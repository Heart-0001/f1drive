// F1Drive - car physics (arcade). Pure math: no DOM, no THREE. See js/README-interfaces.md.
// v6: the car is described by a CarSpec (F1.REF_SPEC = the v5 car, F1.carPerf(spec) -> its limits), and has a
// drivetrain (gear / rpm for the sound and the HUD, no torque interruption), a battery (ERS), a pit limiter, the tyres of
// js/tyres.js (grip multipliers) and knows the pit lane of js/track.js (asphalt, a solid pit wall).
// Golden rule: the reference car on fresh medium tyres, no boost, no limiter, drives exactly as the v5 car did
// (bit-identical: test/car.test.js drives it against the v5 file, devtests/car-v6/car-v5.js).
//
//   F1.REF_SPEC                       the reference CarSpec (the v5 car: its physics numbers are the constants below)
//   F1.sanitizeSpec(spec) -> spec     a clean copy with exactly the contract's fields, the reference's where missing / absurd
//   F1.carPerf(spec) -> perf          F1.CAR_PERF's fields and functions for that spec, plus gearFor(v, gear?),
//                                     rpmFor(v, gear?), gears, topSpeedBoost, ersDeploy(v), ers, spec. F1.CAR_PERF =
//                                     the reference's.
//   F1.createCar(spec?, opts?) -> car opts: {tyres: instance | false, random} (default F1.createTyres({random}) when
//                                     js/tyres.js is loaded, else null: grip 1)
//   car = { state, reset(track, i), update(dt, input, track), setSpec(spec), setBattery(v), bump(strength), spec, perf,
//           tyres }                   bump: a car-to-car impact 0..1 (main.js, after F1.resolveCarCollisions): the next
//                                     update feeds it to the tyres and to state.hit as a wall impact (the path is unchanged)
//   input = {up, down, left, right, throttle?, brake?, steerAxis?, boost?, limiter?}
//   track.pit (js/track.js) must also give paved(index, d) -> bool: on the pit asphalt (lane, boxes, tapers; never
//                                     the road itself), from..to - the car there is not on the grass
//   state (v5) x, y, z, heading, speed, steer, pitch, roll, sampleIndex, d, onGrass, hit
//         (v6) throttle, brake, gear, rpm, shiftT, shiftDir, battery, deploy, harvest, slip, limiter, limitKmh, inPit, vib
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // ---- tuning (the reference car) ---------------------------------------------
  var KMH = 1 / 3.6;
  var TOP_SPEED = 330 * KMH;        // m/s on asphalt
  var REV_MAX = 40 * KMH;           // reverse speed limit
  var DRAG_K = 0.0012;              // aero drag decel = k * v^2   (~1 g at top speed)
  var ROLL = 0.5;                   // rolling resistance, m/s^2
  var TRACTION = 11.0;              // traction-limited acceleration on asphalt, m/s^2
  var TRACTION_GRASS = 5.6;
  var POWER = (DRAG_K * TOP_SPEED * TOP_SPEED + ROLL) * TOP_SPEED; // W/kg, gives exact top speed
  var BRAKE_BASE = 12.0;            // m/s^2 mechanical
  var BRAKE_AERO = 0.0032;          // + k * v^2 (downforce)
  var BRAKE_GRASS = 6.0;
  var REV_ACCEL = 5.0;
  var GRASS_DRAG_BASE = 0.8;        // extra decel on grass = base + lin * |v|
  var GRASS_DRAG_LIN = 0.16;        //   -> full throttle settles at ~80 km/h
  var WHEELBASE = 3.6;
  var STEER_LOCK = 0.35;            // rad: full lock at the road wheels (20 deg: a Monaco-spec rack; F1 cars run ~14 deg
                                    //   elsewhere, ~20-22 at Monaco: formula1.com, Ferrari SF15-T / Smedley 2019)
  var STEER_SPEED_REF = 22;         // m/s; the v5 law at speed: lock = STEER_LOCK / (1 + (v/ref)^2) (keyboard stability)
  var STEER_LOW_GRIP = 1.25;        // ... but never less lock than asks STEER_LOW_GRIP x the mechanical grip: full lock up
                                    //   to ~57 km/h (Monaco's hairpin at ~47 km/h), the v5 law from ~85 km/h on
  var LAT_BASE = 20.0;              // m/s^2 mechanical grip
  var LAT_AERO = 0.0045;            // + k * v^2
  var LAT_MAX = 44.0;               // ~4.5 g cap
  var GRASS_GRIP = 0.45;
  var SCRUB_GAIN = 5.0;             // understeer tyre scrub decel per unit of overshoot
  var SCRUB_MAX = 3.0;
  var CAR_HALF_WIDTH = 1.0;
  var SUBSTEP_DIST = 1.0;           // max metres travelled per sub-step
  var WALL_MAX_OVERSHOOT = 3.0;     // local locate puts the car further than this beyond a wall -> not
                                    //   believable, re-locate globally before resolving the collision
  var RESYNC_DIST = 20.0;           // located sample further than this from the car -> re-locate globally
  var WALL_HIT_REF = 30.0;          // normal impact speed (m/s) giving hit = 1
  var WALL_FRICTION = 0.4;
  var GRAVITY = 9.81;
  var ATTITUDE_TAU = 0.07;          // s, smoothing of pitch / roll
  var KAPPA_TAU = 0.06;             // s, smoothing of the road's vertical curvature under the car
  var STEER_RATE_ANALOG = 12.0;     // 1/s: how fast state.steer follows an analog stick (input.steerAxis).
                                    //   The stick is already smooth, so this only takes the edge off flicks
                                    //   (centre -> full lock in ~0.08 s); keyboard rates are in updateSteer.

  // ---- v6: drivetrain, battery, limiter, tyres, pit lane ------------------------
  var GEAR_DOWN_HYST = 8;           // km/h: downshift this far below the upshift speed of the lower gear
  var SHIFT_T_NONE = 9;             // state.shiftT before the first gear change (s: "long ago")
  var ERS_ETA = 0.38;               // share of the braking power (brake decel x speed) the battery recovers, up to ers.harvest
  var ERS_LIFT_V = 20;              // m/s: lift-off (no pedal) harvests above this speed ...
  var ERS_LIFT = 0.12;              //   ... this share of ers.harvest
  var LIMITER_KMH = 80;             // pit limiter speed where the track has no pit lane
  var LIMITER_BAND = 0.5;           // m/s: the limiter fades the drive out over this much below the limit
  var PUNCT_ROLL = 1.0;             // a flat tyre drags: extra resistance PUNCT_ROLL + PUNCT_DRAG * v^2 (m/s^2) ...
  var PUNCT_DRAG = 0.0043;          //   ... full throttle then tops out at ~150 km/h, ~100 on a flat rear (less traction)
  var PUNCT_IN = 0.5;               // s: phased in as the tyre deflates
  var SLIP_GAIN = 2;                // state.slip = SLIP_GAIN * (lateral grip asked / available - 1), capped at 1
  var CAR_HALF_LEN = 2.6;           // m from the car's origin to its nose / tail (the ends of the pit wall)
  var PIT_RESYNC_DIST = 40;         // in the pit complex the located sample may be this far away (boxes ~23 m out)
  var PIT_EPS = 1e-6;

  // ---- tyre-load model ------------------------------------------------------
  // Grip is mu * a_n, a_n = normal acceleration pressing the car onto the road:
  //   a_n = g*cos(bank)*cos(pitch)            gravity on the tilted surface
  //       + DOWNFORCE * v^2                   aero
  //       - v^2 * kappaV                      vertical curvature (kappaV > 0 over a crest, < 0 in a dip)
  //       - aLeft * sin(bank)                 centripetal load (banked into the turn adds, off-camber removes)
  // The friction coefficients are the old flat-track numbers divided by g, so on a flat road
  // everything is exactly as before: lateral 20 + 0.0045 v^2 (cap 44), traction 11, brake 12 + 0.0032 v^2.
  var MU_LAT = LAT_BASE / GRAVITY;                 // 2.04
  var DOWNFORCE = LAT_AERO / MU_LAT;               // 0.00221 (m/s^2 per (m/s)^2): 1 g of downforce at 240 km/h
  var MU_TRACTION = TRACTION / GRAVITY;            // 1.12, capped at TRACTION (drivetrain limit)
  var MU_TRACTION_GRASS = TRACTION_GRASS / GRAVITY;
  var MU_BRAKE = BRAKE_BASE / GRAVITY;             // 1.22
  var BRAKE_DRAG = BRAKE_AERO - MU_BRAKE * DOWNFORCE; // 0.0005 v^2: extra aero drag under braking
  var MU_BRAKE_GRASS = BRAKE_GRASS / GRAVITY;      // capped at BRAKE_GRASS
  var AN_MIN = 2.0;                 // floor for a_n (car "light" over a sharp crest), m/s^2

  // ---- CarSpec (README-interfaces.md, v6) -------------------------------------
  // The reference car = the v5 car: its physics numbers are the constants above. ERS (per kg of car): deploying
  // multiplies the engine's drive by 1 + ers.power / power at every speed (the drivetrain's traction cap included,
  // still limited by the tyres' friction), a full store deploys ers.power for 32 s; ers.taperKmh (optional, 2026:
  // the MGU-K rule) fades the deploy power out linearly between its two speeds. Harvest: ERS_ETA of the braking power
  // up to ers.harvest. Measured with the real car on the real tracks (devtests/car-v6/ers.js): +16..19 km/h at the end
  // of every straight of 900 m or more, 0-200 km/h 6.09 -> 5.38 s, a racing lap without deploying recovers 55..65 % of
  // the store (analog pedals; the keyboard test driver 48..80 %).
  var ERS_POWER = 0.15 * POWER;                    // 145.5 W/kg: 0.15 x the engine (1.15 x in all deploying)
  var REF = {
    id: '2025-standard', year: 2025,
    team: 'F1Drive', teamZh: 'F1Drive', car: '標準賽車', engine: '1.6 L V6 渦輪混合動力',
    colour: '#9AA0A6', colour2: '#2B2F36',
    ratings: { topSpeed: 50, accel: 50, cornering: 50, braking: 50, ers: 50 },
    note: '',
    power: POWER, dragK: DRAG_K, downforce: DOWNFORCE, latBase: LAT_BASE, latMax: LAT_MAX,
    brakeBase: BRAKE_BASE, traction: TRACTION,
    gearKmh: [60, 100, 140, 180, 220, 260, 300], topKmh: 345,
    rpmIdle: 4000, rpmShift: 11800, rpmMax: 15000, shiftTime: 0.05,   // rpmMax: the V6 regulation limit (as every
                                                                        //   other V6 season); rpm reaches it at 439 km/h
    cylinders: 6, aspiration: 'hybrid',
    ers: { store: 32 * ERS_POWER, power: ERS_POWER, harvest: 230 },
    cockpit: 'halo18'
  };
  var RATINGS = ['topSpeed', 'accel', 'cornering', 'braking', 'ers'];
  var PHYS = ['power', 'dragK', 'downforce', 'latBase', 'latMax', 'brakeBase', 'traction'];
  var ERS_KEYS = ['store', 'power', 'harvest'];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function num(v, fallback) { return typeof v === 'number' && v === v ? v : fallback; }
  function inRange(v, lo, hi) { return typeof v === 'number' && v >= lo && v <= hi; }      // (NaN fails)
  function text(v, fallback) { return typeof v === 'string' ? v.slice(0, 120) : fallback; }
  function colour(v, fallback) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback; }
  // Pedal position 0..1 from a boolean key and an optional analog value (absent / null / NaN = not
  // supplied); when both are given the larger one wins. A pressed key is exactly 1.
  function pedal(key, analog) {
    var k = key ? 1 : 0;
    if (typeof analog !== 'number' || !(analog > k)) return k;
    return analog < 1 ? analog : 1;
  }

  // A clean copy of a CarSpec with exactly the contract's fields: anything missing, of the wrong type or absurd
  // (physics outside 1/4..4 x the reference, ERS outside 1/10..10 x, drivetrain out of range) is the reference's.
  // So a bad data file can never produce NaN physics. ers missing (undefined) = the reference's battery; a battery only
  // from an object giving at least one of store / power / harvest as a number, with neither store nor power 0 (its absurd
  // fields are then the reference's); anything else (null, false, 0, '', {}, {store: 0, ...}) = no battery (null).
  // ers.taperKmh [from, to] (km/h, 50 <= from, from + 1 <= to <= 600) is kept only when valid (the reference has none).
  function sanitizeSpec(spec) {
    var s = spec && typeof spec === 'object' ? spec : {}, R = REF, o = {}, i, k;
    o.id = typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/.test(s.id) ? s.id : R.id;
    o.year = inRange(s.year, 1950, 2100) && s.year % 1 === 0 ? s.year : R.year;
    o.team = text(s.team, R.team); o.teamZh = text(s.teamZh, R.teamZh);
    o.car = text(s.car, R.car); o.engine = text(s.engine, R.engine);
    o.colour = colour(s.colour, R.colour); o.colour2 = colour(s.colour2, R.colour2);
    var rt = s.ratings && typeof s.ratings === 'object' ? s.ratings : {};
    o.ratings = {};
    for (i = 0; i < RATINGS.length; i++) { k = RATINGS[i]; o.ratings[k] = inRange(rt[k], 0, 100) ? rt[k] : R.ratings[k]; }
    o.note = text(s.note, R.note);
    for (i = 0; i < PHYS.length; i++) { k = PHYS[i]; o[k] = inRange(s[k], R[k] / 4, R[k] * 4) ? s[k] : R[k]; }
    var g = s.gearKmh, ok = Array.isArray(g) && g.length >= 1 && g.length <= 11;
    for (i = 0; ok && i < g.length; i++) if (!inRange(g[i], 10, 500) || (i > 0 && !(g[i] > g[i - 1]))) ok = false;
    o.gearKmh = (ok ? g : R.gearKmh).slice();
    var last = o.gearKmh[o.gearKmh.length - 1];
    o.topKmh = inRange(s.topKmh, last + 1, 600) ? s.topKmh : (R.topKmh > last + 1 ? R.topKmh : Math.round(last * 1.15));
    o.rpmIdle = inRange(s.rpmIdle, 500, 20000) ? s.rpmIdle : R.rpmIdle;
    o.rpmShift = inRange(s.rpmShift, o.rpmIdle + 100, 25000) ? s.rpmShift : Math.max(R.rpmShift, o.rpmIdle + 100);
    o.rpmMax = inRange(s.rpmMax, o.rpmShift, 25000) ? s.rpmMax : Math.max(R.rpmMax, o.rpmShift);
    o.shiftTime = inRange(s.shiftTime, 0.01, 0.2) ? s.shiftTime : R.shiftTime;
    o.cylinders = inRange(s.cylinders, 2, 16) && s.cylinders % 2 === 0 ? s.cylinders : R.cylinders;
    o.aspiration = s.aspiration === 'na' || s.aspiration === 'hybrid' ? s.aspiration : R.aspiration;
    var e = s.ers, bat = e === undefined, x;
    if (e && typeof e === 'object' && e.store !== 0 && e.power !== 0) {
      for (i = 0; i < ERS_KEYS.length; i++) { x = e[ERS_KEYS[i]]; if (typeof x === 'number' && x === x) bat = true; }
    }
    if (!bat) o.ers = null;
    else {
      e = e && typeof e === 'object' ? e : {};
      o.ers = {};
      for (i = 0; i < ERS_KEYS.length; i++) { k = ERS_KEYS[i]; o.ers[k] = inRange(e[k], R.ers[k] / 10, R.ers[k] * 10) ? e[k] : R.ers[k]; }
      x = e.taperKmh;
      if (Array.isArray(x) && x.length === 2 && inRange(x[0], 50, 599) && inRange(x[1], x[0] + 1, 600)) o.ers.taperKmh = [x[0], x[1]];
    }
    o.cockpit = s.cockpit === 'modern' || s.cockpit === 'halo' || s.cockpit === 'halo18' ? s.cockpit : R.cockpit;
    return o;
  }

  // The limits of a car (its tyre-load model), for js/car.js itself and for other modules (racing line, sound, HUD).
  // Every number is derived so that the reference spec gives exactly the v5 constants (x * 1 and x + 0 are exact).
  function carPerf(spec) {
    var s = sanitizeSpec(spec);
    var power = s.power, dragK = s.dragK, downforce = s.downforce, traction = s.traction, latMax = s.latMax;
    var muLat = s.latBase / GRAVITY, muTraction = s.traction / GRAVITY, muBrake = s.brakeBase / GRAVITY;
    var brakeDrag = BRAKE_DRAG * (dragK / DRAG_K);                    // extra aero drag under braking, with the drag
    var latAero = LAT_AERO + (muLat * downforce - MU_LAT * DOWNFORCE);
    var brakeAero = BRAKE_AERO + (brakeDrag - BRAKE_DRAG) + (muBrake * downforce - MU_BRAKE * DOWNFORCE);
    var gk = s.gearKmh, nGears = gk.length + 1, rpmIdle = s.rpmIdle, rpmShift = s.rpmShift, rpmMax = s.rpmMax;
    var ersPower = s.ers ? s.ers.power : 0, taper = s.ers && s.ers.taperKmh ? s.ers.taperKmh : null;
    var tv0 = taper ? taper[0] * KMH : 0, tv1 = taper ? taper[1] * KMH : 0;

    // bank / pitch in radians (bank > 0: driver's left higher; pitch > 0: nose up), kappaV in 1/m.
    function baseLoad(v, bank, pitch, kappaV) {
      var a = GRAVITY * Math.cos(bank || 0) * Math.cos(pitch || 0) + (downforce - (kappaV || 0)) * v * v;
      return a > AN_MIN ? a : AN_MIN;
    }
    // Normal acceleration including the centripetal part; latAccel = signed lateral accel towards the LEFT.
    function normalAccel(v, bank, pitch, kappaV, latAccel) {
      var a = baseLoad(v, bank, pitch, kappaV) - (latAccel || 0) * Math.sin(bank || 0);
      return a > AN_MIN ? a : AN_MIN;
    }
    // Largest lateral (centripetal, horizontal) acceleration the tyres can hold while turning towards
    // turnSign (+1 = left, -1 = right). The tyre force along the surface is aLeft*cos(bank) + g*sin(bank):
    // gravity helps when the road is banked into the turn and has to be fought when it is off-camber.
    function maxLatAccel(v, bank, pitch, kappaV, turnSign) {
      var sg = turnSign < 0 ? -1 : 1, sb = Math.sin(bank || 0), cb = Math.cos(bank || 0);
      var A0 = baseLoad(v, bank, pitch, kappaV);
      var den = cb + sg * muLat * sb;
      var m1 = den > 0.05 ? (muLat * A0 - sg * GRAVITY * sb) / den : Infinity;
      var m2 = (latMax - sg * GRAVITY * sb) / cb;       // tyre saturation cap
      var m = m1 < m2 ? m1 : m2;
      return m > 0 ? m : 0;
    }
    // Longitudinal limits as net accelerations along the direction of travel (m/s^2):
    // they include drag, rolling resistance and the gravity component on the slope.
    function maxAccel(v, bank, pitch, kappaV, latAccel) {
      var an = normalAccel(v, bank, pitch, kappaV, latAccel), av = Math.abs(v);
      return Math.min(traction, muTraction * an, power / Math.max(av, 1)) -
             ROLL - dragK * v * v - GRAVITY * Math.sin(pitch || 0);
    }
    function maxDecel(v, bank, pitch, kappaV, latAccel) {
      var an = normalAccel(v, bank, pitch, kappaV, latAccel);
      return muBrake * an + brakeDrag * v * v + ROLL + dragK * v * v + GRAVITY * Math.sin(pitch || 0);
    }

    // Steering lock (rad at the road wheels) at speed v on a road banked `bank` (rad, left higher > 0), turning towards
    // turnSign (+1 left): the v5 law (STEER_LOCK / (1 + (v / STEER_SPEED_REF)^2): at speed, full lock asks for about
    // the grip, so a keyboard's bang-bang steering stays tame), but never less than the lock that asks STEER_LOW_GRIP x
    // the mechanical grip (low speed: full lock up to ~57 km/h, the v5 law from ~85 km/h on); a road banked into the
    // turn, which holds more (maxLatAccel), gets that much more lock (never less than on the flat); at most STEER_LOCK.
    // On the flat above ~85 km/h this is exactly the v5 lock.
    function steerLockAt(v, bank, turnSign) {
      var av = v < 0 ? -v : v, r = av / STEER_SPEED_REF, lock = STEER_LOCK / (1 + r * r);
      if (!(av > 0.5)) return STEER_LOCK;
      var t = Math.tan(lock), tl = STEER_LOW_GRIP * s.latBase * WHEELBASE / (av * av), up = false;
      if (tl > t) { t = tl; up = true; }
      if (bank) {
        var gb = maxLatAccel(av, bank, 0, 0, turnSign), gf = maxLatAccel(av, 0, 0, 0, turnSign);
        if (gb > gf && gf > 0) { t *= gb / gf; up = true; }
      }
      if (!up) return lock;
      t = Math.atan(t);
      return t < STEER_LOCK ? t : STEER_LOCK;
    }

    // Drivetrain (shared by car.js for the own car and by audio.js for remote cars): the gear by speed against
    // gearKmh; with the current gear `cur` (1..n) the downshift comes GEAR_DOWN_HYST km/h below the upshift speed of
    // the lower gear. -1 reversing, 0 standing (|v| < 0.5 m/s).
    function gearFor(v, cur) {
      if (v < -0.5) return -1;
      if (!(v >= 0.5)) return 0;
      var kmh = v * 3.6, g = cur | 0;
      if (g < 1 || g > nGears) {
        g = 1;
        while (g < nGears && kmh >= gk[g - 1]) g++;
        return g;
      }
      while (g < nGears && kmh >= gk[g - 1]) g++;
      while (g > 1 && kmh < gk[g - 2] - GEAR_DOWN_HYST) g--;
      return g;
    }
    // rpm = rpmShift * v / top(g), top(g) = gearKmh[g - 1] (topKmh in the top gear; reverse uses gear 1), floor
    // rpmIdle, ceiling rpmMax. Gear 0 (or no gear given while standing) idles.
    function rpmFor(v, gear) {
      var kmh = (v < 0 ? -v : v) * 3.6, g = gear === undefined || gear === null ? gearFor(v) : gear | 0;
      if (g === 0 || !(kmh === kmh)) return rpmIdle;
      var r = rpmShift * kmh / (g >= nGears ? s.topKmh : gk[g >= 1 ? g - 1 : 0]);
      return r > rpmIdle ? (r < rpmMax ? r : rpmMax) : rpmIdle;
    }

    // Top speed on the flat: where the drive balances drag + rolling resistance (Newton from the reference's top
    // speed: exactly TOP_SPEED for the reference), capped where traction runs out first.
    function topFor(P) {
      var v = TOP_SPEED;
      for (var it = 0; it < 60; it++) {
        var f = (dragK * v * v + ROLL) * v - P;
        if (f === 0) break;
        var dv = f / (3 * dragK * v * v + ROLL);
        v -= dv;
        if (!(v > 1)) v = 1;
        if (Math.abs(dv) < 1e-13 * v) break;
      }
      var vt = Math.sqrt((traction - ROLL) / dragK);
      return v < vt ? v : vt;
    }
    // The battery's deploy power at speed v (W/kg): ers.power, faded out linearly from taperKmh[0] to 0 at taperKmh[1].
    function ersDeploy(v) {
      var av = v < 0 ? -v : v;
      if (!taper || !(av > tv0)) return ersPower;
      return av < tv1 ? ersPower * (tv1 - av) / (tv1 - tv0) : 0;
    }
    // ... and deploying the battery (the engine's drive x (1 + deploy power / power), up to the tyres' traction)
    function topBoost() {
      if (!ersPower) return topFor(power);
      var lo = 1, hi = 250;
      for (var it = 0; it < 80; it++) {
        var v = 0.5 * (lo + hi), ice = Math.min(traction, power / v);
        var a = Math.min(muTraction * (GRAVITY + downforce * v * v), ice * (1 + ersDeploy(v) / power)) - ROLL - dragK * v * v;
        if (a > 0) lo = v; else hi = v;
      }
      return lo;
    }

    return {
      topSpeed: topFor(power), dragK: dragK, roll: ROLL, traction: traction, power: power,
      brakeBase: s.brakeBase, brakeAero: brakeAero, latBase: s.latBase, latAero: latAero, latMax: latMax,
      gravity: GRAVITY, carHalfWidth: CAR_HALF_WIDTH,
      wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF, steerLowGrip: STEER_LOW_GRIP,
      steerLockAt: steerLockAt,        // (v, bank, turnSign) -> rad: the steering lock (state.steer = +-1) at that speed
      muLat: muLat, muTraction: muTraction, muBrake: muBrake, downforce: downforce, brakeDrag: brakeDrag,
      minNormalAccel: AN_MIN,
      bankGrip: 1 + muLat * muLat,     // legacy linearisation: d(maxLat) ~ bankGrip * g * sin(bank into the turn)
      normalAccel: normalAccel,        // (v, bank, pitch, kappaV, latAccelLeft) -> m/s^2
      maxLatAccel: maxLatAccel,        // (v, bank, pitch, kappaV, turnSign)     -> m/s^2
      maxAccel: maxAccel,              // (v, bank, pitch, kappaV, latAccelLeft) -> net m/s^2 on throttle (no battery)
      maxDecel: maxDecel,              // (v, bank, pitch, kappaV, latAccelLeft) -> net m/s^2 on the brakes
      // v6
      gearFor: gearFor,                // (v m/s signed, current gear?) -> -1 | 0 | 1..gears
      rpmFor: rpmFor,                  // (v, gear?) -> rpm
      gears: nGears,
      topSpeedBoost: topBoost(),       // m/s, deploying the battery all the way
      ersDeploy: ersDeploy,            // (v m/s) -> W/kg the battery deploys at that speed (0 without one)
      ers: s.ers,                      // null | {store J/kg, power W/kg, harvest W/kg, taperKmh?: [from, to] km/h}
      spec: s                          // the sanitised spec these numbers come from
    };
  }

  F1.sanitizeSpec = sanitizeSpec;
  F1.carPerf = carPerf;
  F1.REF_SPEC = sanitizeSpec(REF);
  // Tuning + the load model itself of the reference car, for other modules (racing line) so they use the same physics.
  F1.CAR_PERF = carPerf(REF);

  // F1.createCar(spec?, opts?): spec = a CarSpec (default F1.REF_SPEC); opts.tyres = a tyres instance to use (false:
  // none), else F1.createTyres({random: opts.random}) when js/tyres.js is loaded, else none (grip 1: the v5 car).
  F1.createCar = function (spec, opts) {
    opts = opts || {};
    var state = {
      x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, pitch: 0, roll: 0,
      sampleIndex: 0, d: 0, onGrass: false, hit: 0,
      // v6 (refreshed by every update)
      throttle: 0, brake: 0,          // pedals applied, 0..1
      gear: 0, rpm: REF.rpmIdle,      // -1 reverse, 0 standing, 1..n
      shiftT: SHIFT_T_NONE, shiftDir: 1,   // s since the last gear change, its direction
      battery: 1, deploy: 0, harvest: 0,   // 0..1
      slip: 0,                        // 0..1 past the lateral grip limit
      limiter: false, limitKmh: LIMITER_KMH,   // pit limiter engaged, its speed
      inPit: false,                   // in the pit lane between the entry and exit lines
      vib: 0                          // 0..1 flat spots / puncture (js/tyres.js)
    };
    // unsmoothed slope of the surface under the car, along / across the heading (tan of the angle)
    var slopeFwd = 0, slopeLeft = 0;
    // vertical curvature of the road along the direction of travel (1/m, > 0 over a crest): raw / smoothed
    var kappaRaw = 0, kappa = 0;
    // true while the steering is being driven by the analog axis (decides the centring rate once
    // everything is released); never set by keyboard-only input
    var steerAnalog = false;

    var K = null;                     // car.perf: this car's limits
    var ers = null;                   // car.spec.ers
    var tyres = opts.tyres !== undefined ? (opts.tyres || null) :
      (typeof F1.createTyres === 'function' ? F1.createTyres({ random: opts.random }) : null);
    // this step: pedals, boost / limiter, energy in and out of the battery (J/kg), slip, puncture drag (0..1)
    var thr = 0, brk = 0, boost = false, limiterOn = false, limitV = LIMITER_KMH / 3.6;
    var eDep = 0, eHar = 0, stepSlip = 0, punct = 0;
    var load = { speed: 0, lat: 0, brake: 0, drive: 0, slip: 0, onGrass: false, hit: 0 };   // js/tyres.js, every step
    var bumpHit = 0;                  // strongest car.bump since the last update, fed to the next one (then 0)
    // pit wall: its runs of the current track.pit (cache), and where the car was against it after the last step
    var pwFor = null, pwRuns = [], pwLim = 0.4 + CAR_HALF_WIDTH;
    var pwOk = false, pwRun = -1, pwSa = 0, pwRel = 0, lastX = 0, lastZ = 0;

    // Surface under the car: height + slopes along the heading and towards the driver's left.
    // Interpolates between the located sample and its neighbour along the tangent so nothing
    // steps every 2 m. Beyond the wall line the banked plane is continued, clamped at the wall.
    function surface(track) {
      var S = track.samples, n = S.length, i = state.sampleIndex, a = S[i];
      if (!a || typeof a.y !== 'number') { state.y = 0; slopeFwd = 0; slopeLeft = 0; kappaRaw = 0; return; }
      var along = (state.x - a.x) * a.tx + (state.z - a.z) * a.tz;
      var j = along >= 0 ? (i + 1) % n : (i - 1 + n) % n, b = S[j];
      var gap = Math.hypot(b.x - a.x, b.z - a.z);
      var f = gap > 1e-6 ? clamp(Math.abs(along) / gap, 0, 1) : 0;
      if (gap > 10) f = 0;                                  // not really neighbours (open test tracks)
      var lo = -num(a.wallNegDist, track.wallDist), hi = num(a.wallPosDist, track.wallDist);
      var d = clamp(state.d, lo, hi);
      var ta = Math.tan(a.bank || 0), tb = Math.tan(b.bank || 0);
      var tanB = ta + (tb - ta) * f;
      var ya = a.y + d * ta, yb = b.y + d * tb;
      state.y = ya + (yb - ya) * f;
      var g = gap > 1e-6 && gap <= 10 ? (yb - ya) / gap * (along >= 0 ? 1 : -1) : 0;   // dy/ds
      var sh = Math.sin(state.heading), ch = Math.cos(state.heading);
      var ft = sh * a.tx + ch * a.tz, fn = sh * a.nx + ch * a.nz;      // forward in the (t, n) frame
      slopeFwd = g * ft + tanB * fn;
      slopeLeft = -g * fn + tanB * ft;                      // left = (ch, -sh) = -fn * t + ft * n
      // vertical curvature from the second difference of the height profile
      var p = S[(i - 1 + n) % n], q = S[(i + 1) % n], k0 = 0;
      var gp = Math.hypot(a.x - p.x, a.z - p.z), gq = Math.hypot(q.x - a.x, q.z - a.z);
      if (gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10 && typeof p.y === 'number' && typeof q.y === 'number') {
        k0 = -((q.y - a.y) / gq - (a.y - p.y) / gp) / (0.5 * (gp + gq));
      }
      kappaRaw = k0 * ft * ft;
    }

    function reset(track, sampleIndex) {
      var n = track.samples.length;
      var i = ((Math.round(sampleIndex || 0) % n) + n) % n;
      var s = track.samples[i];
      state.x = s.x;
      state.z = s.z;
      state.heading = Math.atan2(s.tx, s.tz);
      state.speed = 0;
      state.steer = 0;
      steerAnalog = false;
      state.sampleIndex = i;
      state.d = 0;
      state.onGrass = false;
      state.hit = 0;
      // make sure the index really is the nearest sample (robust against a stale index)
      var loc = track.locate(state.x, state.z, -1);
      if (loc && loc.index >= 0) { state.sampleIndex = loc.index; state.d = loc.d; }
      surface(track);
      state.pitch = Math.atan(slopeFwd);
      state.roll = Math.atan(slopeLeft);
      kappa = kappaRaw;
      // v6: standing, nothing applied (the battery and the tyres are left alone)
      state.throttle = state.brake = 0;
      state.gear = 0; state.rpm = K.rpmFor(0, 0); state.shiftT = SHIFT_T_NONE;
      state.deploy = state.harvest = state.slip = 0;
      state.inPit = !!(track.pit && track.pit.inLane(state.sampleIndex, state.d));
      state.vib = tyres ? tyres.state.vib : 0;
      pwOk = false; lastX = state.x; lastZ = state.z;
      bumpHit = 0;                    // an impact not yet fed is dropped with the car's old place
    }

    function updateSteer(dt, input) {
      var target = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      var av = Math.abs(state.speed);
      var s = state.steer;
      var rate;
      // analog stick: input.steerAxis (-1..1, +1 = left) is the steering TARGET, so a half-deflected
      // stick holds half lock. Used when it is larger in magnitude than the keys; the keys win ties.
      var ax = input.steerAxis;
      if (typeof ax === 'number' && ax === ax) {
        ax = clamp(ax, -1, 1);
        if (Math.abs(ax) > Math.abs(target)) { target = ax; steerAnalog = true; }
        else if (target !== 0) steerAnalog = false;
      } else if (target !== 0) {
        steerAnalog = false;
      }
      if (steerAnalog) {
        rate = STEER_RATE_ANALOG;
      } else if (target === 0 || (s !== 0 && (s > 0) !== (target > 0))) {
        rate = 6.0;                          // centring / crossing over: quick
      } else {
        rate = 2.2 + 3.0 / (1 + av / 30);    // turning in: a bit gentler at speed
      }
      var step = rate * dt;
      if (s < target) s = Math.min(target, s + step);
      else if (s > target) s = Math.max(target, s - step);
      state.steer = s;
    }

    function stepPhysics(h) {
      var v = state.speed;
      var av = Math.abs(v);
      var grass = state.onGrass;
      // tyre grip multipliers (exactly 1 on a new medium set: x * 1 === x keeps the v5 numbers)
      var gr = tyres ? tyres.state.grip : null;
      var gLat = gr ? gr.lat : 1, gTrac = gr ? gr.traction : 1, gBrk = gr ? gr.brake : 1;

      // --- surface under the car ---
      kappa += (kappaRaw - kappa) * (1 - Math.exp(-h / KAPPA_TAU));
      var cp = 1 / Math.sqrt(1 + slopeFwd * slopeFwd), sp = slopeFwd * cp;      // pitch
      var cr = 1 / Math.sqrt(1 + slopeLeft * slopeLeft), sr = slopeLeft * cr;   // roll (left higher > 0)
      var A0 = GRAVITY * cr * cp + (K.downforce - kappa) * v * v;               // load before cornering
      if (A0 < AN_MIN) A0 = AN_MIN;

      // --- lateral / yaw (bicycle model with grip cap -> understeer) ---
      var resist = ROLL + K.dragK * av * av;  // magnitude, always opposes motion
      if (grass) resist += GRASS_DRAG_BASE + GRASS_DRAG_LIN * av;
      if (punct > 0) resist += punct * (PUNCT_ROLL + PUNCT_DRAG * av * av);   // running on a flat tyre
      var delta = state.steer === 0 ? 0 : state.steer * K.steerLockAt(av, Math.atan(slopeLeft), state.steer);
      var yaw = v * Math.tan(delta) / WHEELBASE;
      var aLeft = v * yaw;                    // centripetal acceleration asked for, towards the left
      load.lat = 0; stepSlip = 0;
      if (aLeft !== 0) {
        var ts = aLeft > 0 ? 1 : -1;
        var den = cr + ts * K.muLat * sr;
        var m1 = den > 0.05 ? (K.muLat * A0 - ts * GRAVITY * sr) / den : Infinity;
        var m2 = (K.latMax - ts * GRAVITY * sr) / cr;
        var latMax = Math.max(0, Math.min(m1, m2)) * gLat;
        if (grass) latMax *= GRASS_GRIP;
        var latReq = aLeft * ts;
        load.lat = latMax > latReq ? ts * latReq / latMax : ts;          // share of the lateral grip in use
        if (latReq > latMax) {
          stepSlip = latMax > 1e-6 ? Math.min(1, SLIP_GAIN * (latReq / latMax - 1)) : 1;
          yaw *= latMax / latReq;
          aLeft = ts * latMax;
          if (av > 5) resist += Math.min(SCRUB_MAX, latMax > 1e-6 ? SCRUB_GAIN * (latReq / latMax - 1) : SCRUB_MAX);
        }
      }
      var an = A0 - aLeft * sr;               // tyre load incl. the centripetal part
      if (an < AN_MIN) an = AN_MIN;

      // --- longitudinal (traction and braking scale with the tyre load) ---
      var drive = 0;      // signed acceleration
      var traction = (grass ? Math.min(TRACTION_GRASS, MU_TRACTION_GRASS * an) : Math.min(K.traction, K.muTraction * an)) * gTrac;
      var brake = (grass ? Math.min(BRAKE_GRASS, MU_BRAKE_GRASS * an) : K.muBrake * an + K.brakeDrag * av * av) * gBrk;

      if (v > 0.5) {
        // the brake pedal overrides the throttle in proportion (full brake = no drive, as with the keys)
        if (brk > 0) resist += brake * brk;
        if (thr > 0 && brk < 1) drive = Math.min(traction, K.power / Math.max(av, 1)) * thr * (1 - brk);
        // pit limiter: the drive fades out over the last LIMITER_BAND below the limit (it never brakes)
        var lf = 1;
        if (limiterOn) { lf = (limitV - av) / LIMITER_BAND; lf = lf < 0 ? 0 : (lf > 1 ? 1 : lf); if (lf < 1) drive *= lf; }
        if (ers) {
          var bat = state.battery, e;
          if (boost && thr > 0 && brk === 0 && bat > 0 && lf === 1) {        // (not while the limiter cuts)
            // deploy: the engine's drive (traction cap included) x (1 + deploy power / engine power), up to what the
            // tyres can transmit: below the traction cap's speed the battery deploys less than its power
            var full = Math.min(traction, K.power / Math.max(av, 1));
            var cap = (grass ? Math.min(TRACTION_GRASS, MU_TRACTION_GRASS * an) : K.muTraction * an) * gTrac;
            var add = Math.min(cap - full, full * K.ersDeploy(av) / K.power) * thr * lf;
            if (add > 0) {
              e = add * av * h;
              if (e > bat * ers.store) { e = bat * ers.store; add = e / (av * h); }
              drive += add;
              eDep += e;
              state.battery = bat - e / ers.store;
            }
          } else if (bat < 1) {
            // harvest: under braking (pedal x speed), a little on lift-off; bookkeeping only (the brakes are unchanged)
            var hp = brk > 0 ? Math.min(ers.harvest, ERS_ETA * brake * brk * av) :
                     (thr === 0 && av > ERS_LIFT_V ? ers.harvest * ERS_LIFT : 0);
            if (hp > 0) {
              e = hp * h;
              if (e > (1 - bat) * ers.store) e = (1 - bat) * ers.store;
              eHar += e;
              state.battery = bat + e / ers.store;
            }
          }
        }
      } else if (v < -0.5) {
        if (thr > 0) resist += brake * thr;
        else if (brk > 0 && av < REV_MAX) drive = -Math.min(REV_ACCEL, traction) * brk;
      } else {
        if (thr > 0 && thr >= brk) drive = traction * thr;
        else if (brk > 0) drive = -Math.min(REV_ACCEL, traction) * brk;
      }
      load.brake = v > 0.5 ? brk : (v < -0.5 ? thr : 0);
      load.drive = traction > 0 ? Math.min(1, (drive < 0 ? -drive : drive) / traction) : 0;

      // slope: gravity along the heading (speed is signed along the heading, so this is too)
      var grav = -GRAVITY * sp;
      var hold = thr === 0 && brk === 0 && av < 0.3;    // parked on a hill: the brakes hold it

      // --- integrate speed ---
      if (hold) {
        v = 0;
      } else {
        var push = drive + grav;
        v += push * h;
        var dv = resist * h;
        if (Math.abs(v) <= dv) v = (push !== 0 && Math.abs(push) > resist) ? v : 0;
        else v -= (v > 0 ? dv : -dv);
        if (v < -REV_MAX && drive < 0) v = -REV_MAX;
      }
      state.speed = v;

      // --- integrate pose ---
      state.heading += yaw * h;
      state.x += Math.sin(state.heading) * v * h;
      state.z += Math.cos(state.heading) * v * h;
    }

    // A wall face with the outward unit normal (nx, nz) (from the wall towards the car): the impact of the outer walls.
    function faceImpact(nx, nz) {
      var v = state.speed;
      if (v === 0) return;
      var sg = v > 0 ? 1 : -1;
      var dx = sg * Math.sin(state.heading), dz = sg * Math.cos(state.heading);   // travel direction
      var into = -(dx * nx + dz * nz);                                             // >0: moving into the wall
      if (!(into > 0)) return;
      var fx = nz, fz = -nx;                                                       // along the face
      var along = dx * fx + dz * fz;
      var tsg = along >= 0 ? 1 : -1;
      var A = Math.atan2(into, Math.abs(along));
      var sinA = Math.sin(A), cosA = Math.cos(A);
      var hit = clamp(Math.abs(v) * sinA / WALL_HIT_REF, 0, 1);
      if (hit > state.hit) state.hit = hit;
      state.speed = v * cosA * (1 - WALL_FRICTION * sinA);
      var turn = wrapPi(Math.atan2(tsg * fx, tsg * fz) - Math.atan2(dx, dz));
      var mag = Math.min(Math.abs(turn), Math.min(0.7 * A + 0.01, 0.35));
      state.heading += (turn >= 0 ? mag : -mag);
    }

    // The runs of the pit wall along track.pit (samples where pit.wallD is finite), cached per pit object:
    // {k0, k1: samples from pit.from, s0: track distance of the upstream end, len (m), wD: offset of its centre line}.
    function pitRuns(track, pit) {
      if (pwFor === pit) return pwRuns;
      pwFor = pit; pwRuns = []; pwOk = false;
      var S = track.samples, N = S.length, L = track.length, K2 = ((pit.to - pit.from) % N + N) % N, r = null;
      if (typeof pit.wallD !== 'function') return pwRuns;
      for (var k = 0; k <= K2; k++) {
        var i = (pit.from + k) % N, w = pit.wallD(i);
        if (typeof w === 'number' && w - w === 0) {
          if (!r) { r = { k0: k, k1: k, s0: S[i].s, len: 0, wD: w }; pwRuns.push(r); }
          r.k1 = k; r.len = ((S[i].s - r.s0) % L + L) % L;
        } else r = null;
      }
      pwLim = num(pit.wallHalfT, 0.4) + CAR_HALF_WIDTH;
      return pwRuns;
    }

    // The pit wall (between the track and the lane): solid from both sides and at both ends. In the frame of a run,
    // sa = metres along from its upstream end, rel = lateral offset from its centre line, the car's origin must stay
    // out of the wall grown by the car: |rel| >= wallHalfT + CAR_HALF_WIDTH beside it, and at the ends the car's
    // reach along the lane (nose / tail / side, by its heading). The car is pushed out through the face it came in by
    // (the face its path from the last step crossed last), with the impact of the outer walls. -> the new d.
    function pitWall(track, pit, idx, d) {
      var runs = pitRuns(track, pit), S = track.samples, N = S.length, s = S[idx];
      var k = ((idx - pit.from) % N + N) % N;
      for (var r = 0; r < runs.length; r++) {
        var R = runs[r];
        if (k < R.k0 - 3 || k > R.k1 + 3) continue;
        var L = track.length, lim = pwLim;
        var along = (state.x - s.x) * s.tx + (state.z - s.z) * s.tz;
        var sa = ((s.s + along - R.s0) % L + L) % L;
        if (sa > L / 2) sa -= L;
        var rel = d - R.wD;
        var sh = Math.sin(state.heading), ch = Math.cos(state.heading);
        var hl = Math.abs(sh * s.tx + ch * s.tz) * CAR_HALF_LEN + Math.abs(sh * s.nx + ch * s.nz) * CAR_HALF_WIDTH;
        var lo = -hl, hi = R.len + hl;
        if (sa > lo && sa < hi && rel > -lim && rel < lim) {
          var face = 0, best = -Infinity, t;
          if (pwOk && pwRun === r) {           // Liang-Barsky: the face the path crossed last
            var pr = pwRel, ps = pwSa;
            if (pr >= lim - PIT_EPS) { t = pr - rel > 0 ? (pr - lim) / (pr - rel) : 0; if (t > best) { best = t; face = 1; } }
            else if (pr <= -lim + PIT_EPS) { t = rel - pr > 0 ? (-lim - pr) / (rel - pr) : 0; if (t > best) { best = t; face = 2; } }
            if (ps <= lo + PIT_EPS) { t = sa - ps > 0 ? (lo - ps) / (sa - ps) : 0; if (t > best) { best = t; face = 3; } }
            else if (ps >= hi - PIT_EPS) { t = ps - sa > 0 ? (ps - hi) / (ps - sa) : 0; if (t > best) { best = t; face = 4; } }
          }
          if (!face) {                         // no history (placed, reset): the shortest way out
            var m = lim - rel; face = 1;
            if (rel + lim < m) { m = rel + lim; face = 2; }
            if (sa - lo < m) { m = sa - lo; face = 3; }
            if (hi - sa < m) face = 4;
          }
          if (face <= 2) {
            var sd = face === 1 ? 1 : -1, over = rel - sd * lim;
            state.x -= s.nx * over; state.z -= s.nz * over;
            d -= over; rel = sd * lim;
            faceImpact(sd * s.nx, sd * s.nz);
          } else {
            var se = face === 3 ? -1 : 1, ov = sa - (face === 3 ? lo : hi);
            state.x -= s.tx * ov; state.z -= s.tz * ov;
            sa -= ov;
            faceImpact(se * s.tx, se * s.tz);
          }
        }
        pwOk = true; pwRun = r; pwSa = sa; pwRel = rel;
        return d;
      }
      pwOk = false;
      return d;
    }

    // In the pit complex (lane, boxes, tapers) on the pit side of from..to, off the road?
    function inPitArea(pit, N, idx, d, hw) {
      var k = ((idx - pit.from) % N + N) % N;
      return k <= ((pit.to - pit.from) % N + N) % N && d * pit.side > hw;
    }

    function resolveTrack(track) {
      var S = track.samples;
      var pit = track.pit || null;
      var loc = track.locate(state.x, state.z, state.sampleIndex);
      var idx = loc.index, d = loc.d;
      var s = S[idx];
      var ad = Math.abs(d);
      var wd = d > 0 ? num(s.wallPosDist, track.wallDist) : num(s.wallNegDist, track.wallDist);
      var hasWall = d > 0 ? s.wallPos : s.wallNeg;
      var hw = num(s.halfW, track.halfWidth);

      // Is the local result believable? If not (far from the located sample, way beyond its wall,
      // or off the road edge where this piece of road has no wall - a crossing), look globally.
      // (In the pit complex the lane and the boxes are more than RESYNC_DIST out: the local result stands there.)
      var ex = state.x - s.x, ez = state.z - s.z, e2 = ex * ex + ez * ez;
      var far = e2 > RESYNC_DIST * RESYNC_DIST;
      if (far && pit && e2 <= PIT_RESYNC_DIST * PIT_RESYNC_DIST && inPitArea(pit, S.length, idx, d, hw)) far = false;
      if (far ||
          ad - (wd - CAR_HALF_WIDTH) >= WALL_MAX_OVERSHOOT ||
          (!hasWall && ad > hw)) {
        var g = track.locate(state.x, state.z, -1);
        if (g && g.index >= 0 && S[g.index]) {
          idx = g.index; d = g.d; s = S[idx]; ad = Math.abs(d);
          wd = d > 0 ? num(s.wallPosDist, track.wallDist) : num(s.wallNegDist, track.wallDist);
          hasWall = d > 0 ? s.wallPos : s.wallNeg;
          hw = num(s.halfW, track.halfWidth);
        }
      }

      var limit = wd - CAR_HALF_WIDTH;
      var side = d > limit ? 1 : (d < -limit ? -1 : 0);

      // The located sample is now the globally nearest one whenever the offset is large, so a car
      // beyond a wall is always put back inside it, however far out it got.
      if (side !== 0 && hasWall) {
        // push back to the limit along the sample normal
        var over = d - side * limit;
        state.x -= s.nx * over;
        state.z -= s.nz * over;
        d = side * limit;

        var v = state.speed;
        if (v !== 0) {
          var sg = v > 0 ? 1 : -1;
          var dx = sg * Math.sin(state.heading), dz = sg * Math.cos(state.heading); // travel direction
          var into = (dx * s.nx + dz * s.nz) * side;   // >0: moving into the wall
          if (into > 0) {
            var along = dx * s.tx + dz * s.tz;
            var tsg = along >= 0 ? 1 : -1;
            var A = Math.atan2(into, Math.abs(along));            // impact angle 0..PI/2
            var sinA = Math.sin(A), cosA = Math.cos(A);
            var hit = clamp(Math.abs(v) * sinA / WALL_HIT_REF, 0, 1);
            if (hit > state.hit) state.hit = hit;
            // keep the tangential part, minus friction growing with the angle
            state.speed = v * cosA * (1 - WALL_FRICTION * sinA);
            // swing the nose toward the wall tangent so the car slides along
            var turn = wrapPi(Math.atan2(tsg * s.tx, tsg * s.tz) - Math.atan2(dx, dz));
            var mag = Math.min(Math.abs(turn), Math.min(0.7 * A + 0.01, 0.35));
            state.heading += (turn >= 0 ? mag : -mag);
          }
        }
      }
      // the pit wall between the track and the pit lane
      if (pit) d = pitWall(track, pit, idx, d);

      state.sampleIndex = idx;
      state.d = d;
      // the pit lane's asphalt is not grass (pit.paved: lane, boxes and tapers, never the road itself)
      state.onGrass = Math.abs(d) > hw && !(pit && pit.paved(idx, d));
      state.inPit = !!pit && pit.inLane(idx, d);
      surface(track);
    }

    // gear (with the hysteresis of perf.gearFor; standing: 1 on the throttle, -1 on the brake = reverse), rpm
    function drivetrain(dt) {
      var v = state.speed, g;
      if (v < -0.5) g = -1;
      else if (!(v >= 0.5)) g = thr > 0 && thr >= brk ? 1 : (brk > 0 ? -1 : 0);
      else g = K.gearFor(v, state.gear);
      if (g !== state.gear) { state.shiftDir = g > state.gear ? 1 : -1; state.shiftT = 0; state.gear = g; }
      else state.shiftT += dt;
      state.rpm = K.rpmFor(v, g);
    }

    function update(dt, input, track) {
      state.hit = 0;
      if (!(dt > 0)) return;
      // a car-to-car impact since the last update (car.bump): an impact of this step for the tyres and state.hit
      if (bumpHit > 0) { state.hit = bumpHit; bumpHit = 0; }
      if (dt > 0.1) dt = 0.1;
      input = input || {};
      // pedals 0..1: keys give exactly 1, input.throttle / input.brake (optional) give analog values
      thr = pedal(input.up, input.throttle); brk = pedal(input.down, input.brake);
      boost = !!input.boost; limiterOn = !!input.limiter;
      var pit = track && track.pit ? track.pit : null;
      var lk = pit && typeof pit.limitKmh === 'number' && pit.limitKmh > 0 ? pit.limitKmh : LIMITER_KMH;
      limitV = lk / 3.6;
      // the car was put somewhere else since the last update (main.js placing it): no pit-wall history
      if (Math.abs(state.x - lastX) > 3 || Math.abs(state.z - lastZ) > 3) pwOk = false;
      eDep = 0; eHar = 0;
      updateSteer(dt, input);
      // sub-step so the car never moves more than ~1 m between wall checks
      var n = Math.ceil((Math.abs(state.speed) + TRACTION * dt) * dt / SUBSTEP_DIST);
      n = clamp(n, 1, 16);
      var h = dt / n;
      for (var i = 0; i < n; i++) {
        stepPhysics(h);
        if (track) resolveTrack(track);
        if (tyres) {
          load.speed = state.speed; load.slip = stepSlip; load.onGrass = state.onGrass; load.hit = state.hit;
          tyres.update(h, load);
          if (tyres.state.puncture >= 0) { punct += h / PUNCT_IN; if (punct > 1) punct = 1; } else punct = 0;
        }
      }
      // attitude follows the surface, lightly smoothed
      var k = 1 - Math.exp(-dt / ATTITUDE_TAU);
      state.pitch += (Math.atan(slopeFwd) - state.pitch) * k;
      state.roll += (Math.atan(slopeLeft) - state.roll) * k;
      // v6 outputs
      state.throttle = thr; state.brake = brk;
      drivetrain(dt);
      state.deploy = ers ? Math.min(1, eDep / (ers.power * dt)) : 0;
      state.harvest = ers ? Math.min(1, eHar / (ers.harvest * dt)) : 0;
      if (!ers) state.battery = 0;
      state.slip = stepSlip;
      state.limiter = limiterOn; state.limitKmh = lk;
      if (!track) state.inPit = false;
      state.vib = tyres ? tyres.state.vib : 0;
      lastX = state.x; lastZ = state.z;
    }

    // Another car (CarSpec, sanitised): its limits, drivetrain and battery. Keeps the battery's charge (0 without ERS).
    function setSpec(spec) {
      K = carPerf(spec);
      car.spec = K.spec; car.perf = K;
      ers = K.spec.ers;
      if (!ers) state.battery = 0;
      state.gear = K.gearFor(state.speed);
      state.rpm = K.rpmFor(state.speed, state.gear);
    }

    // Battery charge 0..1 (main.js: 1 on track load, at the start of qualifying and on the grid); 0 without ERS.
    function setBattery(v) {
      if (typeof v !== 'number' || v !== v) return;
      state.battery = ers ? clamp(v, 0, 1) : 0;
    }

    // A car-to-car impact of strength 0..1 (main.js: the return value of F1.resolveCarCollisions, local detection only -
    // never the impacts other clients report). F1.resolveCarCollisions runs after car.update, whose next call clears
    // state.hit before its tyres ever see it: so the next update (dt > 0) feeds the strongest bump since the last one to
    // the tyres (flat spots / punctures as a wall impact of that strength) and to state.hit. The car's path is unchanged.
    function bump(strength) {
      if (typeof strength !== 'number' || !(strength > 0)) return;
      if (strength > 1) strength = 1;
      if (strength > bumpHit) bumpHit = strength;
    }

    var car = { state: state, reset: reset, update: update, setSpec: setSpec, setBattery: setBattery, bump: bump,
                spec: null, perf: null, tyres: tyres };
    setSpec(spec === undefined || spec === null ? F1.REF_SPEC : spec);
    return car;
  };
})(typeof window !== 'undefined' ? window : globalThis);
