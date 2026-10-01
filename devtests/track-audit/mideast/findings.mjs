// node devtests/track-audit/mideast/findings.mjs  ->  devtests/track-audit/{bh-2002,sa-2021,qa-2004,ae-2009}.json
// Merges the measurements (out/<id>-measure.json, written by audit.mjs) with the sourced findings and machine-readable
// correction proposals. Every number quoted in a finding is read from the measurement file or from a cited source.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), AUD = resolve(HERE, '..');
const M = (id) => JSON.parse(readFileSync(resolve(HERE, 'out', id + '-measure.json'), 'utf8'));

// ---------------------------------------------------------------- sources
const S = {
  osm: (what) => 'OpenStreetMap ' + what + ' (ODbL), Overpass cache devtests/track-audit/cache/overpass/',
  ltQ: (id, path) => 'F1 live-timing archive, 2025 qualifying positions: https://livetiming.formula1.com/static/' + path + 'Position.z.jsonStream (cache devtests/track-audit/cache/f1livetiming/' + id + '-*)',
  ltR: (path) => 'F1 live-timing archive, 2025 race positions (first 3 MB = grid before lights out): https://livetiming.formula1.com/static/' + path + 'Position.z.jsonStream',
  f1hl: 'formula1.com 2016-10-21 "Highs and lows - which F1 track has the most elevation changes?": https://www.formula1.com/en/latest/article/highs-and-lows-which-f1-track-has-the-most-elevation-changes-.7I9JEcBw3R2AqXbnJ6hyvc',
  glo30: 'Copernicus DEM GLO-30 (AWS Open Data COG, cache devtests/track-audit/cache/glo30/)',
  regs: 'FIA 2025 Formula 1 Sporting Regulations, Issue 5 (2025-04-30), Art. 34.7: "A speed limit of 80km/h will be imposed in the pit lane during the whole Competition. However, this limit may be amended by the Race Director" https://www.fia.com/system/files/documents/fia_2025_formula_1_sporting_regulations_-_issue_5_-_2025-04-30.pdf',
  fia: (f) => 'FIA decision document https://www.fia.com/system/files/decision-document/' + f + ' (cache devtests/track-audit/cache/fia/)',
  theRace: 'The Race, "Inside Abu Dhabi\'s tougher track with new \'signature corner\'" (Dec 2021): Turn 9 "a single, fast left-hander with five degrees of banking"; Jeddah T13 "more steeply banked at 12 degrees" https://www.the-race.com/formula-1/inside-abu-dhabis-tougher-track-with-new-signature-corner/',
  raceFans: 'RaceFans 2021-11-26, "How fans\' designs inspired the team behind Yas Marina\'s dramatic new layout": new turn nine "5% camber", apex speeds "around 250kph" https://www.racefans.net/2021/11/26/how-fans-designs-inspired-the-team-behind-yas-marinas-dramatic-new-layout/',
  wiki: (lang, t) => 'https://' + lang + '.wikipedia.org/wiki/' + t + ' (cache devtests/track-audit/cache/wikipedia/)',
};
const LTP = {
  'bh-2002': ['2025/2025-04-13_Bahrain_Grand_Prix/2025-04-12_Qualifying/', '2025/2025-04-13_Bahrain_Grand_Prix/2025-04-13_Race/'],
  'sa-2021': ['2025/2025-04-20_Saudi_Arabian_Grand_Prix/2025-04-19_Qualifying/', '2025/2025-04-20_Saudi_Arabian_Grand_Prix/2025-04-20_Race/'],
  'qa-2004': ['2025/2025-11-30_Qatar_Grand_Prix/2025-11-29_Qualifying/', '2025/2025-11-30_Qatar_Grand_Prix/2025-11-30_Race/'],
  'ae-2009': ['2025/2025-12-07_Abu_Dhabi_Grand_Prix/2025-12-06_Qualifying/', '2025/2025-12-07_Abu_Dhabi_Grand_Prix/2025-12-07_Race/'],
};
const METHOD = [
  'Layout: game centreline = js/track.js samples of tracks-data.js (built in node with lib/three.min.js), converted to lat/lon with the track\'s geo (which carries the official-length rescale), compared in true metres with the OpenStreetMap raceway ways of the layout and with F1\'s own timing reference line (2025 qualifying positions fitted onto OSM by a similarity transform: multi-start angle/mirror/translation search + ICP).',
  'Elevation reference: Z of the F1 live-timing positions (the road height of F1\'s 1-D track model; X/Y/Z in decimetres; median of ~100-200 rows per 10 m bin from 20 cars). Validated where published figures exist: Bahrain 16.6 m vs 16.9 m (formula1.com) and max 3.5 % / 5.1-5.9 % vs 3.6 % / 5.6 % (de.wikipedia); Yas Marina 11.0 m vs 10.7 m with the peak at T3 (formula1.com). Copernicus GLO-30 (30 m surface model, the full-resolution version of the GLO-90 the game uses) sampled along the OSM centreline as a second reference.',
  'The timing positions lie on a single reference line (lateral spread of rows within a 50 m bin on straights 0.1-0.4 m; every car on the grid gets the same lateral offset), so they give the height profile and the longitudinal grid positions but NOT banking or lateral grid side.',
  'Grades: max climb / descent over 50 m and 100 m windows; the game-vs-real comparison uses centred 100 m grades per 10 m bin and flags sections where they differ by more than 2 percentage points (kind: flattened / steepened / reversed / invented slope).',
  'Positions s are metres along the OSM centreline in the racing direction from the foot of the game\'s points[0] (the game\'s start line).',
];

