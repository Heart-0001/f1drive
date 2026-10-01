// node test/server.test.js — tests for net/server.js with real `ws` clients (the relay, the Grand Prix over the
// wire, the v6 cars / room year / tyre wear, protocol hardening), plus js/net.js: address parsing, the real client
// against the real server, and the client against a hostile server.
//
// Ports: the OS picks them (port 0) unless F1_TEST_PORT_BASE is set, then base .. base + 59 are used.
// Clock: the Grand Prix tests hand createServer a manual clock (opts.now) and step it, so a whole race takes
// milliseconds; one test ("real clock") runs a complete Grand Prix on the default clock in real time (~14.5 s).
// Order: every test has its own server, so they run in a few concurrent lanes next to the real-time one.
// The flood tests hog the event loop (client and server share this process): they go first, alone, while
// the real-time test is only waiting for its qualifying lap and its start lights. Whole suite: ~15 s.
// (On the real clock the minimum lap is len / 91.67 m/s = 2.2 s on the shortest track, and the grid takes
// 4 s + 5 lights + the hold: that test cannot be shorter.)
'use strict';
const assert = require('assert');
const nodeNet = require('net');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createServer } = require('../net/server.js');
const { minLapTime, RACE_TIMEOUT_MS } = require('../net/session.js');
const netClient = require('../js/net.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T_START = Date.now();
let failed = 0;
const uncaught = [];
process.on('uncaughtException', e => { uncaught.push(e); console.log('UNCAUGHT ' + (e && e.stack)); });

const PORT_BASE = Number(process.env.F1_TEST_PORT_BASE) || 0;
let portSeq = 0;
const nextPort = () => (PORT_BASE ? PORT_BASE + (portSeq++ % 59) : 0);
const SLOW_PORT = PORT_BASE ? PORT_BASE + 59 : 0;            // the concurrent real-time test keeps its own

async function until(pred, ms, what) {
  const end = Date.now() + (ms || 2000);
  for (;;) {
    const r = pred();
    if (r) return r;
    if (Date.now() >= end) throw new Error('timeout waiting for ' + (what || pred));
    await sleep(5);
  }
}

// A test client that records every message.
function client(port, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    const c = { ws, msgs: [], closed: null, id: 0 };
    c.send = o => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    c.last = t => { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === t) return c.msgs[i]; return null; };
    c.all = t => c.msgs.filter(m => m.t === t);
    c.wait = (pred, ms, what) => until(pred, ms, what);
    // the room as this client knows it: the roster comes in `welcome` and in every later `players`
    c.rosterMsg = () => c.last('players') || c.last('welcome');
    c.roster = () => c.rosterMsg().players;
    c.host = () => c.rosterMsg().host;
    c.seq = () => (c.last('track') || c.last('welcome')).seq;
    // Grand Prix
    c.gp = () => { const m = c.last('gp'); return m ? m.s : null; };
    c.me = () => c.gp().players.find(p => p.id === c.id && !p.left);
    // the car state; v = speed (m/s), h = heading (rad, 0 = +z, PI / 2 = +x)
    c.px = 0; c.pz = 0; c.placed = false;
    c.drive = (x, z, g, v, h) => {
      c.px = x; c.pz = z; c.placed = true;
      c.send({ t: 's', k: c.seq(), c: Date.now(), s: [x, 0, z, h || 0, 0, 0, v || 0, 0], g });
    };
    // The car drives m metres on along x (one state; the server credits it as far as the time since the car's
    // previous state allows at 130 m/s, up to 5 s of it: the tests step the clock before a lap).
    c.run = (m, g) => { if (!c.placed) c.drive(c.px, c.pz); c.drive(c.px + m, c.pz, g); };
    // A lap the server can believe: the car covers a lap of the test track first, then reports it.
    c.lap = (time, sid, at) => {
      c.run(LEN);
      c.send({ t: 'gl', k: c.seq(), sid: sid === undefined ? c.gp().sid : sid, time, at });
    };
    ws.on('message', d => {
      try { c.msgs.push(JSON.parse(d.toString())); } catch (e) { c.msgs.push({ t: '?raw' }); }
      if (c.msgs[c.msgs.length - 1].t === 'track') c.placed = false;        // a new track: the car is not on it yet
    });
    ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    ws.on('open', async () => {
      if (hello === false) { resolve(c); return; }
      c.send(Object.assign({ t: 'hello', v: 1, name: 'P', colour: '#112233' }, hello || {}));
      try {
        await c.wait(() => c.last('welcome') || c.closed);
        const w = c.last('welcome');
        if (w) c.id = w.id;
        resolve(c);
      } catch (e) { reject(e); }
    });
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
const state = (x, v) => ({ t: 's', k: 0, c: Date.now(), s: [x, 0, 0, 0, 0, 0, v || 0, 0] });

// A WebSocket client on a bare TCP socket that never answers a close frame (or a ping): what a hostile
// peer does to keep its connection. Frames are sent masked with key 0.
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const sock = nodeNet.connect(port, '127.0.0.1');
    const r = { sock, msgs: [], closeFrame: null, ended: false };
    let buf = Buffer.alloc(0), upgraded = false;
    r.send = o => {
      const p = Buffer.from(typeof o === 'string' ? o : JSON.stringify(o));
      const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
      if (!sock.destroyed) sock.write(Buffer.concat([head, Buffer.alloc(4), p]));
    };
    r.last = t => { for (let i = r.msgs.length - 1; i >= 0; i--) if (r.msgs[i].t === t) return r.msgs[i]; return null; };
    sock.on('connect', () => sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.toString('latin1', 0, i))) { reject(new Error('no upgrade')); return; }
        buf = buf.subarray(i + 4); upgraded = true; resolve(r);
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 15, payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1) { try { r.msgs.push(JSON.parse(payload.toString())); } catch (e) {} }
        else if (op === 8) r.closeFrame = len >= 2 ? payload.readUInt16BE(0) : 0;
      }
    });
    sock.on('close', () => { r.ended = true; });
    sock.on('error', () => {});
    setTimeout(() => reject(new Error('raw connect timeout')), 3000);
  });
}

// Tests are registered into lanes with T() and run at the bottom of the file.
const lanes = { floods: [], tcp: [], relay: [], gp1: [], gp2: [], gp3: [], client: [], year: [], year2: [], review: [], review2: [] };
let lane = lanes.relay;
const T = (name, fn) => { lane.push([name, fn]); };
const runLane = async list => { for (const [name, fn] of list) await test(name, fn); };

