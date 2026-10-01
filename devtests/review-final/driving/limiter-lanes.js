// The pit limiter through every pit lane: the car placed on the lane centre at the entry line at the limit, limiter on,
// throttle flat out, pure pursuit of laneD to the exit line. Max speed between the lines vs the limit (+3 km/h = speeding
// penalty in js/pit.js). Also the height drop of the lane (downhill lanes: the limiter does not brake).
'use strict';
const { F1, STEP, KMH, track, keysSteer } = require('./load');
const rows = [];
for (const td of global.F1_TRACKS) {
  const { track: tr } = track(td.id), pit = tr.pit;
  if (!pit) { rows.push({ id: td.id, note: 'no pit' }); continue; }
  const S = tr.samples, N = S.length, lim = pit.limitKmh;
  const car = F1.createCar(null, { tyres: false }), st = car.state;
  const pitObj = F1.createPit({ random: () => 0.5 });
  const i0 = pit.entry, s0 = S[i0], d0 = pit.laneD(i0);
  car.reset(tr, i0); st.x = s0.x + s0.nx * d0; st.z = s0.z + s0.nz * d0; st.heading = Math.atan2(s0.tx, s0.tz);
  car.update(1e-4, null, tr); st.speed = lim / KMH;
  const inp = { up: true, limiter: true, left: false, right: false };
  let max = 0, maxAt = -1, k = 0, steps = 0, hits = 0, speeding = null, yEntry = S[i0].y, yExit = S[pit.exit].y, minY = Infinity, maxY = -Infinity;
  while (steps++ < 120 * 90) {
    // pursuit of the lane centre
    const ds = tr.length / N, v = Math.max(0, st.speed), L = Math.min(25, Math.max(7, 5 + 0.3 * v));
    const j = (st.sampleIndex + Math.round(L / ds)) % N, dj = pit.laneD(j), sj = S[j];
    if (!(dj === dj)) break;
    const dx = sj.x + sj.nx * dj - st.x, dz = sj.z + sj.nz * dj - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
    keysSteer(inp, st, Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock)));
    car.update(STEP, inp, tr);
    const ev = pitObj.update(STEP, st, tr, { slot: 0 });
    if (ev === 'speeding' && speeding === null) speeding = st.speed * KMH;
    if (st.hit > 0) hits++;
    k = ((st.sampleIndex - pit.entry) % N + N) % N;
    if (st.y < minY) minY = st.y; if (st.y > maxY) maxY = st.y;
    if (st.inPit && st.speed * KMH > max) { max = st.speed * KMH; maxAt = k; }
    if (k > ((pit.exit - pit.entry) % N + N) % N && k < N / 2) break;
  }
  rows.push({ id: td.id, limit: lim, maxKmh: +max.toFixed(2), over: +(max - lim).toFixed(2), speedingAt: speeding ? +speeding.toFixed(1) : '', drop: +(yEntry - yExit).toFixed(1), span: +(maxY - minY).toFixed(1), hits, flag: max > lim + 3 ? 'PENALTY' : (max > lim + 0.5 ? 'over' : '') });
}
console.table(rows);
