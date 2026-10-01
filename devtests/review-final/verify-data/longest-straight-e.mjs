// Verify S1 like a player: on each circuit find the longest full-throttle run of the no-E autopilot lap, then drive
// again latching full throttle + E over exactly that run (the autopilot's own advice brakes as soon as the car is
// 0.4 % above its no-battery top speed, so it cannot show the deploy top speed). Peak speed in the run, both ways.
import * as B from '../../../tools/build-cars.mjs';
const G = B.loadGame();
const { eras } = B.loadInputs();
const R = G.REF_SPEC;
const HZ = 120;
const calib = JSON.parse((await import('node:fs')).readFileSync(B.CALIB_FILE, 'utf8'));
const specOf = y => Object.assign({}, R, B.eraSpec(eras, y, calib.seasons[y].gripScale, calib.seasons[y].ersHarvest === null ? R.ers.harvest : calib.seasons[y].ersHarvest));
function run(track, spec, win) {
  const S = track.samples, N = S.length, ds = track.length / N;
  const car = G.createCar(spec, { tyres: false });
  const line = G.buildRaceLine(track, car.perf), P = line.points, st = car.state;
  car.reset(track, 0);
  const dt = 1 / HZ, input = { up: false, down: false, left: false, right: false, boost: false };
  let time = 0, prevIdx = 0, lap = 0, peak = 0, latched = false;
  const thr = new Uint8Array(N);
  while (lap < (win ? 3 : 2) && time < 600) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2], i = st.sampleIndex;
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5; input.boost = false;
    if (win && lap >= 1) {
      const inWin = win.a <= win.b ? (i >= win.a && i < win.b) : (i >= win.a || i < win.b);
      if (inWin && input.up) latched = true;
      if (!inWin) latched = false;
      if (latched) { input.up = true; input.down = false; input.boost = true; if (st.speed * 3.6 > peak) peak = st.speed * 3.6; }
    }
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(i + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, track);
    time += dt;
    if (!win && lap === 1) { if (st.throttle >= 0.999 && st.brake === 0) thr[i] = 1; if (st.speed * 3.6 > peak) peak = st.speed * 3.6; }
    if (prevIdx > N * 0.75 && i < N * 0.25) lap++;
    prevIdx = i;
  }
  line.dispose();
  return { peak, thr, N, ds };
}
for (const id of ['it-1922', 'az-2016', 'us-2023', 'mx-1962', 'cn-2004']) {
  const td = globalThis.F1_TRACKS.find(t => t.id === id), track = G.buildTrack(td);
  const out = [];
  for (const y of [2014, 2025, 2026]) {
    const s = specOf(y);
    const base = run(track, s, null), N = base.N, thr = base.thr;
    // longest circular run of full throttle
    let best = { len: 0, a: 0 }, start = -1;
    for (let k = 0; k < 2 * N; k++) {
      const on = thr[k % N];
      if (on && start < 0) start = k;
      if ((!on || k === 2 * N - 1) && start >= 0) { const len = k - start; if (len > best.len && len < N) best = { len, a: start % N }; start = -1; }
    }
    const win = { a: best.a, b: (best.a + best.len) % N };
    const e = run(track, s, win);
    out.push(y + ': run ' + (best.len * base.ds).toFixed(0) + ' m, peak noE ' + base.peak.toFixed(1) + ', E (latched full throttle) ' + e.peak.toFixed(1));
  }
  console.log(td.name + '\n   ' + out.join('\n   '));
  track.dispose();
}
