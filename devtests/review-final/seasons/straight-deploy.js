// Review scratch: how fast does each season's standard car get on a 1.2 km straight from 250 km/h with the
// battery full and E held, and how does that compare with no battery? (Monza main straight ~1.1 km.)
global.window = global;
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(ROOT + '/js/seasons-data.js');
require(ROOT + '/js/cars.js');
require(ROOT + '/js/car.js');
const F1 = global.F1, KMH = 3.6;
function straight(len) {
  const a = [];
  for (let i = 0; i * 2 <= len; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, wallPos: 12, wallNeg: 12 });
  const n = a.length;
  return { samples: a, halfWidth: 7, wallDist: 12, length: n * 2,
    locate(x, z, hint) { let best = -1, bd = Infinity; for (let i = 0; i < n; i++) { const d = (x - a[i].x) ** 2 + (z - a[i].z) ** 2; if (d < bd) { bd = d; best = i; } } return { index: best, d: x }; } };
}
const t = straight(4000), DT = 1 / 120;
for (const y of [2010, 2012, 2014, 2020, 2025, 2026]) {
  const spec = F1.cars.resolve('standard', y);
  const out = [];
  for (const boost of [false, true]) {
    const car = F1.createCar(spec, { tyres: false }); car.reset(t, 0); car.state.speed = 250 / KMH; car.state.z = 0;
    let peak = 0, at1200 = null, z0 = car.state.z, time = 0, batEmpty = null;
    while (car.state.z - z0 < 2000 && time < 60) {
      car.update(DT, { up: true, boost }, t); time += DT;
      const k = car.state.speed * KMH; if (k > peak) peak = k;
      if (at1200 === null && car.state.z - z0 >= 1200) at1200 = k;
      if (boost && batEmpty === null && car.state.battery <= 0) batEmpty = (car.state.z - z0).toFixed(0);
    }
    out.push((boost ? 'E held' : 'no E  ') + ': at 1200 m ' + at1200.toFixed(1) + ' km/h, peak over 2 km ' + peak.toFixed(1) + (boost ? ' (battery empty at ' + batEmpty + ' m)' : ''));
  }
  const p = F1.carPerf(spec);
  console.log(y + ' std  top ' + (p.topSpeed * KMH).toFixed(1) + ' boostTop ' + (p.topSpeedBoost * KMH).toFixed(1) + '\n   ' + out.join('\n   '));
}
