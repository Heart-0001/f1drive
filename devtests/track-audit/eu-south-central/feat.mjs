// node feat.mjs <id> <ref> <a-b:label> ... : height change and steepest 100 m grades of the game vs a reference over s ranges
import { readFileSync } from 'node:fs';
const [id, ref, ...segs] = process.argv.slice(2);
const e = JSON.parse(readFileSync(new URL(`./out/elev-${id}.json`, import.meta.url)));
const R = e.stations10m, ci = R.columns, col = (n) => R.rows.map((r) => r[ci.indexOf(n)]);
const s = col('s'), G = col('game'), B = col(ref), n = s.length;
const g = (a, i, k) => (a[(i + k) % n] - a[(i - k + n) % n]) / (2 * k * 10);
for (const sg of segs) {
  const [ab, lab] = sg.split(':'), [a, b] = ab.split('-').map(Number);
  let gm = [-1e9, 0], rm = [-1e9, 0], gn = [1e9, 0], rn = [1e9, 0];
  const idx = []; for (let i = 0; i < n; i++) if (a <= b ? s[i] >= a && s[i] <= b : s[i] >= a || s[i] <= b) idx.push(i);
  for (const i of idx) { const gg = g(G, i, 5), rr = g(B, i, 5); if (gg > gm[0]) gm = [gg, s[i]]; if (rr > rm[0]) rm = [rr, s[i]]; if (gg < gn[0]) gn = [gg, s[i]]; if (rr < rn[0]) rn = [rr, s[i]]; }
  const ia = idx[0], ib = idx[idx.length - 1];
  console.log(`${lab} ${a}-${b}: game dh ${(G[ib] - G[ia]).toFixed(1)} m, ${ref} dh ${(B[ib] - B[ia]).toFixed(1)} m; game grade100 max ${(gm[0] * 100).toFixed(1)}%@${gm[1]} min ${(gn[0] * 100).toFixed(1)}%@${gn[1]}; ${ref} max ${(rm[0] * 100).toFixed(1)}%@${rm[1]} min ${(rn[0] * 100).toFixed(1)}%@${rn[1]}`);
}
