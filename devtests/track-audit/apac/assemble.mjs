// node devtests/track-audit/apac/assemble.mjs -- writes devtests/track-audit/<id>.json for the APAC circuits (jp-1962, sg-2008,
// my-1999, cn-2004, au-1953) from the measurements in apac/out/ (made by dump-game.js, layout.mjs, au-chain.mjs, gsi.mjs, dem.mjs,
// pit.mjs, overhead.mjs, corners.mjs) plus the cited references. Offline: no network.
import { resolve } from 'node:path';
import { HERE, AUDIT, readJSON, writeJSON, track, toXZ, project, metric, cumLen } from './common.mjs';
import { compare } from './compare.mjs';
import { bridgeDeck } from './jp-run.mjs';
import { deviation } from './osmline.mjs';

const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const out = (f) => readJSON(resolve(HERE, 'out', f));
const PIT = out('pit.json');
const SRC = {
  f1com: 'formula1.com "Highs and lows - which F1 track has the most elevation changes?" (2016), https://www.formula1.com/en/latest/article/highs-and-lows-which-f1-track-has-the-most-elevation-changes-.7I9JEcBw3R2AqXbnJ6hyvc (cached: devtests/track-audit/cache/wikipedia/f1com-highs-and-lows-2016.html)',
  osm: 'OpenStreetMap (c) OpenStreetMap contributors, ODbL; Overpass / OSM API extracts cached in devtests/track-audit/cache/overpass/<id>-all.json and cache/osmapi/',
  esri: 'Esri World Imagery (Vantor / Maxar), checked by eye with devtests/track-audit/apac/imagery.mjs; tiles cached in devtests/track-audit/cache/imagery/',
  glo30: 'Copernicus DEM GLO-30 (30 m surface model, TanDEM-X 2011-2015), AWS open data COG https://copernicus-dem-30m.s3.amazonaws.com (cache/glo30/<id>-apac.json)',
  srtm: 'SRTM GL1 30 m (surface model, Feb 2000) via https://api.opentopodata.org/v1/srtm30m (cache/otd-srtm30m/<id>.json)',
  gsi: 'GSI DEM 5 m laser (DEM5A, 国土地理院) via https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php (cache/gsi5m/jp-1962-osm.json)',
  game: 'game data: tracks-data.js built with lib/three.min.js + js/track.js + scenery-data.js (devtests/track-audit/apac/dump-game.js -> apac/out/game-<id>.json)',
};
function profileTable(r, step = 50) {
  const g = r.grid, k = Math.round(step / g.ds), rows = [];
  for (let i = 0; i < g.game.length; i += k) rows.push([Math.round(i * g.ds), g.game[i], g.dem[i]]);
  return { columns: ['gameS_m', 'game_m', 'dem_m (filtered, relative to its lowest point)'], rows };
}
function elevSummary(r) {
  const p = (s) => ({ range: r2(s.range), highAtS: Math.round(s.highAt), lowAtS: Math.round(s.lowAt), climb50: s.climb50, descent50: s.descent50, climb100: s.climb100, descent100: s.descent100 });
  return { demSource: r.demSourceLabel, filter: r.mode, game: p(r.game), dem: p(r.dem), demRawRange: r.demRawRange, shapeCorrelation: r.shapeCorrelation,
    shapeRmsDiffM: r.shapeRmsDiff, gradeDiffOver2pp_100mWindow: r.gradeDiffOver2pp };
}
// heights on a 20 m grid of game arc length with the lat/lon of the game samples there (robust to a START_AT change)
function profileOverride(id, r) {
  const g = out('game-' + id + '.json'), S = g.samples, k = Math.round(20 / r.grid.ds), pts = [];
  for (let i = 0; i < r.grid.dem.length; i += k) { const s = i * r.grid.ds, q = S[Math.round(s / g.ds) % S.length]; pts.push([q.lat, q.lon, r.grid.dem[i]]); }
  return pts;
}
function pitBlock(id, limitNote) {
  const p = PIT[id];
  return { real: { side: p.realSide, osmWays: p.osmWays, entryGameS: p.realEntry.s, entryLatLon: p.realEntry.ll, exitGameS: p.realExit.s, exitLatLon: p.realExit.ll,
    besideTrackGameS: p.realBesideTrack, laneLengthM: p.realLaneLength }, game: p.game, sideConvention: 'gameS < 0 = before the line; side as in tracks-data pitSide (-1 = driver\'s right)', limit: limitNote };
}
const files = [];

