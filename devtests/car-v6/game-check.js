// npx electron devtests/car-v6/game-check.js        (env TRACK=monza, SHOTS=0 to skip the screenshots)
//
// The v6 car (js/car.js) and pad (js/gamepad.js) in the REAL game, before main.js is wired to the new features: the
// real index.html (minus the <script> tags whose files do not exist yet, see smoke-wrap.js), real key events, a fake
// standard-mapping controller behind navigator.getGamepads (as devtests/gp-smoke). What main.js already passes to the
// car is the input of F1.gamepad.mergeInput, so RB / B boost works through the real input path; the limiter needs
// main.js (keys.limiter) and is covered by test/car.test.js.
//   boot     no error overlay / console errors; F1.REF_SPEC, F1.carPerf, F1.sanitizeSpec; the game's car = REF_SPEC with
//            a fresh medium set (car.tyres), battery full
//   drive    W: gears up by the formula, rpm = perf.rpmFor(speed, gear), shiftT restarts at each change, throttle 1,
//            the tyres wear
//   battery  RT + RB held (fake pad): deploy > 0, the battery drains, faster than RT alone; S: harvest, it refills
//   pad      LB / Back: F1.gamepad.state.pressed.limiter / .compound for one frame; B held: boost
//   pit      the car put in the middle of the pit lane: asphalt (not grass), state.inPit; W then steering into the
//            pit wall: impact, never on the other side
// Screenshots devtests/car-v6/out/game-*.png. Exit code 1 when a check fails.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'car-v6');
const OUT = path.join(__dirname, 'out');
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const SHOTS = process.env.SHOTS !== '0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}

function pageCopy() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace(/<script src="([^"]+)"><\/script>\s*/g, (tag, src) => fs.existsSync(path.join(ROOT, src)) ? tag : '');
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'index-game.html');
  fs.writeFileSync(file, html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">'));
  return file;
}

const PAGE = `(function () {
  var b = []; for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
  window.__pad = { index: 0, id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return [window.__pad, null, null, null]; } });
  window.__btn = function (i, v) { var x = window.__pad.buttons[i]; x.value = v; x.pressed = v > 0.5; return true; };
  // one row per rendered frame (after main.js's frame: registered later): the car state and the pad's edges
  window.__rows = [];
  (function loop() {
    var c = F1.game && F1.game.car;
    if (c) {
      var s = c.state, p = F1.gamepad.state;
      window.__rows.push({ t: performance.now(), v: s.speed, gear: s.gear, rpm: s.rpm, rpmF: c.perf.rpmFor(s.speed, s.gear), shiftT: s.shiftT, thr: s.throttle, brk: s.brake,
        bat: s.battery, dep: s.deploy, har: s.harvest, grass: s.onGrass, inPit: s.inPit, hit: s.hit, d: s.d, i: s.sampleIndex,
        lim: p.pressed.limiter, comp: p.pressed.compound, boost: p.boost });
      if (window.__rows.length > 20000) window.__rows.splice(0, 10000);
    }
    requestAnimationFrame(loop);
  })();
  return true;
})()`;

