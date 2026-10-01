// node devtests/track-audit/east/glo30-fetch.mjs <id> [...]: GLO-30 window around each circuit (game samples' bbox + 500 m),
// cached as cache/glo30/east-<id>.json by glo30.mjs (AWS Open Data, HTTP range requests; no re-fetch).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glo30Window } from './glo30.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
export function bboxOf(id, padM = 500) {
  const g = JSON.parse(readFileSync(resolve(HERE, 'out', `game-${id}.json`), 'utf8'));
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of g.samples) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
  const pl = padM / 111000, po = padM / (111000 * Math.cos(s * Math.PI / 180));
  return [s - pl, w - po, n + pl, e + po];
}
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const id of process.argv.slice(2)) {
    const g = await glo30Window('east-' + id, bboxOf(id));
    console.log(id, g.w, 'x', g.h, g.source);
  }
}
