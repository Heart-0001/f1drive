// Builds js/seasons-data.js (window.F1_SEASONS): the seasons 2010..2026 of the Grand Prix year selector, each with its
// STANDARD car (the era physics, every multiplier 1) and every real team's car of that year (multipliers on the era).
//
//   node tools/build-cars.mjs            write js/seasons-data.js (and devtests/seasons-calib/entries.json, the solve log,
//                                        and the calibration table of docs/seasons-data.md, between its markers)
//   node tools/build-cars.mjs --check    compute and compare with the files on disk; exit code 1 when they differ
//   node tools/build-cars.mjs --dry      compute and print, write nothing
//   node tools/build-cars.mjs --quiet    no per-season tables
// Takes about 40 s (builds the calibration circuits = all 40 of tracks-data.js and their racing lines, then solves one
// level per car).
//
// Inputs (all committed, nothing is downloaded; the same inputs always give byte-identical output):
//   tools/seasons-raw.json          F1DB (CC BY 4.0) seasons, entries, qualifying pace, character, era pace index
//   tools/eras.json                 regulation periods: power-to-weight, top speeds, grip notes, ERS, rpm, gears
//   tools/liveries/*.json           colours, Traditional Chinese team names and notes per entry
//   js/cars-data.js                 the hand-researched 2026 grid (multipliers, notes, colours take precedence)
//   tools/ers-data.json             every car's battery 2011-2026 (docs/ers-data.md): hasErs, deploy / harvest / store
//                                   multipliers and a one-line Traditional Chinese note
//   devtests/seasons-calib/ers-effect.json   the DRIVEN lap-time effect of every car's battery (the season's standard
//                                   car with that battery, deploying, on every calibration circuit), written by
//                                   node devtests/seasons-calib/ers-effect.mjs; refused when stale or incomplete
//   devtests/seasons-calib/calibration.json   the DRIVEN calibration of every season's standard car (the era grip
//                                   scale and the ERS harvest of the KERS / 2026 seasons), written by
//                                   node devtests/seasons-calib/calibrate.mjs with the real js/car.js + autopilot;
//                                   refused when its fingerprint of the other inputs no longer matches
//   js/car.js, js/raceline.js, js/track.js, tracks-data.js   the real physics (F1.REF_SPEC is the 2025 anchor)
//
// METHOD (docs/seasons-data.md, section "遊戲資料與校正", repeats it in Traditional Chinese)
//  A. Era physics = F1.REF_SPEC (the v5 car, = the 2025 standard car, bit for bit) times factors from tools/eras.json,
//     each factor the ratio of the season's figure to 2025's:
//       power      <- race-trim power-to-weight (combustion + the electric power the energy rules sustain)
//       traction   <- power-to-weight in the acceleration zones (the peak with ERS 2014-2026, race trim before):
//                     in the game model the car is traction-limited up to ~317 km/h, so this IS its acceleration
//       dragK      <- the top speed without DRS (typical Monza figure minus the FIA's DRS gain), so that the
//                     standard car reaches 330 km/h x (V_season / V_2025) at full throttle
//       latBase, brakeBase <- mechanical grip: (mean tyre tread width ratio)^0.3 (wider = more grip, less than
//                     proportionally: tyre load sensitivity) x the grip scale
//       latMax     <- peak lateral g (the tyre saturation cap)
//       downforce  <- peak lateral g / mechanical grip (fast corners: grip x downforce) x the grip scale
//       grip scale <- CALIBRATED (devtests/seasons-calib): the value that makes the standard car, driven by the node
//                     autopilot with the real js/car.js on the racing line built for it, lap the calibration
//                     circuits (every circuit of the game) in (median) era index x the 2025 standard car's time. Aero and grip are the one free
//                     number: where the index and the eras.json figures disagree they move, not the power. (Downforce
//                     alone would have to swing from x0.49 (2026) to x1.27 (2020): lap times are not very sensitive to it.)
//                     Real pole laps used the battery, so both cars should be driven deploying it (calibration.json
//                     `deploy`): without it, pressing E adds 0.4..0.7 s a lap with KERS, 2..3.5 s with the ERS and
//                     3.6..4.7 s in 2026 on top of the index and the season order inverts (final review, 2026-10-01).
//                     The driven median must be within CFG.INDEX_TOL of the index (else refused).
//       drivetrain <- gears (7 to 2013, 8 from 2014), rpm (eras.json; V6 max 15 000; the anchor 2025 keeps
//                     F1.REF_SPEC's), shift sound time, cylinders / aspiration, cockpit style
//       ers        <- null 2010; KERS 2011-2013 (60 kW, a 400 kJ store); F1.REF_SPEC.ers 2014-2025; 2026 350 kW with
//                     a 4 MJ store; power and store scaled per kg against the reference (120 kW, 4 MJ, 805 kg), the
//                     harvest of KERS / 2026 CALIBRATED so that a lap recovers the rules' budget (KERS: 400 kJ = one
//                     store per lap; 2026: 8.5 MJ = 2.1 stores per lap through the 4 MJ window). 2026 also fades the
//                     deploy power out between 290 and 345 km/h (FIA C5.2.8; ers.taperKmh, eras.json).
//  B. Cars of a season (not 2026): lap-time target = K x (qualifying gap - median gap), K = SPREAD / (max - min gap)
//     (the real order and proportions, compressed to SPREAD % between the fastest and the slowest car; the standard
//     car sits where the median team is). Engine: the teams of one engine maker (F1DB engineBuiltBy: TAG Heuer and
//     Toro Rosso 2016-2018 are Renault, BWT Mercedes is Mercedes) share power = 1 + ENGINE_GAIN x (median fast-circuit
//     lean of the group, %) / 100, and ENGINE_TRACTION of that on traction. Wing level: drag = downforce = 1 - TRIM_GAIN
//     x (the team's own lean minus its engine group's) / 100 (a fast-circuit car runs less wing). Chassis level L:
//     grip, brake, traction and downforce + L (as js/cars-data.js's method), solved (profile model = js/raceline.js's
//     speed profile on the calibration circuits, mean lap delta) so that the lap-time target is hit.
//     Battery (tools/ers-data.json, 2011-2026): deploy / harvest / store are the car's ersPower / ersHarvest / ersStore
//     (they REPLACE any other ERS multiplier, js/cars-data.js's 2026 ones included); hasErs false = no battery (ers: null).
//     The lap-time target is the lap WITH the battery deployed (as the calibration drives it), and the profile model has
//     no battery, so the car's battery effect (ers-effect.json: mean over the calibration circuits of the driven lap of
//     the season's standard car with this battery / without a change, %) is added to the profile delta: a strong battery
//     gets a correspondingly weaker chassis level L, a car without KERS a stronger one (same lap time, other character).
//     2026: js/cars-data.js's power, drag and chassis multipliers, its target the profile delta they give (the cars-data
//     pace was derived without the battery), then the same level L on top so that the new battery keeps that lap time.
//  C. Ratings 0..100 (50 = the season's standard car): the measures and gains of js/cars-data.js
//     (devtests/cars-data/derive.js), 50 + gain x near 50, compressed with a tanh towards the ends (RATING, ratingOf);
//     the battery's gain lowered for the wider ERS range, 0 for a car without a battery.
'use strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
const require = createRequire(import.meta.url);
const P = (...a) => join(ROOT, ...a);

export const OUT_JS = P('js', 'seasons-data.js');
export const CALIB_FILE = P('devtests', 'seasons-calib', 'calibration.json');
export const ENTRIES_FILE = P('devtests', 'seasons-calib', 'entries.json');
export const ERS_FILE = P('tools', 'ers-data.json');
export const ERS_EFFECT_FILE = P('devtests', 'seasons-calib', 'ers-effect.json');

