// Builds ../scenery-data.js (window.F1_SCENERY) from OpenStreetMap via the Overpass API.
// Usage: node tools/build-scenery.mjs [--only id,id] [--merge] [--out file] [--offline] [--svg]
//   --only     process just these track ids (the output then contains only those; for testing)
//   --merge    with --only: keep every other track's entry of the existing scenery-data.js as it is (byte for byte)
//              and replace only the listed ones (rebuild a few tracks without the other tracks' cached responses)
//   --out f    write there instead of scenery-data.js (--merge still starts from scenery-data.js)
//   --offline  never touch the network (tracks without a cached response are skipped)
//   --svg      write a top-down debug SVG per track into tools/scenery-cache/debug/
// No npm dependencies (global fetch, Node 18+). Raw Overpass responses are cached in
// tools/scenery-cache/<trackId>.json; delete a file to refetch that track.
// Map data (c) OpenStreetMap contributors, ODbL 1.0.
//
// Structures over the lap (2026-10-01 audit, docs/track-audit.md; js/scenery.js builds every 'bridge' entry that holds
// part of the lap as a deck OVER the road):
//   - A man_made=bridge outline holding part of the lap is the LAP'S OWN DECK (left out) when the lap's road is a bridge
//     inside it (a way running along the lap there is bridge=*), or a tunnel=* / layer < 0 / man_made=tunnel / waterway
//     crosses the lap inside it, and no other road / railway with a layer above the lap's crosses the lap inside it.
//   - Linear bridges: a highway / railway way with bridge=* and a layer above the lap's that crosses the lap at 25 deg or
//     more (not inside a mapped bridge outline) becomes a deck strip: the way's piece out to DECK_REACH m from the
//     lap on both sides (at most DECK_WALK along the way, and only while it keeps its direction: a return ramp beside
//     the track is not decked), buffered to its width (width / lanes / road class), carried on straight where the way
//     ends nearer (a bridge way stops at its abutments; the deck must reach past the corridor for its piers), joined
//     with the neighbouring strips of the same level into one deck. Two levels above the lap and up: higher decks (c).
//   - A building / building:part with min_height >= 5 m holding part of the lap (a building spanning the road: the
//     Silverstone Wing footbridge, Shanghai's grandstand wings) becomes a deck from min_height to its height.
//   - None of these over a covered stretch of js/tunnels.js (tools/tunnels.json: Monaco, Madring, Monza, Singapore's
//     Raffles passages, Yas Marina's W hotel): the tunnel module builds the structure there.
//   Bridge entries carry o (OSM way id), and c (underside above the road, m) / t (deck thickness, m) when not the
//   defaults (js/scenery.js: underside >= 6.5 m above the road, 1.4 m thick).
// Pit buildings: buildings named as pits count only within 450 m of the line; otherwise the heuristic also looks for
// the long building beside the line (Silverstone: the Wing since 2011, not the old National pits 1.2 km away).
// js/track.js puts the pit lane on the side of the 'pit' buildings (where tracks-data.js gives no pitSide): after a
// rebuild, node devtests/scenery-test/pitside.js <old scenery-data file> shows whether any track's pit lane moved.
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
const REQUEST_GAP_MS = 10000;  // one request at a time, 10 s apart (Overpass usage policy)
const MAX_BUILDINGS = 1500, MAX_AREAS = 400, MAX_TREES = 1500;
const MIN_BUILDING_AREA = 25;
const TOL_BUILDING = 1, TOL_AREA = 3;
const CORRIDOR = 12;         // m, wall distance used by js/track.js
const DENSE_CITY = 400;      // more buildings than this near the track => vary default heights
const AREA_ORDER = ['urban', 'grass', 'forest', 'asphalt', 'sand', 'water'];
const TUNNELS = join(HERE, 'tunnels.json');
// structures over the lap (see the header)
const LAP_WAY_D = 10;        // m: a way this close to the centreline, running along it (< LAP_WAY_ANG), is the lap's road
const LAP_WAY_ANG = 25;      // deg
const CROSS_ANG = 25;        // deg: a bridge way crossing the lap at a smaller angle is not an overpass
const DECK_REACH = 30;       // m from the centreline: a linear deck runs out to this on both sides (piers clear of the
                             // corridor and, beside the line, of the pit lane), not further (it is flat: no ramps)
