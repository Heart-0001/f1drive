// 2026 cars: a Monza / Spa lap with "sensible deployment" (boost on full throttle above 100 km/h) vs none; peak speed,
// lap time, store recovered per lap. Same for the 2025 reference and 2014.
'use strict';
const { F1, STEP, KMH, track, lineWant, keysSteer } = require('./load');
function lap(tr, line, spec, boostRule, laps) {
  const car = F1.createCar(spec, { tyres: false }), st = car.state, N = tr.samples.length;
  car.reset(tr, N - 10); car.setBattery(1);
  const lc = F1.createLapCounter(N, st.sampleIndex), inp = { up: false, down: false, left: false, right: false, boost: false };
  const out = []; let cur = null, t = 0;
  while (out.length < laps && t < 600) {
    const w = lineWant(tr, line, st), v = st.speed;
    inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, st, w.steer);
    inp.boost = !!(boostRule && boostRule(inp, st));
    car.update(STEP, inp, tr); t += STEP;
    if (cur) { cur.vmax = Math.max(cur.vmax, st.speed * KMH); cur.har += st.harvest * spec.ers.harvest * STEP / spec.ers.store; cur.dep += st.deploy * spec.ers.power * STEP / spec.ers.store; if (st.hit > 0) cur.hits++; if (st.onGrass) cur.grass++; }
    const r = lc.update(st.sampleIndex, st.speed, STEP);
    if (r === 2) { cur.time = lc.last; cur.batEnd = st.battery; out.push(cur); }
    if (r === 1 || r === 2) cur = { vmax: 0, har: 0, dep: 0, hits: 0, grass: 0 };
  }
  return out;
}
const rows = [];
for (const id of ['it-1922', 'be-1925', 'sa-2021']) {
  const { track: tr, line } = track(id);
  for (const y of [2014, 2025, 2026]) {
    const spec = F1.cars.resolve(y + '-standard', y);
    const n = lap(tr, line, spec, null, 3), b = lap(tr, line, spec, (i, s) => i.up && !i.down && s.speed > 100 / KMH, 3);
    const avg = a => a.slice(1).reduce((x, l) => x + l.time, 0) / (a.length - 1);
    rows.push({ track: id, year: y, ersW: Math.round(spec.ers.power), store_s: +(spec.ers.store / spec.ers.power).toFixed(1), harvW: Math.round(spec.ers.harvest),
      lapNo: avg(n).toFixed(2), lapBoost: avg(b).toFixed(2), gainS: (avg(n) - avg(b)).toFixed(2), vmaxNo: n[2].vmax.toFixed(0), vmaxBoost: b[2].vmax.toFixed(0),
      harvPerLapNo: Math.round(n[2].har * 100) + '%', harvPerLapBoost: Math.round(b[2].har * 100) + '%', depPerLap: Math.round(b[2].dep * 100) + '%', batEnd: Math.round(b[2].batEnd * 100) + '%', hitsGrass: b.map(l => l.hits + '/' + l.grass).join(' ') });
  }
}
console.table(rows);
