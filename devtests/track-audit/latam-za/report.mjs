// node devtests/track-audit/latam-za/report.mjs [id ...]
// Writes devtests/track-audit/<id>.json for the latam-za circuits from the measurements in out/ (game-dump.js,
// osm-compare.mjs, dem-profiles.mjs, analyze.mjs, radius.mjs) and the findings below (every "real" value with its
// source). Read-only on the game.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url)), OUTDIR = resolve(HERE, '..');
const J = (f) => JSON.parse(readFileSync(resolve(HERE, f), 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

const SRC = {
  osm: 'OpenStreetMap (ODbL), Overpass query cached in devtests/track-audit/cache/overpass/<id>.json (2026-10-01)',
  fia26: 'FIA 2026 Formula 1 Regulations, Section B Sporting, issue 04 (2025-12-10), "Driving in the Pit Entry Road, Pit Lane And Pit Exit Road" a.: "A speed limit of 80km/h will be imposed in the Pit Lane during the whole Competition" (https://www.fia.com/system/files/documents/fia_2026_f1_regulations_-_section_b_sporting_-_iss_04_-_2025-12-10_0.pdf; copy in devtests/track-audit/cache/web/latam-za/)',
  pitstopWiki: 'en.wikipedia.org/wiki/Pit_stop: after the 1994 San Marino GP "the pit lane speed limit was introduced in Formula One" (ref/en-Pit_stop.wiki)',
  glo30: 'Copernicus DEM GLO-30 (DSM, 30 m), AWS open data COGs s3://copernicus-dem-30m (cache/glo30/)',
  srtm: 'NASA SRTM GL1 v3 30 m via api.opentopodata.org/v1/srtm30m (cache/opentopodata/srtm30m/)',
  geosampa: 'GeoSampa, Prefeitura de São Paulo, Mapa Digital da Cidade: 1 m contours (geoportal:curva_intermediaria, geoportal:curva_mestra) + spot heights (geoportal:ponto_cotado), WFS https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wfs (cache/geosampa/)',
};

// ------------------------------------------------------------------ per-circuit facts and findings
const CIRCUITS = {
  'mx-1962': {
    verdict: 'minor issues',
    layoutNote: 'Grand Prix circuit 2015-present (F1 2015-2019, 2021-2026): 4.304 km, 17 turns, through the baseball stadium and only the second half of the Peraltada.',
    official: { lengthKm: 4.304, src: 'en.wikipedia.org/wiki/Autódromo_Hermanos_Rodríguez infobox "Grand Prix Circuit (2015–present)" length_km 4.304; MexicoGP press release 2022-10-06 "Actualmente es de 4.304 kilómetros" (cache/web/latam-za/mexicogp-nombres-curvas-2022.pdf)' },
    direction: { real: 'clockwise', src: 'MexicoGP press release 2022-10-06: at the end of the >1 km straight "se encuentra una curva a la derecha, la curva número 1"; every OSM racing way is oneway=yes and all 2149 game samples near them run with them (out/osm-mx-1962.json)' },
    pitReal: { side: 'right', limitKmh: 80, wayIds: [638504647, 772763791], src: [SRC.osm + ': ways 638504647 + 772763791 "Pit Lane" (oneway)', SRC.fia26] },
    published: null,
    findings: [
      { aspect: 'bridge', severity: 'minor',
        game: 'No overhead structure where the car passes under bridges: the 3 scenery-data bridges of mx-1962 are 290-317 m from the centreline (the Circuito Interior viaduct).',
        real: 'Six overpasses cross the racing line (OSM, layer 1): footbridges at s 444, 834, 1505, 1811 and 3979 m (ways 736211972, 736211974, 736211970, 736211978, 54241135) and the Calle 63 road bridge at s 856 m (way 685930807), i.e. two over the main straight, one before T4, one on the back straight, one in the stadium section.',
        proposedFix: 'Scenery: draw a deck (and piers outside the walls) for every OSM bridge=yes way that crosses the centreline (list in crossings[] of this file); the crossing points are machine-readable in proposedCorrections.overpasses.',
        sources: [SRC.osm] },
      { aspect: 'pit', severity: 'minor',
        game: 'track.pit: right side (-1), 80 km/h, lane from s 4165 to s 250 (entry line s 4251, exit line s 164): ~385 m, symmetric about the line.',
        real: 'Right side, 80 km/h. The OSM pit lane (583 m + 212 m pit-exit way) leaves the track at s 3991 (300 m before points[0]) and rejoins at s 506 (506 m after it).',
        proposedFix: 'pitLane entry / exit positions in proposedCorrections.pitLane (needs a per-track reach longer than PIT_REACH = 250 m in js/track.js); side and limit already right.',
        sources: [SRC.osm, SRC.fia26] },
      { aspect: 'start', severity: 'cosmetic',
        game: 'points[0] (start / finish of the game) at 19.4062264, -99.0943376.',
        real: 'OSM node 13826403209 "Start Line" is 72.6 m further on (1.7 m off the centreline); node 5070396402 "Finish Line" is 61.5 m before points[0]. The game line lies between the two.',
        proposedFix: 'Optional START_AT["mx-1962"] = the "Start Line" node 13826403209 (coordinates in proposedCorrections.START_AT) so that the grid stands behind the real start line; the game timing line would then be 134 m after the real finish line instead of 61.5 m.',
        sources: [SRC.osm] },
      { aspect: 'other', severity: 'minor',
        game: 'Tightest corner: T5, the right-hander after the left-hand T4 (~110 deg, s 2052-2090): centreline radius 10.8 m measured over +-6 m, 14.2 m over +-18 m; js/track.js banks it 5.7 deg.',
        real: 'OSM centreline radius over the same +-18 m stencil: 16.4 m (2.2 m wider). The game line is a little tighter than the real road, and at ~11 m it is right at the car\'s 10 m minimum turning radius (docs/v6-plan.md, the Monaco hairpin problem).',
        proposedFix: 'None in the data (2 m); covered by the planned v6.2 steering-law fix. Re-test this corner with it.',
        sources: [SRC.osm, 'devtests/track-audit/latam-za/out/radius-mx-1962.json'] },
      { aspect: 'banking', severity: 'cosmetic',
        game: 'Peraltada (T17 "Nigel Mansell", s 4051-4151, R ~79 m): derived bank 3.0 deg (no bankOverrides).',
        real: 'Sources disagree: De Cero a 100 (2022-10-23): 15 deg originally, 9 deg from 1986, then lowered to 3 deg after Senna\'s 1991 crash "lo que tiene actualmente"; MexicoGP press release (2022-10-06): "cambió de 13 a 8.5 grados de peralte" with the 1986 works (no later figure). en.wikipedia only says "slightly banked".',
        proposedFix: 'No change (the derived 3.0 deg equals the only figure given as current). If wanted, pin it: bankOverrides {name: "T17 Peraltada", deg: 3} over the corner (proposedCorrections.bankOverrides).',
        sources: ['https://www.deceroacien.com.mx/f1/2022/10/23/autodromo-hermanos-rodriguez-asi-ha-evolucionado-de-1959-la-fecha-3277.html', 'https://www.mexicogp.mx/wp-content/uploads/files_mf/1664897614221003NombredelascurvasyrectasAHR.pdf', 'en.wikipedia.org/wiki/Autódromo_Hermanos_Rodríguez'] },
      { aspect: 'elevation', severity: 'cosmetic',
        game: 'Range 5.7 m, steepest 100 m grades +2.3 % (s 870) / -2.5 % (s 3509); highest point at s 3413, before T12.',
        real: 'No bare-earth model found (INEGI lidar has no open point service). GLO-30 (DSM): 4.3 m range, but its shape does not match the game\'s (r = 0.41, RMS 1.2 m, max 3.4 m); SRTM 30 m is unusable here (23 m of stands / trees, r = 0.06). Nothing contradicts a few metres of relief; nothing confirms the game\'s shape either.',
        proposedFix: 'None required. If the hump in the stadium section matters, a GLO-30 profile (proposedCorrections.elevationProfileCandidate, smoothed) is no worse than GLO-90.',
        sources: [SRC.glo30, SRC.srtm] },
    ],
    extra: { cornerNames: 'MexicoGP 2022-10-06: T1-T3 "Complejo Moisés Solana", straight T3-T4 "Recta Jim Clark", T4 "la presidencial", T6 "Recorte Rebaque", T12 "Adrián Fernández", T17 "Nigel Mansell" (the remaining half of the Peraltada).' },
  },
  'br-1940': {
    verdict: 'major issues',
    layoutNote: 'Grand Prix circuit 1999-present (5th variation, 4.309 km, 15 turns), the layout of every Brazilian / São Paulo GP 2010-2026.',
    official: { lengthKm: 4.309, src: 'en.wikipedia.org/wiki/Interlagos_Circuit infobox "Grand Prix Circuit (5th Variation) (1999–present)" length_km 4.309' },
    direction: { real: 'anticlockwise', src: 'pt.wikipedia.org/wiki/Autódromo_de_Interlagos: "O circuito tem sentido anti-horário"; all 2152 game samples near oneway OSM ways run with them' },
    pitReal: { side: 'left', limitKmh: 80, wayIds: [33779109], src: [SRC.osm + ': way 33779109 "Pit Lane" (oneway, 1373 m)', 'en.wikipedia.org/wiki/Interlagos_Circuit "Pit lane": "one of the longest pit-lanes ever used in Formula One, starting just before the start-finish straight and rejoining the main course after Curva do Sol"', SRC.fia26] },
    published: { rangeM: 43.0, src: 'pt.wikipedia.org/wiki/Autódromo_de_Interlagos infobox: "Elevação (máx)=43.0 metros"; en.wikipedia.org/wiki/Interlagos_Circuit: Subida dos Boxes "a long uphill left turn with a gradient of 10%", the start "long straight with an upward inclination", S do Senna "a pair of alternating downward turns", Descida do Lago "a pair of downhill left turns", then "a short straight section that climbs up towards the back of the pit buildings"' },
    findings: [
      { aspect: 'elevation', severity: 'major',
        game: 'Range 44.9 m (GLO-90). Height error against the bare-earth GeoSampa profile: RMS 4.3 m, up to 9.6 m. (1) S do Senna: steepest descent -9.1 % (50 m) / -8.8 % (100 m) at s 408-414, and the drop goes on down the Reta Oposta (game 7-10 m too low on s 700-1450). (2) Descida do Lago (T4-T5, s 1404-1632): -0.6 % (flat). (3) Climb after it (s 1770-1860): +2.1 %. (4) Bico de Pato (T10, s 2540-2870): a 9 m hill that is not there, +11.5 % / -9.1 %. (5) Junção (s 3120-3185): -1.8 % (wrong sign). (6) Start straight before the line (s 4205-4289): -0.6 %, so the highest point of the lap is at T14-T15 (s 3815) instead of at the top of the straight. (7) Mergulho T11: -6.2 % / -5.8 %.',
        real: 'GeoSampa 1 m contours + spot heights along the OSM centreline: range 42.8 m (published: 43.0 m). Highest point at the top of the start straight, s 222, just before S do Senna; lowest at T5 Descida do Lago (s 1536). (1) S do Senna T1: -12.9 % over 50 m / -12.1 % over 100 m at s 360, then only -2 % along Curva do Sol and the Reta Oposta. (2) Descida do Lago: -6.7 % / -6.4 % at s 1434-1440. (3) +6.3 % (100 m) at s 1824. (4) Bico de Pato: +5.6 % (50 m) max, a 3 m rise. (5) Junção: +2.5 %. (6) Start straight: +2.6..2.8 % (100 m) at s 4205-4289, +7.4 m from s 4127 to s 240. (7) Mergulho: -9.5 % / -9.2 % at s 2975. Steepest climb 9.9 % (50 m) / 9.7 % (100 m) at T13 Café / Subida dos Boxes, matching the published 10 % (the game has 9.5 % at s 3539, ~100 m later). GLO-30 agrees with GeoSampa (same features, range 44.3 m); every stretch above is also confirmed by GLO-30 and SRTM (consensus[] in this file).',
        proposedFix: 'Replace the profile: proposedCorrections.elevationProfile = the GeoSampa profile (lat, lon, height above the lowest point, every ~12 m along the OSM centreline; build-tracks.mjs would project each point on the centreline and interpolate, then its DTM smoothing). Second choice if a generic source is preferred: Copernicus GLO-30 read from the AWS COGs (devtests/track-audit/latam-za/glo30.mjs) with the DTM filters - it reproduces S do Senna (-11.7 %), Descida do Lago and the start-straight climb; its Bico de Pato is 3.5 m high (trees).',
        sources: [SRC.geosampa, SRC.glo30, SRC.srtm, 'pt.wikipedia.org/wiki/Autódromo_de_Interlagos', 'en.wikipedia.org/wiki/Interlagos_Circuit'] },
      { aspect: 'pit', severity: 'minor',
        game: 'track.pit: left side (+1), 80 km/h, lane from s 4057 to s 250 (entry line s 4143 = 164 m before the line, exit line s 164).',
        real: 'Left side, 80 km/h. The real pit lane (OSM way 33779109, 1373 m) leaves the track at s 3847 (462 m before the line, at the exit of T14 Subida dos Boxes) and rejoins at s 983, on the Reta Oposta after T3 Curva do Sol - one of the longest pit lanes in F1.',
        proposedFix: 'proposedCorrections.pitLane entry / exit (needs a per-track reach; PIT_REACH is 250 m).',
        sources: [SRC.osm, 'en.wikipedia.org/wiki/Interlagos_Circuit', SRC.fia26] },
      { aspect: 'bridge', severity: 'minor',
        game: 'No structure over the track (scenery-data.js has no bridge near br-1940).',
        real: 'A footbridge crosses the start straight at s 260 (OSM way 189535484, bridge=yes, layer 1), just before the braking point of S do Senna.',
        proposedFix: 'Scenery: deck over the road at the OSM crossing (proposedCorrections.overpasses).',
        sources: [SRC.osm] },
      { aspect: 'layout', severity: 'cosmetic',
        game: 'Centreline vs OSM: max 10.5 m (s 4071-4125, T15 Arquibancadas), mean 4.2 m, p95 8.5 m; 3.3 m mean offset to the east; true length of the game line 4282 m, game lap 4307 m.',
        real: 'OSM racing line of the 1999+ layout: 4302 m; official 4.309 km. Same layout, same corners; the dataset is just a little coarse.',
        proposedFix: 'None needed.',
        sources: [SRC.osm, 'en.wikipedia.org/wiki/Interlagos_Circuit'] },
    ],
  },
  'br-1977': {
    verdict: 'minor issues',
    layoutNote: 'Grand Prix circuit 1978-1994 (5.031 km): F1 Brazilian GP 1978 and 1981-1989. Not an F1 venue in 2010-2026: shortened for the 2007 Pan-American Games (Curva Norte removed), closed and demolished in 2012 for the Rio 2016 Olympic Park.',
    official: { lengthKm: 5.031, src: 'pt.wikipedia.org/wiki/Autódromo_de_Jacarepaguá infobox "Circuito Grande Prêmio (1978–1994)" comprimento 5 031 km; demolition and Pan-American 2007 changes: same article' },
    direction: { real: 'anticlockwise (inferred)', src: 'pt.wikipedia.org/wiki/Autódromo_de_Jacarepaguá "Curvas": Carlos Pace, Suspiro, Norte (hairpin), Lagoa and Morette are left-handers, Girão is the only right named; the game\'s lap has the same order (right-handers at the start, long left hairpin at s ~1690 = Norte, Girão-Morette right-left at s 3245-3511, Lagoa left at s 3737)' },
    pitReal: { side: 'unknown', limitKmh: null, src: [SRC.pitstopWiki] },
    published: null,
    findings: [
      { aspect: 'elevation', severity: 'minor',
        game: 'Range 5.6 m; the only relief is a 5 m hump at s 1560-1800 (approach to and exit of the Curva Norte hairpin, +3.3 % / -2.3 % over 100 m); elsewhere within 2 m.',
        real: 'The hump is the 2007 Pan-American arena that replaced the Curva Norte: GLO-30 (TanDEM-X 2011-2015, the same acquisitions as the game\'s GLO-90) reads a 15-18 m building there (s 1500-1680). SRTM (February 2000, circuit intact) has no hump there (4-7 m along the whole lap, +-3 m noise). The venue is a coastal lowland (dataset altitude 3 m).',
        proposedFix: 'Add br-1977 to FLAT_TRACKS in tools/build-tracks.mjs (heavy smoothing, range capped at 4 m), or take the elevation from SRTM 30 m (pre-demolition) instead of GLO-90 (proposedCorrections.flatTrack).',
        sources: [SRC.glo30, SRC.srtm, 'pt.wikipedia.org/wiki/Autódromo_de_Jacarepaguá'] },
      { aspect: 'layout', severity: 'cosmetic',
        game: 'Dataset layout: 5.035 km lap, 23 corners, anticlockwise.',
        real: 'Cannot be checked against OpenStreetMap: the circuit was demolished in 2012 (no raceway ways remain). OpenHistoricalMap has only 3 rough ways traced from a Wikipedia image of the later short circuit (cache/ohm/br-1977.json); they lie within 1-30 m of the game line where they share the road and up to 300 m away elsewhere. The lap length matches the official 5.031 km (+0.1 %).',
        proposedFix: 'None (no better geometry source found).',
        sources: ['https://www.openhistoricalmap.org (ways 201155530-201155532, CC0)', 'pt.wikipedia.org/wiki/Autódromo_de_Jacarepaguá'] },
      { aspect: 'pit', severity: 'cosmetic',
        game: 'track.pit: left side (+1), 80 km/h.',
        real: 'Side not verifiable (demolished, no OSM pit way). Formula One had no pit-lane speed limit until 1994, after the circuit\'s last GP (1989).',
        proposedFix: 'None.',
        sources: [SRC.pitstopWiki] },
    ],
  },
  'ar-1952': {
    verdict: 'minor issues',
    layoutNote: 'Circuit No. 6 with the Senna S (4.259 km), used by F1 1995-1998. Not an F1 venue 2010-2026. es.wikipedia: works started 2026-01-19 (pits demolished, track being reshaped); OSM still shows the pre-2026 track.',
    official: { lengthKm: 4.259, src: 'en.wikipedia.org/wiki/Autódromo_Oscar_y_Juan_Gálvez infobox "No. 6 circuit with Senna S (1995–present)" 4.259 km, "No.6 with Senna S for 1995–1998"; es.wikipedia: "Circuito N.º 6 (4.259,45 metros)"' },
    direction: { real: 'clockwise', src: 'es.wikipedia.org/wiki/Autódromo_Oscar_y_Juan_Gálvez, recorrido of the Senna-S variant (No. 9): "Recta principal, Curva 1, Curva de la confitería, Curva 8, Recta Opuesta, retome de la Chicana de Ascari, Entrada a los Mixtos, Vivorita, Curvas del Ombu y del Cajon, S de Senna, Horquilla Parga" - the game passes the OSM corners in this order (Numero Uno s 334, Confitería 780, Numero 8 1314, Ascari 1968, Entrata a los Mixtos 2331, Viborita 2505, Ombú 2625, S de Senna 3165, Horquilla 3671)' },
    pitReal: { side: 'right', limitKmh: null, wayIds: [48747026], src: [SRC.osm + ': way 48747026 "Boxes" (645 m) beside the main straight'] },
    published: null,
    findings: [
      { aspect: 'length', severity: 'minor',
        game: 'lengthKm 4.325 (the dataset\'s 4.322 km: the geometry, 4.286 km true, is scaled up by 0.9 %).',
        real: 'Official 4.259 km (No. 6 with Senna S); the OSM racing line of the same layout measures 4.278 km. The game lap is 1.5 % longer than the official one, every corner 0.9 % larger than the real road.',
        proposedFix: 'Official length override 4259 m for ar-1952 in build-tracks (the rescale then shrinks the geometry by 0.6 % instead of enlarging it by 0.9 %), or no rescale at all for this circuit (proposedCorrections.officialLengthM).',
        sources: ['en.wikipedia.org/wiki/Autódromo_Oscar_y_Juan_Gálvez', 'es.wikipedia.org/wiki/Autódromo_Oscar_y_Juan_Gálvez', SRC.osm] },
      { aspect: 'pit', severity: 'minor',
        game: 'track.pit: right side (-1), 80 km/h, lane from s 4075 to s 250 (entry line s 4161, exit line s 164).',
        real: 'Right side: the OSM "Boxes" way (645 m) leaves the track at s 3864 (461 m before points[0]) and rejoins at s 209. (No F1 limit figure found for 1995-1998; 80 km/h kept.)',
        proposedFix: 'proposedCorrections.pitLane entry / exit.',
        sources: [SRC.osm] },
      { aspect: 'start', severity: 'cosmetic',
        game: 'points[0] at -34.6940483, -58.4612563.',
        real: 'OSM node 9311100671 raceway=start-finish lies 68.2 m before it (0.4 m off the centreline).',
        proposedFix: 'START_AT["ar-1952"] = that node (proposedCorrections.START_AT).',
        sources: [SRC.osm] },
    ],
  },
  'za-1961': {
    verdict: 'minor issues',
    layoutNote: 'Current circuit, rebuilt 2015-2016 (4.522 km official / 4.529 km Wikipedia, 16 turns, anticlockwise). F1 never raced it: the 1992-1993 South African GPs used the 4.261 km layout. Not an F1 venue 2010-2026.',
    official: { lengthKm: 4.522, src: 'kyalamigrandprixcircuit.com/grand-prix-circuit/: "4.522 km, 16-turn anti-clockwise Grand Prix circuit", "Pole Positions: Left side", "Number of pit garages: 40"; en.wikipedia.org/wiki/Kyalami: "Grand Prix Circuit (2015–present)" 4.529 km, "Grand Prix Circuit (1992–1993 and 2009–2015)" 4.261 km (cache/web/latam-za/kyalami-grand-prix-circuit.html, latam-za/ref/en-Kyalami.wiki)' },
    direction: { real: 'anticlockwise', src: 'kyalamigrandprixcircuit.com/grand-prix-circuit/: "Track run/direction: Anticlockwise"; all 2266 game samples run with the oneway OSM ways' },
    pitReal: { side: 'left', limitKmh: null, wayIds: [793806972], src: [SRC.osm + ': way 793806972 "Grand Prix Pit Lane" (oneway, 569 m)', 'kyalamigrandprixcircuit.com: pole position on the left', SRC.pitstopWiki] },
    published: null,
    findings: [
      { aspect: 'elevation', severity: 'minor',
        game: 'Range 50.2 m. Leeukop (T9, s 2830) is the top at 50.2 m, reached by a +10.8 % (100 m) / +12.9 % climb (s 2650-2790) and left by -7.6 % (s 2840-2920); The Crocodiles -6.4 % (s 3690-3820); the climb through Crowthorne (s 606-660) +2.8 %.',
        real: 'No terrain model or published figure; two surface models agree on: Leeukop crest ~7 m lower (at s 2832, both aligned to the game by their median difference: GLO-30 43.1 m, SRTM 42.3 m against 50.2 m in the game), climb to it +6.8 / +6.9 % (100 m), nearly level after the crest (-2.1 / +1.3 %), Crocodiles -2.2 / -1.5 %, Crowthorne climb +9.7 / +5.5 %. Smoothed ranges 44.1 m (GLO-30) and 47.6 m (SRTM); RMS 3.2 / 2.9 m, max 8.0 / 8.3 m against the game.',
        proposedFix: 'proposedCorrections.elevationProfileCandidate: the mean of the GLO-30 and SRTM profiles (aligned, median 42 m + Gaussian 20 m), relative heights every ~12 m along the OSM centreline. It removes the 7 m Leeukop overshoot; it is still a surface-model profile (no lidar for Gauteng found).',
        sources: [SRC.glo30, SRC.srtm, SRC.osm] },
      { aspect: 'layout', severity: 'cosmetic',
        game: 'The 2015+ layout (game lap 4.531 km): within 4.6 m of OSM (mean 1.7 m), OSM loop 4.509 km.',
        real: 'The current circuit is 4.522 km (official). F1 raced the 4.261 km 1992-1993 layout (and 4.104 km 1968-1985, clockwise).',
        proposedFix: 'None (layout note: label it as the current circuit, not an F1 GP layout).',
        sources: ['kyalamigrandprixcircuit.com/grand-prix-circuit/', 'en.wikipedia.org/wiki/Kyalami', SRC.osm] },
      { aspect: 'pit', severity: 'minor',
        game: 'track.pit: left side (+1), 80 km/h, lane from s 4298 to s 250 (entry line s 4384, exit line s 164).',
        real: 'Left side. The OSM "Grand Prix Pit Lane" leaves the track at s 4079 (452 m before points[0]) and rejoins at s 180. No published pit speed limit found (F1 had none in 1992-1993).',
        proposedFix: 'proposedCorrections.pitLane entry / exit.',
        sources: [SRC.osm, SRC.pitstopWiki] },
      { aspect: 'start', severity: 'cosmetic',
        game: 'points[0] at -25.9987792, 28.0699211.',
        real: 'OSM node 2331688961 raceway=start-finish is 14.1 m further on.',
        proposedFix: 'Optional START_AT["za-1961"] = that node.',
        sources: [SRC.osm] },
    ],
  },
};
const GENERIC_BANK = { aspect: 'banking', severity: 'cosmetic',
  proposedFix: 'None in the data; if real-banking corners should stand out more (the Zandvoort / Madring complaint), consider lowering BANK_MAX for curvature-derived banking so that unbanked hairpins do not look banked.',
  sources: ['js/track.js BANK_MAX / BANK_GAIN', SRC.osm] };

// ------------------------------------------------------------------ helpers
function pitReal(id, osm, game) {
  const L = game.trackLength, ways = osm.pitWays || [];
  const want = CIRCUITS[id].pitReal.wayIds;
  const use = ways.filter((w) => !want || want.includes(w.way));
  if (!use.length) return null;
  // chain: entry = the first point of the way that starts on the track, exit = the last point of the way that ends on it
  const first = use.reduce((a, w) => (w.first.off < a.first.off ? w : a), use[0]).first;
  const last = use.reduce((a, w) => (w.last.off < a.last.off ? w : a), use[0]).last;
  const total = use.reduce((a, w) => a + w.length, 0);
  const signed = (s) => r1(s > L / 2 ? s - L : s);
  return { side: CIRCUITS[id].pitReal.side, limitKmh: CIRCUITS[id].pitReal.limitKmh, osmWays: use.map((w) => w.way), lengthM: r1(total),
    entry: { s: first.s, sRelLine: signed(first.s), latlon: [first.lat, first.lon], offTrackM: first.off },
    exit: { s: last.s, sRelLine: signed(last.s), latlon: [last.lat, last.lon], offTrackM: last.off } };
}
function profileOut(dem, an, keys, every = 2) {
  const o = { spacingM: r1(an.profileSpacingM * every), s: [], latlon: [], game: [] };
  for (const k of keys) o[k] = [];
  for (let j = 0; j < dem.s.length; j += every) {
    o.s.push(r1(dem.s[j])); o.latlon.push(dem.ll[j]); o.game.push(r2(dem.game[j]));
    for (const k of keys) o[k].push(dem.profiles[k][j] === null ? null : r2(dem.profiles[k][j]));
  }
  return o;
}
const wrapF = (M) => (j) => ((j % M) + M) % M;
function gauss(a, sg) { const M = a.length, w = wrapF(M), r = Math.ceil(3 * sg), k = []; let sum = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sg) ** 2); k.push(v); sum += v; } return a.map((_, j) => { let acc = 0; for (let i = -r; i <= r; i++) acc += k[i + r] * a[w(j + i)]; return acc / sum; }); }
function median(a, half) { const M = a.length, w = wrapF(M); return a.map((_, j) => { const q = []; for (let k = -half; k <= half; k++) q.push(a[w(j + k)]); q.sort((x, y) => x - y); return q[half]; }); }
function fill(a) { const M = a.length, w = wrapF(M); return a.map((v, j) => { if (v !== null) return v; let p = j, q = j; while (a[w(p)] === null) p--; while (a[w(q)] === null) q++; return a[w(p)] + (a[w(q)] - a[w(p)]) * (j - p) / (q - p); }); }
function relProfile(dem, h, every = 2) {
  const mn = Math.min(...h), pts = [];
  for (let j = 0; j < h.length; j += every) pts.push([dem.ll[j][0], dem.ll[j][1], r2(h[j] - mn)]);
  return pts;
}
function grade100(h, ds) { const M = h.length, w = wrapF(M), k = Math.max(1, Math.round(50 / ds)); return h.map((_, j) => (h[w(j + k)] - h[w(j - k)]) / (2 * k * ds)); }
function cmp(a, b) { // RMS after median offset, correlation
  const d = a.map((v, j) => v - b[j]), off = [...d].sort((x, y) => x - y)[d.length >> 1];
  const rms = Math.sqrt(d.reduce((s, v) => s + (v - off) ** 2, 0) / d.length);
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let sxy = 0, sxx = 0, syy = 0; for (let j = 0; j < a.length; j++) { sxy += (a[j] - ma) * (b[j] - mb); sxx += (a[j] - ma) ** 2; syy += (b[j] - mb) ** 2; }
  return { rmsM: r2(rms), correlation: r2(sxy / Math.sqrt(sxx * syy)) };
}

