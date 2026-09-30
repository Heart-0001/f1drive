// Builds ../tracks-data.js (window.F1_TRACKS) from the open bacinger/f1-circuits dataset.
// Usage: node tools/build-tracks.mjs [path-to-local-geojson]
// No npm dependencies (uses global fetch, Node 18+).
//
// Elevation: the dataset is 2D, so ground heights are fetched from the Open-Meteo Elevation API
// (Copernicus DEM GLO-90, free, no key) for points every ~25 m along each centreline, cleaned
// (median + Gaussian + slope limit, on the closed loop) and emitted as `elev`, index-aligned with
// `points`. Fetched heights are cached in tools/elevation-cache.json; re-runs do not refetch.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SRC = 'https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tracks-data.js');
const CACHE = resolve(dirname(fileURLToPath(import.meta.url)), 'elevation-cache.json');
const MAX_LENGTH_MISMATCH = 0.15; // rescale to the official length only if within 15 %

const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const ELEV_BATCH = 100;        // API limit: 100 coordinates per request
const ELEV_DELAY_MS = 10500;   // pause between requests (100 coordinates = 100 calls; limit 600 / min)
const ELEV_MAX_WAIT_MS = 80 * 60000; // total time one request may spend waiting out rate limits
const ELEV_STEP = 25;          // m, elevation sampling interval along the centreline
const MAX_POINT_SPACING = 60;  // m, longer segments get extra (collinear) vertices
const MAX_SLOPE = 0.18;        // |dy/ds| limit (Eau Rouge is ~17 %)
const MEDIAN_HALF = 2;         // median window = 2*half+1 samples (125 m): removes DSM spikes
const GAUSS_SIGMA = 50;        // m
// Venues that are flat in reality (parkland, harbour fronts, reclaimed land, car parks). There the
// 90 m surface model only contributes noise (buildings, grandstands, trees, water/quay steps), so
// the profile is smoothed much harder and scaled down to at most FLAT_MAX_RANGE metres.
const FLAT_TRACKS = new Set(['au-1953', 'ru-2014', 'sg-2008', 'sa-2021', 'us-2022', 'ca-1978']);
const FLAT_MEDIAN_HALF = 6;    // 325 m
const FLAT_GAUSS_SIGMA = 250;  // m
const FLAT_MAX_RANGE = 4;      // m

// The dataset's point order normally follows the racing direction. For these circuits it runs
// the wrong way round (checked against the real lap: Marina Bay is anti-clockwise, Paul Ricard
// clockwise), so the order is reversed while keeping points[0] (start/finish) in place.
const REVERSED_IN_DATASET = new Set(['sg-2008', 'fr-1969']);

const r1 = (v) => { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; }; // 0.1 m, no -0

function closedLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

