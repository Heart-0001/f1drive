// node devtests/track-audit/eu-south-central/compose.mjs
// Writes devtests/track-audit/<id>.json for it-1922 it-1953 it-1914 at-1969 hu-1986 from the measurement files in out/
// (game-*.json: game.js; layout-*.json: layout.mjs; lt-*.json: lt.mjs; elev-*.json: elev.mjs): the findings with the
// measured numbers, the measurements themselves, and the proposed corrections in machine-readable form.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, loadGame, gameLine, proj, wrap, sdiff } from './lib.mjs';

const OUT = resolve(HERE, '..');
const J = (f) => JSON.parse(readFileSync(resolve(HERE, 'out', f), 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- sources
const SRC = {
  osm: (rel, file) => `OpenStreetMap (ODbL) circuit relation ${rel} (F1 ways, oneway tags, relation roles start / finish / pit_lane), ${file}; fetched 2026-10-01`,
  lt: (u) => `F1 live-timing archive (feed read by FastF1): ${u} (car X / Y / Z ~4 Hz; cached devtests/track-audit/cache/f1livetiming/)`,
  mv: 'MultiViewer circuit API (F1 live-timing derived corner numbers / positions): https://api.multiviewer.app/api/v1/circuits/<key>/<year> (cache devtests/track-audit/cache/multiviewer/)',
  f1hl: 'https://www.formula1.com/en/latest/article/highs-and-lows-which-f1-track-has-the-most-elevation-changes-.7I9JEcBw3R2AqXbnJ6hyvc (cache devtests/track-audit/cache/wikipedia/f1com-highs-and-lows-2016.html)',
  f1pit: 'https://www.formula1.com/en/latest/article/explained-why-are-there-pit-lane-speed-limits-in-f1-and-how-are-they-measured.jc4jiWVsfbRhb62QomSf0 (2026-06-08: "For the 2026 season the pit lane speed limit is set at 80kph"; reduced to 60 only at select events, e.g. Monaco)',
  fia: (n) => `FIA decision document https://www.fia.com/system/files/decision-document/${n} (cache devtests/track-audit/cache/fia/, text via pypdf)`,
  wiki: (p) => `https://${p} (raw wikitext cached in devtests/track-audit/cache/wikipedia/)`,
  bev: 'BEV ALS DTM 1 m (Austria, airborne laser scanning, release 2023-09-15, CC BY 4.0), COG https://data.bev.gv.at/download/ALS/DTM/20230915/ALS_DTM_CRS3035RES50000mN2650000E4650000.tif (range reads cached in devtests/track-audit/cache/bev-als-dtm-N2650000E4650000/)',
  er: 'Regione Emilia-Romagna DTM 0.5 m RER2022 (lidar Feb-May 2022 / Jan 2023, covers Imola), https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/DtmRER2022/ImageServer (getSamples; cache devtests/track-audit/cache/er-dtmrer2022/)',
  tosc: 'Regione Toscana DSM 1 m 2021 (lidar surface model) and DTM 10 m via GEOscopio WMS https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms?map=wmsmorfologia (layers rt_morfologia.iddsm2021.1m.rt, rt_morfologia.iddtm.10m.rt; GeoTIFF windows cached in devtests/track-audit/cache/toscana-*/)',
  tin: 'TINITALY 1.1 DEM 10 m (Tarquini et al. 2023, INGV, doi 10.13127/tinitaly/1.1, CC BY 4.0), WCS https://tinitaly.pi.ingv.it/TINItaly_1_1/wcs (cache devtests/track-audit/cache/tinitaly/)',
  otd: (ds) => `OpenTopoData public API https://api.opentopodata.org/v1/${ds} (cache devtests/track-audit/cache/opentopodata/)`,
  scripts: 'devtests/track-audit/eu-south-central/ (game.js, layout.mjs, lt.mjs, elev.mjs, dem.mjs, compose.mjs; measurement files in its out/)',
};

// ---------------------------------------------------------------- helpers on the measurement files
function stationsCol(E, name) { const ci = E.stations10m.columns.indexOf(name); return E.stations10m.rows.map((r) => r[ci]); }
function profileStats(h, step) {
  const n = h.length, mn = Math.min(...h), out = { rangeM: r1(Math.max(...h) - mn) };
  for (const W of [50, 100]) {
    const k = Math.round(W / 2 / step); let mx = -1e9, mi = 1e9, smx = 0, smi = 0;
    for (let i = 0; i < n; i++) { const g = (h[(i + k) % n] - h[(i - k + n) % n]) / (2 * k * step); if (g > mx) { mx = g; smx = i * step; } if (g < mi) { mi = g; smi = i * step; } }
    out['maxClimb' + W] = { pct: r1(mx * 100), s: smx }; out['maxDescent' + W] = { pct: r1(mi * 100), s: smi };
  }
  return out;
}
// proposed elevation profile every 10 m: [s, lat, lon, h above the lowest point]
function profile10(E, key, blend) {
  const s = stationsCol(E, 's'), lat = stationsCol(E, 'lat'), lon = stationsCol(E, 'lon');
  let h = stationsCol(E, key);
  if (blend) h = blend(h, s, E);
  const mn = Math.min(...h);
  return { rows: s.map((v, i) => [v, lat[i], lon[i], r2(h[i] - mn)]), h };
}
function turnDir(gl, a, b) {          // net heading change from s=a to s=b (rad, + = left)
  const total = gl.total, idx = (s) => { const t = wrap(s, total); let i = gl.S.findIndex((q) => q.s >= t); return i < 0 ? 0 : i; };
  let tot = 0, i = idx(a); const j = idx(b);
  for (let k = 0; k < gl.N && i !== j; k++) {
    const p0 = gl.P[(i - 1 + gl.N) % gl.N], p1 = gl.P[i], p2 = gl.P[(i + 1) % gl.N];
    const h1 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), h2 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    let d = h2 - h1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; tot += d; i = (i + 1) % gl.N;
  }
  return tot;
}
function llAt(game, s) {
  const S = game.samples, t = wrap(s, game.trackLength); let i = S.findIndex((q) => q.s >= t); if (i <= 0) return [S[0].lat, S[0].lon];
  const a = S[i - 1], b = S[i], u = (t - a.s) / (b.s - a.s); return [+(a.lat + (b.lat - a.lat) * u).toFixed(7), +(a.lon + (b.lon - a.lon) * u).toFixed(7)];
}
// banking: corners with |measured inside-lower angle - game inside-lower angle| >= 2 deg -> bankOverrides candidates
function bankCandidates(id, game, gl, E, key) {
  const src = E.sources[key]; if (!src || !src.cornerBanking) return { table: [], overrides: [] };
  const table = [], overrides = [];
  for (const c of src.cornerBanking) {
    const turn = turnDir(gl, c.from, c.to), right = turn < 0;
    const sgn = right ? 1 : -1;                // + = left side higher; for a right-hander the left side is the outside
    const real = c.realMeanDeg * sgn, gm = c.gameMeanDeg * sgn;
    const row = { corner: c.corner.trim(), fromS: Math.round(c.from), toS: Math.round(c.to), turn: right ? 'right' : 'left', turnDeg: r1(turn * 180 / Math.PI),
      measuredInsideLowerDeg: r1(real), gameInsideLowerDeg: r1(gm), measuredMaxAbsDeg: c.realMaxAbsDeg, gameMaxAbsDeg: c.gameMaxAbsDeg };
    table.push(row);
    if (Math.abs(real - gm) >= 2 && Math.abs(turn) > 0.35) overrides.push({ name: row.corner, deg: Math.max(0, r1(real)), from: llAt(game, c.from), to: llAt(game, c.to),
      note: `measured cross-fall ${r1(real)} deg (inside lower), game ${r1(gm)} deg; lap s ${row.fromS}-${row.toS}` });
  }
  return { table, overrides };
}
function bankProfile(E, key) {
  const src = E.sources[key]; if (!src || !src.crossSlope) return null;
  const s = stationsCol(E, 's'), lat = stationsCol(E, 'lat'), lon = stationsCol(E, 'lon');
  return { convention: '+ = left side of the racing direction higher (= js/track.js samples[].bank sign)', stepM: 10, method: src.crossSlope.method,
    offsetsM: src.crossSlope.offsetsM, droppedStations: src.crossSlope.droppedStations,
    rows: src.crossSlope.deg.map((d, i) => [s[i], lat[i], lon[i], d]) };
}
function cmpSummary(c) {
  return { rmsM: c.rmsM, maxAbsM: c.maxAbsM, maxAt: c.maxAt, grade100: c.grade100, grade50: c.grade50, zonesOver2pp100m: c.zonesOver2pp100m };
}

const AUD = '2026-10-01';
function write(id, obj) { writeFileSync(resolve(OUT, id + '.json'), JSON.stringify(obj, null, 1)); console.log('wrote', resolve(OUT, id + '.json')); }

function base(id) {
  const game = loadGame(id), gl = gameLine(id, game), L = J(`layout-${id}.json`), T = J(`lt-${id}.json`), E = J(`elev-${id}.json`);
  return { game, gl, L, T, E };
}
function measurements(id, b, extra = {}) {
  const { game, L, T, E } = b;
  return {
    game: { lengthKm: game.lengthKm, builtLengthM: r1(game.trackLength), samples: game.N, elevRangeM: E.game.rangeM, maxClimb50: E.game.maxClimb50, maxDescent50: E.game.maxDescent50,
      maxClimb100: E.game.maxClimb100, maxDescent100: E.game.maxDescent100, pit: L.pitGame, bankOverrides: game.bankOverrides, pitSide: game.pitSide, pitLimitKmh: game.pitLimitKmh },
    layout: { osmSource: L.osmSource, osmRelation: L.osmRelation, osmLayoutM: L.lengths.osmLayoutM, osmLoopOK: L.osmLayoutLoopOK, gameToOsm: L.gameToOsm, gameOffOsmZones: L.gameOffOsmZones,
      osmToGameMax: L.osmToGameMax, osmFarFromGameM: L.osmFarFromGameM, onewayAgree: L.direction.onewayLengthAgreeingFrac, corners: L.corners },
    turnNumbers: L.multiviewer ? { source: L.multiviewer.source, fitResidualM: L.multiviewer.fitResidual, corners: L.multiviewer.corners.map((c) => ({ turn: c.number + (c.letter || ''), gameS: c.gameS, d: c.d })) } : null,
    startFinish: { osmNodes: L.startFinish, gridFromLiveTiming: T.grid ? { url: T.grid.url, startUtc: T.grid.startUtc, cars: T.grid.cars, poleSlotFromGameLineM: T.grid.poleSlotFromGameLineM, lastSlotFromGameLineM: T.grid.lastSlotFromGameLineM, firstSlots: (T.grid.slots || []).slice(0, 4) } : null },
    pitOSM: L.pitOSM,
    liveTiming: { source: T.source, method: T.method, fit: T.fit, direction: T.direction },
    elevation: { stepM: E.stepM, game: E.game, sources: Object.fromEntries(Object.entries(E.sources).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => !['crossSlope', 'cornerBanking'].includes(kk)))])),
      compare: Object.fromEntries(Object.entries(E.compare).map(([k, v]) => [k, cmpSummary(v)])), profile25m: E.profile25m, snapToOsm: E.snapToOsm },
    coveredAndCrossings: L.coveredAndCrossings.map((c) => ({ kind: c.kind, osmWay: c.id, gameS: c.gameS ?? undefined, from: c.from, to: c.to,
      tags: Object.fromEntries(Object.entries(c.tags).filter(([k]) => /bridge|tunnel|covered|highway|waterway|name$|layer|building/.test(k))) })),
    ...extra,
  };
}
const zonesText = (z, n = 6) => z.slice().sort((a, b) => Math.abs(b.diffPP) - Math.abs(a.diffPP)).slice(0, n)
  .map((q) => `s ${q.from}-${q.to}${q.at ? ' (' + q.at + ')' : ''}: game ${q.firstPct}% vs ${q.secondPct}%`).join('; ');

