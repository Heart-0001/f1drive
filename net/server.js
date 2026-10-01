// F1Drive multiplayer relay server.
//   - inside the game:   require('./net/server').createServer({ port, hostToken, password })   (net/host.js)
//   - dedicated server:  node net/server.js [port] [password]
// Thin relay: player list (with each player's car), current track, the room's season year, who the host is,
// 20 Hz batched car-state snapshots, and the Grand Prix session (net/session.js holds the rules; this file
// owns the clock and the wire). Computer drivers ("bots") are players the host's game simulates: the server
// gives them ids / slots and treats what their owner sends for them like a player's own (see BOT_LEVELS).
// It is reachable from the internet, so every inbound message is size-limited, parsed defensively,
// validated and rate-limited; a bad client can never throw past handleMessage(), and nothing a client
// sends makes the server broadcast more than a bounded number of messages per second.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { performance } = require('perf_hooks');
const { createSession, cleanYear } = require('./session');   // Grand Prix rules (shared with the single-player game)

const PROTOCOL = 1;
const DEFAULT_PORT = 24500;
const MAX_PLAYERS = 16;
const MAX_PAYLOAD = 2048;          // bytes per inbound message
const SNAP_MS = 50;                // 20 Hz snapshots
const PING_MS = 5000;              // heartbeat; a socket missing two in a row is dropped
const HELLO_TIMEOUT_MS = 5000;     // a socket that never says hello is dropped
const RATE_PER_SEC = 60;           // sustained inbound messages per connection
const RATE_BURST = 120;
const RATE_KICK = 600;             // messages dropped by the limiter before the connection is closed
const KICK_GRACE_MS = 1000;        // a kicked / rejected socket gets this long to close politely, then it is destroyed
const MAX_SOCKETS = 48;            // connected sockets incl. ones that have not said hello yet
const MAX_PER_IP = MAX_PLAYERS + 4;   // a whole room can come from one address (a LAN party / school / office behind
                                      //   one public IPv4, CGNAT), plus a few that are still connecting
const MAX_TCP = 96;                // TCP connections incl. ones that have not (or never will) become WebSockets
const MAX_TCP_PER_IP = MAX_PER_IP + 8;
const HTTP_TIMEOUT_MS = 4000;      // a TCP connection has this long to finish its WebSocket handshake
const NAME_MAX = 16;
const HIT_MIN_MS = 40;             // a player may report at most one impact per 40 ms
const HIT_MAX = 50;                // m/s, largest velocity change one impact report may ask for (js/collide.js hands
                                   //   each car 0.6 x the closing speed: a car at 300 km/h into a parked one)
// An impact report ("my car hit yours") comes from the OTHER player's game, so it is relayed only as far as it
// fits how both cars really moved (see case 'hit'). Their motion is taken from the POSITIONS they reported, timed
// by when those arrived here: the speed, heading and clock in a car state are the client's word and only draw his
// car. A client that forges a whole consistent path can still ram (visibly: everybody sees his car do it); that is
// inherent without physics on the server. The server does not know the track, so it cannot see the pit lane: the
// lane's ghost rule is the receiving game's.
const HIT_FRESH_MS = 500;          // both cars' positions must be this recent; motion is measured over this long
const HIT_NEAR = 12;               // m between the two positions at most, plus HIT_LAG_S of each car's speed
const HIT_LAG_S = 0.2;             //   (the two positions were not taken at the same moment)
const HIT_SLACK = 3;               // m/s over the speed at which the reporter's car was closing along the impulse
const HIT_BUDGET = 100;            // m/s one player can hand one other player in a row (two full impacts) ...
const HIT_REFILL = 25;             // ... refilled at this many m/s per second
const HIT_KEEP = 16;               // positions remembered per player (~0.8 s at 20 Hz): his motion before the contact
const VEL_MIN_MS = 100;            // a velocity is measured over at least this long (arrival jitter stays a small part)
const HIT_MIN_DV = 0.2;            // m/s: smaller ones are not worth relaying (the games ignore them)
// Driving as the server can see it without knowing the track: the path a player's reported positions cover.
const DRIVE_VMAX = 130;            // m/s: no car goes faster (cleanState clamps the speed to this)
const DRIVE_CARRY_MS = 5000;       // a gap in a player's states credits at most this long (lag: late states in a burst)
const TELEPORT = 30;               // m: a step this much longer than the time since the previous one allows is a reset
// A player who sends nothing at all for this long is dropped. The game pings every 10 s and repeats its pose
// every 200 ms, but Chrome runs the timers of a tab hidden for 5 min once a minute (the browser build joining a
// room; the desktop app is not throttled): three such wake-ups of margin. Protocol pongs do not count: the
// network stack answers them even for a frozen page.
const IDLE_MS = 180000;
const PW_MAX = 64;                 // characters of a room password
const PW_TRIES = 5;                // wrong passwords one address may try ...
const PW_WINDOW_MS = 60000;        // ... in this long; then it is refused ('wait') until that is over
const PW_IPS = 1024;               // addresses remembered for that
const TICK_MS = 100;              // Grand Prix clock (lights out, timeout) and the flush of coalesced broadcasts
const GP_LIVE_MS = 500;            // live standings are re-sent this often during a race
const COALESCE_MS = 100;           // roster / Grand Prix broadcasts: one right away, then at most one per tick
const TRACK_MIN_MS = 1000;         // track changes: one right away, then the host's latest pick once this has passed
                                   //   (every client rebuilds the whole track for each one)
