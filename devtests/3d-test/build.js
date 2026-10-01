const { F1, TRACKS, synth } = require('./load');
console.log('synthetic elev tracks:', synth);
const only = process.argv[2];
let fails = 0; const rows = [];
function check(c, m) { if (!c) { fails++; if (fails < 60) console.log('  FAIL', m); } }
for (const td of TRACKS) {
  if (only && !td.name.toLowerCase().includes(only.toLowerCase()) && td.id !== only) continue;
  F1.buildTrack(td).dispose();
  const t0 = process.hrtime.bigint();
  const tr = F1.buildTrack(td);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const S = tr.samples, N = S.length;
  let tris = 0;
  for (const m of tr.group.children) {
    for (const k of Object.keys(m.geometry.attributes)) { const a = m.geometry.attributes[k].array; for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { check(false, td.id + ' NaN ' + m.name + '.' + k); break; } }
    tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  }
  for (const s of S) for (const k in s) if (typeof s[k] === 'number' && !Number.isFinite(s[k])) check(false, td.id + ' sample NaN ' + k);
  check(tr.group.children.length <= 6, 'mesh count');
  // surfaceY vs road / runoff / paint vertices
  let maxErr = 0;
  for (const [name, lift] of [['road', 0.012], ['runoff', 0], ['paint', 0.03]]) {
    const p = tr.group.children.find(m => m.name === name).geometry.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      const loc = tr.locate(p[i], p[i + 2], -1, p[i + 1]);   // (the vertex's height picks the road at a bridge: Suzuka, v6.2)
      const s = S[loc.index];
      if (Math.hypot(p[i] - s.x - s.nx * loc.d, p[i + 2] - s.z - s.nz * loc.d) > 0.05) continue; // not exactly abeam a sample
      const e = Math.abs(p[i + 1] - tr.surfaceY(loc.index, loc.d)) - (name === 'paint' ? 0.04 : lift);
      if (e > maxErr) maxErr = e;
    }
  }
  check(maxErr < 0.03, td.id + ' surfaceY mismatch ' + maxErr.toFixed(3));
  // walls
  let minWallClear = 1e9, minMargin = 1e9, noWall = 0, minHW = 1e9, minWD = 1e9, maxSlope = 0, maxBank = 0, yMax = 0;
  for (let i = 0; i < N; i++) {
    const s = S[i];
    minHW = Math.min(minHW, s.halfW); maxSlope = Math.max(maxSlope, Math.abs(s.grade)); maxBank = Math.max(maxBank, Math.abs(s.bank)); yMax = Math.max(yMax, s.y);
    check(s.halfW <= 7 + 1e-9 && s.halfW >= 3.5 - 1e-9, 'halfW range');
    if (s.wallPos) { minMargin = Math.min(minMargin, s.wallPosDist - s.halfW); minWD = Math.min(minWD, s.wallPosDist); } else noWall++;
    if (s.wallNeg) { minMargin = Math.min(minMargin, s.wallNegDist - s.halfW); minWD = Math.min(minWD, s.wallNegDist); } else noWall++;
    const b = S[(i + 1) % N];
    check(Math.abs(b.halfW - s.halfW) < 0.35 && Math.abs(b.wallPosDist - s.wallPosDist) < 0.8 && Math.abs(b.wallNegDist - s.wallNegDist) < 0.8, td.id + ' width step at ' + i);
  }
  check(minMargin >= 0.99, td.id + ' wall margin ' + minMargin);
  // wall vertices vs any centreline sample: must be >= that sample's halfW + 0.5 away
  const wp = tr.group.children.find(m => m.name === 'walls').geometry.attributes.position.array;
  let wallInRoad = 0, underDeck = 0;
  const nearBridge = k => (tr.bridges || []).some(B => { const w = q => ((k - q) % N + N) % N; return w(B.deckFrom - 10) <= ((B.deckTo - B.deckFrom + 20) % N + N) % N || Math.min(w(B.lo), N - w(B.lo)) <= 30; });
  for (let i = 0; i < wp.length; i += 9) {
    const loc = tr.locate(wp[i], wp[i + 2], -1, wp[i + 1]); const s = S[loc.index];   // (height: the level at a bridge)
    // (v6.2: a bridge's abutment walls stand behind the lower road's walls UNDER the upper road's deck - below its
    //  surface, not in its way: a wall vertex more than 0.5 m below the road it lies under is not "in the road")
    if (nearBridge(loc.index) && wp[i + 1] < tr.surfaceY(loc.index, loc.d) - 0.5) { underDeck++; continue; }
    const dist = Math.hypot(wp[i] - s.x, wp[i + 2] - s.z);
    minWallClear = Math.min(minWallClear, dist - s.halfW);
    if (dist < s.halfW + 0.5) wallInRoad++;
  }
  check(wallInRoad === 0, td.id + ' wall verts inside road: ' + wallInRoad + ' minClear ' + minWallClear.toFixed(2));
  if (underDeck) console.log('  ' + td.id + ': ' + underDeck + ' wall vertices under a bridge deck (abutments), not counted');
  // drawn inner wall face == exported wall distance (collision matches what is drawn)
  { const set = new Set(); for (let i = 0; i < wp.length; i += 3) set.add(Math.round(wp[i] * 50) + ',' + Math.round(wp[i + 2] * 50));
    let miss = 0;
    for (let i = 0; i < N; i++) { const s = S[i], nb = S[(i + 1) % N];
      for (const [fl, nf, sg, wd] of [[s.wallPos, nb.wallPos, 1, s.wallPosDist], [s.wallNeg, nb.wallNeg, -1, s.wallNegDist]]) {
        if (!fl || !nf) continue; const x = s.x + s.nx * sg * wd, z = s.z + s.nz * sg * wd; let ok = false;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (set.has((Math.round(x * 50) + a) + ',' + (Math.round(z * 50) + b))) ok = true;
        if (!ok) miss++; } }
    check(miss === 0, td.id + ' drawn wall not at exported distance: ' + miss); }
  // ground never above the track: bucket ground triangles
  const gm = tr.group.children.find(m => m.name === 'ground').geometry, gp = gm.attributes.position.array, gi = gm.index.array;
  const CELL = 8, buckets = new Map();
  let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
  for (const s of S) { bx0 = Math.min(bx0, s.x); bx1 = Math.max(bx1, s.x); bz0 = Math.min(bz0, s.z); bz1 = Math.max(bz1, s.z); }
  bx0 -= 50; bz0 -= 50; bx1 += 50; bz1 += 50;
  for (let t = 0; t < gi.length; t += 3) {
    const a = gi[t] * 3, b = gi[t + 1] * 3, c = gi[t + 2] * 3;
    const x0 = Math.min(gp[a], gp[b], gp[c]), x1 = Math.max(gp[a], gp[b], gp[c]), z0 = Math.min(gp[a + 2], gp[b + 2], gp[c + 2]), z1 = Math.max(gp[a + 2], gp[b + 2], gp[c + 2]);
    if (x1 < bx0 || x0 > bx1 || z1 < bz0 || z0 > bz1) continue;
    for (let cx = Math.floor(Math.max(x0, bx0) / CELL); cx <= Math.floor(Math.min(x1, bx1) / CELL); cx++) for (let cz = Math.floor(Math.max(z0, bz0) / CELL); cz <= Math.floor(Math.min(z1, bz1) / CELL); cz++) {
      const k = cx * 100003 + cz; let l = buckets.get(k); if (!l) buckets.set(k, l = []); l.push(t);
    }
  }
  function groundTop(x, z) {
    const l = buckets.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)); let top = -Infinity, cnt = 0;
    if (!l) return { top, cnt };
    for (const t of l) {
      const a = gi[t] * 3, b = gi[t + 1] * 3, c = gi[t + 2] * 3;
      const d = (gp[b + 2] - gp[c + 2]) * (gp[a] - gp[c]) + (gp[c] - gp[b]) * (gp[a + 2] - gp[c + 2]);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((gp[b + 2] - gp[c + 2]) * (x - gp[c]) + (gp[c] - gp[b]) * (z - gp[c + 2])) / d;
      const v = ((gp[c + 2] - gp[a + 2]) * (x - gp[c]) + (gp[a] - gp[c]) * (z - gp[c + 2])) / d;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const y = u * gp[a + 1] + v * gp[b + 1] + (1 - u - v) * gp[c + 1]; cnt++;
      if (y > top) top = y;
    }
    return { top, cnt };
  }
  let buried = 0, worstBury = -1e9, holes = 0, maxFloat = 0;
  for (let i = 0; i < N; i++) {
    const s = S[i];
    const lo = -(s.wallNegDist - 0.05), hi = s.wallPosDist - 0.05;
    for (let k = 0; k <= 6; k++) {
      const d = lo + (hi - lo) * k / 6;
      const g = groundTop(s.x + s.nx * d, s.z + s.nz * d), sy = tr.surfaceY(i, d);
      if (g.cnt === 0) holes++;
      if (g.top > sy - 0.02) { buried++; worstBury = Math.max(worstBury, g.top - sy); }
      maxFloat = Math.max(maxFloat, sy - g.top);
    }
    for (const d of [-40, 40]) if (groundTop(s.x + s.nx * d, s.z + s.nz * d).cnt === 0) holes++;
  }
  // groundY vs mesh, nearest vs brute force, inCorridor
  let gErr = [], gBig = 0, nearBad = 0, corrBad = 0;
  for (let i = 0; i < N; i += 3) {
    const s = S[i];
    for (const d of [-150, -60, -33, -22, -16, -13.5, -5, 0, 6, 13.5, 16, 22, 33, 60, 150]) {
      const x = s.x + s.nx * d, z = s.z + s.nz * d;
      const nr = tr.nearest(x, z), br = tr.locate(x, z, -1);
      if (Math.abs(nr.dist - Math.hypot(x - S[br.index].x, z - S[br.index].z)) > 1e-6) nearBad++;
      const gy = tr.groundY(x, z);
      if (!Number.isFinite(gy)) { gBig++; continue; }
      const ns = S[nr.index], wd = nr.d > 0 ? ns.wallPosDist : ns.wallNegDist;
      if (Math.abs(d) <= 5 && !tr.inCorridor(x, z, 0)) corrBad++;
      if (Math.abs(nr.d) < wd && nr.dist < wd) { // inside the walls: must be the track surface
        if (!tr.inCorridor(x, z, 0)) corrBad++;
        if (Math.abs(gy - tr.surfaceY(nr.index, nr.d)) > 1e-6) gBig++;
        continue;
      }
      if (tr.inCorridor(x, z, 0.3)) continue;   // wall footprint / edge: skip
      if (Math.abs(d) > 45) { if (x > bx0 + 1 && x < bx1 - 1 && z > bz0 + 1 && z < bz1 - 1) {} else continue; }
      const g = groundTop(x, z); if (!g.cnt) continue;
      const e = Math.abs(gy - g.top); gErr.push(e); if (e > 0.5) gBig++;
    }
  }
  gErr.sort((a, b) => a - b);
  const gP99 = gErr[Math.floor(gErr.length * 0.99)] || 0, gMax = gErr[gErr.length - 1] || 0;
  check(nearBad === 0, td.id + ' nearest() mismatch ' + nearBad);
  check(corrBad === 0, td.id + ' inCorridor mismatch ' + corrBad);
  check(gP99 < 0.15, td.id + ' groundY p99 err ' + gP99.toFixed(3) + ' max ' + gMax.toFixed(2) + ' big ' + gBig + '/' + gErr.length);
  check(buried === 0, td.id + ' ground above track at ' + buried + ' pts, worst ' + worstBury.toFixed(2));
  check(holes === 0, td.id + ' ground holes ' + holes);
  check(ms < 250, td.id + ' build ' + ms.toFixed(0) + 'ms');
  rows.push({ id: td.id, name: td.name.slice(0, 24), N, ms: ms.toFixed(0), tris, cross: tr.crossings.length, yMax: yMax.toFixed(1), slopePct: (maxSlope * 100).toFixed(1), bankDeg: (maxBank * 180 / Math.PI).toFixed(1), minHW: minHW.toFixed(2), minWall: minWD.toFixed(2), noWall, surfErr: maxErr.toFixed(3), wallClr: minWallClear.toFixed(2), float: maxFloat.toFixed(1), gY99: gP99.toFixed(3), gYmax: gMax.toFixed(2) });
  tr.dispose();
}
console.table(rows);
console.log(fails ? 'FAILURES ' + fails : 'ALL PASS');
