// node devtests/laps-test/drive.js [track-regex] [laps|cross]
//
// Lap counter (js/laps.js) against the REAL track and car: js/car.js stepped at 1/120 s, the counter fed
// exactly as main.js does (update(car.state.sampleIndex, car.state.speed, STEP) after every car.update).
//   laps  : every track: qualifying start (reset, out lap, 2 timed laps) and two race starts (arm on grid
//           slots 0 and 15, 2 laps), driven on the racing line; then a start from every one of the 16 grid
//           slots (arm, drive over the line: nothing is credited; the lap after it counts)
// The car is put on the grid by js/main.js's own placeOnGrid (main-grid.js takes it from the source): each
// slot is a painted grid box, (slot + 1) * 8 m behind the line (devtests/laps-test/grid.js checks the boxes).
//   cross : tracks with a same-level crossing (Suzuka): through the crossover on both roads, both ways,
//           on and beyond the road edge; a real shortcut; the long way round; R reset in the blind zone
// The ground truth is the car's own continuous position (track.locate with a local window, never the
// global re-locate that makes car.state.sampleIndex jump). devtests/laps-test/laps-v0.js is the counter as
// it was before the review; it is fed the same indices to show what it got wrong.
// Exit code 1 when anything the new counter must do fails.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const createV0 = require('./laps-v0.js');
const mainGrid = require('./main-grid.js');
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const F1 = global.F1, TR = global.F1_TRACKS;

const STEP = 1 / 120;                  // main.js
const START_BACK = mainGrid.START_BACK;   // main.js: samples behind the line, alone (placeAtStart)
const GRID_GAP = 8, GRID_BAR = 0.25;      // js/track.js: box k = slot + 1 has its front bar k * 8 m behind the line
const SINCE_GO = 0.0125;               // what main.js puts in lap.time after arm(): gp.sinceGo at that frame
const RACE_LAPS = 2, QUALI_LAPS = 2;

const filter = process.argv[2] && !/^(laps|cross)$/.test(process.argv[2]) ? new RegExp(process.argv[2], 'i') : null;
const only = process.argv.slice(2).find(a => /^(laps|cross)$/.test(a)) || '';
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');

let failures = 0;
function check(ok, what) { if (!ok) { failures++; console.log('    FAIL: ' + what); } return ok; }

// main.js placeOnGrid(slot): the real one
function placeOnGrid(track, car, slot) { return mainGrid(track, car)(slot); }
// Samples the car's centre is behind the line on that slot: nose at the rear edge of the box's front bar.
function gridBack(track, slot) { return ((slot + 1) * GRID_GAP + GRID_BAR + mainGrid.CAR_NOSE) / (track.length / track.samples.length); }

// The car, the counter under test and the old counter, stepped together, with the ground truth alongside.
function createRun(track, car, lap, v0) {
  const N = track.samples.length, st = car.state;
  const wrap = d => d > N / 2 ? d - N : (d < -N / 2 ? d + N : d);
  const run = {
    steps: 0, truth: st.sampleIndex, U: st.sampleIndex === 0 ? 0 : st.sampleIndex - N, lines: 0,
    events: [], v0laps: 0, offSteps: 0, offMax: 0, jumpSteps: 0, voidSteps: 0, backSteps: 0,
    progErr: 0, progDrop: 0, progStep: 0, lastProg: null, hits: 0, grass: 0,
    step(input) {
      car.update(STEP, input, track);
      const c = lap.update(st.sampleIndex, st.speed, STEP);
      if (v0 && v0.update(st.sampleIndex, st.speed, STEP) === 2) run.v0laps++;
      run.steps++;
      const t = track.locate(st.x, st.z, run.truth).index, d = wrap(t - run.truth);
      if (d < 0) run.backSteps++;
      run.U += d; run.truth = t;
      let crossed = false;
      if (Math.floor(run.U / N) >= run.lines) { crossed = true; run.lines = Math.floor(run.U / N) + 1; }
      if (c || crossed) run.events.push({ step: run.steps, code: c, crossed: crossed, last: lap.last, time: lap.time });
      const off = Math.abs(wrap(st.sampleIndex - t));
      if (off > 25) { run.offSteps++; if (off > run.offMax) run.offMax = off; }
      if (lap.jumping) run.jumpSteps++;
      if (lap.void) run.voidSteps++;
      if (st.hit > 0) run.hits++;
      if (st.onGrass) run.grass++;
      const p = lap.progress(st.sampleIndex), e = Math.abs(p - run.U / N);
      if (e > run.progErr) run.progErr = e;
      if (run.lastProg !== null) {
        if (run.lastProg - p > run.progDrop) run.progDrop = run.lastProg - p;
        if (Math.abs(p - run.lastProg) > run.progStep) run.progStep = Math.abs(p - run.lastProg);
      }
      run.lastProg = p;
      return c;
    }
  };
  return run;
}