const YEAR_MIN_MS = 1000;          // room year changes, the same way (every client re-resolves its car and racing line)
const COLOURS = ['#ff7a14', '#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7'];
// Computer drivers ("bots"). The HOST's game simulates them (js/ai.js); the server only knows them as players that
// connection owns: it gives them ids and room slots, keeps them in the roster and the Grand Prix session, takes their
// states / laps / lap times / impact reports from their owner's connection only, under the same checks as a human's,
// and relays them to everybody like a human's. Strength levels as js/ai.js F1.AI.LEVELS (skill 0..1), plus 'mixed'.
// Wire (protocol 1, additive: an older client sees bots as ordinary players):
//   client -> server  bots {n, skill?, list?: [{name?, car?, colour?, skill?}]}   host, free practice: his field
//                     bs {k, c, b: [[id, x, y, z, heading, pitch, roll, speed, steer, g?], ...]}   his bots' states
//                     gl {..., id} / lap {..., id} / hit {..., from}   a lap / lap times / an impact of one of his bots
//   server -> client  roster rows of bots: {..., bot: true, skill, owner, bi}; welcome / players: bots {n, skill}
//                     snap rows and session rows as a player's (session rows: bot: true); glno {why, id};
//                     hit {from, i, bot} to the owner when one of his bots was hit
// The owner leaving takes his bots (a running session they race in ends); a human joining a full room in free
// practice takes the newest bot's seat.
const BOT_LEVELS = { rookie: 0, amateur: 0.35, pro: 0.7, legend: 1, mixed: null };
const BOT_LEVEL_DEFAULT = 'pro';
const BOT_RATE = 4;                // messages / s more for a connection per bot it owns (their laps, lap times, impacts)

function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function round(v, k) { return Math.round(v * k) / k; }
function mono() { return performance.now(); }          // real elapsed ms: rate limits, throttles, coalescing
function isLoopback(ip) { return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'; }

function stripControl(v) {
  var out = "";
  for (var i = 0; i < v.length; i++) {
    var c = v.charCodeAt(i);
    // C0 / C1 controls, zero-width and bidi formatting characters, line separators, BOM
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) continue;
    out += v.charAt(i);
  }
  return out;
}
function cleanName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  // drop control / formatting characters, collapse whitespace, clamp by code point
  let s = stripControl(v).replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, NAME_MAX).join('').trim();
  return s || fallback;
}
function cleanColour(v, fallback) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
}
function cleanTrackId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_.\-]{1,64}$/.test(v) ? v : null;
}
function cleanCarId(v) {                 // a CarSpec id ('2024-ferrari'); null = not a car id
  return typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? v : null;
}
function cleanLap(v) {
  return isNum(v) && v > 1 && v < 36000 ? round(v, 1000) : null;
}
function cleanLevel(v) {                 // a bot strength level id, or null
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOT_LEVELS, v) ? v : null;
}
function cleanSkill(v) {                 // one bot's skill 0..1 (3 decimals), or null
  return isNum(v) ? round(clamp(v, 0, 1), 1000) : null;
}
// A room password as it is compared (js/net.js sends it the same way): NFC, trimmed, at most PW_MAX
// characters; '' = none.
function cleanPassword(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v.normalize('NFC').trim()).slice(0, PW_MAX).join('');
}
function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest(); }

// [x, y, z, heading, pitch, roll, speed, steer] -> validated/clamped copy, or null
function cleanState(a) {
  if (!Array.isArray(a) || a.length !== 8) return null;
  for (let i = 0; i < 8; i++) if (!isNum(a[i])) return null;
  let h = a[3] % (Math.PI * 2);
  return [
    round(clamp(a[0], -1e5, 1e5), 100),
    round(clamp(a[1], -2000, 9000), 100),
    round(clamp(a[2], -1e5, 1e5), 100),
    round(h, 10000),
    round(clamp(a[4], -1.2, 1.2), 1000),
    round(clamp(a[5], -1.2, 1.2), 1000),
    round(clamp(a[6], -130, 130), 100),
    round(clamp(a[7], -1, 1), 100)
  ];
}

/**
 * createServer(opts) -> Promise<{ port, close(): Promise, info(): {...} }>
 * opts: { port = 24500, host = '0.0.0.0', hostToken = null, password = '', maxPlayers = 16, log = fn|null, now = fn,
 *         random = fn, idleMs = 180000 }
 *   hostToken: when set, only a client presenting it in `hello` is the host (the in-game "Create" flow)
 *              and the host never migrates. When null (dedicated server) the first player is the host
 *              and the role passes to the longest-connected player when the host leaves. Either way the
 *              track and the room year stay with the room.
 *   password:  when set (a non-empty string), `hello` must carry it (`password`; the token holder needs none),
 *              else error 'password'. An address that got it wrong PW_TRIES times within PW_WINDOW_MS is
 *              refused with 'wait' until that time is over. Compared as cleanPassword() leaves it.
 *   idleMs:    a player (not the token holder) who sends nothing for this long is dropped with error 'idle'
 *              (tests make it short).
 *   now:       () -> ms, the clock of the Grand Prix session and of everything the clients synchronise to
 *              (`welcome.now`, `pong.s`, `gp.now`, lightsAt / goAt / endsAt). It must never go backwards.
 *              Default: Date.now() taken once at start-up and advanced by a monotonic timer, so a system
 *              clock change in the middle of a race cannot stall or skip the start lights. It does not
 *              have to follow real time: tests pass a manual clock and step it to fast-forward a race
 *              (rate limits, throttles and timers always run on real time).
 *   random:    () -> 0..1, handed to the session (the random hold before lights out). Default Math.random.
 */
