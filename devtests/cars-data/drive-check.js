// node devtests/cars-data/drive-check.js [track-regex]
//
// Cross-check of the lap-time estimates in js/cars-data.js with the REAL car physics: every car of F1_CARS is
// driven by the racing-line autopilot (the one of devtests/raceline-test/test.js: pure pursuit on the line,
// throttle / brake from the line's own advice) for 3 laps on each of the 15 circuits, and the flying lap is
// compared with the standard car's. Deterministic (fixed 1/120 s step, no randomness).
//
// js/car.js (v5) has its tuning as constants and takes no per-car spec yet, so each car gets its own in-memory
// copy of the js/car.js source with the constants multiplied (nothing on disk is changed). The patched copy's
// F1.CAR_PERF is compared with model.js before it is driven. Once js/car.js implements the v6 contract
// (F1.REF_SPEC, F1.carPerf(spec), F1.createCar(spec), F1.buildRaceLine(track, perf)) that path is used
// instead - it is written against README-interfaces.md and could not be tested yet.
//
// Writes devtests/cars-data/drive-check.json (read by derive.js for the documentation). Exit code 1 when a car
// leaves the road / hits a wall on its flying lap or the pace order of the drive differs from the data's.
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./model.js');
const I = require('./inputs.js');
M.load();
const F1 = global.F1, TR = global.F1_TRACKS;
const CARS = require(path.join(M.ROOT, 'js', 'cars-data.js'));
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const HZ = 120, LAPS = 3;

const carSrc = fs.readFileSync(path.join(M.ROOT, 'js', 'car.js'), 'utf8');
const hasSpecApi = typeof F1.carPerf === 'function' && F1.REF_SPEC && typeof F1.REF_SPEC === 'object';

// v5: a private copy of car.js with the constants of this car
function patchedCar(mult) {
  const p = M.makePerf(mult, false), B = M.BASE;
  let src = carSrc, n = 0;
  const rep = (re, text) => { if (!re.test(src)) throw new Error('js/car.js changed: cannot find ' + re); src = src.replace(re, text); n++; };
  rep(/var TOP_SPEED = [^;]+;/, 'var TOP_SPEED = ' + p.topSpeed + ';');
  rep(/var DRAG_K = [^;]+;/, 'var DRAG_K = ' + p.dragK + ';');
  rep(/var TRACTION = [^;]+;/, 'var TRACTION = ' + p.traction + ';');
  rep(/var POWER = [^;]+;/, 'var POWER = ' + p.power + ';');
  rep(/var BRAKE_BASE = [^;]+;/, 'var BRAKE_BASE = ' + p.brakeBase + ';');
  rep(/var BRAKE_AERO = [^;]+;/, 'var BRAKE_AERO = ' + (B.brakeDrag + p.muBrake * p.downforce) + ';');
  rep(/var LAT_BASE = [^;]+;/, 'var LAT_BASE = ' + p.latBase + ';');
  rep(/var LAT_AERO = [^;]+;/, 'var LAT_AERO = ' + (p.downforce * p.muLat) + ';');
  rep(/var LAT_MAX = [^;]+;/, 'var LAT_MAX = ' + p.latMax + ';');
  const root = { F1: {} };
  new Function('window', 'globalThis', src)(root, root);
  const cp = root.F1.CAR_PERF;
  for (const k of ['topSpeed', 'dragK', 'traction', 'power', 'latMax', 'muLat', 'muTraction', 'muBrake', 'downforce', 'brakeDrag']) {
    if (!(Math.abs(cp[k] - p[k]) <= 1e-9 * Math.abs(p[k]))) throw new Error('patched car.js: ' + k + ' = ' + cp[k] + ', model ' + p[k]);
  }
  return { create: () => root.F1.createCar(), perf: cp };
}
// v6 contract (untested: js/car.js did not have it when this was written)
function specCar(mult) {
  const R = F1.REF_SPEC, s = Object.assign({}, R);
  s.power = R.power * mult.power; s.dragK = R.dragK * mult.drag; s.downforce = R.downforce * mult.downforce;
  s.latBase = R.latBase * mult.grip; s.latMax = R.latMax * mult.grip; s.brakeBase = R.brakeBase * mult.brake;
  s.traction = R.traction * mult.traction;
  if (R.ers) s.ers = Object.assign({}, R.ers, { power: R.ers.power * mult.ersPower, harvest: R.ers.harvest * mult.ersHarvest });
  return { create: () => { const c = F1.createCar(s); if (c.tyres && c.tyres.setWearRate) c.tyres.setWearRate(0); return c; }, perf: F1.carPerf(s) };
}