// Follows the racing line: throttle / brake from the line's colour advice, pure pursuit steering with the
// keys (devtests/raceline-test/test.js, which passes on all 40 tracks).
function lineDriver(track, line, car) {
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  const input = { up: false, down: false, left: false, right: false };
  return function () {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    const L = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    return input;
  };
}

// One stint on the racing line until `crossings` lines were crossed (ground truth), + 1 s.
function stint(track, line, car, lap, v0, crossings) {
  const run = createRun(track, car, lap, v0), drive = lineDriver(track, line, car);
  let after = 0, still = 0;
  while (run.steps < 120 * 900) {
    run.step(drive());
    if (run.lines >= crossings && ++after > 120) break;
    still = Math.abs(car.state.speed) < 0.5 ? still + 1 : 0;
    if (still > 120 * 20) break;                         // the driver is stuck
  }
  return run;
}

function common(run, lap, N, what) {
  check(run.voidSteps === 0, what + ': a lap was void for ' + run.voidSteps + ' steps');
  check(lap.void === false && lap.jumping === false, what + ': void / jumping at the end');
  check(run.progErr < 1e-9, what + ': progress() differs from the distance driven by ' + (run.progErr * N).toFixed(3) + ' samples');
  check(run.progStep <= 3.5 / N, what + ': progress() stepped by ' + (run.progStep * N).toFixed(2) + ' samples');
  check(run.progDrop <= 1.5 / N, what + ': progress() dropped by ' + (run.progDrop * N).toFixed(2) + ' samples');
  check(run.backSteps > 0 || run.progDrop === 0, what + ': progress() dropped although the car never went back');
}

