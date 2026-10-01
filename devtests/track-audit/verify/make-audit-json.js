// node devtests/track-audit/verify/make-audit-json.js
// Writes tools/track-audit.json: the verified track-data corrections, in a form tools/build-tracks.mjs can apply later.
// Values that come from an auditor's per-circuit file are copied from it programmatically (no retyping); every lat/lon
// is projected on the game's built centreline here and its arc length / distance recorded as a consistency check.
'use strict';
const L = require('./lib.js');
const fs = L.fs, path = L.path;
const A = (id) => JSON.parse(fs.readFileSync(path.join(L.AUDIT, id + '.json'), 'utf8'));
const pc = (id) => { const j = A(id); return j.proposedCorrections || j.proposedCorrection || {}; };
const rel = (id, s) => { const g = L.game(id); return s > g.L / 2 ? s - g.L : s; };
function where(id, ll) { // [lat, lon] -> {s (relative to the current line, m), offM}
  if (!ll) return null;
  const g = L.game(id), p = g.project(ll[0], ll[1]);
  return { sFromLineM: Math.round(rel(id, p.s)), offCentrelineM: +p.dist.toFixed(1) };
}
const withPos = (id, list) => list.map((o) => Object.assign({}, o, { _check: { from: where(id, o.from || o.fromLatLon), to: where(id, o.to || o.toLatLon) } }));
const lidarBank = (id, filter) => {
  const b = pc(id).bankOverridesFromLidar; if (!b) return [];
  return b.list.filter((o) => (filter ? filter(o) : true)).map((o) => ({ name: o.name.replace(/ \(OSM s.*\)$/, ''), deg: o.deg, from: o.from, to: o.to,
    measured: o.measured, kind: o.kind, side: o.side }));
};

const SOURCES = {
  walmnt: { label: 'SPW Relief de la Wallonie MNT 2021-2022 (lidar DTM 0.5 m), (c) SPW', access: 'ArcGIS MapServer identify, 1 point per request: https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer/identify?geometry={"x":<lon>,"y":<lat>,"spatialReference":{"wkid":4326}}&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=<lon-0.001>,<lat-0.001>,<lon+0.001>,<lat+0.001>&imageDisplay=400,400,96&returnGeometry=false&f=json -> results[0].attributes["Stretch.Pixel Value"]', settings: { dtm: true }, licence: 'SPW web-service conditions, attribution "(c) SPW"; no explicit open licence found: check before shipping (fallback: the static profile devtests/track-audit/be-nl-de-gb/out/profile-be-1925.json)', usedBy: ['be-1925'], politeness: '~700 points, 1 request at a time, >= 0.5 s apart' },
  'ignes-mdt05': { label: 'IGN Espana / CNIG MDT05 (5 m DTM from PNOA-LiDAR), CC BY 4.0 (scne.es)', access: 'INSPIRE WCS 2.0.1 GetCoverage, one GeoTIFF per circuit (int16 whole metres, EPSG:4258): https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion4258_5&SUBSET=Lat(<lat0>,<lat1>)&SUBSET=Long(<lon0>,<lon1>)&FORMAT=image/tiff', settings: { dtm: true, note: 'bilinear sampling; whole-metre steps are removed by the DTM median + Gauss' }, usedBy: ['es-1991', 'es-2026'], caveat: 'PNOA-LiDAR flight year not stated: Madring (built 2025-26) must be re-checked (La Monumental, Valdebebas section)' },
  'er-dtmrer2022': { label: 'Regione Emilia-Romagna DTM RER2022 0.5 m (lidar 2022/23)', access: 'ArcGIS ImageServer getSamples, POST, 100 points per request: https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/DtmRER2022/ImageServer/getSamples (body geometry={"points":[[lon,lat],...],"spatialReference":{"wkid":4326}}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json)', settings: { dtm: true }, usedBy: ['it-1953'], licence: 'Regione Emilia-Romagna open data (CC BY 4.0 per the regional geoportal; confirm)' },
  'toscana-dsm2021': { label: 'Regione Toscana DSM 1 m 2021 (lidar SURFACE model; its 1 m DTM has no data at Mugello)', access: 'WMS GetMap image/tiff float32, EPSG:32632: https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms?map=wmsmorfologia&service=WMS&version=1.3.0&request=GetMap&layers=rt_morfologia.iddsm2021.1m.rt&crs=EPSG:32632&format=image/tiff', settings: { dtm: true, medianHalfM: 25, note: 'a surface model: a 25 m median removes the footbridge spike on the main straight; plus the COVERED footbridge entry' }, usedBy: ['it-1914'], licence: 'Regione Toscana open data (CC BY 4.0; confirm)' },
  tinitaly: { label: 'TINITALY 1.1 DEM 10 m (INGV, Tarquini et al. 2023, doi 10.13127/tinitaly/1.1), CC BY 4.0', access: 'WCS 2.0.1: https://tinitaly.pi.ingv.it/TINItaly_1_1/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=TINItaly_1_1__tinitaly_dem&... (EPSG:32632, 10 m, float32)', settings: { dtm: true }, usedBy: ['it-1922'], caveat: 'a 10 m DEM does not resolve the ~5 m dip under the old banking: add it by hand (see it-1922)' },
  glo30: { label: 'Copernicus DEM GLO-30 (30 m SURFACE model, (c) DLR / Airbus, provided under COPERNICUS by the EU and ESA)', access: 'AWS Open Data COGs, no key: https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_<N|S>yy_00_<E|W>xxx_00_DEM/Copernicus_DSM_COG_10_<...>_DEM.tif (HTTP range reads; reader: devtests/track-audit/latam-za/glo30.mjs)', settings: { dtm: false, note: 'surface model: keep a median >= 50 m (or a low-percentile "road" envelope where stands / trees line the track, as for my-1999)' }, usedBy: ['br-1940', 'my-1999', 'pt-2008'], caveat: 'not published for Azerbaijan; useless where the circuit was built after 2015 (Jeddah) or beside tall stands (Yas)' },
  usgs3dep: { label: 'existing source (tools/build-tracks.mjs SOURCES.usgs3dep)', usedBy: ['us-2022'] },
  hrdem: { label: 'NRCan HRDEM DTM (lidar, 1 m), Open Government Licence - Canada', access: 'WCS GetCoverage of coverage dtm (EPSG:4326 1e-5 deg tiles); reader: devtests/track-audit/americas/net.mjs hrdem()', settings: { dtm: true }, usedBy: ['ca-1978'], status: 'auditor-only (minor finding, not re-measured in the synthesis)' },
  bwdgm1: { label: 'LGL-BW DGM1 (1 m lidar DTM), Datenlizenz Deutschland Namensnennung 2.0', access: 'opengeodata.lgl-bw.de/data/dgm/dgm1_32_<E>_<N>_2_bw.zip (XYZ); NOT the INSPIRE WCS (16-bit integer metres)', settings: { dtm: true }, usedBy: ['de-1932'], status: 'auditor-only (minor)' },
  rlpdgm1: { label: 'LVermGeo RLP DGM1 (1 m lidar DTM), Datenlizenz Deutschland Namensnennung 2.0', access: 'geobasis-rlp.de/data/dgm1/current/tif/dgm1_32_<E>_<N>_1_rp_2025.tif (Float32 LZW, predictor 2)', settings: { dtm: true, covered: 'the three COVERED entries of de-1927' }, usedBy: ['de-1927'], status: 'auditor-only (minor)' },
  ealidar: { label: 'Environment Agency LIDAR Composite DTM 1 m, Open Government Licence', access: 'WCS 2.0.1 GeoTIFF, EPSG:27700', settings: { dtm: true }, usedBy: ['gb-1948 (optional)'], status: 'auditor-only (minor)' },
  bevals: { label: 'BEV ALS DTM 1 m (Austria), CC BY 4.0', access: 'COG https://data.bev.gv.at/download/ALS/DTM/20230915/ALS_DTM_CRS3035RES50000mN2650000E4650000.tif (EPSG:3035, range reads)', settings: { dtm: true }, usedBy: ['at-1969 (optional)'], status: 'auditor-only (minor)' },
};

