// UI harness for the Grand Prix / gamepad parts of js/ui.js + index.html.
// Loads the real index.html in an offscreen Electron window, feeds F1.ui.setGp / setLights / setPad / updateHUD
// with mock GpView objects, writes PNG screenshots to devtests/ui-gp/out/ and runs layout + behaviour checks.
//   npx electron devtests/ui-gp/shots.js          (env ONLY=menu|hud|checks|real|init to run a part, TRACK=monza)
// Part "real" drives the page's own F1.gp (offline session) through a whole Grand Prix and feeds its view() to the UI.
// Part "init" loads the page WITHOUT js/main.js and calls F1.ui.init itself with an onProfile callback that uses the whole
// API at once (init order). env UI=path/to/other-ui.js runs that part against another build of js/ui.js (a mutant).
// v6 (2026-10-01): the corner speed / gear box is gone (the telemetry canvas #hud-telemetry sits at the bottom centre and
// the key hint moved to the bottom right), the side panel has tabs (大獎賽 is the default one), onGpStart carries the tyre
// wear and 'f1drive.gp' stores it; the v6 parts themselves are checked by devtests/ui-v6/shots.js.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), url = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const ONLY = process.env.ONLY || '';
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const UI = process.env.UI ? path.resolve(process.env.UI) : '';
// a throw-away userData dir, and every window muted (offscreen, but Web Audio reaches the speakers; SOUND=1 to hear it)
require('../electron-userdata')(app, 'ui-gp');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}

/* ---------- mock views ---------- */
const COLOURS = ['#ff7a14', '#e10600', '#1e6bff', '#19c8e6', '#35d07f', '#ffd21e', '#c04bff', '#f2f4f7'];
const NAMES = ['Max 維斯塔潘', '車手417', 'Lewis', 'Charles Leclerc16', '小明', 'Fernando_Alonso!', '阿土伯', 'Yuki 角田',
  'A', '<b>x</b><img src=x>', '王大明王大明王大明王大明王大明王', 'Oscar', 'Lando', 'George R.', 'Checo', 'Nico H'];
const driver = i => ({ id: i + 1, name: NAMES[i], colour: COLOURS[i % COLOURS.length] });
const row = (i, selfIdx, o) => Object.assign({ pos: i + 1, isSelf: i === selfIdx, laps: 0, best: null, time: null, gap: null, down: 0,
  done: false, dnf: false, left: false }, driver(i), o);
const base = o => Object.assign({ phase: 'free', online: false, canControl: true, taking: false, spectating: false, q: 3, r: 5,
  lap: 0, lapTotal: 0, pos: 0, count: 0, done: false, endsInMs: null, rows: [], spectators: [], canStart: true, startHint: '' }, o);

const V = {
  freeNoTrack: base({ canStart: false, startHint: '先選一條賽道' }),
  freeTrack: base({}),
  freeHost: base({ online: true }),
  freeHostNoTrack: base({ online: true, canStart: false, startHint: '先幫房間選一條賽道' }),
  freeGuest: base({ online: true, canControl: false, canStart: false }),
  quali3: o => base(Object.assign({ phase: 'quali', online: true, taking: true, lap: 1, lapTotal: 3, pos: 2, count: 3, rows: [
    row(0, 1, { laps: 3, best: 83.456, done: true }), row(1, 1, { laps: 1, best: 84.012 }), row(2, 1, { laps: 0 })] }, o)),
  qualiSolo: base({ phase: 'quali', taking: true, lap: 0, lapTotal: 3, pos: 1, count: 1, rows: [row(1, 1, {})] }),
  grid3: base({ phase: 'grid', online: true, taking: true, lap: 0, lapTotal: 5, pos: 2, count: 3, rows: [
    row(0, 1, { laps: 3, best: 83.456, done: true }), row(1, 1, { laps: 3, best: 84.012, done: true }), row(2, 1, { laps: 3, best: 91.5, done: true })] }),
  race8: o => base(Object.assign({ phase: 'race', online: true, taking: true, lap: 2, lapTotal: 5, pos: 3, count: 8, rows: [
    row(0, 2, { laps: 2, best: 83.456 }), row(1, 2, { laps: 2, best: 83.9, gap: 0.482 }), row(2, 2, { laps: 2, best: 84.2, gap: 1.234 }),
    row(3, 2, { laps: 2, best: 84.0, gap: 3.05 }), row(4, 2, { laps: 2, best: 85.1, gap: 12.345 }), row(5, 2, { laps: 2, best: 86.7, gap: 27.9 }),
    row(6, 2, { laps: 1, best: 99.1, gap: 75.25 }), row(7, 2, { laps: 1, best: 120.4, down: 1 })] }, o)),
  race16: o => {
    const rows = [];
    for (let i = 0; i < 16; i++) {
      const r = { laps: 4, best: 83.4 + i * 0.37, gap: i * 2.137 };
      if (i === 0) { r.laps = 5; r.done = true; r.time = 431.234; r.gap = null; r.best = 84.9; }
      if (i === 1) { r.laps = 5; r.done = true; r.time = 432.468; r.gap = 1.234; }
      if (i === 2) { r.best = 82.901; }
      if (i === 11) { r.gap = 62.345; }
      if (i === 12) { r.laps = 3; r.gap = null; r.down = 1; }
      if (i === 13) { r.laps = 2; r.gap = null; r.down = 2; }
      if (i === 14) { r.laps = 2; r.gap = null; r.dnf = true; }
      if (i === 15) { r.laps = 1; r.gap = null; r.dnf = true; r.left = true; r.colour = '#888888'; }
      rows.push(row(i, 4, r));
    }
    return base(Object.assign({ phase: 'race', online: true, taking: true, lap: 4, lapTotal: 5, pos: 5, count: 16, endsInMs: 83000, rows,
      spectators: [{ id: 40, name: '晚到的小華', colour: '#19c8e6' }, { id: 41, name: 'Late <i>Joiner</i>', colour: '#35d07f' }] }, o));
  },
  results16: o => {
    const rows = [];
    for (let i = 0; i < 16; i++) {
      const r = { laps: 5, best: 83.4 + i * 0.37, done: true, time: 431.234 + i * 2.137, gap: i ? i * 2.137 : null };
      if (i === 2) r.best = 82.901;
      if (i === 11) { r.gap = 62.345; r.time = 493.579; }
      if (i === 12) { r.laps = 4; r.gap = null; r.down = 1; r.time = 470.1; }
      if (i === 13) { r.laps = 3; r.gap = null; r.down = 2; r.time = 455.9; }
      if (i === 14) { r.laps = 2; r.gap = null; r.done = false; r.time = null; }
      if (i === 15) { r.laps = 1; r.gap = null; r.done = false; r.time = null; r.dnf = true; r.left = true; r.colour = '#888888'; }
      rows.push(row(i, 4, r));
    }
    return base(Object.assign({ phase: 'results', online: true, taking: true, lap: 5, lapTotal: 5, pos: 5, count: 16, done: true, rows,
      spectators: [{ id: 40, name: '晚到的小華', colour: '#19c8e6' }, { id: 41, name: 'Late <i>Joiner</i>', colour: '#35d07f' }] }, o));
  },
  resultsSolo: base({ phase: 'results', taking: true, lap: 5, lapTotal: 5, pos: 1, count: 1, done: true,
    rows: [row(1, 1, { pos: 1, laps: 5, best: 83.456, done: true, time: 431.234 })] })
};
const roster = n => { const a = []; for (let i = 0; i < n; i++) a.push(Object.assign(driver(i), { best: i % 3 ? 83.4 + i : null, isHost: i === 0, isSelf: i === 1 })); return a; };
const NET = {
  off: { canCreate: true, connected: false, busy: false, isHost: false, hostInfo: null, roster: [], status: '', statusKind: '', lockText: '' },
  host: n => ({ canCreate: true, connected: true, busy: false, isHost: true, hostInfo: { port: 24500, addresses: ['192.168.1.23'] },
    roster: roster(n).map((p, i) => Object.assign(p, { isHost: i === 1 })), status: '房間已建立，你是房主。選一條賽道開始。', statusKind: 'ok', lockText: '' }),
  guest: n => ({ canCreate: true, connected: true, busy: false, isHost: false, hostInfo: null, roster: roster(n), status: '已加入房間。', statusKind: 'ok', lockText: '' })
};

