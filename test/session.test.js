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

/* ---------- edge cases found in the review of the rules ---------- */

test('lap validation is cumulative: a report delayed on the network does not cost the NEXT lap', () => {
  const h = setup(1, { q: 1, r: 3 });
  h.quickQuali({ 1: 80 }).toRace();
  // lap 1 really took 100 s but its report arrives 3.5 s late
  h.wait(103.5); assert.strictEqual(h.lap(1, 100), '');
  // lap 2 took 100 s too and is reported on time: only 96.6 s after the previous REPORT
  h.wait(96.6); assert.strictEqual(h.lap(1, 100), '', '100 s lap, 96.6 s after a delayed report');
  assert.strictEqual(h.player(1).rLaps, 2);
  // ...but the laps of a phase still cannot add up to more than the phase has lasted (+ 2 s)
  h.wait(60); assert.strictEqual(h.lap(1, 63), 'inconsistent', '263 s of laps in 260.1 s');
  assert.strictEqual(h.lap(1, 61.5), '', '261.5 s of laps in 260.1 s: inside the slack');
  assert.strictEqual(h.snap().phase, 'results');
});

test('lap validation anchors: race laps are timed from goAt, qualifying laps from the session start / the join', () => {
  const h = setup(2, { q: 2, r: 2 });
  // somebody who sat in the menu for ten minutes and then drives a lap is fine
  h.wait(600); assert.strictEqual(h.lap(1, 75), '');
  assert.strictEqual(h.lap(2, 601.5), '', 'a lap as long as the session so far (+ slack)');
  assert.strictEqual(h.player(2).qBest, 601.5);
  // a late joiner cannot have driven a lap longer than the time since they joined
  h.s.addPlayer(3, 'Late', h.t);
  h.wait(70);
  assert.strictEqual(h.lap(3, 90), 'inconsistent');
  assert.strictEqual(h.lap(3, 69), '');
  h.wait(60); h.lap(1, 60); h.lap(2, 60); h.wait(10); assert.strictEqual(h.lap(3, 70), '');
  assert.strictEqual(h.snap().phase, 'grid');
  // on the grid the lap clock is reset to goAt, whatever happened before
  const g = h.snap();
  assert.strictEqual(h.s.lap(1, 60, g.goAt - 1), 'no-session', 'before lights out');
  h.toRace();
  assert.strictEqual(h.s.lap(1, 60, g.goAt + 40000), 'too-soon', '40 s after lights out');
  assert.strictEqual(h.s.lap(1, 63, g.goAt + 60000), 'inconsistent', 'a 63 s lap 60 s after lights out');
  assert.strictEqual(h.s.lap(1, 61.9, g.goAt + 60000), '', 'clock skew / slack of 2 s');
  assert.strictEqual(h.s.lap(1, NaN, g.goAt + 120000), 'bad');
  assert.strictEqual(h.s.lap(1, 60, NaN), 'bad', 'a broken clock rejects rather than accepts');
});

test('race time: own lap times within 1 s of the session clock, else the session clock (no gain from pausing)', () => {
  const h = setup(3, { q: 1, r: 2 });
  h.quickQuali({ 1: 80, 2: 81, 3: 82 }).toRace();
  h.wait(100.4); assert.strictEqual(h.lap(1, 100), '');                 // 0.4 s of latency: own time stands
  assert.strictEqual(h.player(1).rTime, 100);
  h.wait(2.6); assert.strictEqual(h.lap(2, 100), '');                   // clock stopped for 3 s (menu): t = 103
  assert.strictEqual(h.player(2).rTime, 103, 'the session clock, not the paused lap timer');
  assert.strictEqual(h.lap(3, 102.2), '');                              // 0.8 s: still the own time
  assert.strictEqual(h.player(3).rTime, 102.2);
  assert.deepStrictEqual(h.snap().players.map(p => p.gap), [null, 3, 2.2]);
  // finish: 1 arrives first, 3 a moment later but with the smaller own total (it had the longer latency)
  h.wait(97.4); assert.strictEqual(h.lap(1, 100.3), '');                // t = 200.4, own total 200.3
  h.wait(0.2); assert.strictEqual(h.lap(3, 98), '');                    // t = 200.6, own total 200.2
  h.wait(9.4); assert.strictEqual(h.lap(2, 100), '');                   // t = 210, own total 203 + 100: session clock 210
  const g = h.snap();
  assert.strictEqual(g.phase, 'results');
  assert.deepStrictEqual(g.order, [3, 1, 2], 'classified by race time, not by arrival');
  assert.deepStrictEqual(g.players.map(p => p.rTime), [200.3, 210, 200.2]);
  assert.deepStrictEqual(g.players.map(p => p.gap), [0.1, 9.8, null]);
});