// ============================================================================================================ Suzuka
{
  const id = 'jp-1962', t = track(id), L = out('osm-' + id + '.json'), G = out('game-' + id + '.json');
  const r = compare(id, 'gsi', 'dtm', { preprocess: bridgeDeck });
  const gsi = out('dem-jp-1962-gsi.json').profile, hAt = (s) => gsi.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a)).h;
  const lowAsl = Math.min(...gsi.map((p) => p.h));
  const cross = G.crossings[0], yLow = G.samples[cross[0]].y, yUp = G.samples[cross[1]].y;
  const doc = {
    id, name: t.name, verdict: 'major issues',
    summary: 'Layout, length, direction, pit side and the whole height profile match the GSI laser DEM and the published figures (40.4 m, 2.8 % down the main straight, low between T1 and T2, high after Spoon). The one big error: the figure-of-eight crossover is an at-grade X in the game (js/track.js levels both roads to one height at 28.9 m), where the real west straight crosses the Degner-hairpin road on a bridge 6.2 m higher.',
    layout: { dataset: 'Grand Prix circuit 2003-present (used by F1 2010-2019, 2022-2026)', officialLengthKm: 5.807, officialLengthSource: 'en.wikipedia.org/wiki/Suzuka_Circuit infobox (Grand Prix Circuit 2003-present: 5.807 km)', gameLengthKm: t.lengthKm,
      osm: { method: 'map-matched to the OSM oneway raceway ways (apac/layout.mjs)', osmLengthM: Math.round(L.osmLength), gameTrueLengthM: Math.round(L.gameTrueLength), devMeanM: r2(L.devMean), devP95M: r1(L.devP95), devMaxM: r1(L.devMax), devMaxAtGameS: Math.round(L.devMaxAtGameS), gaps: L.gaps } },
    direction: { ok: true, evidence: 'all 37 OSM raceway ways used are oneway=yes in the racing direction; the matcher (direction within 50 deg) found no gaps' },
    startFinish: { gameLatLon: [34.843344, 136.540283], verified: false, note: 'OSM has no start-finish node here and the Esri imagery is not sharp enough (z18) to read the line; the game line is mid-straight beside the main grandstand, plausible. Not changed.' },
    pit: pitBlock(id, { game: 80, real: 80, note: 'no source found for a non-standard limit at Suzuka; the game uses the default 80 km/h' }),
    elevation: Object.assign(elevSummary(r), {
      demNote: 'GSI laser DEM sampled every 10 m along the OSM centreline (580 points, all hsrc "5m（レーザ）"); deck of the crossover bridged (the DEM gives the lower road under it)',
      published: { rangeM: [40.4, SRC.f1com], mainStraightGradePct: [-2.8, 'ja.wikipedia.org/wiki/鈴鹿サーキット: メインストレート "1コーナーに向けて2.8%の下り勾配" (ref. 竹中工務店)'],
        steepestClimbPct: [7.8, 'ja.wikipedia.org/wiki/鈴鹿サーキット: ターン7 "コース中最もきつい7.8%の上り勾配" (ref. Car Watch 2011-08-11)'],
        lowPoint: ['between Turn 1 and Turn 2', SRC.f1com], highPoint: ['just out of Spoon (T13/14)', SRC.f1com] },
      famousFeatures: [
        { feature: 'main straight down to T1 (s 0-500)', publishedPct: -2.8, demPct: r2((r.grid.dem[50] - r.grid.dem[0]) / 500 * 100), gamePct: r2((r.grid.game[50] - r.grid.game[0]) / 500 * 100), verdict: 'ok' },
        { feature: 'Dunlop / T7 climb (s 1466-1594)', publishedPct: 7.8, demMax50mPct: r.dem.climb50.pct, gameMax50mPct: r.game.climb50.pct, verdict: 'ok (game within 0.4 pp of the lidar; the published 7.8 % is a local maximum over a shorter base)' },
        { feature: 'low point between T1 and T2', gameS: Math.round(r.game.lowAt), demS: Math.round(r.dem.lowAt), verdict: 'ok' },
        { feature: 'high point after Spoon', gameS: Math.round(r.game.highAt), demS: Math.round(r.dem.highAt), verdict: 'ok' },
        { feature: 'final corner (T18) descent', gameMax100mPct: r.game.descent100.pct, demMax100mPct: r.dem.descent100.pct, verdict: 'ok' },
      ],
      profile50m: profileTable(r) }),
    crossover: {
      real: { upperRoad: 'west straight, OSM way 175231434 (highway=raceway, bridge=yes, layer=1, 37 m deck)', lowerRoad: 'Degner 2 -> hairpin, OSM way 183391655 (covered=yes)',
        upperRoadAslM: hAt(4636), lowerRoadAslM: hAt(4686), separationM: r1(hAt(4636) - hAt(4686)), upperRelativeToLapLowM: r1(hAt(4636) - lowAsl), lowerRelativeToLapLowM: r1(hAt(4686) - lowAsl),
        source: SRC.gsi + ': the deck approaches read 49.6 m ASL, the ground under the deck (= lower road) 43.4 m ASL' },
      game: { crossingSamples: cross, lowerGameS: Math.round(G.samples[cross[0]].s), upperGameS: Math.round(G.samples[cross[1]].s), lowerY: r2(yLow), upperY: r2(yUp),
        mechanism: 'js/track.js "self-crossing": both roads blended to their mean height (flat +-26 m, eased over 240 m) and the derived banking faded out over the same +-266 m (130R reads 0 to -0.8 deg), no deck, the car can drive straight across' },
      profileError: { lowerRoadTooHighM: r1(yLow - (hAt(4686) - lowAsl)), upperRoadTooLowM: r1((hAt(4636) - lowAsl) - yUp) },
    },
    banking: { publishedBankedCorners: 'none found', gyakuBank: { osmWay: 183391631, gameS: [1246, 1405], gameBankDeg: [1.8, 3.2, 3.7, 2.7, 3.3], real: 'no cant: "路面にカント（傾斜）が付いていない" -> drivers feel tilted outwards, hence the name 逆バンク (ja.wikipedia.org/wiki/鈴鹿サーキット)' } },
    covered: { bridges: ['crossover bridge (west straight over the Degner-hairpin road), see crossover'], tunnels: 'only service / foot tunnels under the track (OSM ways 34096664, 411291884 = prefectural road 643 under the main straight end and T16; 467945733, 941604835, ...): not visible from the car' },
    findings: [], proposedCorrections: {},
  };
  doc.findings.push({ aspect: 'bridge', severity: 'major',
    game: `At-grade X crossing: both roads at y ${r2(yLow)} m (lower road s ${Math.round(G.samples[cross[0]].s)}, upper road s ${Math.round(G.samples[cross[1]].s)}), no deck; heights levelled over +-266 m (lower road ${doc.crossover.profileError.lowerRoadTooHighM} m too high, upper road ${doc.crossover.profileError.upperRoadTooLowM} m too low, i.e. a fake ${doc.crossover.profileError.upperRoadTooLowM} m dip on the west straight into 130R) and banking faded out there`,
    real: `Bridge: west straight ${hAt(4636)} m ASL over the Degner-hairpin road ${hAt(4686)} m ASL = ${doc.crossover.real.separationM} m road-to-road; 37 m deck (OSM way 175231434)`,
    proposedFix: 'js/track.js: when the two roads at a self-crossing differ by more than ~4 m in tracks-data elev (Suzuka: ~6 m after build-tracks COVERED), keep both heights (no levelling, no bank fade), mark the upper road as a bridge deck +-25 m and render deck slab / parapets / abutments over the lower road; collision / locate() must pick the road by height. Data needed is already in tracks-data (COVERED keeps the upper road straight across the deck).',
    sources: [SRC.gsi, SRC.osm, 'en.wikipedia.org/wiki/Suzuka_Circuit: "the 1.2 km long back straight passing over the front section by means of an overpass"'] });
  doc.findings.push({ aspect: 'banking', severity: 'minor', game: 'T6 逆バンク (Gyaku curve, s 1246-1405) banked 1.8-3.7 deg into the corner (curvature-derived)',
    real: 'no cant at all (the corner is named for feeling tilted outwards)', proposedFix: 'bankOverrides jp-1962: { name: "T6 Gyaku Bank", deg: 0, from: [34.8423083, 136.5379594], to: [34.8432867, 136.5370669] (ends of OSM way 183391631) } — js/track.js needs deg 0 to mean "flat" (today deg 0 is skipped)', sources: ['ja.wikipedia.org/wiki/鈴鹿サーキット (S字コーナー、逆バンクコーナー)', SRC.osm] });
  doc.findings.push({ aspect: 'elevation', severity: 'cosmetic', game: 'tools/build-tracks.mjs PUBLISHED jp-1962 = 52 m citing ja.wikipedia "最大高低差は52 m"', real: 'the current ja.wikipedia article has no such sentence; formula1.com gives 40.4 m, which the lidar (40.4 m filtered) and the game (40.1 m) match',
    proposedFix: 'PUBLISHED jp-1962: [40.4, formula1.com "Highs and lows" 2016]', sources: [SRC.f1com, 'ja.wikipedia.org/wiki/鈴鹿サーキット (raw wikitext 2026-10-01, cache/wikipedia/ja-鈴鹿サーキット.wiki)'] });
  doc.findings.push({ aspect: 'pit', severity: 'minor', game: 'pit lane right side (ok), 500 m, entry 164 m before / exit 164 m after the line', real: `right side; entry after the chicane ${-PIT[id].realEntry.s} m before the line, exit at T1 ${PIT[id].realExit.s} m after, 887 m long (OSM way 120917578)`,
    proposedFix: 'optional: pit entry / exit positions as data (pitEntryAt / pitExitAt lat-lon) if js/track.js ever supports them', sources: [SRC.osm, SRC.esri] });
  doc.proposedCorrections = {
    crossover: { trackId: id, type: 'over-under bridge', upper: { gameS: doc.crossover.game.upperGameS, latLon: [34.843984, 136.530598], roadAslM: hAt(4636) }, lower: { gameS: doc.crossover.game.lowerGameS, roadAslM: hAt(4686) }, deckLengthM: 37, separationM: doc.crossover.real.separationM },
    bankOverrides: [{ name: 'T6 Gyaku Bank (no cant)', deg: 0, fromLatLon: [34.8423083, 136.5379594], toLatLon: [34.8432867, 136.5370669], note: 'ends of OSM way 183391631 (逆バンク); needs deg 0 support' }],
    published: { rangeM: 40.4, source: SRC.f1com },
    elevationSource: 'keep gsi5m (matches the lidar along the OSM centreline: correlation 1.00, RMS 0.86 m, all 100 m grades within 2 pp except at the crossover)',
  };
  files.push([id, doc]);
}

