// More hostile clients: stationary attacker with a fake speed field; 16 + 1 players; message sizes; jump start.
'use strict';
const path = require('path');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const PORT = Number(process.env.PORT || 24912);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name, extra) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    const c = { ws, id: 0, seq: 0, hits: [], errors: [], gp: null, maxLen: 0, snapLen: 0, glno: [] };
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello', v: 1, name }, extra || {}))));
    ws.on('message', d => {
      const s = d.toString();
      let m; try { m = JSON.parse(s); } catch (e) { return; }
      if (m.t === 'welcome') { c.id = m.id; c.seq = m.seq; resolve(c); }
      if (m.t === 'track') c.seq = m.seq;
      if (m.t === 'hit') c.hits.push(m.i);
      if (m.t === 'error') { c.errors.push(m.code); resolve(c); }
      if (m.t === 'gp') { c.gp = m.s; c.maxLen = Math.max(c.maxLen, s.length); }
      if (m.t === 'snap') c.snapLen = Math.max(c.snapLen, s.length);
      if (m.t === 'glno') c.glno.push(m.why);
    });
    ws.on('error', e => { c.errors.push('socket:' + e.message); resolve(c); });
    c.send = o => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    c.state = (x, z, heading, speed, g) => { const m = { t: 's', k: c.seq, c: Date.now() % 1e9, s: [x, 0, z, heading, 0, 0, speed, 0] }; if (g != null) m.g = g; c.send(m); };
    return c;
  });
}

(async () => {
  const logs = [];
  const srv = await createServer({ port: PORT, host: '127.0.0.1', log: l => logs.push(l) });
  const host = await client('host');
  host.send({ t: 'track', id: 'it-1922' });
  await sleep(50);
  const victim = await client('victim');
  const attacker = await client('attacker');
  await sleep(50);
  // B. a completely stationary attacker 2.5 m from the victim: its speed field says 130 m/s towards the victim
  for (let i = 0; i < 6; i++) { victim.state(0, 0, 0, 0); attacker.state(2.5, 0, -Math.PI / 2, 130); await sleep(50); }
  attacker.send({ t: 'hit', k: attacker.seq, to: victim.id, i: [-80, 0] });
  await sleep(100);
  console.log('B. stationary attacker, speed field 130 towards the victim: relayed', JSON.stringify(victim.hits));

  // B2. and with speed field 0 (honest): nothing beyond HIT_SLACK should pass
  victim.hits.length = 0;
  await sleep(2100);
  for (let i = 0; i < 6; i++) { victim.state(0, 0, 0, 0); attacker.state(2.5, 0, -Math.PI / 2, 0); await sleep(50); }
  attacker.send({ t: 'hit', k: attacker.seq, to: victim.id, i: [-80, 0] });
  await sleep(100);
  console.log('B2. same, speed field 0: relayed', JSON.stringify(victim.hits));

  // K. 16 players + a 17th; a Grand Prix with 16 on the grid; message sizes
  const many = [];
  for (let i = 0; i < 13; i++) many.push(await client('player-sixteen-' + i, { car: '2024-ferrari' }));
  const seventeenth = await client('seventeen');
  console.log('K. players', srv.info().players.length, '17th:', JSON.stringify(seventeenth.errors), 'slots', srv.info().players.map(p => p.slot).sort((a, b) => a - b).join(','));
  host.send({ t: 'gp', a: 'start', q: 1, r: 2, len: 5000 });
  await sleep(150);
  host.send({ t: 'gp', a: 'skip' });
  await sleep(300);
  const all = [host, victim, attacker].concat(many);
  for (let k = 0; k < 10; k++) { all.forEach((c, i) => c.state(i * 10, 0, 0, 50)); await sleep(50); }
  await sleep(200);
  console.log('K. grid size', host.gp.grid.length, 'phase', host.gp.phase, 'largest gp message', host.maxLen, 'B, largest snap', host.snapLen, 'B');

  // L. jump start: driving as soon as the lights come on, before goAt: the server's view
  const info = srv.info();
  const wait = info.gp.lightsAt - info.now;
  await sleep(Math.max(0, wait + 100));
  // the attacker "drives" 300 m before goAt
  for (let k = 0; k < 40; k++) { attacker.state(20 + k * 8, 0, Math.PI / 2, 80, 0.06); await sleep(50); }
  const i2 = srv.info();
  console.log('L. phase', i2.gp.phase, 'goAt-now', i2.gp.goAt - i2.now, '(a jump-starting client is not told anything; path before goAt is simply not credited)');
  await sleep(Math.max(0, i2.gp.goAt - i2.now + 200));
  // after goAt: he keeps going; then reports a lap with a path of 0.9 * len from goAt
  for (let k = 0; k < 20; k++) { attacker.state(340 + k * 8, 0, Math.PI / 2, 80, 0.1 + k * 0.01); await sleep(50); }
  console.log('L. progress of the jump starter vs an honest car standing on the grid:', JSON.stringify(srv.info().gp.order.slice(0, 3)), 'attacker id', attacker.id);

  all.forEach(c => { try { c.ws.close(); } catch (e) {} });
  await srv.close();
  console.log('server errors:', logs.filter(l => /error/i.test(l)));
})().catch(e => { console.error(e); process.exit(1); });
