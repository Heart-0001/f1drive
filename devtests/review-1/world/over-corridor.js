// node devtests/review-1/world/over-corridor.js [id]
// Scenery triangles that pass OVER the track corridor (any height): centroid / edge midpoints inside inCorridor(x, z, 0).
// The start gantry (within 12 m of sample 6) and bridges are expected; everything else is reported per mesh with height.
const L = require('./load.js');
const F1 = L.F1;
const ids = process.argv[2] ? [process.argv[2]] : L.TRACKS.map(t => t.id);
for (const id of ids) {
  const td = L.TRACKS.find(t => t.id === id), tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
  F1.SCENERY_DEBUG = true;
  const sc = F1.buildScenery(tr, td, L.SCENERY[id]);
  const bridges = sc.debug.footprints.filter(f => f.k === 'bridge').map(f => f.p);
  const g = S[Math.round(6 / ds)];
  function inBridge(x, z) {
    for (const p of bridges) { let ins = false; for (let i = 0, n = p.length, j = n - 1; i < n; j = i++) { const a = p[i], b = p[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; } if (ins) return true; }
    return false;
  }
  const rep = {};
  for (const m of sc.group.children) {
    if (!m.geometry || !m.geometry.attributes.position || m.isInstancedMesh) continue;
    const P = m.geometry.attributes.position.array;
    for (let t = 0; t < P.length; t += 9) {
      const pts = [];
      for (let v = 0; v < 3; v++) pts.push([P[t + v * 3], P[t + v * 3 + 1], P[t + v * 3 + 2]]);
      const test = [[(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][2] + pts[1][2] + pts[2][2]) / 3]];
      for (let e = 0; e < 3; e++) { const a = pts[e], b = pts[(e + 1) % 3]; test.push([(a[0] + b[0]) / 2, (a[2] + b[2]) / 2]); }
      for (const q of test) {
        if (!tr.inCorridor(q[0], q[1], 0)) continue;
        if (Math.hypot(q[0] - g.x, q[1] - g.z) < 14) break;            // the start gantry
        if (inBridge(q[0], q[1])) break;
        const n = tr.nearest(q[0], q[1]);
        const y = Math.min(pts[0][1], pts[1][1], pts[2][1]) - tr.surfaceY(n.index, n.d);
        const key = m.name + ' @sample ' + Math.round(n.index / 20) * 20;
        if (!rep[key]) rep[key] = { n: 0, minH: 1e9, maxH: -1e9, d: n.d.toFixed(1) };
        rep[key].n++; rep[key].minH = Math.min(rep[key].minH, y); rep[key].maxH = Math.max(rep[key].maxH, y);
        break;
      }
    }
  }
  const keys = Object.keys(rep);
  console.log(id, keys.length ? '' : 'clean');
  for (const k of keys) console.log('   ' + k + ': ' + rep[k].n + ' tris, ' + rep[k].minH.toFixed(1) + '..' + rep[k].maxH.toFixed(1) + ' m above the surface, d ' + rep[k].d);
  sc.dispose(); tr.dispose();
}
