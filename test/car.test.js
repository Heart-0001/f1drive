// node test/car.test.js — the car (js/car.js): the golden rule against the v5 car, CarSpec / perf, drivetrain,
// battery (ERS), pit limiter, tyres, pit lane. Loads three, tracks-data, scenery-data (the pit side follows the real
// pit buildings, as in the game), js/track.js, js/tyres.js, js/car.js, js/raceline.js; the v5 car
// (devtests/car-v6/car-v5.js = git show HEAD:js/car.js before v6) runs in a sandbox of its own.
'use strict';
const assert = require('assert');
const path = require('path'), fs = require('fs'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const F1 = global.F1;
function sandbox(file) {
  const g = {}; g.globalThis = g;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), g, { filename: path.basename(file) });
  return g.F1;
}
const V5 = sandbox(path.join(ROOT, 'devtests/car-v6/car-v5.js'));
const ALONE = sandbox(path.join(ROOT, 'js/car.js'));        // js/car.js without js/tyres.js (the node devtests load it so)

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}
const info = s => console.log('       ' + s);
const STEP = 1 / 120;
const KMH = 3.6;
const near = (a, b, e, what) => assert(Math.abs(a - b) <= e, (what || '') + ' ' + a + ' !~ ' + b + ' (tol ' + e + ')');

// ---- tracks -----------------------------------------------------------------------------------------------------
const built = {};
function track(id) {
  if (!built[id]) {
    const td = global.F1_TRACKS.find(t => t.id === id);
    const tr = F1.buildTrack(td);
    built[id] = { track: tr, line: F1.buildRaceLine(tr) };
  }
  return built[id];
}
// flat straight strip, no walls (car-test / gamepad-test style)
function strip(len) {
  const a = [], n = Math.round((len || 20000) / 2);
  for (let i = 0; i < n; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: false, wallNeg: false, halfW: 50, wallPosDist: 60, wallNegDist: 60 });
  return { samples: a, halfWidth: 50, wallDist: 60, length: n * 2, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
}
// pure pursuit of the centreline (+ offset): steering target -1..1 (+ = left)
function pursuit(tr, st, dOff) {
  const S = tr.samples, N = S.length, ds = tr.length / N, v = Math.max(0, st.speed);
  const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), s = S[(st.sampleIndex + Math.round(L / ds)) % N];
  const dx = s.x + s.nx * (dOff || 0) - st.x, dz = s.z + s.nz * (dOff || 0) - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
  const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
  return Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
}
function keysSteer(inp, st, want) { inp.left = want > st.steer + 0.03; inp.right = want < st.steer - 0.03; }
// the racing line: throttle on green, brake on red, pursuit (devtests/laps-test/drive.js)
function lineWant(tr, line, st) {
  line.update(st);
  const S = tr.samples, N = S.length, ds = tr.length / N, P = line.points, v = Math.max(0, st.speed);
  const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
  const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
  const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
  return { level: line.levels[2], steer: Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock)) };
}

// ==================================================================================================================
// 1. THE GOLDEN RULE: recorded input sequences, the v5 car vs the new car (F1.createCar(), tyres at wear rate 0,
//    no boost / limiter), every state value of the v5 car compared after every step
// ==================================================================================================================
const V5_KEYS = ['x', 'y', 'z', 'heading', 'speed', 'steer', 'pitch', 'roll', 'sampleIndex', 'd', 'onGrass', 'hit'];
const snap = st => V5_KEYS.map(k => st[k]);
function apply(car, tr, a) {
  if (a.reset !== undefined) car.reset(tr, a.reset);
  else if (a.place) {                     // main.js placeOnGrid: reset, move, re-locate with a tiny update, stop
    car.reset(tr, a.place.index);
    car.state.heading = a.place.heading; car.state.x = a.place.x; car.state.z = a.place.z;
    car.update(1e-4, null, tr); car.state.speed = 0;
  } else car.update(a.dt, a.input, tr);
}
// the pit complex (off the road on the pit side of from..to): the v6 car differs there on purpose (asphalt, pit wall)
function inPitArea(tr, st) {
  const pit = tr.pit; if (!pit) return false;
  const N = tr.samples.length, k = ((st.sampleIndex - pit.from) % N + N) % N, K = ((pit.to - pit.from) % N + N) % N;
  return k <= K + 3 && st.d * pit.side > tr.samples[st.sampleIndex].halfW - 0.5;
}
// Drives the v5 car with the scenario's controller (closed loop) and records every action and the state after it.
function record(id, sc) {
  const { track: tr } = track(id), car = V5.createCar(), st = car.state;
  const acts = [], traj = [];
  const inp = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null };
  let pit = 0, t = 0, k = 0;
  const push = a => { apply(car, tr, a); acts.push(a); traj.push(snap(st)); if (inPitArea(tr, st)) pit++; };
  push({ reset: sc.start });
  if (sc.setup) sc.setup(tr).forEach(push);
  while (t < sc.T) {
    const extra = sc.ctl(tr, st, t, inp, k);
    if (extra) push(extra);
    // odd frame times too: a 31 ms frame every 97 steps, one 0.2 s hitch (clamped to 0.1), a zero dt
    const dt = k % 97 === 96 ? 0.031 : (k === 400 ? 0.2 : (k === 401 ? 0 : STEP));
    push({ dt, input: Object.assign({}, inp) });
    t += Math.min(dt, 0.1); k++;
  }
  return { acts, traj, pit };
}
// Replays the recording on a car; -> {steps, values, exact, maxDiff, first}
function replay(id, rec, car, extraInput) {
  const { track: tr } = track(id), st = car.state;
  let values = 0, exact = 0, maxDiff = 0, first = null;
  for (let i = 0; i < rec.acts.length; i++) {
    let a = rec.acts[i];
    if (a.input && extraInput) a = { dt: a.dt, input: Object.assign({}, a.input, extraInput) };
    apply(car, tr, a);
    const want = rec.traj[i];
    for (let j = 0; j < V5_KEYS.length; j++) {
      const x = st[V5_KEYS[j]], y = want[j];
      values++;
      if (Object.is(x, y)) { exact++; continue; }
      const diff = typeof y === 'number' && typeof x === 'number' ? Math.abs(x - y) : Infinity;
      if (diff > maxDiff) maxDiff = diff;
      if (diff > 1e-9 && !first) first = 'step ' + i + ' ' + V5_KEYS[j] + ': ' + x + ' vs v5 ' + y;
    }
  }
  return { steps: rec.acts.length, values, exact, maxDiff, first };
}

const GOLDEN_TRACKS = ['it-1922', 'mc-1929', 'be-1925', 'jp-1962', 'au-1953', 'az-2016'];
function scenarios(id) {
  const { track: tr, line } = track(id), N = tr.samples.length, at = f => Math.round(f * N) % N;
  const L = [];
  // full-throttle launch from the free-practice start (10 samples before the line), keys, centreline pursuit;
  // a hard lift after 7 s so the car stays on the road through the first corner
  L.push({ name: 'launch', start: N - 10, T: 12, ctl: (tr, st, t, inp) => {
    keysSteer(inp, st, pursuit(tr, st)); inp.up = t < 7 || st.speed < 25; inp.down = t >= 7 && st.speed > 40;
  } });
  // analog launch from grid slot 5 (placed as main.js's placeOnGrid does), stick steering
  L.push({ name: 'grid launch (pad)', start: 0, T: 8,
    setup: tr => [{ place: { index: tr.grid[5].index, heading: tr.grid[5].heading,
      x: tr.grid[5].x - Math.sin(tr.grid[5].heading) * 2.8, z: tr.grid[5].z - Math.cos(tr.grid[5].heading) * 2.8 } }],
    ctl: (tr, st, t, inp) => { inp.throttle = t < 6 ? 1 : null; inp.brake = t >= 6 ? 0.8 : null; inp.steerAxis = pursuit(tr, st) || null; } });
  // braking: run-up, full brake to a stop, keep braking (reverses), throttle while reversing (brakes), nothing (hill hold)
  L.push({ name: 'braking + reverse', start: at(0.35), T: 17, ctl: (tr, st, t, inp) => {
    const w = pursuit(tr, st);
    if (t < 6) { inp.up = true; inp.down = false; keysSteer(inp, st, w); }
    else if (t < 12) { inp.up = false; inp.down = true; inp.left = inp.right = false; }
    else if (t < 13) { inp.up = true; inp.down = false; }
    else if (t < 14) { inp.up = false; inp.down = false; inp.brake = 0.5; }
    else { inp.up = inp.down = false; inp.brake = null; }
  } });
  // slalom: keys, then a sine on the stick, analog throttle; an R reset in the middle
  L.push({ name: 'slalom + R', start: at(0.55), T: 18, ctl: (tr, st, t, inp, k) => {
    inp.throttle = 0.7;
    if (t < 4) keysSteer(inp, st, pursuit(tr, st));
    else if (t < 9) { const l = Math.floor(t / 0.5) % 2 === 0; inp.left = l; inp.right = !l; }
    else if (t < 14) { inp.left = inp.right = false; inp.steerAxis = Math.sin(t * 3) * 0.8; }
    else { inp.steerAxis = null; keysSteer(inp, st, pursuit(tr, st)); }
    if (k === Math.round(14 / STEP)) return { reset: st.sampleIndex };
    return null;
  } });
  // walls: scrape the left one, cross to the right one, reverse into it, drive on
  L.push({ name: 'walls', start: at(0.45), T: 16, ctl: (tr, st, t, inp) => {
    inp.steerAxis = null;
    if (t < 5) { inp.up = true; inp.down = false; keysSteer(inp, st, pursuit(tr, st)); }
    else if (t < 8) { inp.up = true; inp.left = true; inp.right = false; }
    else if (t < 11) { inp.up = true; inp.left = false; inp.right = true; }
    else if (t < 13) { inp.up = false; inp.down = true; inp.left = true; inp.right = false; }
    else { inp.down = false; inp.up = true; keysSteer(inp, st, pursuit(tr, st)); }
  } });
  // grass: off the road to the left at speed, along the grass, back
  L.push({ name: 'grass', start: at(0.65), T: 14, ctl: (tr, st, t, inp) => {
    inp.up = true;
    if (t < 5) keysSteer(inp, st, pursuit(tr, st));
    else if (t < 10) { inp.left = inp.right = false; inp.steerAxis = pursuit(tr, st, Math.min(9.5, tr.samples[st.sampleIndex].halfW + 2.5)); }
    else { inp.steerAxis = pursuit(tr, st); }
  } });
  // a racing lap on the line (keys), from the free-practice start
  L.push({ name: 'racing-line lap', start: N - 10, T: id === 'mc-1929' ? 90 : 75, ctl: (tr, st, t, inp) => {
    const w = lineWant(tr, line, st), v = st.speed;
    inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, st, w.steer);
  } });
  // the same with analog pedals and the stick
  L.push({ name: 'racing line (pad)', start: at(0.2), T: 30, ctl: (tr, st, t, inp) => {
    const w = lineWant(tr, line, st), v = st.speed;
    inp.throttle = w.level < 0.45 || v < 5 ? 1 : (w.level < 0.6 ? 0.25 : null);
    inp.brake = w.level >= 0.6 && v >= 5 ? Math.min(1, 0.4 + (w.level - 0.6) * 1.5) : null;
    inp.steerAxis = w.steer || null;
  } });
  return L;
}

