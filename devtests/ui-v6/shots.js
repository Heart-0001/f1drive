// UI harness for the v6 parts of js/ui.js + index.html (menu tabs, 年份 / 車輛, 輪胎損耗, 設定, telemetry canvas, pit strip).
// main.js is not wired for v6 yet, so the page is the real index.html WITHOUT js/main.js (and without any script file
// that does not exist yet: seasons-data.js / cars.js are other owners'), written to out/page.html with a <base> to the
// project, over a HUD-free game screenshot (bg.png). The harness calls F1.ui itself with the mock data of mock.js,
// saves screenshots to out/ and runs layout + behaviour checks. Part `real` loads the REAL index.html (with the v5
// main.js) and drives a track, to see that the game still boots and the telemetry graphic is drawn from updateHUD.
//   npx electron devtests/ui-v6/shots.js       env ONLY=static,menu,hud,pit,checks,real (comma list), DPR (1), TRACK (monza)
// Exit code 1 on a failed check.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');

const DPR = Number(process.env.DPR) || 1;
app.commandLine.appendSwitch('force-device-scale-factor', String(DPR));
require('../electron-userdata')(app, 'ui-v6');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
const ONLY = process.env.ONLY || '';
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const part = p => !ONLY || ONLY.split(',').indexOf(p) >= 0;
const M = require('./mock');
const J = JSON.stringify;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
}

const CONTRACT_ORDER = ['lib/three.min.js', 'tracks-data.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js',
  'js/cockpit.js', 'js/gamepad.js', 'js/audio.js', 'js/raceline.js', 'scenery-data.js', 'js/scenery.js', 'js/collide.js',
  'js/carmodel.js', 'js/laps.js', 'js/pit.js', 'net/session.js', 'js/net.js', 'js/gp.js', 'js/telemetry.js', 'js/ui.js', 'js/main.js'];
// every id the v6 UI adds (reported to the integrator / end-to-end tests)
const NEW_IDS = ['hud-telemetry', 'hud-pit', 'hud-pit-limit', 'hud-pit-lim', 'hud-pit-warn', 'hud-pit-box', 'hud-pit-pending', 'hud-pit-svc',
  'hud-pit-svc-label', 'hud-pit-svc-time', 'hud-pit-bar', 'hud-pit-pen', 'hud-gp-year', 'menu-tabs', 'tab-car', 'tab-gp', 'tab-mp', 'tab-set',
  'tab-car-chip', 'tab-gp-dot', 'tab-mp-dot', 'car-panel', 'car-year', 'car-season', 'car-lock', 'car-list', 'car-empty', 'gp-panel', 'gp-car',
  'gp-year', 'gp-car-name', 'gp-car-change', 'gp-wear', 'gp-wear-note', 'mp-section', 'set-panel', 'set-volume', 'set-volume-val', 'set-mute',
  'set-mute-text', 'keys-kb', 'keys-pad', 'pad-status'];
const GONE_IDS = ['hud-speedo', 'hud-speed', 'hud-gear'];

/* ---------- the test page: index.html without main.js / missing scripts, over a game screenshot ---------- */
function buildPage() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const stubbed = [];
  html = html.replace(/<script src="([^"]+)"><\/script>\n?/g, (m, src) => {
    if (src === 'js/main.js') return '';
    if (!fs.existsSync(path.join(ROOT, src))) { stubbed.push(src); return ''; }
    return m;
  });
  const bg = path.join(__dirname, 'bg.png');
  if (!fs.existsSync(bg)) {
    const src = path.join(ROOT, 'devtests', '3d-test', 'shot-a.png');
    if (fs.existsSync(src)) fs.copyFileSync(src, bg);
  }
  const style = fs.existsSync(bg) ? '<style>#game { background: #6f8fb4 url("' + url.pathToFileURL(bg).href + '") center / cover no-repeat; }</style>' : '';
  html = html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">').replace('</head>', style + '</head>');
  const page = path.join(OUT, 'page.html');
  fs.writeFileSync(page, html);
  return { page, stubbed };
}

