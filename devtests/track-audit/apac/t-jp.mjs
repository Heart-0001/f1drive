import { osmCentreline, deviation } from './osmline.mjs';
import { cumLen } from './common.mjs';
const id = process.argv[2] || 'jp-1962';
const r = osmCentreline(id, { exclude: (w) => /Pit|コース|カート|West Circuit/.test(w.tags.name || '') && !/S字/.test(w.tags.name||'') });
const L = cumLen(r.line)[r.line.length], G = cumLen(r.gameXY)[r.gameXY.length];
console.log('osm pts', r.line.length, 'osm len', L.toFixed(1), 'game true len', G.toFixed(1), 'gaps', JSON.stringify(r.gaps));
const dev = deviation(r.gameXY, r.line, 5);
const mx = dev.reduce((a, b) => b.d > a.d ? b : a);
console.log('dev mean', (dev.reduce((a, b) => a + b.d, 0) / dev.length).toFixed(2), 'max', mx.d.toFixed(1), 'at s', mx.s.toFixed(0));
// top deviation stretches
let runs=[], cur=null; for (const p of dev) { if (p.d>8){ if(!cur){cur={s0:p.s,max:0};runs.push(cur);} cur.s1=p.s; cur.max=Math.max(cur.max,p.d);} else cur=null; }
console.log(runs.map(q=>`${q.s0.toFixed(0)}-${q.s1.toFixed(0)}: ${q.max.toFixed(1)}`).join('\n'));
