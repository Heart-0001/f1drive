// node test/server.test.js — tests for net/server.js with real `ws` clients (the relay, the room lobby of protocol 2
// (v7.2: settings, ready, start, the loading barrier, back to the lobby), the Grand Prix over the wire, the v6 cars /
// room year / tyre wear, protocol hardening), plus js/net.js: address parsing, the real client against the real
// server, and the client against a hostile server.
//
// Ports: the OS picks them (port 0) unless F1_TEST_PORT_BASE is set, then base .. base + 59 are used.
// Clock: the Grand Prix tests hand createServer a manual clock (opts.now) and step it, so a whole race takes
// milliseconds; one test ("real clock") runs a complete Grand Prix on the default clock in real time (~14.5 s).
// Order: every test has its own server, so they run in a few concurrent lanes next to the real-time one.
// The flood tests hog the event loop (client and server share this process): they go first, alone, while
// the real-time test is only waiting for its qualifying lap and its start lights. Whole suite: ~23 s (the lobby
// tests wait out SET_PER_S / READY_PER_S / START_MIN_MS windows in real time).
// (On the real clock the minimum lap is len / 91.67 m/s = 2.2 s on the shortest track, and the grid takes
// 4 s + 5 lights + the hold: that test cannot be shorter.)
'use strict';
const assert = require('assert');
const nodeNet = require('net');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createServer, IDLE_MS, LOAD_TIMEOUT_MS, START_MIN_MS, SET_PER_S, READY_PER_S } = require('../net/server.js');
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
    // the room as this client knows it (welcome.room, then every `room` message; kept without its t field)
    c.rm = null;
    c.room = () => c.rm;
    c.rs = () => (c.rm ? c.rm.rs : 0);
    // our track of the room's current load cycle is built (ok) or not
    c.loaded = (ok, extra) => c.send(Object.assign({ t: 'loaded', rs: c.rs(), ok: ok !== false }, extra || {}));
    // Grand Prix
    c.gp = () => { const m = c.last('gp'); return m ? m.s : null; };
    c.me = () => c.gp().players.find(p => p.id === c.id && !p.left);
    // the car state; v = speed (m/s), h = heading (rad, 0 = +z, PI / 2 = +x)
    c.px = 0; c.pz = 0; c.placed = false;
    c.drive = (x, z, g, v, h) => {
      c.px = x; c.pz = z; c.placed = true;
      c.send({ t: 's', k: c.rs(), c: Date.now(), s: [x, 0, z, h || 0, 0, 0, v || 0, 0], g });
    };
    // The car drives m metres on along x (one state; the server credits it as far as the time since the car's
    // previous state allows at 130 m/s, up to 5 s of it: the tests step the clock before a lap).
    c.run = (m, g) => { if (!c.placed) c.drive(c.px, c.pz); c.drive(c.px + m, c.pz, g); };
    // A lap the server can believe: the car covers a lap of the test track first, then reports it.
    c.lap = (time, sid, at) => {
      c.run(LEN);
      c.send({ t: 'gl', k: c.rs(), sid: sid === undefined ? c.gp().sid : sid, time, at });
    };
    ws.on('message', d => {
      try { c.msgs.push(JSON.parse(d.toString())); } catch (e) { c.msgs.push({ t: '?raw' }); }
      const m = c.msgs[c.msgs.length - 1];
      const r = m.t === 'room' ? Object.assign({}, m) : m.t === 'welcome' && m.room ? Object.assign({}, m.room) : null;
      if (r) {
        delete r.t;
        if (!c.rm || r.rs !== c.rm.rs) c.placed = false;                    // a new load cycle: the car is not on it yet
        c.rm = r;
      }
    });
    ws.on('close', (code, reason) => { c.closed = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    ws.on('open', async () => {
      if (hello === false) { resolve(c); return; }
      c.send(Object.assign({ t: 'hello', v: 2, name: 'P', colour: '#112233' }, hello || {}));
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
const state = (x, v, k) => ({ t: 's', k: k === undefined ? 1 : k, c: Date.now(), s: [x, 0, 0, 0, 0, 0, v || 0, 0] });
// The car really drives from x0 to x1 along x in n steps of 50 ms (n + 1 states; the speed field tells the truth).
// Its POSITIONS, timed by their arrival, are all the server believes of its motion when it judges an impact report.
async function driveTo(c, x0, x1, z, n) {
  const v = Math.abs(x1 - x0) / (n * 0.05), h = x1 >= x0 ? Math.PI / 2 : -Math.PI / 2;
  for (let k = 0; k <= n; k++) {
    c.drive(x0 + (x1 - x0) * k / n, z, undefined, v, h);
    if (k < n) await sleep(50);
  }
}

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
const lanes = { floods: [], tcp: [], relay: [], gp1: [], gp2: [], gp3: [], client: [], year: [], year2: [], review: [], review2: [], lobby: [], lobby2: [],
  bots: [], bots2: [], botsClient: [] };
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
// Every client still connected ends up with exactly the room the server holds (and that one satisfies pred). -> room
async function syncRoom(srv, clients, pred, ms) {
  let want = '';
  await until(() => {
    const r = srv.info().room;
    if (pred && !pred(r)) return false;
    want = JSON.stringify(r);
    return clients.every(c => c.closed || JSON.stringify(c.room()) === want);
  }, ms || 3000, 'all clients on the same room' + (pred ? ' with ' + pred : ''));
  return JSON.parse(want);
}
// A room of n players, manual clock, shortest hold before lights out, no START_MIN_MS between the host's start / back
// (unless opts says so). cs[0] is the host. The host sets the track (monza) in the lobby; then, unless opts.lobby,
// he starts free practice and everybody loads it: the room is in a free-practice session on the track (what
// protocol 1's track pick gave).
// opts: createServer options, plus cars: the car id each player announces in its hello; lobby: stay in the lobby;
// real: the server's own clock instead of the manual one.
async function room(t, n, opts) {
  opts = opts || {};
  const clk = manualClock();
  const so = Object.assign({ now: clk, random: () => 0, startMinMs: 0 }, opts);
  if (opts.real) delete so.now;                  // real: the server's own clock (the relay tests)
  delete so.cars; delete so.lobby; delete so.real;
  const srv = await t.start(so);
  const cs = [];
  for (let i = 0; i < n; i++) {
    cs.push(await client(srv.port, Object.assign({ name: 'P' + (i + 1) }, opts.cars ? { car: opts.cars[i] } : {},
      i === 0 && opts.hostToken ? { token: opts.hostToken } : {})));
  }
  const r = { srv, clk, cs, settle: (pred, ms) => settle(srv, r.cs, pred, ms), sync: (pred, ms) => syncRoom(srv, r.cs, pred, ms) };
  r.host = () => r.cs.find(c => !c.closed && c.id && c.id === srv.info().host) || null;
  r.len = LEN;                                   // the track length the host's start names
  // the host starts a load cycle with the room's settings (force: whoever is not ready loads too); everybody still
  // connected reports his track built -> the session (in a Grand Prix: qualifying)
  r.go = async () => {
    const rs = srv.info().room.rs + 1;
    r.host().send({ t: 'start', len: r.len, force: true });
    await r.sync(x => x.st === 'loading' && x.rs === rs);
    r.cs.forEach(c => { if (!c.closed) c.loaded(); });
    return r.sync(x => x.st === 'session' && x.rs === rs);
  };
  r.lobby = async () => {
    if (srv.info().room.st !== 'lobby') r.host().send({ t: 'back' });
    return r.sync(x => x.st === 'lobby');
  };
  // free practice: back to the lobby, mode free, start, everybody loads
  r.free = async () => {
    await r.lobby();
    r.host().send({ t: 'set', mode: 'free' });
    await r.sync(x => x.set.mode === 'free');
    return r.go();
  };
  // a Grand Prix of q / rr laps: back to the lobby, the settings (extra: wear, year...; len: the start's length),
  // start, everybody loads -> qualifying
  r.start = async (q, rr, extra) => {
    extra = Object.assign({}, extra);
    r.len = extra.len || LEN;
    delete extra.len;
    await r.lobby();
    const set = Object.assign({ t: 'set', mode: 'gp', q: q, r: rr }, extra);
    r.host().send(set);
    await r.sync(x => x.set.mode === 'gp' && (q === undefined || x.set.q === q) && (rr === undefined || x.set.r === rr));
    await r.go();
    return r.settle(s => s.phase === 'quali');
  };
  // one qualifying lap each, in join order (2.5 s, 2.6 s, ...) -> grid
  r.toGrid = async () => {
    clk.add(3000);
    const drivers = r.cs.filter(c => !c.closed && c.me() && !c.me().spec);
    drivers.forEach((c, i) => c.lap(2.5 + i * 0.1));
    return r.settle(s => s.phase === 'grid');
  };
  r.toRace = async () => { const g = await r.toGrid(); clk.to(g.goAt); return r.settle(s => s.phase === 'race'); };
  cs[0].send({ t: 'set', track: 'monza' });
  await r.sync(x => x.set.track === 'monza');
  if (!opts.lobby) await r.go();
  return r;
}
// a room in the lobby (track set), for the tests that set the room up themselves
const lobbyRoom = (t, n, opts) => room(t, n, Object.assign({ lobby: true }, opts));
// a fresh instance of the real client (js/net.js is a singleton per load)
/* ---------- computer drivers (bots) helpers ---------- */

// The host asks for n bots and waits until every client in `clients` has them in its roster. -> their ids (list order)
async function addBots(host, clients, n, list, skill) {
  host.send(Object.assign({ t: 'bots', n }, list ? { list } : {}, skill ? { skill } : {}));
  for (const c of clients) if (!c.closed) await c.wait(() => c.roster().filter(p => p.bot).length === n, 2000, n + ' bots');
  return host.roster().filter(p => p.bot).sort((x, y) => x.bi - y.bi).map(p => p.id);
}
// the host's bots' states: rows [id, x, y, z, heading, pitch, roll, speed, steer, g?]
function botStates(host, rows, c) { host.send({ t: 'bs', k: host.rs(), c: c === undefined ? Date.now() : c, b: rows }); }
// bot id drives m metres on along x at z (as c.run for the own car; placed at x = 0 on a new track)
function botRun(host, id, m, g, z) {
  host.bx = host.bx || {};
  const seq = host.rs();
  if (!host.bx[id] || host.bx[id].seq !== seq) {
    host.bx[id] = { x: 0, z: z || 0, seq };
    botStates(host, [[id, 0, 0, host.bx[id].z, Math.PI / 2, 0, 0, 0, 0]]);
  }
  host.bx[id].x += m;
  const row = [id, host.bx[id].x, 0, host.bx[id].z, Math.PI / 2, 0, 0, 0, 0];
  if (g !== undefined) row.push(g);
  botStates(host, [row]);
}
// a lap of bot id the server can believe: its states cover a lap of the test track, then the host reports it
function botLap(host, id, time, sid) {
  botRun(host, id, LEN);
  host.send({ t: 'gl', k: host.rs(), sid: sid === undefined ? host.gp().sid : sid, time, id });
}
// real time: bot id really drives from x0 to x1 along x at z in n steps of 50 ms (as driveTo)
async function botDriveTo(host, id, x0, x1, z, n) {
  const v = Math.abs(x1 - x0) / (n * 0.05), h = x1 >= x0 ? Math.PI / 2 : -Math.PI / 2;
  for (let k = 0; k <= n; k++) {
    botStates(host, [[id, x0 + (x1 - x0) * k / n, 0, z, h, 0, 0, v, 0]]);
    if (k < n) await sleep(50);
  }
}

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
    a.send({ t: 'set', track: 'monza', mode: 'gp', q: 1, r: 1 });
    await b.wait(() => b.room().set.track === 'monza' && b.room().set.mode === 'gp');
    b.send({ t: 'ready', on: true });
    await a.wait(() => a.room().ready.includes(b.id));
    a.send({ t: 'start', len: LEN });
    await b.wait(() => b.room().st === 'loading');
    // the default barrier: everybody gets 20 s on the server clock
    assert.strictEqual(b.room().load.until - b.room().load.at, LOAD_TIMEOUT_MS);
    a.loaded(true, { len: LEN }); b.loaded();
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

  T('join / roster / leave; welcome v2: room, ded, no track / seq / year', async t => {
    const srv = await t.start();
    const a = await client(srv.port, { name: 'Alice' });
    const w = a.last('welcome');
    assert.strictEqual(w.host, a.id, 'first player is host on a dedicated server');
    assert.deepStrictEqual(Object.keys(w).sort(), ['bots', 'ded', 'host', 'id', 'now', 'players', 'room', 't', 'v']);
    assert.deepStrictEqual([w.v, w.ded], [2, true]);
    assert.deepStrictEqual(w.room, { st: 'lobby', rs: 0, set: { track: null, year: null, mode: 'free', q: 3, r: 5, wear: 1, bots: 0, skill: 'pro' },
      ready: [], rr: 0, load: null, len: 0 }, 'a fresh room: the lobby with the defaults');
    assert.deepStrictEqual(srv.info().room, w.room);
    const b = await client(srv.port, { name: 'Bob', colour: '#ABCDEF' });
    await a.wait(() => a.roster().length === 2);
    const ros = a.roster();
    assert.deepStrictEqual(ros.map(p => p.name), ['Alice', 'Bob']);
    assert.deepStrictEqual(ros.map(p => p.slot), [0, 1]);
    assert.strictEqual(ros[1].colour, '#abcdef');
    assert.deepStrictEqual(b.last('welcome').players, ros, 'the newcomer gets the roster in its welcome');
    assert(!('year' in a.last('players')), 'the roster no longer carries the year (room.set has it)');
    b.ws.close();
    await a.wait(() => a.roster().length === 1);
    assert(a.last('gone') && a.last('gone').id === b.id);
    // the freed grid slot is reused, the id is not
    const c = await client(srv.port, { name: 'Carol' });
    assert.strictEqual(c.last('welcome').players.find(p => p.id === c.id).slot, 1);
    assert(c.id > b.id);
    a.ws.close(); c.ws.close();
    // an in-game server is not dedicated
    const s2 = await t.start({ hostToken: 'tok' });
    const h = await client(s2.port, { token: 'tok' });
    assert.deepStrictEqual([h.last('welcome').ded, s2.info().ded], [false, false]);
    h.ws.close();
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

  T('host migration on a dedicated server: the settings stay with the room, the new host sets them', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port), c = await client(srv.port);
    assert.strictEqual(c.last('welcome').host, a.id);
    // a guest cannot set the room up (nor with protocol 1's track message)
    b.send({ t: 'set', track: 'monza' }); b.send({ t: 'track', id: 'monza' });
    await sleep(120);
    assert.deepStrictEqual([c.all('room').length, srv.info().room.set.track], [0, null]);
    a.send({ t: 'set', track: 'spa', year: 2024 });
    await c.wait(() => c.room().set.track === 'spa');
    b.send({ t: 'ready', on: true });
    await c.wait(() => c.room().ready.includes(b.id));
    a.ws.close();
    await c.wait(() => c.host() === b.id && c.room().ready.length === 0, 2000, 'b hosts and is no longer listed as ready');
    assert.deepStrictEqual([c.room().set.track, c.room().set.year], ['spa', 2024], 'the settings stay');
    b.send({ t: 'set', track: 'monza' });
    await c.wait(() => c.room().set.track === 'monza');
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
    g.send({ t: 'set', track: 'spa' }); g.send({ t: 'start', len: LEN, force: true });
    await sleep(100);
    assert.deepStrictEqual([h.all('room').length, g.all('nostart').length, srv.info().room.set.track], [0, 0, null], 'guest must not set up / start');
    h.ws.close();
    await g.wait(() => g.host() === 0);
    g.send({ t: 'set', track: 'spa' });
    await sleep(100);
    assert.strictEqual(srv.info().room.set.track, null, 'nobody hosts a token room without its host');
    g.ws.close(); bad.ws.close();
  });

  T('set: host only, lobby only, every field validated (never clamped); late joiner gets the room in welcome; coalesced, rate-limited', async t => {
    const srv = await t.start();
    const a = await client(srv.port), b = await client(srv.port);
    a.send({ t: 'set', track: 'suzuka' });
    await b.wait(() => b.room().set.track === 'suzuka');
    await a.wait(() => a.room().set.track === 'suzuka', 1000, 'the host gets the broadcast too');
    assert.deepStrictEqual(b.room(), srv.info().room);
    const c = await client(srv.port);
    assert.strictEqual(c.last('welcome').room.set.track, 'suzuka');
    // hostile values: each ignored, never clamped into another meaning; the valid ones apply
    await sleep(120);
    const n = b.all('room').length, before = JSON.stringify(srv.info().room);
    for (const bad of ['', '../etc', '../../x', 'a b', 'x'.repeat(65), 5, null, { a: 1 }, ['spa'], true, '__proto__x/', 'spa\n']) a.send({ t: 'set', track: bad });
    await sleep(150);
    for (const m of [{ q: 1e9 }, { q: 0 }, { q: 21 }, { r: -1 }, { r: 100 }, { r: '5' }, { wear: 6 }, { wear: 0.4 }, { wear: '3' }, { year: 1999 }, { year: 2101 },
      { year: 2024.5 }, { year: '2024' }, { mode: 'race' }, { mode: 'GP' }, { mode: null }, { q: null, r: {}, wear: [] }]) a.send(Object.assign({ t: 'set' }, m));
    a.send('{"t":"set","q":1e999,"r":-1e999,"wear":1e999,"year":1e999}'); a.send('{"t":"set"}'); a.send('{"t":"SET","track":"spa"}');
    await sleep(250);
    assert.strictEqual(JSON.stringify(srv.info().room), before, 'nothing changed');
    assert.strictEqual(b.all('room').length, n, 'nothing changed, nothing broadcast');
    // a guest's set (all valid) changes nothing
    b.send({ t: 'set', track: 'spa', year: 2020, mode: 'gp', q: 2, r: 2, wear: 2 });
    await sleep(150);
    assert.strictEqual(JSON.stringify(srv.info().room), before, 'a guest cannot');
    await sleep(1000);                                           // (SET_PER_S: the junk used this second up)
    // a mix: the valid fields apply, the others are ignored; wear 2.5 rounds to 3, q 2.4 to 2
    a.send({ t: 'set', track: '../x', year: 2024, mode: 'race', q: 2.4, r: 1e9, wear: 2.5 });
    await b.wait(() => b.room().set.year === 2024);
    assert.deepStrictEqual(b.room().set, { track: 'suzuka', year: 2024, mode: 'free', q: 2, r: 5, wear: 3, bots: 0, skill: 'pro' });
    a.send({ t: 'set', track: 'a.B_c-9', mode: 'gp', q: 20, r: 99, wear: 5, year: 2100 });
    await b.wait(() => b.room().set.track === 'a.B_c-9');
    assert.deepStrictEqual(b.room().set, { track: 'a.B_c-9', year: 2100, mode: 'gp', q: 20, r: 99, wear: 5, bots: 0, skill: 'pro' });
    a.send({ t: 'set', q: 1, r: 1, wear: 1, year: 2010, mode: 'free' });
    await b.wait(() => b.room().set.q === 1 && b.room().set.year === 2010);
    // a host clicking through tracks (or a hostile one): at most SET_PER_S a second are taken, and the room goes out
    // coalesced (at most one per 100 ms tick), the last state always
    await sleep(1100);
    const n1 = b.all('room').length, t0 = Date.now();
    for (let i = 0; i < 100; i++) a.send({ t: 'set', track: 'track-' + i });
    await b.wait(() => b.room().set.track === 'track-' + (SET_PER_S - 1), 2000, 'the last pick taken');
    await sleep(300);
    const got = b.all('room').length - n1;
    assert.strictEqual(srv.info().room.set.track, 'track-' + (SET_PER_S - 1), 'SET_PER_S a second: the rest dropped');
    assert(got >= 1 && got <= 2 + (Date.now() - t0) / 100, 'room broadcasts for 100 picks: ' + got);
    // a pick in the next second is taken again
    await sleep(1000);
    a.send({ t: 'set', track: 'next' });
    await b.wait(() => b.room().set.track === 'next');
    // the settings stay with the room after its host is gone; the next host changes them
    a.ws.close();
    await b.wait(() => b.host() === b.id);
    assert.strictEqual(srv.info().room.set.track, 'next');
    b.send({ t: 'set', track: 'mine' });
    await c.wait(() => c.room().set.track === 'mine');
    b.ws.close(); c.ws.close();
  });

  T('snapshot relay at ~20 Hz, validated and clamped (in the session only, with the cycle\'s k)', async t => {
    const R = await room(t, 2, { real: true });
    const [a, b] = R.cs;
    const timer = setInterval(() => a.send(state(Math.random() * 100, 50, a.rs())), 25);
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
    a.send({ t: 's', k: a.rs(), c: 1, s: [1e30, -1e30, 5, 100, 9, -9, 1e9, 7] });
    await b.wait(() => b.all('snap').length > n0);
    const c = b.last('snap').p[0];
    assert(Math.abs(c[2]) <= 1e5 && Math.abs(c[8]) <= 130 && Math.abs(c[9]) <= 1 && Math.abs(c[6]) <= 1.2, JSON.stringify(c));
    const n1 = b.all('snap').length;
    for (const s of [[1, 2, 3], 'x', null, [1, 2, 3, 4, 5, 6, 7, 'a'], [1, 2, 3, 4, 5, 6, 7, null], [NaN, 0, 0, 0, 0, 0, 0, 0]]) {
      a.send({ t: 's', k: a.rs(), c: 2, s });
    }
    a.send({ t: 's', k: 99, c: 3, s: [0, 0, 0, 0, 0, 0, 0, 0] });      // another load cycle
    a.send({ t: 's', k: a.rs() - 1, c: 3, s: [0, 0, 0, 0, 0, 0, 0, 0] });
    a.send({ t: 's', k: String(a.rs()), c: 3, s: [0, 0, 0, 0, 0, 0, 0, 0] });
    a.send({ t: 's', c: 3, s: [0, 0, 0, 0, 0, 0, 0, 0] });
    a.send('{"t":"s","k":' + a.rs() + ',"c":1e999,"s":[0,0,0,0,0,0,0,0]}');  // Infinity timestamp
    await sleep(200);
    assert.strictEqual(b.all('snap').length, n1, 'malformed states must not be relayed');
    // in the lobby and while loading nobody is on a track: states are dropped, nothing relayed
    await R.lobby();
    const n2 = b.all('snap').length;
    for (let i = 0; i < 5; i++) { a.send(state(i, 10, a.rs())); a.send(state(i, 10, a.rs() + 1)); await sleep(30); }
    a.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    for (let i = 0; i < 5; i++) { a.send(state(i, 10, a.rs())); await sleep(30); }
    await sleep(150);
    assert.strictEqual(b.all('snap').length, n2, 'no snapshot in the lobby / while loading');
    assert.strictEqual(R.srv.info().room.st, 'loading');
    a.loaded(); b.loaded();
    await R.sync(x => x.st === 'session');
    a.send(state(3, 10, a.rs()));
    await b.wait(() => b.all('snap').length > n2, 1000, 'relayed again in the session');
    a.ws.close(); b.ws.close();
  });

  T('lap times are shared through the roster (in the session only; cleared by a start and by the lobby)', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    a.send({ t: 'lap', k: a.rs(), last: 83.4567, best: 82.1 });
    await b.wait(() => b.roster().find(p => p.id === a.id).best === 82.1);
    a.send({ t: 'lap', k: a.rs(), last: 'x', best: -5 });
    await b.wait(() => b.roster().find(p => p.id === a.id).best === null);
    a.send({ t: 'lap', k: a.rs(), last: 80, best: 80 });
    await b.wait(() => b.roster().find(p => p.id === a.id).best === 80);
    a.send({ t: 'lap', k: a.rs() + 1, last: 70, best: 70 }); a.send({ t: 'lap', last: 70, best: 70 });
    await sleep(150);
    assert.strictEqual(b.roster().find(p => p.id === a.id).best, 80, 'another cycle\'s / no k: dropped');
    await R.lobby();
    await b.wait(() => b.roster().find(p => p.id === a.id).best === null, 1000, 'cleared in the lobby');
    a.send({ t: 'lap', k: a.rs(), last: 70, best: 70 });
    await sleep(150);
    assert.strictEqual(R.srv.info().players[0].best, null, 'dropped in the lobby');
    a.ws.close(); b.ws.close();
  });

  T('impact reports go to the target only, clamped and throttled; only between cars that are near each other', async t => {
    const R = await room(t, 3, { real: true });
    const [a, b, c] = R.cs;
    const k = a.rs();
    a.send({ t: 'hit', k, to: b.id, i: [3, -4] });                     // nobody has reported a position yet
    await sleep(80);
    assert.strictEqual(b.last('hit'), null, 'a car that is not on the track cannot hit');
    // a drives at 90 m/s along +x up to b (parked 4 m ahead); c is parked half a kilometre away
    const near = async () => { b.drive(14, 10); c.drive(500, 10); await driveTo(a, -3.5, 10, 10, 3); };
    await near();
    a.send({ t: 'hit', k, to: b.id, i: [3, -4] });
    await b.wait(() => b.last('hit'));
    assert.deepStrictEqual(b.last('hit'), { t: 'hit', from: a.id, i: [3, -4] });
    await near();
    a.send({ t: 'hit', k, to: b.id, i: [3000, 0] });
    await b.wait(() => b.all('hit').length === 2);
    assert.deepStrictEqual(b.last('hit').i, [50, 0], 'HIT_MAX');
    await near();
    for (let i = 0; i < 20; i++) a.send({ t: 'hit', k, to: b.id, i: [1, 1] });      // burst: only one passes
    for (const bad of [{ to: a.id, i: [1, 1] }, { to: 999, i: [1, 1] }, { to: b.id, i: [1] }, { to: b.id, i: ['x', 1] },
      { to: b.id, i: [0, 0] }, { to: 'b', i: [1, 1] }, { to: b.id }]) a.send(Object.assign({ t: 'hit', k }, bad));
    a.send({ t: 'hit', k: 7, to: b.id, i: [1, 1] });
    await sleep(150);
    assert.strictEqual(b.all('hit').length, 3);
    a.send({ t: 'hit', k, to: c.id, i: [5, 5] });                      // c is half a kilometre away
    c.send({ t: 'hit', k, to: a.id, i: [5, 5] });
    await sleep(100);
    assert.strictEqual(c.all('hit').length + a.all('hit').length, 0, 'nobody else gets it, and no hits from afar');
    a.ws.close(); b.ws.close(); c.ws.close();
  });

  T('malformed / oversized messages do not crash the server', async t => {
    const srv = await t.start();
    const a = await client(srv.port), good = await client(srv.port);
    for (const junk of ['', 'not json', '{', '[]', 'null', '123', '"str"', '{"t":5}', '{"t":"nope"}', '{"t":"hello"}',
      '{"t":"s"}', '{"t":"track"}', '{"t":"profile"}', '{"t":"lap"}', '{"__proto__":{"t":"track"}}', '{"__proto__":{"t":"set","track":"x"}}',
      '{"t":"s","s":{"length":8}}', '{"t":"constructor"}', '{"t":"toString"}', '{"t":"set","__proto__":{"track":"evil"}}',
      '{"t":"loaded"}', '{"t":"ready"}', '{"t":"start"}', '{"t":"go"}', '{"t":"back"}', '{"t":"set","track":{"toString":1}}']) a.send(junk);
    a.ws.send(Buffer.from([0, 1, 2, 3, 255]));                 // binary frame
    await sleep(100);
    assert.strictEqual(a.closed, null, 'junk alone does not get you kicked');
    assert.strictEqual(srv.info().room.set.track, null, 'no prototype field became a setting');
    a.send('x'.repeat(5000));                                   // over maxPayload
    await a.wait(() => a.closed);
    assert.strictEqual(a.closed.code, 1009);
    // a socket that never says hello and sends only garbage
    const raw = await client(srv.port, false);
    raw.send({ t: 'set', track: 'monza' });
    raw.send({ t: 'start', len: LEN, force: true });
    raw.send(state(1, 1));
    raw.send({ t: 'loaded', rs: 1, ok: true });
    raw.send({ t: 'gl', k: 0, sid: 0, time: 3 });
    raw.send({ t: 'ping', c: 1 });
    await sleep(100);
    assert.strictEqual(good.all('room').length, 0, 'messages before hello are ignored');
    assert.strictEqual(raw.msgs.length, 0, 'and not answered');
    raw.ws.terminate();
    // the server still works
    good.send({ t: 'set', track: 'monza' });   // good is host now (a left)
    await good.wait(() => good.room().set.track === 'monza');
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

  T('protocol 2: any other hello v is rejected with error version, need 2', async t => {
    const srv = await t.start();
    for (const v of [999, 1, 3, '2', null, 2.5, [2], undefined]) {
      const x = await client(srv.port, { v });
      await x.wait(() => x.closed);
      assert.deepStrictEqual([x.id, x.last('error'), x.closed.code], [0, { t: 'error', code: 'version', need: 2 }, 1008], JSON.stringify(v));
    }
    const ok = await client(srv.port, { v: 2 });
    assert(ok.id > 0);
    assert.strictEqual(srv.info().players.length, 1);
    ok.ws.close();
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

  lane = lanes.year;
  T('room year: room.set.year, host only, lobby only, a whole 2010..2100, in welcome.room; stays with the room', async t => {
    const srv = await t.start({ startMinMs: 0 });
    const a = await client(srv.port, { name: 'Host' }), b = await client(srv.port, { name: 'Guest' });
    assert.strictEqual(a.last('welcome').room.set.year, null, 'no year until the host picks one');
    b.send({ t: 'set', year: 2020 });                                             // not the host
    for (const bad of [2009, 2101, 2024.5, '2024', null, {}, [2024], true, -2024, 0]) a.send({ t: 'set', year: bad });
    a.send('{"t":"set","year":1e999}'); a.send({ t: 'year', y: 2020 }); a.send({ t: 'SET', year: 2020 }); a.send({ t: 'set', y: 2020 });
    await sleep(200);
    assert.strictEqual(srv.info().room.set.year, null, 'all refused (protocol 1\'s year message too)');
    await sleep(1000);                                                            // (SET_PER_S: the junk used this second up)
    a.send({ t: 'set', year: 2024 });
    await b.wait(() => b.room().set.year === 2024);
    assert.strictEqual(srv.info().year, 2024, 'srv.info().year = room.set.year');
    await a.wait(() => a.room().set.year === 2024, 1000, 'the host hears it too');
    const c = await client(srv.port, { name: 'Late' });
    assert.strictEqual(c.last('welcome').room.set.year, 2024);
    // a host scrolling through the seasons: the room ends on the last one, everybody with it
    await sleep(1050);
    for (let y = 2010; y <= 2018; y++) a.send({ t: 'set', year: y });
    await c.wait(() => c.room().set.year === 2018, 2000, 'the last pick');
    // the year changes only in the lobby (parc fermé while loading and in a session)
    a.send({ t: 'set', track: 'monza' });
    await c.wait(() => c.room().set.track === 'monza');
    a.send({ t: 'start', len: LEN, force: true });
    await c.wait(() => c.room().st === 'loading');
    a.send({ t: 'set', year: 2019 });
    [a, b, c].forEach(x => x.loaded());
    await c.wait(() => c.room().st === 'session');
    a.send({ t: 'set', year: 2019 });
    await sleep(150);
    assert.strictEqual(srv.info().room.set.year, 2018, 'not while loading / in a session');
    a.send({ t: 'back' });
    await c.wait(() => c.room().st === 'lobby');
    await sleep(1000);                                                            // (SET_PER_S)
    a.send({ t: 'set', year: 2012 });
    await c.wait(() => c.room().set.year === 2012);
    // the year itself stays with the room: host migration, an empty room
    a.ws.close();
    await c.wait(() => c.host() === b.id);
    assert.strictEqual(c.room().set.year, 2012);
    b.send({ t: 'set', year: 2013 });                                             // the new host picks
    await c.wait(() => c.room().set.year === 2013);
    b.ws.close();
    await c.wait(() => c.host() === c.id);
    c.ws.close();
    await until(() => srv.info().players.length === 0, 2000, 'empty room');
    const d = await client(srv.port, { name: 'Next' });
    assert.deepStrictEqual([d.last('welcome').room.set.year, d.last('welcome').room.set.track, d.last('welcome').host], [2013, 'monza', d.id],
      'an empty room keeps its settings');
    d.ws.close();

    // in-game (token) server: without its host nobody can change the year
    const s2 = await t.start({ hostToken: 'tok' });
    const h = await client(s2.port, { name: 'H', token: 'tok' }), g = await client(s2.port, { name: 'G' });
    g.send({ t: 'set', year: 2018 });
    h.send({ t: 'set', year: 2019 });
    await g.wait(() => g.room().set.year === 2019);
    h.ws.close();
    await g.wait(() => g.host() === 0);
    g.send({ t: 'set', year: 2020 });
    await sleep(150);
    assert.deepStrictEqual([s2.info().room.set.year, g.room().set.year], [2019, 2019]);
    g.ws.close();
  });

  /* ---------- the room lobby (protocol 2, v7.2) ---------- */
  lane = lanes.lobby;

  T('lobby: ready (guests only, booleans only, lobby only, rate-limited); a change of track / year / mode clears it (rr + 1), laps / wear / bots do not', async t => {
    const R = await lobbyRoom(t, 3);
    const [a, b, c] = R.cs;
    // nobody is on a track in the lobby
    assert.deepStrictEqual([R.srv.info().room.st, R.srv.info().room.rs, R.srv.info().room.load, R.srv.info().room.len], ['lobby', 0, null, 0]);
    b.send({ t: 'ready', on: true });
    await R.sync(x => x.ready.length === 1);
    assert.deepStrictEqual(c.room().ready, [b.id]);
    // the host is never listed; anything but a boolean is ignored
    a.send({ t: 'ready', on: true });
    for (const on of [1, 'true', null, {}, [true], undefined]) c.send({ t: 'ready', on });
    c.send('{"t":"ready","on":1e999}');
    await sleep(150);
    await sleep(1000);                                           // (c's ready messages of this second are used up)
    assert.deepStrictEqual(R.srv.info().room.ready, [b.id]);
    c.send({ t: 'ready', on: true });
    await R.sync(x => x.ready.length === 2);
    b.send({ t: 'ready', on: false });
    await R.sync(x => x.ready.length === 1);
    assert.deepStrictEqual(R.srv.info().room.ready, [c.id]);
    b.send({ t: 'ready', on: true });
    await R.sync(x => x.ready.length === 2);
    // laps, wear, bots: ready stays
    const rr = R.srv.info().room.rr;
    a.send({ t: 'set', q: 4, r: 6, wear: 2 });
    await R.sync(x => x.set.q === 4);
    a.send({ t: 'bots', n: 2, skill: 'rookie' });
    await R.sync(x => x.set.bots === 2 && x.set.skill === 'rookie');
    assert.deepStrictEqual([R.srv.info().room.ready.length, R.srv.info().room.rr], [2, rr]);
    // track / year / mode: cleared, rr + 1 (each message that changes one of them)
    await sleep(1000);
    for (const [m, k] of [[{ track: 'spa' }, 'track'], [{ year: 2022 }, 'year'], [{ mode: 'gp' }, 'mode']]) {
      b.send({ t: 'ready', on: true }); c.send({ t: 'ready', on: true });
      await R.sync(x => x.ready.length === 2);
      const rr0 = R.srv.info().room.rr;
      a.send(Object.assign({ t: 'set' }, m));
      const x = await R.sync(y => y.set[k] === m[k]);
      assert.deepStrictEqual([x.ready, x.rr], [[], rr0 + 1], k);
      await sleep(400);                                          // (at most 5 ready messages a second each)
    }
    // the same value again: nothing changes, nothing cleared
    b.send({ t: 'ready', on: true });
    await R.sync(x => x.ready.length === 1);
    a.send({ t: 'set', track: 'spa', mode: 'gp' });
    await sleep(150);
    assert.deepStrictEqual(R.srv.info().room.ready, [b.id]);
    // ready flooding: READY_PER_S a second taken, the room goes out coalesced
    await sleep(1050);
    const n = a.all('room').length, t0 = Date.now();
    for (let i = 0; i < 200; i++) c.send({ t: 'ready', on: i % 2 === 0 });
    await sleep(400);
    const got = a.all('room').length - n;
    assert(got <= 2 + (Date.now() - t0) / 100, 'room broadcasts for 200 ready flips: ' + got);
    assert(READY_PER_S === 5);
    assert.deepStrictEqual(R.srv.info().room.ready.includes(c.id), true, 'the 5th of 5 taken (on), the rest dropped');
    await R.sync();
    // in a session ready is not a thing
    await R.go();
    const ready0 = JSON.stringify(R.srv.info().room.ready);
    c.send({ t: 'ready', on: false }); b.send({ t: 'ready', on: false });
    await sleep(150);
    assert.strictEqual(JSON.stringify(R.srv.info().room.ready), ready0, 'not outside the lobby');
    // back to the lobby: everybody's ready is cleared (without an rr change: not a settings change)
    const rr1 = R.srv.info().room.rr;
    await R.lobby();
    assert.deepStrictEqual([R.srv.info().room.ready, R.srv.info().room.rr], [[], rr1]);
    // a guest leaving takes his flag along
    await sleep(1000);
    b.send({ t: 'ready', on: true });
    await R.sync(x => x.ready.length === 1);
    b.ws.close();
    await R.sync(x => x.ready.length === 0);
    R.cs.forEach(x => x.ws.close());
  });

  T('lobby: start rules (nostart to the host only: state, track, len, busy, not-ready with the ids; force); guests cannot start / go / back', async t => {
    const clk = manualClock();
    const srv = await t.start({ now: clk });                    // START_MIN_MS as it is
    const a = await client(srv.port, { name: 'H' }), b = await client(srv.port, { name: 'B' }), c = await client(srv.port, { name: 'C' });
    const why = async (m, from) => {
      from = from || a;
      const n = from.all('nostart').length;
      from.send(Object.assign({ t: 'start' }, m));
      await from.wait(() => from.all('nostart').length > n, 1000, 'nostart for ' + JSON.stringify(m));
      return from.last('nostart');
    };
    assert.deepStrictEqual(await why({ len: LEN }), { t: 'nostart', why: 'track' }, 'no track yet');
    a.send({ t: 'set', track: 'monza' });
    await c.wait(() => c.room().set.track === 'monza');
    for (const len of [50, 199, 100001, '5000', null, [5000], {}, undefined]) assert.deepStrictEqual(await why({ len }), { t: 'nostart', why: 'len' }, JSON.stringify(len));
    a.send('{"t":"start","len":1e999}');
    await a.wait(() => a.last('nostart') && a.all('nostart').length === 10);
    assert.strictEqual(a.last('nostart').why, 'len');
    assert.deepStrictEqual(await why({ len: LEN }), { t: 'nostart', why: 'not-ready', wait: [b.id, c.id] });
    b.send({ t: 'ready', on: true });
    await a.wait(() => a.room().ready.includes(b.id));
    assert.deepStrictEqual(await why({ len: LEN, force: 1 }), { t: 'nostart', why: 'not-ready', wait: [c.id] }, 'force must be true');
    // a guest's start / go / back: no effect, no answer
    for (const m of [{ t: 'start', len: LEN, force: true }, { t: 'go' }, { t: 'back' }]) { b.send(m); c.send(m); }
    await sleep(150);
    assert.deepStrictEqual([srv.info().room.st, b.all('nostart').length + c.all('nostart').length], ['lobby', 0]);
    // nobody but the host hears about refusals
    assert.strictEqual(b.all('nostart').length + c.all('nostart').length, 0);
    // force: c (not ready) loads too
    a.send({ t: 'start', len: LEN, force: true });
    await c.wait(() => c.room().st === 'loading');
    const r1 = c.room();
    assert.deepStrictEqual([r1.rs, r1.load.at, r1.load.until, r1.load.wait, r1.load.done, r1.load.fail, r1.len],
      [1, clk(), clk() + LOAD_TIMEOUT_MS, [a.id, b.id, c.id], [], [], 0]);
    assert.deepStrictEqual(await why({ len: LEN, force: true }), { t: 'nostart', why: 'state' }, 'during loading');
    // back within START_MIN_MS of the start: dropped; after it: the lobby
    a.send({ t: 'back' });
    await sleep(150);
    assert.strictEqual(srv.info().room.st, 'loading', 'back within a second of the start is dropped');
    await sleep(START_MIN_MS - 100);
    a.send({ t: 'back' });
    await c.wait(() => c.room().st === 'lobby');
    // start right after back: busy; a second later: on
    assert.deepStrictEqual(await why({ len: LEN, force: true }), { t: 'nostart', why: 'busy' });
    await sleep(START_MIN_MS + 50);
    a.send({ t: 'start', len: LEN, force: true });
    await c.wait(() => c.room().st === 'loading' && c.room().rs === 2);
    a.send({ t: 'start', len: LEN, force: true });              // twice
    await a.wait(() => a.last('nostart').why === 'state');
    // go before his own track is built: dropped (and within START_MIN_MS anyway); after both: the session
    await sleep(START_MIN_MS + 50);
    a.send({ t: 'go' });
    await sleep(150);
    assert.strictEqual(srv.info().room.st, 'loading', 'go before the host loaded');
    a.loaded(true, { len: LEN });
    await sleep(100);
    b.send({ t: 'go' });
    await sleep(100);
    assert.strictEqual(srv.info().room.st, 'loading', 'a guest\'s go');
    a.send({ t: 'go' });
    await c.wait(() => c.room().st === 'session');
    assert.deepStrictEqual([srv.info().room.len, srv.info().gp.phase], [LEN, 'free'], 'mode free: no Grand Prix');
    // start in a session: state
    assert.deepStrictEqual(await why({ len: LEN, force: true }), { t: 'nostart', why: 'state' });
    [a, b, c].forEach(x => x.ws.close());
  });

  T('lobby: the loading barrier (all loaded / the deadline / the host\'s go / nobody loaded); failed loaders out of the session and back in the lobby; the host\'s length', async t => {
    const R = await lobbyRoom(t, 3);
    const [a, b, c] = R.cs, clk = R.clk;
    const order = x => x.msgs.filter(m => m.t === 'room' || m.t === 'gp').map(m => m.t === 'room' ? 'room ' + m.st : 'gp ' + m.s.phase);
    // 1. a Grand Prix, everybody loads: qualifying starts only at the barrier
    a.send({ t: 'set', mode: 'gp', q: 1, r: 1, wear: 2, year: 2024 });
    await R.sync(x => x.set.mode === 'gp' && x.set.year === 2024);
    a.send({ t: 'start', len: 5000, force: true });
    await R.sync(x => x.st === 'loading');
    const sid0 = R.srv.info().gp.sid;
    a.loaded(true, { len: 5800 }); b.loaded();
    await R.sync(x => x.load.done.length === 2);
    assert.deepStrictEqual([R.srv.info().room.load.wait, R.srv.info().room.load.done, R.srv.info().gp.phase, R.srv.info().gp.sid],
      [[c.id], [a.id, b.id], 'free', sid0], 'the barrier holds: no qualifying yet');
    c.loaded();
    let g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual([g.sid, g.q, g.r, g.len, g.year, g.wear], [sid0 + 1, 1, 1, 5000, 2024, 2], 'the room\'s settings; 5800 is 16 % off 5000: the start\'s length');
    assert.deepStrictEqual([R.srv.info().room.st, R.srv.info().room.load, R.srv.info().room.len], ['session', null, 5000]);
    const seen = order(c).slice(-2);
    assert.deepStrictEqual(seen, ['room session', 'gp quali'], 'the room message before the gp it causes');
    // the host's length when within 15 % of the start's
    await R.lobby();
    a.send({ t: 'start', len: 5000, force: true });
    await R.sync(x => x.st === 'loading');
    a.loaded(true, { len: 5700 }); b.loaded(true, { len: 1000 }); c.loaded(true, { len: 9000 });
    g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual([g.len, R.srv.info().room.len], [5700, 5700], 'the host\'s built length (a guest\'s is not used)');
    // 2. the deadline: c never loads; at load.until the session starts with him in it (he joins it when built)
    await R.lobby();
    a.send({ t: 'set', mode: 'free' });
    await R.sync(x => x.set.mode === 'free');
    a.send({ t: 'start', len: LEN, force: true });
    let r = await R.sync(x => x.st === 'loading');
    a.loaded(); b.loaded();
    await R.sync(x => x.load.wait.length === 1);
    clk.to(r.load.until - 1);
    await sleep(250);
    assert.strictEqual(R.srv.info().room.st, 'loading', '1 ms before the deadline');
    clk.to(r.load.until);
    r = await R.sync(x => x.st === 'session');
    assert.deepStrictEqual([r.rs, R.srv.info().gp.players.map(p => p.id)], [3, [a.id, b.id, c.id]], 'the late one is still in the session');
    c.loaded();                                                  // ...and reports later: no barrier any more
    await sleep(100);
    assert.strictEqual(R.srv.info().room.st, 'session');
    // 3. the host's go, once his own track is built; failed loaders are taken out of the session
    await R.lobby();
    a.send({ t: 'set', mode: 'gp', q: 2 });
    await R.sync(x => x.set.mode === 'gp' && x.set.q === 2);
    a.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    b.loaded(false, { why: 'no-track' });
    await R.sync(x => x.load.fail.length === 1);
    assert.deepStrictEqual(R.srv.info().room.load.fail, [b.id]);
    a.loaded();
    await R.sync(x => x.load.done.length === 1);
    a.send({ t: 'go' });
    g = await R.settle(s => s.phase === 'quali');
    assert.deepStrictEqual(g.players.map(p => p.id), [a.id, c.id], 'b (no track) is out of the session; c (still loading) is in');
    c.loaded(false, { why: 'error' });                           // c joins the session late and cannot build it: out too
    g = await R.settle(s => s.players.length === 1);
    assert.deepStrictEqual(g.players.map(p => p.id), [a.id]);
    // back to the lobby: both are in the session again
    a.send({ t: 'back' });
    g = await R.settle(s => s.phase === 'free' && s.players.length === 3);
    assert.deepStrictEqual(g.players.map(p => p.id).sort(), [a.id, b.id, c.id].sort());
    // 4. nobody loaded: back to the lobby, nostart 'load' to the host
    await R.sync(x => x.st === 'lobby');
    a.send({ t: 'start', len: LEN, force: true });
    r = await R.sync(x => x.st === 'loading');
    a.loaded(false); b.loaded(false);
    await R.sync(x => x.load.fail.length === 2);
    clk.to(r.load.until);
    await R.sync(x => x.st === 'lobby');
    await a.wait(() => a.last('nostart') && a.last('nostart').why === 'load', 1000, 'nostart load');
    assert.deepStrictEqual([b.all('nostart').length, c.all('nostart').length, R.srv.info().gp.phase], [0, 0, 'free']);
    // 5. the only one who loaded leaves: nobody (present) loaded
    const ns = a.all('nostart').length;
    a.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    b.loaded();
    await R.sync(x => x.load.done.length === 1);
    b.ws.close();
    await R.sync(x => x.load.wait.length === 2 && x.load.done.length === 0);
    // ...and everybody else leaving the wait list completes the barrier: a fails, c leaves
    a.loaded(false);
    c.ws.close();
    await R.sync(x => x.st === 'lobby');
    await a.wait(() => a.all('nostart').length === ns + 1, 1000, 'nostart load again');
    assert.strictEqual(a.last('nostart').why, 'load');
    a.ws.close();
  });

  T('lobby: loaded spoofing (another rs, twice, before a start, len from a guest, in the lobby) and car states / laps / impacts outside the session', async t => {
    const R = await lobbyRoom(t, 3);
    const [a, b, c] = R.cs;
    const room0 = JSON.stringify(R.srv.info().room);
    // before any start, in the lobby: nothing
    for (const c1 of [a, b]) {
      c1.send({ t: 'loaded', rs: 0, ok: true }); c1.send({ t: 'loaded', rs: 1, ok: true, len: 5000 });
      c1.send(state(1, 1, 0)); c1.send(state(1, 1, 1));
      c1.send({ t: 'lap', k: 0, last: 80, best: 80 }); c1.send({ t: 'gl', k: 0, sid: 0, time: 80 }); c1.send({ t: 'hit', k: 0, to: c.id, i: [1, 0] });
      c1.send({ t: 'bs', k: 0, c: 1, b: [] }); c1.send({ t: 'gp', a: 'skip' }); c1.send({ t: 'gp', a: 'end' }); c1.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN });
    }
    await sleep(200);
    assert.strictEqual(JSON.stringify(R.srv.info().room), room0);
    assert.deepStrictEqual([c.all('snap').length, c.all('hit').length, a.all('glno').length + b.all('glno').length, R.srv.info().gp.sid],
      [0, 0, 0, 0], 'nothing relayed, nothing answered, no session started (gp start is not a thing in protocol 2)');
    assert(R.srv.info().players.every(p => p.best === null));
    a.send({ t: 'start', len: 5000, force: true });
    await R.sync(x => x.st === 'loading');
    // while loading: no states, no laps
    b.send(state(1, 1, 1)); b.send({ t: 'lap', k: 1, last: 80, best: 80 });
    // spoofing: another rs, garbage rs, the host's len from a guest, twice
    b.send({ t: 'loaded', rs: 0, ok: true }); b.send({ t: 'loaded', rs: 2, ok: true }); b.send({ t: 'loaded', rs: '1', ok: true });
    b.send({ t: 'loaded', ok: true });
    await sleep(150);
    assert.deepStrictEqual(R.srv.info().room.load.wait, [a.id, b.id, c.id], 'another rs / none: ignored');
    b.send({ t: 'loaded', rs: 1, ok: true, len: 9000, why: '<script>' });
    b.send({ t: 'loaded', rs: 1, ok: false, why: 'no-track' });                     // the second one: ignored
    c.send({ t: 'loaded', rs: 1, ok: 'yes' });                                       // not true: a failure
    await R.sync(x => x.load.done.length === 1 && x.load.fail.length === 1);
    assert.deepStrictEqual([R.srv.info().room.load.done, R.srv.info().room.load.fail], [[b.id], [c.id]]);
    assert.deepStrictEqual([c.all('snap').length, R.srv.info().players.every(p => p.best === null)], [0, true], 'nothing taken while loading');
    // a car change while loading: kept (parc fermé); name and colour change
    b.send({ t: 'profile', name: 'Bee', car: '2024-ferrari' });
    await a.wait(() => a.roster().find(p => p.id === b.id).name === 'Bee');
    assert.strictEqual(a.roster().find(p => p.id === b.id).car, '');
    a.loaded(true, { len: 5100 });
    await R.sync(x => x.st === 'session');
    assert.strictEqual(R.srv.info().room.len, 5100, 'the host\'s length, not the guest\'s 9000');
    // a loaded report in the session, again / of another cycle: ignored
    a.send({ t: 'loaded', rs: 1, ok: false }); b.send({ t: 'loaded', rs: 1, ok: false });
    await sleep(150);
    assert.deepStrictEqual(R.srv.info().gp.players.map(p => p.id), [a.id, b.id], 'only c (failed) is out');
    // free practice: the car can change now
    b.send({ t: 'profile', car: '2024-ferrari' });
    await a.wait(() => a.roster().find(p => p.id === b.id).car === '2024-ferrari');
    // states of the cycle are relayed now (b sends with the right k)
    b.drive(3, 0);
    await c.wait(() => c.all('snap').length > 0, 1000, 'states in the session');
    R.cs.forEach(x => x.ws.close());
  });

  lane = lanes.lobby2;

  // LOBBY-1 (lobby review): the server drops the host's go / back (and a gp end acting as back) within START_MIN_MS of
  // the last one it took, without an answer, so js/main.js holds a click that early until START_MIN_MS (+ 30 ms) have
  // passed since it saw the room's st change. That is always enough: the server took the action before it sent that change.
  T('LOBBY-1: the host\'s go / back / gp end sent START_MIN_MS + 30 ms after he saw the room change are taken; sooner: dropped, no answer', async t => {
    const R = await lobbyRoom(t, 2, { startMinMs: START_MIN_MS });
    const [h, g] = R.cs;
    // the moment the host has the room in state st (polled every 5 ms: never before it came)
    const seen = async st => { await h.wait(() => h.room().st === st, 3000, 'the host sees ' + st); return Date.now(); };
    const at = async (t0, ms) => { const w = t0 + ms - Date.now(); if (w > 0) await sleep(w); };
    const AFTER = START_MIN_MS + 30;
    h.send({ t: 'start', len: LEN, force: true });
    const tL = await seen('loading');
    h.loaded(true, { len: LEN });
    await h.wait(() => h.room().load && h.room().load.done.includes(h.id), 1000, 'the host loaded');
    h.send({ t: 'go' });                                   // 不等了，開始 at once
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().room.st, h.all('nostart').length], ['loading', 0], 'go within the second: dropped without an answer');
    await at(tL, AFTER);
    h.send({ t: 'go' });
    const tS = await seen('session');
    h.send({ t: 'back' });                                 // the room menu's 回到大廳 at once
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().room.st, h.all('nostart').length], ['session', 0], 'back within the second: dropped without an answer');
    await at(tS, AFTER);
    h.send({ t: 'back' });
    const tB = await seen('lobby');
    // a Grand Prix whose barrier ends by itself (everybody loaded); 結束大獎賽 in qualifying = back to the lobby
    h.send({ t: 'set', mode: 'gp', q: 1, r: 1 });
    await h.wait(() => h.room().set.mode === 'gp');
    await at(tB, AFTER);
    h.send({ t: 'start', len: LEN, force: true });
    await seen('loading');
    h.loaded(true, { len: LEN }); g.loaded(true);
    const tQ = await seen('session');
    await h.wait(() => h.gp() && h.gp().phase === 'quali', 1000, 'qualifying');
    await at(tQ, AFTER);
    h.send({ t: 'gp', a: 'end' });
    await seen('lobby');
    assert.strictEqual(h.all('nostart').length, 0);
    R.cs.forEach(x => x.ws.close());
  });

  T('lobby: joining in every state (lobby: a bot\'s seat; loading: one more to wait for, full; free session: a bot\'s seat; Grand Prix: full / spectator)', async t => {
    const R = await lobbyRoom(t, 2);
    const [a, b] = R.cs;
    // lobby, full with bots: a human takes the newest bot's seat
    a.send({ t: 'bots', n: 14 });
    await R.sync(x => x.set.bots === 14);
    await b.wait(() => b.roster().length === 16);
    const c = await client(R.srv.port, { name: 'C' });
    R.cs.push(c);
    assert(c.id > 0, 'in');
    assert.deepStrictEqual([c.last('welcome').room.st, c.last('welcome').room.set.track], ['lobby', 'monza']);
    await b.wait(() => b.roster().filter(p => p.bot).length === 13);
    assert.strictEqual(R.srv.info().room.set.bots, 14, 'the wish stays');
    // loading: the newcomer is appended to the wait list, the deadline stays; a full room is full
    a.send({ t: 'start', len: LEN, force: true });
    const r0 = await R.sync(x => x.st === 'loading');
    R.clk.add(5000);
    b.ws.close();
    await R.sync(x => x.load.wait.length === 2);
    const d = await client(R.srv.port, { name: 'D' });
    R.cs.push(d);
    assert.deepStrictEqual([d.last('welcome').room.st, d.last('welcome').room.load.wait, d.last('welcome').room.load.until],
      ['loading', [a.id, c.id, d.id], r0.load.until], 'D waited for, the deadline unchanged');
    await R.sync(x => x.load.wait.length === 3);
    const e = await client(R.srv.port, { name: 'E' });
    await e.wait(() => e.closed);
    assert.deepStrictEqual([e.id, e.last('error').code], [0, 'full'], 'no bot makes room while loading');
    // d loads, a and c too: the session (free practice); a newcomer of a free session takes a bot's seat
    a.loaded(); c.loaded(); d.loaded();
    await R.sync(x => x.st === 'session');
    const f = await client(R.srv.port, { name: 'F' });
    R.cs.push(f);
    assert.deepStrictEqual([f.id > 0, f.last('welcome').room.st, f.last('welcome').room.rs], [true, 'session', 1]);
    await a.wait(() => a.roster().filter(p => p.bot).length === 12);
    // a Grand Prix: full; a seat freed: a spectator during the grid
    await R.start(1, 1);
    const g1 = await client(R.srv.port, { name: 'G1' });
    await g1.wait(() => g1.closed);
    assert.strictEqual(g1.last('error').code, 'full');
    f.ws.close();
    await R.sync(x => true);
    R.cs = R.cs.filter(x => !x.closed);
    await R.settle(s => s.players.length === 15);
    R.clk.add(3000);
    a.send({ t: 'gp', a: 'skip' });
    await R.settle(s => s.phase === 'grid');
    const s1 = await client(R.srv.port, { name: 'S1' });
    R.cs.push(s1);
    const g = await R.settle(s => s.players.length === 16);
    assert.deepStrictEqual([s1.last('welcome').room.st, g.players.find(p => p.id === s1.id).spec], ['session', true]);
    // back to the lobby: everybody (the spectator too) is there
    await R.lobby();
    assert.deepStrictEqual([s1.room().st, R.srv.info().gp.players.every(p => !p.spec)], ['lobby', true]);
    R.cs.forEach(x => x.ws.close());
  });

  T('lobby: back / gp end -> lobby (session ended, cars and ready cleared; room before gp); gp end in the race -> results; a Grand Prix nobody is left in -> lobby', async t => {
    const R = await room(t, 3);
    const [a, b, c] = R.cs;
    const tail = (x, n) => x.msgs.filter(m => m.t === 'room' || m.t === 'gp').slice(-n).map(m => m.t === 'room' ? 'room ' + m.st : 'gp ' + m.s.phase);
    // free practice: cars on track, lap times; back -> lobby: everything cleared
    a.drive(0, 0); b.drive(5, 0);
    a.send({ t: 'lap', k: a.rs(), last: 80, best: 80 });
    await c.wait(() => c.roster()[0].best === 80);
    await R.lobby();
    assert.deepStrictEqual(R.srv.info().players.map(p => p.best), [null, null, null]);
    await c.wait(() => c.roster()[0].best === null);
    // a Grand Prix to the race; a guest's back / gp end: nothing
    await R.start(1, 2);
    await R.toRace();
    for (const m of [{ t: 'back' }, { t: 'gp', a: 'end' }, { t: 'gp', a: 'skip' }]) { b.send(m); c.send(m); }
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().room.st, R.srv.info().gp.phase], ['session', 'race']);
    // gp end in the race: the results (the room stays in the session)
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'results');
    assert.strictEqual(R.srv.info().room.st, 'session');
    // gp end in the results: the lobby, the room message first
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    await R.sync(x => x.st === 'lobby');
    for (const x of R.cs) assert.deepStrictEqual(tail(x, 2), ['room lobby', 'gp free'], 'room, then gp');
    // gp end in qualifying and on the grid: the lobby too
    for (const phase of ['quali', 'grid']) {
      await R.start(1, 1);
      if (phase === 'grid') await R.toGrid();
      a.send({ t: 'gp', a: 'end' });
      await R.sync(x => x.st === 'lobby');
      await R.settle(s => s.phase === 'free');
      assert.deepStrictEqual(tail(c, 2), ['room lobby', 'gp free'], phase);
    }
    // gp start / again in a session: start ignored; again only from the results
    await R.start(1, 1);
    const sid = R.srv.info().gp.sid;
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN }); a.send({ t: 'gp', a: 'again' });
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().gp.sid, R.srv.info().gp.phase], [sid, 'quali']);
    // everybody classified leaves the grid, only a spectator stays: the room goes back to the lobby by itself
    await R.toGrid();
    const s = await client(R.srv.port, { name: 'spec' });
    R.cs.push(s);
    await R.settle(x => x.players.length === 4);
    b.ws.close(); c.ws.close();
    await R.settle(x => x.players.length === 2);
    a.ws.close();
    await s.wait(() => s.room().st === 'lobby' && s.host() === s.id, 2000, 'lobby, s hosts');
    assert.deepStrictEqual([s.host(), s.gp().phase, tail(s, 2)], [s.id, 'free', ['room lobby', 'gp free']]);
    s.ws.close();
  });

  T('lobby: dedicated server: host migration in the lobby and while loading (settings survive, the new host can go); an empty room goes back to the lobby with its settings', async t => {
    const R = await lobbyRoom(t, 3);
    const [a, b, c] = R.cs;
    a.send({ t: 'set', year: 2020, mode: 'gp', q: 2, r: 3, wear: 4 });
    a.send({ t: 'bots', n: 2, skill: 'legend' });
    await R.sync(x => x.set.bots === 2 && x.set.year === 2020);
    const set0 = JSON.stringify(R.srv.info().room.set);
    // in the lobby: b is host, the settings stay, the old host's bots went with him
    a.ws.close();
    await R.sync(x => true);
    await c.wait(() => c.host() === b.id && c.roster().length === 2);
    assert.strictEqual(JSON.stringify(R.srv.info().room.set), set0);
    // b starts; while loading he leaves: c is host, the barrier runs on, c can go once he has loaded
    b.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    b.ws.close();
    await c.wait(() => c.host() === c.id);
    assert.deepStrictEqual(R.srv.info().room.load.wait, [c.id]);
    c.send({ t: 'go' });
    await sleep(100);
    assert.strictEqual(R.srv.info().room.st, 'loading', 'not before his own track is built');
    c.loaded();
    const g = await settle(R.srv, [c], s => s.phase === 'quali');
    assert.deepStrictEqual([g.q, g.r, g.year, g.wear, g.players.map(p => p.id)], [2, 3, 2020, 4, [c.id]]);
    // the room empties: the lobby, the settings kept, the session over
    c.ws.close();
    await until(() => R.srv.info().players.length === 0 && R.srv.info().room.st === 'lobby', 2000, 'empty -> lobby');
    assert.deepStrictEqual([R.srv.info().gp.phase, JSON.stringify(R.srv.info().room.set), R.srv.info().room.ready, R.srv.info().room.load],
      ['free', set0, [], null]);
    const d = await client(R.srv.port, { name: 'D' });
    assert.deepStrictEqual([d.last('welcome').host, d.last('welcome').room.st, JSON.stringify(d.last('welcome').room.set)], [d.id, 'lobby', set0]);
    d.ws.close();
  });

  T('lobby: the in-game host leaving in the lobby / while loading: no host, the barrier still completes for the guests', async t => {
    const R = await lobbyRoom(t, 3, { hostToken: 'tok' });
    const [h, b, c] = R.cs;
    h.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    b.loaded();
    h.ws.close();
    await b.wait(() => b.host() === 0);
    assert.deepStrictEqual(R.srv.info().room.load.wait, [c.id]);
    c.loaded();
    await settle(R.srv, [b, c], s => s.phase === 'free');
    await until(() => R.srv.info().room.st === 'session', 1000, 'session');
    b.send({ t: 'back' }); c.send({ t: 'set', track: 'spa' });
    await sleep(120);
    assert.deepStrictEqual([R.srv.info().room.st, R.srv.info().room.set.track], ['session', 'monza'], 'no host: nobody changes the room');
    b.ws.close(); c.ws.close();
  });

  T('lobby: the in-game host leaving as the last one loading starts nothing (the room is closing: no session a moment before the guests are disconnected)', async t => {
    const R = await lobbyRoom(t, 3, { hostToken: 'tok' });
    const [h, b, c] = R.cs;
    h.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    b.loaded(); c.loaded();
    await R.sync(x => x.st === 'loading' && x.load.done.length === 2 && x.load.wait.length === 1 && x.load.wait[0] === h.id);
    const nRoom = b.all('room').length;
    h.ws.close();
    await b.wait(() => b.host() === 0);
    await sleep(150);
    const r = R.srv.info().room;
    assert.deepStrictEqual([r.st, r.load.wait, r.load.done.slice().sort()], ['loading', [], [b.id, c.id].sort()], 'the barrier did not end with the host\'s leaving');
    assert(b.all('room').slice(nRoom).every(m => m.st === 'loading'), 'no session / lobby room message');
    assert.deepStrictEqual([b.gp().phase, R.srv.info().gp.phase], ['free', 'free']);
    b.ws.close(); c.ws.close();
  });

  T('lobby: the bots field only in the lobby; room.set.bots / skill = the host\'s wish (clamped 0..15), in the room message', async t => {
    const R = await lobbyRoom(t, 2);
    const [a, b] = R.cs;
    a.send({ t: 'bots', n: 99, skill: 'amateur' });
    await R.sync(x => x.set.bots === 15 && x.set.skill === 'amateur');
    await b.wait(() => b.roster().filter(p => p.bot).length === 14, 2000, '14 seats');
    a.send({ t: 'bots', n: 3.9 });
    await R.sync(x => x.set.bots === 3);
    b.send({ t: 'bots', n: 0, skill: 'legend' });
    a.send({ t: 'bots', n: -1 }); a.send({ t: 'bots', n: '2' });
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().room.set.bots, R.srv.info().room.set.skill, R.srv.info().bots.n], [3, 'amateur', 3]);
    await R.go();
    a.send({ t: 'bots', n: 0 });
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().room.set.bots, R.srv.info().bots.n], [3, 3], 'not in a session (free practice included)');
    R.cs.forEach(x => x.ws.close());
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

  T('Grand Prix: only the host controls it, only once the room has a track; it starts at the barrier; settings validated, not clamped', async t => {
    const clk = manualClock();
    const srv = await t.start({ now: clk, random: () => 0, startMinMs: 0 });
    const a = await client(srv.port), b = await client(srv.port);
    a.send({ t: 'set', mode: 'gp', q: 1, r: 1 });
    a.send({ t: 'start', len: LEN, force: true });              // host, but no track yet
    await a.wait(() => a.last('nostart'));
    assert.deepStrictEqual([a.last('nostart').why, srv.info().gp.phase, srv.info().room.st], ['track', 'free', 'lobby'], 'start is refused without a track');
    a.send({ t: 'set', track: 'monza' });
    await b.wait(() => b.room().set.track === 'monza' && b.room().set.mode === 'gp');
    for (const act of ['start', 'skip', 'end', 'again']) b.send({ t: 'gp', a: act, q: 1, r: 1, len: LEN });
    b.send({ t: 'start', len: LEN, force: true });
    await sleep(150);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().gp.sid, srv.info().room.st], ['free', 0, 'lobby'], 'a guest cannot start');
    a.send({ t: 'start', len: LEN, force: true });
    await b.wait(() => b.room().st === 'loading');
    a.loaded(); b.loaded();
    let g = await settle(srv, [a, b], s => s.phase === 'quali');
    assert.deepStrictEqual([g.sid, g.q, g.r, g.len], [1, 1, 1, LEN]);
    for (const act of ['skip', 'end', 'again', 'start']) b.send({ t: 'gp', a: act, q: 1, r: 1, len: LEN });
    b.send({ t: 'back' });
    await sleep(150);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().gp.sid, srv.info().room.st], ['quali', 1, 'session'], 'a guest cannot skip / end / restart / go back');
    a.send({ t: 'gp', a: 'again' });                             // only from the results
    a.send({ t: 'gp', a: 'start', q: 5, r: 5, len: LEN });      // protocol 1's start: ignored
    await sleep(120);
    assert.deepStrictEqual([srv.info().gp.phase, srv.info().gp.sid], ['quali', 1]);
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
    assert.deepStrictEqual([g.sid, srv.info().room.rs], [2, 1], 'again: the same load cycle');
    a.send({ t: 'gp', a: 'end' });                               // qualifying: back to the lobby
    await settle(srv, [a, b], s => s.phase === 'free');
    await b.wait(() => b.room().st === 'lobby');
    // lap counts are never clamped: out of range is ignored (the room keeps 1 / 1); a whole value after rounding
    a.send({ t: 'set', q: 1e9, r: -5 });
    await sleep(120);
    assert.deepStrictEqual([srv.info().room.set.q, srv.info().room.set.r], [1, 1]);
    a.send({ t: 'set', q: 2.4, r: 20 });
    await b.wait(() => b.room().set.q === 2 && b.room().set.r === 20);
    a.send({ t: 'start', len: 99999.5, force: true });
    await b.wait(() => b.room().st === 'loading');
    a.loaded(); b.loaded();
    g = await settle(srv, [a, b], s => s.sid === 3);
    assert.deepStrictEqual([g.phase, g.q, g.r, g.len], ['quali', 2, 20, 99999.5]);
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
    assert.deepStrictEqual([R.srv.info().gp.players.length, R.srv.info().room.st], [0, 'lobby']);
    // the next visitor finds a normal room (in the lobby, its settings kept) and can run a Grand Prix
    const e = await client(R.srv.port, { name: 'Next' });
    assert.deepStrictEqual([e.last('welcome').host, e.room().st, e.room().set.mode], [e.id, 'lobby', 'gp']);
    e.send({ t: 'start', len: LEN });
    await e.wait(() => e.room().st === 'loading');
    e.loaded();
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
  T('Grand Prix: the host\'s back ends the session and everybody is told (room lobby, then gp free); the old cycle\'s laps are ignored', async t => {
    const R = await room(t, 3);
    const [a, b, c] = R.cs;
    await R.start(1, 3);
    await R.toRace();
    R.clk.add(3000);
    a.lap(2.5);
    await R.settle(s => s.players[0].rLaps === 1);
    const rs = a.rs();
    b.send({ t: 'back' }); b.send({ t: 'set', track: 'spa' });  // not the host
    await sleep(120);
    assert.deepStrictEqual([srv_phase(R), R.srv.info().room.st], ['race', 'session']);
    a.send({ t: 'back' });
    const g = await R.settle(s => s.phase === 'free');
    assert.deepStrictEqual([g.sid, g.grid, g.winnerAt, g.players.map(p => p.spec)], [1, [], 0, [false, false, false]]);
    for (const x of R.cs) {
      await x.wait(() => x.room().st === 'lobby');
      const iRoom = x.msgs.findIndex(m => m.t === 'room' && m.st === 'lobby' && m.rs === rs);
      const iFree = x.msgs.findIndex(m => m.t === 'gp' && m.s.phase === 'free' && m.s.sid === 1);
      assert(iRoom >= 0 && iRoom < iFree, 'room(lobby) comes before gp(free)');
    }
    // laps of the ended session are ignored without an answer (in the lobby nothing is a lap)
    b.send({ t: 'gl', k: rs, sid: 1, time: 3 });
    b.lap(3);
    await sleep(120);
    assert.strictEqual(b.all('glno').length, 0);
    // a new free-practice session: a lap there is answered (no Grand Prix), one of the old cycle is not
    await R.free();
    b.send({ t: 'gl', k: rs, sid: 1, time: 3 });
    await sleep(120);
    assert.strictEqual(b.all('glno').length, 0);
    b.lap(3);
    await b.wait(() => b.last('glno'));
    assert.deepStrictEqual([b.last('glno').why, b.rs(), rs + 1], ['no-session', rs + 1, rs + 1]);
    // back in every other phase ends the session too (never left hanging in the results)
    for (const phase of ['quali', 'grid', 'results']) {
      await R.start(1, 1);
      if (phase !== 'quali') await R.toGrid();
      if (phase === 'results') {
        R.clk.to(srv_gp(R).goAt); await R.settle(s => s.phase === 'race');
        a.send({ t: 'gp', a: 'end' }); await R.settle(s => s.phase === 'results');
      }
      a.send({ t: 'back' });
      await R.settle(s => s.phase === 'free');
      await R.sync(x => x.st === 'lobby');
    }
    assert.strictEqual(srv_gp(R).sid, 4);
    // back while loading: nobody is on a track yet; the next start is a new cycle
    a.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    a.loaded();
    a.send({ t: 'back' });
    const r = await R.sync(x => x.st === 'lobby');
    assert.deepStrictEqual([r.load, srv_gp(R).phase, srv_gp(R).sid], [null, 'free', 4]);
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
    b.send('{"t":"gl","k":' + b.rs() + ',"sid":1,"time":1e999}');
    await b.wait(() => b.all('glno').length === 12);
    assert.strictEqual(b.last('glno').why, 'bad');
    b.send({ t: 'gl', k: b.rs(), sid: 1 });                      // no time at all
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
    // stale session id / load cycle: not answered at all
    b.lap(2.5, 0); b.lap(2.5, 2); b.lap(2.5, '1'); b.lap(2.5, null); b.lap(2.5, 1.5);
    b.send({ t: 'gl', k: b.rs() - 1, sid: 1, time: 2.5 }); b.send({ t: 'gl', k: String(b.rs()), sid: 1, time: 2.5 }); b.send({ t: 'gl', sid: 1, time: 2.5 });
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
  T('Grand Prix v6: the session races the room year (never a client\'s) and the room\'s wear; again keeps both; parc fermé', async t => {
    const R = await room(t, 3, { cars: ['2020-ferrari', '2020-mercedes', ''] });
    const [a, b, c] = R.cs;
    await a.wait(() => a.roster().length === 3);
    assert.deepStrictEqual(a.roster().map(p => p.car), ['2020-ferrari', '2020-mercedes', '']);
    // no room year yet: the session has none either, whatever the host names
    let g = await R.start(1, 1, { len: LEN });
    a.send({ t: 'gp', a: 'start', q: 1, r: 1, len: LEN, year: 2024 });           // (protocol 1's start: ignored)
    await sleep(100);
    g = R.srv.info().gp;
    assert.deepStrictEqual([g.sid, g.year, g.wear], [1, null, 1]);
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    g = await R.start(1, 1, { year: 2020, wear: 3 });
    assert.deepStrictEqual([g.sid, g.phase, g.year, g.wear], [2, 'quali', 2020, 3], 'the room year, the wear set');

    // while a session is on: no settings change, no car change (name and colour still change)
    a.send({ t: 'set', year: 2021, wear: 5 });
    b.send({ t: 'profile', name: 'Bee', colour: '#123456', car: '2021-mercedes' });
    await a.wait(() => a.roster()[1].name === 'Bee');
    assert.deepStrictEqual([a.roster()[1].colour, a.roster()[1].car], ['#123456', '2020-mercedes']);
    await sleep(120);
    const n = a.all('players').length;
    b.send({ t: 'profile', car: '2021-mercedes' });                              // a car change alone: nothing at all
    await sleep(250);
    assert.deepStrictEqual([R.srv.info().room.set.year, R.srv.info().room.set.wear, R.srv.info().players[1].car, a.all('players').length],
      [2020, 3, '2020-mercedes', n]);
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
    a.send({ t: 'set', year: 2022 });                                           // the results are still a session
    b.send({ t: 'profile', car: '2021-mercedes' });
    a.send({ t: 'gp', a: 'again' });
    g = await R.settle(s => s.sid === 3);
    assert.deepStrictEqual([g.phase, g.year, g.wear], ['quali', 2020, 3], 'again: the same year and wear');
    assert.deepStrictEqual([R.srv.info().room.set.year, R.srv.info().players[1].car], [2020, '2020-mercedes']);

    // the lobby again: the year and the cars can change
    await R.lobby();
    b.send({ t: 'profile', car: '2021-mercedes' });
    a.send({ t: 'set', year: 2021 });
    await c.wait(() => c.room().set.year === 2021 && c.roster()[1].car === '2021-mercedes', 3000, 'year and car in the lobby');

    // wear over the wire: rounded; out of range or not a number is ignored (the room keeps its wear), never clamped
    await sleep(1050);                                                           // (SET_PER_S: a new second)
    let sid = R.srv.info().gp.sid;
    for (const [w, want] of [[9, 3], [0, 3], [2.6, 3], [4.4, 4], ['3', 4], [null, 4], [5, 5], [1, 1]]) {
      a.send({ t: 'set', wear: w });
      await sleep(120);
      assert.strictEqual(R.srv.info().room.set.wear, want, JSON.stringify(w));
    }
    for (const w of ['1e999', '-1e999', '{}', '[4]', 'true']) a.send('{"t":"set","wear":' + w + '}');
    await sleep(150);
    assert.strictEqual(R.srv.info().room.set.wear, 1);
    await sleep(1050);
    a.send({ t: 'set', wear: 4 });
    g = await R.start(1, 1);
    assert.deepStrictEqual([g.sid, g.year, g.wear], [sid + 1, 2021, 4]);
    // a guest's settings and start take nothing with them
    await R.lobby();
    b.send({ t: 'set', year: 2015, wear: 2 }); b.send({ t: 'start', len: LEN, force: true });
    await sleep(120);
    assert.deepStrictEqual([R.srv.info().room.st, R.srv.info().room.set.year, R.srv.info().room.set.wear], ['lobby', 2021, 4]);
    R.cs.forEach(x => x.ws.close());
  });

  lane = lanes.gp3;
  T('Grand Prix: garbage / wrong-type / oversized gp, gl, ping, progress and room messages never change state or crash', async t => {
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
      '{"t":"s","k":1,"c":1,"s":[0,0,0,0,0,0,0,0],"g":{}}', '{"t":"s","k":1,"c":1,"s":[0,0,0,0,0,0,0,0],"g":-1e308}', '{"t":"s","k":1,"c":1,"s":"x","g":0.5}',
      // protocol 2 messages no state takes: garbage settings, ready, loaded, start; go outside the loading
      '{"t":"set","track":5,"q":1e999}', '{"t":"set","year":"2024","mode":"race","wear":0}', '{"t":"set","track":"../x"}', '{"t":"ready","on":"yes"}',
      '{"t":"ready","on":null}', '{"t":"loaded","rs":"2","ok":true}', '{"t":"loaded","rs":-1,"ok":true}', '{"t":"loaded","rs":1e999,"ok":true}',
      '{"t":"start","len":"200"}', '{"t":"start","len":1e999,"force":true}', '{"t":"go","x":1}', '{"t":"bots","n":"3"}', '{"t":"track","id":"spa"}', '{"t":"year","y":2024}'
    ];
    const check = async (label, expectGlno) => {
      const before = JSON.stringify(srv_gp(R)), room0 = JSON.stringify(R.srv.info().room);
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
      assert.strictEqual(JSON.stringify(R.srv.info().room), room0, label + ': room changed');
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
    b.send('{"t":"gl","k":' + b.rs() + ',"sid":2,"time":"fast"}'); b.send('{"t":"gl","k":' + b.rs() + ',"sid":2,"time":[1,2,3]}');
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
    b.send({ t: 'track', id: 'spa' }); b.send({ t: 'set', track: 'spa' }); b.send({ t: 'back' }); c.send({ t: 'back' });
    await sleep(150);
    assert.deepStrictEqual([srv_phase(R), R.srv.info().track, R.srv.info().host, R.srv.info().room.st], ['quali', 'monza', 0, 'session']);
    g = await R.toRace();                                        // the drivers finish qualifying themselves
    assert.deepStrictEqual(g.grid, [b.id, c.id]);
    R.clk.add(3000);
    b.lap(2.5); c.lap(2.6);
    g = await R.settle(s => s.phase === 'results');
    assert.deepStrictEqual(g.order, [b.id, c.id]);
    b.ws.close(); c.ws.close();
    await until(() => R.srv.info().gp.phase === 'free' && R.srv.info().room.st === 'lobby', 2000, 'empty room -> free, the lobby');
  });

  T('Grand Prix: impact reports follow the ghost rule (none in qualifying / while the grid forms / with spectators)', async t => {
    const R = await room(t, 2);
    const [a, b] = R.cs;
    let sent = 0;
    const hit = async (from, to, expected, label) => {
      const n = to.all('hit').length;
      // fresh positions: to stays parked; from drives the last 3 m at 20 m/s along +x up to 6 m behind it (from does
      // not jump; to does not move, or it would drive away from the impact as far as the server can tell)
      to.drive(to.px, to.pz);
      await driveTo(from, to.px - 9, to.px - 6, to.pz, 3);         // (150 ms: also the 40 ms throttle)
      from.send({ t: 'hit', k: from.rs(), to: to.id, i: [++sent, 0] });
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
    await R.sync(x => x.st === 'lobby');
    await hit(s, a, false, 'the lobby: nobody is on a track');
    await R.free();
    await hit(s, a, true, 'free practice again');
    R.cs.forEach(x => x.ws.close());
  });

  T('year / car garbage from host and guest never changes the room, never crashes, never gets you kicked', async t => {
    const R = await lobbyRoom(t, 2, { cars: ['2024-ferrari', ''] });
    const [a, b] = R.cs;
    a.send({ t: 'set', year: 2024 });
    await b.wait(() => b.room().set.year === 2024);
    const junk = ['{"t":"set"}', '{"t":"set","year":"2025"}', '{"t":"set","year":1e999}', '{"t":"set","year":-1e999}', '{"t":"set","year":2025.5}',
      '{"t":"set","year":null}', '{"t":"set","year":[2025]}', '{"t":"set","year":{"valueOf":2025}}', '{"t":"set","year":true}', '{"t":"set","year":2009}',
      '{"t":"set","year":2101}', '{"t":"set","y":2025}', '{"t":"SET","year":2025}', '{"t":"set","year":"__proto__"}', '{"t":"set","year":9007199254740993}',
      '{"t":"year","y":2025}', '{"t":"year","year":2025}',
      '{"t":"profile","car":null}', '{"t":"profile","car":5}', '{"t":"profile","car":"X"}', '{"t":"profile","car":["2024-mclaren"]}',
      '{"t":"profile","car":{"length":3}}', '{"t":"profile","car":""}', '{"t":"profile","car":"' + 'a'.repeat(41) + '"}',
      '{"t":"profile","car":"a\\u0000b"}', '{"t":"profile","car":"__proto__"}', '{"t":"profile","car":"2024-mclaren\\n"}',
      '{"t":"profile","car":1e999}', '{"t":"hello","v":2,"name":"again","car":"2024-mclaren"}'];
    const check = async label => {
      const before = JSON.stringify([R.srv.info().room, R.srv.info().players, R.srv.info().gp]);
      await sleep(120);
      const n = [a.all('players').length, b.all('players').length];
      for (const j of junk) { a.send(j); b.send(j); }
      await sleep(250);
      assert.strictEqual(JSON.stringify([R.srv.info().room, R.srv.info().players, R.srv.info().gp]), before, label + ': state changed');
      assert.deepStrictEqual([a.all('players').length - n[0], b.all('players').length - n[1]], [0, 0], label + ': rosters sent');
      assert.strictEqual(a.closed || b.closed, null, label + ': kicked');
    };
    await check('lobby');
    await sleep(1050);                                           // (SET_PER_S: the junk used this second up)
    await R.start(1, 1);
    await check('quali');
    // the valid messages still work afterwards
    a.send({ t: 'gp', a: 'end' });
    await R.settle(s => s.phase === 'free');
    await sleep(1050);
    a.send({ t: 'set', year: 2025 }); b.send({ t: 'profile', car: '2025-mclaren' });
    await b.wait(() => b.room().set.year === 2025 && b.roster()[1].car === '2025-mclaren');
    a.ws.close(); b.ws.close();
  });

  T('full room: 16 drivers, then 15 leavers (DNF rows) + 15 spectators: snapshot sizes stay sane', async t => {
    const clk = manualClock();
    const srv = await t.start({ now: clk, random: () => 1 });
    const name = i => '十六個字的超級長名字車手' + String(i).padStart(4, '0');
    const car = i => (String(2000 + i) + '-' + 'x'.repeat(40)).slice(0, 40);   // the longest car ids there can be
    const cs = [];
    for (let i = 0; i < 16; i++) cs.push(await client(srv.port, { name: name(i), car: car(i) }));
    cs[0].send({ t: 'set', track: 'monza', year: 2026, mode: 'gp', q: 1, r: 50, wear: 5 });
    await cs[15].wait(() => cs[15].room().set.year === 2026 && cs[15].room().set.mode === 'gp');
    cs[0].send({ t: 'start', len: LEN, force: true });
    for (const c of cs) { await c.wait(() => c.room().st === 'loading'); c.loaded(); }
    const rmsg = Buffer.byteLength(JSON.stringify(cs[15].all('room').find(m => m.st === 'loading')));
    assert(rmsg < 1024, 'room message while 16 load: ' + rmsg + ' bytes');
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

  T('js/net.js against the real server: lobby, start, barrier, Grand Prix calls and events, clock sync, teardown, reconnect', async t => {
    let skew = 3 * 86400000 + 12345;                             // this server's clock is three days ahead of ours
    const srvNow = () => Date.now() + skew;
    const srv = await t.start({ now: srvNow, random: () => 0, startMinMs: 0 });
    const A = freshNet(), B = freshNet();
    const ev = { A: [], B: [] };
    for (const n of ['connected', 'disconnected', 'gp', 'lapRejected', 'track', 'room', 'load', 'go', 'lobby', 'nostart']) {
      A.on(n, (x, y) => ev.A.push([n, x, y])); B.on(n, (x, y) => ev.B.push([n, x, y]));
    }
    const names = k => ev[k].filter(e => e[0] !== 'gp' && e[0] !== 'room').map(e => e[0]);
    assert(Math.abs(A.serverNow() - Date.now()) < 50, 'not in a room: our own clock');
    assert.deepStrictEqual([A.gp('skip'), A.sendGpLap(1, 3), A.setRoom({ track: 'monza' }), A.startRoom({ len: LEN }), A.room, A.loadedRs],
      [false, false, false, false, null, -1], 'not connected');
    assert.deepStrictEqual(await A.join('127.0.0.1:' + srv.port), { ok: true });
    assert.deepStrictEqual(await B.join('127.0.0.1:' + srv.port), { ok: true });
    assert.deepStrictEqual([A.isHost, B.isHost, A.id > 0, B.id > A.id, A.ded, B.address], [true, false, true, true, true, '127.0.0.1:' + srv.port]);
    assert.deepStrictEqual([A.room.st, A.room.rs, A.trackId, B.room.set], ['lobby', 0, null,
      { track: null, year: null, mode: 'free', q: 3, r: 5, wear: 1, bots: 0, skill: 'pro' }]);
    assert.deepStrictEqual(names('B'), ['connected'], 'no load in the lobby; track never');
    await until(() => A.session && B.session && B.session.players.length === 2 && A.session.players.length === 2, 2000, 'first gp');
    assert.deepStrictEqual([B.session.phase, B.session.sid, B.session.grid, B.session.order.length], ['free', 0, [], 2]);
    // clock: within a few ms of the server's after the first pings
    await sleep(450);
    assert(Math.abs(A.serverNow() - srvNow()) < 25, 'serverNow: ' + (A.serverNow() - srvNow()));
    assert(Math.abs(B.serverNow() - srvNow()) < 25, 'serverNow: ' + (B.serverNow() - srvNow()));
    // only the host sets the room up and starts, only with sane arguments
    assert.deepStrictEqual([B.setRoom({ track: 'monza' }), B.startRoom({ len: LEN, force: true }), B.goNow(), B.backToLobby(), B.selectTrack('monza')],
      [false, false, false, false, false], 'not the host');
    assert.deepStrictEqual([A.gp('start', { q: 1, r: 1, len: LEN }), A.gp('launch'), A.gp('skip')], [false, false, false], 'start is not a gp action; no session');
    assert.strictEqual(A.startRoom({ len: LEN }), false, 'no track yet');
    assert.deepStrictEqual([A.setRoom({}), A.setRoom({ q: 0, r: 1e9, wear: 9, year: 1999, mode: 'race', track: '../x' }), A.setRoom(null)], [false, false, false],
      'nothing valid: nothing sent');
    assert.strictEqual(A.selectTrack('monza'), true);
    assert.strictEqual(A.setRoom({ mode: 'gp', q: 1, r: 1, year: 2024, wear: 2 }), true);
    await until(() => B.trackId === 'monza' && B.room.set.mode === 'gp' && B.room.set.year === 2024 && B.year === 2024, 2000, 'settings');
    assert.strictEqual(A.room.set.track, 'monza');
    // ready: guests only, booleans only
    assert.deepStrictEqual([A.setReady(true), B.setReady('yes'), B.setReady(true)], [false, false, true]);
    await until(() => A.room.ready.includes(B.id) && A.roster.find(p => p.id === B.id).ready === true, 2000, 'ready');
    assert.deepStrictEqual(A.roster.map(p => [p.ready, p.load]), [[true, ''], [true, '']], 'the host counts as ready');
    // start: len checked locally; the barrier
    assert.deepStrictEqual([A.startRoom({ len: 50 }), A.startRoom({}), A.startRoom(null), A.goNow()], [false, false, false, false]);
    assert.strictEqual(A.startRoom({ len: LEN }), true);
    await until(() => A.room.st === 'loading' && B.room.st === 'loading', 2000, 'loading');
    assert.deepStrictEqual(ev.B.filter(e => e[0] === 'load').map(e => e.slice(1)), [['monza', 1]], 'load once for rs 1');
    assert.deepStrictEqual(B.roster.map(p => p.load), ['wait', 'wait']);
    // while loading nothing goes out: states, laps, hits; and the host's go needs his own track built
    B.sendState({ x: 0, z: 0, heading: 0 }, true);
    assert.deepStrictEqual([B.sendGpLap(1, 3), B.sendLap(80, 80), B.sendHit(A.id, 1, 0), A.goNow(), B.sendLoaded(0, true), B.sendLoaded(2, true)],
      [false, false, false, false, false, false]);
    assert.strictEqual(A.sendLoaded(1, true, { len: LEN, why: 'BAD!' }), true);
    assert.deepStrictEqual([A.loadedRs, A.sendLoaded(1, true), A.goNow()], [1, false, true], 'once per rs; then go');
    // (A's go ended the barrier before B loaded: B joins the session when its track is built)
    await until(() => A.session.phase === 'quali' && B.session.phase === 'quali', 2000, 'quali');
    assert.deepStrictEqual([A.room.st, A.room.len, B.loadedRs, A.session.year, A.session.wear], ['session', LEN, -1, 2024, 2]);
    assert.deepStrictEqual(names('A').slice(1), ['load', 'go'], 'the host: load, then go');
    assert.deepStrictEqual(names('B'), ['connected', 'load', 'go'], 'B: go too (the session is on), though its own track is not built yet');
    B.sendState({ x: 0, z: 0, heading: 0 }, true);                // not loaded yet: nothing goes out
    assert.strictEqual(B.sendLoaded(1, true, { len: LEN }), true);
    const t0 = Date.now();
    A.sendState({ x: 0, z: 0, heading: 0 }, true); B.sendState({ x: 0, z: 0, heading: 0 }, true);   // on track
    assert.deepStrictEqual(A.session, B.session);
    assert(ev.B.some(e => e[0] === 'gp' && e[1] === B.session), 'the gp event carries net.session');
    // laps: rejected ones come back as events, accepted ones as snapshots
    assert.strictEqual(B.sendGpLap(B.session.sid, 1), true);
    await until(() => ev.B.some(e => e[0] === 'lapRejected'), 2000, 'lapRejected');
    assert.deepStrictEqual(ev.B.filter(e => e[0] === 'lapRejected').map(e => e[1]), ['too-fast']);
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
    // B leaves: nothing of the room stays behind; A sees a DNF
    const bId = B.id;
    B.leave();
    assert.deepStrictEqual([B.connected, B.session, B.id, B.trackId, B.roster.length, B.room, B.loadedRs, B.address, B.ded],
      [false, null, 0, null, 0, null, -1, null, false]);
    assert(Math.abs(B.serverNow() - Date.now()) < 50, 'clock offset dropped: ' + (B.serverNow() - Date.now()));
    assert.deepStrictEqual(ev.B[ev.B.length - 1], ['disconnected', '已離開房間', undefined]);
    await until(() => A.session.players.some(p => p.left), 2000, 'DNF');
    assert.deepStrictEqual(A.session.players.map(p => [p.id, p.left, p.dnf]), [[A.id, false, false], [bId, true, true]]);
    // B comes back: a new id, a spectator; it loads the running session's track ('load' at once); the stale progress
    // is not sent again
    ev.B.length = 0;
    assert.deepStrictEqual(await B.join('127.0.0.1:' + srv.port), { ok: true });
    assert.deepStrictEqual(names('B'), ['connected', 'load'], 'a newcomer of a session: load at once, no go');
    await until(() => B.session && B.session.players.length === 3, 2000, 'rejoin');
    assert.strictEqual(B.sendLoaded(1, true), true);
    B.sendState({ x: 9, z: 0, heading: 0 }, true);
    assert.deepStrictEqual(B.session.players[2], Object.assign({}, B.session.players[2], { id: B.id, spec: true, left: false }));
    assert(B.id > bId, 'a new id');
    assert.strictEqual(B.trackId, 'monza');
    // the host ends the race (results), then back to the lobby: both hear 'lobby'; nothing goes out there
    assert.strictEqual(A.gp('end'), true);
    await until(() => B.session.phase === 'results', 2000, 'results');
    assert.strictEqual(A.backToLobby(), true);
    await until(() => B.room.st === 'lobby' && A.room.st === 'lobby', 2000, 'lobby');
    assert.deepStrictEqual([names('B').slice(-1), names('A').slice(-1)], [['lobby'], ['lobby']]);
    assert.deepStrictEqual([A.gp('skip'), A.backToLobby(), A.goNow(), B.sendGpLap(2, 3), B.sendLap(1, 1)], [false, false, false, false, false]);
    // nostart reaches the host: B not ready
    assert.strictEqual(A.startRoom({ len: LEN }), true);
    await until(() => ev.A.some(e => e[0] === 'nostart'), 2000, 'nostart');
    assert.deepStrictEqual(ev.A.filter(e => e[0] === 'nostart').map(e => e.slice(1)), [['not-ready', [B.id]]]);
    // the server goes away: both are told, both are clean
    await srv.close();
    await until(() => !A.connected && !B.connected, 3000, 'disconnected');
    assert.deepStrictEqual(ev.A[ev.A.length - 1].slice(0, 2), ['disconnected', '連線中斷：房主已關閉房間']);
    assert.deepStrictEqual([A.session, A.id, A.isHost, A.trackId, A.players.length, A.room], [null, 0, false, null, 0, null]);
    assert(Math.abs(A.serverNow() - Date.now()) < 50);
    // a new server on another clock: everything is learnt again
    const back = -10 * 86400000;
    const srv2 = await t.start({ now: () => Date.now() + back });
    assert.deepStrictEqual(await A.join('127.0.0.1:' + srv2.port), { ok: true });
    await until(() => A.session, 2000, 'gp after reconnect');
    assert.deepStrictEqual([A.id, A.isHost, A.trackId, A.session.phase, A.session.sid, A.session.players.length, A.room.st, A.room.rs],
      [1, true, null, 'free', 0, 1, 'lobby', 0]);
    await sleep(100);
    assert(Math.abs(A.serverNow() - (Date.now() + back)) < 25, 'serverNow after reconnect: ' + (A.serverNow() - (Date.now() + back)));
    A.leave();
    assert.deepStrictEqual(ev.A.filter(e => e[0] === 'track').length + ev.B.filter(e => e[0] === 'track').length, 0, 'track is never emitted');
    assert.strictEqual(uncaught.length, 0);
  });

  T('js/net.js against a hostile server: malformed gp / pong / glno / hit / snap / room cannot throw or poison state', async t => {
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
          ws.send(JSON.stringify({ t: 'welcome', v: 2, id: 7, host: 8, now: fakeNow(), room: { st: 'session', rs: 3, set: { track: 'monza' }, ready: [], rr: 0, load: null, len: 5000 },
            players: [{ id: 7, name: 'me', colour: '#112233', slot: 0 }, { id: 8, name: 'other', colour: '#445566', slot: 1 }] }));
        } else if (m.t === 'ping' && answer) ws.send(JSON.stringify({ t: 'pong', c: m.c, s: fakeNow() }));
      });
    });
    const N = freshNet();
    const ev = [];
    for (const n of ['gp', 'lapRejected', 'hit', 'track', 'load', 'go', 'lobby', 'disconnected']) N.on(n, (x, y) => ev.push([n, x, y]));
    const raw = async s => { sock.send(typeof s === 'string' ? s : JSON.stringify(s)); await sleep(15); };
    const clockOk = (label, extra) => {
      const d = N.serverNow() - fakeNow() - (extra || 0);
      assert(Number.isFinite(N.serverNow()) && Math.abs(d) < 25, label + ': serverNow off by ' + d);
    };
    try {
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      await sleep(80);
      clockOk('synchronised');
      assert.deepStrictEqual([N.id, N.isHost, N.trackId, N.session, N.room.st, N.room.rs], [7, false, 'monza', null, 'session', 3]);
      assert.deepStrictEqual(ev.filter(e => e[0] === 'load').map(e => e.slice(1)), [['monza', 3]], 'a session on: load at once');
      assert.strictEqual(N.sendLoaded(3, true), true);

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
      assert.deepStrictEqual(ev.filter(e => e[0] === 'hit').map(e => [e[1], e[2]]), [[8, [50, 0]], [8, [0, -50]], [8, [3, 4]]]);

      // --- snap ---
      await raw({ t: 'snap', p: [[8, 1000, 1e300, 0, 0, 0, 0, 0, 0, 0], [8, 1001, 0, 0, 0, 0, 0, 0, 1e9, 0], [8, 'x', 0, 0, 0, 0, 0, 0, 0, 0], [8], 5, null, 'x'] });
      await raw('{"t":"snap","p":[[8,1002,1e999,0,0,0,0,0,0,0]]}'); await raw({ t: 'snap', p: 'x' }); await raw({ t: 'snap', p: { length: 3 } });
      // ids that are not numbers: '__proto__' would reach Object.prototype through remotes[...] (every for..in in the
      // game would then list '_off'); a string '8' is not player 8
      await raw({ t: 'snap', p: [['__proto__', 1000, 1, 2, 3, 0, 0, 0, 0, 0], ['constructor', 1000, 1, 2, 3, 0, 0, 0, 0, 0],
        ['toString', 1000, 1, 2, 3, 0, 0, 0, 0, 0], ['hasOwnProperty', 1000, 1, 2, 3, 0, 0, 0, 0, 0], ['8', 1000, 1, 2, 3, 0, 0, 0, 0, 0],
        [null, 1000, 1, 2, 3, 0, 0, 0, 0, 0], [[8], 1000, 1, 2, 3, 0, 0, 0, 0, 0]] });
      const forIn = []; for (const k in {}) forIn.push(k);
      assert.deepStrictEqual([forIn, Object.prototype.hasOwnProperty.call(Object, '_off')], [[], false], 'Object.prototype / Object untouched');
      await raw({ t: 'players', host: 8, players: [{ id: 7, name: 'me', colour: '#112233', slot: 0 }, { id: 8, name: 'other', colour: '#445566', slot: 1 }] });
      assert.deepStrictEqual(N.players.map(p => p.id), [8], 'the roster after the bad rows');
      N.update();
      assert.strictEqual(N.players[0].active, false, 'no pose came through');
      await raw({ t: 'snap', p: [[8, 2000, 10, 1, -20, 0.5, 0, 0, 30, 0]] });
      N.update();
      assert.strictEqual(N.players[0].active, true);
      assert(Object.keys(N.players[0].state).every(k => Number.isFinite(N.players[0].state[k])), JSON.stringify(N.players[0].state));

      // --- room: our race distance belongs to the old load cycle ---
      inbox.length = 0;
      N.setProgress(2.5);
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await until(() => inbox.some(m => m.t === 's'), 1000, 's');
      assert.deepStrictEqual([inbox.find(m => m.t === 's').g, inbox.find(m => m.t === 's').k], [2.5, 3]);
      for (const r of [{}, { st: 'bogus', rs: 4 }, { st: 5 }, { st: ['session'] }, { st: '__proto__' }, { st: 'LOBBY' }, { st: null, set: { track: 'spa' } }]) {
        await raw(Object.assign({ t: 'room' }, r));
      }
      await raw({ t: 'track', id: 'spa', seq: 4 });                // protocol 1: ignored
      assert.deepStrictEqual([N.trackId, N.room.rs, ev.filter(e => e[0] === 'track' || e[0] === 'load').length], ['monza', 3, 1], 'nothing of that is a room');
      await raw({ t: 'room', st: 'loading', rs: 4, set: { track: 'spa' }, load: { at: 1, until: 2, wait: [7], done: [], fail: [] } });
      assert.deepStrictEqual([N.trackId, ev[ev.length - 1]], ['spa', ['load', 'spa', 4]]);
      inbox.length = 0;
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await sleep(60);
      assert.strictEqual(inbox.filter(m => m.t === 's').length, 0, 'loading: no states');
      assert.strictEqual(N.sendLoaded(4, true), true);
      await raw({ t: 'room', st: 'session', rs: 4, set: { track: 'spa' } });
      assert.deepStrictEqual(ev[ev.length - 1], ['go', 4, undefined]);
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await until(() => inbox.some(m => m.t === 's'), 1000, 's');
      assert.deepStrictEqual([inbox.find(m => m.t === 's').g, inbox.find(m => m.t === 's').k], [undefined, 4], 'progress cleared by the new load cycle');

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
      assert.deepStrictEqual([N.session, N.id, N.trackId, N.isHost, N.room, N.loadedRs], [null, 0, null, false, null, -1]);
      assert(Math.abs(N.serverNow() - Date.now()) < 50, 'the 5e9 ms offset is gone');
      // ...and a new connection starts from scratch (no progress in the first state, clock learnt again)
      fakeOff = -7e9; answer = true; inbox.length = 0;
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      assert.strictEqual(N.sendLoaded(3, true), true, 'loaded again for the new connection');
      N.sendState({ x: 1, z: 2, heading: 0 }, true);
      await until(() => inbox.some(m => m.t === 's'), 1000, 's');
      assert.deepStrictEqual([inbox.filter(m => m.t === 's').length, inbox.find(m => m.t === 's').g, inbox.find(m => m.t === 's').k, N.session], [1, undefined, 3, null]);
      await sleep(60);
      clockOk('after reconnect');
      N.leave();
      assert.strictEqual(uncaught.length, 0, 'nothing thrown out of a message handler');
    } finally {
      delete Object.prototype._off; delete Object._off;   // (a failure above must not poison the tests after it)
      wss.clients.forEach(ws => ws.terminate());
      await new Promise(r => wss.close(r));
    }
  });

  T('js/net.js v6 against the real server: car in profile / roster / players, room year + event, wear, parc fermé', async t => {
    const srv = await t.start({ random: () => 0, startMinMs: 0 });
    const A = freshNet(), B = freshNet(), C = freshNet();
    const ev = { A: [], B: [], C: [] };
    for (const [k, N] of [['A', A], ['B', B], ['C', C]]) {
      for (const n of ['connected', 'disconnected', 'year', 'track', 'players', 'gp', 'room', 'load', 'go', 'lobby']) N.on(n, x => ev[k].push([n, n === 'year' ? x : n === 'load' ? x : null]));
    }
    const years = k => ev[k].filter(e => e[0] === 'year').map(e => e[1]);
    const addr = '127.0.0.1:' + srv.port;
    const load = async (rs, ...Ns) => { for (const N of Ns) { await until(() => N.room && N.room.rs === rs && N.room.st !== 'lobby', 2000, 'load ' + rs); N.sendLoaded(rs, true, { len: LEN }); } };
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
    // the year: host only, lobby only, whole 2010..2100; the event comes with the room
    for (const bad of [2009, 2101, 2024.5, '2024', null, undefined, NaN, Infinity]) assert.strictEqual(A.setYear(bad), false, String(bad));
    assert.strictEqual(B.setYear(2024), false, 'not the host');
    assert.strictEqual(A.setYear(2024), true);
    assert.strictEqual(A.year, null, 'not before the server says so');
    await until(() => A.year === 2024 && B.year === 2024 && B.room.set.year === 2024, 2000, 'year');
    assert.deepStrictEqual([years('A'), years('B')], [[2024], [2024]]);
    // a car change alone goes out and reaches the others
    B.setProfile({ car: '2024-williams' });
    await until(() => A.roster[1].car === '2024-williams' && A.players[0].car === '2024-williams', 2000, 'car change');
    // a free-practice session; a newcomer: connected, then the year, then the room, then load (its car is known before
    // the track is built)
    assert.strictEqual(A.selectTrack('monza'), true);
    await until(() => B.trackId === 'monza', 2000, 'track');
    assert.strictEqual(A.startRoom({ len: LEN, force: true }), true);
    await load(1, A, B);
    await until(() => A.room.st === 'session' && B.room.st === 'session', 2000, 'session');
    C.setProfile({ name: 'Cy', car: '2023-alpine' });
    assert.deepStrictEqual(await C.join(addr), { ok: true });
    assert.deepStrictEqual(ev.C.filter(e => ['connected', 'year', 'room', 'load', 'track'].includes(e[0])), [['connected', null], ['year', 2024], ['room', null], ['load', 'monza']]);
    await until(() => A.roster.length === 3 && A.roster[2].car === '2023-alpine', 2000, 'C in the roster');
    C.sendLoaded(1, true);
    // free practice: the car may change
    B.setProfile({ car: '2024-ferrari' });
    await until(() => A.roster[1].car === '2024-ferrari', 2000, 'car change in free practice');
    // Grand Prix: the wear and the laps are the room's, the year too
    assert.strictEqual(A.backToLobby(), true);
    await until(() => [A, B, C].every(N => N.room.st === 'lobby'), 2000, 'lobby');
    assert.strictEqual(A.setRoom({ mode: 'gp', q: 1, r: 1, wear: 4 }), true);
    await until(() => C.room.set.wear === 4 && C.room.set.mode === 'gp', 2000, 'settings');
    assert.strictEqual(A.startRoom({ len: LEN, force: true }), true);
    await load(2, A, B, C);
    await until(() => [A, B, C].every(N => N.session && N.session.phase === 'quali'), 2000, 'quali');
    assert.deepStrictEqual([A, B, C].map(N => [N.session.year, N.session.wear]), [[2024, 4], [2024, 4], [2024, 4]]);
    // parc fermé: the year is refused locally, the car is kept by the server, the choice is remembered
    assert.deepStrictEqual([A.setYear(2025), A.setRoom({ wear: 2 }), A.setBots(2)], [false, false, false], 'a session is on');
    B.setProfile({ car: '2024-haas' });
    B.setProfile({ name: 'Bobby' });
    await until(() => A.roster[1].name === 'Bobby', 2000, 'rename');
    assert.deepStrictEqual([A.roster[1].car, B.getProfile().car], ['2024-ferrari', '2024-haas']);
    // back in the lobby the car chosen meanwhile goes out by itself
    assert.strictEqual(A.gp('end'), true);                         // (qualifying: the lobby)
    await until(() => A.roster[1].car === '2024-haas' && C.players.find(p => p.id === B.id).car === '2024-haas', 2000, 'car sent again in the lobby');
    assert.deepStrictEqual([A.session.phase, A.room.st, A.year, years('C')], ['free', 'lobby', 2024, [2024]]);
    // a Grand Prix without a wear change: the room's (4)
    assert.strictEqual(A.startRoom({ len: LEN, force: true }), true);
    await load(3, A, B, C);
    await until(() => A.session.phase === 'quali' && A.session.sid === 2, 2000, 'second start');
    assert.deepStrictEqual([A.session.year, A.session.wear], [2024, 4]);
    A.gp('end');
    await until(() => A.session.phase === 'free' && A.room.st === 'lobby', 2000, 'free');
    // leaving: nothing of the room stays, and no year event for it
    const nb = years('B').length;
    B.leave();
    assert.deepStrictEqual([B.year, B.roster.length, years('B').length, B.room], [null, 0, nb, null]);
    assert.deepStrictEqual(B.getProfile(), { name: 'Bobby', colour: '#ff7a14', car: '2024-haas' }, 'the profile is ours, it stays');
    C.leave(); A.leave();
    assert.strictEqual(ev.A.filter(e => e[0] === 'track').length, 0);
    assert.strictEqual(uncaught.length, 0);
  });

  T('js/net.js against a hostile server: garbage room / year / car / wear are sanitised; the year event fires on real changes only; version texts', async t => {
    const wss = new WebSocket.Server({ port: nextPort(), host: '127.0.0.1' });
    await new Promise(r => wss.on('listening', r));
    let sock = null, welcomeRoom = { st: 'lobby', rs: 0, set: { year: '2024' } }, refuse = null;
    const inbox = [];
    wss.on('connection', ws => {
      sock = ws;
      ws.on('message', d => {
        const m = JSON.parse(d.toString());
        inbox.push(m);
        if (m.t === 'hello') {
          if (refuse) { ws.send(JSON.stringify(refuse)); ws.close(1008, 'version'); return; }
          ws.send(JSON.stringify({ t: 'welcome', v: 2, id: 7, host: 8, ded: 'yes', room: welcomeRoom, now: Date.now(),
            players: [{ id: 7, name: 'me', colour: '#112233', slot: 0, car: m.car }, { id: 8, name: 'other', colour: '#445566', slot: 1, car: '<script>' }] }));
        } else if (m.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() }));
      });
    });
    const N = freshNet();
    const ev = [];
    for (const n of ['connected', 'year', 'track', 'players', 'gp', 'room', 'load', 'go', 'lobby', 'nostart']) N.on(n, (x, y) => ev.push(n === 'year' ? 'year ' + x : n === 'load' ? 'load ' + x + ' ' + y : n === 'nostart' ? 'nostart ' + x + ' ' + JSON.stringify(y) : n));
    const raw = async s => { sock.send(typeof s === 'string' ? s : JSON.stringify(s)); await sleep(15); };
    const years = () => ev.filter(e => /^year/.test(e));
    const roster = (cars, host) => ({ t: 'players', host: host || 8, players: [
      { id: 7, name: 'me', colour: '#112233', slot: 0, car: cars[0] }, { id: 8, name: 'other', colour: '#445566', slot: 1, car: cars[1] }] });
    const roomMsg = (o, set) => Object.assign({ t: 'room', st: 'lobby', rs: 0, set: Object.assign({ track: 'monza', year: 2024 }, set || {}), ready: [], rr: 0, load: null, len: 0 }, o || {});
    const snap = (year, wear, phase) => ({ t: 'gp', now: 1, s: { sid: 1, phase: phase || 'quali', q: 1, r: 1, len: 5000, year, wear,
      lightsAt: 0, goAt: 0, winnerAt: 0, endsAt: 0, grid: [], order: [7], players: [{ id: 7, name: 'me' }] } });
    const DEF = { track: null, year: null, mode: 'free', q: 3, r: 5, wear: 1, bots: 0, skill: 'pro' };
    try {
      N.setProfile({ car: '2024-ferrari' });
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      assert.deepStrictEqual([inbox[0].v, inbox[0].car], [2, '2024-ferrari'], 'the hello: protocol 2, the car');
      assert.deepStrictEqual([N.year, years(), N.ded, N.room], [null, [], false, { st: 'lobby', rs: 0, set: DEF, ready: [], rr: 0, load: null, len: 0 }],
        'a year that is a string: none, and no event; every field present');
      assert.deepStrictEqual([N.roster.map(p => p.car), N.players[0].car], [['2024-ferrari', ''], ''], 'a car that is not an id: ""');
      assert.deepStrictEqual(N.roster.map(p => [p.ready, p.load]), [[false, ''], [true, '']], 'the host counts as ready');

      // --- room garbage: every field sanitised, never thrown on ---
      await raw({ t: 'room', st: 'lobby', rs: -5, set: { track: '../x', year: 2024.5, mode: 'race', q: 1e9, r: 0, wear: 9, bots: 1e9, skill: '__proto__' },
        ready: [7, 'x', null, 7, 8, {}], rr: 'x', load: { wait: [1] }, len: -1, extra: { a: 1 } });
      assert.deepStrictEqual(N.room, { st: 'lobby', rs: 0, set: Object.assign({}, DEF, { bots: 15 }), ready: [7, 8], rr: 0, load: null, len: 0 });
      assert.deepStrictEqual(N.roster.map(p => p.ready), [true, true]);
      const many = [];
      for (let i = 0; i < 1000; i++) many.push(i + 100);
      await raw({ t: 'room', st: 'loading', rs: 2.9, set: { track: 'spa', year: 2010, mode: 'gp', q: 2.4, r: 99, wear: 4.6, bots: 3.7, skill: 'legend' },
        ready: many, rr: 3, load: { at: 'x', until: 1e999, wait: many, done: [7, 7], fail: 'x' }, len: 5000 });
      assert.deepStrictEqual([N.room.st, N.room.rs, N.room.set, N.room.ready.length, N.room.rr, N.room.load.at, N.room.load.until,
        N.room.load.wait.length, N.room.load.done, N.room.load.fail, N.room.len],
        ['loading', 2, { track: 'spa', year: 2010, mode: 'gp', q: 2, r: 99, wear: 5, bots: 3, skill: 'legend' }, 64, 3, 0, 0, 64, [7], [], 5000]);
      assert.deepStrictEqual(N.roster.map(p => p.load), ['done', ''], 'from load');
      assert.deepStrictEqual(ev.filter(e => /^load|^year/.test(e)).slice(-2), ['year 2010', 'load spa 2'], 'year, room, then load');
      assert.strictEqual(N.sendLoaded(2, true, { len: 1e9, why: 'X' }), true);
      await until(() => inbox.some(m => m.t === 'loaded'), 1000, 'loaded');
      assert.deepStrictEqual(inbox.filter(m => m.t === 'loaded').pop(), { t: 'loaded', rs: 2, ok: true }, 'garbage len / why left out');
      assert.deepStrictEqual([N.sendLoaded(2, true), N.sendLoaded(1, true), N.loadedRs], [false, false, 2]);
      await raw('{"t":"room","st":"session","rs":2,"set":{"track":"spa","q":1e999},"len":1e999}');
      assert.deepStrictEqual([N.room.st, N.room.set.q, N.room.len, N.room.load, ev[ev.length - 1]], ['session', 3, 0, null, 'go']);
      await raw({ t: 'room', st: 'lobby', rs: 2, set: { track: 'spa', year: 2010 } });
      assert.strictEqual(ev[ev.length - 1], 'lobby');
      // nostart: why / ids sanitised
      await raw({ t: 'nostart', why: 'not-ready', wait: [8, 'x', null, 9] }); await raw({ t: 'nostart', why: '<b>BAD</b>', wait: 'x' });
      await raw({ t: 'nostart' });
      assert.deepStrictEqual(ev.filter(e => /^nostart/.test(e)), ['nostart not-ready [8,9]', 'nostart  []', 'nostart  []']);

      // --- year in the room: garbage -> null; a change fires the event, a repeat does not ---
      ev.length = 0;
      for (const y of [2024.5, '2024', 1e308, -2024, 2009, 2101, {}, [2024], true, null, undefined]) await raw(roomMsg({}, { year: y }));
      assert.deepStrictEqual([N.year, years()], [null, ['year null']], 'one change (2010 -> none), then no more');
      await raw(roomMsg()); await raw(roomMsg());
      assert.deepStrictEqual([N.year, years()], [2024, ['year null', 'year 2024']]);
      await raw({ t: 'players', host: 8, year: 2030, players: 'x' });            // not a roster: ignored whole
      await raw({ t: 'players', host: 8, year: 2030, players: [{ id: 7, name: 'me', colour: '#112233', slot: 0 }, { id: 8, name: 'other', colour: '#445566', slot: 1 }] });
      assert.deepStrictEqual([N.year, N.roster.length, years()], [2024, 2, ['year null', 'year 2024']], 'the roster carries no year any more');
      await raw(roomMsg({}, { year: 2030 }));
      assert.deepStrictEqual([N.year, years()], [2030, ['year null', 'year 2024', 'year 2030']]);

      // --- cars in the roster rows ---
      for (const c of [5, null, {}, ['2024-ferrari'], 'A', 'a b', '', 'a'.repeat(41), '2024_x', '<img>', 'x\u0000', '__proto__']) {
        await raw(roster(['2024-ferrari', c]));
        assert.deepStrictEqual([N.players[0].car, N.roster[1].car], ['', ''], JSON.stringify(c));
      }
      await raw(roster(['2024-ferrari', 'a'.repeat(40)]));
      assert.deepStrictEqual([N.players[0].car, N.roster[1].car], ['a'.repeat(40), 'a'.repeat(40)]);

      // --- year / wear in the session snapshot ---
      for (const [y, w, want] of [[2024, 3, [2024, 3]], ['2024', 99, [null, 5]], [2024.5, -1, [null, 1]], [2101, 'x', [null, 1]], [2010, 2.9, [2010, 2]],
        [null, 0, [null, 1]], [{}, {}, [null, 1]], [undefined, undefined, [null, 1]], [[2024], [3], [null, 1]], [2100, 5, [2100, 5]]]) {
        await raw(snap(y, w));
        assert.deepStrictEqual([N.session.year, N.session.wear], want, JSON.stringify([y, w]));
      }
      await raw('{"t":"gp","s":{"sid":1,"phase":"quali","players":[],"year":1e999,"wear":1e999}}');
      assert.deepStrictEqual([N.session.year, N.session.wear], [null, 1]);

      // --- setYear / setRoom: refused locally when not the host / not in the lobby; else sent, net.year waits for the server ---
      assert.strictEqual(N.setYear(2025), false, 'not the host');
      await raw(roster(['2024-ferrari', ''], 7));
      assert.strictEqual(N.isHost, true);
      await raw(roomMsg({ st: 'session', rs: 3 }, { year: 2030 }));
      assert.strictEqual(N.setYear(2025), false, 'a session is on');
      inbox.length = 0;
      await raw(roomMsg({ rs: 3 }, { year: 2030 }));                         // back in the lobby: our car matches, nothing sent
      assert.strictEqual(N.setYear(2025), true);
      await until(() => inbox.some(m => m.t === 'set'), 1000, 'set message');
      assert.deepStrictEqual([inbox.filter(m => m.t === 'set'), inbox.filter(m => m.t === 'profile').length, N.year], [[{ t: 'set', year: 2025 }], 0, 2030]);

      // --- parc fermé resync: back in the lobby and the server has another car for us -> we tell it once ---
      await raw(roster(['old-car', ''], 7));
      await raw(roomMsg({ rs: 3 }, { year: 2030 }));                         // lobby -> lobby: no transition, nothing
      assert.strictEqual(inbox.filter(m => m.t === 'profile').length, 0);
      await raw(roomMsg({ st: 'loading', rs: 4 }, { year: 2030 })); await raw(roomMsg({ st: 'session', rs: 4, set: { track: 'monza', year: 2030, mode: 'gp' } }));
      await raw(snap(2030, 1, 'free')); await raw(snap(2030, 1, 'quali')); await raw(snap(2030, 1, 'free'));
      assert.strictEqual(inbox.filter(m => m.t === 'profile').length, 0, 'not from the gp snapshots any more');
      await raw(roomMsg({ rs: 4 }, { year: 2030 }));
      await until(() => inbox.some(m => m.t === 'profile'), 1000, 'profile sent again');
      await raw(roomMsg({ rs: 4 }, { year: 2030 }));
      assert.deepStrictEqual(inbox.filter(m => m.t === 'profile'), [{ t: 'profile', name: 'Player', colour: '#ff7a14', car: '2024-ferrari' }]);

      // --- a welcome with a real year, in a session: connected, year, room, load ---
      N.leave();
      assert.deepStrictEqual([N.year, N.room], [null, null]);
      welcomeRoom = { st: 'session', rs: 9, set: { track: 'suzuka', year: 2026 } }; ev.length = 0; inbox.length = 0;
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      assert.deepStrictEqual(ev.filter(e => e !== 'players' && e !== 'gp'), ['connected', 'year 2026', 'room', 'load suzuka 9']);
      assert.deepStrictEqual([N.year, N.trackId, N.ded, N.address, inbox.find(m => m.t === 'hello').car], [2026, 'suzuka', false, '127.0.0.1:' + wss.address().port, '2024-ferrari']);
      N.leave();

      // --- version refusals: the text by need ---
      for (const [m, text] of [[{ t: 'error', code: 'version' }, '房間的遊戲版本比較舊（F1Drive v7.1 以前），請房主更新到 v7.2 以上。'],
        [{ t: 'error', code: 'version', need: 3 }, '你的遊戲版本比較舊，請更新後再加入。'], [{ t: 'error', code: 'version', need: 1 }, '遊戲版本與房間不同，無法加入。'],
        [{ t: 'error', code: 'version', need: 'x' }, '房間的遊戲版本比較舊（F1Drive v7.1 以前），請房主更新到 v7.2 以上。']]) {
        refuse = m;
        assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: false, error: text }, JSON.stringify(m));
      }
      assert.strictEqual(uncaught.length, 0, 'nothing thrown out of a message handler');
    } finally {
      wss.clients.forEach(ws => ws.terminate());
      await new Promise(r => wss.close(r));
    }
  });

  /* ---------- hardening: floods, kicks, amplification ---------- */

  /* ---------- computer drivers (bots): the host's game simulates them, the server keeps them as players ---------- */
  lane = lanes.bots;

  T('bots: host only, lobby only; n clamped to the free seats; garbage n / skill / list sanitised; ids and slots kept; newcomers see them; a human takes the newest bot\'s seat', async t => {
    const R = await lobbyRoom(t, 2);
    const [a, b] = R.cs;
    // a guest cannot; a host's n that is not a count changes nothing
    b.send({ t: 'bots', n: 3 });
    for (const n of ['3', -1, null, undefined, {}, [3], true]) a.send({ t: 'bots', n });
    a.send('{"t":"bots","n":1e999}'); a.send('{"t":"bots","n":NaN}'); a.send('{"t":"bots"}');
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().players.length, R.srv.info().bots, R.srv.info().gp.players.length], [2, { n: 0, skill: 'pro' }, 2]);
    // three bots from a list to sanitise
    const ids = await addBots(a, [a, b], 3, [{ name: 'M. Verstappen', car: '2024-red-bull', colour: '#1E41FF', skill: 0.98 },
      { name: '\u0000<b>' + 'x'.repeat(40) + '‮', car: 'BAD CAR', colour: 'red', skill: 'fast' }, 5], 'legend');
    let ros = b.roster(), bots = ros.filter(p => p.bot);
    assert.deepStrictEqual(bots.map(p => [p.id, p.slot, p.bi, p.owner, p.skill, p.car]),
      [[ids[0], 2, 0, a.id, 0.98, '2024-red-bull'], [ids[1], 3, 1, a.id, 1, ''], [ids[2], 4, 2, a.id, 1, '']]);
    assert(ids[0] > b.id && ids[1] === ids[0] + 1 && ids[2] === ids[0] + 2, 'ids from the players\' counter');
    assert.strictEqual(bots[0].name, 'M. Verstappen');
    assert(Array.from(bots[1].name).length === 16 && !/[\u0000‮]/.test(bots[1].name), bots[1].name);
    assert.strictEqual(bots[2].name, 'AI 3');
    assert.strictEqual(bots[0].colour, '#1e41ff');
    assert(bots.every(p => /^#[0-9a-f]{6}$/.test(p.colour)));
    assert.deepStrictEqual(Object.keys(bots[0]).sort(), ['best', 'bi', 'bot', 'car', 'colour', 'id', 'last', 'name', 'owner', 'skill', 'slot']);
    assert.deepStrictEqual(Object.keys(ros.find(p => p.id === a.id)).sort(), ['best', 'car', 'colour', 'id', 'last', 'name', 'slot'], 'human rows as before');
    assert.deepStrictEqual([b.rosterMsg().bots, R.srv.info().bots], [{ n: 3, skill: 'legend' }, { n: 3, skill: 'legend' }]);
    // the session has them: only their rows carry bot: true
    let g = await R.settle(s => s.players.length === 5);
    assert.deepStrictEqual(g.players.map(p => [p.id, p.bot === true]), [[a.id, false], [b.id, false], [ids[0], true], [ids[1], true], [ids[2], true]]);
    assert(!('bot' in g.players[0]));
    // a level that is not one keeps the room's; list entries that are missing / not objects keep what the bot had
    const n0 = b.all('players').length;
    a.send({ t: 'bots', n: 3, skill: 'godlike', list: 'x' });
    a.send({ t: 'bots', n: 3, skill: 7, list: [null, 5, { name: 12, car: 5, colour: [], skill: {} }] });
    a.send('{"t":"bots","n":3,"list":[{"__proto__":{"name":"evil"}}]}');
    await sleep(150);
    assert.strictEqual(b.all('players').length, n0, 'nothing changed: nothing sent');
    assert.deepStrictEqual(R.srv.info().players.filter(p => p.bot).map(p => [p.name, p.skill]), bots.map(p => [p.name, p.skill]));
    // more than there are seats: as many as there are (16 - 2 humans); the first three keep their ids and slots
    a.send({ t: 'bots', n: 999, skill: 'rookie' });
    await b.wait(() => b.roster().filter(p => p.bot).length === 14, 2000, '14 bots');
    ros = b.roster(); bots = ros.filter(p => p.bot).sort((x, y) => x.bi - y.bi);
    assert.deepStrictEqual(bots.slice(0, 3).map(p => [p.id, p.slot]), [[ids[0], 2], [ids[1], 3], [ids[2], 4]]);
    assert.deepStrictEqual([ros.length, bots.map(p => p.bi), bots[3].skill, bots[3].name], [16, [...Array(14).keys()], 0, 'AI 4']);
    assert.deepStrictEqual(ros.map(p => p.slot), [...Array(16).keys()]);
    a.send({ t: 'bots', n: 1e308 });
    await sleep(150);
    assert.strictEqual(R.srv.info().players.length, 16);
    // fewer: the first ones stay (renamed in the roster and the session)
    await addBots(a, [a, b], 2, [{}, { name: 'Renamed' }]);
    g = await R.settle(s => s.players.length === 4 && s.players[3].name === 'Renamed');
    assert.deepStrictEqual(R.srv.info().players.filter(p => p.bot).map(p => [p.id, p.name]), [[ids[0], 'M. Verstappen'], [ids[1], 'Renamed']]);
    // a newcomer sees them in his welcome and his first snapshot
    const c = await client(R.srv.port, { name: 'C' });
    R.cs.push(c);
    assert.deepStrictEqual([c.last('welcome').players.filter(p => p.bot).map(p => p.id), c.last('welcome').bots], [[ids[0], ids[1]], { n: 2, skill: 'rookie' }]);
    await c.wait(() => c.gp() && c.gp().players.filter(p => p.bot).length === 2, 2000, 'bots in his first snapshot');
    assert.strictEqual(c.last('welcome').players.find(p => p.id === c.id).slot, 4, 'the lowest free slot');
    // a full room in the lobby: a human takes the seat of the newest bot
    await addBots(a, [a, b, c], 13);
    const newest = c.roster().filter(p => p.bot).sort((x, y) => y.bi - x.bi)[0];
    const d = await client(R.srv.port, { name: 'D' });
    R.cs.push(d);
    assert(d.last('welcome'), 'D is in');
    await c.wait(() => c.roster().length === 16 && c.roster().some(p => p.id === d.id), 2000, 'D in the roster');
    assert(!c.roster().some(p => p.id === newest.id), 'the newest bot made room');
    assert.deepStrictEqual([c.roster().filter(p => p.bot).length, c.rosterMsg().bots.n, d.last('welcome').players.find(p => p.id === d.id).slot], [12, 12, newest.slot]);
    assert(!c.all('gone').some(m => m.id === newest.id), 'no gone for a bot: the roster says it');
    // a session is on: parc fermé for the field, and a full room is full
    await R.start(1, 1);
    a.send({ t: 'bots', n: 0 });
    await sleep(150);
    assert.strictEqual(R.srv.info().players.filter(p => p.bot).length, 12);
    const e = await client(R.srv.port, { name: 'E' });
    assert.deepStrictEqual([e.last('welcome'), e.last('error') && e.last('error').code], [null, 'full']);
    [a, b, c, d, e].forEach(x => x.ws.close());
  });

  T('bots: states (bs) only from their owner, validated like s, relayed in the snapshots; their laps (gl id) need their states; glno carries the id; lap times (lap id); progress rides on bs', async t => {
    const R = await lobbyRoom(t, 2);
    const [a, b] = R.cs;
    const ids = await addBots(a, [a, b], 2);
    botStates(a, [[ids[0], 1, 0, 1, 0, 0, 0, 10, 0]]);                         // the lobby: nobody is on a track
    await R.go();                                                                // free practice
    // nothing of this is a state of the host's bots
    botStates(b, [[ids[0], 1, 0, 1, 0, 0, 0, 10, 0]]);                         // not his
    a.send({ t: 'bs', k: a.rs() + 1, c: 1, b: [[ids[0], 1, 0, 1, 0, 0, 0, 10, 0]] });   // another load cycle's
    a.send({ t: 'bs', k: a.rs(), c: 'x', b: [[ids[0], 1, 0, 1, 0, 0, 0, 10, 0]] });
    a.send({ t: 'bs', k: a.rs(), c: 1, b: 'x' });
    a.send({ t: 'bs', k: a.rs(), c: 1, b: { 0: [ids[0], 1, 0, 1, 0, 0, 0, 10, 0], length: 1 } });
    botStates(a, [[ids[0]], [ids[0], 'x', 0, 0, 0, 0, 0, 0, 0], [b.id, 1, 0, 1, 0, 0, 0, 0, 0], [a.id, 1, 0, 1, 0, 0, 0, 0, 0], [999, 1, 0, 1, 0, 0, 0, 0, 0],
      null, 5, 'x', [ids[0], 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [String(ids[0]), 1, 0, 1, 0, 0, 0, 0, 0]]);
    a.send('{"t":"bs","k":' + a.rs() + ',"c":1,"b":[[' + ids[0] + ',1e999,0,0,0,0,0,0,0]]}');
    await sleep(200);
    assert(!b.all('snap').some(m => m.p.some(e => ids.includes(e[0]))), 'nothing of the bots relayed');
    // a good one: clamped / rounded like s; the same bot twice in one message: the first row
    botStates(a, [[ids[0], 1e9, 5, 2.123456, 7, 3, -3, 999, 5, 0.5], [ids[0], 9, 9, 9, 9, 0, 0, 0, 0], [ids[1], 10, 0, 20, 0.5, 0, 0, 30, 0.1]], 123456);
    await b.wait(() => b.all('snap').some(m => m.p.some(e => e[0] === ids[1])), 2000, 'bot states relayed');
    const rows = {};
    b.all('snap').forEach(m => m.p.forEach(e => { rows[e[0]] = e; }));
    assert.deepStrictEqual(rows[ids[0]], [ids[0], 123456, 100000, 5, 2.12, 0.7168, 1.2, -1.2, 130, 1]);
    assert.deepStrictEqual(rows[ids[1]], [ids[1], 123456, 10, 0, 20, 0.5, 0, 0, 30, 0.1]);
    // qualifying: a lap of a bot whose states do not cover it is answered with the reason AND the bot's id (host only)
    await R.start(1, 1);
    R.clk.add(3000);
    a.send({ t: 'gl', k: a.rs(), sid: a.gp().sid, time: 2.5, id: ids[1] });
    await a.wait(() => a.last('glno'), 2000, 'glno');
    assert.deepStrictEqual(a.last('glno'), { t: 'glno', why: 'not-driven', id: ids[1] });
    // the guest cannot report the host's bot's lap or lap times: no answer, nothing counted
    botRun(a, ids[0], LEN);
    b.send({ t: 'gl', k: b.rs(), sid: b.gp().sid, time: 2.5, id: ids[0] });
    b.send({ t: 'lap', k: b.rs(), last: 70, best: 70, id: ids[0] });
    await sleep(150);
    assert.deepStrictEqual([b.last('glno'), R.srv.info().gp.players.find(p => p.id === ids[0]).qLaps, R.srv.info().players.find(p => p.id === ids[0]).best], [null, 0, null]);
    // the host's: backed by the bots' states, they count; the grid goes by time, bots or not
    botLap(a, ids[0], 2.6); botLap(a, ids[1], 2.4); a.lap(2.5); b.lap(2.7);
    const g = await R.settle(s => s.phase === 'grid');
    assert.deepStrictEqual(g.grid, [ids[1], a.id, ids[0], b.id]);
    a.send({ t: 'lap', k: a.rs(), last: 82.5, best: 81.25, id: ids[0] });
    await b.wait(() => b.roster().find(p => p.id === ids[0]).best === 81.25, 2000, 'bot lap times in the roster');
    // the race: progress rides on the bots' rows (g), held to what their path covered, as a player's
    R.clk.to(g.goAt);
    await R.settle(s => s.phase === 'race');
    R.clk.add(3000);
    botRun(a, ids[0], 150, 0.7); botRun(a, ids[1], 150, 0.2); a.run(150, 0.5); b.run(150, 0.4);
    let s = await R.settle(x => x.order[0] === ids[0]);
    assert.deepStrictEqual(s.order, [ids[0], a.id, b.id, ids[1]]);
    // bot 1 standing still claims a lap and a half: held to its 150 m of driving (150 / (0.85 x 200) = 0.88 of a lap)
    botRun(a, ids[0], 150, 0.95); botRun(a, ids[1], 0, 1.5);
    s = await R.settle(x => x.order[1] === ids[1]);
    assert.deepStrictEqual(s.order, [ids[0], ids[1], a.id, b.id]);
    [a, b].forEach(x => x.ws.close());
  });

  T('bots: the host leaving takes his bots out of the session (race: DNF, qualifying: gone); the others race on; the same in a token room', async t => {
    // dedicated server, during the race: the bots are DNF, the humans still racing finish it (review r3: the race
    // used to be cut short to the results, the one left classified with 0 laps)
    let R = await lobbyRoom(t, 3);
    let [a, b, c] = R.cs;
    let ids = await addBots(a, [a, b, c], 2);
    await R.start(1, 2);
    R.clk.add(3000);
    botLap(a, ids[0], 2.6); botLap(a, ids[1], 2.7); a.lap(2.5); b.lap(2.8); c.lap(2.9);
    const g = await R.settle(s => s.phase === 'grid');
    R.clk.to(g.goAt);
    await R.settle(s => s.phase === 'race');
    R.clk.add(3000);
    b.lap(2.8); c.lap(2.9);
    await R.settle(s => s.players.filter(p => p.rLaps === 1).length === 2);
    a.ws.close();
    await b.wait(() => b.roster().length === 2 && b.gp().players.filter(p => p.dnf).length === 3, 2000, 'bots DNF');
    let s = b.gp();
    assert.strictEqual(s.phase, 'race', 'the race goes on');
    assert.deepStrictEqual(s.players.map(p => [p.id, p.bot === true, p.left, p.dnf, p.rLaps]),
      [[a.id, false, true, true, 0], [b.id, false, false, false, 1], [c.id, false, false, false, 1],
       [ids[0], true, true, true, 0], [ids[1], true, true, true, 0]]);
    assert.deepStrictEqual(s.order.slice(0, 2), [b.id, c.id], 'the ones still racing ahead of the DNFs');
    assert.deepStrictEqual([b.host(), b.rosterMsg().bots], [b.id, { n: 0, skill: 'pro' }]);
    assert.deepStrictEqual(b.all('gone').map(m => m.id), [a.id], 'gone for the player only');
    assert.strictEqual(R.srv.info().players.length, 2);
    // ...and B and C take the flag
    R.clk.add(3000);
    b.lap(2.8); c.lap(2.9);
    s = await R.settle(x => x.phase === 'results');
    assert.deepStrictEqual(s.players.map(p => [p.id, p.rLaps, p.fin, p.dnf]),
      [[a.id, 0, false, true], [b.id, 2, true, false], [c.id, 2, true, false], [ids[0], 0, false, true], [ids[1], 0, false, true]]);
    assert.deepStrictEqual(s.order.slice(0, 2), [b.id, c.id]);
    b.ws.close(); c.ws.close();
    // dedicated server, during qualifying: the bots leave it, B (the next host) qualifies on; then free practice
    // (his end) and he can have his own
    R = await lobbyRoom(t, 2);
    [a, b] = R.cs;
    ids = await addBots(a, [a, b], 3, null, 'amateur');
    await R.start(2, 2);
    a.ws.close();
    await b.wait(() => b.roster().length === 1 && b.host() === b.id && b.gp().players.length === 1, 2000, 'bots gone');
    assert.deepStrictEqual([b.gp().phase, b.gp().players.map(p => p.id)], ['quali', [b.id]]);
    assert.deepStrictEqual(b.rosterMsg().bots, { n: 0, skill: 'amateur' }, 'the level stays with the room');
    R.clk.add(3000); b.lap(2.6);
    await b.wait(() => b.gp().players[0].qLaps === 1, 2000, 'lap 1');
    R.clk.add(3000); b.lap(2.6);
    await b.wait(() => b.gp().phase === 'grid', 2000, 'grid');
    assert.deepStrictEqual(b.gp().grid, [b.id]);
    b.send({ t: 'gp', a: 'end' });
    await b.wait(() => b.gp().phase === 'free' && b.room().st === 'lobby', 2000, 'free, the lobby');
    const ids2 = await addBots(b, [b], 1);
    assert(ids2[0] > ids[2] && b.roster().find(p => p.id === ids2[0]).owner === b.id);
    b.ws.close();
    // dedicated server, free practice: the session is not touched
    R = await lobbyRoom(t, 2);
    [a, b] = R.cs;
    await addBots(a, [a, b], 2);
    await R.go();
    a.ws.close();
    await b.wait(() => b.roster().length === 1, 2000, 'bots gone');
    assert.deepStrictEqual([b.gp().phase, b.gp().players.length, b.gp().sid], ['free', 1, 0]);
    b.ws.close();
    // token room: the host's bots go with him, out of the session as on a dedicated server (the room closes anyway:
    // the game stops the server)
    R = await lobbyRoom(t, 2, { hostToken: 'tok' });
    [a, b] = R.cs;
    assert.strictEqual(a.host(), a.id);
    ids = await addBots(a, [a, b], 2);
    b.send({ t: 'bots', n: 0 });
    await sleep(100);
    assert.strictEqual(R.srv.info().players.length, 4, 'a guest cannot change them');
    await R.start(1, 1);
    a.ws.close();
    await b.wait(() => b.roster().length === 1 && b.gp().players.length === 1, 2000, 'token room: bots gone');
    assert.deepStrictEqual([b.gp().phase, b.gp().players.map(p => p.id), b.host()], ['quali', [b.id], 0]);
    b.ws.close();
  });

  T('bots: hostile messages from a guest and garbage from the host never change the room nor crash; a host with bots has a bigger message budget', async t => {
    const R = await lobbyRoom(t, 2);
    const [a, b] = R.cs;
    const ids = await addBots(a, [a, b], 14);                      // 2 humans + 14 bots: a full room
    await R.go();                                                  // free practice
    a.drive(0, 0); b.drive(5, 0); botStates(a, [[ids[0], 2, 0, 0, 0, 0, 0, 0, 0], [ids[1], 7, 0, 0, 0, 0, 0, 0, 0]]);
    await sleep(100);
    const state = () => JSON.stringify([R.srv.info().players, R.srv.info().bots, R.srv.info().gp]);
    const before = state();
    // the guest speaking for the host's bots / as the host
    for (const m of [{ t: 'bots', n: 0 }, { t: 'bots', n: 16, skill: 'legend' }, { t: 'gl', k: b.rs(), sid: 0, time: 80, id: ids[0] },
      { t: 'lap', k: b.rs(), last: 70, best: 70, id: ids[0] }, { t: 'lap', k: b.rs(), last: 70, best: 70, id: a.id }, { t: 'hit', k: b.rs(), to: a.id, from: ids[0], i: [5, 0] },
      { t: 'hit', k: b.rs(), to: ids[1], from: ids[0], i: [5, 0] }, { t: 'bs', k: b.rs(), c: 1, b: [[ids[0], 50, 0, 0, 0, 0, 0, 0, 0]] }]) b.send(m);
    // garbage from the host
    for (const m of [{ t: 'bots', n: 14, list: [null, 5, 'x', [], { name: {}, car: [], colour: 5, skill: 'x' }] }, { t: 'bots', n: '14' },
      { t: 'gl', k: a.rs(), sid: 0, time: 80, id: 'x' }, { t: 'gl', k: a.rs(), sid: 0, time: 80, id: b.id }, { t: 'gl', k: a.rs(), sid: 0, time: 80, id: 999 },
      { t: 'gl', k: a.rs(), sid: 0, time: 80, id: null }, { t: 'lap', k: a.rs(), last: 1, best: 1, id: b.id }, { t: 'lap', k: a.rs(), last: 70, best: 70, id: '5' },
      { t: 'hit', k: a.rs(), to: ids[1], from: ids[0], i: [1, 0] }, { t: 'hit', k: a.rs(), to: ids[0], i: [1, 0] }, { t: 'hit', k: a.rs(), to: a.id, from: ids[0], i: [1, 0] },
      { t: 'hit', k: a.rs(), to: b.id, from: 'x', i: [1, 0] }, { t: 'hit', k: a.rs(), to: b.id, from: b.id, i: [1, 0] }, { t: 'hit', k: a.rs(), to: b.id, from: 999, i: [1, 0] },
      { t: 'bs', k: a.rs(), c: 1, b: [] }, { t: 'bs', k: a.rs(), c: 1, b: Array(40).fill(null) }]) a.send(m);
    a.send('{"t":"bots","n":14,"list":[{"__proto__":{"name":"evil"}},{"constructor":{"name":"x"}}],"skill":"__proto__"}');
    a.send('{"t":"bots","n":14,"skill":"constructor"}'); a.send('{"t":"bots","n":14,"skill":"hasOwnProperty"}');
    await sleep(250);
    assert.strictEqual(state(), before, 'nothing changed');
    assert.deepStrictEqual([a.all('hit').length, b.all('hit').length, b.all('glno').length, a.closed, b.closed], [0, 0, 0, null, null]);
    // the host's connection may send more while it simulates bots: 200 lap times in one go all count; a guest's do not
    // (BOT_RATE 4 / s per bot: the host's bucket holds 120 + 2 x 4 x 14 = 232 once it has refilled, ~1 s)
    await sleep(1200);
    for (let i = 0; i < 200; i++) a.send({ t: 'lap', k: a.rs(), last: 60 + i, best: 60, id: ids[i % 14] });
    for (let i = 0; i < 200; i++) b.send({ t: 'lap', k: b.rs(), last: 60 + i, best: 60 });
    await b.wait(() => b.roster().find(p => p.id === ids[199 % 14]).last === 259, 2000, 'every bot lap time');
    await sleep(150);
    const guest = b.roster().find(p => p.id === b.id).last;
    assert(guest >= 150 && guest < 259, 'the guest\'s burst is RATE_BURST: ' + guest);
    assert(!a.closed && !b.closed);
    [a, b].forEach(x => x.ws.close());
  });

  lane = lanes.bots2;                          // real time: impact reports judge motion by arrival time

  T('bots: impact reports to / from bots under the same rules (their positions, ghosts, throttle); never between one player\'s own cars', async t => {
    const R = await lobbyRoom(t, 3);
    const [a, b, o] = R.cs;
    const ids = await addBots(a, [a, b, o], 2);
    await R.go();                                                  // free practice
    // b parked at the origin; the host far away; bot 1 parked 6 m in front of b
    const keep = setInterval(() => { b.drive(0, 0); a.drive(-500, 50); botStates(a, [[ids[1], 6, 0, 0, 0, 0, 0, 0, 0]]); }, 50);
    await sleep(160);
    let sent = 0;
    // bot 0 drives the last 3 m at 20 m/s at b, then the host reports its hit for it
    const botHits = async (to, from, expected, label) => {
      const n = to.all('hit').length;
      await botDriveTo(a, from, -9, -3, 0, 3);
      a.send({ t: 'hit', k: a.rs(), to: to.id, from, i: [++sent, 0] });
      if (expected) {
        await to.wait(() => to.all('hit').length === n + 1, 1000, label);
        assert.deepStrictEqual(to.last('hit'), { t: 'hit', from, i: [sent, 0] }, label);
      } else { await sleep(120); assert.strictEqual(to.all('hit').length, n, label); }
    };
    await botHits(b, ids[0], true, 'a bot hits a player: he hears it from the bot');
    assert.strictEqual(o.all('hit').length + a.all('hit').length, 0, 'nobody else');
    // b drives into bot 1: its owner hears it, told which of his bots it was
    await driveTo(b, 0, 3, 0, 3);
    b.send({ t: 'hit', k: b.rs(), to: ids[1], i: [4, 0] });
    await a.wait(() => a.all('hit').length === 1, 1000, 'the owner hears his bot was hit');
    assert.deepStrictEqual(a.last('hit'), { t: 'hit', from: b.id, bot: ids[1], i: [4, 0] });
    // a parked bot claiming to ram at 130 m/s: only the slack (its positions do not close on him); both cars parked
    // for longer than the motion window (500 ms)
    const n0 = b.all('hit').length;
    for (let k = 0; k < 12; k++) { botStates(a, [[ids[0], -3, 0, 0, Math.PI / 2, 0, 0, 130, 0]]); await sleep(50); }
    a.send({ t: 'hit', k: a.rs(), to: b.id, from: ids[0], i: [80, 0] });
    await b.wait(() => b.all('hit').length === n0 + 1, 1000, 'slack');
    assert(Math.hypot(...b.last('hit').i) <= 3.01, 'a parked bot: only the slack: ' + JSON.stringify(b.last('hit').i));
    // a teleported bot reports nothing; two reports of one bot within 40 ms: the first
    botStates(a, [[ids[0], -2000, 0, 0, 0, 0, 0, 0, 0]]); await sleep(60);
    botStates(a, [[ids[0], -3, 0, 0, Math.PI / 2, 0, 0, 20, 0]]);
    a.send({ t: 'hit', k: a.rs(), to: b.id, from: ids[0], i: [2, 0] });
    await sleep(120);
    assert.strictEqual(b.all('hit').length, n0 + 1, 'nothing after a teleport');
    await botDriveTo(a, ids[0], -9, -3, 0, 3);
    a.send({ t: 'hit', k: a.rs(), to: b.id, from: ids[0], i: [2, 0] });
    a.send({ t: 'hit', k: a.rs(), to: b.id, from: ids[0], i: [3, 0] });
    await b.wait(() => b.all('hit').length === n0 + 2, 1000, 'one of two');
    await sleep(100);
    assert.deepStrictEqual([b.all('hit').length, b.last('hit').i], [n0 + 2, [2, 0]]);
    // never between one player's own cars: his game settles those (his car / his bots)
    await botDriveTo(a, ids[0], 1, 4, 0, 3);
    a.send({ t: 'hit', k: a.rs(), to: ids[1], from: ids[0], i: [1, 0] });
    a.send({ t: 'hit', k: a.rs(), to: ids[1], i: [1, 0] });
    await sleep(60);
    a.send({ t: 'hit', k: a.rs(), to: a.id, from: ids[1], i: [1, 0] });
    await sleep(120);
    assert.deepStrictEqual([a.all('hit').length, b.all('hit').length, o.all('hit').length], [1, n0 + 2, 0]);
    // qualifying: bots are ghosts like everybody
    clearInterval(keep);
    await R.start(1, 1);
    const keep2 = setInterval(() => { b.drive(0, 0); botStates(a, [[ids[1], 6, 0, 0, 0, 0, 0, 0, 0]]); }, 50);
    await sleep(120);
    await botHits(b, ids[0], false, 'qualifying: a ghost');
    await driveTo(b, 0, 3, 0, 3);
    b.send({ t: 'hit', k: b.rs(), to: ids[1], i: [4, 0] });
    await sleep(120);
    assert.strictEqual(a.all('hit').length, 1, 'qualifying: nothing to the owner');
    clearInterval(keep2);
    R.cs.forEach(x => x.ws.close());
  });

  lane = lanes.botsClient;

  T('js/net.js bots against the real server: setBots, net.bots / roster / players, states relayed and kept alive, laps / lap times / impacts by bot id, the host leaving', async t => {
    const clk = manualClock();
    const srv = await t.start({ now: clk, random: () => 0, startMinMs: 0 });
    const A = freshNet(), B = freshNet();
    const ev = { A: [], B: [] };
    for (const [k, N] of [['A', A], ['B', B]]) {
      N.on('bots', l => ev[k].push(['bots', l.map(x => x.id)]));
      N.on('botHit', (id, from, i) => ev[k].push(['botHit', id, from, i]));
      N.on('hit', (from, i) => ev[k].push(['hit', from, i]));
      N.on('botLapRejected', (id, why) => ev[k].push(['botLapRejected', id, why]));
      N.on('lapRejected', why => ev[k].push(['lapRejected', why]));
    }
    const take = k => ev[k].splice(0);
    assert.strictEqual(A.setBots(2), false, 'not connected');
    assert.deepStrictEqual(await A.join('127.0.0.1:' + srv.port), { ok: true });
    assert.deepStrictEqual(await B.join('127.0.0.1:' + srv.port), { ok: true });
    await until(() => A.roster.length === 2 && B.roster.length === 2, 2000, 'roster');
    assert.deepStrictEqual([A.bots, A.botSettings], [[], { n: 0, skill: 'pro' }]);
    assert.strictEqual(B.setBots(2), false, 'not the host');
    for (const bad of ['2', null, {}, -1, NaN, undefined]) assert.strictEqual(A.setBots(bad), false, String(bad));
    assert.strictEqual(A.setBots([{ name: 'M. Verstappen', car: '2026-red-bull', colour: '#1E41FF', skill: 0.98 },
      { name: 'L. Norris', car: '2026-mclaren', skill: 0.7 }, { car: 'BAD' }], 'legend'), true);
    await until(() => A.bots.length === 3 && B.players.length === 4, 2000, 'bots');
    const ids = A.bots.map(x => x.id);
    assert.deepStrictEqual(A.bots.map(x => [x.name, x.car, x.skill, x.bi, x.slot, x.colour]),
      [['M. Verstappen', '2026-red-bull', 0.98, 0, 2, '#1e41ff'], ['L. Norris', '2026-mclaren', 0.7, 1, 3, A.bots[1].colour], ['AI 3', '', 1, 2, 4, A.bots[2].colour]]);
    assert.deepStrictEqual([take('A'), take('B')], [[['bots', ids]], []], 'only the owner hears about his bots');
    // our own bots are local cars: in our roster (mine), not in our players
    assert.deepStrictEqual(A.players.map(p => p.id), [B.id]);
    assert.deepStrictEqual(A.roster.filter(p => p.bot).map(p => [p.id, p.mine, p.owner]), ids.map(id => [id, true, A.id]));
    assert.deepStrictEqual(B.players.map(p => [p.id, p.bot, p.skill, p.car, p.owner]),
      [[A.id, false, null, '', 0], [ids[0], true, 0.98, '2026-red-bull', A.id], [ids[1], true, 0.7, '2026-mclaren', A.id], [ids[2], true, 1, '', A.id]]);
    assert.deepStrictEqual(B.roster.map(p => [p.bot, p.mine]), [[false, false], [false, false], [true, false], [true, false], [true, false]]);
    assert.deepStrictEqual([A.botSettings, B.botSettings, B.bots], [{ n: 3, skill: 'legend' }, { n: 3, skill: 'legend' }, []]);
    // states: only ours go out, only in the session of the cycle we loaded; B draws them like a player's car; the
    // keepalive repeats them parked
    const st = (x, z, v) => ({ x, y: 1, z, heading: Math.PI / 2, pitch: 0, roll: 0, speed: v || 0, steer: 0.1 });
    assert.strictEqual(A.sendBotStates([{ id: ids[0], state: st(0, 0) }], true), false, 'the lobby: nobody is on a track');
    assert.strictEqual(A.selectTrack('monza'), true);
    await until(() => B.trackId === 'monza', 2000, 'track');
    assert.strictEqual(A.startRoom({ len: LEN, force: true }), true);
    await until(() => A.room.st === 'loading' && B.room.st === 'loading', 2000, 'loading');
    assert.strictEqual(A.sendBotStates([{ id: ids[0], state: st(0, 0) }], true), false, 'loading');
    A.sendLoaded(1, true, { len: LEN }); B.sendLoaded(1, true, { len: LEN });
    await until(() => A.room.st === 'session' && B.room.st === 'session', 2000, 'session');
    assert.strictEqual(A.setBots(1), false, 'the field is set in the lobby only');
    assert.strictEqual(A.sendBotStates([{ id: B.id, state: st(0, 0) }, { id: 999, state: st(0, 0) }], true), false, 'not ours');
    assert.strictEqual(A.sendBotStates([{ id: ids[0], state: st(-40, 0, 20) }, { id: ids[1], state: st(30, 30) }, { id: ids[0], state: st(99, 99) }], true), true);
    assert.strictEqual(A.sendBotStates([{ id: ids[1], state: st(31, 30) }]), false, 'at most ~20 times a second');
    await until(() => { B.update(); const p = B.players.find(q => q.id === ids[1]); return p && p.active; }, 2000, 'bot pose at B');
    assert(Math.abs(B.players.find(q => q.id === ids[1]).state.x - 30) < 1 && B.players.find(q => q.id === ids[1]).state.z === 30);
    await sleep(3300);                                              // longer than a remote car stays visible without news
    B.update();
    const kept = B.players.find(q => q.id === ids[1]);
    assert.deepStrictEqual([kept.active, kept.state.speed], [true, 0], 'kept alive, parked, while A sends nothing');
    // impacts (free practice: everybody solid). B parked at the origin; bot 0 drives the last 3 m at it
    const keep = setInterval(() => B.sendState(st(0, 0), true), 50);
    for (let k = 0; k <= 3; k++) { A.sendBotStates([{ id: ids[0], state: st(-9 + k * 2, 0, 40) }], true); await sleep(50); }
    assert.strictEqual(A.sendHit(B.id, 5, 0, ids[0]), true);
    assert.strictEqual(A.sendHit(B.id, 5, 0, ids[0]), false, 'one per bot per 40 ms');
    assert.deepStrictEqual([A.sendHit(ids[1], 1, 0), A.sendHit(A.id, 1, 0), A.sendHit(B.id, 1, 0, B.id), A.sendHit(B.id, 1, 0, 999)], [false, false, false, false]);
    await until(() => ev.B.length, 1000, 'hit from a bot');
    assert.deepStrictEqual(take('B'), [['hit', ids[0], [5, 0]]]);
    // B drives into bot 1 (parked at 6, 0): A hears which of its bots was hit
    A.sendBotStates([{ id: ids[1], state: st(6, 0) }], true);
    clearInterval(keep);
    for (let k = 0; k <= 3; k++) { B.sendState(st(k, 0, 20), true); A.sendBotStates([{ id: ids[1], state: st(6, 0) }], true); await sleep(50); }
    B.sendHit(ids[1], 4, 0);
    await until(() => ev.A.length, 1000, 'botHit');
    assert.deepStrictEqual(take('A'), [['botHit', ids[1], B.id, [4, 0]]]);
    // a Grand Prix: bot laps by id (rejections come back by id), lap times by id, parc fermé for the field
    assert.strictEqual(A.backToLobby(), true);
    await until(() => A.room.st === 'lobby' && B.room.st === 'lobby', 2000, 'lobby');
    assert.strictEqual(A.setRoom({ mode: 'gp', q: 1, r: 1 }), true);
    await until(() => B.room.set.mode === 'gp', 2000, 'mode gp');
    assert.strictEqual(A.startRoom({ len: LEN, force: true }), true);
    await until(() => A.room.st === 'loading' && B.room.st === 'loading', 2000, 'loading 2');
    A.sendLoaded(2, true, { len: LEN }); B.sendLoaded(2, true, { len: LEN });
    await until(() => A.session && A.session.phase === 'quali' && B.session && B.session.phase === 'quali', 2000, 'quali');
    assert.deepStrictEqual(B.session.players.map(p => p.bot === true), [false, false, true, true, true]);
    assert.strictEqual(A.setBots(0), false, 'parc fermé');
    clk.add(3000);
    const sid = A.session.sid;
    assert.deepStrictEqual([A.sendGpLap(sid, 2.5, undefined, B.id), B.sendGpLap(sid, 2.5, undefined, ids[0]), A.sendGpLap(sid, 2.5, undefined, 999)], [false, false, false]);
    assert.strictEqual(A.sendGpLap(sid, 2.5, undefined, ids[2]), true);
    await until(() => ev.A.length, 2000, 'botLapRejected');
    assert.deepStrictEqual(take('A'), [['botLapRejected', ids[2], 'not-driven']], 'by id, not as our own lapRejected');
    A.sendBotStates([{ id: ids[0], state: st(0, 0) }], true);
    A.sendBotStates([{ id: ids[0], state: st(200, 0) }], true);
    assert.strictEqual(A.sendGpLap(sid, 2.5, clk(), ids[0]), true);
    await until(() => A.session.players.find(p => p.id === ids[0]).qLaps === 1, 2000, 'bot lap counted');
    assert.deepStrictEqual([A.sendLap(80.1, 80.1, B.id), A.sendLap(80.1, 80.1, ids[0])], [false, true]);
    await until(() => B.players.find(p => p.id === ids[0]).best === 80.1, 2000, 'bot lap time');
    assert.deepStrictEqual([take('A'), take('B')], [[], []]);
    // the host leaves: his bots go, out of qualifying too; B (the next host) qualifies on
    A.leave();
    assert.deepStrictEqual([A.bots, A.botSettings, take('A')], [[], { n: 0, skill: 'pro' }, [['bots', []]]]);
    await until(() => B.roster.length === 1 && B.session.players.length === 1, 2000, 'bots gone');
    assert.deepStrictEqual([B.players, B.isHost, B.session.phase, B.session.players[0].id], [[], true, 'quali', B.id]);
    B.leave();
    assert.strictEqual(uncaught.length, 0);
  });

  T('js/net.js bots against a hostile server: garbage bot rows / settings; hits and lap answers about cars that are not ours; what it sends', async t => {
    const wss = new WebSocket.Server({ port: nextPort(), host: '127.0.0.1' });
    await new Promise(r => wss.on('listening', r));
    let sock = null;
    const inbox = [];
    const players = [{ id: 7, name: 'me', colour: '#112233', slot: 0 },
      { id: 20, name: 'mine', colour: '#445566', slot: 1, bot: true, skill: 7, owner: 7, bi: 1 },
      { id: 21, name: 'mine too', colour: '#445566', slot: 2, bot: true, skill: 'x', owner: 7, bi: 0 },
      { id: 22, name: 'theirs', slot: 3, bot: true, skill: 0.5, owner: 8 },
      { id: 23, name: 'fake', slot: 4, bot: 'yes', owner: 7 },
      { id: 7, name: 'me again as a bot', bot: true, owner: 7 },
      { id: 24, slot: 5, bot: true }];
    wss.on('connection', ws => {
      sock = ws;
      ws.on('message', d => {
        const m = JSON.parse(d.toString());
        inbox.push(m);
        if (m.t === 'hello') ws.send(JSON.stringify({ t: 'welcome', v: 2, id: 7, host: 7, now: Date.now(), bots: 'x', players,
          room: { st: 'session', rs: 3, set: { track: 'monza' }, ready: [], rr: 0, load: null, len: 5000 } }));
      });
    });
    const N = freshNet(), ev = [];
    for (const n of ['bots', 'botHit', 'hit', 'botLapRejected', 'lapRejected']) N.on(n, (a, b, c) => ev.push([n, a, b, c]));
    const raw = async s => { sock.send(typeof s === 'string' ? s : JSON.stringify(s)); await sleep(15); };
    try {
      assert.deepStrictEqual(await N.join('127.0.0.1:' + wss.address().port), { ok: true });
      assert.strictEqual(N.sendLoaded(3, true), true);              // (the room's session: our cars may go out)
      assert.deepStrictEqual(N.bots.map(x => [x.id, x.bi, x.skill, x.name]), [[21, 0, null, 'mine too'], [20, 1, 1, 'mine']]);
      assert.deepStrictEqual(N.players.map(p => [p.id, p.bot, p.skill, p.owner, p.name]),
        [[22, true, 0.5, 8, 'theirs'], [23, false, null, 0, 'fake'], [24, true, null, 0, 'AI 24']]);
      assert.deepStrictEqual([N.botSettings, N.roster.length, ev.length, ev[0][0], ev[0][1] === N.bots], [{ n: 0, skill: 'pro' }, 6, 1, 'bots', true]);
      ev.length = 0;
      // settings garbage -> sane; the same bots again -> no event
      await raw({ t: 'players', host: 7, bots: { n: 1e9, skill: '__proto__' }, players });
      assert.deepStrictEqual([N.botSettings, ev], [{ n: 16, skill: 'pro' }, []]);
      await raw({ t: 'players', host: 7, bots: { n: 2.7, skill: 'rookie' }, players });
      assert.deepStrictEqual(N.botSettings, { n: 2, skill: 'rookie' });
      await raw({ t: 'players', host: 7, players });
      assert.deepStrictEqual(N.botSettings, { n: 2, skill: 'rookie' }, 'a roster without the field keeps it');
      // hits: one of ours by a remote car -> botHit (clamped); about cars that are not ours / from our own -> nothing
      for (const h of [{ from: 22, bot: 20, i: [3, 4] }, { from: 22, bot: 22, i: [1, 0] }, { from: 21, bot: 20, i: [1, 0] }, { from: 22, bot: 'x', i: [1, 0] },
        { from: 22, bot: 20, i: [1e150, 0] }, { from: 22, bot: 20, i: [1e300, 1e300] }, { from: 21, i: [1, 0] }, { from: 22, bot: null, i: [1, 0] },
        { from: 22, i: [0, 2] }]) await raw(Object.assign({ t: 'hit' }, h));
      assert.deepStrictEqual(ev.splice(0).map(e => e.slice(0, 4)), [['botHit', 20, 22, [3, 4]], ['botHit', 20, 22, [50, 0]], ['hit', 22, [0, 2], undefined]]);
      // lap answers by id: only about ours, never as our own lapRejected
      for (const g of [{ why: 'too-fast', id: 20 }, { why: 'too-fast', id: 22 }, { why: 'too-fast', id: 'x' }, { why: '<b>', id: 21 }, { why: 'no-data', id: null }]) await raw(Object.assign({ t: 'glno' }, g));
      assert.deepStrictEqual(ev.splice(0).map(e => e.slice(0, 3)), [['botLapRejected', 20, 'too-fast'], ['botLapRejected', 21, '']]);
      // snapshot rows of our own bots are not remote cars
      await raw({ t: 'snap', p: [[20, 1000, 1, 0, 1, 0, 0, 0, 0, 0], [22, 1000, 5, 0, 5, 0, 0, 0, 0, 0]] });
      N.update();
      assert.deepStrictEqual(N.players.map(p => [p.id, p.active]), [[22, true], [23, false], [24, false]]);
      // what goes out: states of our bots only, rounded, one row per bot, progress along
      inbox.length = 0;
      assert.strictEqual(N.sendBotStates([{ id: 22, state: { x: 1, z: 1, heading: 0 } }, { id: 20, state: { x: NaN, z: 0, heading: 0 } }, { id: 21 }], true), false);
      assert.deepStrictEqual([N.setBotProgress(21, 1.234567), N.setBotProgress(22, 1), N.setBotProgress(20, 'x')], [true, false, true]);
      assert.strictEqual(N.sendBotStates([{ id: 20, state: { x: 1.23456, y: 2, z: 3, heading: 7, pitch: 0.12345, roll: 0, speed: 50.555, steer: -0.333 } },
        { id: 21, state: { x: 1, z: 2, heading: -1 } }, { id: 20, state: { x: 5, z: 5, heading: 0 } }, { id: 21, state: { x: 9, z: 9, heading: 0 }, g: 7 }], true), true);
      await until(() => inbox.some(m => m.t === 'bs'), 1000, 'bs');
      const bs = inbox.find(m => m.t === 'bs');
      assert.deepStrictEqual([bs.k, typeof bs.c, bs.b], [3, 'number', [[20, 1.23, 2, 3, 0.7168, 0.123, 0, 50.56, -0.33], [21, 1, 0, 2, -1, 0, 0, 0, 0, 1.2346]]]);
      // laps, lap times and impacts by bot id: only ours
      inbox.length = 0;
      assert.deepStrictEqual([N.sendGpLap(1, 80, undefined, 22), N.sendGpLap(1, 80, undefined, 'x'), N.sendGpLap(1, 80, 5e12, 20), N.sendGpLap(1, 80)], [false, false, true, true]);
      assert.deepStrictEqual([N.sendLap(80, 80, 22), N.sendLap(80, 79, 20)], [false, true]);
      assert.deepStrictEqual([N.sendHit(22, 1, 0, 20), N.sendHit(22, 1, 0, 20), N.sendHit(22, 1, 0, 21), N.sendHit(20, 1, 0), N.sendHit(7, 1, 0), N.sendHit(22, 1, 0, 22),
        N.sendHit(22, 2, 0)], [true, false, true, false, false, false, true]);
      await until(() => inbox.length >= 6, 1000, 'sent');
      assert.deepStrictEqual(inbox.filter(m => m.t === 'gl').map(m => [m.id, m.at]), [[20, 5e12], [undefined, undefined]]);
      assert.deepStrictEqual(inbox.filter(m => m.t === 'lap').map(m => [m.id, m.best]), [[20, 79]]);
      assert.deepStrictEqual(inbox.filter(m => m.t === 'hit').map(m => [m.to, m.from]), [[22, 20], [22, 21], [22, undefined]]);
      // keepalive: with the loop stopped the last rows are repeated parked (speed / steer 0, no progress)
      inbox.length = 0;
      await sleep(450);
      const parked = inbox.filter(m => m.t === 'bs');
      assert(parked.length >= 1, 'repeated');
      assert.deepStrictEqual(parked[parked.length - 1].b, [[20, 1.23, 2, 3, 0.7168, 0.123, 0, 0, 0], [21, 1, 0, 2, -1, 0, 0, 0, 0]]);
      // a session is on: no field changes; a new load cycle: no more repeats of the old poses
      await raw({ t: 'gp', now: 1, s: { sid: 4, phase: 'quali', q: 1, r: 1, len: 5000, lightsAt: 0, goAt: 0, winnerAt: 0, endsAt: 0, grid: [], order: [7, 20],
        players: [{ id: 7, name: 'me' }, { id: 20, name: 'mine', bot: true }, { id: 21, name: 'x', bot: 'yes' }] } });
      assert.deepStrictEqual([N.setBots(0), N.session.players.map(p => p.bot)], [false, [undefined, true, undefined]]);
      await raw({ t: 'room', st: 'loading', rs: 4, set: { track: 'spa' } });
      inbox.length = 0;
      await sleep(450);
      assert.strictEqual(inbox.filter(m => m.t === 'bs').length, 0, 'the old cycle\'s poses are not repeated');
      // the lobby: setBots; whatever is asked fits in one frame (16 at most)
      await raw({ t: 'room', st: 'lobby', rs: 4, set: { track: 'spa' } });
      inbox.length = 0;
      assert.strictEqual(N.setBots(Array.from({ length: 20 }, (_, i) => ({ name: '\u{1F600}'.repeat(20), car: 'x'.repeat(40), colour: '#AABBCC', skill: i / 20 })), 'mixed'), true);
      await until(() => inbox.some(m => m.t === 'bots'), 1000, 'bots');
      const bm = inbox.find(m => m.t === 'bots');
      assert.deepStrictEqual([bm.n, bm.list.length, bm.skill, bm.list[3].skill, bm.list[3].car], [16, 16, 'mixed', 0.15, 'x'.repeat(40)]);
      assert(Buffer.byteLength(JSON.stringify(bm)) <= 1900, 'bytes ' + Buffer.byteLength(JSON.stringify(bm)));
      inbox.length = 0;
      assert.strictEqual(N.setBots([{ name: 'A', car: '2026-ferrari', colour: '#AABBCC', skill: 2 }, { name: 5, car: 'BAD', colour: 'x', skill: 'x' }], 'nope'), true);
      await until(() => inbox.some(m => m.t === 'bots'), 1000, 'bots 2');
      assert.deepStrictEqual(inbox.find(m => m.t === 'bots'), { t: 'bots', n: 2, list: [{ name: 'A', car: '2026-ferrari', colour: '#aabbcc', skill: 1 }, {}] });
      // a roster without our bots: they are gone ('bots' with []), and so is all that was kept for them
      await raw({ t: 'players', host: 7, players: players.filter(p => p.id === 7 || p.id === 22) });
      assert.deepStrictEqual([N.bots, ev.splice(0).map(e => [e[0], e[1]])], [[], [['bots', []]]]);
      assert.deepStrictEqual([N.sendBotStates([{ id: 20, state: { x: 1, z: 1, heading: 0 } }], true), N.sendGpLap(4, 80, undefined, 20), N.setBotProgress(20, 1)], [false, false, false]);
      sock.close(1001);
      await until(() => !N.connected, 2000, 'disconnected');
      assert.deepStrictEqual([N.bots, N.botSettings, N.roster], [[], { n: 0, skill: 'pro' }, []]);
      assert.strictEqual(uncaught.length, 0, 'nothing thrown out of a message handler');
    } finally {
      wss.clients.forEach(ws => ws.terminate());
      await new Promise(r => wss.close(r));
    }
  });

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
    // one address (127.0.0.2 is not "this machine" for the server: only 127.0.0.1 is exempt) holds at most 28
    const one = tcp(40, '127.0.0.2');
    await sleep(400);
    assert.strictEqual(open(one), 28, 'silent TCP connections kept per address');
    // ...and at most 20 of them can be WebSockets: a whole room behind one address (a LAN party / school / office
    // joining over the internet, MP-3) gets in, plus a few still connecting; the rest are told "busy"
    const wsFrom3 = [];
    const ws3 = hello => new Promise(resolve => {
      const ws = new WebSocket('ws://127.0.0.1:' + srv.port, { localAddress: '127.0.0.3' });
      const c = { ws, msgs: [], closed: null };
      ws.on('message', d => { c.msgs.push(JSON.parse(d.toString())); resolve(c); });
      ws.on('open', () => { if (hello) ws.send(JSON.stringify({ t: 'hello', v: 2, name: hello })); else setTimeout(() => resolve(c), 30); });
      ws.on('close', code => { c.closed = code; resolve(c); });
      ws.on('error', () => resolve(c));
    });
    for (let i = 0; i < 15; i++) wsFrom3.push(await ws3('n' + i));          // 15 players + a = a full room
    for (let i = 0; i < 7; i++) wsFrom3.push(await ws3(i < 5 ? null : 'late')); // 5 still connecting, then 2 more
    await sleep(150);
    const said = (c, t, code) => c.msgs.some(m => m.t === t && (!code || m.code === code));
    assert.deepStrictEqual([wsFrom3.filter(c => said(c, 'welcome')).length, wsFrom3.slice(15, 20).filter(c => c.msgs.length === 0 && !c.closed).length,
      wsFrom3.filter(c => said(c, 'error', 'busy')).length], [15, 5, 2], 'players / sockets still connecting / busy from one address');
    assert.strictEqual(srv.info().players.length, 16);
    wsFrom3.forEach(c => c.ws.terminate());
    await until(() => srv.info().players.length === 1, 2000, 'the address\'s players gone');
    await sleep(100);
    // the whole server keeps at most 96 connections, whoever they come from
    const t0 = Date.now();
    const many = tcp(150);
    await sleep(500);
    assert(open(many) <= 96 - 28 - 1 && open(many) >= 60, 'silent TCP connections kept in all: ' + open(many));
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
    b.send({ t: 'set', track: 'ok' });
    await b.wait(() => b.room().set.track === 'ok');
    b.ws.close();
  });

  T('nothing a client sends is amplified: floods of lap / profile / gp / gl / ping / room messages / joins reach the room as a trickle', async t => {
    const R = await lobbyRoom(t, 3, { startMinMs: START_MIN_MS });
    const [host, watcher, spammer] = R.cs;
    await R.start(1, 1);
    await sleep(150);
    const count = () => ({ players: watcher.all('players').length, gp: watcher.all('gp').length, room: watcher.all('room').length, all: watcher.msgs.length });
    const flood = async (from, make, label, limit) => {
      const n = count();
      for (let i = 0; i < 3000; i++) from.send(make(i));
      await from.wait(() => from.closed, 5000, label + ': kicked');
      assert.strictEqual(from.closed.code, 1008, label);
      await sleep(250);
      const d = count();
      assert(d.all - n.all < limit, label + ': the watcher got ' + (d.all - n.all) + ' messages (' + (d.players - n.players) + ' rosters, ' +
        (d.gp - n.gp) + ' gp, ' + (d.room - n.room) + ' room)');
      return d.all - n.all;
    };
    const got = [];
    // in a session a rename touches the roster AND the Grand Prix snapshot
    got.push(await flood(spammer, i => ({ t: 'profile', name: 'n' + i }), 'profile', 25));
    let s2 = await client(R.srv.port, { name: 's2' });
    got.push(await flood(s2, i => ({ t: 'lap', k: R.srv.info().room.rs, last: 60 + i, best: 60 }), 'lap', 25));
    s2 = await client(R.srv.port, { name: 's3' });
    await s2.wait(() => s2.gp());
    got.push(await flood(s2, () => ({ t: 'gl', k: s2.rs(), sid: 1, time: 0.5 }), 'gl', 12));
    assert(s2.all('glno').length <= 200, 'answers to the flooder itself are bounded by the rate limit (120 burst + 60 / s): ' + s2.all('glno').length);
    s2 = await client(R.srv.port, { name: 's4' });
    got.push(await flood(s2, i => ({ t: 'ping', c: i }), 'ping', 12));
    assert(s2.all('pong').length <= 200, 'pongs: ' + s2.all('pong').length);
    s2 = await client(R.srv.port, { name: 's5' });
    got.push(await flood(s2, i => ({ t: 'gp', a: i % 2 ? 'end' : 'start', q: 1, r: 1, len: LEN }), 'gp from a guest', 12));
    assert.deepStrictEqual([srv_phase(R), srv_gp(R).sid, R.srv.info().room.st], ['quali', 1, 'session'], 'and it changed nothing');
    // a guest's room messages: set / ready / start / loaded / go / back
    s2 = await client(R.srv.port, { name: 's6' });
    const k6 = s2.rs();
    got.push(await flood(s2, i => [{ t: 'set', track: 'x' + i, mode: 'free' }, { t: 'ready', on: i % 2 === 0 }, { t: 'start', len: LEN, force: true },
      { t: 'loaded', rs: k6, ok: i % 2 === 0 }, { t: 'go' }, { t: 'back' }][i % 6], 'room messages from a guest', 12));
    assert.deepStrictEqual([srv_phase(R), R.srv.info().room.st, R.srv.info().room.set.track], ['quali', 'session', 'monza'], 'and they changed nothing');
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
    assert(d.players - n.players < 40 && d.gp - n.gp < 40 && d.room - n.room < 10, 'churn: ' + (d.players - n.players) + ' rosters, ' + (d.gp - n.gp) +
      ' gp, ' + (d.room - n.room) + ' room for 40 joins + 40 leaves');
    console.log('     watcher messages per 3000-message flood (profile, lap, gl, ping, guest gp, guest room, host gp): ' + got.join(', ') +
      '; churn: ' + (d.players - n.players) + ' rosters + ' + (d.gp - n.gp) + ' gp');
    // the room still works, and its state is the latest
    await sleep(START_MIN_MS + 50);
    await watcher.wait(() => watcher.room().st === 'lobby');
    watcher.send({ t: 'set', q: 2, r: 3 });
    await watcher.wait(() => watcher.room().set.q === 2);
    watcher.send({ t: 'start', len: LEN });
    await watcher.wait(() => watcher.room().st === 'loading');
    watcher.loaded();
    const g = await settle(R.srv, [watcher], s => s.phase === 'quali' && s.q === 2);
    assert.deepStrictEqual(g.players.map(p => p.id), [watcher.id]);
    watcher.ws.close();
  });

  T('nothing the host sends in the lobby is amplified: floods of set / bots / start / back / go reach the room as a trickle; transitions at most one a second', async t => {
    const R = await lobbyRoom(t, 2, { startMinMs: START_MIN_MS });
    const [host, watcher] = R.cs;
    await sleep(1100);
    const n = { room: watcher.all('room').length, all: watcher.msgs.length };
    for (let i = 0; i < 3000; i++) {
      host.send([{ t: 'set', track: 't' + i, year: 2010 + (i % 17), mode: i % 2 ? 'gp' : 'free', q: 1 + (i % 5) }, { t: 'bots', n: i % 15 },
        { t: 'start', len: LEN, force: true }, { t: 'back' }, { t: 'go' }, { t: 'ready', on: true }][i % 6]);
    }
    await host.wait(() => host.closed, 5000, 'kicked');
    assert.strictEqual(host.closed.code, 1008);
    await sleep(400);
    const rooms = watcher.all('room').length - n.room, all = watcher.msgs.length - n.all;
    const starts = new Set(watcher.all('room').slice(n.room).filter(m => m.st === 'loading').map(m => m.rs)).size;
    assert(starts <= 1, 'one start (START_MIN_MS): ' + starts);
    assert(rooms <= 12 && all < 40, 'the watcher got ' + all + ' messages (' + rooms + ' room) for 3000 lobby messages from the host');
    console.log('     watcher messages per 3000-message host lobby flood: ' + all + ' (' + rooms + ' room, ' + starts + ' start)');
    // every room message well-formed
    for (const m of watcher.all('room')) {
      assert(['lobby', 'loading', 'session'].includes(m.st) && Number.isInteger(m.rs) && Array.isArray(m.ready) && (m.load === null || Array.isArray(m.load.wait)), JSON.stringify(m));
    }
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
    liar.send({ t: 'hello', v: 2, name: 'liar' });
    await sleep(200);
    assert.strictEqual(liar.last('welcome'), null, 'a refused socket stays refused');
    assert.strictEqual(srv.info().players.length, 1);
    await until(() => liar.ended, 2000, 'the server destroys the socket');
    // kicked for flooding: removed from the room immediately, its later messages are dead letters
    const rude = await rawClient(srv.port);
    rude.send({ t: 'hello', v: 2, name: 'rude' });
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
    rude.send({ t: 'profile', name: 'still here' }); rude.send({ t: 'hello', v: 2, name: 'again' }); rude.send({ t: 'ping', c: 1 });
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
    await R.start(1, 1, { len: MONZA });
    const gl = async (c, time) => {
      const n = c.all('glno').length;
      c.send({ t: 'gl', k: c.rs(), sid: c.gp().sid, time });
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

  T('impact reports: as hard as the cars\' POSITIONS were closing, never the speed a client claims; none after a teleport; a budget per pair; none on stale positions (hit-spam, MP-1)', async t => {
    const R = await room(t, 3, { real: true });                 // (a free-practice session: impacts are taken there only)
    const [v, e, o] = R.cs;
    // the victim is parked at the origin and reports 20 times a second, as the game does
    const vt = setInterval(() => v.drive(0, 0), 50);
    const W = -Math.PI / 2;                                      // heading -x: straight at the victim from +x
    // the attacker's fake car at (x, 0), "doing 130 m/s at the victim", one state every 50 ms for ms
    const park = async (x, ms) => { for (let s = 0; s < ms; s += 50) { e.drive(x, 0, undefined, 130, W); await sleep(50); } };
    // n reports of `i`, 45 ms apart -> the velocity changes that reached the victim meanwhile
    const fire = async (n, i) => {
      const n0 = v.all('hit').length;
      for (let k = 0; k < n; k++) { e.send({ t: 'hit', k: e.rs(), to: v.id, i }); await sleep(45); }
      await sleep(100);
      return v.all('hit').slice(n0).map(m => m.i);
    };
    e.drive(-2000, 0);
    await sleep(160);
    // a reset: one state 2.5 m from him, from 2 km away, is not driving: nothing it reports is relayed
    e.drive(2.5, 0, undefined, 130, W);
    assert.deepStrictEqual(await fire(5, [-80, 0]), [], 'nothing after a teleport');
    // the verifier's attack: it stands still there but its speed field says 130 m/s at him. Its positions do not
    // close on him at all: the slack is all that gets through (it was the whole 80 m/s)
    await park(2.5, 300);
    let got = await fire(1, [-80, 0]);
    assert(got.length === 1 && Math.hypot(got[0][0], got[0][1]) <= 3.01, 'a parked car claiming 130 m/s: only the slack: ' + JSON.stringify(got));
    // ...and its claimed speed does not stretch the 'near' check either (it did, to 12 + 0.2 x 130 = 38 m)
    await park(30, 650);
    assert.deepStrictEqual(await fire(3, [-80, 0]), [], '30 m away, parked');
    // a real ram: its positions close on him at 60 m/s (and everybody sees its car do it): HIT_MAX goes through,
    // and the pair's budget caps the series that follows (a report every 45 ms for a second)
    await driveTo(e, 30, 3, 0, 9);
    const t0 = Date.now();
    got = await fire(22, [-80, 0]);
    const total = got.reduce((s, i) => s + Math.hypot(i[0], i[1]), 0);
    assert.deepStrictEqual(got[0], [-50, 0], 'the first one: HIT_MAX');
    assert(got.every(i => i[1] === 0 && i[0] < 0 && i[0] >= -50), 'along the impulse, no more than HIT_MAX: ' + JSON.stringify(got));
    assert(total <= 100 + 25 * (Date.now() - t0) / 1000 + 0.1, 'the budget of the pair: ' + total.toFixed(1) + ' m/s in ' + (Date.now() - t0) + ' ms');
    assert(total >= 100, 'the budget is there to be used: ' + total.toFixed(1));
    assert.strictEqual(o.all('hit').length, 0, 'nobody else gets any of it');
    // stale: the victim stops reporting; half a second later nothing is relayed
    clearInterval(vt);
    const et = setInterval(() => e.drive(3, 0), 50);
    await sleep(600);
    assert.deepStrictEqual(await fire(3, [-5, 0]), [], 'the target\'s position is stale');
    clearInterval(et);
    [v, e, o].forEach(c => c.ws.close());
  });

  T('the settings are frozen from the start: set / bots while loading or in the session are dropped; the session races what was set at the start (frozen-settings)', async t => {
    const R = await lobbyRoom(t, 2, { hostToken: 'tok' });
    const [h, g] = R.cs;
    h.send({ t: 'set', mode: 'gp', q: 2, r: 3, wear: 2, year: 2024 });
    h.send({ t: 'bots', n: 2 });
    await R.sync(x => x.set.q === 2 && x.set.bots === 2);
    h.send({ t: 'start', len: LEN, force: true });
    await R.sync(x => x.st === 'loading');
    // while loading: a new track, other laps, another season, the field: all dropped
    h.send({ t: 'set', track: 'monaco', q: 5, r: 9, wear: 5, year: 2010, mode: 'free' });
    h.send({ t: 'bots', n: 0 });
    await sleep(150);
    assert.deepStrictEqual([R.srv.info().room.set.track, R.srv.info().room.set.q, R.srv.info().room.set.year, R.srv.info().bots.n], ['monza', 2, 2024, 2]);
    h.loaded(); g.loaded();
    const s = await R.settle(x => x.phase === 'quali');
    assert.deepStrictEqual([s.q, s.r, s.wear, s.year, s.players.filter(p => p.bot).length], [2, 3, 2, 2024, 2], 'what was set at the start');
    h.send({ t: 'set', track: 'monaco' });
    await sleep(1200);
    assert.deepStrictEqual([R.srv.info().gp.phase, R.srv.info().room.set.track, R.srv.info().room.st], ['quali', 'monza', 'session'], 'and it stays on');
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
    // the default: a guest in a browser tab hidden for 5 min has its timers (pings, the parked pose) run once a
    // minute by Chrome; three of those wake-ups must fit (MP-6)
    assert(IDLE_MS >= 3 * 60000, 'IDLE_MS ' + IDLE_MS);
  });

  const tcp = runLane(lanes.tcp);                               // mostly waiting: fine next to anything
  await runLane(lanes.floods);
  await Promise.all([runLane(lanes.relay), runLane(lanes.gp1), runLane(lanes.gp2), runLane(lanes.gp3), runLane(lanes.client), runLane(lanes.year), runLane(lanes.year2), runLane(lanes.lobby), runLane(lanes.lobby2),
    runLane(lanes.bots), runLane(lanes.bots2), runLane(lanes.botsClient),
    runLane(lanes.review), runLane(lanes.review2), tcp]);
  await slow;

  const secs = ((Date.now() - T_START) / 1000).toFixed(1);
  if (uncaught.length) failed++;
  console.log(failed ? '\n' + failed + ' test(s) FAILED  (' + secs + ' s)' : '\nall server tests passed  (' + secs + ' s)');
  process.exit(failed ? 1 : 0);
})();
