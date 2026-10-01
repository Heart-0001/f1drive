// node devtests/track-audit/west/make-reports.mjs
// Assembles devtests/track-audit/<id>.json for the west-European batch (mc-1929, fr-1960, fr-1969, es-1991, es-2026)
// from the measurements in devtests/track-audit/west/res/ (written by the scripts next to this file) and the sourced
// reference facts below. Re-run after re-running any measurement.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE } from './net.mjs';

const RES = (f) => JSON.parse(readFileSync(resolve(HERE, 'res', f), 'utf8'));
const OUTDIR = resolve(HERE, '..');
const AUDITED = '2026-10-01';

// ---------------------------------------------------------------- sources
const SRC = {
  osm: 'OpenStreetMap (ODbL), Overpass API queries cached in devtests/track-audit/cache/overpass/ (fetched 2026-10-01)',
  ign: 'IGN RGE ALTI 1-5 m bare-earth DEM via https://data.geopf.fr/altimetrie (resource ign_rge_alti_wld), sampled every 5 m on the OSM centreline; cache devtests/track-audit/cache/ignalti/',
  mdt05: 'IGN Espana / CNIG MDT05 (5 m DTM from PNOA-LiDAR) via the INSPIRE WCS https://servicios.idee.es/wcs-inspire/mdt (coverage Elevacion4258_5, served in whole metres), bilinear every 5 m on the OSM centreline; tiles in devtests/track-audit/cache/ign-es/',
  srtm: 'SRTM 30 m (OpenTopoData srtm30m) on the game centreline, cache devtests/track-fix/cache/otd-srtm30m.json (no new requests)',
  glo90: 'Copernicus GLO-90 (the game\'s own source) cache tools/elevation-cache.json',
  wMonaco: 'https://en.wikipedia.org/wiki/Circuit_de_Monaco (wikitext fetched 2026-10-01: length 3.337 km; Avenue d\'Ostende "maximum gradient ... around 12%"; Casino Square "44 m higher than the lowest part"; tunnel)',
  wMagny: 'https://en.wikipedia.org/wiki/Circuit_de_Nevers_Magny-Cours (fetched 2026-10-01: Grand Prix Circuit 2003-present 4.411 km, 17 turns; French GP 1991-2008)',
  wRicard: 'https://en.wikipedia.org/wiki/Circuit_Paul_Ricard (fetched 2026-10-01: layout 1C-V2 with Mistral chicane 5.842 km; 1A-V2 without 5.770 km; "In 2019 the pitlane entry was moved ... now situated between the final two corners (turns 14 and 15)"; "very flat")',
  wBarcelona: 'https://en.wikipedia.org/wiki/Circuit_de_Barcelona-Catalunya (fetched 2026-10-01: GP without chicane 2021-present 4.657 km; with chicane 2021-present 4.675 km; 2007-2020 4.655 km; "From the 2023 Spanish Grand Prix, Formula One stopped using the 2007 chicane")',
  wMadring: 'https://en.wikipedia.org/wiki/Madring (fetched 2026-10-01: length 5.414 km, 22 turns; La Monumental "no more than 13.5 degrees of banking" / "not to exceed a 24% gradient" (Formula1.com 20 June 2026); "Two tunnel sections running underneath an elevated motorway" (Formula1.com 2024-01-23); "sharp downhill drop between Turns 7 and 9")',
  wSpGP26: 'https://en.wikipedia.org/wiki/2026_Spanish_Grand_Prix (fetched 2026-10-01: course 5.414 km, 57 laps, 308.399 km)',
  madring: 'https://www.madring.com/en/circuit (read 2026-10-01: track length 5.4 km, 22 turns; highest point 697 m at Turn 7, lowest 671 m at Turn 2; Turn 6 "8% uphill section" gaining "10 meters", Turn 7/8 "5% downhill gradient"; per-turn length / angle / banking %, Turn 12 La Monumental 547.82 m, banking 24%; Turn 18 "just outside the tunnel connecting Valdebebas with IFEMA")',
  fiaMonaco: 'FIA, 2026 Monaco Grand Prix, Infringement - Car 12 - Pit lane speeding: "the pit lane speed limit which is set at 60 km/h for the event" (https://www.fia.com/system/files/decision-document/2026_monaco_grand_prix_-_infringement_-_car_12_-_pit_lane_speeding.pdf, via web search 2026-10-01)',
  fiaSpain: 'FIA, 2026 Spanish Grand Prix, Document 68, Car 10 pit lane speeding: "the pit lane speed limit which is set at 80 km/h for this event" (https://www.fia.com/system/files/decision-document/2026_spanish_grand_prix_-_infringement_-_car_10_-_pit_lane_speeding.pdf, cached devtests/track-audit/cache/fia/)',
  autosport: 'Autosport, 2 May 2025, "FIA to raise pit lane speed limit at select F1 grands prix": standard limit 80 km/h; 60 km/h only at Melbourne, Monaco, Zandvoort and Singapore (https://www.autosport.com/f1/news/fia-to-raise-pit-lane-speed-limit-at-select-f1-grands-prix/10718694/)',
  dataset: 'bacinger/f1-circuits @432a253 (copy devtests/track-audit/latam-za/ref/f1-circuits-432a253.geojson): properties.length per circuit',
};

const L = { mc: RES('layout-mc-1929.json'), fr60: RES('layout-fr-1960.json'), fr69: RES('layout-fr-1969-1cv2.json'), fr69a: RES('layout-fr-1969.json'),
  es91: RES('layout-es-1991.json'), es91c: RES('layout-es-1991-chicane.json'), es26: RES('layout-es-2026.json') };
const P = { mc: RES('profile-mc-1929-ignalti.json'), fr60: RES('profile-fr-1960-ignalti.json'), fr69: RES('profile-fr-1969-1cv2-ignalti.json'),
  es91: RES('profile-es-1991-mdt05.json'), es26: RES('profile-es-2026-mdt05.json') };
