// node devtests/track-audit/west/corners-osm.mjs <id>[:variant] [minRadius=400] [fromGameS] [toGameS]
// Same corner list as corners.mjs, on the OSM reference loop (res/osm-loop-*.json), with the game s of each corner.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, gameArrays, resample, curvature, gauss, cumLen, nearestOn, r } from './lib-audit.mjs';
const [arg, minR = '400', s0 = '0', s1 = '1e9'] = process.argv.slice(2);
const id = arg.split(':')[0], label = arg.replace(':', '-');
const g = loadGame(id), A = gameArrays(g);
const O = JSON.parse(readFileSync(resolve(HERE, 'res', 'osm-loop-' + label + '.json'), 'utf8'));
const R = resample(O.loop.map(([la, lo]) => A.proj.to(la, lo)), 2, true);
const P = R.pts.map((p) => ({ x: p.x, y: p.y }));
const k = gauss(curvature(P, R.ds, 3), 10 / R.ds);
const gc = cumLen(A.xy, true), gsOf = (i) => nearestOn(A.xy, gc, P[i].x, P[i].y, true).s;
const out = []; let cur = null;
for (let i = 0; i < P.length; i++) {
  const on = Math.abs(k[i]) > 1 / +minR, sg = Math.sign(k[i]);
  if (on && cur && cur.sg === sg) { cur.to = i; cur.ang += k[i] * R.ds; cur.minR = Math.min(cur.minR, 1 / Math.abs(k[i])); }
  else { if (cur) out.push(cur); cur = on ? { from: i, to: i, sg, ang: k[i] * R.ds, minR: 1 / Math.abs(k[i]) } : null; }
}
if (cur) out.push(cur);
for (const c of out) {
  if (Math.abs(c.ang) * 180 / Math.PI < 8) continue;
  const a = gsOf(c.from), b = gsOf(c.to);
  if (a < +s0 || a > +s1) continue;
  const mid = Math.round((c.from + c.to) / 2), ll = A.proj.from(P[mid].x, P[mid].y);
  console.log(`gameS ${r(a, 0)}-${r(b, 0)} ${c.sg > 0 ? 'L' : 'R'} angle ${r(Math.abs(c.ang) * 180 / Math.PI, 0)} deg, len ${r((c.to - c.from + 1) * R.ds, 0)} m, minR ${r(c.minR, 0)} m, at ${ll[0].toFixed(6)},${ll[1].toFixed(6)}`);
}