// ---- configuration ------------------------------------------------------------------------------------------------
export const CFG = {
  FIRST: 2010, LAST: 2026, ANCHOR: 2025, CURRENT: 2026,
  // calibration circuits: 'all' = every circuit of tracks-data.js (the room can race any of them); the era index is
  // matched by the MEDIAN over them, the cars' targets by the MEAN. (Until the independent check of 2026-10-01 this was
  // a hand-picked 12: Monza, Spa, Silverstone, Suzuka, Red Bull Ring, Montreal, Interlagos, Hungaroring, Bahrain,
  // Barcelona, Monaco, Singapore. A season's lap ratio differs from circuit to circuit - the low-downforce seasons 2010,
  // 2014-2016, 2022 and 2026 lose most on fast-corner circuits, least on Monza, Monaco and the street circuits - and those 12
  // held five of the circuits where those seasons look fastest, so 2014 / 2015 came out 0.7 % too slow over the whole
  // game and 1.0 % too slow on Sepang, COTA, Jeddah and Zandvoort: devtests/seasons-calib/check-drive.js.)
  TRACKS: 'all',
  GRIP_WIDTH_EXP: 0.3,          // mechanical grip ~ (tread width ratio)^0.3
  SPREAD: 1.25,                 // % lap time between the fastest and the slowest car of a season (like 2026)
  ENGINE_GAIN: 8,               // power % per % of the engine group's fast-circuit lean ...
  ENGINE_TRACTION: 0.25,        //   ... and this share of it on traction (the drivetrain's part of the acceleration)
  ENGINE_SINGLE: 0.5,           // an engine used by one team only: this share of its lean is the engine's
  TRIM_GAIN: 5,                 // drag and downforce % per % of the team's own lean beyond its engine group's
  MIN: 0.95, MAX: 1.05, DECIMALS: 4,
  // the battery multipliers (tools/ers-data.json): deploy / harvest and store have wider ranges than the rest. A product
  // with the era value must also stay inside js/car.js's F1.sanitizeSpec window (1/10..10 x the reference): 2026's
  // harvest is calibrated at 2190 W/kg = that ceiling / 1.05, so a 2026 harvest above 1.0502 is cut to it
  ERS_MIN: 0.75, ERS_MAX: 1.15, STORE_MIN: 0.9, STORE_MAX: 1.1,
  INDEX_TOL: 0.003,             // |driven median - era index| the task allows (0.3 %); a calibration beyond it is refused
                                // (beyond calibration.json's own, tighter tolerance it is reported as a warning)
  SIG: 6                        // significant digits of the era physics (the 2025 anchor is written unrounded)
};
// rating = 50 + 50 tanh(gain * x / 50), rounded; x = 0 for the season's standard car. Near 50 it is js/cars-data.js's
// 50 + gain * x (the same slope); the tanh compresses the ends instead of clamping them at 0 / 100, where 17 cars of
// 2010-2026 piled up (2010 HRT and Virgin both accel 0, 2016 Manor and 2020 Renault topSpeed 100; final review).
export const ratingOf = gx => clamp(Math.round(50 + 50 * Math.tanh(gx / 50)), 0, 100);
export const RATING = {
  topSpeed: { gain: 11, x: '極速（不含電池）與標準車的差，km/h' },
  accel: { gain: 12, x: '0–300 km/h（乘以該年標準車極速 / 330 km/h）所需時間比標準車少的百分比' },
  cornering: { gain: 23, x: '半徑 30 / 60 / 120 m 平地彎的過彎速度，比標準車高的百分比（三者平均）' },
  braking: { gain: 20, x: '300→80 km/h 煞車距離比標準車短的百分比' },
  // (js/cars-data.js: 13 for its 0.97..1.02; the per-car batteries span 0.76..1.12, so 3.5: Honda 2015 6, Mercedes 2014 80)
  ers: { gain: 3.5, x: '(ersPower − 1) 與 (ersHarvest − 1) 的平均，%；沒有電池的車 0 分' }
};
export const MULT_KEYS = ['power', 'drag', 'downforce', 'grip', 'brake', 'traction', 'ersPower', 'ersHarvest', 'ersStore'];
export const ERS_KEYS = ['ersPower', 'ersHarvest', 'ersStore'];
const ONES = { power: 1, drag: 1, downforce: 1, grip: 1, brake: 1, traction: 1, ersPower: 1, ersHarvest: 1, ersStore: 1 };
// the allowed range of a multiplier (the same as js/cars.js clamps to)
export const multRange = k => k === 'ersStore' ? [CFG.STORE_MIN, CFG.STORE_MAX] :
  (k === 'ersPower' || k === 'ersHarvest' ? [CFG.ERS_MIN, CFG.ERS_MAX] : [CFG.MIN, CFG.MAX]);
const CORNER_RADII = [30, 60, 120];

// ---- documented display overrides (applied here; tools/seasons-raw.json itself is never edited) --------------------
// Team names as the championship classified them where F1DB files the entry under another name.
export const TEAM_NAMES = {
  '2010-sauber': { value: 'BMW Sauber', f1db: 'Sauber', why: 'entered and classified as "BMW Sauber-Ferrari" (BMW Sauber F1 Team) although BMW had left', source: 'https://en.wikipedia.org/wiki/2010_Formula_One_World_Championship' },
  '2011-lotus-racing': { value: 'Lotus', f1db: 'Lotus Racing', why: 'championship constructor "Lotus" (Lotus-Renault), entrant Team Lotus', source: 'https://en.wikipedia.org/wiki/2011_Formula_One_World_Championship' }
};
// Full chassis names where F1DB uses the short form.
export const CHASSIS_NAMES = {
  '2014-mercedes': 'F1 W05 Hybrid', '2015-mercedes': 'F1 W06 Hybrid', '2016-mercedes': 'F1 W07 Hybrid',
  '2017-mercedes': 'F1 W08 EQ Power+', '2018-mercedes': 'F1 W09 EQ Power+', '2019-mercedes': 'F1 W10 EQ Power+',
  '2020-mercedes': 'F1 W11 EQ Performance', '2021-mercedes': 'F1 W12 E Performance', '2022-mercedes': 'F1 W13 E Performance',
  '2023-mercedes': 'F1 W14 E Performance', '2024-mercedes': 'F1 W15 E Performance', '2025-mercedes': 'F1 W16 E Performance',
  '2026-mercedes': 'F1 W17 E Performance',            // js/cars-data.js and F1DB: 'W17' / 'F1 W17'
  '2015-lotus-f1': 'E23 Hybrid'
};
export const CHASSIS_SOURCE = 'https://en.wikipedia.org/wiki/Mercedes-Benz_in_Formula_One (car names), https://en.wikipedia.org/wiki/Mercedes_W17 ("Mercedes-AMG F1 W17 E Performance"), https://en.wikipedia.org/wiki/Lotus_E23_Hybrid';
// Engine designations F1DB only has as a badge: the rebadged Mercedes units of Racing Point.
export const ENGINE_DESIGNATIONS = {
  '2019-racing-point': { value: 'M10 EQ Power+', f1db: 'BWT Mercedes (badge only)', source: 'https://en.wikipedia.org/wiki/Racing_Point_RP19' },
  '2020-racing-point': { value: 'M11 EQ Performance', f1db: 'BWT Mercedes (badge only)', source: 'https://en.wikipedia.org/wiki/Racing_Point_RP20' }
};

// ---- inputs -------------------------------------------------------------------------------------------------------
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
export function loadInputs() {
  const raw = readJson(P('tools', 'seasons-raw.json'));
  const eras = readJson(P('tools', 'eras.json'));
  const liveries = {};
  for (const f of ['2010-2017.json', '2018-2026.json']) Object.assign(liveries, readJson(P('tools', 'liveries', f)).entries);
  const cars2026 = require(P('js', 'cars-data.js'));
  const ersData = readJson(ERS_FILE);
  return { raw, eras, liveries, cars2026, ersData };
}

// ---- the real game modules (node: window = global) ------------------------------------------------------------------
let F1 = null;
export function loadGame() {
  if (F1) return F1;
  globalThis.window = globalThis;
  globalThis.THREE = require(P('lib', 'three.min.js'));
  require(P('tracks-data.js'));
  require(P('js', 'track.js'));
  require(P('js', 'car.js'));
  require(P('js', 'raceline.js'));
  F1 = globalThis.F1;
  return F1;
}
// the calibration circuits (tracks-data.js ids, in the file's order)
export function trackIds() {
  if (Array.isArray(CFG.TRACKS)) return CFG.TRACKS.slice();
  loadGame();
  return globalThis.F1_TRACKS.map(t => t.id);
}

// ---- helpers --------------------------------------------------------------------------------------------------------
export const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
export const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
export const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
export const round = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };
export const sig = v => Number(v.toPrecision(CFG.SIG));
const V = f => (f && typeof f === 'object' && 'v' in f) ? f.v : undefined;
const KMH = 1 / 3.6;

