// node devtests/review-1/verify-world/pit-tex.js [filter]
// For every pit-facade wall vertex of the built 'scenery-pit' mesh: texture reference ref = y - 10 * v (v = (y - ref) / 10
// in addBuilding), compared with the local lane surface at the garage face (track.surfaceY at the pit-side wall offset).
// delta = ref - localLane. Texture rows: garage opening 0.23..4.53 m, fascia 4.77..5.63 m, glazing 5.86..9.14 m above ref;
// the track.js garage face is 6.0 m tall. Only vertices on the front wall (1..3 m behind the face) and beside the full-depth
// face are counted.
const L = require('../load.js');
const F1 = L.F1;
const filt = process.argv[2] || '';
const rows = [];
for (const td of L.TRACKS) {
  if (filt && td.id.indexOf(filt) < 0) continue;
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, p = tr.pit;
  if (!p) { console.log(td.id, 'no pit'); continue; }
  const sg = p.side, wq = q => ((q % N) + N) % N, K = wq(p.to - p.from);
  // face samples: pit side wall distance at its max (garage face stands there)
  let wmax = 0;
  for (let k = 0; k <= K; k++) { const s = S[wq(p.from + k)]; wmax = Math.max(wmax, sg > 0 ? s.wallPosDist : s.wallNegDist); }
  const sc = F1.buildScenery(tr, td, L.SCENERY[td.id]);
  let mesh = null;
  sc.group.traverse(o => { if (o.isMesh && o.name === 'scenery-pit') mesh = o; });
  if (!mesh) { console.log(td.id, 'no scenery-pit mesh'); sc.dispose(); tr.dispose(); continue; }
  const P = mesh.geometry.attributes.position.array, U = mesh.geometry.attributes.uv.array;
  let dMax = -Infinity, dMin = Infinity, at = null, cnt = 0, over037 = 0, over147 = 0;
  const perK = new Map();
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2], vv = U[2 * v + 1];
    const n = tr.nearest(x, z), k = wq(n.index - p.from);
    if (k > K) continue;
    const s = S[n.index], wd = sg > 0 ? s.wallPosDist : s.wallNegDist;
    if (wd < 13) continue;
    const a = n.d * sg;
    if (a < wd + 1.0 || a > wd + 3.0) continue;        // front wall of the building only
    const ref = y - 10 * vv;
    const lane = tr.surfaceY(n.index, sg * wd);
    const dl = ref - lane;
    cnt++;
    if (dl > 0.37) over037++;
    if (dl > 1.47) over147++;
    if (dl > dMax) { dMax = dl; at = { k, index: n.index, ref: +ref.toFixed(2), lane: +lane.toFixed(2) }; }
    if (dl < dMin) dMin = dl;
    const kk = Math.round(k / 10) * 10; perK.set(kk, Math.max(perK.get(kk) || -99, dl));
  }
  let laneMin = Infinity, laneMax = -Infinity;
  for (let k = 0; k <= K; k++) { const i = wq(p.from + k), s = S[i]; const wd = sg > 0 ? s.wallPosDist : s.wallNegDist; if (wd < wmax - 0.3) continue; const y = tr.surfaceY(i, sg * wd); laneMin = Math.min(laneMin, y); laneMax = Math.max(laneMax, y); }
  const line = `${td.id.padEnd(8)} faceVerts ${String(cnt).padStart(4)} delta ${dMin.toFixed(2)}..${dMax.toFixed(2)} m -> fascia top above face ${(5.625 + dMax - 6).toFixed(2)} m, opening top above face ${(4.53 + dMax - 6).toFixed(2)} m; verts with fascia above face ${over037}, with openings above face ${over147}; lane drop beside face ${(laneMax - laneMin).toFixed(2)} m; worst ${JSON.stringify(at)}`;
  console.log(line);
  if (filt) console.log('   per 10 samples max delta:', [...perK.entries()].sort((a, b) => a[0] - b[0]).map(e => e[0] + ':' + e[1].toFixed(1)).join(' '));
  rows.push([td.id, dMax]);
  sc.dispose(); tr.dispose();
}
rows.sort((a, b) => b[1] - a[1]);
console.log('\nworst:', rows.slice(0, 12).map(r => r[0] + ' ' + r[1].toFixed(2)).join(', '));
