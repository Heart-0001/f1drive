// node test/gp.test.js — Grand Prix controller (js/gp.js): offline with its game clock, online with a stub net.
'use strict';
const assert = require('assert');
const { createSession, minLapTime } = require('../net/session.js');
const defaultGp = require('../js/gp.js');
const createGp = globalThis.F1.createGp;

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}

const LEN = 5000;                       // m -> minimum lap 54.5 s
const MIN = minLapTime(LEN);
const DT = 0.0625;                      // s per update(): 62.5 ms, exact in binary, so the game clock has no rounding
const VIEW_KEYS = ['phase', 'online', 'canControl', 'taking', 'spectating', 'q', 'r', 'year', 'wear', 'lap', 'lapTotal', 'pos', 'count',
  'done', 'endsInMs', 'rows', 'spectators'];
const ROW_KEYS = ['pos', 'id', 'name', 'colour', 'isSelf', 'laps', 'best', 'time', 'gap', 'down', 'done', 'dnf', 'left'];

function run(gp, sec) { for (let i = 0, n = Math.round(sec / DT); i < n; i++) gp.update(DT); }

// every event the controller fires, in order; take() returns them and empties the list
function record(gp) {
  const log = [];
  gp.on('phase', (phase, prev) => log.push('phase ' + prev + '>' + phase));
  gp.on('go', () => log.push('go'));
  gp.on('change', () => log.push('change'));
  gp.on('lapRejected', why => log.push('rejected ' + why));
  log.take = () => log.splice(0, log.length);
  return log;
}

// view(): exactly the GpView of the contract, a fresh plain object with sane types
function view(gp) {
  const v = gp.view();
  assert.notStrictEqual(v, gp.view(), 'a fresh object every time');
  assert.deepStrictEqual(Object.keys(v).sort(), VIEW_KEYS.slice().sort());
  assert.strictEqual(Object.getPrototypeOf(v), Object.prototype);
  assert.strictEqual(v.phase, gp.phase);
  assert.strictEqual(v.online, gp.online);
  assert.strictEqual(v.canControl, gp.canControl);
  assert.strictEqual(v.taking, gp.taking);
  assert.strictEqual(v.lap, gp.lap);
  assert.strictEqual(v.lapTotal, gp.lapTotal);
  for (const k of ['online', 'canControl', 'taking', 'spectating', 'done']) assert.strictEqual(typeof v[k], 'boolean', k);
  assert(v.year === null || (Number.isInteger(v.year) && v.year >= 2010 && v.year <= 2100), 'year ' + v.year);
  assert(Number.isInteger(v.wear) && v.wear >= 1 && v.wear <= 5, 'wear ' + v.wear);
  assert.strictEqual(v.count, v.rows.length);
  v.rows.forEach((r, i) => {
    assert.deepStrictEqual(Object.keys(r).sort(), ROW_KEYS.slice().sort());
    assert.strictEqual(r.pos, i + 1);
    assert(/^#[0-9a-f]{6}$/.test(r.colour), 'colour ' + r.colour);
    assert.strictEqual(r.isSelf, r.id === gp.selfId);
  });
  const self = v.rows.filter(r => r.isSelf);
  assert.strictEqual(v.pos, self.length ? self[0].pos : 0);
  v.spectators.forEach(s => assert.deepStrictEqual(Object.keys(s).sort(), ['colour', 'id', 'name']));
  return v;
}

function offline(profile, random) {
  const gp = createGp(), log = record(gp);
  gp.init({ net: null, getProfile: () => profile, random: random || (() => 0.5) });
  return { gp, log };
}

function quiet(fn) {                    // run fn with console.error silenced -> the number of errors it logged
  const orig = console.error;
  let n = 0;
  console.error = () => { n++; };
  try { fn(); } finally { console.error = orig; }
  return n;
}

/* ---------- a stub room: a real session as the "server", stub F1.net objects as the clients ---------- */

function makeRoom(random) {
  const srv = createSession({ random: random || (() => 0) });      // () => 0: the lights hold for 500 ms
  const room = { srv, t: 5000000, hostId: 1, roster: [], clients: [], year: null };   // year: the room's, as on the server

  room.sendRoster = () => room.clients.forEach(c => {
    c.net.roster = room.roster.map(p => ({ id: p.id, name: p.name, colour: p.colour, isHost: p.id === room.hostId, isSelf: p.id === c.id }));
    c.net.isHost = c.id === room.hostId;
    c.net.emit('players', c.net.roster);
  });
  room.push = () => {
    let s = null;
    room.clients.forEach(c => { s = c.net.session = JSON.parse(JSON.stringify(srv.snapshot())); c.net.emit('gp', s); });
    return s;
  };
  // somebody without a controller under test joins / leaves
  room.add = (id, name, colour) => { srv.addPlayer(id, name, room.t); room.roster.push({ id, name, colour }); room.sendRoster(); room.push(); };
  room.remove = id => { srv.removePlayer(id, room.t); room.roster = room.roster.filter(p => p.id !== id); room.sendRoster(); room.push(); };
  room.wait = sec => { room.t += sec * 1000; if (srv.tick(room.t)) room.push(); };
  room.lap = (id, time) => { const why = srv.lap(id, time, room.t); if (!why) room.push(); return why; };

  room.client = (id, name, colour) => {
    const handlers = {};
    const net = {
      connected: false, isHost: false, id: 0, roster: [], session: null,
      skew: 0,                                   // our estimate of the server clock is this far off (ms)
      calls: { gp: [], lap: [], progress: [] },
      on(n, fn) { (handlers[n] = handlers[n] || []).push(fn); },
      emit(n, a, b) { (handlers[n] || []).slice().forEach(fn => fn(a, b)); },
      serverNow() { return room.t + net.skew; },
      gp(a, cfg) {
        net.calls.gp.push(cfg ? [a, cfg] : [a]);
        if (!net.connected || !net.isHost) return false;
        // as net/server.js: the session gets the ROOM's year, never one the client names
        const ok = a === 'start' ? srv.start(Object.assign({}, cfg, { year: room.year }), room.t) : a === 'skip' ? srv.skip(room.t)
          : a === 'end' ? srv.end() : a === 'again' ? srv.again(room.t) : false;
        if (ok) room.push();
        return true;
      },
      sendGpLap(sid, time) {
        net.calls.lap.push([sid, time]);
        if (sid !== srv.sid) return;
        const why = srv.lap(net.id, time, room.t);
        if (why) net.emit('lapRejected', why); else room.push();
      },
      setProgress(v) { net.calls.progress.push(v); if (v !== null) srv.progress(net.id, v); }
    };
    const gp = createGp(), log = record(gp);
    gp.init({ net, getProfile: () => ({ name: 'Solo', colour: '#00ff00' }) });
    const c = { id, net, gp, log };
    c.connect = () => {
      srv.addPlayer(id, name, room.t);
      room.roster.push({ id, name, colour });
      net.id = id; net.connected = true;
      room.clients.push(c);
      room.sendRoster();                         // as js/net.js: the roster is applied before 'connected' fires
      net.emit('connected', { id, isHost: net.isHost });
      room.push();
    };
    c.disconnect = () => {                       // as teardown() in js/net.js
      room.clients = room.clients.filter(x => x !== c);
      net.session = null; net.connected = false; net.isHost = false; net.id = 0; net.roster = [];
      net.emit('disconnected', 'bye');
      room.remove(id);
    };
    return c;
  };
  return room;
}

// Al (1, the host, no controller), Bea (2, the controller under test) and Di (4) have qualified 1-2-3
// for a 2-lap race; the room is on the grid (lights at +4 s, out at +9.5 s).
function gridRoom() {
  const room = makeRoom();
  room.add(1, 'Al', '#ff0000');
  const b = room.client(2, 'Bea', '#2222FF');
  b.connect();
  room.add(4, 'Di', '#ffff00');
  room.srv.start({ q: 1, r: 2, len: LEN }, room.t); room.push();
  room.wait(100);
  assert.strictEqual(room.lap(1, 80), ''); assert.strictEqual(room.lap(2, 81), ''); assert.strictEqual(room.lap(4, 82), '');
  assert.strictEqual(b.gp.phase, 'grid');
  assert.deepStrictEqual(b.gp.snapshot.grid, [1, 2, 4]);
  b.log.take();
  b.net.calls.gp.length = b.net.calls.lap.length = b.net.calls.progress.length = 0;
  return { room, b, gp: b.gp, net: b.net, log: b.log };
}

/* ---------- module ---------- */

test('module: require() gives F1.gp, usable before init(); F1.createGp() makes independent controllers', () => {
  assert.strictEqual(defaultGp, globalThis.F1.gp);
  assert.strictEqual(typeof createGp, 'function');
  assert.deepStrictEqual([defaultGp.phase, defaultGp.online, defaultGp.snapshot, defaultGp.selfId, defaultGp.canControl], ['free', false, null, 1, true]);
  defaultGp.update(DT);
  assert.strictEqual(defaultGp.isGhost(1), false);
  view(defaultGp);
  const a = createGp(), b = createGp();
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.start({ q: 1, r: 1 }, LEN), true, 'works without init(): offline, name "Player"');
  assert.strictEqual(a.phase, 'quali');
  assert.strictEqual(b.phase, 'free');
  assert.deepStrictEqual([view(a).rows[0].name, view(a).rows[0].colour], ['Player', '#888888']);
});