// ---- A. era physics ---------------------------------------------------------------------------------------------------
// The eras.json figures the physics is derived from (every value is read from the file; see METHOD above).
export function eraInputs(eras, year) {
  const p = eras.periods.find(q => year >= q.years[0] && year <= q.years[1]);
  const s = eras.seasons[String(year)];
  if (!p || !s) throw new Error('tools/eras.json has no period / season for ' + year);
  const ersType = p.ers.type;
  const pwRace = V(s.powerToWeight.qualifyingRaceTrim), pwPeak = V(s.powerToWeight.qualifyingPeak);
  const drs = V(p.topSpeed.drs) === true;
  const inp = {
    // the season's own display label where the period's would announce a later year's change (2017: '...; 2018 起有 Halo')
    year, period: p.id, label: typeof s.label === 'string' && s.label ? s.label : p.label, engineDisplay: p.engineDisplay,
    ersType, pwRace, pwPeak,
    pwAccel: ersType === 'ERS' || ersType === 'ERS-2026' ? pwPeak : pwRace,
    topNoDrs: V(p.topSpeed.typicalTopKmh) - (drs ? V(p.topSpeed.drsGain) : 0),
    front: V(p.grip.tyres.frontWidth), rear: V(p.grip.tyres.rearWidth),
    latG: V(p.grip.lateralGPeak), brakeG: V(p.grip.brakingGPeak),
    mass: V(s.qualifyingMass),
    ersKw: ersType === 'none' ? 0 : V(p.ers.power), ersStoreMJ: ersType === 'none' ? 0 : V(p.ers.storeWindow),
    ersHarvestMJ: ersType === 'none' ? 0 : V(p.ers.harvestPerLap),
    // 2026: the ERS-K power fades with speed (C5.2.8): [full power up to, zero from] km/h; null = no taper
    ersTaperKmh: p.ers.taperKmh ? V(p.ers.taperKmh) : null,
    gears: V(p.gearbox.forwardGears), shiftTime: V(p.gearbox.gameShiftTime),
    cylinders: V(p.engine.cylinders), aspiration: V(p.engine.aspiration) === 'na' ? 'na' : 'hybrid',
    rpmIdle: V(p.engine.rpmIdle), rpmShift: V(p.engine.rpmShiftRaceTrim), rpmLimit: V(p.engine.revLimitRegulation),
    cockpit: s.cockpit
  };
  for (const k of Object.keys(inp)) if (inp[k] === undefined || (typeof inp[k] === 'number' && !isFinite(inp[k]))) throw new Error('tools/eras.json ' + year + ': ' + k + ' missing');
  const tk = inp.ersTaperKmh;               // (js/car.js's range: 50 <= from, from + 1 <= to <= 600)
  if (tk !== null && !(Array.isArray(tk) && tk.length === 2 && tk[0] >= 50 && tk[1] >= tk[0] + 1 && tk[1] <= 600)) throw new Error('tools/eras.json ' + year + ': ers.taperKmh must be [full power up to, zero from] km/h');
  return inp;
}

// Factors against the anchor (2025): each is the same expression evaluated for the season and for 2025, so every
// factor of 2025 is exactly 1 and its physics is F1.REF_SPEC's, bit for bit.
export function eraFactors(eras, year) {
  const G = loadGame(), R = G.REF_SPEC, CP = G.CAR_PERF;
  const inp = eraInputs(eras, year), a = eraInputs(eras, CFG.ANCHOR);
  const P = inp.pwRace / a.pwRace, A = inp.pwAccel / a.pwAccel;
  const vRef = CP.topSpeed;                                     // 330 km/h: the reference's top speed
  const vTop = vRef * inp.topNoDrs / a.topNoDrs;
  // drag that balances the drive at the target top speed (the drive is the lower of traction and power / v)
  const dragFor = (Pw, Tr, v) => (Math.min(Tr, Pw / v) - CP.roll) / (v * v);
  const fDrag = dragFor(R.power * P, R.traction * A, vTop) / dragFor(R.power, R.traction, vRef);
  const wr = 0.5 * (inp.front / a.front + inp.rear / a.rear);
  const mech = Math.pow(wr, CFG.GRIP_WIDTH_EXP);
  const latMax = inp.latG / a.latG;
  return {
    inputs: inp, power: P, traction: A, drag: fDrag, topKmh: vTop / KMH, tyreWidth: wr, mech: mech,
    latMax: latMax,
    // downforce before calibration: the peak lateral g not explained by the tyres (fast corners: mu x downforce)
    downforce: latMax / mech,
    ersPower: inp.ersKw && a.ersKw ? (inp.ersKw / inp.mass) / (a.ersKw / a.mass) : 0,
    ersStore: inp.ersStoreMJ && a.ersStoreMJ ? (inp.ersStoreMJ / inp.mass) / (a.ersStoreMJ / a.mass) : 0
  };
}

// The era part of a CarSpec (physics / drivetrain / ers / cockpit) for a grip scale (the calibrated number: it
// multiplies the downforce, the mechanical lateral grip and the braking grip) and an ERS harvest (W/kg; only used
// where the season's ERS is not the reference's). The anchor year returns F1.REF_SPEC's own values.
export function eraSpec(eras, year, gripScale, ersHarvest) {
  const G = loadGame(), R = G.REF_SPEC;
  const f = eraFactors(eras, year), inp = f.inputs, anchor = year === CFG.ANCHOR;
  const num = (ref, k) => anchor ? ref * 1 : sig(ref * k);
  const e = {
    power: num(R.power, f.power),
    dragK: num(R.dragK, f.drag),
    downforce: num(R.downforce, f.downforce * gripScale),
    latBase: num(R.latBase, f.mech * gripScale),
    latMax: num(R.latMax, f.latMax),
    brakeBase: num(R.brakeBase, f.mech * gripScale),
    traction: num(R.traction, f.traction)
  };
  const ers = inp.ersType === 'none' ? null : (inp.ersType === 'ERS' ? { store: R.ers.store, power: R.ers.power, harvest: R.ers.harvest } :
    { store: sig(R.ers.store * f.ersStore), power: sig(R.ers.power * f.ersPower), harvest: sig(ersHarvest) });
  // 2026: the deploy power fades out between taperKmh[0] and [1] (js/car.js: the deploy step and topSpeedBoost)
  if (ers && inp.ersTaperKmh) ers.taperKmh = inp.ersTaperKmh.slice();
  // drivetrain: top gear reaches rpmShift at the top speed deploying the battery, at most the reference's ratio of
  // 345 / 330 km/h above the top speed without it (the reference: 345 km/h, its boost top speed is 346), in 5 km/h
  // steps: the V8 of 2010 revs to its limit at top speed
  const perf = G.carPerf(Object.assign({}, R, e, { ers }));
  const top = perf.topSpeed / KMH, ratio = R.topKmh / (G.CAR_PERF.topSpeed / KMH);
  const topKmh = anchor ? R.topKmh : 5 * Math.round(Math.max(top, Math.min(perf.topSpeedBoost / KMH, top * ratio)) / 5);
  let gearKmh;
  if (anchor) gearKmh = R.gearKmh.slice();
  else if (inp.gears === R.gearKmh.length + 1) gearKmh = R.gearKmh.map(g => Math.round(g * topKmh / R.topKmh));
  else {
    // other gear counts: the reference's first and last upshift ratios, evenly in between
    const n = inp.gears - 1, lo = R.gearKmh[0] / R.topKmh, hi = R.gearKmh[R.gearKmh.length - 1] / R.topKmh;
    gearKmh = [];
    for (let i = 0; i < n; i++) gearKmh.push(Math.round(topKmh * (lo + (hi - lo) * i / (n - 1))));
  }
  e.gearKmh = gearKmh;
  e.topKmh = topKmh;
  e.rpmIdle = anchor ? R.rpmIdle : inp.rpmIdle;
  e.rpmShift = anchor ? R.rpmShift : inp.rpmShift;
  // V8: the 18 000 rpm regulation limit; V6: 15 000 (the regulation / the 2026 gear check), the anchor keeps REF's
  e.rpmMax = anchor ? R.rpmMax : (inp.rpmLimit || 15000);
  // shift sound: eras.json's game value for the V8s (0.04 s); the turbo-hybrids keep the reference's 0.05 s
  e.shiftTime = anchor ? R.shiftTime : (inp.aspiration === 'na' ? inp.shiftTime : R.shiftTime);
  e.cylinders = inp.cylinders;
  e.aspiration = inp.aspiration;
  e.ers = ers;
  e.cockpit = inp.cockpit;
  return e;
}
export const ersCalibrated = (eras, year) => { const t = eraInputs(eras, year).ersType; return t === 'KERS' || t === 'ERS-2026'; };
// store refills per lap the rules allow: KERS 0.4 MJ harvested / 0.4 MJ store; 2026 8.5 MJ / 4 MJ
export const ersLapTarget = (eras, year) => { const i = eraInputs(eras, year); return i.ersStoreMJ ? i.ersHarvestMJ / i.ersStoreMJ : 0; };

// A fingerprint of everything the driven calibration depends on except the calibrated numbers themselves: the
// config, F1.REF_SPEC, every season's era physics before calibration, the pace index and the reference car's
// racing-line lap on each calibration circuit (which changes with the tracks, the line or the car physics).
export function priorsFingerprint(eras, raw) {
  const G = loadGame();
  const out = { cfg: { TRACKS: trackIds(), GRIP_WIDTH_EXP: CFG.GRIP_WIDTH_EXP, SIG: CFG.SIG, ANCHOR: CFG.ANCHOR }, ref: G.REF_SPEC, years: {},
    refLaps: geometries().map(g => [g.id, g.N, g.refLapTime]) };
  for (let y = CFG.FIRST; y <= CFG.LAST; y++) {
    const e = eraSpec(eras, y, 1, 100);
    const s = raw.seasons.find(q => q.year === y);
    out.years[y] = { e, index: s ? s.eraIndex : null, ersLap: ersLapTarget(eras, y) };
  }
  return createHash('sha256').update(JSON.stringify(out)).digest('hex').slice(0, 16);
}

