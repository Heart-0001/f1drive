// End-to-end smoke test of the v6 glue in js/main.js (+ electron-main.js): the REAL game in offscreen Electron windows,
// real key / mouse events, a fake Gamepad API, the real host IPC / server for the room part.
//   npx electron devtests/v6-smoke/smoke.js
//   env ONLY=boot,year,golden,battery,pit,monaco,tyres,audio,room,pad (default: all)   PORT=24820 (room)
//       V5=<folder of a v5 build> (golden; default: the scratch worktree of the v5 snapshot, see below)
// Screenshots go to devtests/v6-smoke/out/ (READ them). Exit code 1 when a check fails.
//   boot     boots clean; F1.game peek (cockpit, pit, tyres, spec); a fresh install drives the 2026 standard car (v6.1),
//            the 車輛 tab on 2026; the 2025 standard car picked before boot is the reference car (F1.REF_SPEC); the room
//            password fields; the F1DB credit
// Every other window has the reference car (2025-standard) picked before the game boots (devtests/ref-car.js): the
// checks, the line / pit drivers and the golden rule below were written for it.
//   year     2012 + a 2012 car picked in the menu -> car.spec is it (7 gears, V8 rpm, KERS), cockpit 'modern', the
//            telemetry shows its team, racing line rebuilt for it; 2021 + a car -> halo; back to the 2025 standard car
//   golden   the 2025 standard car driven 10 s of recorded input (time-warped frames) next to the v5 game: the same
//            trajectory, bit for bit (V5 folder), and against F1.REF_SPEC physics in node (js/car.js, same steps)
//   battery  E held on a straight: deploy, the battery drains, faster than without; braking harvests; a 2010 car has no
//            battery (telemetry hides it, E changes nothing)
//   pit      Monza, time-warped, the car driven through the controller: T picks the next compound; a lap, then into the
//            pit lane with Q (limiter): speed capped, the pit strip counts down to the box, the stop in box 1 (service
//            countdown, jack / gun, car frozen, released on new tyres of the chosen compound, the lap clock ran on);
//            the lap counts through the lane; light curtains in a screenshot; a second visit at 120 km/h without the
//            limiter: speeding toast, a 5 s longer stop
//   monaco   the same on Monaco, whose entry line is after the start / finish line
//   tyres    a Grand Prix with tyre wear x5 on Monza: laps on the autopilot, wear in the telemetry, grip dropping, a stop
//            restores the tyres
//   audio    F1.audio: worklet back end running, the engine following car.state.rpm, shifts counted, beeps with the start
//            lights, M and the volume slider
//   room     host + guest: the host picks 2014, the guest follows (toast, a 2014 car); different teams, liveries on each
//            other's car (screenshot), remote engine voices, a Grand Prix with wear x3 shows the year, parc fermé; cars in
//            the pit lane are ghosts to each other
//   pad      fake controller (v6.1 layout): A / RB boost, B / LB limiter, X compound, the hints (the v5 pad checks are
//            devtests/gp-smoke part pad)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), url = require('url');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'v6-smoke');
const refCar = require('../ref-car');
const host = require(path.join(ROOT, 'net', 'host'));
const OUT = path.join(__dirname, 'out');
const PORT = Number(process.env.PORT || 24820);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const V5 = process.env.V5 || path.join(process.env.TEMP || process.env.TMP || '', 'claude', 'C--Users-Heart-Desktop-f1Drive',
  'c2c193e6-e2b5-4b48-8955-beed8746e07e', 'scratchpad', 'v5build');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let part = '';
