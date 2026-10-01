// Shared helpers of the "east" circuit audit (pt-1972, pt-2008, tr-2005, ru-2014, az-2016). Read-only on the game files:
// the game side comes from out/game-<id>.json (dump-game.js: the game's own js/track.js build of tracks-data.js).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..', '..');
export const EAST = HERE;
export const IDS = ['pt-1972', 'pt-2008', 'tr-2005', 'ru-2014', 'az-2016'];
export const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;

export function game(id) { return JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8')); }
export function readJSON(p) { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; }

// local true-metre projection (equirectangular about lat0 / lon0; < 0.1 % error over a circuit)
export function projector(lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), kz = 110574;
  return { f: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * kz], inv: (x, y) => [lat0 + y / kz, lon0 + x / kx], kx, kz };
}
export function loopLength(P) { let L = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); } return L; }
export function cumLoop(P) { const n = P.length, c = [0]; for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; c.push(c[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); } return c; }
// uniform resampling of a closed polyline every ~step metres -> {pts, s, total, ds}
export function resampleLoop(P, step) {
  const n = P.length, cum = cumLoop(P);
  const total = cum[n], m = Math.max(8, Math.round(total / step)), ds = total / m, out = [], s = [];
  for (let k = 0, i = 0; k < m; k++) {
    const t0 = k * ds;
    while (i < n - 1 && cum[i + 1] <= t0) i++;
    const a = P[i], b = P[(i + 1) % n], t = (t0 - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    out.push(a.map((v, c) => v + (b[c] - v) * t)); s.push(t0);
  }
  return { pts: out, s, total, ds };
}
// nearest point of a closed polyline (segments) to (x, y): {d, s (arc length), i (segment), t, side (+1 = left of the direction)}
export function nearestOnLoop(P, x, y, cum) {
  cum = cum || cumLoop(P);
  let best = { d: Infinity };
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
    const px = a[0] + ex * t, py = a[1] + ey * t, d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, s: cum[i] + t * Math.sqrt(l2), i, t, side: Math.sign(ex * (y - a[1]) - ey * (x - a[0])) || 0 };
  }
  return best;
}
// nearest distance from (x, y) to a set of open polylines [[x, y], ...]
export function distToLines(lines, x, y) {
  let best = { d: Infinity };
  for (let w = 0; w < lines.length; w++) {
    const L = lines[w];
    for (let i = 0; i + 1 < L.length; i++) {
      const a = L[i], b = L[i + 1], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / l2)) : 0;
      const d = Math.hypot(a[0] + ex * t - x, a[1] + ey * t - y);
      if (d < best.d) best = { d, w, i, t };
    }
  }
  return best;
}
export function signedArea(P) { let A = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; A += a[0] * b[1] - b[0] * a[1]; } return A / 2; }

// ---- 1D filters on a closed loop
export function medianLoop(h, half) {
  const m = h.length, w = [];
  return h.map((_, i) => { w.length = 0; for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
}
export function gaussLoop(h, sigma) {
  if (!(sigma > 0)) return h.slice();
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = []; let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let acc = 0; for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m]; return acc / sum; });
}
export function minLoop(h, half) { const m = h.length; return h.map((_, i) => { let v = Infinity; for (let j = -half; j <= half; j++) v = Math.min(v, h[((i + j) % m + m) % m]); return v; }); }
export function fillNull(raw) {
  const m = raw.length, ok = raw.map((v) => v !== null && Number.isFinite(v)), h = raw.slice();
  if (!ok.some(Boolean)) return h;
  for (let i = 0; i < m; i++) {
    if (ok[i]) continue;
    let a = i, b = i, da = 0, db = 0;
    while (!ok[a]) { a = (a - 1 + m) % m; da++; }
    while (!ok[b]) { b = (b + 1) % m; db++; }
    h[i] = raw[a] + (raw[b] - raw[a]) * da / (da + db);
  }
  return h;
}
// steepest climb / descent over a window of `win` metres on a uniform closed profile (ds metres apart)
export function gradeWindows(h, ds, win, sAt, llAt) {
  const m = h.length, k = Math.max(1, Math.round(win / ds));
  let up = { g: -Infinity }, dn = { g: Infinity };
  for (let i = 0; i < m; i++) {
    const g = (h[(i + k) % m] - h[i]) / (k * ds);
    if (g > up.g) up = { g, i }; if (g < dn.g) dn = { g, i };
  }
  const fmt = (o) => ({ pct: r1(o.g * 100), fromS: Math.round(sAt(o.i)), toS: Math.round(sAt((o.i + k) % m)), at: llAt ? llAt((o.i + Math.round(k / 2)) % m) : undefined });
  return { windowM: Math.round(k * ds), climb: fmt(up), descent: fmt(dn) };
}
// every local stretch whose grade over `win` m exceeds `thr` (|g|), merged -> list
export function steepStretches(h, ds, win, thr, sAt) {
  const m = h.length, k = Math.max(1, Math.round(win / ds)), out = [];
  let cur = null;
  for (let i = 0; i < m; i++) {
    const g = (h[(i + k) % m] - h[i]) / (k * ds);
    if (Math.abs(g) >= thr) {
      if (cur && Math.sign(g) === cur.sign && i - cur.last <= 1) { cur.last = i; if (Math.abs(g) > Math.abs(cur.g)) cur.g = g; }
      else { if (cur) out.push(cur); cur = { sign: Math.sign(g), first: i, last: i, g }; }
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ fromS: Math.round(sAt(c.first)), toS: Math.round(sAt((c.last + k) % m)), maxPct: r1(c.g * 100) }));
}
export function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
}
export const range = (a) => Math.max(...a) - Math.min(...a);
