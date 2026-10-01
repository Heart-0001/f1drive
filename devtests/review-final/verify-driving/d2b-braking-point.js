// D2 verification, cleaner: the line driver drives laps; on the longest full-throttle stretch the throttle is held flat
// (no lifting for the line's speed profile) and the battery is set to full at the start of the stretch (a driver who
// saved it). Speed at the point where the no-boost driver ends the stretch (its braking point), with and without E.
'use strict';
const { F1, STEP, KMH, track, lineWant, keysSteer } = require('../driving/load');

function drive(tr, line, spec, zone, boost, rec) {
  const car = F1.createCar(spec, { tyres: false }), st = car.state, N = tr.samples.length;
  car.reset(tr, N - 10); car.setBattery(1);
  const lc = F1.createLapCounter(N, st.sampleIndex), inp = { up: false, down: false, left: false, right: false, boost: false };
  let laps = 0, t = 0, inZ = false, endV = null, entryV = null, peak = 0, deployedS = 0;
  while (laps < 3 && t < 900) {
    const w = lineWant(tr, line, st), v = st.speed;
    inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, st, w.steer);
    const z = zone && laps === 2 && zone.has(st.sampleIndex);
    if (z) {
      if (!inZ) { inZ = true; car.setBattery(1); entryV = st.speed * KMH; }
      inp.up = true; inp.down = false; inp.boost = boost;
      if (st.speed * KMH > peak) peak = st.speed * KMH;
    } else {
      if (inZ && endV === null) endV = st.speed * KMH;
      inp.boost = false;
    }
    if (rec && laps === 1) rec[st.sampleIndex] = inp.up && !inp.down ? 1 : 0;
    car.update(STEP, inp, tr); t += STEP;
    if (z && st.deploy > 0) deployedS += STEP;
    const r = lc.update(st.sampleIndex, st.speed, STEP);
    if (r === 2) laps++;
    if (endV !== null && laps === 2) break;
  }
  return { endV, entryV, peak, deployedS };
}

const rows = [];
for (const id of ['it-1922', 'us-2023', 'az-2016', 'sa-2021', 'mx-1962', 'bh-2002', 'be-1925']) {
  const { track: tr, line } = track(id), N = tr.samples.length, ds = tr.length / N;
  for (const y of [2025, 2026]) {
    const spec = F1.cars.resolve(y + '-standard', y);
    const rec = new Uint8Array(N);
    drive(tr, line, spec, null, false, rec);
    let best = 0, bs = 0, run = 0, rs = 0;
    for (let k = 0; k < 2 * N; k++) { const i = k % N; if (rec[i]) { if (!run) rs = i; run++; if (run > best && run <= N) { best = run; bs = rs; } } else run = 0; }
    const zone = { has: i => ((i - bs) % N + N) % N < best };
    const a = drive(tr, line, spec, zone, false), b = drive(tr, line, spec, zone, true);
    rows.push({ track: id, year: y, straightM: Math.round(best * ds), entryKmh: a.entryV && a.entryV.toFixed(0), endNo: a.endV && a.endV.toFixed(0), endBoost: b.endV && b.endV.toFixed(0),
      gainKmh: a.endV && b.endV ? (b.endV - a.endV).toFixed(0) : '', deployS: b.deployedS.toFixed(1), topNo: (F1.carPerf(spec).topSpeed * KMH).toFixed(0), topBoost: (F1.carPerf(spec).topSpeedBoost * KMH).toFixed(0) });
  }
}
console.table(rows);
