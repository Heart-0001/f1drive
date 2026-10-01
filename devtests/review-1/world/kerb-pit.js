// kerbs / paint under the pit lane asphalt, and the Zandvoort bridge vs the entry curtain
const L = require('./load.js');
const F1 = L.F1;
const KERB_CURV = 1 / 120, KERB_W = 1.3, Y_PAINT = 0.03, Y_START = 0.04;
for (const td of L.TRACKS) {
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, p = tr.pit;
  if (!p) continue;
  const sg = p.side, wq = q => ((q % N) + N) % N, K = wq(p.to - p.from);
  // paint mesh: triangles at lift Y_PAINT (kerb/edge line) whose centroid lies on the pit side beyond halfW and inside the lane asphalt
  const paint = tr.group.children.find(m => m.name === 'paint');
  const P = paint.geometry.attributes.position.array, C = paint.geometry.attributes.color.array;
  let kerbOnLane = 0, redOnLane = 0, ks = new Set();
  for (let t = 0; t < P.length; t += 9) {
    const cx = (P[t] + P[t + 3] + P[t + 6]) / 3, cz = (P[t + 2] + P[t + 5] + P[t + 8]) / 3;
    const n = tr.nearest(cx, cz), k = wq(n.index - p.from);
    if (k > K) continue;
    const a = n.d * sg, s = S[n.index];
    if (a <= s.halfW + 0.05) continue;
    if (!p.paved(n.index, n.d)) continue;
    const isRed = C[t] > 0.7 && C[t + 1] < 0.3;
    // exclude the pit's own paint: lane edge lines (white, thin) / boxes / signs are white/yellow/black/red-ring: only count the red/white kerb pattern = red triangles
    if (isRed) { redOnLane++; ks.add(k); }
  }
  if (redOnLane) console.log(td.id, 'red kerb triangles inside the pit lane asphalt:', redOnLane, 'at lane samples k', [...ks].sort((a, b) => a - b).slice(0, 8).join(','), '... (K=' + K + ', kEn=' + wq(p.entry - p.from) + ', kEx=' + wq(p.exit - p.from) + ')');
}
// Zandvoort bridge vs curtain
{
  const td = L.TRACKS.find(t => t.id === 'nl-1948'), tr = F1.buildTrack(td), S = tr.samples, p = tr.pit;
  F1.SCENERY_DEBUG = true;
  const sc = F1.buildScenery(tr, td, L.SCENERY['nl-1948']);
  const e = p.entry, s = S[e];
  const laneY = tr.surfaceY(e, p.laneD(e));
  for (const f of sc.debug.footprints) if (f.k === 'bridge') console.log('nl-1948 bridge deck bottom', f.minY.toFixed(2), 'lane surface at entry', laneY.toFixed(2), 'curtain top', (laneY + 7.5).toFixed(2), 'column top', (laneY + 8.1).toFixed(2), 'over', f.over);
}
