// The REAL app entry (electron-main.js) boots the game: its window is made offscreen / hidden here (BrowserWindow is
// swapped for a subclass while electron-main.js is required), the userData dir is a throw-away one.
//   npx electron devtests/v6-smoke/app-check.js          exit code 1 on a failure
// Checks: the autoplay switch is set, the page boots without the error overlay, F1.audio runs (worklet, context
// running) without any user gesture, Monza loads and drives with the sound active, no console errors.
'use strict';
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..');
const electron = require('electron');
const { app } = electron;
require('../electron-userdata')(app, 'v6-app');
const RealBW = electron.BrowserWindow;
let win = null;
class OffscreenWindow extends RealBW {
  constructor(o) {
    o = Object.assign({}, o, { show: false });
    o.webPreferences = Object.assign({}, o.webPreferences, { offscreen: true });
    super(o);
    win = this;
  }
  maximize() {}
  setFullScreen() {}
}
const load = Module._load;
Module._load = function (request) {
  if (request === 'electron') return new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? OffscreenWindow : t[k]) });
  return load.apply(this, arguments);
};
require(path.join(ROOT, 'electron-main.js'));
Module._load = load;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
}
app.whenReady().then(async () => {
  const errors = [];
  for (let i = 0; i < 50 && !win; i++) await sleep(100);
  check('electron-main.js opened its window', !!win);
  if (!win) return app.exit(1);
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security Warning') < 0) errors.push(msg); });
  check('autoplay policy switch set (no-user-gesture-required)', app.commandLine.getSwitchValue('autoplay-policy') === 'no-user-gesture-required', app.commandLine.getSwitchValue('autoplay-policy'));
  await new Promise(r => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', r); else r(); });
  await sleep(1500);
  const js = c => win.webContents.executeJavaScript(c);
  const boot = await js(`({ overlay: document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent,
    host: !!window.f1host, canCreate: F1.net.canCreate, audio: { backend: F1.audio.debug.backend, ready: F1.audio.debug.ready, state: F1.audio.debug.context ? F1.audio.debug.context.state : null } })`);
  check('boots: no error overlay, the host API (preload) present', !boot.overlay && boot.host && boot.canCreate, boot);
  check('F1.audio initialised at boot without a gesture: worklet', boot.audio.backend === 'worklet' && boot.audio.ready, boot.audio);
  await js(`(function () { var i = F1_TRACKS.findIndex(function (t) { return t.id === 'it-1922'; }); document.querySelectorAll('#track-grid .card')[i].click(); return true; })()`);
  await sleep(3000);
  const before = await js(`({ running: F1.game.running, active: F1.audio.active, state: F1.audio.debug.context.state, frames: F1.audio.debug.frames })`);
  check('Monza loaded (a script click, no user gesture yet): the sound is active and its context running', before.running && before.active && before.state === 'running' && before.frames > 30, before);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(2000);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  const drive = await js(`({ running: F1.game.running, v: F1.game.car.state.speed, active: F1.audio.active, state: F1.audio.debug.context.state, frames: F1.audio.debug.frames, rpm: F1.audio.debug.rpm })`);
  check('W: it drives, the engine sound follows', drive.running && drive.v > 10 && drive.active && drive.state === 'running' && drive.frames > 60 && drive.rpm > 4000, drive);
  check('no console errors', errors.length === 0, errors.slice(0, 3));
  const bad = results.filter(r => !r).length;
  console.log('\n' + (results.length - bad) + ' / ' + results.length + ' checks passed');
  app.exit(bad ? 1 : 0);
});
