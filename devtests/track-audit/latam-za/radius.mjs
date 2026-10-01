// node devtests/track-audit/latam-za/radius.mjs <id>
// Tightest corners: the game centreline vs the OpenStreetMap centreline, both measured the same way (circumradius of the
// points 18 m behind / ahead, on lines resampled every 6 m: the game's samples and the game samples snapped onto the OSM
// ways, out/osm-<id>.json). Prints every corner whose radius is < 40 m on either line. -> out/radius-<id>.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), id = process.argv[2];
const game = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
const osm = JSON.parse(readFileSync(resolve(HERE, 'out', `osm-${id}.json`), 'utf8'));
const step = Math.max(1, Math.round(5 / game.ds)), lat0 = game.geo.lat0, lon0 = game.geo.lon0;
const KX = Math.cos(lat0 * Math.PI / 180) * 111320, KN = 110540, P = ([la, lo]) => [(lo - lon0) * KX, (la - lat0) * KN];
const Gp = game.samples.filter((_, i) => i % step === 0).map((q) => P(q.ll)), Op = osm.snapped.map(P), M = Op.length;
// light smoothing of the snapped line (it jumps between neighbouring ways): 3-point moving average, twice
const sm = (a) => a.map((_, j) => [0, 1].map((c) => (a[(j - 1 + M) % M][c] + a[j][c] + a[(j + 1) % M][c]) / 3));
const Os = sm(sm(Op));
const K = 3;      // 3 x ~6 m = 18 m each side
function rad(a, j) {
  const p = a[(j - K + M) % M], q = a[j], r = a[(j + K) % M];
  const A = Math.hypot(q[0] - r[0], q[1] - r[1]), B = Math.hypot(p[0] - r[0], p[1] - r[1]), C = Math.hypot(p[0] - q[0], p[1] - q[1]);
  const cross = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return Math.abs(cross) < 1e-9 ? 1e6 : (A * B * C) / (2 * Math.abs(cross));
}
const rg = Gp.map((_, j) => rad(Gp, j)), ro = Os.map((_, j) => rad(Os, j));
const out = [];
for (let j = 0; j < M; j++) {
  const m = Math.min(rg[j], ro[j]);
  if (m >= 40) continue;
  let local = true;
  for (let k = -4; k <= 4; k++) if (Math.min(rg[(j + k + M) % M], ro[(j + k + M) % M]) < m) local = false;
  if (!local) continue;
  // the tightest of each line within +-24 m
  let g = Infinity, o = Infinity;
  for (let k = -4; k <= 4; k++) { g = Math.min(g, rg[(j + k + M) % M]); o = Math.min(o, ro[(j + k + M) % M]); }
  out.push({ s: Math.round(game.samples[j * step].s), ll: osm.snapped[j], gameR: Math.round(g * 10) / 10, osmR: Math.round(o * 10) / 10 });
}
writeFileSync(resolve(HERE, 'out', `radius-${id}.json`), JSON.stringify(out, null, 1));
console.log(id, out.map((c) => `s ${c.s}: game R ${c.gameR} m / OSM R ${c.osmR} m`).join('\n  '));
