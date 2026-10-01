// node devtests/track-audit/east/report.mjs
// Assembles devtests/track-audit/<id>.json for the five "east" circuits from the measurements in out/ (game dump,
// OSM comparison, DEM profiles) plus the cited reference facts. Every 'real' value carries its source.
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EAST, IDS, game, projector, r1 } from './core.mjs';
import { elevOsm } from './elev-osm.mjs';
import { stretchCmp } from './stretch-cmp.mjs';
import { corners } from './corners.mjs';

const OUT = resolve(EAST, '..');
const J = (f) => JSON.parse(readFileSync(resolve(EAST, 'out', f), 'utf8'));
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const statShort = (x) => x && { rangeM: x.rangeM, lowest: x.lowest, highest: x.highest, steepest50m: { climbPct: x.grade50.climb.pct, climbAtS: x.grade50.climb.fromS, descentPct: x.grade50.descent.pct, descentAtS: x.grade50.descent.fromS },
  steepest100m: { climbPct: x.grade100.climb.pct, climbAtS: x.grade100.climb.fromS, climbAt: x.grade100.climb.at, descentPct: x.grade100.descent.pct, descentAtS: x.grade100.descent.fromS, descentAt: x.grade100.descent.at },
  absMinM: x.absMin, absMaxM: x.absMax };

const SRC = {
  osm: 'OpenStreetMap contributors (ODbL), Overpass API; raw answers cached in devtests/track-audit/cache/overpass/east-*.json',
  glo30: 'Copernicus DEM GLO-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA; AWS Open Data COG s3://copernicus-dem-30m (cache/glo30/east-<id>.json)',
  srtm: 'SRTM 30 m (NASA, 2000) via OpenTopoData srtm30m (devtests/track-fix/cache/otd-srtm30m.json; cache/opentopodata/srtm30m/)',
  eudem: 'EU-DEM v1.1 25 m (Copernicus Land Monitoring Service) via OpenTopoData eudem25m (cache/opentopodata/eudem25m/)',
  aster: 'ASTER GDEM v3 30 m (NASA / METI) via OpenTopoData aster30m (cache/opentopodata/aster30m/)',
  f1com2016: 'formula1.com "Highs and lows - which F1 track has the most elevation changes?" (2016), cached devtests/track-audit/cache/wikipedia/f1com-highs-and-lows-2016.html',
};

// stations every 50 m of the OSM loop with the game's own s, for profile overrides
function stations(id, o, key, every = 50) {
  const G = game(id), pr = projector(G.geo.lat0, G.geo.lon0), GP = G.samples.map((q) => pr.f(q.lat, q.lon));
  const P = o._P, h = o._series[key], k = Math.round(every / P.ds), mn = Math.min(...h), rows = [];
  for (let i = 0; i < P.s.length; i += k) {
    const p = pr.f(P.lat[i], P.lon[i]);
    let bi = 0, bd = Infinity; for (let j = 0; j < GP.length; j++) { const d = (GP[j][0] - p[0]) ** 2 + (GP[j][1] - p[1]) ** 2; if (d < bd) { bd = d; bi = j; } }
    rows.push([Math.round(P.s[i]), Math.round(G.samples[bi].s), +P.lat[i].toFixed(6), +P.lon[i].toFixed(6), r1(h[i] - mn), r1(G.samples[bi].y)]);
  }
  return { columns: ['sTrueM', 'gameS', 'lat', 'lon', 'hRelM', 'gameYM'], rows };
}
function bankSummary(id) {
  const g = game(id), b = g.samples.map((s) => Math.abs(s.bank)), n = b.length, c = corners(id);
  return { source: 'js/track.js: derived from curvature (BANK_MAX 6 deg, inside lower); no bankOverrides for this circuit', maxDeg: r1(Math.max(...b)),
    shareOver3DegPct: r1(b.filter((v) => v > 3).length / n * 100), cornersFound: c.length,
    corners: c.map((x) => ({ hand: x.hand, gameS: [x.fromS, x.toS], apexS: x.apexS, angleDeg: x.angleDeg, minRadiusM: x.minRadiusM, gameBankDeg: x.bankDeg, gameGradePct: x.gradePct, apex: x.apex })) };
}
function pitBlock(id) {
  const o = J(`osm-${id}.json`), gp = o.gamePit;
  return { game: { side: gp.side === -1 ? 'right' : 'left', limitKmh: gp.limitKmh, entryS: Math.round(gp.entryS), entryLL: gp.entryLL, exitS: Math.round(gp.exitS), exitLL: gp.exitLL, laneFromS: Math.round(gp.fromS), laneToS: Math.round(gp.toS), lengthM: Math.round(gp.length) },
    osmPitWays: o.pits.map((p) => ({ id: p.id, name: p.name, lengthM: p.lengthM, side: p.side, leavesTrackAt: { gameS: p.first.gameS, trueS: p.first.trueS, ll: p.firstLL, offTrackM: p.first.d }, rejoinsAt: { gameS: p.last.gameS, trueS: p.last.trueS, ll: p.lastLL, offTrackM: p.last.d }, maxspeed: p.tags.maxspeed || null })) };
}
function layoutBlock(id, extra) {
  const o = J(`osm-${id}.json`), g = game(id);
  return Object.assign({ gameLengthKm: g.lengthKm, gameBuiltLengthM: Math.round(g.builtLength), gameTrueLengthM: o.gameTrueLengthM, buildRescale: o.gameScale,
    osmLoopLengthM: o.osmLoopLengthM, osmLoopGaps: o.osmLoopGaps, osmBase: o.osmBase, osmRelations: o.relations.map((r) => ({ id: r.id, name: r.tags.name, members: r.members })),
    lateralDeviationGameToOsm: o.deviation, osmWaysUsed: o.used.map((w) => ({ id: w.id, name: w.name, lengthM: w.lengthM, coverage: w.coverage })),
    osmWaysNotOnGameLine: o.other.filter((w) => w.coverage > 0 || /variante|gancho|tanque|lap|chicane/i.test(w.name || '')).map((w) => ({ id: w.id, name: w.name, lengthM: w.lengthM, coverage: w.coverage, nearGameS: w.nearGameS })) }, extra || {});
}
function crossBlock(id, note) {
  const o = J(`osm-${id}.json`), g = game(id);
  return { gameCrossings: g.crossings, osmCrossingsOfTheGameLine: o.crossings.map((c) => ({ id: c.id, kind: c.kind, name: c.name, layer: c.layer, gameS: c.at.gameS, ll: c.at.ll })), note };
}