// ---- profile model: the speed profile of js/raceline.js on a stored line geometry -------------------------------------
// (a copy of devtests/cars-data/model.js lineGeometry / lap, with the perf of F1.carPerf; checked against
// F1.buildRaceLine(track, perf).lapTime at start-up)
const GRIP_MARGIN = 0.86, STEER_MARGIN = 1.22, BRAKE_MARGIN = 0.80, CREST_SPAN = 3, MIN_SPEED = 7;
function cornerSpeed(p, k, bank, pitch, kappaV, turnSign) {
  k = Math.abs(k);
  if (k < 1e-6) return p.topSpeed;
  let v = p.topSpeed;
  if (GRIP_MARGIN * p.maxLatAccel(v, bank, pitch, kappaV, turnSign) < v * v * k) {
    let lo = MIN_SPEED, hi = p.topSpeed;
    if (GRIP_MARGIN * p.maxLatAccel(lo, bank, pitch, kappaV, turnSign) < lo * lo * k) v = lo;
    else {
      for (let it = 0; it < 18; it++) {
        const mid = 0.5 * (lo + hi);
        if (GRIP_MARGIN * p.maxLatAccel(mid, bank, pitch, kappaV, turnSign) >= mid * mid * k) lo = mid; else hi = mid;
      }
      v = lo;
    }
  }
  const x = Math.atan(p.wheelbase * k * STEER_MARGIN);
  if (x >= p.steerLock) v = MIN_SPEED;
  else v = Math.min(v, p.steerSpeedRef * Math.sqrt(p.steerLock / x - 1));
  return Math.max(MIN_SPEED, Math.min(p.topSpeed, v));
}
function lineGeometry(track, line, grav) {
  const S = track.samples, N = S.length, Pt = line.points;
  const seg = new Float64Array(N), slope = new Float64Array(N), curv = new Float64Array(N);
  const bank = new Float64Array(N), pitch = new Float64Array(N), gsin = new Float64Array(N);
  const kv = new Float64Array(N), kvSafe = new Float64Array(N), latSign = new Float64Array(N);
  let i, j;
  for (i = 0; i < N; i++) {
    j = (i + 1) % N;
    let sl = Math.hypot(Pt[j].x - Pt[i].x, Pt[j].z - Pt[i].z);
    if (sl < 0.05) sl = 0.05;
    seg[i] = sl; curv[i] = Pt[i].curvature;
  }
  for (i = 0; i < N; i++) {
    const i3 = (i + 3) % N, im3 = (i - 3 + N) % N;
    let run = 0;
    for (j = 0; j < 6; j++) run += seg[(im3 + j) % N];
    const rise = Pt[i3].y - Pt[im3].y;
    slope[i] = rise / Math.hypot(run, rise);
  }
  for (i = 0; i < N; i++) {
    const sp = S[(i - 1 + N) % N], sc = S[i], sq = S[(i + 1) % N];
    const gp = Math.hypot(sc.x - sp.x, sc.z - sp.z), gq = Math.hypot(sq.x - sc.x, sq.z - sc.z);
    let k0 = 0;
    if (typeof sc.y === 'number' && typeof sp.y === 'number' && typeof sq.y === 'number' && gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10) {
      k0 = -((sq.y - sc.y) / gq - (sc.y - sp.y) / gp) / (0.5 * (gp + gq));
    }
    kv[i] = isFinite(k0) ? k0 : 0;
    bank[i] = +sc.bank || 0;
    pitch[i] = Math.asin(slope[i]);
    gsin[i] = grav * slope[i];
    latSign[i] = curv[i] < 0 ? 1 : -1;
  }
  for (i = 0; i < N; i++) {
    let km = kv[i];
    for (j = -CREST_SPAN; j <= CREST_SPAN; j++) { const kq = kv[((i + j) % N + N) % N]; if (kq > km) km = kq; }
    kvSafe[i] = km;
  }
  return { N, seg, curv, bank, pitch, gsin, kvSafe, latSign };
}
export function profileLap(geo, p) {
  const N = geo.N, seg = geo.seg, curv = geo.curv, bank = geo.bank, pitch = geo.pitch, gsin = geo.gsin;
  const kvSafe = geo.kvSafe, latSign = geo.latSign;
  const vAllow = new Float64Array(N), vT = new Float64Array(N);
  let i, j, m, iMin = 0;
  for (i = 0; i < N; i++) {
    const k = Math.max(Math.abs(curv[i]), Math.abs(curv[(i + 1) % N]), Math.abs(curv[(i - 1 + N) % N]));
    vAllow[i] = cornerSpeed(p, k, bank[i], pitch[i], kvSafe[i], latSign[i]);
    if (vAllow[i] < vAllow[iMin]) iMin = i;
  }
  const latAt = (idx, v) => { let a = v * v * Math.abs(curv[idx]); if (a > p.latMax) a = p.latMax; return a * latSign[idx]; };
  for (m = 0; m < 2 * N; m++) {
    i = ((iMin - 1 - m) % N + N) % N; j = (i + 1) % N;
    const v1 = vAllow[j], coast = p.roll + p.dragK * v1 * v1 + gsin[i];
    let dec = p.maxDecel(v1, bank[i], pitch[i], kvSafe[i], latAt(i, v1)) - coast;
    dec = BRAKE_MARGIN * dec + coast;
    if (dec < 1) dec = 1;
    const vb = Math.sqrt(v1 * v1 + 2 * dec * seg[i]);
    if (vb < vAllow[i]) vAllow[i] = vb;
  }
  for (i = 0; i < N; i++) vT[i] = vAllow[i];
  for (m = 0; m < 2 * N; m++) {
    i = (iMin + m) % N; j = (i + 1) % N;
    const v1 = vT[i], acc = p.maxAccel(v1, bank[i], pitch[i], kvSafe[i], latAt(i, v1));
    const v2 = v1 * v1 + 2 * acc * seg[i];
    const vf = v2 > MIN_SPEED * MIN_SPEED ? Math.sqrt(v2) : MIN_SPEED;
    if (vf < vT[j]) vT[j] = vf;
  }
  let t = 0, vmax = 0;
  for (i = 0; i < N; i++) { t += seg[i] / (0.5 * (vT[i] + vT[(i + 1) % N])); if (vT[i] > vmax) vmax = vT[i]; }
  return t;
}
// The calibration circuits: car-independent line geometry + the reference lap of the real module (self-check)
let GEOS = null;
export function geometries() {
  if (GEOS) return GEOS;
  const G = loadGame();
  GEOS = trackIds().map(id => {
    const td = globalThis.F1_TRACKS.find(t => t.id === id);
    if (!td) throw new Error('tracks-data.js has no track ' + id);
    const track = G.buildTrack(td), line = G.buildRaceLine(track);
    const geo = lineGeometry(track, line, G.CAR_PERF.gravity);
    geo.id = id; geo.name = td.name; geo.refLapTime = line.lapTime;
    const own = profileLap(geo, G.CAR_PERF);
    if (Math.abs(own - line.lapTime) > 1e-6) throw new Error('profile model differs from js/raceline.js on ' + id + ': ' + own + ' vs ' + line.lapTime);
    line.dispose(); track.dispose();
    return geo;
  });
  return GEOS;
}

// ---- CarSpec from the era + multipliers (the same arithmetic as js/cars.js) ------------------------------------------
// hasErs false: the car raced without a battery (ers: null) whatever its era has
export function applyMult(era, m, hasErs) {
  const bat = !!era.ers && hasErs !== false, st = m.ersStore === undefined ? 1 : m.ersStore;
  const s = {
    power: era.power * m.power, dragK: era.dragK * m.drag, downforce: era.downforce * m.downforce,
    latBase: era.latBase * m.grip, latMax: era.latMax * m.grip, brakeBase: era.brakeBase * m.brake,
    traction: era.traction * m.traction,
    gearKmh: era.gearKmh.slice(), topKmh: era.topKmh, rpmIdle: era.rpmIdle, rpmShift: era.rpmShift, rpmMax: era.rpmMax,
    shiftTime: era.shiftTime, cylinders: era.cylinders, aspiration: era.aspiration,
    ers: bat ? { store: era.ers.store * st, power: era.ers.power * m.ersPower, harvest: era.ers.harvest * m.ersHarvest } : null,
    cockpit: era.cockpit
  };
  if (bat && era.ers.taperKmh) s.ers.taperKmh = era.ers.taperKmh.slice();
  return s;
}

