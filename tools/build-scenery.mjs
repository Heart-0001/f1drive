// Builds ../scenery-data.js (window.F1_SCENERY) from OpenStreetMap via the Overpass API.
// Usage: node tools/build-scenery.mjs [--only id,id] [--offline] [--svg]
//   --only     process just these track ids (the output then contains only those; for testing)
//   --offline  never touch the network (tracks without a cached response are skipped)
//   --svg      write a top-down debug SVG per track into tools/scenery-cache/debug/
// No npm dependencies (global fetch, Node 18+). Raw Overpass responses are cached in
// tools/scenery-cache/<trackId>.json; delete a file to refetch that track.
// Map data (c) OpenStreetMap contributors, ODbL 1.0.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TRACKS = join(ROOT, 'tracks-data.js');
const OUT = join(ROOT, 'scenery-data.js');
const CACHE = join(HERE, 'scenery-cache');
const SRC = 'https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson';
const SRC_CACHE = join(CACHE, '_f1-circuits.geojson');
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const UA = 'f1drive-scenery-builder/1.0 (hobby project, one-off build; Node fetch)';

const BBOX_MARGIN = 350;     // m, query / clip rectangle around the circuit
const MAX_DIST = 300;        // m, keep only things this close to the centreline
const REQUEST_GAP_MS = 5000;
const MAX_BUILDINGS = 1500, MAX_AREAS = 400, MAX_TREES = 1500;
const MIN_BUILDING_AREA = 25;
const TOL_BUILDING = 1, TOL_AREA = 3;
const CORRIDOR = 12;         // m, wall distance used by js/track.js
const DENSE_CITY = 400;      // more buildings than this near the track => vary default heights
const AREA_ORDER = ['urban', 'grass', 'forest', 'asphalt', 'sand', 'water'];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const ONLY = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const OFFLINE = flag('--offline'), SVG = flag('--svg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; };

// ------------------------------------------------------------------ geometry
function ringArea(p) { // signed
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) { const q = p[i], r = p[(i + 1) % n]; a += q[0] * r[1] - r[0] * q[1]; }
  return a / 2;
}
function centroid(p) {
  let x = 0, z = 0;
  for (const q of p) { x += q[0]; z += q[1]; }
  return [x / p.length, z / p.length];
}
function pointInRing(x, z, p) {
  let inside = false;
  for (let i = 0, n = p.length, j = n - 1; i < n; j = i++) {
    const a = p[i], b = p[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function dedupe(p, eps = 0.05) {
  const out = [];
  for (const q of p) {
    const l = out[out.length - 1];
    if (!l || Math.abs(l[0] - q[0]) > eps || Math.abs(l[1] - q[1]) > eps) out.push(q);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= eps &&
         Math.abs(out[0][1] - out[out.length - 1][1]) <= eps) out.pop();
  return out;
}
function dpOpen(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], az = pts[a][1], dx = pts[b][0] - ax, dz = pts[b][1] - az, l2 = dx * dx + dz * dz;
    let best = -1, bd = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, pz = pts[i][1] - az;
      let t = l2 ? (px * dx + pz * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - dx * t, ez = pz - dz * t, d = ex * ex + ez * ez;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  let far = 1, fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = dpOpen(ring.slice(0, far + 1), tol), b = dpOpen(ring.slice(far).concat([ring[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
// Sutherland-Hodgman against an axis-aligned rectangle (keeps vertex order).
function clipRing(ring, R) {
  const edges = [
    [(p) => p[0] >= R.x0, (a, b) => { const t = (R.x0 - a[0]) / (b[0] - a[0]); return [R.x0, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[0] <= R.x1, (a, b) => { const t = (R.x1 - a[0]) / (b[0] - a[0]); return [R.x1, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[1] >= R.z0, (a, b) => { const t = (R.z0 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, R.z0]; }],
    [(p) => p[1] <= R.z1, (a, b) => { const t = (R.z1 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, R.z1]; }],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
  }
  return out;
}
// Merge holes into the outer ring with zero-width bridges (weakly simple "keyhole" polygon).
function bridgeHoles(outer, holes) {
  let ring = outer;
  const so = Math.sign(ringArea(outer));
  for (let hole of holes) {
    if (Math.sign(ringArea(hole)) === so) hole = hole.slice().reverse();
    let bi = 0, bj = 0, bd = Infinity;
    for (let i = 0; i < ring.length; i++) for (let j = 0; j < hole.length; j++) {
      const d = (ring[i][0] - hole[j][0]) ** 2 + (ring[i][1] - hole[j][1]) ** 2;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    ring = ring.slice(0, bi + 1).concat(hole.slice(bj), hole.slice(0, bj + 1), ring.slice(bi));
  }
  return ring;
}
// Join ways (arrays of [x,z]) end to end. directed: only tail->head joins (coastlines).
function stitch(ways, directed) {
  const key = (p) => p[0].toFixed(2) + ',' + p[1].toFixed(2);
  const rings = [], open = [], pend = [];
  for (const w of ways) {
    if (w.length < 2) continue;
    if (w.length > 3 && key(w[0]) === key(w[w.length - 1])) rings.push(w.slice(0, -1)); else pend.push(w);
  }
  const used = new Array(pend.length).fill(false);
  const heads = new Map(), tails = new Map();
  const add = (m, k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); };
  pend.forEach((w, i) => { add(heads, key(w[0]), i); add(tails, key(w[w.length - 1]), i); });
  const take = (m, k) => (m.get(k) || []).find((i) => !used[i]);
  for (let s = 0; s < pend.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let chain = pend[s].slice(), closed = false;
    for (;;) { // extend at the tail
      const k = key(chain[chain.length - 1]);
      if (k === key(chain[0]) && chain.length > 3) { closed = true; break; }
      let n = take(heads, k), rev = false;
      if (n === undefined && !directed) { n = take(tails, k); rev = true; }
      if (n === undefined) break;
      used[n] = true;
      const w = rev ? pend[n].slice().reverse() : pend[n];
      chain = chain.concat(w.slice(1));
    }
    if (!closed) for (;;) { // extend at the head
      const k = key(chain[0]);
      if (k === key(chain[chain.length - 1]) && chain.length > 3) { closed = true; break; }
      let n = take(tails, k), rev = false;
      if (n === undefined && !directed) { n = take(heads, k); rev = true; }
      if (n === undefined) break;
      used[n] = true;
      const w = rev ? pend[n].slice().reverse() : pend[n];
      chain = w.slice(0, -1).concat(chain);
    }
    if (closed) rings.push(chain.slice(0, -1)); else open.push(chain);
  }
  return { rings, open };
}

// ------------------------------------------------------------------ track helpers
function resample(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  return out;
}
function makeIndex(pts, cs = 50) {
  const cells = new Map();
  const ck = (i, j) => i * 100003 + j;
  pts.forEach((p, n) => {
    const k = ck(Math.floor(p[0] / cs), Math.floor(p[1] / cs));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  });
  // distance to the nearest track point, Infinity when farther than maxD
  function nearest(x, z, maxD) {
    const ci = Math.floor(x / cs), cj = Math.floor(z / cs), R = Math.ceil(maxD / cs) + 1;
    let best = Infinity, bi = -1;
    for (let r = 0; r <= R; r++) {
      if (best <= (r - 1) * cs * (r - 1) * cs && r > 0) break;
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        const c = cells.get(ck(i, j));
        if (!c) continue;
        for (const n of c) {
          const d = (pts[n][0] - x) ** 2 + (pts[n][1] - z) ** 2;
          if (d < best) { best = d; bi = n; }
        }
      }
    }
    const d = Math.sqrt(best);
    return d <= maxD ? { d, i: bi } : { d: Infinity, i: -1 };
  }
  return { dist: (x, z, maxD = 400) => nearest(x, z, maxD).d, nearest };
}

// ------------------------------------------------------------------ projection
function closedLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return len;
}
const featureCoords = (f) => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates);
// Same maths as tools/build-tracks.mjs convert(): bbox-centre equirectangular, then the official-length rescale.
function deriveGeo(feature) {
  const coords = featureCoords(feature);
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const lon0 = (minLon + maxLon) / 2, lat0 = (minLat + maxLat) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, kz = 110540;
  let pts = coords.map(([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * kz]);
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;
  pts = pts.filter((q, i) => i === 0 || !same(q, pts[i - 1]));
  while (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
  const projected = closedLength(pts), official = Number(feature.properties.length);
  const s = official > 0 && Math.abs(projected / official - 1) <= 0.15 ? official / projected : 1;
  return { lon0, lat0, kx: kx * s, kz: -kz * s };
}
// Residual of source vertices against the emitted points (original vertices are preserved).
function geoResidual(track, feature, geo) {
  const idx = makeIndex(track.points, 50);
  let max = 0, sum = 0, n = 0;
  const pairs = [];
  for (const [lon, lat] of featureCoords(feature)) {
    const x = (lon - geo.lon0) * geo.kx, z = (lat - geo.lat0) * geo.kz;
    const q = idx.nearest(x, z, 200);
    if (q.i < 0) { max = Infinity; continue; }
    max = Math.max(max, q.d); sum += q.d; n++;
    pairs.push([lon, lat, track.points[q.i][0], track.points[q.i][1]]);
  }
  return { max, mean: n ? sum / n : Infinity, pairs };
}
function fitGeo(pairs) { // least squares x = kx*(lon-lon0), z = kz*(lat-lat0)
  const fit = (u, v) => {
    const n = u.length, mu = u.reduce((a, b) => a + b, 0) / n, mv = v.reduce((a, b) => a + b, 0) / n;
    let suv = 0, suu = 0;
    for (let i = 0; i < n; i++) { suv += (u[i] - mu) * (v[i] - mv); suu += (u[i] - mu) ** 2; }
    const k = suv / suu;
    return { k, o: mu - mv / k };
  };
  const fx = fit(pairs.map((p) => p[0]), pairs.map((p) => p[2]));
  const fz = fit(pairs.map((p) => p[1]), pairs.map((p) => p[3]));
  return { lon0: fx.o, lat0: fz.o, kx: fx.k, kz: fz.k };
}
function resolveGeo(track, feature) {
  let geo = null, how = '';
  if (track.geo && ['lon0', 'lat0', 'kx', 'kz'].every((k) => Number.isFinite(track.geo[k]))) { geo = track.geo; how = 'geo field'; }
  else if (feature) { geo = deriveGeo(feature); how = 'derived (build-tracks maths)'; }
  else return { geo: null, how: 'unavailable' };
  let res = feature ? geoResidual(track, feature, geo) : null;
  if (res && !(res.max < 0.3) && !track.geo) {
    for (let it = 0; it < 4 && res.pairs.length > 10; it++) { geo = fitGeo(res.pairs); res = geoResidual(track, feature, geo); }
    how = 'least-squares fit';
  }
  return { geo, how, res };
}

// ------------------------------------------------------------------ Overpass
function buildQuery(b) {
  const bb = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  return `[out:json][timeout:90][bbox:${bb}];
(
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["leisure"="bleachers"];
  way["man_made"~"^(tower|bridge)$"];
  way["natural"~"^(water|wood|sand|beach|shingle|coastline|grassland|tree_row)$"];
  relation["natural"~"^(water|wood|sand|beach|grassland)$"];
  way["waterway"~"^(riverbank|dock)$"];
  relation["waterway"~"^(riverbank|dock)$"];
  way["landuse"~"^(forest|grass|meadow|village_green|recreation_ground|residential|commercial|retail|industrial|basin|reservoir)$"];
  relation["landuse"~"^(forest|grass|meadow|residential|commercial|retail|industrial|basin|reservoir)$"];
  way["leisure"~"^(park|golf_course|garden)$"];
  relation["leisure"~"^(park|golf_course|garden)$"];
  way["golf"="bunker"];
  way["amenity"="parking"];
  way["aeroway"~"^(apron|helipad|runway|taxiway)$"];
  way["surface"~"^(gravel|fine_gravel|sand|asphalt|concrete|paved)$"]["area"="yes"];
  way["surface"~"^(gravel|fine_gravel|sand)$"][!"highway"];
  way["highway"~"^(raceway|pedestrian)$"]["area"="yes"];
  node["natural"="tree"];
);
out geom;`;
}
const log = [];
async function fetchOverpass(id, query) {
  const file = join(CACHE, id + '.json');
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(j.elements)) return { json: j, cached: true };
    } catch { /* refetch */ }
  }
  if (OFFLINE) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    let why = '';
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Accept': 'application/json' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(130000),
      });
      const text = await res.text();
      if (res.ok) {
        let j = null;
        try { j = JSON.parse(text); } catch { why = 'non-JSON body'; }
        if (j && Array.isArray(j.elements) && !(j.remark && /error|timed out|out of memory/i.test(j.remark))) {
          writeFileSync(file, text, 'utf8');
          return { json: j, cached: false, ep };
        }
        if (j && j.remark) why = 'remark: ' + j.remark;
      } else why = 'HTTP ' + res.status;
    } catch (e) { why = String(e.message || e); }
    const wait = Math.min(90000, 6000 * 2 ** attempt);
    const m = `${id}: ${new URL(ep).host} failed (${why}), retry in ${wait / 1000} s`;
    log.push(m); console.warn('  ' + m);
    await sleep(wait);
  }
  log.push(`${id}: GAVE UP`);
  return null;
}

// ------------------------------------------------------------------ classification
const RE_STAND = /grand\s?stand|tribun|tribün|trybun|gradas?\b|gradería|bleacher|スタンド|看台|lelátó/i;
const RE_PIT = /\bpits?\b|pit[\s-]?(lane|building|complex|garage)|paddock|\bgarages?\b|\bboxe[sn]\b|ピット/i;
function parseHeight(v) {
  if (v == null) return NaN;
  const s = String(v).replace(',', '.'), n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return /ft|feet|'/.test(s) ? n * 0.3048 : n;
}
function hash(n) { let h = (Number(n) ^ 0x9e3779b9) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function classify(t) {
  const name = [t.name, t['name:en'], t.description, t.alt_name].filter(Boolean).join(' ');
  if (t.location === 'underground' || t.tunnel === 'yes' || t.tunnel === 'building_passage') return null;
  if (t.man_made === 'bridge') return { type: 'building', kind: 'bridge' };
  if ((t.building && t.building !== 'no') || t.leisure === 'bleachers' || t.man_made === 'tower') {
    let kind = 'building';
    if (t.building === 'grandstand' || t.leisure === 'bleachers' || t.building === 'bleachers' || RE_STAND.test(name)) kind = 'grandstand';
    else if (RE_PIT.test(name) && t.amenity !== 'parking' && t.building !== 'parking') kind = 'pit';
    else if (t.man_made === 'tower' || t.building === 'tower') kind = 'tower';
    return { type: 'building', kind };
  }
  const a = (kind) => ({ type: 'area', kind });
  if (t.natural === 'water' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.landuse === 'basin' || t.landuse === 'reservoir') {
    return t.intermittent === 'yes' ? null : a('water');
  }
  if (t.natural === 'sand' || t.natural === 'beach' || t.natural === 'shingle' || t.golf === 'bunker') return a('sand');
  if (/^(gravel|fine_gravel|sand)$/.test(t.surface || '') && (!t.highway || t.area === 'yes')) return a('sand');
  if (t.natural === 'wood' || t.landuse === 'forest') return a('forest');
  if (t.amenity === 'parking') return /underground|multi-storey|rooftop/.test(t.parking || '') ? null : a('asphalt');
  if (/^(apron|helipad|runway|taxiway)$/.test(t.aeroway || '')) return a('asphalt');
  if (t.area === 'yes' && (/^(raceway|pedestrian)$/.test(t.highway || '') || /^(asphalt|concrete|paved)$/.test(t.surface || ''))) return a('asphalt');
  if (/^(grass|meadow|village_green|recreation_ground)$/.test(t.landuse || '') || /^(park|golf_course|garden)$/.test(t.leisure || '') || t.natural === 'grassland') return a('grass');
  if (/^(residential|commercial|retail|industrial)$/.test(t.landuse || '')) return a('urban');
  return null;
}

// ------------------------------------------------------------------ coastline -> sea polygons
// OSM coastlines run with land on the left and water on the right. Works in (east, north).
function seaFromCoastline(ways, R, notes) {
  const E = { x0: R.x0, x1: R.x1, y0: -R.z1, y1: -R.z0 };
  const W = E.x1 - E.x0, H = E.y1 - E.y0, P = 2 * (W + H);
  const inside = (p) => p[0] >= E.x0 && p[0] <= E.x1 && p[1] >= E.y0 && p[1] <= E.y1;
  const st = stitch(ways.map((w) => w.map((p) => [p[0], -p[1]])), true);
  const lb = (p, q) => { // Liang-Barsky
    let t0 = 0, t1 = 1; const dx = q[0] - p[0], dy = q[1] - p[1];
    for (const [pp, qq] of [[-dx, p[0] - E.x0], [dx, E.x1 - p[0]], [-dy, p[1] - E.y0], [dy, E.y1 - p[1]]]) {
      if (pp === 0) { if (qq < 0) return null; continue; }
      const r = qq / pp;
      if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  };
  const bt = (p) => { // clockwise border parameter, from the top-left corner
    const d = [Math.abs(p[1] - E.y1), Math.abs(p[0] - E.x1), Math.abs(p[1] - E.y0), Math.abs(p[0] - E.x0)];
    const m = d.indexOf(Math.min(...d));
    return m === 0 ? p[0] - E.x0 : m === 1 ? W + (E.y1 - p[1]) : m === 2 ? W + H + (E.x1 - p[0]) : 2 * W + H + (p[1] - E.y0);
  };
  const pieces = [], islands = [];
  let dangling = 0;
  const chains = st.open.map((c) => ({ c }));
  for (const r of st.rings) {
    if (r.every(inside)) { islands.push(r); continue; }
    const s = r.findIndex((p) => !inside(p));
    chains.push({ c: r.slice(s).concat(r.slice(0, s + 1)) });
  }
  for (const { c } of chains) {
    let cur = null;
    for (let i = 0; i + 1 < c.length; i++) {
      const p = c[i], q = c[i + 1], t = lb(p, q);
      if (!t) { cur = null; continue; }
      const at = (u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
      if (t[0] > 0) cur = { pts: [at(t[0])], ok: true };
      else if (!cur) cur = { pts: [p], ok: i > 0 ? true : false };
      cur.pts.push(at(t[1]));
      if (t[1] < 1) { if (cur.ok) pieces.push(cur); else dangling++; cur = null; }
    }
    if (cur) dangling++;
  }
  if (dangling) notes.push(`coastline: ${dangling} dangling piece(s) ignored`);
  for (const pc of pieces) { pc.pts = dpOpen(pc.pts, TOL_AREA); pc.tIn = bt(pc.pts[0]); pc.tOut = bt(pc.pts[pc.pts.length - 1]); }
  const corners = [[0, [E.x0, E.y1]], [W, [E.x1, E.y1]], [W + H, [E.x1, E.y0]], [2 * W + H, [E.x0, E.y0]]];
  const mod = (v) => ((v % P) + P) % P;
  const used = pieces.map(() => false), polys = [];
  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    const poly = []; let j = s, guard = 0;
    for (;;) {
      used[j] = true; poly.push(...pieces[j].pts);
      let k = -1, bd = Infinity;
      for (let i = 0; i < pieces.length; i++) {
        if (used[i] && i !== s) continue;
        const d = mod(pieces[i].tIn - pieces[j].tOut);
        if (d < bd) { bd = d; k = i; }
      }
      corners.map(([t, p]) => [mod(t - pieces[j].tOut), p]).filter(([d]) => d < bd).sort((a, b) => a[0] - b[0]).forEach(([, p]) => poly.push(p));
      if (k === s || k < 0 || ++guard > pieces.length + 2) break;
      j = k;
    }
    if (poly.length >= 3 && Math.abs(ringArea(poly)) > 200) polys.push(poly);
  }
  if (!pieces.length && islands.length) notes.push('coastline: only closed island rings inside the bbox, sea not synthesised');
  // islands become holes of the sea polygon that contains them
  const out = polys.map((p) => {
    const holes = islands.filter((h) => pointInRing(h[0][0], h[0][1], p)).map((h) => simplifyRing(h, TOL_AREA)).filter((h) => h.length >= 3);
    return (holes.length ? bridgeHoles(p, holes) : p).map((q) => [q[0], -q[1]]);
  });
  return out;
}

// ------------------------------------------------------------------ per-track processing
function processTrack(track, geo, osm) {
  const notes = [];
  const pts = track.points;
  const dense = resample(pts, 4), idx = makeIndex(dense, 50);
  const coarse = dense.filter((_, i) => i % 5 === 0);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const R = { x0: x0 - BBOX_MARGIN, x1: x1 + BBOX_MARGIN, z0: z0 - BBOX_MARGIN, z1: z1 + BBOX_MARGIN };
  const proj = (g) => g.filter(Boolean).map((q) => [(q.lon - geo.lon0) * geo.kx, (q.lat - geo.lat0) * geo.kz]);
  const isClosed = (g) => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

  const rawB = [], rawA = [], trees = [], coast = [];
  const ringDist = (ring) => { // min distance of the outline (vertices + edge samples) to the centreline
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
      for (let j = 0; j < k; j++) {
        const d = idx.dist(a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k, 400);
        if (d < best) best = d;
      }
    }
    return best;
  };
  const containsTrack = (ring) => {
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const [x, z] of ring) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    return coarse.some(([x, z]) => x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1 && pointInRing(x, z, ring));
  };
  const addBuilding = (el, kind, ring) => {
    ring = dedupe(ring);
    if (ring.length < 3) return;
    const c = centroid(ring);
    if (c[0] < R.x0 - 100 || c[0] > R.x1 + 100 || c[1] < R.z0 - 100 || c[1] > R.z1 + 100) return;
    let dist = Math.min(ringDist(ring), idx.dist(c[0], c[1], 400));
    if (dist > MAX_DIST) return;
    ring = dedupe(simplifyRing(ring, TOL_BUILDING).map(([x, z]) => [r1(x), r1(z)]));
    const area = Math.abs(ringArea(ring));
    if (ring.length < 3 || area < MIN_BUILDING_AREA) return;
    const t = el.tags || {};
    let h = parseHeight(t.height);
    if (!Number.isFinite(h)) h = parseHeight(t['building:height']);
    if (!Number.isFinite(h) && Number.isFinite(parseFloat(t['building:levels']))) h = parseFloat(t['building:levels']) * 3.2;
    rawB.push({ id: el.id, kind, h, tagged: Number.isFinite(h), p: ring, area, dist, c, tags: t });
  };
  const addArea = (kind, outer, inners) => {
    let ring = clipRing(dedupe(outer), R);
    if (ring.length < 3) return;
    ring = dedupe(simplifyRing(dedupe(ring), TOL_AREA));
    if (ring.length < 3) return;
    const holes = [];
    for (const h of inners || []) {
      if (!pointInRing(h[0][0], h[0][1], outer)) continue;
      let c = clipRing(dedupe(h), R);
      if (c.length < 3) continue;
      c = dedupe(simplifyRing(dedupe(c), TOL_AREA));
      if (c.length >= 3 && Math.abs(ringArea(c)) > 30) holes.push(c);
    }
    let area = Math.abs(ringArea(ring)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
    if (area < (kind === 'sand' ? 15 : 40)) return;
    if (holes.length) ring = bridgeHoles(ring, holes);
    const dist = containsTrack(ring) ? 0 : ringDist(ring);
    if (dist > MAX_DIST) return;
    ring = dedupe(ring.map(([x, z]) => [r1(x), r1(z)]), 0.01);
    if (ring.length < 3) return;
    rawA.push({ k: kind, p: ring, area, dist });
  };

  for (const el of osm.elements) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree') {
        const x = (el.lon - geo.lon0) * geo.kx, z = (el.lat - geo.lat0) * geo.kz, d = idx.dist(x, z, MAX_DIST);
        if (d <= MAX_DIST) trees.push({ x, z, d });
      }
      continue;
    }
    if (el.type === 'way') {
      if (!el.geometry) continue;
      const g = el.geometry.filter(Boolean);
      if (t.natural === 'coastline') { coast.push(proj(g)); continue; }
      if (t.natural === 'tree_row') {
        const line = proj(g);
        for (let i = 0; i + 1 < line.length; i++) {
          const a = line[i], b = line[i + 1], k = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 8));
          for (let j = 0; j < k; j++) {
            const x = a[0] + (b[0] - a[0]) * j / k, z = a[1] + (b[1] - a[1]) * j / k, d = idx.dist(x, z, MAX_DIST);
            if (d <= MAX_DIST) trees.push({ x, z, d });
          }
        }
        continue;
      }
      if (!isClosed(g)) continue;
      const c = classify(t);
      if (!c) continue;
      const ring = proj(g).slice(0, -1);
      if (c.type === 'building') addBuilding(el, c.kind, ring); else addArea(c.kind, ring, null);
      continue;
    }
    if (el.type === 'relation') {
      const c = classify(t);
      if (!c || !el.members) continue;
      const ways = (role) => el.members.filter((m) => m.type === 'way' && m.geometry && (role === 'inner' ? m.role === 'inner' : m.role !== 'inner')).map((m) => proj(m.geometry));
      const outers = stitch(ways('outer'), false).rings;
      if (c.type === 'building') { for (const r of outers) addBuilding(el, c.kind, r); continue; }
      const inners = stitch(ways('inner'), false).rings.filter((r) => r.length >= 3);
      for (const r of outers) if (r.length >= 3) addArea(c.kind, r, inners);
    }
  }

  // sea from coastline
  let seaAdded = 0;
  if (coast.length) {
    const sea = seaFromCoastline(coast, R, notes);
    for (const s of sea) {
      const ring = dedupe(s);
      const inside = coarse.filter(([x, z]) => pointInRing(x, z, ring)).length / coarse.length;
      if (inside > 0.4) { notes.push(`coastline: synthesised sea would cover ${(inside * 100).toFixed(0)} % of the track - dropped`); continue; }
      const before = rawA.length;
      addArea('water', ring, null);
      if (rawA.length > before) seaAdded++;
    }
    notes.push(`coastline: ${coast.length} way(s) -> ${seaAdded} sea polygon(s)`);
  }

  // ---- buildings: pit heuristic, heights, caps
  const dense_city = rawB.length > DENSE_CITY;
  if (!rawB.some((b) => b.kind === 'pit')) {
    const tx0 = pts[1][0] - pts[pts.length - 1][0], tz0 = pts[1][1] - pts[pts.length - 1][1], tl = Math.hypot(tx0, tz0) || 1;
    const tx = tx0 / tl, tz = tz0 / tl;
    let best = null;
    for (const b of rawB) {
      if (b.kind !== 'building' || b.dist > 40) continue; // real pit buildings sit 15-30 m from the centreline
      if (Math.hypot(b.c[0] - pts[0][0], b.c[1] - pts[0][1]) > 450) continue;
      let a0 = Infinity, a1 = -Infinity, n0 = Infinity, n1 = -Infinity;
      for (const [x, z] of b.p) {
        const a = x * tx + z * tz, n = -x * tz + z * tx;
        a0 = Math.min(a0, a); a1 = Math.max(a1, a); n0 = Math.min(n0, n); n1 = Math.max(n1, n);
      }
      const along = a1 - a0, across = n1 - n0;
      const off = Math.abs(-(b.c[0] - pts[0][0]) * tz + (b.c[1] - pts[0][1]) * tx); // lateral offset from the start straight
      if (along >= 80 && across <= along * 0.4 && off < 90 && (!best || b.area > best.area)) best = b;
    }
    if (best) { best.kind = 'pit'; notes.push(`pit: heuristic (${best.area.toFixed(0)} m2, ${best.dist.toFixed(0)} m from centreline)`); }
  } else notes.push('pit: by name');
  for (const b of rawB) {
    if (!Number.isFinite(b.h)) {
      b.h = b.kind === 'grandstand' ? 12 : b.kind === 'pit' ? 9 : b.kind === 'tower' ? 30 : b.kind === 'bridge' ? 7
        : dense_city ? 8 + Math.round(hash(b.id) * hash(b.id) * 17) : 8;
      if (b.kind === 'building' && /^(garage|garages|shed|hut|roof|carport|kiosk|container|service|toilets)$/.test(b.tags.building || '')) b.h = b.tags.building === 'roof' ? 6 : 3.5;
    } else if (b.kind === 'building' && b.h >= 60) b.kind = 'tower';
    b.h = r1(Math.max(2, Math.min(200, b.h)));
  }
  rawB.sort((a, b) => (a.dist - Math.min(150, Math.sqrt(a.area) * 1.5)) - (b.dist - Math.min(150, Math.sqrt(b.area) * 1.5)));
  const special = rawB.filter((b) => b.kind !== 'building'), plain = rawB.filter((b) => b.kind === 'building');
  const buildings = special.concat(plain).slice(0, MAX_BUILDINGS);
  if (rawB.length > MAX_BUILDINGS) notes.push(`buildings capped ${rawB.length} -> ${MAX_BUILDINGS}`);

  rawA.sort((a, b) => ((a.dist < 80 ? 0 : 1) - (b.dist < 80 ? 0 : 1)) || (b.area - a.area));
  if (rawA.length > MAX_AREAS) notes.push(`areas capped ${rawA.length} -> ${MAX_AREAS}`);
  const areas = rawA.slice(0, MAX_AREAS).sort((a, b) => (AREA_ORDER.indexOf(a.k) - AREA_ORDER.indexOf(b.k)) || (b.area - a.area));

  trees.sort((a, b) => a.d - b.d);
  if (trees.length > MAX_TREES) notes.push(`trees capped ${trees.length} -> ${MAX_TREES}`);
  const seen = new Set(), treeOut = [];
  for (const t of trees) {
    const p = [r1(t.x), r1(t.z)], k = p.join(',');
    if (seen.has(k)) continue;
    seen.add(k); treeOut.push(p);
    if (treeOut.length >= MAX_TREES) break;
  }

  // ---- stats: share of building footprint inside the 12 m corridor, grandstand distances
  let cells = 0, inCorr = 0;
  const standD = [];
  for (const b of buildings) {
    if (b.kind === 'bridge') continue;
    if (b.kind === 'grandstand') standD.push(b.dist);
    if (b.dist > 60) { cells += b.area / 4; continue; }
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const [x, z] of b.p) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    for (let x = bx0 + 1; x < bx1; x += 2) for (let z = bz0 + 1; z < bz1; z += 2) {
      if (!pointInRing(x, z, b.p)) continue;
      cells++;
      if (idx.dist(x, z, 40) < CORRIDOR) inCorr++;
    }
  }
  standD.sort((a, b) => a - b);
  const count = (arr, key, kinds) => Object.fromEntries(kinds.map((k) => [k, arr.filter((o) => o[key] === k).length]));
  const data = {
    buildings: buildings.map((b) => ({ k: b.kind, h: b.h, p: b.p })),
    areas: areas.map((a) => ({ k: a.k, p: a.p })),
    trees: treeOut,
  };
  const stats = {
    b: count(buildings, 'kind', ['grandstand', 'pit', 'tower', 'bridge', 'building']),
    a: count(areas, 'k', AREA_ORDER),
    trees: treeOut.length,
    hTagged: buildings.filter((b) => b.tagged).length,
    corridorShare: cells ? inCorr / cells : 0,
    standDist: standD.length ? { n: standD.length, min: standD[0], med: standD[standD.length >> 1], max: standD[standD.length - 1] } : null,
    seaAdded, coast: coast.length, notes,
  };
  return { data, stats, R, dense };
}

