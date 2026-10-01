// node devtests/track-audit/mideast/show.mjs <id>  - quick look: corners + elevation summary
import { layoutAudit, LAYOUT } from './layout.mjs';
import { elevAudit } from './elev.mjs';
const id = process.argv[2];
const L = layoutAudit(id, LAYOUT[id]);
console.table(L.corners);
const E = await elevAudit(id, L);
for (const k of ['source', 'glo30', 'game', 'compare', 'srtm30AlongGameLine']) console.log(k, JSON.stringify(E[k]));
if (process.argv[3]) { const st = +process.argv[3]; for (let i = 0; i < E._s.length; i += st) console.log(Math.round(E._s[i]), E.profile.glo30[i], E.profile.game[i], E.profile.glo30RawAbs[i]); }