function lapsOnTrack(td) {
  const track = F1.buildTrack(td), line = F1.buildRaceLine(track), car = F1.createCar();
  const N = track.samples.length;
  const out = { id: td.id, name: td.name, N: N, ok: true, offSteps: 0, jumps: 0, back: 0, hits: 0, grass: 0, v0diff: 0, resets: 0 };
  const f0 = failures;

  // --- qualifying / free practice: main.js selectTrack (offline): N - START_BACK, lap.reset(idx)
  let startIdx = ((N - START_BACK) % N + N) % N;
  car.reset(track, startIdx);
  let lap = createLapCounter(N, startIdx), v0 = createV0(N, startIdx);
  lap.reset(startIdx); v0.reset(startIdx);
  let run = stint(track, line, car, lap, v0, 1 + QUALI_LAPS);
  let ev = run.events, what = td.id + ' quali';
  check(run.lines === 1 + QUALI_LAPS, what + ': the driver did not finish (' + run.lines + ' crossings, stuck?)');
  check(ev.length === 1 + QUALI_LAPS && ev.every((e, i) => e.crossed && e.code === (i ? 2 : 1)),
    what + ': expected timing start + ' + QUALI_LAPS + ' laps exactly at the line crossings, got ' + JSON.stringify(ev.map(e => [e.step, e.code, e.crossed])));
  check(lap.n === 1 + QUALI_LAPS && lap.started, what + ': lap.n ' + lap.n);
  const qt = [];
  for (let i = 1; i < ev.length; i++) {
    qt.push(ev[i].last);
    check(Math.abs(ev[i].last - (ev[i].step - ev[i - 1].step) * STEP) < 1e-9, what + ': lap ' + i + ' time ' + ev[i].last + ' != simulated ' + (ev[i].step - ev[i - 1].step) * STEP);
  }
  check(ev.length < 2 || Math.abs(lap.best - Math.min.apply(null, qt)) < 1e-12, what + ': best');
  common(run, lap, N, what);
  out.quali = qt; out.startStep = ev.length ? ev[0].step : -1;
  out.offSteps += run.offSteps; out.jumps += lap.jumps; out.back += run.backSteps; out.hits += run.hits; out.grass += run.grass;
  if (run.v0laps !== QUALI_LAPS || v0.void) out.v0diff++;

  // --- race: main.js 'grid' -> placeOnGrid(slot), lap.reset; 'go' -> lap.arm(idx); lap.time = gp.sinceGo
  out.race = [];
  for (const slot of [0, 15]) {
    const idx = placeOnGrid(track, car, slot);
    const back = (N - idx) % N;
    lap = createLapCounter(N, idx); v0 = createV0(N, idx);
    lap.reset(idx); v0.reset(idx);
    lap.arm(idx); lap.time = SINCE_GO;
    v0.arm(idx); v0.time = SINCE_GO;
    what = td.id + ' race slot ' + slot;
    check(lap.behind && lap.n === 1 && Math.abs(lap.progress(idx) + back / N) < 1e-12 && lap.progress(idx) < 0,
      what + ': on the grid progress ' + lap.progress(idx) + ', ' + back + ' samples back');
    check(Math.abs(back - gridBack(track, slot)) <= 1.5, what + ': grid slot ' + back + ' samples behind the line, expected ' + gridBack(track, slot).toFixed(1));
    run = stint(track, line, car, lap, v0, 1 + RACE_LAPS);
    ev = run.events;
    check(run.lines === 1 + RACE_LAPS, what + ': the driver did not finish (' + run.lines + ' crossings, stuck?)');
    check(ev.length === 1 + RACE_LAPS && ev.every((e, i) => e.crossed && e.code === (i ? 2 : 0)),
      what + ': expected ' + RACE_LAPS + ' laps at the 2nd.. crossings, got ' + JSON.stringify(ev.map(e => [e.step, e.code, e.crossed])));
    check(lap.n === 1 + RACE_LAPS, what + ': lap.n ' + lap.n);
    let total = 0;
    for (let i = 1; i < ev.length; i++) {
      total += ev[i].last;
      const want = i === 1 ? SINCE_GO + ev[1].step * STEP : (ev[i].step - ev[i - 1].step) * STEP;
      check(Math.abs(ev[i].last - want) < 1e-9, what + ': lap ' + i + ' time ' + ev[i].last + ' != ' + want);
    }
    const sim = ev.length ? SINCE_GO + ev[ev.length - 1].step * STEP : 0;
    check(Math.abs(total - sim) < 1e-9, what + ': total ' + total + ' != time since lights out ' + sim);
    common(run, lap, N, what);
    out.race.push({ slot: slot, back: back, total: total, first: ev.length ? ev[0].step * STEP : 0 });
    out.offSteps += run.offSteps; out.jumps += lap.jumps; out.back += run.backSteps; out.hits += run.hits; out.grass += run.grass;
    if (run.v0laps !== RACE_LAPS || v0.void) out.v0diff++;
  }
  // --- all 16 grid slots: where the car ends up, what the armed counter says there, and a real start from
  //     the slot: on the racing line over the line (+ 1 s). That crossing credits nothing; the lap after it
  //     (the counter is fed the rest of the lap) counts.
  let backMin = 1e9, backMax = 0;
  out.launch = 0; out.launchHits = 0;
  for (let slot = 0; slot < 16; slot++) {
    const idx = placeOnGrid(track, car, slot), back = (N - idx) % N;
    backMin = Math.min(backMin, back); backMax = Math.max(backMax, back);
    what = td.id + ' grid slot ' + slot;
    lap = createLapCounter(N, idx);
    lap.reset(idx); lap.arm(idx); lap.time = SINCE_GO;
    check(Math.abs(back - gridBack(track, slot)) <= 1.5, what + ': ' + back + ' samples behind the line, expected ' + gridBack(track, slot).toFixed(1));
    check((car.state.d > 0) === (slot % 2 === 0) && Math.abs(car.state.d) > 2 && Math.abs(car.state.d) < 4, what + ': d ' + car.state.d);
    check(lap.behind && lap.started && lap.n === 1 && Math.abs(lap.progress(idx) + back / N) < 1e-12, what + ': progress ' + lap.progress(idx));
    run = stint(track, line, car, lap, null, 1);
    ev = run.events;
    check(run.lines === 1, what + ': the driver did not reach the line (stuck?)');
    check(ev.length === 1 && ev[0].crossed && ev[0].code === 0, what + ': start: expected one crossing that credits nothing, got ' + JSON.stringify(ev.map(e => [e.step, e.code, e.crossed])));
    check(lap.n === 1 && lap.last === null && !lap.behind && lap.started, what + ': after the line: n ' + lap.n + ', last ' + lap.last + ', behind ' + lap.behind);
    check(ev.length !== 1 || Math.abs(lap.time - (SINCE_GO + run.steps * STEP)) < 1e-9, what + ': the race clock ' + lap.time + ' != time since lights out ' + (SINCE_GO + run.steps * STEP));
    check(run.hits === 0, what + ': ' + run.hits + ' steps against a wall on the way to the line');
    common(run, lap, N, what + ' start');
    check(toLine(lap, N, car.state.sampleIndex) && lap.n === 2 && lap.last !== null, what + ': the first race lap did not count (n ' + lap.n + ')');
    out.launch = Math.max(out.launch, ev.length ? ev[0].step * STEP : 0); out.launchHits += run.hits;
  }
  out.grid = backMin + '..' + backMax;

  // --- R reset (main.js: car.reset(track, car.state.sampleIndex); lap.sync(idx)) with the car 5 m off the
  //     centreline at 30 m/s, right at the line and at the quarter marks: the lap still counts, once
  for (const at of [N - 2, N - 1, 0, 1, N >> 2, (N >> 2) + 1, N >> 1, Math.floor(3 * N / 4), Math.ceil(3 * N / 4)]) {
    for (const off of [5, -5]) {
      const wrap = d => d > N / 2 ? d - N : (d < -N / 2 ? d + N : d), st = car.state;
      placeAt(track, car, at, off, 1, 30);
      lap = primed(createLapCounter, N, st.sampleIndex);      // in its first timed lap, driven up to here
      let laps = 0, U = st.sampleIndex, was = st.sampleIndex;
      for (let k = 0; k < 3; k++) {
        car.update(STEP, {}, track);
        if (lap.update(st.sampleIndex, st.speed, STEP) === 2) laps++;
        U += wrap(st.sampleIndex - was); was = st.sampleIndex;
      }
      car.reset(track, st.sampleIndex);
      lap.sync(st.sampleIndex);
      if (lap.update(st.sampleIndex, 0, STEP) === 2) laps++;
      U += wrap(st.sampleIndex - was);
      what = td.id + ' R reset at sample ' + was + ' (offset ' + off + ')';
      check(Math.abs(wrap(st.sampleIndex - was)) <= 2, what + ': the car was put on sample ' + st.sampleIndex);
      check(!lap.void && !lap.jumping && lap.prevIdx === st.sampleIndex, what + ': void ' + lap.void + ' jumping ' + lap.jumping);
      if (toLine(lap, N, st.sampleIndex)) laps++;
      const expect = Math.floor(U / N) + 1;                   // lines crossed so far + the one toLine drives to
      check(laps === expect && lap.n === expect + 1, what + ': ' + laps + ' laps counted, lap.n ' + lap.n + ', expected ' + expect);
      out.resets++;
    }
  }

  out.ok = failures === f0;
  console.log((out.ok ? 'OK   ' : 'FAIL ') + td.id.padEnd(8) + td.name.slice(0, 26).padEnd(27) + 'N ' + String(N).padStart(4) +
    ' | grid ' + out.grid + ', 16 starts (slot 15 over the line after ' + out.launch.toFixed(2) + ' s)' +
    ' | quali: line ' + (out.startStep * STEP).toFixed(2) + ' s, laps ' + out.quali.map(fmt).join(' ') +
    ' | race ' + out.race.map(r => 's' + r.slot + ': line ' + r.first.toFixed(2) + ' s, ' + RACE_LAPS + ' laps ' + fmt(r.total)).join('; ') +
    ' | ' + out.resets + ' R resets | idx off-road steps ' + out.offSteps + ', jumps ' + out.jumps + ', idx-back steps ' + out.back +
    ', wall ' + out.hits + ', grass ' + out.grass + (out.v0diff ? ' | v0 DIFFERS in ' + out.v0diff + ' stints' : ''));
  line.dispose(); track.dispose();
  return out;
}

