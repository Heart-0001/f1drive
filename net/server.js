// F1Drive multiplayer relay server.
//   - inside the game:   require('./net/server').createServer({ port, hostToken })   (electron-main.js)
//   - dedicated server:  node net/server.js [port]
// Thin relay: player list, current track, who the host is, and 20 Hz batched car-state snapshots.
// It is reachable from the internet, so every inbound message is size-limited, parsed defensively,
// validated and rate-limited; a bad client can never throw past handleMessage().
'use strict';

const { WebSocketServer } = require('ws');
const { createSession } = require('./session');   // Grand Prix rules (shared with the single-player game)

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
const MAX_SOCKETS = 48;            // connected sockets incl. ones that have not said hello yet
const MAX_PER_IP = 8;
const NAME_MAX = 16;
const HIT_MIN_MS = 40;             // a player may report at most one impact per 40 ms
const GP_TICK_MS = 100;             // Grand Prix clock (lights out, timeout)
const GP_LIVE_MS = 500;             // live standings are re-sent this often during a race
const HIT_MAX = 80;                // m/s, largest velocity change one impact report may ask for
const COLOURS = ['#ff7a14', '#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7'];

function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function round(v, k) { return Math.round(v * k) / k; }

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
function cleanLap(v) {
  return isNum(v) && v > 1 && v < 36000 ? round(v, 1000) : null;
}

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
 * opts: { port = 24500, host = '0.0.0.0', hostToken = null, maxPlayers = 16, log = fn|null }
 *   hostToken: when set, only a client presenting it in `hello` is the host (the in-game "Create" flow)
 *              and the host never migrates. When null (dedicated server) the first player is the host
 *              and the role passes to the longest-connected player when the host leaves.
 */
