/* F1Drive - dynamic racing line (green / yellow / red). Classic script; exposes F1.buildRaceLine(track).
   See js/README-interfaces.md. Works with flat v1 tracks and with v2 tracks (y, bank, halfW, surfaceY). */
(function (global) {
  'use strict';

  var F1 = global.F1 = global.F1 || {};

  // ---- car model constants (mirror js/car.js; keep in sync if the car tuning changes) ----
  var KMH = 1 / 3.6;
  var TOP_SPEED = 330 * KMH;
  var DRAG_K = 0.0012;
  var ROLL = 0.5;
  var TRACTION = 11.0;
  var POWER = (DRAG_K * TOP_SPEED * TOP_SPEED + ROLL) * TOP_SPEED;
  var BRAKE_BASE = 12.0;
  var BRAKE_AERO = 0.0032;
  var WHEELBASE = 3.6;
  var STEER_LOCK = 0.35;
  var STEER_SPEED_REF = 22;
  var LAT_BASE = 20.0;
  var LAT_AERO = 0.0045;
  var LAT_MAX = 44.0;
  var GRAV = 9.81;

  // ---- line / safety tuning ----
  var EDGE_MARGIN = 1.6;      // line stays this far inside the road edge (car half width 1 m + 0.6)
  var FOLD_LIMIT = 0.75;       // |d * centreline curvature| limit on the inside of a corner
  var PEAK_CURV = 1/15;     // curvature above which tight spots are penalised extra (IRLS weight)
  var PEAK_GAIN_MAX = 2000;
  var LENGTH_WEIGHT = 2.5e-4; // 1/m^2, weight of path length against squared curvature
  var GRIP_MARGIN = 0.86;     // fraction of lateral grip used  (~93 % of theoretical corner speed)
  var STEER_MARGIN = 1.22;    // steering-lock reserve at low speed
  var BRAKE_MARGIN = 0.80;    // fraction of real braking assumed by the profile
  var SLOPE_MARGIN = 1.0;     // slope (gravity) term as implemented in car.js, see longSlope()
  var MIN_SPEED = 7;          // m/s floor for the profile

  // ---- rendering tuning ----
  var RIBBON_W = 0.9;
  var LIFT = 0.06;            // above the road surface
  var OPACITY = 0.75;
  var AHEAD_M = 400;          // visible window length
  var START_M = 4;            // window starts this far in front of the car
  var MAX_WINDOW = 250;       // points recoloured per frame at most
  var CHEVRON_M = 3.2;        // chevron pitch
  var LEAD_TIME = 0.45;       // s of yellow warning before a braking zone

  var C_GREEN = [0.10, 0.95, 0.25], C_YELLOW = [1.0, 0.86, 0.05], C_RED = [1.0, 0.10, 0.06];

  function accelAt(v) {   // full-throttle net acceleration on asphalt
    return Math.min(TRACTION, POWER / Math.max(v, 1)) - ROLL - DRAG_K * v * v;
  }
  function coastAt(v) { return ROLL + DRAG_K * v * v; }
  function brakeAt(v) {   // full-brake net deceleration
    return BRAKE_BASE + BRAKE_AERO * v * v + ROLL + DRAG_K * v * v;
  }

  // Highest speed at which the car can follow curvature k (1/m), with margins.
  function cornerSpeed(k) {
    k = Math.abs(k);
    if (k < 1e-6) return TOP_SPEED;
    var v2 = LAT_MAX * GRIP_MARGIN / k;
    var ka = k - LAT_AERO * GRIP_MARGIN;
    if (ka > 0) v2 = Math.min(v2, LAT_BASE * GRIP_MARGIN / ka);
    var v = Math.sqrt(v2);
    // steering lock: tan(STEER_LOCK / (1 + (v/ref)^2)) / WHEELBASE >= k * margin
    var x = Math.atan(WHEELBASE * k * STEER_MARGIN);
    if (x >= STEER_LOCK) v = MIN_SPEED;
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
  function solveOffsets(N, px, pz, nx, nz, lo, hi, ds) {
    var levels = [8, 4, 2, 1], iters = [2200, 500, 160, 50];
    var prevD = null, prevM = 0, li;
    for (li = 0; li < levels.length; li++) {
      var M = levels[li] === 1 ? N : Math.max(12, Math.round(N / levels[li]));
      if (M > N) M = N;
      if (M === prevM) continue;
      var ratio = N / M, h = ds * ratio;
      var cx = new Float64Array(M), cz = new Float64Array(M), ux = new Float64Array(M), uz = new Float64Array(M);
      var bl = new Float64Array(M), bh = new Float64Array(M), d = new Float64Array(M);
      var qx = new Float64Array(M), qz = new Float64Array(M);
      var j, k;
      for (j = 0; j < M; j++) {
        var pos = j * ratio, i0 = Math.floor(pos), f = pos - i0;
        if (i0 >= N) i0 -= N;
        var i1 = (i0 + 1) % N;
        cx[j] = px[i0] + (px[i1] - px[i0]) * f;
        cz[j] = pz[i0] + (pz[i1] - pz[i0]) * f;
        var ax = nx[i0] + (nx[i1] - nx[i0]) * f, az = nz[i0] + (nz[i1] - nz[i0]) * f, al = Math.hypot(ax, az) || 1;
        ux[j] = ax / al; uz[j] = az / al;
        var l = -Infinity, hh = Infinity;
        if (M === N) { l = lo[j]; hh = hi[j]; }
        else {
          var span = Math.ceil(ratio);
          for (k = -span; k <= span + 1; k++) {
            var q = ((i0 + k) % N + N) % N;
            if (lo[q] > l) l = lo[q];
            if (hi[q] < hh) hh = hi[q];
          }
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
        qx[j] = cx[j] + ux[j] * d[j]; qz[j] = cz[j] + uz[j] * d[j];
      }
      // projected SOR on  sum w[i] |P[i-1] - 2P[i] + P[i+1]|^2 + lam * sum |P[i+1] - P[i]|^2
      // w[i] = (h / local point spacing)^3 turns the second difference into true curvature^2 * ds
      // (without it the tightly spaced inside of a hairpin looks "cheap" and the line hugs the inside).
      var lam = LENGTH_WEIGHT * h * h, omega = 1.4, it, n = iters[li], w = new Float64Array(M);
      for (it = 0; it < n; it++) {
        var a, b, c, e, g;
        if ((it & 3) === 0) {
          b = M - 1;
          var hp = Math.hypot(qx[0] - qx[b], qz[0] - qz[b]);
          for (c = 0; c < M; c++) {
            e = c + 1; if (e >= M) e = 0;
            var hn = Math.hypot(qx[e] - qx[c], qz[e] - qz[c]);
            var hl = 0.5 * (hp + hn) + 1e-6, r = h / hl, wn = r * r * r;
            if (wn < 0.3) wn = 0.3; else if (wn > 12) wn = 12;
            // IRLS towards sum(curvature^4): tight spots get heavier, which opens up the minimum radius
            var kk = Math.hypot(qx[b] - 2 * qx[c] + qx[e], qz[b] - 2 * qz[c] + qz[e]) / (hl * hl) / PEAK_CURV;
            kk = kk * kk; if (kk > PEAK_GAIN_MAX) kk = PEAK_GAIN_MAX;
            wn *= 1 + kk;
            w[c] = it === 0 ? wn : 0.5 * (w[c] + wn);
            hp = hn; b = c;
          }
        }
        a = M - 2; b = M - 1; e = 1; g = 2;
        for (c = 0; c < M; c++) {
          var wb = w[b], wc = w[c], we = w[e];
          var sx = -wb * (qx[a] - 2 * qx[b] + cx[c]) + 2 * wc * (qx[b] - 2 * cx[c] + qx[e]) - we * (cx[c] - 2 * qx[e] + qx[g]) +
                   lam * (qx[b] + qx[e] - 2 * cx[c]);
          var sz = -wb * (qz[a] - 2 * qz[b] + cz[c]) + 2 * wc * (qz[b] - 2 * cz[c] + qz[e]) - we * (cz[c] - 2 * qz[e] + qz[g]) +
                   lam * (qz[b] + qz[e] - 2 * cz[c]);
          var dn = (sx * ux[c] + sz * uz[c]) / (wb + 4 * wc + we + 2 * lam);
          dn = d[c] + omega * (dn - d[c]);
          if (dn < bl[c]) dn = bl[c]; else if (dn > bh[c]) dn = bh[c];
          d[c] = dn;
          qx[c] = cx[c] + ux[c] * dn; qz[c] = cz[c] + uz[c] * dn;
          a = b; b = c; e = g; g = g + 1; if (g >= M) g = 0;
        }
      }
      prevD = d; prevM = M;
    }
    return prevD;
  }

  // ------------------------------------------------------------------ build

  F1.buildRaceLine = function (track) {
    var THREE = global.THREE;
    var S = track.samples, N = S.length, i, j;
    var hasSurf = typeof track.surfaceY === 'function';
    var ds = track.length / N;

    var px = new Float64Array(N), pz = new Float64Array(N), nx = new Float64Array(N), nz = new Float64Array(N);
    var lo = new Float64Array(N), hi = new Float64Array(N);
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
      if (kc > 1e-4) h = Math.min(h, FOLD_LIMIT / kc);
      else if (kc < -1e-4) l = Math.min(l, FOLD_LIMIT / -kc);
      hi[i] = h; lo[i] = -l;
    }

    var dOff = solveOffsets(N, px, pz, nx, nz, lo, hi, ds);

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

    // ---- speed profile
    function longSlope(idx) { return GRAV * slope[idx] * SLOPE_MARGIN; } // decel from climbing (m/s^2)

    var vCorner = new Float64Array(N), vAllow = new Float64Array(N), vTarget = new Float64Array(N);
    var iMin = 0;
    for (i = 0; i < N; i++) {
      // the corner must be survivable for a few metres around the point as well
      var k = Math.max(Math.abs(curv[i]), Math.abs(curv[(i + 1) % N]), Math.abs(curv[(i - 1 + N) % N]));
      vCorner[i] = cornerSpeed(k);
      vAllow[i] = vCorner[i];
      if (vCorner[i] < vCorner[iMin]) iMin = i;
    }
    // backward pass (braking), two laps so the loop closes
    var m, v1, dec;
    for (m = 0; m < 2 * N; m++) {
      i = ((iMin - 1 - m) % N + N) % N; j = (i + 1) % N;
      v1 = vAllow[j];
      dec = BRAKE_MARGIN * (BRAKE_BASE + BRAKE_AERO * v1 * v1) + coastAt(v1) + Math.min(0, longSlope(i));
      if (dec < 2) dec = 2;
      var vb = Math.sqrt(v1 * v1 + 2 * dec * seg[i]);
      if (vb < vAllow[i]) vAllow[i] = vb;
    }
    // forward pass (acceleration)
    for (i = 0; i < N; i++) vTarget[i] = vAllow[i];
    for (m = 0; m < 2 * N; m++) {
      i = (iMin + m) % N; j = (i + 1) % N;
      v1 = vTarget[i];
      var acc = accelAt(v1) - longSlope(i);
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
      if (p > TOP_SPEED * 1.2) p = TOP_SPEED * 1.2;
      var m, i, j, lv, a0, a1, acc, dec, co, br, gs;

      // predict: full throttle until the allowed profile would be exceeded, then whatever it takes
      for (m = 0; m < LV; m++) {
        i = k0 + m; if (i >= N) i -= N;
        j = i + 1; if (j >= N) j = 0;
        a0 = vAllow[i]; a1 = vAllow[j];
        gs = GRAV * slope[i];
        if (p > a0 * 1.004) {
          // already too fast here: brake flat out
          lv = 0.62 + (p / a0 - 1) * 4.75;       // 8 % over -> full red
          if (lv > 1) lv = 1;
          dec = brakeAt(p) + gs;
          p = p * p - 2 * dec * seg[i];
          p = p > 1 ? Math.sqrt(p) : 1;
        } else {
          acc = accelAt(p) - gs;
          var pa = p * p + 2 * acc * seg[i];
          if (pa <= a1 * a1) {
            lv = 0;
            p = pa > 1 ? Math.sqrt(pa) : 1;
          } else {
            dec = (p * p - a1 * a1) / (2 * seg[i]);  // deceleration needed to meet the next target
            co = coastAt(p) + gs;
            if (dec <= 0) {
              lv = acc > 0.01 ? 0.5 * (1 + dec / acc) : 0.5;   // part throttle
              if (lv < 0) lv = 0;
            } else if (dec <= co || co <= 0 && dec <= 0.5) {
              lv = co > 0 ? 0.5 + 0.08 * dec / co : 0.55;      // lifting is enough
            } else {
              br = brakeAt(p) + gs - co;
              lv = 0.58 + 0.42 * (dec - (co > 0 ? co : 0)) / (0.4 * br);
              if (lv > 1) lv = 1;
            }
            p = a1;
          }
        }
        levels[m] = lv;
      }
      // warning ramp: yellow creeps in shortly before a lift / braking zone
      var lead = Math.round(LEAD_TIME * Math.abs(carState.speed || 0) / ds);
      if (lead < 3) lead = 3;
      var step = 0.6 / lead, prev = 0;
      for (m = LV - 1; m >= 0; m--) {
        lv = (prev < 0.6 ? prev : 0.6) - step;
        if (levels[m] < lv) levels[m] = lv;
        prev = levels[m];
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
