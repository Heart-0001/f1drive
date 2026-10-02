// Builds ../tracks-data.js (window.F1_TRACKS) from the open bacinger/f1-circuits dataset.
// Usage: node tools/build-tracks.mjs [path-to-local-geojson] [--dry] [--dump <file.json>] [--out <file.js>] [--check]
//   --dry   print the tables, do not write tracks-data.js;  --dump  write the per-track height profiles (raw / final)
//   --out   write somewhere else than ../tracks-data.js;  --check  build in memory and compare with the committed
//           tracks-data.js (exit 1 when they differ; nothing is written)
// No npm dependencies (uses global fetch, Node 18+).
//
// Elevation: the dataset is 2D, so ground heights are fetched for points every ~25 m (10 m for the terrain models
// below) along each centreline, cleaned (median + Gaussian + slope limit, on the closed loop) and emitted as `elev`,
// index-aligned with `points`. Default source: the Open-Meteo Elevation API (Copernicus DEM GLO-90, a 90 m SURFACE
// model: buildings, trees and grandstands are in it). Where a free bare-earth terrain model (DTM) with an open API
// covers a circuit, that is used instead (see ELEV_SOURCE / SOURCES). Every fetched height is cached (tools/elevation-
// cache*.json); re-runs do not refetch. Where a terrain model sees the ground above a tunnel or below a bridge, the
// road is taken straight between the ends (COVERED).
//
// Banking: the dataset has none, and js/track.js derives a mild one from curvature (at most 2.5 deg, 1.5 deg on the
// street circuits: `bankMaxDeg`). The corners with a real (published or lidar-measured) bank get `bankOverrides`
// (BANKED below, every value with its source).
//
// 2026-10-01: the verified corrections of the 40-circuit audit (docs/track-audit.md section 2, tools/track-audit.json
// 'apply'; per-circuit evidence in devtests/track-audit/<id>.json) are applied here: new elevation sources (Spa,
// Barcelona, Madring, Imola, Mugello, Monza, Miami, Interlagos, Sepang, Portimao), start lines (Silverstone,
// Hungaroring, Sepang, Shanghai), Albert Park's two stretches from OpenStreetMap, Estoril's length, Madring's length,
// Baku's castle width (`widthOverrides`), per-season pit limits (`pitLimits`), lidar cambers. Raster downloads (GeoTIFF
// windows) are kept in devtests/track-fix/cache/dem/ (git-ignored; the audit's own cache in devtests/track-audit/cache/
// is reused when present); the heights sampled from them go to the tools/elevation-cache-*.json files like the others.
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

// Pinned to the dataset commit the committed tracks-data.js points were built from (last change of the file, 2025-09-04):
// points / lengths / ids never move under a rebuild. ('master' gives the same bytes as long as upstream is unchanged.)
const SRC = 'https://raw.githubusercontent.com/bacinger/f1-circuits/432a253890199d0908e7f82044c52de8268cc056/f1-circuits.geojson';
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(TOOLS_DIR, '..', 'tracks-data.js');
const RASTER_DIR = resolve(TOOLS_DIR, '..', 'devtests', 'track-fix', 'cache', 'dem');       // downloaded DEM windows
const AUDIT_CACHE = resolve(TOOLS_DIR, '..', 'devtests', 'track-audit', 'cache');           // the audit's (reused)
const MAX_LENGTH_MISMATCH = 0.15; // rescale to the official length only if within 15 %
const UA = 'F1Drive-build-tracks/2 (offline game data build; cached, one-off requests)';

const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const ELEV_BATCH = 100;        // API limit: 100 coordinates per request
const ELEV_DELAY_MS = 10500;   // pause between requests (100 coordinates = 100 calls; limit 600 / min)
const ELEV_MAX_WAIT_MS = 80 * 60000; // total time one request may spend waiting out rate limits
const ELEV_STEP = 25;          // m, elevation sampling interval along the centreline (GLO-90)
const MAX_POINT_SPACING = 60;  // m, longer segments get extra (collinear) vertices
const MAX_SLOPE = 0.18;        // |dy/ds| limit (Eau Rouge is ~17 %)
const MEDIAN_HALF = 2;         // median window = 2*half+1 samples (125 m): removes DSM spikes
const GAUSS_SIGMA = 50;        // m
// Venues that are flat in reality (parkland, harbour fronts, reclaimed land, car parks). There the
// 90 m surface model only contributes noise (buildings, grandstands, trees, water/quay steps), so
// the profile is smoothed much harder and scaled down to at most FLAT_MAX_RANGE metres.
// (Miami, us-2022, left the list on 2026-10-01: the USGS lidar shows the real T13-T16 ramp, +3.2 m / +4.7 %.)
const FLAT_TRACKS = new Set(['au-1953', 'ru-2014', 'sg-2008', 'sa-2021', 'ca-1978']);
const FLAT_MEDIAN_HALF = 6;    // 325 m
const FLAT_GAUSS_SIGMA = 250;  // m
const FLAT_MAX_RANGE = 4;      // m
// Bare-earth terrain models (lidar, 0.5-5 m): no buildings or trees to filter out, so they are sampled more densely and
// smoothed much less (a hill like COTA's climb to Turn 1, ~300 m long, survives).
const DTM_STEP = 10;           // m
const DTM_MEDIAN_HALF = 2;     // 50 m: kerbs, drains, a sample on a verge or an embankment
const DTM_GAUSS_SIGMA = 20;    // m

// The dataset's point order normally follows the racing direction. For these circuits it runs
// the wrong way round (checked against the real lap: Marina Bay is anti-clockwise, Paul Ricard
// clockwise), so the order is reversed while keeping points[0] (start/finish) in place.
const REVERSED_IN_DATASET = new Set(['sg-2008', 'fr-1969']);

// The dataset's first vertex is taken as the start / finish line. Where it is not, [lat, lon] of the real line: the
// closed loop is turned to start there (the point's foot on the centreline becomes points[0], a vertex is inserted
// there unless one is within START_SNAP m; order and racing direction kept). Done after the height profile is built,
// so the elevation samples (and their cache keys) do not move; bankOverrides fractions are taken on the turned loop.
// The other circuits were checked (2026-10-01 audit): their first vertex is beside the pit buildings / on the real pit
// straight, within 30 m of the real line (Spa, COTA, Istanbul, Kyalami, Yas: under 30 m, left as they are).
const START_AT = {
  // Monaco: the dataset starts at Casino Square (the top of the lap). The line is on Boulevard Albert 1er:
  // OpenStreetMap node 4937755860 "Monaco Grand Prix Start/Finish Line" (raceway=start-finish), ODbL.
  'mc-1929': [43.7350269, 7.4212652],
  // Silverstone: the dataset starts on the pre-2011 National straight (between Woodcote and Copse). Since 2011 the pits
  // and the line are at the Wing, between Club and Abbey (en.wikipedia "2011 British Grand Prix": "the pits and the
  // start/finish line moved to the straight between Club Corner and the new Abbey"). Two lines there: the timing
  // (finish) line, OSM node 13036050131 (raceway=finish), and 151 m further on the start line, node 13036050130
  // (raceway=start/finish), with the whole grid on the straight between them (grids must be straight). js/track.js lays
  // the grid BEHIND points[0], so the loop starts at the START line: from the timing line it would reach back round
  // Club (review r3 W1: slots 12-16 turned 22-53 deg). One line for all seasons (16 of the 17 seasons 2010..2026 used the Wing).
  'gb-1948': [52.0693366, -1.0221521],
  // Hungaroring: the dataset's first vertex is ~240 m towards T1; the line (audit, OSM + imagery).
  'hu-1986': [47.5789212, 19.2483897],
  // Sepang: 302 m towards T1 in the dataset; the line from the OSM raceway node, the grid visible on imagery.
  'my-1999': [2.7607601, 101.7383513],
  // Shanghai: ~210 m towards T1 in the dataset; the line from imagery (+-15 m).
  'cn-2004': [31.3372693, 121.2205226],
};
const START_SNAP = 1;          // m

// Pit lane facts js/track.js cannot take from the geometry, emitted as pitSide / pitLimitKmh / pitLimits:
//   side      -1 = the driver's right at the line, +1 = the left. Given where scenery-data.js has no pit buildings to
//             take the side from, or has the wrong ones (js/track.js prefers it to them; with neither it tries the inside
//             of the lap first).
//   limitKmh  the pit lane speed limit of the current layout (the newest season) where it is lower than the usual 80
//             (js/track.js never reports more).
//   limits    per-season limits that differ from it: [{to: lastSeason, kmh}] / [{from, to, kmh}], emitted as pitLimits;
//             js/track.js: track.pit.limitFor(year) / track.pit.setYear(year) / F1.buildTrack(data, {year}).
const PIT_FACTS = {
  // Monaco: the pit lane (OpenStreetMap way 850261588 "Voie des stands", pit exit way 1388331347 "Sortie des stands")
  // runs on the harbour side of Boulevard Albert 1er, i.e. on the right going north to Sainte Devote. 60 km/h.
  'mc-1929': { side: -1, limitKmh: 60 },
  // Marina Bay: 60 km/h up to 2024, 80 from 2025 (audit 2026-10-01: FIA event notes).
  'sg-2008': { limits: [{ to: 2024, kmh: 60 }] },
  // Zandvoort: 60 km/h 2021-2024 (the narrow pit lane), 80 from 2025 (audit). Seasons without a Dutch GP take the rule
  // of the layout the game has (2020 and earlier: the same 60 as 2021).
  'nl-1948': { limits: [{ to: 2024, kmh: 60 }] },
  // Sochi: 60 km/h (audit; 80 in the game before).
  'ru-2014': { limitKmh: 60 },
  // Silverstone: the Wing's F1 pit lane (OSM way 227902927 "International pit lane", 755 m before to 555 m after the start
  // line) is on the driver's right. scenery-data.js tags the Wing 'pit' now (109 m from the line, the same side), and the
  // old National pits 1 km away too: the side stays given here so it never depends on which one js/track.js weighs.
  'gb-1948': { side: -1 },
};

// ---------------------------------------------------------------- layout (2026-10-01 audit)
// Stretches where the dataset line leaves the real road, replaced by OpenStreetMap vertices ([lat, lon], ODbL, in the
// racing direction). The dataset line is cut at the feet of the first / last OSM vertex; the dataset vertices within
// `taper` metres before / after are eased onto the OSM line (no lateral step). fillet {at, r}: OSM vertex `at` (a
// junction vertex of the road network) is replaced by a circular arc of radius r tangent to both legs.
const LAYOUT_PATCHES = {
  'au-1953': [
    // Lakeside Drive after T8: the dataset bulges up to 22.5 m towards the lake through grass; the real road (OSM
    // relation 280443, checked on 2025-11-25 imagery by the audit) is almost straight (the T9/T10 chicane went in 2021).
    { name: 'Lakeside Drive after T8', taper: 60, osm: [[-37.8414811, 144.9717653], [-37.8415544, 144.9717607],
      [-37.8416443, 144.9717519], [-37.8417462, 144.9717326], [-37.841826, 144.9717105], [-37.8419452, 144.9716741],
      [-37.8420564, 144.9716318], [-37.8421636, 144.9715871], [-37.8423052, 144.9715266], [-37.8424139, 144.9714758],
      [-37.8424935, 144.9714357], [-37.8425748, 144.9713944], [-37.8426533, 144.9713542], [-37.842739, 144.9713129],
      [-37.8427969, 144.9712826], [-37.8429002, 144.971226], [-37.8430401, 144.9711535], [-37.8433352, 144.9710078],
      [-37.84365, 144.970854], [-37.8438488, 144.9707746], [-37.8441607, 144.9706708], [-37.844292, 144.970644]] },
    // T11 (the old T13, rebuilt 2021): the dataset turns ~73 deg at one vertex 25 m early and cuts across the park
    // (21.5 m off, a 10 m radius). The real corner is the ~90 deg right at the Lakeside Drive / Ross Gregory Drive
    // junction (OSM junction vertex -37.8533681, 144.9786557), rounded with a 20 m centreline radius: the arc's middle is
    // 7.6 m in from the junction vertex, inside the paved junction of two ~14 m roads (inner corner ~9.7 m in).
    { name: 'T11 (old T13)', taper: 60, fillet: { at: 4, r: 20 }, osm: [[-37.8526204, 144.978468], [-37.8527697, 144.9785149],
      [-37.8529031, 144.9785564], [-37.8531462, 144.9786056], [-37.8533681, 144.9786557], [-37.8535501, 144.9776749],
      [-37.8536137, 144.9773215], [-37.8536761, 144.9770152], [-37.8537084, 144.9768607], [-37.853739, 144.976725],
      [-37.8537787, 144.9765678], [-37.8538081, 144.976451]] },
  ],
};

