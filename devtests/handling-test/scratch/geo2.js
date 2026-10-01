const L = require('../lib.js');
const F1 = L.load();
const tr = L.track(F1, 'mc-1929'), S = tr.samples, N = S.length;
const line = F1.buildRaceLine(tr), P = line.points;
function circ(a, b, c) { const ax = b.x - a.x, az = b.z - a.z, bx = c.x - a.x, bz = c.z - a.z, cr = ax * bz - az * bx; return Math.abs(cr) < 1e-9 ? Infinity : Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(c.x - b.x, c.z - b.z) / (2 * cr); }
for (let i = 620; i <= 650; i += 2) {
  const rc = circ(S[i-2], S[i], S[i+2]), rl = circ(P[i-2], P[i], P[i+2]);
  // inner edge
  const E = k => ({ x: S[k].x + S[k].nx * S[k].halfW, z: S[k].z + S[k].nz * S[k].halfW });
  const O = k => ({ x: S[k].x - S[k].nx * S[k].halfW, z: S[k].z - S[k].nz * S[k].halfW });
  console.log(i, 'Rcentre', rc.toFixed(1).padStart(7), 'Rline', rl.toFixed(1).padStart(7), 'R+edge', circ(E(i-2),E(i),E(i+2)).toFixed(1).padStart(7), 'R-edge', circ(O(i-2),O(i),O(i+2)).toFixed(1).padStart(7), 'd', P[i].d.toFixed(2), 'n', S[i].nx.toFixed(2), S[i].nz.toFixed(2), 't', S[i].tx.toFixed(2), S[i].tz.toFixed(2));
}
