// A whole SINGLE-PLAYER Grand Prix, from the menu to the results, driven by an autopilot in the REAL game
// (offscreen Electron), time-warped.
//
//   npx electron devtests/gp-e2e/solo.js            (from the project root; about 45 s; exit code 1 when a check fails)
//
//   env ONLY=monza,monaco,suzuka,spa (default: all four)      VERBOSE=1  print the detail of passed checks too
//       RENDER_EVERY=n   draw every n-th warped frame for real (default 600 = every 10 s of game time; 0 = only screenshots)
//       FRAME_MS=n       another frame pace than 1/60 s (e.g. 33.333 = 30 fps, 6.944 = 144 fps: less than a physics step)
//       JITTER=1         irregular frames, 5..35 ms (a fixed pseudo-random sequence)
//       PATCH='js/main.js=some/copy.js,net/session.js=other/copy.js'
//                        serve modified copies of product scripts to the page (the project files are not touched): to
//                        prove a fix, or to see that a check notices a mutant. Paths relative to the project root.
//   Screenshots: devtests/gp-e2e/out-solo/<track>-NN-<what>.png   Lap times and the warp speed are printed at the end.
//   SILENT: the windows are muted by devtests/electron-userdata.js (never set SOUND); the last check (part 'sound',
//   devtests/gp-e2e/silence.js) proves it: every window muted and never audible, and the Windows volume mixer
//   (mixer-watch.ps1) saw no audio session of this process tree with a peak above 0 during the whole run.
//   (The multi-window autopilot benchmark of the online suite is devtests/gp-e2e/bench.js; until 2026-10-01 this harness
//   was solo-gp.js and that one solo.js.)
//
// How it works (the page side is devtests/gp-e2e/solo-page.js, read its header):
//   - time warp: the page's requestAnimationFrame is replaced by a queue that the harness pumps with synthetic
//     timestamps 1/60 s apart. main.js derives dt from them (physics in fixed 1/120 s steps, the offline session clock
//     fed by the same dt), so the game runs exactly as in real time, only ~700 times faster. Rendering is skipped in
//     warped frames (one real frame is drawn for every screenshot).
//   - wall-clock things under the warp: toasts hide on a wall timer (so toasts are read from a per-frame log of the
//     toast element, not from "is it visible now"; in the screenshots a toast can still be up that a player would have
//     seen go minutes of game time ago), js/gamepad.js swallows button presses after a 500 ms poll gap (the autopilot
//     only needs the A button as a last resort and repeats a swallowed press), rumble gaps and the 100 ms menu-time pad
//     poll only matter for buttons the autopilot never holds (Start).
//   - autopilot: the control law of devtests/raceline-test/test.js (throttle / brake from the racing line's own advice,
//     pure pursuit steering), fed into the game through a fake standard-mapping controller behind
//     navigator.getGamepads: analog stick, RT, LT. It never writes car.state. Esc, R, Enter, the Q / R fields and every
//     button are real key / mouse events.
//   - ground truth for every lap time: the car's own continuous position (track.locate with a local window), line
//     crossings counted in physics steps; a lap must be (steps between two crossings) / 120 s.
// Per track: Q = 2, R = 3 through the menu panel -> out lap + 2 timed laps (R reset in the middle of the 2nd) -> grid by
// itself -> lights (full throttle held through the lock, R ignored) -> 3 race laps (Esc to the menu in the middle of the
// 2nd) -> results. And:
//   monza   再來一場 + a lap in the new session + 結束大獎賽 from the menu + a free-practice lap; then the autopilot is
//           thrown into the wall and turned round, and must recover (reset button); v6: the wall impact damages the
//           tyres (flat spot, usually a puncture), so the recovery includes a pit stop (Q on before the entry line, the
//           own box, a new set, Q off after the exit) before the flying lap that must be normal again
// v6 (2026-10-01): the stored Grand Prix setup is {q, r, wear}; the speed is drawn by the telemetry graphic (no
// #hud-speed: what main.js hands F1.telemetry.draw is checked); the results subtitle names the season (2025: the
// reference car of a fresh profile). Under the warp: the pit service counts down on the GAME clock (pit.update every
// physics step, the car held, the lap clock running: solo-page.js counts those held steps into the ground truth), the
// telemetry graphic is put on the game clock, toasts are read from a log of the F1.ui.toast calls (game clock) as well.
// The v6 Grand Prix (years, cars, battery, tyre wear, pit stops) is devtests/gp-e2e/solo-v6.js.
//   monaco  Esc on the grid with 4 lights on (back with 繼續駕駛); a lap after the flag (nothing counts any more); 結束 on
//           the overlay + a free-practice lap
//   suzuka  a deliberately cut lap through the crossover in qualifying; after the results 關閉, 再來一場 / 跳過排位 from the
//           menu and a race whose first lap is cut (total = session clock); 再來一場, 結束大獎賽 during the race (DNF)
//   spa     started with Enter in the lap field; Esc on the grid, a frame 1 s late on the grid (dt clamp); 再來一場, skip,
//           and quitting to another track in the middle of the race; a new Grand Prix there, ended while the lights are on
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'gp-e2e-solo');
const OUT = path.join(__dirname, 'out-solo');
const ONLY = (process.env.ONLY || '').toLowerCase().split(',').filter(Boolean);
const VERBOSE = !!process.env.VERBOSE;
const RENDER_EVERY = process.env.RENDER_EVERY === undefined ? 600 : Number(process.env.RENDER_EVERY) || 0;
const PATCH = (process.env.PATCH || '').split(/[;,]/).map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i).trim().replace(/\\/g, '/'), path.resolve(ROOT, p.slice(i + 1).trim())]; });
const PAGE_LIB = fs.readFileSync(path.join(__dirname, 'solo-page.js'), 'utf8');

const FRAME_MS = Number(process.env.FRAME_MS) || 1000 / 60, JITTER = !!process.env.JITTER;
const Q = 2, R = 3, STEP = 1 / 120, CLOCK_BASE = 1000000;
const FRAME = (JITTER ? 35 : FRAME_MS) / 1000;                       // the longest warped frame, s
// ending: what happens after the results (see the header). cut: a shortcut through the crossover in qualifying.
// gridPause: Esc to the menu with 4 start lights on, back with the 繼續駕駛 button / with Esc. startWith: 'enter' = the
// Grand Prix is started with Enter in the 正賽圈數 field instead of a click on 開始大獎賽. coolDown: one more lap after
// the flag. upset: at the very end the autopilot is thrown off twice to see it recover. stall: one frame on the grid
// arrives 1 s late (dt clamp).
const TRACKS = {
  monza: { id: 'it-1922', ending: 'again', upset: true },
  monaco: { id: 'mc-1929', ending: 'end', gridPause: 'button', coolDown: true },
  suzuka: { id: 'jp-1962', ending: 'close', cut: true },
  spa: { id: 'be-1925', ending: 'quit', quitTo: 'it-1922', gridPause: 'esc', startWith: 'enter', stall: true }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const r3 = t => Math.round(t * 1000) / 1000;                       // seconds, to the millisecond (net/session.js ms3)
// a completed lap / a total as the game must show it: rounded to the millisecond, m:ss.mmm
const fmt = t => { if (t == null || t !== t) return '--'; const ms = Math.round(t * 1000); return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0'); };
// a running clock as the HUD shows it: cut off at the millisecond
const fmtFloor = t => { const ms = Math.floor(t * 1000 + 1e-6); return Math.floor(ms / 60000) + ':' + String(Math.floor(ms % 60000 / 1000)).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0'); };

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
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const [src, file] of PATCH) {
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
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'gpe2e-solo-' + tag + '-' + (++winSeq),
      preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false }
  });
  w.webContents.setFrameRate(60);
  w.errors = []; w.log = []; w.tag = tag; w.shots = 0; w.wallPump = 0; w.framesPumped = 0;
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
    await w.js(`__e.renderEvery = ${RENDER_EVERY}; __e.setPace(${FRAME_MS}, ${JITTER})`);
    return { lib, overlay: await w.overlay() };
  };
  w.overlay = () => w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  w.snap = () => w.js(`__e.snap()`);
  // new log entries of the page (with the HUD they saw) -> w.log
  w.sync = async () => { const more = await w.js(`(__e.observeDom(), __e.log.slice(${w.log.length}))`); for (const e of more) w.log.push(e); return w.log.length; };
  w.evs = (type, from) => w.log.filter(e => e.type === type && e.i >= (from || 0));
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(30); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  // Pump warped frames until cond holds (a JS expression in the page: E = __e, F1, g = F1.game), for at most maxS
  // seconds of GAME time. -> true when it held.
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
          J({ car: s.car, gp: s.gp, lap: s.lap, truth: s.truth, ap: s.ap, recent: w.log.slice(-6).map(e => e.type) }));
        return false;
      }
    }
  };
  // at least sec seconds of game time
  w.advance = async sec => { const t = await w.js(`__e.clock`); return w.pump(`E.clock >= ${t + sec * 1000}`, sec + 5, sec + ' s'); };
  w.frames = async n => { const r = await w.js(`__e.run(${n}, '', 2000)`); w.wallPump += r.wall; w.framesPumped += r.n; await w.sync(); return r; };
  // a screenshot of what the player would see now: one real frame is drawn (the warp skips rendering)
  w.shot = async (name, noDraw) => {
    if (!noDraw) await w.js(`__e.draw()`);
    await sleep(220);
    const file = tag + '-' + String(++w.shots).padStart(2, '0') + '-' + name + '.png';
    fs.writeFileSync(path.join(OUT, file), (await w.webContents.capturePage()).toPNG());
    return file;
  };
  // real input events
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
  // type into a field the way a player does: click it, select what is there, type
  w.type = async (sel, text) => {
    if (!await w.click(sel)) return null;
    w.webContents.selectAll();
    await sleep(60);
    for (const ch of text) w.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    await sleep(120);
    return w.js(`document.querySelector(${J(sel)}).value`);
  };
  w.esc = async toMenu => { await w.tap('Escape'); return w.until(toMenu ? `!F1.game.running && __e.shown('menu')` : `F1.game.running && !__e.shown('menu')`, 3000, toMenu ? 'Esc -> menu' : 'Esc -> resume'); };
  w.noErrors = async what => { const o = await w.overlay(); return check('no error overlay, no console errors / warnings' + (what ? ' (' + what + ')' : ''), !o && w.errors.length === 0, o || w.errors.slice(0, 3)); };
  return w;
}

/* ---------- pieces shared by the scenarios ---------- */

const expLampsAt = (c, sn) => c >= sn.goAt || c < sn.lightsAt ? 0 : Math.min(5, 1 + Math.floor((c - sn.lightsAt) / 1000));
const hasToast = (w, from, text) => w.evs('toast', from).some(e => e.text === text);
const lastOf = a => a[a.length - 1];
// the first standings row of the HUD right after a lap was handed to gp.lapDone (e = the log entry)
function lapRow(e) { return e.hud && e.hud.rows && e.hud.rows[0] ? e.hud.rows[0] : {}; }
const clean = st => !!st && st.grass === 0 && st.hits === 0 && st.reverses === 0 && st.resets === 0;
const statTxt = st => st ? (clean(st) ? 'clean' : 'grass ' + st.grass + ' f, wall ' + st.hits + ' f (max ' + st.maxHit.toFixed(2) + '), reversed ' + st.reverses + ', reset ' + st.resets) +
  ', top ' + (st.vmax * 3.6).toFixed(0) + ' km/h, widest ' + (st.maxOut > 0 ? '+' : '') + st.maxOut.toFixed(2) + ' m over the white line' : '?';

// From wherever the car stands: over the line (timing starts), then one timed lap. For free practice and for the first
// lap of a new session. -> { time (ground truth), stats, done: the gp.lapDone calls, snap }
async function timedLap(w, ctx, what, phase) {
  const from = w.log.length, c0 = w.evs('cross').length, d0 = w.evs('lapDone').length;
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check(what + ': the first crossing of the line starts the timing', await w.pump(`E.n.cross >= ${c0 + 1}`, ctx.pred * 1.6 + 60, what + ' first crossing'));
  await w.advance(0.05);
  let s = await w.snap();
  const lapTxt1 = phase === 'free' ? '1' : '1 / ' + Q;
  check(what + ': lap counter started, HUD lap "' + lapTxt1 + '", the lap clock runs', s.lap.started && s.lap.n === 1 && s.hud.lap === lapTxt1 && s.hud.cur === fmtFloor(s.lap.time) && s.lap.time > 0 && s.lap.time < 1,
    { lap: s.lap, hud: [s.hud.lap, s.hud.cur] });
  const ok = await w.pump(`E.n.cross >= ${c0 + 2}`, ctx.pred * 1.6 + 60, what + ' lap');
  await w.frames(2);
  s = await w.snap();
  const cr = w.evs('cross', from), truth = cr.length >= 2 ? (cr[1].steps - cr[0].steps) * STEP : NaN;
  check(what + ': the lap is timed: lap counter = physics steps between the two crossings (' + fmt(truth) + ')', ok && near(s.lap.last, truth, 1e-9) && s.lap.n === 2 && s.lap.best === s.lap.last,
    { last: s.lap.last, truth, n: s.lap.n });
  const lapTxt2 = phase === 'free' ? '2' : '2 / ' + Q;
  check(what + ': HUD timing box shows it (lap "' + lapTxt2 + '", 上一圈 = 最快圈 = ' + fmt(truth) + ')', s.hud.lap === lapTxt2 && s.hud.last === fmt(truth) && s.hud.best === fmt(truth), [s.hud.lap, s.hud.last, s.hud.best]);
  return { time: truth, stats: cr[1] ? cr[1].stats : null, done: w.evs('lapDone').slice(d0), snap: s };
}

