/* F1Drive - scenery (trackside objects, buildings, trees, horizon) and sky dome.
   Classic script; exposes F1.buildScenery(track, trackData, sceneryData) and F1.createSky(opts).
   See README-interfaces.md. Everything is procedural and deterministic (seeded from the track id). */
(function (global) {
  'use strict';

  var F1 = global.F1 = global.F1 || {};

  // ---- colours main.js should use for scene.fog and the clear colour (they match the sky horizon)
  var HORIZON = 0xc6dbee;
  F1.SKY_HORIZON_COLOR = HORIZON;

  // ---- corridor rule
  var CLEAR = 1.5;          // nothing within (wall distance + CLEAR) of the centreline
  var SLACK = 0.3;          // extra room used when objects are fitted against the corridor
  var GANTRY_CLEAR_H = 6.5; // underside of anything spanning the road
  var GANTRY_CURTAIN_H = 8.6; // ... and of the start gantry over a pit light curtain within 15 m (7.5 m + its columns)

  // ---- budgets
  var MAX_TREES = 4600;
  var MAX_BUILDINGS = 3200;
  var MAX_PATCH_QUADS = 22000;

  var BIT_B = 1, BIT_WATER = 2, BIT_SAND = 4, BIT_ASPH = 8, BIT_URBAN = 16, BIT_FOREST = 32, BIT_GRASS = 64;

  // ---------------------------------------------------------------- small helpers

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function h01(a) {
    a = (a ^ 61) ^ (a >>> 16); a = (a + (a << 3)) | 0; a = a ^ (a >>> 4);
    a = Math.imul(a, 0x27d4eb2d); a = a ^ (a >>> 15);
    return (a >>> 0) / 4294967296;
  }
  function vnoise(x, z, seed) {
    var ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    function L(a, b) { return h01((Math.imul(a, 374761393) + Math.imul(b, 668265263) + seed) | 0); }
    return (L(ix, iz) * (1 - fx) + L(ix + 1, iz) * fx) * (1 - fz) +
           (L(ix, iz + 1) * (1 - fx) + L(ix + 1, iz + 1) * fx) * fz;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function C(h) { return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; }
  function shade(c, k) { return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)]; }
  function mixC(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  // ---------------------------------------------------------------- polygons (arrays of [x, z])

  function polyArea(p) {
    var a = 0;
    for (var i = 0, n = p.length; i < n; i++) { var q = p[(i + 1) % n]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
    return a / 2;
  }
  // walls built edge by edge face outwards when the signed area is negative
  function orient(p) { if (polyArea(p) > 0) p.reverse(); return p; }
  function pointInPoly(x, z, p) {
    var inside = false;
    for (var i = 0, n = p.length, j = n - 1; i < n; j = i++) {
      var a = p[i], b = p[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  var _qx = 0, _qz = 0;
  function segDist2(px, pz, ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    var t = l2 > 1e-12 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    _qx = ax + dx * t; _qz = az + dz * t;
    dx = px - _qx; dz = pz - _qz;
    return dx * dx + dz * dz;
  }
  function cleanInput(raw) {
    if (!raw || raw.length < 3) return null;
    var out = [], i, a, b;
    for (i = 0; i < raw.length; i++) {
      a = raw[i];
      if (!a || !isFinite(a[0]) || !isFinite(a[1])) return null;
      b = out[out.length - 1];
      if (b && Math.abs(b[0] - a[0]) < 0.05 && Math.abs(b[1] - a[1]) < 0.05) continue;
      out.push([+a[0], +a[1]]);
    }
    while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 0.05 &&
           Math.abs(out[0][1] - out[out.length - 1][1]) < 0.05) out.pop();
    return out.length >= 3 ? out : null;
  }
  function densify(p, step) {
    var out = [];
    for (var i = 0, n = p.length; i < n; i++) {
      var a = p[i], b = p[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var k = Math.max(1, Math.ceil(l / step));
      for (var j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    return out;
  }
  function simplify(p) {
    var out = [], i, n = p.length;
    for (i = 0; i < n; i++) {
      var b = out[out.length - 1];
      if (b && Math.hypot(b[0] - p[i][0], b[1] - p[i][1]) < 0.4) continue;
      out.push(p[i]);
    }
    while (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.4) out.pop();
    // drop collinear vertices
    var res = [];
    n = out.length;
    for (i = 0; i < n; i++) {
      var a = out[(i - 1 + n) % n], c = out[(i + 1) % n], m = out[i];
      var d2 = segDist2(m[0], m[1], a[0], a[1], c[0], c[1]);
      if (d2 > 0.03 * 0.03) res.push(m);
    }
    return res.length >= 3 ? res : null;
  }
  function segsCross(a, b, c, d) {
    function o(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    var o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0)) && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
  }
  function selfIntersects(p) {
    var n = p.length;
    if (n > 260) return true;
    for (var i = 0; i < n; i++) {
      for (var j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- geometry buffers

  function Buf(uv) { this.p = []; this.n = []; this.c = []; this.u = uv ? [] : null; this.tris = 0; }
  // triangle a, b, c (arrays [x, y, z]); colours per vertex; uvs optional [u, v]
  function tri(buf, a, b, c, ca, cb, cc, ua, ub, uc) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    buf.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    buf.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    cb = cb || ca; cc = cc || ca;
    buf.c.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    if (buf.u) {
      if (ua) buf.u.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
      else buf.u.push(0, 0, 0, 0, 0, 0);
    }
    buf.tris++;
  }
  // quad a, b, c, d counter-clockwise as seen from its front
  function quad(buf, a, b, c, d, col, ua, ub, uc, ud) {
    tri(buf, a, b, c, col, col, col, ua, ub, uc);
    tri(buf, a, c, d, col, col, col, ua, uc, ud);
  }
  // upward facing triangle whatever the input order
  function triUp(buf, a, b, c, ca, cb, cc, ua, ub, uc) {
    var ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny >= 0) tri(buf, a, b, c, ca, cb, cc, ua, ub, uc);
    else tri(buf, a, c, b, ca, cc, cb, ua, uc, ub);
  }
  // vertical wall along (x0,z0)->(x1,z1); faces (-dz, dx)
  function wall(buf, x0, z0, x1, z1, yb0, yb1, yt0, yt1, col, u0, u1, vb, vt) {
    if (buf.u) {
      quad(buf, [x0, yb0, z0], [x1, yb1, z1], [x1, yt1, z1], [x0, yt0, z0], col,
           [u0, vb], [u1, vb], [u1, vt], [u0, vt]);
    } else {
      quad(buf, [x0, yb0, z0], [x1, yb1, z1], [x1, yt1, z1], [x0, yt0, z0], col);
    }
  }
  // oriented box: centre (cx, cz), base y0, top y1, half extents a (along (ax, az)) and b (across)
  function box(buf, cx, cz, y0, y1, ax, az, ha, hb, col, colTop) {
    var bx = az, bz = -ax; // across
    var p = [
      [cx - ax * ha - bx * hb, cz - az * ha - bz * hb], [cx + ax * ha - bx * hb, cz + az * ha - bz * hb],
      [cx + ax * ha + bx * hb, cz + az * ha + bz * hb], [cx - ax * ha + bx * hb, cz - az * ha + bz * hb]
    ];
    if (polyArea(p) > 0) p.reverse();
    for (var i = 0; i < 4; i++) {
      var a = p[i], b = p[(i + 1) % 4];
      quad(buf, [a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], col);
    }
    var ct = colTop || col;
    triUp(buf, [p[0][0], y1, p[0][1]], [p[1][0], y1, p[1][1]], [p[2][0], y1, p[2][1]], ct);
    triUp(buf, [p[0][0], y1, p[0][1]], [p[2][0], y1, p[2][1]], [p[3][0], y1, p[3][1]], ct);
    return p;
  }

  // ---------------------------------------------------------------- per-track profile

  function profileFor(td) {
    var id = (td && td.id) || '', cc = id.slice(0, 2);
    var p = {
      city: false, skyline: 0, night: false, trees: 1, mix: [0.65, 0.35, 0], med: false, desert: false,
      hills: [12, 34, 30, 80], cityH: [14, 38], glass: 0.15, tall: 0.1
    };
    var ROLL = [25, 70, 60, 170], HILLY = [40, 120, 130, 330], ALP = [60, 180, 300, 650];
    var inSet = function (s) { return s.indexOf(id) >= 0; };
    if (inSet('at-1969 mc-1929 ru-2014')) p.hills = ALP;
    else if (inSet('be-1925 it-1914 it-1953 de-1927 hu-1986 jp-1962 tr-2005 pt-2008 br-1940 us-1956 mx-1962 ' +
                   'es-1991 fr-1969 za-1961 us-2023 pt-1972')) p.hills = HILLY;
    else if (inSet('it-1922 us-2012 es-2026 cn-2004 my-1999 az-2016 fr-1960')) p.hills = ROLL;
    if (inSet('bh-2002 qa-2004 ae-2009 sa-2021 us-2023')) { p.desert = true; p.trees = 0.14; p.mix = [0, 0, 1]; if (p.hills[3] < 200) p.hills = [22, 70, 90, 230]; }
    if (inSet('sg-2008 my-1999 us-2022 br-1977')) p.mix = [0.5, 0, 0.5];
    if (cc === 'mc' || cc === 'es' || cc === 'pt' || cc === 'it' || cc === 'tr' || cc === 'az' || id === 'fr-1969') {
      p.med = true; p.mix = (cc === 'mc' || cc === 'es' || cc === 'pt') ? [0.6, 0.28, 0.12] : [0.65, 0.35, 0];
    }
    if (inSet('be-1925 de-1927 de-1932 at-1969 us-1956 ca-1978 ru-2014')) p.mix = [0.4, 0.6, 0];
    if (inSet('mc-1929 az-2016 sg-2008 us-2023 sa-2021 us-2022')) { p.city = true; p.skyline = 1; p.trees = Math.min(p.trees, 0.3); }
    if (id === 'mc-1929') { p.cityH = [16, 44]; p.glass = 0.1; p.tall = 0.15; }
    if (id === 'az-2016') { p.cityH = [12, 30]; p.glass = 0.12; p.tall = 0.08; }
    if (id === 'sg-2008') { p.cityH = [20, 60]; p.glass = 0.6; p.tall = 0.3; }
    if (id === 'us-2023') { p.cityH = [15, 70]; p.glass = 0.6; p.tall = 0.35; }
    if (id === 'sa-2021') { p.cityH = [8, 30]; p.glass = 0.3; p.tall = 0.1; }
    if (id === 'us-2022') { p.cityH = [8, 25]; p.glass = 0.4; p.tall = 0.08; }
    if (inSet('au-1953 ca-1978 mx-1962 br-1940 es-2026 ru-2014 ae-2009 cn-2004')) p.skyline = 0.5;
    if (inSet('bh-2002 sg-2008 sa-2021 qa-2004 ae-2009 us-2023')) p.night = true;
    return p;
  }

  // ---------------------------------------------------------------- procedural textures

  function makeCanvas(w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c.getContext && c.getContext('2d') ? c : null;
    } catch (e) { return null; }
  }
  function makeTexture(THREE, canvas, repeatS, repeatT) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = repeatS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.wrapT = repeatT ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }

  function texMasonry(THREE, rnd) {
    var c = makeCanvas(512, 512); if (!c) return null;
    var g = c.getContext('2d'), i, x, y;
    g.fillStyle = '#e4e0d8'; g.fillRect(0, 0, 512, 512);
    for (i = 0; i < 260; i++) {       // faint weathering
      g.fillStyle = 'rgba(' + (rnd() < 0.5 ? '90,84,72' : '255,255,250') + ',' + (0.02 + rnd() * 0.04) + ')';
      g.fillRect(rnd() * 512, rnd() * 512, 20 + rnd() * 90, 4 + rnd() * 30);
    }
    for (y = 0; y < 4; y++) {
      g.fillStyle = 'rgba(70,64,56,0.22)'; g.fillRect(0, y * 128 + 122, 512, 4);   // floor band
      for (x = 0; x < 4; x++) {
        var ox = x * 128, oy = y * 128;
        g.fillStyle = '#f6f3ec'; g.fillRect(ox + 32, oy + 24, 64, 80);              // frame
        var gr = g.createLinearGradient(0, oy + 28, 0, oy + 100);
        var lit = rnd();
        if (lit < 0.12) { gr.addColorStop(0, '#d9c58a'); gr.addColorStop(1, '#a8935a'); }
        else { gr.addColorStop(0, '#6b8196'); gr.addColorStop(0.5, '#34414f'); gr.addColorStop(1, '#232b35'); }
        g.fillStyle = gr; g.fillRect(ox + 37, oy + 29, 54, 70);
        g.fillStyle = '#f6f3ec'; g.fillRect(ox + 62, oy + 29, 4, 70);               // mullion
        var r = rnd();
        if (r < 0.3) { g.fillStyle = 'rgba(226,218,200,0.85)'; g.fillRect(ox + 37, oy + 29, 54, 18 + rnd() * 30); } // blind
        if (r > 0.62) {                                                              // balcony rail
          g.fillStyle = 'rgba(40,40,44,0.85)'; g.fillRect(ox + 26, oy + 84, 76, 3); g.fillRect(ox + 26, oy + 104, 76, 4);
          for (i = 0; i < 9; i++) g.fillRect(ox + 27 + i * 9.2, oy + 84, 2, 22);
        } else {
          g.fillStyle = 'rgba(70,64,56,0.35)'; g.fillRect(ox + 30, oy + 104, 68, 4); // sill
        }
      }
    }
    return makeTexture(THREE, c, true, true);
  }

  function texGlass(THREE, rnd) {
    var c = makeCanvas(512, 512); if (!c) return null;
    var g = c.getContext('2d'), x, y;
    g.fillStyle = '#c9d2d8'; g.fillRect(0, 0, 512, 512);
    for (y = 0; y < 4; y++) {
      for (x = 0; x < 4; x++) {
        var ox = x * 128, oy = y * 128, k = rnd();
        var gr = g.createLinearGradient(0, oy, 0, oy + 100);
        gr.addColorStop(0, k < 0.5 ? '#a9c6df' : '#94b4d0');
        gr.addColorStop(1, k < 0.5 ? '#587a9a' : '#4a6a8a');
        g.fillStyle = gr; g.fillRect(ox + 3, oy + 3, 122, 96);
        if (rnd() < 0.18) { g.fillStyle = 'rgba(255,255,255,0.20)'; g.fillRect(ox + 3, oy + 3, 122, 96); }
        g.fillStyle = '#3a4b5b'; g.fillRect(ox + 3, oy + 99, 122, 26);               // spandrel
        g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(ox + 63, oy + 3, 2, 96);
      }
    }
    return makeTexture(THREE, c, true, true);
  }

  // two garage bays (12 m) wide, 10 m tall; clamped vertically
  function texPit(THREE, rnd) {
    var c = makeCanvas(512, 256); if (!c) return null;
    var g = c.getContext('2d'), x, i;
    g.fillStyle = '#d9dad8'; g.fillRect(0, 0, 512, 256);
    var stripes = ['#c8202a', '#1f4fa8'];
    for (x = 0; x < 2; x++) {
      var ox = x * 256;
      g.fillStyle = '#2f4456'; g.fillRect(ox + 6, 22, 244, 84);                       // hospitality glazing
      var gr = g.createLinearGradient(0, 22, 0, 106);
      gr.addColorStop(0, 'rgba(170,200,225,0.75)'); gr.addColorStop(1, 'rgba(60,90,120,0.2)');
      g.fillStyle = gr; g.fillRect(ox + 6, 22, 244, 84);
      g.fillStyle = '#e8e8e6';
      for (i = 1; i < 6; i++) g.fillRect(ox + 6 + i * 40.6, 22, 3, 84);
      g.fillStyle = 'rgba(30,30,34,0.8)'; g.fillRect(ox, 92, 256, 3);                 // rail
      g.fillStyle = stripes[x]; g.fillRect(ox, 112, 256, 22);                         // fascia
      g.fillStyle = '#ffffff'; g.font = 'bold 18px Arial, sans-serif'; g.textAlign = 'center';
      g.fillText(String(1 + x + Math.floor(rnd() * 8) * 2), ox + 128, 129);
      g.fillStyle = '#14161a'; g.fillRect(ox + 20, 140, 216, 110);                    // open garage
      var g2 = g.createLinearGradient(0, 140, 0, 250);
      g2.addColorStop(0, 'rgba(0,0,0,0.0)'); g2.addColorStop(1, 'rgba(90,96,104,0.55)');
      g.fillStyle = g2; g.fillRect(ox + 20, 140, 216, 110);
      g.fillStyle = 'rgba(200,204,208,0.5)'; g.fillRect(ox + 20, 140, 216, 10);       // rolled shutter
    }
    g.fillStyle = '#b9bab8'; g.fillRect(0, 250, 512, 6);
    g.fillStyle = '#f2f2f0'; g.fillRect(0, 0, 512, 8);
    return makeTexture(THREE, c, true, false);
  }

  // 8 m x 8 m of seating with spectators
  function texCrowd(THREE, rnd) {
    var c = makeCanvas(256, 256); if (!c) return null;
    var g = c.getContext('2d'), r, s;
    var shirts = ['#d8232a', '#f2f2f2', '#f0c020', '#1d4fb0', '#f08020', '#2a9048', '#1c1c20', '#e86aa0',
                  '#d8232a', '#f2f2f2', '#6fb6e8', '#f2f2f2'];
    var skin = ['#e8c4a0', '#c99a76', '#8a5e40', '#f0d0b4'];
    g.fillStyle = '#5d6672'; g.fillRect(0, 0, 256, 256);
    for (r = 0; r < 10; r++) {
      var y = r * 25.6;
      g.fillStyle = 'rgba(20,24,30,0.55)'; g.fillRect(0, y + 21, 256, 4.6);            // step shadow
      for (s = 0; s < 16; s++) {
        if (rnd() < 0.14) { g.fillStyle = '#7a8694'; g.fillRect(s * 16 + 3, y + 8, 10, 12); continue; } // empty seat
        var x = s * 16 + 2 + rnd() * 2;
        g.fillStyle = shirts[Math.floor(rnd() * shirts.length)]; g.fillRect(x, y + 8, 11, 13);
        g.fillStyle = skin[Math.floor(rnd() * skin.length)];
        g.beginPath(); g.arc(x + 5.5, y + 5, 3.6, 0, Math.PI * 2); g.fill();
      }
    }
    return makeTexture(THREE, c, true, true);
  }

  var BANNERS = [
    ['VELOCITA', '#c8102e', '#ffffff'], ['NORDSEE OIL', '#f2c400', '#16181c'], ['KRONOS', '#14306e', '#ffffff'],
    ['APEX TYRES', '#15171a', '#ffd21e'], ['HALCYON', '#0d7a4a', '#ffffff']
  ];
  function texSigns(THREE) {
    var c = makeCanvas(512, 512); if (!c) return null;
    var g = c.getContext('2d'), i;
    g.fillStyle = '#202226'; g.fillRect(0, 0, 512, 512);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (i = 0; i < BANNERS.length; i++) {
      g.fillStyle = BANNERS[i][1]; g.fillRect(0, i * 80, 512, 80);
      g.fillStyle = BANNERS[i][2];
      g.font = 'italic bold 50px Arial, Helvetica, sans-serif';
      g.fillText(BANNERS[i][0], 128, i * 80 + 42, 236);
      g.fillText(BANNERS[i][0], 384, i * 80 + 42, 236);
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(0, i * 80, 512, 3); g.fillRect(0, i * 80 + 77, 512, 3);
    }
    var nums = ['150', '100', '50'];
    for (i = 0; i < 3; i++) {
      g.fillStyle = '#f4f4f2'; g.fillRect(i * 112, 400, 112, 112);
      g.fillStyle = '#15171a'; g.fillRect(i * 112 + 5, 405, 102, 102);
      g.fillStyle = '#f4f4f2'; g.font = 'bold 56px Arial, Helvetica, sans-serif';
      g.fillText(nums[i], i * 112 + 56, 460, 92);
    }
    g.fillStyle = '#0c0d0f'; g.fillRect(336, 400, 176, 112);
    for (i = 0; i < 5; i++) {
      for (var r = 0; r < 2; r++) {
        var gx = 336 + 22 + i * 33, gy = 432 + r * 46;
        var rg = g.createRadialGradient(gx, gy, 2, gx, gy, 15);
        rg.addColorStop(0, '#ff6a5a'); rg.addColorStop(0.55, '#e01010'); rg.addColorStop(1, 'rgba(90,0,0,0)');
        g.fillStyle = rg; g.beginPath(); g.arc(gx, gy, 15, 0, Math.PI * 2); g.fill();
      }
    }
    return makeTexture(THREE, c, false, false);
  }
  // atlas rectangles [u0, v0, u1, v1] (v up)
  function bannerUV(i) { return [0.004, 1 - (i * 80 + 78) / 512, 0.996, 1 - (i * 80 + 2) / 512]; }
  function numberUV(i) { return [(i * 112 + 2) / 512, 1 - 510 / 512, (i * 112 + 110) / 512, 1 - 402 / 512]; }
  var LIGHTS_UV = [338 / 512, 1 - 510 / 512, 510 / 512, 1 - 402 / 512];

  // debris fence: 4 m wide panel with a post, clamped vertically
  function texFence(THREE) {
    var c = makeCanvas(128, 128); if (!c) return null;
    var g = c.getContext('2d'), i;
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(205,210,216,0.5)'; g.lineWidth = 1;
    g.beginPath();
    for (i = -128; i < 256; i += 9) { g.moveTo(i, 0); g.lineTo(i + 128, 128); g.moveTo(i + 128, 0); g.lineTo(i, 128); }
    g.stroke();
    g.fillStyle = 'rgba(150,156,162,0.95)';
    g.fillRect(0, 0, 5, 128); g.fillRect(123, 0, 5, 128);
    g.fillRect(0, 0, 128, 3); g.fillRect(0, 40, 128, 2); g.fillRect(0, 84, 128, 2);
    return makeTexture(THREE, c, true, false);
  }

  // ---------------------------------------------------------------- unit tree geometries (1 m tall)

  function treeGeometry(THREE, kind) {
    var b = new Buf(false), i, a0, a1;
    var trunk = C(0x4a3a2a);
    function ring(r, y, k, n, ph) { var a = (k / n) * Math.PI * 2 + (ph || 0); return [Math.cos(a) * r, y, Math.sin(a) * r]; }
    function cyl(r0, r1, y0, y1, n, col) {
      for (var k = 0; k < n; k++) {
        quad(b, ring(r0, y0, k + 1, n), ring(r0, y0, k, n), ring(r1, y1, k, n), ring(r1, y1, k + 1, n), col);
      }
    }
    function cone(r, y0, y1, n, c0, c1, ph) {
      for (var k = 0; k < n; k++) {
        tri(b, ring(r, y0, k + 1, n, ph), ring(r, y0, k, n, ph), [0, y1, 0], c0, c0, c1);
      }
    }
    var smoothFrom = -1, centre = null;
    if (kind === 'conifer') {
      cyl(0.022, 0.018, 0, 0.22, 4, trunk);
      cone(0.20, 0.14, 0.62, 7, C(0x1e4424), C(0x2f6034), 0);
      cone(0.145, 0.42, 1.0, 7, C(0x224c28), C(0x3a7040), 0.45);
    } else if (kind === 'palm') {
      cyl(0.022, 0.015, 0, 0.9, 4, C(0x6a5a44));
      for (i = 0; i < 7; i++) {
        a0 = (i / 7) * Math.PI * 2; a1 = a0 + 0.22;
        var cx = Math.cos(a0), cz = Math.sin(a0), sx = -cz * 0.045, sz = cx * 0.045;
        var m = [cx * 0.17, 0.97, cz * 0.17], e = [cx * 0.34, 0.80, cz * 0.34];
        var g0 = C(0x3a7a34), g1 = C(0x2c6228);
        tri(b, [0, 0.9, 0], [m[0] + sx, m[1], m[2] + sz], [m[0] - sx, m[1], m[2] - sz], g0);
        tri(b, [m[0] + sx, m[1], m[2] + sz], e, [m[0] - sx, m[1], m[2] - sz], g0, g1, g0);
      }
    } else {
      cyl(0.03, 0.022, 0, 0.42, 5, trunk);
      smoothFrom = b.p.length / 3;
      centre = [0, 0.66, 0];
      var ico = new THREE.IcosahedronGeometry(1, 0), pa = ico.getAttribute('position');
      var vs = [];
      for (i = 0; i < pa.count; i++) {
        var x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        var j = 0.85 + 0.3 * h01((Math.round(x * 50) * 73856093) ^ (Math.round(y * 50) * 19349663) ^ (Math.round(z * 50) * 83492791));
        vs.push([x * 0.33 * j, 0.66 + y * 0.35 * j, z * 0.33 * j]);
      }
      ico.dispose();
      for (i = 0; i < vs.length; i += 3) {
        var cs = [];
        for (var q = 0; q < 3; q++) cs.push(mixC(C(0x1f4a20), C(0x4c8a3a), clamp((vs[i + q][1] - 0.3) / 0.7, 0, 1)));
        tri(b, vs[i], vs[i + 1], vs[i + 2], cs[0], cs[1], cs[2]);
      }
    }
    var geo = new THREE.BufferGeometry();
    var nrm = new Float32Array(b.n);
    if (smoothFrom >= 0) {     // rounded canopy shading
      for (i = smoothFrom; i < b.p.length / 3; i++) {
        var dx = b.p[i * 3] - centre[0], dy = b.p[i * 3 + 1] - centre[1] + 0.12, dz = b.p[i * 3 + 2] - centre[2];
        var l = Math.hypot(dx, dy, dz) || 1;
        nrm[i * 3] = dx / l; nrm[i * 3 + 1] = dy / l; nrm[i * 3 + 2] = dz / l;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.p), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.c), 3));
    geo.computeBoundingSphere();
    geo.userData.tris = b.tris;
    return geo;
  }

  // ================================================================ F1.buildScenery

  F1.buildScenery = function (track, trackData, sceneryData) {
    var THREE = global.THREE, tStart = now();
    var S = track.samples, N = S.length, i, j, k;
    var id = (trackData && trackData.id) || 'track';
    var seed = hashStr(String(id));
    var rnd = makeRng(seed);
    var prof = profileFor(trackData);
    var DEBUG = !!F1.SCENERY_DEBUG;
    var foot = [];            // debug: footprints of everything that stands on the ground

    if (sceneryData && !sceneryData.buildings && !sceneryData.areas && !sceneryData.trees && sceneryData[id]) {
      sceneryData = sceneryData[id];
    }
    var data = sceneryData || {};
    var dBuildings = Array.isArray(data.buildings) ? data.buildings : [];
    var dAreas = Array.isArray(data.areas) ? data.areas : [];
    var dTrees = Array.isArray(data.trees) ? data.trees : [];

    // ---------------------------------------------------------------- track tables
    var X = new Float64Array(N), Z = new Float64Array(N), Y = new Float64Array(N);
    var TX = new Float64Array(N), TZ = new Float64Array(N), NX = new Float64Array(N), NZ = new Float64Array(N);
    var LP = new Float64Array(N), LN = new Float64Array(N), WP = new Float64Array(N), WN = new Float64Array(N);
    var nomWall = isFinite(track.wallDist) ? track.wallDist : 12, nomHalf = isFinite(track.halfWidth) ? track.halfWidth : 7;
    var maxLim = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (i = 0; i < N; i++) {
      var sm = S[i];
      X[i] = sm.x; Z[i] = sm.z; Y[i] = isFinite(sm.y) ? sm.y : 0;
      TX[i] = sm.tx; TZ[i] = sm.tz; NX[i] = sm.nx; NZ[i] = sm.nz;
      var hw = isFinite(sm.halfW) ? sm.halfW : nomHalf;
      WP[i] = isFinite(sm.wallPosDist) ? sm.wallPosDist : nomWall;
      WN[i] = isFinite(sm.wallNegDist) ? sm.wallNegDist : nomWall;
      LP[i] = Math.max(WP[i], hw + 1);
      LN[i] = Math.max(WN[i], hw + 1);
      if (LP[i] > maxLim) maxLim = LP[i];
      if (LN[i] > maxLim) maxLim = LN[i];
      if (X[i] < minX) minX = X[i]; if (X[i] > maxX) maxX = X[i];
      if (Z[i] < minZ) minZ = Z[i]; if (Z[i] > maxZ) maxZ = Z[i];
    }
    var ds = (track.length || N * 2) / N;
    function wrap(a) { return ((a % N) + N) % N; }
    function sY(idx, d) { return typeof track.surfaceY === 'function' ? track.surfaceY(idx, d) : Y[idx]; }

    // spatial grid over the samples
    var GC = 32, gx0 = minX - GC, gz0 = minZ - GC;
    var gCols = Math.ceil((maxX - minX) / GC) + 3, gRows = Math.ceil((maxZ - minZ) / GC) + 3;
    var cellStart = new Int32Array(gCols * gRows + 1), cellOf = new Int32Array(N);
    for (i = 0; i < N; i++) {
      cellOf[i] = Math.floor((Z[i] - gz0) / GC) * gCols + Math.floor((X[i] - gx0) / GC);
      cellStart[cellOf[i] + 1]++;
    }
    for (i = 0; i < gCols * gRows; i++) cellStart[i + 1] += cellStart[i];
    var cellFill = cellStart.slice(0, gCols * gRows), cellItems = new Int32Array(N);
    for (i = 0; i < N; i++) cellItems[cellFill[cellOf[i]]++] = i;

    // min over samples within R of (distance - corridor half width on that side); Infinity if none.
    var lastI = -1;
    function corr(x, z, R) {
      R = R || (maxLim + CLEAR + 8);
      var c0 = Math.floor((x - R - gx0) / GC), c1 = Math.floor((x + R - gx0) / GC);
      var r0 = Math.floor((z - R - gz0) / GC), r1 = Math.floor((z + R - gz0) / GC);
      var best = Infinity, R2 = R * R;
      lastI = -1;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 > gCols - 1) c1 = gCols - 1; if (r1 > gRows - 1) r1 = gRows - 1;
      for (var rr = r0; rr <= r1; rr++) {
        for (var cc = c0; cc <= c1; cc++) {
          var c = rr * gCols + cc;
          for (var e = cellStart[c]; e < cellStart[c + 1]; e++) {
            var s = cellItems[e], dx = x - X[s], dz = z - Z[s], d2 = dx * dx + dz * dz;
            if (d2 > R2) continue;
            var v = Math.sqrt(d2) - ((dx * NX[s] + dz * NZ[s]) >= 0 ? LP[s] : LN[s]);
            if (v < best) { best = v; lastI = s; }
          }
        }
      }
      return best;
    }
    function isClear(x, z, m) { return corr(x, z, maxLim + m + 2) >= m; }
    function segClear(a, b, m) {
      var l = Math.hypot(b[0] - a[0], b[1] - a[1]), st = Math.max(1, Math.ceil(l / 0.5));
      for (var q = 0; q <= st; q++) {
        if (!isClear(a[0] + (b[0] - a[0]) * q / st, a[1] + (b[1] - a[1]) * q / st, m)) return false;
      }
      return true;
    }
    // nearest sample (by plain distance) within R, or -1
    var lastD = 0;
    function nearest(x, z, R) {
      var c0 = Math.floor((x - R - gx0) / GC), c1 = Math.floor((x + R - gx0) / GC);
      var r0 = Math.floor((z - R - gz0) / GC), r1 = Math.floor((z + R - gz0) / GC);
      var best = R * R, bi = -1;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 > gCols - 1) c1 = gCols - 1; if (r1 > gRows - 1) r1 = gRows - 1;
      for (var rr = r0; rr <= r1; rr++) {
        for (var cc = c0; cc <= c1; cc++) {
          var c = rr * gCols + cc;
          for (var e = cellStart[c]; e < cellStart[c + 1]; e++) {
            var s = cellItems[e], dx = x - X[s], dz = z - Z[s], d2 = dx * dx + dz * dz;
            if (d2 < best) { best = d2; bi = s; }
          }
        }
      }
      lastD = Math.sqrt(best);
      return bi;
    }
    // min over samples of (distance from the sample to the polygon - corridor half width); -1e9 when a
    // sample lies inside the polygon.
    function polyClearance(p) {
      var n = p.length, a, bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (a = 0; a < n; a++) {
        if (p[a][0] < bx0) bx0 = p[a][0]; if (p[a][0] > bx1) bx1 = p[a][0];
        if (p[a][1] < bz0) bz0 = p[a][1]; if (p[a][1] > bz1) bz1 = p[a][1];
      }
      var pad = maxLim + CLEAR + 2;
      bx0 -= pad; bx1 += pad; bz0 -= pad; bz1 += pad;
      var c0 = Math.floor((bx0 - gx0) / GC), c1 = Math.floor((bx1 - gx0) / GC);
      var r0 = Math.floor((bz0 - gz0) / GC), r1 = Math.floor((bz1 - gz0) / GC), best = Infinity;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 > gCols - 1) c1 = gCols - 1; if (r1 > gRows - 1) r1 = gRows - 1;
      for (var rr = r0; rr <= r1; rr++) {
        for (var cc = c0; cc <= c1; cc++) {
          var c = rr * gCols + cc;
          for (var e = cellStart[c]; e < cellStart[c + 1]; e++) {
            var s = cellItems[e], sx = X[s], sz = Z[s];
            if (sx < bx0 || sx > bx1 || sz < bz0 || sz > bz1) continue;
            if (pointInPoly(sx, sz, p)) return -1e9;
            var bd = Infinity, qx = 0, qz = 0;
            for (a = 0; a < n; a++) {
              var b = p[(a + 1) % n], d2 = segDist2(sx, sz, p[a][0], p[a][1], b[0], b[1]);
              if (d2 < bd) { bd = d2; qx = _qx; qz = _qz; }
            }
            var v = Math.sqrt(bd) - (((qx - sx) * NX[s] + (qz - sz) * NZ[s]) >= 0 ? LP[s] : LN[s]);
            if (v < best) best = v;
          }
        }
      }
      return best;
    }
    // Fit a footprint against the corridor: vertices inside it are moved out to the corridor edge on the
    // side where the bulk of the footprint is. Returns the (possibly new) polygon or null to drop it.
    function fitPoly(p) {
      var c = polyClearance(p);
      if (c >= CLEAR) return p;
      var area0 = Math.abs(polyArea(p)), n, a, pass;
      var cx = 0, cz = 0;
      for (a = 0; a < p.length; a++) { cx += p[a][0]; cz += p[a][1]; }
      cx /= p.length; cz /= p.length;
      var per = 0;
      for (a = 0; a < p.length; a++) per += Math.hypot(p[(a + 1) % p.length][0] - p[a][0], p[(a + 1) % p.length][1] - p[a][1]);
      var q = densify(p, Math.max(3, per / 220));
      n = q.length;
      var target = CLEAR + SLACK;
      for (pass = 0; pass < 5; pass++) {
        var moved = 0;
        for (a = 0; a < n; a++) {
          var v = corr(q[a][0], q[a][1], maxLim + target + 2);
          if (v >= target - 0.02) continue;
          var s = lastI;
          var side = ((cx - X[s]) * NX[s] + (cz - Z[s]) * NZ[s]) >= 0 ? 1 : -1;
          var along = (q[a][0] - X[s]) * TX[s] + (q[a][1] - Z[s]) * TZ[s];
          var L = (side > 0 ? LP[s] : LN[s]) + target + pass * 0.15;
          q[a] = [X[s] + TX[s] * along + NX[s] * side * L, Z[s] + TZ[s] * along + NZ[s] * side * L];
          moved++;
        }
        if (!moved) break;
      }
      q = simplify(q);
      if (!q) return null;
      var area1 = Math.abs(polyArea(q));
      if (area1 < 20 || area1 < 0.3 * area0) return null;
      if (selfIntersects(q)) return null;
      if (polyClearance(q) < CLEAR) return null;
      return q;
    }

    // ---------------------------------------------------------------- ground height
    // track.groundY is exact but scans every sample for points far from the road, so far points are
    // answered from a lazily filled 32 m lattice of it (or from track.terrainY when that is exported).
    var gfn = typeof track.groundY === 'function' ? track.groundY : null;
    var tfn = typeof track.terrainY === 'function' ? track.terrainY : null;
    function rawY(x, z) {
      var v = gfn ? gfn.call(track, x, z) : (tfn ? tfn.call(track, x, z) : NaN);
      if (v === v && isFinite(v)) return v;
      var s = nearest(x, z, 400);
      return s >= 0 ? Y[s] : 0;
    }
    var HC = 32, hx0 = minX - 900, hz0 = minZ - 900;
    var HWd = Math.ceil((maxX - minX + 1800) / HC) + 2, HHt = Math.ceil((maxZ - minZ + 1800) / HC) + 2;
    var hcache = new Float32Array(HWd * HHt).fill(NaN);
    function latY(ix, iz) {
      var c = iz * HWd + ix, v = hcache[c];
      if (v !== v) { v = rawY(hx0 + ix * HC, hz0 + iz * HC); hcache[c] = v; }
      return v;
    }
    function gY(x, z) {
      if (!gfn && !tfn) return rawY(x, z);
      if (nearest(x, z, 40) >= 0) return rawY(x, z);
      if (tfn) { var t = tfn.call(track, x, z); if (t === t && isFinite(t)) return t; }
      var fx = (x - hx0) / HC, fz = (z - hz0) / HC, ix = Math.floor(fx), iz = Math.floor(fz);
      if (ix < 0 || iz < 0 || ix >= HWd - 1 || iz >= HHt - 1) return rawY(x, z);
      fx -= ix; fz -= iz;
      if (fx < 1e-6 && fz < 1e-6) return latY(ix, iz);
      return (latY(ix, iz) * (1 - fx) + latY(ix + 1, iz) * fx) * (1 - fz) +
             (latY(ix, iz + 1) * (1 - fx) + latY(ix + 1, iz + 1) * fx) * fz;
    }

    // ---------------------------------------------------------------- occupancy raster + coarse distance
    var PAD = 900;
    var rx0 = minX - PAD, rz0 = minZ - PAD;
    var rcell = Math.max(8, Math.sqrt((maxX - minX + 2 * PAD) * (maxZ - minZ + 2 * PAD) / 260000));
    var RW = Math.ceil((maxX - minX + 2 * PAD) / rcell), RH = Math.ceil((maxZ - minZ + 2 * PAD) / rcell);
    var occ = new Uint8Array(RW * RH);
    function occAt(x, z) {
      var cx = Math.floor((x - rx0) / rcell), cz = Math.floor((z - rz0) / rcell);
      return (cx < 0 || cz < 0 || cx >= RW || cz >= RH) ? 0 : occ[cz * RW + cx];
    }
    function fillPoly(p, bit) {
      var n = p.length, a, z0 = Infinity, z1 = -Infinity;
      for (a = 0; a < n; a++) { if (p[a][1] < z0) z0 = p[a][1]; if (p[a][1] > z1) z1 = p[a][1]; }
      var r0 = Math.max(0, Math.floor((z0 - rz0) / rcell)), r1 = Math.min(RH - 1, Math.floor((z1 - rz0) / rcell));
      for (var r = r0; r <= r1; r++) {
        var zc = rz0 + (r + 0.5) * rcell, xs = [];
        for (a = 0; a < n; a++) {
          var u = p[a], v = p[(a + 1) % n];
          if ((u[1] > zc) !== (v[1] > zc)) xs.push(u[0] + (zc - u[1]) / (v[1] - u[1]) * (v[0] - u[0]));
        }
        xs.sort(function (m, o) { return m - o; });
        for (a = 0; a + 1 < xs.length; a += 2) {
          var ca = Math.max(0, Math.ceil((xs[a] - rx0) / rcell - 0.5));
          var cb = Math.min(RW - 1, Math.floor((xs[a + 1] - rx0) / rcell - 0.5));
          for (var cc = ca; cc <= cb; cc++) occ[r * RW + cc] |= bit;
        }
      }
    }
    function stampPoly(p, bit) {
      fillPoly(p, bit);
      for (var a = 0, n = p.length; a < n; a++) {
        var u = p[a], v = p[(a + 1) % n], l = Math.hypot(v[0] - u[0], v[1] - u[1]);
        var st = Math.max(1, Math.ceil(l / (rcell * 0.5)));
        for (var q = 0; q <= st; q++) {
          var cx = Math.floor((u[0] + (v[0] - u[0]) * q / st - rx0) / rcell);
          var cz = Math.floor((u[1] + (v[1] - u[1]) * q / st - rz0) / rcell);
          if (cx >= 0 && cz >= 0 && cx < RW && cz < RH) occ[cz * RW + cx] |= bit;
        }
      }
    }
    function polyHitsOcc(p, mask) {
      var n = p.length, a, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (a = 0; a < n; a++) {
        var u = p[a], v = p[(a + 1) % n], l = Math.hypot(v[0] - u[0], v[1] - u[1]);
        var st = Math.max(1, Math.ceil(l / (rcell * 0.5)));
        for (var q = 0; q < st; q++) {
          if (occAt(u[0] + (v[0] - u[0]) * q / st, u[1] + (v[1] - u[1]) * q / st) & mask) return true;
        }
        if (u[0] < x0) x0 = u[0]; if (u[0] > x1) x1 = u[0]; if (u[1] < z0) z0 = u[1]; if (u[1] > z1) z1 = u[1];
      }
      var c0 = Math.max(0, Math.floor((x0 - rx0) / rcell)), c1 = Math.min(RW - 1, Math.floor((x1 - rx0) / rcell));
      var r0 = Math.max(0, Math.floor((z0 - rz0) / rcell)), r1 = Math.min(RH - 1, Math.floor((z1 - rz0) / rcell));
      for (var r = r0; r <= r1; r++) {
        for (var cc = c0; cc <= c1; cc++) {
          if ((occ[r * RW + cc] & mask) && pointInPoly(rx0 + (cc + 0.5) * rcell, rz0 + (r + 0.5) * rcell, p)) return true;
        }
      }
      return false;
    }

    // coarse distance to the track (chamfer transform on a 40 m grid)
    var DC = 40, DW = Math.ceil((maxX - minX + 2 * PAD) / DC) + 1, DH = Math.ceil((maxZ - minZ + 2 * PAD) / DC) + 1;
    var dist = new Float32Array(DW * DH).fill(1e9);
    for (i = 0; i < N; i++) {
      dist[Math.floor((Z[i] - rz0) / DC) * DW + Math.floor((X[i] - rx0) / DC)] = 0;
    }
    (function () {
      var x, z, c, v, D1 = DC, D2 = DC * 1.4142;
      for (z = 0; z < DH; z++) for (x = 0; x < DW; x++) {
        c = z * DW + x; v = dist[c];
        if (x > 0 && dist[c - 1] + D1 < v) v = dist[c - 1] + D1;
        if (z > 0) {
          if (dist[c - DW] + D1 < v) v = dist[c - DW] + D1;
          if (x > 0 && dist[c - DW - 1] + D2 < v) v = dist[c - DW - 1] + D2;
          if (x < DW - 1 && dist[c - DW + 1] + D2 < v) v = dist[c - DW + 1] + D2;
        }
        dist[c] = v;
      }
      for (z = DH - 1; z >= 0; z--) for (x = DW - 1; x >= 0; x--) {
        c = z * DW + x; v = dist[c];
        if (x < DW - 1 && dist[c + 1] + D1 < v) v = dist[c + 1] + D1;
        if (z < DH - 1) {
          if (dist[c + DW] + D1 < v) v = dist[c + DW] + D1;
          if (x > 0 && dist[c + DW - 1] + D2 < v) v = dist[c + DW - 1] + D2;
          if (x < DW - 1 && dist[c + DW + 1] + D2 < v) v = dist[c + DW + 1] + D2;
        }
        dist[c] = v;
      }
    })();
    function cdist(x, z) {
      var cx = Math.floor((x - rx0) / DC), cz = Math.floor((z - rz0) / DC);
      if (cx < 0 || cz < 0 || cx >= DW || cz >= DH) return 1e9;
      return dist[cz * DW + cx];
    }

    // ---------------------------------------------------------------- track analysis
    var curv = new Float64Array(N);
    (function () {
      var kk = Math.max(2, Math.round(6 / ds)), raw = new Float64Array(N), a, b, w;
      for (i = 0; i < N; i++) {
        a = wrap(i - kk); b = wrap(i + kk);
        var cr = TX[a] * TZ[b] - TZ[a] * TX[b], dt = TX[a] * TX[b] + TZ[a] * TZ[b];
        raw[i] = -Math.atan2(cr, dt) / (2 * kk * ds);   // positive = turning towards +n
      }
      for (i = 0; i < N; i++) {
        var sacc = 0;
        for (w = -5; w <= 5; w++) sacc += raw[wrap(i + w)];
        curv[i] = sacc / 11;
      }
    })();
    var straight = new Uint8Array(N);
    for (i = 0; i < N; i++) straight[i] = Math.abs(curv[i]) < 1 / 300 ? 1 : 0;
    // braking zones: a long straight followed by a tight corner
    var zones = [];
    (function () {
      var start = -1;
      for (i = 0; i < N; i++) if (!straight[i]) { start = i; break; }
      if (start < 0) return;
      var len = 0;
      for (var q = 1; q <= N; q++) {
        var idx = (start + q) % N;
        if (straight[idx]) { len++; continue; }
        if (len * ds >= 180) {
          var km = 0, ks = 0, look = Math.round(110 / ds);
          for (var w = 0; w < look; w++) {
            var cv = curv[(idx + w) % N];
            if (Math.abs(cv) > km) { km = Math.abs(cv); ks = cv > 0 ? 1 : -1; }
          }
          if (km >= 1 / 95) zones.push({ e: idx, L: len * ds, turn: ks, k: km, score: len * ds * Math.sqrt(km) });
        }
        len = 0;
      }
      zones.sort(function (a, b) { return b.score - a.score; });
    })();
    // main straight around sample 0
    var mainBack = 0, mainFwd = 0;
    (function () {
      var lim = Math.round(450 / ds);
      while (mainBack < lim && straight[wrap(-mainBack - 1)]) mainBack++;
      while (mainFwd < lim && straight[wrap(mainFwd + 1)]) mainFwd++;
      var minHalf = Math.round(70 / ds);
      if (mainBack < minHalf) mainBack = minHalf;
      if (mainFwd < minHalf) mainFwd = minHalf;
    })();
    var insideSign = (function () {
      var a = 0;
      for (i = 0; i < N; i++) { j = (i + 1) % N; a += X[i] * Z[j] - X[j] * Z[i]; }
      return a > 0 ? -1 : 1;
    })();
    // The pit lane of js/track.js (track.pit; null: no pit lane, the procedural pit of old is built). Over its samples
    // from..to (pitMask) the corridor on its side (wallPosDist / wallNegDist, LP / LN here) reaches out to the lane's
    // outer wall, which is the 6 m garage face along the boxes (unwrapped samples pitG0..pitG1).
    var PIT = (track.pit && isFinite(track.pit.from) && isFinite(track.pit.to)) ? track.pit : null;
    var pitSide = PIT ? (PIT.side > 0 ? 1 : -1) : insideSign;
    var pitMask = null, pitG0 = 0, pitG1 = -1;
    if (PIT) (function () {
      var K = wrap(PIT.to - PIT.from), i0 = PIT.from > N / 2 ? PIT.from - N : PIT.from, k, w;
      pitMask = new Uint8Array(N);
      for (k = 0; k <= K; k++) pitMask[wrap(i0 + k)] = 1;
      // the garage face: half a box pitch beyond the first and the last box ...
      var bx = Array.isArray(PIT.boxes) ? PIT.boxes : [], kmin = Infinity, kmax = -Infinity, nb = 0;
      for (k = 0; k < bx.length; k++) {
        if (!bx[k] || !isFinite(bx[k].index)) continue;
        var kb = wrap(bx[k].index - PIT.from);
        if (kb > K) continue;
        nb++;
        if (kb < kmin) kmin = kb;
        if (kb > kmax) kmax = kb;
      }
      var g0 = 0, g1 = K;
      if (nb >= 2 && kmax > kmin) {
        var half = (kmax - kmin) / (nb - 1) / 2;
        g0 = Math.max(0, Math.ceil(kmin - half)); g1 = Math.min(K, Math.floor(kmax + half));
      }
      // ... where the outer wall stands at its full distance (trims the ends, or finds it without boxes)
      var wmax = 0;
      for (k = g0; k <= g1; k++) { w = wrap(i0 + k); wmax = Math.max(wmax, pitSide > 0 ? WP[w] : WN[w]); }
      while (g0 < g1 && (pitSide > 0 ? WP[wrap(i0 + g0)] : WN[wrap(i0 + g0)]) < wmax - 0.3) g0++;
      while (g1 > g0 && (pitSide > 0 ? WP[wrap(i0 + g1)] : WN[wrap(i0 + g1)]) < wmax - 0.3) g1--;
      pitG0 = i0 + g0; pitG1 = i0 + g1;
    })();
    // trackside furniture (fence, boards, marshal posts, poles) is not put behind the pit lane
    function pitBehind(idx, side) { return !!pitMask && side === pitSide && pitMask[wrap(idx)] === 1; }
    // the pit building: its front this far behind the corridor edge (= the garage face), its height above the lane
    var PIT_FRONT = CLEAR + 0.25, PIT_H = 10.5;
    // Least distance behind the corridor edge (garage face) of a footprint's outline along the garage face on the pit
    // side; Infinity if it is not there.
    function behindFace(p) {
      var best = Infinity;
      if (!pitMask || pitG1 < pitG0) return best;
      for (var a = 0, n = p.length; a < n; a++) {
        var u = p[a], v = p[(a + 1) % n], st = Math.max(1, Math.ceil(Math.hypot(v[0] - u[0], v[1] - u[1]) / 2));
        for (var q = 0; q < st; q++) {
          var x = u[0] + (v[0] - u[0]) * q / st, z = u[1] + (v[1] - u[1]) * q / st, s = nearest(x, z, maxLim + 30);
          if (s < 0 || wrap(s - pitG0) > pitG1 - pitG0) continue;
          if ((((x - X[s]) * NX[s] + (z - Z[s]) * NZ[s]) >= 0 ? 1 : -1) !== pitSide) continue;
          best = Math.min(best, lastD - lim(s, pitSide));
        }
      }
      return best;
    }
    // Sight lines to the pit entry light curtain from the approach (the centreline 20..130 m before the entry line) to
    // three points across it: kept clear of procedural objects and trees (real buildings stay), so that nothing is put
    // in front of the curtain where the track bends towards the pit side before it.
    var sight = [], sx0 = Infinity, sx1 = -Infinity, sz0 = Infinity, sz1 = -Infinity;
    if (PIT && isFinite(PIT.entry)) (function () {
      var e = wrap(PIT.entry), wd = typeof PIT.wallD === 'function' ? Math.abs(PIT.wallD(e)) : NaN;
      var ld = typeof PIT.laneD === 'function' ? Math.abs(PIT.laneD(e)) : NaN, lh = PIT.laneHalfW || 3.5;
      var a = isFinite(wd) ? wd + (PIT.wallHalfT || 0.4) : (isFinite(ld) ? ld - lh : lim(e, pitSide) - 2 * lh);
      var b = lim(e, pitSide);
      if (!(b > a)) return;
      for (var m = 20; m <= 130; m += 10) {
        var ei = wrap(e - Math.round(m / ds));
        for (var q = 0; q < 3; q++) {
          var t = offPt(e, pitSide * (a + (b - a) * (q + 0.5) / 3));
          sight.push([X[ei], Z[ei], t[0], t[1]]);
          sx0 = Math.min(sx0, X[ei], t[0]); sx1 = Math.max(sx1, X[ei], t[0]);
          sz0 = Math.min(sz0, Z[ei], t[1]); sz1 = Math.max(sz1, Z[ei], t[1]);
        }
      }
    })();
    function inSight(x, z, r) {        // a point within r of a sight line
      if (!sight.length || x < sx0 - r || x > sx1 + r || z < sz0 - r || z > sz1 + r) return false;
      for (var a = 0; a < sight.length; a++) {
        var g = sight[a];
        if (segDist2(x, z, g[0], g[1], g[2], g[3]) < r * r) return true;
      }
      return false;
    }
    function polyInSight(p) {          // a footprint crossing (or within 1 m of) a sight line
      if (!sight.length) return false;
      var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, a, c;
      for (a = 0; a < p.length; a++) {
        x0 = Math.min(x0, p[a][0]); x1 = Math.max(x1, p[a][0]); z0 = Math.min(z0, p[a][1]); z1 = Math.max(z1, p[a][1]);
      }
      if (x1 < sx0 - 1 || x0 > sx1 + 1 || z1 < sz0 - 1 || z0 > sz1 + 1) return false;
      for (a = 0; a < p.length; a++) if (inSight(p[a][0], p[a][1], 1)) return true;
      for (c = 0; c < sight.length; c++) {
        var g = sight[c], A = [g[0], g[1]], B = [g[2], g[3]];
        if (pointInPoly(g[2], g[3], p)) return true;
        for (a = 0; a < p.length; a++) if (segsCross(A, B, p[a], p[(a + 1) % p.length])) return true;
      }
      return false;
    }
    function polysOverlap(p, q) {
      var a, b, n = p.length, m = q.length;
      for (a = 0; a < n; a++) if (pointInPoly(p[a][0], p[a][1], q)) return true;
      for (b = 0; b < m; b++) if (pointInPoly(q[b][0], q[b][1], p)) return true;
      for (a = 0; a < n; a++) {
        for (b = 0; b < m; b++) if (segsCross(p[a], p[(a + 1) % n], q[b], q[(b + 1) % m])) return true;
      }
      return false;
    }

    // ---------------------------------------------------------------- buffers
    var solid = new Buf(false), patch = new Buf(false);
    var masonry = new Buf(true), glass = new Buf(true), pitB = new Buf(true), crowd = new Buf(true);
    var signs = new Buf(true), fence = new Buf(true);
    var phases = {}, tPhase = now();
    function mark(name) { var t = now(); phases[name] = Math.round((t - tPhase) * 10) / 10; tPhase = t; }
    mark('setup');
    var counts = { buildings: 0, stands: 0, dropped: 0, fitted: 0, trees: 0, boards: 0, procBuildings: 0, decks: 0, decksSkipped: 0 };

    var PAL_MASON = prof.med ?
      [0xd9c9a8, 0xe3d2b0, 0xd6b38c, 0xe0bfa0, 0xcfa98a, 0xe8e0d0, 0xd8c0b0, 0xc9b79a, 0xe6d6c2] :
      (prof.desert ? [0xd8cbb0, 0xe0d6c0, 0xc9b99a, 0xe8e2d4, 0xbfae92] :
        [0xd6d2ca, 0xc4beb4, 0xb8a898, 0xa89080, 0xcfc8bc, 0x9a8f86, 0xd8d0c0, 0xb0a9a0]);
    var PAL_GLASS = [0xb8c8d8, 0x9fb6c8, 0xc8d4dc, 0x98b0b8, 0xb0a890, 0x8fa4b8, 0xd0d8e0];
    var PAL_ROOF = [0x77777a, 0x8a8a8c, 0x6a6c70, 0x94928e, 0x7e7a74];
    var PAL_STAND = [0x2a5aa8, 0xc8202a, 0xe8e8e6, 0xe0a020, 0x2a8a58, 0x3a3e46];
    var COL_CONC = C(0x9a9b98), COL_STEEL = C(0x5a5e64), COL_DARK = C(0x2a2c30), COL_ROOF = C(0xc9ccd0);

    function triangulate(p) {
      if (p.length === 3) return [[0, 1, 2]];
      var pts = [];
      for (var a = 0; a < p.length; a++) pts.push(new THREE.Vector2(p[a][0], p[a][1]));
      var f;
      try { f = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { f = []; }
      return f;
    }

    // ---- generic extruded building. yRef (optional): measure the height from this level instead of the lowest ground
    //      under the footprint: the pit lane surface for a building behind the garage face (a pit facade: see below)
    function addBuilding(p, kind, h, hs, yRef) {
      var n = p.length, a, g, gmin = Infinity, gmax = -Infinity, cx = 0, cz = 0;
      for (a = 0; a < n; a++) {
        g = gY(p[a][0], p[a][1]);
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        cx += p[a][0]; cz += p[a][1];
      }
      g = gY(cx / n, cz / n);
      if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      for (a = 0; a < n; a++) {
        g = gY((p[a][0] + p[(a + 1) % n][0]) / 2, (p[a][1] + p[(a + 1) % n][1]) / 2);
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
      }
      h = clamp(isFinite(h) ? h : 8, 2.5, 400);
      // a footprint straddling a steep bank (roads at different heights close together) is left out
      if (kind !== 'pit' && gmax - gmin > Math.max(5, 0.6 * h)) { counts.dropped++; return false; }
      // A pit facade measured from the lane (yRef) is textured from the lane surface at the garage face abeam of each
      // wall vertex (rv; edges split to 4 m at most), not from one level for the whole footprint: where the lane slopes
      // its garage and fascia rows then stay behind the 6 m face of js/track.js along the whole building and only the
      // glazed floor shows above the face (one level put them above the face at the downhill end). The roof is flat, h
      // above the highest of yRef and rv; above the glazing the wall takes the texture's plain top row.
      var base = gmin - 1.5, top = Math.max(gmin + h, gmax + 2.5), ref = gmin, pw = p, rv = null;
      if (yRef === yRef && isFinite(yRef)) {
        var rlo = yRef, rhi = yRef;
        if (kind === 'pit') {
          pw = densify(p, 4); rv = new Array(pw.length);
          for (a = 0; a < pw.length; a++) {
            g = faceLaneY(pw[a][0], pw[a][1]);
            rv[a] = g === g ? g : yRef;
            if (rv[a] < rlo) rlo = rv[a]; if (rv[a] > rhi) rhi = rv[a];
          }
        }
        ref = yRef; base = Math.min(gmin, rlo) - 1.5; top = Math.max(rhi + h, gmax + 2.5);
      }
      var area = Math.abs(polyArea(p));
      var r1 = h01(hs), r2 = h01(hs + 17), r3 = h01(hs + 31), r4 = h01(hs + 47);
      var style = kind === 'pit' ? 2 :
        ((kind === 'tower' || h > 40 || (area > 2200 && r1 < 0.5) || r1 < prof.glass) ? 1 : 0);
      var buf = style === 2 ? pitB : (style === 1 ? glass : masonry);
      var pal = style === 1 ? PAL_GLASS : PAL_MASON;
      var col = style === 2 ? [0.95, 0.95, 0.95] : shade(C(pal[Math.floor(r2 * pal.length)]), 0.88 + r3 * 0.2);
      var FH = style === 1 ? 3.6 : 3.2;
      var nf = Math.max(1, Math.round((top - gmin) / FH));
      var vb, vt, uo = Math.floor(r4 * 4) / 4, vo = Math.floor(r3 * 4) / 4, acc = 0;
      if (style === 2) { vb = (base - ref) / 10; vt = (top - ref) / 10; }
      else { vt = vo + nf / 4; vb = vo + (base - gmin) / ((top - gmin) / nf) / 4; }
      for (a = 0; a < pw.length; a++) {
        var b = (a + 1) % pw.length, u = pw[a], v = pw[b], len = Math.hypot(v[0] - u[0], v[1] - u[1]), u0, u1;
        if (style === 2) { u0 = acc / 12; u1 = (acc + len) / 12; acc += len; }
        else { var nb = Math.round(len / FH); u0 = uo; u1 = uo + nb / 4; }
        if (rv) {
          quad(buf, [u[0], base, u[1]], [v[0], base, v[1]], [v[0], top, v[1]], [u[0], top, u[1]], col,
               [u0, (base - rv[a]) / 10], [u1, (base - rv[b]) / 10], [u1, (top - rv[b]) / 10], [u0, (top - rv[a]) / 10]);
        } else wall(buf, u[0], u[1], v[0], v[1], base, base, top, top, col, u0, u1, vb, vt);
      }
      var roofCol = (prof.med && style === 0 && h < 17 && r4 < 0.7) ? shade(C(0xa85c3c), 0.85 + r3 * 0.3) :
        shade(C(PAL_ROOF[Math.floor(r4 * PAL_ROOF.length)]), 0.9 + r3 * 0.2);
      var f = triangulate(p);
      for (a = 0; a < f.length; a++) {
        var A = p[f[a][0]], B = p[f[a][1]], Cc = p[f[a][2]];
        triUp(solid, [A[0], top, A[1]], [B[0], top, B[1]], [Cc[0], top, Cc[1]], roofCol);
      }
      counts.buildings++;
      if (DEBUG) foot.push({ k: kind, p: p });
      return true;
    }

    // ---- grandstand: raked seating rising away from the track, optional roof
    var fenceFlag = [new Uint8Array(N), new Uint8Array(N)];   // [neg side, pos side]
    function markFence(idx, side, span) {
      var f = fenceFlag[side > 0 ? 1 : 0];
      for (var w = -span; w <= span; w++) f[wrap(idx + w)] = 1;
    }
    function lastDOf(q) { nearest(q[0], q[1], 80); return lastD; }
    function addStand(p, h, roofed, hs) {
      var n = p.length, a, dv = new Array(n), si = new Array(n), dmin = Infinity, dmax = -Infinity, g0 = Infinity;
      for (a = 0; a < n; a++) {
        si[a] = nearest(p[a][0], p[a][1], 320);
        if (si[a] < 0) return false;
        dv[a] = lastD;
        if (dv[a] < dmin) dmin = dv[a];
        if (dv[a] > dmax) dmax = dv[a];
        var g = gY(p[a][0], p[a][1]);
        if (g < g0) g0 = g;
      }
      if (dmin > 260) return false;
      if (n <= 6) {
        // simple mapped footprint: rake along the direction pointing away from the nearest piece of road,
        // so a stand standing at an angle to the track still gets a clean front and back edge
        var ccx = 0, ccz = 0;
        for (a = 0; a < n; a++) { ccx += p[a][0]; ccz += p[a][1]; }
        ccx /= n; ccz /= n;
        var cs = nearest(ccx, ccz, 400);
        if (cs >= 0) {
          var ddx = ccx - X[cs], ddz = ccz - Z[cs], dl = Math.hypot(ddx, ddz);
          if (dl > 1) {
            ddx /= dl; ddz /= dl;
            // snap to the footprint's own edge direction that is closest to it
            var bestDot = -2, ex = ddx, ez = ddz;
            for (a = 0; a < n; a++) {
              var q0 = p[a], q1 = p[(a + 1) % n], el = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
              if (el < 3) continue;
              var ux = (q1[0] - q0[0]) / el, uz = (q1[1] - q0[1]) / el;
              for (var sg = -1; sg <= 1; sg += 2) {
                var dp = (ux * ddx + uz * ddz) * sg;
                if (dp > bestDot) { bestDot = dp; ex = ux * sg; ez = uz * sg; }
                dp = (-uz * ddx + ux * ddz) * sg;
                if (dp > bestDot) { bestDot = dp; ex = -uz * sg; ez = ux * sg; }
              }
            }
            dmin = Infinity; dmax = -Infinity;
            for (a = 0; a < n; a++) {
              dv[a] = (p[a][0] - ccx) * ex + (p[a][1] - ccz) * ez;
              if (dv[a] < dmin) dmin = dv[a];
              if (dv[a] > dmax) dmax = dv[a];
            }
          }
        }
      }
      var depth = dmax - dmin;
      if (depth < 4) return false;
      var H0 = 2.2, HT = clamp(isFinite(h) ? h : 12, H0 + 0.28 * depth, H0 + 0.62 * depth);
      if (HT < 5) HT = 5;
      var base = g0 - 1.5, colS = C(PAL_STAND[Math.floor(h01(hs) * PAL_STAND.length)]);
      var fr = new Array(n), yr = new Array(n), uu = new Array(n), gl = new Array(n);
      for (a = 0; a < n; a++) {
        fr[a] = (dv[a] - dmin) / depth;
        gl[a] = Math.max(g0, Math.min(Y[si[a]], g0 + 14));
      }
      if (n <= 6) {            // compact stand: one level floor (vertices may sit next to roads at different heights)
        var gm = 0;
        for (a = 0; a < n; a++) gm += gl[a];
        gm = Math.min(gm / n, g0 + 6);
        for (a = 0; a < n; a++) gl[a] = gm;
      }
      for (a = 0; a < n; a++) {
        yr[a] = gl[a] + H0 + (HT - H0) * fr[a];
        var rel = ((si[a] - si[0] + N * 1.5) % N) - N / 2;
        uu[a] = rel * ds / 8;
      }
      var tint = shade([1, 1, 1], 0.92), roofY = function (f, q) { return gl[q] + HT + 3.0 + (1 - f) * 2.0; };
      var f3 = triangulate(p);
      for (a = 0; a < f3.length; a++) {
        var ia = f3[a][0], ib = f3[a][1], ic = f3[a][2];
        triUp(crowd, [p[ia][0], yr[ia], p[ia][1]], [p[ib][0], yr[ib], p[ib][1]], [p[ic][0], yr[ic], p[ic][1]],
              tint, tint, tint, [uu[ia], fr[ia] * depth / 8], [uu[ib], fr[ib] * depth / 8], [uu[ic], fr[ic] * depth / 8]);
        if (roofed) {
          triUp(solid, [p[ia][0], roofY(fr[ia], ia), p[ia][1]], [p[ib][0], roofY(fr[ib], ib), p[ib][1]],
                [p[ic][0], roofY(fr[ic], ic), p[ic][1]], COL_ROOF);
        }
      }
      for (a = 0; a < n; a++) {
        var b = (a + 1) % n, u = p[a], v = p[b];
        var front = fr[a] < 0.2 && fr[b] < 0.2, back = fr[a] > 0.8 && fr[b] > 0.8;
        wall(solid, u[0], u[1], v[0], v[1], base, base, yr[a], yr[b], front ? colS : COL_CONC);
        if (back) {
          var ta = roofed ? roofY(fr[a], a) : yr[a] + 1.2, tb = roofed ? roofY(fr[b], b) : yr[b] + 1.2;
          wall(solid, u[0], u[1], v[0], v[1], yr[a], yr[b], ta, tb, shade(colS, 0.8));
        }
        if (roofed && front) {
          wall(solid, u[0], u[1], v[0], v[1], roofY(fr[a], a) - 0.9, roofY(fr[b], b) - 0.9, roofY(fr[a], a), roofY(fr[b], b), colS);
        }
        if (roofed && !front && !back && Math.abs(fr[a] - fr[b]) > 0.5) {   // side: slim roof stays
          var lo = fr[a] > fr[b] ? a : b;
          box(solid, p[lo][0], p[lo][1], yr[lo], roofY(fr[lo], lo), 1, 0, 0.25, 0.25, COL_STEEL);
        }
        if (lastDOf(p[a]) < 70) markFence(si[a], ((u[0] - X[si[a]]) * NX[si[a]] + (u[1] - Z[si[a]]) * NZ[si[a]]) >= 0 ? 1 : -1, 8);
      }
      counts.stands++;
      if (DEBUG) foot.push({ k: 'grandstand', p: p });
      return true;
    }

    // ---- samples over which no mapped deck is built (lazily, for addBridge): the upper road of the track's own bridges
    //      (track.bridges, Suzuka: a bridge outline holding it is the lap's own deck) and the covered stretches of
    //      js/tunnels.js (F1.TUNNEL_DATA when loaded: the tunnel module builds the structure over them), each +-12 m
    var noDeck = null;
    function locateLL(ll, f) {         // a [lat, lon] on the lap (f: lap fraction, the search window) -> sample or -1
      var g = trackData && trackData.geo, hint = isFinite(f) ? wrap(Math.round((f - Math.floor(f)) * N)) : -1;
      if (!ll || !g || !isFinite(g.kx) || !isFinite(g.kz)) return hint;
      var x = (ll[1] - g.lon0) * g.kx, z = (ll[0] - g.lat0) * g.kz, best = -1, bd = Infinity;
      if (hint >= 0) {
        for (var q = -Math.max(40, Math.round(N * 0.04)); q <= Math.max(40, Math.round(N * 0.04)); q++) {
          var s = wrap(hint + q), dx = X[s] - x, dz = Z[s] - z;
          if (dx * dx + dz * dz < bd) { bd = dx * dx + dz * dz; best = s; }
        }
        if (bd < 60 * 60) return best;
      }
      return nearest(x, z, 60);
    }
    function noDeckAt(s) {
      if (!noDeck) {
        noDeck = new Uint8Array(N);
        var mg = Math.ceil(12 / ds), k, K, a;
        var br = Array.isArray(track.bridges) ? track.bridges : [];
        for (a = 0; a < br.length; a++) {
          if (!br[a] || !isFinite(br[a].deckFrom) || !isFinite(br[a].deckTo)) continue;
          K = wrap(br[a].deckTo - br[a].deckFrom);
          if (K > N / 4) continue;
          for (k = -mg; k <= K + mg; k++) noDeck[wrap(br[a].deckFrom + k)] = 1;
        }
        var tl = F1.TUNNEL_DATA && trackData && trackData.id ? F1.TUNNEL_DATA[trackData.id] : null;
        if (Array.isArray(tl)) {
          for (a = 0; a < tl.length; a++) {
            if (!tl[a]) continue;
            var ia = locateLL(tl[a].from, tl[a].fFrom), ib = locateLL(tl[a].to, tl[a].fTo);
            if (ia < 0 || ib < 0) continue;
            K = wrap(ib - ia);
            if (K > N / 2) continue;
            for (k = -mg; k <= K + mg; k++) noDeck[wrap(ia + k)] = 1;
          }
        }
      }
      return noDeck[wrap(s)] === 1;
    }

    // ---- bridge deck over (or away from) the road. it: the data entry (optional): c = underside above the road (m, at
    //      least GANTRY_CLEAR_H), t = deck thickness (m, default 1.4; a thick one, a building spanning the road, has no
    //      parapet), o = OSM way id (debug). Over the road the deck's footprint is stamped: no tree or procedural object
    //      stands under it.
    function addBridge(p, h, it) {
      var n = p.length, a, inside = [], gmin = Infinity, top = -Infinity;
      var T = it && isFinite(it.t) && it.t > 0.3 ? Math.min(+it.t, 40) : 1.4;
      var clr = it && isFinite(it.c) && it.c > GANTRY_CLEAR_H ? Math.min(+it.c, 120) : GANTRY_CLEAR_H;
      for (a = 0; a < n; a++) gmin = Math.min(gmin, gY(p[a][0], p[a][1]));
      var c = polyClearance(p);
      if (c >= CLEAR) {
        top = gmin + Math.max(3, h);
      } else {
        var bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
        for (a = 0; a < n; a++) {
          bx0 = Math.min(bx0, p[a][0]); bx1 = Math.max(bx1, p[a][0]); bz0 = Math.min(bz0, p[a][1]); bz1 = Math.max(bz1, p[a][1]);
        }
        var pad = maxLim + CLEAR + 1, ymax = -Infinity;
        for (a = 0; a < N; a++) {
          if (X[a] < bx0 - pad || X[a] > bx1 + pad || Z[a] < bz0 - pad || Z[a] > bz1 + pad) continue;
          var ins = pointInPoly(X[a], Z[a], p), near = ins;
          if (!near) {
            for (var e = 0; e < n && !near; e++) {
              var q = p[(e + 1) % n];
              if (segDist2(X[a], Z[a], p[e][0], p[e][1], q[0], q[1]) < pad * pad) near = true;
            }
          }
          if (ins) inside.push(a);
          if (near) ymax = Math.max(ymax, Y[a] + Math.max(LP[a], LN[a]) * 0.12);
        }
        if (inside.length * ds > 60 || ymax === -Infinity) return false;   // the road runs along it: leave it out
        for (a = 0; a < inside.length; a++) {
          if (noDeckAt(inside[a])) { counts.decksSkipped++; return true; }   // the lap's own deck / a tunnel's job
        }
        top = Math.max(gmin + h, ymax + clr + T);
      }
      var bot = top - T, f = triangulate(p), col = COL_CONC, rail = T > 2.5 ? 0 : 1.0;
      for (a = 0; a < f.length; a++) {
        var A = p[f[a][0]], B = p[f[a][1]], D = p[f[a][2]];
        triUp(solid, [A[0], top, A[1]], [B[0], top, B[1]], [D[0], top, D[1]], shade(col, 0.8));
        triUp(solid, [A[0], bot, A[1]], [B[0], bot, B[1]], [D[0], bot, D[1]], shade(col, 0.7));
      }
      for (a = 0; a < n; a++) {
        var u = p[a], v = p[(a + 1) % n];
        wall(solid, u[0], u[1], v[0], v[1], bot, bot, top + rail, top + rail, col);
        if (isClear(u[0], u[1], CLEAR + 1.2)) {
          box(solid, u[0], u[1], gY(u[0], u[1]) - 1.5, bot, 1, 0, 0.7, 0.7, shade(col, 0.9));
          if (DEBUG) foot.push({ k: 'pier', p: [[u[0] - 0.7, u[1] - 0.7], [u[0] + 0.7, u[1] - 0.7], [u[0] + 0.7, u[1] + 0.7], [u[0] - 0.7, u[1] + 0.7]] });
        }
      }
      if (c < CLEAR) { stampPoly(p, BIT_B); counts.decks++; }
      if (DEBUG) foot.push({ k: 'bridge', p: p, minY: bot, top: top, over: c < CLEAR, src: it ? it.src : -1, o: it && it.o ? it.o : null });
      return true;
    }

    // ================================================================ 1. real data: buildings
    var dataStandsNear = 0, dataPit = false, dataNearBuildings = 0;
    var dataFeet = [];        // with track.pit: the real buildings that stand, [polygon, x0, x1, z0, z1]
    var pitLater = [];        // with track.pit: the real pit buildings next to the garage face (placed last)
    // A real pit building next to the pit lane (the corridor may have clipped its front to the garage face): the
    // lane surface there, so that it is measured from the lane and rises above the garage face; NaN if it is not.
    function pitRefY(p) {
      var y = NaN;
      for (var a = 0; a < p.length; a++) {
        var s = nearest(p[a][0], p[a][1], maxLim + 40);
        if (s < 0 || !pitMask[s]) continue;
        if ((((p[a][0] - X[s]) * NX[s] + (p[a][1] - Z[s]) * NZ[s]) >= 0 ? 1 : -1) !== pitSide) continue;
        if (lastD - lim(s, pitSide) > 30) continue;
        var v = sY(s, pitSide * wallD(s, pitSide));
        if (!(v <= y)) y = v;
      }
      return y;
    }
    // The lane surface at the garage face (the pit-side corridor edge) abeam of (x, z), interpolated between samples;
    // beyond the ends of the lane (up to 40 m) the lane at its end; NaN where (x, z) is not beside the pit lane.
    // (the texture level of a pit facade's wall vertex, see addBuilding)
    function faceLaneY(x, z) {
      if (!pitMask) return NaN;
      var s = nearest(x, z, maxLim + 80);
      if (s < 0 || (((x - X[s]) * NX[s] + (z - Z[s]) * NZ[s]) >= 0 ? 1 : -1) !== pitSide) return NaN;
      if (!pitMask[s]) {
        var kf = wrap(PIT.from - s), kt = wrap(s - PIT.to);
        if (Math.min(kf, kt) * ds > 40) return NaN;
        s = wrap(kf < kt ? PIT.from : PIT.to);
      }
      var al = (x - X[s]) * TX[s] + (z - Z[s]) * TZ[s], o = wrap(al >= 0 ? s + 1 : s - 1);
      var y = sY(s, pitSide * wallD(s, pitSide));
      if (pitMask[o]) y += (sY(o, pitSide * wallD(o, pitSide)) - y) * Math.min(1, Math.abs(al) / ds);
      return y;
    }
    (function () {
      var list = [], a, b, p;
      for (a = 0; a < dBuildings.length; a++) {
        b = dBuildings[a];
        if (!b) continue;
        p = cleanInput(b.p);
        if (!p) continue;
        var cx = 0, cz = 0;
        for (var q = 0; q < p.length; q++) { cx += p[q][0]; cz += p[q][1]; }
        cx /= p.length; cz /= p.length;
        var d = cdist(cx, cz);
        if (d > PAD - 60) continue;
        list.push({ b: b, p: p, d: d, h: isFinite(b.h) ? +b.h : 8, idx: a });
      }
      if (list.length > MAX_BUILDINGS) {       // keep what is near or tall
        list.sort(function (m, o) { return (m.d - m.h * 4) - (o.d - o.h * 4); });
        list.length = MAX_BUILDINGS;
        list.sort(function (m, o) { return m.idx - o.idx; });
      }
      for (a = 0; a < list.length; a++) {
        var it = list[a], kind = it.b.k || 'building';
        p = orient(it.p);
        if (Math.abs(polyArea(p)) < 6) continue;
        if (kind === 'bridge') {
          if (!addBridge(p, it.h, { c: it.b.c, t: it.b.t, o: it.b.o, src: it.idx })) counts.dropped++;
          continue;
        }
        var fitted = fitPoly(p);
        if (!fitted) { counts.dropped++; continue; }
        if (fitted !== p) { counts.fitted++; p = orient(fitted); }
        var hs = (seed + it.idx * 2654435761) | 0, built;
        if (kind === 'grandstand') {
          if ((built = addStand(p, it.h, h01(hs + 5) < 0.45 || Math.abs(polyArea(p)) > 1500, hs))) {
            if (it.d < 120) dataStandsNear++;
          } else built = addBuilding(p, 'building', Math.min(it.h, 12), hs);
        } else {
          // with track.pit: a real pit building next to the garage face is handled below, once all the real buildings
          // are known; a plain building standing right against the face is the pit building there (pit facade, at
          // least PIT_H - 0.5 above the lane)
          var yr = (kind === 'pit' || kind === 'building') && PIT ? pitRefY(p) : NaN, bf = yr === yr ? behindFace(p) : Infinity;
          if (kind === 'pit') dataPit = true;
          if (it.d < 200) dataNearBuildings++;
          if (kind === 'pit' && bf < 15) { pitLater.push({ p: p, h: it.h, hs: hs, y: yr }); continue; }
          if (kind === 'building' && bf <= PIT_FRONT + 2.5) built = addBuilding(p, 'pit', Math.max(it.h, PIT_H - 0.5), hs, yr);
          else if (kind === 'pit' && yr === yr) built = addBuilding(p, kind, Math.max(it.h, 9), hs, yr);
          else built = addBuilding(p, kind, it.h, hs);
        }
        stampPoly(p, BIT_B);
        if (PIT && built) dataFeet.push(footBox(p));
      }
      // The real pit buildings next to the garage face: the lane of js/track.js is laid out, not mapped, so a real pit
      // building often stands a few metres back from the face, or at a slant. Its front (the edges facing the track
      // along the face) is brought forward to the face, unless that would run into another real building; it gets the
      // pit facade and is at least PIT_H - 0.5 tall above the lane.
      for (a = 0; a < pitLater.length; a++) {
        var pl = pitLater[a], sp = snapToFace(pl.p);
        if (sp) {
          var fb = footBox(sp), clash = false;
          for (q = 0; q < dataFeet.length && !clash; q++) {
            var e = dataFeet[q];
            if (e[2] < fb[1] || e[1] > fb[2] || e[4] < fb[3] || e[3] > fb[4]) continue;
            if (polysOverlap(sp, e[0])) clash = true;
          }
          if (!clash) { pl.p = sp; counts.fitted++; }
        }
        if (addBuilding(pl.p, 'pit', Math.max(pl.h, PIT_H - 0.5), pl.hs, pl.y)) dataFeet.push(footBox(pl.p));
        stampPoly(pl.p, BIT_B);
      }
    })();
    function footBox(p) {
      var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (var q = 0; q < p.length; q++) {
        x0 = Math.min(x0, p[q][0]); x1 = Math.max(x1, p[q][0]); z0 = Math.min(z0, p[q][1]); z1 = Math.max(z1, p[q][1]);
      }
      return [p, x0, x1, z0, z1];
    }
    // the front edges of a footprint (outward normal towards the track, midpoint along the garage face) moved forward to
    // PIT_FRONT + 0.3 behind the corridor edge; null if nothing moves or the result is not valid
    function snapToFace(p0) {
      var p = densify(p0, 4), n = p.length, q = p.map(function (v) { return [v[0], v[1]]; }), front = new Uint8Array(n);
      var a, s, moved = 0;
      if (polyArea(p) > 0) return null;
      for (a = 0; a < n; a++) {
        var u = p[a], v = p[(a + 1) % n], l = Math.hypot(v[0] - u[0], v[1] - u[1]);
        if (l < 0.3) continue;
        var ox = -(v[1] - u[1]) / l, oz = (v[0] - u[0]) / l, mx = (u[0] + v[0]) / 2, mz = (u[1] + v[1]) / 2;
        s = nearest(mx, mz, maxLim + 40);
        if (s < 0 || wrap(s - pitG0) > pitG1 - pitG0) continue;
        if ((((mx - X[s]) * NX[s] + (mz - Z[s]) * NZ[s]) >= 0 ? 1 : -1) !== pitSide) continue;
        if (-(ox * NX[s] + oz * NZ[s]) * pitSide < 0.6) continue;
        front[a] = 1; front[(a + 1) % n] = 1;
      }
      for (a = 0; a < n; a++) {
        if (!front[a]) continue;
        s = nearest(p[a][0], p[a][1], maxLim + 40);
        if (s < 0) continue;
        var dx = p[a][0] - X[s], dz = p[a][1] - Z[s], along = dx * TX[s] + dz * TZ[s];
        var L = lim(s, pitSide) + PIT_FRONT + 0.3;
        if ((dx * NX[s] + dz * NZ[s]) * pitSide <= L) continue;
        q[a] = [X[s] + TX[s] * along + NX[s] * pitSide * L, Z[s] + TZ[s] * along + NZ[s] * pitSide * L];
        moved++;
      }
      if (!moved) return null;
      q = simplify(q);
      if (!q || selfIntersects(q)) return null;
      q = orient(q);
      if (polyClearance(q) < CLEAR || Math.abs(polyArea(q)) < Math.abs(polyArea(p0))) return null;
      return q;
    }

    mark('dataBuildings');
    // ================================================================ 2. real data: areas -> raster
    var hasAreaData = false;
    (function () {
      var bits = { water: BIT_WATER, sand: BIT_SAND, asphalt: BIT_ASPH, urban: BIT_URBAN, forest: BIT_FOREST, grass: BIT_GRASS };
      for (var a = 0; a < dAreas.length; a++) {
        var ar = dAreas[a];
        if (!ar || !bits[ar.k]) continue;
        var p = cleanInput(ar.p);
        if (!p) continue;
        fillPoly(p, bits[ar.k]);
        hasAreaData = true;
      }
    })();

    mark('areas');
    // ================================================================ 3. procedural trackside objects
    function offPt(idx, d) { return [X[idx] + NX[idx] * d, Z[idx] + NZ[idx] * d]; }
    function lim(idx, side) { return side > 0 ? LP[idx] : LN[idx]; }
    function wallD(idx, side) { return side > 0 ? WP[idx] : WN[idx]; }
    function canPlace(p) {
      return !selfIntersects(p) && polyClearance(p) >= CLEAR + 0.1 && !polyHitsOcc(p, BIT_B) && !polyInSight(p);
    }
    // footprint following the track between samples i0..i1 (i1 > i0, unwrapped) on one side
    function stripPoly(i0, i1, side, off0, off1) {
      var L = 0, a, fr = [], bk = [], stp = Math.max(1, Math.round(6 / ds));
      for (a = i0; a <= i1; a++) L = Math.max(L, lim(wrap(a), side));
      for (a = i0; ; a += stp) {
        if (a > i1) a = i1;
        var w = wrap(a);
        fr.push(offPt(w, side * (L + off0)));
        bk.push(offPt(w, side * (L + off1)));
        if (a === i1) break;
      }
      return orient(fr.concat(bk.reverse()));
    }
    function tryStrip(i0, i1, side, offs, depth) {
      for (var a = 0; a < offs.length; a++) {
        var p = stripPoly(i0, i1, side, CLEAR + offs[a], CLEAR + offs[a] + depth);
        if (p.length >= 4 && canPlace(p)) return p;
      }
      return null;
    }

    // ---- start/finish gantry (the only thing over the road)
    (function () {
      var g = wrap(Math.round(6 / ds));
      var tx = TX[g], tz = TZ[g], ok = false, dP, dN, ext;
      // Beside the pit lane (track.pit) the gantry is cantilevered from the far side: nothing of it stands in or spans
      // the lane; its pit-side end hangs over the pit wall, or over the road edge where the wall is open there or where
      // a light curtain stands within 15 m (the entry / exit line next to the start line: the beam keeps clear of it, and
      // goes over its top, so that a driver arriving sees the whole curtain under the beam, not its top behind it).
      var cant = pitMask && pitMask[g] ? pitSide : 0, reach = 0, lw = cant ? 0.42 : 0.3, nearC = false;
      if (cant) {
        var wdg = typeof PIT.wallD === 'function' ? Math.abs(PIT.wallD(g)) : NaN;
        var hwg = isFinite(S[g].halfW) ? S[g].halfW : nomHalf;
        [PIT.entry, PIT.exit].forEach(function (c) {
          if (isFinite(c) && Math.abs(((wrap(c - g) + N / 2) % N) - N / 2) * ds < 15) nearC = true;
        });
        reach = wdg > hwg && !nearC ? wdg : hwg - 0.2;
      }
      for (ext = 0; ext < 6 && !ok; ext++) {
        dP = cant > 0 ? reach - 0.3 : LP[g] + CLEAR + 0.45 + ext;
        dN = cant < 0 ? reach - 0.3 : LN[g] + CLEAR + 0.45 + ext;
        ok = true;
        for (var s = -1; s <= 1 && ok; s += 2) {
          if (s === cant) continue;
          var c = offPt(g, s > 0 ? dP : -dN);
          for (var q = 0; q < 4; q++) {
            if (!isClear(c[0] + ((q & 1) ? lw : -lw), c[1] + ((q & 2) ? lw : -lw), CLEAR)) ok = false;
          }
        }
      }
      if (!ok) return;
      var y0 = Math.max(sY(g, 0), sY(g, cant > 0 ? reach : WP[g]), sY(g, cant < 0 ? -reach : -WN[g]));
      var yb = y0 + (nearC ? GANTRY_CURTAIN_H : GANTRY_CLEAR_H), yt = yb + 1.5;
      var a = offPt(g, dP), b = offPt(g, -dN);
      if (cant <= 0) box(solid, a[0], a[1], gY(a[0], a[1]) - 1.5, yt, tx, tz, lw, lw, COL_STEEL);
      if (cant >= 0) box(solid, b[0], b[1], gY(b[0], b[1]) - 1.5, yt, tx, tz, lw, lw, COL_STEEL);
      var mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, halfSpan = (dP + dN) / 2 + 0.3;
      box(solid, mx, mz, yb, yt, NX[g], NZ[g], halfSpan, 0.45, COL_DARK);
      // faces towards the cars arriving (-t): driver's left is +n, so u runs from +n to -n
      var fx = mx - tx * 0.47, fz = mz - tz * 0.47;
      function face(l0, l1, uv) {   // lateral range measured from the beam centre, +n = driver's left
        var p0 = [fx + NX[g] * l0, fz + NZ[g] * l0], p1 = [fx + NX[g] * l1, fz + NZ[g] * l1];
        quad(signs, [p0[0], yb + 0.08, p0[1]], [p1[0], yb + 0.08, p1[1]], [p1[0], yt - 0.08, p1[1]], [p0[0], yt - 0.08, p0[1]],
             [1, 1, 1], [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]);
      }
      var mid = (dP - dN) / 2 - (dP - dN) / 2;   // beam centre is already the mid point of the legs
      var cen = (dN - dP) / 2;                   // lateral position of the road centre relative to the beam centre
      face(cen + 1.3 + mid, cen - 1.3 + mid, LIGHTS_UV);
      var bi = Math.floor(rnd() * BANNERS.length);
      if (halfSpan - 0.4 - (cen + 1.5) > 3) face(halfSpan - 0.4, cen + 1.5, bannerUV(bi));
      if ((cen - 1.5) - (-halfSpan + 0.4) > 3) face(cen - 1.5, -halfSpan + 0.4, bannerUV((bi + 2) % BANNERS.length));
      if (DEBUG) {
        if (cant <= 0) foot.push({ k: 'gantry-leg', p: [[a[0] - lw, a[1] - lw], [a[0] + lw, a[1] - lw], [a[0] + lw, a[1] + lw], [a[0] - lw, a[1] + lw]] });
        if (cant >= 0) foot.push({ k: 'gantry-leg', p: [[b[0] - lw, b[1] - lw], [b[0] + lw, b[1] - lw], [b[0] + lw, b[1] + lw], [b[0] - lw, b[1] + lw]] });
        foot.push({ k: 'gantry-beam', sample: g, minY: yb });
      }
    })();

    // ---- with track.pit: the pit building right behind the garage face of js/track.js.
    //      The lane, its pit wall, the boxes, the garage face (6 m) and the light curtains are track.js's, inside the
    //      corridor. Behind the garage face (outside corridor + CLEAR) stands the pit building, along it, facing the lane
    //      and rising above it: the real one (OSM 'pit', its front possibly clipped to the corridor by fitPoly) where the
    //      data has a building there, a procedural one (the pit texture: its garages are hidden by the face, the glazed
    //      floor shows above it) over the rest; then the control tower beyond its downstream end and the paddock
    //      (asphalt) behind it. No lane asphalt and no pit wall stands (the lane and the pit wall are track.js's).
    function pitBuilding() {
      if (pitG1 < pitG0) return;
      var FRONT = PIT_FRONT, DEPTH = 16, H = PIT_H, n = pitG1 - pitG0 + 1, a, q;
      function inData(x, z) {
        for (var f = 0; f < dataFeet.length; f++) {
          var e = dataFeet[f];
          if (x >= e[1] && x <= e[2] && z >= e[3] && z <= e[4] && pointInPoly(x, z, e[0])) return true;
        }
        return false;
      }
      function hitsData(p) {        // exact (the occupancy raster is too coarse to fit a block in front of a building)
        var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, b;
        for (b = 0; b < p.length; b++) {
          x0 = Math.min(x0, p[b][0]); x1 = Math.max(x1, p[b][0]); z0 = Math.min(z0, p[b][1]); z1 = Math.max(z1, p[b][1]);
        }
        for (b = 0; b < dataFeet.length; b++) {
          var e = dataFeet[b];
          if (e[2] < x0 || e[1] > x1 || e[4] < z0 || e[3] > z1) continue;
          if (polysOverlap(p, e[0])) return true;
        }
        return false;
      }
      // footprint along the garage face from unwrapped sample a0 to a1, off0..off1 behind the corridor edge;
      // .y = the lane surface at the face (the building's height is measured from it)
      function slab(a0, a1, off0, off1) {
        var stp = Math.max(1, Math.round(4 / ds)), fr = [], bk = [], y = -Infinity;
        for (var b = a0; ; b += stp) {
          if (b > a1) b = a1;
          var w = wrap(b), L = lim(w, pitSide);
          fr.push(offPt(w, pitSide * (L + off0))); bk.push(offPt(w, pitSide * (L + off1)));
          y = Math.max(y, sY(w, pitSide * wallD(w, pitSide)));
          if (b === a1) break;
        }
        var p = orient(fr.concat(bk.reverse()));
        p.y = y; p.a0 = a0; p.a1 = a1;
        return p;
      }
      // samples of the garage face with a real building standing right against it (it is the pit building there)
      var cov = new Uint8Array(n);
      for (a = 0; a < n; a++) {
        var w = wrap(pitG0 + a), pt = offPt(w, pitSide * (lim(w, pitSide) + FRONT + 1.5));
        if (inData(pt[0], pt[1])) cov[a] = 1;
      }
      // procedural blocks over the rest, about 30 m each (the roof steps where the lane climbs); in front of a real
      // building standing further back a block is made shallower, where even that does not fit it is halved. All are
      // checked before any is stamped (neighbours touch).
      var blocks = [], minLen = Math.max(2, Math.round(9 / ds)), segLen = Math.max(minLen, Math.round(30 / ds));
      var DEPTHS = [DEPTH, 12, 9, 6.5, 4.5, 3], TRIMS = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2], [2, 2]];
      function fit(a0, a1) {
        if (a1 - a0 < minLen) return;
        for (var t = 0; t < DEPTHS.length; t++) {
          var p = slab(a0, a1, FRONT, FRONT + DEPTHS[t]);
          if (selfIntersects(p) || polyClearance(p) < CLEAR + 0.1 || polyInSight(p)) break;
          for (var r = 0; r < TRIMS.length; r++) {        // shortened a little where it meets a real building's end
            var b0 = a0 + TRIMS[r][0], b1 = a1 - TRIMS[r][1];
            if (b1 - b0 < minLen || hitsData(slab(b0, b1, FRONT - 0.2, FRONT + DEPTHS[t] + 0.4))) continue;
            var pb = r ? slab(b0, b1, FRONT, FRONT + DEPTHS[t]) : p;
            pb.depth = DEPTHS[t];
            blocks.push(pb);
            return;
          }
        }
        var m = Math.floor((a0 + a1) / 2);
        fit(a0, m); fit(m, a1);
      }
      for (a = 0; a < n;) {
        if (cov[a]) { a++; continue; }
        var r0 = a;
        while (a < n && !cov[a]) a++;
        var nSeg = Math.max(1, Math.round((a - 1 - r0) / segLen));
        for (q = 0; q < nSeg; q++) {
          fit(pitG0 + r0 + Math.round((a - 1 - r0) * q / nSeg), pitG0 + r0 + Math.round((a - 1 - r0) * (q + 1) / nSeg));
        }
      }
      for (a = 0; a < blocks.length; a++) {
        addBuilding(blocks[a], 'pit', H, seed + 101, blocks[a].y);
        if (blocks[a].depth === DEPTH) fillPoly(slab(blocks[a].a0, blocks[a].a1, FRONT + DEPTH, FRONT + DEPTH + 26), BIT_ASPH);   // paddock
      }
      for (a = 0; a < blocks.length; a++) stampPoly(blocks[a], BIT_B);
      counts.pitBlocks = blocks.length;
      // control tower beyond the downstream end (where the track has no pit building of its own)
      if (dataPit || !blocks.length) return;
      var tries = [[10, 0], [16, 0], [10, 6], [24, 0], [16, 8], [32, 4]], sp = Math.round(6 / ds);
      for (var t = 0; t < tries.length; t++) {
        var ti = pitG1 + Math.round(tries[t][0] / ds), wi = wrap(ti), Lt = 0;
        for (q = -sp; q <= sp; q++) Lt = Math.max(Lt, lim(wrap(ti + q), pitSide));
        var tc = offPt(wi, pitSide * (Lt + CLEAR + 1.5 + 4.5 + tries[t][1]));
        var tp = rectPoly(tc[0], tc[1], TX[wi], TZ[wi], 4.5, 4.5);
        if (!canPlace(tp)) continue;
        var ty = sY(wi, pitSide * wallD(wi, pitSide));
        addBuilding(tp, 'tower', 24, seed + 103, ty);
        stampPoly(tp, BIT_B);
        box(solid, tc[0], tc[1], ty + 24, ty + 25.6, TX[wi], TZ[wi], 5.6, 5.6, COL_DARK, C(0x8a8c90));
        break;
      }
    }

    // ---- pit building + control tower + pit wall stands (the procedural pit of a track without track.pit)
    (function () {
      var mSpan = Math.round(40 / ds);
      markFence(0, 1, Math.max(mainBack, mainFwd)); markFence(0, -1, Math.max(mainBack, mainFwd));
      if (PIT) { pitBuilding(); return; }
      if (dataPit) return;
      var back = Math.min(mainBack, Math.round(230 / ds)), fwd = Math.min(mainFwd, Math.round(70 / ds));
      var tries = [[pitSide, 1], [-pitSide, 1], [pitSide, 0.6], [-pitSide, 0.6]], p = null, side = pitSide, i0 = 0, i1 = 0;
      for (var a = 0; a < tries.length && !p; a++) {
        side = tries[a][0];
        i0 = -Math.round(back * tries[a][1]); i1 = Math.round(fwd * tries[a][1]);
        if ((i1 - i0) * ds < 60) continue;
        p = tryStrip(i0, i1, side, [10, 14, 20], 15);
      }
      if (!p) return;
      pitSide = side;
      var lane = stripPoly(i0 - 8, i1 + 8, side, CLEAR, CLEAR + 22);
      fillPoly(lane, BIT_ASPH);
      var front = -1;
      for (var fo = 0; fo < 3 && front < 0; fo++) { var tp0 = stripPoly(i0, i1, side, CLEAR + [10, 14, 20][fo], CLEAR + [10, 14, 20][fo] + 15); if (canPlace(tp0)) front = [10, 14, 20][fo]; }
      var segN = Math.max(1, Math.round((i1 - i0) * ds / 36)), Lmax = 0;
      for (var w0 = i0; w0 <= i1; w0++) Lmax = Math.max(Lmax, lim(wrap(w0), side));
      for (var sg = 0; sg < segN; sg++) {
        var s0 = i0 + Math.round((i1 - i0) * sg / segN), s1 = i0 + Math.round((i1 - i0) * (sg + 1) / segN);
        var sp = orient([offPt(wrap(s0), side * (Lmax + CLEAR + front)), offPt(wrap(s1), side * (Lmax + CLEAR + front)),
                         offPt(wrap(s1), side * (Lmax + CLEAR + front + 15)), offPt(wrap(s0), side * (Lmax + CLEAR + front + 15))]);
        if (polyClearance(sp) < CLEAR) continue;
        var ym = Math.max(Y[wrap(s0)], Y[wrap(s1)]), gm = Math.min(gY(sp[0][0], sp[0][1]), gY(sp[1][0], sp[1][1]), gY(sp[2][0], sp[2][1]), gY(sp[3][0], sp[3][1]));
        addBuilding(sp, 'pit', 9.5 + Math.max(0, Math.min(12, ym - gm)), seed + 101);
      }
      stampPoly(p, BIT_B);
      // control tower beyond the downstream end
      var ti = wrap(i1 + Math.round(12 / ds)), Lt = lim(ti, side) + CLEAR + 14 + 5;
      var tc = offPt(ti, side * Lt);
      var tp = orient([[tc[0] - 4.5, tc[1] - 4.5], [tc[0] + 4.5, tc[1] - 4.5], [tc[0] + 4.5, tc[1] + 4.5], [tc[0] - 4.5, tc[1] + 4.5]]);
      if (canPlace(tp)) {
        addBuilding(tp, 'tower', 24, seed + 103);
        stampPoly(tp, BIT_B);
        var ty = gY(tc[0], tc[1]) + 24;
        box(solid, tc[0], tc[1], ty, ty + 1.6, 1, 0, 5.6, 5.6, COL_DARK, C(0x8a8c90));
      }
      // timing stands on the pit wall
      var stp = Math.round(26 / ds);
      for (var w = i0 + stp; w < i1 - 2; w += stp) {
        var wi = wrap(w), c = offPt(wi, side * (lim(wi, side) + CLEAR + 1.0));
        var hb = box(null_buf(), c[0], c[1], 0, 1, TX[wi], TZ[wi], 1.6, 0.6, COL_DARK);
        var okc = true;
        for (var q = 0; q < 4; q++) if (!isClear(hb[q][0], hb[q][1], CLEAR)) okc = false;
        if (!okc || polyHitsOcc(hb, BIT_B)) continue;
        var by = sY(wi, side * wallD(wi, side));
        box(solid, c[0], c[1], by - 1.0, by + 2.5, TX[wi], TZ[wi], 1.6, 0.6, C(0x3a4048), C(0xd8dadc));
        if (DEBUG) foot.push({ k: 'pitwall-stand', p: hb });
      }
    })();
    function null_buf() { return { p: [], n: [], c: [], u: null, tris: 0 }; }

    // ---- procedural grandstands (main straight + biggest braking zones) when the data has few
    (function () {
      if (dataStandsNear >= 3) return;
      var made = 0, segLen = Math.round(96 / ds), gap = Math.round(8 / ds);
      var side = -pitSide, a0 = -Math.min(mainBack, Math.round(260 / ds)), a1 = Math.min(mainFwd, Math.round(160 / ds));
      for (var a = a0; a + Math.round(40 / ds) <= a1 && made < 4; a += segLen + gap) {
        var b = Math.min(a1, a + segLen);
        var p = tryStrip(a, b, side, [4, 9, 15], 17);
        if (p && addStand(p, 14, true, seed + 200 + made)) { stampPoly(p, BIT_B); made++; }
      }
      var zmax = Math.min(zones.length, 4);
      for (var zi = 0; zi < zmax; zi++) {
        var zn = zones[zi], os = -zn.turn;
        var i0 = zn.e - Math.round(100 / ds), i1 = zn.e + Math.round(10 / ds);
        var p2 = tryStrip(i0, i1, os, [6, 11, 18], 14);
        if (p2 && addStand(p2, 11, (zi & 1) === 0, seed + 230 + zi)) stampPoly(p2, BIT_B);
      }
    })();

    mark('pitStands');
    // ---- city blocks beside the road (fallback when there is little real data)
    var isCityBuild = prof.city && dataNearBuildings < 40;
    function rectPoly(cx, cz, ax, az, ha, hb) {
      var bx = az, bz = -ax;
      return orient([[cx - ax * ha - bx * hb, cz - az * ha - bz * hb], [cx + ax * ha - bx * hb, cz + az * ha - bz * hb],
                     [cx + ax * ha + bx * hb, cz + az * ha + bz * hb], [cx - ax * ha + bx * hb, cz - az * ha + bz * hb]]);
    }
    function cityHeight(far) {
      var h = prof.cityH[0] + rnd() * (prof.cityH[1] - prof.cityH[0]);
      if (rnd() < prof.tall * (far ? 1.6 : 1)) h *= 1.8 + rnd() * 1.8;
      return h;
    }
    (function () {
      if (!isCityBuild) return;
      for (var sd = -1; sd <= 1; sd += 2) {
        var s = rnd() * 20;
        while (s < track.length - 10) {
          var w = 14 + rnd() * 28, depth = 13 + rnd() * 14;
          var idx = wrap(Math.round((s + w / 2) / ds)), placed = false;
          for (var tr = 0; tr < 2 && !placed; tr++) {
            var front = lim(idx, sd) + CLEAR + 0.8 + tr * 6 + (rnd() < 0.25 ? rnd() * 5 : 0);
            var c = offPt(idx, sd * (front + depth / 2));
            var p = rectPoly(c[0], c[1], TX[idx], TZ[idx], w / 2, depth / 2);
            if (canPlace(p)) {
              addBuilding(p, 'building', cityHeight(false), (seed + Math.round(s) * 7919 + sd * 13) | 0);
              stampPoly(p, BIT_B);
              counts.procBuildings++;
              placed = true;
            }
          }
          s += w + (rnd() < 0.22 ? 5 + rnd() * 14 : 0.4);
        }
      }
    })();
    // ---- scattered blocks / skyline further out
    (function () {
      if (!prof.skyline) return;
      var want = isCityBuild ? 320 : Math.round(90 * prof.skyline), tries = want * 8, made = 0;
      var near = isCityBuild ? 45 : 420, far = isCityBuild ? 820 : 860;
      var dirA = rnd() * Math.PI * 2, sector = prof.skyline < 1;
      var cxm = (minX + maxX) / 2, czm = (minZ + maxZ) / 2;
      for (var t = 0; t < tries && made < want; t++) {
        var x = rx0 + rnd() * (maxX - minX + 2 * PAD), z = rz0 + rnd() * (maxZ - minZ + 2 * PAD);
        var d = cdist(x, z), r = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
        if (d < near || d > far) continue;
        var ex0 = (x - cxm) / ((maxX - minX) / 2 + 540), ez0 = (z - czm) / ((maxZ - minZ) / 2 + 540);
        if (ex0 * ex0 + ez0 * ez0 > 1) continue;
        if (sector) {
          var an = Math.atan2(z - czm, x - cxm) - dirA;
          an = Math.atan2(Math.sin(an), Math.cos(an));
          if (Math.abs(an) > 1.0) continue;
        }
        if (isCityBuild && r > 1.15 - d / 900) continue;       // denser near the circuit
        var w = 16 + r2 * 30, dp = 16 + r3 * 26, ang = r4 * Math.PI;
        var p = rectPoly(x, z, Math.cos(ang), Math.sin(ang), w / 2, dp / 2);
        if (polyHitsOcc(p, BIT_B | BIT_WATER) || polyClearance(p) < CLEAR + 3 || polyInSight(p)) continue;
        var h = cityHeight(true) * (d > 300 ? 1.5 : 1);
        if (!isCityBuild) h = 45 + rnd() * 130;
        addBuilding(p, h > 60 ? 'tower' : 'building', h, (seed + t * 104729) | 0);
        stampPoly(p, BIT_B);
        counts.procBuildings++;
        made++;
      }
    })();

    mark('city');
    // ---- advertising boards, distance boards
    var BOARD_B = 1.35, BOARD_T = 2.6;
    function boardRun(i0, i1, side, bannerIdx) {   // unwrapped sample range
      var stp = Math.max(1, Math.round(8 / ds)), made = 0;
      for (var a = i0; a + stp <= i1; a += stp) {
        var ia = wrap(a), ib = wrap(a + stp);
        if (pitBehind(ia, side) || pitBehind(ib, side)) continue;
        var pa = offPt(ia, side * (lim(ia, side) + CLEAR + 0.45)), pb = offPt(ib, side * (lim(ib, side) + CLEAR + 0.45));
        if (!segClear(pa, pb, CLEAR + 0.03)) continue;
        var mx = (pa[0] + pb[0]) / 2, mz = (pa[1] + pb[1]) / 2;
        if ((occAt(mx, mz) | occAt(pa[0], pa[1]) | occAt(pb[0], pb[1])) & BIT_B) continue;
        var ya = sY(ia, side * wallD(ia, side)), yb = sY(ib, side * wallD(ib, side));
        var uv = bannerUV((bannerIdx + Math.floor(made / 3)) % BANNERS.length);
        // facing the track: normal = -side * n. Order the ends left -> right as seen from the road.
        var fxn = -side * NX[ia], fzn = -side * NZ[ia];
        var rxv = fzn, rzv = -fxn;
        var p0 = pa, p1 = pb, y0 = ya, y1 = yb;
        if ((pb[0] - pa[0]) * rxv + (pb[1] - pa[1]) * rzv < 0) { p0 = pb; p1 = pa; y0 = yb; y1 = ya; }
        quad(signs, [p0[0], y0 + BOARD_B, p0[1]], [p1[0], y1 + BOARD_B, p1[1]], [p1[0], y1 + BOARD_T, p1[1]], [p0[0], y0 + BOARD_T, p0[1]],
             [1, 1, 1], [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]);
        // dark back + support skirt (slightly behind)
        var bx = -fxn * 0.06, bz = -fzn * 0.06;
        var g0 = Math.min(gY(p0[0], p0[1]), y0) - 0.6, g1 = Math.min(gY(p1[0], p1[1]), y1) - 0.6;
        quad(solid, [p1[0] + bx, g1, p1[1] + bz], [p0[0] + bx, g0, p0[1] + bz], [p0[0] + bx, y0 + BOARD_T, p0[1] + bz],
             [p1[0] + bx, y1 + BOARD_T, p1[1] + bz], COL_DARK);
        made++; counts.boards++;
        if (DEBUG) foot.push({ k: 'board', p: [p0, p1] });
      }
      return made;
    }
    function distanceBoard(idx, side, which) {
      idx = wrap(idx);
      if (pitBehind(idx, side)) return;
      var l0 = lim(idx, side) + CLEAR + 0.4, l1 = l0 + 2.0;
      var pa = offPt(idx, side * l0), pb = offPt(idx, side * l1);
      if (!segClear(pa, pb, CLEAR + 0.03)) return;
      if ((occAt(pa[0], pa[1]) | occAt(pb[0], pb[1])) & BIT_B) return;
      var y = sY(idx, side * wallD(idx, side)), uv = numberUV(which);
      // faces the arriving cars (normal -t); seen from there the right hand is -n
      var p0 = side > 0 ? pb : pa, p1 = side > 0 ? pa : pb;
      quad(signs, [p0[0], y + 1.45, p0[1]], [p1[0], y + 1.45, p1[1]], [p1[0], y + 2.9, p1[1]], [p0[0], y + 2.9, p0[1]],
           [1, 1, 1], [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]);
      var bx = TX[idx] * 0.06, bz = TZ[idx] * 0.06, g = Math.min(gY(pa[0], pa[1]), gY(pb[0], pb[1]), y) - 0.6;
      quad(solid, [p1[0] + bx, g, p1[1] + bz], [p0[0] + bx, g, p0[1] + bz], [p0[0] + bx, y + 2.9, p0[1] + bz],
           [p1[0] + bx, y + 2.9, p1[1] + bz], COL_DARK);
      if (DEBUG) foot.push({ k: 'distance-board', p: [pa, pb] });
    }
    (function () {
      var zmax = Math.min(zones.length, 7), a;
      for (a = 0; a < zmax; a++) {
        var zn = zones[a], os = -zn.turn, e = zn.e + Math.round(8 / ds);
        distanceBoard(e - Math.round(150 / ds), os, 0);
        distanceBoard(e - Math.round(100 / ds), os, 1);
        distanceBoard(e - Math.round(50 / ds), os, 2);
        boardRun(zn.e - Math.round(120 / ds), zn.e + Math.round(70 / ds), os, a);
        markFence(wrap(zn.e - Math.round(25 / ds)), os, Math.round(95 / ds));
      }
      // main straight, grandstand side
      boardRun(-mainBack, mainFwd, -pitSide, 1);
      // regular short runs around the lap
      var every = Math.round(330 / ds), run = Math.round(48 / ds), n = 0;
      for (a = Math.round(200 / ds); a < N - every / 2; a += every, n++) {
        boardRun(a, a + run, (n & 1) ? 1 : -1, n + 2);
      }
    })();

    // ---- debris fence
    (function () {
      var stp = Math.max(1, Math.round(4 / ds));
      var col = [0.92, 0.93, 0.95];
      for (var sd = 0; sd < 2; sd++) {
        var side = sd ? 1 : -1, flags = fenceFlag[sd];
        var prevOK = false, pp = null, py = 0, pg = 0;
        for (var a = 0; a <= N; a += stp) {
          var ia = wrap(a), on = (prof.city || flags[ia]) && !pitBehind(ia, side);
          var ok = false, pt = null, y = 0, g = 0;
          if (on) {
            pt = offPt(ia, side * (lim(ia, side) + CLEAR + 0.18));
            ok = isClear(pt[0], pt[1], CLEAR + 0.02) && !(occAt(pt[0], pt[1]) & BIT_B);
            if (ok) { y = sY(ia, side * wallD(ia, side)); g = Math.min(y, gY(pt[0], pt[1])) - 0.3; }
          }
          if (ok && prevOK) {
            if (Math.hypot(pt[0] - pp[0], pt[1] - pp[1]) < stp * ds * 2.5 && segClear(pp, pt, CLEAR + 0.01)) {
              var vb = (Math.min(g, pg) - Math.min(y, py)) / 4.3;
              quad(fence, [pp[0], pg, pp[1]], [pt[0], g, pt[1]], [pt[0], y + 4.3, pt[1]], [pp[0], py + 4.3, pp[1]], col,
                   [0, 0], [1, 0], [1, 1], [0, 1]);
              if (DEBUG) foot.push({ k: 'fence', p: [pp, pt] });
            }
          }
          prevOK = ok; pp = pt; py = y; pg = g;
        }
      }
    })();

    // ---- marshal posts, floodlights
    (function () {
      var every = Math.round(340 / ds), n = 0, a, q;
      for (a = Math.round(120 / ds); a < N; a += every, n++) {
        var side = (n & 1) ? -1 : 1, ia = wrap(a);
        if (pitBehind(ia, side)) continue;
        var c = offPt(ia, side * (lim(ia, side) + CLEAR + 1.5));
        var hb = rectPoly(c[0], c[1], TX[ia], TZ[ia], 1.3, 0.95), ok = true;
        for (q = 0; q < 4; q++) if (!isClear(hb[q][0], hb[q][1], CLEAR + 0.05)) ok = false;
        if (!ok || polyHitsOcc(hb, BIT_B)) continue;
        var y = sY(ia, side * wallD(ia, side));
        box(solid, c[0], c[1], Math.min(y, gY(c[0], c[1])) - 1.0, y + 2.75, TX[ia], TZ[ia], 1.3, 0.95, C(0xd86a1c), C(0xe8e8e6));
        if (DEBUG) foot.push({ k: 'marshal-post', p: hb });
      }
      if (prof.night || prof.city) {
        var ev2 = Math.round((prof.night ? 110 : 160) / ds);
        n = 0;
        for (a = Math.round(40 / ds); a < N; a += ev2, n++) {
          var sd2 = (n & 1) ? 1 : -1, ib = wrap(a);
          if (pitBehind(ib, sd2)) continue;
          var c2 = offPt(ib, sd2 * (lim(ib, sd2) + CLEAR + 0.9));
          var ok2 = true;
          for (q = 0; q < 4; q++) if (!isClear(c2[0] + ((q & 1) ? 0.25 : -0.25), c2[1] + ((q & 2) ? 0.25 : -0.25), CLEAR + 0.05)) ok2 = false;
          if (!ok2 || (occAt(c2[0], c2[1]) & BIT_B)) continue;
          var y2 = sY(ib, sd2 * wallD(ib, sd2)), hp = prof.night ? 24 : 11;
          box(solid, c2[0], c2[1], Math.min(y2, gY(c2[0], c2[1])) - 1.0, y2 + hp, TX[ib], TZ[ib], 0.2, 0.2, C(0x8a8e94));
          if (prof.night) {
            // lamp head stays above the pole (does not reach over the corridor edge)
            box(solid, c2[0] + NX[ib] * sd2 * 0.5, c2[1] + NZ[ib] * sd2 * 0.5, y2 + hp, y2 + hp + 1.0, TX[ib], TZ[ib], 1.6, 0.35, C(0xe8eaec));
          }
          if (DEBUG) foot.push({ k: 'pole', p: [[c2[0] - 0.25, c2[1] - 0.25], [c2[0] + 0.25, c2[1] - 0.25], [c2[0] + 0.25, c2[1] + 0.25], [c2[0] - 0.25, c2[1] + 0.25]] });
        }
      }
    })();

    mark('furniture');
    // ================================================================ 4. trees
    var trees = [];   // {x, z, h, kind, tint, w}
    (function () {
      var density = prof.trees, a;
      var hasForest = false;
      for (a = 0; a < occ.length; a += 7) if (occ[a] & BIT_FOREST) { hasForest = true; break; }
      if (hasForest) density *= 0.6;      // mapped woods carry the scene; thin the invented ones
      function pick() {
        var r = rnd(), m = prof.mix;
        return r < m[0] ? 0 : (r < m[0] + m[1] ? 1 : 2);
      }
      function push(x, z, kind, w) {
        var rad = kind === 0 ? 3.6 : 2.6;
        var d = cdist(x, z);
        if (d < 120 && !isClear(x, z, CLEAR + rad)) return;
        if ((occAt(x + 7, z) | occAt(x - 7, z) | occAt(x, z + 7) | occAt(x, z - 7)) & BIT_B) return;
        var h = kind === 0 ? 7 + rnd() * 6.5 : (kind === 1 ? 8 + rnd() * 7 : 7 + rnd() * 5);
        var t = { x: x, z: z, h: h, kind: kind, tint: rnd(), w: w + rnd() * 140, s: 0.82 + rnd() * 0.36, rot: rnd() * 6.283 };
        // next to the pit lane the crown must not reach over it (radius per unit tree: see treeGeometry), nor stand in
        // the sight lines to the entry curtain. Decided after the random draws, so that every other tree stays put.
        if (pitMask && d < 200) {
          var crown = t.h * t.s * (kind === 0 ? 0.39 : (kind === 1 ? 0.21 : 0.35)), ps = nearest(x, z, maxLim + 30);
          if (ps >= 0 && pitMask[ps] && ((x - X[ps]) * NX[ps] + (z - Z[ps]) * NZ[ps] >= 0 ? 1 : -1) === pitSide &&
              !isClear(x, z, crown + 0.2)) return;
          if (inSight(x, z, crown + 0.5)) return;
        }
        trees.push(t);
      }
      for (a = 0; a < dTrees.length; a++) {
        var t = dTrees[a];
        if (!t || !isFinite(t[0]) || !isFinite(t[1])) continue;
        if (occAt(t[0], t[1]) & (BIT_B | BIT_WATER)) continue;
        push(+t[0], +t[1], pick(), -200);
      }
      var SP = 11, nx = Math.ceil((maxX - minX + 2 * PAD) / SP), nz = Math.ceil((maxZ - minZ + 2 * PAD) / SP);
      var thr = prof.city ? 0.7 : (prof.desert ? 0.72 : 0.56);
      for (var iz = 0; iz < nz; iz++) {
        for (var ix = 0; ix < nx; ix++) {
          var r1 = rnd(), r2 = rnd(), r3 = rnd();
          var x = rx0 + (ix + r1) * SP, z = rz0 + (iz + r2) * SP;
          var d = cdist(x, z);
          if (d > 640) continue;
          var o = occAt(x, z);
          if (o & (BIT_B | BIT_WATER | BIT_SAND | BIT_ASPH)) continue;
          var pAcc;
          if (o & BIT_FOREST) pAcc = 0.85;
          else {
            var wn = vnoise(x / 190, z / 190, seed) * 0.7 + vnoise(x / 60, z / 60, seed + 9) * 0.3;
            pAcc = wn > thr ? 0.7 * density : 0.035 * density;
            if (d <= 120) pAcc = Math.max(pAcc, 0.2 * density);
            if (o & BIT_GRASS) pAcc *= 0.12;
            if (o & BIT_URBAN) pAcc *= 0.2;
          }
          pAcc *= clamp(1.25 - d / 560, 0.12, 1);
          if (r3 >= pAcc) continue;
          push(x, z, pick(), d);
        }
      }
      if (trees.length > MAX_TREES) {
        trees.sort(function (m, q) { return m.w - q.w; });
        trees.length = MAX_TREES;
      }
      counts.trees = trees.length;
      if (DEBUG) for (a = 0; a < trees.length; a++) foot.push({ k: 'tree', p: [[trees[a].x, trees[a].z]], r: trees[a].kind === 0 ? 3.6 : 2.6 });
    })();

    mark('trees');
    // ================================================================ 5. ground patches (draped)
    (function () {
      if (prof.city) {       // paved ground around a street circuit
        for (var r = 0; r < RH; r++) {
          for (var c = 0; c < RW; c++) {
            var o = occ[r * RW + c];
            if (o & (BIT_WATER | BIT_FOREST | BIT_GRASS | BIT_SAND)) continue;
            if (cdist(rx0 + (c + 0.5) * rcell, rz0 + (r + 0.5) * rcell) < (hasAreaData ? 240 : 300)) occ[r * RW + c] |= BIT_URBAN;
          }
        }
      }
      var COLS = {};
      COLS[BIT_WATER] = C(0x2c5a80); COLS[BIT_SAND] = C(0xa8966c); COLS[BIT_ASPH] = C(0x47484c); COLS[BIT_URBAN] = C(0x6e6e70);
      function kindAt(x, z) {
        var o = occAt(x, z);
        // data order bottom -> top: urban, grass, forest, asphalt, sand, water (grass / forest stay plain ground)
        return (o & BIT_WATER) ? BIT_WATER : ((o & BIT_SAND) ? BIT_SAND : ((o & BIT_ASPH) ? BIT_ASPH :
          ((o & (BIT_GRASS | BIT_FOREST)) ? 0 : ((o & BIT_URBAN) ? BIT_URBAN : 0))));
      }
      var quads = 0, LIFT = 0.2, M = CLEAR + 0.6;
      // patch vertices all lie on a 2 m grid: memoise the ground height there
      var PW = Math.ceil((maxX - minX + 2 * PAD) / 2) + 2, PH = Math.ceil((maxZ - minZ + 2 * PAD) / 2) + 2;
      var pcache = new Float32Array(PW * PH).fill(NaN);
      function pY(x, z) {
        var c = Math.round((z - rz0) / 2) * PW + Math.round((x - rx0) / 2), v = pcache[c];
        if (v !== v) { v = gY(x, z); pcache[c] = v; }
        return v;
      }
      function rough(x, z, s) {
        var h = s / 2;
        if (nearest(x + h, z + h, 40 + s) < 0) return false;
        var a = pY(x, z), b = pY(x + s, z), c = pY(x, z + s), d = pY(x + s, z + s), T = 0.13;
        if (Math.max(a, b, c, d) - Math.min(a, b, c, d) > 0.3 * s) return true;
        return Math.abs(pY(x + h, z + h) - (a + d) / 2) > T || Math.abs(pY(x + h, z) - (a + b) / 2) > T ||
               Math.abs(pY(x, z + h) - (a + c) / 2) > T || Math.abs(pY(x + s, z + h) - (b + d) / 2) > T ||
               Math.abs(pY(x + h, z + s) - (c + d) / 2) > T;
      }
      function emit(x, z, s, kd) {
        var y00 = pY(x, z) + LIFT, y10 = pY(x + s, z) + LIFT, y01 = pY(x, z + s) + LIFT, y11 = pY(x + s, z + s) + LIFT;
        var col = COLS[kd];
        triUp(patch, [x, y00, z], [x + s, y10, z], [x + s, y11, z + s], col);
        triUp(patch, [x, y00, z], [x + s, y11, z + s], [x, y01, z + s], col);
        quads++;
      }
      function cell(x, z, s) {
        if (quads >= MAX_PATCH_QUADS) return;
        var h = s / 2, k0 = kindAt(x + h / 2, z + h / 2), k1 = kindAt(x + h * 1.5, z + h / 2),
            k2 = kindAt(x + h / 2, z + h * 1.5), k3 = kindAt(x + h * 1.5, z + h * 1.5);
        if (!(k0 | k1 | k2 | k3)) return;
        var same = k0 === k1 && k1 === k2 && k2 === k3;
        var clr = true, hd = s * 0.7072;
        if (cdist(x + h, z + h) < 120) {
          var v = corr(x + h, z + h, maxLim + M + hd + 2);
          if (v < M - hd) return;                 // wholly inside the corridor
          clr = v >= M + hd;                      // wholly outside it
        }
        if (same && clr && !rough(x, z, s)) { emit(x, z, s, k0); return; }
        if (s <= 4.01) {
          if (same && !rough(x, z, s) && isClear(x, z, M) && isClear(x + s, z, M) && isClear(x, z + s, M) && isClear(x + s, z + s, M) &&
              isClear(x + h, z, M) && isClear(x, z + h, M) && isClear(x + s, z + h, M) && isClear(x + h, z + s, M)) emit(x, z, s, k0);
          return;
        }
        cell(x, z, h); cell(x + h, z, h); cell(x, z + h, h); cell(x + h, z + h, h);
      }
      var S0 = 32, nx = Math.ceil((maxX - minX + 2 * PAD) / S0), nz = Math.ceil((maxZ - minZ + 2 * PAD) / S0);
      for (var iz = 0; iz < nz; iz++) {
        for (var ix = 0; ix < nx; ix++) {
          var x = rx0 + ix * S0, z = rz0 + iz * S0;
          if (cdist(x + 16, z + 16) > 760) continue;
          cell(x, z, S0);
        }
      }
      counts.patchQuads = quads;
    })();

    mark('patches');
    // ================================================================ 6. horizon: two rings of hills
    (function () {
      var cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2, hwid = (maxX - minX) / 2, hhei = (maxZ - minZ) / 2;
      var yBase = Infinity;
      for (var a = 0; a < N; a += 8) if (Y[a] < yBase) yBase = Y[a];
      var green = prof.desert ? C(0x9a8660) : C(0x3a6a30), dark = prof.desert ? C(0x85704e) : C(0x27502a);
      var rock = prof.desert ? C(0x9c8468) : C(0x6e7468), snow = prof.desert ? C(0xb09a7c) : C(0xc8ccd0);
      function ring(M, outs, lo, hi, K, sOff, alpine) {
        var prev = null;
        for (var q = 0; q <= K; q++) {
          var th = (q % K) / K * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
          var fx = cx + (hwid + M) * c, fz = cz + (hhei + M) * s;
          var l = Math.hypot((hwid + M) * s, (hhei + M) * c) || 1;       // outward normal of the ellipse
          var ox = (hhei + M) * c / l, oz = (hwid + M) * s / l;
          var nn = vnoise(c * 2.2 + 7, s * 2.2 + 3, seed + sOff) * 0.6 + vnoise(c * 6 + 1, s * 6 + 5, seed + sOff + 3) * 0.28 +
                   vnoise(c * 15, s * 15, seed + sOff + 5) * 0.12;
          var H = lo + (hi - lo) * Math.pow(clamp((nn - 0.22) / 0.56, 0, 1), 1.3);
          var gf = Math.min(gY(fx, fz), yBase + 60) - 6;
          var row = [
            [fx, gf, fz, green],
            [fx + ox * outs[0], gf + 6 + H * 0.55, fz + oz * outs[0], dark],
            [fx + ox * outs[1], gf + 6 + H, fz + oz * outs[1], alpine && H > 330 ? (H > 470 ? snow : rock) : dark],
            [fx + ox * outs[2], gf + 6 + H * 0.5, fz + oz * outs[2], dark]
          ];
          if (prev) {
            for (var r = 0; r < 3; r++) {
              var A = prev[r], B = row[r], Cc = row[r + 1], D = prev[r + 1];
              tri(solid, [A[0], A[1], A[2]], [B[0], B[1], B[2]], [Cc[0], Cc[1], Cc[2]], A[3], B[3], Cc[3]);
              tri(solid, [A[0], A[1], A[2]], [Cc[0], Cc[1], Cc[2]], [D[0], D[1], D[2]], A[3], Cc[3], D[3]);
            }
          }
          prev = row;
        }
      }
      var hl = prof.hills;
      ring(620, [120, 260, 520], hl[0], hl[1], 150, 11, false);
      ring(1150, [200, 420, 800], hl[2], hl[3], 120, 23, id === 'at-1969' || id === 'ru-2014');
    })();

    mark('hills');
    // ================================================================ 7. meshes
    var group = new THREE.Group();
    group.name = 'scenery';
    var disposables = [];
    var rT = makeRng(seed ^ 0x51ed270b);
    var stats = { triangles: 0, drawCalls: 0, buildMs: 0, counts: counts };

    function makeMesh(name, buf, mat, order) {
      if (!buf.tris) { mat.dispose(); if (mat.map) mat.map.dispose(); return null; }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.p), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf.n), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(buf.c), 3));
      if (buf.u) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf.u), 2));
      g.computeBoundingSphere();
      var m = new THREE.Mesh(g, mat);
      m.name = name;
      m.matrixAutoUpdate = false;
      if (order) m.renderOrder = order;
      group.add(m);
      disposables.push(g, mat);
      if (mat.map) disposables.push(mat.map);
      stats.triangles += buf.tris; stats.drawCalls++;
      return m;
    }
    function lam(o) { o.vertexColors = true; return new THREE.MeshLambertMaterial(o); }

    makeMesh('scenery-solid', solid, lam({ side: THREE.DoubleSide }));
    makeMesh('scenery-patches', patch, lam({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    if (masonry.tris) makeMesh('scenery-masonry', masonry, lam({ map: texMasonry(THREE, rT) }));
    if (glass.tris) makeMesh('scenery-glass', glass, lam({ map: texGlass(THREE, rT) }));
    if (pitB.tris) makeMesh('scenery-pit', pitB, lam({ map: texPit(THREE, rT) }));
    if (crowd.tris) {
      var ct = texCrowd(THREE, rT);
      makeMesh('scenery-crowd', crowd, ct ? lam({ map: ct, side: THREE.DoubleSide }) : lam({ color: 0x8a8078, side: THREE.DoubleSide }));
    }
    if (signs.tris) {
      var st = texSigns(THREE);
      makeMesh('scenery-signs', signs, st ? lam({ map: st }) : lam({ color: 0x9a3030 }));
    }
    if (fence.tris) {
      var ft = texFence(THREE);
      makeMesh('scenery-fence', fence, ft ?
        lam({ map: ft, transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.02 }) :
        lam({ color: 0xc0c4c8, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }), 5);
    }

    // instanced trees
    (function () {
      if (!trees.length) return;
      var kinds = ['broadleaf', 'conifer', 'palm'], mat = lam({ side: THREE.DoubleSide });
      var used = false, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      var pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
      for (var kd = 0; kd < 3; kd++) {
        var list = [];
        for (var a = 0; a < trees.length; a++) if (trees[a].kind === kd) list.push(trees[a]);
        if (!list.length) continue;
        var geo = treeGeometry(THREE, kinds[kd]);
        var im = new THREE.InstancedMesh(geo, mat, list.length);
        im.name = 'scenery-trees-' + kinds[kd];
        for (a = 0; a < list.length; a++) {
          var t = list[a];
          pos.set(t.x, gY(t.x, t.z) - 0.25, t.z);
          q.setFromAxisAngle(up, t.rot);
          scl.set(t.h * t.s, t.h, t.h * t.s);
          m4.compose(pos, q, scl);
          im.setMatrixAt(a, m4);
          var b = 0.78 + t.tint * 0.4;
          if (prof.desert) col.setRGB(b * 1.0, b * 0.98, b * 0.8); else col.setRGB(b * (0.92 + t.s * 0.1), b, b * 0.9);
          im.setColorAt(a, col);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.frustumCulled = false;       // instances are spread over the whole map
        im.matrixAutoUpdate = false;
        group.add(im);
        disposables.push(geo);
        if (typeof im.dispose === 'function') disposables.push(im);
        stats.triangles += geo.userData.tris * list.length; stats.drawCalls++;
        used = true;
      }
      if (used) disposables.push(mat); else mat.dispose();
    })();

    function dispose() {
      for (var a = 0; a < disposables.length; a++) {
        if (disposables[a] && typeof disposables[a].dispose === 'function') disposables[a].dispose();
      }
      disposables.length = 0;
      for (var b = group.children.length - 1; b >= 0; b--) group.remove(group.children[b]);
      if (group.parent) group.parent.remove(group);
    }

    mark('meshes');
    stats.phases = phases;
    stats.buildMs = now() - tStart;
    var result = { group: group, dispose: dispose, stats: stats };
    if (DEBUG) result.debug = { footprints: foot, clear: CLEAR };
    return result;
  };

  // ================================================================ F1.createSky

  // Gradient dome + sun glow + soft clouds + a faint far ridge. It always renders centred on the camera
  // (the vertex shader ignores the camera translation), behind everything, and is not affected by fog.
  F1.createSky = function (opts) {
    var THREE = global.THREE;
    opts = opts || {};
    var horizon = new THREE.Color(opts.horizon !== undefined ? opts.horizon : HORIZON);
    var sunDir = new THREE.Vector3(300, 600, 200).normalize();   // same direction as the light in main.js
    if (opts.sunDirection) sunDir.copy(opts.sunDirection).normalize();
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: horizon },
        uMid: { value: new THREE.Color(0x7fb0e2) },
        uZenith: { value: new THREE.Color(0x3a78c8) },
        uSunDir: { value: sunDir },
        uClouds: { value: opts.clouds === undefined ? 1 : +opts.clouds },
        uRidge: { value: opts.ridge === undefined ? 1 : +opts.ridge }
      },
      vertexShader: [
        'varying vec3 vDir;',
        'void main() {',
        '  vDir = position;',
        '  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);',
        '  gl_Position = vec4(p.xy, p.w * 0.99995, p.w);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'uniform vec3 uHorizon; uniform vec3 uMid; uniform vec3 uZenith; uniform vec3 uSunDir;',
        'uniform float uClouds; uniform float uRidge;',
        'varying vec3 vDir;',
        'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'float noise(vec2 p) {',
        '  vec2 i = floor(p), f = fract(p);',
        '  f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);',
        '}',
        'float fbm(vec2 p) {',
        '  float v = 0.0, a = 0.5;',
        '  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; }',
        '  return v;',
        '}',
        'void main() {',
        '  vec3 d = normalize(vDir);',
        '  float y = max(d.y, 0.0);',
        '  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.26, y));',
        '  col = mix(col, uZenith, smoothstep(0.18, 0.95, y));',
        '  float s = max(dot(d, uSunDir), 0.0);',
        '  col += vec3(1.0, 0.95, 0.85) * (pow(s, 1200.0) * 1.5 + pow(s, 90.0) * 0.30 + pow(s, 8.0) * 0.12);',
        '  if (uClouds > 0.0 && d.y > 0.015) {',
        '    vec2 uv = d.xz / (d.y + 0.12) * 0.9;',
        '    float c = smoothstep(0.50, 0.80, fbm(uv + vec2(3.7, 1.9)));',
        '    float fade = smoothstep(0.015, 0.16, d.y);',
        '    vec3 cc = mix(vec3(1.0, 1.0, 1.0), vec3(0.80, 0.84, 0.90), smoothstep(0.55, 0.95, fbm(uv * 1.7 + 11.0)));',
        '    col = mix(col, mix(uHorizon, cc, 0.35 + 0.65 * fade), c * fade * 0.9 * uClouds);',
        '  }',
        '  if (uRidge > 0.0) {',
        '    float a = atan(d.z, d.x);',
        '    float r = 0.006 + 0.013 * (0.5 + 0.5 * sin(a * 3.0 + 1.3)) * (0.6 + 0.4 * sin(a * 7.0 + 4.1)) + 0.003 * sin(a * 17.0) + 0.002 * sin(a * 41.0 + 2.0);',
        '    float m = 1.0 - smoothstep(r - 0.0015, r + 0.0015, d.y);',
        '    col = mix(col, mix(uHorizon, vec3(0.50, 0.60, 0.72), 0.45), m * uRidge * step(0.0, d.y));',
        '  }',
        '  if (d.y < 0.0) col = uHorizon;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false
    });
    var geo = new THREE.BoxGeometry(2, 2, 2);
    var sky = new THREE.Mesh(geo, mat);
    sky.name = 'sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.matrixAutoUpdate = false;
    sky.horizonColor = horizon.getHex();
    sky.sunDirection = sunDir;
    // kept for the integrator: the dome follows the camera by itself, so this is a no-op
    sky.update = function () {};
    sky.dispose = function () { geo.dispose(); mat.dispose(); };
    return sky;
  };
})(typeof window !== 'undefined' ? window : this);
