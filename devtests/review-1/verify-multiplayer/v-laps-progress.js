// Verifier probe: forged-laps + progress-cheat against the real server (manual session clock).
// node devtests/review-1/verify-multiplayer/v-laps-progress.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));

let T = 5000000;
const now = () => T;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function client(port, name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = { ws, id: 0, gp: null, rej: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      if (m.t === 'gp') c.gp = m.s;
      if (m.t === 'glno') c.rej.push(m.why);
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name, token })));
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
const row = (c, id) => c.gp.players.find(p => p.id === id);

(async () => {
  const srv = await createServer({ port: 0, hostToken: 'tok', now, log: () => {} });
  const host = await client(srv.port, 'host', 'tok');
  const honest = await client(srv.port, 'honest');
  const cheat = await client(srv.port, 'cheat');
  send(host, { t: 'track', id: 'monza' });
  await sleep(60);
  const len = 5793, min = len / (330 / 3.6);
  console.log('min lap allowed on', len, 'm:', min.toFixed(3), 's (real 2020 pole 78.887 s)');
  send(host, { t: 'gp', a: 'start', q: 2, r: 3, len });
  await sleep(150);
  const sid = host.gp.sid;

  // ---- qualifying: honest drives 2 laps of 80 s; the cheater never sends a state, only 'gl'
  for (let i = 0; i < 2; i++) {
    T += 81000;
    send(honest, { t: 'gl', k: 1, sid, time: 80 });
    send(host, { t: 'gl', k: 1, sid, time: 81 });
    send(cheat, { t: 'gl', k: 1, sid, time: +(min + 0.001).toFixed(3) });
    await sleep(120);
  }
  await sleep(100);
  console.log('after quali: phase', host.gp.phase, 'grid', host.gp.grid, '(cheat', cheat.id, 'honest', honest.id + ')', 'cheat rejections', cheat.rej);

  // ---- race
  T = host.gp.goAt + 1; await sleep(250);
  console.log('phase', host.gp.phase);
  // cheater: no state at all during the race, laps at the minimum
  for (let i = 0; i < 3; i++) {
    T += Math.ceil(min * 1000) + 50;
    send(cheat, { t: 'gl', k: 1, sid, time: +(min + 0.001).toFixed(3) });
    // honest keeps sending progress while driving (at 80 s / lap he is at ~0.8 of a lap per 64 s)
    send(honest, { t: 's', k: 1, c: T, s: [100, 0, 100, 0, 0, 0, 80, 0], g: (i + 1) * 0.79 });
    await sleep(150);
  }
  const c = row(host, cheat.id);
  console.log('cheater (never moved, never sent a state): fin', c.fin, 'rLaps', c.rLaps, 'rTime', c.rTime, 'order', host.gp.order, 'winnerAt set', host.gp.winnerAt > 0, 'rejections', cheat.rej);

  // ---- progress-cheat limits: new race, g = 99 from a parked car, vs honest who completed a lap
  send(host, { t: 'gp', a: 'start', q: 1, r: 5, len }); await sleep(150);
  send(host, { t: 'gp', a: 'skip' }); await sleep(150);
  T = host.gp.goAt + 1; await sleep(250);
  const sid2 = host.gp.sid;
  send(cheat, { t: 's', k: 1, c: 1, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 99 });
  send(honest, { t: 's', k: 1, c: 1, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 0.5 });
  await sleep(600);
  console.log('same lap (rLaps 0 each): order', host.gp.order, '-> cheat', cheat.id, 'first');
  T += 80000;
  send(honest, { t: 'gl', k: 1, sid: sid2, time: 80 });
  send(honest, { t: 's', k: 1, c: 2, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 1.05 });
  send(cheat, { t: 's', k: 1, c: 2, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 99 });
  await sleep(600);
  console.log('honest completed a lap (rLaps 1, g 1.05), cheat g=99 rLaps 0: order', host.gp.order, '(clamp holds cheat at rLaps + 0.9999)');

  [host, honest, cheat].forEach(x => x.ws.close());
  await srv.close();
})();
