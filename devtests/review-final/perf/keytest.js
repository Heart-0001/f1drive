'use strict';
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const electron = require('electron');
const { app } = electron;
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review-key');
const RealBW = electron.BrowserWindow;
let win = null;
class OffscreenWindow extends RealBW {
  constructor(o) { o = Object.assign({}, o, { show: false }); o.webPreferences = Object.assign({}, o.webPreferences, { offscreen: true }); super(o); win = this; }
  maximize() {} setFullScreen() {}
}
const load = Module._load;
Module._load = function (request) { if (request === 'electron') return new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? OffscreenWindow : t[k]) }); return load.apply(this, arguments); };
require(path.join(ROOT, 'electron-main.js'));
Module._load = load;
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  for (let i = 0; i < 100 && !win; i++) await sleep(50);
  await new Promise(r => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', r); else r(); });
  const js = c => win.webContents.executeJavaScript(c);
  for (let i = 0; i < 100; i++) { if (await js('!!(window.F1 && F1.game)')) break; await sleep(50); }
  await js(`(function(){ var i = F1_TRACKS.findIndex(function(t){ return t.id === 'it-1922'; }); document.querySelectorAll('#track-grid .card')[i].click(); return true; })()`);
  await sleep(1500);
  const probe = async tag => console.log(tag, JSON.stringify(await js('({running: F1.game.running, input: F1.game.input, v: F1.game.car.state.speed, focus: document.hasFocus(), active: document.activeElement && document.activeElement.id})')));
  await probe('after load');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  await sleep(300); await probe('W down 0.3s');
  await sleep(3000); await probe('W down 3.3s');
  if (process.env.CDP) { win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Performance.enable'); await sleep(3000); await probe('with cdp 3s'); }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R' }); await sleep(50); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R' });
  await sleep(2000); await probe('after R + 2s');
  app.exit(0);
});
