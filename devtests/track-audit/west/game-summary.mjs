// node devtests/track-audit/west/game-summary.mjs <id> ... : grades, banking, tight corners of the built game track.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { loadGame, gameArrays, grades, gradeRuns, bankSections, tightCorners, r } from './lib-audit.mjs';
for (const id of process.argv.slice(2)) {
  const g = loadGame(id), A = gameArrays(g);
  const ymin = Math.min(...A.y), ymax = Math.max(...A.y);
  const out = { id, builtLength: r(A.L, 1), lengthKm: g.lengthKm, yRange: r(ymax - ymin, 2),
    yMinAtS: r(A.s[A.y.indexOf(ymin)], 0), yMaxAtS: r(A.s[A.y.indexOf(ymax)], 0),
    g50: grades(A.y, A.ds, 50, A.S), g100: grades(A.y, A.ds, 100, A.S), g20: grades(A.y, A.ds, 20, A.S),
    runs100_4pct: gradeRuns(A.y, A.ds, 100, 4),
    bank3: bankSections(A.bank, A.ds, 3), bankMaxAbs: r(Math.max(...A.bank.map(Math.abs)), 2),
    tight: tightCorners(A.k, A.ds, 40, A.S) };
  writeFileSync(resolve(HERE, 'res', 'game-summary-' + id + '.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
}
