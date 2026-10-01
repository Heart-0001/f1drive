const path = require('path');const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));require(path.join(ROOT, 'js/track.js'));require(path.join(ROOT, 'js/car.js'));require(path.join(ROOT, 'js/raceline.js'));
const td = F1_TRACKS.find(t => new RegExp(process.argv[2], 'i').test(t.name)), from = +process.argv[3], to = +process.argv[4];
const track = F1.buildTrack(td), line = F1.buildRaceLine(track), car = F1.createCar(), S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
car.reset(track, 0); const dt = 1 / 120, input = {}; let t = 0, lap = 0, prev = 0, last = -1;
while (lap < 2 && t < 600) {
  line.update(st); const v = Math.max(0, st.speed), lv = line.levels[2];
  input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
  const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
  const dx = tp.x - st.x, dz = tp.z - st.z, lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading);
  const want = Math.max(-1, Math.min(1, Math.atan(2 * lat / (dx * dx + dz * dz) * 3.6) / (0.35 / (1 + (v / 22) * (v / 22)))));
  input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
  const v0 = st.speed; car.update(dt, input, track); t += dt;
  const i = st.sampleIndex;
  if (lap === 1 && i >= from && i <= to && i !== last) { last = i; const p = P[i], s = S[i];
    console.log(i, 'v', (st.speed*3.6).toFixed(0), 'lim', (p.limit*3.6).toFixed(0), 'tgt', (p.speed*3.6).toFixed(0), 'lv', lv.toFixed(2), input.down ? 'BRK' : input.up ? 'thr' : 'lift', 'acc', ((st.speed - v0) / dt).toFixed(1), 'R', (1/p.curvature).toFixed(0), 'y', s.y.toFixed(1), 'grade', (s.grade*100).toFixed(1), 'bank', (s.bank*57.3).toFixed(1), 'dev', (st.d - p.d).toFixed(2), 'steer', st.steer.toFixed(2)); }
  if (prev > N * 0.75 && i < N * 0.25) lap++; prev = i;
}
