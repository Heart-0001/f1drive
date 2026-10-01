// node devtests/track-audit/mideast/overpass.mjs <id> [<id> ...]
// Fetches (once; cached under devtests/track-audit/cache/overpass/<id>.json) every OpenStreetMap object around one of
// the audited circuits that matters for the audit: raceways (all layouts), raceway / start-finish nodes, pit-lane ways,
// bridges / tunnels / covered ways (crossings of the track), and the relations the raceway ways belong to (layouts).
// Overpass etiquette: one query at a time, 5 s apart, exponential back-off on 429 / 504. Data: (c) OpenStreetMap
// contributors, ODbL.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '..', 'cache', 'overpass');
export const BBOX = {         // [south, west, north, east] = bounding box of tracks-data.js points + ~450 m
  'bh-2002': [26.0220, 50.5050, 26.0410, 50.5235],
  'sa-2021': [21.6210, 39.0960, 21.6545, 39.1110],
  'qa-2004': [25.4795, 51.4430, 25.5015, 51.4645],
  'ae-2009': [24.4590, 54.5970, 24.4830, 54.6140],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EP = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export async function overpass(id) {
  const file = resolve(CACHE, id + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const b = BBOX[id].join(',');
  const q = `[out:json][timeout:90];
(
  way["highway"="raceway"](${b});
  way["raceway"](${b});
  node["raceway"](${b});
  node["highway"="raceway"](${b});
  node["name"~"[Ss]tart|[Ff]inish|[Pp]it"](${b});
  way["service"~"pit"](${b});
  way["name"~"[Pp]it"](${b});
  way["bridge"](${b});
  way["tunnel"](${b});
  way["man_made"="bridge"](${b});
  way["covered"](${b});
  way["building"="bridge"](${b});
  way["building:part"](${b});
  way["sport"="motor"](${b});
  way["leisure"="track"](${b});
)->.a;
way.a["highway"="raceway"]->.r;
rel(bw.r)->.rels;
(.a; .rels;);
out body geom;`;
  for (let a = 0; a < 10; a++) {
    const ep = EP[a % EP.length];
    let res;
    try {
      res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'F1Drive track audit (devtests; cached one-off queries)' } });
    } catch (e) { res = { ok: false, status: 'network ' + (e.cause && e.cause.code || e.message) }; }
    if (res.ok) {
      const j = await res.json();
      j._query = q; j._endpoint = ep; j._fetched = new Date().toISOString();
      writeFileSync(file, JSON.stringify(j), 'utf8');
      return j;
    }
    const wait = Math.min(120000, 15000 * 2 ** a);
    console.warn(`overpass ${id}: HTTP ${res.status} from ${ep}, retry in ${wait / 1000} s`);
    await sleep(wait);
  }
  throw new Error('overpass ' + id + ': giving up');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const id of process.argv.slice(2)) {
    const had = existsSync(resolve(CACHE, id + '.json'));
    const j = await overpass(id);
    const ways = j.elements.filter((e) => e.type === 'way'), rels = j.elements.filter((e) => e.type === 'relation');
    console.log(`${id}: ${j.elements.length} elements (${ways.length} ways, ${rels.length} relations)${had ? ' [cache]' : ''}`);
    if (!had) await sleep(5000);
  }
}
