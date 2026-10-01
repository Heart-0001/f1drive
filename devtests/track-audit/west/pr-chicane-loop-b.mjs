// Paul Ricard 1C-V2 (the F1 layout 2018-2022, with the Mistral chicane): OSM relation 13545643 (1A-V2, no chicane)
// with the straight Mistral way 686705519 cut where the "unnamed chicane" way 229454182 leaves / rejoins it.
// Writes res/osm-loop-fr-1969-1cv2b.json (same shape as osm-loop.mjs).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, gameArrays, loadOverpass, cumLen, nearestOn, r } from './lib-audit.mjs';
const g = loadGame('fr-1969'), A = gameArrays(g);
const base = JSON.parse(readFileSync(resolve(HERE, 'res', 'osm-loop-fr-1969.json'), 'utf8'));
const ch = loadOverpass('fr-1969-raceway').elements.find((e) => e.id === 229454182);
let L = base.loop.map(([la, lo]) => A.proj.to(la, lo));
let C = ch.geometry.map((p) => A.proj.to(p.lat, p.lon));
const c = cumLen(L, true);
let a = nearestOn(L, c, C[0][0], C[0][1], true), b = nearestOn(L, c, C[C.length - 1][0], C[C.length - 1][1], true);
if (a.s > b.s) { C = C.slice().reverse(); [a, b] = [b, a]; }
console.log('chicane ends on the base loop: s', r(a.s, 0), r(a.d, 1), 'm off;', r(b.s, 0), r(b.d, 1), 'm off');
const out = L.slice(0, a.seg + 1).concat(C, L.slice(b.seg + 1));
const len = cumLen(out, true);
const o = Object.assign({}, base, { relation: '13545643 + way 229454182 (unnamed chicane) = 1C-V2', length: r(len[len.length - 1], 1),
  loop: out.map(([x, y]) => A.proj.from(x, y).map((v) => +v.toFixed(7))) });
writeFileSync(resolve(HERE, 'res', 'osm-loop-fr-1969-1cv2b.json'), JSON.stringify(o));
console.log('1C-V2 loop length', o.length);
