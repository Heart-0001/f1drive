// End-to-end smoke test of the v5 glue in js/main.js (gamepad, lap counter, Grand Prix): the REAL game in
// offscreen Electron windows, with the real preload / host IPC / server for the room part.
//   npx electron devtests/gp-smoke/smoke.js
//   env ONLY=free,solo,lap,pad,nopad,suzuka,room,spec (default: all)   PORT=24800 (room, spec)   TRACK=monza   ROOM_TRACK=monaco
//       MAIN=path/to/other-main.js  run against another build of js/main.js (e.g. a mutant, to see that a check notices)
// Screenshots go to devtests/gp-smoke/out/. Exit code 1 when a check fails.
//   free  boot, Monza, W / R / L / Esc / resume, free-practice lap HUD
//   solo  single-player Grand Prix through the menu panel: quali -> skip -> grid (frozen, lights) -> go -> end -> results -> free,
//         and picking another track ends a session
//   lap   a whole single-player Grand Prix with real lap-counter laps (the car is carried round the centreline at warp speed,
//         the game clock is stepped): rejected lap, accepted qualifying lap -> grid, race lap -> results, again, end
//   pad   stubbed Gamepad API: triggers, sticks, head look, buttons, rumble, grid lock, disconnect
//   nopad the page without js/gamepad.js (F1.gamepad absent): keyboard driving and the grid lock still work
//   suzuka R reset while the sample index sits on the other road of the crossover
//   room  host + guest + late joiner in one process: ghosts in qualifying, a guest lap decides the grid, synchronised start,
//         spectator, results, a track change ends the session
//   spec  a player who joins while the grid is formed: sees the start lights (spectator caption), is not locked; toasts are
//         visible while the menu is open (the host ends the Grand Prix from the panel, a spectator in the menu, join / leave)
// Grid slots are checked against the painted grid boxes (js/track.js): __t.box(slot) measures the car in the frame of box
// slot + 1, computed here from the rule (front bar (slot + 1) * 8 m behind the line, 3 m left / right), not from track.grid.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'gp-smoke');
// Every window drives the reference car (2025-standard, the v5 car these checks were written for): picked before the game
// boots (devtests/ref-car.js), since v6.1 a fresh install drives the 2026 standard car.
const refCar = require('../ref-car');
const host = require(path.join(ROOT, 'net', 'host'));
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.PORT || 24800);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const TRACK = (process.env.TRACK || 'monza').toLowerCase();
const ROOM_TRACK = (process.env.ROOM_TRACK || 'monaco').toLowerCase();
const MAIN = process.env.MAIN ? path.resolve(process.env.MAIN) : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let part = '';
function check(name, ok, detail) {
  results.push({ name: part + ': ' + name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + part + ': ' + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const J = v => JSON.stringify(v);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// the car stands in a grid box (b = __t.box(slot)): nose at the rear edge of the front bar, on the centreline, facing along it
const inBox = b => !!b && near(b.nose, 0.25, 0.02) && near(b.off, 0, 0.02) && near(b.turn, 0, 1e-6) && b.v === 0;

/* ---------- helpers living in the page ---------- */
const PAGE_LIB = `(function () {
  var t = window.__t = {
    car: function () { var s = F1.game.car.state; return { x: s.x, y: s.y || 0, z: s.z, h: s.heading, v: s.speed, i: s.sampleIndex, d: s.d, steer: s.steer, hit: s.hit, n: F1.game.track.samples.length }; },
    // The car against grid box slot + 1 (front bar (slot + 1) * 8 m behind the line, 0.25 m thick, centred 3 m to the left
    // for even slots / to the right for odd ones, straight in the frame of the sample the bar is on):
    //   nose = metres from the FRONT of the bar back to the tip of the car's nose (0.25 = at the rear edge of the bar),
    //   off = metres the nose is off the box centreline, turn = heading - box direction
    box: function (slot) {
      var tr = F1.game.track, S = tr.samples, n = S.length, k = slot + 1, c = F1.game.car.state;
      var s = S[((n - Math.round(k * 8 / (tr.length / n))) % n + n) % n], lat = k % 2 ? 3 : -3;
      var nx = c.x + Math.sin(c.heading) * 2.8, nz = c.z + Math.cos(c.heading) * 2.8;
      var turn = c.heading - Math.atan2(s.tx, s.tz);
      return { nose: -((nx - s.x) * s.tx + (nz - s.z) * s.tz), off: (nx - s.x) * s.nx + (nz - s.z) * s.nz - lat,
        turn: Math.atan2(Math.sin(turn), Math.cos(turn)), back: (n - c.sampleIndex) % n, d: c.d, v: c.speed };
    },
    // the toast: on screen? where? (it is not part of the HUD layer: it shows over the menu too)
    toast: function () { var e = document.getElementById('hud-toast'), r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return { shown: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden', text: e.innerText.replace(/\\s+/g, ' ').trim(), top: Math.round(r.top), bottom: Math.round(r.bottom),
        left: Math.round(r.left), right: Math.round(r.right), H: innerHeight, W: innerWidth, menu: t.shown('menu'), hud: t.shown('hud'),
        overMenu: Number(cs.zIndex) > Number(getComputedStyle(document.getElementById('menu')).zIndex), inHud: !!e.closest('#hud') }; },
    shown: function (id) { var e = document.getElementById(id); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; },
    text: function (id) { var e = document.getElementById(id); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null; },
    lights: function () { var e = document.getElementById('hud-lights'); return { shown: t.shown('hud-lights'), on: document.querySelectorAll('#hud-lights i.on').length, go: e.classList.contains('go'), text: document.getElementById('hud-lights-text').textContent }; },
    gp: function () { var g = F1.game.gp; return { phase: g.phase, online: g.online, taking: g.taking, locked: g.inputLocked, lights: g.lights, goFlash: g.goFlash,
      sinceGo: g.sinceGo, gridSlot: g.gridSlot, lap: g.lap, lapTotal: g.lapTotal, sid: g.sid, canControl: g.canControl }; },
    lap: function () { var l = F1.game.lap; return l ? { started: l.started, n: l.n, time: l.time, last: l.last, best: l.best, behind: l.behind, void: l.void } : null; },
    // remote car models: id -> drawn translucent?
    ghosts: function () { var m = F1.game.remoteModels, out = {}; Object.keys(m).forEach(function (k) { var g = false;
      m[k].group.traverse(function (o) { if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.9) g = true; }); out[k] = g; }); return out; },
    state: function () { return { car: t.car(), gp: t.gp(), lap: t.lap(), lights: t.lights(), running: F1.game.running, up: F1.game.input.up }; },
    // carry the car round the centreline at v m/s on top of whatever the physics does (test only): every physics step
    // moves it a few samples on, so the lap counter sees an ordinary (very fast) drive
    cruise: function (v) {
      t.uncruise();
      var car = F1.game.car, orig = car.update, carry = 0;
      t.uncruise = function () { car.update = orig; t.uncruise = function () {}; };
      car.update = function (dt, input, track) {
        orig.call(car, dt, input, track);
        if (!input) return;                    // placeOnGrid's re-locating call
        var S = track.samples, n = S.length, sp = track.length / n;
        carry += v * dt;
        var k = Math.floor(carry / sp);
        if (!k) return;
        carry -= k * sp;
        var i = (car.state.sampleIndex + k) % n, s = S[i];
        car.state.x = s.x; car.state.z = s.z; car.state.heading = Math.atan2(s.tx, s.tz);
        car.state.sampleIndex = i; car.state.d = 0; car.state.speed = 0;
      };
    },
    uncruise: function () {},
    // a standard-mapping controller behind navigator.getGamepads that the test controls:
    // window.__pad (axes / buttons), __btn(i, value), __padOn (false = unplugged), __rumble (effects played)
    fakePad: function () {
      var b = []; for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
      window.__rumble = [];
      window.__pad = { index: 0, id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b,
        vibrationActuator: { type: 'dual-rumble', playEffect: function (type, o) { window.__rumble.push([type, o.duration, o.weakMagnitude, o.strongMagnitude]); return Promise.resolve('complete'); } } };
      window.__padOn = true;
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return window.__padOn ? [window.__pad, null, null, null] : [null, null, null, null]; } });
      window.__btn = function (i, v) { var x = window.__pad.buttons[i]; x.value = v; x.pressed = v > 0.5; return true; };
      return true;
    },
    // strongest impact on our car: .all = any (walls too), .near = while the named player's car is within touching distance
    hits: function (name) {
      var h = { all: 0, near: 0, minDist: Infinity };
      clearInterval(window.__hitIv);
      window.__hits = h;
      window.__hitIv = setInterval(function () {
        var s = F1.game.car.state, p = F1.net.players.filter(function (q) { return q.name === name; })[0];
        var d = p && p.active ? Math.sqrt((p.state.x - s.x) * (p.state.x - s.x) + (p.state.z - s.z) * (p.state.z - s.z)) : Infinity;
        if (d < h.minDist) h.minDist = d;
        if (s.hit > h.all) h.all = s.hit;
        if (d < 7 && s.hit > h.near) h.near = s.hit;
      }, 4);
      return true;
    },
    hitsStop: function () { clearInterval(window.__hitIv); return window.__hits; },
    // one row per rendered frame: [ms, phase, locked, lamps lit in the DOM, speed, x, z, gp.lights, goFlash, lights box shown]
    rec: function () { var out = []; window.__rec = out; (function loop() { if (window.__rec !== out) return; var s = F1.game.car.state, g = F1.game.gp, l = t.lights();
      out.push([performance.now(), g.phase, g.inputLocked ? 1 : 0, l.on, s.speed, s.x, s.z, g.lights, g.goFlash ? 1 : 0, l.shown ? 1 : 0, l.go ? 1 : 0]); requestAnimationFrame(loop); })(); return true; },
    recStop: function () { var r = window.__rec; window.__rec = null; return r; }
  };
  return true;
})()`;

// The page to load: the real index.html, or a copy of it in the out folder (with a <base> pointing at the project)
// without the gamepad script and / or with another main.js.
function pageFile(noPad) {
  if (!noPad && !MAIN) return path.join(ROOT, 'index.html');
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const padTag = '<script src="js/gamepad.js"></script>', mainTag = '<script src="js/main.js"></script>';
  if (html.indexOf(padTag) < 0 || html.indexOf(mainTag) < 0) throw new Error('index.html: script tags not found');
  if (noPad) html = html.replace(padTag, '');
  if (MAIN) html = html.replace(mainTag, '<script src="' + url.pathToFileURL(MAIN).href + '"></script>');
  const file = path.join(OUT, 'index-' + (noPad ? 'nopad' : 'alt') + '.html');
  fs.writeFileSync(file, html.replace('<head>', '<head><base href="' + url.pathToFileURL(ROOT + path.sep).href + '">'));
  return file;
}

let winSeq = 0;
function makeWin(tag, w0, h0) {
  const w = new BrowserWindow({
    width: w0 || 1280, height: h0 || 720, show: false, useContentSize: true,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'gps-' + tag + '-' + (++winSeq),
      preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false
    }
  });
  w.webContents.setFrameRate(60);
  w.errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;    // dev-only CSP notice
    w.errors.push(msg);
    console.log('[' + tag + ' console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  host.attach(w);
  w.tag = tag;
  w.js = code => w.webContents.executeJavaScript(code);
  w.shot = async n => { await sleep(150); fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG()); };
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  w.tap = async k => { w.key(k, true); await sleep(60); w.key(k, false); await sleep(120); };
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(40); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  w.open = async noPad => {
    await refCar.seed(w);                     // the reference car (2025-standard) picked before the game boots
    await w.loadFile(pageFile(noPad));
    await sleep(900);
    await w.js(PAGE_LIB);
    return w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  };
  w.field = (id, v) => w.js(`(function () { var e = document.getElementById(${J(id)}); e.value = ${J(v)};
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  // a real mouse click in the middle of an element
  w.click = async id => {
    const r = await w.js(`(function () { var r = document.getElementById(${J(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    if (!(r.w > 0)) { console.log('click: ' + id + ' is not visible'); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
  };
  w.pick = name => w.js(`(function () { var c = [].slice.call(document.querySelectorAll('.card')).filter(function (n) { return n.textContent.toLowerCase().indexOf(${J(name)}) >= 0; })[0];
    if (!c) return null; c.click(); return c.querySelector('.card-name').textContent; })()`);
  w.state = () => w.js(`__t.state()`);
  w.noErrors = async () => {
    const overlay = await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    check(tag + ': no error overlay, no console errors', !overlay && w.errors.length === 0, overlay || w.errors.slice(0, 3));
  };
  return w;
}

// Watch one car on the grid until the race is on: -> what the frames showed.
function analyseStart(rec) {
  const locked = rec.filter(r => r[2] === 1);
  const first = locked[0];
  const movedWhileLocked = locked.filter(r => r[4] !== 0 || r[5] !== first[5] || r[6] !== first[6]).length;
  const seq = [];                                  // lamps lit, as they changed: [count, ms]
  rec.forEach(r => { if (r[1] === 'grid' && (!seq.length || seq[seq.length - 1][0] !== r[3])) seq.push([r[3], Math.round(r[0])]); });
  const gaps = [];
  for (let i = 2; i < seq.length; i++) gaps.push(seq[i][1] - seq[i - 1][1]);
  const unlockIdx = rec.findIndex((r, i) => i > 0 && rec[i - 1][2] === 1 && r[2] === 0);
  const moveIdx = rec.findIndex((r, i) => i >= Math.max(unlockIdx, 0) && r[4] > 0);
  const goShown = rec.filter(r => r[10] === 1).length;
  const dom = rec.filter(r => r[1] === 'grid' && r[3] !== r[7]).length;     // frames where the DOM lamps differ from gp.lights
  return {
    frames: rec.length, lockedFrames: locked.length, movedWhileLocked, lamps: seq.map(s => s[0]).join(''), gaps,
    unlockToMoveMs: unlockIdx >= 0 && moveIdx >= 0 ? Math.round(rec[moveIdx][0] - rec[unlockIdx][0]) : null,
    unlockAt: unlockIdx >= 0 ? rec[unlockIdx][0] : null, goFrames: goShown, domMismatch: dom,
    endPhase: rec.length ? rec[rec.length - 1][1] : null
  };
}

/* ================= free practice ================= */
async function partFree() {
  part = 'free';
  const w = makeWin('free');
  const err = await w.open();
  check('boots without the error overlay', !err, err || undefined);
  check('modules present', await w.js(`!!(F1.gp && F1.createLapCounter && F1.gamepad && F1.createSession && F1.net && F1.ui.setGp && F1.ui.setLights && F1.ui.setPad)`));
  const peek = await w.js(`(function () { var g = F1.game; return { gp: g.gp === F1.gp, lap: g.lap, input: g.input && Object.keys(g.input).join(','), raceLine: g.raceLine, running: g.running }; })()`);
  check('F1.game exposes gp / lap / input / raceLine (nothing loaded yet)', peek.gp && peek.lap === null && peek.input === 'up,down,left,right' && peek.raceLine === null && !peek.running, peek);
  check('menu: Grand Prix panel asks for a track first', await w.js(`document.getElementById('gp-start').disabled && __t.text('gp-hint') === '先選一條賽道' && __t.shown('gp-setup')`), await w.js(`__t.text('gp-hint')`));
  check('menu: no controller -> no 已連接 tag', await w.js(`!__t.shown('pad-status') && !F1.gamepad.state.connected`));
  await w.shot('a1-menu');

  const name = await w.pick(TRACK);
  check('track loads and the game runs (' + name + ')', await w.until(`F1.game.running && F1.game.track`, 15000));
  await sleep(400);
  let s = await w.state();
  check('start position: START_BACK samples before the line, on the centreline, standing', s.car.i === s.car.n - 10 && Math.abs(s.car.d) < 0.01 && s.car.v === 0, s.car);
  check('lap counter for this track, not started; HUD lap "--"', s.lap && !s.lap.started && s.lap.n === 0 && await w.js(`__t.text('hud-lap') === '--' && __t.text('hud-cur') === '--'`), s.lap);
  check('HUD: keyboard hint, no session box, no lights', await w.js(`__t.shown('hud-hint-keys') && !__t.shown('hud-hint-pad') && !__t.shown('hud-gp') && !__t.shown('hud-lights') && !__t.shown('gp-results')`));
  check('free practice: gp idle', s.gp.phase === 'free' && !s.gp.locked && !s.gp.taking && s.gp.lapTotal === 0, s.gp);

  w.key('W', true);
  await sleep(3000);
  s = await w.state();
  check('W for 3 s: the car accelerates', s.car.v > 20, s.car.v);
  check('crossing the line starts the timing (lap 1)', s.lap.started && s.lap.n === 1 && s.lap.time > 0 && s.lap.time < 3, s.lap);
  const cur1 = await w.js(`__t.text('hud-cur')`); await sleep(300); const cur2 = await w.js(`__t.text('hud-cur')`);
  check('HUD lap row "1" and the lap clock runs', await w.js(`__t.text('hud-lap') === '1'`) && cur1 !== cur2 && /^0:0\d\.\d{3}$/.test(cur1), [cur1, cur2]);
  w.key('A', true); await sleep(500); w.key('A', false); w.key('W', false);
  await w.shot('a2-driving');
  s = await w.state();
  check('A steers: the car is off the centreline', Math.abs(s.car.d) > 0.3 && s.car.v > 5, { d: s.car.d, v: s.car.v });
  const before = s;
  await w.tap('R');
  s = await w.state();
  check('R resets onto the centreline, standing, timing keeps running', Math.abs(s.car.d) < 0.01 && Math.abs(s.car.v) < 0.5 && s.lap.started && s.lap.n === 1 && s.lap.time > before.lap.time &&
    Math.abs(s.car.i - before.car.i) < 30, { d: s.car.d, v: s.car.v, i: [before.car.i, s.car.i], lap: s.lap });
  const l0 = await w.js(`F1.game.raceLine.group.visible`);
  await w.tap('L'); const l1 = await w.js(`F1.game.raceLine.group.visible`);
  await w.tap('L'); const l2 = await w.js(`F1.game.raceLine.group.visible`);
  check('L toggles the racing line', l0 === true && l1 === false && l2 === true, [l0, l1, l2]);

  await w.tap('Escape');
  check('Esc opens the menu', await w.js(`!F1.game.running && __t.shown('menu') && !__t.shown('hud') && __t.shown('menu-resume')`));
  check('menu: Grand Prix can be started now', await w.js(`!document.getElementById('gp-start').disabled && !__t.shown('gp-hint')`), await w.js(`__t.text('gp-hint')`));
  const t1 = (await w.state()).lap.time; await sleep(300); const t2 = (await w.state()).lap.time;
  check('the lap clock stands still while the menu is open', t1 === t2, [t1, t2]);
  await w.shot('a3-menu-track-loaded');
  await w.tap('Escape');
  check('Esc resumes', await w.js(`F1.game.running && __t.shown('hud') && !__t.shown('menu')`));
  await w.tap('Escape');
  await w.click('menu-resume');
  check('繼續駕駛 resumes', await w.js(`F1.game.running && __t.shown('hud')`));
  await sleep(200);
  check('timing survived the menu', (await w.state()).lap.time > t2 && await w.js(`__t.text('hud-lap') === '1'`));
  await w.noErrors();
  w.destroy();
}

/* ================= single player Grand Prix through the UI ================= */
async function partSolo() {
  part = 'solo';
  const w = makeWin('solo');
  await w.open();
  await w.pick(TRACK);
  await w.until(`F1.game.running`, 15000, 'track');
  await w.tap('Escape');
  check('Q / R fields take 1 / 1', (await w.field('gp-q', '1')) === '1' && (await w.field('gp-r', '1')) === '1');
  await w.click('gp-start');
  check('開始大獎賽 -> qualifying', await w.until(`F1.game.gp.phase === 'quali'`, 3000), await w.js(`__t.gp()`));
  await sleep(300);
  let s = await w.state();
  check('quali: menu closed, driving', s.running && await w.js(`!__t.shown('menu') && __t.shown('hud')`));
  check('quali: car on the start slot, lap counter reset', s.car.i === s.car.n - 10 && Math.abs(s.car.d) < 0.01 && s.car.v === 0 && !s.lap.started && s.lap.n === 0, { car: s.car, lap: s.lap });
  check('quali: taking part, not locked, target 1 lap', s.gp.taking && !s.gp.locked && s.gp.lap === 0 && s.gp.lapTotal === 1 && !s.gp.online && s.gp.canControl, s.gp);
  const box = await w.js(`__t.text('hud-gp')`), toast = await w.js(`__t.text('hud-toast')`);
  check('quali: HUD session box + lap row "1 / 1" + toast with the format', await w.js(`__t.shown('hud-gp')`) && /排位賽/.test(box) && /P1\s*\/ 1/.test(box) && await w.js(`__t.text('hud-lap') === '1 / 1'`) &&
    toast === '大獎賽開始：排位 1 圈，正賽 1 圈' && await w.js(`__t.shown('hud-toast') && !__t.shown('hud-lights')`), { box, toast, lap: await w.js(`__t.text('hud-lap')`) });
  // (v6: js/ui.js stores the tyre wear option with them)
  check('Q / R remembered', (await w.js(`localStorage.getItem('f1drive.gp')`)) === '{"q":1,"r":1,"wear":1}', await w.js(`localStorage.getItem('f1drive.gp')`));
  await w.shot('b1-quali');

  // drive over the line so that the grid placement really moves the car back
  w.key('W', true);
  await w.until(`F1.game.lap.started`, 6000, 'timing starts in qualifying');
  await sleep(400);
  s = await w.state();
  check('quali: timing starts at the first crossing of the line', s.lap.started && s.lap.n === 1 && s.car.v > 10 && s.up === true, s.lap);

  // W stays held from here on
  await w.js(`__t.rec()`);
  check('action("skip") -> grid', await w.js(`F1.game.gp.action('skip')`) === true && await w.until(`F1.game.gp.phase === 'grid'`, 2000));
  await sleep(250);
  s = await w.state();
  const slot = { x: s.car.x, z: s.car.z };
  const bx = await w.js(`__t.box(0)`);
  check('grid: car in grid box 1 (pole: nose at the front bar 8 m behind the line, 3 m left of the centreline), standing', inBox(bx) && near(bx.d, 3, 0.05) && near(bx.back, 5.5, 1) && s.car.v === 0, bx);
  check('grid: input locked, W still held, lap counter reset', s.gp.locked && s.gp.gridSlot === 0 && s.up === true && !s.lap.started && s.lap.n === 0 && s.running, { gp: s.gp, lap: s.lap, up: s.up });
  check('grid: lights box on screen, session box says 起跑, toast with the grid position', s.lights.shown && s.lights.text === '準備起跑' && /起跑/.test(await w.js(`__t.text('hud-gp')`)) &&
    (await w.js(`__t.text('hud-toast')`)) === '起跑位置 P1 / 1，燈號全滅就起跑', { lights: s.lights, toast: await w.js(`__t.text('hud-toast')`) });
  await w.tap('R');                                         // ignored while locked (it would put the car on the centreline)
  s = await w.state();
  check('grid: R is ignored while locked', inBox(await w.js(`__t.box(0)`)) && s.car.x === slot.x && s.car.z === slot.z, s.car);
  let shot3 = false, shot5 = false, shotGo = false;
  const end = Date.now() + 16000;
  while (Date.now() < end) {
    const l = await w.js(`__t.lights()`);
    if (!shot3 && l.on === 3) { shot3 = true; await w.shot('b2-grid-lights3'); }
    if (!shot5 && l.on === 5) { shot5 = true; await w.shot('b3-grid-lights5'); }
    if (!shotGo && l.go) { shotGo = true; await w.shot('b4-go'); }
    if ((await w.js(`F1.game.gp.phase`)) === 'race' && (await w.js(`F1.game.car.state.speed`)) > 3) break;
    await sleep(60);
  }
  s = await w.state();
  const a = analyseStart(await w.js(`__t.recStop()`));
  console.log('solo start:', J(a));
  check('grid: frozen in every locked frame with W held (speed 0, position unchanged)', a.lockedFrames > 200 && a.movedWhileLocked === 0, { lockedFrames: a.lockedFrames, moved: a.movedWhileLocked });
  check('grid: lamps come on 0,1,2,3,4,5, one per second', a.lamps === '012345' && a.gaps.slice(0, 4).every(g => near(g, 1000, 120)) && a.domMismatch <= 6, { lamps: a.lamps, gaps: a.gaps, domMismatch: a.domMismatch });
  check('lights out: W accelerates without a new key press', s.car.v > 3 && s.up === true && a.unlockToMoveMs !== null && a.unlockToMoveMs < 120, { v: s.car.v, unlockToMoveMs: a.unlockToMoveMs });
  check('lights out: GO flash shown', shotGo && a.goFrames > 5, a.goFrames);
  check('lights out: lap counter armed (started, lap 1, behind the line), phase race', s.lap.started && s.lap.n === 1 && s.lap.behind === true && s.gp.phase === 'race' && !s.gp.locked, { lap: s.lap, gp: s.gp });
  // (the lap clock is the session clock minus the physics time not simulated yet: never ahead of it)
  check('race clock = time since lights out (behind by less than a physics step, never ahead)', s.gp.sinceGo - s.lap.time > -1e-6 && s.gp.sinceGo - s.lap.time < 0.0125, { lapTime: s.lap.time, sinceGo: s.gp.sinceGo });
  await sleep(1900);
  check('race: lights gone after the flash, session box says 正賽, lap row "1 / 1"', await w.js(`!__t.shown('hud-lights') && /正賽/.test(__t.text('hud-gp')) && __t.text('hud-lap') === '1 / 1'`), await w.js(`__t.text('hud-gp')`));
  s = await w.state();
  check('race: first crossing of the line did not complete a lap', s.lap.n === 1 && s.lap.last === null && s.lap.behind === false && s.gp.lap === 0, s.lap);
  w.key('W', false);
  await w.shot('b5-race');

  check('action("end") in the race -> results', await w.js(`F1.game.gp.action('end')`) === true && await w.until(`F1.game.gp.phase === 'results'`, 2000));
  await sleep(200);
  check('results: overlay visible with 再來一場 / 結束 / 關閉, toast', await w.js(`__t.shown('gp-results') && __t.shown('gp-res-again') && __t.shown('gp-res-end') && __t.shown('gp-close')`) &&
    (await w.js(`__t.text('hud-toast')`)) === '正賽結束：你沒有完賽', { text: await w.js(`__t.text('gp-results')`), toast: await w.js(`__t.text('hud-toast')`) });
  await w.shot('b6-results');
  check('action("end") again -> free', await w.js(`F1.game.gp.action('end')`) === true && await w.until(`F1.game.gp.phase === 'free'`, 2000));
  await sleep(300);
  s = await w.state();
  check('free: normal HUD back (no session box / overlay / lights), lap counter reset, still driving', await w.js(`!__t.shown('hud-gp') && !__t.shown('gp-results') && !__t.shown('hud-lights')`) &&
    !s.lap.started && s.lap.n === 0 && s.running && await w.js(`__t.text('hud-lap') === '--'`) && (await w.js(`__t.text('hud-toast')`)) === '大獎賽已結束，回到自由練習', { lap: s.lap, hudLap: await w.js(`__t.text('hud-lap')`) });
  await w.shot('b7-free-again');

  // a session, then another track from the menu
  await w.tap('Escape');
  await w.click('gp-start');
  check('second session starts from the menu', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  await w.tap('Escape');
  check('menu during a session: state + 跳過排位 / 結束大獎賽, no setup', await w.js(`__t.shown('gp-session') && __t.shown('gp-skip') && __t.shown('gp-end') && !__t.shown('gp-setup') && /排位賽/.test(__t.text('gp-state'))`), await w.js(`__t.text('gp-panel')`));
  await w.shot('b8-menu-quali');
  const other = await w.js(`(function () { var cur = F1.game.trackData.id, i = F1_TRACKS.findIndex(function (t) { return t.id !== cur; }); document.querySelectorAll('.card')[i].click(); return F1_TRACKS[i].id; })()`);
  check('picking another track ends the session and loads it', await w.until(`F1.game.gp.phase === 'free' && F1.game.trackData.id === ${J(other)} && F1.game.running`, 15000), other);
  await sleep(300);
  s = await w.state();
  check('new track: start position, fresh lap counter, no session box', s.car.i === s.car.n - 10 && !s.lap.started && await w.js(`!__t.shown('hud-gp') && F1.game.lap.prevIdx === F1.game.car.state.sampleIndex`), s.car);
  w.key('W', true); await sleep(2500); w.key('W', false);
  s = await w.state();
  check('new track drives normally and times laps', s.car.v > 15 && s.lap.started && s.lap.n === 1 && await w.js(`__t.text('hud-lap') === '1'`), { v: s.car.v, lap: s.lap });
  await w.tap('Escape');
  check('menu: a new Grand Prix can be started on the new track', await w.js(`!document.getElementById('gp-start').disabled && __t.shown('gp-setup')`));
  await w.noErrors();
  w.destroy();
}

/* ================= single player Grand Prix with real lap-counter laps ================= */
async function partLap() {
  part = 'lap';
  const w = makeWin('lap');
  await w.open();
  await w.pick(TRACK);
  await w.until(`F1.game.running`, 15000, 'track');
  await w.tap('Escape');
  await w.field('gp-q', '1'); await w.field('gp-r', '1');
  await w.click('gp-start');
  await w.until(`F1.game.gp.phase === 'quali'`, 3000, 'quali');
  w.key('W', true);
  check('timing starts', await w.until(`F1.game.lap.started`, 6000));
  w.key('W', false);

  // 1. a lap that is far too quick: the session rejects it, the driver is told
  await w.js(`__t.cruise(2400)`);
  const rejected = await w.until(`/沒有被採計/.test(__t.text('hud-toast'))`, 8000, 'rejected lap toast');
  await w.js(`__t.uncruise()`);
  let s = await w.state();
  check('a 2 s lap is rejected with a toast, qualifying goes on', rejected && (await w.js(`__t.text('hud-toast')`)) === '這一圈沒有被採計：圈速快得不合理' && s.gp.phase === 'quali' && s.gp.lap === 0 && s.lap.n >= 2,
    { toast: await w.js(`__t.text('hud-toast')`), lap: s.lap, gp: s.gp });
  // the refused lap was driven (上一圈) but it is not our best: the timing box agrees with the standings (no time)
  await sleep(100);
  const tb = await w.js(`({ last: __t.text('hud-last'), best: __t.text('hud-best'), lapBest: F1.game.lap.best })`);
  check('the refused lap shows as 上一圈 but not as 最快圈 (the timing box agrees with the standings)', /^0:0\d\.\d{3}$/.test(tb.last) && tb.best === '--' && tb.lapBest === null, tb);

  // 2. a believable lap (the game clock and the lap clock are stepped 70 s): accepted, Q = 1 -> straight to the grid
  await w.js(`F1.game.gp.update(70); F1.game.lap.time += 70; __t.cruise(2400); true`);
  check('accepted qualifying lap -> grid at once', await w.until(`F1.game.gp.phase === 'grid'`, 8000));
  await sleep(200);
  s = await w.state();
  const slot = s.car;
  const row = await w.js(`F1.game.gp.view().rows[0]`);
  check('grid after the last qualifying lap: in grid box 1, locked, lap counter reset', inBox(await w.js(`__t.box(0)`)) && slot.d > 2.9 && slot.v === 0 && s.gp.locked && !s.lap.started, { car: slot, box: await w.js(`__t.box(0)`), gp: s.gp, lap: s.lap });
  check('qualifying time is the lap counter\'s lap', row && row.best > 70 && row.best < 80 && row.done === true && /1:1\d\.\d{3}/.test(await w.js(`__t.text('hud-gp')`)), { row, box: await w.js(`__t.text('hud-gp')`) });
  // the carrier is still on and W is held: a frozen car does not move one sample
  w.key('W', true);
  await sleep(1500);
  s = await w.state();
  check('grid: frozen (no physics step runs: the carrier cannot move the car)', s.car.x === slot.x && s.car.z === slot.z && s.car.i === slot.i && s.car.v === 0 && s.gp.locked, s.car);
  await w.js(`__t.uncruise()`);
  await w.shot('l1-grid');
  check('lights out -> racing', await w.until(`F1.game.gp.phase === 'race' && F1.game.car.state.speed > 3`, 16000), await w.js(`__t.gp()`));
  w.key('W', false);

  // 3. the race lap: first crossing of the line counts nothing, the next one finishes the race (R = 1)
  await w.js(`F1.game.gp.update(70); F1.game.lap.time += 70; __t.cruise(2400); true`);
  check('race lap accepted -> results', await w.until(`F1.game.gp.phase === 'results'`, 8000));
  await w.js(`__t.uncruise()`);
  await sleep(250);
  const res = await w.js(`(function () { var v = F1.game.gp.view(), p = F1.game.gp.snapshot.players[0]; return { row: v.rows[0], pos: v.pos, count: v.count, rTime: p.rTime, fin: p.fin, last: F1.game.lap.last,
    clock: (F1.game.gp.now() - F1.game.gp.snapshot.goAt) / 1000, toast: __t.text('hud-toast'), overlay: __t.shown('gp-results'), text: __t.text('gp-results-body') }; })()`);
  console.log('lap results:', J(res));
  check('results: finished P1, race time = the lap counter\'s time since lights out', res.fin && res.pos === 1 && res.row.done && res.row.laps === 1 && near(res.rTime, res.last, 0.0006) && res.last > 70, res);
  check('results: race clock and session clock agree', res.clock - res.last >= 0 && res.clock - res.last < 0.5, { clock: res.clock, last: res.last });
  check('results: overlay with the classification, toast', res.overlay && /1:1\d\.\d{3}/.test(res.text) && res.toast === '正賽結束：你是第 1 名（共 1 位車手）', { text: res.text, toast: res.toast });
  const hudLast = await w.js(`__t.text('hud-last')`);
  check('results: the timing box shows the lap exactly as the classification does', /^1:1\d\.\d{3}$/.test(hudLast) && res.text.indexOf(hudLast) >= 0 && (await w.js(`__t.text('hud-best')`)) === hudLast, { hudLast, table: res.text });
  await w.shot('l2-results');

  await w.click('gp-res-again');
  check('再來一場 (overlay button) -> a new qualifying on the start slot', await w.until(`F1.game.gp.phase === 'quali'`, 2000) && await w.js(`!__t.shown('gp-results') && F1.game.running`) &&
    (s = await w.state()).car.i === s.car.n - 10 && Math.abs(s.car.d) < 0.01 && !s.lap.started, s && s.car);
  await w.tap('Escape');
  await w.click('gp-end');
  check('結束大獎賽 (menu button) -> free, menu stays open with the setup back', await w.until(`F1.game.gp.phase === 'free'`, 2000) && await w.js(`!F1.game.running && __t.shown('gp-setup') && !document.getElementById('gp-start').disabled`));
  const mt = await w.js(`__t.toast()`);
  check('the "Grand Prix ended" toast is visible over the menu (bottom of the window)', mt.shown && mt.text === '大獎賽已結束，回到自由練習' && mt.menu && !mt.hud && mt.overMenu && !mt.inHud &&
    mt.top > mt.H / 2 && mt.bottom <= mt.H && mt.left >= 0 && mt.right <= mt.W, mt);
  await w.shot('l3-menu-toast');
  await w.tap('Escape');
  const ht = await w.js(`__t.toast()`);
  check('back in the car the same toast is at the top of the HUD', ht.shown && ht.text === mt.text && ht.hud && !ht.menu && ht.top >= 0 && ht.bottom < 70, ht);
  await w.noErrors();
  w.destroy();
}

/* ================= gamepad (stubbed Gamepad API) ================= */
async function partPad() {
  part = 'pad';
  const w = makeWin('pad');
  await w.open();
  check('before: keyboard wording', await w.js(`!__t.shown('pad-status') && !F1.gamepad.state.connected`));
  await w.js(`__t.fakePad()`);
  const press = async i => { await w.js(`__btn(${i}, 1)`); await sleep(160); await w.js(`__btn(${i}, 0)`); await sleep(160); };
  const axes = a => w.js(`(function (a) { for (var i = 0; i < 4; i++) if (a[i] != null) __pad.axes[i] = a[i]; return true; })(${J(a)})`);
  await sleep(350);
  check('pad found from the menu (timer poll): 已連接 tag with the pad id', await w.js(`F1.gamepad.state.connected && __t.shown('pad-status') && /Fake Controller/.test(document.getElementById('pad-status').title)`));
  await w.shot('c1-menu-pad');
  await press(9);
  check('Start in the menu without a track does nothing', await w.js(`!F1.game.running && __t.shown('menu') && document.getElementById('error').classList.contains('hidden')`));

  await w.pick(TRACK);
  await w.until(`F1.game.running`, 15000, 'track');
  await sleep(300);
  check('HUD hint switches to controller wording', await w.js(`__t.shown('hud-hint-pad') && !__t.shown('hud-hint-keys') && /RT/.test(__t.text('hud-hint'))`), await w.js(`__t.text('hud-hint')`));

  await w.js(`__btn(7, 1)`);
  await sleep(2000);
  let s = await w.state();
  check('RT accelerates', s.car.v > 12 && Math.abs(s.car.steer) < 1e-9, s.car.v);
  await w.js(`__btn(7, 0.5)`);
  const vA = (await w.state()).car.v; await sleep(500); const vB = (await w.state()).car.v;
  check('RT half: still accelerating, but gently', vB > vA && vB - vA < 4.5, { dv: vB - vA });
  await w.js(`__btn(7, 0); __btn(6, 1)`);
  const v0 = (await w.state()).car.v; await sleep(600); const v1 = (await w.state()).car.v;
  await w.js(`__btn(6, 0)`);
  check('LT brakes', v0 - v1 > 5, { v0, v1 });

  await w.js(`__btn(7, 0.4)`);
  await axes([-0.5]); await sleep(450);
  const half = await w.js(`({ steer: F1.game.car.state.steer, pad: F1.gamepad.state.steer })`);
  await axes([-1]); await sleep(450);
  const fullL = await w.js(`F1.game.car.state.steer`);
  await axes([1]); await sleep(500);
  const fullR = await w.js(`F1.game.car.state.steer`);
  await axes([0]); await sleep(450);
  const centre = await w.js(`F1.game.car.state.steer`);
  await w.js(`__btn(7, 0)`);
  check('left stick steers proportionally (half stick = part lock, full = full lock, centre = 0)', near(half.pad, 0.261, 0.01) && near(half.steer, half.pad, 0.01) && near(fullL, 1, 0.01) && near(fullR, -1, 0.01) && Math.abs(centre) < 0.01,
    { half, fullL, fullR, centre });

  const look = () => w.js(`({ y: F1.game.camera.rotation.y - Math.PI, x: F1.game.camera.rotation.x, max: F1.COCKPIT_LOOK })`);
  const look0 = await look();
  await axes([null, null, -1, 0]); await sleep(900);
  const lookL = await look();
  await w.shot('c2-look-left');
  await axes([null, null, 0, -1]); await sleep(900);
  const lookU = await look();
  await axes([null, null, 1, 0]); await sleep(900);
  const lookR = await look();
  check('right stick turns the head (left / up / right)', near(look0.y, 0, 1e-6) && near(lookL.y, lookL.max.maxYaw, 0.02) && near(lookR.y, -lookL.max.maxYaw, 0.02) &&
    near(Math.abs(lookU.x - look0.x), lookL.max.maxPitchUp, 0.03) && near(lookU.y, 0, 0.02), { look0: look0.y, left: lookL.y, up: lookU.x - look0.x, right: lookR.y, max: lookL.max });
  // stick let go and RS clicked together: the view must be straight at once (easing alone would take ~0.3 s)
  await w.js(`__pad.axes[2] = 0; __pad.axes[3] = 0; __btn(11, 1)`);
  await sleep(70);
  const lookC = await look();
  await w.js(`__btn(11, 0)`);
  check('RS click recentres the view at once', near(lookC.y, 0, 1e-6), lookC.y);

  // off the centreline, then Y (the reset button since the v6.1 layout of js/gamepad.js: A = battery, X = compound)
  await w.js(`__btn(7, 1)`); await axes([-0.6]); await sleep(900); await axes([0]); await w.js(`__btn(7, 0)`);
  s = await w.state();
  const off = s.car.d;
  await press(3);
  s = await w.state();
  check('Y resets the car onto the centreline', Math.abs(off) > 0.3 && Math.abs(s.car.d) < 0.01 && Math.abs(s.car.v) < 0.5, { before: off, after: s.car.d, v: s.car.v });
  const x0 = await w.js(`F1.game.raceLine.group.visible`);
  await press(8); const x1 = await w.js(`F1.game.raceLine.group.visible`);
  await press(8); const x2 = await w.js(`F1.game.raceLine.group.visible`);
  check('View (Back) toggles the racing line', x0 === true && x1 === false && x2 === true, [x0, x1, x2]);
  await press(9);
  check('Start opens the menu', await w.js(`!F1.game.running && __t.shown('menu')`));
  await sleep(700);                                          // longer than gamepad.js's 500 ms edge resync
  await press(9);
  check('Start again resumes (menu-time polling)', await w.js(`F1.game.running && !__t.shown('menu')`));

  // rumble: full throttle into the wall
  await w.js(`window.__maxHit = 0; window.__hitIv = setInterval(function () { var h = F1.game.car.state.hit; if (h > window.__maxHit) window.__maxHit = h; }, 4); __rumble.length = 0; __btn(7, 1); __pad.axes[0] = -1; true`);
  await w.until(`__rumble.length > 0`, 9000, 'rumble');
  await sleep(300);
  await w.js(`__btn(7, 0); __pad.axes[0] = 0; clearInterval(window.__hitIv); true`);
  const rum = await w.js(`({ n: __rumble.length, first: __rumble[0], strongest: __rumble.reduce(function (m, r) { return Math.max(m, r[3]); }, 0), maxHit: window.__maxHit })`);
  check('wall hit -> rumble scaled by the impact', rum.n > 0 && rum.maxHit > 0.03 && rum.first[0] === 'dual-rumble' && rum.strongest > 0.2 && rum.strongest <= 1 &&
    near(rum.strongest, Math.min(1, 0.2 + rum.maxHit), 0.05) && rum.first[1] >= 120 && rum.first[1] <= 400, rum);
  await press(3);

  // grid lock applies to the pad too
  await w.js(`__btn(6, 1)`); await w.until(`Math.abs(F1.game.car.state.speed) < 1`, 4000); await w.js(`__btn(6, 0)`);
  check('Grand Prix started + skipped to the grid', await w.js(`F1.game.gp.start({ q: 1, r: 1 }, F1.game.track.length) && F1.game.gp.action('skip')`) && await w.until(`F1.game.gp.phase === 'grid' && F1.game.gp.inputLocked`, 2000));
  await sleep(200);
  const g0 = (await w.state()).car;
  await w.js(`__btn(7, 1); __pad.axes[0] = -1; __pad.axes[2] = -1; true`);
  await press(3);
  await sleep(1200);
  s = await w.state();
  const lookG = await look();
  check('grid: RT + stick + Y do nothing while locked (no move, no steer, no reset)', s.gp.locked && s.car.v === 0 && s.car.x === g0.x && s.car.z === g0.z && inBox(await w.js(`__t.box(0)`)) && s.car.steer === 0, s.car);
  check('grid: the head still turns', near(lookG.y, lookG.max.maxYaw, 0.03), lookG.y);
  await w.shot('c3-grid-pad');
  await axes([0, null, 0, 0]);
  // (the session clock as the last frame that ran to its end left it: main.js updates the HUD last thing in a frame)
  await w.js(`(function () { var u = F1.ui.updateHUD; window.__hudClock = null; F1.ui.updateHUD = function () { window.__hudClock = F1.game.gp.now(); return u.apply(this, arguments); }; return true; })()`);
  await sleep(100);
  await press(9);
  const pc = await w.js(`({ now: F1.game.gp.now(), hud: window.__hudClock })`);
  check('grid: Start still opens the menu; the frame in which it does adds nothing to the session clock (as with Esc)', await w.js(`!F1.game.running && __t.shown('menu')`) && (await w.state()).gp.locked &&
    pc.hud !== null && pc.now === pc.hud, { clock: pc.now, lastFrame: pc.hud, diffMs: pc.now - pc.hud });
  await press(9);
  check('grid: Start resumes, still locked', await w.js(`F1.game.running`) && (await w.state()).gp.locked);
  check('lights out: RT held through the lock accelerates', await w.until(`F1.game.gp.phase === 'race' && F1.game.car.state.speed > 3`, 16000), (await w.state()).car);
  await w.js(`__btn(7, 0); F1.game.gp.action('end'); F1.game.gp.action('end'); true`);

  // the pad goes away
  await w.js(`window.__padOn = false; true`);
  await sleep(300);
  check('pad unplugged: keyboard wording back, toast', await w.js(`__t.shown('hud-hint-keys') && !__t.shown('hud-hint-pad') && !F1.gamepad.state.connected`) && (await w.js(`__t.text('hud-toast')`)) === '手把已中斷連線', await w.js(`__t.text('hud-toast')`));
  await w.tap('R');
  w.key('W', true); await sleep(1500); w.key('W', false);
  check('keyboard still drives', (await w.state()).car.v > 8);
  await w.js(`window.__padOn = true; true`);
  await sleep(300);
  check('pad plugged in again while driving: controller wording + toast', await w.js(`__t.shown('hud-hint-pad') && F1.gamepad.state.connected`) && (await w.js(`__t.text('hud-toast')`)) === '手把已連接', await w.js(`__t.text('hud-toast')`));
  await w.noErrors();
  w.destroy();
}

/* ================= without js/gamepad.js ================= */
async function partNoPad() {
  part = 'nopad';
  // the real page minus the gamepad script tag
  const w = makeWin('nopad');
  const err = await w.open(true);
  check('boots without F1.gamepad, no error overlay', !err && await w.js(`!F1.gamepad && !!F1.gp && !!F1.game`), err || undefined);
  await w.pick(TRACK);
  check('track loads', await w.until(`F1.game.running`, 15000));
  w.key('W', true); await sleep(2000); w.key('A', true); await sleep(400); w.key('A', false); w.key('W', false);
  let s = await w.state();
  check('keyboard drives and steers', s.car.v > 12 && Math.abs(s.car.d) > 0.1 && s.lap.started, { v: s.car.v, d: s.car.d });
  await w.tap('R');
  check('R resets', Math.abs((await w.state()).car.d) < 0.01);
  await w.tap('L');
  check('L toggles the line', await w.js(`F1.game.raceLine.group.visible === false`));
  await w.tap('Escape');
  check('Esc opens the menu', await w.js(`!F1.game.running && __t.shown('menu')`));
  await w.click('gp-start');
  check('Grand Prix starts from the menu', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  w.key('W', true);
  await w.js(`F1.game.gp.action('skip')`);
  await w.until(`F1.game.gp.phase === 'grid'`, 2000);
  await sleep(1500);
  s = await w.state();
  check('grid: frozen with W held, in grid box 1', s.gp.locked && s.car.v === 0 && inBox(await w.js(`__t.box(0)`)) && s.up === true, s.car);
  check('lights out: W accelerates', await w.until(`F1.game.gp.phase === 'race' && F1.game.car.state.speed > 3`, 16000));
  w.key('W', false);
  check('keyboard hint in the HUD', await w.js(`__t.shown('hud-hint-keys') && !__t.shown('hud-hint-pad')`));
  await w.noErrors();
  w.destroy();
}

/* ================= R reset at Suzuka's crossover ================= */
async function partSuzuka() {
  part = 'suzuka';
  const w = makeWin('suzuka');
  await w.open();
  const name = await w.pick('suzuka');
  check('Suzuka loads', !!name && await w.until(`F1.game.running`, 15000), name);
  const cr = await w.js(`F1.game.track.crossings`);
  check('the crossover is in the track data', Array.isArray(cr) && cr.length === 1, cr);
  const lo = Math.min(cr[0][0], cr[0][1]), hi = Math.max(cr[0][0], cr[0][1]);
  // the car on sample i of the track, d metres to the side, standing
  const put = (i, d) => w.js(`(function (i, d) { var s = F1.game.track.samples[i], c = F1.game.car.state;
    c.x = s.x + s.nx * d; c.z = s.z + s.nz * d; c.heading = Math.atan2(s.tx, s.tz); c.speed = 0; c.steer = 0; c.sampleIndex = i; return true; })(${i}, ${d})`);
  const at = lo - 2;
  await put(at, 0);
  await w.js(`F1.game.lap.reset(${at}); true`);
  await sleep(250);
  // v6.2: the crossover is a BRIDGE (js/track.js: the roads 6.2 m apart; js/car.js locates with the car's height): beyond the
  // road edge at the crossing the car stays on the road it is on - the index never jumps to the other road, so the lap counter
  // never has to wait (until v6.1 the roads met at one level there and car.js put the car on the other one: 'jumping')
  const seen = [];
  for (const d of [9, -9, 8, -8, 10, -10]) {
    await put(at, d);
    await sleep(250);
    const r = await w.js(`({ i: F1.game.car.state.sampleIndex, jumping: F1.game.lap.jumping, bridges: (F1.game.track.bridges || []).length })`);
    seen.push(Object.assign({ d }, r));
  }
  check('off the road at the crossing (8..10 m either side): the bridge keeps the car on its own road (index near ' + at + ', never near ' + hi + '), the lap counter never waits',
    seen.every(r => r.bridges === 1 && Math.abs(r.i - at) < 15 && !r.jumping), seen);
  await w.tap('R');
  await sleep(150);
  const s = await w.state();
  check('R puts the car back on the road it was on (not on the other one, no void lap)', Math.abs(s.car.i - at) < 15 && Math.abs(s.car.d) < 0.01 && s.lap.void === false && await w.js(`F1.game.lap.jumping === false`),
    { car: s.car.i, was: at, otherRoad: hi, lap: s.lap });
  await w.noErrors();
  w.destroy();
}

/* ================= room: host, guest, late joiner ================= */
async function partRoom() {
  part = 'room';
  const A = makeWin('A'), B = makeWin('B');
  let C = null;
  await A.open(); await B.open();
  const ghostOf = async (w, name) => w.js(`(function () { var g = __t.ghosts(), p = F1.net.players.filter(function (p) { return p.name === ${J(name)}; })[0]; return p ? g[p.id] : null; })()`);
  const remote = (w, name) => w.js(`(function () { var p = F1.net.players.filter(function (p) { return p.name === ${J(name)}; })[0]; return p ? { active: p.active, x: p.state.x, z: p.state.z, v: p.state.speed } : null; })()`);

  await A.field('mp-name', 'Alice'); await A.field('mp-port', String(PORT));
  await A.js(`document.getElementById('mp-create').click()`);
  check('A hosts', await A.until(`F1.net.connected && F1.net.isHost`, 5000), await A.js(`__t.text('mp-status')`));
  await B.field('mp-name', 'Bob'); await B.field('mp-addr', '127.0.0.1:' + PORT);
  await B.js(`document.querySelectorAll('.mp-swatch')[2].click(); document.getElementById('mp-join').click()`);
  check('B joins', await B.until(`F1.net.connected && !F1.net.isHost`, 5000), await B.js(`__t.text('mp-status')`));
  await sleep(300);
  check('host without a room track: start disabled with a hint; guest: no setup, told the host starts it', await A.js(`document.getElementById('gp-start').disabled && __t.text('gp-hint') === '先幫房間選一條賽道'`) &&
    await B.js(`!__t.shown('gp-setup') && /房主/.test(__t.text('gp-hint'))`), [await A.js(`__t.text('gp-hint')`), await B.js(`__t.text('gp-hint')`)]);
  const picked = await A.pick(ROOM_TRACK);
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`;
  check('both load the room track (' + picked + ')', await A.until(onTrack, 15000) && await B.until(onTrack, 15000));
  await sleep(1200);
  let a = await A.state(), b = await B.state();
  const n = a.car.n;
  const boxOf = (w, slot) => w.js(`__t.box(${slot})`);
  check('free practice in the room: own slots (grid boxes 1 and 2), solid cars, roster box', inBox(await boxOf(A, 0)) && inBox(await boxOf(B, 1)) && a.car.d > 0 && b.car.d < 0 && (await ghostOf(A, 'Bob')) === false && (await ghostOf(B, 'Alice')) === false &&
    await B.js(`__t.shown('hud-players') && !__t.shown('hud-gp')`), { a: await boxOf(A, 0), b: await boxOf(B, 1) });

  // ---- the host starts the Grand Prix from the menu panel ----
  await A.tap('Escape');
  await A.field('gp-q', '1'); await A.field('gp-r', '1');
  check('host menu: start enabled, room hint', await A.js(`!document.getElementById('gp-start').disabled && /所有人/.test(__t.text('gp-hint'))`), await A.js(`__t.text('gp-hint')`));
  await A.shot('d1-host-menu');
  await A.click('gp-start');
  check('both in qualifying', await A.until(`F1.game.gp.phase === 'quali'`, 3000) && await B.until(`F1.game.gp.phase === 'quali'`, 3000));
  await sleep(700);
  a = await A.state(); b = await B.state();
  check('quali: host pulled out of the menu, both driving, both taking part (online)', a.running && b.running && await A.js(`!__t.shown('menu')`) && a.gp.taking && b.gp.taking && a.gp.online && b.gp.online && a.gp.canControl && !b.gp.canControl, { a: a.gp, b: b.gp });
  check('quali: cars on their room slots, lap counters reset', inBox(await boxOf(A, 0)) && a.car.d > 0 && inBox(await boxOf(B, 1)) && b.car.d < 0 && !a.lap.started && !b.lap.started, { a: a.car, b: b.car });
  check('quali: they see each other as ghosts', (await ghostOf(A, 'Bob')) === true && (await ghostOf(B, 'Alice')) === true, [await A.js(`__t.ghosts()`), await B.js(`__t.ghosts()`)]);
  check('quali: session box with both drivers replaces the roster box; toast', await B.js(`__t.shown('hud-gp') && !__t.shown('hud-players') && /排位賽/.test(__t.text('hud-gp')) && /Alice/.test(__t.text('hud-gp')) && /Bob/.test(__t.text('hud-gp'))`) &&
    (await B.js(`__t.text('hud-toast')`)) === '大獎賽開始：排位 1 圈，正賽 1 圈', { box: await B.js(`__t.text('hud-gp')`), toast: await B.js(`__t.text('hud-toast')`) });
  await B.shot('d2-guest-quali');

  // ---- ghosts do not collide: B straight through A from behind ----
  const a1 = a.car;
  await B.js(`(function () { var s = F1.game.car.state, a = ${J(a1)}; s.x = a.x - Math.sin(a.h) * 14; s.z = a.z - Math.cos(a.h) * 14; s.heading = a.h; s.speed = 0; s.steer = 0; return 1; })()`);
  await sleep(500);
  await A.js(`__t.hits('Bob')`); await B.js(`__t.hits('Alice')`);
  B.key('W', true);
  let minAlong = Infinity, minGap = Infinity, shotDone = false;
  for (let i = 0; i < 42; i++) {
    await sleep(50);
    const [ca, cb] = await Promise.all([A.js(`__t.car()`), B.js(`__t.car()`)]);
    const along = (ca.x - cb.x) * Math.sin(ca.h) + (ca.z - cb.z) * Math.cos(ca.h);
    minAlong = Math.min(minAlong, along); minGap = Math.min(minGap, Math.hypot(ca.x - cb.x, ca.z - cb.z));
    if (!shotDone && along < 3) { shotDone = true; await B.shot('d3-guest-inside-ghost'); }
  }
  B.key('W', false);
  const a2 = (await A.state()).car;
  const hitA = await A.js(`__t.hitsStop()`), hitB = await B.js(`__t.hitsStop()`);
  // (.all on B may be a wall further down the road; what counts is that nothing happened while the cars overlapped)
  check('quali: B drives straight through A (boxes overlap, nobody pushed, no impact on either car)', minAlong < -2 && minGap < 3 && hitB.minDist < 3 && Math.hypot(a2.x - a1.x, a2.z - a1.z) < 0.01 &&
    hitA.all === 0 && hitB.near === 0, { minAlong, minGap, aMoved: Math.hypot(a2.x - a1.x, a2.z - a1.z), hitA, hitB });

  // ---- B sets a time (carried round the centreline at 88 m/s, a legal lap), A does not ----
  const len = await B.js(`F1.game.track.length`);
  console.log('room track length', len, 'm: minimum lap', (len / (330 / 3.6)).toFixed(1), 's, lap at 88 m/s', (len / 88).toFixed(1), 's');
  await B.js(`__t.cruise(88)`);
  const lapOk = await A.until(`(function () { var r = F1.game.gp.view().rows; return r.some(function (x) { return x.name === 'Bob' && x.done; }); })()`, (len / 88 + 25) * 1000, 'B completes a qualifying lap');
  await B.js(`__t.uncruise()`);
  await sleep(400);
  const qa = await A.js(`F1.game.gp.view()`), qb = await B.js(`F1.game.gp.view()`), bl = (await B.state()).lap;
  check('quali: B\'s lap is accepted by the server and shown to both', lapOk && qa.rows[0].name === 'Bob' && near(qa.rows[0].best, bl.last, 0.0006) && qa.rows[0].done && qa.rows[1].name === 'Alice' && qa.rows[1].best === null &&
    qb.rows[0].isSelf && qb.done && qb.pos === 1 && !/沒有被採計/.test(await B.js(`__t.text('hud-toast')`)), { rowsA: qa.rows.map(r => [r.name, r.best, r.done]), last: bl.last, phase: qa.phase });
  check('quali: still qualifying (A has not done a lap)', qa.phase === 'quali' && await B.js(`/排位完成/.test(__t.text('hud-gp'))`), await B.js(`__t.text('hud-gp')`));
  await A.shot('d4-host-quali-times');

  // ---- host skips: grid in qualifying order, both locked, released together ----
  const goHook = `window.__go = null; F1.gp.on('go', function () { window.__go = { server: F1.net.serverNow(), wall: Date.now(), goAt: F1.gp.snapshot.goAt, phase: F1.gp.phase }; }); __t.rec()`;
  await A.js(goHook); await B.js(goHook);
  A.key('W', true); B.key('W', true);
  await A.tap('Escape');
  check('host menu in qualifying: 跳過排位 shown', await A.js(`__t.shown('gp-skip') && __t.shown('gp-end')`));
  await A.click('gp-skip');
  check('both on the grid', await A.until(`F1.game.gp.phase === 'grid'`, 3000) && await B.until(`F1.game.gp.phase === 'grid'`, 3000));
  await sleep(500);
  A.key('W', true);                                         // (the menu cleared A's keys when it closed: held again, before the lights)
  a = await A.state(); b = await B.state();
  const gridA = a.car, gridB = b.car;
  check('grid: qualifying order, not room order: B on pole (box 1), A in box 2', b.gp.gridSlot === 0 && a.gp.gridSlot === 1 && inBox(await boxOf(B, 0)) && b.car.d > 0 && inBox(await boxOf(A, 1)) && a.car.d < 0 &&
    Math.hypot(a.car.x - b.car.x, a.car.z - b.car.z) > 6, { a: await boxOf(A, 1), b: await boxOf(B, 0), dist: Math.hypot(a.car.x - b.car.x, a.car.z - b.car.z) });
  check('grid: both locked and standing, host out of the menu, lap counters reset', a.gp.locked && b.gp.locked && a.car.v === 0 && b.car.v === 0 && a.running && b.running && !a.lap.started && !b.lap.started, { a: a.gp, b: b.gp });
  check('grid: still ghosts while the cars are being placed', (await ghostOf(A, 'Bob')) === true && (await ghostOf(B, 'Alice')) === true);
  const ra = await remote(A, 'Bob'), rb = await remote(B, 'Alice');
  check('grid: each sees the other on its slot', ra && rb && Math.hypot(ra.x - b.car.x, ra.z - b.car.z) < 0.3 && Math.hypot(rb.x - a.car.x, rb.z - a.car.z) < 0.3, { ra, rb });
  check('grid: toasts with the grid positions', (await A.js(`__t.text('hud-toast')`)) === '起跑位置 P2 / 2，燈號全滅就起跑' && (await B.js(`__t.text('hud-toast')`)) === '起跑位置 P1 / 2，燈號全滅就起跑', [await A.js(`__t.text('hud-toast')`), await B.js(`__t.text('hud-toast')`)]);
  let solidSeen = false, lampsTogether = true, shots = 0;
  const end = Date.now() + 16000;
  while (Date.now() < end) {
    const [la, lb] = await Promise.all([A.js(`({ l: __t.lights(), g: __t.gp(), v: F1.game.car.state.speed })`), B.js(`({ l: __t.lights(), g: __t.gp(), v: F1.game.car.state.speed })`)]);
    if (Math.abs(la.g.lights - lb.g.lights) > 1) lampsTogether = false;
    if (!solidSeen && la.g.lights >= 1 && la.g.phase === 'grid') {
      solidSeen = true;
      check('grid: solid for each other once the lights come on', (await ghostOf(A, 'Bob')) === false && (await ghostOf(B, 'Alice')) === false);
    }
    if (shots === 0 && la.l.on === 4) { shots = 1; await A.shot('d5-host-grid-lights'); await B.shot('d5-guest-grid-lights'); }
    if (la.g.phase === 'race' && lb.g.phase === 'race' && la.v > 3 && lb.v > 3) break;
    await sleep(60);
  }
  a = await A.state(); b = await B.state();
  const sa = analyseStart(await A.js(`__t.recStop()`)), sb = analyseStart(await B.js(`__t.recStop()`));
  const goA = await A.js(`window.__go`), goB = await B.js(`window.__go`);
  console.log('room start A:', J(sa), J(goA), '\nroom start B:', J(sb), J(goB));
  check('grid: neither car moved while locked (W held in both)', sa.movedWhileLocked === 0 && sb.movedWhileLocked === 0 && sa.lockedFrames > 100 && sb.lockedFrames > 100, { a: [sa.lockedFrames, sa.movedWhileLocked], b: [sb.lockedFrames, sb.movedWhileLocked] });
  check('grid: five lights in both windows, in step', /12345/.test(sa.lamps) && /12345/.test(sb.lamps) && lampsTogether, { a: sa.lamps, b: sb.lamps, gapsA: sa.gaps, gapsB: sb.gaps });
  check('released at the same session time (go within 150 ms of goAt in both, and of each other)', goA && goB && goA.goAt === goB.goAt && goA.server - goA.goAt >= 0 && goA.server - goA.goAt < 150 &&
    goB.server - goB.goAt >= 0 && goB.server - goB.goAt < 150 && Math.abs(goA.wall - goB.wall) < 150, { a: goA && goA.server - goA.goAt, b: goB && goB.server - goB.goAt, wallDiff: goA && goB && goA.wall - goB.wall });
  console.log('event order at lights out: A go while "' + goA.phase + '", B go while "' + goB.phase + '" (grid = go first, race = the race snapshot first)');
  check('lights out: both accelerate with W held through the lock', a.car.v > 3 && b.car.v > 3 && sa.unlockToMoveMs < 150 && sb.unlockToMoveMs < 150, { va: a.car.v, vb: b.car.v, a: sa.unlockToMoveMs, b: sb.unlockToMoveMs });
  // (sinceGo is read when a frame's callback runs, the lap clock is on the frames' timestamps: it lags by the physics
  //  time not simulated yet (< 8.3 ms) plus how late that callback ran; it must never be ahead (4 ms of slack: a
  //  faster ping may have refined the estimate of the server clock since lights out))
  check('race: lap counters armed, race clocks = time since lights out (never ahead)', a.lap.started && b.lap.started && a.lap.n === 1 && b.lap.n === 1 && a.gp.phase === 'race' && b.gp.phase === 'race' &&
    a.gp.sinceGo - a.lap.time > -0.004 && a.gp.sinceGo - a.lap.time < 0.03 && b.gp.sinceGo - b.lap.time > -0.004 && b.gp.sinceGo - b.lap.time < 0.03, { a: [a.lap.time, a.gp.sinceGo], b: [b.lap.time, b.gp.sinceGo] });
  A.key('W', false); B.key('W', false);
  await sleep(1500);
  await B.shot('d6-guest-race');
  check('race: session box says 正賽 with live order', await A.js(`/正賽/.test(__t.text('hud-gp')) && /P\\d\\s*\\/ 2/.test(__t.text('hud-gp'))`), await A.js(`__t.text('hud-gp')`));

  // ---- a third player joins during the race: spectator, not moved by the session ----
  A.key('S', true); B.key('S', true);
  await A.until(`F1.game.car.state.speed < 1`, 6000); await B.until(`F1.game.car.state.speed < 1`, 6000);
  A.key('S', false); B.key('S', false);
  C = makeWin('C');
  await C.open();
  await C.field('mp-name', 'Carol'); await C.field('mp-addr', '127.0.0.1:' + PORT);
  await C.js(`document.querySelectorAll('.mp-swatch')[3].click(); document.getElementById('mp-join').click()`);
  check('C joins during the race and loads the track', await C.until(`F1.net.connected && ${onTrack}`, 15000) && await C.until(`F1.game.gp.phase === 'race'`, 3000));
  await sleep(1200);
  let c = await C.state();
  const c0 = c.car;
  check('C is a spectator: not classified, not locked, on its own room slot (slot 2 = grid box 3), free-practice lap counter', !c.gp.taking && !c.gp.locked && c.gp.gridSlot === -1 && c.gp.lapTotal === 0 &&
    inBox(await boxOf(C, 2)) && c.car.d > 0 && c.car.v === 0 && !c.lap.started, { gp: c.gp, car: c.car, box: await boxOf(C, 2) });
  check('C: session box says 觀戰中, toast, no lights', await C.js(`__t.shown('hud-gp') && /觀戰中/.test(__t.text('hud-gp')) && !__t.shown('hud-lights')`) &&
    (await C.js(`__t.text('hud-toast')`)) === '大獎賽進行中，你正在觀戰，下一場開始時才會加入', { box: await C.js(`__t.text('hud-gp')`), toast: await C.js(`__t.text('hud-toast')`) });
  check('C sees the racers as ghosts; the racers see C as a ghost and each other solid', (await ghostOf(C, 'Alice')) === true && (await ghostOf(C, 'Bob')) === true && (await ghostOf(A, 'Carol')) === true &&
    (await ghostOf(B, 'Carol')) === true && (await ghostOf(A, 'Bob')) === false && (await ghostOf(B, 'Alice')) === false, [await A.js(`__t.ghosts()`), await B.js(`__t.ghosts()`), await C.js(`__t.ghosts()`)]);
  check('racers\' HUD lists the spectator; C is not in the classification', await A.js(`/觀戰：Carol/.test(__t.text('hud-gp')) && F1.game.gp.view().count === 2`), await A.js(`__t.text('hud-gp')`));
  await sleep(1000);
  c = await C.state();
  check('C was not moved by the session', c.car.x === c0.x && c.car.z === c0.z, c.car);
  C.key('W', true); await sleep(1500); C.key('W', false);
  check('C can drive around', (await C.state()).car.v > 8);
  await C.shot('d7-spectator');

  // ---- the host ends the race: results for everybody ----
  check('host ends the race -> results for all three', await A.js(`F1.game.gp.action('end')`) === true && await A.until(`F1.game.gp.phase === 'results'`, 3000) &&
    await B.until(`F1.game.gp.phase === 'results'`, 3000) && await C.until(`F1.game.gp.phase === 'results'`, 3000));
  await sleep(400);
  check('results overlay: host has 再來一場 / 結束, guest only 關閉', await A.js(`__t.shown('gp-results') && __t.shown('gp-res-again') && __t.shown('gp-res-end')`) &&
    await B.js(`__t.shown('gp-results') && !__t.shown('gp-res-again') && !__t.shown('gp-res-end') && __t.shown('gp-close') && /房主/.test(__t.text('gp-results-note'))`), await B.js(`__t.text('gp-results')`));
  await A.shot('d8-host-results'); await B.shot('d8-guest-results');
  await A.click('gp-res-end');
  check('結束 -> free practice for all three, roster box back', await A.until(`F1.game.gp.phase === 'free'`, 3000) && await B.until(`F1.game.gp.phase === 'free'`, 3000) && await C.until(`F1.game.gp.phase === 'free'`, 3000) &&
    await B.js(`!__t.shown('hud-gp') && !__t.shown('gp-results') && __t.shown('hud-players')`));
  await sleep(500);
  check('free: cars that are apart are solid again', (await ghostOf(A, 'Bob')) === false && (await ghostOf(B, 'Alice')) === false, [await A.js(`__t.ghosts()`), await B.js(`__t.ghosts()`)]);

  // ---- a car that stops being a ghost while it overlaps ours: nothing jumps ----
  check('second session: all three in qualifying (C takes part now)', await A.js(`F1.game.gp.start({ q: 1, r: 1 }, F1.game.track.length)`) === true && await C.until(`F1.game.gp.phase === 'quali' && F1.game.gp.taking`, 3000) && await B.until(`F1.game.gp.phase === 'quali'`, 3000));
  await sleep(600);
  const a3 = (await A.state()).car;
  await B.js(`(function () { var s = F1.game.car.state, a = ${J(a3)}; s.x = a.x - Math.sin(a.h) * 1.5; s.z = a.z - Math.cos(a.h) * 1.5; s.heading = a.h; s.speed = 0; return 1; })()`);
  await sleep(700);
  const b3 = (await B.state()).car;
  await A.js(`__t.hits('Bob')`); await B.js(`__t.hits('Alice')`);
  await A.js(`F1.game.gp.action('end')`);
  await B.until(`F1.game.gp.phase === 'free'`, 3000);
  await sleep(1000);
  const a4 = (await A.state()).car, b4 = (await B.state()).car;
  check('session ended with B inside A: nobody is thrown out, the overlapping car stays a ghost', Math.hypot(a4.x - a3.x, a4.z - a3.z) < 0.01 && Math.hypot(b4.x - b3.x, b4.z - b3.z) < 0.01 &&
    (await ghostOf(A, 'Bob')) === true && (await ghostOf(B, 'Alice')) === true && (await ghostOf(A, 'Carol')) === false, { aMoved: Math.hypot(a4.x - a3.x, a4.z - a3.z), bMoved: Math.hypot(b4.x - b3.x, b4.z - b3.z) });
  B.key('W', true); await sleep(2000); B.key('W', false);
  await sleep(500);
  const a5 = (await A.state()).car, b5 = (await B.state()).car;
  const hitA2 = await A.js(`__t.hitsStop()`), hitB2 = await B.js(`__t.hitsStop()`);
  check('B drives out of A without an impact and is solid again once clear', Math.hypot(a5.x - a3.x, a5.z - a3.z) < 0.01 && hitA2.all === 0 && hitB2.near === 0 && hitB2.minDist < 2 &&
    Math.hypot(a5.x - b5.x, a5.z - b5.z) > 6 && (await ghostOf(A, 'Bob')) === false && (await ghostOf(B, 'Alice')) === false, { dist: Math.hypot(a5.x - b5.x, a5.z - b5.z), hitA2, hitB2 });
  // and solid means solid: B, put 12 m in front of A, reverses into it
  await B.js(`(function () { var s = F1.game.car.state, a = ${J(a5)}; s.x = a.x + Math.sin(a.h) * 12; s.z = a.z + Math.cos(a.h) * 12; s.heading = a.h; s.speed = 0; s.steer = 0; return 1; })()`);
  await B.js(`__t.fakePad()`);                              // (a controller lying untouched next to the keyboard: for the rumble)
  await sleep(600);
  await A.js(`__t.hits('Bob')`); await B.js(`__t.hits('Alice')`);
  B.key('S', true);
  await B.until(`__hits.near > 0`, 9000, 'B reverses into A');
  await sleep(500);
  B.key('S', false);
  const a6 = (await A.state()).car, hitA3 = await A.js(`__t.hitsStop()`), hitB3 = await B.js(`__t.hitsStop()`);
  check('solid again: B reversing into A is stopped by it and A feels it', hitB3.near > 0.02 && hitB3.minDist > 4 && (hitA3.all > 0 || Math.hypot(a6.x - a5.x, a6.z - a5.z) > 0.05),
    { hitA3, hitB3, aMoved: Math.hypot(a6.x - a5.x, a6.z - a5.z) });
  const rumB = await B.js(`({ n: __rumble.length, strongest: __rumble.reduce(function (m, r) { return Math.max(m, r[3]); }, 0), connected: F1.gamepad.state.connected })`);
  check('car-to-car impact rumbles the controller (keyboard driving with a pad connected)', rumB.connected && rumB.n > 0 && near(rumB.strongest, Math.min(1, 0.2 + hitB3.all), 0.06), { rumB, hit: hitB3.all });
  await B.js(`window.__padOn = false; true`);

  // ---- a session in which B is in the menu when it starts and when the grid forms, and C sits in the menu through lights out ----
  await B.tap('Escape');
  check('B opens the menu', await B.js(`!F1.game.running && __t.shown('menu')`));
  await A.js(`F1.game.gp.start({ q: 2, r: 3 }, F1.game.track.length)`);
  check('third session: a guest in the menu is pulled into qualifying', await B.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000) && await B.js(`!__t.shown('menu')`) &&
    await C.until(`F1.game.gp.phase === 'quali'`, 3000));
  await B.tap('Escape');
  await A.js(`F1.game.gp.action('skip')`);
  check('a guest in the menu is pulled onto the grid, locked', await B.until(`F1.game.gp.phase === 'grid' && F1.game.running && F1.game.gp.inputLocked`, 3000) && await B.js(`!__t.shown('menu')`), await B.js(`__t.gp()`));
  await C.until(`F1.game.gp.phase === 'grid'`, 3000);
  await sleep(400);
  const g3 = [await A.state(), await B.state(), await C.state()];
  check('grid of three: nobody has a time, so join order; three different boxes', g3[0].gp.gridSlot === 0 && g3[1].gp.gridSlot === 1 && g3[2].gp.gridSlot === 2 &&
    inBox(await boxOf(A, 0)) && inBox(await boxOf(B, 1)) && inBox(await boxOf(C, 2)) && g3.every(s => s.gp.locked && s.car.v === 0), g3.map(s => [s.gp.gridSlot, s.car.i, s.car.d, s.gp.locked]));
  await C.tap('Escape');
  check('Esc still opens the menu on the grid', await C.js(`!F1.game.running && __t.shown('menu')`));
  // B's estimate of the server clock lags 300 ms: the race snapshot reaches it before its own clock passes goAt
  await B.js(`(function () { var o = F1.net.serverNow; F1.net.serverNow = function () { return o() - 300; }; window.__unlag = function () { F1.net.serverNow = o; }; window.__go = null; return true; })()`);
  B.key('W', true);
  check('the race starts', await A.until(`F1.game.gp.phase === 'race'`, 16000) && await B.until(`!!window.__go`, 3000));
  await sleep(600);
  b = await B.state();
  const goB3 = await B.js(`window.__go`);
  check('race phase before "go" (lagging clock): unlocked at once, lap counter armed by the late "go", W held through the lock drives', goB3.phase === 'race' && !b.gp.locked && b.lap.started && b.lap.n === 1 &&
    b.lap.behind && b.car.v > 2 && b.lights.on === 0, { go: goB3.phase, gp: b.gp, lap: b.lap, v: b.car.v, lights: b.lights });
  B.key('W', false);
  await B.js(`__unlag()`);
  await sleep(900);
  c = await C.state();
  check('C in the menu at lights out: hears the race phase, its car is still on its slot', c.gp.phase === 'race' && !c.running && c.car.x === g3[2].car.x && c.car.z === g3[2].car.z && !c.lap.started, { gp: c.gp, lap: c.lap });
  await C.tap('Escape');
  await sleep(300);
  c = await C.state();
  check('C resumes after lights out: not locked, the race clock has been running since goAt', c.running && !c.gp.locked && c.lap.started && c.lap.n === 1 && c.lap.behind && c.lap.time > 1.5 &&
    near(c.lap.time, c.gp.sinceGo, 0.1), { lap: c.lap, sinceGo: c.gp.sinceGo });

  // ---- a track change by the host ends the session for everybody ----
  await A.tap('Escape');
  const other = await A.js(`(function () { var cur = F1.game.trackData.id, i = F1_TRACKS.findIndex(function (t) { return t.id !== cur; }); document.querySelectorAll('.card')[i].click(); return F1_TRACKS[i].id; })()`);
  const moved = `F1.game.gp.phase === 'free' && F1.game.trackData.id === ${J(other)} && F1.game.running`;
  check('host picks another track: session over, everybody on the new track', await A.until(moved, 15000) && await B.until(moved, 15000) && await C.until(moved, 15000), other);
  await sleep(800);
  c = await C.state();
  check('new track: own room slots, fresh lap counters, no session box', inBox(await boxOf(C, 2)) && inBox(await boxOf(A, 0)) && !c.lap.started && await C.js(`!__t.shown('hud-gp') && __t.shown('hud-players')`), await boxOf(C, 2));

  // ---- the host leaves in the middle of a session ----
  await A.js(`F1.game.gp.start({ q: 1, r: 1 }, F1.game.track.length)`);
  await B.until(`F1.game.gp.phase === 'quali'`, 3000);
  await A.tap('Escape');
  await A.js(`document.getElementById('mp-leave').click()`);
  check('host leaves: guests are offline, session gone, still driving', await B.until(`!F1.net.connected`, 5000) && await B.until(`F1.game.gp.phase === 'free' && !F1.game.gp.online`, 2000) &&
    await B.js(`F1.game.running && !__t.shown('hud-gp') && /連線中斷/.test(__t.text('hud-toast'))`), await B.js(`__t.text('hud-toast')`));
  check('guest alone afterwards: can start a single-player Grand Prix', await B.js(`F1.game.gp.canControl`) && await (async () => { await B.tap('Escape'); return B.js(`!document.getElementById('gp-start').disabled && __t.shown('gp-setup')`); })());
  await A.noErrors(); await B.noErrors(); await C.noErrors();
  A.destroy(); B.destroy(); C.destroy();
}

/* ================= spectator on the grid: start lights; toasts over the menu ================= */
async function partSpec() {
  part = 'spec';
  const H = makeWin('H'), S = makeWin('S');
  await H.open(); await S.open();
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`;
  await H.field('mp-name', 'Hana'); await H.field('mp-port', String(PORT));
  await H.js(`document.getElementById('mp-create').click()`);
  check('H hosts', await H.until(`F1.net.connected && F1.net.isHost`, 5000), await H.js(`__t.text('mp-status')`));
  const picked = await H.pick(ROOM_TRACK);
  check('H loads the room track (' + picked + ')', await H.until(onTrack, 15000));
  await sleep(500);
  // the guest's page is ready to join: name and address typed in; count the 'go' events it gets
  await S.field('mp-name', 'Sam'); await S.field('mp-addr', '127.0.0.1:' + PORT);
  await S.js(`document.querySelectorAll('.mp-swatch')[4].click(); window.__go = 0; F1.gp.on('go', function () { window.__go++; }); true`);

  // ---- H alone goes to the grid; S joins while the grid is being formed (4 s before the first light) ----
  check('H starts a Grand Prix and skips to the grid', await H.js(`F1.game.gp.start({ q: 1, r: 1 }, F1.game.track.length) && F1.game.gp.action('skip')`) === true &&
    await H.until(`F1.game.gp.phase === 'grid' && F1.game.gp.inputLocked`, 3000), await H.js(`__t.gp()`));
  await S.js(`document.getElementById('mp-join').click()`);
  check('S joins during the grid phase and loads the track', await S.until(`F1.net.connected && ${onTrack}`, 8000) && await S.until(`F1.game.gp.phase === 'grid'`, 2000), await S.js(`__t.text('mp-status')`));
  await S.js(`__t.rec()`); await H.js(`__t.rec()`);
  await sleep(250);
  let s = await S.state(), h = await H.state();
  const sBox = await S.js(`__t.box(1)`);
  check('S is a spectator: not classified, not locked, on its room slot (slot 1 = grid box 2); H is locked in box 1', !s.gp.taking && !s.gp.locked && s.gp.gridSlot === -1 && inBox(sBox) &&
    h.gp.taking && h.gp.locked && inBox(await H.js(`__t.box(0)`)), { s: s.gp, box: sBox, h: h.gp });
  check('S: told that it is watching; session box says 觀戰中', (await S.js(`__t.text('hud-toast')`)) === '大獎賽進行中，你正在觀戰，下一場開始時才會加入' && await S.js(`/觀戰中/.test(__t.text('hud-gp'))`), await S.js(`__t.text('hud-toast')`));

  const texts = { s: {}, h: {} };
  let together = true, domOk = true, shot3 = false, shotGo = false, drove = null, polls = 0;
  const end = Date.now() + 16000;
  while (Date.now() < end) {
    const [ls, lh] = await Promise.all([S.js(`({ l: __t.lights(), g: __t.gp(), v: F1.game.car.state.speed })`), H.js(`({ l: __t.lights(), g: __t.gp(), v: F1.game.car.state.speed })`)]);
    polls++;
    if (ls.l.shown) texts.s[ls.l.text] = (texts.s[ls.l.text] || 0) + 1;
    if (lh.l.shown) texts.h[lh.l.text] = (texts.h[lh.l.text] || 0) + 1;
    if (Math.abs(ls.g.lights - lh.g.lights) > 1) together = false;
    if (ls.g.phase === 'grid' && !ls.l.shown) domOk = false;                       // the box is on screen for the whole grid phase
    if (!shot3 && ls.l.on === 3) { shot3 = true; await S.shot('e1-spectator-lights3'); await H.shot('e1-host-lights3'); S.key('W', true); }
    if (shot3 && !drove && lh.g.locked && ls.v > 3) drove = { spectator: ls.v, host: lh.v, hostLocked: lh.g.locked };
    if (!shotGo && ls.l.go) { shotGo = true; await S.shot('e2-spectator-go'); }
    if (lh.g.phase === 'race' && ls.g.phase === 'race' && !lh.g.goFlash && !ls.g.goFlash) break;
    await sleep(60);
  }
  S.key('W', false);
  const rs = analyseStart(await S.js(`__t.recStop()`)), rh = analyseStart(await H.js(`__t.recStop()`));
  console.log('spec start S:', J(rs), J(texts.s), '\nspec start H:', J(rh), J(texts.h));
  // (lamps: the counts shown during the grid phase as they changed; S may arrive after the first ones, and a 0 follows
  //  when the lights go out before the race snapshot arrives)
  check('the spectator sees the lights come on one by one, in step with the host', '0123450'.indexOf(rs.lamps) >= 0 && /345/.test(rs.lamps) && /12345/.test(rh.lamps) && together && domOk && rs.domMismatch <= 6,
    { spectator: rs.lamps, host: rh.lamps, gaps: rs.gaps, together, domOk, domMismatch: rs.domMismatch, polls });
  check('captions: the spectator is told the race is about to start / has started, the driver 準備起跑 / GO', Object.keys(texts.s).sort().join('|') === '正賽即將起跑|正賽開始' &&
    Object.keys(texts.h).sort().join('|') === 'GO|準備起跑', texts);
  check('the spectator is never locked and can drive while the host waits for the lights', rs.lockedFrames === 0 && drove && drove.spectator > 3 && drove.host === 0 && rh.movedWhileLocked === 0, { drove, sLocked: rs.lockedFrames, hMoved: rh.movedWhileLocked });
  check('lights out: the flash is shown to the spectator too; no "go" event for it', shotGo && rs.goFrames > 5 && rh.goFrames > 5 && (await S.js(`window.__go`)) === 0, { s: rs.goFrames, h: rh.goFrames, go: await S.js(`window.__go`) });
  await sleep(400);
  check('after the flash the lights are gone in both windows', await S.js(`!__t.shown('hud-lights')`) && await H.js(`!__t.shown('hud-lights')`));
  s = await S.state();
  check('the spectator\'s lap counter was not armed by the start (free-practice timing)', s.gp.lapTotal === 0 && !s.gp.taking && (s.lap.started ? s.lap.n === 1 && !s.lap.behind : s.lap.n === 0), s.lap);

  // ---- toasts while the menu is open ----
  await S.key('S', true); await S.until(`F1.game.car.state.speed < 1`, 6000); S.key('S', false);
  await S.tap('Escape');
  await H.tap('Escape');
  check('both in the menu', await S.js(`!F1.game.running && __t.shown('menu')`) && await H.js(`!F1.game.running && __t.shown('menu') && __t.shown('gp-end')`));
  await S.js(`F1.ui.toast('')`); await H.js(`F1.ui.toast('')`);
  await H.click('gp-end');                                                       // race -> results
  check('host ends the race from the menu panel -> results', await H.until(`F1.game.gp.phase === 'results'`, 3000) && await S.until(`F1.game.gp.phase === 'results'`, 3000));
  await H.click('gp-end');                                                       // results -> free
  check('... and the Grand Prix -> free', await H.until(`F1.game.gp.phase === 'free'`, 3000) && await S.until(`F1.game.gp.phase === 'free'`, 3000));
  await sleep(200);
  let th = await H.js(`__t.toast()`), ts = await S.js(`__t.toast()`);
  const overMenu = t => t.shown && t.menu && !t.hud && t.overMenu && !t.inHud && t.top > t.H / 2 && t.bottom <= t.H && t.left >= 0 && t.right <= t.W;
  check('the host sees the "Grand Prix ended" toast over its menu', overMenu(th) && th.text === '大獎賽已結束，回到自由練習', th);
  check('the spectator sitting in the menu sees it too', overMenu(ts) && ts.text === '大獎賽已結束，回到自由練習', ts);
  await H.shot('e3-host-menu-toast'); await S.shot('e3-spectator-menu-toast');
  await S.js(`document.getElementById('mp-leave').click()`);
  check('a player leaves: toast over the host\'s menu', await H.until(`__t.text('hud-toast') === 'Sam 離開了房間'`, 4000) && overMenu(await H.js(`__t.toast()`)), await H.js(`__t.toast()`));
  await S.until(`!F1.net.connected`, 3000);
  await S.js(`document.getElementById('mp-join').click()`);
  check('a player joins: toast over the host\'s menu', await H.until(`__t.text('hud-toast') === 'Sam 加入了房間'`, 6000) && overMenu(await H.js(`__t.toast()`)), await H.js(`__t.toast()`));
  await H.shot('e4-host-menu-join-toast');
  await H.tap('Escape');
  th = await H.js(`__t.toast()`);
  check('back in the car the toast is at the top of the HUD', th.shown && th.hud && !th.menu && th.top >= 0 && th.bottom < 70 && th.text === 'Sam 加入了房間', th);
  await sleep(4300);
  check('... and goes away by itself', !(await H.js(`__t.toast()`)).shown);
  await H.tap('Escape');
  await H.js(`document.getElementById('mp-leave').click()`);
  await H.until(`!F1.net.connected`, 3000);
  await H.noErrors(); await S.noErrors();
  H.destroy(); S.destroy();
}

app.on('window-all-closed', () => {});      // the parts open and close their own windows
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  host.register(ipcMain);
  const parts = { free: partFree, solo: partSolo, lap: partLap, pad: partPad, nopad: partNoPad, suzuka: partSuzuka, room: partRoom, spec: partSpec };
  for (const name of Object.keys(parts)) {
    if (ONLY.length && ONLY.indexOf(name) < 0) continue;
    try { await parts[name](); } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '  FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  await host.stopServer();
  ['index-nopad.html', 'index-alt.html'].forEach(f => { try { fs.unlinkSync(path.join(OUT, f)); } catch (e) {} });
  app.exit(bad.length ? 1 : 0);
});