test('race ties: equal race times go to whoever took the flag first; lap times are kept to the millisecond', () => {
  const h = setup(3, { q: 1, r: 1 });
  h.wait(100);
  assert.strictEqual(h.lap(1, 80.12349), ''); assert.strictEqual(h.lap(2, 80.1235), ''); assert.strictEqual(h.lap(3, 80.12351), '');
  assert.deepStrictEqual(h.snap().players.map(p => p.qBest), [80.123, 80.124, 80.124]);
  assert.deepStrictEqual(h.snap().grid, [1, 2, 3]);
  h.toRace();
  h.wait(90); h.lap(3, 90.0004); h.lap(2, 89.9996);                     // both 90.000: 3 crossed first
  h.wait(0.2); h.lap(1, 90.2000001);
  const g = h.snap();
  assert.strictEqual(g.phase, 'results');
  assert.deepStrictEqual(g.order, [3, 2, 1]);
  assert.deepStrictEqual(g.players.map(p => [p.rTime, p.rBest, p.gap]), [[90.2, 90.2, 0.2], [90, 90, 0], [90, 90, null]]);
  assert(JSON.stringify(g).length < 900, 'no long float tails in the snapshot: ' + JSON.stringify(g).length);
});

test('classification at the timeout: finishers, flagged lapped cars, non-finishers by distance, DNF last', () => {
  const h = setup(4, { q: 1, r: 3 });
  h.quickQuali({ 1: 80, 2: 81, 3: 82, 4: 83 }).toRace();
  h.wait(60); h.lap(1, 60);                       // t = 60
  h.wait(2); h.lap(4, 62);                        // t = 62
  h.wait(8); h.lap(3, 70);                        // t = 70
  h.wait(30); h.lap(2, 100);                      // t = 100
  h.wait(20); h.lap(1, 60);                       // t = 120
  h.wait(4); h.lap(4, 62);                        // t = 124
  h.wait(16); h.lap(3, 70);                       // t = 140
  h.s.progress(4, 2.9);
  h.wait(30); h.s.removePlayer(4, h.t);           // t = 170: the car with the second most distance leaves
  h.wait(10); assert.strictEqual(h.lap(1, 60), ''); // t = 180: winner
  let g = h.snap();
  assert.deepStrictEqual([g.phase, g.winnerAt, g.endsAt], ['race', h.t, h.t + RACE_TIMEOUT_MS]);
  h.wait(20); assert.strictEqual(h.lap(2, 100), ''); // t = 200: lapped car takes the flag after 2 laps
  h.s.progress(3, 2.5);                           // on the lead lap, but never makes it to the line
  assert.strictEqual(h.snap().phase, 'race');
  h.wait(70);                                     // t = 270: 90 s after the winner
  g = h.snap();
  assert.strictEqual(g.phase, 'results');
  assert.deepStrictEqual(g.order, [1, 3, 2, 4], 'winner; 3 laps in progress; flagged with 2 laps; DNF');
  const by = {}; g.players.forEach(p => { by[p.id] = p; });
  assert.deepStrictEqual([by[1].fin, by[1].rLaps, by[1].rTime, by[1].down, by[1].gap], [true, 3, 180, 0, null]);
  assert.deepStrictEqual([by[3].fin, by[3].dnf, by[3].rLaps, by[3].down, by[3].gap], [false, false, 2, 0, 20]);
  assert.deepStrictEqual([by[2].fin, by[2].rLaps, by[2].rTime, by[2].down, by[2].gap], [true, 2, 200, 1, null]);
  assert.deepStrictEqual([by[4].fin, by[4].dnf, by[4].left, by[4].rLaps, by[4].down, by[4].gap], [false, true, true, 2, 0, null]);
  assert.strictEqual(h.s.lap(3, 130, h.t), 'no-session', 'too late');
});

test('leaving during the results does not touch the classification', () => {
  const h = setup(3, { q: 1, r: 1 });
  h.quickQuali({ 1: 80, 2: 81, 3: 82 }).toRace();
  h.wait(60); h.lap(1, 60);
  h.s.progress(2, 0.9); h.s.progress(3, 0.5);
  h.wait(90);                                     // timeout: 2 and 3 did not finish
  const before = h.snap();
  assert.strictEqual(before.phase, 'results');
  assert.deepStrictEqual(before.order, [1, 2, 3]);
  assert.strictEqual(h.s.removePlayer(2, h.t), true);
  const after = h.snap();
  assert.deepStrictEqual(after.order, [1, 2, 3], 'a non-finisher who leaves afterwards is not demoted to DNF');
  assert.deepStrictEqual(after.players.map(p => [p.id, p.left, p.dnf, p.fin]), [[1, false, false, true], [2, true, false, false], [3, false, false, false]]);
  assert.strictEqual(h.s.removePlayer(1, h.t), true);
  assert.deepStrictEqual(h.snap().players.map(p => [p.left, p.dnf]), [[true, false], [true, false], [false, false]]);
  assert.strictEqual(h.snap().phase, 'results');
  h.s.removePlayer(3, h.t);
  assert.strictEqual(h.snap().phase, 'free', 'nobody left: the session is over');
  assert.strictEqual(h.snap().players.length, 0);
});

