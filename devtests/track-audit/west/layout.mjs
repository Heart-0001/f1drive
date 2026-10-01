// node devtests/track-audit/west/layout.mjs <id>[:variant] ...
// Centreline comparison: game samples (~2 m) against the OSM reference loop (res/osm-loop-<id>[-variant].json), both ways:
// game -> OSM (where the game strays) and OSM (resampled at 2 m) -> game (OSM sections the game lacks). Writes
// res/layout-<id>[-variant].json.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, gameArrays, deviation, deviationRuns, resample, cumLen, nearestOn, r, curvature, tightCorners } from './lib-audit.mjs';

for (const arg of process.argv.slice(2)) {
  const id = arg.split(':')[0], label = arg.replace(':', '-');
  const g = loadGame(id), A = gameArrays(g);
  const O = JSON.parse(readFileSync(resolve(HERE, 'res', 'osm-loop-' + label + '.json'), 'utf8'));
  const oXY = O.loop.map(([la, lo]) => A.proj.to(la, lo));
  const dev = deviation(A.xy, oXY, A.s);
  const runs = deviationRuns(dev.perSample, A.s, 8);
  // reverse direction
  const R = resample(oXY, 2, true), gc = cumLen(A.xy, true);
  const back = R.pts.map((p) => nearestOn(A.xy, gc, p.x, p.y, true).d);
  const sortedB = back.slice().sort((a, b) => a - b);
  const backRuns = deviationRuns(back, R.pts.map((p) => p.s), 8);
  // OSM curvature: tight corners (radius < 40 m) on the OSM line, at the game's s of the same place
  const P = R.pts.map((p) => ({ x: p.x, y: p.y })), k = curvature(P, R.ds, 3);
  const osmTight = tightCorners(k, R.ds, 40).map((c) => {
    const p = R.pts[Math.round(c.s / R.ds) % R.pts.length], q = nearestOn(A.xy, gc, p.x, p.y, true);
    return Object.assign(c, { gameS: r(q.s, 0), at: A.proj.from(p.x, p.y).map((v) => +v.toFixed(6)) });
  });
  const out = { id: label, osmRelation: O.relation, osmLength: O.length, gameBuiltLength: r(A.L, 1), gameLengthKm: g.lengthKm,
    gameToOsm: { meanM: dev.meanM, p50M: dev.p50M, p95M: dev.p95M, maxM: dev.maxM, maxAtGameS: dev.maxAtS, runsOver8m: runs },
    osmToGame: { meanM: r(back.reduce((a, v) => a + v, 0) / back.length, 2), p95M: r(sortedB[Math.floor(back.length * 0.95)], 2), maxM: r(sortedB[sortedB.length - 1], 1), runsOver8mOsmS: backRuns },
    osmTightCorners: osmTight };
  writeFileSync(resolve(HERE, 'res', 'layout-' + label + '.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
}