function convert(feature, warn) {
  const p = feature.properties || {};
  const name = p.Name || p.name || p.id;
  let geom = feature.geometry;
  let coords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : geom.coordinates;
  if (geom.type !== 'LineString') warn(`${name}: geometry type ${geom.type}`);

  // centre = bounding-box centre
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const lon0 = (minLon + maxLon) / 2, lat0 = (minLat + maxLat) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, kz = 110540;

  // East = +x, North = -z  (true, non-mirrored map when viewed from +y with screen-up = -z)
  let pts = coords.map(([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * kz, lon, lat]);

  // drop consecutive duplicates, then a duplicated closing point
  const EPS = 0.05;
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
  pts = pts.filter((q, i) => i === 0 || !same(q, pts[i - 1]));
  while (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();

  if (REVERSED_IN_DATASET.has(String(p.id))) pts = [pts[0], ...pts.slice(1).reverse()];

  // rescale to the official length when the mismatch is small
  const projected = closedLength(pts);
  const official = Number(p.length);
  let scale = 1; // official-length rescale factor, folded into `geo`
  if (official > 0) {
    const mismatch = projected / official - 1;
    if (Math.abs(mismatch) <= MAX_LENGTH_MISMATCH) {
      const s = official / projected;
      scale = s;
      pts = pts.map(([x, z, lon, lat]) => [x * s, z * s, lon, lat]);
    } else {
      warn(`${name}: projected length ${projected.toFixed(0)} m vs official ${official} m ` +
           `(${(mismatch * 100).toFixed(1)} %) - keeping projected length`);
    }
  } else {
    warn(`${name}: no official length - keeping projected length`);
  }

  pts = pts.map(([x, z, lon, lat]) => [r1(x), r1(z), lon, lat]);
  pts = pts.filter((q, i) => i === 0 || !same(q, pts[i - 1]));

  // sanity warnings
  const n = pts.length;
  const len = closedLength(pts);
  if (pts.some((q) => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) warn(`${name}: non-finite coordinate`);
  if (n <= 30) warn(`${name}: only ${n} points`);
  const gap = Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
  let maxSeg = 0;
  for (let i = 0; i < n - 1; i++) maxSeg = Math.max(maxSeg, Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  if (gap > Math.max(2 * maxSeg, 0.15 * len)) warn(`${name}: closing gap ${gap.toFixed(0)} m (longest other segment ${maxSeg.toFixed(0)} m)`);

  return {
    id: String(p.id),
    name: String(name),
    location: String(p.Location || p.location || ''),
    lengthKm: Math.round(len) / 1000,
    points: densify(pts), // [x, z, lon, lat]; lon/lat are stripped before writing
    // projection of the emitted points: x = (lon - lon0) * kx, z = (lat - lat0) * kz (full precision)
    geo: { lon0, lat0, kx: kx * scale, kz: -kz * scale },
    _src: pts.map((q) => [q[2], q[3], q[0], q[1]]), // original vertices [lon, lat, x, z] for the geo self-check
    _stats: { projected, official, gap, maxSeg, srcPoints: n },
  };
}

// Insert evenly spaced vertices on every segment longer than MAX_POINT_SPACING (closed loop).
// Existing vertices are kept untouched and in order.
function densify(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / MAX_POINT_SPACING);
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push([r1(a[0] + (b[0] - a[0]) * t), r1(a[1] + (b[1] - a[1]) * t),
                a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- elevation
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coordKey = (lon, lat) => `${lat.toFixed(5)},${lon.toFixed(5)}`; // ~1 m grid

// Uniform samples (lon/lat) every ~ELEV_STEP metres of arc length around the closed loop.
function elevationSamples(pts) {
  const n = pts.length, cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n], m = Math.max(8, Math.round(total / ELEV_STEP)), ds = total / m;
  const samples = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const a = pts[i], b = pts[(i + 1) % n], t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    samples.push({ lon: a[2] + (b[2] - a[2]) * t, lat: a[3] + (b[3] - a[3]) * t });
  }
  return { samples, ds, cum, total };
}

// Open-Meteo counts every coordinate as one call against its free limits (600 / minute,
// 5000 / hour, 10000 / day), so a 429 names the window that was exceeded and we wait it out.
async function fetchElevations(batch) {
  const url = `${ELEV_API}?latitude=${batch.map((k) => k.split(',')[0]).join(',')}` +
              `&longitude=${batch.map((k) => k.split(',')[1]).join(',')}`;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    let status = 'network error', wait = Math.min(60000, 2000 * 2 ** attempt);
    try {
      const res = await fetch(url);
      status = res.status;
      if (res.ok) {
        const e = (await res.json()).elevation;
        if (!Array.isArray(e) || e.length !== batch.length || e.some((v) => !Number.isFinite(v))) {
          throw new Error('Elevation API: unexpected response ' + JSON.stringify(e).slice(0, 200));
        }
        return e;
      }
      const text = await res.text();
      if (res.status !== 429 && res.status < 500) throw new Error(`Elevation API: HTTP ${res.status} ${text}`);
      if (res.status === 429) {
        if (/daily/i.test(text)) throw new Error('Elevation API: daily limit reached - re-run tomorrow (progress is cached)');
        wait = /hourly/i.test(text) ? 300000 : 61000;
        status = '429 ' + (/hourly/i.test(text) ? 'hourly limit' : 'minutely limit');
      }
    } catch (err) {
      if (String(err.message).startsWith('Elevation API')) throw err;
    }
    if (waited > ELEV_MAX_WAIT_MS) throw new Error(`Elevation API: giving up after ${attempt + 1} attempts (${status}); progress is cached, re-run later`);
    console.warn(`  elevation request failed (${status}), retrying in ${wait / 1000} s`);
    await sleep(wait);
    waited += wait;
  }
}

// Fills cache (key "lat,lon" -> metres) for every key that is missing. Sequential and throttled.
async function ensureElevations(keys, cache) {
  const missing = [...new Set(keys)].filter((k) => !(k in cache));
  if (!missing.length) { console.log(`Elevation: all ${keys.length} samples served from cache.`); return; }
  const total = Math.ceil(missing.length / ELEV_BATCH);
  console.log(`Elevation: fetching ${missing.length} of ${keys.length} samples in ${total} request(s) from ${ELEV_API}`);
  for (let i = 0, r = 1; i < missing.length; i += ELEV_BATCH, r++) {
    const batch = missing.slice(i, i + ELEV_BATCH);
    const elev = await fetchElevations(batch);
    batch.forEach((k, j) => { cache[k] = elev[j]; });
    writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
    if (r % 10 === 0 || r === total) console.log(`  ${r}/${total}`);
    if (r < total) await sleep(ELEV_DELAY_MS);
  }
}

// --- filters on a uniform closed loop
function medianLoop(h, half) {
  const m = h.length, out = new Array(m), w = [];
  for (let i = 0; i < m; i++) {
    w.length = 0;
    for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]);
    w.sort((a, b) => a - b);
    out[i] = w[half];
  }
  return out;
}
function gaussLoop(h, sigma) { // sigma in samples
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m];
    return acc / sum;
  });
}
// Mean of the upper and lower Lipschitz envelopes: the result never changes by more than `maxStep`
// between neighbours anywhere on the loop, and is unchanged where the input already complies.
function slopeLimitLoop(h, maxStep) {
  const m = h.length;
  return h.map((_, i) => {
    let lo = -Infinity, hi = Infinity;
    for (let j = 0; j < m; j++) {
      const d = Math.min(Math.abs(i - j), m - Math.abs(i - j)) * maxStep;
      if (h[j] - d > lo) lo = h[j] - d;
      if (h[j] + d < hi) hi = h[j] + d;
    }
    return (lo + hi) / 2;
  });
}