const G = { mc: RES('game-summary-mc-1929.json'), fr60: RES('game-summary-fr-1960.json'), fr69: RES('game-summary-fr-1969.json'),
  es91: RES('game-summary-es-1991.json'), es26: RES('game-summary-es-2026.json') };

const brief = (o) => { const { profile, ...b } = o; return b; };
const layoutBrief = (o) => ({ osmRelation: o.osmRelation, osmLength: o.osmLength, gameBuiltLength: o.gameBuiltLength, gameLengthKm: o.gameLengthKm,
  gameToOsm: o.gameToOsm, osmToGame: o.osmToGame });
// 10 m profile on the OSM line: [lat, lon, real h above the lap's lowest point, game h (same datum offset)], from the 5 m one
function profile10(o) {
  const p = o.profile, out = [], min = Math.min(...p.real);
  for (let i = 0; i < p.real.length; i += 2) {
    const ll = latlonOf(o, i);
    out.push([ll[0], ll[1], +(p.real[i] - min).toFixed(2), +(p.game[i] - min).toFixed(2), p.gameS[i]]);
  }
  return out;
}
function latlonOf(o, i) {
  // profile.json does not store lat/lon per sample: rebuild from the OSM loop at the same arc length
  const loop = RES('osm-loop-' + o.id + '.json').loop;
  if (!latlonOf.cache[o.id]) {
    const R = 6371008.8, d = Math.PI / 180, cum = [0];
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      const dy = (b[0] - a[0]) * d * R, dx = (b[1] - a[1]) * d * R * Math.cos(a[0] * d);
      cum.push(cum[k] + Math.hypot(dx, dy));
    }
    latlonOf.cache[o.id] = { loop, cum };
  }
  const { loop: Lp, cum } = latlonOf.cache[o.id], s = o.profile.osmS[i] / o.osmLength * cum[cum.length - 1];
  let k = 0; while (k < Lp.length - 1 && cum[k + 1] <= s) k++;
  const a = Lp[k], b = Lp[(k + 1) % Lp.length], t = (s - cum[k]) / ((cum[k + 1] - cum[k]) || 1);
  return [+(a[0] + (b[0] - a[0]) * t).toFixed(6), +(a[1] + (b[1] - a[1]) * t).toFixed(6)];
}
latlonOf.cache = {};

const F = (aspect, severity, game, real, proposedFix, sources) => ({ aspect, game, real, severity, proposedFix, sources });