const pick = (m) => ({
  layout: m.layout, geometryVsF1ReferenceLine: m.geometry, start: m.start, pit: m.pit,
  elevation: Object.fromEntries(Object.entries(m.elevation).filter(([k]) => k !== 'profile')),
  corners: m.corners, crossings: m.crossings, sceneryBridges: m.sceneryBridges,
});
const prof = (m) => Object.assign({ binM: m.elevation.binM, sNote: m.elevation.sNote, sources: m.elevation.sources }, m.elevation.profile);
const gd = (m, s) => m.elevation.gradeDiffsOver2pp.find((g) => g.fromS <= s && g.toS >= s) || {};
const atP = (m, s) => { const P = m.elevation.profile, i = P.s.findIndex((v) => v >= s); return { lt: P.lt[i], game: P.game[i], ltG: P.ltGrade100Pct[i], gameG: P.gameGrade100Pct[i], glo: P.glo30[i] }; };

// ---------------------------------------------------------------- per circuit
function bahrain() {
  const id = 'bh-2002', m = M(id), e = m.elevation, g = m.start.realGrid2025, L = m.layout, G = m.geometry;
  const st = [5005, 5205, 5315, 15, 115, 325].map((s) => [s, atP(m, s)]);
  const d4145 = gd(m, 4145), d2215 = gd(m, 2215), d2515 = gd(m, 2515), d3335 = gd(m, 3335), p1955 = atP(m, 1955);
  const findings = [
    { aspect: 'layout', severity: 'cosmetic',
      game: `Grand Prix Circuit (5.412 km) for every season; centreline vs OSM relation 284538: mean ${L.deviationGameVsOsm.meanM} m, max ${L.deviationGameVsOsm.maxM} m (main straight around the line, s ${L.deviationGameVsOsm.over5m.map((r) => r.fromS + '..' + r.toS).join(', ')}); vs F1's 2025 reference line: mean ${G.gameSamplesToLtPath.meanM} m, max ${G.gameSamplesToLtPath.maxM} m (racing line cutting T4 / T6 / T8)`,
      real: 'Grand Prix Circuit 5.412 km is the F1 layout 2004-2009 and 2011-2026; 2010 used the Endurance Circuit (6.299 km, extra loop after T4); the 2020 Sakhir GP used the Outer Circuit (3.543 km)',
      proposedFix: 'None for the GP layout (current). Layout note only: the 2010 Endurance and 2020 Outer layouts are not modelled (would need their own centrelines: OSM relations 11987743 "Bahrain International Circuit" incl. way 4818387 "Endurance Circuit", and 11987742 "Bahrain Outer Circuit").',
      sources: [S.osm('relation 284538 "Bahrain Grand Prix Circuit" = ways 4818385, 881756729, 881756728'), S.wiki('en', 'Bahrain_International_Circuit') + ': layouts GP 5.412 km, Outer 3.543 km, Endurance 6.299 km', S.wiki('de', 'Bahrain_International_Circuit') + ': 2010 GP on the Endurance layout', S.ltQ(id, LTP[id][0])] },
    { aspect: 'length', severity: 'cosmetic',
      game: `lengthKm ${L.lengths.gameKm}; samples ${L.lengths.samplesTrueM} m true`, real: `FIA 2025 circuit map "Circuit Centreline Length = 5.412km"; OSM ${L.lengths.osmM} m`,
      proposedFix: 'none', sources: [S.fia('2025_bahrain_grand_prix_-_event_notes_-_circuit_map_v4.pdf'), S.osm('relation 284538')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'clockwise', real: `clockwise (OSM oneway ways; 2025 timing rows: ${L.direction.liveTiming.forwardSteps} forward vs ${L.direction.liveTiming.backwardSteps} backward steps)`, proposedFix: 'none', sources: [S.osm('ways 4818385, 881756729, 881756728 (oneway=yes)'), S.ltQ(id, LTP[id][0])] },
    { aspect: 'start', severity: 'minor',
      game: `points[0] at ${m.start.gamePoint0LL.join(', ')}; pole box front bar 8 m behind it, pole on the driver's left; 16 boxes reach ~128 m behind the line`,
      real: `2025 race grid (timing positions just before lights out, ${g.startUtc}): pole car at s = +${g.poleS} m (${g.poleLL.join(', ')}), P20 at s = ${g.lastS} m, ${g.meanGapM} m apart -> the real grid is ~${Math.round(g.poleS + 8)} m further along than the game's. FIA pit lane drawing: "Pole LHS" (matches the game). FIA circuit map (scaled with its own "Speed trap 158 m before T1" / "DRS detection 50 m before T1"): the control line (chequered flag) ~730 m and the start line ~455 m before T1, i.e. the game's line lies ~160 m after the control line and ~85-90 m before the start line`,
      proposedFix: `START_AT 'bh-2002': [${g.proposedLineLL.join(', ')}] (s = +${g.proposedLineS} m: the game's pole box then stands where the 2025 pole car stood; lap counting moves with it). Keep pole on the left.`,
      sources: [S.ltR(LTP[id][1]), S.fia('2025_bahrain_grand_prix_-_event_notes_-_pit_lane_drawing_v2.pdf') + ' ("Pole LHS")', S.fia('2025_bahrain_grand_prix_-_event_notes_-_circuit_map_v4.pdf') + ' (Start Line / Control Line symbols, speed trap and DRS distances)'] },
    { aspect: 'pit', severity: 'cosmetic',
      game: `side right, limit ${m.pit.game.limitKmh} km/h, lane from s = ${m.pit.game.fromS - Math.round(L.lengths.gameKm * 1000)} m to +${m.pit.game.toS} m (lines at ${m.pit.game.entryLineS - Math.round(L.lengths.gameKm * 1000)} / +${m.pit.game.exitLineS} m), ${m.pit.game.length} m`,
      real: `side right (OSM way 187123422 "Pit Lane", ${m.pit.osm.midOffset} m from the centreline); leaves the lap at s = ${m.pit.osm.entryS - L.osm.lengthM} m and rejoins at +${m.pit.osm.exitS} m (${m.pit.osm.laneLen} m incl. entry/exit roads); de.wikipedia: "die Boxengasse 417,9 m"; limit 80 km/h (Sporting Regulations art. 34.7; the 2025 event notes set no other limit)`,
      proposedFix: 'none needed (side and limit right); optional: PIT_FACTS entry/exit points from OSM way 187123422 ends if js/track.js ever takes real pit geometry',
      sources: [S.osm('way 187123422 "Pit Lane"'), S.wiki('de', 'Bahrain_International_Circuit') + ': "die Boxengasse 417,9 m"', S.regs, S.fia('2025_bahrain_grand_prix_-_race_directors_event_notes_v2.pdf')] },
    { aspect: 'elevation', severity: 'minor',
      game: `range ${e.game.rangeM} m, highest point at s = ${e.game.highest.s} (T13), lowest s = ${e.game.lowest.s}; main straight NOT flat: ${st.map(([s, v]) => 's ' + s + ': ' + v.game + ' m').join(', ')} (a ~5 m hump peaking ~90 m before the line, +3.3 % up then -1.8 % down into T1); correlation with the real profile ${e.gameVsLt.correlation}, rms ${e.gameVsLt.rmsAfterOffsetM} m, worst ${e.gameVsLt.worstDiffM} m at s = ${e.gameVsLt.worstAtS}`,
      real: `F1 timing Z: range ${e.lt.rangeM} m (formula1.com: "Elevation change: 16.9m", "Its highest point is the hairpin at Turn 4 ... the start-finish straight some 15m lower"); highest at s = ${e.lt.highest.s} (T4), the main straight (s 5005 .. +115) flat within 0.2 m: ${st.filter(([s]) => s !== 325).map(([s, v]) => 's ' + s + ': ' + v.lt + ' m').join(', ')} (real T1 braking zone at s 325: ${st[5][1].lt} m). GLO-30 agrees with the timing Z (corr ${e.glo30VsLt.correlation}, rms ${e.glo30VsLt.rmsAfterOffsetM} m) except +2-3 m at the grandstand / pit building on the straight`,
      proposedFix: 'Replace elev with the timing-Z profile (proposedCorrections.elevation.perPoint, index-aligned with points; then no FLAT/GLO smoothing). Cause: GLO-90 (surface model) sees the main grandstand and pit building along the straight.',
      sources: [S.ltQ(id, LTP[id][0]), S.f1hl, S.glo30] },
    { aspect: 'gradient', severity: 'minor',
      game: `max climb ${e.game.grade100.maxClimbPct} % / max descent ${e.game.grade100.maxDescentPct} % (100 m), the descent at s ${e.game.grade100.descentAt.join('..')} (T13 -> T14 back straight, real ${d4145.ltGradePct} %: invented ${d4145.gameGradePct} %); flattened: after T8 s ${d2215.fromS}..${d2215.toS} (real ${d2215.ltGradePct} % vs ${d2215.gameGradePct} %), T9-T10 s ${d2515.fromS}..${d2515.toS} (${d2515.ltGradePct} % vs ${d2515.gameGradePct} %), T11 s ${d3335.fromS}..${d3335.toS} (${d3335.ltGradePct} % vs ${d3335.gameGradePct} %); the T7 -> T8 descent ${p1955.gameG} % vs real ${p1955.ltG} % at s 1955`,
      real: `timing Z: max climb ${e.lt.grade100.maxClimbPct} % (100 m) / ${e.lt.grade50.maxClimbPct} % (50 m) at s ${e.lt.grade100.climbAt.join('..')} (T11 -> T12/T13), max descent ${e.lt.grade100.maxDescentPct} % (100 m) / ${e.lt.grade50.maxDescentPct} % (50 m) at s ${e.lt.grade100.descentAt.join('..')} (T7 -> T8); de.wikipedia: "Die maximale Steigung beträgt 3,6 %, das maximale Gefälle 5,6 %"`,
      proposedFix: 'Same profile replacement as above (all sections listed in measurements.elevation.gradeDiffsOver2pp disappear).',
      sources: [S.ltQ(id, LTP[id][0]), S.wiki('de', 'Bahrain_International_Circuit')] },
    { aspect: 'banking', severity: 'cosmetic',
      game: `no override; js/track.js derives up to ${Math.max(...m.corners.map((c) => Math.abs(c.gameBankDeg)))} deg at the hairpins (T1 ${m.corners[0].gameBankDeg}, T4 ${m.corners[3].gameBankDeg}, T8 ${m.corners[7].gameBankDeg}, T10 ${m.corners[9].gameBankDeg} deg)`,
      real: 'no published bank angle for any Bahrain corner (en/de wikipedia, FIA notes); the timing data cannot measure banking (1-D positions)',
      proposedFix: 'none (no sourced angle); the derived banking is a global js/track.js choice', sources: [S.wiki('en', 'Bahrain_International_Circuit'), S.fia('2025_bahrain_grand_prix_-_race_directors_event_notes_v2.pdf')] },
    { aspect: 'tunnel', severity: 'cosmetic',
      game: 'no tunnels / bridges', real: `only underpasses BELOW the track (OSM: service tunnels ways 4818401 at s ${m.crossings.find((c) => c.osmWay === 4818401).s} (also under the pit lane), 271528382 at s ${m.crossings.find((c) => c.osmWay === 271528382).s}, 415670602/415670603 and the drag-strip tunnel 1251965005/1251965007 at s ~4615-4645); no bridge over the track in OSM`,
      proposedFix: 'none (nothing the driver sees)', sources: [S.osm('ways 4818401, 271528382, 415670602, 415670603, 1251965005, 1251965007 (tunnel=yes, layer -1)')] },
  ];
  return { id, m, verdict: 'minor issues', findings,
    proposedCorrections: {
      elevation: { action: 'replace elev', source: 'f1-livetiming-z (2025 qualifying), per tracks-data.js point, metres above the lap\'s lowest point', perPoint: m.proposedElevPerPoint.elev },
      START_AT: { latLon: g.proposedLineLL, sFromCurrentLineM: g.proposedLineS, note: g.proposedLineNote, optional: true },
      pit: { side: -1, limitKmh: 80, osmWays: [187123422], entryLL: m.pit.osm.entryLL, exitLL: m.pit.osm.exitLL, change: 'none' },
      bankOverrides: [],
      layoutNotes: ['GP circuit current (2004-09, 2011-26). 2010 = Endurance Circuit 6.299 km; 2020 Sakhir GP = Outer Circuit 3.543 km: not modelled.'],
    } };
}

function jeddah() {
  const id = 'sa-2021', m = M(id), e = m.elevation, g = m.start.realGrid2025, L = m.layout, G = m.geometry;
  const cr = (w) => m.crossings.filter((c) => c.osmWay === w && c.crosses === 'lap').map((c) => c.s);
  const findings = [
    { aspect: 'layout', severity: 'cosmetic',
      game: `2021+ layout; vs OSM (way 1007989410 + southern ways): mean ${L.deviationGameVsOsm.meanM} m, max ${L.deviationGameVsOsm.maxM} m; vs F1's 2025 reference line mean ${G.gameSamplesToLtPath.meanM} m, max ${G.gameSamplesToLtPath.maxM} m (no stretch over 10 m)`,
      real: 'the F1 layout raced 2021-2025 (FE / WTCR short layouts not used by F1)', proposedFix: 'none',
      sources: [S.osm('ways 1007989410, 1359884757, 1257884699, 1359884761, 1359884760, 1359884759, 1359884758, 1359884756, 1359884762'), S.ltQ(id, LTP[id][0]), S.wiki('en', 'Jeddah_Corniche_Circuit')] },
    { aspect: 'length', severity: 'cosmetic', game: `lengthKm ${L.lengths.gameKm}; samples ${L.lengths.samplesTrueM} m true`, real: `FIA 2025 map "Circuit Centreline Length = 6.174km"; OSM ${L.lengths.osmM} m`, proposedFix: 'none', sources: [S.fia('2025_saudi_arabian_grand_prix_-_event_notes_-_circuit_map_pit_lane_and_quarantine_zone.pdf')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'anticlockwise', real: `anticlockwise (timing rows ${L.direction.liveTiming.forwardSteps} forward / ${L.direction.liveTiming.backwardSteps} backward along the OSM ways)`, proposedFix: 'none', sources: [S.ltQ(id, LTP[id][0])] },
    { aspect: 'start', severity: 'minor',
      game: `points[0] at ${m.start.gamePoint0LL.join(', ')}; grid behind it (pole bar -8 m ... box 16 at -128 m), pole on the driver's LEFT`,
      real: `2025 race grid: pole car at s = +${g.poleS} m (${g.poleLL.join(', ')}), P20 at +${g.lastS} m (${g.meanGapM} m apart): the whole real grid stands AHEAD of the game's line, the game's grid is ~${Math.round(g.poleS + 8)} m too far back; FIA pit lane drawing "Pole RHS" (game: left). FIA circuit map: the control line (chequered flag) ~165 m before the start line (map-scaled, +-30 m), i.e. the game's points[0] is about at the control line`,
      proposedFix: `START_AT 'sa-2021': [${g.proposedLineLL.join(', ')}] (s = +${g.proposedLineS} m) and pole on the RIGHT: new track field gridPoleSide: -1 (js/track.js grid: lat = (k & 1 ? 1 : -1) * ... -> multiply by gridPoleSide)`,
      sources: [S.ltR(LTP[id][1]), S.fia('2025_saudi_arabian_grand_prix_-_event_notes_-_circuit_map_pit_lane_and_quarantine_zone.pdf') + ' (page 2 circuit map: Start Line / Control Line; page 3 pit lane drawing: "Pole RHS")'] },
    { aspect: 'pit', severity: 'cosmetic',
      game: `side left, ${m.pit.game.limitKmh} km/h, lane ${m.pit.game.length} m from s = ${m.pit.game.fromS - Math.round(L.lengths.gameKm * 1000)} to +${m.pit.game.toS} m`,
      real: `side left (OSM ways 1121870473 / 1257884704 (tunnel=yes, layer -1) / 1257884703 "Pit Lane"), leaves the lap at s = ${m.pit.osm.entryS - L.osm.lengthM} m, rejoins at +${m.pit.osm.exitS} m (${m.pit.osm.laneLen} m incl. entry/exit roads); a service-road bridge (OSM 1213751284, layer 1) crosses the pit entry; limit 80 km/h (Sporting Regulations art. 34.7, no other limit in the 2025 event notes)`,
      proposedFix: 'none needed (side and limit right)', sources: [S.osm('ways 1121870473, 1257884704, 1257884703, 1213751284'), S.regs, S.fia('2025_saudi_arabian_grand_prix_-_race_directors_event_notes_.pdf')] },
    { aspect: 'elevation', severity: 'cosmetic',
      game: `range ${e.game.rangeM} m (FLAT_TRACKS: scaled to <= 4 m), max grade ${e.game.grade100.maxClimbPct} % / ${e.game.grade100.maxDescentPct} %`,
      real: `timing Z: range ${e.lt.rangeM} m, max climb ${e.lt.grade100.maxClimbPct} % / descent ${e.lt.grade100.maxDescentPct} % (100 m) in the fast esses of the first sector (s ${e.lt.grade100.descentAt[0]}..${e.lt.grade100.climbAt[1]}); game vs real rms ${e.gameVsLt.rmsAfterOffsetM} m. GLO-30 is useless here (range ${e.glo30.rangeM} m, false ${e.glo30.grade50.maxClimbPct} % grades: surface model, acquired before the 2021 circuit)`,
      proposedFix: 'none needed (optional: the timing-Z profile, proposedCorrections.elevation.perPoint, adds the real 2.3 m undulation)', sources: [S.ltQ(id, LTP[id][0]), S.glo30] },
    { aspect: 'banking', severity: 'cosmetic',
      game: 'bankOverride T13 12 deg: full angle over the whole 208 deg left hairpin (game s 2290..2570, inside lower), derived <= 5.6 deg elsewhere',
      real: 'T13 banked 12 deg (it.wikipedia "la pendenza di 12 gradi della curva 13" citing formula1.com; de.wikipedia "Kurvenüberhöhung 12°"; The Race "banked at 12 degrees"); no other sourced banked corner',
      proposedFix: 'none (correct)', sources: [S.wiki('it', 'Circuito_di_Gedda'), S.wiki('de', 'Jeddah_Corniche_Circuit'), S.theRace] },
    { aspect: 'bridge', severity: 'minor',
      game: 'no bridge over the track (scenery-data.js has no bridge for sa-2021: build-scenery only takes man_made=bridge areas)',
      real: `OSM: footbridge way 1485777385 (bridge=yes, layer 1) spans both legs of the northern section at s = ${cr(1485777385).join(' and ')}; footbridge 1485777389 at s = ${cr(1485777389).join(' and ')}; service-road bridge 1213751284 (layer 1) over the lap at s = ${cr(1213751284).join(', ')} (just before the line) and over the pit entry`,
      proposedFix: 'Scenery: bridge decks for these OSM ways (footways ~4 m wide, the service road ~8 m, deck >= 5.5 m above the road, as js/scenery.js addBridge already draws man_made=bridge areas). In tools/build-scenery.mjs: also take highway=* + bridge=yes LINES that cross the circuit, buffered to their width.',
      sources: [S.osm('ways 1485777385, 1485777389, 1213751284')] },
  ];
  return { id, m, verdict: 'minor issues', findings,
    proposedCorrections: {
      elevation: { action: 'keep (optional replace)', source: 'f1-livetiming-z (2025 qualifying)', perPoint: m.proposedElevPerPoint.elev },
      START_AT: { latLon: g.proposedLineLL, sFromCurrentLineM: g.proposedLineS, note: g.proposedLineNote },
      gridPoleSide: { value: -1, note: 'FIA 2025 pit lane drawing "Pole RHS"; needs js/track.js support (pole box currently always on the left)' },
      pit: { side: 1, limitKmh: 80, osmWays: [1121870473, 1257884704, 1257884703], change: 'none' },
      bankOverrides: [{ name: 'T13', deg: 12, status: 'present and correct' }],
      scenery: { bridges: [{ osmWay: 1485777385, kind: 'footway bridge', lapS: cr(1485777385) }, { osmWay: 1485777389, kind: 'footway bridge', lapS: cr(1485777389) }, { osmWay: 1213751284, kind: 'service road bridge', lapS: cr(1213751284), alsoOverPitEntry: true }] },
      layoutNotes: ['2021+ F1 layout = current; nothing to change.'],
    } };
}

function lusail() {
  const id = 'qa-2004', m = M(id), e = m.elevation, g = m.start.realGrid2025, L = m.layout, G = m.geometry;
  const findings = [
    { aspect: 'layout', severity: 'cosmetic',
      game: `vs OSM way 152483595: mean ${L.deviationGameVsOsm.meanM} m, max ${L.deviationGameVsOsm.maxM} m; vs F1's 2025 reference line mean ${G.gameSamplesToLtPath.meanM} m, max ${G.gameSamplesToLtPath.maxM} m`,
      real: 'the layout F1 raced in 2021 and 2023-2025 (en.wikipedia lists "Original Grand Prix Circuit (2004-2022)" 5.380 km and "Grand Prix Circuit (2023-present)" 5.419 km; no stretch of the 2025 line is more than 8 m from the game\'s centreline)',
      proposedFix: 'none', sources: [S.osm('way 152483595 (closed circuit)'), S.ltQ(id, LTP[id][0]), S.wiki('en', 'Lusail_International_Circuit')] },
    { aspect: 'length', severity: 'minor',
      game: `lengthKm ${L.lengths.gameKm}: the dataset's 5.380 km (the 2004-2022 figure) made build-tracks shrink the points by ${((1 - L.lengths.geoScale) * 100).toFixed(2)} % (geo scale ${L.lengths.geoScale}); true size of the drawn centreline ${L.lengths.datasetPolylineTrueM} m`,
      real: `FIA 2025 map "Circuit Centreline Length = 5.419km"; OSM ${L.lengths.osmM} m; en.wikipedia Grand Prix Circuit (2023-present) 5.419 km`,
      proposedFix: 'Official length override for qa-2004: 5419 m (rescale factor ~1.002 instead of 0.995); lengthKm 5.419',
      sources: [S.fia('2025_qatar_grand_prix_-_event_notes_-_circuit_map._pit_lane_drawing_emergency_exits_map_ers_battery_containment_area_red_zones_map.pdf'), S.wiki('en', 'Lusail_International_Circuit')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'clockwise', real: `clockwise (timing rows ${L.direction.liveTiming.forwardSteps} forward / ${L.direction.liveTiming.backwardSteps} backward)`, proposedFix: 'none', sources: [S.ltQ(id, LTP[id][0])] },
    { aspect: 'start', severity: 'cosmetic',
      game: `points[0] at ${m.start.gamePoint0LL.join(', ')}, pole box front bar 8 m behind`,
      real: `2025 race grid: pole car at s = ${g.poleS} m (${g.cars} cars standing, down to ${g.lastS} m) - the game's line is where the real start line is (FIA map: start line mid-straight, control line further back towards T16); pole side not stated in the 2025 FIA documents`,
      proposedFix: 'none', sources: [S.ltR(LTP[id][1]), S.fia('2025_qatar_grand_prix_-_event_notes_-_circuit_map._pit_lane_drawing_emergency_exits_map_ers_battery_containment_area_red_zones_map.pdf')] },
    { aspect: 'pit', severity: 'minor',
      game: `side right, ${m.pit.game.limitKmh} km/h; lane peels off the main straight at s = ${m.pit.game.fromS - Math.round(L.lengths.gameKm * 1000)} m (after T16) and rejoins at +${m.pit.game.toS} m, ${m.pit.game.length} m`,
      real: `side right; the F1 pit entry (OSM way 1037707300 "F1 Pit entry") leaves the lap at s = ${m.pit.osm.entryS} (${m.pit.osm.entryS - L.osm.lengthM} m), on the inside BEFORE T16 (T16 apex s ~4695), and joins the pit lane (way 196193732) that rejoins at s = +${m.pit.osm.exitS} m before T1 (${m.pit.osm.laneLen} m); 80 km/h (Sporting Regulations art. 34.7, no other limit in the 2025 event notes)`,
      proposedFix: 'If js/track.js takes real pit geometry: entry at the OSM 1037707300 branch point [25.4851995, 51.4544205] (before T16), exit at [25.4919501, 51.4479661]. Otherwise none.',
      sources: [S.osm('ways 1037707300 "F1 Pit entry", 196193732 "Pit Lane"'), S.regs, S.fia('2025_qatar_grand_prix_-_race_directors_event_notes_.pdf')] },
    { aspect: 'elevation', severity: 'cosmetic',
      game: `range ${e.game.rangeM} m, max ${e.game.grade100.maxClimbPct} % / ${e.game.grade100.maxDescentPct} % (100 m); a +${e.gameVsLt.worstDiffM} m hump at s = ${e.gameVsLt.worstAtS} (the straight just before the line)`,
      real: `timing Z: range ${e.lt.rangeM} m, max ${e.lt.grade100.maxClimbPct} % / ${e.lt.grade100.maxDescentPct} %; highest after T16 (s ${e.lt.highest.s}; game ${e.game.highest.s}), lowest s ${e.lt.lowest.s} (game ${e.game.lowest.s}); game vs real corr ${e.gameVsLt.correlation}, rms ${e.gameVsLt.rmsAfterOffsetM} m; no section differs by more than 2 percentage points`,
      proposedFix: 'optional: the timing-Z profile (proposedCorrections.elevation.perPoint)', sources: [S.ltQ(id, LTP[id][0]), S.glo30] },
    { aspect: 'banking', severity: 'cosmetic', game: `derived only, <= ${Math.max(...m.corners.map((c) => Math.abs(c.gameBankDeg)))} deg`, real: 'no published bank angle (de.wikipedia infobox "Kurvenüberhöhung" left empty)', proposedFix: 'none', sources: [S.wiki('de', 'Losail_International_Circuit')] },
    { aspect: 'tunnel', severity: 'cosmetic', game: 'none', real: `three road tunnels pass UNDER the lap (OSM 347533291 at s ${m.crossings.find((c) => c.osmWay === 347533291).s}, 1234912007 at s ${m.crossings.find((c) => c.osmWay === 1234912007).s}, 347533295 at s ${m.crossings.find((c) => c.osmWay === 347533295 && c.s).s} also under the pit lane); the six OSM footbridges by the main straight (ways 1316236368 ... 1316236378) do not cross the track`, proposedFix: 'none', sources: [S.osm('ways 347533291, 347533295, 1234912007, 1316236368-1316236378')] },
  ];
  return { id, m, verdict: 'minor issues', findings,
    proposedCorrections: {
      officialLengthM: { value: 5419, note: 'FIA 2025 circuit map centreline length; replaces the dataset\'s 5380 (2004-2022 layout figure) in the official-length rescale' },
      elevation: { action: 'keep (optional replace)', source: 'f1-livetiming-z (2025 qualifying)', perPoint: m.proposedElevPerPoint.elev },
      START_AT: null,
      pit: { side: -1, limitKmh: 80, osmWays: [1037707300, 196193732], entryLL: m.pit.osm.entryLL, exitLL: m.pit.osm.exitLL, change: 'entry before T16 only if pit geometry from OSM is supported' },
      bankOverrides: [], layoutNotes: ['2023+ Grand Prix Circuit geometry = current; only the length figure is the 2004-2022 one.'],
    } };
}

function yas() {
  const id = 'ae-2009', m = M(id), e = m.elevation, g = m.start.realGrid2025, L = m.layout, G = m.geometry;
  const d4395 = gd(m, 4395), d5125 = gd(m, 5125);
  const findings = [
    { aspect: 'layout', severity: 'cosmetic',
      game: `2021+ layout (16 turns); vs OSM relation 19882715 "Yas Marina Circuit 2025": mean ${L.deviationGameVsOsm.meanM} m, max ${L.deviationGameVsOsm.maxM} m; vs F1's 2025 reference line mean ${G.gameSamplesToLtPath.meanM} m, max ${G.gameSamplesToLtPath.maxM} m`,
      real: 'Grand Prix Circuit (2021-present) 5.281 km, 16 turns; seasons 2010-2020 raced the 2009-2021 layout (5.554 km, 21 turns: T5-T6 chicane, T11-T14, tighter T17-T20)',
      proposedFix: 'none for the current layout; layout note: the 2010-2020 layout is not modelled (it would need its own centreline; OSM no longer carries it)',
      sources: [S.osm('relation 19882715 = ways 168477013, 1469184731, 1469184732 (the last two from api.openstreetmap.org, cache/osmapi), 188337196, 1255169703, 1255169704'), S.ltQ(id, LTP[id][0]), S.wiki('en', 'Yas_Marina_Circuit')] },
    { aspect: 'length', severity: 'cosmetic', game: `lengthKm ${L.lengths.gameKm}; samples ${L.lengths.samplesTrueM} m`, real: `FIA 2025 map "Circuit Centreline Length = 5.281km"; OSM ${L.lengths.osmM} m`, proposedFix: 'none', sources: [S.fia('2025_abu_dhabi_grand_prix_-_event_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_quarantine_zone_and_red_zones.pdf')] },
    { aspect: 'direction', severity: 'cosmetic', game: 'anticlockwise', real: `anticlockwise (timing rows ${L.direction.liveTiming.forwardSteps} forward / ${L.direction.liveTiming.backwardSteps} backward)`, proposedFix: 'none', sources: [S.ltQ(id, LTP[id][0])] },
    { aspect: 'start', severity: 'cosmetic',
      game: `points[0] at ${m.start.gamePoint0LL.join(', ')}, pole bar 8 m behind, pole left`,
      real: `2025 race grid: pole car at s = ${g.poleS} m, P20 at ${g.lastS} m -> the game's grid is ~${Math.round(-g.poleS - 8)} m ahead of the real one; FIA circuit map (scaled with the T16 -> T1 straight): the control line ~125 m before the start-line symbol, which lies ~15 m before the game's line, consistent with the grid; pole side not stated in the 2025 FIA documents`,
      proposedFix: `optional START_AT 'ae-2009': [${g.proposedLineLL.join(', ')}] (s = ${g.proposedLineS} m)`, sources: [S.ltR(LTP[id][1]), S.fia('2025_abu_dhabi_grand_prix_-_event_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_quarantine_zone_and_red_zones.pdf')] },
    { aspect: 'pit', severity: 'major',
      game: `generic lane on the right of the main straight, rejoining the track on the right at s = +${m.pit.game.toS} m, before T1; ${m.pit.game.limitKmh} km/h`,
      real: `pit lane on the right (OSM way 176695254) from s = ${m.pit.osm.entryS - L.osm.lengthM} m (entry inside T16); the pit EXIT dives into a tunnel under the track just after T1 (OSM way 176695255 tunnel=yes layer -1, crossing under the lap at s ~282) and climbs back to rejoin on the LEFT at T3 (s ~${m.pit.osm.exitS}, way 176695253). en.wikipedia: "the pit exit, which dips under the main circuit by way of a tunnel"; de.wikipedia: part of the pit exit runs below the track and rejoins from below; 80 km/h (Sporting Regulations art. 34.7, no other limit in the 2025 event notes)`,
      proposedFix: 'Needs js/track.js support for an OSM pit lane with an underpass: lane geometry from ways 176695254 + 176695255 + 176695253, exit tunnel ~40 m (s 255..294 alongside T1) under the track, merge on the left at T3. Data: proposedCorrections.pit. Side (right) and limit stay.',
      sources: [S.osm('ways 176695254, 176695255 (tunnel=yes, layer -1), 176695253 "Pit Lane"'), S.wiki('en', 'Yas_Marina_Circuit'), S.wiki('de', 'Yas_Marina_Circuit'), S.fia('2025_abu_dhabi_grand_prix_-_event_notes_-_circuit_map_pit_lane_drawing_emergency_exits_map_quarantine_zone_and_red_zones.pdf') + ' (page 3 pit lane drawing)', S.regs] },
    { aspect: 'bridge', severity: 'major',
      game: `no structure over the track at the W hotel (scenery has only the hotel tower ~15 m beside the track at s ~4411); the two scenery bridge decks are the road / foot bridge at s ~${m.sceneryBridges[0].nearestLapS} and the Marina Walk Bridge at s ~${m.sceneryBridges[1].nearestLapS} (both real, OK)`,
      real: 'the track passes under the W Abu Dhabi hotel\'s link bridge: OSM raceway way 1255169704 covered=yes (s 4416..4445) under building:part 1387292013 (white glass, min_height 9 m, height 18 m); en.wikipedia: the circuit "passes by the marina and under the W Abu Dhabi hotel" (photo caption "The circuit goes under the W Abu Dhabi - Yas Island hotel")',
      proposedFix: 'Scenery: a bridge deck from OSM way 1387292013 (underside 9 m, top 18 m, white glass) over s 4416..4445; in tools/build-scenery.mjs take building:part with min_height >= 5 that crosses the circuit as a bridge (js/scenery.js addBridge with a given underside height). The road below must not climb: see elevation (the surface model reads the hotel as a hump there).',
      sources: [S.osm('ways 1255169704 (covered=yes), 1387292013 (building:part, min_height 9, height 18), 1228229328 "W Hotel Abu Dhabi"'), S.wiki('en', 'Yas_Marina_Circuit')] },
    { aspect: 'elevation', severity: 'minor',
      game: `range ${e.game.rangeM} m, highest at s = ${e.game.highest.s} (T3), corr with the real profile ${e.gameVsLt.correlation}, rms ${e.gameVsLt.rmsAfterOffsetM} m; invented: ${d4395.gameGradePct} % slope under the W hotel (s ${d4395.fromS}..${d4395.toS}, real ${d4395.ltGradePct} %), the main straight rising ${d5125.gameGradePct} % where it really falls ${d5125.ltGradePct} % (s ${d5125.fromS}..${d5125.toS}; hump +${e.gameVsLt.worstDiffM} m at s ${e.gameVsLt.worstAtS}); T2 -> T3 climb flattened to ${e.game.grade100.maxClimbPct} % (100 m)`,
      real: `timing Z: range ${e.lt.rangeM} m (formula1.com: "Elevation change: 10.7m", "one stand-out 'peak' at the sweeping Turn 3"), highest at s = ${e.lt.highest.s} (T3), climb ${e.lt.grade100.maxClimbPct} % (100 m) / ${e.lt.grade50.maxClimbPct} % (50 m) at s ${e.lt.grade100.climbAt.join('..')}, descent ${e.lt.grade100.maxDescentPct} % after T3. GLO-30 is worse than the game here (false ${e.glo30.grade50.maxClimbPct} % grades by the T5 grandstands)`,
      proposedFix: 'Replace elev with the timing-Z profile (proposedCorrections.elevation.perPoint).',
      sources: [S.ltQ(id, LTP[id][0]), S.f1hl, S.glo30] },
    { aspect: 'banking', severity: 'cosmetic',
      game: 'no override; derived 2.9..3.9 deg (inside lower) over T9 (OSM s ~3509..3676), the 198 deg left at the end of the second back straight',
      real: 'T9 (2021, replaced old T11-T14) is banked: The Race "five degrees of banking"; RaceFans quoting the circuit: "5% camber" (= 2.9 deg). The game already lies between the two figures. de.wikipedia also mentions some off-camber ("hängende") corners without naming them or giving angles',
      proposedFix: 'optional bankOverrides T9 5 deg (The Race) from [24.463222, 54.608575] to [24.464561, 54.608796] (where the radius drops below 400 m, game s 3490..3758); keep as is if the 5 % figure is preferred',
      sources: [S.theRace, S.raceFans, S.wiki('de', 'Yas_Marina_Circuit')] },
    { aspect: 'tunnel', severity: 'cosmetic', game: 'none', real: 'the track itself crosses OVER grandstand access tunnels on a short bridge (OSM raceway 188337196 bridge=yes layer 1, s 2082..2116; tunnels 188858652, 188858656 "Access to Main Grandstand", 188858666, 1153686600 below) and over service / footway tunnels near the line (168477698, 188739622 at s ~5041) and at T2 (188739619, 188858657 at s ~595); a run-off under the West grandstand (en/de wikipedia)', proposedFix: 'none (invisible to the driver)', sources: [S.osm('ways 188337196, 188858652, 188858656, 188858666, 1153686600, 168477698, 188739622, 188739619, 188858657'), S.wiki('en', 'Yas_Marina_Circuit')] },
  ];
  return { id, m, verdict: 'major issues', findings,
    proposedCorrections: {
      elevation: { action: 'replace elev', source: 'f1-livetiming-z (2025 qualifying), per tracks-data.js point, metres above the lap\'s lowest point', perPoint: m.proposedElevPerPoint.elev },
      START_AT: { latLon: g.proposedLineLL, sFromCurrentLineM: g.proposedLineS, note: g.proposedLineNote, optional: true },
      pit: { side: -1, limitKmh: 80, osmWays: [176695254, 176695255, 176695253], entryLL: m.pit.osm.entryLL, exitLL: m.pit.osm.exitLL,
        exitTunnel: { osmWay: 176695255, underLapS: 282, from: [24.470176, 54.608055], to: [24.470615, 54.607953] }, rejoinSide: 1, change: 'needs OSM pit geometry + underpass support in js/track.js' },
      bankOverrides: [{ name: 'T9', deg: 5, from: [24.463222, 54.608575], to: [24.464561, 54.608796], optional: true, note: 'The Race 5 deg vs RaceFans 5 % (2.9 deg); derived 2.9-3.9 deg today' }],
      scenery: { bridges: [{ osmWay: 1387292013, kind: 'W hotel link bridge (building:part)', minHeightM: 9, heightM: 18, lapS: [4416, 4445], status: 'missing' },
        { osmWays: [133904804, 520933543, 1473728620], lapS: 2765, status: 'present (scenery bridge)' }, { osmWays: [188732722, 1473750056], name: 'Marina Walk Bridge', lapS: 4643, status: 'present (scenery bridge)' }] },
      layoutNotes: ['2021+ layout = current. 2010-2020 seasons used the 5.554 km / 21-turn layout: not modelled.'],
    } };
}

const all = [bahrain(), jeddah(), lusail(), yas()];
let VER = {}; try { VER = JSON.parse(readFileSync(resolve(HERE, 'out', 'verify-elev.json'), 'utf8')); } catch (e) { /* run verify-elev.mjs */ }
for (const c of all) if (VER[c.id] && c.proposedCorrections.elevation) c.proposedCorrections.elevation.verification = VER[c.id];
const written = [];
for (const c of all) {
  const out = {
    id: c.id, name: c.m.name, audited: new Date().toISOString().slice(0, 10), verdict: c.verdict,
    findings: c.findings, proposedCorrections: c.proposedCorrections,
    measurements: pick(c.m), demProfile: prof(c.m), method: METHOD,
    scripts: 'devtests/track-audit/mideast/ (audit.mjs -> out/<id>-measure.json; findings.mjs -> this file); caches in devtests/track-audit/cache/ (overpass, osmapi, f1livetiming, glo30, fia, wikipedia)',
  };
  const f = resolve(AUD, c.id + '.json');
  writeFileSync(f, JSON.stringify(out, null, 1));
  written.push(f);
  console.log(c.id, c.verdict, c.findings.map((x) => x.aspect + ':' + x.severity).join(' '));
}
console.log(written.join('\n'));
