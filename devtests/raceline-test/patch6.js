const fs=require('fs'),f='C:/Users/user/Desktop/f1drive/js/raceline.js';let s=fs.readFileSync(f,'utf8');
function rep(o,n){ if(!s.includes(o)) throw new Error('missing: '+o.slice(0,70)); s=s.replace(o,n); }
function cut(a,b,n){ const i=s.indexOf(a), j=s.indexOf(b); if(i<0||j<0||j<i) throw new Error('cut '+a.slice(0,50)); s=s.slice(0,i)+n+s.slice(j); }

// ---- header: constants + load model
cut("  // ---- car model constants", "  // ---- line / safety tuning ----", `  // ---- car model: fallback copies of js/car.js. F1.CAR_PERF (published by car.js) overrides them,
  //      and its load-model helpers are used directly when present, so the line shares the car's physics.
  var KMH = 1 / 3.6;
  var TOP_SPEED = 330 * KMH;
  var DRAG_K = 0.0012;
  var ROLL = 0.5;
  var TRACTION = 11.0;
  var POWER = (DRAG_K * TOP_SPEED * TOP_SPEED + ROLL) * TOP_SPEED;
  var WHEELBASE = 3.6;
  var STEER_LOCK = 0.35;
  var STEER_SPEED_REF = 22;
  var LAT_MAX = 44.0;
  var GRAV = 9.81;
  var MU_LAT = 20 / GRAV, MU_TRACTION = 11 / GRAV, MU_BRAKE = 12 / GRAV;
  var DOWNFORCE = 0.0045 / MU_LAT;
  var BRAKE_DRAG = 0.0032 - MU_BRAKE * DOWNFORCE;
  var AN_MIN = 2.0;

  // bank > 0: driver's left higher; pitch > 0: nose up; kappaV > 0 over a crest; latAccel towards the left.
  function fbBaseLoad(v, bank, pitch, kappaV) {
    var a = GRAV * Math.cos(bank) * Math.cos(pitch) + (DOWNFORCE - kappaV) * v * v;
    return a > AN_MIN ? a : AN_MIN;
  }
  function fbNormal(v, bank, pitch, kappaV, latAccel) {
    var a = fbBaseLoad(v, bank, pitch, kappaV) - latAccel * Math.sin(bank);
    return a > AN_MIN ? a : AN_MIN;
  }
  function fbMaxLat(v, bank, pitch, kappaV, turnSign) {
    var sg = turnSign < 0 ? -1 : 1, sb = Math.sin(bank), cb = Math.cos(bank);
    var den = cb + sg * MU_LAT * sb;
    var m1 = den > 0.05 ? (MU_LAT * fbBaseLoad(v, bank, pitch, kappaV) - sg * GRAV * sb) / den : Infinity;
    var m2 = (LAT_MAX - sg * GRAV * sb) / cb;
    var m = m1 < m2 ? m1 : m2;
    return m > 0 ? m : 0;
  }
  function fbMaxAccel(v, bank, pitch, kappaV, latAccel) {
    return Math.min(TRACTION, MU_TRACTION * fbNormal(v, bank, pitch, kappaV, latAccel), POWER / Math.max(v, 1)) -
           ROLL - DRAG_K * v * v - GRAV * Math.sin(pitch);
  }
  function fbMaxDecel(v, bank, pitch, kappaV, latAccel) {
    return MU_BRAKE * fbNormal(v, bank, pitch, kappaV, latAccel) + BRAKE_DRAG * v * v + ROLL + DRAG_K * v * v +
           GRAV * Math.sin(pitch);
  }
  var maxLatAccel = fbMaxLat, maxAccel = fbMaxAccel, maxDecel = fbMaxDecel;

  function syncCarPerf() {
    var p = F1.CAR_PERF;
    maxLatAccel = fbMaxLat; maxAccel = fbMaxAccel; maxDecel = fbMaxDecel;
    if (!p) return;
    function pick(v, fb) { return typeof v === 'number' && v === v ? v : fb; }
    TOP_SPEED = pick(p.topSpeed, TOP_SPEED); DRAG_K = pick(p.dragK, DRAG_K); ROLL = pick(p.roll, ROLL);
    TRACTION = pick(p.traction, TRACTION); POWER = pick(p.power, POWER); LAT_MAX = pick(p.latMax, LAT_MAX);
    GRAV = pick(p.gravity, GRAV);
    WHEELBASE = pick(p.wheelbase, WHEELBASE); STEER_LOCK = pick(p.steerLock, STEER_LOCK);
    STEER_SPEED_REF = pick(p.steerSpeedRef, STEER_SPEED_REF);
    MU_LAT = pick(p.muLat, MU_LAT); MU_TRACTION = pick(p.muTraction, MU_TRACTION); MU_BRAKE = pick(p.muBrake, MU_BRAKE);
    DOWNFORCE = pick(p.downforce, DOWNFORCE); BRAKE_DRAG = pick(p.brakeDrag, BRAKE_DRAG);
    AN_MIN = pick(p.minNormalAccel, AN_MIN);
    if (typeof p.maxLatAccel === 'function' && typeof p.maxAccel === 'function' && typeof p.maxDecel === 'function') {
      maxLatAccel = p.maxLatAccel; maxAccel = p.maxAccel; maxDecel = p.maxDecel;
    }
  }

`);
rep("  var SLOPE_MARGIN = 1.0;     // slope (gravity) term as implemented in car.js, see longSlope()\n","  var CREST_SPAN = 3;         // samples each side: the worst crest nearby is assumed for the profile\n");
cut("  function accelAt(v) {", "  function makeChevronTexture", `  // Highest speed at which the car can follow curvature k (1/m) at a point with the given surface, with margins.
  // turnSign: +1 = left. Solved against the car's load model (grip depends on speed, bank, crest).
  function cornerSpeed(k, bank, pitch, kappaV, turnSign) {
    k = Math.abs(k);
    if (k < 1e-6) return TOP_SPEED;
    var v = TOP_SPEED;
    if (GRIP_MARGIN * maxLatAccel(v, bank, pitch, kappaV, turnSign) < v * v * k) {
      var lo = MIN_SPEED, hi = TOP_SPEED, it, mid;
      if (GRIP_MARGIN * maxLatAccel(lo, bank, pitch, kappaV, turnSign) < lo * lo * k) v = lo;
      else {
        for (it = 0; it < 18; it++) {
          mid = 0.5 * (lo + hi);
          if (GRIP_MARGIN * maxLatAccel(mid, bank, pitch, kappaV, turnSign) >= mid * mid * k) lo = mid; else hi = mid;
        }
        v = lo;
      }
    }
    // steering lock: tan(STEER_LOCK / (1 + (v/ref)^2)) / WHEELBASE >= k * margin
    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);
    if (x >= STEER_LOCK) v = MIN_SPEED;
    else v = Math.min(v, STEER_SPEED_REF * Math.sqrt(STEER_LOCK / x - 1));
    return Math.max(MIN_SPEED, Math.min(TOP_SPEED, v));
  }

`);

