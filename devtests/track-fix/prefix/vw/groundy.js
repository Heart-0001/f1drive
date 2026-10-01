// node devtests/review-1/verify-world/groundy.js [filter]
// track.groundY vs the rendered 'ground' mesh (terrain grid + verge skirts), by a vertical ray against the mesh triangles
// (highest hit = what is seen from above). 1) a lattice beside the pit complex (lateral 26..46 m on the pit side, every
// sample of the lane); 2) every scenery object recorded by SCENERY_DEBUG (trees, boards, posts, poles, building corners):
// the ground height it was placed from (groundY) vs the rendered ground under it.
const L = require('./load.js');
const F1 = L.F1;
const filt = process.argv[2] || '';
const EARLY = 12 + 0.5 + 16 + 2;
F1.SCENERY_DEBUG = true;
for (const td of L.TRACKS) {
  if (filt && td.id.indexOf(filt) < 0) continue;
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, p = tr.pit;
  if (!p) { tr.dispose(); continue; }
  const ground = tr.group.children.find(m => m.name === 'ground');
  const pos = ground.geometry.attributes.position.array, idx = ground.geometry.index.array;
  // triangle hash (8 m cells) limited to the pit area bounding box + 80 m
  const sg = p.side, wq = q => ((q % N) + N) % N, K = wq(p.to - p.from);
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let k = 0; k <= K; k++) { const s = S[wq(p.from + k)]; bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x); bz0 = Math.min(bz0, s.z); bz1 = Math.max(bz1, s.z); }
  bx0 -= 80; bx1 += 80; bz0 -= 80; bz1 += 80;
  const C = 8, cells = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const x0 = Math.min(pos[a], pos[b], pos[c]), x1 = Math.max(pos[a], pos[b], pos[c]);
    const z0 = Math.min(pos[a + 2], pos[b + 2], pos[c + 2]), z1 = Math.max(pos[a + 2], pos[b + 2], pos[c + 2]);
    if (x1 < bx0 || x0 > bx1 || z1 < bz0 || z0 > bz1) continue;
    for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++) for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
      const key = cx + ',' + cz; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(t);
    }
  }
  function rendered(x, z) {        // highest ground-mesh surface at (x, z); NaN if none
    const list = cells.get(Math.floor(x / C) + ',' + Math.floor(z / C)) || [];
    let best = -Infinity;
    for (const t of list) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = pos[a], az = pos[a + 2], bxx = pos[b], bzz = pos[b + 2], cx = pos[c], cz = pos[c + 2];
      const d = (bzz - cz) * (ax - cx) + (cx - bxx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bzz - cz) * (x - cx) + (cx - bxx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * pos[a + 1] + l2 * pos[b + 1] + l3 * pos[c + 1];
      if (y > best) best = y;
    }
    return best === -Infinity ? NaN : best;
  }
  // 1) lattice
  let worst = 0, wAt = null, nBad = 0, nIn = 0, worstIn = 0;
  for (let k = 0; k <= K; k += 2) {
    const i = wq(p.from + k), s = S[i];
    for (let a = 26; a <= 46; a += 1) {
      const x = s.x + s.nx * sg * a, z = s.z + s.nz * sg * a;
      const n = tr.nearest(x, z);
      if (n.index !== i && Math.abs(wq(n.index - i + N / 2) - N / 2) > 3) continue;   // another piece of track is nearer
      const r = rendered(x, z), g = tr.groundY(x, z);
      if (!(r === r)) continue;
      const dif = r - g;
      if (n.dist > EARLY) { if (Math.abs(dif) > 0.1) nBad++; if (Math.abs(dif) > Math.abs(worst)) { worst = dif; wAt = { k, a, dist: +n.dist.toFixed(1), rendered: +r.toFixed(2), groundY: +g.toFixed(2) }; } }
      else { nIn++; worstIn = Math.max(worstIn, Math.abs(dif)); }
    }
  }
  // 2) scenery objects near the pit
  const sc = F1.buildScenery(tr, td, L.SCENERY[td.id]);
  const objs = {};
  for (const f of sc.debug.footprints || []) {
    if (!f.p || !Array.isArray(f.p)) continue;
    for (const q of f.p) {
      const x = q[0], z = q[1];
      if (x < bx0 || x > bx1 || z < bz0 || z > bz1) continue;
      const n = tr.nearest(x, z);
      if (n.dist <= EARLY || n.d * sg < 0 || wq(n.index - p.from) > K) continue;
      const r = rendered(x, z), g = tr.groundY(x, z);
      if (!(r === r) || Math.abs(r - g) < 0.2) continue;
      const o = objs[f.k] || (objs[f.k] = { n: 0, max: 0 });
      o.n++; if (Math.abs(r - g) > Math.abs(o.max)) o.max = +(r - g).toFixed(2);
    }
  }
  sc.dispose();
  console.log(`${td.id.padEnd(8)} beyond ${EARLY} m: ${nBad} lattice pts off by >0.1 m, worst rendered-groundY ${worst.toFixed(2)} m ${wAt ? JSON.stringify(wAt) : ''} | inside ${EARLY} m worst ${worstIn.toFixed(2)} m | objects (points) off >0.2 m: ${JSON.stringify(objs)}`);
  tr.dispose();
}
