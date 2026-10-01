// js/tunnels.js — covered stretches of a circuit (Monaco's tunnel under the Fairmont hotel, ...), built in code from the
// track samples. Classic script on window.F1; THREE r149 global. Data: F1.TUNNEL_DATA (below, from tools/tunnels.json,
// OpenStreetMap, ODbL). No asset files: the two small canvas textures are drawn here (none in node: vertex colours only).
//
//   var tun = F1.buildTunnels(track, trackData, tunnelData?)   // tunnelData: list for this track (default
//                                                                // F1.TUNNEL_DATA[trackData.id]); [] or none -> empty group
//   tun.group            THREE.Group (add to the scene; empty when the track has no covered stretch)
//   tun.inTunnel(i)      0..1 at sample i: 0 outside, 1 deep inside, smooth over the first / last RAMP_IN (30) m
//   tun.lightAt(i)       daylight factor at sample i: 1 outside, LIGHT_IN (0.3) deep inside, smooth over RAMP_LIGHT (40) m
//   tun.covered(i)       bool: sample i lies between the portals of a covered stretch
//   tun.update(t, viewIndex?)   per frame (t in s, any clock); viewIndex = the sample the CAMERA is at (car.state.sampleIndex
//                        for the cockpit): drives the daylight glare in the portal openings seen from inside. Optional.
//   tun.tunnels          [{name, kind, from, to, length, sFrom, sTo}]  (sample indices / metres along the lap)
//   tun.stats            {tunnels, triangles, drawCalls, ms}
//   tun.dispose()
//
// What is built (per stretch, everything merged into 4 meshes for the whole track):
//   interior (unlit, baked light): side walls standing just behind the track's barriers (js/track.js wallPosDist /
//     wallNegDist + 0.52 m: the barrier stays the thing the car hits, the tunnel wall is never in front of it and only stands
//     where the track has a barrier), a chamfer, a flat soffit H_CEIL (6.8 m) above the road following its grade (level across),
//     two rows of ceiling light fixtures (four in the threshold zones at the portals), advertising boards on the wall
//     right above the barrier, all brighter towards the portals where daylight comes in.
//   exterior (lit like the scenery): roof slab, the block over the road up to the height of the mapped building(s) that
//     cover it (F1_SCENERY footprints, so it joins the hotel parts js/scenery.js keeps beside the corridor), the portal
//     facades (hotel windows or plain concrete), side walls.
//   shade (multiply decal): darkens the road, runoff and the barriers inside, so the interior reads dark from outside too.
//   glare (additive): the daylight in the portal openings as seen from inside (update(t, viewIndex)).
(function (global) {
  'use strict';
  var F1 = global.F1 = global.F1 || {};

  // Covered stretches per track id, in racing order: from = entry portal, to = exit portal ([lat, lon] on the circuit,
  // mapped to the nearest sample through trackData.geo; f* = the same points as fractions of the lap (fallback without
  // geo, and the search window for the nearest sample)). Generated from tools/tunnels.json (sources there).
  F1.TUNNEL_DATA = F1.TUNNEL_DATA || {
    'mc-1929': [
      { name: 'Portier', kind: 'underpass', facade: 'plain',
        from: [43.741060, 7.429974], to: [43.741084, 7.430250], fFrom: 0.42288, fTo: 0.43170 },
      { name: 'Tunnel', kind: 'tunnel', facade: 'hotel',
        from: [43.740362, 7.430326], to: [43.737778, 7.427973], fFrom: 0.45695, fTo: 0.56761 }
    ]
  };

  var H_CEIL = 6.8;        // soffit above the centreline road surface (m); js/scenery.js keeps spans >= 6.5 m (GANTRY_CLEAR_H)
  var CHAMFER = 0.7;       // 45-degree haunch between wall and soffit
  var SLAB = 1.2;          // roof slab above the soffit
  var WALL_GAP = 0.52;     // tunnel wall face this far behind the barrier's inner face (js/track.js WALL_THICK 0.5 + 2 cm)
  var WALL_SINK = 0.8;     // walls reach this far below the surface (no cracks against the runoff / skirt)
  var OUT_T = 1.1;         // block side this far beyond the tunnel wall face (stays inside js/scenery.js's corridor + CLEAR)
  var WING = 3.5;          // portal facade reaches this far beyond the block side
  var RAMP_IN = 30;        // inTunnel: 0 -> 1 over the first / last 30 m inside
  var RAMP_LIGHT = 40;     // daylight reaches this far in
  var LIGHT_IN = 0.3;      // lightAt deep inside
  var SHADE_IN = 0.5;      // road / barrier multiply factor deep inside (1 at the portals)
  var BARRIER_H = 1.2;     // js/track.js WALL_H
  var FIX_ROWS = [-3.6, 3.6], FIX_ROWS_THR = [-7.6, 7.6];   // fixture rows (lateral offsets); extra rows in the threshold zones
  var FIX_PITCH = 4.5, FIX_LEN = 2.6, FIX_W = 0.42, FIX_H = 0.14, THRESHOLD = 60;
  var BOARD_Y0 = 1.4, BOARD_Y1 = 2.5, BOARD_SEG = 3;          // ad boards: 3 sample steps (~6 m) each
  var VEIL_MAX = 0.9;      // glare strength deep inside
  var MIN_LEN = 12;        // m: shorter stretches are ignored

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smootherstep(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
  function mixc(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function mulc(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }

  function Buf() { this.p = []; this.c = []; this.u = []; this.tris = 0; }
  // Quad a-b-c-d (corners in order around it, either orientation), front face towards `toward` (a vector).
  Buf.prototype.quad = function (a, b, c, d, toward, ca, cb, cc, cd, ua, ub, uc, ud) {
    var e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2], e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    var flip = nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
    cb = cb || ca; cc = cc || ca; cd = cd || ca;
    ua = ua || [0, 0]; ub = ub || ua; uc = uc || ua; ud = ud || ua;
    if (flip) { this.tri(a, d, c, ca, cd, cc, ua, ud, uc); this.tri(a, c, b, ca, cc, cb, ua, uc, ub); }
    else { this.tri(a, b, c, ca, cb, cc, ua, ub, uc); this.tri(a, c, d, ca, cc, cd, ua, uc, ud); }
  };
  Buf.prototype.tri = function (a, b, c, ca, cb, cc, ua, ub, uc) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.c.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    this.u.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    this.tris++;
  };

  // ---- textures (browser only). Interior atlas 512 x 512: five advertising banners (rows of 96 px) over a white strip.
  var BANNERS = [
    { bg: '#d8141c', fg: '#ffffff', t: 'MONTE-CARLO' }, { bg: '#ffffff', fg: '#0b2a6b', t: 'GRAND PRIX' },
    { bg: '#111111', fg: '#f2c200', t: 'RIVIERA' }, { bg: '#0b6b3a', fg: '#ffffff', t: 'F1DRIVE' },
    { bg: '#f2f2f2', fg: '#c8102e', t: 'PRINCIPAUTÉ' }
  ];
  var UV_WHITE = [0.5, 1 - 500 / 512];
  function bannerUV(b) { return [0.004, 1 - (b * 96 + 92) / 512, 0.996, 1 - (b * 96 + 4) / 512]; }
  function makeCanvas(w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    return cv.getContext && cv.getContext('2d') ? cv : null;
  }
  function interiorAtlas(THREE) {
    var cv = makeCanvas(512, 512);
    if (!cv) return null;
    var g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
    for (var b = 0; b < BANNERS.length; b++) {
      var B = BANNERS[b], y = b * 96;
      g.fillStyle = B.bg; g.fillRect(0, y, 512, 96);
      g.fillStyle = B.fg; g.fillRect(0, y + 6, 512, 4); g.fillRect(0, y + 86, 512, 4);
      g.font = 'bold 58px Arial, Helvetica, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(B.t, 256, y + 50, 490);
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    return tex;
  }
  // Exterior facade tile (repeats): one bay 4 m wide x one floor 3.2 m high; the top-left corner is plain wall
  // (UV_PLAIN: roofs, concrete, lintels get their colour from the vertex colour times that wall tone).
  var BAY = 4, FLOOR = 3.2, UV_PLAIN = [0.04, 0.96];
  function facadeTex(THREE) {
    var cv = makeCanvas(128, 128);
    if (!cv) return null;
    var g = cv.getContext('2d');
    g.fillStyle = '#eee6d6'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#d9cfbd'; g.fillRect(0, 100, 128, 10);             // balcony slab
    g.fillStyle = '#f6f2ea'; g.fillRect(0, 96, 128, 4);
    g.fillStyle = '#4b5a66'; g.fillRect(22, 30, 84, 66);              // window / french door
    g.fillStyle = '#7f909c'; g.fillRect(26, 34, 37, 26); g.fillRect(65, 34, 37, 26);
    g.fillStyle = '#f2efe8'; g.fillRect(62, 30, 4, 66); g.fillRect(22, 28, 84, 4);
    g.strokeStyle = '#c9c2b4'; g.lineWidth = 2;                       // railing
    for (var x = 22; x <= 106; x += 6) { g.beginPath(); g.moveTo(x, 78); g.lineTo(x, 96); g.stroke(); }
    g.fillStyle = '#c9c2b4'; g.fillRect(20, 76, 88, 3);
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  // ---- mapping the data onto the samples
  function locateEnd(track, trackData, ll, f) {
    var S = track.samples, N = S.length, hint = -1, best = -1, bd = Infinity, q;
    if (isFinite(f)) hint = ((Math.round((f - Math.floor(f)) * N) % N) + N) % N;
    var g = trackData && trackData.geo;
    if (ll && g && isFinite(g.kx) && isFinite(g.kz)) {
      var x = (ll[1] - g.lon0) * g.kx, z = (ll[0] - g.lat0) * g.kz;
      if (hint >= 0) {
        var win = Math.max(40, Math.round(N * 0.04));
        for (q = -win; q <= win; q++) {
          var c = ((hint + q) % N + N) % N, ex = S[c].x - x, ez = S[c].z - z, dd = ex * ex + ez * ez;
          if (dd < bd) { bd = dd; best = c; }
        }
      } else if (typeof track.nearest === 'function') best = track.nearest(x, z).index;
      if (best >= 0 && bd > 30 * 30 && hint >= 0 && typeof track.nearest === 'function') {
        var n = track.nearest(x, z);       // far from the hinted window: trust the geometry
        if (n.dist < Math.sqrt(bd)) best = n.index;
      }
      return best;
    }
    return hint;
  }

  // Height of the mapped building(s) standing over sample i's road (js/scenery.js measures a building from the lowest ground
  // under its footprint: top = max(gmin + h, gmax + 2.5)); -Infinity where none.
  function pointInPoly(x, z, p) {
    var c = false;
    for (var a = 0, b = p.length - 1; a < p.length; b = a++) {
      if (((p[a][1] > z) !== (p[b][1] > z)) && (x < (p[b][0] - p[a][0]) * (z - p[a][1]) / (p[b][1] - p[a][1]) + p[a][0])) c = !c;
    }
    return c;
  }

  F1.buildTunnels = function (track, trackData, tunnelData) {
    var THREE = global.THREE, t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    var S = track.samples, N = S.length, i, k;
    var group = new THREE.Group();
    group.name = 'tunnels';
    var inT = new Float32Array(N), light = new Float32Array(N).fill(1), cov = new Uint8Array(N);
    var list = tunnelData !== undefined && tunnelData !== null ? tunnelData :
      (trackData && trackData.id && F1.TUNNEL_DATA ? F1.TUNNEL_DATA[trackData.id] : null);
    if (!Array.isArray(list)) list = [];
    var len = track.length || 0, ds = len / N;
    function wrap(q) { return ((q % N) + N) % N; }
    function sY(idx, d) {
      if (typeof track.surfaceY === 'function') return track.surfaceY(idx, d);
      var s = S[idx]; return (isFinite(s.y) ? s.y : 0) + d * Math.tan(s.bank || 0);
    }
    function gY(x, z, fb) {
      if (typeof track.groundY === 'function') { var v = track.groundY(x, z); if (isFinite(v)) return v; }
      return fb;
    }

    // mapped buildings (js/scenery.js data) for the block heights
    var sceneB = [];
    (function () {
      var sc = global.F1_SCENERY && trackData && trackData.id ? global.F1_SCENERY[trackData.id] : null;
      var bl = sc && Array.isArray(sc.buildings) ? sc.buildings : [];
      for (var a = 0; a < bl.length; a++) {
        var b = bl[a];
        if (!b || !Array.isArray(b.p) || b.p.length < 3 || b.k === 'bridge') continue;
        var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (var q = 0; q < b.p.length; q++) {
          x0 = Math.min(x0, b.p[q][0]); x1 = Math.max(x1, b.p[q][0]); z0 = Math.min(z0, b.p[q][1]); z1 = Math.max(z1, b.p[q][1]);
        }
        sceneB.push({ p: b.p, h: isFinite(b.h) ? +b.h : 8, x0: x0, x1: x1, z0: z0, z1: z1, top: null });
      }
    })();
    function bTop(b) {
      if (b.top !== null) return b.top;
      var gmin = Infinity, gmax = -Infinity, n = b.p.length, cx = 0, cz = 0, a, g;
      for (a = 0; a < n; a++) {
        var u = b.p[a], v = b.p[(a + 1) % n];
        g = gY(u[0], u[1], NaN); if (g === g) { gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
        g = gY((u[0] + v[0]) / 2, (u[1] + v[1]) / 2, NaN); if (g === g) { gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
        cx += u[0]; cz += u[1];
      }
      g = gY(cx / n, cz / n, NaN); if (g === g) { gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
      b.top = gmin < Infinity ? Math.max(gmin + clamp(b.h, 2.5, 400), gmax + 2.5) : -Infinity;
      return b.top;
    }
    function buildingTop(idx) {
      var s = S[idx], best = -Infinity, offs = [-6, 0, 6];
      for (var a = 0; a < sceneB.length; a++) {
        var b = sceneB[a];
        if (s.x < b.x0 - 7 || s.x > b.x1 + 7 || s.z < b.z0 - 7 || s.z > b.z1 + 7) continue;
        for (var o = 0; o < offs.length; o++) {
          if (pointInPoly(s.x + s.nx * offs[o], s.z + s.nz * offs[o], b.p)) { best = Math.max(best, bTop(b)); break; }
        }
      }
      return best;
    }

    var inner = new Buf(), outer = new Buf(), shade = new Buf(), veil = new Buf();
    var ranges = [];

    // colours (linear; the game renders without tone mapping)
    var C_TILE = [0.88, 0.86, 0.80], C_LOW = [0.30, 0.30, 0.31], C_SOFFIT = [0.36, 0.35, 0.33];
    var C_LENS = [1.0, 0.96, 0.86], C_HOUSING = [0.42, 0.42, 0.44];
    var C_CONC = [0.80, 0.79, 0.76], C_ROOF = [0.62, 0.62, 0.63], C_PLAIN = [0.74, 0.73, 0.70];

    for (var ti = 0; ti < list.length; ti++) {
      var td = list[ti];
      if (!td) continue;
      var ia = locateEnd(track, trackData, td.from, td.fFrom), ib = locateEnd(track, trackData, td.to, td.fTo);
      if (ia < 0 || ib < 0) continue;
      var K = wrap(ib - ia);
      if (K < 2 || K > N / 2 || K * ds < MIN_LEN) continue;
      buildOne(td, ia, K);
    }

    function buildOne(td, ia, K) {
      var idx = new Int32Array(K + 1), arc = new Float64Array(K + 1), Ltot, k, q;
      for (k = 0; k <= K; k++) {
        idx[k] = wrap(ia + k);
        if (k) arc[k] = arc[k - 1] + Math.hypot(S[idx[k]].x - S[idx[k - 1]].x, S[idx[k]].z - S[idx[k - 1]].z);
      }
      Ltot = arc[K];
      var hotel = td.facade === 'hotel';
      // per-sample cross-section
      var X = [], Z = [], NX = [], NZ = [], YC = [], YR = [], YT = [], EL = [], ER = [], FL = [], FR = [], DAY = [];
      var tops = [];
      for (k = 0; k <= K; k++) {
        var s = S[idx[k]];
        X[k] = s.x; Z[k] = s.z; NX[k] = s.nx; NZ[k] = s.nz;
        var yc = (isFinite(s.y) ? s.y : 0) + H_CEIL;
        YC[k] = yc; YR[k] = yc + SLAB;
        EL[k] = (isFinite(s.wallPosDist) ? s.wallPosDist : (track.wallDist || 12)) + WALL_GAP;
        ER[k] = (isFinite(s.wallNegDist) ? s.wallNegDist : (track.wallDist || 12)) + WALL_GAP;
        FL[k] = s.wallPos !== false; FR[k] = s.wallNeg !== false;
        var dist = Math.min(arc[k], Ltot - arc[k]);
        DAY[k] = 1 - smootherstep(dist / RAMP_LIGHT);                     // 1 at a portal -> 0 deep inside
        var it = smootherstep(dist / RAMP_IN), lt = 1 - (1 - LIGHT_IN) * smootherstep(dist / RAMP_LIGHT);
        var ii = idx[k];
        if (k > 0 && k < K) cov[ii] = 1;
        if (it > inT[ii]) inT[ii] = it;
        if (lt < light[ii]) light[ii] = lt;
        tops[k] = buildingTop(ii);
      }
      // block top: the covering building where there is one (constant per building, as js/scenery.js builds it), else the
      // roof slab; a short gap between two covered parts is bridged at the lower of the two tops
      for (k = 0; k <= K; k++) YT[k] = Math.max(YR[k] + 0.6, tops[k]);
      ranges.push({ name: td.name || '', kind: td.kind || 'tunnel', from: idx[0], to: idx[K], length: Math.round(Ltot),
        sFrom: Math.round(S[idx[0]].s), sTo: Math.round(S[idx[K]].s) });

      function P(k, d, y) { return [X[k] + NX[k] * d, y, Z[k] + NZ[k] * d]; }
      function n3(k, sgn) { return [NX[k] * sgn, 0, NZ[k] * sgn]; }
      var UP = [0, 1, 0], DOWN = [0, -1, 0];
      // baked interior light: walls brighter towards the top (the fixtures) and towards the portals (daylight)
      function wallCol(k, f) { return mulc(C_TILE, (0.50 + 0.12 * f) * (1 - DAY[k]) + 0.95 * DAY[k]); }
      function soffitCol(k) { return mulc(C_SOFFIT, 0.62 * (1 - DAY[k]) + 1.6 * DAY[k]); }

      for (k = 0; k < K; k++) {
        var w = k + 1, side;
        // ---- side walls: lower part (behind the barrier), tiled part, chamfer
        for (side = -1; side <= 1; side += 2) {
          if (side > 0 ? !(FL[k] && FL[w]) : !(FR[k] && FR[w])) continue;
          var eu = side > 0 ? EL[k] : ER[k], ew = side > 0 ? EL[w] : ER[w], du = side * eu, dw = side * ew;
          var gu = sY(idx[k], du), gw = sY(idx[w], dw), inward = n3(k, -side);
          var hu = gu + BARRIER_H + 0.15, hw2 = gw + BARRIER_H + 0.15;
          inner.quad(P(k, du, gu - WALL_SINK), P(w, dw, gw - WALL_SINK), P(w, dw, hw2), P(k, du, hu), inward,
            mulc(C_LOW, 1), null, null, null, UV_WHITE);
          var tu = YC[k] - CHAMFER, tw = YC[w] - CHAMFER;
          inner.quad(P(k, du, hu), P(w, dw, hw2), P(w, dw, tw), P(k, du, tu), inward,
            wallCol(k, 0), wallCol(w, 0), wallCol(w, 1), wallCol(k, 1), UV_WHITE);
          inner.quad(P(k, du, tu), P(w, dw, tw), P(w, side * (ew - CHAMFER), YC[w]), P(k, side * (eu - CHAMFER), YC[k]),
            [inward[0], -1, inward[2]], mulc(wallCol(k, 1), 0.85), mulc(wallCol(w, 1), 0.85), null, null, UV_WHITE);
        }
        // ---- soffit (three strips: the middle one a little darker between the fixture rows)
        var cuts = [-(ER[k] - CHAMFER), -5.4, 5.4, EL[k] - CHAMFER], cutsW = [-(ER[w] - CHAMFER), -5.4, 5.4, EL[w] - CHAMFER];
        for (q = 0; q < 3; q++) {
          var cm = q === 1 ? 0.85 : 1;
          inner.quad(P(k, cuts[q], YC[k]), P(w, cutsW[q], YC[w]), P(w, cutsW[q + 1], YC[w]), P(k, cuts[q + 1], YC[k]), DOWN,
            mulc(soffitCol(k), cm), mulc(soffitCol(w), cm), null, null, UV_WHITE);
        }
        // ---- shade decal: road + runoff, barrier faces and tops (only where the barrier is)
        var fu = 1 - (1 - SHADE_IN) * (1 - DAY[k]), fw = 1 - (1 - SHADE_IN) * (1 - DAY[w]);
        var cu = [fu, fu, fu], cw = [fw, fw, fw];
        var bLu = EL[k] - WALL_GAP, bLw = EL[w] - WALL_GAP, bRu = ER[k] - WALL_GAP, bRw = ER[w] - WALL_GAP;
        shade.quad(P(k, -bRu, sY(idx[k], -bRu) + 0.06), P(w, -bRw, sY(idx[w], -bRw) + 0.06),
          P(w, bLw, sY(idx[w], bLw) + 0.06), P(k, bLu, sY(idx[k], bLu) + 0.06), UP, cu, cw, cw, cu);
        for (side = -1; side <= 1; side += 2) {
          if (side > 0 ? !(FL[k] && FL[w]) : !(FR[k] && FR[w])) continue;
          var bu = side * ((side > 0 ? bLu : bRu) - 0.02), bw = side * ((side > 0 ? bLw : bRw) - 0.02);
          var su = sY(idx[k], bu), sw = sY(idx[w], bw);
          shade.quad(P(k, bu, su - 0.05), P(w, bw, sw - 0.05), P(w, bw, sw + BARRIER_H + 0.02), P(k, bu, su + BARRIER_H + 0.02),
            n3(k, -side), cu, cw, cw, cu);
          var bu2 = bu + side * 0.54, bw2 = bw + side * 0.54;
          shade.quad(P(k, bu, su + BARRIER_H + 0.02), P(w, bw, sw + BARRIER_H + 0.02), P(w, bw2, sw + BARRIER_H + 0.02),
            P(k, bu2, su + BARRIER_H + 0.02), UP, cu, cw, cw, cu);
        }
        // ---- exterior: block top, block sides
        var oLu = EL[k] + OUT_T, oLw = EL[w] + OUT_T, oRu = ER[k] + OUT_T, oRw = ER[w] + OUT_T;
        outer.quad(P(k, -oRu, YT[k]), P(w, -oRw, YT[k]), P(w, oLw, YT[k]), P(k, oLu, YT[k]), UP, C_ROOF, null, null, null, UV_PLAIN);
        if (Math.abs(YT[w] - YT[k]) > 0.01) {      // a step in the roof line: riser at w
          outer.quad(P(w, -oRw, YT[k]), P(w, oLw, YT[k]), P(w, oLw, YT[w]), P(w, -oRw, YT[w]),
            [S[idx[w]].tx * (YT[w] > YT[k] ? -1 : 1), 0, S[idx[w]].tz * (YT[w] > YT[k] ? -1 : 1)], hotel ? [1, 1, 1] : C_PLAIN, null, null, null, UV_PLAIN);
        }
        for (side = -1; side <= 1; side += 2) {
          var ou = side * (side > 0 ? oLu : oRu), ow = side * (side > 0 ? oLw : oRw);
          var bot0 = Math.min(sY(idx[k], ou), gY(X[k] + NX[k] * ou, Z[k] + NZ[k] * ou, sY(idx[k], ou))) - 1.5;
          var bot1 = Math.min(sY(idx[w], ow), gY(X[w] + NX[w] * ow, Z[w] + NZ[w] * ow, sY(idx[w], ow))) - 1.5;
          var ua = arc[k] / BAY, ub = arc[w] / BAY;
          outer.quad(P(k, ou, bot0), P(w, ow, bot1), P(w, ow, YT[k]), P(k, ou, YT[k]), n3(k, side),
            hotel ? [1, 1, 1] : C_PLAIN, null, null, null,
            hotel ? [ua, bot0 / FLOOR] : UV_PLAIN, hotel ? [ub, bot1 / FLOOR] : UV_PLAIN,
            hotel ? [ub, YT[k] / FLOOR] : UV_PLAIN, hotel ? [ua, YT[k] / FLOOR] : UV_PLAIN);
        }
      }

      // ---- light fixtures: boxes hanging from the soffit, lens facing down
      function at(a) {          // interpolated frame at arc length a
        var lo = 0, hi = K;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (arc[mid] <= a) lo = mid; else hi = mid; }
        var f = (a - arc[lo]) / ((arc[hi] - arc[lo]) || 1), nx = NX[lo] + (NX[hi] - NX[lo]) * f, nz = NZ[lo] + (NZ[hi] - NZ[lo]) * f;
        var nl = Math.hypot(nx, nz) || 1;
        return { x: X[lo] + (X[hi] - X[lo]) * f, z: Z[lo] + (Z[hi] - Z[lo]) * f, y: YC[lo] + (YC[hi] - YC[lo]) * f,
          nx: nx / nl, nz: nz / nl, tx: -nz / nl, tz: nx / nl };
      }
      function fixture(a, d) {
        var F = at(a), hl = FIX_LEN / 2, hw = FIX_W / 2, y1 = F.y - 0.01, y0 = F.y - FIX_H;
        function c(al, la, y) { return [F.x + F.tx * al + F.nx * (d + la), y, F.z + F.tz * al + F.nz * (d + la)]; }
        inner.quad(c(-hl, -hw, y0), c(hl, -hw, y0), c(hl, hw, y0), c(-hl, hw, y0), DOWN, C_LENS, null, null, null, UV_WHITE);
        inner.quad(c(-hl, -hw, y0), c(hl, -hw, y0), c(hl, -hw, y1), c(-hl, -hw, y1), [-F.nx, 0, -F.nz], C_HOUSING, null, null, null, UV_WHITE);
        inner.quad(c(-hl, hw, y0), c(hl, hw, y0), c(hl, hw, y1), c(-hl, hw, y1), [F.nx, 0, F.nz], C_HOUSING, null, null, null, UV_WHITE);
        inner.quad(c(-hl, -hw, y0), c(-hl, hw, y0), c(-hl, hw, y1), c(-hl, -hw, y1), [-F.tx, 0, -F.tz], C_HOUSING, null, null, null, UV_WHITE);
        inner.quad(c(hl, -hw, y0), c(hl, hw, y0), c(hl, hw, y1), c(hl, -hw, y1), [F.tx, 0, F.tz], C_HOUSING, null, null, null, UV_WHITE);
      }
      var nFix = Math.floor((Ltot - 2) / FIX_PITCH), a0 = (Ltot - nFix * FIX_PITCH) / 2, r;
      for (q = 0; q <= nFix; q++) {
        var a = a0 + q * FIX_PITCH;
        if (a < FIX_LEN / 2 + 0.5 || a > Ltot - FIX_LEN / 2 - 0.5) continue;
        for (r = 0; r < FIX_ROWS.length; r++) fixture(a, FIX_ROWS[r]);
        if (Ltot > 2.5 * THRESHOLD && (a < THRESHOLD || a > Ltot - THRESHOLD)) for (r = 0; r < FIX_ROWS_THR.length; r++) fixture(a, FIX_ROWS_THR[r]);
      }

      // ---- advertising boards on the walls above the barrier: runs of 4 boards, 12 m apart, alternating banners
      var bIdx = ti * 2, made = 0;
      for (var side2 = -1; side2 <= 1; side2 += 2) {
        for (k = 2; k + BOARD_SEG <= K - 2; k += BOARD_SEG) {
          var run = Math.floor((k - 2) / BOARD_SEG) % 6;
          if (run >= 4 || (side2 < 0 && run >= 2)) continue;         // right (inside) wall: shorter runs
          var ok = true;
          for (q = 0; q <= BOARD_SEG; q++) if (side2 > 0 ? !FL[k + q] : !FR[k + q]) ok = false;
          if (!ok) continue;
          var uvB = bannerUV((bIdx + Math.floor(made / 4)) % BANNERS.length);
          for (q = 0; q < BOARD_SEG; q++) {
            var k0 = k + q, k1 = k0 + 1, e0 = side2 * ((side2 > 0 ? EL[k0] : ER[k0]) - 0.04), e1 = side2 * ((side2 > 0 ? EL[k1] : ER[k1]) - 0.04);
            var g0 = sY(idx[k0], e0), g1 = sY(idx[k1], e1);
            // text reads left to right from the road: on the left wall that is along the lap, on the right against it
            var u0 = uvB[0] + (uvB[2] - uvB[0]) * (side2 > 0 ? q : BOARD_SEG - q) / BOARD_SEG;
            var u1 = uvB[0] + (uvB[2] - uvB[0]) * (side2 > 0 ? q + 1 : BOARD_SEG - q - 1) / BOARD_SEG;
            var lc0 = mulc([1, 1, 1], 0.62 * (1 - DAY[k0]) + DAY[k0]), lc1 = mulc([1, 1, 1], 0.62 * (1 - DAY[k1]) + DAY[k1]);
            inner.quad(P(k0, e0, g0 + BOARD_Y0), P(k1, e1, g1 + BOARD_Y0), P(k1, e1, g1 + BOARD_Y1), P(k0, e0, g0 + BOARD_Y1),
              n3(k0, -side2), lc0, lc1, lc1, lc0, [u0, uvB[1]], [u1, uvB[1]], [u1, uvB[3]], [u0, uvB[3]]);
          }
          made++;
        }
      }

      // ---- portals: facade (lintel over the opening + wings), the glare veil just inside
      function portal(k, out) {     // out = +1: the facade faces along the lap (exit), -1: against it (entry)
        var s = S[idx[k]], face = [s.tx * out, 0, s.tz * out];
        var eL = EL[k], eR = ER[k], oL = eL + OUT_T + WING, oR = eR + OUT_T + WING, top = YT[k];
        var gL = Math.min(sY(idx[k], oL), gY(X[k] + NX[k] * oL, Z[k] + NZ[k] * oL, sY(idx[k], oL))) - 1.5;
        var gR = Math.min(sY(idx[k], -oR), gY(X[k] - NX[k] * oR, Z[k] - NZ[k] * oR, sY(idx[k], -oR))) - 1.5;
        var off = out * 0.02;      // a hair outside the cross-section plane
        function F(d, y) { return [X[k] + NX[k] * d + s.tx * off, y, Z[k] + NZ[k] * d + s.tz * off]; }
        function fuv(d, y) { return hotel ? [d / BAY, y / FLOOR] : UV_PLAIN; }
        var cf = hotel ? [1, 1, 1] : C_CONC, lint = YC[k] + 1.0;
        // concrete lintel band right over the opening, then the facade up to the top
        outer.quad(F(-eR, YC[k]), F(eL, YC[k]), F(eL, lint), F(-eR, lint), face, C_CONC, null, null, null, UV_PLAIN);
        outer.quad(F(-oR, lint), F(oL, lint), F(oL, top), F(-oR, top), face, cf, null, null, null,
          fuv(-oR, lint), fuv(oL, lint), fuv(oL, top), fuv(-oR, top));
        outer.quad(F(eL, gL), F(oL, gL), F(oL, lint), F(eL, lint), face, cf, null, null, null, fuv(eL, gL), fuv(oL, gL), fuv(oL, lint), fuv(eL, lint));
        outer.quad(F(-oR, gR), F(-eR, gR), F(-eR, lint), F(-oR, lint), face, cf, null, null, null, fuv(-oR, gR), fuv(-eR, gR), fuv(-eR, lint), fuv(-oR, lint));
        // the wings' backs and ends (visible from the side), the parapet cap
        var back = 0.6 * -out;
        function Fb(d, y) { return [X[k] + NX[k] * d + s.tx * back, y, Z[k] + NZ[k] * d + s.tz * back]; }
        outer.quad(Fb(oL, gL), Fb(oL, top), F(oL, top), F(oL, gL), n3(k, 1), C_PLAIN, null, null, null, UV_PLAIN);
        outer.quad(Fb(-oR, gR), Fb(-oR, top), F(-oR, top), F(-oR, gR), n3(k, -1), C_PLAIN, null, null, null, UV_PLAIN);
        outer.quad(Fb(eL + OUT_T, gL), Fb(oL, gL), Fb(oL, top), Fb(eL + OUT_T, top), [-face[0], 0, -face[2]], C_PLAIN, null, null, null, UV_PLAIN);
        outer.quad(Fb(-oR, gR), Fb(-eR - OUT_T, gR), Fb(-eR - OUT_T, top), Fb(-oR, top), [-face[0], 0, -face[2]], C_PLAIN, null, null, null, UV_PLAIN);
        outer.quad(Fb(-oR, top), Fb(oL, top), F(oL, top), F(-oR, top), UP, C_ROOF, null, null, null, UV_PLAIN);
        // portal reveal: the inner wall faces' ends and the lintel's underside are the tunnel's own walls / soffit
        // glare veil, 1.5 m inside, facing inwards
        var kv = out > 0 ? Math.max(0, k - 1) : Math.min(K, k + 1), sv = S[idx[kv]];
        var vin = [-sv.tx * out, 0, -sv.tz * out];
        var dl = [-ER[kv] + 0.05, -ER[kv] * 0.45, 0, EL[kv] * 0.45, EL[kv] - 0.05], ys = [0, 0.45, 1];
        var g0v = sY(idx[kv], 0), hv = YC[kv] - 0.05 - g0v;
        function VP(a, b) { return [X[kv] + NX[kv] * dl[a], g0v + hv * ys[b], Z[kv] + NZ[kv] * dl[a]]; }
        function VC(a, b) {
          var e = (a === 0 || a === 4) ? 0 : (a === 2 ? 1 : 0.8), h = b === 2 ? 0 : (b === 1 ? 0.8 : 1), v = e * h;
          return [v, v * 0.98, v * 0.92];
        }
        for (var a1 = 0; a1 < 4; a1++) {
          for (var b1 = 0; b1 < 2; b1++) {
            veil.quad(VP(a1, b1), VP(a1 + 1, b1), VP(a1 + 1, b1 + 1), VP(a1, b1 + 1), vin,
              VC(a1, b1), VC(a1 + 1, b1), VC(a1 + 1, b1 + 1), VC(a1, b1 + 1));
          }
        }
      }
      portal(0, -1);
      portal(K, 1);
    }

    // ---- meshes
    var meshes = [], textures = [], materials = [];
    function geom(buf, withUV) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.p), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(buf.c), 3));
      if (withUV) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf.u), 2));
      g.computeVertexNormals();
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    }
    function add(name, buf, mat, order, withUV) {
      if (!buf.tris) { mat.dispose(); return null; }
      var m = new THREE.Mesh(geom(buf, withUV), mat);
      m.name = name; m.renderOrder = order; m.matrixAutoUpdate = false;
      group.add(m); meshes.push(m); materials.push(mat);
      return m;
    }
    var atlas = inner.tris ? interiorAtlas(THREE) : null, ftex = outer.tris ? facadeTex(THREE) : null;
    if (atlas) textures.push(atlas);
    if (ftex) textures.push(ftex);
    add('tunnel-interior', inner, new THREE.MeshBasicMaterial({ vertexColors: true, map: atlas }), 0, true);
    add('tunnel-exterior', outer, new THREE.MeshLambertMaterial({ vertexColors: true, map: ftex, side: THREE.DoubleSide }), 0, true);
    add('tunnel-shade', shade, new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.MultiplyBlending,
      depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), 5, false);
    var veilMat = new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0, depthWrite: false, fog: false });
    var veilMesh = add('tunnel-glare', veil, veilMat, 11, false);
    if (veilMesh) { veilMesh.visible = false; veilMesh.userData.mirror = true; }

    var tris = 0;
    for (i = 0; i < meshes.length; i++) tris += meshes[i].geometry.attributes.position.count / 3;
    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();

    function okIdx(index) { index = index | 0; return index >= 0 && index < N ? index : wrap(index); }
    function inTunnel(index) { return N ? inT[okIdx(index)] : 0; }
    function lightAt(index) { return N ? light[okIdx(index)] : 1; }
    function covered(index) { return N ? cov[okIdx(index)] === 1 : false; }
    function update(t, viewIndex) {
      if (!veilMesh || viewIndex === undefined || viewIndex === null || !isFinite(viewIndex)) return;
      var dark = (1 - lightAt(viewIndex)) / (1 - LIGHT_IN);
      veilMat.opacity = VEIL_MAX * clamp(dark, 0, 1);
      veilMesh.visible = veilMat.opacity > 0.01;
    }
    function dispose() {
      for (var a = 0; a < meshes.length; a++) { meshes[a].geometry.dispose(); group.remove(meshes[a]); }
      for (a = 0; a < materials.length; a++) materials[a].dispose();
      for (a = 0; a < textures.length; a++) textures[a].dispose();
      meshes = []; materials = []; textures = [];
      if (group.parent) group.parent.remove(group);
    }

    return {
      group: group,
      tunnels: ranges,
      inTunnel: inTunnel,
      lightAt: lightAt,
      covered: covered,
      update: update,
      dispose: dispose,
      stats: { tunnels: ranges.length, triangles: tris, drawCalls: meshes.length, ms: Math.round((t1 - t0) * 10) / 10 }
    };
  };
})(typeof window !== 'undefined' ? window : this);
