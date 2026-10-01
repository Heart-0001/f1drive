// Verifier probes for MP-1..MP-4 against the real net/server.js (raw ws clients).
//   node devtests/review-final/verify-multiplayer/probe.js
'use strict';
const path = require('path');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { createServer } = require(path.join(ROOT, 'net', 'server.js'));
const resolve = require(path.join(ROOT, 'js', 'collide.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let PORT = 24961;

function client(name, extra, opts) {
  return new Promise(res => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT, opts || {});
    const c = { ws, id: 0, seq: 0, hits: [], errors: [], gp: null, gps: 0, closed: false };
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'hello', v: 1, name }, extra || {}))));
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.t === 'welcome') { c.id = m.id; c.seq = m.seq; res(c); }
      if (m.t === 'track') c.seq = m.seq;
      if (m.t === 'hit') c.hits.push(m.i);
      if (m.t === 'gp') { c.gp = m.s; c.gps++; }
      if (m.t === 'error') { c.errors.push(m.code); res(c); }
    });
    ws.on('error', e => { c.errors.push('socket:' + e.message); res(c); });
    ws.on('close', () => { c.closed = true; res(c); });
    c.send = o => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
    c.state = (x, z, h, v) => c.send({ t: 's', k: c.seq, c: Date.now() % 1e9, s: [x, 0, z, h, 0, 0, v, 0] });
  });
}

async function mp1() {
  const srv = await createServer({ port: PORT, host: '127.0.0.1' });
  const host = await client('host');
  host.send({ t: 'track', id: 'it-1922' }); await sleep(60);
  const victim = await client('victim'), att = await client('attacker');
  await sleep(60);
  const W = -Math.PI / 2;                    // heading towards -x (heading 0 = +z; sin(-pi/2) = -1)
  // (a) the reviewer's case: the attacker does not move, its speed field says 130 m/s towards the victim
  for (let i = 0; i < 6; i++) { victim.state(0, 0, 0, 0); att.state(2.5, 0, W, 130); await sleep(50); }
  att.send({ t: 'hit', k: att.seq, to: victim.id, i: [-80, 0] }); await sleep(120);
  console.log('MP-1 a. stationary attacker, fake speed field 130:', JSON.stringify(victim.hits));
  victim.hits.length = 0; await sleep(4100);  // budget refill
  // (b) same, honest speed field 0
  for (let i = 0; i < 6; i++) { victim.state(0, 0, 0, 0); att.state(2.5, 0, W, 0); await sleep(50); }
  att.send({ t: 'hit', k: att.seq, to: victim.id, i: [-80, 0] }); await sleep(120);
  console.log('MP-1 b. stationary attacker, honest speed 0:', JSON.stringify(victim.hits));
  victim.hits.length = 0; await sleep(4100);
  // (c) position-consistent attacker: its reported positions REALLY close at 130 m/s (6.5 m per 50 ms), as the
  //     reviewer's fix would require; speed field = what the positions show
  att.state(40, 0, W, 0); await sleep(50);
  for (let x = 33.5; x >= 2; x -= 6.5) { victim.state(0, 0, 0, 0); att.state(x, 0, W, 130); await sleep(50); }
  att.send({ t: 'hit', k: att.seq, to: victim.id, i: [-80, 0] }); await sleep(120);
  console.log('MP-1 c. attacker whose POSITIONS close at 130 m/s (dx/dt-derived speed would agree):', JSON.stringify(victim.hits));
  for (const c of [host, victim, att]) c.ws.close();
  await srv.close();

  // (d) no 'hit' message at all: the victim's OWN resolver (js/collide.js) against a remote car whose state says
  //     130 m/s at it, overlapping by 0.3 m. The victim stands still.
  const me = { x: 0, z: 0, heading: 0, speed: 0, hit: 0 };
  const contacts = [];
  resolve(me, [{ x: 1.6, z: 0, heading: W, speed: 130 }], 1 / 120, contacts);
  console.log('MP-1 d. victim resolver vs a remote state "1.6 m away, 130 m/s at us": victim velocity change',
    JSON.stringify(contacts.map(c => [+c.ix.toFixed(1), +c.iz.toFixed(1)])), 'speed now', me.speed.toFixed(1), 'heading', me.heading.toFixed(3));
  const me2 = { x: 0, z: 0, heading: 0, speed: 0, hit: 0 }, c2 = [];
  resolve(me2, [{ x: 0, z: 5.0, heading: Math.PI, speed: 130 }], 1 / 120, c2);
  console.log('MP-1 d2. same head-on along our heading (remote 5.0 m ahead, 130 m/s at us): velocity change',
    JSON.stringify(c2.map(c => [+c.ix.toFixed(1), +c.iz.toFixed(1)])), 'speed now', me2.speed.toFixed(1));
}

async function mp2() {
  PORT++;
  const srv = await createServer({ port: PORT, host: '127.0.0.1', password: 'secret' });
  const out = [];
  for (let i = 0; i < 6; i++) { const c = await client('bf' + i, { password: 'guess' + i }); out.push(c.errors[0]); }
  const right = await client('friend', { password: 'secret' });
  console.log('MP-2. 6 wrong from one address:', JSON.stringify(out), '| then the right one from that address:', right.id ? 'admitted' : JSON.stringify(right.errors));
  try { right.ws.close(); } catch (e) {}
  await srv.close();
}

async function mp3() {
  PORT++;
  const srv = await createServer({ port: PORT, host: '127.0.0.1' });
  const host = await client('host');                       // the in-game host is on loopback (exempt)
  const res = [];
  for (let i = 0; i < 10; i++) {
    // 127.0.0.2 is not one of the addresses isLoopback() exempts: stands for one public / NAT address
    const c = await client('nat' + i, {}, { localAddress: '127.0.0.2' });
    res.push(c.id ? 'in' : c.errors.join('/'));
  }
  console.log('MP-3. 10 players from one non-loopback address:', JSON.stringify(res), '| roster', srv.info().players.length);
  host.ws.close();
  await srv.close();
}

async function mp4() {
  PORT++;
  const srv = await createServer({ port: PORT, host: '127.0.0.1' });
  const host = await client('host');
  host.send({ t: 'track', id: 'it-1922' }); await sleep(30);
  host.send({ t: 'track', id: 'mc-1929' }); await sleep(30);   // waits ~1 s (trackNext)
  const before = host.gps;
  host.send({ t: 'gp', a: 'start', q: 1, r: 1, len: 5000 }); await sleep(200);
  console.log('MP-4. start while the 2nd pick waits: phase', srv.info().gp.phase, '| gp messages to the host since:', host.gps - before);
  await sleep(1000);
  console.log('MP-4. 1.2 s later: track', srv.info().track, 'phase', srv.info().gp.phase);
  host.send({ t: 'gp', a: 'start', q: 1, r: 1, len: 5000 }); await sleep(200);
  console.log('MP-4. start again now: phase', srv.info().gp.phase);
  host.ws.close();
  await srv.close();
}

(async () => {
  const only = process.argv[2];
  if (!only || only === '1') await mp1();
  if (!only || only === '2') await mp2();
  if (!only || only === '3') await mp3();
  if (!only || only === '4') await mp4();
})().catch(e => { console.error(e); process.exit(1); });
