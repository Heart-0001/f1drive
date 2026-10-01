// Hostile raw-WebSocket clients against the real net/server.js (review scratch, not a suite).
// node devtests/review-final/multiplayer/attack.js
'use strict';
const path = require('path');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const { createSession } = require(path.join(ROOT, 'net', 'session.js'));
const PORT = Number(process.env.PORT || 24911);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name, extra) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    const c = { ws, id: 0, seq: 0, msgs: [], hits: [], errors: [], gp: null, roster: 0 };
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello', v: 1, name }, extra || {}))));
    ws.on('message', d => {
      let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
      c.msgs.push(m);
      if (m.t === 'welcome') { c.id = m.id; c.seq = m.seq; resolve(c); }
      if (m.t === 'track') c.seq = m.seq;
      if (m.t === 'hit') c.hits.push({ at: Date.now(), i: m.i, from: m.from });
      if (m.t === 'error') { c.errors.push(m.code); resolve(c); }
      if (m.t === 'gp') c.gp = m.s;
      if (m.t === 'players') c.roster++;
    });
    ws.on('error', e => { c.errors.push('socket:' + e.message); resolve(c); });
    ws.on('close', () => { c.closed = true; });
    c.send = o => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    c.state = (x, z, heading, speed) => c.send({ t: 's', k: c.seq, c: Date.now() % 1e9, s: [x, 0, z, heading, 0, 0, speed, 0] });
  });
}

