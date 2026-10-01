// Review probe: js/ui.js + index.html in Electron without main.js (the ui-v6 harness page, which has a <base> to the
// project): hostile strings through every text path (player names, team / car names, colours, track names, toasts),
// UI states that can stick, the telemetry canvas under a DPR change and a window resize, HUD per-frame DOM work.
//   npx electron devtests/review-1/sound-graphics/probe-ui.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
require('../../electron-userdata')(app, 'review-ui');
const PAGE = path.join(__dirname, '..', '..', 'ui-v6', 'out', 'page.html');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e, level, msg, line, src) => { if (level >= 2 && msg.indexOf('Security Warning') < 0) console.log('[console]', msg, (src || '').split('/').pop() + ':' + line); });
  await w.loadFile(PAGE);
  const js = (code) => w.webContents.executeJavaScript(code, false);
  try {
    const r = await js(`(function () {
      var out = {}, ui = F1.ui, X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">', Y = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">';
      window.__xss = 0;
      ui.init({ onSelectTrack: function () {}, onExitToMenu: function () {} });
      ui.showMenu([{ id: 'a', name: X, location: X, lengthKm: 5.8, points: [[0, 0], [100, 0], [100, 100]] }]);
      ui.setNet({ connected: true, isHost: true, hostInfo: { port: 24500, addresses: [X] }, roster: [{ name: X, colour: Y, best: 80, isHost: true, isSelf: true }], status: X, statusKind: Y });
      ui.setGp({ phase: 'results', online: true, canControl: true, taking: true, q: 3, r: 5, wear: 2, year: 2024, pos: 1, count: 2, done: true, sid: 1,
        rows: [{ pos: 1, id: 1, name: X, colour: Y, colour2: Y, team: X, isSelf: true, laps: 5, best: 80, time: 400, gap: 0, down: 0, done: true },
               { pos: 2, id: 2, name: X, colour: '#ff0000', colour2: X, team: X, laps: 5, best: 81, time: 401, gap: 1, down: 0, done: true }],
        spectators: [{ id: 3, name: X, colour: Y }], canStart: true, startHint: X });
      ui.setCars({ year: 2024, selected: 'a-1', canPickYear: true, canPickCar: true, seasons: [{ year: 2024, label: X, engine: X, count: 1 }],
        cars: [{ id: 'a-1', team: X, teamZh: X, car: X, engine: X, colour: Y, colour2: Y, note: X, ratings: { topSpeed: 50 }, ers: {} },
               { id: Y, team: 'bad-id', car: 'x', colour: '#000000' }] });
      ui.setPit({ inLane: true, limiter: false, speeding: true, limitKmh: X, slot: X, boxAhead: 12, service: null, pending: 3 });
      ui.toast(X, 100000);
      ui.setTrack({ name: X, points: [[0, 0], [10, 0]] });
      ui.setLights(3, false, true);
      out.imgCount = document.querySelectorAll('img').length;
      out.styleAttrs = [].slice.call(document.querySelectorAll('[style]')).map(function (e) { return e.getAttribute('style'); }).filter(function (s) { return s.indexOf('onerror') >= 0 || s.indexOf('<') >= 0; });
      out.xssRuns = window.__xss;
      out.badCardIds = [].slice.call(document.querySelectorAll('#car-list .car-card')).map(function (e) { return e.getAttribute('data-id'); });
      out.pitLimitText = document.getElementById('hud-pit-limit').textContent;
      out.pitBoxText = document.getElementById('hud-pit-box').textContent;
      out.resultsHasTable = !!document.querySelector('#gp-results table');
      // pending dim state after a year change that never gets answered
      var sel = document.getElementById('car-year');
      out.yearOptions = sel.options.length;
      return out;
    })()`);
    console.log('xss / text paths:', JSON.stringify(r, null, 1));
    // a second look after the images (if any) had time to fire
    await new Promise(r => setTimeout(r, 500));
    console.log('xss handlers fired later:', await js('window.__xss'));

    // ---- UI stuck states ----
    const s = await js(`(function () {
      var out = {}, ui = F1.ui;
      ui.setCars({ year: 2024, selected: 'a-1', canPickYear: true, canPickCar: true, seasons: [{ year: 2024 }, { year: 2023 }], cars: [{ id: 'a-1', team: 'T', car: 'C', colour: '#ff0000' }] });
      var sel = document.getElementById('car-year');
      sel.value = '2023'; sel.dispatchEvent(new Event('change'));
      out.pendingAfterYearChange = document.getElementById('car-list').classList.contains('pending');
      // the host refuses / nothing answers: is the list dim for ever?
      ui.setGp({ phase: 'free', rows: [] });
      out.pendingStillAfterSetGp = document.getElementById('car-list').classList.contains('pending');
      // results overlay: close it, then the same session again -> stays closed (by design); a new sid -> reopens
      ui.setGp({ phase: 'results', sid: 7, canControl: true, rows: [{ pos: 1, id: 1, name: 'a', colour: '#ff0000', done: true, time: 10, best: 5 }] });
      document.getElementById('gp-close').click();
      out.resHiddenAfterClose = document.getElementById('gp-results').classList.contains('hidden');
      ui.setGp({ phase: 'results', sid: 7, canControl: true, rows: [] });
      out.resStaysClosedSameSid = document.getElementById('gp-results').classList.contains('hidden');
      ui.setGp({ phase: 'results', sid: 8, canControl: true, rows: [] });
      out.resReopensNewSid = !document.getElementById('gp-results').classList.contains('hidden');
      // lights: hidden -> 3 -> go -> hidden
      ui.setLights(-1); ui.setLights(5, false, false); ui.setLights(0, true, false);
      out.goText = document.getElementById('hud-lights-text').textContent;
      ui.setLights(-1);
      out.lightsHidden = document.getElementById('hud-lights').classList.contains('hidden');
      // toast over the menu then hideMenu: still visible?
      ui.toast('hi', 5000); ui.hideMenu();
      out.toastVisibleAfterHideMenu = !document.getElementById('hud-toast').classList.contains('hidden');
      return out;
    })()`);
    console.log('states:', JSON.stringify(s, null, 1));

    // ---- HUD per-frame DOM work: count DOM mutations over 300 updateHUD frames with a steady state ----
    const m = await js(`(function () {
      var ui = F1.ui, muts = 0;
      var mo = new MutationObserver(function (list) { muts += list.length; });
      mo.observe(document.getElementById('hud'), { subtree: true, childList: true, characterData: true, attributes: true });
      var h = { speedKmh: 200, gear: 5, rpm: 9000, rpmIdle: 4000, rpmShift: 11800, rpmMax: 12500, throttle: 1, brake: 0, battery: 0.5, deploy: 0, harvest: 0, limiter: false, inPit: false, limitKmh: 80,
        tyres: { compound: 'M', wear: [0.1, 0.1, 0.1, 0.1], flat: [0, 0, 0, 0], puncture: -1 }, team: 'T', car: 'C', colour: '#ff0000', lap: 2, lapTotal: 5, curTime: 12.345, lastTime: 80, bestTime: 80, x: 0, z: 0, heading: 0, others: null };
      for (var i = 0; i < 300; i++) { h.curTime += 1 / 60; ui.updateHUD(h); ui.setPit({ inLane: true, limiter: true, limitKmh: 80, slot: 3, boxAhead: 100 - i * 0.1 }); }
      return { mutationsPer300Frames: muts };
    })()`);
    console.log('hud dom work:', JSON.stringify(m));

    // ---- telemetry canvas: resize and DPR ----
    const t1 = await js(`(function () { var c = document.getElementById('hud-telemetry'); return { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, dpr: devicePixelRatio }; })()`);
    w.setSize(1920, 1080);
    await new Promise(r => setTimeout(r, 400));
    await js(`F1.ui.updateHUD({ speedKmh: 100, gear: 3 })`);
    const t2 = await js(`(function () { var c = document.getElementById('hud-telemetry'); return { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, dpr: devicePixelRatio }; })()`);
    w.webContents.setZoomFactor(1.5);
    await new Promise(r => setTimeout(r, 400));
    await js(`F1.ui.updateHUD({ speedKmh: 100, gear: 3 })`);
    const t3 = await js(`(function () { var c = document.getElementById('hud-telemetry'); return { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, dpr: devicePixelRatio }; })()`);
    console.log('telemetry backing store: 1280 ->', JSON.stringify(t1), ' 1920 ->', JSON.stringify(t2), ' zoom 1.5 ->', JSON.stringify(t3));
  } catch (e) { console.log('ERR', e.stack || e.message); }
  app.exit(0);
});