/* ---------- the crossover ---------- */

// Holds the lateral offset `off` from the centreline of the road through sample c, in direction dir.
function offsetDriver(track, car, off, vT, dir, get) {
  const S = track.samples, N = S.length, st = car.state, input = {};
  return function () {
    const truth = get();
    const L = Math.max(8, 0.35 * Math.abs(st.speed));
    const tp = S[((truth + dir * Math.round(L / 2)) % N + N) % N];
    const dx = tp.x + tp.nx * off - st.x, dz = tp.z + tp.nz * off - st.z;
    const lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading), kap = 2 * lat / (dx * dx + dz * dz);
    const v = Math.abs(st.speed), lock = 0.35 / (1 + (v / 22) * (v / 22));
    input.steerAxis = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.up = st.speed < vT; input.down = st.speed > vT + 2;
    return input;
  };
}

// A counter that is in its first timed lap and has driven from the line to sample idx.
function primed(create, N, idx) {
  const lap = create(N, N - 1);
  lap.reset(N - 1);
  lap.update(0, 10, 0);
  for (let k = 1; k <= idx; k++) lap.update(k, 10, 0);
  return lap;
}
// ... and drives on from sample `from` to the line: does the lap count?
function toLine(lap, N, from) {
  let c = 0;
  for (let k = from + 1; k <= N && c !== 2; k++) c = lap.update(k % N, 10, 0);
  return c === 2;
}

