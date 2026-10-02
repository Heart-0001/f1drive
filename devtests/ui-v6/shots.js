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

// (v6.1: js/hudmirrors.js after js/cockpit.js - the HUD rear-view mirrors; v6.2: js/track-names-zh.js after tracks-data.js - the
// Chinese circuit names of the cards and the search -, js/tunnels.js after js/scenery.js - Monaco's tunnel; v7: js/ai.js after js/pit.js -
// the computer drivers)
const CONTRACT_ORDER = ['js/boot.js', 'lib/three.min.js', 'tracks-data.js', 'js/track-names-zh.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js',
  'js/cockpit.js', 'js/hudmirrors.js', 'js/gamepad.js', 'js/audio.js', 'js/raceline.js', 'scenery-data.js', 'js/scenery.js', 'js/tunnels.js', 'js/collide.js',
  'js/carmodel.js', 'js/laps.js', 'js/pit.js', 'js/ai.js', 'net/session.js', 'js/net.js', 'js/gp.js', 'js/telemetry.js', 'js/ui.js', 'js/main.js'];
// every id the v6 UI adds (reported to the integrator / end-to-end tests); v6.1: the HUD mirror frames and their switch
const NEW_IDS = ['hud-telemetry', 'hud-pit', 'hud-pit-limit', 'hud-pit-lim', 'hud-pit-warn', 'hud-pit-box', 'hud-pit-pending', 'hud-pit-svc',
  'hud-pit-svc-label', 'hud-pit-svc-time', 'hud-pit-bar', 'hud-pit-pen', 'hud-gp-year', 'menu-tabs', 'tab-car', 'tab-gp', 'tab-mp', 'tab-set',
  'tab-car-chip', 'tab-gp-dot', 'tab-mp-dot', 'car-panel', 'car-year', 'car-season', 'car-lock', 'car-list', 'car-empty', 'gp-panel', 'gp-car',
  'gp-year', 'gp-car-name', 'gp-car-change', 'gp-wear', 'gp-wear-note', 'mp-section', 'set-panel', 'set-volume', 'set-volume-val', 'set-mute',
  'set-mute-text', 'keys-kb', 'keys-pad', 'pad-status', 'hud-mirror-l', 'hud-mirror-r', 'set-mirrors', 'set-mirrors-text',
  'set-fov', 'set-fov-val', 'set-fov-note', 'gp-tyre-row', 'gp-tyre', 'gp-tyre-label', 'gp-tyre-note', 'hud-pit-next'];   // (v6.2)
