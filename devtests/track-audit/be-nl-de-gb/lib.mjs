// Shared helpers for the be-nl-de-gb track audit (Spa, Zandvoort, Hockenheim, Nurburgring GP, Silverstone).
// Read-only with respect to the game: it only reads out/game-<id>.json (written by dump-game.js from the game's own
// tracks-data.js + js/track.js) and the cached OpenStreetMap / DEM responses under ../cache/.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE = resolve(HERE, '..', 'cache');
export const UA = 'F1Drive track audit (devtests; cached one-off requests; github.com/Heart-0001/f1drive)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const D2R = Math.PI / 180;

export function readJSON(p) { return JSON.parse(readFileSync(p, 'utf8')); }
export function writeJSON(p, v, pretty) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, pretty ? 1 : 0)); }
export function game(id) { return readJSON(resolve(HERE, 'out', `game-${id}.json`)); }
export function osm(id) { return readJSON(resolve(CACHE, 'overpass', `${id}.json`)); }

// local metric projection around (lat0, lon0): x east, y north (m)
export function proj(lat0, lon0) {
  const ky = 111132.92 - 559.82 * Math.cos(2 * lat0 * D2R) + 1.175 * Math.cos(4 * lat0 * D2R);
  const kx = 111412.84 * Math.cos(lat0 * D2R) - 93.5 * Math.cos(3 * lat0 * D2R);
  return { fwd: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky], inv: (x, y) => [lat0 + y / ky, lon0 + x / kx], kx, ky };
}

