// node xsec.mjs <id> <osmS,osmS,...> [half=12] [step=1] -> lidar cross-sections (left = +) at OSM arc lengths
// prints height relative to the centre and the best-fit slope (deg) over the central +-w m for w = 3, 5, 7
import { osmLoop } from './osmline.mjs';
import { osm, pointAt } from './lib.mjs';
import * as DEM from './dem.mjs';
import { CFG } from './config.mjs';
const [id, list, halfA, stepA] = process.argv.slice(2);
const cfg = CFG[id], J = osm(id);
let only = cfg.only || null;
const rel = cfg.rel ? J.elements.find((e) => e.type === 'relation' && e.id === cfg.rel) : null;
if (rel && !only) only = rel.members.filter((m) => m.type === 'way' && !/pit/.test(m.role)).map((m) => m.ref);
const O = osmLoop(id, { first: cfg.first, rev: !!cfg.rev, only, exclude: cfg.exclude, extra: cfg.extra });
const half = +(halfA || 12), step = +(stepA || 1);
for (const s of list.split(',').map(Number)) {
  const p = pointAt(O.xy, O.cum, s), a = pointAt(O.xy, O.cum, s - 3), b = pointAt(O.xy, O.cum, s + 3);
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]), tx = (b[0] - a[0]) / l, ty = (b[1] - a[1]) / l;
  const offs = []; for (let o = -half; o <= half + 1e-9; o += step) offs.push(+o.toFixed(2));
  const ll = offs.map((o) => O.P.inv(p[0] - ty * o, p[1] + tx * o));
  const h = await DEM[cfg.dem](ll);
  const c = h[offs.indexOf(0)];
  const fit = (w) => { let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0; offs.forEach((o, i) => { if (Math.abs(o) <= w && Number.isFinite(h[i])) { sx += o; sy += h[i]; sxx += o * o; sxy += o * h[i]; n++; } }); const k = (n * sxy - sx * sy) / (n * sxx - sx * sx); return +(Math.atan(k) * 180 / Math.PI).toFixed(1); };
  console.log(`s=${s} centre ${c && c.toFixed(2)} m  fit(+-3/5/7/10) ${fit(3)} ${fit(5)} ${fit(7)} ${fit(10)} deg (+ = left higher)`);
  console.log('   ' + offs.map((o, i) => `${o}:${Number.isFinite(h[i]) ? (h[i] - c).toFixed(2) : 'na'}`).join(' '));
}
