// npx electron devtests/tyres-test/browser-load.js — js/tyres.js as a classic browser script (no module / require),
// loaded the way index.html loads it (page.html: a window.F1 that already exists, then the script). Runs the same
// deterministic scenario (seeded random: a lap-like mix of corners, braking, traction, slides, grass, impacts, a set worn
// through at x5) in the page and in node, and compares the resulting states: they must be identical.
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../electron-userdata')(app, 'tyres-test');       // own throw-away userData dir, removed on exit
app.disableHardwareAcceleration();

// runs in both places; F1 = the namespace holding createTyres
function scenario(F1) {
  var s = 12345, random = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  var ty = F1.createTyres({ random: random }), L = { speed: 0, lat: 0, brake: 0, drive: 0, slip: 0, onGrass: false, hit: 0 };
  var trace = [];
  ty.fit('S'); ty.setWearRate(5);
  for (var i = 0; i < 120 * 200; i++) {
    var t = i / 120;
    L.speed = 30 + 50 * Math.abs(Math.sin(t * 0.3)); L.lat = Math.sin(t * 0.7); L.brake = (t % 9) < 1.2 ? 0.8 : 0;
    L.drive = (t % 9) > 3 ? 1 : 0.2; L.slip = (t % 23) < 1.5 ? 0.7 : 0; L.onGrass = (t % 31) < 1; L.hit = i % 3000 === 1500 ? 0.3 + (i % 7) / 10 : 0;
    ty.update(1 / 120, L);
    if (i % 1200 === 0) trace.push(ty.state.puncture, ty.state.grip.lat, ty.state.vib);
  }
  return { state: JSON.parse(JSON.stringify(ty.state)), trace: trace, next: F1.Tyres.nextCompound('H'), names: F1.Tyres.NAMES };
}

app.whenReady().then(async () => {
  const errors = [], lines = [];
  let ok = true;
  const check = (c, what) => { lines.push((c ? 'ok   ' : 'FAIL ') + what); if (!c) ok = false; };
  try {
    const win = new BrowserWindow({ width: 400, height: 300, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (e, level, msg, line, src) => { if (level >= 3) errors.push(msg + ' (' + src + ':' + line + ')'); });
    await win.loadFile(path.join(__dirname, 'page.html'));
    const env = await win.webContents.executeJavaScript('({ module: typeof module, require: typeof require, before: window.F1.before, ' +
      'createTyres: typeof window.F1.createTyres, Tyres: typeof window.F1.Tyres, same: window.F1.Tyres && window.F1.Tyres.createTyres === window.F1.createTyres })');
    lines.push('env ' + JSON.stringify(env));
    check(env.module === 'undefined' && env.require === 'undefined', 'plain browser globals (no module / require)');
    check(env.before === 'kept', 'the existing window.F1 is extended, not replaced');
    check(env.createTyres === 'function' && env.Tyres === 'object' && env.same, 'F1.createTyres and F1.Tyres');
    const page = await win.webContents.executeJavaScript('(' + scenario.toString() + ')(window.F1)');
    const node = scenario(require('../../js/tyres.js') && globalThis.F1);
    check(JSON.stringify(page) === JSON.stringify(node), 'page and node give the identical run (' + page.trace.length / 3 + ' samples, final wear ' +
      page.state.wear.map(w => w.toFixed(3)).join(' ') + ', puncture ' + page.state.puncture + ')');
    check(page.next === 'S' && page.names.M === '中性胎', 'helpers: nextCompound, names');
  } catch (e) { check(false, 'ERROR ' + (e && e.stack || e)); }
  errors.forEach(e => { lines.push('console error: ' + e); ok = false; });
  lines.push(ok ? 'browser-load: all checks passed' : 'browser-load FAILED');
  console.log(lines.join('\n'));
  app.exit(ok ? 0 : 1);
});