// ============================================================================================================ Sepang
{
  const id = 'my-1999', t = track(id), L = out('osm-' + id + '.json');
  const r = compare(id, 'glo30', 'dsm'), rs = compare(id, 'srtm30m', 'dsm'), rd = compare(id, 'glo30', 'dtm');
  const g = r.grid, at = (arr, s) => arr[Math.round(s / g.ds) % arr.length];
  const doc = {
    id, name: t.name, verdict: 'major issues',
    summary: 'Layout, length, direction and pit side are right. The start line is 302 m too far down the straight (the painted grid and the OSM start-finish node are at the east end of the pit building), and the GLO-90 height profile has the right range but the wrong shape: the highest point sits on the back straight (next to the double-sided grandstand, a surface-model artefact) instead of at T11, and the climb from the T9 hairpin up to T11 is cut from ~8 m to ~3 m.',
    layout: { dataset: 'F1 Grand Prix circuit (1999-2017; seasons 2010-2017 in the game)', officialLengthKm: 5.543, officialLengthSource: 'en.wikipedia.org/wiki/Sepang_International_Circuit infobox', gameLengthKm: t.lengthKm,
      osm: { method: 'map-matched to OSM oneway raceway ways (apac/layout.mjs)', osmLengthM: Math.round(L.osmLength), gameTrueLengthM: Math.round(L.gameTrueLength), devMeanM: r2(L.devMean), devP95M: r1(L.devP95), devMaxM: r1(L.devMax), devMaxAtGameS: Math.round(L.devMaxAtGameS), gaps: L.gaps } },
    direction: { ok: true, evidence: 'clockwise ("Gefahren wird üblicherweise im Uhrzeigersinn", de.wikipedia.org/wiki/Sepang_International_Circuit); OSM oneway raceway ways matched with no gaps' },
    startFinish: { gameLatLon: [2.760529, 101.735641], realLatLon: [2.7607601, 101.7383513], realGameS: -302,
      evidence: ['OSM node 1578189278 name=Start-Finish raceway=start-finish (tagged 2022-10, repositioned 2026-09 by another mapper)', 'Esri imagery z19 (img/sf-my-grid-a.png): the staggered grid-slot markings start just behind that node and run ~300 m back towards T15; the overhead start-gantry shadow is just ahead of it; at the game\'s line (img/sf-my-grid-b.png) there is only a thin line and no grid markings'],
      effect: 'game: line -> T1 braking (Pangkor Laut chicane, s 301) = 301 m; real = 603 m' },
    pit: pitBlock(id, { game: 80, real: 80, note: 'no source found for a non-standard limit' }),
    elevation: Object.assign(elevSummary(r), {
      demNote: 'GLO-30 sampled every 10 m along the OSM centreline; "dsm" filter = rolling 20th percentile over 150 m (the road is the lower envelope of a surface model), median 50 m, Gaussian 40 m. Cross-checked with GLO-30 unfiltered (dtm mode) and SRTM 30 m (2000, after the 1999 opening): all three put the low at T3 and the high at T10/T11.',
      crossCheck: { glo30_dtmFilter: { range: r2(rd.dem.range), highAtS: Math.round(rd.dem.highAt), lowAtS: Math.round(rd.dem.lowAt) }, srtm30m_dsmFilter: { range: r2(rs.dem.range), highAtS: Math.round(rs.dem.highAt), lowAtS: Math.round(rs.dem.lowAt), gradeDiffOver2pp: rs.gradeDiffOver2pp } },
      published: { rangeM: [22, SRC.f1com + ': "a 22m difference between Turn 3 and Turn 11"'] },
      famousFeatures: [
        { feature: 'T3 low point (OSM way "3", s 564-894)', gameLowS: Math.round(r.game.lowAt), demLowS: Math.round(r.dem.lowAt), verdict: 'ok' },
        { feature: 'T11 high point (Kenyir Lake Corner, s 3210-3269)', gameHeightAtT11: r1(at(g.game, 3240)), gameMax: r1(r.game.range), gameHighS: Math.round(r.game.highAt), demHeightAtT11: r1(at(g.dem, 3240)), demHighS: Math.round(r.dem.highAt), verdict: 'wrong: the game\'s high point is on the back straight (s 4292, 20.4 m) and T11 is 2.9 m below it; in the DEMs T11 is the top of the lap' },
        { feature: 'climb from T9 hairpin (s 2887) to T11 (s 3240)', gameRiseM: r1(at(g.game, 3240) - at(g.game, 2887)), demRiseM: r1(at(g.dem, 3240) - at(g.dem, 2887)), gameGrade100AtT9Exit: -2.07, demGrade100AtT9Exit: 1.75, verdict: 'flattened by ~5 m' },
        { feature: 'back straight (Penang Straight, s 3967-4814)', gameMeanM: r1((at(g.game, 4100) + at(g.game, 4300) + at(g.game, 4500) + at(g.game, 4700)) / 4), demMeanM: r1((at(g.dem, 4100) + at(g.dem, 4300) + at(g.dem, 4500) + at(g.dem, 4700)) / 4), verdict: 'game ~' + r1((at(g.game, 4100) + at(g.game, 4300) + at(g.game, 4500) + at(g.game, 4700)) / 4 - (at(g.dem, 4100) + at(g.dem, 4300) + at(g.dem, 4500) + at(g.dem, 4700)) / 4) + ' m too high (likely the double-sided main grandstand beside it inside the 90 m GLO-90 cells)' },
        { feature: 'descent T2 -> T3', gameSteepest100: r.game.descent100, demSteepest100: r.dem.descent100, verdict: 'game descent ~150 m late (DEM -4.8 % at s 530-650 where the game is flat; game -5.9 % at s 720-870 where the DEM is flat)' },
      ],
      profile50m: profileTable(r) }),
    banking: { publishedBankedCorners: 'none found', note: 'game banks hairpins (T1, T9, T15) 5-6 deg from curvature; no source for any real banking at Sepang' },
    covered: { note: 'nothing over the track; only service tunnels underneath (OSM ways 107364034, 107364089). The second pit lane along the back straight (OSM way 107364027) belongs to the South circuit ("Die Südvariante besitzt ... auf der Gegengeraden ... eine zweite Boxenanlage", de.wikipedia) and is not part of the F1 lap.' },
    findings: [], proposedCorrections: {},
  };
  doc.findings.push({ aspect: 'start', severity: 'major', game: 'start / finish line and grid 302 m further down the main straight (line -> T1 braking 301 m)', real: 'line at OSM node 1578189278 (2.7607601, 101.7383513), grid behind it towards T15 (painted slots visible on 2025 imagery); line -> T1 = 603 m',
    proposedFix: "START_AT['my-1999'] = [2.7607601, 101.7383513] (the pit lane then sits correctly around the line: real lane from s -685 to +247 relative to the game's current line = -383 .. +549 relative to the new one)", sources: [SRC.osm, SRC.esri] });
  doc.findings.push({ aspect: 'elevation', severity: 'major', game: `GLO-90: range ${r2(r.game.range)} m, low T3 (ok) but high on the back straight (s 4292); T11 ${r1(at(g.game, 3240))} m; T9->T11 rise ${r1(at(g.game, 3240) - at(g.game, 2887))} m; back straight ~19-20 m`,
    real: `GLO-30 (lower envelope): range ${r2(r.dem.range)} m (published 22 m T3->T11), high at T10/T11 (s ${Math.round(r.dem.highAt)}), T9->T11 rise ${r1(at(g.dem, 3240) - at(g.dem, 2887))} m, back straight ~14.5-16 m; 100 m grades differ by > 2 pp at 13 places (worst -5.8 pp at the T9 exit, +4.2/+4.9 pp around T2-T3, +4 pp invented climb after T15)`,
    proposedFix: 'elevation source for my-1999: GLO-30 sampled every 10 m with the surface-model lower-envelope filter (20th percentile over 150 m, median 50 m, Gaussian 40 m) instead of GLO-90 — or apply proposedCorrections.profileOverride (lat, lon, metres above the lap low every 20 m)', sources: [SRC.glo30, SRC.srtm, SRC.f1com] });
  doc.findings.push({ aspect: 'pit', severity: 'minor', game: 'right side (ok), 500 m lane centred on the (wrong) line', real: `right side, entry at the end of the back straight before T15 (${-PIT[id].realEntry.s} m before the game line), exit before T1 (${PIT[id].realExit.s} m after), 991 m (OSM ways 144359483, 23410526)`,
    proposedFix: 'comes mostly right with the START_AT move; optional entry / exit data', sources: [SRC.osm, SRC.esri] });
  doc.proposedCorrections = {
    START_AT: [2.7607601, 101.7383513],
    elevationSource: { source: 'glo30', step: 10, filter: 'lower envelope: rolling 20th percentile over 150 m, then median 50 m, Gaussian sigma 40 m', expectedRangeM: r2(r.dem.range) },
    profileOverride: { note: 'metres above the lap\'s lowest point every 20 m from the CURRENT game start line, with the lat/lon of that point (use the lat/lon after a START_AT change)', points: profileOverride(id, r) },
  };
  files.push([id, doc]);
}

