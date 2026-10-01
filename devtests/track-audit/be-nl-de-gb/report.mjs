// node devtests/track-audit/be-nl-de-gb/report.mjs <id> -> devtests/track-audit/<id>.json
// Assembles the audit file of one circuit: the verdict and findings written below (each with its sources), the proposed
// corrections in machine-readable form, and the measurements of out/measure-<id>.json (audit.mjs) they rest on.
import { resolve } from 'node:path';
import { HERE, readJSON, writeJSON, osm, pointAt } from './lib.mjs';
import { osmLoop } from './osmline.mjs';
import { CFG } from './config.mjs';
import { FINDINGS } from './findings.mjs';

const id = process.argv[2];
const cfg = CFG[id], F = FINDINGS[id];
if (!cfg || !F) throw new Error('no config / findings for ' + id);
const M = readJSON(resolve(HERE, 'out', `measure-${id}.json`));
const G = readJSON(resolve(HERE, 'out', `game-${id}.json`));
const curvAt = (a, b) => { let k = 0, n = 0; for (const q of G.samples) { let gs = q.s; if (gs > G.builtLength / 2) gs -= G.builtLength; if (gs >= a && gs <= b) { k += q.k; n++; } } return n ? k / n : 0; };
const J = osm(id);
let only = cfg.only || null;
const rel = cfg.rel ? J.elements.find((e) => e.type === 'relation' && e.id === cfg.rel) : null;
if (rel && !only) only = rel.members.filter((m) => m.type === 'way' && !/pit/.test(m.role)).map((m) => m.ref);
const O = osmLoop(id, { first: cfg.first, rev: !!cfg.rev, only, exclude: cfg.exclude, extra: cfg.extra });
const ll = (s) => O.P.inv(...pointAt(O.xy, O.cum, s)).map((v) => +v.toFixed(7));

// Banking proposals from the lidar cross slope: stretches (>= 30 m) where the lidar and the game differ by >= 2.5 deg.
// deg = the measured mean (rounded to 0.5), always with the inside of the corner lower (checked: each entry says whether it is
// inside-lower, nearly straight or off-camber) - in the format of tools/build-tracks.mjs BANKED ({name, deg, from, to} in lat / lon).
const bank = [];
for (const st of (M.cross && M.cross.stretches) || []) {
  if (st.osmTo - st.osmFrom < 30) continue;
  const d = Math.abs(st.realMeanDeg) - Math.abs(st.gameMeanDeg);
  if (Math.abs(d) < 2.5) continue;
  if ((F.bankSkip || []).some(([a, b]) => st.osmFrom >= a && st.osmTo <= b)) continue;
  const k = curvAt(st.fromLine, st.fromLine + (st.osmTo - st.osmFrom));
  const side = Math.abs(k) < 1 / 800 ? 'nearly straight (radius ' + (k ? Math.round(1 / Math.abs(k)) : 'inf') + ' m): bankOverrides take the side from the corner direction, check it' : (Math.sign(-k) === Math.sign(st.realMeanDeg) ? 'inside-lower (radius ' + Math.round(1 / Math.abs(k)) + ' m)' : 'OFF-CAMBER (outside lower; radius ' + Math.round(1 / Math.abs(k)) + ' m): cannot be expressed by bankOverrides');
  bank.push({ side, name: `${st.near || 'unnamed'} (OSM s ${st.osmFrom}-${st.osmTo} m, ${st.fromLine} m from the line)`, deg: Math.round(Math.abs(st.realMeanDeg) * 2) / 2,
    from: ll(st.osmFrom), to: ll(st.osmTo), measured: { lidarMeanDeg: st.realMeanDeg, lidarMaxDeg: st.realMaxDeg, gameMeanDeg: st.gameMeanDeg, gameMaxDeg: st.gameMaxDeg },
    kind: d > 0 ? 'real camber missing / too small in the game' : 'game banks a corner that is (nearly) flat' });
}

const E = M.elevation;
const out = {
  id, name: M.name, auditedBy: 'track audit, region be-nl-de-gb (2026-10-01)', verdict: F.verdict,
  summary: F.summary,
  findings: F.findings,
  proposedCorrection: Object.assign({}, F.correction, bank.length ? { bankOverridesFromLidar: { note: 'optional, minor: replaces the curvature-derived bank where the 0.5-1 m lidar DTM measures a different cross slope (+-' + (M.cross ? M.cross.halfBaseM : 4) + ' m about the OSM centreline, median of 3 samples 10 m apart); the full measured series is under measurements.crossSlope.series', list: bank } } : {}),
  measurements: {
    method: 'devtests/track-audit/be-nl-de-gb/audit.mjs: game = tracks-data.js + js/track.js built in node (out/game-<id>.json from dump-game.js); OSM = Overpass (cache/overpass/<id>.json), the F1 lap chained from its raceway ways in their oneway direction; DEM sampled every 5 m along the OSM centreline, 25 m median + 5 m Gauss; game heights mapped to the OSM centreline by nearest point and aligned by the mean difference',
    osmLapWays: M.osm.loopWays, osmRelation: M.osm.relation, chicaneNote: cfg.chicaneNote,
    lengths: { osmCentrelineM: M.osm.lengthM, gameBuiltM: M.game.builtLengthM, gameLengthKm: M.game.lengthKm },
    layoutDeviationM: M.layout, direction: M.direction, startFinish: M.startFinish, pitOsm: M.pitOsm, pitGame: M.pitGame, structures: M.structures,
    elevation: { dem: E.dem, stepM: E.stepM, holesFilled: E.holes, covered: E.covered, realRangeM: E.realRangeM, realMinASL: E.realMinASL, realMinAt: E.realMinAt, realMaxASL: E.realMaxASL, realMaxAt: E.realMaxAt,
      gameRangeM: E.gameRangeM, rmsDiffM: E.rmsDiffM, maxDiffM: E.maxDiffM, maxDiffAt: E.maxDiffAt, grades50m: E.grades50, grades100m: E.grades100, mismatchRuns100m: E.mismatchRuns100, namedFeatures: E.features,
      profile25m: { columns: ['osmS', 'fromGameLine', 'lidarASL', 'gameAlignedASL'], rows: E.profile25m }, fullProfile: `devtests/track-audit/be-nl-de-gb/out/profile-${id}.json (5 m, with lat / lon)` },
    crossSlope: M.cross,
  },
  sources: F.sources,
};
writeJSON(resolve(HERE, '..', `${id}.json`), out, true);
console.log(id, out.verdict, out.findings.length, 'findings,', bank.length, 'bank proposals');
