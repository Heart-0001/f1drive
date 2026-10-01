// npx electron devtests/pit-logic/page-check.js
// js/pit.js as a classic browser script: loads devtests/pit-logic/page.html (three, tracks, track.js, laps.js, pit.js,
// session.js in the game's order) in an offscreen window and runs drive-lane.js on real tracks inside the page:
// the real track.pit where js/track.js has one, a mock lane otherwise (both sides). Exit code 1 on any failure.
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../electron-userdata')(app, 'pit-logic');

const TRACKS = (process.env.TRACKS || 'mc-1929,it-1922,jp-1962,sg-2008,be-1925').split(',');

app.whenReady().then(async () => {
  let failed = 0;
  const w = new BrowserWindow({ width: 400, height: 300, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const kill = setTimeout(() => { console.log('FAIL timeout'); app.exit(2); }, 120000);
  try {
    await w.loadFile(path.join(__dirname, 'page.html'));
    const res = await w.webContents.executeJavaScript(`(function () {
      var out = { errors: window.__errors.slice(), api: null, runs: [] };
      var P = window.F1 && window.F1.createPit;
      out.api = { createPit: typeof P, serviceTime: P && typeof P.serviceTime, moduleLeak: typeof module,
        pitKeys: P ? Object.keys(P()).join(',') : '', lapCounter: typeof window.F1.createLapCounter,
        session: typeof window.F1.createSession };
      ${JSON.stringify(TRACKS)}.forEach(function (id) {
        var td = window.F1_TRACKS.filter(function (t) { return t.id === id; })[0];
        if (!td) { out.runs.push({ id: id, ok: false, fails: ['no such track'] }); return; }
        var track = window.F1.buildTrack(td), real = !!track.pit;
        var r = PitDrive.checkTrack(window.F1, track);
        out.runs.push({ id: id, kind: real ? 'real' : 'none', ok: r.ok, fails: r.fails, summary: r.summary });
        [-1, 1].forEach(function (sd) {
          track.pit = PitDrive.mockPit(track, sd);
          var m = PitDrive.checkTrack(window.F1, track);
          out.runs.push({ id: id, kind: 'mock ' + sd, ok: m.ok, fails: m.fails, summary: m.summary });
        });
        track.dispose();
      });
      return out;
    })()`);
    const apiOk = res.api.createPit === 'function' && res.api.serviceTime === 'function' && res.api.moduleLeak === 'undefined' &&
      res.api.pitKeys === 'state,reset,update';
    console.log((apiOk ? 'PASS ' : 'FAIL ') + 'window.F1.createPit in the page  ' + JSON.stringify(res.api));
    if (!apiOk) failed++;
    console.log((res.errors.length ? 'FAIL ' : 'PASS ') + 'no script errors  ' + JSON.stringify(res.errors));
    if (res.errors.length) failed++;
    res.runs.forEach(r => {
      console.log((r.ok ? 'PASS ' : 'FAIL ') + r.id + ' ' + r.kind + '  ' + (r.summary || '') + (r.ok ? '' : '  ' + r.fails.join(' | ')));
      if (!r.ok) failed++;
    });
  } catch (e) {
    console.log('FAIL ' + (e && e.stack || e));
    failed++;
  }
  clearTimeout(kill);
  console.log(failed ? failed + ' FAILED' : 'all ok');
  w.destroy();
  app.exit(failed ? 1 : 0);
});
