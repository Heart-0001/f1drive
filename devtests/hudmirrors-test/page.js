// Lives in the PAGE of the real game (injected by devtests/hudmirrors-test/run.js with executeJavaScript).
// window.__hm: test tools around the HUD rear-view mirrors that the game itself draws since v6.1 (js/main.js creates
// F1.createHudMirrors once with the cockpit, exclude [cockpit.group], the frames #hud-mirror-l / -r of index.html, and
// calls hm.render(car.state, dt) right after its main render; key V / the 後照鏡 switch of 設定 hide them):
//   - the renderer is taken from the scene's onBeforeRender (three.js hands it over) - for a separate instance of the
//     module (the no-track checks) and the cost loops; renderer.render is wrapped only to count the game's main renders
//     and, with __hm.follow, to put the test cars behind our car right before them;
//   - __hm.game(): the game's own instance (F1.game.hudMirrors) and frames;
//   - test cars (magenta behind-left, cyan behind-right, yellow straight behind) can follow our car;
//   - frame cost: requestAnimationFrame callbacks timed (main.js's whole frame, mirrors included), GPU-synced cost loops.
(function () {
  'use strict';
  if (window.__hm) return 'already';
  var H = window.__hm = { follow: false, hm: null, renderer: null, scene: null, frames: [], errs: [], mainRenders: 0 };
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

  // ---- renderer capture ----
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
      if (main) H.mainRenders++;
      return real.call(r, sc, c);
    };
  };

  // ---- the game's own mirrors ----
  H.game = function () {
    H.hm = F1.game.hudMirrors || null;
    H.frames = [document.getElementById('hud-mirror-l'), document.getElementById('hud-mirror-r')];
    return H.hm ? H.hm.info() : null;
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

  // ---- is the cockpit left out of the mirror passes? A cockpit mesh, never frustum-culled for the test, counts the
  //      passes of the mirror cameras that draw it (none while main.js's exclude [cockpit.group] is in force) ----
  H.cockpitProbe = function () {
    var mesh = null, noop = THREE.Object3D.prototype.onBeforeRender;
    // (not the glass of the in-car mirrors: its own onBeforeRender draws them)
    F1.game.cockpit.group.traverse(function (o) { if (!mesh && o.isMesh && o.visible && o.onBeforeRender === noop) mesh = o; });
    if (!mesh) return null;
    var p = { mesh: mesh, seen: 0, main: 0, culled: mesh.frustumCulled, before: mesh.onBeforeRender };
    mesh.frustumCulled = false;
    mesh.onBeforeRender = function (r, s, c) { if (c && c.name === 'hud-mirror-camera') p.seen++; else p.main++; };
    H.probe = p;
    return true;
  };
  H.cockpitProbeEnd = function () {
    var p = H.probe; if (!p) return null;
    p.mesh.frustumCulled = p.culled; p.mesh.onBeforeRender = p.before;
    H.probe = null;
    return { seen: p.seen, main: p.main };
  };

  // ---- GPU-synced cost: n times [fn + 1-pixel readPixels] minus n times [readPixels] ----
  // (synchronous: no game frame runs in between)
  H.syncCost = function (what, n) {
    n = n || 60;
    var r = H.renderer, gl = r.getContext(), px = new Uint8Array(4), st = F1.game.car.state;
    function sync() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    var fn = what === 'main' ? function () { H.realRender(H.scene, F1.game.camera); }
           : what === 'mirrors' ? function () { H.hm.render(st, 1 / 60); }
           : what === 'both' ? function () { H.realRender(H.scene, F1.game.camera); H.hm.render(st, 1 / 60); }
           : function () {};
    for (var w = 0; w < 10; w++) { fn(); sync(); }
    var t0 = performance.now();
    for (var i = 0; i < n; i++) sync();
    var base = (performance.now() - t0) / n;
    var t1 = performance.now();
    for (var j = 0; j < n; j++) { fn(); sync(); }
    var tot = (performance.now() - t1) / n;
    return { what: what, ms: +(tot - base).toFixed(3), sync: +base.toFixed(3) };
  };
  // GPU time through EXT_disjoint_timer_query_webgl2, when the browser offers it
  H.gpuTime = function (what, n) {
    var r = H.renderer, gl = r.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return Promise.resolve({ what: what, unavailable: true });
    var st = F1.game.car.state, qs = [];
    for (var i = 0; i < (n || 30); i++) {
      var q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      if (what === 'main') H.realRender(H.scene, F1.game.camera); else H.hm.render(st, 1 / 60);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
    }
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
