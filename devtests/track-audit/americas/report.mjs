// node devtests/track-audit/americas/report.mjs [ids...]
// Writes devtests/track-audit/<id>.json for the americas circuits from the measurements in out/audit-<id>.json (audit.mjs)
// plus the reference facts below (each with its source) and the predicted in-game result of the proposed elevation source
// (sim.mjs = tools/build-tracks.mjs filters + js/track.js smoothing, checked against the built game: rms 3-8 cm).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';
import { predictGame } from './sim.mjs';
import { grades, r1, r2 } from './geo.mjs';

const OUTDIR = resolve(HERE, '..');
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['us-2012', 'us-2023', 'us-2022', 'us-1909', 'us-1956', 'ca-1978'];
const W = (t) => 'https://en.wikipedia.org/wiki/' + t;
const OSMW = (id) => 'https://www.openstreetmap.org/way/' + id;
const OSMN = (id) => 'https://www.openstreetmap.org/node/' + id;
const SRC = {
  usgs: 'USGS 3DEP bare-earth DEM, 1 m lidar (public domain): https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer (getSamples), acquisition dates from https://epqs.nationalmap.gov/v1/json?...&includeDate=true',
  hrdem: 'NRCan HRDEM mosaic DTM (lidar; Open Government Licence - Canada): WCS https://datacube.services.geo.ca/ows/elevation, coverage dtm, EPSG:4326, 1e-5 deg grid',
  osm: 'OpenStreetMap (ODbL) via Overpass API (maps.mail.ru mirror), cached in devtests/track-audit/cache/overpass/',
  pit80: 'FIA 2025 Formula 1 Sporting Regulations, Issue 5 (2025-04-30), art. 34.7: "A speed limit of 80km/h will be imposed in the pit lane during the whole Competition. However, this limit may be amended by the Race Director" (cache/fia/fia_2025_formula_1_sporting_regulations_-_issue_5_-_2025-04-30.txt)',
  game: 'game data: tracks-data.js + js/track.js built in node (devtests/track-audit/americas/game.js -> out/game-<id>.json)',
};

function load(id) { return JSON.parse(readFileSync(resolve(HERE, 'out', 'audit-' + id + '.json'), 'utf8')); }
const sAt = (A, s) => { const rows = A.profile.rows, L = A.builtLengthM; const k = Math.round((((s % L) + L) % L) / A.profile.step) % rows.length; return [rows[k][1], rows[k][2]]; };
function predicted(A, kind, over) {
  const rows = A.profile.rows, ds = A.profile.step, real = rows.map((r) => r[3]);
  const p = predictGame(real, ds, kind, over), g50 = grades(p, ds, 50), g100 = grades(p, ds, 100);
  let imx = 0, imn = 0; g50.forEach((v, k) => { if (v > g50[imx]) imx = k; if (v < g50[imn]) imn = k; });
  const gr = grades(real, ds, 50);
  return { kind, override: over || null, rangeM: r1(Math.max(...p) - Math.min(...p)), maxClimb50Pct: r1(g50[imx] * 100), atS: rows[imx][0],
    maxDescent50Pct: r1(g50[imn] * 100), atS2: rows[imn][0], maxClimb100Pct: r1(Math.max(...g100) * 100), maxDescent100Pct: r1(Math.min(...g100) * 100),
    rmsGradeDiffVsLidarPct: r2(Math.sqrt(g50.reduce((a, v, k) => a + ((v - gr[k]) * 100) ** 2, 0) / g50.length)) };
}
// corners whose lidar cross-slope (inside lower) is at least minDeg and exceeds the game's by gap: bankOverrides entries
function bankProposals(A, minDeg, gap, names = {}) {
  return A.banking.corners.filter((c) => c.realInsideLowerDeg.median >= minDeg && c.realInsideLowerDeg.median - c.gameInsideLowerDeg.median >= gap)
    .map((c) => ({ name: names[c.s0] || (c.way || '') + ` (s ${c.s0}-${c.s1})`, deg: Math.round(c.realInsideLowerDeg.median * 2) / 2,
      from: sAt(A, c.s0), to: sAt(A, c.s1), source: 'measured: USGS 3DEP 1 m lidar cross-slope at +-4 m (median over the corner); no published figure',
      gameNowDeg: c.gameInsideLowerDeg.median }));
}
function derivedBankSummary(A) {
  const c = A.banking.corners;
  const flatReal = c.filter((x) => Math.abs(x.realInsideLowerDeg.median) <= 2.2);
  const over = flatReal.filter((x) => x.gameInsideLowerDeg.median - x.realInsideLowerDeg.median >= 2);
  return { cornersMeasured: c.length, realWithin2deg: flatReal.length, gameOverBanksBy2degOrMore: over.length,
    worst: over.sort((a, b) => (b.gameInsideLowerDeg.median - b.realInsideLowerDeg.median) - (a.gameInsideLowerDeg.median - a.realInsideLowerDeg.median)).slice(0, 6)
      .map((x) => `s ${x.s0}-${x.s1} ${x.dir} R${x.minRadius} m (${x.way}): real ${x.realInsideLowerDeg.median} deg, game ${x.gameInsideLowerDeg.median} (max ${x.gameInsideLowerDeg.max})`) };
}
const pitGame = (A) => { const g = A.pit.game, L = A.builtLengthM, w = (s) => r1(s > L / 2 ? s - L : s);
  return { side: g.sideText, limitKmh: g.limitKmh, laneFromS: w(g.fromS), laneToS: w(g.toS), entryLineS: w(g.entryS), exitLineS: w(g.exitS), lengthM: Math.round(g.length) }; };

// ------------------------------------------------------------------------------------------------ per circuit
const C = {};

