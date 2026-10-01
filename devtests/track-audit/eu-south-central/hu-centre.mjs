// node hu-centre.mjs [id] : which centreline (game dataset or OSM) sits where the cars drive? Per 10 m bin: the F1 cars'
// median lateral position (lt-<id>.json pathOffsetM, + = left of the game line) and the OSM layout's signed offset from
// the game line; summary over the bins where the two lines differ by > 3 m.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, loadGame, loadOSM, gameLine, osmLayout } from './lib.mjs';
const id = process.argv[2] || 'hu-1986';
const game = loadGame(id), gl = gameLine(id, game), lay = osmLayout(id, loadOSM(id));
const L = JSON.parse(readFileSync(resolve(HERE, 'out', `lt-${id}.json`), 'utf8'));
const rows = [];
for (let k = 0; k < L.s.length; k++) {
  const s = L.s[k]; let i = gl.S.findIndex((q) => q.s >= s); if (i < 0) i = 0;
  const a = gl.P[(i - 2 + gl.N) % gl.N], b = gl.P[(i + 2) % gl.N], tl = Math.hypot(b[0] - a[0], b[1] - a[1]), n = [-(b[1] - a[1]) / tl, (b[0] - a[0]) / tl];
  const o = lay.idx.near(gl.P[i][0], gl.P[i][1], 50), osmOff = (o.px - gl.P[i][0]) * n[0] + (o.py - gl.P[i][1]) * n[1];
  rows.push({ s, car: L.pathOffsetM[k], osm: osmOff });
}
const diff = rows.filter((r) => Math.abs(r.osm) > 3);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`${id}: bins ${rows.length}; |OSM - game| > 3 m in ${diff.length} bins`);
console.log(`  over those bins: mean |car - game| ${mean(diff.map((r) => Math.abs(r.car))).toFixed(2)} m, mean |car - OSM| ${mean(diff.map((r) => Math.abs(r.car - r.osm))).toFixed(2)} m, cars on the OSM side of the game line in ${diff.filter((r) => Math.sign(r.car) === Math.sign(r.osm)).length} bins`);
console.log(`  all bins: mean |car - game| ${mean(rows.map((r) => Math.abs(r.car))).toFixed(2)}, mean |car - OSM| ${mean(rows.map((r) => Math.abs(r.car - r.osm))).toFixed(2)}`);
console.log('  sample:', diff.filter((_, j) => j % 8 === 0).map((r) => `s${r.s.toFixed(0)} car ${r.car.toFixed(1)} osm ${r.osm.toFixed(1)}`).join(' | '));
