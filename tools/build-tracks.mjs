// Builds ../tracks-data.js (window.F1_TRACKS) from the open bacinger/f1-circuits dataset.
// Usage: node tools/build-tracks.mjs [path-to-local-geojson] [--dry] [--dump <file.json>]
//   --dry   print the tables, do not write tracks-data.js;  --dump  write the per-track height profiles (raw / final)
// No npm dependencies (uses global fetch, Node 18+).
//
// Elevation: the dataset is 2D, so ground heights are fetched for points every ~25 m (10 m for the terrain models
// below) along each centreline, cleaned (median + Gaussian + slope limit, on the closed loop) and emitted as `elev`,
// index-aligned with `points`. Default source: the Open-Meteo Elevation API (Copernicus DEM GLO-90, a 90 m SURFACE
// model: buildings, trees and grandstands are in it). Where a free bare-earth terrain model (DTM) with an open API
// covers a circuit, that is used instead (see ELEV_SOURCE / SOURCES). Every fetched height is cached (tools/elevation-
// cache*.json); re-runs do not refetch. Where a terrain model sees the ground above a tunnel or below a bridge, the
// road is taken straight between the ends (COVERED).
//
// Banking: the dataset has none, and js/track.js derives a mild one from curvature. The circuits with really banked
// corners get `bankOverrides` (BANKED below, every value with its source).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Pinned to the dataset commit the committed tracks-data.js points were built from (last change of the file, 2025-09-04):
// points / lengths / ids never move under a rebuild. ('master' gives the same bytes as long as upstream is unchanged.)
const SRC = 'https://raw.githubusercontent.com/bacinger/f1-circuits/432a253890199d0908e7f82044c52de8268cc056/f1-circuits.geojson';
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(TOOLS_DIR, '..', 'tracks-data.js');
const MAX_LENGTH_MISMATCH = 0.15; // rescale to the official length only if within 15 %
const UA = 'F1Drive-build-tracks/2 (offline game data build; cached, one-off requests)';

const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const ELEV_BATCH = 100;        // API limit: 100 coordinates per request
const ELEV_DELAY_MS = 10500;   // pause between requests (100 coordinates = 100 calls; limit 600 / min)
const ELEV_MAX_WAIT_MS = 80 * 60000; // total time one request may spend waiting out rate limits
const ELEV_STEP = 25;          // m, elevation sampling interval along the centreline (GLO-90)
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
// Bare-earth terrain models (lidar, 0.5-5 m): no buildings or trees to filter out, so they are sampled more densely and
// smoothed much less (a hill like COTA's climb to Turn 1, ~300 m long, survives).
const DTM_STEP = 10;           // m
const DTM_MEDIAN_HALF = 2;     // 50 m: kerbs, drains, a sample on a verge or an embankment
const DTM_GAUSS_SIGMA = 20;    // m

// The dataset's point order normally follows the racing direction. For these circuits it runs
// the wrong way round (checked against the real lap: Marina Bay is anti-clockwise, Paul Ricard
// clockwise), so the order is reversed while keeping points[0] (start/finish) in place.
const REVERSED_IN_DATASET = new Set(['sg-2008', 'fr-1969']);

// ---------------------------------------------------------------- elevation sources
// Where a better (bare-earth) model with an open API covers a circuit. Why each one (checked 2026-10, see also
// PUBLISHED below and devtests/track-fix/): GLO-90 flattened COTA (20.6 m vs 41 m published; the 300 m climb to Turn 1
// is smeared away), made the Las Vegas Strip hilly (25 m, 8.7 %: hotels in the surface model; USGS lidar: 16 m, 3 %)
// and gave Monaco a fake 30 m high harbour front (buildings; 54 m vs 44 m published). Where the lidar and a published
// figure disagree, the lidar is kept: COTA 31 m along this centreline (lowest point 151 m ASL ~600 m before the line, turn 1
// crest 182 m; the 1 m grid +-20 m around both gives at most 34 m) against the "133 ft (41 m)" publicity figure, the
// 12 % climb to turn 1 matching the published "over 11%"; Suzuka 40.5 m (GSI laser 5 m: 17.2 .. 57.7 m ASL) against
// the published 52 m. The other circuits keep GLO-90; devtests/track-fix/xcheck.mjs compares every range with SRTM 30 m /
// NED 10 m and the published figures.
const ELEV_SOURCE = {
  'us-2012': 'usgs3dep', 'us-2023': 'usgs3dep', 'us-1909': 'usgs3dep', 'us-1956': 'usgs3dep',
  'mc-1929': 'ignalti', 'fr-1960': 'ignalti', 'fr-1969': 'ignalti',
  'jp-1962': 'gsi5m', 'nl-1948': 'ahn4',
};