function check(name, ok, detail) {
  results.push({ name: part + ': ' + name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + part + ': ' + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const J = v => JSON.stringify(v);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const WARP = fs.readFileSync(path.join(ROOT, 'devtests', 'gp-e2e', 'solo-page.js'), 'utf8');   // time warp, fake pad, autopilot
const V6 = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');                                // observers, pit driver
const T_LIB = `(function () {
  var t = window.__t = {
    shown: function (id) { var e = typeof id === 'string' ? (document.getElementById(id) || document.querySelector(id)) : id; if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; },
    text: function (id) { var e = document.getElementById(id) || document.querySelector(id); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null; },
    fakePad: function () {
      var b = []; for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
      window.__rumble = [];
      window.__pad = { index: 0, id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b,
        vibrationActuator: { type: 'dual-rumble', playEffect: function (type, o) { window.__rumble.push([type, o.duration]); return Promise.resolve('complete'); } } };
      window.__padOn = true;
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return window.__padOn ? [window.__pad, null, null, null] : [null, null, null, null]; } });
      window.__btn = function (i, v) { var x = window.__pad.buttons[i]; x.value = v; x.pressed = v > 0.5; return true; };
      return true;
    }
  };
  return true;
})()`;

// The page to load: the real index.html, or another build's (v5 golden reference)
function pageFile(which) {
  if (which === 'v5') return path.join(V5, 'index.html');
  return path.join(ROOT, 'index.html');
}

let winSeq = 0;
function makeWin(tag, opts) {
  opts = opts || {};
  const w = new BrowserWindow({
    width: opts.w || 1280, height: opts.h || 720, show: false, useContentSize: true,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'v6s-' + tag + '-' + (++winSeq),
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
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('renderer gone: ' + d.reason); console.log('[' + tag + '] renderer gone', d.reason); });
  host.attach(w);
  w.tag = tag;
  w.js = code => w.webContents.executeJavaScript(code);
  w.shot = async (n, draw) => {
    if (draw) await w.js(`window.__e && __e.draw ? __e.draw() : true`);
    await sleep(200);
    fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG());
  };
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  w.tap = async k => { w.key(k, true); await sleep(60); w.key(k, false); await sleep(120); };
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(40); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  // opts.warp: inject the time warp + fake controller of gp-e2e/solo-page.js before anything asks for a frame
  // opts.fresh: a fresh install (else the reference car is picked before the game boots: devtests/ref-car.js)
  w.open = async (which, o) => {
    o = o || {};
    if (which !== 'v5' && !o.fresh) await refCar.seed(w);
    await w.loadFile(pageFile(which));
    await sleep(900);
    await w.js(T_LIB);
    if (o.warp) { await w.js(WARP); await w.js(`__e.renderEvery = 0; true`); }
    if (which !== 'v5') await w.js(V6);
    return w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  };
  w.field = (id, v) => w.js(`(function () { var e = document.getElementById(${J(id)}); e.value = ${J(v)};
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  // a real mouse click in the middle of an element (CSS selector or id), scrolled into view first
  w.click = async sel => {
    const r = await w.js(`(function () { var e = document.getElementById(${J(sel)}) || document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, hit: !!top && (top === e || e.contains(top)), disabled: !!e.disabled }; })()`);
    if (!r || !(r.w > 0) || !r.hit || r.disabled) { console.log('click: ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
  };
  // the track card (real mouse click) -> the game runs on it
  w.pickTrack = async id => {
    const i = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; })`);
    if (i < 0 || !await w.click(`#track-grid .card[data-i="${i}"]`)) return false;
    return w.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, 20000, 'track ' + id);
  };
  // the 年份 select of the 車輛 tab (a native select cannot be opened offscreen: its value is set and 'change' fired)
  w.pickYear = async y => {
    await w.click('#tab-car');
    return w.js(`(function () { var s = document.getElementById('car-year'); if (s.disabled) return 'disabled'; s.value = ${J(String(y))}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  };
  w.pickCar = async id => { await w.click('#tab-car'); return w.click(`#car-list .car-card[data-id="${id}"]`); };
  // time warp: pump frames until cond (a JS expression; E = __e, F1, g = F1.game) holds, for at most maxS s of game time
  w.pump = async (cond, maxS, what) => {
    const start = await w.js(`__e.clock`);
    for (;;) {
      const r = await w.js(`__e.run(200000, ${J(cond)}, 150)`);
      if (r.fatal) throw new Error('error overlay: ' + r.fatal);
      if (r.hit) return true;
      if (r.idle || r.clock - start > maxS * 1000) {
        console.log((r.idle ? 'NOT RUNNING ' : 'TIMEOUT (' + maxS + ' s of game time) ') + tag + ': ' + (what || cond) + '  ' + J(await w.js(`({ car: __v.car ? __v.car() : null, plan: __v.planInfo ? __v.planInfo() : null })`)));
        return false;
      }
    }
  };
  w.frames = n => w.js(`__e.run(${n}, '', 5000)`);
  w.noErrors = async what => {
    const overlay = await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    check(tag + ': no error overlay, no console errors' + (what ? ' (' + what + ')' : ''), !overlay && w.errors.length === 0, overlay || w.errors.slice(0, 3));
  };
  return w;
}

/* ================= boot ================= */
const CAR_TAB = `({ year: document.getElementById('car-year').value, years: document.getElementById('car-year').options.length, disabled: document.getElementById('car-year').disabled,
    cards: document.querySelectorAll('#car-list .car-card').length, on: (document.querySelector('#car-list .car-card.on') || {}).getAttribute ? document.querySelector('#car-list .car-card.on').getAttribute('data-id') : null,
    locked: document.getElementById('car-list').classList.contains('locked'), lock: __t.shown('car-lock') })`;
// one car card of the 車輛 tab: its rating bars, the battery line (F1.cars.ersNote) and the 無 KERS mark
const CARD = id => `(function () { var c = document.querySelector('#car-list .car-card[data-id="${id}"]'); if (!c) return null;
    var e = c.querySelector('.car-ers'), n = c.querySelector('.car-noers');
    return { bars: [].map.call(c.querySelectorAll('.car-bar em'), function (x) { return x.firstChild.textContent; }), ers: e ? e.textContent : null, noers: n ? n.textContent : null,
      note: F1.cars.ersNote(${J(id)}), spec: (F1.cars.get(${J(id)}) || {}).ers === null ? 'null' : 'battery', overflow: c.scrollWidth > c.clientWidth + 1 }; })()`;
async function partBoot() {
  part = 'boot';
  const w = makeWin('boot');
  const err = await w.open('v6', { fresh: true });
  check('boots without the error overlay', !err, err || undefined);
  check('v6 modules present', await w.js(`!!(F1.cars && F1.createPit && F1.Tyres && F1.audio && F1.telemetry && F1.REF_SPEC && F1.carPerf && F1.buildRaceLine)`));
  const peek = await w.js(`(function () { var g = F1.game; return { cockpit: g.cockpit, pit: !!g.pit, tyres: !!g.tyres, spec: g.spec && g.spec.id, input: Object.keys(g.input).join(','),
    desc: ['cockpit', 'pit', 'tyres', 'spec'].map(function (k) { var d = Object.getOwnPropertyDescriptor(g, k); return !!d.get && !d.set; }) }; })()`);
  check('F1.game peek: cockpit (none before a track), pit, tyres, spec; read-only getters; input unchanged', peek.cockpit === null && peek.pit && peek.tyres && peek.spec && peek.desc.every(Boolean) &&
    peek.input === 'up,down,left,right', peek);
  // v6.1: a fresh install opens on 2026 and drives its standard car
  const fresh = await w.js(`(function () { var s = F1.game.spec, std = F1.cars.list(2026)[0]; return { id: s.id, year: s.year, eqStd: JSON.stringify(s) === JSON.stringify(std), stdId: std.id,
    tyres: F1.game.tyres.state.compound, battery: F1.game.car.state.battery, stored: localStorage.getItem('f1drive.car') }; })()`);
  check('a fresh install (v6.1) drives the 2026 standard car (= F1.cars.list(2026)[0]), medium tyres, battery full, nothing stored', fresh.id === '2026-standard' && fresh.year === 2026 &&
    fresh.eqStd && fresh.stdId === '2026-standard' && fresh.tyres === 'M' && fresh.battery === 1 && fresh.stored === null, fresh);
  await w.click('#tab-car');
  const menu = await w.js(CAR_TAB);
  check('車輛 tab: 年份 2026 of 17 seasons, the 2026 cars (12), the standard car highlighted, both enabled', menu.year === '2026' && menu.years === 17 && !menu.disabled && menu.cards === 12 && menu.on === '2026-standard' &&
    !menu.locked && !menu.lock, menu);
  // v6.1: every car its own battery: a line about it on its card; a car that raced without KERS: no 電池 bar, 無 KERS
  const c26 = await w.js(CARD('2026-aston-martin')), c26s = await w.js(CARD('2026-standard'));
  await w.pickYear(2011);
  await sleep(200);
  const hrt = await w.js(CARD('2011-hrt')), rb11 = await w.js(CARD('2011-red-bull'));
  await w.shot('boot-1b-cars-2011');
  await w.pickYear(2015);
  await sleep(200);
  const mcl = await w.js(CARD('2015-mclaren'));
  await w.pickYear(2010);
  await sleep(200);
  const s10 = await w.js(CARD('2010-standard'));
  console.log('car cards: ' + J({ c26, c26s, hrt, rb11, mcl, s10 }));
  const withNote = c => c && c.spec === 'battery' && c.bars.length === 5 && c.bars[4] === '電池' && !c.noers && c.note && c.ers === '電池' + c.note && !c.overflow;
  check('car cards: a car with a battery shows the 電池 bar and its battery line (F1.cars.ersNote): 2026 Aston Martin, 2011 Red Bull, 2015 McLaren ("MGU-H 回收不足…")',
    withNote(c26) && withNote(rb11) && withNote(mcl) && /^MGU-H 回收不足/.test(mcl.note), { c26, rb11, mcl });
  check('car cards: no battery line where there is no note (the standard car)', c26s && c26s.bars.length === 5 && c26s.ers === null && c26s.note === '' && !c26s.noers, c26s);
  check('car cards: no KERS (2011 HRT, the 2010 standard car): no 電池 bar, 無 KERS where the bar would be; the battery line only where there is a note (HRT: "沒有裝 KERS…")',
    [hrt, s10].every(c => c && c.spec === 'null' && c.bars.length === 4 && c.bars.indexOf('電池') < 0 && c.noers === '無 KERS' && !c.overflow && (c.note ? c.ers === '電池' + c.note : c.ers === null)) &&
    /^沒有裝 KERS/.test(hrt.note) && s10.note === '', { hrt, s10 });
  await w.pickYear(2026);
  await sleep(200);
  check('back on 2026 (the standard car again; nothing else picked)', (await w.js(`F1.game.spec.id`)) === '2026-standard');
  const credit = await w.js(`({ text: __t.text('.brand .credits'), title: document.querySelector('.brand .credits').title })`);
  check('credits: OpenStreetMap + F1DB (CC BY 4.0, modified); the full F1DB attribution on hover', /OpenStreetMap/.test(credit.text) && /F1DB（CC BY 4.0，經修改）/.test(credit.text) && /F1DB v\d/.test(credit.title) && /CC BY 4\.0/.test(credit.title), credit);
  await w.shot('boot-1-car-tab');
  await w.click('#tab-mp');
  const pw = await w.js(`({ c: !!document.getElementById('mp-create-pass'), j: !!document.getElementById('mp-join-pass'), ct: document.getElementById('mp-create-pass').type,
    cShown: __t.shown('mp-create-pass'), jShown: __t.shown('mp-join-pass'), stored: localStorage.getItem('f1drive.mp') || '' })`);
  check('多人連線 tab: a room password field for create and for join (type password, shown)', pw.c && pw.j && pw.ct === 'password' && pw.cShown && pw.jShown, pw);
  await w.shot('boot-2-mp-tab');
  await w.click('#tab-gp');
  await w.noErrors();
  w.destroy();
  // the reference car: '2025-standard' picked (stored) before the game boots, as every other part of this harness does
  const r = makeWin('boot-ref');
  const err2 = await r.open('v6');
  check('boots with the 2025 standard car picked (stored before boot)', !err2, err2 || undefined);
  const ref = await r.js(`(function () { function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    var s = F1.game.spec; return { id: s.id, eqRef: eq(s, F1.REF_SPEC), keysRef: eq(Object.keys(s), Object.keys(F1.REF_SPEC)), perfSame: Object.keys(F1.CAR_PERF).every(function (k) { var a = F1.CAR_PERF[k], b = F1.game.car.perf[k]; return typeof a === 'function' || (a && typeof a === 'object' ? eq(a, b) : a === b); }),
      tyres: F1.game.tyres.state.compound, rate: F1.game.tyres.wearRate, battery: F1.game.car.state.battery }; })()`);
  check('the 2025 standard car is the reference car: 2025-standard, deep-equal to F1.REF_SPEC, the same perf numbers, medium tyres, battery full', ref.id === '2025-standard' && ref.eqRef && ref.keysRef && ref.perfSame &&
    ref.tyres === 'M' && ref.battery === 1, ref);
  await r.click('#tab-car');
  const menu2 = await r.js(CAR_TAB);
  check('車輛 tab: 年份 2025 of 17 seasons, the 2025 cars, the standard car highlighted, both enabled', menu2.year === '2025' && menu2.years === 17 && !menu2.disabled && menu2.cards === 11 && menu2.on === '2025-standard' &&
    !menu2.locked && !menu2.lock, menu2);
  await r.noErrors();
  r.destroy();
}

/* ================= year / car ================= */
async function partYear() {
  part = 'year';
  const w = makeWin('year');
  await w.open('v6');
  const y1 = await w.pickYear(2012);
  await sleep(200);
  const list = await w.js(`[].map.call(document.querySelectorAll('#car-list .car-card'), function (c) { return c.getAttribute('data-id'); })`);
  const sel0 = await w.js(`F1.game.spec.id`);
  check('年份 2012 picked (offline): the list shows the 2012 cars, the car follows at once (2012 standard)', y1 === '2012' && list.length >= 12 && list.every(id => /^2012-/.test(id)) && sel0 === '2012-standard', { y1, list, sel0 });
  const pick = list.indexOf('2012-red-bull') >= 0 ? '2012-red-bull' : list[1];
  check('a 2012 car card clicked (real mouse click)', await w.pickCar(pick));
  await sleep(200);
  let s = await w.js(`(function () { var s = F1.game.spec, st = F1.game.car.state; return { id: s.id, year: s.year, gears: s.gearKmh.length + 1, rpmShift: s.rpmShift, rpmMax: s.rpmMax, cyl: s.cylinders, asp: s.aspiration,
    ers: s.ers, cockpit: s.cockpit, team: s.team, battery: st.battery, stored: localStorage.getItem('f1drive.car'), on: document.querySelector('#car-list .car-card.on').getAttribute('data-id'),
    profile: F1.net.getProfile().car, engine: F1.audio.debug.engine ? { cyl: F1.audio.debug.engine.cyl, idle: F1.audio.debug.engine.idle, max: F1.audio.debug.engine.max } : null }; })()`);
  check('car.spec is that car: 7 gears, V8 revs (rpmShift > 17000), naturally aspirated, KERS battery, full', s.id === pick && s.year === 2012 && s.gears === 7 && s.rpmShift > 17000 && s.cyl === 8 && s.asp === 'na' &&
    s.ers && s.ers.store < 1000 && s.battery === 1 && s.on === pick && s.profile === pick && JSON.parse(s.stored).car === pick, s);
  check('F1.audio.setEngine got it (8 cylinders, its rpm range)', s.engine && s.engine.cyl === 8 && s.engine.max >= 17000, s.engine);
  check('Monza loads', await w.pickTrack('it-1922'));
  await sleep(1200);
  const ck = await w.js(`(function () { var i = F1.game.cockpit.info(); return { style: i.style, halo: i.halo, year: i.year, colour: i.livery.colour, spec: F1.game.spec.colour }; })()`);
  const tel = await w.js(`({ team: __v.hud.team, car: __v.hud.car, colour: __v.hud.colour, rpmShift: __v.hud.rpmShift, rpmMax: __v.hud.rpmMax, battery: __v.hud.battery, gear: __v.hud.gear })`);
  check('cockpit: style modern (no halo), livery of the car', ck.style === 'modern' && !ck.halo && ck.colour.toLowerCase() === ck.spec.toLowerCase(), ck);
  check('telemetry: its team, car, colour and rpm range', tel.team === s.team && tel.rpmShift === s.rpmShift && tel.rpmMax === s.rpmMax && tel.battery === 1 && tel.colour === ck.spec, tel);
  const line = await w.js(`(function () { var a = F1.buildRaceLine(F1.game.track, F1.game.car.perf).points, b = F1.game.raceLine.points, r = F1.buildRaceLine(F1.game.track).points, same = a.length === b.length, diff = 0;
    for (var i = 0; same && i < a.length; i++) if (a[i].speed !== b[i].speed) { same = false; } for (i = 0; i < r.length && i < b.length; i++) diff = Math.max(diff, Math.abs(r[i].speed - b[i].speed));
    return { same: same, diffToRef: diff }; })()`);
  check('the racing line is this car\'s (built with car.perf; differs from the reference car\'s)', line.same && line.diffToRef > 0.5, line);
  w.key('W', true); await sleep(2500); w.key('W', false);
  s = await w.js(`__v.car()`);
  check('it drives (gear and rpm from the car: V8 revs)', s.v > 20 && s.gear >= 2 && s.rpm > 9000, s);
  await w.shot('year-1-2012-cockpit');
  // 2021 + a car
  await w.tap('Escape');
  await w.pickYear(2021);
  await sleep(200);
  const list21 = await w.js(`[].map.call(document.querySelectorAll('#car-list .car-card'), function (c) { return c.getAttribute('data-id'); })`);
  const auto21 = await w.js(`F1.game.spec.id`);
  check('2021 picked: the same team\'s 2021 car at once (lineage)', /^2021-/.test(auto21) && auto21 !== '2021-standard', auto21);
  const pick21 = list21.indexOf('2021-mercedes') >= 0 ? '2021-mercedes' : list21[2];
  check('a 2021 car clicked', await w.pickCar(pick21));
  await sleep(300);
  const ck21 = await w.js(`(function () { var i = F1.game.cockpit.info(); return { style: i.style, halo: i.halo, spec: F1.game.spec.id, cockpit: F1.game.spec.cockpit, gears: F1.game.spec.gearKmh.length + 1, cyl: F1.game.spec.cylinders }; })()`);
  check('2021 car: halo cockpit, V6 hybrid, 8 gears', ck21.spec === pick21 && ck21.style === 'halo' && ck21.halo && ck21.gears === 8 && ck21.cyl === 6, ck21);
  await w.tap('Escape');
  await sleep(1500);
  await w.shot('year-2-2021-cockpit');
  // back to 2025, the standard car
  await w.tap('Escape');
  await w.pickYear(2025);
  await w.pickCar('2025-standard');
  await sleep(300);
  const back = await w.js(`({ eq: JSON.stringify(F1.game.spec) === JSON.stringify(F1.REF_SPEC), style: F1.game.cockpit.info().style, line: (function () { var a = F1.buildRaceLine(F1.game.track).points, b = F1.game.raceLine.points;
    for (var i = 0; i < a.length; i++) if (a[i].speed !== b[i].speed || a[i].x !== b[i].x) return false; return a.length === b.length; })() })`);
  check('2025 standard car: car.spec deep-equals F1.REF_SPEC, cockpit halo18, the racing line bit-identical to the reference one', back.eq && back.style === 'halo18' && back.line, back);
  await w.tap('Escape');
  await sleep(1200);
  await w.shot('year-3-2025-standard');
  await w.noErrors();
  w.destroy();
}

/* ================= golden rule: the reference car against the v5 game ================= */
// Recorded input, frame by frame (60 frames = 1 s): [from frame, keys held]. GENTLE steers only at low speed (the tyres
// never slide); FLICK has two full-lock key flicks at ~150 km/h (the tyres slide past js/tyres.js's FLAT_SLIP).
const GENTLE = [[0, 'W'], [40, 'WA'], [46, 'WD'], [52, 'W'], [400, 'S'], [450, ''], [460, 'W'], [600, null]];
const FLICK = [[0, 'W'], [150, 'WA'], [168, 'W'], [186, 'WD'], [204, 'W'], [420, 'S'], [470, ''], [480, 'W'], [540, 'WA'], [552, 'W'], [600, null]];
const GOLDEN_LIB = `(function (prog) {
  var E = window.__e, rec = [], k = 0;
  window.__gold = rec;
  E.ap.on = true;
  E.ap.step = function () {
    var g = F1.game, s = g.car.state;
    rec.push([s.x, s.z, s.heading, s.speed, s.steer, s.y, s.pitch, s.roll, s.sampleIndex, s.d, g.lap ? g.lap.time : 0]);
    while (k + 1 < prog.length && prog[k + 1][0] <= E.gameFrames) k++;
    var keys = prog[k][1] || '';
    g.input.up = keys.indexOf('W') >= 0; g.input.down = keys.indexOf('S') >= 0; g.input.left = keys.indexOf('A') >= 0; g.input.right = keys.indexOf('D') >= 0;
  };
  return true;
})`;
function compare(a, b, fields) {
  let worst = 0, at = -1;
  for (let f = 0; f < Math.min(a.length, b.length); f++) for (let k = 0; k < fields; k++) { const d = Math.abs(a[f][k] - b[f][k]); if (d > worst) { worst = d; at = f; } }
  return { frames: [a.length, b.length], worstDiff: worst, atFrame: at, same: a.length === b.length && worst === 0 };
}
async function goldenRun(which, prog, rate0) {
  const w = makeWin('gold' + which.slice(1) + (rate0 ? 'r0' : ''));
  const err = await w.open(which, { warp: true });
  check(which + ' boots', !err, err || undefined);
  if (which === 'v6') check(which + ': the reference car (2025-standard = F1.REF_SPEC)', await w.js(`JSON.stringify(F1.game.spec) === JSON.stringify(F1.REF_SPEC)`));
  const i = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === 'it-1922'; })`);
  await w.click(`#track-grid .card[data-i="${i}"]`);
  const ok = await w.until(`F1.game.running && F1.game.track && __e.queued() === 1`, 20000);
  if (rate0) await w.js(`F1.game.tyres.setWearRate(0); true`);
  await w.js(GOLDEN_LIB + '(' + J(prog) + ')');
  await w.js(`__e.run(${prog[prog.length - 1][0] + 1}, '', 60000)`);
  const out = { rec: await w.js(`__gold`), ok, tyres: which === 'v6' ? await w.js(`__v.tyres()`) : null };
  if (which === 'v6' && !rate0 && prog === GENTLE) await w.shot('golden-v6-end', true);
  await w.noErrors();
  w.destroy();
  return out;
}
function nodeReplay(prog) {
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'golden-node.js')], { encoding: 'utf8', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    input: J({ program: prog }) });
  try { return JSON.parse(r.stdout); } catch (e) { check('node replay ran', false, (r.stderr || r.stdout || '').slice(0, 800)); return null; }
}
async function partGolden() {
  part = 'golden';
  const haveV5 = fs.existsSync(path.join(V5, 'index.html')) && fs.existsSync(path.join(V5, 'js', 'main.js'));
  if (!haveV5) check('v5 build found for the comparison (' + V5 + ')', false, 'set V5=<folder>');
  // 1. gentle driving: the tyres stay exactly new -> bit-identical to v5
  const g6 = await goldenRun('v6', GENTLE);
  const a = g6.rec;
  check('v6: 10 s recorded (601 frames), the car went somewhere (> 300 m)', a.length === 601 && Math.hypot(a[600][0] - a[0][0], a[600][1] - a[0][1]) > 300, a.length && { from: a[0].slice(0, 2), to: a[600].slice(0, 4) });
  check('v6, gentle input: the tyres are still exactly the reference after 10 s (grip 1 / 1 / 1, no flat spot, < 20 % wear)', g6.tyres.grip.lat === 1 && g6.tyres.grip.brake === 1 &&
    g6.tyres.grip.traction === 1 && Math.max.apply(null, g6.tyres.flat) === 0 && Math.max.apply(null, g6.tyres.wear) < 0.2, g6.tyres);
  if (haveV5) {
    const g5 = await goldenRun('v5', GENTLE);
    const c = compare(a, g5.rec, 11);
    check('GOLDEN RULE: v6 reference car vs the v5 game, same recorded input, same frames: every state value of every frame bit-identical (x, z, heading, speed, steer, y, pitch, roll, sample, d, lap clock)',
      c.same, Object.assign(c, c.atFrame >= 0 ? { v6: a[c.atFrame], v5: g5.rec[c.atFrame] } : {}));
  }
  const n1 = nodeReplay(GENTLE);
  if (n1) { const c = compare(a, n1, 10); check('v6 game vs F1.createCar(F1.REF_SPEC) stepped in node exactly as main.js steps it (gentle): bit-identical', c.same, c); }
  // 2. two full-lock flicks at speed: the tyres slide -> flat spots (js/tyres.js) -> a trace of braking grip less
  const f6 = await goldenRun('v6', FLICK), f60 = await goldenRun('v6', FLICK, true);
  const n2 = nodeReplay(FLICK);
  if (n2) { const c = compare(f6.rec, n2, 10); check('v6 game vs node replay (flick): bit-identical', c.same, c); }
  if (haveV5) {
    const f5 = await goldenRun('v5', FLICK);
    const c = compare(f6.rec, f5.rec, 11), c0 = compare(f60.rec, f5.rec, 11);
    console.log('flick input: v6 at tyre wear rate 1 vs v5: ' + J(c) + '  tyres ' + J(f6.tyres));
    check('flick input, tyre model frozen (setWearRate(0): the reference tyres): bit-identical to v5 -> the tyres are the only difference', c0.same, c0);
    check('flick input, tyres live: the slides left flat spots (js/tyres.js: slip > FLAT_SLIP), braking grip < 1, the trajectory stays within 1 cm of v5 over 10 s',
      Math.max.apply(null, f6.tyres.flat) > 0 && f6.tyres.grip.brake < 1 && c.worstDiff < 0.01, { worstDiff: c.worstDiff, flat: f6.tyres.flat, grip: f6.tyres.grip });
  }
}

