// How much does driving THROUGH the pit lane without the limiter cost, compared with the racing line over the same
// stretch (pit.from - 100 m .. pit.to + 100 m)? Pure pursuit of the lane centre with a speed target from the lane
// path's curvature (lateral 9 m/s^2) and braking (7 m/s^2 look-ahead), no limiter; vs the line driver on the racing line.
'use strict';
const { F1, STEP, KMH, track, keysSteer, lineWant } = require('./load');
const rows = [];
for (const id of ['it-1922', 'be-1925', 'mc-1929', 'sa-2021', 'us-2023', 'gb-1948']) {
  const { track: tr, line } = track(id), pit = tr.pit, S = tr.samples, N = S.length, ds = tr.length / N;
  const K = ((pit.to - pit.from) % N + N) % N, back = Math.round(100 / ds), ahead = Math.round(100 / ds);
  const i0 = (pit.from - back + N) % N, iEnd = (pit.to + ahead) % N;
  // lane path: centreline before from, laneD inside, centreline after to
  const px = [], pz = [];
  for (let k = 0; k <= K + back + ahead; k++) {
    const i = (i0 + k) % N, s = S[i], kk = k - back, d = kk >= 0 && kk <= K ? pit.laneD(i) : 0;
    px.push(s.x + s.nx * d); pz.push(s.z + s.nz * d);
  }
  // speed profile from curvature + braking
  const n = px.length, vmax = new Float64Array(n).fill(95);
  for (let k = 1; k < n - 1; k++) {
    const ax = px[k] - px[k - 1], az = pz[k] - pz[k - 1], bx = px[k + 1] - px[k], bz = pz[k + 1] - pz[k];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), cr = Math.abs(ax * bz - az * bx) / (la * lb * 0.5 * (la + lb));
    if (cr > 1e-6) vmax[k] = Math.min(95, Math.sqrt(9 / cr));
  }
  for (let k = n - 2; k >= 0; k--) { const seg = Math.hypot(px[k + 1] - px[k], pz[k + 1] - pz[k]); vmax[k] = Math.min(vmax[k], Math.sqrt(vmax[k + 1] * vmax[k + 1] + 2 * 7 * seg)); }
  const drive = (useLane) => {
    const car = F1.createCar(null, { tyres: false }), st = car.state;
    car.reset(tr, (i0 - Math.round(300 / ds) + N) % N); st.speed = 0;
    const inp = { up: true, down: false, left: false, right: false };
    let t = 0, t0 = null, hits = 0, grass = 0, maxInLane = 0, k0 = -1;
    for (let step = 0; step < 120 * 120; step++) {
      const kk = ((st.sampleIndex - i0) % N + N) % N;
      if (useLane) {
        const v = Math.max(0, st.speed), L = Math.min(30, Math.max(7, 5 + 0.3 * v));
        const j = Math.min(n - 1, Math.max(0, (kk < n ? kk : (kk > N - 200 ? kk - N : n - 1)) + Math.round(L / ds)));
        const dx = px[j] - st.x, dz = pz[j] - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
        const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
        keysSteer(inp, st, Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock)));
        const vt = kk < n ? vmax[Math.min(n - 1, kk + 3)] : 95;
        inp.up = v < vt; inp.down = v > vt + 1;
      } else {
        const w = lineWant(tr, line, st), v = st.speed; inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, st, w.steer);
      }
      car.update(STEP, inp, tr); t += STEP;
      const k2 = ((st.sampleIndex - i0) % N + N) % N;
      if (t0 === null && k2 < n && k2 >= 0 && k0 >= 0 && k0 > N / 2) t0 = t;     // crossed i0
      if (t0 !== null) { if (st.hit > 0) hits++; if (st.onGrass) grass++; if (st.inPit) maxInLane = Math.max(maxInLane, st.speed * KMH); if (k2 >= n - 1 && k2 < N / 2) return { t: t - t0, hits, grass, maxInLane: maxInLane.toFixed(0) }; }
      k0 = k2;
    }
    return { t: NaN, hits, grass };
  };
  const a = drive(false), b = drive(true);
  rows.push({ id, lineS: a.t.toFixed(2), laneFastS: b.t.toFixed(2), costS: (b.t - a.t).toFixed(2), laneHitsGrass: b.hits + '/' + b.grass, lineHitsGrass: a.hits + '/' + a.grass, maxKmhInLane: b.maxInLane, limit: pit.limitKmh });
}
console.table(rows);