// ============================================================================================================ Shanghai
{
  const id = 'cn-2004', t = track(id), L = out('osm-' + id + '.json');
  const r = compare(id, 'glo30', 'dsm'), g = r.grid, at = (arr, s) => arr[Math.round(s / g.ds) % arr.length];
  const doc = {
    id, name: t.name, verdict: 'major issues',
    summary: 'Layout (one OSM way, mean 2.2 m off), length, direction, pit side and the published height range (7.4 m, high at T2) are fine. The start line is ~210 m too far down the straight: the game\'s line is ~60 m before T1, while the painted grid under the grandstand wings starts ~219 m before it. The two "wing" viewing bridges over the start straight are missing.',
    layout: { dataset: 'Grand Prix circuit 2004-present (seasons 2010-2019, 2024-2026)', officialLengthKm: 5.451, officialLengthSource: 'en.wikipedia.org/wiki/Shanghai_International_Circuit infobox', gameLengthKm: t.lengthKm,
      osm: { method: 'OSM way 156328670 (the whole lap, 5462 m)', osmLengthM: Math.round(L.osmLength), gameTrueLengthM: Math.round(L.gameTrueLength), devMeanM: r2(L.devMean), devP95M: r1(L.devP95), devMaxM: r1(L.devMax), devMaxAtGameS: Math.round(L.devMaxAtGameS) } },
    direction: { ok: true, evidence: 'the game\'s first corner is the long tightening right-hander ("The first two bends make a 185 km/h right-hand curve", en.wikipedia.org/wiki/Shanghai_International_Circuit); OSM way 156328670 has no oneway tag' },
    startFinish: { gameLatLon: [31.336835, 121.21838], estimatedRealGameS: -210, firstGridMarkLatLon: [31.337348, 121.2206], firstGridMarkGameS: -219,
      evidence: ['no OSM start-finish node', 'Esri imagery z19 (img/sf-cn-a.png, img/sf-cn-b.png): staggered grid-slot markings on the straight from ~219 m before the game\'s line back past the east wing; none between them and the game line, which is beside the west wing ~60 m before the T1 turn-in (game T1 apex s 132)'],
      effect: 'game: line -> T1 ~60-130 m; real ~270-340 m' },
    pit: pitBlock(id, { game: 80, real: 80, note: 'no source found for a non-standard limit' }),
    elevation: Object.assign(elevSummary(r), {
      demNote: 'GLO-30 along the OSM way, lower-envelope filter. SRTM (Feb 2000) predates the circuit (built 2003-04 on marshland) and is not used. The grandstands / wings are inside the surface model on the start straight.',
      published: { rangeM: [7.4, SRC.f1com], highPoint: ['Turn 2', SRC.f1com], lowPoint: ['the long back straight', SRC.f1com] },
      famousFeatures: [
        { feature: 'high point at T2', gameHighS: Math.round(r.game.highAt), demHighS: Math.round(r.dem.highAt), verdict: 'ok' },
        { feature: 'low point on the back straight (T13-T14, s ~3200-4400)', gameLowS: Math.round(r.game.lowAt), gameBackStraightMinM: r1(Math.min(...[3300, 3450, 3600, 3750, 3900, 4050, 4200].map((s) => at(g.game, s)))), verdict: 'minor: the game\'s low (0 m) is between T12 and T13; its back straight reads 0.6-1.9 m' },
        { feature: 'range', game: r2(r.game.range), published: 7.4, demLowerEnvelope: r2(r.dem.range), verdict: 'ok (the 30 m lower envelope under-reads a 7 m range; the game is within 0.6 m of the published figure)' },
        { feature: 'start straight hump (s 5100-5400)', gameM: [r1(at(g.game, 5100)), r1(at(g.game, 5250)), r1(at(g.game, 5400))], demM: [r1(at(g.dem, 5100)), r1(at(g.dem, 5250)), r1(at(g.dem, 5400))], verdict: 'game -3 % over 100 m before the line where the lower envelope shows about half of it; probably the grandstand / wing structures in GLO-90' },
      ],
      profile50m: profileTable(r) }),
    banking: { publishedBankedCorners: 'none found' },
    covered: { real: 'main grandstand (OSM way 107371135 "A看台", height 35 m) linked to the pit / team building by two wing bridges over the start straight: OSM building:part 1371942059 (min_height 24.5 m) at game s 5019-5050 and 1371942060 (min_height 24.5 m) at s 5380-5411; en.wikipedia: "wing-like viewing platforms crossing the circuit at either end"',
      game: 'missing: scenery.js fits every footprint out of the road corridor ("start/finish gantry (the only thing over the road)"); no element of scenery-data within 70 m of either wing' },
    findings: [], proposedCorrections: {},
  };
  doc.findings.push({ aspect: 'start', severity: 'major', game: 'line ~60-130 m before T1 (beside the west wing)', real: 'grid markings start ~219 m before the game line (2025 imagery): line ~210 m further back (no OSM node)',
    proposedFix: "START_AT['cn-2004'] = [31.3372693, 121.2205226] (the centreline 10 m ahead of the first painted grid slot, s -209; +-15 m, check on an official map). Moves the game's pit lane too (real lane: entry before T16 at s -683, exit at T1 s +94 relative to the current line)", sources: [SRC.esri] });
  doc.findings.push({ aspect: 'bridge', severity: 'minor', game: 'no structure over the start straight', real: 'two wing bridges (underside 24.5 m) over the straight at s 5019-5050 and 5380-5411',
    proposedFix: 'scenery: allow OSM building:part with min_height >= 6 m that spans the corridor as an overhead slab (like the start gantry), or add the two wings by hand', sources: [SRC.osm, 'en.wikipedia.org/wiki/Shanghai_International_Circuit'] });
  doc.findings.push({ aspect: 'elevation', severity: 'minor', game: `low point s ${Math.round(r.game.lowAt)} (T12-T13 run), 3 % drop on the start straight 150 m before the line`, real: 'low point on the long back straight, "a fairly flat track with only minor elevation changes" (formula1.com); the GLO-30 lower envelope shows about -1.5 % (2.8 -> 0.5 m) over the same 150 m of the start straight',
    proposedFix: 'optional: GLO-30 lower-envelope profile scaled to the published 7.4 m; not worth a dedicated override', sources: [SRC.f1com, SRC.glo30] });
  doc.findings.push({ aspect: 'pit', severity: 'minor', game: 'right side (ok); lane 344 m, exit only 8 m after the line', real: 'right side, entry before T16 (683 m before the game line), exit at T1 (94 m after), 841 m (OSM ways 107371147 + 107371138)', proposedFix: 'follows from the START_AT move', sources: [SRC.osm] });
  doc.proposedCorrections = { START_AT: [31.3372693, 121.2205226], START_AT_confidence: 'approximate (+-15 m) from imagery', overheadStructures: [{ name: 'west wing', gameS: [5380, 5411], undersideM: 24.5, osm: 1371942060 }, { name: 'east wing', gameS: [5019, 5050], undersideM: 24.5, osm: 1371942059 }] };
  files.push([id, doc]);
}