function svg(track, res) {
  const { R, data } = res;
  const col = { urban: '#e4e0da', grass: '#b5d98f', forest: '#4f9a54', asphalt: '#a9a9a9', sand: '#eed58a', water: '#6db3f2' };
  const bcol = { building: '#5a4a42', grandstand: '#e0262b', pit: '#1f4fd8', tower: '#8a2be2', bridge: '#ff8c00' };
  const poly = (p) => p.map((q) => q.join(',')).join(' ');
  const w = R.x1 - R.x0, h = R.z1 - R.z0, sc = 1600 / Math.max(w, h);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w * sc)}" height="${Math.round(h * sc)}" viewBox="${R.x0} ${R.z0} ${w} ${h}">\n<rect x="${R.x0}" y="${R.z0}" width="${w}" height="${h}" fill="#f7f4ec"/>\n`;
  for (const a of data.areas) s += `<polygon points="${poly(a.p)}" fill="${col[a.k]}" fill-rule="evenodd" fill-opacity="0.85"/>\n`;
  s += `<polygon points="${poly(track.points)}" fill="none" stroke="#000" stroke-width="14" stroke-linejoin="round" stroke-opacity="0.75"/>\n`;
  for (const b of data.buildings) s += `<polygon points="${poly(b.p)}" fill="${bcol[b.k]}" fill-opacity="0.9"/>\n`;
  for (const t of data.trees) s += `<circle cx="${t[0]}" cy="${t[1]}" r="3" fill="#0a6b1f"/>\n`;
  s += `<circle cx="${track.points[0][0]}" cy="${track.points[0][1]}" r="12" fill="#ff0"/ stroke="#000" stroke-width="3">`.replace('"/ stroke', '" stroke').replace('>', '/>') + '\n';
  return s + '</svg>\n';
}