function createServer(opts) {
  opts = opts || {};
  const port = opts.port == null ? DEFAULT_PORT : opts.port;
  const bindHost = opts.host || '0.0.0.0';
  const hostToken = typeof opts.hostToken === 'string' && opts.hostToken ? opts.hostToken : null;
  const maxPlayers = clamp(Math.floor(opts.maxPlayers || MAX_PLAYERS), 1, MAX_PLAYERS);
  const log = typeof opts.log === 'function' ? opts.log : function () {};

  return new Promise(function (resolve, reject) {
    if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) {
      reject(new Error('invalid port'));
      return;
    }
    let wss;
    try {
      wss = new WebSocketServer({
        port: port, host: bindHost, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true
      });
    } catch (err) { reject(err); return; }

    const players = new Map();   // id -> player (said hello)
    const perIp = new Map();
    let nextId = 1, joinCounter = 0;
    let hostId = 0;
    let trackId = null, trackSeq = 0;
    let closed = false, started = false;
    let snapTimer = null, pingTimer = null, gpTimer = null;
    const session = createSession({ random: opts.random });
    let gpSentAt = 0;

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
        list.push({ id: p.id, name: p.name, colour: p.colour, slot: p.slot, last: p.last, best: p.best });
      });
      list.sort(function (a, b) { return a.slot - b.slot; });
      return list;
    }
    function sendRoster() { broadcast({ t: 'players', host: hostId, players: roster() }); }
    function gpMessage() { return { t: 'gp', now: Date.now(), s: session.snapshot() }; }
    function sendGp() { gpSentAt = Date.now(); broadcast(gpMessage()); }
    function gpTick() {
      const now = Date.now();
      if (session.tick(now)) { log('gp    ' + session.phase); sendGp(); }
      else if (session.phase === 'race' && now - gpSentAt >= GP_LIVE_MS) sendGp();
    }
    function freeSlot() {
      const used = new Set();
      players.forEach(function (p) { used.add(p.slot); });
      let s = 0;
      while (used.has(s)) s++;
      return s;
    }
    function pickHost() {
      if (hostToken) return;                     // in-game server: only the token holder is ever host
      let best = null;
      players.forEach(function (p) { if (!best || p.order < best.order) best = p; });
      hostId = best ? best.id : 0;
    }
    function reject1(ws, code) {
      send(ws, { t: 'error', code: code });
      try { ws.close(1008, code); } catch (e) {}
    }

    function onHello(ws, m) {
      if (ws._player) return;
      if (m.v !== PROTOCOL) { reject1(ws, 'version'); return; }
      if (players.size >= maxPlayers) { reject1(ws, 'full'); return; }
      const id = nextId++;
      const p = {
        id: id, ws: ws, order: joinCounter++, slot: freeSlot(),
        name: cleanName(m.name, 'Player ' + id),
        colour: cleanColour(m.colour, COLOURS[id % COLOURS.length]),
        state: null, ct: 0, fresh: false, last: null, best: null, hitT: 0
      };
      players.set(id, p);
      ws._player = p;
      if (hostToken) {
        if (typeof m.token === 'string' && m.token === hostToken) hostId = id;
      } else if (!hostId) hostId = id;
      session.addPlayer(id, p.name, Date.now());
      send(ws, { t: 'welcome', v: PROTOCOL, id: id, host: hostId, track: trackId, seq: trackSeq, players: roster(), now: Date.now() });
      sendRoster();
      sendGp();
      log('join  #' + id + ' "' + p.name + '" (' + players.size + '/' + maxPlayers + ')');
    }

    function handleMessage(ws, data, isBinary) {
      if (isBinary) return;
      // rate limit (token bucket)
      const now = Date.now();
      ws._tokens = Math.min(RATE_BURST, ws._tokens + (now - ws._tokenT) * RATE_PER_SEC / 1000);
      ws._tokenT = now;
      if (ws._tokens < 1) {
        if (++ws._dropped > RATE_KICK) { try { ws.close(1008, 'flood'); } catch (e) {} }
        return;
      }
      ws._tokens -= 1;

      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;

      if (m.t === 'hello') { onHello(ws, m); return; }
      const p = ws._player;
      if (!p) return;                              // everything else needs a hello first

      switch (m.t) {
        case 's': {                                // car state
          if (m.k !== trackSeq) return;            // state from before the last track change
          const st = cleanState(m.s);
          if (!st || !isNum(m.c)) return;
          p.state = st; p.ct = Math.round(clamp(m.c, 0, 1e13)); p.fresh = true;
          if (isNum(m.g)) session.progress(p.id, m.g);     // race progress rides along
          break;
        }
        case 'ping': {                             // clock sync for the start lights
          if (isNum(m.c)) send(ws, { t: 'pong', c: m.c, s: Date.now() });
          break;
        }
        case 'gp': {                               // host: start / skip / end / again
          if (p.id !== hostId || typeof m.a !== 'string') return;
          let changed = false;
          if (m.a === 'start') changed = !!trackId && session.start({ q: m.q, r: m.r, len: m.len }, now);
          else if (m.a === 'skip') changed = session.skip(now);
          else if (m.a === 'end') changed = session.end();
          else if (m.a === 'again') changed = session.again(now);
          if (changed) { log('gp    ' + m.a + ' -> ' + session.phase); sendGp(); }
          break;
        }
        case 'gl': {                               // a lap completed in qualifying / the race
          if (m.k !== trackSeq || m.sid !== session.sid) return;
          const why = session.lap(p.id, m.time, now);
          if (why) send(ws, { t: 'glno', why: why });
          else sendGp();
          break;
        }
        case 'hit': {                              // "my car just hit yours": relayed to that player only
          if (m.k !== trackSeq || !isNum(m.to) || !Array.isArray(m.i) || m.i.length !== 2) return;
          if (!isNum(m.i[0]) || !isNum(m.i[1])) return;
          const target = players.get(m.to);
          if (!target || target === p || now - p.hitT < HIT_MIN_MS) return;
          p.hitT = now;
          let ix = m.i[0], iz = m.i[1];
          const mag = Math.sqrt(ix * ix + iz * iz);
          if (!(mag > 0) || !isNum(mag)) return;
          if (mag > HIT_MAX) { ix *= HIT_MAX / mag; iz *= HIT_MAX / mag; }
          send(target.ws, { t: 'hit', from: p.id, i: [round(ix, 100), round(iz, 100)] });
          break;
        }
        case 'track': {
          if (p.id !== hostId) return;
          const id = cleanTrackId(m.id);
          if (!id) return;
          trackId = id; trackSeq++;
          players.forEach(function (q) { q.state = null; q.fresh = false; q.last = null; q.best = null; });
          const gpEnded = session.phase !== 'free';
          while (session.phase !== 'free') session.end();   // a new track ends a Grand Prix in progress
          broadcast({ t: 'track', id: trackId, seq: trackSeq });
          sendRoster();
          if (gpEnded) sendGp();
          log('track ' + trackId);
          break;
        }
        case 'profile': {
          const name = cleanName(m.name, p.name), colour = cleanColour(m.colour, p.colour);
          if (name === p.name && colour === p.colour) return;
          p.name = name; p.colour = colour;
          sendRoster();
          if (session.rename(p.id, name) && session.phase !== 'free') sendGp();
          break;
        }
        case 'lap': {
          const last = cleanLap(m.last), best = cleanLap(m.best);
          if (last === p.last && best === p.best) return;
          p.last = last; p.best = best;
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
      const p = ws._player;
      if (!p || players.get(p.id) !== p) return;
      players.delete(p.id);
      ws._player = null;
      log('leave #' + p.id + ' "' + p.name + '" (' + players.size + '/' + maxPlayers + ')');
      if (closed) return;
      if (p.id === hostId) { hostId = 0; pickHost(); }
      session.removePlayer(p.id, Date.now());
      broadcast({ t: 'gone', id: p.id });
      sendRoster();
      sendGp();
    }

    wss.on('connection', function (ws, req) {
      const ip = (req && req.socket && req.socket.remoteAddress) || '?';
      ws._ip = ip;
      perIp.set(ip, (perIp.get(ip) || 0) + 1);
      ws._player = null; ws._alive = true;
      ws._tokens = RATE_BURST; ws._tokenT = Date.now(); ws._dropped = 0;
      ws.on('error', function () {});               // e.g. oversized frame: ws closes the socket itself
      ws.on('close', function () { try { onClose(ws); } catch (e) { log('close error: ' + e.message); } });
      ws.on('pong', function () { ws._alive = true; });
      ws.on('message', function (data, isBinary) {
        try { handleMessage(ws, data, isBinary); } catch (e) { log('message error: ' + (e && e.message)); }
      });
      const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (wss.clients.size > MAX_SOCKETS || (!loopback && perIp.get(ip) > MAX_PER_IP)) {
        reject1(ws, 'busy');
        return;
      }
      ws._helloTimer = setTimeout(function () {
        ws._helloTimer = null;
        if (!ws._player) { try { ws.terminate(); } catch (e) {} }
      }, HELLO_TIMEOUT_MS);
    });

    function snapshot() {
      if (players.size < 2) { players.forEach(function (p) { p.fresh = false; }); return; }
      const list = [];
      players.forEach(function (p) {
        if (!p.fresh || !p.state) return;
        p.fresh = false;
        const s = p.state;
        list.push([p.id, p.ct, s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]);
      });
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
      clearInterval(snapTimer); clearInterval(pingTimer); clearInterval(gpTimer);
      return new Promise(function (res) {
        wss.clients.forEach(function (ws) {
          if (ws._helloTimer) { clearTimeout(ws._helloTimer); ws._helloTimer = null; }
          try { ws.close(1001, 'server closing'); } catch (e) {}
        });
        // do not wait for polite close handshakes from dead peers
        const kill = setTimeout(function () {
          wss.clients.forEach(function (ws) { try { ws.terminate(); } catch (e) {} });
        }, 300);
        wss.close(function () { clearTimeout(kill); res(); });
      });
    }

    wss.on('error', function (err) {
      if (!started) { reject(err); return; }
      log('server error: ' + (err && err.message));
    });
    wss.on('listening', function () {
      started = true;
      snapTimer = setInterval(function () { try { snapshot(); } catch (e) { log('snapshot error: ' + e.message); } }, SNAP_MS);
      pingTimer = setInterval(function () { try { heartbeat(); } catch (e) {} }, PING_MS);
      gpTimer = setInterval(function () { try { gpTick(); } catch (e) { log('gp error: ' + e.message); } }, GP_TICK_MS);
      const addr = wss.address();
      resolve({
        port: addr && addr.port ? addr.port : port,
        close: close,
        info: function () { return { players: roster(), host: hostId, track: trackId, seq: trackSeq, gp: session.snapshot() }; }
      });
    });
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
  DEFAULT_PORT: DEFAULT_PORT, MAX_PLAYERS: MAX_PLAYERS, PROTOCOL: PROTOCOL
};

if (require.main === module) {
  const arg = process.argv[2];
  const p = arg == null ? DEFAULT_PORT : Number(arg);
  if (!(Number.isInteger(p) && p > 0 && p < 65536)) {
    console.error('usage: node net/server.js [port]   (default ' + DEFAULT_PORT + ')');
    process.exit(1);
  }
  const stamp = function (s) { console.log(new Date().toISOString().slice(11, 19) + ' ' + s); };
  createServer({ port: p, log: stamp }).then(function (srv) {
    stamp('F1Drive server listening on 0.0.0.0:' + srv.port + ' (TCP). LAN addresses: ' +
      (lanAddresses().join(', ') || 'none found'));
    stamp('The first player to join is the host and picks the track.');
    const stop = function () { srv.close().then(function () { process.exit(0); }); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, function (err) {
    console.error('cannot start server: ' + (err && err.code === 'EADDRINUSE' ? 'port ' + p + ' is already in use' : err && err.message));
    process.exit(1);
  });
}
