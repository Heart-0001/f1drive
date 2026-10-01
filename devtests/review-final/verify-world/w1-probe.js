// W1 probe: where is points[0] of mc-1929 and where is the real start line?
global.window = {};
require('../../../tracks-data.js');
const T = window.F1_TRACKS;
const t = T.find(x => x.id === 'mc-1929');
console.log(Object.keys(t));
const g = t.geo;
const toLL = (p) => [p[1] / g.kz + g.lat0, p[0] / g.kx + g.lon0];
const P = t.points, E = t.elev;
let s = 0, cum = [0];
for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += Math.hypot(b[0]-a[0], b[1]-a[1]); cum.push(s); }
console.log('n', P.length, 'len', s.toFixed(0), 'p0', toLL(P[0]), 'elev0', E[0], 'range', Math.min(...E), Math.max(...E));
// nearest vertex to real start line 43.73472, 7.42054
function nearest(lat, lon) {
  const x = (lon - g.lon0) * g.kx, z = (lat - g.lat0) * g.kz;
  let bi = 0, bd = 1e9;
  P.forEach((p, i) => { const d = Math.hypot(p[0]-x, p[1]-z); if (d < bd) { bd = d; bi = i; } });
  return { i: bi, d: bd.toFixed(1), s: cum[bi].toFixed(0), elev: E[bi] };
}
console.log('real line 43.73472,7.42054 ->', nearest(43.73472, 7.42054));
console.log('casino 43.7394,7.4272 ->', nearest(43.7394, 7.4272));
console.log('Ste Devote 43.7364,7.4213 ->', nearest(43.7364, 7.4213));
console.log('Anthony Noghes 43.7341,7.4215 ->', nearest(43.7341, 7.4215));
// profile every ~100m
for (let i = 0; i < P.length; i++) if (i % 4 === 0 || i < 5 || i > P.length - 5) console.log(i, cum[i].toFixed(0), toLL(P[i]).map(v => v.toFixed(5)).join(','), E[i]);