test('a session never gets stuck: everybody / every driver leaving in each phase', () => {
  // qualifying
  let h = setup(2, { q: 1, r: 1 });
  h.s.removePlayer(1, h.t); assert.strictEqual(h.s.phase, 'quali');
  h.s.removePlayer(2, h.t); assert.strictEqual(h.s.phase, 'free');
  assert.strictEqual(h.s.start({ q: 1, r: 1, len: LEN }, h.t), false, 'nobody to race');
  h.s.addPlayer(3, 'New', h.t);
  assert.strictEqual(h.s.start({ q: 1, r: 1, len: LEN }, h.t), true);
  assert.deepStrictEqual([h.s.phase, h.s.sid, h.snap().players.length], ['quali', 2, 1]);

  // grid: the drivers leave, a spectator stays -> free practice, and the spectator is a normal player again
  h = setup(2, { q: 1, r: 1 });
  h.quickQuali({ 1: 80, 2: 81 });
  h.s.addPlayer(3, 'Spec', h.t);
  h.s.removePlayer(1, h.t);
  assert.deepStrictEqual([h.s.phase, h.snap().grid], ['grid', [2]]);
  h.s.removePlayer(2, h.t);
  assert.deepStrictEqual([h.s.phase, h.snap().players.map(p => [p.id, p.spec])], ['free', [[3, false]]]);
  assert.strictEqual(h.s.tick(h.t + 60000), false, 'no lights for nobody');

  // race: every driver leaves (one of them after finishing), spectators stay
  h = setup(2, { q: 1, r: 1 });
  h.quickQuali({ 1: 80, 2: 81 }).toRace();
  h.s.addPlayer(3, 'Spec', h.t);
  h.wait(60); h.lap(1, 60);
  h.s.removePlayer(1, h.t);                       // the winner goes home
  let g = h.snap();
  assert.strictEqual(g.phase, 'race', 'player 2 is still racing');
  assert.deepStrictEqual(g.players.map(p => [p.id, p.left, p.dnf, p.fin]), [[1, true, false, true], [2, false, false, false], [3, false, false, false]]);
  h.s.removePlayer(3, h.t);                       // a spectator leaving changes nothing
  assert.deepStrictEqual([h.s.phase, h.snap().players.length], ['race', 2]);
  h.s.addPlayer(4, 'Spec2', h.t);
  h.s.removePlayer(2, h.t);
  assert.deepStrictEqual([h.s.phase, h.snap().players.map(p => [p.id, p.spec])], ['free', [[4, false]]]);

  // race: the last driver on track leaves after the others finished -> results, not a hung race
  h = setup(2, { q: 1, r: 1 });
  h.quickQuali({ 1: 80, 2: 81 }).toRace();
  h.wait(60); h.lap(1, 60);
  h.s.removePlayer(2, h.t);
  g = h.snap();
  assert.deepStrictEqual([g.phase, g.order, g.players[1].dnf], ['results', [1, 2], true]);

  // results: only a spectator is left -> the results stay until somebody decides; "again" makes them a driver
  h = setup(1, { q: 1, r: 1 });
  h.quickQuali({ 1: 80 }).toRace();
  h.s.addPlayer(2, 'Spec', h.t);
  h.wait(60); h.lap(1, 60);
  assert.strictEqual(h.s.phase, 'results');
  h.s.removePlayer(1, h.t);
  assert.strictEqual(h.s.phase, 'results');
  assert.strictEqual(h.s.again(h.t), true);
  g = h.snap();
  assert.deepStrictEqual([g.phase, g.sid, g.players.map(p => [p.id, p.spec, p.left])], ['quali', 2, [[2, false, false]]]);

  // a race nobody finishes has no timeout: the host ends it
  h = setup(2, { q: 1, r: 1 });
  h.quickQuali({ 1: 80, 2: 81 }).toRace();
  h.wait(100000);
  assert.strictEqual(h.s.phase, 'race');
  assert.strictEqual(h.s.end(), true);
  assert.deepStrictEqual([h.s.phase, h.snap().order], ['results', [1, 2]]);
});

test('calls without a usable clock are refused or harmless (never a grid whose lights cannot go out)', () => {
  const h = setup(2, { q: 1, r: 1 });
  h.wait(100);
  for (const bad of [NaN, undefined, null, '5', Infinity]) assert.strictEqual(h.s.skip(bad), false, 'skip ' + String(bad));
  assert.strictEqual(h.s.phase, 'quali');
  assert.strictEqual(h.lap(1, 80), '');
  h.s.removePlayer(2, NaN);                         // the last driver still out leaves, and the caller has no clock
  let g = h.snap();
  assert.strictEqual(g.phase, 'grid');
  assert(Number.isFinite(g.lightsAt) && Number.isFinite(g.goAt) && g.goAt > g.lightsAt, JSON.stringify([g.lightsAt, g.goAt]));
  assert.strictEqual(h.s.tick(NaN), false);
  assert.strictEqual(h.s.tick(h.t), true, 'lights out as soon as a real clock comes by');
  h.wait(60); assert.strictEqual(h.lap(1, 60), '');
  assert.strictEqual(h.s.phase, 'results');
  for (const bad of [NaN, undefined, null, '5']) assert.strictEqual(h.s.again(bad), false, 'again ' + String(bad));
  assert.strictEqual(h.s.again(h.t), true);
});

