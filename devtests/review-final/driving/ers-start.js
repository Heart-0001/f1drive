// ERS: the standing start and the straights, reference car + a few season cars; what the boost adds and when.
'use strict';
const { F1, STEP, KMH, strip } = require('./load');
const tr = strip(40000);
function run(spec, boost, T, v0) {
  const c = F1.createCar(spec, { tyres: false }); c.reset(tr, 0); c.state.speed = (v0 || 0) / KMH; c.setBattery(1);
  const marks = {}, times = {};
  let t = 0;
  for (; t < T; t += STEP) {
    c.update(STEP, { up: true, boost }, tr);
    for (const m of [2, 4, 6, 8, 10, 12]) if (!(m in marks) && t + STEP >= m - 1e-9) marks[m] = c.state.speed * KMH;
    for (const v of [100, 200, 300]) if (!(v in times) && c.state.speed * KMH >= v) times[v] = +(t + STEP).toFixed(2);
  }
  return { marks, times, bat: c.state.battery, v: c.state.speed * KMH };
}
const specs = [['2025 standard (ref)', F1.REF_SPEC]];
for (const y of [2011, 2014, 2021, 2026]) specs.push([y + ' standard', F1.cars.resolve(y + '-standard', y)]);
specs.push(['2026 fastest ers', F1.cars.list(2026).slice().sort((a, b) => b.ratings.ers - a.ratings.ers)[0]]);
const rows = [];
for (const [name, spec] of specs) {
  const a = run(spec, false, 12), b = run(spec, true, 12);
  const P = F1.carPerf(spec);
  rows.push({ car: name, ersW: spec.ers ? Math.round(spec.ers.power) : 0, store_s: spec.ers ? +(spec.ers.store / spec.ers.power).toFixed(0) : 0,
    '0-100': a.times[100] + ' / ' + b.times[100], '0-200': a.times[200] + ' / ' + b.times[200], '0-300': a.times[300] + ' / ' + b.times[300],
    'v@4s': a.marks[4].toFixed(0) + ' / ' + b.marks[4].toFixed(0), 'v@8s': a.marks[8].toFixed(0) + ' / ' + b.marks[8].toFixed(0) + ' (+' + (b.marks[8] - a.marks[8]).toFixed(1) + ')',
    'v@12s': a.marks[12].toFixed(0) + ' / ' + b.marks[12].toFixed(0), bat8s: 'n/a', top: (P.topSpeed * KMH).toFixed(0) + ' / ' + (P.topSpeedBoost * KMH).toFixed(0), battAfter12: (b.bat * 100).toFixed(0) + '%' });
}
console.table(rows);
// where does the ERS add the most? extra acceleration per speed for the reference car
const P = F1.CAR_PERF, E = F1.REF_SPEC.ers;
const line = [];
for (const kmh of [20, 50, 100, 150, 200, 250, 300]) {
  const v = kmh / KMH;
  const base = Math.min(P.traction, P.power / Math.max(v, 1));
  const cap = P.muTraction * (9.81 + P.downforce * v * v);
  const add = Math.min(cap, base + E.power / v) - base;
  line.push({ kmh, engineAccel: base.toFixed(2), tyreCap: cap.toFixed(2), ersAdd: add.toFixed(2), pct: (100 * add / base).toFixed(0) + '%', powerLimited: P.power / v < P.traction });
}
console.table(line);
console.log('engine power ' + P.power.toFixed(0) + ' W/kg; traction-capped (not power-limited) below ' + (P.power / P.traction * KMH).toFixed(0) + ' km/h');
