// node devtests/review-1/world/probe-all.js [id part]
// Per track: pit summary, elevation stats, wall gaps, groundY-vs-skirt mismatch near the pit complex, scenery stats.
const L = require('./load.js');
const F1 = L.F1, TRACKS = L.TRACKS, SC = L.SCENERY;
const filt = process.argv[2] || '';
const out = [];
for (const td of TRACKS) {
  if (filt && td.id.indexOf(filt) < 0 && td.name.indexOf(filt) < 0) continue;
  F1.PIT_DEBUG = [];
  const t0 = Date.now();
  const tr = F1.buildTrack(td);
  const tb = Date.now() - t0;
  const S = tr.samples, N = S.length, ds = tr.length / N;
  // elevation
  let ymin = Infinity, ymax = -Infinity, gmax = 0, bmax = 0, hwMin = 99;
  for (const s of S) { ymin = Math.min(ymin, s.y); ymax = Math.max(ymax, s.y); gmax = Math.max(gmax, Math.abs(s.grade)); bmax = Math.max(bmax, Math.abs(s.bank)); hwMin = Math.min(hwMin, s.halfW); }
  let emin = Infinity, emax = -Infinity;
  for (const e of td.elev || []) { emin = Math.min(emin, e); emax = Math.max(emax, e); }
  // wall gaps (runs of samples without wall on a side, excluding pit tapers)
  function gaps(side) {
    const r = []; let run = 0, start = -1;
    for (let i = 0; i < N; i++) {
      const has = side ? S[i].wallPos : S[i].wallNeg;
      if (!has) { if (run === 0) start = i; run++; } else if (run) { r.push([start, Math.round(run * ds)]); run = 0; }
    }
    if (run) r.push([start, Math.round(run * ds)]);
    return r;
  }
  const gP = gaps(1), gN = gaps(0);
  // pit
  const p = tr.pit;
  let pitInfo = 'NO PIT';
  if (p) {
    const rel = i => Math.round(((i > N / 2 ? i - N : i)) * ds);
    let bad = 0;
    for (const b of p.boxes) { if (![b.x, b.y, b.z, b.heading].every(Number.isFinite)) bad++; }
    // box on pit asphalt?
    let boxOff = 0;
    for (const b of p.boxes) { const n = tr.nearest(b.x, b.z); if (!p.paved(n.index, n.d)) boxOff++; }
    // groundY vs skirt mismatch beside garage face: sample every lane sample, lateral wallOuter+1..+16
    let mis = 0, misMax = 0;
    for (let k = 0; k <= L2(p); k += 5) {
      const i = (p.from + k) % N, s = S[i];
      const wo = (p.side > 0 ? s.wallPosDist : s.wallNegDist) + 0.5;
      for (let d = wo + 1; d < wo + 18; d += 3) {
        const x = s.x + s.nx * p.side * d, z = s.z + s.nz * p.side * d;
        const g = tr.groundY(x, z), t = tr.terrainY(x, z);
        const dif = Math.abs(g - (s.y + p.side * d * Math.tan(s.bank)));
        if (Math.abs(g - t) < 1e-6 && d < wo + 6) { mis++; misMax = Math.max(misMax, Math.abs(s.y - t)); }
      }
    }
    pitInfo = `side ${p.side} lim ${p.limitKmh} from ${rel(p.from)} entry ${rel(p.entry)} exit ${rel(p.exit)} to ${rel(p.to)} len ${Math.round(p.length)} laneHW ${p.laneHalfW} boxW ${p.boxW.toFixed(1)} badBoxes ${bad} boxesOffAsphalt ${boxOff} skirtEarlyOut ${mis}/${misMax.toFixed(2)}`;
  }
  function L2(p) { return ((p.to - p.from) % N + N) % N; }
  // scenery
  let scInfo = '';
  try {
    const t1 = Date.now();
    const sc = F1.buildScenery(tr, td, SC[td.id]);
    const c = sc.stats.counts;
    scInfo = `sc ${Date.now() - t1}ms tris ${sc.stats.triangles} b ${c.buildings} st ${c.stands} drop ${c.dropped} fit ${c.fitted} pitBlocks ${c.pitBlocks} trees ${c.trees}`;
    sc.dispose();
  } catch (e) { scInfo = 'SCENERY THROWS: ' + e.message; }
  const line = `${td.id.padEnd(8)} N ${N} build ${tb}ms | elev data ${(emax - emin).toFixed(1)} built ${(ymax - ymin).toFixed(1)} grade ${(gmax * 100).toFixed(1)}% bank ${(bmax * 180 / Math.PI).toFixed(1)}deg hwMin ${hwMin.toFixed(1)}\n   gapsPos ${JSON.stringify(gP)} gapsNeg ${JSON.stringify(gN)}\n   pit: ${pitInfo}\n   ${scInfo}` +
    (p ? '' : '\n   PIT_DEBUG: ' + F1.PIT_DEBUG.slice(0, 6).join(' | '));
  console.log(line);
  tr.dispose();
}
