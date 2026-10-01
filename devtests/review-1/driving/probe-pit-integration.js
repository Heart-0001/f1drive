// Probe: pit.js + laps.js on the REAL tracks with the REAL car, the lane driven as devtests/car-v6/pit-drive.js does,
// the car frozen during the service as main.js is meant to do. Events, service, lap counter jumps, stops in the
// wrong box, and the "enter" event across the start / finish line.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/pit.js'));
require(path.join(ROOT, 'js/laps.js'));
const F1 = global.F1, PERF = F1.CAR_PERF, STEP = 1 / 120, HZ_EVERY = 2;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const rows = [];
for (const td of global.F1_TRACKS) {
  if (filter && !filter.test(td.id) && !filter.test(td.name)) continue;
  const track = F1.buildTrack(td), pit = track.pit, S = track.samples, N = S.length, ds = track.length / N;
  const wq = q => ((q % N) + N) % N, kOf = i => wq(i - pit.from);
  const K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit), vLim = pit.limitKmh / 3.6;
  for (const slot of [0, 9, 15]) {
    const car = F1.createCar(), st = car.state; car.tyres.setWearRate(0);
    const pitL = F1.createPit({ random: () => 0.5 });
    const lap = F1.createLapCounter(N, 0);
    const run = Math.round(250 / ds), out = Math.round(150 / ds), back = Math.round(100 / ds);
    const start = wq(pit.from - run);
    car.reset(track, start); lap.reset(st.sampleIndex);
    const L = run + K + out + 40, tgt = new Float64Array(L + 1), vmax = new Float64Array(L + 1).fill(40), iOf = u => wq(start + u);
    const b = pit.boxes[slot], ub = run + kOf(b.index);
    for (let u = 0; u <= L; u++) {
      if (u < run) { const f = clamp(u / (run - 10), 0, 1); tgt[u] = pit.laneD(pit.from) * f * f * (3 - 2 * f); }
      else if (u <= run + K) tgt[u] = pit.laneD(iOf(u));
      else { const f = clamp((u - run - K) / back, 0, 1); tgt[u] = pit.laneD(pit.to) * (1 - f * f * (3 - 2 * f)); }
    }
    { const a0 = ub - Math.round(28 / ds), a1 = ub - Math.round(6 / ds), b0 = ub + Math.round(4 / ds), b1 = ub + Math.round(28 / ds);
      for (let u = a0; u <= b1; u++) { let f = u < a1 ? (u - a0) / (a1 - a0) : (u <= b0 ? 1 : 1 - (u - b0) / (b1 - b0)); f = clamp(f, 0, 1); f = f * f * (3 - 2 * f); tgt[u] = tgt[u] + (b.d - tgt[u]) * f; } }
    const P = [];
    for (let u = 0; u <= L; u++) { const s = S[iOf(u)]; P.push([s.x + s.nx * tgt[u], s.z + s.nz * tgt[u]]); }
    for (let u = 2; u <= L - 2; u++) { const a = P[u - 2], bb = P[u], c = P[u + 2]; const ax = bb[0] - a[0], az = bb[1] - a[1], bx = c[0] - a[0], bz = c[1] - a[1];
      const kap = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(c[0] - bb[0], c[1] - bb[1]) + 1e-9); vmax[u] = Math.min(vmax[u], Math.sqrt(9 / Math.max(kap, 1e-6))); }
    const uEn = run + kEn, uEx = run + kEx;
    for (let u = uEn - Math.round(40 / ds); u <= uEx; u++) vmax[u] = Math.min(vmax[u], vLim - 2 / 3.6);
    vmax[ub] = Math.min(vmax[ub], 2);
    for (let u = L - 1; u >= 0; u--) { const acc = u < ub && ub - u < 40 / ds ? 2.5 : 7; vmax[u] = Math.min(vmax[u], Math.sqrt(vmax[u + 1] * vmax[u + 1] + 2 * acc * ds)); }
    const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, limiter: false, boost: false };
    let truth = st.sampleIndex, U = 0, t = 0, n = 0, integ = 0, stopped = false, frozenT = 0;
    const events = [], rec = { jumps: 0, minProg: 0, maxProg: 0, lapRes: [] };
    let releaseAt = -1;
    while (U < L - 40 && t < 240) {
      const frozen = !!pitL.state.service;
      if (frozen) {
        // main.js: no physics, the pit clock runs with the frame dt
        st.speed = 0; frozenT += STEP;
        const ev = pitL.update(STEP, st, track, { slot, limiter: input.limiter }); if (ev) events.push(ev + '@' + t.toFixed(1));
        t += STEP; continue;
      }
      if (n++ % HZ_EVERY === 0) {
        const u = clamp(U, 0, L - 1), v = Math.max(0, st.speed);
        input.limiter = u >= uEn - Math.round(30 / ds) && u <= uEx;
        let vt = vmax[u];
        const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
        const dist = stopped ? Infinity : (b.x - st.x) * fx + (b.z - st.z) * fz;
        if (dist < 25) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dist - 0.05)) + (dist > 0.05 ? 0.25 : 0));
        const braking = !stopped && dist < 0.06;
        if (braking && v < 0.02 && !stopped) { stopped = true; }
        const la = clamp(4 + 0.35 * v, 5, 20), j = clamp(u + Math.round(la / ds), 0, L), s = S[iOf(j)];
        const gx = s.x + s.nx * tgt[j] - st.x, gz = s.z + s.nz * tgt[j] - st.z;
        const sh = Math.sin(st.heading), ch = Math.cos(st.heading);
        const xf = gx * sh + gz * ch, yl = gx * ch - gz * sh, kap = 2 * yl / (xf * xf + yl * yl);
        const lock = PERF.steerLock / (1 + (v / PERF.steerSpeedRef) * (v / PERF.steerSpeedRef));
        input.steerAxis = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1);
        const cruising = input.limiter && u >= uEn && vt >= vLim - 2.5 / 3.6 && dist > 30;
        const err = (cruising ? vLim + 5 : vt) - v;
        integ = clamp(integ + err * HZ_EVERY * STEP * 0.6, 0, 1);
        if (braking) { input.throttle = null; input.brake = 1; integ = 0; }
        else if (cruising) { input.throttle = 1; input.brake = null; }
        else if (err > -0.4) { input.throttle = clamp(0.35 * err + integ + (vt > 0.5 ? 0.15 : 0), 0, 1); input.brake = null; }
        else { input.throttle = null; input.brake = clamp(-0.3 * err, 0, 1); integ *= 0.9; }
        if (input.throttle === 0) input.throttle = null;
      }
      car.update(STEP, input, track); t += STEP;
      const ev = pitL.update(STEP, st, track, { slot, limiter: input.limiter }); if (ev) events.push(ev + '@' + t.toFixed(1));
      const r = lap.update(st.sampleIndex, st.speed, STEP); if (r) rec.lapRes.push(r);
      const pr = lap.progress(st.sampleIndex); rec.maxProg = Math.max(rec.maxProg, pr);
      const g = track.locate(st.x, st.z, truth).index; let dg = g - truth; if (dg > N / 2) dg -= N; if (dg < -N / 2) dg += N; U += dg; truth = g;
    }
    rows.push({ track: td.id, slot, wraps: kOf(0) <= K, events: events.join(' '), stops: pitL.state.stops, pending: pitL.state.pending, frozenS: +frozenT.toFixed(2), lapJumps: lap.jumps, lapRes: rec.lapRes.join(','), done: U >= L - 40 });
  }
  track.dispose();
}
for (const r of rows) console.log(JSON.stringify(r));
const bad = rows.filter(r => !/^enter@[\d.]+ serviceStart@[\d.]+ serviceDone@[\d.]+ exit@[\d.]+$/.test(r.events) || r.stops !== 1 || r.lapJumps || !r.done);
console.log('rows', rows.length, 'unexpected', bad.length);