/* ---------- page helpers ---------- */
const PAGE_SETUP = `(function () {
  var ui = F1.ui;
  // keep the originals for the harness and cut main.js off from the parts under test (once it is wired it
  // calls setLights every frame and setGp on every change, which would overwrite the mock state)
  window.__ui = { setGp: ui.setGp, setLights: ui.setLights, setPad: ui.setPad, setNet: ui.setNet, updateHUD: ui.updateHUD };
  ui.setGp = function () {}; ui.setLights = function () {}; ui.setPad = function () {}; ui.setNet = function () {};
  ui.updateHUD = function (h) {
    var o = window.__hud;
    if (o) { var c = {}, k; for (k in h) c[k] = h[k]; for (k in o) c[k] = o[k]; h = c; }
    return window.__ui.updateHUD(h);
  };
  window.__rect = function (id) {
    var e = typeof id === 'string' ? document.getElementById(id) : id;
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
      shown: r.width > 0 && r.height > 0, sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight };
  };
  // overlap in px^2 of two shown elements (0 when either is hidden)
  window.__overlap = function (a, b) {
    var p = __rect(a), q = __rect(b);
    if (!p || !q || !p.shown || !q.shown) return 0;
    var w = Math.min(p.r, q.r) - Math.max(p.x, q.x), h = Math.min(p.b, q.b) - Math.max(p.y, q.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  // every standings row: is anything cut off / squeezed?
  window.__rows = function (sel) {
    var bad = [], rows = document.querySelectorAll(sel);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], name = row.querySelector('.mp-pname'), val = row.querySelector('.gp-val, .c-gap');
      if (row.scrollWidth > row.clientWidth + 1) bad.push(i + ': row overflows ' + row.scrollWidth + ' > ' + row.clientWidth);
      if (name && name.getBoundingClientRect().width < 40) bad.push(i + ': name only ' + Math.round(name.getBoundingClientRect().width) + 'px');
      if (val && val.scrollWidth > val.clientWidth + 1) bad.push(i + ': value cut');
    }
    return { n: rows.length, bad: bad };
  };
  return true;
})()`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const consoleErrors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level >= 2 && msg.indexOf('Electron Security Warning') >= 0) return;   // dev-only CSP notice
    if (level >= 2) { consoleErrors.push(msg); console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line); }
  });
  const js = code => w.webContents.executeJavaScript(code);
  const shot = async n => { await sleep(180); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const size = async (W, H) => { w.setContentSize(W, H); await sleep(450); return js('[innerWidth, innerHeight]'); };
  const setGp = v => js(`__ui.setGp(${JSON.stringify(v)})`);
  const setNet = v => js(`__ui.setNet(${JSON.stringify(v)})`);
  const rect = id => js(`__rect(${JSON.stringify(id)})`);
  const load = async () => {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(900);
    const err = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    // the error overlay would cover every screenshot: report it, then hide it (harness only)
    if (err) await js(`document.getElementById('error').classList.add('hidden')`);
    await js(PAGE_SETUP);
    return err;
  };
  const mouseClick = async id => {
    const r = await rect(id);
    const x = Math.round((r.x + r.r) / 2), y = Math.round((r.y + r.b) / 2);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };

  try {
    const bootErr = await load();
    check('page boots without the error overlay', !bootErr, bootErr || undefined);
    const order = await js(`[].slice.call(document.querySelectorAll('script[src]')).map(function (s) { return s.getAttribute('src'); }).join(' ')`);
    check('script order matches the contract', order === 'lib/three.min.js tracks-data.js js/seasons-data.js js/cars.js js/track.js js/tyres.js js/car.js ' +
      'js/cockpit.js js/gamepad.js js/audio.js js/raceline.js scenery-data.js js/scenery.js js/collide.js js/carmodel.js js/laps.js js/pit.js ' +
      'net/session.js js/net.js js/gp.js js/telemetry.js js/ui.js js/main.js', order);
    check('ui API present', await js(`['setGp','setLights','setPad','updateHUD','setNet','toast','showMenu','hideMenu'].every(function (k) { return typeof F1.ui[k] === 'function'; })`));

    /* ================= menu ================= */
    if (!ONLY || ONLY === 'menu') {
      await size(1280, 720);
      await setNet(NET.off);
      await setGp(V.freeNoTrack);
      await shot('menu-1280-offline-notrack');
      check('offline, no track: start disabled + hint', await js(`document.getElementById('gp-start').disabled && document.getElementById('gp-hint').textContent === '先選一條賽道' && !document.getElementById('gp-hint').classList.contains('hidden')`));
      await setGp(V.freeTrack);
      await shot('menu-1280-offline-track');
      check('offline, track loaded: start enabled, no hint', await js(`!document.getElementById('gp-start').disabled && document.getElementById('gp-hint').classList.contains('hidden')`));
      check('menu has no horizontal overflow (1280)', await js(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('mp-panel').scrollWidth <= document.getElementById('mp-panel').clientWidth`),
        await rect('mp-panel'));
      const heads = await js(`[__rect(document.querySelector('.menu-head')), __rect(document.querySelector('.hints')), __rect('keys-pad')]`);
      check('menu head: controller hints on one line at 1280', heads[2].h <= 26, heads);
      await js(`__ui.setPad(true, 'Xbox 360 Controller (XInput STANDARD GAMEPAD)')`);
      await shot('menu-1280-pad-connected');
      const padRow = await js(`({ row: __rect('keys-pad'), tag: __rect('pad-status'), title: document.getElementById('pad-status').title, W: innerWidth })`);
      check('menu: pad connected tag shown, still one line, inside the window', padRow.tag.shown && padRow.row.h <= 26 && padRow.row.r <= padRow.W - 16 && /Xbox/.test(padRow.title), padRow);
      await js(`__ui.setPad(false, '')`);
      check('menu: pad tag hidden again', !(await rect('pad-status')).shown);

      // a toast while the menu is open: its own layer at the bottom of the window, above the menu
      const menuToast = async tag => {
        await js(`F1.ui.toast('車手417 加入了房間', 60000)`);
        await shot('menu-' + tag + '-toast');
        const t = await js(`(function () { var e = document.getElementById('hud-toast'), r = __rect(e), cs = getComputedStyle(e);
          return { r: r, text: e.textContent, W: innerWidth, H: innerHeight, z: Number(cs.zIndex), menuZ: Number(getComputedStyle(document.getElementById('menu')).zIndex),
            inHud: !!e.closest('#hud'), hudShown: __rect('hud').shown, events: cs.pointerEvents, cut: e.scrollWidth > e.clientWidth + 1 }; })()`);
        check(tag + ' menu: toast visible over the menu (bottom, inside the window, above the menu layer, click-through)', t.r.shown && !t.hudShown && !t.inHud && t.z > t.menuZ && t.events === 'none' &&
          t.r.y > t.H / 2 && t.r.b <= t.H - 8 && t.r.x >= 8 && t.r.r <= t.W - 8 && Math.abs((t.r.x + t.r.r) / 2 - t.W / 2) <= 1 && !t.cut && t.text === '車手417 加入了房間',
          { rect: t.r.x + ',' + t.r.y + ' ' + t.r.w + 'x' + t.r.h, of: t.W + 'x' + t.H, z: t.z, menuZ: t.menuZ, events: t.events });
        await js(`F1.ui.toast('')`);
        check(tag + ' menu: toast("") hides it', !(await rect('hud-toast')).shown);
      };
      await menuToast('1280');

      await setNet(NET.host(3)); await setGp(V.freeHost);
      await shot('menu-1280-host-free');
      check('host: start enabled + room hint', await js(`!document.getElementById('gp-start').disabled && /所有人/.test(document.getElementById('gp-hint').textContent)`));
      await setGp(V.freeHostNoTrack);
      check('host without a track: start disabled, startHint shown', await js(`document.getElementById('gp-start').disabled && document.getElementById('gp-hint').textContent === '先幫房間選一條賽道'`));
      await setNet(NET.guest(3)); await setGp(V.freeGuest);
      await shot('menu-1280-guest-free');
      check('guest: no Q / R / start, told that the host starts it', await js(`__rect('gp-setup').shown === false && /房主/.test(document.getElementById('gp-hint').textContent)`),
        await js(`document.getElementById('gp-hint').textContent`));

      await setNet(NET.host(3)); await setGp(V.quali3({}));
      await shot('menu-1280-host-quali3');
      check('host in quali: skip + end shown, again hidden, setup hidden', await js(`__rect('gp-skip').shown && __rect('gp-end').shown && !__rect('gp-again').shown && !__rect('gp-setup').shown`));
      await setNet(NET.guest(8)); await setGp(V.race8({ canControl: false }));
      await shot('menu-1280-guest-race8');
      check('guest in race: no action buttons', await js(`!__rect('gp-actions').shown && __rect('gp-standings').shown`));
      await setNet(NET.host(16)); await setGp(V.race16({}));
      await shot('menu-1280-host-race16');
      check('menu standings rows fit (race 16)', (await js(`__rows('#gp-standings .gp-row')`)).bad.length === 0, await js(`__rows('#gp-standings .gp-row')`));
      await setGp(V.results16({}));
      await shot('menu-1280-host-results16');
      check('host in results: again + end shown, skip hidden', await js(`__rect('gp-again').shown && __rect('gp-end').shown && !__rect('gp-skip').shown`));
      check('menu standings rows fit (results 16, with best lap)', (await js(`__rows('#gp-standings .gp-row')`)).bad.length === 0, await js(`__rows('#gp-standings .gp-row')`));
      check('menu panel: no horizontal overflow with 16 drivers', await js(`document.getElementById('mp-panel').scrollWidth <= document.getElementById('mp-panel').clientWidth`));
      check('names are escaped (no element injected from a name)', await js(`!document.querySelector('#gp-standings img, #gp-standings b, #gp-spec i, #hud-gp img, #gp-results img, #gp-results-spec i')`));
      await js(`document.getElementById('mp-panel').scrollTop = 99999`);
      await shot('menu-1280-host-results16-scrolled');
      await js(`document.getElementById('mp-panel').scrollTop = 0`);

      await size(1920, 1080);
      await shot('menu-1920-host-results16');
      await setNet(NET.off); await setGp(V.freeTrack);
      await shot('menu-1920-offline-track');

      await menuToast('1920');
      const narrow = await size(700, 720);
      await shot('menu-700-offline-track');
      await menuToast('700');
      await js(`F1.ui.toast('這是一則很長很長的訊息，用來確認提示在很窄的視窗裡會自動換行而不會超出畫面：連線中斷，已回到單人模式', 60000)`);
      await shot('menu-700-toast-long');
      const lt = await js(`({ r: __rect('hud-toast'), W: innerWidth, H: innerHeight })`);
      check('narrow menu: a long toast wraps and stays inside the window', lt.r.shown && lt.r.x >= 8 && lt.r.r <= lt.W - 8 && lt.r.b <= lt.H - 8 && lt.r.h > 44, lt.r);
      await js(`F1.ui.toast('')`);
      check('narrow menu: no horizontal overflow', await js(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('menu').scrollWidth <= innerWidth`), narrow);
      await setNet(NET.host(16)); await setGp(V.results16({}));
      await shot('menu-700-host-results16');
      check('narrow menu rows fit', (await js(`__rows('#gp-standings .gp-row')`)).bad.length === 0, await js(`__rows('#gp-standings .gp-row')`));
      await js(`document.querySelector('.menu-main').scrollTop = 900`);
      await shot('menu-700-host-results16-scrolled');
      await js(`document.querySelector('.menu-main').scrollTop = 0`);
      await setNet(NET.off); await setGp(V.freeNoTrack);
      await size(1280, 720);
    }

    /* ================= HUD ================= */
    if (!ONLY || ONLY === 'hud') {
      await size(1280, 720);
      await setNet(NET.off); await setGp(V.freeTrack);
      const clicked = await js(`(function () {
        var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${JSON.stringify(TRACK)}) >= 0; })[0];
        if (!c) return 'no card'; c.click(); return c.querySelector('.card-name').textContent; })()`);
      await sleep(1800);
      let driving = await js(`!document.getElementById('hud').classList.contains('hidden')`);
      check('track loads and the HUD shows (' + clicked + ')', driving, await js(`document.getElementById('error-text').textContent`));
      if (!driving) { await js(`document.getElementById('error').classList.add('hidden'); F1.ui.hideMenu()`); }

      const hudShots = async tag => {
        // free, in a room: the roster box as before
        await setNet(NET.guest(5)); await setGp(V.freeGuest); await js(`window.__hud = { lap: 2, lapTotal: null }`);
        await shot('hud-' + tag + '-free-roster');
        check(tag + ' free: roster box shown, session box hidden, lap row "2"', await js(`__rect('hud-players').shown && !__rect('hud-gp').shown && document.getElementById('hud-lap').textContent === '2'`));

        await setNet(NET.guest(3)); await setGp(V.quali3({ canControl: false })); await js(`window.__hud = { lap: 2, lapTotal: 3 }`);
        await shot('hud-' + tag + '-quali3');
        check(tag + ' quali: session box replaces the roster box, lap row "2 / 3"', await js(`!__rect('hud-players').shown && __rect('hud-gp').shown && document.getElementById('hud-lap').textContent === '2 / 3'`),
          await js(`document.getElementById('hud-gp').innerText.replace(/\\s+/g, ' ')`));
        await setGp(V.quali3({ canControl: false, done: true, lap: 3, pos: 1, rows: [row(1, 1, { laps: 3, best: 83.012, done: true }),
          row(0, 1, { laps: 3, best: 83.456, done: true }), row(2, 1, { laps: 1, best: 95.2 })].map((r, i) => Object.assign(r, { pos: i + 1 })) }));
        await js(`__ui.setPad(true, 'Xbox 360 Controller (XInput STANDARD GAMEPAD)')`);
        await shot('hud-' + tag + '-quali3-done-pad');
        check(tag + ' pad connected: HUD hint shows controller wording', await js(`__rect('hud-hint-pad').shown && !__rect('hud-hint-keys').shown && /RT/.test(document.getElementById('hud-hint').innerText)`));
        await js(`__ui.setPad(false, '')`);
        check(tag + ' pad gone: keyboard wording back', await js(`!__rect('hud-hint-pad').shown && __rect('hud-hint-keys').shown`));

        await setGp(V.grid3); await js(`window.__hud = { lap: 0, lapTotal: 5 }`);
        await js(`F1.ui.toast('車手417 加入了房間', 60000)`);
        for (const [n, go, name] of [[0, false, 'l0'], [3, false, 'l3'], [5, false, 'l5'], [0, true, 'go']]) {
          await js(`__ui.setLights(${n}, ${go})`);
          await shot('hud-' + tag + '-grid-' + name);
          const st = await js(`({ on: document.querySelectorAll('#hud-lights i.on').length, go: document.getElementById('hud-lights').classList.contains('go'),
            text: document.getElementById('hud-lights-text').textContent, box: __rect('hud-lights'), lamp: __rect(document.querySelector('#hud-lights i')),
            toast: __rect('hud-toast'), map: __rect('hud-map'), timing: __rect('hud-timing'), W: innerWidth })`);
          check(tag + ' lights ' + name, st.on === (go ? 0 : n) && st.go === go && st.text === (go ? 'GO' : '準備起跑') && st.box.shown &&
            st.box.y >= st.toast.b && st.box.x > st.timing.r && st.box.r < st.map.x && Math.abs((st.box.x + st.box.r) / 2 - st.W / 2) <= 1 && st.lamp.w >= 40,
            { on: st.on, go: st.go, text: st.text, box: st.box.x + ',' + st.box.y + ' ' + st.box.w + 'x' + st.box.h, lamp: st.lamp.w });
        }
        // third argument: the viewer only watches the start (spectator)
        for (const [n, go, name, text] of [[4, false, 'l4', '正賽即將起跑'], [0, true, 'go', '正賽開始']]) {
          await js(`__ui.setLights(${n}, ${go}, true)`);
          await shot('hud-' + tag + '-grid-watch-' + name);
          const st = await js(`({ on: document.querySelectorAll('#hud-lights i.on').length, go: document.getElementById('hud-lights').classList.contains('go'),
            watch: document.getElementById('hud-lights').classList.contains('watch'), text: document.getElementById('hud-lights-text').textContent,
            box: __rect('hud-lights'), cap: __rect('hud-lights-text'), toast: __rect('hud-toast'), W: innerWidth,
            colour: getComputedStyle(document.getElementById('hud-lights-text')).color })`);
          check(tag + ' lights for a spectator ' + name + ': caption "' + text + '", fits the box', st.on === (go ? 0 : n) && st.go === go && st.watch && st.text === text && st.box.shown &&
            st.cap.sw <= st.cap.cw + 1 && st.cap.sh <= st.cap.ch + 1 && st.box.y >= st.toast.b && Math.abs((st.box.x + st.box.r) / 2 - st.W / 2) <= 1 && (!go || st.colour === 'rgb(75, 227, 143)'),
            { on: st.on, go: st.go, watch: st.watch, text: st.text, cap: st.cap.sw + '/' + st.cap.cw + ' x ' + st.cap.sh + '/' + st.cap.ch, colour: st.colour });
        }
        await js(`__ui.setLights(2, false)`);
        check(tag + ' lights: back to the driver caption without the third argument', await js(`document.getElementById('hud-lights-text').textContent === '準備起跑' && !document.getElementById('hud-lights').classList.contains('watch')`));
        const tt = await js(`({ r: __rect('hud-toast'), hud: __rect('hud').shown, W: innerWidth })`);
        check(tag + ' HUD: toast at the top, centred', tt.r.shown && tt.hud && tt.r.y === 18 && Math.abs((tt.r.x + tt.r.r) / 2 - tt.W / 2) <= 1, tt.r);
        await js(`__ui.setLights(-1, false); F1.ui.toast('')`);
        check(tag + ' lights hidden with n = -1', !(await rect('hud-lights')).shown);

        for (const [name, view, lapTotal] of [['race8', V.race8({}), 5], ['race16', V.race16({}), 5], ['race16-spectating', V.race16({ taking: false, spectating: true, pos: 0, lap: 0, lapTotal: 0,
          rows: V.race16({}).rows.map(r => Object.assign({}, r, { isSelf: false })) }), null]]) {
          await setNet(NET.guest(view.count)); await setGp(view); await js(`window.__hud = { lap: 3, lapTotal: ${lapTotal} }`);
          await shot('hud-' + tag + '-' + name);
          const st = await js(`({ gp: __rect('hud-gp'), timing: __rect('hud-timing'), hint: __rect('hud-hint'), rows: __rows('#hud-gp .gp-row'),
            tel: __rect('hud-telemetry'), telGp: __overlap('hud-gp', 'hud-telemetry'), hintGp: __overlap('hud-gp', 'hud-hint'), H: innerHeight, text: document.getElementById('hud-gp').innerText.replace(/\\s+/g, ' ') })`);
          check(tag + ' ' + name + ': session box fits (no clipping, clear of timing box and hint)', st.rows.n === view.count && st.rows.bad.length === 0 &&
            st.gp.sh <= st.gp.ch + 1 && st.gp.y >= st.timing.b && !st.hintGp && !st.telGp && st.gp.r < st.tel.x,
            { box: st.gp.y + '..' + st.gp.b + ' of ' + st.H, content: st.gp.sh + '/' + st.gp.ch, timingBottom: st.timing.b, hintOverlap: st.hintGp, telOverlap: st.telGp, bad: st.rows.bad });
          if (name === 'race16') {
            check(tag + ' race16 texts', /P5\s*\/ 16/.test(st.text) && /4 \/ 5/.test(st.text) && /完賽/.test(st.text) && /\+1\.234/.test(st.text) && /\+1:02\.345/.test(st.text) &&
              /\+1 圈/.test(st.text) && /\+2 圈/.test(st.text) && /未完賽 DNF/.test(st.text) && /離線/.test(st.text) && /比賽將在 1:2\d 後結束/.test(st.text) && /觀戰：晚到的小華、Late <i>Joiner<\/i>/.test(st.text), st.text);
          }
          if (name === 'race8') check(tag + ' race8 texts', /正賽/.test(st.text) && /P3\s*\/ 8/.test(st.text) && /領先/.test(st.text) && /\+0\.482/.test(st.text) && /\+1:15\.250/.test(st.text) && /\+1 圈/.test(st.text) && !/後結束/.test(st.text), st.text);
          if (name === 'race16-spectating') check(tag + ' spectating note', /觀戰中/.test(st.text) && !/完成圈數/.test(st.text), st.text);
        }

        await setNet(NET.host(16)); await setGp(V.results16({})); await js(`window.__hud = { lap: 5, lapTotal: 5 }`);
        await shot('hud-' + tag + '-results16-host');
        let st = await js(`({ res: __rect('gp-results'), body: __rect('gp-results-body'), gp: __rect('hud-gp'), W: innerWidth, H: innerHeight,
          rows: document.querySelectorAll('#gp-results tbody tr').length, again: __rect('gp-res-again'), end: __rect('gp-res-end'), close: __rect('gp-close'),
          cut: [].slice.call(document.querySelectorAll('#gp-results td')).filter(function (td) { return td.className !== 'c-name' && td.scrollWidth > td.clientWidth + 1; }).length,
          names: [].slice.call(document.querySelectorAll('#gp-results .mp-pname')).map(function (n) { return n.scrollWidth > n.clientWidth + 1 ? Math.round(n.getBoundingClientRect().width) : 999; }),
          fl: (function () { var f = document.querySelectorAll('#gp-results td.fl'); return f.length ? getComputedStyle(f[0]).color + '|' + f.length : ''; })(),
          text: document.getElementById('gp-results').innerText.replace(/\\s+/g, ' ') })`);
        check(tag + ' results overlay: 16 rows inside the window, no scrolling needed, clear of the session box', st.rows === 16 && st.res.shown && st.res.x >= 0 && st.res.y >= 0 &&
          st.res.r <= st.W && st.res.b <= st.H && st.body.sh <= st.body.ch + 1 && st.cut === 0 && st.res.x >= st.gp.r && Math.min.apply(null, st.names) >= 120 && st.fl === 'rgb(201, 139, 255)|1',
          { res: st.res.x + ',' + st.res.y + ' ' + st.res.w + 'x' + st.res.h, body: st.body.sh + '/' + st.body.ch, gpRight: st.gp.r, minCutName: Math.min.apply(null, st.names), fl: st.fl });
        check(tag + ' results overlay (host): again / end / close shown', st.again.shown && st.end.shown && st.close.shown);
        check(tag + ' results texts', /7:11\.234/.test(st.text) && /\+2\.137/.test(st.text) && /\+1:02\.345/.test(st.text) && /\+1 圈/.test(st.text) && /未完賽 DNF/.test(st.text) && /離線/.test(st.text) && /1:22\.901/.test(st.text), st.text);
        await setNet(NET.guest(16)); await setGp(V.results16({ canControl: false }));
        await shot('hud-' + tag + '-results16-guest');
        st = await js(`({ again: __rect('gp-res-again'), end: __rect('gp-res-end'), close: __rect('gp-close'), note: document.getElementById('gp-results-note').textContent })`);
        check(tag + ' results overlay (guest): only close', !st.again.shown && !st.end.shown && st.close.shown && /房主/.test(st.note), st.note);
        await setNet(NET.off); await setGp(V.resultsSolo);
        await shot('hud-' + tag + '-results-solo');
      };

      await hudShots('1280');
      await size(1920, 1080);
      await hudShots('1920');
      await size(700, 720);
      await setNet(NET.guest(16)); await setGp(V.race16({})); await js(`window.__hud = { lap: 3, lapTotal: 5 }; __ui.setLights(5, false)`);
      await shot('hud-700-race16-lights5');
      let st = await js(`({ gp: __rect('hud-gp'), lights: __rect('hud-lights'), map: __rect('hud-map'), timing: __rect('hud-timing'), hint: __rect('hud-hint'), tel: __rect('hud-telemetry'), hintOver: __overlap('hud-hint', 'hud-telemetry') + __overlap('hud-hint', 'hud-lights') + __overlap('hud-hint', 'hud-map'), W: innerWidth })`);
      check('narrow HUD: session box compact (rows hidden), lights inside the window and clear of the other boxes', st.gp.shown && st.gp.h < 120 && st.lights.x >= 0 && st.lights.r <= st.W &&
        st.lights.y >= st.timing.b && st.lights.y >= st.map.b && st.gp.y >= st.lights.b && !st.hintOver && st.gp.b <= st.tel.y,
        { gp: st.gp.y + '..' + st.gp.b, lights: st.lights.x + '..' + st.lights.r + ' x ' + st.lights.y + '..' + st.lights.b, timingBottom: st.timing.b, mapBottom: st.map.b, hintOverlap: st.hintOver, telTop: st.tel.y });
      await js(`__ui.setLights(-1, false)`);
      await setGp(V.results16({}));
      await shot('hud-700-results16');
      st = await js(`({ res: __rect('gp-results'), W: innerWidth, H: innerHeight, cut: [].slice.call(document.querySelectorAll('#gp-results td')).filter(function (td) { return td.className !== 'c-name' && td.scrollWidth > td.clientWidth + 1; }).length })`);
      check('narrow HUD: results overlay inside the window', st.res.x >= 0 && st.res.r <= st.W && st.res.y >= 0 && st.res.b <= st.H && st.cut === 0, st);
      await size(1280, 560);
      await shot('hud-1280x560-results16');
      st = await js(`({ res: __rect('gp-results'), body: __rect('gp-results-body'), H: innerHeight, close: __rect('gp-close') })`);
      check('short window (560 px): overlay stays inside, table scrolls, buttons visible', st.res.y >= 0 && st.res.b <= st.H && st.close.b <= st.H && st.body.sh > st.body.ch, st);
      await size(1280, 720);
    }

    /* ================= behaviour ================= */
    if (!ONLY || ONLY === 'checks') {
      await size(1280, 720);
      // our own callbacks (replaces main.js's: nothing of the game is needed from here on)
      await js(`window.__calls = []; F1.ui.init({ onGpStart: function (c) { __calls.push(['start', c]); }, onGpAction: function (a) { __calls.push(['action', a]); } });
        F1.ui.showMenu(window.F1_TRACKS); true`);
      const calls = () => js(`JSON.stringify(__calls)`);
      const setField = (id, v) => js(`(function () { var e = document.getElementById(${JSON.stringify(id)}); e.focus(); e.value = ${JSON.stringify(v)};
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);

      await setNet(NET.off); await setGp(V.freeNoTrack);
      await js(`document.getElementById('gp-start').click()`);
      await mouseClick('gp-start');
      check('start disabled: clicking does nothing', (await calls()) === '[]', await calls());
      await setGp(V.freeTrack);
      check('Q / R fields: typed values are clamped', (await setField('gp-q', '7')) === '7' && (await setField('gp-r', '250')) === '99' && (await setField('gp-q', '0')) === '1' &&
        (await setField('gp-q', '-4')) === '1' && (await setField('gp-q', '2.6')) === '3' && (await setField('gp-r', '')) === '99' && (await setField('gp-q', '33')) === '20');
      await setField('gp-q', '4'); await setField('gp-r', '12');
      await mouseClick('gp-start');
      check('start (real mouse click) -> onGpStart({q: 4, r: 12, wear: 1})', (await calls()) === '[["start",{"q":4,"r":12,"wear":1}]]', await calls());
      // typed but not committed (no change event): start still sends the cleaned value
      await js(`__calls.length = 0; var e = document.getElementById('gp-r'); e.value = '500'; e.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('gp-start').click()`);
      check('start cleans an uncommitted value -> {q: 4, r: 99, wear: 1}', (await calls()) === '[["start",{"q":4,"r":99,"wear":1}]]', await calls());
      await setField('gp-q', '6'); await setField('gp-r', '42'); await setField('mp-name', 'UI Tester');
      check('localStorage holds the laps', (await js(`localStorage.getItem('f1drive.gp')`)) === '{"q":6,"r":42,"wear":1}', await js(`localStorage.getItem('f1drive.gp')`));

      await js(`__calls.length = 0`);
      await setGp(V.quali3({}));
      await mouseClick('gp-skip'); await mouseClick('gp-end');
      check('menu: skip / end -> onGpAction', (await calls()) === '[["action","skip"],["action","end"]]', await calls());
      await js(`__calls.length = 0`);
      await setGp(V.results16({}));
      await mouseClick('gp-again');
      check('menu: again -> onGpAction("again")', (await calls()) === '[["action","again"]]', await calls());

      // HUD: results overlay buttons, pointer-events
      await js(`__calls.length = 0; F1.ui.hideMenu()`);
      await sleep(150);
      let hit = await js(`(function () { function at(id, fx, fy) { var r = document.getElementById(id).getBoundingClientRect(); var e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); return e ? (e.id || e.tagName) : null; }
        return { head: at('gp-results', 0.5, 0.04), gpbox: at('hud-gp', 0.5, 0.5), again: at('gp-res-again', 0.5, 0.5), end: at('gp-res-end', 0.5, 0.5), close: at('gp-close', 0.5, 0.5), menuBtn: at('hud-menu-btn', 0.5, 0.5) }; })()`);
      check('HUD is click-through except its buttons', hit.head === 'game' && hit.gpbox === 'game' && hit.again === 'gp-res-again' && hit.end === 'gp-res-end' && hit.close === 'gp-close' && hit.menuBtn === 'hud-menu-btn', hit);
      await mouseClick('gp-res-again'); await mouseClick('gp-res-end');
      check('overlay: again / end -> onGpAction', (await calls()) === '[["action","again"],["action","end"]]', await calls());
      check('overlay buttons do not keep the focus', await js(`document.activeElement === document.body || document.activeElement == null`), await js(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`));
      await mouseClick('gp-close');
      check('close hides the overlay, no callback', !(await rect('gp-results')).shown && (await calls()) === '[["action","again"],["action","end"]]');
      await setGp(V.results16({}));
      check('closed overlay stays closed on the next results update', !(await rect('gp-results')).shown);
      await setGp(V.quali3({})); await setGp(V.results16({}));
      check('overlay is back after a phase change', (await rect('gp-results')).shown);
      await mouseClick('gp-close');
      await setGp(V.results16({ sid: 7 }));
      check('overlay is back when the session id changes', (await rect('gp-results')).shown);
      await setGp(V.freeTrack);
      check('free: overlay and session box hidden', !(await rect('gp-results')).shown && !(await rect('hud-gp')).shown);

      // DOM is only touched on change
      const quiet = await js(`new Promise(function (done) {
        var n = 0, mo = new MutationObserver(function (list) { n += list.length; });
        var view = ${JSON.stringify(V.race16({ endsInMs: null }))};
        __ui.setGp(view); __ui.setLights(3, false);
        mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        for (var i = 0; i < 50; i++) { __ui.setGp(JSON.parse(JSON.stringify(view))); __ui.setLights(3, false); __ui.setPad(false, ''); }
        setTimeout(function () {
          var same = n;
          view.rows[3].gap = 9.999; __ui.setGp(view); __ui.setLights(4, false);
          setTimeout(function () { mo.disconnect(); done({ same: same, changed: n - same }); }, 50);
        }, 50);
      })`);
      check('setGp / setLights / setPad with unchanged input touch no DOM; a change does', quiet.same === 0 && quiet.changed > 0, quiet);
      const quiet2 = await js(`new Promise(function (done) {
        var n = 0, mo = new MutationObserver(function (list) { n += list.length; });
        __ui.setLights(3, false, true);
        mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        for (var i = 0; i < 50; i++) __ui.setLights(3, false, true);
        setTimeout(function () {
          var same = n;
          __ui.setLights(3, false, false);
          setTimeout(function () {
            var caption = n - same;
            __ui.setLights(-1, false, true);
            setTimeout(function () {
              var hide = n - same - caption;
              for (var i = 0; i < 20; i++) { __ui.setLights(-1, false, false); __ui.setLights(-1, false, true); __ui.setLights(-1, false); }
              setTimeout(function () { mo.disconnect(); done({ same: same, caption: caption, hide: hide, hidden: n - same - caption - hide, text: document.getElementById('hud-lights-text').textContent }); }, 50);
            }, 50);
          }, 50);
        }, 50);
      })`);
      check('setLights(n, go, watching): unchanged input touches no DOM; the caption changing does; while hidden the third argument changes nothing',
        quiet2.same === 0 && quiet2.caption > 0 && quiet2.hide > 0 && quiet2.hidden === 0 && quiet2.text === '準備起跑', quiet2);
      await js(`__ui.setLights(-1, false)`);

      // countdown runs between two setGp calls (ticked by updateHUD)
      await setGp(V.race16({ endsInMs: 2400 }));
      const c1 = await js(`document.getElementById('hud-gp-ends').textContent`);
      await sleep(1600);
      await js(`__ui.updateHUD({ speedKmh: 0, gear: 'N', lap: 0, x: 0, z: 0, heading: 0 })`);
      const c2 = await js(`document.getElementById('hud-gp-ends').textContent`);
      check('countdown ticks on its own', c1 === '比賽將在 0:03 後結束' && c2 === '比賽將在 0:01 後結束', [c1, c2]);
      await setGp(V.freeTrack);
      check('lap row: "--" without a lap, "7" beyond the target', await js(`(function () { var e = document.getElementById('hud-lap'), o = [];
        __ui.updateHUD({ speedKmh: 0, gear: 'N', lap: 0, lapTotal: 5, x: 0, z: 0, heading: 0 }); o.push(e.textContent);
        __ui.updateHUD({ speedKmh: 0, gear: 'N', lap: 2, lapTotal: 5, x: 0, z: 0, heading: 0 }); o.push(e.textContent);
        __ui.updateHUD({ speedKmh: 0, gear: 'N', lap: 2, lapTotal: null, x: 0, z: 0, heading: 0 }); o.push(e.textContent);
        __ui.updateHUD({ speedKmh: 0, gear: 'N', lap: 7, lapTotal: 5, x: 0, z: 0, heading: 0 }); o.push(e.textContent);
        return o.join('|'); })()`) === '--|2 / 5|2|7');

      // Q / R survive a reload; junk in storage is sanitised
      const err2 = await load();
      check('reload: Q / R restored from localStorage', (await js(`document.getElementById('gp-q').value + ',' + document.getElementById('gp-r').value`)) === '6,42' && !err2,
        await js(`document.getElementById('gp-q').value + ',' + document.getElementById('gp-r').value`));
      await js(`localStorage.setItem('f1drive.gp', '{"q":"abc","r":1e9}')`);
      await load();
      check('reload with junk in storage: defaults / clamped', (await js(`document.getElementById('gp-q').value + ',' + document.getElementById('gp-r').value`)) === '3,99',
        await js(`document.getElementById('gp-q').value + ',' + document.getElementById('gp-r').value`));
      await js(`localStorage.setItem('f1drive.gp', 'not json')`);
      await load();
      check('reload with corrupt storage: defaults', (await js(`document.getElementById('gp-q').value + ',' + document.getElementById('gp-r').value`)) === '3,5');
      check('the multiplayer store is a separate key and still loads', (await js(`document.getElementById('mp-name').value`)) === 'UI Tester', await js(`localStorage.getItem('f1drive.mp')`));
    }
    /* ================= the real F1.gp, offline, through the UI ================= */
    if (!ONLY || ONLY === 'real') {
      await load();
      await size(1280, 720);
      await js(`[].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${JSON.stringify(TRACK)}) >= 0; })[0].click()`);
      await sleep(1800);
      const ready = await js(`(function () {
        var gp = F1.gp;
        if (!gp || typeof gp.view !== 'function') return 'no F1.gp';
        window.__calls = [];
        F1.ui.init({ onGpStart: function (c) { __calls.push(['start', c, gp.start(c, 5000)]); }, onGpAction: function (a) { __calls.push(['action', a, gp.action(a)]); } });
        gp.init({ net: null, getProfile: F1.ui.getProfile });
        window.__push = function () {
          var v = gp.view(); v.canStart = true; v.startHint = '';
          __ui.setGp(v);
          __ui.setLights(gp.phase === 'grid' || gp.goFlash ? gp.lights : -1, gp.goFlash);
          return gp.phase;
        };
        window.__step = function (dt) { gp.update(dt); return __push(); };
        gp.on('change', __push);
        __push();
        F1.ui.showMenu(window.F1_TRACKS);
        return gp.phase;
      })()`);
      check('real gp: idle offline session, panel ready', ready === 'free' && await js(`!document.getElementById('gp-start').disabled && __rect('gp-setup').shown`), ready);
      const field = (id, v) => js(`(function () { var e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)};
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
      await field('gp-q', '1'); await field('gp-r', '2');
      await mouseClick('gp-start');
      let s = await js(`({ phase: F1.gp.phase, calls: JSON.stringify(__calls), state: document.getElementById('gp-state').innerText, self: document.getElementById('gp-self').innerText,
        setup: __rect('gp-setup').shown, skip: __rect('gp-skip').shown, end: __rect('gp-end').shown, rows: document.querySelectorAll('#gp-standings .gp-row').length })`);
      check('real gp: start button -> quali, menu panel shows the session', s.phase === 'quali' && s.calls === '[["start",{"q":1,"r":2,"wear":1},true]]' && /排位賽/.test(s.state) && /0 \/ 1/.test(s.self) && !s.setup && s.skip && s.end && s.rows === 1, s);
      await shot('real-menu-quali');
      await js(`F1.ui.hideMenu()`);
      await js(`__step(100); F1.gp.lapDone(90); __push()`);
      s = await js(`({ phase: F1.gp.phase, box: document.getElementById('hud-gp').innerText.replace(/\\s+/g, ' '), lights: __rect('hud-lights').shown, on: document.querySelectorAll('#hud-lights i.on').length })`);
      check('real gp: one qualifying lap -> grid, session box + dark lights', s.phase === 'grid' && /起跑/.test(s.box) && /P1\s*\/ 1/.test(s.box) && /1:30\.000/.test(s.box) && s.lights && s.on === 0, s);
      await shot('real-hud-grid');
      const seq = [];
      for (const dt of [4.5, 1, 1, 1, 1.05]) {
        await js(`__step(${dt})`);
        seq.push(await js(`F1.gp.lights + '/' + document.querySelectorAll('#hud-lights i.on').length`));
      }
      check('real gp: the DOM follows gp.lights 1..5', seq.join(' ') === '1/1 2/2 3/3 4/4 5/5', seq);
      await shot('real-hud-lights5');
      let go = null;
      for (let i = 0; i < 12 && !go; i++) {
        await js(`__step(0.25)`);
        const g = await js(`({ flash: F1.gp.goFlash, phase: F1.gp.phase, go: document.getElementById('hud-lights').classList.contains('go'), text: document.getElementById('hud-lights-text').textContent, on: document.querySelectorAll('#hud-lights i.on').length, shown: __rect('hud-lights').shown })`);
        if (g.flash) go = g;
      }
      check('real gp: lights out -> GO', go && go.go && go.text === 'GO' && go.on === 0 && go.shown, go);
      await shot('real-hud-go');
      await js(`__step(2)`);
      s = await js(`({ phase: F1.gp.phase, lights: __rect('hud-lights').shown, box: document.getElementById('hud-gp').innerText.replace(/\\s+/g, ' ') })`);
      check('real gp: race under way, lights gone, session box says 正賽 0 / 2', s.phase === 'race' && !s.lights && /正賽/.test(s.box) && /0 \/ 2/.test(s.box) && /領先/.test(s.box), s);
      await js(`__step(95); F1.gp.lapDone(95); __push()`);
      s = await js(`document.getElementById('hud-gp').innerText.replace(/\\s+/g, ' ')`);
      check('real gp: after one race lap 1 / 2', /1 \/ 2/.test(s), s);
      await shot('real-hud-race');
      await js(`__step(90); F1.gp.lapDone(88); __push()`);
      s = await js(`({ phase: F1.gp.phase, res: __rect('gp-results').shown, text: document.getElementById('gp-results').innerText.replace(/\\s+/g, ' '),
        again: __rect('gp-res-again').shown, end: __rect('gp-res-end').shown, close: __rect('gp-close').shown })`);
      check('real gp: finished -> results overlay with the classification', s.phase === 'results' && s.res && /3:0\d\.\d{3}/.test(s.text) && /1:28\.000/.test(s.text) && s.again && s.end && s.close, s);
      await shot('real-hud-results');
      await js(`__calls.length = 0`);
      await mouseClick('gp-res-again');
      s = await js(`({ phase: F1.gp.phase, calls: JSON.stringify(__calls), res: __rect('gp-results').shown, box: document.getElementById('hud-gp').innerText.replace(/\\s+/g, ' ') })`);
      check('real gp: 再來一場 -> a new qualifying, overlay gone', s.phase === 'quali' && s.calls === '[["action","again",true]]' && !s.res && /排位賽/.test(s.box), s);
      await js(`__calls.length = 0; F1.ui.showMenu(window.F1_TRACKS)`);
      await mouseClick('gp-skip');
      s = await js(`({ phase: F1.gp.phase, calls: JSON.stringify(__calls), state: document.getElementById('gp-state').innerText })`);
      check('real gp: 跳過排位 -> grid', s.phase === 'grid' && s.calls === '[["action","skip",true]]' && /起跑/.test(s.state), s);
      await mouseClick('gp-end');
      s = await js(`({ phase: F1.gp.phase, setup: __rect('gp-setup').shown, session: __rect('gp-session').shown, q: document.getElementById('gp-q').value, r: document.getElementById('gp-r').value,
        start: !document.getElementById('gp-start').disabled, box: __rect('hud-gp').shown })`);
      check('real gp: 結束大獎賽 -> free, setup back with the remembered laps', s.phase === 'free' && s.setup && !s.session && s.q === '1' && s.r === '2' && s.start, s);
      await shot('real-menu-free-again');
    }
    /* ================= init order: a callback fired from inside init() uses the whole API ================= */
    if (!ONLY || ONLY === 'init') {
      // the real page without js/main.js (and, for a mutant run, with another ui.js): nobody has called F1.ui.init yet
      let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      const mainTag = '<script src="js/main.js"></script>', uiTag = '<script src="js/ui.js"></script>';
      if (html.indexOf(mainTag) < 0 || html.indexOf(uiTag) < 0) throw new Error('index.html: script tags not found');
      html = html.replace(mainTag, '');
      if (UI) html = html.replace(uiTag, '<script src="' + url.pathToFileURL(UI).href + '"></script>');
      const page = path.join(OUT, 'index-init.html');
      fs.writeFileSync(page, html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">'));
      await w.loadFile(page);
      await sleep(700);
      await size(1280, 720);
      const r = await js(`(function () {
        var out = { calls: 0, error: '', before: '' };
        var quali = ${JSON.stringify(V.quali3({}))}, race = ${JSON.stringify(V.race8({}))}, net = ${JSON.stringify(NET.host(3))};
        try {
          // before init: nothing may throw (there is no UI yet); the last view / net state is rendered by init
          F1.ui.setGp(quali); F1.ui.setNet(net); F1.ui.setLights(2, false); F1.ui.setPad(true, 'Early Pad'); F1.ui.toast('too early');
        } catch (e) { out.before = String(e && e.stack || e); }
        try {
          F1.ui.init({ onProfile: function (p) {
            out.calls++;
            out.profile = p && typeof p.name === 'string' && /^#[0-9a-f]{6}$/.test(p.colour);
            out.sameAsGetProfile = JSON.stringify(F1.ui.getProfile()) === JSON.stringify(p);
            // what main.js's onProfile does (pushGp -> ui.setGp), and everything else, from INSIDE init
            F1.ui.setGp(race); F1.ui.setNet(net); F1.ui.setLights(3, false, true); F1.ui.setPad(true, 'Init Pad'); F1.ui.toast('在 init 裡面', 60000);
            F1.ui.setResumeHandler(function () {}); F1.ui.showMenu(window.F1_TRACKS);
          } });
        } catch (e) { out.error = String(e && e.stack || e); }
        var id = function (x) { return document.getElementById(x); };
        out.state = id('gp-state').innerText.replace(/\\s+/g, ' ');
        out.rows = document.querySelectorAll('#gp-standings .gp-row').length;
        out.hudRows = document.querySelectorAll('#hud-gp-rows .gp-row').length;
        out.players = document.querySelectorAll('#mp-players li').length;
        out.lamps = document.querySelectorAll('#hud-lights i.on').length;
        out.caption = id('hud-lights-text').textContent;
        out.pad = !id('pad-status').classList.contains('hidden') && id('pad-status').title;
        out.toast = id('hud-toast').textContent + '|' + !id('hud-toast').classList.contains('hidden');
        out.cards = document.querySelectorAll('.card').length;
        out.menu = !id('menu').classList.contains('hidden');
        out.q = id('gp-q').value + ',' + id('gp-r').value;
        out.swatches = document.querySelectorAll('.mp-swatch').length;
        out.name = id('mp-name').value.length > 0;
        return out;
      })()`);
      check('init: API calls before init() do not throw', r.before === '', r.before);
      check('init: onProfile is called once, from inside init(), with the stored profile', r.calls === 1 && r.profile && r.sameAsGetProfile, r);
      check('init: the callback can use setGp / setNet / setLights / setPad / toast / showMenu right away (nothing throws)', r.error === '', r.error);
      check('init: ... and everything it set is on screen', /正賽/.test(r.state) && r.rows === 8 && r.hudRows === 8 && r.players === 3 && r.lamps === 3 && r.caption === '正賽即將起跑' &&
        r.pad === 'Init Pad' && r.toast === '在 init 裡面|true' && r.cards === 40 && r.menu && r.swatches === 8 && r.name && /^\d+,\d+$/.test(r.q), r);
      await shot('init-callback');
      try { fs.unlinkSync(page); } catch (e) {}
    }
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' / ' + results.length + ' checks passed' + (failed.length ? '  FAILED: ' + failed.map(r => r.name).join(' | ') : ''));
  app.exit(failed.length ? 1 : 0);
});
