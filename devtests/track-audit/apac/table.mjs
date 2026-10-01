// node devtests/track-audit/apac/table.mjs <id> <src:mode>[,<src:mode>...] [step]  -- side-by-side height table (game vs DEM profiles, each
// relative to its own lowest point) every `step` m of the lap
import { compare } from './compare.mjs';
const [id, list, step = '100'] = process.argv.slice(2);
const runs = list.split(',').map((x) => { const [s, m] = x.split(':'); return compare(id, s, m || 'dtm'); });
const g = runs[0].grid, k = Math.round(+step / g.ds);
console.log('s'.padStart(6), 'game'.padStart(7), ...runs.map((r) => (r.demSource + ':' + r.mode).padStart(14)), '   raw(' + runs[0].demSource + ')');
for (let i = 0; i < g.game.length; i += k) console.log(String(Math.round(i * g.ds)).padStart(6), g.game[i].toFixed(1).padStart(7), ...runs.map((r) => r.grid.dem[i].toFixed(1).padStart(14)), '   ' + runs[0].grid.demRaw[i].toFixed(1));
for (const r of runs) console.log(r.demSource, r.mode, 'range', r.dem.range.toFixed(1), 'high', Math.round(r.dem.highAt), 'low', Math.round(r.dem.lowAt), 'corr', r.shapeCorrelation, 'rms', r.shapeRmsDiff, 'climb100', JSON.stringify(r.dem.climb100), 'desc100', JSON.stringify(r.dem.descent100));
console.log('game range', runs[0].game.range.toFixed(1), 'high', Math.round(runs[0].game.highAt), 'low', Math.round(runs[0].game.lowAt), 'climb100', JSON.stringify(runs[0].game.climb100), 'desc100', JSON.stringify(runs[0].game.descent100));