/* ---------- offline ---------- */

test('offline: a complete Grand Prix through the public API (quali -> grid -> lights -> race -> results -> again -> end)', () => {
  const { gp, log } = offline({ name: 'Tester', colour: '#12ABcd' });
  assert.deepStrictEqual(view(gp), { phase: 'free', online: false, canControl: true, taking: false, spectating: false,
    q: 3, r: 5, year: null, wear: 1, lap: 0, lapTotal: 0, pos: 0, count: 0, done: false, endsInMs: null, rows: [], spectators: [] });
  assert.strictEqual(gp.isGhost(2), false);
  gp.lapDone(80); gp.setProgress(0.5);                       // nothing to report to in free practice
  assert.deepStrictEqual(log.take(), []);

  // qualifying: 2 laps
  assert.strictEqual(gp.start({ q: 2, r: 2 }, LEN), true);
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change']);
  assert.deepStrictEqual([gp.phase, gp.sid, gp.selfId, gp.taking, gp.canControl, gp.online], ['quali', 1, 1, true, true, false]);
  assert.deepStrictEqual([gp.lap, gp.lapTotal, gp.gridSlot, gp.inputLocked, gp.lights, gp.goFlash, gp.sinceGo], [0, 2, -1, false, 0, false, 0]);
  assert.strictEqual(gp.isGhost(2), true, 'qualifying: everybody else is a ghost');
  const row0 = { pos: 1, id: 1, name: 'Tester', colour: '#12abcd', isSelf: true, laps: 0, best: null, time: null, gap: null, down: 0, done: false, dnf: false, left: false };
  assert.deepStrictEqual(view(gp), { phase: 'quali', online: false, canControl: true, taking: true, spectating: false,
    q: 2, r: 2, year: null, wear: 1, lap: 0, lapTotal: 2, pos: 1, count: 1, done: false, endsInMs: null, rows: [row0], spectators: [] });
  run(gp, 100);
  assert.deepStrictEqual(log.take(), [], 'driving fires nothing');
  gp.lapDone(80);
  assert.deepStrictEqual(log.take(), ['change']);
  assert.deepStrictEqual([gp.lap, gp.lapTotal, gp.phase], [1, 2, 'quali']);
  assert.deepStrictEqual(view(gp).rows[0], Object.assign({}, row0, { laps: 1, best: 80 }));
  run(gp, 80);
  gp.lapDone(78);
  assert.deepStrictEqual(log.take(), ['phase quali>grid', 'change']);

  // grid: locked until the lights go out
  const G = gp.now(), s = gp.snapshot;
  assert.deepStrictEqual([s.phase, s.lightsAt, s.goAt], ['grid', G + 4000, G + 10250]);
  assert.deepStrictEqual([gp.phase, gp.gridSlot, gp.lap, gp.lapTotal, gp.inputLocked, gp.lights], ['grid', 0, 0, 2, true, 0]);
  let v = view(gp);
  assert.deepStrictEqual([v.phase, v.taking, v.pos, v.count, v.done, v.lap, v.lapTotal], ['grid', true, 1, 1, false, 0, 2]);
  assert.deepStrictEqual(v.rows[0], Object.assign({}, row0, { laps: 2, best: 78, done: true }), 'grid rows show the qualifying result');
  gp.lapDone(80); gp.setProgress(-0.01);
  assert.deepStrictEqual(log.take(), [], 'no laps on the grid');
  const seen = [gp.lights];
  let first = null;
  while (gp.now() < s.goAt + 3000) {
    gp.update(DT);
    const t = gp.now(), ev = log.take();
    if (t < s.goAt) {
      assert.deepStrictEqual(ev, []);
      assert.deepStrictEqual([gp.phase, gp.inputLocked, gp.goFlash, gp.sinceGo], ['grid', true, false, 0]);
      assert.strictEqual(gp.lights, t < s.lightsAt ? 0 : Math.min(5, 1 + Math.floor((t - s.lightsAt) / 1000)));
      assert.strictEqual(gp.isGhost(1), t < s.lightsAt, 'before the lights everybody is a ghost, then the drivers are solid');
      assert.strictEqual(gp.isGhost(2), true, 'nobody else is in an offline session');
    } else {
      if (first === null) {
        first = t;
        assert.deepStrictEqual(ev, ['go', 'phase grid>race', 'change'], 'lights out: go once, then the race');
      } else assert.deepStrictEqual(ev, []);
      assert.deepStrictEqual([gp.phase, gp.inputLocked, gp.lights], ['race', false, 0]);
      assert.strictEqual(gp.sinceGo, (t - s.goAt) / 1000);
      assert.strictEqual(gp.goFlash, t - s.goAt < 1500);
    }
    if (seen[seen.length - 1] !== gp.lights) seen.push(gp.lights);
  }
  assert.deepStrictEqual(seen, [0, 1, 2, 3, 4, 5, 0], 'five lights one by one, then out');
  assert(first >= s.goAt && first - s.goAt < DT * 1000, 'unlocked in the frame the clock passed goAt');

  // race: 2 laps
  v = view(gp);
  assert.deepStrictEqual([v.phase, v.lap, v.lapTotal, v.pos, v.done, v.endsInMs], ['race', 0, 2, 1, false, null]);
  assert.deepStrictEqual(v.rows[0], row0, 'race rows: race laps / best, nothing yet');
  run(gp, 77);                                                 // 80 s after lights out (the loop above ran 3 s into the race)
  gp.setProgress(0.99);
  gp.lapDone(80);
  assert.deepStrictEqual(log.take(), ['change']);
  v = view(gp);
  assert.deepStrictEqual([v.lap, v.lapTotal, v.done, v.endsInMs], [1, 2, false, null]);
  assert.deepStrictEqual(v.rows[0], Object.assign({}, row0, { laps: 1, best: 80 }));
  run(gp, 76);
  gp.lapDone(76);
  assert.deepStrictEqual(log.take(), ['phase race>results', 'change']);

  // results
  assert.deepStrictEqual([gp.phase, gp.taking, gp.lap, gp.lapTotal, gp.inputLocked, gp.lights, gp.goFlash, gp.sinceGo], ['results', true, 2, 2, false, 0, false, 0]);
  v = view(gp);
  assert.deepStrictEqual([v.phase, v.pos, v.count, v.done, v.endsInMs, v.spectating], ['results', 1, 1, true, null, false]);
  assert(Math.abs(v.rows[0].time - 156) < 1e-9, String(v.rows[0].time));
  assert.deepStrictEqual(Object.assign({}, v.rows[0], { time: 0 }), Object.assign({}, row0, { laps: 2, best: 76, time: 0, done: true }));
  gp.lapDone(80); gp.setProgress(2.1);
  run(gp, 5);
  assert.deepStrictEqual(log.take(), [], 'results: nothing more happens by itself');

  // again: a new session id, qualifying skipped, 'go' fires once more
  assert.strictEqual(gp.action('again'), true);
  assert.deepStrictEqual(log.take(), ['phase results>quali', 'change']);
  assert.deepStrictEqual([gp.phase, gp.sid, gp.lap, gp.lapTotal], ['quali', 2, 0, 2]);
  assert.strictEqual(gp.action('skip'), true);
  assert.deepStrictEqual(log.take(), ['phase quali>grid', 'change']);
  assert.deepStrictEqual(view(gp).rows[0], row0, 'on the grid without a time');
  run(gp, 11);
  assert.deepStrictEqual(log.take(), ['go', 'phase grid>race', 'change']);
  run(gp, 3);
  assert.deepStrictEqual(log.take(), []);

  // end: the race -> results (as it stands) -> free
  assert.strictEqual(gp.action('end'), true);
  assert.deepStrictEqual(log.take(), ['phase race>results', 'change']);
  assert.strictEqual(view(gp).done, false);
  assert.strictEqual(gp.action('end'), true);
  assert.deepStrictEqual(log.take(), ['phase results>free', 'change']);
  for (const a of ['end', 'again', 'skip', 'start', 'bogus', null, undefined]) assert.strictEqual(gp.action(a), false, String(a));
  assert.deepStrictEqual(log.take(), []);
  assert.deepStrictEqual(view(gp), { phase: 'free', online: false, canControl: true, taking: false, spectating: false,
    q: 2, r: 2, year: null, wear: 1, lap: 0, lapTotal: 0, pos: 0, count: 0, done: false, endsInMs: null, rows: [], spectators: [] });
  assert.strictEqual(gp.isGhost(2), false);
});