// ---- speed profile
cut("    // ---- speed profile", "    var lapTime = 0;", `    // ---- surface along the line, as the car feels it
    //   pitch from the line's own height profile; vertical curvature from the centreline heights
    //   (exactly what car.js does), > 0 over a crest; bank from the sample.
    var bankA = new Float64Array(N), pitchA = new Float64Array(N), gsin = new Float64Array(N);
    var kv = new Float64Array(N), kvSafe = new Float64Array(N), latSign = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var sp = S[(i - 1 + N) % N], sc = S[i], sq = S[(i + 1) % N];
      var gp = Math.hypot(sc.x - sp.x, sc.z - sp.z), gq = Math.hypot(sq.x - sc.x, sq.z - sc.z), k0 = 0;
      if (typeof sc.y === 'number' && typeof sp.y === 'number' && typeof sq.y === 'number' &&
          gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10) {
        k0 = -((sq.y - sc.y) / gq - (sc.y - sp.y) / gp) / (0.5 * (gp + gq));
      }
      kv[i] = isFinite(k0) ? k0 : 0;
      bankA[i] = +sc.bank || 0;
      pitchA[i] = Math.asin(slope[i]);
      gsin[i] = GRAV * slope[i];
    }
    for (i = 0; i < N; i++) {
      var km = kv[i];
      for (j = -CREST_SPAN; j <= CREST_SPAN; j++) { var kq = kv[((i + j) % N + N) % N]; if (kq > km) km = kq; }
      kvSafe[i] = km;
    }

    // ---- speed profile
    var vCorner = new Float64Array(N), vAllow = new Float64Array(N), vTarget = new Float64Array(N);
    var iMin = 0;
    for (i = 0; i < N; i++) {
      // the corner must be survivable for a few metres around the point as well
      var k = Math.max(Math.abs(curv[i]), Math.abs(curv[(i + 1) % N]), Math.abs(curv[(i - 1 + N) % N]));
      latSign[i] = curv[i] < 0 ? 1 : -1;        // curv < 0 is a left turn
      vCorner[i] = cornerSpeed(k, bankA[i], pitchA[i], kvSafe[i], latSign[i]);
      vAllow[i] = vCorner[i];
      if (vCorner[i] < vCorner[iMin]) iMin = i;
    }
    function latAt(idx, v) {                     // lateral acceleration on the line, towards the left
      var a = v * v * Math.abs(curv[idx]);
      if (a > LAT_MAX) a = LAT_MAX;
      return a * latSign[idx];
    }
    // backward pass (braking), two laps so the loop closes
    var m, v1, dec, coast;
    for (m = 0; m < 2 * N; m++) {
      i = ((iMin - 1 - m) % N + N) % N; j = (i + 1) % N;
      v1 = vAllow[j];
      coast = ROLL + DRAG_K * v1 * v1 + gsin[i];
      dec = maxDecel(v1, bankA[i], pitchA[i], kvSafe[i], latAt(i, v1)) - coast;   // tyre + brake-drag part
      dec = BRAKE_MARGIN * dec + coast;
      if (dec < 1) dec = 1;
      var vb = Math.sqrt(v1 * v1 + 2 * dec * seg[i]);
      if (vb < vAllow[i]) vAllow[i] = vb;
    }
    // forward pass (acceleration)
    for (i = 0; i < N; i++) vTarget[i] = vAllow[i];
    for (m = 0; m < 2 * N; m++) {
      i = (iMin + m) % N; j = (i + 1) % N;
      v1 = vTarget[i];
      var acc = maxAccel(v1, bankA[i], pitchA[i], kvSafe[i], latAt(i, v1));
      var v2 = v1 * v1 + 2 * acc * seg[i];
      var vf = v2 > MIN_SPEED * MIN_SPEED ? Math.sqrt(v2) : MIN_SPEED;
      if (vf < vTarget[j]) vTarget[j] = vf;
    }
`);

