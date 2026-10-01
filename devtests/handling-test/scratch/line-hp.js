const L = require('../lib.js');
const F1 = L.load(L.variant(process.argv[2] || 'proposed'));
const tr = L.track(F1, 'mc-1929'), S = tr.samples, N = S.length;
const line = F1.buildRaceLine(tr), P = line.points;
for (let i = 612; i <= 660; i++) {
  const p = P[i], s = S[i];
  console.log(i, 'd', p.d.toFixed(2).padStart(6), 'hw', s.halfW.toFixed(1), 'R', (1/Math.abs(p.curvature)).toFixed(1).padStart(6), 'v', (p.speed*3.6).toFixed(1).padStart(6), 'lim', (p.limit*3.6).toFixed(1).padStart(6));
}
// all tracks: points where the line radius < 15 m
const out = [];
for (const td of F1.TRACKS) {
  const t = L.track(F1, td.id), ln = F1.buildRaceLine(t);
  let n = 0, rmin = 1e9, at = -1;
  for (const p of ln.points) { const r = 1 / Math.abs(p.curvature); if (r < 15) n++; if (r < rmin) { rmin = r; at = p.sampleIndex; } }
  if (rmin < 25) out.push(`${td.id} minR ${rmin.toFixed(1)} at ${at} (${n} pts < 15 m) lap ${ln.lapTime.toFixed(2)}`);
}
console.log(out.join('\n'));