test('offline: the clock only runs in update(dt) (the menu pauses the session); bad laps fire lapRejected', () => {
  const { gp, log } = offline({ name: 'T', colour: '#ffffff' });
  assert.strictEqual(gp.start({ q: 3, r: 1 }, LEN), true);
  log.take();
  const t0 = gp.now();
  gp.lapDone(MIN - 0.1);
  assert.deepStrictEqual(log.take(), ['rejected too-fast']);
  gp.lapDone(80);
  assert.deepStrictEqual(log.take(), ['rejected too-soon'], 'no update() since the start: no time has passed');
  gp.view(); gp.isGhost(2); gp.setProgress(0.3);
  for (const bad of [NaN, -1, 0, Infinity, undefined, null, '1']) gp.update(bad);
  assert.strictEqual(gp.now(), t0, 'the clock stands still without a positive dt');
  run(gp, 100);
  assert.strictEqual(gp.now(), t0 + 100000, 'and advances by exactly the dt it is given');
  gp.lapDone(300);
  gp.lapDone(NaN);
  assert.deepStrictEqual(log.take(), ['rejected inconsistent', 'rejected bad']);
  assert.strictEqual(gp.lap, 0);
  gp.lapDone(80);
  assert.deepStrictEqual(log.take(), ['change']);
  assert.strictEqual(gp.lap, 1);
  // "menu open": on the grid nothing moves until update() is called again
  assert.strictEqual(gp.action('skip'), true);
  log.take();
  run(gp, 5);
  const lit = gp.lights, t1 = gp.now();
  assert.deepStrictEqual([lit, gp.inputLocked], [2, true]);
  assert.deepStrictEqual([gp.now(), gp.lights, gp.inputLocked, gp.phase], [t1, lit, true, 'grid']);
  assert.deepStrictEqual(log.take(), []);
});

test('offline: trackChanged() ends the session', () => {
  const { gp, log } = offline({ name: 'T', colour: '#ffffff' });
  gp.trackChanged();
  assert.deepStrictEqual(log.take(), [], 'nothing to end');
  gp.start({ q: 1, r: 1 }, LEN); run(gp, 10); log.take();
  gp.trackChanged();
  assert.deepStrictEqual(log.take(), ['phase quali>free', 'change']);
  assert.deepStrictEqual([gp.phase, gp.taking, gp.lap, gp.lapTotal], ['free', false, 0, 0]);
  gp.trackChanged();
  assert.deepStrictEqual(log.take(), []);
  // from the race: straight to free (not via the results)
  gp.start({ q: 1, r: 1 }, LEN); gp.action('skip'); run(gp, 11);
  assert.strictEqual(gp.phase, 'race');
  log.take();
  gp.trackChanged();
  assert.deepStrictEqual(log.take(), ['phase race>free', 'change']);
  assert.deepStrictEqual([gp.inputLocked, gp.lights, gp.goFlash, gp.sinceGo], [false, 0, false, 0]);
  // and from the grid the input lock goes with it
  gp.start({ q: 1, r: 1 }, LEN); gp.action('skip');
  assert.strictEqual(gp.inputLocked, true);
  gp.trackChanged();
  assert.deepStrictEqual([gp.phase, gp.inputLocked], ['free', false]);
  assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), true, 'a new Grand Prix can start on the new track');
  assert.strictEqual(gp.sid, 4);
});

test('offline: start() validates, clamps, restarts with a new session id and takes the current profile name', () => {
  const profile = { name: 'First', colour: '#aabbcc' };
  const { gp, log } = offline(profile);
  for (const len of [undefined, NaN, 50, '5000']) assert.strictEqual(gp.start({ q: 1, r: 1 }, len), false, String(len));
  assert.deepStrictEqual(log.take(), []);
  assert.strictEqual(gp.phase, 'free');
  assert.strictEqual(gp.start(null, LEN), true);
  assert.deepStrictEqual([view(gp).q, view(gp).r, gp.sid], [3, 5, 1], 'defaults');
  log.take();
  assert.strictEqual(gp.start({ q: 50, r: 0 }, LEN), true);
  assert.deepStrictEqual(log.take(), ['phase quali>quali', 'change'], 'same phase, new session id: a phase event');
  assert.deepStrictEqual([view(gp).q, view(gp).r, gp.sid, gp.lapTotal], [20, 1, 2, 20]);
  assert.strictEqual(view(gp).rows[0].name, 'First');
  gp.action('end');
  profile.name = 'Second'; profile.colour = 'red';
  gp.start({ q: 1, r: 1 }, LEN);
  assert.deepStrictEqual([view(gp).rows[0].name, view(gp).rows[0].colour], ['Second', '#888888'], 'renamed; unknown colour -> grey');
  // a getProfile that throws does not break anything
  const g2 = createGp();
  g2.init({ net: null, getProfile: () => { throw new Error('profile boom'); } });
  assert.strictEqual(quiet(() => { assert.strictEqual(g2.start({ q: 1, r: 1 }, LEN), true); }), 1);
  assert.strictEqual(quiet(() => { assert.strictEqual(g2.view().rows[0].name, 'Player'); }), 1);
});

test('listeners that throw do not break the controller; init() again resets it and keeps the listeners', () => {
  const gp = createGp();
  gp.on('phase', () => { throw new Error('phase boom'); });
  gp.on('change', () => { throw new Error('change boom'); });
  gp.on('go', () => { throw new Error('go boom'); });
  gp.on('lapRejected', () => { throw new Error('rejected boom'); });
  const log = record(gp);
  gp.init({ net: null, getProfile: () => ({ name: 'T', colour: '#ffffff' }), random: () => 0 });
  const errors = quiet(() => {
    assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), true);
    gp.lapDone(1);
    gp.action('skip');
    run(gp, 10);
  });
  assert.strictEqual(errors, 8, 'phase + change (start), rejected, phase + change (skip), go, phase + change (race)');
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change', 'rejected too-fast', 'phase quali>grid', 'change', 'go', 'phase grid>race', 'change']);
  assert.strictEqual(gp.phase, 'race');
  gp.init({ net: null, getProfile: () => ({ name: 'T', colour: '#ffffff' }) });
  assert.deepStrictEqual([gp.phase, gp.sid, gp.snapshot, gp.taking, gp.online], ['free', 0, null, false, false]);
  assert.deepStrictEqual(log.take(), [], 'init() fires nothing');
  assert.strictEqual(quiet(() => gp.start({ q: 1, r: 1 }, LEN)), 2);
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change'], 'the listeners survived');
  assert.strictEqual(quiet(() => { gp.action('skip'); run(gp, 11); }), 5);
  assert.deepStrictEqual([gp.sid, log.take()], [1, ['phase quali>grid', 'change', 'go', 'phase grid>race', 'change']], 'session 1 again: go again');
});

/* ---------- online ---------- */