C['us-2012'] = (A) => {
  const E = A.elevation, B = A.banking, t1 = B.corners.find((c) => c.way === 'Turn 1');
  const off = B.corners.filter((c) => c.realInsideLowerDeg.median < 0);
  return {
    layout: { gameLayout: 'Grand Prix Circuit 2012-present (20 turns), the layout of every 2012-2026 United States GP', officialLengthKm: 5.513,
      sources: [W('Circuit_of_the_Americas') + ' (infobox: Grand Prix Circuit 2012-present, 5.513 km, 20 turns)', SRC.osm] },
    directionReal: { value: 'anticlockwise', source: W('Circuit_of_the_Americas') + ': "one of only a handful on the Formula One 2012 calendar to be run counter-clockwise"; OSM oneway raceway ways agree over ' + A.layout.onewayCheck.sameDirectionM + ' m, 0 m against' },
    published: [{ what: 'elevation change', value: '133 ft (41 m)', source: W('Circuit_of_the_Americas') + ' (Speed TV 2010 announcement)' },
      { what: 'climb to Turn 1', value: 'gradient of over 11%', source: W('Circuit_of_the_Americas') }],
    famous: [{ feature: 'Turn 1 climb (Big Red)', real: `lidar ${E.grades.w50.real.maxClimb.pct} % over 50 m / ${E.grades.w100.real.maxClimb.pct} % over 100 m at s ${E.grades.w50.real.maxClimb.s} m`, game: `${E.grades.w50.game.maxClimb.pct} % / ${E.grades.w100.game.maxClimb.pct} %`, verdict: 'ok (published: over 11 %)' },
      { feature: 'drop from Turn 1 into the esses', real: `${E.grades.w50.real.maxDescent.pct} % (50 m) / ${E.grades.w100.real.maxDescent.pct} % (100 m) at s ${E.grades.w50.real.maxDescent.s}`, game: `${E.grades.w50.game.maxDescent.pct} % / ${E.grades.w100.game.maxDescent.pct} %`, verdict: 'ok' },
      { feature: 'total elevation change', real: `lidar ${E.real.range} m along the OSM centreline (${E.real.min} m ASL at s ${E.real.sMin}, ${E.real.max} m at Turn 1, s ${E.real.sMax})`, game: `${E.game.range} m`, verdict: 'ok against the lidar; the published 41 m is not reachable on the track surface (already noted in tools/build-tracks.mjs)' }],
    findings: [
      { aspect: 'banking', severity: 'minor', game: `curvature-derived banking 1.6-5.4 deg (median per corner, inside lower) on all 20 corners; Turn 1 ${t1.gameInsideLowerDeg.median} deg`,
        real: `lidar cross-slope (+-4 m): Turn 1 is genuinely cambered ${t1.realInsideLowerDeg.median} deg (max ${t1.realInsideLowerDeg.max}); every other corner shows only the ~1.4 deg drainage cross-fall (straights median ${B.straightsAbsTiltMedianDeg} deg), and ${off.map((c) => c.way).join(', ')} fall away from the apex (${off.map((c) => c.realInsideLowerDeg.median).join(' / ')} deg, off-camber) where the game banks them ${off.map((c) => c.gameInsideLowerDeg.median).join(' / ')} deg`,
        proposedFix: 'keep Turn 1 (derived value is close); optionally replace the derived banking by the measured cross-slope profile (profile.rows column realTiltDeg, every 10 m) or scale the derived banking down for this circuit (needs a per-track factor in js/track.js)', sources: [SRC.usgs, SRC.game] },
      { aspect: 'bridge', severity: 'minor', game: 'no structure over the track (scenery-data.js has no man_made=bridge polygon for us-2012)',
        real: `three pedestrian bridges span the track: OSM ways 191582144 (s ${r1(A.crossings.find((c) => c.way === 191582144).s)} m, after Turn 2), 1285657865 (s ${r1(A.crossings.find((c) => c.way === 1285657865).s)} m, Turn 10), 191582102 (s ${r1(A.crossings.find((c) => c.way === 191582102).s)} m, Turn 17); two service / foot tunnels pass under the start straight (s 124-132 m) and one under s 3210 m (invisible from the car)`,
        proposedFix: 'add footbridge decks at those three crossings (scenery: a deck like addBridge() at >= 6.5 m clearance); OSM ways are linear (highway=footway, bridge=yes, layer 1), so build-scenery would need to buffer them to a ~4 m wide polygon', sources: [OSMW(191582144), OSMW(1285657865), OSMW(191582102), SRC.osm] },
      { aspect: 'pit', severity: 'minor', game: `pit lane ${JSON.stringify(pitGame(A))}`,
        real: `OSM way 514836373 "Pit Lane" (${A.pit.osm[0].lengthM} m) on the left: from s ${A.pit.osm[0].minS} m (between Turn 19 and Turn 20, on the inside) to s +${A.pit.osm[0].maxS} m (it rejoins at Turn 1); limit 80 km/h`,
        proposedFix: 'side and limit are right; the lane is ~450 m shorter than the real one (js/track.js PIT_REACH = 250 m each way). If longer lanes are wanted: pitLane {entry: [30.1353383, -97.6413928], exit: [30.1300873, -97.6370612]} (needs js/track.js support)', sources: [OSMW(514836373), SRC.pit80] },
      { aspect: 'start', severity: 'cosmetic', game: `start / finish at [${A.startFinish.gameStart.map((v) => v.toFixed(6))}]`,
        real: `OSM node 7909207460 raceway=start-finish is ${Math.abs(A.startFinish.osmNodes.find((n) => n.node === 7909207460).gameS)} m before it`,
        proposedFix: "START_AT['us-2012'] = [30.131893, -97.6398291] (optional, 23 m)", sources: [OSMN(7909207460)] },
    ],
    proposal: { START_AT: [30.131893, -97.6398291], elevation: 'keep usgs3dep (lidar 2017; game rms ' + E.rmsDiffM + ' m vs lidar along OSM, grades within 1 pp)',
      bridgesOverTrack: [191582144, 1285657865, 191582102].map((w) => { const c = A.crossings.find((x) => x.way === w); return { osmWay: w, kind: 'footbridge', s: c.s, at: c.at }; }),
      pitLane: { side: 'left', limitKmh: 80, realEntry: [30.1353383, -97.6413928], realExit: [30.1300873, -97.6370612] } },
    verdictNote: 'layout, length, direction, elevation (lidar) and the Turn 1 climb all match; only cosmetic / minor items',
  };
};