function createServer(opts) {
  opts = opts || {};
  const port = opts.port == null ? DEFAULT_PORT : opts.port;
  const bindHost = opts.host || '0.0.0.0';
  const hostToken = typeof opts.hostToken === 'string' && opts.hostToken ? opts.hostToken : null;
  const maxPlayers = clamp(Math.floor(opts.maxPlayers || MAX_PLAYERS), 1, MAX_PLAYERS);
  const password = cleanPassword(opts.password);
  const pwHash = password ? sha256(password) : null;       // null = an open room
  const idleMs = isNum(opts.idleMs) && opts.idleMs > 0 ? opts.idleMs : IDLE_MS;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  const epoch = Date.now() - performance.now();
  const clock = typeof opts.now === 'function' ? opts.now : function () { return Math.round(epoch + performance.now()); };

  return new Promise(function (resolve, reject) {
    if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) {
      reject(new Error('invalid port'));
      return;
    }
    // Our own HTTP server under the WebSocket server, so that connections which never upgrade are bounded
    // too: a cap on their number (in all and per address) and a short time to complete the handshake.
    // (Left to itself the ws / node default is: unlimited connections, 60 s each.)
    let wss, httpServer;
    const tcpPerIp = new Map();
    try {
      httpServer = http.createServer({
        headersTimeout: HTTP_TIMEOUT_MS, requestTimeout: HTTP_TIMEOUT_MS, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000
      }, function (req, res) {
        const body = 'F1Drive multiplayer server: WebSocket only';
        res.writeHead(426, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' });
        res.end(body);
      });
      httpServer.maxConnections = MAX_TCP;
      httpServer.on('connection', function (sock) {
        const ip = sock.remoteAddress || '?';
        tcpPerIp.set(ip, (tcpPerIp.get(ip) || 0) + 1);
        sock.on('close', function () {
          const c = (tcpPerIp.get(ip) || 1) - 1;
          if (c > 0) tcpPerIp.set(ip, c); else tcpPerIp.delete(ip);
        });
        if (!isLoopback(ip) && tcpPerIp.get(ip) > MAX_TCP_PER_IP) { sock.destroy(); return; }
        // silent connections; ws switches this timeout off once the socket is a WebSocket
        sock.setTimeout(HTTP_TIMEOUT_MS, function () { sock.destroy(); });
      });
      httpServer.on('clientError', function (err, sock) { try { sock.destroy(); } catch (e) {} });
      wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true });
    } catch (err) { reject(err); return; }

    const players = new Map();   // id -> player (said hello): the humans, each with a connection
    // id -> computer driver: { bot: true, owner (the id of the player whose game simulates it), bi (its index in the
    // owner's list), name, colour, car, skill, slot, ... and the same driving / impact bookkeeping as a player }.
    // Ids come from the same counter as the players', room slots from the same pool; humans + bots <= maxPlayers.
    const bots = new Map();
    let botLevel = BOT_LEVEL_DEFAULT;            // the room's strength setting (shown to everybody; the host's word)
    const perIp = new Map();
    const pwFails = new Map();   // address -> { n, t }: wrong room passwords since mono() t
    let nextId = 1, joinCounter = 0;
    let hostId = 0;
    let trackId = null, trackSeq = 0;
    let closed = false, started = false;
    let snapTimer = null, pingTimer = null, tickTimer = null;
    const session = createSession({ random: opts.random });
    let rosterAt = -1e9, rosterDirty = false;      // mono() of the last roster / Grand Prix broadcast,
    let gpAt = -1e9, gpDirty = false;              //   and whether a newer one is waiting for the next tick
    let trackAt = -1e9, trackNext = null, trackBy = 0;   // last track change; the pick that waits, and whose it is
    // The room's season year (null until the host picks one): everybody picks a car of that year. Only the host
    // sets it, only in free practice; it belongs to the room, so it survives host migration and an empty room.
    let year = null, yearAt = -1e9, yearNext = null, yearBy = 0;

    function send(ws, obj) {
      if (ws.readyState !== 1) return;
      // a client that cannot keep up does not get to grow our memory
      if (ws.bufferedAmount > 1 << 20) { try { ws.terminate(); } catch (e) {} return; }
      try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) {}
    }
    function broadcast(obj) {
      const s = JSON.stringify(obj);
      players.forEach(function (p) { send(p.ws, s); });
    }
    function roster() {
      const list = [];
      players.forEach(function (p) {
        list.push({ id: p.id, name: p.name, colour: p.colour, car: p.car, slot: p.slot, last: p.last, best: p.best });
      });
      // a bot's row has the same fields plus bot: true, its skill (0..1 or null), its owner and its index in his list
      bots.forEach(function (b) {
        list.push({ id: b.id, name: b.name, colour: b.colour, car: b.car, slot: b.slot, last: b.last, best: b.best,
                    bot: true, skill: b.skill, owner: b.owner, bi: b.bi });
      });
      list.sort(function (a, b) { return a.slot - b.slot; });
      return list;
    }
    function botInfo() { return { n: bots.size, skill: botLevel }; }
    function entity(id) { return players.get(id) || bots.get(id) || null; }
    function ownerOf(e) { return e.bot ? e.owner : e.id; }
    // the bot `id` when it is one of player p's, else null
    function ownBot(p, id) {
      const b = isNum(id) ? bots.get(id) : null;
      return b && b.owner === p.id ? b : null;
    }
    function botsOf(id) {
      const list = [];
      bots.forEach(function (b) { if (b.owner === id) list.push(b); });
      list.sort(function (a, b) { return a.bi - b.bi; });
      return list;
    }
    function gpMessage() { return { t: 'gp', now: clock(), s: session.snapshot() }; }

    // Roster and Grand Prix state go to everybody, so what triggers them (profile / lap changes, joins and
    // leaves, accepted laps, host actions) must not be able to multiply traffic: the first change is sent
    // right away, further ones within COALESCE_MS wait for the next tick and go out as ONE message with the
    // state as it is then. Clients therefore always end up with the latest state, but may not see every
    // intermediate one.
    function flushRoster() {
      rosterAt = mono(); rosterDirty = false;
      broadcast({ t: 'players', host: hostId, year: year, bots: botInfo(), players: roster() });
    }
    function flushGp() {
      gpAt = mono(); gpDirty = false;
      broadcast(gpMessage());
    }
    function sendRoster() {
      if (mono() - rosterAt < COALESCE_MS) rosterDirty = true; else flushRoster();
    }
    /** -> true when it went out now, false when it waits for the next tick */
    function sendGp() {
      if (mono() - gpAt < COALESCE_MS) { gpDirty = true; return false; }
      flushGp();
      return true;
    }
    // Time-driven session transitions (lights out, race timeout). Called by the tick and before anything
    // else touches the session, so a lap or a leaver is never judged in a phase that is already over.
    function gpSync(now) {
      if (!session.tick(now)) return;
      log('gp    ' + session.phase);
      sendGp();
    }
    function setTrack(id) {
      trackAt = mono(); trackNext = null;
      trackId = id; trackSeq++;
      const clear = function (q) { q.state = null; q.fresh = false; q.last = null; q.best = null; q.trail.length = 0; };
      players.forEach(clear);
      bots.forEach(clear);
      // a new track ends a Grand Prix in progress; everybody hears that before they load the track
      if (session.phase !== 'free') {
        while (session.phase !== 'free') session.end();
        log('gp    track change -> free');
        flushGp();
      }
      broadcast({ t: 'track', id: trackId, seq: trackSeq });
      sendRoster();
      log('track ' + trackId);
    }
    // The room year goes out with the roster (`players` carries it). A pick that equals the current year
    // only cancels one that was waiting.
    function setYear(y) {
      yearNext = null;
      if (y === year) return;
      yearAt = mono(); year = y;
      sendRoster();
      log('year  ' + year);
    }
    function tick() {
      gpSync(clock());
      // players who have sent nothing at all for idleMs (the game pings every 10 s even from the menu); the
      // token holder is the room itself and is never dropped
      const t = mono(), idle = [];
      players.forEach(function (p) { if (t - p.ws._seen > idleMs && !(hostToken && p.id === hostId)) idle.push(p); });
      idle.forEach(function (p) { log('idle  #' + p.id); reject1(p.ws, 'idle'); });
      if (trackNext && mono() - trackAt >= TRACK_MIN_MS) {
        if (trackBy === hostId) setTrack(trackNext); else trackNext = null;      // the host changed meanwhile
      }
      if (yearNext !== null && mono() - yearAt >= YEAR_MIN_MS) {
        // the host changed meanwhile, or a session is on (parc fermé): the pick is dropped
        if (yearBy === hostId && session.phase === 'free') setYear(yearNext); else yearNext = null;
      }
      if (rosterDirty) flushRoster();
      if (gpDirty || (session.phase === 'race' && mono() - gpAt >= GP_LIVE_MS)) flushGp();
    }
    function freeSlot() {
      const used = new Set();
      players.forEach(function (p) { used.add(p.slot); });
      bots.forEach(function (b) { used.add(b.slot); });
      let s = 0;
      while (used.has(s)) s++;
      return s;
    }

    /* ---------- computer drivers ---------- */

    function forgetHits(id) {                       // nobody owes id an impact budget any more
      players.forEach(function (q) { q.hitB.delete(id); });
      bots.forEach(function (q) { q.hitB.delete(id); });
    }
    function addBot(owner, bi, e, now) {
      const id = nextId++;
      const b = {
        id: id, bot: true, owner: owner.id, bi: bi, order: joinCounter++, slot: freeSlot(),
        name: cleanName(e.name, 'AI ' + (bi + 1)),
        colour: cleanColour(e.colour, COLOURS[id % COLOURS.length]),
        car: cleanCarId(e.car) || '',
        skill: cleanSkill(e.skill) !== null ? cleanSkill(e.skill) : BOT_LEVELS[botLevel],
        state: null, ct: 0, fresh: false, last: null, best: null, hitT: -1e9,
        sAt: now, budget: 0, dist: 0, live: 0, dKey: '', jump: false, sT: -1e9, trail: [], hitB: new Map()
      };
      bots.set(id, b);
      owner.nBots++;
      session.addPlayer(id, b.name, now, { bot: true, owner: owner.id });
      return b;
    }
    // (no 'gone' for a bot: the roster that follows says it; a host changing his field must not multiply traffic)
    function removeBot(b, now) {
      if (bots.get(b.id) !== b) return;
      bots.delete(b.id);
      const o = players.get(b.owner);
      if (o) o.nBots = Math.max(0, o.nBots - 1);
      forgetHits(b.id);
      session.removePlayer(b.id, now);
    }
    // The host's field: n bots, entry i of list naming bot i (name, car, colour, skill; anything missing or not
    // valid gets a default). Bots 0..n-1 that exist keep their ids and slots (they are updated in place), the rest
    // are removed or added. -> true when anything changed.
    function setBots(owner, n, list, level, now) {
      const mine = botsOf(owner.id);
      let changed = level !== botLevel;
      botLevel = level;
      for (let i = 0; i < mine.length && i < n; i++) {
        const b = mine[i], e = list[i] && typeof list[i] === 'object' ? list[i] : {};
        const name = cleanName(e.name, b.name), colour = cleanColour(e.colour, b.colour);
        const car = cleanCarId(e.car) || b.car, skill = cleanSkill(e.skill) !== null ? cleanSkill(e.skill) : b.skill;
        if (name === b.name && colour === b.colour && car === b.car && skill === b.skill) continue;
        b.name = name; b.colour = colour; b.car = car; b.skill = skill;
        session.rename(b.id, name);
        changed = true;
      }
      for (let i = mine.length - 1; i >= n; i--) { removeBot(mine[i], now); changed = true; }
      for (let i = mine.length; i < n; i++) {
        addBot(owner, i, list[i] && typeof list[i] === 'object' ? list[i] : {}, now);
        changed = true;
      }
      return changed;
    }
    // The newest bot (the last of its owner's list), the one a human joining a full room replaces.
    function newestBot() {
      let best = null;
      bots.forEach(function (b) { if (!best || b.bi > best.bi || (b.bi === best.bi && b.id > best.id)) best = b; });
      return best;
    }
    function pickHost() {
      if (hostToken) return;                     // in-game server: only the token holder is ever host
      let best = null;
      players.forEach(function (p) { if (!best || p.order < best.order) best = p; });
      hostId = best ? best.id : 0;
    }

    // The player behind this socket is gone (socket closed, or kicked: we do not wait for the close).
    function dropPlayer(ws) {
      const p = ws._player;
      if (!p || players.get(p.id) !== p) return;
      players.delete(p.id);
      ws._player = null;
      log('leave #' + p.id + ' "' + p.name + '" (' + players.size + '/' + maxPlayers + ')');
      if (closed) return;
      forgetHits(p.id);
      if (p.id === hostId) { hostId = 0; pickHost(); }
      const now = clock();
      gpSync(now);
      session.removePlayer(p.id, now);
      // His bots go with him (nobody simulates them any more). If they were in a running session it ends cleanly:
      // qualifying / grid -> free practice, the race -> the results as they stand (the bots DNF); a classification
      // that is already final stays. (Ownership could pass to the next host one day: his game would rebuild them.)
      const mine = botsOf(p.id);
      if (mine.length) {
        mine.forEach(function (b) { removeBot(b, now); });
        if (session.phase === 'quali' || session.phase === 'grid' || session.phase === 'race') {
          session.end();
          log('gp    the bots\' owner left -> ' + session.phase);
        }
        log('bots  ' + mine.length + ' of #' + p.id + ' removed');
      }
      broadcast({ t: 'gone', id: p.id });
      sendRoster();
      sendGp();
    }
    // Refuse / kick: tell the client why, ignore whatever else it sends, and do not depend on it to
    // complete the close handshake (a hostile peer would otherwise keep its seat for ws's 30 s timeout).
    function reject1(ws, code) {
      if (ws._bye) return;
      send(ws, { t: 'error', code: code });
      ws._bye = true;
      dropPlayer(ws);
      try { ws.close(1008, code); } catch (e) {}
      ws._byeTimer = setTimeout(function () {
        ws._byeTimer = null;
        try { ws.terminate(); } catch (e) {}
      }, KICK_GRACE_MS);
    }

    // What the server can check of a player's driving without knowing the track: the path his reported
    // positions cover, each step credited up to what the time since his previous state allows at DRIVE_VMAX
    // (time not used carries over, up to DRIVE_CARRY_MS, so a burst of states held up on the network still
    // counts), and for how long his states kept arriving. A step far beyond that is a reset (R, a new track, a
    // client that teleports): it counts for nothing, and his impact reports wait for a pose he drove to.
    // Both sums start again in every phase of every session and after every accepted lap. Session clock.
    function driveKey(p) {
      const key = session.sid + ':' + session.phase;
      if (p.dKey !== key) { p.dKey = key; p.dist = 0; p.live = 0; }
    }
    function driven(p, st, now) {
      driveKey(p);
      const gap = clamp(now - p.sAt, 0, DRIVE_CARRY_MS);
      p.sAt = now;
      p.live += gap;
      p.budget = Math.min(p.budget + DRIVE_VMAX * gap / 1000, DRIVE_VMAX * DRIVE_CARRY_MS / 1000);
      p.jump = false;
      if (!p.state) return;
      const dx = st[0] - p.state[0], dy = st[1] - p.state[1], dz = st[2] - p.state[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > p.budget + TELEPORT) { p.jump = true; return; }
      const c = Math.min(d, p.budget);
      p.dist += c; p.budget -= c;
    }
    // How player p really moved in the last HIT_FRESH_MS (mono() t): from the positions he reported since his last
    // reset (p.trail), timed by their arrival here, never by the speed / heading / clock he claims. Each state is
    // paired with the latest one at least VEL_MIN_MS before it; f(vx, vz) gets each such velocity (m/s, XZ).
    // -> how many there were (0: his positions show no motion to measure)
    function motion(p, t, f) {
      const tr = p.trail;
      let n = 0;
      for (let i = tr.length - 1; i > 0 && t - tr[i][2] <= HIT_FRESH_MS; i--) {
        for (let j = i - 1; j >= 0 && t - tr[j][2] <= HIT_FRESH_MS; j--) {
          const dt = tr[i][2] - tr[j][2];
          if (dt < VEL_MIN_MS) continue;
          f((tr[i][0] - tr[j][0]) * 1000 / dt, (tr[i][1] - tr[j][1]) * 1000 / dt);
          n++;
          break;
        }
      }
      return n;
    }
    // the fastest p moved (m/s), at most DRIVE_VMAX; null when nothing can be measured
    function topSpeed(p, t) {
      let s = 0;
      const n = motion(p, t, function (vx, vz) { s = Math.max(s, Math.sqrt(vx * vx + vz * vz)); });
      return n ? Math.min(s, DRIVE_VMAX) : null;
    }
    // m/s at which a's car was closing on b's along (ux, uz): a's fastest approach (his own game may already have
    // slowed his car down) against b's slowest; b counts as standing still when his motion cannot be measured
    function closing(a, b, ux, uz, t) {
      let va = -Infinity, vb = Infinity;
      motion(a, t, function (vx, vz) { va = Math.max(va, vx * ux + vz * uz); });
      motion(b, t, function (vx, vz) { vb = Math.min(vb, vx * ux + vz * uz); });
      return va - (vb === Infinity ? 0 : vb);
    }
    // what player p may still hand player id (m/s), refilled since the last time
    function hitBudget(p, id, t) {
      let e = p.hitB.get(id);
      if (!e) { e = { b: HIT_BUDGET, t: t }; p.hitB.set(id, e); }
      e.b = Math.min(HIT_BUDGET, e.b + Math.max(0, t - e.t) * HIT_REFILL / 1000); e.t = t;
      return e;
    }
    // Room password: -> '' when this hello may come in, else the error code. The comparison of two SHA-256
    // digests takes the same time whatever was sent; wrong guesses are counted per address.
    function passwordError(ws, m) {
      if (!pwHash || (hostToken && typeof m.token === 'string' && m.token === hostToken)) return '';
      const t = mono(), ip = ws._ip;
      let f = pwFails.get(ip);
      if (f && t - f.t < PW_WINDOW_MS && f.n >= PW_TRIES) return 'wait';
      if (crypto.timingSafeEqual(sha256(cleanPassword(m.password)), pwHash)) { pwFails.delete(ip); return ''; }
      if (!f || t - f.t >= PW_WINDOW_MS) {
        pwFails.delete(ip);
        f = { n: 0, t: t };
        pwFails.set(ip, f);
        if (pwFails.size > PW_IPS) pwFails.delete(pwFails.keys().next().value);   // the oldest
      }
      f.n++;
      log('wrong password from ' + ip + ' (' + f.n + ')');
      return 'password';
    }

    function onHello(ws, m) {
      if (ws._player) return;
      if (m.v !== PROTOCOL) { reject1(ws, 'version'); return; }
      const pw = passwordError(ws, m);
      if (pw) { reject1(ws, pw); return; }
      const now = clock();
      if (players.size + bots.size >= maxPlayers) {
        // a human goes before a computer driver: in free practice the newest bot makes room (its owner's game hears
        // it from the roster); while a session is on the field is fixed
        gpSync(now);
        const b = players.size < maxPlayers && session.phase === 'free' ? newestBot() : null;
        if (!b) { reject1(ws, 'full'); return; }
        removeBot(b, now);
        log('bots  #' + b.id + ' "' + b.name + '" makes room');
      }
      const id = nextId++;
      const p = {
        id: id, ws: ws, order: joinCounter++, slot: freeSlot(), nBots: 0,
        name: cleanName(m.name, 'Player ' + id),
        colour: cleanColour(m.colour, COLOURS[id % COLOURS.length]),
        car: cleanCarId(m.car) || '',              // '' = not chosen; whatever he announces counts, even mid-session
        state: null, ct: 0, fresh: false, last: null, best: null, hitT: -1e9,
        // driving (see driven()): session-clock time of the last state, path credit, path / time since the last
        // lap, which phase they belong to, whether the last state was a reset
        sAt: now, budget: 0, dist: 0, live: 0, dKey: '', jump: false,
        sT: -1e9, trail: [], hitB: new Map()       // impacts: mono() of the last state, [x, z, mono] recent, budgets
      };
      players.set(id, p);
      ws._player = p;
      if (hostToken) {
        if (typeof m.token === 'string' && m.token === hostToken) hostId = id;
      } else if (!hostId) hostId = id;
      gpSync(now);
      session.addPlayer(id, p.name, now);
      send(ws, { t: 'welcome', v: PROTOCOL, id: id, host: hostId, track: trackId, seq: trackSeq, year: year, bots: botInfo(),
                 players: roster(), now: now });
      sendRoster();
      if (!sendGp()) send(ws, gpMessage());        // the newcomer never waits for the session state
      log('join  #' + id + ' "' + p.name + '" (' + players.size + '/' + maxPlayers + ')');
    }

    function handleMessage(ws, data, isBinary) {
      if (ws._bye) return;
      // rate limit (token bucket); frames we have no use for count too. A connection that simulates bots sends
      // their laps, lap times and impact reports as well: BOT_RATE more per bot (none of it is broadcast as such).
      const t = mono();
      ws._seen = t;                                // (anything at all keeps a player from being dropped as idle)
      const nb = ws._player ? ws._player.nBots : 0;
      if (t > ws._tokenT) {
        ws._tokens = Math.min(RATE_BURST + 2 * BOT_RATE * nb, ws._tokens + (t - ws._tokenT) * (RATE_PER_SEC + BOT_RATE * nb) / 1000);
        ws._tokenT = t;
      }
      if (ws._tokens < 1) {
        if (++ws._dropped > RATE_KICK) reject1(ws, 'flood');
        return;
      }
      ws._tokens -= 1;
      if (isBinary) return;

      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;

      if (m.t === 'hello') { onHello(ws, m); return; }
      const p = ws._player;
      if (!p) return;                              // everything else needs a hello first
      const now = clock();

      // A validated state of car e (a player's own, or one of his bots) arrived at mono() t.
      const applyState = function (e, st, c, g) {
        driven(e, st, now);
        e.state = st; e.ct = Math.round(clamp(c, 0, 1e13)); e.fresh = true; e.sT = t;
        // where it is and when that arrived, for its motion (see motion()); a reset starts it again
        if (e.jump) e.trail.length = 0;
        e.trail.push([st[0], st[2], t]);
        if (e.trail.length > HIT_KEEP) e.trail.shift();
        // race progress rides along; no further ahead of the laps counted than the path driven allows
        if (isNum(g)) session.progress(e.id, g, e.dist);
      };
      // The car a lap / lap time / impact report is about: his own (no id, or his id), or one of his bots; null when
      // the id names anything else (nobody may speak for somebody else's car).
      const subject = function (id) { return id === undefined || id === p.id ? p : ownBot(p, id); };

      switch (m.t) {
        case 's': {                                // car state
          if (m.k !== trackSeq) return;            // state from before the last track change
          const st = cleanState(m.s);
          if (!st || !isNum(m.c)) return;
          gpSync(now);                             // (driving after lights out is the race's, tick or no tick yet)
          applyState(p, st, m.c, m.g);
          break;
        }
        case 'bs': {                               // the states of his bots: b = [[id, x, y, z, heading, pitch, roll, speed, steer, g?], ...]
          if (m.k !== trackSeq || !isNum(m.c) || !Array.isArray(m.b) || !p.nBots) return;
          gpSync(now);
          const seen = new Set();
          for (let i = 0; i < m.b.length && i < MAX_PLAYERS; i++) {
            const row = m.b[i];
            if (!Array.isArray(row) || (row.length !== 9 && row.length !== 10)) continue;
            const b = ownBot(p, row[0]);
            if (!b || seen.has(b.id)) continue;    // somebody else's car, or the same bot twice in one message
            const st = cleanState(row.slice(1, 9));
            if (!st) continue;
            seen.add(b.id);
            applyState(b, st, m.c, row[9]);
          }
          break;
        }
        case 'bots': {                             // host, free practice only: his computer drivers
          if (p.id !== hostId || session.phase !== 'free' || !isNum(m.n) || m.n < 0) return;
          // as many as the room has seats for next to the humans (and anybody else's bots)
          const n = Math.max(0, Math.min(Math.floor(m.n), maxPlayers - players.size - (bots.size - p.nBots)));
          const level = cleanLevel(m.skill) || botLevel;               // a level that is not one keeps the room's
          if (setBots(p, n, Array.isArray(m.list) ? m.list : [], level, now)) {
            log('bots  ' + bots.size + ' (' + botLevel + ')');
            sendRoster();
            sendGp();
          }
          break;
        }
        case 'ping': {                             // clock sync for the start lights
          if (isNum(m.c)) send(ws, { t: 'pong', c: m.c, s: now });
          break;
        }
        case 'gp': {                               // host: start / skip / end / again
          if (p.id !== hostId || typeof m.a !== 'string') return;
          gpSync(now);
          // A track pick of his that still waits for the rate limit is about to replace the track (and so end the
          // session): no new session until it is out (m.len is the length of the track he is on now). He starts
          // one again once everybody has loaded the new track.
          if ((m.a === 'start' || m.a === 'again') && trackNext && trackBy === p.id) return;
          let changed = false;
          if (m.a === 'start') {
            // the session races the ROOM's year (never one the client names); a year pick of the host's that is
            // still waiting for the rate limit is his latest word, so it is applied with the start
            const y = yearNext !== null && yearBy === p.id ? yearNext : year;
            changed = !!trackId && session.start({ q: m.q, r: m.r, len: m.len, year: y, wear: m.wear }, now);
            if (changed) setYear(y);
          } else if (m.a === 'skip') changed = session.skip(now);
          else if (m.a === 'end') changed = session.end();
          else if (m.a === 'again') changed = session.again(now);
          if (changed) { log('gp    ' + m.a + ' -> ' + session.phase); sendGp(); }
          break;
        }
        case 'gl': {                               // a lap completed in qualifying / the race (id: one of his bots)
          // a lap of an earlier track or an earlier session is not this session's business: no answer
          if (m.k !== trackSeq || m.sid !== session.sid) return;
          const r = subject(m.id);
          if (!r) return;
          gpSync(now);
          driveKey(r);                             // (no state of its in this phase yet: nothing driven)
          // the lap must be backed by the path its states covered since its previous lap (see driven());
          // m.at = the sender's estimate of the session clock when the car crossed the line (race time)
          const why = session.lap(r.id, m.time, now, { dist: r.dist, live: r.live / 1000, at: m.at });
          if (why) send(ws, r === p ? { t: 'glno', why: why } : { t: 'glno', why: why, id: r.id });
          else { r.dist = 0; r.live = 0; sendGp(); }
          break;
        }
        case 'hit': {                              // "my car just hit yours": relayed to that car's player only
          if (m.k !== trackSeq || !isNum(m.to) || !Array.isArray(m.i) || m.i.length !== 2) return;
          if (!isNum(m.i[0]) || !isNum(m.i[1])) return;
          // the reporting car: his own, or (from) one of his bots
          const r = subject(m.from);
          const target = entity(m.to);
          // his game settles contacts among its own cars (his car and his bots) itself
          if (!r || !target || ownerOf(target) === p.id || t - r.hitT < HIT_MIN_MS) return;
          // both cars on this track with a recent position, the reporter's one it drove to (not a reset) after
          // positions that show its motion, near each other, and solid for each other (in a Grand Prix qualifying
          // cars and spectators are ghosts)
          const a = r.state, b = target.state;
          if (!a || !b || r.jump || t - r.sT > HIT_FRESH_MS || t - target.sT > HIT_FRESH_MS) return;
          const sa = topSpeed(r, t), sb = topSpeed(target, t) || 0;
          if (sa === null) return;
          const dx = a[0] - b[0], dz = a[2] - b[2], near = HIT_NEAR + (sa + sb) * HIT_LAG_S;
          if (dx * dx + dz * dz > near * near || !session.solid(r.id, target.id, now)) return;
          r.hitT = t;
          const mag = Math.sqrt(m.i[0] * m.i[0] + m.i[1] * m.i[1]);
          if (!(mag > 0) || !isNum(mag)) return;
          const ux = m.i[0] / mag, uz = m.i[1] / mag;
          // No more than the two cars can have given each other: the reporter's car must have been closing on
          // the target's along the impulse, at least as fast as the velocity change asked for (a contact gives
          // each car at most the closing speed), and one car can only hand another so much in a row.
          const pair = hitBudget(r, target.id, t);
          const j = Math.min(mag, HIT_MAX, closing(r, target, ux, uz, t) + HIT_SLACK, pair.b);
          if (!(j >= HIT_MIN_DV)) return;
          pair.b -= j;
          const imp = [round(ux * j, 100), round(uz * j, 100)];
          // a bot is hit in its owner's game: he is told which of his bots it was
          const dest = target.bot ? players.get(target.owner) : target;
          if (dest) send(dest.ws, target.bot ? { t: 'hit', from: r.id, bot: target.id, i: imp } : { t: 'hit', from: r.id, i: imp });
          break;
        }
        case 'track': {
          if (p.id !== hostId) return;
          const id = cleanTrackId(m.id);
          if (!id) return;
          if (t - trackAt < TRACK_MIN_MS) { trackNext = id; trackBy = p.id; }   // applied by the tick; the last pick wins
          else setTrack(id);
          break;
        }
        case 'year': {                             // host, free practice only: the season everybody picks a car of
          if (p.id !== hostId || session.phase !== 'free') return;
          const y = cleanYear(m.y);
          if (y === null) return;
          if (t - yearAt < YEAR_MIN_MS) { yearNext = y; yearBy = p.id; }       // applied by the tick; the last pick wins
          else setYear(y);
          break;
        }
        case 'profile': {
          const name = cleanName(m.name, p.name), colour = cleanColour(m.colour, p.colour);
          // parc fermé: the car cannot be changed while a session is on (name and colour can)
          const car = session.phase === 'free' ? cleanCarId(m.car) || p.car : p.car;
          if (name === p.name && colour === p.colour && car === p.car) return;
          p.name = name; p.colour = colour; p.car = car;
          sendRoster();
          if (session.rename(p.id, name) && session.phase !== 'free') sendGp();
          break;
        }
        case 'lap': {                              // lap times for the roster (id: one of his bots)
          const r = subject(m.id);
          if (!r) return;
          const last = cleanLap(m.last), best = cleanLap(m.best);
          if (last === r.last && best === r.best) return;
          r.last = last; r.best = best;
          sendRoster();
          break;
        }
        default: break;
      }
    }

    function onClose(ws) {
      const ip = ws._ip;
      const c = (perIp.get(ip) || 1) - 1;
      if (c > 0) perIp.set(ip, c); else perIp.delete(ip);
      if (ws._helloTimer) { clearTimeout(ws._helloTimer); ws._helloTimer = null; }
      if (ws._byeTimer) { clearTimeout(ws._byeTimer); ws._byeTimer = null; }
      dropPlayer(ws);
    }

    wss.on('connection', function (ws, req) {
      const ip = (req && req.socket && req.socket.remoteAddress) || '?';
      ws._ip = ip;
      perIp.set(ip, (perIp.get(ip) || 0) + 1);
      ws._player = null; ws._alive = true; ws._bye = false; ws._byeTimer = null; ws._helloTimer = null;
      ws._tokens = RATE_BURST; ws._tokenT = mono(); ws._dropped = 0; ws._seen = mono();
      ws.on('error', function () {});               // e.g. oversized frame: ws closes the socket itself
      ws.on('close', function () { try { onClose(ws); } catch (e) { log('close error: ' + e.message); } });
      ws.on('pong', function () { ws._alive = true; });
      ws.on('message', function (data, isBinary) {
        try { handleMessage(ws, data, isBinary); } catch (e) { log('message error: ' + (e && e.message)); }
      });
      if (wss.clients.size > MAX_SOCKETS || (!isLoopback(ip) && perIp.get(ip) > MAX_PER_IP)) {
        reject1(ws, 'busy');
        return;
      }
      ws._helloTimer = setTimeout(function () {
        ws._helloTimer = null;
        if (!ws._player) { try { ws.terminate(); } catch (e) {} }
      }, HELLO_TIMEOUT_MS);
    });

    // Bots ride in the same rows as the players (their owner gets his own back and skips them, as his own car's).
    function snapshot() {
      if (players.size < 2) {                      // nobody to tell (a lone host's bots are drawn by his own game)
        players.forEach(function (p) { p.fresh = false; });
        bots.forEach(function (b) { b.fresh = false; });
        return;
      }
      const list = [];
      const row = function (p) {
        if (!p.fresh || !p.state) return;
        p.fresh = false;
        const s = p.state;
        list.push([p.id, p.ct, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]);
      };
      players.forEach(row);
      bots.forEach(row);
      if (list.length) broadcast({ t: 'snap', p: list });
    }

    function heartbeat() {
      wss.clients.forEach(function (ws) {
        if (!ws._alive) { try { ws.terminate(); } catch (e) {} return; }
        ws._alive = false;
        try { ws.ping(); } catch (e) {}
      });
    }

    function close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(snapTimer); clearInterval(pingTimer); clearInterval(tickTimer);
      return new Promise(function (res) {
        let left = 2;
        const done = function () { if (--left === 0) { clearTimeout(kill); res(); } };
        // stop listening at once (the port is free for the next room), then see the connections out
        try { httpServer.close(done); } catch (e) { done(); }
        try { httpServer.closeAllConnections(); } catch (e) {}       // plain HTTP ones; WebSockets are ours
        wss.clients.forEach(function (ws) {
          if (ws._helloTimer) { clearTimeout(ws._helloTimer); ws._helloTimer = null; }
          try { ws.close(1001, 'server closing'); } catch (e) {}
        });
        // do not wait for polite close handshakes from dead peers
        const kill = setTimeout(function () {
          wss.clients.forEach(function (ws) { try { ws.terminate(); } catch (e) {} });
        }, 300);
        wss.close(done);
      });
    }

    wss.on('error', function (err) {
      if (!started) {                              // could not listen (port in use, ...): leave nothing behind
        closed = true;
        try { httpServer.close(); } catch (e) {}
        reject(err);
        return;
      }
      log('server error: ' + (err && err.message));
    });
    wss.on('listening', function () {
      if (closed) return;
      started = true;
      snapTimer = setInterval(function () { try { snapshot(); } catch (e) { log('snapshot error: ' + e.message); } }, SNAP_MS);
      pingTimer = setInterval(function () { try { heartbeat(); } catch (e) {} }, PING_MS);
      tickTimer = setInterval(function () { try { tick(); } catch (e) { log('gp error: ' + e.message); } }, TICK_MS);
      const addr = httpServer.address();
      resolve({
        port: addr && addr.port ? addr.port : port,
        close: close,
        info: function () {
          return { players: roster(), host: hostId, track: trackId, seq: trackSeq, year: year, bots: botInfo(), now: clock(),
                   gp: session.snapshot() };
        }
      });
    });
    try { httpServer.listen(port, bindHost); } catch (err) { reject(err); }
  });
}

