// F1Drive - two small HUD rear-view mirrors drawn on the screen itself (top-left / top-right), like the virtual
// mirrors of racing games. Not the cockpit's glass mirrors (js/cockpit.js): these are flat rectangles of the main
// canvas, framed by two DOM elements of the HUD.
//
//   var hm = F1.createHudMirrors(renderer, scene, {
//     exclude: [cockpit.group],          // never drawn in the mirrors (our own car); setExclude(list) to change it
//     elements: [frameLeft, frameRight]  // optional: each mirror fills the padding box of its element (the CSS owns the
//   });                                  //   layout); without them the built-in F1.hudMirrorsLayout(w, h) is used
//   // every frame while driving, right AFTER renderer.render(scene, camera):
//   hm.render(car.state, dt);            // = hm.update(car.state, dt); hm.render();
//
//   hm.update(pose, dt)    pose: {x, y, z, heading, pitch, roll} (car.state); dt in s (smooths the attitude a little)
//   hm.render()            draws both mirrors into the canvas (nothing while hidden, the context is lost, the frames
//                          are not laid out - e.g. the HUD is hidden behind the menu - or no pose was given)
//   hm.setVisible(on)      -> on. Hidden: no work at all, render targets released; with `elements` it also sets their
//                          style.display ('' / 'none'). hm.visible
//   hm.setRects(fn|null)   custom placement: fn(cssW, cssH) -> [[x, y, w, h] left, [x, y, w, h] right], CSS px of the
//                          canvas from its top-left corner (overrides `elements`); null = back to elements / built-in
//   hm.relayout()          measure the frames again now (also done on window resize, element resize, every 2 s)
//   hm.setExclude(list)    objects (and their subtrees) left out of the mirrors
//   hm.setOptions(o)       hfov, yaw, pitch (degrees), rate (1 | 2 | 'auto'), trees (bool), msaa (0 | 4); also as
//                          the third argument of createHudMirrors
//   hm.dispose()
//   hm.info()              -> {visible, lost, rate (in use), rateMode, passes, blits, ms (average CPU ms of render()),
//                              msMax, pixelRatio, rects, target, hfov, yaw, pitch, source}
//
// How: each mirror has its own small render target (the size of its glass in device pixels, capped), drawn by a camera
// that looks straight back from beside the driver's head, turned `yaw` degrees outwards; then both targets are copied
// into the canvas with setViewport / setScissor / setScissorTest, flipped left-right as a mirror does (the driver's
// left stays on the left of the image), with rounded corners and a slightly darker, glassy look. rate 1: both mirrors
// are re-rendered every frame; rate 2: one per frame, alternately (each one at half the frame rate), both still copied
// every frame; 'auto' (default): 1, switching to 2 while render() averages over 1 ms of CPU time. The scene's fog and sky come along (it is the same scene). Left out of the pass: the `exclude` list,
// and every scene child or grandchild with userData.mirror === false (the cars' name tags) - like the cockpit's glass.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};
  var DEG = Math.PI / 180;

  var DEF = {
    hfov: 40,             // deg: horizontal field of view of one mirror (a flat mirror at arm's length shows ~20-30 deg;
                          //   game mirrors are a little wider)
    yaw: 12,              // deg: each mirror looks this much outwards from straight back
    pitch: -1.5,          // deg: and a little downwards (the road behind starts ~10 m back)
    rate: 'auto',         // 1: both every frame; 2: alternately; 'auto': 1, and 2 while the mirrors cost too much
    trees: true,          // the scenery's instanced trees (about 90 % of its triangles) are drawn in the mirrors too
    msaa: 4               // samples of the targets (WebGL 2), 0 = none
  };
  // the cameras, car-local (x = driver's LEFT, y up, z forward): beside the helmet, a little above the eye (0.80 m)
  var CAM_X = 0.45, CAM_Y = 1.0, CAM_Z = -0.40;
  var NEAR = 0.5, FAR = 2600;           // far: the fog's end (main.js: Fog(SKY, 300, 2500)); objects beyond it are sky
  var MAX_W = 720;                      // device px: cap of a target's width (a 4K screen at DPR 2)
  var RADIUS = 7;                       // CSS px: corner radius of the glass (the frame's inner radius)
  var BLEED = 1;                        // CSS px: the glass reaches this far under its frame (no seam at any DPR)
  var MEASURE_EVERY = 2;                // s: the frames are measured again this often anyway (position-only changes)
  var SMOOTH = 0.06;                    // s: time constant of the pitch / roll filter (a narrow view magnifies jitter)
  // rate 'auto': the average CPU time of render() (both mirrors redrawn) above AUTO_SLOW ms for AUTO_N frames in a row
  // -> one mirror per frame; back to both when it stays under AUTO_FAST ms (one mirror) for 5 * AUTO_N frames
  var AUTO_SLOW = 1.0, AUTO_FAST = 0.35, AUTO_N = 90;

  // Built-in placement (CSS px of the canvas, from its top-left), used without `elements`: the glass of each mirror,
  // i.e. the INSIDE of its frame. It is the layout index.html's frames use (its .hud-mirror / --mir-* rules; layout A of
  // devtests/hudmirrors-test/layouts.css, there with a 224 px minimum):
  //   glass width  gw = clamp(176, 18.75 % of the width, 400), height gh = round(gw / 3) (176: the start lights still
  //                fit between the two from 721 to 1000 px)
  //   frame: 4 px border all round, outer box at top 12, left 18 / right 18; narrower than 444 px the glass shrinks
  F1.hudMirrorsLayout = function (w, h) {
    var gw = Math.round(Math.max(176, Math.min(400, w * 0.1875))), gh = Math.round(gw / 3), b = 4, top = 12, side = 18;
    if (w < 2 * (gw + 2 * b + side) + 40) {                // very narrow window: shrink to fit side by side
      gw = Math.max(60, Math.floor((w - 2 * side - 4 * b - 40) / 2)); gh = Math.round(gw / 3);
    }
    return [[side + b, top + b, gw, gh], [w - side - b - gw, top + b, gw, gh]];
  };

  var VERT = [
    'varying vec2 vUv;',
    'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');
  // the target flipped left-right; rounded corners (discarded: the frame covers them); a mirror gives back a little
  // less light than it gets, a touch more at the edges; a faint diagonal sheen
  var FRAG = [
    'uniform sampler2D tMap;',
    'uniform vec2 uSize;',          // glass size in device px
    'uniform float uRadius;',       // corner radius in device px
    'uniform float uEdge;',         // edge darkening width in device px
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 p = vUv * uSize;',
    '  vec2 q = abs(p - 0.5 * uSize) - (0.5 * uSize - uRadius);',
    '  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;',
    '  if (d > 0.0) discard;',
    '  vec3 c = texture2D(tMap, vec2(1.0 - vUv.x, vUv.y)).rgb;',
    '  float e = smoothstep(0.0, 1.0, clamp(-d / uEdge, 0.0, 1.0));',
    '  c *= 0.92 * mix(0.74, 1.0, e);',
    '  float s = vUv.x * 0.55 + vUv.y;',
    '  c += vec3(0.05) * smoothstep(0.80, 1.05, s) * (1.0 - smoothstep(1.05, 1.30, s));',
    '  gl_FragColor = vec4(c, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '}'
  ].join('\n');

  F1.createHudMirrors = function (renderer, scene, opts) {
    var THREE = root.THREE;
    opts = opts || {};
    var o = {
      hfov: num(opts.hfov, DEF.hfov), yaw: num(opts.yaw, DEF.yaw), pitch: num(opts.pitch, DEF.pitch),
      rate: rateOpt(opts.rate, DEF.rate), trees: opts.trees === undefined ? DEF.trees : !!opts.trees,
      msaa: opts.msaa === undefined ? DEF.msaa : (opts.msaa | 0)
    };
    var canvas = renderer.domElement;
    var gl = renderer.getContext();
    var webgl2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    var elements = opts.elements && opts.elements.length === 2 && opts.elements[0] && opts.elements[1] ? opts.elements.slice() : null;
    var rectFn = null;
    var exclude = (opts.exclude || []).slice();

    var visible = true, lost = false, disposed = false;
    var havePose = false, frameNo = 0, passes = 0, blits = 0, msAvg = 0, msMax = 0, lastDt = 0;
    var att = { pitch: 0, roll: 0, ok: false };
    // glass rects in CSS px of the renderer's drawing size, from the top-left: [x, y, w, h] or null (not laid out)
    var rects = [null, null], dirty = true, sinceMeasure = 0;
    var targets = [null, null], fresh = [false, false];
    var pr = 0, sizeW = 0, sizeH = 0;
    var tmpSize = new THREE.Vector2(), saveVp = new THREE.Vector4(), saveSc = new THREE.Vector4();

    // ---- cameras: on a rig that takes the car's pose ----
    var rig = new THREE.Object3D();
    rig.rotation.order = 'YXZ';
    var cams = [];
    for (var k = 0; k < 2; k++) {
      var cam = new THREE.PerspectiveCamera(20, 3, NEAR, FAR);
      cam.name = 'hud-mirror-camera';
      cam.rotation.order = 'YXZ';
      rig.add(cam);
      cams.push(cam);
    }
    placeCameras();

    // ---- the copy into the canvas ----
    var blitScene = new THREE.Scene();
    var blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quadGeo = new THREE.PlaneGeometry(2, 2);
    var mats = [makeMat(), makeMat()];
    var quad = new THREE.Mesh(quadGeo, mats[0]);
    quad.frustumCulled = false;
    blitScene.add(quad);

    function makeMat() {
      return new THREE.ShaderMaterial({
        uniforms: { tMap: { value: null }, uSize: { value: new THREE.Vector2(1, 1) }, uRadius: { value: RADIUS }, uEdge: { value: 12 } },
        vertexShader: VERT, fragmentShader: FRAG,
        depthTest: false, depthWrite: false, transparent: false, fog: false
      });
    }
    function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
    function rateOpt(v, d) { return v === 1 || v === 2 || v === 'auto' ? v : d; }
    var autoRate = 1, autoCount = 0;
    function effRate() { return o.rate === 'auto' ? autoRate : o.rate; }

    // left camera k = 0 at +x (the driver's left), right k = 1 at -x; a camera looks along its local -Z, i.e. straight
    // back on the rig; rotation.y = phi turns that to (-sin phi, 0, -cos phi): the left one (outwards = +x) needs -yaw
    function placeCameras() {
      for (var k = 0; k < 2; k++) {
        var side = k === 0 ? 1 : -1;
        cams[k].position.set(side * CAM_X, CAM_Y, CAM_Z);
        cams[k].rotation.set(o.pitch * DEG, -side * o.yaw * DEG, 0);
      }
    }

    // ---- layout ----
    function onResize() { dirty = true; }
    root.addEventListener && root.addEventListener('resize', onResize);
    var ro = null;
    function observe() {
      if (ro) { ro.disconnect(); ro = null; }
      if (elements && typeof root.ResizeObserver === 'function') {
        ro = new root.ResizeObserver(onResize);
        ro.observe(elements[0]); ro.observe(elements[1]);
      }
    }
    observe();

    function measure() {
      dirty = false; sinceMeasure = 0;
      renderer.getSize(tmpSize);
      sizeW = tmpSize.x; sizeH = tmpSize.y;
      pr = renderer.getPixelRatio();
      var r = null;
      if (rectFn) r = rectFn(sizeW, sizeH);
      else if (elements) r = [elRect(elements[0]), elRect(elements[1])];
      else r = F1.hudMirrorsLayout(sizeW, sizeH);
      for (var k = 0; k < 2; k++) {
        var q = r && r[k];
        rects[k] = q && q[2] >= 8 && q[3] >= 4 && q[0] < sizeW && q[1] < sizeH && q[0] + q[2] > 0 && q[1] + q[3] > 0 ? q.slice(0, 4) : null;
        if (rects[k]) fitTarget(k);
      }
    }
    // the padding box of a frame element (its glass), plus BLEED under the border, in renderer CSS px
    function elRect(el) {
      if (!el || !el.isConnected) return null;
      var b = el.getBoundingClientRect();
      if (!(b.width > 0 && b.height > 0)) return null;           // display: none (the HUD is hidden: menu)
      var c = canvas.getBoundingClientRect();
      if (!(c.width > 0 && c.height > 0)) return null;
      var sx = sizeW / c.width, sy = sizeH / c.height;
      var x = b.left + el.clientLeft - c.left - BLEED, y = b.top + el.clientTop - c.top - BLEED;
      return [x * sx, y * sy, (el.clientWidth + 2 * BLEED) * sx, (el.clientHeight + 2 * BLEED) * sy];
    }
    // the target of mirror k: its glass in device px (capped), and the camera's aspect
    function fitTarget(k) {
      var q = rects[k];
      var w = Math.max(16, Math.round(q[2] * pr)), h = Math.max(8, Math.round(q[3] * pr));
      if (w > MAX_W) { h = Math.max(8, Math.round(h * MAX_W / w)); w = MAX_W; }
      var t = targets[k];
      if (!t) {
        t = targets[k] = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false,
          samples: webgl2 && o.msaa > 0 ? o.msaa : 0 });
        t.texture.name = 'hud-mirror-' + (k === 0 ? 'left' : 'right');
        t.texture.generateMipmaps = false;
        t.texture.minFilter = THREE.LinearFilter;
        t.texture.magFilter = THREE.LinearFilter;
        fresh[k] = false;
      } else if (t.width !== w || t.height !== h) {
        t.setSize(w, h);
        fresh[k] = false;
      }
      var cam = cams[k], aspect = q[2] / q[3];
      cam.aspect = aspect;
      cam.fov = 2 * Math.atan(Math.tan(o.hfov * DEG / 2) / aspect) / DEG;
      cam.updateProjectionMatrix();
      var m = mats[k].uniforms;
      m.tMap.value = t.texture;
      m.uSize.value.set(q[2] * pr, q[3] * pr);
      m.uRadius.value = RADIUS * pr;
      m.uEdge.value = Math.max(4, Math.min(q[3] * 0.18, 14)) * pr;
    }
    function freeTargets() {
      for (var k = 0; k < 2; k++) {
        if (targets[k]) { targets[k].dispose(); targets[k] = null; }
        fresh[k] = false;
        mats[k].uniforms.tMap.value = null;
      }
      dirty = true;
    }

    // ---- context loss: nothing is drawn while it is lost; afterwards three.js re-creates the GPU objects on use and
    //      both targets are drawn again before they are shown ----
    function onLost() { lost = true; }
    function onRestored() { lost = false; fresh[0] = fresh[1] = false; dirty = true; }
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);

    // ---- per frame ----
    function update(pose, dt) {
      lastDt = dt > 0 ? Math.min(dt, 0.25) : 0;
      if (!pose || !isFinite(pose.x) || !isFinite(pose.z) || !isFinite(pose.heading)) { havePose = false; return; }
      var p = pose.pitch || 0, r = pose.roll || 0;
      if (att.ok && dt > 0) {
        var a = 1 - Math.exp(-dt / SMOOTH);
        att.pitch += (p - att.pitch) * a; att.roll += (r - att.roll) * a;
      } else { att.pitch = p; att.roll = r; att.ok = true; }
      rig.position.set(pose.x, pose.y || 0, pose.z);
      rig.rotation.set(-att.pitch, pose.heading, att.roll);    // as js/cockpit.js poses the car (local +x = left)
      havePose = true;
    }

    var hidden = [], hiddenWas = [], TREES = /^scenery-trees/;
    function skip(obj) { return obj.userData.mirror === false || (!o.trees && TREES.test(obj.name)); }
    function hideOwn() {
      hidden.length = 0;
      var i, j, x, c, kids = scene.children;
      for (i = 0; i < exclude.length; i++) if (exclude[i] && exclude[i].visible) hidden.push(exclude[i]);
      for (i = 0; i < kids.length; i++) {
        x = kids[i];
        if (!x.visible) continue;
        if (skip(x)) { hidden.push(x); continue; }
        for (j = 0; j < x.children.length; j++) {
          c = x.children[j];
          if (c.visible && skip(c)) hidden.push(c);
        }
      }
      for (i = 0; i < hidden.length; i++) { hiddenWas[i] = hidden[i].visible; hidden[i].visible = false; }
    }
    function showOwn() {
      for (var i = 0; i < hidden.length; i++) hidden[i].visible = hiddenWas[i];
      hidden.length = 0;
    }

    function render(pose, dt) {
      if (pose !== undefined) update(pose, dt);
      if (!visible || disposed || !havePose) return;
      if (lost || (gl.isContextLost && gl.isContextLost())) return;
      var t0 = root.performance ? root.performance.now() : 0;
      frameNo++;
      // layout: renderer size / pixel ratio changed, a resize, or time for the periodic check
      renderer.getSize(tmpSize);
      sinceMeasure += lastDt > 0 ? lastDt : 1 / 60;
      if (dirty || tmpSize.x !== sizeW || tmpSize.y !== sizeH || renderer.getPixelRatio() !== pr ||
          (elements && !rectFn && sinceMeasure > MEASURE_EVERY)) measure();
      if (!rects[0] && !rects[1]) return;

      // which targets to draw now: both (rate 1, or one has nothing in it yet), else this frame's one
      var draw0 = !!rects[0], draw1 = !!rects[1];
      var rate = effRate();
      if (rate === 2 && fresh[0] && fresh[1]) { if (frameNo & 1) draw0 = false; else draw1 = false; }

      var autoClear = renderer.autoClear, autoReset = renderer.info.autoReset, target = renderer.getRenderTarget();
      var scTest = renderer.getScissorTest();
      renderer.getViewport(saveVp); renderer.getScissor(saveSc);
      renderer.info.autoReset = false;               // the frame's statistics count the mirrors too
      rig.updateMatrixWorld(true);
      try {
        if (draw0 || draw1) {
          hideOwn();
          try {
            renderer.autoClear = true;
            for (var k = 0; k < 2; k++) {
              if (!(k === 0 ? draw0 : draw1)) continue;
              renderer.setRenderTarget(targets[k]);
              renderer.render(scene, cams[k]);
              fresh[k] = true;
              passes++;
            }
          } finally {
            renderer.setRenderTarget(target);
            showOwn();
          }
        }
        // copy into the canvas
        renderer.autoClear = false;
        renderer.setScissorTest(true);
        for (var m = 0; m < 2; m++) {
          var q = rects[m];
          if (!q || !fresh[m]) continue;
          var y = sizeH - q[1] - q[3];               // GL: from the bottom
          renderer.setViewport(q[0], y, q[2], q[3]);
          renderer.setScissor(q[0], y, q[2], q[3]);
          quad.material = mats[m];
          renderer.render(blitScene, blitCam);
          blits++;
        }
      } finally {
        renderer.setViewport(saveVp); renderer.setScissor(saveSc); renderer.setScissorTest(scTest);
        renderer.autoClear = autoClear;
        renderer.info.autoReset = autoReset;
      }
      if (root.performance) {
        var ms = root.performance.now() - t0;
        msAvg = msAvg ? msAvg + (ms - msAvg) * 0.05 : ms;
        if (ms > msMax) msMax = ms;
        if (o.rate === 'auto') {
          if (rate === 1) {
            autoCount = msAvg > AUTO_SLOW ? autoCount + 1 : 0;
            if (autoCount >= AUTO_N) { autoRate = 2; autoCount = 0; }
          } else {
            autoCount = msAvg < AUTO_FAST ? autoCount + 1 : 0;
            if (autoCount >= 5 * AUTO_N) { autoRate = 1; autoCount = 0; }
          }
        }
      }
    }

    function setVisible(on) {
      on = on !== false && on !== 0;
      if (on === visible) return visible;
      visible = on;
      if (elements) for (var k = 0; k < 2; k++) elements[k].style.display = on ? '' : 'none';
      if (!on) freeTargets();
      else { dirty = true; att.ok = false; }
      return visible;
    }

    function setRects(fn) { rectFn = typeof fn === 'function' ? fn : null; dirty = true; }
    function relayout() { dirty = true; if (visible && !disposed) measure(); return rects.slice(); }
    function setExclude(list) { exclude = (list || []).slice(); }
    function setOptions(x) {
      x = x || {};
      if (x.hfov !== undefined) o.hfov = num(x.hfov, o.hfov);
      if (x.yaw !== undefined) o.yaw = num(x.yaw, o.yaw);
      if (x.pitch !== undefined) o.pitch = num(x.pitch, o.pitch);
      if (x.rate !== undefined) { o.rate = rateOpt(x.rate, o.rate); autoRate = 1; autoCount = 0; }
      if (x.trees !== undefined) o.trees = !!x.trees;
      if (x.msaa !== undefined && (x.msaa | 0) !== o.msaa) { o.msaa = x.msaa | 0; freeTargets(); }
      placeCameras();
      dirty = true;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      freeTargets();
      quadGeo.dispose(); mats[0].dispose(); mats[1].dispose();
      if (ro) { ro.disconnect(); ro = null; }
      root.removeEventListener && root.removeEventListener('resize', onResize);
      canvas.removeEventListener('webglcontextlost', onLost, false);
      canvas.removeEventListener('webglcontextrestored', onRestored, false);
      exclude = []; elements = null;
    }

    function info() {
      return { visible: visible, lost: lost, rate: effRate(), rateMode: o.rate, trees: o.trees, msaa: webgl2 ? o.msaa : 0, passes: passes, blits: blits,
               ms: +msAvg.toFixed(3), msMax: +msMax.toFixed(3), pixelRatio: pr,
               rects: [rects[0] && rects[0].map(round1), rects[1] && rects[1].map(round1)],
               target: [targets[0] ? [targets[0].width, targets[0].height] : null, targets[1] ? [targets[1].width, targets[1].height] : null],
               hfov: o.hfov, yaw: o.yaw, pitch: o.pitch, source: rectFn ? 'fn' : (elements ? 'elements' : 'built-in') };
    }
    function round1(v) { return Math.round(v * 10) / 10; }

    var api = {
      update: update, render: render, setVisible: setVisible, setRects: setRects, relayout: relayout,
      setExclude: setExclude, setOptions: setOptions, dispose: dispose, info: info,
      cameras: cams
    };
    Object.defineProperty(api, 'visible', { get: function () { return visible; }, enumerable: true });
    return api;
  };
})(typeof window !== 'undefined' ? window : this);
