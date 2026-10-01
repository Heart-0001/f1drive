// F1Drive - car-selection data: the physics model used to turn perf multipliers into lap times and ratings.
//
// This is a parameterised copy of the load model of js/car.js (v5 constants = every multiplier 1) and of the
// speed profile of js/raceline.js (corner-speed limit, backward braking pass, forward acceleration pass, with
// the same margins). derive.js checks at start-up that, for the standard car, it reproduces
// F1.CAR_PERF and F1.buildRaceLine(track).lapTime of the real modules.
//
// What each multiplier scales (README-interfaces.md, CarSpec):
//   power      -> POWER (W/kg)                 top speed; acceleration above ~300 km/h (below that the car is
//                                              limited by `traction`)
//   drag       -> DRAG_K                       top speed, acceleration at speed (and a little extra braking)
//   downforce  -> DOWNFORCE                    medium / fast corner speed, braking from high speed
//   grip       -> LAT_BASE and LAT_MAX         lateral grip at every speed (slow corners: the only term)
//   brake      -> BRAKE_BASE                   braking
//   traction   -> TRACTION                     acceleration from standstill up to the power limit
//   ersPower   -> ers.power                    extra power while the battery button is held
//   ersHarvest -> ers.harvest                  how fast the battery refills
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const KMH = 1 / 3.6;
const BASE = {                      // js/car.js v5 constants
  topSpeed: 330 * KMH, dragK: 0.0012, roll: 0.5, traction: 11.0, brakeBase: 12.0, brakeAero: 0.0032,
  latBase: 20.0, latAero: 0.0045, latMax: 44.0, gravity: 9.81, anMin: 2.0,
  wheelbase: 3.6, steerLock: 0.35, steerSpeedRef: 22,
  ersPowerShare: 0.16               // README v6: ers.power = 0.16 * POWER for the reference car
};
BASE.power = (BASE.dragK * BASE.topSpeed * BASE.topSpeed + BASE.roll) * BASE.topSpeed;
BASE.muLat = BASE.latBase / BASE.gravity;
BASE.downforce = BASE.latAero / BASE.muLat;
BASE.muBrake = BASE.brakeBase / BASE.gravity;
BASE.brakeDrag = BASE.brakeAero - BASE.muBrake * BASE.downforce;

const KEYS = ['power', 'drag', 'downforce', 'grip', 'brake', 'traction', 'ersPower', 'ersHarvest'];
const ONES = { power: 1, drag: 1, downforce: 1, grip: 1, brake: 1, traction: 1, ersPower: 1, ersHarvest: 1 };

// top speed (m/s) for power P (W/kg) and drag k: P = (k v^2 + roll) v
function topSpeedFor(P, k, roll) {
  let lo = 10, hi = 200;
  for (let i = 0; i < 60; i++) { const v = 0.5 * (lo + hi); if ((k * v * v + roll) * v < P) lo = v; else hi = v; }
  return 0.5 * (lo + hi);
}

