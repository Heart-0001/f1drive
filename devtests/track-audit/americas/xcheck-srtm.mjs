// node devtests/track-audit/americas/xcheck-srtm.mjs <id> [dataset]: cross-check the lidar profile with OpenTopoData (SRTM 30 m
// by default) every 50 m along the OSM line: one request of <= 100 locations, cached (cache/opentopodata/<dataset>-americas.json)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, opentopodata } from './net.mjs';
const id = process.argv[2], ds = process.argv[3] || 'srtm30m';
const a = JSON.parse(readFileSync(resolve(HERE, 'out', 'audit-' + id + '.json'), 'utf8'));
const rows = a.profile.rows.filter((r, k) => k % 5 === 0).slice(0, 100);
const v = await opentopodata(ds, rows.map((r) => [r[1], r[2]]));
const lid = rows.map((r) => r[3]);
const mOff = lid.reduce((s, x) => s + x, 0) / lid.length - v.reduce((s, x) => s + x, 0) / v.length;
let sxy = 0, sxx = 0, syy = 0; const ml = lid.reduce((s, x) => s + x, 0) / lid.length, mv = v.reduce((s, x) => s + x, 0) / v.length;
rows.forEach((r, k) => { sxy += (lid[k] - ml) * (v[k] - mv); sxx += (lid[k] - ml) ** 2; syy += (v[k] - mv) ** 2; });
console.log(id, ds, 'n', rows.length, 'range lidar', (Math.max(...lid) - Math.min(...lid)).toFixed(1), ds, (Math.max(...v) - Math.min(...v)).toFixed(1), 'offset', mOff.toFixed(1), 'corr', (sxy / Math.sqrt(sxx * syy)).toFixed(3));
rows.forEach((r, k) => { if (k % 2 === 0) console.log(r[0], lid[k], v[k]); });