test('online: connecting abandons an offline session, disconnecting goes back to an idle offline one', () => {
  const room = makeRoom();
  room.add(1, 'Al', '#ff0000');
  const b = room.client(2, 'Bea', '#2222ff'), gp = b.gp, log = b.log;
  assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), true);
  assert.deepStrictEqual([gp.online, gp.phase, gp.selfId, gp.canControl, gp.taking], [false, 'quali', 1, true, true]);
  log.take();
  b.connect();
  assert.deepStrictEqual(log.take(), ['phase quali>free', 'change', 'change'], 'abandoned at once; then the room\'s (free) session arrives');
  assert.deepStrictEqual([gp.online, gp.phase, gp.selfId, gp.canControl, gp.taking, gp.sid], [true, 'free', 2, false, false, 0]);
  assert.deepStrictEqual(gp.snapshot, b.net.session);
  assert.notStrictEqual(gp.snapshot, b.net.session, 'a sanitised copy, not the object from the wire');
  let v = view(gp);
  assert.deepStrictEqual([v.online, v.canControl, v.spectating, v.count], [true, false, false, 0]);
  assert.strictEqual(gp.now(), room.t, 'the clock is the server\'s');
  gp.update(1000);
  assert.strictEqual(gp.now(), room.t, 'update(dt) does not move it');

  room.srv.start({ q: 1, r: 1, len: LEN }, room.t); room.push();
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change']);
  assert.deepStrictEqual([gp.taking, gp.sid, gp.lap, gp.lapTotal], [true, 1, 0, 1]);

  b.disconnect();
  assert.deepStrictEqual(log.take(), ['phase quali>free', 'change']);
  assert.deepStrictEqual([gp.online, gp.phase, gp.snapshot, gp.selfId, gp.canControl, gp.taking, gp.sid], [false, 'free', null, 1, true, false, 0]);
  assert.strictEqual(b.net.calls.progress[b.net.calls.progress.length - 1], null, 'race progress cleared on disconnect');
  v = view(gp);
  assert.deepStrictEqual([v.online, v.phase, v.q, v.r, v.count], [false, 'free', 3, 5, 0]);
  b.net.emit('gp', room.srv.snapshot());
  b.net.emit('players', []);
  b.net.emit('lapRejected', 'too-fast');
  assert.deepStrictEqual(log.take(), [], 'net events are ignored while offline');
  assert.strictEqual(gp.phase, 'free');
  // the local session is idle (the one we abandoned was ended, not parked) and usable again
  for (const a of ['end', 'skip', 'again']) assert.strictEqual(gp.action(a), false, a);
  run(gp, 1);
  assert.deepStrictEqual(log.take(), []);
  const t0 = gp.now();
  gp.update(DT);
  assert.strictEqual(gp.now(), t0 + DT * 1000, 'back on the game clock');
  assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), true);
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change']);
  assert.deepStrictEqual([view(gp).rows[0].name, view(gp).rows[0].colour, gp.selfId], ['Solo', '#00ff00', 1]);
  assert.strictEqual(b.net.calls.gp.length, 0, 'offline start does not go through the net');

  // disconnect when nothing was running: 'change' only
  room.srv.end();
  const c = room.client(5, 'Eve', '#123456');
  c.connect(); c.log.take();
  c.disconnect();
  assert.deepStrictEqual(c.log.take(), ['change']);
});

test('online: a session already known to net when it connects (or at init) is adopted', () => {
  const room = makeRoom();
  room.add(1, 'Al', '#ff0000');
  room.srv.start({ q: 1, r: 1, len: LEN }, room.t);
  const b = room.client(2, 'Bea', '#2222ff');
  b.gp.start({ q: 1, r: 1 }, LEN);          // offline quali, sid 1 - the same phase and id as the room's
  b.log.take();
  room.srv.addPlayer(2, 'Bea', room.t);
  b.net.id = 2; b.net.connected = true; b.net.session = room.srv.snapshot();
  b.net.emit('connected', { id: 2, isHost: false });
  assert.deepStrictEqual(b.log.take(), ['phase quali>free', 'change', 'phase free>quali', 'change'], 'a different session: through free');
  assert.deepStrictEqual([b.gp.online, b.gp.phase, b.gp.selfId, b.gp.taking], [true, 'quali', 2, true]);
  // init() on a net that is already connected
  const g = createGp();
  g.init({ net: b.net, getProfile: () => ({ name: 'x', colour: '#000000' }) });
  assert.deepStrictEqual([g.online, g.phase, g.selfId, g.taking, g.canControl], [true, 'quali', 2, true, false]);
});

test('online: phase / session id changes, host control (canControl follows isHost), laps go to the server', () => {
  const room = makeRoom();
  const a = room.client(1, 'Al', '#ff0000'), gp = a.gp, log = a.log, net = a.net;
  a.connect();
  room.add(2, 'Bea', '#2222ff');
  log.take();
  assert.deepStrictEqual([gp.canControl, view(gp).canControl], [true, true]);

  assert.strictEqual(gp.start({ q: 2, r: 3 }, LEN), true);
  assert.deepStrictEqual(net.calls.gp, [['start', { q: 2, r: 3, len: LEN }]]);
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change']);
  assert.deepStrictEqual([gp.phase, gp.sid, gp.lap, gp.lapTotal, gp.taking], ['quali', 1, 0, 2, true]);

  gp.lapDone(10);
  assert.deepStrictEqual(net.calls.lap, [[1, 10]]);
  assert.deepStrictEqual(log.take(), ['rejected too-fast'], 'the server\'s verdict is passed on');
  net.emit('lapRejected', 42);
  assert.deepStrictEqual(log.take(), ['rejected '], 'a reason that is not a string becomes ""');
  room.wait(100);
  gp.lapDone(80);
  assert.deepStrictEqual(net.calls.lap[1], [1, 80]);
  assert.deepStrictEqual(log.take(), ['change'], 'a new snapshot in the same phase: change only');
  assert.strictEqual(gp.lap, 1);

  assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), true);                // the host restarts it
  assert.deepStrictEqual(log.take(), ['phase quali>quali', 'change'], 'same phase, new session id');
  assert.deepStrictEqual([gp.sid, gp.lap, gp.lapTotal], [2, 0, 1]);

  room.hostId = 2; room.sendRoster();                                     // host migration
  assert.deepStrictEqual(log.take(), ['change']);
  assert.deepStrictEqual([gp.canControl, view(gp).canControl], [false, false]);
  assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), false);
  assert.strictEqual(gp.action('skip'), false);
  assert.deepStrictEqual([gp.phase, gp.sid], ['quali', 2]);
  room.hostId = 1; room.sendRoster();
  assert.deepStrictEqual(log.take(), ['change']);
  assert.strictEqual(gp.canControl, true);

  const n = net.calls.gp.length;
  assert.strictEqual(gp.action('bogus'), false);
  assert.strictEqual(net.calls.gp.length, n, 'unknown actions never reach the net');
  assert.strictEqual(gp.action('skip'), true);
  assert.deepStrictEqual(net.calls.gp[n], ['skip']);
  assert.deepStrictEqual(log.take(), ['phase quali>grid', 'change']);
  assert.strictEqual(gp.action('end'), true);
  assert.deepStrictEqual(log.take(), ['phase grid>free', 'change']);
  assert.deepStrictEqual([gp.taking, gp.lap, gp.lapTotal, gp.inputLocked], [false, 0, 0, false]);

  // a session id that changes while the phase stays 'free' is not a new Grand Prix
  net.emit('gp', Object.assign(room.srv.snapshot(), { sid: 77 }));
  assert.deepStrictEqual(log.take(), ['change']);
  assert.deepStrictEqual([gp.phase, gp.sid], ['free', 77]);
});