const DECK_WALK = 45;        // m along its way from the crossing at most, each way (a ramp running beside the lap is
                             // not followed: at 25 deg 45 m is 19 m out)
const DECK_TURN = 40;        // deg: the way's direction may differ this much from its direction at the crossing
const DECK_CLEAR_MIN = 18;   // m from the centreline: a piece ending nearer is carried on straight (piers off the road)
const DECK_MAX_ALONG = 60;   // m of lap under one deck at most (js/scenery.js leaves longer ones out)
const DECK_H = 7.9;          // deck top above the lowest ground (js/scenery.js raises it to 6.5 m clear of the road)
const DECK_LAYER_STEP = 6;   // m higher underside per layer above the first
const DECK_MIN_HEIGHT = 5;   // building / building:part min_height (m) that makes a spanning building a deck
const TUNNEL_MARGIN = 15;    // m: no deck this close to a covered stretch of tools/tunnels.json

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const ONLY = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const OFFLINE = flag('--offline'), SVG = flag('--svg'), MERGE = flag('--merge');
const OUT_FILE = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : OUT;

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
  way["highway"="raceway"];
  way["bridge"]["bridge"!="no"];
  way["tunnel"]["tunnel"!="no"];
  way["man_made"="tunnel"];
  way["layer"]["layer"!="0"];
  way["waterway"~"^(river|stream|canal|ditch|drain)$"];
  way["building:part"]["min_height"];
);
out geom;`;
}
const log = [];
// the query's shape (bbox left out) tags each cached response: a response of an older query (without the ways the
// structure rules need) is fetched again, or used as it is with --offline
function queryTag(query) {
  const s = query.replace(/\[bbox:[^\]]*\]/, '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
async function fetchOverpass(id, query) {
  const file = join(CACHE, id + '.json'), tag = queryTag(query);
  let stale = null;
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(j.elements)) {
        if (j.f1driveQuery === tag) return { json: j, cached: true };
        stale = j;
      }
    } catch { /* refetch */ }
  }
  if (OFFLINE) {
    if (stale) { log.push(`${id}: cached response of an older query used (--offline): no structure rules`); return { json: stale, cached: true }; }
    return null;
  }
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
          j.f1driveQuery = tag;
          j.f1driveFetched = new Date().toISOString();
          writeFileSync(file, JSON.stringify(j), 'utf8');
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

// ------------------------------------------------------------------ structures over the lap (see the header)
const isNo = (v) => v === undefined || v === null || v === '' || v === 'no';
function layerOf(t) {
  const n = parseInt(String(t.layer === undefined ? '' : t.layer).split(';')[0], 10);
  if (Number.isFinite(n)) return n;
  if (!isNo(t.bridge)) return 1;
  if (!isNo(t.tunnel)) return -1;
  return 0;
}
function widthOf(t) {
  const w = parseFloat(String(t.width === undefined ? '' : t.width).replace(',', '.'));
  if (Number.isFinite(w) && w >= 1.5 && w <= 60) return w;
  const lanes = parseInt(t.lanes, 10), h = t.highway || '', r = t.railway || '';
  if (h && Number.isFinite(lanes) && lanes > 0 && lanes < 12) return lanes * 3.5 + 1.5;
  if (r) return r === 'monorail' ? 3.5 : (r === 'tram' ? 7 : 8);
  if (/^(motorway|trunk)$/.test(h)) return 12;
  if (/_link$/.test(h)) return 7;
  if (/^(primary|secondary)$/.test(h)) return 10;
  if (/^(tertiary|unclassified|residential|living_street)$/.test(h)) return 8;
  if (/^(service|track|busway|road)$/.test(h)) return 6;
  if (/^(footway|path|cycleway|steps|pedestrian|bridleway|corridor)$/.test(h)) return 3.5;
  return 6;
}
function segDist(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t);
}
// inside the ring or within m of its outline
function nearRing(x, z, ring, m) {
  if (pointInRing(x, z, ring)) return true;
  for (let i = 0; i < ring.length; i++) if (segDist(x, z, ring[i], ring[(i + 1) % ring.length]) < m) return true;
  return false;
}
function ringBox(r) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}
function segsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return (o(c, d, a) > 0) !== (o(c, d, b) > 0) && (o(a, b, c) > 0) !== (o(a, b, d) > 0);
}
function ringsOverlap(p, q) {
  if (p.some(([x, z]) => pointInRing(x, z, q)) || q.some(([x, z]) => pointInRing(x, z, p))) return true;
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) {
    if (segsCross(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
  }
  return false;
}
function ringGap(p, q) { // least distance between two outlines (0 when they overlap)
  if (ringsOverlap(p, q)) return 0;
  let d = Infinity;
  for (const [x, z] of p) for (let j = 0; j < q.length; j++) d = Math.min(d, segDist(x, z, q[j], q[(j + 1) % q.length]));
  for (const [x, z] of q) for (let i = 0; i < p.length; i++) d = Math.min(d, segDist(x, z, p[i], p[(i + 1) % p.length]));
  return d;
}
function selfCrossing(p) {
  const n = p.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
  }
  return false;
}
function convexHull(pts) { // monotone chain, counter-clockwise in (x, z)
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// a polyline buffered by hw on both sides (mitred joins, limited to 2 hw)
function bufferLine(pts, hw) {
  const n = pts.length, L = [], R = [];
  const nrm = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [-dz / l, dx / l]; };
  for (let i = 0; i < n; i++) {
    const na = i > 0 ? nrm(pts[i - 1], pts[i]) : nrm(pts[0], pts[1]);
    const nb = i < n - 1 ? nrm(pts[i], pts[i + 1]) : na;
    let mx = na[0] + nb[0], mz = na[1] + nb[1], ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = na[0]; mz = na[1]; ml = 1; }
    mx /= ml; mz /= ml;
    const k = Math.min(2, 1 / Math.max(0.5, mx * na[0] + mz * na[1]));
    L.push([pts[i][0] + mx * hw * k, pts[i][1] + mz * hw * k]);
    R.push([pts[i][0] - mx * hw * k, pts[i][1] - mz * hw * k]);
  }
  return L.concat(R.reverse());
}
// The lap as a closed polyline (dense: <= 4 m) with tangents, arc length and a grid of its segments.
function lapModel(dense) {
  const n = dense.length, tx = new Float64Array(n), tz = new Float64Array(n), cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = dense[(i - 1 + n) % n], b = dense[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    tx[i] = (b[0] - a[0]) / l; tz[i] = (b[1] - a[1]) / l;
    const c = dense[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(c[0] - dense[i][0], c[1] - dense[i][1]);
  }
  const CS = 40, cells = new Map(), key = (i, j) => i * 100003 + j;
  for (let i = 0; i < n; i++) {
    const a = dense[i], b = dense[(i + 1) % n];
    for (let ci = Math.floor(Math.min(a[0], b[0]) / CS); ci <= Math.floor(Math.max(a[0], b[0]) / CS); ci++) {
      for (let cj = Math.floor(Math.min(a[1], b[1]) / CS); cj <= Math.floor(Math.max(a[1], b[1]) / CS); cj++) {
        const k = key(ci, cj);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(i);
      }
    }
  }
  // crossings of the segment a-b with the lap: [{i (lap segment), u (0..1 along a-b), x, z, ang (deg, 0..90)}]
  function crossings(a, b) {
    const seen = new Set(), out = [];
    for (let ci = Math.floor(Math.min(a[0], b[0]) / CS); ci <= Math.floor(Math.max(a[0], b[0]) / CS); ci++) {
      for (let cj = Math.floor(Math.min(a[1], b[1]) / CS); cj <= Math.floor(Math.max(a[1], b[1]) / CS); cj++) {
        for (const i of cells.get(key(ci, cj)) || []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const q = dense[i], q2 = dense[(i + 1) % n];
          const rx = b[0] - a[0], rz = b[1] - a[1], sx = q2[0] - q[0], sz = q2[1] - q[1], rs = rx * sz - rz * sx;
          if (Math.abs(rs) < 1e-12) continue;
          const qx = q[0] - a[0], qz = q[1] - a[1], u = (qx * sz - qz * sx) / rs, v = (qx * rz - qz * rx) / rs;
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;
          const cosA = Math.abs(rx * sx + rz * sz) / ((Math.hypot(rx, rz) * Math.hypot(sx, sz)) || 1);
          out.push({ i, u, x: a[0] + rx * u, z: a[1] + rz * u, ang: Math.acos(Math.min(1, cosA)) * 180 / Math.PI });
        }
      }
    }
    return out;
  }
  return { n, dense, tx, tz, cum, len: cum[n], crossings };
}
// Lines (ways that are not footprints) with what the rules need: layer, the samples where they run along the lap
// (the lap's own roads), their crossings with the lap.
function prepLine(L, lap, idx) {
  L.layer = layerOf(L.t);
  L.isRoad = !!(L.t.highway || L.t.railway);
  L.along = [];
  L.cross = [];
  L.arc = [0];
  for (let s = 0; s + 1 < L.pts.length; s++) {
    const a = L.pts[s], b = L.pts[s + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    L.arc.push(L.arc[s] + len);
    for (const c of lap.crossings(a, b)) L.cross.push(Object.assign(c, { seg: s, pos: L.arc[s] + c.u * len }));
    if (!L.isRoad || len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len, k = Math.max(1, Math.ceil(len / 3));
    for (let j = 0; j < k; j++) {
      const x = a[0] + (b[0] - a[0]) * (j + 0.5) / k, z = a[1] + (b[1] - a[1]) * (j + 0.5) / k;
      const q = idx.nearest(x, z, LAP_WAY_D);
      if (q.i < 0) continue;
      if (Math.abs(ux * lap.tx[q.i] + uz * lap.tz[q.i]) >= Math.cos(LAP_WAY_ANG * Math.PI / 180)) L.along.push([x, z]);
    }
  }
}
// dense lap indices inside a ring
function lapInside(ring, lap) {
  const b = ringBox(ring), out = [];
  for (let i = 0; i < lap.n; i++) {
    const [x, z] = lap.dense[i];
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && pointInRing(x, z, ring)) out.push(i);
  }
  return out;
}
// A man_made=bridge outline holding part of the lap: the lap's own deck, or a structure over the lap?
function classifyOutline(ring, lines) {
  const b = ringBox(ring), pad = 4;
  const inR = (x, z) => x >= b.x0 - pad && x <= b.x1 + pad && z >= b.z0 - pad && z <= b.z1 + pad && nearRing(x, z, ring, 3);
  const lapWays = lines.filter((L) => L.along.filter(([x, z]) => inR(x, z)).length >= 2);
  const lapLayer = lapWays.length ? Math.max(...lapWays.map((L) => L.layer)) : 0;
  const lapBridge = lapWays.some((L) => !isNo(L.t.bridge));
  const under = [], over = [];
  for (const L of lines) {
    if (lapWays.includes(L)) continue;
    const cr = L.cross.filter((c) => inR(c.x, c.z));
    if (!cr.length) continue;
    const t = L.t;
    if (!isNo(t.tunnel) || t.man_made === 'tunnel' || L.layer < 0 || (t.waterway && isNo(t.bridge))) under.push(L.id);
    else if (L.isRoad && L.layer > lapLayer && cr.some((c) => c.ang >= 10)) over.push(L.id);
  }
  return { lapLayer, lapBridge, lapWays: lapWays.map((L) => L.id), under, over, lapDeck: (lapBridge || under.length > 0) && !over.length };
}
// covered stretches of tools/tunnels.json as a test on dense lap indices (with TUNNEL_MARGIN)
let tunnelJson;
function tunnelTest(id, geo, lap) {
  if (tunnelJson === undefined) {
    try { tunnelJson = JSON.parse(readFileSync(TUNNELS, 'utf8')).tracks || {}; } catch { tunnelJson = {}; }
  }
  const list = tunnelJson[id] || [], n = lap.n, mask = new Uint8Array(n), ranges = [];
  const locate = (ll, f) => {
    const x = (ll[1] - geo.lon0) * geo.kx, z = (ll[0] - geo.lat0) * geo.kz;
    const hint = Number.isFinite(f) ? Math.round((f - Math.floor(f)) * n) : -1, win = Math.max(40, Math.round(n * 0.06));
    let best = -1, bd = Infinity;
    for (let q = hint >= 0 ? -win : 0; q <= (hint >= 0 ? win : n - 1); q++) {
      const i = hint >= 0 ? ((hint + q) % n + n) % n : q, d = (lap.dense[i][0] - x) ** 2 + (lap.dense[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const step = lap.len / n, m = Math.ceil(TUNNEL_MARGIN / step);
  for (const t of list) {
    if (!t || !t.from || !t.to) continue;
    const a = locate(t.from, t.fFrom), b = locate(t.to, t.fTo);
    if (a < 0 || b < 0) continue;
    const K = ((b - a) % n + n) % n;
    if (K > n / 2) continue;
    for (let k = -m; k <= K + m; k++) mask[((a + k) % n + n) % n] = 1;
    ranges.push({ name: t.name, s: [Math.round(lap.cum[a]), Math.round(lap.cum[b])] });
  }
  return { covered: (i) => mask[((i % n) + n) % n] === 1, ranges };
}
// Linear bridges over the lap -> deck strips [{p, rel, ids, dir, area, why}] (one per run of a way near the lap)
function linearDecks(lines, lap, idx, outlines, covered, notes) {
  const pieces = [], skipped = {};
  const skip = (why, id) => { (skipped[why] = skipped[why] || []).push(id); };
  for (const L of lines) {
    const t = L.t;
    if (!L.isRoad || isNo(t.bridge) || t.highway === 'raceway' || t.sport === 'motor') continue;
    if (/^(proposed|construction|abandoned|razed|disused)$/.test(t.highway || t.railway || '')) continue;
    const ok = [];
    for (const c of L.cross) {
      if (c.ang < CROSS_ANG) { skip('angle', L.id); continue; }
      const lapRoads = lines.filter((M) => M !== L && M.along.some(([x, z]) => (x - c.x) ** 2 + (z - c.z) ** 2 < 400));
      const lapLayer = lapRoads.length ? Math.max(...lapRoads.map((M) => M.layer)) : 0;
      if (L.layer <= lapLayer) { skip('level', L.id); continue; }
      if (outlines.some((r) => nearRing(c.x, c.z, r, 3))) { skip('outline', L.id); continue; }
      if (covered(c.i)) { skip('tunnel', L.id); continue; }
      // levels above the lap: layer 1 over a lap at 0 or -1 is one level up, layer 2 two (layer - lapLayer when the lap
      // itself is raised)
      ok.push(Object.assign({}, c, { rel: Math.max(1, Math.min(L.layer, L.layer - lapLayer)) }));
    }
    if (!ok.length) continue;
    // the way densified (<= 3 m) with its arc length and distance to the lap
    const D = [], pos = [];
    for (let s = 0; s + 1 < L.pts.length; s++) {
      const a = L.pts[s], b = L.pts[s + 1], len = L.arc[s + 1] - L.arc[s], k = Math.max(1, Math.ceil(len / 3));
      for (let j = 0; j < k; j++) { D.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]); pos.push(L.arc[s] + len * j / k); }
    }
    D.push(L.pts[L.pts.length - 1]); pos.push(L.arc[L.arc.length - 1]);
    const dist = D.map(([x, z]) => idx.dist(x, z, 400));
    ok.sort((a, b) => a.pos - b.pos);
    let lastB = -1;
    for (const c of ok) {
      let k = 0;
      while (k + 1 < D.length && pos[k + 1] <= c.pos) k++;
      if (k <= lastB) continue;                         // in the previous run already
      let a = k, b = Math.min(k + 1, D.length - 1);
      // out from the crossing while near the lap, at most DECK_WALK, and while the way keeps (within DECK_TURN) the
      // direction it crosses the lap in (a footbridge's return ramp beside the track is not decked)
      const sa = L.pts[c.seg], sb = L.pts[c.seg + 1], sl = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]) || 1;
      const straight = (i, j) => {
        const dx = D[j][0] - D[i][0], dz = D[j][1] - D[i][1], l = Math.hypot(dx, dz);
        return l < 1e-6 || (dx * (sb[0] - sa[0]) + dz * (sb[1] - sa[1])) / (l * sl) >= Math.cos(DECK_TURN * Math.PI / 180);
      };
      while (a > 0 && dist[a] < DECK_REACH && c.pos - pos[a - 1] <= DECK_WALK && straight(a - 1, a)) a--;
      while (b < D.length - 1 && dist[b] < DECK_REACH && pos[b + 1] - c.pos <= DECK_WALK && straight(b, b + 1)) b++;
      lastB = b;
      let pts = D.slice(a, b + 1);
      // a way that ends near the lap (the bridge way stops at its abutment): carried on straight
      const carry = (end, prev) => {
        const dx = end[0] - prev[0], dz = end[1] - prev[1], l = Math.hypot(dx, dz) || 1, out = [];
        for (let e = 2; e <= 40; e += 2) {
          const q = [end[0] + dx / l * e, end[1] + dz / l * e];
          out.push(q);
          if (idx.dist(q[0], q[1], 400) >= DECK_REACH) break;
        }
        return out;
      };
      // carried on straight where the way itself ends near the lap, or where the piece still ends over the corridor
      if (pts.length >= 2 && ((a === 0 && dist[a] < DECK_REACH) || dist[a] < DECK_CLEAR_MIN)) pts = carry(pts[0], pts[1]).reverse().concat(pts);
      if (pts.length >= 2 && ((b === D.length - 1 && dist[b] < DECK_REACH) || dist[b] < DECK_CLEAR_MIN)) pts = pts.concat(carry(pts[pts.length - 1], pts[pts.length - 2]));
      pts = dpOpen(dedupe(pts, 0.3), 0.5);
      if (pts.length < 2) continue;
      let p = bufferLine(pts, widthOf(t) / 2 + 0.5);
      if (selfCrossing(p)) p = convexHull(p);
      p = dedupe(p.map(([x, z]) => [r1(x), r1(z)]));
      if (p.length < 3) continue;
      const along = lapInside(p, lap).length * lap.len / lap.n;
      if (along > DECK_MAX_ALONG) { skip('along', L.id); notes.push(`deck: way ${L.id} would hold ${along.toFixed(0)} m of the lap - left out`); continue; }
      const f = pts[0], g = pts[pts.length - 1], dl = Math.hypot(g[0] - f[0], g[1] - f[1]) || 1;
      const rel = Math.max(...ok.filter((q) => q.pos >= pos[a] - 1 && q.pos <= pos[b] + 1).map((q) => q.rel));
      pieces.push({ p, rel, ids: [L.id], dir: [(g[0] - f[0]) / dl, (g[1] - f[1]) / dl], area: Math.abs(ringArea(p)),
        s: Math.round(lap.cum[c.i]) });
    }
  }
  // neighbouring strips of the same level (parallel carriageways, a road and its footway) -> one deck
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < pieces.length && !changed; i++) for (let j = i + 1; j < pieces.length && !changed; j++) {
      const A = pieces[i], B = pieces[j];
      if (A.rel !== B.rel || Math.abs(A.dir[0] * B.dir[0] + A.dir[1] * B.dir[1]) < Math.cos(25 * Math.PI / 180)) continue;
      if (ringGap(A.p, B.p) > 2.5) continue;
      const h = convexHull(A.p.concat(B.p)), ha = Math.abs(ringArea(h));
      if (ha > 1.5 * (A.area + B.area)) continue;
      if (lapInside(h, lap).length * lap.len / lap.n > DECK_MAX_ALONG) continue;
      pieces[i] = { p: h.map(([x, z]) => [r1(x), r1(z)]), rel: A.rel, ids: A.ids.concat(B.ids), dir: A.dir, area: ha, s: Math.min(A.s, B.s) };
      pieces.splice(j, 1);
      changed = true;
    }
  }
  // decks that still overlap at the same level: each later one a little higher (no shared plane)
  for (let i = 0; i < pieces.length; i++) {
    pieces[i].bump = 0;
    for (let j = 0; j < i; j++) {
      if (pieces[j].rel === pieces[i].rel && ringsOverlap(pieces[i].p, pieces[j].p)) pieces[i].bump = Math.max(pieces[i].bump, pieces[j].bump + 0.35);
    }
  }
  for (const [why, ids] of Object.entries(skipped)) notes.push(`deck: bridge way crossings not decked (${why}): ${[...new Set(ids)].join(' ')}`);
  return pieces;
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
    const raw = ring;
    ring = dedupe(simplifyRing(ring, TOL_BUILDING).map(([x, z]) => [r1(x), r1(z)]));
    const area = Math.abs(ringArea(ring));
    if (ring.length < 3 || area < MIN_BUILDING_AREA) return;
    const t = el.tags || {};
    let h = parseHeight(t.height);
    if (!Number.isFinite(h)) h = parseHeight(t['building:height']);
    if (!Number.isFinite(h) && Number.isFinite(parseFloat(t['building:levels']))) h = parseFloat(t['building:levels']) * 3.2;
    rawB.push({ id: el.id, kind, h, tagged: Number.isFinite(h), p: ring, area, dist, c, tags: t, raw });
  };
  const lines = [], spans = [];   // for the structures over the lap (see the header)
  const isLine = (t) => (t.highway || t.railway || t.waterway || t.man_made === 'tunnel') && t.area !== 'yes' &&
    !(t.building && t.building !== 'no') && !t['building:part'];
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
      if (isLine(t) && g.length >= 2) {
        const lp = proj(g).filter((q, i, a) => i === 0 || Math.abs(q[0] - a[i - 1][0]) > 0.05 || Math.abs(q[1] - a[i - 1][1]) > 0.05);
        if (lp.length >= 2) lines.push({ id: el.id, t, pts: lp });
      }
      if (!isClosed(g)) continue;
      if (((t.building && t.building !== 'no') || t['building:part']) && parseHeight(t.min_height) >= DECK_MIN_HEIGHT) {
        spans.push({ id: el.id, t, ring: dedupe(proj(g).slice(0, -1)) });
      }
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

  // ---- structures over the lap (see the header)
  const lap = lapModel(dense);
  for (const L of lines) prepLine(L, lap, idx);
  const tun = tunnelTest(track.id, geo, lap);
  if (tun.ranges.length) notes.push('covered stretches (tools/tunnels.json): ' + tun.ranges.map((r) => `${r.name} s ${r.s.join('-')}`).join(', '));
  const decks = { lap: [], over: [], linear: [], spans: [], covered: [] };
  const outlineRings = [];
  for (let i = rawB.length - 1; i >= 0; i--) {
    const b = rawB[i];
    if (b.kind !== 'bridge') continue;
    outlineRings.push(b.raw);
    const holds = lapInside(b.raw, lap);
    if (!holds.length) continue;
    const s = Math.round(lap.cum[holds[0]]);
    if (holds.some(tun.covered)) {
      rawB.splice(i, 1); decks.covered.push(b.id);
      notes.push(`bridge outline ${b.id} at s ${s}: over a covered stretch (js/tunnels.js builds it) - left out`);
      continue;
    }
    const v = classifyOutline(b.raw, lines);
    if (v.lapDeck) {
      rawB.splice(i, 1); decks.lap.push(b.id);
      notes.push(`bridge outline ${b.id} at s ${s}: the lap's own deck (lap ways ${v.lapWays.join(' ') || '-'}` +
        `${v.lapBridge ? ' on a bridge' : ''}, under it ${v.under.join(' ') || '-'}) - left out`);
    } else {
      decks.over.push(b.id);
      notes.push(`bridge outline ${b.id} at s ${s}: over the lap (over it ${v.over.join(' ') || '-'}, under ${v.under.join(' ') || '-'}, lap layer ${v.lapLayer})`);
    }
  }
  for (const B of spans) {
    if (B.ring.length < 3) continue;
    const holds = lapInside(B.ring, lap);
    if (!holds.length) continue;
    const s = Math.round(lap.cum[holds[0]]);
    if (holds.some(tun.covered)) { decks.covered.push(B.id); notes.push(`spanning building ${B.id} at s ${s}: over a covered stretch (js/tunnels.js) - left to it`); continue; }
    const mh = parseHeight(B.t.min_height);
    let h = parseHeight(B.t.height);
    if (!(h > mh + 0.5)) h = mh + 4;
    for (let i = rawB.length - 1; i >= 0; i--) if (rawB[i].id === B.id) rawB.splice(i, 1);
    const p = dedupe(simplifyRing(B.ring, TOL_BUILDING).map(([x, z]) => [r1(x), r1(z)]));
    if (p.length < 3) continue;
    rawB.push({ id: B.id, kind: 'bridge', h: r1(h), cl: r1(mh), th: r1(h - mh), tagged: true, p, area: Math.abs(ringArea(p)), dist: 0, c: centroid(p), tags: B.t });
    decks.spans.push(B.id);
    notes.push(`spanning building ${B.id} at s ${s}: deck ${mh}..${r1(h)} m`);
  }
  for (const B of spans) if (decks.spans.includes(B.id)) outlineRings.push(B.ring);   // its indoor footway: not a deck too
  for (const pc of linearDecks(lines, lap, idx, outlineRings, tun.covered, notes)) {
    const lift = (pc.rel - 1) * DECK_LAYER_STEP + pc.bump;
    rawB.push({ id: pc.ids[0], kind: 'bridge', h: r1(DECK_H + lift), cl: lift > 0 ? r1(6.5 + lift) : undefined, tagged: true,
      p: pc.p, area: pc.area, dist: 0, c: centroid(pc.p), tags: {} });
    decks.linear.push(pc.ids.join('+'));
    notes.push(`deck from bridge way(s) ${pc.ids.join(' ')} at s ${pc.s}: ${Math.round(pc.area)} m2, layer +${pc.rel}${lift ? ', underside ' + r1(6.5 + lift) + ' m' : ''}`);
  }

  // ---- buildings: pit heuristic, heights, caps
  const dense_city = rawB.length > DENSE_CITY;
  // a building named as a pit counts when it stands near the line (Silverstone: the old National pits are 1.2 km from
  // the Wing, where the line is since 2011); otherwise the heuristic looks for the pit building beside the line
  const nearLine = (b) => Math.hypot(b.c[0] - pts[0][0], b.c[1] - pts[0][1]) <= 450;
  if (!rawB.some((b) => b.kind === 'pit' && nearLine(b))) {
    if (rawB.some((b) => b.kind === 'pit')) notes.push('pit: the buildings named as pits are far from the line - heuristic too');
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
    buildings: buildings.map((b) => {
      const o = { k: b.kind, h: b.h, p: b.p };
      if (b.kind === 'bridge') {
        if (b.id) o.o = b.id;
        if (b.cl !== undefined) o.c = b.cl;
        if (b.th !== undefined) o.t = b.th;
      }
      return o;
    }),
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
    seaAdded, coast: coast.length, decks, notes,
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
//   'bridge' buildings of the tracks built since 2026-10-01 also carry o (OSM way id) and, where not the defaults,
//   c (underside above the road, m) and t (deck thickness, m); see the header of tools/build-scenery.mjs.
`;
  // --merge: the other tracks' lines of the existing file are kept as they are (same order; new tracks at the end)
  let entries = Object.entries(out).map(([id, d]) => [id, `${JSON.stringify(id)}:${JSON.stringify(d)}`]);
  if (MERGE) {
    if (!ONLY) throw new Error('--merge needs --only');
    const old = existsSync(OUT) ? readFileSync(OUT, 'utf8').split(/\r?\n/) : [];   // a CRLF checkout too
    const kept = [];
    for (const line of old) {
      const m = /^"([^"]+)":\{/.exec(line);
      if (!m) continue;
      const id = m[1];
      kept.push([id, id in out ? `${JSON.stringify(id)}:${JSON.stringify(out[id])}` : line.replace(/,$/, '')]);
    }
    for (const [id, l] of entries) if (!kept.some((k) => k[0] === id)) kept.push([id, l]);
    const lost = ONLY ? [...ONLY].filter((id) => !(id in out)) : [];
    if (lost.length) console.warn(`--merge: not rebuilt (kept as they were): ${lost.join(', ')}`);
    entries = kept;
  }
  const body = entries.map((e) => e[1]).join(',\n');
  const text = `${header}window.F1_SCENERY = {\n${body}\n};\n`;
  writeFileSync(OUT_FILE, text, 'utf8');
  writeFileSync(join(CACHE, '_report.json'), JSON.stringify({ report, log }, null, 1), 'utf8');
  console.log(`\n${entries.length} track(s) written to ${OUT_FILE} (${Object.keys(out).length} built; ${(text.length / 1048576).toFixed(2)} MB); ${bad} invalid item(s); ${fetched} fetched; ${log.length} API problem line(s).`);
  if (bad) process.exitCode = 1;
}

export { processTrack, classifyOutline, linearDecks, lapModel, prepLine, layerOf, widthOf, buildQuery, queryTag };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