const recordings = {};
test('golden rule: the new car (tyres at wear rate 0, no boost / limiter) replays the v5 car\'s recorded runs within 1e-9 at every step', () => {
  let values = 0, exact = 0, steps = 0, maxDiff = 0, runs = 0, stats = { hits: 0, grass: 0, rev: 0, resets: 0 };
  for (const id of GOLDEN_TRACKS) {
    for (const sc of scenarios(id)) {
      const rec = record(id, sc);
      recordings[id + '/' + sc.name] = rec;
      assert.strictEqual(rec.pit, 0, id + ' ' + sc.name + ': the scenario drives into the pit complex (' + rec.pit + ' steps): choose another start');
      rec.traj.forEach(s => { if (s[11] > 0) stats.hits++; if (s[10]) stats.grass++; if (s[4] < -0.5) stats.rev++; });
      stats.resets += rec.acts.filter(a => a.reset !== undefined).length;
      // the new car, fresh medium tyres frozen (rate 0); every other run also passes boost / limiter false explicitly
      const car = F1.createCar(); car.tyres.setWearRate(0);
      const r = replay(id, rec, car, runs % 2 ? { boost: false, limiter: false } : null);
      assert(!r.first, id + ' ' + sc.name + ': ' + r.first);
      values += r.values; exact += r.exact; steps += r.steps; maxDiff = Math.max(maxDiff, r.maxDiff); runs++;
    }
  }
  assert(stats.hits > 100 && stats.grass > 100 && stats.rev > 100, 'the runs exercise walls, grass and reversing: ' + JSON.stringify(stats));
  info(runs + ' runs on ' + GOLDEN_TRACKS.length + ' tracks, ' + steps + ' steps, ' + values + ' values: ' + exact + ' bit-identical, max |diff| ' + maxDiff +
    ' (wall steps ' + stats.hits + ', grass ' + stats.grass + ', reversing ' + stats.rev + ', R resets ' + stats.resets + ')');
});

test('golden rule: the game\'s default car (fresh mediums at wear rate 1, ERS harvesting, spec REF_SPEC) is bit-identical while the grip is 1', () => {
  let n = 0;
  // (runs without impacts, grass or heavy slides: those change the tyres at once - flat spots, dirt - as they should)
  for (const key of ['it-1922/racing-line lap', 'be-1925/racing-line lap', 'jp-1962/racing-line lap', 'az-2016/racing-line lap', 'au-1953/braking + reverse']) {
    const id = key.split('/')[0], car = F1.createCar(F1.REF_SPEC);
    assert.strictEqual(car.tyres.wearRate, 1);
    const r = replay(id, recordings[key], car);
    const g = car.tyres.state.grip;
    if (g.lat === 1 && g.brake === 1 && g.traction === 1) { assert(!r.first, key + ': ' + r.first); n++; }
    else info(key + ': grip left 1 (' + JSON.stringify(g) + '), not compared');
    assert(car.tyres.state.wear.every(w => w > 0), key + ': the tyres were fed (wear ' + car.tyres.state.wear + ')');
  }
  assert(n >= 4, 'compared ' + n);
});

test('golden rule: boost does nothing on a car without ERS, the limiter nothing below its speed', () => {
  const rec = recordings['it-1922/racing-line lap'];
  const noErs = F1.createCar(Object.assign({}, F1.REF_SPEC, { ers: null })); noErs.tyres.setWearRate(0);
  let r = replay('it-1922', rec, noErs, { boost: true });
  assert(!r.first, 'boost without ERS: ' + r.first);
  assert.strictEqual(noErs.state.battery, 0);
  // a slow run round Monaco (keys, kept under 50 km/h: the limiter fades the drive from 58.2 km/h on)
  const N = track('mc-1929').track.samples.length;
  const slow = record('mc-1929', { name: 'slow', start: Math.round(N * 0.3), T: 25, ctl: (tr, st, t, inp) => {
    keysSteer(inp, st, pursuit(tr, st)); inp.up = st.speed * KMH < 50; inp.down = st.speed * KMH > 54;
  } });
  assert.strictEqual(slow.pit, 0);
  assert(Math.max(...slow.traj.map(s => Math.abs(s[4]))) * KMH < 57, 'stays slow');
  const lim = F1.createCar(); lim.tyres.setWearRate(0);
  r = replay('mc-1929', slow, lim, { limiter: true });
  assert(!r.first, 'limiter below the limit: ' + r.first);
  assert.strictEqual(lim.state.limiter, true);
});

test('golden rule: js/car.js without js/tyres.js (node devtests) is the v5 car, car.tyres null', () => {
  const car = ALONE.createCar();
  assert.strictEqual(car.tyres, null);
  const r = replay('be-1925', recordings['be-1925/walls'], car);
  assert(!r.first, r.first);
  assert.strictEqual(F1.createCar(null, { tyres: false }).tyres, null, 'opts.tyres false: none');
});

// ==================================================================================================================
// 2. CarSpec, F1.REF_SPEC, F1.carPerf
// ==================================================================================================================
test('REF_SPEC: the v5 physics constants, 8 gears, the contract\'s drivetrain, 6-cyl hybrid, ERS, halo18', () => {
  const R = F1.REF_SPEC, P5 = V5.CAR_PERF;
  assert.strictEqual(R.power, P5.power); assert.strictEqual(R.dragK, P5.dragK); assert.strictEqual(R.downforce, P5.downforce);
  assert.strictEqual(R.latBase, P5.latBase); assert.strictEqual(R.latMax, P5.latMax); assert.strictEqual(R.brakeBase, P5.brakeBase);
  assert.strictEqual(R.traction, P5.traction);
  assert.deepStrictEqual(R.gearKmh, [60, 100, 140, 180, 220, 260, 300]); assert.strictEqual(R.topKmh, 345);
  // rpmMax 15 000: the V6 regulation limit, as every other V6 season (review S6). It only caps rpmFor, which the reference
  // car reaches at 439 km/h in 8th (deploying it tops out at 346): physics and sound at the shift point are unchanged.
  assert.deepStrictEqual([R.rpmIdle, R.rpmShift, R.rpmMax, R.shiftTime, R.cylinders, R.aspiration, R.cockpit], [4000, 11800, 15000, 0.05, 6, 'hybrid', 'halo18']);
  assert(F1.carPerf(R).topSpeedBoost * KMH * R.rpmShift / R.topKmh < 12500, 'rpm never reaches the old 12 500 ceiling either');
  assert(/^[a-z0-9-]{1,40}$/.test(R.id), R.id);
  assert(R.ers && R.ers.store > 0 && R.ers.power > 0 && R.ers.harvest > 0);
  near(R.ers.store / R.ers.power, 32, 1e-9, 'a full store deploys for 32 s');
  near(R.ers.power / P5.power, 0.15, 1e-12, 'ers.power = 0.15 x the engine');
  assert.deepStrictEqual(Object.keys(R).sort(), ['aspiration', 'brakeBase', 'car', 'cockpit', 'colour', 'colour2', 'cylinders', 'downforce', 'dragK',
    'engine', 'ers', 'gearKmh', 'id', 'latBase', 'latMax', 'note', 'power', 'ratings', 'rpmIdle', 'rpmMax', 'rpmShift', 'shiftTime', 'team', 'teamZh',
    'topKmh', 'traction', 'year'].sort());
  assert.strictEqual(F1.carPerf(R).gears, 8);
});

const GRID = [];
for (const v of [0, 0.5, 5, 20, 50, 91.7, 120, -15]) for (const b of [-0.12, 0, 0.07]) for (const p of [-0.06, 0, 0.04]) for (const kv of [-0.01, 0, 0.003]) for (const la of [-35, 0, 14]) GRID.push([v, b, p, kv, la]);
test('F1.CAR_PERF = F1.carPerf(REF_SPEC): every v5 field and function value identical, v5 keys first in the same order', () => {
  const P5 = V5.CAR_PERF;
  for (const P of [F1.CAR_PERF, F1.carPerf(F1.REF_SPEC), F1.carPerf(), F1.carPerf({})]) {
    assert.deepStrictEqual(Object.keys(P).slice(0, Object.keys(P5).length), Object.keys(P5));
    for (const k of Object.keys(P5)) {
      if (typeof P5[k] !== 'function') { assert(Object.is(P[k], P5[k]), k + ': ' + P[k] + ' vs ' + P5[k]); continue; }
      for (const g of GRID) assert(Object.is(P[k](...g), P5[k](...g)), k + '(' + g + '): ' + P[k](...g) + ' vs ' + P5[k](...g));
    }
    for (const k of ['gearFor', 'rpmFor']) assert.strictEqual(typeof P[k], 'function', k);
    assert.strictEqual(P.topSpeed, 330 / 3.6);
  }
});

