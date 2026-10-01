// F1Drive - car physics (arcade). Pure math: no DOM, no THREE. See js/README-interfaces.md.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // ---- tuning -------------------------------------------------------------
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
  var STEER_LOCK = 0.35;            // rad at standstill
  var STEER_SPEED_REF = 22;         // m/s; lock = STEER_LOCK / (1 + (v/ref)^2)
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

  // bank / pitch in radians (bank > 0: driver's left higher; pitch > 0: nose up), kappaV in 1/m.
  function baseLoad(v, bank, pitch, kappaV) {
    var a = GRAVITY * Math.cos(bank || 0) * Math.cos(pitch || 0) + (DOWNFORCE - (kappaV || 0)) * v * v;
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
    var s = turnSign < 0 ? -1 : 1, sb = Math.sin(bank || 0), cb = Math.cos(bank || 0);
    var A0 = baseLoad(v, bank, pitch, kappaV);
    var den = cb + s * MU_LAT * sb;
    var m1 = den > 0.05 ? (MU_LAT * A0 - s * GRAVITY * sb) / den : Infinity;
    var m2 = (LAT_MAX - s * GRAVITY * sb) / cb;       // tyre saturation cap
    var m = m1 < m2 ? m1 : m2;
    return m > 0 ? m : 0;
  }
  // Longitudinal limits as net accelerations along the direction of travel (m/s^2):
  // they include drag, rolling resistance and the gravity component on the slope.
  function maxAccel(v, bank, pitch, kappaV, latAccel) {
    var an = normalAccel(v, bank, pitch, kappaV, latAccel), av = Math.abs(v);
    return Math.min(TRACTION, MU_TRACTION * an, POWER / Math.max(av, 1)) -
           ROLL - DRAG_K * v * v - GRAVITY * Math.sin(pitch || 0);
  }
  function maxDecel(v, bank, pitch, kappaV, latAccel) {
    var an = normalAccel(v, bank, pitch, kappaV, latAccel);
    return MU_BRAKE * an + BRAKE_DRAG * v * v + ROLL + DRAG_K * v * v + GRAVITY * Math.sin(pitch || 0);
  }

  // Tuning + the load model itself, for other modules (racing line) so they use the same physics.
  F1.CAR_PERF = {
    topSpeed: TOP_SPEED, dragK: DRAG_K, roll: ROLL, traction: TRACTION, power: POWER,
    brakeBase: BRAKE_BASE, brakeAero: BRAKE_AERO, latBase: LAT_BASE, latAero: LAT_AERO, latMax: LAT_MAX,
    gravity: GRAVITY, carHalfWidth: CAR_HALF_WIDTH,
    wheelbase: WHEELBASE, steerLock: STEER_LOCK, steerSpeedRef: STEER_SPEED_REF,
    muLat: MU_LAT, muTraction: MU_TRACTION, muBrake: MU_BRAKE, downforce: DOWNFORCE, brakeDrag: BRAKE_DRAG,
    minNormalAccel: AN_MIN,
    bankGrip: 1 + MU_LAT * MU_LAT,   // legacy linearisation: d(maxLat) ~ bankGrip * g * sin(bank into the turn)
    normalAccel: normalAccel,        // (v, bank, pitch, kappaV, latAccelLeft) -> m/s^2
    maxLatAccel: maxLatAccel,        // (v, bank, pitch, kappaV, turnSign)     -> m/s^2
    maxAccel: maxAccel,              // (v, bank, pitch, kappaV, latAccelLeft) -> net m/s^2 on throttle
    maxDecel: maxDecel               // (v, bank, pitch, kappaV, latAccelLeft) -> net m/s^2 on the brakes
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function num(v, fallback) { return typeof v === 'number' && v === v ? v : fallback; }
  // Pedal position 0..1 from a boolean key and an optional analog value (absent / null / NaN = not
  // supplied); when both are given the larger one wins. A pressed key is exactly 1.
  function pedal(key, analog) {
    var k = key ? 1 : 0;
    if (typeof analog !== 'number' || !(analog > k)) return k;
    return analog < 1 ? analog : 1;
  }

  F1.createCar = function () {
    var state = {
      x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, pitch: 0, roll: 0,
      sampleIndex: 0, d: 0, onGrass: false, hit: 0
    };
    // unsmoothed slope of the surface under the car, along / across the heading (tan of the angle)
    var slopeFwd = 0, slopeLeft = 0;
    // vertical curvature of the road along the direction of travel (1/m, > 0 over a crest): raw / smoothed
    var kappaRaw = 0, kappa = 0;
    // true while the steering is being driven by the analog axis (decides the centring rate once
    // everything is released); never set by keyboard-only input
    var steerAnalog = false;

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

    function stepPhysics(h, input) {
      var v = state.speed;
      var av = Math.abs(v);
      var grass = state.onGrass;
      // pedals 0..1: keys give exactly 1, input.throttle / input.brake (optional) give analog values
      var thr = pedal(input.up, input.throttle), brk = pedal(input.down, input.brake);

      // --- surface under the car ---
      kappa += (kappaRaw - kappa) * (1 - Math.exp(-h / KAPPA_TAU));
      var cp = 1 / Math.sqrt(1 + slopeFwd * slopeFwd), sp = slopeFwd * cp;      // pitch
      var cr = 1 / Math.sqrt(1 + slopeLeft * slopeLeft), sr = slopeLeft * cr;   // roll (left higher > 0)
      var A0 = GRAVITY * cr * cp + (DOWNFORCE - kappa) * v * v;                 // load before cornering
      if (A0 < AN_MIN) A0 = AN_MIN;

      // --- lateral / yaw (bicycle model with grip cap -> understeer) ---
      var resist = ROLL + DRAG_K * av * av;   // magnitude, always opposes motion
      if (grass) resist += GRASS_DRAG_BASE + GRASS_DRAG_LIN * av;
      var ratio = av / STEER_SPEED_REF;
      var delta = state.steer * STEER_LOCK / (1 + ratio * ratio);
      var yaw = v * Math.tan(delta) / WHEELBASE;
      var aLeft = v * yaw;                    // centripetal acceleration asked for, towards the left
      if (aLeft !== 0) {
        var ts = aLeft > 0 ? 1 : -1;
        var den = cr + ts * MU_LAT * sr;
        var m1 = den > 0.05 ? (MU_LAT * A0 - ts * GRAVITY * sr) / den : Infinity;
        var m2 = (LAT_MAX - ts * GRAVITY * sr) / cr;
        var latMax = Math.max(0, Math.min(m1, m2));
        if (grass) latMax *= GRASS_GRIP;
        var latReq = aLeft * ts;
        if (latReq > latMax) {
          yaw *= latMax / latReq;
          aLeft = ts * latMax;
          if (av > 5) resist += Math.min(SCRUB_MAX, latMax > 1e-6 ? SCRUB_GAIN * (latReq / latMax - 1) : SCRUB_MAX);
        }
      }
      var an = A0 - aLeft * sr;               // tyre load incl. the centripetal part
      if (an < AN_MIN) an = AN_MIN;

      // --- longitudinal (traction and braking scale with the tyre load) ---
      var drive = 0;      // signed acceleration
      var traction = grass ? Math.min(TRACTION_GRASS, MU_TRACTION_GRASS * an) : Math.min(TRACTION, MU_TRACTION * an);
      var brake = grass ? Math.min(BRAKE_GRASS, MU_BRAKE_GRASS * an) : MU_BRAKE * an + BRAKE_DRAG * av * av;

      if (v > 0.5) {
        // the brake pedal overrides the throttle in proportion (full brake = no drive, as with the keys)
        if (brk > 0) resist += brake * brk;
        if (thr > 0 && brk < 1) drive = Math.min(traction, POWER / Math.max(av, 1)) * thr * (1 - brk);
      } else if (v < -0.5) {
        if (thr > 0) resist += brake * thr;
        else if (brk > 0 && av < REV_MAX) drive = -Math.min(REV_ACCEL, traction) * brk;
      } else {
        if (thr > 0 && thr >= brk) drive = traction * thr;
        else if (brk > 0) drive = -Math.min(REV_ACCEL, traction) * brk;
      }

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

    function resolveTrack(track) {
      var S = track.samples;
      var loc = track.locate(state.x, state.z, state.sampleIndex);
      var idx = loc.index, d = loc.d;
      var s = S[idx];
      var ad = Math.abs(d);
      var wd = d > 0 ? num(s.wallPosDist, track.wallDist) : num(s.wallNegDist, track.wallDist);
      var hasWall = d > 0 ? s.wallPos : s.wallNeg;
      var hw = num(s.halfW, track.halfWidth);

      // Is the local result believable? If not (far from the located sample, way beyond its wall,
      // or off the road edge where this piece of road has no wall - a crossing), look globally.
      var ex = state.x - s.x, ez = state.z - s.z;
      if (ex * ex + ez * ez > RESYNC_DIST * RESYNC_DIST ||
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

      state.sampleIndex = idx;
      state.d = d;
      state.onGrass = Math.abs(d) > hw;
      surface(track);
    }

    function update(dt, input, track) {
      state.hit = 0;
      if (!(dt > 0)) return;
      if (dt > 0.1) dt = 0.1;
      input = input || {};
      updateSteer(dt, input);
      // sub-step so the car never moves more than ~1 m between wall checks
      var n = Math.ceil((Math.abs(state.speed) + TRACTION * dt) * dt / SUBSTEP_DIST);
      n = clamp(n, 1, 16);
      var h = dt / n;
      for (var i = 0; i < n; i++) {
        stepPhysics(h, input);
        if (track) resolveTrack(track);
      }
      // attitude follows the surface, lightly smoothed
      var k = 1 - Math.exp(-dt / ATTITUDE_TAU);
      state.pitch += (Math.atan(slopeFwd) - state.pitch) * k;
      state.roll += (Math.atan(slopeLeft) - state.roll) * k;
    }

    return { state: state, reset: reset, update: update };
  };
})(typeof window !== 'undefined' ? window : globalThis);