// ======================================================================= mc-1929
const mc = {
  id: 'mc-1929', name: 'Circuit de Monaco', audited: AUDITED, verdict: 'major issues',
  layoutNote: 'Current Grand Prix layout (2015-present, Tabac re-profiled, 3.337 km); the 2010-2014 seasons used the 3.340 km version (3 m longer at Tabac).',
  measurements: {
    layout: layoutBrief(L.mc), datasetGeodesicLengthM: 3324.3, buildScale: 1.00644,
    direction: 'clockwise; OSM oneway members of relation 148194 run with the game direction (746 m with, 108 m against = the U-shaped pit lane)',
    start: 'game points[0] is 0.1 m from OSM node 4937755860 "Monaco Grand Prix Start/Finish Line"',
    pit: { game: { side: 'right (-1)', limitKmh: 60, entryS: 3202.3, exitS: 94, laneLengthM: 390 },
      osm: { way: 850261588, exitWay: 1388331347, side: 'right', entryS: 2972, entryLatLon: [43.7323832, 7.4229757], laneEndS: 26, exitMergeS: 268, exitMergeLatLon: [43.7370216, 7.4221175],
        note: 'enters between La Rascasse and Anthony Noghes, runs along the harbour, its exit lane follows the yellow line through Sainte Devote and merges on Avenue d\'Ostende' } },
    elevation: { source: SRC.ign, osmLine: brief(P.mc), game: { range: G.mc.yRange, g50: G.mc.g50, g100: G.mc.g100 },
      beauRivage: { rawMaxPct: { '10m': 20.4, '20m': 15.6, '50m': 11.5, '100m': 10.6 }, cleanMaxPct: { '20m': 10.4, '50m': 10.0, '100m': 9.5 }, gameMaxPct: { '20m': 9.6, '50m': 9.2, '100m': 9.0 },
        published: 'around 12% (Wikipedia)' },
      published: { rangeM: 44, source: SRC.wMonaco }, measuredRangeM: P.mc.realRange,
      tunnelNote: 'IGN reads the hotel ground above the tunnel (up to 24 m); taken straight between the portals (7.6 -> 7.3 m ASL), as the game does (build-tracks COVERED)' },
    hairpin: { gameMinRadiusM: 9.6, gameRadiusAt12mChordM: [9.8, 11.3, 10.3], osmCentrelineMinRadiusM: 8.9, gameHalfWidthM: 6.9, gameBankDeg: -5.95, gameGradePct: -5.8,
      note: 'centreline geometry agrees with OSM within 0.7 m of radius; the car cannot take it because of js/car.js steering lock (v6-plan: 10 m minimum turning radius at 10 km/h), not because of the track data' },
    banking: { gameMaxAbsDeg: G.mc.bankMaxAbs, gameSectionsOver3deg: G.mc.bank3.length, real: 'no banked corners published (street circuit)' },
    covered: [
      { name: 'Tunnel (Boulevard Louis II under the Fairmont hotel)', osmWays: [4230891, 1230247123], gameS: [1514, 1888], lengthM: 362,
        from: [43.740362, 7.430326], to: [43.737778, 7.427973], inGame: 'elevation bridged (COVERED) but no tunnel geometry: open sky; js/tunnels.js (v6.2 prep, not wired) has this stretch' },
      { name: 'Portier covered roundabout (OSM raceway way 1470365907, tunnel=yes, layer -1) with Boulevard du Larvotto on a bridge over the circuit (way 92627405)', gameS: [1412, 1430], lengthM: 18,
        from: [43.741073, 7.430032], to: [43.741089, 7.430253], inGame: 'nothing; js/tunnels.js (prep) lists a "Portier underpass"' },
      { name: 'footpath bridge over the track near Anthony Noghes (OSM way 167625745)', gameS: [3048, 3048], inGame: 'no' },
    ],
  },
  findings: [
    F('tunnel', 'major', 'No tunnel: the 362 m stretch under the Fairmont hotel (game s 1514-1888) is open road under the sky; only its elevation is bridged (flat 7.6 -> 7.4 m).',
      'Covered from the Portier exit to the Nouvelle Chicane approach: OSM way 4230891 "Boulevard Louis II" tunnel=yes layer -1 (356 m) + way 1230247123 (6 m), portals [43.740362, 7.430326] -> [43.737778, 7.427973]; partly open to the sea on the left (Wikipedia: the tunnel is "a unique feature").',
      'Wire js/tunnels.js (already holds this stretch: from [43.740362, 7.430326] to [43.737778, 7.427973], open side +1) into main.js / audio (lighting + reverb), as planned for v6.2.', [SRC.osm + ': ways 4230891, 1230247123, 450334964 (footway in the tunnel)', SRC.wMonaco]),
    F('tunnel', 'minor', 'Nothing at Portier.', 'OSM (2026) maps the circuit through an 18 m covered section at the Portier roundabout (raceway way 1470365907 tunnel=yes layer -1, game s 1412-1430) with Boulevard du Larvotto passing over it on a bridge (way 92627405, crosses at game s 1406).',
      'Keep the "Portier underpass" entry of js/tunnels.js (from [43.741060, 7.429974] to [43.741084, 7.430250]).', [SRC.osm + ': ways 1470365907, 92627405, 353889280']),
    F('pit', 'minor', 'Generic 390 m lane beside the start straight: entry line at s 3202 (124 m before the line, after Anthony Noghes), exit at s 94; side right; 60 km/h.',
      'Right side and 60 km/h are correct (FIA 2026). Real lane (OSM way 850261588) leaves the track at s 2972, between La Rascasse and Anthony Noghes ([43.7323832, 7.4229757]), and the exit lane (way 1388331347) rejoins after Sainte Devote at s 268 ([43.7370216, 7.4221175]).',
      'Optional: trackData.pitEntry / pitExit points (new fields) so js/track.js can start the lane before Anthony Noghes and end it after Sainte Devote; until then keep side -1, 60 km/h.', [SRC.osm + ': ways 850261588, 1388331347', SRC.fiaMonaco]),
    F('gradient', 'minor', 'Beau Rivage (Avenue d\'Ostende) climb: max 9.2 % over 50 m, 9.0 % over 100 m (s 335-529).',
      'IGN lidar on the OSM line: 10.0 % over 50 m and 9.5 % over 100 m after cleaning, 11.5 % over 50 m raw; published "around 12%". The rest of the profile matches within 0.8 m (RMS 0.23 m), range 41.8 m (game 41.3, published 44).',
      'Optional: use the DTM median of 30 m instead of 50 m (DTM_MEDIAN_HALF 1 for mc-1929) to keep ~1 pp more of the Beau Rivage grade; no other elevation change needed.', [SRC.ign, SRC.wMonaco]),
    F('banking', 'minor', `Curvature-derived banking 4-6 deg (inside low) at every slow corner: Sainte Devote 5.3, Mirabeau 5.8, Fairmont hairpin 5.95, Portier 5.7, Nouvelle Chicane 5.5, Rascasse 5.9, Anthony Noghes 5.5 deg (${G.mc.bank3.length} sections above 3 deg).`,
      'No banking published for any Monaco corner (city streets with ordinary road crossfall).',
      'Cap the derived banking on street circuits (e.g. trackData.bankMax = 2 deg for mc-1929) or lower BANK_MAX globally; the hairpin would then also lose its 6 deg inward roll.', [SRC.wMonaco]),
    F('other', 'minor', 'Fairmont hairpin: centreline radius 9.6-9.8 m (12 m chord), half width 6.9 m, grade -5.8 %, bank -5.95 deg.',
      'OSM centreline radius 8.9 m at the same place; the data is correct. The "cannot take the hairpin at 20 km/h" complaint comes from js/car.js (minimum turning radius 10 m at 10 km/h).',
      'No track-data change; fix the steering lock law (v6.2). Lowering the derived 6 deg bank there (above) also helps.', [SRC.osm + ': relation 148194 ways 4230007 / 568187257']),
    F('length', 'cosmetic', 'lengthKm 3.337; the dataset line measures 3324 m (geodesic) and is scaled by 1.0064.', '3.337 km since 2015 (3.340 km 2010-2014); OSM centreline 3331.6 m.', 'None.', [SRC.wMonaco, SRC.dataset]),
  ],
  proposedCorrections: {
    tunnels: [
      { name: 'Tunnel', kind: 'tunnel', from: [43.740362, 7.430326], to: [43.737778, 7.427973], openSide: 1, source: 'OSM ways 4230891 + 1230247123 (already in js/tunnels.js prep data)' },
      { name: 'Portier', kind: 'underpass', from: [43.741073, 7.430032], to: [43.741089, 7.430253], source: 'OSM raceway way 1470365907 (tunnel=yes) + bridge way 92627405 over it' },
    ],
    pitFacts: { side: -1, limitKmh: 60, realEntry: [43.7323832, 7.4229757], realExitMerge: [43.7370216, 7.4221175] },
    banking: { bankMaxDeg: 2, why: 'no banked corners; derived 6 deg is invented' },
    elevation: 'keep ignalti (matches lidar on the OSM line within 0.8 m); optional DTM_MEDIAN_HALF 1 for Beau Rivage',
  },
};

