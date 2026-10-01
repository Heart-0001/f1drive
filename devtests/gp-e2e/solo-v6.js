// A whole SINGLE-PLAYER v6 Grand Prix (seasons, cars, battery, tyre wear, a pit stop) from the menu to the results,
// driven by the autopilot in the REAL game (offscreen Electron), time-warped.
//
//   npx electron devtests/gp-e2e/solo-v6.js           (from the project root; about 2 min; exit code 1 when a check fails)
//
//   env ONLY=monza,suzuka,zandvoort,monza26 (default: all four)   VERBOSE=1 (detail of passed checks too)
//       RENDER_EVERY=n (draw every n-th warped frame for real; default 600)   PIT_AFTER=n (the stop is decided at the end
//       of race lap n and driven in the next lap; default 2: half distance)   PATCH='js/main.js=copy.js,...' (as solo.js)
//       FRAME_MS=n (another frame pace than 1/60 s)   JITTER=1 (irregular frames, 5..35 ms)
//   Screenshots: devtests/gp-e2e/out-solo-v6/<run>-NN-<what>.png (READ them); with PATCH in out-solo-v6/patched/.
//   SILENT: the windows are muted by devtests/electron-userdata.js (never set SOUND); the last check (part 'sound',
//   silence.js) proves it: every window muted and never audible, the Windows volume mixer saw nothing of this process.
//
// Runs (each in its own window, a fresh profile):
//   monza      2012, the Red Bull RB8      Q 1 / R 6, tyre wear x5; the KERS A/B on the start straight first
//   suzuka     2012, the McLaren MP4-27    the same Grand Prix
//   zandvoort  2012, the Ferrari F2012     the same; Zandvoort's banked corners (19 deg) and its 60 km/h pit lane whose
//              box 1 lies just BEFORE the line (the stop and the crossing are in the same lap)
//   monza26    2026, the Mercedes W17      the ERS A/B on the start straight (compared with the 2012 KERS), the same
//              Grand Prix, but the pit stop is driven at the limit + 25 km/h WITHOUT the limiter: speeding, +5 s
// Each run: 年份 picked with real keys on the select of the 車輛 tab (the label clicked to focus it, the year typed:
// type-ahead), the car card clicked; year / car in the menu, the 大獎賽 tab, the HUD session box, the telemetry graphic and
// the results; T (real key) in free practice picks hards for the Grand Prix (strategy: at x5 a medium set lasts only
// 1.7..2.2 laps of the autopilot - 46..59 % a lap with a 2012 car - and a hard one twice that, so the one-stop race is
// hards -> hards with the stop at half distance); Q / R typed, 輪胎損耗 ×5 clicked, 開始大獎賽; parc fermé in qualifying;
// out lap + 1 timed lap; grid; lights; 6 race laps with the autopilot deploying the battery on the straights (RB held:
// solo-page.js's battery manager) and pacing itself on the grip its tyres have left (ap.gripPace); T pressed three times
// in race lap 1 (soft, medium, back to hard: the telemetry's next-compound indicator follows); ONE pit stop, in lap 3:
// Q (real key) 15 m before the entry curtain, the lane at the limit, box 1 (slot 0), the random service (2.0..4.5 s, +5 s
// penalty when speeding), the hards chosen with T, out, Q off once past the exit curtain; tyre wear rising lap by lap in
// the telemetry's tyre data and the grip dropping, restored by the stop; every lap against the ground truth (physics steps
// + steps held in the box), the lap through the pit lane counted, the race total = the session clock from lights out;
// results; 結束 back to free practice with the car free again.
//
// Time under the warp (the harness's own finding, see solo.js too): the Grand Prix clock alone is the game clock
// (js/gp.js update(dt)); the pit service counts down in pit.update(STEP) every physics step (main.js frame(): held in the
// box, lap.update(idx, 0, STEP)): game clock, so its 2.0..4.5 s are game seconds; the toast ELEMENT hides on a
// wall-clock setTimeout (js/ui.js toast): toasts are read from solo-page.js's log of the F1.ui.toast calls (game clock);
// the telemetry graphic smooths / flashes on performance.now() unless F1.telemetry.clock is replaced (solo-page.js does);
// the light curtains pulse on the rAF timestamp (synthetic: game time). Audio runs on the real audio clock (muted).
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'gp-e2e-solo-v6');
const ONLY = (process.env.ONLY || '').toLowerCase().split(',').filter(Boolean);
const VERBOSE = !!process.env.VERBOSE;
const RENDER_EVERY = process.env.RENDER_EVERY === undefined ? 600 : Number(process.env.RENDER_EVERY) || 0;
// the one stop at half distance: decided at the end of race lap PIT_AFTER, driven in the next lap (the in-lap)
const PIT_AFTER = Number(process.env.PIT_AFTER) >= 1 ? Math.floor(Number(process.env.PIT_AFTER)) : 2;
const PATCH = (process.env.PATCH || '').split(/[;,]/).map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim().replace(/\\/g, '/'), path.resolve(ROOT, p.slice(i + 1).trim())]; });
// (a run against patched copies keeps its screenshots apart: out-solo-v6/patched/)
const OUT = path.join(__dirname, 'out-solo-v6', PATCH.length ? 'patched' : '');
const PAGE_LIB = fs.readFileSync(path.join(__dirname, 'solo-page.js'), 'utf8');
const V6_LIB = fs.readFileSync(path.join(__dirname, 'solo-v6-page.js'), 'utf8');

