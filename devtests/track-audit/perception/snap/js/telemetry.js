// F1Drive - the broadcast-style telemetry graphic in the bottom centre of the HUD (after the driver graphic of the
// F1 TV world feed): rev arc with a row of shift lights, speed and gear, throttle / brake arcs, battery (ERS), the
// four tyres with the compound, the pit limiter and the team. One <canvas>, 2D context, no DOM work per frame.
//
//   F1.telemetry.init(canvas)   once (again with another canvas is fine) -> bool. Sizes the backing store from the
//                               canvas's CSS box and devicePixelRatio; re-measured by a ResizeObserver (window resize and
//                               matchMedia(resolution) where that is missing), never per frame. A hidden canvas
//                               (display: none) is simply not drawn until it has a size again.
//   F1.telemetry.draw(t)        every rendered frame. Every field is optional and sanitised (missing / NaN -> a
//                               sensible default); draw() never throws and does not allocate.
//     t = { speedKmh, gear (-1 R, 0 N, 1..9), rpm, rpmIdle, rpmShift, rpmMax,
//           throttle, brake (0..1 pedals), battery (0..1, or null / missing = the car has no ERS: block left out),
//           deploy, harvest (0..1), limiter (bool), inPit (bool), limitKmh,
//           tyres: { compound 'S' | 'M' | 'H', wear: [FL, FR, RL, RR] 0..1, flat: [4] 0..1, puncture -1 | 0..3 },
//           nextCompound ('S' | 'M' | 'H', default = tyres.compound), team, car, colour ('#rrggbb'),
//           colour2 (optional: the second livery colour, the accent when `colour` is a dark neutral: black, graphite) }
//   F1.telemetry.reset()        forget the smoothed values (the next frame shows t as it is)
//   F1.telemetry.W, .H          design size in CSS px (520 x 156): the graphic is scaled uniformly to fit the
//                               canvas's CSS box, centred horizontally, standing on its bottom edge.
//   F1.telemetry.clock          function () -> ms, for smoothing and flashing (performance.now); tests replace it.
//
// Layout (design units): the panel body spans y 42..156; the gauge disc rises above it to y 30 and the light bar
// (15 shift lights) sits above that at y 9..27 — or, while the pit limiter is on / the car is in the pit lane, the
// wider flashing band 維修區限速 80. Left wing: team colour strip, team and car, battery. Right wing: gear, tyres.
// Without a battery the left wing closes up around the team name and the gauge stays in the centre.
//
// Cost: everything that does not move (panel, gauge furniture, labels, team) is a static layer, and every piece of
// text that changes (digits, gear, percentages, tags, badges, the pit band) plus the lit LED bar and battery bars
// are pre-rendered into a sprite atlas at device resolution; both are rebuilt only when the size, the team / car /
// colours, the rpm range, the battery presence or the pit speed limit change. A frame is one static blit, a few
// arcs and paths and a handful of sprite blits at whole device pixels.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // ---- design (units = CSS px at scale 1) ------------------------------------------------------------------------
  var DEG = Math.PI / 180, TAU = Math.PI * 2;
  var W = 520, H = 156;
  var K_MAX = 5;                                // device px per design unit at most (bounds the atlas)
  var BODY_Y = 42, BODY_R = 10;                 // panel body top edge and corner radius
  var CX = 260, CY = 100, HUB_R = 70;           // gauge centre, disc radius (rises above the body)
  var RPM_R = 61.5, RPM_W = 9;                  // rev band: centre radius / width (57..66)
  var RPM_A0 = 150 * DEG, RPM_A1 = 390 * DEG;   // 240 deg over the top, clockwise on screen
  var PED_R = 49.5, PED_W = 6;                  // pedal arcs inside the rev band
  var BRK_A0 = 158 * DEG, BRK_SW = 92 * DEG;    // brake: lower left, fills clockwise (upwards)
  var THR_A0 = 22 * DEG, THR_SW = 92 * DEG;     // throttle: lower right, fills anticlockwise (upwards)
  var BAR_X = CX - 76, BAR_W = 152, BAR_Y = 9, BAR_H = 18;   // light bar above the gauge
  var LED_N = 15, LED_R = 3.9, LED_DX = 9.6, LED_GR = 5.6;   // shift lights: count, radius, pitch, glow radius
  var BAND_X = CX - 118, BAND_W = 236, BAND_Y = 5, BAND_H = 24;   // pit band (replaces the light bar)
  var SPEED_Y = 116, SPEED_PX = 46;             // speed digits baseline / size
  var GEAR_X = 364, GEAR_Y = 117;
  var LEFT_X = 0, LEFT_PAD = 20, LEFT_R = 182;  // left wing: content inset, right end of its content
  var BAT_Y = 104, BAT_H = 12, BAT_SEG = 10, BAT_GAP = 2;   // battery bar
  var TY_X = [398, 424, 397, 423], TY_Y = [56, 56, 88, 88], TY_W = [14, 14, 16, 16], TY_H = 24;   // FL FR RL RR
  var TY_CX = 418;                              // tyre block centre
  var CMP_X = 476, CMP_Y = 72, CMP_R = 14;      // current compound badge
  var NXT_Y = 126, NXT_R = 9.5;                 // next compound badge

  var TAU_PEDAL = 0.028, TAU_RPM = 0.030, TAU_BAT = 0.08, TAU_FX = 0.12;   // smoothing time constants (s)

  var NUM = 'Bahnschrift, "DIN Alternate", "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif';
  var UIF = '"Segoe UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", system-ui, sans-serif';
  var F_SPEED = 'italic 700 ' + SPEED_PX + 'px ' + NUM;
  var F_GEAR = 'italic 700 46px ' + NUM;
  var F_UNIT = '600 10px ' + NUM;
  var F_LABEL = '600 10.5px ' + UIF;
  var F_TEAM = '700 15px ' + NUM, F_TEAM_BIG = '700 17px ' + NUM;      // names: uppercase, like a broadcast tag
  var F_CAR = '600 12px ' + NUM, F_CAR_BIG = '600 13px ' + NUM;
  var F_PCT = 'italic 700 17px ' + NUM, F_PCT_SIGN = 'italic 700 11px ' + NUM;
  var F_TAG = '700 11px ' + UIF;
  var F_BAND = '700 15px ' + UIF, F_CHIP = 'italic 800 12px ' + NUM;
  var F_CMP = '800 14px ' + NUM, F_NXT = '800 10px ' + NUM;

  var C_PANEL = 'rgba(11,13,17,0.87)', C_HUB = 'rgba(4,5,7,0.55)', C_EDGE = 'rgba(255,255,255,0.16)';
  var C_TEXT = '#f2f4f7', C_MUTED = '#9aa4b2', C_DIM = 'rgba(255,255,255,0.10)';
  var C_THR = '#27e07a', C_BRK = '#ff3030', C_AMBER = '#ffb81c', C_BAT = '#3cc8ff', C_DEP = '#ffd84a',
      C_HAR = '#3ee07e', C_LOW = '#ff5a3c';
  var LED_COL = ['#2cf07c', '#ff2a2a', '#3d7bff'], LED_GLOW = ['rgba(44,240,124,0.30)', 'rgba(255,42,42,0.30)',
      'rgba(61,123,255,0.34)'];
  var CMP_TXT = ['S', 'M', 'H'], CMP_COL = ['#ff3a36', '#ffd21e', '#eef1f5'];
  var GEAR_TXT = ['R', 'N', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  var DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  var WEAR_N = 48, WEAR_COL = [];               // wear 0..1 -> green .. yellow .. red (built once)
  (function () {
    var stops = [[0, 53, 208, 127], [0.45, 255, 214, 30], [0.72, 255, 128, 32], [0.9, 255, 52, 40], [1, 230, 30, 30]];
    for (var i = 0; i <= WEAR_N; i++) {
      var w = i / WEAR_N, j = 0;
      while (j < stops.length - 2 && w > stops[j + 1][0]) j++;
      var a = stops[j], b = stops[j + 1], f = (w - a[0]) / (b[0] - a[0]);
      if (f < 0) f = 0; else if (f > 1) f = 1;
      WEAR_COL.push('rgb(' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ',' +
        Math.round(a[3] + (b[3] - a[3]) * f) + ')');
    }
  })();

  // sprite ids (atlas cells)
  var SP_SPD = 0;          // speed digits: + colour * 10 + digit; colours white, amber, red
  var SP_GEAR = 30;        // + gear + 1 (R N 1..9)
  var SP_PCT = 41;         // battery % digits: + colour * 10 + digit; colours white, deploy yellow, red, muted
  var SP_PSIGN = 81;       // '%': + 0 muted, + 1 red
  var SP_TAG = 83;         // + 0 放電中, + 1 充電中, + 2 電量耗盡
  var SP_BADGE = 86;       // + 0..3 big (compound -1..2), + 4..7 small
  var SP_BAND = 94;        // + 0..5 pit band variants (see drawBand)
  var SP_LEDS = 100;       // + 0 lit in group colours, + 1 all blue (shift point)
  var SP_BATBAR = 102;     // + 0 cyan, + 1 deploy yellow, + 2 low red
  var SP_N = 105;
  var SX = new Float64Array(SP_N), SY = new Float64Array(SP_N), SW = new Float64Array(SP_N),
      SH = new Float64Array(SP_N), SOX = new Float64Array(SP_N), SOY = new Float64Array(SP_N);

  // globalAlpha steps 0, 1/32 .. 1 held as ready-made heap numbers (the array starts with a non-number, so its
  // elements stay tagged): setting a computed double on the context would box a new number every frame
  var ALPHA = [null], ALPHA_N = 32;
  for (var ai = 0; ai <= ALPHA_N; ai++) ALPHA[ai] = ai / ALPHA_N;
  function alpha(v) { return ALPHA[v <= 0 ? 0 : v >= 1 ? ALPHA_N : (v * ALPHA_N + 0.5) | 0]; }

  var EMPTY = {};

  // ---- state -----------------------------------------------------------------------------------------------------
  var canvas = null, ctx = null, base = null, bctx = null, atlas = null, actx = null, ro = null, mql = null;
  var devW = 0, devH = 0, sizeDirty = true;
  var bw = 0, bh = 0, k = 1, ox = 0, oy = 0;    // backing size, device px per design unit, origin of the design box
  var staticDirty = true;
  // static-layer key
  var sk = { team: null, car: null, colour: null, colour2: null, idle: 0, shift: 0, max: 0, bat: false, lim: 0 };
  // derived from the key (static layer)
  var leftX = 0, batX = 0;
  var rLo = 0, rHi = 1, rStep = 500, rSegs = 1, rShiftSeg = 0, rWarnSeg = 0;
  var spCell = 26, pctCell = 10, pctSign = 8;
  // smoothed values live in a typed array: a double stored in a closure variable would be boxed on every frame
  var SM_T = 0, SM_THR = 1, SM_BRK = 2, SM_RPM = 3, SM_BAT = 4, SM_DEP = 5, SM_HAR = 6, SM_SPEED = 7;
  var sm = new Float64Array(8), fresh = true;
  sm[SM_T] = -1;
  var warned = false, wired = false;

  var tel = F1.telemetry = {
    W: W, H: H,
    init: init,
    draw: draw,
    reset: function () { fresh = true; },
    clock: function () { var p = root.performance; return p && p.now ? p.now() : Date.now(); }
  };

  function num(v, d) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : d; }
  function clamp01(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }
  function compIndex(v) {
    if (typeof v !== 'string' || !v.length) return -1;
    var c = v.charCodeAt(0);
    return c === 83 || c === 115 ? 0 : c === 77 || c === 109 ? 1 : c === 72 || c === 104 ? 2 : -1;
  }
  function warn(e) {
    if (warned) return;
    warned = true;
    try { root.console && root.console.warn('F1.telemetry:', e); } catch (e2) {}
  }

  // ---- size ------------------------------------------------------------------------------------------------------
  function init(el) {
    try {
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      canvas = null; ctx = null;
      if (!el || typeof el.getContext !== 'function') return false;
      var c = el.getContext('2d');
      if (!c) return false;
      if (!base) {
        base = root.document.createElement('canvas');
        bctx = base.getContext('2d');
        atlas = root.document.createElement('canvas');
        actx = atlas.getContext('2d');
      }
      canvas = el; ctx = c;
      measure();
      if (typeof root.ResizeObserver === 'function') {
        ro = new root.ResizeObserver(onObserved);
        try { ro.observe(el, { box: 'device-pixel-content-box' }); } catch (e) { ro.observe(el); }
      }
      if (!wired) {
        wired = true;
        root.addEventListener('resize', onWinResize);
        watchDpr();
      }
      fresh = true;
      staticDirty = true;
      return true;
    } catch (e) { warn(e); canvas = null; ctx = null; return false; }
  }

  function dpr() { return num(root.devicePixelRatio, 1) || 1; }
  function measure() {
    if (!canvas) return;
    var r = canvas.getBoundingClientRect(), d = dpr();
    devW = Math.round(r.width * d); devH = Math.round(r.height * d);
    sizeDirty = true;
  }
  function onObserved(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.target !== canvas) continue;
      var b = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      if (b) { devW = b.inlineSize; devH = b.blockSize; } else {
        devW = Math.round(e.contentRect.width * dpr()); devH = Math.round(e.contentRect.height * dpr());
      }
      sizeDirty = true;
    }
  }
  function onWinResize() { if (canvas && !ro) measure(); }
  // devicePixelRatio changes (window dragged to another monitor, browser zoom) where the observer cannot see them
  function watchDpr() {
    if (!root.matchMedia) return;
    try {
      if (mql) mql.removeEventListener('change', onDpr);
      mql = root.matchMedia('(resolution: ' + dpr() + 'dppx)');
      mql.addEventListener('change', onDpr);
    } catch (e) {}
  }
  function onDpr() { if (canvas) measure(); watchDpr(); }

  function applySize() {
    sizeDirty = false;
    var w = Math.max(0, Math.round(devW)), h = Math.max(0, Math.round(devH));
    var kk = Math.min(w / W, h / H);
    if (kk > K_MAX) { w = Math.round(w * K_MAX / kk); h = Math.round(h * K_MAX / kk); }   // CSS stretches the rest
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    if (base.width !== w) base.width = w;
    if (base.height !== h) base.height = h;
    if (w === bw && h === bh) return;          // e.g. the observer's first report of an unchanged box
    bw = w; bh = h;
    k = Math.min(w / W, h / H);
    ox = Math.round((w - W * k) / 2);
    oy = Math.round(h - H * k);
    staticDirty = true;
  }

  // ---- colour ----------------------------------------------------------------------------------------------------
  function parseHex(s) {
    if (typeof s !== 'string') return null;
    var m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s.trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hsvV(c) { return Math.max(c[0], c[1], c[2]) / 255; }
  function hsvS(c) { var mx = Math.max(c[0], c[1], c[2]); return mx > 0 ? (mx - Math.min(c[0], c[1], c[2])) / mx : 0; }
  // the accent must read on the dark panel: the livery colour when it is bright enough; a dark near-neutral livery
  // (black, graphite) gives way to the second colour (Mercedes: silver); a dark saturated one (navy, racing green,
  // maroon) keeps its hue and is brightened. -> [r, g, b]
  function pickAccent(c1, c2) {
    var a = parseHex(c1), b = parseHex(c2), v, f;
    if (!a) return b && hsvV(b) >= 0.5 ? b : [225, 6, 0];
    v = hsvV(a);
    if (v >= 0.55) return a;
    if (hsvS(a) < 0.3) {
      if (b && hsvV(b) >= 0.5) return b;
      f = (0.7 - v) / (1 - v);                 // mix with white up to V = 0.7
      return [a[0] + (255 - a[0]) * f, a[1] + (255 - a[1]) * f, a[2] + (255 - a[2]) * f];
    }
    f = 0.8 / Math.max(v, 0.05);               // same hue and saturation, V = 0.8
    return [Math.min(255, a[0] * f), Math.min(255, a[1] * f), Math.min(255, a[2] * f)];
  }
  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')';
  }

  // ---- paths -----------------------------------------------------------------------------------------------------
  function rrect(c, x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function rpmAngle(r) {
    var f = (r - rLo) / (rHi - rLo);
    return RPM_A0 + (RPM_A1 - RPM_A0) * (f < 0 ? 0 : f > 1 ? 1 : f);
  }
  var SEG_GAP = 1.6 * DEG;
  function segPath(c, from, to) {           // rev band segments [from, to) as one path of arcs
    for (var i = from; i < to; i++) {
      var a0 = RPM_A0 + (RPM_A1 - RPM_A0) * i / rSegs + SEG_GAP / 2,
          a1 = RPM_A0 + (RPM_A1 - RPM_A0) * (i + 1) / rSegs - SEG_GAP / 2;
      c.moveTo(CX + Math.cos(a0) * RPM_R, CY + Math.sin(a0) * RPM_R);
      c.arc(CX, CY, RPM_R, a0, a1, false);
    }
  }
  function ledX(i) { return CX + (i - (LED_N - 1) / 2) * LED_DX; }
  function boltPath(c, x, y, s) {           // small lightning bolt, top-left at (x, y), ~7 x 11
    c.beginPath();
    c.moveTo(x + 4.5 * s, y); c.lineTo(x, y + 6.4 * s); c.lineTo(x + 3 * s, y + 6.4 * s);
    c.lineTo(x + 2 * s, y + 11 * s); c.lineTo(x + 6.8 * s, y + 4.2 * s); c.lineTo(x + 3.8 * s, y + 4.2 * s);
    c.closePath();
  }
  function batSegW() { return (LEFT_R - batX - BAT_GAP * (BAT_SEG - 1)) / BAT_SEG; }
  function batSegPath(c) {                  // the ten battery cells, full
    var sw = batSegW();
    for (var i = 0; i < BAT_SEG; i++) c.rect(batX + i * (sw + BAT_GAP), BAT_Y, sw, BAT_H);
  }
  function ellipsize(c, s, maxW) {
    if (c.measureText(s).width <= maxW) return s;
    while (s.length > 1 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  // ---- static layer: panel, gauge furniture, labels, team (redrawn on size / team / rpm range / battery change) --
  function buildStatic(team, car, colour, colour2, idle, shift, max, hasBat, limKmh) {
    staticDirty = false;
    sk.team = team; sk.car = car; sk.colour = colour; sk.colour2 = colour2;
    sk.idle = idle; sk.shift = shift; sk.max = max; sk.bat = hasBat; sk.lim = limKmh;
    var acc = pickAccent(colour, colour2), accent = rgba(acc, 1);

    // rev band range: from half the idle speed (a little of the band is lit at idle) to rpmMax, 500 / 1000 rpm steps
    rLo = Math.max(0, Math.floor(idle * 0.5 / 1000) * 1000);
    rHi = Math.ceil(max / 1000) * 1000;
    if (rHi <= rLo + 1000) rHi = rLo + 1000;
    rStep = (rHi - rLo) / 500 <= 34 ? 500 : 1000;
    rSegs = Math.max(1, Math.round((rHi - rLo) / rStep));
    rShiftSeg = Math.max(0, Math.min(rSegs, Math.floor((shift - rLo) / rStep)));
    rWarnSeg = Math.max(0, Math.min(rShiftSeg, Math.floor((shift - 1800 - rLo) / rStep)));

    var c = bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, bw, bh);
    c.setTransform(k, 0, 0, k, ox, oy);
    c.lineCap = 'butt';
    c.lineJoin = 'round';
    c.textBaseline = 'alphabetic';

    // text metrics (fixed digit cells: the numbers never shift sideways whatever the value)
    c.font = F_SPEED; spCell = 0;
    for (var d = 0; d < 10; d++) spCell = Math.max(spCell, c.measureText(DIGITS[d]).width);
    c.font = F_PCT; pctCell = 0;
    for (d = 0; d < 10; d++) pctCell = Math.max(pctCell, c.measureText(DIGITS[d]).width);
    c.font = F_PCT_SIGN; pctSign = c.measureText('%').width;

    // left wing width: with a battery the full wing, without it just around the team name
    var teamS = (team || '').toUpperCase(), carS = (car || '').toUpperCase();
    c.font = hasBat ? F_TEAM : F_TEAM_BIG;
    var nameW = c.measureText(teamS).width;
    c.font = hasBat ? F_CAR : F_CAR_BIG;
    nameW = Math.max(nameW, c.measureText(carS).width);
    var innerR = CX - HUB_R - 8;                             // right end of the left wing's content
    if (hasBat) leftX = LEFT_X;
    else leftX = Math.max(LEFT_X, Math.round(innerR - LEFT_PAD - 2 - Math.max(70, Math.min(150, nameW))));
    var tx = leftX + LEFT_PAD, maxW = innerR - tx;
    batX = tx;

    // body + gauge disc as one shape (union, filled once)
    c.beginPath();
    rrect(c, leftX, BODY_Y, W - leftX, H - BODY_Y + BODY_R, BODY_R);
    c.moveTo(CX + HUB_R, CY);
    c.arc(CX, CY, HUB_R, 0, TAU, false);
    var g = c.createLinearGradient(0, BODY_Y - 12, 0, H);
    g.addColorStop(0, 'rgba(30,34,42,0.90)');
    g.addColorStop(0.35, C_PANEL);
    g.addColorStop(1, 'rgba(6,7,10,0.91)');
    c.fillStyle = g;
    c.fill('nonzero');
    // darker gauge well
    c.beginPath();
    c.arc(CX, CY, HUB_R - 1, 0, TAU, false);
    c.fillStyle = C_HUB;
    c.fill();
    // top edge highlight following the silhouette
    var ha = Math.asin((BODY_Y - CY) / HUB_R), hx = Math.cos(ha) * HUB_R;
    c.beginPath();
    c.moveTo(leftX + BODY_R, BODY_Y + 0.5);
    c.lineTo(CX - hx, BODY_Y + 0.5);
    c.arc(CX, CY, HUB_R - 0.5, Math.PI - ha, TAU + ha, false);
    c.lineTo(W - BODY_R, BODY_Y + 0.5);
    c.strokeStyle = C_EDGE; c.lineWidth = 1; c.stroke();
    // thin slanted separator between the gear and the tyres
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.beginPath();
    c.moveTo(GEAR_X + 27.5, BODY_Y + 14); c.lineTo(GEAR_X + 23.5, H - 14);
    c.stroke();

    // team colour: slanted strip on the left edge, a wash fading into the panel, a hairline under the gear
    c.save();
    c.beginPath();
    rrect(c, leftX, BODY_Y, W - leftX, H - BODY_Y + BODY_R, BODY_R);
    c.clip();
    c.fillStyle = accent;
    c.beginPath();
    c.moveTo(leftX, BODY_Y); c.lineTo(leftX + 9, BODY_Y); c.lineTo(leftX + 5, H); c.lineTo(leftX, H);
    c.fill();
    g = c.createLinearGradient(leftX, 0, leftX + 150, 0);
    g.addColorStop(0, rgba(acc, 0.24));
    g.addColorStop(1, rgba(acc, 0));
    c.fillStyle = g;
    c.fillRect(leftX, BODY_Y, 150, H - BODY_Y);
    c.restore();
    c.fillStyle = accent;
    c.fillRect(GEAR_X - 14, GEAR_Y + 7, 28, 2);

    // team / car
    c.textAlign = 'left';
    if (c.letterSpacing !== undefined) c.letterSpacing = '0.4px';
    if (hasBat) {
      c.font = F_TEAM; c.fillStyle = C_TEXT;
      c.fillText(ellipsize(c, teamS, maxW), tx, 64);
      c.font = F_CAR; c.fillStyle = C_MUTED;
      c.fillText(ellipsize(c, carS, maxW), tx, 80);
    } else {
      var y0 = carS ? 95 : 105;
      c.font = F_TEAM_BIG; c.fillStyle = C_TEXT;
      c.fillText(ellipsize(c, teamS, maxW), tx, y0);
      c.font = F_CAR_BIG; c.fillStyle = C_MUTED;
      c.fillText(ellipsize(c, carS, maxW), tx, y0 + 18);
    }
    if (c.letterSpacing !== undefined) c.letterSpacing = '0px';

    // battery furniture
    if (hasBat) {
      c.font = F_LABEL; c.fillStyle = C_MUTED;
      c.fillText('電池', tx + 11, BAT_Y - 6);
      boltPath(c, tx + 3.5, BAT_Y - 11.5, 1);
      c.fill();
      c.fillStyle = C_DIM;
      c.beginPath();
      batSegPath(c);
      c.fill();
    }

    // light bar housing + dark LEDs
    c.beginPath();
    rrect(c, BAR_X, BAR_Y, BAR_W, BAR_H, BAR_H / 2);
    c.fillStyle = 'rgba(8,9,12,0.86)'; c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1; c.stroke();
    for (var i = 0; i < LED_N; i++) {
      c.beginPath();
      c.arc(ledX(i), BAR_Y + BAR_H / 2, LED_R, 0, TAU);
      c.fillStyle = i < 5 ? 'rgba(44,240,124,0.13)' : i < 10 ? 'rgba(255,42,42,0.15)' : 'rgba(61,123,255,0.17)';
      c.fill();
    }

    // rev band: unlit segments (red zone tinted), ticks every 1000 rpm on the outside
    c.lineWidth = RPM_W;
    c.strokeStyle = 'rgba(255,255,255,0.09)';
    c.beginPath(); segPath(c, 0, rShiftSeg); c.stroke();
    c.strokeStyle = 'rgba(255,48,48,0.26)';
    c.beginPath(); segPath(c, rShiftSeg, rSegs); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.30)'; c.lineWidth = 1;
    c.beginPath();
    for (var r = Math.ceil(rLo / 1000) * 1000; r <= rHi; r += 1000) {
      var a = rpmAngle(r), ca = Math.cos(a), sa = Math.sin(a);
      c.moveTo(CX + ca * (RPM_R + RPM_W / 2 + 1), CY + sa * (RPM_R + RPM_W / 2 + 1));
      c.lineTo(CX + ca * (RPM_R + RPM_W / 2 + 3.2), CY + sa * (RPM_R + RPM_W / 2 + 3.2));
    }
    c.stroke();

    // pedal tracks + labels
    c.lineWidth = PED_W; c.lineCap = 'round';
    c.strokeStyle = 'rgba(255,48,48,0.16)';
    c.beginPath(); c.arc(CX, CY, PED_R, BRK_A0, BRK_A0 + BRK_SW, false); c.stroke();
    c.strokeStyle = 'rgba(39,224,122,0.15)';
    c.beginPath(); c.arc(CX, CY, PED_R, THR_A0, THR_A0 - THR_SW, true); c.stroke();
    c.lineCap = 'butt';
    c.font = F_LABEL; c.textAlign = 'center';
    c.fillStyle = 'rgba(255,110,110,0.95)';
    c.fillText('煞車', CX - 43, CY + 45);
    c.fillStyle = 'rgba(90,235,150,0.95)';
    c.fillText('油門', CX + 43, CY + 45);
    c.font = F_UNIT; c.fillStyle = C_MUTED;
    if (c.letterSpacing !== undefined) c.letterSpacing = '1.5px';
    c.fillText('KM/H', CX + 1, SPEED_Y + 16);
    if (c.letterSpacing !== undefined) c.letterSpacing = '0px';
    c.font = F_LABEL; c.fillStyle = C_MUTED;
    c.fillText('檔位', GEAR_X, GEAR_Y + 25);

    // tyres: car outline (axles, spine), labels
    c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(TY_X[0] + TY_W[0], TY_Y[0] + TY_H / 2); c.lineTo(TY_X[1], TY_Y[1] + TY_H / 2);
    c.moveTo(TY_X[2] + TY_W[2], TY_Y[2] + TY_H / 2); c.lineTo(TY_X[3], TY_Y[3] + TY_H / 2);
    c.moveTo(TY_CX, TY_Y[0] + 4); c.lineTo(TY_CX, TY_Y[2] + TY_H - 4);
    c.stroke();
    c.fillStyle = C_MUTED; c.font = F_LABEL; c.textAlign = 'center';
    c.fillText('輪胎', TY_CX, GEAR_Y + 25);
    c.fillText('下一組', CMP_X, NXT_Y - 16);

    buildAtlas(limKmh);
  }

  // ---- sprite atlas: every piece of text that changes, the lit LED bar, the battery bars, the pit band ----------
  // A sprite is painted in design units around an anchor; blit() puts that anchor on a whole device pixel.
  function buildAtlas(limKmh) {
    var list = [];
    function add(id, x0, y0, x1, y1, paint) { list.push({ id: id, x0: x0, y0: y0, x1: x1, y1: y1, paint: paint }); }
    var cols3 = [C_TEXT, C_AMBER, C_BRK], cols4 = [C_TEXT, C_DEP, C_BRK, C_MUTED];
    var d, j;
    // speed digits, anchored at the centre of their cell on the baseline
    for (j = 0; j < 3; j++) for (d = 0; d < 10; d++) {
      add(SP_SPD + j * 10 + d, -spCell / 2 - 8, -SPEED_PX * 0.8, spCell / 2 + 10, SPEED_PX * 0.12,
        textPainter(F_SPEED, cols3[j], DIGITS[d]));
    }
    // gear: N muted, R amber, the rest white
    for (d = 0; d < 11; d++) {
      add(SP_GEAR + d, -22, -38, 26, 6, textPainter(F_GEAR, d === 1 ? C_MUTED : d === 0 ? C_AMBER : C_TEXT, GEAR_TXT[d]));
    }
    // battery percentage digits and sign
    for (j = 0; j < 4; j++) for (d = 0; d < 10; d++) {
      add(SP_PCT + j * 10 + d, -pctCell / 2 - 4, -14, pctCell / 2 + 5, 3, textPainter(F_PCT, cols4[j], DIGITS[d]));
    }
    add(SP_PSIGN, -pctSign / 2 - 3, -10, pctSign / 2 + 3, 3, textPainter(F_PCT_SIGN, C_MUTED, '%'));
    add(SP_PSIGN + 1, -pctSign / 2 - 3, -10, pctSign / 2 + 3, 3, textPainter(F_PCT_SIGN, C_BRK, '%'));
    // battery state tags, anchored at the left end of the baseline
    add(SP_TAG, -1, -11, 56, 3, tagPainter(C_DEP, '放電中', true));
    add(SP_TAG + 1, -1, -11, 56, 3, tagPainter(C_HAR, '充電中', true));
    add(SP_TAG + 2, -1, -11, 60, 3, tagPainter(C_LOW, '電量耗盡', false));
    // compound badges, anchored at the centre
    for (d = 0; d < 4; d++) {
      add(SP_BADGE + d, -CMP_R - 1, -CMP_R - 1, CMP_R + 1, CMP_R + 1, badgePainter(CMP_R, d - 1, F_CMP));
      add(SP_BADGE + 4 + d, -NXT_R - 1, -NXT_R - 1, NXT_R + 1, NXT_R + 1, badgePainter(NXT_R, d - 1, F_NXT));
    }
    // pit band variants, anchored at the band's top-left
    var bandText = '維修區限速 ' + limKmh;
    for (d = 0; d < 6; d++) add(SP_BAND + d, -1.5, -1.5, BAND_W + 1.5, BAND_H + 1.5, bandPainter(d, bandText));
    // LED bar fully lit (group colours / all blue), anchored at the bar's top-left
    add(SP_LEDS, 0, 0, BAR_W, BAR_H, ledPainter(false));
    add(SP_LEDS + 1, 0, 0, BAR_W, BAR_H, ledPainter(true));
    // battery bars full, anchored at the bar's top-left
    var bl = LEFT_R - batX;
    add(SP_BATBAR, 0, 0, bl, BAT_H, batPainter(C_BAT));
    add(SP_BATBAR + 1, 0, 0, bl, BAT_H, batPainter(C_DEP));
    add(SP_BATBAR + 2, 0, 0, bl, BAT_H, batPainter(C_LOW));

    // shelf packing in device pixels
    var AW = 2048, x = 0, y = 0, rowH = 0, i, s;
    for (i = 0; i < list.length; i++) {
      s = list[i];
      var offX = Math.floor(s.x0 * k) - 1, offY = Math.floor(s.y0 * k) - 1;
      var w = Math.ceil(s.x1 * k) + 1 - offX, h = Math.ceil(s.y1 * k) + 1 - offY;
      if (x + w > AW) { x = 0; y += rowH + 1; rowH = 0; }
      SX[s.id] = x; SY[s.id] = y; SW[s.id] = w; SH[s.id] = h; SOX[s.id] = offX; SOY[s.id] = offY;
      x += w + 1;
      if (h > rowH) rowH = h;
    }
    atlas.width = AW;
    atlas.height = y + rowH + 1;
    var c = actx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, atlas.width, atlas.height);
    c.textBaseline = 'alphabetic';
    for (i = 0; i < list.length; i++) {
      s = list[i];
      c.save();
      c.beginPath(); c.rect(SX[s.id], SY[s.id], SW[s.id], SH[s.id]); c.clip();
      c.setTransform(k, 0, 0, k, SX[s.id] - SOX[s.id], SY[s.id] - SOY[s.id]);
      s.paint(c);
      c.restore();
    }
  }
  function textPainter(font, col, txt) {
    return function (c) { c.font = font; c.fillStyle = col; c.textAlign = 'center'; c.fillText(txt, 0, 0); };
  }
  function tagPainter(col, txt, bolt) {
    return function (c) {
      c.font = F_TAG; c.fillStyle = col; c.textAlign = 'left';
      c.fillText(txt, bolt ? 12 : 0, 0);
      if (bolt) { boltPath(c, 1, -10, 0.95); c.fill(); }
    };
  }
  function badgePainter(r, idx, font) {
    return function (c) {
      var col = idx >= 0 ? CMP_COL[idx] : C_MUTED;
      c.beginPath(); c.arc(0, 0, r, 0, TAU);
      c.fillStyle = '#0c0d10'; c.fill();
      c.lineWidth = r * 0.24; c.strokeStyle = col;
      c.beginPath(); c.arc(0, 0, r - r * 0.12, 0, TAU); c.stroke();
      c.font = font; c.textAlign = 'center'; c.fillStyle = col;
      c.fillText(idx >= 0 ? CMP_TXT[idx] : '?', 0, r * 0.36);
    };
  }
  // variant: 0 / 1 limiter, amber (solid phase), without / with the PIT chip; 2 / 3 the same, dark phase;
  // 4 / 5 in the lane without the limiter, red solid / dark (always with the chip)
  function bandPainter(v, text) {
    return function (c) {
      var lim = v < 4, solid = v === 0 || v === 1 || v === 4, pit = v === 1 || v === 3 || v >= 4;
      c.beginPath();
      rrect(c, 0, 0, BAND_W, BAND_H, 5);
      c.fillStyle = lim ? (solid ? C_AMBER : 'rgba(26,20,4,0.94)') : (solid ? 'rgba(150,14,14,0.94)' : 'rgba(40,6,6,0.94)');
      c.fill();
      c.strokeStyle = lim ? C_AMBER : C_BRK; c.lineWidth = 1.5; c.stroke();
      var tx = BAND_W / 2;
      if (pit) {                               // "in the pit lane" chip on the left
        c.beginPath();
        rrect(c, 4, 4, 34, BAND_H - 8, 3);
        c.fillStyle = lim && solid ? '#111' : '#fff'; c.fill();
        c.font = F_CHIP; c.textAlign = 'center';
        c.fillStyle = lim && solid ? C_AMBER : '#111';
        c.fillText('PIT', 21, 16.5);
        tx += 19;
      }
      c.font = F_BAND; c.textAlign = 'center';
      c.fillStyle = lim ? (solid ? '#111' : C_AMBER) : '#fff';
      c.fillText(text, tx, 17);
    };
  }
  function ledPainter(blue) {
    return function (c) {
      var y = BAR_H / 2;
      for (var i = 0; i < LED_N; i++) {
        var g = blue ? 2 : (i / 5) | 0, x = ledX(i) - BAR_X;
        c.fillStyle = LED_GLOW[g];
        c.beginPath(); c.arc(x, y, LED_GR, 0, TAU); c.fill();
        c.fillStyle = LED_COL[g];
        c.beginPath(); c.arc(x, y, LED_R, 0, TAU); c.fill();
      }
    };
  }
  function batPainter(col) {
    return function (c) {
      var sw = batSegW();
      c.fillStyle = col;
      c.beginPath();
      for (var i = 0; i < BAT_SEG; i++) c.rect(i * (sw + BAT_GAP), 0, sw, BAT_H);
      c.fill();
    };
  }
  // sprite `id` with its anchor at design point (x, y); the context must have the identity transform
  function blit(c, id, x, y) {
    c.drawImage(atlas, SX[id], SY[id], SW[id], SH[id],
      Math.round(ox + x * k) + SOX[id], Math.round(oy + y * k) + SOY[id], SW[id], SH[id]);
  }
  // the left part of a sprite anchored at its left edge, cut `w` design units right of the anchor
  function blitLeft(c, id, x, y, w) {
    var sw = Math.round(w * k) - SOX[id];
    if (sw <= 0) return;
    if (sw > SW[id]) sw = SW[id];
    c.drawImage(atlas, SX[id], SY[id], sw, SH[id],
      Math.round(ox + x * k) + SOX[id], Math.round(oy + y * k) + SOY[id], sw, SH[id]);
  }

  // ---- per frame -------------------------------------------------------------------------------------------------
  function draw(t) {
    if (!ctx) return;
    try { frame(t); } catch (e) { warn(e); }
  }

  function frame(t) {
    var now = num(tel.clock(), 0), lastT = sm[SM_T], dt = lastT < 0 ? 0 : (now - lastT) / 1000;
    sm[SM_T] = now;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    if (sizeDirty) applySize();
    if (bw < 8 || bh < 8) return;
    if (!t || typeof t !== 'object') t = EMPTY;

    // ---- sanitise
    var speed = num(t.speedKmh, 0);
    if (speed < 0) speed = -speed;
    if (speed > 999) speed = 999;
    var gear = num(t.gear, 0);
    gear = gear < -0.5 ? -1 : gear > 9 ? 9 : Math.round(gear);
    var idle = num(t.rpmIdle, 4000), shift = num(t.rpmShift, 11800), max = num(t.rpmMax, 12500);
    if (!(idle >= 0 && idle < 30000)) idle = 4000;
    if (!(shift > idle && shift < 30000)) shift = Math.max(idle + 1000, 11800);
    if (!(max >= shift && max < 32000)) max = shift + 700;
    var rpm = num(t.rpm, idle);
    if (rpm < 0) rpm = 0; else if (rpm > max * 1.1) rpm = max * 1.1;
    var thr = clamp01(num(t.throttle, 0)), brk = clamp01(num(t.brake, 0));
    var hasBat = typeof t.battery === 'number' && t.battery === t.battery;
    var bat = hasBat ? clamp01(t.battery) : 0;
    var dep = clamp01(num(t.deploy, 0)), har = clamp01(num(t.harvest, 0));
    var lim = t.limiter === true, inPit = t.inPit === true;
    var limKmh = Math.round(num(t.limitKmh, 80));
    if (!(limKmh >= 5 && limKmh <= 400)) limKmh = 80;
    var ty = t.tyres && typeof t.tyres === 'object' ? t.tyres : EMPTY;
    var cmp = compIndex(ty.compound);
    if (cmp < 0 && ty.compound === undefined) cmp = 1;         // no compound given: medium (the reference)
    var nxt = t.nextCompound === undefined || t.nextCompound === null ? cmp : compIndex(t.nextCompound);
    var team = typeof t.team === 'string' ? t.team : '', car = typeof t.car === 'string' ? t.car : '';
    var col = typeof t.colour === 'string' ? t.colour : '', col2 = typeof t.colour2 === 'string' ? t.colour2 : '';

    if (staticDirty || team !== sk.team || car !== sk.car || col !== sk.colour || col2 !== sk.colour2 ||
        idle !== sk.idle || shift !== sk.shift || max !== sk.max || hasBat !== sk.bat || limKmh !== sk.lim) {
      buildStatic(team, car, col, col2, idle, shift, max, hasBat, limKmh);
    }

    // ---- smoothing (light: a keyboard on / off pedal shows ~80 % of the change within 50 ms)
    var sThr, sBrk, sRpm, sBat, sDep, sHar, shownSpeed;
    if (fresh) {
      fresh = false;
      sThr = thr; sBrk = brk; sRpm = rpm; sBat = bat; sDep = dep; sHar = har; shownSpeed = Math.round(speed);
    } else {
      var aP = 1 - Math.exp(-dt / TAU_PEDAL), aF = 1 - Math.exp(-dt / TAU_FX);
      sThr = sm[SM_THR] + (thr - sm[SM_THR]) * aP;
      sBrk = sm[SM_BRK] + (brk - sm[SM_BRK]) * aP;
      sRpm = sm[SM_RPM] + (rpm - sm[SM_RPM]) * (1 - Math.exp(-dt / TAU_RPM));
      sBat = sm[SM_BAT] + (bat - sm[SM_BAT]) * (1 - Math.exp(-dt / TAU_BAT));
      sDep = sm[SM_DEP] + (dep - sm[SM_DEP]) * aF;
      sHar = sm[SM_HAR] + (har - sm[SM_HAR]) * aF;
      // speed: whole km/h with a little hysteresis, so a steady speed does not flicker between two numbers
      shownSpeed = sm[SM_SPEED];
      if (Math.abs(speed - shownSpeed) > 0.62) shownSpeed = Math.round(speed);
    }
    sm[SM_THR] = sThr; sm[SM_BRK] = sBrk; sm[SM_RPM] = sRpm; sm[SM_BAT] = sBat; sm[SM_DEP] = sDep; sm[SM_HAR] = sHar;
    sm[SM_SPEED] = shownSpeed;
    var flash = now % 500 < 250;                   // 2 Hz flashing
    var fast = now % 140 < 70;                     // shift-point strobe (both 'on' at multiples of 3500 ms)
    var over = inPit && speed > limKmh + 3;
    var batDep = sk.bat && sDep > 0.08, batHar = sk.bat && !batDep && sHar > 0.08;

    // ---- paint: static layer
    var c = ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, bw, bh);
    c.drawImage(base, 0, 0);

    // ---- paint: paths, in design units
    c.setTransform(k, 0, 0, k, ox, oy);
    c.lineCap = 'butt';
    // rev band: lit segments, white -> amber -> red
    var lit = (sRpm - rLo) / rStep, litN = Math.floor(lit);
    if (litN > rSegs) litN = rSegs;
    if (litN > 0) {
      c.lineWidth = RPM_W;
      var n1 = Math.min(litN, rWarnSeg), n2 = Math.min(litN, rShiftSeg);
      if (n1 > 0) { c.strokeStyle = lim ? C_AMBER : C_TEXT; c.beginPath(); segPath(c, 0, n1); c.stroke(); }
      if (n2 > n1) { c.strokeStyle = C_AMBER; c.beginPath(); segPath(c, n1, n2); c.stroke(); }
      if (litN > n2) { c.strokeStyle = C_BRK; c.beginPath(); segPath(c, n2, litN); c.stroke(); }
    }
    if (litN < rSegs && lit > 0) {                 // tip of the band: a needle across it
      var ta = RPM_A0 + (RPM_A1 - RPM_A0) * lit / rSegs, tc = Math.cos(ta), ts = Math.sin(ta);
      c.strokeStyle = C_TEXT; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(CX + tc * (RPM_R - RPM_W / 2 - 1), CY + ts * (RPM_R - RPM_W / 2 - 1));
      c.lineTo(CX + tc * (RPM_R + RPM_W / 2 + 1), CY + ts * (RPM_R + RPM_W / 2 + 1));
      c.stroke();
    }
    // pedals
    c.lineWidth = PED_W; c.lineCap = 'round';
    if (sBrk > 0.004) {
      c.strokeStyle = C_BRK;
      c.beginPath(); c.arc(CX, CY, PED_R, BRK_A0, BRK_A0 + BRK_SW * sBrk, false); c.stroke();
    }
    if (sThr > 0.004) {
      c.strokeStyle = C_THR;
      c.beginPath(); c.arc(CX, CY, PED_R, THR_A0, THR_A0 - THR_SW * sThr, true); c.stroke();
    }
    c.lineCap = 'butt';
    if (batDep) {                                  // battery glow while deploying
      c.fillStyle = 'rgba(255,216,74,0.18)';
      c.globalAlpha = alpha(0.5 + 0.5 * Math.min(1, sDep * 1.5) * (0.75 + 0.25 * Math.sin(now * 0.02)));
      c.beginPath(); rrect(c, batX - 3, BAT_Y - 3, LEFT_R - batX + 6, BAT_H + 6, 4); c.fill();
      c.globalAlpha = 1;
    }
    if (batDep || batHar) chevrons(c, batDep);
    drawTyres(c, ty, flash);

    // ---- paint: sprites, at whole device pixels
    c.setTransform(1, 0, 0, 1, 0, 0);
    // shift lights / pit band
    if (lim || inPit) {
      blit(c, SP_BAND + (lim ? (flash ? 0 : 2) + (inPit ? 1 : 0) : (over && !flash ? 5 : 4)), BAND_X, BAND_Y);
    } else {
      var on = sk.shift - (sk.shift - sk.idle) * 0.36;
      var f = (sRpm - on) / (sk.shift - on), n = f <= 0 ? 0 : f >= 1 ? LED_N : Math.floor(f * LED_N + 0.5);
      if (n >= LED_N) { if (fast) blit(c, SP_LEDS + 1, BAR_X, BAR_Y); }         // shift point: all blue, strobing
      else if (n > 0) blitLeft(c, SP_LEDS, BAR_X, BAR_Y, ledX(n - 1) + LED_DX / 2 - BAR_X);
    }
    // speed: right-aligned in three fixed cells centred on the gauge
    var sc = lim ? 1 : over && flash ? 2 : 0;
    var v = shownSpeed, right = CX - 2 + spCell * 1.5;
    for (var i = 0; i < 3; i++) {
      blit(c, SP_SPD + sc * 10 + v % 10, right - spCell * (i + 0.5), SPEED_Y);
      v = (v / 10) | 0;
      if (v === 0) break;
    }
    // gear
    blit(c, SP_GEAR + gear + 1, GEAR_X, GEAR_Y);
    // battery
    if (sk.bat) drawBattery(c, flash, batDep, batHar);
    // compound badges
    blit(c, SP_BADGE + cmp + 1, CMP_X, CMP_Y);
    if (nxt === cmp) c.globalAlpha = 0.55;
    blit(c, SP_BADGE + 4 + nxt + 1, CMP_X, NXT_Y);
    c.globalAlpha = 1;
  }

  function drawBattery(c, flash, dep, har) {
    var sBat = sm[SM_BAT], pct = Math.round(sBat * 100), empty = pct <= 0, low = pct < 15;
    // percentage, right-aligned in fixed cells, with a small % sign
    var y = BAT_Y - 5;
    blit(c, SP_PSIGN + (empty && flash ? 1 : 0), LEFT_R - pctSign / 2, y);
    var pc = empty ? (flash ? 2 : 3) : dep ? 1 : 0;
    var v = pct, right = LEFT_R - pctSign - 1.5;
    for (var i = 0; i < 3; i++) {
      blit(c, SP_PCT + pc * 10 + v % 10, right - pctCell * (i + 0.5), y);
      v = (v / 10) | 0;
      if (v === 0) break;
    }
    // bar: the left part of a full bar, cut at the charge
    if (sBat > 0.002) blitLeft(c, SP_BATBAR + (dep ? 1 : low ? 2 : 0), batX, BAT_Y, (LEFT_R - batX) * sBat);
    // state line
    var sy = BAT_Y + BAT_H + 17;
    if (dep && !empty) blit(c, SP_TAG, batX, sy);
    else if (har && pct < 100) blit(c, SP_TAG + 1, batX, sy);
    else if (empty) {
      if (!flash) c.globalAlpha = 0.55;
      blit(c, SP_TAG + 2, batX, sy);
      c.globalAlpha = 1;
    }
  }
  // three chevrons running right (deploy: energy out) or left (harvest: energy in); design units
  // (no double arguments: they would be boxed on every call)
  function chevrons(c, out) {
    var ph = (sm[SM_T] % 600) / 600, x = batX + 62, y = BAT_Y + BAT_H + 13;
    c.lineWidth = 1.8; c.strokeStyle = out ? C_DEP : C_HAR;
    for (var i = 0; i < 3; i++) {
      var j = out ? i : 2 - i;
      var a = (ph * 3 - j) % 3;
      if (a < 0) a += 3;
      c.globalAlpha = alpha(a < 1 ? 1 - a * 0.7 : 0.3);
      var cx = x + i * 8, d = out ? 1 : -1;
      c.beginPath();
      c.moveTo(cx - 2.5 * d, y - 4); c.lineTo(cx + 1.5 * d, y); c.lineTo(cx - 2.5 * d, y + 4);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  // four tyres in car layout (design units): wear colour and remaining tread, flat spots, a puncture
  function drawTyres(c, ty, flash) {
    var wear = ty.wear, flat = ty.flat;
    if (!wear || typeof wear !== 'object') wear = EMPTY;
    if (!flat || typeof flat !== 'object') flat = EMPTY;
    var pun = Math.round(num(ty.puncture, -1));
    for (var i = 0; i < 4; i++) {
      var w = clamp01(num(wear[i], 0)), fl = clamp01(num(flat[i], 0));
      var x = TY_X[i], y = TY_Y[i], tw = TY_W[i], th = TY_H;
      if (i === pun) {
        // puncture: deflated (squat), flashing red outline, a white X
        c.beginPath(); rrect(c, x - 1, y + 3, tw + 2, th - 3, 3.5);
        c.fillStyle = 'rgba(120,10,10,0.9)'; c.fill();
        c.strokeStyle = flash ? '#ff3030' : 'rgba(255,48,48,0.45)'; c.lineWidth = 1.6; c.stroke();
        c.strokeStyle = '#fff'; c.lineWidth = 1.8;
        c.beginPath();
        c.moveTo(x + 3, y + 8); c.lineTo(x + tw - 3, y + th - 4);
        c.moveTo(x + tw - 3, y + 8); c.lineTo(x + 3, y + th - 4);
        c.stroke();
        continue;
      }
      // outline in the wear colour, the remaining tread as a level from the bottom
      var colW = WEAR_COL[Math.round(w * WEAR_N)];
      c.beginPath(); rrect(c, x, y, tw, th, 4);
      c.fillStyle = 'rgba(255,255,255,0.07)'; c.fill();
      c.strokeStyle = colW; c.lineWidth = 1.5; c.stroke();
      var lvl = (th - 3) * (1 - w);
      if (lvl < 2.5) lvl = 2.5;
      c.fillStyle = colW;
      c.beginPath(); rrect(c, x + 1.5, y + th - 1.5 - lvl, tw - 3, lvl, lvl > 6 ? 2.8 : 1.2); c.fill();
      if (fl > 0.12) {
        // flat spot: a bright scuffed patch across the tread (thicker when worse), a marker on the outer side
        var py = y + th * 0.4, ph = 2.2 + 3.4 * fl, mx = i === 0 || i === 2 ? x - 2.5 : x + tw + 2.5, d = mx < x ? -1 : 1;
        c.fillStyle = 'rgba(8,9,12,0.92)';
        c.fillRect(x + 0.75, py - ph / 2 - 1.3, tw - 1.5, ph + 2.6);
        c.fillStyle = '#fff';
        c.fillRect(x + 0.75, py - ph / 2, tw - 1.5, ph);
        c.beginPath();
        c.moveTo(mx, py); c.lineTo(mx + 4.5 * d, py - 3.2); c.lineTo(mx + 4.5 * d, py + 3.2); c.closePath();
        c.fill();
      }
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = tel;
})(typeof window !== 'undefined' ? window : this);