// ============================================================================================================ Singapore
{
  const id = 'sg-2008', t = track(id), L = out('osm-' + id + '.json');
  const r = compare(id, 'glo30', 'dsmflat');
  const doc = {
    id, name: t.name, verdict: 'major issues',
    summary: 'The dataset is the current 4.927 km layout (2023+ straight along Raffles Avenue instead of the Float section, remeasured 2025) and follows the roads; direction, start line (5 m) and pit side are right. Missing: the East Coast Parkway / Benjamin Sheares Bridge viaduct and its ramps that the cars pass under around T1-T5 and before the line, and the building link over Raffles Boulevard. The pit lane limit has been 80 km/h since 2025 (game 60). Height range capped at 4 m vs 5.3 m published.',
    layout: { dataset: '2023+ layout (en.wikipedia: 2025-present 4.927 km, 19 turns; 2023-2024 4.940 km). Seasons 2010-2022 used the Float section (5.065-5.073 km), not modelled', officialLengthKm: 4.927, officialLengthSource: 'en.wikipedia.org/wiki/Marina_Bay_Street_Circuit infobox', gameLengthKm: t.lengthKm,
      osm: { method: 'map-matched to the public roads ignoring oneway (raced against the traffic in places); dual carriageways -> metres of offset are expected', osmPathLengthM: Math.round(L.osmLength), gameTrueLengthM: Math.round(L.gameTrueLength), devMeanM: r2(L.devMean), devP95M: r1(L.devP95), devMaxM: r1(L.devMax), devMaxAtGameS: Math.round(L.devMaxAtGameS), visualCheck: 'img/sg-2008-ov.png: the game line follows the circuit roads all the way' } },
    direction: { ok: true, evidence: 'anti-clockwise (REVERSED_IN_DATASET in build-tracks); lap description on en.wikipedia (T1 left, Republic Boulevard, Raffles Boulevard, ...) matches' },
    startFinish: { gameLatLon: [1.291728, 103.864144], osmStartLine: { node: 4281759834, latLon: [1.2916929, 103.8642117], gameS: -5 }, osmFinishLine: { node: 13826310653, latLon: [1.290463, 103.8643543], gameS: -141, note: 'tagged 2026-05 by one mapper; not checked further' }, ok: true },
    pit: pitBlock(id, { game: 60, real: { until2024: 60, from2025: 80 }, source: 'en.wikipedia.org/wiki/Singapore_Grand_Prix (2025: "increase in the pit lane speed limit from 60 km/h to 80 km/h", ref. Pirelli press 2025-09-29 https://press.pirelli.com/managing-the-heat-under-the-lights-in-singapore/ — checked: "The increase in the pit lane speed limit from 60 to 80 km/h ...")' }),
    elevation: Object.assign(elevSummary(r), {
      demNote: 'GLO-30 along the game centreline (the map-matched OSM path detours round dual carriageways), "dsmflat" filter = 20th percentile over 300 m + Gaussian 80 m: dense city, buildings and the ECP viaduct are in the surface model, only the broad shape survives. SRTM (2000) does not fit the present ground (range 50 m) and is not used.',
      published: { rangeM: [5.3, SRC.f1com] },
      famousFeatures: [{ feature: 'range', game: r2(r.game.range), published: 5.3, demLowerEnvelope: r2(r.dem.range), verdict: 'minor: build-tracks caps flat tracks at 4 m' }, { feature: 'low at the start / T1, high on St Andrew\'s Road (Padang)', gameLowS: Math.round(r.game.lowAt), gameHighS: Math.round(r.game.highAt), demLowS: Math.round(r.dem.lowAt), demHighS: Math.round(r.dem.highAt), verdict: 'low matches; the DEM high near s 3980 is the Raffles Avenue / Bayfront area where the viaducts stand (unreliable)' }],
      profile50m: profileTable(r) }),
    banking: { publishedBankedCorners: 'none (public roads)', note: 'the game banks the 90-degree street corners 5-6 deg (~10 % cross-slope) from curvature; public roads are crowned / drained, no source for any real banking' },
    covered: {
      overTheTrack: [
        { what: 'East Coast Parkway / Benjamin Sheares Bridge (motorway viaduct, layer 1-2) and its ramps', osmWays: [74722808, 122067627, 122067629, 122067630, 99007260, 121906574, 21786033, 21697558, 39961203, 122067631, 635253783], gameS: [[196, 260], [520, 720], [644, 981], [1020], [4282, 4339]], source: 'en.wikipedia lap description: "The pit straight approaching just below the Benjamin Sheares Bridge"' },
        { what: 'covered link building over Raffles Boulevard (min_height 4.5 m, height 6 m; Raffles Boulevard tunnel=building_passage, maxheight 4.5)', osmWays: [393090492, 479745478, 545362402], gameS: [[1236, 1259]] },
        { what: 'footbridges (layer 1-2)', osmWays: [740112301, 740112303, 741164882, 1314036589], gameS: [[196, 715], [898], [1028], [4282, 4339]] },
      ],
      trackOnBridges: [
        { what: 'Esplanade Bridge, 261 m low-level 7-span concrete arch bridge over the mouth of the Singapore River', osmWays: [763010995, 35037536, 1313321640], gameS: [2963, 3254], source: 'en.wikipedia.org/wiki/Esplanade_Bridge' },
        { what: 'Anderson Bridge (1910 steel bridge with granite portal arches)', osmWays: [29377119], gameS: [2789], source: 'en.wikipedia.org/wiki/Anderson_Bridge_(Singapore)' },
      ],
      game: 'none of these: scenery-data sg-2008 has 4 man_made=bridge decks but none over the track (devtests/track-audit/apac/out/overhead-sg-2008.json); the road on the bridges is plain terrain',
    },
    findings: [], proposedCorrections: {},
  };
  doc.findings.push({ aspect: 'bridge', severity: 'major', game: 'nothing overhead anywhere on the lap', real: 'the ECP / Benjamin Sheares Bridge viaduct and its ramps pass over the track at T1 (s ~200-260), around T3-T5 (s ~520-1020) and before the line (s ~4280-4340); a covered building link spans Raffles Boulevard (s 1236-1259, 4.5 m clearance)',
    proposedFix: 'scenery: build road viaducts (OSM highway=* bridge=yes layer>=1 crossing the corridor) as decks on piers outside the corridor, deck underside from OSM / >= 6 m above the track; add building passages with min_height as slabs. Ways listed in covered.overTheTrack', sources: [SRC.osm, SRC.esri, 'en.wikipedia.org/wiki/Marina_Bay_Street_Circuit'] });
  doc.findings.push({ aspect: 'pit', severity: 'minor', game: 'pitLimitKmh 60 for every season', real: '60 km/h until 2024, 80 km/h from 2025 (the game\'s 4.927 km layout is the 2025 one; default season 2026)',
    proposedFix: 'PIT_FACTS sg-2008: limitKmh 80 for seasons >= 2025 (or drop the 60 if the limit is not per season); a 482 m lane at 60 vs 80 km/h is ~7 s of pit loss', sources: ['en.wikipedia.org/wiki/Singapore_Grand_Prix', 'https://press.pirelli.com/managing-the-heat-under-the-lights-in-singapore/'] });
  doc.findings.push({ aspect: 'elevation', severity: 'minor', game: 'range 4.0 m (FLAT_MAX_RANGE)', real: '5.3 m (formula1.com); GLO-30 lower envelope 5.1 m', proposedFix: 'FLAT cap for sg-2008 = 5.3 m (per-track cap)', sources: [SRC.f1com, SRC.glo30] });
  doc.findings.push({ aspect: 'bridge', severity: 'cosmetic', game: 'Esplanade Bridge (s 2963-3254) and Anderson Bridge (s 2789) are plain road on terrain', real: 'the track crosses the river mouth on a 261 m bridge and the river on the 1910 Anderson Bridge (granite portal arches)', proposedFix: 'scenery: water + parapets under / beside those stretches (OSM bridge=yes on the racing road)', sources: [SRC.osm, 'en.wikipedia.org/wiki/Esplanade_Bridge'] });
  doc.findings.push({ aspect: 'layout', severity: 'cosmetic', game: '2023+ layout for every season 2010-2026', real: '2010-2012 Singapore Sling layout, 2013-2022 Float section (5.065 / 5.063 km), 2023+ straight', proposedFix: 'note only (one layout per circuit is a game-wide choice)', sources: ['en.wikipedia.org/wiki/Marina_Bay_Street_Circuit (layout history)'] });
  doc.findings.push({ aspect: 'pit', severity: 'minor', game: 'left side (ok), 482 m, entry 150 m before / exit 164 m after the line', real: `left side, entry ${-PIT[id].realEntry.s} m before, exit ${PIT[id].realExit.s} m after (round T3), 822 m (OSM way 100484287)`, proposedFix: 'optional entry / exit data', sources: [SRC.osm] });
  doc.proposedCorrections = { pitLimitKmh: { until2024: 60, from2025: 80 }, flatMaxRangeM: 5.3, overheadStructures: doc.covered.overTheTrack };
  files.push([id, doc]);
}