// ------------------------------------------------------------------ build
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CIRCUITS);
const summary = [];
for (const id of ids) {
  const C = CIRCUITS[id], game = J(`out/game-${id}.json`), dem = J(`out/dem-${id}.json`), an = J(`out/analysis-${id}.json`);
  const osm = existsSync(resolve(HERE, 'out', `osm-${id}.json`)) ? J(`out/osm-${id}.json`) : null;
  const rad = existsSync(resolve(HERE, 'out', `radius-${id}.json`)) ? J(`out/radius-${id}.json`) : null;
  const refKeys = Object.keys(dem.profiles).filter((k) => dem.profiles[k]);
  const ds = an.profileSpacingM;
  const corrections = {};
  // elevation candidates
  if (id === 'br-1940') {
    const h = gauss(fill(dem.profiles.geosampa), 1);          // sigma 6 m
    corrections.elevationProfile = { what: 'replace elev of br-1940 with this bare-earth profile', source: SRC.geosampa,
      format: '[lat, lon, metres above the lowest point of the lap] along the OSM centreline, racing direction from points[0], every ~12 m (Gaussian sigma 6 m on the contour profile)',
      points: relProfile(dem, h) };
    const g = gauss(median(fill(dem.profiles.glo30), 2), 2.5);
    corrections.alternative = { what: 'generic source instead: Copernicus GLO-30 (AWS COG) with DTM-like filters', vsGeosampa: cmp(g, h), vsGeosampaGameIs: cmp(dem.game, h) };
  }
  if (id === 'za-1961') {
    const g = fill(dem.profiles.glo30), s = fill(dem.profiles.srtm30m);
    const off = [...g.map((v, j) => v - s[j])].sort((a, b) => a - b)[g.length >> 1];
    let h = g.map((v, j) => (v + s[j] + off) / 2);
    h = gauss(median(h, 3), 20 / ds);
    const gg = grade100(h, ds);
    corrections.elevationProfileCandidate = { what: 'candidate elev for za-1961 (surface models only)', source: SRC.glo30 + ' + ' + SRC.srtm,
      method: 'GLO-30 and SRTM aligned by their median difference, averaged, 7-point (~42 m) median, Gaussian sigma 20 m',
      rangeM: r2(Math.max(...h) - Math.min(...h)), maxClimb100Pct: r1(Math.max(...gg) * 100), maxDescent100Pct: r1(Math.min(...gg) * 100),
      vsGame: cmp(dem.game, h), points: relProfile(dem, h) };
  }
  if (id === 'mx-1962') {
    const h = gauss(median(fill(dem.profiles.glo30), 3), 25 / ds);
    corrections.elevationProfileCandidate = { what: 'optional: GLO-30 profile for mx-1962 (surface model; the venue is nearly flat)', source: SRC.glo30,
      method: '7-point median, Gaussian sigma 25 m', rangeM: r2(Math.max(...h) - Math.min(...h)), points: relProfile(dem, h, 4) };
  }
  if (id === 'br-1977') corrections.flatTrack = { what: 'add "br-1977" to FLAT_TRACKS in tools/build-tracks.mjs (or use SRTM 2000 as its source)', why: 'the only relief in the game profile is the 2007 arena over the old Curva Norte' };
  if (id === 'ar-1952') corrections.officialLengthM = { value: 4259, why: 'dataset length 4322 is not the official No. 6 + Senna S length', src: C.official.src };
  // start
  const startNodes = osm ? osm.startNodes.filter((n) => n.lateral < 30) : [];
  if (id === 'mx-1962') { const n = startNodes.find((q) => /Start Line/.test(q.tags.name || '')); if (n) corrections.START_AT = { latlon: [n.lat, n.lon], osmNode: n.node, sRelPoints0: n.sSigned, optional: true }; }
  if (id === 'ar-1952' || id === 'za-1961') { const n = startNodes.find((q) => /start/.test(q.tags.raceway || '')); if (n) corrections.START_AT = { latlon: [n.lat, n.lon], osmNode: n.node, sRelPoints0: n.sSigned, optional: id === 'za-1961' }; }
  // pit
  const pr = osm ? pitReal(id, osm, game) : null;
  if (pr) corrections.pitLane = Object.assign({ note: 'real pit lane from OSM; js/track.js keeps the lane within PIT_REACH = 250 m of the line, so these ends need a per-track reach' }, pr);
  // overpasses
  const over = an.crossings.filter((c) => c.tags.bridge && c.tags.layer && +c.tags.layer > 0 && id !== 'br-1977');
  if (over.length) corrections.overpasses = over.map((c) => ({ s: c.s, latlon: c.at, osmWay: c.way, kind: c.tags.highway || c.tags.railway || c.tags.man_made, name: c.tags.name }));
  if (id === 'mx-1962') {
    const pc = an.corners.filter((c) => c.from_s > 4000 && c.from_s < 4200).sort((a, b) => b.turnDeg - a.turnDeg)[0];
    if (pc) { const at = (s) => game.samples.reduce((b, q) => (Math.abs(q.s - s) < Math.abs(b.s - s) ? q : b)).ll;
      corrections.bankOverrides = { optional: true, entry: { name: 'T17 Peraltada', deg: 3, from: at(pc.from_s), to: at(pc.to_s), apex: pc.at, note: 'from / to = where the radius of the game line drops below 150 m (s ' + pc.from_s + '-' + pc.to_s + '); 3 deg = the derived bank there today' } }; }
  }

  // banking note per circuit (derived bank on tight corners)
  const tight = an.corners.filter((c) => c.minRadiusM < 35).map((c) => `s ${Math.round(c.from_s)}${c.near ? ' ' + c.near : ''} R ${c.minRadiusM} m: ${Math.abs(c.gameBankDeg)} deg`);
  const findings = C.findings.slice();
  findings.push(Object.assign({}, GENERIC_BANK, {
    game: `Curvature-derived banking up to ${an.maxGameBankDeg} deg; every corner tighter than ~35 m gets 4.5-5.9 deg (${tight.slice(0, 6).join('; ')}${tight.length > 6 ? '; ...' : ''}). No bankOverrides.`,
    real: id === 'mx-1962' ? 'Only the Peraltada is documented as banked (see the banking finding above); no figure for the other corners.' : 'No banked corner is documented for this circuit (Wikipedia en / pt / es, official site); OSM ways carry no banking / incline tags.' }));

  const out = {
    id, name: game.name, auditedAt: '2026-10-01', auditor: 'devtests/track-audit/latam-za (scripts in that folder; caches in devtests/track-audit/cache/)',
    verdict: C.verdict,
    reproduce: ['node devtests/track-audit/latam-za/game-dump.js ' + id, id === 'br-1977' ? '(no OSM raceway ways: demolished; OpenHistoricalMap ways in cache/ohm/br-1977.json)' : 'node devtests/track-audit/latam-za/osm-fetch2.mjs ' + id + ' && node devtests/track-audit/latam-za/osm-compare.mjs ' + id + (({ 'br-1940': ' --pit 33779109', 'ar-1952': ' --pit 48747026' })[id] || ''),
      'node devtests/track-audit/latam-za/dem-profiles.mjs ' + id, 'node devtests/track-audit/latam-za/analyze.mjs ' + id, id === 'br-1977' ? null : 'node devtests/track-audit/latam-za/radius.mjs ' + id, 'node devtests/track-audit/latam-za/report.mjs ' + id].filter(Boolean),
    layout: { note: C.layoutNote, official: C.official, game: { lengthKmData: game.lengthKm, lapM: game.trackLength, trueGeometryM: osm ? osm.gameLengthTrueM : null, samples: game.N },
      osm: osm ? { snappedLoopM: osm.osmSnappedLoopM, deviation: osm.deviation, unusedWays: osm.unusedWays.map((u) => ({ way: u.way, name: u.tags.name, note: u.tags.note, sport: u.tags.sport, lengthM: u.length, maxDistM: u.maxDist })) } : 'no OSM raceway ways (circuit demolished)' ,
      tightestCorners: rad },
    direction: { game: game.rotation, totalTurnDeg: an.totalTurnDeg, real: C.direction.real, src: C.direction.src, osmOnewayAgree: osm ? osm.direction : null },
    startFinish: { gamePoints0: game.points0, osmNodes: startNodes },
    pit: { game: game.pit, real: pr, src: C.pitReal.src },
    elevation: {
      published: C.published,
      game: { rangeM: game.yRange, elevSource: 'GLO-90 (tracks-data.js header)', stats: an.stats.game },
      references: Object.fromEntries(refKeys.map((k) => [k, { source: dem.sources[k].label, rawRangeM: r2(Math.max(...dem.profiles[k].filter((v) => v !== null)) - Math.min(...dem.profiles[k].filter((v) => v !== null))), filtered: an.stats[k], vsGame: an.comparisons[k] }])),
      consensus: { refs: an.consensusRefs, note: 'stretches where every independent reference differs from the game\'s 100 m grade by > 2 percentage points in the same direction', stretches: an.consensus },
      filters: an.profileFilters,
      profileUsed: Object.assign({ line: dem.lineSrc }, profileOut(dem, an, refKeys)),
    },
    banking: { gameMaxDeg: an.maxGameBankDeg, corners: an.corners, bankOverrides: game.bankOverrides },
    crossings: { note: 'OSM ways with bridge / tunnel / covered that cross the game centreline (layer > 0: over the track, the car passes under; layer < 0: under the track)', list: an.crossings, sceneryDataBridges: an.sceneryBridges },
    findings,
    proposedCorrections: corrections,
    sources: [SRC.osm, ...Object.values(dem.sources).map((s) => s.label), C.official.src, C.direction.src].filter((v, i, a) => a.indexOf(v) === i),
  };
  writeFileSync(resolve(OUTDIR, `${id}.json`), JSON.stringify(out, null, 1));
  summary.push(`${id}: ${C.verdict}, ${findings.length} findings -> devtests/track-audit/${id}.json`);
}
console.log(summary.join('\n'));
