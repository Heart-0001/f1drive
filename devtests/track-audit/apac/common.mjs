// Shared helpers for the APAC circuit audit (jp-1962, sg-2008, my-1999, cn-2004, au-1953).
// Read-only use of the game data: tracks-data.js, lib/three.min.js, js/track.js, scenery-data.js.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const AUDIT = resolve(HERE, '..');
export const ROOT = resolve(AUDIT, '..', '..');
export const CACHE = resolve(AUDIT, 'cache');
export const IDS = ['jp-1962', 'sg-2008', 'my-1999', 'cn-2004', 'au-1953'];
export const UA = 'F1Drive-track-audit/1 (offline game data check; cached, one-off requests)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _tracks = null;
export function tracks() {
  if (_tracks) return _tracks;
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(resolve(ROOT, 'tracks-data.js'), 'utf8'), ctx);
  _tracks = ctx.window.F1_TRACKS;
  return _tracks;
}
export const track = (id) => tracks().find((t) => t.id === id);

// game local metres <-> lat/lon (x = (lon - lon0) * kx, z = (lat - lat0) * kz; kz < 0)
export const toLL = (t, x, z) => [t.geo.lat0 + z / t.geo.kz, t.geo.lon0 + x / t.geo.kx];
export const toXZ = (t, lat, lon) => [(lon - t.geo.lon0) * t.geo.kx, (lat - t.geo.lat0) * t.geo.kz];
// true metres (no official-length rescale) for comparisons with OSM
export function metric(lat0, lon0) {
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, kz = 110540;
  return { xy: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * kz], ll: (x, y) => [lat0 + y / kz, lon0 + x / kx] };
}

export function cumLen(P) {
  const n = P.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
  return cum;
}
// uniform samples every ~step m along a closed polyline P ([x, z]) with optional per-vertex values v
export function resample(P, step, v) {
  const n = P.length, cum = cumLen(P), total = cum[n], m = Math.max(8, Math.round(total / step)), ds = total / m, out = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const j = (i + 1) % n, f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    out.push({ s, x: P[i][0] + (P[j][0] - P[i][0]) * f, z: P[i][1] + (P[j][1] - P[i][1]) * f,
      v: v ? v[i] + (v[j] - v[i]) * f : undefined });
  }
  return { pts: out, ds, total };
}
// nearest point on a closed (or open) polyline: {s, dist, seg, t, side} side > 0 = left of the polyline direction
export function project(P, x, z, closed = true) {
  let best = Infinity, bs = 0, bi = 0, bt = 0, s = 0, side = 0;
  const n = P.length, last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = P[i], b = P[(i + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez, l = Math.sqrt(l2);
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
    if (d < best) { best = d; bs = s + t * l; bi = i; bt = t; side = ex * (z - a[1]) - ez * (x - a[0]); }
    s += l;
  }
  return { s: bs, dist: best, seg: bi, t: bt, side, total: s };
}

export function readJSON(file, dflt) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : dflt; }
export function writeJSON(file, obj, pretty) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj), 'utf8');
}

// Overpass: one query at a time, cached by name; back off on 429 / 504.
export async function overpass(name, query) {
  const file = resolve(CACHE, 'overpass', name + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const eps = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (let a = 0; a < 10; a++) {
    const ep = eps[a % eps.length];
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query) });
      if (r.ok) { const j = await r.json(); writeJSON(file, j); return j; }
      console.warn(`overpass ${name}: HTTP ${r.status} at ${ep}, backing off`);
    } catch (e) { console.warn(`overpass ${name}: ${e.message}`); }
    await sleep(Math.min(120000, 15000 * (a + 1)));
  }
  throw new Error('overpass ' + name + ': giving up');
}

// OpenTopoData public API: <= 100 locations per request, >= 2.5 s between requests (shared machine-wide etiquette).
let lastOTD = 0;
export async function otd(dataset, id, lls) {
  const file = resolve(CACHE, 'otd-' + dataset, id + '.json');
  const cache = readJSON(file, {});
  const key = (p) => p[0].toFixed(5) + ',' + p[1].toFixed(5);
  const miss = [...new Set(lls.map(key))].filter((k) => !(k in cache));
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100);
    for (let a = 0; ; a++) {
      const wait = lastOTD + 2600 - Date.now();
      if (wait > 0) await sleep(wait);
      lastOTD = Date.now();
      let r = null;
      try { r = await fetch(`https://api.opentopodata.org/v1/${dataset}?locations=${b.join('|')}`, { headers: { 'User-Agent': UA } }); }
      catch (e) { console.warn('otd ' + e.message); }
      if (r && r.ok) { const j = await r.json(); j.results.forEach((q, n) => { cache[b[n]] = q.elevation; }); break; }
      if (a > 6) throw new Error(`otd ${dataset}: HTTP ${r && r.status}`);
      console.warn(`otd ${dataset}: HTTP ${r && r.status}, backing off`);
      await sleep(10000 * (a + 1));
    }
    writeJSON(file, cache);
  }
  return lls.map((p) => cache[key(p)]);
}

// Build the game track (js/track.js) in node with lib/three.min.js; scenery-data.js gives the pit side.
let _build = null;
export function buildTrack(t) {
  if (!_build) {
    const require = createRequire(import.meta.url);
    const THREE = require(resolve(ROOT, 'lib/three.min.js'));
    const sc = { window: {} };
    vm.runInNewContext(readFileSync(resolve(ROOT, 'scenery-data.js'), 'utf8'), sc);
    const win = { THREE, F1_SCENERY: sc.window.F1_SCENERY };
    vm.runInContext(readFileSync(resolve(ROOT, 'js/track.js'), 'utf8'), vm.createContext({ window: win, console }), { filename: 'js/track.js' });
    _build = win.F1.buildTrack;
  }
  return _build(t);
}

// grade statistics over windows (m) on a uniform profile h (closed loop, spacing ds)
export function gradeWindows(h, ds, win) {
  const m = h.length, k = Math.max(1, Math.round(win / ds)), out = [];
  for (let i = 0; i < m; i++) out.push((h[(i + k) % m] - h[i]) / (k * ds));
  return out;
}
export function extremes(arr, ds, startOffset = 0) {
  let mx = -Infinity, mn = Infinity, imx = 0, imn = 0;
  arr.forEach((v, i) => { if (v > mx) { mx = v; imx = i; } if (v < mn) { mn = v; imn = i; } });
  return { max: mx, maxAt: imx * ds + startOffset, min: mn, minAt: imn * ds + startOffset };
}
export function medianLoop(h, half) {
  const m = h.length;
  return h.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
}
export function gaussLoop(h, sigma) {
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = []; let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => { let acc = 0; for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m]; return acc / sum; });
}
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