test('carPerf: top speed where power balances drag + rolling resistance; the numbers follow the spec', () => {
  const R = F1.REF_SPEC, P0 = F1.CAR_PERF;
  const pw = F1.carPerf(Object.assign({}, R, { power: R.power * 1.05 }));
  near((pw.dragK * pw.topSpeed * pw.topSpeed + pw.roll) * pw.topSpeed, R.power * 1.05, 1e-9 * R.power, 'power balance');
  assert(pw.topSpeed > P0.topSpeed && pw.topSpeed < P0.topSpeed * 1.02, 'more power, a little faster: ' + pw.topSpeed * KMH);
  const dr = F1.carPerf(Object.assign({}, R, { dragK: R.dragK * 1.1 }));
  assert(dr.topSpeed < P0.topSpeed, 'more drag, slower'); assert(dr.brakeDrag > P0.brakeDrag, 'more drag under braking too');
  const df = F1.carPerf(Object.assign({}, R, { downforce: R.downforce * 1.2 }));
  assert(df.maxLatAccel(60, 0, 0, 0, 1) > P0.maxLatAccel(60, 0, 0, 0, 1), 'more downforce, more grip at speed');
  near(df.maxLatAccel(0, 0, 0, 0, 1), P0.maxLatAccel(0, 0, 0, 0, 1), 1e-12, 'but not standing');
  near(df.latAero, df.muLat * df.downforce, 1e-15, 'latAero = muLat * downforce');
  const gr = F1.carPerf(Object.assign({}, R, { latBase: 22, latMax: 48, brakeBase: 13, traction: 12 }));
  near(gr.maxLatAccel(0, 0, 0, 0, 1), 22 * 9.81 / 9.81, 1e-9, 'mechanical grip'); near(gr.maxDecel(0, 0, 0, 0, 0), 13 + 0.5, 1e-9, 'brakes + roll');
  near(gr.maxAccel(1, 0, 0, 0, 0), 12 - 0.5 - gr.dragK, 1e-9, 'traction');
  // traction-capped top speed: lots of power, little traction
  const tc = F1.carPerf(Object.assign({}, R, { power: R.power * 3, traction: 4 }));
  near(tc.topSpeed, Math.sqrt((4 - 0.5) / R.dragK), 1e-9, 'traction cap');
  assert(P0.topSpeedBoost * KMH > 340 && P0.topSpeedBoost * KMH < 352, 'deploying: ' + P0.topSpeedBoost * KMH);
});

test('drivetrain formula: gearFor (hysteresis 8 km/h), rpmFor (rpmShift * v / top(g), idle floor, max ceiling)', () => {
  const P = F1.CAR_PERF, g = kmh => P.gearFor(kmh / KMH);
  assert.deepStrictEqual([0, 0.4 * KMH, 30, 59.9, 60, 99, 100, 139, 140, 179, 180, 219, 220, 259, 260, 299, 300, 345, 400].map(g),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8]);
  assert.strictEqual(P.gearFor(-0.6), -1); assert.strictEqual(P.gearFor(NaN), 0);
  // hysteresis: from gear 3 down to 2 only below 100 - 8 = 92 km/h; up to 4 at 140
  assert.strictEqual(P.gearFor(95 / KMH, 3), 3); assert.strictEqual(P.gearFor(91.9 / KMH, 3), 2);
  assert.strictEqual(P.gearFor(135 / KMH, 4), 4); assert.strictEqual(P.gearFor(131.9 / KMH, 4), 3);
  assert.strictEqual(P.gearFor(139.9 / KMH, 3), 3); assert.strictEqual(P.gearFor(140 / KMH, 3), 4);
  assert.strictEqual(P.gearFor(250 / KMH, 2), 6, 'several gears at once upwards'); assert.strictEqual(P.gearFor(50 / KMH, 7), 1, 'and downwards');
  near(P.rpmFor(100 / KMH, 3), 11800 * 100 / 140, 1e-9); near(P.rpmFor(330 / KMH, 8), 11800 * 330 / 345, 1e-9);
  assert.strictEqual(P.rpmFor(0.1, 0), 4000); assert.strictEqual(P.rpmFor(10 / KMH, 1), 4000, 'idle floor');
  near(P.rpmFor(400 / KMH, 8), 11800 * 400 / 345, 1e-9, 'under the ceiling at 400 km/h');
  assert.strictEqual(P.rpmFor(500 / KMH, 8), 15000, 'ceiling'); near(P.rpmFor(-40 / KMH, -1), 11800 * 40 / 60, 1e-9, 'reverse on gear 1');
  near(P.rpmFor(150 / KMH), 11800 * 150 / 180, 1e-9, 'gear from the speed when not given');
  const v8 = F1.carPerf(Object.assign({}, F1.REF_SPEC, { gearKmh: [90, 130, 170, 210, 250, 290], topKmh: 320, rpmIdle: 5000, rpmShift: 18000, rpmMax: 18000, cylinders: 8, aspiration: 'na' }));
  assert.strictEqual(v8.gears, 7); assert.strictEqual(v8.gearFor(300 / KMH), 7); near(v8.rpmFor(300 / KMH, 7), 18000 * 300 / 320, 1e-9);
});

test('sanitised specs: missing / wrong / absurd fields fall back to the reference, never NaN physics', () => {
  const R = F1.REF_SPEC;
  assert.deepStrictEqual(F1.sanitizeSpec({}), R); assert.deepStrictEqual(F1.sanitizeSpec(null), R); assert.deepStrictEqual(F1.sanitizeSpec('x'), R);
  const bad = { id: 'Bad ID!', year: 2025.5, team: 7, colour: 'red', ratings: { topSpeed: 140, accel: 'x' }, power: NaN, dragK: -1, downforce: Infinity,
    latBase: 1e9, latMax: '44', brakeBase: null, traction: [11], gearKmh: [100, 50], topKmh: 20, rpmIdle: -3, rpmShift: 1e6, rpmMax: NaN,
    shiftTime: 3, cylinders: 7, aspiration: 'steam', ers: { store: -1, power: 'big', harvest: 1e12 }, cockpit: 'constructor', extra: { x: 1 } };
  const s = F1.sanitizeSpec(bad);
  assert.deepStrictEqual(s, R, 'every field of that one is garbage');
  assert.strictEqual(s.extra, undefined, 'only the contract\'s fields');
  const ok = F1.sanitizeSpec({ id: '2012-red-bull', year: 2012, power: R.power * 1.3, dragK: R.dragK * 0.8, gearKmh: [90, 130, 170, 210, 250, 290], topKmh: 320,
    rpmIdle: 5000, rpmShift: 18000, rpmMax: 18000, shiftTime: 0.04, cylinders: 8, aspiration: 'na', ers: { store: 2000, power: 80, harvest: 100 }, cockpit: 'modern' });
  assert.deepStrictEqual([ok.id, ok.year, ok.power, ok.dragK, ok.topKmh, ok.cylinders, ok.aspiration, ok.cockpit, ok.ers.store],
    ['2012-red-bull', 2012, R.power * 1.3, R.dragK * 0.8, 320, 8, 'na', 'modern', 2000]);
  assert.strictEqual(F1.sanitizeSpec({ ers: null }).ers, null); assert.strictEqual(F1.sanitizeSpec({ ers: false }).ers, null);
  assert.deepStrictEqual(F1.sanitizeSpec({ ers: undefined }).ers, R.ers, 'missing ERS: the reference battery');
  // a copy: the caller's arrays / objects are not kept
  const g = [70, 120, 170], sp = F1.sanitizeSpec({ gearKmh: g, topKmh: 250 }); g[0] = 999; assert.strictEqual(sp.gearKmh[0], 70);
  // the physics of a garbage spec drives
  const car = F1.createCar(bad), tr = strip(20000);
  car.reset(tr, 0);
  for (let i = 0; i < 120 * 20; i++) {
    car.update(STEP, { up: i < 1800, down: i >= 1800, left: i % 300 < 100, boost: true, limiter: i > 2200 }, tr);
    for (const k of Object.keys(car.state)) if (typeof car.state[k] === 'number') assert(Number.isFinite(car.state[k]), k + ' at step ' + i);
  }
  for (const k of Object.keys(car.perf)) if (typeof car.perf[k] === 'number') assert(Number.isFinite(car.perf[k]), 'perf.' + k);
});

test('sanitised ERS: missing = the reference battery; 0 / \'\' / {} / {store: 0, ...} and any non-object = no battery, never the reference\'s', () => {
  const R = F1.REF_SPEC, S = ers => F1.sanitizeSpec(Object.assign({}, R, { ers }));
  const none = { 'null': null, 'false': false, '0': 0, "''": '', 'NaN': NaN, 'true': true, "'x'": 'x', '5': 5, '[]': [], '{}': {},
    '{foo: 1}': { foo: 1 }, '{store: NaN}': { store: NaN }, "{store: '4000'}": { store: '4000' },
    '{store: 0, power: 0, harvest: 0} (2010)': { store: 0, power: 0, harvest: 0 }, '{store: 0, ...}': { store: 0, power: R.ers.power, harvest: R.ers.harvest },
    '{power: 0, ...}': { store: R.ers.store, power: 0, harvest: R.ers.harvest }, '{store: -0}': { store: -0, power: 100 } };
  for (const [k, e] of Object.entries(none)) {
    assert.strictEqual(S(e).ers, null, 'ers ' + k);
    const car = F1.createCar(Object.assign({}, R, { ers: e }), { tyres: false }); car.setBattery(1);
    assert.strictEqual(car.state.battery, 0, 'ers ' + k + ': no battery');
    assert.strictEqual(car.perf.topSpeedBoost, car.perf.topSpeed, 'ers ' + k + ': boost adds nothing');
  }
  const noKey = Object.assign({}, R); delete noKey.ers;
  assert.deepStrictEqual(F1.sanitizeSpec(noKey).ers, R.ers, 'missing: the reference battery');
  assert.deepStrictEqual(S(undefined).ers, R.ers, 'undefined: the reference battery');
  // a battery: well-formed as it is; a battery with absurd fields keeps the reference's for those
  assert.deepStrictEqual(S({ store: 2000, power: 80, harvest: 100 }).ers, { store: 2000, power: 80, harvest: 100 });
  assert.deepStrictEqual(S({ harvest: 100 }).ers, { store: R.ers.store, power: R.ers.power, harvest: 100 });
  assert.deepStrictEqual(S({ store: -1, power: 'big', harvest: 1e12 }).ers, R.ers, 'garbage numbers: the reference\'s fields');
  assert.deepStrictEqual(S({ store: 2000, power: 80, harvest: 0 }).ers, { store: 2000, power: 80, harvest: R.ers.harvest }, 'harvest 0 is out of range');
  assert.deepStrictEqual(F1.sanitizeSpec(S({ store: 2000, power: 80, harvest: 100 })), S({ store: 2000, power: 80, harvest: 100 }), 'idempotent');
  assert.strictEqual(F1.sanitizeSpec(S(0)).ers, null, 'idempotent: no battery stays none');
});

