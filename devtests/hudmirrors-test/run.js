// HUD rear-view mirrors (js/hudmirrors.js) in the REAL game: index.html in an offscreen, MUTED Electron window
// (devtests/electron-userdata.js), the module patched in from the page (page.js: renderer taken from the scene,
// renderer.render wrapped so hm.render(car.state, dt) runs right after main.js's main render). Nothing in the project
// is edited. Screenshots in ./out, results on stdout and in out/results.json.
//   npx electron devtests/hudmirrors-test/run.js            env TRACK (default it-1922 = Monza), ONLY=layouts|cost|robust
'use strict';
const path = require('path'), fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'hudmirrors');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const MODULE = fs.readFileSync(path.join(ROOT, 'js', 'hudmirrors.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, 'layouts.css'), 'utf8');
const TRACK = process.env.TRACK || 'it-1922';
const ONLY = process.env.ONLY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const results = { checks: [], cost: [], layouts: {}, gpu: null };
function check(name, ok, detail) {
  results.checks.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
  return !!ok;
}

function makeWin(W, H) {
  const w = new BrowserWindow({
    width: W, height: H, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(ROOT, 'preload.js'), partition: 'hm-' + Date.now() }
  });
  w.webContents.setFrameRate(60);
  w.errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    w.errors.push(msg);
    console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('renderer gone: ' + d.reason); console.log('renderer gone', d.reason); });
  w.js = code => w.webContents.executeJavaScript(code);
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(50); }
    console.log('TIMEOUT ' + (what || code));
    return false;
  };
  w.shot = async name => {
    await sleep(200);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('shot ' + name + '.png ' + J(img.getSize()));
    return img;
  };
  w.size = async (W2, H2) => { w.setContentSize(W2, H2); await sleep(700); return w.js('[innerWidth, innerHeight, devicePixelRatio]'); };
  w.key = async (code, holdMs) => {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: code });
    await sleep(holdMs || 60);
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: code });
    await sleep(120);
  };
  return w;
}

// colour blobs of the test cars inside the two glasses of a capture: count + mean x (0 = left edge of the glass)
// (without: a second capture; a pixel counts only when it is NOT of that colour there - the car that was removed)
function blobs(img, rects, scale, without) {
  const sz = img.getSize(), bmp = img.toBitmap(), s = scale || sz.width / rects.cssW;
  const ref = without ? without.toBitmap() : null;
  const kind = (r, g, b) => (r > 110 && b > 110 && g < 0.55 * Math.min(r, b)) ? 'M'
    : (g > 110 && b > 110 && r < 0.55 * Math.min(g, b)) ? 'C' : (r > 110 && g > 110 && b < 0.5 * Math.min(r, g)) ? 'Y' : null;
  const out = [];
  for (let k = 0; k < 2; k++) {
    const q = rects.r[k], res = { M: { n: 0, x: 0 }, C: { n: 0, x: 0 }, Y: { n: 0, x: 0 } };
    if (!q) { out.push(null); continue; }
    const x0 = Math.ceil((q[0] + 4) * s), x1 = Math.floor((q[0] + q[2] - 4) * s), y0 = Math.ceil((q[1] + 4) * s), y1 = Math.floor((q[1] + q[3] - 4) * s);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * sz.width + x) * 4, c = kind(bmp[i + 2], bmp[i + 1], bmp[i]);
      if (c && ref && kind(ref[i + 2], ref[i + 1], ref[i]) === c) continue;
      if (c) { res[c].n++; res[c].x += (x - x0) / (x1 - x0); }
    }
    for (const c of ['M', 'C', 'Y']) res[c].x = res[c].n ? +(res[c].x / res[c].n).toFixed(3) : null;
    out.push(res);
  }
  return out;
}

async function rectsOf(w) {
  return w.js(`({ r: __hm.hm.info().rects, cssW: innerWidth, dpr: devicePixelRatio, info: __hm.hm.info(),
    frames: __hm.frames.map(function (f) { var b = f.getBoundingClientRect(); return [b.left, b.top, b.width, b.height, f.clientLeft, f.clientWidth, f.clientHeight]; }) })`);
}