test('online: start lights from the server clock, input lock, go exactly once (before or after the race snapshot)', () => {
  const { room, gp, log, net } = gridRoom();
  const s = gp.snapshot, G = room.t;
  assert.deepStrictEqual([s.lightsAt, s.goAt], [G + 4000, G + 9500]);
  assert.deepStrictEqual([gp.gridSlot, gp.lap, gp.lapTotal, gp.taking, gp.inputLocked, gp.lights], [1, 0, 2, true, true, 0]);
  gp.update(0.016);
  assert.deepStrictEqual([gp.inputLocked, gp.lights, gp.goFlash, gp.sinceGo], [true, 0, false, 0]);
  room.t = s.lightsAt - 1; gp.update(0.016);
  assert.strictEqual(gp.lights, 0);
  for (let k = 0; k < 5; k++) {
    room.t = s.lightsAt + k * 1000; gp.update(0.016);
    assert.deepStrictEqual([gp.lights, gp.inputLocked], [k + 1, true]);
    room.t += 999; gp.update(0.016);
    assert.strictEqual(gp.lights, k + 1);
  }
  room.t = s.goAt - 1; gp.update(0.016);
  assert.deepStrictEqual([gp.lights, gp.inputLocked, gp.goFlash, gp.sinceGo], [5, true, false, 0], 'all five held until lights out');
  assert.deepStrictEqual(log.take(), []);

  room.t = s.goAt + 40;                       // our clock passes goAt; the server has not said "race" yet
  assert.strictEqual(gp.inputLocked, true, 'only update() refreshes the lock');
  gp.update(0.016);
  assert.deepStrictEqual(log.take(), ['go']);
  assert.deepStrictEqual([gp.phase, gp.inputLocked, gp.lights, gp.goFlash, gp.sinceGo], ['grid', false, 0, true, 0.04]);
  gp.update(0.016); gp.update(0.016);
  assert.deepStrictEqual(log.take(), [], 'go fires once');
  gp.lapDone(80);
  assert.deepStrictEqual(net.calls.lap, [], 'no laps before the server is racing');
  room.wait(0.06);                            // the server's tick: race
  assert.deepStrictEqual(log.take(), ['phase grid>race', 'change']);
  gp.update(0.016);
  assert.deepStrictEqual(log.take(), [], 'and not again when the race snapshot arrives');
  room.t = s.goAt + 1499; gp.update(0.016);
  assert.deepStrictEqual([gp.goFlash, gp.sinceGo, gp.lights, gp.inputLocked], [true, 1.499, 0, false]);
  room.t = s.goAt + 1500; gp.update(0.016);
  assert.deepStrictEqual([gp.goFlash, gp.sinceGo], [false, 1.5]);

  // the other order: our clock estimate lags, the race snapshot arrives first
  const k = gridRoom();
  k.net.skew = -300;
  k.room.t = k.gp.snapshot.goAt; k.gp.update(0.016);
  assert.deepStrictEqual([k.gp.inputLocked, k.gp.lights], [true, 5], 'by our clock the lights are still on');
  k.room.wait(0);
  assert.deepStrictEqual(k.log.take(), ['phase grid>race', 'change']);
  assert.deepStrictEqual([k.gp.phase, k.gp.inputLocked, k.gp.lights], ['race', false, 0], 'the server says race: unlocked, lights out');
  k.gp.update(0.016);
  assert.deepStrictEqual(k.log.take(), ['go']);
  assert.strictEqual(k.gp.sinceGo, 0);
  k.room.t += 1000; k.gp.update(0.016);
  assert.deepStrictEqual([k.log.take(), k.gp.sinceGo], [[], 0.7]);

  // the menu is open during the start (no update()): phase events still arrive, go fires on the first frame back
  const m = gridRoom();
  m.room.wait(14.5);                          // lights out was 5 s ago
  assert.deepStrictEqual(m.log.take(), ['phase grid>race', 'change']);
  assert.strictEqual(m.gp.inputLocked, false);
  m.gp.update(0.016);
  assert.deepStrictEqual(m.log.take(), ['go']);
  assert.strictEqual(m.gp.sinceGo, 5, 'main.js starts the lap clock from sinceGo');

  // "again": a new session id -> go fires again
  const a = gridRoom();
  a.room.wait(9.5); a.gp.update(0.016);
  assert.deepStrictEqual(a.log.take(), ['phase grid>race', 'change', 'go']);
  a.room.srv.end(); a.room.srv.again(a.room.t); a.room.srv.skip(a.room.t); a.room.push();
  assert.deepStrictEqual(a.log.take(), ['phase race>grid', 'change']);
  assert.deepStrictEqual([a.gp.sid, a.gp.inputLocked], [2, true]);
  a.gp.update(0.016);
  assert.deepStrictEqual(a.log.take(), []);
  a.room.wait(9.5); a.gp.update(0.016);
  assert.deepStrictEqual(a.log.take(), ['phase grid>race', 'change', 'go']);
});

test('online: race - laps, progress forwarding, standings view, chequered flag, results', () => {
  const { room, gp, log, net } = gridRoom();
  room.add(3, 'Cy', '#00ffff');               // joins on the grid: a spectator
  log.take();
  const prog = net.calls.progress;
  const last = () => prog[prog.length - 1];

  let v = view(gp);
  assert.deepStrictEqual([v.phase, v.taking, v.spectating, v.pos, v.count, v.lap, v.lapTotal, v.done, v.endsInMs], ['grid', true, false, 2, 3, 0, 2, false, null]);
  assert.deepStrictEqual(v.rows.map(r => [r.pos, r.id, r.name, r.colour, r.isSelf, r.laps, r.best, r.done]), [
    [1, 1, 'Al', '#ff0000', false, 1, 80, true], [2, 2, 'Bea', '#2222ff', true, 1, 81, true], [3, 4, 'Di', '#ffff00', false, 1, 82, true]]);
  assert(v.rows.every(r => r.time === null && r.gap === null && r.down === 0 && !r.dnf && !r.left));
  assert.deepStrictEqual(v.spectators, [{ id: 3, name: 'Cy', colour: '#00ffff' }]);

  gp.setProgress(-0.02);
  assert.strictEqual(last(), null, 'grid: progress is not forwarded');
  room.wait(9.5); gp.update(0.016);
  assert.deepStrictEqual(log.take(), ['phase grid>race', 'change', 'go']);
  gp.setProgress(0.25);
  assert.strictEqual(last(), 0.25, 'racing: forwarded');
  gp.setProgress(NaN);
  assert.strictEqual(last(), null, 'not a number: cleared');
  gp.setProgress(0.3);
  room.srv.progress(1, 0.2); room.srv.progress(4, 0.1);
  room.push();
  v = view(gp);
  assert.deepStrictEqual(v.rows.map(r => r.id), [2, 1, 4], 'live order by distance');
  assert.deepStrictEqual([v.pos, v.count, v.lap, v.lapTotal], [1, 3, 0, 2]);
  assert.deepStrictEqual(v.rows.map(r => [r.laps, r.best, r.time, r.gap, r.down, r.done]), [[0, null, null, null, 0, false], [0, null, null, null, 0, false], [0, null, null, null, 0, false]]);

  room.wait(100); assert.strictEqual(room.lap(1, 100), '');
  room.wait(1); gp.lapDone(101);
  assert.deepStrictEqual(net.calls.lap, [[1, 101]], 'sendGpLap(sid, time)');
  room.wait(1); assert.strictEqual(room.lap(4, 102), '');
  log.take();
  v = view(gp);
  assert.deepStrictEqual(v.rows.map(r => [r.id, r.laps, r.best, r.time, r.down, r.done]), [[1, 1, 100, null, 0, false], [2, 1, 101, null, 0, false], [4, 1, 102, null, 0, false]]);
  assert.deepStrictEqual(v.rows.map(r => r.gap === null ? null : Math.round(r.gap * 1000) / 1000), [null, 1, 2]);
  assert.deepStrictEqual([v.pos, v.lap, v.lapTotal, v.done, v.endsInMs], [2, 1, 2, false, null]);

  room.wait(98); assert.strictEqual(room.lap(1, 100), '');               // t = 200: Al wins
  v = view(gp);
  assert.strictEqual(gp.phase, 'race');
  assert.strictEqual(v.endsInMs, 90000);
  assert.deepStrictEqual([v.rows[0].id, v.rows[0].done, v.rows[0].time, v.rows[0].laps], [1, true, 200, 2]);
  room.t += 1000;
  assert.strictEqual(view(gp).endsInMs, 89000, 'counted down on the session clock at the time of the call');
  room.t += 200000;
  assert.strictEqual(view(gp).endsInMs, 0, 'never negative');
  room.t -= 200000;
  gp.setProgress(1.97);
  assert.strictEqual(last(), 1.97, 'still racing after the winner finished');
  assert.deepStrictEqual(log.take(), ['change'], 'the winner\'s lap: a new snapshot');

  gp.lapDone(100);                                                       // t = 201: we finish, Di is still out
  assert.deepStrictEqual(net.calls.lap[1], [1, 100]);
  assert.deepStrictEqual(log.take(), ['change']);
  assert.strictEqual(last(), null, 'finished: the progress is cleared without waiting for setProgress()');
  v = view(gp);
  assert.deepStrictEqual([v.phase, v.done, v.pos, v.lap, v.lapTotal], ['race', true, 2, 2, 2]);
  assert.deepStrictEqual([v.rows[1].id, v.rows[1].done, v.rows[1].time, Math.round(v.rows[1].gap * 1000)], [2, true, 201, 1000]);
  const n = prog.length;
  gp.setProgress(2.01);
  assert.deepStrictEqual([prog.length, last()], [n + 1, null], 'finished: not forwarded');
  gp.lapDone(90);
  assert.strictEqual(net.calls.lap.length, 2, 'finished: further laps are not reported');
  assert.deepStrictEqual(log.take(), []);

  room.remove(4);                                                         // Di leaves: DNF, the race is over
  assert.deepStrictEqual(log.take(), ['change', 'phase race>results', 'change'], 'roster, then the results');
  v = view(gp);
  assert.deepStrictEqual([v.phase, v.pos, v.count, v.done, v.endsInMs, v.taking, v.spectating], ['results', 2, 3, true, null, true, false]);
  assert.deepStrictEqual(v.rows.map(r => [r.pos, r.id, r.name, r.colour, r.laps, r.best, r.done, r.dnf, r.left]), [
    [1, 1, 'Al', '#ff0000', 2, 100, true, false, false], [2, 2, 'Bea', '#2222ff', 2, 100, true, false, false],
    [3, 4, 'Di', '#888888', 1, 102, false, true, true]], 'a driver who left: classified DNF, colour unknown');
  assert.deepStrictEqual(v.rows.map(r => r.time), [200, 201, null]);
  assert.deepStrictEqual(v.spectators, [{ id: 3, name: 'Cy', colour: '#00ffff' }]);
  assert.deepStrictEqual([gp.inputLocked, gp.lights, gp.goFlash, gp.sinceGo, gp.lap, gp.lapTotal], [false, 0, false, 0, 2, 2]);
  gp.setProgress(2.2); gp.lapDone(100);
  assert.deepStrictEqual([last(), net.calls.lap.length], [null, 2]);

  // the race ending while we are still driving clears the progress too
  const k = gridRoom();
  k.room.wait(9.5); k.gp.update(0.016);
  k.gp.setProgress(0.4);
  const before = k.net.calls.progress.length;
  k.room.srv.end(); k.room.push();
  assert.strictEqual(k.gp.phase, 'results');
  assert.deepStrictEqual(k.net.calls.progress.slice(before), [null]);
});

