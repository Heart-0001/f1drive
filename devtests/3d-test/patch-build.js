const fs=require('fs');let s=fs.readFileSync(__dirname+'/build.js','utf8');
if(!s.includes('groundY vs mesh')){
s=s.replace("  check(buried === 0,", `  // groundY vs mesh, nearest vs brute force, inCorridor
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
  check(buried === 0,`);
s=s.replace("float: maxFloat.toFixed(1) });","float: maxFloat.toFixed(1), gY99: gP99.toFixed(3), gYmax: gMax.toFixed(2) });");
fs.writeFileSync(__dirname+'/build.js',s);}
