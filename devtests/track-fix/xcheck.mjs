// node devtests/track-fix/xcheck.mjs [tracks-data.js]
// Independent cross-check of every circuit's elevation range: the emitted elev[] (tracks-data.js) against
//   - SRTM 30 m (OpenTopoData public API 'srtm30m', a 2000 radar surface model, independent of Copernicus GLO-90),
//   - NED 10 m (OpenTopoData 'ned10m' = USGS 3DEP 1/3 arc-second bare earth) for the US circuits,
//   - the published range where one is known (tools/build-tracks.mjs PUBLISHED, repeated here).
// Samples every 25 m along points (lat/lon through geo), ranges after a 125 m median (as the build's first filter).
// OpenTopoData public limits: 100 locations / request, 1 request / s, 1000 / day -> 1.2 s between requests. Every
// response is cached in devtests/track-fix/cache/otd-<dataset>.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '..', '..');
globalThis.window = globalThis;
const dataFile = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'tracks-data.js');
new Function(readFileSync(dataFile, 'utf8'))();
const TR = window.F1_TRACKS;
const PUBLISHED = { 'us-2012': 41, 'mc-1929': 44, 'nl-1948': 8.9, 'jp-1962': 52, 'be-1925': 102.2, 'at-1969': 65, 'de-1927': 55 };
const US = new Set(['us-2012', 'us-2023', 'us-2022', 'us-1909', 'us-1956']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

function samples(t, step) {
  const P = t.points, g = t.geo, n = P.length, cum = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
  const total = cum[n], m = Math.round(total / step), ds = total / m, out = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const f = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1), j = (i + 1) % n;
    const x = P[i][0] + (P[j][0] - P[i][0]) * f, z = P[i][1] + (P[j][1] - P[i][1]) * f;
    out.push({ s, lat: g.lat0 + z / g.kz, lon: g.lon0 + x / g.kx, elev: t.elev[i] + (t.elev[j] - t.elev[i]) * f });
  }
  return out;
}
async function ensure(dataset, pts) {
  const file = resolve(HERE, 'cache', `otd-${dataset}.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const miss = [...new Set(pts.map((p) => key(p.lat, p.lon)))].filter((k) => !(k in cache));
  for (let i = 0; i < miss.length; i += 100) {
    const b = miss.slice(i, i + 100);
    for (let a = 0; ; a++) {
      const r = await fetch(`https://api.opentopodata.org/v1/${dataset}?locations=${b.join('|')}`, { headers: { 'User-Agent': 'F1Drive devtests/track-fix xcheck' } });
      if (r.ok) { const j = await r.json(); j.results.forEach((q, n) => { cache[b[n]] = q.elevation; }); break; }
      if (a > 6) throw new Error(`${dataset}: HTTP ${r.status}`);
      await sleep(3000 * (a + 1));
    }
    writeFileSync(file, JSON.stringify(cache));
    await sleep(1200);
  }
  return cache;
}
function medRange(v, half) {
  const m = v.length, med = v.map((_, i) => { const w = []; for (let j = -half; j <= half; j++) w.push(v[((i + j) % m + m) % m]); w.sort((a, b) => a - b); return w[half]; });
  return Math.max(...med) - Math.min(...med);
}
const rows = [];
for (const t of TR) {
  const pts = samples(t, 25);
  const srtm = await ensure('srtm30m', pts);
  const sv = pts.map((p) => srtm[key(p.lat, p.lon)]).filter((v) => v !== null && Number.isFinite(v));
  let ned = null;
  if (US.has(t.id)) { const c = await ensure('ned10m', pts); ned = pts.map((p) => c[key(p.lat, p.lon)]).filter((v) => v !== null && Number.isFinite(v)); }
  const er = Math.max(...t.elev) - Math.min(...t.elev);
  const sr = medRange(sv, 2), nr = ned ? medRange(ned, 2) : null, pub = PUBLISHED[t.id];
  const ref = pub || nr || sr, ratio = er / ref;
  rows.push({ id: t.id, name: t.name, game: er, srtm: sr, ned: nr, pub, ratio, flag: ratio < 0.7 || ratio > 1.3 ? (ratio < 1 ? 'LOW' : 'HIGH') : '' });
}
console.log('id       name                                   game range  SRTM30 (125 m median)  NED10  published  game/ref  flag');
for (const r of rows) console.log(`${r.id.padEnd(8)} ${r.name.slice(0, 38).padEnd(38)} ${r.game.toFixed(1).padStart(7)} m  ${r.srtm.toFixed(1).padStart(12)} m  ${r.ned === null ? '     -' : (r.ned.toFixed(1) + ' m').padStart(7)}  ${r.pub ? (r.pub + ' m').padStart(8) : '       -'}  ${r.ratio.toFixed(2).padStart(7)}  ${r.flag}`);
console.log('ref = published range if known, else NED 10 m (US), else SRTM 30 m; flagged when game/ref is outside 0.7..1.3.' +
  ' FLAT_TRACKS in tools/build-tracks.mjs are scaled to <= 4 m on purpose (surface-model noise on flat venues).');