test('start lights never hang on a broken random generator', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, 'x', null]) {
    const h = setup(1, { q: 1, r: 1 }, () => bad);
    h.quickQuali({ 1: 80 });
    const g = h.snap();
    assert(Number.isFinite(g.goAt) && g.goAt - g.lightsAt >= 5500 && g.goAt - g.lightsAt <= 7000, String(bad) + ': ' + (g.goAt - g.lightsAt));
    assert.strictEqual(h.s.tick(g.goAt), true);
  }
});

test('live order before anybody reports progress is the grid; a silent car is not shown a lap down; gaps are never negative', () => {
  const h = setup(3, { q: 1, r: 3 });
  h.quickQuali({ 1: 82, 2: 80, 3: 81 }).toRace();
  assert.deepStrictEqual(h.snap().order, [2, 3, 1], 'grid order');
  h.s.progress(2, 0.4); h.s.progress(3, 0.3);     // player 1 sends no progress (old client / menu open)
  let g = h.snap();
  assert.deepStrictEqual(g.order, [2, 3, 1]);
  assert.deepStrictEqual(g.players.map(p => p.down), [0, 0, 0], 'not "+1 lap" for a car that is on the grid');
  h.wait(100); h.lap(3, 100); h.wait(1); h.lap(2, 101); h.lap(1, 101);
  h.s.progress(2, 1.5); h.s.progress(3, 1.2);     // 2 got back past 3 after the line
  g = h.snap();
  assert.deepStrictEqual(g.order, [2, 3, 1]);
  assert.deepStrictEqual(g.players.map(p => p.gap), [0, null, 0], 'the car that crossed first but is behind now: 0, not -1');
  // three cars level on distance (they crossed the line, no newer progress yet): in the order they crossed it
  const k = setup(3, { q: 1, r: 3 });
  k.quickQuali({ 1: 80, 2: 81, 3: 82 }).toRace();
  k.wait(100); k.lap(3, 99.5); k.lap(1, 99.8); k.lap(2, 99.6);
  assert.deepStrictEqual(k.snap().order, [3, 2, 1], 'not the grid order');
  assert.deepStrictEqual(k.snap().players.map(p => p.gap), [0.3, 0.1, null]);
  // progress is only ever a number inside the lap being driven
  for (const bad of [NaN, Infinity, -Infinity, '2', null, undefined, {}, 1e308, -1e308]) h.s.progress(3, bad);
  g = h.snap();
  assert.deepStrictEqual(g.order.slice().sort(), [1, 2, 3]);
  assert(g.players.every(p => p.down === 0 || p.down === 1), JSON.stringify(g.players.map(p => p.down)));
  h.s.progress(3, 1e308);
  assert.deepStrictEqual(h.snap().order, [3, 2, 1], '1e308 laps counts as "almost at the line", no more');
  h.s.progress(99, 1); h.s.progress(undefined, 1);   // unknown players are ignored
});

test('solid(): who may touch whom (the server side of the ghost rule)', () => {
  const h = setup(2);
  assert.strictEqual(h.s.solid(1, 2, h.t), true, 'free practice');
  assert.strictEqual(h.s.start({ q: 1, r: 1, len: LEN }, h.t), true);
  assert.strictEqual(h.s.solid(1, 2, h.t), false, 'qualifying: everybody is a ghost');
  h.quickQuali({ 1: 80, 2: 81 });
  const g = h.snap();
  h.s.addPlayer(3, 'Spec', h.t);
  assert.strictEqual(h.s.solid(1, 2, g.lightsAt - 1), false, 'grid being formed');
  assert.strictEqual(h.s.solid(1, 2, g.lightsAt), true, 'lights on: the cars are in place');
  assert.strictEqual(h.s.solid(1, 2, NaN), false);
  h.toRace();
  assert.strictEqual(h.s.solid(1, 2, h.t), true);
  assert.strictEqual(h.s.solid(1, 3, h.t), false, 'spectator');
  assert.strictEqual(h.s.solid(3, 2, h.t), false);
  assert.strictEqual(h.s.solid(1, 99, h.t), false, 'unknown');
  h.s.removePlayer(2, h.t);
  assert.strictEqual(h.s.solid(1, 2, h.t), false, 'left');
  h.wait(60); h.lap(1, 60);
  assert.strictEqual(h.s.phase, 'results');
  h.s.end();
  assert.strictEqual(h.s.solid(1, 3, h.t), true, 'free practice again');
});