// closed polyline [[x, y]] -> cumulative arc length
export function cumLen(P, closed = true) {
  const c = [0];
  const n = P.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) { const a = P[i], b = P[(i + 1) % n]; c.push(c[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  return c;
}
// nearest point on closed polyline P (with cum c) to q: {d, s, i, t, side} (side > 0 = q left of the direction)
export function nearestOn(P, c, q, closed = true) {
  let best = { d: Infinity };
  const n = P.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = P[i], b = P[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / l2)) : 0;
    const fx = a[0] + ex * t, fy = a[1] + ey * t, d = Math.hypot(q[0] - fx, q[1] - fy);
    if (d < best.d) best = { d, s: c[i] + t * Math.sqrt(l2), i, t, side: Math.sign(ex * (q[1] - a[1]) - ey * (q[0] - a[0])), tx: ex / Math.sqrt(l2 || 1), ty: ey / Math.sqrt(l2 || 1) };
  }
  return best;
}
// point at arc length s on closed polyline
export function pointAt(P, c, s) {
  const L = c[c.length - 1];
  s = ((s % L) + L) % L;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
  const a = P[lo], b = P[(lo + 1) % P.length], t = (s - c[lo]) / ((c[lo + 1] - c[lo]) || 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
export function resample(P, step, closed = true) {
  const c = cumLen(P, closed), L = c[c.length - 1], n = Math.max(8, Math.round(L / step)), ds = L / n, out = [];
  for (let k = 0; k < (closed ? n : n + 1); k++) out.push(pointAt(P, c, k * ds));
  return { pts: out, ds, L };
}

// Chain OSM ways (with .geometry [{lat, lon}] and .tags) into one closed loop. Starts from `first` (way id) in its
// stored direction (or reversed if `reverseFirst`), then repeatedly appends the unused way that starts (or, if not
// oneway, ends) at the current end node position. Returns {ll: [[lat, lon]], ways: [{id, name, from, to}], closed, gap}.
export function chain(ways, first, reverseFirst = false) {
  const key = (p) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
  const used = new Set([first]);
  const w0 = ways.find((w) => w.id === first);
  let g = w0.geometry.slice(); if (reverseFirst) g.reverse();
  const ll = g.map((p) => [p.lat, p.lon]), list = [{ id: w0.id, name: w0.tags.name || '', from: 0, to: ll.length - 1, rev: reverseFirst }];
  const startKey = key(g[0]);
  for (let guard = 0; guard < 500; guard++) {
    const endK = key(g[g.length - 1]);
    if (endK === startKey && list.length > 1) return { ll: ll.slice(0, -1), ways: list, closed: true, gap: 0 };
    let next = null, rev = false;
    for (const w of ways) {
      if (used.has(w.id)) continue;
      if (key(w.geometry[0]) === endK) { next = w; rev = false; break; }
    }
    if (!next) for (const w of ways) {
      if (used.has(w.id) || w.tags.oneway === 'yes') continue;
      if (key(w.geometry[w.geometry.length - 1]) === endK) { next = w; rev = true; break; }
    }
    if (!next) {
      const a = g[g.length - 1], b = ll[0];
      return { ll, ways: list, closed: false, gap: Math.hypot((a.lat - b[0]) * 111000, (a.lon - b[1]) * 111000 * Math.cos(a.lat * D2R)) };
    }
    used.add(next.id);
    g = next.geometry.slice(); if (rev) g.reverse();
    const from = ll.length - 1;
    for (let k = 1; k < g.length; k++) ll.push([g[k].lat, g[k].lon]);
    list.push({ id: next.id, name: next.tags.name || '', from, to: ll.length - 1, rev });
  }
  throw new Error('chain: too many ways');
}

// Windowed grades (rise / run over `w` metres, centred) on a closed uniform profile h with spacing ds.
export function grades(h, ds, w) {
  const n = h.length, k = Math.max(1, Math.round(w / ds)), out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (h[(i + Math.ceil(k / 2)) % n] - h[(i - Math.floor(k / 2) + n) % n]) / (k * ds);
  return out;
}
export function extremes(arr, ds, count = 3, sep = 150) {      // top `count` local max and min (separated by sep m)
  const n = arr.length, idx = [...arr.keys()];
  const pick = (cmp) => {
    const sorted = idx.slice().sort((a, b) => cmp(arr[a], arr[b])), out = [];
    for (const i of sorted) {
      if (out.every((j) => Math.min(Math.abs(i - j), n - Math.abs(i - j)) * ds >= sep)) out.push(i);
      if (out.length >= count) break;
    }
    return out.map((i) => ({ s: +(i * ds).toFixed(0), v: +arr[i].toFixed(4) }));
  };
  return { max: pick((a, b) => b - a), min: pick((a, b) => a - b) };
}
export function medianLoop(h, half) {
  const m = h.length, out = new Float64Array(m), w = [];
  for (let i = 0; i < m; i++) {
    w.length = 0;
    for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]);
    w.sort((a, b) => a - b); out[i] = w[half];
  }
  return out;
}
export function gaussLoop(h, sigma) {
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return Float64Array.from(h, (_, i) => { let acc = 0; for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m]; return acc / sum; });
}
export function fillNulls(raw) {
  const m = raw.length, ok = raw.map((v) => v !== null && Number.isFinite(v)), h = raw.slice();
  for (let i = 0; i < m; i++) {
    if (ok[i]) continue;
    let a = i, b = i, da = 0, db = 0;
    while (!ok[a] && da < m) { a = (a - 1 + m) % m; da++; }
    while (!ok[b] && db < m) { b = (b + 1) % m; db++; }
    h[i] = raw[a] + (raw[b] - raw[a]) * da / (da + db);
  }
  return h;
}

// ---------------------------------------------------------------- UTM (ETRS89 / WGS84, Krueger series)
export function toUTM(lat, lon, zone) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, E0 = 500000;
  const n = f / (2 - f), A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
  const phi = lat * D2R, lam = (lon - (zone * 6 - 183)) * D2R;
  const e = Math.sqrt(f * (2 - f));
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 3; j++) { x += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); y += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); }
  return [E0 + k0 * A * x, k0 * A * y];
}

