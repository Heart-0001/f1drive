const fs=require('fs');const F='C:/Users/user/Desktop/f1drive/js/car.js';let s=fs.readFileSync(F,'utf8');
function rep(a,b){ if(!s.includes(a)) throw new Error('missing: '+a.slice(0,70)); s=s.replace(a,()=>b); }
// constants
rep(`  var GRAVITY = 9.81;               // slope: accel along the direction of travel = -g * sin(pitch)
  var BANK_GRIP = 2.0;              // lateral grip change = BANK_GRIP * g * sin(bank into the turn), m/s^2
  var ATTITUDE_TAU = 0.07;          // s, smoothing of pitch / roll
`,
`  var GRAVITY = 9.81;
  var ATTITUDE_TAU = 0.07;          // s, smoothing of pitch / roll
  var KAPPA_TAU = 0.06;             // s, smoothing of the road's vertical curvature under the car

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
`);
const p0=s.indexOf("  // Read-only copy of the performance constants"), p1=s.indexOf("  function clamp(v, lo, hi)");
s=s.slice(0,p0)+`  // Tuning + the load model itself, for other modules (racing line) so they use the same physics.
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

`+s.slice(p1);
rep("    var slopeFwd = 0, slopeLeft = 0;", "    var slopeFwd = 0, slopeLeft = 0;\n    // vertical curvature of the road along the direction of travel (1/m, > 0 over a crest): raw / smoothed\n    var kappaRaw = 0, kappa = 0;");
rep("      if (!a || typeof a.y !== 'number') { state.y = 0; slopeFwd = 0; slopeLeft = 0; return; }",
    "      if (!a || typeof a.y !== 'number') { state.y = 0; slopeFwd = 0; slopeLeft = 0; kappaRaw = 0; return; }");
rep("      slopeLeft = -g * fn + tanB * ft;                      // left = (ch, -sh) = -fn * t + ft * n",
`      slopeLeft = -g * fn + tanB * ft;                      // left = (ch, -sh) = -fn * t + ft * n
      // vertical curvature from the second difference of the height profile
      var p = S[(i - 1 + n) % n], q = S[(i + 1) % n], k0 = 0;
      var gp = Math.hypot(a.x - p.x, a.z - p.z), gq = Math.hypot(q.x - a.x, q.z - a.z);
      if (gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10 && typeof p.y === 'number' && typeof q.y === 'number') {
        k0 = -((q.y - a.y) / gq - (a.y - p.y) / gp) / (0.5 * (gp + gq));
      }
      kappaRaw = k0 * ft * ft;`);
rep("      state.pitch = Math.atan(slopeFwd);\n      state.roll = Math.atan(slopeLeft);\n    }", "      state.pitch = Math.atan(slopeFwd);\n      state.roll = Math.atan(slopeLeft);\n      kappa = kappaRaw;\n    }");
// physics body
const a0=s.indexOf("      // --- longitudinal ---"), a1=s.indexOf("      // --- integrate speed ---");
s=s.slice(0,a0)+`      // --- surface under the car ---
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
        if (down) resist += brake;
        else if (up) drive = Math.min(traction, POWER / Math.max(av, 1));
      } else if (v < -0.5) {
        if (up) resist += brake;
        else if (down && av < REV_MAX) drive = -Math.min(REV_ACCEL, traction);
      } else {
        if (up) drive = traction;
        else if (down) drive = -Math.min(REV_ACCEL, traction);
      }

      // slope: gravity along the heading (speed is signed along the heading, so this is too)
      var grav = -GRAVITY * sp;
      var hold = !up && !down && av < 0.3;    // parked on a hill: the brakes hold it

`+s.slice(a1);
fs.writeFileSync(F,s);
console.log('patched');