C['us-2023'] = (A) => {
  const E = A.elevation, sf = A.startFinish.osmNodes, st = sf.find((n) => n.tags.raceway === 'start'), fi = sf.find((n) => n.tags.raceway === 'finish');
  const cr = A.crossings, mono = cr.filter((c) => c.tags.railway === 'monorail'), foot = cr.filter((c) => c.tags.highway === 'footway' && c.kind === 'crosses');
  const drawn = A.sceneryBridges.filter((b) => b.overLine);
  return {
    layout: { gameLayout: 'Las Vegas Strip Circuit 2023-present (17 corners), the layout of every Las Vegas GP 2023-2025', officialLengthKm: 6.201,
      sources: [W('Las_Vegas_Strip_Circuit') + ' (6.201 km, counterclockwise, 17 corners)', 'FIA 2025 Las Vegas GP Event Notes - Circuit Map v2: "Circuit Centreline Length = 6.201km" (https://www.fia.com/system/files/decision-document/2025_las_vegas_grand_prix_-_event_notes_-_circuit_map_v2_pit_lane_drawing_emergency_map_exits_quarantine_zone_and_red_zones.pdf)', SRC.osm],
      note: `street circuit: ${Math.round(A.layout.fractionMatchedToStreets * 100)} % of the line was compared with OSM road ways (dual carriageways: the deviation includes half the carriageway separation); max ${A.layout.deviation.max} m at s ${A.layout.offStretches.map((o) => o.s0).join(', ')} (Turn 14, the left from the Strip onto Harmon Avenue)` },
    directionReal: { value: 'anticlockwise', source: W('Las_Vegas_Strip_Circuit') + ': "street circuit runs counterclockwise"; OSM oneway raceway ways agree' },
    published: [],
    famous: [{ feature: 'Las Vegas Boulevard (the Strip) straight', real: `lidar: gentle fall to the south, total range ${E.real.range} m over the lap, steepest 50 m grade ${E.grades.w50.real.maxDescent.pct} % (s ${E.grades.w50.real.maxDescent.s}, the approach to the pit straight)`, game: `range ${E.game.range} m, ${E.grades.w50.game.maxDescent.pct} %`, verdict: 'ok' }],
    findings: [
      { aspect: 'start', severity: 'minor', game: `start / finish (one line) at [${A.startFinish.gameStart.map((v) => v.toFixed(6))}]`,
        real: `OSM node 13016217986 raceway=start is ${Math.abs(st.gameS)} m before the game's line and node 13016217985 raceway=finish ${Math.abs(fi.gameS)} m before it; the FIA circuit map marks a separate "Start Line" and "Control Line"`,
        proposedFix: "START_AT['us-2023'] = [36.1092838, -115.1618816] (the start line; the finish / control line is a further 92 m back at [36.1086649, -115.1625601] - the game has one line)", sources: [OSMN(13016217986), OSMN(13016217985), 'FIA 2025 Las Vegas GP Event Notes - Circuit Map v2 (legend "Control Line", "Start Line")'] },
      { aspect: 'bridge', severity: 'minor', game: `one deck over the track: the scenery's man_made=bridge polygon at s ${drawn.map((b) => b.s).join(', ')} m (Las Vegas Boulevard Overpass footbridge)`,
        real: `the lap passes under the Las Vegas Monorail viaduct twice (OSM ways 43875943 / 395310512, layer 2: s ${mono.map((c) => c.s).sort((a, b) => a - b).join(', ')} m) and under ${foot.length} pedestrian bridges (s ${foot.map((c) => c.s).sort((a, b) => a - b).join(', ')} m; only the one at s ~4268 is drawn), most of them over the Strip`,
        proposedFix: 'add the monorail viaduct crossings (s ~2110-2381 and ~5552-5556) and the footbridge decks; they are linear OSM ways (railway=monorail bridge=viaduct, highway=footway bridge=yes) that build-scenery.mjs does not turn into decks today', sources: [OSMW(43875943), OSMW(395310512), ...foot.map((c) => OSMW(c.way)), SRC.osm] },
      { aspect: 'banking', severity: 'minor', game: `curvature-derived banking at every slow corner: ${derivedBankSummary(A).worst.slice(0, 4).join('; ')}`,
        real: `lidar: city streets, flat (|cross-slope| <= 2.2 deg at ${derivedBankSummary(A).realWithin2deg} of ${derivedBankSummary(A).cornersMeasured} corners, straights ${A.banking.straightsAbsTiltMedianDeg} deg); no banking is published`,
        proposedFix: 'no derived banking on this street circuit (per-track factor 0 in js/track.js, or the measured cross-slope profile)', sources: [SRC.usgs, SRC.game] },
      { aspect: 'pit', severity: 'cosmetic', game: `pit lane ${JSON.stringify(pitGame(A))}`,
        real: `OSM way 1223479152 raceway=pitlane (${A.pit.osm[0].lengthM} m) on the left from s ${A.pit.osm[0].minS} to +${A.pit.osm[0].maxS} m; 80 km/h`,
        proposedFix: 'none needed (side and limit right; real exit ~100 m further on)', sources: [OSMW(1223479152), SRC.pit80] },
      { aspect: 'elevation', severity: 'cosmetic', game: `${E.game.range} m range, rms ${E.rmsDiffM} m vs lidar`,
        real: `lidar ${E.real.range} m. Note: the 3DEP lidar here was flown in 2022 (EPQS AcquisitionDate), before the paddock / pit straight on the former car park was built (2023)`,
        proposedFix: 'none', sources: [SRC.usgs] },
    ],
    proposal: { START_AT: [36.1092838, -115.1618816], finishLine: [36.1086649, -115.1625601], derivedBankScale: 0,
      bridgesOverTrack: [...mono, ...foot].map((c) => ({ osmWay: c.way, kind: c.tags.railway === 'monorail' ? 'monorail viaduct' : 'footbridge', s: c.s, at: c.at })) },
    verdictNote: 'layout, length, direction and elevation match; start line 92 m off; overhead structures and flat street corners are the visible differences',
  };
};

