// js/tunnels.js — covered stretches of a circuit (Monaco's tunnel under the Fairmont hotel, the Portier underpass), built
// in code from the track samples. Classic script on window.F1; THREE r149 global. Data: F1.TUNNEL_DATA below (a copy of
// tools/tunnels.json's "tracks", where the sources are; devtests/tunnel-test/make-data.js --check keeps the two equal).
// No asset files: the two small canvas textures are drawn here (in node there are none: vertex colours only).
//
//   var tun = F1.buildTunnels(track, trackData, tunnelData?)   // tunnelData: the list for this track (default
//                                                                // F1.TUNNEL_DATA[trackData.id]); [] or none -> empty group
//   tun.group             THREE.Group (add it to the scene; empty when the track has no covered stretch)
//   tun.inTunnel(i)       0..1 at sample i: 0 outside, 1 deep inside, smooth over the first / last RAMP_IN (30) m
//                         (a 22 m underpass peaks at ~0.2). For the sound: reverb / reflections (see the report).
//   tun.lightAt(i)        daylight reaching sample i: 1 outside, LIGHT_IN (0.3) deep inside, LIGHT_OPEN (0.5) beside the
//                         openings to the sea, smooth over RAMP_LIGHT (40) m at the portals
//   tun.sceneLight(i, k)  factor for main.js's scene lights while the CAMERA is at sample i: k = 'hemi' (hemisphere
//                         light, ~0.8 deep inside) or 'sun' (directional light, 0 inside). The eye adapts: the scene
//                         is dimmed to lightAt^0.4, not to lightAt. 1 outside.
//   tun.covered(i)        bool: sample i lies between the portals of a covered stretch
//   tun.update(t, viewIndex, sceneScaled)   once per frame before rendering. viewIndex: the sample the camera is at
//                         (car.state.sampleIndex in the cockpit; null / undefined = a camera outside every tunnel).
//                         Sets the view-dependent parts (allocation-free): interior exposure, the road shade, the glare
//                         in the portals / openings seen from inside. sceneScaled (default true): main.js scales its
//                         lights with sceneLight(); pass false if it does not (the road shade then stays on inside).
//   tun.tunnels           [{name, kind, from, to, length, sFrom, sTo, width, height, open: [{side, from, to}]}]
//                         (sample indices / metres; width wall to wall, height road to soffit)
//   tun.stats             {tunnels, triangles, drawCalls, ms}
//   tun.dispose()
//   F1.tunnelImpulse(sampleRate, {width, height, rt60, seconds}) -> {sampleRate, left, right}: an impulse response for
//                         a ConvolverNode (tunnel reverb in js/audio.js), see below
//
// What is built (per stretch, everything merged into 4 meshes for the whole track):
//   interior (unlit, baked light; one exposure uniform): side walls just behind the track's barriers (js/track.js
//     wallPosDist / wallNegDist + WALL_GAP: the barrier stays the thing the car hits, the tunnel wall never stands in
//     front of it and only stands where the track has a barrier), a chamfer, a flat soffit H_CEIL above the road following
//     its grade, two rows of ceiling light fixtures (four in the threshold zones), advertising boards right above the
//     barrier, all lit brighter towards the portals and the openings. On a side with `open` data (Monaco: the sea side
//     under the hotel, "partly open on one side along the shoreline") the wall is a colonnade: piers, a parapet up to
//     OPEN_SILL, openings up to OPEN_HEAD, reveals.
//   exterior (lit like the scenery): roof slab, the block over the road up to the height of the mapped building(s) that
//     cover it (F1_SCENERY footprints: js/scenery.js leaves a footprint that spans the road out, so this block stands in
//     for its middle and the "wings" for the rest of it beside the block, out along the normals while inside the
//     footprint, at most WING_MAX, clear of every other part of the corridor, never on an open side), the portal facades
//     (hotel windows or plain concrete, per portal, as wide as the wings), the sides (the entry portal's facade up to
//     `split`, the exit's after it), the colonnade's outer face.
//   shade (custom blend, dst * (1 - k * darkness)): darkens the road, runoff and barriers inside as seen from OUTSIDE (a
//     dark hole); update() fades it out as the camera goes in, where main.js's dimmed lights do that job instead.
//   glare (additive): the daylight in the portal openings and the sea openings as seen from inside (eye adaptation).
(function (global) {
  'use strict';
  var F1 = global.F1 = global.F1 || {};

  // Covered stretches per track id, in racing order: from = entry portal, to = exit portal ([lat, lon] on the circuit,
  // mapped to the nearest sample through trackData.geo; f* = the same points as fractions of the lap: the fallback
  // without geo and the search window for the nearest sample). facade: 'hotel' | 'plain' or [entry, exit]; split: where
  // the block's side facades change from the entry's to the exit's; open: openings in one side wall ([side] +1 = the
  // driver's left); ads: 'monaco' | 'none' | (default) neutral boards; ceil / deck: soffit / structure top over the road
  // (default 6.8 m / the covering building); wings: false = none. Generated from tools/tunnels.json (sources there).
  F1.TUNNEL_DATA = F1.TUNNEL_DATA || {
    'it-1922': [
      { name: 'Sopraelevata underpass', kind: 'underpass', facade: 'plain', ads: 'none',
        from: [45.624834, 9.289355], to: [45.624692, 9.289124], fFrom: 0.56692, fTo: 0.57106 }
    ],
    'mc-1929': [
      { name: 'Portier', kind: 'underpass', facade: 'plain', ads: 'monaco',
        from: [43.741073, 7.430032], to: [43.741088, 7.430246], fFrom: 0.42636, fTo: 0.4316 },
      { name: 'Tunnel', kind: 'tunnel', facade: ['hotel', 'plain'], ads: 'monaco',
        from: [43.740359, 7.430326], to: [43.737778, 7.427973], fFrom: 0.45721, fTo: 0.56752,
        split: [43.73859, 7.429497], fSplit: 0.52074,
        open: [{ side: 1, from: [43.740365, 7.430331], to: [43.738704, 7.429618], fFrom: 0.45699, fTo: 0.51593 }] }
    ],
    'es-2026': [
      { name: 'Tunnel 1 (under the motorway)', kind: 'tunnel', facade: 'plain',
        from: [40.472201, -3.624061], to: [40.472797, -3.624293], fFrom: 0.25146, fTo: 0.26412 },
      { name: 'Tunnel 2 (under the motorway)', kind: 'tunnel', facade: 'plain',
        from: [40.472714, -3.618774], to: [40.471681, -3.617988], fFrom: 0.70592, fTo: 0.73043 }
    ],
    'sg-2008': [
      { name: 'Raffles Boulevard link', kind: 'underpass', facade: 'plain', ceil: 4.5, deck: 6, wings: false,
        from: [1.291445, 103.859372], to: [1.291459, 103.859171], fFrom: 0.25105, fTo: 0.25563 },
      { name: 'Raffles Boulevard passage', kind: 'underpass', facade: 'plain', ceil: 5,
        from: [1.29177, 103.858258], to: [1.291982, 103.85789], fFrom: 0.27771, fTo: 0.28729 }
    ],
    'ae-2009': [
      { name: 'W hotel bridge', kind: 'underpass', facade: 'plain', ceil: 9, deck: 18, wings: false,
        from: [24.467333, 54.606494], to: [24.467586, 54.60648], fFrom: 0.8352, fTo: 0.8405 }
    ]
  };

  var H_CEIL = 6.8;        // soffit above the centreline road surface (m); js/scenery.js keeps spans >= 6.5 m (GANTRY_CLEAR_H)
  var CHAMFER = 0.7;       // 45-degree haunch between wall and soffit
  var SLAB = 1.2;          // roof slab above the soffit
  var WALL_GAP = 0.52;     // tunnel wall face this far behind the barrier's inner face (js/track.js WALL_THICK 0.5 + 2 cm)
  var WALL_SINK = 0.8;     // walls reach this far below the surface (no cracks against the runoff / skirt)
  var OUT_T = 1.1;         // block side this far beyond the tunnel wall face (inside js/scenery.js's corridor + CLEAR)
  var WING = 3.5;          // portal facade reaches this far beyond the block side
  var RAMP_IN = 30;        // inTunnel: 0 -> 1 over the first / last 30 m inside
  var RAMP_LIGHT = 40;     // daylight reaches this far in
  var LIGHT_IN = 0.3;      // lightAt deep inside
  var LIGHT_OPEN = 0.5;    // lightAt beside the openings
  var ADAPT = 0.6;         // eye adaptation: exposure ~ lightAt^-ADAPT (the scene is dimmed to lightAt^(1 - ADAPT))
  var HEMI_COMP = 0.35;    // the hemisphere light takes over part of the sun's share inside (diffuse fixture light)
  var BARRIER_H = 1.2;     // js/track.js WALL_H
  var FIX_ROWS = [-3.6, 3.6], FIX_ROWS_THR = [-7.6, 7.6];   // fixture rows (lateral offsets); extra rows in the threshold zones
  var FIX_PITCH = 4.5, FIX_LEN = 2.6, FIX_W = 0.42, FIX_H = 0.14, THRESHOLD = 60;
  var BOARD_Y0 = 1.4, BOARD_Y1 = 2.5, BOARD_SEG = 3;          // ad boards: 3 sample steps (~6 m) each
  var OPEN_SILL = 2.75;    // colonnade: parapet top above the surface at the wall (over the ad boards)
  var OPEN_HEAD = 1.35;    // colonnade: opening top this far under the soffit
  var PIER_W = 1.5, PIER_PITCH = 7.5, OPEN_MARGIN = 8, OPEN_RAMP = 24;
  var VEIL_MAX = 0.9;      // glare strength deep inside
  var MIN_LEN = 12;        // m: shorter stretches are ignored
  var WING_MAX = 45;       // m: the covering building's mass beside the block reaches at most this far beyond it ...
  var WING_CLEAR = 1.6;    // ... and keeps this far from every other part of the corridor (js/scenery.js CLEAR 1.5)

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smootherstep(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
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

  // A tunnel's impulse response for a ConvolverNode (offered to js/audio.js; pure math, node-testable):
  //   F1.tunnelImpulse(sampleRate, {width, height, rt60, seconds}) -> {sampleRate, left, right} (Float32Array each)
  // Early reflections: the flutter between road and soffit (every 2 * height / c) and the two side walls (every width / c,
  // slightly different per ear), then a diffuse tail decaying by 60 dB in rt60 s whose highs die first. Deterministic
  // (seeded noise). Use it with convolver.normalize = true (the default) and a wet gain of ~0.45 * inTunnel.
  F1.tunnelImpulse = function (sampleRate, opts) {
    opts = opts || {};
    var sr = sampleRate > 0 ? sampleRate : 48000, W = opts.width > 0 ? opts.width : 25, H = opts.height > 0 ? opts.height : H_CEIL;
    var rt = opts.rt60 > 0 ? opts.rt60 : 1.4, c = 343, seed = 0x2545f491;
    var len = Math.max(64, Math.round(sr * (opts.seconds > 0 ? opts.seconds : Math.min(3, rt * 1.15))));
    var L = new Float32Array(len), R = new Float32Array(len), k60 = 6.907755 / rt, i, n;
    function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; }
    var onset = Math.round(sr * H / c), lpL = 0, lpR = 0;
    for (i = onset; i < len; i++) {
      var t = i / sr, env = Math.exp(-k60 * t), fc = 600 + 6400 * Math.exp(-1.6 * t), a = Math.exp(-2 * Math.PI * fc / sr);
      lpL = a * lpL + (1 - a) * rnd(); lpR = a * lpR + (1 - a) * rnd();
      var fade = Math.min(1, (i - onset) / (sr * 0.012)), g = env * fade * 2.2;
      L[i] = lpL * g; R[i] = lpR * g;
    }
    function tap(delay, gl, gr) { var j = Math.round(delay * sr); if (j > 0 && j < len) { L[j] += gl; R[j] += gr; } }
    tap(0.0005, 0.9, 0.9);                                                   // direct
    for (n = 1; n <= 10; n++) { var gv = 0.55 * Math.pow(0.78, n); tap(2 * H * n / c, gv, gv); }
    for (n = 1; n <= 5; n++) {
      var gs = 0.5 * Math.pow(0.65, n), d0 = W * n / c;
      tap(d0, gs, gs * 0.6); tap(d0 + 0.0011, gs * 0.6, gs);
    }
    return { sampleRate: sr, left: L, right: R };
  };

  F1.buildTunnels = function (track, trackData, tunnelData) {
    var THREE = global.THREE, t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    var S = track.samples, N = S.length, i;
    var group = new THREE.Group();
    group.name = 'tunnels';
    var inT = new Float32Array(N), light = new Float32Array(N).fill(1), cov = new Uint8Array(N);
    var list = tunnelData !== undefined && tunnelData !== null ? tunnelData :
      (trackData && trackData.id && F1.TUNNEL_DATA ? F1.TUNNEL_DATA[trackData.id] : null);
    if (!Array.isArray(list)) list = [];
    var len = track.length || 0, ds = N ? len / N : 1;
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
    // the mapped building(s) standing over sample idx's road (their footprint holds a point of the road's middle)
    function coveringAt(idx) {
      var s = S[idx], found = [], offs = [-6, 0, 6];
      for (var a = 0; a < sceneB.length; a++) {
        var b = sceneB[a];
        if (s.x < b.x0 - 7 || s.x > b.x1 + 7 || s.z < b.z0 - 7 || s.z > b.z1 + 7) continue;
        for (var o = 0; o < offs.length; o++) {
          if (pointInPoly(s.x + s.nx * offs[o], s.z + s.nz * offs[o], b.p)) { found.push(b); break; }
        }
      }
      return found;
    }

    var inner = new Buf(), outer = new Buf(), shade = new Buf(), veil = new Buf();
    var ranges = [];

    // colours (linear; the game renders without tone mapping). Interior colours are as seen from inside (adapted).
    var C_TILE = [0.88, 0.86, 0.80], C_LOW = [0.30, 0.30, 0.31], C_SOFFIT = [0.36, 0.35, 0.33];
    // (the lenses are > 1: they stay bright under any exposure)
    var C_LENS = [2.2, 2.1, 1.85], C_HOUSING = [0.42, 0.42, 0.44], C_REVEAL = [0.80, 0.79, 0.75];
    var C_CONC = [0.80, 0.79, 0.76], C_ROOF = [0.62, 0.62, 0.63], C_PLAIN = [0.74, 0.73, 0.70], C_PIER = [0.70, 0.69, 0.66];

    for (var ti = 0; ti < list.length; ti++) {
      var td = list[ti];
      if (!td || !N) continue;
      var ia = locateEnd(track, trackData, td.from, td.fFrom), ib = locateEnd(track, trackData, td.to, td.fTo);
      if (ia < 0 || ib < 0) continue;
      var K = wrap(ib - ia);
      if (K < 2 || K > N / 2 || K * ds < MIN_LEN) continue;
      buildOne(td, ia, K, ti);
    }

    function buildOne(td, ia, K, ti) {
      var idx = new Int32Array(K + 1), arc = new Float64Array(K + 1), Ltot, k, q, side;
      for (k = 0; k <= K; k++) {
        idx[k] = wrap(ia + k);
        if (k) arc[k] = arc[k - 1] + Math.hypot(S[idx[k]].x - S[idx[k - 1]].x, S[idx[k]].z - S[idx[k - 1]].z);
      }
      Ltot = arc[K];
      function kOf(ll, f) {           // a data point inside this stretch -> 0..K, or -1
        var j = locateEnd(track, trackData, ll, f);
        if (j < 0) return -1;
        var r = wrap(j - ia);
        return r <= K ? r : -1;
      }
      // ceil: soffit height over the centreline road (OSM min_height / maxheight where known), deck: top of the
      // structure over the road (a bridge: its height) instead of the covering building's top
      var ceil = td.ceil > 0 ? clamp(+td.ceil, 3.5, 20) : H_CEIL, deck = td.deck > 0 ? Math.max(+td.deck, ceil + 0.5) : 0;
      var fac = Array.isArray(td.facade) ? td.facade : [td.facade, td.facade];
      var hotelIn = fac[0] === 'hotel', hotelOut = (fac[1] === undefined ? fac[0] : fac[1]) === 'hotel';
      var kSplit = td.split ? kOf(td.split, td.fSplit) : -1;
      if (kSplit < 0) kSplit = hotelIn === hotelOut ? K + 1 : Math.round(K / 2);
      function hotelAt(k) { return k < kSplit ? hotelIn : hotelOut; }

      // openings: per side, sample range [a, b] (kept OPEN_MARGIN m off the portals)
      var openRanges = [], OPN = new Float64Array(K + 1), isOpen = [new Uint8Array(K + 1), new Uint8Array(K + 1)];
      (td.open || []).forEach(function (o) {
        if (!o || (o.side !== 1 && o.side !== -1)) return;
        var a = kOf(o.from, o.fFrom), b = kOf(o.to, o.fTo);
        if (a < 0 || b < 0 || b <= a) return;
        while (a < K && arc[a] < OPEN_MARGIN) a++;
        while (b > 0 && Ltot - arc[b] < OPEN_MARGIN) b--;
        if (arc[b] - arc[a] < PIER_PITCH + PIER_W) return;
        openRanges.push({ side: o.side, a: a, b: b });
      });

      // per-sample cross-section
      var X = [], Z = [], NX = [], NZ = [], TX = [], TZ = [], YC = [], YR = [], YT = [], EL = [], ER = [], FL = [], FR = [], DAY = [];
      var tops = [], covers = [];
      for (k = 0; k <= K; k++) {
        var s = S[idx[k]];
        X[k] = s.x; Z[k] = s.z; NX[k] = s.nx; NZ[k] = s.nz; TX[k] = s.tx; TZ[k] = s.tz;
        var yc = (isFinite(s.y) ? s.y : 0) + ceil;
        YC[k] = yc; YR[k] = yc + (deck > 0 ? Math.min(SLAB, deck - ceil) : SLAB);
        EL[k] = (isFinite(s.wallPosDist) ? s.wallPosDist : (track.wallDist || 12)) + WALL_GAP;
        ER[k] = (isFinite(s.wallNegDist) ? s.wallNegDist : (track.wallDist || 12)) + WALL_GAP;
        FL[k] = s.wallPos !== false; FR[k] = s.wallNeg !== false;
        var dist = Math.min(arc[k], Ltot - arc[k]);
        DAY[k] = 1 - smootherstep(dist / RAMP_LIGHT);                     // 1 at a portal -> 0 deep inside
        var op = 0;
        for (q = 0; q < openRanges.length; q++) {
          var R = openRanges[q];
          op = Math.max(op, smootherstep(Math.min(arc[k] - arc[R.a], arc[R.b] - arc[k]) / OPEN_RAMP + 0.5));
          if (k >= R.a && k < R.b) isOpen[R.side > 0 ? 1 : 0][k] = 1;
        }
        OPN[k] = op;
        var it = smootherstep(dist / RAMP_IN);
        var lt = Math.max(1 - (1 - LIGHT_IN) * smootherstep(dist / RAMP_LIGHT), LIGHT_IN + (LIGHT_OPEN - LIGHT_IN) * op);
        var ii = idx[k];
        if (k > 0 && k < K) cov[ii] = 1;
        if (it > inT[ii]) inT[ii] = it;
        if (lt < light[ii]) light[ii] = lt;
        covers[k] = coveringAt(ii);
        tops[k] = -Infinity;
        for (q = 0; q < covers[k].length; q++) tops[k] = Math.max(tops[k], bTop(covers[k][q]));
      }
      // block top: the covering building's (or the slab + a parapet); a given deck height wins (a bridge over the road)
      for (k = 0; k <= K; k++) YT[k] = deck > 0 ? YC[k] - ceil + deck : Math.max(YR[k] + 0.6, tops[k]);

      // ---- wings: the rest of the covering building(s) beside the block. js/scenery.js leaves a footprint that spans
      // the road out altogether, so per sample the mass reaches out along the normal while inside such a footprint,
      // at most WING_MAX, clear of every other part of the corridor (+ WING_CLEAR), never on an open side (the sea).
      // WL / WR: outer offset of the mass on the +n / -n side (= the block side where there is no wing).
      var WL = new Float64Array(K + 1), WR = new Float64Array(K + 1);
      var foreign = [];         // every sample outside this stretch that comes near it (the road beyond the portals too)
      (function () {
        var reach = WING_MAX + 40, j, m;
        for (j = 0; j < N; j++) {
          if (wrap(j - ia) <= K) continue;
          for (m = 0; m <= K; m += 3) {
            if (Math.abs(S[j].x - X[m]) < reach && Math.abs(S[j].z - Z[m]) < reach &&
                Math.hypot(S[j].x - X[m], S[j].z - Z[m]) < reach) { foreign.push(j); break; }
          }
        }
      })();
      // a wing point must stay clear of the rest of the corridor, and nearer to its own sample's normal line than to the
      // stretch's other samples (inside a curve the normals meet at its centre: the mass stops short of it)
      function blocked(x, z, k) {
        var f, ex, ez, dd;
        for (f = 0; f < foreign.length; f++) {
          var sj = S[foreign[f]];
          ex = x - sj.x; ez = z - sj.z; dd = ex * ex + ez * ez;
          var lim = Math.max(isFinite(sj.wallPosDist) ? sj.wallPosDist : 12, isFinite(sj.wallNegDist) ? sj.wallNegDist : 12) + 0.5 + WING_CLEAR;
          if (dd < lim * lim) return true;
        }
        ex = x - X[k]; ez = z - Z[k];
        var dk = Math.sqrt(ex * ex + ez * ez);
        for (var m = Math.max(0, k - 12); m <= Math.min(K, k + 12); m++) {
          if (m > k - 2 && m < k + 2) continue;
          ex = x - X[m]; ez = z - Z[m];
          if (Math.sqrt(ex * ex + ez * ez) < dk - 0.75) return true;
        }
        return false;
      }
      for (k = 0; k <= K; k++) {
        for (side = -1; side <= 1; side += 2) {
          var b0 = (side > 0 ? EL[k] : ER[k]) + OUT_T, last = b0, cl = covers[k];
          var openHere = isOpen[side > 0 ? 1 : 0][k] || (k > 0 && isOpen[side > 0 ? 1 : 0][k - 1]);
          if (cl.length && !openHere && td.wings !== false) {
            for (var tt = b0 + 1; tt <= b0 + WING_MAX; tt += 1) {
              var wx = X[k] + NX[k] * side * tt, wz = Z[k] + NZ[k] * side * tt, inside = false;
              for (q = 0; q < cl.length && !inside; q++) inside = pointInPoly(wx, wz, cl[q].p);
              if (!inside || blocked(wx, wz, k)) break;
              last = tt;
            }
          }
          if (last - b0 < 2) last = b0;
          if (side > 0) WL[k] = last; else WR[k] = last;
        }
      }
      function hasWing(k, side) { return side > 0 ? WL[k] > EL[k] + OUT_T + 0.01 : WR[k] > ER[k] + OUT_T + 0.01; }
      var wSum = 0;
      for (k = 0; k <= K; k++) wSum += EL[k] + ER[k];
      ranges.push({ name: td.name || '', kind: td.kind || 'tunnel', from: idx[0], to: idx[K], length: Math.round(Ltot),
        sFrom: Math.round(S[idx[0]].s), sTo: Math.round(S[idx[K]].s),
        width: Math.round(wSum / (K + 1) * 10) / 10, height: ceil,         // wall to wall, road to soffit (for F1.tunnelImpulse)
        open: openRanges.map(function (R) { return { side: R.side, from: idx[R.a], to: idx[R.b] }; }) });

      function P(k, d, y) { return [X[k] + NX[k] * d, y, Z[k] + NZ[k] * d]; }
      function n3(k, sgn) { return [NX[k] * sgn, 0, NZ[k] * sgn]; }
      var UP = [0, 1, 0], DOWN = [0, -1, 0];
      // baked interior light: walls brighter towards the top (the fixtures), towards the portals (daylight) and where the
      // openings let the daylight in
      function bright(k) { return (1 - DAY[k]) * 0.16 * OPN[k]; }
      function wallCol(k, f) { return mulc(C_TILE, (0.50 + 0.12 * f) * (1 - DAY[k]) + 0.95 * DAY[k] + bright(k)); }
      function soffitCol(k) { return mulc(C_SOFFIT, 0.62 * (1 - DAY[k]) + 1.6 * DAY[k] + 1.4 * bright(k)); }

      // ---- side walls between samples k and w (a closed wall; the colonnade side is built below)
      function sideWall(k, w, side) {
        var eu = side > 0 ? EL[k] : ER[k], ew = side > 0 ? EL[w] : ER[w], du = side * eu, dw = side * ew;
        var gu = sY(idx[k], du), gw = sY(idx[w], dw), inward = n3(k, -side);
        var hu = gu + BARRIER_H + 0.15, hw2 = gw + BARRIER_H + 0.15;
        inner.quad(P(k, du, gu - WALL_SINK), P(w, dw, gw - WALL_SINK), P(w, dw, hw2), P(k, du, hu), inward,
          C_LOW, null, null, null, UV_WHITE);
        var tu = YC[k] - CHAMFER, tw = YC[w] - CHAMFER;
        inner.quad(P(k, du, hu), P(w, dw, hw2), P(w, dw, tw), P(k, du, tu), inward,
          wallCol(k, 0), wallCol(w, 0), wallCol(w, 1), wallCol(k, 1), UV_WHITE);
        inner.quad(P(k, du, tu), P(w, dw, tw), P(w, side * (ew - CHAMFER), YC[w]), P(k, side * (eu - CHAMFER), YC[k]),
          [inward[0], -1, inward[2]], mulc(wallCol(k, 1), 0.85), mulc(wallCol(w, 1), 0.85), null, null, UV_WHITE);
      }
      function blockSide(k, w, side) {
        var hotel = hotelAt(k), oL = (side > 0 ? EL[k] : ER[k]) + OUT_T, oW = (side > 0 ? EL[w] : ER[w]) + OUT_T;
        var ou = side * oL, ow = side * oW;
        var bot0 = Math.min(sY(idx[k], ou), gY(X[k] + NX[k] * ou, Z[k] + NZ[k] * ou, sY(idx[k], ou))) - 1.5;
        var bot1 = Math.min(sY(idx[w], ow), gY(X[w] + NX[w] * ow, Z[w] + NZ[w] * ow, sY(idx[w], ow))) - 1.5;
        var ua = arc[k] / BAY, ub = arc[w] / BAY;
        outer.quad(P(k, ou, bot0), P(w, ow, bot1), P(w, ow, YT[k]), P(k, ou, YT[k]), n3(k, side),
          hotel ? [1, 1, 1] : C_PLAIN, null, null, null,
          hotel ? [ua, bot0 / FLOOR] : UV_PLAIN, hotel ? [ub, bot1 / FLOOR] : UV_PLAIN,
          hotel ? [ub, YT[k] / FLOOR] : UV_PLAIN, hotel ? [ua, YT[k] / FLOOR] : UV_PLAIN);
      }

      for (k = 0; k < K; k++) {
        var w = k + 1;
        for (side = -1; side <= 1; side += 2) {
          if (side > 0 ? !(FL[k] && FL[w]) : !(FR[k] && FR[w])) continue;
          if (isOpen[side > 0 ? 1 : 0][k]) continue;
          sideWall(k, w, side);
          if (!(hasWing(k, side) && hasWing(w, side))) blockSide(k, w, side);
        }
        // ---- soffit (three strips: the middle one a little darker between the fixture rows)
        // (the middle strip's edges stay inside the chamfers of a narrow tunnel)
        var cuts = [-(ER[k] - CHAMFER), -Math.min(5.4, ER[k] - CHAMFER - 0.3), Math.min(5.4, EL[k] - CHAMFER - 0.3), EL[k] - CHAMFER];
        var cutsW = [-(ER[w] - CHAMFER), -Math.min(5.4, ER[w] - CHAMFER - 0.3), Math.min(5.4, EL[w] - CHAMFER - 0.3), EL[w] - CHAMFER];
        for (q = 0; q < 3; q++) {
          var cm = q === 1 ? 0.85 : 1;
          inner.quad(P(k, cuts[q], YC[k]), P(w, cutsW[q], YC[w]), P(w, cutsW[q + 1], YC[w]), P(k, cuts[q + 1], YC[k]), DOWN,
            mulc(soffitCol(k), cm), mulc(soffitCol(w), cm), null, null, UV_WHITE);
        }
        // ---- shade (darkness = 1 - lightAt): road + runoff, barrier faces and tops (only where the barrier is)
        var lu = Math.max(1 - (1 - LIGHT_IN) * (1 - DAY[k]), LIGHT_IN + (LIGHT_OPEN - LIGHT_IN) * OPN[k]);
        var lw = Math.max(1 - (1 - LIGHT_IN) * (1 - DAY[w]), LIGHT_IN + (LIGHT_OPEN - LIGHT_IN) * OPN[w]);
        var cu = [1 - lu, 1 - lu, 1 - lu], cw = [1 - lw, 1 - lw, 1 - lw];
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
        // ---- exterior: block top (with the wings), a riser where the roof line steps, the wings' outer faces
        var oLu = WL[k], oLw = WL[w], oRu = WR[k], oRw = WR[w];
        outer.quad(P(k, -oRu, YT[k]), P(w, -oRw, YT[k]), P(w, oLw, YT[k]), P(k, oLu, YT[k]), UP, C_ROOF, null, null, null, UV_PLAIN);
        if (Math.abs(YT[w] - YT[k]) > 0.01) {
          var hw = hotelAt(w), rw = Math.max(oRu, oRw), lw2 = Math.max(oLu, oLw);
          outer.quad(P(w, -rw, YT[k]), P(w, lw2, YT[k]), P(w, lw2, YT[w]), P(w, -rw, YT[w]),
            [TX[w] * (YT[w] > YT[k] ? -1 : 1), 0, TZ[w] * (YT[w] > YT[k] ? -1 : 1)],
            hw ? [1, 1, 1] : C_PLAIN, null, null, null,
            hw ? [-rw / BAY, YT[k] / FLOOR] : UV_PLAIN, hw ? [lw2 / BAY, YT[k] / FLOOR] : UV_PLAIN,
            hw ? [lw2 / BAY, YT[w] / FLOOR] : UV_PLAIN, hw ? [-rw / BAY, YT[w] / FLOOR] : UV_PLAIN);
        }
        for (side = -1; side <= 1; side += 2) {
          if (!hasWing(k, side) && !hasWing(w, side)) continue;
          var wu = side * (side > 0 ? WL[k] : WR[k]), ww = side * (side > 0 ? WL[w] : WR[w]), hk = hotelAt(k);
          var xu = X[k] + NX[k] * wu, zu = Z[k] + NZ[k] * wu, xw = X[w] + NX[w] * ww, zw = Z[w] + NZ[w] * ww;
          var gu2 = Math.min(sY(idx[k], wu), gY(xu, zu, sY(idx[k], wu))) - 1.5, gw2 = Math.min(sY(idx[w], ww), gY(xw, zw, sY(idx[w], ww))) - 1.5;
          var ua2 = arc[k] / BAY, ub2 = ua2 + Math.hypot(xw - xu, zw - zu) / BAY;
          outer.quad(P(k, wu, gu2), P(w, ww, gw2), P(w, ww, YT[k]), P(k, wu, YT[k]), n3(k, side),
            hk ? [1, 1, 1] : C_PLAIN, null, null, null,
            hk ? [ua2, gu2 / FLOOR] : UV_PLAIN, hk ? [ub2, gw2 / FLOOR] : UV_PLAIN, hk ? [ub2, YT[k] / FLOOR] : UV_PLAIN, hk ? [ua2, YT[k] / FLOOR] : UV_PLAIN);
        }
      }

      // ---- the colonnade: piers, parapet, openings with reveals, on the open side(s)
      function frame(a, side) {       // interpolated cross-section at arc length a on one side
        var lo = 0, hi = K;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (arc[mid] <= a) lo = mid; else hi = mid; }
        var f = clamp((a - arc[lo]) / ((arc[hi] - arc[lo]) || 1), 0, 1), g = 1 - f;
        var nx = NX[lo] * g + NX[hi] * f, nz = NZ[lo] * g + NZ[hi] * f, nl = Math.hypot(nx, nz) || 1;
        var e = (side > 0 ? EL[lo] : ER[lo]) * g + (side > 0 ? EL[hi] : ER[hi]) * f;
        var ys = sY(idx[lo], side * e) * g + sY(idx[hi], side * e) * f;
        return { x: X[lo] * g + X[hi] * f, z: Z[lo] * g + Z[hi] * f, nx: nx / nl, nz: nz / nl, tx: TX[lo] * g + TX[hi] * f, tz: TZ[lo] * g + TZ[hi] * f, e: e, ys: ys, yc: YC[lo] * g + YC[hi] * f, yt: YT[lo], k: lo, a: a,
          day: DAY[lo] * g + DAY[hi] * f, opn: OPN[lo] * g + OPN[hi] * f, hotel: hotelAt(lo) };
      }
      function FP(F, d, y) { return [F.x + F.nx * d, y, F.z + F.nz * d]; }
      function fcol(F, f) { return mulc(C_TILE, (0.50 + 0.12 * f) * (1 - F.day) + 0.95 * F.day + (1 - F.day) * 0.16 * F.opn); }
      openRanges.forEach(function (R) {
        var sd = R.side, A0 = arc[R.a], A1 = arc[R.b], nP = Math.max(1, Math.round((A1 - A0 - PIER_W) / PIER_PITCH));
        var pitch = (A1 - A0 - PIER_W) / nP, cuts = [], m, j;
        // pieces: piers [c - W/2, c + W/2] and the openings between them, split further at every sample
        for (m = 0; m <= nP; m++) {
          var c0 = A0 + m * pitch;
          cuts.push({ a: c0, pier: true }, { a: c0 + PIER_W, pier: false });
        }
        cuts[cuts.length - 1] = { a: A1, pier: false };
        var pieces = [];
        for (j = 0; j + 1 < cuts.length; j++) {
          var a0 = cuts[j].a, a1 = cuts[j + 1].a, pier = cuts[j].pier, x0 = a0;
          for (k = R.a; k <= R.b; k++) {
            if (arc[k] > a0 + 1e-6 && arc[k] < a1 - 1e-6) { pieces.push({ a0: x0, a1: arc[k], pier: pier, first: x0 === a0, last: false }); x0 = arc[k]; }
          }
          pieces.push({ a0: x0, a1: a1, pier: pier, first: x0 === a0, last: true });
        }
        var inward = null;
        pieces.forEach(function (pc) {
          var Fa = frame(pc.a0, sd), Fb = frame(pc.a1, sd);
          inward = [-Fa.nx * sd, 0, -Fa.nz * sd];
          var da = sd * Fa.e, db = sd * Fb.e, oa = sd * (Fa.e + OUT_T), ob = sd * (Fb.e + OUT_T);
          var ha = Fa.ys + BARRIER_H + 0.15, hb = Fb.ys + BARRIER_H + 0.15;
          var ta = Fa.yc - CHAMFER, tb = Fb.yc - CHAMFER;
          var sa = Fa.ys + OPEN_SILL, sb = Fb.ys + OPEN_SILL, ea = Fa.yc - OPEN_HEAD, eb = Fb.yc - OPEN_HEAD;
          // interior face: lower band, tiles (whole or below / above the opening), chamfer
          inner.quad(FP(Fa, da, Fa.ys - WALL_SINK), FP(Fb, db, Fb.ys - WALL_SINK), FP(Fb, db, hb), FP(Fa, da, ha), inward, C_LOW, null, null, null, UV_WHITE);
          if (pc.pier) {
            inner.quad(FP(Fa, da, ha), FP(Fb, db, hb), FP(Fb, db, tb), FP(Fa, da, ta), inward,
              fcol(Fa, 0), fcol(Fb, 0), fcol(Fb, 1), fcol(Fa, 1), UV_WHITE);
          } else {
            inner.quad(FP(Fa, da, ha), FP(Fb, db, hb), FP(Fb, db, sb), FP(Fa, da, sa), inward,
              fcol(Fa, 0), fcol(Fb, 0), fcol(Fb, 0.2), fcol(Fa, 0.2), UV_WHITE);
            inner.quad(FP(Fa, da, ea), FP(Fb, db, eb), FP(Fb, db, tb), FP(Fa, da, ta), inward,
              fcol(Fa, 0.85), fcol(Fb, 0.85), fcol(Fb, 1), fcol(Fa, 1), UV_WHITE);
            // reveals: sill (up), head (down), jambs at the piers
            inner.quad(FP(Fa, da, sa), FP(Fb, db, sb), FP(Fb, ob, sb), FP(Fa, oa, sa), UP, C_REVEAL, null, null, null, UV_WHITE);
            inner.quad(FP(Fa, da, ea), FP(Fb, db, eb), FP(Fb, ob, eb), FP(Fa, oa, ea), DOWN, mulc(C_REVEAL, 0.8), null, null, null, UV_WHITE);
            if (pc.first) inner.quad(FP(Fa, da, sa), FP(Fa, oa, sa), FP(Fa, oa, ea), FP(Fa, da, ea), [Fa.tx, 0, Fa.tz], C_REVEAL, null, null, null, UV_WHITE);
            if (pc.last) inner.quad(FP(Fb, db, sb), FP(Fb, ob, sb), FP(Fb, ob, eb), FP(Fb, db, eb), [-Fb.tx, 0, -Fb.tz], C_REVEAL, null, null, null, UV_WHITE);
            // the daylight in the opening as seen from inside (additive, view-dependent strength)
            var gl = [0.55, 0.55, 0.52], gd = [0.12, 0.12, 0.11];
            veil.quad(FP(Fa, da - sd * 0.04, sa), FP(Fb, db - sd * 0.04, sb), FP(Fb, db - sd * 0.04, eb), FP(Fa, da - sd * 0.04, ea), inward,
              gl, gl, gd, gd);
          }
          inner.quad(FP(Fa, da, ta), FP(Fb, db, tb), FP(Fb, sd * (Fb.e - CHAMFER), Fb.yc), FP(Fa, sd * (Fa.e - CHAMFER), Fa.yc),
            [inward[0], -1, inward[2]], mulc(fcol(Fa, 1), 0.85), mulc(fcol(Fb, 1), 0.85), null, null, UV_WHITE);
          // exterior face: piers whole, else the parapet and the facade above the opening
          var gA = Math.min(Fa.ys, gY(Fa.x + Fa.nx * oa, Fa.z + Fa.nz * oa, Fa.ys)) - 1.5, gB = Math.min(Fb.ys, gY(Fb.x + Fb.nx * ob, Fb.z + Fb.nz * ob, Fb.ys)) - 1.5;
          var out = [Fa.nx * sd, 0, Fa.nz * sd], ytA = Fa.yt, hot = Fa.hotel;
          function ouv(F, y) { return hot ? [F.a / BAY, y / FLOOR] : UV_PLAIN; }
          var cf = hot ? [1, 1, 1] : C_PLAIN;
          if (pc.pier) {
            outer.quad(FP(Fa, oa, gA), FP(Fb, ob, gB), FP(Fb, ob, eb), FP(Fa, oa, ea), out, C_PIER, null, null, null, UV_PLAIN);
            outer.quad(FP(Fa, oa, ea), FP(Fb, ob, eb), FP(Fb, ob, ytA), FP(Fa, oa, ytA), out, cf, null, null, null,
              ouv(Fa, ea), ouv(Fb, eb), ouv(Fb, ytA), ouv(Fa, ytA));
          } else {
            outer.quad(FP(Fa, oa, gA), FP(Fb, ob, gB), FP(Fb, ob, sb), FP(Fa, oa, sa), out, C_PIER, null, null, null, UV_PLAIN);
            outer.quad(FP(Fa, oa, ea), FP(Fb, ob, eb), FP(Fb, ob, ytA), FP(Fa, oa, ytA), out, cf, null, null, null,
              ouv(Fa, ea), ouv(Fb, eb), ouv(Fb, ytA), ouv(Fa, ytA));
          }
        });
      });

      // ---- light fixtures: boxes hanging from the soffit, lens facing down
      function at(a) {          // interpolated frame at arc length a
        var lo = 0, hi = K;
        while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (arc[mid] <= a) lo = mid; else hi = mid; }
        var f = (a - arc[lo]) / ((arc[hi] - arc[lo]) || 1), nx = NX[lo] + (NX[hi] - NX[lo]) * f, nz = NZ[lo] + (NZ[hi] - NZ[lo]) * f;
        var nl = Math.hypot(nx, nz) || 1;
        return { x: X[lo] + (X[hi] - X[lo]) * f, z: Z[lo] + (Z[hi] - Z[lo]) * f, y: YC[lo] + (YC[hi] - YC[lo]) * f,
          nx: nx / nl, nz: nz / nl, tx: TX[lo] + (TX[hi] - TX[lo]) * f, tz: TZ[lo] + (TZ[hi] - TZ[lo]) * f };
      }
      function fixture(a, d) {
        var F = at(a), hl = FIX_LEN / 2, hw = FIX_W / 2, y1 = F.y - 0.01, y0 = F.y - FIX_H;
        var lo = Math.min(K, Math.max(0, Math.round(a / (Ltot / K))));                 // (a row a narrow tunnel has no room for)
        if (d + hw > EL[lo] - CHAMFER - 0.2 || -d + hw > ER[lo] - CHAMFER - 0.2) return;
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

      // ---- advertising boards on the walls above the barrier: runs of 4 boards, alternating banners. ads: 'monaco' (all
      // five), 'none', else the two neutral ones (GRAND PRIX, F1DRIVE)
      var bIdx = ti * 2, made = 0, adSet = td.ads === 'monaco' ? [0, 1, 2, 3, 4] : (td.ads === 'none' ? [] : [1, 3]);
      for (var side2 = -1; side2 <= 1 && adSet.length; side2 += 2) {
        for (k = 2; k + BOARD_SEG <= K - 2; k += BOARD_SEG) {
          var run = Math.floor((k - 2) / BOARD_SEG) % 6;
          if (run >= 4 || (side2 < 0 && run >= 2)) continue;         // right wall: shorter runs
          var ok = true;
          for (q = 0; q <= BOARD_SEG; q++) if (side2 > 0 ? !FL[k + q] : !FR[k + q]) ok = false;
          if (!ok) continue;
          var uvB = bannerUV(adSet[(bIdx + Math.floor(made / 4)) % adSet.length]);
          for (q = 0; q < BOARD_SEG; q++) {
            var k0 = k + q, k1 = k0 + 1, e0 = side2 * ((side2 > 0 ? EL[k0] : ER[k0]) - 0.04), e1 = side2 * ((side2 > 0 ? EL[k1] : ER[k1]) - 0.04);
            var g0 = sY(idx[k0], e0), g1 = sY(idx[k1], e1);
            // text reads left to right from the road: on the left wall that is along the lap, on the right against it
            var u0 = uvB[0] + (uvB[2] - uvB[0]) * (side2 > 0 ? q : BOARD_SEG - q) / BOARD_SEG;
            var u1 = uvB[0] + (uvB[2] - uvB[0]) * (side2 > 0 ? q + 1 : BOARD_SEG - q - 1) / BOARD_SEG;
            var lc0 = mulc([1, 1, 1], 0.62 * (1 - DAY[k0]) + DAY[k0] + bright(k0)), lc1 = mulc([1, 1, 1], 0.62 * (1 - DAY[k1]) + DAY[k1] + bright(k1));
            inner.quad(P(k0, e0, g0 + BOARD_Y0), P(k1, e1, g1 + BOARD_Y0), P(k1, e1, g1 + BOARD_Y1), P(k0, e0, g0 + BOARD_Y1),
              n3(k0, -side2), lc0, lc1, lc1, lc0, [u0, uvB[1]], [u1, uvB[1]], [u1, uvB[3]], [u0, uvB[3]]);
          }
          made++;
        }
      }

      // ---- portals: facade (lintel over the opening + wings), the glare veil just inside
      function portal(k, out) {     // out = +1: the facade faces along the lap (exit), -1: against it (entry)
        var s = S[idx[k]], face = [s.tx * out, 0, s.tz * out], hotel = out < 0 ? hotelIn : hotelOut;
        var eL = EL[k], eR = ER[k], oL = Math.max(eL + OUT_T + WING, WL[k]), oR = Math.max(eR + OUT_T + WING, WR[k]), top = YT[k];
        var gL = Math.min(sY(idx[k], oL), gY(X[k] + NX[k] * oL, Z[k] + NZ[k] * oL, sY(idx[k], oL))) - 1.5;
        var gR = Math.min(sY(idx[k], -oR), gY(X[k] - NX[k] * oR, Z[k] - NZ[k] * oR, sY(idx[k], -oR))) - 1.5;
        var off = out * 0.02;      // a hair outside the cross-section plane
        function F(d, y) { return [X[k] + NX[k] * d + s.tx * off, y, Z[k] + NZ[k] * d + s.tz * off]; }
        function fuv(d, y) { return hotel ? [d / BAY, y / FLOOR] : UV_PLAIN; }
        var cf = hotel ? [1, 1, 1] : C_CONC, lint = Math.min(YC[k] + 1.0, top);
        // concrete lintel band right over the opening, then the facade up to the top
        outer.quad(F(-eR, YC[k]), F(eL, YC[k]), F(eL, lint), F(-eR, lint), face, C_CONC, null, null, null, UV_PLAIN);
        if (top - lint > 0.05) {
          outer.quad(F(-oR, lint), F(oL, lint), F(oL, top), F(-oR, top), face, cf, null, null, null,
            fuv(-oR, lint), fuv(oL, lint), fuv(oL, top), fuv(-oR, top));
        }
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
        // glare veil one sample inside, facing inwards: the daylight in the opening as seen from inside
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
    var innerMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: atlas });
    var innerMesh = add('tunnel-interior', inner, innerMat, 0, true);
    add('tunnel-exterior', outer, new THREE.MeshLambertMaterial({ vertexColors: true, map: ftex, side: THREE.DoubleSide }), 0, true);
    // dst * (1 - colour): colour = k * darkness (k set by update). The destination alpha is kept (the WebGL canvas is
    // composited with its alpha: alpha 0 would let the page show through)
    var shadeMat = new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    var shadeMesh = add('tunnel-shade', shade, shadeMat, 5, false);
    var veilMat = new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true,
      opacity: 0, depthWrite: false, fog: false });
    var veilMesh = add('tunnel-glare', veil, veilMat, 11, false);
    if (veilMesh) veilMesh.userData.mirror = true;

    var tris = 0;
    for (i = 0; i < meshes.length; i++) tris += meshes[i].geometry.attributes.position.count / 3;
    var t1 = (global.performance && performance.now) ? performance.now() : Date.now();

    function okIdx(index) { index = index | 0; return index >= 0 && index < N ? index : wrap(index); }
    function inTunnel(index) { return N ? inT[okIdx(index)] : 0; }
    function lightAt(index) { return N ? light[okIdx(index)] : 1; }
    function covered(index) { return N ? cov[okIdx(index)] === 1 : false; }
    function sceneLight(index, kind) {
      if (!N || index === undefined || index === null || !isFinite(index)) return 1;
      var j = okIdx(index), g = Math.pow(light[j], 1 - ADAPT), it = inT[j];
      return kind === 'sun' ? g * (1 - it) * (1 - it) : g * (1 + HEMI_COMP * it);
    }
    function update(t, viewIndex, sceneScaled) {
      var inside = N > 0 && viewIndex !== undefined && viewIndex !== null && isFinite(viewIndex);
      var Lv = inside ? light[okIdx(viewIndex)] : 1;
      var adapt = clamp((1 - Lv) / (1 - LIGHT_IN), 0, 1);
      if (innerMesh) innerMat.color.setScalar(Math.pow(LIGHT_IN / Lv, ADAPT));
      if (shadeMesh) {
        var ks = sceneScaled === false ? 1 : clamp((Lv - LIGHT_IN) / (1 - LIGHT_IN), 0, 1);
        shadeMat.color.setScalar(ks);
        shadeMesh.visible = ks > 0.01;
      }
      if (veilMesh) {
        veilMat.opacity = VEIL_MAX * adapt;
        veilMesh.visible = veilMat.opacity > 0.01;
      }
    }
    update(0, null);
    function dispose() {
      for (var a = 0; a < meshes.length; a++) { meshes[a].geometry.dispose(); group.remove(meshes[a]); }
      for (a = 0; a < materials.length; a++) materials[a].dispose();
      for (a = 0; a < textures.length; a++) textures[a].dispose();
      meshes = []; materials = []; textures = []; innerMesh = shadeMesh = veilMesh = null;
      if (group.parent) group.parent.remove(group);
    }

    return {
      group: group,
      tunnels: ranges,
      inTunnel: inTunnel,
      lightAt: lightAt,
      sceneLight: sceneLight,
      covered: covered,
      update: update,
      dispose: dispose,
      stats: { tunnels: ranges.length, triangles: tris, drawCalls: meshes.length, ms: Math.round((t1 - t0) * 10) / 10 }
    };
  };
})(typeof window !== 'undefined' ? window : this);
