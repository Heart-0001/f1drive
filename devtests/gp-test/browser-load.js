// npx electron devtests/gp-test/browser-load.js — js/gp.js as a classic browser script (no module / require):
// loads page.html (laps.js, net/session.js, net.js, gp.js in the contract's order) in an offscreen window and
// drives a whole offline Grand Prix through F1.gp with the real F1.net (not connected) and the real lap counter.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../electron-userdata')(app, 'gp-test');          // own throw-away userData dir, removed on exit
app.disableHardwareAcceleration();

function inPage() {
  var F1 = window.F1, gp = F1.gp, log = [], out = { env: {}, checks: [] };
  function check(name, ok, info) { out.checks.push({ name: name, ok: !!ok, info: info === undefined ? '' : String(info) }); }
  function run(sec) { for (var i = 0, n = Math.round(sec / 0.0625); i < n; i++) gp.update(0.0625); }
  out.env = { module: typeof module, require: typeof require, createSession: typeof F1.createSession, Session: typeof F1.Session,
    net: typeof F1.net, createGp: typeof F1.createGp, laps: typeof F1.createLapCounter };
  check('plain browser globals (no module / require)', typeof module === 'undefined' && typeof require === 'undefined');
  check('F1.gp and F1.createGp exist', gp && typeof gp.init === 'function' && typeof F1.createGp === 'function');
  gp.on('phase', function (p, prev) { log.push('phase ' + prev + '>' + p); });
  gp.on('go', function () { log.push('go'); });
  gp.on('change', function () { log.push('change'); });
  gp.on('lapRejected', function (w) { log.push('rejected ' + w); });
  gp.init({ net: F1.net, getProfile: function () { return { name: '測試車手', colour: '#FF7A14' }; } });
  check('idle offline after init', gp.phase === 'free' && !gp.online && gp.canControl && gp.selfId === 1);
  check('start', gp.start({ q: 1, r: 1 }, 5793) === true && gp.phase === 'quali' && gp.lapTotal === 1);
  gp.lapDone(5);
  run(100); gp.lapDone(85.5);
  check('qualified -> grid, locked', gp.phase === 'grid' && gp.inputLocked && gp.gridSlot === 0, gp.phase);
  var seen = [gp.lights], lap = F1.createLapCounter(400, 390), goTime = null;
  gp.on('go', function () { lap.arm(390); lap.time = gp.sinceGo; goTime = gp.sinceGo; });
  for (var i = 0; i < 16 * 14 && gp.phase === 'grid'; i++) { gp.update(0.0625); if (seen[seen.length - 1] !== gp.lights) seen.push(gp.lights); }
  check('lights 0..5 then out', seen.join('') === '0123450', seen.join(''));
  check('race, unlocked, lap counter armed at go', gp.phase === 'race' && !gp.inputLocked && lap.started && lap.behind && goTime !== null && goTime < 0.0625, goTime);
  // drive one lap with the real lap counter: 400 samples, one per 1/4 s
  var idx = 390, res = 0, laps = 0;
  for (var k = 0; k < 420 && gp.phase === 'race'; k++) {
    gp.update(0.25);
    idx = (idx + 1) % 400;
    res = lap.update(idx, 60, 0.25);
    gp.setProgress(lap.progress(idx));
    if (res === 2) { laps++; gp.lapDone(lap.last); }
  }
  var v = gp.view();
  check('one race lap -> results', gp.phase === 'results' && laps === 1 && v.done && v.pos === 1, gp.phase + ' laps ' + laps + ' last ' + lap.last);
  check('results row', v.rows.length === 1 && v.rows[0].name === '測試車手' && v.rows[0].colour === '#ff7a14' && Math.abs(v.rows[0].time - lap.last) <= 0.0005 + 1e-9,
    JSON.stringify(v.rows[0]) + ' last ' + lap.last + ' diff ' + (v.rows[0].time - lap.last));
  check('end -> free', gp.action('end') === true && gp.phase === 'free');
  var want = ['phase free>quali', 'change', 'rejected too-fast', 'phase quali>grid', 'change', 'go', 'phase grid>race', 'change',
    'phase race>results', 'change', 'phase results>free', 'change'];
  check('event sequence', log.join('|') === want.join('|'), log.join('|'));
  out.ok = out.checks.every(function (c) { return c.ok; });
  return out;
}

app.whenReady().then(async () => {
  const errors = [];
  let res;
  try {
    const win = new BrowserWindow({ width: 400, height: 300, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (e, level, msg, line, src) => { if (level >= 3) errors.push(msg + ' (' + src + ':' + line + ')'); });
    await win.loadFile(path.join(__dirname, 'page.html'));
    res = await win.webContents.executeJavaScript('(' + inPage.toString() + ')()');
  } catch (e) { res = { ok: false, checks: [], error: String(e && e.stack || e) }; }
  const lines = [];
  lines.push('env ' + JSON.stringify(res.env));
  res.checks.forEach(c => lines.push((c.ok ? 'ok   ' : 'FAIL ') + c.name + (c.ok || !c.info ? '' : '  [' + c.info + ']')));
  if (res.error) lines.push('ERROR ' + res.error);
  errors.forEach(e => lines.push('console error: ' + e));
  const ok = res.ok && !errors.length;
  lines.push(ok ? 'browser-load: all checks passed' : 'browser-load FAILED');
  console.log(lines.join('\n'));
  app.exit(ok ? 0 : 1);
});