// Stretches where a terrain model reads something other than the road: tunnels (it gives the ground above) and bridges
// (bare earth has no deck: it gives the ground below). The road is taken as straight (constant grade) between the
// heights just outside the ends, `pad` metres beyond them. Ends from OpenStreetMap (ODbL), in either order.
const COVERED = {
  // Monaco tunnel under the Fairmont hotel, Boulevard Louis II (OSM way 4230891, tunnel=yes, layer -1): from Portier
  // to the exit before the Nouvelle Chicane. IGN RGE ALTI reads 18-24 m on it (the ground of the hotel / Spelugues
  // level) against ~6-9 m at the portals.
  'mc-1929': [{ name: 'tunnel', from: [43.740362, 7.430326], to: [43.737778, 7.427973], pad: 0 }],
  // Suzuka's crossover: the back straight's bridge over the Degner - hairpin road (OSM way 175231434, raceway,
  // bridge=yes, layer 1). The GSI model gives the lower road's height (~6 m less) on the deck.
  'jp-1962': [{ name: 'crossover bridge', from: [34.844026, 136.530434], to: [34.843915, 136.530810], pad: 10 }],
};

// Published elevation change (highest minus lowest point of the lap) where a source gives one; printed next to the
// built range. [metres, source]
const PUBLISHED = {
  'us-2012': [41, 'en.wikipedia.org/wiki/Circuit_of_the_Americas: "elevation change of 133 ft (41 m)", Turn 1 climb "over 11%"'],
  'mc-1929': [44, 'en.wikipedia.org/wiki/Circuit_de_Monaco: Casino "44 m (144 ft) higher than the lowest part", Beau Rivage max "around 12%"'],
  'nl-1948': [8.9, 'en/nl.wikipedia.org/wiki/Circuit_Zandvoort: "The elevation difference is 8.9 m"'],
  'jp-1962': [52, 'ja.wikipedia.org/wiki/鈴鹿サーキット: "最大高低差は52 m" (max height difference 52 m)'],
  'be-1925': [102.2, 'en.wikipedia.org/wiki/Circuit_de_Spa-Francorchamps: highest point "102.2 m (335 ft) above the lowest part"'],
  'at-1969': [65, 'en.wikipedia.org/wiki/Red_Bull_Ring: "65 m (213 ft) from lowest to highest point"; de: max +12 % / -9.3 %'],
  'de-1927': [55, 'de.wikipedia.org/wiki/Nürburgring: GP-Strecke "Höhenunterschied: 55 m"'],
};