// ======================================================================= fr-1960
const fr60 = {
  id: 'fr-1960', name: 'Circuit de Nevers Magny-Cours', audited: AUDITED, verdict: 'minor issues',
  layoutNote: 'Grand Prix circuit 2003-present (4.411 km, the last F1 layout; French GP 1991-2008). Not on any 2010-2026 calendar.',
  measurements: {
    layout: layoutBrief(L.fr60), datasetGeodesicLengthM: 4458.5, buildScale: 0.99361,
    lengthNote: 'the dataset line and the OSM GP way 63951656 (tagged "4 411 m pour la piste Grand Prix") agree within 2.4 m and both measure ~4458 m; the build shrinks the circuit by 0.64 % to the official 4.411 km',
    direction: 'clockwise; OSM oneway way 63951656 (4411 m) and pit lane 195975305 run with the game direction',
    start: 'no start-finish node in OSM; points[0] lies on the pit straight between the OSM pit lane ends (cosmetic, unverified)',
    pit: { game: { side: 'left (+1)', limitKmh: 80, entryS: 4270.9, exitS: 92, laneLengthM: 404 },
      osm: { way: 195975305, side: 'left', entryS: 4135, entryLatLon: [46.862807, 3.1607953], exitMergeS: 478, exitMergeLatLon: [46.8676721, 3.1656763], laneLengthM: 728 } },
    elevation: { source: SRC.ign, osmLine: brief(P.fr60), game: { range: G.fr60.yRange, g50: G.fr60.g50, g100: G.fr60.g100 } },
    banking: { gameMaxAbsDeg: G.fr60.bankMaxAbs, gameSectionsOver3deg: G.fr60.bank3.length, real: 'no banking published' },
    covered: [
      { name: 'footbridge', osmWay: 199007717, gameS: 18 }, { name: 'footbridge', osmWay: 199007702, gameS: 1408 },
      { name: 'footbridge (spans two parts of the track)', osmWay: 820455063, gameS: [2035, 2999] }, { name: 'service road bridge', osmWay: 199007695, gameS: 3726 },
    ],
  },
  findings: [
    F('pit', 'minor', 'Lane on the left (side +1), entry line s 4271, exit s 92, 404 m long, 80 km/h.',
      'OSM pit lane (way 195975305, relation 11249753 role pit_lane) is on the left; it leaves the track at s 4135 before the Lycee chicane ([46.862807, 3.1607953]) and rejoins at s 478 ([46.8676721, 3.1656763]), 728 m long.',
      'Side is correct. Optional pitEntry / pitExit points as for Monaco. Limit: no 2010-2026 F1 event; keep 80.', [SRC.osm + ': way 195975305, relation 11249753']),
    F('banking', 'minor', `Derived banking up to ${G.fr60.bankMaxAbs} deg: s 1638 (Adelaide hairpin) 5.9, s 3407-3475 5.7, s 4017-4055 5.7, s 2437-2573 5.2, final chicane s 4127-4181 5.1 deg.`, 'No banked corners published.',
      'Same global cap as Monaco (2-3 deg) for circuits without published banking.', [SRC.wMagny]),
    F('bridge', 'cosmetic', 'No bridges over the track.', 'OSM: footbridges cross over the track at s 18, 1408, 2035 and 2999 (ways 199007717, 199007702, 820455063) and a service-road bridge at s 3726 (way 199007695).',
      'Optional: draw them as gantries (js/scenery.js only draws man_made=bridge areas).', [SRC.osm]),
    F('length', 'cosmetic', 'lengthKm 4.412 (circuit scaled by 0.9936).', 'Official 4.411 km; the OSM GP centreline measures 4457.8 m.', 'None (keep the official length).', [SRC.wMagny, SRC.osm + ': way 63951656']),
    F('elevation', 'cosmetic', `Range ${G.fr60.yRange} m; max climb 3.8 % / descent -4.1 % over 100 m.`,
      `IGN lidar on the OSM line: range ${P.fr60.realRange} m, +4.0 / -4.2 % over 100 m, residual RMS ${P.fr60.residualRms} m: matches.`, 'None.', [SRC.ign]),
  ],
  proposedCorrections: { pitFacts: { side: 1, limitKmh: 80, realEntry: [46.862807, 3.1607953], realExitMerge: [46.8676721, 3.1656763] }, banking: { bankMaxDeg: 3 }, elevation: 'keep ignalti', layout: 'keep' },
};

