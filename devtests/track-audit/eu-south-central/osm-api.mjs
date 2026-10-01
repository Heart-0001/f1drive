// node devtests/track-audit/eu-south-central/osm-api.mjs <id> [<id> ...]
// Fallback for overpass.mjs while the Overpass servers do not answer (2026-10-01: overpass-api.de, kumi, private.coffee,
// mail.ru all time out from this machine): one OpenStreetMap API 0.6 /map call per circuit (bbox from overpass.mjs),
// cached raw under devtests/track-audit/cache/osmapi/<id>-map.json, and converted to the Overpass "out body geom"
// shape (ways with geometry, tagged nodes, relations) at devtests/track-audit/cache/osmapi/<id>.json, filtered to what
// overpass.mjs asks for (raceways, raceway / start-finish nodes, pit ways, bridges, tunnels, covered, sport=motor, track,
// and the relations of the raceway ways). Data: (c) OpenStreetMap contributors, ODbL.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX } from './overpass.mjs';
const HERE = dirname(fileURLToPath(import.meta.url)), CACHE = resolve(HERE, '..', 'cache', 'osmapi');
mkdirSync(CACHE, { recursive: true });
const UA = { 'User-Agent': 'F1Drive track audit (devtests; one cached /map call per circuit)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function osmMap(id) {
  const raw = resolve(CACHE, id + '-map.json');
  let j;
  if (existsSync(raw)) j = JSON.parse(readFileSync(raw, 'utf8'));
  else {
    const [s, w, n, e] = BBOX[id];
    const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${w},${s},${e},${n}`;
    for (let a = 0; ; a++) {
      const r = await fetch(url, { headers: UA });
      if (r.ok) { j = await r.json(); j._url = url; j._fetched = new Date().toISOString(); writeFileSync(raw, JSON.stringify(j)); break; }
      if (a > 4) throw new Error(`osm api ${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      await sleep(5000 * 2 ** a);
    }
    await sleep(3000);
  }
  const nodes = new Map();
  for (const el of j.elements) if (el.type === 'node') nodes.set(el.id, el);
  const keepWay = (t) => t && (t.highway === 'raceway' || t.raceway || /pit/i.test(t.service || '') || /pit|box/i.test(t.name || '') ||
    t.bridge || t.tunnel || t.man_made === 'bridge' || t.covered || t.building === 'bridge' || t.sport === 'motor' || t.leisure === 'track');
  const keepNode = (t) => t && (t.raceway || t.highway === 'raceway' || /start|finish|pit|traguardo|ziel|rajt|c[ée]l/i.test(t.name || ''));
  const out = [], raceWays = new Set();
  for (const el of j.elements) {
    if (el.type === 'way' && keepWay(el.tags)) {
      const geometry = el.nodes.map((nid) => nodes.get(nid)).filter(Boolean).map((nd) => ({ lat: nd.lat, lon: nd.lon }));
      out.push({ type: 'way', id: el.id, tags: el.tags, nodes: el.nodes, geometry });
      if (el.tags.highway === 'raceway') raceWays.add(el.id);
    } else if (el.type === 'node' && keepNode(el.tags)) out.push({ type: 'node', id: el.id, lat: el.lat, lon: el.lon, tags: el.tags });
  }
  for (const el of j.elements) {
    if (el.type === 'relation' && el.members.some((m) => m.type === 'way' && raceWays.has(m.ref))) out.push(el);
  }
  const res = { elements: out, _source: j._url || 'osm api 0.6 map', _fetched: j._fetched };
  writeFileSync(resolve(CACHE, id + '.json'), JSON.stringify(res));
  return res;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const id of process.argv.slice(2)) {
    const r = await osmMap(id);
    const c = (t) => r.elements.filter((e) => e.type === t).length;
    console.log(`${id}: ${r.elements.length} kept (${c('way')} ways, ${c('node')} nodes, ${c('relation')} relations)`);
  }
}