test('online: a spectator (joined after qualifying) is not classified: no lock, no go, everybody a ghost', () => {
  const { room } = gridRoom();
  const c = room.client(3, 'Cy', '#00FFFF'), gp = c.gp, log = c.log, net = c.net;
  c.connect();
  assert.deepStrictEqual(log.take(), ['change', 'phase free>grid', 'change']);
  assert.deepStrictEqual([gp.online, gp.phase, gp.selfId, gp.taking, gp.gridSlot, gp.lap, gp.lapTotal, gp.inputLocked, gp.canControl], [true, 'grid', 3, false, -1, 0, 0, false, false]);
  let v = view(gp);
  assert.deepStrictEqual([v.taking, v.spectating, v.pos, v.count, v.done, v.lap, v.lapTotal, v.q, v.r], [false, true, 0, 3, false, 0, 0, 1, 2]);
  assert.deepStrictEqual(v.rows.map(r => r.id), [1, 2, 4]);
  assert.deepStrictEqual(v.spectators, [{ id: 3, name: 'Cy', colour: '#00ffff' }]);
  const s = gp.snapshot;
  room.t = s.lightsAt + 2500; gp.update(0.016);
  assert.deepStrictEqual([gp.lights, gp.inputLocked], [3, false], 'the lights are shown, the input is never locked');
  for (const id of [1, 2, 4, 3, 99]) assert.strictEqual(gp.isGhost(id), true, 'grid ' + id);
  room.wait(3.5); gp.update(0.016); gp.update(0.016);         // 0.5 s after lights out
  assert.deepStrictEqual(log.take(), ['phase grid>race', 'change'], 'no go for a spectator');
  assert.deepStrictEqual([gp.phase, gp.taking, gp.inputLocked, gp.goFlash], ['race', false, false, true]);
  for (const id of [1, 2, 4, 99]) assert.strictEqual(gp.isGhost(id), true, 'race ' + id);
  gp.lapDone(80); gp.setProgress(0.5);
  assert.deepStrictEqual([net.calls.lap, net.calls.progress[net.calls.progress.length - 1]], [[], null]);
  room.srv.end(); room.push();
  assert.deepStrictEqual(log.take(), ['phase race>results', 'change']);
  for (const id of [1, 2, 4, 99]) assert.strictEqual(gp.isGhost(id), true, 'results ' + id);
  assert.strictEqual(view(gp).spectating, true);
  // the next session: takes part
  room.srv.again(room.t); room.push();
  assert.deepStrictEqual(log.take(), ['phase results>quali', 'change']);
  v = view(gp);
  assert.deepStrictEqual([gp.taking, v.spectating, v.spectators.length, v.count, gp.lapTotal], [true, false, 0, 4, 1]);
  room.wait(100); gp.lapDone(90);
  assert.deepStrictEqual(net.calls.lap, [[2, 90]]);
  assert.strictEqual(view(gp).done, true);
  gp.lapDone(85);
  assert.strictEqual(net.calls.lap.length, 1, 'qualifying done: further laps are not reported');
  assert(log.take().every(e => e === 'change'), 'and nothing is rejected');
});

test('online: isGhost in every phase', () => {
  const room = makeRoom();
  room.add(1, 'Al', '#ff0000');
  const b = room.client(2, 'Bea', '#2222ff'), gp = b.gp;
  b.connect();
  const ghosts = () => [1, 3, 99].map(id => gp.isGhost(id));      // a driver, a (later) spectator, a stranger
  assert.deepStrictEqual([gp.phase, ghosts()], ['free', [false, false, false]]);
  room.srv.start({ q: 1, r: 1, len: LEN }, room.t); room.push();
  assert.deepStrictEqual([gp.phase, ghosts()], ['quali', [true, true, true]]);
  room.wait(100); room.lap(1, 80); gp.lapDone(81);
  room.add(3, 'Cy', '#00ffff');
  const s = gp.snapshot;
  assert.deepStrictEqual([gp.phase, ghosts()], ['grid', [true, true, true]], 'cars are being placed');
  room.t = s.lightsAt - 1;
  assert.deepStrictEqual(ghosts(), [true, true, true]);
  room.t = s.lightsAt;
  assert.deepStrictEqual(ghosts(), [false, true, true], 'from the first light the drivers are solid (no update() needed)');
  room.t = s.goAt - 1;
  assert.deepStrictEqual(ghosts(), [false, true, true]);
  room.wait(0.001);
  assert.deepStrictEqual([gp.phase, ghosts()], ['race', [false, true, true]]);
  room.remove(1);                                                 // Al leaves: DNF, still in the snapshot, not a spectator
  assert.deepStrictEqual([gp.phase, ghosts()], ['race', [false, true, true]]);
  room.srv.end(); room.push();
  assert.deepStrictEqual([gp.phase, ghosts()], ['results', [false, true, true]]);
  room.srv.end(); room.push();
  assert.deepStrictEqual([gp.phase, ghosts()], ['free', [false, false, false]]);
});