C['us-2022'] = (A) => {
  const E = A.elevation, pr = predicted(A, 'dtm'), pr2 = predicted(A, 'dtm', { medHalf: 1, sigma: 10 });
  const fly = A.crossings.filter((c) => c.tags.highway === 'motorway_link'), foot = A.crossings.filter((c) => c.tags.highway === 'footway');
  return {
    layout: { gameLayout: 'Grand Prix Circuit 2022-present (19 corners), the layout of every Miami GP 2022-2026', officialLengthKm: 5.412,
      sources: [W('Miami_International_Autodrome') + ' (Grand Prix Circuit 2022-present: 3.363 mi / 5.412 km, 19 corners)', SRC.osm],
      note: `OSM ways 1233165737 (670 m) and part of 1485454063 belong to the 2024 club layouts (Marina / MIA loops), not the GP circuit` },
    directionReal: { value: 'anticlockwise', source: `OSM oneway raceway ways of the circuit agree over ${A.layout.onewayCheck.sameDirectionM} m, 0 m against` },
    published: [{ what: 'Turns 13-16', value: '"The main elevation change can be found between Turns 13 and 16, with the track heading over an exit ramp and under various flyovers across uneven ground." "The Turn 14-15 chicane has an uphill approach, with a crest in the middle of the chicane and then drops down on exit."', source: 'https://www.formula1.com/en/latest/article.everything-you-need-to-know-about-the-f1-miami-grand-prix.6JTdOPphcU58I8TDLmssx.html' }],
    famous: [{ feature: 'Turn 14-15 chicane: uphill approach, crest, drop on exit', real: `lidar (flown 2024-04, after the circuit was built): +3.0 m from s 3262 to the crest at s ~3350, ${E.grades.w50.real.maxClimb.pct} % over 50 m (s ${E.grades.w50.real.maxClimb.s}), then ${E.grades.w50.real.maxDescent.pct} % down (s ${E.grades.w50.real.maxDescent.s})`, game: `flat: ${E.grades.w50.game.maxClimb.pct} % / ${E.grades.w50.game.maxDescent.pct} % at most anywhere; the game's highest point is at s ${E.game.sMax} (a GLO-90 artefact in sector 1)`, verdict: 'missing' }],
    findings: [
      { aspect: 'elevation', severity: 'major', game: `GLO-90 surface model, FLAT_TRACKS (median 325 m, Gaussian 250 m, scaled to <= 4 m): range ${E.game.range} m, max 50 m grades +${E.grades.w50.game.maxClimb.pct} / ${E.grades.w50.game.maxDescent.pct} %; shape uncorrelated with the ground (r = ${E.correlation}, rms ${E.rmsDiffM} m)`,
        real: `USGS 3DEP lidar (2024) along the OSM centreline: range ${E.real.range} m; flat (1-2 m ASL) except the Turn 13-16 rise: ${E.grades.w50.real.maxClimb.pct} % up over 50 m into the Turn 14-15 chicane, crest ~4.4 m ASL, ${E.grades.w50.real.maxDescent.pct} % down after it - the published "uphill approach, crest in the middle of the chicane, drops down on exit"`,
        proposedFix: `ELEV_SOURCE['us-2022'] = 'usgs3dep' and remove 'us-2022' from FLAT_TRACKS. Predicted in game (build DTM filters + js/track.js smoothing on this lidar profile): range ${pr.rangeM} m, chicane climb ${pr.maxClimb50Pct} % / drop ${pr.maxDescent50Pct} % over 50 m (with DTM median half 1 / sigma 10 m for this track: ${pr2.maxClimb50Pct} / ${pr2.maxDescent50Pct} %)`,
        sources: [SRC.usgs, 'https://www.formula1.com/en/latest/article.everything-you-need-to-know-about-the-f1-miami-grand-prix.6JTdOPphcU58I8TDLmssx.html', 'tools/build-tracks.mjs FLAT_TRACKS'] },
      { aspect: 'bridge', severity: 'minor', game: 'no structure over the track (no bridge in scenery-data.js for us-2022)',
        real: `the Turn 13-16 section passes under three Florida's Turnpike ramp bridges (OSM motorway_link, layer 1-2: s ${fly.map((c) => c.s).join(', ')} m) and the lap under two footbridges (s ${foot.map((c) => c.s).join(', ')} m)`,
        proposedFix: 'add the three flyover decks over Turns 13-16 (and the two footbridges): linear OSM bridge ways buffered to their width (ramps: 1-2 lanes)', sources: [...fly.map((c) => OSMW(c.way)), ...foot.map((c) => OSMW(c.way)), 'formula1.com (as above): "under various flyovers"'] },
      { aspect: 'banking', severity: 'minor', game: `curvature-derived banking: ${derivedBankSummary(A).worst.slice(0, 3).join('; ')}`,
        real: `lidar: ${derivedBankSummary(A).realWithin2deg} of ${derivedBankSummary(A).cornersMeasured} corners within +-2.2 deg (straights ${A.banking.straightsAbsTiltMedianDeg} deg); larger cross-slopes only on the Turn 14-15 ramp`,
        proposedFix: 'scale the derived banking down for this circuit, or use the measured cross-slope profile', sources: [SRC.usgs, SRC.game] },
      { aspect: 'pit', severity: 'minor', game: `pit lane ${JSON.stringify(pitGame(A))}`,
        real: `OSM way 1017340352 "Pit Lane" (${A.pit.osm[0].lengthM} m) on the right from s ${A.pit.osm[0].minS} to +${A.pit.osm[0].maxS} m; 80 km/h`,
        proposedFix: 'side and limit right; real lane ~300 m longer (pitLane {entry: [25.9597645, -80.2415191], exit: [25.9572399, -80.2359148]} if js/track.js ever supports it)', sources: [OSMW(1017340352), SRC.pit80] },
      { aspect: 'start', severity: 'cosmetic', game: `start / finish at [${A.startFinish.gameStart.map((v) => v.toFixed(6))}]`, real: 'no start / finish node in OSM; not verified (the FIA circuit map PDF has no machine-readable coordinates)', proposedFix: 'none', sources: [SRC.osm] },
    ],
    proposal: { ELEV_SOURCE: 'usgs3dep', FLAT_TRACKS: 'remove us-2022', predictedWithLidar: pr, predictedWithLighterSmoothing: pr2,
      bridgesOverTrack: [...fly, ...foot].map((c) => ({ osmWay: c.way, kind: c.tags.highway === 'footway' ? 'footbridge' : "Florida's Turnpike ramp", s: c.s, at: c.at })), derivedBankScale: 0.3 },
    verdictNote: 'layout / length / direction right; the famous Turn 14-15 climb under the Turnpike flyovers is flat and bare in the game (GLO-90 flattened to 4 m)',
  };
};

