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

  var ws = null;
  var handlers = {};
  var pending = null;           // { resolve } of the join in progress
  var connectTimer = 0, keepTimer = 0;
  var hosting = false;          // we started the server through the preload API
  var profile = { name: 'Player', colour: '#ff7a14' };
  var trackSeq = 0;
  var lastSendT = 0, lastState = null;
  var remotes = {};             // id -> remote record
  var lastError = '';
  var clockOff = 0, clockRtt = Infinity, pingTimer = 0, pingCount = 0;   // server clock = Date.now() + clockOff
  var progress = null;          // race progress sent along with the car state

  function sendPing() {
    if (!net.connected) return;
    pingCount++;
    send({ t: 'ping', c: Date.now() });
    clearTimeout(pingTimer);
    pingTimer = setTimeout(sendPing, pingCount < 6 ? 300 : 10000);
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
      id: id, name: 'Player ' + id, colour: '#ff7a14', slot: 0, last: null, best: null,
      active: false,                // has a recent pose (draw it / collide with it)
      state: { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, steer: 0 },
      _buf: [], _off: null, _offS: null, _recv: 0, _ct: -Infinity
    };
  }

  function pushSnap(r, e, now) {
    // e = [id, ct, x, y, z, heading, pitch, roll, speed, steer]
    for (var i = 1; i < 10; i++) if (!isNum(e[i])) return;
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
      r.name = e.name; r.colour = e.colour; r.slot = e.slot; r.last = e.last; r.best = e.best;
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
        if (!isNum(m.c) || !isNum(m.s)) return;
        var tn = Date.now(), rtt = tn - m.c;
        if (rtt < 0 || rtt > 5000) return;
        clockRtt += 2;                            // old estimates age, so a changed route is picked up
        if (rtt <= clockRtt) { clockRtt = rtt; clockOff = m.s + rtt / 2 - tn; }
        break;
      }
      case 'gp': {                                // Grand Prix session state (server authoritative)
        if (!net.connected || !m.s || typeof m.s !== 'object' || !Array.isArray(m.s.players)) return;
        net.session = m.s;
        emit('gp', m.s);
        break;
      }
      case 'glno': emit('lapRejected', typeof m.why === 'string' ? m.why : ''); break;
      case 'welcome': {
        if (net.connected || !isNum(m.id)) return;
        clearTimeout(connectTimer);
        clockRtt = Infinity; pingCount = 0;
        clockOff = isNum(m.now) ? m.now - Date.now() : 0;   // rough until the first pong
        net.id = m.id;
        net.connected = true; net.connecting = false;
        trackSeq = isNum(m.seq) ? m.seq : 0;
        net.trackId = typeof m.track === 'string' ? m.track : null;
        lastState = null;
        applyRoster(m);
        if (pending) { var p = pending; pending = null; p.resolve({ ok: true }); }
        sendPing();
        emit('connected', { id: net.id, isHost: net.isHost });
        if (net.trackId) emit('track', net.trackId);
        break;
      }
      case 'players': if (net.connected) applyRoster(m); break;
      case 'gone': break;                         // the roster that follows removes the player
      case 'track': {
        if (!net.connected || typeof m.id !== 'string' || !isNum(m.seq)) return;
        trackSeq = m.seq; net.trackId = m.id;
        lastState = null;                         // our old pose belongs to the old track
        clearPoses();
        emit('track', m.id);
        break;
      }
      case 'hit': {                               // another player's car hit ours
        if (!net.connected || !Array.isArray(m.i) || !isNum(m.from) || !isNum(m.i[0]) || !isNum(m.i[1])) return;
        if (remotes[m.from]) emit('hit', m.from, [m.i[0], m.i[1]]);
        break;
      }
      case 'error': {
        lastError = m.code === 'full' ? '房間已滿（最多 16 人）'
          : m.code === 'version' ? '遊戲版本與房主不同，無法加入'
          : m.code === 'busy' ? '伺服器忙碌中，請稍後再試' : '伺服器拒絕連線';
        break;
      }
      default: break;
    }
  }

  function teardown(reason) {
    var was = net.connected, s = ws, wasHosting = hosting;
    ws = null; hosting = false;
    clearTimeout(connectTimer); clearTimeout(pingTimer);
    net.session = null; progress = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = s.onclose = null;
      try { s.close(); } catch (err) {}
    }
    net.connected = false; net.connecting = false; net.isHost = false;
    net.id = 0; net.hostId = 0; net.slot = 0; net.trackId = null; net.hostInfo = null;
    net.roster = []; net.players = [];
    remotes = {}; lastState = null; trackSeq = 0;
    if (wasHosting && root.f1host) { try { root.f1host.stopServer(); } catch (err) {} }
    if (pending) { var p = pending; pending = null; p.resolve({ ok: false, error: reason }); }
    if (was) emit('disconnected', reason);
  }

  function connect(addr, token) {
    return new Promise(function (resolve) {
      var s;
      lastError = '';
      try { s = new root.WebSocket(addr.url); } catch (err) {
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
        var hello = { t: 'hello', v: PROTOCOL, name: profile.name, colour: profile.colour };
        if (token) hello.token = token;
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
    session: null,              // Grand Prix state from the server (net/session.js snapshot), null when offline
    hostInfo: null,             // { port, addresses: [LAN IPv4] } while we host
    roster: [],                 // everyone incl. us: [{id, name, colour, slot, last, best, isHost, isSelf}]
    players: [],                // the OTHER players: [{id, name, colour, slot, active, state:{x,y,z,heading,pitch,roll,speed,steer}}]

    /** on('connected' | 'disconnected' | 'players' | 'track' | 'hit' | 'gp' | 'lapRejected', fn)
     *  hit: fn(fromId, [ix, iz]);  gp: fn(sessionSnapshot) */
    on: function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); },

    /** Host a room: starts the server in the Electron main process, then joins it. -> Promise<{ok, error}> */
    create: function (port) {
      if (!net.canCreate) return Promise.resolve({ ok: false, error: '只有桌面版（F1Drive.exe）可以建立房間' });
      if (net.connected || net.connecting) return Promise.resolve({ ok: false, error: '已經在房間中' });
      port = Number(port == null || port === '' ? DEFAULT_PORT : port);
      if (!(port >= 1024 && port <= 65535) || Math.floor(port) !== port) {
        return Promise.resolve({ ok: false, error: '連接埠必須是 1024–65535 的整數' });
      }
      net.connecting = true;
      return root.f1host.startServer(port).then(function (res) {
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
        var info = { port: res.port, addresses: Array.isArray(res.addresses) ? res.addresses.slice(0, 8) : [] };
        var p = connect({ host: '127.0.0.1', port: res.port, url: 'ws://127.0.0.1:' + res.port }, res.token);
        net.hostInfo = info;                      // cleared again by teardown() if the join fails
        return p;
      }, function (err) {
        net.connecting = false;
        return { ok: false, error: '無法建立房間：' + (err && err.message ? err.message : err) };
      });
    },

    /** Join a room. -> Promise<{ok, error}> */
    join: function (address) {
      if (net.connected || net.connecting) return Promise.resolve({ ok: false, error: '已經在房間中' });
      var addr = parseAddress(address, DEFAULT_PORT);
      if (!addr) return Promise.resolve({ ok: false, error: '位址格式不正確（例：203.0.113.5 或 203.0.113.5:24500）' });
      if (!root.WebSocket) return Promise.resolve({ ok: false, error: '此環境不支援 WebSocket' });
      return connect(addr, null);
    },

    /** Leave the room (the host leaving closes the room for everyone). */
    leave: function () {
      if (!ws && !hosting) return;
      teardown('已離開房間');
    },

    setProfile: function (p) {
      p = p || {};
      var name = cleanName(p.name, profile.name), colour = cleanColour(p.colour, profile.colour);
      if (name === profile.name && colour === profile.colour) return;
      profile.name = name; profile.colour = colour;
      if (net.connected) send({ t: 'profile', name: name, colour: colour });
    },
    getProfile: function () { return { name: profile.name, colour: profile.colour }; },

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

    /** Grand Prix, host only: action = 'start' (cfg {q, r, len}) | 'skip' | 'end' | 'again'. */
    gp: function (action, cfg) {
      if (!net.connected || !net.isHost) return false;
      var m = { t: 'gp', a: action };
      if (cfg) { m.q = cfg.q; m.r = cfg.r; m.len = cfg.len; }
      return send(m);
    },

    /** Report a completed lap of Grand Prix session sid (qualifying or race). */
    sendGpLap: function (sid, time) {
      if (net.connected && isNum(time)) send({ t: 'gl', k: trackSeq, sid: sid, time: Math.round(time * 1000) / 1000 });
    },

    /** The server's clock in ms (for the start lights: session.lightsAt / goAt are server times). */
    serverNow: function () { return Date.now() + clockOff; },

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
