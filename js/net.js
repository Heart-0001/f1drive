// F1Drive - multiplayer client (F1.net). Talks to net/server.js over a WebSocket. See js/README-interfaces.md.
// No DOM besides WebSocket / timers; no THREE.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var PROTOCOL = 1;
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
  var HIT_MAX = 80;             // m/s, the largest velocity change the server relays in one impact report
  var CLOCK_MAX = 1e14;         // ms: no server clock is beyond this (keeps a hostile value out of the arithmetic)
  var PING_KEEP = 8;            // pings that may be waiting for their pong
  var GP_PHASES = { free: 1, quali: 1, grid: 1, race: 1, results: 1 };
  var GP_ACTIONS = { start: 1, skip: 1, end: 1, again: 1 };
  var GP_MAX_PLAYERS = 64;      // rows of a session snapshot we keep (the server has at most 32)
  var YEAR_MIN = 2010, YEAR_MAX = 2100;   // a room / session year; anything else is "no year" (null)
  var WEAR_MAX = 5;             // tyre wear multiplier of a Grand Prix, 1..5
  var PW_MAX = 64;              // characters of a room password

  var ws = null;
  var handlers = {};
  var pending = null;           // { resolve } of the join in progress
  var connectTimer = 0, keepTimer = 0;
  var hosting = false;          // we started the server through the preload API
  var profile = { name: 'Player', colour: '#ff7a14', car: '' };   // car: a CarSpec id, '' = not chosen
  var trackSeq = 0;
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
    }
    return {
      sid: s.sid, phase: s.phase,
      q: count(s.q, 20) || 3, r: count(s.r, 99) || 5, len: isNum(s.len) && s.len > 0 ? s.len : 0,
      year: cleanYear(s.year), wear: count(s.wear, WEAR_MAX) || 1,
      lightsAt: lightsAt, goAt: goAt, winnerAt: clockMs(s.winnerAt), endsAt: clockMs(s.endsAt),
      grid: cleanIds(s.grid), order: cleanIds(s.order), players: players
    };
  }

  function emit(name, a, b) {
    var list = handlers[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](a, b); } catch (err) { if (root.console) console.error(err); }
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

  // Parc fermé: the server keeps our car while a session is on. A car chosen meanwhile (or one that crossed a
  // session start on the way) is sent again once the room is back in free practice.
  function resyncCar() {
    if (!profile.car) return;
    for (var i = 0; i < net.roster.length; i++) {
      if (net.roster[i].isSelf) { if (net.roster[i].car !== profile.car) sendProfile(); return; }
    }
  }

  function applyRoster(m) {
    if (!Array.isArray(m.players)) return;
    var seen = {}, roster = [], n = Math.min(m.players.length, 32);
    var hostId = isNum(m.host) ? m.host : 0;
    for (var i = 0; i < n; i++) {
      var p = m.players[i];
      if (!p || !isNum(p.id)) continue;
      var e = {
        id: p.id,
        name: cleanName(p.name, 'Player ' + p.id),
        colour: cleanColour(p.colour, '#ff7a14'),
        car: cleanCarId(p.car) || '',
        slot: isNum(p.slot) && p.slot >= 0 ? Math.floor(p.slot) : i,
        last: isNum(p.last) ? p.last : null,
        best: isNum(p.best) ? p.best : null,
        isHost: p.id === hostId,
        isSelf: p.id === net.id
      };
      roster.push(e);
      if (e.isSelf) { net.slot = e.slot; continue; }
      seen[e.id] = true;
      var r = remotes[e.id] || (remotes[e.id] = makeRemote(e.id));
      r.name = e.name; r.colour = e.colour; r.car = e.car; r.slot = e.slot; r.last = e.last; r.best = e.best;
    }
    for (var id in remotes) if (!seen[id]) delete remotes[id];
    net.roster = roster;
    net.hostId = hostId;
    net.isHost = !!net.id && hostId === net.id;
    rebuildPlayers();
    emit('players', roster);
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
          if (!Array.isArray(e) || e.length < 10 || e[0] === net.id) continue;
          var r = remotes[e[0]];
          if (r) pushSnap(r, e, now);
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
        var was = net.session ? net.session.phase : 'free';
        net.session = snap;
        emit('gp', snap);
        if (snap.phase === 'free' && was !== 'free') resyncCar();
        break;
      }
      case 'glno': {                              // our lap was not accepted: a short reason code
        if (!net.connected) return;
        emit('lapRejected', typeof m.why === 'string' && /^[a-z\-]{1,24}$/.test(m.why) ? m.why : '');
        break;
      }
      case 'welcome': {
        if (net.connected || !isNum(m.id)) return;
        clearTimeout(connectTimer);
        resetClock();
        if (isNum(m.now) && m.now > 0 && m.now < CLOCK_MAX) clockOff = m.now - localNow();   // rough until the first pong
        net.id = m.id;
        net.connected = true; net.connecting = false;
        trackSeq = isNum(m.seq) ? m.seq : 0;
        net.trackId = cleanTrackId(m.track);
        net.year = cleanYear(m.year);
        lastState = null;
        applyRoster(m);
        if (pending) { var p = pending; pending = null; p.resolve({ ok: true }); }
        sendPing();
        emit('connected', { id: net.id, isHost: net.isHost });
        // the year before the track: the car (and so the racing line) is known before the track is built
        if (net.year !== null) emit('year', net.year);
        if (net.trackId) emit('track', net.trackId);
        break;
      }
      case 'players': {                           // the roster, and the room year that rides along
        if (!net.connected || !Array.isArray(m.players)) return;
        var y = cleanYear(m.year), yearChanged = y !== net.year;
        net.year = y;
        applyRoster(m);
        if (yearChanged) emit('year', y);
        break;
      }
      case 'gone': break;                         // the roster that follows removes the player
      case 'track': {
        if (!net.connected || !cleanTrackId(m.id) || !isNum(m.seq)) return;
        trackSeq = m.seq; net.trackId = m.id;
        lastState = null;                         // our old pose belongs to the old track
        progress = null;                          //   and so does our race distance (a new track ends a Grand Prix)
        clearPoses();
        emit('track', m.id);
        break;
      }
      case 'hit': {                               // another player's car hit ours
        if (!net.connected || !Array.isArray(m.i) || !isNum(m.from) || !isNum(m.i[0]) || !isNum(m.i[1])) return;
        if (!remotes[m.from]) return;
        var hx = m.i[0], hz = m.i[1], hm = Math.sqrt(hx * hx + hz * hz);
        if (!isNum(hm)) return;
        if (hm > HIT_MAX) {                       // the server clamps; do not count on it
          hx = Math.round(hx / hm * HIT_MAX * 100) / 100; hz = Math.round(hz / hm * HIT_MAX * 100) / 100;
        }
        emit('hit', m.from, [hx, hz]);
        break;
      }
      case 'error': {
        lastError = m.code === 'full' ? '房間已滿（最多 16 人）'
          : m.code === 'version' ? '遊戲版本與房主不同，無法加入'
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
    net.roster = []; net.players = [];
    remotes = {}; lastState = null; trackSeq = 0;
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
    if (!net.connected || !lastState) return;
    var now = nowMs();
    if (now - lastSendT < KEEPALIVE_MS) return;
    lastState[6] = 0; lastState[7] = 0;           // the loop is not running: the car is standing still
    lastSendT = now;
    send({ t: 's', k: trackSeq, c: Math.round(now), s: lastState });
  }

  var net = {
    DEFAULT_PORT: DEFAULT_PORT,
    MAX_PLAYERS: 16,
    /** true when the page runs inside the Electron app (it can host a room) */
    canCreate: !!(root.f1host && typeof root.f1host.startServer === 'function'),
    connected: false, connecting: false, isHost: false,
    id: 0, hostId: 0,
    slot: 0,                    // our grid slot (0 = pole), assigned by the server in join order
    trackId: null,              // the room's current track id
    year: null,                 // the room's season year (2010..2100) or null (none picked / not in a room)
    session: null,              // Grand Prix state from the server: a sanitised net/session.js snapshot (every
                                //   documented field present and of its type), null when not in a room
    hostInfo: null,             // { port, addresses: [LAN IPv4], hasPassword } while we host
    roster: [],                 // everyone incl. us: [{id, name, colour, car, slot, last, best, isHost, isSelf}]
    players: [],                // the OTHER players: [{id, name, colour, car, slot, active, state:{x,y,z,heading,pitch,roll,speed,steer}}]
                                //   car: a CarSpec id or '' (not chosen / unknown)

    /** on('connected' | 'disconnected' | 'players' | 'track' | 'year' | 'hit' | 'gp' | 'lapRejected', fn)
     *  year: fn(year | null), the room year changed (also once right after 'connected', before 'track', when the
     *  room has one; not on disconnect);  hit: fn(fromId, [ix, iz]);  gp: fn(sessionSnapshot), the object net.session now is;
     *  lapRejected: fn(why): 'too-fast' | 'too-soon' | 'inconsistent' | 'not-driven' (the server did not see the car
     *  cover the lap) | 'no-data' (too few car states reached it during the lap) | 'bad' | 'done' | 'not-racing' |
     *  'no-session' | '' */
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
      return connect(addr, null, cleanPassword(opts && opts.password));
    },

    /** Leave the room (the host leaving closes the room for everyone). */
    leave: function () {
      if (!ws && !hosting) return;
      teardown('已離開房間');
    },

    /** setProfile({name, colour, car}): what the room sees of us. A field that is missing or not valid keeps its
     *  previous value (car: a CarSpec id, /^[a-z0-9-]{1,40}$/). While a session is on the server keeps our car
     *  (parc fermé); a car chosen meanwhile is sent again when the room is back in free practice. */
    setProfile: function (p) {
      p = p || {};
      var name = cleanName(p.name, profile.name), colour = cleanColour(p.colour, profile.colour);
      var car = cleanCarId(p.car) || profile.car;
      if (name === profile.name && colour === profile.colour && car === profile.car) return;
      profile.name = name; profile.colour = colour; profile.car = car;
      if (net.connected) sendProfile();
    },
    getProfile: function () { return { name: profile.name, colour: profile.colour, car: profile.car }; },

    /** Host only, free practice only: the season year for the room (2010..2100). -> true when the request was
     *  sent. The server applies one pick right away, then the latest one a second later at most; the answer is
     *  the 'year' event (net.year). A pick equal to net.year cancels one that is still waiting. */
    setYear: function (y) {
      if (!net.connected || !net.isHost || cleanYear(y) === null) return false;
      if (net.session && net.session.phase !== 'free') return false;
      return send({ t: 'year', y: y });
    },

    /** Call every frame with car.state; sends at most 20 times a second. */
    sendState: function (s, force) {
      if (!net.connected || !s) return;
      var now = nowMs();
      if (!force && now - lastSendT < SEND_MS) return;
      if (!isNum(s.x) || !isNum(s.z) || !isNum(s.heading)) return;
      lastSendT = now;
      lastState = [s.x, isNum(s.y) ? s.y : 0, s.z, s.heading, isNum(s.pitch) ? s.pitch : 0,
        isNum(s.roll) ? s.roll : 0, isNum(s.speed) ? s.speed : 0, isNum(s.steer) ? s.steer : 0];
      var msg = { t: 's', k: trackSeq, c: Math.round(now), s: lastState };
      if (progress !== null) msg.g = Math.round(progress * 10000) / 10000;
      send(msg);
    },

    /** Race progress (laps completed + fraction of the lap) to send along with the state; null = none. */
    setProgress: function (v) { progress = isNum(v) ? v : null; },

    /** Grand Prix, host only: action = 'start' (cfg {q, r, len: track length in m, wear: tyre wear 1..5}) |
     *  'skip' | 'end' | 'again'. The session's year is the room's (net.year), set by the server.
     *  -> true when the request was sent (the answer is the next 'gp' event; a refused one has no answer). */
    gp: function (action, cfg) {
      if (!net.connected || !net.isHost || GP_ACTIONS[action] !== 1) return false;
      var m = { t: 'gp', a: action };
      if (action === 'start') {
        if (!cfg || !isNum(cfg.len)) return false;
        if (isNum(cfg.q)) m.q = cfg.q;            // left out -> the server's default (3 / 5 / 1)
        if (isNum(cfg.r)) m.r = cfg.r;
        if (isNum(cfg.wear)) m.wear = cfg.wear;
        m.len = cfg.len;
      }
      return send(m);
    },

    /** Report a completed lap of Grand Prix session sid (qualifying or race). -> true when it was sent.
     *  at (optional): serverNow() when the car crossed the line: the race time is taken from it, not from when
     *  the report arrives (a report held up on the network costs nothing). The server counts a lap only when
     *  the car states it got from us cover it (sendState during the lap).
     *  A lap the server does not accept comes back as the 'lapRejected' event. */
    sendGpLap: function (sid, time, at) {
      if (!net.connected || !isNum(sid) || !isNum(time) || !(time > 0)) return false;
      var m = { t: 'gl', k: trackSeq, sid: sid, time: Math.round(time * 1000) / 1000 };
      if (isNum(at) && at > 0 && at < CLOCK_MAX) m.at = Math.round(at);
      return send(m);
    },

    /** The server's clock in ms (for the start lights: session.lightsAt / goAt are server times).
     *  Not in a room: our own clock. */
    serverNow: function () { return localNow() + clockOff; },

    /** The game loop stopped (menu): tell the others right away that the car stands still. */
    park: function () { lastSendT = 0; keepalive(); },

    /** Our car hit player id: (ix, iz) is the velocity change (m/s) their car is owed. */
    sendHit: function (id, ix, iz) {
      if (!net.connected || !isNum(id) || !isNum(ix) || !isNum(iz)) return;
      send({ t: 'hit', k: trackSeq, to: id, i: [Math.round(ix * 100) / 100, Math.round(iz * 100) / 100] });
    },

    /** Share lap times (seconds or null) with the room. */
    sendLap: function (last, best) {
      if (net.connected) send({ t: 'lap', last: isNum(last) ? last : null, best: isNum(best) ? best : null });
    },

    /** Host only: load this track for everyone (also restarts the session on the same track). */
    selectTrack: function (trackId) {
      if (!net.connected || !net.isHost || typeof trackId !== 'string') return false;
      return send({ t: 'track', id: trackId });
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
