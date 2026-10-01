// The node autopilot of the seasons calibration: the racing-line driver of devtests/raceline-test/test.js and
// devtests/cars-data/drive-check.js (pure pursuit on the line, throttle / brake keys from the line's own advice,
// levels[2]), driving the REAL js/car.js on the racing line built for that car (F1.buildRaceLine(track, car.perf)).
// Fixed 1/120 s step (main.js's STEP), no randomness, no tyre model (grip 1 = a new medium set), no limiter, the
// battery only with opts.deploy (without it: the golden-rule conditions). A run is 3 laps from a standing start on the
// centreline at sample 0; the flying lap is the better of laps 2 and 3, timed at the moment of crossing inside the step
// (distance past the line / speed).
import * as B from '../../tools/build-cars.mjs';

const HZ = 120, LAPS = 3;
const DEPLOY_MIN = 100 / 3.6;          // opts.deploy: E held on full throttle above this speed (m/s)

export function buildTracks(ids) {
  const G = B.loadGame();
  return ids.map(id => {
    const td = globalThis.F1_TRACKS.find(t => t.id === id);
    if (!td) throw new Error('unknown track ' + id);
    return { id, name: td.name, track: G.buildTrack(td) };
  });
}

// opts.harvestProbe: keep the battery empty (setBattery(0) before every step, so it never fills up) and record, on
// lap 2, the ERS power stored at every braking step and the lift-off time: the energy a lap could recover is then
// sum(min(H, brakeP) dt) + 0.12 H liftT for any harvest cap H (js/car.js's rule), and `energy` is the one at this spec's H.
// opts.deploy: hold the battery button (input.boost) whenever the autopilot is on full throttle above 100 km/h, as a
// real pole lap uses it; the battery is full at the standing start and refilled only by harvesting, so the flying lap
// (2 or 3) is what the car can deploy lap after lap.
export function driveLap(t, spec, opts) {
  opts = opts || {};
  const G = B.loadGame();
  const track = t.track;
  const car = G.createCar(spec, { tyres: false });
  const line = G.buildRaceLine(track, car.perf);
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  car.reset(track, 0);
  const dt = 1 / HZ, input = { up: false, down: false, left: false, right: false, boost: false };
  const ers = car.spec.ers;
  const probe = opts.harvestProbe && ers ? { brakeP: [], liftT: 0, dt, energy: 0, clipped: 0 } : null;
  let time = 0, lapStart = 0, prevIdx = 0, grass = 0, hits = 0, vmax = 0;
  const laps = [];
  while (laps.length < LAPS && time < 900) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    input.boost = !!opts.deploy && input.up && !input.down && v > DEPLOY_MIN;
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = typeof car.perf.steerLockAt === 'function' ? car.perf.steerLockAt(v, S[st.sampleIndex].bank || 0, kap >= 0 ? 1 : -1) :
      0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    if (probe) car.setBattery(0);
    car.update(dt, input, track);
    time += dt;
    if (laps.length >= 1) { if (st.onGrass) grass++; if (st.hit > 0) hits++; if (st.speed > vmax) vmax = st.speed; }
    if (probe && laps.length === 1) {
      const e = st.harvest * ers.harvest;                         // W/kg stored, mean over the step
      probe.energy += e * dt;
      if (st.brake > 0 && st.speed > 0.5) { probe.brakeP.push(e); if (st.harvest >= 0.999) probe.clipped++; }
      else if (st.throttle === 0 && st.speed > 20) probe.liftT += dt;
    }
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prevIdx = st.sampleIndex;
  }
  const pred = line.lapTime;
  line.dispose();
  return { laps, flying: laps.length >= 2 ? Math.min.apply(null, laps.slice(1)) : NaN, pred, grass, hits, vmaxKmh: vmax * 3.6, probe };
}
