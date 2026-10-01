// Verify S1: E held only on Monza's main straight (last 900 m before the line .. 900 m after it), on full throttle.
import * as B from '../../../tools/build-cars.mjs';
const G = B.loadGame();
const { eras } = B.loadInputs();
const R = G.REF_SPEC;
const HZ = 120;
const calib = JSON.parse((await import('node:fs')).readFileSync(B.CALIB_FILE, 'utf8'));
const specOf = y => Object.assign({}, R, B.eraSpec(eras, y, calib.seasons[y].gripScale, calib.seasons[y].ersHarvest === null ? R.ers.harvest : calib.seasons[y].ersHarvest));
const td = globalThis.F1_TRACKS.find(t => t.id === 'it-1922'), track = G.buildTrack(td);
const S = track.samples, N = S.length, ds = track.length / N;
console.log('Monza length ' + track.length.toFixed(0) + ' m, N ' + N);
for (const y of [2014, 2020, 2025, 2026]) {
  const car = G.createCar(specOf(y), { tyres: false });
  const line = G.buildRaceLine(track, car.perf), P = line.points, st = car.state;
  car.reset(track, 0);
  const dt = 1 / HZ, input = { up: false, down: false, left: false, right: false, boost: false };
  let time = 0, prevIdx = 0, lap = 0, vmaxLap = [0, 0, 0, 0], batAt = [];
  while (lap < 4 && time < 900) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    const i = st.sampleIndex, onMain = i > N - 900 / ds || i < 900 / ds;
    input.boost = onMain && input.up && !input.down && v > 100 / 3.6;
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(i + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, track);
    time += dt;
    if (st.speed * 3.6 > vmaxLap[lap]) vmaxLap[lap] = st.speed * 3.6;
    if (prevIdx < N - 900 / ds && i >= N - 900 / ds) batAt.push(st.battery.toFixed(2));
    if (prevIdx > N * 0.75 && i < N * 0.25) lap++;
    prevIdx = i;
  }
  line.dispose();
  console.log(y + '  max km/h per lap ' + vmaxLap.map(v => v.toFixed(1)).join(' / ') + '   battery entering the main straight ' + batAt.join(' '));
}
