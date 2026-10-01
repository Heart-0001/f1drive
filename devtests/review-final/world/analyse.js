// node devtests/review-final/world/analyse.js  -- numeric checks of the built tracks (no verdict, numbers to read)
const { F1, TRACKS, THREE } = require('../../3d-test/load.js');
require(require('path').resolve(__dirname, '..', '..', '..') + '/scenery-data.js');
const deg = r => r * 180 / Math.PI;
for (const td of TRACKS) {
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
  // elevation: max grade, max |d grade / ds| (vertical curvature), biggest 2 m step
  let maxG = 0, maxK = 0, maxStep = 0, gi = 0, ki = 0;
  for (let i = 0; i < N; i++) {
    const a = S[(i - 1 + N) % N], c = S[(i + 1) % N];
    if (Math.abs(S[i].grade) > maxG) { maxG = Math.abs(S[i].grade); gi = i; }
    const k = (c.grade - a.grade) / (2 * ds);
    if (Math.abs(k) > maxK) { maxK = Math.abs(k); ki = i; }
    maxStep = Math.max(maxStep, Math.abs(c.y - S[i].y));
  }
  // banking
  let maxB = 0, bi = 0;
  for (let i = 0; i < N; i++) if (Math.abs(S[i].bank) > maxB) { maxB = Math.abs(S[i].bank); bi = i; }
  // bank override position check: the fraction point of the polyline vs the sample where the full angle starts
  let ov = '';
  for (const o of td.bankOverrides || []) {
    const pts = td.points, cum = [0];
    for (let u = 0; u < pts.length; u++) { const a = pts[u], b = pts[(u + 1) % pts.length]; cum.push(cum[u] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    const at = f => { const s = f * cum[pts.length]; let a = 0; while (a < pts.length - 1 && cum[a + 1] <= s) a++; const t = (s - cum[a]) / ((cum[a + 1] - cum[a]) || 1); const p0 = pts[a], p1 = pts[(a + 1) % pts.length]; return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]; };
    const pa = at(o.from), pb = at(o.to), na = tr.nearest(pa[0], pa[1]), nb = tr.nearest(pb[0], pb[1]);
    // samples at the full angle
    const full = Math.min(Math.abs(o.deg), 30) * Math.PI / 180;
    let f0 = -1, f1 = -1, cnt = 0;
    for (let i = 0; i < N; i++) if (Math.abs(Math.abs(S[i].bank) - full) < 0.002) { cnt++; if (f0 < 0) f0 = i; f1 = i; }
    // sign: inside lower?  curvature sign over the section vs bank sign
    let net = 0; const len = ((nb.index - na.index) % N + N) % N;
    for (let v = 0; v <= len; v++) { const i = (na.index + v) % N, a = S[(i - 2 + N) % N], c = S[(i + 2) % N]; net += ((c.tx - a.tx) * S[i].nx + (c.tz - a.tz) * S[i].nz); }
    const bmid = S[(na.index + (len >> 1)) % N].bank;
    ov += ` [${o.name}: from s=${Math.round(na.index * ds)} (off ${na.dist.toFixed(1)} m) to s=${Math.round(nb.index * ds)} (off ${nb.dist.toFixed(1)} m), full-angle samples ${cnt} (${f0}..${f1}), turn ${net > 0 ? 'left' : 'right'}, bank mid ${deg(bmid).toFixed(1)}deg -> ${(net > 0) === (bmid < 0) ? 'inside lower OK' : 'WRONG SIDE'}]`;
  }
  // terrain: biggest step between neighbouring grid vertices of the ground mesh (fine part)
  const g = tr.group.children.find(m => m.name === 'ground').geometry, pos = g.getAttribute('position');
  let maxT = 0;
  // vertices: unknown grid dims -> scan index triangles for max |dy| over edges shorter than 25 m
  const idx = g.getIndex().array;
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + (e + 1) % 3];
      const dx = pos.getX(a) - pos.getX(b), dz = pos.getZ(a) - pos.getZ(b), dy = Math.abs(pos.getY(a) - pos.getY(b));
      const l = Math.hypot(dx, dz);
      if (l < 25 && dy / l > maxT) maxT = dy / l;
    }
  }
  // pit lane: boxes vs curtains, lane slope, box lateral position inside outer wall
  let pit = 'no pit';
  if (tr.pit) {
    const P = tr.pit, kE = ((P.entry - P.from) % N + N) % N, kX = ((P.exit - P.from) % N + N) % N;
    let minCur = Infinity;
    for (const b of P.boxes) { const k = ((b.index - P.from) % N + N) % N; minCur = Math.min(minCur, Math.abs(k - kE) * ds, Math.abs(k - kX) * ds); }
    let maxLaneG = 0;
    for (let k = kE; k <= kX; k++) { const i = (P.from + k) % N; maxLaneG = Math.max(maxLaneG, Math.abs(S[i].grade)); }
    const bx = P.boxes[0], wOut = P.side > 0 ? S[bx.index].wallPosDist : S[bx.index].wallNegDist;
    pit = `pit side ${P.side} lim ${P.limitKmh} box-curtain min ${minCur.toFixed(1)} m, lane grade max ${(maxLaneG * 100).toFixed(1)}%, box1 |d| ${Math.abs(bx.d).toFixed(1)} outer wall ${wOut.toFixed(1)}`;
  }
  console.log(`${td.id.padEnd(8)} ${td.name.slice(0, 26).padEnd(26)} grade max ${(maxG * 100).toFixed(1)}% @${gi}  vcurv max ${(maxK * 1000).toFixed(2)}e-3 @${ki}  step ${maxStep.toFixed(2)}  bank max ${deg(maxB).toFixed(1)}deg @${bi}  terrain slope max ${maxT.toFixed(2)}  ${pit}${ov}`);
  tr.dispose();
}
