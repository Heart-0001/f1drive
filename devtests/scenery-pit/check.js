// node devtests/scenery-pit/check.js [trackId]      (env SCENERY=<path to another scenery.js> to compare, e.g. an old copy)
//
// js/scenery.js against the pit lane of js/track.js (track.pit), every track twice (OSM data, procedural fallback):
//   inPit    scenery inside the pit lane: mesh vertices, triangle centroids / edge midpoints and tree canopies (a circle of
//            the canopy radius) for which track.pit.contains(x, z) is true. Must be 0.
//   over     the same but 6 m or more above the lane surface: only real (OSM) bridge decks spanning track and lane.
//   losEn/Ex line of sight to the light curtains at the entry / exit line: rays from eye points (1 m over the track
//            centreline 40, 80, 120 m before the line; the lane centre before it; for the exit also the far side of the
//            track abeam of it) to 5 x 4 points on the curtain that meet a scenery triangle or tree canopy within 80 m of
//            the curtain (blocked / total), the meshes that block and where. The track's own geometry and the
//            see-through debris fence are not counted. 'info': the same from the track 180 / 250 m before the entry line
//            (before the lane starts, often inside the previous corner) and the track 180 m before the exit line;
//            'real': blocked by a real (OSM) building (within 1.5 m of a mapped footprint). Both reported, not failed.
//   pitBld   metres of the garage face (pitG0..pitG1 as scenery.js finds it) with a building standing right behind it
//            (a scenery vertex 1..10 m behind the corridor edge, at least 7 m above the lane) / length of the face.
//   tex      the pit facade texture's level on the building front beside the garage face, above the lane at the face
//            (max, m): over 0.3 its garage row / numbered fascia shows above the 6 m face (a second row of garages).
//   ms       build time of F1.buildScenery (warm: second build of the same track).
// Ends with "FAILS n" (inPit > 0 or losEn / losEx blocked, or pitBld < 80 % of the face, or tex > 0.3).
const ROOT = require('path').resolve(__dirname, '..', '..') + '/';
global.window = global; global.THREE = require(ROOT + 'lib/three.min.js');
require(ROOT + 'tracks-data.js');
require(ROOT + 'scenery-data.js');
require(ROOT + 'js/track.js');
require(process.env.SCENERY ? require('path').resolve(process.env.SCENERY) : ROOT + 'js/scenery.js');
const only = process.argv[2];

function wrapN(i, N) { return ((i % N) + N) % N; }