/* ================= one track ================= */
async function runTrack(key) {
  part = key;
  const cfg = TRACKS[key], w = makeWin(key), wall0 = Date.now();
  const rep = report[key] = { id: cfg.id, laps: [], notes: [] };
  for (const f of fs.readdirSync(OUT)) if (f.indexOf(key + '-') === 0 && /\.png$/.test(f)) fs.unlinkSync(path.join(OUT, f));   // this track's old screenshots
  try {
    await scenario(w, cfg, rep);
  } catch (err) {
    check('scenario ran to the end', false, err && err.stack ? err.stack : String(err));
    try { await w.shot('crash'); } catch (e) {}
  }
  try {
    await w.sync();
    const tail = await w.js(`({ clockErr: __e.clockErr, padErr: __e.ap.padErr, vis: __e.visChanges, renders: __e.renders, skipped: __e.skipped, frames: __e.gameFrames, clock: __e.clock, rumbles: __e.rumbles })`);
    check('warp: the game\'s session clock is exactly the sum, bit for bit, of the frame dts the harness fed it (' + (JITTER ? '5..35 ms, irregular' : FRAME_MS.toFixed(3) + ' ms each') + ')', tail.clockErr === 0 && tail.vis === 0, tail);
    check('autopilot: the controller gave the game exactly what was asked (steer / throttle / brake through js/gamepad.js)', tail.padErr < 1e-9, tail.padErr);
    check('no lap was rejected at any point (no lapRejected event, no 沒有被採計 toast)', w.evs('lapRejected').length === 0 && !w.evs('toast').some(e => /沒有被採計/.test(e.text)),
      w.evs('lapRejected').concat(w.evs('toast').filter(e => /沒有被採計/.test(e.text))));
    const firstUpset = w.evs('ap-upset-end')[0], rec = w.log.filter(e => /^ap-(reverse|reset)$/.test(e.type) && (!firstUpset || e.i < firstUpset.i));
    check('autopilot: never needed a recovery on its own (no reversing out, no reset button' + (firstUpset ? '; before the deliberate upsets' : '') + ')', rec.length === 0, rec);
    await w.noErrors('whole run');
    rep.gameS = (tail.clock - CLOCK_BASE) / 1000; rep.frames = tail.frames; rep.renders = tail.renders; rep.wallS = (Date.now() - wall0) / 1000; rep.pumpS = w.wallPump / 1000;
    rep.apEvents = rec.map(e => e.type + '@' + e.idx);
  } catch (err) { check('final state readable', false, String(err)); }
  w.destroy();
}

