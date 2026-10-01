// HUD rear-view mirrors (js/hudmirrors.js) in the REAL game: index.html in an offscreen, MUTED Electron window
// (devtests/electron-userdata.js). Since v6.1 the game draws them itself (js/main.js: created once with the cockpit,
// exclude [cockpit.group], the frames #hud-mirror-l / -r of index.html, hm.render(car.state, dt) right after the main
// render; key V and the 後照鏡 switch of 設定, remembered). page.js (injected) only looks: the renderer for a separate
// instance (the no-track checks) and the cost loops, test cars behind ours, frame timing. Nothing in the project is
// edited. Screenshots in ./out (READ them), results on stdout and in out/results.json. Exit code 1 on a failed check.
// The last part (a second window: the setting stored off) also breaks the game's mirror pass on purpose: main.js must
// switch the mirrors off for good (設定: 無法顯示) and keep the game running.
//   npx electron devtests/hudmirrors-test/run.js            env TRACK (default it-1922 = Monza), ONLY=layouts|cost|robust
'use strict';
const path = require('path'), fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'hudmirrors');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PAGE = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
const MOCK = require(path.join(ROOT, 'devtests', 'ui-v6', 'mock'));          // a 16-driver results view
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
  // a real mouse click in the middle of an element (CSS selector or id), scrolled into view first
  w.click = async sel => {
    const r = await w.js(`(function () { var e = document.getElementById(${J(sel)}) || document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, hit: !!top && (top === e || e.contains(top)) }; })()`);
    if (!r || !(r.w > 0) || !r.hit) { console.log('click: ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
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

// every box of the HUD on screen, and which of them overlap (the HUD as laid out has none)
const BOXES = ['hud-mirror-l', 'hud-mirror-r', 'hud-timing', 'hud-gp', 'hud-players', 'hud-map', 'hud-lights', 'hud-toast', 'hud-telemetry', 'hud-hint', 'gp-results', 'hud-pit'];
async function boxesOf(w) {
  const boxes = await w.js(`(function () { var o = {}; ${J(BOXES)}.forEach(function (id) {
    var e = document.getElementById(id); if (!e) return; var b = e.getBoundingClientRect(); if (!(b.width > 0)) return;
    o[id] = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }); return o; })()`);
  const over = [], ids = Object.keys(boxes);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = boxes[ids[i]], b = boxes[ids[j]];
    if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) over.push(ids[i] + ' x ' + ids[j]);
  }
  return { boxes, over, mirOver: over.filter(o => /hud-mirror/.test(o)) };
}

async function boot(w) {
  for (let k = 0; k < 4; k++) {
    try { await w.loadFile(path.join(ROOT, 'index.html')); break; } catch (e) { console.log('load retry ' + k + ': ' + e.message); await sleep(500); }
  }
  await sleep(1000);
  const overlay = await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  if (overlay) { check('game boots without the error overlay', false, overlay.slice(0, 400)); return false; }
  console.log('page: ' + await w.js(PAGE));
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

// the mirrors as the game has them now: setting, module, frames, layout class, where the timing box is
const mirState = w => w.js(`({ setting: F1.ui.getMirrors(), game: F1.game.mirrors, visible: F1.game.hudMirrors ? F1.game.hudMirrors.visible : null,
  target: F1.game.hudMirrors ? F1.game.hudMirrors.info().target : null, passes: F1.game.hudMirrors ? F1.game.hudMirrors.info().passes : null,
  frames: ['hud-mirror-l', 'hud-mirror-r'].map(function (id) { return document.getElementById(id).getBoundingClientRect().width > 0; }),
  noMirrors: document.getElementById('hud').classList.contains('no-mirrors'), stored: localStorage.getItem('f1drive.hud'),
  timingTop: Math.round(document.getElementById('hud-timing').getBoundingClientRect().top), mapTop: Math.round(document.getElementById('hud-map').getBoundingClientRect().top),
  box: document.getElementById('set-mirrors').checked, toast: document.getElementById('hud-toast').textContent })`);

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
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const order = []; html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => order.push(src));
  const hudOpen = html.indexOf('<div id="hud"'), frameAt = html.indexOf('id="hud-mirror-l"'), timingAt = html.indexOf('id="hud-timing"');
  check('index.html: js/hudmirrors.js loaded right after js/cockpit.js; the two frames are the first children of #hud',
    order.indexOf('js/hudmirrors.js') === order.indexOf('js/cockpit.js') + 1 && order.indexOf('js/hudmirrors.js') < order.indexOf('js/main.js') &&
    hudOpen > 0 && frameAt > hudOpen && frameAt < timingAt && html.indexOf('id="hud-mirror-r"') < timingAt, { order: order.slice(7, 11) });
  check('the module is the page\'s own (F1.createHudMirrors), the game has no mirrors before a track (they come with the cockpit), setting on by default',
    await w.js(`typeof F1.createHudMirrors === 'function' && F1.game.hudMirrors === null && F1.ui.getMirrors() === true && F1.game.mirrors === true`));

  // ---------- 1. no track loaded: the scene is only lights + sky (a separate instance of the module) ----------
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
      return { nullPose: a, sky: b.passes, blits: b.blits, nan: c, rects: b.rects, target: b.target, errs: __hm.errs.length,
        W: __hm.renderer.getSize(new THREE.Vector2()).x };
    })()`);
    check('no track: null pose draws nothing, a pose draws both mirrors (sky), NaN pose nothing, after dispose nothing',
      r1.nullPose === 0 && r1.sky === 2 && r1.blits === 2 && r1.nan === 2 && r1.errs === 0, r1);
    // (the window asked for 1280 x 720 may come out 1 px larger at some device pixel ratios: the right glass is placed from
    //  the right edge, 22 px in - 1018 at exactly 1280)
    check('built-in layout at 1280x720 = glass 240x80 at (22,16) and (W - 262,16) = (1018,16) at exactly 1280',
      Math.abs(r1.W - 1280) <= 1 && J(r1.rects) === J([[22, 16, 240, 80], [r1.W - 262, 16, 240, 80]]), { rects: r1.rects, W: r1.W });
  }

  // ---------- 2. a track: the game's own mirrors ----------
  check('track ' + TRACK + ' loads and runs', await pickTrack(w, TRACK));
  await sleep(800);
  const gi = await w.js(`__hm.game()`);
  console.log('game mirrors: ' + J(gi));
  check('the game created its mirrors with the cockpit: visible, laid out by the frames of index.html (source elements), glass 242x82 incl. the 1 px bleed at 1280',
    gi && gi.visible && gi.source === 'elements' && gi.rects[0] && Math.abs(gi.rects[0][2] - 242) < 1 && Math.abs(gi.rects[0][3] - 82) < 1 && gi.rects[1] && gi.rects[1][0] > 900, gi);
  await w.js(`__hm.addCars()`);
  await sleep(300);
  const c0 = await w.js(`({ p: __hm.hm.info().passes, b: __hm.hm.info().blits, m: __hm.mainRenders })`);
  await sleep(1200);
  const c1 = await w.js(`({ p: __hm.hm.info().passes, b: __hm.hm.info().blits, m: __hm.mainRenders, info: __hm.hm.info() })`);
  const frames = c1.m - c0.m;
  check('main.js draws the mirrors every frame right after its main render (rate 1: 2 passes + 2 copies per main render)', frames > 40 && c1.p - c0.p === 2 * frames && c1.b - c0.b === 2 * frames,
    { mainRenders: frames, passes: c1.p - c0.p, blits: c1.b - c0.b, rate: c1.info.rate });
  // our own car is left out (exclude [cockpit.group]): a cockpit mesh is never drawn by a mirror camera - unless the
  // exclusion is lifted (positive control: then it is)
  await w.js(`__hm.cockpitProbe()`); await sleep(500);
  const pr1 = await w.js(`__hm.cockpitProbeEnd()`);
  await w.js(`__hm.hm.setExclude([]); __hm.cockpitProbe(); true`); await sleep(500);
  const pr0 = await w.js(`__hm.cockpitProbeEnd()`);
  await w.js(`__hm.hm.setExclude([F1.game.cockpit.group]); true`);
  check('the cockpit (our own car) is left out of the mirror passes (main.js: exclude [cockpit.group]); with the exclusion lifted the same mesh is drawn by them',
    pr1 && pr1.main > 20 && pr1.seen === 0 && pr0 && pr0.seen > 20, { excluded: pr1, lifted: pr0 });

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
  // name tags: hidden from the mirrors by userData.mirror === false (tags of the test cars are on: eye within range)
  const tags = await w.js(`__hm.cars.map(function (c) { var t = null; c.m.group.traverse(function (o) { if (o.isSprite) t = o; }); return t ? [t.visible, t.userData.mirror] : null; })`);
  check('test cars carry visible name tags flagged userData.mirror === false', tags.every(t => t && t[0] === true && t[1] === false), tags);

  // ---------- 3. the V key and the 後照鏡 switch of 設定 ----------
  await w.key('V');
  await sleep(500);
  const v1 = await mirState(w);
  B = blobs(await w.shot('a-1280-off-V'), R);
  await sleep(500);
  const v1b = await mirState(w);
  check('V: mirrors off - no passes, targets released, frames hidden, #hud.no-mirrors (timing box / minimap back at 18 px), remembered, toast 後照鏡：關（V）, no test-car colours there',
    v1.setting === false && v1.game === false && v1.visible === false && !v1.target[0] && !v1.target[1] && v1.frames.every(f => !f) && v1.noMirrors && v1.timingTop === 18 && v1.mapTop === 18 &&
    v1.stored === '{"mirrors":false}' && /後照鏡：關（V）/.test(v1.toast) && v1b.passes === v1.passes && B[0].M.n + B[1].C.n === 0, { v1, passesLater: v1b.passes, B });
  await w.key('V');
  await sleep(600);
  const v2 = await mirState(w);
  await sleep(300);
  const v2b = await mirState(w);
  check('V again: mirrors back (drawing, frames shown, boxes under them again, remembered, toast 後照鏡：開（V）)', v2.setting === true && v2.visible === true && v2.frames.every(Boolean) && !v2.noMirrors &&
    v2.timingTop === 110 && v2.stored === '{"mirrors":true}' && /後照鏡：開（V）/.test(v2.toast) && v2b.passes > v2.passes, { v2, passesLater: v2b.passes });
  await w.key('Escape');
  await w.until(`!F1.game.running`, 3000, 'menu');
  await w.click('#tab-set');
  const sw = await w.click('#set-mirrors');
  await sleep(200);
  const s1 = await mirState(w);
  await w.shot('a-1280-settings-mirrors-off');
  await w.key('Escape');
  await w.until(`F1.game.running`, 3000, 'resume');
  await sleep(500);
  const s1b = await mirState(w);
  check('設定 → 後照鏡 switch (real mouse click) off: the game hides them (no passes while driving), remembered', sw && s1.setting === false && s1.game === false && !s1.box && s1.visible === false &&
    s1b.frames.every(f => !f) && s1b.noMirrors && s1b.passes === s1.passes && s1.stored === '{"mirrors":false}', { s1, s1b });
  await w.key('Escape');
  await w.until(`!F1.game.running`, 3000, 'menu');
  await w.click('#set-mirrors');
  await w.key('Escape');
  await w.until(`F1.game.running`, 3000, 'resume');
  await sleep(500);
  const s2 = await mirState(w);
  check('設定 → 後照鏡 switch on again: drawn again', s2.setting === true && s2.visible === true && s2.frames.every(Boolean) && !s2.noMirrors && s2.box, s2);

  if (!ONLY || ONLY === 'layouts') await layouts(w);
  if (!ONLY || ONLY === 'cost') await cost(w);
  if (!ONLY || ONLY === 'robust') await robust(w);

  // main.js keeps running; its own render still works; no errors
  check('no page errors / console errors', (await w.js(`__hm.errs.length`)) === 0 && w.errors.length === 0, (await w.js(`__hm.errs`)).concat(w.errors).slice(0, 6));
  try { w.destroy(); } catch (e) {}
  // ---------- 4. the setting remembered: a new start with the mirrors off ----------
  if (!ONLY || ONLY === 'robust') await restart();
  finish();
}

// ---------- index.html's layout (A: the mirrors in the top corners, the corner boxes under them) with the busiest HUD:
// Grand Prix session box, start lights, a toast; then the results overlay ----------
async function layouts(w) {
  // offline Grand Prix: qualifying -> the session box shows; the lights are forced on and a toast is up
  const gpOk = await w.js(`(function () { var g = F1.game.gp; return g.start({ q: 2, r: 5, wear: 1 }, F1.game.track.length); })()`);
  await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 5000, 'quali');
  await w.js(`(function () { var real = F1.ui.setLights; window.__realLights = real; F1.ui.setLights = function () { return real.call(F1.ui, 3, false, false); }; return true; })()`);
  await sleep(500);
  await w.js(`__hm.placeCars(), true`);
  console.log('gp start ' + gpOk);
  for (const [W, H] of [[1280, 720], [1920, 1080]]) {
    console.log('size ' + J(await w.size(W, H)));
    await w.js(`F1.ui.toast('大獎賽開始：排位 2 圈，正賽 5 圈', 60000), true`);
    await sleep(600);
    let R = await rectsOf(w);
    let L = await boxesOf(w);
    check('layout ' + W + 'x' + H + ' (qualifying: session box, start lights, toast): no HUD box overlaps another, the mirrors included', L.over.length === 0, L.over);
    results.layouts['quali-' + W] = { glass: R.r, boxes: L.boxes, overlaps: L.over, target: R.info.target };
    console.log('layout quali ' + W + 'x' + H + ' boxes ' + J(L.boxes) + ' glass ' + J(R.r));
    let img = await w.shot('layout-' + W + '-quali-lights-toast');
    let B = blobs(img, R);
    check('layout ' + W + ': glass inside its frame (module rect = frame padding box + 1 px)',
      R.frames.every((f, k) => R.r[k] && Math.abs(R.r[k][0] - (f[0] + f[4] - 1)) < 0.6 && Math.abs(R.r[k][2] - (f[5] + 2)) < 0.6), { glass: R.r, frames: R.frames });
    check('layout ' + W + ': both mirrors draw the test cars', B[0] && B[1] && B[0].M.n > 20 && B[1].C.n > 20, B.map(b => b && [b.M.n, b.C.n, b.Y.n]));
    // the results overlay of a 16-driver race (main.js's own setGp calls held off meanwhile)
    await w.js(`F1.ui.toast(''); F1.ui.setLights = window.__realLights; window.__setGp = F1.ui.setGp; F1.ui.setGp = function () {}; window.__setGp.call(F1.ui, ${J(MOCK.V.results16({}))}); true`);
    await sleep(500);
    R = await rectsOf(w);
    L = await boxesOf(w);
    results.layouts['results-' + W] = { glass: R.r, boxes: L.boxes, overlaps: L.over };
    check('layout ' + W + 'x' + H + ' (results overlay of 16): nothing over the mirrors, the overlay clear of the session box / timing box / minimap',
      !!L.boxes['gp-results'] && L.mirOver.length === 0 && L.over.filter(o => /gp-results/.test(o) && /hud-(gp|timing|map)/.test(o)).length === 0, { over: L.over, results: L.boxes['gp-results'] });
    img = await w.shot('layout-' + W + '-results16');
    B = blobs(img, R);
    check('layout ' + W + ' (results): the mirrors still draw the test cars', B[0] && B[1] && B[0].M.n > 20 && B[1].C.n > 20, B.map(b => b && [b.M.n, b.C.n, b.Y.n]));
    await w.js(`F1.ui.setGp = window.__setGp; F1.ui.setLights = function () { return window.__realLights.call(F1.ui, 3, false, false); }; F1.game.gp.action('skip'); F1.game.gp.action('end'); F1.game.gp.action('end'); true`);
    await sleep(300);
    await w.js(`F1.game.gp.start({ q: 2, r: 5, wear: 1 }, F1.game.track.length), true`);
    await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 5000, 'quali again');
    await sleep(300);
    await w.js(`__hm.placeCars(), true`);
  }
  await w.js(`F1.ui.toast('', 1); F1.ui.setLights = window.__realLights; F1.game.gp.action('end'); F1.game.gp.action('end'); true`);
  await w.until(`F1.game.gp.phase === 'free'`, 3000, 'free');
  await w.size(1280, 720);
}

// ---------- cost at 1920x1080 ----------
async function cost(w) {
  await w.size(1920, 1080);
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
  const back = await w.js(`__hm.hm.info()`);
  check('cost runs done; the game\'s mirrors back on their defaults (rate auto, MSAA 4, trees)', back.visible && back.rateMode === 'auto' && back.trees === true, back);
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

// a new start of the game with the setting stored off: the mirrors come up hidden with the first track, V brings them
async function restart() {
  const w = makeWin(1280, 720);
  for (let k = 0; k < 4; k++) { try { await w.loadFile(path.join(__dirname, '..', 'ref-car.html')); break; } catch (e) { await sleep(500); } }
  await w.js(`localStorage.setItem('f1drive.hud', '{"mirrors":false}'); true`);
  if (!await boot(w)) return;
  const pre = await w.js(`({ setting: F1.ui.getMirrors(), box: document.getElementById('set-mirrors').checked, cls: document.getElementById('hud').classList.contains('no-mirrors') })`);
  await pickTrack(w, TRACK);
  await sleep(800);
  const s = await mirState(w);
  check('a new start with the mirrors stored off: the switch off, the HUD without them, the game\'s instance created hidden (no targets)', pre.setting === false && !pre.box && pre.cls &&
    s.visible === false && !s.target[0] && s.frames.every(f => !f) && s.noMirrors && s.timingTop === 18, { pre, s });
  await w.key('V');
  await sleep(600);
  const v = await mirState(w);
  check('... V shows them (drawn, frames, boxes under them)', v.visible === true && v.frames.every(Boolean) && !v.noMirrors && v.timingTop === 110 && v.passes > 0, v);
  check('no page errors / console errors (new start)', w.errors.length === 0, w.errors.slice(0, 4));
  // the mirrors are decoration: one that throws while drawing is switched off (設定: 無法顯示), the game drives on
  await w.js(`(function () { var hm = F1.game.hudMirrors; hm.render = function () { throw new Error('hudmirrors-test: a broken mirror pass'); }; return true; })()`);
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(900);
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  const broken = await w.js(`({ running: F1.game.running, hm: F1.game.hudMirrors === null ? null : 'still there', overlay: !document.getElementById('error').classList.contains('hidden'),
    kmh: Math.round(F1.game.car.state.speed * 3.6), dis: document.getElementById('set-mirrors').disabled, txt: document.getElementById('set-mirrors-text').textContent,
    cls: document.getElementById('hud').classList.contains('no-mirrors'), timingTop: Math.round(document.getElementById('hud-timing').getBoundingClientRect().top),
    frames: ['hud-mirror-l', 'hud-mirror-r'].map(function (id) { return document.getElementById(id).getBoundingClientRect().width > 0; }), setting: F1.ui.getMirrors() })`);
  await w.js(`F1.ui.toast(''), true`);
  await w.key('V');
  await sleep(300);
  const afterV = await w.js(`({ hm: F1.game.hudMirrors === null ? null : 'back', cls: document.getElementById('hud').classList.contains('no-mirrors'), toast: document.getElementById('hud-toast').textContent })`);
  const expected = w.errors.filter(e => /a broken mirror pass/.test(e));
  check('a mirror pass that throws: mirrors switched off for good (game instance gone, 設定 switch disabled 無法顯示, HUD laid out without them, the setting kept), the game drives on (no error overlay, W accelerates); V then does nothing',
    broken.running && broken.hm === null && !broken.overlay && broken.kmh > 20 && broken.dis && broken.txt === '無法顯示' && broken.cls && broken.timingTop === 18 &&
    broken.frames.every(f => !f) && broken.setting === true && afterV.hm === null && afterV.cls && !/後照鏡/.test(afterV.toast) && expected.length === 1 && w.errors.length === 1,
    { broken, afterV, errors: w.errors.slice(0, 3) });
  try { w.destroy(); } catch (e) {}
}

function finish() {
  const failed = results.checks.filter(c => !c.ok).length;
  results.summary = { checks: results.checks.length, failed };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASS') + ' (' + results.checks.length + ' checks)');
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
}

app.on('window-all-closed', () => {});      // the restart check opens a second window after the first is destroyed
main().catch(e => { console.log('FATAL ' + (e && e.stack || e)); app.exit(2); });