// ---------------------------------------------------------------- per circuit
const C = {};
const V = (aspect, status, claim, evidence) => ({ aspect, status, claim, evidence });

C['be-1925'] = {
  verdict: 'major issues',
  verification: [
    V('gradient', 'verified', 'GLO-90 profile flattens Eau Rouge / Raidillon and moves the steep climb up the Kemmel straight',
      'Re-sampled the Wallonia MNT 2021-22 lidar myself (new points every 20 m on the built centreline, 350 identify requests): Raidillon +14.8 % over 50 m / +13.9 % over 100 m at s 1021 where the game has +3.0 %; the game\'s steepest climb +12.2 % (50 m) is at s 1921 on the Kemmel straight where the lidar has +4.6 %. fr.wikipedia "côte très raide à 17 %", f1.com "maximum gradient of 15%".'),
    V('elevation', 'verified', 'Tree-canopy hump Paul Frere -> Bus Stop, RMS ~10 m', 'Same re-sample: range lidar 102.3 m vs game 99.0 m (en.wikipedia 102.2 m), RMS 9.8 m, 25 stretches with 100 m grades > 2 pp apart, worst in s 4900-6700 (game +8.5 / +11.2 / +11.0 % where the lidar has +0.5..+3.5 %).'),
    V('bridge', 'verified', 'Phantom deck 686 m after the line (OSM 1353164215)', 'Fresh OSM API query of the deck box: outline 1353164215 (man_made=bridge) has only way 1353164214 (layer -1) under it and nothing over the lap; js/scenery.js builds it over the road (my decks.js: 2 m of centreline inside the polygon, s 688).'),
  ],
  apply: {
    ELEV_SOURCE: 'walmnt',
    PUBLISHED: [102.2, 'en.wikipedia.org/wiki/Circuit_de_Spa-Francorchamps "102.2 m"; = Wallonia lidar range of the lap'],
    expectedAfter: pc('be-1925').elevationSource.expected,
    sceneryDropBridges: [1353164215],
  },
  optional: {
    BANKED: lidarBank('be-1925', (o) => !/nearly straight/.test(o.side)),
    START_AT: [50.4440643, 5.9651626], START_AT_note: 'OSM node 258602622 (relation 284560 start), 23 m before the game line; cosmetic',
  },
  breaks: ['tracks-data.js elev of be-1925 -> rerun devtests/seasons-calib/calibrate.mjs'],
};
C['nl-1948'] = {
  verdict: 'major issues',
  verification: [
    V('banking', 'verified (spot check)', 'Tarzanbocht camber 6.5 deg vs 3.3 deg in the game', 'Own AHN4 cross-sections (9 stations, +-4 m, 1 m apart, 1 request): mean 6.5 deg, all planar (residual <= 0.07 m); game 3.4 deg. Confirms the auditor 6.4 deg and its method.'),
    V('bridge', 'verified', 'Phantom deck over the main straight 160 m before the line (OSM 765476850)', 'Fresh OSM API: outline 765476850 has service tunnel 186321842 (layer -1, tunnel=yes) under it; nothing over the lap. Built over the road at s 4097-4105.'),
    V('pit', 'verified (minor)', 'Pit limit 60 km/h before 2025', 'en.wikipedia 2025 Dutch Grand Prix, "Circuit change": "The pit lane speed limit was increased from 60 km/h to 80 km/h".'),
  ],
  apply: {
    sceneryDropBridges: [765476850],
    BANKED_keep: 'T3 19 deg and T14 18 deg stay (published; the lidar shows a progressive cross-section, ~5 deg inside to 18-23 deg outside)',
    BANKED_add: lidarBank('nl-1948', (o) => !/nearly straight/.test(o.side)),
    PIT_FACTS: { limitKmhBySeason: { 2021: 60, 2022: 60, 2023: 60, 2024: 60 }, note: '80 from 2025 (default). Needs per-season support in js/track.js / the season code; if only one value is possible keep 80 (current layout year).' },
  },
  optional: { START_AT: [52.3889948, 4.5408762], START_AT_note: 'OSM relation 13545573 "Finish" node 12148116710, 70 m after the game line', BANKED_sideCheck: lidarBank('nl-1948', (o) => /nearly straight/.test(o.side)) },
  breaks: ['bankOverrides change handling at Tarzan / Hunserug / Scheivlak -> recalibrate'],
};
C['de-1932'] = {
  verdict: 'major issues',
  verification: [V('bridge', 'verified', 'Three phantom decks (OSM 1302356195, 1302600377, 1302600378)', 'Fresh OSM API: each outline has a service / foot tunnel (layer -2) under it (31320990, 26336602 + 534265659, 192994934) and nothing over the lap; built over the road at s 552-558, 3378-3388, 3232-3240.')],
  apply: { sceneryDropBridges: [1302356195, 1302600377, 1302600378] },
  optional: { ELEV_SOURCE: 'bwdgm1', ELEV_note: 'minor: GLO-90 puts a 5 m hump on the Parabolika (lidar range 4.2 m vs game 7.9 m); auditor-only', BANKED: lidarBank('de-1932') },
};
C['de-1927'] = {
  verdict: 'major issues',
  verification: [V('bridge', 'verified', 'Phantom deck 1466 m after the line (OSM 790945811); BMW-Bruecke real', 'Fresh OSM API: the lap raceway 1443047846 is bridge=yes layer 1 inside outline 790945811 and the B 258 (layer 0) crosses the lap there (s 1456): the outline is the lap\'s own bridge. Outline 34444288 "BMW-Brücke" (man_made=bridge, bridge=covered, cable-stayed) spans the start straight: keep.')],
  apply: { sceneryDropBridges: [790945811], sceneryKeepBridges: [34444288] },
  optional: { ELEV_SOURCE: 'rlpdgm1', COVERED: pc('de-1927').covered, ELEV_note: 'minor: NGK climb displaced ~150 m, RMS 3.4 m; auditor-only', BANKED: lidarBank('de-1927') },
};
C['gb-1948'] = {
  verdict: 'major issues',
  verification: [
    V('start', 'verified', 'Line and pits at the pre-2011 National straight', 'en.wikipedia 2011 British Grand Prix: "the pits and the start/finish line moved to the straight between Club Corner and the new Abbey". Fresh OSM API: node 13036050131 (raceway=finish) lies on the game lap 3038 m after the game line (1.1 m off the centreline), node 13036050130 (raceway=start/finish) 151 m further.'),
    V('pit', 'verified', 'F1 pit lane is the Wing lane on the right', 'OSM way 227902927 "International pit lane" runs on the driver\'s right from 604 m before to 706 m after the finish node (side test on 73 nodes: 69 right).'),
  ],
  apply: { START_AT: [52.0682609, -1.0234867], START_AT_note: 'the timing (finish) line; the start line (grid) is node 13036050130 [52.0693366, -1.0221521], 151 m further on', PIT_FACTS: { side: -1 } },
  optional: { ELEV_SOURCE: 'ealidar', BANKED: lidarBank('gb-1948', (o) => !/OFF-CAMBER/.test(o.side)), scenery: 'tag the Wing as the pit building; add the Wellington Straight bridges and the Wing glass footbridge (building=bridge, min_height 14.5 m)' },
  breaks: ['grid, pit lane and timing move 3.04 km round the lap (2010 used the old line: the game has one line for all seasons; 16 of the 17 seasons used the Wing)', 'scenery-data.js still has the old pit building as "pit": js/scenery.js may draw garages at the old place', 'recalibrate (lap start moves)'],
};
C['mc-1929'] = {
  verdict: 'major issues',
  verification: [V('tunnel', 'verified', 'The 360 m tunnel under the Fairmont is open road in the game', 'Fresh OSM API: Boulevard Louis II way 4230891 (tunnel=yes, layer -1) runs along the lap from s 1521 to s 1882 (all 26 nodes within 7.9 m of the centreline); the Portier raceway way 1470365907 (tunnel=yes, layer -1) at s 1418-1436 under Boulevard du Larvotto (bridge 92627405).')],
  apply: { tunnels: pc('mc-1929').tunnels, tunnelsNote: 'already the prep data of js/tunnels.js (v6.2); COVERED for the tunnel already exists in build-tracks', derivedBankMaxDeg: 2 },
  optional: { pitLaneReal: { entryLL: [43.7323832, 7.4229757], exitLL: [43.7370216, 7.4221175], note: 'enters between La Rascasse and Anthony Noghes, exit lane rejoins after Sainte Devote; needs js/track.js support' }, elevNote: 'IGN lidar keeps Beau Rivage at 9.2 % (lidar 10 %); optional DTM median half 1' },
  notTrackData: 'Fairmont hairpin: centreline radius 9.6-9.8 m vs OSM 8.9 m is correct; "cannot take it at 20 km/h" is js/car.js steering lock (min radius 10 m), v6.2',
};
C['es-1991'] = {
  verdict: 'major issues',
  verification: [V('elevation', 'verified', 'Invented crest at T3 and dip into T4', 'Own read of the cached IGN MDT05 GeoTIFF (own TIFF reader, bilinear, 10 m on the built centreline): range 29.9 m vs game 34.7 m, RMS 2.73 m; s 981-1221 game -3.5 % vs lidar +3.2 %; game +8.5 % at s 891 vs lidar +4.1 %; 12 stretches > 2 pp.')],
  apply: { ELEV_SOURCE: 'ignes-mdt05', bbox: [41.56148, 2.24852, 41.57745, 2.26728] },
  optional: { fallbackProfile: 'devtests/track-audit/es-1991.json proposedCorrections.elevationProfile10m', derivedBankMaxDeg: 3 },
  layoutNote: 'one layout (2023+, no final chicane) for every season; 2010-2022 raced with the RACC chicane (OSM relation 2049529): a per-season layout is not supported today',
  breaks: ['elev -> recalibrate'],
};
C['es-2026'] = {
  verdict: 'major issues',
  verification: [
    V('elevation', 'verified', 'GLO-90 profile has the wrong shape (main straight climbs, fake drop to T3)', 'Own read of the cached IGN MDT05 tile: range 25.7 m (official 697-671 = 26 m) vs game 24.1 m, RMS 2.99 m, 27 stretches > 2 pp; main straight s 5200-5400 flat at 673 m in the lidar while the game climbs 7 m; the lidar\'s +-13 % 50 m grades at s 1439 / 3877 are the two tunnels (ground above) and need COVERED.'),
    V('tunnel', 'verified', 'Two tunnels under the motorway link are missing', 'Fresh OSM API: tunnel=yes ways 87096566 (s 1376-1446, the tube the game line follows) and 827423913 / 827423914 (s 3865-4000) with motorway link bridge 34049818 (layer 1) over s 3912; en.wikipedia Madring: "Two tunnel sections running underneath an elevated motorway".'),
    V('length', 'verified (minor)', 'Dataset length 5474 m is wrong', 'en.wikipedia Madring "5.414 km"; the dataset line is 5430 m geodesic, built 5476 m (+0.85 %).'),
  ],
  apply: { ELEV_SOURCE: 'ignes-mdt05', bbox: [40.46158, -3.62889, 40.48334, -3.60844],
    COVERED: [{ name: 'tunnel 1 (the tube the game line follows, OSM way 87096566)', from: [40.4721947, -3.6240596], to: [40.4727971, -3.6242927], pad: 10 }, pc('es-2026').covered[1]],
    tunnels: [{ name: 'Tunnel 1', kind: 'tunnel', facade: 'plain', from: [40.4721947, -3.6240596], to: [40.4727971, -3.6242927], osm: 87096566, note: 'the OSM circuit relation uses the parallel tube 34049751 (14.8 m away); the dataset line runs in 87096566' }, pc('es-2026').tunnels[1]],
    LENGTH_OVERRIDE_M: 5414 },
  optional: { BANKED: pc('es-2026').bankOverrides, BANKED_note: 'per-turn banking from madring.com/en/circuit (auditor-read, not re-read here); negative = contra-banked (js/track.js supports it); keep T12 13.5 deg', fallbackProfile: 'devtests/track-audit/es-2026.json proposedCorrections.elevationProfile10m' },
  caveat: 'lidar flight year unknown (circuit built 2025-26): re-check La Monumental and the Valdebebas section after applying',
  breaks: ['elev, length -> recalibrate; scenery-data.js has no stands / pit building yet'],
};
C['it-1922'] = {
  verdict: 'major issues',
  verification: [
    V('elevation', 'verified', 'Invented hills (game range 22.4 m vs ~12 m)', 'Own read of the cached TINITALY 10 m tile (UTM 32N, own projection): range 12.0 m vs game 22.4 m, RMS 3.90 m, 16 stretches > 2 pp; game -5.5 % at s 2400 and +4.7 % at s 2660 where TINITALY has -0.9 / -0.2 %. formula1.com 12.8 m.'),
    V('gradient', 'partly verified', 'No dip under the old banking; one long invented descent Lesmo 2 -> Ascari', 'The invented 11.6 m descent (game s 2900-3600) is confirmed: TINITALY is flat within 1.2 m there. The ~5 m dip itself is NOT resolved by the 10 m DEM; it rests on the F1 timing car heights and formula1.com ("the significant dip ... between the second Lesmo and Ascari"): plausible, add by hand.'),
  ],
  apply: { ELEV_SOURCE: 'tinitaly', manualDip: { name: 'underpass under the old banking (OSM bridge 34404729 over car way 1443867793)', centreLL: [45.6247798, 9.2892658], depthM: 5, lengthM: 600, note: 'from the timing heights 192.7 / 187.6 / 190.9 m at s 3005 / 3300 / 3595 (-1.7 % / +1.2 %)' } },
  optional: { staticProfile: 'devtests/track-audit/it-1922.json proposedCorrections.elevation.profile10m (timing heights + TINITALY; FOM data: licence question)' },
  breaks: ['elev -> recalibrate'],
};
C['it-1953'] = {
  verdict: 'major issues',
  verification: [
    V('banking', 'verified (spot check)', 'T7 Tosa over-banked in the game', 'Own RER2022 cross-sections (9 stations): 2.6 deg (auditor 2.4), game 4.7 deg.'),V('elevation', 'verified', 'Profile shifted and smeared; Acque Minerali too shallow, Rivazza too steep', 'Re-sampled the RER2022 0.5 m DTM myself (491 new points, 5 POST requests): range 34.3 m vs game 35.2, RMS 3.90 m; game +9.7 % at s 2169 where the lidar has -0.3 %, Rivazza -10.7 % vs lidar -6.9 %, Piratella -> Acque Minerali lidar 32.3 -> 12.0 m (game 32.4 -> 18.2).')],
  apply: { ELEV_SOURCE: 'er-dtmrer2022', BANKED: pc('it-1953').bankOverrides },
  breaks: ['elev, banking -> recalibrate'],
};
C['it-1914'] = {
  verdict: 'major issues',
  verification: [
    V('banking', 'verified (spot check)', 'Arrabbiata 1 cambered ~5 deg', 'Own Toscana DSM cross-sections (11 stations): mean 5.2 deg (auditor 5.1), game 2.1 deg.'),V('elevation', 'verified', 'San Donato taken downhill in the game, uphill in reality', 'Own read of the cached Toscana DSM 1 m tiles (8 tiles, UTM 32N, 25 m median): s 450 -> 900 lidar +12.9 m (21.7 -> 34.6) vs game -3.5 m; range 42.7 vs 37.2 m, RMS 4.9 m, 17 stretches > 2 pp. it.wikipedia: main straight "in salita".')],
  apply: { ELEV_SOURCE: 'toscana-dsm2021', COVERED: pc('it-1914').COVERED, BANKED: pc('it-1914').bankOverrides.filter((o) => o.deg !== 0) },
  optional: { flatten: pc('it-1914').bankOverrides.filter((o) => o.deg === 0), flattenNote: 'deg 0 is skipped by js/track.js applyBankOverrides: use the derived-bank cap, or support deg 0' },
  breaks: ['elev, banking -> recalibrate'],
};
C['hu-1986'] = {
  verdict: 'major issues',
  verification: [V('start', 'verified', 'Start / finish ~240 m too far towards T1', 'FIA 2026 Hungarian GP circuit map (cache/fia/hu-2026-p2.png) re-measured: start + control line ~620 m before T1 using its own "Speed trap 310 m before T1" scale; the game line is 360 m before the T1 apex -> ~250 m. The auditor\'s 2025 / 2026 timing grids put pole at -244.5 / -243.5 m. Esri imagery (2024) shows no line at the game position.')],
  apply: { START_AT: [47.5789212, 19.2483897] },
  optional: { elevation: 'F1 timing car heights (range 34.7 m, rms 2.1 m vs game): optional, licence question; no open lidar for Hungary' },
  breaks: ['grid, pit lane and timing move 240 m back -> recalibrate'],
};
C['pt-1972'] = {
  verdict: 'major issues',
  verification: [V('layout', 'verified', 'The geometry is the post-2000 layout, labelled and stretched as the 1972-93 one', 'Game line vs current OSM raceway ways: mean 2.3 m, max 6.6 m (no stretch off the modern road); geodesic length of the dataset line 4166 m, built 4350 m (+4.4 %). en.wikipedia Circuito do Estoril: original 4.349 km, 4.360 km with the 1994 chicane, "redesign of the parabolica ... reduced to 4.182 km ... in 2000".')],
  apply: { LENGTH_OVERRIDE_M: 'geometric (no rescale, ~4166 m) or 4163 (Tanque variant)', nameNote: 'label it the current (2000+) layout; F1 never raced it (F1 1984-96 used the old Parabolica)' },
  optional: { addGanchoChicane: pc('pt-1972').layout.alternative.addChicane, elevation: 'GLO-30 profile (range 22.6 m vs game 30.6 m; auditor-only, minor)', pitLaneReal: pc('pt-1972').pit },
  doNotApply: [{ what: 'redraw the pre-2000 Parabolica', why: 'no OSM geometry survives; DGT 1995 orthophotos need an account' }],
  breaks: ['every distance shrinks 4.4 % -> recalibrate; scenery-data.js is in lat/lon-derived metres of the same geo: rebuild scenery with the new geo scale'],
};
C['pt-2008'] = {
  verdict: 'major issues',
  verification: [V('elevation', 'verified (surface models only)', 'Crests about halved; steepest fall 7.9 % vs published 12 %', 'Own bilinear re-sample of the cached GLO-30 grid (10 m, 25 m median): range 27.6 vs game 24.1 m, steepest fall -10.2 % (100 m) vs game -7.9 %, T9-T11 dip s 2171-2351 -8.4 % vs game -1.9 %; own OpenTopoData SRTM 30 m request (99 points): range 34.8 m, -11.0 % / +12.9 %. de.wikipedia: "Die steilste Abfahrt hat 12 % im Maximum, ... bis zu 6,2 % bergauf". No lidar reachable (DGT needs an account).')],
  apply: { ELEV_SOURCE: 'glo30', settings: { medianHalfM: 25, gaussSigmaM: 20 }, note: 'check after the build: max fall ~10-12 %, max rise must not exceed ~7 % (published 6.2 %); clamp or smooth climbs if it does' },
  optional: { staticProfile: 'devtests/track-audit/pt-2008.json proposedCorrections.elevation.stations', pitLaneReal: pc('pt-2008').pit, lidarLater: 'DGT MDT 2 m (2024) with a DGT account' },
  breaks: ['elev -> recalibrate'],
};
C['az-2016'] = {
  verdict: 'major issues',
  verification: [V('other', 'verified', 'Castle section 14 m wide in the game, 7.6 m real', 'en.wikipedia Baku City Circuit: "the track has a narrow 7.6 m (25 ft) uphill section". Built samples s 2550-2850: road 14.0 m wide, walls 12 m from the centreline on both sides.')],
  apply: { widthOverrides: pc('az-2016').widthOverrides, widthNote: 'needs js/track.js support (per-stretch halfW cap, walls follow); HALF_WIDTH_MIN 3.5 allows 3.8' },
  optional: { elevationScaleToRangeM: 26.8, elevationNote: 'GLO-90 range 34.4 m includes old-town buildings; formula1.com 26.8 m (auditor-only)', START_AT: [40.3725853, 49.8529141], pitLaneReal: pc('az-2016').pit },
  breaks: ['narrower road -> recalibrate; walls / scenery clearance in the castle section'],
};
C['us-2022'] = {
  verdict: 'major issues',
  verification: [V('elevation', 'verified', 'Turn 13-16 climb and crest flattened (FLAT_TRACKS, GLO-90)', 'Own USGS 3DEP EPQS samples (36 points, 10 m apart, s 3250-3600): the road rises 3.2 m from s 3270 to a crest at s 3350 (4.46 m ASL), +4.7 % over 50 m, then falls -3.2 % to 0.9 m at s 3540; the game varies 0.21 m there. OpenTopoData NED 10 m (pre-2022 data) shows only a 1.6 m bump: the ramp was built with the circuit. formula1.com describes the uphill approach and crest in the T14-15 chicane.')],
  apply: { ELEV_SOURCE: 'usgs3dep', FLAT_TRACKS: 'remove us-2022', settings: { medianHalf: 1, gaussSigmaM: 10, note: 'lighter DTM smoothing keeps 4.4 / -2.8 % at the T14-15 ramp (auditor sim)' } },
  optional: { sceneryOverpasses: pc('us-2022').bridgesOverTrack },
  breaks: ['elev -> recalibrate'],
};
C['ca-1978'] = {
  verdict: 'major issues',
  verification: [V('bridge', 'verified', 'Bridge underpass before T8 missing', 'Fresh OSM API: five bridge=yes layer 1 ways cross the lap between s 2114 and 2134 (135527655, 1427698141 Avenue Pierre-Dupuy, 814256358, 413000974, 164863796 Pont des Iles); en.wikipedia: "Pont de la Concorde corner (Turn 8) is after the bridge underpass".')],
  apply: { sceneryOverpasses: pc('ca-1978').bridgesOverTrack, underpassDeck: pc('ca-1978').underpassDeck },
  optional: { ELEV_SOURCE: 'hrdem', FLAT_TRACKS: 'remove ca-1978', elevNote: 'minor, auditor-only: GLO-90 shape uncorrelated with the ground (r 0.05); HRDEM range 5.2 m', derivedBankScale: 0.3 },
};
C['br-1940'] = {
  verdict: 'major issues',
  verification: [V('elevation', 'verified', 'S do Senna too gentle, Descida do Lago flat, invented Bico de Pato hill, start straight falls', 'Own GLO-30 re-sample (25 m median): S do Senna -11.4 % (100 m) vs game -8.8 %; Descida do Lago s 1389-1629 -4.9 % vs game +0.4 %; Bico de Pato s 2518-2628 +4.6 % vs game +10.6 %; start straight s 4197-4297 +5.2 % vs game -0.7 %; RMS 4.45 m. Own OpenTopoData SRTM 30 m request (98 points) shows the same pattern (start straight +5.5 %, Descida do Lago -4.1 %). pt.wikipedia range 43 m (GLO-30 43.6 m).')],
  apply: { ELEV_SOURCE: 'glo30', settings: { medianHalfM: 25, gaussSigmaM: 10 } },
  optional: { staticProfile: 'devtests/track-audit/br-1940.json proposedCorrections.elevationProfile (GeoSampa 1 m contours, bare earth; best data)', pitLaneReal: pc('br-1940').pitLane, sceneryOverpasses: pc('br-1940').overpasses },
  breaks: ['elev -> recalibrate'],
};
C['ae-2009'] = {
  verdict: 'major issues',
  verification: [
    V('pit', 'verified', 'Pit exit tunnels under the track and rejoins on the left at T3', 'OSM: pit lane 176695254 on the right from s -406 to 256, tunnel way 176695255 (tunnel=yes, layer -1) s 256-297 (fresh API query confirms tunnel=yes at s 278-291), then 176695253 on the LEFT (25/25 nodes) to s 728. en.wikipedia: "the pit exit, which dips under the main circuit by way of a tunnel".'),
    V('bridge', 'verified', 'The lap passes under the W hotel link', 'Fresh OSM API: raceway way 1255169704 covered=yes at s 4408-4437, building:part 1387292013 (min_height 9, height 18) crosses the lap at s 4408 / 4436. en.wikipedia: "passes by the marina and under the W Abu Dhabi hotel".'),
  ],
  apply: { scenery: [{ osmWay: 1387292013, kind: 'W hotel link (building:part)', undersideM: 9, topM: 18, lapS: [4408, 4437] }], pitLaneReal: pc('ae-2009').pit },
  optional: { elevation: 'timing-Z profile (rms 1.45 -> 0.05 m; licence question); START_AT [24.46995, 54.605311] (-16 m)', BANKED: pc('ae-2009').bankOverrides },
  needsCode: ['js/track.js: real pit geometry with an underpass and a left-side merge'],
};
C['jp-1962'] = {
  verdict: 'major issues',
  verification: [V('bridge', 'verified', 'The crossover is a flat junction in the game', 'Built track: both roads at y 28.93 m at the crossing (s 2320 / 4690), bank 0; tracks-data elev there 25.8 / 32.0 m. GSI 5 m cache next to the crossing: lower road 43.4 m, upper road approaches 49.4-49.7 m ASL (6.2 m apart). OSM raceway way 175231434 bridge=yes layer 1 at s 4675-4711 (fresh API).'),
    V('elevation', 'corrected', 'PUBLISHED 52 m "not in ja.wikipedia"', 'Re-read: ja.wikipedia 鈴鹿サーキット still says "最大高低差は52 m"; the lap lidar range is 40.4 m (formula1.com 40.4 m). Keep gsi5m; show both figures.')],
  apply: { PUBLISHED: [40.4, 'formula1.com "Highs and lows" (2016) 40.4 m = GSI lidar range of the lap; ja.wikipedia "最大高低差は52 m" is the whole site'] },
  needsCode: ['js/track.js: at a self-crossing whose tracks-data heights differ by > 4 m keep both heights (no levelling, no bank fade), draw a 37 m deck with parapets over the lower road, locate()/collision by height'],
  optional: { BANKED_flatten: pc('jp-1962').bankOverrides, note: 'T6 逆バンク has no cant; deg 0 needs js/track.js support or the derived cap' },
};
C['sg-2008'] = {
  verdict: 'major issues',
  verification: [V('bridge', 'verified', 'ECP / Benjamin Sheares viaduct over the lap missing', 'Fresh OSM API: East Coast Parkway bridges (layer 1-2) cross the lap at s 202-256 (T1), 530-1020 (T3-T5) and 4278-4334 (before the line); a building (layer 1, min_height 4.5) spans Raffles Boulevard at s 1234-1258. en.wikipedia: "The pit straight approaching just below the Benjamin Sheares Bridge".'),
    V('pit', 'verified', 'Pit limit 80 km/h since 2025', 'en.wikipedia 2025 Singapore Grand Prix: "the pit lane was widened by one metre; as such, the pit lane speed limit was increased from 60 km/h to 80 km/h".')],
  apply: { PIT_FACTS: { limitKmhBySeason: { 2010: 60, 2011: 60, 2012: 60, 2013: 60, 2014: 60, 2015: 60, 2016: 60, 2017: 60, 2018: 60, 2019: 60, 2022: 60, 2023: 60, 2024: 60 }, defaultLimitKmh: 80, note: 'if only one value is possible: drop the 60 (the game uses the 2025 layout, 2026 is the default season)' }, scenery: pc('sg-2008').overheadStructures },
  optional: { flatMaxRangeM: 5.3, flatNote: 'formula1.com 5.3 m (auditor-only)' },
};
C['my-1999'] = {
  verdict: 'major issues',
  verification: [
    V('start', 'verified', 'Line and grid ~300 m too far down the straight', 'Fresh OSM API: node 1578189278 "Start-Finish" (raceway=start-finish) is 302 m before the game line, 2.6 m off the centreline. Esri imagery: staggered grid marks run back from s -300 towards T15; none between s -270 and the game line; gantry shadow at s ~-270.'),
    V('elevation', 'verified (surface models)', 'High point on the back straight instead of T10/T11', 'Own GLO-30 re-sample: highest s 3192 (T10/T11), lowest s 881 (T3); game highest s 4293. Own SRTM request: highest s 3192, lowest s 896. T9 exit s 2843-2993 game -2.0 % vs +3.4 % (SRTM +4.7 %); T2->T3 descent starts late (s 540-671: -0.5 % vs -5.4 %). formula1.com "22m difference between Turn 3 and Turn 11".'),
  ],
  apply: { START_AT: [2.7607601, 101.7383513], ELEV_SOURCE: 'glo30', settings: { lowerEnvelope: 'rolling 20th percentile over 150 m, then median 50 m, Gauss sigma 40 m (auditor)' } },
  optional: { staticProfile: 'devtests/track-audit/my-1999.json proposedCorrections.profileOverride (20 m, from the CURRENT line: re-key after START_AT)' },
  breaks: ['grid, pit lane, timing move 302 m back; elev -> recalibrate'],
};
C['cn-2004'] = {
  verdict: 'major issues',
  verification: [V('start', 'verified (approximate)', 'Line ~210 m too close to T1', 'Esri imagery z19 re-rendered: staggered grid marks start at s ~-215 and run back past s -400; none between s -190 and the game line (which is beyond the west wing bridge, at the T1 entry). START_AT at s -209 is consistent; +-15 m, confirm on an official map.')],
  apply: { START_AT: [31.3372693, 121.2205226], START_AT_confidence: '+-15 m (imagery)' },
  optional: { scenery: pc('cn-2004').overheadStructures },
  breaks: ['grid, pit lane, timing move ~210 m back -> recalibrate'],
};
C['au-1953'] = {
  verdict: 'major issues',
  verification: [V('layout', 'verified', 'Two dataset stretches run across the grass ~22 m off the road; T11 built with a 10 m radius', 'Game line vs OSM relation 280443 (cache + 5 member / road ways re-fetched from the OSM API): mean 1.6 m; s 2530-2686 max 22.6 m (s 2594), s 4099-4205 max 22.1 m (s 4113); everything else <= 8.4 m. Esri imagery re-rendered: both stretches visibly on grass. Built T11 minimum radius 10.3 m (12 m chord) at s 4091.')],
  apply: { layoutPatches: pc('au-1953').layoutPatches, layoutNote: 'round the T11 junction vertex with an arc that stays on the paved junction' },
  optional: { START_AT: [-37.8500562, 144.9689843], START_AT_note: 'OSM node 9123374386 (raceway=start-finish) 45 m before the game line; painted line on imagery (auditor)', flatMaxRangeM: 2.6 },
  breaks: ['points change -> scenery-data.js alignment near T8 / T11 (re-run build-scenery), recalibrate'],
};

