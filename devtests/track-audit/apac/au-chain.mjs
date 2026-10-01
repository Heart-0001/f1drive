// node devtests/track-audit/apac/au-chain.mjs -- Albert Park: the OSM circuit relation 280443 (cache/osmapi/rel-280443-full.xml)
// chained in member order into a closed centreline; deviation of the game lap from it; heading changes where they differ.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CACHE, HERE, track, toLL, metric, cumLen, writeJSON, project } from './common.mjs';
import { deviation } from './osmline.mjs';
const xml = readFileSync(resolve(CACHE, 'osmapi', 'rel-280443-full.xml'), 'utf8');
const nodes = new Map();
for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(+m[1], [+m[2], +m[3]]);
const ways = new Map();
for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) ways.set(+m[1], { nds: [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((q) => +q[1]), tags: Object.fromEntries([...m[2].matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map((q) => [q[1], q[2]])) });
const members = [...xml.matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"\/>/g)].map((m) => ({ id: +m[1], role: m[2] })).filter((m) => m.role !== 'pit_lane');
// chain: orient each way so it continues from the previous end
let chain = [], log = [];
for (const m of members) {
  let nds = ways.get(m.id).nds.slice();
  if (chain.length) {
    const end = chain[chain.length - 1];
    if (nds[0] === end) {} else if (nds[nds.length - 1] === end) nds.reverse();
    else { log.push(`way ${m.id} (${m.role}) does not connect to the previous end`); }
    chain.push(...nds.slice(nds[0] === end ? 1 : 0));
  } else {
    // first way: orient so its end connects to the next member
    const next = ways.get(members[1].id).nds;
    if (next.includes(nds[0]) && !next.includes(nds[nds.length - 1])) nds.reverse();
    chain.push(...nds);
  }
}
console.log('chain nodes', chain.length, 'closed', chain[0] === chain[chain.length - 1], log.join('; '));
const t = track('au-1953'), M = metric(t.geo.lat0, t.geo.lon0);
if (chain[0] === chain[chain.length - 1]) chain.pop();
const osmXY = chain.map((n) => M.xy(...nodes.get(n)));
const gameXY = t.points.map((p) => M.xy(...toLL(t, p[0], p[1])));
const L = cumLen(osmXY)[osmXY.length], G = cumLen(gameXY)[gameXY.length];
// direction: compare the order of 3 OSM nodes projected on the game lap
const sOf = (xy) => project(gameXY, xy[0], xy[1]).s;
const s1 = sOf(osmXY[0]), s2 = sOf(osmXY[Math.floor(osmXY.length / 4)]), s3 = sOf(osmXY[Math.floor(osmXY.length / 2)]);
console.log('osm chain length', L.toFixed(1), 'game true', G.toFixed(1), 'scale', (t.lengthKm * 1000 / G).toFixed(4), 'order on game lap', s1.toFixed(0), s2.toFixed(0), s3.toFixed(0));
const dev = deviation(gameXY, osmXY, 5), scale = t.lengthKm * 1000 / G;
const runs = []; let cur = null;
for (const p of dev) { if (p.d > 5) { if (!cur) { cur = { s0: p.s, max: 0 }; runs.push(cur); } cur.s1 = p.s; if (p.d > cur.max) { cur.max = p.d; cur.at = p.s; } } else cur = null; }
const mean = dev.reduce((a, b) => a + b.d, 0) / dev.length;
console.log('dev mean', mean.toFixed(2), 'max', Math.max(...dev.map((d) => d.d)).toFixed(1));
for (const q of runs) {
  // heading change of game and of OSM over the stretch (+-60 m)
  const a = q.s0 - 60, b = q.s1 + 60;
  const head = (P, s) => { const c = cumLen(P), Lp = c[P.length]; s = ((s % Lp) + Lp) % Lp; let i = 0; while (i < P.length - 1 && c[i + 1] <= s) i++; const j = (i + 1) % P.length; return Math.atan2(P[j][1] - P[i][1], P[j][0] - P[i][0]); };
  let turnG = 0, prev = head(gameXY, a);
  const hs = [];
  for (let s = a + 5; s <= b; s += 5) { const h = head(gameXY, s); let d = h - prev; d = Math.atan2(Math.sin(d), Math.cos(d)); turnG += Math.abs(d); prev = h; hs.push(Math.round(h * 180 / Math.PI)); }
  const [la, lo] = M.ll(dev[Math.round(q.at / 5)].x, dev[Math.round(q.at / 5)].y);
  console.log(`game s ${Math.round(q.s0 * scale)}-${Math.round(q.s1 * scale)} max ${q.max.toFixed(1)} m at ${Math.round(q.at * scale)} (${la.toFixed(6)}, ${lo.toFixed(6)}); game total |heading change| ${Math.round(turnG * 180 / Math.PI)} deg over ${Math.round(b - a)} m; headings ${hs.join(' ')}`);
}
// OSM heading change over the same stretches
for (const q of runs) {
  const pa = M.xy(...toLL(t, ...t.points[0])); // dummy
}
writeJSON(resolve(HERE, 'out', 'osm-au-1953-relation.json'), { relation: 280443, osmLength: L, gameTrueLength: G, scale, devMean: mean,
  stretches: runs.map((q) => ({ fromS: Math.round(q.s0 * scale), toS: Math.round(q.s1 * scale), max: +q.max.toFixed(1), atS: Math.round(q.at * scale) })),
  llLine: osmXY.map(([x, y]) => M.ll(x, y).map((v) => +v.toFixed(7))) });
