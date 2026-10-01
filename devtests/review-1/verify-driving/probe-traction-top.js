// Verify finding traction-cap-limits-top-speed: does spec.traction (and the tyres' traction multiplier) cap the top
// speed in the real physics (car.update on a long flat strip), not only in carPerf.topSpeed?
// node devtests/review-1/verify-driving/probe-traction-top.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/cars-data.js'));
const F1 = global.F1, R = F1.REF_SPEC;

function strip(len) {
  const a = [], n = Math.round(len / 2);
  for (let i = 0; i < n; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: false, wallNeg: false, halfW: 50, wallPosDist: 60, wallNegDist: 60 });
  return { samples: a, halfWidth: 50, wallDist: 60, length: n * 2, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
}
const TR = strip(80000);
function uncapped(p) {        // drag / power balance only
  let v = 90; for (let i = 0; i < 100; i++) { const f = (p.dragK * v * v + p.roll) * v - p.power; v -= f / (3 * p.dragK * v * v + p.roll); }
  return v;
}
function drive(spec, tyres) {
  const car = F1.createCar(spec, tyres ? { tyres } : undefined);
  if (car.tyres && car.tyres.setWearRate) car.tyres.setWearRate(0);
  car.reset(TR, 0); car.state.x = 0; car.state.z = 10; car.state.heading = 0;
  let v = 0;
  for (let n = 0; n < 120 * 150; n++) { car.update(1 / 120, { up: true }, TR); v = car.state.speed; }
  return v;
}
const row = (label, spec, tyres) => {
  const p = F1.carPerf(spec);
  console.log(label.padEnd(44), 'uncapped', (uncapped(p) * 3.6).toFixed(1), ' carPerf.topSpeed', (p.topSpeed * 3.6).toFixed(1),
    ' physics (150 s flat out)', (drive(spec, tyres) * 3.6).toFixed(1), 'km/h');
};
const S = m => Object.assign({}, R, { traction: R.traction * (m.t || 1), power: R.power * (m.p || 1), dragK: R.dragK * (m.d || 1) });
row('reference', R);
for (const t of [0.99, 0.97, 0.96, 0.95, 0.9]) row('traction x' + t, S({ t }));
for (const t of [1, 0.98, 0.95]) row('traction x' + t + ', power x1.05, drag x0.95', S({ t, p: 1.05, d: 0.95 }));

// tyres: car.js multiplies the constant drivetrain cap by tyres.state.grip.traction, so worn / dirty tyres cap the
// reference car's top speed too (stub tyres with a fixed traction multiplier)
for (const g of [1, 0.97, 0.95, 0.9, 0.88]) {
  const stub = { state: { grip: { lat: 1, brake: 1, traction: g }, puncture: -1, vib: 0 }, update() {}, setWearRate() {} };
  row('reference, tyres grip.traction ' + g, R, stub);
}

// the shipped 2026 cars (js/cars-data.js): are any of them traction-capped?
let capped = 0;
for (const c of global.F1_CARS || []) {
  const m = c.perf, spec = Object.assign({}, R, { power: R.power * m.power, dragK: R.dragK * m.drag, traction: R.traction * m.traction });
  const p = F1.carPerf(spec), u = uncapped(p);
  if (p.topSpeed < u - 1e-6) capped++;
  console.log('  2026 ' + c.id.padEnd(14), 'traction x' + m.traction, ' uncapped', (u * 3.6).toFixed(2), ' carPerf', (p.topSpeed * 3.6).toFixed(2), ' est.topKmh', c.est.topKmh);
}
console.log('2026 cars (cars-data.js) with a traction-capped top speed:', capped);
// threshold: the traction multiplier below which the cap binds, reference power / drag
const p0 = F1.carPerf(R), v0 = uncapped(p0);
console.log('reference: cap binds below traction multiplier', ((p0.dragK * v0 * v0 + p0.roll) / R.traction).toFixed(4),
  '; drive at 330 km/h = power/v', (R.power / v0).toFixed(3), 'm/s^2 vs traction', R.traction);
