// node devtests/track-audit/apac/jp-run.mjs -- Suzuka: game vs GSI laser DEM along the OSM centreline (deck of the crossover bridged:
// the DEM gives the lower road under it), table every 50 m, published features, crossover heights.
import { compare } from './compare.mjs';
import { readJSON, HERE } from './common.mjs';
import { resolve } from 'node:path';
export const bridgeDeck = (raw, dem) => {
  // the upper road's deck: DEM samples (OSM loop s) 4660..4705 read the ground below -> straight between 4656 and 4716
  const s = dem.profile.map((p) => p.s), a = s.findIndex((v) => v >= 4656), b = s.findIndex((v) => v >= 4716);
  const out = raw.slice(); for (let i = a + 1; i < b; i++) out[i] = raw[a] + (raw[b] - raw[a]) * (s[i] - s[a]) / (s[b] - s[a]);
  return out;
};
const r = compare('jp-1962', 'gsi', 'dtm', { preprocess: bridgeDeck });
const g = r.grid;
if (process.argv[1].endsWith('jp-run.mjs')) {
  for (let i = 0; i < g.game.length; i += 5) console.log(String(Math.round(i * g.ds)).padStart(6), g.game[i].toFixed(1).padStart(7), g.dem[i].toFixed(1).padStart(7), g.demRaw[i].toFixed(1).padStart(7));
  const { grid, ...rest } = r; console.log(JSON.stringify(rest));
}
