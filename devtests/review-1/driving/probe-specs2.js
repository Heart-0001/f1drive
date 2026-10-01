'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1, R = F1.REF_SPEC;
const S = F1.sanitizeSpec;
console.log('gearKmh with NaN element ->', S({ gearKmh: [60, NaN, 140] }).gearKmh);
console.log('topKmh below last gear ->', S({ gearKmh: [60, 100, 400], topKmh: 300 }).topKmh);
console.log('ers {} ->', S({ ers: {} }).ers, ' ers 0 ->', S({ ers: 0 }).ers, ' ers "x" ->', S({ ers: 'x' }).ers);
console.log('power = Infinity ->', S({ power: Infinity }).power, ' rpmMax < rpmShift ->', S({ rpmShift: 15000, rpmMax: 12000 }).rpmMax);
for (const tm of [1, 0.98, 0.95, 0.9]) {
  const p = F1.carPerf({ traction: R.traction * tm });
  const p2 = F1.carPerf({ traction: R.traction * tm, power: R.power * 1.05, dragK: R.dragK * 0.95 });
  console.log('traction x' + tm, 'topSpeed', (p.topSpeed * 3.6).toFixed(1), 'km/h; with +5% power -5% drag:', (p2.topSpeed * 3.6).toFixed(1));
}
const p4 = F1.carPerf({ power: R.power * 4, traction: R.traction * 4, dragK: R.dragK / 4 });
console.log('4x power, 4x traction, 1/4 drag: topSpeed km/h', (p4.topSpeed * 3.6).toFixed(0), 'topBoost', (p4.topSpeedBoost * 3.6).toFixed(0));