async function scenario(w, cfg, rep) {
  let s, e, ok, cr, done, from;
  /* ---------- boot, menu, track ---------- */
  const boot = await w.open();
  check('boots without the error overlay; page helpers installed', !boot.overlay && boot.lib === 'ok', boot);
  check('menu: no track yet -> 開始大獎賽 disabled with 先選一條賽道', await w.js(`document.getElementById('gp-start').disabled && __e.shown('gp-hint') && document.getElementById('gp-hint').textContent === '先選一條賽道'`));
  check('menu: the controller is found by the menu-time poll (已連接)', await w.until(`F1.gamepad.state.connected && __e.shown('pad-status')`, 3000, 'pad found'));
  const idx = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(cfg.id)}; })`);
  check('track card clicked (real mouse click)', idx >= 0 && await w.click(`#track-grid .card[data-i="${idx}"]`), idx);
  check('track loads and the game asks for frames', await w.until(`F1.game.track && F1.game.trackData.id === ${J(cfg.id)} && F1.game.running && __e.queued() === 1`, 30000, 'track load'));
  check('warp hooks: renderer and car found', await w.js(`__e.hookRenderer() && __e.hookCar()`));
  await w.frames(3);
  s = await w.snap();
  const N = s.car.n, trackName = s.trackName, len = s.trackLen;
  const meta = await w.js(`({ pred: F1.game.raceLine.lapTime, crossings: F1.game.track.crossings, profile: F1.ui.getProfile(), ds: F1.game.track.length / F1.game.track.samples.length, minLap: F1.game.track.length / (330 / 3.6),
    year: F1.game.spec.year, spec: F1.game.spec.id, refCar: JSON.stringify(F1.game.spec) === JSON.stringify(F1.REF_SPEC) })`);
  const ctx = { pred: meta.pred, N, len };
  rep.name = trackName; rep.pred = meta.pred; rep.len = len;
  info(trackName + ': ' + (len / 1000).toFixed(3) + ' km, ' + N + ' samples, racing-line profile predicts ' + fmt(meta.pred) + ', session minimum lap ' + meta.minLap.toFixed(1) + ' s');
  check('first warped frame was drawn for real (renderer caught), the next ones are skipped', await w.js(`__e.renders === 1 && __e.skipped === 2 && !!__e.renderer`), await w.js(`[__e.renders, __e.skipped]`));
  check('free practice: on the start position (10 samples before the line, centreline, standing), lap counter idle, HUD "--"',
    s.car.i === N - 10 && Math.abs(s.car.d) < 0.01 && s.car.v === 0 && !s.lap.started && s.lap.n === 0 && s.hud.lap === '--' && s.hud.cur === '--' && s.hud.last === '--' && s.hud.best === '--',
    { car: s.car, lap: s.lap, hud: [s.hud.lap, s.hud.cur] });
  check('free practice: no session (phase free), normal HUD (no session box / lights / results), controller hint', s.gp.phase === 'free' && !s.gp.taking && s.gp.lapTotal === 0 && s.snapshot === null &&
    s.dom.hud && !s.dom.menu && !s.dom.hudGp && !s.dom.lights && !s.dom.results && s.dom.hintPad && !s.dom.hintKeys && s.dom.track === trackName, { gp: s.gp, dom: s.dom });

  /* ---------- the Grand Prix is started through the menu panel ---------- */
  check('Esc opens the menu; the loop stops asking for frames', await w.esc(true) && await w.js(`__e.queued() === 0`));
  const q = await w.type('#gp-q', String(Q)), r = await w.type('#gp-r', String(R));
  check('Q / R typed into the fields (click, select all, type): ' + Q + ' / ' + R, q === String(Q) && r === String(R), [q, r]);
  s = await w.snap();
  check('menu: 開始大獎賽 enabled, setup shown, no hint', s.dom.menuGp.setup && !s.dom.menuGp.startDisabled && !s.dom.menuGp.hint && !s.dom.menuGp.session, s.dom.menuGp);
  await w.shot('menu-before-start', true);
  from = w.log.length;
  const gpFrom = from, sid0 = s.gp.sid;                                  // log index where this Grand Prix begins
  if (cfg.startWith === 'enter') { await w.tap('Enter'); check('Enter pressed in the 正賽圈數 field (it still has the focus) instead of a click on 開始大獎賽', true); }
  else check('開始大獎賽 clicked', await w.click('#gp-start'));
  check('-> qualifying, out of the menu, frames asked for again', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running && __e.queued() === 1 && !__e.shown('menu')`, 3000, 'quali'));
  await w.sync();
  s = await w.snap();
  const sid = s.gp.sid, me0 = s.me;
  check('quali: phase event free -> quali, a new session id', w.evs('phase', from).length === 1 && w.evs('phase', from)[0].phase === 'quali' && w.evs('phase', from)[0].prev === 'free' && sid === sid0 + 1, { ev: w.evs('phase', from), sid, sid0 });
  check('quali: session snapshot: q ' + Q + ', r ' + R + ', track length, one driver, nothing done',
    s.snapshot && s.snapshot.q === Q && s.snapshot.r === R && near(s.snapshot.len, len, 1e-9) && s.snapshot.players.length === 1 && s.snapshot.order.join() === '1' && s.snapshot.grid.length === 0 &&
    me0.qLaps === 0 && me0.qBest === null && !me0.qDone && me0.rLaps === 0 && me0.rTime === 0 && !me0.fin, s.snapshot);
  check('quali: taking part, not locked, offline, target ' + Q + ' laps', s.gp.taking && !s.gp.locked && !s.gp.online && s.gp.canControl && s.gp.lap === 0 && s.gp.lapTotal === Q, s.gp);
  check('quali: car on the start position, standing; lap counter reset', s.car.i === N - 10 && Math.abs(s.car.d) < 0.01 && s.car.v === 0 && !s.lap.started && s.lap.n === 0 && s.lap.last === null, { car: s.car, lap: s.lap });
  // (v6: the stored object is {q, r, wear}; nothing here touches the 輪胎損耗 buttons: a fresh profile's x1)
  check('Q / R remembered in localStorage (v6: with the tyre wear x1 of a fresh profile)', (await w.js(`localStorage.getItem('f1drive.gp')`)) === J({ q: Q, r: R, wear: 1 }), await w.js(`localStorage.getItem('f1drive.gp')`));
  // v6: the session carries the season and the tyre wear; a fresh profile drives the reference car (F1.REF_SPEC, 2025)
  check('quali: v6 session config: season ' + meta.year + ' (the car\'s, a fresh profile\'s 2025 standard car = F1.REF_SPEC), tyre wear x1 (the tyres wear at the normal rate)',
    s.snapshot.year === meta.year && meta.year === 2025 && meta.refCar && s.snapshot.wear === 1 && s.tyres && s.tyres.rate === 1 && s.tyres.compound === 'M' && Math.max.apply(null, s.tyres.wear) === 0,
    { year: s.snapshot.year, wear: s.snapshot.wear, spec: meta.spec, tyres: s.tyres });
  await w.frames(2);
  s = await w.snap();
  const who = s.hud.rows[0] ? s.hud.rows[0].name : null;
  check('quali HUD: session box 排位賽, P1 / 1, 完成圈數 "0 / ' + Q + '", standings row (name, 0/' + Q + ', --); timing box lap "1 / ' + Q + '"',
    s.dom.hudGp && s.hud.gpTitle === '排位賽' && s.hud.gpPos === 'P1/1' && s.dom.gpLapRow && s.hud.gpLap === '0 / ' + Q && s.hud.rows.length === 1 && who === meta.profile.name &&
    s.hud.rows[0].pos === '1' && s.hud.rows[0].sub === '0/' + Q && s.hud.rows[0].val === '--' && /self/.test(s.hud.rows[0].cls) && s.hud.lap === '1 / ' + Q && s.hud.cur === '--' &&
    !s.dom.lights && !s.dom.results && !s.dom.players, s.hud);
  check('quali: toast 大獎賽開始：排位 ' + Q + ' 圈，正賽 ' + R + ' 圈', hasToast(w, from, '大獎賽開始：排位 ' + Q + ' 圈，正賽 ' + R + ' 圈'), w.evs('toast', from));

  /* ---------- out lap: the 20 m to the line ---------- */
  let c0 = w.evs('cross').length;
  const d0 = w.evs('lapDone').length;
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('out lap: the autopilot reaches the line', await w.pump(`E.n.cross >= ${c0 + 1}`, 60, 'first crossing'));
  await w.frames(1);
  s = await w.snap();
  check('timing starts at the first crossing of the line (lap 1, nothing reported)', s.lap.started && s.lap.n === 1 && s.lap.time < 2 * FRAME + 0.07 && s.hud.lap === '1 / ' + Q && s.hud.cur === fmtFloor(s.lap.time) &&
    w.evs('lapDone').length === d0 && s.me.qLaps === 0 && s.car.v > 10, { lap: s.lap, hud: [s.hud.lap, s.hud.cur], v: s.car.v });

  /* ---------- Suzuka: a deliberately cut lap through the crossover ---------- */
  if (cfg.cut) {
    const crs = meta.crossings;
    check('the crossover is in the track data', Array.isArray(crs) && crs.length === 1, crs);
    const lo = Math.min(crs[0][0], crs[0][1]), hi = Math.max(crs[0][0], crs[0][1]);
    from = w.log.length;
    await w.js(`__e.ap.cutPlan = { a: ${lo}, b: ${hi} }; true`);
    ok = await w.pump(`E.n['ap-cut'] >= 1`, 200, 'the autopilot reaches the crossover');
    s = await w.snap();
    check('cut lap: the autopilot slows down and turns off road ' + lo + ' onto road ' + hi + ' at the crossover (' + ((hi - lo) / N * 100).toFixed(0) + ' % of the lap skipped)', ok && s.ap.mode === 'cut' && s.car.v < 11, { ap: s.ap, car: s.car, truth: s.truth });
    await w.pump(`E.truth.idx >= ${hi + 8}`, 30, 'a few metres onto the other road');
    await w.shot('cut-at-the-crossover');
    ok = await w.pump(`E.n['ap-cut-done'] >= 1`, 120, 'onto the other road');
    s = await w.snap();
    const voidOn = w.evs('void', from).filter(v => v.on);
    check('cut lap: the car really drives on along the later road; the lap counter marks the lap void', ok && Math.abs(s.car.i - s.truth.idx) <= 2 && s.car.i > hi + 90 && s.lap.void === true && s.lap.behind === true && voidOn.length === 1 &&
      s.lap.n === 1 && s.lap.jumps >= 1, { car: s.car.i, truth: s.truth.idx, lap: s.lap, voidOn });
    info('cut: void set when car.state.sampleIndex was ' + (voidOn[0] ? voidOn[0].idx : '?') + ' (crossing ' + lo + ' / ' + hi + ')');
    ok = await w.pump(`E.n.cross >= ${c0 + 2}`, 200, 'the line after the cut');
    await w.frames(1);
    s = await w.snap();
    const crossCut = lastOf(w.evs('cross'));
    check('cut lap: crossing the line after the shortcut counts NOTHING: no lap reported, session laps 0, lap 1 still, no time', ok && crossCut.cut === true && w.evs('lapDone').length === d0 &&
      s.me.qLaps === 0 && s.me.qBest === null && s.lap.n === 1 && s.lap.last === null && s.lap.best === null && s.gp.lap === 0, { cross: crossCut, me: s.me, lap: s.lap });
    check('cut lap: HUD unchanged (lap "1 / ' + Q + '", 上一圈 --, 完成圈數 "0 / ' + Q + '", standings --)', s.hud.lap === '1 / ' + Q && s.hud.last === '--' && s.hud.best === '--' && s.hud.gpLap === '0 / ' + Q && s.hud.rows[0].val === '--' && s.hud.rows[0].sub === '0/' + Q, s.hud);
    check('cut lap: the lap is valid again from the line and the clock restarted there', s.lap.void === false && s.lap.behind === false && s.lap.started && s.lap.time < 2 * FRAME + 0.02 && crossCut.lapTime > 20 &&
      w.evs('void', from).length === 2, { lap: s.lap, atLine: crossCut.lapTime, voids: w.evs('void', from) });
    rep.notes.push('cut lap through the crossover ' + lo + ' -> ' + hi + ': ' + crossCut.lapTime.toFixed(1) + ' s on the lap clock at the line, not counted');
    c0 += 1;                                                              // the timed laps start at this crossing
  }

  /* ---------- timed lap 1 ---------- */
  ok = await w.pump(`E.n.cross >= ${c0 + 1} && E.frac() >= 0.3`, ctx.pred, 'a third of timed lap 1');
  s = await w.snap();
  // (v6: the speed box is gone; the speed is drawn by the telemetry graphic (canvas): what main.js handed it this frame)
  check('quali lap 1 under way: HUD lap "1 / ' + Q + '", 本圈 = the lap counter\'s clock, speed shown (the telemetry graphic got |speed| x 3.6 and the gear)', ok && s.hud.lap === '1 / ' + Q && s.hud.cur === fmtFloor(s.lap.time) &&
    s.tel && s.tel.speedKmh === Math.abs(s.car.v) * 3.6 && s.tel.gear >= 1 && s.lap.n === 1 && s.dom.speed === null,
    { hud: [s.hud.lap, s.hud.cur], tel: s.tel && [s.tel.speedKmh, s.tel.gear], lap: s.lap, v: s.car.v });
  await w.shot('quali-lap1');
  from = w.log.length;
  ok = await w.pump(`E.n.lapDone >= ${d0 + 1}`, ctx.pred * 1.6 + 60, 'timed lap 1');
  cr = w.evs('cross'); done = w.evs('lapDone');
  e = done[d0] || {};
  const q1 = e.time, q1truth = (cr[c0 + 1].steps - cr[c0].steps) * STEP;
  check('quali lap 1 completed and reported: ' + fmt(q1) + ' = physics steps between the two line crossings', ok && near(q1, q1truth, 1e-9) && e.phase === 'quali' && e.sid === sid, { time: q1, truth: q1truth });
  check('quali lap 1 accepted: session qLaps 1, qBest = the lap to the millisecond, still qualifying', e.me && e.me.qLaps === 1 && e.me.qBest === r3(q1) && !e.me.qDone && e.phaseAfter === 'quali' && w.evs('lapRejected', from).length === 0, e.me);
  check('quali lap 1 plausible: ' + fmt(q1) + ' against the line\'s prediction ' + fmt(ctx.pred) + (cfg.cut ? ' (flying: straight after the cut lap)' : ' (from a standing start 20 m before the line)'),
    q1 > meta.minLap && q1 > ctx.pred * 0.98 && q1 < ctx.pred * 1.12 + 3, { q1, pred: ctx.pred });
  check('quali lap 1: lap counter (last = best = the lap, now on lap 2)', e.lapAfter && e.lapAfter.n === 2 && e.lapAfter.last === q1 && e.lapAfter.best === q1 && e.lapAfter.started, e.lapAfter);
  check('quali lap 1: HUD timing box: lap "2 / ' + Q + '", 上一圈 = 最快圈 = ' + fmt(q1), e.hud && e.hud.lap === '2 / ' + Q && e.hud.last === fmt(q1) && e.hud.best === fmt(q1), e.hud && [e.hud.lap, e.hud.last, e.hud.best]);
  check('quali lap 1: session box: 完成圈數 "1 / ' + Q + '", standings row 1/' + Q + ' with the same ' + fmt(q1) + ', P1 / 1', e.hud && e.hud.gpLap === '1 / ' + Q && lapRow(e).val === fmt(q1) && lapRow(e).sub === '1/' + Q && e.hud.gpPos === 'P1/1' && e.hud.gpTitle === '排位賽', e.hud);
  check('quali lap 1: driven cleanly (no grass, no wall, no recovery)', clean(cr[c0 + 1].stats), cr[c0 + 1].stats);
  rep.laps.push([cfg.cut ? 'quali 1 (flying, straight after the cut lap)' : 'quali 1 (from a standing start 20 m before the line)', q1, cr[c0 + 1].stats]);

  /* ---------- timed lap 2, with an R reset in the middle ---------- */
  ok = await w.pump(`E.frac() >= 0.5`, ctx.pred, 'half of timed lap 2');
  const b = await w.snap();
  from = w.log.length;
  await w.tap('R');
  ok = await w.until(`F1.game.car.state.speed === 0 && Math.abs(F1.game.car.state.d) < 0.01`, 3000, 'R reset');
  await w.sync();
  const a = await w.snap();
  check('R in the middle of quali lap 2 (at ' + (b.car.v * 3.6).toFixed(0) + ' km/h, ' + b.car.d.toFixed(2) + ' m off the centreline): car back on the centreline where it was, standing',
    ok && Math.abs(a.car.d) < 0.01 && a.car.v === 0 && Math.abs(a.car.i - b.car.i) <= 1 && b.car.v > 8, { before: b.car, after: a.car });
  check('R reset: lap not touched (same lap, clock not reset, not void), no phase change, nothing reported', a.lap.n === 2 && a.lap.time === b.lap.time && a.lap.started && !a.lap.void && !a.lap.jumping &&
    a.gp.phase === 'quali' && w.evs('phase', from).length === 0 && w.evs('lapDone', from).length === 0 && a.lap.time > ctx.pred * 0.3, { before: b.lap, after: a.lap });
  await w.advance(1);
  s = await w.snap();
  check('R reset: the lap clock keeps running (1 s of session clock later: +1 s) and the autopilot pulls away', near(s.lap.time - b.lap.time, (s.gpNow - b.gpNow) / 1000, STEP + 1e-9) && s.gpNow - b.gpNow >= 1000 &&
    s.gpNow - b.gpNow < 1000 + FRAME * 1000 + 1e-6 && s.hud.cur === fmtFloor(s.lap.time) && s.car.v > 5 && s.hud.lap === '2 / ' + Q, { dt: s.lap.time - b.lap.time, clock: s.gpNow - b.gpNow, v: s.car.v, hud: [s.hud.lap, s.hud.cur] });
  await w.shot('quali-lap2-after-R');
  const gridFrom = w.log.length;
  ok = await w.pump(`E.n.lapDone >= ${d0 + 2}`, ctx.pred * 1.6 + 60, 'timed lap 2');
  cr = w.evs('cross'); done = w.evs('lapDone');
  e = done[d0 + 1] || {};
  const q2 = e.time, q2truth = (cr[c0 + 2].steps - cr[c0 + 1].steps) * STEP, qBest = Math.min(q1, q2);
  check('quali lap 2 (with the reset) still counts: ' + fmt(q2) + ' = physics steps between the crossings, reset and standstill included', ok && near(q2, q2truth, 1e-9) && e.phase === 'quali', { time: q2, truth: q2truth });
  check('quali lap 2 plausible: ' + fmt(q2), q2 > ctx.pred * 0.98 && q2 < ctx.pred * 1.12 + 12, { q1, q2 });
  check('quali lap 2 accepted: qLaps 2, qDone', e.me && e.me.qLaps === Q && e.me.qDone === true && w.evs('lapRejected', from).length === 0, e.me);
  check('qualifying best = the faster of the two laps (' + fmt(qBest) + ')', e.me && e.me.qBest === r3(qBest) && r3(q1) !== r3(q2), { q1, q2, qBest: e.me && e.me.qBest });
  rep.laps.push(['quali 2 (R reset at half distance)', q2, cr[c0 + 2].stats]);

  /* ---------- the grid, by itself ---------- */
  const phGrid = w.evs('phase', gridFrom);
  check('the session moves to the grid by itself, in the frame of the last qualifying lap', e.phaseAfter === 'grid' && phGrid.length === 1 && phGrid[0].phase === 'grid' && phGrid[0].prev === 'quali' && phGrid[0].inFrame && phGrid[0].f === e.f, phGrid);
  s = await w.snap();
  const snapG = s.snapshot, hold = snapG.goAt - snapG.lightsAt - 5000;
  check('grid: snapshot: grid [1], lights 4 s after the lap (session clock), lights out 5 s + a 0.5..2 s hold later', snapG.phase === 'grid' && snapG.grid.join() === '1' && near(snapG.lightsAt, e.gpNow + 4000, 1e-6) && hold >= 500 && hold <= 2000 &&
    snapG.players[0].qBest === r3(qBest), { lightsAt: snapG.lightsAt - e.gpNow, hold });
  check('grid slot = P1: locked, gridSlot 0', s.gp.phase === 'grid' && s.gp.locked && s.gp.gridSlot === 0 && s.gp.taking && s.view.pos === 1 && s.view.count === 1, s.gp);
  let bx = await w.js(`__e.box(0)`);
  check('grid: the car stands in grid box 1: nose at the front bar 8 m behind the line, left of the centreline, straight, standing',
    near(bx.nose, 0.25, 0.02) && near(bx.turn, 0, 1e-6) && bx.v === 0 && bx.lat > 0.5 && bx.lat <= 3.001 && near(bx.lat, bx.gridD, 0.02) && bx.lat + 1 < bx.halfW && near(bx.back, (8 + 0.25 + 2.8) / meta.ds, 1.5), bx);
  check('grid: lap counter reset for the race (not started)', !s.lap.started && s.lap.n === 0 && s.lap.last === null && s.lap.best === null, s.lap);
  const gh = e.hud || { lights: {} };
  check('grid HUD (same frame): session box 起跑, P1 / 1, no 完成圈數 row, standings row with the qualifying best ' + fmt(qBest), gh.gpTitle === '起跑' && gh.gpPos === 'P1/1' && gh.gpLapRow === false && lapRow(e).val === fmt(qBest) && lapRow(e).sub === null, gh);
  check('grid HUD: timing box lap "1 / ' + R + '", clocks --; start lights box shown, 0 lamps, 準備起跑', gh.lap === '1 / ' + R && gh.cur === '--' && gh.last === '--' && gh.best === '--' && gh.lights.shown && gh.lights.on === 0 && !gh.lights.go && gh.lights.text === '準備起跑', gh);
  check('grid: toast 起跑位置 P1 / 1，燈號全滅就起跑', hasToast(w, gridFrom, '起跑位置 P1 / 1，燈號全滅就起跑'), w.evs('toast', gridFrom));
  const slot = { x: s.car.x, z: s.car.z };

  // lights: R is ignored while locked; screenshots at 3 and 5 lamps and at lights out
  const g0 = w.evs('go').length, cR = w.evs('cross').length, dR = w.evs('lapDone').length;   // go events / crossings / reports before the race
  check('grid: 2 lamps', await w.pump(`g.gp.lights >= 2`, 8, '2 lamps'));
  await w.tap('R');
  await sleep(100);
  s = await w.snap();
  bx = await w.js(`__e.box(0)`);
  check('grid: R is ignored while locked (the car stays in its box)', s.car.x === slot.x && s.car.z === slot.z && s.gp.locked && near(bx.nose, 0.25, 0.02) && near(bx.lat, bx.gridD, 0.02), s.car);
  if (cfg.stall) {
    // one frame arrives a whole second late: main.js simulates at most 0.25 s of it, and the session clock goes with that
    const sb = await w.snap();
    await w.js(`__e.stall(1000)`);
    await w.frames(1);
    s = await w.snap();
    check('a frame 1 s late on the grid: the session clock moves on by the clamped 0.25 s only, the car stays frozen, the lamps follow the clock', near(s.gpNow - sb.gpNow, 250, 1e-6) && s.gp.locked && s.car.x === slot.x && s.car.z === slot.z &&
      s.hud.lights.on === expLampsAt(s.gpNow, snapG) && s.gp.lights === s.hud.lights.on, { dclock: s.gpNow - sb.gpNow, lights: s.hud.lights, gp: s.gp.lights });
  }
  await w.pump(`g.gp.lights >= 3`, 3, '3 lamps');
  await w.shot('grid-3-lights');
  if (cfg.gridPause) {
    await w.pump(`g.gp.lights >= 4`, 3, '4 lamps');
    const gb = await w.snap();
    check('Esc with 4 start lights on opens the menu', await w.esc(true) && await w.js(`__e.queued() === 0 && __e.spin(1200)`));
    await sleep(300);
    const gm = await w.snap(), gmg = gm.dom.menuGp;
    check('menu on the grid: the session clock stands still (the lights wait), still locked; panel 起跑 正賽 ' + R + ' 圈，燈號全滅就起跑, 你的起跑位置：P1 / 1, 結束大獎賽 only',
      gm.gpNow === gb.gpNow && gm.gp.locked && gm.gp.lights === 4 && !gm.running && /^起跑\s*正賽 3 圈，燈號全滅就起跑$/.test(gmg.state) && gmg.self === '你的起跑位置：P1 / 1' && gmg.end && !gmg.skip && !gmg.again &&
      !gmg.setup && gmg.rows[0].val === fmt(qBest), { clock: [gb.gpNow, gm.gpNow], gmg });
    await w.shot('menu-on-the-grid', true);
    if (cfg.gridPause === 'button') check('繼續駕駛 (menu button) clicked', await w.click('#menu-resume') && await w.until(`F1.game.running && !__e.shown('menu')`, 3000, 'resume'));
    else check('Esc resumes', await w.esc(false));
    await w.frames(1);
    s = await w.snap();
    check('back on the grid: same clock, 4 lamps, still frozen in the box', s.gpNow === gb.gpNow && s.hud.lights.on === 4 && s.hud.lights.shown && s.gp.locked && s.car.x === slot.x && s.car.z === slot.z && s.car.v === 0 && s.dom.hud,
      { clock: s.gpNow - gb.gpNow, lights: s.hud.lights });
  }
  await w.pump(`g.gp.lights >= 5`, 3, '5 lamps');
  s = await w.snap();
  check('grid, 5 lamps: still frozen, full throttle held on the controller, HUD lamps 5', s.car.v === 0 && s.car.x === slot.x && s.car.z === slot.z && s.pad.thr === 1 && s.hud.lights.on === 5 && s.gp.locked, { car: s.car, pad: s.pad, lights: s.hud.lights });
  await w.shot('grid-5-lights');
  ok = await w.pump(`E.n.go >= ${g0 + 1}`, 4, 'lights out');
  const go = w.evs('go')[g0];
  await w.shot('lights-out');
  check('lights out', ok && !!go);
  /* ---------- the race ---------- */
  ok = await w.pump(`E.n.cross >= ${cR + 1}`, 30, 'the line after the start');
  await w.frames(1);
  s = await w.snap();
  cr = w.evs('cross');
  const toLine = go.sinceGo + (cr[cR].steps - go.steps) * STEP;
  check('race: the first crossing of the line (' + toLine.toFixed(2) + ' s after lights out, from the grid slot behind it) completes nothing', ok && w.evs('lapDone').length === dR && s.lap.n === 1 && s.lap.last === null &&
    s.lap.behind === false && s.me.rLaps === 0 && s.gp.lap === 0 && s.hud.lap === '1 / ' + R && s.hud.gpLap === '0 / ' + R && toLine > 0.8 && toLine < 3 && near(cr[cR].lapTime + STEP, toLine, 1e-9),
    { toLine, lap: s.lap, me: s.me, hud: [s.hud.lap, s.hud.gpLap] });
  check('race clock = session clock since lights out (behind by the physics time not simulated yet: less than a step; never ahead)', s.gp.sinceGo - s.lap.time > -1e-9 && s.gp.sinceGo - s.lap.time < STEP + 1e-9, { lap: s.lap.time, sinceGo: s.gp.sinceGo });

  // the start procedure, frame by frame
  await w.pump(`!g.gp.goFlash`, 3, 'end of the GO flash');
  const rec = (await w.js(`__e.grid`)).filter(x => x[0] >= e.gpNow - 1e-6);
  // rec row: [clock, grid?, locked, gp.lights, DOM lamps, box shown, go class, speed, x, z, pad throttle, steer, caption, goFlash, frame, steps]
  const locked = rec.filter(x => x[2] === 1), unlockIdx = rec.findIndex((x, i) => i > 0 && rec[i - 1][2] === 1 && x[2] === 0);
  const expLamps = c => c >= snapG.goAt || c < snapG.lightsAt ? 0 : Math.min(5, 1 + Math.floor((c - snapG.lightsAt) / 1000));
  const seq = [], firstOn = {};
  rec.forEach(x => { if (!seq.length || lastOf(seq) !== x[4]) { seq.push(x[4]); if (firstOn[x[4]] === undefined) firstOn[x[4]] = x[0]; } });
  check('car frozen until lights out: speed 0 and the same position in every locked frame (' + locked.length + ' frames, ' + ((snapG.goAt - e.gpNow) / 1000).toFixed(2) + ' s of session clock from the last qualifying lap to lights out)',
    locked.length >= ((snapG.goAt - e.gpNow) / 1000 - (cfg.stall ? 0.25 : 0)) / FRAME - 1 && locked[0][0] === e.gpNow && lastOf(locked)[0] < snapG.goAt && locked.every(x => x[7] === 0 && x[8] === slot.x && x[9] === slot.z && x[11] === 0),
    { n: locked.length, first: locked[0] && locked[0][0], last: lastOf(locked) && lastOf(locked)[0], lap: e.gpNow, goAt: snapG.goAt });
  check('the autopilot holds full throttle through the lock (controller throttle 1 in every locked frame after the first)', locked.slice(1).every(x => x[10] === 1), locked.filter(x => x[10] !== 1).length);
  check('start lights: DOM lamps 0,1,2,3,4,5,0, in every frame exactly what the session clock says (one more per second from lightsAt, out at goAt)', seq.join('') === '0123450' && rec.every(x => x[4] === expLamps(x[0]) && x[3] === x[4]) &&
    [1, 2, 3, 4, 5].every(k => firstOn[k] >= snapG.lightsAt + (k - 1) * 1000), { seq: seq.join(''), firstOn, lightsAt: snapG.lightsAt });
  const flash = rec.filter(x => x[6] === 1);
  check('start lights box: on screen for the whole grid phase (準備起跑), then GO for 1.5 s, then gone', rec.filter(x => x[1] === 1).every(x => x[5] === 1 && x[12] === '準備起跑' && x[6] === 0) && flash.length >= 1.5 / FRAME - 1 && rec.every(x => (x[6] === 1) === (x[0] >= snapG.goAt)) &&
    lastOf(flash)[0] - snapG.goAt < 1500 && flash.every(x => x[12] === 'GO' && x[5] === 1 && x[4] === 0) && !(await w.snap()).dom.lights, { flash: flash.length, last: lastOf(flash) && lastOf(flash)[0] - snapG.goAt });
  // (the car moves with the first physics step after the go frame: the next frame, or the one after when a frame is shorter than a step)
  const goRow = rec[unlockIdx] || [], moveRow = rec.slice(unlockIdx + 1).find(x => x[15] > goRow[15]) || [];
  check('lights out in the first frame past goAt; the car still stands in that frame and moves with the very next physics step (throttle held, no new input)',
    unlockIdx > 0 && goRow[0] >= snapG.goAt && rec[unlockIdx - 1][0] < snapG.goAt && goRow[7] === 0 && goRow[8] === slot.x && goRow[9] === slot.z && moveRow[7] > 0.05 && (moveRow[0] - goRow[0]) / 1000 < STEP + FRAME + 1e-9 &&
    goRow[15] === rec[unlockIdx - 1][15], { go: goRow.slice(0, 11), move: moveRow.slice(0, 11), goAt: snapG.goAt });
  const phRace = w.evs('phase', gridFrom).filter(p => p.phase === 'race');
  check('one "go" event, then phase grid -> race in the same frame; session clock at go = goAt + less than a frame',
    w.evs('go').length === g0 + 1 && phRace.length === 1 && phRace[0].prev === 'grid' && phRace[0].f === go.f && go.phase === 'grid' && go.goAt === snapG.goAt &&
    near(go.sinceGo, (go.gpNow - snapG.goAt) / 1000, 1e-12) && go.sinceGo >= 0 && go.sinceGo < FRAME + 1e-9 && go.clock === go.gpNow, { go, phRace });
  check('lights out: lap counter armed (lap 1, behind the line), race clock = time since lights out', go.lap.started && go.lap.n === 1 && go.lap.behind === true && go.lap.time === go.sinceGo && go.lap.last === null, go.lap);
  check('lights out HUD (same frame): 正賽, 完成圈數 "0 / ' + R + '", lap "1 / ' + R + '", 本圈 ' + fmtFloor(go.sinceGo) + ', GO shown, standings 領先',
    go.hud.gpTitle === '正賽' && go.hud.gpLap === '0 / ' + R && go.hud.gpLapRow && go.hud.lap === '1 / ' + R && go.hud.cur === fmtFloor(go.sinceGo) && go.hud.lights.go && go.hud.lights.text === 'GO' &&
    go.hud.rows[0].val === '領先' && go.hud.gpPos === 'P1/1', go.hud);

  // race lap 1 (from the grid)
  from = w.log.length;
  ok = await w.pump(`E.n.lapDone >= ${dR + 1}`, ctx.pred * 1.6 + 60, 'race lap 1');
  cr = w.evs('cross'); done = w.evs('lapDone');
  e = done[dR] || {};
  const r1 = e.time, r1truth = go.sinceGo + (cr[cR + 1].steps - go.steps) * STEP;
  check('race lap 1: ' + fmt(r1) + ' = from lights out (on the grid slot) to the second crossing of the line: time since go at the go frame + physics steps', ok && near(r1, r1truth, 1e-9) && e.phase === 'race', { r1, truth: r1truth });
  check('race lap 1 accepted: rLaps 1, race time = best = the lap to the millisecond, not finished', e.me && e.me.rLaps === 1 && e.me.rTime === r3(r1) && e.me.rBest === r3(r1) && !e.me.fin && e.phaseAfter === 'race', e.me);
  check('race lap 1: the session clock since lights out agrees with it (the lap clock lags by less than a frame + a step)', (e.gpNow - snapG.goAt) / 1000 - r1 > -1e-9 && (e.gpNow - snapG.goAt) / 1000 - r1 < FRAME + STEP + 1e-9, (e.gpNow - snapG.goAt) / 1000 - r1);
  check('race lap 1 plausible (standing start ' + (8 + 0.25 + 2.8).toFixed(1) + ' m behind the line): ' + fmt(r1), r1 > ctx.pred * 0.98 && r1 < ctx.pred * 1.12 + 6, { r1, pred: ctx.pred });
  check('race lap 1 HUD: lap "2 / ' + R + '", 上一圈 = 最快圈 = ' + fmt(r1) + ', 完成圈數 "1 / ' + R + '", P1 / 1, gap cell 領先', e.hud && e.hud.lap === '2 / ' + R && e.hud.last === fmt(r1) && e.hud.best === fmt(r1) &&
    e.hud.gpLap === '1 / ' + R && e.hud.gpPos === 'P1/1' && lapRow(e).val === '領先' && lapRow(e).pos === '1' && e.hud.gpTitle === '正賽', e.hud);
  check('race lap 1: view: P1 of 1, 1 lap, no gap, not a lap down', e.view.pos === 1 && e.view.count === 1 && e.view.rows[0].laps === 1 && e.view.rows[0].gap === null && e.view.rows[0].down === 0 && e.view.rows[0].best === r3(r1) &&
    e.view.rows[0].time === null && e.view.endsInMs === null, e.view.rows[0]);
  check('race lap 1: driven cleanly', clean(cr[cR + 1].stats), cr[cR + 1].stats);
  rep.laps.push(['race 1 (standing start on the grid)', r1, cr[cR + 1].stats]);

  // race lap 2: Esc to the menu in the middle of it
  await w.pump(`E.frac() >= 0.5`, ctx.pred, 'half of race lap 2');
  const pb = await w.snap();
  from = w.log.length;
  check('Esc in the middle of race lap 2 opens the menu; no frames are asked for', await w.esc(true) && await w.js(`__e.queued() === 0`));
  check('menu open: 30 s of synthetic frame time with nothing to run', await w.js(`__e.spin(1800)`) === true);
  await sleep(700);                                                     // wall time too: the menu-time pad poll runs with the throttle still held
  await w.sync();
  const pm = await w.snap();
  check('menu during the race: the offline session clock stands still (session clock, race time, lap clock, car: unchanged)',
    pm.gpNow === pb.gpNow && pm.lap.time === pb.lap.time && pm.gp.sinceGo === pb.gp.sinceGo && pm.car.x === pb.car.x && pm.car.z === pb.car.z && pm.car.v === pb.car.v && !pm.running && pm.gp.phase === 'race' &&
    w.evs('phase', from).length === 0 && pm.pad.thr === pb.pad.thr, { before: [pb.gpNow, pb.lap.time, pb.gp.sinceGo], menu: [pm.gpNow, pm.lap.time, pm.gp.sinceGo], running: pm.running });
  const mg = pm.dom.menuGp;
  check('menu during the race: panel shows 正賽 共 ' + R + ' 圈, 你已完成 1 / ' + R + ' 圈（P1 / 1）, standings 領先, 結束大獎賽 only (no setup / 跳過排位 / 再來一場), 繼續駕駛',
    mg.session && !mg.setup && /^正賽\s*共 3 圈$/.test(mg.state) && mg.self === '你已完成 1 / ' + R + ' 圈（P1 / 1）' && mg.end && !mg.skip && !mg.again && mg.rows.length === 1 && mg.rows[0].val === '領先' &&
    mg.rows[0].pos === '1' && mg.resume && pm.dom.menu && !pm.dom.hud, mg);
  await w.shot('menu-mid-race', true);
  check('Esc resumes', await w.esc(false) && await w.js(`__e.queued() === 1`));
  await w.frames(1);
  s = await w.snap();
  check('resume: the first frame has dt 0 (clock unchanged), then it runs on from where it stopped', s.gpNow === pb.gpNow && s.lap.time === pb.lap.time && s.dom.hud && !s.dom.menu, [s.gpNow - pb.gpNow, s.lap.time - pb.lap.time]);
  await w.advance(1);
  s = await w.snap();
  check('resume: 1 s of frames later the session clock is 1 s on, the lap clock with it, the car at speed', s.gpNow - pb.gpNow >= 1000 && s.gpNow - pb.gpNow < 1000 + FRAME * 1000 + 1e-6 &&
    near(s.lap.time - pb.lap.time, (s.gpNow - pb.gpNow) / 1000, 2 * STEP) && s.car.v > 5 && s.lap.n === 2, [s.gpNow - pb.gpNow, s.lap.time - pb.lap.time, s.car.v]);
  ok = await w.pump(`E.n.lapDone >= ${dR + 2}`, ctx.pred * 1.6 + 60, 'race lap 2');
  cr = w.evs('cross'); done = w.evs('lapDone');
  e = done[dR + 1] || {};
  const r2 = e.time, r2truth = (cr[cR + 2].steps - cr[cR + 1].steps) * STEP, clock2 = (e.gpNow - snapG.goAt) / 1000;
  check('race lap 2 (paused in the menu) is still accepted: ' + fmt(r2) + ' = physics steps between the crossings (the pause is not in it)', ok && near(r2, r2truth, 1e-9) && e.me && e.me.rLaps === 2 && !e.me.fin &&
    w.evs('lapRejected', from).length === 0, { r2, truth: r2truth, me: e.me });
  check('race lap 2: race time so far = lap 1 + lap 2 (to the ms) = session clock since lights out (the pause is not in the clock either)', e.me && near(e.me.rTime, r3(r3(r1) + r3(r2)), 1e-9) &&
    clock2 - (r1 + r2) > -1e-9 && clock2 - (r1 + r2) < FRAME + 2 * STEP + 1e-6 && e.me.rBest === r3(Math.min(r1, r2)), { rTime: e.me && e.me.rTime, laps: r1 + r2, clock: clock2 });
  check('race lap 2 HUD: lap "3 / ' + R + '", 上一圈 ' + fmt(r2) + ', 最快圈 ' + fmt(Math.min(r1, r2)) + ', 完成圈數 "2 / ' + R + '"', e.hud && e.hud.lap === '3 / ' + R && e.hud.last === fmt(r2) && e.hud.best === fmt(Math.min(r1, r2)) &&
    e.hud.gpLap === '2 / ' + R && lapRow(e).val === '領先', e.hud);
  check('race lap 2: driven cleanly', clean(cr[cR + 2].stats), cr[cR + 2].stats);
  rep.laps.push(['race 2 (flying, Esc pause at half distance)', r2, cr[cR + 2].stats]);

  // race lap 3: the finish
  await w.pump(`E.frac() >= 0.4`, ctx.pred, 'race lap 3 under way');
  await w.shot('race-lap3');
  from = w.log.length;
  ok = await w.pump(`E.n.lapDone >= ${dR + 3}`, ctx.pred * 1.6 + 60, 'race lap 3');
  cr = w.evs('cross'); done = w.evs('lapDone');
  e = done[dR + 2] || {};
  const r3t = e.time, r3truth = (cr[cR + 3].steps - cr[cR + 2].steps) * STEP;
  const total = r3(r3(r1) + r3(r2) + r3(r3t)), rBest = Math.min(r1, r2, r3t), clockTotal = (e.gpNow - snapG.goAt) / 1000;
  check('quali lap 2: the R reset cost time against a clean flying lap (race lap 3): +' + (q2 - r3t).toFixed(3) + ' s', q2 - r3t > 1.5, { q2, r3: r3t });
  check('race lap 3: ' + fmt(r3t) + ' = physics steps between the crossings; a clean flying lap', ok && near(r3t, r3truth, 1e-9) && clean(cr[cR + 3].stats), { r3: r3t, truth: r3truth, stats: cr[cR + 3].stats });
  check('race laps 2 and 3 (both flying) agree within 1.5 s: the menu pause added nothing to lap 2', Math.abs(r2 - r3t) < 1.5 && r3t > ctx.pred * 0.98 && r3t < ctx.pred * 1.08 + 1, { r2, r3: r3t, pred: ctx.pred });
  rep.laps.push(['race 3 (flying)', r3t, cr[cR + 3].stats]);
  const phRes = w.evs('phase', from);
  check('finish after ' + R + ' laps: fin, and the session goes to the results in that frame', e.me && e.me.fin && e.me.rLaps === R && e.phaseAfter === 'results' && phRes.length === 1 && phRes[0].phase === 'results' && phRes[0].prev === 'race' && phRes[0].f === e.f, { me: e.me, phRes });
  check('race total ' + fmt(total) + ' = sum of the three laps (each to the ms)', e.me && near(e.me.rTime, total, 1e-9) && near(e.me.rTime, r1 + r2 + r3t, 0.0016), { rTime: e.me && e.me.rTime, sum: r1 + r2 + r3t });
  check('race total = session clock from lights out to the finish (' + clockTotal.toFixed(4) + ' s; the lap clock lags the frame clock by less than a frame + two steps)', e.me && clockTotal - e.me.rTime > -0.002 && clockTotal - e.me.rTime < FRAME + 2 * STEP + 0.002 &&
    e.clock === e.gpNow, { clockTotal, rTime: e.me && e.me.rTime });
  check('race total = ground truth: time since go at the go frame + physics steps from lights out to the last crossing', near(r1 + r2 + r3t, go.sinceGo + (cr[cR + 3].steps - go.steps) * STEP, 1e-8), [r1 + r2 + r3t, go.sinceGo + (cr[cR + 3].steps - go.steps) * STEP]);
  check('fastest race lap = the quickest of the three', e.me && e.me.rBest === r3(rBest), { rBest: e.me && e.me.rBest, laps: [r1, r2, r3t] });
  rep.total = total; rep.qBest = qBest;

  /* ---------- results ---------- */
  await w.js(`__e.ap.mode = 'stop'; true`);
  await w.pump(`g.car.state.speed < 1`, 60, 'the car stops after the flag');
  await w.frames(5);
  s = await w.snap();
  const rr = s.dom.res.rows[0] || { cells: [] };
  // (v6: the subtitle names the season; no 輪胎損耗 part at wear x1)
  const resSub = trackName + ' ‧ ' + meta.year + ' 賽季 ‧ 排位 ' + Q + ' 圈 ‧ 正賽 ' + R + ' 圈';
  check('results overlay on screen with 再來一場 / 結束 / 關閉; subtitle ' + resSub, s.dom.results && s.dom.res.again && s.dom.res.end && s.dom.res.close && s.dom.res.note === '' &&
    s.dom.res.sub === resSub, s.dom.res);
  check('results table: one row: 1, ' + who + ' (你), ' + R + ' laps, total ' + fmt(total) + ', no gap, best lap ' + fmt(rBest) + ' (fastest-lap colour)', s.dom.res.rows.length === 1 && rr.cells[0] === '1' && rr.name === who && rr.you &&
    rr.cells[2] === String(R) && rr.cells[3] === fmt(total) && rr.cells[4] === '' && rr.cells[5] === fmt(rBest) && rr.fl && /self/.test(rr.cls) && !/out/.test(rr.cls), rr);
  check('results: HUD session box 成績, P1 / 1, no 完成圈數 row, standings row with the total ' + fmt(total), s.hud.gpTitle === '成績' && s.hud.gpPos === 'P1/1' && !s.dom.gpLapRow && s.hud.rows[0].val === fmt(total) && !s.dom.lights && !s.dom.gpEnds, s.hud);
  check('results: timing box lap "' + R + ' / ' + R + '", 上一圈 ' + fmt(r3t) + ', 最快圈 ' + fmt(rBest) + ' = the table\'s best lap', s.hud.lap === R + ' / ' + R && s.hud.last === fmt(r3t) && s.hud.best === fmt(rBest) && s.hud.best === rr.cells[5], [s.hud.lap, s.hud.last, s.hud.best]);
  check('results: view P1 of 1, finished, 3 laps, total, no gap; toast 正賽結束：你是第 1 名（共 1 位車手）', s.view.pos === 1 && s.view.count === 1 && s.view.done && s.view.rows[0].laps === R && s.view.rows[0].time === total && s.view.rows[0].gap === null &&
    s.view.rows[0].down === 0 && !s.view.rows[0].dnf && s.view.rows[0].best === r3(rBest) && hasToast(w, from, '正賽結束：你是第 1 名（共 1 位車手）'), { row: s.view.rows[0], toasts: w.evs('toast', from) });
  check('results: the car is not locked (it rolled to a stop under the autopilot\'s brake)', !s.gp.locked && Math.abs(s.car.v) < 1 && s.running, s.car);
  await w.shot('results');

  // the whole Grand Prix, as the player saw it
  const phases = w.evs('phase', gpFrom).map(p => p.phase), hudLaps = w.evs('hudLap', gpFrom).map(h => h.text), gpLaps = w.evs('gpLap', gpFrom).map(h => h.text);
  check('phase sequence quali -> grid -> race -> results, one go', phases.join(' ') === 'quali grid race results' && w.evs('go', gpFrom).length === 1, phases);
  check('lap numbers shown in the timing box: 1 / 2, 2 / 2, 1 / 3, 2 / 3, 3 / 3', hudLaps.join(', ') === '1 / 2, 2 / 2, 1 / 3, 2 / 3, 3 / 3', hudLaps);
  check('完成圈數 shown in the session box: 0 / 2, 1 / 2, (grid: hidden), 0 / 3, 1 / 3, 2 / 3, (results: hidden)', J(gpLaps) === J(['0 / 2', '1 / 2', null, '0 / 3', '1 / 3', '2 / 3', null]), gpLaps);
  check('exactly ' + (Q + R) + ' laps were reported to the session, all accepted', w.evs('lapDone', gpFrom).length === Q + R && w.evs('lapRejected', gpFrom).length === 0, w.evs('lapDone', gpFrom).map(x => x.time));
  await w.noErrors('Grand Prix');
  info('laps: quali ' + fmt(q1) + ' ' + fmt(q2) + ' | race ' + fmt(r1) + ' ' + fmt(r2) + ' ' + fmt(r3t) + ' = ' + fmt(total) + ' | line prediction ' + fmt(ctx.pred));

  /* ---------- after the flag: nothing counts any more ---------- */
  if (cfg.coolDown) {
    from = w.log.length;
    const cc = w.evs('cross').length, before = await w.snap();
    await w.js(`__e.ap.mode = 'line'; true`);
    ok = await w.pump(`E.n.cross >= ${cc + 1}`, ctx.pred * 1.6 + 60, 'a lap after the flag');
    await w.frames(2);
    await w.js(`__e.ap.mode = 'stop'; true`);
    await w.pump(`g.car.state.speed < 1`, 60, 'stop');
    await w.frames(2);
    s = await w.snap();
    const calls = w.evs('lapDone', from), row = s.dom.res.rows[0] || { cells: [] };
    check('a lap after the flag (results overlay open): the session ignores it (still ' + R + ' laps, same total, same best), the table and the standings are unchanged', ok && calls.length === 1 && calls[0].phaseAfter === 'results' &&
      J(s.me) === J(before.me) && J(row.cells) === J(before.dom.res.rows[0].cells) && s.hud.rows[0].val === fmt(total) && s.gp.phase === 'results' && w.evs('phase', from).length === 0 && w.evs('lapRejected', from).length === 0,
      { calls: calls.map(c => [c.time, c.phaseAfter]), me: s.me, row: row.cells });
    const stopped = s.hud.cur === '--' && s.hud.last === fmt(r3t) && s.hud.best === fmt(rBest);
    const note = 'one more lap after the flag: the HUD timing box ' + (stopped ? 'stopped at the flag' : 'KEEPS TIMING') + ': 圈數 "' + s.hud.lap + '", 本圈 ' + s.hud.cur + ', 上一圈 ' + s.hud.last +
      (s.hud.last === fmt(r3t) ? '' : ' = the lap driven after the flag (' + fmt(calls[0].time) + '), not the last race lap ' + fmt(r3t)) + ', 最快圈 ' + s.hud.best + ' (race best ' + fmt(rBest) + ')';
    info(note);
    rep.notes.push(note);
    check('after the flag: HUD lap number stays "' + R + ' / ' + R + '"; the classification keeps the race best lap ' + fmt(rBest), s.hud.lap === R + ' / ' + R && row.cells[5] === fmt(rBest), [s.hud.lap, s.hud.last, s.hud.best]);
    check('after the flag: the timing box has stopped at the flag: 本圈 --, 上一圈 still the last race lap ' + fmt(r3t) + ', 最快圈 still the race best ' + fmt(rBest),
      s.hud.cur === '--' && s.hud.last === fmt(r3t) && s.hud.best === fmt(rBest), [s.hud.cur, s.hud.last, s.hud.best]);
    await w.shot('after-the-flag');
  }

  const res = { sid, total, rBest, who, trackName, N, len, r3t, crossings: meta.crossings, minLap: meta.minLap };
  if (cfg.ending === 'again') await endAgain(w, ctx, rep, res, cfg);
  else if (cfg.ending === 'end') await endOverlayEnd(w, ctx, rep, res);
  else if (cfg.ending === 'close') await endClose(w, ctx, rep, res);
  else if (cfg.ending === 'quit') await endQuit(w, ctx, rep, res, cfg);
}

/* ---------- checks shared by the endings ---------- */

// A new qualifying session has just started (再來一場): new id, everything cleared, car on the start position.
async function checkNewQuali(w, res, from, what) {
  await w.sync();
  let s = await w.snap();
  const ph = w.evs('phase', from);
  check(what + ': phase results -> quali with a NEW session id (' + res.sid + ' -> ' + s.gp.sid + ')', ph.length === 1 && ph[0].phase === 'quali' && ph[0].prev === 'results' && s.gp.sid === res.sid + 1 && s.snapshot.sid === res.sid + 1, { ph, sid: s.gp.sid });
  check(what + ': times cleared in the session (no laps, no best, no race time, not finished, empty grid, no lights clock)', s.me.qLaps === 0 && s.me.qBest === null && !s.me.qDone && s.me.rLaps === 0 && s.me.rTime === 0 && s.me.rBest === null &&
    !s.me.fin && s.snapshot.grid.length === 0 && s.snapshot.goAt === 0 && s.snapshot.lightsAt === 0 && s.snapshot.q === Q && s.snapshot.r === R, s.snapshot);
  check(what + ': car back on the start position, standing; lap counter cleared', s.car.i === res.N - 10 && Math.abs(s.car.d) < 0.01 && s.car.v === 0 && !s.lap.started && s.lap.n === 0 && s.lap.last === null && s.lap.best === null, { car: s.car, lap: s.lap });
  check(what + ': out of any menu, driving; results overlay gone', s.running && s.dom.hud && !s.dom.menu && !s.dom.results, s.dom);
  await w.frames(2);
  s = await w.snap();
  check(what + ': HUD: 排位賽, 完成圈數 "0 / ' + Q + '", standings --, timing box lap "1 / ' + Q + '" and all clocks --', s.hud.gpTitle === '排位賽' && s.hud.gpLap === '0 / ' + Q && s.hud.rows[0].val === '--' && s.hud.rows[0].sub === '0/' + Q &&
    s.hud.lap === '1 / ' + Q && s.hud.cur === '--' && s.hud.last === '--' && s.hud.best === '--' && !s.dom.lights, s.hud);
  check(what + ': toast 大獎賽開始', hasToast(w, from, '大獎賽開始：排位 ' + Q + ' 圈，正賽 ' + R + ' 圈'), w.evs('toast', from));
  return s;
}

// Qualifying is skipped from the menu panel: -> on the grid without a time.
async function skipToGrid(w, what) {
  check(what + ': Esc -> menu', await w.esc(true));
  const from = w.log.length;
  check(what + ': 跳過排位 (menu) clicked', await w.click('#gp-skip'));
  check(what + ': -> grid, pulled out of the menu, locked', await w.until(`F1.game.gp.phase === 'grid' && F1.game.running && F1.game.gp.inputLocked`, 3000, 'skip'));
  await w.sync();
  await w.frames(2);
  const s = await w.snap(), bx = await w.js(`__e.box(0)`);
  check(what + ': skipped qualifying: grid P1 without a time (standings --), car in box 1, toast', s.gp.gridSlot === 0 && s.snapshot.grid.join() === '1' && s.me.qBest === null && s.hud.rows[0].val === '--' && near(bx.nose, 0.25, 0.02) &&
    near(bx.lat, bx.gridD, 0.02) && bx.v === 0 && hasToast(w, from, '起跑位置 P1 / 1，燈號全滅就起跑') && s.hud.gpTitle === '起跑' && s.hud.lap === '1 / ' + R, { gp: s.gp, bx, hud: s.hud });
  return s;
}

// Back in free practice (the Grand Prix was ended): no session, timing restarts at the line.
async function checkFree(w, from, what, prev) {
  await w.sync();
  const ph = w.evs('phase', from).filter(p => p.phase === 'free');
  const s = await w.snap();
  check(what + ': phase ' + prev + ' -> free, once; session idle (not taking part, no lap target)', ph.length === 1 && ph[0].prev === prev && s.gp.phase === 'free' && !s.gp.taking && s.gp.lapTotal === 0 && !s.gp.locked &&
    s.snapshot.phase === 'free' && s.view.rows.length === 0, { ph: w.evs('phase', from), gp: s.gp });
  check(what + ': toast 大獎賽已結束，回到自由練習', hasToast(w, from, '大獎賽已結束，回到自由練習'), w.evs('toast', from));
  check(what + ': lap counter cleared (timing starts again at the next crossing of the line)', !s.lap.started && s.lap.n === 0 && s.lap.last === null && s.lap.best === null, s.lap);
  return s;
}
async function checkFreeHud(w, what) {
  await w.frames(2);
  const s = await w.snap();
  check(what + ': normal HUD back: no session box, no lights, no results overlay, no roster box; timing box lap "--", clocks --', s.dom.hud && !s.dom.hudGp && !s.dom.lights && !s.dom.results && !s.dom.players &&
    s.hud.lap === '--' && s.hud.cur === '--' && s.hud.last === '--' && s.hud.best === '--', { dom: s.dom, hud: [s.hud.lap, s.hud.cur, s.hud.last, s.hud.best] });
  return s;
}
async function freePracticeLap(w, ctx, rep, what) {
  const from = w.log.length;
  const l = await timedLap(w, ctx, what, 'free');
  check(what + ': nothing of it reaches a session (phase free, no phase event, no rejected lap)', l.snap.gp.phase === 'free' && l.done.every(d => d.phase === 'free' && d.phaseAfter === 'free') && w.evs('lapRejected', from).length === 0 &&
    w.evs('phase', from).length === 0 && l.snap.gp.lapTotal === 0, l.done.map(d => [d.phase, d.time]));
  check(what + ': plausible (' + fmt(l.time) + ') and clean', l.time > ctx.pred * 0.98 && l.time < ctx.pred * 1.12 + 6 && clean(l.stats), { time: l.time, stats: l.stats });
  rep.laps.push([what, l.time, l.stats, ctx.pred]);
  await w.js(`__e.ap.mode = 'stop'; true`);
}

/* ---------- monza: 再來一場 on the overlay, a lap in the new session, 結束大獎賽 from the menu, free practice ---------- */
async function endAgain(w, ctx, rep, res, cfg) {
  let from = w.log.length, s;
  check('再來一場 (results overlay) clicked', await w.click('#gp-res-again'));
  check('-> a new qualifying', await w.until(`F1.game.gp.phase === 'quali'`, 3000, 'again'));
  await checkNewQuali(w, res, from, '再來一場');
  const l = await timedLap(w, ctx, 'new session', 'quali');
  const e = l.done[0] || {};
  check('new session: the lap is reported to session ' + (res.sid + 1) + ' and accepted as its first (qLaps 1, best ' + fmt(l.time) + '), standings show it', l.done.length === 1 && e.sid === res.sid + 1 && near(e.time, l.time, 1e-9) &&
    e.me.qLaps === 1 && e.me.qBest === r3(l.time) && e.hud.gpLap === '1 / ' + Q && lapRow(e).val === fmt(l.time), { e: e.me, hud: e.hud });
  rep.laps.push(['quali 1 of the second session (再來一場)', l.time, l.stats]);
  await w.shot('again-new-session');
  check('Esc -> menu', await w.esc(true));
  s = await w.snap();
  let mg = s.dom.menuGp;
  check('menu in qualifying: 排位賽 每人 ' + Q + ' 圈…, 你已完成 1 / ' + Q + ' 圈, 跳過排位 + 結束大獎賽, standings 1/' + Q + ' ' + fmt(l.time), mg.session && !mg.setup && /^排位賽\s*每人 2 圈，最快圈決定起跑順序$/.test(mg.state) &&
    mg.self === '你已完成 1 / ' + Q + ' 圈' && mg.skip && mg.end && !mg.again && mg.rows[0].val === fmt(l.time) && mg.rows[0].sub === '1/' + Q, mg);
  from = w.log.length;
  check('結束大獎賽 (menu) clicked', await w.click('#gp-end'));
  check('-> free practice', await w.until(`F1.game.gp.phase === 'free'`, 3000, 'end'));
  s = await checkFree(w, from, '結束大獎賽', 'quali');
  mg = s.dom.menuGp;
  check('結束大獎賽: the menu stays open with the setup back (開始大獎賽 enabled, Q / R still ' + Q + ' / ' + R + '), toast visible over the menu', !s.running && s.dom.menu && mg.setup && !mg.startDisabled && !mg.session && mg.q === String(Q) && mg.r === String(R) && s.dom.toast, mg);
  await w.shot('menu-after-end', true);
  check('Esc resumes', await w.esc(false));
  await checkFreeHud(w, 'free practice');
  await freePracticeLap(w, ctx, rep, 'free practice lap after the Grand Prix');
  await w.shot('free-practice');
  if (cfg.upset) await upsets(w, ctx, rep);
}

// The autopilot itself: thrown off the road twice (through the same controller), it must get back and finish the lap.
async function upsets(w, ctx, rep) {
  let s, ok, u, cr;
  // 1. full throttle and full lock at speed: over the grass into the wall
  await w.js(`__e.ap.mode = 'line'; true`);
  let c0 = w.evs('cross').length, from = w.log.length;
  const upFrom = from;
  ok = await w.pump(`g.car.state.speed > 60 && E.frac() > 0.05 && E.frac() < 0.6`, ctx.pred + 120, 'at speed');
  s = await w.snap();
  await w.js(`__e.ap.upset = { kind: 'wall', steer: ${s.car.d >= 0 ? 1 : -1}, time: 1.25 }; true`);
  ok = await w.pump(`!E.ap.upset`, 10, 'upset 1') && ok;
  u = lastOf(w.evs('ap-upset-end')) || { stats: {} };
  check('upset 1: full lock at ' + (s.car.v * 3.6).toFixed(0) + ' km/h for 1.25 s: the car goes over the grass into the wall (impact ' + (u.stats.maxHit || 0).toFixed(2) + ')', ok && u.stats.grass > 0 && u.stats.hits > 0 && u.grass, u);
  await w.shot('upset-against-the-wall');
  ok = await w.pump(`E.n.cross >= ${c0 + 1}`, ctx.pred * 2 + 120, 'the lap after upset 1');
  await w.frames(2);
  s = await w.snap();
  cr = w.evs('cross');
  let truth = (cr[c0].steps - cr[c0 - 1].steps) * STEP;
  check('upset 1: the autopilot brakes, steers back onto the road and finishes the lap (' + fmt(truth) + ', ' + statTxt(cr[c0].stats) + '); the lap counter timed it', ok && near(s.lap.last, truth, 1e-9) && !s.car.grass &&
    Math.abs(s.car.d) < s.truth.N && truth > ctx.pred, { last: s.lap.last, truth, stats: cr[c0].stats, events: w.log.slice(from).filter(x => /^ap-/.test(x.type)).map(x => x.type) });
  rep.laps.push(['free practice, thrown into the wall at speed (upset 1)', truth, cr[c0].stats]);

  // 2. turned round: slowed down and held on full lock until the car faces backwards
  c0 = w.evs('cross').length; from = w.log.length;
  await w.pump(`E.frac() > 0.3`, ctx.pred + 60, 'a third of the lap');
  await w.js(`__e.ap.upset = { kind: 'spin', time: 20 }; true`);
  ok = await w.pump(`!E.ap.upset`, 25, 'upset 2');
  u = lastOf(w.evs('ap-upset-end')) || { stats: {} };
  check('upset 2: the car is turned round (heading ' + (u.herr * 180 / Math.PI).toFixed(0) + ' deg against the track)', ok && Math.abs(u.herr) > 2.6, u);
  await w.shot('upset-facing-backwards');
  ok = await w.pump(`E.n['ap-reset'] >= 1 && E.ap.resetState === 0 && g.car.state.speed > 5`, 20, 'the reset button');
  s = await w.snap();
  const rs = w.evs('ap-reset', from);
  check('upset 2: facing the wrong way the autopilot uses its last resort, the controller\'s A button: the game puts the car back on the centreline, facing forwards, and it drives on', ok && rs.length === 1 &&
    Math.abs(s.car.i - s.truth.idx) <= 2 && s.lap.started && !s.lap.void, { rs, car: s.car, lap: s.lap });
  ok = await w.pump(`E.n.cross >= ${c0 + 1}`, ctx.pred * 2 + 120, 'the lap after upset 2');
  await w.frames(2);
  s = await w.snap();
  cr = w.evs('cross');
  truth = (cr[c0].steps - cr[c0 - 1].steps) * STEP;
  check('upset 2: the lap is finished and still counts (' + fmt(truth) + ' = physics steps between the crossings, the turn-round and the reset included)', ok && near(s.lap.last, truth, 1e-9) && truth > ctx.pred,
    { last: s.lap.last, truth, stats: cr[c0].stats });
  rep.laps.push(['free practice, turned round + reset button (upset 2)', truth, cr[c0].stats]);

  // 3. v6: the wall impact damaged the tyres (js/tyres.js: an impact over HIT_FLAT flat-spots a tyre, one over HIT_PUNCT
  //    punctures it with a chance that grows with the impact: random, ~80 % for a full-lock hit at speed). A punctured car
  //    tops out at ~100..150 km/h: it cannot "lap normally again" until it gets new tyres. So the recovery goes on the way
  //    a driver's would: into the pit lane (limiter on with Q before the entry line, off after the exit), a stop in the own
  //    box for a new set, then the flying lap. The check on that lap is unchanged.
  s = await w.snap();
  const dmg = s.tyres, dmgToasts = w.evs('toastCall', upFrom).filter(x => /爆胎/.test(x.text));
  check('upset 1 left real tyre damage (v6): a flat spot on at least one tyre' + (dmg.puncture >= 0 ? ', and a puncture (' + ['FL', 'FR', 'RL', 'RR'][dmg.puncture] + ')' : ' (no puncture this time: the chance is random)') +
    '; the telemetry graphic shows the same tyres; a puncture is announced once by a toast', Math.max.apply(null, dmg.flat) > 0.05 && s.tel && J(s.tel.tyres.flat) === J(dmg.flat) && s.tel.tyres.puncture === dmg.puncture &&
    dmgToasts.length === (dmg.puncture >= 0 ? 1 : 0), { tyres: dmg, grip: dmg.grip, toasts: dmgToasts.map(x => x.text) });
  rep.notes.push('upsets: tyre damage flat ' + dmg.flat.map(x => x.toFixed(2)).join('/') + ', puncture ' + dmg.puncture + ', grip lat ' + dmg.grip.lat.toFixed(3) + ' brake ' + dmg.grip.brake.toFixed(3) + ' traction ' + dmg.grip.traction.toFixed(3));
  from = w.log.length;
  const pv = await pitStop(w, ctx, { limiter: true, what: 'upset recovery' });
  if (pv) {
    const t2 = pv.after.tyres;
    check('upset recovery: into the pit lane (limiter on before the entry line, no speeding), stopped in box 1, the service (' + (pv.info.rec.svcWork || 0).toFixed(2) + ' s) put on a new medium set: no wear, no flat spot, no puncture, grip 1 / 1 / 1',
      pv.info.rec.limiterAtEntry === true && pv.info.rec.speedingFrames === 0 && pv.info.rec.svcPenalty === 0 && pv.stopsAfter === pv.stopsBefore + 1 && t2.compound === 'M' && Math.max.apply(null, t2.wear) < 1e-6 &&
      Math.max.apply(null, t2.flat) === 0 && t2.puncture === -1 && t2.grip.lat === 1 && t2.grip.brake === 1 && t2.grip.traction === 1, { rec: pv.info.rec, tyres: t2 });
    const stopLap = pv.stopLap;
    check('upset recovery: the lap with the stop counts on the lap counter with the stop in it (physics steps + ' + (stopLap ? stopLap.held : '?') + ' steps held in the box = ' + (stopLap ? fmt(stopLap.truth) : '?') + ')',
      stopLap && near(stopLap.last, stopLap.truth, 1e-9) && near(stopLap.held * STEP, pv.info.rec.svcTotal, STEP + 1e-9), stopLap);
    rep.laps.push(['free practice, the lap with the pit stop (new tyres)', stopLap ? stopLap.truth : NaN, stopLap ? stopLap.stats : null]);
  } else check('upset recovery: the pit stop was driven', false);
  // 4. and then a normal lap again: the one that starts where the lap with the stop ended
  c0 = w.evs('cross').length;
  ok = await w.pump(`E.n.cross >= ${c0 + 1}`, ctx.pred * 1.6 + 60, 'a lap after the upsets');
  cr = w.evs('cross');
  truth = cr[c0] ? (cr[c0].steps - cr[c0 - 1].steps) * STEP : NaN;
  check('after the upsets (and the new tyres) the autopilot laps normally again: ' + fmt(truth) + ', clean', ok && clean(cr[c0].stats) && truth > ctx.pred * 0.98 && truth < ctx.pred * 1.08 + 1 &&
    cr[c0].held === cr[c0 - 1].held, { truth, stats: cr[c0] && cr[c0].stats });
  rep.laps.push(['free practice, flying lap after the upsets', truth, cr[c0] && cr[c0].stats]);
  await w.js(`__e.ap.mode = 'stop'; true`);
}

// v6: a pit stop driven by solo-page.js's pit-lane driver. Q (a real key) switches the limiter on ~15 m before the entry
// line when o.limiter, and off again once the visit is over (6..8 m past the exit line). -> { info (E.pitInfo()), after
// {tyres}, stopsBefore / After, stopLap: {last, truth, held, stats} of the lap the service was in } or null
const PIT_BEFORE = 420;          // m before pit.from where the pit driver takes over from the line autopilot
const nearPit = m => `(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - E.truth.idx) % N + N) % N, m = k * g.track.length / N;
  return m < ${m} && m > ${m - 60}; })()`;
async function pitStop(w, ctx, o) {
  await w.js(`__e.ap.on = true; if (__e.ap.mode !== 'line') __e.ap.mode = 'line'; true`);
  if (!await w.pump(nearPit(PIT_BEFORE), ctx.pred * 2 + 120, o.what + ': ' + PIT_BEFORE + ' m before the pit lane')) return null;
  const stopsBefore = await w.js(`F1.game.pit.state.stops`), c0 = w.evs('cross').length;
  const plan = await w.js(`__e.pitPlan(${J({ cruise: !!o.limiter, vLane: o.vLane || 0 })})`);
  if (!plan || !plan.ok) { console.log('pitPlan: ' + J(plan)); return null; }
  if (o.limiter) {
    if (!await w.pump(`E.ap.pit.U >= E.ap.pit.uEn - Math.round(15 / (g.track.length / g.track.samples.length))`, 60, o.what + ': before the entry line')) return null;
    await w.tap('Q');
    if (!await w.until(`F1.game.limiter === true`, 2000, 'Q -> limiter on')) return null;
  }
  if (!await w.pump(`!!g.pit.state.service`, 90, o.what + ': the service starts')) return null;
  if (!await w.pump(`!g.pit.state.service`, 30, o.what + ': the service ends')) return null;
  const after = { tyres: (await w.snap()).tyres };            // (the frame of 'serviceDone': the new set, a step or two old)
  if (o.limiter) {
    if (!await w.pump(`!g.pit.state.visit && !g.pit.state.inLane`, 60, o.what + ': out of the lane')) return null;
    await w.tap('Q');
    if (!await w.until(`F1.game.limiter === false`, 2000, 'Q -> limiter off')) return null;
  }
  if (!await w.pump(`!E.ap.pit.active`, 60, o.what + ': the pit driver hands back')) return null;
  const info = await w.js(`__e.pitInfo()`), stopsAfter = await w.js(`F1.game.pit.state.stops`);
  // the lap the service was in: the first crossing after the service
  if (!await w.pump(`E.n.cross >= ${c0 + 1} && E.log.filter(function (e) { return e.type === 'cross'; }).slice(${c0}).some(function (c) { return c.held > ${info.rec.svcHeld0}; })`, ctx.pred * 2 + 120, o.what + ': the lap with the stop')) return { info, after, stopsBefore, stopsAfter, stopLap: null };
  await w.frames(1);
  const cr = w.evs('cross'), k = cr.findIndex((c, i) => i >= c0 && c.held > info.rec.svcHeld0), s = await w.snap();
  const stopLap = k > 0 ? { last: s.lap.last, truth: (cr[k].steps - cr[k - 1].steps) * STEP, held: cr[k].held - cr[k - 1].held, stats: cr[k].stats } : null;
  return { info, after, stopsBefore, stopsAfter, stopLap };
}

/* ---------- monaco: 結束 on the overlay, free practice ---------- */
async function endOverlayEnd(w, ctx, rep, res) {
  const from = w.log.length;
  check('結束 (results overlay) clicked', await w.click('#gp-res-end'));
  check('-> free practice', await w.until(`F1.game.gp.phase === 'free'`, 3000, 'end'));
  const s = await checkFree(w, from, '結束', 'results');
  check('結束: still driving (no menu)', s.running && s.dom.hud && !s.dom.menu, s.dom);
  await checkFreeHud(w, '結束');
  await w.shot('free-after-end');
  await freePracticeLap(w, ctx, rep, 'free practice lap after the Grand Prix');
  const t = await w.snap();
  check('free practice: lap numbers count on their own again (HUD lap "2", no "/ n")', t.hud.lap === '2' && t.gp.lapTotal === 0, t.hud.lap);
  await w.shot('free-practice-lap');
}

/* ---------- suzuka: 關閉; 再來一場 + 跳過排位 from the menu and a race with a cut lap; 再來一場, 結束大獎賽 in the race (DNF), 結束 ---------- */
async function endClose(w, ctx, rep, res) {
  let from = w.log.length, s;
  check('關閉 (results overlay) clicked', await w.click('#gp-close'));
  await w.frames(2);
  s = await w.snap();
  check('關閉: the overlay is gone, the session is still in results, the session box still shows 成績', !s.dom.results && s.gp.phase === 'results' && s.dom.hudGp && s.hud.gpTitle === '成績' && w.evs('phase', from).length === 0, s.dom);
  await w.shot('results-closed');
  check('Esc -> menu', await w.esc(true));
  s = await w.snap();
  let mg = s.dom.menuGp;
  check('menu in results: 成績 正賽 ' + R + ' 圈, 你的名次：P1 / 1, 再來一場 + 結束大獎賽 (no 跳過排位), row with total ' + fmt(res.total) + ' and best ' + fmt(res.rBest), mg.session && !mg.setup && /^成績\s*正賽 3 圈$/.test(mg.state) &&
    mg.self === '你的名次：P1 / 1' && mg.again && mg.end && !mg.skip && mg.rows[0].val === fmt(res.total) && mg.rows[0].best === fmt(res.rBest) && mg.rows[0].fl, mg);
  await w.shot('menu-results', true);
  from = w.log.length;
  check('再來一場 (menu) clicked', await w.click('#gp-again'));
  check('-> a new qualifying, pulled out of the menu', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000, 'again'));
  await checkNewQuali(w, res, from, '再來一場 (menu)');
  await skipToGrid(w, 'second session');

  // ---- a race whose first lap is cut through the crossover: the lap does not count, its time stays in the race ----
  const lo = Math.min(res.crossings[0][0], res.crossings[0][1]), hi = Math.max(res.crossings[0][0], res.crossings[0][1]);
  let g0 = w.evs('go').length, c0 = w.evs('cross').length;
  const dC = w.evs('lapDone').length;
  from = w.log.length;
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; __e.ap.cutPlan = { a: ${lo}, b: ${hi} }; true`);
  check('cut race: lights out, over the line', await w.pump(`E.n.go >= ${g0 + 1} && E.n.cross >= ${c0 + 1}`, 60, 'second race under way'));
  const go = w.evs('go')[g0], goAt = (await w.snap()).snapshot.goAt;
  let ok = await w.pump(`E.n.cross >= ${c0 + 2}`, 300, 'the line after the cut');
  await w.frames(1);
  s = await w.snap();
  const cut = lastOf(w.evs('cross')), cutTime = go.sinceGo + (cut.steps - go.steps) * STEP;
  check('cut race: the first lap is cut through the crossover; at the line (' + cutTime.toFixed(1) + ' s after lights out) nothing is counted: no lap reported, rLaps 0, still lap "1 / ' + R + '", the lap clock restarts',
    ok && cut.cut === true && w.evs('lapDone').length === dC && s.me.rLaps === 0 && s.me.rTime === 0 && s.lap.n === 1 && s.lap.last === null && !s.lap.void && s.lap.time < 2 * FRAME + 0.02 && s.hud.lap === '1 / ' + R &&
    s.hud.gpLap === '0 / ' + R && s.hud.last === '--' && w.evs('void', from).length === 2 && cutTime > 30, { cut, me: s.me, lap: s.lap, hud: [s.hud.lap, s.hud.gpLap, s.hud.last] });
  const times = [];
  let e = {}, prevTime = 0;
  for (let k = 1; k <= R; k++) {
    ok = await w.pump(`E.n.lapDone >= ${dC + k}`, ctx.pred * 1.6 + 60, 'cut race: counted lap ' + k);
    e = w.evs('lapDone')[dC + k - 1] || {};
    const cr = w.evs('cross'), truth = (cr[c0 + 1 + k].steps - cr[c0 + k].steps) * STEP, clock = (e.gpNow - goAt) / 1000;
    times.push(e.time);
    if (k === 1) {
      check('cut race: the first lap that counts is the one after the cut: ' + fmt(e.time) + ' = physics steps between the crossings, accepted as lap 1', ok && near(e.time, truth, 1e-9) && e.me.rLaps === 1 && e.me.rBest === r3(e.time) &&
        e.hud.lap === '2 / ' + R && e.hud.last === fmt(e.time) && e.hud.gpLap === '1 / ' + R, { time: e.time, truth, me: e.me, hud: [e.hud.lap, e.hud.last, e.hud.gpLap] });
      check('cut race: the race time after it is the SESSION CLOCK since lights out (' + clock.toFixed(3) + ' s: the cut lap + this lap), not the sum of counted laps', e.me.rTime === r3(clock) && clock - e.time > 30 &&
        clock - (cutTime + e.time) > -1e-9 && clock - (cutTime + e.time) < FRAME + 2 * STEP + 1e-6, { rTime: e.me.rTime, clock, cutTime, lap: e.time });
    } else {
      check('cut race: counted lap ' + k + ' ' + fmt(e.time) + ' accepted; race time = previous + the lap, in step with the session clock', ok && near(e.time, truth, 1e-9) && e.me.rLaps === k && near(e.me.rTime, prevTime + r3(e.time), 0.0011) &&
        Math.abs(clock - e.me.rTime) < FRAME + 2 * STEP + 0.002, { time: e.time, truth, rTime: e.me.rTime, clock });
    }
    prevTime = e.me ? e.me.rTime : 0;
    rep.laps.push(['cut race: counted lap ' + k + (k === 1 ? ' (from the line, after the shortcut)' : ' (flying)'), e.time, cr[c0 + 1 + k].stats]);
  }
  const total2 = e.me.rTime, sum2 = times[0] + times[1] + times[2], best2 = Math.min(times[0], times[1], times[2]);
  await w.js(`__e.ap.mode = 'stop'; true`);
  await w.pump(`g.car.state.speed < 1`, 60, 'stop');
  await w.frames(3);
  s = await w.snap();
  let rr = s.dom.res.rows[0] || { cells: [] };
  check('cut race: finished after ' + R + ' counted laps; total ' + fmt(total2) + ' = session clock from lights out to the finish = the cut lap (' + cutTime.toFixed(1) + ' s) + the three laps (' + sum2.toFixed(1) + ' s)',
    e.phaseAfter === 'results' && e.me.fin && e.me.rLaps === R && Math.abs((e.gpNow - goAt) / 1000 - total2) < FRAME + 2 * STEP + 0.002 && near(total2 - sum2, cutTime, 0.08) && e.me.rBest === r3(best2),
    { total2, sum2, cutTime, clock: (e.gpNow - goAt) / 1000 });
  check('cut race: results table: ' + R + ' laps, total ' + fmt(total2) + ', best ' + fmt(best2) + '; standings and toast agree', s.dom.results && rr.cells[2] === String(R) && rr.cells[3] === fmt(total2) && rr.cells[4] === '' &&
    rr.cells[5] === fmt(best2) && s.hud.rows[0].val === fmt(total2) && s.hud.best === fmt(best2) && hasToast(w, from, '正賽結束：你是第 1 名（共 1 位車手）'), { rr, hud: s.hud });
  rep.notes.push('race with a cut first lap: ' + cutTime.toFixed(1) + ' s to the line through the shortcut (not counted), then ' + times.map(fmt).join(' ') + '; total ' + fmt(total2) + ' (session clock)');
  await w.shot('results-after-cut-race');

  // ---- once more: ended by hand in the middle of the race (not classified) ----
  from = w.log.length;
  check('再來一場 (results overlay) clicked', await w.click('#gp-res-again'));
  check('-> a new qualifying', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000, 'again'));
  await checkNewQuali(w, Object.assign({}, res, { sid: res.sid + 1 }), from, '再來一場 (third session)');
  await skipToGrid(w, 'third session');
  g0 = w.evs('go').length; c0 = w.evs('cross').length;
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('third start: lights out, over the line, a fifth of the lap', await w.pump(`E.n.go >= ${g0 + 1} && E.n.cross >= ${c0 + 1} && E.frac() >= 0.2`, 90, 'second race under way'));
  s = await w.snap();
  check('third race under way: lap 1 of ' + R + ', no lap yet', s.gp.phase === 'race' && s.hud.lap === '1 / ' + R && s.me.rLaps === 0 && s.car.v > 10, s.hud);
  check('Esc -> menu', await w.esc(true));
  from = w.log.length;
  check('結束大獎賽 (menu, during the race) clicked', await w.click('#gp-end'));
  check('-> results', await w.until(`F1.game.gp.phase === 'results'`, 3000, 'end race'));
  await w.sync();
  s = await w.snap();
  mg = s.dom.menuGp;
  check('race ended by hand: results with the driver not classified (no laps, not finished); menu stays open with 再來一場 / 結束大獎賽', s.gp.phase === 'results' && !s.me.fin && s.me.rLaps === 0 && !s.running && mg.again && mg.end && !mg.skip &&
    mg.rows[0].val === '未完賽 DNF' && /out/.test(mg.rows[0].cls) && hasToast(w, from, '正賽結束：你沒有完賽'), { me: s.me, mg, toasts: w.evs('toast', from) });
  check('Esc resumes', await w.esc(false));
  await w.js(`__e.ap.mode = 'stop'; true`);
  await w.pump(`g.car.state.speed < 1`, 60, 'stop');
  await w.frames(3);
  s = await w.snap();
  rr = s.dom.res.rows[0] || { cells: [] };
  check('results overlay is open again for the new session: 0 laps, no total (--), 未完賽 DNF, no best lap, greyed row', s.dom.results && rr.cells[0] === '1' && rr.cells[2] === '0' && rr.cells[3] === '--' && rr.cells[4] === '未完賽 DNF' &&
    rr.cells[5] === '--' && /out/.test(rr.cls) && !rr.fl && s.hud.rows[0].val === '未完賽 DNF', rr);
  await w.shot('results-dnf');
  from = w.log.length;
  check('結束 (results overlay) clicked', await w.click('#gp-res-end'));
  check('-> free practice', await w.until(`F1.game.gp.phase === 'free'`, 3000, 'end'));
  await checkFree(w, from, '結束', 'results');
  await checkFreeHud(w, '結束');
  await freePracticeLap(w, ctx, rep, 'free practice lap after the Grand Prix');
  await w.shot('free-practice');
}

