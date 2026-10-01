/* F1Drive - dynamic racing line (green / yellow / red). Classic script; exposes F1.buildRaceLine(track, perf?)
   (perf = F1.carPerf(spec) of the car it is built for; default F1.CAR_PERF).
   See js/README-interfaces.md. Works with flat v1 tracks and with v2 tracks (y, bank, halfW, surfaceY). */
(function (global) {
  'use strict';

  var F1 = global.F1 = global.F1 || {};

  // ---- car model: fallback copies of js/car.js. F1.CAR_PERF (published by car.js) overrides them,
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
  var steerLockAt = null;     // perf.steerLockAt (js/car.js) when present: the car's own lock law (speed, banking)

  // perf: the limits of the car the line is built for (F1.carPerf(spec)); default F1.CAR_PERF (the reference car)
  function syncCarPerf(perf) {
    var p = perf && typeof perf === 'object' ? perf : F1.CAR_PERF;
    maxLatAccel = fbMaxLat; maxAccel = fbMaxAccel; maxDecel = fbMaxDecel; steerLockAt = null;
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
    if (typeof p.steerLockAt === 'function') steerLockAt = p.steerLockAt;
  }

  // ---- line / safety tuning ----
  var EDGE_MARGIN = 1.6;      // line stays this far inside the road edge (car half width 1 m + 0.6)
  var FOLD_LIMIT = 0.75;       // |d * centreline curvature| limit on the inside of a corner
  var PEAK_CURV = 1 / 40;     // curvature above which tight spots are penalised extra (IRLS weight)
  var PEAK_GAIN_MAX = 40;
  var LENGTH_WEIGHT = 2.5e-4; // 1/m^2, weight of path length against squared curvature
  var GRIP_MARGIN = 0.86;     // fraction of lateral grip used  (~93 % of theoretical corner speed)
  var STEER_MARGIN = 1.22;    // steering-lock reserve at low speed
  var BRAKE_MARGIN = 0.80;    // fraction of real braking assumed by the profile
  var CREST_SPAN = 3;         // samples each side: the worst crest nearby is assumed for the profile
  var MIN_SPEED = 7;          // m/s floor for the profile

  // ---- rendering tuning ----
  var RIBBON_W = 0.9;
  var LIFT = 0.06;            // above the road surface
  var OPACITY = 0.75;
  var AHEAD_M = 400;          // visible window length
  var START_M = 4;            // window starts this far in front of the car
  var MAX_WINDOW = 250;       // points recoloured per frame at most
  var CHEVRON_M = 3.2;        // chevron pitch
  var LEAD_TIME = 0.45;       // s of warning before a braking zone
  var WARN_LEVEL = 0.42;      // level the warning ramps up to (0.5 = yellow / lift)

  var C_GREEN = [0.10, 0.95, 0.25], C_YELLOW = [1.0, 0.86, 0.05], C_RED = [1.0, 0.10, 0.06];

  // Highest speed at which the car can follow curvature k (1/m) at a point with the given surface, with margins.
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
    // steering lock: tan(lock(v)) / WHEELBASE >= k * margin
    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);
    if (steerLockAt) {
      // the car's law (js/car.js perf.steerLockAt: speed, banking); it falls with speed: the fastest speed whose lock is enough
      if (steerLockAt(v, bank, turnSign) < x) {
        var a = MIN_SPEED, b = v, c;
        if (steerLockAt(a, bank, turnSign) < x) v = MIN_SPEED;
        else {
          for (var n = 0; n < 18; n++) { c = 0.5 * (a + b); if (steerLockAt(c, bank, turnSign) >= x) a = c; else b = c; }
          v = a;
        }
      }
    } else if (x >= STEER_LOCK) v = MIN_SPEED;
    else v = Math.min(v, STEER_SPEED_REF * Math.sqrt(STEER_LOCK / x - 1));
    return Math.max(MIN_SPEED, Math.min(TOP_SPEED, v));
  }

  function makeChevronTexture(THREE) {
    var W = 32, H = 64, data = new Uint8Array(W * H * 4), x, y;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        var u = (x + 0.5) / W, v = (y + 0.5) / H;
        var t = v + Math.abs(u - 0.5) * 0.9;
        t -= Math.floor(t);
        // solid chevron for t in [0, 0.6), soft edges, faint fill in between
        var e = Math.min(t / 0.06, (0.6 - t) / 0.06);
        e = e < 0 ? 0 : (e > 1 ? 1 : e);
        var a = 0.38 + 0.62 * e;
        var o = (y * W + x) * 4;
        data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = Math.round(a * 255);
      }
    }
    var tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  // ------------------------------------------------------------------ ideal line

  // Returns Float64Array d[N]: lateral offsets of a minimum-curvature path inside [lo, hi].
  // Works in the track (Frenet) frame: for offset d(s) from a centreline of curvature kc(s)
  //   line curvature  k = (q (q kc + d'') + 2 kc d'^2) / (q^2 + d'^2)^1.5,   q = 1 - d*kc
  // and minimises  sum P * k^2 * (line arc element)  +  LENGTH_WEIGHT * length  by projected Gauss-Newton coordinate descent
  // (coarse to fine). P = 1 + (k / PEAK_CURV)^2 (lagged) pushes towards a larger minimum radius.
  function solveOffsets(N, kcs, lo, hi, ds) {
    var levels = [8, 4, 2, 1], iters = [1500, 400, 150, 60];
    var prevD = null, prevM = 0, li;
    for (li = 0; li < levels.length; li++) {
      var M = levels[li] === 1 ? N : Math.max(12, Math.round(N / levels[li]));
      if (M > N) M = N;
      if (M === prevM) continue;
      var ratio = N / M, h = ds * ratio, ih2 = 1 / (h * h);
      var K = new Float64Array(M), bl = new Float64Array(M), bh = new Float64Array(M), d = new Float64Array(M);
      var W = new Float64Array(M);   // lagged peak weight P per node
      var j, k;
      for (j = 0; j < M; j++) {
        var pos = j * ratio, i0 = Math.floor(pos), f = pos - i0;
        if (i0 >= N) i0 -= N;
        var l = -Infinity, hh = Infinity;
        if (M === N) { l = lo[j]; hh = hi[j]; K[j] = kcs[j]; }
        else {
          var span = Math.ceil(ratio), half = Math.ceil(ratio / 2), ksum = 0;
          for (k = -span; k <= span + 1; k++) {
            var q0 = ((i0 + k) % N + N) % N;
            if (lo[q0] > l) l = lo[q0];
            if (hi[q0] < hh) hh = hi[q0];
          }
          for (k = -half; k <= half; k++) ksum += kcs[((i0 + k) % N + N) % N];
          K[j] = ksum / (2 * half + 1);
          if (l > hh) l = hh = 0.5 * (l + hh);
        }
        bl[j] = l; bh[j] = hh;
        var dv = 0;
        if (prevD) {
          var pp = j * prevM / M, p0 = Math.floor(pp), pf = pp - p0;
          p0 %= prevM;
          dv = prevD[p0] + (prevD[(p0 + 1) % prevM] - prevD[p0]) * pf;
        }
        d[j] = dv < l ? l : (dv > hh ? hh : dv);
      }
      var omega = 1.3, it, n = iters[li], a, b, c, e, g, i2h = 1 / (2 * h);
      var q, sl, t, r, kk;
      for (it = 0; it < n; it++) {
        if ((it & 3) === 0) {   // refresh the lagged peak-curvature weights
          b = M - 1;
          for (c = 0; c < M; c++) {
            e = c + 1; if (e >= M) e = 0;
            q = 1 - K[c] * d[c]; if (q < 0.2) q = 0.2;
            sl = (d[e] - d[b]) * i2h;
            t = q * q + sl * sl;
            r = q * (q * K[c] + (d[b] - 2 * d[c] + d[e]) * ih2) + 2 * K[c] * sl * sl;
            kk = r / (t * Math.sqrt(t) * PEAK_CURV); kk = kk * kk; if (kk > PEAK_GAIN_MAX) kk = PEAK_GAIN_MAX;
            W[c] = it === 0 ? 1 + kk : 0.5 * (W[c] + 1 + kk);
            b = c;
          }
        }
        a = M - 2; b = M - 1; e = 1; g = 2;
        for (c = 0; c < M; c++) {
          var u = d[c], kc = K[c], grad, hess, rp, den;
          // own node: r = q (q kc + d'') + 2 kc d'^2,  energy = r^2 / (q^2 + d'^2)^2.5
          q = 1 - kc * u; if (q < 0.2) q = 0.2;
          sl = (d[e] - d[b]) * i2h;
          var dd = (d[b] + d[e] - 2 * u) * ih2;
          t = q * q + sl * sl; den = t * t * Math.sqrt(t);
          r = q * (q * kc + dd) + 2 * kc * sl * sl;
          rp = -kc * (2 * q * kc + dd) - 2 * q * ih2;
          grad = W[c] * r / den * (2 * rp + 5 * kc * q * r / t);
          hess = W[c] * 2 * rp * rp / den;
          // previous node (u enters its d'' and d')
          q = 1 - K[b] * d[b]; if (q < 0.2) q = 0.2;
          sl = (u - d[a]) * i2h;
          t = q * q + sl * sl; den = t * t * Math.sqrt(t);
          r = q * (q * K[b] + (d[a] - 2 * d[b] + u) * ih2) + 2 * K[b] * sl * sl;
          rp = q * ih2 + 4 * K[b] * sl * i2h;
          grad += W[b] * r / den * (2 * rp - 5 * sl * i2h * r / t);
          hess += W[b] * 2 * rp * rp / den;
          // next node
          q = 1 - K[e] * d[e]; if (q < 0.2) q = 0.2;
          sl = (d[g] - u) * i2h;
          t = q * q + sl * sl; den = t * t * Math.sqrt(t);
          r = q * (q * K[e] + (u - 2 * d[e] + d[g]) * ih2) + 2 * K[e] * sl * sl;
          rp = q * ih2 - 4 * K[e] * sl * i2h;
          grad += W[e] * r / den * (2 * rp + 5 * sl * i2h * r / t);
          hess += W[e] * 2 * rp * rp / den;
          // path length
          grad += LENGTH_WEIGHT * (-kc + (2 * u - d[b] - d[e]) * ih2);
          hess += LENGTH_WEIGHT * 2 * ih2;

          var st = -omega * grad / hess;
          if (st > 1) st = 1; else if (st < -1) st = -1;
          u += st;
          if (u < bl[c]) u = bl[c]; else if (u > bh[c]) u = bh[c];
          d[c] = u;
          a = b; b = c; e = g; g = g + 1; if (g >= M) g = 0;
        }
      }
      prevD = d; prevM = M;
    }
    return prevD;
  }

  // ------------------------------------------------------------------ build

  // perf (optional): F1.carPerf(spec) of the car that drives it (v6); without it the reference car's F1.CAR_PERF.
  F1.buildRaceLine = function (track, perf) {
    var THREE = global.THREE;
    syncCarPerf(perf);
    // this line's car, kept for update(): building another line (another car) must not change this one's advice
    var L_TOP = TOP_SPEED, L_LAT_MAX = LAT_MAX, L_ROLL = ROLL, L_DRAG_K = DRAG_K;
    var lMaxAccel = maxAccel, lMaxDecel = maxDecel;
    var S = track.samples, N = S.length, i, j;
    var hasSurf = typeof track.surfaceY === 'function';
    var ds = track.length / N;

    var px = new Float64Array(N), pz = new Float64Array(N), nx = new Float64Array(N), nz = new Float64Array(N);
    var lo = new Float64Array(N), hi = new Float64Array(N), kcs = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var s = S[i];
      px[i] = s.x; pz[i] = s.z; nx[i] = s.nx; nz[i] = s.nz;
      var hw = (s.halfW > 0 ? s.halfW : track.halfWidth) - EDGE_MARGIN;
      if (!(hw > 0)) hw = 0;
      var h = hw, l = hw;
      if (s.wallPosDist > 0) h = Math.min(h, Math.max(0, s.wallPosDist - EDGE_MARGIN - 0.4));
      if (s.wallNegDist > 0) l = Math.min(l, Math.max(0, s.wallNegDist - EDGE_MARGIN - 0.4));
      // fold guard: do not offset further than a fraction of the centreline radius on the inside
      var a = S[(i - 2 + N) % N], b = S[(i + 2) % N];
      var kc = ((b.tx - a.tx) * s.nx + (b.tz - a.tz) * s.nz) / (4 * ds);
      kcs[i] = kc;
      if (kc > 1e-4) h = Math.min(h, FOLD_LIMIT / kc);
      else if (kc < -1e-4) l = Math.min(l, FOLD_LIMIT / -kc);
      hi[i] = h; lo[i] = -l;
    }

    var dOff = solveOffsets(N, kcs, lo, hi, ds);

    // line points, heights, segment lengths
    var lx = new Float64Array(N), lz = new Float64Array(N), ly = new Float64Array(N);
    function surf(idx, d) {
      var y = hasSurf ? track.surfaceY(idx, d) : (S[idx].y || 0);
      return isFinite(y) ? y : 0;
    }
    for (i = 0; i < N; i++) {
      lx[i] = px[i] + nx[i] * dOff[i];
      lz[i] = pz[i] + nz[i] * dOff[i];
      ly[i] = surf(i, dOff[i]);
    }
    var seg = new Float64Array(N), cum = new Float64Array(N + 1), slope = new Float64Array(N);
    for (i = 0; i < N; i++) {
      j = (i + 1) % N;
      var sl = Math.hypot(lx[j] - lx[i], lz[j] - lz[i]);
      if (sl < 0.05) sl = 0.05;
      seg[i] = sl;
      cum[i + 1] = cum[i] + sl;
    }
    // smoothed longitudinal slope (sin of the climb angle) over ~+-6 m
    for (i = 0; i < N; i++) {
      var i3 = (i + 3) % N, im3 = (i - 3 + N) % N, run = 0;
      for (j = 0; j < 6; j++) run += seg[(im3 + j) % N];
      var rise = ly[i3] - ly[im3];
      slope[i] = rise / Math.hypot(run, rise);
    }

    // curvature of the line (turning angle over +-2 points / arc), lightly smoothed
    var curv = new Float64Array(N), tmp = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var ia = (i - 2 + N) % N, ib = (i + 2) % N;
      var ax = lx[i] - lx[ia], az = lz[i] - lz[ia], bx = lx[ib] - lx[i], bz = lz[ib] - lz[i];
      var la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      var ang = Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
      curv[i] = (la + lb) > 1e-6 ? 2 * ang / (la + lb) : 0;
    }
    for (j = 0; j < 2; j++) {
      for (i = 0; i < N; i++) tmp[i] = 0.25 * curv[(i - 1 + N) % N] + 0.5 * curv[i] + 0.25 * curv[(i + 1) % N];
      for (i = 0; i < N; i++) curv[i] = tmp[i];
    }

    // ---- surface along the line, as the car feels it
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
    var lapTime = 0;
    for (i = 0; i < N; i++) lapTime += seg[i] / (0.5 * (vTarget[i] + vTarget[(i + 1) % N]));

    var points = new Array(N);
    for (i = 0; i < N; i++) {
      points[i] = { x: lx[i], z: lz[i], y: ly[i], d: dOff[i], sampleIndex: i, speed: vTarget[i], limit: vAllow[i], curvature: curv[i] };
    }

    // ---- ribbon geometry: 2 vertices per point, point N duplicates point 0 (uv seam)
    var NV = N + 1;
    var pos = new Float32Array(NV * 6), uv = new Float32Array(NV * 4), col = new Float32Array(NV * 8);
    var reps = Math.max(1, Math.round(cum[N] / CHEVRON_M)), hwid = RIBBON_W / 2;
    for (i = 0; i < NV; i++) {
      var q = i % N, dl = dOff[q] + hwid, dr = dOff[q] - hwid, o = i * 6;
      pos[o] = px[q] + nx[q] * dl; pos[o + 1] = surf(q, dl) + LIFT; pos[o + 2] = pz[q] + nz[q] * dl;
      pos[o + 3] = px[q] + nx[q] * dr; pos[o + 4] = surf(q, dr) + LIFT; pos[o + 5] = pz[q] + nz[q] * dr;
      var vv = cum[i] / cum[N] * reps;
      uv[i * 4] = 0; uv[i * 4 + 1] = vv; uv[i * 4 + 2] = 1; uv[i * 4 + 3] = vv;
      for (j = 0; j < 2; j++) {
        col[i * 8 + j * 4] = C_GREEN[0]; col[i * 8 + j * 4 + 1] = C_GREEN[1]; col[i * 8 + j * 4 + 2] = C_GREEN[2];
        col[i * 8 + j * 4 + 3] = 1;
      }
    }
    // index buffer covers two laps so any window [start, start + count) is one contiguous draw range
    var idx = NV * 2 > 65535 ? new Uint32Array(N * 12) : new Uint16Array(N * 12);
    for (m = 0; m < 2 * N; m++) {
      i = m % N;
      var v0 = i * 2, o6 = m * 6;   // v0 = left(i), v0+1 = right(i), v0+2 = left(i+1), v0+3 = right(i+1)
      idx[o6] = v0; idx[o6 + 1] = v0 + 2; idx[o6 + 2] = v0 + 1;
      idx[o6 + 3] = v0 + 1; idx[o6 + 4] = v0 + 2; idx[o6 + 5] = v0 + 3;
    }

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    var colAttr = new THREE.BufferAttribute(col, 4);
    if (colAttr.setUsage && THREE.DynamicDrawUsage) colAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colAttr);
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    geometry.computeBoundingSphere();

    var texture = makeChevronTexture(THREE);
    var material = new THREE.MeshBasicMaterial({
      map: texture, vertexColors: true, transparent: true, opacity: OPACITY,
      depthWrite: false, fog: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    var mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'raceline';
    mesh.renderOrder = 6;
    mesh.frustumCulled = false;   // only a short window is drawn; bounding sphere covers the whole lap
    mesh.matrixAutoUpdate = false;

    var group = new THREE.Group();
    group.name = 'raceline';
    group.add(mesh);

    // ---- per-frame colouring
    var WIN = Math.max(2, Math.min(MAX_WINDOW, Math.round(AHEAD_M / ds), N - 8));
    var START = Math.max(1, Math.min(Math.round(START_M / ds), 4));
    var LV = WIN + START + 2;               // levels computed from the car's own sample onwards
    var levels = new Float32Array(LV);      // 0 = green (throttle), 0.5 = yellow (lift), 1 = red (brake)
    geometry.setDrawRange(0, WIN * 6);

    function update(carState) {
      if (!carState || !mesh.visible) return;
      var k0 = carState.sampleIndex | 0;
      if (!(k0 >= 0)) k0 = 0;
      k0 %= N;
      var p = Math.abs(+carState.speed) || 0;
      if (p > L_TOP * 1.2) p = L_TOP * 1.2;
      var m, i, j, lv, a0, a1, acc, dec, co, br, la, bk, pt, kp;

      // predict: full throttle until the allowed profile would be exceeded, then whatever it takes
      for (m = 0; m < LV; m++) {
        i = k0 + m; if (i >= N) i -= N;
        j = i + 1; if (j >= N) j = 0;
        a0 = vAllow[i]; a1 = vAllow[j];
        bk = bankA[i]; pt = pitchA[i]; kp = kv[i];
        la = p * p * curv[i]; la = la > L_LAT_MAX ? -L_LAT_MAX : (la < -L_LAT_MAX ? L_LAT_MAX : -la);   // towards the left
        if (p > a0 * 1.004) {
          // already too fast here: brake flat out
          lv = 0.62 + (p / a0 - 1) * 4.75;       // 8 % over -> full red
          if (lv > 1) lv = 1;
          dec = lMaxDecel(p, bk, pt, kp, la);
          if (dec < 0.5) dec = 0.5;
          p = p * p - 2 * dec * seg[i];
          p = p > 1 ? Math.sqrt(p) : 1;
        } else {
          acc = lMaxAccel(p, bk, pt, kp, la);
          var pa = p * p + 2 * acc * seg[i];
          if (pa <= a1 * a1) {
            lv = 0;
            p = pa > 1 ? Math.sqrt(pa) : 1;
          } else {
            dec = (p * p - a1 * a1) / (2 * seg[i]);  // deceleration needed to meet the next target
            co = L_ROLL + L_DRAG_K * p * p + gsin[i];
            if (dec <= 0) {
              lv = acc > 0.01 ? 0.5 * (1 + dec / acc) : 0.5;   // part throttle
              if (lv < 0) lv = 0;
            } else if (dec <= co || co <= 0 && dec <= 0.5) {
              lv = co > 0 ? 0.5 + 0.08 * dec / co : 0.55;      // lifting is enough
            } else {
              br = lMaxDecel(p, bk, pt, kp, la) - co;
              if (br < 0.5) br = 0.5;
              lv = 0.58 + 0.42 * (dec - (co > 0 ? co : 0)) / (0.4 * br);
              if (lv > 1) lv = 1;
            }
            p = a1;
          }
        }
        levels[m] = lv;
      }
      // warning ramp: the line turns yellow-green shortly before a real braking zone. It stays below
      // "lift" (0.5) and is not seeded by lift-only zones, otherwise a car that is under the limit would be
      // told to coast all the way down a long (uphill) braking curve.
      var lead = Math.round(LEAD_TIME * Math.abs(carState.speed || 0) / ds);
      if (lead < 3) lead = 3;
      var step = WARN_LEVEL / lead, ramp = 0;
      for (m = LV - 1; m >= 0; m--) {
        if (levels[m] >= 0.58) ramp = WARN_LEVEL + step;
        else if (ramp > 0) {
          ramp -= step;
          if (levels[m] < ramp) levels[m] = ramp;
        }
      }

      // write colours for the visible window
      var first = k0 + START; if (first >= N) first -= N;
      var fadeOut = WIN > 40 ? 20 : (WIN >> 1), r, g, b, al, t, o;
      for (m = 0; m <= WIN; m++) {
        i = first + m; if (i >= N) i -= N;
        lv = levels[m + START];
        if (lv <= 0.5) {
          t = lv * 2;
          r = C_GREEN[0] + (C_YELLOW[0] - C_GREEN[0]) * t;
          g = C_GREEN[1] + (C_YELLOW[1] - C_GREEN[1]) * t;
          b = C_GREEN[2] + (C_YELLOW[2] - C_GREEN[2]) * t;
        } else {
          t = (lv - 0.5) * 2;
          r = C_YELLOW[0] + (C_RED[0] - C_YELLOW[0]) * t;
          g = C_YELLOW[1] + (C_RED[1] - C_YELLOW[1]) * t;
          b = C_YELLOW[2] + (C_RED[2] - C_YELLOW[2]) * t;
        }
        al = m < 3 ? (m + 1) * 0.25 : (m > WIN - fadeOut ? (WIN - m) / fadeOut : 1);
        o = i * 8;
        col[o] = r; col[o + 1] = g; col[o + 2] = b; col[o + 3] = al;
        col[o + 4] = r; col[o + 5] = g; col[o + 6] = b; col[o + 7] = al;
        if (i === 0) {           // duplicate seam vertex pair
          o = N * 8;
          col[o] = r; col[o + 1] = g; col[o + 2] = b; col[o + 3] = al;
          col[o + 4] = r; col[o + 5] = g; col[o + 6] = b; col[o + 7] = al;
        }
      }
      if (colAttr.updateRange) {
        if (first + WIN < N) { colAttr.updateRange.offset = first * 8; colAttr.updateRange.count = (WIN + 1) * 8; }
        else { colAttr.updateRange.offset = 0; colAttr.updateRange.count = -1; }
      }
      colAttr.needsUpdate = true;
      geometry.setDrawRange(first * 6, WIN * 6);
    }

    function setVisible(on) {
      mesh.visible = !!on;
      group.visible = !!on;
    }

    function dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
      group.remove(mesh);
      if (group.parent) group.parent.remove(group);
    }

    return {
      group: group,
      points: points,
      update: update,
      setVisible: setVisible,
      dispose: dispose,
      // extras (not required by the interface)
      lapTime: lapTime,        // estimated lap time (s) of the speed profile
      levels: levels,          // after update(): advice from the car's sample onwards, 0 throttle .. 0.5 lift .. 1 brake
      windowPoints: WIN
    };
  };
})(typeof window !== 'undefined' ? window : this);
