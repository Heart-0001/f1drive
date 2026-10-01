// Verify S1: lap with E held only above a speed threshold (a player saving the battery for straights).
// Reports the flying lap and the max speed on laps 2-3, for 2025 / 2026 standard cars, Monza and Hungaroring.
import * as B from '../../../tools/build-cars.mjs';
const G = B.loadGame();
const { eras } = B.loadInputs();
const R = G.REF_SPEC;
const HZ = 120, LAPS = 3;
function drive(track, spec, eMinKmh) {
  const car = G.createCar(spec, { tyres: false });
  const line = G.buildRaceLine(track, car.perf);
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  car.reset(track, 0);
  const dt = 1 / HZ, input = { up: false, down: false, left: false, right: false, boost: false };
  let time = 0, lapStart = 0, prevIdx = 0, vmax = 0;
  const laps = [];
  while (laps.length < LAPS && time < 900) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    input.boost = eMinKmh !== null && input.up && !input.down && v > eMinKmh / 3.6;
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, track);
    time += dt;
    if (laps.length >= 1 && st.speed > vmax) vmax = st.speed;
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prevIdx = st.sampleIndex;
  }
  line.dispose();
  return { flying: Math.min(...laps.slice(1)), vmax: vmax * 3.6 };
}
const calib = JSON.parse((await import('node:fs')).readFileSync(B.CALIB_FILE, 'utf8'));
const specOf = y => Object.assign({}, R, B.eraSpec(eras, y, calib.seasons[y].gripScale, calib.seasons[y].ersHarvest === null ? R.ers.harvest : calib.seasons[y].ersHarvest));
for (const id of ['it-1922', 'hu-1986']) {
  const td = globalThis.F1_TRACKS.find(t => t.id === id), track = G.buildTrack(td);
  console.log('== ' + td.name);
  for (const y of [2013, 2014, 2025, 2026]) {
    const s = specOf(y);
    const parts = [];
    for (const th of [null, 100, 200, 250]) { const r = drive(track, s, th); parts.push((th === null ? 'noE' : 'E>' + th) + ' ' + r.flying.toFixed(2) + 's/' + r.vmax.toFixed(0)); }
    console.log(y + '  ' + parts.join('   '));
  }
  track.dispose();
}