// ============================================================================================================ Albert Park
{
  const id = 'au-1953', t = track(id), A = out('osm-au-1953-relation.json');
  const r = compare(id, 'glo30', 'dsmflat');
  // deviation stats against the relation chain + the replacement stretches (OSM relation vertices between the game points)
  const M = metric(t.geo.lat0, t.geo.lon0), osmXY = A.llLine.map(([a, b]) => M.xy(a, b));
  const G = out('game-' + id + '.json'), S = G.samples;
  const gameXY = t.points.map((p) => M.xy(t.geo.lat0 + p[1] / t.geo.kz, t.geo.lon0 + p[0] / t.geo.kx));
  const dev = deviation(gameXY, osmXY, 5), p95 = dev.map((d) => d.d).sort((a, b) => a - b)[Math.floor(dev.length * 0.95)];
  function patch(s0, s1) {
    const q0 = S[Math.round(s0 / G.ds)], q1 = S[Math.round(s1 / G.ds)];
    const a = project(osmXY, ...M.xy(q0.lat, q0.lon), true), b = project(osmXY, ...M.xy(q1.lat, q1.lon), true);
    const pts = [];
    for (let i = a.seg + 1; i !== (b.seg + 1) % osmXY.length; i = (i + 1) % osmXY.length) pts.push(A.llLine[i]);
    return { fromGameS: s0, toGameS: s1, fromLatLon: [q0.lat, q0.lon], toLatLon: [q1.lat, q1.lon], replaceWithOsmVertices: pts };
  }
  const doc = {
    id, name: t.name, verdict: 'major issues',
    summary: 'Length (5.278 km), direction, pit side, the 80 km/h limit and the start line (45 m) are about right, but two stretches of the dataset leave the real road: the Lakeside Drive run after T8 bulges up to 22.5 m towards the lake through grass, and T11 (the old T13, rebuilt 2021) is cut diagonally across the park, turning ~45 m early. Height range 4.0 m (cap) vs 2.6 m published, with the high and low points in the wrong places.',
    layout: { dataset: '2021+ layout by length (5.278 km; T9/T10 chicane removed, T11 rebuilt) — geometry partly wrong, see findings. Seasons 2010-2019 used the 5.303 km layout with the chicane (not modelled)', officialLengthKm: 5.278, officialLengthSource: 'en.wikipedia.org/wiki/Albert_Park_Circuit infobox (2021-present)', gameLengthKm: t.lengthKm,
      osm: { method: 'OSM circuit relation 280443 chained in member order (apac/au-chain.mjs; includes the race-only disused:highway=raceway ways)', osmLengthM: Math.round(A.osmLength), gameTrueLengthM: Math.round(A.gameTrueLength), devMeanM: r2(A.devMean), devP95M: r1(p95), stretchesOver5m: A.stretches },
      imagery: 'Esri World Imagery 2025-11-25 (Vantor Vivid Advanced, 0.34 m): img/au-t9.png, img/au-t13.png, img/au-t910.png, img/au-1953-ov.png — the OSM relation lies on the asphalt, the game line crosses grass at both stretches' },
    direction: { ok: true, evidence: 'clockwise ("the current circuit which runs clockwise", en.wikipedia.org/wiki/Albert_Park_Circuit); relation members ordered "forward" in the game\'s direction' },
    startFinish: { gameLatLon: [-37.849757, 144.968644], osmNode: { id: 9123374386, latLon: [-37.8500562, 144.9689843], tag: 'raceway=start-finish', gameS: -45 }, note: 'a line across the road is visible at the OSM node on the 2025 imagery (img/sf-au-a.png)' },
    pit: pitBlock(id, { game: 80, real: 80, source: 'en.wikipedia.org/wiki/2022_Australian_Grand_Prix: organisers applied to raise the pit lane limit from 60 to 80 km/h after the 2021-22 works (ref. speedcafe.com 2022-04-06)' }),
    elevation: Object.assign(elevSummary(r), {
      demNote: 'GLO-30 along the OSM relation, "dsmflat" filter; park roads lined with trees: the surface model is inconclusive for a 2.6 m range (no open Australian lidar endpoint reachable: services.ga.gov.au refused / 404).',
      published: { rangeM: [2.6, SRC.f1com], highPoint: ['approaching Turn 13 (2016 numbering = T11 since 2022)', SRC.f1com], lowPoint: ['on the start-finish straight', SRC.f1com] },
      famousFeatures: [{ feature: 'range', game: r2(r.game.range), published: 2.6, verdict: 'game 1.4 m too much (flat-track cap 4 m)' },
        { feature: 'high / low points', gameHighS: Math.round(r.game.highAt), gameLowS: Math.round(r.game.lowAt), publishedHigh: 'approach to T11 (game s ~3900-4100)', publishedLow: 'start-finish straight (game s ~4900-5278 / 0-200)', verdict: 'both misplaced: game high on Albert Road Drive (T6-T7), low on Lakeside Drive after T8' }],
      profile50m: profileTable(r) }),
    banking: { publishedBankedCorners: 'none (public park roads)' },
    covered: { note: 'nothing permanent over the track (OSM); one service tunnel under the main straight (way 28119449)' },
    findings: [], proposedCorrections: {},
  };
  const pT9 = patch(2440, 2780), pT11 = patch(4030, 4300);
  doc.findings.push({ aspect: 'layout', severity: 'major', game: 'T11 (old T13, s 4099-4224): the dataset turns ~73 deg at one vertex 25 m before the real corner (the junction vertex of the OSM relation, -37.8533681, 144.9786557) and runs diagonally across the grass (max 21.5 m off at s 4119); the built corner has a 10 m minimum radius (80 deg, apex s 4091) — as tight as the Monaco hairpin problem; after T8 (s 2519-2699): an invented right-left bulge up to 22.5 m towards the lake (max at s 2589), where the real road (Lakeside Drive) is almost straight',
    real: 'OSM relation 280443 on the asphalt (checked on 2025-11-25 imagery): T11 is a ~90 deg right at the Lakeside Drive / Ross Gregory Drive junction; Lakeside Drive after T8 has only a gentle bend (the 2021-22 works removed the T9/T10 chicane)',
    proposedFix: 'replace the dataset vertices between game s 2440-2780 and 4030-4300 by the OSM relation vertices (proposedCorrections.layoutPatches; at T11 the OSM road centreline has a sharp junction vertex too: round it with an arc that stays on the paved junction, checked on the imagery, so the built radius is not ~10 m again), or take the whole centreline from relation 280443 (5293 m true, 0.3 % from 5.278 km; scenery-data is OSM so it aligns better; the start line / pit stay; seasons calibration must be re-run)', sources: [SRC.osm, SRC.esri, 'en.wikipedia.org/wiki/Albert_Park_Circuit ("Turn 13 was significantly altered, and turns 9 and 10 were removed")'] });
  doc.findings.push({ aspect: 'elevation', severity: 'minor', game: `range ${r2(r.game.range)} m, high s ${Math.round(r.game.highAt)} (Albert Road Drive), low s ${Math.round(r.game.lowAt)} (Lakeside Drive)`, real: '2.6 m, high approaching (old) T13, low on the start-finish straight (formula1.com); all grades < 1 % either way',
    proposedFix: 'FLAT cap for au-1953 = 2.6 m; without lidar keep the shape (or a hand profile: low on the main straight, rising ~2.6 m to the approach of T11)', sources: [SRC.f1com, SRC.glo30] });
  doc.findings.push({ aspect: 'start', severity: 'minor', game: 'line 45 m after the OSM start-finish node', real: 'OSM node 9123374386 raceway=start-finish (-37.8500562, 144.9689843); painted line visible there', proposedFix: "START_AT['au-1953'] = [-37.8500562, 144.9689843]", sources: [SRC.osm, SRC.esri] });
  doc.findings.push({ aspect: 'pit', severity: 'minor', game: 'right side (ok), 500 m, entry 167 m before / exit 164 m after the line', real: `right side, entry ${-PIT[id].realEntry.s} m before the line, exit ${PIT[id].realExit.s} m after, 712 m (OSM relation member 28119448, role pit_lane)`, proposedFix: 'optional entry / exit data', sources: [SRC.osm] });
  doc.proposedCorrections = { layoutPatches: [pT9, pT11], START_AT: [-37.8500562, 144.9689843], flatMaxRangeM: 2.6, alternative: 'centreline from OSM relation 280443 (devtests/track-audit/apac/out/osm-au-1953-relation.json llLine, clockwise from near the line)' };
  files.push([id, doc]);
}

for (const [id, doc] of files) {
  const o = Object.assign({ id: doc.id, name: doc.name, auditedAt: '2026-10-01', auditor: 'track-audit APAC (devtests/track-audit/apac/)', verdict: doc.verdict, summary: doc.summary, findings: doc.findings, proposedCorrections: doc.proposedCorrections }, doc);
  o.sourcesUsed = Object.values(SRC);
  o.files = { scripts: 'devtests/track-audit/apac/*.mjs', images: 'devtests/track-audit/apac/img/*.png (git-ignored output of imagery.mjs)', data: 'devtests/track-audit/apac/out/' };
  writeJSON(resolve(AUDIT, id + '.json'), o, true);
  console.log('wrote', id + '.json', doc.verdict, doc.findings.map((f) => f.severity + ':' + f.aspect).join(', '));
}
