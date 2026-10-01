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

  // ---- starting grid: the painted boxes; track.grid tells main.js where the cars go
  var GRID_SLOTS = 16;       // boxes = players a room holds
  var GRID_GAP = 8;          // metres between the front bars of two consecutive boxes (they alternate sides)
  var GRID_SIDE = 3;         // lateral offset of a box centreline from the track centreline
  var GRID_EDGE = 1.8;       // ... but a box centreline stays at least this far inside the road edge
  var GRID_BOX_W = 1.3;      // half width of a box
  var GRID_BAR = 0.25;       // thickness of the front bar
  var GRID_BOX_LEN = 1.6;    // the side brackets reach this far back from the front of the bar
  var GRID_CAR_LEN = 5.6;    // length of the car standing behind the bar (for the narrowest-road lookup)

  // ---- pit lane (track.pit): beside the start / finish straight, see "pit lane" in buildTrack
  var PIT_REACH = 250;       // the lane reaches this far before and after the line (m), less where the track forces it
  var PIT_SCAN = 460;        // room for it is looked for this far along the lap each way (m)
  var PIT_DATA_R = 200;      // scenery 'pit' buildings further than this from the centreline do not pick the side
  var PIT_SLOTS = 16;        // boxes = players a room holds
  var PIT_TAPER = 80;        // the lane peels off the track edge / rejoins it over this length (m) ...
  var PIT_TAPER_MIN = 60;    // ... never shorter, and never shorter than PIT_TAPER_SLOPE x its lateral travel
  var PIT_TAPER_SLOPE = 5.2; //   (the outer wall then moves out at most ~0.36 m per metre, like the other walls)
  var PIT_LINE_GAP = 6;      // entry line this far after the entry taper, exit line this far before the exit taper
  var PIT_BOX_LEN = 7;       // painted box, along the lane
  var PIT_PITCH_MIN = 7.5, PIT_PITCH_MAX = 11;   // spacing of the boxes
  var PIT_BOX_MARGIN = 12;   // the boxes keep this far from the entry / exit line: no car stopped in a box stands in or
                             //   next to a light curtain, which would fill the driver's view (13 is all Monaco has room for)
  var PIT_RAMP = 20;         // the outer wall moves out to the garage face (and back) over this length (m)
  var PIT_WALL_HALF_T = 0.4, PIT_WALL_H = 1.1;
  var PIT_LANE_GAP = 0.3;    // between the pit wall and the lane's inner edge
  var PIT_OUT_GAP = 0.6;     // outer wall this far beyond the lane's outer edge where there are no boxes
  var PIT_OUT_T = 0.5;       // thickness of the outer wall / garage face
  var PIT_SOFT = 1.5;        // the outer wall eases off / back onto the track's own wall over +-this (m)
  var PIT_ROOM_MARGIN = 1.5; // the whole complex stays this far inside the medial axis (other roads, bends)
  var PIT_LAT_MAX = 8;       // m/s^2 on the lane centre at 80 km/h ...
  var PIT_LAT_MAX_60 = 12;   // ... and at 60 (a lane that has to follow a bend; the car has ~21 on asphalt there)
  var PIT_GARAGE_H = 6, PIT_DOOR_H = 4.2;   // garage face (the start gantry passes over at 6.5 m)
  var PIT_CURTAIN_H = 7.5;   // light curtains at the entry / exit line
  var PIT_LINE_W = 0.2;
  // cross-sections, tried from wide to narrow: [pit wall face offset, lane half width, box strip depth]
  var PIT_VARIANTS = [[12, 3.5, 5.0], [10, 3.5, 5.0], [8.5, 3.0, 4.4]];

  // ---- elevation / banking
  var Y_SMOOTH_PASSES = 40;  // extra [1,2,1]/4 passes on the height profile (sigma ~9 m)
  // Cap of the banking derived from curvature (degrees); trackData.bankMaxDeg overrides it (1.5 on street circuits).
  // 2.5 since 2026-10-01 (was 6): lidar cross-slopes at 14 circuits measure 0-2.4 deg in hairpins and chicanes, and the
  // real banked / cambered corners come as trackData.bankOverrides (docs/track-audit.md).
  var BANK_MAX_DEG = 2.5;
  var BANK_GAIN = 5.0;       // rad of bank per unit curvature (1/m): radius 100 m -> ~2 deg (saturating at the cap)
  var BANK_SMOOTH_PASSES = 32; // sigma ~8 m, i.e. transitions spread over ~35 m
  // Real banked corners (trackData.bankOverrides, from tools/build-tracks.mjs): the full angle between the lap fractions
  // `from` and `to`, eased in / out from the derived banking over BANK_RAMP metres outside them (C2 ease).
  var BANK_RAMP = 35;
  var BANK_OVERRIDE_MAX = 30 * Math.PI / 180;   // sanity cap on the data

  // ---- self-crossing (Suzuka). Where the two roads are at about the same height (a junction) both are blended to one
  //      flat height around the crossing; where one passes over the other (trackData heights CROSS_SEP_MIN or more
  //      apart: Suzuka's crossover, 6.2 m) both keep their heights, the upper road is a bridge (deck, parapets = its
  //      walls, abutments beside the lower road) and locate / nearest / groundY take the level closest to a given y.
  var CROSS_DIST = 2.5;      // two non-adjacent samples this close = the centreline crosses itself
  var CROSS_MIN_SEP = 60;    // samples; "non-adjacent"
  var CROSS_ZONE = 40;       // samples each side of the crossing treated as the crossing zone
  var CROSS_FLAT_R = 26;     // m of arc each side that is exactly level
  var CROSS_BLEND_R = 240;   // m of arc over which the height eases back to the real profile
  var CROSS_SEP_MIN = 3.0;   // m: two roads this far apart in height at the crossing = a bridge, not a junction
  var BRIDGE_SEP = 6.0;      // m: the upper road is raised (smoothly) where it is less than this above the lower one
  var BRIDGE_DECK_T = 0.9;   // deck thickness under the road surface (clearance = separation - this)
  var BRIDGE_GAP = 0.6;      // the deck is drawn where the terrain is more than this below the road
  var ABUT_GAP = 0.6, ABUT_T = 1.0;   // abutment walls: this far behind the lower road's walls, this thick

  // ---- narrow stretches (trackData.widthOverrides: Baku's castle section): road half width capped, walls moved in
  var WIDTH_RAMP = 40;       // m over which the road widens back to normal past each end (< 0.35 m per 2 m sample)
  var WIDTH_WALL_RAMP = 50;  // m over which the walls move back out (< 0.6 m per sample, like the other walls)
  var WIDTH_WALL_GAP = WALL_ROAD_MARGIN;   // wall inner face this far outside the road edge (as everywhere: the car's
                             // centre can use the road's whole width, 7.6 m at Baku's castle, walls 9.6 m apart)

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
  // C2 ease (zero slope and curvature at both ends): the pit lane tapers
  function smootherstep(t) { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * t * (t * (t * 6 - 15) + 10); }
  // C1 "max(0, x)" with the corner rounded over +-s: exactly 0 below -s, exactly x above s, never below either
  function softPos(x, s) { return x <= -s ? 0 : (x >= s ? x : (x + s) * (x + s) / (4 * s)); }

  // 7-segment digits (bits a..g = 0..6), for the numbers painted in the pit lane
  var SEG7 = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

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

  // The real pit lane speed limit of trackData in season `year` (km/h): trackData.pitLimits [{from?, to?, kmh}] (season
  // years, inclusive) where one matches, else trackData.pitLimitKmh (the current layout's), else 80. A year that is not
  // a number gives the current one.
  function realPitLimit(trackData, year) {
    var def = trackData && +trackData.pitLimitKmh > 0 ? +trackData.pitLimitKmh : 80;
    var list = trackData && trackData.pitLimits, y = +year;
    if (!Array.isArray(list) || year === null || year === undefined || !isFinite(y)) return def;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !(+e.kmh > 0)) continue;
      if ((e.from === undefined || y >= +e.from) && (e.to === undefined || y <= +e.to)) return +e.kmh;
    }
    return def;
  }
  F1.pitLimitFor = realPitLimit;   // (trackData, year) -> km/h, before the lane geometry's own cap (see track.pit.limitFor)

  // opts (optional): { year } = the session's season (the pit lane limit and its painted signs are that season's;
  // track.pit.setYear changes it later).
  F1.buildTrack = function (trackData, opts) {
    var THREE = global.THREE;
    var pts = cleanPoints((trackData && trackData.points) || [], trackData && trackData.elev);
    if (pts.length < 3) throw new Error('F1.buildTrack: track needs at least 3 distinct points');
    var BANK_MAX = (trackData && +trackData.bankMaxDeg > 0 ? Math.min(+trackData.bankMaxDeg, 10) : BANK_MAX_DEG) * Math.PI / 180;
    var buildYear = opts && opts.year !== undefined && opts.year !== null && isFinite(+opts.year) ? +opts.year : null;

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

    // A crossing where the two roads are CROSS_SEP_MIN or more apart in height is a bridge: both keep their heights (the
    // upper one raised smoothly to BRIDGE_SEP above the lower one where the data has less). sepP[i] = 1 on both branches
    // of such a crossing (where partner[i] is set); bridges = [{up, lo}] (sample of each road at the crossing point).
    // Any other crossing: level both roads to a common height around it so the two surfaces coincide.
    var flatW = new Float64Array(N), sepP = new Uint8Array(N), bridges = [];
    for (k = 0; k < crossings.length; k++) {
      var dyc = py[crossings[k][0]] - py[crossings[k][1]];
      var span = Math.min((N >> 1) - 1, Math.ceil((CROSS_FLAT_R + CROSS_BLEND_R) / ds));
      if (Math.abs(dyc) >= CROSS_SEP_MIN) {
        var bUp = dyc > 0 ? crossings[k][0] : crossings[k][1], bLo = dyc > 0 ? crossings[k][1] : crossings[k][0];
        var lift = BRIDGE_SEP - Math.abs(dyc);
        if (lift > 0) {
          for (q = -span; q <= span; q++) {
            py[(bUp + q + N) % N] += lift * (1 - smoothstep((Math.abs(q) * ds - CROSS_FLAT_R) / CROSS_BLEND_R));
          }
        }
        for (var w0 = -CROSS_ZONE; w0 <= CROSS_ZONE; w0++) { sepP[(bUp + w0 + N) % N] = 1; sepP[(bLo + w0 + N) % N] = 1; }
        bridges.push({ up: bUp, lo: bLo, sep: Math.abs(dyc) + Math.max(0, lift) });
        continue;
      }
      var hc = 0.5 * (py[crossings[k][0]] + py[crossings[k][1]]);
      for (var br = 0; br < 2; br++) {
        for (q = -span; q <= span; q++) {
          i = (crossings[k][br] + q + N) % N;
          var wgt = 1 - smoothstep((Math.abs(q) * ds - CROSS_FLAT_R) / CROSS_BLEND_R);
          py[i] += (hc - py[i]) * wgt;
          if (wgt > flatW[i]) flatW[i] = wgt;
        }
      }
    }

    // The sample at fraction f of the input polyline's arc length (trackData's bankOverrides / widthOverrides are given
    // so): that point, then the nearest sample in a window around the same fraction of the samples.
    var cumP = null;
    function sampleAtFrac(f) {
      var np = pts.length, u;
      if (!cumP) {
        cumP = [0];
        for (u = 0; u < np; u++) {
          var pa = pts[u], pb = pts[(u + 1) % np];
          cumP.push(cumP[u] + Math.hypot(pb[0] - pa[0], pb[1] - pa[1]));
        }
      }
      f = f - Math.floor(f);
      var s = f * cumP[np], a = 0;
      while (a < np - 1 && cumP[a + 1] <= s) a++;
      var p0 = pts[a], p1 = pts[(a + 1) % np], t = (s - cumP[a]) / ((cumP[a + 1] - cumP[a]) || 1);
      var x = p0[0] + (p1[0] - p0[0]) * t, z = p0[1] + (p1[1] - p0[1]) * t;
      var hint = Math.round(f * N), win = Math.max(40, Math.round(N * 0.03)), best = hint % N, bd = Infinity;
      for (var q2 = -win; q2 <= win; q2++) {
        var c = ((hint + q2) % N + N) % N, ex = px[c] - x, ez = pz[c] - z, dd = ex * ex + ez * ez;
        if (dd < bd) { bd = dd; best = c; }
      }
      return best;
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
    for (i = 0; i < N; i++) bank[i] = bankRaw[i] * (1 - flatW[i]);
    applyBankOverrides(trackData && trackData.bankOverrides);
    for (i = 0; i < N; i++) tanB[i] = Math.tan(bank[i]);

    // Real banked corners: each override's ends are found on the samples (the point at that fraction of the input
    // polyline's arc length, nearest sample in a window around the same fraction of the samples), the side from the
    // corner's direction (net curvature over the section: turning towards +n -> the +n side is the inside, lower ->
    // negative bank), then bank = derived * (1 - w) + full * w with w = 1 on the section and a C2 ease outside it.
    function applyBankOverrides(list) {
      if (!Array.isArray(list) || !list.length) return;
      var u, v, sampleAt = sampleAtFrac;
      var w = new Float64Array(N), full = new Float64Array(N), rampN = Math.ceil(BANK_RAMP / ds);
      for (u = 0; u < list.length; u++) {
        var o = list[u], deg = o ? +o.deg : NaN;
        if (!o || !isFinite(o.from) || !isFinite(o.to) || !isFinite(deg) || deg === 0) continue;
        var ang = Math.min(Math.abs(deg) * Math.PI / 180, BANK_OVERRIDE_MAX) * (deg < 0 ? -1 : 1);
        var ia = sampleAt(+o.from), ib = sampleAt(+o.to), len = ((ib - ia) % N + N) % N, net = 0;
        if (len < 2 || len > N / 2) continue;
        for (v = 0; v <= len; v++) net += curv[(ia + v) % N];
        var b = net > 0 ? -ang : ang;          // deg > 0: inside of the corner lower
        for (v = -rampN; v <= len + rampN; v++) {
          var k2 = ((ia + v) % N + N) % N;
          var d = v < 0 ? -v * ds : (v > len ? (v - len) * ds : 0);
          var wt = 1 - smootherstep(d / BANK_RAMP);
          if (wt > w[k2]) { w[k2] = wt; full[k2] = b; }
        }
      }
      for (u = 0; u < N; u++) if (w[u] > 0) bank[u] = bank[u] * (1 - w[u]) + full[u] * w[u];
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
    // Narrow stretches (trackData.widthOverrides [{name, from, to, halfW}], lap fractions): the road's half width is
    // capped at halfW from `from` to `to` and eases back out over WIDTH_RAMP; the walls stand WIDTH_WALL_GAP outside the
    // road edge there and ease back out over WIDTH_WALL_RAMP (never inside the road edge on the way).
    var capWall = null, capHW = null;
    (function (list) {
      if (!Array.isArray(list) || !list.length) return;
      for (var u = 0; u < list.length; u++) {
        var o = list[u], hw = o ? +o.halfW : NaN;
        if (!o || !isFinite(o.from) || !isFinite(o.to) || !(hw > 0)) continue;
        hw = Math.max(HALF_WIDTH_MIN, Math.min(HALF_WIDTH, hw));
        var ia = sampleAtFrac(+o.from), ib = sampleAtFrac(+o.to), len = ((ib - ia) % N + N) % N;
        if (len < 1 || len > N / 2) continue;
        if (!capWall) { capWall = new Float64Array(N).fill(Infinity); capHW = new Float64Array(N).fill(Infinity); }
        var rw = Math.ceil(WIDTH_WALL_RAMP / ds);
        for (var v = -rw; v <= len + rw; v++) {
          var kk = ((ia + v) % N + N) % N, d = v < 0 ? -v * ds : (v > len ? (v - len) * ds : 0);
          var c = hw + (HALF_WIDTH - hw) * smootherstep(d / WIDTH_RAMP);
          var cw = Math.max(c + WIDTH_WALL_GAP, hw + WIDTH_WALL_GAP + (WALL_DIST - hw - WIDTH_WALL_GAP) * smootherstep(d / WIDTH_WALL_RAMP));
          if (c < capHW[kk]) capHW[kk] = c;
          if (cw < capWall[kk]) capWall[kk] = cw;
        }
      }
      if (!capWall) return;
      for (var i2 = 0; i2 < N; i2++) {
        if (capHW[i2] < halfW[i2]) halfW[i2] = capHW[i2];
        for (var s2 = 0; s2 < 2; s2++) if (capWall[i2] < wallOff[s2][i2]) wallOff[s2][i2] = capWall[i2];
      }
    })(trackData && trackData.widthOverrides);
    for (side = 0; side < 2; side++) {
      var sg = side ? 1 : -1, wo = wallOff[side], fl = wallFlag[side];
      wallOuter[side] = new Float64Array(N);
      for (i = 0; i < N; i++) {
        var th = roomRoad[side][i] - 0.05 - wo[i];
        th = th > WALL_THICK ? WALL_THICK : (th < 0.2 ? 0.2 : th);
        wallOuter[side][i] = Math.max(wo[i] + th, halfW[i]);
        // (a narrow stretch keeps its walls although they stand closer than WALL_MIN)
        fl[i] = wo[i] >= (capWall && capWall[i] < Infinity ? Math.min(WALL_MIN, halfW[i] + 0.3) : WALL_MIN) ? 1 : 0;
        // crossing: no wall across the other road (it stops where it meets that road's own wall); a bridge keeps the
        // walls of both roads (the upper road's are its parapets, the lower road's run on under the deck)
        if (fl[i] && partner[i] >= 0 && !sepP[i]) {
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

    // --- paint masks (edge lines / kerbs are not drawn across another piece of road; at a bridge the other road is on
    //     another level and does not count)
    function clearMask(sign, off, margin) {
      var m = new Uint8Array(N);
      for (var u = 0; u < N; u++) {
        var o = off[u] * sign, c = halfW[u] + margin, x = px[u] + nx[u] * o, z = pz[u] + nz[u] * o;
        if (!sepP[u]) { m[u] = nearestD2(x, z) >= c * c ? 1 : 0; continue; }
        var best = Infinity, pu = partner[u];
        forNear(x, z, 1, function (s) {
          if (cyc(s, pu) <= PARTNER_SPAN) return;
          var ddx = px[s] - x, ddz = pz[s] - z, dd = ddx * ddx + ddz * ddz;
          if (dd < best) best = dd;
        });
        m[u] = best >= c * c ? 1 : 0;
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

    // --- pit lane. Beside the start / finish straight, on the side of the real pit buildings (scenery data) or else
    //     the side with room, from up to PIT_REACH before the line to PIT_REACH after it, following the centreline as
    //     an offset curve. Cross-section from the track outwards: runoff, pit wall (open where the lane peels off /
    //     rejoins through its tapers), the lane, the strip of PIT_SLOTS boxes, the garage face = outer wall.
    //     Offsets below are positive away from the track on the pit side; `k` counts samples from `from`.
    //     The whole complex stays PIT_ROOM_MARGIN inside the medial axis (roomAll): it never folds in a bend, never
    //     meets another part of the circuit, and nearest() / locate() keep finding this stretch for a car in it.
    //     Everything above (road, kerbs, lines, grid) was built without it; from here on the track's own wall on that
    //     side (wallOff / wallOuter / wallFlag: samples, runoff, terrain, inCorridor, groundY) is the complex's outer wall.
    var pitL = null;
    (function () {
      var span = Math.min(Math.round(PIT_SCAN / ds), (N >> 1) - 2), reach = Math.min(Math.round(PIT_REACH / ds), span);
      if (span < 8) return;
      function wq(q) { return ((q % N) + N) % N; }

      // side of the real pit lane: trackData.pitSide where the track data gives it (tracks without pit buildings in the
      // scenery data), else the side of the real pit buildings next to the line, weighted by footprint area
      var pref = 0, sc = global.F1_SCENERY, data = sc && trackData && trackData.id ? sc[trackData.id] : null;
      if (trackData && (trackData.pitSide === 1 || trackData.pitSide === -1)) pref = trackData.pitSide;
      else if (data && Array.isArray(data.buildings)) {
        var acc = 0;
        for (var b = 0; b < data.buildings.length; b++) {
          var bl = data.buildings[b], p = bl && bl.p;
          if (!bl || bl.k !== 'pit' || !Array.isArray(p) || p.length < 3) continue;
          var cx = 0, cz = 0, ar = 0, m = p.length, e, ok = true;
          for (e = 0; e < m; e++) {
            var p0 = p[e], p1 = p[(e + 1) % m];
            if (!p0 || !p1 || !isFinite(p0[0]) || !isFinite(p0[1]) || !isFinite(p1[0]) || !isFinite(p1[1])) { ok = false; break; }
            cx += p0[0]; cz += p0[1]; ar += p0[0] * p1[1] - p1[0] * p0[1];
          }
          if (!ok) continue;
          var nb = nearest(cx / m, cz / m), off = nb.index > N / 2 ? nb.index - N : nb.index;
          if (Math.abs(off) > span || nb.dist > PIT_DATA_R) continue;
          acc += (nb.d > 0 ? 1 : -1) * Math.max(1, Math.abs(ar) / 2);
        }
        pref = acc > 0 ? 1 : (acc < 0 ? -1 : 0);
      }
      // else the inside of the lap first (as scenery.js puts its procedural pit building)
      var area = 0;
      for (var u = 0; u < N; u++) { var w = (u + 1) % N; area += px[u] * pz[w] - px[w] * pz[u]; }
      // What is tried, in this order: [cross-section, limit, late]. A full lane at 80 km/h, then less runoff in front of
      // the pit wall, then the narrow lane, then the same at 60 km/h (a lane that has to follow more of a bend). The
      // side of the pit buildings first, all of it; without data both sides for each option, the inside of the lap
      // first. Last resort ('late'): the lane still starts before the line, but its entry line may come after it.
      // The limit reported (and painted) is the lower of the layout's and trackData.pitLimitKmh (the real limit where
      // it is below 80: Monaco, Singapore).
      var opts = [[0, 80], [1, 80], [2, 80], [0, 60], [1, 60], [2, 60]], tries = [], t, v;
      var inside = area > 0 ? -1 : 1, first = pref || inside, dbg = Array.isArray(F1.PIT_DEBUG) ? F1.PIT_DEBUG : null;
      for (v = 0; v < opts.length; v++) {
        tries.push([first, opts[v][0], opts[v][1], false]);
        if (!pref) tries.push([-first, opts[v][0], opts[v][1], false]);
      }
      if (pref) for (v = 0; v < opts.length; v++) tries.push([-first, opts[v][0], opts[v][1], false]);
      tries.push([first, 2, 60, true], [-first, 2, 60, true]);
      for (t = 0; t < tries.length && !pitL; t++) pitL = layout(tries[t][0], tries[t][1], tries[t][2], tries[t][3]);
      if (pitL) {
        pitL.layoutLimit = pitL.limit;             // what the lane's geometry can be driven at (80 or 60)
        pitL.limit = Math.min(pitL.layoutLimit, realPitLimit(trackData, buildYear));
      }

      function why(side, vi, limit, msg) {       // F1.PIT_DEBUG = [] collects why a layout was not taken
        if (dbg) dbg.push((trackData && trackData.id) + ' side ' + side + ' variant ' + vi + ' ' + limit + ': ' + msg);
        return null;
      }
      // shortest taper of a cross-section: the lane's lateral travel x PIT_TAPER_SLOPE, at least PIT_TAPER_MIN
      function tMin(V) {
        return Math.max(PIT_TAPER_MIN, PIT_TAPER_SLOPE * (V[0] + 2 * PIT_WALL_HALF_T + PIT_LANE_GAP + 2 * V[1] - HALF_WIDTH));
      }

      // Lateral profile of a lane from..to (sample offsets from the line), tapers at most Tcap long; box = null or
      // {s0, s1}: metres from the line where the garage face stands (the outer wall ramps out to it over PIT_RAMP).
      // null: too short.
      function profile(sd, from, to, V, Tcap, box, late) {
        var L = to - from, len = L * ds, lh = V[1], bdp = V[2];
        var wof = V[0] + 2 * PIT_WALL_HALF_T, dL = wof + PIT_LANE_GAP + lh;
        var T = Math.min(Tcap, (len - PIT_SLOTS * PIT_PITCH_MIN - 2 * (PIT_BOX_MARGIN + PIT_LINE_GAP)) / 2);
        if (T < tMin(V)) return null;
        var kEn = Math.round((T + PIT_LINE_GAP) / ds), kEx = L - kEn;
        if (late ? from > -1 || to < 1 : from + kEn > -1 || from + kEx < 1) return null;  // the line between entry and exit
        var P = { L: L, T: T, kEn: kEn, kEx: kEx, wof: wof, dL: dL, dLo: dL + lh,
          lane: new Float64Array(L + 1), li: new Float64Array(L + 1), lo: new Float64Array(L + 1), ai: new Float64Array(L + 1),
          ao: new Float64Array(L + 1), O: new Float64Array(L + 1), gw: new Float64Array(L + 1), wall: new Uint8Array(L + 1) };
        for (var k = 0; k <= L; k++) {
          var i = wq(from + k), s = (from + k) * ds;
          var f = Math.min(smootherstep(k * ds / T), smootherstep((L - k) * ds / T));
          var dA = halfW[i] - lh;                                // at the ends the lane is the outer half of the road
          var ld = dA + (dL - dA) * f;
          P.lane[k] = ld; P.li[k] = ld - lh; P.lo[k] = ld + lh;
          P.wall[k] = P.li[k] >= wof + 0.05 ? 1 : 0;              // the pit wall stands where the lane has cleared it
          P.ai[k] = P.wall[k] ? wof : Math.max(halfW[i], P.li[k]);
          var g = !box ? 0 : (s < box.s0 ? smoothstep(1 - (box.s0 - s) / PIT_RAMP) :
                              (s > box.s1 ? smoothstep(1 - (s - box.s1) / PIT_RAMP) : 1));
          P.gw[k] = g;
          P.ao[k] = P.lo[k] + PIT_OUT_GAP + g * (bdp - PIT_OUT_GAP);
          P.O[k] = wallOff[sd][i] + softPos(P.ao[k] - wallOff[sd][i], PIT_SOFT);
        }
        // the complex reaches further out than the track's own wall there, and the medial axis is too close
        P.bad = function (k) {
          var i = wq(from + k), E = P.O[k] + PIT_OUT_T;
          return E > wallOuter[sd][i] + 0.01 && roomAll[sd][i] - PIT_ROOM_MARGIN < E;
        };
        return P;
      }

      // Curvature (1/m) of the lane centre at each k (0 within 2 samples of the ends).
      function laneCurv(side, from, P) {
        var K = P.L, lx = new Float64Array(K + 1), lz = new Float64Array(K + 1), c = new Float64Array(K + 1), k, i;
        for (k = 0; k <= K; k++) {
          i = wq(from + k);
          lx[k] = px[i] + nx[i] * side * P.lane[k]; lz[k] = pz[i] + nz[i] * side * P.lane[k];
        }
        for (k = 2; k <= K - 2; k++) {       // circle through k - 2, k, k + 2
          var ax = lx[k] - lx[k - 2], az = lz[k] - lz[k - 2], bx = lx[k + 2] - lx[k - 2], bz = lz[k + 2] - lz[k - 2];
          var la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(lx[k + 2] - lx[k], lz[k + 2] - lz[k]);
          if (la * lb * lc > 1e-9) c[k] = 2 * Math.abs(ax * bz - az * bx) / (la * lb * lc);
        }
        return c;
      }

      function layout(side, vi, limit, late) {
        var sd = side > 0 ? 1 : 0, qa = 0, qb = 0;
        function usable(q) { var j = wq(q); return wallFlag[sd][j] && partner[j] < 0; }
        if (!usable(0)) return why(side, vi, limit, 'no wall at the line');
        while (qa > -span && usable(qa - 1)) qa--;
        while (qb < span && usable(qb + 1)) qb++;
        // a short lane gets shorter tapers, so that the boxes still fit (and, since 2026-10-01, so that its entry line
        // still comes before the start line: Silverstone's line at the Wing is ~90 m after Club)
        for (var Tcap = PIT_TAPER; Tcap >= tMin(PIT_VARIANTS[vi]) - 1e-9; Tcap -= 4) {
          var r = fit(side, vi, limit, late, Math.max(qa, -reach), Math.min(qb, reach), Tcap);
          if (r !== 'boxes' && r !== 'short') return r;
        }
        return null;
      }

      // One try: -> the layout, null, 'boxes' (the lane fits but the boxes do not) or 'short' (the stretch is too short
      // for this taper): a shorter taper may help.
      function fit(side, vi, limit, late, from, to, Tcap) {
        var sd = side > 0 ? 1 : 0, V = PIT_VARIANTS[vi], P = null, k;
        var cMax = (limit > 60 ? PIT_LAT_MAX : PIT_LAT_MAX_60) / ((limit / 3.6) * (limit / 3.6));  // at the limit
        function where() { return Math.round(from * ds) + '..' + Math.round(to * ds) + ' m, taper ' + Tcap; }
        // shrink the lane from either end until the complex fits and the lane can be driven at the limit everywhere
        for (var it = 0; it < 200 && !P; it++) {
          P = profile(sd, from, to, V, Tcap, null, late);
          if (!P) { why(side, vi, limit, 'too short: ' + where()); return 'short'; }
          var cv = laneCurv(side, from, P), vNeg = null, vPos = null;
          for (k = 0; k <= P.L; k++) {
            if (!P.bad(k) && cv[k] <= cMax) continue;
            if (from + k < 0) vNeg = from + k; else if (vPos === null) vPos = from + k;
          }
          if (vNeg !== null || vPos !== null) {
            if (vNeg !== null) from = vNeg + 1;
            if (vPos !== null) to = vPos - 1;
            P = null;
          }
        }
        if (!P) return why(side, vi, limit, 'no fit: ' + where());
        // boxes: the longest stretch with room for the garage face, ramps included; the ramps may reach into the
        // last 15 % of a taper (the lane hardly moves out any more there)
        var Ebox = P.dLo + V[2] + PIT_OUT_T, kT = Math.ceil(0.85 * P.T / ds), best = null, r0 = -1;
        for (k = kT; k <= P.L - kT + 1; k++) {
          var okb = k <= P.L - kT && roomAll[sd][wq(from + k)] - PIT_ROOM_MARGIN >= Ebox;
          if (okb && r0 < 0) r0 = k;
          if (!okb && r0 >= 0) {
            var ua = Math.max(r0 * ds + PIT_RAMP + 1, P.kEn * ds + PIT_BOX_MARGIN);
            var ub = Math.min((k - 1) * ds - PIT_RAMP - 1, P.kEx * ds - PIT_BOX_MARGIN);
            if (!best || ub - ua > best[1] - best[0]) best = [ua, ub];
            r0 = -1;
          }
        }
        if (!best || best[1] - best[0] < PIT_SLOTS * PIT_PITCH_MIN) {
          why(side, vi, limit, 'no room for the boxes: ' + where() + (best ? ' (longest ' + Math.round(best[1] - best[0]) + ' m)' : ''));
          return 'boxes';
        }
        var pitch = Math.min(PIT_PITCH_MAX, (best[1] - best[0]) / PIT_SLOTS), lb = pitch * PIT_SLOTS;
        var sb0 = (best[0] + best[1]) / 2 - lb / 2 + from * ds;   // metres from the line to the upstream end of box 16
        P = profile(sd, from, to, V, Tcap, { s0: sb0 - 1, s1: sb0 + lb + 1 }, late);
        if (!P) return why(side, vi, limit, 'lost the profile: ' + where());
        for (k = 0; k <= P.L; k++) {
          if (P.bad(k)) return why(side, vi, limit, 'no room for the garage face at ' + Math.round((from + k) * ds) + ' m');
        }
        for (k = 0; k < P.L; k++) {    // the outer wall never runs out at a steeper angle than the track's own walls
          if (Math.abs(P.O[k + 1] - P.O[k]) > 0.75) return why(side, vi, limit, 'outer wall too steep at ' + Math.round((from + k) * ds) + ' m');
        }
        return { side: side, sd: sd, face: V[0], lh: V[1], bdp: V[2], from: from, to: to, P: P, pitch: pitch, sb0: sb0, limit: limit };
      }
    })();

    if (pitL) {
      (function () {
        var L = pitL, P = L.P, sd = L.sd;
        for (var k = 0; k <= P.L; k++) {
          var i = ((L.from + k) % N + N) % N;
          wallOff[sd][i] = P.O[k];
          wallOuter[sd][i] = P.O[k] + PIT_OUT_T;
          wallFlag[sd][i] = 1;
          // the kerbs were laid out before the lane: none where the lane's asphalt adjoins the road edge (tapers)
          if (P.ao[k] > halfW[i] + 0.05) kerbMask[sd][i] = 0;
        }
        dropShortRuns(kerbMask[sd], 4);
        wallIn[sd] = line(L.side, wallOff[sd]);
        wallOut[sd] = line(L.side, wallOuter[sd]);
      })();
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
    // Grid: box k = 1..GRID_SLOTS (slot k - 1, 0 = pole) has its front bar k * GRID_GAP metres behind the line,
    // GRID_SIDE metres to the driver's left (+n) for odd k and to the right for even k; where the road is
    // narrow the boxes move in towards the centreline. A box is a straight piece in the frame of the sample
    // its front bar is on: a bar across the front and two short side brackets. grid[k - 1] says where the
    // NOSE of the car in that box goes (the middle of the rear edge of the front bar) and which way it faces.
    var grid = [], gridBack = Math.ceil((GRID_BAR + GRID_CAR_LEN) / ds);
    for (k = 1; k <= GRID_SLOTS; k++) {
      var gi = ((N - Math.round((k * GRID_GAP) / ds)) % N + N) % N;
      var ghw = halfW[gi];                       // narrowest road under the car standing in the box
      for (var gb = 1; gb <= gridBack; gb++) ghw = Math.min(ghw, halfW[((gi - gb) % N + N) % N]);
      var lat = ((k & 1) ? 1 : -1) * Math.max(0, Math.min(GRID_SIDE, ghw - GRID_EDGE));
      grid.push({
        index: gi, d: lat,
        x: px[gi] + nx[gi] * lat - tx[gi] * GRID_BAR, z: pz[gi] + nz[gi] * lat - tz[gi] * GRID_BAR,
        heading: Math.atan2(tx[gi], tz[gi])
      });
      if (k * GRID_GAP > total / 4) continue;    // (a lap too short for the whole grid: no paint further back)
      rect(gi, lat - GRID_BOX_W, lat + GRID_BOX_W, -GRID_BAR, 0, Y_START, C_WHITE);
      rect(gi, lat - GRID_BOX_W, lat - GRID_BOX_W + 0.2, -GRID_BOX_LEN, -GRID_BAR, Y_START, C_WHITE);
      rect(gi, lat + GRID_BOX_W - 0.2, lat + GRID_BOX_W, -GRID_BOX_LEN, -GRID_BAR, Y_START, C_WHITE);
    }

    // --- pit lane geometry: asphalt, paint, pit wall, garage face (all merged into the meshes above) and the light
    //     curtains (a mesh of their own). pit = the exported description, boxes included.
    var wallDraw = [wallFlag[0], wallFlag[1]];    // where buildWall draws the plain barrier (not under the garage face)
    var curtainBuf = null, pit = null, signBufs = null;
    if (pitL) (function () {
      var L = pitL, P = L.P, sd = L.sd, sg = L.side, K = P.L, from = L.from, k, u, i;
      var bw = L.bdp - 0.6;                       // painted box width (across)
      function wq(q) { return ((q % N) + N) % N; }
      function si(kk) { return wq(from + kk); }
      // per-sample array (length N) from a lane array, other samples 0
      function perSample(src, add) {
        var o = new Float64Array(N);
        for (var kk = 0; kk <= K; kk++) o[si(kk)] = src[kk] + (add || 0);
        return o;
      }
      function laneMask(fn) {
        var m = new Uint8Array(N);
        for (var kk = 0; kk <= K; kk++) m[si(kk)] = fn(kk) ? 1 : 0;
        return m;
      }
      // strip between two offsets on the pit side (lo < hi, both >= 0)
      function pitStrip(buf, lo, hi, lift, mask, colFn) {
        if (sg > 0) strip(buf, line(1, lo), line(1, hi), lift, mask, colFn);
        else strip(buf, line(-1, hi), line(-1, lo), lift, mask, colFn);
      }
      // Surface height at signed offset la, lon metres along from sample idx: linear between the samples, like the
      // asphalt strips (far out from the centreline the tilted plane of one sample, as rect() uses, is too coarse).
      function hAt(idx, la, lon) {
        var f = lon / ds, j = Math.floor(f), a = wq(idx + j), b = wq(idx + j + 1);
        f -= j;
        return py[a] + la * tanB[a] + (py[b] + la * tanB[b] - py[a] - la * tanB[a]) * f;
      }
      // paint triangle in the frame of sample idx; points [lat, lon] (signed lat), turned to face up (into paintTo)
      var paintTo = paintBuf;
      function ptri(idx, A, B, Cc, lift, c) {
        if ((B[1] - A[1]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[1] - A[1]) < 0) { var tmp = B; B = Cc; Cc = tmp; }
        var pts = [A, B, Cc];
        for (var v = 0; v < 3; v++) {
          var la = pts[v][0], lo = pts[v][1];
          paintTo.pos.push(px[idx] + nx[idx] * la + tx[idx] * lo, hAt(idx, la, lo) + lift, pz[idx] + nz[idx] * la + tz[idx] * lo);
          paintTo.nrm.push(ux[idx], uy[idx], uz[idx]);
          paintTo.col.push(c[0], c[1], c[2]);
        }
      }
      // paint rectangle in the frame of sample idx: signed lateral lat0..lat1, lon0..lon1 along
      function lrect(idx, lat0, lat1, lon0, lon1, lift, c) {
        ptri(idx, [lat0, lon0], [lat0, lon1], [lat1, lon0], lift, c);
        ptri(idx, [lat1, lon0], [lat0, lon1], [lat1, lon1], lift, c);
      }
      // the same between unsigned offsets a, b on the pit side
      function prect(idx, a, b, lon0, lon1, lift, c) { lrect(idx, sg * a, sg * b, lon0, lon1, lift, c); }
      // digits read by a driver going forward: glyph up = +lon, glyph right = the driver's right (-n)
      function digits(idx, str, cLat, cLon, W, H, tW, tH, gap, lift, c) {
        var tot = str.length * W + (str.length - 1) * gap;
        for (var ch = 0; ch < str.length; ch++) {
          var bits = SEG7[+str.charAt(ch)] || 0, g0 = -tot / 2 + ch * (W + gap);
          var segs = [[0, W, H - tH, H], [W - tW, W, H / 2, H], [W - tW, W, 0, H / 2], [0, W, 0, tH],
                      [0, tW, 0, H / 2], [0, tW, H / 2, H], [0, W, H / 2 - tH / 2, H / 2 + tH / 2]];
          for (var sgm = 0; sgm < 7; sgm++) {
            if (!(bits & (1 << sgm))) continue;
            var q = segs[sgm];
            lrect(idx, cLat - (g0 + q[1]), cLat - (g0 + q[0]), cLon - H / 2 + q[2], cLon - H / 2 + q[3], lift, c);
          }
        }
      }
      // ellipse ring (ri = 0: disc) centred at signed lat cLat, lon cLon; semi-axes across / along
      function ellipse(idx, cLat, cLon, ra, rl, ri, lift, c) {
        var n = 28;
        for (var e = 0; e < n; e++) {
          var a0 = 2 * Math.PI * e / n, a1 = 2 * Math.PI * (e + 1) / n;
          var o0 = [cLat + ra * Math.cos(a0), cLon + rl * Math.sin(a0)], o1 = [cLat + ra * Math.cos(a1), cLon + rl * Math.sin(a1)];
          if (!ri) { ptri(idx, [cLat, cLon], o0, o1, lift, c); continue; }
          var i0 = [cLat + ra * ri * Math.cos(a0), cLon + rl * ri * Math.sin(a0)], i1 = [cLat + ra * ri * Math.cos(a1), cLon + rl * ri * Math.sin(a1)];
          ptri(idx, i0, o0, o1, lift, c); ptri(idx, i0, o1, i1, lift, c);
        }
      }

      // asphalt from the pit wall (or the track edge) to the lane's outer edge / the garage face
      pitStrip(roadBuf, perSample(P.ai), perSample(P.ao), Y_ROAD, laneMask(function () { return true; }), null);

      // lane edge lines where they are off the road
      var li = perSample(P.li), lo = perSample(P.lo);
      pitStrip(paintBuf, li, perSample(P.li, PIT_LINE_W), Y_PAINT,
               laneMask(function (kk) { return P.li[kk] >= halfW[si(kk)] + 0.05; }), null);
      pitStrip(paintBuf, perSample(P.lo, -PIT_LINE_W), lo, Y_PAINT,
               laneMask(function (kk) { return P.lo[kk] - PIT_LINE_W >= halfW[si(kk)] + 0.05; }), null);

      // entry / exit lines across the lane; speed-limit sign after the entry line, end-of-limit sign before the exit
      var eI = si(P.kEn), xI = si(P.kEx), dL = P.dL, lim = String(L.limit);
      prect(eI, P.wof, P.ao[P.kEn], -0.25, 0.25, Y_PAINT, C_WHITE);
      prect(xI, P.wof, P.ao[P.kEx], -0.25, 0.25, Y_PAINT, C_WHITE);
      var ra = L.lh - 0.9, rl = 2.1 * ra, dW = 0.42 * ra, dH = 1.55 * ra;
      var sI = si(P.kEn + Math.round(10 / ds)), xs = si(P.kEx - Math.round(12 / ds)), C_GREY = hexRGB(0x8c8c8c);
      ellipse(sI, sg * dL, 0, ra, rl, 0.8, Y_START, C_RED);
      ellipse(sI, sg * dL, 0, ra * 0.8, rl * 0.8, 0, Y_START, C_WHITE);
      ellipse(xs, sg * dL, 0, ra, rl, 0.93, Y_START, C_BLACK);
      ellipse(xs, sg * dL, 0, ra * 0.93, rl * 0.93, 0, Y_START, C_WHITE);
      // the painted limit: one value -> part of the paint mesh; a track whose limit changed over the seasons
      // (trackData.pitLimits) gets the digits of each value in a buffer of their own, appended to the paint mesh as a
      // material group shown for the current limit only (see "meshes" below, pit.setYear)
      var limVals = [L.limit], pl = trackData && trackData.pitLimits;
      if (Array.isArray(pl)) {
        limVals.push(Math.min(L.layoutLimit, realPitLimit(trackData, null)));
        for (var e2 = 0; e2 < pl.length; e2++) if (pl[e2] && +pl[e2].kmh > 0) limVals.push(Math.min(L.layoutLimit, +pl[e2].kmh));
      }
      limVals = limVals.filter(function (v, ix) { return limVals.indexOf(v) === ix; });
      signBufs = {};
      for (var lv = 0; lv < limVals.length; lv++) {
        var lstr = String(limVals[lv]);
        if (limVals.length > 1) paintTo = signBufs[lstr] = newBuf(true, true);
        digits(sI, lstr, sg * dL, 0, dW, dH, 0.12 * dW / 0.5, 0.18 * dH / 2.2, 0.3 * dW, Y_START + 0.015, C_BLACK);
        digits(xs, lstr, sg * dL, 0, dW, dH, 0.12 * dW / 0.5, 0.18 * dH / 2.2, 0.3 * dW, Y_START + 0.015, C_GREY);
      }
      paintTo = paintBuf;
      if (limVals.length < 2) signBufs = null;
      var bH = 0.16 * ra, bA = [sg * dL + 0.75 * ra, -0.75 * rl], bB = [sg * dL - 0.75 * ra, 0.75 * rl];  // the diagonal bar
      ptri(xs, [bA[0] + bH, bA[1]], [bA[0] - bH, bA[1]], [bB[0] - bH, bB[1]], Y_START + 0.025, C_BLACK);
      ptri(xs, [bA[0] + bH, bA[1]], [bB[0] - bH, bB[1]], [bB[0] + bH, bB[1]], Y_START + 0.025, C_BLACK);

      // boxes: box 16 (slot 15) upstream ... box 1 (slot 0) next to the exit. A box is a straight piece in the frame
      // of the sample nearest its centre: outline, number, and a yellow stop bar where the car's nose stops.
      var boxes = new Array(PIT_SLOTS), C_YELLOW = hexRGB(0xffd21e), bd0 = P.dLo + 0.3, bd1 = P.dLo + L.bdp - 0.3;
      var bc = P.dLo + L.bdp / 2, half = PIT_BOX_LEN / 2;
      for (var j = 0; j < PIT_SLOTS; j++) {
        var s = L.sb0 + (j + 0.5) * L.pitch, q = Math.round(s / ds), bi = wq(q), lon = s - q * ds, d = sg * bc;
        boxes[PIT_SLOTS - 1 - j] = {
          slot: PIT_SLOTS - 1 - j, index: bi, d: d,
          x: px[bi] + nx[bi] * d + tx[bi] * lon, y: hAt(bi, d, lon), z: pz[bi] + nz[bi] * d + tz[bi] * lon,
          heading: Math.atan2(tx[bi], tz[bi])
        };
        prect(bi, bd0, bd1, lon - half, lon - half + 0.15, Y_START, C_WHITE);
        prect(bi, bd0, bd1, lon + half - 0.15, lon + half, Y_START, C_WHITE);
        prect(bi, bd0, bd0 + 0.15, lon - half + 0.15, lon + half - 0.15, Y_START, C_WHITE);
        prect(bi, bd1 - 0.15, bd1, lon - half + 0.15, lon + half - 0.15, Y_START, C_WHITE);
        prect(bi, bd0 + 0.2 * bw, bd1 - 0.2 * bw, lon + 2.85, lon + 3.25, Y_START, C_YELLOW);
        digits(bi, String(PIT_SLOTS - j), d, lon - 0.6, 0.9, 2.2, 0.22, 0.26, 0.3, Y_START, C_WHITE);
      }

      // pit wall: concrete, white top band, yellow / black attenuators at both ends
      var C_PW_LO = hexRGB(0xa9aaa6), C_PW_HI = hexRGB(0xe6e6e2), C_ATT_Y = hexRGB(0xf2c200), C_ATT_K = hexRGB(0x1a1a1a);
      var Lf = line(sg, L.face), Lo = line(sg, P.wof);
      var A0 = sg > 0 ? Lf : Lo, B0 = sg > 0 ? Lo : Lf;      // lower-n / higher-n face
      function V3(Ln, uu, h) { return [Ln.x[uu], Ln.y[uu] + h, Ln.z[uu]]; }
      var kw0 = -1, kw1 = -1;
      for (k = 0; k <= K; k++) if (P.wall[k]) { if (kw0 < 0) kw0 = k; kw1 = k; }
      for (k = kw0; k >= 0 && k < kw1; k++) {
        u = si(k); var w = si(k + 1);
        var att = k - kw0 < 3 || kw1 - k <= 3, lo2 = att ? ((k & 1) ? C_ATT_Y : C_ATT_K) : C_PW_LO, hi2 = att ? lo2 : C_PW_HI;
        if (k === kw0) quad(wallBuf, V3(A0, u, -0.2), V3(B0, u, -0.2), V3(A0, u, PIT_WALL_H), V3(B0, u, PIT_WALL_H), C_ATT_Y);
        if (k + 1 === kw1) quad(wallBuf, V3(A0, w, -0.2), V3(B0, w, -0.2), V3(A0, w, PIT_WALL_H), V3(B0, w, PIT_WALL_H), C_ATT_Y);
        for (var fc = 0; fc < 2; fc++) {
          var F = fc ? B0 : A0;
          quad(wallBuf, V3(F, u, -0.2), V3(F, w, -0.2), V3(F, u, 0.75), V3(F, w, 0.75), lo2);
          quad(wallBuf, V3(F, u, 0.75), V3(F, w, 0.75), V3(F, u, PIT_WALL_H), V3(F, w, PIT_WALL_H), hi2);
        }
        quad(wallBuf, V3(A0, u, PIT_WALL_H), V3(A0, w, PIT_WALL_H), V3(B0, u, PIT_WALL_H), V3(B0, w, PIT_WALL_H), hi2);
      }

      // garage face where the outer wall is at its full distance: it replaces the plain barrier there. Doors per box,
      // a band in "team" colours (boxes 1-2, 3-4, ... share one) above them.
      var TEAM = [0xd81e1e, 0x1e46d2, 0x14b4a0, 0xf07814, 0x0a6450, 0x1e8cf0, 0x283c5a, 0xb4b8bc].map(hexRGB);
      var C_FACADE = hexRGB(0xd9dbdd), C_DOOR = hexRGB(0x2c2f35), C_BACK = hexRGB(0xb4b6b4), C_ROOF = hexRGB(0x7a7c80);
      var kg0 = -1, kg1 = -1;
      for (k = 0; k <= K; k++) if (P.gw[k] >= 1) { if (kg0 < 0) kg0 = k; kg1 = k; }
      if (kg0 >= 0 && kg1 > kg0) {
        wallDraw[sd] = wallFlag[sd].slice();
        for (k = kg0 + 1; k < kg1; k++) wallDraw[sd][si(k)] = 0;
        var I = wallIn[sd], Ob = wallOut[sd], doorW = Math.min(L.pitch - 1.4, 6.0);
        function VL(Ln, uu, ww, f, h) {
          return [Ln.x[uu] + (Ln.x[ww] - Ln.x[uu]) * f, Ln.y[uu] + (Ln.y[ww] - Ln.y[uu]) * f + h, Ln.z[uu] + (Ln.z[ww] - Ln.z[uu]) * f];
        }
        function boxAt(s) { return Math.floor((s - L.sb0) / L.pitch); }
        function inDoor(s) {
          var jj = boxAt(s);
          return jj >= 0 && jj < PIT_SLOTS && Math.abs(s - (L.sb0 + (jj + 0.5) * L.pitch)) < doorW / 2;
        }
        for (k = kg0; k < kg1; k++) {
          u = si(k); var w2 = si(k + 1), s0 = (from + k) * ds, s1 = s0 + ds, cuts = [0, 1], jb;
          for (jb = Math.max(0, boxAt(s0)); jb <= Math.min(PIT_SLOTS, boxAt(s1)); jb++) {
            var edges = [L.sb0 + jb * L.pitch, L.sb0 + (jb + 0.5) * L.pitch - doorW / 2, L.sb0 + (jb + 0.5) * L.pitch + doorW / 2];
            for (var ed = 0; ed < 3; ed++) if (edges[ed] > s0 && edges[ed] < s1) cuts.push((edges[ed] - s0) / ds);
          }
          cuts.sort(function (m1, m2) { return m1 - m2; });
          for (var c = 0; c + 1 < cuts.length; c++) {
            var fa = cuts[c], fb = cuts[c + 1], sm = s0 + (fa + fb) / 2 * ds, jj = boxAt(sm);
            var band = jj >= 0 && jj < PIT_SLOTS ? TEAM[((PIT_SLOTS - 1 - jj) >> 1) % TEAM.length] : C_FACADE;
            quad(wallBuf, VL(I, u, w2, fa, -0.3), VL(I, u, w2, fb, -0.3), VL(I, u, w2, fa, PIT_DOOR_H), VL(I, u, w2, fb, PIT_DOOR_H),
                 inDoor(sm) ? C_DOOR : C_FACADE);
            quad(wallBuf, VL(I, u, w2, fa, PIT_DOOR_H), VL(I, u, w2, fb, PIT_DOOR_H), VL(I, u, w2, fa, PIT_DOOR_H + 0.35),
                 VL(I, u, w2, fb, PIT_DOOR_H + 0.35), C_FACADE);
            quad(wallBuf, VL(I, u, w2, fa, PIT_DOOR_H + 0.35), VL(I, u, w2, fb, PIT_DOOR_H + 0.35), VL(I, u, w2, fa, PIT_GARAGE_H),
                 VL(I, u, w2, fb, PIT_GARAGE_H), band);
          }
          quad(wallBuf, V3(Ob, u, -0.3), V3(Ob, w2, -0.3), V3(Ob, u, PIT_GARAGE_H), V3(Ob, w2, PIT_GARAGE_H), C_BACK);
          quad(wallBuf, V3(I, u, PIT_GARAGE_H), V3(I, w2, PIT_GARAGE_H), V3(Ob, u, PIT_GARAGE_H), V3(Ob, w2, PIT_GARAGE_H), C_ROOF);
        }
        quad(wallBuf, V3(I, si(kg0), -0.3), V3(Ob, si(kg0), -0.3), V3(I, si(kg0), PIT_GARAGE_H), V3(Ob, si(kg0), PIT_GARAGE_H), C_BACK);
        quad(wallBuf, V3(I, si(kg1), -0.3), V3(Ob, si(kg1), -0.3), V3(I, si(kg1), PIT_GARAGE_H), V3(Ob, si(kg1), PIT_GARAGE_H), C_BACK);
      }

      // light curtains: amber at the entry line, green at the exit line. Three translucent layers across the lane
      // (fading upwards, with vertical light beams in the middle one), a glowing column at each end and a bar on top.
      // Only vertical quads; colours carry their opacity (RGBA), see the material below.
      curtainBuf = newBuf(true, false);
      function curtain(kk, col) {
        var idx = si(kk), a = P.wof + 0.05, b = P.O[kk] - 0.05;
        function at(off, lon, h) {
          var la = sg * off;
          return [px[idx] + nx[idx] * la + tx[idx] * lon, hAt(idx, la, lon) + h, pz[idx] + nz[idx] * la + tz[idx] * lon];
        }
        function vq(o0, o1, lon0, lon1, h0, h1, f0, f1) {     // vertical quad, opacity f0 at the bottom, f1 at the top
          var p00 = at(o0, lon0, h0), p10 = at(o1, lon1, h0), p01 = at(o0, lon0, h1), p11 = at(o1, lon1, h1);
          p01[0] = p00[0]; p01[2] = p00[2]; p11[0] = p10[0]; p11[2] = p10[2];
          var c0 = [col[0], col[1], col[2], f0], c1 = [col[0], col[1], col[2], f1];
          curtainBuf.pos.push(p00[0], p00[1], p00[2], p10[0], p10[1], p10[2], p01[0], p01[1], p01[2],
                              p01[0], p01[1], p01[2], p10[0], p10[1], p10[2], p11[0], p11[1], p11[2]);
          [c0, c0, c1, c1, c0, c1].forEach(function (c) { curtainBuf.col.push(c[0], c[1], c[2], c[3]); });
        }
        var H = PIT_CURTAIN_H, lay, hs = [-0.2, 0.7, 2.6, H], fs = [0.34, 0.24, 0.12, 0.01];
        for (lay = -1; lay <= 1; lay++) {
          for (var hb = 0; hb < 3; hb++) vq(a, b, lay * 0.45, lay * 0.45, hs[hb], hs[hb + 1], fs[hb], fs[hb + 1]);
        }
        for (var o = a + 0.5; o < b - 0.3; o += 0.8) vq(o - 0.05, o + 0.05, 0, 0, -0.2, H, 0.75, 0.08);
        vq(a, b, 0.5, 0.5, H - 0.35, H, 0.85, 0.85);
        vq(a, b, -0.5, -0.5, H - 0.35, H, 0.85, 0.85);
        [a + 0.2, b - 0.2].forEach(function (o) {
          var r = 0.18;
          vq(o - r, o + r, -r, -r, -0.2, H + 0.6, 0.95, 0.8); vq(o + r, o + r, -r, r, -0.2, H + 0.6, 0.95, 0.8);
          vq(o + r, o - r, r, r, -0.2, H + 0.6, 0.95, 0.8); vq(o - r, o - r, r, -r, -0.2, H + 0.6, 0.95, 0.8);
        });
      }
      curtain(P.kEn, hexRGB(0xffa014));
      curtain(P.kEx, hexRGB(0x1eff5a));

      // the exported description (functions: see "pit API" below)
      pit = {
        side: sg, limitKmh: L.limit, from: si(0), to: si(K), entry: eI, exit: xI,
        laneHalfW: L.lh, wallHalfT: PIT_WALL_HALF_T, boxes: boxes,
        length: K * ds, boxLen: PIT_BOX_LEN, boxW: bw,
        layoutLimitKmh: L.layoutLimit,   // what the lane's geometry allows (the real limit is never above it)
        year: buildYear                  // the season limitKmh is for (null: the current layout's rule)
      };
    })();

    // walls: bases follow the (banked) surface at their lateral offset, tops WALL_H above
    function buildWall(sd) {
      var I = wallIn[sd], O = wallOut[sd], mask = wallDraw[sd];
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
    // The cell the point (x, z) of sample i's cross-section (lateral dLo..dHi) falls in: its vertices are kept
    // TERRAIN_EPS below that cross-section, each at its own lateral offset, the cross-section held level beyond its
    // ends. Rising outwards (the high side of a banked corner) that shape is concave, so the cell's triangles stay
    // under it and the ground beyond the outer wall stays at the top of the banking (the lowest point of the
    // cross-section in the cell, taken before, left a 3-5 m drop behind the walls of the real bankings). Where the
    // cell reaches past the end that falls away (the low side) all four vertices take that end's height, as before.
    function stamp(i, x, z, dLo, dHi) {
      var ix = Math.floor((x - tx0) / cellT), iz = Math.floor((z - tz0) / cellT);
      if (ix < 0) ix = 0; else if (ix > nIx - 2) ix = nIx - 2;
      if (iz < 0) iz = 0; else if (iz > nIz - 2) iz = nIz - 2;
      var c = (iz + TERRAIN_RINGS) * TW + ix + TERRAIN_RINGS, v, dv, low = tanB[i] > 0 ? dLo : dHi, past = false;
      function lat(v) { return (tx0 + (ix + (v & 1)) * cellT - px[i]) * nx[i] + (tz0 + (iz + (v >> 1)) * cellT - pz[i]) * nz[i]; }
      for (v = 0; v < 4; v++) { dv = lat(v); if (low < 0 ? dv < dLo : dv > dHi) past = true; }
      for (v = 0; v < 4; v++) {
        dv = past ? low : lat(v);
        var h = py[i] + (dv < dLo ? dLo : (dv > dHi ? dHi : dv)) * tanB[i] - TERRAIN_EPS, cv = c + (v & 1) + (v >> 1) * TW;
        if (h < tH[cv]) tH[cv] = h;
      }
    }
    for (i = 0; i < N; i++) {
      var dLo = -(wallOuter[0][i] + 0.3), dHi = wallOuter[1][i] + 0.3;
      var nSt = Math.ceil((dHi - dLo) / 2);
      for (k = 0; k <= nSt; k++) {
        var dd = dLo + (dHi - dLo) * k / nSt;
        stamp(i, px[i] + nx[i] * dd, pz[i] + nz[i] * dd, dLo, dHi);
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
    var gyReach = 0;   // furthest the corridor + verge reaches from the centreline (the pit complex's skirt included)
    for (side = 0; side < 2; side++) {
      var sg2 = side ? 1 : -1, base = gridVerts + side * N * SK_ROWS;
      for (i = 0; i < N; i++) {
        var o0 = Math.min(wallOuter[side][i], Math.max(1.0, roomRoad[side][i] - 0.04));
        var U = roomAll[side][i] - o0 - 0.3;
        U = U < 0 ? 0 : (U > SKIRT_W ? SKIRT_W : U);
        var h0 = py[i] + sg2 * o0 * tanB[i];
        skO[side][i] = o0; skU[side][i] = U;
        if (o0 + U > gyReach) gyReach = o0 + U;
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

    // --- bridges (grade-separated crossings): under the upper road a deck slab BRIDGE_DECK_T thick, from wall foot to
    //     wall foot, wherever the terrain falls away more than BRIDGE_GAP under it (the cutting the lower road runs in),
    //     and on both sides of the lower road, ABUT_GAP behind its walls, abutment walls up to the deck's underside.
    //     The upper road's walls are the parapets. Everything goes into the walls mesh (vertex colours, double sided).
    var bridgeOut = [];
    function deckRange(B) {           // [q0, q1]: deck samples up + q0 .. up + q1, or null
      var q0 = null, q1 = null;
      for (var q = -CROSS_ZONE; q <= CROSS_ZONE; q++) {
        var u = (B.up + q + N) % N, lo = -wallOuter[0][u], hi = wallOuter[1][u], gap = 0;
        for (var t = 0; t <= 16; t++) {
          var d = lo + (hi - lo) * t / 16, g = py[u] + d * tanB[u] - terrainAt(px[u] + nx[u] * d, pz[u] + nz[u] * d);
          if (g > gap) gap = g;
        }
        if (gap > BRIDGE_GAP) { if (q0 === null) q0 = q; q1 = q; }
      }
      return q0 === null ? null : [Math.max(-CROSS_ZONE, q0 - 1), Math.min(CROSS_ZONE, q1 + 1)];
    }
    for (var bI = 0; bI < bridges.length; bI++) (function (B) {
      var R = deckRange(B);
      if (!R) return;
      var C_SIDE = hexRGB(0xa9a9a4), C_UNDER = hexRGB(0x5f605c), C_ABUT = hexRGB(0x9d9d97), C_ABUT_TOP = hexRGB(0x7d7d79);
      var T = BRIDGE_DECK_T, A0 = wallOut[0], A1 = wallOut[1], q, u, w;
      function V(Ln, uu, h) { return [Ln.x[uu], Ln.y[uu] + h, Ln.z[uu]]; }
      for (q = R[0]; q < R[1]; q++) {
        u = (B.up + q + N) % N; w = (u + 1) % N;
        quad(wallBuf, V(A0, u, -T), V(A1, u, -T), V(A0, w, -T), V(A1, w, -T), C_UNDER);     // underside
        quad(wallBuf, V(A0, u, -T), V(A0, w, -T), V(A0, u, 0), V(A0, w, 0), C_SIDE);        // side faces (the walls'
        quad(wallBuf, V(A1, u, -T), V(A1, w, -T), V(A1, u, 0), V(A1, w, 0), C_SIDE);        //  outer faces go on up)
      }
      [R[0], R[1]].forEach(function (qe) {       // end faces
        var ue = (B.up + qe + N) % N;
        quad(wallBuf, V(A0, ue, -T), V(A1, ue, -T), V(A0, ue, 0), V(A1, ue, 0), C_SIDE);
      });
      // underside of the deck at (x, z), NaN where (x, z) is not under it
      function deckBottom(x, z) {
        var best = -1, bd = Infinity;
        for (var qq = R[0]; qq <= R[1]; qq++) {
          var s = (B.up + qq + N) % N, ex = px[s] - x, ez = pz[s] - z, dd = ex * ex + ez * ez;
          if (dd < bd) { bd = dd; best = s; }
        }
        var dl = (x - px[best]) * nx[best] + (z - pz[best]) * nz[best], al = (x - px[best]) * tx[best] + (z - pz[best]) * tz[best];
        if (dl < -wallOuter[0][best] - 0.05 || dl > wallOuter[1][best] + 0.05 || Math.abs(al) > ds) return NaN;
        return py[best] + dl * tanB[best] + al * grade[best] - T;
      }
      var abut = 0;
      for (var sd = 0; sd < 2; sd++) {
        var sgn = sd ? 1 : -1, prev = null;
        for (q = -CROSS_ZONE; q <= CROSS_ZONE; q++) {
          u = (B.lo + q + N) % N;
          var a = wallOuter[sd][u] + ABUT_GAP, b = a + ABUT_T, m = (a + b) / 2;
          var cx = px[u] + nx[u] * sgn * m, cz = pz[u] + nz[u] * sgn * m, top = deckBottom(cx, cz);
          var cur = null;
          if (isFinite(top)) {
            var foot = Math.min(py[u] + sgn * a * tanB[u], terrainAt(cx, cz)) - 0.5;
            cur = { u: u, top: top, foot: foot,
              ia: [px[u] + nx[u] * sgn * a, pz[u] + nz[u] * sgn * a], ib: [px[u] + nx[u] * sgn * b, pz[u] + nz[u] * sgn * b] };
          }
          if (cur && prev) {
            var P0 = function (c, p, h) { return [c[p][0], h, c[p][1]]; };
            quad(wallBuf, P0(prev, 'ia', prev.foot), P0(cur, 'ia', cur.foot), P0(prev, 'ia', prev.top), P0(cur, 'ia', cur.top), C_ABUT);
            quad(wallBuf, P0(prev, 'ib', prev.foot), P0(cur, 'ib', cur.foot), P0(prev, 'ib', prev.top), P0(cur, 'ib', cur.top), C_ABUT);
            quad(wallBuf, P0(prev, 'ia', prev.top), P0(cur, 'ia', cur.top), P0(prev, 'ib', prev.top), P0(cur, 'ib', cur.top), C_ABUT_TOP);
            abut++;
          }
          if ((cur && !prev) || (!cur && prev)) {   // end face of a run
            var E = cur || prev;
            quad(wallBuf, [E.ia[0], E.foot, E.ia[1]], [E.ib[0], E.foot, E.ib[1]], [E.ia[0], E.top, E.ia[1]], [E.ib[0], E.top, E.ib[1]], C_ABUT);
          }
          prev = cur;
        }
      }
      var minClear = Infinity;              // lowest deck underside above the lower road's surface (car's path)
      for (q = -CROSS_ZONE; q <= CROSS_ZONE; q++) {
        u = (B.lo + q + N) % N;
        for (var t2 = -1; t2 <= 1; t2 += 0.25) {
          var dd2 = t2 * wallOff[t2 > 0 ? 1 : 0][u], h2 = deckBottom(px[u] + nx[u] * dd2, pz[u] + nz[u] * dd2);
          if (isFinite(h2)) minClear = Math.min(minClear, h2 - (py[u] + dd2 * tanB[u]));
        }
      }
      bridgeOut.push({ up: B.up, lo: B.lo, separation: py[B.up] - py[B.lo], deckFrom: (B.up + R[0] + N) % N,
        deckTo: (B.up + R[1] + N) % N, deckLength: (R[1] - R[0]) * ds, clearance: minClear, abutmentSegments: abut });
    })(bridges[bI]);

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
    // The pit lane's painted limit where it changed over the seasons (trackData.pitLimits): the digits of each value
    // are appended to the paint mesh as a group of their own with its own material ('pitSign' + km/h), visible for the
    // current limit only (pit.setYear); the paint mesh then carries an array of materials. Otherwise one material.
    var PAINT_OPTS = { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    var signMats = {};
    if (signBufs) {
      var baseCount = paintBuf.pos.length / 3, groups = [[0, baseCount, 'paint']];
      for (var sKey in signBufs) {
        if (!Object.prototype.hasOwnProperty.call(signBufs, sKey) || !signBufs[sKey].pos.length) continue;
        var sb = signBufs[sKey], at = paintBuf.pos.length / 3;
        Array.prototype.push.apply(paintBuf.pos, sb.pos);
        Array.prototype.push.apply(paintBuf.col, sb.col);
        Array.prototype.push.apply(paintBuf.nrm, sb.nrm);
        groups.push([at, sb.pos.length / 3, sKey]);
      }
      var pMesh = addMesh('paint', makeGeometry(paintBuf), PAINT_OPTS, 3), mats = [pMesh.material];
      pMesh.material.name = 'paint';
      for (var gk = 0; gk < groups.length; gk++) {
        pMesh.geometry.addGroup(groups[gk][0], groups[gk][1], gk);
        if (!gk) continue;
        var sMat = new THREE.MeshLambertMaterial(PAINT_OPTS);
        sMat.name = 'pitSign' + groups[gk][2];
        sMat.visible = pit ? String(pit.limitKmh) === groups[gk][2] : false;
        signMats[groups[gk][2]] = sMat;
        mats.push(sMat);
      }
      pMesh.material = mats;
    } else {
      addMesh('paint', makeGeometry(paintBuf), PAINT_OPTS, 3);
    }
    addMesh('walls', makeGeometry(wallBuf), { vertexColors: true, side: THREE.DoubleSide }, 4);
    // light curtains: translucent (per-vertex opacity; not additive, which washes the colours out to white against a
    // daytime sky), never blinding when driven through, no depth writes, no fog (they read from across the circuit)
    var curtainMat = null;
    if (curtainBuf && curtainBuf.pos.length) {
      var cGeo = new THREE.BufferGeometry();
      cGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(curtainBuf.pos), 3));
      cGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(curtainBuf.col), 4));
      curtainMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true,
        depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false });
      var cMesh = new THREE.Mesh(finish(cGeo), curtainMat);
      cMesh.name = 'pitCurtains';
      cMesh.renderOrder = 10;
      cMesh.matrixAutoUpdate = false;
      group.add(cMesh);
    }

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

    // --- two levels (bridges): at a grade-separated crossing a point can be on either road. otherLevel -> the nearest
    //     sample of the other road (around partner[idx]), or -1; pickLevel -> idx or that sample, whichever's surface at
    //     (x, z) is closer to the height y (the other road only when (x, z) is inside its corridor).
    function otherLevel(x, z, idx) {
      if (idx < 0 || !sepP[idx]) return -1;
      var p = partner[idx], best = -1, bd = Infinity;
      for (var q = -PARTNER_SPAN; q <= PARTNER_SPAN; q++) {
        var s = (p + q + N) % N, ex = px[s] - x, ez = pz[s] - z, dd = ex * ex + ez * ez;
        if (dd < bd) { bd = dd; best = s; }
      }
      return best;
    }
    function inOwnCorridor(x, z, s, margin) {
      var d = (x - px[s]) * nx[s] + (z - pz[s]) * nz[s], a = (x - px[s]) * tx[s] + (z - pz[s]) * tz[s];
      return Math.abs(a) <= ds && Math.abs(d) <= wallOuter[d > 0 ? 1 : 0][s] + (margin || 0);
    }
    function pickLevel(x, z, idx, y) {
      if (typeof y !== 'number' || !isFinite(y)) return idx;
      var o = otherLevel(x, z, idx);
      if (o < 0 || !inOwnCorridor(x, z, o, 1)) return idx;
      var dI = (x - px[idx]) * nx[idx] + (z - pz[idx]) * nz[idx], dO = (x - px[o]) * nx[o] + (z - pz[o]) * nz[o];
      return Math.abs(py[o] + dO * tanB[o] - y) < Math.abs(py[idx] + dI * tanB[idx] - y) ? o : idx;
    }

    // Nearest centreline sample to any world point (global): {index, dist, d}. d = signed lateral offset.
    // y (optional): at a bridge, the road whose surface is closest to that height (see pickLevel); without it the
    // nearest sample in plan.
    function nearest(x, z, y) {
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
      if (y !== undefined && sepP[best]) {
        var lv = pickLevel(x, z, best, y);
        if (lv !== best) { best = lv; bd = (px[best] - x) * (px[best] - x) + (pz[best] - z) * (pz[best] - z); }
      }
      return { index: best, dist: Math.sqrt(bd), d: (x - px[best]) * nx[best] + (z - pz[best]) * nz[best] };
    }

    // True if (x, z) is inside the track corridor (road + runoff + walls of any part of the track),
    // grown by `margin` metres. Scenery must keep out of it. (At a bridge: inside either road's corridor.)
    function inCorridor(x, z, margin) {
      var n = nearest(x, z);
      if (n.dist <= wallOuter[n.d > 0 ? 1 : 0][n.index] + (margin || 0)) return true;
      var o = otherLevel(x, z, n.index);
      return o >= 0 && inOwnCorridor(x, z, o, margin || 0);
    }

    // Height of the rendered ground at any world point: the track surface inside the corridor,
    // the verge outside the walls, the terrain everywhere else. y (optional): at a bridge, the level closest to it
    // (without y: the road nearest in plan, as everywhere else).
    function groundY(x, z, y) {
      var n = nearest(x, z, y);
      if (n.dist > gyReach + 2) return terrainAt(x, z);   // (beyond every verge: plain terrain)
      var sd = n.d > 0 ? 1 : 0, ad = Math.abs(n.d), u = n.index;
      if (ad <= skO[sd][u] + 1e-6) return py[u] + n.d * tanB[u];
      var t = terrainAt(x, z), U = skU[sd][u];
      if (U < 1e-6 || ad >= skO[sd][u] + U) return t;
      var f = (ad - skO[sd][u]) / U, h = skH[sd], b = u * SK_ROWS, v;
      if (f <= SK_F[1]) v = h[b] + (h[b + 1] - h[b]) * (f / SK_F[1]);
      else v = h[b + 1] + (h[b + 2] - h[b + 1]) * ((f - SK_F[1]) / (1 - SK_F[1]));
      return v > t ? v : t;
    }

    // y (optional): at a bridge, the road whose surface at (x, z) is closest to that height (the car's own y: the
    // physics stays on its level); without it as before (the hinted window, else the nearest sample in plan).
    function locate(x, z, hintIndex, y) {
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
      if (y !== undefined && sepP[best]) best = pickLevel(x, z, best, y);
      return { index: best, d: (x - px[best]) * nx[best] + (z - pz[best]) * nz[best] };
    }

    // --- pit API (see "pit lane" above; README-interfaces.md, v6). k = samples from pit.from, -1 outside the lane.
    if (pit) (function () {
      var L = pitL, P = L.P, sg = L.side, K = P.L, kEn = P.kEn, kEx = P.kEx, lo = pit.from;
      function pk(index) {
        var k = ((index | 0) - lo) % N;
        if (k < 0) k += N;
        return k <= K ? k : -1;
      }
      // signed lateral offset of the lane centre at that sample, NaN outside from..to
      pit.laneD = function (index) { var k = pk(index); return k < 0 ? NaN : sg * P.lane[k]; };
      // signed lateral offset of the pit wall's centre line, NaN where there is no pit wall (outside it, openings)
      pit.wallD = function (index) {
        var k = pk(index);
        return k < 0 || !P.wall[k] ? NaN : sg * (L.face + PIT_WALL_HALF_T);
      };
      // between the entry and exit lines (inclusive), on the lane side of the pit wall, inside the outer wall
      pit.inLane = function (index, d) {
        var k = pk(index), a = d * sg;
        return k >= kEn && k <= kEx && a >= P.wof && a <= P.O[k];
      };
      // (addition) on the pit lane's asphalt anywhere from..to, tapers included (not the track itself): car.js can
      // use it for "not grass"
      pit.paved = function (index, d) {
        var k = pk(index), a = d * sg;
        return k >= 0 && a >= P.ai[k] && a <= P.ao[k] && a > halfW[lo + k < N ? lo + k : lo + k - N];
      };
      pit.contains = function (x, z) { var n = nearest(x, z); return pit.paved(n.index, n.d); };
      // Per-season limit (trackData.pitLimits: Zandvoort and Singapore 60 up to 2024, 80 from 2025): the limit in
      // season `year`, never above what the lane's geometry allows. setYear(year) makes it pit.limitKmh (car.js,
      // pit.js and main.js read that) and shows the matching painted signs; -> the limit. A year that is not a number
      // gives the current layout's rule.
      pit.limitFor = function (year) { return Math.min(L.layoutLimit, realPitLimit(trackData, year)); };
      pit.setYear = function (year) {
        var v = pit.limitFor(year);
        pit.limitKmh = v;
        pit.year = year === null || year === undefined || year === '' || !isFinite(+year) ? null : +year;
        for (var key in signMats) if (Object.prototype.hasOwnProperty.call(signMats, key)) signMats[key].visible = key === String(v);
        return v;
      };
    })();

    // Optional, e.g. once per frame: t in seconds (any clock). The light curtains pulse slowly.
    function update(t) {
      if (curtainMat && isFinite(t)) curtainMat.opacity = 0.8 + 0.2 * Math.sin(t * 2 * Math.PI / 1.6);
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
      // grade-separated crossings: [{up, lo (sample of the upper / lower road at the crossing), separation (m), deckFrom,
      // deckTo (upper-road samples the deck spans), deckLength, clearance (deck underside above the lower road), ...}]
      bridges: bridgeOut,
      grid: grid,            // [{index, d, x, z, heading}] per grid slot (0 = pole): see "Grid" above
      pit: pit,              // pit lane (null if there is no room for one): see "pit lane" / "pit API" above
      update: update,
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