/* ================= battery ================= */
// One window per run (the same start, the same frames): W (+ E) from the start line of Monza for 8 s of game time.
async function batteryRun(tag, year, carId, boost) {
  const w = makeWin(tag);
  await w.open('v6', { warp: true });
  if (year) { await w.pickYear(year); if (carId) await w.pickCar(carId); await sleep(150); }
  const i = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === 'it-1922'; })`);
  await w.click(`#track-grid .card[data-i="${i}"]`);
  await w.until(`F1.game.running && F1.game.track && __e.queued() === 1`, 20000);
  await w.js(`__v.hookRenderer(); true`);
  w.key('W', true); if (boost) w.key('E', true);
  const keys = await w.until(`F1.game.input.up && F1.game.boost === ${!!boost}`, 3000, 'keys arrive');
  // (the stick keeps the car on the centreline: W alone would drift off the slightly curved straight onto the grass)
  const r = await w.js(`(function () { var out = { maxDeploy: 0, minBattery: 1, deployFrames: 0, grass: 0 }; __v.follow(true); var n = 0;
    while (n < 480) { var k = __e.run(1, '', 5000).n; if (!k) break; n += k; var s = F1.game.car.state;
      if (s.deploy > out.maxDeploy) out.maxDeploy = s.deploy; if (s.battery < out.minBattery) out.minBattery = s.battery; if (s.deploy > 0) out.deployFrames++; if (s.onGrass) out.grass++; }
    out.frames = n; out.car = __v.car(); out.hud = { battery: __v.hud.battery, deploy: __v.hud.deploy, harvest: __v.hud.harvest }; return out; })()`);
  r.keys = keys; r.w = w;
  return r;
}
async function partBattery() {
  part = 'battery';
  const a = await batteryRun('bat-no', 0, null, false), b = await batteryRun('bat-e', 0, null, true);
  console.log('8 s from the line, W only: ' + (a.car.v * 3.6).toFixed(1) + ' km/h; W + E: ' + (b.car.v * 3.6).toFixed(1) + ' km/h, battery ' + b.car.battery.toFixed(3));
  check('keys through the real input path (W, E held)', a.keys && b.keys);
  check('W only: 480 frames on the road, no deploy, the battery stays full', a.frames === 480 && a.grass === 0 && b.grass === 0 && a.maxDeploy === 0 && a.car.battery === 1 && a.hud.battery === 1,
    { frames: a.frames, grass: [a.grass, b.grass], maxDeploy: a.maxDeploy, battery: a.car.battery });
  check('E held: state.deploy > 0, the battery drains, faster than without (> +3 km/h after 8 s); the telemetry shows it', b.maxDeploy > 0.5 && b.car.battery < 0.9 && b.car.v * 3.6 > a.car.v * 3.6 + 3 && b.hud.deploy > 0 && b.hud.battery === b.car.battery,
    { maxDeploy: b.maxDeploy, battery: b.car.battery, kmh: [a.car.v * 3.6, b.car.v * 3.6], hud: b.hud });
  await b.w.shot('battery-1-deploying', true);
  // braking: harvest
  b.w.key('E', false); b.w.key('W', false); b.w.key('S', true);
  await b.w.until(`!F1.game.input.up && F1.game.input.down && !F1.game.boost`, 3000);
  const h = await b.w.js(`(function () { var out = { maxHarvest: 0, b0: F1.game.car.state.battery };
    for (var n = 0; n < 60; n++) { __e.run(1, '', 5000); var s = F1.game.car.state; if (s.harvest > out.maxHarvest) out.maxHarvest = s.harvest; }
    out.b1 = F1.game.car.state.battery; out.hudHarvest = __v.hud.harvest; out.v = F1.game.car.state.speed; return out; })()`);
  b.w.key('S', false);
  check('braking: state.harvest > 0, the battery charges', h.maxHarvest > 0.3 && h.b1 > h.b0, h);
  await b.w.shot('battery-2-harvesting', true);
  await a.w.noErrors(); await b.w.noErrors(); a.w.destroy(); b.w.destroy();
  // 2010: no battery
  const c = await batteryRun('bat-2010', 2010, '2010-standard', false), d = await batteryRun('bat-2010e', 2010, '2010-standard', true);
  check('2010 car: spec.ers null, battery 0, the telemetry gets battery null (hidden)', c.car.spec === '2010-standard' && (await c.w.js(`F1.game.spec.ers === null`)) && c.car.battery === 0 && c.hud.battery === null && d.hud.battery === null,
    { spec: c.car.spec, battery: c.car.battery, hud: c.hud });
  check('2010 car: E does nothing (no deploy, the same speed to the last bit)', d.keys && d.maxDeploy === 0 && d.car.v === c.car.v && d.car.x === c.car.x, { v: [c.car.v, d.car.v], deploy: d.maxDeploy });
  await d.w.shot('battery-3-2010-no-battery', true);
  await c.w.noErrors(); await d.w.noErrors(); c.w.destroy(); d.w.destroy();
  // v6.1 (every car its own battery): a 2011 car that raced without KERS - the HRT - has none either
  const hr = await batteryRun('bat-2011hrt', 2011, '2011-hrt', true);
  check('2011 HRT (raced without KERS): spec.ers null, battery 0, the telemetry gets battery null (hidden), E held deploys nothing', hr.car.spec === '2011-hrt' &&
    (await hr.w.js(`F1.game.spec.ers === null`)) && hr.car.battery === 0 && hr.hud.battery === null && hr.keys && hr.maxDeploy === 0 && hr.frames === 480 && hr.grass === 0,
    { spec: hr.car.spec, battery: hr.car.battery, hud: hr.hud, deploy: hr.maxDeploy, keys: hr.keys, frames: hr.frames, grass: hr.grass });
  await hr.w.shot('battery-4-2011-hrt-no-kers', true);
  await hr.w.noErrors(); hr.w.destroy();
}

