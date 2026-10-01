// D2 verification on real tracks: the line driver, (a) no boost, (b) boost held on the throttle above 100 km/h
// everywhere, (c) boost saved for the longest full-throttle stretch of the lap only. Peak speed on that stretch,
// lap time of laps 2..3, battery at the start of the stretch.
'use strict';
const { F1, STEP, KMH, track, lineWant, keysSteer } = require('../driving/load');

function drive(tr, line, spec, rule, laps, rec) {
  const car = F1.createCar(spec, { tyres: false }), st = car.state, N = tr.samples.length;
  car.reset(tr, N - 10); car.setBattery(1);
  const lc = F1.createLapCounter(N, st.sampleIndex), inp = { up: false, down: false, left: false, right: false, boost: false };
  const out = []; let cur = null, t = 0;
  while (out.length < laps && t < 900) {
    const w = lineWant(tr, line, st), v = st.speed;
    inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, st, w.steer);
    inp.boost = !!(rule && rule(inp, st));
    if (rec && out.length === 1) rec[st.sampleIndex] = inp.up && !inp.down ? 1 : 0;
    car.update(STEP, inp, tr); t += STEP;
    if (cur) {
      if (st.speed * KMH > cur.vmax) { cur.vmax = st.speed * KMH; cur.at = st.sampleIndex; }
      if (cur.zone && cur.zone(st.sampleIndex) && cur.bat0 === null) cur.bat0 = st.battery;
    }
    const r = lc.update(st.sampleIndex, st.speed, STEP);
    if (r === 2) { cur.time = lc.last; out.push(cur); }
    if (r === 1 || r === 2) cur = { vmax: 0, at: -1, zone: rule && rule.zone, bat0: null };
  }
  return out;
}

const rows = [];
for (const id of ['it-1922', 'us-2023', 'az-2016', 'sa-2021', 'mx-1962', 'bh-2002']) {
  const { track: tr, line } = track(id), N = tr.samples.length, ds = tr.length / N;
  for (const y of [2025, 2026]) {
    const spec = F1.cars.resolve(y + '-standard', y);
    const rec = new Uint8Array(N);
    const a = drive(tr, line, spec, null, 3, rec);
    // the longest throttle run (cyclic)
    let best = 0, bs = 0, run = 0, rs = 0;
    for (let k = 0; k < 2 * N; k++) { const i = k % N; if (rec[i]) { if (!run) rs = i; run++; if (run > best && run <= N) { best = run; bs = rs; } } else run = 0; }
    const zone = i => ((i - bs) % N + N) % N < best;
    const save = (inp, st) => inp.up && !inp.down && zone(st.sampleIndex); save.zone = zone;
    const all = (inp, st) => inp.up && !inp.down && st.speed > 100 / KMH;
    const b = drive(tr, line, spec, all, 3), c = drive(tr, line, spec, save, 3);
    // peak speed inside the zone without boost
    const avg = L => (L[1].time + L[2].time) / 2;
    rows.push({ track: id, year: y, straightM: Math.round(best * ds), vmaxNo: a[2].vmax.toFixed(0), vmaxHoldAll: b[2].vmax.toFixed(0), vmaxSaved: c[2].vmax.toFixed(0), batAtZone: c[2].bat0 === null ? '' : (c[2].bat0 * 100).toFixed(0) + '%',
      lapNo: avg(a).toFixed(2), lapHoldAll: avg(b).toFixed(2), lapSaved: avg(c).toFixed(2), topBoost: (F1.carPerf(spec).topSpeedBoost * KMH).toFixed(0) });
  }
}
console.table(rows);
