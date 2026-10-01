// node devtests/cars-data/derive.js [--dry | --check] [--scan]
//
// Derives the game's car list (js/cars-data.js, window.F1_CARS) and its documentation
// (docs/cars-data-sources.md) from the sourced real-world inputs in inputs.js. Both files are OUTPUTS of this
// script: change inputs.js or the constants below and run it again, never edit them by hand.
//   (no flag)  write js/cars-data.js, docs/cars-data-sources.md and devtests/cars-data/derived.json
//   --dry      compute and print, write nothing
//   --check    compute and compare with the files on disk; exit code 1 when they differ
//   --scan     also print how the calibration residual L depends on GAIN
// Takes about 10 s (it builds the 15 tracks and their racing lines, then solves one number per car).
//
// METHOD (every constant is in CFG / RATING; docs/cars-data-sources.md repeats it in Traditional Chinese)
//  1. Pace target. Real pace gap P = 0.5 * qualifying gap + 0.3 * race-pace gap + 0.2 * Autosport gap (each in %
//     to the fastest team). The game's target lap-time difference to the STANDARD car is
//         target = K * (P - median P),   K = SPREAD / (max P - min P)
//     so the field keeps its real order and proportions, compressed to SPREAD (1.25 %) between the fastest and
//     the slowest car; the standard car sits where the median team is.
//  2. Engine. power = the value that gives the standard car (drag 1) a top speed of V_REF + GAIN * (mean measured
//     speed index V of all the teams with that power unit), the same for every team with that power unit.
//     (POWER_FROM 'speed'. The FIA ADUO index measures the combustion engine only; in 2026 the straight-line speed
//     depends as much on the electrical deployment - Red Bull Ford has the benchmark ICE but only a median top speed
//     over the season - so an ADUO-based power put the cars' top speeds in an order the measured speeds contradict.
//     The ADUO value 1 + GAIN * ICE_SHARE * (index - field median) / 100 is still computed and documented as a
//     cross-check; POWER_FROM 'aduo' restores it, with the measured speed only for open-ended bands it cannot explain.)
//  3. Drag. Teams with the same power unit differ in top speed because of the car:
//         drag = 1 - 3 * GAIN * (V - mean V of the power-unit family) / 330
//     V = measured speed index in km/h (top speed ~ (power / drag)^(1/3)). A power unit used by one team only
//     cannot be separated from its car: drag = 1 (neutral, no data). With steps 2 + 3 every car's top speed is
//     V_REF + GAIN * V, i.e. the game keeps the measured straight-line order.
//  4. Battery. ersPower = 1 - E_GAIN * (time in the last third of long straights, % vs field median) / 100
//     (telemetry proxy for deployment). ersHarvest = 1 + E_STEP * ordinal rank from the press reports.
//  5. Chassis. grip, downforce, brake, traction = 1 - GAIN * (time in the matching lap zones, % vs field
//     median) / 100 + L, and traction additionally + DRAG_COMP * (drag - 1): the measured zone times already
//     contain each car's drag, so what the drag multiplier costs or gains in lap time is given back through
//     traction (drag then decides where the time is made - top speed or acceleration - not how much).
//     L is one number per car, the same for the four chassis multipliers, solved so that the simulated lap
//     time (mean of the 15 circuits raced so far, model.js) hits the target of step 1.
//  6. Multipliers are rounded to 4 decimals and must stay inside 0.95 .. 1.05; the lap times, top speeds and
//     ratings that are reported are recomputed from the rounded values.
//  7. Ratings 0..100 (50 = standard car) from simple physical figures of the rounded multipliers: see RATING.
'use strict';
const fs = require('fs');
const path = require('path');
const M = require('./model.js');
const I = require('./inputs.js');

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry'), CHECK = ARGS.includes('--check'), SCAN = ARGS.includes('--scan');

