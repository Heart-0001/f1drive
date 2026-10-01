// Review probe: can a client forge Grand Prix laps without driving? Can it launch another car at will?
// node devtests/review-1/multiplayer/probe-cheat.js
'use strict';
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'ws'));
const { createServer } = require(path.join(__dirname, '..', '..', '..', 'net', 'server.js'));

let T = 1000000;                       // manual session clock (ms)
const now = () => T;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function client(port, name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = { ws, id: 0, msgs: [], gp: null, hits: 0, last: null };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.msgs.push(m);
      if (m.t === 'welcome') { c.id = m.id; resolve(c); }
      if (m.t === 'gp') c.gp = m.s;
      if (m.t === 'glno') c.last = m.why;
      if (m.t === 'hit') c.hits++;
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, name, token })));
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));

(async () => {
  const srv = await createServer({ port: 0, hostToken: 'tok', now, log: () => {} });
  const host = await client(srv.port, 'host', 'tok');
  const cheat = await client(srv.port, 'cheat');
  const honest = await client(srv.port, 'honest');
  send(host, { t: 'track', id: 'it-1922' });
  await sleep(50);
  // Monza-ish 5793 m: minimum lap = 5793 / (330/3.6) = 63.2 s
  const len = 5793, minLap = len / (330 / 3.6);
  send(host, { t: 'gp', a: 'start', q: 1, r: 3, len });
  await sleep(150);
  const sid = cheat.gp.sid;
  console.log('phase', cheat.gp.phase, 'sid', sid);

  // ---- forged qualifying lap: wait the minimum, report the minimum, never move the car
  T += Math.ceil(minLap * 1000) + 100;
  send(cheat, { t: 'gl', k: 1, sid, time: Math.ceil(minLap * 1000) / 1000 });
  await sleep(150);
  const me = cheat.gp.players.find(p => p.id === cheat.id);
  console.log('forged quali lap accepted?', cheat.last === null && me.qBest !== null, 'qBest', me.qBest, 'glno', cheat.last);

  // host + honest skip: host skips qualifying -> grid
  send(host, { t: 'gp', a: 'skip' });
  await sleep(150);
  console.log('grid order', cheat.gp.grid, '(cheat id', cheat.id + ')');
  T = cheat.gp.goAt + 10;
  await sleep(250);
  console.log('phase', cheat.gp.phase);

  // ---- forged race: three laps at the minimum, car parked on the grid (progress g stays 0)
  for (let i = 0; i < 3; i++) {
    T += Math.ceil(minLap * 1000) + 100;
    send(cheat, { t: 's', k: 1, c: T, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 0 });
    send(cheat, { t: 'gl', k: 1, sid, time: Math.ceil(minLap * 1000) / 1000 });
    await sleep(150);
  }
  const me2 = cheat.gp.players.find(p => p.id === cheat.id);
  console.log('cheat finished race?', me2.fin, 'rLaps', me2.rLaps, 'winnerAt', cheat.gp.winnerAt, 'endsAt - winnerAt', cheat.gp.endsAt - cheat.gp.winnerAt, 'order', cheat.gp.order);

  // honest player: has driven 0 laps; his next lap is his flag
  T += 70000;
  send(honest, { t: 'gl', k: 1, sid, time: 70 });
  await sleep(150);
  const h = cheat.gp.players.find(p => p.id === honest.id);
  console.log('honest after 1 lap: fin', h.fin, 'rLaps', h.rLaps, 'phase', cheat.gp.phase);

  // ---- hit spam: attacker teleports his state onto the victim, then reports 80 m/s impacts
  send(host, { t: 'gp', a: 'end' }); await sleep(150);
  send(host, { t: 'gp', a: 'end' }); await sleep(150);       // results -> free
  console.log('phase', cheat.gp.phase);
  send(honest, { t: 's', k: 1, c: 1, s: [500, 0, 500, 0, 0, 0, 80, 0] });
  send(cheat, { t: 's', k: 1, c: 1, s: [500, 0, 500, 0, 0, 0, 0, 0] });   // 1 km away from where the cheat "was"
  await sleep(100);
  honest.hits = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) {
    send(cheat, { t: 'hit', k: 1, to: honest.id, i: [80, 0] });
    await sleep(20);
  }
  await sleep(100);
  console.log('impact reports relayed to the victim in 1 s:', honest.hits, '(each 80 m/s = 288 km/h)');

  // ---- progress cheat: g = 99 while parked
  send(host, { t: 'gp', a: 'start', q: 1, r: 5, len }); await sleep(150);
  send(host, { t: 'gp', a: 'skip' }); await sleep(150);
  T = cheat.gp.goAt + 10; await sleep(250);
  send(cheat, { t: 's', k: 1, c: 2, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 99 });
  send(honest, { t: 's', k: 1, c: 2, s: [0, 0, 0, 0, 0, 0, 0, 0], g: 0.5 });
  await sleep(700);
  console.log('live order with cheat parked and g=99:', cheat.gp.order, 'cheat id', cheat.id, 'honest id', honest.id);

  [host, cheat, honest].forEach(c => c.ws.close());
  await srv.close();
})();
