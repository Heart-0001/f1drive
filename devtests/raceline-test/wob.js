const path = require('path');const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));require(path.join(ROOT, 'js/track.js'));require(path.join(ROOT, 'js/car.js'));require(process.argv[3] || path.join(ROOT, 'js/raceline.js'));
const verbose = process.argv[2];
let tot = 0, totC = 0;
for (const td of F1_TRACKS) {
  const tr = F1.buildTrack(td), l = F1.buildRaceLine(tr), P = l.points, S = tr.samples, N = P.length;
  // heading of line per segment, curvature lobes
  const hd = [], sg = [];
  for (let i = 0; i < N; i++) { const q = P[(i + 1) % N]; hd.push(Math.atan2(q.x - P[i].x, q.z - P[i].z)); sg.push(Math.hypot(q.x - P[i].x, q.z - P[i].z)); }
  const dth = []; for (let i = 0; i < N; i++) { let a = hd[i] - hd[(i - 1 + N) % N]; while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; dth.push(a); }
  // smooth dth over 5 samples to ignore 2 m jitter
  const sm = dth.map((_, i) => { let s = 0; for (let k = -2; k <= 2; k++) s += dth[(i + k + N) % N]; return s / 5; });
  // lobes
  const lobes = []; let start = 0, acc = 0, len = 0, sign = Math.sign(sm[0]) || 1;
  for (let i = 0; i < N; i++) { const s = Math.sign(sm[i]) || sign; if (s !== sign) { lobes.push({ start, len, ang: acc }); start = i; acc = 0; len = 0; sign = s; } acc += sm[i]; len += sg[i]; }
  lobes.push({ start, len, ang: acc });
  // wobble = lobe with small turning angle (not a corner) but non-trivial; lateral amplitude ~ ang*len/8
  const wob = lobes.filter(o => Math.abs(o.ang) < 0.06 && Math.abs(o.ang) * o.len / 8 > 0.03 && o.len < 160);
  // centreline same measure for reference
  tot += wob.length; 
  // jitter: rms of (dth - sm) in rad per sample -> high-frequency zigzag
  let j2 = 0, jmax = 0; for (let i = 0; i < N; i++) { const e = dth[i] - sm[i]; j2 += e * e; jmax = Math.max(jmax, Math.abs(e)); }
  if (verbose === 'all' || new RegExp(verbose || 'Monza', 'i').test(td.name)) {
    console.log(td.name, 'lobes', lobes.length, 'wobble lobes', wob.length, 'hf jitter rms mrad', (Math.sqrt(j2 / N) * 1e3).toFixed(2), 'max', (jmax * 1e3).toFixed(1));
    if (verbose !== 'all') console.log(wob.map(o => o.start + ': len ' + o.len.toFixed(0) + 'm ang ' + (o.ang * 57.3).toFixed(2) + 'deg amp ' + (Math.abs(o.ang) * o.len / 8).toFixed(2) + 'm  d=' + P[o.start].d.toFixed(2) + ' kc=' + (1 / ((S[(o.start + 5) % N].tx - S[o.start].tx) * S[o.start].nx + (S[(o.start + 5) % N].tz - S[o.start].tz) * S[o.start].nz) * 10).toFixed(0)).join('\n'));
  }
}
console.log('total wobble lobes all tracks', tot);
