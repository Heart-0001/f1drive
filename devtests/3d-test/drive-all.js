// Drive one full lap on each track with a centreline follower using real track.js + car.js;
// replicate main.js lap timing. Report: stuck, max |d|, wall hits, lap counted, lap time, wall-on-road.
const { F1, TRACKS } = require('C:/Users/user/AppData/Local/Temp/f1drive-3d-test/load');
const only = process.argv[2];
const DT = 1 / 120;
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

function speedProfile(S, N, ds) {
  // curvature-limited target speed with backward braking pass
  const vmax = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = S[(i - 3 + N) % N], b = S[(i + 3) % N];
    const c = Math.abs((b.tx - a.tx) * S[i].nx + (b.tz - a.tz) * S[i].nz) / (6 * ds);
    // lat grip ~ 20 + 0.0045 v^2 capped 44 ; use v = sqrt(aLat / c) with aLat ~ 0.6 * (20 + ...) iteratively
    let v = 90;
    for (let k = 0; k < 8; k++) { const aLat = 0.55 * Math.min(44, 20 + 0.0045 * v * v); v = c > 1e-6 ? Math.min(90, Math.sqrt(aLat / c)) : 90; }
    vmax[i] = v;
  }
  for (let pass = 0; pass < 2; pass++) for (let k = 2 * N; k >= 0; k--) {
    const i = k % N, j = (i + 1) % N;
    const allowed = Math.sqrt(vmax[j] * vmax[j] + 2 * 8 * ds); // 8 m/s^2 braking budget
    if (vmax[i] > allowed) vmax[i] = allowed;
  }
  return vmax;
}

function wallOnRoad(track) {
  const mesh = track.group.children.find(m => m.name === 'walls');
  const pos = mesh.geometry.attributes.position.array;
  const S = track.samples; let bad = 0, worst = Infinity;
  for (let i = 0; i < pos.length; i += 9) { // one vertex per triangle is enough
    const x = pos[i], z = pos[i + 2];
    let best = Infinity;
    for (let k = 0; k < S.length; k++) { const dx = S[k].x - x, dz = S[k].z - z; const d = dx * dx + dz * dz; if (d < best) best = d; }
    best = Math.sqrt(best);
    if (best < worst) worst = best;
    if (best < 7.0) bad++;
  }
  return { bad, worst: worst.toFixed(2) };
}

const rows = [];
for (const td of TRACKS) {
  if (only && td.id !== only && !td.name.toLowerCase().includes((only || '').toLowerCase())) continue;
  const track = F1.buildTrack(td);
  const S = track.samples, N = S.length, ds = track.length / N;
  const vmax = speedProfile(S, N, ds);
  const car = F1.createCar();
  const startIdx = ((N - 10) % N + N) % N;
  car.reset(track, startIdx);
  const st = car.state;
  const lap = { started: false, n: 0, time: 0, last: null, best: null, prevIdx: startIdx, sector: 0 };
  function updateLap(dt) {
    const idx = st.sampleIndex, prev = lap.prevIdx; lap.prevIdx = idx;
    if (lap.started) lap.time += dt;
    if (idx === prev) return;
    const q = Math.min(3, Math.floor(idx * 4 / N)), pq = Math.min(3, Math.floor(prev * 4 / N));
    const forward = st.speed > 0;
    if (pq === 3 && q === 0 && forward) {
      if (!lap.started) { lap.started = true; lap.n = 1; lap.time = 0; lap.sector = 0; }
      else if (lap.sector === 3) { lap.last = lap.time; lap.n += 1; lap.time = 0; lap.sector = 0; }
    } else if (lap.started && q === lap.sector + 1 && pq === lap.sector) lap.sector = q;
  }
  let maxD = 0, maxDi = 0, hits = 0, maxHit = 0, grassSteps = 0, progress = 0, lastProg = 0, stuckT = 0, stuck = false, t = 0;
  let prevIdx = startIdx, maxSpeed = 0, worstOffTrack = null;
  const input = { up: false, down: false, left: false, right: false };
  let hdgErr0 = wrapPi(Math.atan2(S[startIdx].tx, S[startIdx].tz) - st.heading);
  while (t < 400 && lap.n < 2) {
    const idx = st.sampleIndex, v = st.speed;
    const look = Math.max(6, Math.round((6 + 0.35 * v) / ds));
    const tgt = S[(idx + look) % N];
    const des = Math.atan2(tgt.x - st.x, tgt.z - st.z);
    const err = wrapPi(des - st.heading);
    input.left = err > 0.02; input.right = err < -0.02;
    // speed target: min of profile over next braking window
    let vt = Infinity;
    const win = Math.round((v * v / (2 * 8) + 10) / ds);
    for (let k = 0; k <= win; k++) vt = Math.min(vt, vmax[(idx + k) % N] + 0); // vmax already has braking pass
    input.up = v < vt - 0.5; input.down = v > vt + 1.0;
    car.update(DT, input, track);
    updateLap(DT);
    t += DT;
    if (Math.abs(st.d) > maxD) { maxD = Math.abs(st.d); maxDi = st.sampleIndex; }
    if (st.hit > 0) { hits++; if (st.hit > maxHit) maxHit = st.hit; }
    if (st.onGrass) grassSteps++;
    if (v > maxSpeed) maxSpeed = v;
    // progress
    let di = st.sampleIndex - prevIdx; if (di > N / 2) di -= N; if (di < -N / 2) di += N;
    progress += di; prevIdx = st.sampleIndex;
    if (progress - lastProg < 1) { stuckT += DT; if (stuckT > 5) { stuck = true; break; } } else { stuckT = 0; lastProg = progress; }
  }
  const wr = wallOnRoad(track);
  rows.push({ id: td.id, name: td.name.slice(0, 26), lapCounted: lap.n >= 2, lapTime: lap.last ? lap.last.toFixed(1) : (lap.time.toFixed(1) + '*'), stuck, stuckAt: stuck ? st.sampleIndex + '/' + N : '', maxD: maxD.toFixed(1), maxDi, hits, maxHit: maxHit.toFixed(2), grassPct: (grassSteps / (t / DT) * 100).toFixed(1), vmaxKmh: (maxSpeed * 3.6).toFixed(0), startHdgErr: hdgErr0.toFixed(3), wallOnRoad: wr.bad, wallMinDist: wr.worst });
  track.dispose();
}
console.table(rows);