test('ids and names: a returning id is a new spectator next to its DNF row; odd input never throws', () => {
  const h = setup(2, { q: 1, r: 2 });
  h.quickQuali({ 1: 80, 2: 81 }).toRace();
  h.s.removePlayer(2, h.t);
  assert.strictEqual(h.s.addPlayer(2, 'Back', h.t), true);
  assert.strictEqual(h.s.addPlayer(2, 'Twice', h.t), false, 'already present');
  let g = h.snap();
  assert.deepStrictEqual(g.players.map(p => [p.id, p.left, p.spec, p.dnf]), [[1, false, false, false], [2, true, false, true], [2, false, true, false]]);
  assert.deepStrictEqual(g.order, [1, 2]);
  assert.strictEqual(h.lap(2, 100), 'not-racing');
  assert.strictEqual(h.s.rename(2, 'Renamed'), true);
  assert.deepStrictEqual(h.snap().players.map(p => p.name), ['P1', 'P2', 'Renamed'], 'the DNF row keeps the name it raced under');
  assert.strictEqual(h.s.rename(2, 'Renamed'), false);
  assert.strictEqual(h.s.rename(77, 'x'), false);
  assert.strictEqual(h.s.removePlayer(77, h.t), false);
  for (const bad of [undefined, null, 'x', '8', NaN, Infinity, {}, [8]]) assert.strictEqual(h.s.addPlayer(bad, 'x', h.t), false, 'ids are finite numbers');
  h.s.addPlayer(5, null, h.t); h.s.addPlayer(6, undefined, h.t); h.s.addPlayer(7, 12345, h.t);
  assert.deepStrictEqual(h.snap().players.slice(3).map(p => p.name), ['', '', '12345']);
  // restart from the middle of a race: leavers are gone, everybody present takes part, new session id
  assert.strictEqual(h.s.start({ q: 20, r: 99, len: 200 }, h.t), true);
  g = h.snap();
  assert.deepStrictEqual([g.phase, g.sid, g.q, g.r, g.len], ['quali', 2, 20, 99, 200]);
  assert.deepStrictEqual(g.players.map(p => [p.id, p.spec, p.left, p.rLaps, p.dnf]), [1, 2, 5, 6, 7].map(id => [id, false, false, 0, false]));
  for (const cfg of [null, undefined, 5, 'x', {}, { len: 199.9 }, { len: 100001 }, { len: '5000' }, { len: Infinity }, { len: -1 }]) {
    assert.strictEqual(h.s.start(cfg, h.t), false, JSON.stringify(cfg));
  }
  assert.strictEqual(h.s.start({ len: LEN }, NaN), false, 'no clock');
  assert.strictEqual(h.s.sid, 2, 'a refused start changes nothing');
});

/* ---------- v6: the season year and the tyre wear of a Grand Prix ---------- */

test('year / wear: none / 1 before the first start; carried in the snapshot; kept by every phase, again and end', () => {
  const s = createSession({ random: () => 0 });
  assert.deepStrictEqual([s.snapshot().year, s.snapshot().wear], [null, 1], 'a fresh session');
  s.addPlayer(1, 'A', 0);
  assert.strictEqual(s.start({ q: 1, r: 1, len: LEN, year: 2024, wear: 3 }, 0), true);
  let g = s.snapshot();
  assert.deepStrictEqual([g.phase, g.year, g.wear], ['quali', 2024, 3]);
  const at = t => [s.phase, s.snapshot().year, s.snapshot().wear, t];
  s.lap(1, 80, 100000);
  assert.deepStrictEqual(at('grid'), ['grid', 2024, 3, 'grid']);
  s.tick(s.snapshot().goAt);
  assert.deepStrictEqual(at('race'), ['race', 2024, 3, 'race']);
  s.lap(1, 80, s.snapshot().goAt + 80000);
  assert.deepStrictEqual(at('results'), ['results', 2024, 3, 'results']);
  assert.strictEqual(s.again(s.snapshot().goAt + 90000), true);
  g = s.snapshot();
  assert.deepStrictEqual([g.phase, g.sid, g.year, g.wear], ['quali', 2, 2024, 3], 'again: same year and wear');
  s.end();
  g = s.snapshot();
  assert.deepStrictEqual([g.phase, g.year, g.wear], ['free', 2024, 3], 'free keeps those of the last session, like q / r');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), g);
  // a refused start changes nothing
  assert.strictEqual(s.start({ q: 1, r: 1, year: 2011, wear: 5 }, 0), false, 'no track length');
  assert.strictEqual(s.start({ q: 1, r: 1, len: LEN, year: 2011, wear: 5 }, NaN), false, 'no clock');
  assert.deepStrictEqual([s.snapshot().year, s.snapshot().wear, s.sid], [2024, 3, 2]);
  // a new start replaces both; left out -> none / 1
  assert.strictEqual(s.start({ q: 1, r: 1, len: LEN }, 0), true);
  assert.deepStrictEqual([s.snapshot().year, s.snapshot().wear], [null, 1]);
});

