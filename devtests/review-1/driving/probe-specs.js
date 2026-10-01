// Probe: every season car through F1.carPerf: is the top speed traction-capped rather than power/drag-capped?
// And a few sanitizeSpec edge cases.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/seasons-data.js'));
require(path.join(ROOT, 'js/cars.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1;
let capped = [], total = 0, noErs = [];
for (const s of F1.cars.seasons) {
  for (const spec of F1.cars.list(s.year)) {
    total++;
    const p = F1.carPerf(spec);
    const vt = Math.sqrt((p.traction - p.roll) / p.dragK);
    // drag-limited speed: solve (dragK v^2 + roll) v = power
    let v = 90; for (let i = 0; i < 100; i++) { const f = (p.dragK * v * v + p.roll) * v - p.power; v -= f / (3 * p.dragK * v * v + p.roll); }
    if (vt < v - 0.01) capped.push({ id: spec.id, tractionCap: +(vt * 3.6).toFixed(1), powerLimit: +(v * 3.6).toFixed(1), topSpeed: +(p.topSpeed * 3.6).toFixed(1), rTop: spec.ratings.topSpeed, rAcc: spec.ratings.accel });
    if (!spec.ers) noErs.push(spec.id);
  }
}
console.log('cars', total, 'traction-capped top speed:', capped.length);
console.table(capped.slice(0, 20));
console.log('no ERS years:', [...new Set(noErs.map(i => i.slice(0, 4)))]);

// sanitizeSpec edge cases
const S = F1.sanitizeSpec;
console.log('gearKmh with NaN element ->', S({ gearKmh: [60, NaN, 140] }).gearKmh);
console.log('topKmh below last gear ->', S({ gearKmh: [60, 100, 400], topKmh: 300 }).topKmh);
console.log('ers {} ->', S({ ers: {} }).ers, ' ers 0 ->', S({ ers: 0 }).ers, ' ers "x" ->', S({ ers: 'x' }).ers);
console.log('power = Infinity ->', S({ power: Infinity }).power, ' rpmMax < rpmShift ->', S({ rpmShift: 15000, rpmMax: 12000 }).rpmMax);
const p2 = F1.carPerf({ power: F1.REF_SPEC.power * 4, traction: F1.REF_SPEC.traction * 4, dragK: F1.REF_SPEC.dragK / 4 });
console.log('4x power, 4x traction, 1/4 drag: topSpeed km/h', (p2.topSpeed * 3.6).toFixed(0), 'topBoost', (p2.topSpeedBoost * 3.6).toFixed(0));
