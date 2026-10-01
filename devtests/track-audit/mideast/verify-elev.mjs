// node devtests/track-audit/mideast/verify-elev.mjs : builds each track in memory (js/track.js) with tracks-data.js elev
// replaced by proposedCorrections.elevation.perPoint and compares the samples the car drives on with the F1 timing
// profile (same OSM s bins as audit.mjs). Read-only: no game file is changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutAudit } from './layout.mjs';
import { CFG } from './audit.mjs';
import { buildGame, toLatLon, resampleLoop, nearestOnLoop, gradeWindows, corr, r1, r2 } from './core.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = {};
for (const id of ['bh-2002', 'sa-2021', 'qa-2004', 'ae-2009']) {
  const J = JSON.parse(readFileSync(resolve(HERE, '..', id + '.json'), 'utf8')), P = J.demProfile;
  const L = layoutAudit(id, CFG[id]), td = L._td, pr = L._pr;
  const td2 = Object.assign({}, td, { elev: J.proposedCorrections.elevation.perPoint });
  const tr2 = buildGame(td2), S2 = tr2.samples.map((q) => pr.f(...toLatLon(td.geo, q.x, q.z)));
  const R2 = resampleLoop(L._O, 2), k0 = Math.round(L._f0.s / R2.ds) % R2.pts.length, O0 = R2.pts.slice(k0).concat(R2.pts.slice(0, k0));
  const y2 = P.s.map((s) => { const p = O0[Math.floor(s / R2.ds) % O0.length]; return tr2.samples[nearestOnLoop(S2, p[0], p[1]).i].y; });
  const m2 = Math.min(...y2), rel2 = y2.map((v) => v - m2), lt = P.lt, n = lt.length;
  const rms = (a) => { const off = a.reduce((x, v, i) => x + v - lt[i], 0) / n; return r2(Math.sqrt(a.reduce((x, v, i) => x + (v - lt[i] - off) ** 2, 0) / n)); };
  const g100 = gradeWindows(P.s, rel2, n * P.binM, 100), l100 = gradeWindows(P.s, lt, n * P.binM, 100);
  OUT[id] = { method: 'tracks-data.js elev replaced in memory by perPoint, track rebuilt with js/track.js, samples compared with the F1 timing profile on the same 10 m OSM bins', rangeM: { real: r1(Math.max(...lt)), now: r1(Math.max(...P.game)), proposed: r1(Math.max(...rel2)) }, rmsVsRealM: { now: rms(P.game), proposed: rms(rel2) }, correlation: { now: r2(corr(P.game, lt)), proposed: r2(corr(rel2, lt)) }, maxGrade100Pct: { real: [l100.maxClimbPct, l100.maxDescentPct], proposed: [g100.maxClimbPct, g100.maxDescentPct] } };
  console.log(id, 'range lt', r1(Math.max(...lt)), 'now', r1(Math.max(...P.game)), 'proposed', r1(Math.max(...rel2)),
    '| rms vs lt: now', rms(P.game), 'proposed', rms(rel2), '| corr now', r2(corr(P.game, lt)), 'proposed', r2(corr(rel2, lt)),
    '| max climb/desc 100 m: lt', l100.maxClimbPct, '/', l100.maxDescentPct, 'proposed', g100.maxClimbPct, '/', g100.maxDescentPct);
}
writeFileSync(resolve(HERE, 'out', 'verify-elev.json'), JSON.stringify(OUT, null, 1));
