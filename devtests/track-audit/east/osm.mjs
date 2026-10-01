// node devtests/track-audit/east/osm.mjs <id> [...ids]
// Fetches the OpenStreetMap raceway data (ODbL) around a circuit from the Overpass API, one query at a time, and caches
// the raw response in devtests/track-audit/cache/overpass/east-<id>.json (re-runs never refetch).
// Query: every way tagged highway=raceway (track, pit lane, other layouts), every node / way with a raceway=* or
// "start-finish"-like tag, tunnels / bridges / covered ways on them, and the relations that hold those ways.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '..', 'cache', 'overpass');
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

for (const id of process.argv.slice(2)) {
  const file = resolve(CACHE, `east-${id}.json`);
  if (existsSync(file)) { console.log(id, 'cached'); continue; }
  const g = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of g.samples) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  const padLat = 400 / 111000, padLon = 400 / (111000 * Math.cos(s * Math.PI / 180));
  const bb = [s - padLat, w - padLon, n + padLat, e + padLon].map((v) => v.toFixed(5)).join(',');
  const q = `[out:json][timeout:90];
(
  way["highway"="raceway"](${bb});
  node["raceway"](${bb});
  node["highway"="raceway"](${bb});
  way["raceway"](${bb});
  node["name"~"start|finish|largada|chegada",i](${bb});
  way["leisure"="track"]["sport"="motor"](${bb});
  way["landuse"="raceway"](${bb});
  way["tunnel"]["highway"](${bb});
  way["covered"="yes"]["highway"](${bb});
  way["bridge"]["highway"](${bb});
)->.a;
.a out body geom;
way["highway"="raceway"](${bb})->.r;
rel(bw.r);
out body;
`;
  let done = false;
  for (let a = 0; a < 12 && !done; a++) {
    const ep = ENDPOINTS[a % ENDPOINTS.length];
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'F1Drive devtests/track-audit (one-off, cached)' } });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const j = JSON.parse(text);
        if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error('remark ' + j.remark);
        writeFileSync(file, text);
        console.log(id, ep, 'elements', j.elements.length);
        done = true;
      } else {
        console.log(id, ep, 'HTTP', res.status, text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500));
        if (res.status === 400) break;
        await sleep(res.status === 429 ? 30000 * (a + 1) : 10000);
      }
    } catch (err) { console.log(id, ep, 'error', err.message); await sleep(10000); }
  }
  await sleep(5000);
}