(async () => {
  let now = 1800000000000;
  const logs = [];
  const srv = await createServer({ port: PORT, host: '127.0.0.1', log: l => logs.push(l), password: 'secret' });

  // ---- A. remote shove: the attacker is nowhere near the victim, then "arrives" and claims to be closing at 130 m/s
  const host = await client('host', { password: 'secret' });
  host.send({ t: 'track', id: 'it-1922' });
  await sleep(50);
  const victim = await client('victim', { password: 'secret' });
  const attacker = await client('attacker', { password: 'secret' });
  await sleep(50);
  for (let i = 0; i < 5; i++) { victim.state(0, 0, 0, 0); attacker.state(2000, 2000, 0, 0); await sleep(50); }
  attacker.state(3, 0, -Math.PI / 2, 130);     // teleport next to the victim (jump)
  await sleep(50);
  attacker.state(2.5, 0, -Math.PI / 2, 130);   // one small step: jump cleared, "closing" at 130 m/s along -x
  await sleep(50);
  attacker.send({ t: 'hit', k: attacker.seq, to: victim.id, i: [-80, 0] });
  await sleep(100);
  console.log('A. shove from across the map, attacker claims 130 m/s while barely moving: victim got', JSON.stringify(victim.hits.map(h => h.i)));

  // sustained: one hit every 100 ms for 3 s, what gets through
  victim.hits.length = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    attacker.state(2.5 + Math.random() * 0.2, 0, -Math.PI / 2, 130);
    victim.state(0, 0, 0, 0);
    attacker.send({ t: 'hit', k: attacker.seq, to: victim.id, i: [-80, 0] });
    await sleep(100);
  }
  const total = victim.hits.reduce((s, h) => s + Math.hypot(h.i[0], h.i[1]), 0);
  console.log('A2. sustained 3 s: ' + victim.hits.length + ' hits relayed, total ' + total.toFixed(0) + ' m/s of velocity change handed to the victim');

  // ---- B. completely stationary attacker (positions identical), speed field says 130 towards the victim
  await sleep(2500);
  victim.hits.length = 0;
  for (let i = 0; i < 4; i++) { attacker.state(2.5, 0, -Math.PI / 2, 130); await sleep(50); }
  attacker.send({ t: 'hit', k: attacker.seq, to: victim.id, i: [-80, 0] });
  await sleep(100);
  console.log('B. stationary attacker (same position 4x), speed field 130: relayed', JSON.stringify(victim.hits.map(h => h.i)));

  // ---- C. the victim is frozen on the grid between lightsAt and goAt: is a hit relayed?
  // (server-side solid() says yes after lightsAt; the client ignores it while inputLocked - check the server part)
  host.send({ t: 'gp', a: 'start', q: 1, r: 2, len: 5000 });
  await sleep(150);
  host.send({ t: 'gp', a: 'skip' });
  await sleep(150);
  console.log('C. phase after skip:', host.gp && host.gp.phase, 'lightsAt-now', host.gp && (host.gp.lightsAt - srv.info().now));
  victim.hits.length = 0;
  await sleep(4300);   // lights on
  for (let i = 0; i < 3; i++) { attacker.state(2.5, 0, -Math.PI / 2, 130); victim.state(0, 0, 0, 0); await sleep(50); }
  attacker.send({ t: 'hit', k: attacker.seq, to: victim.id, i: [-80, 0] });
  await sleep(100);
  console.log('C. hit relayed while the lights are on (cars frozen):', JSON.stringify(victim.hits.map(h => h.i)), 'phase', host.gp.phase);
  host.send({ t: 'gp', a: 'end' }); await sleep(100); host.send({ t: 'gp', a: 'end' }); await sleep(100);

  // ---- D. password brute force from one address
  const tries = [];
  for (let i = 0; i < 8; i++) { const c = await client('bf' + i, { password: 'guess' + i }); tries.push(c.errors[0]); }
  console.log('D. 8 wrong passwords from one address:', JSON.stringify(tries));
  const right = await client('bfok', { password: 'secret' });
  console.log('D. right password while that address waits:', right.id ? 'admitted' : JSON.stringify(right.errors));

  // ---- E. JSON nesting bomb within 2 KB, and a 2 KB name
  attacker.ws.send('['.repeat(1000) + ']'.repeat(1000));
  attacker.ws.send('{"t":"profile","name":"' + 'x'.repeat(1990) + '"}');
  attacker.ws.send('{"t":"s","k":' + attacker.seq + ',"c":1e13,"s":[1e300,-1e300,1e300,1e300,1,1,1e300,1]}');
  await sleep(100);
  console.log('E. after nesting bomb / huge name / huge state: attacker still connected', !attacker.closed, 'server errors', logs.filter(l => /error/i.test(l)));

  // ---- F. profile flood: how many roster broadcasts per second reach the others
  victim.roster = 0;
  const f0 = Date.now();
  let n = 0;
  while (Date.now() - f0 < 2000) { attacker.send({ t: 'profile', name: 'n' + (n++ % 2) }); await sleep(20); }
  await sleep(200);
  console.log('F. profile flood 50/s for 2 s: victim received', victim.roster, 'roster broadcasts');

  // ---- G. host 'start' right after a track pick: silently ignored?
  host.send({ t: 'track', id: 'mc-1929' });
  await sleep(20);
  host.send({ t: 'track', id: 'be-1925' });   // waits for the rate limit (trackNext)
  await sleep(20);
  host.send({ t: 'gp', a: 'start', q: 1, r: 1, len: 5000 });
  await sleep(200);
  console.log('G. start sent while a track pick waits: phase =', host.gp && host.gp.phase, '(answer to the host: none)');
  await sleep(1200);
  console.log('G. 1.2 s later: track =', srv.info().track, 'phase =', srv.info().gp.phase);

  // ---- H. TCP exhaustion: 96 silent connections, then a real join
  const net = require('net');
  const socks = [];
  for (let i = 0; i < 96; i++) { const s = net.connect(PORT, '127.0.0.1'); s.on('error', () => {}); socks.push(s); }
  await sleep(300);
  const late = await Promise.race([client('late', { password: 'secret' }), sleep(1500).then(() => ({ errors: ['timeout (no welcome in 1.5 s)'] }))]);
  console.log('H. join with 96 silent TCP connections held:', late.id ? 'admitted' : JSON.stringify(late.errors));
  socks.forEach(s => s.destroy());
  await sleep(200);
  const late2 = await client('late2', { password: 'secret' });
  console.log('H. after they are gone:', late2.id ? 'admitted' : JSON.stringify(late2.errors));

  // ---- I. 16 seats held by silent-but-pinging sockets from 2 addresses? (only loopback here: perIp exempt) - skip

  for (const c of [host, victim, attacker, right, late, late2]) { try { c.ws && c.ws.close(); } catch (e) {} }
  await srv.close();

  // ---- J. session: live progress after a rejected lap (pure session.js)
  const S = createSession({ random: () => 0.5 });
  let t = 1000000;
  S.addPlayer(1, 'a', t); S.addPlayer(2, 'b', t);
  S.start({ q: 1, r: 5, len: 5000 }, t);
  S.skip(t); t += 20000; S.tick(t);
  // both drive lap 1 honestly (dist 5000 m, live ok)
  t += 100000;
  console.log('J. lap1 a:', S.lap(1, 100, t, { dist: 5000, live: 100 }), 'b:', S.lap(2, 100, t, { dist: 5000, live: 100 }));
  // lap 2: player a's states were dropped (no-data) -> rejected; his game counts the lap anyway (lap counter = 2)
  t += 100000;
  console.log('J. lap2 a (no data):', S.lap(1, 100, t, { dist: 5000, live: 10 }), 'b:', S.lap(2, 100, t, { dist: 5000, live: 100 }));
  // now both at the start of their next lap on the road: a reports progress 2.05 (his count), b 2.05
  S.progress(1, 2.05, 300);   // a: dist since his last ACCEPTED lap = 5000 + 300 (not reset on reject)
  S.progress(2, 2.05, 300);
  let snap = S.snapshot();
  console.log('J. order after a rejected lap, both at the same point on the road:', JSON.stringify(snap.order), 'rLaps', snap.players.map(p => p.rLaps));
  // half a lap later: a is really behind b by 10 m
  S.progress(1, 2.5, 2800); S.progress(2, 2.502, 2800);
  snap = S.snapshot();
  console.log('J. half a lap later, b really 10 m ahead:', JSON.stringify(snap.order));
})().catch(e => { console.error(e); process.exit(1); });