// ======================================================================= fr-1969
const fr69 = {
  id: 'fr-1969', name: 'Circuit Paul Ricard', audited: AUDITED, verdict: 'minor issues',
  layoutNote: 'F1 layout 1C-V2 with the Mistral chicane (5.842 km), French GP 2018, 2019, 2021, 2022.',
  measurements: {
    layout: Object.assign(layoutBrief(L.fr69), { reference: 'OSM relation 13545643 "Grand Prix automobile de France" is the 1A-V2 (no chicane) loop: 5764.5 m vs 5.770 km published; with OSM way 229454180 "Chicane Nord" spliced in: 5846.3 m vs 5.842 km published',
      withoutChicane: { gameToOsmMaxM: L.fr69a.gameToOsm.maxM, at: L.fr69a.gameToOsm.runsOver8m } }),
    datasetGeodesicLengthM: 5818.0, buildScale: 1.00551,
    direction: 'clockwise; all oneway members of relation 13545643 (6511 m) run with the game direction (REVERSED_IN_DATASET is right)',
    start: { game: [43.2520204, 5.7915716], osmNode: 2255501646, osmNodeLatLon: [43.251187, 5.7930593], osmNodeGameS: 5687, note: 'the OSM raceway=start-finish node lies 152 m before the game line, mid main grandstand; not verified against an FIA map' },
    pit: { game: { side: 'right (-1)', limitKmh: 80, entryS: 5674.7, exitS: 164, laneLengthM: 500 },
      osm: { way: 799477739, note: 'tagged "Modified for the 2019 F1 Grand Prix."', side: 'right', entryS: 5211, entryLatLon: [43.2506981, 5.7968856], exitMergeS: 340, exitMergeLatLon: [43.25385, 5.788233] } },
    elevation: { source: SRC.ign, osmLine: brief(P.fr69), game: { range: G.fr69.yRange, g50: G.fr69.g50, g100: G.fr69.g100 },
      underpass: 'the track crosses over service tunnels (OSM ways 284183359 / 284183360, layer -1) at game s ~5490-5520: the DTM has the deck removed (raw 421.3 m vs 426.8 m around, a 5.5 m notch); the game keeps a 1.9 m dip (min 424.95 at s 5535) with -2.4 % / +1.1 % grades where the road is level' },
    banking: { gameMaxAbsDeg: G.fr69.bankMaxAbs, gameSectionsOver3deg: G.fr69.bank3.length, real: 'no banking published; "very flat" plateau circuit' },
    covered: [
      { name: 'Passerelle Sud (footbridge)', osmWay: 242947741, gameS: 143 }, { name: 'Passerelle Pinede (footbridge)', osmWay: 1107731474, gameS: 284 },
      { name: 'Passerelle Nord (footbridge)', osmWay: 686698872, gameS: 2639 }, { name: 'service underpass below the track', osmWays: [284183359, 284183360], gameS: [5491, 5523] },
    ],
  },
  findings: [
    F('layout', 'minor', 'Mistral chicane: the game stays on the straight until s 2810 and then turns left (R 21 m) and right (R 24 m).',
      'OSM "Chicane Nord" (way 229454180) leaves the Mistral 110 m earlier with a right-hand bulge 36 m off the straight (s 2702-2818) before the same left-right; with it the OSM loop is 5846 m = the published 5.842 km, while the dataset line is 5818 m and the build stretches the whole circuit by 0.55 % to reach 5.842.',
      'Replace the dataset points between [43.254156, 5.791693] (game s 2700) and [43.253813, 5.792959] (s 2810) with OSM way 229454180\'s first part; then the length rescale drops to ~1.000.', [SRC.osm + ': relation 13545643, way 229454180', SRC.wRicard]),
    F('pit', 'minor', 'Entry line on the main straight (s 5675, 164 m before the line), exit s 164; right side; 80 km/h.',
      'Since 2019 the pit entry is "between the final two corners (turns 14 and 15)" (Wikipedia); OSM way 799477739 ("Modified for the 2019 F1 Grand Prix") leaves the track at s 5211 ([43.2506981, 5.7968856]) and rejoins at s 340 ([43.25385, 5.788233]). Right side and 80 km/h are correct.',
      'Optional pitEntry / pitExit points; keep side -1, 80.', [SRC.osm + ': way 799477739', SRC.wRicard, SRC.autosport]),
    F('elevation', 'minor', 'A 1.9 m dip with -2.4 % / +1.1 % grades at s 5470-5600 (Virage du Pont).',
      'The road is level there (426.8-427 m ASL); the dip comes from the DTM notch where the track bridges a service underpass (OSM ways 284183359 / 284183360, layer -1).',
      'COVERED["fr-1969"] = [{ name: "bridge over the service underpass (Virage du Pont)", from: [43.2500184, 5.7951677], to: [43.2503472, 5.7945838], pad: 10 }]', [SRC.ign, SRC.osm + ': ways 284183359, 284183360']),
    F('start', 'minor', 'Start / finish at the dataset\'s first vertex [43.2520204, 5.7915716].',
      'OSM node 2255501646 raceway=start-finish is at [43.251187, 5.7930593], 152 m earlier (game s 5687). Not confirmed by an FIA document.',
      'Check against the FIA event map before moving; if confirmed START_AT["fr-1969"] = [43.251187, 5.7930593].', [SRC.osm + ': node 2255501646']),
    F('banking', 'minor', `Derived banking up to ${G.fr69.bankMaxAbs} deg (e.g. Virage du Pont 5.9, Virage du Camp 5.8 deg).`, 'No banking published ("very flat").', 'Global cap 2-3 deg for unbanked circuits.', [SRC.wRicard]),
    F('bridge', 'cosmetic', 'No footbridges.', 'Three footbridges cross over the track: Passerelle Sud (s 143), Passerelle Pinede (s 284), Passerelle Nord (s 2639) (OSM ways 242947741, 1107731474, 686698872).', 'Optional gantry-like footbridges.', [SRC.osm]),
  ],
  proposedCorrections: {
    covered: [{ name: 'bridge over the service underpass (Virage du Pont)', from: [43.2500184, 5.7951677], to: [43.2503472, 5.7945838], pad: 10 }],
    layout: { replaceBetween: [[43.254156, 5.791693], [43.253813, 5.792959]], withOsmWay: 229454180, note: 'Mistral chicane entry bulge' },
    startAt: { candidate: [43.251187, 5.7930593], status: 'unverified (OSM only)' },
    pitFacts: { side: -1, limitKmh: 80, realEntry: [43.2506981, 5.7968856], realExitMerge: [43.25385, 5.788233] },
    banking: { bankMaxDeg: 3 },
  },
};