test('year / wear validation: a year is a whole 2010..2100 or null (never clamped); wear is clamped to 1..5', () => {
  const s = createSession();
  s.addPlayer(1, 'A', 0);
  const yearOf = y => { assert.strictEqual(s.start({ len: LEN, year: y }, 0), true, 'a bad year never blocks a start: ' + String(y)); return s.snapshot().year; };
  for (const y of [2010, 2024, 2026, 2100]) assert.strictEqual(yearOf(y), y);
  for (const y of [2009, 2101, 1999, 0, -2024, 2024.5, 2024.0000001, '2024', NaN, Infinity, -Infinity, null, undefined, {}, [2024], true,
    { valueOf: () => 2024 }, 1e308]) {
    assert.strictEqual(yearOf(y), null, JSON.stringify(y) + ' / ' + String(y));
  }
  const wearOf = w => { assert.strictEqual(s.start({ len: LEN, wear: w }, 0), true, String(w)); return s.snapshot().wear; };
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(wearOf), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual([0, -3, 6, 99, 1e308, 2.4, 2.6, 4.5].map(wearOf), [1, 1, 5, 5, 5, 2, 3, 5], 'clamped and rounded like q / r');
  assert.deepStrictEqual(['3', NaN, Infinity, -Infinity, null, undefined, {}, [3], true].map(wearOf), [1, 1, 1, 1, 1, 1, 1, 1, 1], 'not a number: the default');
  assert(JSON.stringify(s.snapshot()).indexOf('"year":null,"wear":1') > 0, 'plain JSON values');
});

test('snapshot of a full room (16 drivers, 16-character names) stays small and plain', () => {
  const s = createSession({ random: () => 0 });
  let t = 5000000;
  for (let i = 1; i <= 16; i++) s.addPlayer(i, '十六個字的超級長名字車手' + String(i).padStart(4, '0'), t);
  s.start({ q: 1, r: 99, len: LEN, year: 2026, wear: 5 }, t);
  t += 100000;
  for (let i = 1; i <= 16; i++) assert.strictEqual(s.lap(i, 80 + i * 0.123, t), '');
  t = s.snapshot().goAt; s.tick(t);
  for (let lap = 1; lap <= 12; lap++) {
    t += 83456.789;
    for (let i = 1; i <= 16; i++) { assert.strictEqual(s.lap(i, 83.456 + i * 0.0001, t + i), ''); s.progress(i, lap + 0.3 - i * 0.01); }
  }
  const g = s.snapshot();
  const bytes = Buffer.byteLength(JSON.stringify(g));
  assert(bytes < 4200, 'snapshot bytes: ' + bytes);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), g, 'JSON round trip loses nothing (no NaN / undefined)');
  assert.strictEqual(g.players.length, 16);
});

/* ---------- review 1: laps and progress backed by driving, race time from the crossing ---------- */

test('proof of driving: a lap needs 85 % of the track covered and positions over 3/4 of its time (forged-laps)', () => {
  const { LAP_DIST, LAP_LIVE } = require('../net/session.js');
  assert.deepStrictEqual([LAP_DIST, LAP_LIVE], [0.85, 0.75]);
  const h = setup(2, { q: 2, r: 1 });
  h.wait(100);
  const lap = (id, time, proof) => h.s.lap(id, time, h.t, proof);
  // a parked client that only reports laps (the verifier's cheater): nothing driven, nothing counted
  assert.strictEqual(lap(2, MIN + 0.001, { dist: 0, live: 0 }), 'not-driven');
  assert.strictEqual(lap(2, 80, { dist: LEN * 0.85 - 0.01, live: 80 }), 'not-driven', 'just short of 85 %');
  for (const bad of [{}, { live: 80 }, { dist: NaN, live: 80 }, { dist: '5000', live: 80 }, { dist: Infinity, live: 80 }, 5, 'x', true]) {
    assert.strictEqual(lap(2, 80, bad), 'not-driven', 'a missing / broken distance counts as none: ' + JSON.stringify(bad));
  }
  assert.strictEqual(lap(2, 80, { dist: LEN, live: 59.9 }), 'no-data', 'positions for less than 3/4 of the lap');
  assert.strictEqual(lap(2, 80, { dist: LEN, live: NaN }), 'no-data');
  // the checks come after the time checks: the reason a client sees does not change for a lap that is wrong anyway
  assert.strictEqual(lap(2, MIN - 1, { dist: 0, live: 0 }), 'too-fast');
  assert.strictEqual(lap(2, 103, { dist: 0, live: 0 }), 'inconsistent');
  assert.strictEqual(h.player(2).qLaps, 0, 'none of it counted');
  // the racing line / the pit lane are shorter than the centreline: 85 % is enough; without proof (alone) no check
  assert.strictEqual(lap(2, 80, { dist: LEN * 0.85, live: 60 }), '');
  assert.strictEqual(lap(1, 80), '', 'the single-player game passes no proof');
  assert.strictEqual(h.player(2).qLaps, 1);
  // the race too
  h.wait(100); lap(1, 90); lap(2, 90, { dist: LEN, live: 90 });
  h.toRace(); h.wait(90);
  assert.strictEqual(lap(2, 88, { dist: 10, live: 88 }), 'not-driven');
  assert.strictEqual(h.player(2).rLaps, 0);
  assert.strictEqual(lap(2, 88, { dist: LEN + 60, live: 88 }), '', 'first lap: from the grid slot behind the line');
  assert.strictEqual(h.snap().winnerAt > 0, true);
});

