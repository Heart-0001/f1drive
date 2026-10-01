// node devtests/tunnel-test/osm-fetch.mjs [trackId ...]
// Fetches from OpenStreetMap (Overpass API, ODbL) every way near each circuit that is covered: tunnel=* (not "no"),
// covered=yes, or a raceway on a negative layer, plus bridges / buildings that pass OVER the circuit (man_made=bridge,
// building with a layer / min_height, highway bridges). Raw responses are cached in devtests/tunnel-test/cache/<id>.json
// (re-runs do not refetch). The bbox of each track comes from tracks-data.js's geo projection (inverse of
// x = (lon - lon0) * kx, z = (lat - lat0) * kz) grown by 60 m.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CACHE = join(HERE, 'cache');
const UA = 'F1Drive-tunnel-test/1 (offline game data check; cached, one-off requests)';
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w = {};
(new Function('window', readFileSync(join(ROOT, 'tracks-data.js'), 'utf8')))(w);
const TRACKS = w.F1_TRACKS;

export function bboxOf(t, pad = 60) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of t.points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const g = t.geo;
  const lonA = (minX - pad) / g.kx + g.lon0, lonB = (maxX + pad) / g.kx + g.lon0;
  const latA = (minZ - pad) / g.kz + g.lat0, latB = (maxZ + pad) / g.kz + g.lat0;
  return { s: Math.min(latA, latB), n: Math.max(latA, latB), w: Math.min(lonA, lonB), e: Math.max(lonA, lonB) };
}

function query(b) {
  const bb = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  return `[out:json][timeout:90][bbox:${bb}];
(
  way["tunnel"]["tunnel"!="no"];
  way["covered"]["covered"!="no"];
  way["highway"="raceway"]["layer"~"^-"];
  way["man_made"="bridge"];
  way["bridge"]["bridge"!="no"]["highway"];
  way["bridge"]["bridge"!="no"]["railway"];
  way["building"]["layer"];
  way["building"]["min_height"];
  way["building:part"]["min_height"];
  way["building"="bridge"];
  way["highway"="raceway"];
);
out geom tags;`;
}

async function fetchOne(t) {
  const file = join(CACHE, t.id + '.json');
  if (existsSync(file)) {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(j.elements)) return { j, cached: true }; } catch (e) { /* refetch */ }
  }
  const q = query(bboxOf(t));
  for (let a = 0; a < 8; a++) {
    const ep = ENDPOINTS[a % ENDPOINTS.length];
    let why = '';
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(130000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, 'Accept': 'application/json' } });
      const text = await res.text();
      if (res.ok) {
        let j = null;
        try { j = JSON.parse(text); } catch (e) { why = 'non-JSON'; }
        if (j && Array.isArray(j.elements) && !(j.remark && /error|timed out|out of memory/i.test(j.remark))) {
          j.__fetched = { at: new Date().toISOString(), endpoint: ep, query: q };
          writeFileSync(file, JSON.stringify(j), 'utf8');
          return { j, cached: false };
        }
        if (j && j.remark) why = 'remark ' + j.remark;
      } else why = 'HTTP ' + res.status;
    } catch (e) { why = String(e.message || e); }
    const wait = Math.min(60000, 5000 * 2 ** a);
    console.warn(`  ${t.id}: ${new URL(ep).host} failed (${why}), retry in ${wait / 1000} s`);
    await sleep(wait);
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(CACHE, { recursive: true });
  const want = process.argv.slice(2);
  for (const t of TRACKS) {
    if (want.length && !want.includes(t.id)) continue;
    const r = await fetchOne(t);
    console.log(`${t.id.padEnd(8)} ${r ? r.j.elements.length + ' ways' + (r.cached ? ' (cached)' : '') : 'FAILED'}`);
    if (r && !r.cached) await sleep(1500);
  }
}