async function boot(w) {
  for (let k = 0; k < 4; k++) {
    try { await w.loadFile(path.join(ROOT, 'index.html')); break; } catch (e) { console.log('load retry ' + k + ': ' + e.message); await sleep(500); }
  }
  await sleep(1000);
  const overlay = await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  if (overlay) { check('game boots without the error overlay', false, overlay.slice(0, 400)); return false; }
  console.log('page: ' + await w.js(PAGE));
  await w.js(MODULE + '\n;typeof F1.createHudMirrors');
  await w.webContents.insertCSS(CSS);
  return true;
}

async function pickTrack(w, id) {
  const ok = await w.js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; });
    var c = document.querySelector('#track-grid .card[data-i="' + i + '"]'); if (!c) return false; c.click(); return true; })()`);
  if (!ok) return false;
  return w.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, 30000, 'track ' + id);
}

async function frameCost(w, label, seconds) {
  await w.js(`__hm.frameStats(), true`);
  const p0 = await w.js(`__hm.hm.info().passes`);
  await sleep((seconds || 3) * 1000);
  const f = await w.js(`__hm.frameStats()`);
  const inf = await w.js(`__hm.hm.info()`);
  return { label, frame: f, mirrorsMs: inf.ms, passes: inf.passes - p0 };
}

async function main() {
  await app.whenReady();
  try {
    const g = await app.getGPUInfo('basic');
    results.gpu = (g.gpuDevice || []).filter(d => d.active).map(d => ({ vendor: d.vendorId, device: d.deviceId, driver: d.driverVersion }));
    console.log('GPU ' + J(results.gpu) + ' ' + J((g.auxAttributes || {}).glRenderer || ''));
  } catch (e) { console.log('gpu info: ' + e.message); }

  const w = makeWin(1280, 720);
  if (!await boot(w)) { finish(w); return; }
  const glr = await w.js(`(function () { try { var c = document.createElement('canvas').getContext('webgl2'); var e = c.getExtension('WEBGL_debug_renderer_info');
    return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER); } catch (e) { return String(e); } })()`);
  console.log('WebGL renderer: ' + glr);
  results.glRenderer = glr;

  // ---------- 1. no track loaded: the scene is only lights + sky ----------
  await w.js(`__hm.hookAny()`);
  await w.size(1282, 720); await w.size(1280, 720);           // main.js onResize renders the still frame behind the menu
  const hooked = await w.until(`__hm.renderer`, 5000, 'renderer captured from the menu still');
  check('renderer captured before any track (menu still)', hooked);
  if (hooked) {
    const r1 = await w.js(`(function () {
      var hm = F1.createHudMirrors(__hm.renderer, __hm.scene, {});      // built-in layout, nothing excluded
      hm.render(null, 0.016); var a = hm.info().passes;
      hm.render({ x: 0, y: 0, z: 0, heading: 0 }, 0.016); var b = hm.info();
      hm.render({ x: NaN, z: 0, heading: 0 }, 0.016); var c = hm.info().passes;
      hm.dispose(); hm.render({ x: 0, z: 0, heading: 0 }, 0.016);
      return { nullPose: a, sky: b.passes, blits: b.blits, nan: c, rects: b.rects, target: b.target, errs: __hm.errs.length };
    })()`);
    check('no track: null pose draws nothing, a pose draws both mirrors (sky), NaN pose nothing, after dispose nothing',
      r1.nullPose === 0 && r1.sky === 2 && r1.blits === 2 && r1.nan === 2 && r1.errs === 0, r1);
    check('built-in layout at 1280x720 = glass 240x80 at (22,16) and (1018,16)',
      J(r1.rects) === J([[22, 16, 240, 80], [1018, 16, 240, 80]]), r1.rects);
  }

  // ---------- 2. a track ----------
  check('track ' + TRACK + ' loads and runs', await pickTrack(w, TRACK));
  await sleep(800);
  console.log('create: ' + J(await w.js(`__hm.create({}), __hm.layout('a'), __hm.hm.info()`)));
  await w.js(`__hm.addCars()`);
  await sleep(1200);
  let info = await w.js(`__hm.hm.info()`);
  check('mirrors render every frame after the main render (rate 1: 2 passes + 2 copies per frame)', info.passes > 40 && info.blits > 40, info);

  // left / right: magenta car behind-left, cyan behind-right, yellow straight behind
  let R = await rectsOf(w);
  console.log('rects ' + J(R));
  let img = await w.shot('a-1280-free');
  let B = blobs(img, R);
  console.log('blobs ' + J(B));
  check('left mirror shows the car behind-LEFT on its outer (left) side, not the one behind-right',
    B[0] && B[0].M.n > 30 && B[0].M.x < 0.5 && B[0].C.n === 0, B[0]);
  check('right mirror shows the car behind-RIGHT on its outer (right) side, not the one behind-left',
    B[1] && B[1].C.n > 30 && B[1].C.x > 0.5 && B[1].M.n === 0, B[1]);
  // the yellow car: the trackside boards are yellow too, so only pixels that stop being yellow without it count
  await w.js(`__hm.cars[2].m.group.visible = false, true`);
  await sleep(300);
  const imgNoY = await w.shot('a-1280-free-noY');
  await w.js(`__hm.cars[2].m.group.visible = true, true`);
  const BY = blobs(img, R, null, imgNoY);
  check('the car straight behind is on the inner side of both mirrors (left mirror: right part, right mirror: left part)',
    BY[0] && BY[1] && BY[0].Y.n > 20 && BY[1].Y.n > 20 && BY[0].Y.x > 0.5 && BY[1].Y.x < 0.5, [BY[0] && BY[0].Y, BY[1] && BY[1].Y]);
  // negative control: hidden mirrors -> no test-car colours in those rects
  await w.js(`__hm.hm.setVisible(false), true`);
  await sleep(300);
  const p0 = await w.js(`__hm.hm.info().passes`);
  img = await w.shot('a-1280-hidden');
  const B0 = blobs(img, R);
  await sleep(600);
  const p1 = await w.js(`__hm.hm.info()`);
  check('setVisible(false): no passes, targets released, frames display:none, no test-car colours there',
    p1.passes === p0 && !p1.target[0] && !p1.target[1] && B0[0].M.n + B0[1].C.n === 0 &&
    await w.js(`__hm.frames.every(function (f) { return f.style.display === 'none'; })`), { p0, p1: p1.passes, target: p1.target, B0 });
  await w.js(`__hm.hm.setVisible(true), true`);
  await sleep(500);

  // own car: what the mirrors would show without excluding the cockpit
  await w.js(`__hm.hm.setExclude([]), true`);
  await sleep(300);
  await w.shot('a-1280-cockpit-not-excluded');
  await w.js(`__hm.hm.setExclude([F1.game.cockpit.group]), true`);
  // name tags: hidden from the mirrors by userData.mirror === false (tags of the test cars are on: eye within range)
  const tags = await w.js(`__hm.cars.map(function (c) { var t = null; c.m.group.traverse(function (o) { if (o.isSprite) t = o; }); return t ? [t.visible, t.userData.mirror] : null; })`);
  check('test cars carry visible name tags flagged userData.mirror === false', tags.every(t => t && t[0] === true && t[1] === false), tags);

  if (!ONLY || ONLY === 'layouts') await layouts(w);
  if (!ONLY || ONLY === 'cost') await cost(w);
  if (!ONLY || ONLY === 'robust') await robust(w);

  // main.js keeps running; its own render still works; no errors
  check('no page errors / console errors', (await w.js(`__hm.errs.length`)) === 0 && w.errors.length === 0, (await w.js(`__hm.errs`)).concat(w.errors).slice(0, 6));
  finish(w);
}

// ---------- layouts A / B / C with the busiest HUD (Grand Prix session box, start lights, a toast) ----------
async function layouts(w) {
  // offline Grand Prix: qualifying -> the session box shows; the lights are forced on and a toast is up
  const gpOk = await w.js(`(function () { var g = F1.game.gp; return g.start({ q: 2, r: 5, wear: 1 }, F1.game.track.length); })()`);
  await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 5000, 'quali');
  await w.js(`(function () { var real = F1.ui.setLights; F1.ui.setLights = function () { return real.call(F1.ui, 3, false, false); }; return true; })()`);
  await sleep(500);
  await w.js(`__hm.placeCars(), true`);
  console.log('gp start ' + gpOk);
  for (const [W, H] of [[1280, 720], [1920, 1080]]) {
    console.log('size ' + J(await w.size(W, H)));
    for (const L of ['a', 'b', 'c']) {
      await w.js(`__hm.layout(${J(L)}), F1.ui.toast('排位賽：完成 2 圈計時圈', 60000), true`);
      await sleep(600);
      const R = await rectsOf(w);
      const boxes = await w.js(`(function () { var o = {}; ['hud-timing', 'hud-gp', 'hud-players', 'hud-map', 'hud-lights', 'hud-toast', 'hud-telemetry', 'hud-hint', 'hud-mirror-l', 'hud-mirror-r'].forEach(function (id) {
        var e = document.getElementById(id); if (!e) return; var b = e.getBoundingClientRect(); if (!(b.width > 0)) return;
        o[id] = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }); return o; })()`);
      // overlaps between any two of these boxes (the bare HUD has none)
      const over = [], ids = Object.keys(boxes);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = boxes[ids[i]], b = boxes[ids[j]];
        if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) over.push(ids[i] + ' x ' + ids[j]);
      }
      if (L === 'a') check('layout a ' + W + ': no HUD box overlaps another', over.length === 0, over);
      results.layouts[L + '-' + W] = { glass: R.r, boxes, overlaps: over, target: R.info.target };
      console.log('layout ' + L + ' ' + W + 'x' + H + ' overlaps ' + J(over) + ' glass ' + J(R.r));
      const img = await w.shot('layout-' + L + '-' + W);
      const B = blobs(img, R);
      check('layout ' + L + ' ' + W + ': glass inside its frame (module rect = frame padding box + 1 px)',
        R.frames.every((f, k) => R.r[k] && Math.abs(R.r[k][0] - (f[0] + f[4] - 1)) < 0.6 && Math.abs(R.r[k][2] - (f[5] + 2)) < 0.6), { glass: R.r, frames: R.frames });
      check('layout ' + L + ' ' + W + ': both mirrors draw the test cars', B[0] && B[1] && B[0].M.n > 20 && B[1].C.n > 20, B.map(b => b && [b.M.n, b.C.n, b.Y.n]));
    }
  }
  await w.js(`F1.ui.toast('', 1), __hm.layout('a'), true`);
  await w.size(1280, 720);
}

// ---------- cost at 1920x1080 ----------
async function cost(w) {
  await w.size(1920, 1080);
  await w.js(`__hm.layout('a'), true`);
  // driving: hold W, test cars follow
  await w.js(`__hm.follow = true`);
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(2500);
  await w.shot('drive-1920');
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  const configs = [
    { name: 'rate1 msaa4 trees', o: { rate: 1, msaa: 4, trees: true } },
    { name: 'rate2 msaa4 trees', o: { rate: 2, msaa: 4, trees: true } },
    { name: 'rate1 msaa0 trees', o: { rate: 1, msaa: 0, trees: true } },
    { name: 'rate1 msaa4 no-trees', o: { rate: 1, msaa: 4, trees: false } },
    { name: 'rate2 msaa4 no-trees', o: { rate: 2, msaa: 4, trees: false } }
  ];
  // baseline: mirrors hidden
  await w.js(`__hm.hm.setVisible(false), true`);
  await sleep(500);
  const base = await frameCost(w, 'mirrors hidden', 3);
  base.syncMain = await w.js(`__hm.syncCost('main', 40)`);
  base.gpuMain = await w.js(`__hm.gpuTime('main', 30)`);
  results.cost.push(base);
  console.log('COST ' + J(base));
  await w.js(`__hm.hm.setVisible(true), true`);
  for (const c of configs) {
    await w.js(`__hm.hm.setOptions(${J(c.o)}), true`);
    await sleep(600);
    const r = await frameCost(w, c.name, 3);
    r.sync = await w.js(`__hm.syncCost('mirrors', 60)`);
    r.gpu = await w.js(`__hm.gpuTime('mirrors', 30)`);
    r.info = await w.js(`__hm.hm.info()`);
    results.cost.push(r);
    console.log('COST ' + J(r));
  }
  await w.js(`__hm.hm.setOptions({ rate: 'auto', msaa: 4, trees: true }), true`);   // back to the defaults
  await sleep(300);
  await w.shot('drive-1920-after');
  await w.js(`__hm.follow = false`);
}

// ---------- resize, DPR, menu, context loss ----------
async function robust(w) {
  console.log('size ' + J(await w.size(1600, 900)));
  await sleep(400);
  let R = await rectsOf(w);
  check('resize 1600x900: glass follows the frames (300x100)', R.r[0] && Math.abs(R.r[0][2] - 302) < 1 && Math.abs(R.r[0][3] - 102) < 1, R.r);
  // another device pixel ratio (zoom 1.5 x the system's): main.js's onResize sets the renderer's pixel ratio (max 2)
  const dpr0 = await w.js('devicePixelRatio');
  w.webContents.setZoomFactor(1.5);
  await sleep(900);
  R = await rectsOf(w);
  console.log('zoomed ' + J(R));
  const prWant = Math.min(R.dpr, 2);
  check('DPR ' + dpr0 + ' -> ' + R.dpr + ': renderer pixel ratio picked up, targets in device px, glass follows the frames',
    R.dpr !== dpr0 && R.info.pixelRatio === prWant && R.info.target[0] && Math.abs(R.info.target[0][0] - Math.min(720, Math.round(R.r[0][2] * prWant))) <= 1 &&
    R.frames.every((f, k) => R.r[k] && Math.abs(R.r[k][2] - (f[5] + 2)) < 0.6), { dpr0, dpr: R.dpr, pr: R.info.pixelRatio, target: R.info.target, glass: R.r, frames: R.frames });
  await w.shot('zoom15-1600');
  w.webContents.setZoomFactor(1);
  await sleep(800);
  // menu open: the loop stops (no call); a stray call does nothing either (the frames are hidden with #hud)
  const before = await w.js(`__hm.hm.info().passes`);
  await w.key('Escape');
  await w.until(`!F1.game.running`, 3000, 'menu');
  await sleep(400);
  const stray = await w.js(`(function () { var a = __hm.hm.info().passes; __hm.hm.render(F1.game.car.state, 0.016); __hm.hm.relayout(); __hm.hm.render(F1.game.car.state, 0.016); return [a, __hm.hm.info().passes, __hm.hm.info().rects]; })()`);
  check('menu open: no mirror passes (loop stopped; a direct call finds the frames hidden)', stray[0] === stray[1] && stray[2][0] === null, { before, stray });
  await w.shot('menu-open');
  await w.key('Escape');
  await w.until(`F1.game.running`, 3000, 'resume');
  await sleep(800);
  const after = await w.js(`__hm.hm.info()`);
  check('resume: mirrors back', after.passes > stray[1] && after.rects[0], after);
  // rate 'auto': a slow machine (each mirror pass made 0.9 ms slower) -> one mirror per frame; fast again -> both
  check('rate auto by default, both mirrors every frame on this machine', after.rateMode === 'auto' && after.rate === 1, after);
  await w.js(`(function () { var m = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial()); m.frustumCulled = false;
    m.onBeforeRender = function (r, s, c) { if (c.name === 'hud-mirror-camera') { var t = performance.now(); while (performance.now() - t < 0.9) {} } };
    __hm.scene.add(m); __hm.slow = m; return true; })()`);
  const slowOk = await w.until(`__hm.hm.info().rate === 2`, 6000, 'auto -> rate 2');
  const slowInfo = await w.js(`__hm.hm.info()`);
  await w.js(`__hm.scene.remove(__hm.slow), true`);
  const fastOk = await w.until(`__hm.hm.info().rate === 1`, 15000, 'auto -> rate 1');
  check('rate auto: slow mirrors -> alternate (rate 2), fast again -> both (rate 1)', slowOk && fastOk, { slow: slowInfo.ms, back: (await w.js(`__hm.hm.info()`)).ms });
  // WebGL context loss and restore
  const lost = await w.js(`(function () { var gl = __hm.renderer.getContext(); __hm.loseExt = gl.getExtension('WEBGL_lose_context'); if (!__hm.loseExt) return 'no-ext'; __hm.loseExt.loseContext(); return 'lost'; })()`);
  await sleep(700);
  const during = await w.js(`[__hm.hm.info().lost, __hm.hm.info().passes]`);
  await sleep(300);
  const during2 = await w.js(`__hm.hm.info().passes`);
  check('context lost: module notices, no passes', lost === 'lost' && during[0] === true && during2 === during[1], { lost, during, during2 });
  await w.js(`__hm.loseExt.restoreContext(), true`);
  await sleep(1500);
  const rest = await w.js(`__hm.hm.info()`);
  check('context restored: mirrors render again', rest.lost === false && rest.passes > during2, rest);
  await w.shot('context-restored');
}

function finish(w) {
  const failed = results.checks.filter(c => !c.ok).length;
  results.summary = { checks: results.checks.length, failed };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASS') + ' (' + results.checks.length + ' checks)');
  try { w.destroy(); } catch (e) {}
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
}

main().catch(e => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