// perf object in the shape of F1.CAR_PERF. boost = true adds the ERS power (battery button held).
function makePerf(m, boost) {
  m = Object.assign({}, ONES, m || {});
  const G = BASE.gravity, AN_MIN = BASE.anMin, ROLL = BASE.roll;
  const DRAG_K = BASE.dragK * m.drag;
  const POWER = BASE.power * m.power + (boost ? BASE.power * BASE.ersPowerShare * m.ersPower : 0);
  const TRACTION = BASE.traction * m.traction, MU_TRACTION = TRACTION / G;
  const MU_LAT = BASE.latBase * m.grip / G, LAT_MAX = BASE.latMax * m.grip;
  const DOWNFORCE = BASE.downforce * m.downforce;
  const MU_BRAKE = BASE.brakeBase * m.brake / G, BRAKE_DRAG = BASE.brakeDrag;
  const TOP = topSpeedFor(POWER, DRAG_K, ROLL);
  function baseLoad(v, bank, pitch, kappaV) {
    const a = G * Math.cos(bank || 0) * Math.cos(pitch || 0) + (DOWNFORCE - (kappaV || 0)) * v * v;
    return a > AN_MIN ? a : AN_MIN;
  }
  function normalAccel(v, bank, pitch, kappaV, latAccel) {
    const a = baseLoad(v, bank, pitch, kappaV) - (latAccel || 0) * Math.sin(bank || 0);
    return a > AN_MIN ? a : AN_MIN;
  }
  function maxLatAccel(v, bank, pitch, kappaV, turnSign) {
    const s = turnSign < 0 ? -1 : 1, sb = Math.sin(bank || 0), cb = Math.cos(bank || 0);
    const A0 = baseLoad(v, bank, pitch, kappaV), den = cb + s * MU_LAT * sb;
    const m1 = den > 0.05 ? (MU_LAT * A0 - s * G * sb) / den : Infinity;
    const m2 = (LAT_MAX - s * G * sb) / cb;
    const r = m1 < m2 ? m1 : m2;
    return r > 0 ? r : 0;
  }
  function maxAccel(v, bank, pitch, kappaV, latAccel) {
    const an = normalAccel(v, bank, pitch, kappaV, latAccel), av = Math.abs(v);
    return Math.min(TRACTION, MU_TRACTION * an, POWER / Math.max(av, 1)) - ROLL - DRAG_K * v * v - G * Math.sin(pitch || 0);
  }
  function maxDecel(v, bank, pitch, kappaV, latAccel) {
    const an = normalAccel(v, bank, pitch, kappaV, latAccel);
    return MU_BRAKE * an + BRAKE_DRAG * v * v + ROLL + DRAG_K * v * v + G * Math.sin(pitch || 0);
  }
  return {
    topSpeed: TOP, dragK: DRAG_K, roll: ROLL, traction: TRACTION, power: POWER,
    brakeBase: BASE.brakeBase * m.brake, latBase: BASE.latBase * m.grip, latMax: LAT_MAX, gravity: G,
    wheelbase: BASE.wheelbase, steerLock: BASE.steerLock, steerSpeedRef: BASE.steerSpeedRef,
    muLat: MU_LAT, muTraction: MU_TRACTION, muBrake: MU_BRAKE, downforce: DOWNFORCE, brakeDrag: BRAKE_DRAG,
    minNormalAccel: AN_MIN,
    normalAccel: normalAccel, maxLatAccel: maxLatAccel, maxAccel: maxAccel, maxDecel: maxDecel
  };
}

// ---- racing-line speed profile (js/raceline.js, same margins) on a stored line geometry ----
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

// Geometry of the racing line of a built track: everything the speed profile needs, independent of the car.
function lineGeometry(track, line) {
  const S = track.samples, N = S.length, P = line.points, G = BASE.gravity;
  const seg = new Float64Array(N), slope = new Float64Array(N), curv = new Float64Array(N);
  const bank = new Float64Array(N), pitch = new Float64Array(N), gsin = new Float64Array(N);
  const kv = new Float64Array(N), kvSafe = new Float64Array(N), latSign = new Float64Array(N);
  let i, j;
  for (i = 0; i < N; i++) {
    j = (i + 1) % N;
    let sl = Math.hypot(P[j].x - P[i].x, P[j].z - P[i].z);
    if (sl < 0.05) sl = 0.05;
    seg[i] = sl; curv[i] = P[i].curvature;
  }
  for (i = 0; i < N; i++) {
    const i3 = (i + 3) % N, im3 = (i - 3 + N) % N;
    let run = 0;
    for (j = 0; j < 6; j++) run += seg[(im3 + j) % N];
    const rise = P[i3].y - P[im3].y;
    slope[i] = rise / Math.hypot(run, rise);
  }
  for (i = 0; i < N; i++) {
    const sp = S[(i - 1 + N) % N], sc = S[i], sq = S[(i + 1) % N];
    const gp = Math.hypot(sc.x - sp.x, sc.z - sp.z), gq = Math.hypot(sq.x - sc.x, sq.z - sc.z);
    let k0 = 0;
    if (typeof sc.y === 'number' && typeof sp.y === 'number' && typeof sq.y === 'number' &&
        gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10) {
      k0 = -((sq.y - sc.y) / gq - (sc.y - sp.y) / gp) / (0.5 * (gp + gq));
    }
    kv[i] = isFinite(k0) ? k0 : 0;
    bank[i] = +sc.bank || 0;
    pitch[i] = Math.asin(slope[i]);
    gsin[i] = G * slope[i];
    latSign[i] = curv[i] < 0 ? 1 : -1;
  }
  for (i = 0; i < N; i++) {
    let km = kv[i];
    for (j = -CREST_SPAN; j <= CREST_SPAN; j++) { const kq = kv[((i + j) % N + N) % N]; if (kq > km) km = kq; }
    kvSafe[i] = km;
  }
  return { N: N, seg: seg, curv: curv, bank: bank, pitch: pitch, gsin: gsin, kvSafe: kvSafe, latSign: latSign };
}

