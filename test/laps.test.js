// node test/laps.test.js — lap counter (js/laps.js), pure logic fed with synthetic sample-index sequences.
'use strict';
const assert = require('assert');
const createLapCounter = require('../js/laps.js');
const { createSession } = require('../net/session.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}

const DT = 1 / 120;
const N = 2903, I = 1160, J = 2345;      // Suzuka: sample count and the two samples of the crossover
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

// A car on a track of n samples. `at` is the sample the car is really at; every step() feeds the counter
// exactly as main.js does (one update per 1/120 s physics step) and checks what must always hold.
function rig(n, startIdx, opts) {
  const lap = createLapCounter(n, startIdx);
  if (opts && opts.arm) lap.arm(startIdx);
  const r = {
    lap, n, at: startIdx, steps: 0, codes: [], laps: [], lastProg: null, maxProgStep: 0, progDrops: 0,
    t0: 0, base: 0,                       // step at which the lap clock (re)started, and what it started from
    setTime(t) { lap.time = t; r.base = t; r.t0 = r.steps; },             // main.js: lap.time = gp.sinceGo
    // one physics step with the index the car reports (default: where it really is)
    step(idx, speed) {
      if (idx === undefined) idx = r.at;
      const before = lap.n, wasVoid = lap.void;
      const c = lap.update(idx, speed === undefined ? 60 : speed, DT);
      r.steps++;
      assert([0, 1, 2].includes(c), 'update returns 0 | 1 | 2');
      if (c) r.codes.push(c);
      if (c === 2) {
        assert(near(lap.last, r.base + (r.steps - r.t0) * DT, 1e-8), 'lap time = simulated time since the clock started');
        assert(lap.best !== null && lap.best <= lap.last);
        r.laps.push({ time: lap.last, step: r.steps });
        assert.strictEqual(lap.n, before + 1, 'a completed lap advances n by one');
      } else if (c === 1) assert.strictEqual(lap.n, 1);
      else assert.strictEqual(lap.n, before, 'n only changes with a result');
      if (c || (wasVoid && !lap.void && lap.time === 0)) { r.t0 = r.steps; r.base = 0; }    // the clock restarted
      assert(near(lap.time, lap.started ? r.base + (r.steps - r.t0) * DT : 0, 1e-8), 'lap clock');
      assert.strictEqual(lap.behind, lap.started && lap.progress() < (lap.n > 0 ? lap.n - 1 : 0), 'behind flag');
      assert(!lap.void || lap.behind, 'a void lap is behind its line');
      const p = lap.progress(idx);
      assert(p === p && isFinite(p), 'progress is a number');
      if (r.lastProg !== null) {
        if (p < r.lastProg - 1e-12) r.progDrops++;
        r.maxProgStep = Math.max(r.maxProgStep, Math.abs(p - r.lastProg));
      }
      r.lastProg = p;
      return c;
    },
    // drive `count` samples forward (negative: backwards), `per` steps on every sample
    drive(count, per) {
      const dir = count < 0 ? -1 : 1;
      for (let k = 0; k < Math.abs(count); k++) {
        r.at = ((r.at + dir) % n + n) % n;
        for (let s = 0; s < (per || 1); s++) r.step();
      }
      return r;
    },
    to(idx, per) { return r.drive(((idx - r.at) % n + n) % n, per); },       // forward to that sample
    hold(steps, idx) { for (let s = 0; s < steps; s++) r.step(idx); return r; },
    // the car's index reports `idx` (drifting by `drift` samples over the time) while the car itself drives
    // `travel` samples on along its own road: a mis-location at the crossover
    mislocate(idx, steps, drift, travel) {
      for (let s = 0; s < steps; s++) r.step(((idx + Math.round((drift || 0) * s / steps)) % n + n) % n);
      r.at = ((r.at + (travel || 0)) % n + n) % n;
      return r.hold(1);
    },
    done() { return r.laps.length; }
  };
  return r;
}

test('API: shape of the counter, also reachable as F1.createLapCounter', () => {
  assert.strictEqual(typeof createLapCounter, 'function');
  assert.strictEqual(globalThis.F1.createLapCounter, createLapCounter);
  const lap = createLapCounter(1000, 990);
  ['reset', 'arm', 'sync', 'update', 'progress'].forEach(f => assert.strictEqual(typeof lap[f], 'function', f));
  assert.deepStrictEqual([lap.started, lap.n, lap.time, lap.last, lap.best, lap.sector, lap.void, lap.behind],
    [false, 0, 0, null, null, 0, false, false]);
  assert.strictEqual(lap.prevIdx, 990);
  assert.strictEqual(lap.jumping, false);
});

test('free practice: timing starts at the first crossing, a lap is one full loop', () => {
  const r = rig(N, N - 10);
  r.drive(9, 3);
  assert.deepStrictEqual([r.lap.started, r.lap.n, r.lap.time, r.codes.length], [false, 0, 0, 0], 'nothing before the line');
  assert.strictEqual(r.step(0), 1, 'the step that reaches sample 0 starts the clock');
  r.at = 0;
  assert.deepStrictEqual([r.lap.started, r.lap.n, r.lap.time], [true, 1, 0]);
  const s0 = r.steps;
  r.drive(N - 1, 3);
  assert.strictEqual(r.done(), 0, 'one sample short of the line');
  r.hold(5);
  assert.strictEqual(r.done(), 0, 'standing still completes nothing');
  assert.strictEqual(r.step(0), 2);
  r.at = 0;
  assert.strictEqual(r.lap.n, 2);
  assert(near(r.lap.last, (r.steps - s0) * DT), 'lap time = simulated time between the two crossings');
  assert.strictEqual(r.lap.best, r.lap.last);
  assert.strictEqual(r.lap.time, 0);
  // a faster second lap becomes the best, a slower third one does not
  r.drive(N, 2);
  assert.strictEqual(r.done(), 2);
  assert(near(r.lap.last, (N * 2 - 1) * DT) && r.lap.best === r.lap.last);
  const best = r.lap.best;
  r.drive(N, 4);
  assert.deepStrictEqual([r.done(), r.lap.n, r.lap.best], [3, 4, best]);
  assert(near(r.lap.last, (r.laps[2].step - r.laps[1].step) * DT) && r.lap.last > best);
  assert.deepStrictEqual(r.codes, [1, 2, 2, 2]);
  assert.strictEqual(r.lap.jumps, 0);
});

test('sector: furthest quarter reached, back to 0 on a new lap', () => {
  const r = rig(1000, 990);
  r.drive(10);
  assert.strictEqual(r.lap.sector, 0);
  r.to(249); assert.strictEqual(r.lap.sector, 0);
  r.to(250); assert.strictEqual(r.lap.sector, 1);
  r.to(600); assert.strictEqual(r.lap.sector, 2);
  r.drive(-200); assert.strictEqual(r.lap.sector, 2, 'driving back does not take it away');
  r.to(999); assert.strictEqual(r.lap.sector, 3);
  r.to(0); assert.deepStrictEqual([r.lap.sector, r.done()], [0, 1]);
});

test('any sample count: not divisible by 4, tiny tracks', () => {
  for (const n of [5, 6, 7, 9, 13, 30, 101, 1001, 1663, 2903, 3001, 3502]) {
    const r = rig(n, n - 1);
    r.drive(1 + 3 * n);
    assert.deepStrictEqual(r.codes, [1, 2, 2, 2], 'N = ' + n);
    assert.strictEqual(r.lap.n, 4, 'N = ' + n);
    assert(near(r.lap.last, n * DT), 'N = ' + n);
    assert.strictEqual(r.progDrops, 0, 'N = ' + n);
  }
});

test('the index may advance several samples in a step, also over the line', () => {
  const r = rig(N, N - 3);
  r.step(2); r.at = 2;                                  // -3 -> +2 in one step
  assert.deepStrictEqual(r.codes, [1]);
  for (let k = 0; k < 1.5 * N / 7; k++) { r.at = (r.at + 7) % N; r.step(); }
  assert.strictEqual(r.done(), 1);
  assert(r.lap.n === 2 && r.lap.progress(r.at) > 1 && r.lap.progress(r.at) < 2);
});

test('reversing over the line and coming back counts nothing', () => {
  // before timing has started: backing away and coming forward starts the clock once
  let r = rig(N, N - 10);
  r.drive(-30).drive(45);
  assert.deepStrictEqual(r.codes, [1]);
  // right after the start of a lap: back over the line, forward again
  const t0 = r.lap.time;
  r.drive(-20, 4);
  assert.deepStrictEqual([r.lap.behind, r.lap.n, r.lap.void], [true, 1, false]);
  assert(r.lap.progress(r.at) < 0);
  r.drive(30, 4);
  assert.deepStrictEqual([r.lap.behind, r.lap.n, r.done()], [false, 1, 0]);
  assert(near(r.lap.time, t0 + 50 * 4 * DT), 'the clock keeps running from the first crossing');
  // at the end of a lap: over the line (lap counted), back, forward again -> still one lap
  r.to(0);
  assert.strictEqual(r.done(), 1);
  for (let k = 0; k < 20; k++) { r.drive(-3); r.drive(3); }
  r.drive(-1).drive(1).drive(-1).drive(1);
  assert.deepStrictEqual([r.done(), r.lap.n], [1, 2]);
  // the index flickering between the last sample and sample 0 while the car sits on the line
  r.to(N - 1);
  for (let k = 0; k < 50; k++) { r.step(0); r.step(N - 1); }
  assert.deepStrictEqual([r.done(), r.lap.n], [2, 3], 'counted exactly once');
  r.at = N - 1; r.drive(1);
  assert.strictEqual(r.done(), 2);
  r.drive(N);
  assert.strictEqual(r.done(), 3);
});

test('spinning and driving backwards inside a lap: the lap still counts, once', () => {
  const r = rig(N, N - 5);
  r.drive(5);
  r.to(1800).drive(-900).drive(40).drive(-40);          // back over the half-way and quarter marks
  assert.deepStrictEqual([r.lap.void, r.lap.behind], [false, false]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
  assert(near(r.lap.last, (N + 2 * 900 + 80) * DT, 1e-8));
  // speed sign is irrelevant: rolling backwards over the line in the racing direction is a crossing
  r.to(N - 2);
  r.at = 1; r.step(1, -3);
  assert.strictEqual(r.done(), 2);
});

test('driving the wrong way round: nothing counts until a lap is driven forwards', () => {
  const r = rig(N, 5);
  r.drive(-5 - N - 200);                                // backwards over the line twice
  assert.deepStrictEqual([r.lap.started, r.codes.length], [false, 0]);
  r.drive(210);
  assert.deepStrictEqual(r.codes, [1]);
  r.drive(-10 - 2 * N - 300);                           // two and a bit laps backwards with the clock running
  assert.deepStrictEqual([r.done(), r.lap.n, r.lap.behind], [0, 1, true]);
  r.to(0);
  assert.strictEqual(r.done(), 0, 'coming back over the line gives nothing');
  r.drive(N);
  assert.strictEqual(r.done(), 1, 'a whole lap forwards does');
  assert(near(r.lap.last, (10 + 10 + 2 * N + 300 + 300 + N) * DT, 1e-8), 'and the clock ran all the time');
});

test('race start: arm() on the grid, first crossing does not complete a lap, clock runs from arm', () => {
  for (const slot of [0, 1, 7, 15]) {
    // main.js placeOnGrid: grid box slot + 1 (js/track.js track.grid), its front bar (slot + 1) * 8 m behind the line,
    // the car's origin 0.25 + 2.8 m (CAR_NOSE) behind the bar's front: 6 .. 66 samples at 2 m per sample
    const back = Math.round(((slot + 1) * 8 + 0.25 + 2.8) / 2);
    const r = rig(N, N - back, { arm: true });
    assert.deepStrictEqual([r.lap.started, r.lap.n, r.lap.behind, r.lap.time], [true, 1, true, 0]);
    r.setTime(0.35);                                    // main.js: lap.time = gp.sinceGo
    assert(near(r.lap.progress(N - back), -back / N), 'slightly negative on the grid');
    r.hold(30);                                         // reaction time
    r.drive(back, 6);
    assert.deepStrictEqual([r.codes.length, r.lap.n, r.lap.behind], [0, 1, false], 'slot ' + slot);
    const R = 3;
    r.drive(R * N, 2);
    assert.deepStrictEqual(r.codes, [2, 2, 2], 'slot ' + slot);
    assert.strictEqual(r.lap.n, R + 1);
    const total = r.laps.reduce((a, l) => a + l.time, 0);
    assert(near(total, 0.35 + r.laps[R - 1].step * DT, 1e-8), 'sum of the lap times = time since lights out');
    assert(near(r.laps[0].time, 0.35 + r.laps[0].step * DT, 1e-8), 'lap 1 includes the run to the line');
    assert(r.laps[0].step > 30 + back * 6 + (N - 1) * 2);
    assert(near(r.laps[1].time, N * 2 * DT, 1e-8));
    assert.strictEqual(r.progDrops, 0, 'progress never goes back');
    assert(r.maxProgStep <= 1 / N + 1e-12, 'progress is continuous over the line');
    assert(near(r.lap.progress(r.at), R));
  }
});

test('race start on a very short track: a grid slot more than half a lap back', () => {
  for (const [n, back] of [[100, 70], [100, 26], [100, 51], [140, 70], [71, 70]]) {
    const r = rig(n, n - back, { arm: true });
    assert(near(r.lap.progress(n - back), -back / n), 'N ' + n);
    r.drive(back);
    assert.deepStrictEqual([r.codes.length, r.lap.behind], [0, false], 'first crossing, N ' + n + ' back ' + back);
    r.drive(2 * n);
    assert.deepStrictEqual(r.codes, [2, 2], 'N ' + n + ' back ' + back);
    assert.strictEqual(r.progDrops, 0);
  }
  // not armed (qualifying) from the same far slot: the first crossing starts the clock
  const q = rig(100, 30);
  q.drive(70);
  assert.deepStrictEqual(q.codes, [1]);
  q.drive(100);
  assert.deepStrictEqual(q.codes, [1, 2]);
  // sitting exactly on sample 0: a whole lap to go, both armed and not
  const z = rig(100, 0, { arm: true });
  z.drive(99); assert.strictEqual(z.done(), 0);
  z.drive(1); assert.strictEqual(z.done(), 1);
  const y = rig(100, 0);
  y.drive(99); assert.strictEqual(y.lap.started, false);
  y.drive(1); assert.deepStrictEqual(y.codes, [1]);
});

test('arm() and reset() wipe the previous session', () => {
  const r = rig(N, N - 5);
  r.drive(5 + N + 400);
  assert(r.lap.best !== null && r.lap.n === 2);
  r.lap.arm(N - 30);
  assert.deepStrictEqual([r.lap.started, r.lap.n, r.lap.time, r.lap.last, r.lap.best, r.lap.void, r.lap.behind, r.lap.jumps],
    [true, 1, 0, null, null, false, true, 0]);
  r.lap.reset(N - 12);
  assert.deepStrictEqual([r.lap.started, r.lap.n, r.lap.time, r.lap.last, r.lap.best, r.lap.void, r.lap.behind, r.lap.prevIdx],
    [false, 0, 0, null, null, false, false, N - 12]);
  assert(near(r.lap.progress(N - 12), -12 / N));
});

test('R reset (sync): timing keeps running, nothing is credited or lost', () => {
  // mid lap, same sample
  let r = rig(N, N - 5);
  r.drive(5).to(1452);
  const t = r.lap.time, p = r.lap.progress(r.at);
  r.lap.sync(r.at);
  assert.deepStrictEqual([r.lap.time, r.lap.progress(r.at), r.lap.void], [t, p, false]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
  // the reset moves the index a few samples, across a quarter boundary and across the line
  // [from, to, laps right after the reset, laps after the next crossing of the line]
  for (const [from, to, now, next] of [[724, 727, 0, 1], [1453, 1449, 0, 1], [N - 1, 1, 1, 2], [N - 1, 0, 1, 2],
    [1, N - 2, 0, 0], [0, N - 1, 0, 0]]) {
    r = rig(N, N - 5);
    r.drive(5).to(from);
    r.lap.sync(to); r.at = to; r.hold(3);
    assert.strictEqual(r.done(), now, 'sync ' + from + ' -> ' + to);
    r.to(N - 1).drive(2);
    assert.strictEqual(r.done(), next, 'next crossing, sync ' + from + ' -> ' + to);
    assert.strictEqual(r.lap.void, false);
    r.drive(N);
    assert.strictEqual(r.done(), next + 1, 'and the lap after, sync ' + from + ' -> ' + to);
  }
  // sync() straight over the line: the crossing is reported by the next update()
  r = rig(N, N - 5);
  r.drive(5).to(N - 1);
  r.lap.sync(0); r.at = 0;
  assert.strictEqual(r.step(), 2);
});

test('index jump to the other branch for a few steps (Suzuka crossover): ignored', () => {
  const r = rig(N, N - 5);
  r.drive(5).to(I - 2, 2);
  const p = r.lap.progress(r.at);
  r.hold(1, J - 2);
  assert.deepStrictEqual([r.lap.jumping, r.lap.prevIdx, r.lap.jumps], [true, I - 2, 1]);
  assert.strictEqual(r.lap.progress(J - 2), p, 'progress stays where the car really is');
  r.hold(5, J - 3);
  r.at = I + 1; r.hold(1);
  assert.deepStrictEqual([r.lap.jumping, r.lap.void, r.lap.prevIdx], [false, false, I + 1]);
  r.to(J - 1, 2);
  r.hold(4, I + 3);                                     // and on the other branch, the other way
  assert.strictEqual(r.lap.progress(I + 3), (J - 1) / N);
  r.at = J + 2; r.hold(1);
  r.to(0, 2);
  assert.deepStrictEqual([r.done(), r.lap.void, r.lap.jumps, r.progDrops], [1, false, 2, 0]);
});

test('off the road at the crossover: the index sits on the other branch for seconds, the lap still counts', () => {
  // what car.js reports for a car 9 m off the centreline at 6 m/s: ~430 steps on samples 2343..2337
  // while the car covers 11 samples of its own road; then the same on the way back on the other branch
  for (const steps of [40, 119, 120, 121, 434, 5000]) {
    const r = rig(N, N - 5);
    r.drive(5).to(I - 2, 2);
    r.mislocate(J - 2, steps, -6, 11);
    assert.deepStrictEqual([r.lap.void, r.lap.jumping, r.lap.prevIdx], [false, false, I + 9], steps + ' steps');
    r.to(J - 8, 2);
    r.mislocate(I + 7, steps, -5, 10);
    assert.deepStrictEqual([r.lap.void, r.lap.jumping, r.lap.prevIdx], [false, false, J + 2], steps + ' steps');
    r.to(0, 2);
    assert.strictEqual(r.done(), 1, steps + ' steps: the lap counts');
    assert(near(r.lap.last, (r.laps[0].step - 5) * DT, 1e-8));
    assert.strictEqual(r.progDrops, 0, 'progress never drops');
    assert(r.maxProgStep <= 21 / N, 'and only catches up the blind stretch');
    r.drive(N, 2);
    assert.strictEqual(r.done(), 2);
  }
});

test('parked on the other branch of the crossover for a minute, index flickering between the branches', () => {
  const r = rig(N, N - 5, { arm: true });
  r.drive(5).to(I - 1);
  r.hold(7200, J + 1);
  assert.deepStrictEqual([r.lap.jumping, r.lap.void, r.lap.prevIdx], [true, false, I - 1]);
  for (let k = 0; k < 300; k++) { r.step(k % 2 ? J + 1 : I); r.step(k % 3 ? I : J - 4); }
  assert.strictEqual(r.lap.void, false);
  r.at = I + 2; r.hold(2);
  assert.deepStrictEqual([r.lap.jumping, r.lap.void], [false, false]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
  assert.strictEqual(r.progDrops, 0);
});

test('shortcut over the crossover: the lap is void, the next crossing restarts the clock', () => {
  const r = rig(N, N - 5);
  r.drive(5 + N);                                       // a clean lap first
  assert.strictEqual(r.done(), 1);
  r.to(I - 1, 2);
  const before = r.lap.progress(r.at);
  r.at = J; r.hold(1);                                  // turns onto the other road
  assert.strictEqual(r.lap.jumping, true);
  r.drive(25);
  assert.deepStrictEqual([r.lap.void, r.lap.jumping], [false, true], 'not believed after 50 m');
  r.drive(1);
  assert.deepStrictEqual([r.lap.void, r.lap.behind, r.lap.jumping, r.lap.prevIdx], [true, true, false, J + 26]);
  assert(near(r.lap.progress(r.at), 1 + (J + 26) / N - 1), 'a lap behind where it seems to be');
  assert(r.lap.progress(r.at) < before);
  r.to(N - 1, 2);
  assert(r.lap.time > 0);
  assert.strictEqual(r.step(0), 0, 'the crossing completes nothing');
  r.at = 0;
  assert.deepStrictEqual([r.lap.n, r.lap.void, r.lap.behind, r.lap.time, r.done()], [2, false, false, 0, 1]);
  assert(near(r.lap.progress(0), 1));
  const s0 = r.steps;
  r.drive(N, 2);
  assert.strictEqual(r.done(), 2);
  assert(near(r.lap.last, (r.laps[1].step - s0) * DT, 1e-8), 'the next lap is timed from that crossing');
  // in a race the shortcut costs the lap
  const g = rig(N, N - 40, { arm: true });
  g.to(I).hold(1);
  g.at = J; g.drive(40).to(0);
  assert.deepStrictEqual([g.done(), g.lap.n], [0, 1]);
  g.drive(N);
  assert.deepStrictEqual([g.done(), g.lap.n], [1, 2]);
});

test('the crossover the long way round: no void, the lap counts when the loop is complete', () => {
  const r = rig(N, N - 5);
  r.drive(5).to(J, 2);
  r.at = I; r.drive(30);                                // turns onto the early branch again
  assert.deepStrictEqual([r.lap.void, r.lap.behind, r.lap.prevIdx, r.lap.jumping], [false, false, I + 30, false]);
  assert(near(r.lap.progress(r.at), (I + 30) / N), 'ground lost');
  r.to(0, 2);
  assert.strictEqual(r.done(), 1);
  assert(near(r.lap.last, (r.laps[0].step - 5) * DT, 1e-8) && r.laps[0].step > (N + J - I) * 2 - 60);
  // ... and hopping forward again to where the lap had already been is no shortcut
  r.to(J, 2);
  r.at = I; r.drive(30);
  r.at = J; r.hold(1).drive(26);
  assert.deepStrictEqual([r.lap.void, r.lap.jumping, r.lap.prevIdx], [false, false, J + 26]);
  assert(near(r.lap.progress(r.at), 1 + (J + 26) / N));
  r.to(0, 2);
  assert.strictEqual(r.done(), 2);
});

test('a void lap becomes valid again when the car goes back to where it left the lap', () => {
  // jumps back
  let r = rig(N, N - 5);
  r.drive(5).to(I);
  r.at = J; r.drive(40);
  assert.strictEqual(r.lap.void, true);
  r.at = I + 4; r.hold(1).drive(25);
  assert.deepStrictEqual([r.lap.void, r.lap.jumping], [true, true], 'the way back is a jump like any other');
  r.drive(1);
  assert.deepStrictEqual([r.lap.void, r.lap.behind, r.lap.prevIdx], [false, false, I + 30]);
  assert(near(r.lap.progress(r.at), (I + 30) / N));
  r.to(0);
  assert.strictEqual(r.done(), 1);
  // drives back the wrong way round the part it skipped
  r = rig(N, N - 5);
  r.drive(5).to(I);
  r.at = J; r.drive(40);
  r.drive(-(J + 40 - I - 61));
  assert.strictEqual(r.lap.void, true, 'not yet');
  r.drive(-1);
  assert.deepStrictEqual([r.lap.void, r.lap.behind], [false, false]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
  // but not by going somewhere else: a second hop further on keeps it void
  r = rig(N, N - 5);
  r.drive(5).to(300);
  r.at = 1000; r.drive(30);
  r.at = 2000; r.drive(30);
  assert.strictEqual(r.lap.void, true);
  r.to(0);
  assert.deepStrictEqual([r.done(), r.lap.void], [0, false]);
});

test('a mis-location that was wrongly believed corrects itself on the way back', () => {
  // forward: on the early branch, the index walks 40 samples along the late one, then returns
  let r = rig(N, N - 5);
  r.drive(5).to(I - 5);
  for (let k = 0; k <= 40; k++) r.step(J + 10 - k);
  assert.strictEqual(r.lap.void, true);
  r.at = I + 30; r.hold(1).drive(26);                   // 35 samples further on than where it left, + 26
  assert.deepStrictEqual([r.lap.void, r.lap.behind, r.lap.prevIdx], [false, false, I + 56]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
  // backward: on the late branch, the index walks along the early one
  r = rig(N, N - 5);
  r.drive(5).to(J - 5);
  for (let k = 0; k <= 40; k++) r.step(I + 10 - k);
  assert.deepStrictEqual([r.lap.void, r.lap.prevIdx], [false, I - 30]);
  r.at = J + 30; r.hold(1).drive(26);
  assert.deepStrictEqual([r.lap.void, r.lap.prevIdx, r.lap.jumping], [false, J + 56, false]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
});

test('a one-step wrong index never changes anything, wherever it points', () => {
  // armed on the grid, the index points just past the line for a step: still the grid's first crossing to come
  const g = rig(N, N - 70, { arm: true });
  g.setTime(0.2);
  g.hold(10);
  g.hold(1, 30); g.hold(1); g.hold(1, N - 400); g.hold(1); g.hold(1, 1500); g.hold(3);
  assert.deepStrictEqual([g.lap.behind, g.lap.void, g.lap.jumping, g.lap.prevIdx, g.lap.jumps], [true, false, false, N - 70, 3]);
  g.drive(70 + N, 2);
  assert.deepStrictEqual(g.codes, [2]);
  assert(near(g.lap.last, 0.2 + g.laps[0].step * DT, 1e-8), 'and the clock ran from lights out');
  // in a lap that has been further round already (after the long way round): pointing there and back
  const r = rig(N, N - 5);
  r.drive(5).to(J);
  r.at = I; r.drive(30);
  r.hold(1, J); r.hold(2); r.hold(1, 40); r.hold(2);
  assert.deepStrictEqual([r.lap.void, r.lap.prevIdx, r.lap.jumping], [false, I + 30, false]);
  assert(near(r.lap.progress(r.at), (I + 30) / N));
  // in a void lap: pointing back at where the lap was left
  const v = rig(N, N - 5);
  v.drive(5).to(I);
  v.at = J; v.drive(40);
  v.hold(1, I + 2); v.hold(2);
  assert.deepStrictEqual([v.lap.void, v.lap.prevIdx], [true, J + 40]);
  assert.strictEqual(g.progDrops + r.progDrops, 1, 'only the believed move back (long way round) lowers progress');
});

test('R reset while the index is on the other branch puts the car there: believed at once', () => {
  // early branch -> late branch: a shortcut, the lap is void
  let r = rig(N, N - 5);
  r.drive(5).to(I - 1);
  r.hold(3, J + 1);
  r.lap.sync(J + 1); r.at = J + 1;
  assert.strictEqual(r.step(), 0);
  assert.deepStrictEqual([r.lap.void, r.lap.prevIdx, r.lap.jumping], [true, J + 1, false]);
  r.to(0);
  assert.strictEqual(r.done(), 0);
  r.drive(N);
  assert.strictEqual(r.done(), 1);
  // late branch -> early branch: ground lost, the lap still counts
  r = rig(N, N - 5);
  r.drive(5).to(J - 1);
  r.hold(3, I + 1);
  r.lap.sync(I + 1); r.at = I + 1; r.hold(1);
  assert.deepStrictEqual([r.lap.void, r.lap.prevIdx, r.lap.jumping], [false, I + 1, false]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
});

test('a jump never starts the clock and never completes a lap', () => {
  // not started: jumping over the line does not start timing
  let r = rig(N, N - 300);
  r.at = 200; r.drive(40);
  assert.deepStrictEqual([r.lap.started, r.codes.length], [false, 0]);
  r.to(0);
  assert.deepStrictEqual(r.codes, [1]);
  // started: jumping over the line near the end of a lap is ground lost, not a lap
  r.to(N - 300);
  r.at = 200; r.drive(40);
  assert.deepStrictEqual([r.done(), r.lap.n, r.lap.void, r.lap.prevIdx], [0, 1, false, 240]);
  r.to(0);
  assert.strictEqual(r.done(), 1, 'one lap for one driven crossing');
  // armed on the grid: jumping over the line does not make the first crossing
  const g = rig(N, N - 300, { arm: true });
  g.at = 200; g.drive(40);
  assert.deepStrictEqual([g.lap.behind, g.lap.void, g.lap.n], [true, false, 1]);
  g.to(0);
  assert.strictEqual(g.done(), 0);
  g.drive(N);
  assert.strictEqual(g.done(), 1);
  // a jump back over the line into a part this lap has not seen: void
  r = rig(N, N - 5);
  r.drive(5).to(300);
  r.at = N - 400; r.drive(40);
  assert.deepStrictEqual([r.lap.void, r.lap.behind], [true, true]);
  r.to(0);
  assert.deepStrictEqual([r.done(), r.lap.time], [0, 0]);
});

test('what is tolerated: an index step of up to 60 samples (120 m) is taken as driving', () => {
  const r = rig(N, N - 5);
  r.drive(5).to(1000);
  r.at = 1060; r.hold(2);
  assert.deepStrictEqual([r.lap.jumping, r.lap.void, r.lap.prevIdx], [false, false, 1060]);
  r.at = 1121; r.hold(2);                               // 61: a jump
  assert.deepStrictEqual([r.lap.jumping, r.lap.prevIdx], [true, 1060]);
  r.drive(26);
  assert.strictEqual(r.lap.void, true);
  // on a tiny track the tolerance shrinks with it (N / 8)
  const t = rig(80, 79);
  t.drive(1);
  t.at = 10; t.hold(1);
  assert.deepStrictEqual([t.lap.jumping, t.lap.prevIdx], [false, 10]);
  t.at = 21; t.hold(1);
  assert.deepStrictEqual([t.lap.jumping, t.lap.prevIdx], [true, 10]);
});

test('where to put the car on an R reset during a jump: lap.prevIdx', () => {
  const r = rig(N, N - 5, { arm: true });
  r.drive(5).to(I - 2);
  r.hold(200, J - 2);
  assert.deepStrictEqual([r.lap.jumping, r.lap.prevIdx], [true, I - 2]);
  r.lap.sync(r.lap.prevIdx);                            // main.js: car.reset(track, lap.prevIdx); lap.sync(idx)
  assert.strictEqual(r.lap.jumping, false);
  r.hold(3);
  assert.deepStrictEqual([r.lap.void, r.lap.behind, r.lap.prevIdx, r.lap.jumps], [false, false, I - 2, 1]);
  r.to(0);
  assert.strictEqual(r.done(), 1);
});

test('progress: race distance in laps, monotonic, continuous, frozen during a jump', () => {
  const r = rig(N, N - 70, { arm: true });
  assert(near(r.lap.progress(N - 70), -70 / N));
  let prev = r.lap.progress(r.at);
  for (let k = 0; k < 70 + 2 * N + 500; k++) {
    r.drive(1);
    const p = r.lap.progress(r.at);
    assert(near(p - prev, 1 / N, 1e-12), 'one sample = 1 / N of a lap, at sample ' + r.at);
    prev = p;
  }
  assert(near(prev, 2 + 500 / N));
  assert.strictEqual(r.lap.progress(), prev, 'without an argument: the believed position');
  assert.strictEqual(r.lap.progress(r.at + 3), prev + 3 / N, 'a few samples on: added');
  assert.strictEqual(r.lap.progress((r.at + 1200) % N), prev, 'a jump: not added');
  assert.strictEqual(r.lap.progress(NaN), prev);
  // not started (qualifying out lap): distance to the line, 0 at the line
  const q = rig(N, N - 10);
  assert(near(q.lap.progress(N - 10), -10 / N));
  q.drive(10);
  assert.strictEqual(q.lap.progress(0), 0);
  assert.strictEqual(q.progDrops, 0);
});

test('lap time: dt accumulation over long laps, agrees with the step count', () => {
  const lap = createLapCounter(N, 0);
  lap.arm(N - 10);
  let steps = 0;
  for (; steps < 120 * 120; steps++) lap.update(N - 10, 0, DT);
  assert(Math.abs(lap.time - 120) < 1e-9, 'two minutes: ' + (lap.time - 120));
  for (; steps < 3600 * 120; steps++) lap.update(N - 10, 0, DT);
  assert(Math.abs(lap.time - 3600) < 1e-6, 'an hour: ' + (lap.time - 3600));
  // identical laps give identical times (ties in qualifying are real ties)
  const a = rig(N, N - 3), b = rig(N, N - 900);
  a.drive(3 + N, 4); b.drive(900 + N, 4);
  assert.strictEqual(a.lap.last, b.lap.last);
  // dt that is not a number or not positive adds nothing
  const t = a.lap.time;
  a.lap.update(a.at, 10, NaN); a.lap.update(a.at, 10, -1); a.lap.update(a.at, 10, undefined); a.lap.update(a.at, 10, 0);
  assert.strictEqual(a.lap.time, t);
});

test('odd input does not break the counter', () => {
  const r = rig(1000, 990);
  r.lap.update(NaN, NaN, DT); r.lap.update(undefined, 0, DT); r.lap.update('x', 0, DT);   // read as sample 0
  r.lap.update(990 - 1000, 0, DT);                       // out of range: wrapped
  r.lap.update(990 + 3000, 0, DT);
  assert.strictEqual(r.lap.prevIdx, 990);
  r.lap.reset(-10);
  assert.strictEqual(r.lap.prevIdx, 990);
  r.lap.reset(2990.7);
  assert.strictEqual(r.lap.prevIdx, 990);
  r.at = 990; r.codes.length = 0;
  r.drive(10 + 1000);
  assert.deepStrictEqual(r.codes, [1, 2]);
  const one = createLapCounter(1, 0), zero = createLapCounter(0), none = createLapCounter();
  [one, zero, none].forEach(l => { l.arm(0); l.update(0, 1, DT); l.sync(0); assert.strictEqual(l.progress(0), 0); });
});

test('random driving without jumps: laps = whole loops driven forwards past the furthest line', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 60; run++) {
    const n = 40 + Math.floor(rnd() * 400), start = 1 + Math.floor(rnd() * (n - 1)), armed = rnd() < 0.5;
    const r = rig(n, start, { arm: armed });
    // u: unwrapped samples from the line ahead of the start. Lines are at 0, n, 2n, ...: each one counts
    // the first time the car gets there. The reference only lets the car reverse up to half a lap behind
    // the last line it crossed (whole laps backwards have their own test).
    let u = start - n, line = 0, expect = 0;
    for (let k = 0; k < 6000; k++) {
      let d = rnd() < 0.62 ? 1 + Math.floor(rnd() * 3) : -1 - Math.floor(rnd() * 3);
      if (rnd() < 0.1) d = 0;
      if (u + d <= (line > 0 ? line - n - (n >> 1) : -n)) d = 1;
      u += d;
      r.at = ((u % n) + n) % n;
      const c = r.step();
      let want = 0;
      if (u >= line) {
        want = line > 0 ? 2 : (armed ? 0 : 1);
        if (want === 2) expect++;
        line += n;
      }
      assert.strictEqual(c, want, 'run ' + run + ' step ' + k + ' u ' + u + ' N ' + n);
    }
    assert.strictEqual(r.done(), expect);
    assert.strictEqual(r.lap.jumps, 0);
    assert(near(r.lap.progress(r.at), u / n, 1e-9), 'progress = unwrapped distance in laps');
  }
});

test('random jumps: the counter never gets out of step with itself', () => {
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 40; run++) {
    const n = 200 + Math.floor(rnd() * 3000);
    const r = rig(n, Math.floor(rnd() * n), { arm: rnd() < 0.5 });
    let lastLapStep = 0;
    for (let k = 0; k < 20000; k++) {
      const x = rnd();
      if (x < 0.002) r.at = Math.floor(rnd() * n);                        // teleport
      else if (x < 0.004) { r.lap.sync(r.at); }
      else if (x < 0.8) r.at = (r.at + 1) % n;
      else if (x < 0.9) r.at = (r.at + n - 1) % n;
      const glitch = rnd() < 0.01 ? Math.floor(rnd() * n) : r.at;         // one-step wrong index
      const c = r.step(glitch);
      if (c === 2) {
        assert(r.lap.last > 0 && r.lap.best <= r.lap.last);
        lastLapStep = r.steps;
      }
      assert(r.lap.time >= 0 && r.lap.sector >= 0 && r.lap.sector <= 3);
      assert(r.lap.prevIdx >= 0 && r.lap.prevIdx < n);
      const frac = r.lap.progress() * n;
      assert(near(((Math.round(frac) % n) + n) % n, r.lap.prevIdx) && near(frac, Math.round(frac), 1e-6),
        'progress and the believed index agree');
    }
    assert.strictEqual(r.lap.n, (r.lap.started ? 1 : 0) + r.done());
    assert(lastLapStep >= 0);
  }
});

test('with the Grand Prix rules: every lap of a qualifying and a race is accepted by the session', () => {
  // the session compares each lap with its own clock (rejects a lap longer than the wall time since the
  // previous one + 2 s, or laps that come too quickly); here the wall clock is the simulated time
  const LEN = N * 2, PER = 3;                           // 5806 m at 80 m/s: 72.6 s laps
  const s = createSession({ random: () => 0 });
  let now = 5000000;
  s.addPlayer(1, 'A', now);
  assert.strictEqual(s.start({ q: 2, r: 3, len: LEN }, now), true);
  // qualifying: out lap from the start slot, then 2 timed laps
  let r = rig(N, N - 10), flag = 0;
  const tick = (c) => { now += DT * 1000; s.tick(now); return c; };
  const run = (count) => {
    for (let k = 0; k < count; k++) {
      r.at = (r.at + 1) % N;
      for (let j = 0; j < PER; j++) {
        if (tick(r.step()) !== 2) continue;
        assert.strictEqual(s.lap(1, r.lap.last, now), '', 'lap accepted');
        flag = now;
      }
    }
  };
  run(10 + 2 * N);
  let snap = s.snapshot();
  assert.strictEqual(snap.phase, 'grid');
  assert(near(snap.players[0].qBest, N * PER * DT, 1e-3));
  // lights out: arm on the grid, clock from goAt
  now = snap.goAt; s.tick(now);
  assert.strictEqual(s.phase, 'race');
  r = rig(N, N - 10, { arm: true });
  r.setTime(0);
  run(10 + 3 * N);
  snap = s.snapshot();
  assert.strictEqual(snap.phase, 'results');
  assert.deepStrictEqual([snap.players[0].rLaps, snap.players[0].fin], [3, true]);
  assert(near(snap.players[0].rTime, (flag - snap.goAt) / 1000, 1e-3), 'race time = time since lights out');
  assert(near(snap.players[0].rTime, ((10 + 3 * N) * PER - (PER - 1)) * DT, 1e-3));
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall laps tests passed');
process.exit(failed ? 1 : 0);