// ---- per-frame prediction
rep("      var m, i, j, lv, a0, a1, acc, dec, co, br, gs;","      var m, i, j, lv, a0, a1, acc, dec, co, br, la, bk, pt, kp;");
rep("        gs = GRAV * slope[i];\n","        bk = bankA[i]; pt = pitchA[i]; kp = kv[i];\n        la = p * p * curv[i]; la = la > LAT_MAX ? -LAT_MAX : (la < -LAT_MAX ? LAT_MAX : -la);   // towards the left\n");
rep("          dec = brakeAt(p) + gs;\n          p = p * p - 2 * dec * seg[i];","          dec = maxDecel(p, bk, pt, kp, la);\n          if (dec < 0.5) dec = 0.5;\n          p = p * p - 2 * dec * seg[i];");
rep("          acc = accelAt(p) - gs;","          acc = maxAccel(p, bk, pt, kp, la);");
rep("            co = coastAt(p) + gs;","            co = ROLL + DRAG_K * p * p + gsin[i];");
rep("              br = brakeAt(p) + gs - co;\n              lv = 0.58 + 0.42 * (dec - (co > 0 ? co : 0)) / (0.4 * br);","              br = maxDecel(p, bk, pt, kp, la) - co;\n              if (br < 0.5) br = 0.5;\n              lv = 0.58 + 0.42 * (dec - (co > 0 ? co : 0)) / (0.4 * br);");
fs.writeFileSync(f,s);