// Lap of the speed profile for perf p. Returns the lap time, the highest speed and the profile itself.
function lap(geo, p) {
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
  let t = 0, vmax = 0, len = 0;
  for (i = 0; i < N; i++) {
    t += seg[i] / (0.5 * (vT[i] + vT[(i + 1) % N]));
    len += seg[i];
    if (vT[i] > vmax) vmax = vT[i];
  }
  return { time: t, vmax: vmax, length: len, speed: vT };
}

// ---- simple car metrics on a flat road (for the menu's rating bars) ----
function metrics(m) {
  const p = makePerf(m, false), pb = makePerf(m, true);
  const dv = 0.05;
  let t = 0, d = 0, v;
  // standing start to 300 km/h (s), flat and straight
  for (v = 0.5; v < 300 * KMH; v += dv) { const a = p.maxAccel(v, 0, 0, 0, 0); if (!(a > 0.01)) { t = Infinity; break; } t += dv / a; }
  // braking distance 300 -> 80 km/h (m)
  for (v = 300 * KMH; v > 80 * KMH; v -= dv) d += v * dv / p.maxDecel(v, 0, 0, 0, 0);
  // steady corner speed on a flat, unbanked radius R (m)
  const corner = R => {
    let lo = 5, hi = 120;
    for (let i = 0; i < 50; i++) { const x = 0.5 * (lo + hi); if (p.maxLatAccel(x, 0, 0, 0, 1) >= x * x / R) lo = x; else hi = x; }
    return 0.5 * (lo + hi);
  };
  return {
    topKmh: p.topSpeed / KMH, topBoostKmh: pb.topSpeed / KMH, t0to300: t, brake300to80: d,
    cornerSlowKmh: corner(30) / KMH, cornerMedKmh: corner(110) / KMH, cornerFastKmh: corner(260) / KMH
  };
}

// ---- tracks ----
let loaded = false;
function load() {
  if (loaded) return;
  global.window = global;
  global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
  require(path.join(ROOT, 'tracks-data.js'));
  require(path.join(ROOT, 'js/track.js'));
  require(path.join(ROOT, 'js/car.js'));
  require(path.join(ROOT, 'js/raceline.js'));
  loaded = true;
}
// Builds the real track and its real racing line; returns the car-independent geometry plus the lap time the
// real module predicts for its own car (the v5 / reference car).
function buildGeometry(trackId) {
  load();
  const F1 = global.F1, td = global.F1_TRACKS.find(t => t.id === trackId);
  if (!td) throw new Error('unknown track ' + trackId);
  const track = F1.buildTrack(td), line = F1.buildRaceLine(track);
  const geo = lineGeometry(track, line);
  geo.id = td.id; geo.name = td.name; geo.refLapTime = line.lapTime;
  if (line.dispose) line.dispose();
  if (track.dispose) track.dispose();
  return geo;
}

module.exports = { BASE, KEYS, ONES, KMH, makePerf, topSpeedFor, lineGeometry, lap, metrics, buildGeometry, load, ROOT };