const CFG = {
  SPREAD: 1.25,                 // % lap time between the fastest and the slowest car (contract: about 1 .. 1.5)
  W_QUALI: 0.5, W_RACE: 0.3, W_AUTOSPORT: 0.2,
  GAIN: 0.5,                    // every measured difference enters at half size: zone times -> chassis multipliers,
                                //   speed index -> top speed (drag, Honda's power), FIA index -> power
  ICE_SHARE: 400 / 750,         // combustion share of the 2026 power (400 kW ICE + 350 kW electric)
  POWER_FROM: 'speed',          // 'speed' (measured family speed index) | 'aduo' (FIA ICE index): see METHOD step 2
  COLOUR_MIN_PAIR_DE: 15,       // two team cars whose (colour, colour2) differ by less than this (sum of the two
                                //   CIEDE2000 distances) count as the same livery -> problem
  V_REF: 330,                   // km/h: the standard car's top speed
  E_GAIN: 1.0,                  // ersPower: multiplier % per % of end-of-straight zone time
  E_STEP: 0.01,                 // ersHarvest: per ordinal step
  W_MEDIUM: 13, W_FAST: 7,      // share of the lap in medium / fast corner zones (weights of the downforce input)
  W_TRACTION_ZONE: 0.5,         // traction input = 0.5 * traction zone + 0.5 * full-throttle zones
  MIN: 0.95, MAX: 1.05, DECIMALS: 4
};
// rating = 50 + gain * x, rounded and limited to 0..100; x = 0 for the standard car
const RATING = {
  topSpeed: { gain: 11, x: '極速（不含電池）與標準車的差，km/h' },
  accel: { gain: 12, x: '0–300 km/h 所需時間比標準車少的百分比' },
  cornering: { gain: 23, x: '半徑 30 / 60 / 120 m 平地彎的過彎速度，比標準車高的百分比（三者平均）' },
  braking: { gain: 20, x: '300→80 km/h 煞車距離比標準車短的百分比' },
  ers: { gain: 13, x: '(ersPower − 1) 與 (ersHarvest − 1) 的平均，%' }
};
const CORNER_RADII = [30, 60, 120];
const CHASSIS = ['grip', 'downforce', 'brake', 'traction'];

const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
const round = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };

// ---- 0. tracks + model self-check ---------------------------------------------------------------------------
const geos = I.SEASON.trackIds.map(id => M.buildGeometry(id));
const stdPerf = M.makePerf(M.ONES);
const selfCheck = { perf: true, lap: true };
{
  const cp = global.F1.CAR_PERF;
  for (const k of ['topSpeed', 'dragK', 'roll', 'traction', 'power', 'latMax', 'muLat', 'muTraction', 'muBrake', 'downforce', 'brakeDrag']) {
    if (!(Math.abs(stdPerf[k] - cp[k]) <= 1e-9 * Math.abs(cp[k]))) { selfCheck.perf = false; console.log('WARNING: F1.CAR_PERF.' + k + ' = ' + cp[k] + ' but model.js has ' + stdPerf[k]); }
  }
}
const stdLaps = geos.map(g => {
  const t = M.lap(g, stdPerf).time;
  if (!(Math.abs(t - g.refLapTime) < 1e-6)) { selfCheck.lap = false; console.log('WARNING: ' + g.id + ' lap ' + t + ' s differs from js/raceline.js ' + g.refLapTime + ' s'); }
  return t;
});
// lap-time difference to the standard car on every circuit, % (boost = battery button held all lap)
function lapDeltas(mult, boost) {
  const p = M.makePerf(mult, !!boost);
  return geos.map((g, i) => (M.lap(g, p).time / stdLaps[i] - 1) * 100);
}
const lapDelta = (mult, boost) => mean(lapDeltas(mult, boost));

// lap-time sensitivity of each multiplier: % lap time per +1 %
const SENS = {};
for (const k of ['power', 'drag', 'downforce', 'grip', 'brake', 'traction']) {
  const m = Object.assign({}, M.ONES); m[k] = 1.01;
  SENS[k] = lapDelta(m);
}
const DRAG_COMP = -SENS.drag / SENS.traction;       // traction that offsets 1 unit of drag in lap time (~0.39)