C['us-1909'] = (A) => {
  const E = A.elevation, B = A.banking, ov = B.corners.filter((c) => /Turn 1/.test(c.way || ''));
  const ovMed = ov.map((c) => c.realInsideLowerDeg.median), tun = A.crossings.filter((c) => c.tags.tunnel), hb = A.crossings.find((c) => c.way === 152842141);
  return {
    layout: { gameLayout: 'Grand Prix Road Course 2000-2007 (13 turns, clockwise), the F1 United States GP layout of 2000-2007; not raced by F1 in 2010-2026', officialLengthKm: 4.192,
      sources: [W('Indianapolis_Motor_Speedway') + ' (infobox layout7: Grand Prix Road Course 2000-2007, 4.192 km, 13 turns)', SRC.osm],
      note: `the line stays within ${A.layout.deviation.max} m of OSM raceway ways everywhere (incl. OSM way 588780310 "IMS Grand Prix Circuit"), i.e. the 2000-2007 course is still paved; the OSM ways not followed are the oval's other turns, the 2008+ / 2014+ road-course variants, pit roads` },
    directionReal: { value: 'clockwise', source: W('Indianapolis_Motor_Speedway') + ': "The 2000 United States Grand Prix was the first event at IMS to be held clockwise"; OSM: the road-course ways agree (' + A.layout.onewayCheck.sameDirectionM + ' m), the oval ways are digitised anti-clockwise (' + A.layout.onewayCheck.oppositeM + ' m against), as expected' },
    published: [{ what: 'oval turn banking', value: "9 deg 12' (9.2 deg)", source: W('Indianapolis_Motor_Speedway') + ' (infobox banking "Turns: 9.2 deg"); OSM way 51308226 banking=9 deg 12\'' }],
    famous: [{ feature: 'banked oval Turn 1 (F1 Turn 13)', real: `lidar cross-slope ${Math.min(...ovMed)}-${Math.max(...ovMed)} deg (medians of its sections; ramps at the ends), published 9.2 deg`, game: 'bankOverrides 9.2 deg', verdict: 'ok' },
      { feature: 'flat infield', real: `lidar range ${E.real.range} m, 50 m grades +${E.grades.w50.real.maxClimb.pct} / ${E.grades.w50.real.maxDescent.pct} %`, game: `${E.game.range} m, +${E.grades.w50.game.maxClimb.pct} / ${E.grades.w50.game.maxDescent.pct} %, rms ${E.rmsDiffM} m`, verdict: 'ok' }],
    findings: [
      { aspect: 'banking', severity: 'minor', game: `curvature-derived banking on the infield corners: ${derivedBankSummary(A).worst.slice(0, 4).join('; ')}`,
        real: `lidar: infield corners ${derivedBankSummary(A).realWithin2deg} of ${derivedBankSummary(A).cornersMeasured - ov.length} within +-2.2 deg (straights ${B.straightsAbsTiltMedianDeg} deg). The oval turn override is confirmed by the same method (${Math.min(...ovMed)}-${Math.max(...ovMed)} deg vs 9.2 published), which validates the measurement`,
        proposedFix: 'keep the 9.2 deg override; scale the derived banking of the infield down (or use the measured cross-slope profile)', sources: [SRC.usgs, SRC.game] },
      { aspect: 'bridge', severity: 'minor', game: 'no structure over the track',
        real: `the Hulman Boulevard Pedestrian Bridge (OSM way 152842141, layer 1) spans the track at s ${hb.s} m (Hulman straight); ${tun.length} tunnels / culverts pass under it (Tunnel 6 at s ~40 m, Tunnel 7 at s ~450-460 m, Tunnel 3 at s 3166, ...), invisible from the car`,
        proposedFix: 'add the footbridge deck at s ' + hb.s + ' m', sources: [OSMW(152842141), SRC.osm] },
      { aspect: 'pit', severity: 'minor', game: `pit lane ${JSON.stringify(pitGame(A))}`,
        real: 'OSM: "IMS Road Course - Pit Entry" (way 317832622) leaves on the inside before oval Turn 1 at s -761 m, "IMS Formula One Pit Lane" (way 588780329) and "IMS Pit Lane" (ways 588780264, 1176980820) run along the main straight on the right (inside) to s +421 m, "IMS Road Course - Pit Exit" (588780283) rejoins at s ~+658 m (road-course Turn 1). Pit limit for 2000-2007 not found',
        proposedFix: 'side right; length is the game-wide 500 m simplification', sources: [OSMW(317832622), OSMW(588780329), OSMW(588780283)] },
      { aspect: 'start', severity: 'cosmetic', game: 'start at the yard of bricks', real: `OSM way 1213055867 "IMS Start-Finish Line" crosses the game line ${Math.abs(A.startFinish.osmNodes[0].gameS)} m from s = 0`, proposedFix: 'none', sources: [OSMW(1213055867)] },
    ],
    proposal: { elevation: 'keep usgs3dep', bankOverrides: 'keep T13 (oval turn 1) 9.2 deg', derivedBankScale: 0.3,
      bridgesOverTrack: [{ osmWay: 152842141, kind: 'footbridge (Hulman Boulevard Pedestrian Bridge)', s: hb.s, at: hb.at }] },
    verdictNote: 'the 2000-2007 F1 road course, length, direction, elevation and the 9.2 deg oval banking all check out',
  };
};