// Lap length the line is scaled to where the dataset's `length` is not that of the drawn layout. [metres | 'geodesic'
// (the line's own length on the WGS84 ellipsoid: no stretch), source]
const LENGTH_OVERRIDE = {
  // Madring: the dataset says 5474 m; the circuit gives 5.414 km (madring.com, en.wikipedia), the drawn line 5.41 km.
  'es-2026': [5414, 'madring.com / en.wikipedia.org/wiki/Madring: 5.414 km'],
  // Estoril: the line is the post-2000 layout (Parabolica redesigned in 2000; mean 2.3 m from today's OSM road) but
  // the dataset's 4349 m is the 1972-93 layout's: it was stretched 4.4 %. F1 never raced this layout (1984-96: the
  // old Parabolica, which OSM does not keep). The line keeps its own length (en.wikipedia: 4.182 km since 2000; 4.163 km
  // with the Tanque variant the line follows).
  'pt-1972': ['geodesic', 'en.wikipedia.org/wiki/Circuito_do_Estoril: "reduced to 4.182 km ... in 2000"'],
};
// Emitted as `layout` (a note the menu may show): where the drawn layout is not the one the name suggests.
const LAYOUT_NOTE = {
  'pt-1972': 'post-2000 layout (F1 raced the 1984-96 layouts)',
};

// Road width: stretches narrower than the generic road ([lat, lon] ends in the racing direction, half width in m), emitted
// as widthOverrides [{name, from, to, halfW}] (lap fractions); js/track.js caps the road and moves the walls in.
const WIDTH_OVERRIDES = {
  // Baku: "the track has a narrow 7.6 m (25 ft) uphill section" (en.wikipedia Baku City Circuit), the old-town castle
  // section from T8 to T12 (the game had 14 m of road, walls 12 m out). Ends: game T8 apex / T12 exit (audit).
  'az-2016': [{ name: 'castle section T8-T12', halfW: 3.8, from: [40.368589, 49.837431], to: [40.369393, 49.835656] }],
};

// Street circuits: the curvature-derived banking of js/track.js is capped at 1.5 deg there (2.5 elsewhere): lidar
// cross-slopes measured 0-2.4 deg in hairpins and chicanes where the game had 3.5-6 (audit 'derivedBanking').
const STREET_CIRCUITS = new Set(['mc-1929', 'sg-2008', 'az-2016', 'us-2023', 'sa-2021', 'ca-1978', 'au-1953', 'ru-2014',
  'us-2022', 'es-2026']);
const STREET_BANK_MAX_DEG = 1.5;

// ---------------------------------------------------------------- elevation sources
// Where a better (bare-earth) model with an open API covers a circuit. Why each one (checked 2026-10, see also
// PUBLISHED below and devtests/track-fix/): GLO-90 flattened COTA (20.6 m vs 41 m published; the 300 m climb to Turn 1
// is smeared away), made the Las Vegas Strip hilly (25 m, 8.7 %: hotels in the surface model; USGS lidar: 16 m, 3 %)
// and gave Monaco a fake 30 m high harbour front (buildings; 54 m vs 44 m published). Where the lidar and a published
// figure disagree, the lidar is kept: COTA 31 m along this centreline (lowest point 151 m ASL ~600 m before the line, turn 1
// crest 182 m; the 1 m grid +-20 m around both gives at most 34 m) against the "133 ft (41 m)" publicity figure, the
// 12 % climb to turn 1 matching the published "over 11%"; Suzuka 40.5 m (GSI laser 5 m: 17.2 .. 57.7 m ASL) against
// the published 52 m. The other circuits keep GLO-90; devtests/track-fix/xcheck.mjs compares every range with SRTM 30 m /
// NED 10 m and the published figures.
// 2026-10-01 audit (every one re-measured independently in devtests/track-audit/verify/): Spa from the Wallonia lidar
// (GLO-90 + tree canopy: Raidillon 3-5 % instead of ~15 %, Paul Frere -> Bus Stop 25-30 m too high), Barcelona and Madring
// from IGN's MDT05 (an invented crest at T3 / dip at T4; Madring's profile the wrong shape), Imola from the Emilia-Romagna
// lidar (Acque Minerali too shallow, Rivazza -10.7 % instead of -6.9 %), Mugello from the Tuscany 1 m DSM (San Donato
// downhill in the game, +12.9 m uphill in reality), Monza from TINITALY 10 m (invented hills: 22.4 m instead of ~12 m),
// Miami from the USGS lidar (off the flat list), Interlagos / Sepang / Portimao from Copernicus GLO-30 (no open lidar
// there; GLO-30 cross-checked with SRTM by the audit).
const ELEV_SOURCE = {
  'us-2012': 'usgs3dep', 'us-2023': 'usgs3dep', 'us-1909': 'usgs3dep', 'us-1956': 'usgs3dep', 'us-2022': 'usgs3dep',
  'mc-1929': 'ignalti', 'fr-1960': 'ignalti', 'fr-1969': 'ignalti',
  'jp-1962': 'gsi5m', 'nl-1948': 'ahn4',
  'be-1925': 'walmnt', 'es-1991': 'ignes', 'es-2026': 'ignes', 'it-1953': 'erdtm', 'it-1914': 'toscana',
  'it-1922': 'tinitaly', 'br-1940': 'glo30', 'my-1999': 'glo30', 'pt-2008': 'glo30',
};

// Per-circuit smoothing where the source's default does not suit (metres; medianHalf in samples):
//   medianHalfM  half window of the median (m);  sigmaM  Gaussian sigma (m);  envelope {pct, halfM}  a rolling low
//   percentile first (a surface model beside stands / trees: the road is the lower envelope);  maxRise  a cap on the
//   steepest climb over 100 m, checked after the build (reported, not enforced, unless `clampRise`).
const ELEV_SETTINGS = {
  // Portimao (GLO-30): audit: 25 m median, sigma 20 m; check: max fall ~10-12 %, max rise must stay under ~7 %
  // (de.wikipedia: "Die steilste Abfahrt hat 12 % im Maximum, ... bis zu 6,2 % bergauf").
  // (Built 2026-10-01: +7.3 % / 100 m, +7.2 % after js/track.js's smoothing: within the audit's ~7 %, not clamped.)
  'pt-2008': { medianHalfM: 25, sigmaM: 20, maxRise: 0.075 },
  'br-1940': { medianHalfM: 25, sigmaM: 10 },                    // Interlagos (GLO-30), audit settings
  // Sepang (GLO-30): grandstands and trees line the track: the road is the low envelope (rolling 20th percentile over
  // 150 m), then a 50 m median and sigma 40 m (audit).
  'my-1999': { envelope: { pct: 0.2, halfM: 75 }, medianHalfM: 25, sigmaM: 40 },
  'us-2022': { medianHalf: 1, sigmaM: 10 },                      // Miami: lighter DTM smoothing keeps the T14-15 ramp
  'it-1914': { medianHalfM: 25 },                                // Mugello: a SURFACE model, the median removes spikes
};

// Features a 10 m DEM does not resolve, added by hand (raised cosine of `depth` m over `length` m centred on `at`).
const MANUAL_DIPS = {
  // Monza: the dip where the lap passes under the old banking between Lesmo 2 and Ascari (OSM bridge 34404729 over the
  // circuit way 1443867793; the underpass of js/tunnels.js). formula1.com: "the significant dip ... between the second
  // Lesmo and Ascari"; the F1 timing car heights (used for validation only: FOM data) give 192.7 / 187.6 / 190.9 m at
  // s 3005 / 3300 / 3595 (-1.7 % / +1.2 %). TINITALY 10 m is flat within 1.2 m there (the audit: plausible, add by hand).
  'it-1922': [{ name: 'underpass under the old banking', at: [45.6247798, 9.2892658], depth: 5, length: 600 }],
};

// Stretches where a terrain model reads something other than the road: tunnels (it gives the ground above) and bridges
// (bare earth has no deck: it gives the ground below). The road is taken as straight (constant grade) between the
// heights just outside the ends, `pad` metres beyond them. Ends from OpenStreetMap (ODbL), in either order.
const COVERED = {
  // Monaco tunnel under the Fairmont hotel, Boulevard Louis II (OSM way 4230891, tunnel=yes, layer -1): from Portier
  // to the exit before the Nouvelle Chicane. IGN RGE ALTI reads 18-24 m on it (the ground of the hotel / Spelugues
  // level) against ~6-9 m at the portals.
  'mc-1929': [{ name: 'tunnel', from: [43.740362, 7.430326], to: [43.737778, 7.427973], pad: 0 }],
  // Suzuka's crossover: the back straight's bridge over the Degner - hairpin road (OSM way 175231434, raceway,
  // bridge=yes, layer 1). The GSI model gives the lower road's height (~6 m less) on the deck.
  'jp-1962': [{ name: 'crossover bridge', from: [34.844026, 136.530434], to: [34.843915, 136.530810], pad: 10 }],
  // Mugello: the main-straight footbridge in the Tuscany SURFACE model (+16 m spike; audit).
  'it-1914': [{ name: 'main-straight footbridge', from: [43.997901, 11.37166], to: [43.998082, 11.371773], pad: 5 }],
  // Madring: the two tunnels under the motorway / IFEMA (the DTM gives the ground above). Tunnel 1 = the tube the line
  // follows (OSM way 87096566; the circuit relation uses the parallel tube 34049751, 14.8 m away).
  'es-2026': [
    { name: 'tunnel 1', from: [40.4721947, -3.6240596], to: [40.4727971, -3.6242927], pad: 10 },
    { name: 'Valdebebas - IFEMA tunnel', from: [40.4726371, -3.6188896], to: [40.4716693, -3.6181083], pad: 10 },
  ],
};

// Published elevation change (highest minus lowest point of the lap) where a source gives one; printed next to the
// built range. [metres, source]
const PUBLISHED = {
  'us-2012': [41, 'en.wikipedia.org/wiki/Circuit_of_the_Americas: "elevation change of 133 ft (41 m)", Turn 1 climb "over 11%"'],
  'mc-1929': [44, 'en.wikipedia.org/wiki/Circuit_de_Monaco: Casino "44 m (144 ft) higher than the lowest part", Beau Rivage max "around 12%"'],
  'nl-1948': [8.9, 'en/nl.wikipedia.org/wiki/Circuit_Zandvoort: "The elevation difference is 8.9 m"'],
  'jp-1962': [40.4, 'formula1.com "Highs and lows" (2016): 40.4 m = the GSI lidar range of the lap; ja.wikipedia.org/wiki/鈴鹿サーキット "最大高低差は52 m" is the whole site'],
  'it-1922': [12.8, 'formula1.com (via the 2026-10-01 audit): 12.8 m; TINITALY 12.0 m'],
  'be-1925': [102.2, 'en.wikipedia.org/wiki/Circuit_de_Spa-Francorchamps: highest point "102.2 m (335 ft) above the lowest part"'],
  'at-1969': [65, 'en.wikipedia.org/wiki/Red_Bull_Ring: "65 m (213 ft) from lowest to highest point"; de: max +12 % / -9.3 %'],
  'de-1927': [55, 'de.wikipedia.org/wiki/Nürburgring: GP-Strecke "Höhenunterschied: 55 m"'],
  'az-2016': [26.8, 'formula1.com "Highs and lows - which F1 track has the most elevation changes?" (2016): Baku "Elevation change: 26.8m" (cached: devtests/track-audit/cache/wikipedia/f1com-highs-and-lows-2016.html)'],
};
// Circuits whose smoothed profile is scaled (shape kept) to the PUBLISHED range: no open terrain model covers them and
// every model there reads buildings. Baku (review r3 W4; audit 2026-10-01 'scaleToRange'): Copernicus GLO-30 is not
// released for Azerbaijan, and GLO-90 (34.4 m), SRTM (36.9 m) and ASTER (42.1 m) are all surface models in the city,
// the excess sitting on the old-town climb T12-T13; the shape is right (high at T13, low on the sea front), the
// range 28 % too big. Scaled 26.8 / 34.4: the -10.5 % fall after T15 becomes ~-8 %.
const RANGE_TO_PUBLISHED = new Set(['az-2016']);