// ---------------------------------------------------------------- minor-only circuits (auditor findings; spot checks noted)
const minor = (verdict, o) => Object.assign({ verdict }, o);
C['fr-1960'] = minor('minor issues', { optional: { pitLaneReal: { entryLL: [46.862807, 3.1607953], exitLL: [46.8676721, 3.1656763] }, derivedBankMaxDeg: 3 }, notes: 'IGN lidar profile matches (range 30.3 vs 29.95 m); no F1 race 2010-2026; real length 4.411 km vs OSM 4458 m geometry (rescale 0.994)' });
C['fr-1969'] = minor('minor issues', { optional: { COVERED: pc('fr-1969').covered, layoutPatch: pc('fr-1969').layout, START_AT_candidate: pc('fr-1969').startAt, pitLaneReal: { entryLL: [43.2506981, 5.7968856], exitLL: [43.25385, 5.788233] } }, notes: 'Mistral chicane entry bulge missing (dataset 5818 m, stretched 0.35 %); START_AT candidate 152 m earlier is OSM-only: check the FIA map first' });
C['at-1969'] = minor('minor issues', { optional: { ELEV_SOURCE: 'bevals', note: 'GLO-90 4-6 m humps on the Schönberg straight; climbs to T1 / T3 right' } });
C['mx-1962'] = minor('minor issues', { optional: { START_AT: pc('mx-1962').START_AT.latlon, START_AT_note: 'OSM "Start Line" node 13826403209, 73 m after the game line', sceneryOverpasses: pc('mx-1962').overpasses, pitLaneReal: pc('mx-1962').pitLane } });
C['br-1977'] = minor('minor issues', { optional: { FLAT_TRACKS: 'add br-1977', note: 'the only relief is the 2007 arena over the old Curva Norte in the 2011-15 radar data; SRTM 2000 is flat' } });
C['ar-1952'] = minor('minor issues', { optional: { LENGTH_OVERRIDE_M: 4259, START_AT: pc('ar-1952').START_AT.latlon, START_AT_note: 'OSM node 9311100671 (raceway=start-finish) 68 m before', pitLaneReal: pc('ar-1952').pitLane } });
C['za-1961'] = minor('minor issues', { optional: { elevation: 'GLO-30 + SRTM mean profile (Leeukop 7 m lower); surface models only', START_AT: pc('za-1961').START_AT.latlon }, notes: '2015+ layout, never raced by F1' });
C['bh-2002'] = minor('minor issues', {
  verification: [V('start', 'verified (minor)', 'Real grid ~90 m further along', 'Esri imagery re-rendered: the start gantry spans the track at s ~+95; grid marks run back from there past the game line; nothing marks the game line.')],
  optional: { START_AT: pc('bh-2002').START_AT.latLon, elevation: 'GLO-30 (corr 0.99 with timing heights) removes the 5 m grandstand hump on the main straight' } });