test('online: malformed snapshots are ignored or sanitised, never thrown on', () => {
  const { room, gp, log, net } = gridRoom();
  const good = () => JSON.parse(JSON.stringify(room.srv.snapshot()));
  const before = JSON.stringify(gp.snapshot);
  const state = () => JSON.stringify([gp.phase, gp.sid, gp.taking, gp.gridSlot, gp.lap, gp.lapTotal, gp.inputLocked, gp.lights, gp.view()]);
  const st = state();
  const bad = [
    null, undefined, 'race', 42, true, [], {}, { phase: 'race' },
    Object.assign(good(), { phase: 'party' }), Object.assign(good(), { phase: ['grid'] }),
    Object.assign(good(), { phase: 'constructor' }), Object.assign(good(), { phase: 'toString' }),
    Object.assign(good(), { sid: '1' }), Object.assign(good(), { sid: NaN }), Object.assign(good(), { sid: null }),
    Object.assign(good(), { players: null }), Object.assign(good(), { players: 'abc' }), Object.assign(good(), { players: { length: 3 } }),
    Object.assign(good(), { order: undefined }), Object.assign(good(), { order: 7 }), Object.assign(good(), { grid: 'abc' }),
    Object.assign(good(), { grid: null }),
    Object.assign(good(), { goAt: undefined }), Object.assign(good(), { goAt: NaN }), Object.assign(good(), { goAt: '9' }),
    Object.assign(good(), { goAt: 0 }), Object.assign(good(), { goAt: Infinity }), Object.assign(good(), { lightsAt: null }),
    Object.assign(good(), { lightsAt: good().goAt + 1 }),
    Object.assign(good(), { phase: 'race', goAt: -5, lightsAt: -10 })
  ];
  bad.forEach((s, i) => {
    assert.doesNotThrow(() => net.emit('gp', s), 'bad #' + i);
    gp.update(0.016); gp.isGhost(1); gp.setProgress(0.1);
    assert.strictEqual(JSON.stringify(gp.snapshot), before, 'bad #' + i + ' changed the snapshot');
    assert.strictEqual(state(), st, 'bad #' + i + ' changed the state');
  });
  assert.deepStrictEqual(log.take(), [], 'and no events');

  // right shape, rubbish inside: sanitised
  const junk = good();
  junk.q = 1e9; junk.r = -3; junk.len = 'long'; junk.winnerAt = {}; junk.endsAt = 'soon';
  junk.players = [null, 'x', 7, [], { id: '1' }, { id: NaN },
    { id: 1, name: 12345, spec: 'yes', left: 1, qLaps: 'x', qBest: {}, qDone: 'true', rLaps: -4, rTime: null, rBest: NaN, fin: 1, dnf: [], gap: 'far', down: 2.7 },
    { id: 2, name: 'B'.repeat(500), qLaps: 1.9, qBest: 81 },
    { id: 9, name: 'Spec', spec: true }, { id: 10, name: 'Gone', spec: true, left: true }];
  junk.order = [2, 2, 'x', null, 99, 9, 1, { id: 1 }, 2];
  junk.grid = [99, 2, 1, 1, 2, 9, NaN];
  assert.doesNotThrow(() => net.emit('gp', junk));
  assert.deepStrictEqual(log.take(), ['change']);
  const c = gp.snapshot;
  assert.deepStrictEqual([c.q, c.r, c.len, c.winnerAt, c.endsAt, c.phase, c.sid], [20, 5, 0, 0, 0, 'grid', 1]);
  assert.deepStrictEqual([c.year, c.wear], [null, 1], 'no year / wear in the junk: none / the default');
  assert.deepStrictEqual([c.order, c.grid], [[2, 1], [2, 1]], 'only classified players, each once');
  assert.deepStrictEqual(c.players.map(p => p.id), [1, 2, 9, 10]);
  assert.deepStrictEqual(c.players[0], { id: 1, name: '', spec: false, left: false, qLaps: 0, qBest: null, qDone: false,
    rLaps: 0, rTime: 0, rBest: null, fin: false, dnf: false, gap: null, down: 2 });
  assert.deepStrictEqual([c.players[1].name.length, c.players[1].qLaps, c.players[1].qBest], [32, 1, 81]);
  junk.players.length = 0; junk.order.length = 0; junk.sid = 50;
  assert.deepStrictEqual([gp.snapshot.players.length, gp.snapshot.order.length, gp.sid], [4, 2, 1], 'a copy: later changes to the wire object do not reach us');
  const v = view(gp);
  assert.deepStrictEqual(v.rows.map(r => [r.pos, r.id, r.name, r.colour, r.isSelf]), [[1, 2, 'B'.repeat(32), '#2222ff', true], [2, 1, 'Player 1', '#ff0000', false]]);
  assert.deepStrictEqual(v.spectators, [{ id: 9, name: 'Spec', colour: '#888888' }], 'a spectator who left is not listed');
  assert.deepStrictEqual([gp.gridSlot, gp.taking, v.pos, v.count], [0, true, 1, 2]);
  gp.update(0.016); gp.lapDone(80);

  // more players than any room has: capped
  const crowd = good();
  crowd.players = []; crowd.order = [];
  for (let i = 1; i <= 500; i++) { crowd.players.push({ id: i, name: 'P' + i }); crowd.order.push(i); }
  net.emit('gp', crowd);
  assert.deepStrictEqual([gp.snapshot.players.length, view(gp).count], [64, 64]);

  // we are not in the snapshot at all: not taking part, nothing locked
  const gone = good();
  gone.players = gone.players.filter(p => p.id !== 2);
  net.emit('gp', gone);
  assert.deepStrictEqual([gp.taking, gp.inputLocked, gp.gridSlot, view(gp).spectating, view(gp).pos], [false, false, -1, true, 0]);

  // an id twice (a driver who left, then somebody present with the same id): the one in the room is "that player"
  const twin = good();
  twin.phase = 'race';
  twin.players = [{ id: 1, name: 'Al' }, { id: 2, name: 'Old Bea', left: true, dnf: true }, { id: 2, name: 'New Bea', spec: true }];
  twin.order = [1, 2]; twin.grid = [1, 2];
  net.emit('gp', twin);
  assert.deepStrictEqual([gp.taking, gp.inputLocked, gp.gridSlot, gp.isGhost(1)], [false, false, -1, true], 'we are the spectator, not the driver who left');
  assert.deepStrictEqual(gp.view().rows.map(x => [x.id, x.name, x.isSelf, x.left]), [[1, 'Al', false, false], [2, 'Old Bea', false, true]]);
  assert.deepStrictEqual([gp.view().pos, gp.view().spectating, gp.view().spectators.map(x => x.name)], [0, true, ['New Bea']]);

  // a rubbish roster does not break view() either
  net.emit('gp', good());
  for (const r of [null, 'abc', [null, 5, { id: 'x' }, { id: 1, colour: 'javascript:alert(1)' }, { id: 2 }]]) {
    net.roster = r;
    assert.doesNotThrow(() => net.emit('players', r));
    assert.deepStrictEqual(view(gp).rows.map(x => x.colour), ['#888888', '#888888', '#888888']);
  }
  // nor does a server clock that is not a number
  net.serverNow = () => NaN;
  assert.doesNotThrow(() => { gp.update(0.016); gp.isGhost(1); view(gp); });
  assert(Number.isFinite(gp.now()));
});

test('go fires for every session, also when an offline and a room session happen to share an id', () => {
  const goes = log => log.take().filter(e => e === 'go').length;
  // offline session 1 has had its go; the room's session 1 must get its own
  const r = makeRoom(), c = r.client(1, 'Al', '#ff0000');
  c.gp.start({ q: 1, r: 1 }, LEN); c.gp.action('skip'); run(c.gp, 11);
  assert.deepStrictEqual([c.gp.online, c.gp.phase, c.gp.sid, goes(c.log)], [false, 'race', 1, 1]);
  c.connect();
  assert.strictEqual(c.gp.start({ q: 1, r: 1 }, LEN), true);
  assert.strictEqual(c.gp.action('skip'), true);
  c.log.take();
  r.wait(9.5); c.gp.update(0.016); c.gp.update(0.016);
  assert.deepStrictEqual([c.gp.online, c.gp.sid, c.log.take()], [true, 1, ['phase grid>race', 'change', 'go']]);

  // and back: the room's session 1 had its go, then the first offline session (also number 1) gets one too
  const { room, b, gp, log } = gridRoom();
  room.wait(9.5); gp.update(0.016);
  assert.deepStrictEqual([gp.sid, goes(log)], [1, 1]);
  b.disconnect();
  gp.start({ q: 1, r: 1 }, LEN); gp.action('skip'); run(gp, 11);
  assert.deepStrictEqual([gp.online, gp.phase, gp.sid, goes(log)], [false, 'race', 1, 1]);

  // a controller initialised on a net that is already in a race we take part in: go on its first frame
  const k = gridRoom();
  k.room.wait(12);
  const late = createGp(), llog = record(late);
  late.init({ net: k.net, getProfile: () => ({ name: 'x', colour: '#000000' }) });
  assert.deepStrictEqual([late.online, late.phase, late.taking, llog.take()], [true, 'race', true, []]);
  late.update(0.016); late.update(0.016);
  assert.deepStrictEqual([llog.take(), late.sinceGo], [['go'], 2.5]);
});