test('progress backed by driving: the fraction ahead of the laps counted is held to dist / (0.85 * len) (progress-cheat)', () => {
  const h = setup(3, { q: 1, r: 3 });
  h.quickQuali({ 1: 80, 2: 81, 3: 82 }).toRace();
  // 3 is parked and claims to be almost a lap ahead; 1 drove 1500 m and says 0.3 of a lap (1500 m of 5000)
  h.s.progress(3, 0.99, 0); h.s.progress(1, 0.3, 1500); h.s.progress(2, 0.2, 1000);
  assert.deepStrictEqual(h.snap().order, [1, 2, 3], 'the parked car is last on the road, not first');
  h.s.progress(3, 0.99, 425);                                   // 425 m of path: at most 0.1 of a lap
  assert.deepStrictEqual(h.snap().order, [1, 2, 3]);
  h.s.progress(3, 0.99, 1275);                                  // 0.3 of a lap: level with 1 -> grid order
  assert.deepStrictEqual(h.snap().order, [1, 3, 2]);
  h.s.progress(3, 0.35, 3000);                                  // an honest claim is taken as it is
  assert.deepStrictEqual(h.snap().order, [3, 1, 2]);
  h.s.progress(3, 55, 1e9);                                     // never more than "almost a lap" (as before)
  h.wait(100); assert.strictEqual(h.lap(1, 100), '');
  assert.deepStrictEqual(h.snap().order, [1, 3, 2], 'a counted lap beats any progress');
  for (const bad of [NaN, '1', null, undefined, {}, -5]) h.s.progress(2, 0.5, bad);   // odd distances: unchecked / none
  assert(h.snap().order.length === 3);
  h.s.progress(2, 0.6, -5);
  assert.deepStrictEqual(h.snap().order, [1, 3, 2], 'a negative distance is none');
});

test('race time from the moment of the crossing: a late report costs nothing, a pause still does (rtime-latency)', () => {
  // the verifier's case: A crosses 0.4 s before B; A's flag report is delayed 1.2 s
  const race = () => {
    const s = createSession({ random: () => 0.5 });
    [1, 2].forEach(id => s.addPlayer(id, 'p' + id, 0));
    s.start({ q: 1, r: 2, len: 1000 }, 0); s.skip(0);
    const go = s.snapshot().goAt; s.tick(go);
    return { s, go };
  };
  const P = at => ({ at, dist: 1000, live: 100 });              // (driven: the server always sends all three)
  let { s, go } = race();
  s.lap(1, 30.0, go + 30050, P(go + 30000)); s.lap(2, 30.2, go + 30250, P(go + 30200));
  s.lap(2, 30.2, go + 60450, P(go + 60400));
  s.lap(1, 30.0, go + 61200, P(go + 60000));
  let g = s.snapshot();
  assert.deepStrictEqual(g.players.map(p => p.rTime), [60, 60.4], 'the laps, not the arrival');
  assert.deepStrictEqual(g.order, [1, 2], 'as on the road');
  assert.deepStrictEqual(g.players.map(p => p.gap), [null, 0.4]);
  // the same without `at` (an older client): the arrival, as before
  ({ s, go } = race());
  s.lap(1, 30.0, go + 30050); s.lap(2, 30.2, go + 30250); s.lap(2, 30.2, go + 60450); s.lap(1, 30.0, go + 61200);
  assert.deepStrictEqual(s.snapshot().players.map(p => p.rTime), [61.2, 60.4]);
  // a driver who sat in the menu for 30 s: his lap timer stood still, the crossing did not
  ({ s, go } = race());
  s.lap(2, 31.0, go + 31050, P(go + 31000));
  s.lap(2, 31.0, go + 92050, P(go + 92000));
  assert.strictEqual(s.snapshot().players[1].rTime, 92, 'laps sum 62 s, crossed at 92 s');
  // `at` is taken as no later than the arrival, and no earlier than 3 s before it (or his previous crossing):
  // a made-up crossing time gains at most that
  ({ s, go } = race());
  s.lap(1, 30.0, go + 30100, P(go + 99999));
  assert.strictEqual(s.snapshot().players[0].rTime, 30, 'in the future: the arrival (30.1 s, within the tolerance)');
  s.lap(1, 20.0, go + 60100, P(go + 1000));
  assert.strictEqual(s.snapshot().players[0].rTime, 57.1, 'laps of 50 s "crossed at 1 s": 3 s before the arrival');
  ({ s, go } = race());
  s.lap(1, 30.0, go + 33000, P(go + 30000));
  assert.strictEqual(s.snapshot().players[0].rTime, 30, 'a report 3 s late still costs nothing');
  s.lap(1, 30.0, go + 65000, P(go + 60000));
  assert.strictEqual(s.snapshot().players[0].rTime, 62, '5 s late: taken as crossed 3 s before the arrival');
  for (const bad of [NaN, '1', null, {}, Infinity]) {
    ({ s, go } = race());
    s.lap(1, 30.0, go + 31500, P(bad));
    assert.strictEqual(s.snapshot().players[0].rTime, 31.5, 'garbage `at`: the arrival ' + String(bad));
  }
});

/* ---------- computer drivers (bots) ---------- */