const SOURCES = {
  glo90: {
    label: 'Copernicus DEM GLO-90 (surface model) via the Open-Meteo Elevation API, https://open-meteo.com',
    cache: 'elevation-cache.json', step: ELEV_STEP, dtm: false, batch: ELEV_BATCH, delay: ELEV_DELAY_MS,
    fetch: fetchOpenMeteo,
  },
  usgs3dep: {
    label: 'USGS 3DEP bare-earth DEM (lidar, mostly 1 m; public domain) via the Elevation Point Query Service, https://epqs.nationalmap.gov',
    cache: 'elevation-cache-usgs3dep.json', step: DTM_STEP, dtm: true, batch: 60, delay: 0,
    fetch: (keys) => pointPool(keys, 6, async (lat, lon) => {
      const j = await getJSON(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Meters&includeDate=false`);
      const v = +j.value;
      return Number.isFinite(v) && v > -1000 ? v : null;       // -1000000 = no data
    }),
  },
  ignalti: {
    label: 'IGN RGE ALTI bare-earth DEM (1-5 m; source: IGN, Licence Ouverte Etalab 2.0) via the Geoplateforme altimetry service, https://data.geopf.fr/altimetrie',
    cache: 'elevation-cache-ignalti.json', step: DTM_STEP, dtm: true, batch: 100, delay: 400,
    fetch: async (keys) => {
      const ll = keys.map(splitKey);
      const j = await withRetry(() => getJSON('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=' +
        ll.map((p) => p[1]).join('|') + '&lat=' + ll.map((p) => p[0]).join('|') + '&resource=ign_rge_alti_wld&zonly=true'), 'IGN');
      if (!Array.isArray(j.elevations) || j.elevations.length !== keys.length) throw new Error('IGN: unexpected response');
      return j.elevations.map((v) => (Number.isFinite(+v) && +v > -1000 ? +v : null));   // -99999 = no data
    },
  },
  gsi5m: {
    label: 'GSI DEM 5 m (lidar; source: Geospatial Information Authority of Japan / 国土地理院) via its elevation API, https://maps.gsi.go.jp',
    cache: 'elevation-cache-gsi5m.json', step: DTM_STEP, dtm: true, batch: 40, delay: 0,
    fetch: (keys) => pointPool(keys, 3, async (lat, lon) => {
      const j = await getJSON(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`);
      const v = +j.elevation;
      return Number.isFinite(v) ? v : null;                      // "-----" = no data
    }),
  },
  ahn4: {
    label: 'AHN4 DTM 0.5 m (Actueel Hoogtebestand Nederland, lidar; open data, CC0) via the AHN ImageServer, https://ahn.arcgisonline.nl',
    cache: 'elevation-cache-ahn4.json', step: DTM_STEP, dtm: true, batch: 100, delay: 300,
    fetch: async (keys) => {
      const pts = keys.map(splitKey).map(([lat, lon]) => [+lon, +lat]);
      const geom = encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } }));
      const j = await withRetry(() => getJSON('https://ahn.arcgisonline.nl/arcgis/rest/services/AHNviewer/AHN4_DTM_50cm/ImageServer/getSamples' +
        `?geometry=${geom}&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json`), 'AHN');
      if (!Array.isArray(j.samples)) throw new Error('AHN: unexpected response ' + JSON.stringify(j).slice(0, 200));
      const out = keys.map(() => null);
      for (const s of j.samples) { const v = +s.value; if (Number.isFinite(v) && v > -1000) out[s.locationId] = v; }
      return out;
    },
  },
  // ---- 2026-10-01 audit sources
  walmnt: {
    label: 'SPW Relief de la Wallonie MNT 2021-2022 (lidar DTM 0.5 m; source: Service public de Wallonie, CC BY 4.0, geodata.wallonie.be/id/a004e570-99d6-4fe5-b83d-49b774409278) via the SPW geoservices MapServer identify, https://geoservices.wallonie.be',
    cache: 'elevation-cache-walmnt.json', step: DTM_STEP, dtm: true, batch: 50, delay: 0,
    // one point per request, one request at a time, ~0.45 s apart (the audit's politeness rule)
    fetch: (keys) => pointPool(keys, 1, async (lat, lon) => {
      lat = +lat; lon = +lon;
      const j = await getJSON('https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer/identify?geometry=' +
        encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } })) +
        `&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=0&mapExtent=${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}` +
        '&imageDisplay=400,400,96&returnGeometry=false&f=json');
      const r = j.results && j.results[0], a = r && r.attributes;
      const v = a ? parseFloat(a['Stretch.Pixel Value'] !== undefined ? a['Stretch.Pixel Value'] : a['Pixel Value']) : NaN;
      return Number.isFinite(v) && v > -1000 ? v : null;
    }, 450),
  },
  erdtm: {
    label: 'Regione Emilia-Romagna DTM RER2022 0.5 m (lidar 2022-23; CC BY 4.0) via its ImageServer getSamples, https://servizigis.regione.emilia-romagna.it',
    cache: 'elevation-cache-erdtm.json', step: DTM_STEP, dtm: true, batch: 100, delay: 800,
    fetch: async (keys) => {
      const pts = keys.map(splitKey).map(([lat, lon]) => [+lon, +lat]);
      const body = 'geometry=' + encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } })) +
        '&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json';
      const j = await withRetry(() => getJSON('https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/public/DtmRER2022/ImageServer/getSamples',
        { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 'ER');
      if (!Array.isArray(j.samples)) throw new Error('ER: unexpected response ' + JSON.stringify(j).slice(0, 200));
      const out = keys.map(() => null);
      for (const s of j.samples) { const v = parseFloat(s.value); if (Number.isFinite(v) && v > -1000) out[s.locationId] = v; }
      return out;
    },
  },
  ignes: {
    label: 'IGN Espana / CNIG MDT05 (5 m DTM from PNOA-LiDAR; CC BY 4.0, scne.es) via the INSPIRE WCS https://servicios.idee.es/wcs-inspire/mdt',
    cache: 'elevation-cache-ignes.json', step: DTM_STEP, dtm: true, batch: Infinity, delay: 0,
    // bilinear on whole metres: the DTM median + Gauss remove the 1 m steps
    fetch: (keys, track) => rasterSample(keys, ignesRaster(track, keys)),
  },
  tinitaly: {
    label: 'TINITALY 1.1 DEM 10 m (INGV, Tarquini et al. 2023, doi 10.13127/tinitaly/1.1; CC BY 4.0) via its WCS, https://tinitaly.pi.ingv.it',
    cache: 'elevation-cache-tinitaly.json', step: DTM_STEP, dtm: true, batch: Infinity, delay: 0,
    fetch: (keys, track) => rasterSample(keys, tinitalyRaster(track, keys)),
  },
  toscana: {
    // The 2021 DSM is photogrammetric, not lidar (its metadata, GeoNetwork r_toscan:c5c907bf-50cc-4a76-8787-abc547509c8d:
    // image autocorrelation of the 2021 aerial survey by Italian Remote Sensing S.r.l., GSD 15 cm): trees and the footbridge
    // are in it, hence Mugello's 25 m median and its COVERED footbridge (review r3 W6).
    label: 'Regione Toscana DSM 1 m 2021 (photogrammetric surface model, image autocorrelation of the 2021 aerial survey; CC BY 4.0) via the GEOscopio WMS, https://www502.regione.toscana.it/wmsraster',
    cache: 'elevation-cache-toscana.json', step: DTM_STEP, dtm: true, batch: Infinity, delay: 0,
    fetch: (keys) => toscanaSample(keys),
  },
  glo30: {
    label: 'Copernicus DEM GLO-30 (30 m SURFACE model; (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; free licence) via the AWS Open Data COGs, https://copernicus-dem-30m.s3.amazonaws.com',
    cache: 'elevation-cache-glo30.json', step: DTM_STEP, dtm: false, batch: Infinity, delay: 0, medianHalfM: 25, sigmaM: 20,
    fetch: (keys, track) => rasterSample(keys, glo30Raster(track, keys)),
  },
};

// ---------------------------------------------------------------- banking
// Real banked corners (the curvature-derived banking of js/track.js is at most 2.5 deg, 1.5 on street circuits). deg =
// bank angle with the inside of the corner lower (js/track.js takes the side from the corner's direction); from / to =
// where the full angle starts and ends ([lat, lon] on the centreline, in the racing direction; given the other way round
// they are swapped here); js/track.js eases in and out over 35 m outside them. Emitted as bankOverrides: [{name, from,
// to, deg}], from / to as fractions of the lap (arc length of `points`). Checked, not added (no sourced angle, or not part
// of the layout in the dataset): Monza's old banking (not on the road course), Mexico's Peraltada ("slightly banked", no
// figure), Hockenheim's 1938 Ostkurve (gone), Red Bull Ring, Interlagos, Baku, Las Vegas, Suzuka (no banking figures
// published); Madring's per-turn table (madring.com, read by an auditor only) and Yas T9 (press figures disagree: 5 deg
// vs 5 % = 2.9 deg) are not applied.
// 2026-10-01: the lidar-measured cambers of the audit (cross-slope of the bare-earth model at +-4 m, median over the
// corner; tools/track-audit.json, devtests/track-audit/<id>.json). Some are LOWER than the derived banking the game had
// (it banked every slow corner by up to 6 deg; the lidar shows 0-2.4 deg there), some higher (Zandvoort's Tarzan,
// Hunserug, Scheivlak, Mugello's Arrabbiata, Spa's Kemmel / Blanchimont, Watkins Glen).
const BANKED = {
  'nl-1948': [
    // en.wikipedia.org/wiki/Circuit_Zandvoort: "turn 3 has a 19-degree bank", "turns 13/14 have an 18-degree bank"
    // (nl.wikipedia gives 18 / 19 the other way round; OpenStreetMap tags both corners "Helling 32% / 18 graden").
    // Ends = the OpenStreetMap raceway ways named after the corners (ways 1311522216 and 1311879069).
    // (The AHN4 lidar shows T3's bowl progressive across: ~5 deg on the inside to 18-23 deg on the outside. js/track.js
    // keeps one plane per cross-section, and car.js / raceline.js / ai.js compute the surface the same way, so the
    // published angle stays the planar value.)
    { name: 'T3 Hugenholtzbocht', deg: 19, from: [52.3887467, 4.5416496], to: [52.3881816, 4.5421584] },
    { name: 'T14 Arie Luyendijkbocht', deg: 18, from: [52.3843701, 4.5406984], to: [52.3860509, 4.5388923] },
    // AHN4 0.5 m lidar (audit apply): lidar mean / max deg (the game had)
    { name: 'T1 Tarzanbocht', deg: 6.5, from: [52.3916242, 4.5426454], to: [52.3908736, 4.5434526] },        // 6.4 / 7.5 (3.3)
    { name: 'T2 Gerlachbocht', deg: 4.5, from: [52.3902076, 4.5430133], to: [52.3897659, 4.5428895] },       // 4.3 / 5.2 (1.2)
    { name: 'T4 Hunserug', deg: 4.5, from: [52.388405, 4.5433259], to: [52.3884474, 4.5450726] },            // 4.6 / 5.7 (0.9)
    { name: 'T5 Rob Slotemakerbocht', deg: 5, from: [52.3882938, 4.5462202], to: [52.3884478, 4.5477831] },  // 4.8 / 5.6 (1.5)
    { name: 'T6 Rob Slotemakerbocht', deg: 4.5, from: [52.3887735, 4.5486623], to: [52.3889693, 4.5497944] },// 4.4 / 5.1 (1.5)
    { name: 'T7 Scheivlak', deg: 5, from: [52.3888916, 4.5518451], to: [52.3874188, 4.5527161] },            // 5.2 / 5.8 (2.4)
    { name: 'T8 CM.com bocht', deg: 1.5, from: [52.3872051, 4.5508212], to: [52.3879477, 4.5507501] },       // 1.6 / 1.8 (4.4)
  ],
  // Imola, Emilia-Romagna DTM 0.5 m (audit apply): measured cross-fall (the game had)
  'it-1953': [
    { name: 'T6', deg: 0.8, from: [44.3388621, 11.7044979], to: [44.3382567, 11.7041738] },     // (2.9)
    { name: 'T7', deg: 2.4, from: [44.337067, 11.7022103], to: [44.3365095, 11.7023853] },      // (5)
    { name: 'T17', deg: 1.2, from: [44.3438417, 11.7248089], to: [44.3444122, 11.7250105] },    // (3.5)
    { name: 'T18', deg: 0.8, from: [44.344914, 11.724681], to: [44.3449402, 11.7237756] },      // (3.3)
  ],
  // Mugello, Tuscany DSM 1 m (audit apply; Arrabbiata re-measured in the synthesis: 11 stations, mean 5.2 deg)
  'it-1914': [
    { name: 'T4 Curva Materassi', deg: 1.1, from: [43.9977623, 11.3749903], to: [43.9971817, 11.3748715] },        // (3.1)
    { name: "T8 Curva dell'Arrabbiata 1", deg: 5.1, from: [43.9921731, 11.3694135], to: [43.9917035, 11.3672609] }, // (2.1)
  ],
  // Spa, Wallonia MNT 0.5 m (audit, lidar-measured): lidar mean / max (the game had)
  'be-1925': [
    { name: 'Kemmel', deg: 4, from: [50.4387159, 5.9742126], to: [50.4378817, 5.9747185] },         // 3.8 / 4.3 (0.7)
    { name: 'Blanchimont', deg: 4, from: [50.4355115, 5.9673803], to: [50.4373789, 5.9678398] },    // 3.8 / 4.2 (1.0)
  ],
  // Hockenheim, LGL-BW DGM1 1 m (audit, lidar-measured)
  'de-1932': [
    { name: 'Bernie-Ecclestone-Kurve', deg: 2.5, from: [49.3337697, 8.5689331], to: [49.3336272, 8.5694703] },  // 2.3 / 2.4 (4.8)
    { name: 'Spitzkehre', deg: 1.5, from: [49.3325769, 8.584054], to: [49.3323348, 8.5841701] },               // 1.4 / 1.5 (5.2)
    { name: 'Mobil 1 Kurve', deg: 1.5, from: [49.3306009, 8.5756345], to: [49.3302979, 8.5754379] },           // 1.3 / 1.4 (4.3)
    { name: 'Sachs-Kurve', deg: 1.5, from: [49.329307, 8.5759631], to: [49.328874, 8.5758891] },               // 1.3 / 1.4 (4.0)
    { name: 'Südkurve', deg: 1.5, from: [49.3263776, 8.5694159], to: [49.3260677, 8.56922] },                  // 1.5 / 1.6 (4.6)
  ],
  // Nürburgring, RLP DGM1 1 m (audit, lidar-measured; the Sprintstrecke / Mercedes-Arena corners)
  'de-1927': [
    { name: 'Sprintstrecke 1', deg: 1, from: [50.3317663, 6.9413513], to: [50.3318767, 6.9409565] },     // 1.1 / 1.1 (5.0)
    { name: 'Sprintstrecke 2', deg: 1.5, from: [50.332948, 6.9416486], to: [50.333623, 6.940829] },      // 1.4 / 1.5 (3.9)
    { name: 'Sprintstrecke 3', deg: 1.5, from: [50.3332806, 6.9388173], to: [50.3327031, 6.9390953] },   // 1.3 / 1.4 (4.6)
    { name: 'Sprintstrecke 4', deg: 1.5, from: [50.3327097, 6.9396563], to: [50.3324794, 6.9400017] },   // 1.4 / 1.4 (4.9)
  ],
  // Silverstone, Environment Agency LIDAR DTM 1 m (audit, lidar-measured: the slow corners are nearly flat)
  'gb-1948': [
    { name: 'Abbey', deg: 1, from: [52.0711914, -1.019826], to: [52.0713009, -1.0194313] },             // 1.0 / 1.3 (3.5)
    { name: 'Village', deg: 1.5, from: [52.0725024, -1.0135819], to: [52.0723406, -1.0130157] },        // 1.6 / 1.6 (4.8)
    { name: 'The Loop', deg: 1.5, from: [52.0715682, -1.0126261], to: [52.0715995, -1.0119014] },       // 1.7 / 1.8 (4.9)
    { name: 'Brooklands', deg: 0.5, from: [52.0771521, -1.0193439], to: [52.0767797, -1.0200572] },     // 0.3 / 0.4 (3.9)
    { name: 'Luffield', deg: 1.5, from: [52.0760695, -1.0202098], to: [52.0763987, -1.021677] },        // 1.7 / 1.8 (4.2)
    { name: 'Chapel', deg: 0.5, from: [52.0712254, -1.0093563], to: [52.070624, -1.0094699] },          // 0.6 / 0.8 (3.5)
    { name: 'Stowe', deg: 0.5, from: [52.063602, -1.0183386], to: [52.0637588, -1.0186917] },           // 0.6 / 0.6 (3.4)
    { name: 'Club', deg: 0.5, from: [52.0662784, -1.0227876], to: [52.0662914, -1.0233314] },           // 0.6 / 0.7 (4.7)
  ],
  // Watkins Glen, USGS 3DEP 1 m lidar cross-slope at +-4 m, median over the corner (audit; no published figures):
  // real superelevation in both directions, the straights 0.9 deg.
  'us-1956': [
    { name: 'The Ninety', deg: 6, from: [42.343934, -76.928566], to: [42.34425, -76.927768] },
    { name: 'The Esses 1', deg: 4.5, from: [42.343879, -76.925145], to: [42.342555, -76.923574] },
    { name: 'The Esses 2', deg: 4, from: [42.341928, -76.923465], to: [42.340927, -76.92269] },
    { name: 'The Esses 3', deg: 4.5, from: [42.340471, -76.921936], to: [42.340345, -76.921765] },
    { name: 'The Esses 4', deg: 4, from: [42.339108, -76.920805], to: [42.338933, -76.920744] },
    { name: 'Outer Loop', deg: 5.5, from: [42.33125, -76.920333], to: [42.330652, -76.922961] },
    { name: 'The Chute', deg: 5.5, from: [42.332347, -76.924786], to: [42.331742, -76.926402] },
    { name: 'The Toe', deg: 5.5, from: [42.329122, -76.926219], to: [42.329082, -76.927802] },
    { name: 'The Heel', deg: 5, from: [42.333857, -76.928375], to: [42.334261, -76.927168] },
    { name: 'The Fast Lefthander', deg: 4.5, from: [42.336541, -76.924849], to: [42.337175, -76.925881] },
    { name: 'Turn 11', deg: 5.5, from: [42.337284, -76.928307], to: [42.338158, -76.929073] },
  ],
  // en.wikipedia.org/wiki/Indianapolis_Motor_Speedway: "The turns have 9°12' banking"; the F1 road course
  // (2000-2007) includes "the main stretch and the southwest turn" = oval turn 1, driven clockwise as F1 turn 13.
  // Ends = OpenStreetMap way 51308226 "Indianapolis Motor Speedway - Turn 1" (tagged banking=9° 12').
  'us-1909': [{ name: 'T13 (oval turn 1)', deg: 9.2, from: [39.788120, -86.235622], to: [39.790729, -86.238823] }],
  // it.wikipedia.org/wiki/Circuito_di_Gedda: "la pendenza di 12 gradi della curva 13"; de.wikipedia: "Kurvenüberhöhung:
  // 12°". T13 = the 208 deg left-hand hairpin at the northern end; ends = where its radius drops below 400 m
  // (devtests/track-fix/corners.js).
  'sa-2021': [{ name: 'T13', deg: 12, from: [21.649528, 39.102989], to: [21.648828, 39.101942] }],
  // en.wikipedia.org/wiki/Madring: La Monumental, the "longest banked curve" in F1, "no more than 13.5 degrees of
  // banking" ("not to exceed a 24% gradient"). = the 500 m, 234 deg right-hander (the longest corner of the lap by
  // far); ends = where its radius drops below 400 m (devtests/track-fix/corners.js).
  'es-2026': [{ name: 'T12 La Monumental', deg: 13.5, from: [40.479284, -3.624737], to: [40.478759, -3.622536] }],
};