C['us-1956'] = (A) => {
  const E = A.elevation, B = A.banking;
  const names = {};
  for (const c of B.corners) names[c.s0] = (c.way === 'Watkins Glen International' ? 'Turn 11 (final corner)' : (c.way || 'corner')) + ` (s ${c.s0}-${c.s1} m)`;
  const props = bankProposals(A, 3.5, 1.5, names);
  const fb = A.crossings.find((c) => c.tags.highway === 'footway'), tun = A.crossings.filter((c) => c.tags.tunnel || c.tags.layer === '-1');
  return {
    layout: { gameLayout: 'Grand Prix Circuit with the Boot, no Inner Loop (5.435 km): the F1 layout of 1971-1974 (1975-1980 F1 races added the Esses chicane, removed in 1985); F1 has not raced here since 1980 (not a 2010-2026 venue)', officialLengthKm: 5.435,
      sources: [W('Watkins_Glen_International') + ' (infobox layout4 "Grand Prix Circuit (1971-1974, 1986-1991)" 5.435 km; layout5 "with Esses Chicane (1975-1985)"; Inner Loop added 1992)', SRC.osm],
      note: `the line follows OSM within ${A.layout.deviation.max} m incl. the disused straight bypassed by the 1992 "Inner Loop" (OSM way 428026652, not followed: ${A.layout.osmWaysNotFollowed.find((w) => w.way === 428026652).offM} m) - consistent with the pre-1992 length; no Esses chicane in the game` },
    directionReal: { value: 'clockwise', source: `OSM oneway raceway ways agree over ${A.layout.onewayCheck.sameDirectionM} m, 0 m against` },
    published: [{ what: 'the Boot', value: '"curling left-hand downhill through the woods ... two uphill right-hand turns, over an exciting blind crest"', source: W('Watkins_Glen_International') }],
    famous: [{ feature: 'climb through the Esses', real: `lidar ${E.grades.w50.real.maxClimb.pct} % (50 m) / ${E.grades.w100.real.maxClimb.pct} % (100 m) at s ${E.grades.w50.real.maxClimb.s}`, game: `${E.grades.w50.game.maxClimb.pct} / ${E.grades.w100.game.maxClimb.pct} %`, verdict: 'ok' },
      { feature: 'descent after the Outer Loop / into the Boot', real: `${E.grades.w50.real.maxDescent.pct} % (50 m) at s ${E.grades.w50.real.maxDescent.s}`, game: `${E.grades.w50.game.maxDescent.pct} %`, verdict: 'ok (1.3 pp flatter)' },
      { feature: 'total elevation change', real: `lidar ${E.real.range} m (${E.real.min}-${E.real.max} m ASL)`, game: `${E.game.range} m (rms ${E.rmsDiffM} m)`, verdict: 'ok; no published figure found' }],
    findings: [
      { aspect: 'banking', severity: 'minor', game: `curvature-derived banking only: ${props.map((p) => `${p.name.split(' (')[0]} ${p.gameNowDeg} deg`).join(', ')}`,
        real: `lidar cross-slope shows real superelevation in both directions (inside lower in left- and right-handers): ${props.map((p) => `${p.name.split(' (')[0]} ${p.deg}`).join(', ')} deg; straights ${B.straightsAbsTiltMedianDeg} deg. No published angles`,
        proposedFix: 'BANKED[\'us-1956\'] = proposal.bankOverrides (measured angles; js/track.js eases 35 m in / out)', sources: [SRC.usgs] },
      { aspect: 'bridge', severity: 'minor', game: 'no structure over the track', real: `a footbridge (OSM way ${fb.way}, layer 1) spans the pit straight at s ${fb.s} m (${r1(A.builtLengthM - fb.s)} m before the game's line); service tunnels pass under the track at s ${tun.map((c) => c.s).join(', ')} m`,
        proposedFix: 'add the footbridge deck', sources: [OSMW(fb.way), SRC.osm] },
      { aspect: 'elevation', severity: 'cosmetic', game: `smooth over the service tunnels (s ~1098 and ~4512 m)`, real: 'the bare-earth lidar dips 3.3 m (s 1091-1101) and up to 5.7 m (s 4512, dataset line) where tunnels pass under the track: the DEM removed the track deck as a bridge. The build\'s 50 m median already rejects them (game rms vs lidar 0.28 m)',
        proposedFix: "optional COVERED['us-1956'] = [{name: 'tunnel s1098', from: [42.340698, -76.922312], to: [42.340527, -76.922029], pad: 5}, {name: 'tunnel s4512', from: [42.33513, -76.924418], to: [42.335306, -76.924471], pad: 5}] (robustness only)", sources: [SRC.usgs, OSMW(50289308), OSMW(50263474)] },
      { aspect: 'pit', severity: 'minor', game: `pit lane ${JSON.stringify(pitGame(A))}`, real: `OSM "Pit Lane" ways 50289311 + 20164027 on the right from s ${Math.min(...A.pit.osm.map((p) => p.minS))} to +${Math.max(...A.pit.osm.map((p) => p.maxS))} m (rejoins after the 90). No pit speed limit existed in F1 before 1994`,
        proposedFix: 'side right; 80 km/h is the game-wide default', sources: [OSMW(50289311), OSMW(20164027), W('Pit_stop') + ' (pit lane speed limits introduced in F1 after the 1994 San Marino GP)'] },
      { aspect: 'start', severity: 'cosmetic', game: `start / finish at [${A.startFinish.gameStart.map((v) => v.toFixed(6))}]`, real: 'no start / finish node in OSM; the line was moved 380 ft (116 m) towards the 90 in 2006, the 1971-1980 position is not mapped', proposedFix: 'none', sources: [W('Watkins_Glen_International')] },
    ],
    proposal: { elevation: 'keep usgs3dep', bankOverrides: props.map(({ gameNowDeg, ...p }) => p),
      COVERED: [{ name: 'service tunnel s1098', from: [42.340698, -76.922312], to: [42.340527, -76.922029], pad: 5 }, { name: 'service tunnel s4512', from: [42.33513, -76.924418], to: [42.335306, -76.924471], pad: 5 }],
      bridgesOverTrack: [{ osmWay: fb.way, kind: 'footbridge', s: fb.s, at: fb.at }] },
    verdictNote: '1971-1974 F1 layout (historic); elevation good; corners under-banked by 2-3 deg against the lidar',
  };
};