// Per-vertex heights (lowest = 0, 0.1 m) from the raw DEM heights of the uniform samples.
function buildElevation(track, sampling, raw) {
  const { ds, cum, total } = sampling, m = raw.length, flat = FLAT_TRACKS.has(track.id);
  let h = medianLoop(raw, flat ? FLAT_MEDIAN_HALF : MEDIAN_HALF);
  h = gaussLoop(h, (flat ? FLAT_GAUSS_SIGMA : GAUSS_SIGMA) / ds);
  h = slopeLimitLoop(h, MAX_SLOPE * ds);
  h = gaussLoop(h, 1); // round the corners the limiter leaves
  let min = Math.min(...h);
  const range = Math.max(...h) - min;
  const scale = flat && range > FLAT_MAX_RANGE ? FLAT_MAX_RANGE / range : 1;
  h = h.map((v) => (v - min) * scale);
  // linear interpolation at each vertex's arc length (periodic), then re-zero after rounding
  let elev = track.points.map((_, i) => {
    const u = cum[i] / ds, a = Math.floor(u) % m, t = u - Math.floor(u);
    return h[a] + (h[(a + 1) % m] - h[a]) * t;
  });
  min = Math.min(...elev);
  elev = elev.map((v) => r1(v - min));
  let maxGrad = 0;
  for (let i = 0; i < elev.length; i++) {
    const d = cum[i + 1] - cum[i];
    if (d >= 5) maxGrad = Math.max(maxGrad, Math.abs(elev[(i + 1) % elev.length] - elev[i]) / d);
  }
  const rawSorted = [...raw].sort((a, b) => a - b);
  return { elev, stats: { flat, samples: m, rawMin: rawSorted[0], rawRange: rawSorted[m - 1] - rawSorted[0],
    range: Math.max(...elev), maxGrad, scale, lengthCheck: total } };
}

