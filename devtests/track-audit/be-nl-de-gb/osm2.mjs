// node osm2.mjs <id>: as osm.mjs (same query, same cache file) with other Overpass endpoints and a 3 min timeout per try (used when overpass-api.de / kumi failed).
// Fetches once (cached in devtests/track-audit/cache/overpass/<id>.json) the OpenStreetMap objects around a circuit that
// matter for the audit: raceways (all layouts), raceway / start-finish nodes, pit-lane ways, bridges / tunnels / covered
// ways, and the relations the raceway ways belong to. Bounding box = the game's points + ~400 m.
// Etiquette: one query at a time, 6 s apart, exponential back-off on 429 / 504. Data (c) OpenStreetMap contributors, ODbL.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '..', 'cache', 'overpass');
mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EP = (process.env.OVERPASS_EP || 'https://overpass.private.coffee/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass-api.de/api/interpreter').split(',');

export function bboxOf(id) {
  const g = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lon] of g.points) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); }
  const dl = 400 / 111000, dn = 400 / (111000 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return [s - dl, w - dn, n + dl, e + dn].map((v) => +v.toFixed(5));
}

export async function overpass(id) {
  const file = resolve(CACHE, id + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const b = bboxOf(id).join(',');
  const q = `[out:json][timeout:120];
(
  way["highway"="raceway"](${b});
  way["raceway"](${b});
  node["raceway"](${b});
  node["highway"="raceway"](${b});
  node["name"~"[Ss]tart|[Ff]inish|[Pp]it|[Ff]inis|[Zz]iel"](${b});
  way["service"~"pit"](${b});
  way["name"~"[Pp]it|[Bb]ox"](${b});
  way["bridge"](${b});
  way["tunnel"](${b});
  way["man_made"="bridge"](${b});
  way["covered"](${b});
  way["building"="bridge"](${b});
  way["sport"="motor"](${b});
  way["leisure"="track"](${b});
)->.a;
way.a["highway"="raceway"]->.r;
rel(bw.r)->.rels;
(.a; .rels;);
out body geom;`;
  for (let a = 0; a < 8; a++) {
    const ep = EP[a % EP.length];
    let res;
    try {
      res = await fetch(ep, { signal: AbortSignal.timeout(180000), method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'F1Drive track audit (devtests; cached one-off queries)' } });
    } catch (e) { console.warn(`  ${ep}: ${e.message}`); await sleep(10000 * 2 ** a); continue; }
    if (res.ok) {
      const j = await res.json();
      if (j.remark && /runtime error|timed out/i.test(j.remark)) { console.warn('  remark ' + j.remark); await sleep(15000 * 2 ** a); continue; }
      writeFileSync(file, JSON.stringify(j));
      return j;
    }
    console.warn(`  ${ep}: HTTP ${res.status}, backing off`);
    await sleep(15000 * 2 ** a);
  }
  throw new Error('overpass failed for ' + id);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const id of process.argv.slice(2)) {
    const had = existsSync(resolve(CACHE, id + '.json'));
    const j = await overpass(id);
    const ways = j.elements.filter((e) => e.type === 'way'), rels = j.elements.filter((e) => e.type === 'relation');
    console.log(id, 'bbox', bboxOf(id).join(','), 'elements', j.elements.length, 'ways', ways.length, 'rels', rels.length,
      'raceway ways', ways.filter((w) => w.tags && w.tags.highway === 'raceway').length, had ? '(cache)' : '(fetched)');
    if (!had) await sleep(6000);
  }
}
