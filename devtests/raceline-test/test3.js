// synthetic elevation + v1 fallback checks
const path = require('path');
const ROOT = 'C:/Users/user/Desktop/f1drive';
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');
let hasElev = 0; for (const t of F1_TRACKS) if (t.elev) hasElev++;
console.log('tracks with real elev:', hasElev, '/', F1_TRACKS.length);
for (const name of ['Spa', 'Monaco', 'Suzuka', 'Red Bull', 'Baku', 'Interlagos']) {
  const src = F1_TRACKS.find(t => new RegExp(name, 'i').test(t.name));
  const n = src.points.length;
  const td = src;
  const track = F1.buildTrack(td), line = F1.buildRaceLine(track), car = F1.createCar();
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  let maxGrade = 0, minHW = 9, maxBank = 0, yErr = 0, minY = 1e9, maxY = -1e9;
  const pos = line.group.children[0].geometry.attributes.position.array;
  for (let i = 0; i < N; i++) {
    maxGrade = Math.max(maxGrade, Math.abs(S[i].grade)); minHW = Math.min(minHW, S[i].halfW); maxBank = Math.max(maxBank, Math.abs(S[i].bank));
    yErr = Math.max(yErr, Math.abs(pos[i * 6 + 1] - (track.surfaceY(i, P[i].d + 0.45) + 0.06)), Math.abs(pos[i * 6 + 4] - (track.surfaceY(i, P[i].d - 0.45) + 0.06)));
    minY = Math.min(minY, S[i].y); maxY = Math.max(maxY, S[i].y);
    if (Math.abs(P[i].d) > S[i].halfW - 1.6 + 1e-6) throw new Error('offset out of limits');
  }
  car.reset(track, 0);
  const dt = 1 / 60, input = {};
  let t = 0, lapStart = 0, laps = [], prev = 0, grass = 0, hits = 0;
  while (laps.length < 3 && t < 900) {
    line.update(st);
    const v = Math.max(0, st.speed), lv = line.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading);
    const want = Math.max(-1, Math.min(1, Math.atan(2 * lat / (dx * dx + dz * dz) * 3.6) / (0.35 / (1 + (v / 22) * (v / 22)))));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, track); t += dt;
    if (st.onGrass) grass++; if (st.hit > 0) hits++;
    if (prev > N * 0.75 && st.sampleIndex < N * 0.25) { laps.push(t - lapStart); lapStart = t; }
    prev = st.sampleIndex;
  }
  console.log((laps.length === 3 && !grass && !hits ? 'OK   ' : 'FAIL ') + src.name.padEnd(38), 'y', minY.toFixed(0) + '..' + maxY.toFixed(0), 'maxGrade', (maxGrade * 100).toFixed(1) + '%', 'maxBank', (maxBank * 57.3).toFixed(1), 'minHalfW', minHW.toFixed(2),
    'ribbonYerr', yErr.toExponential(1), 'pred', fmt(line.lapTime), 'laps', laps.map(fmt).join(' '), 'grass', grass, 'hits', hits);
  // v1 fallback: strip the v2 fields
  const v1 = { samples: S.map(s => ({ x: s.x, z: s.z, tx: s.tx, tz: s.tz, nx: s.nx, nz: s.nz, s: s.s, wallPos: s.wallPos, wallNeg: s.wallNeg })), length: track.length, halfWidth: 7, wallDist: 12 };
  const l1 = F1.buildRaceLine(v1); l1.update({ sampleIndex: 3, speed: 40 });
  const p1 = l1.group.children[0].geometry.attributes.position.array; let bad = 0;
  for (let i = 0; i < p1.length; i++) if (!isFinite(p1[i])) bad++;
  for (let i = 1; i < p1.length; i += 3) if (Math.abs(p1[i] - 0.06) > 1e-6) bad++;
  if (bad) console.log('  v1 fallback BAD', bad);
  l1.setVisible(false); l1.setVisible(true); l1.dispose(); line.dispose();
}