// ---- 1. pace target -------------------------------------------------------------------------------------------
const T = I.TEAMS.map(t => Object.assign({}, t));
const autoMin = [0, 1].map(k => Math.min.apply(null, T.map(t => t.autosport[k])));
for (const t of T) {
  t.autosportGapPct = mean([0, 1].map(k => (t.autosport[k] / autoMin[k] - 1) * 100));
  t.pace = CFG.W_QUALI * t.qualiGapPct + CFG.W_RACE * t.raceGapPct + CFG.W_AUTOSPORT * t.autosportGapPct;
}
const paceMed = median(T.map(t => t.pace));
const paceMin = Math.min.apply(null, T.map(t => t.pace)), paceMax = Math.max.apply(null, T.map(t => t.pace));
const K = CFG.SPREAD / (paceMax - paceMin);
for (const t of T) t.target = K * (t.pace - paceMed);

// ---- 2. + 3. engine and drag ------------------------------------------------------------------------------------
for (const t of T) t.V = mean([t.vmaxKmh, t.trapKmh]);
const PU = {};
for (const id of Object.keys(I.POWER_UNITS)) {
  const teams = T.filter(t => t.pu === id);
  PU[id] = Object.assign({ id: id, teams: teams.map(t => t.id), V: mean(teams.map(t => t.V)) }, I.POWER_UNITS[id]);
}
const iceMed = median(T.map(t => PU[t.pu].aduoIcePct));
// power that gives the standard car (drag 1) a top speed of V_REF + dV km/h
function powerForSpeed(dV) {
  const v = (CFG.V_REF + dV) * M.KMH;
  return (M.BASE.dragK * v * v + M.BASE.roll) * v / M.BASE.power;
}
for (const id of Object.keys(PU)) {
  const u = PU[id];
  u.powerAduo = 1 + CFG.GAIN * CFG.ICE_SHARE * (u.aduoIcePct - iceMed) / 100;
  u.powerSpeed = powerForSpeed(CFG.GAIN * u.V);
  u.usesSpeed = CFG.POWER_FROM === 'speed' || (u.aduoOpenEnded && u.powerSpeed < u.powerAduo);
  u.power = u.usesSpeed ? u.powerSpeed : u.powerAduo;
}
for (const t of T) {
  const u = PU[t.pu];
  t.raw = {};
  t.raw.power = u.power;
  t.familyResidual = u.teams.length > 1 ? t.V - u.V : null;      // km/h; null = cannot be separated from the engine
  t.raw.drag = t.familyResidual === null ? 1 : 1 - 3 * CFG.GAIN * t.familyResidual / CFG.V_REF;
  // ---- 4. battery
  t.raw.ersPower = 1 - CFG.E_GAIN * t.endStraight / 100;
  t.ersRank = u.ersRank + (t.ersAdj || 0);
  t.raw.ersHarvest = 1 + CFG.E_STEP * t.ersRank;
  // ---- 5. chassis: zone inputs (% time vs field median)
  t.zone = {
    grip: t.slow,
    downforce: (CFG.W_MEDIUM * t.medium + CFG.W_FAST * t.fast) / (CFG.W_MEDIUM + CFG.W_FAST),
    brake: t.entry,
    traction: CFG.W_TRACTION_ZONE * t.traction + (1 - CFG.W_TRACTION_ZONE) * t.ft
  };
}
// multipliers before rounding, for level L (not clamped: the range is checked afterwards)
function multFor(t, L, gain, comp) {
  const m = { power: t.raw.power, drag: t.raw.drag, ersPower: t.raw.ersPower, ersHarvest: t.raw.ersHarvest };
  for (const k of CHASSIS) m[k] = 1 - gain * t.zone[k] / 100 + L;
  m.traction += comp * (t.raw.drag - 1);
  return m;
}
function solveLevel(t, gain, comp) {
  let lo = -0.04, hi = 0.04;                  // more L = faster car = smaller lap delta
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    if (lapDelta(multFor(t, mid, gain, comp)) > t.target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
const scan = [];
if (SCAN) {
  for (const g of [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1]) {
    const Ls = T.map(t => solveLevel(t, g, DRAG_COMP) * 100);
    scan.push({ gain: g, rms: Math.sqrt(mean(Ls.map(x => x * x))), max: Math.max.apply(null, Ls.map(Math.abs)) });
  }
}

const stdMetrics = M.metrics(M.ONES);
const cornerSpeeds = m => {
  const p = M.makePerf(m, false);
  return CORNER_RADII.map(R => {
    let lo = 5, hi = 130;
    for (let i = 0; i < 50; i++) { const x = 0.5 * (lo + hi); if (p.maxLatAccel(x, 0, 0, 0, 1) >= x * x / R) lo = x; else hi = x; }
    return 0.5 * (lo + hi) / M.KMH;
  });
};
const stdCorner = cornerSpeeds(M.ONES);
function ratingsFor(m) {
  const k = M.metrics(m), c = cornerSpeeds(m);
  const x = {
    topSpeed: k.topKmh - stdMetrics.topKmh,
    accel: (1 - k.t0to300 / stdMetrics.t0to300) * 100,
    cornering: mean(c.map((v, i) => (v / stdCorner[i] - 1) * 100)),
    braking: (1 - k.brake300to80 / stdMetrics.brake300to80) * 100,
    ers: 0.5 * ((m.ersPower - 1) + (m.ersHarvest - 1)) * 100
  };
  const r = {};
  for (const key of Object.keys(RATING)) r[key] = clamp(Math.round(50 + RATING[key].gain * x[key]), 0, 100);
  return { ratings: r, x: x, metrics: k, corner: c };
}

for (const t of T) {
  t.L = solveLevel(t, CFG.GAIN, DRAG_COMP);
  t.exact = multFor(t, t.L, CFG.GAIN, DRAG_COMP);
  t.perf = {};
  for (const k of M.KEYS) t.perf[k] = round(t.exact[k], CFG.DECIMALS);
  t.perTrack = lapDeltas(t.perf);
  t.lapDelta = mean(t.perTrack);
  t.lapDeltaBoost = lapDelta(t.perf, true);
  Object.assign(t, ratingsFor(t.perf));
}
const stdBoost = lapDelta(M.ONES, true);
const ORDER = T.slice().sort((a, b) => a.pace - b.pace);      // fastest first
// pairs the constructors' standings puts the other way round than the pace order (for the documentation)
const standingSwaps = [];
for (const a of T) for (const b of T) if (a.standing.pos < b.standing.pos && a.pace > b.pace) standingSwaps.push([b, a]);

// ---- colours: CIEDE2000 distances (how different two liveries look) -----------------------------------------------
function lab(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const X = f((c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047), Y = f(c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722),
    Z = f((c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
function deltaE(hexA, hexB) {
  const [L1, a1, b1] = lab(hexA), [L2, a2, b2] = lab(hexB), rad = Math.PI / 180, p7 = x => Math.pow(x, 7);
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, G = 0.5 * (1 - Math.sqrt(p7(Cm) / (p7(Cm) + p7(25))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const h1 = (Math.atan2(b1, a1p) / rad + 360) % 360, h2 = (Math.atan2(b2, a2p) / rad + 360) % 360;
  let dh = C1 * C2 === 0 ? 0 : h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh * rad / 2), Lm = (L1 + L2) / 2, Cp = (C1 + C2) / 2;
  let hm = h1 + h2; if (C1 * C2 !== 0) { if (Math.abs(h1 - h2) > 180) hm += hm < 360 ? 360 : -360; hm /= 2; }
  const Tt = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + 0.015 * (Lm - 50) * (Lm - 50) / Math.sqrt(20 + (Lm - 50) * (Lm - 50)), SC = 1 + 0.045 * Cp, SH = 1 + 0.015 * Cp * Tt;
  const RT = -Math.sin(2 * 30 * Math.exp(-Math.pow((hm - 275) / 25, 2)) * rad) * 2 * Math.sqrt(p7(Cp) / (p7(Cp) + p7(25)));
  return Math.sqrt(Math.pow(dL / SL, 2) + Math.pow(dC / SC, 2) + Math.pow(dH / SH, 2) + RT * (dC / SC) * (dH / SH));
}
const colourPairs = [];
for (let i = 0; i < I.TEAMS.length; i++) for (let j = i + 1; j < I.TEAMS.length; j++) {
  const a = I.TEAMS[i], b = I.TEAMS[j];
  const dot = deltaE(a.colour, b.colour), second = deltaE(a.colour2, b.colour2);
  colourPairs.push({ a: a, b: b, dot: dot, second: second, pair: dot + second, team: deltaE(a.colourTeam, b.colourTeam) });
}
// the grey standard car (not a team) against the team cars' main colour
const STD_LIVERY = { colour: '#9AA0A6', colour2: '#2B2F36', colourTeam: '#C8CCD0' };
const standardColourNearest = I.TEAMS.map(t => ({ t: t, dot: deltaE(STD_LIVERY.colour, t.colour) })).sort((x, y) => x.dot - y.dot)[0];

// ---- 8. the car list --------------------------------------------------------------------------------------------
const stdRatings = ratingsFor(M.ONES);
const CARS = [{
  id: 'standard', team: 'F1Drive', teamZh: 'F1Drive', teamEn: 'F1Drive', car: '標準賽車',
  pu: 'F1Drive', engine: '標準動力單元（1.6 L V6 渦輪混合動力）',
  colour: STD_LIVERY.colour, colour2: STD_LIVERY.colour2, colourTeam: STD_LIVERY.colourTeam,
  perf: Object.assign({}, M.ONES),
  ratings: stdRatings.ratings,
  note: '遊戲的基準車：所有倍率都是 1，速度約在 2026 年車隊的中位數。',
  est: { lapPct: 0, topKmh: round(stdMetrics.topKmh, 1) }
}].concat(I.TEAMS.map(src => {
  const t = T.find(x => x.id === src.id), u = PU[t.pu];
  return {
    id: t.id,
    team: t.teamZh === t.teamEn ? t.teamEn : t.teamZh + ' ' + t.teamEn,
    teamZh: t.teamZh, teamEn: t.teamEn, car: t.car,
    pu: u.supplier, engine: u.engine,
    colour: t.colour, colour2: t.colour2, colourTeam: t.colourTeam,
    perf: t.perf,
    ratings: t.ratings,
    note: t.note,
    est: { lapPct: round(t.lapDelta, 2), topKmh: round(t.metrics.topKmh, 1) }
  };
}));

// ---- checks ---------------------------------------------------------------------------------------------------
const problems = [];
if (!selfCheck.perf) problems.push('model.js no longer equals F1.CAR_PERF of js/car.js (the reference car changed?)');
if (!selfCheck.lap) problems.push('model.js lap differs from js/raceline.js');
{
  const byReal = ORDER.map(t => t.id).join(' ');
  const byGame = T.slice().sort((a, b) => a.lapDelta - b.lapDelta).map(t => t.id).join(' ');
  if (byReal !== byGame) problems.push('pace order differs: real ' + byReal + ' / game ' + byGame);
  // the game's top speeds keep the measured straight-line order (speed index V)
  const bySpeedReal = T.slice().sort((a, b) => b.V - a.V).map(t => t.id).join(' ');
  const bySpeedGame = T.slice().sort((a, b) => b.metrics.topKmh - a.metrics.topKmh).map(t => t.id).join(' ');
  if (bySpeedReal !== bySpeedGame) problems.push('top-speed order differs: measured ' + bySpeedReal + ' / game ' + bySpeedGame);
  for (const p of colourPairs) if (p.pair < CFG.COLOUR_MIN_PAIR_DE) problems.push('liveries of ' + p.a.id + ' and ' + p.b.id + ' are nearly identical (dE ' + p.dot.toFixed(1) + ' + ' + p.second.toFixed(1) + ')');
  const spread = Math.max.apply(null, T.map(t => t.lapDelta)) - Math.min.apply(null, T.map(t => t.lapDelta));
  if (!(spread >= 1 && spread <= 1.5)) problems.push('lap-time spread ' + spread.toFixed(3) + ' % outside 1 .. 1.5 %');
  for (const t of T) {
    if (Math.abs(t.lapDelta - t.target) > 0.01) problems.push(t.id + ': lap delta ' + t.lapDelta.toFixed(4) + ' % misses the target ' + t.target.toFixed(4) + ' %');
    for (const k of M.KEYS) if (!(t.exact[k] >= CFG.MIN && t.exact[k] <= CFG.MAX)) problems.push(t.id + '.' + k + ' out of range: ' + t.exact[k]);
  }
  const ids = {};
  CARS.forEach((c, i) => {
    if (!/^[a-z0-9_-]{1,24}$/.test(c.id) || ids[c.id]) problems.push('bad or duplicate id ' + c.id);
    ids[c.id] = true;
    for (const k of ['colour', 'colour2', 'colourTeam']) if (!/^#[0-9a-f]{6}$/i.test(c[k])) problems.push(c.id + '.' + k + ' is not #rrggbb');
    for (const k of M.KEYS) if (i === 0 && c.perf[k] !== 1) problems.push('standard.' + k + ' is not 1');
    for (const k of Object.keys(RATING)) if (!(c.ratings[k] >= 0 && c.ratings[k] <= 100) || (i === 0 && c.ratings[k] !== 50)) problems.push(c.id + ' rating ' + k + ' = ' + c.ratings[k]);
  });
  if (CARS[0].id !== 'standard') problems.push('standard is not first');
}

// ---- output -----------------------------------------------------------------------------------------------------
function carsJs() {
  const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const obj = (o, keys) => '{ ' + keys.map(k => k + ': ' + (typeof o[k] === 'string' ? q(o[k]) : o[k])).join(', ') + ' }';
  const L = [];
  L.push('// GENERATED by devtests/cars-data/derive.js - do not edit by hand (node devtests/cars-data/derive.js).');
  L.push('// F1Drive - cars to choose from: the standard car plus the 11 cars of the ' + I.SEASON.year + ' Formula 1 grid.');
  L.push('// Data as of ' + I.SEASON.asOf + ', after round ' + I.SEASON.lastRound + ' (Azerbaijan GP). ESTIMATES derived from public data for a game,');
  L.push('// NOT official specifications. Sources, formula and limits: docs/cars-data-sources.md.');
  L.push('// Calibrated on the v5 reference car (F1.CAR_PERF of js/car.js = every multiplier 1).');
  L.push('//');
  L.push('// window.F1_CARS = [{');
  L.push('//   id,                  /^[a-z0-9_-]{1,24}$/; \'standard\' first. The team ids are the F1DB constructor ids');
  L.push('//                        (tools/seasons-raw.json: \'' + I.SEASON.year + '-\' + id).');
  L.push('//   team,                display name: Traditional Chinese (Taiwan usage) + English; teamZh / teamEn = the two parts');
  L.push('//   car,                 chassis designation');
  L.push('//   pu, engine,          power-unit supplier, its designation');
  L.push('//   colour, colour2,     livery \'#rrggbb\': main body paint, second livery colour (sampled from official renders / photos)');
  L.push('//   colourTeam,          the team colour of F1\'s timing graphics (published; bright, for HUD / lists)');
  L.push('//   perf: { power, drag, downforce, grip, brake, traction, ersPower, ersHarvest },');
  L.push('//                        multipliers on the standard car, each within ' + CFG.MIN + ' .. ' + CFG.MAX + ': power -> POWER (W/kg),');
  L.push('//                        drag -> DRAG_K, downforce -> DOWNFORCE, grip -> LAT_BASE and LAT_MAX, brake -> BRAKE_BASE,');
  L.push('//                        traction -> TRACTION, ersPower -> ers.power, ersHarvest -> ers.harvest. A LOWER drag is better.');
  L.push('//   ratings: { topSpeed, accel, cornering, braking, ers },   0..100 for the menu bars, 50 = the standard car');
  L.push('//   note,                one line, Traditional Chinese');
  L.push('//   est: { lapPct, topKmh }   model estimate: lap time vs the standard car in % (negative = faster, mean of the');
  L.push('//                        ' + geos.length + ' circuits raced so far, no battery), top speed without battery in km/h');
  L.push('// }, ...]');
  L.push('(function (root) {');
  L.push("  'use strict';");
  L.push('  var CARS = [');
  CARS.forEach((c, i) => {
    L.push('    {');
    L.push('      id: ' + q(c.id) + ', team: ' + q(c.team) + ', teamZh: ' + q(c.teamZh) + ', teamEn: ' + q(c.teamEn) + ', car: ' + q(c.car) + ',');
    L.push('      pu: ' + q(c.pu) + ', engine: ' + q(c.engine) + ',');
    L.push('      colour: ' + q(c.colour) + ', colour2: ' + q(c.colour2) + ', colourTeam: ' + q(c.colourTeam) + ',');
    L.push('      perf: ' + obj(c.perf, M.KEYS) + ',');
    L.push('      ratings: ' + obj(c.ratings, Object.keys(RATING)) + ',');
    L.push('      note: ' + q(c.note) + ',');
    L.push('      est: ' + obj(c.est, ['lapPct', 'topKmh']));
    L.push('    }' + (i < CARS.length - 1 ? ',' : ''));
  });
  L.push('  ];');
  L.push('  root.F1_CARS = CARS;');
  L.push("  if (typeof module !== 'undefined' && module.exports) module.exports = CARS;");
  L.push("})(typeof window !== 'undefined' ? window : globalThis);");
  return L.join('\n') + '\n';
}
const D = {
  CFG, RATING, CORNER_RADII, SENS, DRAG_COMP, T, ORDER, PU, K, paceMed, paceMin, paceMax, iceMed, geos, stdLaps,
  stdMetrics, stdCorner, stdBoost, CARS, scan, problems, selfCheck, inputs: I, model: M,
  standingSwaps, colourPairs, standardColourNearest, deltaE
};
module.exports = D;

function derivedJson() {
  const r = (v, d) => round(v, d === undefined ? 4 : d);
  return JSON.stringify({
    generatedBy: 'devtests/cars-data/derive.js', season: I.SEASON, cfg: CFG, rating: RATING,
    lapTimeSensitivityPctPerPct: Object.fromEntries(Object.keys(SENS).map(k => [k, r(SENS[k])])),
    dragComp: r(DRAG_COMP), paceCompression: r(K), paceMedianPct: r(paceMed),
    standard: { topKmh: r(stdMetrics.topKmh, 2), topBatteryKmh: r(stdMetrics.topBoostKmh, 2), t0to300: r(stdMetrics.t0to300, 3),
      brake300to80: r(stdMetrics.brake300to80, 2), cornerKmh: stdCorner.map(v => r(v, 2)), batteryAllLapPct: r(stdBoost),
      laps: geos.map((g, i) => ({ id: g.id, name: g.name, seconds: r(stdLaps[i], 3) })) },
    powerUnits: Object.keys(PU).map(id => ({ id: id, teams: PU[id].teams, aduoIcePct: PU[id].aduoIcePct, speedIndexKmh: r(PU[id].V, 3),
      powerFromAduo: r(PU[id].powerAduo), powerFromSpeed: r(PU[id].powerSpeed), usesSpeed: PU[id].usesSpeed, power: r(PU[id].power) })),
    cars: ORDER.map(t => ({
      id: t.id, pacePct: r(t.pace), autosportGapPct: r(t.autosportGapPct), targetPct: r(t.target), speedIndexKmh: r(t.V, 3),
      familyResidualKmh: t.familyResidual === null ? null : r(t.familyResidual, 3), ersRank: t.ersRank,
      zone: Object.fromEntries(CHASSIS.map(k => [k, r(t.zone[k])])), levelPct: r(t.L * 100), perf: t.perf,
      lapPct: r(t.lapDelta), lapBatteryPct: r(t.lapDeltaBoost), perTrackPct: t.perTrack.map(v => r(v, 3)),
      topKmh: r(t.metrics.topKmh, 2), topBatteryKmh: r(t.metrics.topBoostKmh, 2), t0to300: r(t.metrics.t0to300, 3),
      brake300to80: r(t.metrics.brake300to80, 2), cornerKmh: t.corner.map(v => r(v, 2)),
      ratingX: Object.fromEntries(Object.keys(t.x).map(k => [k, r(t.x[k], 3)])), ratings: t.ratings
    }))
  }, null, 1) + '\n';
}

if (require.main === module) {
  const f = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d);
  console.log('lap-time sensitivity (% per +1 %): ' + Object.keys(SENS).map(k => k + ' ' + SENS[k].toFixed(4)).join(', ') + '; DRAG_COMP ' + DRAG_COMP.toFixed(4));
  console.log('pace: K = ' + K.toFixed(4) + '  (real spread ' + (paceMax - paceMin).toFixed(3) + ' % -> ' + CFG.SPREAD + ' %), median real gap ' + paceMed.toFixed(3) + ' %');
  if (SCAN) for (const s of scan) console.log('  GAIN ' + s.gain.toFixed(2) + ': rms L ' + s.rms.toFixed(3) + ' %, largest |L| ' + s.max.toFixed(3) + ' %');
  console.log('id            pace%  target%    lap%     L%     power   drag  downf   grip  brake  tract   ersP   ersH    top  0-300   brk  corners            | T   A   C   B   E');
  for (const t of ORDER) {
    const p = t.perf, k = t.metrics;
    console.log(t.id.padEnd(13) + t.pace.toFixed(3).padStart(6) + f(t.target, 3).padStart(8) + f(t.lapDelta, 3).padStart(8) + f(t.L * 100, 2).padStart(7) + '   ' +
      M.KEYS.map(key => p[key].toFixed(4)).join(' ') + '  ' + k.topKmh.toFixed(1) + ' ' + k.t0to300.toFixed(2) + ' ' + k.brake300to80.toFixed(1) + '  ' +
      t.corner.map(v => v.toFixed(1)).join(' ') + ' | ' + Object.keys(RATING).map(key => String(t.ratings[key]).padStart(3)).join(' '));
  }
  console.log('rating x:     ' + Object.keys(RATING).map(key => key + ' ' + Math.min.apply(null, T.map(t => t.x[key])).toFixed(2) + ' .. ' + Math.max.apply(null, T.map(t => t.x[key])).toFixed(2)).join('; '));
  console.log('standard car: top ' + stdMetrics.topKmh.toFixed(1) + ' (battery ' + stdMetrics.topBoostKmh.toFixed(1) + ') km/h, 0-300 ' + stdMetrics.t0to300.toFixed(2) + ' s, 300-80 ' +
    stdMetrics.brake300to80.toFixed(1) + ' m, corners ' + stdCorner.map(v => v.toFixed(1)).join(' / ') + ' km/h; battery held all lap: ' + stdBoost.toFixed(3) + ' % lap time');
  for (const id of Object.keys(PU)) { const u = PU[id]; console.log('PU ' + id.padEnd(12) + ' V ' + u.V.toFixed(2).padStart(6) + '  aduo-power ' + u.powerAduo.toFixed(4) + '  speed-power ' + u.powerSpeed.toFixed(4) + '  -> ' + u.power.toFixed(4) + (u.usesSpeed ? ' (measured speed)' : '')); }

  const outputs = [
    [path.join(M.ROOT, 'js', 'cars-data.js'), carsJs()],
    [path.join(M.ROOT, 'docs', 'cars-data-sources.md'), require('./doc.js')(D)],
    [path.join(__dirname, 'derived.json'), derivedJson()]
  ];
  if (problems.length) { console.log('PROBLEMS (nothing written):\n  ' + problems.join('\n  ')); process.exitCode = 1; }
  else if (CHECK) {
    for (const [file, text] of outputs) {
      const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
      console.log((same ? 'up to date  ' : 'DIFFERS     ') + path.relative(M.ROOT, file));
      if (!same) process.exitCode = 1;
    }
  } else if (DRY) console.log('checks passed (--dry: nothing written)');
  else {
    for (const [file, text] of outputs) { fs.writeFileSync(file, text); console.log('wrote ' + path.relative(M.ROOT, file)); }
    console.log('checks passed');
  }
}