test('createCar(spec) / setSpec / car.spec / car.perf; setSpec(REF_SPEC) is the v5 car again', () => {
  const R = F1.REF_SPEC, fast = Object.assign({}, R, { id: '2026-fast', power: R.power * 1.1, traction: 12 });
  const car = F1.createCar(fast), tr = strip(20000);
  assert.strictEqual(car.spec.id, '2026-fast'); assert.notStrictEqual(car.spec, fast); assert.deepStrictEqual(car.spec, F1.sanitizeSpec(fast));
  assert.strictEqual(car.perf.power, R.power * 1.1); assert.strictEqual(car.perf.spec, car.spec);
  const ref = F1.createCar(); ref.reset(tr, 0); car.reset(tr, 0);
  for (let i = 0; i < 120 * 30; i++) { car.update(STEP, { up: true }, tr); ref.update(STEP, { up: true }, tr); }
  assert(car.state.z > ref.state.z + 50 && car.state.speed > ref.state.speed, 'the faster spec is faster');
  near(car.state.speed, car.perf.topSpeed, 0.2, 'reaches its top speed');
  car.setSpec(R); car.tyres.setWearRate(0);
  assert.deepStrictEqual(car.spec, R); assert.strictEqual(car.perf.power, V5.CAR_PERF.power);
  const r = replay('au-1953', recordings['au-1953/braking + reverse'], car);
  assert(!r.first, 'after setSpec(REF_SPEC): ' + r.first);
  assert.strictEqual(F1.createCar(null).spec.id, R.id); assert.strictEqual(F1.createCar().perf.topSpeed, 330 / 3.6);
});

// ==================================================================================================================
// 3. drivetrain state
// ==================================================================================================================
test('gears up through a full-throttle launch at the gearKmh speeds, rpm by the formula, shiftT / shiftDir; no torque interruption', () => {
  const tr = strip(20000), car = F1.createCar(), st = car.state, old = V5.createCar(), P = car.perf;
  car.reset(tr, 0); old.reset(tr, 0);
  assert.deepStrictEqual([st.gear, st.rpm, st.shiftT, st.throttle, st.brake], [0, 4000, 9, 0, 0]);
  const gears = [];
  let prevGear = 0, shiftT = st.shiftT;
  for (let i = 0; i < 120 * 40; i++) {
    car.update(STEP, { up: true }, tr); old.update(STEP, { up: true }, tr);
    assert(Object.is(st.speed, old.state.speed), 'the drive is never interrupted (speed identical to the v5 car) at step ' + i);
    const kmh = st.speed * KMH;
    if (st.gear !== prevGear) {
      gears.push(st.gear);
      assert.strictEqual(st.shiftT, 0); assert.strictEqual(st.shiftDir, 1);
      if (st.gear > 1) { const up = F1.REF_SPEC.gearKmh[st.gear - 2]; assert(kmh >= up && kmh < up + 1.5, 'upshift to ' + st.gear + ' at ' + kmh); }
    } else near(st.shiftT, shiftT + STEP, 1e-12, 'shiftT counts');
    prevGear = st.gear; shiftT = st.shiftT;
    assert.strictEqual(st.rpm, P.rpmFor(st.speed, st.gear));
    assert.deepStrictEqual([st.throttle, st.brake], [1, 0]);
  }
  assert.deepStrictEqual(gears, [1, 2, 3, 4, 5, 6, 7, 8]);
  near(st.rpm, 11800 * 330 / 345, 1, 'top speed in 8th: ' + st.rpm);
});

test('gears down with 8 km/h of hysteresis under braking, reverse gear, neutral standing; pedals as applied', () => {
  const tr = strip(20000), car = F1.createCar(), st = car.state;
  car.reset(tr, 0); st.speed = 300 / KMH;
  car.update(STEP, { up: true }, tr); assert.strictEqual(st.gear, 8);
  const downs = [];
  let prev = st.gear;
  for (let i = 0; i < 120 * 8 && st.speed > 0.6; i++) {
    car.update(STEP, { down: true }, tr);
    if (st.gear !== prev && st.gear >= 1) {
      downs.push(st.gear); assert.strictEqual(st.shiftDir, -1); assert.strictEqual(st.shiftT, 0);
      const up = F1.REF_SPEC.gearKmh[st.gear - 1];
      assert(st.speed * KMH < up - 8 && st.speed * KMH > up - 8 - 5, 'down to ' + st.gear + ' at ' + st.speed * KMH);
    }
    prev = st.gear;
  }
  assert.deepStrictEqual(downs, [7, 6, 5, 4, 3, 2, 1]);
  for (let i = 0; i < 240; i++) car.update(STEP, { down: true }, tr);
  assert(st.speed < -0.5 && st.gear === -1, 'brake held at a stop: reverse, gear -1');
  near(st.rpm, car.perf.rpmFor(st.speed, 1), 1e-9);
  for (let i = 0; i < 1200 && st.speed < -0.2; i++) car.update(STEP, { up: true }, tr);    // the throttle brakes a reversing car
  for (let i = 0; i < 120; i++) car.update(STEP, {}, tr);
  assert.deepStrictEqual([st.speed, st.gear, st.rpm, st.throttle, st.brake], [0, 0, 4000, 0, 0], 'standing, nothing pressed: neutral, idle');
  car.update(STEP, { throttle: 0.3 }, tr); assert.deepStrictEqual([st.gear, st.throttle, st.brake], [1, 0.3, 0]);
  car.update(STEP, { up: true, throttle: 0.3, brake: 0.25 }, tr); assert.deepStrictEqual([st.throttle, st.brake], [1, 0.25]);
  car.reset(tr, 10); assert.deepStrictEqual([st.gear, st.rpm, st.throttle, st.deploy], [0, 4000, 0, 0]);
});

// ==================================================================================================================
// 4. battery (ERS)
// ==================================================================================================================
const E = F1.REF_SPEC.ers;
test('deploy: only with boost + throttle + no brake + charge; adds ers.power / v where power-limited; a full store lasts 32 s', () => {
  const tr = strip(40000);
  const run = (inp, v0, bat) => { const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); c.state.speed = v0; if (bat !== undefined) c.setBattery(bat); c.update(STEP, inp, tr); return c.state; };
  // 330 km/h: above the traction cap's speed (power / traction = 318 km/h) the engine is power-limited
  const v = 330 / KMH, base = run({ up: true }, v), boost = run({ up: true, boost: true }, v);
  assert.strictEqual(base.deploy, 0); near(boost.deploy, 1, 1e-9, 'deploy share');
  near((boost.speed - base.speed) / STEP, E.power / v, 1e-6, 'extra acceleration = ers.power / v');
  near(1 - boost.battery, E.power * STEP / E.store, 1e-12, 'drain = ers.power per second');
  for (const [what, inp, bat] of [['no throttle', { boost: true }], ['braking', { up: true, down: true, boost: true }], ['half brake', { up: true, brake: 0.5, boost: true }], ['empty', { up: true, boost: true }, 0]]) {
    const s = run(inp, v, bat), s0 = run(Object.assign({}, inp, { boost: false }), v, bat);
    assert.strictEqual(s.deploy, 0, what); assert.strictEqual(s.speed, s0.speed, what + ': no extra drive');
  }
  near(run({ throttle: 0.5, boost: true }, v).deploy, 0.5, 1e-9, 'proportional to the throttle');
  // 250 km/h, traction-capped: 0.15 x the capped drive, so the battery deploys (and drains) less than ers.power
  const v2 = 250 / KMH, b2 = run({ up: true, boost: true }, v2);
  near((b2.speed - run({ up: true }, v2).speed) / STEP, 0.15 * F1.CAR_PERF.traction, 1e-6, '0.15 x the traction cap');
  near(b2.deploy, 0.15 * F1.CAR_PERF.traction * v2 / E.power, 1e-9, 'deploy share below 1');
  // 32 s at full power (full throttle + boost from 330 km/h: power-limited all the way)
  const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); c.state.speed = 330 / KMH;
  let t = 0; while (c.state.battery > 0 && t < 60) { c.update(STEP, { up: true, boost: true }, tr); t += STEP; }
  near(t, 32, 0.02, 'store lasts'); assert(c.state.battery === 0);
  c.update(STEP, { up: true, boost: true }, tr); assert.strictEqual(c.state.deploy, 0, 'nothing left');
});