const r1 = (v) => { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; }; // 0.1 m, no -0

function closedLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

// Metres per degree of longitude / latitude on the WGS84 ellipsoid at latitude lat (deg).
function metresPerDeg(lat) {
  const f = lat * Math.PI / 180;
  return { lon: 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f) + 0.118 * Math.cos(5 * f),
           lat: 111132.954 - 559.822 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f) };
}
// Length (m) of the closed line coords ([lon, lat]) on the ellipsoid (local metric per segment: mm per segment).
function geodesicLength(coords) {
  let L = 0;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i], b = coords[(i + 1) % coords.length], m = metresPerDeg((a[1] + b[1]) / 2);
    L += Math.hypot((b[0] - a[0]) * m.lon, (b[1] - a[1]) * m.lat);
  }
  return L;
}

// LAYOUT_PATCHES on the dataset line coords ([lon, lat], closed, racing order, coords[0] = the line): -> new coords.
function applyLayoutPatches(id, coords, warn) {
  const list = LAYOUT_PATCHES[id];
  if (!list) return { coords, notes: [] };
  const notes = [];
  // local metric frame around the line
  let la = 0, lo = 0;
  for (const c of coords) { lo += c[0]; la += c[1]; }
  la /= coords.length; lo /= coords.length;
  const M = metresPerDeg(la);
  const toXY = (lon, lat) => [(lon - lo) * M.lon, (lat - la) * M.lat];
  const toLL = (x, y) => [lo + x / M.lon, la + y / M.lat];
  let P = coords.map(([lon, lat]) => toXY(lon, lat));
  const sstep = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
  for (const patch of list) {
    let O = patch.osm.map(([lat, lon]) => toXY(lon, lat));
    if (patch.fillet) {                     // round the junction vertex with an arc of radius r tangent to both legs
      const k = patch.fillet.at, r = patch.fillet.r, A = O[k - 1], V = O[k], B = O[k + 1];
      const u1 = [V[0] - A[0], V[1] - A[1]], l1 = Math.hypot(u1[0], u1[1]), u2 = [B[0] - V[0], B[1] - V[1]], l2 = Math.hypot(u2[0], u2[1]);
      u1[0] /= l1; u1[1] /= l1; u2[0] /= l2; u2[1] /= l2;
      const phi = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))), T = r * Math.tan(phi / 2);
      if (T > 0.95 * Math.min(l1, l2)) throw new Error(`${id} ${patch.name}: fillet r ${r} m does not fit (tangent ${T.toFixed(1)} m)`);
      const turn = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]);            // +1 left (counter-clockwise), -1 right
      const T1 = [V[0] - u1[0] * T, V[1] - u1[1] * T];
      const C = [T1[0] - turn * u1[1] * r, T1[1] + turn * u1[0] * r];     // centre: left normal of u1 for a left turn
      const a0 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), nArc = Math.max(4, Math.ceil(phi * r / 3));
      const arc = [];
      for (let q = 0; q <= nArc; q++) {
        const a = a0 + turn * phi * q / nArc;
        arc.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]);
      }
      const mid = arc[nArc >> 1];
      notes.push(`${patch.name}: junction vertex rounded, r ${r} m, ${(phi * 180 / Math.PI).toFixed(0)} deg, arc middle ` +
        `${Math.hypot(mid[0] - V[0], mid[1] - V[1]).toFixed(1)} m from the vertex`);
      O = O.slice(0, k).concat(arc, O.slice(k + 1));
    }
    // feet of the first / last OSM vertex on the current line (segment index, parameter, arc length)
    const n = P.length, cum = [0];
    for (let i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
    const foot = (q) => {
      let best = { d: Infinity };
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n], ex = b[0] - a[0], ey = b[1] - a[1], l2 = ex * ex + ey * ey;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * ex + (q[1] - a[1]) * ey) / l2)) : 0;
        const fx = a[0] + ex * t, fy = a[1] + ey * t, d = Math.hypot(q[0] - fx, q[1] - fy);
        if (d < best.d) best = { d, i, t, s: cum[i] + t * (cum[i + 1] - cum[i]), dx: q[0] - fx, dy: q[1] - fy };
      }
      return best;
    };
    const fa = foot(O[0]), fb = foot(O[O.length - 1]);
    if (fa.d > 30 || fb.d > 30) throw new Error(`${id} ${patch.name}: ends ${fa.d.toFixed(0)} / ${fb.d.toFixed(0)} m off the dataset line`);
    if (!(fb.s > fa.s) || fb.s - fa.s > cum[n] / 2) throw new Error(`${id} ${patch.name}: not in the racing order / crosses the line`);
    // ease the dataset vertices within `taper` m before the cut onto the OSM line, the same after it
    const tp = patch.taper || 0, out = [];
    for (let i = 0; i <= fa.i; i++) {
      const g = tp > 0 ? sstep(1 - (fa.s - cum[i]) / tp) : 0;
      out.push([P[i][0] + fa.dx * g, P[i][1] + fa.dy * g]);
    }
    for (const q of O) out.push(q.slice());
    for (let i = fb.i + 1; i < n; i++) {
      const g = tp > 0 ? sstep(1 - (cum[i] - fb.s) / tp) : 0;
      out.push([P[i][0] + fb.dx * g, P[i][1] + fb.dy * g]);
    }
    const removed = fb.i - fa.i;
    notes.push(`${patch.name}: ${removed} dataset vertices (${(fb.s - fa.s).toFixed(0)} m) -> ${O.length} OSM vertices; ` +
      `joins ${fa.d.toFixed(1)} / ${fb.d.toFixed(1)} m off the dataset line, eased over ${tp} m`);
    P = out;
  }
  return { coords: P.map(([x, y]) => toLL(x, y)), notes };
}

