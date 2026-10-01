// Is the pit lane a shortcut? Per track: length of the lane centre path (laneD offset curve from..to) vs the centreline
// and vs the racing line over the same samples; lane limit section length; the time a car needs through the lane at
// the limit vs the racing line's time over the same stretch (from the line's speed profile).
'use strict';
const { F1, KMH, track } = require('./load');
const rows = [];
for (const td of global.F1_TRACKS) {
  const { track: tr, line } = track(td.id), pit = tr.pit;
  if (!pit) continue;
  const S = tr.samples, N = S.length, K = ((pit.to - pit.from) % N + N) % N;
  let lane = 0, centre = 0, rl = 0, tLine = 0;
  let px = null, pz = null, cx = null, cz = null, rx = null, rz = null;
  for (let k = 0; k <= K; k++) {
    const i = (pit.from + k) % N, s = S[i], d = pit.laneD(i), p = line.points[i];
    const x = s.x + s.nx * d, z = s.z + s.nz * d;
    if (px !== null) { lane += Math.hypot(x - px, z - pz); centre += Math.hypot(s.x - cx, s.z - cz); const seg = Math.hypot(p.x - rx, p.z - rz); rl += seg; tLine += seg / Math.max(5, p.speed); }
    px = x; pz = z; cx = s.x; cz = s.z; rx = p.x; rz = p.z;
  }
  const limLen = ((pit.exit - pit.entry) % N + N) % N * (tr.length / N);
  const tLane = limLen / (pit.limitKmh / KMH) + (lane - limLen) / 60;   // crude: the rest at ~216 km/h
  rows.push({ id: td.id, laneM: Math.round(lane), centreM: Math.round(centre), raceLineM: Math.round(rl), laneMinusLine: Math.round(lane - rl), limitedM: Math.round(limLen), limit: pit.limitKmh, tLineS: +tLine.toFixed(1), tLaneAtLimitS: +tLane.toFixed(1) });
}
rows.sort((a, b) => a.laneMinusLine - b.laneMinusLine);
console.table(rows);
