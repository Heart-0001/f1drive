const fs = require('fs');
const ROOT = 'C:/Users/user/Desktop/f1drive/';
function patch(file, pairs) {
  let s = fs.readFileSync(ROOT + file, 'utf8');
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  s = s.replace(/\r\n/g, '\n');
  for (const [a, b] of pairs) {
    const c = s.split(a).length - 1;
    if (c !== 1) throw new Error(file + ': expected 1 match, got ' + c + ' for: ' + a.slice(0, 70));
    s = s.replace(a, () => b);
  }
  fs.writeFileSync(ROOT + file, s.replace(/\n/g, nl));
  console.log('patched', file);
}

patch('js/net.js', [
[`  var lastError = '';`, `  var lastError = '';
  var clockOff = 0, clockRtt = Infinity, pingTimer = 0, pingCount = 0;   // server clock = Date.now() + clockOff
  var progress = null;          // race progress sent along with the car state

  function sendPing() {
    if (!net.connected) return;
    pingCount++;
    send({ t: 'ping', c: Date.now() });
    clearTimeout(pingTimer);
    pingTimer = setTimeout(sendPing, pingCount < 6 ? 300 : 10000);
  }`],
[`      case 'welcome': {
        if (net.connected || !isNum(m.id)) return;
        clearTimeout(connectTimer);`, `      case 'pong': {
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
        clockOff = isNum(m.now) ? m.now - Date.now() : 0;   // rough until the first pong`],
[`        if (pending) { var p = pending; pending = null; p.resolve({ ok: true }); }
        emit('connected', { id: net.id, isHost: net.isHost });`, `        if (pending) { var p = pending; pending = null; p.resolve({ ok: true }); }
        sendPing();
        emit('connected', { id: net.id, isHost: net.isHost });`],
[`    ws = null; hosting = false;
    clearTimeout(connectTimer);`, `    ws = null; hosting = false;
    clearTimeout(connectTimer); clearTimeout(pingTimer);
    net.session = null; progress = null;`],
[`      send({ t: 's', k: trackSeq, c: Math.round(now), s: lastState });
    },

    /** The game loop stopped`, `      var msg = { t: 's', k: trackSeq, c: Math.round(now), s: lastState };
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

    /** The game loop stopped`],
[`    trackId: null,              // the room's current track id`, `    trackId: null,              // the room's current track id
    session: null,              // Grand Prix state from the server (net/session.js snapshot), null when offline`],
[`    /** on('connected' | 'disconnected' | 'players' | 'track' | 'hit', fn);  hit: fn(fromId, [ix, iz]) */`,
 `    /** on('connected' | 'disconnected' | 'players' | 'track' | 'hit' | 'gp' | 'lapRejected', fn)
     *  hit: fn(fromId, [ix, iz]);  gp: fn(sessionSnapshot) */`]
]);

patch('js/carmodel.js', [
[`    return {
      wheelGeo: m.build(),
      mat: new THREE.MeshLambertMaterial({ vertexColors: true })
    };`, `    return {
      wheelGeo: m.build(),
      mat: new THREE.MeshLambertMaterial({ vertexColors: true }),
      // "ghost" cars (qualifying, spectators): see-through and not solid
      ghostMat: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false })
    };`],
[`    var curColour = '', curName = null, wheelAngle = 0;`, `    var curColour = '', curName = null, wheelAngle = 0, ghost = false;

    function setGhost(on) {
      on = !!on;
      if (on === ghost) return;
      ghost = on;
      var mat = on ? shared.ghostMat : shared.mat;
      group.traverse(function (o) { if (o.isMesh) { o.material = mat; o.renderOrder = on ? 3 : 0; } });
      tagMat.opacity = on ? 0.6 : 1;
    }`],
[`    return { group: group, update: update, setColour: setColour, setName: setName, dispose: dispose };`,
 `    return { group: group, update: update, setColour: setColour, setName: setName, setGhost: setGhost, dispose: dispose };`]
]);