function placeAt(track, car, idx, off, dir, v) {
  const S = track.samples, N = S.length, st = car.state;
  car.reset(track, ((idx % N) + N) % N);
  const s = S[st.sampleIndex];
  st.x += s.nx * off; st.z += s.nz * off;
  if (dir < 0) st.heading += Math.PI;
  car.update(1e-4, null, track);
  st.speed = v;
}

function through(track, c, off, vT, dir) {
  const N = track.samples.length, car = F1.createCar(), st = car.state;
  const wrap = d => d > N / 2 ? d - N : (d < -N / 2 ? d + N : d);
  const hi = dir > 0 ? c - 80 : c + 80;                  // furthest point of the lap so far
  placeAt(track, car, c - dir * 80, off, dir, vT);
  const lap = primed(createLapCounter, N, hi), v0 = primed(createV0, N, hi);
  if (dir < 0) { lap.update(st.sampleIndex, 1, 0); v0.update(st.sampleIndex, 1, 0); }
  const run = createRun(track, car, lap, v0);
  run.U = st.sampleIndex; run.lines = 1;
  const drive = offsetDriver(track, car, off, vT, dir, () => run.truth);
  const r = { off: off, otherSteps: 0, k0: null, k1: null, o0: null, o1: null, wait: 0, v0void: false };
  while (run.steps < 120 * 90) {
    run.step(drive());
    const k = wrap(run.truth - c);
    if (Math.abs(wrap(st.sampleIndex - run.truth)) > 40) {
      if (r.k0 === null) { r.k0 = k; r.o0 = st.sampleIndex; }
      r.k1 = k; r.o1 = st.sampleIndex; r.otherSteps++;
    }
    if (lap.jumping) r.wait++;
    if (v0.void) r.v0void = true;
    if (dir * k > 60) break;
  }
  const what = 'crossover ' + c + ' dir ' + dir + ' v ' + vT + ' off ' + off;
  check(dir * wrap(run.truth - c) > 60, what + ': the car did not get through');
  check(run.voidSteps === 0 && !lap.void, what + ': lap void');
  check(!lap.jumping && lap.prevIdx === st.sampleIndex, what + ': counter not back on the car (' + lap.prevIdx + ' vs ' + st.sampleIndex + ')');
  check(Math.abs(lap.progress(st.sampleIndex) - run.U / N) < 1e-9, what + ': progress ' + lap.progress(st.sampleIndex) + ' != ' + run.U / N);
  check(run.progStep <= 25 / N, what + ': progress stepped by ' + (run.progStep * N).toFixed(1) + ' samples');
  if (dir > 0) check(run.progDrop <= 1.5 / N, what + ': progress dropped by ' + (run.progDrop * N).toFixed(1) + ' samples');
  r.counted = toLine(lap, N, st.sampleIndex);
  check(r.counted, what + ': the lap did not count');
  r.v0counted = toLine(v0, N, st.sampleIndex);
  r.jumps = lap.jumps; r.maxStep = run.progStep * N; r.hits = run.hits;
  return r;
}