// Review D3: the deploy used to add ers.power / v on top of the drivetrain's traction cap (up to the tyres' friction):
// +32 % acceleration at 150 km/h, 0-200 km/h 6.09 -> 5.04 s, +36 km/h after 8 s. Now it multiplies the engine's drive
// (traction cap included) by 1 + ers.power / power = 1.15 at every speed, still limited by the tyres.
test('deploy = 1.15 x the engine\'s drive at every speed (traction cap included), up to the tyres; +15..20 km/h at the end of a 900 m straight', () => {
  const tr = strip(40000), P = F1.CAR_PERF;
  const extra = v => { const run = boost => { const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); c.state.speed = v; c.update(1e-3, { up: true, boost }, tr); return c.state.speed; };
    return (run(true) - run(false)) / 1e-3; };
  // at 20 m/s 0.15 x the drive would be 1.65 m/s^2 more, but the tyres can only take muTraction * a_n in all
  near(extra(20), P.muTraction * (9.81 + P.downforce * 400) - P.traction, 1e-6, 'capped by the tyres at 20 m/s');
  for (const kmh of [100, 150, 200, 250, 300, 330, 345]) {
    const v = kmh / KMH, drive = Math.min(P.traction, P.power / v), x = extra(v), tyres = P.muTraction * (9.81 + P.downforce * v * v) - drive;
    near(x, Math.min(tyres, drive * E.power / P.power), 1e-6, kmh + ' km/h');
    assert(x <= 0.15 * drive + 1e-6, kmh + ' km/h: never more than 0.15 x the drive: ' + x);
  }
  near(extra(90), E.power / 90, 1e-6, 'the full ers.power at 90 m/s (power-limited)');
  const tTo = (kmh, boost) => { const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); let n = 0; while (c.state.speed * KMH < kmh) { c.update(STEP, { up: true, boost }, tr); n++; } return n * STEP; };
  const a = tTo(100, false), b = tTo(100, true), a2 = tTo(200, false), b2 = tTo(200, true);
  assert(a - b < 0.25 && a - b >= 0, '0-100 km/h ' + a.toFixed(3) + ' s, with boost ' + b.toFixed(3) + ' s');
  assert(a2 - b2 > 0.4 && a2 - b2 < 0.8, '0-200 km/h ' + a2.toFixed(3) + ' s, with boost ' + b2.toFixed(3) + ' s (was 6.09 -> 5.04)');
  const at8 = boost => { const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); for (let i = 0; i < 8 * 120; i++) c.update(STEP, { up: true, boost }, tr); return c.state.speed * KMH; };
  const g8 = at8(true) - at8(false);
  assert(g8 > 15 && g8 < 30, 'after 8 s from a standing start: +' + g8.toFixed(1) + ' km/h (was +36)');
  const end = boost => { const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); c.state.speed = 150 / KMH; while (c.state.z < 900) c.update(STEP, { up: true, boost }, tr); return c.state.speed * KMH; };
  const gain = end(true) - end(false);
  assert(gain >= 15 && gain <= 20, 'gain ' + gain);
  info('0-100 km/h ' + a.toFixed(2) + ' s / boost ' + b.toFixed(2) + ' s; 0-200 ' + a2.toFixed(2) + ' / ' + b2.toFixed(2) + ' s; +' + g8.toFixed(1) +
    ' km/h after 8 s; 900 m from 150 km/h: ' + end(false).toFixed(1) + ' -> ' + end(true).toFixed(1) + ' km/h');
});

// Review D2: the 2026 MGU-K fades out with speed (rule C5.2.8: P = 1800 - 5v kW, 350 kW up to 290 km/h). A spec gives it
// as ers.taperKmh [from, to]: the deploy power falls linearly from ers.power at `from` to 0 at `to`.
test('ers.taperKmh: sanitised, the deploy power fades out between its speeds, topSpeedBoost follows; none for the reference', () => {
  const R = F1.REF_SPEC, S = ers => F1.sanitizeSpec(Object.assign({}, R, { ers }));
  assert.deepStrictEqual(Object.keys(R.ers), ['store', 'power', 'harvest'], 'the reference has no taper');
  const e26 = { store: 4849, power: 442, harvest: 2190 };
  const ok = S(Object.assign({ taperKmh: [290, 360] }, e26));
  assert.deepStrictEqual(ok.ers, Object.assign({}, e26, { taperKmh: [290, 360] }));
  const src = [290, 345], cp = S(Object.assign({ taperKmh: src }, e26)); src[0] = 1;
  assert.deepStrictEqual(cp.ers.taperKmh, [290, 345], 'a copy');
  assert.deepStrictEqual(F1.sanitizeSpec(ok), ok, 'idempotent');
  for (const bad of [null, 0, 'x', [], [290], [290, 360, 400], [360, 290], [290, 290], [290, 290.5], ['290', 360], [NaN, 360], [290, Infinity], [10, 360], [290, 700], { 0: 290, 1: 360, length: 2 }]) {
    assert.deepStrictEqual(S(Object.assign({ taperKmh: bad }, e26)).ers, e26, 'taperKmh ' + JSON.stringify(bad) + ': dropped');
  }
  assert.strictEqual(S({ taperKmh: [290, 360] }).ers, null, 'a taper alone is no battery');
  // the deploy power by speed
  const spec = Object.assign({}, R, { ers: Object.assign({ taperKmh: [290, 360] }, e26) }), P = F1.carPerf(spec), flat = F1.carPerf(Object.assign({}, R, { ers: e26 }));
  for (const [kmh, want] of [[0, 442], [200, 442], [290, 442], [300, 442 * 60 / 70], [325, 442 / 2], [340, 442 * 20 / 70], [360, 0], [400, 0], [-300, 442 * 60 / 70]]) {
    near(P.ersDeploy(kmh / KMH), want, 1e-9, kmh + ' km/h');
    assert.strictEqual(flat.ersDeploy(kmh / KMH), 442, 'no taper: ' + kmh);
  }
  assert.strictEqual(F1.CAR_PERF.ersDeploy(400 / KMH), E.power, 'the reference: ers.power at any speed');
  assert.strictEqual(F1.carPerf(Object.assign({}, R, { ers: null })).ersDeploy(50), 0, 'no battery: 0');
  // in the car: below the taper the same as without it, above `to` nothing, in between the faded power
  const tr = strip(40000);
  const extra = (sp, kmh) => { const run = boost => { const c = F1.createCar(sp, { tyres: false }); c.reset(tr, 0); c.state.speed = kmh / KMH; c.setBattery(1); c.update(1e-3, { up: true, boost }, tr); return c.state; };
    const b = run(true); return { a: (b.speed - run(false).speed) / 1e-3, deploy: b.deploy }; };
  near(extra(spec, 250).a, extra(Object.assign({}, R, { ers: e26 }), 250).a, 1e-9, 'below the taper: unchanged');
  near(extra(spec, 325).a, P.power / (325 / KMH) * (442 / 2) / P.power, 1e-6, '325 km/h: half the power');
  const top = extra(spec, 365);
  assert.deepStrictEqual([top.a, top.deploy], [0, 0], 'above 360 km/h: nothing');
  // the deploying top speed stays inside the taper: the boost can no longer carry the car 50 km/h past its top speed
  const vb = P.topSpeedBoost * KMH, vf = flat.topSpeedBoost * KMH;
  assert(vb > P.topSpeed * KMH + 5 && vb < 360 && vf > vb + 20, 'top ' + (P.topSpeed * KMH).toFixed(1) + ', deploying ' + vb.toFixed(1) + ' (no taper ' + vf.toFixed(1) + ')');
  const c = F1.createCar(spec, { tyres: false }); c.reset(tr, 0); c.state.speed = 200 / KMH; c.setBattery(1);
  let vmax = 0; for (let i = 0; i < 120 * 60; i++) { c.update(STEP, { up: true, boost: true }, tr); vmax = Math.max(vmax, c.state.speed * KMH); }
  assert(vmax <= vb + 0.05, 'driven: ' + vmax.toFixed(2) + ' vs ' + vb.toFixed(2));
  info('taper [290, 360] on 442 W/kg: top ' + (P.topSpeed * KMH).toFixed(1) + ' km/h, deploying ' + vb.toFixed(1) + ' (without the taper ' + vf.toFixed(1) + ')');
});

test('harvest: under braking (share of the braking power, up to ers.harvest), a little on lift-off above 20 m/s; braking unchanged; clamps', () => {
  const tr = strip(40000);
  const step = (inp, v0, bat) => { const c = F1.createCar(null, { tyres: false }); c.reset(tr, 0); c.state.speed = v0; c.setBattery(bat === undefined ? 0.5 : bat); c.update(STEP, inp, tr); return c.state; };
  near(step({ down: true }, 80).harvest, 1, 1e-9, 'hard braking at speed: the full ers.harvest');
  near(step({ down: true }, 80).battery - 0.5, E.harvest * STEP / E.store, 1e-12);
  const lo1 = step({ down: true }, 15).harvest, lo2 = step({ brake: 0.5 }, 15).harvest;
  assert(lo1 > 0 && lo1 < 1 && Math.abs(lo2 / lo1 - 0.5) < 0.01, 'proportional to the pedal below the cap: ' + lo1 + ' / ' + lo2);
  assert(step({ down: true }, 25).harvest > lo1, 'and grows with speed');
  near(step({}, 30).harvest, 0.12, 1e-9, 'lift-off'); assert.strictEqual(step({}, 19).harvest, 0, 'not below 20 m/s');
  assert.strictEqual(step({ up: true }, 30).harvest, 0, 'not on the throttle'); assert.strictEqual(step({ throttle: 0.1 }, 30).harvest, 0);
  const full = step({ down: true }, 80, 1); assert.deepStrictEqual([full.harvest, full.battery], [0, 1], 'full: nothing more');
  // bookkeeping only: the car without ERS brakes exactly the same
  const a = F1.createCar(null, { tyres: false }), b = F1.createCar(Object.assign({}, F1.REF_SPEC, { ers: null }), { tyres: false });
  a.reset(tr, 0); b.reset(tr, 0); a.state.speed = b.state.speed = 300 / KMH; a.setBattery(0);
  for (let i = 0; i < 120 * 6; i++) {
    const inp = i < 400 ? { down: true } : (i < 600 ? {} : { brake: 0.3 });
    a.update(STEP, inp, tr); b.update(STEP, inp, tr);
    assert(Object.is(a.state.speed, b.state.speed) && Object.is(a.state.z, b.state.z), 'step ' + i);
  }
  assert(a.state.battery > 0.1, 'harvested ' + a.state.battery);
});

test('setBattery / reset / no ERS: clamps, reset keeps the charge, ers null = battery 0 always', () => {
  const tr = strip(2000), car = F1.createCar();
  car.setBattery(0.4); car.reset(tr, 5); assert.strictEqual(car.state.battery, 0.4, 'reset leaves the battery');
  car.setBattery(2); assert.strictEqual(car.state.battery, 1); car.setBattery(-1); assert.strictEqual(car.state.battery, 0);
  car.setBattery(0.7); car.setBattery(NaN); car.setBattery('1'); assert.strictEqual(car.state.battery, 0.7, 'not a number: ignored');
  car.setSpec(Object.assign({}, F1.REF_SPEC, { ers: null })); assert.strictEqual(car.state.battery, 0);
  car.setBattery(1); assert.strictEqual(car.state.battery, 0);
  car.state.speed = 60; car.update(STEP, { down: true, boost: true }, tr);
  assert.deepStrictEqual([car.state.battery, car.state.deploy, car.state.harvest], [0, 0, 0]);
  car.setSpec(F1.REF_SPEC); car.setBattery(0.25); assert.strictEqual(car.state.battery, 0.25);
  assert.strictEqual(F1.createCar().state.battery, 1, 'a new car is charged');
});