// ---- the batteries (tools/ers-data.json) -------------------------------------------------------------------------------
// A car's battery on its era: { hasErs, ersPower, ersHarvest, ersStore (multipliers, 4 decimals, inside multRange and
// the F1.sanitizeSpec window of the product), note, cut: [keys cut to that window], src: the ers-data entry | null }.
// No battery in the era (2010): hasErs false and no note. hasErs false in the data: multipliers 1 (ignored).
const ERS_FIELD = { ersPower: ['deploy', 'power'], ersHarvest: ['harvest', 'harvest'], ersStore: ['store', 'store'] };
export function carErs(ersData, id, eraErs) {
  const none = { hasErs: false, ersPower: 1, ersHarvest: 1, ersStore: 1, note: '', cut: [], src: null };
  if (!eraErs) return Object.assign(none, { eraNone: true });      // like the standard car of that season
  const ent = ersData && ersData.entries && Object.prototype.hasOwnProperty.call(ersData.entries, id) ? ersData.entries[id] : null;
  if (!ent) throw new Error('tools/ers-data.json has no entry for ' + id);
  const note = typeof ent.note === 'string' ? ent.note : '';
  if (ent.hasErs === false) return Object.assign({}, none, { note, src: ent });
  const R = loadGame().REF_SPEC.ers, out = { hasErs: true, note, cut: [], src: ent };
  for (const k of ERS_KEYS) {
    const [field, ek] = ERS_FIELD[k], v = ent[field], [lo, hi] = multRange(k);
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('tools/ers-data.json ' + id + '.' + field + ' is not a number');
    // its range (multRange), 4 decimals, then the window of the product: each change is reported (NOTE)
    let m = round(clamp(v, lo, hi), CFG.DECIMALS);
    const top = Math.floor(R[ek] * 10 / eraErs[ek] * 1e4) / 1e4, bot = Math.ceil(R[ek] / 10 / eraErs[ek] * 1e4) / 1e4;
    if (m > top) m = top;
    if (m < bot) m = bot;
    if (m !== v) out.cut.push(k);
    out[k] = m;
  }
  return out;
}
// the key of a battery inside its season (ers-effect.json): 'none' or 'deploy/harvest/store'; null = the standard car's
// (also no battery in a season without one)
export const ersKey = b => b.eraNone ? null : (!b.hasErs ? 'none' :
  (b.ersPower === 1 && b.ersHarvest === 1 && b.ersStore === 1 ? null : [b.ersPower, b.ersHarvest, b.ersStore].join('/')));
// The standard car of a season (F1.REF_SPEC with the era part) from the driven calibration
export function standardSpec(eras, year, calib) {
  const cal = calib.seasons[year];
  return Object.assign({}, loadGame().REF_SPEC, eraSpec(eras, year, cal.gripScale, cal.ersHarvest));
}
// Every battery the cars of 2011..2026 have that differs from their season's standard car:
// [{ year, key, hasErs, ersPower, ersHarvest, ersStore, cars: [ids] }] (seasons ascending, keys in first-car order)
export function ersCombos(inp, calib) {
  const out = [];
  for (let year = CFG.FIRST; year <= CFG.LAST; year++) {
    const rs = inp.raw.seasons.find(s => s.year === year), era = eraSpec(inp.eras, year, calib.seasons[year].gripScale, calib.seasons[year].ersHarvest);
    for (const e of rs.entries) {
      const b = carErs(inp.ersData, e.id, era.ers), key = ersKey(b);
      if (key === null) continue;
      let c = out.find(q => q.year === year && q.key === key);
      if (!c) out.push(c = { year, key, hasErs: b.hasErs, ersPower: b.ersPower, ersHarvest: b.ersHarvest, ersStore: b.ersStore, cars: [] });
      c.cars.push(e.id);
    }
  }
  return out;
}
// what a stored ers-effect.json was measured on: the calibration (its fingerprint and each season's solved numbers)
export function ersEffectFingerprint(calib) {
  const s = {};
  for (const y of Object.keys(calib.seasons).sort()) s[y] = [calib.seasons[y].gripScale, calib.seasons[y].ersHarvest];
  return createHash('sha256').update(JSON.stringify({ calib: calib.fingerprint, deploy: calib.deploy === true, tracks: calib.tracks, s })).digest('hex').slice(0, 16);
}

// flat-road figures of a perf (menu ratings, documentation). The standing start runs to accelKmh: 300 km/h scaled
// with the season's standard top speed (300 x top / 330: exactly 300 for 2025 / 2026, js/cars-data.js's formula;
// 289 for the 318 km/h V8 + KERS cars, whose 0-300 time would be dominated by the drag near their top speed).
export function metrics(perf, accelKmh) {
  const dv = 0.05;
  let t = 0, d = 0, v;
  for (v = 0.5; v < accelKmh * KMH; v += dv) { const a = perf.maxAccel(v, 0, 0, 0, 0); if (!(a > 0.01)) { t = Infinity; break; } t += dv / a; }
  for (v = 300 * KMH; v > 80 * KMH; v -= dv) d += v * dv / perf.maxDecel(v, 0, 0, 0, 0);
  const corner = R => {
    let lo = 5, hi = 130;
    for (let i = 0; i < 50; i++) { const x = 0.5 * (lo + hi); if (perf.maxLatAccel(x, 0, 0, 0, 1) >= x * x / R) lo = x; else hi = x; }
    return 0.5 * (lo + hi) / KMH;
  };
  return { topKmh: perf.topSpeed / KMH, topBoostKmh: perf.topSpeedBoost / KMH, t0to300: t, accelKmh: accelKmh, brake300to80: d, corner: CORNER_RADII.map(corner) };
}
// hasErs false (no battery: the era's or the car's): the battery bar is 0 (the menu hides it for ers: null), x.ers null
export function ratingsFor(met, stdMet, m, hasErs) {
  const x = {
    topSpeed: met.topKmh - stdMet.topKmh,
    accel: (1 - met.t0to300 / stdMet.t0to300) * 100,
    cornering: mean(met.corner.map((c, i) => (c / stdMet.corner[i] - 1) * 100)),
    braking: (1 - met.brake300to80 / stdMet.brake300to80) * 100,
    ers: hasErs === false ? null : 0.5 * ((m.ersPower - 1) + (m.ersHarvest - 1)) * 100
  };
  const r = {};
  for (const k of Object.keys(RATING)) r[k] = x[k] === null ? 0 : ratingOf(RATING[k].gain * x[k]);
  return { ratings: r, x };
}

// ---- display strings ------------------------------------------------------------------------------------------------
const spacedL = s => s.replace(/(\d)L\b/g, '$1 L');
function engineDisplay(e) {
  const fix = ENGINE_DESIGNATIONS[e.id];
  let s = fix ? e.engineManufacturer + ' ' + fix.value : String(e.engine.fullName).replace(/\s+\d+(\.\d+)?\s+V\d+.*$/, '').trim();
  const maker = String(e.engineBuiltBy || '').split(' ')[0];
  if (maker && s.indexOf(maker) < 0) s += ' (' + e.engineBuiltBy + ')';
  return s;
}

