// node devtests/handling-test/stability.js [variant[:hookJSON] ...]   (default: today proposed)
// Is the steering still tame where the keyboard needs it? Per variant, on the real car physics (120 Hz like main.js):
//  A. step response on a long straight (Monza's main straight; Jeddah's back straight) at 300 / 250 / 200 / 120 / 80 /
//     50 km/h held: the car starts 2.5 m off the centreline with a 2 deg heading error and a pursuit driver (keys =
//     bang-bang LEFT / RIGHT with the 0.03 dead band of the project's harness drivers, or analog) brings it back:
//     overshoot (m), lateral offset RMS over 2..6 s (m, the steady weave), key reversals per second, max |yaw rate|.
//  B. a key tap (LEFT for 0.10 / 0.25 s, then nothing) at 300 / 200 / 120 / 80 / 60 / 40 km/h on the flat: the heading
//     change and lateral displacement 1 s later, the peak lateral g and whether it ran past the grip (slip > 0).
//  C. the same tap and step tests in the middle of the banked corners (Zandvoort T3 at its speed, T14, Madring T12):
//     the pursuit of the racing line through the corner, keys, 3 laps: max |d - line d| and reversals per second.
const L = require('./lib.js'), { drive } = require('./driver.js');
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['today', 'proposed'];
const D = 180 / Math.PI, HZ = 120, dt = 1 / HZ;
function straight(tr) {
  const S = tr.samples, N = S.length, ds = tr.length / N;
  let best = { a: 0, n: 0 }, a = -1;
  for (let i = 0; i < 2 * N; i++) {
    const s = S[i % N], p = S[(i + N - 2) % N], q = S[(i + 2) % N];
    const kc = ((q.tx - p.tx) * s.nx + (q.tz - p.tz) * s.nz) / (4 * ds);
    const ok = Math.abs(kc) < 1 / 3000 && Math.abs(s.bank) < 0.01;
    if (ok) { if (a < 0) a = i; if (i - a > best.n) best = { a: a % N, n: i - a }; } else a = -1;
  }
  return best;
}
function pursuitWant(K, st, tx, tz, v, bank) {
  const dx = tx - st.x, dz = tz - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
  const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz), sg = kap >= 0 ? 1 : -1;
  const lock = typeof K.steerLockAt === 'function' ? K.steerLockAt(v, bank, sg) : 0.35 / (1 + (v / 22) ** 2);
  return Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
}
for (const a of names) {
  const [name, hj] = a.split(/:(.*)/s);
  const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
  console.log(`\n=== ${a}`);
  // ---- A. step response on straights
  for (const id of ['it-1922', 'sa-2021']) {
    const tr = L.track(F1, id), S = tr.samples, N = S.length, ds = tr.length / N, st0 = straight(tr);
    const rows = [];
    for (const kmh of [300, 250, 200, 120, 80, 50]) {
      for (const mode of ['keys', 'analog']) {
        const car = F1.createCar(null, { tyres: false }), st = car.state, K = car.perf;
        const i0 = (st0.a + 10) % N;
        car.reset(tr, i0);
        const s = S[i0]; st.x += s.nx * 2.5; st.z += s.nz * 2.5; st.heading += 2 / D; car.update(1e-4, null, tr);
        st.speed = kmh / 3.6;
        let over = 0, rms = 0, nr = 0, flips = 0, last = 0, yawMax = 0, side0 = Math.sign(st.d), crossed = false;
        const inp = { up: false, down: false, left: false, right: false, steerAxis: null };
        for (let k = 0; k < 6 * HZ; k++) {
          const v = st.speed, Ld = Math.min(35, Math.max(7, 5 + 0.3 * v)), j = (st.sampleIndex + Math.round(Ld / ds)) % N;
          const want = pursuitWant(K, st, S[j].x, S[j].z, v, 0);
          if (mode === 'analog') inp.steerAxis = want;
          else { inp.left = want > st.steer + 0.03; inp.right = want < st.steer - 0.03; const dir = inp.left ? 1 : inp.right ? -1 : 0; if (dir && last && dir !== last) flips++; if (dir) last = dir; }
          inp.up = st.speed < kmh / 3.6 - 0.05; inp.down = st.speed > kmh / 3.6 + 0.4;
          const h0 = st.heading;
          car.update(dt, inp, tr);
          let dh = st.heading - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          yawMax = Math.max(yawMax, Math.abs(dh / dt));
          if (Math.sign(st.d) !== side0) crossed = true;
          if (crossed) over = Math.max(over, Math.abs(st.d));
          if (k >= 2 * HZ) { rms += st.d * st.d; nr++; }
        }
        rows.push(`${String(kmh).padStart(3)} ${mode.padEnd(6)} overshoot ${over.toFixed(2)} m, weave RMS ${Math.sqrt(rms / nr).toFixed(3)} m, reversals ${(flips / 6).toFixed(1)}/s, max yaw ${(yawMax * D).toFixed(1)} deg/s`);
      }
    }
    console.log(`  A. ${id} straight from sample ${st0.a} (${(st0.n * ds).toFixed(0)} m): 2.5 m off, 2 deg heading error\n     ` + rows.join('\n     '));
  }
  // ---- B. key taps on the flat (straight of Monza)
  {
    const tr = L.track(F1, 'it-1922'), S = tr.samples, st0 = straight(tr);
    const rows = [];
    for (const kmh of [300, 200, 120, 80, 60, 40]) {
      const cells = [];
      for (const tap of [0.10, 0.25]) {
        const car = F1.createCar(null, { tyres: false }), st = car.state;
        car.reset(tr, (st0.a + 10) % S.length); st.speed = kmh / 3.6; car.update(1e-4, null, tr);
        const h0 = st.heading, d0 = st.d;
        let gMax = 0, slip = 0;
        for (let k = 0; k < HZ; k++) {
          const hb = st.heading;
          car.update(dt, { left: k < tap * HZ, up: st.speed < kmh / 3.6 - 0.05, down: st.speed > kmh / 3.6 + 0.4 }, tr);
          let dh = st.heading - hb; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          gMax = Math.max(gMax, Math.abs(st.speed * dh / dt) / 9.81); slip = Math.max(slip, st.slip);
        }
        let dh = st.heading - h0; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        cells.push(`tap ${tap.toFixed(2)} s: heading ${(dh * D).toFixed(2)} deg, moved ${(st.d - d0).toFixed(2)} m, peak ${gMax.toFixed(2)} g${slip > 0 ? ', past the grip (slip ' + slip.toFixed(2) + ')' : ''}`);
      }
      rows.push(`${String(kmh).padStart(3)} km/h  ` + cells.join(' | '));
    }
    console.log('  B. key taps (LEFT, flat straight, 1 s later)\n     ' + rows.join('\n     '));
  }
  // ---- C. racing-line tracking through the banked corners, keys and analog
  {
    const rows = [];
    for (const [id, A, B, nm] of [['nl-1948', 417, 505, 'Zandvoort T3'], ['nl-1948', 1846, 1998, 'Zandvoort T14'], ['es-2026', 1122, 1391, 'Madring T12'], ['sa-2021', 1138, 1293, 'Jeddah T13']]) {
      const tr = L.track(F1, id);
      for (const mode of ['keys', 'analog']) {
        const r = drive(F1, tr, { mode, trace: [A, B], laps: 3 });
        const fly = r.trace.filter(q => q.lap >= 1);
        let dev = 0, rev = 0, last = 0, steerRms = 0, prevSteer = null, dSteer = 0;
        for (const q of fly) { dev = Math.max(dev, Math.abs(q.d - q.lineD)); if (prevSteer !== null) dSteer += Math.abs(q.steer - prevSteer); prevSteer = q.steer; }
        const tSec = fly.length / HZ;
        rows.push(`${nm.padEnd(13)} ${mode.padEnd(6)} max |d - line| ${dev.toFixed(2)} m, steer travel ${(dSteer / tSec).toFixed(2)} /s over ${tSec.toFixed(1)} s`);
      }
    }
    console.log('  C. the autopilot through the banked corners (laps 2-3)\n     ' + rows.join('\n     '));
  }
}