// ---------------------------------------------------------------- OSGB36 British National Grid (Helmert, ~3-5 m)
export function toBNG(lat, lon) {
  // WGS84 -> cartesian
  const a1 = 6378137, b1 = 6356752.3142, e21 = 1 - (b1 * b1) / (a1 * a1);
  const phi = lat * D2R, lam = lon * D2R, nu1 = a1 / Math.sqrt(1 - e21 * Math.sin(phi) ** 2);
  const X = nu1 * Math.cos(phi) * Math.cos(lam), Y = nu1 * Math.cos(phi) * Math.sin(lam), Z = nu1 * (1 - e21) * Math.sin(phi);
  // Helmert WGS84 -> OSGB36
  const tx = -446.448, ty = 125.157, tz = -542.06, s = 20.4894e-6, rx = -0.1502 / 3600 * D2R, ry = -0.247 / 3600 * D2R, rz = -0.8421 / 3600 * D2R;
  const X2 = tx + (1 + s) * X - rz * Y + ry * Z, Y2 = ty + rz * X + (1 + s) * Y - rx * Z, Z2 = tz - ry * X + rx * Y + (1 + s) * Z;
  // cartesian -> Airy 1830 lat/lon
  const a = 6377563.396, b = 6356256.909, e2 = 1 - (b * b) / (a * a), p = Math.hypot(X2, Y2);
  let ph = Math.atan2(Z2, p * (1 - e2));
  for (let i = 0; i < 10; i++) { const nu = a / Math.sqrt(1 - e2 * Math.sin(ph) ** 2); ph = Math.atan2(Z2 + e2 * nu * Math.sin(ph), p); }
  const la = Math.atan2(Y2, X2);
  // Transverse Mercator (OS)
  const F0 = 0.9996012717, lat0 = 49 * D2R, lon0 = -2 * D2R, N0 = -100000, E0 = 400000, n = (a - b) / (a + b);
  const nu = a * F0 / Math.sqrt(1 - e2 * Math.sin(ph) ** 2), rho = a * F0 * (1 - e2) / (1 - e2 * Math.sin(ph) ** 2) ** 1.5, eta2 = nu / rho - 1;
  const Ma = (1 + n + 5 / 4 * n * n + 5 / 4 * n ** 3) * (ph - lat0), Mb = (3 * n + 3 * n * n + 21 / 8 * n ** 3) * Math.sin(ph - lat0) * Math.cos(ph + lat0);
  const Mc = (15 / 8 * n * n + 15 / 8 * n ** 3) * Math.sin(2 * (ph - lat0)) * Math.cos(2 * (ph + lat0)), Md = 35 / 24 * n ** 3 * Math.sin(3 * (ph - lat0)) * Math.cos(3 * (ph + lat0));
  const M = b * F0 * (Ma - Mb + Mc - Md), c = Math.cos(ph), sn = Math.sin(ph), tn = Math.tan(ph);
  const I = M + N0, II = nu / 2 * sn * c, III = nu / 24 * sn * c ** 3 * (5 - tn * tn + 9 * eta2), IIIA = nu / 720 * sn * c ** 5 * (61 - 58 * tn * tn + tn ** 4);
  const IV = nu * c, V = nu / 6 * c ** 3 * (nu / rho - tn * tn), VI = nu / 120 * c ** 5 * (5 - 18 * tn * tn + tn ** 4 + 14 * eta2 - 58 * tn * tn * eta2);
  const dl = la - lon0;
  return [E0 + IV * dl + V * dl ** 3 + VI * dl ** 5, I + II * dl * dl + III * dl ** 4 + IIIA * dl ** 6];
}

// bilinear sample of a raster {w, h, data, x0, y0 (top-left corner of the top-left pixel), px, py (pixel size, py > 0
// going down)} at projected (x, y); null outside / nodata
export function bilinear(r, x, y) {
  const u = (x - r.x0) / r.px - 0.5, v = (r.y0 - y) / r.py - 0.5;
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  if (i < 0 || j < 0 || i + 1 >= r.w || j + 1 >= r.h) return null;
  const g = (ii, jj) => r.data[jj * r.w + ii];
  const vals = [g(i, j), g(i + 1, j), g(i, j + 1), g(i + 1, j + 1)];
  if (vals.some((q) => !Number.isFinite(q) || q < -1000 || (r.nodata !== null && r.nodata !== undefined && q === r.nodata))) return null;
  return vals[0] * (1 - fu) * (1 - fv) + vals[1] * fu * (1 - fv) + vals[2] * (1 - fu) * fv + vals[3] * fu * fv;
}

// polite fetch with retries (429 / 5xx / network): returns Response
export async function politeFetch(url, opts = {}, what = 'request') {
  for (let a = 0; a < 7; a++) {
    let res;
    try { res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(120000) }, opts, { headers: Object.assign({ 'User-Agent': UA }, opts.headers || {}) })); }
    catch (e) { console.warn(`  ${what}: ${e.message}, retry`); await sleep(3000 * 2 ** a); continue; }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) { console.warn(`  ${what}: HTTP ${res.status}, backing off`); await sleep(5000 * 2 ** a); continue; }
    throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error(`${what}: giving up`);
}
