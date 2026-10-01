// node devtests/tyres-test/golden.js [track id, default au-1953] [compound S|M|H] [rate] [laps]
//
// The tyres THROUGH the real car. js/car.js is not wired to the tyres yet (another step does it), so this takes the v5
// car (devtests/tyres-test/car-v5.js, the golden-rule reference) and patches it in memory the way the contract says
// car.js will use js/tyres.js: lateral grip, braking and traction multiplied by tyres.state.grip, and tyres.update(dt,
// load) after every car.update with the load of the contract (lat = requested / available lateral accel, slip =
// 2 * overshoot, brake pedal, drive = share of the traction limit used, grass, wall hit).
//   1. golden rule: the patched car on a new medium set at wear rate 1 and the untouched car, same autopilot, side by
//      side for the first 2 laps: every step must be bit-identical (x, z, heading, speed).
//   2. a stint: the patched car alone until the tyres are finished: lap time, wear, grip, grass steps per lap.
// The autopilot (devtests/gp-e2e/autopilot.js) drives the racing line computed for NEW tyres at pace 1, so on worn
// tyres it overdrives the corners: that shows what the wear does to a driver who does not adapt.
'use strict';
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(__dirname, 'car-v5.js'));
require(path.join(ROOT, 'js/raceline.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const createAutopilot = require(path.join(ROOT, 'devtests/gp-e2e/autopilot.js'));
const Tyres = require(path.join(ROOT, 'js/tyres.js'));
const F1 = global.F1;
const createCarRef = F1.createCar;

// ---- the patched car: the v5 source with the tyre hook -----------------------------------------------------------
let src = fs.readFileSync(path.join(__dirname, 'car-v5.js'), 'utf8').replace(/\r\n/g, '\n');
function patch(a, b) { if (!src.includes(a)) throw new Error('car-v5.js: not found: ' + a); src = src.replace(a, b); }
patch("F1.CAR_PERF = {", "var __unused = {");                                  // keep the reference CAR_PERF
patch("F1.createCar = function () {", "F1.createCarTyres = function (tyres) {\n    var TL = { speed: 0, lat: 0, brake: 0, drive: 0, slip: 0, onGrass: false, hit: 0 };");
patch("        var latMax = Math.max(0, Math.min(m1, m2));", "        var latMax = Math.max(0, Math.min(m1, m2)) * tyres.state.grip.lat;");
patch("        var latReq = aLeft * ts;", "        var latReq = aLeft * ts;\n        TL.lat = latMax > 0 ? ts * Math.min(1, latReq / latMax) : 0; TL.slip = latMax > 0 && latReq > latMax ? Math.min(1, 2 * (latReq / latMax - 1)) : 0;");
patch("      if (aLeft !== 0) {", "      TL.lat = 0; TL.slip = 0;\n      if (aLeft !== 0) {");
patch("      var traction = grass ? Math.min(TRACTION_GRASS, MU_TRACTION_GRASS * an) : Math.min(TRACTION, MU_TRACTION * an);\n      var brake = grass ? Math.min(BRAKE_GRASS, MU_BRAKE_GRASS * an) : MU_BRAKE * an + BRAKE_DRAG * av * av;",
      "      var traction = (grass ? Math.min(TRACTION_GRASS, MU_TRACTION_GRASS * an) : Math.min(TRACTION, MU_TRACTION * an)) * tyres.state.grip.traction;\n" +
      "      var brake = (grass ? Math.min(BRAKE_GRASS, MU_BRAKE_GRASS * an) : MU_BRAKE * an + BRAKE_DRAG * av * av) * tyres.state.grip.brake;\n" +
      "      TL.brake = v > 0.5 ? brk : 0; TL.drive = v > 0.5 ? thr * (1 - brk) * Math.min(traction, POWER / Math.max(av, 1)) / traction : (thr > 0 && thr >= brk ? thr : 0);");
patch("      state.pitch += (Math.atan(slopeFwd) - state.pitch) * k;\n      state.roll += (Math.atan(slopeLeft) - state.roll) * k;",
      "      state.pitch += (Math.atan(slopeFwd) - state.pitch) * k;\n      state.roll += (Math.atan(slopeLeft) - state.roll) * k;\n" +
      "      TL.speed = state.speed; TL.onGrass = state.onGrass; TL.hit = state.hit;\n      tyres.update(dt, TL);");
patch("return { state: state, reset: reset, update: update };", "return { state: state, reset: reset, update: update, tyres: tyres };");
new Function('root', src.replace(/^\(function \(root\) \{/m, '(function (root) {').replace(/\}\)\(typeof window !== 'undefined' \? window : globalThis\);\s*$/, '})(root);'))(global);
if (typeof F1.createCarTyres !== 'function') throw new Error('patch failed');

const trackId = process.argv[2] || 'au-1953', compound = process.argv[3] || 'M', rate = +(process.argv[4] || 1);
const maxLaps = +(process.argv[5] || 40);
const td = global.F1_TRACKS.find(t => t.id === trackId);
const track = F1.buildTrack(td), line = F1.buildRaceLine(track), N = track.samples.length;
const STEP = 1 / 120;
const fmt = t => t == null ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
let failures = 0;
function check(ok, what) { console.log((ok ? '  ok    ' : '  FAIL  ') + what); if (!ok) failures++; }

function makeCar(car) {
  const ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = 1;
  car.reset(track, N - 10);
  return { car, ap, st: car.state, lap: createLapCounter(N, car.state.sampleIndex), laps: [], n: 0, t: 0,
    input: { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null } };
}
function step(c) {
  if (c.n++ % 2 === 0) {                                   // 60 Hz controller, like the e2e runs
    const o = c.ap.step({ t: c.t, st: c.st, track, line, locked: false, others: [] });
    c.input.throttle = o.throttle > 0 ? o.throttle : null; c.input.brake = o.brake > 0 ? o.brake : null; c.input.steerAxis = o.steer !== 0 ? o.steer : null;
    if (o.reset) { c.car.reset(track, c.st.sampleIndex); c.lap.sync(c.st.sampleIndex); c.resets = (c.resets || 0) + 1; }
  }
  c.car.update(STEP, c.input, track);
  c.t += STEP;
  return c.lap.update(c.st.sampleIndex, c.st.speed, STEP);
}

// ---- 1. golden rule -----------------------------------------------------------------------------------------------
console.log(td.name + ' (' + (track.length / 1000).toFixed(2) + ' km), compound ' + compound + ', wear rate ' + rate);
{
  const tyres = Tyres.createTyres({ random: () => 0.5 }); tyres.fit('M'); tyres.setWearRate(1);
  const a = makeCar(createCarRef()), b = makeCar(F1.createCarTyres(tyres));
  let diff = 0, steps = 0, firstDiff = -1, gripNot1 = 0, firstNot1 = -1, lapsAt1 = 0;
  while (a.laps.length < 3 && a.t < 600) {
    const ca = step(a), cb = step(b); steps++;
    if (ca === 2) a.laps.push(a.lap.last);
    if (cb === 2) b.laps.push(b.lap.last);
    const g = tyres.state.grip;
    if (g.lat !== 1 || g.brake !== 1 || g.traction !== 1) { gripNot1++; if (firstNot1 < 0) { firstNot1 = steps; lapsAt1 = b.lap.progress(b.st.sampleIndex); } }
    if (a.st.x !== b.st.x || a.st.z !== b.st.z || a.st.heading !== b.st.heading || a.st.speed !== b.st.speed) { diff++; if (firstDiff < 0) firstDiff = steps; }
  }
  if (firstNot1 < 0) firstNot1 = Infinity;
  check(firstDiff < 0 || firstDiff > firstNot1, 'golden rule: new mediums at wear rate 1 vs the untouched v5 car: bit-identical (x, z, heading, speed) at every step while the ' +
    'multipliers are exactly 1: ' + (firstDiff < 0 ? 'all ' + steps + ' steps' : 'first difference at step ' + firstDiff + ', multipliers left 1 at step ' + firstNot1));
  check(lapsAt1 === 0 || lapsAt1 > 2.2, 'the multipliers stay exactly 1 for more than 2 laps (race distance ' + (lapsAt1 || 'all').toString().slice(0, 5) + ' from the start of timing) ' +
    '(' + steps + ' steps): laps ' + a.laps.map(fmt).join(' ') + ' / ' + b.laps.map(fmt).join(' ') +
    '; wear after it ' + tyres.state.wear.map(w => (w * 100).toFixed(1) + '%').join(' ') + ', grip != 1 in ' + gripNot1 + ' steps');
}

// ---- 2. a stint ---------------------------------------------------------------------------------------------------
{
  const tyres = Tyres.createTyres({ random: (s => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; })(9) });
  tyres.fit(compound); tyres.setWearRate(rate);
  const c = makeCar(F1.createCarTyres(tyres));
  let grass = 0, slipSteps = 0, maxT = 0, hits = 0, lastLap = 0;
  const rows = [];
  while (c.laps.length < maxLaps && c.t < 20000) {
    const r = step(c);
    if (c.st.onGrass) grass++;
    if (c.st.hit > 0) hits++;
    maxT = Math.max(maxT, ...tyres.state.temp);
    if (r === 2) {
      c.laps.push(c.lap.last);
      const s = tyres.state;
      rows.push([c.laps.length, c.lap.last, s.wear.slice(), s.grip.lat, s.grip.brake, s.grip.traction, grass, hits, maxT, s.puncture, Math.max(...s.flat), s.vib]);
      grass = 0; hits = 0; maxT = 0;
      if (s.puncture >= 0 && ++lastLap >= 2) break;         // two laps on a puncture, then stop
    }
  }
  const best = Math.min(...c.laps);
  console.log('\n  stint: lap  time      +best   wear FL FR RL RR           grip lat/brake/trac   grass hits  Tmax  flat  punct');
  for (const r of rows) {
    console.log('  ' + String(r[0]).padStart(10) + '  ' + fmt(r[1]) + '  +' + (r[1] - best).toFixed(2).padStart(5) + '   ' + r[2].map(w => (w * 100).toFixed(0).padStart(3) + '%').join(' ') +
      '   ' + [r[3], r[4], r[5]].map(x => x.toFixed(3)).join(' / ') + '   ' + String(r[6]).padStart(5) + ' ' + String(r[7]).padStart(4) + '  ' + r[8].toFixed(0) +
      '  ' + r[10].toFixed(2) + '  ' + (r[9] >= 0 ? ['FL', 'FR', 'RL', 'RR'][r[9]] : '--'));
  }
  check(rows.length >= 3, 'stint driven: ' + rows.length + ' laps, resets ' + (c.resets || 0));
}
console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
