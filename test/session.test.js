// node test/session.test.js — Grand Prix rules (net/session.js), pure logic with an injected clock.
'use strict';
const assert = require('assert');
const { createSession, minLapTime, RACE_TIMEOUT_MS } = require('../net/session.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}
const LEN = 5000;                       // m -> minimum lap 54.5 s
const MIN = minLapTime(LEN);
// helper: a session with players 1..n on a 5 km track, clock in ms
function setup(n, cfg, random) {
  const s = createSession({ random: random || (() => 0.5) });
  let t = 1000000;
  for (let i = 1; i <= n; i++) s.addPlayer(i, 'P' + i, t);
  const h = {
    s, get t() { return t; }, wait(sec) { t += sec * 1000; s.tick(t); return h; },
    lap(id, time) { return s.lap(id, time, t); },
    snap() { return s.snapshot(); },
    player(id) { return s.snapshot().players.find(p => p.id === id); },
    // everybody does one 80 s lap (after an out lap) -> grid -> lights out
    quickQuali(times) {
      h.wait(100);
      Object.keys(times).forEach(id => assert.strictEqual(h.lap(+id, times[id]), '', 'quali lap of ' + id));
      return h;
    },
    toRace() { const g = h.snap(); assert.strictEqual(g.phase, 'grid'); t = g.goAt; s.tick(t); assert.strictEqual(s.phase, 'race'); return h; }
  };
  if (cfg) assert.strictEqual(s.start(Object.assign({ len: LEN }, cfg), t), true);
  return h;
}

test('minimum lap time is the 330 km/h average', () => {
  assert(Math.abs(MIN - 5000 / (330 / 3.6)) < 1e-9);
});

test('start: settings are clamped, needs a track length and a player', () => {
  const s = createSession();
  assert.strictEqual(s.start({ q: 3, r: 5, len: LEN }, 0), false, 'nobody connected');
  s.addPlayer(1, 'A', 0);
  assert.strictEqual(s.start({ q: 3, r: 5 }, 0), false, 'no track length');
  assert.strictEqual(s.start({ q: 3, r: 5, len: NaN }, 0), false);
  assert.strictEqual(s.start({ q: 0, r: 1000, len: LEN }, 0), true);
  let g = s.snapshot();
  assert.deepStrictEqual([g.phase, g.q, g.r, g.sid], ['quali', 1, 99, 1]);
  s.end();
  assert.strictEqual(s.start({ q: 'x', r: null, len: LEN }, 0), true);   // not numbers -> defaults
  g = s.snapshot();
  assert.deepStrictEqual([g.q, g.r, g.sid], [3, 5, 2], 'defaults 3 / 5');
  assert.strictEqual(s.start({ q: 25.4, r: 2.6, len: LEN }, 0), true);
  assert.deepStrictEqual([s.snapshot().q, s.snapshot().r], [20, 3]);
});

test('invalid laps are rejected (too fast, too soon, garbage, longer than the wall clock)', () => {
  const h = setup(1, { q: 3, r: 2 });
  h.wait(200);
  for (const bad of [NaN, Infinity, -5, 0, '80', null, undefined, 4000]) assert.strictEqual(h.lap(1, bad), 'bad', String(bad));
  assert.strictEqual(h.lap(1, MIN - 0.1), 'too-fast');
  assert.strictEqual(h.lap(1, 300), 'inconsistent', 'a 300 s lap 200 s after the start');
  assert.strictEqual(h.lap(1, 80), '');
  assert.strictEqual(h.lap(1, 80), 'too-soon', 'second lap in the same instant');
  h.wait(MIN * 0.5);
  assert.strictEqual(h.lap(1, 80), 'too-soon');
  assert.strictEqual(h.lap(99, 80), 'not-racing', 'unknown player');
  assert.strictEqual(h.player(1).qLaps, 1);
  assert.strictEqual(h.player(1).qBest, 80);
});

test('qualifying: X laps each, best counts, ends when everyone is done', () => {
  const h = setup(3, { q: 2, r: 3 });
  h.wait(150);
  assert.strictEqual(h.lap(1, 90), ''); assert.strictEqual(h.lap(2, 85), ''); assert.strictEqual(h.lap(3, 95), '');
  assert.deepStrictEqual(h.snap().order, [2, 1, 3]);
  h.wait(90);
  assert.strictEqual(h.lap(1, 84), '');
  assert.strictEqual(h.player(1).qDone, true);
  assert.strictEqual(h.lap(1, 70), 'done', 'no extra laps');
  assert.strictEqual(h.lap(2, 88), '');
  assert.strictEqual(h.snap().phase, 'quali', 'player 3 still has a lap to do');
  assert.strictEqual(h.lap(3, 86), '');
  const g = h.snap();
  assert.strictEqual(g.phase, 'grid');
  assert.deepStrictEqual(g.grid, [1, 2, 3], '84 < 85 < 86');
});

test('grid order: ties go to whoever set the time first; no-time players at the back in join order', () => {
  const h = setup(5, { q: 1, r: 3 });
  h.wait(150);
  assert.strictEqual(h.lap(4, 88), '');
  assert.strictEqual(h.lap(2, 88), '');          // same time, set later
  assert.strictEqual(h.lap(5, 91), '');
  assert.deepStrictEqual(h.snap().order, [4, 2, 5, 1, 3]);
  assert.strictEqual(h.s.skip(h.t), true);       // host forces the race
  const g = h.snap();
  assert.strictEqual(g.phase, 'grid');
  assert.deepStrictEqual(g.grid, [4, 2, 5, 1, 3]);
  assert.strictEqual(h.s.skip(h.t), false, 'skip only works in qualifying');
});

test('start lights: 5 lights one second apart, random hold 0.5-2 s, race starts at goAt', () => {
  for (const [r, hold] of [[0, 500], [1, 2000], [0.5, 1250], [7, 2000], [-3, 500]]) {
    const h = setup(2, { q: 1, r: 1 }, () => r);
    h.quickQuali({ 1: 80, 2: 81 });
    const g = h.snap();
    assert.strictEqual(g.phase, 'grid');
    assert.strictEqual(g.lightsAt, h.t + 4000);
    assert.strictEqual(g.goAt - g.lightsAt, 5000 + hold);
    assert.strictEqual(h.s.tick(g.goAt - 1), false);
    assert.strictEqual(h.s.phase, 'grid');
    assert.strictEqual(h.lap(1, 80), 'no-session', 'no laps on the grid');
    assert.strictEqual(h.s.tick(g.goAt), true);
    assert.strictEqual(h.s.phase, 'race');
  }
});

test('late join: during qualifying takes part; during grid / race / results spectates until the next session', () => {
  const h = setup(2, { q: 1, r: 2 });
  h.wait(100);
  h.s.addPlayer(3, 'Late', h.t);
  assert.strictEqual(h.player(3).spec, false);
  h.lap(1, 80); h.lap(2, 82);
  assert.strictEqual(h.snap().phase, 'quali', 'the late joiner still has to set a time');
  h.wait(100);
  assert.strictEqual(h.lap(3, 79), '');
  assert.deepStrictEqual(h.snap().grid, [3, 1, 2]);
  h.s.addPlayer(4, 'Later', h.t);                 // on the grid
  assert.strictEqual(h.player(4).spec, true);
  assert.deepStrictEqual(h.snap().grid, [3, 1, 2]);
  h.toRace();
  h.s.addPlayer(5, 'Latest', h.t);
  assert.strictEqual(h.player(5).spec, true);
  h.wait(100);
  assert.strictEqual(h.lap(5, 80), 'not-racing');
  assert.deepStrictEqual(h.snap().order, [3, 1, 2], 'spectators are not classified');
  // the race finishes without waiting for spectators
  h.lap(3, 100); h.lap(1, 100); h.lap(2, 100); h.wait(100); h.lap(3, 100); h.lap(1, 100); h.lap(2, 100);
  assert.strictEqual(h.snap().phase, 'results');
  assert.strictEqual(h.s.again(h.t), true);
  assert.strictEqual(h.snap().phase, 'quali');
  assert(h.snap().players.every(p => !p.spec), 'everybody takes part in the next session');
});

test('leave: qualifying removes the player (and can complete it); race marks DNF and keeps the row', () => {
  const h = setup(3, { q: 1, r: 2 });
  h.wait(100);
  h.lap(1, 80); h.lap(2, 81);
  assert.strictEqual(h.snap().phase, 'quali');
  h.s.removePlayer(3, h.t);                       // the only one still out leaves
  let g = h.snap();
  assert.strictEqual(g.phase, 'grid');
  assert.deepStrictEqual(g.grid, [1, 2]);
  assert.strictEqual(g.players.length, 2);
  h.s.addPlayer(4, 'X', h.t); h.s.removePlayer(4, h.t);   // a spectator comes and goes
  h.toRace(); h.wait(100);
  h.lap(1, 100);
  h.s.removePlayer(2, h.t);
  g = h.snap();
  assert.strictEqual(g.phase, 'race');
  const p2 = g.players.find(p => p.id === 2);
  assert(p2 && p2.dnf && p2.left, 'leaver stays in the classification as DNF');
  assert.deepStrictEqual(g.order, [1, 2]);
  h.wait(100); h.lap(1, 100);
  g = h.snap();
  assert.strictEqual(g.phase, 'results', 'the race ends without the leaver');
  assert.deepStrictEqual(g.order, [1, 2]);
  assert.strictEqual(h.s.lap(2, 100, h.t), 'not-racing');
  // a grid that empties goes back to free
  const k = setup(1, { q: 1, r: 1 }); k.wait(100); k.lap(1, 80);
  assert.strictEqual(k.snap().phase, 'grid');
  k.s.removePlayer(1, k.t);
  assert.strictEqual(k.snap().phase, 'free');
});

test('race: live order by progress, gaps at the line, chequered-flag rule, results', () => {
  const h = setup(3, { q: 1, r: 3 });
  h.quickQuali({ 1: 80, 2: 81, 3: 82 }).toRace();
  assert.deepStrictEqual(h.snap().order, [1, 2, 3], 'grid order before anyone moves');
  h.s.progress(1, -0.01); h.s.progress(2, -0.012); h.s.progress(3, 0.2);
  assert.deepStrictEqual(h.snap().order, [3, 1, 2], 'live order follows progress');
  h.s.progress(3, 55);                            // nonsense is clamped to "almost a lap"
  assert.deepStrictEqual(h.snap().order, [3, 1, 2]);
  h.wait(100);
  assert.strictEqual(h.lap(1, 100), '');
  h.wait(2); assert.strictEqual(h.lap(2, 102), '');
  h.wait(28); assert.strictEqual(h.lap(3, 130), '');
  let g = h.snap();
  assert.deepStrictEqual(g.order, [1, 2, 3]);
  assert(Math.abs(g.players[1].gap - 2) < 1e-9 && Math.abs(g.players[2].gap - 30) < 1e-9, JSON.stringify(g.players.map(p => p.gap)));
  h.wait(70); h.lap(1, 100); h.wait(2); h.lap(2, 100);      // t = 200 / 202
  h.wait(28); assert.strictEqual(h.lap(3, 100), '');          // t = 230
  h.wait(70); assert.strictEqual(h.lap(1, 100), '');          // t = 300: the leader has done 3 laps
  g = h.snap();
  assert.strictEqual(g.phase, 'race');
  assert(g.winnerAt > 0 && g.endsAt === g.winnerAt + RACE_TIMEOUT_MS);
  assert.strictEqual(g.players[0].fin, true);
  assert.strictEqual(h.lap(1, 100), 'done');
  h.wait(4); assert.strictEqual(h.lap(2, 192), 'inconsistent');
  assert.strictEqual(h.lap(2, 102), '');                      // t = 304
  assert.strictEqual(h.snap().phase, 'race', 'player 3 is still out');
  h.wait(26); assert.strictEqual(h.lap(3, 100), '');          // t = 330
  g = h.snap();
  assert.strictEqual(g.phase, 'results');
  assert.deepStrictEqual(g.order, [1, 2, 3]);
  assert.deepStrictEqual(g.players.map(p => [p.rLaps, Math.round(p.rTime)]), [[3, 300], [3, 304], [3, 330]]);
  assert(Math.abs(g.players[1].gap - 4) < 1e-6 && Math.abs(g.players[2].gap - 30) < 1e-6);
  assert.strictEqual(g.players[0].rBest, 100);
});

test('chequered flag: a lapped car finishes at its next crossing with fewer laps, behind cars on the lead lap', () => {
  const h = setup(3, { q: 1, r: 2 });
  h.quickQuali({ 1: 80, 2: 81, 3: 82 }).toRace();
  h.wait(60); h.lap(1, 60);                       // t=60   P1 lap 1
  h.wait(30); h.lap(2, 90);                       // t=90   P2 lap 1
  h.wait(28); h.lap(3, 118);                      // t=118  P3 lap 1
  h.wait(2); assert.strictEqual(h.lap(1, 60), ''); // t=120 P1 finishes 2 laps
  let g = h.snap();
  assert.strictEqual(g.phase, 'race');
  h.s.progress(2, 1.5); h.s.progress(3, 1.1);
  assert.deepStrictEqual(h.snap().order, [1, 2, 3]);
  h.wait(60); assert.strictEqual(h.lap(2, 90), ''); // t=180 P2 finishes 2 laps
  h.wait(20); assert.strictEqual(h.lap(3, 82), ''); // t=200 P3 finishes 2 laps (inside the 90 s window)
  g = h.snap();
  assert.strictEqual(g.phase, 'results');
  assert.deepStrictEqual(g.order, [1, 2, 3]);
  assert.deepStrictEqual(g.players.map(p => p.rLaps), [2, 2, 2]);
  assert(Math.abs(g.players[1].gap - 60) < 1e-6 && Math.abs(g.players[2].gap - 80) < 1e-6);

  // now with a car a full lap down: it is flagged after 1 lap
  const k = setup(2, { q: 1, r: 2 });
  k.quickQuali({ 1: 80, 2: 81 }).toRace();
  k.wait(60); k.lap(1, 60);
  k.wait(60); k.lap(1, 60);                       // winner at t=120, P2 has not completed a lap
  k.s.progress(2, 0.9);
  let s2 = k.snap();
  assert.strictEqual(s2.players[1].down, 1, 'shown as one lap down');
  k.wait(10); assert.strictEqual(k.lap(2, 130), '');
  s2 = k.snap();
  assert.strictEqual(s2.phase, 'results');
  assert.deepStrictEqual([s2.players[1].fin, s2.players[1].rLaps, s2.players[1].down], [true, 1, 1]);
});

test('race timeout: 90 s after the winner the race is over for everybody', () => {
  const h = setup(2, { q: 1, r: 1 });
  h.quickQuali({ 1: 80, 2: 81 }).toRace();
  h.wait(60); h.lap(1, 60);
  const g = h.snap();
  assert.strictEqual(g.phase, 'race');
  assert.strictEqual(h.s.tick(g.endsAt - 1), false);
  assert.strictEqual(h.s.tick(g.endsAt), true);
  const r = h.snap();
  assert.strictEqual(r.phase, 'results');
  assert.deepStrictEqual(r.order, [1, 2]);
  assert.deepStrictEqual([r.players[1].fin, r.players[1].dnf], [false, false], 'not finished, but still classified');
  assert.strictEqual(h.s.lap(2, 100, h.t + 200000), 'no-session');
});

test('host controls: end during the race -> results; end elsewhere -> free; again; total time falls back to the server clock', () => {
  const h = setup(2, { q: 1, r: 5 });
  h.quickQuali({ 1: 80, 2: 81 }).toRace();
  h.wait(100); h.lap(1, 60);                      // claims 60 s but 100 s passed -> server time is used
  assert(Math.abs(h.player(1).rTime - 100) < 1e-6, String(h.player(1).rTime));
  assert.strictEqual(h.s.end(), true);
  assert.strictEqual(h.snap().phase, 'results');
  assert.deepStrictEqual(h.snap().order, [1, 2]);
  assert.strictEqual(h.s.again(h.t), true);
  const g = h.snap();
  assert.deepStrictEqual([g.phase, g.q, g.r, g.sid], ['quali', 1, 5, 2]);
  assert(g.players.every(p => p.qLaps === 0 && p.qBest === null && p.rLaps === 0));
  assert.strictEqual(h.s.end(), true);
  assert.strictEqual(h.snap().phase, 'free');
  assert.strictEqual(h.s.end(), false);
  assert.strictEqual(h.s.again(h.t), false);
  assert.strictEqual(h.s.skip(h.t), false);
});

test('single player: the whole Grand Prix alone', () => {
  const h = setup(1, { q: 2, r: 2 });
  h.wait(150); assert.strictEqual(h.lap(1, 75), '');
  h.wait(80); assert.strictEqual(h.lap(1, 74), '');
  assert.deepStrictEqual(h.snap().grid, [1]);
  h.toRace();
  h.wait(80); h.lap(1, 80); h.wait(76); h.lap(1, 76);
  const g = h.snap();
  assert.strictEqual(g.phase, 'results');
  assert(Math.abs(g.players[0].rTime - 156) < 1e-6 && g.players[0].rBest === 76 && g.players[0].qBest === 74);
  JSON.stringify(g);
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall session tests passed');
process.exit(failed ? 1 : 0);
