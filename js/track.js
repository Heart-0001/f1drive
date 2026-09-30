/* F1Drive - track builder. Classic script; exposes F1.buildTrack(trackData). See README-interfaces.md. */
(function (global) {
  'use strict';

  var F1 = global.F1 = global.F1 || {};

  // ---- plan layout
  var HALF_WIDTH = 7;        // nominal (maximum) road half width; per-sample value is samples[i].halfW
  var HALF_WIDTH_MIN = 3.5;  // the road is never narrowed below this
  var WALL_DIST = 12;        // nominal (maximum) wall inner face offset; per-sample: wallPosDist / wallNegDist
  var WALL_THICK = 0.5;
  var WALL_H = 1.2;
  var WALL_BAND_Y = 0.75;    // lower concrete part / upper coloured band split
  var WALL_SHARE_GAP = 0.3;  // a wall shared by two close roads stands this far short of the mid-line
  var WALL_ROAD_MARGIN = 1.0;// wall inner face is at least this far outside the road edge
  var WALL_MIN = HALF_WIDTH_MIN + WALL_ROAD_MARGIN; // no room even for that -> the wall is dropped
  var WIDTH_SMOOTH = 8;      // samples each side used to ease per-sample wall offsets / road width
  var STEP = 2;              // sample spacing (m)
  var SMOOTH_PASSES = 8;     // [1,2,1]/4 passes on 2 m samples -> sigma ~4 m
  var LINE_W = 0.3;
  var KERB_W = 1.3;
  var KERB_CURV = 1 / 120;   // kerbs where corner radius < 120 m
  var LOCATE_WINDOW = 40;
  var GRID_CELL = 16;
  var NEAR_R = 64;           // other pieces of road further away than this never affect a sample

  // ---- elevation / banking
  var Y_SMOOTH_PASSES = 40;  // extra [1,2,1]/4 passes on the height profile (sigma ~9 m)
  var BANK_MAX = 6 * Math.PI / 180;  // cap
  var BANK_GAIN = 5.0;       // rad of bank per unit curvature (1/m): radius 100 m -> ~2.7 deg
  var BANK_SMOOTH_PASSES = 32; // sigma ~8 m, i.e. transitions spread over ~35 m

  // ---- self-crossing (Suzuka): both roads are blended to one flat height around the crossing
  var CROSS_DIST = 2.5;      // two non-adjacent samples this close = the centreline crosses itself
  var CROSS_MIN_SEP = 60;    // samples; "non-adjacent"
  var CROSS_ZONE = 40;       // samples each side of the crossing treated as the crossing zone
  var CROSS_FLAT_R = 26;     // m of arc each side that is exactly level
  var CROSS_BLEND_R = 240;   // m of arc over which the height eases back to the real profile

  // ---- terrain
  var SKIRT_W = 16;          // verge outside the walls that eases down to the terrain
  var TERRAIN_EPS = 0.3;     // terrain is kept at least this far below the track surface it passes under
  var TERRAIN_PAD = 80;      // fine grid margin around the track bounding box
  var TERRAIN_CELL_MIN = 10, TERRAIN_MAX_VERTS = 42000;
  var TERRAIN_RINGS = 9, TERRAIN_RING_GROW = 1.8; // coarse outer rings reaching several km

  var Y_ROAD = 0.012, Y_PAINT = 0.03, Y_START = 0.04; // lifts above the nominal surface

  // ---------------------------------------------------------------- centreline

  function cleanPoints(points, elev) {
    var out = [], i, p, q;
    var useElev = !!(elev && elev.length === points.length);
    for (i = 0; i < points.length; i++) {
      p = points[i];
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      q = out[out.length - 1];
      if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.5) continue;
      var y = useElev ? +elev[i] : 0;
      out.push([+p[0], +p[1], isFinite(y) ? y : 0]);
    }
    while (out.length > 1 &&
           Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.5) {
      out.pop();
    }
    return out;
  }

  // Closed centripetal Catmull-Rom on (x, z), densely evaluated (~1 m); the height rides along
  // on the same parametrisation.
  function catmullRomClosed(pts) {
    var n = pts.length, out = [[], [], []];
    for (var i = 0; i < n; i++) {
      var p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      var d01 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
      var d12 = Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
      var d23 = Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
      var t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23;
      var segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var sub = Math.max(1, Math.ceil(segLen));
      for (var k = 0; k < sub; k++) {
        var t = t1 + (t2 - t1) * (k / sub);
        for (var c = 0; c < 3; c++) {
          var a1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
          var a2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
          var a3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
          var b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
          var b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
          out[c].push((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2);
        }
      }
    }
    return { x: out[0], z: out[1], y: out[2] };
  }

  // Uniform (plan) arc-length resampling of a closed polyline; first output point = first input point.
  function resampleClosed(xs, zs, ys, step) {
    var n = xs.length, cum = new Float64Array(n + 1), i;
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], zs[j] - zs[i]);
    }
    var L = cum[n];
    var M = Math.max(16, Math.round(L / step));
    var ds = L / M, ox = new Array(M), oz = new Array(M), oy = new Array(M), seg = 0;
    for (i = 0; i < M; i++) {
      var target = i * ds;
      while (seg < n - 1 && cum[seg + 1] < target) seg++;
      var sl = cum[seg + 1] - cum[seg];
      var f = sl > 1e-9 ? (target - cum[seg]) / sl : 0;
      var b = (seg + 1) % n;
      ox[i] = xs[seg] + (xs[b] - xs[seg]) * f;
      oz[i] = zs[seg] + (zs[b] - zs[seg]) * f;
      oy[i] = ys[seg] + (ys[b] - ys[seg]) * f;
    }
    return { x: ox, z: oz, y: oy };
  }

  function smoothClosed(a, passes) {
    var n = a.length, b = new Array(n), p, i, t;
    a = Array.prototype.slice.call(a);
    for (p = 0; p < passes; p++) {
      for (i = 0; i < n; i++) b[i] = 0.25 * a[(i - 1 + n) % n] + 0.5 * a[i] + 0.25 * a[(i + 1) % n];
      t = a; a = b; b = t;
    }
    return a;
  }

  // ---------------------------------------------------------------- helpers

  // Cyclic runs of mask[i] == value: [[start, len], ...]
  function cyclicRuns(mask, value) {
    var n = mask.length, runs = [], i, start = -1;
    for (i = 0; i < n; i++) {
      if ((!!mask[i]) !== value) { start = i; break; }
    }
    if (start < 0) return (n && (!!mask[0]) === value) ? [[0, n]] : [];
    var len = 0, rs = 0;
    for (var k = 1; k <= n; k++) {
      i = (start + k) % n;
      if ((!!mask[i]) === value) {
        if (len === 0) rs = i;
        len++;
      } else if (len) {
        runs.push([rs, len]); len = 0;
      }
    }
    return runs;
  }

  function setRun(mask, run, v) {
    var n = mask.length;
    for (var k = 0; k < run[1]; k++) mask[(run[0] + k) % n] = v;
  }

  // Remove true-runs shorter than minLen.
  function dropShortRuns(mask, minLen) {
    var runs = cyclicRuns(mask, true);
    for (var r = 0; r < runs.length; r++) {
      if (runs[r][1] < minLen && runs[r][1] < mask.length) setRun(mask, runs[r], 0);
    }
  }

  // Eased copy of a[] that never exceeds a[] itself: cyclic min over +-w, then mean over +-w.
  function easeBelow(a, w) {
    var n = a.length, m = new Float64Array(n), o = new Float64Array(n), i, k, v;
    if (2 * w + 1 >= n) w = Math.max(0, (n >> 1) - 1);
    for (i = 0; i < n; i++) {
      v = Infinity;
      for (k = -w; k <= w; k++) { var q = a[(i + k + n) % n]; if (q < v) v = q; }
      m[i] = v;
    }
    for (i = 0; i < n; i++) {
      v = 0;
      for (k = -w; k <= w; k++) v += m[(i + k + n) % n];
      o[i] = v / (2 * w + 1);
    }
    return o;
  }

  function smoothstep(t) { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }

  function hexRGB(h) { return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; }

  function newBuf(colored, normals) { return { pos: [], col: colored ? [] : null, nrm: normals ? [] : null }; }

  // Quad a-b-c-d as triangles (a, b, c), (c, b, d); each point is [x, y, z].
  function quad(buf, a, b, c, d, col) {
    buf.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
                 c[0], c[1], c[2], b[0], b[1], b[2], d[0], d[1], d[2]);
    if (buf.col) for (var k = 0; k < 6; k++) buf.col.push(col[0], col[1], col[2]);
  }

  // Fill the cells of a W x H grid that have wgt == 0 from the ones that have wgt == 1 (pull-push).
  function pullPush(val, wgt, W, H) {
    var i, x, y, holes = 0;
    for (i = 0; i < W * H; i++) if (!wgt[i]) holes++;
    if (!holes) return;
    if (W <= 1 && H <= 1) { val[0] = 0; return; }
    var W2 = (W + 1) >> 1, H2 = (H + 1) >> 1;
    var v2 = new Float64Array(W2 * H2), w2 = new Float64Array(W2 * H2);
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        i = y * W + x;
        if (wgt[i]) { var c = (y >> 1) * W2 + (x >> 1); v2[c] += val[i]; w2[c] += 1; }
      }
    }
    for (i = 0; i < W2 * H2; i++) if (w2[i]) { v2[i] /= w2[i]; w2[i] = 1; }
    pullPush(v2, w2, W2, H2);
    for (y = 0; y < H; y++) {
      var fy = (y - 0.5) / 2, y0 = Math.floor(fy), ty = fy - y0, y1 = y0 + 1;
      if (y0 < 0) y0 = 0; if (y1 > H2 - 1) y1 = H2 - 1; if (y0 > H2 - 1) y0 = H2 - 1;
      for (x = 0; x < W; x++) {
        i = y * W + x;
        if (wgt[i]) continue;
        var fx = (x - 0.5) / 2, x0 = Math.floor(fx), tx = fx - x0, x1 = x0 + 1;
        if (x0 < 0) x0 = 0; if (x1 > W2 - 1) x1 = W2 - 1; if (x0 > W2 - 1) x0 = W2 - 1;
        val[i] = (v2[y0 * W2 + x0] * (1 - tx) + v2[y0 * W2 + x1] * tx) * (1 - ty) +
                 (v2[y1 * W2 + x0] * (1 - tx) + v2[y1 * W2 + x1] * tx) * ty;
      }
    }
  }

  // ---------------------------------------------------------------- build

  F1.buildTrack = function (trackData) {
    var THREE = global.THREE;
    var pts = cleanPoints((trackData && trackData.points) || [], trackData && trackData.elev);
    if (pts.length < 3) throw new Error('F1.buildTrack: track needs at least 3 distinct points');

    // --- smooth + resample (x, z and height together)
    var dense = catmullRomClosed(pts);
    var r = resampleClosed(dense.x, dense.z, dense.y, STEP);
    r = resampleClosed(smoothClosed(r.x, SMOOTH_PASSES), smoothClosed(r.z, SMOOTH_PASSES),
                       smoothClosed(r.y, SMOOTH_PASSES), STEP);

    var N = r.x.length, i, j, k, q;
    var px = new Float64Array(N), pz = new Float64Array(N), py = new Float64Array(N);
    var tx = new Float64Array(N), tz = new Float64Array(N);
    var nx = new Float64Array(N), nz = new Float64Array(N);
    var sArr = new Float64Array(N);
    var ySm = smoothClosed(r.y, Y_SMOOTH_PASSES);
    for (i = 0; i < N; i++) { px[i] = r.x[i]; pz[i] = r.z[i]; py[i] = ySm[i]; }
    var total = 0;
    for (i = 0; i < N; i++) {
      sArr[i] = total;
      j = (i + 1) % N;
      total += Math.hypot(px[j] - px[i], pz[j] - pz[i]);
    }
    var ds = total / N;
    for (i = 0; i < N; i++) {
      var a = (i - 1 + N) % N, b = (i + 1) % N;
      var dx = px[b] - px[a], dz = pz[b] - pz[a], l = Math.hypot(dx, dz);
      if (l < 1e-9) { dx = px[b] - px[i]; dz = pz[b] - pz[i]; l = Math.hypot(dx, dz) || 1; }
      tx[i] = dx / l; tz[i] = dz / l;
      // n = driver's LEFT (up x forward): +d is to the left of the racing direction
      nx[i] = tz[i]; nz[i] = -tx[i];
    }
    function cyc(u, v) { var d = Math.abs(u - v); return d < N - d ? d : N - d; }

    // --- signed curvature (positive = turning towards +n), lightly smoothed
    var curv = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var i0 = (i - 2 + N) % N, i1 = (i + 2) % N;
      curv[i] = ((tx[i1] - tx[i0]) * nx[i] + (tz[i1] - tz[i0]) * nz[i]) / (4 * ds);
    }

    // --- spatial grid over centreline samples
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (i = 0; i < N; i++) {
      if (px[i] < minX) minX = px[i]; if (px[i] > maxX) maxX = px[i];
      if (pz[i] < minZ) minZ = pz[i]; if (pz[i] > maxZ) maxZ = pz[i];
    }
    var gx0 = minX - GRID_CELL, gz0 = minZ - GRID_CELL;
    var gCols = Math.ceil((maxX - minX) / GRID_CELL) + 3, gRows = Math.ceil((maxZ - minZ) / GRID_CELL) + 3;
    var cellStart = new Int32Array(gCols * gRows + 1), cellOf = new Int32Array(N);
    for (i = 0; i < N; i++) {
      cellOf[i] = Math.floor((pz[i] - gz0) / GRID_CELL) * gCols + Math.floor((px[i] - gx0) / GRID_CELL);
      cellStart[cellOf[i] + 1]++;
    }
    for (i = 0; i < gCols * gRows; i++) cellStart[i + 1] += cellStart[i];
    var cellFill = cellStart.slice(0, gCols * gRows), cellItems = new Int32Array(N);
    for (i = 0; i < N; i++) cellItems[cellFill[cellOf[i]]++] = i;

    // Calls fn(sampleIndex) for every sample in the grid cells within `reach` cells of (x, z).
    function forNear(x, z, reach, fn) {
      var cx = Math.floor((x - gx0) / GRID_CELL), cz = Math.floor((z - gz0) / GRID_CELL);
      for (var zz = cz - reach; zz <= cz + reach; zz++) {
        if (zz < 0 || zz >= gRows) continue;
        for (var xx = cx - reach; xx <= cx + reach; xx++) {
          if (xx < 0 || xx >= gCols) continue;
          var c = zz * gCols + xx;
          for (var e = cellStart[c]; e < cellStart[c + 1]; e++) fn(cellItems[e]);
        }
      }
    }

    // Squared distance from (x,z) to the nearest centreline sample (exact within GRID_CELL).
    function nearestD2(x, z) {
      var best = Infinity;
      forNear(x, z, 1, function (s) {
        var ddx = px[s] - x, ddz = pz[s] - z, dd = ddx * ddx + ddz * ddz;
        if (dd < best) best = dd;
      });
      return best;
    }

    // --- genuine self-crossings: non-adjacent samples that (nearly) coincide
    var crossings = [], partner = new Int32Array(N).fill(-1);
    (function () {
      var cands = [], lim = CROSS_DIST * CROSS_DIST;
      if (N < 4 * CROSS_MIN_SEP) return;
      for (var u = 0; u < N; u++) {
        var bj = -1, bd = lim;
        forNear(px[u], pz[u], 1, function (s) {
          if (s <= u || cyc(u, s) <= CROSS_MIN_SEP) return;
          var ex = px[s] - px[u], ez = pz[s] - pz[u], dd = ex * ex + ez * ez;
          if (dd < bd) { bd = dd; bj = s; }
        });
        if (bj >= 0) cands.push([bd, u, bj]);
      }
      cands.sort(function (p, o) { return p[0] - o[0]; });
      for (var c = 0; c < cands.length; c++) {
        var ci = cands[c][1], cj = cands[c][2], dup = false;
        for (var e = 0; e < crossings.length; e++) {
          var o = crossings[e];
          if ((cyc(ci, o[0]) <= CROSS_ZONE && cyc(cj, o[1]) <= CROSS_ZONE) ||
              (cyc(ci, o[1]) <= CROSS_ZONE && cyc(cj, o[0]) <= CROSS_ZONE)) dup = true;
        }
        if (!dup) crossings.push([ci, cj]);
      }
      for (c = 0; c < crossings.length; c++) {
        for (var w = -CROSS_ZONE; w <= CROSS_ZONE; w++) {
          partner[(crossings[c][0] + w + N) % N] = crossings[c][1];
          partner[(crossings[c][1] + w + N) % N] = crossings[c][0];
        }
      }
    })();
    var PARTNER_SPAN = CROSS_ZONE + 20;

    // level both roads to a common height around each crossing so the two surfaces coincide
    var flatW = new Float64Array(N);
    for (k = 0; k < crossings.length; k++) {
      var hc = 0.5 * (py[crossings[k][0]] + py[crossings[k][1]]);
      var span = Math.min((N >> 1) - 1, Math.ceil((CROSS_FLAT_R + CROSS_BLEND_R) / ds));
      for (var br = 0; br < 2; br++) {
        for (q = -span; q <= span; q++) {
          i = (crossings[k][br] + q + N) % N;
          var wgt = 1 - smoothstep((Math.abs(q) * ds - CROSS_FLAT_R) / CROSS_BLEND_R);
          py[i] += (hc - py[i]) * wgt;
          if (wgt > flatW[i]) flatW[i] = wgt;
        }
      }
    }

    // --- grade (dy/ds) and banking (derived from curvature: inside of the corner lower)
    var grade = new Float64Array(N), bank = new Float64Array(N), tanB = new Float64Array(N);
    var bankRaw = new Array(N);
    for (i = 0; i < N; i++) {
      grade[i] = (py[(i + 1) % N] - py[(i - 1 + N) % N]) / (2 * ds);
      // curv > 0 turns towards +n, so the +n side is the inside and must be lower -> negative bank
      bankRaw[i] = -BANK_MAX * Math.tanh(BANK_GAIN * curv[i] / BANK_MAX);
    }
    bankRaw = smoothClosed(bankRaw, BANK_SMOOTH_PASSES);
    for (i = 0; i < N; i++) {
      bank[i] = bankRaw[i] * (1 - flatW[i]);
      tanB[i] = Math.tan(bank[i]);
    }
    // unit surface normal per sample
    var ux = new Float64Array(N), uy = new Float64Array(N), uz = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var vx = -grade[i] * tx[i] - tanB[i] * nx[i], vz = -grade[i] * tz[i] - tanB[i] * nz[i];
      var vl = Math.sqrt(vx * vx + 1 + vz * vz);
      ux[i] = vx / vl; uy[i] = 1 / vl; uz[i] = vz / vl;
    }

    // --- free lateral room per sample and side: how far the offset point can go along the normal
    //     before it is closer to some other sample than to its own (= distance to the medial axis:
    //     the centre of curvature inside a bend, half the gap to a neighbouring piece of road).
    //     roomAll counts everything; roomRoad ignores the other branch of a genuine crossing.
    var roomAll = [new Float64Array(N).fill(1e9), new Float64Array(N).fill(1e9)];   // [neg, pos]
    var roomRoad = [new Float64Array(N).fill(1e9), new Float64Array(N).fill(1e9)];
    var nearReach = Math.ceil(NEAR_R / GRID_CELL), nearR2 = NEAR_R * NEAR_R;
    for (i = 0; i < N; i++) {
      (function (u) {
        var pu = partner[u], x = px[u], z = pz[u], ax = nx[u], az = nz[u];
        forNear(x, z, nearReach, function (s) {
          if (s === u) return;
          var ex = px[s] - x, ez = pz[s] - z, d2 = ex * ex + ez * ez;
          if (d2 > nearR2) return;
          var dn = ex * ax + ez * az, side = dn > 0 ? 1 : 0;
          if (dn < 0) dn = -dn;
          if (dn < 1e-6) return;
          var v = d2 / (2 * dn);
          if (v < roomAll[side][u]) roomAll[side][u] = v;
          if (pu >= 0 && cyc(s, pu) <= PARTNER_SPAN) return;
          if (v < roomRoad[side][u]) roomRoad[side][u] = v;
        });
      })(i);
    }

    // --- per-sample wall offsets (inner face), wall flags, road half width
    var wallOff = [null, null], wallOuter = [null, null], wallFlag = [new Uint8Array(N), new Uint8Array(N)];
    var side;
    for (side = 0; side < 2; side++) {
      var raw = new Float64Array(N);
      for (i = 0; i < N; i++) raw[i] = Math.max(0.5, Math.min(WALL_DIST, roomRoad[side][i] - WALL_SHARE_GAP));
      wallOff[side] = easeBelow(raw, WIDTH_SMOOTH);
    }
    var halfW = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var wmin = Math.min(wallOff[0][i], wallOff[1][i]) - WALL_ROAD_MARGIN;
      halfW[i] = wmin > HALF_WIDTH ? HALF_WIDTH : (wmin < HALF_WIDTH_MIN ? HALF_WIDTH_MIN : wmin);
    }
    for (side = 0; side < 2; side++) {
      var sg = side ? 1 : -1, wo = wallOff[side], fl = wallFlag[side];
      wallOuter[side] = new Float64Array(N);
      for (i = 0; i < N; i++) {
        var th = roomRoad[side][i] - 0.05 - wo[i];
        th = th > WALL_THICK ? WALL_THICK : (th < 0.2 ? 0.2 : th);
        wallOuter[side][i] = Math.max(wo[i] + th, halfW[i]);
        fl[i] = wo[i] >= WALL_MIN ? 1 : 0;
        // crossing: no wall across the other road (it stops where it meets that road's own wall)
        if (fl[i] && partner[i] >= 0) {
          var wx = px[i] + nx[i] * sg * wo[i], wz = pz[i] + nz[i] * sg * wo[i];
          var lim2 = (WALL_DIST + WALL_THICK) * (WALL_DIST + WALL_THICK);
          for (q = -PARTNER_SPAN; q <= PARTNER_SPAN; q++) {
            j = (partner[i] + q + N) % N;
            var ex2 = px[j] - wx, ez2 = pz[j] - wz;
            if (ex2 * ex2 + ez2 * ez2 < lim2) { fl[i] = 0; break; }
          }
        }
      }
      dropShortRuns(fl, 2);
    }

    // --- offset lines. sign = +1 / -1, off = number or per-sample array (lateral distance >= 0).
    //     Clamped just short of the medial axis so strips never fold over.
    function line(sign, off) {
      var room = roomRoad[sign > 0 ? 1 : 0];
      var lx = new Float64Array(N), ly = new Float64Array(N), lz = new Float64Array(N);
      for (var u = 0; u < N; u++) {
        var o = typeof off === 'number' ? off : off[u];
        var cap = Math.max(1.0, room[u] - 0.04);
        var e = sign * (o < cap ? o : cap);
        lx[u] = px[u] + nx[u] * e; lz[u] = pz[u] + nz[u] * e; ly[u] = py[u] + e * tanB[u];
      }
      return { x: lx, y: ly, z: lz };
    }
    function shifted(arr, delta) {
      var o = new Float64Array(N);
      for (var u = 0; u < N; u++) o[u] = arr[u] + delta;
      return o;
    }
    var centre = { x: px, y: py, z: pz };
    var edge = [line(-1, halfW), line(1, halfW)];
    var wallIn = [line(-1, wallOff[0]), line(1, wallOff[1])];
    var wallOut = [line(-1, wallOuter[0]), line(1, wallOuter[1])];

    // --- paint masks (edge lines / kerbs are not drawn across another piece of road)
    function clearMask(sign, off, margin) {
      var m = new Uint8Array(N);
      for (var u = 0; u < N; u++) {
        var o = off[u] * sign, c = halfW[u] + margin;
        m[u] = nearestD2(px[u] + nx[u] * o, pz[u] + nz[u] * o) >= c * c ? 1 : 0;
      }
      return m;
    }
    var lineMask = [clearMask(-1, halfW, -0.5), clearMask(1, halfW, -0.5)];
    dropShortRuns(lineMask[0], 3); dropShortRuns(lineMask[1], 3);

    var kerbBase = new Uint8Array(N);
    for (i = 0; i < N; i++) {
      if (Math.abs(curv[i]) > KERB_CURV) {
        for (k = -3; k <= 3; k++) kerbBase[(i + k + N) % N] = 1;
      }
    }
    dropShortRuns(kerbBase, 8);
    var kerbMid = shifted(halfW, KERB_W / 2), kerbMask = [null, null];
    for (side = 0; side < 2; side++) {
      var kc = clearMask(side ? 1 : -1, kerbMid, 0.3);
      kerbMask[side] = new Uint8Array(N);
      for (i = 0; i < N; i++) {
        var fits = Math.min(wallOff[side][i], roomRoad[side][i]) >= halfW[i] + KERB_W + 0.1;
        kerbMask[side][i] = kerbBase[i] && kc[i] && fits ? 1 : 0;
      }
      dropShortRuns(kerbMask[side], 4);
    }

    // --- geometry buffers
    var C_WHITE = hexRGB(0xf2f2f2), C_RED = hexRGB(0xd0201c), C_BLACK = hexRGB(0x111111);
    var C_CONC_A = hexRGB(0xb9b9b4), C_CONC_B = hexRGB(0x9c9c98);
    var C_BAND_A = hexRGB(0xd0201c), C_BAND_B = hexRGB(0xf2f2f2), C_TOP = hexRGB(0x8a8a86);

    function pushV(buf, L, u, lift, c) {
      buf.pos.push(L.x[u], L.y[u] + lift, L.z[u]);
      buf.nrm.push(ux[u], uy[u], uz[u]);
      if (buf.col) buf.col.push(c[0], c[1], c[2]);
    }
    // Surface strip between two offset lines. A = lower-n side, B = higher-n side.
    function strip(buf, A, B, lift, mask, colorFn) {
      for (var u = 0; u < N; u++) {
        var w = (u + 1) % N;
        if (mask && !(mask[u] && mask[w])) continue;
        var c = colorFn ? colorFn(u) : C_WHITE;
        pushV(buf, A, u, lift, c); pushV(buf, A, w, lift, c); pushV(buf, B, u, lift, c);
        pushV(buf, B, u, lift, c); pushV(buf, A, w, lift, c); pushV(buf, B, w, lift, c);
      }
    }

    var roadBuf = newBuf(false, true), runoffBuf = newBuf(false, true), paintBuf = newBuf(true, true);
    var wallBuf = newBuf(true, false);

    strip(roadBuf, edge[0], centre, Y_ROAD, null, null);
    strip(roadBuf, centre, edge[1], Y_ROAD, null, null);

    strip(runoffBuf, edge[1], wallOut[1], 0, null, null);
    strip(runoffBuf, wallOut[0], edge[0], 0, null, null);

    var lineIn = shifted(halfW, -LINE_W), kerbOut = shifted(halfW, KERB_W);
    strip(paintBuf, line(1, lineIn), edge[1], Y_PAINT, lineMask[1], null);
    strip(paintBuf, edge[0], line(-1, lineIn), Y_PAINT, lineMask[0], null);

    function kerbColor(u) { return ((u >> 1) & 1) ? C_RED : C_WHITE; }
    strip(paintBuf, edge[1], line(1, kerbOut), Y_PAINT, kerbMask[1], kerbColor);
    strip(paintBuf, line(-1, kerbOut), edge[0], Y_PAINT, kerbMask[0], kerbColor);

    // start/finish chequer + grid slots, drawn in the local (tilted) frame of a sample
    function rect(idx, lat0, lat1, lon0, lon1, lift, c) {
      var lat = [lat0, lat0, lat1, lat1, lat0, lat1], lon = [lon0, lon1, lon0, lon0, lon1, lon1];
      for (var v = 0; v < 6; v++) {
        paintBuf.pos.push(px[idx] + nx[idx] * lat[v] + tx[idx] * lon[v],
                          py[idx] + lat[v] * tanB[idx] + lon[v] * grade[idx] + lift,
                          pz[idx] + nz[idx] * lat[v] + tz[idx] * lon[v]);
        paintBuf.nrm.push(ux[idx], uy[idx], uz[idx]);
        paintBuf.col.push(c[0], c[1], c[2]);
      }
    }
    var row, col, sq = halfW[0] / 7;
    for (row = 0; row < 2; row++) {
      for (col = 0; col < 14; col++) {
        rect(0, (col - 7) * sq, (col - 6) * sq, -0.8 + row * 0.8, row * 0.8, Y_START,
             ((row + col) & 1) ? C_WHITE : C_BLACK);
      }
    }
    var slots = Math.min(10, Math.floor(total / 4 / 8));
    for (k = 1; k <= slots; k++) {
      var gi = ((N - Math.round((k * 8) / ds)) % N + N) % N;
      if (halfW[gi] < 4.8) continue;
      var lat = (k & 1) ? 3 : -3;
      rect(gi, lat - 1.3, lat + 1.3, -0.25, 0, Y_START, C_WHITE);
      rect(gi, lat - 1.3, lat - 1.1, -1.6, -0.25, Y_START, C_WHITE);
      rect(gi, lat + 1.1, lat + 1.3, -1.6, -0.25, Y_START, C_WHITE);
    }

    // walls: bases follow the (banked) surface at their lateral offset, tops WALL_H above
    function buildWall(sd) {
      var I = wallIn[sd], O = wallOut[sd], mask = wallFlag[sd];
      function P(L, u, h) { return [L.x[u], L.y[u] + h, L.z[u]]; }
      for (var u = 0; u < N; u++) {
        if (!mask[u]) continue;
        var w = (u + 1) % N, p = (u - 1 + N) % N;
        var alt = (u >> 2) & 1;
        if (!mask[p] || !mask[w]) { // end cap
          quad(wallBuf, P(I, u, 0), P(O, u, 0), P(I, u, WALL_H), P(O, u, WALL_H), C_CONC_B);
        }
        if (!mask[w]) continue;
        var lo = alt ? C_CONC_A : C_CONC_B, hi = alt ? C_BAND_A : C_BAND_B;
        quad(wallBuf, P(I, u, 0), P(I, w, 0), P(I, u, WALL_BAND_Y), P(I, w, WALL_BAND_Y), lo);
        quad(wallBuf, P(I, u, WALL_BAND_Y), P(I, w, WALL_BAND_Y), P(I, u, WALL_H), P(I, w, WALL_H), hi);
        quad(wallBuf, P(O, u, 0), P(O, w, 0), P(O, u, WALL_BAND_Y), P(O, w, WALL_BAND_Y), lo);
        quad(wallBuf, P(O, u, WALL_BAND_Y), P(O, w, WALL_BAND_Y), P(O, u, WALL_H), P(O, w, WALL_H), hi);
        if (sd) quad(wallBuf, P(I, u, WALL_H), P(I, w, WALL_H), P(O, u, WALL_H), P(O, w, WALL_H), C_TOP);
        else quad(wallBuf, P(O, u, WALL_H), P(O, w, WALL_H), P(I, u, WALL_H), P(I, w, WALL_H), C_TOP);
      }
    }
    buildWall(1);
    buildWall(0);

    // --- terrain: a height field that passes just under the track wherever the track is, is
    //     interpolated smoothly everywhere else, plus a verge ("skirt") from the outer foot of the
    //     walls that eases down into it. The field can never rise above the track it passes under.
    var cellT = Math.max(TERRAIN_CELL_MIN,
      Math.sqrt((maxX - minX + 2 * TERRAIN_PAD) * (maxZ - minZ + 2 * TERRAIN_PAD) / TERRAIN_MAX_VERTS));
    var tx0 = minX - TERRAIN_PAD, tz0 = minZ - TERRAIN_PAD;
    var nIx = Math.ceil((maxX - minX + 2 * TERRAIN_PAD) / cellT) + 1;
    var nIz = Math.ceil((maxZ - minZ + 2 * TERRAIN_PAD) / cellT) + 1;
    var TW = nIx + 2 * TERRAIN_RINGS, TH = nIz + 2 * TERRAIN_RINGS;
    function axis(o, n) {
      var c = new Float64Array(n + 2 * TERRAIN_RINGS), u, w = cellT;
      for (u = 0; u < n; u++) c[TERRAIN_RINGS + u] = o + u * cellT;
      for (u = 1; u <= TERRAIN_RINGS; u++) {
        w *= TERRAIN_RING_GROW;
        c[TERRAIN_RINGS - u] = c[TERRAIN_RINGS - u + 1] - w;
        c[TERRAIN_RINGS + n - 1 + u] = c[TERRAIN_RINGS + n - 2 + u] + w;
      }
      return c;
    }
    var tgx = axis(tx0, nIx), tgz = axis(tz0, nIz);
    var tH = new Float64Array(TW * TH).fill(Infinity), tFix = new Float64Array(TW * TH);
    function stamp(x, z, h) {
      var ix = Math.floor((x - tx0) / cellT), iz = Math.floor((z - tz0) / cellT);
      if (ix < 0) ix = 0; else if (ix > nIx - 2) ix = nIx - 2;
      if (iz < 0) iz = 0; else if (iz > nIz - 2) iz = nIz - 2;
      var c = (iz + TERRAIN_RINGS) * TW + ix + TERRAIN_RINGS;
      if (h < tH[c]) tH[c] = h;
      if (h < tH[c + 1]) tH[c + 1] = h;
      if (h < tH[c + TW]) tH[c + TW] = h;
      if (h < tH[c + TW + 1]) tH[c + TW + 1] = h;
    }
    for (i = 0; i < N; i++) {
      var dLo = -(wallOuter[0][i] + 0.3), dHi = wallOuter[1][i] + 0.3;
      var nSt = Math.ceil((dHi - dLo) / 2);
      for (k = 0; k <= nSt; k++) {
        var dd = dLo + (dHi - dLo) * k / nSt;
        stamp(px[i] + nx[i] * dd, pz[i] + nz[i] * dd, py[i] + dd * tanB[i] - TERRAIN_EPS);
      }
    }
    for (i = 0; i < TW * TH; i++) { if (tH[i] < Infinity) tFix[i] = 1; else tH[i] = 0; }
    pullPush(tH, tFix, TW, TH);
    for (k = 0; k < 6; k++) {       // relax the filled-in part a little
      for (var gz = 1; gz < TH - 1; gz++) {
        for (var gx = 1; gx < TW - 1; gx++) {
          i = gz * TW + gx;
          if (!tFix[i]) tH[i] = 0.25 * (tH[i - 1] + tH[i + 1] + tH[i - TW] + tH[i + TW]);
        }
      }
    }
    function axisCell(c, n, v) {       // index of the grid interval containing v (clamped)
      var lo = 0, hi = n - 2;
      if (v <= c[0]) return 0;
      if (v >= c[n - 1]) return hi;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (c[mid] <= v) lo = mid; else hi = mid - 1; }
      return lo;
    }
    // Height of the terrain grid at (x, z); follows the mesh triangles exactly.
    function terrainAt(x, z) {
      var ix, iz;
      if (x >= tx0 && x < tx0 + (nIx - 1) * cellT) ix = TERRAIN_RINGS + Math.floor((x - tx0) / cellT);
      else ix = axisCell(tgx, TW, x);
      if (z >= tz0 && z < tz0 + (nIz - 1) * cellT) iz = TERRAIN_RINGS + Math.floor((z - tz0) / cellT);
      else iz = axisCell(tgz, TH, z);
      if (ix > TW - 2) ix = TW - 2; if (iz > TH - 2) iz = TH - 2;
      var fx = (x - tgx[ix]) / (tgx[ix + 1] - tgx[ix]), fz = (z - tgz[iz]) / (tgz[iz + 1] - tgz[iz]);
      fx = fx < 0 ? 0 : (fx > 1 ? 1 : fx); fz = fz < 0 ? 0 : (fz > 1 ? 1 : fz);
      var c = iz * TW + ix, h00 = tH[c], h10 = tH[c + 1], h01 = tH[c + TW], h11 = tH[c + TW + 1];
      if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
      return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
    }

    var gridVerts = TW * TH, SK_ROWS = 3, SK_F = [0, 0.4, 1], SK_B = [0, 0.3, 1];
    var gPos = new Float32Array((gridVerts + N * 2 * SK_ROWS) * 3);
    var skO = [new Float64Array(N), new Float64Array(N)], skU = [new Float64Array(N), new Float64Array(N)];
    var skH = [new Float64Array(N * SK_ROWS), new Float64Array(N * SK_ROWS)];
    var gIdx = new Uint32Array(((TW - 1) * (TH - 1) + N * 2 * (SK_ROWS - 1)) * 6), gi2 = 0;
    for (var vz2 = 0; vz2 < TH; vz2++) {
      for (var vx2 = 0; vx2 < TW; vx2++) {
        i = vz2 * TW + vx2;
        gPos[i * 3] = tgx[vx2]; gPos[i * 3 + 1] = tH[i]; gPos[i * 3 + 2] = tgz[vz2];
        if (vx2 < TW - 1 && vz2 < TH - 1) {
          gIdx[gi2++] = i; gIdx[gi2++] = i + TW; gIdx[gi2++] = i + 1;
          gIdx[gi2++] = i + 1; gIdx[gi2++] = i + TW; gIdx[gi2++] = i + TW + 1;
        }
      }
    }
    for (side = 0; side < 2; side++) {
      var sg2 = side ? 1 : -1, base = gridVerts + side * N * SK_ROWS;
      for (i = 0; i < N; i++) {
        var o0 = Math.min(wallOuter[side][i], Math.max(1.0, roomRoad[side][i] - 0.04));
        var U = roomAll[side][i] - o0 - 0.3;
        U = U < 0 ? 0 : (U > SKIRT_W ? SKIRT_W : U);
        var h0 = py[i] + sg2 * o0 * tanB[i];
        skO[side][i] = o0; skU[side][i] = U;
        for (k = 0; k < SK_ROWS; k++) {
          var e = sg2 * (o0 + U * SK_F[k]);
          var x = px[i] + nx[i] * e, z = pz[i] + nz[i] * e, v = (base + i * SK_ROWS + k) * 3;
          gPos[v] = x; gPos[v + 2] = z;
          gPos[v + 1] = skH[side][i * SK_ROWS + k] = k === 0 ? h0 : h0 + (terrainAt(x, z) - 0.4 - h0) * SK_B[k];
        }
      }
      for (i = 0; i < N; i++) {
        var w2 = (i + 1) % N;
        for (k = 0; k < SK_ROWS - 1; k++) {
          // a = lower-n vertex row, b = higher-n vertex row
          var a0 = base + i * SK_ROWS + (side ? k : k + 1), b0 = base + i * SK_ROWS + (side ? k + 1 : k);
          var a1 = base + w2 * SK_ROWS + (side ? k : k + 1), b1 = base + w2 * SK_ROWS + (side ? k + 1 : k);
          gIdx[gi2++] = a0; gIdx[gi2++] = a1; gIdx[gi2++] = b0;
          gIdx[gi2++] = b0; gIdx[gi2++] = a1; gIdx[gi2++] = b1;
        }
      }
    }

    // --- meshes
    var group = new THREE.Group();
    group.name = 'track';

    function finish(g) {
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    }
    function makeGeometry(buf) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.pos), 3));
      if (buf.col) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(buf.col), 3));
      if (buf.nrm) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf.nrm), 3));
      else g.computeVertexNormals();
      return finish(g);
    }
    function addMesh(name, geo, matOpts, order) {
      var mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial(matOpts));
      mesh.name = name;
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      return mesh;
    }

    var groundGeo = new THREE.BufferGeometry();
    groundGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
    groundGeo.setIndex(new THREE.BufferAttribute(gIdx, 1));
    groundGeo.computeVertexNormals();
    addMesh('ground', finish(groundGeo),
      { color: 0x3f7f34, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }, 0);
    addMesh('runoff', makeGeometry(runoffBuf),
      { color: 0x6d7268, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }, 1);
    addMesh('road', makeGeometry(roadBuf), { color: 0x2b2b2e }, 2);
    addMesh('paint', makeGeometry(paintBuf),
      { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 3);
    addMesh('walls', makeGeometry(wallBuf), { vertexColors: true, side: THREE.DoubleSide }, 4);

    // --- samples
    var samples = new Array(N);
    for (i = 0; i < N; i++) {
      samples[i] = {
        x: px[i], z: pz[i], tx: tx[i], tz: tz[i], nx: nx[i], nz: nz[i], s: sArr[i],
        wallPos: !!wallFlag[1][i], wallNeg: !!wallFlag[0][i],
        y: py[i], bank: bank[i], grade: grade[i],
        wallPosDist: wallOff[1][i], wallNegDist: wallOff[0][i], halfW: halfW[i]
      };
    }

    function surfaceY(index, d) {
      index = ((index | 0) % N + N) % N;
      return py[index] + d * tanB[index];
    }

    // Nearest centreline sample to any world point (global): {index, dist, d}. d = signed lateral offset.
    function nearest(x, z) {
      var best = -1, bd = Infinity;
      for (var reach = 1; reach <= 3 && best < 0; reach += 2) {
        forNear(x, z, reach, function (s) {
          var ex = px[s] - x, ez = pz[s] - z, dd = ex * ex + ez * ez;
          if (dd < bd) { bd = dd; best = s; }
        });
        if (best >= 0 && bd > reach * GRID_CELL * reach * GRID_CELL) best = -1;   // not yet provably the nearest
      }
      if (best < 0) {
        bd = Infinity;
        for (var u = 0; u < N; u++) {
          var ex = px[u] - x, ez = pz[u] - z, dd = ex * ex + ez * ez;
          if (dd < bd) { bd = dd; best = u; }
        }
      }
      return { index: best, dist: Math.sqrt(bd), d: (x - px[best]) * nx[best] + (z - pz[best]) * nz[best] };
    }

    // True if (x, z) is inside the track corridor (road + runoff + walls of any part of the track),
    // grown by `margin` metres. Scenery must keep out of it.
    function inCorridor(x, z, margin) {
      var n = nearest(x, z);
      return n.dist <= wallOuter[n.d > 0 ? 1 : 0][n.index] + (margin || 0);
    }

    // Height of the rendered ground at any world point: the track surface inside the corridor,
    // the verge outside the walls, the terrain everywhere else.
    function groundY(x, z) {
      var n = nearest(x, z);
      if (n.dist > WALL_DIST + WALL_THICK + SKIRT_W + 2) return terrainAt(x, z);
      var sd = n.d > 0 ? 1 : 0, ad = Math.abs(n.d), u = n.index;
      if (ad <= skO[sd][u] + 1e-6) return py[u] + n.d * tanB[u];
      var t = terrainAt(x, z), U = skU[sd][u];
      if (U < 1e-6 || ad >= skO[sd][u] + U) return t;
      var f = (ad - skO[sd][u]) / U, h = skH[sd], b = u * SK_ROWS, v;
      if (f <= SK_F[1]) v = h[b] + (h[b + 1] - h[b]) * (f / SK_F[1]);
      else v = h[b + 1] + (h[b + 2] - h[b + 1]) * ((f - SK_F[1]) / (1 - SK_F[1]));
      return v > t ? v : t;
    }

    function locate(x, z, hintIndex) {
      var best = 0, bestD = Infinity, u, dxx, dzz, dd;
      if (hintIndex >= 0 && hintIndex < N && 2 * LOCATE_WINDOW + 1 < N) {
        var start = (hintIndex | 0) - LOCATE_WINDOW;
        for (var w = 0; w <= 2 * LOCATE_WINDOW; w++) {
          u = start + w;
          if (u < 0) u += N; else if (u >= N) u -= N;
          dxx = x - px[u]; dzz = z - pz[u]; dd = dxx * dxx + dzz * dzz;
          if (dd < bestD) { bestD = dd; best = u; }
        }
      } else {
        for (u = 0; u < N; u++) {
          dxx = x - px[u]; dzz = z - pz[u]; dd = dxx * dxx + dzz * dzz;
          if (dd < bestD) { bestD = dd; best = u; }
        }
      }
      return { index: best, d: (x - px[best]) * nx[best] + (z - pz[best]) * nz[best] };
    }

    function dispose() {
      for (var u = group.children.length - 1; u >= 0; u--) {
        var m = group.children[u];
        if (m.geometry) m.geometry.dispose();
        var mats = Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []);
        for (var w = 0; w < mats.length; w++) {
          if (mats[w].map) mats[w].map.dispose();
          mats[w].dispose();
        }
        group.remove(m);
      }
      if (group.parent) group.parent.remove(group);
    }

    return {
      group: group,
      samples: samples,
      length: total,
      halfWidth: HALF_WIDTH,
      wallDist: WALL_DIST,
      crossings: crossings,
      surfaceY: surfaceY,
      groundY: groundY,
      terrainY: terrainAt,   // terrain height field only (valid away from the track corridor)
      nearest: nearest,
      inCorridor: inCorridor,
      locate: locate,
      dispose: dispose
    };
  };
})(typeof window !== 'undefined' ? window : this);
