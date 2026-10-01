const path = require('path');
const root = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(root, 'lib/three.min.js'));
require(path.join(root, 'tracks-data.js'));
require(path.join(root, 'js/track.js'));
let fails = 0;
function check(c, msg) { if (!c) { fails++; if (fails < 40) console.log('  FAIL', msg); } }
const only = process.argv[2];
for (const td of window.F1_TRACKS) {
  if (only && !td.id.includes(only) && !td.name.toLowerCase().includes(only)) continue;
  const t0 = Date.now();
  const tr = F1.buildTrack(td);
  const ms = Date.now() - t0;
  const S = tr.samples, N = S.length;
  // geometry
  let verts = 0, downTris = 0;
  check(tr.group.children.length <= 6, 'mesh count');
  for (const m of tr.group.children) {
    for (const k of Object.keys(m.geometry.attributes)) {
      const a = m.geometry.attributes[k].array;
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { check(false, td.id + ' NaN in ' + m.name + '.' + k); break; }
    }
    check(Number.isFinite(m.geometry.boundingSphere.radius), 'bsphere ' + m.name);
    const p = m.geometry.attributes.position.array; verts += p.length / 3;
    // walk real triangles: the ground mesh is indexed since the terrain was added (v3)
    const ix = m.geometry.index ? m.geometry.index.array : null, nI = ix ? ix.length : p.length / 3;
    if (m.name !== 'walls') for (let t = 0; t < nI; t += 3) {
      const i = (ix ? ix[t] : t) * 3, j = (ix ? ix[t + 1] : t + 1) * 3, k = (ix ? ix[t + 2] : t + 2) * 3;
      const ny = (p[j+2]-p[i+2])*(p[k]-p[i]) - (p[j]-p[i])*(p[k+2]-p[i+2]);
      if (ny < -1e-6) downTris++;
    }
  }
  // samples
  let minSp = 1e9, maxSp = 0, maxTurn = 0;
  for (let i = 0; i < N; i++) {
    const a = S[i], b = S[(i + 1) % N];
    const sp = Math.hypot(b.x - a.x, b.z - a.z); minSp = Math.min(minSp, sp); maxSp = Math.max(maxSp, sp);
    check(Math.abs(Math.hypot(a.tx, a.tz) - 1) < 1e-9 && Math.abs(Math.hypot(a.nx, a.nz) - 1) < 1e-9, 'unit');
    check(Math.abs(a.tx * a.nx + a.tz * a.nz) < 1e-9, 'perp');
    check((b.x - a.x) * a.tx + (b.z - a.z) * a.tz > 0, 'tangent direction');
    if (i) check(a.s > S[i - 1].s, 's monotonic');
    maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, a.tx * b.tx + a.tz * b.tz)));
  }
  check(S[0].s === 0, 's0'); check(minSp > 1.7 && maxSp < 2.3, td.id + ' spacing ' + minSp + ' ' + maxSp);
  check(Math.abs(tr.length - td.lengthKm * 1000) / (td.lengthKm * 1000) < 0.05, td.id + ' length ' + tr.length + ' vs ' + td.lengthKm);
  const d0 = Math.hypot(S[0].x - td.points[0][0], S[0].z - td.points[0][1]);
  check(d0 < 5, td.id + ' sample0 far from points[0]: ' + d0);
  // locate
  let maxErr = 0, idxMiss = 0;
  for (let i = 0; i < N; i += 3) {
    const a = S[i];
    for (const hint of [i, (i + 25) % N, (i - 25 + N) % N, -1]) {
      let r = tr.locate(a.x, a.z, hint);
      if (r.index !== i) idxMiss++;
      maxErr = Math.max(maxErr, Math.abs(r.d));
      for (const o of [5, -5]) {
        r = tr.locate(a.x + a.nx * o, a.z + a.nz * o, hint < 0 ? -1 : hint);
        if (hint >= 0) maxErr = Math.max(maxErr, Math.abs(r.d - o)); // global can legitimately hit another section
        else if (Math.abs(r.index - i) < 5) maxErr = Math.max(maxErr, Math.abs(r.d - o));
      }
    }
  }
  check(idxMiss === 0, td.id + ' locate index misses ' + idxMiss);
  check(maxErr < 0.15, td.id + ' locate d err ' + maxErr);
  // walls vs non-adjacent road
  let lostP = 0, lostN = 0, onRoad = 0, near = 0, minClear = 1e9;
  for (let i = 0; i < N; i++) {
    const a = S[i];
    if (!a.wallPos) lostP++; if (!a.wallNeg) lostN++;
    // per-sample wall offsets and road half widths (v3: close parallel roads share a pulled-in mid wall);
    // tr.wallDist / tr.halfWidth are only the nominal values
    for (const [flag, sg, wd] of [[a.wallPos, 1, a.wallPosDist ?? tr.wallDist], [a.wallNeg, -1, a.wallNegDist ?? tr.wallDist]]) {
      if (!flag) continue;
      const wx = a.x + a.nx * sg * wd, wz = a.z + a.nz * sg * wd;
      for (let j = 0; j < N; j++) {
        let sep = Math.abs(S[j].s - a.s); sep = Math.min(sep, tr.length - sep);
        if (sep <= 60) continue;
        const d = Math.hypot(S[j].x - wx, S[j].z - wz);
        if (d < minClear) minClear = d;
        const hw = S[j].halfW ?? tr.halfWidth;
        if (d < hw + 0.3) { onRoad++; break; }
        if (d < hw + 1.5) near++;
      }
    }
  }
  check(onRoad === 0, td.id + ' walls on road: ' + onRoad);
  // run lengths
  function runs(key, val) { let out = [], len = 0; const st = S.findIndex(s => s[key] !== val); if (st < 0) return out;
    for (let k = 1; k <= N; k++) { const i = (st + k) % N; if (S[i][key] === val) len++; else if (len) { out.push(len); len = 0; } } return out; }
  const frag = [...runs('wallPos', true), ...runs('wallNeg', true)].filter(l => l < 3).length;
  const holes = [...runs('wallPos', false), ...runs('wallNeg', false)].filter(l => l < 3).length;
  check(frag === 0, td.id + ' wall fragments ' + frag);
  check(downTris === 0, td.id + ' down-facing flat tris ' + downTris);
  tr.dispose(); check(tr.group.children.length === 0, 'dispose');
  console.log(`${td.id.padEnd(10)} ${td.name.slice(0,28).padEnd(28)} N=${String(N).padStart(4)} len=${tr.length.toFixed(0)} sp=${minSp.toFixed(2)}-${maxSp.toFixed(2)} maxTurn/2m=${(maxTurn*180/Math.PI).toFixed(1)}deg verts=${verts} build=${ms}ms noWall +n=${(100*lostP/N).toFixed(1)}% -n=${(100*lostN/N).toFixed(1)}% smallHoles=${holes} minClearNonAdj=${minClear.toFixed(1)} locErr=${maxErr.toFixed(3)}`);
}
console.log(fails ? 'FAILURES: ' + fails : 'ALL PASS');
