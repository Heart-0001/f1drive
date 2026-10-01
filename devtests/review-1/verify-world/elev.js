// node devtests/review-1/verify-world/elev.js
// Elevation of every track: the raw DEM samples (tools/elevation-cache.json, looked up exactly as tools/build-tracks.mjs
// samples them: every ~25 m of arc, key lat.toFixed(5),lon.toFixed(5), lon/lat recovered through td.geo), the emitted
// elev[] (range, steepest grade over segments >= 5 m) and the built track (samples[].y range, max |grade|).
const fs = require('fs'), path = require('path');
const L = require('./load.js');
const F1 = L.F1;
const cache = JSON.parse(fs.readFileSync(path.join(L.ROOT, 'tools', 'elevation-cache.json'), 'utf8'));
const filt = process.argv[2] ? process.argv[2].split(',') : null;
const key = (lon, lat) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
function lookup(lon, lat) {
  let k = key(lon, lat);
  if (k in cache) return cache[k];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { k = key(lon + a * 1e-5, lat + b * 1e-5); if (k in cache) return cache[k]; }
  return NaN;
}
for (const td of L.TRACKS) {
  if (filt && !filt.includes(td.id)) continue;
  const g = td.geo, pts = td.points, n = pts.length, cum = [0];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
  const total = cum[n], m = Math.max(8, Math.round(total / 25)), ds = total / m;
  const raw = []; let miss = 0;
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const a = pts[i], b = pts[(i + 1) % n], t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    const v = lookup(g.lon0 + x / g.kx, g.lat0 + z / g.kz);
    if (!(v === v)) miss++; else raw.push(v);
  }
  const rr = raw.length ? Math.max(...raw) - Math.min(...raw) : NaN;
  const e = td.elev, er = Math.max(...e) - Math.min(...e);
  let eg = 0;
  for (let i = 0; i < n; i++) { const d = cum[i + 1] - cum[i]; if (d >= 5) eg = Math.max(eg, Math.abs(e[(i + 1) % n] - e[i]) / d); }
  // raw 5-sample (125 m) median range, as the first filter step sees it
  const med = raw.map((_, i) => { const w = []; for (let j = -2; j <= 2; j++) w.push(raw[((i + j) % raw.length + raw.length) % raw.length]); w.sort((p, q) => p - q); return w[2]; });
  const mr = Math.max(...med) - Math.min(...med);
  // max raw grade over 100 m (4 samples)
  let rg = 0;
  for (let i = 0; i < raw.length; i++) rg = Math.max(rg, Math.abs(raw[(i + 4) % raw.length] - raw[i]) / (4 * ds));
  const tr = F1.buildTrack(td), S = tr.samples;
  let ymin = Infinity, ymax = -Infinity, gmax = 0;
  for (const s of S) { ymin = Math.min(ymin, s.y); ymax = Math.max(ymax, s.y); gmax = Math.max(gmax, Math.abs(s.grade)); }
  console.log(`${td.id.padEnd(8)} raw DEM range ${rr.toFixed(1).padStart(5)} m (median-125m ${mr.toFixed(1).padStart(5)} m, max raw 100 m grade ${(rg * 100).toFixed(1).padStart(5)} %, ${miss} missing) | elev[] range ${er.toFixed(1).padStart(5)} m, grade ${(eg * 100).toFixed(1).padStart(5)} % | built range ${(ymax - ymin).toFixed(1).padStart(5)} m, grade ${(gmax * 100).toFixed(1).padStart(5)} %`);
  tr.dispose();
}