// the HUD mirror frames (index.html; js/hudmirrors.js draws into them): nothing of the HUD may cover them
const MIRRORS = ['hud-mirror-l', 'hud-mirror-r'];
const NEAR_MIRRORS = ['hud-timing', 'hud-map', 'hud-hint', 'hud-gp', 'hud-players', 'gp-results', 'hud-lights', 'hud-pit', 'hud-menu-btn', 'hud-telemetry', 'hud-toast'];
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
      // (v7.2: a Grand Prix starts in the start panel: 開始 -> onSetupStart; its mode / laps / wear -> onSetup)
      onSetupStart: function (c) { __calls.push(['start', c]); },
      onSetup: function (p) { __calls.push(['setup', p]); },
      onGpAction: function (a) { __calls.push(['action', a]); },
      onYear: function (y) { __calls.push(['year', y]); },
      onCar: function (id) { __calls.push(['car', id]); },
      onAudio: function (a) { __calls.push(['audio', a]); },
      onMirrors: function (on) { __calls.push(['mirrors', on]); },
      onFov: function (d) { __calls.push(['fov', d]); },
      onCompound: function (c) { __calls.push(['compound', c]); },
      onProfile: function () {}
    });
    F1.ui.showMenu(window.F1_TRACKS);
    return true;
  };
  // v7.2: the start panel of Monza as main.js draws it alone (a SetupView), or the cards again
  window.__panel = function (on) {
    if (!on) { F1.ui.setSetup({ show: 'tracks', room: false }); return true; }
    var td = F1_TRACKS.filter(function (t) { return t.id === 'it-1922'; })[0], s = F1.ui.getSetup();
    F1.ui.setSetup({ show: 'setup', room: false, track: td, trackId: td.id, trackMissing: false, current: false, mode: s.mode, q: s.q, r: s.r, wear: s.wear, canEdit: true,
      go: { show: true, enabled: true, label: '開始', sub: '' }, hint: '', note: '', banner: '' });
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
    check('ui API: v6 functions present (v6.1: getMirrors / setMirrors; v6.2: getFov / setCompound)', await js(`['setCars','getCar','getYear','getAudio','setAudio','setPit','setGp','setNet','setLights','setPad','updateHUD','toast','getMirrors','setMirrors','getFov','setCompound'].every(function (k) { return typeof F1.ui[k] === 'function'; })`));

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
      check('menu head: new keys and controller mapping listed', ['限速器', '電池', '換胎配方', '靜音', '後照鏡', 'Q', 'E', 'T', 'M', 'V', 'LB', 'RB', 'View', 'Start'].every(s => head.hint.indexOf(s) >= 0), head.hint);
      // v6.1: the keyboard / controller key of each action, column by column (js/gamepad.js's A B X Y layout, the V key)
      const cols = await js(`(function () { var h = [].map.call(document.querySelectorAll('.keymap thead th'), function (t) { return t.textContent; }), o = {};
        var row = function (id) { return [].map.call(document.querySelectorAll('#' + id + ' td'), function (td) { return td.textContent.replace(/\\s+/g, ''); }); };
        var kb = row('keys-kb'), pad = row('keys-pad'); h.forEach(function (n, i) { o[n] = [kb[i], pad[i]]; }); return o; })()`);
      const WANT = { '油門': ['W', 'RT'], '重置': ['R', 'Y'], '行車線': ['L', 'View'], '限速器': ['Q', 'B/LB'], '電池（按住）': ['E', 'A/RB'], '換胎配方': ['T', 'X'], '靜音': ['M', '—'], '後照鏡': ['V', '—'],
        '選單': ['Esc', 'Start'], '視角': ['—', '右搖桿'] };
      check('menu head: each action\'s key and button (v6.1 pad layout A battery (hold) / B limiter / X compound / Y reset / View line / Start menu; V mirrors)',
        Object.keys(WANT).every(k => J(cols[k]) === J(WANT[k])), cols);
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
      // v6.1: each car's battery line (F1.cars.ersNote: the real data's, the mock rows carry none) under its bars
      const ers26 = await js(`[].map.call(document.querySelectorAll('#car-list .car-card'), function (c) { var e = c.querySelector('.car-ers');
        return [c.getAttribute('data-id'), e ? e.textContent : null, F1.cars ? F1.cars.ersNote(c.getAttribute('data-id')) : null, !!c.querySelector('.car-noers')]; })`);
      check('cars 2026: the battery line (電池 + F1.cars.ersNote) on every card that has a note, none on the others (the standard car), no 無 KERS mark',
        ers26.every(r => r[3] === false && (r[2] ? r[1] === '電池' + r[2] : r[1] === null)) && ers26.filter(r => r[1]).length >= 8 && ers26[0][0] === '2026-standard' && ers26[0][1] === null, ers26);
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
        labels: [].slice.call(document.querySelectorAll('#car-list .car-bar em')).map(function (e) { return e.firstChild.textContent; }),
        noers: [].slice.call(document.querySelectorAll('#car-list .car-card')).map(function (n) { var x = n.querySelector('.car-noers'); return x ? x.textContent : null; }),
        text: __text('car-list'), season: __text('car-season'), year: document.getElementById('car-year').value })`);
      // (v6.1: a car without a battery may still have a battery line - the real data's "沒有裝 KERS…" - so the bar is looked for, not the word)
      check('cars 2012 (no ERS): the 電池 bar is left out on every card, 無 KERS where it would be', st.bars.length === 12 && st.bars.every(n => n === 4) && st.labels.indexOf('電池') < 0 &&
        st.noers.every(t => t === '無 KERS') && st.year === '2012' && /V8/.test(st.season), { bars: st.bars, noers: st.noers, season: st.season });

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
      // (v7.2: the laps / tyre wear moved to the start panel (#gp-wear with its id); the tab offers 在目前賽道開大獎賽…)
      st = await js(`({ car: __text('gp-car'), change: __rect('gp-car-change').shown, wear: [].slice.call(document.querySelectorAll('#gp-wear button')).map(function (b) { return b.textContent + (b.classList.contains('on') ? '*' : ''); }).join(' '),
        inSetup: !!document.querySelector('#setup #gp-wear'), panel: __rect('mp-panel'), open: __rect('gp-open') })`);
      check('GP tab free: season + car line with 換車; the start panel\'s wear ×1..×5 (×1 on); 在目前賽道開大獎賽… above the fold', /^2026/.test(st.car) && /麥拉倫 MCL40/.test(st.car) && st.change && st.wear === '×1* ×2 ×3 ×4 ×5' &&
        st.inSetup && st.open.shown && st.open.b <= st.panel.b, st);
      await mouseClick('#gp-car-change');
      check('換車 opens the 車輛 tab', await js(`document.getElementById('tab-car').classList.contains('on') && __rect('car-list').shown`));

      // settings
      await tab('set');
      await shot('menu-1280-settings');
      st = await js(`({ vol: document.getElementById('set-volume').value, val: __text('set-volume-val'), mute: document.getElementById('set-mute').checked, panel: __rect('set-panel') })`);
      check('設定: volume slider 80 % and mute off by default', st.vol === '80' && st.val === '80%' && !st.mute && st.panel.shown, st);
      st = await js(`({ on: document.getElementById('set-mirrors').checked, dis: document.getElementById('set-mirrors').disabled, txt: __text('set-mirrors-text'), get: F1.ui.getMirrors(),
        shown: __rect('set-mirrors').shown, note: __text('set-mirrors-note'), cls: document.getElementById('hud').classList.contains('no-mirrors'), panel: __rect('set-panel'), row: __rect('set-mirrors-text') })`);
      check('設定 (v6.1): 後照鏡 switch on by default (開), the V key named, the HUD laid out with the mirrors', st.on && !st.dis && st.txt === '開' && st.get === true && st.shown && /V/.test(st.note) && !st.cls && st.row.r <= st.panel.r, st);

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
    // (v6.1: + the two HUD mirror frames: shown, in the top corners, inside the window, and nothing of the HUD over them)
    const layout = () => js(`(function () { var ids = ['hud-timing', 'hud-map', 'hud-hint', 'hud-gp', 'hud-players', 'gp-results', 'hud-lights', 'hud-pit', 'hud-menu-btn'], o = {};
      for (var i = 0; i < ids.length; i++) o[ids[i]] = __overlap('hud-telemetry', ids[i]);
      var mir = {}, near = ${J(NEAR_MIRRORS)}, M = ${J(MIRRORS)};
      for (var m = 0; m < M.length; m++) for (var k = 0; k < near.length; k++) { var a = __overlap(M[m], near[k]); if (a) mir[M[m] + ' x ' + near[k]] = a; }
      var ml = __rect('hud-mirror-l'), mr = __rect('hud-mirror-r');
      return { tel: __rect('hud-telemetry'), over: o, hint: __rect('hud-hint'), hintMap: __overlap('hud-hint', 'hud-map'), hintGp: __overlap('hud-hint', 'hud-gp'), hintLights: __overlap('hud-hint', 'hud-lights'),
        pitRes: __overlap('hud-pit', 'hud-gp'), W: innerWidth, H: innerHeight, px: __telPixels(), mir: mir, ml: ml, mr: mr,
        // (frames: 4 px border round a 3 : 1 glass, 12 px from the top, 18 px from the sides)
        mirOk: ml.shown && mr.shown && ml.y === 12 && mr.y === 12 && ml.x === 18 && mr.r === innerWidth - 18 && ml.r < mr.x && Math.abs(ml.w - mr.w) <= 1 &&
          Math.abs((ml.w - 8) / (ml.h - 8) - 3) < 0.1 }; })()`);
    const clear = s => Object.keys(s.over).every(k => s.over[k] === 0) && !s.hintMap && !s.hintGp && !s.hintLights && s.mirOk && Object.keys(s.mir).length === 0;
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
        check(tag + ': free practice - telemetry clear of the timing box, minimap, key hint and menu button; hint clear of the minimap; the two mirror frames in the top corners, nothing over them',
          clear(s), { over: s.over, hint: s.hint, mir: s.mir, ml: s.ml, mr: s.mr, mirOk: s.mirOk });
        await setNet(M.NET.guest(16)); await setGp(M.V.race16({})); await js(`F1.ui.setLights(4, false)`); await hudFrame({ speedKmh: 88, gear: 3, limiter: true, inPit: true, rpm: 8000 });
        await js(`F1.ui.setPit(${J(M.PIT.laneAhead)}); F1.ui.toast('起跑位置 P5 / 16，燈號全滅就起跑', 60000)`);
        await shot('hud-' + tag + '-race16-lights-pit');
        s = await layout();
        check(tag + ': race 16 + lights + pit strip + a toast - nothing overlaps the telemetry graphic or the mirrors', clear(s) && !s.pitRes, { over: s.over, pitGp: s.pitRes, mir: s.mir });
        await js(`F1.ui.setLights(-1, false); F1.ui.setPit(null); F1.ui.toast('')`);
        await setNet(M.NET.host(16)); await setGp(M.V.results16({}));
        await shot('hud-' + tag + '-results16');
        s = await layout();
        const res = await js(`({ res: __rect('gp-results'), body: __rect('gp-results-body'), sub: __text('gp-results-sub'), teams: document.querySelectorAll('#gp-results .gp-team').length, chips: document.querySelectorAll('#gp-results .gp-chip').length })`);
        const inWin = res.res.y >= 0 && res.res.b <= H && res.res.x >= 0 && res.res.r <= W;
        check(tag + ': results 16 - the mirror frames still in place, nothing over them', s.mirOk && Object.keys(s.mir).length === 0, { mir: s.mir, ml: s.ml, mr: s.mr });
        if (W >= 1260) check(tag + ': results overlay clear of the telemetry graphic and inside the window', !s.over['gp-results'] && inWin, { res: res.res, tel: s.tel });
        else {
          // narrower than 1260 px (index.html): the overlay goes below the top row of boxes (timing box, minimap; under
          // 1000 px also the 選單 button), the session box makes way for it; it stays above the telemetry graphic when at
          // least 250 px are left there, else it is 250 px tall and covers the graphic's top
          const top = await js(`({ timing: __rect('hud-timing'), map: __rect('hud-map'), btn: __rect('hud-menu-btn'), gp: __rect('hud-gp'), open: document.getElementById('hud').classList.contains('res-open') })`);
          const room = s.tel.y - res.res.y - 8, below = res.res.y >= top.timing.b && res.res.y >= top.map.b && (W >= 1000 || !top.btn.shown || res.res.y >= top.btn.b);
          check(tag + ': results overlay inside the window, below the timing box / minimap' + (W < 1000 ? ' / 選單 button' : '') + ', the session box hidden; ' +
            (room >= 250 ? 'clear of the telemetry graphic (' + Math.round(room) + ' px left above it)' : 'over the graphic\'s top at 250 px tall (only ' + Math.round(room) + ' px above it)'),
            inWin && below && top.open && !top.gp.shown && (room >= 250 ? !s.over['gp-results'] : res.res.h <= 251), { res: res.res, tel: s.tel, top });
        }
        if (tag === '1280' || tag === '1920') check(tag + ': results 16 rows need no scrolling', res.body.sh <= res.body.ch + 1, res.body);
        if (tag === '1280') check('results subtitle: year and wear; team chips and names in the rows', /2026 賽季/.test(res.sub) && /輪胎損耗 ×2/.test(res.sub) && res.teams === 16 && res.chips === 16, res);
        await js(`F1.ui.setPad(true, 'Pad')`);
        await setNet(M.NET.off); await setGp(M.V.freeTrack);
        s = await layout();
        const padHint = await js(`({ text: __text('hud-hint'), keys: __rect('hud-hint-keys').shown, pad: __rect('hud-hint-pad').shown })`);
        // (v6.1 layout: A / RB battery (hold), B / LB limiter, X compound, Y reset, View line, Start menu; V mirrors)
        if (W >= 1000) check(tag + ': controller hint shows the v6.1 layout (A / RB 電池（按住）, B / LB 限速器, X, Y, View, Start, V) and stays clear', padHint.pad && !padHint.keys &&
          /A\s*\/\s*RB\s*電池（按住）/.test(padHint.text) && /B\s*\/\s*LB\s*限速器/.test(padHint.text) && /X\s*換胎配方/.test(padHint.text) && /Y\s*重置/.test(padHint.text) &&
          /View\s*行車線/.test(padHint.text) && /Start\s*選單/.test(padHint.text) && /V\s*後照鏡/.test(padHint.text) && clear(s), padHint);
        else check(tag + ': compact window - key hints hidden, only the menu button (clear of everything)', !padHint.pad && !padHint.keys && /選單/.test(padHint.text) && clear(s), padHint);
        await shot('hud-' + tag + '-pad-hint');
        await js(`F1.ui.setPad(false, '')`);
      }
      await size(1280, 720);
      // v6.1: mirrors off (設定 / V): the frames hidden, every box exactly where it was without mirrors (v6)
      for (const [W, H] of [[1280, 720], [700, 720]]) {
        await size(W, H);
        await setNet(M.NET.guest(16)); await setGp(M.V.race16({})); await js(`F1.ui.setLights(4, false); F1.ui.setMirrors({ on: false })`); await hudFrame({});
        await shot('hud-' + W + '-no-mirrors');
        const nm = await js(`({ cls: document.getElementById('hud').className, l: __rect('hud-mirror-l').shown, r: __rect('hud-mirror-r').shown, timing: __rect('hud-timing'), map: __rect('hud-map'),
          gp: __rect('hud-gp'), lights: __rect('hud-lights'), hint: __rect('hud-hint'), toastMax: getComputedStyle(document.getElementById('hud-toast')).maxWidth })`);
        await js(`F1.ui.setMirrors({ on: true }); F1.ui.setLights(-1, false)`);
        const ok = W > 720 ? nm.timing.y === 18 && nm.map.y === 18 && nm.gp.y === 196 : nm.timing.y === 18 && nm.lights.y === 176 && nm.gp.y === 284 && nm.hint.y === 174;
        check(W + ': mirrors off - frames hidden (#hud.no-mirrors), the corner boxes back at their v6 places (timing / minimap 18, session box 196; narrow: lights 176, session 284, 選單 174), the toast as wide as before (60vw)',
          / no-mirrors|^no-mirrors/.test(nm.cls) && !nm.l && !nm.r && ok && nm.toastMax === Math.round(W * 0.6) + 'px', nm);
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
          // v6.2: wherever the strip is up, the next set and its keys (keyboard: T first)
          const ZHC = { S: '軟胎', M: '中性胎', H: '硬胎' };
          if (name !== 'off') { want += ' + 下一組：' + ZHC[p.next] + '（T / X 切換）'; ok = ok && s.text.indexOf('下一組：' + ZHC[p.next] + '（T / X 切換）') >= 0; }
          check(tag + ' pit ' + name + ': ' + (want || 'hidden') + '; inside the window, clear of the telemetry / hint / timing box', ok, { text: s.text, strip: s.strip.x + ',' + s.strip.y + ' ' + s.strip.w + 'x' + s.strip.h });
        }
        await js(`F1.ui.setPad(true, 'Pad'); F1.ui.setPit(${J(M.PIT.laneNoLimiter)})`);
        const padPit = await js(`__text('hud-pit')`);
        check(tag + ' pit: with a controller the limiter hint names B (v6.1 layout) and the next set X first (v6.2: 下一組：軟胎（X / T 切換）)',
          /請開啟限速器（B）/.test(padPit) && padPit.indexOf('下一組：軟胎（X / T 切換）') >= 0, padPit);
        if (tag === '1280') await shot('pit-1280-laneNoLimiter-pad');
        const noNext = Object.assign({}, M.PIT.laneAhead); delete noNext.next;
        await js(`F1.ui.setPad(false, ''); F1.ui.setPit(${J(noNext)})`);
        check(tag + ' pit: without `next` (an older main.js) no next-set line', !/下一組/.test(await js(`__text('hud-pit')`)) && !(await js(`__rect('hud-pit-next').shown`)));
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
      // wear + start (v7.2: in the start panel, mode 大獎賽)
      await tab('gp');
      await js(`__panel(true); document.querySelector('#setup-mode [data-m="gp"]').click(); __panel(true); __calls.length = 0`);
      await mouseClick('#gp-wear button[data-w="3"]');
      await mouseClick('#setup-go');
      st = await js(`({ calls: JSON.stringify(__calls), store: localStorage.getItem('f1drive.gp'), on: document.querySelector('#gp-wear .on').getAttribute('data-w') })`);
      check('輪胎損耗 ×3 (real mouse, start panel) + 開始 -> onSetup({wear: 3}), onSetupStart({mode: gp, q, r, wear: 3}), remembered', st.calls === '[["setup",{"wear":3}],["start",{"mode":"gp","q":3,"r":5,"wear":3,"force":false}]]' &&
        JSON.parse(st.store).wear === 3 && st.on === '3', st);
      await js(`__panel(false)`);
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
      // v6.1: the HUD mirrors switch (real mouse) -> onMirrors(false), remembered, the HUD laid out without them
      await js(`__calls.length = 0`);
      await mouseClick('#set-mirrors');
      st = await js(`({ calls: JSON.stringify(__calls), store: localStorage.getItem('f1drive.hud'), get: F1.ui.getMirrors(), box: document.getElementById('set-mirrors').checked, txt: __text('set-mirrors-text'),
        cls: document.getElementById('hud').classList.contains('no-mirrors') })`);
      check('後照鏡 switch (real mouse) -> onMirrors(false), remembered (f1drive.hud), getMirrors, #hud.no-mirrors', st.calls === '[["mirrors",false]]' && st.store === '{"mirrors":false}' &&
        st.get === false && !st.box && st.txt === '關' && st.cls, st);
      await js(`__calls.length = 0; F1.ui.setMirrors({ on: true }); F1.ui.setMirrors({ on: 'yes' }); F1.ui.setMirrors(null); F1.ui.setMirrors(7)`);
      st = await js(`({ calls: JSON.stringify(__calls), store: localStorage.getItem('f1drive.hud'), get: F1.ui.getMirrors(), box: document.getElementById('set-mirrors').checked, cls: document.getElementById('hud').classList.contains('no-mirrors') })`);
      check('setMirrors({on}) (the V key): shown and remembered, junk ignored, no onMirrors', st.calls === '[]' && st.store === '{"mirrors":true}' && st.get === true && st.box && !st.cls, st);
      await js(`F1.ui.setMirrors({ available: false })`);
      st = await js(`({ dis: document.getElementById('set-mirrors').disabled, box: document.getElementById('set-mirrors').checked, txt: __text('set-mirrors-text'), get: F1.ui.getMirrors(),
        store: localStorage.getItem('f1drive.hud'), cls: document.getElementById('hud').classList.contains('no-mirrors') })`);
      await mouseClick('#set-mirrors');
      check('setMirrors({available: false}) (the game cannot draw them): switch disabled (無法顯示), HUD without mirrors, the setting itself kept; a click does nothing',
        st.dis && !st.box && st.txt === '無法顯示' && st.get === true && st.store === '{"mirrors":true}' && st.cls && (await calls()) === '[]', st);
      await js(`F1.ui.setMirrors({ available: true }); F1.ui.setMirrors({ on: false })`);
      // session start brings the GP tab forward
      await tab('mp');
      await setGp(M.V.quali3({}));
      check('a Grand Prix starting (free -> quali) switches to the 大獎賽 tab (not remembered)', await js(`__rect('gp-panel').shown && JSON.parse(localStorage.getItem('f1drive.menu')).tab === 'mp'`));
      await setGp(M.V.freeTrack);
      await tab('set');
      // reload: everything restored
      await load();
      st = await js(`({ tab: document.querySelector('.menu-tabs .on').id, car: F1.ui.getCar(), year: F1.ui.getYear(), audio: JSON.stringify(F1.ui.getAudio()), vol: document.getElementById('set-volume').value,
        mute: document.getElementById('set-mute').checked, wear: document.querySelector('#gp-wear .on').getAttribute('data-w'), mirrors: F1.ui.getMirrors(), mbox: document.getElementById('set-mirrors').checked,
        cls: document.getElementById('hud').classList.contains('no-mirrors') })`);
      check('reload: tab, car, year, audio, wear and the mirrors setting (off) restored', st.tab === 'tab-set' && st.car === '2026-ferrari' && st.year === 2012 && st.audio === '{"volume":0.35,"muted":true}' &&
        st.vol === '35' && st.mute && st.wear === '3' && st.mirrors === false && !st.mbox && st.cls, st);
      await js(`localStorage.setItem('f1drive.car', '{"year":1999.5,"car":"Constructor Evil!"}'); localStorage.setItem('f1drive.audio', '{"volume":"loud","muted":1}');
        localStorage.setItem('f1drive.menu', '{"tab":"__proto__"}'); localStorage.setItem('f1drive.gp', '{"q":3,"r":5,"wear":99}'); localStorage.setItem('f1drive.hud', '{"mirrors":"off"}')`);
      await load();
      st = await js(`({ tab: document.querySelector('.menu-tabs .on').id, car: F1.ui.getCar(), year: F1.ui.getYear(), audio: JSON.stringify(F1.ui.getAudio()), wear: document.querySelector('#gp-wear .on').getAttribute('data-w'), mirrors: F1.ui.getMirrors() })`);
      check('reload with junk in storage: validated (car / year null, audio defaults, tab 大獎賽, wear clamped to 5, mirrors on)', st.tab === 'tab-gp' && st.car === null && st.year === null && st.audio === '{"volume":0.8,"muted":false}' && st.wear === '5' &&
        st.mirrors === true, st);
      await js(`localStorage.setItem('f1drive.car', 'not json'); localStorage.setItem('f1drive.audio', '[1,2]'); localStorage.setItem('f1drive.gp', '{"wear":"3"}'); localStorage.setItem('f1drive.hud', 'not json')`);
      await load();
      st = await js(`({ car: F1.ui.getCar(), audio: JSON.stringify(F1.ui.getAudio()), wear: document.querySelector('#gp-wear .on').getAttribute('data-w'), mirrors: F1.ui.getMirrors() })`);
      check('reload with corrupt storage: defaults', st.car === null && st.audio === '{"volume":0.8,"muted":false}' && st.wear === '1' && st.mirrors === true, st);
    }

    /* ================= v6.2: Chinese track cards + search, 視野 (FOV), the starting compound ================= */
    if (part('v62')) {
      await size(1280, 720);
      await load();
      await setNet(M.NET.off); await setGp(M.V.freeTrack); await setCars(cars(L26));
      // the cards: the Chinese name, the English one under it (smaller), the Chinese location; F1_TRACKS order kept
      let st = await js(`(function () { var c = [].slice.call(document.querySelectorAll('#track-grid .card')), Z = window.F1_TRACK_NAMES_ZH || {};
        var bad = c.map(function (n, i) { var t = F1_TRACKS[i], z = Z[t.id] || {}, nm = n.querySelector('.card-name'), en = n.querySelector('.card-en'), loc = n.querySelector('.card-meta span');
          return Number(n.getAttribute('data-i')) === i && nm.textContent === z.name && en && en.textContent === t.name && loc.textContent === z.location &&
            parseFloat(getComputedStyle(en).fontSize) < parseFloat(getComputedStyle(nm).fontSize) ? null : [i, t.id, nm.textContent, en && en.textContent, loc.textContent]; }).filter(Boolean);
        var i = F1_TRACKS.findIndex(function (t) { return t.id === 'jp-1962'; }), s = c[i];
        return { n: c.length, bad: bad, suzuka: s ? s.querySelector('.card-info').innerText.replace(/\\s+/g, ' ') : null, cut: c.filter(function (n) { return n.scrollWidth > n.clientWidth + 1; }).length }; })()`);
      check('v6.2 cards: all 40 show the Chinese name (js/track-names-zh.js), the English name smaller under it and the Chinese location, in F1_TRACKS order',
        st.n === 40 && !st.bad.length && /鈴鹿賽道/.test(st.suzuka) && /Suzuka International Racing Course/.test(st.suzuka) && /日本 鈴鹿/.test(st.suzuka) && st.cut === 0, st);
      await shot('v62-menu-cards');
      // the search: real keys for Latin text, the input event for Chinese (an IME's commit)
      const typeQ = async q => {
        await js(`(function () { var s = document.getElementById('track-search'); s.value = ''; s.focus(); s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        if (/^[a-z ]+$/.test(q)) { for (const ch of q) w.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(120); }
        else await js(`(function () { var s = document.getElementById('track-search'); s.value = ${J(q)}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        return js(`({ value: document.getElementById('track-search').value, ids: [].slice.call(document.querySelectorAll('#track-grid .card')).filter(function (n) { return !n.classList.contains('hidden'); })
          .map(function (n) { return F1_TRACKS[Number(n.getAttribute('data-i'))].id; }), count: __text('track-count'), empty: __rect('track-empty').shown })`);
      };
      const usIds = await js(`F1_TRACKS.filter(function (t) { return /^us-/.test(t.id); }).map(function (t) { return t.id; })`);
      const Q = [['japan', ['jp-1962']], ['suzuka', ['jp-1962']], ['日本', ['jp-1962']], ['鈴鹿', ['jp-1962']], ['铃鹿', ['jp-1962']], ['japanese gp', ['jp-1962']],
        ['usa', usIds], ['us', usIds], ['美國', usIds], ['uk', ['gb-1948']], ['britain', ['gb-1948']], ['英國', ['gb-1948']], ['italy', null], ['義大利', null],
        ['uae', ['ae-2009']], ['阿布達比', ['ae-2009']], ['nurburgring', ['de-1927']], ['吉爾‧維倫紐夫', ['ca-1978']], ['蒙扎', ['it-1922']], ['xyzzy', []]];
      const bad = [];
      for (const [q, want] of Q) {
        const r = await typeQ(q);
        const ok = r.value === q && (want === null ? r.ids.length === 3 && r.ids.every(id => /^it-/.test(id)) : J(r.ids) === J(want)) &&
          r.count === r.ids.length + ' / 40 條賽道' && r.empty === (r.ids.length === 0);
        if (!ok) bad.push({ q, got: r.ids, count: r.count, value: r.value });
        if (q === 'japan') await shot('v62-search-japan');
        if (q === '鈴鹿') await shot('v62-search-suzuka-zh');
      }
      check('v6.2 search: japan / suzuka / 日本 / 鈴鹿 / 铃鹿 / japanese gp find Suzuka only; usa / us / 美國 the 5 US circuits; uk / britain / 英國 Silverstone; italy / 義大利 the 3 Italian; uae, 阿布達比, nurburgring, 吉爾‧維倫紐夫 (the IME dot), 蒙扎 (an alias); nonsense: none, the empty note',
        bad.length === 0, bad);
      await js(`(function () { var s = document.getElementById('track-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); s.blur(); })()`);
      check('v6.2 search cleared: all 40 again', (await js(`__text('track-count')`)) === '40 條賽道');

      // 設定 → 視野: the range of F1.COCKPIT_FOV, the default, real keys on the slider, remembered
      await tab('set');
      st = await js(`({ min: document.getElementById('set-fov').min, max: document.getElementById('set-fov').max, val: document.getElementById('set-fov').value, txt: __text('set-fov-val'),
        get: F1.ui.getFov(), def: F1.COCKPIT_FOV ? F1.COCKPIT_FOV.def : null, store: localStorage.getItem('f1drive.fov'), note: __text('set-fov-note'), row: __rect('set-fov-val'), panel: __rect('set-panel') })`);
      check('v6.2 設定 視野: slider 50..75 (F1.COCKPIT_FOV), default 60 (60°), nothing stored yet, inside the panel', st.min === '50' && st.max === '75' && st.val === '60' && st.txt === '60°' &&
        st.get === 60 && st.def === 60 && st.store === null && /60°/.test(st.note) && st.row.r <= st.panel.r, st);
      await shot('v62-settings-fov');
      await js(`__calls.length = 0`);
      await mouseClick('#set-fov');
      const fovClick = JSON.parse(await calls());
      await js(`__calls.length = 0; document.getElementById('set-fov').focus()`);
      for (let k = 0; k < 4; k++) { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' }); await sleep(60); }
      const before = await js(`F1.ui.getFov()`);
      st = await js(`({ calls: JSON.stringify(__calls), get: F1.ui.getFov(), txt: __text('set-fov-val'), store: localStorage.getItem('f1drive.fov') })`);
      const v0 = fovClick.length ? fovClick[fovClick.length - 1][1] : 60;
      check('v6.2 視野 (real mouse, then 4 x Right on the slider): onFov per whole degree, getFov, the label and f1drive.fov follow',
        fovClick.every(c => c[0] === 'fov' && Number.isInteger(c[1]) && c[1] >= 50 && c[1] <= 75) && JSON.parse(st.calls).map(c => c[1]).join() === [1, 2, 3, 4].map(k => Math.min(75, v0 + k)).join() &&
        st.get === Math.min(75, v0 + 4) && st.txt === st.get + '°' && st.store === J({ fov: st.get }), { fovClick, st, before });
      await js(`(function () { var s = document.getElementById('set-fov'); s.value = '72'; s.dispatchEvent(new Event('input', { bubbles: true })); s.blur(); })()`);
      await load();
      st = await js(`({ get: F1.ui.getFov(), val: document.getElementById('set-fov').value, txt: __text('set-fov-val') })`);
      check('v6.2 視野: reload restores 72', st.get === 72 && st.val === '72' && st.txt === '72°', st);
      await js(`localStorage.setItem('f1drive.fov', '{"fov":99}')`); await load();
      const hi = await js(`F1.ui.getFov()`);
      await js(`localStorage.setItem('f1drive.fov', '{"fov":"70"}')`); await load();
      const str = await js(`F1.ui.getFov()`);
      await js(`localStorage.setItem('f1drive.fov', 'not json')`); await load();
      const junk = await js(`F1.ui.getFov()`);
      check('v6.2 視野: stored 99 -> 75, a string -> the default 60, corrupt -> 60', hi === 75 && str === 60 && junk === 60, { hi, str, junk });
      await js(`localStorage.removeItem('f1drive.fov')`);

      // 大獎賽 → 起跑輪胎 (= main.js's next set): real mouse, setCompound, the label / note by phase, guests too
      await load();
      await setNet(M.NET.off); await setGp(M.V.freeTrack); await setCars(cars(L26));
      await tab('gp');
      const tyre = () => js(`({ on: [].slice.call(document.querySelectorAll('#gp-tyre button')).map(function (b) { return b.textContent + (b.classList.contains('on') ? '*' : ''); }).join(' '),
        aria: [].slice.call(document.querySelectorAll('#gp-tyre button')).map(function (b) { return b.getAttribute('aria-checked'); }).join(' '),
        label: __text('gp-tyre-label'), note: __text('gp-tyre-note'), row: __rect('gp-tyre-row'), panel: __rect('mp-panel'), start: __rect('gp-open'), calls: JSON.stringify(__calls) })`);
      st = await tyre();
      // (v7.2: 在目前賽道開大獎賽… in the place of the start button)
      check('v6.2 大獎賽: 起跑輪胎 軟 / 中 / 硬 with 中 marked (the default set), the note names T and the controller\'s X, 在目前賽道開大獎賽… still above the fold',
        st.on === '軟 中* 硬' && st.aria === 'false true false' && st.label === '起跑輪胎' && /T/.test(st.note) && /X/.test(st.note) && st.row.shown && st.start.shown && st.start.b <= st.panel.b, st);
      await shot('v62-gp-tyre-free');
      const storage = () => js(`JSON.stringify(Object.keys(localStorage).sort().map(function (k) { return [k, localStorage.getItem(k)]; }))`);
      const store0 = await storage();
      await js(`__calls.length = 0`);
      await mouseClick('#gp-tyre button[data-c="S"]');
      st = await tyre();
      const store1 = await storage();
      check('v6.2 大獎賽: 軟 clicked (real mouse) -> onCompound(S), marked at once; nothing stored (main.js owns the next set)', st.calls === '[["compound","S"]]' && st.on === '軟* 中 硬' &&
        store1 === store0, { st, store0, store1 });
      await js(`__calls.length = 0; F1.ui.setCompound('H'); F1.ui.setCompound('Z'); F1.ui.setCompound(null); F1.ui.setCompound(7)`);
      st = await tyre();
      check('v6.2 setCompound (T / X while driving): H marked, junk ignored, no onCompound', st.on === '軟 中 硬*' && st.calls === '[]', st);
      await setGp(M.V.quali3({}));
      st = await tyre();
      check('v6.2 大獎賽 in qualifying: the row says 下一組輪胎 (the grid and the next stop)', st.label === '下一組輪胎' && /正賽起跑/.test(st.note) && st.row.shown && st.on === '軟 中 硬*', st);
      await shot('v62-gp-tyre-quali');
      await setGp(M.V.freeTrack);
      await setNet(M.NET.guest(3)); await setGp(M.V.freeGuest);
      st = await tyre();
      check('v6.2 大獎賽 as a guest (no setup of the room): the tyre row is there (every driver picks his own set)', st.row.shown && st.label === '起跑輪胎', st);
      await setNet(M.NET.off); await setGp(M.V.freeTrack);
      await size(700, 720);
      st = await tyre();
      const cutTyre = await js(`document.getElementById('gp-tyre-row').scrollWidth <= document.getElementById('gp-tyre-row').clientWidth + 1`);
      check('v6.2 大獎賽 700 px: the tyre row fits', cutTyre && st.row.shown, st.row);
      await size(1280, 720);
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
        if (!c) return null; c.click(); document.getElementById('setup-go').click(); return c.querySelector('.card-name').textContent; })()`);
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
