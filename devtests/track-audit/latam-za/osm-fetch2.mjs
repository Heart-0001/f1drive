// node devtests/track-audit/latam-za/osm-fetch2.mjs (osm-fetch.mjs with the mail.ru mirror first: overpass-api.de timed out on 2026-10-01) [id ...]
// One Overpass query per circuit (sequential, backs off on 429 / 504): every highway=raceway way, every way / node with a
// raceway=* tag, every tunnel / bridge / covered way and every pit-related element inside the circuit's bounding box
// (+250 m). Cached as devtests/track-audit/cache/overpass/<id>.json (reused when present). Data (c) OpenStreetMap
// contributors, ODbL.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '..', '..', '..');
const CACHE = resolve(HERE, '..', 'cache', 'overpass');
mkdirSync(CACHE, { recursive: true });
globalThis.window = globalThis;
new Function(readFileSync(resolve(ROOT, 'tracks-data.js'), 'utf8'))();
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['mx-1962', 'br-1940', 'br-1977', 'ar-1952', 'za-1961'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'F1Drive-track-audit/1 (offline game-data check; cached one-off queries)';
const ENDPOINTS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
for (const id of ids) {
  const file = resolve(CACHE, `${id}.json`);
  if (existsSync(file)) { console.log(`${id}: cached`); continue; }
  const t = window.F1_TRACKS.find((q) => q.id === id), g = t.geo;
  let s = 90, w = 180, n = -90, e = -180;
  for (const [x, z] of t.points) {
    const lat = g.lat0 + z / g.kz, lon = g.lon0 + x / g.kx;
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const pad = 250 / 111000, padLon = pad / Math.cos(g.lat0 * Math.PI / 180);
  const bb = `${(s - pad).toFixed(5)},${(w - padLon).toFixed(5)},${(n + pad).toFixed(5)},${(e + padLon).toFixed(5)}`;
  const q = `[out:json][timeout:90];
(
  way["highway"="raceway"](${bb});
  way["raceway"](${bb});
  node["raceway"](${bb});
  node["highway"="raceway"](${bb});
  way["tunnel"](${bb});
  way["bridge"](${bb});
  way["man_made"="bridge"](${bb});
  way["covered"="yes"]["highway"](${bb});
  way["leisure"="track"](${bb});
  way["landuse"="raceway"](${bb});
  way["building"~"grandstand|pit|garage"](${bb});
  way["name"~"[Pp]it|[Bb]ox|[Bb]oxes|[Pp]its"](${bb});
  node["name"~"[Ss]tart|[Ll]argada|[Ss]alida|[Ll]ínea|[Ff]inish"](${bb});
);
out tags geom;`;
  let done = false;
  for (let a = 0; a < 8 && !done; a++) {
    const ep = ENDPOINTS[a % ENDPOINTS.length];
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(150000) });
      if (r.ok) {
        const j = await r.json();
        j._query = { bbox: bb, endpoint: ep, fetched: new Date().toISOString(), query: q };
        writeFileSync(file, JSON.stringify(j));
        console.log(`${id}: ${j.elements.length} elements (${ep})`);
        done = true;
      } else {
        const wait = r.status === 429 || r.status === 504 ? 30000 * (a + 1) : 10000;
        console.log(`${id}: HTTP ${r.status} from ${ep}, waiting ${wait / 1000} s`);
        await sleep(wait);
      }
    } catch (err) { console.log(`${id}: ${err.message}, waiting 20 s`); await sleep(20000); }
  }
  await sleep(5000);
}