// Along road `a` to the crossing, then turn onto road `b` and drive on (forwards on both).
function turnOnto(track, a, b) {
  const S = track.samples, N = S.length, car = F1.createCar(), st = car.state, input = {};
  const wrap = d => d > N / 2 ? d - N : (d < -N / 2 ? d + N : d);
  placeAt(track, car, a - 60, 0, 1, 8);
  const lap = primed(createLapCounter, N, a - 60);
  let own = st.sampleIndex, onB = false, steps = 0, believedAt = null, trace = [];
  const before = lap.progress(st.sampleIndex);
  while (steps < 120 * 120) {
    if (!onB && wrap(own - a) >= -5) { onB = true; own = b - 2; }
    const tp = S[(own + 5) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z;
    const lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading), kap = 2 * lat / (dx * dx + dz * dz);
    input.steerAxis = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / 0.3));
    input.up = st.speed < 8; input.down = st.speed > 10;
    car.update(STEP, input, track);
    lap.update(st.sampleIndex, st.speed, STEP);
    steps++;
    own = track.locate(st.x, st.z, own).index;
    if (onB && believedAt === null && !lap.jumping && Math.abs(wrap(lap.prevIdx - b)) < 200) believedAt = wrap(st.sampleIndex - b);
    if (steps % 60 === 0) trace.push(st.sampleIndex);
    if (onB && wrap(own - b) > 100) break;
  }
  return { lap: lap, car: car, steps: steps, own: own, before: before, believedAt: believedAt, trace: trace,
    arrived: onB && wrap(own - b) > 100 && Math.abs(wrap(st.sampleIndex - own)) <= 2 };
}

