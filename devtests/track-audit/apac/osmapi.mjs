// node devtests/track-audit/apac/osmapi.mjs <id> -- fallback for fetch-osm.mjs while the public Overpass servers time out:
// the OSM editing API's /map call (bbox of the circuit + 250 m, split in tiles if the API refuses), converted to the
// Overpass "out tags geom" shape and cached as cache/overpass/<id>-all.json (same file osmline.mjs reads).
// Only tagged nodes and ways that matter are kept (roads / raceway / bridges / tunnels / covered / layered buildings,
// start / finish / pit names). One request at a time, 3 s apart. Data (c) OpenStreetMap contributors, ODbL.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { track, toLL, CACHE, UA, sleep, writeJSON } from './common.mjs';

const id = process.argv[2];
const file = resolve(CACHE, 'overpass', id + '-all.json');
if (existsSync(file)) { console.log('cached', file); process.exit(0); }
const t = track(id);
let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
for (const p of t.points) {
  const [lat, lon] = toLL(t, p[0], p[1]);
  s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
}
const mLat = 250 / 110540, mLon = 250 / (111320 * Math.cos(s * Math.PI / 180));
s -= mLat; n += mLat; w -= mLon; e += mLon;

const nodes = new Map(), ways = new Map(), rels = new Map();
const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parse(xml) {
  const tagsOf = (body) => { const o = {}; for (const m of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)) o[unesc(m[1])] = unesc(m[2]); return o; };
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"[^>]*?(\/>|>([\s\S]*?)<\/node>)/g))
    nodes.set(+m[1], { type: 'node', id: +m[1], lat: +m[2], lon: +m[3], tags: m[5] ? tagsOf(m[5]) : undefined });
  for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g))
    ways.set(+m[1], { type: 'way', id: +m[1], nodes: [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((q) => +q[1]), tags: tagsOf(m[2]) });
  for (const m of xml.matchAll(/<relation id="(\d+)"[^>]*>([\s\S]*?)<\/relation>/g))
    rels.set(+m[1], { type: 'relation', id: +m[1], members: [...m[2].matchAll(/<member type="(\w+)" ref="(\d+)" role="([^"]*)"\/>/g)].map((q) => ({ type: q[1], ref: +q[2], role: q[3] })), tags: tagsOf(m[2]) });
}
async function get(bb, depth = 0) {
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${bb.map((v) => v.toFixed(6)).join(',')}`;
  for (let a = 0; a < 6; a++) {
    await sleep(3000);
    let r = null;
    try { r = await fetch(url, { headers: { 'User-Agent': UA } }); } catch (err) { console.warn('osm api', err.message); }
    if (r && r.ok) { const x = await r.text(); parse(x); console.log('tile', bb.map((v) => v.toFixed(4)).join(','), x.length, 'bytes'); return; }
    if (r && (r.status === 400 || r.status === 509) && depth < 3) {
      console.warn('osm api', r.status, (await r.text()).slice(0, 120), '-> splitting');
      const [w0, s0, e0, n0] = bb, mx = (w0 + e0) / 2, my = (s0 + n0) / 2;
      for (const q of [[w0, s0, mx, my], [mx, s0, e0, my], [w0, my, mx, n0], [mx, my, e0, n0]]) await get(q, depth + 1);
      return;
    }
    console.warn('osm api HTTP', r && r.status, 'retry');
    await sleep(15000 * (a + 1));
  }
  throw new Error('osm api: giving up');
}
await get([w, s, e, n]);
const keepWay = (tg) => tg.highway || tg.raceway || tg.bridge || tg.tunnel || tg.covered || tg.man_made === 'bridge' || tg.building === 'bridge' ||
  (tg.building && (tg.layer || tg.min_height || tg['building:min_level'])) || (tg['building:part'] && (tg.min_height || tg.layer)) ||
  tg.leisure === 'track' || tg.sport === 'motor' || /pit|grandstand/i.test(tg.name || '');
const els = [];
for (const nd of nodes.values()) if (nd.tags && Object.keys(nd.tags).length) els.push(nd);
for (const wy of ways.values()) {
  if (!keepWay(wy.tags)) continue;
  const geometry = wy.nodes.map((r) => nodes.get(r)).filter(Boolean).map((q) => ({ lat: q.lat, lon: q.lon }));
  els.push({ type: 'way', id: wy.id, nodes: wy.nodes, tags: wy.tags, geometry });
}
for (const r of rels.values()) els.push(r);
writeJSON(file, { version: 0.6, generator: 'osm api /map via devtests/track-audit/apac/osmapi.mjs', osm3s: { copyright: 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.' },
  bbox: [s, w, n, e], fetched: new Date().toISOString(), elements: els });
console.log(id, 'elements kept', els.length, 'of nodes', nodes.size, 'ways', ways.size, 'rels', rels.size);