C['ca-1978'] = (A) => {
  const E = A.elevation, B = A.banking, pr = predicted(A, 'dtm');
  const brs = A.crossings.filter((c) => c.tags.bridge || c.tags.man_made === 'bridge'), tun = A.crossings.filter((c) => c.tags.tunnel);
  const drawn = A.sceneryBridges.filter((b) => b.overLine);
  return {
    layout: { gameLayout: 'Grand Prix Circuit 2002-present (14 turns), the layout of every 2010-2026 Canadian GP', officialLengthKm: 4.361,
      sources: [W('Circuit_Gilles_Villeneuve') + ' (infobox: Grand Prix Circuit 2002-present, 4.361 km, 14 turns)', SRC.osm] },
    directionReal: { value: 'clockwise', source: `OSM oneway raceway ways agree over ${A.layout.onewayCheck.sameDirectionM} m, ${A.layout.onewayCheck.oppositeM} m against` },
    published: [{ what: 'Turn 8', value: '"The very fast Pont de la Concorde corner (Turn 8) is after the bridge underpass"', source: W('Circuit_Gilles_Villeneuve') }],
    famous: [{ feature: 'bridge underpass before Turn 8 (Pont de la Concorde corner)', real: `the track passes under the Avenue Pierre-Dupuy bridges and the "Pont des Iles" cycle bridge (OSM, layer 1) at s ${Math.min(...brs.map((c) => c.s))}-${Math.max(...brs.map((c) => c.s))} m, ~60 m before the Turn 8-9 chicane`, game: 'no deck over the track: the six man_made=bridge polygons in scenery-data.js all stand beside the line (none over it); the two nearest (OSM 1266996939 / 1266996940 outlines) end ~20 m east of the centreline', verdict: 'missing' },
      { feature: 'elevation (flat artificial island)', real: `HRDEM lidar: ${E.real.range} m range; start / pit straight ~10.6 m, a ~4.5 m rise after the Senna S (s 600-700, ${E.grades.w50.real.maxClimb.pct} % over 50 m), plateau to Turn 3, drop into Turns 3-4 (${E.grades.w50.real.maxDescent.pct} %), 13.5-14.3 m from Turn 6 to the hairpin, then the Casino straight falls back to 10.4 m`, game: `GLO-90 flattened to ${E.game.range} m with an unrelated shape (r = ${E.correlation}): its low point (s ${E.game.sMin}) is where the ground is level at ~14 m`, verdict: 'wrong shape, gentle' }],
    findings: [
      { aspect: 'bridge', severity: 'major', game: `nothing over the track at s ${Math.min(...brs.map((c) => c.s))}-${Math.max(...brs.map((c) => c.s))} m; scenery draws bridge decks beside the line only (${A.sceneryBridges.length} man_made=bridge polygons, none over it)`,
        real: `${brs.length} bridge ways cross over the track there (OSM ${brs.map((c) => c.way + (c.tags.name ? ' "' + c.tags.name + '"' : '')).join(', ')}; all bridge=yes, layer 1): the "bridge underpass" Wikipedia names before Turn 8, the Pont de la Concorde corner`,
        proposedFix: `add one deck (or the 4 parallel decks) spanning the track at s ${Math.min(...brs.map((c) => c.s))}-${Math.max(...brs.map((c) => c.s))} m, ~21 m long along the track, clearance >= 6.5 m; build-scenery.mjs would need to turn crossing linear bridge ways (highway=* bridge=yes layer>=1) into deck polygons (buffer by their width)`,
        sources: [...brs.map((c) => OSMW(c.way)), W('Circuit_Gilles_Villeneuve') + ': "The very fast Pont de la Concorde corner (Turn 8) is after the bridge underpass"', SRC.osm] },
      { aspect: 'elevation', severity: 'minor', game: `GLO-90 + FLAT_TRACKS: range ${E.game.range} m, 50 m grades <= ${E.grades.w50.game.maxClimb.pct} %, correlation with the ground ${E.correlation}, rms ${E.rmsDiffM} m (max ${E.maxAbsDiff.m} m at s ${E.maxAbsDiff.s})`,
        real: `NRCan HRDEM lidar along the OSM centreline: range ${E.real.range} m (${E.real.min}-${E.real.max} m ASL); grades flattened by > 2 pp at s ${E.grades.w50.mismatches.map((m) => `${m.s0}-${m.s1} (real ${m.realPct} %, game ${m.gamePct} %)`).join(', ')}. Cross-check: SRTM 30 m (OpenTopoData) correlates 0.52 with the lidar and shows the same higher middle of the lap`,
        proposedFix: `new elevation source 'hrdem' (WCS GetCoverage of coverage dtm, EPSG:4326 1e-5 deg tiles, bilinear; see devtests/track-audit/americas/net.mjs hrdem()) with ELEV_SOURCE['ca-1978'] = 'hrdem' and 'ca-1978' removed from FLAT_TRACKS. Predicted in game: range ${pr.rangeM} m, ${pr.maxClimb50Pct} % / ${pr.maxDescent50Pct} % over 50 m. The profile at 10 m is in profile.rows (realH) if a static override is preferred`,
        sources: [SRC.hrdem, 'OpenTopoData srtm30m (cache/opentopodata/srtm30m-americas.json)', 'tools/build-tracks.mjs FLAT_TRACKS'] },
      { aspect: 'banking', severity: 'minor', game: `curvature-derived banking: ${derivedBankSummary(A).worst.slice(0, 4).join('; ')}`,
        real: `lidar: all ${derivedBankSummary(A).cornersMeasured} corners within +-2.2 deg (park roads; straights ${B.straightsAbsTiltMedianDeg} deg)`,
        proposedFix: 'scale the derived banking down for this circuit (or use the measured cross-slope profile)', sources: [SRC.hrdem, SRC.game] },
      { aspect: 'pit', severity: 'minor', game: `pit lane ${JSON.stringify(pitGame(A))}`,
        real: `OSM way 413000959 "Circuit Gilles Villeneuve pit lane" (${A.pit.osm[0].lengthM} m) on the left from s ${A.pit.osm[0].minS} m (at the final chicane) to +${A.pit.osm[0].maxS} m (it rejoins after Turn 2, the 2002 pit exit); 80 km/h`,
        proposedFix: 'side and limit right; real exit is ~340 m further on, after the Senna S (pitLane {entry: [45.5040959, -73.5234683], exit: [45.4970649, -73.5224658]} if js/track.js ever supports it)', sources: [OSMW(413000959), W('Circuit_Gilles_Villeneuve') + ' (pit exit changed in 2002)', SRC.pit80] },
      { aspect: 'start', severity: 'cosmetic', game: `start / finish at [${A.startFinish.gameStart.map((v) => v.toFixed(6))}]`, real: 'no start / finish node or line in OSM; not verified', proposedFix: 'none', sources: [SRC.osm] },
    ],
    proposal: { ELEV_SOURCE: 'hrdem (new source: NRCan HRDEM DTM via WCS)', FLAT_TRACKS: 'remove ca-1978', predictedWithHrdem: pr,
      bridgesOverTrack: brs.map((c) => ({ osmWay: c.way, name: c.tags.name || null, kind: c.tags.highway || c.tags.railway || c.tags.man_made, s: c.s, at: c.at })),
      underpassDeck: { sFrom: Math.min(...brs.map((c) => c.s)) - 2, sTo: Math.max(...brs.map((c) => c.s)) + 2, clearanceM: 6.5 }, derivedBankScale: 0.3 },
    verdictNote: 'layout, length, direction and pit side right; the bridge underpass before Turn 8 is missing; elevation is a flattened GLO-90 guess (gentle in reality too)',
  };
};

