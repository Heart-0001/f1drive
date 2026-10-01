// D1 verification: from a completed service in box `slot`, (A) the legit way: drive the lane at the limiter to the
// exit, limiter off after the 'exit' event, then the racing-line driver; (B) the exploit: press R in the box (main.js
// resetCar = car.reset(track, sampleIndex), limiter switched off by the player), then the racing-line driver from 0.
// Both run until the same sample far downstream (exit + 1500 m). Time difference = what R gains.
'use strict';
const { F1, STEP, KMH, track, keysSteer, lineWant } = require('../driving/load');

function run(id, slot, exploit, speeder) {
  const { track: tr, line } = track(id), pit = tr.pit, S = tr.samples, N = S.length, ds = tr.length / N;
  const car = F1.createCar(null, { tyres: false }), st = car.state;
  const pitObj = F1.createPit({ random: () => 0.5 });
  const b = pit.boxes[slot];
  // put the car in its box, at rest, as main.js placeOnGrid does
  car.reset(tr, b.index); st.heading = b.heading; st.x = b.x; st.z = b.z; car.update(1e-4, null, tr); st.speed = 0;
  // a pit visit in progress: let pit.js see the car moving in the lane first (so the service starts)
  const opt = { slot };
  pitObj.update(STEP, Object.assign({}, st, { speed: 5 }), tr, opt);
  let ev, g = 0;
  while (g++ < 10) { ev = pitObj.update(STEP, st, tr, opt); if (ev === 'serviceStart') break; }
  if (ev !== 'serviceStart') return { note: 'no service ' + ev };
  while (pitObj.state.service) pitObj.update(STEP, st, tr, opt);   // held: the service runs out
  const y0 = st.y, idx0 = st.sampleIndex;
  let limiter = !speeder; let pend0 = pitObj.state.pending;
  if (exploit) { car.reset(tr, st.sampleIndex); limiter = false; }
  const jump = { dy: +(st.y - y0).toFixed(2), dIdx: st.sampleIndex - idx0 };
  const target = (pit.exit + Math.round(1500 / ds)) % N;
  const exitK = ((pit.exit - b.index) % N + N) % N;
  const inp = { up: true, down: false, left: false, right: false, limiter };
  let t = 0, exited = false, tExitLine = null, vExitLine = null, hits = 0, solidAt = null, speedAtSolid = null;
  for (let step = 0; step < 120 * 120; step++) {
    const k = ((st.sampleIndex - b.index) % N + N) % N;
    const dl = pit.laneD((st.sampleIndex + 1) % N);
    if (!exploit && !exited && dl === dl) {
      const v = Math.max(0, st.speed), L = Math.min(25, Math.max(7, 5 + 0.3 * v));
      const j = (st.sampleIndex + Math.round(L / ds)) % N, dj = pit.laneD(j), sj = S[j];
      const dd = dj === dj ? dj : 0;
      const dx = sj.x + sj.nx * dd - st.x, dz = sj.z + sj.nz * dd - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
      const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
      keysSteer(inp, st, Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock)));
      inp.up = true; inp.down = false;
    } else {
      const w = lineWant(tr, line, st), v = st.speed;
      inp.up = w.level < 0.45 || v < 5; inp.down = w.level >= 0.6 && v >= 5; keysSteer(inp, st, w.steer);
    }
    car.update(STEP, inp, tr); t += STEP;
    if (st.hit > 0.05) hits++;
    const e = pitObj.update(STEP, st, tr, opt);
    if (e === 'exit') { exited = true; inp.limiter = false; }
    if (tExitLine === null && k >= exitK && k < N / 2) { tExitLine = t; vExitLine = st.speed * KMH; }
    if (solidAt === null && !pit.paved(st.sampleIndex, st.d)) { solidAt = t; speedAtSolid = st.speed * KMH; }
    const kt = ((st.sampleIndex - target) % N + N) % N;
    if (kt < 5 && step > 100) return { pending: pitObj.state.pending - pend0, t, vEnd: st.speed * KMH, tExitLine, vExitLine, hits, jump, solidAt, speedAtSolid, laneLeftM: Math.round(exitK * ds) };
  }
  return { note: 'timeout' };
}

const rows = [];
for (const id of ['it-1922', 'mc-1929', 'gb-1948', 'be-1925']) {
  for (const slot of [0, 15]) {
    const a = run(id, slot, false), b = run(id, slot, true);
    rows.push({ id, box: slot + 1, laneAheadM: a.laneLeftM, legitS: a.t && a.t.toFixed(2), exploitS: b.t && b.t.toFixed(2), gainS: a.t && b.t ? (a.t - b.t).toFixed(2) : a.note || b.note,
      vExitLegit: a.vExitLine && a.vExitLine.toFixed(0), vExitR: b.vExitLine && b.vExitLine.toFixed(0), tToExitLegit: a.tExitLine && a.tExitLine.toFixed(1), tToExitR: b.tExitLine && b.tExitLine.toFixed(1),
      vEndL: a.vEnd && a.vEnd.toFixed(0), vEndR: b.vEnd && b.vEnd.toFixed(0), hitsL: a.hits, hitsR: b.hits, jumpDy: b.jump && b.jump.dy, solidR_s: b.solidAt, vSolidR: b.speedAtSolid && b.speedAtSolid.toFixed(0) });
  }
}
// (D1 table skipped here)
// D4: after the service, leave the box flat out (no limiter): the 5 s speeding hold goes to state.pending and is only
// served at a NEXT stop; in a one-stop race it is never served
const rows4 = [];
for (const id of ['it-1922', 'mc-1929', 'gb-1948', 'be-1925']) {
  for (const slot of [0, 15]) {
    const a = run(id, slot, false, false), c = run(id, slot, false, true);
    rows4.push({ id, box: slot + 1, legitS: a.t && a.t.toFixed(2), speederS: c.t && c.t.toFixed(2), gainS: a.t && c.t ? (a.t - c.t).toFixed(2) : (a.note || c.note), vExitSpeeder: c.vExitLine && c.vExitLine.toFixed(0), hitsSpeeder: c.hits, pendingAfter: c.pending });
  }
}
console.table(rows4);