const SOURCES = {
  glo90: {
    label: 'Copernicus DEM GLO-90 (surface model) via the Open-Meteo Elevation API, https://open-meteo.com',
    cache: 'elevation-cache.json', step: ELEV_STEP, dtm: false, batch: ELEV_BATCH, delay: ELEV_DELAY_MS,
    fetch: fetchOpenMeteo,
  },
  usgs3dep: {
    label: 'USGS 3DEP bare-earth DEM (lidar, mostly 1 m; public domain) via the Elevation Point Query Service, https://epqs.nationalmap.gov',
    cache: 'elevation-cache-usgs3dep.json', step: DTM_STEP, dtm: true, batch: 60, delay: 0,
    fetch: (keys) => pointPool(keys, 6, async (lat, lon) => {
      const j = await getJSON(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Meters&includeDate=false`);
      const v = +j.value;
      return Number.isFinite(v) && v > -1000 ? v : null;       // -1000000 = no data
    }),
  },
  ignalti: {
    label: 'IGN RGE ALTI bare-earth DEM (1-5 m; source: IGN, Licence Ouverte Etalab 2.0) via the Geoplateforme altimetry service, https://data.geopf.fr/altimetrie',
    cache: 'elevation-cache-ignalti.json', step: DTM_STEP, dtm: true, batch: 100, delay: 400,
    fetch: async (keys) => {
      const ll = keys.map(splitKey);
      const j = await withRetry(() => getJSON('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=' +
        ll.map((p) => p[1]).join('|') + '&lat=' + ll.map((p) => p[0]).join('|') + '&resource=ign_rge_alti_wld&zonly=true'), 'IGN');
      if (!Array.isArray(j.elevations) || j.elevations.length !== keys.length) throw new Error('IGN: unexpected response');
      return j.elevations.map((v) => (Number.isFinite(+v) && +v > -1000 ? +v : null));   // -99999 = no data
    },
  },
  gsi5m: {
    label: 'GSI DEM 5 m (lidar; source: Geospatial Information Authority of Japan / 国土地理院) via its elevation API, https://maps.gsi.go.jp',
    cache: 'elevation-cache-gsi5m.json', step: DTM_STEP, dtm: true, batch: 40, delay: 0,
    fetch: (keys) => pointPool(keys, 3, async (lat, lon) => {
      const j = await getJSON(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`);
      const v = +j.elevation;
      return Number.isFinite(v) ? v : null;                      // "-----" = no data
    }),
  },
  ahn4: {
    label: 'AHN4 DTM 0.5 m (Actueel Hoogtebestand Nederland, lidar; open data, CC0) via the AHN ImageServer, https://ahn.arcgisonline.nl',
    cache: 'elevation-cache-ahn4.json', step: DTM_STEP, dtm: true, batch: 100, delay: 300,
    fetch: async (keys) => {
      const pts = keys.map(splitKey).map(([lat, lon]) => [+lon, +lat]);
      const geom = encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }));
      const j = await withRetry(() => getJSON('https://ahn.arcgisonline.nl/arcgis/rest/services/AHNviewer/AHN4_DTM_50cm/ImageServer/getSamples' +
        `?geometry=${geom}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json`), 'AHN');
      if (!Array.isArray(j.samples)) throw new Error('AHN: unexpected response ' + JSON.stringify(j).slice(0, 200));
      const out = keys.map(() => null);
      for (const s of j.samples) { const v = +s.value; if (Number.isFinite(v) && v > -1000) out[s.locationId] = v; }
      return out;
    },
  },
};

// ---------------------------------------------------------------- banking
// Real banked corners (the curvature-derived banking of js/track.js is at most 6 deg). deg = bank angle with the
// inside of the corner lower (js/track.js takes the side from the corner's direction); from / to = where the full
// angle starts and ends ([lat, lon] on the centreline, in the racing direction); js/track.js eases in and out over
// 35 m outside them. Emitted as bankOverrides: [{name, from, to, deg}], from / to as fractions of the lap (arc length
// of `points`). Checked, not added (no sourced angle, or not part of the layout in the dataset): Monza's old banking
// (not on the road course), Mexico's Peraltada ("slightly banked", no figure), Hockenheim's 1938 Ostkurve (gone),
// Red Bull Ring, Interlagos, Baku, Las Vegas, Suzuka (no banking figures published).
const BANKED = {
  'nl-1948': [
    // en.wikipedia.org/wiki/Circuit_Zandvoort: "turn 3 has a 19-degree bank", "turns 13/14 have an 18-degree bank"
    // (nl.wikipedia gives 18 / 19 the other way round; OpenStreetMap tags both corners "Helling 32% / 18 graden").
    // Ends = the OpenStreetMap raceway ways named after the corners (ways 1311522216 and 1311879069).
    { name: 'T3 Hugenholtzbocht', deg: 19, from: [52.3887467, 4.5416496], to: [52.3881816, 4.5421584] },
    { name: 'T14 Arie Luyendijkbocht', deg: 18, from: [52.3843701, 4.5406984], to: [52.3860509, 4.5388923] },
  ],
  // en.wikipedia.org/wiki/Indianapolis_Motor_Speedway: "The turns have 9°12' banking"; the F1 road course
  // (2000-2007) includes "the main stretch and the southwest turn" = oval turn 1, driven clockwise as F1 turn 13.
  // Ends = OpenStreetMap way 51308226 "Indianapolis Motor Speedway - Turn 1" (tagged banking=9° 12').
  'us-1909': [{ name: 'T13 (oval turn 1)', deg: 9.2, from: [39.788120, -86.235622], to: [39.790729, -86.238823] }],
  // it.wikipedia.org/wiki/Circuito_di_Gedda: "la pendenza di 12 gradi della curva 13"; de.wikipedia: "Kurvenüberhöhung:
  // 12°". T13 = the 208 deg left-hand hairpin at the northern end; ends = where its radius drops below 400 m
  // (devtests/track-fix/corners.js).
  'sa-2021': [{ name: 'T13', deg: 12, from: [21.649528, 39.102989], to: [21.648828, 39.101942] }],
  // en.wikipedia.org/wiki/Madring: La Monumental, the "longest banked curve" in F1, "no more than 13.5 degrees of
  // banking" ("not to exceed a 24% gradient"). = the 500 m, 234 deg right-hander (the longest corner of the lap by
  // far); ends = where its radius drops below 400 m (devtests/track-fix/corners.js).
  'es-2026': [{ name: 'T12 La Monumental', deg: 13.5, from: [40.479284, -3.624737], to: [40.478759, -3.622536] }],
};

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

