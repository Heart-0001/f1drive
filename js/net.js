// F1Drive - multiplayer client (F1.net). Talks to net/server.js over a WebSocket. See js/README-interfaces.md.
// No DOM besides WebSocket / timers; no THREE.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var PROTOCOL = 2;             // 2 (v7.2): the room lobby (net.room); incompatible with 1
  var DEFAULT_PORT = 24500;
  var SEND_MS = 45;             // own state goes out at ~20 Hz (every 3rd frame at 60 fps)
  var KEEPALIVE_MS = 200;       // when the game loop is not running (menu) the last pose is repeated, parked
  var INTERP_DELAY = 100;       // remote cars are drawn this far in the past (ms)
  var LEAD = 0.1;               // s: the interpolated pose is pushed forward along its heading by speed * LEAD,
                                //   so a car at 300 km/h is not drawn (and hit) 8 m behind where it really is
  var MAX_EXTRAP = 250;         // ms of dead reckoning when snapshots are late
  var STALE_MS = 3000;          // no snapshot for this long -> the remote car is hidden
  var TELEPORT = 30;            // m between two snapshots that means "reset", not "drove there"
  var BUF_MAX = 24;
  var CONNECT_TIMEOUT = 8000;
  var NAME_MAX = 16;
  var HIT_MAX = 50;             // m/s, the largest velocity change the server relays in one impact report
  var CLOCK_MAX = 1e14;         // ms: no server clock is beyond this (keeps a hostile value out of the arithmetic)
  var PING_KEEP = 8;            // pings that may be waiting for their pong
  var GP_PHASES = { free: 1, quali: 1, grid: 1, race: 1, results: 1 };
  var GP_ACTIONS = { skip: 1, end: 1, again: 1 };   // ('start': a room starts with startRoom)
  var ROOM_STATES = { lobby: 1, loading: 1, session: 1 };
  var ROOM_IDS_MAX = 64;        // ids in one list of a room message that we keep
  var LEN_MIN = 200, LEN_MAX = 100000;   // m: a track length a start / a loaded report may name
  var Q_MAX = 20, R_MAX = 99, ROOM_BOTS_MAX = 15;
  var GP_MAX_PLAYERS = 64;      // rows of a session snapshot we keep (the server has at most 32)
  var YEAR_MIN = 2010, YEAR_MAX = 2100;   // a room / session year; anything else is "no year" (null)
  var WEAR_MAX = 5;             // tyre wear multiplier of a Grand Prix, 1..5
  var PW_MAX = 64;              // characters of a room password
  // computer drivers ("bots", simulated by the host's game; see net/server.js)
  var BOT_LEVELS = { rookie: 1, amateur: 1, pro: 1, legend: 1, mixed: 1 };   // the room's strength setting
  var BOT_LEVEL_DEFAULT = 'pro';
  var BOTS_MAX = 16;            // bots in one room at most (the server gives fewer: humans + bots <= 16)
  var MSG_MAX = 1900;           // bytes we put in one message (the server refuses frames over 2048)
  var HIT_MIN_MS = 40;          // the server takes one impact report per car per 40 ms

  var ws = null;
  var handlers = {};
  var pending = null;           // { resolve } of the join in progress
  var connectTimer = 0, keepTimer = 0;
  var hosting = false;          // we started the server through the preload API
  var profile = { name: 'Player', colour: '#ff7a14', car: '' };   // car: a CarSpec id, '' = not chosen
  // the room's load cycles: the rs 'load' was last emitted for, the rs we last reported (ok or not) with sendLoaded;
  // the address being joined (net.address once in)
  var loadEmitRs = -1, reportedRs = -1, joinLabel = null;
  var lastSendT = 0, lastState = null;
  var remotes = {};             // id -> remote record
  var lastError = '';
  var pwSent = false;           // the hello of the connection in progress carried a room password
  // Session clock. localNow() is OUR clock: Date.now() read once and advanced by the monotonic timer, so a
  // system clock change (time sync, the user) in the middle of a start sequence does not move the lights.
  // The server's clock = localNow() + clockOff, learnt from ping / pong (the fastest exchange wins).
  var clockBase = Date.now() - nowMs();
  var clockOff = 0, clockRtt = Infinity, pingTimer = 0, pingCount = 0;
  var pings = [];               // send times (localNow) of the pings still waiting for their pong, oldest first
  var progress = null;          // race progress sent along with the car state
  // our bots (we host the room and simulate them): id -> true, their race progress, the last rows sent (repeated
  // parked by keepalive while the game loop stands still), the last impact report per bot
  var myBots = {}, botProg = {}, lastBotRows = null, lastBotSendT = 0, botHitT = {}, botSig = '';

  function localNow() { return clockBase + nowMs(); }

  function sendPing() {
    if (!net.connected) return;
    pingCount++;
    var c = Math.round(localNow() * 1000) / 1000;
    pings.push(c);
    if (pings.length > PING_KEEP) pings.shift();
    send({ t: 'ping', c: c });
    clearTimeout(pingTimer);
    pingTimer = setTimeout(sendPing, pingCount < 6 ? 300 : 10000);
  }

  function resetClock() {
    clearTimeout(pingTimer);
    clockOff = 0; clockRtt = Infinity; pingCount = 0; pings.length = 0;
  }

  function nowMs() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }
  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
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
    var s = stripControl(v).replace(/\s+/g, ' ').trim();
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
  function cleanYear(v) {                  // a whole year 2010..2100, else null
    return typeof v === 'number' && v % 1 === 0 && v >= YEAR_MIN && v <= YEAR_MAX ? v : null;
  }
  // a room password as net/server.js compares it: NFC, trimmed, at most PW_MAX characters; '' = none
  function cleanPassword(v) {
    if (typeof v !== 'string') return '';
    var s = typeof v.normalize === 'function' ? v.normalize('NFC') : v;
    return Array.from(s.trim()).slice(0, PW_MAX).join('');
  }
  function cleanSkill(v) {                 // a bot's skill 0..1 (3 decimals), else null
    return isNum(v) ? Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000 : null;
  }
  function cleanLevel(v) { return typeof v === 'string' && BOT_LEVELS[v] === 1 && BOT_LEVELS.hasOwnProperty(v) ? v : null; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function isMine(id) { return isNum(id) && myBots.hasOwnProperty(id) && myBots[id] === true; }
  function utf8Bytes(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* ---------- Grand Prix session snapshot: never trusted as it comes off the wire ---------- */

  function count(v, max) { return isNum(v) && v > 0 ? Math.min(Math.floor(v), max) : 0; }
  function lapTime(v) { return isNum(v) && v > 0 ? v : null; }
  function clockMs(v) { return isNum(v) && v > 0 && v < CLOCK_MAX ? v : 0; }
  function cleanIds(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < GP_MAX_PLAYERS; i++) if (isNum(list[i])) out.push(list[i]);
    return out;
  }

  /**
   * -> a fresh snapshot with every documented field present and of the documented type (see
   * js/README-interfaces.md), or null when `s` is not a session snapshot. Whatever reads net.session can
   * rely on the shape; it cannot rely on the VALUES being fair (the server is the authority).
   */
  function cleanSession(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    if (typeof s.phase !== 'string' || GP_PHASES[s.phase] !== 1 || !isNum(s.sid) || !Array.isArray(s.players)) return null;
    var lightsAt = clockMs(s.lightsAt), goAt = clockMs(s.goAt);
    // the start lights need both clocks
    if ((s.phase === 'grid' || s.phase === 'race') && !(goAt > 0 && lightsAt > 0 && lightsAt <= goAt)) return null;
    var players = [], n = Math.min(s.players.length, GP_MAX_PLAYERS);
    for (var i = 0; i < n; i++) {
      var p = s.players[i];
      if (!p || typeof p !== 'object' || !isNum(p.id)) continue;
      players.push({
        id: p.id, name: cleanName(p.name, 'Player ' + p.id),
        spec: p.spec === true, left: p.left === true,
        qLaps: count(p.qLaps, 999), qBest: lapTime(p.qBest), qDone: p.qDone === true,
        rLaps: count(p.rLaps, 999), rTime: isNum(p.rTime) && p.rTime > 0 ? p.rTime : 0, rBest: lapTime(p.rBest),
        fin: p.fin === true, dnf: p.dnf === true,
        gap: isNum(p.gap) && p.gap >= 0 ? p.gap : null, down: count(p.down, 999)
      });
      if (p.bot === true) players[players.length - 1].bot = true;   // a computer driver: only its rows carry the field
    }
    return {
      sid: s.sid, phase: s.phase,
      q: count(s.q, 20) || 3, r: count(s.r, 99) || 5, len: isNum(s.len) && s.len > 0 ? s.len : 0,
      year: cleanYear(s.year), wear: count(s.wear, WEAR_MAX) || 1,
      lightsAt: lightsAt, goAt: goAt, winnerAt: clockMs(s.winnerAt), endsAt: clockMs(s.endsAt),
      grid: cleanIds(s.grid), order: cleanIds(s.order), players: players
    };
  }

  /* ---------- the room (protocol 2): never trusted as it comes off the wire either ---------- */

  // a whole number lo..hi after Math.round, else null (as net/server.js cleans a setting: never clamped)
  function wholeIn(v, lo, hi) {
    if (!isNum(v)) return null;
    v = Math.round(v);
    return v >= lo && v <= hi ? v : null;
  }
  function cleanLen(v) { return isNum(v) && v >= LEN_MIN && v <= LEN_MAX ? v : null; }
  function cleanWhy(v) { return typeof v === 'string' && /^[a-z-]{1,16}$/.test(v) ? v : ''; }
  // up to ROOM_IDS_MAX numeric ids, each once
  function roomIds(list) {
    var out = [], seen = {};
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < ROOM_IDS_MAX; i++) {
      var id = list[i];
      if (isNum(id) && !seen[id]) { seen[id] = true; out.push(id); }
    }
    return out;
  }
  function defaultRoom() {
    return { st: 'lobby', rs: 0, set: { track: null, year: null, mode: 'free', q: 3, r: 5, wear: 1, bots: 0, skill: BOT_LEVEL_DEFAULT },
             ready: [], rr: 0, load: null, len: 0 };
  }
  /**
   * -> a fresh room with every documented field present and of its type (see js/README-interfaces.md, v7.2), or null
   * when `o` is not a room at all (no object, or st not one of the three). A setting that is not valid gets the
   * default; load is null outside 'loading'.
   */
  function cleanRoom(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.st !== 'string' || ROOM_STATES[o.st] !== 1) return null;
    var s = o.set && typeof o.set === 'object' && !Array.isArray(o.set) ? o.set : {};
    var r = defaultRoom();
    r.st = o.st;
    r.rs = isNum(o.rs) && o.rs >= 0 && o.rs < 1e12 ? Math.floor(o.rs) : 0;
    r.set.track = cleanTrackId(s.track);
    r.set.year = cleanYear(s.year);
    r.set.mode = s.mode === 'gp' ? 'gp' : 'free';
    r.set.q = wholeIn(s.q, 1, Q_MAX) || 3;
    r.set.r = wholeIn(s.r, 1, R_MAX) || 5;
    r.set.wear = wholeIn(s.wear, 1, WEAR_MAX) || 1;
    r.set.bots = isNum(s.bots) && s.bots > 0 ? Math.min(Math.floor(s.bots), ROOM_BOTS_MAX) : 0;
    r.set.skill = cleanLevel(s.skill) || BOT_LEVEL_DEFAULT;
    r.ready = roomIds(o.ready);
    r.rr = isNum(o.rr) && o.rr >= 0 && o.rr < 1e12 ? Math.floor(o.rr) : 0;
    var L = o.load;
    if (r.st === 'loading' && L && typeof L === 'object' && !Array.isArray(L)) {
      r.load = { at: clockMs(L.at), until: clockMs(L.until), wait: roomIds(L.wait), done: roomIds(L.done), fail: roomIds(L.fail) };
    }
    r.len = cleanLen(o.len) || 0;
    return r;
  }
  // roster rows: ready (guests from room.ready; the host and the bots count as ready) and load ('' | 'wait' | 'done' |
  // 'fail' from room.load)
  function mergeRoom() {
    var room = net.room, i, e;
    for (i = 0; i < net.roster.length; i++) {
      e = net.roster[i];
      e.ready = e.isHost || e.bot || (!!room && room.ready.indexOf(e.id) >= 0);
      e.load = '';
      if (room && room.load && !e.bot) {
        e.load = room.load.wait.indexOf(e.id) >= 0 ? 'wait' : room.load.done.indexOf(e.id) >= 0 ? 'done'
          : room.load.fail.indexOf(e.id) >= 0 ? 'fail' : '';
      }
    }
  }
  // what belongs to one load cycle: our pose, our progress, our bots' poses and progress, every remote pose
  function dropCycle() {
    lastState = null; progress = null;
    lastBotRows = null; botProg = {};
    clearPoses();
  }
  // our car states may go out: the room's session of the cycle we built the track of
  function onTrack() { return net.connected && !!net.room && net.room.st === 'session' && net.loadedRs === net.room.rs; }
  function curRs() { return net.room ? net.room.rs : 0; }

  // 'load' once per load cycle, when the room is loading or in a session with a track (a start, or we joined then)
  function maybeLoad(r) {
    if ((r.st !== 'loading' && r.st !== 'session') || !r.set.track || loadEmitRs === r.rs) return false;
    loadEmitRs = r.rs;
    dropCycle();
    emit('load', r.set.track, r.rs);
    return true;
  }
  // A `room` message (prev: the room we had). Events in this order: 'year' (when it changed), 'room', then the
  // transition: 'lobby' (loading / session -> lobby), 'load' (a load cycle we have not loaded for), 'go' (loading ->
  // session of the same cycle).
  function applyRoom(r, prev) {
    net.room = r;
    net.trackId = r.set.track;
    var y = r.set.year, yearChanged = y !== net.year;
    net.year = y;
    mergeRoom();
    if (yearChanged) emit('year', y);
    emit('room', r, prev);
    if (prev.st !== 'lobby' && r.st === 'lobby') {
      dropCycle();
      resyncCar();                                 // (a car chosen during a Grand Prix may go out now)
      emit('lobby');
    } else if (maybeLoad(r)) {
      // (nothing more for this message)
    } else if (prev.st === 'loading' && r.st === 'session' && prev.rs === r.rs) {
      if (r.set.mode === 'free') resyncCar();      // (a car chosen while loading may go out now)
      emit('go', r.rs);
    }
  }

  function emit(name, a, b, c) {
    var list = handlers[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b, c); } catch (err) { if (root.console) console.error(err); }
    }
  }

  /**
   * parseAddress("1.2.3.4" | "1.2.3.4:24500" | "host.name[:port]" | "[::1]" | "[::1]:24500" | "::1" | "ws://...")
   *   -> { host, port, url } or null
   */
  function parseAddress(text, defPort) {
    if (typeof text !== 'string') return null;
    var s = text.trim().replace(/^[a-z]+:\/\//i, '').replace(/[\/?#].*$/, '');
    if (!s || s.length > 255) return null;
    var host, port = null, m, v6 = false;
    if (s.charAt(0) === '[') {
      m = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(s);
      if (!m || m[1].indexOf(':') < 0) return null;
      host = m[1]; port = m[2]; v6 = true;
    } else if (s.split(':').length > 2) {
      if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;      // bare IPv6, no port possible
      host = s; v6 = true;
    } else {
      m = /^([A-Za-z0-9_](?:[A-Za-z0-9_.\-]*[A-Za-z0-9_])?)(?::(\d{1,5}))?$/.exec(s);
      if (!m) return null;
      host = m[1]; port = m[2];
    }
    var p = port == null || port === '' ? (defPort || DEFAULT_PORT) : Number(port);
    if (!(p >= 1 && p <= 65535) || Math.floor(p) !== p) return null;
    var h = v6 ? '[' + host + ']' : host;
    return { host: h, port: p, url: 'ws://' + h + ':' + p };
  }

  /* ---------- remote players: snapshot buffer + interpolation ---------- */

  function makeRemote(id) {
    return {
      id: id, name: 'Player ' + id, colour: '#ff7a14', car: '', slot: 0, last: null, best: null,
      bot: false, skill: null, owner: 0,   // a computer driver (simulated by player `owner`'s game) and its skill 0..1
      active: false,                // has a recent pose (draw it / collide with it)
      state: { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steer: 0 },
      _buf: [], _off: null, _offS: null, _recv: 0, _ct: -Infinity
    };
  }

  function pushSnap(r, e, now) {
    // e = [id, ct, x, y, z, heading, pitch, roll, speed, steer]
    if (!isNum(e[1])) return;
    for (var i = 2; i < 10; i++) if (!isNum(e[i]) || e[i] > 1e6 || e[i] < -1e6) return;   // the server clamps far tighter
    var ct = e[1];
    if (ct <= r._ct) {
      if (ct > r._ct - 5000) return;                   // duplicate / out of order
      r._buf.length = 0; r._off = null; r._offS = null; // the sender's clock restarted
    }
    var d = now - ct;
    // offset between our clock and the sender's: follow the fastest deliveries, creep up slowly
    r._off = r._off === null || Math.abs(d - r._off) > 2000 ? d : Math.min(r._off + 0.05, d);
    var b = r._buf, n = b.length;
    if (n) {
      var q = b[n - 1], dx = e[2] - q.x, dz = e[4] - q.z;
      if (dx * dx + dz * dz > TELEPORT * TELEPORT) b.length = 0;
    }
    b.push({ t: ct, x: e[2], y: e[3], z: e[4], h: e[5], p: e[6], r: e[7], v: e[8], st: e[9] });
    if (b.length > BUF_MAX) b.shift();
    r._ct = ct; r._recv = now;
  }

  function sample(r, now) {
    var b = r._buf, n = b.length, s = r.state;
    if (!n || now - r._recv > STALE_MS) { r.active = false; return; }
    r.active = true;
    // the playback clock follows the offset estimate gradually, so a correction never shows as a jump
    if (r._offS === null || Math.abs(r._off - r._offS) > 300) r._offS = r._off;
    else r._offS += (r._off - r._offS) * 0.04;
    var rt = now - r._offS - INTERP_DELAY;
    var last = b[n - 1], lead = LEAD;
    if (rt >= last.t) {
      // late: dead-reckon from the newest snapshot for a short while, then stand still
      var over = rt - last.t, ex = Math.min(over, MAX_EXTRAP) / 1000;
      var yaw = 0;
      if (n > 1) {
        var pv = b[n - 2], dtp = (last.t - pv.t) / 1000;
        if (dtp > 0.01 && dtp < 0.5) yaw = Math.max(-2, Math.min(2, wrapPi(last.h - pv.h) / dtp));
      }
      s.x = last.x; s.y = last.y; s.z = last.z;
      s.heading = last.h + yaw * ex; s.pitch = last.p; s.roll = last.r;
      s.speed = last.v; s.steer = last.st;
      lead += ex;
      if (over > MAX_EXTRAP) {                 // gave up predicting: it stays where the prediction ended
        s.x += Math.sin(s.heading) * s.speed * lead;
        s.z += Math.cos(s.heading) * s.speed * lead;
        s.speed = 0;
        return;
      }
    } else {
      var i = n - 1;
      while (i > 0 && b[i - 1].t > rt) i--;
      if (i === 0) {                 // older than everything we have
        var f0 = b[0];
        s.x = f0.x; s.y = f0.y; s.z = f0.z; s.heading = f0.h; s.pitch = f0.p; s.roll = f0.r; s.speed = f0.v; s.steer = f0.st;
      } else {
        var a = b[i - 1], c = b[i], span = c.t - a.t, k = span > 0 ? (rt - a.t) / span : 1;
        if (k < 0) k = 0; else if (k > 1) k = 1;
        s.x = a.x + (c.x - a.x) * k;
        s.y = a.y + (c.y - a.y) * k;
        s.z = a.z + (c.z - a.z) * k;
        s.heading = a.h + wrapPi(c.h - a.h) * k;
        s.pitch = a.p + (c.p - a.p) * k;
        s.roll = a.r + (c.r - a.r) * k;
        s.speed = a.v + (c.v - a.v) * k;
        s.steer = a.st + (c.st - a.st) * k;
      }
    }
    s.x += Math.sin(s.heading) * s.speed * lead;
    s.z += Math.cos(s.heading) * s.speed * lead;
  }

  function clearPoses() {
    for (var id in remotes) {
      var r = remotes[id];
      r._buf.length = 0; r._off = null; r._offS = null; r._ct = -Infinity; r.active = false;
    }
  }

  function rebuildPlayers() {
    var list = [];
    for (var id in remotes) list.push(remotes[id]);
    list.sort(function (a, b) { return a.slot - b.slot; });
    net.players = list;
  }

  /* ---------- connection ---------- */

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch (err) { return false; }
  }

  function sendProfile() { send({ t: 'profile', name: profile.name, colour: profile.colour, car: profile.car }); }

  // Parc fermé: the server keeps our car while the room loads and during a Grand Prix. A car chosen meanwhile (or one
  // that crossed a start on the way) is sent again once the room is back in the lobby or in a free-practice session.
  function resyncCar() {
    if (!profile.car) return;
    for (var i = 0; i < net.roster.length; i++) {
      if (net.roster[i].isSelf) { if (net.roster[i].car !== profile.car) sendProfile(); return; }
    }
  }

  // The room's computer-driver setting as it rides on welcome / players: {n: bots in the room, skill: level id}.
  function applyBotInfo(b) {
    var o = b && typeof b === 'object' ? b : {};
    net.botSettings = { n: isNum(o.n) && o.n > 0 ? Math.min(Math.floor(o.n), BOTS_MAX) : 0,
                        skill: cleanLevel(o.skill) || BOT_LEVEL_DEFAULT };
  }

  function applyRoster(m) {
    if (!Array.isArray(m.players)) return;
    var seen = {}, roster = [], mine = [], ids = {}, n = Math.min(m.players.length, 32);
    var hostId = isNum(m.host) ? m.host : 0;
    for (var i = 0; i < n; i++) {
      var p = m.players[i];
      if (!p || !isNum(p.id) || ids[p.id]) continue;          // (an id listed twice: the first row counts)
      ids[p.id] = true;
      var bot = p.bot === true && p.id !== net.id;
      var e = {
        id: p.id,
        name: cleanName(p.name, (bot ? 'AI ' : 'Player ') + p.id),
        colour: cleanColour(p.colour, '#ff7a14'),
        car: cleanCarId(p.car) || '',
        slot: isNum(p.slot) && p.slot >= 0 ? Math.floor(p.slot) : i,
        last: isNum(p.last) ? p.last : null,
        best: isNum(p.best) ? p.best : null,
        isHost: p.id === hostId,
        isSelf: p.id === net.id,
        bot: bot,                                             // a computer driver
        skill: bot ? cleanSkill(p.skill) : null,              //   its strength 0..1 (null: not told)
        owner: bot && isNum(p.owner) ? p.owner : 0,           //   whose game simulates it
        mine: false                                           //   ours (we simulate it: a local car, not a remote)
      };
      e.mine = bot && !!net.id && e.owner === net.id;
      roster.push(e);
      if (e.isSelf) { net.slot = e.slot; continue; }
      if (e.mine) {
        mine.push({ id: e.id, name: e.name, colour: e.colour, car: e.car, slot: e.slot, skill: e.skill,
                    bi: isNum(p.bi) && p.bi >= 0 ? Math.floor(p.bi) : BOTS_MAX + mine.length, last: e.last, best: e.best });
        continue;
      }
      seen[e.id] = true;
      var r = remotes[e.id] || (remotes[e.id] = makeRemote(e.id));
      r.name = e.name; r.colour = e.colour; r.car = e.car; r.slot = e.slot; r.last = e.last; r.best = e.best;
      r.bot = e.bot; r.skill = e.skill; r.owner = e.owner;
    }
    for (var id in remotes) if (!seen[id]) delete remotes[id];
    // our own bots, in the order of the list we sent (bi)
    mine.sort(function (a, b) { return a.bi - b.bi || a.id - b.id; });
    myBots = {};
    var sig = [];
    for (i = 0; i < mine.length; i++) {
      myBots[mine[i].id] = true;
      sig.push([mine[i].id, mine[i].name, mine[i].colour, mine[i].car, mine[i].slot, mine[i].skill].join('|'));
    }
    for (id in botProg) if (!myBots[id]) delete botProg[id];
    for (id in botHitT) if (!myBots[id]) delete botHitT[id];
    net.bots = mine;
    if (m.bots !== undefined || m.t === 'welcome') applyBotInfo(m.bots);
    net.roster = roster;
    net.hostId = hostId;
    net.isHost = !!net.id && hostId === net.id;
    mergeRoom();                                  // (ready / load from the room)
    rebuildPlayers();
    emit('players', roster);
    sig = sig.join('\n');
    if (sig !== botSig) { botSig = sig; emit('bots', net.bots); }
  }

  function onMessage(ev) {
    var m;
    if (typeof ev.data !== 'string' || ev.data.length > 65536) return;
    try { m = JSON.parse(ev.data); } catch (err) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'snap': {
        if (!net.connected || !Array.isArray(m.p)) return;
        var now = nowMs();
        for (var i = 0; i < m.p.length && i < 64; i++) {
          var e = m.p[i];
          // ids are numbers: '__proto__' / 'constructor' must never reach remotes[...] (Object.prototype)
          if (!Array.isArray(e) || e.length < 10 || !isNum(e[0]) || e[0] === net.id || !remotes.hasOwnProperty(e[0])) continue;
          pushSnap(remotes[e[0]], e, now);
        }
        break;
      }
      case 'pong': {
        if (!net.connected || !isNum(m.c) || !isNum(m.s) || !(m.s > 0 && m.s < CLOCK_MAX)) return;
        var k = pings.indexOf(m.c);
        if (k < 0) return;                        // not the answer to a ping of ours (or answered already)
        pings.splice(0, k + 1);                   // answers come in order: older pings are overtaken
        var tn = localNow(), rtt = tn - m.c;
        if (rtt < 0 || rtt > 5000) return;
        var off = m.s + rtt / 2 - tn;             // off by at most rtt / 2
        clockRtt += 2;                            // old estimates age, so a changed route is picked up
        // The fastest exchange is the best estimate. One that contradicts ours by more than both error
        // bounds means a clock was changed since (ours or the server's): start again from this one.
        if (rtt <= clockRtt || Math.abs(off - clockOff) > (rtt + clockRtt) / 2 + 50) { clockRtt = rtt; clockOff = off; }
        break;
      }
      case 'gp': {                                // Grand Prix session state (server authoritative)
        if (!net.connected) return;
        var snap = cleanSession(m.s);
        if (!snap) return;                        // not a snapshot: keep the one we have
        net.session = snap;
        emit('gp', snap);                         // (the car goes out again with the room's 'lobby', not here)
        break;
      }
      case 'glno': {                              // our lap (or one of our bots', id) was not accepted: a short reason code
        if (!net.connected) return;
        var why = typeof m.why === 'string' && /^[a-z\-]{1,24}$/.test(m.why) ? m.why : '';
        if (m.id === undefined) emit('lapRejected', why);
        else if (isMine(m.id)) emit('botLapRejected', m.id, why);
        break;
      }
      case 'welcome': {
        if (net.connected || !isNum(m.id)) return;
        clearTimeout(connectTimer);
        resetClock();
        if (isNum(m.now) && m.now > 0 && m.now < CLOCK_MAX) clockOff = m.now - localNow();   // rough until the first pong
        net.id = m.id;
        net.connected = true; net.connecting = false;
        net.ded = m.ded === true;
        net.address = hosting ? null : joinLabel;
        net.loadedRs = -1; loadEmitRs = -1; reportedRs = -1;
        lastState = null;
        // the room (a welcome without a usable one: a lobby with the defaults)
        var room = cleanRoom(m.room) || defaultRoom();
        net.room = room; net.trackId = room.set.track; net.year = room.set.year;
        applyRoster(m);
        if (pending) { var p = pending; pending = null; p.resolve({ ok: true }); }
        sendPing();
        emit('connected', { id: net.id, isHost: net.isHost });
        // the year before the track: the car (and so the racing line) is known before the track is built
        if (net.year !== null) emit('year', net.year);
        emit('room', room, null);
        maybeLoad(room);                          // a room that is loading / in a session: we load its track too
        break;
      }
      case 'players': {                           // the roster (the room year is in the room now)
        if (!net.connected || !Array.isArray(m.players)) return;
        applyRoster(m);
        break;
      }
      case 'room': {                              // the room's state, settings, ready flags, loading barrier
        if (!net.connected) return;
        var nr = cleanRoom(m);
        if (!nr) return;                          // not a room: keep the one we have
        applyRoom(nr, net.room || defaultRoom());
        break;
      }
      case 'nostart': {                           // the host's start was refused: why, and who is not ready
        if (!net.connected) return;
        emit('nostart', cleanWhy(m.why), roomIds(m.wait));
        break;
      }
      case 'gone': break;                         // the roster that follows removes the player
      case 'hit': {                               // another car hit ours (bot: or one of our bots)
        if (!net.connected || !Array.isArray(m.i) || !isNum(m.from) || !isNum(m.i[0]) || !isNum(m.i[1])) return;
        if (!remotes[m.from]) return;             // (a player or somebody else's bot; never one of ours)
        var hx = m.i[0], hz = m.i[1], hm = Math.sqrt(hx * hx + hz * hz);
        if (!isNum(hm)) return;
        if (hm > HIT_MAX) {                       // the server clamps; do not count on it
          hx = Math.round(hx / hm * HIT_MAX * 100) / 100; hz = Math.round(hz / hm * HIT_MAX * 100) / 100;
        }
        if (m.bot === undefined) emit('hit', m.from, [hx, hz]);
        else if (isMine(m.bot)) emit('botHit', m.bot, m.from, [hx, hz]);
        break;
      }
      case 'error': {
        // version: a v7.2+ server says which protocol it needs; an older one (protocol 1) does not
        lastError = m.code === 'full' ? '房間已滿（最多 16 人）'
          : m.code === 'version' ? (!isNum(m.need) ? '房間的遊戲版本比較舊（F1Drive v7.1 以前），請房主更新到 v7.2 以上。'
            : m.need > PROTOCOL ? '你的遊戲版本比較舊，請更新後再加入。' : '遊戲版本與房間不同，無法加入。')
          : m.code === 'busy' ? '伺服器忙碌中，請稍後再試'
          : m.code === 'flood' ? '傳送過於頻繁，伺服器已中斷連線'
          : m.code === 'password' ? (pwSent ? '房間密碼錯誤' : '這個房間需要密碼，請輸入房間密碼')
          : m.code === 'wait' ? '密碼錯誤次數太多，請一分鐘後再試'
          : m.code === 'idle' ? '太久沒有動作，已被移出房間' : '伺服器拒絕連線';
        break;
      }
      default: break;
    }
  }

  function teardown(reason) {
    var was = net.connected, s = ws, wasHosting = hosting;
    ws = null; hosting = false;
    clearTimeout(connectTimer);
    // nothing of the room's Grand Prix survives the connection: session, our race distance, the clock offset
    resetClock();
    net.session = null; progress = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try { s.close(); } catch (err) {}
    }
    net.connected = false; net.connecting = false; net.isHost = false;
    net.id = 0; net.hostId = 0; net.slot = 0; net.trackId = null; net.year = null; net.hostInfo = null;
    net.room = null; net.loadedRs = -1; net.ded = false; net.address = null;
    loadEmitRs = -1; reportedRs = -1; joinLabel = null;
    net.roster = []; net.players = [];
    remotes = {}; lastState = null;
    // our bots were the room's: they are gone with it
    var hadBots = botSig !== '';
    net.bots = []; applyBotInfo(null);
    myBots = {}; botProg = {}; lastBotRows = null; botHitT = {}; botSig = '';
    if (hadBots) emit('bots', net.bots);
    if (wasHosting && root.f1host) { try { root.f1host.stopServer(); } catch (err) {} }
    if (pending) { var p = pending; pending = null; p.resolve({ ok: false, error: reason }); }
    if (was) emit('disconnected', reason);
  }

  function connect(addr, token, password) {
    return new Promise(function (resolve) {
      var s;
      lastError = '';
      pwSent = !!password;
      try { s = new root.WebSocket(addr.url); } catch (err) {
        // e.g. an address the URL parser refuses (999.1.1.1): nothing was opened, leave nothing half set up
        teardown('');
        resolve({ ok: false, error: '無法連線到 ' + addr.host + ':' + addr.port });
        return;
      }
      ws = s;
      net.connecting = true;
      pending = { resolve: resolve };
      var label = addr.host + ':' + addr.port;
      connectTimer = setTimeout(function () {
        if (ws === s && !net.connected) teardown('連線逾時：' + label + ' 沒有回應（請確認位址、連接埠轉發與防火牆）');
      }, CONNECT_TIMEOUT);
      s.onopen = function () {
        if (ws !== s) return;
        var hello = { t: 'hello', v: PROTOCOL, name: profile.name, colour: profile.colour, car: profile.car };
        if (token) hello.token = token;
        if (password) hello.password = password;
        send(hello);
      };
      s.onmessage = function (ev) { if (ws === s) onMessage(ev); };
      s.onerror = function () {};
      s.onclose = function (ev) {
        if (ws !== s) return;
        var reason;
        if (net.connected) {
          reason = ev && ev.code === 1001 ? '連線中斷：房主已關閉房間' : '連線中斷';
          if (lastError) reason = '連線中斷：' + lastError;
        } else {
          reason = lastError || ('無法連線到 ' + label + '（請確認位址、連接埠轉發與防火牆）');
        }
        teardown(reason);
      };
    });
  }

  function keepalive() {
    if (!onTrack()) return;                       // (lobby / loading: nobody is on a track)
    var now = nowMs();
    if (lastState && now - lastSendT >= KEEPALIVE_MS) {
      lastState[6] = 0; lastState[7] = 0;         // the loop is not running: the car is standing still
      lastSendT = now;
      send({ t: 's', k: curRs(), c: Math.round(now), s: lastState });
    }
    if (lastBotRows && now - lastBotSendT >= KEEPALIVE_MS) {
      // our bots stand still with the loop (we simulate them): their last poses, parked, for the others
      var rows = [];
      for (var i = 0; i < lastBotRows.length; i++) {
        var r = lastBotRows[i];
        if (isMine(r[0])) rows.push([r[0], r[1], r[2], r[3], r[4], r[5], r[6], 0, 0]);
      }
      lastBotSendT = now;
      if (rows.length) sendRows(rows, now); else lastBotRows = null;
    }
  }

  // bot state rows -> one 'bs' message, or a few when they do not fit in one (never more than MSG_MAX bytes each)
  function sendRows(rows, now) {
    var c = Math.round(now), head = '{"t":"bs","k":' + curRs() + ',"c":' + c + ',"b":[', part = [], len = head.length + 2;
    for (var i = 0; i < rows.length; i++) {
      var s = JSON.stringify(rows[i]);
      if (part.length && len + s.length + 1 > MSG_MAX) {
        if (ws && ws.readyState === 1) { try { ws.send(head + part.join(',') + ']}'); } catch (err) {} }
        part = []; len = head.length + 2;
      }
      part.push(s); len += s.length + 1;
    }
    if (part.length && ws && ws.readyState === 1) { try { ws.send(head + part.join(',') + ']}'); } catch (err) {} }
  }

  var net = {
    DEFAULT_PORT: DEFAULT_PORT,
    MAX_PLAYERS: 16,
    /** true when the page runs inside the Electron app (it can host a room) */
    canCreate: !!(root.f1host && typeof root.f1host.startServer === 'function'),
    connected: false, connecting: false, isHost: false,
    id: 0, hostId: 0,
    slot: 0,                    // our grid slot (0 = pole), assigned by the server in join order
    trackId: null,              // = room.set.track: the room's chosen track (in the lobby it is NOT loaded yet)
    year: null,                 // = room.set.year: the room's season year (2010..2100) or null (none picked / not in a room)
    // The room (protocol 2), null outside one: a sanitised copy of the last `room` message (js/README-interfaces.md
    // v7.2): {st: 'lobby' | 'loading' | 'session', rs (the load cycle), set: {track, year, mode: 'free' | 'gp', q, r,
    // wear, bots, skill}, ready: [guest ids], rr (ready resets by a settings change), load: null | {at, until, wait,
    // done, fail} (server clock; ids), len (m, the session's track length; 0 in the lobby)}
    room: null,
    loadedRs: -1,               // the rs of our last sendLoaded(rs, true); -1 none (reset on connect / disconnect)
    ded: false,                 // the room is a dedicated server's (the host is the first player and migrates)
    address: null,              // the address we joined ('203.0.113.5:24500'); null for the host (hostInfo has his)
    session: null,              // Grand Prix state from the server: a sanitised net/session.js snapshot (every
                                //   documented field present and of its type), null when not in a room
    hostInfo: null,             // { port, addresses: [LAN IPv4], hasPassword } while we host
    roster: [],                 // everyone incl. us and the bots: [{id, name, colour, car, slot, last, best, isHost, isSelf,
                                //   bot, skill, owner, mine}]: bot = a computer driver, skill its strength 0..1 (null
                                //   = not told), owner the id of the player whose game simulates it, mine = ours;
                                //   ready (guests from room.ready; the host and bots true), load ('' | 'wait' | 'done' |
                                //   'fail' from room.load): protocol 2
    players: [],                // the OTHER cars to draw: [{id, name, colour, car, slot, bot, skill, owner, active,
                                //   state:{x,y,z,heading,pitch,roll,speed,steer}}]; car: a CarSpec id or '' (not chosen /
                                //   unknown). Humans and other players' bots alike; OUR bots are not in it (local cars).
    bots: [],                   // OUR bots (we host and simulate them), in the order of the list we sent:
                                //   [{id, name, colour, car, slot, skill, bi, last, best}] (slot = grid column / pit box)
    botSettings: { n: 0, skill: 'pro' },   // the room's computer drivers as the host set them: n in the room, skill =
                                //   'rookie' | 'amateur' | 'pro' | 'legend' | 'mixed' (everybody sees it)

    /** on('connected' | 'disconnected' | 'players' | 'year' | 'room' | 'load' | 'go' | 'lobby' | 'nostart' | 'hit' | 'gp' |
     *     'lapRejected' | 'bots' | 'botHit' | 'botLapRejected', fn)   ('track' is never emitted in protocol 2)
     *  year: fn(year | null), room.set.year changed (also once right after 'connected', before 'room', when the
     *  room has one; not on disconnect);
     *  room: fn(room, prev), every accepted `room` message (prev: the room before) and on welcome (prev null);
     *  load: fn(trackId, rs), once per load cycle when the room is loading or in a session with a track (a start, or we
     *  joined then): build it, then sendLoaded(rs, ok, {len | why});  go: fn(rs), loading -> session of that cycle;
     *  lobby: fn(), loading / session -> lobby;  nostart: fn(why, waitIds), our start was refused ('state' | 'track' |
     *  'len' | 'busy' | 'not-ready' (waitIds: the guests not ready) | 'load' (nobody loaded));
     *  order for one message: 'year', 'room', then 'lobby' / 'load' / 'go'; on welcome 'connected', 'year', 'room', 'load';
     *  hit: fn(fromId, [ix, iz]);  gp: fn(sessionSnapshot), the object net.session now is;
     *  lapRejected: fn(why): 'too-fast' | 'too-soon' | 'inconsistent' | 'not-driven' (the server did not see the car
     *  cover the lap) | 'no-data' (too few car states reached it during the lap) | 'bad' | 'done' | 'not-racing' |
     *  'no-session' | '';
     *  bots: fn(net.bots), our bots changed (ids, names, cars, colours, skills, slots; also [] when we leave);
     *  botHit: fn(botId, fromId, [ix, iz]), another car hit one of our bots (fromId is a remote car);
     *  botLapRejected: fn(botId, why), a lap of one of our bots was not accepted (reasons as lapRejected) */
    on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); },

    /** Host a room: starts the server in the Electron main process, then joins it. -> Promise<{ok, error}>
     *  opts (optional): { password }: a room password (trimmed, at most 64 characters; '' / missing = an open
     *  room); whoever joins must give it (net.join(address, {password})). net.hostInfo.hasPassword tells. */
    create: function (port, opts) {
      if (!net.canCreate) return Promise.resolve({ ok: false, error: '只有桌面版（F1Drive.exe）可以建立房間' });
      if (net.connected || net.connecting) return Promise.resolve({ ok: false, error: '已經在房間中' });
      port = Number(port == null || port === '' ? DEFAULT_PORT : port);
      if (!(port >= 1024 && port <= 65535) || Math.floor(port) !== port) {
        return Promise.resolve({ ok: false, error: '連接埠必須是 1024–65535 的整數' });
      }
      var password = cleanPassword(opts && opts.password);
      net.connecting = true;
      return root.f1host.startServer(port, { password: password }).then(function (res) {
        if (!res || !res.ok) {
          net.connecting = false;
          var e = res && res.error;
          return {
            ok: false,
            error: e === 'EADDRINUSE' ? '連接埠 ' + port + ' 已被其他程式使用，請換一個'
              : e === 'EACCES' ? '沒有權限使用連接埠 ' + port : '無法建立房間：' + (e || '未知錯誤')
          };
        }
        hosting = true;
        var info = { port: res.port, addresses: Array.isArray(res.addresses) ? res.addresses.slice(0, 8) : [],
                     hasPassword: !!password };
        var p = connect({ host: '127.0.0.1', port: res.port, url: 'ws://127.0.0.1:' + res.port }, res.token, password);
        net.hostInfo = info;                      // cleared again by teardown() if the join fails
        return p;
      }, function (err) {
        net.connecting = false;
        return { ok: false, error: '無法建立房間：' + (err && err.message ? err.message : err) };
      });
    },

    /** Join a room. opts (optional): { password } for a room that has one. -> Promise<{ok, error}>
     *  A room with a password refuses a wrong / missing one: {ok: false, error: '房間密碼錯誤' |
     *  '這個房間需要密碼，請輸入房間密碼'}; after 5 wrong ones in a minute: '密碼錯誤次數太多，請一分鐘後再試'. */
    join: function (address, opts) {
      if (net.connected || net.connecting) return Promise.resolve({ ok: false, error: '已經在房間中' });
      var addr = parseAddress(address, DEFAULT_PORT);
      if (!addr) return Promise.resolve({ ok: false, error: '位址格式不正確（例：203.0.113.5 或 203.0.113.5:24500）' });
      if (!root.WebSocket) return Promise.resolve({ ok: false, error: '此環境不支援 WebSocket' });
      joinLabel = addr.host + ':' + addr.port;     // net.address once we are in (cleared by teardown())
      return connect(addr, null, cleanPassword(opts && opts.password));
    },

    /** Leave the room (the host leaving closes the room for everyone). */
    leave: function () {
      if (!ws && !hosting) return;
      teardown('已離開房間');
    },

    /** setProfile({name, colour, car}): what the room sees of us. A field that is missing or not valid keeps its
     *  previous value (car: a CarSpec id, /^[a-z0-9-]{1,40}$/). While the room loads and during a Grand Prix the
     *  server keeps our car (parc fermé); a car chosen meanwhile is sent again when the room is back in the lobby
     *  (or the free-practice session begins). */
    setProfile: function (p) {
      p = p || {};
      var name = cleanName(p.name, profile.name), colour = cleanColour(p.colour, profile.colour);
      var car = cleanCarId(p.car) || profile.car;
      if (name === profile.name && colour === profile.colour && car === profile.car) return;
      profile.name = name; profile.colour = colour; profile.car = car;
      if (net.connected) sendProfile();
    },
    getProfile: function () { return { name: profile.name, colour: profile.colour, car: profile.car }; },

    /* ---------- the room (protocol 2) ---------- */

    /** Host, lobby: the room's settings. partial = any of {track: id, year: 2010..2100, mode: 'free' | 'gp',
     *  q: 1..20, r: 1..99, wear: 1..5 (whole after Math.round)}, cleaned as the server cleans them: a field that is
     *  not valid is left out (never clamped). -> true when sent (the answer is the next 'room'); false when we may not
     *  or nothing valid is left. A changed track, year or mode clears the guests' ready flags (room.rr + 1). The
     *  server takes at most 10 a second. */
    setRoom: function (p) {
      if (!net.connected || !net.isHost || !net.room || net.room.st !== 'lobby' || !p || typeof p !== 'object') return false;
      var m = { t: 'set' }, any = false, v;
      if (p.track !== undefined && (v = cleanTrackId(p.track)) !== null) { m.track = v; any = true; }
      if (p.year !== undefined && (v = cleanYear(p.year)) !== null) { m.year = v; any = true; }
      if (p.mode === 'free' || p.mode === 'gp') { m.mode = p.mode; any = true; }
      if ((v = wholeIn(p.q, 1, Q_MAX)) !== null) { m.q = v; any = true; }
      if ((v = wholeIn(p.r, 1, R_MAX)) !== null) { m.r = v; any = true; }
      if ((v = wholeIn(p.wear, 1, WEAR_MAX)) !== null) { m.wear = v; any = true; }
      return any ? send(m) : false;
    },

    /** Guest, lobby: ready (true) or not (false). -> true when sent (room.ready answers). */
    setReady: function (on) {
      if (!net.connected || net.isHost || !net.room || net.room.st !== 'lobby' || typeof on !== 'boolean') return false;
      return send({ t: 'ready', on: on });
    },

    /** Host, lobby, room.set.track set: everybody loads it. opts = {len: the track length in m (200..100000;
     *  round(trackData.lengthKm * 1000)), force: true = start with guests who are not ready}. -> true when sent; a
     *  refusal comes back as 'nostart'. */
    startRoom: function (opts) {
      if (!net.connected || !net.isHost || !net.room || net.room.st !== 'lobby' || !net.room.set.track) return false;
      var len = cleanLen(opts && opts.len);
      if (len === null) return false;
      var m = { t: 'start', len: len };
      if (opts.force === true) m.force = true;
      return send(m);
    },

    /** Host, loading, our own track built (loadedRs === room.rs): end the barrier now (不等了，開始). */
    goNow: function () {
      if (!net.connected || !net.isHost || !net.room || net.room.st !== 'loading' || net.loadedRs !== net.room.rs) return false;
      return send({ t: 'go' });
    },

    /** Host, loading or session: everybody back to the lobby (回到大廳). */
    backToLobby: function () {
      if (!net.connected || !net.isHost || !net.room || (net.room.st !== 'loading' && net.room.st !== 'session')) return false;
      return send({ t: 'back' });
    },

    /** Our track of load cycle rs is built (ok true; opts.len: its length in m) or cannot be (ok false; opts.why:
     *  'no-track' | 'error'). Loading / session, rs === room.rs, once per rs. ok sets loadedRs: our car states may go
     *  out once the room's session of that cycle is on. -> true when sent. */
    sendLoaded: function (rs, ok, opts) {
      var r = net.room;
      if (!net.connected || !r || (r.st !== 'loading' && r.st !== 'session') || rs !== r.rs || reportedRs === rs) return false;
      var m = { t: 'loaded', rs: rs, ok: ok === true };
      var why = cleanWhy(opts && opts.why), len = cleanLen(opts && opts.len);
      if (why) m.why = why;
      if (len !== null) m.len = len;
      if (!send(m)) return false;
      reportedRs = rs;
      if (m.ok) net.loadedRs = rs;
      return true;
    },

    /** Host, lobby: the room's season (2010..2100) = setRoom({year: y}). The answer is the 'year' event (net.year). */
    setYear: function (y) { return net.setRoom({ year: y }); },

    /** Host, lobby: the room's track = setRoom({track: id}). It is loaded by everybody only at startRoom(). */
    selectTrack: function (trackId) { return net.setRoom({ track: trackId }); },

    /** Call every frame with car.state; sends at most 20 times a second. Nothing goes out unless the room's session
     *  of the cycle we loaded is on (room.st 'session', loadedRs === room.rs). */
    sendState: function (s, force) {
      if (!onTrack() || !s) return;
      var now = nowMs();
      if (!force && now - lastSendT < SEND_MS) return;
      if (!isNum(s.x) || !isNum(s.z) || !isNum(s.heading)) return;
      lastSendT = now;
      lastState = [s.x, isNum(s.y) ? s.y : 0, s.z, s.heading, isNum(s.pitch) ? s.pitch : 0,
        isNum(s.roll) ? s.roll : 0, isNum(s.speed) ? s.speed : 0, isNum(s.steer) ? s.steer : 0];
      var msg = { t: 's', k: curRs(), c: Math.round(now), s: lastState };
      if (progress !== null) msg.g = Math.round(progress * 10000) / 10000;
      send(msg);
    },

    /** Race progress (laps completed + fraction of the lap) to send along with the state; null = none. */
    setProgress: function (v) { progress = isNum(v) ? v : null; },

    /** Host only, lobby only: the room's computer drivers. list = [{name, car, colour, skill}] (one entry per
     *  bot, in a fixed order: entry i is always bot i; name <= 16 characters, car a CarSpec id, colour '#rrggbb',
     *  skill 0..1 — anything missing or not valid gets the server's default: 'AI n', no car, a palette colour, the
     *  level's skill), or a number n (n bots with the defaults). skill = the room's level 'rookie' | 'amateur' |
     *  'pro' | 'legend' | 'mixed' (shown to everybody; anything else keeps the room's). The server gives at most
     *  16 - humans; bots 0..n-1 that exist keep their ids and slots. -> true when the request was sent; the answer is
     *  the roster ('players', 'bots' events; net.bots). n is also the room's wish (room.set.bots, skill:
     *  room.set.skill). A human joining a full room in the lobby / free practice takes the seat of the newest bot.
     *  When we leave the room our bots go (out of a running session: DNF in the race; the others race on). */
    setBots: function (list, skill) {
      if (!net.connected || !net.isHost || !net.room || net.room.st !== 'lobby') return false;
      var n;
      if (isNum(list)) { n = list; list = []; }
      else if (Array.isArray(list)) n = list.length;
      else return false;
      if (!(n >= 0)) return false;
      n = Math.min(Math.floor(n), BOTS_MAX);
      var out = [];
      for (var i = 0; i < n && i < list.length; i++) {
        var e = list[i], o = {};
        if (e && typeof e === 'object') {
          var nm = cleanName(e.name, ''), car = cleanCarId(e.car), col = cleanColour(e.colour, ''), sk = cleanSkill(e.skill);
          if (nm) o.name = nm;
          if (car) o.car = car;
          if (col) o.colour = col;
          if (sk !== null) o.skill = sk;
        }
        out.push(o);
      }
      var m = { t: 'bots', n: n, list: out }, level = cleanLevel(skill);
      if (level) m.skill = level;
      // one frame (16 long names in 4-byte characters would not fit): colours go first (the car's livery is known
      // from its id), then the names are shortened
      if (utf8Bytes(JSON.stringify(m)) > MSG_MAX) out.forEach(function (o) { delete o.colour; });
      if (utf8Bytes(JSON.stringify(m)) > MSG_MAX) out.forEach(function (o) { if (o.name) o.name = Array.from(o.name).slice(0, 6).join(''); });
      return send(m);
    },

    /** Host: our bots' car states. list = [{id, state, g?}] with state = car.state of each of OUR bots (ids from
     *  net.bots; anything else is left out) and g = its race progress (optional; else the one setBotProgress gave).
     *  Call it every frame like sendState: it sends at most ~20 times a second (force = now) in one 'bs' message
     *  (or a few when it would not fit in 2 KB). Nothing goes out unless the room's session of the cycle we loaded
     *  is on (as sendState). -> true when something was sent. */
    sendBotStates: function (list, force) {
      if (!onTrack() || !Array.isArray(list) || !list.length || botSig === '') return false;
      var now = nowMs();
      if (!force && now - lastBotSendT < SEND_MS) return false;
      var rows = [], seen = {};
      for (var i = 0; i < list.length && rows.length < BOTS_MAX; i++) {
        var e = list[i], s = e && e.state;
        if (!e || !isMine(e.id) || seen[e.id] || !s || !isNum(s.x) || !isNum(s.z) || !isNum(s.heading)) continue;
        seen[e.id] = true;
        var row = [e.id, r2(s.x), r2(isNum(s.y) ? s.y : 0), r2(s.z), r4(s.heading % (Math.PI * 2)), r3(isNum(s.pitch) ? s.pitch : 0),
          r3(isNum(s.roll) ? s.roll : 0), r2(isNum(s.speed) ? s.speed : 0), r2(isNum(s.steer) ? s.steer : 0)];
        var g = isNum(e.g) ? e.g : botProg[e.id];
        if (isNum(g)) row.push(r4(g));
        rows.push(row);
      }
      if (!rows.length) return false;
      lastBotSendT = now;
      lastBotRows = rows;
      sendRows(rows, now);
      return true;
    },

    /** Host: race progress of one of our bots (laps + fraction, lapCounter.progress(idx)); null = none. It rides
     *  along with its next state (sendBotStates). */
    setBotProgress: function (id, v) {
      if (!isMine(id)) return false;
      if (isNum(v)) botProg[id] = v; else delete botProg[id];
      return true;
    },

    /** Grand Prix, host only, the room's session: action = 'skip' | 'end' | 'again'. 'end': during the race -> the
     *  results; otherwise the room goes back to the lobby (as backToLobby). 'start' -> false: a room starts with
     *  setRoom({mode: 'gp', q, r, wear}) + startRoom(). -> true when the request was sent (the answer is the next 'gp'
     *  / 'room'; a refused one has no answer). */
    gp: function (action) {
      if (!net.connected || !net.isHost || GP_ACTIONS[action] !== 1 || !net.room || net.room.st !== 'session') return false;
      return send({ t: 'gp', a: action });
    },

    /** Report a completed lap of Grand Prix session sid (qualifying or race). -> true when it was sent.
     *  at (optional): serverNow() when the car crossed the line: the race time is taken from it, not from when
     *  the report arrives (a report held up on the network costs nothing). The server counts a lap only when
     *  the car states it got from us cover it (sendState during the lap).
     *  A lap the server does not accept comes back as the 'lapRejected' event.
     *  botId (optional): the lap is one of OUR bots' (its states went out with sendBotStates); a rejection comes back
     *  as 'botLapRejected' (botId, why). Any other id -> false, nothing sent. As sendState: only in the room's
     *  session of the cycle we loaded. */
    sendGpLap: function (sid, time, at, botId) {
      if (!onTrack() || !isNum(sid) || !isNum(time) || !(time > 0)) return false;
      if (botId !== undefined && botId !== null && !isMine(botId)) return false;
      var m = { t: 'gl', k: curRs(), sid: sid, time: Math.round(time * 1000) / 1000 };
      if (isNum(at) && at > 0 && at < CLOCK_MAX) m.at = Math.round(at);
      if (isMine(botId)) m.id = botId;
      return send(m);
    },

    /** The server's clock in ms (for the start lights: session.lightsAt / goAt are server times).
     *  Not in a room: our own clock. */
    serverNow: function () { return localNow() + clockOff; },

    /** The game loop stopped (menu): tell the others right away that the car stands still. */
    park: function () { lastSendT = 0; keepalive(); },

    /** Our car hit car id (a player or somebody else's bot): (ix, iz) is the velocity change (m/s) their car is owed.
     *  fromBotId (optional): it was one of OUR bots that hit them (at most one report per bot per 40 ms goes out, as
     *  the server takes no more). Contacts among our own cars (our car, our bots) are settled locally: never sent.
     *  As sendState: only in the room's session of the cycle we loaded. -> true when it was sent. */
    sendHit: function (id, ix, iz, fromBotId) {
      if (!onTrack() || !isNum(id) || !isNum(ix) || !isNum(iz) || isMine(id) || id === net.id) return false;
      var m = { t: 'hit', k: curRs(), to: id, i: [Math.round(ix * 100) / 100, Math.round(iz * 100) / 100] };
      if (fromBotId !== undefined && fromBotId !== null) {
        if (!isMine(fromBotId)) return false;
        var now = nowMs();
        if (now - (botHitT[fromBotId] || -1e9) < HIT_MIN_MS) return false;
        botHitT[fromBotId] = now;
        m.from = fromBotId;
      }
      return send(m);
    },

    /** Share lap times (seconds or null) with the room. botId (optional): one of OUR bots' times. As sendState: only
     *  in the room's session of the cycle we loaded (the server clears every lap time at a start and in the lobby). */
    sendLap: function (last, best, botId) {
      if (!onTrack()) return false;
      var m = { t: 'lap', k: curRs(), last: isNum(last) ? last : null, best: isNum(best) ? best : null };
      if (botId !== undefined && botId !== null) {
        if (!isMine(botId)) return false;
        m.id = botId;
      }
      return send(m);
    },

    /** Call once per frame before reading players[i].state / .active. */
    update: function (now) {
      if (!net.connected) return;
      if (!isNum(now)) now = nowMs();
      for (var i = 0; i < net.players.length; i++) sample(net.players[i], now);
    },

    parseAddress: parseAddress
  };

  if (typeof root.setInterval === 'function') keepTimer = root.setInterval(keepalive, KEEPALIVE_MS / 2);
  if (keepTimer && keepTimer.unref) keepTimer.unref();
  if (typeof root.addEventListener === 'function') {
    // closing / reloading the page: leave cleanly so the room (if we host it) stops at once
    root.addEventListener('pagehide', function () { if (ws || hosting) teardown('已離開房間'); });
  }

  F1.net = net;
  if (typeof module !== 'undefined' && module.exports) module.exports = net;
})(typeof window !== 'undefined' ? window : globalThis);
