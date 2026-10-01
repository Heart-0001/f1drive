// Verifier probe, area "flow" (G2, G3, G4) in the real page: offscreen Electron, muted (electron-userdata.js).
//   npx electron devtests/review-final/verify-flow/run.js     env ONLY=g3,g4,g2  PORT=24950
// Reuses the reviewer's window helpers (devtests/review-final/game/lib.js); screenshots go to ./out. Not part of
// the project; nothing here edits project files.
'use strict';
const { app, ipcMain } = require('electron');
const path = require('path'), fs = require('fs');
require('../../electron-userdata')(app, 'verify-flow');
const L = require('../game/lib');
L.host.register(ipcMain);
const { sleep, J, check, note, state, results } = L;
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 24950);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

function makeWin(tag, o) {
  const w = L.makeWin(tag, o);
  w.shot = async (n, draw) => {
    if (draw) await w.js(`window.__e && __e.draw ? __e.draw() : true`);
    await sleep(draw ? 120 : 250);
    fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG());
    console.log('shot ' + n + '.png');
  };
  return w;
}

const PIT_BEFORE = 420;
const nearPit = m => `(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - g.car.state.sampleIndex) % N + N) % N, m = k * g.track.length / N;
  return g.lap.started && m < ${m} && m > ${m - 40}; })()`;
const SNAP = `({ phase: F1.game.gp.phase, running: F1.game.running, svc: F1.game.pit.state.service ? +F1.game.pit.state.service.left.toFixed(2) : null,
  visit: F1.game.pit.state.visit, inBox: F1.game.pit.state.inBox, stops: F1.game.pit.state.stops,
  tyres: { compound: F1.game.tyres.state.compound, puncture: F1.game.tyres.state.puncture, wear: F1.game.tyres.state.wear.map(function (x) { return +x.toFixed(3); }) },
  next: F1.game.nextCompound, v: +(F1.game.car.state.speed * 3.6).toFixed(1), x: +F1.game.car.state.x.toFixed(2), z: +F1.game.car.state.z.toFixed(2),
  svcStrip: __t.shown('hud-pit-svc') ? __t.text('hud-pit-svc') : '', toast: __t.shown('hud-toast') ? __t.text('hud-toast') : '' })`;

