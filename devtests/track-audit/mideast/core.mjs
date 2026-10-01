// Shared helpers of the Middle-East circuit audit (bh-2002, sa-2021, qa-2004, ae-2009). Read-only on the game files.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- game data
let TRACKS = null, SCENERY = null, THREE = null;
export function gameTracks() {
  if (!TRACKS) {
    const w = {};
    vm.runInNewContext(readFileSync(resolve(ROOT, 'tracks-data.js'), 'utf8'), { window: w });
    TRACKS = w.F1_TRACKS;
  }
  return TRACKS;
}
export function gameTrack(id) { return gameTracks().find((t) => t.id === id); }
// Builds the track exactly as the game does (lib/three.min.js + js/track.js, with scenery-data.js for the pit side).
export function buildGame(td) {
  if (!THREE) THREE = require(resolve(ROOT, 'lib', 'three.min.js'));
  if (!SCENERY) { const w = {}; vm.runInNewContext(readFileSync(resolve(ROOT, 'scenery-data.js'), 'utf8'), { window: w }); SCENERY = w.F1_SCENERY; }
  const win = { THREE, F1_SCENERY: SCENERY };
  vm.runInContext(readFileSync(resolve(ROOT, 'js', 'track.js'), 'utf8'), vm.createContext({ window: win, console }), { filename: 'js/track.js' });
  return win.F1.buildTrack(td);
}
export const toLatLon = (g, x, z) => [g.lat0 + z / g.kz, g.lon0 + x / g.kx];

// ---------------------------------------------------------------- local true-metre projection
export function projector(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), kz = 110574;
  return { f: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * kz], inv: (x, y) => [lat0 + y / kz, lon0 + x / kx], kx, kz };
}
// Uniform resampling of a closed polyline [[x, y], ...] every `step` metres -> {pts, s[], total}
export function resampleLoop(P, step) {
  const n = P.length, cum = [0];
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const total = cum[n], m = Math.max(8, Math.round(total / step)), ds = total / m, out = [], s = [];
  for (let k = 0, i = 0; k < m; k++) {
    const t0 = k * ds;
    while (i < n - 1 && cum[i + 1] <= t0) i++;
    const a = P[i], b = P[(i + 1) % n], t = (t0 - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    out.push(a.map((v, c) => v + (b[c] - v) * t)); s.push(t0);
  }
  return { pts: out, s, total, ds };
}
export function loopLength(P) { let L = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); } return L; }
// nearest point on a closed polyline: {d, s (arc length of the foot), i, t}
export function nearestOnLoop(P, x, y, cum) {
  const n = P.length;
  if (!cum) { cum = [0]; for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); } }
  let best = Infinity, bs = 0, bi = 0, bt = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y);
    if (d < best) { best = d; bs = cum[i] + t * (cum[i + 1] - cum[i]); bi = i; bt = t; }
  }
  return { d: best, s: bs, i: bi, t: bt, cum };
}
export function signedArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

// ---------------------------------------------------------------- OSM
// Chains the given ways (any order / orientation) into one closed loop of [lat, lon], oriented along the ways' own
// direction (oneway=yes raceway ways are drawn in the racing direction). Returns {ll, nodes, wayOrder}.
export function chainWays(elements, wayIds) {
  const ways = wayIds.map((id) => elements.find((e) => e.type === 'way' && e.id === id));
  if (ways.some((w) => !w)) throw new Error('missing way in OSM data: ' + wayIds.filter((id, i) => !ways[i]).join(','));
  const used = new Set([0]), order = [ways[0].id];
  let nodes = ways[0].nodes.slice(), geom = ways[0].geometry.map((g) => [g.lat, g.lon]), reversed = 0;
  while (used.size < ways.length) {
    const end = nodes[nodes.length - 1];
    let k = ways.findIndex((w, i) => !used.has(i) && w.nodes[0] === end);
    let rev = false;
    if (k < 0) { k = ways.findIndex((w, i) => !used.has(i) && w.nodes[w.nodes.length - 1] === end); rev = true; }
    if (k < 0) throw new Error('chain broken after way ' + order[order.length - 1]);
    used.add(k); order.push(ways[k].id + (rev ? 'r' : ''));
    if (rev) reversed++;
    const wn = rev ? ways[k].nodes.slice().reverse() : ways[k].nodes, wg = (rev ? ways[k].geometry.slice().reverse() : ways[k].geometry).map((g) => [g.lat, g.lon]);
    nodes = nodes.concat(wn.slice(1)); geom = geom.concat(wg.slice(1));
  }
  if (nodes[0] !== nodes[nodes.length - 1]) throw new Error('loop not closed');
  nodes.pop(); geom.pop();
  return { ll: geom, nodes, wayOrder: order, reversedWays: reversed };
}

// ---------------------------------------------------------------- profiles
export function gradeWindows(s, h, total, win) {        // max climb / descent over a window of `win` metres (closed loop)
  const n = s.length, ds = total / n, k = Math.max(1, Math.round(win / ds));
  let up = { g: -Infinity }, dn = { g: Infinity };
  for (let i = 0; i < n; i++) {
    const g = (h[(i + k) % n] - h[i]) / (k * ds);
    if (g > up.g) up = { g, from: s[i], to: (s[i] + k * ds) % total };
    if (g < dn.g) dn = { g, from: s[i], to: (s[i] + k * ds) % total };
  }
  return { maxClimbPct: +(up.g * 100).toFixed(2), climbAt: [Math.round(up.from), Math.round(up.to)], maxDescentPct: +(-dn.g * 100).toFixed(2), descentAt: [Math.round(dn.from), Math.round(dn.to)] };
}
export function medianLoop(h, half) {
  const m = h.length;
  return h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
}
export function gaussLoop(h, sigma) {
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = []; let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) a += k[j + r] * h[((i + j) % m + m) % m]; return a / sum; });
}
export function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
export const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