function convert(feature, warn) {
  const p = feature.properties || {};
  const name = p.Name || p.name || p.id;
  let geom = feature.geometry;
  let coords = geom.type === 'MultiLineString' ? geom.coordinates.flat() : geom.coordinates;
  if (geom.type !== 'LineString') warn(`${name}: geometry type ${geom.type}`);
  const patched = applyLayoutPatches(String(p.id), coords, warn);
  coords = patched.coords;

  // centre = bounding-box centre
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const lon0 = (minLon + maxLon) / 2, lat0 = (minLat + maxLat) / 2;
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, kz = 110540;

  // East = +x, North = -z  (true, non-mirrored map when viewed from +y with screen-up = -z)
  let pts = coords.map(([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * kz, lon, lat]);

  // drop consecutive duplicates, then a duplicated closing point
  const EPS = 0.05;
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
  pts = pts.filter((q, i) => i === 0 || !same(q, pts[i - 1]));
  while (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();

  if (REVERSED_IN_DATASET.has(String(p.id))) pts = [pts[0], ...pts.slice(1).reverse()];

  // rescale to the official length when the mismatch is small (LENGTH_OVERRIDE: the drawn layout's own figure)
  const projected = closedLength(pts);
  const ov = LENGTH_OVERRIDE[String(p.id)];
  const official = ov ? (ov[0] === 'geodesic' ? geodesicLength(coords) : ov[0]) : Number(p.length);
  let scale = 1; // official-length rescale factor, folded into `geo`
  if (official > 0) {
    const mismatch = projected / official - 1;
    if (Math.abs(mismatch) <= MAX_LENGTH_MISMATCH) {
      const s = official / projected;
      scale = s;
      pts = pts.map(([x, z, lon, lat]) => [x * s, z * s, lon, lat]);
    } else {
      warn(`${name}: projected length ${projected.toFixed(0)} m vs official ${official} m ` +
           `(${(mismatch * 100).toFixed(1)} %) - keeping projected length`);
    }
  } else {
    warn(`${name}: no official length - keeping projected length`);
  }

  pts = pts.map(([x, z, lon, lat]) => [r1(x), r1(z), lon, lat]);
  pts = pts.filter((q, i) => i === 0 || !same(q, pts[i - 1]));

  // sanity warnings
  const n = pts.length;
  const len = closedLength(pts);
  if (pts.some((q) => !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) warn(`${name}: non-finite coordinate`);
  if (n <= 30) warn(`${name}: only ${n} points`);
  const gap = Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
  let maxSeg = 0;
  for (let i = 0; i < n - 1; i++) maxSeg = Math.max(maxSeg, Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  if (gap > Math.max(2 * maxSeg, 0.15 * len)) warn(`${name}: closing gap ${gap.toFixed(0)} m (longest other segment ${maxSeg.toFixed(0)} m)`);

  return {
    id: String(p.id),
    name: String(name),
    location: String(p.Location || p.location || ''),
    lengthKm: Math.round(len) / 1000,
    points: densify(pts), // [x, z, lon, lat]; lon/lat are stripped before writing
    // projection of the emitted points: x = (lon - lon0) * kx, z = (lat - lat0) * kz (full precision)
    geo: { lon0, lat0, kx: kx * scale, kz: -kz * scale },
    _src: pts.map((q) => [q[2], q[3], q[0], q[1]]), // original vertices [lon, lat, x, z] for the geo self-check
    _stats: { projected, official, datasetLength: Number(p.length), gap, maxSeg, srcPoints: n, layoutNotes: patched.notes },
  };
}

// Insert evenly spaced vertices on every segment longer than MAX_POINT_SPACING (closed loop).
// Existing vertices are kept untouched and in order.
function densify(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / MAX_POINT_SPACING);
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push([r1(a[0] + (b[0] - a[0]) * t), r1(a[1] + (b[1] - a[1]) * t),
                a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
    }
  }
  return out;
}

// Arc length (m) along the closed polyline pts ([x, z, ...]) of the point nearest to (x, z), and that distance.
function projectOnLoop(pts, x, z) {
  let best = Infinity, bestS = 0, s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
    if (d < best) { best = d; bestS = s + t * Math.sqrt(l2); }
    s += Math.sqrt(l2);
  }
  return { s: bestS, dist: best, total: s };
}
function projectLatLon(track, lat, lon) {
  const g = track.geo;
  return projectOnLoop(track.points, (lon - g.lon0) * g.kx, (lat - g.lat0) * g.kz);
}

// ---------------------------------------------------------------- elevation
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coordKey = (lon, lat) => `${lat.toFixed(5)},${lon.toFixed(5)}`; // ~1 m grid
const splitKey = (k) => k.split(',');                                   // -> [lat, lon] (strings)

// Uniform samples (lon/lat) every ~step metres of arc length around the closed loop.
function elevationSamples(pts, step) {
  const n = pts.length, cum = [0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[n], m = Math.max(8, Math.round(total / step)), ds = total / m;
  const samples = [];
  for (let k = 0, i = 0; k < m; k++) {
    const s = k * ds;
    while (i < n - 1 && cum[i + 1] <= s) i++;
    const a = pts[i], b = pts[(i + 1) % n], t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    samples.push({ lon: a[2] + (b[2] - a[2]) * t, lat: a[3] + (b[3] - a[3]) * t });
  }
  return { samples, ds, cum, total };
}

async function getJSON(url, opts) {
  opts = opts || {};
  const res = await fetch(url, { method: opts.method || 'GET', body: opts.body,
    headers: Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, opts.headers || {}) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
  return res.json();
}
async function getBuffer(url, range) {
  const h = { 'User-Agent': UA };
  if (range) h.Range = `bytes=${range[0]}-${range[1]}`;
  const res = await fetch(url, { headers: h });
  if (!res.ok) { const e = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------- raster DEMs (GeoTIFF windows)
// Minimal GeoTIFF reader: classic TIFF, little / big endian, strips or tiles, uncompressed or Deflate, predictor 1 / 2 / 3,
// one band of int16 / uint16 / int32 / float32 / float64. -> {w, h, data (Float64Array, NaN = no data), x0, y0 (map
// coordinates of the top-left CORNER of pixel 0, 0), dx, dy (pixel size, both > 0)}.
function readTiff(b) {
  const le = b[0] === 0x49;
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error('not a classic TIFF (BigTIFF or other)');
  const ifd = u32(4), n = u16(ifd), T = {}, SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), size = (SZ[type] || 1) * cnt;
    const off = size > 4 ? u32(e + 8) : e + 8, v = [];
    if (type === 2) { T[tag] = [b.toString('latin1', off, off + cnt).replace(/\0+$/, '')]; continue; }
    for (let k = 0; k < cnt; k++) {
      const o = off + k * (SZ[type] || 1);
      v.push(type === 3 ? u16(o) : type === 4 ? u32(o) : type === 12 ? (le ? b.readDoubleLE(o) : b.readDoubleBE(o)) :
        type === 11 ? (le ? b.readFloatLE(o) : b.readFloatBE(o)) : type === 8 ? (le ? b.readInt16LE(o) : b.readInt16BE(o)) :
        type === 9 ? (le ? b.readInt32LE(o) : b.readInt32BE(o)) : b[o]);
    }
    T[tag] = v;
  }
  const W = T[256][0], H = T[257][0], bps = T[258][0], fmt = (T[339] || [1])[0], comp = (T[259] || [1])[0];
  const pred = (T[317] || [1])[0], spp = (T[277] || [1])[0], B = bps / 8;
  if (spp !== 1) throw new Error('TIFF: ' + spp + ' samples per pixel');
  if (comp !== 1 && comp !== 8 && comp !== 32946) throw new Error('TIFF: compression ' + comp + ' not supported');
  const tiled = !!T[322], cw = tiled ? T[322][0] : W, ch = tiled ? T[323][0] : ((T[278] || [H])[0]);
  const offs = tiled ? T[324] : T[273], cnts = tiled ? T[325] : T[279];
  const across = Math.ceil(W / cw), data = new Float64Array(W * H).fill(NaN);
  const rd = (buf, o) => {
    if (fmt === 3) return bps === 32 ? (le ? buf.readFloatLE(o) : buf.readFloatBE(o)) : (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
    if (bps === 16) return fmt === 2 ? (le ? buf.readInt16LE(o) : buf.readInt16BE(o)) : (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    if (bps === 32) return fmt === 2 ? (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) : (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    if (bps === 8) return fmt === 2 ? buf.readInt8(o) : buf[o];
    throw new Error('TIFF: ' + bps + ' bits per sample');
  };
  for (let c = 0; c < offs.length; c++) {
    const cx = tiled ? (c % across) * cw : 0, cy = tiled ? Math.floor(c / across) * ch : c * ch;
    if (cy >= H) break;
    let raw = b.subarray(offs[c], offs[c] + cnts[c]);
    if (comp !== 1) raw = inflateSync(raw);
    const rows = tiled ? ch : Math.min(ch, H - cy), rowB = cw * B;
    for (let r = 0; r < rows; r++) {
      let row = raw.subarray(r * rowB, (r + 1) * rowB), vals;
      if (pred === 3) {                     // floating-point predictor: byte differencing, then byte planes (big-endian)
        row = Buffer.from(row);
        for (let k = 1; k < rowB; k++) row[k] = (row[k] + row[k - 1]) & 255;
        const tmp = Buffer.alloc(B);
        vals = new Float64Array(cw);
        for (let x = 0; x < cw; x++) {
          for (let q = 0; q < B; q++) tmp[q] = row[q * cw + x];
          vals[x] = B === 4 ? tmp.readFloatBE(0) : tmp.readDoubleBE(0);
        }
      } else {
        vals = new Float64Array(cw);
        for (let x = 0; x < cw; x++) vals[x] = rd(row, x * B);
        if (pred === 2) {                   // horizontal differencing (integers)
          const mod = 2 ** bps, half = mod / 2;
          for (let x = 1; x < cw; x++) {
            let v = (vals[x] + vals[x - 1]) % mod;
            if (fmt === 2) { if (v >= half) v -= mod; else if (v < -half) v += mod; } else if (v < 0) v += mod;
            vals[x] = v;
          }
        }
      }
      const Y = cy + r;
      if (Y >= H) break;
      for (let x = 0; x < cw; x++) { const X = cx + x; if (X < W) data[Y * W + X] = vals[x]; }
    }
  }
  const nod = T[42113] ? parseFloat(T[42113][0]) : NaN;
  if (Number.isFinite(nod)) for (let i = 0; i < data.length; i++) if (data[i] === nod) data[i] = NaN;
  let x0, y0, dx, dy;
  if (T[34264]) { const m = T[34264]; dx = m[0]; dy = -m[5]; x0 = m[3]; y0 = m[7]; }
  else { const s = T[33550], tp = T[33922]; dx = s[0]; dy = s[1]; x0 = tp[3] - tp[0] * dx; y0 = tp[4] + tp[1] * dy; }
  const gk = T[34735] || [];
  let rt = 1;
  for (let k = 4; k < gk.length; k += 4) if (gk[k] === 1025) rt = gk[k + 3];
  if (rt === 2) { x0 -= dx / 2; y0 += dy / 2; }   // PixelIsPoint: the tie point is a pixel centre
  return { w: W, h: H, data, x0, y0, dx, dy };
}
// Bilinear on pixel centres at map coordinates (X, Y); NaN outside or next to no-data.
function bilinear(r, X, Y) {
  const fx = (X - r.x0) / r.dx - 0.5, fy = (r.y0 - Y) / r.dy - 0.5, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  if (i < 0 || j < 0 || i + 1 >= r.w || j + 1 >= r.h) return NaN;
  const v = (a, c) => r.data[c * r.w + a];
  return (v(i, j) * (1 - tx) + v(i + 1, j) * tx) * (1 - ty) + (v(i, j + 1) * (1 - tx) + v(i + 1, j + 1) * tx) * ty;
}
// WGS84 -> UTM easting / northing (zone), Krueger series to the 6th order of e (sub-mm here)
function utm(lat, lon, zone) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const r = Math.PI / 180, phi = lat * r, lam0 = ((zone - 1) * 6 - 180 + 3) * r, lam = lon * r;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const E = 500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
  const Nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [E, lat < 0 ? Nn + 10000000 : Nn];
}
function keysBBox(keys) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const k of keys) { const [la, lo] = splitKey(k).map(Number); s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return [s, w, n, e];
}
// A downloaded file: the audit's cache copy when it exists, else devtests/track-fix/cache/dem/<name> (fetched once).
async function cachedFile(name, auditPath, url) {
  mkdirSync(RASTER_DIR, { recursive: true });
  const f = resolve(RASTER_DIR, name);
  if (existsSync(f)) return readFileSync(f);
  if (auditPath && existsSync(resolve(AUDIT_CACHE, auditPath))) { copyFileSync(resolve(AUDIT_CACHE, auditPath), f); return readFileSync(f); }
  console.log(`  downloading ${url.slice(0, 150)}`);
  const b = await withRetry(() => getBuffer(url), name);
  if (b[0] !== 0x49 && b[0] !== 0x4d) throw new Error(`${name}: not a TIFF: ${b.slice(0, 300).toString()}`);
  writeFileSync(f, b);
  return b;
}
// sampler(lat, lon) -> metres | NaN, for keys "lat,lon"
async function rasterSample(keys, samplerP) {
  const sampler = await samplerP;
  return keys.map((k) => { const [la, lo] = splitKey(k).map(Number), v = sampler(la, lo); return Number.isFinite(v) && v > -1000 ? v : null; });
}
// IGN Espana MDT05: one WCS window (EPSG:4258 lat / lon) per circuit, the audit's bboxes (else the samples' + 300 m)
const IGNES_BBOX = { 'es-1991': [41.56148, 2.24852, 41.57745, 2.26728], 'es-2026': [40.46158, -3.62889, 40.48334, -3.60844] };
async function ignesRaster(track, keys) {
  let bb = IGNES_BBOX[track.id];
  const kb = keysBBox(keys);
  if (!bb || kb[0] < bb[0] || kb[1] < bb[1] || kb[2] > bb[2] || kb[3] > bb[3]) bb = [kb[0] - 0.003, kb[1] - 0.004, kb[2] + 0.003, kb[3] + 0.004].map((v) => +v.toFixed(5));
  const url = 'https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion4258_5' +
    `&SUBSET=Lat(${bb[0]},${bb[2]})&SUBSET=Long(${bb[1]},${bb[3]})&FORMAT=image/tiff`;
  const same = IGNES_BBOX[track.id] && bb === IGNES_BBOX[track.id];
  const r = readTiff(await cachedFile(`ignes-${track.id}-${bb.join('_')}.tif`, same ? `ign-es/${track.id}-mdt05.tif` : null, url));
  return (lat, lon) => bilinear(r, lon, lat);
}
// TINITALY: one WCS window (EPSG:32632, 10 m) per circuit on 100 m edges (Monza: the audit's window)
const TINITALY_WIN = { 'it-1922': [521300, 5050500, 523800, 5053600] };
async function tinitalyRaster(track, keys) {
  const kb = keysBBox(keys), a = utm(kb[0], kb[1], 32), b = utm(kb[2], kb[3], 32), c = utm(kb[0], kb[3], 32), d = utm(kb[2], kb[1], 32);
  const E0 = Math.min(a[0], b[0], c[0], d[0]), E1 = Math.max(a[0], b[0], c[0], d[0]), N0 = Math.min(a[1], b[1], c[1], d[1]), N1 = Math.max(a[1], b[1], c[1], d[1]);
  let win = TINITALY_WIN[track.id];
  if (!win || E0 < win[0] + 50 || N0 < win[1] + 50 || E1 > win[2] - 50 || N1 > win[3] - 50) {
    win = [Math.floor(E0 / 100) * 100 - 300, Math.floor(N0 / 100) * 100 - 300, Math.ceil(E1 / 100) * 100 + 300, Math.ceil(N1 / 100) * 100 + 300];
  }
  const url = 'https://tinitaly.pi.ingv.it/TINItaly_1_1/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=TINItaly_1_1__tinitaly_dem' +
    `&subset=E(${win[0]},${win[2]})&subset=N(${win[1]},${win[3]})&format=image/tiff`;
  const r = readTiff(await cachedFile(`tinitaly-${win.join('_')}.tif`, `tinitaly/${win.join('_')}.tif`, url));
  return (lat, lon) => { const [E, N] = utm(lat, lon, 32); return bilinear(r, E, N); };
}
// Tuscany DSM 1 m: WMS GetMap windows of 500 m x 500 px (EPSG:32632, float32), as the audit fetched them
const toscTiles = new Map();
async function toscanaSample(keys) {
  const layer = 'rt_morfologia.iddsm2021.1m.rt', size = 500, out = [];
  for (const k of keys) {
    const [lat, lon] = splitKey(k).map(Number), [E, N] = utm(lat, lon, 32), E0 = Math.floor(E / size) * size, N0 = Math.floor(N / size) * size;
    const name = `${E0}_${N0}_${size}_${size}.tif`;
    if (!toscTiles.has(name)) {
      const url = 'https://www502.regione.toscana.it/wmsraster/com.rt.wms.RTmap/wms?map=wmsmorfologia&service=WMS&version=1.3.0&request=GetMap' +
        `&layers=${layer}&styles=&crs=EPSG:32632&bbox=${E0},${N0},${E0 + size},${N0 + size}&width=${size}&height=${size}&format=image/tiff`;
      const b = await cachedFile('toscana-' + name, 'toscana-rt_morfologia_iddsm2021_1m_rt/' + name, url);
      const t = readTiff(b);
      // a WMS image carries no geo tags: pixel (i, j) covers E0 + i, N0 + size - j (1 m)
      t.x0 = E0; t.y0 = N0 + size; t.dx = size / t.w; t.dy = size / t.h;
      for (let i = 0; i < t.data.length; i++) if (!(t.data[i] > 0 && t.data[i] < 9000)) t.data[i] = NaN;
      toscTiles.set(name, t);
    }
    const t = toscTiles.get(name);
    // edge pixels: clamp into the tile (a neighbour tile would be the exact answer; 0.5 m at most)
    const v = bilinear(t, Math.max(E0 + 0.5 * t.dx, Math.min(E0 + size - 0.5 * t.dx - 1e-6, E)), Math.max(N0 + 0.5 * t.dy + 1e-6, Math.min(N0 + size - 0.5 * t.dy, N)));
    out.push(Number.isFinite(v) ? v : null);
  }
  return out;
}
// Copernicus GLO-30: the 1024 x 1024 tiles of the public COG a circuit needs (HTTP range requests; Deflate + the
// floating-point predictor), decoded window cached as JSON in devtests/track-fix/cache/dem/glo30-<id>.json.
async function glo30Raster(track, keys) {
  const kb = keysBBox(keys), bb = [kb[0] - 0.003, kb[1] - 0.003, kb[2] + 0.003, kb[3] + 0.003];
  const file = resolve(RASTER_DIR, `glo30-${track.id}.json`);
  let g = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (!g || bb[0] < g.bbox[0] || bb[1] < g.bbox[1] || bb[2] > g.bbox[2] || bb[3] > g.bbox[3]) {
    const la = Math.floor((bb[0] + bb[2]) / 2), lo = Math.floor((bb[1] + bb[3]) / 2);
    if (Math.floor(bb[0]) !== la || Math.floor(bb[2]) !== la || Math.floor(bb[1]) !== lo || Math.floor(bb[3]) !== lo) throw new Error(`${track.id}: GLO-30 window spans two 1-degree tiles`);
    const nm = `Copernicus_DSM_COG_10_${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}_00_${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}_00_DEM`;
    const url = `https://copernicus-dem-30m.s3.amazonaws.com/${nm}/${nm}.tif`;
    console.log(`  GLO-30 ${track.id}: range reads of ${url}`);
    const head = await withRetry(() => getBuffer(url, [0, 65535]), 'GLO-30');
    const u16 = (o) => head.readUInt16LE(o), u32 = (o) => head.readUInt32LE(o);
    const off = u32(4), cnt = u16(off), T = {};
    for (let i = 0; i < cnt; i++) {
      const q = off + 2 + i * 12, tag = u16(q), type = u16(q + 2), c = u32(q + 4), sz = ({ 3: 2, 4: 4, 12: 8, 2: 1 }[type] || 1) * c, at = sz <= 4 ? q + 8 : u32(q + 8), v = [];
      for (let k = 0; k < c; k++) v.push(type === 3 ? u16(at + 2 * k) : type === 4 ? u32(at + 4 * k) : type === 12 ? head.readDoubleLE(at + 8 * k) : head[at + k]);
      T[tag] = v;
    }
    const W = T[256][0], H = T[257][0], TW = T[322][0], TH = T[323][0], pred = (T[317] || [1])[0], sc = T[33550], tie = T[33922];
    if (T[259][0] !== 8 || T[339][0] !== 3 || T[258][0] !== 32) throw new Error('GLO-30: unexpected GeoTIFF layout');
    let rt = 1;
    for (let k = 4; k < T[34735].length; k += 4) if (T[34735][k] === 1025) rt = T[34735][k + 3];
    const cornerX = tie[3] - (rt === 2 ? sc[0] / 2 : 0), cornerY = tie[4] + (rt === 2 ? sc[1] / 2 : 0);
    const i0 = Math.max(0, Math.floor((bb[1] - cornerX) / sc[0]) - 2), i1 = Math.min(W - 1, Math.ceil((bb[3] - cornerX) / sc[0]) + 2);
    const j0 = Math.max(0, Math.floor((cornerY - bb[2]) / sc[1]) - 2), j1 = Math.min(H - 1, Math.ceil((cornerY - bb[0]) / sc[1]) + 2);
    const across = Math.ceil(W / TW), ww = i1 - i0 + 1, hh = j1 - j0 + 1, z = new Array(ww * hh).fill(null);
    for (let ty = Math.floor(j0 / TH); ty <= Math.floor(j1 / TH); ty++) {
      for (let tx = Math.floor(i0 / TW); tx <= Math.floor(i1 / TW); tx++) {
        const ti = ty * across + tx, raw = inflateSync(await withRetry(() => getBuffer(url, [T[324][ti], T[324][ti] + T[325][ti] - 1]), 'GLO-30'));
        const rowB = TW * 4, tmp = Buffer.alloc(4);
        for (let r = 0; r < TH; r++) {
          const row = raw.subarray(r * rowB, (r + 1) * rowB);
          if (pred === 3) for (let k = 1; k < rowB; k++) row[k] = (row[k] + row[k - 1]) & 255;
          const j = ty * TH + r;
          if (j < j0 || j > j1) continue;
          for (let c = 0; c < TW; c++) {
            const i = tx * TW + c;
            if (i < i0 || i > i1) continue;
            let v;
            if (pred === 3) { tmp[0] = row[c]; tmp[1] = row[TW + c]; tmp[2] = row[2 * TW + c]; tmp[3] = row[3 * TW + c]; v = tmp.readFloatBE(0); }
            else v = row.readFloatLE(c * 4);
            z[(j - j0) * ww + (i - i0)] = Math.round(v * 100) / 100;
          }
        }
      }
    }
    g = { source: url, bbox: bb, x0: cornerX + i0 * sc[0], y0: cornerY - j0 * sc[1], dx: sc[0], dy: sc[1], w: ww, h: hh, z, fetched: new Date().toISOString() };
    mkdirSync(RASTER_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(g), 'utf8');
  }
  const r = { w: g.w, h: g.h, x0: g.x0, y0: g.y0, dx: g.dx, dy: g.dy, data: Float64Array.from(g.z, (v) => (v === null ? NaN : v)) };
  return (lat, lon) => bilinear(r, lon, lat);
}
// fn() with retries (network errors, 429, 5xx): 1 s, 2 s, 4 s ... 60 s, 9 tries
async function withRetry(fn, what) {
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (err) {
      const st = err.status || 0;
      if (st && st !== 429 && st < 500) throw new Error(`${what}: ${err.message}`);
      if (a >= 8) throw new Error(`${what}: giving up after ${a + 1} attempts (${err.message}); progress is cached, re-run later`);
      const wait = Math.min(60000, 1000 * 2 ** a);
      console.warn(`  ${what} request failed (${err.message.slice(0, 80)}), retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}
// One request per point, `conc` at a time (each worker pausing `gap` ms after a request).
async function pointPool(keys, conc, one, gap) {
  const out = new Array(keys.length);
  let next = 0;
  async function worker() {
    while (next < keys.length) {
      const i = next++, [lat, lon] = splitKey(keys[i]);
      out[i] = await withRetry(() => one(lat, lon), 'elevation point');
      if (gap) await sleep(gap);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, keys.length) }, worker));
  return out;
}

// Open-Meteo counts every coordinate as one call against its free limits (600 / minute,
// 5000 / hour, 10000 / day), so a 429 names the window that was exceeded and we wait it out.
async function fetchOpenMeteo(batch) {
  const url = `${ELEV_API}?latitude=${batch.map((k) => k.split(',')[0]).join(',')}` +
              `&longitude=${batch.map((k) => k.split(',')[1]).join(',')}`;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    let status = 'network error', wait = Math.min(60000, 2000 * 2 ** attempt);
    try {
      const res = await fetch(url);
      status = res.status;
      if (res.ok) {
        const e = (await res.json()).elevation;
        if (!Array.isArray(e) || e.length !== batch.length || e.some((v) => !Number.isFinite(v))) {
          throw new Error('Elevation API: unexpected response ' + JSON.stringify(e).slice(0, 200));
        }
        return e;
      }
      const text = await res.text();
      if (res.status !== 429 && res.status < 500) throw new Error(`Elevation API: HTTP ${res.status} ${text}`);
      if (res.status === 429) {
        if (/daily/i.test(text)) throw new Error('Elevation API: daily limit reached - re-run tomorrow (progress is cached)');
        wait = /hourly/i.test(text) ? 300000 : 61000;
        status = '429 ' + (/hourly/i.test(text) ? 'hourly limit' : 'minutely limit');
      }
    } catch (err) {
      if (String(err.message).startsWith('Elevation API')) throw err;
    }
    if (waited > ELEV_MAX_WAIT_MS) throw new Error(`Elevation API: giving up after ${attempt + 1} attempts (${status}); progress is cached, re-run later`);
    console.warn(`  elevation request failed (${status}), retrying in ${wait / 1000} s`);
    await sleep(wait);
    waited += wait;
  }
}

// Fills a source's cache (key "lat,lon" -> metres, null = no data) for every key that is missing. Throttled.
// track: the circuit the keys belong to (raster sources fetch a window around it), or null.
async function ensureElevations(src, keys, cache, file, track) {
  const missing = [...new Set(keys)].filter((k) => !(k in cache));
  if (!missing.length) { if (!track) console.log(`Elevation (${src.cache}): all ${keys.length} samples served from cache.`); return 0; }
  const total = Math.max(1, Math.ceil(missing.length / src.batch));
  console.log(`Elevation${track ? ' ' + track.id : ''}: fetching ${missing.length} of ${keys.length} samples in ${total} batch(es): ${src.label}`);
  for (let i = 0, r = 1; i < missing.length; i += src.batch, r++) {
    const batch = missing.slice(i, i + src.batch);
    const elev = await src.fetch(batch, track);
    batch.forEach((k, j) => { cache[k] = elev[j] === undefined ? null : elev[j]; });
    writeFileSync(file, JSON.stringify(cache), 'utf8');
    if (r % 10 === 0 || r === total) console.log(`  ${r}/${total}`);
    if (r < total && src.delay) await sleep(src.delay);
  }
  return missing.length;
}

// --- filters on a uniform closed loop
function medianLoop(h, half) {
  const m = h.length, out = new Array(m), w = [];
  for (let i = 0; i < m; i++) {
    w.length = 0;
    for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]);
    w.sort((a, b) => a - b);
    out[i] = w[half];
  }
  return out;
}
function gaussLoop(h, sigma) { // sigma in samples
  const m = h.length, r = Math.min(Math.ceil(sigma * 3), Math.floor((m - 1) / 2)), k = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); k.push(v); sum += v; }
  return h.map((_, i) => {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += k[j + r] * h[((i + j) % m + m) % m];
    return acc / sum;
  });
}
// Mean of the upper and lower Lipschitz envelopes: the result never changes by more than `maxStep`
// between neighbours anywhere on the loop, and is unchanged where the input already complies.
function slopeLimitLoop(h, maxStep) {
  const m = h.length;
  return h.map((_, i) => {
    let lo = -Infinity, hi = Infinity;
    for (let j = 0; j < m; j++) {
      const d = Math.min(Math.abs(i - j), m - Math.abs(i - j)) * maxStep;
      if (h[j] - d > lo) lo = h[j] - d;
      if (h[j] + d < hi) hi = h[j] + d;
    }
    return (lo + hi) / 2;
  });
}
// Rolling percentile (0..1) over +-half samples (closed loop): the low envelope of a surface model beside stands / trees.
function percentileLoop(h, half, pct) {
  const m = h.length, out = new Array(m), w = [];
  for (let i = 0; i < m; i++) {
    w.length = 0;
    for (let j = -half; j <= half; j++) w.push(h[((i + j) % m + m) % m]);
    w.sort((a, b) => a - b);
    out[i] = w[Math.round(pct * (w.length - 1))];
  }
  return out;
}
// No-data samples (null: sea, a hole in the lidar) linearly from the nearest valid ones (closed loop).
function fillGaps(raw) {
  const m = raw.length, h = raw.slice(), ok = raw.map((v) => v !== null && Number.isFinite(v));
  const valid = ok.reduce((a, v) => a + (v ? 1 : 0), 0);
  if (!valid) throw new Error('no elevation data at all');
  for (let i = 0; i < m; i++) {
    if (ok[i]) continue;
    let a = i, b = i, da = 0, db = 0;
    while (!ok[a]) { a = (a - 1 + m) % m; da++; }
    while (!ok[b]) { b = (b + 1) % m; db++; }
    h[i] = raw[a] + (raw[b] - raw[a]) * da / (da + db);
  }
  return { h, holes: m - valid };
}
// COVERED stretches: straight grade between the heights just outside the ends (median of 3 samples each side).
function bridgeCovered(track, sampling, h) {
  const list = COVERED[track.id] || [], m = h.length, notes = [];
  for (const c of list) {
    let pa = projectLatLon(track, c.from[0], c.from[1]), pb = projectLatLon(track, c.to[0], c.to[1]);
    if (pa.dist > 30 || pb.dist > 30) throw new Error(`${track.id} ${c.name}: end ${Math.max(pa.dist, pb.dist).toFixed(0)} m off the centreline`);
    if (((pb.s - pa.s) % pa.total + pa.total) % pa.total > pa.total / 2) [pa, pb] = [pb, pa];   // racing order
    const pad = c.pad || 0;
    const ka = Math.floor((pa.s - pad) / sampling.ds), kb = Math.ceil((pb.s + pad) / sampling.ds);
    const len = ((kb - ka) % m + m) % m;
    const med3 = (k0, dir) => [0, 1, 2].map((j) => h[((k0 + dir * j) % m + m) % m]).sort((p, q) => p - q)[1];
    const ya = med3(ka, -1), yb = med3(kb, 1);
    let maxDiff = 0;
    for (let j = 1; j < len; j++) {
      const k = ((ka + j) % m + m) % m, y = ya + (yb - ya) * j / len;
      if (Math.abs(h[k] - y) > Math.abs(maxDiff)) maxDiff = h[k] - y;
      h[k] = y;
    }
    notes.push(`${c.name} ${Math.round(pa.s - pad)}-${Math.round(pb.s + pad)} m: ${ya.toFixed(1)} -> ${yb.toFixed(1)} m ` +
      `(the model was up to ${Math.abs(maxDiff).toFixed(1)} m ${maxDiff > 0 ? 'higher' : 'lower'})`);
  }
  return notes;
}

// Per-vertex heights (lowest = 0, 0.1 m) from the raw heights of the uniform samples.
function buildElevation(track, sampling, raw, src) {
  const { ds, cum, total } = sampling, m = raw.length, flat = FLAT_TRACKS.has(track.id);
  const set = ELEV_SETTINGS[track.id] || {};
  const filled = fillGaps(raw);
  let h = filled.h;
  const covered = bridgeCovered(track, sampling, h);
  let medHalf = src.dtm ? DTM_MEDIAN_HALF : (flat ? FLAT_MEDIAN_HALF : MEDIAN_HALF);
  let sigma = src.dtm ? DTM_GAUSS_SIGMA : (flat ? FLAT_GAUSS_SIGMA : GAUSS_SIGMA);
  const medHalfM = set.medianHalfM !== undefined ? set.medianHalfM : src.medianHalfM;
  if (medHalfM !== undefined) medHalf = Math.max(0, Math.round(medHalfM / ds));
  if (set.medianHalf !== undefined) medHalf = set.medianHalf;
  if (set.sigmaM !== undefined) sigma = set.sigmaM; else if (src.sigmaM !== undefined) sigma = src.sigmaM;
  const pre = h.slice();
  if (set.envelope) h = percentileLoop(h, Math.max(1, Math.round(set.envelope.halfM / ds)), set.envelope.pct);
  h = medianLoop(h, medHalf);
  h = gaussLoop(h, sigma / ds);
  h = slopeLimitLoop(h, MAX_SLOPE * ds);
  h = gaussLoop(h, 1); // round the corners the limiter leaves
  const dips = [];
  for (const dp of MANUAL_DIPS[track.id] || []) {          // raised cosine, after the filters (they would blur it)
    const pc = projectLatLon(track, dp.at[0], dp.at[1]);
    if (pc.dist > 30) throw new Error(`${track.id} ${dp.name}: ${pc.dist.toFixed(0)} m off the centreline`);
    for (let k = 0; k < m; k++) {
      let x = k * ds - pc.s;
      x -= Math.round(x / total) * total;
      if (Math.abs(x) < dp.length / 2) h[k] -= dp.depth * 0.5 * (1 + Math.cos(2 * Math.PI * x / dp.length));
    }
    dips.push(`${dp.name}: -${dp.depth} m over ${dp.length} m at ${pc.s.toFixed(0)} m`);
  }
  let min = Math.min(...h);
  const range = Math.max(...h) - min;
  const target = RANGE_TO_PUBLISHED.has(track.id) ? PUBLISHED[track.id][0] : null;
  const scale = flat && range > FLAT_MAX_RANGE ? FLAT_MAX_RANGE / range : (target ? target / range : 1);
  h = h.map((v) => (v - min) * scale);
  // linear interpolation at each vertex's arc length (periodic), then re-zero after rounding
  let elev = track.points.map((_, i) => {
    const u = cum[i] / ds, a = Math.floor(u) % m, t = u - Math.floor(u);
    return h[a] + (h[(a + 1) % m] - h[a]) * t;
  });
  min = Math.min(...elev);
  elev = elev.map((v) => r1(v - min));
  let maxGrad = 0;
  for (let i = 0; i < elev.length; i++) {
    const d = cum[i + 1] - cum[i];
    if (d >= 5) maxGrad = Math.max(maxGrad, Math.abs(elev[(i + 1) % elev.length] - elev[i]) / d);
  }
  // steepest climb / fall over 100 m of the smoothed profile (racing direction)
  const w100 = Math.max(1, Math.round(100 / ds));
  let rise100 = -Infinity, fall100 = Infinity;
  for (let k = 0; k < m; k++) {
    const g = (h[(k + w100) % m] - h[k]) / (w100 * ds);
    if (g > rise100) rise100 = g;
    if (g < fall100) fall100 = g;
  }
  const valid = raw.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  return { elev, profile: { ds, raw, pre, final: h }, stats: { flat, samples: m, holes: filled.holes, covered, dips,
    rawMin: valid[0], rawRange: valid[valid.length - 1] - valid[0], medHalf, sigma, rise100, fall100,
    range: Math.max(...elev), maxGrad, scale, lengthCheck: total } };
}

// ---------------------------------------------------------------- start / finish line (see START_AT)
// Turns track.points ([x, z, lon, lat]) and elev so that the loop starts at the foot of [lat, lon] on the centreline.
function startAt(track, elev, ll, warn) {
  const g = track.geo, P = track.points, n = P.length, x = (ll[1] - g.lon0) * g.kx, z = (ll[0] - g.lat0) * g.kz;
  let best = Infinity, bi = 0, bt = 0, s = 0, bs = 0;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2)) : 0;
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
    if (d < best) { best = d; bi = i; bt = t; bs = s + t * Math.sqrt(l2); }
    s += Math.sqrt(l2);
  }
  if (best > 30) warn(`${track.id}: START_AT ${best.toFixed(0)} m off the centreline`);
  const a = P[bi], b = P[(bi + 1) % n], seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let k;
  if (bt * seg <= START_SNAP) k = bi;
  else if ((1 - bt) * seg <= START_SNAP) k = (bi + 1) % n;
  else {
    const q = [r1(a[0] + (b[0] - a[0]) * bt), r1(a[1] + (b[1] - a[1]) * bt), a[2] + (b[2] - a[2]) * bt, a[3] + (b[3] - a[3]) * bt];
    P.splice(bi + 1, 0, q);
    elev = elev.slice();
    elev.splice(bi + 1, 0, r1(elev[bi] + (elev[(bi + 1) % n] - elev[bi]) * bt));
    k = bi + 1;
  }
  track.points = P.slice(k).concat(P.slice(0, k));
  return { elev: elev.slice(k).concat(elev.slice(0, k)), s: bs, dist: best };
}

// ---------------------------------------------------------------- banking (see BANKED), width (WIDTH_OVERRIDES)
// Stretches given by [lat, lon] ends -> lap fractions of the (turned) loop, in the racing order (ends given the other way
// round are swapped: js/track.js would skip a stretch longer than half the lap). `extra` copies the value fields.
function lapRanges(track, list, extra, warn) {
  if (!list) return null;
  const out = [];
  for (const b of list) {
    if (!b.from || !b.to) { warn(`${track.id} ${b.name}: no from / to - skipped`); continue; }
    let pa = projectLatLon(track, b.from[0], b.from[1]), pb = projectLatLon(track, b.to[0], b.to[1]);
    if (pa.dist > 25 || pb.dist > 25) warn(`${track.id} ${b.name}: from / to ${Math.max(pa.dist, pb.dist).toFixed(0)} m off the centreline`);
    let swapped = false;
    if (((pb.s - pa.s) % pa.total + pa.total) % pa.total > pa.total / 2) { [pa, pb] = [pb, pa]; swapped = true; }
    const f5 = (v) => Math.round(v * 1e5) / 1e5;
    const o = { name: b.name, from: f5(pa.s / pa.total), to: f5(pb.s / pb.total) };
    for (const k of extra) o[k] = b[k];
    o._m = [pa.s, pb.s, ((pb.s - pa.s) % pa.total + pa.total) % pa.total, swapped];
    out.push(o);
  }
  return out.length ? out : null;
}
function bankOverrides(track, warn) { return lapRanges(track, BANKED[track.id], ['deg'], warn); }
function widthOverrides(track, warn) { return lapRanges(track, WIDTH_OVERRIDES[track.id], ['halfW'], warn); }

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check'), dry = args.includes('--dry') || check;
  const di = args.indexOf('--dump'), dumpFile = di >= 0 ? args[di + 1] : null;
  const oi = args.indexOf('--out'), outFile = oi >= 0 ? resolve(args[oi + 1]) : OUT;
  const local = args.find((a, i) => !a.startsWith('--') && (di < 0 || i !== di + 1) && (oi < 0 || i !== oi + 1));
  let text;
  if (local) text = readFileSync(local, 'utf8');
  else {
    const res = await fetch(SRC);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    text = await res.text();
  }
  const geo = JSON.parse(text);

  const warnings = [];
  const warn = (m) => { warnings.push(m); console.warn('WARNING: ' + m); };

  const tracks = geo.features.map((f) => convert(f, warn));
  tracks.sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const ids = new Set();
  for (const t of tracks) { if (ids.has(t.id)) warn(`duplicate id ${t.id}`); ids.add(t.id); }
  for (const id of Object.keys(ELEV_SOURCE)) if (!ids.has(id) || !SOURCES[ELEV_SOURCE[id]]) warn(`ELEV_SOURCE ${id}: unknown track or source`);
  for (const id of [...Object.keys(START_AT), ...Object.keys(PIT_FACTS), ...Object.keys(LAYOUT_PATCHES), ...Object.keys(LENGTH_OVERRIDE),
    ...Object.keys(WIDTH_OVERRIDES), ...Object.keys(BANKED), ...Object.keys(COVERED), ...Object.keys(ELEV_SETTINGS),
    ...Object.keys(MANUAL_DIPS), ...STREET_CIRCUITS, ...FLAT_TRACKS, ...RANGE_TO_PUBLISHED]) if (!ids.has(id)) warn(`${id}: unknown track id in a table`);
  for (const id of RANGE_TO_PUBLISHED) if (!PUBLISHED[id] || FLAT_TRACKS.has(id)) warn(`RANGE_TO_PUBLISHED ${id}: no PUBLISHED range, or a flat track`);

  // elevation: every source's samples fetched (cached), then each track built from its own source
  const srcOf = (t) => SOURCES[ELEV_SOURCE[t.id] || 'glo90'];
  const samplings = tracks.map((t) => elevationSamples(t.points, srcOf(t).step));
  const keysPer = samplings.map((s) => s.samples.map((q) => coordKey(q.lon, q.lat)));
  const caches = {};
  for (const [name, src] of Object.entries(SOURCES)) {
    const file = resolve(TOOLS_DIR, src.cache);
    const mine = tracks.map((t, i) => i).filter((i) => srcOf(tracks[i]) === src);
    caches[name] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    if (!mine.length) continue;
    // one call per circuit (raster sources fetch a window around it); the network is only used for missing samples
    let fetched = 0;
    for (const i of mine) fetched += await ensureElevations(src, keysPer[i], caches[name], file, tracks[i]);
    if (!fetched) console.log(`Elevation (${src.cache}): all ${mine.reduce((a, i) => a + keysPer[i].length, 0)} samples served from cache.`);
  }
  const dump = {};
  tracks.forEach((t, i) => {
    const sname = ELEV_SOURCE[t.id] || 'glo90', src = SOURCES[sname];
    let { elev, profile, stats } = buildElevation(t, samplings[i], keysPer[i].map((k) => caches[sname][k]), src);
    if (START_AT[t.id]) {          // before bankOverrides: their fractions are of the turned loop
      const st = startAt(t, elev, START_AT[t.id], warn);
      elev = st.elev;
      t._start = st;
    }
    t.bankOverrides = bankOverrides(t, warn);
    t.widthOverrides = widthOverrides(t, warn);
    t.points = t.points.map(([x, z]) => [x, z]);
    t.elev = elev;
    t.elevSource = sname;
    t.pit = PIT_FACTS[t.id] || null;
    t.bankMaxDeg = STREET_CIRCUITS.has(t.id) ? STREET_BANK_MAX_DEG : null;
    t.layout = LAYOUT_NOTE[t.id] || null;
    Object.assign(t._stats, stats);
    // (profile = the uniform samples from the dataset's first vertex; elev starts at startS metres into that loop)
    dump[t.id] = Object.assign({ source: sname }, profile, { elev, startS: t._start ? t._start.s : 0, bankOverrides: t.bankOverrides });
    if (elev.length !== t.points.length || elev.some((v) => !Number.isFinite(v))) warn(`${t.name}: bad elevation data`);
  });
  if (dumpFile) writeFileSync(dumpFile, JSON.stringify(dump), 'utf8');

  // geo self-check: re-project the original lon/lat vertices and compare with the emitted points
  let geoWorst = 0;
  for (const t of tracks) {
    const g = t.geo;
    let worst = 0;
    for (const [lon, lat, x, z] of t._src) worst = Math.max(worst, Math.abs((lon - g.lon0) * g.kx - x), Math.abs((lat - g.lat0) * g.kz - z));
    if (!(worst <= 0.0501) || !(g.kz < 0)) warn(`${t.name}: geo projection mismatch ${worst.toFixed(3)} m`);
    geoWorst = Math.max(geoWorst, worst);
  }

  const bySource = {};
  for (const t of tracks) (bySource[t.elevSource] = bySource[t.elevSource] || []).push(t.id);
  const header =
`// GENERATED by tools/build-tracks.mjs - do not edit by hand.
// Circuit centrelines from the "f1-circuits" dataset by Tomislav Bacinger:
//   https://github.com/bacinger/f1-circuits   (file: f1-circuits.geojson)
// Licence of the source data: MIT License, Copyright (c) Tomislav Bacinger.
// Converted to local metres (x = east, z = -north), centred on each circuit,
// scaled to the official lap length (Madring: 5.414 km; Estoril: the line's own length, the post-2000 layout).
// points[0] = start/finish, racing direction (loops turned to start at the real line: Monaco on Boulevard Albert 1er,
// OpenStreetMap node 4937755860, ODbL; Silverstone at the Wing's start line (2011+; the grid lies behind it, the timing
// line 151 m before it), Hungaroring, Sepang, Shanghai).
// Albert Park: two stretches (Lakeside Drive after T8, T11) replaced by OpenStreetMap vertices (ODbL).
// Segments longer than ${MAX_POINT_SPACING} m carry extra collinear vertices.
// geo = projection used: x = (lon - geo.lon0) * geo.kx, z = (lat - geo.lat0) * geo.kz.
// elev[i] = height in metres of points[i] above the lowest point of the circuit, smoothed, from:
${Object.entries(bySource).map(([s, l]) => `//   ${SOURCES[s].label}:\n//     ${l.join(' ')}`).join('\n')}
//   Tunnels and bridges (Monaco's tunnel, Suzuka's crossover bridge, Madring's two tunnels, Mugello's main-straight
//   footbridge): straight between their ends (from OpenStreetMap, ODbL), where the models see the ground above / below
//   the road (or the footbridge). Monza: the dip under the old banking added by hand (5 m over 600 m).
//   Baku: every model there is a surface model (the old town's buildings), the profile is scaled to the published
//   26.8 m (formula1.com, 2016).
// bankOverrides (optional) = real banked corners [{name, from, to, deg}]: full bank angle deg (inside of the corner
// lower) from fraction \`from\` to fraction \`to\` of the lap (arc length of points); published angles and lidar-measured
// cambers, sources in tools/build-tracks.mjs. bankMaxDeg (optional) = cap of js/track.js's curvature-derived banking
// (street circuits 1.5; else js/track.js's default 2.5).
// widthOverrides (optional) = narrower stretches [{name, from, to, halfW}]: road half width (m) from fraction \`from\` to
// \`to\` (Baku's castle section, 7.6 m); js/track.js narrows the road and moves the walls in.
// pitSide (optional) = side of the real pit lane where the scenery data has no (or the wrong) pit buildings: -1 the
// driver's right at the line, +1 the left. pitLimitKmh (optional) = the real pit lane speed limit of the current layout
// (the newest season) where it is below 80; pitLimits (optional) = other seasons' limits [{from?, to?, kmh}] (season
// years, inclusive): js/track.js track.pit.limitFor(year) / setYear(year).
// layout (optional) = which layout the line is where the name alone does not say it.
`;
  const body = tracks.map((t) =>
    `{id:${JSON.stringify(t.id)},name:${JSON.stringify(t.name)},location:${JSON.stringify(t.location)},` +
    `lengthKm:${t.lengthKm},geo:${JSON.stringify(t.geo)},points:${JSON.stringify(t.points)},elev:${JSON.stringify(t.elev)}` +
    (t.bankOverrides ? `,bankOverrides:${JSON.stringify(t.bankOverrides.map(({ name, from, to, deg }) => ({ name, from, to, deg })))}` : '') +
    (t.pit && t.pit.side ? `,pitSide:${t.pit.side}` : '') + (t.pit && t.pit.limitKmh ? `,pitLimitKmh:${t.pit.limitKmh}` : '') +
    (t.pit && t.pit.limits ? `,pitLimits:${JSON.stringify(t.pit.limits)}` : '') +
    (t.widthOverrides ? `,widthOverrides:${JSON.stringify(t.widthOverrides.map(({ name, from, to, halfW }) => ({ name, from, to, halfW })))}` : '') +
    (t.bankMaxDeg ? `,bankMaxDeg:${t.bankMaxDeg}` : '') + (t.layout ? `,layout:${JSON.stringify(t.layout)}` : '') +
    '}').join(',\n');
  const outText = `${header}window.F1_TRACKS = [\n${body}\n];\n`;
  if (!dry) writeFileSync(outFile, outText, 'utf8');

  for (const t of tracks) {
    const s = t._stats;
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(42)} ${String(t.points.length).padStart(4)} pts  ` +
      `${t.lengthKm.toFixed(3)} km  (projected ${(s.projected / 1000).toFixed(3)}, official ${(s.official / 1000).toFixed(3)}` +
      `${LENGTH_OVERRIDE[t.id] ? ' [LENGTH_OVERRIDE; dataset ' + (s.datasetLength / 1000).toFixed(3) + ']' : ''}, ` +
      `gap ${s.gap.toFixed(0)} m, maxSeg ${s.maxSeg.toFixed(0)} m)`);
    for (const nt of s.layoutNotes || []) console.log(`         layout patch: ${nt}`);
  }
  console.log('\nElevation (raw = model samples, out = emitted elev, pub = published range where known):');
  console.log('id       name                                        pts src->out  source    raw range  out range  max grad    pub  mode');
  for (const t of tracks) {
    const s = t._stats, pub = PUBLISHED[t.id];
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(42)} ${(s.srcPoints + '->' + t.points.length).padStart(10)}  ${t.elevSource.padEnd(9)}` +
      `${s.rawRange.toFixed(0).padStart(7)} m  ${s.range.toFixed(1).padStart(7)} m  ${(s.maxGrad * 100).toFixed(1).padStart(6)} %  ` +
      `${pub ? (pub[0] + ' m').padStart(7) : '      -'}  ` +
      (s.flat ? `flat (x${s.scale.toFixed(2)})` : (SOURCES[t.elevSource].dtm ? 'terrain model' : 'normal') + (s.scale !== 1 ? ` (x${s.scale.toFixed(3)} to the published range)` : '')) + `  base ${+(+s.rawMin).toFixed(2)} m` +
      `  100 m: +${(s.rise100 * 100).toFixed(1)} / ${(s.fall100 * 100).toFixed(1)} %` +
      (ELEV_SETTINGS[t.id] ? `  [median +-${s.medHalf}, sigma ${s.sigma} m${ELEV_SETTINGS[t.id].envelope ? ', low envelope' : ''}]` : '') +
      (s.holes ? `  ${s.holes} no-data samples filled` : '') + (s.covered.length ? '  covered: ' + s.covered.join('; ') : '') +
      (s.dips.length ? '  dip: ' + s.dips.join('; ') : ''));
    const set = ELEV_SETTINGS[t.id];
    if (set && set.maxRise && s.rise100 > set.maxRise) warn(`${t.id}: steepest climb ${(s.rise100 * 100).toFixed(1)} % over 100 m > ${(set.maxRise * 100).toFixed(0)} %`);
  }
  console.log('\nBanked corners (bankOverrides):');
  for (const t of tracks) {
    for (const b of t.bankOverrides || []) {
      console.log(`${t.id.padEnd(8)} ${b.name.padEnd(28)} ${String(b.deg).padStart(5)} deg  from ${b.from.toFixed(5)} (${b._m[0].toFixed(0)} m) ` +
        `to ${b.to.toFixed(5)} (${b._m[1].toFixed(0)} m), ${b._m[2].toFixed(0)} m at full angle${b._m[3] ? ' (ends given reversed: swapped)' : ''}`);
    }
  }
  console.log('\nNarrow stretches (widthOverrides) and derived-banking caps (bankMaxDeg):');
  for (const t of tracks) {
    for (const w of t.widthOverrides || []) {
      console.log(`${t.id.padEnd(8)} ${w.name.padEnd(28)} half width ${w.halfW} m  from ${w.from.toFixed(5)} (${w._m[0].toFixed(0)} m) to ${w.to.toFixed(5)} (${w._m[1].toFixed(0)} m), ${w._m[2].toFixed(0)} m${w._m[3] ? ' (ends given reversed: swapped)' : ''}`);
    }
  }
  console.log(`street circuits (bankMaxDeg ${STREET_BANK_MAX_DEG}): ${tracks.filter((t) => t.bankMaxDeg).map((t) => t.id).join(' ')}`);
  console.log('\nStart / finish line moved (START_AT) and pit lane facts (PIT_FACTS):');
  for (const t of tracks) {
    if (t._start) console.log(`${t.id.padEnd(8)} points[0] = ${t._start.s.toFixed(0)} m into the dataset's lap, ${t._start.dist.toFixed(1)} m from the given line`);
    if (t.pit) console.log(`${t.id.padEnd(8)} pit ${JSON.stringify(t.pit)}`);
    if (t.layout) console.log(`${t.id.padEnd(8)} layout: ${t.layout}`);
  }
  console.log('\nSources of the published figures:');
  for (const [id, p] of Object.entries(PUBLISHED)) console.log(`  ${id}: ${p[1]}`);
  console.log(`\ngeo self-check: worst re-projection error ${geoWorst.toFixed(4)} m (limit 0.05)`);
  if (check) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    const same = cur === outText;
    console.log(`\n--check: the build ${same ? 'equals' : 'DIFFERS FROM'} ${OUT}; ${warnings.length} warning(s).`);
    if (!same) process.exitCode = 1;
    return;
  }
  console.log(`\n${tracks.length} circuits ${dry ? 'built (dry run, nothing written)' : 'written to ' + outFile}; ${warnings.length} warning(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