/** Non-internal IPv4 addresses of this machine (what LAN friends type in). */
function lanAddresses() {
  const out = [];
  try {
    const ifs = require('os').networkInterfaces();
    Object.keys(ifs).forEach(function (name) {
      (ifs[name] || []).forEach(function (a) {
        const v4 = a.family === 'IPv4' || a.family === 4;
        if (v4 && !a.internal && !/^169\.254\./.test(a.address) && out.indexOf(a.address) < 0) out.push(a.address);
      });
    });
  } catch (e) {}
  return out;
}

module.exports = {
  createServer: createServer, lanAddresses: lanAddresses,
  DEFAULT_PORT: DEFAULT_PORT, MAX_PLAYERS: MAX_PLAYERS, PROTOCOL: PROTOCOL, IDLE_MS: IDLE_MS
};

if (require.main === module) {
  const arg = process.argv[2];
  const p = arg == null ? DEFAULT_PORT : Number(arg);
  if (!(Number.isInteger(p) && p > 0 && p < 65536)) {
    console.error('usage: node net/server.js [port] [password]   (default port ' + DEFAULT_PORT +
      '; the password can also come from the environment variable F1_ROOM_PASSWORD)');
    process.exit(1);
  }
  const pw = cleanPassword(process.argv[3] != null ? process.argv[3] : process.env.F1_ROOM_PASSWORD);
  const stamp = function (s) { console.log(new Date().toISOString().slice(11, 19) + ' ' + s); };
  createServer({ port: p, log: stamp, password: pw }).then(function (srv) {
    stamp('F1Drive server listening on 0.0.0.0:' + srv.port + ' (TCP). LAN addresses: ' +
      (lanAddresses().join(', ') || 'none found') + (pw ? '. Players need the room password.' : '. No room password.'));
    stamp('The first player to join is the host and picks the track and the season.');
    const stop = function () { srv.close().then(function () { process.exit(0); }); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, function (err) {
    console.error('cannot start server: ' + (err && err.code === 'EADDRINUSE' ? 'port ' + p + ' is already in use' : err && err.message));
    process.exit(1);
  });
}
