// node devtests/track-audit/apac/gameprof.mjs -- the game's built height profile (out/game-<id>.json samples): range, where the high
// and low points are, steepest climbs / descents over 50 m and 100 m windows, and bank statistics.
import { resolve } from 'node:path';
import { IDS, HERE, readJSON } from './common.mjs';
export function profStats(h, ds) {
  const m = h.length, res = { range: Math.max(...h) - Math.min(...h) };
  let imax = 0, imin = 0; h.forEach((v, i) => { if (v > h[imax]) imax = i; if (v < h[imin]) imin = i; });
  res.highAt = imax * ds; res.lowAt = imin * ds; res.high = h[imax]; res.low = h[imin];
  for (const w of [50, 100]) {
    const k = Math.max(1, Math.round(w / ds)); let up = -Infinity, dn = Infinity, iu = 0, id = 0;
    for (let i = 0; i < m; i++) { const g = (h[(i + k) % m] - h[i]) / (k * ds); if (g > up) { up = g; iu = i; } if (g < dn) { dn = g; id = i; } }
    res['climb' + w] = { pct: +(up * 100).toFixed(2), fromS: Math.round(iu * ds) }; res['descent' + w] = { pct: +(dn * 100).toFixed(2), fromS: Math.round(id * ds) };
  }
  return res;
}
if (process.argv[1] && process.argv[1].endsWith('gameprof.mjs')) {
  for (const id of IDS) {
    const g = readJSON(resolve(HERE, 'out', 'game-' + id + '.json'));
    const h = g.samples.map((s) => s.y), st = profStats(h, g.ds);
    const banks = g.samples.map((s) => Math.abs(s.bank));
    console.log(id, 'range', st.range.toFixed(2), 'high', st.highAt.toFixed(0), 'low', st.lowAt.toFixed(0), 'climb50', JSON.stringify(st.climb50), 'desc50', JSON.stringify(st.descent50), 'climb100', JSON.stringify(st.climb100), 'desc100', JSON.stringify(st.descent100), 'max|bank|', Math.max(...banks).toFixed(2), 'deg; >3deg over', (banks.filter((b) => b > 3).length * g.ds).toFixed(0), 'm');
  }
}