C['sa-2021'] = minor('minor issues', { optional: { START_AT: pc('sa-2021').START_AT.latLon, gridPoleSide: -1, note: 'auditor: 2025 timing grid wholly ahead of the game line (pole +180 m), FIA "Pole RHS"; my imagery check was inconclusive; needs js/track.js pole-side support' } });
C['qa-2004'] = minor('minor issues', { verification: [V('length', 'verified (minor)', 'Length 5.380 is the 2004-2022 figure', 'FIA 2025 Qatar circuit map text: "Circuit Centreline Length = 5.419km"; dataset geodesic 5421 m, built 5382 m (-0.7 %).')], optional: { LENGTH_OVERRIDE_M: 5419 } });
C['tr-2005'] = minor('minor issues', { optional: { START_AT: [40.95222, 29.4063884], elevation: 'GLO-30 profile (hilltop 6-7 m higher)', pitLaneReal: pc('tr-2005').pit } });
C['ru-2014'] = minor('minor issues', { verification: [V('pit', 'verified (minor)', 'Pit limit 60 km/h', 'FIA 2021 Russian GP event notes (cached text): "The Pit lane Speed limit ... is hereby amended to 60km/h for the duration of the Event".')], apply: { PIT_FACTS: { limitKmh: 60 } }, optional: { elevationScaleToRangeM: 1.9 } });
C['us-2012'] = minor('minor issues', { optional: { START_AT: [30.131893, -97.6398291], sceneryOverpasses: pc('us-2012').bridgesOverTrack, pitLaneReal: pc('us-2012').pitLane } , notes: 'USGS lidar profile good (rms 0.15 m); only T1 has a real 4.3 deg camber' });
C['us-2023'] = minor('minor issues', { optional: { START_AT: pc('us-2023').START_AT, START_AT_note: 'OSM raceway=start node 92 m before the game line; the control line is 92 m further back', sceneryOverpasses: pc('us-2023').bridgesOverTrack, derivedBankMaxDeg: 1.5 } });
C['us-1909'] = minor('minor issues', { optional: { sceneryOverpasses: pc('us-1909').bridgesOverTrack, derivedBankScale: 0.3 }, notes: 'T13 9.2 deg override confirmed by lidar (8.4-8.8); dataset line follows OSM within 2.8 m but is 4084 m geodesic, built 4191 m (+2.6 %) to match 4.192 km: consider no rescale' });
C['us-1956'] = minor('minor issues', { optional: { BANKED: pc('us-1956').bankOverrides, COVERED: pc('us-1956').COVERED, sceneryOverpasses: pc('us-1956').bridgesOverTrack }, notes: 'real 4-6 deg superelevation everywhere (lidar), under-banked in the game; historic venue' });

