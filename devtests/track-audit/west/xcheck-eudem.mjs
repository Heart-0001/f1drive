// One OpenTopoData request (eudem25m, EU-DEM v1.1 25 m) as an independent cross-check of the two disputed stretches:
// Barcelona Turn 2 -> Turn 4 (game s 700-1750) and the Madring main straight -> Turn 3 (game s 5000 -> 550).
// Every 50 m along the OSM line; cached in cache/opentopodata/eudem25m.json.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, opentopodata } from './net.mjs';
const pick = (id, a, b) => {
  const o = JSON.parse(readFileSync(resolve(HERE, 'res', `profile-${id}-mdt05.json`), 'utf8')).profile;
  const pts = JSON.parse(readFileSync(resolve(HERE, '..', id + '.json'), 'utf8')).proposedCorrections.elevationProfile10m.points;
  return pts.filter((p, i) => i % 5 === 0 && (a < b ? p[4] >= a && p[4] <= b : p[4] >= a || p[4] <= b));
};
const A = pick('es-1991', 700, 1750), B = pick('es-2026', 5000, 550);
const h = await opentopodata('eudem25m', A.concat(B).map((p) => [p[0], p[1]]));
const show = (name, P, H) => { console.log(name); const m = Math.min(...H); P.forEach((p, i) => console.log(`  s ${Math.round(p[4])}: eudem ${(H[i]).toFixed(1)}  mdt05(rel) ${p[2].toFixed(1)}  game(rel) ${p[3].toFixed(1)}`)); };
show('es-1991 T2 -> T4', A, h.slice(0, A.length));
show('es-2026 main straight -> T3', B, h.slice(A.length));