/* ================= pit lane ================= */
const PIT_BEFORE = 420;          // m before pit.from where the pit driver takes over from the line autopilot
const nearPit = m => `(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - g.car.state.sampleIndex) % N + N) % N, m = k * g.track.length / N;
  return g.lap.started && m < ${m} && m > ${m - 40}; })()`;
// Drive into the pit lane with the pit driver (page.js), stop in our box, out again. -> what was seen
async function pitVisit(w, name, o) {
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  if (!await w.pump(nearPit(PIT_BEFORE), 200, name + ': ' + PIT_BEFORE + ' m before the pit lane')) return null;
  if (o.limiter) { await w.tap('Q'); if (!await w.until(`F1.game.limiter === true`, 2000, 'Q')) return null; }
  const plan = await w.js(`__v.pitPlan(${J({ cruise: !!o.limiter, vLane: o.vLane || 0 })})`);
  if (!plan || !plan.ok) { console.log('pitPlan', J(plan)); return null; }
  const shots = {};
  // the entry curtain ahead (~50 m before the entry line)
  await w.pump(`__v.plan.U >= __v.plan.uEn - 25`, 60, 'before the entry line');
  shots.entry = name + '-1-entry-curtain'; await w.shot(shots.entry, true);
  // in the lane, the strip counting down to the box
  await w.pump(`F1.game.pit.state.inLane && F1.game.pit.state.boxAhead !== null && F1.game.pit.state.boxAhead < 60 && !F1.game.pit.state.service`, 60, 'box ahead');
  const strip = await w.js(`({ box: __t.text('hud-pit-box'), limit: __t.text('hud-pit-limit'), lim: __t.text('hud-pit-lim'), warn: __t.shown('hud-pit-warn') ? __t.text('hud-pit-warn') : '',
    shown: __t.shown('hud-pit'), pit: __v.pit, hudLimiter: __v.hud.limiter, hudInPit: __v.hud.inPit, speeding: F1.game.pit.state.speeding })`);
  shots.lane = name + '-2-lane'; await w.shot(shots.lane, true);
  // the stop
  const svc = await w.pump(`!!F1.game.pit.state.service`, 60, 'service');
  await w.frames(30);
  const during = await w.js(`({ svc: __v.pitState().service, strip: __t.text('hud-pit-svc'), car: __v.car(), sounds: __v.soundsSince(__v.plan.sounds0), hudGear: __v.hud.gear })`);
  shots.service = name + '-3-service'; await w.shot(shots.service, true);
  await w.pump(`!F1.game.pit.state.service`, 20, 'service done');
  await w.frames(2);
  const after = await w.js(`({ tyres: __v.tyres(), toasts: __v.toasts.slice(-3).map(function (t) { return t.text; }), sounds: __v.soundsSince(__v.plan.sounds0), stops: F1.game.pit.state.stops })`);
  await w.pump(`!__v.plan.active`, 90, name + ': out of the lane');
  if (o.limiter) { await w.tap('Q'); await w.until(`F1.game.limiter === false`, 2000, 'Q off'); }
  const info = await w.js(`__v.planInfo()`);
  return { plan, strip, svc, during, after, info, shots };
}
async function pitScenario(trackId, tag, second) {
  const w = makeWin(tag);
  await w.open('v6', { warp: true });
  check(tag + ': track loads', await w.pickTrack(trackId));
  await w.js(`__v.hookRenderer() && __e.hookCar()`);
  const P = await w.js(`(function () { var p = F1.game.track.pit, N = F1.game.track.samples.length; return { limit: p.limitKmh, entryAfterLine: ((p.entry % N) + N) % N < N / 2, from: p.from, entry: p.entry, box0: p.boxes[0].index, N: N }; })()`);
  // T: the next set will be hards
  await w.tap('T');
  await w.frames(2);
  const t = await w.js(`({ next: F1.game.nextCompound, hud: __v.hud.nextCompound, toast: __v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /下一組輪胎/.test(t); }).join('|'), fitted: F1.game.tyres.state.compound })`);
  check(tag + ': T picks the next compound (M -> H), shown in the telemetry, a toast; the fitted set stays medium', t.next === 'H' && t.hud === 'H' && /硬胎/.test(t.toast) && t.fitted === 'M', t);
  check(tag + ': the timing starts', await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`) && await w.pump(`g.lap.started`, 60, 'timing'));
  const v1 = await pitVisit(w, tag, { limiter: true });
  if (!v1) { check(tag + ': pit visit with the limiter ran', false); w.destroy(); return; }
  const r = v1.info.rec;
  console.log(tag + ' visit 1: ' + J({ stopped: v1.info.stopped, rec: r, strip: v1.strip }));
  check(tag + ': Q engaged the limiter; the strip shows the limit and 限速器 開; the telemetry knows', v1.strip.shown && v1.strip.hudLimiter === true && /限速器 開/.test(v1.strip.lim) &&
    new RegExp('限速\\s*' + P.limit).test(v1.strip.limit), v1.strip);
  check(tag + ': in the lane the speed is capped at the limit (max ' + r.maxLaneKmh.toFixed(2) + ' km/h, limit ' + P.limit + '), the limiter holds it (' + r.cruiseKmh.toFixed(1) + ')',
    r.maxLaneKmh <= P.limit + 0.5 && r.cruiseKmh >= P.limit - 2.5, { max: r.maxLaneKmh, cruise: r.cruiseKmh });
  check(tag + ': the pit strip counts down to our box (維修格 1 號：前方 N m)', /維修格 1 號：前方 \d+ m/.test(v1.strip.box) && v1.strip.pit.boxAhead > 0 && v1.strip.pit.slot === 0 && v1.strip.hudInPit, v1.strip.box);
  check(tag + ': no wall contact, no grass in the pit complex', r.hits === 0 && r.grass === 0, { hits: r.hits, grass: r.grass });
  const st = v1.info.stopped;
  check(tag + ': stopped in box 1 (within the pit rule: 2.5 m along, 1.2 m across)', st && Math.abs(st.along) < 2.5 && Math.abs(st.across) < 1.2 && st.inPit, st);
  check(tag + ': service countdown (換胎中) of 2.0..4.5 s, no penalty', v1.svc && v1.during.svc && v1.during.svc.left < v1.during.svc.total && /換胎中/.test(v1.during.strip) &&
    r.svcWork >= 2 && r.svcWork <= 4.5 && r.svcPenalty === 0, { during: v1.during.svc, strip: v1.during.strip, work: r.svcWork });
  const snd = v1.during.sounds.filter(k => /jack|pitgun/.test(k)), snd2 = v1.after.sounds.filter(k => /jack|pitgun/.test(k));
  check(tag + ': jack and wheel gun requested at the start of the service, again at the end', J(snd) === J(['play:jack', 'play:pitgun']) && J(snd2) === J(['play:jack', 'play:pitgun', 'play:pitgun', 'play:jack']),
    { during: v1.during.sounds, after: v1.after.sounds });
  check(tag + ': the car is frozen during the service (no movement, speed 0 in every frame), shown in neutral', r.serviceFrames > 100 && r.maxServiceMove === 0 && r.frozenBad === 0 && v1.during.hudGear === 0,
    { frames: r.serviceFrames, moved: r.maxServiceMove, bad: r.frozenBad, gear: v1.during.hudGear });
  const held = (r.svcDoneClock - r.svcStartClock) / 1000;
  check(tag + ': the stop lasted the service time (' + held.toFixed(2) + ' s vs ' + r.svcTotal.toFixed(2) + ' s) and the lap clock ran on through it (a stop costs time)',
    Math.abs(held - r.svcTotal) < 0.05 && Math.abs((r.svcLap1 - r.svcLap0) - held) < 0.05, { held, total: r.svcTotal, lapClock: [r.svcLap0, r.svcLap1] });
  check(tag + ': released on a new set of the chosen compound (H, no wear), toast', v1.after.tyres.compound === 'H' && Math.max.apply(null, v1.after.tyres.wear) < 1e-6 && v1.after.stops === 1 &&
    v1.after.toasts.some(x => /換上新胎：硬胎/.test(x)), v1.after);
  const lapIn = r.lapChanges.filter(c => c.inLane || c.carInPit || Math.abs(c.d) > 7);
  check(tag + ': the lap counts through the pit lane (a lap completed while in the ' + (P.entryAfterLine ? 'entry taper' : 'lane') + ', its time recorded)',
    r.lapChanges.length >= 1 && (P.entryAfterLine || lapIn.length >= 1) && r.lapChanges[0].last > 30, { changes: r.lapChanges, entryAfterLine: P.entryAfterLine });
  check(tag + ': light curtains: screenshot ' + v1.shots.entry + '.png (READ it)', true);
  if (second) {
    const v2 = await pitVisit(w, tag + '-fast', { limiter: false, vLane: 120 / 3.6 });
    if (!v2) { check(tag + ': second visit ran', false); }
    else {
      const r2 = v2.info.rec;
      console.log(tag + ' visit 2: ' + J({ stopped: v2.info.stopped, rec: r2 }));
      const toastSpeed = await w.js(`__v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /維修區超速/.test(t); })`);
      check(tag + ': 120 km/h in the lane without the limiter: speeding toast', r2.maxLaneKmh > P.limit + 20 && toastSpeed.length >= 1, { max: r2.maxLaneKmh, toasts: toastSpeed });
      check(tag + ': the stop is 5 s longer (penalty 5 s served first)', r2.svcPenalty === 5 && Math.abs(r2.svcTotal - r2.svcWork - 5) < 1e-9 && Math.abs((r2.svcDoneClock - r2.svcStartClock) / 1000 - r2.svcTotal) < 0.05,
        { total: r2.svcTotal, work: r2.svcWork, penalty: r2.svcPenalty });
      check(tag + ': second stop: 2 stops, frozen, no contact', v2.after.stops === 2 && r2.maxServiceMove === 0 && r2.frozenBad === 0 && r2.hits === 0, { stops: v2.after.stops, hits: r2.hits, moved: r2.maxServiceMove, bad: r2.frozenBad });
      // over the limit again after the stop (the driver keeps 120 km/h to the exit line): a new offence, held 5 s AT THE
      // EXIT LINE (a stop-go: js/pit.js 'penaltyStart' / 'penaltyDone', no tyres), the car frozen, the lap clock running
      const tAll = await w.js(`__v.toasts.map(function (t) { return t.text; })`);
      const heldS = (r2.holdDoneClock - r2.holdStartClock) / 1000;
      check(tag + ': speeding after the stop: a second toast (在出口線罰停 5 秒), held ' + (heldS === heldS ? heldS.toFixed(2) : '?') + ' s at the exit line, frozen, the lap clock ran on, then 罰停結束; no new tyres (still 2 stops)',
        tAll.filter(t => /維修區超速（限速/.test(t)).length === 2 && /在出口線罰停 5 秒/.test(tAll.filter(t => /維修區超速（限速/.test(t))[1]) && tAll.some(t => /出口線停 5 秒/.test(t)) && tAll.some(t => /罰停結束/.test(t)) &&
        r2.holdTotal === 5 && Math.abs(heldS - 5) < 0.05 && Math.abs((r2.holdLap1 - r2.holdLap0) - heldS) < 0.05 && r2.maxHoldMove === 0 && r2.holdFrozenBad === 0 &&
        (await w.js(`F1.game.pit.state.stops`)) === 2 && (await w.js(`F1.game.pit.state.pending`)) === 0,
        { toasts: tAll.slice(-6), hold: { total: r2.holdTotal, held: heldS, lap: r2.holdLap1 - r2.holdLap0, moved: r2.maxHoldMove, bad: r2.holdFrozenBad } });
    }
  }
  await w.noErrors();
  w.destroy();
}
async function partPit() { part = 'pit'; await pitScenario('it-1922', 'pit-monza', true); }
async function partMonaco() { part = 'monaco'; await pitScenario('mc-1929', 'pit-monaco', false); }

/* ================= tyres: a Grand Prix with wear x5 ================= */
async function partTyres() {
  part = 'tyres';
  const w = makeWin('tyres');
  await w.open('v6', { warp: true });
  await w.pickTrack('it-1922');
  await w.js(`__v.hookRenderer() && __e.hookCar()`);
  await w.tap('Escape');
  await w.click('#tab-gp');
  // (the wear option is for the race only: qualifying runs at x1, so the laps are driven in the race)
  await w.field('gp-q', '1'); await w.field('gp-r', '3');
  await w.click('#gp-wear button[data-w="5"]');
  check('Grand Prix with 輪胎損耗 ×5 started from the menu', await w.click('gp-start') && await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  const tq = await w.js(`__v.tyres()`);
  check('qualifying: wear rate 1 (the x5 is for the race only)', tq.rate === 1, tq);
  await w.js(`F1.game.gp.action('skip'); true`);
  check('qualifying skipped: on the grid', await w.pump(`g.gp.phase === 'grid'`, 5, 'grid'));
  const t0 = await w.js(`__v.tyres()`);
  check('grid: a new medium set, wear rate 5 from here on', t0.rate === 5 && t0.compound === 'M' && Math.max.apply(null, t0.wear) === 0, t0);
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('lights out: the race', await w.pump(`g.gp.phase === 'race' && !g.gp.inputLocked`, 30, 'race'));
  const laps = [];
  for (let k = 1; k <= 2; k++) {
    const ok = await w.pump(`g.gp.lap >= ${k}`, 200, 'race lap ' + k);
    const s = await w.js(`({ lap: F1.game.lap.last, tyres: __v.tyres(), hud: __v.hud.tyres })`);
    laps.push({ ok, lap: s.lap, wear: s.tyres.wear.map(x => +x.toFixed(3)), grip: s.tyres.grip, hudWear: s.hud.wear });
    if (k === 2) await w.shot('tyres-1-worn-telemetry', true);
  }
  console.log('wear x5, Monza, laps on the autopilot: ' + J(laps));
  check('2 laps driven; the wear grows lap by lap (x5: a medium set is past half after 2 laps), shown in the telemetry', laps.every(l => l.ok) && laps[0].wear[0] > 0.05 && laps[1].wear[0] > laps[0].wear[0] + 0.1 &&
    J(laps[1].hudWear.map(x => +x.toFixed(3))) === J(laps[1].wear), laps.map(l => l.wear));
  check('grip dropping with the wear (lateral / braking / traction below 1, lower after lap 2 than after lap 1)', laps[1].grip.lat < laps[0].grip.lat && laps[1].grip.brake < laps[0].grip.brake &&
    laps[1].grip.traction < laps[0].grip.traction && laps[1].grip.lat < 0.97, laps.map(l => l.grip));
  const v = await pitVisit(w, 'tyres-pit', { limiter: true });
  check('a pit stop restores the tyres (a new medium set: wear 0, grip 1 / 1 / 1)', v && v.after.tyres.compound === 'M' && Math.max.apply(null, v.after.tyres.wear) < 1e-6 &&
    v.after.tyres.grip.lat === 1 && v.after.tyres.grip.brake === 1 && v.after.tyres.grip.traction === 1, v && v.after.tyres);
  await w.frames(10);
  await w.shot('tyres-2-after-stop', true);
  check('the lap with the stop counted for the session (race lap 3 recorded, slower than the flying lap)', await w.pump(`g.gp.lap >= 3`, 200, 'lap 3') && (await w.js(`F1.game.lap.last`)) > laps[1].lap, await w.js(`F1.game.lap.last`));
  await w.noErrors();
  w.destroy();
}

/* ================= audio ================= */
async function partAudio() {
  part = 'audio';
  const w = makeWin('audio');
  await w.open('v6');
  await w.until(`F1.audio.debug.ready`, 5000, 'audio graph');
  const d0 = await w.js(`({ backend: F1.audio.debug.backend, ready: F1.audio.debug.ready, state: F1.audio.debug.context ? F1.audio.debug.context.state : null, vol: F1.audio.volume, muted: F1.audio.muted, active: F1.audio.active, errors: F1.audio.debug.errors })`);
  check('boot: F1.audio initialised without a gesture, worklet back end, the saved volume (0.8), not active in the menu', d0.backend === 'worklet' && d0.ready && d0.vol === 0.8 && !d0.muted && !d0.active && d0.errors === 0, d0);
  await w.pickTrack('it-1922');
  await sleep(600);
  const d1 = await w.js(`({ active: F1.audio.active, state: F1.audio.debug.context.state, frames: F1.audio.debug.frames, engine: { cyl: F1.audio.debug.engine.cyl } })`);
  check('driving: active, the context running, update() called every frame', d1.active && d1.state === 'running' && d1.frames > 20, d1);
  const up0 = await w.js(`F1.audio.debug.upshifts`);
  w.key('W', true);
  const samples = [];
  for (let k = 0; k < 24; k++) { await sleep(150); samples.push(await w.js(`[F1.audio.debug.rpm, F1.game.car.state.rpm, F1.game.car.state.gear, F1.audio.debug.gear, F1.game.car.state.speed]`)); }
  w.key('W', false);
  const up1 = await w.js(`F1.audio.debug.upshifts`);
  const off = samples.filter(s => Math.abs(s[0] - s[1]) > 0.03 * s[1]);
  console.log('audio rpm vs car rpm: ' + J(samples.map(s => [Math.round(s[0]), Math.round(s[1]), s[2], s[3]])));
  check('the own engine follows car.state.rpm (within 3 % in ' + (samples.length - off.length) + ' / ' + samples.length + ' samples) and its gear', off.length <= 2 && samples.filter(s => s[2] === s[3]).length >= samples.length - 2, off);
  const gEnd = samples[samples.length - 1][2];
  check('gear changes counted: ' + (up1 - up0) + ' upshifts heard for the car going 1 -> ' + gEnd, up1 - up0 >= 2 && up1 - up0 === gEnd - 1, { up0, up1, gEnd });
  // start lights: a beep for every lamp, one at lights out
  await w.tap('Escape');
  await w.click('gp-start');
  await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000, 'quali');
  const s0 = await w.js(`__v.sounds.length`), b0 = await w.js(`F1.audio.debug.beeps`);
  await w.js(`F1.game.gp.action('skip')`);
  const raced = await w.until(`F1.game.gp.phase === 'race' && !F1.game.gp.goFlash`, 16000, 'race');
  const beeps = await w.js(`__v.soundsSince(${s0}).filter(function (k) { return /^beep/.test(k); })`), b1 = await w.js(`F1.audio.debug.beeps`);
  check('start lights: beep(light) x 5 as the lamps come on, beep(go) at lights out (F1.audio.debug.beeps +6)', raced && J(beeps) === J(['beep:light', 'beep:light', 'beep:light', 'beep:light', 'beep:light', 'beep:go']) && b1 - b0 === 6,
    { beeps, debug: b1 - b0 });
  await w.js(`F1.game.gp.action('end'); F1.game.gp.action('end'); true`);
  // M
  await w.tap('M');
  const m1 = await w.js(`({ muted: F1.audio.muted, box: document.getElementById('set-mute').checked, stored: localStorage.getItem('f1drive.audio'), toast: __t.text('hud-toast') })`);
  await w.tap('M');
  const m2 = await w.js(`({ muted: F1.audio.muted, box: document.getElementById('set-mute').checked })`);
  check('M mutes (the 設定 switch follows, remembered, toast) and M again unmutes', m1.muted && m1.box && /"muted":true/.test(m1.stored) && /靜音/.test(m1.toast) && !m2.muted && !m2.box, { m1, m2 });
  // the volume slider
  await w.tap('Escape');
  await w.click('#tab-set');
  await w.js(`(function () { var e = document.getElementById('set-volume'); e.value = '30'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await w.click('set-mute');
  const v = await w.js(`({ vol: F1.audio.volume, muted: F1.audio.muted, stored: localStorage.getItem('f1drive.audio'), label: __t.text('set-volume-val') })`);
  check('設定: the volume slider (30 %) and the mute switch reach F1.audio, remembered', v.vol === 0.3 && v.muted && v.stored === '{"volume":0.3,"muted":true}' && v.label === '30%', v);
  await w.shot('audio-1-settings');
  await w.click('set-mute');
  await w.noErrors();
  w.destroy();
}

/* ================= room ================= */
async function partRoom() {
  part = 'room';
  const A = makeWin('A'), B = makeWin('B');
  await A.open('v6'); await B.open('v6');
  const pwSupported = await A.js(`F1.net.create.length >= 2 && F1.net.join.length >= 2`);
  console.log('room password supported by js/net.js: ' + pwSupported);
  await A.field('mp-name', 'Alice'); await A.field('mp-port', String(PORT));
  await B.field('mp-name', 'Bob'); await B.field('mp-addr', '127.0.0.1:' + PORT);
  await B.js(`document.querySelectorAll('.mp-swatch')[2].click(); true`);
  if (pwSupported) {
    await A.field('mp-create-pass', 'pit-wall');
    await A.js(`document.getElementById('mp-create').click()`);
    check('A hosts a room with a password', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.js(`__t.text('mp-status')`));
    await B.field('mp-join-pass', 'wrong');
    await B.js(`document.getElementById('mp-join').click()`);
    const refused = await B.until(`!F1.net.connected && !F1.net.connecting && /密碼/.test(__t.text('mp-status'))`, 8000, 'wrong password refused');
    check('B with a wrong password is refused (the status says so)', refused && !(await B.js(`F1.net.connected`)), await B.js(`__t.text('mp-status')`));
    await B.field('mp-join-pass', 'pit-wall');
  } else {
    await A.field('mp-create-pass', 'pit-wall');
    await A.js(`document.getElementById('mp-create').click()`);
    await sleep(300);
    check('js/net.js without passwords: a room is NOT opened with a password typed in (told to clear it)', !(await A.js(`F1.net.connected || F1.net.connecting`)) && /不支援房間密碼/.test(await A.js(`__t.text('mp-status')`)), await A.js(`__t.text('mp-status')`));
    await A.field('mp-create-pass', '');
    await A.js(`document.getElementById('mp-create').click()`);
    check('A hosts', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.js(`__t.text('mp-status')`));
  }
  await B.js(`document.getElementById('mp-join').click()`);
  check('B joins', await B.until(`F1.net.connected && !F1.net.isHost`, 6000), await B.js(`__t.text('mp-status')`));
  check('the room has the host\'s season (2025, its pick) and both drive 2025 cars', await A.until(`F1.net.year === 2025`, 3000) && await B.until(`F1.net.year === 2025 && F1.game.spec.year === 2025`, 3000));
  // the host picks 2014
  const y = await A.pickYear(2014);
  const followed = await A.until(`F1.net.year === 2014 && F1.game.spec.year === 2014`, 4000, 'A 2014') && await B.until(`F1.net.year === 2014 && F1.game.spec.year === 2014`, 4000, 'B 2014');
  const bt = await B.js(`__v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /2014/.test(t); })`);
  check('the host picks 2014 (年份): the room follows, the guest is told and drives a 2014 car', y === '2014' && followed && bt.length >= 1 && /房間是 2014 賽季：你的車換成/.test(bt[0]), { y, toast: bt, b: await B.js(`F1.game.spec.id`) });
  await B.click('#tab-car');
  const gl = await B.js(`({ yearDisabled: document.getElementById('car-year').disabled, year: document.getElementById('car-year').value, lock: __t.text('car-lock'), cards: document.querySelectorAll('#car-list .car-card').length, locked: document.getElementById('car-list').classList.contains('locked') })`);
  check('guest: 年份 locked on 2014 (房主選), the 2014 cars selectable', gl.yearDisabled && gl.year === '2014' && /年份由房主選擇/.test(gl.lock) && gl.cards >= 12 && !gl.locked, gl);
  check('A picks the 2014 Mercedes, B the 2014 Red Bull (cards clicked)', await A.pickCar('2014-mercedes') && await B.pickCar('2014-red-bull'));
  const ids = { a: await A.js(`F1.net.id`), b: await B.js(`F1.net.id`) };
  check('the roster carries the cars (each sees the other\'s)', await A.until(`F1.net.players.length === 1 && F1.net.players[0].car === '2014-red-bull'`, 3000) &&
    await B.until(`F1.net.players.length === 1 && F1.net.players[0].car === '2014-mercedes'`, 3000), { a: await A.js(`F1.net.players.map(function (p) { return p.car; })`), b: await B.js(`F1.net.players.map(function (p) { return p.car; })`) });
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`;
  await A.pickTrack('it-1922');
  check('both load the room track', await A.until(onTrack, 15000) && await B.until(onTrack, 15000));
  await sleep(1200);
  const rc = { a: await A.js(`(function () { var r = F1.game.remoteCars[${ids.b}]; return r && r.spec ? r.spec.id : null; })()`), b: await B.js(`(function () { var r = F1.game.remoteCars[${ids.a}]; return r && r.spec ? r.spec.id : null; })()`) };
  check('remote cars: each resolves the other\'s car (livery and engine from F1.cars)', rc.a === '2014-red-bull' && rc.b === '2014-mercedes', rc);
  // B 12 m behind A: B sees the Mercedes livery; A's engine is a voice in B's sound
  const put = (w, other, back) => w.js(`(function () { var s = F1.game.car.state, o = F1.net.players[0].state; s.x = o.x - Math.sin(o.heading) * ${back}; s.z = o.z - Math.cos(o.heading) * ${back}; s.heading = o.heading; s.speed = 0; s.steer = 0; return true; })()`);
  await put(B, A, 12);
  await sleep(1500);
  const voice = await B.js(`(function () { var d = F1.audio.debug, i = [].indexOf.call(d.voiceId, ${ids.a}); return { voices: d.voices, idx: i, dist: i >= 0 ? d.voiceDist[i] : null, rpm: i >= 0 ? d.voiceRpm[i] : null, state: i >= 0 ? d.voiceState[i] : null }; })()`);
  check('B hears A: a remote engine voice for A\'s car, ~12 m away', voice.voices >= 1 && voice.idx >= 0 && voice.dist > 8 && voice.dist < 16 && voice.rpm > 0, voice);
  await B.shot('room-1-guest-sees-host-mercedes');
  await put(A, B, 12);
  await sleep(1500);
  await A.shot('room-2-host-sees-guest-redbull');
  check('liveries on each other\'s car: screenshots room-1 (silver Mercedes ahead of B) / room-2 (dark blue Red Bull ahead of A) (READ them)', true);
  // a Grand Prix with wear x3
  await A.tap('Escape');
  await A.click('#tab-gp');
  await A.field('gp-q', '1'); await A.field('gp-r', '1');
  await A.click('#gp-wear button[data-w="3"]');
  await A.click('gp-start');
  check('the host starts a Grand Prix with 輪胎損耗 ×3: both in qualifying', await A.until(`F1.game.gp.phase === 'quali'`, 3000) && await B.until(`F1.game.gp.phase === 'quali'`, 3000));
  await sleep(600);
  const gv = async w => w.js(`({ year: __t.text('hud-gp-year'), vYear: F1.game.gp.view().year, wear: F1.game.gp.view().wear, rate: F1.game.tyres.wearRate, spec: F1.game.spec.id,
    chips: [].map.call(document.querySelectorAll('#hud-gp-rows .gp-row'), function (r) { var c = r.querySelector('.gp-chip'); return [r.querySelector('.mp-pname').textContent, c ? c.style.background : null]; }),
    teams: [].map.call(document.querySelectorAll('#gp-standings .gp-row'), function (r) { var t = r.querySelector('.gp-team'); return [r.querySelector('.mp-pname').textContent, t ? t.textContent : null]; }) })`);
  const ga = await gv(A), gb = await gv(B);
  console.log('grand prix views: ' + J({ ga, gb }));
  check('the session shows its year (2014) in the HUD box; wear x3 in the session, qualifying tyres at x1 (the option is for the race only)', ga.year === '2014' && gb.year === '2014' && ga.vYear === 2014 && ga.wear === 3 && gb.wear === 3 && ga.rate === 1 && gb.rate === 1, { ga, gb });
  check('standings: every row has the livery chip of its car (HUD box) and the team name (menu panel)', ga.chips.length === 2 && ga.chips.every(r => !!r[1]) && gb.teams.length === 2 &&
    gb.teams.some(r => r[0] === 'Alice' && r[1] === '賓士') && gb.teams.some(r => r[0] === 'Bob' && r[1] === '紅牛'), { chips: ga.chips, teams: gb.teams });
  await A.shot('room-3-host-quali-2014');
  await B.tap('Escape');
  await B.click('#tab-car');
  const pf = await B.js(`({ locked: document.getElementById('car-list').classList.contains('locked'), yearDisabled: document.getElementById('car-year').disabled, lock: __t.text('car-lock') })`);
  await B.click('#car-list .car-card[data-id="2014-ferrari"]');
  await sleep(200);
  const pf2 = await B.js(`({ spec: F1.game.spec.id, on: (document.querySelector('#car-list .car-card.on') || { getAttribute: function () { return null; } }).getAttribute('data-id'), profile: F1.net.getProfile().car })`);
  check('parc fermé: the guest\'s car list is locked (賽事進行中不能換車); a click on another car changes nothing', pf.locked && pf.yearDisabled && /賽事進行中不能換車/.test(pf.lock) && pf2.spec === '2014-red-bull' && pf2.on === '2014-red-bull', { pf, pf2 });
  await B.shot('room-4-guest-parc-ferme');
  await B.tap('Escape');
  await A.js(`F1.game.gp.action('end'); F1.game.gp.action('end'); true`);
  check('Grand Prix ended: both in free practice, the car picker open again', await A.until(`F1.game.gp.phase === 'free'`, 3000) && await B.until(`F1.game.gp.phase === 'free' && !document.getElementById('car-list').classList.contains('locked')`, 3000));
  // pit lane: A stands in its box (slot 0), B drives from its own box (slot 1, upstream) through A
  await sleep(1500);
  const box = (w, slot) => w.js(`(function () { var b = F1.game.track.pit.boxes[${slot}], s = F1.game.car.state; s.x = b.x; s.z = b.z; s.heading = b.heading; s.speed = 0; s.steer = 0; return { x: b.x, z: b.z }; })()`);
  await box(A, 0); await box(B, 1);
  await sleep(1000);
  const ghostOf = (w, id) => w.js(`(function () { var m = F1.game.remoteModels[${id}], g = false; if (!m) return null; m.group.traverse(function (o) { if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.9) g = true; }); return g; })()`);
  const g1 = { aSeesB: await ghostOf(A, ids.b), bSeesA: await ghostOf(B, ids.a), aIn: await A.js(`F1.game.pit.state.inLane || F1.game.track.pit.paved(F1.game.car.state.sampleIndex, F1.game.car.state.d)`),
    bIn: await B.js(`F1.game.track.pit.paved(F1.game.car.state.sampleIndex, F1.game.car.state.d)`), phase: await A.js(`F1.game.gp.phase`) };
  check('free practice, both cars in the pit lane: ghosts to each other (translucent)', g1.aSeesB === true && g1.bSeesA === true && g1.aIn && g1.bIn && g1.phase === 'free', g1);
  const a0 = await A.js(`__v.car()`);
  await A.js(`window.__mh = 0; window.__mi = setInterval(function () { var h = F1.game.car.state.hit; if (h > window.__mh) window.__mh = h; }, 4); true`);
  await B.js(`window.__mh = 0; window.__md = 1e9; window.__mi = setInterval(function () { var s = F1.game.car.state, p = F1.net.players[0].state, d = Math.hypot(s.x - p.x, s.z - p.z); if (d < window.__md) window.__md = d; if (d < 7 && s.hit > window.__mh) window.__mh = s.hit; }, 4); true`);
  B.key('W', true); await sleep(1600); B.key('W', false);
  await sleep(400);
  const hA = await A.js(`(clearInterval(window.__mi), window.__mh)`), hB = await B.js(`(clearInterval(window.__mi), { hit: window.__mh, minDist: window.__md })`);
  const a1 = await A.js(`__v.car()`);
  check('B drives through A in the pit lane: no impact on either car, A not pushed', hB.minDist < 3 && hB.hit === 0 && hA === 0 && Math.hypot(a1.x - a0.x, a1.z - a0.z) < 0.01, { hA, hB, aMoved: Math.hypot(a1.x - a0.x, a1.z - a0.z) });
  await B.shot('room-5-pit-lane-ghost');
  await A.noErrors(); await B.noErrors();
  await A.js(`document.getElementById('mp-leave').click(); true`);
  await sleep(300);
  A.destroy(); B.destroy();
}

/* ================= controller ================= */
async function partPad() {
  part = 'pad';
  const w = makeWin('pad');
  await w.open('v6');
  await w.js(`__t.fakePad()`);
  const press = async i => { await w.js(`__btn(${i}, 1)`); await sleep(160); await w.js(`__btn(${i}, 0)`); await sleep(160); };
  await sleep(300);
  await w.pickTrack('it-1922');
  await sleep(300);
  await w.js(`__btn(7, 1); __btn(5, 1); window.__dep = 0; window.__di = setInterval(function () { var s = F1.game.car.state; if (s.deploy > window.__dep) window.__dep = s.deploy; }, 10); true`);
  await sleep(3500);
  const rb = await w.js(`({ dep: window.__dep, battery: F1.game.car.state.battery, boost: F1.gamepad.state.boost, v: F1.game.car.state.speed })`);
  await w.js(`__btn(5, 0); window.__dep = 0; true`);
  await sleep(500);
  const off = await w.js(`({ dep: F1.game.car.state.deploy, boost: F1.gamepad.state.boost })`);
  await w.js(`__btn(0, 1); window.__dep = 0; true`);
  await sleep(800);
  const bb = await w.js(`({ dep: window.__dep, boost: F1.gamepad.state.boost })`);
  await w.js(`__btn(0, 0); __btn(7, 0); __btn(6, 1); clearInterval(window.__di); true`);
  // (state.deploy = the share of the battery's power used: since 2026-10-01 the deploy adds to the engine's drive only up to
  // what the tyres transmit, so in these 3.5 s from a standstill it peaks near 0.43, full only above the traction cap's speed)
  check('RB held: the battery deploys (state.deploy > 0, battery drains); released: no deploy', rb.dep > 0.25 && rb.battery < 1 && rb.boost && off.dep === 0 && !off.boost, { rb, off });
  check('A held (v6.1: the battery button): deploys too', bb.dep > 0.5 && bb.boost, bb);
  await w.until(`Math.abs(F1.game.car.state.speed) < 1`, 6000); await w.js(`__btn(6, 0)`);
  const l0 = await w.js(`F1.game.limiter`);
  await press(4);
  const l1 = await w.js(`({ lim: F1.game.limiter, strip: __t.shown('hud-pit'), lim2: __t.text('hud-pit-lim'), hint: __t.shown('hud-pit-warn') })`);
  await w.shot('pad-1-limiter-on');
  await press(4);
  const l2 = await w.js(`({ lim: F1.game.limiter, strip: __t.shown('hud-pit') })`);
  check('LB toggles the pit limiter (the strip shows 限速器 開, hidden again when off)', l0 === false && l1.lim === true && l1.strip && /限速器 開/.test(l1.lim2) && l2.lim === false && !l2.strip, { l0, l1, l2 });
  await press(1);
  const b1 = await w.js(`({ lim: F1.game.limiter, strip: __t.shown('hud-pit'), lim2: __t.text('hud-pit-lim') })`);
  await press(1);
  const b2 = await w.js(`({ lim: F1.game.limiter, strip: __t.shown('hud-pit') })`);
  check('B (v6.1) toggles the pit limiter too', b1.lim === true && b1.strip && /限速器 開/.test(b1.lim2) && b2.lim === false && !b2.strip, { b1, b2 });
  const c0 = await w.js(`F1.game.nextCompound`);
  await press(2);
  const c1 = await w.js(`F1.game.nextCompound`);
  await press(2);
  const c2 = await w.js(`({ next: F1.game.nextCompound, hud: __v.hud.nextCompound })`);
  check('X (v6.1) picks the next compound (M -> H -> S), shown in the telemetry', c0 === 'M' && c1 === 'H' && c2.next === 'S' && c2.hud === 'S', { c0, c1, c2 });
  const hint = await w.js(`({ text: __t.text('hud-hint-pad'), keys: [].map.call(document.querySelectorAll('#hud-hint-pad kbd'), function (k) { return k.textContent; }), shown: __t.shown('hud-hint-pad') })`);
  check('controller hints (v6.1 layout) name A / RB 電池（按住）, B / LB 限速器, X 換胎配方, Y 重置, View 行車線, Start 選單 and V 後照鏡', hint.shown &&
    ['RT', 'LT', 'A', 'RB', 'B', 'LB', 'X', 'Y', 'View', 'Start', 'V'].every(k => hint.keys.indexOf(k) >= 0) && /A\s*\/\s*RB\s*電池（按住）/.test(hint.text) && /B\s*\/\s*LB\s*限速器/.test(hint.text) &&
    /X\s*換胎配方/.test(hint.text) && /Y\s*重置/.test(hint.text) && /View\s*行車線/.test(hint.text) && /Start\s*選單/.test(hint.text) && /V\s*後照鏡/.test(hint.text), hint);
  await w.noErrors();
  w.destroy();
}

app.on('window-all-closed', () => {});      // the parts open and close their own windows
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  host.register(ipcMain);
  const parts = { boot: partBoot, year: partYear, golden: partGolden, battery: partBattery, pit: partPit, monaco: partMonaco, tyres: partTyres, audio: partAudio, room: partRoom, pad: partPad };
  for (const name of Object.keys(parts)) {
    if (ONLY.length && ONLY.indexOf(name) < 0) continue;
    try { await parts[name](); } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '  FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  await host.stopServer();
  app.exit(bad.length ? 1 : 0);
});