// ==================================================================================================================
// 5. pit limiter
// ==================================================================================================================
test('pit limiter: holds just under 80 km/h (no pit) / track.pit.limitKmh, never above; it does not brake; state.limiter', () => {
  const tr = strip(20000), car = F1.createCar(null, { tyres: false }), st = car.state;
  car.reset(tr, 0);
  let max = 0;
  for (let i = 0; i < 120 * 10; i++) { car.update(STEP, { up: true, limiter: true, boost: true }, tr); max = Math.max(max, st.speed * KMH); }
  assert(max <= 80 && st.speed * KMH > 79.5, 'max ' + max + ', holding ' + st.speed * KMH);
  assert.deepStrictEqual([st.limiter, st.limitKmh, st.deploy], [true, 80, 0]);
  // entering at 150 km/h with the limiter on and the throttle open: it coasts exactly like a car with no throttle ...
  const a = F1.createCar(null, { tyres: false }), b = F1.createCar(null, { tyres: false });
  a.reset(tr, 0); b.reset(tr, 0); a.state.speed = b.state.speed = 150 / KMH; a.setBattery(1); b.setBattery(1);
  while (a.state.speed * KMH > 81) {
    a.update(STEP, { up: true, limiter: true }, tr); b.update(STEP, { up: false }, tr);
    assert(Object.is(a.state.speed, b.state.speed), 'the limiter does not brake: ' + a.state.speed + ' vs coasting ' + b.state.speed);
  }
  for (let i = 0; i < 600; i++) a.update(STEP, { up: true, limiter: true }, tr);
  assert(a.state.speed * KMH <= 80 && a.state.speed * KMH > 79.5, '... then holds ' + a.state.speed * KMH);
  car.update(STEP, { up: true }, tr); assert.strictEqual(st.limiter, false, 'released');
  // Monaco's lane is 60 km/h
  const { track: mc } = track('mc-1929'), m = F1.createCar(); m.tyres.setWearRate(0);
  m.reset(mc, 1000);
  max = 0;
  const mi = { up: true, limiter: true, left: false, right: false };
  for (let i = 0; i < 120 * 5; i++) { keysSteer(mi, m.state, pursuit(mc, m.state)); m.update(STEP, mi, mc); max = Math.max(max, m.state.speed * KMH); }
  assert.strictEqual(mc.pit.limitKmh, 60); assert.strictEqual(m.state.limitKmh, 60);
  assert(max <= 60 && m.state.speed * KMH > 59.5, 'Monaco: max ' + max);
});

// ==================================================================================================================
// 6. tyres
// ==================================================================================================================
test('car.tyres is an F1.createTyres instance, fed every step with the load the physics really uses', () => {
  const { track: tr, line } = track('au-1953'), car = F1.createCar(null, { random: () => 0.5 }), st = car.state, ty = car.tyres;
  assert(ty && typeof ty.fit === 'function' && typeof ty.setWearRate === 'function' && ty.state.compound === 'M' && ty.wearRate === 1);
  const seen = { n: 0, left: 0, right: 0, brake: 0, drive: 0, slip: 0, maxLat: 0 };
  const upd = ty.update;
  ty.update = (dt, l) => {
    seen.n++;
    assert(dt > 0 && dt <= STEP + 1e-12, 'per physics step');
    assert(Math.abs(l.lat) <= 1 && l.brake >= 0 && l.brake <= 1 && l.drive >= 0 && l.drive <= 1 && l.slip >= 0 && l.slip <= 1, JSON.stringify(l));
    assert.strictEqual(l.speed, st.speed); assert.strictEqual(l.onGrass, st.onGrass); assert.strictEqual(l.hit, st.hit);
    if (l.lat > 0.3) seen.left++; if (l.lat < -0.3) seen.right++;
    if (l.brake > 0) seen.brake++; if (l.drive > 0) seen.drive++; if (l.slip > 0) seen.slip++;
    seen.maxLat = Math.max(seen.maxLat, Math.abs(l.lat));
    return upd(dt, l);
  };
  car.reset(tr, tr.samples.length - 10);
  const inp = { up: false, down: false, left: false, right: false };
  for (let i = 0; i < 120 * 60; i++) {
    const w = lineWant(tr, line, st); inp.up = w.level < 0.45 || st.speed < 5; inp.down = w.level >= 0.6 && st.speed >= 5; keysSteer(inp, st, w.steer);
    car.update(STEP, inp, tr);
    if (st.steer > 0.5 && st.speed > 20 && seen.left) assert(true);
  }
  assert(seen.n >= 120 * 60 && seen.left > 100 && seen.right > 100 && seen.brake > 100 && seen.drive > 1000, JSON.stringify(seen));
  assert(ty.state.wear.every(w => w > 0), 'wear ' + ty.state.wear);
  assert.strictEqual(st.vib, ty.state.vib);
  info('60 s of Albert Park: wear ' + ty.state.wear.map(w => (w * 100).toFixed(2) + '%').join(' ') + ', max |lat| ' + seen.maxLat.toFixed(2) + ', slip steps ' + seen.slip);
});

// a stub tyre set with fixed multipliers
function stubTyres(lat, brake, traction, extra) {
  return Object.assign({ state: { grip: { lat, brake, traction }, puncture: -1, vib: 0 }, update() {}, fit() {}, setWearRate() {}, wearRate: 1 }, extra || {});
}
test('the grip multipliers scale lateral grip, braking and traction', () => {
  const tr = strip(20000), P = F1.CAR_PERF;
  const mk = g => { const c = F1.createCar(null, { tyres: g ? stubTyres(g, g, g) : false }); c.reset(tr, 0); return c; };
  // lateral: full lock at 40 m/s, far past the grip: the yaw rate is capped at latMax / v
  const yaw = g => { const c = mk(g); c.state.steer = 1; c.state.speed = 40; const h = c.state.heading; c.update(1 / 480, { left: true }, null); return (c.state.heading - h) * 480; };
  near(yaw(0.7) / yaw(1), 0.7, 1e-9, 'lateral');
  near(yaw(1) * 40, P.maxLatAccel(40, 0, 0, 0, 1), 1e-9, 'reference: the flat-road limit');
  // braking: the deceleration's tyre part
  const dec = g => { const c = mk(g); c.state.speed = 60; c.update(STEP, { down: true }, tr); return (60 - c.state.speed) / STEP; };
  const brk1 = P.muBrake * (9.81 + P.downforce * 3600) + P.brakeDrag * 3600;
  near(dec(1), brk1 + 0.5 + P.dragK * 3600, 1e-6, 'reference braking'); near(dec(0.8), brk1 * 0.8 + 0.5 + P.dragK * 3600, 1e-6, 'braking x 0.8');
  // traction: at 10 m/s the drive is traction-limited
  const acc = g => { const c = mk(g); c.state.speed = 10; c.update(STEP, { up: true }, tr); return (c.state.speed - 10) / STEP; };
  near(acc(0.6) + 0.5 + P.dragK * 100, (acc(1) + 0.5 + P.dragK * 100) * 0.6, 1e-6, 'traction x 0.6');
});

test('car.bump: a car-to-car impact reaches the tyres and state.hit on the next update (as a wall impact); the path is unchanged', () => {
  const tr = strip(20000), seen = [];
  const c = F1.createCar(null, { tyres: stubTyres(1, 1, 1, { update(dt, l) { seen.push(l.hit); } }) }), st = c.state;
  c.reset(tr, 0); st.speed = 60;
  c.update(STEP, { up: true }, tr); assert.strictEqual(st.hit, 0);
  // main.js order: car.update, F1.resolveCarCollisions (sets state.hit after the update), car.bump
  c.bump(0.3); c.bump(0.7); c.bump(0.5);
  assert.strictEqual(st.hit, 0, 'recorded, not applied until the next update');
  seen.length = 0; c.update(STEP, { up: true }, tr);
  assert(seen.length >= 1 && seen.every(h => h === 0.7), 'every sub-step of the next update sees the strongest bump: ' + seen);
  assert.strictEqual(st.hit, 0.7, 'state.hit (HUD, sound)');
  seen.length = 0; c.update(STEP, { up: true }, tr);
  assert(seen.every(h => h === 0) && st.hit === 0, 'fed once');
  for (const [v, want] of [[5, 1], [Infinity, 1], [0, 0], [-1, 0], [NaN, 0], ['1', 0], [null, 0], [undefined, 0]]) {
    c.bump(v); c.update(STEP, { up: true }, tr); assert.strictEqual(st.hit, want, 'bump(' + v + ')');
  }
  c.bump(0.6); c.update(0, { up: true }, tr); assert.strictEqual(st.hit, 0, 'dt 0: no step');
  c.update(STEP, { up: true }, tr); assert.strictEqual(st.hit, 0.6, '... kept for the next real step');
  c.bump(0.6); c.reset(tr, 5); c.update(STEP, { up: true }, tr); assert.strictEqual(st.hit, 0, 'reset drops a pending bump');
  // the real tyres, random() = 0: bump(1) punctures and flat-spots as a head-on wall impact at hit 1 (chance 0.8)
  const d = F1.createCar(null, { random: () => 0 }), dt = d.tyres.state;
  d.reset(tr, 0); d.state.speed = 60;
  for (let i = 0; i < 12; i++) d.update(STEP, { up: true }, tr);
  assert(dt.puncture < 0 && Math.max(...dt.flat) === 0, 'healthy before');
  d.bump(1);
  for (let i = 0; i < 12; i++) d.update(STEP, { up: true }, tr);
  assert(dt.puncture >= 0 && Math.max(...dt.flat) > 0, 'after bump(1): puncture ' + dt.puncture + ', flat ' + dt.flat);
  const e = F1.createCar(null, { random: () => 0 }); e.reset(tr, 0); e.state.speed = 60;
  e.bump(0.15); for (let i = 0; i < 12; i++) e.update(STEP, { up: true }, tr);
  assert(e.tyres.state.puncture < 0 && Math.max(...e.tyres.state.flat) === 0, 'a touch (below the tyres\' impact threshold) does nothing');
  // the path: bumps change nothing but state.hit (no tyres: nothing to damage)
  const p = F1.createCar(null, { tyres: false }), q = F1.createCar(null, { tyres: false });
  p.reset(tr, 0); q.reset(tr, 0);
  let hits = 0;
  for (let i = 0; i < 1200; i++) {
    if (i % 7 === 0) p.bump((i % 13) / 12);
    const inp = { up: i < 800, down: i >= 800, left: i % 100 < 30, boost: i > 300 };
    p.update(STEP, inp, tr); q.update(STEP, inp, tr);
    for (const k of Object.keys(q.state)) if (k !== 'hit') assert(Object.is(p.state[k], q.state[k]), k + ' at step ' + i);
    if (p.state.hit > 0) hits++;
  }
  assert(hits > 100 && q.state.hit === 0, 'bumps seen ' + hits);
});