// ======================================================================= es-1991
const es91 = {
  id: 'es-1991', name: 'Circuit de Barcelona-Catalunya', audited: AUDITED, verdict: 'major issues',
  layoutNote: 'The game has the 2023-present F1 layout without the final chicane (4.657 km). Seasons 2010-2020 used the 4.655 km layout with the RACC chicane and the old La Caixa (T10); 2021-2022 the 4.675 km layout with the chicane and the new T10.',
  measurements: {
    layout: Object.assign(layoutBrief(L.es91), { withChicaneRelation: { relation: L.es91c.osmRelation, osmLength: L.es91c.osmLength, gameToOsmMaxM: L.es91c.gameToOsm.maxM, runs: L.es91c.gameToOsm.runsOver8m } }),
    datasetGeodesicLengthM: 4664.3, buildScale: 1.00063,
    direction: 'clockwise; oneway members of relation 284540 (5710 m) all run with the game direction',
    start: 'game points[0] is 0.3 m from OSM node 385973430 raceway=start (relation 284540 role start); the relation\'s finish node 14202158171 lies 124 m earlier (game s 4530)',
    pit: { game: { side: 'right (-1)', limitKmh: 80, entryS: 4490.1, exitS: 164, laneLengthM: 500 },
      osm: { ways: [33742214, 178416729, 178416733], side: 'right', entryS: 4092, entryLatLon: [41.5741808, 2.2625147], exitMergeS: 494, exitMergeLatLon: [41.5662607, 2.2580545], laneLengthM: 1036 } },
    elevation: { source: SRC.mdt05, osmLine: brief(P.es91), game: { source: 'glo90', range: G.es91.yRange, g50: G.es91.g50, g100: G.es91.g100 },
      crossCheck: { srtm30RangeM: 33.8, glo90RawRangeM: 38.0, note: 'both surface models (grandstands, trees) give a larger range than the lidar DTM',
        eudem25m: 'OpenTopoData eudem25m every 50 m (west/xcheck-eudem.mjs, cache/opentopodata/eudem25m.json): T2 (s 750) 114.7 -> s 1000 123.5 -> s 1251 130.3 -> s 1701 134.4 m: it also climbs where the game descends (s 1000-1251: game -5.8 m, lidar +6.0 m, EU-DEM +6.8 m)' },
      keyPoints: { T2_lowest: 'lidar 112.6 m ASL at s ~730; game lowest 111.7 at s 550', T3: 'lidar 121.9 m at s 1000 vs game 127.7 (+5.8); lidar 127.9 at s 1251 vs game 121.9 (-6.0)', T12_T13: 'lidar 142.0 at s 3753 vs game 146.5 (+4.5)' } },
    banking: { gameMaxAbsDeg: G.es91.bankMaxAbs, gameSectionsOver3deg: G.es91.bank3.length, real: 'no banking published' },
    covered: [
      { name: 'footbridge', osmWay: 178416735, gameS: 1514 }, { name: 'footbridge', osmWay: 178416725, gameS: 2197 },
      { name: 'tunnels under the track (service / footway)', osmWays: [33742533, 151597859, 1530387851, 1180180054, 151597862, 33742298], gameS: [137, 467, 472, 1915, 2350, 2939] },
    ],
  },
  findings: [
    F('elevation', 'major', `GLO-90 surface model: range ${G.es91.yRange} m; a crest at Turn 3 (s 900-1050 climbs 8.6 % over 100 m to 127.7 m) followed by a 5.8 m DESCENT into Turn 4 (s 1000-1251); T12-T13 4.5 m too high.`,
      `IGN-ES MDT05 lidar DTM on the OSM line: range ${P.es91.realRange} m (112.6 m at T2 to 142 m at T12-T13); the road climbs steadily (2.2 % average, 4.7 % peak over 100 m) from T2 (112.6 m, s 750) through Turn 3 to the exit of Turn 4 (134 m, s 1701) - no crest at T3, no dip at T4. Max grades +6.1 % (s 2531-2631, up to Campsa) / -6.2 % (s 2036-2136); 11 stretches where the game's 100 m grade differs by more than 2 pp. Residual RMS ${P.es91.residualRms} m, worst ${P.es91.residualMax} m at s ${P.es91.residualMaxAtGameS}.`,
      'ELEV_SOURCE["es-1991"] = "ignes-mdt05": new SOURCES entry (WCS GetCoverage Elevacion4258_5 for the bbox, bilinear, DTM processing step 10 m / median 50 m / gauss 20 m); or apply proposedCorrections.elevationProfile10m (lidar profile on the OSM line, metres above the lowest point).', [SRC.mdt05, SRC.srtm, SRC.glo90, SRC.osm + ': relation 284540']),
    F('layout', 'minor', 'One layout for every season: the 2023-present one (no final chicane); game vs OSM relation 284540 mean 0.24 m, max 1.0 m.',
      'F1 used the 4.655 km layout with the RACC chicane (and the old La Caixa) 2007-2020 and the 4.675 km layout with the chicane 2021-2022; the "with chicane" OSM relation 2049529 departs from the game by up to 43 m at s 3928-4066.',
      'Optional: a per-season layout variant (chicane from OSM relation 2049529 ways 1560896062/63/67/68) for 2010-2022; otherwise keep and note it.', [SRC.wBarcelona, SRC.osm + ': relations 284540, 2049529']),
    F('pit', 'minor', 'Entry line s 4490, exit s 164 (500 m lane); right side; 80 km/h.',
      'Right side and 80 km/h are correct. OSM: "Entrada al Pit Lane" (way 33742214) leaves the track at s 4092 ([41.5741808, 2.2625147]) right after the last corner; "Sortida del Pit Lane" (way 178416733) rejoins at s 494 ([41.5662607, 2.2580545]) before Turn 1; ~1036 m in all.',
      'Optional pitEntry / pitExit points; keep side -1, 80.', [SRC.osm + ': ways 33742214, 178416729, 178416733', SRC.autosport]),
    F('banking', 'minor', `Derived banking up to ${G.es91.bankMaxAbs} deg (inside low): s 690-748 (T1) 5.1, s 1960-2050 5.3, s 2402-2460 5.2, s 3338-3432 (La Caixa) 5.6 deg.`, 'No banking published for Barcelona-Catalunya.', 'Global cap 2-3 deg for unbanked circuits.', [SRC.wBarcelona]),
    F('bridge', 'cosmetic', 'No footbridges.', 'Footbridges cross over the track at s 1514 and 2197 (OSM ways 178416735, 178416725).', 'Optional.', [SRC.osm]),
  ],
  proposedCorrections: {
    elevationSource: { id: 'ignes-mdt05', wcs: 'https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion4258_5&SUBSET=Lat(41.56148,41.57745)&SUBSET=Long(2.24852,2.26728)&FORMAT=image/tiff',
      note: 'one GeoTIFF per circuit (~300 kB), int16 whole metres -> bilinear + the DTM cleaning; licence CC BY 4.0 (CNIG / IGN Espana, scne.es)' },
    elevationProfile10m: { format: '[lat, lon, real m above the lap minimum, game m on the same datum, game s]', points: profile10(P.es91) },
    pitFacts: { side: -1, limitKmh: 80, realEntry: [41.5741808, 2.2625147], realExitMerge: [41.5662607, 2.2580545] },
    banking: { bankMaxDeg: 3 },
  },
};

