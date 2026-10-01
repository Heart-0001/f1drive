// node devtests/car-v6/traction-cap.js
//
// Review finding traction-cap-limits-top-speed (NOT changed, on purpose: the seasons data is calibrated with it).
// js/car.js drives with min(spec.traction, power / v) at every speed, so spec.traction also caps the top speed at
// sqrt((traction - ROLL) / dragK). For the reference car that is 337 km/h, just above its drag-limited 330 km/h: the cap
// binds for a traction multiplier below ~0.962 at reference power / drag. F1.carPerf(spec).topSpeed includes the cap
// (topFor), so the racing line, the HUD and the physics agree. This lists every CarSpec of js/seasons-data.js (via
// js/cars.js) whose top speed the cap lowers, and by how much.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
require(path.join(ROOT, 'js/seasons-data.js'));
require(path.join(ROOT, 'js/cars.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1;

function uncapped(p) {        // drag / power balance only (Newton, as carPerf's topFor without the traction cap)
  let v = 90;
  for (let i = 0; i < 100; i++) { const f = (p.dragK * v * v + p.roll) * v - p.power; v -= f / (3 * p.dragK * v * v + p.roll); }
  return v;
}
let n = 0, capped = 0, worst = 0, worstId = '';
for (const s of F1.cars.seasons) {
  for (const spec of F1.cars.list(s.year)) {
    n++;
    const p = F1.carPerf(spec), u = uncapped(p), lost = (u - p.topSpeed) * 3.6;
    if (lost > 1e-6) {
      capped++;
      console.log('  ' + spec.id.padEnd(28), 'traction', spec.traction.toFixed(3), ' top', (p.topSpeed * 3.6).toFixed(2),
        'km/h, without the cap', (u * 3.6).toFixed(2), '(-' + lost.toFixed(2) + ')');
      if (lost > worst) { worst = lost; worstId = spec.id; }
    }
  }
}
console.log(n + ' CarSpecs of ' + F1.cars.seasons.length + ' seasons; traction-capped top speed: ' + capped +
  (capped ? ', worst ' + worstId + ' -' + worst.toFixed(2) + ' km/h' : ''));
