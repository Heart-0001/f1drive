// The handling-test autopilots (pure logic over a loaded variant F1):
//   keys   the keyboard racing-line driver of devtests/seasons-calib/driver.mjs / raceline-test/test.js: pure pursuit of
//          the line, LEFT / RIGHT keys when the wanted steer differs from state.steer by 0.03 (bang-bang), throttle /
//          brake keys from the line's colour (levels[2]); 120 Hz like main.js's STEP.
//   analog the same pursuit as a stick (input.steerAxis = wanted steer), pedals as keys.
// The wanted steer = atan(curvature x wheelbase) / lock, lock = car.perf.steerLockAt(v, bank, sign) when the car has it
// (opts.oldLock: the v5 formula 0.35 / (1 + (v/22)^2) even then: what the project's harnesses do until they are updated).
// drive(F1, track, opts) -> {laps, flying, pred, grass, hits, vmax, trace?}
//   opts: {laps 3, hz 120, mode 'keys' | 'analog', spec, line (prebuilt), oldLock, trace: [from, to] sample range to record
//          (every step: lap, i, d, v, steer, delta, latG, yaw), startIdx 0, maxTime 900}
function drive(F1, track, opts) {
  opts = opts || {};
  const car = F1.createCar(opts.spec || null, { tyres: false });
  const line = opts.line || F1.buildRaceLine(track, car.perf);
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state, K = car.perf;
  const LAPS = opts.laps || 3, HZ = opts.hz || 120, dt = 1 / HZ, mode = opts.mode || 'keys';
  car.reset(track, opts.startIdx || 0);
  const input = { up: false, down: false, left: false, right: false, steerAxis: null };
  let time = 0, lapStart = 0, prevIdx = st.sampleIndex, grass = 0, hits = 0, vmax = 0, lapsDone = 0, steerFlips = 0, lastDir = 0;
  const laps = [], trace = [];
  const lockOf = (v, i, sg) => (!opts.oldLock && typeof K.steerLockAt === 'function') ? K.steerLockAt(v, S[i].bank || 0, sg) : 0.35 / (1 + (v / 22) * (v / 22));
  while (laps.length < LAPS && time < (opts.maxTime || 900)) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = lockOf(v, st.sampleIndex, kap >= 0 ? 1 : -1);
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    if (mode === 'analog') { input.steerAxis = want; input.left = input.right = false; }
    else {
      input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
      const dir = input.left ? 1 : (input.right ? -1 : 0);
      if (dir && lastDir && dir !== lastDir) steerFlips++;
      if (dir) lastDir = dir;
    }
    const h0 = st.heading;
    car.update(dt, input, track);
    time += dt;
    if (laps.length >= 1) { if (st.onGrass) grass++; if (st.hit > 0) hits++; if (st.speed > vmax) vmax = st.speed; }
    if (opts.trace) {
      const i = st.sampleIndex, [a, b] = opts.trace;
      if (((i - a + N) % N) <= ((b - a + N) % N)) {
        let dh = st.heading - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const lk = typeof K.steerLockAt === 'function' ? K.steerLockAt(st.speed, Math.atan(Math.tan(st.roll)), st.steer || 1) : 0.35 / (1 + (st.speed / 22) ** 2);
        trace.push({ lap: laps.length, t: time, i, d: st.d, v: st.speed, steer: st.steer, lock: lk, latG: st.speed * dh / dt / 9.81, slip: st.slip, roll: st.roll, lineD: P[i].d, lineV: P[i].speed });
      }
    }
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prevIdx = st.sampleIndex;
  }
  const res = { laps, flying: laps.length >= 2 ? Math.min.apply(null, laps.slice(1)) : NaN, pred: line.lapTime, grass, hits,
    vmax: vmax * 3.6, steerFlips, trace, line, car };
  return res;
}
module.exports = { drive };
