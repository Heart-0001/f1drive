// node devtests/track-audit/americas/prefetch-hrdem.mjs : NRCan HRDEM tiles under the game line of ca-1978 (+-15 m), cached
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, hrdem } from './net.mjs';
const g = JSON.parse(readFileSync(resolve(HERE, 'out', 'game-ca-1978.json'), 'utf8'));
const pts = [];
for (let i = 0; i < g.samples.length; i += 5) { const q = g.samples[i]; for (const d of [-0.00015, 0, 0.00015]) pts.push([q.lat + d, q.lon], [q.lat, q.lon + d * 1.4]); }
const v = await hrdem(pts);
console.log('points', pts.length, 'valid', v.filter((x) => x !== null).length, 'min', Math.min(...v.filter((x) => x !== null)), 'max', Math.max(...v.filter((x) => x !== null)));
