// node devtests/track-audit/east/stretch-cmp.mjs <id> [winM=100] [thr=0.05]
// Every stretch where the cleaned GLO-30 profile along the OSM loop is steeper than thr over winM, with the game's grade
// over the same window (same places: game heights are taken at the nearest game sample). s = true metres along the
// OSM loop from the foot of the game start line; gameS = the game's own s there.
import { resolve } from 'node:path';
import { EAST, r1 } from './core.mjs';
import { elevOsm } from './elev-osm.mjs';
export async function stretchCmp(id, win = 100, thr = 0.05, key = 'glo30') {
  const o = await elevOsm(id), P = o._P, h = o._series[key], y = o._series.game, m = h.length, k = Math.round(win / P.ds);
  if (!h) return [];
  const g = (arr, i) => (arr[(i + k) % m] - arr[i]) / (k * P.ds);
  const out = []; let cur = null;
  for (let i = 0; i < m; i++) {
    const gd = g(h, i);
    if (Math.abs(gd) >= thr) {
      if (cur && Math.sign(gd) === cur.sg && i - cur.b <= 1) { cur.b = i; if (Math.abs(gd) > Math.abs(cur.g)) { cur.g = gd; cur.i = i; } }
      else { if (cur) out.push(cur); cur = { sg: Math.sign(gd), a: i, b: i, g: gd, i }; }
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ fromS: Math.round(P.s[c.a]), toS: Math.round(P.s[(c.b + k) % m]), at: [+P.lat[c.i].toFixed(6), +P.lon[c.i].toFixed(6)], demPct: r1(c.g * 100), gamePct: r1(g(y, c.i) * 100),
    gameMaxPctInStretch: r1(Math.max(...Array.from({ length: c.b - c.a + 1 }, (_, j) => c.sg * g(y, c.a + j))) * 100 * c.sg) }));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(EAST, 'stretch-cmp.mjs')) {
  const [id, w, t, key] = process.argv.slice(2);
  for (const r of await stretchCmp(id, +(w || 100), +(t || 0.05), key || 'glo30')) console.log(JSON.stringify(r));
}
