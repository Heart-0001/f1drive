// Verifier probe for "v6-glue-missing-sound-telemetry": the REAL game (index.html + the current js/main.js) in an
// offscreen Electron window. Drive forward and in reverse with real key events, press Q / E / T / M, and record what
// reaches F1.audio, F1.telemetry.draw, the 車輛 tab and the pit strip.
//   npx electron devtests/review-1/verify-media/probe-glue.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require('../../electron-userdata')(app, 'verify-media-glue');
app.commandLine.appendSwitch('mute-audio');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const errors = [];
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Security Warning') < 0) errors.push(msg); });
  const js = c => w.webContents.executeJavaScript(c, true);
  const key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  const tap = async k => { key(k, true); await sleep(80); key(k, false); await sleep(150); };
  const out = {};
  try {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(1200);
    out.errorOverlay = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent.slice(0, 300)`);
    // record every object handed to the telemetry graphic
    await js(`(function () { var d = F1.telemetry.draw; window.__tele = []; F1.telemetry.draw = function (t) {
      window.__tele.push({ gear: t && t.gear, speedKmh: t && Math.round(t.speedKmh), rpm: t && t.rpm, throttle: t && t.throttle, brake: t && t.brake,
        battery: t && t.battery, team: t && t.team, car: t && t.car, keys: t ? Object.keys(t).join(',') : '' });
      if (window.__tele.length > 4000) window.__tele.shift();
      return d.apply(this, arguments); }; return true; })()`);
    out.carTabBefore = await js(`(function () { var e = document.getElementById('car-empty'); return e ? { text: e.textContent, hidden: e.classList.contains('hidden') || getComputedStyle(e).display === 'none' } : null; })()`);
    out.picked = await js(`(function () { var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf('monza') >= 0; })[0];
      if (!c) return null; c.click(); return c.querySelector('.card-name').textContent; })()`);
    await sleep(2500);
    out.running = await js('F1.game.running');
    out.spec = await js(`(function () { var c = F1.game.car; return c && c.spec ? { id: c.spec.id, cockpit: c.spec.cockpit, colour: c.spec.colour } : null; })()`);
    // forward
    key('W', true); await sleep(2500); key('W', false);
    out.forward = await js(`(function () { var s = F1.game.car.state, t = __tele[__tele.length - 1]; return { speed: s.speed, stateGear: s.gear, stateRpm: s.rpm, stateBattery: s.battery, tele: t }; })()`);
    key('S', true); await sleep(6000);
    out.reverse = await js(`(function () { var s = F1.game.car.state, t = __tele[__tele.length - 1]; return { speed: s.speed, stateGear: s.gear, tele: t }; })()`);
    key('S', false); await sleep(300);
    // v6 keys
    out.beforeKeys = await js(`(function () { var s = F1.game.car.state; return { limiter: s.limiter, deploy: s.deploy, input: JSON.stringify(F1.game.input) }; })()`);
    await tap('Q');
    key('W', true); key('E', true); await sleep(1500);
    out.afterQE = await js(`(function () { var s = F1.game.car.state; return { limiter: s.limiter, deploy: s.deploy, battery: s.battery, input: JSON.stringify(F1.game.input) }; })()`);
    key('E', false); key('W', false);
    await tap('T'); await tap('M');
    out.audio = await js(`(function () { var a = F1.audio, d = a.debug; return { supported: a.supported, active: a.active, muted: a.muted, ready: d.ready, frames: d.frames, backend: d.backend, context: d.context ? d.context.state : null }; })()`);
    out.pitStrip = await js(`(function () { var e = document.getElementById('hud-pit'); if (!e) return 'no #hud-pit'; var r = e.getBoundingClientRect(); return { shown: r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none', text: e.textContent.trim().slice(0, 60) }; })()`);
    // back to the menu: the 車輛 tab
    await tap('Escape'); await sleep(400);
    out.carTabAfter = await js(`(function () { var e = document.getElementById('car-empty'); return e ? { text: e.textContent, hidden: e.classList.contains('hidden') || getComputedStyle(e).display === 'none', cards: document.querySelectorAll('#car-list > *').length } : null; })()`);
    out.teleSummary = await js(`(function () { var gears = {}, keys = {}; __tele.forEach(function (t) { gears[typeof t.gear + ':' + t.gear] = (gears[typeof t.gear + ':' + t.gear] || 0) + 1; keys[t.keys] = 1; });
      return { draws: __tele.length, gears: gears, keySets: Object.keys(keys) }; })()`);
  } catch (e) { out.err = String(e && e.stack || e); }
  out.consoleErrors = errors.slice(0, 5);
  console.log(JSON.stringify(out, null, 1));
  app.exit(0);
});