// ------------------------------------------------------------------ main
async function main() {
  mkdirSync(CACHE, { recursive: true });
  const w = {};
  new Function('window', readFileSync(TRACKS, 'utf8'))(w);
  const tracks = w.F1_TRACKS;
  if (!Array.isArray(tracks)) throw new Error('tracks-data.js did not define window.F1_TRACKS');

  let features = null;
  try {
    let text;
    if (existsSync(SRC_CACHE)) text = readFileSync(SRC_CACHE, 'utf8');
    else if (!OFFLINE) {
      const res = await fetch(SRC, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      text = await res.text();
      writeFileSync(SRC_CACHE, text, 'utf8');
    }
    if (text) features = new Map(JSON.parse(text).features.map((f) => [String(f.properties.id), f]));
  } catch (e) { console.warn('source GeoJSON unavailable: ' + e.message); }

  const out = {}, report = [];
  let fetched = 0;
  for (const track of tracks) {
    if (ONLY && !ONLY.has(track.id)) continue;
    const { geo, how, res } = resolveGeo(track, features && features.get(track.id));
    if (!geo) { console.warn(`${track.id}: no projection available - skipped`); report.push({ id: track.id, name: track.name, skipped: 'no projection' }); continue; }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of track.points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const lat = (z) => z / geo.kz + geo.lat0, lon = (x) => x / geo.kx + geo.lon0;
    const bbox = { s: lat(z1 + BBOX_MARGIN), n: lat(z0 - BBOX_MARGIN), w: lon(x0 - BBOX_MARGIN), e: lon(x1 + BBOX_MARGIN) };
    if (fetched && !existsSync(join(CACHE, track.id + '.json')) && !OFFLINE) await sleep(REQUEST_GAP_MS);
    const got = await fetchOverpass(track.id, buildQuery(bbox));
    if (!got) { console.warn(`${track.id}: no OSM data - skipped`); report.push({ id: track.id, name: track.name, skipped: 'no OSM data' }); continue; }
    if (!got.cached) fetched++;
    const r = processTrack(track, geo, got.json);
    out[track.id] = r.data;
    const bytes = JSON.stringify(r.data).length;
    report.push({ id: track.id, name: track.name, geo: how, geoMaxErr: res ? res.max : null, elements: got.json.elements.length, cached: got.cached, bytes, ...r.stats });
    const s = r.stats;
    console.log(`${track.id.padEnd(8)} ${track.name.slice(0, 34).padEnd(34)} B ${Object.values(s.b).join('/').padEnd(16)} A ${Object.values(s.a).join('/').padEnd(22)} T ${String(s.trees).padStart(4)}  ${(bytes / 1024).toFixed(0).padStart(4)} kB  corr ${(s.corridorShare * 100).toFixed(1)} %  geo ${how}${res ? ' err ' + res.max.toFixed(2) : ''}${got.cached ? '' : '  [fetched]'}`);
    for (const n of s.notes) console.log('           ' + n);
    if (SVG) { mkdirSync(join(CACHE, 'debug'), { recursive: true }); writeFileSync(join(CACHE, 'debug', track.id + '.svg'), svg(track, r), 'utf8'); }
  }

  // validation
  let bad = 0;
  for (const [id, d] of Object.entries(out)) {
    const okP = (p) => Array.isArray(p) && p.length >= 3 && p.every((q) => q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]));
    for (const b of d.buildings) if (!okP(b.p) || !Number.isFinite(b.h)) { bad++; console.warn(`${id}: bad building`); }
    for (const a of d.areas) if (!okP(a.p)) { bad++; console.warn(`${id}: bad area`); }
    for (const t of d.trees) if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) { bad++; console.warn(`${id}: bad tree`); }
  }
  const header =
`// GENERATED by tools/build-scenery.mjs - do not edit by hand.
// Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright),
// fetched through the Overpass API and reduced to footprints near each circuit.
// Format: window.F1_SCENERY[trackId] = { buildings: [{k, h, p}], areas: [{k, p}], trees: [[x, z]] }
//   coordinates in track metres (same frame as tracks-data.js points), polygons not closed.
//   Area polygons with holes (islands) are emitted as one ring joined by zero-width bridges.
//   areas are ordered bottom to top: ${AREA_ORDER.join(', ')}; larger first within a kind.
`;
  const body = Object.entries(out).map(([id, d]) => `${JSON.stringify(id)}:${JSON.stringify(d)}`).join(',\n');
  const text = `${header}window.F1_SCENERY = {\n${body}\n};\n`;
  writeFileSync(OUT, text, 'utf8');
  writeFileSync(join(CACHE, '_report.json'), JSON.stringify({ report, log }, null, 1), 'utf8');
  console.log(`\n${Object.keys(out).length} track(s) written to ${OUT} (${(text.length / 1048576).toFixed(2)} MB); ${bad} invalid item(s); ${fetched} fetched; ${log.length} API problem line(s).`);
  if (bad) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