async function test(name, fn) {
  const servers = [], t0 = Date.now();
  const ctx = {
    start: async (o, port) => {
      const srv = await createServer(Object.assign({ port: port === undefined ? nextPort() : port, host: '127.0.0.1' }, o));
      servers.push(srv);
      return srv;
    }
  };
  try { await fn(ctx); console.log('ok   ' + name + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
  finally { for (const s of servers) await s.close(); }
}

/* ---------- Grand Prix helpers ---------- */

const LEN = 200;                          // m, the shortest track a session accepts
const MIN = minLapTime(LEN);              // 2.18 s
// A clock that only moves when the test says so.
function manualClock(t0) {
  let t = t0 || 1700000000000;
  const c = () => t;
  c.add = ms => { t += ms; return t; };
  c.to = v => { if (v > t) t = v; return t; };
  return c;
}
// Every client ends up with exactly the snapshot the server holds (and that one satisfies pred). -> snapshot
async function settle(srv, clients, pred, ms) {
  let want = '';
  await until(() => {
    const s = srv.info().gp;
    if (pred && !pred(s)) return false;
    want = JSON.stringify(s);
    return clients.every(c => c.closed || (c.last('gp') && JSON.stringify(c.last('gp').s) === want));
  }, ms || 3000, 'all clients on the same snapshot' + (pred ? ' with ' + pred : ''));
  return JSON.parse(want);
}
// A room of n players on a track, manual clock, shortest hold before lights out. cs[0] is the host.
// opts: createServer options, plus cars: the car id each player announces in its hello.
async function room(t, n, opts) {
  const clk = manualClock();
  const srv = await t.start(Object.assign({ now: clk, random: () => 0 }, opts));
  const cs = [];
  for (let i = 0; i < n; i++) {
    cs.push(await client(srv.port, Object.assign({ name: 'P' + (i + 1) }, opts && opts.cars ? { car: opts.cars[i] } : {},
      i === 0 && opts && opts.hostToken ? { token: opts.hostToken } : {})));
  }
  cs[0].send({ t: 'track', id: 'monza' });
  for (const c of cs) await c.wait(() => c.last('track'), 2000, 'track');
  const r = { srv, clk, cs, settle: (pred, ms) => settle(srv, r.cs, pred, ms) };
  r.start = async (q, rr) => { cs[0].send({ t: 'gp', a: 'start', q: q, r: rr, len: LEN }); return r.settle(s => s.phase === 'quali'); };
  // one qualifying lap each, in join order (2.5 s, 2.6 s, ...) -> grid
  r.toGrid = async () => {
    clk.add(3000);
    const drivers = r.cs.filter(c => !c.closed && c.me() && !c.me().spec);
    drivers.forEach((c, i) => c.lap(2.5 + i * 0.1));
    return r.settle(s => s.phase === 'grid');
  };
  r.toRace = async () => { const g = await r.toGrid(); clk.to(g.goAt); return r.settle(s => s.phase === 'race'); };
  return r;
}
// a fresh instance of the real client (js/net.js is a singleton per load)
function freshNet() {
  const p = require.resolve('../js/net.js');
  delete require.cache[p];
  return require(p);
}

(async () => {
  /* ---------- real clock: a whole Grand Prix in real time, started now, awaited at the very end ---------- */
  const slow = test('Grand Prix on the real clock: 200 m track, quali -> lights -> race -> results in real time', async t => {
    const srv = await t.start({ random: () => 0 }, SLOW_PORT);
    const a = await client(srv.port, { name: 'Ann' }), b = await client(srv.port, { name: 'Bob' });
    assert(Math.abs(b.last('welcome').now - Date.now()) < 150, 'the default clock starts at Date.now(): ' + (b.last('welcome').now - Date.now()));
    a.send({ t: 'track', id: 'monza' });
    await b.wait(() => b.last('track'));
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    await settle(srv, [a, b], s => s.phase === 'quali');
    const t0 = Date.now();
    a.lap(2.2);
    await a.wait(() => a.last('glno'));
    assert.strictEqual(a.last('glno').why, 'too-soon', 'no lap can be over ' + (MIN * 0.9).toFixed(2) + ' s into the session');
    await sleep(2350 - (Date.now() - t0));
    a.lap(2.2); b.lap(2.25);
    const g = await settle(srv, [a, b], s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [a.id, b.id]);
    const m = b.last('gp');
    assert(g.lightsAt - m.now > 3700 && g.lightsAt - m.now <= 4000, 'first light 4 s after the grid forms: ' + (g.lightsAt - m.now));
    assert.strictEqual(g.goAt - g.lightsAt, 5500, 'five lights + the shortest hold');
    assert(Math.abs(m.now - Date.now()) < 150, 'gp.now is the server clock');
    await sleep(g.goAt - Date.now() - 400);
    assert.strictEqual(srv.info().gp.phase, 'grid', '400 ms before lights out');
    await b.wait(() => b.gp().phase === 'race', 3000, 'race');
    const late = Date.now() - g.goAt;
    assert(late >= -30 && late < 500, 'the race snapshot follows lights out: ' + late + ' ms');
    assert(b.last('gp').now >= g.goAt, 'never before goAt on the server clock');
    const n0 = b.all('gp').length, tRace = Date.now();
    a.run(150, 0.4); b.run(150, 0.6);                          // (progress needs the path to back it: 150 m of 200)
    await settle(srv, [a, b], s => s.order[0] === b.id);
    await sleep(2350 - (Date.now() - tRace));
    assert(b.all('gp').length - n0 >= 4, 'live standings about twice a second: ' + (b.all('gp').length - n0));
    b.lap(2.3); a.lap(2.32);
    const r = await settle(srv, [a, b], s => s.phase === 'results');
    assert.deepStrictEqual(r.order, [b.id, a.id]);
    assert.deepStrictEqual(r.players.map(p => [p.fin, p.rLaps]), [[true, 1], [true, 1]]);
    assert(r.winnerAt > r.goAt && r.endsAt === r.winnerAt + RACE_TIMEOUT_MS);
    a.ws.close(); b.ws.close();
  });

  /* ---------- the relay ---------- */
  lane = lanes.relay;

  T('join / roster / leave', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: 'Alice' });
    assert.strictEqual(a.last('welcome').host, a.id, 'first player is host on a dedicated server');
    assert.strictEqual(a.last('welcome').track, null);
    const b = await client(srv.port, { name: 'Bob', colour: '#ABCDEF' });
    await a.wait(() => a.roster().length === 2);
    const ros = a.roster();
    assert.deepStrictEqual(ros.map(p => p.name), ['Alice', 'Bob']);
    assert.deepStrictEqual(ros.map(p => p.slot), [0, 1]);
    assert.strictEqual(ros[1].colour, '#abcdef');
    assert.deepStrictEqual(b.last('welcome').players, ros, 'the newcomer gets the roster in its welcome');
    b.ws.close();
    await a.wait(() => a.roster().length === 1);
    assert(a.last('gone') && a.last('gone').id === b.id);
    // the freed grid slot is reused, the id is not
    const c = await client(srv.port, { name: 'Carol' });
    assert.strictEqual(c.last('welcome').players.find(p => p.id === c.id).slot, 1);
    assert(c.id > b.id);
    a.ws.close(); c.ws.close();
  });

  T('name / colour sanitising', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: '  <b>very very very long name here</b>\u0000\n ', colour: 'red; x' });
    const me = a.last('welcome').players[0];
    assert(Array.from(me.name).length <= 16, me.name);
    assert(!/[\u0000-\u001f]/.test(me.name));
    assert(/^#[0-9a-f]{6}$/.test(me.colour), me.colour);
    const b = await client(srv.port, { name: 12345, colour: null });
    assert(/^Player \d+$/.test(b.last('welcome').players.find(p => p.id === b.id).name));
    a.send({ t: 'profile', name: '小明', colour: '#00ff00' });
    await b.wait(() => b.roster().some(p => p.name === '小明' && p.colour === '#00ff00'));
    a.ws.close(); b.ws.close();
  });

  T('host migration on a dedicated server', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port), c = await client(srv.port);
    assert.strictEqual(c.last('welcome').host, a.id);
    // non-host cannot change the track
    b.send({ t: 'track', id: 'monza' });
    await sleep(120);
    assert.strictEqual(c.last('track'), null);
    a.ws.close();
    await c.wait(() => c.host() === b.id);
    b.send({ t: 'track', id: 'monza' });
    await c.wait(() => c.last('track'));
    assert.strictEqual(c.last('track').id, 'monza');
    b.ws.close();
    await c.wait(() => c.host() === c.id);
    c.ws.close();
  });

  T('in-game server: host is the token holder, no migration', async t => {
    const srv = await t.start({ hostToken: 'secret-token' });
    const g = await client(srv.port, { name: 'Guest' });            // joins first, but has no token
    assert.strictEqual(g.last('welcome').host, 0);
    const bad = await client(srv.port, { name: 'Liar', token: 'wrong' });
    assert.strictEqual(bad.last('welcome').host, 0);
    const h = await client(srv.port, { name: 'Host', token: 'secret-token' });
    assert.strictEqual(h.last('welcome').host, h.id);
    await g.wait(() => g.host() === h.id);
    g.send({ t: 'track', id: 'spa' });
    await sleep(100);
    assert.strictEqual(h.last('track'), null, 'guest must not pick the track');
    h.ws.close();
    await g.wait(() => g.host() === 0);
    g.ws.close(); bad.ws.close();
  });

  T('track change broadcast, late joiner gets the current track', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    a.send({ t: 'track', id: 'suzuka' });
    await b.wait(() => b.last('track'));
    assert.deepStrictEqual([b.last('track').id, b.last('track').seq], ['suzuka', 1]);
    assert.strictEqual(a.last('track').id, 'suzuka', 'the host gets the broadcast too');
    const c = await client(srv.port);
    assert.deepStrictEqual([c.last('welcome').track, c.last('welcome').seq], ['suzuka', 1]);
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(65), 5, null, { a: 1 }]) a.send({ t: 'track', id: bad });
    await sleep(120);
    assert.strictEqual(b.all('track').length, 1, 'invalid track ids are ignored');
    // a host clicking through tracks (or a hostile one): everybody loads the first and then only the last pick
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) a.send({ t: 'track', id: 'track-' + i });
    await b.wait(() => b.last('track').id === 'track-99', 3000, 'the last pick');
    assert(Date.now() - t0 >= 700, 'not before a second has passed since the previous change: ' + (Date.now() - t0));
    assert.deepStrictEqual(b.all('track').map(m => [m.id, m.seq]), [['suzuka', 1], ['track-99', 2]], 'one reload, not a hundred');
    assert.deepStrictEqual([srv.info().track, srv.info().seq], ['track-99', 2]);
    // a pick that is still waiting dies with its host
    a.send({ t: 'track', id: 'never' });
    a.ws.close();
    await b.wait(() => b.host() === b.id);
    await sleep(1200);
    assert.strictEqual(srv.info().track, 'track-99');
    b.send({ t: 'track', id: 'mine' });
    await c.wait(() => c.last('track').id === 'mine');
    b.ws.close(); c.ws.close();
  });

  T('snapshot relay at ~20 Hz, validated and clamped', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    const timer = setInterval(() => a.send(state(Math.random() * 100, 50)), 25);
    await sleep(1050);
    clearInterval(timer);
    const snaps = b.all('snap');
    assert(snaps.length >= 15 && snaps.length <= 23, 'snapshots in ~1 s: ' + snaps.length);
    const e = snaps[snaps.length - 1].p[0];
    assert.strictEqual(e.length, 10);
    assert.strictEqual(e[0], a.id);
    assert(e.every(Number.isFinite));
    // nothing new -> no snapshot
    await sleep(120);
    const n0 = b.all('snap').length;
    await sleep(250);
    assert.strictEqual(b.all('snap').length, n0, 'idle players must not be rebroadcast');
    // out-of-range values are clamped, malformed states are dropped
    a.send({ t: 's', k: 0, c: 1, s: [1e30, -1e30, 5, 100, 9, -9, 1e9, 7] });
    await b.wait(() => b.all('snap').length > n0);
    const c = b.last('snap').p[0];
    assert(Math.abs(c[2]) <= 1e5 && Math.abs(c[8]) <= 130 && Math.abs(c[9]) <= 1 && Math.abs(c[6]) <= 1.2, JSON.stringify(c));
    const n1 = b.all('snap').length;
    for (const s of [[1, 2, 3], 'x', null, [1, 2, 3, 4, 5, 6, 7, 'a'], [1, 2, 3, 4, 5, 6, 7, null], [NaN, 0, 0, 0, 0, 0, 0, 0]]) {
      a.send({ t: 's', k: 0, c: 2, s });
    }
    a.send({ t: 's', k: 99, c: 3, s: [0, 0, 0, 0, 0, 0, 0, 0] });      // wrong track sequence
    a.send('{"t":"s","k":0,"c":1e999,"s":[0,0,0,0,0,0,0,0]}');         // Infinity timestamp
    await sleep(200);
    assert.strictEqual(b.all('snap').length, n1, 'malformed states must not be relayed');
    a.ws.close(); b.ws.close();
  });

  T('lap times are shared through the roster', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    a.send({ t: 'lap', last: 83.4567, best: 82.1 });
    await b.wait(() => b.roster().find(p => p.id === a.id).best === 82.1);
    a.send({ t: 'lap', last: 'x', best: -5 });
    await b.wait(() => b.roster().find(p => p.id === a.id).best === null);
    a.ws.close(); b.ws.close();
  });

  T('impact reports go to the target only, clamped and throttled; only between cars that are near each other', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port), c = await client(srv.port);
    a.send({ t: 'hit', k: 0, to: b.id, i: [3, -4] });                  // nobody has reported a position yet
    await sleep(80);
    assert.strictEqual(b.last('hit'), null, 'a car that is not on the track cannot hit');
    // a drives at 90 m/s along +x into b (parked 4 m ahead); c is parked half a kilometre away
    const near = async () => { b.drive(14, 10); c.drive(500, 10); a.drive(10, 10, undefined, 90, Math.PI / 2); await sleep(60); };
    await near();
    a.send({ t: 'hit', k: 0, to: b.id, i: [3, -4] });
    await b.wait(() => b.last('hit'));
    assert.deepStrictEqual(b.last('hit'), { t: 'hit', from: a.id, i: [3, -4] });
    await near();
    a.send({ t: 'hit', k: 0, to: b.id, i: [3000, 0] });
    await b.wait(() => b.all('hit').length === 2);
    assert.deepStrictEqual(b.last('hit').i, [80, 0]);
    await near();
    for (let i = 0; i < 20; i++) a.send({ t: 'hit', k: 0, to: b.id, i: [1, 1] });      // burst: only one passes
    for (const bad of [{ to: a.id, i: [1, 1] }, { to: 999, i: [1, 1] }, { to: b.id, i: [1] }, { to: b.id, i: ['x', 1] },
      { to: b.id, i: [0, 0] }, { to: 'b', i: [1, 1] }, { to: b.id }]) a.send(Object.assign({ t: 'hit', k: 0 }, bad));
    a.send({ t: 'hit', k: 7, to: b.id, i: [1, 1] });
    await sleep(150);
    assert.strictEqual(b.all('hit').length, 3);
    a.send({ t: 'hit', k: 0, to: c.id, i: [5, 5] });                   // c is half a kilometre away
    c.send({ t: 'hit', k: 0, to: a.id, i: [5, 5] });
    await sleep(100);
    assert.strictEqual(c.all('hit').length + a.all('hit').length, 0, 'nobody else gets it, and no hits from afar');
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  T('malformed / oversized messages do not crash the server', async t => {
    const srv = await t.start();
    const a = await client(srv.port), good = await client(srv.port);
    for (const junk of ['', 'not json', '{', '[]', 'null', '123', '"str"', '{"t":5}', '{"t":"nope"}', '{"t":"hello"}',
      '{"t":"s"}', '{"t":"track"}', '{"t":"profile"}', '{"t":"lap"}', '{"__proto__":{"t":"track"}}',
      '{"t":"s","s":{"length":8}}', '{"t":"constructor"}', '{"t":"toString"}']) a.send(junk);
    a.ws.send(Buffer.from([0, 1, 2, 3, 255]));                 // binary frame
    await sleep(100);
    assert.strictEqual(a.closed, null, 'junk alone does not get you kicked');
    a.send('x'.repeat(5000));                                   // over maxPayload
    await a.wait(() => a.closed);
    assert.strictEqual(a.closed.code, 1009);
    // a socket that never says hello and sends only garbage
    const raw = await client(srv.port, false);
    raw.send({ t: 'track', id: 'monza' });
    raw.send(state(1, 1));
    raw.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    raw.send({ t: 'gl', k: 0, sid: 0, time: 3 });
    raw.send({ t: 'ping', c: 1 });
    await sleep(100);
    assert.strictEqual(good.last('track'), null, 'messages before hello are ignored');
    assert.strictEqual(raw.msgs.length, 0, 'and not answered');
    raw.ws.terminate();
    // the server still works
    good.send({ t: 'track', id: 'monza' });   // good is host now (a left)
    await good.wait(() => good.last('track'));
    good.ws.close();
  });

  T('17th player is rejected with "full"; a slot opens when someone leaves', async t => {
    const srv = await t.start();
    const cs = [];
    for (let i = 0; i < 16; i++) cs.push(await client(srv.port, { name: 'p' + i }));
    assert(cs.every(c => c.id > 0));
    const x = await client(srv.port, { name: 'late' });
    await x.wait(() => x.closed);
    assert.strictEqual(x.id, 0);
    assert.strictEqual(x.last('error').code, 'full');
    assert.strictEqual(srv.info().players.length, 16);
    cs[5].ws.close();
    await cs[0].wait(() => cs[0].roster().length === 15);
    const y = await client(srv.port, { name: 'again' });
    assert(y.id > 0);
    assert.strictEqual(y.last('welcome').players.find(p => p.id === y.id).slot, 5);
    cs.forEach(c => c.ws.close()); y.ws.close();
  });

  T('wrong protocol version is rejected', async t => {
    const srv = await t.start();
    const x = await client(srv.port, { v: 999 });
    await x.wait(() => x.closed);
    assert.strictEqual(x.last('error').code, 'version');
    assert.strictEqual(x.closed.code, 1008);
  });

  T('closing the server disconnects clients with 1001; port in use is reported', async t => {
    const srv = await t.start();
    const a = await client(srv.port);
    await assert.rejects(createServer({ port: srv.port, host: '127.0.0.1' }), e => e.code === 'EADDRINUSE');
    await srv.close();
    await a.wait(() => a.closed);
    assert.strictEqual(a.closed.code, 1001);
    await srv.close();                                         // idempotent
    const again = await createServer({ port: srv.port, host: '127.0.0.1' });   // port is free again
    await again.close();
  });

  T('client address parsing (js/net.js)', async () => {
    const p = netClient.parseAddress;
    const url = s => { const r = p(s); return r ? r.url : null; };
    assert.strictEqual(url('1.2.3.4'), 'ws://1.2.3.4:24500');
    assert.strictEqual(url(' 1.2.3.4:25565 '), 'ws://1.2.3.4:25565');
    assert.strictEqual(url('my-host.example.com'), 'ws://my-host.example.com:24500');
    assert.strictEqual(url('my-host.example.com:80'), 'ws://my-host.example.com:80');
    assert.strictEqual(url('localhost'), 'ws://localhost:24500');
    assert.strictEqual(url('[::1]'), 'ws://[::1]:24500');
    assert.strictEqual(url('[2001:db8::5]:3000'), 'ws://[2001:db8::5]:3000');
    assert.strictEqual(url('2001:db8::5'), 'ws://[2001:db8::5]:24500');
    assert.strictEqual(url('ws://1.2.3.4:24500/'), 'ws://1.2.3.4:24500');
    assert.strictEqual(url('http://1.2.3.4'), 'ws://1.2.3.4:24500');
    for (const bad of ['', '   ', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:abc', 'a b', 'host:', '[::1', '[abc]', 'x@y',
      '<script>', 'user:pw@host', null, undefined, 5]) {
      assert.strictEqual(p(bad), null, 'should reject ' + JSON.stringify(bad));
    }
  });

  /* ---------- v6: cars and the room year ---------- */

  T('cars: hello / profile / roster carry a CarSpec id; anything else is ignored and the previous car kept', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: 'Ann', car: '2024-ferrari' });
    const b = await client(srv.port, { name: 'Bob' });                             // no car: not chosen
    const c = await client(srv.port, { name: 'Cy', car: 'Ferrari 2024' });         // not an id
    await a.wait(() => a.roster().length === 3);
    assert.deepStrictEqual(a.roster().map(p => [p.name, p.car]), [['Ann', '2024-ferrari'], ['Bob', ''], ['Cy', '']]);
    assert.deepStrictEqual(c.last('welcome').players.map(p => p.car), ['2024-ferrari', '', '']);
    assert.deepStrictEqual(Object.keys(a.roster()[0]).sort(), ['best', 'car', 'colour', 'id', 'last', 'name', 'slot']);
    // a car change alone is a profile change; what the message leaves out stays
    const before = a.roster().map(p => [p.name, p.colour]);
    b.send({ t: 'profile', car: '2024-red-bull' });
    await a.wait(() => a.roster()[1].car === '2024-red-bull');
    assert.deepStrictEqual(a.roster().map(p => [p.name, p.colour]), before, 'name and colour kept when left out');
    await sleep(120);                                                              // past the coalescing window
    const n = a.all('players').length;
    for (const bad of ['', 'X', '2024-Ferrari', 'a b', 'x'.repeat(41), '2024_ferrari', '../etc', '2024-ferrari\n', '<b>', 'ｆｅｒｒａｒｉ',
      5, null, {}, ['2024-ferrari'], true]) b.send({ t: 'profile', car: bad });
    b.send('{"t":"profile","car":1e999}'); b.send('{"t":"profile"}');
    await sleep(250);
    assert.strictEqual(a.all('players').length, n, 'nothing changed, nothing broadcast');
    assert.strictEqual(srv.info().players[1].car, '2024-red-bull');
    // the longest id; name, colour and car at once
    const long = 'a'.repeat(35) + '-2c-d';
    assert.strictEqual(long.length, 40);
    b.send({ t: 'profile', name: 'Bobby', colour: '#00FF00', car: long });
    await a.wait(() => a.roster()[1].car === long);
    assert.deepStrictEqual([a.roster()[1].name, a.roster()[1].colour], ['Bobby', '#00ff00']);
    b.send({ t: 'profile', car: long + 'x' });
    await sleep(150);
    assert.strictEqual(srv.info().players[1].car, long);
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  lane = lanes.year;                           // the year's rate limit runs on real time: these tests wait a lot
  T('room year: host only, a whole 2010..2100, in welcome and every players message, rate-limited, stays with the room', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: 'Host' }), b = await client(srv.port, { name: 'Guest' });
    assert.strictEqual(a.last('welcome').year, null, 'no year until the host picks one');
    await b.wait(() => b.last('players'));
    assert.strictEqual(b.last('players').year, null);
    b.send({ t: 'year', y: 2020 });                                               // not the host
    for (const bad of [2009, 2101, 2024.5, '2024', null, {}, [2024], true, -2024, 0]) a.send({ t: 'year', y: bad });
    a.send('{"t":"year","y":1e999}'); a.send({ t: 'year' }); a.send({ t: 'YEAR', y: 2020 }); a.send({ t: 'year', year: 2020 });
    await sleep(200);
    assert.strictEqual(srv.info().year, null, 'all refused');
    a.send({ t: 'year', y: 2024 });
    await b.wait(() => b.rosterMsg().year === 2024);
    assert.strictEqual(srv.info().year, 2024);
    await a.wait(() => a.rosterMsg().year === 2024, 1000, 'the host hears it too');
    // every later roster carries it, and a newcomer gets it in its welcome
    b.send({ t: 'profile', name: 'G2' });
    await a.wait(() => a.roster()[1].name === 'G2');
    assert.strictEqual(a.last('players').year, 2024);
    const c = await client(srv.port, { name: 'Late' });
    assert.strictEqual(c.last('welcome').year, 2024);
    // a host scrolling through the seasons: the first pick right away, then only the last one, a second later
    await sleep(1050);
    const t0 = Date.now(), n = c.all('players').length;
    for (let y = 2010; y <= 2026; y++) a.send({ t: 'year', y });
    await c.wait(() => c.rosterMsg().year === 2026, 3000, 'the last pick');
    assert(Date.now() - t0 >= 700, 'not before a second has passed since the previous change: ' + (Date.now() - t0));
    const seen = c.all('players').slice(n).map(m => m.year).filter((y, i, l) => i === 0 || y !== l[i - 1]);
    assert.deepStrictEqual(seen, [2010, 2026], 'two changes, not seventeen');
    // a pick equal to the current year cancels one that is still waiting
    a.send({ t: 'year', y: 2011 }); a.send({ t: 'year', y: 2026 });
    await sleep(1250);
    assert.strictEqual(srv.info().year, 2026);
    // the pick of a host who leaves dies with him; the year itself stays with the room
    a.send({ t: 'year', y: 2012 });                                               // applied at once (the window is over)
    await c.wait(() => c.rosterMsg().year === 2012);
    a.send({ t: 'year', y: 2015 });                                               // waits...
    a.ws.close();                                                                 // ...and its host is gone
    await c.wait(() => c.host() === b.id);
    await sleep(1150);
    assert.deepStrictEqual([srv.info().year, c.rosterMsg().year, b.rosterMsg().year], [2012, 2012, 2012]);
    b.send({ t: 'year', y: 2013 });                                               // the new host picks
    await c.wait(() => c.rosterMsg().year === 2013);
    b.ws.close();
    await c.wait(() => c.host() === c.id);
    assert.strictEqual(c.rosterMsg().year, 2013);
    c.ws.close();
    await until(() => srv.info().players.length === 0, 2000, 'empty room');
    const d = await client(srv.port, { name: 'Next' });
    assert.deepStrictEqual([d.last('welcome').year, d.last('welcome').host], [2013, d.id], 'an empty room keeps its year');
    d.ws.close();

    // in-game (token) server: without its host nobody can change the year
    const s2 = await t.start({ hostToken: 'tok' });
    const h = await client(s2.port, { name: 'H', token: 'tok' }), g = await client(s2.port, { name: 'G' });
    g.send({ t: 'year', y: 2018 });
    h.send({ t: 'year', y: 2019 });
    await g.wait(() => g.rosterMsg().year === 2019);
    h.ws.close();
    await g.wait(() => g.host() === 0);
    g.send({ t: 'year', y: 2020 });
    await sleep(150);
    assert.deepStrictEqual([s2.info().year, g.rosterMsg().year], [2019, 2019]);
    g.ws.close();
  });

  /* ---------- Grand Prix over the wire (manual clock) ---------- */
  lane = lanes.gp1;

  T('clock: welcome.now, pong.s and gp.now are the server clock (opts.now)', async t => {
    const clk = manualClock(4102444800000);                     // the year 2100: nothing reads Date.now() behind our back
    const srv = await t.start({ now: clk });
    const a = await client(srv.port);
    assert.strictEqual(a.last('welcome').now, clk());
    await a.wait(() => a.last('gp'));
    assert.strictEqual(a.last('gp').now, clk(), 'the session state follows the welcome');
    assert.deepStrictEqual([a.gp().phase, a.gp().sid, a.gp().players.map(p => p.id)], ['free', 0, [a.id]]);
    clk.add(1234);
    a.send({ t: 'ping', c: 987654.321 });
    await a.wait(() => a.last('pong'));
    assert.deepStrictEqual(a.last('pong'), { t: 'pong', c: 987654.321, s: clk() });
    assert.strictEqual(srv.info().now, clk());
    // a ping without a usable stamp is not answered
    for (const c of ['x', null, {}, [1], true]) a.send({ t: 'ping', c });
    a.send('{"t":"ping","c":1e999}'); a.send('{"t":"ping"}');
    await sleep(100);
    assert.strictEqual(a.all('pong').length, 1);
    a.ws.close();
  });

  T('Grand Prix: only the host controls it, and only once the room has a track', async t => {
    const clk = manualClock();
    const srv = await t.start({ now: clk, random: () => 0 });
    const a = await client(srv.port), b = await client(srv.port);
    const cfg = { q: 1, r: 1, len: LEN };
    a.send(Object.assign({ t: 'gp', a: 'start' }, cfg));         // host, but no track yet
    await sleep(150);
    assert.strictEqual(srv.info().gp.phase, 'free', 'start is refused without a track');
    a.send({ t: 'track', id: 'monza' });
    await b.wait(() => b.last('track'));
    for (const act of ['start', 'skip', 'end', 'again']) b.send(Object.assign({ t: 'gp', a: act }, cfg));
    await sleep(150);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().gp.sid], ['free', 0], 'a guest cannot start');
    a.send(Object.assign({ t: 'gp', a: 'start' }, cfg));
    let g = await settle(srv, [a, b], s => s.phase === 'quali');
    assert.deepStrictEqual([g.sid, g.q, g.r, g.len], [1, 1, 1, LEN]);
    for (const act of ['skip', 'end', 'again', 'start']) b.send(Object.assign({ t: 'gp', a: act }, cfg));
    await sleep(150);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().gp.sid], ['quali', 1], 'a guest cannot skip / end / restart');
    a.send({ t: 'gp', a: 'again' });                             // only from the results
    await sleep(120);
    assert.strictEqual(srv.info().gp.phase, 'quali');
    a.send({ t: 'gp', a: 'skip' });
    g = await settle(srv, [a, b], s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [a.id, b.id], 'no times: join order');
    a.send({ t: 'gp', a: 'skip' });                              // only in qualifying
    b.send({ t: 'gp', a: 'end' });
    await sleep(120);
    assert.strictEqual(srv.info().gp.phase, 'grid');
    clk.to(g.goAt);
    await settle(srv, [a, b], s => s.phase === 'race');
    b.send({ t: 'gp', a: 'end' });
    await sleep(120);
    assert.strictEqual(srv.info().gp.phase, 'race');
    a.send({ t: 'gp', a: 'end' });                               // the host ends the race: results as they stand
    g = await settle(srv, [a, b], s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [a.id, b.id]);
    b.send({ t: 'gp', a: 'again' }); b.send({ t: 'gp', a: 'end' });
    await sleep(120);
    assert.strictEqual(srv.info().gp.phase, 'results');
    a.send({ t: 'gp', a: 'again' });
    g = await settle(srv, [a, b], s => s.phase === 'quali');
    assert.strictEqual(g.sid, 2);
    a.send({ t: 'gp', a: 'end' });
    await settle(srv, [a, b], s => s.phase === 'free');
    // lap counts are clamped to 1..20 / 1..99, missing ones default to 3 / 5; a start in mid-session restarts it
    a.send({ t: 'gp', a: 'start', q: 1e9, r: -5, len: LEN });
    g = await settle(srv, [a, b], s => s.phase === 'quali');
    assert.deepStrictEqual([g.sid, g.q, g.r], [3, 20, 1]);
    a.send({ t: 'gp', a: 'start', q: 2.4, len: 99999.5 });
    g = await settle(srv, [a, b], s => s.sid === 4);
    assert.deepStrictEqual([g.phase, g.q, g.r, g.len], ['quali', 2, 5, 99999.5]);
    a.ws.close(); b.ws.close();
  });

  T('Grand Prix: full flow quali -> grid -> race -> results -> again -> end, three clients, consistent snapshots', async t => {
    const R = await room(t, 3);
    const [a, b, c] = R.cs, clk = R.clk;
    let g = await R.start(2, 2);
    assert.deepStrictEqual([g.sid, g.q, g.r, g.len, g.lightsAt, g.goAt], [1, 2, 2, LEN, 0, 0]);
    assert.deepStrictEqual(g.players.map(p => [p.id, p.spec, p.left, p.qLaps, p.qBest, p.qDone]), [a, b, c].map(x => [x.id, false, false, 0, null, false]));
    assert.deepStrictEqual(g.order, [a.id, b.id, c.id]);
    assert.strictEqual(a.last('gp').now, clk());

    // qualifying, first laps
    clk.add(3000);
    a.lap(2.9); b.lap(2.5); c.lap(2.7);
    g = await R.settle(s => s.players.every(p => p.qLaps === 1));
    assert.deepStrictEqual(g.order, [b.id, c.id, a.id]);
    assert.deepStrictEqual(g.players.map(p => p.qBest), [2.9, 2.5, 2.7]);
    // second laps: a improves to the best time; the session waits for the last driver
    clk.add(3000);
    a.lap(2.4); b.lap(2.6);
    g = await R.settle(s => s.players.filter(p => p.qDone).length === 2);
    assert.deepStrictEqual([g.phase, g.order], ['quali', [a.id, b.id, c.id]]);
    c.lap(2.45);
    g = await R.settle(s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [a.id, c.id, b.id], '2.4 < 2.45 < 2.5');
    assert.deepStrictEqual(g.order, g.grid);

    // the start lights are on the server clock
    const gm = a.last('gp');
    assert.strictEqual(gm.now, clk());
    assert.strictEqual(g.lightsAt, gm.now + 4000, 'first light 4 s after the grid forms');
    assert.strictEqual(g.goAt, g.lightsAt + 5500, 'five lights one second apart + the hold (0.5 s with random = 0)');
    assert(gm.now < g.lightsAt && g.lightsAt < g.goAt);
    a.lap(2.5);                                                  // no laps on the grid
    await a.wait(() => a.last('glno'));
    assert.strictEqual(a.last('glno').why, 'no-session');
    clk.to(g.goAt - 1);
    await sleep(250);
    assert.strictEqual(srv_phase(R), 'grid', '1 ms before lights out');
    clk.to(g.goAt);
    g = await R.settle(s => s.phase === 'race');
    assert.strictEqual(a.last('gp').now, g.goAt);
    assert.deepStrictEqual(g.order, [a.id, c.id, b.id], 'grid order until the cars report progress');

    // live order from the progress that rides on the car state (as far as the path driven since lights out backs it)
    a.run(100, 0.30); c.run(100, 0.50); b.run(100, 0.10);
    g = await R.settle(s => s.order[0] === c.id);
    assert.deepStrictEqual(g.order, [c.id, a.id, b.id]);
    // lap 1
    clk.add(3000);
    c.lap(2.9); a.lap(2.95); b.lap(3.0);
    g = await R.settle(s => s.players.every(p => p.rLaps === 1));
    assert.deepStrictEqual(g.order, [c.id, a.id, b.id]);
    assert.deepStrictEqual(g.players.map(p => p.gap), [0.05, 0.1, null]);
    assert.deepStrictEqual([g.winnerAt, g.endsAt], [0, 0]);
    // lap 2: c wins, a follows, the race stays open for b
    clk.add(3000);
    c.lap(3.0);
    g = await R.settle(s => s.winnerAt > 0);
    assert.deepStrictEqual([g.phase, g.winnerAt, g.endsAt], ['race', clk(), clk() + RACE_TIMEOUT_MS]);
    a.lap(3.0);
    g = await R.settle(s => s.players.filter(p => p.fin).length === 2);
    assert.strictEqual(g.phase, 'race');
    c.lap(3.0);                                                  // the winner is done
    await c.wait(() => c.last('glno'));
    assert.strictEqual(c.last('glno').why, 'done');
    clk.add(500);
    b.lap(3.4);
    g = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [c.id, a.id, b.id]);
    assert.deepStrictEqual(g.players.map(p => [p.id, p.fin, p.dnf, p.rLaps, p.rTime, p.rBest, p.gap, p.down]),
      [[a.id, true, false, 2, 5.95, 2.95, 0.05, 0], [b.id, true, false, 2, 6.4, 3, 0.5, 0], [c.id, true, false, 2, 5.9, 2.9, null, 0]]);
    assert.deepStrictEqual(g.players.map(p => p.qBest), [2.4, 2.5, 2.45], 'qualifying times are kept for the results');

    // again -> a new session, everything reset; end -> free practice
    a.send({ t: 'gp', a: 'again' });
    g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual([g.sid, g.q, g.r, g.grid, g.winnerAt, g.endsAt, g.goAt], [2, 2, 2, [], 0, 0, 0]);
    assert(g.players.every(p => p.qLaps === 0 && p.qBest === null && !p.qDone && p.rLaps === 0 && p.rTime === 0 && !p.fin));
    b.lap(3, 1);                                                 // a lap of the previous session: not ours, no answer
    await sleep(120);
    assert.strictEqual(b.all('glno').length, 0);
    assert.strictEqual(srv_gp(R).players.find(p => p.id === b.id).qLaps, 0);
    a.send({ t: 'gp', a: 'end' });
    g = await R.settle(s => s.phase === 'free');
    assert.deepStrictEqual([g.sid, g.players.map(p => p.spec)], [2, [false, false, false]]);
    // every gp message any client ever got carried a well-formed snapshot
    for (const x of R.cs) for (const m of x.all('gp')) {
      assert(Number.isFinite(m.now) && m.s && Array.isArray(m.s.players) && Array.isArray(m.s.grid) && Array.isArray(m.s.order));
    }
    R.cs.forEach(x => x.ws.close());
  });
  function srv_gp(R) { return R.srv.info().gp; }
  function srv_phase(R) { return R.srv.info().gp.phase; }

  T('Grand Prix: joining during qualifying = driver; during grid / race / results = spectator until the next session', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    await R.start(1, 1);
    const q = await client(R.srv.port, { name: 'InQuali' });     // takes part, and qualifying waits for them
    R.cs.push(q);
    let g = await R.settle(s => s.players.length === 3);
    assert.strictEqual(g.players[2].spec, false);
    R.clk.add(3000);
    a.lap(2.5); b.lap(2.6);
    g = await R.settle(s => s.players.filter(p => p.qDone).length === 2);
    assert.strictEqual(g.phase, 'quali');
    q.lap(2.4);
    g = await R.settle(s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [q.id, a.id, b.id]);

    const s1 = await client(R.srv.port, { name: 'OnGrid' });
    R.cs.push(s1);
    g = await R.settle(s => s.players.length === 4);
    assert.deepStrictEqual([g.players[3].id, g.players[3].spec, g.grid, g.order], [s1.id, true, [q.id, a.id, b.id], [q.id, a.id, b.id]]);
    assert.strictEqual(s1.gp().phase, 'grid', 'the newcomer is told the phase at once');
    R.clk.to(g.goAt);
    await R.settle(s => s.phase === 'race');
    const s2 = await client(R.srv.port, { name: 'InRace' });
    R.cs.push(s2);
    g = await R.settle(s => s.players.length === 5);
    assert.deepStrictEqual([g.players[4].spec, g.order], [true, [q.id, a.id, b.id]]);
    // a spectator's laps and progress do not count
    R.clk.add(3000);
    s2.lap(2.5); s2.drive(0, 0, 0.99);
    await s2.wait(() => s2.last('glno'));
    assert.strictEqual(s2.last('glno').why, 'not-racing');
    // the race does not wait for spectators
    q.lap(2.5); a.lap(2.6); b.lap(2.7);
    g = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [q.id, a.id, b.id]);
    const s3 = await client(R.srv.port, { name: 'InResults' });
    R.cs.push(s3);
    g = await R.settle(s => s.players.length === 6);
    assert.deepStrictEqual(g.players.map(p => p.spec), [false, false, false, true, true, true]);
    // the next session is for everybody
    a.send({ t: 'gp', a: 'again' });
    g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual(g.players.map(p => p.spec), [false, false, false, false, false, false]);
    assert.strictEqual(g.order.length, 6);
    R.cs.forEach(x => x.ws.close());
  });

  T('Grand Prix: a driver leaving during the race is DNF; slots and ids are not confused; leaving later changes nothing', async t => {
    const R = await room(t, 3);
    const [a, b, c] = R.cs;
    await R.start(1, 2);
    let g = await R.toRace();
    assert.deepStrictEqual(g.grid, [a.id, b.id, c.id]);
    R.clk.add(3000);
    a.lap(2.5); b.lap(2.4); c.lap(2.6);                          // b leads
    g = await R.settle(s => s.players.every(p => p.rLaps === 1));
    assert.deepStrictEqual(g.order, [b.id, a.id, c.id]);
    const bSlot = a.roster().find(p => p.id === b.id).slot;
    b.ws.close();
    g = await R.settle(s => s.players.some(p => p.left));
    assert.strictEqual(g.phase, 'race');
    assert.deepStrictEqual(g.players.map(p => [p.id, p.left, p.dnf, p.rLaps]), [[a.id, false, false, 1], [b.id, true, true, 1], [c.id, false, false, 1]]);
    assert.deepStrictEqual(g.order, [a.id, c.id, b.id], 'DNF goes to the back, but stays classified');
    assert.deepStrictEqual(g.grid, [a.id, b.id, c.id]);
    await a.wait(() => a.roster().length === 2);
    // somebody takes the free slot: a new id, a spectator, nothing to do with the DNF row
    const d = await client(R.srv.port, { name: 'New' });
    R.cs.push(d);
    g = await R.settle(s => s.players.length === 4);
    assert.strictEqual(d.last('welcome').players.find(p => p.id === d.id).slot, bSlot);
    assert(d.id > c.id);
    assert.deepStrictEqual(g.players.map(p => [p.id, p.left, p.spec]), [[a.id, false, false], [b.id, true, false], [c.id, false, false], [d.id, false, true]]);
    // the race ends without the leaver
    R.clk.add(3000);
    a.lap(2.5);
    await R.settle(s => s.winnerAt > 0);
    c.lap(2.6);
    g = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [a.id, c.id, b.id]);
    const frozen = JSON.stringify(g.order);
    // leaving during the results: the row stays as it is
    c.ws.close();
    g = await R.settle(s => s.players.filter(p => p.left).length === 2);
    assert.strictEqual(JSON.stringify(g.order), frozen);
    const row = g.players.find(p => p.id === c.id);
    assert.deepStrictEqual([row.left, row.dnf, row.fin, row.rLaps], [true, false, true, 2], 'a finisher who leaves stays a finisher');
    // the host and the spectator leave too: the room is empty and the session is over
    a.ws.close(); d.ws.close();
    await until(() => R.srv.info().players.length === 0 && R.srv.info().gp.phase === 'free', 2000, 'empty room -> free');
    assert.strictEqual(R.srv.info().gp.players.length, 0);
    // the next visitor finds a normal room and can run a Grand Prix
    const e = await client(R.srv.port, { name: 'Next' });
    assert.strictEqual(e.last('welcome').host, e.id);
    e.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    await e.wait(() => e.gp() && e.gp().phase === 'quali');
    assert.deepStrictEqual([e.gp().sid, e.gp().players.map(p => p.id)], [2, [e.id]]);
    e.ws.close();
  });

  T('Grand Prix: lights out and the race timeout are applied before a lap or a leaver is judged', async t => {
    const R = await room(t, 3);
    const [a, b, c] = R.cs;
    await R.start(1, 1);
    let g = await R.toGrid();
    // the clock passes goAt and, before the server's next tick, a lap arrives and a driver disconnects
    R.clk.to(g.goAt + 3000);
    a.lap(2.5);
    c.ws.close();
    g = await R.settle(s => s.players.some(p => p.left));
    assert.deepStrictEqual(g.players.map(p => [p.id, p.rLaps, p.fin, p.left, p.dnf]),
      [[a.id, 1, true, false, false], [b.id, 0, false, false, false], [c.id, 0, false, true, true]],
      'the lap counted as the first race lap; the leaver is DNF, not removed from a grid');
    assert.strictEqual(a.all('glno').length, 0);
    assert.strictEqual(g.phase, 'race');
    // same at the other end: the 90 s are over, then a lap arrives
    R.clk.to(g.endsAt);
    b.lap(2.6);
    await b.wait(() => b.last('glno'));
    assert.strictEqual(b.last('glno').why, 'no-session', 'too late: the race is closed');
    g = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [a.id, b.id, c.id]);
    assert.deepStrictEqual(g.players.map(p => [p.fin, p.dnf]), [[true, false], [false, false], [false, true]]);
    a.ws.close(); b.ws.close();
  });

  lane = lanes.gp2;
  T('Grand Prix: a track change ends the session and everybody is told before they load the track', async t => {
    const R = await room(t, 3);
    const [a, b, c] = R.cs;
    await R.start(1, 3);
    await R.toRace();
    R.clk.add(3000);
    a.lap(2.5);
    await R.settle(s => s.players[0].rLaps === 1);
    b.send({ t: 'track', id: 'spa' });                           // not the host
    await sleep(120);
    assert.strictEqual(srv_phase(R), 'race');
    a.send({ t: 'track', id: 'spa' });
    const g = await R.settle(s => s.phase === 'free');
    assert.deepStrictEqual([g.sid, g.grid, g.winnerAt, g.players.map(p => p.spec)], [1, [], 0, [false, false, false]]);
    for (const x of R.cs) {
      await x.wait(() => x.last('track').id === 'spa');
      assert.strictEqual(x.last('track').seq, 2);
      const iTrack = x.msgs.lastIndexOf(x.last('track'));
      const iFree = x.msgs.findIndex(m => m.t === 'gp' && m.s.phase === 'free' && m.s.sid === 1);
      assert(iFree >= 0 && iFree < iTrack, 'gp(free) comes before the track message');
    }
    // laps of the old track / the ended session are ignored without an answer
    b.send({ t: 'gl', k: 1, sid: 1, time: 3 });
    await sleep(120);
    assert.strictEqual(b.all('glno').length, 0);
    b.lap(3);                                                    // right track, right sid, but there is no session
    await b.wait(() => b.last('glno'));
    assert.strictEqual(b.last('glno').why, 'no-session');
    // picking a track in every other phase ends the session too (never left hanging in the results)
    for (const phase of ['quali', 'grid', 'results']) {
      a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
      await R.settle(s => s.phase === 'quali');
      if (phase !== 'quali') await R.toGrid();
      if (phase === 'results') {
        R.clk.to(srv_gp(R).goAt); await R.settle(s => s.phase === 'race');
        a.send({ t: 'gp', a: 'end' }); await R.settle(s => s.phase === 'results');
      }
      a.send({ t: 'track', id: 'monza' });
      await R.settle(s => s.phase === 'free');
    }
    assert.strictEqual(srv_gp(R).sid, 4);
    R.cs.forEach(x => x.ws.close());
  });

  T('Grand Prix: rejected laps are answered with glno and the reason, to the sender only', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    await R.start(2, 1);
    const spec = await client(R.srv.port, { name: 'x' });        // joins in qualifying: a driver
    R.cs.push(spec);
    await R.settle(s => s.players.length === 3);
    const why = async (c, time, sid) => {
      const n = c.all('glno').length;
      c.lap(time, sid);
      await c.wait(() => c.all('glno').length > n, 1000, 'glno for ' + JSON.stringify(time));
      return c.last('glno').why;
    };
    R.clk.add(1500);
    assert.strictEqual(await why(b, 2.5), 'too-soon', '1.5 s into the session');
    R.clk.add(1500);
    assert.strictEqual(await why(b, MIN - 0.01), 'too-fast', 'faster than a 330 km/h average');
    assert.strictEqual(await why(b, 5.2), 'inconsistent', 'a 5.2 s lap 3 s into the session');
    for (const bad of ['2.5', null, {}, [2.5], true, -2.5, 0, 3601]) assert.strictEqual(await why(b, bad), 'bad', JSON.stringify(bad));
    b.send('{"t":"gl","k":1,"sid":1,"time":1e999}');
    await b.wait(() => b.all('glno').length === 12);
    assert.strictEqual(b.last('glno').why, 'bad');
    b.send({ t: 'gl', k: 1, sid: 1 });                           // no time at all
    await b.wait(() => b.all('glno').length === 13);
    assert.strictEqual(b.last('glno').why, 'bad');
    assert.strictEqual(srv_gp(R).players[1].qLaps, 0, 'none of that counted');
    b.lap(2.5);
    await R.settle(s => s.players[1].qLaps === 1);
    assert.strictEqual(await why(b, 2.5), 'too-soon', 'two laps in the same instant');
    R.clk.add(3000);
    b.lap(2.6);
    await R.settle(s => s.players[1].qDone);
    assert.strictEqual(await why(b, 2.3), 'done', 'qualifying laps are used up');
    // stale session id / track sequence: not answered at all
    b.lap(2.5, 0); b.lap(2.5, 2); b.lap(2.5, '1'); b.lap(2.5, null); b.lap(2.5, 1.5);
    b.send({ t: 'gl', k: 0, sid: 1, time: 2.5 }); b.send({ t: 'gl', k: '1', sid: 1, time: 2.5 }); b.send({ t: 'gl', sid: 1, time: 2.5 });
    await sleep(150);
    assert.strictEqual(b.all('glno').length, 15);
    // on the grid and as a spectator
    a.send({ t: 'gp', a: 'skip' });
    const g = await R.settle(s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [b.id, a.id, spec.id]);
    assert.strictEqual(await why(a, 2.5), 'no-session');
    const late = await client(R.srv.port, { name: 'late' });
    R.cs.push(late);
    await R.settle(s => s.players.length === 4);
    R.clk.to(g.goAt + 3000);
    await R.settle(s => s.phase === 'race');
    assert.strictEqual(await why(late, 2.5), 'not-racing');
    assert.strictEqual(await why(a, 5.5), 'inconsistent', 'race laps are timed from goAt');
    a.lap(2.5);
    await R.settle(s => s.players[0].fin);
    assert.strictEqual(await why(a, 2.5), 'done');
    // nobody else ever saw a glno
    assert.deepStrictEqual([a.all('glno').length, b.all('glno').length, spec.all('glno').length, late.all('glno').length], [3, 15, 0, 1]);
    R.cs.forEach(x => x.ws.close());
  });

  lane = lanes.year2;
  T('Grand Prix v6: the session races the room year (never a client\'s), wear 1..5, again keeps both; parc fermé', async t => {
    const R = await room(t, 3, { cars: ['2020-ferrari', '2020-mercedes', ''] });
    const [a, b, c] = R.cs;
    await a.wait(() => a.roster().length === 3);
    assert.deepStrictEqual(a.roster().map(p => p.car), ['2020-ferrari', '2020-mercedes', '']);
    // no room year yet: the session has none either, whatever the host names
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN, year: 2024 });
    let g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual([g.sid, g.year, g.wear], [1, null, 1]);
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    a.send({ t: 'year', y: 2020 });
    await c.wait(() => c.rosterMsg().year === 2020);
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN, year: 1999, wear: 3 });
    g = await R.settle(s => s.sid === 2);
    assert.deepStrictEqual([g.phase, g.year, g.wear], ['quali', 2020, 3], 'the room year, the wear asked for');

    // while a session is on: no year change, no car change (name and colour still change)
    a.send({ t: 'year', y: 2021 });
    b.send({ t: 'profile', name: 'Bee', colour: '#123456', car: '2021-mercedes' });
    await a.wait(() => a.roster()[1].name === 'Bee');
    assert.deepStrictEqual([a.roster()[1].colour, a.roster()[1].car], ['#123456', '2020-mercedes']);
    await sleep(120);
    const n = a.all('players').length;
    b.send({ t: 'profile', car: '2021-mercedes' });                              // a car change alone: nothing at all
    await sleep(1150);                                                           // longer than the year's rate limit
    assert.deepStrictEqual([R.srv.info().year, a.rosterMsg().year, R.srv.info().players[1].car, a.all('players').length], [2020, 2020, '2020-mercedes', n]);
    // ...but whoever joins mid-session keeps the car he announces
    const d = await client(R.srv.port, { name: 'Late', car: '2020-williams' });
    R.cs.push(d);
    await R.settle(s => s.players.length === 4);
    assert.strictEqual(d.last('welcome').players.find(p => p.id === d.id).car, '2020-williams');
    await a.wait(() => a.roster().length === 4 && a.roster()[3].car === '2020-williams');

    // grid, race, results, again: the same year and wear throughout
    g = await R.toGrid();
    assert.deepStrictEqual([g.year, g.wear], [2020, 3]);
    R.clk.to(g.goAt);
    g = await R.settle(s => s.phase === 'race');
    assert.deepStrictEqual([g.year, g.wear], [2020, 3]);
    a.send({ t: 'gp', a: 'end' });
    g = await R.settle(s => s.phase === 'results');
    a.send({ t: 'year', y: 2022 });                                              // the results are still a session
    b.send({ t: 'profile', car: '2021-mercedes' });
    a.send({ t: 'gp', a: 'again' });
    g = await R.settle(s => s.sid === 3);
    assert.deepStrictEqual([g.phase, g.year, g.wear], ['quali', 2020, 3], 'again: the same year and wear');
    assert.deepStrictEqual([R.srv.info().year, R.srv.info().players[1].car], [2020, '2020-mercedes']);

    // free practice again: the year and the cars can change
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    b.send({ t: 'profile', car: '2021-mercedes' });
    a.send({ t: 'year', y: 2021 });
    await c.wait(() => c.rosterMsg().year === 2021 && c.roster()[1].car === '2021-mercedes', 3000, 'year and car after the session');

    // wear over the wire: clamped / rounded like the lap counts, the default when it is not a number
    let sid = R.srv.info().gp.sid;
    for (const [w, want] of [[9, 5], [0, 1], [2.6, 3], ['3', 1], [undefined, 1], [null, 1], [5, 5], [1, 1]]) {
      a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN, wear: w });
      g = await R.settle(s => s.sid === sid + 1);
      sid++;
      assert.strictEqual(g.wear, want, JSON.stringify(w));
    }
    for (const w of ['1e999', '-1e999', '{}', '[4]', 'true']) {
      a.send('{"t":"gp","a":"start","q":1,"r":1,"len":' + LEN + ',"wear":' + w + '}');
      g = await R.settle(s => s.sid === sid + 1);
      sid++;
      assert.strictEqual(g.wear, 1, w);
    }

    // a year pick still waiting for the rate limit goes with the start (it is the host's latest word)
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    a.send({ t: 'year', y: 2016 }); a.send({ t: 'year', y: 2017 });             // at least 2017 waits (2021 was just set)
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    g = await R.settle(s => s.sid === sid + 1);
    assert.deepStrictEqual([g.phase, g.year, R.srv.info().year], ['quali', 2017, 2017]);
    await c.wait(() => c.rosterMsg().year === 2017);
    await sleep(1150);
    assert.deepStrictEqual([R.srv.info().year, c.rosterMsg().year], [2017, 2017], 'and nothing is applied later');
    // a guest's start (refused) takes no year with it either
    b.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN, wear: 4 });
    await sleep(120);
    assert.deepStrictEqual([R.srv.info().gp.sid, R.srv.info().gp.wear], [sid + 1, 1]);
    R.cs.forEach(x => x.ws.close());
  });

  lane = lanes.gp3;
  T('Grand Prix: garbage / wrong-type / oversized gp, gl, ping and progress never change state or crash', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    const junk = [
      '{"t":"gp"}', '{"t":"gp","a":5}', '{"t":"gp","a":null}', '{"t":"gp","a":["start"]}', '{"t":"gp","a":{"a":"start"}}',
      '{"t":"gp","a":"nuke"}', '{"t":"gp","a":"__proto__"}', '{"t":"gp","a":"constructor"}', '{"t":"gp","a":"toString"}', '{"t":"gp","a":"START"}',
      '{"t":"gp","a":"start"}', '{"t":"gp","a":"start","q":1,"r":1}', '{"t":"gp","a":"start","q":"x","r":{},"len":"200"}',
      '{"t":"gp","a":"start","q":1e999,"r":-1e999,"len":1e999}', '{"t":"gp","a":"start","len":-1e999}', '{"t":"gp","a":"start","len":199}',
      '{"t":"gp","a":"start","len":100001}', '{"t":"gp","a":"start","len":null}', '{"t":"gp","a":"start","len":[200]}', '{"t":"gp","a":"start","len":{"valueOf":1}}',
      '{"t":"gp","a":"start","len":true}', '{"t":"GP","a":"start","q":1,"r":1,"len":200}',
      '{"t":"gl"}', '{"t":"gl","k":1}', '{"t":"gl","k":1,"sid":{}}', '{"t":"gl","k":[1],"sid":[0],"time":3}', '{"t":"gl","k":1e999,"sid":1e999,"time":3}',
      '{"t":"gl","k":null,"sid":null,"time":null}', '{"t":"gl","k":1,"sid":"0","time":3}',
      '{"t":"ping"}', '{"t":"ping","c":"x"}', '{"t":"ping","c":null}', '{"t":"ping","c":1e999}', '{"t":"ping","c":{}}', '{"t":"ping","c":[]}',
      '{"t":"s","k":1,"c":1,"s":[0,0,0,0,0,0,0,0],"g":"x"}', '{"t":"s","k":1,"c":1,"s":[0,0,0,0,0,0,0,0],"g":1e999}',
      '{"t":"s","k":1,"c":1,"s":[0,0,0,0,0,0,0,0],"g":{}}', '{"t":"s","k":1,"c":1,"s":[0,0,0,0,0,0,0,0],"g":-1e308}', '{"t":"s","k":1,"c":1,"s":"x","g":0.5}'
    ];
    const check = async (label, expectGlno) => {
      const before = JSON.stringify(srv_gp(R));
      const n = [a.all('glno').length, b.all('glno').length, a.all('pong').length, b.all('pong').length];
      for (const j of junk) { a.send(j); b.send(j); }
      await sleep(200);
      const after = srv_gp(R);
      if (after.phase === 'race') {                               // only the clamped progress of a driver may have moved the order
        const x = JSON.parse(before);
        assert.deepStrictEqual(Object.assign({}, after, { order: 0 }), Object.assign({}, x, { order: 0 }), label);
        assert.deepStrictEqual(after.order.slice().sort(), x.order.slice().sort(), label);
      } else assert.strictEqual(JSON.stringify(after), before, label + ': state changed');
      assert.deepStrictEqual([a.all('glno').length - n[0], b.all('glno').length - n[1]], [expectGlno, expectGlno], label + ': glno');
      assert.deepStrictEqual([a.all('pong').length - n[2], b.all('pong').length - n[3]], [0, 0], label + ': pong');
      assert.strictEqual(a.closed || b.closed, null, label + ': junk alone does not get you kicked');
    };
    await check('free', 0);
    // '{"t":"gl","k":1,"sid":"0"...}' and friends never match; with sid 1 running, none of the junk has k 1 + sid 1
    await R.start(1, 2);
    await check('quali', 0);
    await R.toGrid();
    await check('grid', 0);
    R.clk.to(srv_gp(R).goAt);
    await R.settle(s => s.phase === 'race');
    await check('race', 0);
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'results');
    await check('results', 0);
    // a well-formed lap with a garbage time IS answered (and changes nothing)
    a.send({ t: 'gp', a: 'again' });
    await R.settle(s => s.phase === 'quali');
    const before = JSON.stringify(srv_gp(R));
    b.send('{"t":"gl","k":1,"sid":2,"time":"fast"}'); b.send('{"t":"gl","k":1,"sid":2,"time":[1,2,3]}');
    await b.wait(() => b.all('glno').length === 2);
    assert.strictEqual(JSON.stringify(srv_gp(R)), before);
    // oversized: the socket is closed by the size limit, the room lives on
    b.send(JSON.stringify({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN, pad: 'x'.repeat(3000) }));
    await b.wait(() => b.closed);
    assert.strictEqual(b.closed.code, 1009);
    const g = await settle(R.srv, [a], s => s.players.length === 1);
    assert.strictEqual(g.phase, 'quali');
    a.send({ t: 'ping', c: 5 });
    await a.wait(() => a.last('pong'));
    a.ws.close();
  });

  T('Grand Prix: the host leaving. Dedicated server: the next player controls; token server: nobody does, the session runs on', async t => {
    // dedicated: the role migrates, in every phase
    let R = await room(t, 3);
    let [a, b, c] = R.cs;
    await R.start(1, 1);
    a.ws.close();
    let g = await R.settle(s => s.players.length === 2);
    assert.strictEqual(g.phase, 'quali');
    await c.wait(() => c.host() === b.id);
    c.send({ t: 'gp', a: 'skip' });
    await sleep(120);
    assert.strictEqual(srv_phase(R), 'quali', 'not the new host');
    b.send({ t: 'gp', a: 'skip' });
    g = await R.settle(s => s.phase === 'grid');
    R.clk.to(g.goAt);
    await R.settle(s => s.phase === 'race');
    b.ws.close();                                                // the host leaves the race: DNF, and c takes over
    g = await R.settle(s => s.players.some(p => p.left));
    await c.wait(() => c.host() === c.id);
    assert.deepStrictEqual([g.phase, g.players.map(p => [p.id, p.dnf])], ['race', [[b.id, true], [c.id, false]]]);
    c.send({ t: 'gp', a: 'end' });
    g = await R.settle(s => s.phase === 'results');
    c.send({ t: 'gp', a: 'again' });
    g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual(g.players.map(p => p.id), [c.id]);
    c.ws.close();

    // in-game (token) server: a guest never becomes host; without the host the session still runs to its end
    R = await room(t, 3, { hostToken: 'tok' });
    [a, b, c] = R.cs;
    assert.strictEqual(b.host(), a.id);
    b.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    await sleep(120);
    assert.strictEqual(srv_phase(R), 'free');
    await R.start(1, 1);
    a.ws.close();
    g = await R.settle(s => s.players.length === 2);
    await b.wait(() => b.host() === 0);
    for (const act of ['skip', 'end', 'again', 'start']) { b.send({ t: 'gp', a: act, q: 1, r: 1, len: LEN }); c.send({ t: 'gp', a: act, q: 1, r: 1, len: LEN }); }
    b.send({ t: 'track', id: 'spa' });
    await sleep(150);
    assert.deepStrictEqual([srv_phase(R), R.srv.info().track, R.srv.info().host], ['quali', 'monza', 0]);
    g = await R.toRace();                                        // the drivers finish qualifying themselves
    assert.deepStrictEqual(g.grid, [b.id, c.id]);
    R.clk.add(3000);
    b.lap(2.5); c.lap(2.6);
    g = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [b.id, c.id]);
    b.ws.close(); c.ws.close();
    await until(() => R.srv.info().gp.phase === 'free', 2000, 'empty room -> free');
  });

  T('Grand Prix: impact reports follow the ghost rule (none in qualifying / while the grid forms / with spectators)', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    let sent = 0;
    const hit = async (from, to, expected, label) => {
      const n = to.all('hit').length;
      // fresh positions: from drives at 20 m/s along +x into to, parked 6 m ahead (from does not jump)
      to.drive(from.px + 6, from.pz); from.drive(from.px, from.pz, undefined, 20, Math.PI / 2);
      await sleep(50);                                           // the 40 ms throttle
      from.send({ t: 'hit', k: from.seq(), to: to.id, i: [++sent, 0] });
      if (expected) { await to.wait(() => to.all('hit').length === n + 1, 1000, label); assert.strictEqual(to.last('hit').i[0], sent, label); }
      else { await sleep(100); assert.strictEqual(to.all('hit').length, n, label); }
    };
    a.drive(0, 0); b.drive(6, 0);
    await sleep(60);
    await hit(a, b, true, 'free practice');
    await R.start(1, 1);
    a.drive(0, 0); b.drive(6, 0);
    await sleep(60);
    await hit(a, b, false, 'qualifying');
    const g = await R.toGrid();
    await hit(a, b, false, 'grid being formed');
    R.clk.to(g.lightsAt);
    await hit(a, b, true, 'lights on');
    const s = await client(R.srv.port, { name: 'spec' });
    R.cs.push(s);
    await R.settle(x => x.players.length === 3);
    s.drive(3, 0);
    await sleep(60);
    R.clk.to(g.goAt);
    await R.settle(x => x.phase === 'race');
    await hit(b, a, true, 'race, driver to driver');
    await hit(s, a, false, 'spectator to driver');
    await hit(a, s, false, 'driver to spectator');
    a.send({ t: 'gp', a: 'end' }); await R.settle(x => x.phase === 'results');
    a.send({ t: 'gp', a: 'end' }); await R.settle(x => x.phase === 'free');
    await hit(s, a, true, 'free practice again');
    R.cs.forEach(x => x.ws.close());
  });

  T('year / car garbage from host and guest never changes the room, never crashes, never gets you kicked', async t => {
    const R = await room(t, 2, { cars: ['2024-ferrari', ''] });
    const [a, b] = R.cs;
    a.send({ t: 'year', y: 2024 });
    await b.wait(() => b.rosterMsg().year === 2024);
    const junk = ['{"t":"year"}', '{"t":"year","y":"2025"}', '{"t":"year","y":1e999}', '{"t":"year","y":-1e999}', '{"t":"year","y":2025.5}',
      '{"t":"year","y":null}', '{"t":"year","y":[2025]}', '{"t":"year","y":{"valueOf":2025}}', '{"t":"year","y":true}', '{"t":"year","y":2009}',
      '{"t":"year","y":2101}', '{"t":"year","year":2025}', '{"t":"YEAR","y":2025}', '{"t":"year","y":"__proto__"}', '{"t":"year","y":9007199254740993}',
      '{"t":"profile","car":null}', '{"t":"profile","car":5}', '{"t":"profile","car":"X"}', '{"t":"profile","car":["2024-mclaren"]}',
      '{"t":"profile","car":{"length":3}}', '{"t":"profile","car":""}', '{"t":"profile","car":"' + 'a'.repeat(41) + '"}',
      '{"t":"profile","car":"a\\u0000b"}', '{"t":"profile","car":"__proto__"}', '{"t":"profile","car":"2024-mclaren\\n"}',
      '{"t":"profile","car":1e999}', '{"t":"hello","v":1,"name":"again","car":"2024-mclaren"}'];
    const check = async label => {
      const before = JSON.stringify([R.srv.info().year, R.srv.info().players, R.srv.info().gp]);
      await sleep(120);
      const n = [a.all('players').length, b.all('players').length];
      for (const j of junk) { a.send(j); b.send(j); }
      await sleep(250);
      assert.strictEqual(JSON.stringify([R.srv.info().year, R.srv.info().players, R.srv.info().gp]), before, label + ': state changed');
      assert.deepStrictEqual([a.all('players').length - n[0], b.all('players').length - n[1]], [0, 0], label + ': rosters sent');
      assert.strictEqual(a.closed || b.closed, null, label + ': kicked');
    };
    await check('free');
    await R.start(1, 1);
    await check('quali');
    // the valid messages still work afterwards
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    await sleep(1050);
    a.send({ t: 'year', y: 2025 }); b.send({ t: 'profile', car: '2025-mclaren' });
    await b.wait(() => b.rosterMsg().year === 2025 && b.roster()[1].car === '2025-mclaren');
    a.ws.close(); b.ws.close();
  });

  T('full room: 16 drivers, then 15 leavers (DNF rows) + 15 spectators: snapshot sizes stay sane', async t => {
    const clk = manualClock();
    const srv = await t.start({ now: clk, random: () => 1 });
    const name = i => '十六個字的超級長名字車手' + String(i).padStart(4, '0');
    const car = i => (String(2000 + i) + '-' + 'x'.repeat(40)).slice(0, 40);   // the longest car ids there can be
    const cs = [];
    for (let i = 0; i < 16; i++) cs.push(await client(srv.port, { name: name(i), car: car(i) }));
    cs[0].send({ t: 'track', id: 'monza' });
    cs[0].send({ t: 'year', y: 2026 });
    await cs[15].wait(() => cs[15].last('track') && cs[15].rosterMsg().year === 2026);
    cs[0].send({ t: 'gp', a: 'start', q: 1, r: 50, len: LEN, wear: 5 });
    await settle(srv, cs, s => s.phase === 'quali');
    clk.add(3000);
    cs.forEach((c, i) => c.lap(2.5 + i * 0.001));
    let g = await settle(srv, cs, s => s.phase === 'grid');
    assert.strictEqual(g.goAt - g.lightsAt, 7000, 'the longest hold (random = 1)');
    clk.to(g.goAt);
    await settle(srv, cs, s => s.phase === 'race');
    for (let lap = 1; lap <= 3; lap++) {
      clk.add(2345);
      cs.forEach((c, i) => { c.lap(2.345 - i * 0.001); c.drive(i * 8, 0, lap + 0.123 + i * 0.01); });
      await settle(srv, cs, s => s.players.every(p => p.rLaps === lap));
    }
    const size = c => Buffer.byteLength(JSON.stringify(c.last('gp')));
    const full = size(cs[0]);
    assert(full < 4096, 'gp message, 16 drivers: ' + full + ' bytes');
    // everybody but the host leaves, 15 others take their seats as spectators
    for (let i = 1; i < 16; i++) cs[i].ws.close();
    await settle(srv, [cs[0]], s => s.players.filter(p => p.left).length === 15);
    const specs = [];
    for (let i = 0; i < 15; i++) specs.push(await client(srv.port, { name: name(100 + i), car: car(100 + i) }));
    g = await settle(srv, [cs[0]].concat(specs), s => s.players.length === 31);
    assert.deepStrictEqual([g.order.length, g.players.filter(p => p.dnf).length, g.players.filter(p => p.spec).length], [16, 15, 15]);
    assert.deepStrictEqual([g.year, g.wear], [2026, 5]);
    const worst = size(specs[14]);
    assert(worst < 8192, 'gp message, 16 classified + 15 spectators: ' + worst + ' bytes');
    const ros = Buffer.byteLength(JSON.stringify(specs[14].rosterMsg()));
    assert.strictEqual(specs[14].roster().filter(p => p.car.length === 40).length, 16, 'every row carries its car');
    // (2 KB is the limit on what a CLIENT may send; the v6 rows carry a car id of up to 40 characters each)
    assert(ros < 3072, 'roster message, 16 players with the longest names and car ids: ' + ros + ' bytes');
    console.log('     sizes: gp 16 drivers ' + full + ' B, gp 31 rows ' + worst + ' B, roster ' + ros + ' B');
    // the 17th is still refused while the room has 16 PRESENT players, whatever the session remembers
    const x = await client(srv.port, { name: 'late' });
    await x.wait(() => x.closed);
    assert.strictEqual(x.last('error').code, 'full');
    cs[0].ws.close(); specs.forEach(c => c.ws.close());
  });

  /* ---------- js/net.js, the real client ---------- */
  lane = lanes.client;

  T('js/net.js against the real server: Grand Prix calls and events, clock sync, teardown, reconnect', async t => {
    let skew = 3 * 86400000 + 12345;                             // this server's clock is three days ahead of ours
    const srvNow = () => Date.now() + skew;
    const srv = await t.start({ now: srvNow, random: () => 0 });
    const A = freshNet(), B = freshNet();
    const ev = { A: [], B: [] };
    for (const n of ['connected', 'disconnected', 'gp', 'lapRejected', 'track']) {
      A.on(n, x => ev.A.push([n, x])); B.on(n, x => ev.B.push([n, x]));
    }
    assert(Math.abs(A.serverNow() - Date.now()) < 50, 'not in a room: our own clock');
    assert.strictEqual(A.gp('start', { q: 1, r: 1, len: LEN }), false, 'not connected');
    assert.strictEqual(A.sendGpLap(1, 3), false);
    assert.deepStrictEqual(await A.join('127.0.0.1:' + srv.port), { ok: true });
    assert.deepStrictEqual(await B.join('127.0.0.1:' + srv.port), { ok: true });
    assert.deepStrictEqual([A.isHost, B.isHost, A.id > 0, B.id > A.id], [true, false, true, true]);
    await until(() => A.session && B.session && B.session.players.length === 2 && A.session.players.length === 2, 2000, 'first gp');
    assert.deepStrictEqual([B.session.phase, B.session.sid, B.session.grid, B.session.order.length], ['free', 0, [], 2]);
    // clock: within a few ms of the server's after the first pings
    await sleep(450);
    assert(Math.abs(A.serverNow() - srvNow()) < 25, 'serverNow: ' + (A.serverNow() - srvNow()));
    assert(Math.abs(B.serverNow() - srvNow()) < 25, 'serverNow: ' + (B.serverNow() - srvNow()));
    // only the host can act, and only with sane arguments
    assert.strictEqual(B.gp('start', { q: 1, r: 1, len: LEN }), false, 'not the host');
    assert.strictEqual(A.gp('launch'), false);
    assert.strictEqual(A.gp('start', { q: 1, r: 1 }), false, 'no track length');
    assert.strictEqual(A.gp('start', { q: 1, r: 1, len: LEN }), true, 'sent; the server refuses it: no track yet');
    await sleep(150);
    assert.strictEqual(A.session.phase, 'free');
    assert.strictEqual(A.selectTrack('monza'), true);
    await until(() => B.trackId === 'monza' && A.trackId === 'monza', 2000, 'track');
    assert.strictEqual(A.gp('start', { q: 1, r: 1, len: LEN }), true);
    await until(() => A.session.phase === 'quali' && B.session.phase === 'quali', 2000, 'quali');
    const t0 = Date.now();
    A.sendState({ x: 0, z: 0, heading: 0 }, true); B.sendState({ x: 0, z: 0, heading: 0 }, true);   // on track
    assert.deepStrictEqual(A.session, B.session);
    assert(ev.B.some(e => e[0] === 'gp' && e[1] === B.session), 'the gp event carries net.session');
    // laps: rejected ones come back as events, accepted ones as snapshots
    assert.strictEqual(B.sendGpLap(B.session.sid, 1), true);
    await until(() => ev.B.some(e => e[0] === 'lapRejected'), 2000, 'lapRejected');
    assert.deepStrictEqual(ev.B.filter(e => e[0] === 'lapRejected'), [['lapRejected', 'too-fast']]);
    assert.strictEqual(B.sendGpLap(B.session.sid, NaN), false);
    assert.strictEqual(B.sendGpLap('1', 3), false);
    await sleep(2300 - (Date.now() - t0));
    // a lap of the 200 m track driven (the server counts only laps the car states cover), then reported
    A.sendState({ x: 200, z: 0, heading: 0 }, true); B.sendState({ x: 200, z: 0, heading: 0 }, true);
    B.sendGpLap(B.session.sid, 2.2004); A.sendGpLap(A.session.sid, 2.25);
    await until(() => A.session.phase === 'grid' && B.session.phase === 'grid', 2000, 'grid');
    assert.deepStrictEqual(A.session.grid, [B.id, A.id]);
    assert.strictEqual(A.session.players[1].qBest, 2.2);
    const left = A.session.lightsAt - A.serverNow();
    assert(left > 3500 && left <= 4000, 'lights in ' + left + ' ms by the synchronised clock');
    // skip the wait on the server (its clock jumps 9.5 s); the clients hear about the race from the snapshot
    skew += A.session.goAt - srvNow();
    await until(() => A.session.phase === 'race' && B.session.phase === 'race', 2000, 'race');
    // progress rides on the car state; null stops it
    assert.deepStrictEqual(A.session.order, [B.id, A.id], 'grid order');
    // (both cars have driven ~150 m since lights out: the clock jumped 9.5 s, which credits up to 5 s of it)
    A.setProgress(0.5); B.setProgress(0.25);
    A.sendState({ x: 350, z: 0, heading: 0 }, true); B.sendState({ x: 359, z: 0, heading: 0 }, true);
    await until(() => A.session.order[0] === A.id && B.session.order[0] === A.id, 2000, 'order by progress');
    A.setProgress(null); B.setProgress(0.4);                     // A stops reporting: it keeps the 0.5 it had
    A.sendState({ x: 351, z: 0, heading: 0 }, true); B.sendState({ x: 359, z: 0, heading: 0 }, true);
    await sleep(700);
    assert.strictEqual(A.session.order[0], A.id);
    B.setProgress(0.75);
    B.sendState({ x: 359, z: 0, heading: 0 }, true);
    await until(() => A.session.order[0] === B.id, 2000, 'order by progress (2)');
    // B leaves: nothing of the room's Grand Prix stays behind; A sees a DNF
    const bId = B.id;
    B.leave();
    assert.deepStrictEqual([B.connected, B.session, B.id, B.trackId, B.roster.length], [false, null, 0, null, 0]);
    assert(Math.abs(B.serverNow() - Date.now()) < 50, 'clock offset dropped: ' + (B.serverNow() - Date.now()));
    assert.deepStrictEqual(ev.B[ev.B.length - 1], ['disconnected', '已離開房間']);
    await until(() => A.session.players.some(p => p.left), 2000, 'DNF');
    assert.deepStrictEqual(A.session.players.map(p => [p.id, p.left, p.dnf]), [[A.id, false, false], [bId, true, true]]);
    // B comes back: a new id, a spectator; the stale progress is not sent again
    assert.deepStrictEqual(await B.join('127.0.0.1:' + srv.port), { ok: true });
    await until(() => B.session && B.session.players.length === 3, 2000, 'rejoin');
    B.sendState({ x: 9, z: 0, heading: 0 }, true);
    assert.deepStrictEqual(B.session.players[2], Object.assign({}, B.session.players[2], { id: B.id, spec: true, left: false }));
    assert(B.id > bId, 'a new id');
    assert.strictEqual(B.trackId, 'monza');
    // the server goes away: both are told, both are clean
    await srv.close();
    await until(() => !A.connected && !B.connected, 3000, 'disconnected');
    assert.deepStrictEqual(ev.A[ev.A.length - 1], ['disconnected', '連線中斷：房主已關閉房間']);
    assert.deepStrictEqual([A.session, A.id, A.isHost, A.trackId, A.players.length], [null, 0, false, null, 0]);
    assert(Math.abs(A.serverNow() - Date.now()) < 50);
    // a new server on another clock: everything is learnt again
    const back = -10 * 86400000;
    const srv2 = await t.start({ now: () => Date.now() + back });
    assert.deepStrictEqual(await A.join('127.0.0.1:' + srv2.port), { ok: true });
    await until(() => A.session, 2000, 'gp after reconnect');
    assert.deepStrictEqual([A.id, A.isHost, A.trackId, A.session.phase, A.session.sid, A.session.players.length], [1, true, null, 'free', 0, 1]);
    await sleep(100);
    assert(Math.abs(A.serverNow() - (Date.now() + back)) < 25, 'serverNow after reconnect: ' + (A.serverNow() - (Date.now() + back)));
    A.leave();
    assert.strictEqual(uncaught.length, 0);
  });

  T('js/net.js against a hostile server: malformed gp / pong / glno / hit / snap / track cannot throw or poison state', async t => {
    // a fake server: says welcome, records what the client sends, answers pings from a clock we control
    const wss = new WebSocket.Server({ port: nextPort(), host: '127.0.0.1' });
    await new Promise(r => wss.on('listening', r));
    let sock = null, fakeOff = 5e9, answer = true;
    const inbox = [];
    const fakeNow = () => Date.now() + fakeOff;
    wss.on('connection', ws => {
      sock = ws;
      ws.on('message', d => {
        const m = JSON.parse(d.toString());
        inbox.push(m);
        if (m.t === 'hello') {
          ws.send(JSON.stringify({ t: 'welcome', v: 1, id: 7, host: 8, track: 'monza', seq: 3, now: fakeNow(),
            players: [{ id: 7, name: 'me', colour: '#112233', slot: 0 }, { id: 8, name: 'other', colour: '#445566', slot: 1 }] }));
        } else if (m.t === 'ping' && answer) ws.send(JSON.stringify({ t: 'pong', c: m.c, s: fakeNow() }));
      });
    });
    const N = freshNet();
    const ev = [];
    for (const n of ['gp', 'lapRejected', 'hit', 'track', 'disconnected']) N.on(n, (x, y) => ev.push([n, x, y]));
    const raw = async s => { sock.send(typeof s === 'string' ? s : JSON.stringify(s)); await sleep(15); };
    const clockOk = (label, extra) => {
      const d = N.serverNow() - fakeNow() - (extra || 0);
      assert(Number.isFinite(N.serverNow()) && Math.abs(d) < 25, label + ': serverNow off by ' + d);
    };
    try {
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      await sleep(80);
      clockOk('synchronised');
      assert.deepStrictEqual([N.id, N.isHost, N.trackId, N.session], [7, false, 'monza', null]);

      // --- pong ---
      const ping = inbox.filter(m => m.t === 'ping').pop();
      for (const p of [{ t: 'pong' }, { t: 'pong', c: 'x', s: 1 }, { t: 'pong', c: ping.c, s: 'x' }, { t: 'pong', c: ping.c, s: null },
        { t: 'pong', c: ping.c, s: 9e12 },                         // an answer we already used: replayed with another clock
        { t: 'pong', c: ping.c + 1, s: 9e12 }, { t: 'pong', c: Date.now(), s: 9e12 }, { t: 'pong', c: -1, s: 9e12 },
        { t: 'pong', c: ping.c, s: -5 }, { t: 'pong', c: ping.c, s: 0 }, { t: 'pong', c: ping.c, s: 1e300 }]) await raw(p);
      await raw('{"t":"pong","c":' + ping.c + ',"s":1e999}'); await raw('{"t":"pong","c":1e999,"s":1e999}');
      // "you pinged me just now" (a perfect round trip, if it were ours) with a clock from the year 2255
      sock.send(JSON.stringify({ t: 'pong', c: Date.now(), s: 9e12 })); sock.send(JSON.stringify({ t: 'pong', c: performance.now(), s: 9e12 }));
      await sleep(15);
      clockOk('after forged pongs');
      // the server's clock really changes (60 s): the next genuine exchange contradicts ours and replaces it
      fakeOff += 60000;
      await until(() => Math.abs(N.serverNow() - fakeNow()) < 25, 1000, 'resync after a clock step');
      // pings that are never answered and answers that never match leave the clock alone
      answer = false;
      await sleep(350);
      const unanswered = inbox.filter(m => m.t === 'ping').pop();
      await raw({ t: 'pong', c: unanswered.c, s: 1e300 });        // refused, and the ping is still open:
      clockOk('1e300');
      await raw({ t: 'pong', c: unanswered.c, s: fakeNow() });    // ...its real answer still counts
      clockOk('late genuine pong');

      // --- gp: not a snapshot -> ignored, net.session keeps what it had ---
      const notSnapshots = ['{"t":"gp"}', '{"t":"gp","s":null}', '{"t":"gp","s":5}', '{"t":"gp","s":"x"}', '{"t":"gp","s":[]}', '{"t":"gp","s":{}}',
        '{"t":"gp","s":{"players":[]}}', '{"t":"gp","s":{"phase":"quali","sid":"1","players":[]}}', '{"t":"gp","s":{"phase":"quali","sid":1,"players":"x"}}',
        '{"t":"gp","s":{"phase":"quali","sid":1e999,"players":[]}}', '{"t":"gp","s":{"phase":"bogus","sid":1,"players":[]}}',
        '{"t":"gp","s":{"phase":"__proto__","sid":1,"players":[]}}', '{"t":"gp","s":{"phase":"constructor","sid":1,"players":[]}}',
        '{"t":"gp","s":{"phase":["race"],"sid":1,"players":[]}}',
        '{"t":"gp","s":{"phase":"race","sid":1,"players":[]}}',                             // a race without start clocks
        '{"t":"gp","s":{"phase":"grid","sid":1,"players":[],"lightsAt":10,"goAt":5}}',     // lights after the start
        '{"t":"gp","s":{"phase":"grid","sid":1,"players":[],"lightsAt":"soon","goAt":{}}}',
        '{"t":"gp","s":{"phase":"race","sid":1,"players":[],"lightsAt":1e999,"goAt":1e999}}'];
      for (const s of notSnapshots) await raw(s);
      assert.strictEqual(N.session, null);
      assert.strictEqual(ev.filter(e => e[0] === 'gp').length, 0);
      // --- gp: a snapshot full of rubbish -> every field has the documented type afterwards ---
      const many = [];
      for (let i = 0; i < 1000; i++) many.push({ id: 100 + i, name: 'n' + i });
      await raw('{"t":"gp","now":"never","s":{"phase":"quali","sid":3,"q":"x","r":1e999,"len":-5,"lightsAt":"soon","goAt":{},"winnerAt":-1,"endsAt":1e999,' +
        '"grid":"abc","order":{"0":1,"length":1},"players":[null,5,"x",[],{"id":"a"},' +
        '{"id":8,"name":12345,"spec":"yes","left":1,"qLaps":-3,"qBest":"fast","qDone":"no","rLaps":1e999,"rTime":-1,"rBest":{},"fin":null,"dnf":[],"gap":-5,"down":"x"},' +
        '{"id":9,"name":"' + 'x'.repeat(3000) + '\\u0000\\u202e","qLaps":2.9,"qBest":80.5,"qDone":true,"rLaps":2.7,"rTime":12.5,"rBest":6,"fin":true,"gap":1.5,"down":1,"extra":{"a":1}}' +
        many.map(p => ',' + JSON.stringify(p)).join('') + ']}}');
      const s = N.session;
      assert(s && ev.filter(e => e[0] === 'gp').length === 1 && ev.find(e => e[0] === 'gp')[1] === s);
      assert.deepStrictEqual([s.sid, s.phase, s.q, s.r, s.len, s.lightsAt, s.goAt, s.winnerAt, s.endsAt, s.grid, s.order],
        [3, 'quali', 3, 5, 0, 0, 0, 0, 0, [], []]);
      assert.strictEqual(s.players.length, 59, 'at most 64 rows are read');
      assert.deepStrictEqual(s.players[0], { id: 8, name: 'Player 8', spec: false, left: false, qLaps: 0, qBest: null, qDone: false,
        rLaps: 0, rTime: 0, rBest: null, fin: false, dnf: false, gap: null, down: 0 });
      assert.deepStrictEqual(s.players[1], { id: 9, name: 'x'.repeat(16), spec: false, left: false, qLaps: 2, qBest: 80.5, qDone: true,
        rLaps: 2, rTime: 12.5, rBest: 6, fin: true, dnf: false, gap: 1.5, down: 1 });
      // a later non-snapshot does not wipe it; a good one replaces it
      await raw('{"t":"gp","s":{"phase":"race","sid":4,"players":[]}}');
      assert.strictEqual(N.session, s);
      await raw({ t: 'gp', now: 1, s: { sid: 4, phase: 'grid', q: 2, r: 9, len: 5000, lightsAt: 5000, goAt: 11000, winnerAt: 0, endsAt: 0, grid: [8, 7], order: [8, 7],
        players: [{ id: 7, name: 'me', spec: false, left: false, qLaps: 1, qBest: 81, qDone: true, rLaps: 0, rTime: 0, rBest: null, fin: false, dnf: false, gap: null, down: 0 }] } });
      assert.deepStrictEqual([N.session.sid, N.session.phase, N.session.q, N.session.r, N.session.len, N.session.lightsAt, N.session.goAt, N.session.grid],
        [4, 'grid', 2, 9, 5000, 5000, 11000, [8, 7]]);

      // --- glno ---
      for (const w of [12, null, {}, ['too-fast'], 'x'.repeat(5000), '<img src=x>', 'Too-Fast', '']) await raw({ t: 'glno', why: w });
      await raw({ t: 'glno' }); await raw({ t: 'glno', why: 'too-fast' });
      assert.deepStrictEqual(ev.filter(e => e[0] === 'lapRejected').map(e => e[1]), ['', '', '', '', '', '', '', '', '', 'too-fast']);

      // --- hit ---
      for (const h of [{ from: 8, i: [1e150, 0] }, { from: 8, i: [0, -300] }, { from: 8, i: [3, 4] }, { from: 8, i: ['x', 1] }, { from: 8, i: [1] },
        { from: 8, i: 'xx' }, { from: 99, i: [1, 1] }, { from: '8', i: [1, 1] }, { from: 8 }]) await raw(Object.assign({ t: 'hit' }, h));
      await raw('{"t":"hit","from":8,"i":[1e999,0]}'); await raw('{"t":"hit","from":8,"i":[1e300,1e300]}');
      assert.deepStrictEqual(ev.filter(e => e[0] === 'hit').map(e => [e[1], e[2]]), [[8, [80, 0]], [8, [0, -80]], [8, [3, 4]]]);

      // --- snap ---
      await raw({ t: 'snap', p: [[8, 1000, 1e300, 0, 0, 0, 0, 0, 0, 0], [8, 1001, 0, 0, 0, 0, 0, 0, 1e9, 0], [8, 'x', 0, 0, 0, 0, 0, 0, 0, 0], [8], 5, null, 'x'] });
      await raw('{"t":"snap","p":[[8,1002,1e999,0,0,0,0,0,0,0]]}'); await raw({ t: 'snap', p: 'x' }); await raw({ t: 'snap', p: { length: 3 } });
      N.update();
      assert.strictEqual(N.players[0].active, false, 'no pose came through');
      await raw({ t: 'snap', p: [[8, 2000, 10, 1, -20, 0.5, 0, 0, 30, 0]] });
      N.update();
      assert.strictEqual(N.players[0].active, true);
      assert(Object.keys(N.players[0].state).every(k => Number.isFinite(N.players[0].state[k])), JSON.stringify(N.players[0].state));

      // --- track: our race distance belongs to the old track ---
      inbox.length = 0;
      N.setProgress(2.5);
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await until(() => inbox.some(m => m.t === 's'), 1000, 's');
      assert.deepStrictEqual([inbox.find(m => m.t === 's').g, inbox.find(m => m.t === 's').k], [2.5, 3]);
      for (const tr of [{ id: 5, seq: 4 }, { id: 'x'.repeat(100), seq: 4 }, { id: '../etc', seq: 4 }, { id: 'spa', seq: 'x' }, { id: 'spa' }, { seq: 4 }, { id: '<b>', seq: 4 }]) {
        await raw(Object.assign({ t: 'track' }, tr));
      }
      assert.strictEqual(N.trackId, 'monza');
      assert.strictEqual(ev.filter(e => e[0] === 'track').length, 1, 'only the one from the welcome');
      await raw({ t: 'track', id: 'spa', seq: 4 });
      assert.strictEqual(N.trackId, 'spa');
      inbox.length = 0;
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await until(() => inbox.some(m => m.t === 's'), 1000, 's');
      assert.deepStrictEqual([inbox.find(m => m.t === 's').g, inbox.find(m => m.t === 's').k], [undefined, 4], 'progress cleared by the track change');

      // --- everything else ---
      for (const j of ['null', '[]', '5', '"x"', '{"t":{}}', '{"t":"welcome","id":99,"host":99}', '{"t":"players","players":"x"}', '{"t":"nope"}', 'not json', '']) await raw(j);
      sock.send(Buffer.from([1, 2, 3]));
      sock.send('{"t":"gp","pad":"' + 'x'.repeat(70000) + '","s":{"phase":"free","sid":9,"players":[]}}');
      await raw({ t: 'players', host: 7, players: [null, { id: 'a' }, { id: 7, name: 5, colour: 'red', slot: -1 }, { id: 8, name: '‮evil', colour: '#AABBCC', slot: 1 }] });
      assert.deepStrictEqual([N.id, N.isHost, N.session.sid], [7, true, 4]);
      assert.deepStrictEqual(N.roster.map(p => [p.id, p.name, p.colour]), [[7, 'Player 7', '#ff7a14'], [8, 'evil', '#aabbcc']]);
      clockOk('at the end');

      // --- the server drops us: nothing stays behind ---
      N.setProgress(1.5);
      sock.close(1001);
      await until(() => !N.connected, 2000, 'disconnected');
      assert.deepStrictEqual([N.session, N.id, N.trackId, N.isHost], [null, 0, null, false]);
      assert(Math.abs(N.serverNow() - Date.now()) < 50, 'the 5e9 ms offset is gone');
      // ...and a new connection starts from scratch (no progress in the first state, clock learnt again)
      fakeOff = -7e9; answer = true; inbox.length = 0;
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await until(() => inbox.some(m => m.t === 's'), 1000, 's');
      assert.deepStrictEqual([inbox.find(m => m.t === 's').g, inbox.find(m => m.t === 's').k, N.session], [undefined, 3, null]);
      await sleep(60);
      clockOk('after reconnect');
      N.leave();
      assert.strictEqual(uncaught.length, 0, 'nothing thrown out of a message handler');
    } finally {
      wss.clients.forEach(ws => ws.terminate());
      await new Promise(r => wss.close(r));
    }
  });

  T('js/net.js v6 against the real server: car in profile / roster / players, room year + event, wear, parc fermé', async t => {
    const srv = await t.start({ random: () => 0 });
    const A = freshNet(), B = freshNet(), C = freshNet();
    const ev = { A: [], B: [], C: [] };
    for (const [k, N] of [['A', A], ['B', B], ['C', C]]) {
      for (const n of ['connected', 'disconnected', 'year', 'track', 'players', 'gp']) N.on(n, x => ev[k].push([n, n === 'year' ? x : null]));
    }
    const years = k => ev[k].filter(e => e[0] === 'year').map(e => e[1]);
    const addr = '127.0.0.1:' + srv.port;
    // the profile before joining: sanitised; a car that is not an id keeps the previous one
    A.setProfile({ name: 'Ann', colour: '#112233', car: '2024-ferrari' });
    B.setProfile({ name: 'Bob', car: 'Not A Car' });
    assert.deepStrictEqual(B.getProfile(), { name: 'Bob', colour: '#ff7a14', car: '' });
    B.setProfile({ car: '2024-mclaren' });
    for (const bad of [5, null, {}, [], '', 'X', 'a'.repeat(41)]) B.setProfile({ car: bad });
    B.setProfile({}); B.setProfile(null);
    assert.deepStrictEqual(B.getProfile(), { name: 'Bob', colour: '#ff7a14', car: '2024-mclaren' });
    assert.strictEqual(A.setYear(2024), false, 'not in a room');
    assert.deepStrictEqual(await A.join(addr), { ok: true });
    assert.deepStrictEqual(await B.join(addr), { ok: true });
    await until(() => A.roster.length === 2 && B.roster.length === 2, 2000, 'roster');
    assert.deepStrictEqual([A.year, B.year, years('A'), years('B')], [null, null, [], []], 'no year yet: none, and no event');
    assert.deepStrictEqual(A.roster.map(p => [p.name, p.car]), [['Ann', '2024-ferrari'], ['Bob', '2024-mclaren']]);
    assert.deepStrictEqual([A.players[0].car, B.players[0].car], ['2024-mclaren', '2024-ferrari']);
    // the year: host only, whole 2010..2100; the event comes with the roster
    for (const bad of [2009, 2101, 2024.5, '2024', null, undefined, NaN, Infinity]) assert.strictEqual(A.setYear(bad), false, String(bad));
    assert.strictEqual(B.setYear(2024), false, 'not the host');
    assert.strictEqual(A.setYear(2024), true);
    assert.strictEqual(A.year, null, 'not before the server says so');
    await until(() => A.year === 2024 && B.year === 2024, 2000, 'year');
    assert.deepStrictEqual([years('A'), years('B')], [[2024], [2024]]);
    // a car change alone goes out and reaches the others
    B.setProfile({ car: '2024-williams' });
    await until(() => A.roster[1].car === '2024-williams' && A.players[0].car === '2024-williams', 2000, 'car change');
    // a newcomer: connected, then the year, then the track (its car is known before the track is built)
    assert.strictEqual(A.selectTrack('monza'), true);
    await until(() => B.trackId === 'monza', 2000, 'track');
    C.setProfile({ name: 'Cy', car: '2023-alpine' });
    assert.deepStrictEqual(await C.join(addr), { ok: true });
    assert.deepStrictEqual(ev.C.filter(e => e[0] === 'connected' || e[0] === 'year' || e[0] === 'track'), [['connected', null], ['year', 2024], ['track', null]]);
    await until(() => A.roster.length === 3 && A.roster[2].car === '2023-alpine', 2000, 'C in the roster');
    // Grand Prix: the wear goes along, the year is the room's
    assert.strictEqual(A.gp('start', { q: 1, r: 1, len: LEN, wear: 4, year: 1999 }), true);
    await until(() => [A, B, C].every(N => N.session && N.session.phase === 'quali'), 2000, 'quali');
    assert.deepStrictEqual([A, B, C].map(N => [N.session.year, N.session.wear]), [[2024, 4], [2024, 4], [2024, 4]]);
    // parc fermé: the year is refused locally, the car is kept by the server, the choice is remembered
    assert.strictEqual(A.setYear(2025), false, 'a session is on');
    B.setProfile({ car: '2024-haas' });
    B.setProfile({ name: 'Bobby' });
    await until(() => A.roster[1].name === 'Bobby', 2000, 'rename');
    assert.deepStrictEqual([A.roster[1].car, B.getProfile().car], ['2024-williams', '2024-haas']);
    // back in free practice the car chosen meanwhile goes out by itself
    assert.strictEqual(A.gp('end'), true);
    await until(() => A.roster[1].car === '2024-haas' && C.players.find(p => p.id === B.id).car === '2024-haas', 2000, 'car sent again after the session');
    assert.deepStrictEqual([A.session.phase, A.year, years('C')], ['free', 2024, [2024]]);
    // a Grand Prix without a wear: the default
    assert.strictEqual(A.gp('start', { q: 1, r: 1, len: LEN }), true);
    await until(() => A.session.phase === 'quali' && A.session.sid === 2, 2000, 'second start');
    assert.deepStrictEqual([A.session.year, A.session.wear], [2024, 1]);
    A.gp('end');
    await until(() => A.session.phase === 'free', 2000, 'free');
    // leaving: nothing of the room stays, and no year event for it
    const nb = years('B').length;
    B.leave();
    assert.deepStrictEqual([B.year, B.roster.length, years('B').length], [null, 0, nb]);
    assert.deepStrictEqual(B.getProfile(), { name: 'Bobby', colour: '#ff7a14', car: '2024-haas' }, 'the profile is ours, it stays');
    C.leave(); A.leave();
    assert.strictEqual(uncaught.length, 0);
  });

  T('js/net.js against a hostile server: garbage year / car / wear are sanitised; the year event fires on real changes only', async t => {
    const wss = new WebSocket.Server({ port: nextPort(), host: '127.0.0.1' });
    await new Promise(r => wss.on('listening', r));
    let sock = null, welcomeYear = '2024';
    const inbox = [];
    wss.on('connection', ws => {
      sock = ws;
      ws.on('message', d => {
        const m = JSON.parse(d.toString());
        inbox.push(m);
        if (m.t === 'hello') {
          ws.send(JSON.stringify({ t: 'welcome', v: 1, id: 7, host: 8, track: 'monza', seq: 3, year: welcomeYear, now: Date.now(),
            players: [{ id: 7, name: 'me', colour: '#112233', slot: 0, car: m.car }, { id: 8, name: 'other', colour: '#445566', slot: 1, car: '<script>' }] }));
        } else if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() }));
      });
    });
    const N = freshNet();
    const ev = [];
    for (const n of ['connected', 'year', 'track', 'players', 'gp']) N.on(n, x => ev.push(n === 'year' ? 'year ' + x : n));
    const raw = async s => { sock.send(typeof s === 'string' ? s : JSON.stringify(s)); await sleep(15); };
    const years = () => ev.filter(e => /^year/.test(e));
    const roster = (year, cars, host) => ({ t: 'players', host: host || 8, year, players: [
      { id: 7, name: 'me', colour: '#112233', slot: 0, car: cars[0] }, { id: 8, name: 'other', colour: '#445566', slot: 1, car: cars[1] }] });
    const snap = (year, wear, phase) => ({ t: 'gp', now: 1, s: { sid: 1, phase: phase || 'quali', q: 1, r: 1, len: 5000, year, wear,
      lightsAt: 0, goAt: 0, winnerAt: 0, endsAt: 0, grid: [], order: [7], players: [{ id: 7, name: 'me' }] } });
    try {
      N.setProfile({ car: '2024-ferrari' });
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      assert.strictEqual(inbox[0].car, '2024-ferrari', 'the hello carries the car');
      assert.deepStrictEqual([N.year, years()], [null, []], 'a year that is a string: none, and no event');
      assert.deepStrictEqual([N.roster.map(p => p.car), N.players[0].car], [['2024-ferrari', ''], ''], 'a car that is not an id: ""');

      // --- year in the roster: garbage -> null; a change fires the event, a repeat does not ---
      for (const y of [2024.5, '2024', 1e308, -2024, 2009, 2101, {}, [2024], true, null, undefined]) await raw(roster(y, ['a', 'b']));
      await raw('{"t":"players","host":8,"year":1e999,"players":[]}');
      assert.deepStrictEqual([N.year, years()], [null, []]);
      await raw(roster(2024, ['2024-ferrari', '2024-mclaren'])); await raw(roster(2024, ['2024-ferrari', '2024-mclaren']));
      assert.deepStrictEqual([N.year, years()], [2024, ['year 2024']]);
      await raw({ t: 'players', host: 8, year: 2030, players: 'x' });            // not a roster: ignored whole
      await raw({ t: 'players', host: 8, year: 2030 });
      assert.deepStrictEqual([N.year, N.roster.length, years()], [2024, 2, ['year 2024']]);
      await raw(roster(2024.5, ['2024-ferrari', '2024-mclaren']));
      assert.deepStrictEqual([N.year, years()], [null, ['year 2024', 'year null']], 'the room has no (usable) year any more');
      await raw(roster(2030, ['2024-ferrari', '2024-mclaren']));
      assert.deepStrictEqual([N.year, years()], [2030, ['year 2024', 'year null', 'year 2030']]);

      // --- cars in the roster rows ---
      for (const c of [5, null, {}, ['2024-ferrari'], 'A', 'a b', '', 'a'.repeat(41), '2024_x', '<img>', 'x\u0000', '__proto__']) {
        await raw(roster(2030, ['2024-ferrari', c]));
        assert.deepStrictEqual([N.players[0].car, N.roster[1].car], ['', ''], JSON.stringify(c));
      }
      await raw(roster(2030, ['2024-ferrari', 'a'.repeat(40)]));
      assert.deepStrictEqual([N.players[0].car, N.roster[1].car], ['a'.repeat(40), 'a'.repeat(40)]);

      // --- year / wear in the session snapshot ---
      for (const [y, w, want] of [[2024, 3, [2024, 3]], ['2024', 99, [null, 5]], [2024.5, -1, [null, 1]], [2101, 'x', [null, 1]], [2010, 2.9, [2010, 2]],
        [null, 0, [null, 1]], [{}, {}, [null, 1]], [undefined, undefined, [null, 1]], [[2024], [3], [null, 1]], [2100, 5, [2100, 5]]]) {
        await raw(snap(y, w));
        assert.deepStrictEqual([N.session.year, N.session.wear], want, JSON.stringify([y, w]));
      }
      await raw('{"t":"gp","s":{"sid":1,"phase":"quali","players":[],"year":1e999,"wear":1e999}}');
      assert.deepStrictEqual([N.session.year, N.session.wear], [null, 1]);

      // --- setYear: refused locally when not the host / in a session; else sent, and net.year waits for the server ---
      assert.strictEqual(N.setYear(2025), false, 'not the host');
      await raw(roster(2030, ['2024-ferrari', ''], 7));
      assert.strictEqual(N.isHost, true);
      assert.strictEqual(N.setYear(2025), false, 'a session is on (quali)');
      inbox.length = 0;
      await raw(snap(2030, 1, 'free'));                                           // quali -> free: our car matches, nothing sent
      assert.strictEqual(N.setYear(2025), true);
      await until(() => inbox.some(m => m.t === 'year'), 1000, 'year message');
      assert.deepStrictEqual([inbox.filter(m => m.t === 'year'), inbox.filter(m => m.t === 'profile').length, N.year], [[{ t: 'year', y: 2025 }], 0, 2030]);

      // --- parc fermé resync: a session ends and the server has another car for us -> we tell it once ---
      await raw(roster(2030, ['old-car', ''], 7));
      await raw(snap(2030, 1, 'free'));                                           // free -> free: no transition, nothing
      assert.strictEqual(inbox.filter(m => m.t === 'profile').length, 0);
      await raw(snap(2030, 1, 'quali')); await raw(snap(2030, 1, 'results'));
      await raw(snap(2030, 1, 'free'));
      await until(() => inbox.some(m => m.t === 'profile'), 1000, 'profile sent again');
      await raw(snap(2030, 1, 'free')); await raw(snap(2030, 1, 'free'));
      assert.deepStrictEqual(inbox.filter(m => m.t === 'profile'), [{ t: 'profile', name: 'Player', colour: '#ff7a14', car: '2024-ferrari' }]);

      // --- a welcome with a real year: connected, then year, then track ---
      N.leave();
      assert.strictEqual(N.year, null);
      welcomeYear = 2026; ev.length = 0; inbox.length = 0;
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      assert.deepStrictEqual(ev.filter(e => e !== 'players' && e !== 'gp'), ['connected', 'year 2026', 'track']);
      assert.deepStrictEqual([N.year, inbox[0].car], [2026, '2024-ferrari']);
      N.leave();
      assert.strictEqual(uncaught.length, 0, 'nothing thrown out of a message handler');
    } finally {
      wss.clients.forEach(ws => ws.terminate());
      await new Promise(r => wss.close(r));
    }
  });

  /* ---------- hardening: floods, kicks, amplification ---------- */

  lane = lanes.tcp;
  T('connections that never become WebSockets are capped (in all and per address) and short-lived', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: 'player' });
    // plain HTTP gets a short answer, not a hanging socket
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/', agent: false }, r => {
        let body = '';
        r.on('data', d => { body += d; });
        r.on('end', () => resolve({ code: r.statusCode, body }));
      }).on('error', reject);
    });
    assert.deepStrictEqual([res.code, /WebSocket/.test(res.body)], [426, true]);
    const open = list => list.filter(s => !s._gone).length;
    const tcp = (n, localAddress) => {
      const list = [];
      for (let i = 0; i < n; i++) {
        const s = nodeNet.connect({ host: '127.0.0.1', port: srv.port, localAddress });
        s.on('error', () => {}); s.on('close', () => { s._gone = true; });
        list.push(s);
      }
      return list;
    };
    // one address (127.0.0.2 is not "this machine" for the server: only 127.0.0.1 is exempt) holds at most 16
    const one = tcp(40, '127.0.0.2');
    await sleep(400);
    assert.strictEqual(open(one), 16, 'silent TCP connections kept per address');
    // ...and at most 8 of them can be WebSockets; the rest are told "busy"
    const wsFrom3 = [];
    for (let i = 0; i < 11; i++) {
      wsFrom3.push(await new Promise(resolve => {
        const ws = new WebSocket('ws://127.0.0.1:' + srv.port, { localAddress: '127.0.0.3' });
        const c = { ws, msgs: [], closed: null };
        ws.on('message', d => c.msgs.push(JSON.parse(d.toString())));
        ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', v: 1, name: 'n' + i })); setTimeout(() => resolve(c), 60); });
        ws.on('close', code => { c.closed = code; });
        ws.on('error', () => resolve(c));
      }));
    }
    await sleep(150);
    assert.deepStrictEqual([wsFrom3.filter(c => c.msgs.some(m => m.t === 'welcome')).length, wsFrom3.filter(c => c.msgs.some(m => m.t === 'error' && m.code === 'busy')).length], [8, 3]);
    assert.strictEqual(srv.info().players.length, 9);
    wsFrom3.forEach(c => c.ws.terminate());
    // the whole server keeps at most 96 connections, whoever they come from
    const t0 = Date.now();
    const many = tcp(150);
    await sleep(500);
    assert(open(many) <= 96 - 16 - 1 && open(many) >= 60, 'silent TCP connections kept in all: ' + open(many));
    // a slow-loris dribbling its request is cut off like the silent ones
    const loris = many.find(s => !s._gone), req = 'GET / HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'x'.repeat(200);
    let sent = 0;
    const drip = setInterval(() => { if (!loris._gone && sent < req.length) loris.write(req[sent++]); }, 250);
    // the player in the room notices nothing
    a.send({ t: 'ping', c: 1 });
    await a.wait(() => a.last('pong'));
    await until(() => open(one) + open(many) === 0, 8000, 'every silent connection closed by the server');
    clearInterval(drip);
    const took = Date.now() - t0;
    assert(took > 3000 && took < 7000, 'closed about 4 s after they connected: ' + took + ' ms');
    assert.strictEqual(a.closed, null);
    const b = await client(srv.port, { name: 'next' });            // and there is room again
    assert(b.id > 0);
    a.ws.close(); b.ws.close();
  });

  lane = lanes.floods;

  T('flooding is rate-limited and the flooder is dropped', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    await sleep(150);
    const n0 = b.all('players').length;
    for (let i = 0; i < 5000; i++) a.send({ t: 'profile', name: 'n' + i, colour: '#000000' });
    await a.wait(() => a.closed, 4000);
    assert.strictEqual(a.closed.code, 1008);
    assert.strictEqual(a.last('error').code, 'flood');
    const rosters = b.all('players').length - n0;
    assert(rosters < 25, 'roster broadcasts caused by the flood: ' + rosters);
    await b.wait(() => b.roster().length === 1);
    b.send({ t: 'track', id: 'ok' });
    await b.wait(() => b.last('track'));
    b.ws.close();
  });

  T('nothing a client sends is amplified: floods of lap / profile / gp / gl / ping / joins reach the room as a trickle', async t => {
    const R = await room(t, 3);
    const [host, watcher, spammer] = R.cs;
    await R.start(1, 1);
    await sleep(150);
    const count = () => ({ players: watcher.all('players').length, gp: watcher.all('gp').length, all: watcher.msgs.length });
    const flood = async (from, make, label, limit) => {
      const n = count();
      for (let i = 0; i < 3000; i++) from.send(make(i));
      await from.wait(() => from.closed, 5000, label + ': kicked');
      assert.strictEqual(from.closed.code, 1008, label);
      await sleep(250);
      const d = count();
      assert(d.all - n.all < limit, label + ': the watcher got ' + (d.all - n.all) + ' messages (' + (d.players - n.players) + ' rosters, ' + (d.gp - n.gp) + ' gp)');
      return d.all - n.all;
    };
    const got = [];
    // in a session a rename touches the roster AND the Grand Prix snapshot
    got.push(await flood(spammer, i => ({ t: 'profile', name: 'n' + i }), 'profile', 25));
    let s2 = await client(R.srv.port, { name: 's2' });
    got.push(await flood(s2, i => ({ t: 'lap', last: 60 + i, best: 60 }), 'lap', 25));
    s2 = await client(R.srv.port, { name: 's3' });
    await s2.wait(() => s2.gp());
    got.push(await flood(s2, () => ({ t: 'gl', k: 1, sid: 1, time: 0.5 }), 'gl', 12));
    assert(s2.all('glno').length <= 200, 'answers to the flooder itself are bounded by the rate limit (120 burst + 60 / s): ' + s2.all('glno').length);
    s2 = await client(R.srv.port, { name: 's4' });
    got.push(await flood(s2, i => ({ t: 'ping', c: i }), 'ping', 12));
    assert(s2.all('pong').length <= 200, 'pongs: ' + s2.all('pong').length);
    s2 = await client(R.srv.port, { name: 's5' });
    got.push(await flood(s2, i => ({ t: 'gp', a: i % 2 ? 'end' : 'start', q: 1, r: 1, len: LEN }), 'gp from a guest', 12));
    assert.deepStrictEqual([srv_phase(R), srv_gp(R).sid], ['quali', 1], 'and it changed nothing');
    // even the host cannot make the server spray snapshots
    got.push(await flood(host, i => ({ t: 'gp', a: i % 2 ? 'end' : 'start', q: 1, r: 1, len: LEN }), 'gp from the host', 25));
    await watcher.wait(() => watcher.host() === watcher.id);
    await settle(R.srv, [watcher], s => s.players.length === 1);
    // connection churn: 40 joins and leaves
    const n = count();
    for (let i = 0; i < 40; i++) { const c = await client(R.srv.port, { name: 'c' + i }); c.ws.close(); }
    await until(() => R.srv.info().players.length === 1, 2000, 'churn over');
    await sleep(250);
    const d = count();
    // per join + leave the watcher used to get 2 rosters + 2 snapshots (+ gone); now it is bounded by time
    assert(d.players - n.players < 40 && d.gp - n.gp < 40, 'churn: ' + (d.players - n.players) + ' rosters, ' + (d.gp - n.gp) + ' gp for 40 joins + 40 leaves');
    console.log('     watcher messages per 3000-message flood (profile, lap, gl, ping, guest gp, host gp): ' + got.join(', ') +
      '; churn: ' + (d.players - n.players) + ' rosters + ' + (d.gp - n.gp) + ' gp');
    // the room still works, and its state is the latest
    watcher.send({ t: 'gp', a: 'end' }); watcher.send({ t: 'gp', a: 'start', q: 2, r: 3, len: LEN });
    const g = await settle(R.srv, [watcher], s => s.phase === 'quali' && s.q === 2);
    assert.deepStrictEqual(g.players.map(p => p.id), [watcher.id]);
    watcher.ws.close();
  });

  T('a kicked or refused client that ignores the close frame loses its seat at once and is cut off', async t => {
    const srv = await t.start();
    const good = await client(srv.port, { name: 'good' });
    // refused (wrong version): the socket cannot say hello again while we wait for it to close
    const liar = await rawClient(srv.port);
    liar.send({ t: 'hello', v: 999, name: 'liar' });
    await until(() => liar.closeFrame === 1008, 2000, 'close frame');
    assert.strictEqual(liar.last('error').code, 'version');
    liar.send({ t: 'hello', v: 1, name: 'liar' });
    await sleep(200);
    assert.strictEqual(liar.last('welcome'), null, 'a refused socket stays refused');
    assert.strictEqual(srv.info().players.length, 1);
    await until(() => liar.ended, 2000, 'the server destroys the socket');
    // kicked for flooding: removed from the room immediately, its later messages are dead letters
    const rude = await rawClient(srv.port);
    rude.send({ t: 'hello', v: 1, name: 'rude' });
    await until(() => rude.last('welcome'), 2000, 'welcome');
    await good.wait(() => good.roster().length === 2);
    const t0 = Date.now();
    for (let i = 0; i < 1500; i++) rude.send({ t: 'ping', c: i });
    await until(() => rude.closeFrame === 1008, 3000, 'kicked');
    assert.strictEqual(rude.last('error').code, 'flood');
    await good.wait(() => good.roster().length === 1, 600, 'the seat is free before the socket is gone');
    assert.strictEqual(rude.ended, false, 'the peer never answered the close');
    await sleep(300);                                            // the rate limiter would have refilled by now
    const n = good.msgs.length;
    rude.send({ t: 'profile', name: 'still here' }); rude.send({ t: 'hello', v: 1, name: 'again' }); rude.send({ t: 'ping', c: 1 });
    const pongs = rude.msgs.filter(m => m.t === 'pong').length;
    await sleep(200);
    assert.strictEqual(good.msgs.length, n, 'nothing from a kicked socket reaches the room');
    assert.strictEqual(rude.msgs.filter(m => m.t === 'pong').length, pongs);
    await until(() => rude.ended, 2000, 'the server destroys the socket');
    assert(Date.now() - t0 < 3000, 'within about a second of the kick, not ws\'s 30 s close timeout');
    good.ws.close();
  });

  /* ---------- review 1: what the server can check (laps and progress backed by driving, impacts, the race time,
     the start, room password, idle players) ---------- */
  lane = lanes.review;

  // every message c sent before this has been handled (pings are answered in order)
  const handled = async c => {
    const n = c.all('pong').length;
    c.send({ t: 'ping', c: 1 });
    await c.wait(() => c.all('pong').length > n, 2000, 'pong');
  };

  T('forged laps: only laps the car states cover count, credited at 130 m/s at most; live progress likewise (forged-laps, progress-cheat)', async t => {
    const R = await room(t, 4);
    // a hosts and stays parked; h drives at 80 m/s; x reports laps it never drove; y's states come only every 16 s
    const [a, h, x, y] = R.cs;
    const MONZA = 5793, MIN_M = minLapTime(MONZA);             // 63.2 s
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: MONZA });
    await R.settle(s => s.phase === 'quali');
    const gl = async (c, time) => {
      const n = c.all('glno').length;
      c.send({ t: 'gl', k: c.seq(), sid: c.gp().sid, time });
      await handled(c);
      return c.all('glno').length > n ? c.last('glno').why : '';
    };
    // the verifier's cheater: not a single state, a lap at the fastest the time checks allow
    R.clk.add(64000);
    assert.strictEqual(await gl(x, MIN_M + 0.001), 'not-driven');
    // 76 s: h drives 320 m every 4 s; x stands still with its states flowing
    h.drive(0, 0); x.drive(0, 0);
    await Promise.all([handled(h), handled(x)]);
    for (let i = 1; i <= 19; i++) {
      R.clk.add(4000);
      h.drive(i * 320, 0, undefined, 80, Math.PI / 2); x.drive(0, 0);
      await Promise.all([handled(h), handled(x)]);
    }
    assert.strictEqual(await gl(h, 75), '', 'h drove 6080 m');
    assert.strictEqual(await gl(x, 70), 'not-driven', 'x stood still');
    // a burst of states cannot make up for it: 5 s of credit at most (650 m), then a step is a reset or nothing
    x.drive(650, 0, undefined, 130, Math.PI / 2); x.drive(1300, 0);
    for (let i = 1; i <= 20; i++) x.drive(1300 + i * 30, 0);
    assert.strictEqual(await gl(x, 70), 'not-driven', '1900 m of states in no time: 650 m of it count');
    // y drives far enough, but its positions arrive every 16 s: 5 s of each gap count, 45 s over a 127 s lap
    y.drive(0, 0);
    for (let i = 1; i <= 8; i++) { R.clk.add(16000); y.drive(i * 650, 0, undefined, 80, Math.PI / 2); await handled(y); }
    assert.strictEqual(await gl(y, 127), 'no-data');
    let g = srv_gp(R);
    assert.deepStrictEqual(g.players.map(p => p.qLaps), [0, 1, 0, 0]);

    // race: the live order cannot be claimed by a parked car
    a.send({ t: 'gp', a: 'skip' });
    g = await R.settle(s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [h.id, a.id, x.id, y.id]);
    R.clk.to(g.goAt);
    await R.settle(s => s.phase === 'race');
    x.drive(x.px, 0, 0.99);                                     // parked on its grid slot, "99 % of a lap"
    R.clk.add(4000);
    h.drive(h.px + 320, 0, 320 / MONZA, 80, Math.PI / 2);       // 4 s at 80 m/s
    await Promise.all([handled(h), handled(x)]);
    g = await R.settle(s => s.order[0] === h.id);
    assert.deepStrictEqual(g.order, [h.id, x.id, a.id, y.id], 'the parked car is not in the lead');
    x.drive(x.px + 5000, 0, 0.99);                              // "a lap further on" in one step: a reset
    await handled(x);
    assert.deepStrictEqual(srv_gp(R).order, g.order);
    // x drives faster than h for 8 s: now it does lead (by what it drove, not what it says)
    for (let i = 0; i < 2; i++) {
      R.clk.add(4000);
      x.drive(x.px + 520, 0, 0.99, 130, Math.PI / 2); h.drive(h.px + 320, 0, (h.px + 320 - 19 * 320) / MONZA, 80, Math.PI / 2);
      await Promise.all([handled(h), handled(x)]);
    }
    g = await R.settle(s => s.order[0] === x.id);
    assert.deepStrictEqual(g.order, [x.id, h.id, a.id, y.id]);
    R.cs.forEach(c => c.ws.close());
  });

  T('race time from the crossing: a lap report that arrives late costs nothing (rtime-latency)', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    await R.start(1, 1);
    const g = await R.toRace();
    // b crosses the line 3.0 s after lights out, a at 3.2 s; a's report arrives at once, b's 1.5 s late
    R.clk.to(g.goAt + 3250);
    a.lap(3.2, undefined, g.goAt + 3200);
    await R.settle(s => s.players.some(p => p.fin));
    R.clk.to(g.goAt + 4500);
    b.lap(3.0, undefined, g.goAt + 3000);
    const r = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(r.players.map(p => p.rTime), [3.2, 3], 'the laps (the crossings agree with them), not the arrival');
    assert.deepStrictEqual(r.order, [b.id, a.id], 'b crossed first');
    R.cs.forEach(c => c.ws.close());
  });

  lane = lanes.review2;                        // real time

  T('impact reports: none after a teleport; no bigger than the two cars\' motion allows, within a budget per pair; none on stale positions (hit-spam)', async t => {
    const srv = await t.start();
    const v = await client(srv.port, { name: 'victim' }), e = await client(srv.port, { name: 'evil' }), o = await client(srv.port, { name: 'other' });
    // the victim drives along +z at 60 m/s and reports 20 times a second, as the game does
    let vz = 1000;
    const vt = setInterval(() => { vz += 3; v.drive(1000, vz, undefined, 60, 0); }, 50);
    e.drive(-1000, -1000);
    await sleep(120);
    // one state 10 m beside him from 2.8 km away is a reset, not driving: nothing it reports is relayed
    e.drive(1010, vz);
    for (let i = 0; i < 5; i++) { e.send({ t: 'hit', k: 0, to: v.id, i: [0, -80] }); await sleep(45); }
    await sleep(100);
    assert.strictEqual(v.all('hit').length, 0, 'nothing after a teleport');
    // then it keeps pace beside him ("parked", it says) and fires 80 m/s reports both ways, 22 a second
    const et = setInterval(() => e.drive(1010, vz), 50);
    await sleep(120);
    const t0 = Date.now();
    let k = 0;
    while (Date.now() - t0 < 1000) { e.send({ t: 'hit', k: 0, to: v.id, i: [0, k++ % 2 ? 80 : -80] }); await sleep(45); }
    await sleep(150);
    const got = v.all('hit').map(m => m.i);
    const total = got.reduce((s, i) => s + Math.hypot(i[0], i[1]), 0);
    assert(got.length >= 2, 'a car that runs into a parked one at 60 m/s is pushed back: ' + got.length);
    assert(got.every(i => i[0] === 0 && i[1] < 0), 'only against his motion (a parked car cannot push him on): ' + JSON.stringify(got));
    assert(got.every(i => -i[1] <= 63.01), 'no more than the closing speed (60 m/s) + 3: ' + JSON.stringify(got));
    assert(total <= 160 + 40 * 1.4, 'the budget of the pair: ' + total.toFixed(1) + ' m/s in about a second (was 22 x 80)');
    assert.strictEqual(o.all('hit').length, 0);
    // stale: the victim stops reporting; half a second later nothing is relayed
    clearInterval(vt);
    await sleep(600);
    const n = v.all('hit').length;
    for (let i = 0; i < 3; i++) { e.send({ t: 'hit', k: 0, to: v.id, i: [0, -5] }); await sleep(50); }
    await sleep(100);
    assert.strictEqual(v.all('hit').length, n, 'the target\'s position is stale');
    clearInterval(et);
    [v, e, o].forEach(c => c.ws.close());
  });

  T('a Grand Prix start while the host\'s own track pick still waits is refused, not undone a moment later (track-then-start)', async t => {
    const srv = await t.start({ hostToken: 'tok' });
    const h = await client(srv.port, { name: 'H', token: 'tok' }), g = await client(srv.port, { name: 'G' });
    h.send({ t: 'track', id: 'monza' });
    await g.wait(() => g.last('track'));
    await sleep(300);
    h.send({ t: 'track', id: 'monaco' });                         // within a second of the last change: it waits
    await sleep(100);
    h.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });        // on Monza, which Monaco is about to replace
    await sleep(150);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().gp.sid], ['free', 0], 'refused');
    await g.wait(() => g.last('track').id === 'monaco', 2000, 'the pick goes out');
    h.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    await settle(srv, [h, g], s => s.phase === 'quali');
    await sleep(1200);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().track], ['quali', 'monaco'], 'and it stays on');
    assert.deepStrictEqual(g.all('track').map(m => m.id), ['monza', 'monaco']);
    assert(!g.all('gp').some(m => m.s.sid === 1 && m.s.phase === 'free'), 'never thrown back to free practice');
    h.ws.close(); g.ws.close();
  });

  T('room password: needed in hello (not by the token holder), compared trimmed / NFC, wrong guesses limited per address (open-room)', async t => {
    const srv = await t.start({ hostToken: 'tok', password: '  Café 42 ' });
    const h = await client(srv.port, { name: 'H', token: 'tok' });              // the room itself needs none
    assert.strictEqual(h.last('welcome').host, h.id);
    // js/net.js: missing, wrong, right (typed with a decomposed é and spaces around)
    const N = freshNet();
    assert.deepStrictEqual(await N.join('127.0.0.1:' + srv.port), { ok: false, error: '這個房間需要密碼，請輸入房間密碼' });
    assert.deepStrictEqual(await N.join('127.0.0.1:' + srv.port, { password: 'cafe 42' }), { ok: false, error: '房間密碼錯誤' });
    assert.deepStrictEqual(await N.join('127.0.0.1:' + srv.port, { password: ' Café 42' }), { ok: true });
    await h.wait(() => h.roster().length === 2);
    N.leave();
    // raw hellos (the right one above cleared the count): five wrong ones from this address in a minute, then even
    // the right one has to wait
    for (const pw of [42, 'Café 4', 'café 42', '', 'Café 42 x']) {
      const c = await client(srv.port, { name: 'x', password: pw });
      await c.wait(() => c.closed);
      assert.deepStrictEqual([c.id, c.last('error').code, c.closed.code], [0, 'password', 1008], JSON.stringify(pw));
    }
    const late = await client(srv.port, { name: 'x', password: 'Café 42' });
    await late.wait(() => late.closed);
    assert.deepStrictEqual([late.id, late.last('error').code], [0, 'wait']);
    assert.strictEqual(srv.info().players.length, 1);
    // the token holder is not held up by it; an open room ignores a password
    const h2 = await client(srv.port, { name: 'H2', token: 'tok' });
    assert(h2.id > 0);
    const open = await t.start();
    const any = await client(open.port, { name: 'any', password: 'whatever' });
    assert(any.id > 0);
    h.ws.close(); h2.ws.close(); any.ws.close();
  });

  T('idle: a player who sends nothing for idleMs is dropped with "idle" (js/net.js says why); anything keeps one; the token holder stays', async t => {
    const srv = await t.start({ hostToken: 'tok', idleMs: 400 });
    const h = await client(srv.port, { name: 'H', token: 'tok' });
    const quiet = await client(srv.port, { name: 'Q' }), busy = await client(srv.port, { name: 'B' });
    const timer = setInterval(() => busy.send({ t: 'ping', c: 1 }), 100);
    await quiet.wait(() => quiet.closed, 2000, 'idle kick');
    assert.deepStrictEqual([quiet.last('error').code, quiet.closed.code], ['idle', 1008]);
    await sleep(300);
    assert.deepStrictEqual(srv.info().players.map(p => p.name).sort(), ['B', 'H'], 'the pinging one and the silent host stay');
    clearInterval(timer);
    // js/net.js pings 6 times at 300 ms, then every 10 s: dropped after that, and it tells the player why
    const N = freshNet(), ev = [];
    N.on('disconnected', r => ev.push(r));
    assert.deepStrictEqual(await N.join('127.0.0.1:' + srv.port), { ok: true });
    await until(() => ev.length, 4000, 'net.js dropped');
    assert.deepStrictEqual(ev, ['連線中斷：太久沒有動作，已被移出房間']);
    h.ws.close(); busy.ws.close();
  });

  const tcp = runLane(lanes.tcp);                               // mostly waiting: fine next to anything
  await runLane(lanes.floods);
  await Promise.all([runLane(lanes.relay), runLane(lanes.gp1), runLane(lanes.gp2), runLane(lanes.gp3), runLane(lanes.client), runLane(lanes.year), runLane(lanes.year2),
    runLane(lanes.review), runLane(lanes.review2), tcp]);
  await slow;

  const secs = ((Date.now() - T_START) / 1000).toFixed(1);
  if (uncaught.length) failed++;
  console.log(failed ? '\n' + failed + ' test(s) FAILED  (' + secs + ' s)' : '\nall server tests passed  (' + secs + ' s)');
  process.exit(failed ? 1 : 0);
})();