// runs in the page: helpers + a recorder for every callback
const PAGE_LIB = `(function () {
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
  window.__text = function (id) { var e = document.getElementById(id); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null; };
  // DOM mutations caused by fn (synchronously, through takeRecords)
  window.__mut = function (fn) {
    var mo = new MutationObserver(function () {});
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    fn();
    var n = mo.takeRecords().length;
    mo.disconnect();
    return n;
  };
  window.__calls = [];
  window.__init = function () {
    F1.ui.init({
      onSelectTrack: function (t) { __calls.push(['track', t.id]); },
      onGpStart: function (c) { __calls.push(['start', c]); },
      onGpAction: function (a) { __calls.push(['action', a]); },
      onYear: function (y) { __calls.push(['year', y]); },
      onCar: function (id) { __calls.push(['car', id]); },
      onAudio: function (a) { __calls.push(['audio', a]); },
      onProfile: function () {}
    });
    F1.ui.showMenu(window.F1_TRACKS);
    return true;
  };
  // telemetry pixels actually drawn: opaque pixels in the canvas backing store
  window.__telPixels = function () {
    var c = document.getElementById('hud-telemetry'), n = 0;
    if (!c || !c.width || !c.height) return { w: c ? c.width : 0, h: c ? c.height : 0, n: 0 };
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (var i = 3; i < d.length; i += 16) if (d[i] > 128) n++;
    return { w: c.width, h: c.height, n: n };
  };
  return true;
})()`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.setFrameRate(60);
  const consoleErrors = [];
  let realPart = false;
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level >= 2 && msg.indexOf('Electron Security Warning') >= 0) return;
    if (level >= 2 && /willReadFrequently/.test(msg)) return;                  // our own readback of the telemetry canvas
    if (level >= 2 && realPart && /ERR_FILE_NOT_FOUND|Failed to load resource/.test(msg)) return;   // scripts not written yet
    if (level >= 2) { consoleErrors.push(msg); console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line); }
  });
  const js = code => w.webContents.executeJavaScript(code);
  const shot = async n => { await sleep(160); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const size = async (W, H) => { w.setContentSize(W, H); await sleep(420); return js('[innerWidth, innerHeight]'); };
  const rect = id => js(`__rect(${J(id)})`);
  const calls = () => js(`JSON.stringify(__calls)`);
  const mouseClick = async (sel) => {
    const r = await js(`(function () { var e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, hit: !!top && (top === e || e.contains(top)) }; })()`);
    if (!r || !(r.w > 0) || !r.hit) { console.log('click: ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
    return true;
  };
  const { page, stubbed } = buildPage();
  const load = async () => {
    await w.loadFile(page);
    await sleep(600);
    await js(PAGE_LIB);
    await js(`__init()`);
    return js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  };
  const cars = (list, o) => Object.assign({ year: list[0].year, cars: list, selected: list[3].id, canPickYear: true, canPickCar: true, seasons: M.SEASONS }, o);
  const setCars = v => js(`F1.ui.setCars(${J(v)})`);
  const setGp = v => js(`F1.ui.setGp(${J(v)})`);
  const setNet = v => js(`F1.ui.setNet(${J(v)})`);
  const tab = t => js(`document.getElementById('tab-${t}').click()`);
  const L26 = M.list2026(), L12 = M.list2012();

  try {
    console.log('scripts missing on disk (left out of the test page): ' + (stubbed.join(', ') || 'none'));
    /* ================= static: script order, ids ================= */
    if (part('static')) {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      const order = [];
      html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => order.push(src));
      check('index.html: script order is exactly the contract\'s final v6 order', J(order) === J(CONTRACT_ORDER), order.join(' '));
      const ids = [];
      html.replace(/\sid="([^"]+)"/g, (m, id) => ids.push(id));
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      check('index.html: no duplicate ids', dup.length === 0, dup);
      const missing = NEW_IDS.filter(id => ids.indexOf(id) < 0), gone = GONE_IDS.filter(id => ids.indexOf(id) >= 0);
      check('index.html: every new v6 id exists, the old speed / gear box is gone', !missing.length && !gone.length, { missing, gone });
    }

    const bootErr = await load();
    check('test page boots without the error overlay', !bootErr, bootErr || undefined);
    check('ui API: v6 functions present', await js(`['setCars','getCar','getYear','getAudio','setAudio','setPit','setGp','setNet','setLights','setPad','updateHUD','toast'].every(function (k) { return typeof F1.ui[k] === 'function'; })`));

    /* ================= menu ================= */
    if (part('menu')) {
      await size(1280, 720);
      await setNet(M.NET.off); await setGp(M.V.freeTrack);
      check('default tab is 大獎賽 (nothing stored)', await js(`document.getElementById('tab-gp').classList.contains('on') && __rect('gp-panel').shown && !__rect('car-panel').shown && !__rect('mp-section').shown && !__rect('set-panel').shown`));
      // head: key map
      const head = await js(`({ kb: __rect('keys-kb'), pad: __rect('keys-pad'), table: __rect(document.querySelector('.keymap')), head: __rect(document.querySelector('.menu-head')),
        credits: document.querySelector('.brand .credits').textContent, W: innerWidth, hint: document.querySelector('.keymap').innerText.replace(/\\s+/g, ' ') })`);
      check('menu head: key map rows one line each (1280), table inside the window, head not taller than 130 px', head.kb.h <= 26 && head.pad.h <= 26 && head.table.r <= head.W - 16 && head.head.h <= 130,
        { kb: head.kb.h, pad: head.pad.h, tableRight: head.table.r, headH: head.head.h });
      check('menu head: new keys and controller mapping listed', ['限速器', '電池', '換胎配方', '靜音', 'Q', 'E', 'T', 'M', 'LB', 'RB', 'Back'].every(s => head.hint.indexOf(s) >= 0), head.hint);
      check('menu head: F1DB credit next to the OpenStreetMap one', /OpenStreetMap/.test(head.credits) && /F1DB（CC BY 4\.0(，經修改)?）/.test(head.credits), head.credits);
      await js(`F1.ui.setPad(true, 'Xbox Wireless Controller (STANDARD GAMEPAD)')`);
      const padHead = await js(`({ pad: __rect('keys-pad'), tag: __rect('pad-status'), table: __rect(document.querySelector('.keymap')), W: innerWidth })`);
      check('menu head: controller connected tag keeps the row on one line inside the window', padHead.tag.shown && padHead.pad.h <= 26 && padHead.table.r <= padHead.W - 16 && padHead.table.w === head.table.w, padHead);
      await shot('menu-1280-gp-free-pad');
      await js(`F1.ui.setPad(false, '')`);

      // 車輛 tab, offline, 2026
      await setCars(cars(L26));
      await tab('car');
      await shot('menu-1280-cars-2026');
      let st = await js(`({ cards: document.querySelectorAll('#car-list .car-card').length, first: document.querySelector('#car-list .car-card').getAttribute('data-id'),
        on: [].slice.call(document.querySelectorAll('#car-list .car-card.on')).map(function (n) { return n.getAttribute('data-id'); }),
        bars: [].slice.call(document.querySelectorAll('#car-list .car-card')).map(function (n) { return n.querySelectorAll('.car-bar').length; }),
        years: [].slice.call(document.getElementById('car-year').options).map(function (o) { return Number(o.value); }), year: document.getElementById('car-year').value,
        disabled: document.getElementById('car-year').disabled, lock: __rect('car-lock').shown, season: __text('car-season'),
        panel: __rect('mp-panel'), grid: __rect('track-grid'), card0: __rect(document.querySelector('.car-card')), doc: document.documentElement.scrollHeight <= innerHeight,
        chip: __rect('tab-car-chip').shown, text: __text('car-list'), credit: document.querySelector('.car-credit').textContent,
        cols: getComputedStyle(document.getElementById('track-grid')).gridTemplateColumns.split(' ').length })`);
      check('cars 2026: 12 cards, the standard car first, the chosen one (only) highlighted', st.cards === 12 && st.first === '2026-standard' && J(st.on) === J(['2026-mclaren']), st.on);
      check('cars 2026: five rating bars on every card', st.bars.every(n => n === 5), st.bars);
      check('year selector: 17 seasons newest first, 2026 selected, enabled, no lock text', st.years.length === 17 && st.years[0] === 2026 && st.years[16] === 2010 && st.year === '2026' && !st.disabled && !st.lock, st.years);
      check('cars: team zh + en, car, engine, note and ratings on screen; season line', /麥拉倫\s*McLaren/.test(st.text) && /MCL40/.test(st.text) && /Mercedes-AMG F1 M17 E Performance/.test(st.text) &&
        /極速\s*44/.test(st.text) && /季中升級/.test(st.text) && /12 輛車/.test(st.season), st.season);
      check('cars: the estimates line and the F1DB credit in the 車輛 tab', /推估/.test(st.credit) && /F1DB（CC BY 4\.0）/.test(st.credit), st.credit);
      check('1280x720: the list scrolls inside the side panel, the page itself does not; track grid keeps 3 columns', st.panel.sh > st.panel.ch && st.doc && st.cols >= 3 && st.panel.sw <= st.panel.cw,
        { panel: st.panel.sh + '/' + st.panel.ch, cols: st.cols, panelW: st.panel.w });
      check('car tab chip shows the chosen livery', st.chip);
      const cut = await js(`[].slice.call(document.querySelectorAll('.car-card')).filter(function (c) { return c.scrollWidth > c.clientWidth + 1; }).length`);
      check('car cards: nothing overflows sideways', cut === 0, cut);
      await js(`document.getElementById('mp-panel').scrollTop = 99999`);
      await shot('menu-1280-cars-2026-bottom');
      const creditVis = await js(`(function () { var p = __rect('mp-panel'), c = __rect(document.querySelector('.car-credit')); return c.b <= p.b + 1 && c.y >= p.y; })()`);
      check('scrolled to the bottom: the credit line is visible inside the panel', creditVis);
      await js(`document.getElementById('mp-panel').scrollTop = 0`);

      // 2012: no ERS -> 4 bars
      await setCars(cars(L12, { selected: '2012-lotus' }));
      await shot('menu-1280-cars-2012-noers');
      st = await js(`({ bars: [].slice.call(document.querySelectorAll('#car-list .car-card')).map(function (n) { return n.querySelectorAll('.car-bar').length; }),
        text: __text('car-list'), season: __text('car-season'), year: document.getElementById('car-year').value })`);
      check('cars 2012 (no ERS): the 電池 bar is left out on every card', st.bars.length === 12 && st.bars.every(n => n === 4) && !/電池/.test(st.text) && st.year === '2012' && /V8/.test(st.season), { bars: st.bars, season: st.season });

      // host / guest / session
      await setNet(M.NET.host(3)); await setGp(M.V.freeHost);
      await setCars(cars(L26));
      await shot('menu-1280-cars-host');
      await setNet(M.NET.guest(3)); await setGp(M.V.freeGuest);
      await setCars(cars(L26, { canPickYear: false, canPickCar: true, reason: '年份由房主選擇（2026）' }));
      await shot('menu-1280-cars-guest');
      st = await js(`({ dis: document.getElementById('car-year').disabled, lock: __text('car-lock'), locked: document.getElementById('car-list').classList.contains('locked') })`);
      check('guest: year selector disabled with the reason, cars still pickable', st.dis && st.lock === '年份由房主選擇（2026）' && !st.locked, st);
      await setCars(cars(L26, { canPickYear: false, canPickCar: false }));
      await setGp(M.V.quali3({ canControl: false }));
      await tab('car');
      await shot('menu-1280-cars-session-locked');
      st = await js(`({ dis: document.getElementById('car-year').disabled, lock: __text('car-lock'), locked: document.getElementById('car-list').classList.contains('locked') })`);
      check('session: both disabled, default reason 賽事進行中不能換車', st.dis && st.lock === '賽事進行中不能換車' && st.locked, st);
      await tab('gp');
      await shot('menu-1280-gp-session-year');
      st = await js(`({ car: __text('gp-car'), change: __rect('gp-car-change').shown, state: __text('gp-state'), dot: __rect('tab-gp-dot').shown, mpdot: __rect('tab-mp-dot').shown,
        teams: document.querySelectorAll('#gp-standings .gp-team').length, chips: document.querySelectorAll('#gp-standings .gp-chip').length })`);
      check('GP tab in a session: year + car + wear shown, no 換車, tab dots', /2026/.test(st.car) && /麥拉倫 MCL40/.test(st.car) && /輪胎損耗 ×3/.test(st.car) && !st.change && st.dot && st.mpdot, st);
      check('GP standings: car chip and team name from row.colour2 / row.team', st.teams === 3 && st.chips === 3, st);

      // GP tab free, offline: year line + wear control
      await setNet(M.NET.off); await setGp(M.V.freeTrack); await setCars(cars(L26));
      await shot('menu-1280-gp-free');
      st = await js(`({ car: __text('gp-car'), change: __rect('gp-car-change').shown, wear: [].slice.call(document.querySelectorAll('#gp-wear button')).map(function (b) { return b.textContent + (b.classList.contains('on') ? '*' : ''); }).join(' '),
        setup: __rect('gp-setup'), panel: __rect('mp-panel'), start: __rect('gp-start') })`);
      check('GP tab free: season + car line with 換車, wear ×1..×5 (×1 on), start button above the fold', /^2026/.test(st.car) && /麥拉倫 MCL40/.test(st.car) && st.change && st.wear === '×1* ×2 ×3 ×4 ×5' && st.start.b <= st.panel.b, st);
      await mouseClick('#gp-car-change');
      check('換車 opens the 車輛 tab', await js(`document.getElementById('tab-car').classList.contains('on') && __rect('car-list').shown`));

      // settings
      await tab('set');
      await shot('menu-1280-settings');
      st = await js(`({ vol: document.getElementById('set-volume').value, val: __text('set-volume-val'), mute: document.getElementById('set-mute').checked, panel: __rect('set-panel') })`);
      check('設定: volume slider 80 % and mute off by default', st.vol === '80' && st.val === '80%' && !st.mute && st.panel.shown, st);

      // 1920 and narrow
      await size(1920, 1080);
      await tab('car');
      await shot('menu-1920-cars');
      st = await js(`({ cols: getComputedStyle(document.getElementById('track-grid')).gridTemplateColumns.split(' ').length, kb: __rect('keys-kb'), W: innerWidth, doc: document.documentElement.scrollWidth <= innerWidth })`);
      check('1920: grid 6 columns, key map one line', st.cols >= 5 && st.kb.h <= 26 && st.doc, st);
      await tab('gp');
      await setNet(M.NET.host(16)); await setGp(M.V.results16({}));
      await shot('menu-1920-gp-results16');
      check('GP standings with team names fit (results 16)', await js(`[].slice.call(document.querySelectorAll('#gp-standings .gp-row')).every(function (r) { return r.scrollWidth <= r.clientWidth + 1 && r.querySelector('.mp-pname').getBoundingClientRect().width >= 40; })`));
      await setNet(M.NET.off); await setGp(M.V.freeTrack);
      await size(1024, 640);
      await tab('car');
      await shot('menu-1024x640-cars');
      st = await js(`({ doc: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight, panel: __rect('mp-panel'), table: __rect(document.querySelector('.keymap')), W: innerWidth,
        cols: getComputedStyle(document.getElementById('track-grid')).gridTemplateColumns.split(' ').length })`);
      check('1024x640: no page overflow, key map inside, panel at least 330 px tall, grid 2+ columns', st.doc && st.table.r <= st.W - 16 && st.panel.h >= 330 && st.cols >= 2, st);
      await tab('gp');
      const narrow = await size(700, 720);
      await tab('car');
      await shot('menu-700-cars');
      st = await js(`({ doc: document.documentElement.scrollWidth <= innerWidth, menu: document.getElementById('menu').scrollWidth <= innerWidth, panel: __rect('mp-panel'), tabs: __rect('menu-tabs'), hints: __rect(document.querySelector('.hints')) })`);
      check('narrow menu: no horizontal overflow, tabs and key map inside the window', st.doc && st.menu && st.tabs.r <= narrow[0] && st.hints.r <= narrow[0], st);
      await js(`document.querySelector('.menu-main').scrollTop = 700`);
      await shot('menu-700-cars-scrolled');
      await js(`document.querySelector('.menu-main').scrollTop = 0`);
      await tab('set');
      await shot('menu-700-settings');
      await tab('gp');
      await size(1280, 720);
    }

    /* ================= HUD: telemetry graphic and its neighbours ================= */
    const hudFrame = o => js(`(function () { var t = F1_TRACKS.filter(function (t) { return (t.name + ' ' + t.id).toLowerCase().indexOf(${J(TRACK)}) >= 0; })[0] || F1_TRACKS[0];
      var h = Object.assign({ lap: 3, lapTotal: 5, curTime: 42.123, lastTime: 83.456, bestTime: 82.901, x: t.points[40][0], z: t.points[40][1], heading: 1.2, others: null }, ${J(M.TEL(o))});
      window.__h = h; for (var i = 0; i < 30; i++) F1.ui.updateHUD(h); return true; })()`);
    const layout = () => js(`(function () { var ids = ['hud-timing', 'hud-map', 'hud-hint', 'hud-gp', 'hud-players', 'gp-results', 'hud-lights', 'hud-pit', 'hud-menu-btn'], o = {};
      for (var i = 0; i < ids.length; i++) o[ids[i]] = __overlap('hud-telemetry', ids[i]);
      return { tel: __rect('hud-telemetry'), over: o, hint: __rect('hud-hint'), hintMap: __overlap('hud-hint', 'hud-map'), hintGp: __overlap('hud-hint', 'hud-gp'), hintLights: __overlap('hud-hint', 'hud-lights'),
        pitRes: __overlap('hud-pit', 'hud-gp'), W: innerWidth, H: innerHeight, px: __telPixels() }; })()`);
    const clear = s => Object.keys(s.over).every(k => s.over[k] === 0) && !s.hintMap && !s.hintGp && !s.hintLights;
    if (part('hud') || part('pit')) {
      await js(`(function () { var t = F1_TRACKS.filter(function (t) { return (t.name + ' ' + t.id).toLowerCase().indexOf(${J(TRACK)}) >= 0; })[0] || F1_TRACKS[0];
        F1.ui.setTrack(t); F1.ui.hideMenu(); return true; })()`);
      await setNet(M.NET.off); await setGp(M.V.freeTrack); await setCars(cars(L26));
    }
    if (part('hud')) {
      for (const [W, H, tag, telW] of [[1280, 720, '1280', 520], [1920, 1080, '1920', 780], [700, 720, '700', 520], [1100, 720, '1100', 520], [1000, 600, '1000x600', 520], [960, 640, '960', 520]]) {
        await size(W, H);
        await setNet(M.NET.off); await setGp(M.V.freeTrack); await js(`F1.ui.setPit(null); F1.ui.setLights(-1, false)`);
        await hudFrame({});
        await sleep(80); await hudFrame({});
        await shot('hud-' + tag + '-driving');
        let s = await layout();
        check(tag + ': telemetry canvas bottom centre, ' + telW + ' px wide, backing store = CSS box x DPR, drawn', s.tel.w === telW && Math.abs((s.tel.x + s.tel.r) / 2 - W / 2) <= 1 &&
          s.tel.b === H - 10 && s.px.w === Math.round(telW * DPR) && s.px.n > 500, { tel: s.tel, px: s.px });
        check(tag + ': free practice - telemetry clear of the timing box, minimap, key hint and menu button; hint clear of the minimap', clear(s), { over: s.over, hint: s.hint });
        await setNet(M.NET.guest(16)); await setGp(M.V.race16({})); await js(`F1.ui.setLights(4, false)`); await hudFrame({ speedKmh: 88, gear: 3, limiter: true, inPit: true, rpm: 8000 });
        await js(`F1.ui.setPit(${J(M.PIT.laneAhead)})`);
        await shot('hud-' + tag + '-race16-lights-pit');
        s = await layout();
        check(tag + ': race 16 + lights + pit strip - nothing overlaps the telemetry graphic', clear(s) && !s.pitRes, { over: s.over, pitGp: s.pitRes });
        await js(`F1.ui.setLights(-1, false); F1.ui.setPit(null)`);
        await setNet(M.NET.host(16)); await setGp(M.V.results16({}));
        await shot('hud-' + tag + '-results16');
        s = await layout();
        const res = await js(`({ res: __rect('gp-results'), body: __rect('gp-results-body'), sub: __text('gp-results-sub'), teams: document.querySelectorAll('#gp-results .gp-team').length, chips: document.querySelectorAll('#gp-results .gp-chip').length })`);
        check(tag + ': results overlay clear of the telemetry graphic and inside the window', !s.over['gp-results'] && res.res.y >= 0 && res.res.b <= H && res.res.x >= 0 && res.res.r <= W, { res: res.res, tel: s.tel });
        if (tag === '1280' || tag === '1920') check(tag + ': results 16 rows need no scrolling', res.body.sh <= res.body.ch + 1, res.body);
        if (tag === '1280') check('results subtitle: year and wear; team chips and names in the rows', /2026 賽季/.test(res.sub) && /輪胎損耗 ×2/.test(res.sub) && res.teams === 16 && res.chips === 16, res);
        await js(`F1.ui.setPad(true, 'Pad')`);
        await setNet(M.NET.off); await setGp(M.V.freeTrack);
        s = await layout();
        const padHint = await js(`({ text: __text('hud-hint'), keys: __rect('hud-hint-keys').shown, pad: __rect('hud-hint-pad').shown })`);
        if (W >= 1000) check(tag + ': controller hint shows LB / RB / Back and stays clear', padHint.pad && !padHint.keys && /LB/.test(padHint.text) && /Back/.test(padHint.text) && clear(s), padHint);
        else check(tag + ': compact window - key hints hidden, only the menu button (clear of everything)', !padHint.pad && !padHint.keys && /選單/.test(padHint.text) && clear(s), padHint);
        await shot('hud-' + tag + '-pad-hint');
        await js(`F1.ui.setPad(false, '')`);
      }
      await size(1280, 720);
      await setGp(M.V.race16({})); await setNet(M.NET.guest(16));
      const box = await js(`({ text: __text('hud-gp'), year: __text('hud-gp-year') })`);
      check('HUD session box shows the year', box.year === '2026' && /正賽/.test(box.text), box);
      // updateHUD hands the SAME object to F1.telemetry.draw
      const same = await js(`(function () { var T = F1.telemetry, orig = T.draw, got = null; T.draw = function (t) { got = t; return orig.apply(T, arguments); };
        var h = Object.assign({}, window.__h); F1.ui.updateHUD(h); T.draw = orig; return got === h; })()`);
      check('updateHUD passes its object straight to F1.telemetry.draw (no copy)', same);
      await setGp(M.V.freeTrack); await setNet(M.NET.off);
    }

    /* ================= HUD: pit strip ================= */
    if (part('pit')) {
      for (const [W, H, tag] of [[1280, 720, '1280'], [1920, 1080, '1920'], [700, 720, '700']]) {
        await size(W, H);
        for (const name of Object.keys(M.PIT)) {
          const p = M.PIT[name];
          const inPit = p.inLane, limiter = p.limiter;
          await hudFrame({ speedKmh: name === 'speeding' ? 71 : p.service ? 0 : inPit ? 79 : 142, gear: p.service ? 0 : 3, inPit, limiter, limitKmh: p.limitKmh, throttle: p.service ? 0 : 0.6 });
          await js(`F1.ui.setPit(${J(p)})`);
          if (tag === '1280' || name === 'servicePenalty' || name === 'speeding') await shot('pit-' + tag + '-' + name);
          const s = await js(`({ strip: __rect('hud-pit'), text: __text('hud-pit'), over: __overlap('hud-pit', 'hud-telemetry'), hint: __overlap('hud-pit', 'hud-hint'),
            timing: __overlap('hud-pit', 'hud-timing'), lim: document.getElementById('hud-pit-lim').className, warn: document.getElementById('hud-pit-warn').className, W: innerWidth, H: innerHeight })`);
          const inside = !s.strip.shown || (s.strip.x >= 0 && s.strip.r <= s.W && s.strip.y >= 0);
          const clearOf = !s.over && !s.hint && !s.timing;
          let ok = inside && clearOf, want = '';
          if (name === 'off') ok = ok && !s.strip.shown;
          if (name === 'limiterOnTrack') { want = '維修區 限速 80 / 限速器 開'; ok = ok && s.strip.shown && /維修區 限速\s*80/.test(s.text) && /限速器 開/.test(s.text) && !/維修格/.test(s.text); }
          if (name === 'laneAhead') { want = '你的維修格 3 號：前方 45 m'; ok = ok && /你的維修格 3 號：前方 45 m/.test(s.text) && /\bon\b/.test(s.lim); }
          if (name === 'laneNoLimiter') { want = '限速器 關 (warn) + 請開啟限速器（Q）'; ok = ok && /限速器 關/.test(s.text) && /warn/.test(s.lim) && /請開啟限速器（Q）/.test(s.text); }
          if (name === 'speeding') { want = '超速！(flashing), limit 60'; ok = ok && /超速！/.test(s.text) && /hot/.test(s.warn) && /限速\s*60/.test(s.text) && !/下次停站/.test(s.text); }
          if (name === 'atBox') { want = '到了，停車'; ok = ok && /你的維修格 3 號：到了，停車/.test(s.text); }
          if (name === 'passed') { want = '已超過 + 下次停站罰停 +5 s'; ok = ok && /你的維修格 3 號：已超過/.test(s.text) && /下次停站罰停 \+5 s/.test(s.text); }
          if (name === 'serviceTyres') { want = '換胎中 2.3 s'; ok = ok && /換胎中 2\.3 s/.test(s.text) && !/罰停/.test(s.text) && !/維修格/.test(s.text); }
          if (name === 'servicePenalty') { want = '罰停中 6.5 s + 罰停 +5 s'; ok = ok && /罰停中 6\.5 s/.test(s.text) && /罰停 \+5 s/.test(s.text); }
          if (name === 'serviceAfterPenalty') { want = '換胎中 1.4 s + 罰停 +5 s'; ok = ok && /換胎中 1\.4 s/.test(s.text) && /罰停 \+5 s/.test(s.text); }
          check(tag + ' pit ' + name + ': ' + (want || 'hidden') + '; inside the window, clear of the telemetry / hint / timing box', ok, { text: s.text, strip: s.strip.x + ',' + s.strip.y + ' ' + s.strip.w + 'x' + s.strip.h });
        }
        await js(`F1.ui.setPad(true, 'Pad'); F1.ui.setPit(${J(M.PIT.laneNoLimiter)})`);
        check(tag + ' pit: with a controller the limiter hint names LB', /請開啟限速器（LB）/.test(await js(`__text('hud-pit')`)));
        await js(`F1.ui.setPad(false, ''); F1.ui.setPit(null)`);
      }
      await size(1280, 720);
    }

    /* ================= behaviour ================= */
    if (part('checks')) {
      await load();
      await size(1280, 720);
      await setNet(M.NET.off); await setGp(M.V.freeTrack);
      await setCars(cars(L26));
      await js(`__calls.length = 0`);
      // tabs persist
      await mouseClick('#tab-car');
      check('tab click (real mouse) -> 車輛 page, remembered', await js(`__rect('car-panel').shown && JSON.parse(localStorage.getItem('f1drive.menu')).tab === 'car'`));
      // car pick
      await mouseClick('#car-list .car-card[data-id="2026-ferrari"]');
      let st = await js(`({ calls: JSON.stringify(__calls), on: [].slice.call(document.querySelectorAll('#car-list .car-card.on')).map(function (n) { return n.getAttribute('data-id'); }).join(','),
        store: localStorage.getItem('f1drive.car'), get: F1.ui.getCar(), gpcar: __text('gp-car-name') })`);
      check('car card click (real mouse) -> onCar("2026-ferrari"), highlighted at once, remembered', st.calls === '[["car","2026-ferrari"]]' && st.on === '2026-ferrari' && st.get === '2026-ferrari' &&
        JSON.parse(st.store).car === '2026-ferrari' && /法拉利 SF-26/.test(st.gpcar), st);
      await mouseClick('#car-list .car-card[data-id="2026-ferrari"]');
      check('clicking the chosen car again: no second callback', (await calls()) === '[["car","2026-ferrari"]]');
      await setCars(cars(L26, { selected: '2026-williams' }));
      check('setCars decides the highlight (main.js resolved another id)', await js(`[].slice.call(document.querySelectorAll('#car-list .car-card.on')).map(function (n) { return n.getAttribute('data-id'); }).join(',') === '2026-williams'`));
      // year pick
      await js(`__calls.length = 0; var s = document.getElementById('car-year'); s.value = '2012'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
      st = await js(`({ calls: JSON.stringify(__calls), pending: document.getElementById('car-list').classList.contains('pending'), get: F1.ui.getYear(), store: localStorage.getItem('f1drive.car') })`);
      check('year change -> onYear(2012), remembered, list dimmed until setCars brings 2012', st.calls === '[["year",2012]]' && st.pending && st.get === 2012 && JSON.parse(st.store).year === 2012, st);
      await setCars(cars(L12, { selected: '2012-standard' }));
      check('setCars(2012) -> list replaced, no longer dimmed', await js(`!document.getElementById('car-list').classList.contains('pending') && document.querySelectorAll('.car-card').length === 12 && document.querySelector('.car-card.on').getAttribute('data-id') === '2012-standard'`));
      // locked
      await setCars(cars(L12, { canPickYear: false, canPickCar: false }));
      await js(`__calls.length = 0; document.querySelectorAll('.car-card')[5].click(); var s = document.getElementById('car-year'); s.value = '2020'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
      st = await js(`({ calls: JSON.stringify(__calls), year: document.getElementById('car-year').value, car: F1.ui.getCar() })`);
      check('locked (session): card click and a forced year change do nothing; the selector snaps back', st.calls === '[]' && st.year === '2012' && st.car === '2026-ferrari', st);
      await setCars(cars(L26));
      // parc fermé by the UI itself: a session on locks the controls even if the flags say otherwise
      await setGp(M.V.quali3({}));
      await js(`__calls.length = 0; document.querySelectorAll('.car-card')[6].click()`);
      st = await js(`({ calls: JSON.stringify(__calls), locked: document.getElementById('car-list').classList.contains('locked'), dis: document.getElementById('car-year').disabled, lock: __text('car-lock') })`);
      check('session on, flags still true: the UI locks cars and year itself (賽事進行中不能換車)', st.calls === '[]' && st.locked && st.dis && st.lock === '賽事進行中不能換車', st);
      await setGp(M.V.freeTrack);
      check('session over: unlocked again', await js(`!document.getElementById('car-list').classList.contains('locked') && !document.getElementById('car-year').disabled && !__rect('car-lock').shown`));
      // 50 identical setCars -> no DOM mutation; a change -> some
      const q1 = await js(`(function () { var v = ${J(cars(L26, { selected: '2026-audi' }))}; F1.ui.setCars(v);
        var same = __mut(function () { for (var i = 0; i < 50; i++) F1.ui.setCars(JSON.parse(JSON.stringify(v))); });
        v.selected = '2026-haas'; var sel = __mut(function () { F1.ui.setCars(v); });
        v.canPickCar = false; var lock = __mut(function () { F1.ui.setCars(v); });
        return { same: same, sel: sel, lock: lock }; })()`);
      check('50 identical setCars calls touch no DOM; a new selection / lock does', q1.same === 0 && q1.sel > 0 && q1.sel <= 12 && q1.lock > 0, q1);
      await setCars(cars(L26));
      // 50 identical setPit -> none; the countdown touches the DOM only when the shown tenth changes
      const q2 = await js(`(function () { var p = ${J(M.PIT.servicePenalty)}; F1.ui.setPit(p);
        var same = __mut(function () { for (var i = 0; i < 50; i++) F1.ui.setPit(JSON.parse(JSON.stringify(p))); });
        var hidden = __mut(function () { F1.ui.setPit(null); for (var i = 0; i < 50; i++) F1.ui.setPit({ inLane: false, limiter: false, service: null, boxAhead: 12, slot: 1 }); });
        var p2 = JSON.parse(JSON.stringify(${J(M.PIT.serviceTyres)})), frames = 0, tick = __mut(function () {
          for (var t = 3.1; t > 0; t -= 1 / 60) { p2.service.left = t; F1.ui.setPit(p2); frames++; } });
        var drive = __mut(function () { var q = JSON.parse(JSON.stringify(${J(M.PIT.laneAhead)})); for (var i = 0; i < 60; i++) { q.boxAhead = 45.3 - i * 0.01; F1.ui.setPit(q); } });
        F1.ui.setPit(null);
        return { same: same, hidden: hidden, tick: tick, frames: frames, drive: drive }; })()`);
      check('50 identical setPit calls touch no DOM; a 3.1 s countdown at 60 fps changes it ~31 times, not every frame', q2.same === 0 && q2.hidden > 0 && q2.tick < q2.frames && q2.tick <= 4 * 34 && q2.drive <= 3, q2);
      // setPit before / with junk never throws
      const junk = await js(`(function () { try { F1.ui.setPit(undefined); F1.ui.setPit(7); F1.ui.setPit({ inLane: 'yes', limiter: 1, service: { left: NaN, total: -1, penalty: 'x' }, limitKmh: -5, boxAhead: Infinity, slot: 1e9, pending: {} });
        F1.ui.setCars(null); F1.ui.setCars({ cars: [null, 5, { id: 'Bad Id' }, { id: '2026-x', team: '<img src=x onerror=alert(1)>', note: '<b>n</b>', ratings: { topSpeed: 1e9, accel: 'a' }, colour: 'red' }], year: '2026x', seasons: 'no' });
        return 'ok'; } catch (e) { return String(e.stack || e); } })()`);
      check('junk into setPit / setCars never throws', junk === 'ok', junk);
      check('car texts are escaped (no element injected from a team / note)', await js(`!document.querySelector('#car-list img, #car-list .car-note b') && document.querySelectorAll('#car-list .car-card').length === 1`));
      await setCars(cars(L26));
      await js(`F1.ui.setPit(null)`);
      // wear + start
      await tab('gp');
      await js(`__calls.length = 0`);
      await mouseClick('#gp-wear button[data-w="3"]');
      await mouseClick('#gp-start');
      st = await js(`({ calls: JSON.stringify(__calls), store: localStorage.getItem('f1drive.gp'), on: document.querySelector('#gp-wear .on').getAttribute('data-w') })`);
      check('輪胎損耗 ×3 (real mouse) + start -> onGpStart({q, r, wear: 3}), remembered', st.calls === '[["start",{"q":3,"r":5,"wear":3}]]' && JSON.parse(st.store).wear === 3 && st.on === '3', st);
      // audio
      await tab('set');
      await js(`__calls.length = 0; var s = document.getElementById('set-volume'); s.value = '35'; s.dispatchEvent(new Event('input', { bubbles: true }))`);
      await mouseClick('#set-mute');
      st = await js(`({ calls: JSON.stringify(__calls), store: localStorage.getItem('f1drive.audio'), get: JSON.stringify(F1.ui.getAudio()), val: __text('set-volume-val'), mt: __text('set-mute-text') })`);
      check('volume slider and mute switch (real mouse) -> onAudio, remembered, getAudio', st.calls === '[["audio",{"volume":0.35,"muted":false}],["audio",{"volume":0.35,"muted":true}]]' &&
        st.store === '{"volume":0.35,"muted":true}' && st.get === '{"volume":0.35,"muted":true}' && st.val === '35%' && st.mt === '開', st);
      await js(`__calls.length = 0; F1.ui.setAudio({ muted: false }); F1.ui.setAudio({ volume: 7 }); F1.ui.setAudio({ volume: 'x', muted: 'no' })`);
      st = await js(`({ calls: JSON.stringify(__calls), get: JSON.stringify(F1.ui.getAudio()), box: document.getElementById('set-mute').checked, vol: document.getElementById('set-volume').value, store: localStorage.getItem('f1drive.audio') })`);
      check('setAudio (M key): shown and remembered, clamped, junk ignored, no onAudio', st.calls === '[]' && st.get === '{"volume":1,"muted":false}' && !st.box && st.vol === '100' && st.store === '{"volume":1,"muted":false}', st);
      await js(`F1.ui.setAudio({ volume: 0.35, muted: true })`);
      // session start brings the GP tab forward
      await tab('mp');
      await setGp(M.V.quali3({}));
      check('a Grand Prix starting (free -> quali) switches to the 大獎賽 tab (not remembered)', await js(`__rect('gp-panel').shown && JSON.parse(localStorage.getItem('f1drive.menu')).tab === 'mp'`));
      await setGp(M.V.freeTrack);
      await tab('set');
      // reload: everything restored
      await load();
      st = await js(`({ tab: document.querySelector('.menu-tabs .on').id, car: F1.ui.getCar(), year: F1.ui.getYear(), audio: JSON.stringify(F1.ui.getAudio()), vol: document.getElementById('set-volume').value,
        mute: document.getElementById('set-mute').checked, wear: document.querySelector('#gp-wear .on').getAttribute('data-w') })`);
      check('reload: tab, car, year, audio and wear restored', st.tab === 'tab-set' && st.car === '2026-ferrari' && st.year === 2012 && st.audio === '{"volume":0.35,"muted":true}' &&
        st.vol === '35' && st.mute && st.wear === '3', st);
      await js(`localStorage.setItem('f1drive.car', '{"year":1999.5,"car":"Constructor Evil!"}'); localStorage.setItem('f1drive.audio', '{"volume":"loud","muted":1}');
        localStorage.setItem('f1drive.menu', '{"tab":"__proto__"}'); localStorage.setItem('f1drive.gp', '{"q":3,"r":5,"wear":99}')`);
      await load();
      st = await js(`({ tab: document.querySelector('.menu-tabs .on').id, car: F1.ui.getCar(), year: F1.ui.getYear(), audio: JSON.stringify(F1.ui.getAudio()), wear: document.querySelector('#gp-wear .on').getAttribute('data-w') })`);
      check('reload with junk in storage: validated (car / year null, audio defaults, tab 大獎賽, wear clamped to 5)', st.tab === 'tab-gp' && st.car === null && st.year === null && st.audio === '{"volume":0.8,"muted":false}' && st.wear === '5', st);
      await js(`localStorage.setItem('f1drive.car', 'not json'); localStorage.setItem('f1drive.audio', '[1,2]'); localStorage.setItem('f1drive.gp', '{"wear":"3"}')`);
      await load();
      st = await js(`({ car: F1.ui.getCar(), audio: JSON.stringify(F1.ui.getAudio()), wear: document.querySelector('#gp-wear .on').getAttribute('data-w') })`);
      check('reload with corrupt storage: defaults', st.car === null && st.audio === '{"volume":0.8,"muted":false}' && st.wear === '1', st);
    }

    /* ================= the real game (v5 main.js until v6 is wired) ================= */
    if (part('real')) {
      realPart = true;
      await size(1280, 720);
      await w.loadFile(path.join(ROOT, 'index.html'));
      await sleep(1200);
      await js(PAGE_LIB);
      const err = await js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
      const expected = stubbed.map(s => '無法載入程式檔：' + s);
      check('real game: the only boot errors are the scripts not written yet (' + (stubbed.join(', ') || 'none') + ')', err.split('\n').filter(Boolean).every(l => expected.indexOf(l) >= 0), err);
      await js(`document.getElementById('error').classList.add('hidden')`);
      const picked = await js(`(function () { var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${J(TRACK)}) >= 0; })[0];
        if (!c) return null; c.click(); return c.querySelector('.card-name').textContent; })()`);
      await sleep(1800);
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
      await sleep(2500);
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      await sleep(200);
      await shot('real-1280-driving');
      const s = await layout();
      const sp = await js(`F1.game && F1.game.car ? Math.round(Math.abs(F1.game.car.state.speed) * 3.6) : -1`);
      check('real game (' + picked + '): HUD up, telemetry drawn by the game loop, car moving, layout clear', s.px.n > 500 && sp > 20 && clear(s), { px: s.px, kmh: sp, over: s.over });
      await js(`document.getElementById('hud-menu-btn').click()`);
      await sleep(300);
      const menu = await js(`({ menu: __rect('menu').shown, tabs: __rect('menu-tabs').shown, gp: __rect('gp-panel').shown })`);
      check('real game: 選單 opens the menu with the tabs', menu.menu && menu.tabs && menu.gp, menu);
      await js(`document.getElementById('tab-car').click()`);
      await shot('real-1280-menu-cars');
      await js(`document.getElementById('tab-gp').click()`);
      await size(1920, 1080);
      await js(`document.getElementById('menu-resume').click()`);
      await sleep(600);
      await shot('real-1920-driving');
      const s2 = await layout();
      check('real game 1920: telemetry 780 px wide, drawn, clear', s2.tel.w === 780 && s2.px.n > 500 && clear(s2), { tel: s2.tel, px: s2.px, over: s2.over });
      realPart = false;
    }
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' / ' + results.length + ' checks passed' + (failed.length ? '  FAILED: ' + failed.map(r => r.name).join(' | ') : ''));
  app.exit(failed.length ? 1 : 0);
});
