// node xprobe.mjs <id> <s> [<s> ...] : cross-section of the lidar model at game arc length s (offsets -9..9 m, 1 m)
import { loadGame, loadOSM, gameLine, osmLayout, proj } from './lib.mjs';
import * as DEM from './dem.mjs';
const [id, ...ss] = process.argv.slice(2);
const fn = { 'at-1969': DEM.bev, 'it-1953': (p) => DEM.er(p), 'it-1914': (p) => DEM.toscana(p) }[id];
const game = loadGame(id), gl = gameLine(id, game), lay = osmLayout(id, loadOSM(id)), p = proj(id);
for (const s0 of ss.map(Number)) {
  let i = gl.S.findIndex((q) => q.s >= s0); if (i < 0) i = 0;
  const a = gl.P[(i - 3 + gl.N) % gl.N], b = gl.P[(i + 3) % gl.N], tl = Math.hypot(b[0] - a[0], b[1] - a[1]), n = [-(b[1] - a[1]) / tl, (b[0] - a[0]) / tl];
  const sn = lay.idx.near(gl.P[i][0], gl.P[i][1], 50), c = sn.d < 12 ? [sn.px, sn.py] : gl.P[i];
  const offs = []; for (let o = -9; o <= 9; o++) offs.push(o);
  const h = await fn(offs.map((o) => p.from(c[0] + n[0] * o, c[1] + n[1] * o)));
  const h0 = h[9];
  console.log(`s ${s0} (game bank ${gl.S[i].bankDeg} deg, snap ${sn.d.toFixed(1)} m): ` + offs.map((o, k) => `${o}:${(h[k] - h0).toFixed(2)}`).join(' '));
}