/* ---------- spa: 再來一場, skip, and another track in the middle of the race ---------- */
async function endQuit(w, ctx, rep, res, cfg) {
  let from = w.log.length, s, ok2;
  check('再來一場 (results overlay) clicked', await w.click('#gp-res-again'));
  check('-> a new qualifying', await w.until(`F1.game.gp.phase === 'quali'`, 3000, 'again'));
  await checkNewQuali(w, res, from, '再來一場');
  await skipToGrid(w, 'second session');
  const g0 = w.evs('go').length, c0 = w.evs('cross').length;
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('second start: lights out, over the line, 15 % of the lap', await w.pump(`E.n.go >= ${g0 + 1} && E.n.cross >= ${c0 + 1} && E.frac() >= 0.15`, 90, 'second race under way'));
  s = await w.snap();
  check('in the middle of race lap 1 at ' + (s.car.v * 3.6).toFixed(0) + ' km/h', s.gp.phase === 'race' && s.gp.taking && s.car.v > 10 && s.hud.lap === '1 / ' + R && s.dom.hudGp, s.gp);
  await w.shot('race-before-quit');
  check('Esc -> menu', await w.esc(true));
  from = w.log.length;
  const idx = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(cfg.quitTo)}; })`);
  check('another track\'s card clicked in the middle of the race (real mouse click)', await w.click(`#track-grid .card[data-i="${idx}"]`));
  check('the other track loads and runs', await w.until(`F1.game.trackData.id === ${J(cfg.quitTo)} && F1.game.running && __e.queued() === 1`, 30000, 'track switch'));
  s = await checkFree(w, from, 'quit to another track', 'race');
  check('quit: exactly one phase event (race -> free: no results phase on the way out)', w.evs('phase', from).length === 1, w.evs('phase', from).map(p => p.prev + '>' + p.phase));
  const N2 = s.car.n;
  check('quit: on the new track\'s start position, standing, out of the menu', s.trackId === cfg.quitTo && s.car.i === N2 - 10 && Math.abs(s.car.d) < 0.01 && s.car.v === 0 && s.running && !s.dom.menu && N2 !== res.N, { car: s.car, id: s.trackId });
  const t = await checkFreeHud(w, 'quit');
  check('quit: HUD shows the new track (' + t.dom.track + '), nothing of the session left over', t.dom.track === t.trackName && t.trackName !== res.trackName && t.gp.sinceGo === 0 && !t.gp.goFlash && t.gp.lights === 0 && t.gp.gridSlot === -1, [t.dom.track, t.gp]);
  await w.shot('quit-new-track');
  const pred2 = await w.js(`F1.game.raceLine.lapTime`);
  await freePracticeLap(w, { pred: pred2, N: N2 }, rep, 'free practice lap on ' + cfg.quitTo + ' after quitting the race');
  await w.pump(`g.car.state.speed < 1`, 60, 'stop');
  // and a new Grand Prix starts cleanly there
  check('Esc -> menu', await w.esc(true));
  s = await w.snap();
  check('menu on the new track: setup shown, 開始大獎賽 enabled', s.dom.menuGp.setup && !s.dom.menuGp.startDisabled && !s.dom.menuGp.session, s.dom.menuGp);
  from = w.log.length;
  check('開始大獎賽 clicked', await w.click('#gp-start'));
  check('-> qualifying on the new track', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000, 'quali'));
  await w.sync();
  await w.frames(2);
  s = await w.snap();
  check('new Grand Prix on the new track: next session id, its track length, start position, clean times, HUD "1 / ' + Q + '"', s.gp.sid === res.sid + 2 && near(s.snapshot.len, s.trackLen, 1e-9) && s.car.i === N2 - 10 && s.me.qLaps === 0 &&
    s.me.qBest === null && s.me.rLaps === 0 && s.hud.lap === '1 / ' + Q && s.hud.rows[0].val === '--' && !s.lap.started, { sid: s.gp.sid, me: s.me, hud: s.hud.lap });
  // ... and is ended from the menu while the start lights are on
  await skipToGrid(w, 'new Grand Prix');
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.gp.lights >= 2`, 8, '2 lamps');
  s = await w.snap();
  check('new Grand Prix: on the grid, 2 lamps, locked, lights box shown', s.gp.locked && s.hud.lights.on === 2 && s.dom.lights && s.car.v === 0, { gp: s.gp, lights: s.hud.lights });
  check('Esc -> menu', await w.esc(true));
  from = w.log.length;
  check('結束大獎賽 clicked while the lights are on', await w.click('#gp-end'));
  check('-> free practice', await w.until(`F1.game.gp.phase === 'free'`, 3000, 'end'));
  await checkFree(w, from, '結束大獎賽 on the grid', 'grid');
  check('Esc resumes', await w.esc(false));
  await checkFreeHud(w, '結束大獎賽 on the grid');
  const c0b = w.evs('cross').length;
  ok2 = await w.pump(`E.n.cross >= ${c0b + 1}`, 30, 'away from the grid slot');
  await w.frames(2);
  s = await w.snap();
  check('ended on the grid: the car is free at once (no lights left, not locked), drives off the grid slot and the first crossing starts free-practice timing (lap "1")',
    ok2 && !s.gp.locked && !s.dom.lights && s.car.v > 5 && s.lap.started && s.lap.n === 1 && s.hud.lap === '1' && w.evs('go', from).length === 0, { car: s.car, lap: s.lap, hud: s.hud.lap });
}

/* ================= main ================= */
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const silence = require('./silence')(app, 'solo');          // the harness must not be heard (see silence.js)
  setTimeout(() => { console.log('WATCHDOG: the run did not finish within 15 minutes'); app.exit(2); }, 15 * 60 * 1000);
  if (PATCH.length) console.log('PATCH: ' + PATCH.map(p => p[0] + ' <- ' + path.relative(ROOT, p[1]).replace(/\\/g, '/')).join(', '));
  if (JITTER || process.env.FRAME_MS) console.log('frame pace: ' + (JITTER ? 'irregular, 5..35 ms' : FRAME_MS + ' ms'));
  for (const key of Object.keys(TRACKS)) {
    if (ONLY.length && ONLY.indexOf(key) < 0) continue;
    try { await runTrack(key); } catch (e) { part = key; check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  }
  part = 'sound';
  const sr = await silence.finish();
  check(sr.text, sr.ok, sr.detail);
  part = '';
  console.log('\n===== autopilot lap times (real game, real input path, time-warped) =====');
  for (const key of Object.keys(report)) {
    const r = report[key];
    if (!r.name) continue;
    console.log(key + ' - ' + r.name + ' (' + (r.len / 1000).toFixed(3) + ' km): racing-line profile predicts ' + fmt(r.pred) +
      (r.total ? '; qualifying best ' + fmt(r.qBest) + ', race total ' + fmt(r.total) : ''));
    for (const l of r.laps) console.log('    ' + l[0].padEnd(58) + fmt(l[1]) + '  (' + (l[1] / (l[3] || r.pred) * 100 - 100 >= 0 ? '+' : '') + (l[1] / (l[3] || r.pred) * 100 - 100).toFixed(1) + ' % vs profile' + (l[3] && l[3] !== r.pred ? ' ' + fmt(l[3]) : '') + ')  ' + statTxt(l[2]));
    for (const n of r.notes) console.log('    note: ' + n);
    if (r.apEvents && r.apEvents.length) console.log('    autopilot recoveries: ' + r.apEvents.join(', '));
    if (r.gameS) console.log('    ' + r.gameS.toFixed(0) + ' s of game time (' + r.frames + ' frames, ' + r.renders + ' drawn) in ' + r.wallS.toFixed(1) + ' s wall; pumping alone ' + r.pumpS.toFixed(1) + ' s = ' +
      (r.gameS / Math.max(r.pumpS, 1e-3)).toFixed(0) + 'x real time');
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  try { fs.unlinkSync(path.join(OUT, 'index-patched-' + process.pid + '.html')); } catch (e) {}
  app.exit(bad.length ? 1 : 0);
});