test('state.slip past the lateral limit (2 x the overshoot, capped), 0 inside it; state.vib from the tyres', () => {
  const tr = strip(20000), c = F1.createCar(null, { tyres: stubTyres(1, 1, 1, { state: { grip: { lat: 1, brake: 1, traction: 1 }, puncture: -1, vib: 0.37 } }) });
  c.reset(tr, 0); c.state.steer = 1; c.state.speed = 40; c.update(1 / 480, { left: true }, null);
  const req = 40 * 40 * Math.tan(0.35 / (1 + (40 / 22) ** 2)) / 3.6, cap = F1.CAR_PERF.maxLatAccel(40, 0, 0, 0, 1);
  near(c.state.slip, Math.min(1, 2 * (req / cap - 1)), 1e-9, 'slip');
  assert.strictEqual(c.state.vib, 0.37);
  c.reset(tr, 0); c.state.speed = 20; c.update(STEP, { left: true }, tr); assert.strictEqual(c.state.slip, 0, 'gentle: no slip');
});

test('a puncture is drivable, slowly (~150 km/h flat out); a new set cures it', () => {
  const { track: mz } = track('it-1922'), tr = strip(40000);
  // a heavy head-on wall impact with random() = 0: a puncture for sure (js/tyres.js: chance 0.8 at hit 1)
  const car = F1.createCar(null, { random: () => 0 }), st = car.state;
  car.reset(mz, Math.round(mz.samples.length * 0.4));
  st.heading += Math.PI / 2 * 0.95; st.speed = 90;
  for (let i = 0; i < 240 && car.tyres.state.puncture < 0; i++) car.update(STEP, { up: true }, mz);
  assert(car.tyres.state.puncture >= 0, 'punctured');
  car.reset(tr, 0);
  let t = 0, max = 0;
  while (t < 60) { car.update(STEP, { up: true }, tr); t += STEP; max = Math.max(max, st.speed * KMH); }
  assert(max > 110 && max < 165, 'flat out on a puncture: ' + max);
  assert(st.vib > 0.3, 'it shakes: ' + st.vib);
  // round Monza on it (keys, centreline pursuit, half the racing line's speed, at most 100 km/h): on the road, slowly
  // (at 65 % of the line's speed, clean on healthy tyres, the punctured car runs wide: lateral grip x 0.74)
  const line = track('it-1922').line, N = mz.samples.length, i0 = Math.round(N * 0.1), inp = { up: true, down: false, left: false, right: false };
  car.reset(mz, i0);
  let prog = 0, prev = i0, grass = 0, hits = 0;
  for (let i = 0; i < 120 * 60; i++) {
    const vt = Math.min(100 / KMH, 0.5 * line.points[(st.sampleIndex + 15) % N].speed);
    keysSteer(inp, st, pursuit(mz, st)); inp.up = st.speed < vt; inp.down = st.speed > vt + 2; car.update(STEP, inp, mz);
    let di = st.sampleIndex - prev; if (di < -N / 2) di += N; if (di > N / 2) di -= N; prog += di; prev = st.sampleIndex;
    if (st.onGrass) grass++; if (st.hit > 0) hits++;
  }
  const km = prog * mz.length / N / 1000;
  assert(km > 1.2 && km < 1.8 && grass === 0 && hits === 0 && Number.isFinite(st.x), 'a minute round Monza on a puncture: ' + km.toFixed(2) + ' km, grass steps ' + grass + ', wall steps ' + hits);
  info('on a puncture: ' + max.toFixed(0) + ' km/h flat out on a straight, ' + km.toFixed(2) + ' km round Monza in a minute');
  car.tyres.fit('M'); car.reset(tr, 0);
  max = 0; for (let i = 0; i < 120 * 40; i++) { car.update(STEP, { up: true }, tr); max = Math.max(max, st.speed * KMH); }
  assert(max > 329, 'a new set: ' + max);

});

// ==================================================================================================================
// 7. pit lane (the real tracks)
// ==================================================================================================================
function placeAt(car, tr, x, z, heading) {
  const loc = tr.nearest(x, z);
  car.reset(tr, loc.index); car.state.x = x; car.state.z = z; car.state.heading = heading;
  car.update(1e-4, null, tr); car.state.speed = 0;
}
test('pit lane: asphalt (not grass) in the lane and the boxes, state.inPit between the lines, no global re-locate in a box', () => {
  for (const id of ['it-1922', 'mc-1929', 'sg-2008']) {
    const { track: tr } = track(id), pit = tr.pit, car = F1.createCar(), st = car.state;
    car.tyres.setWearRate(0);
    for (const slot of [0, 7, 15]) {
      const b = pit.boxes[slot];
      placeAt(car, tr, b.x, b.z, b.heading);
      assert.strictEqual(st.onGrass, false, id + ' box ' + (slot + 1) + ': asphalt');
      assert.strictEqual(st.inPit, true, id + ' box ' + (slot + 1) + ': inPit');
      near(st.d, b.d, 0.05, id + ' d');
      // no global locate while standing / driving slowly in the box
      let global = 0; const loc = tr.locate;
      tr.locate = function (x, z, hint) { if (hint < 0) global++; return loc.call(tr, x, z, hint); };
      for (let i = 0; i < 120; i++) car.update(STEP, { throttle: 0.2, limiter: true }, tr);
      tr.locate = loc;
      assert.strictEqual(global, 0, id + ': global locates in the box');
    }
    // lane centre between the lines: asphalt traction (a standing start as quick as on the road)
    const N = tr.samples.length, kMid = Math.round(((pit.exit - pit.entry + N) % N) / 2), i = (pit.entry + kMid) % N, s = tr.samples[i];
    const dl = pit.laneD(i);
    placeAt(car, tr, s.x + s.nx * dl, s.z + s.nz * dl, Math.atan2(s.tx, s.tz));
    for (let k = 0; k < 120; k++) car.update(STEP, { up: true, limiter: true }, tr);
    assert(st.inPit && !st.onGrass && st.speed * KMH > 30, id + ': ' + st.speed * KMH + ' km/h after 1 s in the lane');
    // the track beside the lane is not inPit
    car.reset(tr, i); assert.strictEqual(st.inPit, false);
  }
});

test('pit wall: solid from the track, from the lane and at both ends, with the outer walls\' impact', () => {
  for (const id of ['it-1922', 'mc-1929', 'nl-1948', 'us-2023']) {
    const { track: tr } = track(id), pit = tr.pit, S = tr.samples, N = S.length, car = F1.createCar(), st = car.state;
    car.tyres.setWearRate(0);
    let k0 = -1, k1 = -1;
    for (let k = 0; k <= ((pit.to - pit.from + N) % N); k++) if (Number.isFinite(pit.wallD((pit.from + k) % N))) { if (k0 < 0) k0 = k; k1 = k; }
    assert(k0 > 0 && k1 > k0, id + ': a pit wall');
    const wD = pit.wallD((pit.from + k0) % N), sg = pit.side, lim = pit.wallHalfT + 1;
    const mid = (pit.from + Math.round((k0 + k1) / 2)) % N;
    const shoot = (i, d, heading, v, inp, T) => {
      const s = S[i]; placeAt(car, tr, s.x + s.nx * d, s.z + s.nz * d, heading); st.speed = v;
      const side0 = Math.sign(st.d - wD); let hit = 0, minGap = Infinity, crossed = false;
      for (let n = 0; n < (T || 2) * 120; n++) {
        car.update(STEP, inp, tr); hit = Math.max(hit, st.hit);
        const g = tr.nearest(st.x, st.z), k = (g.index - pit.from + N) % N;
        if (k > k0 + 1 && k < k1 - 1) { minGap = Math.min(minGap, Math.abs(g.d - wD)); if (Math.sign(g.d - wD) !== side0) crossed = true; }
      }
      return { hit, minGap, crossed };
    };
    const tan = Math.atan2(S[mid].tx, S[mid].tz);
    for (const deg of [10, 45, 90]) {
      // from the track side, turning towards the pit side (sg > 0: the driver's left = +heading)
      let r = shoot(mid, wD - sg * 6, tan + sg * deg * Math.PI / 180, 85, { up: true });
      assert(r.hit > 0 && !r.crossed && r.minGap >= lim - 0.02, id + ' from the track at ' + deg + ' deg: ' + JSON.stringify(r));
      // from the lane side
      r = shoot(mid, wD + sg * 4, tan - sg * deg * Math.PI / 180, 25, { up: true });
      assert(r.hit > 0 && !r.crossed && r.minGap >= lim - 0.02, id + ' from the lane at ' + deg + ' deg: ' + JSON.stringify(r));
    }
    // reversing into it
    const rr = shoot(mid, wD - sg * 3, tan - sg * 1.2, -5, { down: true });
    assert(rr.hit > 0 && !rr.crossed, id + ' reversing: ' + JSON.stringify(rr));
    // head-on at the upstream end (the attenuator) at 200 km/h, and at the downstream end driving the wrong way
    for (const [k, dir] of [[k0 - 6, 0], [k1 + 6, Math.PI]]) {
      const i = (pit.from + k) % N, s = S[i];
      assert(pit.paved(i, wD), id + ': the start in line with the wall is on the pit asphalt');
      placeAt(car, tr, s.x + s.nx * wD, s.z + s.nz * wD, Math.atan2(s.tx, s.tz) + dir); st.speed = 200 / KMH;
      let hit = 0, inside = 0;
      for (let n = 0; n < 240; n++) {
        car.update(STEP, { up: true }, tr); hit = Math.max(hit, st.hit);
        const g = tr.nearest(st.x, st.z), kk = (g.index - pit.from + N) % N;
        if (kk >= k0 && kk <= k1 && Math.abs(g.d - wD) < lim - 0.02) inside++;
      }
      assert(hit > 0.5 && inside === 0, id + ' head-on into the ' + (dir ? 'downstream' : 'upstream') + ' end: hit ' + hit + ', inside ' + inside);
    }
  }
});