process.on('exit', () => { try { fs.unlinkSync(path.join(OUT, 'index-game.html')); } catch (e) { /* not written */ } });

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const errors = [];
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security Warning') < 0) { errors.push(msg); console.log('[console]', msg); } });
  const js = code => w.webContents.executeJavaScript(code);
  const key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  const shot = async n => { if (!SHOTS) return; await sleep(150); fs.writeFileSync(path.join(OUT, 'game-' + n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const rows = async () => js(`(function () { var r = window.__rows; window.__rows = []; return r; })()`);
  try {
    await w.loadFile(pageCopy());
    await sleep(1200);
    await js(PAGE);
    const boot = await js(`({ overlay: document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent,
      ref: !!F1.REF_SPEC && typeof F1.carPerf === 'function' && typeof F1.sanitizeSpec === 'function', id: F1.REF_SPEC && F1.REF_SPEC.id, gears: F1.CAR_PERF.gears })`);
    check('boot: no error overlay, v6 car API present', !boot.overlay && boot.ref && boot.gears === 8, boot);
    const name = await js(`(function () { var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${JSON.stringify(TRACK)}) >= 0; })[0];
      if (!c) return null; c.click(); return c.querySelector('.card-name').textContent; })()`);
    await sleep(1500);
    const car0 = await js(`(function () { var c = F1.game.car; return { running: F1.game.running, spec: c.spec.id, same: JSON.stringify(c.spec) === JSON.stringify(F1.REF_SPEC), tyres: !!c.tyres && c.tyres.state.compound,
      rate: c.tyres && c.tyres.wearRate, bat: c.state.battery, gear: c.state.gear, rpm: c.state.rpm, pit: !!F1.game.track.pit }; })()`);
    check('track ' + name + ': the game\'s car is F1.REF_SPEC on a fresh medium set at wear rate 1, battery full, neutral', car0.running && car0.same && car0.tyres === 'M' && car0.rate === 1 &&
      car0.bat === 1 && car0.gear === 0 && car0.rpm === 4000 && car0.pit, car0);

    // --- drive: W
    await rows();
    key('W', true); await sleep(5000); key('W', false);
    let r = await rows();
    const gears = []; r.forEach(x => { if (!gears.length || gears[gears.length - 1] !== x.gear) gears.push(x.gear); });
    const rpmOk = r.every(x => Math.abs(x.rpm - x.rpmF) < 1e-6);
    const shiftOk = r.every((x, k) => k === 0 || x.gear === r[k - 1].gear || x.shiftT < 0.05);
    const oneByOne = gears.every((g, k) => g === k);
    check('W (5 s): gears up one by one to 4th or more, rpm = perf.rpmFor(speed, gear), shiftT restarts at each change, throttle 1', oneByOne && gears.length >= 5 && rpmOk && shiftOk &&
      r.filter(x => x.v > 1).every(x => x.thr === 1), { gears: gears.join(' '), vmaxKmh: Math.round(Math.max(...r.map(x => x.v)) * 3.6), rpmOk, shiftOk });
    const wear = await js(`F1.game.car.tyres.state.wear.slice()`);
    check('the tyres are fed: they wear', wear.every(x => x > 0), wear);
    await shot('drive');

    // --- battery through the real pad path: RT alone, then RT + RB (mergeInput -> car.update)
    await js(`F1.game.car.reset(F1.game.track, Math.round(F1.game.track.samples.length * 0.72)); F1.game.car.setBattery(1); true`);
    await rows();
    await js(`__btn(7, 1)`); await sleep(1500);
    r = await rows();
    const batA = r[r.length - 1].bat, depA = Math.max(...r.map(x => x.dep));
    await js(`__btn(5, 1)`); await sleep(2500);
    r = await rows();
    const batB = r[r.length - 1].bat, depB = Math.max(...r.map(x => x.dep)), boostSeen = r.some(x => x.boost);
    await js(`__btn(7, 0); __btn(5, 0)`);
    check('RT alone: no deploy, battery full', depA === 0 && batA === 1, { depA, batA });
    check('RT + RB held: deploy, the battery drains (mergeInput passes boost)', boostSeen && depB > 0.5 && batB < 0.97, { depB, batB });
    await rows();
    key('S', true); await sleep(1500); key('S', false);
    r = await rows();
    const har = Math.max(...r.map(x => x.har)), batC = r[r.length - 1].bat;
    check('S: harvest under braking, the battery refills; brake 1', har > 0.5 && batC > batB && r.some(x => x.brk === 1), { har, batB, batC });
    // B held is a boost too
    await js(`__btn(1, 1)`); await sleep(200);
    r = await rows(); await js(`__btn(1, 0)`);
    check('B held: F1.gamepad.state.boost', r.some(x => x.boost), r.length);
    // LB / Back: one-frame edges
    await rows();
    await js(`__btn(4, 1)`); await sleep(300); await js(`__btn(4, 0)`); await sleep(150);
    await js(`__btn(8, 1)`); await sleep(300); await js(`__btn(8, 0)`); await sleep(150);
    r = await rows();
    check('LB -> pressed.limiter, Back -> pressed.compound, one frame each', r.filter(x => x.lim).length === 1 && r.filter(x => x.comp).length === 1,
      { lim: r.filter(x => x.lim).length, comp: r.filter(x => x.comp).length });

    // --- pit lane: the car in the middle of the lane, then into the pit wall
    const lane = await js(`(function () {
      var tr = F1.game.track, pit = tr.pit, S = tr.samples, N = S.length, c = F1.game.car, st = c.state;
      var k = Math.round(((pit.exit - pit.entry + N) % N) * 0.3), i = (pit.entry + k) % N, s = S[i], d = pit.laneD(i);
      c.reset(tr, i); st.x = s.x + s.nx * d; st.z = s.z + s.nz * d; st.heading = Math.atan2(s.tx, s.tz); c.update(1e-4, null, tr); st.speed = 0;
      window.__pitSide = pit.side; window.__wallD = pit.wallD(i);
      return { d: st.d, laneD: d, inPit: st.inPit, grass: st.onGrass, wallD: pit.wallD(i), halfT: pit.wallHalfT, side: pit.side };
    })()`);
    check('in the pit lane: asphalt, inPit', lane.inPit && !lane.grass, lane);
    await rows();
    key('W', true); await sleep(1800);
    r = await rows();
    // (1.8 s from standstill: ~65 km/h on asphalt, ~35 on grass)
    check('W in the lane: accelerates as on asphalt, inPit all along, never grass', r.every(x => x.inPit && !x.grass) && r[r.length - 1].v * 3.6 > 55,
      { kmh: Math.round(r[r.length - 1].v * 3.6), inPit: r.every(x => x.inPit), grass: r.some(x => x.grass) });
    await shot('pitlane');
    // steer towards the track: through the pit wall? (+n is the driver's left: A when the lane is on the -n side... the
    // wall is between the lane and the track, so steer away from the lane side)
    const toTrack = lane.side > 0 ? 'D' : 'A';
    key(toTrack, true); await sleep(1500); key(toTrack, false); key('W', false);
    r = await rows();
    const wD = lane.wallD, lim = lane.halfT + 1;
    const wrong = r.filter(x => Math.sign(x.d - wD) !== Math.sign(lane.laneD - wD) && Math.abs(x.d - wD) < 30).length;
    const minGap = Math.min(...r.map(x => Math.abs(x.d - wD)));
    check('steering into the pit wall from the lane: an impact, never on the track side of it', r.some(x => x.hit > 0) && wrong === 0 && minGap >= lim - 0.05,
      { maxHit: Math.max(...r.map(x => x.hit)), wrong, minGap });
    await shot('pitwall');
    check('no console errors', errors.length === 0, errors.slice(0, 3));
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  const bad = results.filter(x => !x.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '  FAILED: ' + bad.map(x => x.name).join(' | ') : ''));
  app.exit(bad.length ? 1 : 0);
});
