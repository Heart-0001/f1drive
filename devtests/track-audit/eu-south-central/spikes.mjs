// node spikes.mjs <id> <from> <to> [step] : raw centreline heights of the lidar model (OSM-snapped), to see bridges / gantries
import { loadGame, loadOSM, gameLine, osmLayout, proj } from './lib.mjs';
import * as DEM from './dem.mjs';
const [id, a, b, st] = process.argv.slice(2);
const fn = { 'at-1969': DEM.bev, 'it-1953': (p) => DEM.er(p), 'it-1914': (p) => DEM.toscana(p) }[id];
const game = loadGame(id), gl = gameLine(id, game), lay = osmLayout(id, loadOSM(id)), p = proj(id);
const pts = [], ss = [];
for (let s = +a; s <= +b; s += +(st || 2)) {
  let i = gl.S.findIndex((q) => q.s >= s); if (i < 0) i = 0;
  const sn = lay.idx.near(gl.P[i][0], gl.P[i][1], 50); pts.push(p.from(...(sn.d < 12 ? [sn.px, sn.py] : gl.P[i]))); ss.push(s);
}
const h = await fn(pts);
console.log(ss.map((s, k) => `${s}:${h[k].toFixed(2)}`).join(' '));
