// node devtests/gp-test/net-glue.js — js/gp.js against the REAL js/net.js (no TCP: a fake WebSocket whose
// other end is a real net/session.js playing the server, and a fake Date.now for the server clock).
'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { createSession } = require(path.join(ROOT, 'net/session.js'));

let T = 1700000000000;
const T0 = T;
Date.now = () => T;
// js/net.js keeps its clock on the monotonic timer: fake that one too
Object.defineProperty(globalThis, 'performance', { value: { now: () => T - T0 + 5000 }, configurable: true });

let sock = null;
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sock = this; }
  send(text) { this.sent.push(JSON.parse(text)); server(JSON.parse(text)); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWS;

const net = require(path.join(ROOT, 'js/net.js'));
const gp = require(path.join(ROOT, 'js/gp.js'));

// ---- the "server" (protocol 2, as net/server.js speaks it): player 1 = us (host), player 2 = somebody else; the room
// (Monza, a Grand Prix of Q 1 / R 2 set in the lobby) starts with `start`, its session after our `loaded` (the barrier)
const srv = createSession({ random: () => 0 });
const roster = [{ id: 1, name: 'Me', colour: '#ff7a14', slot: 0 }, { id: 2, name: 'Other', colour: '#00ccff', slot: 1 }];
const room = { st: 'lobby', rs: 0, set: { track: 'monza', year: null, mode: 'gp', q: 1, r: 2, wear: 1, bots: 0, skill: 'pro' }, ready: [2], rr: 0, load: null, len: 0 };
let startLen = 0;
const deliver = m => sock.onmessage({ data: JSON.stringify(m) });
const sendGp = () => deliver({ t: 'gp', now: T, s: srv.snapshot() });
const sendRoom = () => deliver(Object.assign({ t: 'room' }, JSON.parse(JSON.stringify(room))));
function server(m) {
  if (m.t === 'hello') {
    srv.addPlayer(1, m.name, T); srv.addPlayer(2, 'Other', T);
    deliver({ t: 'welcome', v: 2, id: 1, host: 1, ded: false, now: T, room: JSON.parse(JSON.stringify(room)), bots: { n: 0, skill: 'pro' }, players: roster });
    deliver({ t: 'players', host: 1, bots: { n: 0, skill: 'pro' }, players: roster });
    sendGp();
  } else if (m.t === 'ping') deliver({ t: 'pong', c: m.c, s: T });
  else if (m.t === 'start') {                       // the host's 開始: everybody loads (player 2 already has)
    if (room.st !== 'lobby') return;
    room.st = 'loading'; room.rs++; startLen = m.len;
    room.load = { at: T, until: T + 20000, wait: [1], done: [2], fail: [] };
    sendRoom();
  } else if (m.t === 'loaded') {                    // ours: the barrier ends, the session (room first, then gp)
    if (room.st !== 'loading' || m.rs !== room.rs || m.ok !== true) return;
    room.st = 'session'; room.load = null; room.len = startLen;
    sendRoom();
    if (srv.start({ q: room.set.q, r: room.set.r, len: room.len }, T)) sendGp();
  } else if (m.t === 'gp') {
    if (room.st !== 'session') return;
    const ok = m.a === 'skip' ? srv.skip(T) : m.a === 'end' ? srv.end() : m.a === 'again' ? srv.again(T) : false;
    if (ok) sendGp();
  } else if (m.t === 'gl') {
    if (m.k !== room.rs || m.sid !== srv.sid) return;
    const why = srv.lap(1, m.time, T);
    if (why) deliver({ t: 'glno', why }); else sendGp();
  } else if (m.t === 's') { if (typeof m.g === 'number') srv.progress(1, m.g); }
}
const wait = sec => { T += sec * 1000; if (srv.tick(T)) sendGp(); };
const last = t => sock.sent.filter(m => m.t === t).pop();

const log = [];
gp.on('phase', (p, prev) => log.push('phase ' + prev + '>' + p));
gp.on('go', () => log.push('go'));
gp.on('change', () => log.push('change'));
gp.on('lapRejected', w => log.push('rejected ' + w));
const take = () => log.splice(0, log.length);
const car = { x: 1, y: 0, z: 2, heading: 0, pitch: 0, roll: 0, speed: 50, steer: 0 };

(async () => {
  gp.init({ net, getProfile: () => ({ name: 'Me', colour: '#ff7a14' }) });
  assert.strictEqual(gp.start({ q: 1, r: 1 }, 5000), true, 'offline start');
  assert.deepStrictEqual(take(), ['phase free>quali', 'change']);

  net.setProfile({ name: 'Me', colour: '#ff7a14' });
  const joined = net.join('127.0.0.1:1');
  sock.onopen();
  assert.deepStrictEqual(await joined, { ok: true });
  assert.deepStrictEqual([gp.online, gp.phase, gp.selfId, gp.canControl, net.isHost], [true, 'free', 1, true, true]);
  assert.deepStrictEqual(take(), ['phase quali>free', 'change', 'change', 'change'], 'abandoned; roster; first snapshot');
  assert.strictEqual(gp.now(), net.serverNow());

  // host starts (protocol 2): F1.gp cannot start a room (the lobby's 開始 does: start, then the loading barrier)
  assert.strictEqual(gp.start({ q: 1, r: 2 }, 5000), false, 'online: a room starts through its lobby');
  assert.strictEqual(sock.sent.filter(m => m.t === 'gp').length, 0, 'no gp start message');
  assert.strictEqual(net.startRoom({ len: 5000 }), true);
  assert.deepStrictEqual(last('start'), { t: 'start', len: 5000 });
  assert.deepStrictEqual([net.room.st, net.room.rs, gp.phase], ['loading', 1, 'free'], 'loading: no session yet');
  take();
  net.sendState(car, true);
  assert.strictEqual(last('s'), undefined, 'no car state before the session (and before our loaded)');
  assert.strictEqual(net.sendLoaded(1, true, { len: 5000 }), true);
  assert.deepStrictEqual(last('loaded'), { t: 'loaded', rs: 1, ok: true, len: 5000 });
  assert.deepStrictEqual(take(), ['phase free>quali', 'change']);
  assert.strictEqual(net.room.st, 'session');
  assert.deepStrictEqual([gp.phase, gp.sid, gp.taking, gp.lapTotal], ['quali', 1, true, 1]);
  assert.strictEqual(gp.isGhost(2), true);

  gp.lapDone(12.3456789);
  assert.deepStrictEqual(last('gl'), { t: 'gl', k: 1, sid: 1, time: 12.346, at: T }, 'with the server clock of the crossing (k = the load cycle)');
  assert.deepStrictEqual(take(), ['rejected too-fast']);
  wait(100);
  gp.lapDone(80);
  assert.deepStrictEqual(take(), ['change']);
  assert.strictEqual(gp.view().done, true);
  srv.lap(2, 79, T); sendGp();
  assert.deepStrictEqual(take(), ['phase quali>grid', 'change']);
  assert.deepStrictEqual([gp.gridSlot, gp.inputLocked, gp.lights], [1, true, 0]);

  const s = gp.snapshot;
  T = s.lightsAt + 3200; gp.update(0.016);
  assert.deepStrictEqual([gp.lights, gp.inputLocked, gp.isGhost(2)], [4, true, false]);
  gp.setProgress(-0.01); net.sendState(car, true);
  assert.strictEqual('g' in last('s'), false, 'no progress in the state message on the grid');
  T = s.goAt + 20; gp.update(0.016);
  assert.deepStrictEqual(take(), ['go']);
  assert.deepStrictEqual([gp.inputLocked, gp.lights, gp.goFlash], [false, 0, true]);
  wait(0.08);
  assert.deepStrictEqual(take(), ['phase grid>race', 'change']);
  gp.update(0.016);
  assert.deepStrictEqual(take(), []);

  gp.setProgress(0.4321); net.sendState(car, true);
  assert.strictEqual(last('s').g, 0.4321, 'progress rides on the state message while racing');
  srv.progress(2, 0.2); sendGp();
  assert.deepStrictEqual(gp.view().rows.map(r => [r.id, r.name, r.colour, r.isSelf]), [[1, 'Me', '#ff7a14', true], [2, 'Other', '#00ccff', false]]);
  take();

  wait(100); gp.lapDone(100);
  wait(100); gp.lapDone(100);                                   // we win; player 2 is still out
  assert.deepStrictEqual(take(), ['change', 'change']);
  assert.deepStrictEqual([gp.phase, gp.view().done, gp.view().endsInMs], ['race', true, 90000]);
  net.sendState(car, true);
  assert.strictEqual('g' in last('s'), false, 'finished: the progress was cleared by the snapshot, before any setProgress()');
  wait(90);
  assert.deepStrictEqual(take(), ['phase race>results', 'change']);
  assert.deepStrictEqual(gp.view().rows.map(r => [r.id, r.laps, r.done, r.time]), [[1, 2, true, 200], [2, 0, false, null]]);

  assert.strictEqual(gp.action('again'), true);
  assert.deepStrictEqual(take(), ['phase results>quali', 'change']);
  assert.strictEqual(gp.sid, 2);

  // the room goes away
  sock.onclose({ code: 1001 });
  assert.deepStrictEqual(take(), ['phase quali>free', 'change']);
  assert.deepStrictEqual([gp.online, gp.phase, gp.snapshot, gp.selfId, gp.canControl, net.session], [false, 'free', null, 1, true, null]);
  assert.strictEqual(gp.start({ q: 1, r: 1 }, 5000), true, 'offline again');
  assert.strictEqual(gp.view().rows[0].name, 'Me');
  console.log('net-glue: all checks passed');
  process.exit(0);
})().catch(e => { console.log('net-glue FAILED\n' + (e && e.stack)); process.exit(1); });