async function main() {
  const local = process.argv[2];
  let text;
  if (local) text = readFileSync(local, 'utf8');
  else {
    const res = await fetch(SRC);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    text = await res.text();
  }
  const geo = JSON.parse(text);

  const warnings = [];
  const warn = (m) => { warnings.push(m); console.warn('WARNING: ' + m); };

  const tracks = geo.features.map((f) => convert(f, warn));
  tracks.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const ids = new Set();
  for (const t of tracks) { if (ids.has(t.id)) warn(`duplicate id ${t.id}`); ids.add(t.id); }

  // elevation
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  const samplings = tracks.map((t) => elevationSamples(t.points));
  const keysPer = samplings.map((s) => s.samples.map((q) => coordKey(q.lon, q.lat)));
  await ensureElevations(keysPer.flat(), cache);
  tracks.forEach((t, i) => {
    const { elev, stats } = buildElevation(t, samplings[i], keysPer[i].map((k) => cache[k]));
    t.points = t.points.map(([x, z]) => [x, z]);
    t.elev = elev;
    Object.assign(t._stats, stats);
    if (elev.length !== t.points.length || elev.some((v) => !Number.isFinite(v))) warn(`${t.name}: bad elevation data`);
  });

  // geo self-check: re-project the original lon/lat vertices and compare with the emitted points
  let geoWorst = 0;
  for (const t of tracks) {
    const g = t.geo;
    let worst = 0;
    for (const [lon, lat, x, z] of t._src) worst = Math.max(worst, Math.abs((lon - g.lon0) * g.kx - x), Math.abs((lat - g.lat0) * g.kz - z));
    if (!(worst <= 0.0501) || !(g.kz < 0)) warn(`${t.name}: geo projection mismatch ${worst.toFixed(3)} m`);
    geoWorst = Math.max(geoWorst, worst);
  }

  const header =
`// GENERATED by tools/build-tracks.mjs - do not edit by hand.
// Circuit centrelines from the "f1-circuits" dataset by Tomislav Bacinger:
//   https://github.com/bacinger/f1-circuits   (file: f1-circuits.geojson)
// Licence of the source data: MIT License, Copyright (c) Tomislav Bacinger.
// Converted to local metres (x = east, z = -north), centred on each circuit,
// scaled to the official lap length. points[0] = start/finish, racing direction.
// Segments longer than ${MAX_POINT_SPACING} m carry extra collinear vertices.
// geo = projection used: x = (lon - geo.lon0) * geo.kx, z = (lat - geo.lat0) * geo.kz.
// elev[i] = height in metres of points[i] above the lowest point of the circuit, from the
// Open-Meteo Elevation API (https://open-meteo.com, Copernicus DEM GLO-90), smoothed.
`;
  const body = tracks.map((t) =>
    `{id:${JSON.stringify(t.id)},name:${JSON.stringify(t.name)},location:${JSON.stringify(t.location)},` +
    `lengthKm:${t.lengthKm},geo:${JSON.stringify(t.geo)},points:${JSON.stringify(t.points)},elev:${JSON.stringify(t.elev)}}`).join(',\n');
  writeFileSync(OUT, `${header}window.F1_TRACKS = [\n${body}\n];\n`, 'utf8');

  for (const t of tracks) {
    const s = t._stats;
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(42)} ${String(t.points.length).padStart(4)} pts  ` +
      `${t.lengthKm.toFixed(3)} km  (projected ${(s.projected / 1000).toFixed(3)}, official ${(s.official / 1000).toFixed(3)}, ` +
      `gap ${s.gap.toFixed(0)} m, maxSeg ${s.maxSeg.toFixed(0)} m)`);
  }
  console.log('\nElevation (raw = DEM samples, out = emitted elev):');
  console.log('id       name                                        pts src->out  raw range  out range  max grad  mode');
  for (const t of tracks) {
    const s = t._stats;
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(42)} ${(s.srcPoints + '->' + t.points.length).padStart(10)}  ` +
      `${s.rawRange.toFixed(0).padStart(7)} m  ${s.range.toFixed(1).padStart(7)} m  ${(s.maxGrad * 100).toFixed(1).padStart(6)} %  ` +
      (s.flat ? `flat (x${s.scale.toFixed(2)})` : 'normal') + `  base ${s.rawMin} m`);
  }
  console.log(`\ngeo self-check: worst re-projection error ${geoWorst.toFixed(4)} m (limit 0.05)`);
  console.log(`\n${tracks.length} circuits written to ${OUT}; ${warnings.length} warning(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
