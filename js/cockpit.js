// F1Drive - first-person cockpit model + camera rig. See js/README-interfaces.md.
// Car-local frame: +Z forward, +Y up, +X = driver's LEFT (because heading h -> forward (sin h, 0, cos h)).
// Everything is generated in code: lofted bodywork, aerofoil wing elements, lathed tyres and rims, an extruded
// steering wheel, and canvas textures (livery atlas, carbon weave, tyre sidewalls, a small environment map for the
// reflections, the live steering-wheel display). Static parts are merged into one geometry per material, so the
// whole car is 17 draw calls. Only what the driver can see (with the head turned 55 deg) is modelled. The mirrors
// show a live rear view: a small render target drawn during the main render (see "live mirrors" below).
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var EYE_Y = 0.80, EYE_Z = -0.35;
  // Vertical field of view: a base value at a standstill that widens with speed, by (FOV_MAX - FOV_MIN) / FOV_MIN of it
  // at V_TOP (v5..v6.1: 70 -> 82 deg). v6.2: the base defaults to FOV_DEFAULT (track audit: at 70-82 deg on an ordinary
  // screen every angle shows at about 0.3x, so a 15 % climb read like 4-5 %); setFov(deg) picks it in
  // FOV_SET_MIN..FOV_SET_MAX (the 設定 tab). The widening stays proportional: 60 -> 70.3 deg, 70 -> 82 exactly as v5.
  var FOV_MIN = 70, FOV_MAX = 82, V_TOP = 330 / 3.6;
  var FOV_DEFAULT = 60, FOV_SET_MIN = 50, FOV_SET_MAX = 75;
  // Framing: a narrower FOV alone would push the steering-wheel display down under the HUD's telemetry graphic (at 60
  // deg its lower edge fell from 83 % to 91 % of the picture's height). A vertical lens shift in the projection (the
  // picture moves, the view does not tilt, verticals stay vertical) keeps the point FRAME_TAN below the line of sight
  // (the display's lower edge, 25 deg) at the height v5's camera showed it at the same speed. FOV setting 70: none (v5's
  // camera); narrower: the picture moves up (60: the horizon at 43 % of the height, more road); wider: down.
  var FRAME_TAN = Math.tan(25 * Math.PI / 180);
  var WHEEL_X = 0.80, AXLE_Z = 1.9;
  var WHEEL_STEER_VIS = 0.30;      // rad of visible front-wheel steer at steer = 1
  var HANDWHEEL_VIS = 1.0;         // rad of steering-wheel rotation at steer = 1
  var DISPLAY_DT = 1 / 15;         // the wheel display is redrawn at most this often (and only when it changes)
  var BLUR_SPEED = 7;              // m/s: above this the sidewall lettering is drawn motion-blurred
  // ---- road shape cues (v6.2) ----
  // The camera used to follow the car 1:1, so a banked road stayed level on screen and only the scenery leaned
  // (Zandvoort / Madring "not felt"), and a steady climb looked exactly like a flat road (Spa "not felt"). The head now
  // - keeps HEAD_ROLL_KEEP of the car's roll out, following the roll HEAD_ROLL_TAU later: the banking reads as the road
  //   and the cockpit tilting;
  // - takes out HEAD_PITCH_KEEP of the car's pitch, slowly (HEAD_PITCH_TAU): a change of slope still swings the view at
  //   first, then the head settles and a steady climb shows as the nose and the road rising against the horizon (a
  //   descent: falling away);
  // - sinks and nods under the road's compression: car.state.compress in g (banking, dips > 0, crests < 0), or else
  //   state.seatG - 1 (the seat load in g); neither: nothing.
  // Both counter-rotations turn about the CAR's axes whatever the head look (added to the YXZ look angles: roll
  // x -= a sin(yaw), z += a cos(yaw); pitch x -= b cos(yaw), z -= b sin(yaw)), so camera.rotation.y stays PI + yaw,
  // which main.js's audio listener reads. On a level road with no compression all of it is exactly 0.
  var HEAD_ROLL_KEEP = 0.45;       // share of the car's roll the head takes out (0 = the v6.1 camera)
  var HEAD_ROLL_TAU = 0.25;        // s: the neck follows the car's roll this much later
  var HEAD_PITCH_KEEP = 0.5;       // share of the car's pitch the head takes out once settled
  var HEAD_PITCH_TAU = 0.6;        // s: slow, so a crest / dip still swings the view before the head catches it
  var COMPRESS_EYE = 0.012;        // m the eye sinks per g of compression
  var COMPRESS_NOD = 0.004;        // rad the head nods down per g
  var COMPRESS_MIN = -1, COMPRESS_MAX = 2.5, COMPRESS_TAU = 0.08;   // g, g, s

  // ---- driver head look (right stick) ---------------------------------------
  // Limits follow what a real F1 driver can do. The helmet is boxed in by the headrest surround and
  // tethered by the HANS device, so the HEAD only turns about 20-25 deg to each side and nods a few
  // degrees; the rest of a mirror check is done with the EYES (comfortably ~30 deg sideways inside the
  // visor opening). Full stick therefore gives head + eyes:
  //   yaw   25 deg head + 30 deg eyes = 55 deg each way (enough to read a mirror, not to look behind)
  //   pitch a few degrees of nod + eyes, cut off by the visor top edge / the chin bar and cockpit rim
  var DEG = Math.PI / 180;
  var LOOK_HEAD_YAW = 25 * DEG;    // part of the yaw done by turning the helmet (moves the eye point)
  var LOOK_EYE_YAW = 30 * DEG;     // part done by the eyes alone
  var LOOK_MAX_YAW = LOOK_HEAD_YAW + LOOK_EYE_YAW;   // 55 deg
  var LOOK_MAX_PITCH_UP = 12 * DEG;
  var LOOK_MAX_PITCH_DOWN = 10 * DEG;
  var LOOK_SMOOTH = 0.12;          // s, critically damped follow time (stick flicks do not snap the view)
  var LOOK_NECK = 0.09;            // m from the neck axis forward to the eyes: turning the head swings
                                   //   the eye point sideways a little, as it does for the driver

  // radians
  F1.COCKPIT_LOOK = { maxYaw: LOOK_MAX_YAW, maxPitchUp: LOOK_MAX_PITCH_UP, maxPitchDown: LOOK_MAX_PITCH_DOWN,
                      headYaw: LOOK_HEAD_YAW, smoothTime: LOOK_SMOOTH };
  // the FOV setting (deg, vertical, at a standstill): its default and range for the UI; widen = the share it grows by
  // at top speed
  F1.COCKPIT_FOV = { def: FOV_DEFAULT, min: FOV_SET_MIN, max: FOV_SET_MAX, widen: (FOV_MAX - FOV_MIN) / FOV_MIN };
  // the road shape cues (see above): shares, time constants (s), eye drop (m / g), nod (rad / g)
  F1.COCKPIT_HEAD = { rollKeep: HEAD_ROLL_KEEP, rollTau: HEAD_ROLL_TAU, pitchKeep: HEAD_PITCH_KEEP, pitchTau: HEAD_PITCH_TAU,
                      compressEye: COMPRESS_EYE, compressNod: COMPRESS_NOD, compressMin: COMPRESS_MIN, compressMax: COMPRESS_MAX,
                      compressTau: COMPRESS_TAU };

  // ---- live mirrors -------------------------------------------------------------
  // Both glasses show one small render target, one half each, drawn by a rear-facing camera at each glass. The pass
  // runs inside the main render (the glass mesh's onBeforeRender, so only when a glass is on screen), one glass per
  // frame: each is redrawn every 2nd frame. Left out of it: the glass itself, our car's carbon and dark trim (only its
  // painted flank and sidepod show at the inner edge), objects (scene children and their children) whose name matches
  // MIRROR_SKIP (the scenery's trees: instanced over the whole map, about 90 % of its triangles) and anything with
  // userData.mirror === false (the cars' name tags). The track with its walls and terrain, the other cars, buildings,
  // stands and the sky are drawn. setMirrors(false) goes back to the environment-mapped glass.
  var MIRROR_W = 512, MIRROR_H = 96;   // the target: 256 x 96 per glass
  var MIRROR_HFOV = 40 * DEG;          // horizontal field of view of a glass (a slightly convex mirror)
  var MIRROR_PITCH = -3 * DEG;         // it looks back a little downwards
  var MIRROR_NEAR = 0.05, MIRROR_FAR = 600;
  var MIRROR_SKIP = /^scenery-trees/;

  // ---- car styles (CarSpec.cockpit) -------------------------------------------
  // nose: loft sections [z, crown y, half width, depth, squareness]; wing: elements [x0, x1, z of the leading edge,
  // y inner, y outer, chord, angle inner, angle outer] (angle > 0: trailing edge up), the first one is the carbon
  // main plane. Every nose ends at z = 2.80 and every wing at x = 0.95 (the grid boxes and laps-test/grid.js
  // assume that). The noses only fall away as far as the eye can still follow them from the seat.
  var NOSE = {
    modern: [[0.42, 0.62, 0.40, 0.42, 3.2], [0.80, 0.605, 0.365, 0.41, 3], [1.30, 0.585, 0.30, 0.38, 2.8], [1.75, 0.55, 0.22, 0.30, 2.6],
             [2.15, 0.515, 0.16, 0.22, 2.4], [2.50, 0.485, 0.115, 0.16, 2.3], [2.70, 0.467, 0.07, 0.11, 2.2], [2.80, 0.458, 0.03, 0.06, 2]],
    stepped: [[0.42, 0.62, 0.40, 0.42, 3.2], [0.80, 0.62, 0.37, 0.42, 3], [1.22, 0.615, 0.31, 0.40, 2.8], [1.32, 0.57, 0.27, 0.32, 2.6],
              [1.75, 0.55, 0.21, 0.28, 2.6], [2.15, 0.53, 0.16, 0.22, 2.4], [2.50, 0.51, 0.12, 0.17, 2.3], [2.70, 0.495, 0.08, 0.12, 2.2],
              [2.80, 0.487, 0.04, 0.06, 2]],
    halo: [[0.42, 0.62, 0.40, 0.42, 3.2], [0.80, 0.585, 0.36, 0.40, 3], [1.30, 0.54, 0.28, 0.35, 2.8], [1.75, 0.50, 0.19, 0.28, 2.6],
           [2.15, 0.465, 0.13, 0.20, 2.4], [2.50, 0.435, 0.09, 0.14, 2.3], [2.70, 0.417, 0.055, 0.09, 2.2], [2.80, 0.408, 0.02, 0.05, 2]],
    halo18: [[0.42, 0.62, 0.40, 0.42, 3.2], [0.80, 0.57, 0.37, 0.38, 3], [1.30, 0.505, 0.31, 0.33, 2.8], [1.75, 0.455, 0.25, 0.27, 2.6],
             [2.15, 0.415, 0.20, 0.21, 2.5], [2.50, 0.38, 0.16, 0.16, 2.4], [2.72, 0.352, 0.12, 0.11, 2.2], [2.80, 0.34, 0.07, 0.07, 2]]
  };
  var WING = {
    // 2010-2017: 1.8 m wide, main plane + two flaps + a cascade winglet, hung under the high nose on pylons
    modern: { half: 0.90, el: [[0.00, 0.90, 2.79, 0.085, 0.085, 0.28, 0.02, 0.02], [0.10, 0.89, 2.55, 0.13, 0.14, 0.17, 0.35, 0.40],
                               [0.10, 0.89, 2.42, 0.19, 0.20, 0.13, 0.55, 0.60], [0.62, 0.89, 2.62, 0.30, 0.31, 0.11, 0.30, 0.30]],
              plate: [[2.80, 0.03], [2.80, 0.24], [2.66, 0.31], [2.30, 0.31], [2.20, 0.25], [2.20, 0.03]], pylons: true },
    // 2018-2021: 2.0 m wide, five straight elements, tall flat endplates, pylons
    halo: { half: 0.945, el: [[0.00, 0.94, 2.79, 0.09, 0.09, 0.28, 0.00, 0.02], [0.12, 0.935, 2.54, 0.13, 0.13, 0.16, 0.30, 0.32],
                              [0.12, 0.935, 2.42, 0.18, 0.18, 0.13, 0.45, 0.48], [0.13, 0.935, 2.32, 0.23, 0.23, 0.11, 0.60, 0.62],
                              [0.14, 0.935, 2.24, 0.28, 0.28, 0.09, 0.75, 0.78]],
            plate: [[2.80, 0.03], [2.80, 0.27], [2.70, 0.33], [2.22, 0.33], [2.18, 0.26], [2.18, 0.03]], pylons: true },
    // 2022 on: simplified four-element wing whose flaps roll up into rounded endplates, fixed to the low nose
    halo18: { half: 0.945, el: [[0.00, 0.94, 2.79, 0.085, 0.10, 0.25, -0.06, 0.05], [0.13, 0.935, 2.58, 0.12, 0.19, 0.18, 0.25, 0.45],
                                [0.14, 0.935, 2.43, 0.17, 0.27, 0.14, 0.45, 0.70], [0.15, 0.935, 2.31, 0.22, 0.34, 0.11, 0.60, 0.85]],
              plate: [[2.80, 0.04], [2.80, 0.16], [2.70, 0.27], [2.52, 0.35], [2.30, 0.37], [2.18, 0.32], [2.18, 0.04]], pylons: false }
  };
  // wheels: outer radius, rim radius (13 in = 0.165 m, 18 in = 0.229 m), shoulder radius
  var WHEELS = { r13: { R: 0.330, rr: 0.165, sh: 0.050 }, r18: { R: 0.360, rr: 0.229, sh: 0.034 } };
  var DEFAULT_YEAR = { modern: 2013, halo: 2019, halo18: 2025 };
  // halo centre line: the +x half of the hoop from the rear foot forwards (the -x half is its mirror image), the apex on
  // the centre line, the top of the centre pillar. js/carmodel.js draws the other players' halo along the same line.
  var HALO = { hoop: [[0.44, 0.66, -1.02], [0.45, 0.80, -0.98], [0.48, 1.02, -0.55], [0.47, 1.18, -0.10], [0.38, 1.29, 0.30], [0.20, 1.325, 0.56], [0.08, 1.33, 0.625]],
               apex: [0, 1.332, 0.645], pillar: [0, 1.325, 0.64] };
  F1.COCKPIT_HALO = HALO;
  // drivetrain of the reference car (F1.REF_SPEC), used until a spec says otherwise
  var REF_DRIVE = { gearKmh: [60, 100, 140, 180, 220, 260, 300], topKmh: 345, rpmIdle: 4000, rpmShift: 11800, rpmMax: 12500 };
  var COMPOUND = { S: ['#e8202a', 'SOFT'], M: ['#ffd21e', 'MEDIUM'], H: ['#f0f0f0', 'HARD'], I: ['#35b44a', 'INTERMEDIATE'], W: ['#1e6fd9', 'WET'] };
  var DEFAULT_LIVERY = { colour: '#ff7a14', colour2: '#17181c', accent: '#19c8e6' };

  // ---- livery atlas: 1024 x 1024 canvas, regions in canvas pixels -----------------
  var ATLAS = 1024;
  var TOP_X = 0.95, TOP_Z0 = -2.0, TOP_Z1 = 3.0;     // top view: x +0.95 (left edge) .. -0.95, z 3.0 (top row) .. -2.0
  var SIDE_Z0 = -2.2, SIDE_Z1 = 3.0, SIDE_Y1 = 0.95; // side views: z along, y 0.95 (top row) .. 0
  var RG = { top: [0, 0, 1024, 512], sideL: [0, 512, 1024, 192], sideR: [0, 704, 1024, 192], wing: [0, 896, 1024, 64], sw: [0, 960, 1024, 64] };
  var SW = { c1: 0, c2: 1, acc: 2 };                  // solid swatches: colour, colour2, the player's accent

  // ---- colours ----
  function hexOf(c, dflt) {
    if (typeof c === 'number' && isFinite(c)) return '#' + ('000000' + (c & 0xffffff).toString(16)).slice(-6);
    if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    if (typeof c === 'string' && /^#[0-9a-fA-F]{3}$/.test(c)) return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
    return dflt;
  }
  function rgbOf(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function toHex(r, g, b) {
    function c(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }
    return '#' + c(r) + c(g) + c(b);
  }
  function shade(h, k) {           // k < 1: darker; k > 1: towards white
    var c = rgbOf(h);
    if (k <= 1) return toHex(c[0] * k, c[1] * k, c[2] * k);
    var t = Math.min(1, k - 1);
    return toHex(c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t);
  }
  function lum(h) { var c = rgbOf(h); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255; }
  function rgba(h, a) { var c = rgbOf(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  function makeCanvas(w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c.getContext && c.getContext('2d') ? c : null;
    } catch (e) { return null; }
  }

  // =====================================================================================================
  // geometry
  // =====================================================================================================

  // Collects triangles per material key and merges them into one non-indexed BufferGeometry each.
  // add(key, geo, matrix, o): o.uv = 'keep' (o.rect remaps the geometry's own uv into an atlas rectangle
  // [u0, v0, u1, v1]), 'box' (planar by the dominant axis, o.tile metres per repeat), 'livery' (top / side views of
  // the atlas), 'swatch' (o.sw: a solid cell of the atlas); o.col = vertex colour; o.ao(x, y, z, nx, ny, nz) -> 0..1.
  function Builder(THREE) { this.T = THREE; this.sets = {}; }
  Builder.prototype.add = function (key, geo, m, o) {
    var THREE = this.T, S = this.sets[key] || (this.sets[key] = { p: [], n: [], u: [], c: [] });
    o = o || {};
    if (!geo.attributes.normal) geo.computeVertexNormals();
    var g = geo.index ? geo.toNonIndexed() : geo;
    if (m) g.applyMatrix4(m);
    var flip = !!(m && m.determinant() < 0);          // a mirror flips the winding: put it back
    var P = g.attributes.position.array, N = g.attributes.normal.array, U = g.attributes.uv ? g.attributes.uv.array : null;
    var col = new THREE.Color(o.col != null ? o.col : 0xffffff), ao = o.ao || aoDefault, mode = o.uv || 'box';
    var tile = o.tile || 0.06, rect = o.rect, swu = 0, swv = 0;
    if (mode === 'swatch') { var sc = swatchUV(o.sw || 0); swu = sc[0]; swv = sc[1]; }
    var order = flip ? [0, 2, 1] : [0, 1, 2];
    for (var t = 0; t + 8 < P.length; t += 9) {
      var fnx = N[t] + N[t + 3] + N[t + 6], fny = N[t + 1] + N[t + 4] + N[t + 7], fnz = N[t + 2] + N[t + 5] + N[t + 8];
      var ax = Math.abs(fnx), ay = Math.abs(fny), az = Math.abs(fnz), fl = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      var cx = (P[t] + P[t + 3] + P[t + 6]) / 3;
      for (var q = 0; q < 3; q++) {
        var k = order[q], i = t + k * 3, x = P[i], y = P[i + 1], z = P[i + 2], u = 0, v = 0, uv;
        if (mode === 'keep') {
          var j = (t / 3 + k) * 2;
          u = U ? U[j] : 0; v = U ? U[j + 1] : 0;
          if (rect) { u = rect[0] + u * (rect[2] - rect[0]); v = rect[1] + v * (rect[3] - rect[1]); }
        } else if (mode === 'swatch') { u = swu; v = swv; }
        else if (mode === 'livery') {
          uv = ay / fl > 0.5 ? topUV(x, z) : sideUV(Math.abs(cx) > 0.02 ? cx : fnx, z, y);
          u = uv[0]; v = uv[1];
        } else {
          if (ax >= ay && ax >= az) { u = z / tile; v = y / tile; }
          else if (ay >= az) { u = x / tile; v = z / tile; }
          else { u = x / tile; v = y / tile; }
        }
        S.p.push(x, y, z);
        S.n.push(N[i], N[i + 1], N[i + 2]);
        S.u.push(u, v);
        var a = ao(x, y, z, N[i], N[i + 1], N[i + 2]);
        S.c.push(col.r * a, col.g * a, col.b * a);
      }
    }
    if (g !== geo) g.dispose();
    geo.dispose();
  };
  Builder.prototype.build = function (key) {
    var S = this.sets[key], THREE = this.T;
    if (!S || !S.p.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(S.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(S.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(S.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(S.c, 3));
    g.computeBoundingSphere();
    return g;
  };

  function topUV(x, z) {
    var px = (TOP_X - x) / (2 * TOP_X) * RG.top[2], py = (TOP_Z1 - z) / (TOP_Z1 - TOP_Z0) * RG.top[3];
    return [px / ATLAS, 1 - (RG.top[1] + Math.max(0, Math.min(RG.top[3], py))) / ATLAS];
  }
  // side: sign of the face normal / position (> 0: the left side, seen from the left)
  function sideUV(side, z, y) {
    var r = side > 0 ? RG.sideL : RG.sideR, f = (z - SIDE_Z0) / (SIDE_Z1 - SIDE_Z0);
    var px = (side > 0 ? 1 - f : f) * r[2], py = Math.max(0, Math.min(1, (SIDE_Y1 - y) / SIDE_Y1)) * r[3];
    return [px / ATLAS, 1 - (r[1] + py) / ATLAS];
  }
  function swatchUV(i) { return [(i * 64 + 32) / ATLAS, 1 - (RG.sw[1] + 32) / ATLAS]; }
  function rectUV(r) { return [r[0] / ATLAS, 1 - (r[1] + r[3]) / ATLAS, (r[0] + r[2]) / ATLAS, 1 - r[1] / ATLAS]; }

  // ambient occlusion baked into the vertex colours: faces turned to the ground and parts close to it are darker
  function aoDefault(x, y, z, nx, ny) {
    var a = 1;
    if (ny < -0.25) a *= 0.70;
    if (y < 0.22) a *= 0.62 + 0.38 * Math.max(0, y) / 0.22;
    return a;
  }
  function aoNone() { return 1; }

  // Loft of superellipse arches (bottom of one side, over the crown, down the other side).
  // sections [{z, x, top, hw, h, n}]; uv: u along the arch, v along the sections. cap: close the last section.
  // th0 / th1: part of the arch (0 = bottom of the +x side, 1 = bottom of the -x side), default all of it.
  function archLoft(THREE, S, M, cap, th0, th1) {
    var pos = [], uv = [], idx = [], i, j, s;
    th0 = th0 == null ? 0 : th0; th1 = th1 == null ? 1 : th1;
    for (i = 0; i < S.length; i++) {
      s = S[i];
      var e = 2 / s.n;
      for (j = 0; j <= M; j++) {
        var th = Math.PI * (th0 + (th1 - th0) * j / M), c = Math.cos(th), sn = Math.max(0, Math.sin(th));
        pos.push((s.x || 0) + s.hw * (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), e), s.top - s.h + s.h * Math.pow(sn, e), s.z);
        uv.push(j / M, i / (S.length - 1));
      }
    }
    // winding (and so the computed normals) outwards whichever way the sections run along z
    var fw = S[S.length - 1].z > S[0].z;
    for (i = 0; i + 1 < S.length; i++) {
      for (j = 0; j < M; j++) {
        var a = i * (M + 1) + j, b = a + M + 1;
        if (fw) idx.push(a, a + 1, b, a + 1, b + 1, b);
        else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    if (cap) {
      s = S[S.length - 1];
      var c0 = pos.length / 3, base = (S.length - 1) * (M + 1);
      pos.push(s.x || 0, s.top - s.h * 0.45, s.z + (cap > 0 ? cap : 0));
      uv.push(0.5, 1);
      for (j = 0; j < M; j++) { if (fw) idx.push(base + j, base + j + 1, c0); else idx.push(base + j, c0, base + j + 1); }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // the arch of one section as points (k: scale towards the section's centre line, for lips / openings)
  function archPoints(s, M, k) {
    var out = [], e = 2 / s.n;
    for (var j = 0; j <= M; j++) {
      var th = Math.PI * j / M, c = Math.cos(th), sn = Math.max(0, Math.sin(th));
      out.push([(s.x || 0) + k * s.hw * (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), e), s.top - s.h + k * s.h * Math.pow(sn, e) + (1 - k) * 0.02, s.z]);
    }
    return out;
  }
  function sections(list, xOff) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ z: list[i][0], top: list[i][1], hw: list[i][2], h: list[i][3], n: list[i][4], x: xOff || 0 });
    return out;
  }
  // the nose / chassis at z (linear between sections): {top, hw, yb}
  function noseAt(list, z) {
    for (var i = 0; i + 1 < list.length; i++) {
      var a = list[i], b = list[i + 1];
      if (z <= b[0] || i + 2 === list.length) {
        var t = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
        return { top: a[1] + (b[1] - a[1]) * t, hw: a[2] + (b[2] - a[2]) * t, yb: a[1] - a[3] + ((b[1] - b[3]) - (a[1] - a[3])) * t };
      }
    }
    return { top: list[0][1], hw: list[0][2], yb: list[0][1] - list[0][3] };
  }

  // A wing element: closed cambered aerofoil section lofted along x. st: [{x, zle, yle, c, a}] (a > 0: trailing
  // edge up); inverted camber (downforce). uv: u = along the span, v = around the section (upper surface first).
  var FOIL = (function () {
    var K = 8, pts = [], k, x, t;
    function thick(x) { return 0.45 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x); }
    function camber(x) { return -0.045 * Math.sin(Math.PI * x) * (1 - 0.3 * x); }
    for (k = 0; k <= K; k++) { t = 1 - k / K; x = (1 - Math.cos(t * Math.PI)) / 2; pts.push([x, camber(x) + thick(x) * 0.5]); }
    for (k = 1; k < K; k++) { t = k / K; x = (1 - Math.cos(t * Math.PI)) / 2; pts.push([x, camber(x) - thick(x) * 0.5]); }
    return pts;
  })();
  function foilLoft(THREE, st, capIn) {
    var pos = [], uv = [], idx = [], L = FOIL.length, i, k;
    for (i = 0; i < st.length; i++) {
      var s = st[i], ca = Math.cos(s.a), sa = Math.sin(s.a);
      for (k = 0; k <= L; k++) {
        var p = FOIL[k % L], px = p[0] * s.c, py = p[1] * s.c;
        pos.push(s.x, s.yle + sa * px + ca * py, s.zle - ca * px + sa * py);
        uv.push(i / (st.length - 1), k / L);
      }
    }
    for (i = 0; i + 1 < st.length; i++) {
      for (k = 0; k < L; k++) {
        var a = i * (L + 1) + k, b = a + L + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    if (capIn) for (k = 1; k + 1 < L; k++) idx.push(0, k + 1, k);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Sweep of an elliptical section along a polyline (halo, pillars): pts [[x, y, z]], w / h: section size per point
  // (w across, in the horizontal plane; h the other way).
  function sweep(THREE, pts, w, h, seg, capEnds) {
    var pos = [], uv = [], idx = [], n = pts.length, i, j;
    var UP = new THREE.Vector3(0, 1, 0), T = new THREE.Vector3(), W = new THREE.Vector3(), H = new THREE.Vector3();
    for (i = 0; i < n; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      T.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      W.crossVectors(T, UP);
      if (W.lengthSq() < 1e-6) W.set(1, 0, 0);
      W.normalize();
      H.crossVectors(W, T).normalize();
      var ww = (typeof w === 'number' ? w : w[i]) / 2, hh = (typeof h === 'number' ? h : h[i]) / 2;
      for (j = 0; j <= seg; j++) {
        var ph = 2 * Math.PI * j / seg, c = Math.cos(ph) * ww, s = Math.sin(ph) * hh;
        pos.push(pts[i][0] + W.x * c + H.x * s, pts[i][1] + W.y * c + H.y * s, pts[i][2] + W.z * c + H.z * s);
        uv.push(j / seg, i / (n - 1));
      }
    }
    for (i = 0; i + 1 < n; i++) {
      for (j = 0; j < seg; j++) {
        var p = i * (seg + 1) + j, q = p + seg + 1;
        idx.push(p, q, p + 1, p + 1, q, q + 1);
      }
    }
    if (capEnds) {
      for (var e = 0; e < 2; e++) {
        var base = e ? (n - 1) * (seg + 1) : 0, c0 = pos.length / 3, P = pts[e ? n - 1 : 0];
        pos.push(P[0], P[1], P[2]); uv.push(0.5, e);
        for (j = 0; j < seg; j++) idx.push(base + j, c0, base + j + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // strut between two points with an elliptical section, the wide axis kept horizontal (wishbones)
  function strutMatrix(THREE, a, b, w, t) {
    var A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
    var Y = B.clone().sub(A), len = Y.length();
    Y.normalize();
    var X = new THREE.Vector3().crossVectors(Y, new THREE.Vector3(0, 1, 0));
    if (X.lengthSq() < 1e-6) X.set(1, 0, 0);
    X.normalize();
    var Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    var m = new THREE.Matrix4().makeBasis(X.multiplyScalar(w / 2), Y.multiplyScalar(len), Z.multiplyScalar(t / 2));
    m.setPosition(A.add(B).multiplyScalar(0.5));
    return m;
  }
  function strut(THREE, bld, key, a, b, w, t, o) {
    bld.add(key, new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), strutMatrix(THREE, a, b, w, t), o);
  }

  // rounded rectangle shape (centre x, y)
  function rrect(THREE, w, h, r, cx, cy) {
    var s = new THREE.Shape(), x0 = (cx || 0) - w / 2, y0 = (cy || 0) - h / 2, x1 = x0 + w, y1 = y0 + h;
    r = Math.min(r, w / 2, h / 2);
    s.moveTo(x0 + r, y0); s.lineTo(x1 - r, y0); s.quadraticCurveTo(x1, y0, x1, y0 + r);
    s.lineTo(x1, y1 - r); s.quadraticCurveTo(x1, y1, x1 - r, y1); s.lineTo(x0 + r, y1);
    s.quadraticCurveTo(x0, y1, x0, y1 - r); s.lineTo(x0, y0 + r); s.quadraticCurveTo(x0, y0, x0 + r, y0);
    return s;
  }
  // rounded box: w x h (x, y), depth d along z, centred on the origin
  function rbox(THREE, w, h, d, r, bev) {
    bev = bev == null ? Math.min(r, d / 3) : bev;
    var g = new THREE.ExtrudeGeometry(rrect(THREE, w - 2 * bev, h - 2 * bev, Math.max(0.001, r - bev)),
      { depth: Math.max(0.0005, d - 2 * bev), bevelEnabled: bev > 0, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 4 });
    g.translate(0, 0, -(d - 2 * bev) / 2);
    return g;
  }
  function at(THREE, x, y, z, rx, ry, rz, sx, sy, sz) {
    var m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, 'YXZ'));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz));
    return m;
  }
  var MIRROR_X = null;
  function mirrorX(THREE, m) {
    if (!MIRROR_X) MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
    return new THREE.Matrix4().multiplyMatrices(MIRROR_X, m || new THREE.Matrix4());
  }

  // tyre profile for a lathe (r, axial a): inner sidewall (a < 0, towards the car), rounded shoulder, tread,
  // shoulder, outer sidewall. vs: texture v of each point (sidewall 0..0.42 from the rim, tread 0.45..0.55, outer 0.58..1).
  function tyreProfile(THREE, R, W, rr, sh) {
    var pts = [], vs = [], hw = W / 2, bul = 0.010, k, t, g;
    var side = R - sh - rr;
    for (k = 0; k <= 6; k++) { t = k / 6; pts.push([rr + side * t, -hw - bul * Math.sin(Math.PI * t)]); vs.push(0.42 * t); }
    for (k = 1; k <= 4; k++) { g = Math.PI / 2 * k / 4; pts.push([R - sh + sh * Math.sin(g), -hw + sh - sh * Math.cos(g)]); vs.push(0.42 + 0.03 * k / 4); }
    for (k = 1; k <= 3; k++) { t = k / 4; pts.push([R + 0.003 * Math.sin(Math.PI * t), -hw + sh + (W - 2 * sh) * t]); vs.push(0.45 + 0.10 * t); }
    for (k = 0; k <= 4; k++) { g = Math.PI / 2 * (1 - k / 4); pts.push([R - sh + sh * Math.sin(g), hw - sh + sh * Math.cos(g)]); vs.push(0.55 + 0.03 * k / 4); }
    for (k = 1; k <= 6; k++) { t = 1 - k / 6; pts.push([rr + side * t, hw + bul * Math.sin(Math.PI * t)]); vs.push(1 - 0.42 * t); }
    var v2 = [];
    for (k = 0; k < pts.length; k++) v2.push(new THREE.Vector2(pts[k][0], pts[k][1]));
    return { pts: v2, vs: vs };
  }
  // lathe around the X axis (the wheel axle); vs overrides the texture v per profile point
  function latheX(THREE, pts, seg, vs) {
    var g = new THREE.LatheGeometry(pts, seg);
    if (vs) {
      var uv = g.attributes.uv, n = pts.length;
      for (var i = 0; i < uv.count; i++) uv.setY(i, vs[i % n]);
    }
    g.rotateZ(-Math.PI / 2);
    return g;
  }

  // =====================================================================================================
  // textures
  // =====================================================================================================

  function carbonCanvas() {
    var c = makeCanvas(256, 256);
    if (!c) return null;
    var g = c.getContext('2d'), n = 16, s = 256 / n, i, j;
    g.fillStyle = '#16171a'; g.fillRect(0, 0, 256, 256);
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        var hor = ((i + j) % 4) < 2, x = i * s, y = j * s;
        var gr = hor ? g.createLinearGradient(0, y, 0, y + s) : g.createLinearGradient(x, 0, x + s, 0);
        var hi = hor ? '#33363c' : '#26282d';
        gr.addColorStop(0, '#16171a'); gr.addColorStop(0.5, hi); gr.addColorStop(1, '#16171a');
        g.fillStyle = gr; g.fillRect(x + 0.5, y + 0.5, s - 1, s - 1);
        g.fillStyle = hor ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.10)';
        for (var k = 1; k < 4; k++) {
          if (hor) g.fillRect(x, y + k * s / 4, s, 0.6); else g.fillRect(x + k * s / 4, y, 0.6, s);
        }
      }
    }
    return c;
  }

  // Tyre band texture (1024 x 128, u around the tyre, v across the profile as tyreProfile's vs): lettering, the
  // compound band on both sidewalls, the tread. blurred: the lettering smeared into a ring (spinning wheel).
  function drawTyre(c, compound, blurred) {
    var g = c.getContext('2d'), W = c.width, H = c.height, comp = COMPOUND[compound] || COMPOUND.M;
    function row(v) { return (1 - v) * H; }
    g.fillStyle = '#141416'; g.fillRect(0, 0, W, H);
    // tread: clean dark rubber, the shoulders a touch lighter (vertex colours darken it with wear)
    var tg = g.createLinearGradient(0, row(0.58), 0, row(0.42));
    tg.addColorStop(0, '#19191b'); tg.addColorStop(0.2, '#1f1f22'); tg.addColorStop(0.5, '#1b1b1d'); tg.addColorStop(0.8, '#1f1f22'); tg.addColorStop(1, '#19191b');
    g.fillStyle = tg; g.fillRect(0, row(0.58), W, row(0.42) - row(0.58));
    for (var i = 0; i < 900; i++) {                  // fine grain
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
      g.fillRect((i * 97.13) % W, row(0.45) + ((i * 13.7) % 1) * (row(0.55) - row(0.45)) + (i % 7) * 1.3, 3, 1);
    }
    // sidewalls: f = 0 at the rim .. 1 at the shoulder
    for (var side = 0; side < 2; side++) {
      var vr = function (f) { return side ? 1 - 0.42 * f : 0.42 * f; };
      var sg = g.createLinearGradient(0, row(vr(0)), 0, row(vr(1)));
      sg.addColorStop(0, '#0f0f11'); sg.addColorStop(0.7, '#161618'); sg.addColorStop(1, '#1c1c1f');
      g.fillStyle = sg; g.fillRect(0, Math.min(row(vr(0)), row(vr(1))), W, Math.abs(row(vr(1)) - row(vr(0))));
      // compound band
      var b0 = row(vr(0.66)), b1 = row(vr(0.80));
      g.fillStyle = comp[0]; g.fillRect(0, Math.min(b0, b1), W, Math.abs(b1 - b0));
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, Math.min(b0, b1), W, 1); g.fillRect(0, Math.max(b0, b1) - 1, W, 1);
      // lettering between the rim and the band, letters upright = pointing away from the axle
      var y0 = row(vr(0.14)), y1 = row(vr(0.58)), th = Math.abs(y1 - y0);
      if (blurred) {
        g.fillStyle = 'rgba(210,210,210,0.13)'; g.fillRect(0, Math.min(y0, y1) + th * 0.18, W, th * 0.64);
        continue;
      }
      g.save();
      g.textBaseline = 'middle'; g.textAlign = 'center';
      var words = [['APEX', 1.0, '#ececec'], [comp[1], 0.62, '#e2e2e2'], ['APEX', 1.0, '#ececec'], [comp[1], 0.62, '#e2e2e2']];
      for (var w = 0; w < 4; w++) {
        var cx = W * (w + 0.5) / 4, cy = (y0 + y1) / 2;
        g.save();
        g.translate(cx, cy);
        if (side === 0) g.scale(1, -1);                // inner sidewall: v runs the other way
        g.font = 'italic 900 ' + Math.round(th * 0.82 * words[w][1]) + 'px Arial, Helvetica, sans-serif';
        g.fillStyle = words[w][2];
        g.fillText(words[w][0], 0, 1, W / 4 - 30);
        g.restore();
      }
      g.restore();
    }
  }

  // small equirectangular environment for the reflections: sky, a bright sun patch where main.js puts the sun,
  // a horizon of stands and trees, grey ground. Only the car's materials use it.
  function envCanvas() {
    var c = makeCanvas(256, 128);
    if (!c) return null;
    var g = c.getContext('2d'), W = 256, H = 128, i;
    var sky = g.createLinearGradient(0, 0, 0, H / 2);
    sky.addColorStop(0, '#3f6fb8'); sky.addColorStop(0.6, '#8fb4e0'); sky.addColorStop(1, '#dfe9f3');
    g.fillStyle = sky; g.fillRect(0, 0, W, H / 2);
    // sun: direction (300, 600, 200) -> azimuth atan2(z, x) = 34 deg, elevation 59 deg
    var sx = (0.5 + 34 / 360) * W, sy = (0.5 - 59 / 180) * H;
    var sun = g.createRadialGradient(sx, sy, 1, sx, sy, 30);
    sun.addColorStop(0, 'rgba(255,255,250,1)'); sun.addColorStop(0.25, 'rgba(255,250,235,0.7)'); sun.addColorStop(1, 'rgba(255,250,235,0)');
    g.fillStyle = sun; g.fillRect(0, 0, W, H / 2);
    // cloud streaks
    g.fillStyle = 'rgba(255,255,255,0.25)';
    for (i = 0; i < 14; i++) g.fillRect((i * 67) % W, 18 + (i * 29) % 34, 24 + (i * 13) % 30, 2 + i % 3);
    // ground
    var gr = g.createLinearGradient(0, H / 2, 0, H);
    gr.addColorStop(0, '#8a8f93'); gr.addColorStop(0.15, '#5c6064'); gr.addColorStop(1, '#2e3033');
    g.fillStyle = gr; g.fillRect(0, H / 2, W, H / 2);
    // horizon: stands, trees, buildings
    for (i = 0; i < 40; i++) {
      var x = (i * 53.7) % W, w = 6 + (i * 17) % 18, h = 2 + (i * 7) % 9;
      g.fillStyle = i % 3 ? '#44573f' : '#5d646c';
      g.fillRect(x, H / 2 - h, w, h);
    }
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, H / 2, W, 1);
    return c;
  }

  // soft contact shadow blob: black, faded out by the canvas alpha
  function shadowCanvas() {
    var c = makeCanvas(64, 64);
    if (!c) return null;
    var g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    r.addColorStop(0, 'rgba(0,0,0,0.85)'); r.addColorStop(0.55, 'rgba(0,0,0,0.45)'); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    return c;
  }

  // ---- the livery atlas ----
  // L: {c1, c2, acc: '#rrggbb', num: car number text, nose: key of NOSE (where the spine and flanks run)}
  function drawLivery(c, L) {
    var g = c.getContext('2d'), c1 = L.c1, c2 = L.c2, acc = L.acc, i;
    var ink = lum(c1) > 0.55 ? '#15161a' : '#f4f4f4';       // text on the base colour
    var ink2 = lum(c2) > 0.55 ? '#15161a' : '#f4f4f4';
    g.save();
    g.fillStyle = c1; g.fillRect(0, 0, ATLAS, ATLAS);
    function T(x, z) { return [(TOP_X - x) / (2 * TOP_X) * RG.top[2], (TOP_Z1 - z) / (TOP_Z1 - TOP_Z0) * RG.top[3]]; }
    function S(side, z, y) {
      var r = side > 0 ? RG.sideL : RG.sideR, f = (z - SIDE_Z0) / (SIDE_Z1 - SIDE_Z0);
      return [(side > 0 ? 1 - f : f) * r[2], r[1] + (SIDE_Y1 - y) / SIDE_Y1 * r[3]];
    }
    function poly(pts, fill) {
      g.beginPath();
      for (var k = 0; k < pts.length; k++) { if (k) g.lineTo(pts[k][0], pts[k][1]); else g.moveTo(pts[k][0], pts[k][1]); }
      g.closePath(); g.fillStyle = fill; g.fill();
    }
    function text(s, x, y, rot, px, fill, maxW, font) {
      g.save(); g.translate(x, y); g.rotate(rot || 0);
      g.font = (font || 'italic 900 ') + px + 'px Arial, Helvetica, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = fill;
      g.fillText(s, 0, 0, maxW || 1000);
      g.restore();
    }
    var nose = NOSE[L.nose] || NOSE.halo18;

    // ---------- top view ----------
    g.save();
    g.beginPath(); g.rect(RG.top[0], RG.top[1], RG.top[2], RG.top[3]); g.clip();
    // spine in colour2 from the cockpit to the tip, pinstriped in the accent colour
    var L1 = [], R1 = [], z, w;
    for (z = 0.40; z <= 2.86; z += 0.1) {
      var ns = noseAt(nose, z);
      w = Math.min(ns.hw * 0.32, 0.035 + 0.05 * Math.max(0, (2.8 - z) / 2.4));
      L1.push(T(w, z)); R1.push(T(-w, z));
    }
    poly(L1.concat(R1.reverse()), c2);
    g.strokeStyle = acc; g.lineWidth = 3;
    g.beginPath(); for (i = 0; i < L1.length; i++) { if (i) g.lineTo(L1[i][0], L1[i][1]); else g.moveTo(L1[i][0], L1[i][1]); } g.stroke();
    g.beginPath(); for (i = 0; i < R1.length; i++) { if (i) g.lineTo(R1[i][0], R1[i][1]); else g.moveTo(R1[i][0], R1[i][1]); } g.stroke();
    // colour2 flanks along the chassis sides and the sidepod tops
    for (var sd = -1; sd <= 1; sd += 2) {
      var fl = [];
      for (z = 0.42; z <= 1.9; z += 0.1) { ns = noseAt(nose, z); fl.push(T(sd * ns.hw * 1.02, z)); }
      for (z = 1.9; z >= 0.42; z -= 0.1) { ns = noseAt(nose, z); fl.push(T(sd * (ns.hw * 0.80 - 0.02 * (1.9 - z)), z)); }
      poly(fl, c2);
      // sidepod top: a colour2 sweep from the inlet lip back along the inner edge, pinstriped
      poly([T(sd * 0.42, 0.34), T(sd * 0.58, 0.34), T(sd * 0.50, -0.40), T(sd * 0.47, -1.40), T(sd * 0.42, -1.40)], c2);
      poly([T(sd * 0.58, 0.34), T(sd * 0.595, 0.34), T(sd * 0.515, -0.40), T(sd * 0.485, -1.40), T(sd * 0.47, -1.40), T(sd * 0.50, -0.40)], acc);
    }
    // sponsor along the nose (reads along the car), number on the tip (reads from the front, as on the real cars)
    var pn = T(0, 1.95);
    text('KRONOS', pn[0], pn[1], -Math.PI / 2, 24, ink2, 120);
    var num = String(L.num);
    var pt = T(0, 2.40);
    g.save(); g.translate(pt[0], pt[1]); g.scale(1.25, 0.8);
    text(num, 0, 0, Math.PI, 60, '#ffffff', 110, '900 ');
    g.restore();
    // logo ahead of the driver, tone on tone (reads from the front, as on the real cars)
    var ph = T(0, 0.64);
    text('HALCYON', ph[0], ph[1], Math.PI, 16, lum(c1) > 0.5 ? rgba('#000000', 0.30) : rgba('#ffffff', 0.35), 120);
    // panel line at the nose joint + fasteners, cockpit-edge shadow (baked AO)
    var j0 = T(0.5, 1.30), j1 = T(-0.5, 1.30);
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(j0[0], j0[1] - 1, j1[0] - j0[0], 2);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (i = -4; i <= 4; i++) { var fp = T(i * 0.06, 1.34); g.beginPath(); g.arc(fp[0], fp[1], 1.6, 0, 2 * Math.PI); g.fill(); }
    var e0 = T(0, 0.42), e1 = T(0, 0.70), sh = g.createLinearGradient(0, e0[1], 0, e1[1]);
    sh.addColorStop(0, 'rgba(0,0,0,0.42)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh; g.fillRect(0, e1[1], ATLAS, e0[1] - e1[1] + 4);
    // sidepod / chassis junction and the cockpit rim shadow
    for (sd = -1; sd <= 1; sd += 2) {
      var a0 = T(sd * 0.40, 0.3), a1 = T(sd * 0.50, 0.3), jg = g.createLinearGradient(a0[0], 0, a1[0], 0);
      jg.addColorStop(0, 'rgba(0,0,0,0.35)'); jg.addColorStop(1, 'rgba(0,0,0,0)');
      var b0 = T(sd * 0.40, 0.42), b1 = T(sd * 0.50, -2.0);
      g.fillStyle = jg; g.fillRect(Math.min(b0[0], b1[0]), b0[1], Math.abs(b1[0] - b0[0]), b1[1] - b0[1]);
    }
    g.restore();

    // ---------- side views ----------
    for (sd = -1; sd <= 1; sd += 2) {
      var r = sd > 0 ? RG.sideL : RG.sideR;
      g.save();
      g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip();
      // lower band and floor edge in colour2, accent pinstripe
      poly([S(sd, 3.0, 0.24), S(sd, 1.2, 0.30), S(sd, 0.3, 0.30), S(sd, -2.2, 0.26), S(sd, -2.2, 0), S(sd, 3.0, 0)], c2);
      poly([S(sd, 3.0, 0.24), S(sd, 1.2, 0.30), S(sd, 0.3, 0.30), S(sd, -2.2, 0.26), S(sd, -2.2, 0.245), S(sd, 0.3, 0.285), S(sd, 1.2, 0.285), S(sd, 3.0, 0.225)], acc);
      // colour2 flash along the cockpit side up to the rim
      poly([S(sd, 0.45, 0.66), S(sd, 0.10, 0.66), S(sd, -0.55, 0.58), S(sd, -0.20, 0.50), S(sd, 0.45, 0.52)], c2);
      // sponsor block on the cockpit side and on the sidepod, number
      var q = S(sd, -0.02, 0.44);
      g.fillStyle = '#f2f2f2'; g.fillRect(q[0] - 78, q[1] - 17, 156, 34);
      text('HALCYON', q[0], q[1] + 1, 0, 26, '#0d7a4a', 146);
      q = S(sd, -0.95, 0.40);
      text('NORDSEE OIL', q[0], q[1], 0, 30, ink, 230);
      q = S(sd, 0.95, 0.50);
      text(num, q[0], q[1], 0, 34, ink, 80, '900 ');
      // endplates (z 2.18 .. 2.80)
      poly([S(sd, 2.80, 0.40), S(sd, 2.18, 0.40), S(sd, 2.18, 0.0), S(sd, 2.80, 0.0)], c2);
      q = S(sd, 2.49, 0.18);
      text('VELOCITA', q[0], q[1], 0, 22, acc, 110);
      // contact shadow towards the ground
      var y0 = S(sd, 0, 0.30), y1 = S(sd, 0, 0.0), sg = g.createLinearGradient(0, y0[1], 0, y1[1]);
      sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,0.45)');
      g.fillStyle = sg; g.fillRect(r[0], y0[1], r[2], y1[1] - y0[1]);
      g.restore();
    }

    // ---------- wing flaps: 3 bands (elements 1..3), u inner -> outer, v around the section ----------
    var wr = RG.wing, bh = wr[3] / 4;
    for (i = 0; i < 4; i++) {
      var y = wr[1] + i * bh;
      g.fillStyle = i === 0 ? c2 : c1; g.fillRect(wr[0], y, wr[2], bh);
      g.fillStyle = i === 1 ? acc : c2; g.fillRect(wr[0] + wr[2] * 0.80, y, wr[2] * 0.20, bh);   // outer ends
      g.fillStyle = shade(i === 0 ? c2 : c1, 0.55); g.fillRect(wr[0], y, wr[2] * 0.06, bh);        // inner ends (in the nose's shade)
    }

    // ---------- swatches ----------
    var sw = [c1, c2, acc];
    for (i = 0; i < sw.length; i++) { g.fillStyle = sw[i]; g.fillRect(i * 64, RG.sw[1], 64, 64); }
    g.restore();
  }

  // ---- the live steering-wheel display (256 x 160: LED strip on top, screen below) ----
  function drawDisplay(c, d, classic) {
    var g = c.getContext('2d'), i;
    g.fillStyle = '#050608'; g.fillRect(0, 0, 256, 160);
    // shift lights: 15 LEDs, green / red / blue; all flash at the shift point; the pit limiter blinks them
    for (i = 0; i < 15; i++) {
      var x = 13 + i * 16.4, on = i < d.leds, col = i < 5 ? '#27ff4d' : (i < 10 ? '#ff2530' : '#3d7dff');
      if (d.shift) { on = d.flash; col = '#3d7dff'; }
      if (d.limiter) { on = (i % 2 === 0) === d.flash; col = i % 2 ? '#ffcc22' : '#3d7dff'; }
      g.beginPath(); g.arc(x, 16, 6.2, 0, 2 * Math.PI);
      g.fillStyle = on ? col : '#1b1d22'; g.fill();
      if (on) { g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(x - 1.5, 14.5, 2.2, 0, 2 * Math.PI); g.fill(); }
    }
    g.fillStyle = '#000'; g.fillRect(0, 31, 256, 2);
    g.save(); g.translate(0, 32);                       // screen: 256 x 128
    var fg = classic ? '#ffb030' : '#ffffff', dim = classic ? '#8a5a18' : '#8c96a8';
    g.fillStyle = classic ? '#0c0904' : '#07090d'; g.fillRect(0, 0, 256, 128);
    if (!classic) {
      g.fillStyle = '#12161e'; g.fillRect(4, 4, 70, 120); g.fillRect(182, 4, 70, 120);
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // gear, big in the middle
    g.font = '900 ' + (classic ? 92 : 100) + 'px Arial, Helvetica, sans-serif';
    g.fillStyle = d.shift && d.flash ? '#3d7dff' : fg;
    g.fillText(d.gear, 128, 66);
    // speed
    g.font = '700 30px Arial, Helvetica, sans-serif'; g.fillStyle = fg;
    g.fillText(String(d.kmh), 39, 36);
    g.font = '700 11px Arial, Helvetica, sans-serif'; g.fillStyle = dim;
    g.fillText('KM/H', 39, 58);
    // lap time / delta
    if (d.lap) {
      g.font = '700 ' + (d.lap.length > 6 ? 15 : 20) + 'px Arial, Helvetica, sans-serif'; g.fillStyle = d.lapCol || fg;
      g.fillText(d.lap, 39, 84);
      g.font = '700 10px Arial, Helvetica, sans-serif'; g.fillStyle = dim;
      g.fillText(d.lapLabel || '', 39, 102);
    }
    // tyre compound
    if (d.comp) {
      var cc = COMPOUND[d.comp] || COMPOUND.M;
      g.beginPath(); g.arc(22, 114, 9, 0, 2 * Math.PI); g.lineWidth = 3; g.strokeStyle = cc[0]; g.stroke();
      g.font = '700 11px Arial, Helvetica, sans-serif'; g.fillStyle = fg; g.fillText(d.comp, 22, 115);
    }
    // battery: vertical bar, yellow while deploying, green while harvesting
    if (d.battery >= 0) {
      g.fillStyle = '#1e232c'; g.fillRect(203, 18, 28, 88);
      var hbar = Math.round(84 * d.battery);
      g.fillStyle = d.deploy ? '#ffd21e' : (d.harvest ? '#35e06a' : (classic ? '#ffb030' : '#34c6ff'));
      g.fillRect(205, 104 - hbar, 24, hbar);
      g.font = '700 11px Arial, Helvetica, sans-serif'; g.fillStyle = dim; g.fillText('ERS', 217, 11);
      g.font = '700 14px Arial, Helvetica, sans-serif'; g.fillStyle = fg; g.fillText(Math.round(d.battery * 100) + '%', 217, 118);
    } else {
      g.font = '700 12px Arial, Helvetica, sans-serif'; g.fillStyle = dim; g.fillText(classic ? 'KERS' : 'ERS', 217, 60);
      g.fillText('--', 217, 78);
    }
    // pit limiter
    if (d.limiter) {
      g.fillStyle = d.flash ? '#1f5bff' : '#0b2a8a'; g.fillRect(64, 100, 128, 26);
      g.font = '900 20px Arial, Helvetica, sans-serif'; g.fillStyle = '#ffffff'; g.fillText('PIT LIMIT', 128, 114);
    }
    g.restore();
  }

  // =====================================================================================================
  // the cockpit
  // =====================================================================================================

  F1.createCockpit = function (camera) {
    var THREE = root.THREE;
    var group = new THREE.Group();
    group.name = 'cockpit';
    group.rotation.order = 'YXZ';
    var DS = THREE.DoubleSide, tmpN = new THREE.Vector3();

    // ---- textures (kept for the cockpit's life; setCar redraws them) ----
    var liveryCanvas = makeCanvas(ATLAS, ATLAS), carbonC = carbonCanvas(), envC = envCanvas(), shadowC = shadowCanvas();
    var tyreC = makeCanvas(1024, 128), tyreBlurC = makeCanvas(1024, 128), displayC = makeCanvas(256, 160);
    function tex(c, repeat, mips) {
      if (!c) return null;
      var t = new THREE.CanvasTexture(c);
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (mips === false) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
      t.anisotropy = 8;
      return t;
    }
    var liveryTex = tex(liveryCanvas), carbonTex = tex(carbonC, true), shadowTex = tex(shadowC, false, false);
    var tyreTex = tex(tyreC, true), tyreBlurTex = tex(tyreBlurC, true), displayTex = tex(displayC, false, false);
    if (tyreTex) { tyreTex.wrapT = tyreBlurTex.wrapT = THREE.ClampToEdgeWrapping; }
    var envTex = null;
    if (envC) { envTex = new THREE.CanvasTexture(envC); envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.name = 'cockpit-env'; }
    if (displayTex) displayTex.name = 'wheel-display';
    if (liveryTex) liveryTex.name = 'livery';

    // ---- materials (shared; geometry is swapped when the style changes) ----
    function std(o) {
      var m = new THREE.MeshStandardMaterial(o);
      m.side = DS;
      if (envTex) { m.envMap = envTex; }
      return m;
    }
    // (the paint albedo is held a little under 1: the scene's lights are bright and would clip saturated liveries)
    var mPaint = std({ color: 0xd4d4d4, map: liveryTex, vertexColors: true, roughness: 0.30, metalness: 0.08, envMapIntensity: 0.45 });
    var mCarbon = std({ color: 0xffffff, map: carbonTex, vertexColors: true, roughness: 0.46, metalness: 0.12, envMapIntensity: 0.35 });
    var mMatte = std({ color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.25 });
    var mMetal = std({ color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.85, envMapIntensity: 0.9 });
    var mMirror = std({ color: 0x8a939e, roughness: 0.06, metalness: 1.0, envMapIntensity: 1.15 });
    var mTyre = std({ color: 0xffffff, map: tyreTex, vertexColors: true, roughness: 0.82, metalness: 0.0, envMapIntensity: 0.3 });
    var mTyreBlur = std({ color: 0xffffff, map: tyreBlurTex, vertexColors: true, roughness: 0.82, metalness: 0.0, envMapIntensity: 0.3 });
    var mSuit = std({ color: 0x333333, vertexColors: true, roughness: 0.9, metalness: 0.0, envMapIntensity: 0.25 });
    var mDisplay = new THREE.MeshBasicMaterial({ color: displayTex ? 0xffffff : 0x0a1a12, map: displayTex, toneMapped: false });
    var mShadow = new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, opacity: shadowTex ? 0.55 : 0,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // live mirror glass: the rear view render target (a mirror gives back a little less light than it gets)
    var mMirrorLive = new THREE.MeshBasicMaterial({ color: 0xc8cdd3, side: DS });
    if (!liveryTex) mPaint.color.set(DEFAULT_LIVERY.colour);
    if (!carbonTex) mCarbon.color.set(0x222326);
    var materials = [mPaint, mCarbon, mMatte, mMetal, mMirror, mMirrorLive, mTyre, mTyreBlur, mSuit, mDisplay, mShadow];

    // ---- persistent scene graph (geometries filled in by build()) ----
    function mesh(parent, mat, name) { var m = new THREE.Mesh(undefined, mat); m.name = name; parent.add(m); return m; }
    var body = new THREE.Group();
    body.name = 'cockpit-body';
    group.add(body);
    var bodyMeshes = { paint: mesh(body, mPaint, 'paint'), carbon: mesh(body, mCarbon, 'carbon'), matte: mesh(body, mMatte, 'matte'),
                       metal: mesh(body, mMetal, 'metal'), mirror: mesh(body, mMirror, 'mirror') };
    var shadowMesh = mesh(body, mShadow, 'shadow');
    shadowMesh.renderOrder = 1;
    // rear-view cameras, one per glass (0: the left glass, +x; 1: the right one), placed by build()
    var mirror = { on: false, rt: null, cams: [], centre: [new THREE.Vector3(), new THREE.Vector3()], next: 0, busy: false,
                   done: [false, false], passes: 0 };
    for (var mc = 0; mc < 2; mc++) {
      var mcam = new THREE.PerspectiveCamera(15, 3, MIRROR_NEAR, MIRROR_FAR);
      mcam.name = 'mirror-camera';
      group.add(mcam);
      mirror.cams.push(mcam);
    }
    var wheels = [];
    for (var sx = 1; sx >= -1; sx -= 2) {
      var pivot = new THREE.Group();                   // steers
      var flip = new THREE.Group();                    // the right wheel is the left one turned round
      flip.rotation.y = sx > 0 ? 0 : Math.PI;
      var spin = new THREE.Group();                    // rolls
      pivot.add(flip); flip.add(spin); group.add(pivot);
      wheels.push({ side: sx, pivot: pivot, spin: spin, tyre: mesh(spin, mTyre, 'tyre'), rim: mesh(spin, mMetal, 'rim'),
                    hub: mesh(flip, mCarbon, 'brake-duct'), wear: -1 });
    }
    var column = new THREE.Group();
    group.add(column);
    var hand = new THREE.Group();
    column.add(hand);
    var handMeshes = { carbon: mesh(hand, mCarbon, 'wheel-carbon'), matte: mesh(hand, mMatte, 'wheel-matte'),
                       metal: mesh(hand, mMetal, 'wheel-metal'), display: mesh(hand, mDisplay, 'wheel-display') };
    // forearm (unit length along +Y, the wrist at the top): darker towards the elbow, which is down in the cockpit
    var armGeo = new THREE.CylinderGeometry(0.033, 0.043, 1, 12, 4, true);
    (function () {
      var p = armGeo.attributes.position, c = [];
      for (var i = 0; i < p.count; i++) { var k = 0.28 + 0.72 * Math.pow(p.getY(i) + 0.5, 1.5); c.push(k, k, k); }
      armGeo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    })();
    var arms = [mesh(group, mSuit, 'forearm'), mesh(group, mSuit, 'forearm')];
    arms[0].geometry = arms[1].geometry = armGeo;
    var gloveAt = [new THREE.Vector3(), new THREE.Vector3()];
    var ELBOW = [new THREE.Vector3(0.235, 0.40, -0.16), new THREE.Vector3(-0.235, 0.40, -0.16)];

    // ---- build a style ----
    var cur = { style: '', year: 0, R: 0.36, W: 0.305, classic: false };

    function build(style, year) {
      var B = new Builder(THREE), H = new Builder(THREE), Wb = new Builder(THREE), i, sd;
      var noseKey = style === 'modern' && (year === 2012 || year === 2013) ? 'stepped' : style;
      var nose = NOSE[noseKey], wing = WING[style], wh = style === 'halo18' ? WHEELS.r18 : WHEELS.r13;
      var R = wh.R, rr = wh.rr, TW = style === 'modern' && year < 2017 ? 0.25 : 0.305, hw = TW / 2;
      var classic = year < 2014;

      // ---------- chassis and nose ----------
      B.add('paint', archLoft(THREE, sections(nose), 26, 0.035), null, { uv: 'livery' });
      // cockpit side walls: rounded rim from the dash back to the headrest (sections along z, outer x 0.40)
      for (sd = -1; sd <= 1; sd += 2) {
        var rim = [];
        var zs = [0.42, 0.25, 0.0, -0.30, -0.60, -0.85, -1.00], tops = [0.612, 0.592, 0.576, 0.570, 0.590, 0.640, 0.675];
        for (i = 0; i < zs.length; i++) rim.push({ z: zs[i], x: sd * 0.338, top: tops[i], hw: 0.065, h: 0.40, n: 4 });
        // the outside and the top in the livery; the inner face (towards the driver) padded and dark
        B.add('paint', archLoft(THREE, rim, 12, 0, sd > 0 ? 0 : 0.40, sd > 0 ? 0.60 : 1), null, { uv: 'livery' });
        B.add('matte', archLoft(THREE, rim, 8, 0, sd > 0 ? 0.60 : 0, sd > 0 ? 1 : 0.40), null, { col: 0x23272f, ao: function (x, y) {
          return 0.30 + 0.70 * Math.max(0, Math.min(1, (y - 0.38) / 0.20));
        } });
        // a thin coloured lip along the inner edge, where the padding starts
        var lip = [];
        for (i = 0; i < zs.length; i++) lip.push([sd * (0.338 - 0.036), tops[i] - 0.004, zs[i]]);
        B.add('paint', sweep(THREE, lip, 0.010, 0.010, 5, false), null, { uv: 'swatch', sw: SW.c2 });
        // inner liner of the tub, dark
        B.add('matte', new THREE.BoxGeometry(0.02, 0.44, 1.42), at(THREE, sd * 0.262, 0.36, -0.29), { col: 0x0c0d10 });
        // headrest pads beside the helmet
        var pad = [];
        var pz = [-0.20, -0.35, -0.60, -0.85, -0.98], pt = [0.62, 0.70, 0.735, 0.74, 0.735];
        for (i = 0; i < pz.length; i++) pad.push({ z: pz[i], x: sd * 0.245, top: pt[i], hw: 0.052, h: 0.26, n: 3 });
        B.add('matte', archLoft(THREE, pad, 10, 0), null, { col: 0x1d222b, uv: 'box' });
      }
      // headrest back, cockpit floor, dash bulkhead
      B.add('matte', rbox(THREE, 0.44, 0.32, 0.10, 0.04), at(THREE, 0, 0.60, -1.00), { col: 0x1d222b });
      B.add('matte', new THREE.BoxGeometry(0.50, 0.02, 1.45), at(THREE, 0, 0.15, -0.30), { col: 0x050607, ao: aoNone });
      B.add('carbon', new THREE.BoxGeometry(0.52, 0.29, 0.03), at(THREE, 0, 0.455, 0.425), { ao: function () { return 0.55; } });
      // cockpit front rim (the padded lip under the cowl, in front of the wheel)
      B.add('matte', sweep(THREE, [[-0.285, 0.588, 0.37], [-0.20, 0.603, 0.40], [0, 0.609, 0.412], [0.20, 0.603, 0.40], [0.285, 0.588, 0.37]], 0.030, 0.018, 8, true),
        null, { col: 0x16181c });

      // ---------- sidepods, floor, bargeboards ----------
      var pod = style === 'halo18' ? [[0.30, 0.50, 0.18, 0.28, 4], [0.0, 0.53, 0.19, 0.31, 4], [-0.6, 0.52, 0.18, 0.32, 3.4], [-1.3, 0.44, 0.14, 0.28, 2.8], [-1.9, 0.32, 0.07, 0.20, 2.5]]
        : (style === 'halo' ? [[0.32, 0.53, 0.17, 0.31, 4], [0.0, 0.55, 0.18, 0.34, 4], [-0.6, 0.54, 0.17, 0.34, 3.4], [-1.3, 0.46, 0.13, 0.30, 2.8], [-1.9, 0.33, 0.07, 0.20, 2.5]]
          : [[0.22, 0.54, 0.18, 0.33, 4], [-0.1, 0.56, 0.19, 0.36, 4], [-0.7, 0.55, 0.18, 0.36, 3.4], [-1.35, 0.46, 0.13, 0.30, 2.8], [-1.9, 0.33, 0.07, 0.20, 2.5]]);
      for (sd = -1; sd <= 1; sd += 2) {
        var ps = sections(pod, sd * 0.60);
        B.add('paint', archLoft(THREE, ps, 16, 0), null, { uv: 'livery' });
        // inlet: the front of the pod is a dark opening with a carbon lip round it
        var ip = archPoints(ps[0], 16, 0.93), fan = [], ipos = [];
        for (i = 0; i < ip.length; i++) ipos.push(ip[i][0], ip[i][1], ip[i][2] - 0.02);
        ipos.push(ps[0].x, ps[0].top - ps[0].h, ps[0].z - 0.02);
        for (i = 0; i + 1 < ip.length; i++) fan.push(i, ip.length, i + 1);
        var ig = new THREE.BufferGeometry();
        ig.setAttribute('position', new THREE.Float32BufferAttribute(ipos, 3)); ig.setIndex(fan); ig.computeVertexNormals();
        B.add('matte', ig, null, { col: 0x050506, ao: aoNone });
        B.add('carbon', sweep(THREE, archPoints(ps[0], 16, 0.97), 0.018, 0.018, 6, false), null, { tile: 0.05 });
        // floor edge
        B.add('carbon', new THREE.BoxGeometry(0.62, 0.025, 3.1), at(THREE, sd * 0.56, 0.065, -0.35), { tile: 0.12 });
        if (style !== 'halo18') {
          for (i = 0; i < 3; i++) B.add('carbon', new THREE.BoxGeometry(0.008, 0.26 - i * 0.05, 0.42), at(THREE, sd * (0.47 + i * 0.09), 0.20, 0.95 - i * 0.12, 0, sd * 0.08), {});
        }
      }

      // ---------- front wing ----------
      for (var e = 0; e < wing.el.length; e++) {
        var E = wing.el[e], st = [];
        var NS = 12;
        for (i = 0; i <= NS; i++) {
          var t = i / NS, x = E[0] + (E[1] - E[0]) * t;
          // 2022: the outer third of the flaps rolls up into the endplate
          var roll = style === 'halo18' ? Math.pow(Math.max(0, (t - 0.55) / 0.45), 2) : t;
          st.push({ x: x, zle: E[2] - (style === 'halo18' ? 0.04 * roll : 0), yle: E[3] + (E[4] - E[3]) * roll, c: E[5] * (style === 'halo18' ? 1 - 0.25 * t : 1), a: E[6] + (E[7] - E[6]) * roll });
        }
        for (sd = -1; sd <= 1; sd += 2) {
          var g = foilLoft(THREE, st, true);
          var m = sd > 0 ? null : mirrorX(THREE);
          if (e === 0) B.add('carbon', g, m, { tile: 0.08 });
          else {
            // one row of the flap band (colours vary along the span only, so mip levels do not bleed between bands)
            var band = Math.min(3, e - 1), br = rectUV([RG.wing[0], RG.wing[1] + band * 16 + 8, RG.wing[2], 0]);
            B.add('paint', g, m, { uv: 'keep', rect: [br[0], br[1], br[2], br[1]] });
          }
        }
      }
      // endplates (extruded outline in the z-y plane) + footplate
      var sh = new THREE.Shape(), pl = wing.plate;
      sh.moveTo(pl[0][0], pl[0][1]);
      for (i = 1; i < pl.length; i++) sh.lineTo(pl[i][0], pl[i][1]);
      var basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0));
      for (sd = -1; sd <= 1; sd += 2) {
        var ep = new THREE.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.003, bevelSegments: 1, curveSegments: 4 });
        var mm = new THREE.Matrix4().makeTranslation(sd > 0 ? wing.half - 0.012 : -wing.half, 0, 0).multiply(basis);
        B.add('paint', ep, mm, { uv: 'livery' });
        B.add('carbon', new THREE.BoxGeometry(0.10, 0.012, 0.60), at(THREE, sd * (wing.half - 0.05), 0.035, 2.50), {});
      }
      if (wing.pylons) {
        var ntip = noseAt(nose, 2.55);
        for (sd = -1; sd <= 1; sd += 2) B.add('carbon', new THREE.BoxGeometry(0.012, Math.max(0.02, ntip.yb - 0.09), 0.26), at(THREE, sd * 0.055, (ntip.yb + 0.09) / 2, 2.60), {});
      }

      // ---------- front suspension ----------
      for (sd = -1; sd <= 1; sd += 2) {
        var ux = sd * (WHEEL_X - hw - 0.06), a1 = noseAt(nose, 1.62), a2 = noseAt(nose, 2.12), a3 = noseAt(nose, 1.78), a4 = noseAt(nose, 1.95);
        var ut = [ux, R + 0.14, AXLE_Z], lb = [ux, R - 0.16, AXLE_Z];
        var ch = function (a, z, dy) { return [sd * (a.hw - 0.015), a.top - dy, z]; };
        strut(THREE, B, 'carbon', ch(a1, 1.62, 0.07), ut, 0.050, 0.016, { tile: 0.05 });
        strut(THREE, B, 'carbon', ch(a2, 2.12, 0.07), ut, 0.050, 0.016, { tile: 0.05 });
        strut(THREE, B, 'carbon', [sd * (a1.hw - 0.02), Math.max(0.18, a1.yb + 0.06), 1.60], lb, 0.050, 0.016, { tile: 0.05 });
        strut(THREE, B, 'carbon', [sd * (a2.hw - 0.02), Math.max(0.16, a2.yb + 0.06), 2.16], lb, 0.050, 0.016, { tile: 0.05 });
        strut(THREE, B, 'carbon', [ux - sd * 0.04, R - 0.13, AXLE_Z - 0.02], ch(a3, 1.78, 0.05), 0.022, 0.022, { tile: 0.05 });   // push rod
        var tz = style === 'halo18' ? AXLE_Z + 0.13 : AXLE_Z - 0.12;
        strut(THREE, B, 'carbon', [sd * (a4.hw - 0.02), (a4.top + a4.yb) / 2 + 0.03, tz - 0.02], [ux + sd * 0.01, R + 0.03, tz], 0.040, 0.014, { tile: 0.05 });   // track rod
      }

      // ---------- mirrors ----------
      var mz = 0.45, mx = style === 'halo18' ? 0.66 : 0.70, my = 0.665, mw = style === 'modern' ? 0.17 : 0.20, mh = style === 'modern' ? 0.070 : 0.078;
      for (sd = -1; sd <= 1; sd += 2) {
        var yaw = sd * 0.34;                          // glass turned towards the driver
        var hm = at(THREE, sd * mx, my, mz, 0.06, yaw, 0);
        // housing (front face at z -0.0305 of the mirror frame), a dark bezel, the glass in front of it
        B.add('paint', rbox(THREE, mw, mh, 0.085, 0.03, 0.012), new THREE.Matrix4().multiplyMatrices(hm, at(THREE, 0, 0, 0.012)), { uv: 'swatch', sw: SW.c1 });
        B.add('matte', rbox(THREE, mw - 0.010, mh - 0.010, 0.004, 0.02, 0.001), new THREE.Matrix4().multiplyMatrices(hm, at(THREE, 0, 0, -0.0315)), { col: 0x0b0b0d, ao: aoNone });
        // slightly convex glass (normals fanned out), so the environment map shows sky above ground like a real
        // mirror, not one flat tone; texture coordinates: this glass's half of the live rear view, the glass's +x
        // (the driver's left) on the view's right-hand side (the rear camera sees the car's left on its right)
        var gw = mw - 0.020, gh = mh - 0.018, gm = new THREE.Matrix4().multiplyMatrices(hm, at(THREE, 0, 0, -0.0345));
        var gl = rbox(THREE, gw, gh, 0.002, 0.016, 0), gp = gl.attributes.position, gn = gl.attributes.normal, gu = gl.attributes.uv;
        var u0 = (sd > 0 ? 0 : 0.5) + 1 / MIRROR_W, du = 0.5 - 2 / MIRROR_W;
        for (i = 0; i < gp.count; i++) {
          gu.setXY(i, u0 + du * Math.max(0, Math.min(1, gp.getX(i) / gw + 0.5)), Math.max(0, Math.min(1, gp.getY(i) / gh + 0.5)));
          if (gn.getZ(i) > -0.5) continue;
          tmpN.set(gp.getX(i) * 2.5, gp.getY(i) * 9, -1).normalize();
          gn.setXYZ(i, tmpN.x, tmpN.y, tmpN.z);
        }
        B.add('mirror', gl, gm, { uv: 'keep', ao: aoNone });
        placeMirrorCamera(sd > 0 ? 0 : 1, gm, gw / gh);
        if (style === 'halo18') {
          // flat aerofoil mount from the sidepod shoulder + a thin blade from the chassis
          strut(THREE, B, 'carbon', [sd * 0.60, 0.55, 0.36], [sd * mx, my - 0.03, mz + 0.01], 0.05, 0.012, {});
          strut(THREE, B, 'carbon', [sd * 0.40, 0.60, 0.50], [sd * (mx - mw / 2 + 0.02), my - 0.01, mz + 0.02], 0.035, 0.008, {});
        } else if (style === 'halo') {
          strut(THREE, B, 'carbon', [sd * 0.62, pod[0][1] - 0.02, pod[0][0] + 0.02], [sd * mx, my - 0.03, mz + 0.01], 0.040, 0.012, {});
          strut(THREE, B, 'carbon', [sd * 0.40, 0.62, 0.40], [sd * (mx - 0.05), my - 0.02, mz + 0.02], 0.028, 0.010, {});
        } else {
          strut(THREE, B, 'carbon', [sd * 0.395, 0.60, 0.34], [sd * (mx - 0.04), my - 0.025, mz + 0.01], 0.030, 0.012, {});
        }
      }

      // ---------- halo ----------
      if (style !== 'modern') {
        var hp = HALO.hoop, ha = HALO.apex, hpt = HALO.pillar;
        var curve = [], hwid = style === 'halo18' ? 0.058 : 0.050, hhei = style === 'halo18' ? 0.040 : 0.034;
        for (i = 0; i < hp.length; i++) curve.push(new THREE.Vector3(hp[i][0], hp[i][1], hp[i][2]));
        curve.push(new THREE.Vector3(ha[0], ha[1], ha[2]));
        for (i = hp.length - 1; i >= 0; i--) curve.push(new THREE.Vector3(-hp[i][0], hp[i][1], hp[i][2]));
        // carbon hoop, the front "tip" (where the pillar meets it) in the player's accent colour
        var cc = new THREE.CatmullRomCurve3(curve, false, 'catmullrom', 0.5), cp = cc.getPoints(70), runs = [], run = null, prev = null;
        for (i = 0; i < cp.length; i++) {
          var P = [cp[i].x, cp[i].y, cp[i].z], tip = Math.abs(P[0]) < 0.12 && P[2] > 0.5;
          if (!run || run.tip !== tip) { run = { tip: tip, pts: prev ? [prev] : [] }; runs.push(run); }
          run.pts.push(P); prev = P;
        }
        for (i = 0; i < runs.length; i++) {
          if (runs[i].pts.length < 2) continue;
          if (runs[i].tip) B.add('paint', sweep(THREE, runs[i].pts, hwid * 1.02, hhei * 1.02, 10, true), null, { uv: 'swatch', sw: SW.acc });
          else B.add('carbon', sweep(THREE, runs[i].pts, hwid, hhei, 10, true), null, { tile: 0.08 });
        }
        // centre pillar: slim across the view, deeper along it, flaring into a foot on the chassis
        var foot = noseAt(nose, 0.95), pil = [], pw = [], pd = [];
        for (i = 0; i <= 8; i++) {
          var tt = i / 8;
          pil.push([0, hpt[1] + (foot.top - hpt[1]) * tt, hpt[2] + (0.95 - hpt[2]) * tt]);
          pw.push(0.022 + 0.030 * Math.pow(tt, 4));
          pd.push(0.050 + 0.10 * Math.pow(tt, 3));
        }
        B.add('carbon', sweep(THREE, pil, pw, pd, 10, true), null, { tile: 0.06 });
      }

      // ---------- camera pods, antennas ----------
      var cpz = style === 'modern' ? 1.05 : 0.98, cpn = noseAt(nose, cpz);
      for (sd = -1; sd <= 1; sd += 2) {
        // TV camera pod: dark body, the lens hood in the player's accent colour
        B.add('matte', new THREE.CapsuleGeometry(0.012, 0.045, 3, 8), at(THREE, sd * (cpn.hw + 0.002), cpn.top - 0.075, cpz, Math.PI / 2, 0, 0), { col: 0x16171a });
        B.add('paint', new THREE.CylinderGeometry(0.0125, 0.0125, 0.018, 10), at(THREE, sd * (cpn.hw + 0.002), cpn.top - 0.075, cpz + 0.03, Math.PI / 2, 0, 0), { uv: 'swatch', sw: SW.acc });
      }
      var an = noseAt(nose, 1.12);
      B.add('matte', new THREE.CylinderGeometry(0.0025, 0.004, 0.11, 5), at(THREE, 0.09, an.top + 0.05, 1.12, -0.35, 0, 0), { col: 0x111111 });
      B.add('matte', new THREE.CylinderGeometry(0.008, 0.008, 0.012, 8), at(THREE, 0.09, an.top + 0.003, 1.12), { col: 0x222222 });
      if (style === 'modern') B.add('matte', new THREE.CylinderGeometry(0.003, 0.003, 0.16, 5), at(THREE, -0.12, an.top + 0.07, 1.30, -0.5, 0, 0), { col: 0x111111 });

      // ---------- soft contact shadows under the car (drawn on the road) ----------
      var shadowParts = [[0, 1.55, 0.95, 2.9], [WHEEL_X, AXLE_Z, 0.62, 0.95], [-WHEEL_X, AXLE_Z, 0.62, 0.95], [0.62, -0.7, 0.75, 2.6], [-0.62, -0.7, 0.75, 2.6], [0, 2.55, 2.1, 0.75]];
      for (i = 0; i < shadowParts.length; i++) {
        var sp = shadowParts[i], pg = new THREE.PlaneGeometry(sp[2], sp[3]);
        pg.rotateX(-Math.PI / 2);
        B.add('shadow', pg, at(THREE, sp[0], 0.012, sp[1]), { uv: 'keep', ao: aoNone });
      }

      // ---------- front wheels (one wheel, used for both; its -X side faces the car) ----------
      var prof = tyreProfile(THREE, R, TW, rr, wh.sh);
      Wb.add('tyre', latheX(THREE, prof.pts, 56, prof.vs), null, { uv: 'keep', ao: aoNone });
      // rim: barrel with flanges, the outer face: spokes (13 in) or a cover (18 in), coloured wheel nut
      var rp = [[rr + 0.010, -hw - 0.002], [rr - 0.004, -hw + 0.012], [rr - 0.012, -hw + 0.035], [rr - 0.014, hw - 0.035], [rr - 0.006, hw - 0.012], [rr + 0.010, hw + 0.002]];
      var rv = []; for (i = 0; i < rp.length; i++) rv.push(new THREE.Vector2(rp[i][0], rp[i][1]));
      Wb.add('rim', latheX(THREE, rv, 40), null, { col: 0x5a5e66, ao: aoNone });
      if (style === 'halo18') {
        var cv = [[rr + 0.010, hw + 0.004], [rr * 0.75, hw + 0.020], [0.06, hw + 0.030], [0.035, hw + 0.050], [0.0, hw + 0.052]];
        var cvv = []; for (i = 0; i < cv.length; i++) cvv.push(new THREE.Vector2(cv[i][0], cv[i][1]));
        Wb.add('rim', latheX(THREE, cvv, 40), null, { col: 0x1c1d21, ao: aoNone });
      } else {
        Wb.add('rim', new THREE.CylinderGeometry(0.045, 0.05, 0.05, 12).rotateZ(-Math.PI / 2), at(THREE, hw - 0.04, 0, 0), { col: 0x3a3d44, ao: aoNone });
        for (i = 0; i < 10; i++) {
          var an2 = i * Math.PI * 2 / 10, spk = new THREE.BoxGeometry(0.012, rr - 0.045, 0.018);
          spk.translate(0, (rr - 0.045) / 2 + 0.04, 0);
          Wb.add('rim', spk, at(THREE, hw - 0.045 + 0.02 * (i % 2), 0, 0, an2, 0, 0), { col: 0x6a6e76, ao: aoNone });
        }
      }
      Wb.add('rim', new THREE.CylinderGeometry(0.028, 0.028, 0.03, 6).rotateZ(-Math.PI / 2), at(THREE, hw + (style === 'halo18' ? 0.06 : -0.01), 0, 0), { col: 0xc8202a, ao: aoNone });
      // brake duct drum on the inner side, the intake scoop, and (2022 on) the wake deflector over the tyre
      Wb.add('hub', new THREE.CylinderGeometry(rr - 0.02, rr - 0.03, 0.14, 24).rotateZ(-Math.PI / 2), at(THREE, -hw + 0.02, 0, 0), { tile: 0.06 });
      Wb.add('hub', rbox(THREE, 0.07, 0.06, 0.12, 0.02), at(THREE, -hw - 0.02, rr * 0.35, rr * 0.75), { tile: 0.06 });
      Wb.add('hub', new THREE.BoxGeometry(0.05, 0.05, 0.08), at(THREE, -hw - 0.035, 0.12, 0), { tile: 0.06 });
      if (style === 'halo18') {
        var dfl = [];
        for (i = 0; i <= 8; i++) { var ang = -0.2 + 0.9 * i / 8; dfl.push([-hw + 0.06, Math.cos(ang) * (R + 0.055), Math.sin(ang) * (R + 0.055)]); }
        Wb.add('hub', sweep(THREE, dfl, 0.09, 0.010, 6, true), null, { tile: 0.06 });
        Wb.add('hub', new THREE.BoxGeometry(0.01, 0.10, 0.03), at(THREE, -hw + 0.04, R - 0.01, 0.12), { tile: 0.06 });
      }

      // ---------- steering wheel (in the hand group: x across, y up the face, the face towards -z) ----------
      buildWheel(H, classic);

      // ---------- swap geometries in ----------
      function swap(meshObj, geo) { if (meshObj.geometry && meshObj.geometry !== armGeo) meshObj.geometry.dispose(); meshObj.geometry = geo || new THREE.BufferGeometry(); meshObj.visible = !!geo; }
      for (var k in bodyMeshes) swap(bodyMeshes[k], B.build(k));
      swap(shadowMesh, B.build('shadow'));
      for (k in handMeshes) swap(handMeshes[k], H.build(k));
      var tg = Wb.build('tyre');
      for (i = 0; i < 2; i++) {
        var w = wheels[i];
        swap(w.tyre, i ? tg.clone() : tg);
        swap(w.rim, Wb.build('rim'));
        swap(w.hub, Wb.build('hub'));
        w.pivot.position.set(w.side * WHEEL_X, R, AXLE_Z);
        w.wear = -1;
      }
      cur.R = R; cur.W = TW; cur.classic = classic;
      // steering column / wheel placement
      column.position.set(0, 0.535, 0.235);
      column.rotation.set(0.32, 0, 0);
    }

    function buildWheel(H, classic) {
      var i, sd;
      if (!classic) {
        // 2014 on: squared-off body, grips, big colour screen, LED strip, rotaries, buttons, paddles
        var bs = new THREE.Shape();
        bs.moveTo(-0.090, -0.058); bs.lineTo(0.090, -0.058); bs.quadraticCurveTo(0.100, -0.058, 0.100, -0.045);
        bs.lineTo(0.102, 0.052); bs.quadraticCurveTo(0.100, 0.070, 0.082, 0.072); bs.quadraticCurveTo(0, 0.080, -0.082, 0.072);
        bs.quadraticCurveTo(-0.100, 0.070, -0.102, 0.052); bs.lineTo(-0.100, -0.045); bs.quadraticCurveTo(-0.100, -0.058, -0.090, -0.058);
        var bg = new THREE.ExtrudeGeometry(bs, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 6 });
        bg.translate(0, 0, -0.011);
        H.add('carbon', bg, null, { tile: 0.05, ao: aoNone });
        for (sd = -1; sd <= 1; sd += 2) {
          H.add('matte', rbox(THREE, 0.046, 0.150, 0.046, 0.02), at(THREE, sd * 0.122, 0.004, 0.004, 0, 0, sd * -0.06), { col: 0x17181b, ao: aoNone });
          glove(H, sd, sd * 0.125, 0.0, sd * -0.06);
          // paddles behind the upper corners
          H.add('metal', rbox(THREE, 0.060, 0.050, 0.004, 0.015, 0.001), at(THREE, sd * 0.098, 0.050, 0.030, 0, 0, sd * -0.35), { col: 0x9aa0a8 });
          H.add('carbon', rbox(THREE, 0.050, 0.040, 0.004, 0.012, 0.001), at(THREE, sd * 0.085, -0.035, 0.030, 0, 0, sd * 0.3), { tile: 0.04 });
        }
        // screen bezel + screen + LED strip (the display material: one live canvas)
        H.add('matte', rbox(THREE, 0.118, 0.074, 0.006, 0.006, 0.001), at(THREE, 0, 0.020, -0.0145), { col: 0x050506, ao: aoNone });
        addDisplay(H, 0.106, 0.064, 0, 0.020, -0.0180, 0.146, 0.011, 0, 0.0665);
        // rotary dials and buttons
        var rot = [[-0.070, -0.030], [0.070, -0.030], [-0.036, -0.040], [0.036, -0.040], [-0.071, 0.000], [0.071, 0.000]];
        for (i = 0; i < rot.length; i++) knob(H, rot[i][0], rot[i][1], 0.0095);
        var btn = [[-0.078, 0.046, 0xe0202a], [0.078, 0.046, 0x2bd046], [-0.083, 0.024, 0xffd21e], [0.083, 0.024, 0x2a6cff],
                   [0, -0.042, 0xf2f2f2], [-0.018, -0.050, 0xff8a1e], [0.018, -0.050, 0x19c8e6], [-0.056, -0.052, 0x9a4dff], [0.056, -0.052, 0xe0202a]];
        for (i = 0; i < btn.length; i++) button(H, btn[i][0], btn[i][1], 0.0068, btn[i][2]);
      } else {
        // 2010-2013: rounder "butterfly" wheel, small screen, LED row along the top, many buttons
        var cs = new THREE.Shape();
        cs.moveTo(-0.085, -0.050); cs.quadraticCurveTo(0, -0.072, 0.085, -0.050); cs.quadraticCurveTo(0.112, -0.040, 0.118, 0.0);
        cs.quadraticCurveTo(0.118, 0.060, 0.080, 0.068); cs.quadraticCurveTo(0, 0.085, -0.080, 0.068); cs.quadraticCurveTo(-0.118, 0.060, -0.118, 0.0);
        cs.quadraticCurveTo(-0.112, -0.040, -0.085, -0.050);
        var cg = new THREE.ExtrudeGeometry(cs, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 2, curveSegments: 8 });
        cg.translate(0, 0, -0.011);
        H.add('carbon', cg, null, { tile: 0.05, ao: aoNone });
        for (sd = -1; sd <= 1; sd += 2) {
          H.add('matte', rbox(THREE, 0.044, 0.125, 0.048, 0.02), at(THREE, sd * 0.118, -0.004, 0.004, 0, 0, sd * -0.12), { col: 0x17181b, ao: aoNone });
          glove(H, sd, sd * 0.121, -0.008, sd * -0.12);
          H.add('metal', rbox(THREE, 0.055, 0.045, 0.004, 0.015, 0.001), at(THREE, sd * 0.090, 0.050, 0.030, 0, 0, sd * -0.35), { col: 0x9aa0a8 });
        }
        H.add('matte', rbox(THREE, 0.080, 0.042, 0.006, 0.005, 0.001), at(THREE, 0, 0.026, -0.0145), { col: 0x050506, ao: aoNone });
        addDisplay(H, 0.070, 0.035, 0, 0.026, -0.0180, 0.150, 0.010, 0, 0.061);
        var rot2 = [[-0.050, -0.022], [0.050, -0.022], [-0.025, -0.045], [0.025, -0.045]];
        for (i = 0; i < rot2.length; i++) knob(H, rot2[i][0], rot2[i][1], 0.0085);
        var b2 = [[-0.068, 0.040, 0xe0202a], [0.068, 0.040, 0x2bd046], [-0.086, 0.018, 0xffd21e], [0.086, 0.018, 0x2a6cff], [-0.080, -0.010, 0xf2f2f2],
                  [0.080, -0.010, 0xff8a1e], [0, -0.030, 0xe0202a], [-0.045, 0.002, 0x19c8e6], [0.045, 0.002, 0x9a4dff], [0, -0.056, 0xf2f2f2]];
        for (i = 0; i < b2.length; i++) button(H, b2[i][0], b2[i][1], 0.0065, b2[i][2]);
      }
      // column hub
      H.add('matte', new THREE.CylinderGeometry(0.026, 0.030, 0.10, 12).rotateX(Math.PI / 2), at(THREE, 0, 0, 0.06), { col: 0x101114, ao: aoNone });
    }
    // a gloved hand round a grip: palm and fingers wrapped round it, the thumb resting on the face, a light cuff
    function glove(H, sd, x, y, rz) {
      var base = at(THREE, x, y, 0, 0, 0, rz), sph = function () { return new THREE.SphereGeometry(1, 14, 10); };
      function part(geo, px, py, pz, sx, sy, sz, rx, ry, rzz, col) {
        H.add('matte', geo, new THREE.Matrix4().multiplyMatrices(base, at(THREE, px, py, pz, rx || 0, ry || 0, rzz || 0, sx, sy, sz)), { col: col, ao: aoNone });
      }
      part(sph(), sd * 0.004, 0.000, 0.004, 0.034, 0.050, 0.036, 0, 0, 0, 0x2a2e35);            // palm / back of the hand
      part(sph(), sd * -0.006, 0.004, -0.024, 0.030, 0.044, 0.016, 0, 0, 0, 0x30353d);          // fingers over the front of the grip
      part(sph(), sd * -0.030, 0.020, -0.026, 0.011, 0.026, 0.010, 0, 0, sd * 0.55, 0x2a2e35);  // thumb on the face
      part(new THREE.CylinderGeometry(1, 1, 1, 14, 1, true), sd * 0.004, -0.046, 0.004, 0.033, 0.016, 0.035, 0, 0, 0, 0xdadada);  // cuff
    }
    function knob(H, x, y, r) {
      H.add('matte', new THREE.CylinderGeometry(r, r * 1.08, 0.012, 12).rotateX(Math.PI / 2), at(THREE, x, y, -0.019), { col: 0x33363c, ao: aoNone });
      H.add('matte', new THREE.BoxGeometry(0.002, r * 0.9, 0.002), at(THREE, x, y + r * 0.45, -0.0255), { col: 0xf0f0f0, ao: aoNone });
    }
    function button(H, x, y, r, col) {
      H.add('matte', new THREE.CylinderGeometry(r * 1.35, r * 1.35, 0.004, 12).rotateX(Math.PI / 2), at(THREE, x, y, -0.0160), { col: 0x0a0a0b, ao: aoNone });
      H.add('matte', new THREE.CylinderGeometry(r, r, 0.007, 12).rotateX(Math.PI / 2), at(THREE, x, y, -0.0185), { col: col, ao: aoNone });
    }
    // screen (w x h at x, y) + LED strip above it, both mapped onto the display canvas
    function addDisplay(H, w, h, x, y, z, lw, lh, lx, ly) {
      var scr = new THREE.PlaneGeometry(w, h); scr.rotateY(Math.PI);
      H.add('display', scr, at(THREE, x, y, z), { uv: 'keep', rect: [0, 0, 1, 0.8], ao: aoNone });
      var led = new THREE.PlaneGeometry(lw, lh); led.rotateY(Math.PI);
      H.add('display', led, at(THREE, lx, ly, z + 0.002), { uv: 'keep', rect: [0, 0.8, 1, 1], ao: aoNone });
      H.add('matte', rbox(THREE, lw + 0.008, lh + 0.006, 0.005, 0.004, 0.001), at(THREE, lx, ly, z + 0.0045), { col: 0x050506, ao: aoNone });
    }

    // ---- livery / tyres (canvases) ----
    var liv = { c1: DEFAULT_LIVERY.colour, c2: DEFAULT_LIVERY.colour2, acc: DEFAULT_LIVERY.accent, num: 7, nose: 'halo18', key: '' };
    function paintLivery() {
      var key = [liv.c1, liv.c2, liv.acc, liv.num, liv.nose].join('|');
      if (key === liv.key) return;
      liv.key = key;
      if (liveryCanvas) { drawLivery(liveryCanvas, liv); liveryTex.needsUpdate = true; }
      else mPaint.color.set(liv.c1);
      // race suit sleeves: the team colour, toned down (a very light livery gets its second colour)
      mSuit.color.set(lum(liv.c1) > 0.8 ? shade(liv.c2, 0.7) : shade(liv.c1, 0.5));
    }
    var compoundDrawn = '';
    function paintTyres(compound) {
      if (compound === compoundDrawn) return;
      compoundDrawn = compound;
      if (!tyreC) return;
      drawTyre(tyreC, compound, false); tyreTex.needsUpdate = true;
      drawTyre(tyreBlurC, compound, true); tyreBlurTex.needsUpdate = true;
    }

    // ---- car / sources ----
    var drive = { gearKmh: REF_DRIVE.gearKmh, topKmh: REF_DRIVE.topKmh, rpmIdle: REF_DRIVE.rpmIdle, rpmShift: REF_DRIVE.rpmShift, rpmMax: REF_DRIVE.rpmMax, ers: true };
    var sources = { car: null, lap: null };
    var carKey = '';

    // spec: CarSpec (cockpit style, year, colour, colour2, number, drivetrain); accent: the player's own colour
    function setCar(spec, accent) {
      spec = spec && typeof spec === 'object' ? spec : {};
      var year = typeof spec.year === 'number' && isFinite(spec.year) ? Math.round(spec.year) : 0;
      var style = spec.cockpit === 'modern' || spec.cockpit === 'halo' || spec.cockpit === 'halo18' ? spec.cockpit
        : (year ? (year < 2018 ? 'modern' : (year < 2022 ? 'halo' : 'halo18')) : 'halo18');
      if (!year) year = DEFAULT_YEAR[style];
      var key = style + '|' + (style === 'modern' ? (year === 2012 || year === 2013 ? 's' : 'n') + (year < 2017 ? 'n' : 'w') : '') + (year < 2014 ? 'c' : 'b');
      var driveKey = [key, spec.rpmShift, spec.rpmIdle, spec.rpmMax, spec.topKmh, String(spec.gearKmh), spec.ers === null].join('|');
      if (key !== carKey) { carKey = key; cur.style = style; build(style, year); }
      cur.year = year;
      liv.c1 = hexOf(spec.colour, DEFAULT_LIVERY.colour);
      liv.c2 = hexOf(spec.colour2, lum(liv.c1) > 0.45 ? '#17181c' : '#e8e8e8');
      liv.acc = hexOf(accent, hexOf(spec.colourTeam, DEFAULT_LIVERY.accent));
      var num = spec.number != null ? spec.number : (spec.num != null ? spec.num : spec.carNumber);
      if (num == null || !/^\d{1,3}$/.test(String(num))) {
        var h = 0, id = String(spec.id || spec.team || '');
        for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
        num = id ? 2 + h % 98 : 7;
      }
      liv.num = String(num);
      liv.nose = style === 'modern' && (year === 2012 || year === 2013) ? 'stepped' : style;
      paintLivery();
      drive.gearKmh = Array.isArray(spec.gearKmh) && spec.gearKmh.length ? spec.gearKmh : REF_DRIVE.gearKmh;
      drive.topKmh = spec.topKmh > 0 ? spec.topKmh : REF_DRIVE.topKmh;
      drive.rpmIdle = spec.rpmIdle > 0 ? spec.rpmIdle : REF_DRIVE.rpmIdle;
      drive.rpmShift = spec.rpmShift > 0 ? spec.rpmShift : REF_DRIVE.rpmShift;
      drive.rpmMax = spec.rpmMax > 0 ? spec.rpmMax : Math.max(drive.rpmShift, REF_DRIVE.rpmMax);
      drive.ers = spec.ers !== null;
      if (driveKey !== drive.key) { drive.key = driveKey; dispKey = ''; gearHeld = 0; }   // redraw the display with the new car
    }
    // Optional live sources for the wheel display / tyres: {car: the F1.createCar() object (spec, tyres),
    // lap: the F1.createLapCounter() object (lap time and delta)}. Kept by reference; either may be null.
    function setSources(src) {
      src = src || {};
      sources.car = src.car || null;
      sources.lap = src.lap || null;
      refLap = null; curLap = null; lapN = -1; lapT = 0;
    }

    // ---- camera rig ----
    var fovBase = FOV_DEFAULT;      // the FOV setting (deg at a standstill)
    var shift = 0;                  // the framing lens shift in the projection now (share of the picture's height, + = up)
    // The cockpit's projection: camera.fov plus the framing shift (FRAME_TAN). v5's FOV at the same speed is
    // camera.fov * FOV_MIN / fovBase; the point FRAME_TAN below the line of sight is drawn as high as v5 drew it. The
    // shift goes into the projection matrix only (no camera.view), so it is rebuilt by update() every frame while there
    // is one: an outside camera.updateProjectionMatrix() (main.js on a resize; a test harness borrowing the camera for an
    // overview) gets a plain centred projection.
    function project() {
      camera.updateProjectionMatrix();
      var s = 0;
      if (fovBase !== FOV_MIN) {
        var ref = camera.fov * FOV_MIN / fovBase;
        s = FRAME_TAN / 2 * (1 / Math.tan(camera.fov * DEG / 2) - 1 / Math.tan(ref * DEG / 2));
        if (!isFinite(s)) s = 0;
      }
      if (s !== 0) {                // the frustum's top and bottom both move down by 2 s of its half height
        camera.projectionMatrix.elements[9] -= 2 * s;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
      shift = s;
    }
    camera.near = Math.min(camera.near, 0.06);
    camera.fov = FOV_DEFAULT;
    project();
    camera.position.set(0, EYE_Y, EYE_Z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(0, Math.PI, 0);                  // look along local +Z
    group.add(camera);

    // ---- live mirrors ----
    // glass k's rear-view camera: at the glass, looking along the eye's line of sight reflected by the glass (straight
    // back), levelled to MIRROR_PITCH; aspect: the glass's
    function placeMirrorCamera(k, gm, aspect) {
      var cam = mirror.cams[k], c = mirror.centre[k].setFromMatrixPosition(gm);
      var n = new THREE.Vector3(0, 0, -1).transformDirection(gm);
      var d = c.clone().sub(new THREE.Vector3(0, EYE_Y, EYE_Z)).normalize();
      d.addScaledVector(n, -2 * d.dot(n));
      var yaw = Math.atan2(d.x, d.z), cp = Math.cos(MIRROR_PITCH);
      var dir = new THREE.Vector3(Math.sin(yaw) * cp, Math.sin(MIRROR_PITCH), Math.cos(yaw) * cp);
      cam.position.copy(c);
      cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(c, dir.add(c), new THREE.Vector3(0, 1, 0)));
      cam.aspect = aspect;
      cam.fov = 2 * Math.atan(Math.tan(MIRROR_HFOV / 2) / aspect) / DEG;
      cam.updateProjectionMatrix();
    }
    function mirrorTarget() {
      var rt = new THREE.WebGLRenderTarget(MIRROR_W, MIRROR_H, { depthBuffer: true, stencilBuffer: false });
      rt.texture.name = 'mirror-view';
      rt.texture.generateMipmaps = false;
      rt.texture.minFilter = THREE.LinearFilter;
      return rt;
    }
    // Live mirrors on (default) or off (false / 0: the environment-mapped glass, no extra pass). -> the state
    function setMirrors(on) {
      on = on !== false && on !== 0 && typeof THREE.WebGLRenderTarget === 'function';
      if (on && !mirror.rt) {
        mirror.rt = mirrorTarget();
        mMirrorLive.map = mirror.rt.texture; mMirrorLive.needsUpdate = true;
        mirror.done[0] = mirror.done[1] = false;
      } else if (!on && mirror.rt) {
        mirror.rt.dispose(); mirror.rt = null;
        mMirrorLive.map = null; mMirrorLive.needsUpdate = true;
      }
      mirror.on = on;
      bodyMeshes.mirror.material = on ? mMirrorLive : mMirror;
      return on;
    }
    // one glass's half of the target, drawn with its camera
    function renderMirror(renderer, scene, k) {
      // of our own car only the painted bodywork (the sidepod and the flank at the glass's inner edge): the carbon and
      // the dark trim would add the halo's legs and the headrest, which a real mirror does not catch
      var rt = mirror.rt, kids = scene.children, hidden = [bodyMeshes.mirror, bodyMeshes.carbon, bodyMeshes.matte], i, j, o, c;
      for (i = 0; i < kids.length; i++) {
        o = kids[i];
        if (!o.visible || o === group) continue;
        if (o.userData.mirror === false || MIRROR_SKIP.test(o.name)) { hidden.push(o); continue; }
        for (j = 0; j < o.children.length; j++) {
          c = o.children[j];
          if (c.visible && (c.userData.mirror === false || MIRROR_SKIP.test(c.name))) hidden.push(c);
        }
      }
      var was = [];
      for (i = 0; i < hidden.length; i++) { was.push(hidden[i].visible); hidden[i].visible = false; }
      var autoReset = renderer.info.autoReset, target = renderer.getRenderTarget();
      mirror.busy = true;
      renderer.info.autoReset = false;          // the frame's statistics count the pass too
      rt.viewport.set(k * MIRROR_W / 2, 0, MIRROR_W / 2, MIRROR_H);
      rt.scissor.copy(rt.viewport);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      try {
        renderer.render(scene, mirror.cams[k]);
      } finally {
        renderer.setRenderTarget(target);
        renderer.info.autoReset = autoReset;
        for (i = 0; i < hidden.length; i++) hidden[i].visible = was[i];
        mirror.busy = false;
      }
      mirror.done[k] = true;
      mirror.passes++;
    }
    var mirFrustum = new THREE.Frustum(), mirMat = new THREE.Matrix4(), mirSphere = new THREE.Sphere(new THREE.Vector3(), 0.16);
    function mirrorOnScreen(k) {
      mirSphere.center.copy(mirror.centre[k]).applyMatrix4(group.matrixWorld);
      return mirFrustum.intersectsSphere(mirSphere);
    }
    // the main render is about to draw the glasses: refresh the one whose turn it is (the other one if the camera
    // does not see it; both the first time)
    bodyMeshes.mirror.onBeforeRender = function (renderer, scene, camera) {
      if (!mirror.on || mirror.busy || !mirror.rt || !scene || scene.isScene !== true || renderer.getRenderTarget() === mirror.rt) return;
      mirMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      mirFrustum.setFromProjectionMatrix(mirMat);
      var k = mirror.next;
      if (!mirrorOnScreen(k)) { k = 1 - k; if (!mirrorOnScreen(k)) return; }
      mirror.next = 1 - k;
      renderMirror(renderer, scene, k);
      if (!mirror.done[1 - k]) renderMirror(renderer, scene, 1 - k);
    };

    // ---- animation state ----
    var lastHeading = null, latG = 0, shake = 0, time = 0, fov = FOV_DEFAULT, wheelAngle = 0, vibPhase = 0;
    var headRoll = 0, headPitch = 0, comp = 0;   // v6.2: the roll / pitch the head follows (smoothed, rad), compression (g)
    // head look: target (from setLook) and the smoothed value + its rate, in radians
    var lookYawT = 0, lookPitchT = 0, lookYaw = 0, lookPitch = 0, lookYawV = 0, lookPitchV = 0;
    // display
    var dispKey = '', dispT = -1, displayDraws = 0, gearHeld = 0, dispState = { gear: 'N', kmh: 0, leds: 0, shift: false, flash: false, battery: -1, deploy: false,
      harvest: false, limiter: false, lap: '', lapCol: '', lapLabel: '', comp: '' };
    // lap delta: the time at every sample of the lap counter's best lap (recorded while driving)
    var refLap = null, curLap = null, lapN = -1, lapT = 0;

    // Where the driver looks, NORMALISED: x, y in -1..1 (x: +1 = full LEFT, y: +1 = full UP), i.e. the
    // right stick as reported by F1.gamepad (state.lookX, state.lookY). Out-of-range values are clamped;
    // the angles come from F1.COCKPIT_LOOK. The value is kept until the next call, so call it every
    // frame (0, 0 = straight ahead); the view follows smoothly in update().
    function setLook(x, y) {
      x = x > 1 ? 1 : (x < -1 ? -1 : (x === x ? +x || 0 : 0));
      y = y > 1 ? 1 : (y < -1 ? -1 : (y === y ? +y || 0 : 0));
      lookYawT = x * LOOK_MAX_YAW;
      lookPitchT = y > 0 ? y * LOOK_MAX_PITCH_UP : y * LOOK_MAX_PITCH_DOWN;
    }
    // Snap the view straight ahead at once (no easing), e.g. after a reset or on right-stick click.
    function centreLook() {
      lookYawT = lookPitchT = lookYaw = lookPitch = lookYawV = lookPitchV = 0;
    }
    // The FOV setting: the vertical field of view at a standstill in degrees (the 設定 tab), clamped to
    // F1.COCKPIT_FOV.min..max (50..75); a numeric string is taken, anything else not a finite number gives the default
    // (60). The speed widening scales with it. Applied at once (no easing). -> the value now in use
    function setFov(deg) {
      var v = typeof deg === 'number' ? deg : (typeof deg === 'string' && deg.trim() ? +deg : NaN);
      v = isFinite(v) ? (v < FOV_SET_MIN ? FOV_SET_MIN : (v > FOV_SET_MAX ? FOV_SET_MAX : v)) : FOV_DEFAULT;
      if (v !== fovBase) {
        fov = fov * v / fovBase;    // keeps the share of the speed widening the view has right now
        fovBase = v;
        camera.fov = fov;
        project();
      }
      return v;
    }
    // critically damped spring towards the target (exact for any dt, never overshoots)
    function followLook(dt) {
      if (!(dt > 0)) return;
      var w = 2 / LOOK_SMOOTH, e = Math.exp(-w * dt), d, tmp;
      d = lookYaw - lookYawT; tmp = (lookYawV + w * d) * dt;
      lookYawV = (lookYawV - w * tmp) * e; lookYaw = lookYawT + (d + tmp) * e;
      d = lookPitch - lookPitchT; tmp = (lookPitchV + w * d) * dt;
      lookPitchV = (lookPitchV - w * tmp) * e; lookPitch = lookPitchT + (d + tmp) * e;
      if (lookYawT === 0 && Math.abs(lookYaw) < 1e-5 && Math.abs(lookYawV) < 1e-4) lookYaw = lookYawV = 0;
      if (lookPitchT === 0 && Math.abs(lookPitch) < 1e-5 && Math.abs(lookPitchV) < 1e-4) lookPitch = lookPitchV = 0;
    }

    function num(v) { return typeof v === 'number' && v === v; }
    function fin(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
    function tyreState(state) {
      var t = state.tyres || (sources.car && sources.car.tyres) || null;
      if (t && t.state && typeof t.state === 'object') t = t.state;
      return t && typeof t === 'object' ? t : null;
    }
    function fmtTime(t) {
      var m = Math.floor(t / 60), s = t - m * 60;
      return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
    }

    // wheel display: values from the state (v6 fields) or derived from the speed; redrawn at <= 15 Hz on change
    function updateDisplay(state, av, tys) {
      var kmh = av * 3.6, d = dispState, gk = drive.gearKmh, g, rpm;
      var spec = sources.car && sources.car.spec;
      var rpmShift = num(state.rpmShift) ? state.rpmShift : (spec && spec.rpmShift > 0 ? spec.rpmShift : drive.rpmShift);
      var rpmIdle = spec && spec.rpmIdle > 0 ? spec.rpmIdle : drive.rpmIdle;
      if (num(state.gear)) g = state.gear;
      else {
        // derived: the drivetrain formula of the contract (upshift at gearKmh, downshift 8 km/h lower)
        if ((state.speed || 0) < -0.5) g = -1;
        else if (av < 0.5) g = 0;
        else {
          g = gearHeld < 1 ? 1 : gearHeld;
          while (g <= gk.length && kmh >= gk[g - 1]) g++;
          while (g > 1 && kmh < gk[g - 2] - 8) g--;
        }
        gearHeld = g;
      }
      if (num(state.rpm)) rpm = state.rpm;
      else if (g > 0) rpm = Math.max(rpmIdle, Math.min(drive.rpmMax, rpmShift * kmh / (g <= gk.length ? gk[g - 1] : drive.topKmh)));
      else rpm = rpmIdle;
      var lo = rpmShift * 0.85;
      d.gear = g < 0 ? 'R' : (g === 0 ? 'N' : String(g));
      d.kmh = Math.round(kmh);
      d.shift = rpm >= rpmShift - 1 && g > 0;
      d.leds = rpm <= lo ? 0 : Math.min(15, Math.ceil((rpm - lo) / (rpmShift - lo) * 15));
      d.limiter = state.limiter === true;
      d.flash = Math.floor(time * 8) % 2 === 0;
      var ers = spec ? spec.ers !== null : drive.ers;
      d.battery = num(state.battery) ? (ers ? Math.max(0, Math.min(1, state.battery)) : -1) : (ers ? 1 : -1);
      d.deploy = (state.deploy || 0) > 0.05;
      d.harvest = !d.deploy && (state.harvest || 0) > 0.05;
      d.comp = tys && COMPOUND[tys.compound] ? tys.compound : '';
      // lap: delta to the best lap (recorded here per sample), else the running lap time
      d.lap = ''; d.lapCol = ''; d.lapLabel = '';
      var lap = sources.lap, lt = num(state.lapTime) ? state.lapTime : (lap && lap.started ? lap.time : null);
      if (num(state.lapDelta)) { d.lap = (state.lapDelta >= 0 ? '+' : '-') + Math.abs(state.lapDelta).toFixed(2); d.lapCol = state.lapDelta > 0 ? '#ff4040' : '#35e06a'; d.lapLabel = 'DELTA'; }
      else if (lap && lap.started && num(lap.time) && num(state.sampleIndex)) {
        if (lap.n !== lapN || lap.time < lapT - 1e-6) {   // a lap was completed, or the timing restarted
          // the reference is the counter's own best lap: a new track brings a new counter, lap.reset() (qualifying
          // start) clears its best, so a best lap of another track or session never gates it
          if (curLap && num(lap.last) && lapN >= 0 && lap.n === lapN + 1 && (!num(lap.best) || lap.last <= lap.best + 1e-6) && !lap.void) refLap = curLap;
          else if (!num(lap.best)) refLap = null;
          curLap = {}; lapN = lap.n;
        }
        lapT = lap.time;
        if (curLap && curLap[state.sampleIndex] === undefined) curLap[state.sampleIndex] = lap.time;
        var ref = refLap && refLap[state.sampleIndex];
        if (num(ref) && lap.time > 1) {
          var dl = lap.time - ref;
          d.lap = (dl >= 0 ? '+' : '-') + Math.abs(dl).toFixed(2); d.lapCol = dl > 0 ? '#ff4040' : '#35e06a'; d.lapLabel = 'DELTA';
        } else { d.lap = fmtTime(lap.time); d.lapLabel = 'LAP'; }
      } else if (num(lt)) { d.lap = fmtTime(lt); d.lapLabel = 'LAP'; }
      if (!displayC) return;
      var key = d.gear + '|' + d.kmh + '|' + d.leds + '|' + d.shift + '|' + (d.shift || d.limiter ? d.flash : '') + '|' + Math.round(d.battery * 100) + '|' + d.deploy + d.harvest +
        '|' + d.limiter + '|' + d.lap + '|' + d.comp;
      if (key === dispKey || (time - dispT < DISPLAY_DT && dispT >= 0)) return;
      dispKey = key; dispT = time; displayDraws++;
      drawDisplay(displayC, d, cur.classic);
      displayTex.needsUpdate = true;
    }

    // tread darkens with wear (vertex colours of the tread band)
    function updateWear(w, wear) {
      var q = Math.round(Math.max(0, Math.min(1, wear)) * 50) / 50;
      if (q === w.wear) return;
      w.wear = q;
      var geo = w.tyre.geometry, uv = geo.attributes.uv, col = geo.attributes.color;
      if (!uv || !col) return;
      var k = 1 - 0.5 * q;
      for (var i = 0; i < uv.count; i++) {
        var v = uv.getY(i), c = v > 0.44 && v < 0.56 ? k : (v > 0.41 && v < 0.59 ? 1 - 0.3 * q : 1);
        col.setXYZ(i, c, c, c);
      }
      col.needsUpdate = true;
    }

    var tmpV = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
    function update(state, dt) {
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      time += dt;
      var speed = state.speed || 0, av = Math.abs(speed), steer = state.steer || 0;

      // yaw about world Y, then pitch about the car's lateral (X) axis, then roll about its forward (Z)
      // axis. Local +X is the driver's LEFT, so +rotation.x would tip the nose DOWN (hence -pitch) and
      // +rotation.z lifts the left side (same sign as roll / bank).
      group.position.set(state.x, state.y || 0, state.z);
      group.rotation.set(-(state.pitch || 0), state.heading, state.roll || 0);

      // steering wheel (+steer = left = top of the wheel moves toward +X) and front wheels
      hand.rotation.z = -steer * HANDWHEEL_VIS;
      wheelAngle = (wheelAngle + speed / cur.R * dt) % (Math.PI * 2);
      var tys = tyreState(state), blur = av > BLUR_SPEED;
      paintTyres(tys && COMPOUND[tys.compound] ? tys.compound : 'M');
      for (var w = 0; w < 2; w++) {
        var wh = wheels[w];
        wh.pivot.rotation.y = steer * WHEEL_STEER_VIS;
        wh.spin.rotation.x = wh.side > 0 ? wheelAngle : -wheelAngle;
        wh.tyre.material = blur ? mTyreBlur : mTyre;
        updateWear(wh, tys && tys.wear ? +tys.wear[w] || 0 : 0);
      }
      // forearms: from the elbows to the gloves on the grips
      column.updateMatrix(); hand.updateMatrix();
      for (var a = 0; a < 2; a++) {
        var gv = gloveAt[a].set(a ? -0.125 : 0.125, -0.05, 0.008).applyMatrix4(hand.matrix).applyMatrix4(column.matrix);
        tmpV.subVectors(gv, ELBOW[a]);
        var len = tmpV.length();
        arms[a].position.addVectors(gv, ELBOW[a]).multiplyScalar(0.5);
        arms[a].quaternion.setFromUnitVectors(UPV, tmpV.multiplyScalar(1 / len));
        arms[a].scale.set(1, len, 1);
      }
      updateDisplay(state, av, tys);

      // FOV widens gently with speed (by the same share of the setting as v5's 70 -> 82)
      var t = Math.min(1, av / V_TOP);
      var widen = fovBase * (FOV_MAX - FOV_MIN) / FOV_MIN;
      var target = fovBase + widen * t * t * (3 - 2 * t);
      fov += (target - fov) * Math.min(1, dt * 3);
      if (Math.abs(fov - camera.fov) > 0.02) {
        camera.fov = fov;
        project();
      } else if (fovBase !== FOV_MIN) project();     // the framing shift, kept in place every frame (see project)

      // lateral g estimate from yaw rate (positive = turning left), smoothed
      var yawRate = 0;
      if (lastHeading !== null && dt > 0) {
        var dh = state.heading - lastHeading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        yawRate = dh / dt;
      }
      lastHeading = state.heading;
      var g = Math.max(-5, Math.min(5, speed * yawRate / 9.81));
      latG += (g - latG) * Math.min(1, dt * 5);

      // shake: wall hits (decaying) + grass rumble + a whisper of high-speed buzz + tyre vibration
      if (state.hit > shake) shake = state.hit;
      shake *= Math.exp(-5 * dt);
      if (shake < 0.002) shake = 0;
      var rumble = state.onGrass ? Math.min(1, av / 25) : 0;
      var buzz = Math.min(1, av / V_TOP);
      var ox = 0, oy = 0, rx = 0, rz = 0;
      if (shake > 0) {
        ox += (Math.random() - 0.5) * 0.05 * shake;
        oy += (Math.random() - 0.5) * 0.05 * shake;
        rx += (Math.random() - 0.5) * 0.030 * shake;
        rz += (Math.random() - 0.5) * 0.040 * shake;
      }
      if (rumble > 0) {
        oy += (Math.sin(time * 61) * 0.6 + Math.sin(time * 37 + 1.3) * 0.4) * 0.010 * rumble;
        ox += Math.sin(time * 47 + 0.7) * 0.004 * rumble;
        rz += Math.sin(time * 29) * 0.004 * rumble;
      }
      oy += Math.sin(time * 83) * 0.0012 * buzz * buzz;
      // flat spots / a puncture (state.vib 0..1): a thump once per wheel turn, capped so it does not alias at speed
      var vib = num(state.vib) ? Math.max(0, Math.min(1, state.vib)) : 0;
      if (vib > 0 && av > 0.5) {
        var hz = Math.min(18, av / (2 * Math.PI * cur.R));
        vibPhase = (vibPhase + 2 * Math.PI * hz * dt) % (Math.PI * 2);
        var amp = vib * Math.min(1, av / 12);
        oy += (Math.sin(vibPhase) + 0.35 * Math.sin(2 * vibPhase + 0.4)) * 0.0045 * amp;
        rz += Math.sin(vibPhase + 1.1) * 0.0035 * amp;
        rx += Math.sin(vibPhase + 2.0) * 0.0015 * amp;
      }

      // head look, on top of the pose / shake / lean. The cockpit model stays put; only the camera turns
      // (order YXZ: yaw about the car's up axis, then pitch about the turned lateral axis). The helmet
      // does the first LOOK_HEAD_YAW of the yaw about the neck, which carries the eyes sideways a bit.
      followLook(dt);
      var headYaw = lookYaw * (LOOK_HEAD_YAW / LOOK_MAX_YAW);
      var hx = LOOK_NECK * Math.sin(headYaw), hz = LOOK_NECK * (Math.cos(headYaw) - 1);

      // road shape (v6.2, see HEAD_ROLL_KEEP): the roll / pitch the head follows and the compression, smoothed (dt 0:
      // at once, as after a track load); the counter-rotations about the car's forward / lateral axes
      var kR = dt > 0 ? 1 - Math.exp(-dt / HEAD_ROLL_TAU) : 1, kP = dt > 0 ? 1 - Math.exp(-dt / HEAD_PITCH_TAU) : 1;
      var kC = dt > 0 ? 1 - Math.exp(-dt / COMPRESS_TAU) : 1;
      headRoll += (fin(state.roll) - headRoll) * kR;
      headPitch += (fin(state.pitch) - headPitch) * kP;
      var cg = num(state.compress) ? state.compress : (num(state.seatG) ? state.seatG - 1 : 0);
      cg = cg > COMPRESS_MIN ? (cg < COMPRESS_MAX ? cg : COMPRESS_MAX) : COMPRESS_MIN;
      comp += (cg - comp) * kC;
      var hr = HEAD_ROLL_KEEP * headRoll, hp = HEAD_PITCH_KEEP * headPitch, ly = Math.sin(lookYaw), lc = Math.cos(lookYaw);

      // head leans slightly into the corner
      camera.position.set(latG * 0.006 + ox + hx, EYE_Y + oy - COMPRESS_EYE * comp, EYE_Z + hz);
      camera.rotation.set(rx + lookPitch - COMPRESS_NOD * comp - hr * ly - hp * lc, Math.PI + lookYaw,
        latG * 0.005 + rz + hr * lc - hp * ly);
    }

    // Everything the cockpit created (call when the cockpit is thrown away; the camera is left alone).
    function dispose() {
      group.traverse(function (o) { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      armGeo.dispose();
      for (var i = 0; i < materials.length; i++) materials[i].dispose();
      [liveryTex, carbonTex, shadowTex, tyreTex, tyreBlurTex, displayTex, envTex].forEach(function (t) { if (t) t.dispose(); });
      if (mirror.rt) { mirror.rt.dispose(); mirror.rt = null; }
      mirror.on = false;
    }

    // what is built (tests / debugging): style, year, wheel kind, rim size, halo, triangles, draw calls, mirrors, the FOV
    // (setting and the current value, deg; shift: the framing lens shift, share of the height), the head's road-shape
    // counter-roll / counter-pitch (rad) and compression (g)
    function info() {
      var tris = 0, draws = 0;
      group.traverse(function (o) {
        if (!o.isMesh || !o.visible || !o.geometry || !o.geometry.attributes.position) return;
        draws++;
        tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      });
      return { style: cur.style, year: cur.year, wheel: cur.classic ? 'classic' : 'big', rim: cur.style === 'halo18' ? 18 : 13,
               halo: cur.style !== 'modern', tyreWidth: cur.W, triangles: Math.round(tris), drawCalls: draws,
               livery: { colour: liv.c1, colour2: liv.c2, accent: liv.acc, number: liv.num }, displayDraws: displayDraws,
               mirrors: { live: mirror.on, passes: mirror.passes, size: [MIRROR_W, MIRROR_H], hfov: MIRROR_HFOV / DEG },
               fov: { setting: fovBase, now: camera.fov, shift: shift },
               head: { roll: HEAD_ROLL_KEEP * headRoll, pitch: HEAD_PITCH_KEEP * headPitch, compress: comp } };
    }

    setCar(null, null);                                // default: 2022-on car in the default colours
    paintTyres('M');
    setMirrors(true);
    return { group: group, update: update, setLook: setLook, centreLook: centreLook, setCar: setCar, setSources: setSources,
             setMirrors: setMirrors, setFov: setFov, dispose: dispose, info: info };
  };
})(typeof window !== 'undefined' ? window : globalThis);
