// F1Drive - tyres (F1.createTyres): wear, flat spots, temperature, dirt and punctures of the four tyres, and the grip
// multipliers js/car.js applies to its lateral grip, braking and traction. See js/README-interfaces.md ("js/tyres.js").
// Pure logic: no DOM, no THREE; update() allocates nothing; the only randomness is the injected random() (fit() draws
// four numbers, an impact one or two), so a run is reproducible. Loadable in node: require('./js/tyres.js') ->
// F1.Tyres = { createTyres, nextCompound, ORDER, NAMES, COLOURS, COMPOUNDS, ... }. Tests: test/tyres.test.js;
// calibration against the real cars on the 40 circuits: devtests/tyre-test (README.md there has the tables).
//
// Wheels are indexed FL, FR, RL, RR (0..3). car.js calls update(dt, load) every physics step with the share of the
// grip the car is using; load.lat > 0 is a LEFT-hand turn, which loads the RIGHT-hand (outside) tyres.
//
// Work. What wears and heats a tyre is the energy it dissipates, friction force x slip speed. The slip speed grows
// with the share of the grip in use, so each way of loading the tyres costs
//     P = u^2 * a(v) * v        (m^2/s^3 per kg of car)
// u = share of that grip in use, a(v) = the most the reference car can do that way at speed v (cornering and braking
// grow with downforce; traction is capped by the drivetrain, so at speed full throttle uses only part of the rear
// tyres' friction). Cornering work goes LAT_FRONT to the front axle and LAT_OUT of each axle to the outside tyre,
// braking BRAKE_FRONT to the fronts, traction to the rears only. Sliding (load.slip > 0) adds
//     P_slide = slip * a_lat(v) * v * SLIDE_WORK
// on the tyres that slide (the car.js model runs out of grip at the front when cornering, locks the fronts on the
// brakes, spins the rears on the throttle); every tyre also has a little rolling work (ROLL_WORK * v) and the grass
// scrubs all four (GRASS_SCRUB * v). On the grass the forces are the grass's (GRASS_GRIP of the asphalt ones).
//
// Wear.         raw[i] += rate * compound.wear * WEAR_K * work * (front ? FRONT_RUBBER : 1) * (1 + overheat / HOT_WEAR) * dt
//   wear = min(1, raw). Calibrated (2026-10-02, devtests/tyre-test) to real stint lengths: the real cars of 2010, 2014,
//   2023 and 2026 (js/car.js with this file, 1/120 s) driven on all 40 circuits from a standing start until a tyre is
//   worn through. On the racing line at full pace (the seasons calibration's keyboard driver: every brake and throttle
//   100 %) the 2023 Red Bull reaches the cliff (75 %) after 14.5 laps of Spa on softs, 23.6 on mediums, 33 on hards
//   (real Spa stints: softs 12..18, mediums 20..30); over the 40 circuits after ~90 / ~150 / ~210 km (soft / medium /
//   hard: 18 / 29 / 41 laps of 5 km; per km a set lasts longest at Monza, Las Vegas, Baku and Mexico, shortest at
//   Jacarepagua, Zandvoort, Losail and Buenos Aires: 114..193 km for a medium). A human-like keyboard driver (late
//   braking, kerbs, slides) wears a set ~10 % faster, the gentle analog autopilot (4 % off the pace) ~1.45 x slower.
//   The work is weighed with the reference car's limits, so a car with less grip at its limit is charged a little
//   more: the 2026 cars have ~20 % shorter stints, 2014 ~7 %.
//   Front- and rear-limited tracks come out about half and half. The wear rate scales it exactly (x2: half the km).
//   (Before 2026-10-02: WEAR_K 3.9e-6, soft 2.0, hard 0.5 - a medium set lasted 15 laps of 5 km, and a soft at Spa
//   wore through and punctured after ~4 laps on the racing line, ~2.4 for a keyboard driver who slides: the report
//   "RB19 at Spa, x1, a puncture halfway through lap 2, I hit nothing", test/tyres.test.js "the user's case".)
//   Grip loss:  A * max(0, w - W0)^P                        0 up to W0 = 20 %, 0.8 % at 50 %, 4 % at 75 %
//               + CLIFF * max(0, (w - 0.75) / 0.25)^3       the cliff: ~12 % at 90 %, ~31 % at 100 %
//   A tyre run past 100 % punctures once raw reaches its carcass life (1.03..1.12, drawn when the set is fitted: 3..12 %
//   of its life later); past 95 % it starts to shake a little. Nothing else punctures a tyre but an impact (below).
// Temperature.  dT/dt = H_WORK * work + H_SLIDE * slide - (T - T_REST) * (COOL_0 + COOL_V * v)
//   Hard racing keeps the tyres at 90..~99 deg C, inside every compound's window; sustained sliding overheats them
//   (6 s of heavy understeer: the outside front near 130 deg C). Above compound.hot the tyre loses
//   HEAT_MAX * (1 - exp(-(over / HEAT_SCALE)^2)) and wears faster; it cools back in the airflow in 5..10 s.
//   There are no cold tyres: a set is fitted at T_REST (blankets) and never cools below it, so standing on the grid
//   or in the pit lane changes nothing.
// Dirt.         The grass picks it up (DIRT_UP per s at speed); on asphalt it wears off with distance:
//   d(dirt)/ds = -(dirt / DIRT_LEN + DIRT_LIN) -> clean after ~150 m (3..4 s at 45 m/s). Loss DIRT_LOSS * dirt.
// Flat spots.   A lock-up - heavy sliding (slip > FLAT_SLIP) with the brake on - grows them on the sliding tyres, in
//   proportion to the brake; a slide without the brakes (understeer, a power slide) leaves none (since 2026-10-02:
//   before, a keyboard driver's throttle-on slides flat-spotted all four tyres within a real-length stint). A hard
//   impact (hit > HIT_FLAT) puts one on a random tyre (the fronts more likely). They never heal: vibration growing
//   with speed and FLAT_BRAKE * flat less braking grip on that tyre.
// Punctures.    Worn through (above), or a very heavy impact: chance PUNCT_HIT_P * (hit - HIT_PUNCT) / (1 - HIT_PUNCT)
//   on the tyre that took the hit. The tyre deflates over DEFLATE_T s to PUNCT_LOSS less grip; strong vibration;
//   only fit() (a pit stop) cures it. One puncture at a time.
// Car multipliers (per tyre g = product of (1 - loss) of wear, heat, dirt, puncture; for braking also the flat spot):
//   lateral   the loaded side counts most: side weight 0.5 +- SIDE_W (full at |lat| >= SIDE_SAT), per axle; then
//             LAT_WORST * worse axle + (1 - LAT_WORST) * mean of the axles
//   brake     BRAKE_FRONT_GRIP * front axle + the rest * rear axle
//   traction  rears: half the worse one, half the mean
//   times compound.grip. Everything is continuous in time (impact flat spots are phased in over ~0.2 s, a puncture
//   deflates over DEFLATE_T), and a new, clean medium set in its window gives exactly 1 / 1 / 1: every loss is
//   exactly 0, and the first 20 % of wear (~10 hard laps of 5 km on medium at rate 1) costs nothing at all.
// setWearRate(0) freezes the state completely (wear, flat spots, punctures, temperature, dirt): the reference car.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var FL = 0, FR = 1, RL = 2, RR = 3;

  // ---- compounds ------------------------------------------------------------
  // grip: multiplier on all three; wear: multiplier on the wear rate (a real soft lasts ~0.6 x a medium's stint, a
  // hard ~1.4 x: Pirelli's neighbouring compounds; 2.0 / 0.5 until 2026-10-02); hot: top of the working window (deg C)
  var COMPOUNDS = {
    S: { grip: 1.015, wear: 1.65, hot: 105 },
    M: { grip: 1,     wear: 1,    hot: 110 },
    H: { grip: 0.985, wear: 0.7,  hot: 115 }
  };
  var ORDER = ['S', 'M', 'H'];
  var NAMES = { S: '軟胎', M: '中性胎', H: '硬胎' };
  var COLOURS = { S: '#e8002d', M: '#ffd12e', H: '#f0f0ec' };   // sidewall bands: red / yellow / white

  // ---- the reference car's limits (js/car.js on a flat road): they only weigh the work of the tyres ----------
  var LAT_BASE = 20.0, LAT_AERO = 0.0045, LAT_MAX = 44.0;
  var BRAKE_BASE = 12.0, BRAKE_AERO = 0.0032;
  var TRACTION = 11.0, GRAVITY = 9.81;
  var MU_TRACTION = TRACTION / GRAVITY, DOWNFORCE = LAT_AERO / (LAT_BASE / GRAVITY);

  // ---- work -------------------------------------------------------------------
  var LAT_FRONT = 0.55;             // share of the cornering work on the front axle
  var LAT_OUT = 0.72;               // share of an axle's cornering work on the outside tyre
  var BRAKE_FRONT = 0.64;           // share of the braking work on the front axle
  var SLIDE_WORK = 4.0;             // a sliding tyre (slip 1) works this many times harder than one at the limit
  var SLIDE_FRONT_LAT = 0.7;        // front share of the sliding: cornering (car.js understeers) ...
  var SLIDE_FRONT_BRAKE = 0.8;      //   ... braking (the fronts lock) ...
  var SLIDE_FRONT_DRIVE = 0.1;      //   ... throttle (the rears spin)
  var FRONT_RUBBER = 1.55;          // the fronts are narrower (305 vs 405 mm) and steered: the same work wears them faster
  var ROLL_WORK = 0.25;             // m/s^2 equivalent: rolling, every tyre
  var GRASS_SCRUB = 12.0;           // m/s^2 equivalent: the grass scrubs every tyre
  var GRASS_GRIP = 0.45;            // car.js: the forces on the grass are this share of the asphalt ones

  // ---- wear -------------------------------------------------------------------
  var WEAR_K = 1.0e-6;              // wear per unit of work (calibrated to real stint lengths: devtests/tyre-test)
  var W0 = 0.20;                    // no grip loss below this wear
  var W50 = 0.008, W75 = 0.04;      // grip loss at 50 % and 75 % wear
  var WP = Math.log(W75 / W50) / Math.log((0.75 - W0) / (0.5 - W0));   // 2.66
  var WA = W50 / Math.pow(0.5 - W0, WP);
  var CLIFF = 0.20;                 // extra loss at 100 % wear (cubic from 75 %)
  var LIFE_MIN = 1.03, LIFE_SPAN = 0.09;   // carcass life in raw wear: 1.03..1.12
  var HOT_WEAR = 25;                // deg C over the window that doubles the wear

  // ---- temperature ------------------------------------------------------------
  var T_REST = 90;                  // deg C: fitted at this, settles back to it
  var T_MAX = 160;
  var H_WORK = 0.006;               // deg C per unit of work
  var H_SLIDE = 0.012;              // deg C per unit of sliding work
  var COOL_0 = 0.12, COOL_V = 0.005;   // 1/s: cooling towards T_REST, grows with the airflow
  var HEAT_MAX = 0.15, HEAT_SCALE = 25;

  // ---- dirt -------------------------------------------------------------------
  var DIRT_UP = 1.5;                // 1/s on the grass at 20 m/s and more
  var DIRT_LEN = 70, DIRT_LIN = 0.002;   // m, 1/m: cleaning on asphalt
  var DIRT_LOSS = 0.12;

  // ---- flat spots, impacts, punctures -------------------------------------------
  var FLAT_SLIP = 0.4;              // sliding above this leaves flat spots
  var FLAT_RATE = 0.4;              // 1/s at slip 1 on the most-sliding tyre, braking (lock-up)
  var FLAT_LAT = 0;                 //   share of that without the brakes: none, only lock-ups (0.2 until 2026-10-02)
  var FLAT_IN = 1.5;                // 1/s: how fast an impact's flat spot is phased in
  var FLAT_BRAKE = 0.06;            // braking grip lost on a tyre with a full flat spot
  var HIT_FLAT = 0.2, HIT_FLAT_GAIN = 0.8;   // impact -> flat spot (hit - HIT_FLAT) * gain
  var HIT_NEW = 0.05;               // an impact counts as new when it is this much above the last one ...
  var HIT_DECAY = 2.0;              //   ... which fades at this rate (1/s)
  var HIT_PUNCT = 0.4, PUNCT_HIT_P = 0.8;
  var PUNCT_LOSS = 0.65;            // grip lost on a flat tyre
  var DEFLATE_T = 0.5;              // s

  // ---- car multipliers, vibration -------------------------------------------------
  var SIDE_W = 0.25, SIDE_SAT = 0.5;
  var LAT_WORST = 0.6;
  var BRAKE_FRONT_GRIP = 0.62;
  var VIB_V = 70;                   // m/s: vibration grows with speed up to here
  var VIB_FLAT = 0.8, VIB_FLAT_MORE = 0.25, VIB_DIRT = 0.1;
  var VIB_WORN = 0.15, WORN_VIB = 0.95;    // a tyre worn past 95 % shakes a little (a puncture is coming)
  var VIB_PUNCT_0 = 0.35, VIB_PUNCT_V = 0.55;
  var V_CAP = 150;                  // m/s: sanity cap on the speed fed in
  var DT_MAX = 0.1;

  function num(v) { return typeof v === 'number' && v - v === 0 ? v : 0; }   // finite number, else 0
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function wearLoss(w) {
    if (!(w > W0)) return 0;
    if (w > 1) w = 1;
    var l = WA * Math.pow(w - W0, WP);
    if (w > 0.75) { var c = (w - 0.75) / 0.25; l += CLIFF * c * c * c; }
    return l;
  }
  function heatLoss(over) {
    if (!(over > 0)) return 0;
    var x = over / HEAT_SCALE;
    return HEAT_MAX * (1 - Math.exp(-x * x));
  }
  function compoundOf(c) {
    var k = typeof c === 'string' && c.length ? c.charAt(0).toUpperCase() : '';
    return COMPOUNDS.hasOwnProperty(k) ? k : 'M';
  }

  function createTyres(opts) {
    var random = opts && typeof opts.random === 'function' ? opts.random : Math.random;
    var state = {
      compound: 'M',
      wear: [0, 0, 0, 0],
      flat: [0, 0, 0, 0],
      temp: [T_REST, T_REST, T_REST, T_REST],
      dirt: 0,
      puncture: -1,
      grip: { lat: 1, brake: 1, traction: 1 },
      vib: 0
    };
    var comp = COMPOUNDS.M;
    var rate = 1;
    // Internal numbers live in typed arrays: V8 boxes a double passed to a function it does not inline, or stored
    // in a closure variable, into a new heap object; typed-array elements (and number fields of state, and plain
    // arrays holding only numbers) are written in place. So update() and its helpers allocate nothing.
    var raw = new Float64Array(4);  // wear, not capped at 1
    var life = new Float64Array(4); // raw wear at which a worn-out tyre punctures
    var pend = new Float64Array(4); // flat spots still to be phased in (FLAT_IN per s)
    var work = new Float64Array(4), slide = new Float64Array(4);   // this step
    var lossL = new Float64Array(4), lossB = new Float64Array(4);
    var io = new Float64Array(9);   // this step's input and the scalars that change every step
    var DT = 0, V = 1, LAT = 2, BRK = 3, DRV = 4, SLIP = 5, HIT = 6, DEFL = 7, PEAK = 8;   // DEFL: deflation 0..1

    function rnd() {
      var r = random();
      return typeof r === 'number' && r >= 0 && r < 1 ? r : 0.5;
    }

    function output() {
      var i, v = io[V], lat = io[LAT], deflate = io[DEFL], dl = 1 - DIRT_LOSS * state.dirt, flat = state.flat, temp = state.temp;
      for (i = 0; i < 4; i++) {
        var g = (1 - wearLoss(raw[i])) * (1 - heatLoss(temp[i] - comp.hot)) * dl;
        if (i === state.puncture) g *= 1 - PUNCT_LOSS * deflate;
        lossL[i] = 1 - g;
        lossB[i] = 1 - g * (1 - FLAT_BRAKE * flat[i]);
      }
      var wr = 0.5 + SIDE_W * clamp(lat / SIDE_SAT, -1, 1);    // weight of the right-hand tyres
      var lf = (1 - wr) * lossL[FL] + wr * lossL[FR], lr = (1 - wr) * lossL[RL] + wr * lossL[RR];
      var latLoss = LAT_WORST * (lf > lr ? lf : lr) + (1 - LAT_WORST) * 0.5 * (lf + lr);
      var brakeLoss = BRAKE_FRONT_GRIP * 0.5 * (lossB[FL] + lossB[FR]) + (1 - BRAKE_FRONT_GRIP) * 0.5 * (lossB[RL] + lossB[RR]);
      var tracLoss = 0.5 * (lossL[RL] > lossL[RR] ? lossL[RL] : lossL[RR]) + 0.25 * (lossL[RL] + lossL[RR]);
      state.grip.lat = comp.grip * (1 - latLoss);
      state.grip.brake = comp.grip * (1 - brakeLoss);
      state.grip.traction = comp.grip * (1 - tracLoss);

      var sp = v / VIB_V, fm = 0, fs = 0, wm = 0;
      if (sp > 1) sp = 1;
      for (i = 0; i < 4; i++) { fs += flat[i]; if (flat[i] > fm) fm = flat[i]; if (raw[i] > wm) wm = raw[i]; }
      wm = wm > WORN_VIB ? (wm < 1 ? (wm - WORN_VIB) / (1 - WORN_VIB) : 1) : 0;   // the cords are showing
      var vb = (VIB_FLAT * fm + VIB_FLAT_MORE * (fs - fm) + VIB_DIRT * state.dirt + VIB_WORN * wm) * sp;
      if (state.puncture >= 0) vb += deflate * (VIB_PUNCT_0 + VIB_PUNCT_V * sp);
      state.vib = vb > 1 ? 1 : vb;
    }

    function fit(compound) {
      var c = compoundOf(compound);
      state.compound = c;
      comp = COMPOUNDS[c];
      for (var i = 0; i < 4; i++) {
        raw[i] = 0; state.wear[i] = 0; state.flat[i] = 0; pend[i] = 0; state.temp[i] = T_REST;
        life[i] = LIFE_MIN + LIFE_SPAN * rnd();
      }
      state.dirt = 0;
      state.puncture = -1;
      io[DEFL] = 0; io[PEAK] = 0; io[V] = 0; io[LAT] = 0;
      output();
    }

    function setWearRate(mult) {
      rate = typeof mult === 'number' && mult - mult === 0 ? clamp(mult, 0, 5) : 1;
      tyres.wearRate = rate;
    }

    function evolve(grass) {
      var i, flat = state.flat, temp = state.temp;
      var dt = io[DT], v = io[V], lat = io[LAT], brk = io[BRK], drv = io[DRV], slip = io[SLIP], hit = io[HIT], hitPeak = io[PEAK];
      var ul = lat < 0 ? -lat : lat;
      var surf = grass ? GRASS_GRIP : 1;
      var aLat = LAT_BASE + LAT_AERO * v * v;
      if (aLat > LAT_MAX) aLat = LAT_MAX;
      var aBrk = BRAKE_BASE + BRAKE_AERO * v * v;
      var aFric = MU_TRACTION * (GRAVITY + DOWNFORCE * v * v);   // what the rear tyres could transmit
      var ud = aFric > TRACTION ? drv * TRACTION / aFric : drv;   // share of that full throttle uses
      var pLat = ul * ul * aLat * v * surf;
      var pBrk = brk * brk * aBrk * v * surf;
      var pDrv = ud * ud * aFric * v * surf;
      var wr = lat > 0 ? LAT_OUT : (lat < 0 ? 1 - LAT_OUT : 0.5);  // right-hand share (left turn: right is outside)
      var latF = pLat * LAT_FRONT, latR = pLat - latF, brkF = pBrk * BRAKE_FRONT, brkR = pBrk - brkF;
      work[FL] = latF * (1 - wr) + brkF * 0.5;
      work[FR] = latF * wr + brkF * 0.5;
      work[RL] = latR * (1 - wr) + brkR * 0.5 + pDrv * 0.5;
      work[RR] = latR * wr + brkR * 0.5 + pDrv * 0.5;

      // sliding: which tyres slide depends on what the car is doing
      var mix = ul + brk + drv;
      var fs = mix > 0 ? (ul * SLIDE_FRONT_LAT + brk * SLIDE_FRONT_BRAKE + drv * SLIDE_FRONT_DRIVE) / mix : 0.5;
      var pSl = slip * aLat * v * surf * SLIDE_WORK;
      slide[FL] = pSl * fs * (1 - wr);
      slide[FR] = pSl * fs * wr;
      slide[RL] = pSl * (1 - fs) * (1 - wr);
      slide[RR] = pSl * (1 - fs) * wr;

      // flat spots from heavy sliding, on the sliding tyres (most on the one sliding most)
      if (slip > FLAT_SLIP && v > 5) {
        var smax = 0;
        for (i = 0; i < 4; i++) if (slide[i] > smax) smax = slide[i];
        var g = FLAT_RATE * (slip - FLAT_SLIP) / (1 - FLAT_SLIP) * (FLAT_LAT + (1 - FLAT_LAT) * brk) *
                (v < 30 ? v / 30 : 1) * dt / smax;
        for (i = 0; i < 4; i++) pend[i] += g * slide[i];
      }

      // impacts: a new one (clearly harder than the last, which fades) -> flat spot, maybe a puncture
      hitPeak -= HIT_DECAY * dt;
      if (hitPeak < 0) hitPeak = 0;
      if (hit > HIT_FLAT && hit > hitPeak + HIT_NEW) {
        var r = rnd(), w = r < 0.35 ? FL : (r < 0.7 ? FR : (r < 0.85 ? RL : RR));   // the fronts are the most exposed
        pend[w] += (hit - (hitPeak > HIT_FLAT ? hitPeak : HIT_FLAT)) * HIT_FLAT_GAIN;
        var p = PUNCT_HIT_P * (hit - HIT_PUNCT) / (1 - HIT_PUNCT);
        if (p > 0 && state.puncture < 0 && rnd() < p) state.puncture = w;
        hitPeak = hit;
      } else if (hit > hitPeak) {
        hitPeak = hit;
      }
      io[PEAK] = hitPeak;

      // wear, temperature, flat spots phased in
      var kw = rate * comp.wear * WEAR_K * dt;
      var roll = (ROLL_WORK + (grass ? GRASS_SCRUB : 0)) * v;
      var keep = Math.exp(-(COOL_0 + COOL_V * v) * dt);
      for (i = 0; i < 4; i++) {
        var over = temp[i] - comp.hot;
        raw[i] += kw * (work[i] + slide[i] + roll) * (i < RL ? FRONT_RUBBER : 1) * (over > 0 ? 1 + over / HOT_WEAR : 1);
        if (raw[i] >= life[i] && state.puncture < 0) state.puncture = i;
        state.wear[i] = raw[i] < 1 ? raw[i] : 1;
        var t = T_REST + (temp[i] - T_REST) * keep + (H_WORK * work[i] + H_SLIDE * slide[i]) * dt;
        temp[i] = t < T_MAX ? t : T_MAX;
        if (pend[i] > 0) {
          var m = FLAT_IN * dt;
          if (m > pend[i]) m = pend[i];
          pend[i] -= m;
          flat[i] = flat[i] + m < 1 ? flat[i] + m : 1;
        }
      }

      // dirt
      if (grass) {
        state.dirt += DIRT_UP * (v < 20 ? v / 20 : 1) * dt;
        if (state.dirt > 1) state.dirt = 1;
      } else if (state.dirt > 0) {
        state.dirt -= (state.dirt / DIRT_LEN + DIRT_LIN) * v * dt;
        if (state.dirt < 0) state.dirt = 0;
      }

      if (state.puncture >= 0 && io[DEFL] < 1) {
        io[DEFL] += dt / DEFLATE_T;
        if (io[DEFL] > 1) io[DEFL] = 1;
      }
    }

    function update(dt, load) {
      if (typeof dt !== 'number' || !(dt > 0)) return;
      io[DT] = dt > DT_MAX ? DT_MAX : dt;
      io[V] = 0; io[LAT] = 0;
      if (load && typeof load === 'object') {
        var v = num(load.speed);
        if (v < 0) v = -v;
        io[V] = v > V_CAP ? V_CAP : v;
        io[LAT] = clamp(num(load.lat), -1, 1);
        if (rate > 0) {
          io[BRK] = clamp(num(load.brake), 0, 1); io[DRV] = clamp(num(load.drive), 0, 1);
          io[SLIP] = clamp(num(load.slip), 0, 1); io[HIT] = clamp(num(load.hit), 0, 1);
          evolve(load.onGrass === true || load.onGrass === 1);
        }
      }
      output();
    }

    var tyres = {
      state: state,
      wearRate: 1,
      fit: fit,
      setWearRate: setWearRate,
      update: update
    };
    fit('M');
    return tyres;
  }

  // the next compound in the S -> M -> H -> S cycle (key T)
  function nextCompound(c) { return ORDER[(ORDER.indexOf(compoundOf(c)) + 1) % ORDER.length]; }

  var exported = {
    createTyres: createTyres, nextCompound: nextCompound, compoundOf: compoundOf,
    ORDER: ORDER, NAMES: NAMES, COLOURS: COLOURS, COMPOUNDS: COMPOUNDS, T_REST: T_REST,
    wearLoss: wearLoss, heatLoss: heatLoss
  };
  F1.createTyres = createTyres;
  F1.Tyres = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : globalThis);