function check(td, data, label) {
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N, pit = tr.pit;
  F1.buildScenery(tr, td, data).dispose();                     // warm-up
  const t0 = process.hrtime.bigint();
  const sc = F1.buildScenery(tr, td, data);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!pit) { console.log(td.id.padEnd(8), label.padEnd(5), 'NO PIT', 'ms', ms.toFixed(0)); sc.dispose(); tr.dispose(); return { ms, fail: 0 }; }
  const side = pit.side > 0 ? 1 : -1, K = wrapN(pit.to - pit.from, N);
  const wall = i => side > 0 ? S[i].wallPosDist : S[i].wallNegDist;
  const surf = (i, d) => tr.surfaceY(i, d);
  // pit region bbox (+ 60 m)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let k = 0; k <= K; k++) {
    const s = S[wrapN(pit.from + k, N)];
    for (const d of [0, side * (wall(wrapN(pit.from + k, N)) + 12)]) {
      const x = s.x + s.nx * d, z = s.z + s.nz * d;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
  }
  x0 -= 60; x1 += 60; z0 -= 60; z1 += 60;
  // ---- collect scenery triangles (world coords; the group has identity transforms) and trees
  const tris = [], names = [], inPit = {}, trees = [];
  // a vertex / point 6 m or more above the lane (a real bridge deck spanning it) is counted as 'over', not 'inPit'
  let inPitN = 0, overN = 0; const inPitEx = [];
  const hit = (name, what, x, y, z) => {
    const nn = tr.nearest(x, z), above = y - surf(nn.index, nn.d);
    if (what !== 'canopy' && what !== 'trunk' && above >= 6) { overN++; return; }
    inPitN++; inPit[name + ':' + what] = (inPit[name + ':' + what] || 0) + 1;
    if (inPitEx.length < 2) inPitEx.push(name + '@s' + nn.index + ',d' + nn.d.toFixed(1) + ',y+' + above.toFixed(1));
  };
  sc.group.traverse(o => {
    if (!o.geometry) return;
    const g = o.geometry;
    if (o.isInstancedMesh) {
      const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m); m.decompose(p, q, s);
        // canopy radius per unit tree (js/scenery.js treeGeometry): broadleaf 0.33 x 1.15, conifer 0.2, palm 0.34
        const h = s.y, r = Math.max(s.x, s.z) * (o.name.indexOf('conifer') >= 0 ? 0.2 : (o.name.indexOf('palm') >= 0 ? 0.34 : 0.38));
        if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
        trees.push({ x: p.x, y: p.y + h * (o.name.indexOf('palm') >= 0 ? 0.85 : 0.62), z: p.z, r, name: o.name });
        for (let a = 0; a < 8; a++) {
          const ang = a * Math.PI / 4;
          if (pit.contains(p.x + Math.cos(ang) * r, p.z + Math.sin(ang) * r)) { hit(o.name, 'canopy', p.x, p.y, p.z); break; }
        }
        if (pit.contains(p.x, p.z)) hit(o.name, 'trunk', p.x, p.y, p.z);
      }
      return;
    }
    const pa = g.attributes.position.array, idx = g.index ? g.index.array : null;
    const nT = idx ? idx.length / 3 : pa.length / 9;
    for (let t = 0; t < nT; t++) {
      const v = [0, 1, 2].map(c => { const k = idx ? idx[t * 3 + c] : t * 3 + c; return [pa[k * 3], pa[k * 3 + 1], pa[k * 3 + 2]]; });
      const bx0 = Math.min(v[0][0], v[1][0], v[2][0]), bx1 = Math.max(v[0][0], v[1][0], v[2][0]);
      const bz0 = Math.min(v[0][2], v[1][2], v[2][2]), bz1 = Math.max(v[0][2], v[1][2], v[2][2]);
      if (bx1 < x0 || bx0 > x1 || bz1 < z0 || bz0 > z1) continue;
      tris.push(v, [bx0, bx1, Math.min(v[0][1], v[1][1], v[2][1]), Math.max(v[0][1], v[1][1], v[2][1]), bz0, bz1]);
      names.push(o.name);
      const pts = v.concat([[(v[0][0] + v[1][0] + v[2][0]) / 3, 0, (v[0][2] + v[1][2] + v[2][2]) / 3],
        [(v[0][0] + v[1][0]) / 2, 0, (v[0][2] + v[1][2]) / 2], [(v[1][0] + v[2][0]) / 2, 0, (v[1][2] + v[2][2]) / 2],
        [(v[0][0] + v[2][0]) / 2, 0, (v[0][2] + v[2][2]) / 2]]);
      for (let c = 0; c < pts.length; c++) if (pit.contains(pts[c][0], pts[c][2])) { hit(o.name, c < 3 ? 'vertex' : 'face', pts[c][0], c < 3 ? pts[c][1] : Math.min(v[0][1], v[1][1], v[2][1]), pts[c][2]); break; }
    }
  });
  // ---- line of sight
  // scenery things on the segment a -> b (not the last 0.3 m): the one nearest to b as {name, t} (t = 0 at a, 1 at b), or null
  function segHits(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz), tMax = 1 - 0.3 / L;
    const sx0 = Math.min(a[0], b[0]), sx1 = Math.max(a[0], b[0]), sz0 = Math.min(a[2], b[2]), sz1 = Math.max(a[2], b[2]);
    const sy0 = Math.min(a[1], b[1]), sy1 = Math.max(a[1], b[1]);
    let best = null;
    for (let t = 0; t < names.length; t++) {
      if (names[t] === 'scenery-fence') continue;   // see-through wire mesh
      const bb = tris[t * 2 + 1];
      if (bb[1] < sx0 || bb[0] > sx1 || bb[5] < sz0 || bb[4] > sz1 || bb[3] < sy0 || bb[2] > sy1) continue;
      const v = tris[t * 2];
      // Moller-Trumbore
      const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const p = [dy * e2[2] - dz * e2[1], dz * e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, s = [a[0] - v[0][0], a[1] - v[0][1], a[2] - v[0][2]];
      const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const w = (dx * q[0] + dy * q[1] + dz * q[2]) * inv;
      if (w < 0 || u + w > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
      if (tt > 1e-4 && tt < tMax && (!best || tt > best.t)) best = { name: names[t], t: tt };
    }
    for (const c of trees) {
      const fx = a[0] - c.x, fy = a[1] - c.y, fz = a[2] - c.z;
      const A = dx * dx + dy * dy + dz * dz, B = 2 * (fx * dx + fy * dy + fz * dz), Cc = fx * fx + fy * fy + fz * fz - c.r * c.r;
      const disc = B * B - 4 * A * Cc;
      if (disc < 0) continue;
      const tt = (-B - Math.sqrt(disc)) / (2 * A);
      if (tt > 0 && tt < tMax && (!best || tt > best.t)) best = { name: c.name, t: tt };
    }
    return best;
  }
  function curtainPts(i) {
    const wd = Math.abs(pit.wallD(i)), ld = Math.abs(pit.laneD(i));
    const a = isFinite(wd) ? wd + pit.wallHalfT + 0.3 : ld - pit.laneHalfW + 0.3, b = wall(i) - 0.3, s = S[i], out = [];
    for (let l = 0; l < 5; l++) for (const h of [1, 3, 5, 7]) {
      const d = side * (a + (b - a) * l / 4);
      out.push([s.x + s.nx * d, surf(i, d) + h, s.z + s.nz * d]);
    }
    return out;
  }
  function eye(i, d) { const s = S[i]; return [s.x + s.nx * d, surf(i, d) + 1.0, s.z + s.nz * d]; }
  // blocked: the nearest scenery hit lies within NEAR m (plan) of the curtain = something stands right in front of it.
  // Eyes marked info (the track 180 / 250 m before the entry line: before the lane starts, often inside the previous
  // corner) are reported but do not fail.
  const NEAR = 80;
  // a hit on a real (OSM) building: within 1.5 m of one of the track's mapped footprints (reported, not failed: real
  // buildings are not removed for the view)
  const realFeet = (data && data.buildings || []).filter(b => b && b.k !== 'bridge' && Array.isArray(b.p) && b.p.length >= 3).map(b => b.p);
  function onReal(x, z) {
    for (const p of realFeet) {
      let c = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i], b = p[j];
        if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
        if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < 1.5) return true;
      }
      if (c) return true;
    }
    return false;
  }
  function los(line, eyes) {
    const tg = curtainPts(line), c = S[line];
    let n = 0, blocked = 0, info = 0, real = 0, far = 0; const by = {}, ex = [], perEye = eyes.map(() => 0);
    for (let ei = 0; ei < eyes.length; ei++) for (const t of tg) {
      const e = eyes[ei].p;
      n++;
      const h = segHits(e, t);
      if (!h) continue;
      const hx = e[0] + (t[0] - e[0]) * h.t, hy = e[1] + (t[1] - e[1]) * h.t, hz = e[2] + (t[2] - e[2]) * h.t;
      if (Math.hypot(hx - c.x, hz - c.z) > NEAR) { far++; continue; }
      perEye[ei]++;
      if (eyes[ei].info) { info++; continue; }
      if (onReal(hx, hz)) { real++; continue; }
      blocked++; by[h.name] = (by[h.name] || 0) + 1;
      if (ex.length < 3) { const nn = tr.nearest(hx, hz); ex.push(h.name + '@' + Math.round((wrapN(nn.index - line + N / 2, N) - N / 2) * ds) + 'm,d' + nn.d.toFixed(1) + ',y+' + (hy - S[nn.index].y).toFixed(1)); }
    }
    return { n, blocked, info, real, far, by, ex, perEye, names: eyes.map(e => e.name) };
  }
  const kEn = wrapN(pit.entry - pit.from, N);
  const enEyes = [40, 80, 120, 180, 250].map(m => ({ name: 't' + m, info: m > 120, p: eye(wrapN(pit.entry - Math.round(m / ds), N), 0) }));
  for (const m of [15, 35]) { const k = kEn - Math.round(m / ds); if (k >= 0) { const i = wrapN(pit.from + k, N); enEyes.push({ name: 'lane' + m, p: eye(i, pit.laneD(i)) }); } }
  const exEyes = [40, 100, 180].map(m => ({ name: 't' + m, info: m > 120, p: eye(wrapN(pit.exit - Math.round(m / ds), N), 0) }));
  for (const m of [20, 50, 100]) { const i = wrapN(pit.exit - Math.round(m / ds), N); exEyes.push({ name: 'lane' + m, p: eye(i, pit.laneD(i)) }); }
  exEyes.push({ name: 'across', p: eye(pit.exit, -side * (S[pit.exit].halfW - 1)) });
  const lEn = los(pit.entry, enEyes), lEx = los(pit.exit, exEyes);
  const eyeStr = l => l.names.map((nm, i) => l.perEye[i] ? nm + ':' + l.perEye[i] : '').filter(Boolean).join(',');
  // (scenery.js keeps its garage range private: found here the same way)
  let kmin = Infinity, kmax = -Infinity;
  for (const b of pit.boxes) { const k = wrapN(b.index - pit.from, N); kmin = Math.min(kmin, k); kmax = Math.max(kmax, k); }
  const half = (kmax - kmin) / (pit.boxes.length - 1) / 2;
  let g0 = Math.ceil(kmin - half), g1 = Math.floor(kmax + half), wmax = 0;
  for (let k = g0; k <= g1; k++) wmax = Math.max(wmax, wall(wrapN(pit.from + k, N)));
  while (g0 < g1 && wall(wrapN(pit.from + g0, N)) < wmax - 0.3) g0++;
  while (g1 > g0 && wall(wrapN(pit.from + g1, N)) < wmax - 0.3) g1--;
  // from the lane centre (eye 1 m) a ray over the top of the garage face (7 m above the lane there) to 10 m behind it:
  // does it meet a scenery building behind the face?
  const cover = new Uint8Array(g1 - g0 + 1);
  for (let k = g0; k <= g1; k++) {
    const i = wrapN(pit.from + k, N), s = S[i], ld = pit.laneD(i), W = side * wall(i), yl = surf(i, ld);
    const e = [s.x + s.nx * ld, yl + 1, s.z + s.nz * ld], f = (Math.abs(W) + 10 - Math.abs(ld)) / (Math.abs(W) - Math.abs(ld));
    const d2 = W + side * 10, yT = yl + 1 + (surf(i, W) + 7 - yl - 1) * f;
    const h = segHits(e, [s.x + s.nx * d2, yT, s.z + s.nz * d2]);
    if (h && /pit|masonry|glass|solid/.test(h.name) && h.t > (Math.abs(W) - Math.abs(ld)) / (Math.abs(d2) - Math.abs(ld))) cover[k - g0] = 1;
  }
  const covered = cover.reduce((a, b) => a + b, 0) / cover.length;
  // the pit facade's texture level along the face: scenery.js maps it at v = (y - ref) / 10 (garage openings 0.23..4.53 m,
  // fascia 4.77..5.63 m, glazing 5.86..9.14 m above ref), so ref = y - 10 v at every 'scenery-pit' vertex on the building
  // front (1..3 m behind the face) beside the garage face. rise = max(ref - lane at the face): above 0.37 m the fascia
  // (above 1.47 m the garage openings) shows over the 6 m face as a second row of garages
  let rise = -Infinity, riseAt = -1;
  sc.group.traverse(o => {
    if (!o.isMesh || o.name !== 'scenery-pit') return;
    const P = o.geometry.attributes.position.array, U = o.geometry.attributes.uv.array;
    for (let v = 0; v < P.length / 3; v++) {
      const nn = tr.nearest(P[3 * v], P[3 * v + 2]), k = wrapN(nn.index - pit.from, N);
      if (k < g0 || k > g1) continue;
      const a = nn.d * side - wall(nn.index);
      if (a < 1 || a > 3) continue;
      const r = P[3 * v + 1] - 10 * U[2 * v + 1] - surf(nn.index, side * wall(nn.index));
      if (r > rise) { rise = r; riseAt = k; }
    }
  });
  const fail = inPitN > 0 || lEn.blocked > 0 || lEx.blocked > 0 || covered < 0.8 || rise > 0.3;
  console.log(td.id.padEnd(8), label.padEnd(5), 'inPit', String(inPitN).padStart(3),
    'losEn', (lEn.blocked + '/' + lEn.n).padStart(7), 'losEx', (lEx.blocked + '/' + lEx.n).padStart(7),
    'over', String(overN).padStart(2), 'pitBld', ((covered * 100).toFixed(0) + '% of ' + Math.round(cover.length * ds) + 'm').padStart(12),
    'tex', (isFinite(rise) ? (rise >= 0 ? '+' : '') + rise.toFixed(2) + (rise > 0.3 ? '@k' + riseAt : '') : '-').padStart(6),
    'ms', ms.toFixed(0).padStart(4), 'info', String(lEn.info + lEx.info).padStart(2), 'real', String(lEn.real + lEx.real).padStart(2), fail ? 'FAIL' : '', inPitN ? JSON.stringify(inPit) + ' ' + inPitEx.join(' ') : '',
    lEn.blocked ? 'en:' + JSON.stringify(lEn.by) + ' eyes ' + eyeStr(lEn) + ' ' + lEn.ex.join(' ') : '', lEx.blocked ? 'ex:' + JSON.stringify(lEx.by) + ' eyes ' + eyeStr(lEx) + ' ' + lEx.ex.join(' ') : '',
    sc.stats.counts.pitBlocks !== undefined ? 'blocks ' + sc.stats.counts.pitBlocks : '');
  sc.dispose(); tr.dispose();
  return { ms, fail: fail ? 1 : 0 };
}

let fails = 0, tot = 0, n = 0;
for (const td of F1_TRACKS) {
  if (only && td.id !== only) continue;
  const d = window.F1_SCENERY && window.F1_SCENERY[td.id];
  for (const [data, label] of (d ? [[d, 'data'], [undefined, 'proc']] : [[undefined, 'proc']])) {
    const r = check(td, data, label);
    fails += r.fail; tot += r.ms; n++;
  }
}
console.log('builds', n, 'total build ms', tot.toFixed(0), 'mean', (tot / n).toFixed(1), 'FAILS', fails);