// ------------------------------------------------------------------------------------------------ assemble
for (const id of IDS) {
  if (!existsSync(resolve(HERE, 'out', 'audit-' + id + '.json'))) { console.log(id, 'no audit yet'); continue; }
  const A = load(id), X = C[id](A), E = A.elevation;
  const findings = X.findings;
  const sev = findings.some((f) => f.severity === 'major') ? 'major issues' : findings.some((f) => f.severity === 'minor') ? 'minor issues' : 'ok';
  const lenDiff = r2((A.builtLengthM / 1000 / X.layout.officialLengthKm - 1) * 100);
  const out = {
    id, name: A.name, audited: '2026-10-01', auditor: 'devtests/track-audit/americas (audit.mjs + report.mjs)', verdict: sev, summary: X.verdictNote,
    layout: { ...X.layout, gameBuiltLengthM: A.builtLengthM, lengthDiffPct: lenDiff, osmCenterlineDeviationM: A.layout.deviation, offStretchesOver12m: A.layout.offStretches,
      osmRacewayWaysNotFollowed: A.layout.osmWaysNotFollowed, onewayDirectionCheck: { sameM: A.layout.onewayCheck.sameDirectionM, oppositeM: A.layout.onewayCheck.oppositeM } },
    direction: { game: A.direction, real: X.directionReal.value, ok: A.direction === X.directionReal.value, source: X.directionReal.source },
    startFinish: { gameStart: A.startFinish.gameStart, osm: A.startFinish.osmNodes },
    pit: { game: pitGame(A), osm: A.pit.osm.map((p) => ({ way: p.way, name: p.tags && p.tags.name, lengthM: p.lengthM, fromS: p.minS, toS: p.maxS, side: p.side, first: p.first, last: p.last })),
      realLimitKmh: ['us-1909', 'us-1956'].includes(id) ? null : 80, limitSource: id === 'us-1956' ? 'F1 raced here 1961-1980, before pit lane speed limits (introduced after the 1994 San Marino GP: ' + W('Pit_stop') + ')' : id === 'us-1909' ? 'not found for the 2000-2007 United States GPs (the 80 km/h default of the current regulations is not a source for then)' : SRC.pit80 },
    elevation: { demUsedForReference: E.source, gameSource: id === 'us-2022' || id === 'ca-1978' ? 'GLO-90 (Open-Meteo), FLAT_TRACKS (range scaled to <= 4 m)' : 'USGS 3DEP via EPQS along the dataset centreline, DTM filters',
      real: E.real, game: E.game, buildRawAlongDatasetLine: E.buildRawAlongDatasetLine, rmsDiffM: E.rmsDiffM, correlation: E.correlation, maxAbsDiff: E.maxAbsDiff,
      grades: E.grades, published: X.published, famousFeatures: X.famous },
    banking: { method: A.banking.method, straightsAbsTiltMedianDeg: A.banking.straightsAbsTiltMedianDeg, gameOverrides: A.banking.gameOverrides, gameMaxAbsBankDeg: A.banking.gameMaxAbsBankDeg,
      corners: A.banking.corners },
    tunnelsAndBridges: { crossings: A.crossings.map((c) => ({ kind: c.kind, osmWay: c.way, s: c.s !== undefined ? c.s : c.s0, at: c.at || null,
      what: [c.tags.highway, c.tags.railway, c.tags.waterway, c.tags.man_made].filter(Boolean).join('/'), bridge: c.tags.bridge || null, tunnel: c.tags.tunnel || null, layer: c.tags.layer || null, name: c.tags.name || null })),
      gameSceneryBridges: A.sceneryBridges },
    findings,
    proposedCorrection: X.proposal,
    profile: A.profile,
    sources: [SRC.game, SRC.osm, id.startsWith('ca-') ? SRC.hrdem : SRC.usgs, SRC.pit80, ...X.layout.sources],
  };
  writeFileSync(resolve(OUTDIR, id + '.json'), JSON.stringify(out, null, 1));
  console.log(id, sev, findings.map((f) => f.aspect + ':' + f.severity).join(', '));
}