// ================================================================= Monza
{
  const id = 'it-1922', b = base(id), { game, gl, L, T, E } = b;
  const c = E.compare.game_vs_lt, ct = E.compare.game_vs_tinitaly, lts = E.sources.lt, tin = E.sources.tinitaly;
  // recommended profile: live-timing heights, with TINITALY (offset-matched) on the start / finish straight where the
  // timing heights show a pit-lane artefact (5600 .. 300 m)
  const blend = (h, s, EE) => {
    const tinH = stationsCol(EE, 'tinitaly'), total = EE.totalM, out = h.slice();
    const inWin = (v) => v >= 5600 || v <= 300, edgeA = s.findIndex((v) => v >= 5600), edgeB = s.findIndex((v) => v > 300);
    const offA = h[edgeA] - tinH[edgeA], offB = h[edgeB] - tinH[edgeB];
    for (let i = 0; i < s.length; i++) if (inWin(s[i])) { const t = wrap(s[i] - 5600, total) / wrap(300 - 5600, total); out[i] = tinH[i] + offA + (offB - offA) * t; }
    return out;
  };
  const P = profile10(E, 'lt', blend), PS = profileStats(P.h, 10);
  const bankByCorner = L.corners.map((cc) => { const w = game.samples.filter((q) => { const len = wrap(cc.to - cc.from, game.trackLength); return wrap(q.s - cc.from, game.trackLength) <= len; }); return { corner: cc.name, from: cc.from, to: cc.to, gameMaxAbsDeg: r1(w.reduce((m, q) => (Math.abs(q.bankDeg) > Math.abs(m) ? q.bankDeg : m), 0)) }; });
  const findings = [
    { aspect: 'layout', severity: 'cosmetic', game: `current layout; built ${r1(game.trackLength)} m (dataset ${game.lengthKm} km); vs OSM F1 ways mean ${L.gameToOsm.mean} m, p95 ${L.gameToOsm.p95} m, max ${L.gameToOsm.max} m (s ${Math.round(L.gameToOsm.maxAt)}, Variante del Rettifilo)`,
      real: `FIA 2026 Italian GP circuit map "CIRCUIT CENTRELINE LENGTH - 5.793km"; OSM relation 284565 F1 ways ${L.lengths.osmLayoutM} m; same layout every season 2010-2026 (en.wikipedia: 5.793 km since the 2000 chicane changes)`,
      proposedFix: 'none', sources: [SRC.fia('2026_italian_grand_prix_-_competition_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_and_red_zone.pdf'), SRC.osm(284565, L.osmSource), SRC.wiki('en.wikipedia.org/wiki/Monza_Circuit')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'clockwise, as the dataset order', real: `all OSM oneway F1 ways agree (${L.direction.onewayLengthAgreeingFrac * 100}% of their length); 2026 qualifying cars: ${T.direction.forwardSteps} forward vs ${T.direction.backwardSteps} backward steps along the game line`, proposedFix: 'none', sources: [SRC.osm(284565, L.osmSource), SRC.lt(T.source)] },
    { aspect: 'start', severity: 'cosmetic', game: 'start / finish line = dataset point 0', real: `OSM start+finish member node 1828499259 (start lights) ${L.startFinish[0].offsetFromGameLineM} m from the game line; 2026 Italian GP grid: pole car at ${T.grid.poleSlotFromGameLineM} m, last car at ${T.grid.lastSlotFromGameLineM} m`, proposedFix: 'none (the FIA 2026 map labels a START LINE and a CONTROL LINE; the game uses one line)', sources: [SRC.osm(284565, L.osmSource) + '; node via https://api.openstreetmap.org/api/0.6/node/1828499259.json', SRC.lt(T.grid.url), SRC.fia('2026_italian_grand_prix_-_competition_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_and_red_zone.pdf')] },
    { aspect: 'pit', severity: 'minor', game: `pit lane on the right, ${L.pitGame.limitKmh} km/h, ${L.pitGame.laneLengthM} m long: entry ${L.pitGame.entryBeforeLineM} m before the line, exit ${L.pitGame.exitAfterLineM} m after`,
      real: `right side, 80 km/h (FIA 2026 decision: "the pit lane speed limit which is set at 80 km/h for this event"); OSM pit lane way 38168747 ${L.pitOSM[0].lengthM} m: leaves the track ${L.pitOSM[0].entryBeforeLineM} m before the line (Curva Alboreto exit), rejoins ${L.pitOSM[0].exitAfterLineM} m after it; real pit loss ~25.4 s (MultiViewer pitLoss.normal)`,
      proposedFix: 'side / limit correct; layout note: the generic 500 m lane is ~240 m shorter than the real one (pit-stop time loss too small); a data-driven lane (entry / exit arc positions from OSM) would fix it', sources: [SRC.fia('2026_italian_grand_prix_-_infringement_-_car_12_-_pit_lane_speeding.pdf'), SRC.f1pit, SRC.osm(284565, L.osmSource), SRC.mv] },
    { aspect: 'elevation', severity: 'major', game: `range ${E.game.rangeM} m; invented hills up to ${E.game.maxClimb50.pct}% / ${E.game.maxDescent50.pct}% (50 m) around Lesmo; highest point s ~2900 (Curva del Serraglio) ${r1(E.profile25m.find((r) => r.s === 2900).game)} m above the lowest`,
      real: `range ${lts.rangeM} m (F1 live-timing car heights, 2026 qualifying), ${tin.rangeM} m (TINITALY 10 m DTM), 12.8 m (formula1.com); en.wikipedia: "generally flat, but has a gradual gradient from the second Lesmos to the Variante Ascari"; real grades over 100 m: TINITALY +${tin.maxClimb100.pct}% / ${tin.maxDescent100.pct}%, car heights +${lts.maxClimb100.pct}% / ${lts.maxDescent100.pct}% (the +3.3% is on the start straight where the timing heights carry a pit-lane artefact). Game vs car heights: rms ${c.rmsM} m, max ${c.maxAbsM} m at s ${c.maxAt.s} (${c.maxAt.at}); grade over 100 m rms ${c.grade100.rmsPP} pp, max ${c.grade100.maxPP} pp. Invented slopes (> 2 pp over 100 m): ${zonesText(c.zonesOver2pp100m, 7)}`,
      proposedFix: `elevation source: the proposedCorrections.elevation profile (F1 live-timing car heights, TINITALY on the start straight), range ${PS.rangeM} m; or at least TINITALY 10 m (range ${tin.rangeM} m) instead of GLO-90 (the park's trees are in the surface model). No lidar was reachable (Regione Lombardia geoportal / cartografia.servizirl.it time out from here; the national PCN lidar WMS answers 403)`,
      sources: [SRC.lt(T.source), SRC.tin, SRC.f1hl, SRC.wiki('en.wikipedia.org/wiki/Monza_Circuit'), SRC.otd('eudem25m')] },
    { aspect: 'gradient', severity: 'major', game: 'Lesmo 2 -> Ascari: one long descent from the invented hump (s 2950-3600: -11.1 m, steepest -3.5%/100 m); no dip at the underpass',
      real: 'the road dips ~5 m to pass under the old banking: car heights 192.7 m (s 3005) -> 187.6 m (s 3300, the underpass) -> 190.9 m (s 3595), -1.7% / +1.2%; formula1.com: "the significant dip coming on the drag between the second Lesmo (Turn 7) and Ascari (Turn 8)"; TINITALY (10 m, interpolated) misses the cut',
      proposedFix: 'comes with the proposed profile (the live-timing heights carry the dip)', sources: [SRC.lt(T.source), SRC.f1hl, SRC.osm(284565, L.osmSource) + ' (way 1443867793 covered=yes)'] },
    { aspect: 'banking', severity: 'cosmetic', game: `curvature-derived banking only; max per corner: ${bankByCorner.map((q) => q.corner + ' ' + q.gameMaxAbsDeg).join(', ')} deg`,
      real: 'no published bank angle for the road course (en.wikipedia only: Lesmo 1 "has a slight banking"; the 1955 oval bankings are not on the F1 lap). Not measured: no lidar reachable for Monza from here (see elevation)',
      proposedFix: 'none until measured', sources: [SRC.wiki('en.wikipedia.org/wiki/Monza_Circuit')] },
    { aspect: 'bridge', severity: 'minor', game: 'no structures over the track', real: 'the F1 lap passes UNDER the old high-speed oval: OSM way 34404729 (raceway, bridge=yes, layer 1, "anello alta velocità") over F1 way 1443867793 (covered=yes, 25 m) at s ~3283-3310, between Curva del Serraglio and Curva Vialone (Ascari); footbridges over the track at s ~4124 (way 194458113, covered) and s ~4418 (way 194458112); the podium bridge-building (way 219396377 "Podio") over the main straight ~270 m before the line',
      proposedFix: 'scenery: a concrete banking bridge at s ~3292 (the landmark) and the footbridges (proposedCorrections.bridgesOver)', sources: [SRC.osm(284565, L.osmSource)] },
  ];
  const bridgesOver = [
    { kind: 'old oval banking bridge (Sopraelevata Nord)', osmWay: 34404729, carWay: 1443867793, gameS: 3292, at: llAt(game, 3292), lengthM: 25 },
    { kind: 'covered footbridge', osmWay: 194458113, gameS: 4124, at: llAt(game, 4124) },
    { kind: 'footbridge', osmWay: 194458112, gameS: 4418, at: llAt(game, 4418) },
    { kind: 'podium bridge building', osmWay: 219396377, gameS: 5520, at: llAt(game, 5520), note: 'OSM building=tower, bridge=yes, layer 1, beside / over the main straight' },
  ];
  write(id, { id, name: game.name, audited: AUD, auditor: SRC.scripts, verdict: 'major issues', findings,
    measurements: measurements(id, b, { gameBankByCorner: bankByCorner }),
    proposedCorrections: {
      elevation: { source: 'F1 live-timing car heights (median of all cars, 2026 Italian GP qualifying) with TINITALY 10 m on s 5600..300 (offset-matched)', alternative: 'TINITALY 10 m DTM via WCS (no underpass dip)', stats: PS,
        profile10m: { columns: ['s (game arc length, m)', 'lat', 'lon (OSM-snapped centreline)', 'h (m above the lowest point)'], rows: P.rows } },
      START_AT: null, pitSide: -1, pitLimitKmh: 80, bankOverrides: [], bridgesOver,
      COVERED: [{ name: 'under the old banking', from: llAt(game, 3270), to: llAt(game, 3320), pad: 10, note: 'only needed with a surface model; the proposed profile is unaffected' }],
      layoutNote: 'layout current (5.793 km); pit lane real length 741 m from 559 m before the line to 182 m after it (OSM way 38168747)' },
    reproduce: ['node devtests/track-audit/eu-south-central/game.js', 'node devtests/track-audit/eu-south-central/layout.mjs', 'node devtests/track-audit/eu-south-central/lt.mjs', 'node devtests/track-audit/eu-south-central/elev.mjs', 'node devtests/track-audit/eu-south-central/feat.mjs <id> <reference> <from-to:label> ... (feature gradients)', 'node devtests/track-audit/eu-south-central/xprobe.mjs <id> <s> ... (lidar cross-sections)', 'node devtests/track-audit/eu-south-central/compose.mjs'] });
}

// ================================================================= Imola
{
  const id = 'it-1953', b = base(id), { game, gl, L, T, E } = b;
  const c = E.compare.game_vs_er, er = E.sources.er, lts = E.sources.lt, cel = E.compare.er_vs_lt;
  const P = profile10(E, 'er'), PS = profileStats(P.h, 10), BK = bankCandidates(id, game, gl, E, 'er');
  const findings = [
    { aspect: 'layout', severity: 'cosmetic', game: `2008+ layout with the Variante Bassa bypass; built ${r1(game.trackLength)} m; vs OSM F1 ways mean ${L.gameToOsm.mean} m, p95 ${L.gameToOsm.p95} m, max ${L.gameToOsm.max} m`,
      real: `FIA 2025 Emilia Romagna GP map "Circuit Centreline Length = 4.909km"; OSM relation 9291096 without the motorcycle chicane ways (176764793, 1025616646, 1025616647) ${L.lengths.osmLayoutM} m; F1 used this layout 2020-2022 and 2024-2025 (2023 cancelled); not on the 2026 calendar`,
      proposedFix: 'none', sources: [SRC.fia('2025_emilia_romagna_grand_prix_-_race_director_event_notes_-_circuit_map_pit_lane_emergency_exits_quarantine_zone_and_red_zones.pdf'), SRC.osm(9291096, L.osmSource), SRC.wiki('en.wikipedia.org/wiki/Imola_Circuit')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'anticlockwise, as the dataset order', real: `OSM oneway ways agree (${L.direction.onewayLengthAgreeingFrac * 100}%); 2025 qualifying cars ${T.direction.forwardSteps} forward vs ${T.direction.backwardSteps} backward steps`, proposedFix: 'none', sources: [SRC.osm(9291096, L.osmSource), SRC.lt(T.source)] },
    { aspect: 'start', severity: 'cosmetic', game: 'line = dataset point 0', real: `OSM raceway=finish nodes 1872449434 / 5167232891 at +1.1 m; 2025 Emilia Romagna GP grid: pole car at ${T.grid.poleSlotFromGameLineM} m, last at ${T.grid.lastSlotFromGameLineM} m (the OSM raceway=start node 5106325593 at +218 m is not the F1 grid)`, proposedFix: 'none', sources: [SRC.osm(9291096, L.osmSource), SRC.lt(T.grid.url)] },
    { aspect: 'pit', severity: 'minor', game: `right, ${L.pitGame.limitKmh} km/h, ${L.pitGame.laneLengthM} m (entry ${L.pitGame.entryBeforeLineM} m before the line, exit ${L.pitGame.exitAfterLineM} m after)`,
      real: `right, 80 km/h (FIA 2025 decision car 43: "set at 80 km/h for this event"); OSM pit lane way 196368195 ${L.pitOSM[0].lengthM} m from ${L.pitOSM[0].entryBeforeLineM} m before the line (after Rivazza) to ${L.pitOSM[0].exitAfterLineM} m after; real pit loss ~28.0 s (MultiViewer)`,
      proposedFix: 'side / limit correct; layout note: the real lane is ~2x the generic 500 m', sources: [SRC.fia('2025_emilia_romagna_grand_prix_-_infringement_-_car_43_-_pit_lane_speeding.pdf'), SRC.osm(9291096, L.osmSource), SRC.mv] },
    { aspect: 'elevation', severity: 'major', game: `range ${E.game.rangeM} m; the profile is shifted / smeared along the lap (GLO-90 + smoothing): steepest climb ${E.game.maxClimb100.pct}%/100 m at s ${E.game.maxClimb100.s} (${E.game.maxClimb100.at}), steepest descent ${E.game.maxDescent100.pct}%/100 m at s ${E.game.maxDescent100.s} (${E.game.maxDescent100.at})`,
      real: `lidar DTM 0.5 m along the OSM centreline: range ${er.rangeM} m (${er.absMinM}..${er.absMaxM} m ASL); steepest climb ${er.maxClimb100.pct}%/100 m (${er.maxClimb50.pct}%/50 m) at ${er.maxClimb100.at}, steepest descent ${er.maxDescent100.pct}%/100 m at ${er.maxDescent100.at}; F1 car heights agree with the lidar (rms ${cel.rmsM} m, grade rms ${cel.grade100.rmsPP} pp). Game vs lidar: rms ${c.rmsM} m, max ${c.maxAbsM} m at s ${c.maxAt.s} (${c.maxAt.at}), grade over 100 m rms ${c.grade100.rmsPP} pp, max ${c.grade100.maxPP} pp; worst zones: ${zonesText(c.zonesOver2pp100m, 6)}`,
      proposedFix: `elevation source: Regione Emilia-Romagna DTM 0.5 m RER2022 (ArcGIS getSamples, POST, 100 points per request; same pattern as the AHN source) - profile in proposedCorrections.elevation (range ${PS.rangeM} m)`, sources: [SRC.er, SRC.lt(T.source)] },
    { aspect: 'gradient', severity: 'major', game: 'Piratella -> Acque Minerali (s 2200-2850): -9.0 m, -10.0%/100 m at s 2450 then level at ~18.5 m from s 2600 to 2850; climb to Variante Alta +16.1 m, max +5.5%/100 m; Rivazza descent (s 3700-4300) -29.8 m, max -10.7%/100 m (-11.5%/50 m); after Tosa a -3.9% dip then +9.6% at s 2170, summit at s 2330',
      real: 'lidar: Piratella -> Acque Minerali -21.2 m, steepest -7.9%/100 m at s 2560 (the dip is 12 m deeper than in the game); Acque Minerali -> Variante Alta +19.2 m, max +8.2%/100 m (+9.0%/50 m) at T13; Rivazza descent -25.0 m, max -6.9%/100 m (game 3.8 pp too steep); Tosa -> Piratella a steady climb (max +6.4%), summit at s 2180',
      proposedFix: 'comes with the lidar profile', sources: [SRC.er, SRC.lt(T.source)] },
    { aspect: 'banking', severity: 'minor', game: `curvature-derived up to ${er.crossSummary.gameAbsMaxDeg} deg (p95 ${er.crossSummary.gameAbsP95Deg})`,
      real: `lidar cross-fall across +-4 m: median ${er.crossSummary.realAbsMedianDeg} deg, p95 ${er.crossSummary.realAbsP95Deg}, max ${er.crossSummary.realAbsMaxDeg} (Piratella, which the game matches). The game over-banks the chicanes and hairpins: ${BK.table.filter((q) => Math.abs(q.measuredInsideLowerDeg - q.gameInsideLowerDeg) >= 2).map((q) => `${q.corner} measured ${q.measuredInsideLowerDeg} vs game ${q.gameInsideLowerDeg} (game max ${q.gameMaxAbsDeg})`).join('; ')}`,
      proposedFix: 'bankOverrides in proposedCorrections (measured angles), or better the measured cross-fall profile (proposedCorrections.bankProfile10m) instead of the curvature law; no published bank angles exist', sources: [SRC.er] },
    { aspect: 'bridge', severity: 'minor', game: 'no structures over the track', real: 'road bridge Viale dei Colli (OSM way 22911424, bridge=yes, layer 1) crosses over the track at s ~3936 (the run from Variante Alta down to Rivazza); several roads / paths pass UNDER the track (tunnels, not visible from the car)',
      proposedFix: 'scenery: the road bridge (proposedCorrections.bridgesOver)', sources: [SRC.osm(9291096, L.osmSource)] },
  ];
  write(id, { id, name: game.name, audited: AUD, auditor: SRC.scripts, verdict: 'major issues', findings,
    measurements: measurements(id, b, { banking: { source: er.label, summary: er.crossSummary, steepest: er.steepestCrossFall, corners: BK.table } }),
    proposedCorrections: {
      elevation: { source: 'er-dtmrer2022 (Regione Emilia-Romagna DTM 0.5 m, lidar 2022/23)', serviceUrl: 'https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/DtmRER2022/ImageServer/getSamples', stats: PS,
        profile10m: { columns: ['s (game arc length, m)', 'lat', 'lon (OSM-snapped centreline)', 'h (m above the lowest point)'], rows: P.rows } },
      bankOverrides: BK.overrides, bankProfile10m: bankProfile(E, 'er'), START_AT: null, pitSide: -1, pitLimitKmh: 80,
      bridgesOver: [{ kind: 'road bridge (Viale dei Colli)', osmWay: 22911424, gameS: 3936, at: llAt(game, 3936) }],
      layoutNote: 'layout current for 2020-2025 (4.909 km, Variante Bassa bypass); real pit lane 1032 m (OSM way 196368195)' },
    reproduce: ['node devtests/track-audit/eu-south-central/game.js', 'node devtests/track-audit/eu-south-central/layout.mjs', 'node devtests/track-audit/eu-south-central/lt.mjs', 'node devtests/track-audit/eu-south-central/elev.mjs', 'node devtests/track-audit/eu-south-central/feat.mjs <id> <reference> <from-to:label> ... (feature gradients)', 'node devtests/track-audit/eu-south-central/xprobe.mjs <id> <s> ... (lidar cross-sections)', 'node devtests/track-audit/eu-south-central/compose.mjs'] });
}

// ================================================================= Mugello
{
  const id = 'it-1914', b = base(id), { game, gl, L, T, E } = b;
  const c = E.compare.game_vs_toscDSM, ds = E.sources.toscDSM, lts = E.sources.lt, cdl = E.compare.toscDSM_vs_lt;
  const P = profile10(E, 'toscDSM'), PS = profileStats(P.h, 10), BK = bankCandidates(id, game, gl, E, 'toscDSM');
  const findings = [
    { aspect: 'layout', severity: 'cosmetic', game: `2020 Tuscan GP layout; built ${r1(game.trackLength)} m; vs OSM F1 ways mean ${L.gameToOsm.mean} m, p95 ${L.gameToOsm.p95} m, max ${L.gameToOsm.max} m`,
      real: `en.wikipedia: 5.245 km; OSM relation 8487163 ${L.lengths.osmLayoutM} m; F1 raced here once (2020 Tuscan GP)`, proposedFix: 'none', sources: [SRC.osm(8487163, L.osmSource), SRC.wiki('en.wikipedia.org/wiki/Mugello_Circuit')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'clockwise', real: `OSM oneway ways agree (${L.direction.onewayLengthAgreeingFrac * 100}%); 2020 qualifying cars ${T.direction.forwardSteps} forward vs ${T.direction.backwardSteps} backward steps`, proposedFix: 'none', sources: [SRC.osm(8487163, L.osmSource), SRC.lt(T.source)] },
    { aspect: 'start', severity: 'cosmetic', game: 'line = dataset point 0', real: `no OSM start / finish node; 2020 Tuscan GP grid: pole car at ${T.grid.poleSlotFromGameLineM} m, last at ${T.grid.lastSlotFromGameLineM} m`, proposedFix: 'none', sources: [SRC.lt(T.grid.url)] },
    { aspect: 'pit', severity: 'minor', game: `right, ${L.pitGame.limitKmh} km/h, ${L.pitGame.laneLengthM} m (entry ${L.pitGame.entryBeforeLineM} m before the line, exit ${L.pitGame.exitAfterLineM} m after); the side came from the inside-of-the-lap fallback: the only 'pit' building in scenery-data.js for it-1914 is the "Ingresso Paddock" roof (OSM way 556089654) 135 m from the track beside Arrabbiata 1 (s ~2391)`,
      real: `right, 80 km/h for F1 (FIA 2020 decision car 10: "set at 80 km/h for this Event"; the OSM pit lane way's maxspeed=60 is not the F1 limit); OSM pit lane way 197788411 ${L.pitOSM.find((q) => q.id === 197788411).lengthM} m from ${L.pitOSM.find((q) => q.id === 197788411).entryBeforeLineM} m before the line to ${L.pitOSM.find((q) => q.id === 197788411).exitAfterLineM} m after`,
      proposedFix: 'side / limit correct; scenery note: the real pit garages are missing and a paddock entrance roof is drawn as a pit building', sources: ['FIA decision https://www.fia.com/sites/default/files/decision-document/2020 Tuscan Grand Prix - Offence - Car 10 - Pit lane speeding.pdf (cache devtests/track-audit/cache/fia/2020_tuscan_car10_pit_lane_speeding.pdf)', SRC.osm(8487163, L.osmSource)] },
    { aspect: 'elevation', severity: 'major', game: `range ${E.game.rangeM} m; a 10 m hump at the end of the main straight (s ~550, 32.4 m above the lowest point) and a dip after Poggio Secco (s 1300-1700, 8-10 m too low)`,
      real: `Toscana lidar DSM 1 m on the asphalt (median 25 m + Gauss 10 m): range ${ds.rangeM} m (${ds.absMinM}..${ds.absMaxM} m ASL); 2020 car heights ${lts.rangeM} m (DSM vs cars rms ${cdl.rmsM} m, grade rms ${cdl.grade100.rmsPP} pp); it.wikipedia: main straight "in salita lungo 1141 m". Game vs DSM: rms ${c.rmsM} m, max ${c.maxAbsM} m at s ${c.maxAt.s} (${c.maxAt.at}), grade over 100 m rms ${c.grade100.rmsPP} pp, max ${c.grade100.maxPP} pp; worst zones: ${zonesText(c.zonesOver2pp100m, 6)}`,
      proposedFix: `elevation source: Regione Toscana DSM 1 m 2021 (WMS GetMap image/tiff float32 in EPSG:32632) with a 25 m median (footbridge spike at s ~48: +16 m) - profile in proposedCorrections.elevation (range ${PS.rangeM} m); the 10 m DTM layer is a coarser alternative`, sources: [SRC.tosc, SRC.lt(T.source), SRC.wiki('it.wikipedia.org/wiki/Autodromo_internazionale_del_Mugello')] },
    { aspect: 'gradient', severity: 'major', game: 'San Donato (T1): the braking zone and hairpin go DOWNHILL: s 450-900 -3.5 m, steepest -6.4%/100 m at s 660',
      real: 'lidar: San Donato is approached and taken UPHILL: s 450-900 +12.9 m, up to +6.5%/100 m at s 810 (2020 car heights the same: 22.9 m -> 35.5 m over s 600-900). Other famous features: Arrabbiata climb +29.8 m, max +9.3%/100 m (game +30.6 m, 8.1%: ok); Casanova -> Savelli descent -35.6 m, max -8.2% (game -30.0 m, -6.6%)',
      proposedFix: 'comes with the lidar profile', sources: [SRC.tosc, SRC.lt(T.source)] },
    { aspect: 'banking', severity: 'minor', game: `curvature-derived up to ${ds.crossSummary.gameAbsMaxDeg} deg (p95 ${ds.crossSummary.gameAbsP95Deg})`,
      real: `lidar DSM cross-fall across +-4 m (${E.sources.toscDSM.crossSlope.droppedStations} of ${E.sources.toscDSM.crossSummary.stations} stations not planar, dropped and interpolated): median ${ds.crossSummary.realAbsMedianDeg} deg, p95 ${ds.crossSummary.realAbsP95Deg}; corners differing by >= 2 deg: ${BK.table.filter((q) => Math.abs(q.measuredInsideLowerDeg - q.gameInsideLowerDeg) >= 2).map((q) => `${q.corner} measured ${q.measuredInsideLowerDeg} vs game ${q.gameInsideLowerDeg}`).join('; ')} (inside-lower degrees; Arrabbiata 1 is really cambered ~5-7 deg, Scarperia / Luco / Savelli are flat)`,
      proposedFix: 'bankOverrides in proposedCorrections (measured), or the measured cross-fall profile; DSM caveat: a surface model, readings next to kerbs / barriers / gantries were filtered (Theil-Sen + planarity test)', sources: [SRC.tosc] },
    { aspect: 'bridge', severity: 'minor', game: 'no structures over the track', real: 'covered suspension footbridge over the main straight ~50 m after the line (OSM way 612264990: bridge=boardwalk, covered=yes, layer 2; the DSM shows its deck ~16 m above the road)',
      proposedFix: 'scenery: the footbridge (proposedCorrections.bridgesOver); with a surface model as elevation source add it to COVERED', sources: [SRC.osm(8487163, L.osmSource), SRC.tosc] },
  ];
  write(id, { id, name: game.name, audited: AUD, auditor: SRC.scripts, verdict: 'major issues', findings,
    measurements: measurements(id, b, { banking: { source: ds.label, summary: ds.crossSummary, steepest: ds.steepestCrossFall, corners: BK.table } }),
    proposedCorrections: {
      elevation: { source: 'toscana-dsm2021-1m (Regione Toscana lidar DSM 1 m, 25 m median)', serviceUrl: 'https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms?map=wmsmorfologia&service=WMS&version=1.3.0&request=GetMap&layers=rt_morfologia.iddsm2021.1m.rt&crs=EPSG:32632&format=image/tiff', stats: PS,
        profile10m: { columns: ['s (game arc length, m)', 'lat', 'lon (OSM-snapped centreline)', 'h (m above the lowest point)'], rows: P.rows } },
      COVERED: [{ name: 'main-straight footbridge', from: llAt(game, 38), to: llAt(game, 60), pad: 5, note: 'only with a surface model' }],
      bankOverrides: BK.overrides, bankProfile10m: Object.assign(bankProfile(E, 'toscDSM'), { suspectRanges: [{ fromS: 4100, toS: 4260, note: 'straight between Biondetti and Bucine: the DSM cross-sections rise ~1 m to +3 m then fall (not a plane; 6-9 deg readings are not credible on a straight) - do not use' }] }), START_AT: null, pitSide: -1, pitLimitKmh: 80,
      bridgesOver: [{ kind: 'covered suspension footbridge', osmWay: 612264990, gameS: 50, at: llAt(game, 50) }],
      sceneryNote: 'scenery-data.js it-1914: the "pit" building is OSM way 556089654 "Ingresso Paddock"; the pit garages beside the main straight are missing',
      layoutNote: 'layout = 2020 Tuscan GP (5.245 km); real pit lane ~1014 m (OSM way 197788411)' },
    reproduce: ['node devtests/track-audit/eu-south-central/game.js', 'node devtests/track-audit/eu-south-central/layout.mjs', 'node devtests/track-audit/eu-south-central/lt.mjs', 'node devtests/track-audit/eu-south-central/elev.mjs', 'node devtests/track-audit/eu-south-central/feat.mjs <id> <reference> <from-to:label> ... (feature gradients)', 'node devtests/track-audit/eu-south-central/xprobe.mjs <id> <s> ... (lidar cross-sections)', 'node devtests/track-audit/eu-south-central/compose.mjs'] });
}

// ================================================================= Red Bull Ring
{
  const id = 'at-1969', b = base(id), { game, gl, L, T, E } = b;
  const c = E.compare.game_vs_bev, bev = E.sources.bev, lts = E.sources.lt, cbl = E.compare.bev_vs_lt;
  const P = profile10(E, 'bev'), PS = profileStats(P.h, 10), BK = bankCandidates(id, game, gl, E, 'bev');
  const sf = L.startFinish;
  const findings = [
    { aspect: 'layout', severity: 'cosmetic', game: `1996+ layout (used 2014-2026); built ${r1(game.trackLength)} m (dataset ${game.lengthKm} km); vs OSM F1 ways mean ${L.gameToOsm.mean} m, p95 ${L.gameToOsm.p95} m, max ${L.gameToOsm.max} m`,
      real: `FIA 2026 Austrian GP map "CIRCUIT CENTRELINE LENGTH - 4.326km" (8 m more than the long-standing 4.318 km); OSM relation 5309181 without the MotoGP chicane / long-lap / pit ways ${L.lengths.osmLayoutM} m`, proposedFix: 'none (0.2 %)', sources: [SRC.fia('2026_austrian_grand_prix_-_competition_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_and_red_zone.pdf'), SRC.osm(5309181, L.osmSource)] },
    { aspect: 'direction', severity: 'cosmetic', game: 'clockwise', real: `OSM oneway ways agree (${L.direction.onewayLengthAgreeingFrac * 100}%); 2026 qualifying cars ${T.direction.forwardSteps} forward vs ${T.direction.backwardSteps} backward steps`, proposedFix: 'none', sources: [SRC.osm(5309181, L.osmSource), SRC.lt(T.source)] },
    { aspect: 'start', severity: 'cosmetic', game: 'one start / finish line = dataset point 0', real: `OSM node 13826152421 "Start Line" at ${sf.find((q) => q.role === 'start').offsetFromGameLineM} m and node 13826152422 "Finish Line" at ${sf.find((q) => q.role === 'finish').offsetFromGameLineM} m (FIA map: START LINE and CONTROL LINE); 2026 Austrian GP grid: pole car at ${T.grid.poleSlotFromGameLineM} m`, proposedFix: 'none for the start; optional: time laps at the control line 126 m before the start line', sources: [SRC.osm(5309181, L.osmSource), SRC.lt(T.grid.url), SRC.fia('2026_austrian_grand_prix_-_competition_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_and_red_zone.pdf')] },
    { aspect: 'pit', severity: 'minor', game: `right, ${L.pitGame.limitKmh} km/h, ${L.pitGame.laneLengthM} m (entry ${L.pitGame.entryBeforeLineM} m before the line, exit ${L.pitGame.exitAfterLineM} m after)`,
      real: `right, 80 km/h (FIA 2026 decision car 14: "set at 80 km/h for this event"); OSM pit lane way 289111668 ${L.pitOSM[0].lengthM} m from ${L.pitOSM[0].entryBeforeLineM} m before the line (between T9 and T10) to ${L.pitOSM[0].exitAfterLineM} m after it (after T1); real pit loss ~21.3 s (MultiViewer)`,
      proposedFix: 'side / limit correct; layout note: the real lane is 2x the generic one and its exit joins after Turn 1', sources: [SRC.fia('2026_austrian_grand_prix_-_infringement_-_car_14_-_pit_lane_speeding.pdf'), SRC.osm(5309181, L.osmSource), SRC.mv] },
    { aspect: 'elevation', severity: 'minor', game: `range ${E.game.rangeM} m; steepest ${E.game.maxClimb50.pct}% / ${E.game.maxDescent50.pct}% over 50 m; the famous climb to T3: ${E.game.maxClimb100.pct}%/100 m`,
      real: `BEV ALS DTM 1 m along the OSM centreline: range ${bev.rangeM} m (${bev.absMinM}..${bev.absMaxM} m ASL), steepest ${bev.maxClimb50.pct}% / ${bev.maxDescent50.pct}% over 50 m, climb to T3 ${bev.maxClimb100.pct}%/100 m; de.wikipedia "maximale Steigung 12 % und maximale Gefälle 9,3 %", en.wikipedia 65 m, formula1.com 63.5 m; car heights ${lts.rangeM} m. Game vs lidar: rms ${c.rmsM} m, max ${c.maxAbsM} m, grade over 100 m rms ${c.grade100.rmsPP} pp, max ${c.grade100.maxPP} pp. Local GLO-90 errors (4-6 m humps, > 2 pp): ${zonesText(c.zonesOver2pp100m, 8)}`,
      proposedFix: `elevation source: BEV ALS DTM 1 m (cloud-optimised GeoTIFF, EPSG:3035, HTTP range reads; one 50 km tile N2650000E4650000) - profile in proposedCorrections.elevation (range ${PS.rangeM} m)`, sources: [SRC.bev, SRC.wiki('de.wikipedia.org/wiki/Red_Bull_Ring'), SRC.wiki('en.wikipedia.org/wiki/Red_Bull_Ring'), SRC.f1hl, SRC.lt(T.source)] },
    { aspect: 'gradient', severity: 'minor', game: 'Schönberg straight (T3 -> T4) 5-7 m too high, then -8.5%/100 m at s 1880; +4.9% hump after T5 (s 2300); +8.5% hump before T9 (s 3350)',
      real: 'lidar: Schönberg straight a steady -4..-5.7%; after T5 +1.6% at most; before T9 +4.3% at most; the climbs to T1 (+10.3%/100 m) and T3 (+12.1%/100 m) and the descent to T7 (-8.6%/100 m) match the game within 1.2 pp',
      proposedFix: 'comes with the lidar profile', sources: [SRC.bev] },
    { aspect: 'banking', severity: 'minor', game: `curvature-derived up to ${bev.crossSummary.gameAbsMaxDeg} deg (p95 ${bev.crossSummary.gameAbsP95Deg})`,
      real: `lidar DTM cross-fall: median ${bev.crossSummary.realAbsMedianDeg} deg, p95 ${bev.crossSummary.realAbsP95Deg}, max ${bev.crossSummary.realAbsMaxDeg} (T3 Remus); per corner (inside lower): ${BK.table.map((q) => `${q.corner} ${q.measuredInsideLowerDeg} vs game ${q.gameInsideLowerDeg}`).join('; ')}; no published bank angles (tools/build-tracks.mjs BANKED comment)`,
      proposedFix: 'bankOverrides where the game differs by >= 2 deg (proposedCorrections), or the measured cross-fall profile', sources: [SRC.bev] },
    { aspect: 'tunnel', severity: 'cosmetic', game: 'nothing over the track', real: 'nothing over the track in OSM: only roads (Red-Bull-Ring-Straße tunnels at s ~242 and ~3242) and streams pass under it', proposedFix: 'none', sources: [SRC.osm(5309181, L.osmSource)] },
  ];
  write(id, { id, name: game.name, audited: AUD, auditor: SRC.scripts, verdict: 'minor issues', findings,
    measurements: measurements(id, b, { banking: { source: bev.label, summary: bev.crossSummary, steepest: bev.steepestCrossFall, corners: BK.table } }),
    proposedCorrections: {
      elevation: { source: 'bev-als-dtm-1m (Austria ALS DTM 1 m, COG)', tileUrl: 'https://data.bev.gv.at/download/ALS/DTM/20230915/ALS_DTM_CRS3035RES50000mN2650000E4650000.tif', crs: 'EPSG:3035 (ETRS89-LAEA), orthometric heights', stats: PS,
        profile10m: { columns: ['s (game arc length, m)', 'lat', 'lon (OSM-snapped centreline)', 'h (m above the lowest point)'], rows: P.rows } },
      bankOverrides: BK.overrides, bankProfile10m: bankProfile(E, 'bev'), START_AT: null, pitSide: -1, pitLimitKmh: 80, bridgesOver: [],
      layoutNote: 'layout current; control (timing) line 126 m before the start line (OSM nodes 13826152422 / 13826152421); real pit lane 1001 m from between T9-T10 to after T1' },
    reproduce: ['node devtests/track-audit/eu-south-central/game.js', 'node devtests/track-audit/eu-south-central/layout.mjs', 'node devtests/track-audit/eu-south-central/lt.mjs', 'node devtests/track-audit/eu-south-central/elev.mjs', 'node devtests/track-audit/eu-south-central/feat.mjs <id> <reference> <from-to:label> ... (feature gradients)', 'node devtests/track-audit/eu-south-central/xprobe.mjs <id> <s> ... (lidar cross-sections)', 'node devtests/track-audit/eu-south-central/compose.mjs'] });
}

// ================================================================= Hungaroring
{
  const id = 'hu-1986', b = base(id), { game, gl, L, T, E } = b;
  const T25 = J('lt-hu-1986-2025.json');
  const c = E.compare.game_vs_lt, lts = E.sources.lt, eu = E.sources.eudem, sr = E.sources.srtm30;
  const P = profile10(E, 'lt'), PS = profileStats(P.h, 10);
  const startS = -240, startLL = llAt(game, game.trackLength + startS);
  const t1 = L.multiviewer.corners.find((q) => q.number === 1);
  const findings = [
    { aspect: 'layout', severity: 'cosmetic', game: `2003+ layout; built ${r1(game.trackLength)} m (dataset ${game.lengthKm} km); vs OSM F1 ways mean ${L.gameToOsm.mean} m, p95 ${L.gameToOsm.p95} m, max ${L.gameToOsm.max} m (s ${Math.round(L.gameToOsm.maxAt)}, T8)`,
      real: `FIA 2026 Hungarian GP map "CIRCUIT CENTRELINE LENGTH - 4.381km"; OSM relation 284557 ${L.lengths.osmLayoutM} m. Where game and OSM differ by > 3 m the 2026 cars' median path is closer to the game line (mean |car - game| 2.6 m vs |car - OSM| 5.3 m): the OSM ways are the less accurate ones`,
      proposedFix: 'none', sources: [SRC.fia('2026_hungarian_grand_prix_-_competition_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_and_red_zone.pdf'), SRC.osm(284557, L.osmSource), SRC.lt(T.source)] },
    { aspect: 'direction', severity: 'cosmetic', game: 'clockwise', real: `OSM oneway ways agree (${L.direction.onewayLengthAgreeingFrac * 100}%); 2026 qualifying cars ${T.direction.forwardSteps} forward vs ${T.direction.backwardSteps} backward steps`, proposedFix: 'none', sources: [SRC.osm(284557, L.osmSource), SRC.lt(T.source)] },
    { aspect: 'start', severity: 'major', game: `start / finish line (dataset point 0) ${Math.round(t1.gameS)} m before Turn 1 apex, under the footbridge (OSM way 493519980)`,
      real: `the real start / control line is ~240 m earlier: 2025 Hungarian GP grid pole car (16) at ${T25.grid.poleSlotFromGameLineM} m, P2 (81) ${T25.grid.slots[1].s} m, P3 (4) ${T25.grid.slots[2].s} m; 2026 grid pole at ${T.grid.poleSlotFromGameLineM} m; FIA 2026 circuit map: START LINE and CONTROL LINE side by side ~600 m before T1 (scaled with its "SPEED TRAP [T] - 310m before T1"); no OSM start / finish node`,
      proposedFix: `START_AT 'hu-1986': [${startLL[0]}, ${startLL[1]}] (game centreline ${-startS} m before the current line; +-10 m). Moves the grid, the timing line and the generic pit lane; the scenery pit building (s -280..+32 around the old line) then lies around the line as it should`,
      sources: [SRC.lt(T25.grid.url), SRC.lt(T.grid.url), SRC.fia('2026_hungarian_grand_prix_-_competition_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_and_red_zone.pdf'), SRC.mv] },
    { aspect: 'pit', severity: 'minor', game: `right, ${L.pitGame.limitKmh} km/h, ${L.pitGame.laneLengthM} m centred on the (misplaced) line`,
      real: `right, 80 km/h (FIA 2026 decision car 44: "set at 80 km/h for this event"); OSM pit lane way 231417580 ${L.pitOSM[0].lengthM} m from ${L.pitOSM[0].entryBeforeLineM} m before the game line (~${L.pitOSM[0].entryBeforeLineM + startS} m before the real line) to ${L.pitOSM[0].exitAfterLineM} m after it (~${L.pitOSM[0].exitAfterLineM - startS} m after the real line); real pit loss ~21.2 s (MultiViewer)`,
      proposedFix: 'side / limit correct; follows the START_AT fix', sources: [SRC.fia('2026_hungarian_grand_prix_-_infringement_-_car_44_-_pit_lane_speeding.pdf'), SRC.osm(284557, L.osmSource), SRC.mv] },
    { aspect: 'elevation', severity: 'minor', game: `range ${E.game.rangeM} m, steepest ${E.game.maxClimb50.pct}% / ${E.game.maxDescent50.pct}% over 50 m; T8-T13 section ~4 m too low relative to the rest (net +1.6 m over s 2400-3700)`,
      real: `F1 car heights (2026 qualifying): range ${lts.rangeM} m, ${lts.maxClimb50.pct}% / ${lts.maxDescent50.pct}% over 50 m, s 2400-3700 +5.4 m; formula1.com 34.7 m; de.wikipedia "Höhenunterschied ... 36 m, der größte Anstieg beträgt 6,2 % und das größte Gefälle 7,0 %"; EU-DEM ${eu.rangeM} m / SRTM ${sr.rangeM} m (surface models). Game vs car heights: rms ${c.rmsM} m, max ${c.maxAbsM} m at s ${c.maxAt.s}, grade over 100 m rms ${c.grade100.rmsPP} pp, max ${c.grade100.maxPP} pp`,
      proposedFix: `optional: the car-height profile in proposedCorrections.elevation (range ${PS.rangeM} m); no open lidar for Hungary`, sources: [SRC.lt(T.source), SRC.f1hl, SRC.wiki('de.wikipedia.org/wiki/Hungaroring'), SRC.otd('eudem25m'), SRC.otd('srtm30m')] },
    { aspect: 'banking', severity: 'cosmetic', game: 'curvature-derived, up to 5.8 deg (T1, T12)', real: 'no published bank angles; not measured (no open lidar / DTM finer than 25 m for Hungary)', proposedFix: 'none until measured', sources: [] },
    { aspect: 'bridge', severity: 'minor', game: 'no structures over the track', real: 'footbridge over the main straight (OSM way 493519980, layer 1) at the game line (~240 m after the real line); service-road bridge (OSM way 54843543, bridge=yes, layer 1) over the track at s ~694 between T1A and T2',
      proposedFix: 'scenery: both bridges (proposedCorrections.bridgesOver)', sources: [SRC.osm(284557, L.osmSource)] },
  ];
  write(id, { id, name: game.name, audited: AUD, auditor: SRC.scripts, verdict: 'major issues', findings,
    measurements: measurements(id, b, { grid2025: { url: T25.grid.url, startUtc: T25.grid.startUtc, poleSlotFromGameLineM: T25.grid.poleSlotFromGameLineM, firstSlots: T25.grid.slots.slice(0, 4), zRangeM: r1(Math.max(...T25.z) - Math.min(...T25.z)) },
      fiaMapScaling: 'FIA 2026 map page 2: speed trap T is "310m before T1"; T -> T1 = 205 px, control line -> T = 194 px => control line ~600 m before T1 (approximate, read off the PDF render cache/fia/hu-2026-p2.png)' }),
    proposedCorrections: {
      START_AT: { 'hu-1986': startLL, note: `on the game centreline ${-startS} m before the current line (grid pole at -244.5 m in 2025, -243.5 m in 2026)` },
      elevation: { source: 'F1 live-timing car heights (2026 Hungarian GP qualifying, median of all cars per 10 m)', optional: true, stats: PS,
        profile10m: { columns: ['s (game arc length from the CURRENT line, m)', 'lat', 'lon (OSM-snapped centreline)', 'h (m above the lowest point)'], rows: P.rows } },
      pitSide: -1, pitLimitKmh: 80, bankOverrides: [],
      bridgesOver: [{ kind: 'footbridge over the main straight', osmWay: 493519980, gameS: 0, at: llAt(game, 0) }, { kind: 'service-road bridge', osmWay: 54843543, gameS: 694, at: llAt(game, 694) }],
      layoutNote: 'layout current (4.381 km); OSM centreline less accurate than the dataset here (up to 7.4 m)' },
    reproduce: ['node devtests/track-audit/eu-south-central/game.js', 'node devtests/track-audit/eu-south-central/layout.mjs', 'node devtests/track-audit/eu-south-central/lt.mjs', 'node devtests/track-audit/eu-south-central/grid-check.mjs', 'node devtests/track-audit/eu-south-central/elev.mjs', 'node devtests/track-audit/eu-south-central/hu-centre.mjs hu-1986', 'node devtests/track-audit/eu-south-central/feat.mjs hu-1986 lt 2400-3700:T8-T13', 'node devtests/track-audit/eu-south-central/compose.mjs'] });
}