// ======================================================================= es-2026
const bank26 = RES('madring-bank.json');
const es26 = {
  id: 'es-2026', name: 'Circuito de Madring', audited: AUDITED, verdict: 'major issues',
  layoutNote: 'New for 2026 (Spanish GP, 13 September 2026). OSM relation 18813472 still has several ways tagged construction=raceway.',
  measurements: {
    layout: layoutBrief(L.es26), datasetLengthProperty: 5474, datasetGeodesicLengthM: 5430.3, buildScale: 1.01112,
    lengthNote: 'bacinger gives length 5474; the official length is 5.414 km (Wikipedia infobox, 2026 Spanish GP: 57 laps = 308.399 km). The dataset geometry itself is ~5415-5430 m long, so the build STRETCHES the circuit by 1.1 % to the wrong 5474.',
    corners: 'the game corner sequence (angle / length) matches the official 22 turns (T1 79/77.5 deg, T10 52/57.6, T12 233 deg over 502 m vs 547.8 m, T15 90/90 over 214/209.7 m, T20 114/117.5, T22 87/90.8); T4 (official 70.9 deg over 432.6 m) is only ~34 deg in both the game and OSM',
    direction: 'clockwise; relation members (5126 m) run with the game direction (two ways, 350 m, carry a "forward" role against their drawing)',
    start: 'no start node in OSM; official "just over 200 m" from the line to Turn 1: game T1 apex at s ~198',
    pit: { game: { side: 'right (-1)', limitKmh: 80, entryS: 5312.3, exitS: 96, laneLengthM: 432 },
      osm: { way: 1552567031, side: 'right', entryS: 4950, entryLatLon: [40.4668009, -3.6121166], exitMergeS: 474, exitMergeLatLon: [40.4649706, -3.6214382], laneLengthM: 903 } },
    elevation: { source: SRC.mdt05 + ' (tunnels taken straight between their portals)', osmLine: brief(P.es26), game: { source: 'glo90', range: G.es26.yRange, g50: G.es26.g50, g100: G.es26.g100 },
      official: { highestM: 697, highestAt: 'Turn 7', lowestM: 671, lowestAt: 'Turn 2', climb: 'Turn 6: 8% uphill, +10 m', descent: 'after Turn 7: 5% downhill', source: SRC.madring },
      lidarAtOfficialPoints: { T2: 671.0, T7: 695.7 },
      gameAtOfficialPoints: { T2: 673.1, T7: 693.7, lowest: '669.7 at s 507 (T3 exit)', mainStraight: 'falls 12 m from s 5393 (681.5) to s 507 (669.7)' },
      crossCheck: { srtm30RangeM: 36.6, glo90RawRangeM: 28.0,
        offsetFree: 'T7 minus T2: official 26 m (697 - 671), lidar 24.7 m, game 20.6 m; start line minus T2: lidar +2.0 m, EU-DEM +2.8 m, game +8.2 m',
        eudem25m: 'OpenTopoData eudem25m every 50 m (west/xcheck-eudem.mjs): main straight 674-681 m with building noise, T2 671.5 m (official 671); it shows 665.7 m at T3 (s 407), below the official lowest point (T2, 671 m), so EU-DEM is not used' },
      caveat: 'PNOA-LiDAR flight year not stated by the WCS; sections built in 2025-26 (La Monumental s 2262-2762, the Valdebebas link) may differ from the pre-construction ground. The official highest / lowest points agree with the lidar within 1.3 m.' },
    banking: { official: bank26.map((b) => ({ name: b.name, pct: b.officialPct, deg: b.deg, gameDeg: b.gameBankDeg })),
      laMonumental: { game: '13.5 deg over 548 m (bank > 3 deg)', official: '24 % = 13.5 deg, 547.82 m' } },
    covered: [
      { name: 'Tunnel 1 (under a road ramp, after Turn 5)', osmWays: [34049751, 87096566], gameS: [1365, 1446], lengthM: 69, from: [40.472194, -3.623907], to: [40.47278, -3.624167],
        note: 'OSM routes the circuit (relation member 34049751) through the eastern tube; the game line follows the western tube 87096566, 9-15 m away' },
      { name: 'Tunnel 2 ("the tunnel connecting Valdebebas with IFEMA", before Turn 18)', osmWay: 827423914, gameS: [3868, 3996], lengthM: 127, from: [40.4726371, -3.6188896], to: [40.4716693, -3.6181083],
        over: 'motorway link bridge (way 34049818, layer 1) crosses above at s ~3915; footbridge (way 516431587) at s ~3971-4006' },
    ],
  },
  findings: [
    F('elevation', 'major', `GLO-90 surface model (IFEMA halls, trees): range ${G.es26.yRange} m but the wrong shape - the last 300 m of the main straight climb +4.2 % / 100 m to 681.5 m (s 5393) and the road then falls 12 m to 669.7 m at the Turn 3 exit (s 507), where the real ground is flat; the Turn 6-7 climb is only +2.7 % (s 1467-1718); the drop after Turn 7 only -2.4 %; invented 4-4.5 % humps at T19-T21 (s 4188-4909); the Valdebebas descent (lidar -9.4 % at s 3521-3621) sits ~90 m later in the game (-8.2 % at s 3606-3706).`,
      `Official: highest 697 m at Turn 7, lowest 671 m at Turn 2 (26 m), Turn 6 "8% uphill" (+10 m), "5% downhill" after Turn 7. IGN-ES MDT05 lidar on the OSM line: range ${P.es26.realRange} m, T2 671.0 m, T7 695.7 m; climb to T7 +7.2-7.3 % over 100 m, descent after T7 -6.2 / -6.5 %; main straight and T19-T22 flat at 673 +-1 m. 25 stretches where the game's 100 m grade differs by more than 2 pp; residual RMS ${P.es26.residualRms} m.`,
      'ELEV_SOURCE["es-2026"] = "ignes-mdt05" (DTM processing) + COVERED for the two tunnels (below); or apply proposedCorrections.elevationProfile10m. Re-check La Monumental / Valdebebas against a post-construction survey when one exists.', [SRC.madring, SRC.mdt05, SRC.wMadring, SRC.srtm, SRC.glo90]),
    F('tunnel', 'major', 'No covered sections; the GLO-90 heights there include the roads above.',
      'Two tunnels on the lap ("Two tunnel sections running underneath an elevated motorway"; official: Turn 18 is "just outside the tunnel connecting Valdebebas with IFEMA"): OSM tunnel 1 (ways 34049751 / 87096566, 69 m, game s 1365-1446) and tunnel 2 (way 827423914, 127 m, game s 3868-3996) under the motorway link bridge 34049818.',
      'Add to js/tunnels.js data: es-2026 [{name: "Tunnel 1", kind: "tunnel", facade: "plain", from: [40.472194, -3.623907], to: [40.47278, -3.624167]}, {name: "Valdebebas - IFEMA tunnel", kind: "tunnel", facade: "plain", from: [40.4726371, -3.6188896], to: [40.4716693, -3.6181083]}] and the same ends as COVERED entries (pad 10).', [SRC.wMadring, SRC.madring, SRC.osm + ': ways 34049751, 87096566, 827423914, 34049818']),
    F('length', 'minor', 'lengthKm 5.474: the build scales the dataset geometry by 1.0111 to the dataset\'s length property 5474 m - every distance on the circuit is 1.1 % too long (lap +60 m).',
      'Official 5.414 km (Wikipedia; 2026 Spanish GP 57 laps = 308.399 km). The dataset line itself measures 5430 m (geodesic), OSM 5442 m.',
      'Official-length override in tools/build-tracks.mjs: LENGTH_OVERRIDE = { "es-2026": 5414 } (scale ~1.000 instead of 1.011). Re-run the seasons calibration afterwards.', [SRC.wMadring, SRC.wSpGP26, SRC.dataset]),
    F('banking', 'minor', 'Derived banking (inside low) 4.7-5.8 deg at T1, T2, T5, T7, T8, T13, T17, T20, T21, T22; contra-banked corners banked the normal way.',
      'Official per-turn banking (madring.com): 1-7 % (0.6-4.0 deg) except La Monumental 24 % (13.5 deg, which the game has right over 548 m); contra-banking at T3 (-3 %), T11, T14, T16, T21, T22.',
      'Replace BANKED["es-2026"] with proposedCorrections.bankOverrides (21 corners + the existing T12; negative deg = contra-banking, supported by js/track.js applyBankOverrides).', [SRC.madring, SRC.wMadring]),
    F('layout', 'minor', `Game vs OSM relation 18813472: mean ${L.es26.gameToOsm.meanM} m, p95 ${L.es26.gameToOsm.p95M} m, max ${L.es26.gameToOsm.maxM} m at s 1364-1442 (tunnel 1: the other tube), 10.2 m at T21 (s 4756-4792), 9.6 m at T19 (s 4124-4182), 8.9 m at T3 (s 358-394).`,
      'OSM is partly still tagged construction=raceway (ways 1366550166, 1366550168, 1378267450, 1378267452), so neither line is a surveyed final layout.',
      'Re-check against a post-race OSM / official map later; no change now.', [SRC.osm + ': relation 18813472']),
    F('pit', 'minor', 'Entry line s 5312, exit s 96 (432 m lane); right side; 80 km/h.',
      'Right side and 80 km/h are correct (FIA 2026). OSM "Madring pit lane" (way 1552567031) leaves the track at s 4950 before Turn 22 ([40.4668009, -3.6121166]) and rejoins at s 474 after Turn 3 ([40.4649706, -3.6214382]), ~903 m.',
      'Optional pitEntry / pitExit points; keep side -1, 80.', [SRC.fiaSpain, SRC.osm + ': way 1552567031']),
  ],
  proposedCorrections: {
    lengthOverrideM: 5414,
    bankOverrides: bank26.filter((b) => b.from).map(({ name, deg, from, to }) => ({ name, deg, from, to })).concat([{ name: 'T12 La Monumental', deg: 13.5, keep: true }]),
    covered: [
      { name: 'tunnel 1', from: [40.472194, -3.623907], to: [40.47278, -3.624167], pad: 10 },
      { name: 'Valdebebas - IFEMA tunnel', from: [40.4726371, -3.6188896], to: [40.4716693, -3.6181083], pad: 10 },
    ],
    tunnels: [
      { name: 'Tunnel 1', kind: 'tunnel', facade: 'plain', from: [40.472194, -3.623907], to: [40.47278, -3.624167] },
      { name: 'Valdebebas - IFEMA tunnel', kind: 'tunnel', facade: 'plain', from: [40.4726371, -3.6188896], to: [40.4716693, -3.6181083] },
    ],
    elevationSource: { id: 'ignes-mdt05', wcs: 'https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion4258_5&SUBSET=Lat(40.46158,40.48334)&SUBSET=Long(-3.62889,-3.60844)&FORMAT=image/tiff' },
    elevationProfile10m: { format: '[lat, lon, real m above the lap minimum, game m on the same datum, game s]', points: profile10(P.es26) },
    pitFacts: { side: -1, limitKmh: 80, realEntry: [40.4668009, -3.6121166], realExitMerge: [40.4649706, -3.6214382] },
  },
};

const all = [mc, fr60, fr69, es91, es26];
for (const t of all) {
  t.method = 'devtests/track-audit/west/: dump-game.js (game build), ovp.mjs / osm-fetch2.mjs (Overpass), osm-loop.mjs + pr-chicane-loop.mjs (OSM reference loops), layout.mjs, profile.mjs (DEM on the OSM line vs game), raw-vs-game.mjs, crossings.mjs, way-on-track.mjs, direction.mjs, corners.mjs, madring-bank.mjs; results in west/res/';
  t.globalNote = 'tools/build-tracks.mjs projects with kz = 110540 m/deg and kx = 111320 cos(lat) m/deg: at these latitudes north-south distances come out 0.31-0.39 % shorter than east-west ones before the official-length rescale (WGS84: 111044-111168 m/deg of latitude). Cosmetic (<= 4 m per km).';
  writeFileSync(resolve(OUTDIR, t.id + '.json'), JSON.stringify(t, null, 1));
  console.log('wrote', t.id + '.json', t.verdict, t.findings.length, 'findings');
}
