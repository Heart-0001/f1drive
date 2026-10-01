// A driver who saves the battery for the end of Monza's main straight: 2025 vs 2026 standard cars. Full throttle from
// 200 km/h over 1100 m (the Monza straight), boost only for the last `tBoost` seconds of the store. Speed at the end.
'use strict';
const { F1, STEP, KMH, strip } = require('./load');
const tr = strip(40000);
for (const y of [2025, 2026]) {
  const spec = F1.cars.resolve(y + '-standard', y);
  const res = [];
  for (const L of [900, 1100, 1400]) {
    const end = boost => { const c = F1.createCar(spec, { tyres: false }); c.reset(tr, 0); c.state.speed = 200 / KMH; c.setBattery(1); while (c.state.z < L) c.update(STEP, { up: true, boost }, tr); return c.state.speed * KMH; };
    res.push({ straightM: L, noBoost: end(false).toFixed(0), boostAllTheWay: end(true).toFixed(0) });
  }
  console.log(y + ' standard: ers ' + Math.round(spec.ers.power) + ' W/kg, store ' + (spec.ers.store / spec.ers.power).toFixed(0) + ' s, top ' + (F1.carPerf(spec).topSpeed * KMH).toFixed(0) + ' km/h, top deploying ' + (F1.carPerf(spec).topSpeedBoost * KMH).toFixed(0) + ' km/h');
  console.table(res);
}