function drive(td, maker) {
  const track = F1.buildTrack(td);
  const saved = F1.CAR_PERF;
  let line;
  if (hasSpecApi) line = F1.buildRaceLine(track, maker.perf);
  else { F1.CAR_PERF = maker.perf; line = F1.buildRaceLine(track); F1.CAR_PERF = saved; }
  const car = maker.create();
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  car.reset(track, 0);
  const dt = 1 / HZ, input = { up: false, down: false, left: false, right: false };
  let t = 0, lapStart = 0, prevIdx = 0, grass = 0, hits = 0;
  const laps = [];
  while (laps.length < LAPS && t < 900) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, track);
    t += dt;
    if (laps.length >= 1) { if (st.onGrass) grass++; if (st.hit > 0) hits++; }
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) {
      // the moment of crossing inside this step (finer than 1/120 s): distance past the line / speed
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = t - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prevIdx = st.sampleIndex;
  }
  const pred = line.lapTime;
  if (line.dispose) line.dispose();
  if (track.dispose) track.dispose();
  return { laps: laps, flying: laps.length >= 2 ? Math.min.apply(null, laps.slice(1)) : NaN, pred: pred, grass: grass, hits: hits };
}

const tracks = I.SEASON.trackIds.map(id => TR.find(t => t.id === id)).filter(td => !filter || filter.test(td.name) || filter.test(td.id));
console.log((hasSpecApi ? 'js/car.js v6 spec API' : 'js/car.js v5: patched in-memory copies of its constants') + '; ' + tracks.length + ' circuits, ' + HZ + ' Hz, flying lap of ' + LAPS);
const rows = [];
let bad = 0;
for (const c of CARS) {
  const maker = hasSpecApi ? specCar(c.perf) : patchedCar(c.perf);
  const r = { id: c.id, est: c.est.lapPct, laps: [], pred: [], off: 0 };
  for (const td of tracks) {
    const d = drive(td, maker);
    r.laps.push(d.flying); r.pred.push(d.pred);
    if (!(d.flying > 0) || d.grass || d.hits) { r.off++; console.log('  ' + c.id + ' @ ' + td.name + ': flying ' + d.flying + ' s, grass steps ' + d.grass + ', wall steps ' + d.hits); }
  }
  rows.push(r);
}
const std = rows[0], mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log('car            estimate %   driven %   line-profile %   (mean over the circuits, vs the standard car)   worst / best circuit (driven %)');
for (const r of rows) {
  r.drivenPct = r.laps.map((t, i) => (t / std.laps[i] - 1) * 100);
  r.profilePct = r.pred.map((t, i) => (t / std.pred[i] - 1) * 100);
  r.driven = mean(r.drivenPct); r.profile = mean(r.profilePct);
  if (r.off) bad++;
  console.log(r.id.padEnd(14) + r.est.toFixed(2).padStart(10) + r.driven.toFixed(3).padStart(11) + r.profile.toFixed(3).padStart(15) + ''.padStart(52) +
    Math.max.apply(null, r.drivenPct).toFixed(2) + ' / ' + Math.min.apply(null, r.drivenPct).toFixed(2));
}
const teams = rows.slice(1);
const orderEst = teams.slice().sort((a, b) => a.profile - b.profile).map(r => r.id).join(' ');
const orderDrv = teams.slice().sort((a, b) => a.driven - b.driven).map(r => r.id).join(' ');
const spread = Math.max.apply(null, teams.map(r => r.driven)) - Math.min.apply(null, teams.map(r => r.driven));
console.log('driven spread fastest .. slowest: ' + spread.toFixed(3) + ' %');
console.log('order (line profile): ' + orderEst);
console.log('order (driven):       ' + orderDrv + (orderEst === orderDrv ? '   SAME' : '   DIFFERENT'));
if (!filter) {
  const r3 = v => Math.round(v * 1000) / 1000;
  fs.writeFileSync(path.join(__dirname, 'drive-check.json'), JSON.stringify({
    generatedBy: 'devtests/cars-data/drive-check.js', physics: hasSpecApi ? 'js/car.js spec API' : 'js/car.js v5 constants patched in memory',
    hz: HZ, circuits: tracks.map(t => t.id), spreadPct: r3(spread), sameOrder: orderEst === orderDrv, offTrackRuns: bad,
    standardLaps: std.laps.map(r3),
    cars: rows.map(r => ({ id: r.id, estimatePct: r.est, drivenPct: r3(r.driven), lineProfilePct: r3(r.profile), perCircuitDrivenPct: r.drivenPct.map(r3) }))
  }, null, 1) + '\n');
  console.log('wrote devtests/cars-data/drive-check.json');
}
if (bad || orderEst !== orderDrv) process.exitCode = 1;
