// npx electron devtests/gamepad-test/game-map.js        (env TRACK=monza)
//
// The v6.1 controller mapping (js/gamepad.js) in the REAL game: the real index.html + js/main.js in one offscreen,
// MUTED window (devtests/electron-userdata.js), a fake standard-mapping controller behind navigator.getGamepads (as
// devtests/gp-smoke), every function pressed on its new button and what main.js did with it read back:
//   A [0] / RB [5] held = battery deploy      B [1] / LB [4] = pit limiter toggle      X [2] = next tyre compound
//   Y [3] = reset to the track                View [8] = racing line                   Menu [9] = menu / resume
//   RS click [11] = recentre the view
// and the v6 meanings gone (A does not reset, X does not toggle the line, View does not change the compound, B does not
// deploy). Exit code 1 when a check fails, 2 on the 120 s watchdog.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'pad-map');           // mutes the window (never set SOUND here)
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
}
setTimeout(() => { console.log('WATCHDOG: 120 s'); app.exit(2); }, 120000).unref();

const FAKE_PAD = `(function () {
  var b = []; for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
  window.__pad = { index: 0, id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return [window.__pad, null, null, null]; } });
  window.__btn = function (i, v) { var x = window.__pad.buttons[i]; x.value = v; x.pressed = v > 0.5; return true; };
  window.__ax = function (a) { for (var i = 0; i < 4; i++) if (a[i] != null) window.__pad.axes[i] = a[i]; return true; };
  // peak of car.state.deploy since the last read
  window.__dep = 0; setInterval(function () { var c = F1.game && F1.game.car; if (c && c.state.deploy > window.__dep) window.__dep = c.state.deploy; }, 5);
  window.__depRead = function () { var d = window.__dep; window.__dep = 0; return d; };
  return true;
})()`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const errors = [];
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security Warning') < 0) { errors.push(msg); console.log('[console]', msg); } });
  const js = code => w.webContents.executeJavaScript(code);
  const until = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js('!!(' + code + ')')) return true; await sleep(40); } return false; };
  const btn = (i, v) => js(`__btn(${i}, ${v})`);
  const press = async i => { await btn(i, 1); await sleep(160); await btn(i, 0); await sleep(160); };
  const look = () => js(`({ y: F1.game.camera.rotation.y - Math.PI, max: F1.COCKPIT_LOOK.maxYaw })`);
  const stop = async () => { await btn(7, 0); await js(`__ax([0, 0, 0, 0])`); await btn(6, 1); await until(`Math.abs(F1.game.car.state.speed) < 1`, 6000); await btn(6, 0); };
  let code = 1;
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(900);
    await js(FAKE_PAD);
    await sleep(350);
    const name = await js(`(function () { var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${J(TRACK)}) >= 0; })[0];
      if (!c) return null; c.click(); var __g=document.getElementById('setup-go'); if(__g) __g.click(); return c.querySelector('.card-name').textContent; })()`);
    const running = await until(`F1.game.running && F1.gamepad.state.connected`, 15000);
    await sleep(300);
    const car0 = await js(`({ spec: F1.game.car.spec.id, ers: !!F1.game.car.perf.ersPower || F1.game.car.state.battery > 0 })`);
    check('boot: ' + name + ' running, fake pad connected', running && !!name, car0);

    // --- A [0] held = battery; RB [5] held = battery too; B [1] held = NOT the battery
    await btn(7, 1); await sleep(1200); await js(`__depRead()`);
    await btn(0, 1); await sleep(1500);
    const a = await js(`({ dep: __depRead(), boost: F1.gamepad.state.boost, bat: F1.game.car.state.battery })`);
    await btn(0, 0); await sleep(300); await js(`__depRead()`); await sleep(400);
    const aOff = await js(`({ dep: __depRead(), boost: F1.gamepad.state.boost })`);
    await btn(5, 1); await sleep(800);
    const rb = await js(`({ dep: __depRead(), boost: F1.gamepad.state.boost })`);
    await btn(5, 0); await sleep(300); await js(`__depRead()`);
    check('A held: the battery deploys (state.deploy > 0, drains); released: no deploy', a.dep > 0.1 && a.boost && a.bat < 1 && aOff.dep === 0 && !aOff.boost, { a, aOff });
    check('RB held: deploys too', rb.dep > 0.1 && rb.boost, rb);
    const l0 = await js(`F1.game.limiter`);
    await btn(1, 1); await sleep(400);
    const bHeld = await js(`({ dep: __depRead(), boost: F1.gamepad.state.boost, lim: F1.game.limiter })`);
    await btn(1, 0); await sleep(160);
    if (await js(`F1.game.limiter`)) await press(1);        // B toggled the limiter on: off again for the next part
    check('B held: no deploy (B is the limiter now: it toggled it)', bHeld.dep === 0 && !bHeld.boost && bHeld.lim === !l0, bHeld);
    await stop();

    // --- B [1] / LB [4] = pit limiter toggle
    const lim = [await js(`F1.game.limiter`)];
    await press(1); lim.push(await js(`F1.game.limiter`));
    await press(1); lim.push(await js(`F1.game.limiter`));
    await press(4); lim.push(await js(`F1.game.limiter`));
    await press(4); lim.push(await js(`F1.game.limiter`));
    check('B toggles the pit limiter, LB too', J(lim) === J([false, true, false, true, false]), lim);

    // --- X [2] = next compound; View [8] does not change it
    const cmp = [await js(`F1.game.nextCompound`)];
    await press(2); cmp.push(await js(`F1.game.nextCompound`));
    await press(2); cmp.push(await js(`F1.game.nextCompound`));
    await press(8); cmp.push(await js(`F1.game.nextCompound`));
    await press(8);                                          // (the line back as it was)
    check('X picks the next compound (M -> H -> S); View leaves it alone', J(cmp) === J(['M', 'H', 'S', 'S']), cmp);
    await press(2);                                          // back to M

    // --- View [8] = racing line; X [2] does not toggle it
    const ln = [await js(`F1.game.raceLine.group.visible`)];
    await press(8); ln.push(await js(`F1.game.raceLine.group.visible`));
    await press(8); ln.push(await js(`F1.game.raceLine.group.visible`));
    await press(2); ln.push(await js(`F1.game.raceLine.group.visible`));
    check('View toggles the racing line; X does not', ln[0] === true && ln[1] === false && ln[2] === true && ln[3] === true, ln);
    await press(2); await press(2);                          // compound round to M again

    // --- Y [3] = reset; A [0] does not reset
    await btn(7, 1); await js(`__ax([-0.6])`); await sleep(900); await js(`__ax([0])`); await btn(7, 0);
    const dOff = await js(`F1.game.car.state.d`);
    await press(0);
    const dA = await js(`({ d: F1.game.car.state.d, v: F1.game.car.state.speed })`);
    await press(3);
    const dY = await js(`({ d: F1.game.car.state.d, v: F1.game.car.state.speed })`);
    check('A does not reset; Y resets the car onto the centreline', Math.abs(dOff) > 0.3 && Math.abs(dA.d) > 0.3 && dA.v > 1 && Math.abs(dY.d) < 0.01 && Math.abs(dY.v) < 0.5, { dOff, dA, dY });

    // --- Menu [9] opens the menu, again resumes
    await press(9);
    const menu = await js(`!F1.game.running`);
    await sleep(700);                                        // longer than gamepad.js's 500 ms edge resync
    await press(9);
    const back = await js(`F1.game.running`);
    check('Menu opens the menu, Menu again resumes', menu && back, { menu, back });

    // --- RS click [11] recentres the view at once
    await js(`__ax([null, null, -1, 0])`); await sleep(900);
    const lookL = await look();
    await js(`__pad.axes[2] = 0; __pad.axes[3] = 0; __btn(11, 1)`); await sleep(70);
    const lookC = await look();
    await btn(11, 0);
    check('right stick looks left; RS click recentres at once', near(lookL.y, lookL.max, 0.03) && near(lookC.y, 0, 1e-6), { left: lookL.y, max: lookL.max, after: lookC.y });

    const overlay = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    check('no error overlay, no console errors', !overlay && errors.length === 0, overlay || errors.slice(0, 3));
    const bad = results.filter(r => !r.ok).length;
    console.log((bad ? 'FAILED ' + bad + ' of ' : 'ALL PASS ') + results.length + ' checks');
    code = bad ? 1 : 0;
  } catch (e) {
    console.log('ERROR', e && e.stack || e);
  }
  w.destroy();
  app.exit(code);
});