function crossover(td) {
  const track = F1.buildTrack(td), S = track.samples, N = S.length;
  const wrap = d => d > N / 2 ? d - N : (d < -N / 2 ? d + N : d);
  for (const pair of track.crossings) {
    const a0 = S[pair[0]], b0 = S[pair[1]];
    console.log('\n' + td.id + ' ' + td.name + ': crossing of samples ' + pair[0] + ' and ' + pair[1] + ' (N ' + N + ', ' +
      (pair[0] / N).toFixed(3) + ' and ' + (pair[1] / N).toFixed(3) + ' of the lap), roads at ' +
      (Math.acos(Math.abs(a0.tx * b0.tx + a0.tz * b0.tz)) * 180 / Math.PI).toFixed(1) + ' deg, half width ' + a0.halfW + ' m');
    console.log('  per run: [offset m: steps car.state.sampleIndex was on the OTHER road (own samples rel. to the crossing -> other road samples)]');
    let runs = 0, mis = 0, maxSteps = 0, maxSpan = 0, maxOther = 0, v0lost = 0, v0void = 0, maxWait = 0;
    for (const c of pair) {
      for (const dir of [1, -1]) {
        for (const vT of [70, 25, 6]) {
          const parts = [];
          for (const off of [0, 3, 5.5, 7.5, 9, 11, -3, -5.5, -7.5, -9, -11]) {
            const r = through(track, c, off, vT, dir);
            runs++;
            if (r.otherSteps) {
              mis++;
              maxSteps = Math.max(maxSteps, r.otherSteps); maxSpan = Math.max(maxSpan, Math.abs(r.k1 - r.k0));
              maxOther = Math.max(maxOther, Math.abs(wrap(r.o1 - r.o0))); maxWait = Math.max(maxWait, r.wait);
              parts.push(off + ': ' + r.otherSteps + ' (' + r.k0 + '..' + r.k1 + ' -> ' + r.o0 + '..' + r.o1 + ')' +
                (r.v0counted ? '' : ' v0:LAP LOST'));
            }
            if (!r.v0counted) v0lost++;
            if (r.v0void) v0void++;
          }
          console.log('  road ' + c + (dir > 0 ? ' forwards ' : ' wrong way') + ' at ' + String(vT).padStart(2) + ' m/s: ' + (parts.join('  ') || 'index never left the road'));
        }
      }
    }
    console.log('  ' + runs + ' runs, index on the other road in ' + mis + ' (only beyond the road edge): up to ' + maxSteps + ' steps (' +
      (maxSteps * STEP).toFixed(1) + ' s), over up to ' + maxSpan + ' samples of the car\'s own road, moving up to ' + maxOther + ' samples along the other road');
    console.log('  new counter: every lap counted, never void, waited out up to ' + maxWait + ' steps; old counter (v0): void in ' + v0void + ' runs, lap lost in ' + v0lost);

    const lo = Math.min(pair[0], pair[1]), hi = Math.max(pair[0], pair[1]);
    const short = tr => { const j = tr.findIndex((v, i) => i && Math.abs(wrap(v - tr[i - 1])) > 40); return tr.slice(Math.max(0, j - 3), j + 3).join(' '); };

    // a whole race (grid slot 0, 2 laps) on the racing line, running 9 m wide at 12 m/s through the
    // crossover on both roads in lap 1: what main.js would see
    {
      const line = F1.buildRaceLine(track), car = F1.createCar(), idx = placeOnGrid(track, car, 0);
      const lap = createLapCounter(N, idx), v0 = createV0(N, idx);
      lap.arm(idx); lap.time = SINCE_GO; v0.arm(idx); v0.time = SINCE_GO;
      const run = createRun(track, car, lap, v0), drive = lineDriver(track, line, car);
      const wideLo = offsetDriver(track, car, 9, 12, 1, () => run.truth), wideHi = offsetDriver(track, car, -9, 12, 1, () => run.truth);
      let after = 0, frozen = 0;
      while (run.steps < 120 * 600) {
        const kl = wrap(run.truth - lo), kh = wrap(run.truth - hi), lap1 = run.lines === 1;
        run.step(lap1 && kl > -120 && kl < 25 ? wideLo() : (lap1 && kh > -120 && kh < 25 ? wideHi() : drive()));
        if (lap.jumping) frozen++;
        if (run.lines >= 3 && ++after > 120) break;
      }
      const ev = run.events, what = td.id + ' race, wide at the crossover';
      check(run.offSteps > 100, what + ': the index was on the other road for only ' + run.offSteps + ' steps');
      check(ev.length === 3 && ev.every((e, i) => e.crossed && e.code === (i ? 2 : 0)), what + ': got ' + JSON.stringify(ev.map(e => [e.step, e.code, e.crossed])));
      check(run.voidSteps === 0 && !lap.void && lap.n === 3, what + ': void steps ' + run.voidSteps + ', lap.n ' + lap.n);
      check(ev.length === 3 && Math.abs(ev[1].last + ev[2].last - (SINCE_GO + ev[2].step * STEP)) < 1e-9, what + ': total time');
      check(run.progDrop === 0 && run.progStep <= 25 / N && run.progErr <= 25 / N, what + ': progress drop ' + run.progDrop * N + ' step ' + run.progStep * N + ' err ' + run.progErr * N + ' samples');
      console.log('  race from slot 0, 9 m wide at 12 m/s through both roads of the crossover in lap 1: index on the other road for ' + run.offSteps +
        ' steps; new counter: laps ' + (lap.n - 1) + ' of 2 (' + ev.slice(1).map(e => fmt(e.last)).join(' ') + '), never void, progress held for ' + frozen +
        ' steps, caught up by at most ' + (run.progStep * N).toFixed(0) + ' samples; old counter (v0): laps ' + run.v0laps + ' of 2' + (run.v0laps < 2 ? '  <-- LAP LOST' : ''));
      line.dispose();
    }

    // a real shortcut (early road -> late road) and the long way round (late -> early)
    let t = turnOnto(track, lo, hi), lap = t.lap, st = t.car.state;
    console.log('  shortcut ' + lo + ' -> ' + hi + ': index each 0.5 s ... ' + short(t.trace) + ' ...; believed ' + t.believedAt + ' samples past the crossing');
    check(t.arrived, 'shortcut: the car did not get onto the other road');
    check(lap.void && lap.behind && !lap.jumping && lap.prevIdx === st.sampleIndex, 'shortcut: not void (void ' + lap.void + ', jumping ' + lap.jumping + ')');
    check(Math.abs(lap.progress(st.sampleIndex) - (st.sampleIndex / N - 1)) < 1e-9 && lap.progress(st.sampleIndex) < t.before, 'shortcut: progress ' + lap.progress(st.sampleIndex));
    check(!toLine(lap, N, st.sampleIndex) && lap.n === 1 && !lap.void && lap.time === 0, 'shortcut: the lap counted, or the clock did not restart at the line');
    check(toLine(lap, N, 0) && lap.n === 2, 'shortcut: the lap after it did not count');
    console.log('    -> void, progress a lap back, nothing at the line, clock restarted, next lap counted');

    t = turnOnto(track, hi, lo); lap = t.lap; st = t.car.state;
    console.log('  long way ' + hi + ' -> ' + lo + ': index each 0.5 s ... ' + short(t.trace) + ' ...; believed ' + t.believedAt + ' samples past the crossing');
    check(t.arrived, 'long way: the car did not get onto the other road');
    check(!lap.void && !lap.behind && !lap.jumping && lap.prevIdx === st.sampleIndex, 'long way: void ' + lap.void + ', jumping ' + lap.jumping);
    check(Math.abs(lap.progress(st.sampleIndex) - st.sampleIndex / N) < 1e-9, 'long way: progress ' + lap.progress(st.sampleIndex));
    check(toLine(lap, N, st.sampleIndex) && lap.n === 2, 'long way: the lap did not count');
    console.log('    -> not void, ground lost, the lap counted at the line');

    // R reset while the index is on the other road (main.js: car.reset(track, car.state.sampleIndex); lap.sync(idx))
    for (const useBelieved of [false, true]) {
      const car = F1.createCar();
      st = car.state;
      placeAt(track, car, lo - 40, 9, 1, 6);
      lap = primed(createLapCounter, N, lo - 40);
      let own = st.sampleIndex, steps = 0;
      const drive = offsetDriver(track, car, 9, 6, 1, () => own);
      while (steps++ < 120 * 60 && Math.abs(wrap(st.sampleIndex - own)) < 40) {
        car.update(STEP, drive(), track);
        lap.update(st.sampleIndex, st.speed, STEP);
        own = track.locate(st.x, st.z, own).index;
      }
      for (let k = 0; k < 30; k++) { car.update(STEP, drive(), track); lap.update(st.sampleIndex, st.speed, STEP); }
      const was = st.sampleIndex, believed = lap.prevIdx, jumping = lap.jumping;
      car.reset(track, useBelieved && lap.jumping ? lap.prevIdx : st.sampleIndex);
      lap.sync(st.sampleIndex);
      lap.update(st.sampleIndex, 0, STEP);
      console.log('  R reset in the blind zone (car.state.sampleIndex ' + was + ', counter believes ' + believed + ', jumping ' + jumping + '), ' +
        (useBelieved ? 'reset to lap.prevIdx' : 'reset to car.state.sampleIndex (main.js today)') + ': car now at ' + st.sampleIndex +
        ', void ' + lap.void + ', progress ' + lap.progress(st.sampleIndex).toFixed(4));
      if (useBelieved) check(!lap.void && Math.abs(wrap(st.sampleIndex - lo)) < 30, 'R reset to lap.prevIdx: left the road');
      else check(lap.void && Math.abs(wrap(st.sampleIndex - hi)) < 30 && !toLine(lap, N, st.sampleIndex), 'R reset onto the other road must void the lap');
    }
  }
  track.dispose();
}

