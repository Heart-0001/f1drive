// Probe: pit limiter on every track's pit lane. Car placed on the lane centre at the entry line at limit speed,
// limiter ON, full throttle (and separately: no throttle), driven down the lane centre with a simple follower.
// Reports the max speed between the lines vs limitKmh + 3 (pit.js speeding threshold) and the grade.
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
const F1 = global.F1, PERF = F1.CAR_PERF, STEP = 1 / 120;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
let noPit = [];
const rows = [];
for (const td of global.F1_TRACKS) {
  const track = F1.buildTrack(td), pit = track.pit, S = track.samples, N = S.length;
  if (!pit) { noPit.push(td.id); track.dispose(); continue; }
  const wq = q => ((q % N) + N) % N, kOf = i => wq(i - pit.from);
  const K = kOf(pit.to), kEn = kOf(pit.entry), kEx = kOf(pit.exit);
  let minGrade = 0, maxGrade = 0;
  for (let k = kEn; k <= kEx; k++) { const g = S[wq(pit.from + k)].grade || 0; minGrade = Math.min(minGrade, g); maxGrade = Math.max(maxGrade, g); }
  for (const thr of [1, 0]) {
    const car = F1.createCar(), st = car.state; car.tyres.setWearRate(0);
    const pitL = F1.createPit({ random: () => 0.5 });
    const i0 = wq(pit.from + kEn);
    car.reset(track, i0);
    const s0 = S[i0], d0 = pit.laneD(i0);
    st.x = s0.x + s0.nx * d0; st.z = s0.z + s0.nz * d0;
    car.update(1e-4, null, track);
    st.speed = pit.limitKmh / 3.6 - 0.6;
    const input = { up: false, down: false, throttle: thr || null, brake: null, steerAxis: null, limiter: true, boost: false };
    let maxV = 0, speeding = false, t = 0, k = kEn, minV = 1e9;
    while (k <= kEx && t < 120) {
      // pure pursuit along laneD
      const j = wq(st.sampleIndex + Math.round(8 / (track.length / N)));
      const dj = Number.isFinite(pit.laneD(j)) ? pit.laneD(j) : pit.laneD(wq(pit.from + kEx));
      const s = S[j], gx = s.x + s.nx * dj - st.x, gz = s.z + s.nz * dj - st.z;
      const sh = Math.sin(st.heading), ch = Math.cos(st.heading);
      const xf = gx * sh + gz * ch, yl = gx * ch - gz * sh, kap = 2 * yl / (xf * xf + yl * yl);
      const lock = PERF.steerLock / (1 + (st.speed / PERF.steerSpeedRef) ** 2);
      input.steerAxis = clamp(Math.atan(kap * PERF.wheelbase) / lock, -1, 1);
      car.update(STEP, input, track); t += STEP;
      const ev = pitL.update(STEP, st, track, { slot: 0, limiter: true });
      if (ev === 'speeding') speeding = true;
      k = kOf(st.sampleIndex);
      if (k >= kEn && k <= kEx && st.inPit) { maxV = Math.max(maxV, st.speed); minV = Math.min(minV, st.speed); }
      if (st.hit > 0 || st.speed < 0.5) break;
    }
    rows.push({ track: td.id, thr, limit: pit.limitKmh, maxKmh: +(maxV * 3.6).toFixed(1), minKmh: +(minV * 3.6).toFixed(1),
      over: +(maxV * 3.6 - pit.limitKmh).toFixed(1), speedingEvent: speeding, gradeMin: +(minGrade * 100).toFixed(1), gradeMax: +(maxGrade * 100).toFixed(1), t: +t.toFixed(1), reached: k > kEx });
  }
  track.dispose();
}
console.log('tracks without pit:', noPit);
console.table(rows.filter(r => r.thr === 1).sort((a, b) => b.over - a.over).slice(0, 12));
console.log('speeding events with limiter on + full throttle:', rows.filter(r => r.thr === 1 && r.speedingEvent).map(r => r.track + ' ' + r.over));
console.log('coasting (no throttle) gets flagged:', rows.filter(r => r.thr === 0 && r.speedingEvent).map(r => r.track + ' ' + r.over));