/* ===== G3: the session ends while we are held in the box for a service ===== */
async function partG3() {
  state.part = 'g3';
  const w = makeWin('g3');
  await w.open({ warp: true });
  check('Monza loads (warp)', await w.pickTrackWarp('it-1922'));
  await w.tap('Escape');
  await w.click('#tab-gp');
  await w.field('gp-q', '3'); await w.field('gp-r', '1');
  check('GP starts', await w.click('gp-start') && await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  await w.tap('T'); await w.tap('T');         // next set: M -> H -> S
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('timing starts', await w.pump(`g.lap.started`, 60, 'timing'));
  // wear the tyres a little so a fitted set would be visible
  await w.pump(`g.lap.time > 30`, 60, 'drive 30 s');
  if (!await w.pump(nearPit(PIT_BEFORE), 200, 'before the pit lane')) { check('reached the pit lane', false); return; }
  await w.tap('Q');
  const plan = await w.js(`__v.pitPlan(${J({ cruise: true })})`);
  note('plan ' + J(plan));
  check('service starts in our box', await w.pump(`!!F1.game.pit.state.service`, 90, 'service'));
  await w.frames(20);
  // the puncture that brought us in (set while held: it does not change the path of the drive in)
  await w.js(`F1.game.tyres.state.puncture = 1; true`);
  await w.frames(3);
  const before = await w.js(SNAP);
  note('held, before the end: ' + J(before));
  await w.shot('g3-1-held', true);
  // the session ends now (the host's 結束大獎賽 arriving online / solo: the same onGpPhase('free') path)
  await w.js(`__e.ap.on = false; __v.plan && (__v.plan.active = false); true`);
  const ended = await w.js(`F1.game.gp.action('end')`);
  await w.frames(4);
  const after = await w.js(SNAP);
  note('end -> ' + ended + '; 4 frames later: ' + J(after));
  await w.shot('g3-2-after-end', true);
  check('G3: service cancelled, no new set fitted (compound unchanged), puncture still there',
    before.svc > 0 && after.phase === 'free' && after.svc === null && after.tyres.compound === before.tyres.compound && after.tyres.puncture === 1 && after.tyres.compound !== after.next, { before, after });
  // standing in the box for 5 s (no input): does a service start again by itself?
  await w.frames(600);
  const stand = await w.js(SNAP);
  note('standing 5 s in the box: ' + J(stand));
  // all toasts since the service
  note('toasts: ' + J(await w.js(`__v.toasts.slice(-6).map(function (t) { return t.text; })`)));
  await w.noErrors();
  await L.close(w);
}

/* ===== G4: the results overlay at window sizes ===== */
async function partG4() {
  state.part = 'g4';
  const w = makeWin('g4');
  await w.open({ warp: true });
  check('Monza loads (warp)', await w.pickTrackWarp('it-1922'));
  await w.tap('Escape');
  await w.click('#tab-gp');
  await w.field('gp-q', '1'); await w.field('gp-r', '1');
  check('GP starts', await w.click('gp-start') && await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  await w.tap('Escape'); await w.click('#tab-gp');
  check('skip quali', await w.click('gp-skip') && await w.until(`F1.game.gp.phase === 'grid'`, 3000));
  if (!(await w.js(`F1.game.running`))) await w.tap('Escape');
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('race', await w.pump(`g.gp.phase === 'race'`, 40, 'race'));
  check('results', await w.pump(`g.gp.phase === 'results'`, 200, 'results'));
  await w.js(`__e.ap.on = false; true`);
  const R = `(function () { var q = function (s) { return __t.rect(s); };
    var b = document.getElementById('hud-menu-btn'), r = b.getBoundingClientRect(), pts = [[r.left + r.width / 2, r.top + 3], [r.left + r.width / 2, r.bottom - 3]];
    var hit = pts.map(function (p) { var e = document.elementFromPoint(p[0], p[1]); return e ? (e.id || e.className || e.tagName) : null; });
    return { win: [innerWidth, innerHeight], res: q('gp-results'), timing: q('hud-timing'), map: q('hud-map'), btn: q('hud-menu-btn'), toast: __t.shown('hud-toast') ? q('hud-toast') : null,
      gp: __t.shown('hud-gp') ? q('hud-gp') : null, tel: q('hud-telemetry'), btnHit: hit, resShown: __t.shown('gp-results') }; })()`;
  for (const s of [[1920, 1080], [1280, 720], [1024, 600], [800, 600], [700, 500], [560, 700]]) {
    await w.size(s[0], s[1]); await w.frames(3);
    const r = await w.js(R);
    const ov = (a, b) => a && b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
    note(s.join('x') + ': ' + J(r) + ' overlap timing=' + ov(r.res, r.timing) + ' map=' + ov(r.res, r.map) + ' btn=' + ov(r.res, r.btn) + ' toast=' + ov(r.res, r.toast) + ' gpbox=' + ov(r.res, r.gp));
    await w.shot('g4-' + s.join('x'), true);
  }
  // can the 選單 button be clicked where the overlay covers it?
  await w.size(560, 700); await w.frames(3);
  const clicked = await w.js(`(function () { var b = document.getElementById('hud-menu-btn'), r = b.getBoundingClientRect(); var e = document.elementFromPoint(r.left + r.width / 2, r.bottom - 3); return e === b || b.contains(e); })()`);
  note('560x700: the covered lower part of 選單 takes the click: ' + clicked);
  await w.noErrors();
  await L.close(w);
}

/* ===== G2: the host changes the room year while a guest drives ===== */
async function partG2() {
  state.part = 'g2';
  const A = makeWin('A'), B = makeWin('B');
  for (const w of [A, B]) { const e = await w.open(); if (e) check(w.tag + ' boots', false, e); }
  await A.field('mp-name', 'Host'); await A.field('mp-port', String(PORT));
  await B.field('mp-name', 'Guest'); await B.field('mp-addr', '127.0.0.1:' + PORT);
  await A.click('#tab-mp'); await A.click('mp-create');
  check('A hosts', await A.until(`F1.net.connected && F1.net.isHost`, 6000));
  await B.click('#tab-mp'); await B.click('mp-join');
  check('B joins', await B.until(`F1.net.connected`, 6000));
  await A.pickTrack('it-1922');
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`;
  check('both on Monza', await A.until(onTrack, 15000) && await B.until(onTrack, 15000));
  // B: frame-interval recorder
  await B.js(`(function () { var raf = window.requestAnimationFrame; window.__fi = { last: 0, s: [] };
    window.requestAnimationFrame = function (fn) { return raf.call(window, function (t) { var a = performance.now(); fn(t); __fi.s.push([+(t - __fi.last).toFixed(1), +(performance.now() - a).toFixed(1)]); __fi.last = t; if (__fi.s.length > 400) __fi.s.shift(); }); }; return true; })()`);
  // B drives flat out with the battery (E) for 4 s
  B.key('W', true); B.key('E', true);
  await sleep(4000);
  const b1 = await B.js(`({ spec: F1.game.spec.id, v: +(F1.game.car.state.speed * 3.6).toFixed(0), gear: F1.game.car.state.gear, bat: +F1.game.car.state.battery.toFixed(3), lineN: F1.game.raceLine && F1.game.raceLine.points.length })`);
  B.key('E', false);
  note('B before: ' + J(b1));
  await B.js(`__fi.s.length = 0; true`);
  // host: Esc, pick 2014 (hybrid: the battery shows)
  await A.tap('Escape');
  const y = await A.pickYear(2014);
  note('A picked ' + y);
  check('B follows 2014', await B.until(`F1.game.spec.year === 2014`, 5000));
  const b2 = await B.js(`({ spec: F1.game.spec.id, v: +(F1.game.car.state.speed * 3.6).toFixed(0), gear: F1.game.car.state.gear, bat: +F1.game.car.state.battery.toFixed(3), running: F1.game.running, toast: __t.text('hud-toast') })`);
  note('B right after: ' + J(b2));
  await sleep(500);
  const fi = await B.js(`__fi.s.slice()`);
  const worst = fi.slice().sort((a, b) => b[1] - a[1]).slice(0, 4);
  note('B frame intervals around the swap (ms; [interval, callback]) worst callbacks: ' + J(worst) + ' max interval ' + Math.max.apply(null, fi.map(x => x[0])));
  await B.shot('g2-guest-after-year');
  B.key('W', false);
  await A.noErrors(); await B.noErrors();
  await L.close(A); await L.close(B);
}

const PARTS = { g3: partG3, g4: partG4, g2: partG2 };
app.whenReady().then(async () => {
  for (const k of Object.keys(PARTS)) {
    if (ONLY.length && ONLY.indexOf(k) < 0) continue;
    try { await PARTS[k](); } catch (e) { check(k + ' part threw', false, String(e && e.stack || e)); }
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  await L.host.stopServer();
  app.exit(0);
});
