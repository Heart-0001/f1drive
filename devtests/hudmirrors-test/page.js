// Lives in the PAGE of the real game (injected by devtests/hudmirrors-test/run.js with executeJavaScript, after
// js/hudmirrors.js itself). window.__hm: installs the HUD mirrors into the running game WITHOUT editing main.js:
//   - the renderer is taken from the scene's onBeforeRender (three.js hands it over), then renderer.render is wrapped:
//     right after main.js's own renderer.render(scene, camera) of a game frame (F1.game.running) it calls
//     hm.render(car.state, dt) - exactly the one line main.js will get;
//   - the two frame elements are added to #hud (the layout CSS comes from layouts.css through insertCSS);
//   - test cars (magenta behind-left, cyan behind-right, yellow straight behind) can follow our car;
//   - frame cost: requestAnimationFrame callbacks timed (main.js's whole frame), GPU-synced cost loops.
(function () {
  'use strict';
  if (window.__hm) return 'already';
  var H = window.__hm = { auto: true, follow: false, hm: null, renderer: null, scene: null, frames: [], errs: [], mainRenders: 0 };
  window.addEventListener('error', function (e) { H.errs.push(String(e && (e.message || e.type))); });
  window.addEventListener('unhandledrejection', function (e) { H.errs.push('rejection: ' + String(e && e.reason)); });

  // ---- rAF timing (main.js's frame callback, mirrors included) ----
  var raf = window.requestAnimationFrame;
  H.ft = [];
  window.requestAnimationFrame = function (cb) {
    return raf.call(window, function (t) {
      var s = performance.now();
      cb(t);
      H.ft.push(performance.now() - s);
      if (H.ft.length > 4000) H.ft.splice(0, 2000);
    });
  };
  H.frameStats = function () {
    var f = H.ft.slice().sort(function (a, b) { return a - b; }); H.ft.length = 0;
    var s = 0; for (var i = 0; i < f.length; i++) s += f[i];
    return { n: f.length, mean: f.length ? +(s / f.length).toFixed(3) : 0, p50: +(f[f.length >> 1] || 0).toFixed(3),
             p95: +(f[Math.floor(f.length * 0.95)] || 0).toFixed(3), max: +(f[f.length - 1] || 0).toFixed(3) };
  };

  // ---- renderer capture + the per-frame call ----
  H.hook = function () {
    if (H.renderer) return 'hooked';
    var s = F1.game.camera;
    while (s && !s.isScene) s = s.parent;
    if (!s) {                       // no track yet: the camera is not in the scene. The scene is main.js's only Scene;
      return 'no-scene';            // find it on the first render instead (any Scene rendered with the main camera)
    }
    H.scene = s;
    s.onBeforeRender = function (r) {
      delete s.onBeforeRender;
      H.wrap(r);
    };
    return 'armed';
  };
  // before a track is loaded: catch the renderer from the scene that main.js renders with its camera (menu still)
  H.hookAny = function () {
    if (H.renderer) return 'hooked';
    var proto = THREE.Scene.prototype, orig = proto.onBeforeRender;
    proto.onBeforeRender = function (r, sc, cam) {
      if (!H.renderer && cam === F1.game.camera) { proto.onBeforeRender = orig; H.scene = sc; H.wrap(r); }
    };
    return 'armed-any';
  };
  H.wrap = function (r) {
    H.renderer = r;
    var real = r.render;
    H.realRender = function (sc, c) { return real.call(r, sc, c); };
    r.render = function (sc, c) {
      var main = sc === H.scene && c === F1.game.camera && r.getRenderTarget() === null;
      if (main && H.follow && F1.game.car) H.placeCars();
      var out = real.call(r, sc, c);
      if (main) {
        H.mainRenders++;
        if (H.hm && H.auto && F1.game.running) {
          var now = performance.now(), dt = H.lastT ? (now - H.lastT) / 1000 : 0;
          H.lastT = now;
          H.hm.render(F1.game.car.state, dt);       // <- the one line for main.js
        }
      }
      return out;
    };
  };

  H.makeFrames = function () {
    var hud = document.getElementById('hud');
    if (H.frames.length) return true;
    ['hud-mirror-l', 'hud-mirror-r'].forEach(function (id) {
      var d = document.createElement('div');
      d.id = id; d.className = 'hud-mirror';
      hud.insertBefore(d, hud.firstChild);
      H.frames.push(d);
    });
    // insertBefore(firstChild) twice put r before l: keep l first in the tree
    hud.insertBefore(H.frames[0], H.frames[1]);
    return true;
  };
  H.layout = function (name) {
    document.body.classList.remove('mir-a', 'mir-b', 'mir-c');
    if (name) document.body.classList.add('mir-' + name);
    if (H.hm) H.hm.relayout();
    return name;
  };

  H.create = function (opts) {
    if (H.hm) H.hm.dispose();
    opts = opts || {};
    var o = { exclude: F1.game.cockpit ? [F1.game.cockpit.group] : [] };
    if (opts.elements !== false) { H.makeFrames(); o.elements = H.frames; }
    for (var k in opts) if (k !== 'elements') o[k] = opts[k];
    H.hm = F1.createHudMirrors(H.renderer, H.scene, o);
    return H.hm.info();
  };

  // ---- test cars ----
  H.cars = [];
  var SPOTS = [
    { name: 'L', colour: '#ff00ff', back: 7, left: 3.5 },     // behind-left: left mirror, its outer (left) part
    { name: 'R', colour: '#00ffff', back: 8, left: -3.5 },    // behind-right: right mirror, its outer (right) part
    { name: 'C', colour: '#ffff00', back: 25, left: 0 }       // straight behind: both mirrors, their inner parts
  ];
  H.addCars = function () {
    if (H.cars.length) return H.cars.length;
    SPOTS.forEach(function (p) {
      var m = F1.createCarModel(p.colour, 'TEST ' + p.name);
      if (m.setLivery) m.setLivery(p.colour, p.colour, p.colour);
      m.setName && m.setName('TEST ' + p.name);
      H.scene.add(m.group);
      H.cars.push({ m: m, p: p });
    });
    H.placeCars();
    return H.cars.length;
  };
  H.placeCars = function () {
    var s = F1.game.car.state, tr = F1.game.track, h = s.heading;
    var fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
    var eye = { x: s.x, y: (s.y || 0) + 0.8, z: s.z };
    for (var i = 0; i < H.cars.length; i++) {
      var c = H.cars[i], x = s.x - fx * c.p.back + lx * c.p.left, z = s.z - fz * c.p.back + lz * c.p.left;
      var y = tr && tr.groundY ? tr.groundY(x, z) : (s.y || 0);
      c.m.update({ x: x, y: y, z: z, heading: h, pitch: s.pitch || 0, roll: s.roll || 0, speed: s.speed, steer: 0 }, 1 / 60, eye);
    }
    return true;
  };
  H.removeCars = function () {
    H.cars.forEach(function (c) { H.scene.remove(c.m.group); c.m.dispose(); });
    H.cars = [];
    return true;
  };

  // ---- GPU-synced cost: n times [fn + 1-pixel readPixels] minus n times [readPixels] ----
  H.syncCost = function (what, n) {
    n = n || 60;
    var r = H.renderer, gl = r.getContext(), px = new Uint8Array(4), st = F1.game.car.state;
    function sync() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    var fn = what === 'main' ? function () { H.realRender(H.scene, F1.game.camera); }
           : what === 'mirrors' ? function () { H.hm.render(st, 1 / 60); }
           : what === 'both' ? function () { H.realRender(H.scene, F1.game.camera); H.hm.render(st, 1 / 60); }
           : function () {};
    var auto = H.auto; H.auto = false;
    try {
      for (var w = 0; w < 10; w++) { fn(); sync(); }
      var t0 = performance.now();
      for (var i = 0; i < n; i++) sync();
      var base = (performance.now() - t0) / n;
      var t1 = performance.now();
      for (var j = 0; j < n; j++) { fn(); sync(); }
      var tot = (performance.now() - t1) / n;
      return { what: what, ms: +(tot - base).toFixed(3), sync: +base.toFixed(3) };
    } finally { H.auto = auto; }
  };
  // GPU time through EXT_disjoint_timer_query_webgl2, when the browser offers it
  H.gpuTime = function (what, n) {
    var r = H.renderer, gl = r.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return Promise.resolve({ what: what, unavailable: true });
    var st = F1.game.car.state, qs = [], auto = H.auto;
    H.auto = false;
    for (var i = 0; i < (n || 30); i++) {
      var q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      if (what === 'main') H.realRender(H.scene, F1.game.camera); else H.hm.render(st, 1 / 60);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
    }
    H.auto = auto;
    return new Promise(function (res) {
      var tries = 0;
      (function poll() {
        var last = qs[qs.length - 1];
        if (!gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE) && tries++ < 200) return setTimeout(poll, 10);
        var disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT), v = [];
        qs.forEach(function (q) { v.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); });
        v.sort(function (a, b) { return a - b; });
        res({ what: what, disjoint: !!disjoint, p50: +v[v.length >> 1].toFixed(3), mean: +(v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(3), n: v.length });
      })();
    });
  };
  return 'ok';
})();