test('online: init() again on the same net does not double the listeners; a replaced net is no longer heard', () => {
  const room = makeRoom();
  const a = room.client(1, 'Al', '#ff0000'), gp = a.gp, log = a.log;
  gp.init({ net: a.net, getProfile: () => ({ name: 'Solo', colour: '#00ff00' }) });
  gp.init({ net: a.net, getProfile: () => ({ name: 'Solo', colour: '#00ff00' }) });
  a.connect();
  assert.deepStrictEqual(log.take(), ['change', 'change'], 'connected + the first snapshot, each once');
  assert.strictEqual(gp.start({ q: 1, r: 1 }, LEN), true);
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change']);
  // switch the controller to another net: the old one's events no longer reach it
  const other = makeRoom().client(1, 'Al', '#ff0000');
  gp.init({ net: other.net, getProfile: () => ({ name: 'Solo', colour: '#00ff00' }) });
  assert.deepStrictEqual([gp.online, gp.phase], [false, 'free']);
  room.srv.skip(room.t); room.push();
  a.net.emit('connected', { id: 1, isHost: true });
  assert.deepStrictEqual([log.take(), gp.online, gp.phase], [[], false, 'free']);
  other.net.id = 1; other.net.connected = true;
  other.net.emit('connected', { id: 1, isHost: false });
  assert.deepStrictEqual([log.take(), gp.online], [['change'], true]);
  a.net.emit('gp', room.srv.snapshot());
  a.net.emit('players', []);
  a.net.emit('lapRejected', 'too-fast');
  a.net.emit('disconnected', 'bye');
  a.net.emit('connected', { id: 1, isHost: true });
  assert.deepStrictEqual([log.take(), gp.online, gp.phase, gp.canControl], [[], true, 'free', false]);
});

/* ---------- v6: year and tyre wear ---------- */

test('offline: start({q, r, year, wear}) puts both into the local session; view() shows them through every phase and again', () => {
  const { gp, log } = offline({ name: 'T', colour: '#ffffff' });
  assert.deepStrictEqual([view(gp).year, view(gp).wear], [null, 1], 'before the first Grand Prix');
  assert.strictEqual(gp.start({ q: 1, r: 1, year: 2016, wear: 4 }, LEN), true);
  assert.deepStrictEqual(log.take(), ['phase free>quali', 'change']);
  assert.deepStrictEqual([gp.snapshot.year, gp.snapshot.wear, view(gp).year, view(gp).wear], [2016, 4, 2016, 4]);
  assert.strictEqual(gp.action('skip'), true);
  assert.deepStrictEqual([view(gp).phase, view(gp).year, view(gp).wear], ['grid', 2016, 4]);
  run(gp, 11);
  assert.deepStrictEqual([view(gp).phase, view(gp).year, view(gp).wear], ['race', 2016, 4]);
  assert.strictEqual(gp.action('end'), true);
  assert.deepStrictEqual([view(gp).phase, view(gp).year, view(gp).wear], ['results', 2016, 4]);
  assert.strictEqual(gp.action('again'), true);
  assert.deepStrictEqual([view(gp).phase, gp.sid, view(gp).year, view(gp).wear], ['quali', 2, 2016, 4], 'again keeps them');
  gp.trackChanged();
  assert.deepStrictEqual([view(gp).phase, view(gp).year, view(gp).wear], ['free', 2016, 4], 'free: those of the last session, like q / r');
  // validation is the session's: a year is a whole 2010..2100 or none; wear 1..5, the default when not a number
  const cases = [[{ year: 2026, wear: 5 }, [2026, 5]], [{ year: 2009, wear: 9 }, [null, 5]], [{ year: '2020', wear: 0 }, [null, 1]],
    [{ year: 2020.5, wear: 2.6 }, [null, 3]], [{ year: NaN, wear: '3' }, [null, 1]], [{}, [null, 1]], [{ year: 2100, wear: null }, [2100, 1]]];
  for (const [cfg, want] of cases) {
    assert.strictEqual(gp.start(Object.assign({ q: 1, r: 1 }, cfg), LEN), true, JSON.stringify(cfg));
    assert.deepStrictEqual([view(gp).year, view(gp).wear], want, JSON.stringify(cfg));
  }
  assert.strictEqual(gp.start({ q: 1, r: 1, year: 2011, wear: 2 }, 50), false, 'a refused start changes nothing');
  assert.deepStrictEqual([view(gp).year, view(gp).wear], [2100, 1]);
});

test('online: start() sends the wear (never the year: the server puts in the room\'s); view() shows the session\'s', () => {
  const room = makeRoom();
  room.year = 2021;
  const a = room.client(1, 'Al', '#ff0000'), gp = a.gp, net = a.net;
  a.connect();
  room.add(2, 'Bea', '#2222ff');
  const b = room.client(3, 'Cy', '#00ffff');
  assert.deepStrictEqual([view(gp).year, view(gp).wear], [null, 1], 'the room\'s session has not run yet');
  assert.strictEqual(gp.start({ q: 1, r: 2, year: 1999, wear: 3 }, LEN), true);
  assert.deepStrictEqual(net.calls.gp, [['start', { q: 1, r: 2, len: LEN, wear: 3 }]], 'no year on the wire');
  assert.deepStrictEqual([gp.phase, view(gp).year, view(gp).wear], ['quali', 2021, 3]);
  assert.strictEqual(gp.start({ q: 1, r: 2 }, LEN), true);
  assert.deepStrictEqual(net.calls.gp[1], ['start', { q: 1, r: 2, len: LEN }], 'no wear given: none sent (the server\'s default)');
  assert.deepStrictEqual([gp.sid, view(gp).year, view(gp).wear], [2, 2021, 1]);
  assert.strictEqual(gp.start({ q: 1, r: 2, wear: 5 }, LEN), true);
  // somebody who connects in the middle sees the session's year and wear, as a spectator too
  room.wait(100); room.lap(1, 80); room.lap(2, 81);
  assert.strictEqual(gp.phase, 'grid');
  b.connect();
  assert.deepStrictEqual([b.gp.phase, view(b.gp).spectating, view(b.gp).year, view(b.gp).wear], ['grid', true, 2021, 5]);
  room.wait(10);
  assert.deepStrictEqual([gp.phase, view(gp).year, view(gp).wear, view(b.gp).year], ['race', 2021, 5, 2021]);
  // a guest cannot start one (the net refuses: not the host)
  assert.deepStrictEqual([b.gp.canControl, b.gp.start({ q: 1, r: 1, wear: 2 }, LEN)], [false, false]);
  // disconnected: back to the idle offline session, nothing of the room's
  a.disconnect();
  assert.deepStrictEqual([gp.online, view(gp).year, view(gp).wear], [false, null, 1]);
});

test('online: year / wear garbage in a snapshot is sanitised (a year 2010..2100 or null, wear 1..5)', () => {
  const { room, gp, net, log } = gridRoom();
  const good = () => JSON.parse(JSON.stringify(room.srv.snapshot()));
  const cases = [[2024, 3, [2024, 3]], ['2024', 99, [null, 5]], [2024.5, -1, [null, 1]], [2101, 'x', [null, 1]], [2009, 2.9, [null, 2]],
    [2010, 0, [2010, 1]], [null, null, [null, 1]], [{}, {}, [null, 1]], [[2024], [4], [null, 1]], [Infinity, Infinity, [null, 1]],
    [NaN, NaN, [null, 1]], [true, true, [null, 1]], [2100, 5, [2100, 5]], [undefined, undefined, [null, 1]]];
  for (const [year, wear, want] of cases) {
    const s = good(); s.year = year; s.wear = wear;
    assert.doesNotThrow(() => net.emit('gp', s));
    assert.deepStrictEqual([gp.snapshot.year, gp.snapshot.wear], want, JSON.stringify([year, wear]));
    assert.deepStrictEqual([view(gp).year, view(gp).wear], want);
  }
  assert(log.take().every(e => e === 'change'), 'same session: change events only');
});

test('online: lapDone sends the session clock of the crossing with the lap, so a late report costs nothing (rtime-latency)', () => {
  const { room, gp, net } = gridRoom();
  const sent = [];
  const stub = net.sendGpLap;
  net.sendGpLap = (sid, time, at) => { sent.push([sid, time, at]); return stub(sid, time); };
  net.skew = -12;                                                        // our estimate of the server clock
  gp.lapDone(80);                                                        // on the grid: nothing to report
  assert.strictEqual(sent.length, 0);
  room.wait(9.5); gp.update(0.016);
  assert.strictEqual(gp.phase, 'race');
  room.wait(90);
  gp.lapDone(89.9);
  assert.deepStrictEqual(sent, [[gp.sid, 89.9, room.t - 12]], 'sendGpLap(sid, time, net.serverNow() at the crossing)');
  // offline: the local session's own clock is exact, nothing to send
  const solo = createGp();
  solo.init({ net: null, getProfile: () => ({ name: 'Solo', colour: '#00ff00' }) });
  assert.strictEqual(solo.start({ q: 1, r: 1 }, LEN), true);
  solo.update(100); solo.lapDone(80);
  assert.strictEqual(solo.snapshot.players[0].qLaps, 1, 'offline laps need no proof of driving');
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall gp tests passed');
process.exit(failed ? 1 : 0);
