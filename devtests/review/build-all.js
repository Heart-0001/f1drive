// Build every track; report geometry stats: N, length, wall coverage, min clearance, wall-on-road, road pinch.
const { F1, TRACKS } = require('./load');
const HALF = 7, WALL = 12;
function wrap(i, n) { return ((i % n) + n) % n; }
const rows = [];
for (const td of TRACKS) {
  let t;
  try { t = F1.buildTrack(td); } catch (e) { console.log('BUILD FAIL', td.name, e.message); continue; }
  const S = t.samples, N = S.length;
  let nan = 0, wp = 0, wn = 0;
  for (const s of S) { if (![s.x, s.z, s.tx, s.tz, s.nx, s.nz, s.s].every(Number.isFinite)) nan++; if (s.wallPos) wp++; if (s.wallNeg) wn++; }
  // min distance between non-adjacent samples (parallel sections / crossings), excluding +-60 samples along track
  let minPar = Infinity, minParI = -1, minParJ = -1;
  for (let i = 0; i < N; i++) {
    for (let j = i + 60; j < N; j++) {
      if (N - (j - i) < 60) continue;
      const dx = S[i].x - S[j].x, dz = S[i].z - S[j].z, d = Math.hypot(dx, dz);
      if (d < minPar) { minPar = d; minParI = i; minParJ = j; }
    }
  }
  // wall geometry check: does the wall line (as drawn: clamped) fall on a road? Recompute clamp like track.js.
  // Instead: check for each sample where wallPos/Neg true, distance from unclamped wall point to nearest sample >= 8.5 (by construction) -> skip.
  // Check min corner radius (curvature) from samples.
  let maxCurv = 0, maxCurvI = 0;
  for (let i = 0; i < N; i++) {
    const a = S[wrap(i - 2, N)], b = S[wrap(i + 2, N)];
    const c = Math.abs((b.tx - a.tx) * S[i].nx + (b.tz - a.tz) * S[i].nz) / (4 * (t.length / N));
    if (c > maxCurv) { maxCurv = c; maxCurvI = i; }
  }
  // gap runs (no wall) lengths per side
  function runs(key) {
    const out = []; let start = -1;
    for (let k = 0; k < 2 * N; k++) { const i = k % N; const v = S[i][key]; if (!v && start < 0) start = k; if (v && start >= 0) { if (start < N) out.push([start, k - start]); start = -1; } }
    return out;
  }
  const gp = runs('wallPos'), gn = runs('wallNeg');
  const heading0 = Math.atan2(S[0].tx, S[0].tz);
  rows.push({ id: td.id, name: td.name, N, len: t.length.toFixed(0), km: td.lengthKm, nan, wallPos: (wp / N * 100).toFixed(0) + '%', wallNeg: (wn / N * 100).toFixed(0) + '%', gapsPos: gp.length, gapsNeg: gn.length, biggestGap: Math.max(0, ...gp.map(g => g[1]), ...gn.map(g => g[1])) * 2 + 'm', minPar: minPar.toFixed(1), minRad: (1 / maxCurv).toFixed(1), pts: td.points.length });
  t.dispose();
}
console.table(rows);