// ---------------------------------------------------------------- write
const order = window.F1_TRACKS.map((t) => t.id);
const circuits = {};
for (const id of order) {
  const c = C[id]; if (!c) throw new Error('missing ' + id);
  const T = L.td(id);
  const o = Object.assign({ name: T.name, auditFile: `devtests/track-audit/${id}.json` }, c);
  // consistency checks of every START_AT / BANKED / COVERED position against the built lap
  const checks = {};
  for (const sec of ['apply', 'optional']) {
    const x = o[sec]; if (!x) continue;
    if (Array.isArray(x.START_AT)) checks[sec + '.START_AT'] = where(id, x.START_AT);
    for (const k of ['BANKED', 'BANKED_add', 'COVERED']) if (Array.isArray(x[k])) checks[sec + '.' + k] = x[k].filter((b) => b.from).map((b) => ({ name: b.name, from: where(id, b.from), to: where(id, b.to) }));
  }
  if (Object.keys(checks).length) o.positionCheck = checks;
  circuits[id] = o;
}

const out = {
  about: {
    what: 'Verified corrections of the 40 circuits\' track data (2026-10-01 audit), for tools/build-tracks.mjs to apply later. Nothing here is applied yet.',
    howMade: 'Nine auditors measured every circuit (devtests/track-audit/<id>.json); the synthesis re-measured every major finding independently (devtests/track-audit/verify/: own DEM sampling on the built centreline, fresh OSM API queries, re-read sources, imagery). Minor findings are carried as "optional" with the auditor\'s evidence unless a verification line says otherwise.',
    report: 'docs/track-audit.md',
    conventions: { latLon: '[lat, lon] WGS84', BANKED: 'same as tools/build-tracks.mjs BANKED: {name, deg, from, to}, deg > 0 = inside of the corner lower, < 0 = contra-banked; js/track.js skips deg 0', START_AT: 'same as tools/build-tracks.mjs START_AT', COVERED: 'same as tools/build-tracks.mjs COVERED', positionCheck: 'every START_AT / BANKED / COVERED point projected on the current built lap: sFromLineM (negative = before the line) and offCentrelineM (should be < 25-30 m)' },
    afterApplying: ['node tools/build-tracks.mjs (fetches the new DEM samples; caches them)', 'node tools/build-scenery.mjs only where points / geo change (au-1953, pt-1972, es-2026 length, az-2016 width)', 'node devtests/seasons-calib/calibrate.mjs (~22 min) and node tools/build-cars.mjs --check', 'all node suites and the Electron harnesses'],
  },
  global: {
    derivedBanking: {
      finding: 'js/track.js derives up to 6 deg (BANK_MAX) inside-lower bank from curvature at every slow corner. Lidar cross-slopes at 14 circuits (Spa, Zandvoort, Hockenheim, Nürburgring, Silverstone, Imola, Mugello, Red Bull Ring, COTA, Las Vegas, Miami, Indianapolis, Watkins Glen, Montreal) measure 0-2.4 deg in hairpins and chicanes where the game has 3.5-6 deg; real cambers of 4-7 deg exist only in specific corners (Zandvoort Tarzan / Hunserug / Scheivlak, Nürburgring Goodyear-Kehre, Mugello Arrabbiata 1, Hockenheim Sachs-Kurve, COTA T1, Watkins Glen) and are rendered at 1-3 deg.',
      recommend: { derivedBankMaxDeg: 2.5, streetCircuitsDeg: 1.5, streetCircuits: ['mc-1929', 'sg-2008', 'az-2016', 'us-2023', 'sa-2021', 'ca-1978', 'au-1953', 'ru-2014', 'us-2022', 'es-2026'], keep: 'all BANKED overrides (published) plus the lidar-measured ones listed per circuit', why: 'faithful, and the real banked corners (Zandvoort 19 / 18, Madring 13.5, Jeddah 12, Indy 9.2) stand out against flat corners: the user said the banking is not felt' },
      cost: 'changes cornering everywhere -> recalibrate',
    },
    phantomBridges: {
      finding: 'js/scenery.js addBridge() builds an OSM man_made=bridge outline that contains the lap as a deck OVER the road even when the outline is the lap\'s own deck over an underpass. Game-wide check (verify/decks.js + decks-osm.js): 11 decks are built over the road; 6 are phantoms (be-1925 1353164215, nl-1948 765476850, de-1932 1302356195 / 1302600377 / 1302600378, de-1927 790945811), 5 are real (de-1927 BMW-Brücke 34444288, gb-1948 605922107 Hangar Straight, ae-2009 1473728620 and 1473750056 Marina Walk, us-2023 1419057401 Las Vegas Boulevard Overpass).',
      rule: 'tools/build-scenery.mjs: drop a man_made=bridge outline that contains the lap centreline when a raceway way inside it is bridge=yes, or a tunnel=* / layer<0 way crosses the lap inside it and no non-raceway way with a HIGHER layer than the lap crosses it.',
    },
    missingOverpasses: {
      finding: 'build-scenery only takes man_made=bridge AREAS, so linear bridge ways that cross over the lap are missing (Montreal bridge underpass before T8 [major], Marina Bay ECP viaduct [major], Yas W hotel link [major, building:part], Miami Turnpike ramps, Las Vegas monorail + Strip footbridges, footbridges at COTA, Indianapolis, Watkins Glen, Mexico, Interlagos, Jeddah, Baku, Imola, Mugello, Monza, Hungaroring, Shanghai wings).',
      rule: 'tools/build-scenery.mjs: also emit decks for highway / railway ways with bridge=* and layer > lap layer that cross the lap (buffered to their width, deck underside >= 6.5 m above the road), and for building / building:part with min_height >= 5 m that span the corridor.',
    },
    lengthRescale: {
      finding: 'tools/build-tracks.mjs rescales each line to the dataset\'s "length" property (up to 15 %). Built length vs the line\'s own geodesic length: pt-1972 +4.4 %, us-1909 +2.6 %, br-1977 +1.5 %, fr-1960 -1.1 %, az-2016 +1.0 %, es-2026 +0.85 %, ar-1952 +0.7 %, qa-2004 -0.7 %, tr-2005 +0.6 %; all others within 0.4 %.',
      recommend: 'LENGTH_OVERRIDE_M where the official figure is sourced for the drawn layout (es-2026 5414, qa-2004 5419, ar-1952 4259); no rescale where the figure belongs to another layout (pt-1972). kz = 110540 m/deg is 0.3-0.6 % short of WGS84 at these latitudes (cosmetic).',
    },
    pitLanes: {
      finding: 'Every pit lane is a generic lane within PIT_REACH = 250 m of the line. Real F1 lanes (OSM) are 569-1373 m and leave 170-890 m before the line. Sides are right everywhere they could be checked; limits: 80 km/h except Monaco 60, Singapore 60 until 2024, Zandvoort 60 until 2024, Sochi 60.',
      recommend: 'optional new track inputs pitEntry / pitExit [lat, lon] (listed per circuit as pitLaneReal) and per-season limits; pit-stop time loss is too small today.',
    },
    presentation: {
      note: 'Not track data (js/cockpit.js, js/car.js, js/track.js); from the perception analyst (devtests/track-audit/perception/), code facts re-checked in the synthesis.',
      verifiedCodeFacts: ['js/cockpit.js FOV_MIN 70 / FOV_MAX 82 (vertical), smoothstep to V_TOP 330 km/h', 'group.rotation.set(-(state.pitch), heading, state.roll): the camera is a child of the cockpit group, so view pitch / roll = car pitch / roll; the camera adds only look, shake and a 0.006 m + 0.005 rad per g lean', 'js/car.js has no seat-load output (no seatG); ATTITUDE_TAU 0.07 s', 'geometry: a 28 deg tall monitor showing an 80 deg vertical FOV draws angles near the centre at tan(14)/tan(40) = 0.30 of their size: 15 % (8.5 deg) reads like ~4.5 %'],
      recommend: [{ what: 'FOV', change: 'FOV_MIN 70 -> 58, FOV_MAX 82 -> 62 (vertical) + a 視野 50-75 deg setting', measured: '10.5 px/deg instead of 7.3 at 280 km/h; the Raidillon climb 39 -> 56 px', sideEffect: 'the steering-wheel display sits lower, partly behind the bottom HUD panel' }, { what: 'horizon stabilisation', change: 'a head Object3D between group and camera: head.rotation.x = +0.5 * pitch, head.rotation.z = -0.4 * roll, setting 地平線穩定 0-100 % (0 = today); mirrors untouched' }, { what: 'seat load', change: 'car.js exports state.seatG = (g cos - kappa v^2 - aLeft sin) / g and longG; cockpit head spring 2.2 Hz, damping 0.45, 0.03 m drop + 1.5 deg nod per g, 17 Hz bump-stop buzz above 0.3 g' }, { what: 'banking cues', change: 'world-vertical fence posts (3 m, every 4 m) on stretches with |bank| > 8 deg; track.js stamp(): carry the banked plane 15-20 m beyond the outer wall' }, { what: 'Spa profile', change: 'the walmnt elevation source (be-1925): the compression at the Eau Rouge bottom only exists in the lidar profile' }],
    },
    timingHeights: 'F1 live-timing car heights validate the lidar (Imola rms 0.55 m) but are FOM data: use only for validation unless the licence is cleared.',
  },
  newElevationSources: SOURCES,
  circuits,
};
fs.writeFileSync(path.join(L.ROOT, 'tools', 'track-audit.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote tools/track-audit.json', (JSON.stringify(out).length / 1024).toFixed(0) + ' kB', Object.keys(circuits).length, 'circuits');
for (const [id, c] of Object.entries(circuits)) if (c.positionCheck) for (const [k, v] of Object.entries(c.positionCheck)) {
  const arr = Array.isArray(v) ? v : [{ name: 'START_AT', from: v }];
  for (const b of arr) for (const e of [b.from, b.to]) if (e && e.offCentrelineM > 25) console.log('  WARN', id, k, b.name, JSON.stringify(e));
}