// ---- the whole build ------------------------------------------------------------------------------------------------
export function build(opts) {
  opts = opts || {};
  const G = loadGame(), R = G.REF_SPEC;
  const { raw, eras, liveries, cars2026, ersData } = loadInputs();
  const problems = [], warnings = [], notes = [];
  if (!existsSync(CALIB_FILE)) throw new Error('missing ' + relative(ROOT, CALIB_FILE) + ': run node devtests/seasons-calib/calibrate.mjs');
  const calib = readJson(CALIB_FILE);
  const fp = priorsFingerprint(eras, raw);
  if (calib.fingerprint !== fp) problems.push('devtests/seasons-calib/calibration.json is stale (fingerprint ' + calib.fingerprint + ', inputs now ' + fp + '): run node devtests/seasons-calib/calibrate.mjs');
  // the driven lap-time effect of the batteries (devtests/seasons-calib/ers-effect.mjs)
  const ERS_RUN = 'run node devtests/seasons-calib/ers-effect.mjs';
  const ersFx = existsSync(ERS_EFFECT_FILE) ? readJson(ERS_EFFECT_FILE) : null, efp = ersEffectFingerprint(calib);
  if (!ersFx) problems.push('missing devtests/seasons-calib/ers-effect.json: ' + ERS_RUN);
  else if (ersFx.fingerprint !== efp) problems.push('devtests/seasons-calib/ers-effect.json is stale (fingerprint ' + ersFx.fingerprint + ', calibration now ' + efp + '): ' + ERS_RUN);
  const hasOwn = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  const ersPctOf = (year, key, id) => {
    if (key === null) return 0;
    const s = hasOwn(ersFx && ersFx.seasons, year) ? ersFx.seasons[year] : null, c = s && hasOwn(s.combos, key) ? s.combos[key] : null;
    if (!c || typeof c.meanPct !== 'number' || !isFinite(c.meanPct)) { if (ersFx) problems.push(id + ': ers-effect.json has no driven effect of the battery ' + year + ' ' + key + ': ' + ERS_RUN); return 0; }
    return c.meanPct;
  };
  const geos = geometries();
  const lapsOf = spec => { const p = G.carPerf(spec); return geos.map(g => profileLap(g, p)); };

  const seasons = [], log = { cfg: CFG, rating: RATING, seasons: [] };
  for (let year = CFG.FIRST; year <= CFG.LAST; year++) {
    const rs = raw.seasons.find(s => s.year === year);
    if (!rs) { problems.push('no raw season ' + year); continue; }
    const cal = calib.seasons && calib.seasons[year];
    if (!cal) { problems.push('no calibration for ' + year); continue; }
    // the driven calibration must have hit the era index (calibrate.mjs only prints a warning when it misses)
    const miss = Math.abs(cal.drivenMedian - rs.eraIndex);
    if (!(miss <= CFG.INDEX_TOL)) problems.push(year + ': calibrated driven median ' + cal.drivenMedian + ' misses the era index ' + rs.eraIndex + ' by more than ' + CFG.INDEX_TOL);
    else if (miss > calib.tolerance) warnings.push(year + ': calibrated driven median ' + cal.drivenMedian + ' misses the era index ' + rs.eraIndex + ' by ' + (miss * 100).toFixed(3) + ' % (calibration tolerance ' + (calib.tolerance * 100).toFixed(2) + ' %)');
    const inp = eraInputs(eras, year);
    const era = eraSpec(eras, year, cal.gripScale, cal.ersHarvest);
    const std = Object.assign({}, R, era);
    const stdPerf = G.carPerf(std), accelKmh = 300 * stdPerf.topSpeed / G.CAR_PERF.topSpeed;
    const stdMet = metrics(stdPerf, accelKmh), stdLaps = lapsOf(std);
    const lapDeltas = spec => lapsOf(spec).map((t, i) => (t / stdLaps[i] - 1) * 100);
    const stdEngine = spacedL(inp.engineDisplay);
    const stdCar = {
      id: year + '-standard', lineage: 'standard', team: R.team, teamZh: R.teamZh, car: R.car,
      engine: year === CFG.ANCHOR ? R.engine : stdEngine, cylinders: era.cylinders, aspiration: era.aspiration,
      colour: R.colour, colour2: R.colour2, ratings: Object.assign({}, R.ratings, era.ers ? {} : { ers: 0 }),
      perf: Object.assign({}, ONES), hasErs: !!era.ers, note: '', ersNote: '', est: { lapPct: 0, ersPct: 0, topKmh: round(stdMet.topKmh, 1) }
    };
    if (year === CFG.ANCHOR && stdCar.engine !== stdEngine) problems.push('the anchor standard engine "' + R.engine + '" differs from eras.json "' + stdEngine + '"');
    const cars = [stdCar];
    const slog = { year, index: rs.eraIndex, era, stdTopKmh: stdMet.topKmh, stdTopBoostKmh: stdMet.topBoostKmh, accelKmh, cars: [] };

    // ---- entries
    const E = rs.entries.map(e => ({ src: e, id: e.id }));
    const liv = id => liveries[id] || null;
    for (const e of E) if (!liv(e.id)) problems.push('no livery for ' + e.id);
    // every car's battery (tools/ers-data.json) and its driven lap-time effect on the season's standard car
    for (const e of E) {
      try { e.bat = carErs(ersData, e.id, era.ers); }
      catch (err) { problems.push(err.message); e.bat = { hasErs: !!era.ers, ersPower: 1, ersHarvest: 1, ersStore: 1, note: '', cut: [], src: null }; }
      e.ersKey = ersKey(e.bat);
      e.ersPct = ersPctOf(year, e.ersKey, e.id);
      for (const k of e.bat.cut) notes.push(e.id + ': ' + k + ' ' + e.bat.src[ERS_FIELD[k][0]] + ' cut to ' + e.bat[k] + ' (its range ' + multRange(k).join('..') +
        ', 4 decimals, and era x multiplier inside F1.sanitizeSpec\'s 1/10..10 x the reference)');
    }
    const ersOf = e => ({ ersPower: e.bat.ersPower, ersHarvest: e.bat.ersHarvest, ersStore: e.bat.ersStore });
    // the chassis level L: lap delta of the profile model (no battery) + the battery's driven effect = the target
    const solveLevel = (e, multFor) => {
      const f = L => mean(lapDeltas(applyWith(std, multFor(L), e.bat.hasErs))) + e.ersPct - e.target;
      // secant on L (lap delta falls monotonically with L), bracketed
      let a = -0.02, b = 0.02, fa = f(a), fb = f(b), L = 0;
      for (let it = 0; it < 40; it++) {
        L = b - fb * (b - a) / (fb - fa);
        if (!isFinite(L)) L = 0.5 * (a + b);
        const fl = f(L);
        if (Math.abs(fl) < 1e-5) break;
        a = b; fa = fb; b = L; fb = fl;
      }
      e.L = L;
      e.exact = multFor(L);
      e.mult = {};
      for (const k of MULT_KEYS) e.mult[k] = round(e.exact[k], CFG.DECIMALS);
    };
    if (year === CFG.CURRENT) {
      // the hand-researched grid: notes, colours, names as they are; power, drag and the chassis multipliers of
      // js/cars-data.js with their pace (its profile delta: derived without the battery), the battery of ers-data.json
      // and the chassis level L that keeps that pace with it
      for (const e of E) {
        const c = cars2026.find(x => '2026-' + x.id === e.id);
        if (!c) { problems.push('js/cars-data.js has no car for ' + e.id); continue; }
        const base = c.perf;
        e.target = mean(lapDeltas(applyWith(std, Object.assign({}, ONES, base))));
        solveLevel(e, L => Object.assign({ power: base.power, drag: base.drag, downforce: base.downforce + L, grip: base.grip + L,
          brake: base.brake + L, traction: base.traction + L }, ersOf(e)));
        // multipliers, notes and colours of js/cars-data.js take precedence; the Chinese team name is the fact-checked
        // one of tools/liveries (Taiwan usage, one name per lineage: 紅牛二隊 for Toro Rosso .. Racing Bulls, where
        // js/cars-data.js says 小紅牛), the chassis name the documented full name (CHASSIS_NAMES)
        const lv = liv(e.id) || {};
        e.display = { team: c.teamEn, teamZh: lv.teamZh || c.teamZh, car: CHASSIS_NAMES[e.id] || c.car, engine: c.engine, colour: c.colour, colour2: c.colour2, note: c.note };
      }
      for (const c of cars2026) if (c.id !== 'standard' && !E.find(e => e.id === '2026-' + c.id)) problems.push('js/cars-data.js car ' + c.id + ' is not in the 2026 raw season');
    } else {
      const gaps = E.map(e => e.src.pace.medianGapPct);
      const gMin = Math.min(...gaps), gMax = Math.max(...gaps), gMed = median(gaps), K = CFG.SPREAD / (gMax - gMin);
      slog.K = K; slog.gapMedian = gMed;
      // engine groups by the real maker
      const groups = new Map();
      for (const e of E) {
        const k = e.src.engineBuiltBy;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      }
      const gLean = new Map();
      for (const [k, list] of groups) {
        const leans = list.map(e => e.src.character.vsFieldPct);
        gLean.set(k, list.length > 1 ? median(leans) : CFG.ENGINE_SINGLE * leans[0]);
      }
      slog.engineGroups = [...groups.keys()].map(k => ({ builtBy: k, entries: groups.get(k).map(e => e.id), leanPct: gLean.get(k), power: 1 + CFG.ENGINE_GAIN * gLean.get(k) / 100 }));
      for (const e of E) {
        const lean = e.src.character.vsFieldPct, gl = gLean.get(e.src.engineBuiltBy);
        e.target = K * (e.src.pace.medianGapPct - gMed);
        e.engine = 1 + CFG.ENGINE_GAIN * gl / 100;
        e.trim = 1 - CFG.TRIM_GAIN * (lean - gl) / 100;
        e.leanOwn = lean - gl;
        solveLevel(e, L => Object.assign({ power: e.engine, traction: 1 + L + CFG.ENGINE_TRACTION * (e.engine - 1), drag: e.trim, downforce: e.trim + L,
          grip: 1 + L, brake: 1 + L }, ersOf(e)));
        const s = e.src, lv = liv(e.id) || {};
        const team = TEAM_NAMES[e.id] ? TEAM_NAMES[e.id].value : s.constructor;
        e.display = {
          team, teamZh: lv.teamZh || team, car: CHASSIS_NAMES[e.id] || s.chassis, engine: engineDisplay(s),
          colour: lv.colour, colour2: lv.colour2, note: lv.note || ''
        };
      }
    }
    // ---- rounded multipliers -> reported figures, ratings, checks
    for (const e of E) {
      if (!e.mult) continue;
      const spec = applyWith(std, e.mult, e.bat.hasErs), perf = G.carPerf(spec), met = metrics(perf, accelKmh);
      // js/car.js must take the car as it is (F1.sanitizeSpec replaces out-of-range values with the reference's)
      const san = G.sanitizeSpec(spec);
      for (const k of ['power', 'dragK', 'downforce', 'latBase', 'latMax', 'brakeBase', 'traction', 'topKmh', 'rpmIdle', 'rpmShift', 'rpmMax', 'shiftTime', 'cylinders'])
        if (!Object.is(san[k], spec[k])) problems.push(e.id + ': F1.sanitizeSpec changes ' + k + ' ' + spec[k] + ' -> ' + san[k]);
      if (JSON.stringify(san.ers) !== JSON.stringify(spec.ers) || JSON.stringify(san.gearKmh) !== JSON.stringify(spec.gearKmh)) problems.push(e.id + ': F1.sanitizeSpec changes the ERS or the gears');
      e.perTrack = lapDeltas(spec);
      e.profilePct = mean(e.perTrack);
      e.lapPct = e.profilePct + e.ersPct;                 // the lap with the battery deployed, vs the standard car's
      e.met = met;
      const rr = ratingsFor(met, stdMet, e.mult, e.bat.hasErs);
      e.ratings = rr.ratings; e.ratingX = rr.x;
      for (const k of MULT_KEYS) { const [lo, hi] = multRange(k); if (!(e.exact[k] >= lo && e.exact[k] <= hi)) problems.push(e.id + '.' + k + ' out of range: ' + e.exact[k]); }
      if (Math.abs(e.lapPct - e.target) > 0.01) problems.push(e.id + ': lap delta ' + e.lapPct.toFixed(4) + ' % misses the target ' + e.target.toFixed(4) + ' %');
      const s = e.src, d = e.display;
      cars.push({
        id: e.id, lineage: s.lineage, team: d.team, teamZh: d.teamZh, car: d.car, engine: d.engine,
        cylinders: s.engine.cylinders, aspiration: /^(na|naturally)/i.test(s.engine.aspiration) ? 'na' : 'hybrid',
        colour: d.colour, colour2: d.colour2, ratings: e.ratings, perf: e.mult, hasErs: e.bat.hasErs, note: d.note, ersNote: e.bat.note,
        est: { lapPct: round(e.lapPct, 3), ersPct: round(e.ersPct, 3), topKmh: round(met.topKmh, 1) }
      });
      const b = e.bat.src;
      slog.cars.push({ id: e.id, gapPct: s.pace.medianGapPct, rank: s.pace.rank, leanPct: s.character.vsFieldPct, targetPct: round(e.target, 4),
        lapPct: round(e.lapPct, 4), profilePct: round(e.profilePct, 4), ersPct: round(e.ersPct, 4), levelPct: round(e.L * 100, 3), perf: e.mult,
        battery: { hasErs: e.bat.hasErs, key: e.ersKey, cut: e.bat.cut, data: b ? { hasErs: b.hasErs, deploy: b.deploy, harvest: b.harvest, store: b.store, confidence: b.confidence, group: b.group } : null },
        perTrackPct: e.perTrack.map(v => round(v, 3)),
        topKmh: round(met.topKmh, 2), t0to300: round(met.t0to300, 3), brake300to80: round(met.brake300to80, 2), cornerKmh: met.corner.map(v => round(v, 2)),
        ratingX: Object.fromEntries(Object.keys(e.ratingX).map(k => [k, e.ratingX[k] === null ? null : round(e.ratingX[k], 3)])), ratings: e.ratings });
    }
    // checks inside the season
    const ids = new Set(), lineages = new Set();
    cars.forEach((c, i) => {
      if (!/^[a-z0-9-]{1,40}$/.test(c.id) || ids.has(c.id)) problems.push('bad or duplicate id ' + c.id);
      ids.add(c.id);
      if (lineages.has(c.lineage)) problems.push(year + ': two cars of lineage ' + c.lineage);
      lineages.add(c.lineage);
      for (const k of ['colour', 'colour2']) if (!/^#[0-9a-fA-F]{6}$/.test(c[k])) problems.push(c.id + '.' + k + ' is not #rrggbb: ' + c[k]);
      for (const k of MULT_KEYS) { const [lo, hi] = multRange(k); if (!(c.perf[k] >= lo && c.perf[k] <= hi) || (i === 0 && c.perf[k] !== 1)) problems.push(c.id + '.perf.' + k + ' = ' + c.perf[k]); }
      // the standard car: 50 everywhere, the battery 0 where the era has none
      for (const k of Object.keys(RATING)) if (!(c.ratings[k] >= 0 && c.ratings[k] <= 100) || (i === 0 && c.ratings[k] !== (k === 'ers' && !era.ers ? 0 : 50))) problems.push(c.id + ' rating ' + k + ' = ' + c.ratings[k]);
      // no battery: only where the era has none or tools/ers-data.json says so; its bar 0
      if (typeof c.hasErs !== 'boolean' || (c.hasErs && !era.ers) || (!c.hasErs && era.ers && i === 0)) problems.push(c.id + '.hasErs = ' + c.hasErs);
      if (!c.hasErs && c.ratings.ers !== 0) problems.push(c.id + ': no battery but an ers rating ' + c.ratings.ers);
      if (typeof c.ersNote !== 'string' || c.ersNote.length > 120 || /[\r\n]/.test(c.ersNote)) problems.push(c.id + '.ersNote is not one line');
      for (const k of ['team', 'teamZh', 'car', 'engine']) if (typeof c[k] !== 'string' || !c[k]) problems.push(c.id + '.' + k + ' empty');
    });
    const teamsOnly = cars.slice(1);
    slog.spreadPct = Math.max(...teamsOnly.map(c => c.est.lapPct)) - Math.min(...teamsOnly.map(c => c.est.lapPct));
    seasons.push({
      year, label: year + ' · ' + inp.label, engine: year === CFG.ANCHOR ? R.engine : stdEngine, paceIndex: rs.eraIndex,
      era, cars
    });
    log.seasons.push(slog);
  }
  // the anchor: its standard car must BE F1.REF_SPEC
  const a = seasons.find(s => s.year === CFG.ANCHOR);
  if (a) {
    const e = a.era;
    for (const k of ['power', 'dragK', 'downforce', 'latBase', 'latMax', 'brakeBase', 'traction', 'topKmh', 'rpmIdle', 'rpmShift', 'rpmMax', 'shiftTime', 'cylinders', 'aspiration', 'cockpit']) {
      if (!Object.is(e[k], R[k])) problems.push('anchor ' + k + ' ' + e[k] + ' != F1.REF_SPEC ' + R[k]);
    }
    if (JSON.stringify(e.gearKmh) !== JSON.stringify(R.gearKmh) || JSON.stringify(e.ers) !== JSON.stringify(R.ers)) problems.push('anchor gears / ers differ from F1.REF_SPEC');
  }
  // every documented no-KERS car of tools/ers-data.json has no battery, and no other car of 2011..2026
  for (const s of seasons) for (const c of s.cars.slice(1)) {
    const ent = hasOwn(ersData.entries, c.id) ? ersData.entries[c.id] : null;
    if (ent && c.hasErs !== (ent.hasErs !== false)) problems.push(c.id + ': hasErs ' + c.hasErs + ' but tools/ers-data.json says ' + ent.hasErs);
  }
  return { seasons, log, problems, warnings, notes, calib, raw, fingerprint: fp };
}
export const applyWith = (std, m, hasErs) => Object.assign({}, std, applyMult(std, m, hasErs));

// ---- output -----------------------------------------------------------------------------------------------------------
export function seasonsJs(b) {
  const src = b.raw.source;
  const info = {
    generatedBy: 'tools/build-cars.mjs',
    f1db: { name: src.name, url: src.url, release: src.release, licence: src.licence, licenceUrl: src.licenceUrl },
    attribution: src.attribution,
    attributionShort: src.attributionShort,
    sources2026: '2026 cars: estimates from public data (FIA, formula1.com, OpenF1, Jolpica-F1, Autosport, team releases), see docs/cars-data-sources.md',
    disclaimer: '車輛數據是依公開資料推估的遊戲數值，並非官方規格。'
  };
  const L = [];
  L.push('// GENERATED by tools/build-cars.mjs - do not edit by hand (node tools/build-cars.mjs; --check verifies it).');
  L.push('// F1Drive - the seasons 2010..2026 of the Grand Prix year selector and the cars of each year: the season\'s');
  L.push('// standard car (the era physics, every multiplier 1) first, then every team as the constructors\' championship');
  L.push('// classified it. ESTIMATES derived from public data for a game, NOT official specifications.');
  L.push('// Sources: ' + src.attributionShort + ' (' + src.url + ', ' + src.release + '); tools/eras.json; tools/liveries/*.json;');
  L.push('// the 2026 grid from js/cars-data.js; every car\'s battery from tools/ers-data.json (docs/ers-data.md).');
  L.push('// Method and calibration: docs/seasons-data.md.');
  L.push('//');
  L.push('// window.F1_SEASONS = [{ year, label, engine, paceIndex (real pole-time index, 2025 = 1),');
  L.push('//   era: { power, dragK, downforce, latBase, latMax, brakeBase, traction, gearKmh, topKmh, rpmIdle, rpmShift, rpmMax,');
  L.push('//          shiftTime, cylinders, aspiration, ers: null | { store, power, harvest, taperKmh? }, cockpit }   (absolute CarSpec values)');
  L.push('//   cars: [{ id, lineage, team, teamZh, car, engine, cylinders, aspiration, colour, colour2,');
  L.push('//            ratings: { topSpeed, accel, cornering, braking, ers },   0..100, 50 = the season\'s standard car;');
  L.push('//                                                     ers 0 for a car without a battery');
  L.push('//            perf: { power, drag, downforce, grip, brake, traction,   multipliers on the era, 0.95..1.05;');
  L.push('//                    ersPower, ersHarvest, ersStore },                   the battery\'s 0.75..1.15 (store 0.9..1.1)');
  L.push('//            hasErs,      false: no battery (ers: null) - the era has none (2010) or the car raced without KERS');
  L.push('//            note,        one line, Traditional Chinese, or \'\'');
  L.push('//            ersNote,     one line about the car\'s battery, Traditional Chinese, or \'\' (tools/ers-data.json)');
  L.push('//            est: { lapPct, ersPct, topKmh } }] }]   model lap time vs the standard car (%), both deploying the');
  L.push('//                         battery; ersPct = the battery\'s share of it (driven); top speed without the battery');
  L.push('// window.F1_SEASONS_INFO = { attribution, attributionShort, sources2026, disclaimer, f1db }');
  L.push('(function (root) {');
  L.push("  'use strict';");
  L.push('  var SEASONS = [');
  b.seasons.forEach((s, si) => {
    L.push('    {');
    L.push('      year: ' + s.year + ', label: ' + JSON.stringify(s.label) + ', engine: ' + JSON.stringify(s.engine) + ', paceIndex: ' + s.paceIndex + ',');
    L.push('      era: ' + JSON.stringify(s.era) + ',');
    L.push('      cars: [');
    s.cars.forEach((c, i) => L.push('        ' + JSON.stringify(c) + (i < s.cars.length - 1 ? ',' : '')));
    L.push('      ]');
    L.push('    }' + (si < b.seasons.length - 1 ? ',' : ''));
  });
  L.push('  ];');
  L.push('  var INFO = ' + JSON.stringify(info) + ';');
  L.push('  root.F1_SEASONS = SEASONS;');
  L.push('  root.F1_SEASONS_INFO = INFO;');
  L.push("  if (typeof module !== 'undefined' && module.exports) module.exports = SEASONS;");
  L.push("})(typeof window !== 'undefined' ? window : globalThis);");
  return L.join('\n') + '\n';
}

// docs/seasons-data.md: the calibration table is generated (copied by hand it went stale), between these markers
export const DOC_FILE = P('docs', 'seasons-data.md');
const DOC_BEGIN = '<!-- BEGIN calibration table: generated by node tools/build-cars.mjs from devtests/seasons-calib/calibration.json, do not edit -->';
const DOC_END = '<!-- END calibration table -->';
function calibrationTable(b) {
  const R = loadGame().REF_SPEC, c = b.calib, f = (v, d) => v.toFixed(d), pct = v => f(v * 100, 2) + ' %';
  // calibrate.mjs (deploying) also drives the solved car without the battery: what a lap without E costs
  const nd = Object.values(c.seasons).some(s => typeof s.noDeployMedian === 'number');
  const L = [DOC_BEGIN, '',
    '| 年 | 目標指數 | 實跑（中位數） | 平均 | ' + (nd ? '不放電（中位數） | ' : '') + '各賽道標準差 | 各賽道最大偏差 | 極速 km/h | 放電極速 | 功率 W/kg（×2025） | 牽引 | 風阻 | 下壓力 | 機械抓地 | 側向上限 | 抓地倍率 |',
    '|' + ' --- |'.repeat(nd ? 16 : 15)];
  const off = [];
  for (const s of b.log.seasons) {
    const cal = c.seasons[s.year], e = s.era;
    const dev = Object.values(cal.ratios).map(r => r / cal.index - 1), m = mean(dev);
    const sd = Math.sqrt(mean(dev.map(d => (d - m) * (d - m)))), mx = Math.max(...dev.map(Math.abs));
    const miss = Math.abs(cal.drivenMedian - cal.index);
    if (miss > c.tolerance) off.push(s.year + ' 差 ' + f(miss * 100, 3) + ' %');
    L.push('| ' + [s.year, f(cal.index, 4), f(cal.drivenMedian, 4) + (miss > c.tolerance ? '*' : ''), f(cal.drivenMean, 4)].concat(nd ? [f(cal.noDeployMedian, 4)] : []).concat([pct(sd), pct(mx),
      f(s.stdTopKmh, 1), f(s.stdTopBoostKmh, 1), f(e.power, 0) + '（' + f(e.power / R.power, 3) + '）', f(e.traction / R.traction, 3),
      f(e.dragK / R.dragK, 3), f(e.downforce / R.downforce, 3), f(e.latBase / R.latBase, 3), f(e.latMax / R.latMax, 3), f(cal.gripScale, 4)]).join(' | ') + ' |');
  }
  const y26 = b.seasons.find(s => s.year === CFG.CURRENT), taper = y26 && y26.era.ers && y26.era.ers.taperKmh;
  L.push('',
    '牽引到側向上限各欄是對 2025 的倍數；極速不含電池，放電極速是一直放電的極限。' +
      (nd ? '「不放電」是本年與 2025 標準車都不按 E 時的中位數圈速比（沒人按 E 時的年代順序）。' : '') + '校正誤差要求 ' + f(c.tolerance * 100, 2) + ' %（任務要求 ' +
      f(CFG.INDEX_TOL * 100, 1) + ' %）' + (off.length ? '；* 超出 ' + f(c.tolerance * 100, 2) + ' %：' + off.join('、') + '（仍在 ' + f(CFG.INDEX_TOL * 100, 1) + ' % 以內）。' : '，每一年都達到。'),
    '這份校正' + (c.deploy ? '是**放電**跑的（全油門且 100 km/h 以上按住 E，電池只靠回收補充；2025 標準車也一樣）。' :
      '是**不放電**跑的（舊方法：按 E 之後各年代多出的電力不同，年代順序會亂，見〈ERS〉一節）。') +
      (taper ? '2026 的放電功率 ' + taper[0] + ' km/h 起遞減，' + taper[1] + ' km/h 為零。' : '2026 的放電功率不隨速度遞減。') +
      'calibration.json 指紋 `' + c.fingerprint + '`。',
    '', DOC_END);
  return L.join('\n');
}
function docText(b) {
  const old = readFileSync(DOC_FILE, 'utf8'), i = old.indexOf(DOC_BEGIN), j = old.indexOf(DOC_END);
  if (i < 0 || j < i) throw new Error(relative(ROOT, DOC_FILE) + ' has no calibration table markers');
  return old.slice(0, i) + calibrationTable(b) + old.slice(j + DOC_END.length);
}

function entriesJson(b) {
  return JSON.stringify({ generatedBy: 'tools/build-cars.mjs', fingerprint: b.fingerprint, seasons: b.log.seasons.map(s => ({
    year: s.year, index: s.index, K: s.K === undefined ? null : round(s.K, 5), gapMedianPct: s.gapMedian === undefined ? null : s.gapMedian,
    spreadPct: round(s.spreadPct, 4), stdTopKmh: round(s.stdTopKmh, 2), engineGroups: s.engineGroups || null, cars: s.cars
  })) }, null, 1) + '\n';
}

// ---- main -----------------------------------------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const CHECK = args.includes('--check'), DRY = args.includes('--dry'), QUIET = args.includes('--quiet');
  const t0 = Date.now();
  const b = build();
  if (!QUIET) {
    for (const s of b.log.seasons) {
      console.log('== ' + s.year + ' index ' + s.index + '  std top ' + s.stdTopKmh.toFixed(1) + ' km/h  spread ' + s.spreadPct.toFixed(3) + ' %' + (s.K ? '  K ' + s.K.toFixed(4) : ''));
      for (const c of s.cars) {
        console.log('  ' + c.id.padEnd(22) + (c.gapPct === undefined ? '' : String(c.gapPct).padStart(6)) + (c.targetPct === null ? '       -' : c.targetPct.toFixed(3).padStart(8)) + c.lapPct.toFixed(3).padStart(8) +
          ' (E ' + (c.ersPct >= 0 ? '+' : '') + c.ersPct.toFixed(3) + (c.battery.hasErs ? '' : ' none') + ')' +
          (c.levelPct === null ? '      -' : c.levelPct.toFixed(2).padStart(7)) + '  ' + MULT_KEYS.map(k => c.perf[k].toFixed(4)).join(' ') + '  ' + c.topKmh.toFixed(1) + ' | ' +
          Object.keys(RATING).map(k => String(c.ratings[k]).padStart(3)).join(' '));
      }
    }
  }
  for (const n of b.notes) console.log('NOTE ' + n);
  for (const w of b.warnings) console.log('WARNING ' + w);
  const outputs = b.problems.length ? [] : [[OUT_JS, seasonsJs(b)], [ENTRIES_FILE, entriesJson(b)], [DOC_FILE, docText(b)]];
  if (b.problems.length) { console.log('PROBLEMS (nothing written):\n  ' + b.problems.join('\n  ')); process.exitCode = 1; }
  else if (CHECK) {
    for (const [file, text] of outputs) {
      const same = existsSync(file) && readFileSync(file, 'utf8') === text;
      console.log((same ? 'up to date  ' : 'DIFFERS     ') + relative(ROOT, file).replace(/\\/g, '/'));
      if (!same) process.exitCode = 1;
    }
  } else if (DRY) console.log('checks passed (--dry: nothing written)');
  else {
    for (const [file, text] of outputs) { writeFileSync(file, text); console.log('wrote ' + relative(ROOT, file).replace(/\\/g, '/')); }
    console.log('checks passed');
  }
  console.log('(' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