const t0 = Date.now();
const tracks = TR.filter(td => !filter || filter.test(td.id) || filter.test(td.name));
let okTracks = 0, nLaps = 0, offTracks = [];
if (only !== 'cross') {
  console.log('laps on the racing line, ' + tracks.length + ' tracks: reset + out lap + ' + QUALI_LAPS + ' timed laps; arm on grid slots 0 and 15 + ' + RACE_LAPS + ' laps');
  for (const td of tracks) {
    const o = lapsOnTrack(td);
    if (o.ok) okTracks++;
    nLaps += QUALI_LAPS + 2 * RACE_LAPS;
    if (o.offSteps || o.jumps) offTracks.push(td.id);
  }
  console.log('laps: ' + okTracks + ' / ' + tracks.length + ' tracks ok, ' + nLaps + ' laps expected; index left the road it was on during laps: ' +
    (offTracks.join(', ') || 'never') + '   (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}
if (only !== 'laps') {
  const t1 = Date.now();
  for (const td of tracks) {
    const track = F1.buildTrack(td), has = track.crossings.length > 0;
    track.dispose();
    if (has || offTracks.indexOf(td.id) >= 0) crossover(td);
  }
  console.log('crossover checks: ' + ((Date.now() - t1) / 1000).toFixed(1) + ' s');
}
console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nall lap drive checks passed' + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(failures ? 1 : 0);
