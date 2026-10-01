// node devtests/track-audit/eu-south-central/overpass.mjs <id> [<id> ...]
// Fetches (once; cached under devtests/track-audit/cache/overpass/<id>.json) the OpenStreetMap objects around one of the
// audited circuits: raceways (all layouts), raceway / start-finish nodes, pit-lane ways, bridges / tunnels / covered ways,
// and the relations the raceway ways belong to. One query at a time, 6 s apart, exponential back-off on 429 / 5xx.
// Data: (c) OpenStreetMap contributors, ODbL.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '..', 'cache', 'overpass');
mkdirSync(CACHE, { recursive: true });
export const BBOX = {         // [south, west, north, east] = bounding box of tracks-data.js points + ~450 m
  'it-1922': [45.6078, 9.2749, 45.6354, 9.3027],
  'it-1953': [44.3325, 11.6964, 44.3491, 11.7308],
  'it-1914': [43.9875, 11.3601, 44.0073, 11.3829],
  'at-1969': [47.2152, 14.7481, 47.2304, 14.7766],
  'hu-1986': [47.5735, 19.2363, 47.5925, 19.2626],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export async function overpass(id) {
  const file = resolve(CACHE, id + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const b = BBOX[id].join(',');
  const q = `[out:json][timeout:120];
(
  way["highway"="raceway"](${b});
  way["raceway"](${b});
  node["raceway"](${b});
  node["highway"="raceway"](${b});
  node["name"~"[Ss]tart|[Ff]inish|[Pp]it|[Tt]raguardo|[Zz]iel|[Rr]ajt|[Cc][ée]l"](${b});
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
    let status = 'network error';
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'F1Drive track audit (devtests; cached one-off queries)' } });
      status = res.status;
      if (res.ok) {
        const j = await res.json();
        j._query = q; j._endpoint = ep; j._fetched = new Date().toISOString();
        writeFileSync(file, JSON.stringify(j), 'utf8');
        return j;
      }
    } catch (e) { status = e.message; }
    const wait = 15000 * 2 ** a;
    console.warn(`overpass ${id}: ${status} from ${ep}, retry in ${wait / 1000} s`);
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
    if (!had) await sleep(6000);
  }
}