test('bots: players like any other (qualify, grid by time, race, DNF when removed); only their rows carry bot: true', () => {
  const s = createSession({ random: () => 0.5 });
  let t = 1000000;
  assert.strictEqual(s.addPlayer(1, 'Human', t), true);
  assert.strictEqual(s.addPlayer(2, 'Bot A', t, { bot: true, owner: 1 }), true);
  assert.strictEqual(s.addPlayer(3, 'Bot B', t, { bot: true, owner: 1 }), true);
  assert.strictEqual(s.addPlayer(2, 'again', t, { bot: true, owner: 1 }), false, 'an id is in the session once');
  // anything but {bot: true} is a human; a garbage owner is 0
  s.addPlayer(4, 'not a bot', t, { bot: 'yes', owner: 1 });
  s.addPlayer(5, 'nor this', t, 'bot');
  s.addPlayer(6, 'odd owner', t, { bot: true, owner: 'me' });
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 99].map(id => s.isBot(id)), [false, true, true, false, false, true, false]);
  let g = s.snapshot();
  assert.deepStrictEqual(g.players.map(p => p.bot), [undefined, true, true, undefined, undefined, true], 'a human row is as it was');
  assert(!('bot' in g.players[0]) && !('owner' in g.players[1]), 'rows carry bot: true, nothing else new');
  [4, 5, 6].forEach(id => s.removePlayer(id, t));
  // qualifying waits for every bot; the grid goes by time, bots or not
  s.start({ q: 1, r: 2, len: LEN }, t);
  t += 100000;
  assert.strictEqual(s.lap(1, 81, t), '');
  assert.strictEqual(s.lap(3, 80, t), '');
  assert.strictEqual(s.phase, 'quali', 'bot A has not done its lap');
  assert.strictEqual(s.lap(2, 82, t), '');
  g = s.snapshot();
  assert.deepStrictEqual([g.phase, g.grid], ['grid', [3, 1, 2]]);
  t = g.goAt; s.tick(t);
  // race: progress and laps as for anybody; a bot removed mid-race is a DNF row that keeps bot: true
  s.progress(2, 0.6); s.progress(3, 0.4); s.progress(1, 0.5);
  assert.deepStrictEqual(s.snapshot().order, [2, 1, 3]);
  assert.strictEqual(s.removePlayer(3, t), true);
  g = s.snapshot();
  const b = g.players.find(p => p.id === 3);
  assert.deepStrictEqual([b.left, b.dnf, b.bot, g.order[2]], [true, true, true, 3]);
  assert.strictEqual(s.isBot(3), false, 'gone');
  t += 100000; assert.strictEqual(s.lap(2, 90, t), ''); assert.strictEqual(s.lap(1, 91, t), '');
  t += 100000; assert.strictEqual(s.lap(2, 90, t), ''); assert.strictEqual(s.lap(1, 91, t), '');
  g = s.snapshot();
  assert.deepStrictEqual([g.phase, g.order, g.players.filter(p => p.bot).map(p => [p.id, p.fin, p.dnf])], ['results', [2, 1, 3], [[2, true, false], [3, false, true]]]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), g);
  // free practice: the leaver's row goes, the bot that stays is a bot again in the next session
  s.end();
  g = s.snapshot();
  assert.deepStrictEqual(g.players.map(p => [p.id, p.bot === true]), [[1, false], [2, true]]);
  s.start({ q: 1, r: 1, len: LEN }, t);
  assert.deepStrictEqual(s.snapshot().players.map(p => [p.id, p.bot === true, p.spec]), [[1, false, false], [2, true, false]]);
});

test('bots: a full field of 1 human + 15 bots; removing the bots in qualifying completes it; a bot added mid-session spectates', () => {
  const s = createSession({ random: () => 0 });
  let t = 2000000;
  s.addPlayer(1, 'Solo', t);
  for (let i = 2; i <= 16; i++) s.addPlayer(i, 'AI ' + i, t, { bot: true, owner: 1 });
  s.start({ q: 2, r: 3, len: LEN }, t);
  t += 100000;
  assert.strictEqual(s.lap(1, 80, t), '');
  t += 100000;
  assert.strictEqual(s.lap(1, 80, t), '');
  assert.strictEqual(s.phase, 'quali');
  for (let i = 2; i <= 16; i++) s.removePlayer(i, t);           // the owner's game went away
  assert.strictEqual(s.phase, 'grid', 'nobody left to wait for');
  assert.deepStrictEqual(s.snapshot().grid, [1]);
  s.addPlayer(30, 'late bot', t, { bot: true, owner: 1 });
  const p = s.snapshot().players.find(q => q.id === 30);
  assert.deepStrictEqual([p.spec, p.bot], [true, true], 'like anybody joining during the grid');
  assert.strictEqual(s.solid(1, 30, s.snapshot().goAt), false);
  const big = createSession();
  for (let i = 1; i <= 16; i++) big.addPlayer(i, '十六個字的超級長名字車手' + String(i).padStart(4, '0'), t, i > 1 ? { bot: true, owner: 1 } : undefined);
  big.start({ q: 1, r: 99, len: LEN, year: 2026, wear: 5 }, t);
  assert(Buffer.byteLength(JSON.stringify(big.snapshot())) < 4200, 'bots add 11 bytes a row');
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall session tests passed');
process.exit(failed ? 1 : 0);