async function build(id) {
  const g = game(id), o = await elevOsm(id), osm = J(`osm-${id}.json`), eg = J(`elev-game-${id}.json`);
  const elevBase = {
    along: 'OSM centreline loop, s = true metres from the foot of the game start line (gameS = the game\'s own s at the same place)',
    game: statShort(o.game), glo30: statShort(o.glo30), glo30LowerEnvelope: statShort(o.glo30floor), eudem25m: statShort(o.eudem25m), srtm30m: statShort(o.srtm30m), aster30m: statShort(o.aster30m),
    alongGameCentreline: { srtm30: statShort(eg.srtm30), glo90raw: statShort(eg.glo90raw), note: 'the same sources along the game\'s own points (elev-game.mjs); glo90raw = the unsmoothed input of the game profile' },
    shapeAgreement: o.compare,
  };
  const steep = o.glo30 ? await stretchCmp(id, 100, 0.05, 'glo30') : (o.srtm30m ? await stretchCmp(id, 100, 0.05, 'srtm30m') : []);
  const R = { id, name: g.name, auditor: 'track-audit east (2026-10-01)', method: 'devtests/track-audit/east/*.mjs (README in report.mjs header); game side = out/game-<id>.json (dump-game.js, the game\'s own js/track.js build)' };
  const F = [], fix = {};
  if (id === 'pt-1972') {
    R.layout = layoutBlock(id, {
      official: { 'GP circuit 1972-1993': 4.349, 'GP circuit 1994-1999 (chicane added after Imola 1994)': 4.360, 'GP circuit 2000-present (parabolica redesigned for FIM homologation)': 4.182, 'Tanque circuit 2018-present': 4.163,
        source: 'en.wikipedia.org/wiki/Circuito_do_Estoril infobox + History ("A new redesign of the parabolica turn which saw its length reduced to 4.182 km was implemented in 2000"); circuito-estoril.pt TRACK DATA (archived 2010-04-02): "Track Lenght (central line) 4.182,720 m"' },
      f1Use: 'Portuguese GP 1984-1996 (en.wikipedia); not on the 2010-2026 calendar',
      osmCurrentGpLayoutM: 4177, osmCurrentGpLayoutNote: 'OSM relation 11266675 "Circuito do Estoril" (19 members, pit lane excluded) = 2000-present GP circuit incl. the Gancho chicane: 4177 m',
      identification: 'The game line follows OSM within 6.4 m everywhere, using Curva do Tanque (way 38160804) instead of the Gancho chicane (ways 1301627165 + 363138870) and the post-2000 Parabolica Ayrton Senna (way 363138869): that is the "Tanque circuit (2018-present)", 4.163 km official, 4151 m along OSM, 4153 m along the game points. The dataset labels it 1972 / 4.349 km and the build stretched it x1.0474 to 4350 m. Commons maps File:Circuito_de_Estoril_1972-1993.png and File:Autódromo_de_Estoril_1994-1999.png (cache/wikipedia/east-img/) show the F1-era final Parabolica as a larger sweep further north-east; no OSM way of it survives (all ways in 38.7515..38.758 N, -9.394..-9.388 E checked, cache east-pt-1972-parabolica-area.json).',
    });
    F.push({ aspect: 'layout', severity: 'major', game: 'Dataset geometry = the modern "Tanque" layout (2018-present, 4.163 km): post-2000 Parabolica Ayrton Senna + Curva do Tanque, 4153 m true; labelled pt-1972 / 4.349 km.',
      real: 'F1 raced Estoril 1984-1996 on the pre-2000 layout: 1984-93 4.349/4.350 km (Curva do Tanque + the old, larger final Parabolica), 1994-96 4.360 km (old Parabolica + the post-Imola chicane). The 2000 redesign shortened the final Parabolica (~180 m); the Parabolica where Villeneuve passed Schumacher in 1996 is not the corner in the game.',
      proposedFix: 'Either (a) declare it the current layout: no 4.7 % stretch (official 4.182 with the Gancho, OSM relation 11266675 = 4177 m; or 4.163 Tanque) and name it "Estoril (2000- layout)"; or (b) redraw the pre-2000 Parabolica from historical imagery (DGT ORTOS-1995 orthophotos exist but need a DGT account; no OSM trace) for the 1994-96 F1 layout with the Gancho chicane.',
      sources: ['en.wikipedia.org/wiki/Circuito_do_Estoril', SRC.osm + ' ways 38160804, 1301627165, 363138870, 363138867, 363138869, relation 11266675', 'commons.wikimedia.org File:Circuito_de_Estoril_1972-1993.png, File:Autódromo_de_Estoril_1994-1999.png, File:Estoril track map.svg'] });
    F.push({ aspect: 'length', severity: 'minor', game: `Built lap ${Math.round(g.builtLength)} m: the 4153 m geometry stretched x1.0474 (every corner radius and straight +4.7 %) to the 1972-93 length.`,
      real: 'The drawn layout measures 4151 m on OSM (official Tanque 4.163 km); the stretch makes it 187 m longer than the real road it depicts.',
      proposedFix: 'build-tracks: per-track official-length override pt-1972 -> 4.163 (or 4.182 if the Gancho is added); the MAX_LENGTH_MISMATCH 15 % rule let a wrong-layout length through.', sources: ['en.wikipedia.org/wiki/Circuito_do_Estoril (Tanque circuit 4.163 km)', SRC.osm] });
    fix.layout = { lengthOverrideKm: 4.163, alternative: { addChicane: { osmWays: [1301627165, 363138870, 363138867], replaces: [38160804], resultingLengthM: 4177, officialKm: 4.182 } } };
    R.direction = { game: osm.direction.gameSense, real: 'clockwise', ok: true, source: 'OSM oneway raceway ways (4179 m agree, 0 against); Commons layout maps (arrow)' };
    R.startFinish = { game: osm.gameStart, osmNode: null, note: 'No start/finish node in OSM. circuito-estoril.pt: start-finish straight 985.686 m. The game line lies 496 m into the 999 m OSM pit lane (beside the pit building): plausible, not verified.' };
    R.pit = Object.assign(pitBlock(id), { real: { side: 'right', limitKmh: null, limitNote: '1994-96 F1 pit speed limits not verified' } });
    F.push({ aspect: 'pit', severity: 'minor', game: 'Pit lane 500 m beside the straight: entry gameS 4186, exit gameS 164.',
      real: 'OSM "Pit Lane" (way 363050271, 999 m, right side) leaves the track at gameS 3829 (357 m earlier, just after the Parabolica) and rejoins at gameS 591 (427 m later, after Curva 1).',
      proposedFix: 'pit entry/exit from OSM (new optional track fields, e.g. pitEntryLL [38.753124,-9.390716], pitExitLL [38.746388,-9.396228]); side -1 already right.', sources: [SRC.osm + ' way 363050271'] });
    fix.pit = { side: -1, entryLL: [38.753124, -9.390716], exitLL: [38.746388, -9.396228], note: 'entry/exit LL need a new track.js input (today the lane is synthesised beside the straight)' };
    R.elevation = Object.assign(elevBase, { published: { maxRisePct: 6.75, maxFallPct: 5.56, source: 'circuito-estoril.pt TRACK DATA (web.archive.org 2010-04-02, cached devtests/track-audit/cache/web/estoril-trackdata-2010.html): "GRADIENT MAX. of rise: 6,75% MAX. of fall: 5,56%"; en.wikipedia: "the maximum gradient is nearly 7%"', rangeM: null },
      steepStretchesGlo30VsGame: steep });
    F.push({ aspect: 'elevation', severity: 'minor', game: `Range ${o.game.rangeM} m; steepest fall ${o.game.grade100.descent.pct} %/100 m (${o.game.grade50.descent.pct} %/50 m) on the Descida para o Triângulo; high point on the Parabolica Ayrton Senna.`,
      real: `GLO-30 ${o.glo30.rangeM} m, SRTM ${eg.srtm30.rangeM} m, EU-DEM ${o.eudem25m.rangeM} m (three models agree within 3 m); official max fall 5.56 %, max rise 6.75 %. The game's GLO-90 input (raw range ${eg.glo90raw.rangeM} m) sees trees / structures at the Parabolica (+5 m) and makes the main straight dip 5 m too deep; its steepest fall exceeds the official maximum by ~2 pp (GLO-30: ${o.glo30.grade100.descent.pct} %/100 m). Climb ${o.game.grade100.climb.pct} %/100 m matches the official 6.75 %.`,
      proposedFix: 'Replace the profile with the GLO-30 one (median 50 m + Gauss 20 m, range 22.6 m; stations in proposedCorrections.elevation) or add a GLO-30 source to build-tracks; DGT LiDAR MDT 2 m (2024) would be best but its download needs a DGT account.', sources: [SRC.glo30, SRC.srtm, SRC.eudem, 'circuito-estoril.pt TRACK DATA 2010 (archived)'] });
    fix.elevation = { kind: 'profileOverride', source: 'GLO-30 cleaned along OSM', targetRangeM: o.glo30.rangeM, stations: stations(id, o, 'glo30') };
    R.banking = Object.assign(bankSummary(id), { real: 'No banked corner reported (en.wikipedia, circuito-estoril.pt track data list none).', verdict: 'synthetic only (7 corners at 4.5-5.6 deg, unverified)' });
    R.coveredAndBridges = crossBlock(id, 'No tunnel or covered section on the lap. OSM: footbridges over the track at gameS ~704 (Curva 1-2, way 363050593) and ~1510 (Recta Interior, way 363113294, 167 m); service / footway tunnels under it (not visible). scenery-data has 3 man_made=bridge decks for this circuit.');
    R.verdict = 'major issues';
  }
  if (id === 'pt-2008') {
    R.layout = layoutBlock(id, { official: { 'GP circuit 2008-present': 4.653, 'Motorcycling circuit (other Turn 5 variant)': 4.592, 'GP circuit with chicane 2008-2019': 4.684, source: 'en.wikipedia.org/wiki/Algarve_International_Circuit; de.wikipedia: MotoGP uses the other Turn 5 variant, 43 m shorter' },
      f1Use: 'Portuguese GP 2020, 2021', identification: 'Game line = OSM GP loop (Curva da Torre VIP variant way 511858547), deviation max 1.7 m; 4635 m true vs OSM 4631 m vs official 4.653 km. Correct F1 layout.' });
    R.direction = { game: osm.direction.gameSense, real: 'clockwise', ok: true, source: 'OSM oneway raceway ways (4631 m agree)' };
    R.startFinish = { game: osm.gameStart, osmStart: { id: 5006082198, tag: 'raceway=start', ll: [37.2321164, -8.6308098], offGameLineM: 0.1, gameS: 0 }, osmFinish: { id: 5006070798, tag: 'raceway=finish', ll: [37.2298018, -8.6299791], gameS: 4385, beforeGameLineM: 266 },
      fia: 'FIA 2020 Portuguese GP Race Director\'s Event Notes, pit lane map (cache/web/fia-2020-por-p7.png): Control Line at the pit-entry end of the pit straight, pole position further down = OSM finish / start nodes.', ok: true };
    F.push({ aspect: 'start', severity: 'cosmetic', game: 'One line for start and lap timing at the OSM raceway=start node (pole / start line).', real: 'The control (timing) line is a separate line 266 m earlier (OSM raceway=finish node 5006070798; FIA 2020 pit lane map).', proposedFix: 'none needed for the grid; a separate timing line would need a new field.', sources: [SRC.osm, 'fia.com 2020 Portuguese Grand Prix - Race Directors\' Event Notes (cache/web/fia-2020-portuguese-gp-event-notes.pdf)'] });
    R.pit = Object.assign(pitBlock(id), { real: { side: 'right', limitKmh: 80, limitSource: 'OSM pit lane maxspeed=80; FIA 2020 event notes make no change to Sporting Regulations art. 22.10 (80 km/h)', entry: 'from the pit straight after the last corner (FIA 2020 pit lane map; OSM way 511859459 "Enter Pit Line" from gameS 4105)', exit: 'just before Turn 1 (OSM way 157790380 end, gameS 318)' } });
    F.push({ aspect: 'pit', severity: 'minor', game: 'Lane 500 m: entry gameS 4488, exit gameS 164.', real: 'F1 entry from the straight at gameS ~4105 (OSM 511859459 start, 383 m earlier), exit at gameS 318 just before T1 (154 m later); ~860 m of lane. Side right and 80 km/h correct.',
      proposedFix: 'pitEntryLL [37.227374,-8.629111], pitExitLL [37.234861,-8.631817] (new optional fields).', sources: [SRC.osm + ' ways 511859459, 157790380', 'FIA 2020 Portuguese GP event notes pit lane map'] });
    fix.pit = { side: -1, limitKmh: 80, entryLL: [37.227374, -8.629111], exitLL: [37.234861, -8.631817] };
    const dip = (h, a, b, c) => [r1(h[a] - h[b]), r1(h[c] - h[b])];
    const P = o._P, at = (s) => P.s.findIndex((v) => v >= s);
    const iT9 = at(2190), iT10 = at(2410), iT11 = at(2650);
    R.elevation = Object.assign(elevBase, { published: { maxFallPct: 12, maxRisePct: 6.2, source: 'de.wikipedia.org/wiki/Autódromo_Internacional_do_Algarve: "Die steilste Abfahrt hat 12 % im Maximum, während es bis zu 6,2 % bergauf geht"' },
      t9t10t11Dip: { where: 'Curva Samsung (T9) -> Curva Craig Jones (T10) -> Curva Portimão (T11), OSM s 2190 / 2410 / 2650', glo30DropRiseM: dip(o._series.glo30, iT9, iT10, iT11), gameDropRiseM: dip(o._series.game, iT9, iT10, iT11),
        note: 'GLO-30, SRTM 2000 and the raw GLO-90 all show the ~11 m dip (elev-game profile50); the game\'s smoothing (125 m median + 50 m Gauss) keeps half of it' },
      steepStretchesGlo30VsGame: steep });
    F.push({ aspect: 'elevation', severity: 'major', game: `Range ${o.game.rangeM} m; steepest fall ${o.game.grade100.descent.pct} %/100 m (${o.game.grade50.descent.pct} %/50 m); T9-T10-T11 dip ${R.elevation.t9t10t11Dip.gameDropRiseM.join(' / ')} m (down / up).`,
      real: `Published max fall 12 % (game ~4 pp less). GLO-30 ${o.glo30.rangeM} m range, fall ${o.glo30.grade50.descent.pct} %/50 m, T9-T10-T11 dip ${R.elevation.t9t10t11Dip.glo30DropRiseM.join(' / ')} m; the descent after T9 is -8.6 %/100 m in GLO-30 vs -3.4 % in the game, the climb to T11 +7.4 % vs +4.2 %, the drop through Sagres (T14) -5.6 % vs -0.6 %. The "roller-coaster" crests the circuit is known for are halved.`,
      proposedFix: 'Profile override from GLO-30 (light DTM-style smoothing; stations below) or a GLO-30 source in build-tracks; best: DGT LiDAR MDT 2 m (needs a DGT account). Keep the 18 % slope cap.', sources: [SRC.glo30, SRC.srtm, SRC.eudem, 'de.wikipedia.org/wiki/Autódromo_Internacional_do_Algarve'] });
    fix.elevation = { kind: 'profileOverride', source: 'GLO-30 cleaned along OSM (note: a surface model; its climbs reach 8.4 %/50 m vs the published 6.2 % max, so a light extra smoothing of climbs or a lidar source is preferable)', targetRangeM: o.glo30.rangeM, stations: stations(id, o, 'glo30') };
    R.banking = Object.assign(bankSummary(id), { real: 'No banking figures published (de.wikipedia infobox "Kurvenüberhöhung" empty).', verdict: 'synthetic only' });
    R.coveredAndBridges = crossBlock(id, 'No tunnel, bridge or covered section the car drives through or under; two service tunnels pass under the track (gameS ~2848, ~4312).');
    R.verdict = 'major issues';
  }
  if (id === 'tr-2005') {
    R.layout = layoutBlock(id, { official: { 'GP circuit 2005-present': 5.338, source: 'en.wikipedia.org/wiki/Istanbul_Park; TOSFED Istanbul Park "The Circuit" (tosfedistanbulpark.com/en/the-circuit/): "Track Length: 5.338 km", 14 turns, Turn 8 "approximately 640 meters long ... quadruple-apex"' },
      f1Use: 'Turkish GP 2005-2011, 2020, 2021 (same layout)', identification: 'Game line within 8.5 m of OSM way 179048507 (5338 m = official); the game\'s points measure 5303 m (0.66 % short, corners slightly cut), rescaled x1.0071. Correct layout.' });
    R.direction = { game: osm.direction.gameSense, real: 'anticlockwise', ok: true, source: 'TOSFED Istanbul Park: "Direction: Counter-clockwise"; OSM oneway way' };
    R.startFinish = { game: osm.gameStart, osmNode: { id: 1893855303, tag: 'raceway=start-finish', ll: [40.95222, 29.4063884], gameS: 22, lateralM: 5.4 }, fia: 'FIA 2020 Turkish GP event notes pit lane map (cache/web/fia-tur-p8.png): control line near the pit-lane start, pole further on' };
    F.push({ aspect: 'start', severity: 'cosmetic', game: 'Line at gameS 0.', real: 'OSM raceway=start-finish node 1893855303 is 22 m further on.', proposedFix: "START_AT 'tr-2005': [40.95222, 29.4063884]", sources: [SRC.osm + ' node 1893855303'] });
    fix.START_AT = [40.95222, 29.4063884];
    R.pit = Object.assign(pitBlock(id), { real: { side: 'left', limitKmh: 80, limitSource: 'FIA 2020 Turkish GP Race Directors\' Event Notes v2: no change to Sporting Regulations art. 22.10 (80 km/h) (cache/web/fia-2020-turkish-gp-event-notes.pdf)', entry: 'in the final corner complex (FIA 2020 pit map; OSM way 295742111 from gameS 4784)', exit: 'after Turn 1 (FIA map; OSM gameS 442)' } });
    F.push({ aspect: 'pit', severity: 'minor', game: 'Lane 474 m: entry gameS 5176, exit gameS 138 (before T1).', real: 'OSM "Pit Lane" (way 295742111, 908 m, left): leaves at gameS 4784 (392 m earlier, in the last-corner complex), rejoins at gameS 442 (304 m later, after Turn 1, as the FIA 2020 pit map shows). Side left and 80 km/h correct.',
      proposedFix: 'pitEntryLL [40.95238,29.401025], pitExitLL [40.954302,29.408926] (new optional fields).', sources: [SRC.osm + ' way 295742111', 'FIA 2020 Turkish GP event notes'] });
    fix.pit = { side: 1, limitKmh: 80, entryLL: [40.95238, 29.401025], exitLL: [40.954302, 29.408926] };
    R.elevation = Object.assign(elevBase, { published: { rangeM: 40, rangeSource: 'f1-fansite.com/f1-circuits/istanbul-park-circuit/: "Elevation change | 40 meters / 131 feet"', maxGradientPct: 8.145, maxGradientSource: 'TOSFED Istanbul Park, The Circuit: "Maximum Gradient: 8.145%"', note: 'Wikipedia: "the circuit runs over four different ground levels"; Turn 1 "plunges downhill"' },
      steepStretchesGlo30VsGame: steep });
    F.push({ aspect: 'elevation', severity: 'minor', game: `Range ${o.game.rangeM} m; max climb ${o.game.grade100.climb.pct} %/100 m, max fall ${o.game.grade100.descent.pct} %/100 m.`,
      real: `Published 40 m (GLO-30 ${o.glo30.rangeM} m, EU-DEM ${o.eudem25m.rangeM} m); official max gradient 8.145 % (game within ~1 pp). The game clips ~6-7 m off the hilltop at OSM s ~1000 (the climb out of T1-T2 tops there) and ~8 m off the back straight before the T12 hairpin (OSM s 3940-4450; GLO-30 +6.4 %/100 m vs game +3.8 %). Turn 1 drop OK (game ~11 m, GLO-30 ~13 m over 400 m).`,
      proposedFix: 'Profile override from GLO-30 (stations below) or scale the hill sections; low priority.', sources: [SRC.glo30, SRC.eudem, 'f1-fansite.com Istanbul Park', 'tosfedistanbulpark.com/en/the-circuit/'] });
    fix.elevation = { kind: 'profileOverride', source: 'GLO-30 cleaned along OSM', targetRangeM: o.glo30.rangeM, stations: stations(id, o, 'glo30') };
    R.banking = Object.assign(bankSummary(id), { real: 'No banked corner published (Turn 8 is described only as a fast quadruple-apex left).', verdict: 'synthetic only (T8 apexes -4.0..-4.6 deg in game, unverified)' });
    R.coveredAndBridges = crossBlock(id, 'No tunnel, bridge or covered section the car drives through or under; two service tunnels under the track (gameS ~888, ~4488).');
    R.verdict = 'minor issues';
  }
  if (id === 'ru-2014') {
    R.layout = layoutBlock(id, { official: { 'GP circuit 2014-2023': 5.848, source: 'en.wikipedia.org/wiki/Sochi_Autodrom (dismantled after 6 Nov 2023; only the 2.313 km Sirius layout remains); de.wikipedia: FIA length 5.853 km' },
      f1Use: 'Russian GP 2014-2021', osmSnapshot: 'Current OSM only has the 2.313 km Sirius layout (way 1235494683), so the GP layout was compared with the OSM history snapshot of 2021-09-20 (Overpass attic query, cache east-ru-2014-attic-2021.json): way 234329382 "Сочи Автодром", 5832 m',
      identification: 'Game line within 9.3 m (mean 4.2 m) of the 2021 OSM GP loop; 5823 m true vs 5832 m OSM vs 5.848 official. Correct layout.' });
    R.direction = { game: osm.direction.gameSense, real: 'clockwise', ok: true, source: 'de.wikipedia.org/wiki/Sochi_Autodrom: "Die im Uhrzeigersinn zu durchfahrende Strecke"; 2021 OSM oneway way' };
    R.startFinish = { game: osm.gameStart, osmNode: null, note: 'No start/finish node in the 2021 OSM snapshot (the current raceway=start-finish node 8164671075 belongs to the short Sirius layout, 356 m off the GP line). FIA 2020 pit map: control line at the pit-entry end of the garages, pole further down. Not verified.' };
    R.pit = Object.assign(pitBlock(id), { real: { side: 'right', limitKmh: 60, limitSource: 'FIA 2020 Russian GP Race Directors\' Event Notes art. 18.1 and 2021 Russian GP Race Directors\' Event Notes v2 art. 18.1: "The Pit lane Speed limit ... is hereby amended to 60km/h for the duration of the Event" (cache/web/fia-2020-russian-gp-event-notes.pdf, fia-2021-russian-gp-event-notes.pdf)', entry: 'on the inside before the last corners (FIA 2020 pit map; 2021 OSM way 306234479 leaves at gameS 5205)', exit: 'on the straight after the Turn 1 kink (OSM gameS 485)' } });
    F.push({ aspect: 'pit', severity: 'minor', game: 'pitLimitKmh 80 (default).', real: 'Sochi ran a 60 km/h pit lane limit (FIA Race Director\'s event notes 2020 and 2021, art. 18.1).', proposedFix: "PIT_FACTS 'ru-2014': { limitKmh: 60 }", sources: ['fia.com 2020 Russian Grand Prix - Race Directors\' Event Notes Version 3', 'fia.com 2021 Russian Grand Prix - Race Directors\' Event Notes Version 2'] });
    F.push({ aspect: 'pit', severity: 'minor', game: 'Lane 500 m: entry gameS 5684, exit gameS 164.', real: '2021 OSM pit lane (way 306234479, 1069 m, right) leaves at gameS 5205 (479 m earlier, before T18, running inside T18-T19) and rejoins at gameS 485 (321 m later).', proposedFix: 'pitEntryLL [43.411489,39.967301], pitExitLL [43.407119,39.963608] (new optional fields).', sources: [SRC.osm + ' 2021 snapshot way 306234479', 'FIA 2020 Russian GP pit lane map (cache/web/fia-2020-rus-p10.png)'] });
    fix.PIT_FACTS = { limitKmh: 60 };
    fix.pit = { side: -1, limitKmh: 60, entryLL: [43.411489, 39.967301], exitLL: [43.407119, 39.963608] };
    R.elevation = Object.assign(elevBase, { published: { rangeM: 1.9, source: SRC.f1com2016 + ': "Sochi Autodrom, Russia Elevation change: 1.9m"; de.wikipedia infobox Höhenunterschied 1.9' },
      note: 'Build: FLAT_TRACKS (median 325 m, Gauss 250 m, scaled to <= 4 m). GLO-30 along OSM 4.2 m / lower envelope 3.5 m is surface-model noise at this scale.' });
    F.push({ aspect: 'elevation', severity: 'cosmetic', game: `Range ${o.game.rangeM} m, grades <= 0.5 %.`, real: 'Published 1.9 m (F1.com 2016; de.wikipedia).', proposedFix: "build-tracks: PUBLISHED 'ru-2014' 1.9 and scale FLAT tracks to their published range (ru-2014 -> 1.9 m)", sources: [SRC.f1com2016, 'de.wikipedia.org/wiki/Sochi_Autodrom'] });
    fix.elevation = { kind: 'scaleToRange', targetRangeM: 1.9, factor: r1(1.9 / o.game.rangeM * 100) / 100 };
    R.banking = Object.assign(bankSummary(id), { real: 'No banking published; the circuit runs on Olympic Park roads (F1.com: "extremely flat").', verdict: 'synthetic only: 12 of its 90-degree corners get 5.1-5.6 deg, unverified' });
    F.push({ aspect: 'banking', severity: 'cosmetic', game: '12 corners banked 5.1-5.6 deg inward (curvature-derived).', real: 'No banking reported for any corner (en/de.wikipedia, F1.com); the venue is described as extremely flat. Not measurable from the available 30 m DEMs.', proposedFix: 'Optional: a per-track bank scale (e.g. 0.4) for street / plaza circuits, or bankOverrides deg 0 on the 90-degree corners.', sources: [SRC.f1com2016] });
    R.coveredAndBridges = crossBlock(id, 'No tunnel on the lap. Current OSM has a private service-road bridge (way 259568728, layer 1) and footbridges (765654800, 306234499) crossing the GP line at gameS ~4590 and ~5480; the 2021 snapshot query did not include bridges, so their presence during the GP years is not verified. The game has no overhead structure there.');
    F.push({ aspect: 'bridge', severity: 'cosmetic', game: 'No bridge over the track.', real: 'OSM (current data): service bridge 259568728 + footbridge 765654800 over the GP line near T14-T15 (gameS ~4590), footbridge 306234499 before the last corners (gameS ~5480).', proposedFix: 'If confirmed for 2014-2021 imagery, add them as bridge decks in the scenery (build-scenery man_made=bridge path).', sources: [SRC.osm] });
    R.verdict = 'minor issues';
  }
  if (id === 'az-2016') {
    R.layout = layoutBlock(id, { official: { 'GP circuit 2016-present': 6.003, source: 'en.wikipedia.org/wiki/Baku_City_Circuit' },
      f1Use: 'European GP 2016, Azerbaijan GP 2017-2026', identification: 'Game line within 9.3 m (mean 2.8 m) of the street ways of OSM relation 11266687 (5994 m); game points 5932 m (1.0 % short), rescaled x1.012. Correct layout.' });
    R.width = { game: { halfWidthM: 7, note: 'js/track.js HALF_WIDTH 7 m (narrowed only by nearby scenery walls): 14 m through the castle section (gameS 2560-2800)' }, real: { castleSectionM: 7.6, source: 'en.wikipedia.org/wiki/Baku_City_Circuit: "the track has a narrow 7.6 m uphill section and then runs around the Old City"' } };
    F.push({ aspect: 'other', severity: 'major', game: 'Road 14 m wide through the old-town castle section (half width 7 m at gameS 2500-2900).', real: 'The castle section narrows to 7.6 m (en.wikipedia) - the defining feature of the lap.',
      proposedFix: 'New optional per-track width overrides, e.g. widthOverrides: [{ name: "castle T8-T12", from: [40.368589,49.837431], to: [40.369393,49.835656], halfW: 3.8, ramp: 30 }] (HALF_WIDTH_MIN 3.5 allows it).', sources: ['en.wikipedia.org/wiki/Baku_City_Circuit'] });
    fix.widthOverrides = [{ name: 'castle section T8-T12', from: [40.368589, 49.837431], to: [40.369393, 49.835656], halfW: 3.8, note: 'narrowest 7.6 m (en.wikipedia); ends at game T8 apex / T12 exit; exact per-corner widths not published' }];
    R.direction = { game: osm.direction.gameSense, real: 'anticlockwise', ok: true, source: 'en.wikipedia.org/wiki/Baku_City_Circuit: "anti-clockwise layout"' };
    R.startFinish = { game: osm.gameStart, osmStart: { id: 13826310746, name: 'Start Line', ll: [40.3725853, 49.8529141], beforeGameLineM: 31 }, osmFinish: { id: 13826310747, name: 'Finish Line', ll: [40.3721915, 49.8517072], beforeGameLineM: 142 },
      fia: 'FIA 2021 Azerbaijan GP event notes pit lane map (cache/web/fia-aze-p8.png): Control Line at the race-control end of the pit straight, pole further on - consistent with the two OSM nodes' };
    F.push({ aspect: 'start', severity: 'cosmetic', game: 'Line 31 m past the OSM "Start Line" node and 142 m past the "Finish Line" (control line) node.', real: 'OSM relation 11266687 start / finish nodes; FIA 2021 pit lane map.', proposedFix: "START_AT 'az-2016': [40.3725853, 49.8529141] (start line; the control line is 111 m earlier)", sources: [SRC.osm + ' nodes 13826310746, 13826310747', 'FIA 2021 Azerbaijan GP Race Directors\' Event Notes v2'] });
    fix.START_AT = [40.3725853, 49.8529141];
    R.pit = Object.assign(pitBlock(id), { real: { side: 'left', limitKmh: 80, limitSource: 'FIA 2021 Azerbaijan GP Race Directors\' Event Notes v2: no change to art. 22.10 (80 km/h) (cache/web/fia-2021-azerbaijan-gp-event-notes.pdf)', entry: 'from the main straight (FIA 2021 pit map; OSM way 1513267145 from gameS 5667)', exit: 'after Turn 1, inside the corner (FIA map; OSM gameS 251)' } });
    F.push({ aspect: 'pit', severity: 'minor', game: 'Lane 410 m: entry gameS 5838, exit gameS 74 - before Turn 1.', real: 'OSM "Pit Lane" (way 1513267145, 569 m, left): leaves at gameS 5667 (171 m earlier), runs inside Turn 1 and rejoins after it at gameS 251 (FIA 2021 pit lane map). Side left and 80 km/h correct.',
      proposedFix: 'pitEntryLL [40.371524,49.849646], pitExitLL [40.373934,49.854913] (new optional fields; the exit is beyond a 90-degree corner).', sources: [SRC.osm + ' way 1513267145', 'FIA 2021 Azerbaijan GP event notes'] });
    fix.pit = { side: 1, limitKmh: 80, entryLL: [40.371524, 49.849646], exitLL: [40.373934, 49.854913] };
    R.elevation = Object.assign(elevBase, { published: { rangeM: 26.8, highPoint: 'Turn 13', lowPoint: 'the sea front, "some 24 metres below sea level"', note: '"around Turn 8 - that the circuit narrows and takes the drivers uphill"', source: SRC.f1com2016 },
      demNote: 'Copernicus GLO-30 is not published for Azerbaijan (tile N40E049 404 on AWS). SRTM / ASTER are 30 m urban surface models (buildings of the old town): their ranges (36.9 / 42.1 m) and grades are not usable as truth here.',
      steepStretchesSrtmVsGame: steep });
    F.push({ aspect: 'elevation', severity: 'minor', game: `Range ${o.game.rangeM} m (high at T13 gameS ~3190, low at T1); T12->T13 climb +20 m, steepest ${o.game.grade100.climb.pct} %/100 m up, ${o.game.grade100.descent.pct} %/100 m down (after T15 towards T16).`,
      real: 'Published 26.8 m, high point at Turn 13, low point at the sea front ~24 m below sea level (F1.com 2016): shape right (high / low in the right places), total 7.6 m (28 %) too big - GLO-90 buildings in the old town.',
      proposedFix: 'Scale the profile to 26.8 m (factor 0.779) keeping its shape; no open lidar for Baku.', sources: [SRC.f1com2016, SRC.srtm, SRC.aster] });
    fix.elevation = { kind: 'scaleToRange', targetRangeM: 26.8, factor: r1(26.8 / o.game.rangeM * 1000) / 1000 };
    R.banking = Object.assign(bankSummary(id), { real: 'No banking published (city streets).', verdict: 'synthetic only: 13 street corners banked 4.5-5.8 deg, unverified' });
    F.push({ aspect: 'banking', severity: 'cosmetic', game: '13 corners (90-degree street junctions incl. the castle section) banked 4.5-5.8 deg inward.', real: 'Public city streets; no banking reported (en/de.wikipedia infobox empty). Not measurable from the available DEMs.', proposedFix: 'Optional per-track bank scale (~0.3-0.4) for street circuits or bankOverrides deg 0 on the junction corners.', sources: ['en.wikipedia.org/wiki/Baku_City_Circuit', 'de.wikipedia.org/wiki/Baku_City_Circuit'] });
    R.coveredAndBridges = crossBlock(id, 'No tunnel or covered section on the lap. OSM: permanent footbridges over the track at gameS ~244 (after T1, way 1425935015) and ~5574 (main straight, way 715443013); several pedestrian underpasses below it. The game has neither footbridge.');
    F.push({ aspect: 'bridge', severity: 'cosmetic', game: 'No structure over the track except the start gantry.', real: 'Two permanent footbridges cross the track (OSM ways 1425935015 at gameS ~244, 715443013 at gameS ~5574).', proposedFix: 'Add as bridge decks in build-scenery (they are highway=footway bridge=yes, not man_made=bridge, so the current scenery query misses them).', sources: [SRC.osm] });
    R.verdict = 'major issues';
  }
  R.findings = F;
  R.proposedCorrections = fix;
  R.profile50 = { along: 'OSM loop, s true metres from the game start', columns: Object.keys(o.profile50[0]), rows: o.profile50.map((r) => Object.values(r)) };
  return R;
}

for (const id of IDS) {
  const R = await build(id);
  writeFileSync(resolve(OUT, `${id}.json`), JSON.stringify(R, null, 1));
  console.log(id, R.verdict, R.findings.length, 'findings');
}