const FRAME_MS = Number(process.env.FRAME_MS) || 1000 / 60, JITTER = !!process.env.JITTER;
const Q = 1, R = 6, WEAR = 5, STEP = 1 / 120, CLOCK_BASE = 1000000;
const FRAME = (JITTER ? 35 : FRAME_MS) / 1000;                       // the longest warped frame, s
const RUNS = {
  monza: { id: 'it-1922', year: 2012, car: '2012-red-bull', ab: true, escInService: true },
  suzuka: { id: 'jp-1962', year: 2012, car: '2012-mclaren' },
  zandvoort: { id: 'nl-1948', year: 2012, car: '2012-ferrari' },
  monza26: { id: 'it-1922', year: 2026, car: '2026-mercedes', ab: true, speeding: true }
};
const NEXT = 'H';                     // the compound picked with T for the stop (M -> H: one press)
const COMPOUND_ZH = { S: '軟胎', M: '中性胎', H: '硬胎' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const r3 = t => Math.round(t * 1000) / 1000;
const fmt = t => { if (t == null || t !== t) return '--'; const ms = Math.round(t * 1000); return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0'); };
const maxOf = a => Math.max.apply(null, a);
const lastOf = a => a[a.length - 1];

const results = [], report = {};
let part = '';
function check(name, ok, detail) {
  results.push({ name: part + ': ' + name, ok: !!ok });
  const d = detail !== undefined && (!ok || VERBOSE) ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : '';
  console.log((ok ? 'PASS ' : 'FAIL ') + part + ': ' + name + d);
  return !!ok;
}
const info = s => console.log('     ' + part + ': ' + s);

/* ---------- the page: the real index.html, or a copy with some scripts replaced (PATCH) ---------- */
function pageFile() {
  if (!PATCH.length) return path.join(ROOT, 'index.html');
  const own = PATCH.find(p => p[0] === 'index.html');            // index.html=<copy>: the page itself replaced
  let html = fs.readFileSync(own ? own[1] : path.join(ROOT, 'index.html'), 'utf8');
  for (const [src, file] of PATCH) {
    if (src === 'index.html') continue;
    const tag = '<script src="' + src + '"></script>';
    if (html.indexOf(tag) < 0) throw new Error('PATCH: no script tag for ' + src + ' in index.html');
    if (!fs.existsSync(file)) throw new Error('PATCH: ' + file + ' does not exist');
    html = html.replace(tag, '<script src="' + url.pathToFileURL(file).href + '"></script>');
  }
  const file = path.join(OUT, 'index-patched-' + process.pid + '.html');
  fs.writeFileSync(file, html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">'));
  return file;
}

let winSeq = 0;
function makeWin(tag) {
  const w = new BrowserWindow({
    width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'gpe2e-solo-v6-' + tag + '-' + (++winSeq),
      preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false }
  });
  w.webContents.setFrameRate(60);
  w.errors = []; w.log = []; w.tag = tag; w.shots = 0; w.wallPump = 0; w.framesPumped = 0; w.shotFiles = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;    // dev-only CSP notice
    w.errors.push(msg);
    console.log('[' + tag + ' console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('renderer gone: ' + d.reason); console.log('[' + tag + '] renderer gone', d.reason); });
  w.js = code => w.webContents.executeJavaScript(code);
  w.open = async () => {
    await w.loadFile(pageFile());
    await sleep(700);
    const lib = await w.js(PAGE_LIB);
    const v6 = await w.js(V6_LIB);
    await w.js(`__e.renderEvery = ${RENDER_EVERY}; __e.setPace(${FRAME_MS}, ${JITTER})`);
    return { lib, v6, overlay: await w.overlay() };
  };
  w.overlay = () => w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  w.snap = () => w.js(`__e.snap()`);
  w.sync = async () => { const more = await w.js(`(__e.observeDom(), __e.log.slice(${w.log.length}))`); for (const e of more) w.log.push(e); return w.log.length; };
  w.evs = (type, from) => w.log.filter(e => e.type === type && e.i >= (from || 0));
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(30); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  // pump warped frames until cond (E = __e, F1, g = F1.game) holds, for at most maxS s of GAME time
  w.pump = async (cond, maxS, what) => {
    const start = await w.js(`__e.clock`);
    for (;;) {
      const r = await w.js(`__e.run(200000, ${J(cond)}, 150)`);
      w.wallPump += r.wall; w.framesPumped += r.n;
      if (r.fatal) { await w.sync(); throw new Error('error overlay: ' + r.fatal); }
      if (r.hit) { await w.sync(); return true; }
      if (r.idle || r.clock - start > maxS * 1000) {
        await w.sync();
        const s = await w.snap();
        console.log((r.idle ? 'NOT RUNNING ' : 'TIMEOUT (' + maxS.toFixed(0) + ' s of game time) ') + tag + ': ' + (what || cond) + '  ' +
          J({ car: s.car, gp: s.gp, lap: s.lap, truth: s.truth, ap: s.ap, pit: s.pitState, recent: w.log.slice(-6).map(e => e.type) }));
        return false;
      }
    }
  };
  w.advance = async sec => { const t = await w.js(`__e.clock`); return w.pump(`E.clock >= ${t + sec * 1000}`, sec + 5, sec + ' s'); };
  w.frames = async n => { const r = await w.js(`__e.run(${n}, '', 2000)`); w.wallPump += r.wall; w.framesPumped += r.n; await w.sync(); return r; };
  // a screenshot of what the player would see now (one real frame drawn: the warp skips rendering)
  w.shot = async (name, noDraw) => {
    if (!noDraw) await w.js(`__e.draw()`);
    await sleep(220);
    const file = tag + '-' + String(++w.shots).padStart(2, '0') + '-' + name + '.png';
    fs.writeFileSync(path.join(OUT, file), (await w.webContents.capturePage()).toPNG());
    w.shotFiles.push(file);
    return file;
  };
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  w.tap = async k => { w.key(k, true); await sleep(50); w.key(k, false); await sleep(80); };
  w.clickAt = async (x, y) => {
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  // a real mouse click in the middle of an element (scrolled into view first); sel = a CSS selector
  w.click = async sel => {
    const r = await w.js(`(function () { var e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, h: r.height, hit: !!top && (top === e || e.contains(top)), disabled: !!e.disabled }; })()`);
    if (!r || !(r.w > 0) || !r.hit || r.disabled) { console.log('click: ' + sel + ' cannot be clicked ' + J(r)); return false; }
    await w.clickAt(Math.round(r.x), Math.round(r.y));
    return true;
  };
  w.type = async (sel, text) => {
    if (!await w.click(sel)) return null;
    w.webContents.selectAll();
    await sleep(60);
    for (const ch of text) w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    await sleep(120);
    return w.js(`document.querySelector(${J(sel)}).value`);
  };
  w.text = sel => w.js(`(function () { var e = document.querySelector(${J(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  w.shown = sel => w.js(`(function () { var e = document.querySelector(${J(sel)}); return !!e && __e.shown(e); })()`);
  w.esc = async toMenu => { await w.tap('Escape'); return w.until(toMenu ? `!F1.game.running && __e.shown('menu')` : `F1.game.running && !__e.shown('menu')`, 3000, toMenu ? 'Esc -> menu' : 'Esc -> resume'); };
  w.noErrors = async what => { const o = await w.overlay(); return check('no error overlay, no console errors / warnings' + (what ? ' (' + what + ')' : ''), !o && w.errors.length === 0, o || w.errors.slice(0, 3)); };
  w.toastsSince = from => w.evs('toastCall', from).map(e => e.text);
  return w;
}

/* ---------- menu pieces ---------- */

// 年份: the label is clicked (it focuses the select without opening its popup, which cannot be shown offscreen), then the
// year is TYPED: the select's type-ahead picks "2012 年" and fires 'change' (2025 -> 2024 -> 2019 -> 2012 on the way).
async function pickYearByKeys(w, year) {
  const before = await w.js(`document.getElementById('car-year').value`);
  await w.js(`window.__yearChanges = []; document.getElementById('car-year').addEventListener('change', function (e) { __yearChanges.push(e.target.value); }); true`);
  await w.click('label[for="car-year"]');
  let how = 'label clicked (focus)';
  if (!await w.js(`document.activeElement === document.getElementById('car-year')`)) {
    await w.js(`document.getElementById('car-year').focus(); true`);
    how = 'select.focus() (the label click did not focus it)';
  }
  for (const ch of String(year)) {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(80);
  }
  await sleep(300);
  const r = await w.js(`({ value: document.getElementById('car-year').value, text: document.getElementById('car-year').selectedOptions[0].textContent, changes: __yearChanges,
    spec: F1.game.spec.id, year: F1.game.spec.year, focused: document.activeElement && document.activeElement.id,
    cards: [].map.call(document.querySelectorAll('#car-list .car-card'), function (c) { return c.getAttribute('data-id'); }), season: document.getElementById('car-season').textContent })`);
  return Object.assign(r, { before, how });
}

const carInfo = w => w.js(`(function () { var s = F1.game.spec, st = F1.game.car.state, on = document.querySelector('#car-list .car-card.on');
  return { id: s.id, year: s.year, team: s.team, teamZh: s.teamZh, car: s.car, engine: s.engine, colour: s.colour, gears: s.gearKmh.length + 1, rpmShift: s.rpmShift, rpmMax: s.rpmMax,
    cyl: s.cylinders, asp: s.aspiration, ers: s.ers, cockpit: s.cockpit, battery: st.battery, on: on ? on.getAttribute('data-id') : null,
    stored: localStorage.getItem('f1drive.car'), profile: F1.net ? F1.net.getProfile().car : null, topKmh: F1.game.car.perf.topSpeed * 3.6, boostKmh: F1.game.car.perf.topSpeedBoost * 3.6 }; })()`);

/* ---------- the battery A/B on the start straight ---------- */
// From the start position (free practice, the track just loaded: full battery, new tyres): W held (real key) and the
// stick following the centreline for `len` metres -> speed there. The track card clicked again (the car back on the
// start position, battery full), then W + E held over the same distance. The same frames, the same start: the only
// difference is the battery.
async function abTest(w, cfg, rep, trackIdx) {
  const st = await w.js(`({ m: __v6.straightFromStart(F1.game.car.perf.topSpeed * 3.6 * 0.99), top: F1.game.car.perf.topSpeed * 3.6 })`);
  const len = Math.round(Math.min(st.m - 40, 900));
  info('battery A/B: ' + len + ' m from the start position (the car\'s racing line starts braking from its top speed after ' + st.m.toFixed(0) + ' m)');
  // A: W only
  w.key('W', true);
  const keysA = await w.until(`F1.game.input.up && !F1.game.boost`, 3000, 'W arrives');
  const a = await w.js(`__v6.ab(${len})`);
  w.key('W', false);
  await w.until(`!F1.game.input.up`, 2000, 'W released');
  // the pad back at rest, the autopilot off (as before A: the standing frames below must not turn the wheel)
  await w.js(`__v6.steerOnly = false; __e.ap.on = false; __e.pad.axes[0] = 0; __e.pad.axes[1] = 0; true`);
  // the track again: start position, full battery
  check('A/B: Esc, the same track card clicked again: the car is back on the start position, standing, battery full', await w.esc(true) && await w.click(`#track-grid .card[data-i="${trackIdx}"]`) &&
    await w.until(`F1.game.running && __e.queued() === 1 && F1.game.car.state.speed === 0 && F1.game.car.state.battery === 1`, 20000, 'reload'));
  await w.js(`__e.hookCar(); true`);
  await w.frames(3);                         // (as after the first load: the ground truth rebases on the new track)
  const at = await w.js(`({ i: F1.game.car.state.sampleIndex, d: F1.game.car.state.d, v: F1.game.car.state.speed, truth: __e.truth.idx, n: F1.game.track.samples.length })`);
  check('A/B: B starts where A started (the start position, 10 samples before the line, standing; the ground truth on the new track)', at.i === at.n - 10 && Math.abs(at.d) < 0.01 && at.v === 0 && at.truth === at.i, at);
  // B: W + E, a screenshot half way
  w.key('W', true); w.key('E', true);
  const keysB = await w.until(`F1.game.input.up && F1.game.boost`, 3000, 'W + E arrive');
  const b1 = await w.js(`__v6.ab(${Math.round(len * 0.55)})`);
  const shotTel = b1.tel;
  const shot = await w.shot('ers-deploying-on-the-straight');
  const b = await w.js(`__v6.ab(${len} - ${b1.dist})`);
  w.key('E', false); w.key('W', false);
  await w.until(`!F1.game.input.up && !F1.game.boost`, 2000, 'keys released');
  await w.js(`__v6.steerOnly = false; true`);
  const spec = (await carInfo(w)).ers;
  const gain = b.kmh - a.kmh, used = (1 - b.battery) * spec.store, dep = b1.deployFrames + b.deployFrames, depS = b1.deployT + b.deployT;
  const res = { len, a: { kmh: a.kmh, battery: a.battery, deployFrames: a.deployFrames, dist: a.dist, timeS: a.timeS, grass: a.grass, hits: a.hits },
    b: { kmh: b.kmh, battery: b.battery, deployFrames: dep, dist: b1.dist + b.dist, timeS: b1.timeS + b.timeS, emptyAt: b1.emptyAt !== null ? b1.emptyAt : (b.emptyAt !== null ? b1.timeS + b.emptyAt : null), grass: b1.grass + b.grass, hits: b1.hits + b.hits, maxDeploy: Math.max(b1.maxDeploy, b.maxDeploy) },
    gain, usedJ: used, deployS: depS, powerWkg: depS > 0 ? used / depS : 0, store: spec.store, power: spec.power, fullS: spec.store / spec.power, shot, shotTel };
  rep.ab = res;
  info('battery A/B over ' + len + ' m: W only ' + a.kmh.toFixed(1) + ' km/h, W + E ' + b.kmh.toFixed(1) + ' km/h (+' + gain.toFixed(1) + '); deployed ' + depS.toFixed(1) + ' s, ' + used.toFixed(0) + ' J/kg = ' +
    res.powerWkg.toFixed(1) + ' W/kg on average (spec ' + spec.power.toFixed(1) + ' W/kg, store ' + spec.store.toFixed(0) + ' J/kg = ' + res.fullS.toFixed(1) + ' s at full deploy); empty after ' + (res.b.emptyAt === null ? 'never' : res.b.emptyAt.toFixed(2) + ' s'));
  check('A/B: keys through the real input path (W, then W + E held; the stick on the centreline, the triggers at rest)', keysA && keysB && a.upKey && !a.boostKey && b.upKey && b.boostKey);
  check('A/B: both runs on the road over the whole distance (no grass, no wall), the same distance (' + len + ' m)', res.a.grass === 0 && res.a.hits === 0 && res.b.grass === 0 && res.b.hits === 0 && a.dist >= len && res.b.dist >= len && Math.abs(a.dist - res.b.dist) < 4,
    { a: res.a, b: res.b });
  check('A/B: W only: no deploy, the battery stays full', a.deployFrames === 0 && a.battery === 1, res.a);
  check('A/B: E held: the battery deploys (state.deploy up to ' + res.b.maxDeploy.toFixed(2) + ') and drains (' + (1 - b.battery).toFixed(3) + ' of the store used); the telemetry graphic got it half way (deploy ' + (shotTel && shotTel.deploy.toFixed(2)) + ', battery ' + (shotTel && shotTel.battery.toFixed(3)) + ')',
    dep > 30 && res.b.maxDeploy > 0.9 && b.battery < 1 && shotTel && shotTel.deploy > 0 && shotTel.battery < 1 && shotTel.battery === b1.battery, { shotTel, b: res.b });
  check('A/B: the deploy power is the car\'s (' + res.powerWkg.toFixed(1) + ' W/kg on average over the frames deploying; at most the spec\'s ' + spec.power.toFixed(1) + ' W/kg: near the start the tyres limit it)', res.powerWkg <= spec.power * 1.001 && res.powerWkg > spec.power * 0.25, res);
  if (cfg.year <= 2013) {
    check('KERS (' + cfg.year + '): a SMALL store: ' + spec.store.toFixed(0) + ' J/kg = ' + res.fullS.toFixed(1) + ' s at full deploy (the 2025 reference car: ' + (4656.67 / 145.52).toFixed(0) + ' s); E held all the way: empty after ' + res.deployS.toFixed(2) + ' s of deploying (' + (res.b.emptyAt === null ? '-' : res.b.emptyAt.toFixed(2)) + ' s after the start), then nothing more',
      spec.store < 1000 && res.fullS < 8 && res.b.emptyAt !== null && res.deployS >= res.fullS * 0.98 && res.deployS <= res.fullS * 2 && b.battery === 0 && b.deploy === 0, res);
    check('KERS: faster with E (+' + gain.toFixed(1) + ' km/h after ' + len + ' m)', gain > 1, { gain });
  } else {
    check('ERS (' + cfg.year + '): much more power: +' + gain.toFixed(1) + ' km/h after ' + len + ' m with E (spec ' + spec.power.toFixed(0) + ' W/kg, the 2025 reference car 146 W/kg' +
      (report.monza && report.monza.ab ? ', the 2012 KERS here +' + report.monza.ab.gain.toFixed(1) + ' km/h' : '') + ')',
      gain >= 20 && spec.power > 400 && (!(report.monza && report.monza.ab) || (gain > 3 * report.monza.ab.gain && res.powerWkg > 3 * report.monza.ab.powerWkg)), { gain, res, kers2012: report.monza && report.monza.ab ? { gain: report.monza.ab.gain, powerWkg: report.monza.ab.powerWkg } : null });
    check('ERS: a big store: ' + spec.store.toFixed(0) + ' J/kg (' + res.fullS.toFixed(1) + ' s at full deploy), still ' + (b.battery * 100).toFixed(0) + ' % after ' + res.b.timeS.toFixed(1) + ' s of E', spec.store > 4000 && b.battery > 0.2, res);
  }
  return res;
}

/* ---------- a pit stop (solo-page.js's pit-lane driver through the fake controller; Q / T are real keys) ---------- */
const PIT_BEFORE = 420;          // m before pit.from where the pit driver takes over from the line autopilot
const nearPit = m => `(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - E.truth.idx) % N + N) % N, m = k * g.track.length / N;
  return m < ${m} && m > ${m - 60}; })()`;
async function pitStop(w, ctx, o) {
  const ds = ctx.ds, shots = {}, dom = {};
  await w.js(`__e.ap.on = true; if (__e.ap.mode !== 'line') __e.ap.mode = 'line'; true`);
  if (!await w.pump(nearPit(PIT_BEFORE), ctx.pred * 2 + 120, o.what + ': ' + PIT_BEFORE + ' m before the pit lane')) return null;
  const stopsBefore = await w.js(`F1.game.pit.state.stops`), c0 = w.evs('cross').length, from = w.log.length, held0 = await w.js(`__e.truth.held`);
  const plan = await w.js(`__e.pitPlan(${J({ cruise: !!o.limiter, vLane: o.vLane || 0 })})`);
  if (!plan || !plan.ok) { console.log('pitPlan: ' + J(plan)); return null; }
  // Q 15 m before the entry line (the curtain), a screenshot just before it
  if (o.limiter) {
    if (!await w.pump(`E.ap.pit.U >= E.ap.pit.uEn - ${Math.round(15 / ds)}`, 60, o.what + ': 15 m before the entry line')) return null;
    await w.tap('Q');
    if (!await w.until(`F1.game.limiter === true`, 2000, 'Q -> limiter on')) return null;
    dom.limiterOnAt = await w.js(`({ U: __e.ap.pit.U, uEn: __e.ap.pit.uEn, kmh: F1.game.car.state.speed * 3.6, inLane: F1.game.pit.state.inLane })`);
  }
  if (!await w.pump(`E.ap.pit.U >= E.ap.pit.uEn - ${Math.round(6 / ds)}`, 60, o.what + ': at the entry curtain')) return null;
  shots.entry = await w.shot('pit-entry-curtain');
  // the stop: a screenshot 1.2 s into the service (the countdown; with a penalty: 罰停中 first)
  if (!await w.pump(`!!g.pit.state.service`, 90, o.what + ': the service starts')) return null;
  const svc0 = await w.js(`({ clock: __e.clock, svc: JSON.parse(JSON.stringify(F1.game.pit.state.service)) })`);
  await w.pump(`E.clock >= ${svc0.clock + 1200}`, 5, '1.2 s into the service');
  dom.svc1 = await w.js(`({ shown: __e.shown('hud-pit-svc'), label: document.getElementById('hud-pit-svc-label').textContent, time: document.getElementById('hud-pit-svc-time').textContent,
    pen: __e.shown('hud-pit-pen') ? document.getElementById('hud-pit-pen').textContent : '', left: F1.game.pit.state.service && F1.game.pit.state.service.left, v: F1.game.car.state.speed, gear: F1.game.car.state.gear })`);
  shots.service = await w.shot('pit-service-countdown');
  if (o.escInService) {
    // Esc in the middle of the service: the menu; 30 s of synthetic frame time + wall time go by; the service, the lap
    // clock and the session clock must not move (main.js runs no frame), and the stop goes on where it was after Esc
    const rd = `({ clock: __e.clock, gp: F1.game.gp.now(), left: F1.game.pit.state.service ? F1.game.pit.state.service.left : null, lap: F1.game.lap.time, held: __e.truth.held, x: F1.game.car.state.x, z: F1.game.car.state.z })`;
    const b = await w.js(rd);
    const menuOk = await w.esc(true) && await w.js(`__e.queued() === 0 && __e.spin(1800)`);
    await sleep(600);
    const m = await w.js(rd), menuDom = await w.js(`({ menu: __e.shown('menu'), resume: __e.shown('menu-resume') })`);
    const back = await w.esc(false);
    await w.frames(1);
    const r1 = await w.js(rd);
    dom.escInService = { before: b, menu: m, after: r1, menuOk, back };
    check('pit: Esc in the middle of the service opens the menu (繼續駕駛 shown): 30 s of frame time + 0.6 s of wall time later the service (' + (b.left || 0).toFixed(3) + ' s left), the lap clock, the session clock and the car have not moved; Esc resumes, the first frame changes nothing',
      menuOk && back && menuDom.menu && menuDom.resume && b.left > 0 && m.left === b.left && m.gp === b.gp && m.lap === b.lap && m.held === b.held && m.x === b.x && m.z === b.z &&
      r1.left === b.left && r1.gp === b.gp && r1.lap === b.lap, dom.escInService);
  }
  if (svc0.svc.penalty > 0) {
    // the penalty is served first: then the tyre change
    await w.pump(`!g.pit.state.service || g.pit.state.service.left < g.pit.state.service.work - 0.5`, 8, 'into the tyre change');
    dom.svc2 = await w.js(`({ shown: __e.shown('hud-pit-svc'), label: document.getElementById('hud-pit-svc-label').textContent, time: document.getElementById('hud-pit-svc-time').textContent,
      pen: __e.shown('hud-pit-pen') ? document.getElementById('hud-pit-pen').textContent : '', left: F1.game.pit.state.service && F1.game.pit.state.service.left })`);
    shots.service2 = await w.shot('pit-service-after-the-penalty');
  }
  if (!await w.pump(`!g.pit.state.service`, 30, o.what + ': the service ends')) return null;
  // leaving: approaching the exit curtain
  if (!await w.pump(`E.ap.pit.U >= E.ap.pit.uEx - ${Math.round(8 / ds)}`, 60, o.what + ': at the exit curtain')) return null;
  dom.exit = await w.js(`({ limiter: F1.game.limiter, kmh: F1.game.car.state.speed * 3.6, inLane: F1.game.pit.state.inLane, tyres: F1.game.tyres.state.compound })`);
  shots.leaving = await w.shot('pit-leaving-exit-curtain');
  let offAfterExit = null;
  if (o.limiter) {
    if (!await w.pump(`!g.pit.state.visit && !g.pit.state.inLane`, 60, o.what + ': out of the lane')) return null;
    offAfterExit = await w.js(`({ U: __e.ap.pit.U, uEx: __e.ap.pit.uEx, limiter: F1.game.limiter })`);
    await w.tap('Q');
    if (!await w.until(`F1.game.limiter === false`, 2000, 'Q -> limiter off')) return null;
  }
  if (!await w.pump(`!E.ap.pit.active`, 60, o.what + ': the pit driver hands back')) return null;
  const pinfo = await w.js(`__e.pitInfo()`), stopsAfter = await w.js(`F1.game.pit.state.stops`);
  // the lap the service was in: the first crossing after the service
  if (!await w.pump(`E.log.filter(function (e) { return e.type === 'cross'; }).slice(${c0}).some(function (c) { return c.held > ${pinfo.rec.svcHeld0}; })`, ctx.pred * 2 + 120, o.what + ': the lap with the stop')) return null;
  await w.frames(1);
  return { plan, info: pinfo, stopsBefore, stopsAfter, shots, dom, svc0, offAfterExit, from, c0, held0 };
}

/* ================= one run ================= */
async function runOne(key) {
  part = key;
  const cfg = RUNS[key], w = makeWin(key), wall0 = Date.now();
  const rep = report[key] = { id: cfg.id, year: cfg.year, car: cfg.car, laps: [], notes: [] };
  for (const f of fs.readdirSync(OUT)) if (f.indexOf(key + '-') === 0 && /\.png$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  try {
    await scenario(w, cfg, rep);
  } catch (err) {
    check('scenario ran to the end', false, err && err.stack ? err.stack : String(err));
    try { await w.shot('crash'); } catch (e) {}
  }
  try {
    await w.sync();
    const tail = await w.js(`({ clockErr: __e.clockErr, padErr: __e.ap.padErr, vis: __e.visChanges, renders: __e.renders, frames: __e.gameFrames, clock: __e.clock })`);
    check('warp: the session clock is exactly the sum of the frame dts the harness fed it (bit for bit)', tail.clockErr === 0 && tail.vis === 0, tail);
    check('autopilot: the controller gave the game exactly what was asked (stick / triggers / RB through js/gamepad.js)', tail.padErr < 1e-9, tail.padErr);
    check('no lap was rejected (no lapRejected event, no 沒有被採計 toast)', w.evs('lapRejected').length === 0 && !w.evs('toastCall').some(e => /沒有被採計/.test(e.text)), w.evs('lapRejected'));
    const rec = w.log.filter(e => /^ap-(reverse|reset)$/.test(e.type));
    check('autopilot: never needed a recovery (no reversing out, no reset button)', rec.length === 0, rec);
    await w.noErrors('whole run');
    rep.gameS = (tail.clock - CLOCK_BASE) / 1000; rep.frames = tail.frames; rep.renders = tail.renders; rep.wallS = (Date.now() - wall0) / 1000; rep.pumpS = w.wallPump / 1000;
    rep.shots = w.shotFiles;
  } catch (err) { check('final state readable', false, String(err)); }
  w.destroy();
}

async function scenario(w, cfg, rep) {
  let s, ok, e;
  const year = cfg.year, kers = year <= 2013;
  /* ---------- boot ---------- */
  const boot = await w.open();
  check('boots without the error overlay; page helpers installed (solo-page.js + solo-v6-page.js)', !boot.overlay && boot.lib === 'ok' && boot.v6 === 'ok', boot);
  check('menu: the controller is found by the menu-time poll (已連接)', await w.until(`F1.gamepad.state.connected && __e.shown('pad-status')`, 3000, 'pad found'));
  const fresh = await w.js(`({ spec: F1.game.spec.id, stored: localStorage.getItem('f1drive.car') })`);
  check('a fresh profile: the 2025 standard car, nothing stored', fresh.spec === '2025-standard' && fresh.stored === null, fresh);

  /* ---------- 年份 + car through the 車輛 tab ---------- */
  check('車輛 tab clicked (real click)', await w.click('#tab-car') && await w.shown('#car-panel'));
  const y = await pickYearByKeys(w, year);
  check('年份 ' + year + ' picked with real keys on the select (' + y.how + ', "' + year + '" typed: type-ahead, \'change\' ' + y.changes.length + 'x: ' + y.changes.join(' -> ') + ')',
    y.value === String(year) && y.text === year + ' 年' && lastOf(y.changes) === String(year) && y.before === '2025', y);
  check('the 車輛 list shows the ' + year + ' cars (' + y.cards.length + ': the standard car first, then the teams); the car follows the year at once (' + y.spec + ')',
    y.cards.length >= 11 && y.cards[0] === year + '-standard' && y.cards.every(id => id.indexOf(year + '-') === 0) && y.cards.indexOf(cfg.car) > 0 && y.year === year && y.spec === year + '-standard' && /\d+ 輛車/.test(y.season), y);
  check('car card ' + cfg.car + ' clicked (real click)', await w.click(`#car-list .car-card[data-id="${cfg.car}"]`));
  await sleep(150);
  const ci = await carInfo(w);
  rep.carName = ci.teamZh + ' ' + ci.car;
  check('car.spec = ' + cfg.car + ' (' + ci.team + ' ' + ci.car + ', ' + ci.engine + '), highlighted, remembered (f1drive.car), sent with the profile', ci.id === cfg.car && ci.year === year && ci.on === cfg.car &&
    J(JSON.parse(ci.stored)) === J({ year: year, car: cfg.car }) && ci.profile === cfg.car && ci.battery === 1, ci);
  if (kers) check('a 2012 car: 2.4 l V8 (8 cylinders, naturally aspirated, revs past 17 000), 7 gears, KERS (a small store), no halo (cockpit "modern")',
    ci.cyl === 8 && ci.asp === 'na' && ci.rpmShift > 17000 && ci.gears === 7 && ci.ers && ci.ers.store < 1000 && ci.cockpit === 'modern', ci);
  else check('a 2026 car: 1.6 l V6 turbo hybrid, ERS (big store, ' + (ci.ers && ci.ers.power.toFixed(0)) + ' W/kg), halo + 18-inch wheels', ci.cyl === 6 && ci.asp === 'hybrid' && ci.ers && ci.ers.store > 4000 && ci.ers.power > 400 && ci.cockpit === 'halo18', ci);
  await w.shot('menu-year-and-car', true);
  check('大獎賽 tab clicked', await w.click('#tab-gp') && await w.shown('#gp-panel'));
  const gpCar = await w.js(`({ shown: __e.shown('gp-car'), year: document.getElementById('gp-year').textContent, name: document.getElementById('gp-car-name').textContent.replace(/\\s+/g, ' ').trim(), tabChip: __e.shown('tab-car-chip') })`);
  check('大獎賽 tab: the season (' + gpCar.year + ') and the car (' + gpCar.name + ') above the setup; the 車輛 tab shows the livery chip', gpCar.shown && gpCar.year === String(year) && gpCar.name.indexOf(ci.teamZh) >= 0 && gpCar.name.indexOf(ci.car) >= 0 && gpCar.tabChip, gpCar);

  /* ---------- the track ---------- */
  const trackIdx = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(cfg.id)}; })`);
  check('track card clicked (real click)', trackIdx >= 0 && await w.click(`#track-grid .card[data-i="${trackIdx}"]`));
  check('track loads and runs', await w.until(`F1.game.track && F1.game.trackData.id === ${J(cfg.id)} && F1.game.running && __e.queued() === 1`, 30000, 'track load'));
  check('warp hooks: renderer and car found', await w.js(`__e.hookRenderer() && __e.hookCar()`));
  await w.frames(3);
  s = await w.snap();
  const meta = await w.js(`({ pred: F1.game.raceLine.lapTime, ds: F1.game.track.length / F1.game.track.samples.length, pit: (function () { var p = F1.game.track.pit, N = F1.game.track.samples.length, rel = function (i) { i = ((i % N) + N) % N; return i > N / 2 ? i - N : i; };
    return { limit: p.limitKmh, entry: rel(p.entry), exit: rel(p.exit), from: rel(p.from), to: rel(p.to), box0: rel(p.boxes[0].index) }; })(),
    style: F1.game.cockpit.info().style, halo: F1.game.cockpit.info().halo, maxBank: (function () { var m = 0; F1.game.track.samples.forEach(function (q) { if (Math.abs(q.bank) > Math.abs(m)) m = q.bank; }); return m * 180 / Math.PI; })() })`);
  const ctx = { pred: meta.pred, ds: meta.ds, N: s.car.n, len: s.trackLen };
  rep.name = s.trackName; rep.pred = meta.pred; rep.pit = meta.pit;
  info(s.trackName + ': ' + (s.trackLen / 1000).toFixed(3) + ' km, racing line of ' + cfg.car + ' predicts ' + fmt(meta.pred) + '; pit lane ' + meta.pit.limit + ' km/h, entry ' + (-meta.pit.entry * meta.ds) + ' m before the line, box 1 ' +
    (meta.pit.box0 * meta.ds) + ' m after it, exit ' + (meta.pit.exit * meta.ds) + ' m after it; steepest banking ' + meta.maxBank.toFixed(1) + ' deg');
  const tel0 = s.tel;
  check('telemetry graphic: the car\'s team / name / livery colour, its rev range, battery full, medium tyres, next set M', tel0 && tel0.team === ci.team && tel0.car === ci.car && tel0.colour === ci.colour &&
    tel0.rpmShift === ci.rpmShift && tel0.rpmMax === ci.rpmMax && tel0.battery === 1 && tel0.tyres.compound === 'M' && tel0.nextCompound === 'M', tel0);
  check('cockpit style of the season: ' + meta.style + (meta.halo ? ' (halo)' : ' (no halo)'), kers ? meta.style === 'modern' && !meta.halo : meta.style === 'halo18' && meta.halo, meta);

  /* ---------- the battery A/B on the start straight ---------- */
  if (cfg.ab) await abTest(w, cfg, rep, trackIdx);

  /* ---------- T: hards for the Grand Prix ---------- */
  let from = w.log.length;
  await w.tap('T');
  await w.frames(1);
  s = await w.snap();
  check('free practice: T (real key) picks the next set: ' + COMPOUND_ZH[NEXT] + '; the telemetry\'s next-compound indicator shows it, toast; the fitted set stays medium',
    s.nextCompound === NEXT && s.tel.nextCompound === NEXT && s.tyres.compound === 'M' && w.toastsSince(from).indexOf('下一組輪胎：' + COMPOUND_ZH[NEXT] + '（進站換胎時裝上）') >= 0, { next: s.nextCompound, tel: s.tel.nextCompound, toasts: w.toastsSince(from) });

  /* ---------- the Grand Prix: Q / R / wear in the panel ---------- */
  check('Esc opens the menu', await w.esc(true));
  if (!await w.shown('#gp-panel')) await w.click('#tab-gp');
  const q = await w.type('#gp-q', String(Q)), r = await w.type('#gp-r', String(R));
  check('Q / R typed into the fields: ' + Q + ' / ' + R, q === String(Q) && r === String(R), [q, r]);
  check('輪胎損耗 ×' + WEAR + ' clicked', await w.click(`#gp-wear button[data-w="${WEAR}"]`));
  const setup = await w.js(`({ stored: localStorage.getItem('f1drive.gp'), on: [].map.call(document.querySelectorAll('#gp-wear button.on'), function (b) { return b.getAttribute('data-w'); }),
    note: document.getElementById('gp-wear-note').textContent, start: !document.getElementById('gp-start').disabled })`);
  check('setup remembered (f1drive.gp = {q: 1, r: 6, wear: 5}), ×5 marked, 開始大獎賽 enabled', setup.stored === J({ q: Q, r: R, wear: WEAR }) && J(setup.on) === J([String(WEAR)]) && setup.start, setup);
  await w.shot('menu-gp-setup', true);
  from = w.log.length;
  check('開始大獎賽 clicked', await w.click('#gp-start'));
  check('-> qualifying, out of the menu', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running && __e.queued() === 1 && !__e.shown('menu')`, 3000, 'quali'));
  await w.sync();
  await w.frames(2);
  s = await w.snap();
  const hudYear = () => w.js(`({ year: document.getElementById('hud-gp-year').textContent, shown: __e.shown('hud-gp-year') })`);
  let hy = await hudYear();
  check('qualifying: the session is ' + year + ', tyre wear x' + WEAR + ' (snapshot), the car ' + cfg.car + ' (parc fermé), a new set of the compound picked with T (' + NEXT + ') wearing at rate ' + WEAR + ', battery full',
    s.snapshot.year === year && s.snapshot.wear === WEAR && s.snapshot.q === Q && s.snapshot.r === R && s.spec.id === cfg.car && s.tyres.rate === WEAR && s.tyres.compound === NEXT && maxOf(s.tyres.wear) === 0 && s.battery === 1,
    { snap: { year: s.snapshot.year, wear: s.snapshot.wear }, spec: s.spec.id, tyres: s.tyres, battery: s.battery });
  check('HUD session box: 排位賽 with the season ' + hy.year + '; toast 大獎賽開始', s.hud.gpTitle === '排位賽' && hy.year === String(year) && hy.shown && w.toastsSince(from).some(t => t.indexOf('大獎賽開始：排位 1 圈，正賽 6 圈') === 0), { hy, toasts: w.toastsSince(from) });
  // parc fermé: the 車輛 tab is locked while the session is on
  check('Esc -> menu (qualifying, still at the start position)', await w.esc(true));
  await w.click('#tab-car');
  const pf = await w.js(`({ locked: document.getElementById('car-list').classList.contains('locked'), yearDisabled: document.getElementById('car-year').disabled, lock: __e.shown('car-lock') ? document.getElementById('car-lock').textContent : '' })`);
  await w.click(`#car-list .car-card:not(.on)`);                     // (a click on another card does nothing)
  const pf2 = await w.js(`F1.game.spec.id`);
  check('parc fermé: the 車輛 list locked, 年份 disabled, 賽事進行中不能換車; a click on another card changes nothing', pf.locked && pf.yearDisabled && pf.lock === '賽事進行中不能換車' && pf2 === cfg.car, { pf, spec: pf2 });
  await w.click('#tab-gp');
  check('Esc resumes', await w.esc(false));

  /* ---------- qualifying: out lap + 1 timed lap, the battery manager on ---------- */
  let c0 = w.evs('cross').length;
  const d0 = w.evs('lapDone').length;
  await w.js(`__e.ap.ers = { min: 0.02, vMin: 25 }; __e.ap.gripPace = true; __e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('out lap: the autopilot reaches the line', await w.pump(`E.n.cross >= ${c0 + 1}`, 60, 'first crossing'));
  const gridFrom = w.log.length;
  ok = await w.pump(`E.n.lapDone >= ${d0 + 1}`, ctx.pred * 1.6 + 60, 'the qualifying lap');
  let cr = w.evs('cross'), done = w.evs('lapDone');
  e = done[d0] || {};
  const q1 = e.time, q1truth = cr[c0 + 1] ? (cr[c0 + 1].steps - cr[c0].steps) * STEP : NaN;
  check('qualifying lap: ' + fmt(q1) + ' = physics steps between the crossings; accepted (qLaps 1, qDone) -> grid in that frame', ok && near(q1, q1truth, 1e-9) && e.me && e.me.qLaps === 1 && e.me.qBest === r3(q1) && e.me.qDone && e.phaseAfter === 'grid',
    { q1, truth: q1truth, me: e.me, phaseAfter: e.phaseAfter });
  check('qualifying lap plausible against the car\'s racing line (' + fmt(ctx.pred) + ') and clean', q1 > ctx.pred * 0.97 && q1 < ctx.pred * 1.12 + 3 && cr[c0 + 1] && clean(cr[c0 + 1].stats), { q1, pred: ctx.pred, stats: cr[c0 + 1] && cr[c0 + 1].stats });
  rep.laps.push(['quali (from 20 m before the line, battery manager on)', q1, cr[c0 + 1] && cr[c0 + 1].stats]);

  /* ---------- grid ---------- */
  await w.frames(1);
  s = await w.snap();
  const snapG = s.snapshot;
  check('grid: locked in box 1, a NEW ' + NEXT + ' set again (wear 0, rate ' + WEAR + '), battery full', s.gp.phase === 'grid' && s.gp.locked && s.gp.gridSlot === 0 && s.tyres.compound === NEXT && maxOf(s.tyres.wear) === 0 &&
    s.tyres.rate === WEAR && s.battery === 1 && s.car.v === 0, { gp: s.gp, tyres: s.tyres, battery: s.battery });
  const g0 = w.evs('go').length, cR = w.evs('cross').length, dR = w.evs('lapDone').length;
  await w.pump(`g.gp.lights >= 3`, 8, '3 lamps');
  s = await w.snap(); hy = await hudYear();
  const gridShot = await w.shot('grid-3-lights');
  check('grid, 3 lamps: HUD lights 3 / 準備起跑, session box 起跑 ' + hy.year + ', car frozen, full throttle held (screenshot ' + gridShot + ')', s.hud.lights.on === 3 && s.hud.lights.shown && s.hud.lights.text === '準備起跑' &&
    s.hud.gpTitle === '起跑' && hy.year === String(year) && s.car.v === 0 && s.pad.thr === 1, { lights: s.hud.lights, hy });
  ok = await w.pump(`E.n.go >= ${g0 + 1}`, 8, 'lights out');
  const go = w.evs('go')[g0];
  check('lights out', ok && !!go);
  await w.js(`__v6.resetKers(); true`);                                  // the battery tally of the race alone
  const kersFrom = await w.js(`__v6.series.length`);

  /* ---------- the race ---------- */
  // lap 1: T pressed three times at a third of the lap (S, M, back to H): the next set follows each press
  ok = await w.pump(`E.n.cross >= ${cR + 1} && E.frac() >= 0.3`, 60, 'a third of race lap 1');
  const cyc = [];
  for (let t = 0; t < 3; t++) {
    from = w.log.length;
    await w.tap('T');
    await w.frames(1);
    s = await w.snap();
    cyc.push({ next: s.nextCompound, tel: s.tel.nextCompound, fitted: s.tyres.compound, toasts: w.toastsSince(from) });
  }
  check('race lap 1: T (real key) three times: the next set goes ' + cyc.map(c => c.next).join(' -> ') + ' (soft, medium, hard again), the telemetry\'s indicator and a toast follow every press; the fitted hards stay on',
    J(cyc.map(c => c.next)) === J(['S', 'M', 'H']) && cyc.every(c => c.tel === c.next && c.fitted === NEXT && c.toasts.indexOf('下一組輪胎：' + COMPOUND_ZH[c.next] + '（進站換胎時裝上）') >= 0), cyc);
  // the battery on a straight (race lap 1 or 2): a screenshot of the telemetry while the manager deploys
  ok = await w.pump(`E.ap.boost && E.ap.ersStraight && g.car.state.deploy > 0.5 && g.gp.phase === 'race'`, ctx.pred * 1.5, 'deploying on a straight');
  s = await w.snap();
  const depNow = await w.js(`F1.game.car.state.deploy`);
  const kShot = await w.shot((kers ? 'kers' : 'ers') + '-deploying-race');
  check('race: the autopilot deploys the battery on a straight (RB held; state.deploy ' + depNow.toFixed(2) + ', the telemetry graphic got deploy ' + (s.tel ? s.tel.deploy.toFixed(2) : '?') + ', battery ' + (s.tel ? (s.tel.battery * 100).toFixed(0) : '?') + ' %; screenshot ' + kShot + ')',
    ok && s.pad.boost === true && s.tel && s.tel.deploy > 0 && s.tel.battery < 1, { tel: s.tel, pad: s.pad });

  // laps until the pit decision, the stop, the rest
  let k = await w.js(`F1.game.gp.lap`), planned = 0, pv = null;
  while (k < R) {
    if (planned && !pv) {
      pv = await pitStop(w, ctx, { limiter: !cfg.speeding, vLane: cfg.speeding ? (meta.pit.limit + 25) / 3.6 : 0, escInService: !!cfg.escInService, what: 'race pit stop' });
      if (!pv) { check('race: the pit stop was driven', false); break; }
      k = await w.js(`F1.game.gp.lap`);
      continue;
    }
    ok = await w.pump(`g.gp.lap >= ${k + 1} || g.gp.phase !== 'race'`, ctx.pred * 1.8 + 60, 'race lap ' + (k + 1));
    if (!ok) break;
    k = await w.js(`F1.game.gp.lap`);
    const wearNow = await w.js(`Math.max.apply(null, F1.game.tyres.state.wear)`);
    if (!planned && k >= PIT_AFTER && k <= R - 2) { planned = k; info('pit stop decided at the end of race lap ' + k + ' (max tyre wear ' + (wearNow * 100).toFixed(1) + ' %): the in-lap is lap ' + (k + 1)); }
  }
  ok = await w.pump(`g.gp.phase === 'results'`, ctx.pred * 1.8 + 60, 'the flag');
  await w.sync();
  cr = w.evs('cross'); done = w.evs('lapDone');
  const raceDone = done.slice(dR), raceCross = cr.slice(cR);
  e = lastOf(raceDone) || {};
  check('the race ran to the flag: ' + R + ' laps reported, all accepted, fin -> results', ok && raceDone.length === R && e.me && e.me.fin && e.me.rLaps === R && e.phaseAfter === 'results' && w.evs('lapRejected', gridFrom).length === 0,
    { n: raceDone.length, me: e.me });

  // every race lap against the ground truth (physics steps + the steps held in the box)
  const laps = [];
  for (let j = 1; j <= R && raceCross[j]; j++) {
    const truth = j === 1 ? go.sinceGo + (raceCross[1].steps - go.steps) * STEP : (raceCross[j].steps - raceCross[j - 1].steps) * STEP;
    laps.push({ n: j, time: raceDone[j - 1] ? raceDone[j - 1].time : NaN, truth, held: raceCross[j].held - raceCross[j - 1].held, inLane: raceCross[j].inLane, stats: raceCross[j].stats, rLaps: raceDone[j - 1] && raceDone[j - 1].me ? raceDone[j - 1].me.rLaps : null });
  }
  check('every race lap = the ground truth (lap 1: time since lights out at the go frame + physics steps; then steps between the crossings, the steps held in the box included)',
    laps.length === R && laps.every(l => near(l.time, l.truth, 1e-9)), laps.map(l => [l.n, l.time, l.truth, l.held]));
  laps.forEach(l => rep.laps.push(['race ' + l.n + (l.held ? ' (the stop: ' + (l.held * STEP).toFixed(2) + ' s held in the box)' : '') + (l.inLane ? ' (crossed the line in the pit lane)' : ''), l.time, l.stats]));
  check('all six race laps driven cleanly on the worn tyres too (no grass, no wall, no recovery: the autopilot paces itself on the grip left)', laps.length === R && laps.every(l => clean(l.stats)), laps.map(l => [l.n, statTxt(l.stats)]));

  /* ---------- the pit stop ---------- */
  if (pv) {
    const P = pv.info.rec, svcs = await w.js(`__v6.services`), sv = svcs[0] || {};
    const heldS = P.svcHeld1 - P.svcHeld0, stopLap = laps.find(l => l.held > 0), laneLap = laps.find(l => l.inLane);
    rep.pit = { plannedAfter: planned, rec: P, stopped: pv.info.stopped, svc: sv, dom: pv.dom, shots: pv.shots };
    info('pit stop: planned after lap ' + planned + '; ' + (cfg.speeding ? 'NO limiter, the lane at up to ' + P.maxLaneKmh.toFixed(1) + ' km/h' : 'limiter on ' + (pv.dom.limiterOnAt ? ((pv.dom.limiterOnAt.uEn - pv.dom.limiterOnAt.U) * ctx.ds).toFixed(0) + ' m before the entry line at ' + pv.dom.limiterOnAt.kmh.toFixed(0) + ' km/h' : '?') +
      ', the lane at ' + P.minLaneKmh.toFixed(1) + '..' + P.maxLaneKmh.toFixed(1) + ' km/h') + '; stopped ' + (pv.info.stopped ? pv.info.stopped.along.toFixed(2) + ' m along / ' + pv.info.stopped.across.toFixed(2) + ' m across box 1' : '?') +
      '; service ' + (P.svcWork || 0).toFixed(3) + ' s' + (P.svcPenalty ? ' + ' + P.svcPenalty + ' s penalty' : '') + ' = ' + (P.svcTotal || 0).toFixed(3) + ' s, held ' + (heldS * STEP).toFixed(3) + ' s; tyres before ' +
      (sv.before ? sv.before.compound + ' wear ' + sv.before.wear.map(x => (x * 100).toFixed(0)).join('/') + ' %, grip ' + sv.before.grip.lat.toFixed(4) + ' / ' + sv.before.grip.brake.toFixed(4) + ' / ' + sv.before.grip.traction.toFixed(4) : '?') +
      ', after ' + (sv.after ? sv.after.compound + ' grip ' + sv.after.grip.lat.toFixed(4) : '?'));
    if (!cfg.speeding) {
      check('pit: Q (real key) 15 m before the entry curtain: the limiter on before the entry line; on through the whole lane; 已離開維修區 reminder at the exit; Q off once past the exit curtain (' +
        (pv.offAfterExit ? ((pv.offAfterExit.U - pv.offAfterExit.uEx) * ctx.ds).toFixed(0) + ' m after the exit line' : '?') + ')',
        P.limiterAtEntry === true && P.limiterAtExit === true && pv.offAfterExit && pv.offAfterExit.limiter === true && pv.offAfterExit.U > pv.offAfterExit.uEx && pv.dom.exit.limiter === true &&
        w.toastsSince(pv.from).some(t => /^已離開維修區：按 (LB|Q) 關閉限速器$/.test(t)) && !(await w.js(`F1.game.limiter`)), { dom: pv.dom, off: pv.offAfterExit, rec: { atEntry: P.limiterAtEntry, atExit: P.limiterAtExit } });
      check('pit: the lane driven AT the limit on the limiter (' + P.minLaneKmh.toFixed(1) + '..' + P.maxLaneKmh.toFixed(1) + ' km/h between the curtains away from the box, limit ' + meta.pit.limit + '), never speeding, no penalty',
        P.maxLaneKmh <= meta.pit.limit + 0.5 && P.cruiseKmh >= meta.pit.limit - 2.5 && P.speedingFrames === 0 && P.svcPenalty === 0 && !w.toastsSince(pv.from).some(t => /超速/.test(t)), P);
      check('pit: the service time is random in 2.0..4.5 s: ' + (P.svcWork || 0).toFixed(3) + ' s, no penalty; the HUD counts it down (' + pv.dom.svc1.label + ' ' + pv.dom.svc1.time + ' 1.2 s in)',
        P.svcWork >= 2 && P.svcWork <= 4.5 && P.svcTotal === P.svcWork && pv.dom.svc1.shown && pv.dom.svc1.label === '換胎中' && pv.dom.svc1.time === (Math.ceil(pv.dom.svc1.left * 10 - 1e-6) / 10).toFixed(1) + ' s' && pv.dom.svc1.pen === '',
        { work: P.svcWork, total: P.svcTotal, svc1: pv.dom.svc1 });
    } else {
      const spToasts = w.toastsSince(pv.from).filter(t => /維修區超速/.test(t));
      check('pit, speeding on purpose: no limiter, the lane at up to ' + P.maxLaneKmh.toFixed(1) + ' km/h (limit ' + meta.pit.limit + '): speeding (' + P.speedingFrames + ' frames), the toast once (' + (spToasts[0] || '-') + ')',
        P.limiterAtEntry === false && P.maxLaneKmh > meta.pit.limit + 15 && P.speedingFrames > 0 && spToasts.length === 1 && spToasts[0] === '維修區超速（限速 ' + meta.pit.limit + ' km/h）：停站時罰停 5 秒', { rec: P, toasts: spToasts });
      check('pit: the penalty +5 s is applied AT THAT STOP: service = ' + (P.svcWork || 0).toFixed(3) + ' s tyre change (random, 2.0..4.5) + 5 s = ' + (P.svcTotal || 0).toFixed(3) + ' s; the HUD shows 罰停中 first (' + pv.dom.svc1.label + ' ' + pv.dom.svc1.time + ', ' + pv.dom.svc1.pen + '), then 換胎中 (' + (pv.dom.svc2 ? pv.dom.svc2.label + ' ' + pv.dom.svc2.time : '?') + ')',
        P.svcPenalty === 5 && P.svcWork >= 2 && P.svcWork <= 4.5 && near(P.svcTotal, P.svcWork + 5, 1e-9) && P.penNowFrames > 0 && pv.dom.svc1.label === '罰停中' && pv.dom.svc1.pen === '罰停 +5 s' && pv.dom.svc2 && pv.dom.svc2.label === '換胎中' &&
        (await w.js(`F1.game.pit.state.pending`)) === 0, { work: P.svcWork, total: P.svcTotal, penalty: P.svcPenalty, svc1: pv.dom.svc1, svc2: pv.dom.svc2 });
    }
    check('pit: stopped in OWN box 1 (slot 0; within 2.5 m along, 1.2 m across), held there for the whole service (frozen: no movement, speed 0, neutral), no wall / grass in the pit complex',
      pv.info.stopped && Math.abs(pv.info.stopped.along) < 2.5 && Math.abs(pv.info.stopped.across) < 1.2 && pv.info.stopped.inPit && P.maxServiceMove === 0 && P.frozenBad === 0 && P.serviceFrames > 1.9 / FRAME &&
      pv.dom.svc1.v === 0 && pv.dom.svc1.gear === 0 && P.hits === 0 && P.grass === 0, { stopped: pv.info.stopped, rec: { move: P.maxServiceMove, bad: P.frozenBad, frames: P.serviceFrames, hits: P.hits, grass: P.grass }, svc1: pv.dom.svc1 });
    check('pit: the hold lasted the service time on the GAME clock (' + ((P.svcDoneClock - P.svcStartClock) / 1000).toFixed(3) + ' s; ' + heldS + ' physics steps held = ' + (heldS * STEP).toFixed(3) + ' s vs ' + (P.svcTotal || 0).toFixed(3) + ' s), the lap clock ran on through it',
      // (read at frame starts: the held steps of the frame the service began in, and the steps driven after it ended in its last
      //  frame, fall outside / inside by up to a frame; the exact count per lap is checked with the lap of the stop below)
      near(heldS * STEP, P.svcTotal, FRAME + STEP + 1e-9) && near((P.svcDoneClock - P.svcStartClock) / 1000, P.svcTotal, FRAME + 1e-6) && near(P.svcLap1 - P.svcLap0, heldS * STEP, FRAME + STEP + 1e-9) &&
      pv.stopsAfter === pv.stopsBefore + 1, { held: heldS, total: P.svcTotal, clock: (P.svcDoneClock - P.svcStartClock) / 1000, lapClock: P.svcLap1 - P.svcLap0 });
    const nt = w.toastsSince(pv.from).filter(t => /換上新胎/.test(t));
    check('pit: released on the set picked with T: ' + (sv.after && sv.after.compound) + ' (new: no wear, no flat spot, no puncture), toast ' + (nt[0] || '-'),
      sv.after && sv.after.compound === NEXT && maxOf(sv.after.wear) < 1e-6 && maxOf(sv.after.flat) === 0 && sv.after.puncture === -1 && sv.telAfter && sv.telAfter.compound === NEXT &&
      nt.length === 1 && nt[0] === '換上新胎：' + COMPOUND_ZH[NEXT] + '，出發！' && pv.dom.exit.tyres === NEXT, { sv, toasts: nt });
    // tyres: wear rising lap by lap in the telemetry's data, grip dropping, restored by the stop
    const v6laps = (await w.js(`__v6.laps`)).filter(l => l.clock >= snapG.goAt - 1 && l.tel);
    const beforeStop = v6laps.filter(l => l.clock < sv.startClock), afterStop = v6laps.filter(l => l.clock > sv.endClock);
    // (the four tyres as the telemetry graphic got them at every crossing of the line, then at the start of the service)
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const wearSets = beforeStop.map(l => l.tel.wear).concat(sv.telBefore ? [sv.telBefore.wear] : []);
    const wearSeq = wearSets.map(maxOf), meanSeq = wearSets.map(mean);
    const gripSeq = beforeStop.map(l => l.grip.lat).concat(sv.before ? [sv.before.grip.lat] : []);
    const afterSets = afterStop.map(l => l.tel.wear);
    rep.wear = { seq: wearSeq, mean: meanSeq, grip: gripSeq, after: afterSets.map(maxOf), afterMean: afterSets.map(mean), gripAfter: afterStop.map(l => l.grip.lat) };
    info('tyres (' + NEXT + ' at the start): the most worn tyre at the line crossings of the race, as the telemetry got it: ' + wearSeq.map(x => (x * 100).toFixed(1) + ' %').join(', ') + ' (service; mean of the four ' +
      meanSeq.map(x => (x * 100).toFixed(1)).join(', ') + ' %); lateral grip ' + gripSeq.map(x => x.toFixed(4)).join(', ') + '; after the stop (' + NEXT + '): ' + rep.wear.after.map(x => (x * 100).toFixed(1) + ' %').join(', ') +
      ', grip ' + rep.wear.gripAfter.map(x => x.toFixed(4)).join(', '));
    check('tyre wear rises lap by lap in the telemetry graphic\'s tyre data (most worn ' + wearSeq.map(x => (x * 100).toFixed(0)).join(' -> ') + ' %, mean ' + meanSeq.map(x => (x * 100).toFixed(0)).join(' -> ') + ' % at the line / the service; x' + WEAR + ')',
      wearSets.length >= 3 && meanSeq.every((x, i) => i === 0 || x > meanSeq[i - 1]) && wearSets.every((ws, i) => i === 0 || ws.every((x, j) => x >= wearSets[i - 1][j])) && lastOf(wearSeq) > 0.45, { wearSets });
    check('the grip drops with it (lateral ' + gripSeq.map(x => x.toFixed(4)).join(' -> ') + '; braking ' + (sv.before ? sv.before.grip.brake.toFixed(4) : '?') + ', traction ' + (sv.before ? sv.before.grip.traction.toFixed(4) : '?') + ' at the stop)',
      gripSeq.length >= 3 && gripSeq.every((x, i) => i === 0 || x <= gripSeq[i - 1]) && lastOf(gripSeq) < gripSeq[0] - 0.005 && sv.before.grip.brake < sv.after.grip.brake && sv.before.grip.traction < sv.after.grip.traction, { gripSeq, before: sv.before });
    check('the stop restores the tyres: the new ' + NEXT + ' set has the grip of a new one again (lateral ' + (sv.after ? sv.after.grip.lat.toFixed(4) : '?') + ' vs ' + (sv.before ? sv.before.grip.lat.toFixed(4) : '?') + ' worn) and wears from 0 again (' + rep.wear.after.map(x => (x * 100).toFixed(1)).join(', ') + ' %)',
      sv.after && sv.before && sv.after.grip.lat > sv.before.grip.lat && sv.after.grip.lat === gripSeq[0] && sv.after.grip.brake > sv.before.grip.brake && sv.after.grip.traction > sv.before.grip.traction && afterStop.length >= 2 &&
      rep.wear.after[0] < lastOf(wearSeq) && rep.wear.afterMean.every((x, i) => i === 0 || x > rep.wear.afterMean[i - 1]), { before: sv.before, after: sv.after, wearAfter: rep.wear.after });
    // the laps of the stop
    check('the lap through the pit lane counts: race lap ' + (laneLap ? laneLap.n : '?') + ' was completed crossing the line IN the pit lane, accepted (' + (laneLap ? fmt(laneLap.time) : '?') + ')',
      !!laneLap && laneLap.rLaps === laneLap.n && near(laneLap.time, laneLap.truth, 1e-9), laneLap);
    const flying = laps.filter(l => l.n > 1 && !l.held && !l.inLane && clean(l.stats)).map(l => l.time), fast = flying.length ? Math.min.apply(null, flying) : NaN;
    check('the lap with the stop (race lap ' + (stopLap ? stopLap.n : '?') + ', ' + (stopLap ? fmt(stopLap.time) : '?') + ') has the stop in it: ' + (stopLap ? stopLap.held : '?') + ' steps held = ' + (stopLap ? (stopLap.held * STEP).toFixed(3) : '?') +
      ' s = the service, and it is slower than the fastest flying lap (' + fmt(fast) + ') by more than the service',
      !!stopLap && near(stopLap.held * STEP, P.svcTotal, STEP + 1e-9) && near(stopLap.time, stopLap.truth, 1e-9) && stopLap.time > fast + P.svcTotal, { stopLap, fast, svc: P.svcTotal });
    check('only ONE pit stop (one service, one pit visit with a stop)', svcs.length === 1 && (await w.js(`F1.game.pit.state.stops`)) === 1, svcs.length);
    rep.pit.fast = fast;
  } else check('race: a pit stop happened', false, { planned });

  /* ---------- the race total ---------- */
  const total = e.me ? e.me.rTime : NaN, clockTotal = e.gpNow !== undefined ? (e.gpNow - snapG.goAt) / 1000 : NaN, sum = laps.reduce((a, l) => a + l.time, 0), rBest = Math.min.apply(null, laps.map(l => l.time));
  check('race total ' + fmt(total) + ' = the sum of the six laps (each to the ms) = the session clock from lights out to the flag (' + clockTotal.toFixed(3) + ' s; the lap clock lags it by less than a frame + two steps)',
    near(total, laps.reduce((a, l) => r3(a + r3(l.time)), 0), 0.0016) && near(total, sum, 0.004) && clockTotal - total > -0.002 && clockTotal - total < FRAME + 2 * STEP + 0.002, { total, sum, clockTotal });
  if (pv && rep.pit) check('the stop cost time: total ' + fmt(total) + ' > ' + R + ' x the fastest flying lap (' + fmt(rep.pit.fast) + ') + the service (' + rep.pit.rec.svcTotal.toFixed(2) + ' s)', total > R * rep.pit.fast + rep.pit.rec.svcTotal, { total, fast: rep.pit.fast });
  rep.total = total; rep.qBest = q1;

  /* ---------- the battery in the race ---------- */
  const kb = await w.js(`__v6.kers`), series = (await w.js(`__v6.series.slice(${kersFrom})`)).filter(x => x[1] === 3);
  rep.kers = { deployS: kb.deployT, harvestS: kb.harvestT, heldS: kb.heldT, cycles: kb.cycles, recharged: kb.recharged, minBattery: kb.minBattery, deployE: kb.deployE, harvestE: kb.harvestE, drains: kb.drains.length, maxBoostKmh: await w.js(`__v6.maxBoostKmh`) };
  info('battery in the race: deployed ' + rep.kers.deployS.toFixed(1) + ' s (' + kb.deployE.toFixed(0) + ' J/kg), harvested ' + rep.kers.harvestS.toFixed(1) + ' s (' + kb.harvestE.toFixed(0) + ' J/kg), RB held ' + rep.kers.heldS.toFixed(1) + ' s; emptied ' + kb.cycles + 'x, back over 35 % ' + kb.recharged + 'x; lowest ' + (kb.minBattery * 100).toFixed(1) + ' %; top speed while deploying ' + rep.kers.maxBoostKmh.toFixed(0) + ' km/h');
  check('race: the battery is deployed only while the button is held (RB, never otherwise), never from an empty store; it is harvested under braking', kb.deployT > 1 && kb.deployNotHeld === 0 && kb.deployWhileEmpty === 0 && kb.harvestT > 1, kb);
  // (the manager spends the store on the next straight: between two deployments the brakes give back part of it)
  const rech = kb.drains.slice(1).map((d, i) => d[0] - kb.drains[i][1]), rechN = rech.filter(x => x >= 0.08).length;
  rep.kers.recharges = rechN;
  // (on a track of long straights it is spent to the bottom, on a twisty one a straight takes a quarter of it)
  const bigDrain = kb.drains.length ? maxOf(kb.drains.map(d => d[0] - d[1])) : 0;
  if (kers) check('KERS in the race: the small store (' + ci.ers.store.toFixed(0) + ' J/kg) drains on the straights (' + kb.drains.length + ' deployments, the biggest ' + (bigDrain * 100).toFixed(0) + ' % of it; lowest ' + (kb.minBattery * 100).toFixed(1) + ' %, ' + kb.cycles + 'x down to 5 %) and recharges under braking between them (' +
    rechN + 'x by 8 % or more, up to +' + (rech.length ? (maxOf(rech) * 100).toFixed(0) : '-') + ' %): ' + kb.deployE.toFixed(0) + ' J/kg deployed = ' + (kb.deployE / ci.ers.store).toFixed(1) + ' stores, ' + kb.harvestE.toFixed(0) + ' J/kg harvested',
    kb.drains.length >= R && bigDrain >= 0.25 && rechN >= R && kb.deployE > ci.ers.store * 2 && kb.harvestE > ci.ers.store * 2, { kb, rech });
  else check('ERS in the race: deployed (' + kb.deployE.toFixed(0) + ' J/kg) and harvested (' + kb.harvestE.toFixed(0) + ' J/kg) every lap, the battery going down and up', kb.deployE > 4849 && kb.harvestE > 4849 && kb.minBattery < 0.8, kb);
  check('race: the manager deploys on the straights only (the brake never applied while deploying)', series.every(x => !(x[5] > 0 && x[9] > 0)), series.filter(x => x[5] > 0 && x[9] > 0).slice(0, 5));

  /* ---------- results ---------- */
  await w.js(`__e.ap.mode = 'stop'; true`);
  await w.pump(`g.car.state.speed < 1`, 60, 'the car stops after the flag');
  await w.frames(5);
  s = await w.snap(); hy = await hudYear();
  const teamCell = await w.js(`(function () { var t = document.querySelector('#gp-results-body tbody tr .gp-team'); return t ? t.textContent : null; })()`);
  const rr = s.dom.res.rows[0] || { cells: [] }, trackName = s.trackName;
  const resSub = trackName + ' ‧ ' + year + ' 賽季 ‧ 排位 ' + Q + ' 圈 ‧ 正賽 ' + R + ' 圈 ‧ 輪胎損耗 ×' + WEAR;
  check('results overlay: subtitle "' + resSub + '"', s.dom.results && s.dom.res.sub === resSub && s.dom.res.again && s.dom.res.end && s.dom.res.close, s.dom.res);
  check('results table: 1, the driver (你) with the team ' + teamCell + ', ' + R + ' laps, total ' + fmt(total) + ', best ' + fmt(rBest) + ' (fastest-lap colour)', s.dom.res.rows.length === 1 && rr.cells[0] === '1' && rr.you &&
    teamCell === ci.teamZh && rr.cells[2] === String(R) && rr.cells[3] === fmt(total) && rr.cells[4] === '' && rr.cells[5] === fmt(rBest) && rr.fl, { rr, teamCell });
  check('results HUD: 成績 ' + hy.year + ', P1 / 1, standings with the total; toast 正賽結束：你是第 1 名（共 1 位車手）', s.hud.gpTitle === '成績' && hy.year === String(year) && s.hud.gpPos === 'P1/1' && s.hud.rows[0].val === fmt(total) &&
    w.toastsSince(gridFrom).indexOf('正賽結束：你是第 1 名（共 1 位車手）') >= 0, { hud: s.hud, hy });
  check('results: the telemetry still shows the car (' + s.tel.team + ' ' + s.tel.car + ') on the hards', s.tel.team === ci.team && s.tel.car === ci.car && s.tel.tyres.compound === NEXT, s.tel);
  await w.shot('results');
  await w.noErrors('Grand Prix');

  /* ---------- 結束: free practice, the car free again ---------- */
  from = w.log.length;
  check('結束 (results overlay) clicked -> free practice', await w.click('#gp-res-end') && await w.until(`F1.game.gp.phase === 'free'`, 3000, 'end'));
  await w.frames(2);
  check('Esc -> menu', await w.esc(true));
  await w.click('#tab-car');
  const fr = await w.js(`({ locked: document.getElementById('car-list').classList.contains('locked'), yearDisabled: document.getElementById('car-year').disabled, year: document.getElementById('car-year').value, spec: F1.game.spec.id,
    wear: F1.game.tyres.wearRate, lock: __e.shown('car-lock') })`);
  check('free practice again: the same ' + year + ' car, the 車輛 tab unlocked (年份 enabled), tyre wear back to x1', !fr.locked && !fr.yearDisabled && fr.year === String(year) && fr.spec === cfg.car && fr.wear === 1 && !fr.lock, fr);
}

const clean = st => !!st && st.grass === 0 && st.hits === 0 && st.reverses === 0 && st.resets === 0;
const statTxt = st => st ? (clean(st) ? 'clean' : 'grass ' + st.grass + ' f, wall ' + st.hits + ' f (max ' + st.maxHit.toFixed(2) + '), reversed ' + st.reverses + ', reset ' + st.resets) +
  ', top ' + (st.vmax * 3.6).toFixed(0) + ' km/h' : '?';

/* ================= main ================= */
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const silence = require('./silence')(app, 'solo-v6');
  setTimeout(() => { console.log('WATCHDOG: the run did not finish within 15 minutes'); app.exit(2); }, 15 * 60 * 1000);
  if (PATCH.length) console.log('PATCH: ' + PATCH.map(p => p[0] + ' <- ' + path.relative(ROOT, p[1]).replace(/\\/g, '/')).join(', '));
  for (const key of Object.keys(RUNS)) {
    if (ONLY.length && ONLY.indexOf(key) < 0) continue;
    try { await runOne(key); } catch (e) { part = key; check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  }
  part = 'sound';
  const sr = await silence.finish();
  check(sr.text, sr.ok, sr.detail);
  part = '';
  console.log('\n===== v6 Grand Prix: Q ' + Q + ' / R ' + R + ', tyre wear x' + WEAR + ' (real game, real input path, time-warped) =====');
  for (const key of Object.keys(report)) {
    const r = report[key];
    if (!r.name) continue;
    console.log(key + ' - ' + r.name + ', ' + r.year + ' ' + (r.carName || r.car) + ': racing line ' + fmt(r.pred) + (r.total ? '; qualifying ' + fmt(r.qBest) + ', race total ' + fmt(r.total) : ''));
    for (const l of r.laps) console.log('    ' + l[0].padEnd(70) + fmt(l[1]) + '  ' + statTxt(l[2]));
    if (r.ab) console.log('    battery A/B over ' + r.ab.len + ' m from the start: ' + r.ab.a.kmh.toFixed(1) + ' -> ' + r.ab.b.kmh.toFixed(1) + ' km/h with E (+' + r.ab.gain.toFixed(1) + '), ' + r.ab.powerWkg.toFixed(0) + ' W/kg deployed, empty after ' + (r.ab.b.emptyAt === null ? '-' : r.ab.b.emptyAt.toFixed(2) + ' s'));
    if (r.pit) console.log('    pit stop after lap ' + r.pit.plannedAfter + ': service ' + (r.pit.rec.svcWork || 0).toFixed(3) + ' s' + (r.pit.rec.svcPenalty ? ' + ' + r.pit.rec.svcPenalty + ' s penalty' : '') + ', lane max ' + r.pit.rec.maxLaneKmh.toFixed(1) + ' km/h');
    if (r.wear) console.log('    tyre wear (max) at the line: ' + r.wear.seq.map(x => (x * 100).toFixed(0) + '%').join(' ') + ' | after the stop ' + r.wear.after.map(x => (x * 100).toFixed(0) + '%').join(' '));
    if (r.kers) console.log('    battery in the race: deployed ' + r.kers.deployS.toFixed(1) + ' s, harvested ' + r.kers.harvestS.toFixed(1) + ' s, emptied ' + r.kers.cycles + 'x, top ' + r.kers.maxBoostKmh.toFixed(0) + ' km/h while deploying');
    for (const n of r.notes) console.log('    note: ' + n);
    if (r.gameS) console.log('    ' + r.gameS.toFixed(0) + ' s of game time (' + r.frames + ' frames) in ' + r.wallS.toFixed(1) + ' s wall; pumping ' + r.pumpS.toFixed(1) + ' s = ' + (r.gameS / Math.max(r.pumpS, 1e-3)).toFixed(0) + 'x real time');
    if (r.shots) console.log('    screenshots (out-solo-v6/): ' + r.shots.join(', '));
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  try { fs.unlinkSync(path.join(OUT, 'index-patched-' + process.pid + '.html')); } catch (e) {}
  app.exit(bad.length ? 1 : 0);
});