// Arc length (m) along the closed polyline pts ([x, z, ...]) of the point nearest to (x, z), and that distance.
function projectOnLoop(pts, x, z) {
  let best = Infinity, bestS = 0, s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
    if (d < best) { best = d; bestS = s + t * Math.sqrt(l2); }
    s += Math.sqrt(l2);
  }
  return { s: bestS, dist: best, total: s };
}
function projectLatLon(track, lat, lon) {
  const g = track.geo;
  return projectOnLoop(track.points, (lon - g.lon0) * g.kx, (lat - g.lat0) * g.kz);
}

// ---------------------------------------------------------------- elevation
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coordKey = (lon, lat) => `${lat.toFixed(5)},${lon.toFixed(5)}`; // ~1 m grid
const splitKey = (k) => k.split(',');                                   // -> [lat, lon] (strings)

// Uniform samples (lon/lat) every ~step metres of arc length around the closed loop.
function elevationSamples(pts, step) {
  const n = pts.length, cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n], m = Math.max(8, Math.round(total / step)), ds = total / m;
  const samples = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const a = pts[i], b = pts[(i + 1) % n], t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    samples.push({ lon: a[2] + (b[2] - a[2]) * t, lat: a[3] + (b[3] - a[3]) * t });
  }
  return { samples, ds, cum, total };
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
  return res.json();
}
// fn() with retries (network errors, 429, 5xx): 1 s, 2 s, 4 s ... 60 s, 9 tries
async function withRetry(fn, what) {
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (err) {
      const st = err.status || 0;
      if (st && st !== 429 && st < 500) throw new Error(`${what}: ${err.message}`);
      if (a >= 8) throw new Error(`${what}: giving up after ${a + 1} attempts (${err.message}); progress is cached, re-run later`);
      const wait = Math.min(60000, 1000 * 2 ** a);
      console.warn(`  ${what} request failed (${err.message.slice(0, 80)}), retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}
// One request per point, `conc` at a time.
async function pointPool(keys, conc, one) {
  const out = new Array(keys.length);
  let next = 0;
  async function worker() {
    while (next < keys.length) {
      const i = next++, [lat, lon] = splitKey(keys[i]);
      out[i] = await withRetry(() => one(lat, lon), 'elevation point');
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, keys.length) }, worker));
  return out;
}

// Open-Meteo counts every coordinate as one call against its free limits (600 / minute,
// 5000 / hour, 10000 / day), so a 429 names the window that was exceeded and we wait it out.
async function fetchOpenMeteo(batch) {
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

// Fills a source's cache (key "lat,lon" -> metres, null = no data) for every key that is missing. Throttled.
async function ensureElevations(src, keys, cache, file) {
  const missing = [...new Set(keys)].filter((k) => !(k in cache));
  if (!missing.length) { console.log(`Elevation (${src.cache}): all ${keys.length} samples served from cache.`); return; }
  const total = Math.ceil(missing.length / src.batch);
  console.log(`Elevation: fetching ${missing.length} of ${keys.length} samples in ${total} batch(es): ${src.label}`);
  for (let i = 0, r = 1; i < missing.length; i += src.batch, r++) {
    const batch = missing.slice(i, i + src.batch);
    const elev = await src.fetch(batch);
    batch.forEach((k, j) => { cache[k] = elev[j] === undefined ? null : elev[j]; });
    writeFileSync(file, JSON.stringify(cache), 'utf8');
    if (r % 10 === 0 || r === total) console.log(`  ${r}/${total}`);
    if (r < total && src.delay) await sleep(src.delay);
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
// No-data samples (null: sea, a hole in the lidar) linearly from the nearest valid ones (closed loop).
function fillGaps(raw) {
  const m = raw.length, h = raw.slice(), ok = raw.map((v) => v !== null && Number.isFinite(v));
  const valid = ok.reduce((a, v) => a + (v ? 1 : 0), 0);
  if (!valid) throw new Error('no elevation data at all');
  for (let i = 0; i < m; i++) {
    if (ok[i]) continue;
    let a = i, b = i, da = 0, db = 0;
    while (!ok[a]) { a = (a - 1 + m) % m; da++; }
    while (!ok[b]) { b = (b + 1) % m; db++; }
    h[i] = raw[a] + (raw[b] - raw[a]) * da / (da + db);
  }
  return { h, holes: m - valid };
}
// COVERED stretches: straight grade between the heights just outside the ends (median of 3 samples each side).
function bridgeCovered(track, sampling, h) {
  const list = COVERED[track.id] || [], m = h.length, notes = [];
  for (const c of list) {
    let pa = projectLatLon(track, c.from[0], c.from[1]), pb = projectLatLon(track, c.to[0], c.to[1]);
    if (pa.dist > 30 || pb.dist > 30) throw new Error(`${track.id} ${c.name}: end ${Math.max(pa.dist, pb.dist).toFixed(0)} m off the centreline`);
    if (((pb.s - pa.s) % pa.total + pa.total) % pa.total > pa.total / 2) [pa, pb] = [pb, pa];   // racing order
    const pad = c.pad || 0;
    const ka = Math.floor((pa.s - pad) / sampling.ds), kb = Math.ceil((pb.s + pad) / sampling.ds);
    const len = ((kb - ka) % m + m) % m;
    const med3 = (k0, dir) => [0, 1, 2].map((j) => h[((k0 + dir * j) % m + m) % m]).sort((p, q) => p - q)[1];
    const ya = med3(ka, -1), yb = med3(kb, 1);
    let maxDiff = 0;
    for (let j = 1; j < len; j++) {
      const k = ((ka + j) % m + m) % m, y = ya + (yb - ya) * j / len;
      if (Math.abs(h[k] - y) > Math.abs(maxDiff)) maxDiff = h[k] - y;
      h[k] = y;
    }
    notes.push(`${c.name} ${Math.round(pa.s - pad)}-${Math.round(pb.s + pad)} m: ${ya.toFixed(1)} -> ${yb.toFixed(1)} m ` +
      `(the model was up to ${Math.abs(maxDiff).toFixed(1)} m ${maxDiff > 0 ? 'higher' : 'lower'})`);
  }
  return notes;
}

// Per-vertex heights (lowest = 0, 0.1 m) from the raw heights of the uniform samples.
function buildElevation(track, sampling, raw, src) {
  const { ds, cum, total } = sampling, m = raw.length, flat = FLAT_TRACKS.has(track.id);
  const filled = fillGaps(raw);
  let h = filled.h;
  const covered = bridgeCovered(track, sampling, h);
  const medHalf = src.dtm ? DTM_MEDIAN_HALF : (flat ? FLAT_MEDIAN_HALF : MEDIAN_HALF);
  const sigma = src.dtm ? DTM_GAUSS_SIGMA : (flat ? FLAT_GAUSS_SIGMA : GAUSS_SIGMA);
  const pre = h.slice();
  h = medianLoop(h, medHalf);
  h = gaussLoop(h, sigma / ds);
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
  const valid = raw.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  return { elev, profile: { ds, raw, pre, final: h }, stats: { flat, samples: m, holes: filled.holes, covered,
    rawMin: valid[0], rawRange: valid[valid.length - 1] - valid[0],
    range: Math.max(...elev), maxGrad, scale, lengthCheck: total } };
}

// ---------------------------------------------------------------- banking (see BANKED)
function bankOverrides(track, warn) {
  const list = BANKED[track.id];
  if (!list) return null;
  const out = [];
  for (const b of list) {
    if (!b.from || !b.to) { warn(`${track.id} ${b.name}: no from / to - skipped`); continue; }
    const pa = projectLatLon(track, b.from[0], b.from[1]), pb = projectLatLon(track, b.to[0], b.to[1]);
    if (pa.dist > 25 || pb.dist > 25) warn(`${track.id} ${b.name}: from / to ${Math.max(pa.dist, pb.dist).toFixed(0)} m off the centreline`);
    const f5 = (v) => Math.round(v * 1e5) / 1e5;
    out.push({ name: b.name, from: f5(pa.s / pa.total), to: f5(pb.s / pb.total), deg: b.deg,
      _m: [pa.s, pb.s, ((pb.s - pa.s) % pa.total + pa.total) % pa.total] });
  }
  return out.length ? out : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const di = args.indexOf('--dump'), dumpFile = di >= 0 ? args[di + 1] : null;
  const local = args.find((a, i) => !a.startsWith('--') && (di < 0 || i !== di + 1));
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
  for (const id of Object.keys(ELEV_SOURCE)) if (!ids.has(id) || !SOURCES[ELEV_SOURCE[id]]) warn(`ELEV_SOURCE ${id}: unknown track or source`);

  // elevation: every source's samples fetched (cached), then each track built from its own source
  const srcOf = (t) => SOURCES[ELEV_SOURCE[t.id] || 'glo90'];
  const samplings = tracks.map((t) => elevationSamples(t.points, srcOf(t).step));
  const keysPer = samplings.map((s) => s.samples.map((q) => coordKey(q.lon, q.lat)));
  const caches = {};
  for (const [name, src] of Object.entries(SOURCES)) {
    const file = resolve(TOOLS_DIR, src.cache);
    const keys = tracks.flatMap((t, i) => (srcOf(t) === src ? keysPer[i] : []));
    caches[name] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (keys.length) await ensureElevations(src, keys, caches[name], file);
  }
  const dump = {};
  tracks.forEach((t, i) => {
    const sname = ELEV_SOURCE[t.id] || 'glo90', src = SOURCES[sname];
    const { elev, profile, stats } = buildElevation(t, samplings[i], keysPer[i].map((k) => caches[sname][k]), src);
    t.bankOverrides = bankOverrides(t, warn);
    t.points = t.points.map(([x, z]) => [x, z]);
    t.elev = elev;
    t.elevSource = sname;
    Object.assign(t._stats, stats);
    dump[t.id] = Object.assign({ source: sname }, profile, { elev, bankOverrides: t.bankOverrides });
    if (elev.length !== t.points.length || elev.some((v) => !Number.isFinite(v))) warn(`${t.name}: bad elevation data`);
  });
  if (dumpFile) writeFileSync(dumpFile, JSON.stringify(dump), 'utf8');

  // geo self-check: re-project the original lon/lat vertices and compare with the emitted points
  let geoWorst = 0;
  for (const t of tracks) {
    const g = t.geo;
    let worst = 0;
    for (const [lon, lat, x, z] of t._src) worst = Math.max(worst, Math.abs((lon - g.lon0) * g.kx - x), Math.abs((lat - g.lat0) * g.kz - z));
    if (!(worst <= 0.0501) || !(g.kz < 0)) warn(`${t.name}: geo projection mismatch ${worst.toFixed(3)} m`);
    geoWorst = Math.max(geoWorst, worst);
  }

  const bySource = {};
  for (const t of tracks) (bySource[t.elevSource] = bySource[t.elevSource] || []).push(t.id);
  const header =
`// GENERATED by tools/build-tracks.mjs - do not edit by hand.
// Circuit centrelines from the "f1-circuits" dataset by Tomislav Bacinger:
//   https://github.com/bacinger/f1-circuits   (file: f1-circuits.geojson)
// Licence of the source data: MIT License, Copyright (c) Tomislav Bacinger.
// Converted to local metres (x = east, z = -north), centred on each circuit,
// scaled to the official lap length. points[0] = start/finish, racing direction.
// Segments longer than ${MAX_POINT_SPACING} m carry extra collinear vertices.
// geo = projection used: x = (lon - geo.lon0) * geo.kx, z = (lat - geo.lat0) * geo.kz.
// elev[i] = height in metres of points[i] above the lowest point of the circuit, smoothed, from:
${Object.entries(bySource).map(([s, l]) => `//   ${SOURCES[s].label}:\n//     ${l.join(' ')}`).join('\n')}
//   Monaco's tunnel and Suzuka's crossover bridge: straight between their ends (from OpenStreetMap, ODbL), where the
//   terrain models see the ground above / below the road.
// bankOverrides (optional) = real banked corners [{name, from, to, deg}]: full bank angle deg (inside of the corner
// lower) from fraction \`from\` to fraction \`to\` of the lap (arc length of points); sources in tools/build-tracks.mjs.
`;
  const body = tracks.map((t) =>
    `{id:${JSON.stringify(t.id)},name:${JSON.stringify(t.name)},location:${JSON.stringify(t.location)},` +
    `lengthKm:${t.lengthKm},geo:${JSON.stringify(t.geo)},points:${JSON.stringify(t.points)},elev:${JSON.stringify(t.elev)}` +
    (t.bankOverrides ? `,bankOverrides:${JSON.stringify(t.bankOverrides.map(({ name, from, to, deg }) => ({ name, from, to, deg })))}` : '') +
    '}').join(',\n');
  if (!dry) writeFileSync(OUT, `${header}window.F1_TRACKS = [\n${body}\n];\n`, 'utf8');

  for (const t of tracks) {
    const s = t._stats;
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(42)} ${String(t.points.length).padStart(4)} pts  ` +
      `${t.lengthKm.toFixed(3)} km  (projected ${(s.projected / 1000).toFixed(3)}, official ${(s.official / 1000).toFixed(3)}, ` +
      `gap ${s.gap.toFixed(0)} m, maxSeg ${s.maxSeg.toFixed(0)} m)`);
  }
  console.log('\nElevation (raw = model samples, out = emitted elev, pub = published range where known):');
  console.log('id       name                                        pts src->out  source    raw range  out range  max grad    pub  mode');
  for (const t of tracks) {
    const s = t._stats, pub = PUBLISHED[t.id];
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(42)} ${(s.srcPoints + '->' + t.points.length).padStart(10)}  ${t.elevSource.padEnd(9)}` +
      `${s.rawRange.toFixed(0).padStart(7)} m  ${s.range.toFixed(1).padStart(7)} m  ${(s.maxGrad * 100).toFixed(1).padStart(6)} %  ` +
      `${pub ? (pub[0] + ' m').padStart(7) : '      -'}  ` +
      (s.flat ? `flat (x${s.scale.toFixed(2)})` : (SOURCES[t.elevSource].dtm ? 'terrain model' : 'normal')) + `  base ${s.rawMin} m` +
      (s.holes ? `  ${s.holes} no-data samples filled` : '') + (s.covered.length ? '  covered: ' + s.covered.join('; ') : ''));
  }
  console.log('\nBanked corners (bankOverrides):');
  for (const t of tracks) {
    for (const b of t.bankOverrides || []) {
      console.log(`${t.id.padEnd(8)} ${b.name.padEnd(26)} ${String(b.deg).padStart(5)} deg  from ${b.from.toFixed(5)} (${b._m[0].toFixed(0)} m) ` +
        `to ${b.to.toFixed(5)} (${b._m[1].toFixed(0)} m), ${b._m[2].toFixed(0)} m at full angle`);
    }
  }
  console.log('\nSources of the published figures:');
  for (const [id, p] of Object.entries(PUBLISHED)) console.log(`  ${id}: ${p[1]}`);
  console.log(`\ngeo self-check: worst re-projection error ${geoWorst.toFixed(4)} m (limit 0.05)`);
  console.log(`\n${tracks.length} circuits ${dry ? 'built (dry run, nothing written)' : 'written to ' + OUT}; ${warnings.length} warning(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