// ---- v6.2 ----------------------------------------------------------------------------------------------------------
test('v6.2 steering law perf.steerLockAt: full lock 0.40 rad (8.5 m) to ~52 km/h, never less than 1.25 x the grip asks, exactly the v5 law from ~85 km/h on, more on a real banked corner', () => {
  const P = F1.CAR_PERF, P5 = V5.CAR_PERF, v5law = v => 0.35 / (1 + (v / 22) * (v / 22)), WB = P.wheelbase;
  assert.strictEqual(P.steerLockMax, 0.40); assert.strictEqual(P.steerLowGrip, 1.25);
  for (const v of [0, 0.3, 20 / KMH, 45 / KMH, 50 / KMH]) assert.strictEqual(P.steerLockAt(v, 0, 1), 0.40, 'full lock at ' + v * KMH + ' km/h');
  near(WB / Math.tan(P.steerLockAt(45 / KMH, 0, 1)), 8.515, 0.001, 'full-lock radius (3.6 m / tan 0.40)');
  let prev = Infinity;
  for (let kmh = 1; kmh <= 340; kmh += 1) {
    const v = kmh / KMH, a = P.steerLockAt(v, 0, 1), b = P.steerLockAt(v, 0, -1), asked = v * v * Math.tan(a) / WB;
    assert(a === b && a === P5.steerLockAt(v, 0, 1), 'symmetric on the flat, the oracle has the same law, ' + kmh + ' km/h');
    assert(a <= prev && a >= v5law(v) && a <= 0.40, 'falls with speed, between the v5 law and 0.40: ' + kmh);
    if (kmh >= 85) assert.strictEqual(a, v5law(v), 'the v5 law at ' + kmh + ' km/h');
    else if (a < 0.40) assert(asked >= 1.25 * P.latBase * (1 - 1e-12), 'never asks less than 1.25 x the mechanical grip: ' + kmh);
    prev = a;
  }
  // banking (rad, > 0: left higher): turning right (-1) is into it
  const v = 130 / KMH, flat = P.steerLockAt(v, 0, -1), deg = d => d * Math.PI / 180;
  assert(P.steerLockAt(v, deg(19), -1) > flat * 1.15, 'Zandvoort T3 (19 deg) into the bank: more lock');
  assert.strictEqual(P.steerLockAt(v, deg(19), 1), flat, 'off-camber: no more lock');
  assert.strictEqual(P.steerLockAt(v, deg(4), -1), flat, 'derived banking (<= 6 deg): no change');
  assert(P.steerLockAt(v, deg(7.5), -1) > flat && P.steerLockAt(v, deg(7.5), -1) < P.steerLockAt(v, deg(9), -1), '6..9 deg: faded in');
  // a grippier car may turn tighter at low-mid speed; the law is per spec
  assert(F1.carPerf(Object.assign({}, F1.REF_SPEC, { latBase: 26 })).steerLockAt(60 / KMH, 0, 1) > P.steerLockAt(60 / KMH, 0, 1), 'per spec');
  // and the car turns with it: full lock at 20 km/h on the flat = an 8.5 m circle
  const car = ALONE.createCar(), st = car.state, tr = strip(400);
  car.reset(tr, 20); st.speed = 20 / KMH;
  let h0 = 0, R = 0;
  for (let n = 0; n < 60; n++) { h0 = st.heading; car.update(STEP, { steerAxis: 1, throttle: 0.05 }, tr); R = Math.abs(st.speed) * STEP / (st.heading - h0); }
  near(R, WB / Math.tan(0.40), 0.05, 'turning radius at full lock, 20 km/h');
  info('lock 0.40 rad to ' + (() => { let k = 1; while (P.steerLockAt((k + 1) / KMH, 0, 1) === 0.40) k++; return k; })() + ' km/h, the v5 law from 85 km/h; T3 at 130 km/h: ' +
    (P.steerLockAt(v, deg(19), -1) / flat).toFixed(3) + ' x the flat lock; full-lock circle at 20 km/h ' + R.toFixed(2) + ' m');
});

test('v6.2 cues state.load / state.compress (g): 1 / 0 standing on the flat, downforce adds to load only, banking into the turn compresses, a crest lightens; no effect on the path', () => {
  const G = F1.CAR_PERF.gravity, DF = F1.CAR_PERF.downforce;
  const mk = bankDeg => {
    const tr = strip(4000), b = bankDeg * Math.PI / 180;
    for (const s of tr.samples) s.bank = b;
    return tr;
  };
  let car = ALONE.createCar(), st = car.state, tr = mk(0);
  car.reset(tr, 10);
  assert(st.load === 1 && st.compress === 0, 'after reset');
  car.update(STEP, {}, tr);
  near(st.load, 1, 1e-12, 'standing'); near(st.compress, 0, 1e-12, 'standing');
  const v0 = 300 / KMH;                       // (the load is the step's: from the speed it started with, one sub-step here)
  st.speed = v0; car.update(STEP, {}, tr);
  near(st.load, 1 + DF * v0 * v0 / G, 1e-9, '300 km/h: downforce'); near(st.compress, 0, 1e-9, '300 km/h on the flat');
  for (let n = 0; n < 30; n++) car.update(STEP, { steerAxis: 0.3 }, tr);
  near(st.compress, 0, 1e-9, 'cornering on the flat');
  // a road banked 19 deg (left higher): turning right (into it) compresses, left (off camber) lightens
  for (const [sx, sign] of [[-0.4, 1], [0.4, -1]]) {
    car = ALONE.createCar(); st = car.state; tr = mk(19); car.reset(tr, 10); st.speed = 150 / KMH;
    for (let n = 0; n < 60; n++) car.update(STEP, { steerAxis: sx, throttle: 0.6 }, tr);
    assert(sign * st.compress > 0.3, (sign > 0 ? 'into' : 'off') + ' the bank: compress ' + st.compress);
  }
  // a crest (kappaV > 0): the road falls away, the car lightens
  car = ALONE.createCar(); st = car.state; tr = strip(4000);
  tr.samples.forEach((s, i) => { s.y = -0.0005 * (s.z - 600) * (s.z - 600); });
  car.reset(tr, 250); st.speed = 200 / KMH;
  let minC = 0, vMax = 0;
  for (let n = 0; n < 240; n++) { car.update(STEP, { throttle: 0.7 }, tr); if (st.compress < minC) minC = st.compress; vMax = Math.max(vMax, st.speed); }
  // (v^2 kappaV / g: 0.31 g at 200 km/h on this 1000 m crest, a little more as the car accelerates over it)
  assert(minC < -0.3 && minC > -(vMax * vMax * 0.001 / G) - 0.05, 'over a crest: ' + minC + ' (v^2 kappa / g at the top speed ' + (vMax * vMax * 0.001 / G) + ')');
  info('banked 19 deg at 150 km/h: compress > 0.3 g into the turn, < -0.3 g off camber; crest (radius 1000 m) at 200 km/h: ' + minC.toFixed(2) + ' g');
});

test('v6.2: every track.locate gets the car\'s height (the sample\'s on reset), and Suzuka\'s bridge keeps a car on its level', () => {
  const tr = strip(2000), seen = [];
  tr.samples.forEach(s => { s.y = 3.25; });
  const loc = tr.locate;
  tr.locate = function (x, z, hint, y) { seen.push([hint, y]); return loc.call(tr, x, z, hint, y); };
  const car = F1.createCar(), st = car.state;
  car.reset(tr, 30);
  assert(seen.length === 1 && seen[0][0] === -1 && seen[0][1] === 3.25, 'reset: ' + JSON.stringify(seen));
  seen.length = 0;
  for (let n = 0; n < 10; n++) car.update(STEP, { up: true }, tr);
  assert(seen.length >= 10 && seen.every(a => a[1] === 3.25), 'update: ' + JSON.stringify(seen.slice(0, 3)));
  // the real bridge (js/track.js: a crossing whose roads are 3 m or more apart keeps both heights)
  const { track: su } = track('jp-1962'), B = (su.bridges || [])[0];
  if (!B) { info('jp-1962 has no bridge in this tracks-data.js / js/track.js: skipped'); return; }
  for (const [mine, other] of [[B.up, B.lo], [B.lo, B.up]]) {
    const c = F1.createCar(), s = c.state, N = su.samples.length;
    c.reset(su, other); c.update(STEP, {}, su);
    c.reset(su, mine);
    assert(s.sampleIndex === mine && Math.abs(s.y - su.samples[mine].y) < 1e-9, 'reset onto ' + mine + ': ' + s.sampleIndex + ' y ' + s.y);
    // put back at the crossing point with a stale index: the global re-locate takes the car's own level
    c.reset(su, (mine + (N >> 1)) % N);
    s.x = su.samples[mine].x + su.samples[mine].nx * 2; s.z = su.samples[mine].z + su.samples[mine].nz * 2; s.y = su.surfaceY(mine, 2);
    c.update(STEP, {}, su);
    const dd = Math.min(Math.abs(s.sampleIndex - mine), N - Math.abs(s.sampleIndex - mine));
    assert(dd <= 3, 'placed on ' + mine + ' with a stale index: located at ' + s.sampleIndex);
  }
  info('Suzuka bridge: ' + B.up + ' over ' + B.lo + ', ' + (+(B.separation || B.sep)).toFixed(2) + ' m apart; devtests/car-v6/crossing.js drives it');
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall car tests passed');
process.exit(failed ? 1 : 0);
