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

patch('net/server.js', [
[`const { WebSocketServer } = require('ws');`, `const { WebSocketServer } = require('ws');
const { createSession } = require('./session');   // Grand Prix rules (shared with the single-player game)`],
[`const HIT_MAX = 80; `, `const GP_TICK_MS = 100;             // Grand Prix clock (lights out, timeout)
const GP_LIVE_MS = 500;             // live standings are re-sent this often during a race
const HIT_MAX = 80; `],
[`    let snapTimer = null, pingTimer = null;`, `    let snapTimer = null, pingTimer = null, gpTimer = null;
    const session = createSession({ random: opts.random });
    let gpSentAt = 0;`],
[`    function sendRoster() { broadcast({ t: 'players', host: hostId, players: roster() }); }`,
`    function sendRoster() { broadcast({ t: 'players', host: hostId, players: roster() }); }
    function gpMessage() { return { t: 'gp', now: Date.now(), s: session.snapshot() }; }
    function sendGp() { gpSentAt = Date.now(); broadcast(gpMessage()); }
    function gpTick() {
      const now = Date.now();
      if (session.tick(now)) { log('gp    ' + session.phase); sendGp(); }
      else if (session.phase === 'race' && now - gpSentAt >= GP_LIVE_MS) sendGp();
    }`],
[`      send(ws, { t: 'welcome', v: PROTOCOL, id: id, host: hostId, track: trackId, seq: trackSeq, players: roster() });
      sendRoster();`, `      session.addPlayer(id, p.name, Date.now());
      send(ws, { t: 'welcome', v: PROTOCOL, id: id, host: hostId, track: trackId, seq: trackSeq, players: roster(), now: Date.now() });
      sendRoster();
      sendGp();`],
[`          p.state = st; p.ct = Math.round(clamp(m.c, 0, 1e13)); p.fresh = true;
          break;`, `          p.state = st; p.ct = Math.round(clamp(m.c, 0, 1e13)); p.fresh = true;
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
          break;`],
[`          players.forEach(function (q) { q.state = null; q.fresh = false; q.last = null; q.best = null; });
          broadcast({ t: 'track', id: trackId, seq: trackSeq });
          sendRoster();`, `          players.forEach(function (q) { q.state = null; q.fresh = false; q.last = null; q.best = null; });
          const gpEnded = session.phase !== 'free';
          while (session.phase !== 'free') session.end();   // a new track ends a Grand Prix in progress
          broadcast({ t: 'track', id: trackId, seq: trackSeq });
          sendRoster();
          if (gpEnded) sendGp();`],
[`          p.name = name; p.colour = colour;
          sendRoster();`, `          p.name = name; p.colour = colour;
          sendRoster();
          if (session.rename(p.id, name) && session.phase !== 'free') sendGp();`],
[`      if (p.id === hostId) { hostId = 0; pickHost(); }
      broadcast({ t: 'gone', id: p.id });
      sendRoster();`, `      if (p.id === hostId) { hostId = 0; pickHost(); }
      session.removePlayer(p.id, Date.now());
      broadcast({ t: 'gone', id: p.id });
      sendRoster();
      sendGp();`],
[`      clearInterval(snapTimer); clearInterval(pingTimer);`, `      clearInterval(snapTimer); clearInterval(pingTimer); clearInterval(gpTimer);`],
[`      pingTimer = setInterval(function () { try { heartbeat(); } catch (e) {} }, PING_MS);`,
`      pingTimer = setInterval(function () { try { heartbeat(); } catch (e) {} }, PING_MS);
      gpTimer = setInterval(function () { try { gpTick(); } catch (e) { log('gp error: ' + e.message); } }, GP_TICK_MS);`],
[`        info: function () { return { players: roster(), host: hostId, track: trackId, seq: trackSeq }; }`,
`        info: function () { return { players: roster(), host: hostId, track: trackId, seq: trackSeq, gp: session.snapshot() }; }`]
]);
