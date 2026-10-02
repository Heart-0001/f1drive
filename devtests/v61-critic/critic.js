// v6.1 critic: the v6.1 changes played like a player would (offscreen Electron windows, MUTED by
// devtests/electron-userdata.js, real keys / mouse, a fake controller, a real room): the first boot (2026), the HUD
// rear-view mirrors (設定 switch, V, overtaking / being overtaken in a room, the pit lane, the start lights, toasts, the
// results overlay, window sizes), the pad on A / B / X / Y / View / Start, the battery per car (2014 Mercedes against the
// 2015 McLaren-Honda, the 2011 HRT without KERS, the 2026 Aston Martin). Screenshots in devtests/v61-critic/out/ (READ
// them); NOTE lines say what was seen. Exit code 1 when a check fails.
//   npx electron devtests/v61-critic/critic.js
//   env ONLY=<parts> (boot,pad,ers,room,pit,gp; default all)   PORT=24890 (the room)
'use strict';
const { app, ipcMain } = require('electron');
const path = require('path');
require('../electron-userdata')(app, 'v61-critic');
const L = require('./lib');
const { sleep, J, results, state, check, note, makeWin, roomTrack, roomStart } = L;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const PORT = Number(process.env.PORT || 24890);

/* ================= first boot: 2026, the menu, the mirrors switch, V ================= */
async function partBoot() {
  state.part = 'boot';
  let w = makeWin('boot', { partition: 'v61-boot' });
  const err = await w.open({ fresh: true });
  check('a fresh install boots without the error overlay', !err, err);
  await w.shot('boot-01-menu');
  const m = await w.js(`({ year: document.getElementById('car-year').value, sel: (document.querySelector('#car-list .car-card.on') || {}).getAttribute ? document.querySelector('#car-list .car-card.on').getAttribute('data-id') : null,
    spec: F1.game.spec.id, keymap: __t.text('.keymap'), kb: __t.text('keys-kb'), pad: __t.text('keys-pad'), gpCar: __t.text('gp-car'), mirrors: __p.mirrors() })`);
  note('menu: ' + J(m));
  check('fresh install: the 2026 season and its standard car (menu and game agree)', m.year === '2026' && m.sel === '2026-standard' && m.spec === '2026-standard', m);
  check('the key map has the 後照鏡 column (V) and the pad row Y / View / B/LB / A/RB / X', /後照鏡/.test(m.keymap) && /V/.test(m.kb) && /Y/.test(m.pad) && /View/.test(m.pad) && /A\s*\/\s*RB/.test(m.pad) && /B\s*\/\s*LB/.test(m.pad), m.pad);
  check('mirrors on by default (setting, switch 開), nothing stored yet', m.mirrors.setting === true && m.mirrors.sw === true && m.mirrors.swText === '開' && m.mirrors.stored === null, m.mirrors);
  await w.click('#tab-car'); await w.shot('boot-02-car-tab');
  await w.click('#tab-set'); await w.shot('boot-03-settings');
  // first drive
  check('Monza picked with a mouse click', await w.pickTrack('it-1922'));
  await sleep(800);
  await w.shot('boot-04-standing');
  w.key('W', true); await sleep(3000);
  await w.shot('boot-05-driving');
  const d = await w.js(`({ m: __p.mirrors(), lay: __p.layout(), v: F1.game.car.state.speed * 3.6, hint: __t.text('hud-hint'), tel: __v.hud.team + ' ' + __v.hud.car })`);
  note('driving: ' + J({ v: d.v, tel: d.tel, hint: d.hint, m: d.m, over: d.lay.over }));
  check('driving: both mirrors drawn every frame into the two frames, no HUD box over another', d.m.inst && d.m.visible && d.m.passes > 60 && d.m.frames[0] && d.m.frames[1] && d.lay.over.length === 0, { m: d.m, over: d.lay.over });
  // V off / on while driving
  await w.tap('V'); await sleep(250);
  const v1 = await w.js(`({ m: __p.mirrors(), toast: __p.toast() })`);
  await w.shot('boot-06-V-off');
  await sleep(400);
  const p1 = await w.js(`F1.game.hudMirrors.info().passes`);
  await sleep(500);
  const p2 = await w.js(`F1.game.hudMirrors.info().passes`);
  check('V while driving: mirrors off (frames hidden, boxes back up to 18 px, no passes), toast 後照鏡：關（V）, remembered', !v1.m.game && !v1.m.visible && !v1.m.frames[0] && v1.m.noMirrors && v1.m.timingTop === 18 && p1 === p2 && v1.toast === '後照鏡：關（V）' && v1.m.stored === '{"mirrors":false}', { v1, p1, p2 });
  await w.tap('V'); await sleep(300);
  const v2 = await w.js(`({ m: __p.mirrors(), toast: __p.toast() })`);
  await w.shot('boot-07-V-on');
  check('V again: on (frames, passes, boxes under the mirrors), toast 後照鏡：開（V）', v2.m.game && v2.m.visible && v2.m.frames[0] && !v2.m.noMirrors && v2.m.timingTop > 100 && v2.toast === '後照鏡：開（V）' && v2.m.stored === '{"mirrors":true}', v2);
  // holding V (key repeat) does not flicker them
  w.key('V', true); await sleep(60);
  for (let i = 0; i < 6; i++) { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['isAutoRepeat'] }); await sleep(35); }
  w.key('V', false); await sleep(200);
  const v3 = await w.js(`__p.mirrors()`);
  check('V held down (auto-repeat): one toggle only', v3.game === false, v3);
  await w.tap('V'); await sleep(200);
  w.key('W', false);
  // 設定: the switch with the mouse
  await w.tap('Escape'); await sleep(300);
  await w.click('#tab-set');
  await w.click('set-mirrors'); await sleep(200);
  const s1 = await w.js(`__p.mirrors()`);
  await w.shot('boot-08-settings-off');
  await w.tap('Escape'); await sleep(600);
  const s2 = await w.js(`({ m: __p.mirrors(), running: F1.game.running, lay: __p.layout() })`);
  await w.shot('boot-09-resumed-no-mirrors');
  check('設定 → 後照鏡 off (mouse): switch 關, remembered; resumed: no mirrors, the timing box back at 18 px', s1.sw === false && s1.swText === '關' && s1.stored === '{"mirrors":false}' &&
    s2.running && !s2.m.visible && s2.m.noMirrors && s2.m.timingTop === 18, { s1, s2: s2.m });
  // a restart remembers it
  await w.noErrors('before the restart');
  w.destroy();
  w = makeWin('boot2', { partition: 'v61-boot' });
  await w.open({ fresh: true });
  const r1 = await w.js(`__p.mirrors()`);
  check('after a restart: the switch is still 關 (and the year still 2026)', r1.setting === false && r1.sw === false && r1.swText === '關' && (await w.js(`document.getElementById('car-year').value`)) === '2026', r1);
  await w.click('#tab-set'); await w.click('set-mirrors');
  await w.shot('boot-10-settings-on-again');
  check('Monza again', await w.pickTrack('it-1922'));
  await sleep(600);
  const r2 = await w.js(`__p.mirrors()`);
  check('switched on again in 設定: mirrors drawn after the restart', r2.inst && r2.visible && r2.passes > 0 && !r2.noMirrors, r2);
  // V in the menu / in a text field does nothing
  await w.tap('Escape'); await sleep(200);
  await w.tap('V'); await sleep(150);
  await w.click('#tab-mp'); await w.click('mp-name');
  w.key('V', true); w.webContents.sendInputEvent({ type: 'char', keyCode: 'v' }); await sleep(40); w.key('V', false); await sleep(150);
  const r3 = await w.js(`({ m: __p.mirrors(), name: document.getElementById('mp-name').value })`);
  check('V in the menu and while typing a name: no toggle (the name gets the v)', r3.m.setting === true && /v$/i.test(r3.name), r3);
  await w.js(`document.activeElement && document.activeElement.blur(); true`);
  await w.noErrors();
  w.destroy();
}

/* ================= the pad: A / B / X / Y / View / Start (time warp, the fake controller of gp-e2e/solo-page.js) ================= */
// A driver on the controller only: the stick follows the centreline (as v6-smoke's __v.follow), RT / LT / A / RB as asked
// in window.__drv; it records what js/gamepad.js made of it.
const DRV = `(function () {
  var E = window.__e;
  if (!window.__apLine) window.__apLine = E.ap.step;
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  var D = window.__drv = { thr: 0, brk: 0, a: 0, rb: 0, follow: true, steer: 0,
    log: { frames: 0, boost: 0, deployMax: 0, deploySum: 0, steerMax: 0, dMax: 0, grass: 0, hits: 0 } };
  E.ap.step = function () {
    var g = F1.game, st = g.car.state, track = g.track, S = track.samples, N = S.length, ds = track.length / N, v = Math.max(0, st.speed);
    var b = E.pad.buttons, steer = D.steer;
    if (D.follow) {
      var la = clamp(8 + 0.5 * v, 10, 40), s = S[(st.sampleIndex + Math.round(la / ds)) % N];
      var gx = s.x - st.x, gz = s.z - st.z, sh = Math.sin(st.heading), ch = Math.cos(st.heading);
      var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh, kap = 2 * yl / (xf * xf + yl * yl);
      var P = g.car.perf || F1.CAR_PERF, lock = P.steerLock / (1 + (v / P.steerSpeedRef) * (v / P.steerSpeedRef));
      steer = clamp(Math.atan(kap * P.wheelbase) / lock, -1, 1);
    }
    var t = D.thr > 0 ? (D.thr >= 1 ? 1 : 0.04 + 0.96 * D.thr) : 0, k = D.brk > 0 ? (D.brk >= 1 ? 1 : 0.04 + 0.96 * D.brk) : 0;
    b[7].value = t; b[7].pressed = t > 0.5; b[6].value = k; b[6].pressed = k > 0.5;
    b[0].value = D.a ? 1 : 0; b[0].pressed = !!D.a; b[5].value = D.rb ? 1 : 0; b[5].pressed = !!D.rb;
    E.pad.axes[0] = Math.abs(steer) < 1e-4 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
    E.pad.axes[1] = 0;
    // what the game made of the previous frame's input
    var L = D.log, ps = F1.gamepad.state;
    L.frames++; if (ps.boost) L.boost++;
    if (st.deploy > L.deployMax) L.deployMax = st.deploy; L.deploySum += st.deploy;
    if (Math.abs(ps.steer) > L.steerMax) L.steerMax = Math.abs(ps.steer);
    if (Math.abs(st.d) > L.dMax) L.dMax = Math.abs(st.d);
    if (st.onGrass) L.grass++; if (st.hit > 0) L.hits++;
  };
  E.ap.on = true;
  return true;
})()`;
const drv = (w, o) => w.js(`(function () { var D = window.__drv; Object.assign(D, ${J(o)}); if (${J(!!(o && o.resetLog))}) D.log = { frames: 0, boost: 0, deployMax: 0, deploySum: 0, steerMax: 0, dMax: 0, grass: 0, hits: 0 }; return true; })()`);
const carNow = `({ v: F1.game.car.state.speed * 3.6, battery: F1.game.car.state.battery, deploy: F1.game.car.state.deploy, d: F1.game.car.state.d, i: F1.game.car.state.sampleIndex,
  spec: F1.game.spec.id, boost: F1.gamepad.state.boost, limiter: F1.game.limiter, next: F1.game.nextCompound, log: window.__drv ? __drv.log : null })`;

async function partPad() {
  state.part = 'pad';
  const w = makeWin('pad');
  await w.open({ fresh: true, warp: true });
  check('Monza (fresh install: the 2026 standard car), a controller connected', await w.pickTrackWarp('it-1922') && (await w.js(`F1.gamepad.state.connected && F1.game.spec.id`)) === '2026-standard');
  const hint = await w.js(`({ pad: __t.shown('hud-hint-pad') ? __t.text('hud-hint-pad') : '', keys: __t.shown('hud-hint-keys'), status: __t.shown('pad-status') })`);
  note('pad hint: ' + J(hint));
  check('with a pad the HUD hint is the pad\'s: A/RB 電池（按住）, B/LB 限速器, X 換胎配方, Y 重置, View 行車線, Start 選單', !hint.keys &&
    /A\s*\/\s*RB\s*電池（按住）/.test(hint.pad) && /B\s*\/\s*LB\s*限速器/.test(hint.pad) && /X\s*換胎配方/.test(hint.pad) && /Y\s*重置/.test(hint.pad) && /View\s*行車線/.test(hint.pad) && /Start\s*選單/.test(hint.pad), hint);
  await w.shot('pad-01-standing-hint', true);
  await w.js(DRV);
  // 1. full throttle 6 s from the start, no battery; 2. the same with A held (steering on the stick all the time)
  await drv(w, { thr: 1, a: 0, resetLog: true });
  await w.frames(360);
  const r1 = await w.js(carNow);
  await w.tap('Escape'); await w.until(`!F1.game.running`, 2000, 'menu');
  await w.pickTrackWarp('it-1922');
  await drv(w, { thr: 1, a: 1, resetLog: true });
  await w.frames(360);
  const r2 = await w.js(carNow);
  await w.shot('pad-02-A-held-steering', true);
  note('A: ' + J({ r1, r2 }));
  check('A held with RT and the stick: the battery deploys (boost every frame, deploy, store used), faster than without, the car still steered on the road',
    r2.log.boost >= r2.log.frames - 1 && r2.log.deployMax > 0.3 && r2.battery < 0.9 && r2.v > r1.v + 3 && r1.log.boost === 0 && r2.log.steerMax > 0.002 && r2.log.dMax < 4 && r2.log.grass === 0 && r2.log.hits === 0,
    { v: [r1.v, r2.v], battery: r2.battery, log: r2.log });
  // A under braking: nothing
  await drv(w, { thr: 0, brk: 1, a: 1 });
  await w.frames(3);                                     // (the log lags one frame: it sees the previous frame's state)
  await drv(w, { resetLog: true });
  await w.frames(60);
  const rb = await w.js(carNow);
  check('A held while braking: no deploy', rb.log.deployMax === 0, rb.log);
  // RB does the same as A
  await drv(w, { thr: 1, brk: 0, a: 0, rb: 1, resetLog: true });
  await w.frames(90);
  const rr = await w.js(carNow);
  check('RB held: the battery too', rr.log.boost >= rr.log.frames - 1 && rr.log.deployMax > 0.3, rr.log);
  await drv(w, { thr: 0.25, rb: 0, a: 0 });
  // B: limiter
  const s0 = await w.js(`__v.sounds.length`);
  await w.button(1, 3, true);
  const b1 = await w.js(`({ lim: F1.game.limiter, tel: __v.hud.limiter, sounds: __v.soundsSince(${s0}) })`);
  await w.shot('pad-03-B-limiter-on', true);
  await w.button(1, 3, true);
  const b2 = await w.js(`F1.game.limiter`);
  check('B: limiter on (telemetry limiter, sound limiterOn), B again: off', b1.lim === true && b1.tel === true && b1.sounds.indexOf('play:limiterOn') >= 0 && b2 === false, { b1, b2 });
  // B held, LB pressed too, both released: one toggle (the two buttons are one function)
  await w.js(`__e.pad.buttons[1].value = 1; __e.pad.buttons[1].pressed = true; true`); await w.frames(3);
  await w.js(`__e.pad.buttons[4].value = 1; __e.pad.buttons[4].pressed = true; true`); await w.frames(3);
  await w.js(`__e.pad.buttons[1].value = 0; __e.pad.buttons[1].pressed = false; true`); await w.frames(3);
  await w.js(`__e.pad.buttons[4].value = 0; __e.pad.buttons[4].pressed = false; true`); await w.frames(3);
  const b3 = await w.js(`F1.game.limiter`);
  await w.button(4, 3, true);
  const b4 = await w.js(`F1.game.limiter`);
  check('B held + LB pressed: one toggle (on); LB alone: off again', b3 === true && b4 === false, { b3, b4 });
  // X: next compound
  const t0 = await w.js(`__v.toasts.length`);
  await w.button(2, 3, true);
  const x1 = await w.js(`({ next: F1.game.nextCompound, toast: __p.toast(), tel: __v.hud.nextCompound })`);
  await w.shot('pad-04-X-compound', true);
  await w.button(2, 3, true); await w.button(2, 3, true);
  const x2 = await w.js(`({ next: F1.game.nextCompound, toasts: __v.toastsSince(${t0}) })`);
  note('X: ' + J({ x1, x2 }));
  check('X: next compound M -> H (toast, telemetry 下一組), X X: S, M', x1.next === 'H' && /硬胎/.test(x1.toast) && x1.tel === 'H' && x2.next === 'M' && x2.toasts.length === 3, { x1, x2 });
  // Y: reset (off the centre at speed first)
  await drv(w, { thr: 0.6, follow: false, steer: 0.25 });
  await w.frames(50);
  await drv(w, { thr: 0, steer: 0 });
  const y0 = await w.js(carNow);
  await w.button(3, 2, true);
  const y1 = await w.js(carNow);
  check('Y: the car is put back on the centreline, stopped', Math.abs(y0.d) > 0.5 && y0.v > 20 && Math.abs(y1.d) < 0.3 && y1.v < 1, { before: [y0.d, y0.v], after: [y1.d, y1.v] });
  await drv(w, { follow: true });
  // View: racing line
  await w.button(8, 2, true);
  const l1 = await w.js(`F1.game.raceLine.group.visible`);
  await w.shot('pad-05-View-line-off', true);
  await w.button(8, 2, true);
  const l2 = await w.js(`F1.game.raceLine.group.visible`);
  check('View: racing line off, View again: on', l1 === false && l2 === true, { l1, l2 });
  // Start: menu; Start in the menu: back (polled on a timer while the loop stands)
  await w.button(9, 2, true);
  const m1 = await w.js(`({ running: F1.game.running, menu: __t.shown('menu') })`);
  await sleep(300);                                      // (the menu's 100 ms poll must see the button up first, as with a real thumb)
  await w.js(`__e.pad.buttons[9].value = 1; __e.pad.buttons[9].pressed = true; true`); await sleep(350);
  await w.js(`__e.pad.buttons[9].value = 0; __e.pad.buttons[9].pressed = false; true`); await sleep(250);
  const m2 = await w.js(`({ running: F1.game.running, menu: __t.shown('menu') })`);
  check('Start: the menu; Start again in the menu: driving again', m1.running === false && m1.menu && m2.running && !m2.menu, { m1, m2 });
  // the pit lane with a pad: the prompts name B
  await w.js(`__e.ap.step = window.__apLine; __e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.lap.started`, 90, 'timing');
  await w.pump(`(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - g.car.state.sampleIndex) % N + N) % N; return k * g.track.length / N < 400 && k * g.track.length / N > 360; })()`, 200, 'before the pit lane');
  const plan = await w.js(`__v.pitPlan({ vLane: 70 / 3.6 })`);
  check('the pit-lane driver starts', plan && plan.ok, plan);
  await w.pump(`F1.game.pit.state.inLane && F1.game.car.state.speed > 5`, 60, 'in the lane');
  await w.frames(20);
  const p1 = await w.js(`({ warn: __t.shown('hud-pit-warn') ? __t.text('hud-pit-warn') : '', strip: __t.text('hud-pit') })`);
  await w.shot('pad-06-lane-no-limiter', true);
  await w.button(1, 3, true);
  const p2 = await w.js(`({ lim: F1.game.limiter, strip: __t.text('hud-pit') })`);
  await w.pump(`!!F1.game.pit.state.service`, 60, 'service');
  await w.pump(`!F1.game.pit.state.service`, 30, 'service done');
  await w.pump(`!__v.plan.active`, 90, 'out of the lane');
  const p3 = await w.js(`__v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /已離開維修區/.test(t); })`);
  note('pit with a pad: ' + J({ p1, p2, p3 }));
  check('pit lane with a pad: 請開啟限速器（B）, B switches it on, the exit reminder says B', /請開啟限速器（B）/.test(p1.warn) && p2.lim === true && /限速器 開/.test(p2.strip) && p3.length === 1 && /按 B 關閉限速器/.test(p3[0]), { p1, p2, p3 });
  await w.noErrors();
  w.destroy();
}

/* ================= the battery per car (time warp, lock-step pairs: the same frames with and without E / A) ================= */
// From the start of Monza: W (or RT) for 3 s, then W + E (or A) for 6 s (a 2026 car with E reaches the first chicane
// at 330 km/h after about 7 s); the stick follows the centreline. trace = the speed every second of the second phase.
async function ersRun(tag, year, carId, how) {
  const w = makeWin(tag);
  await w.open({ warp: true });
  await w.pickYear(year); await w.pickCar(carId); await sleep(150);
  const card = await w.js(`(function () { var c = document.querySelector('#car-list .car-card[data-id="${carId}"]'); return c ? c.innerText.replace(/\\s+/g, ' ') : null; })()`);
  if (how === 'shot') await w.shot('ers-card-' + carId);
  const spec = await w.js(`F1.game.spec.id`);
  await w.pickTrackWarp('it-1922');
  await w.js(DRV);
  await drv(w, { thr: 1 });
  await w.frames(180);
  const v3 = await w.js(`F1.game.car.state.speed * 3.6`);
  if (how === 'E') { w.key('E', true); await w.until(`F1.game.boost`, 3000, 'E'); }
  if (how === 'A') await drv(w, { a: 1 });
  const r = await w.js(`(function () { var out = { maxDeploy: 0, sumDeploy: 0, minBattery: 1, emptyAt: -1, vmax: 0, frames: 0, dist: 0, trace: [] }, n = 0, s;
    while (n < 360) { var k = __e.run(1, '', 5000).n; if (!k) break; n += k; s = F1.game.car.state; out.dist += s.speed / 60; if (n % 60 === 0) out.trace.push(+(s.speed * 3.6).toFixed(1));
      if (s.deploy > out.maxDeploy) out.maxDeploy = s.deploy; out.sumDeploy += s.deploy; if (s.battery < out.minBattery) out.minBattery = s.battery;
      if (out.emptyAt < 0 && s.battery <= 0 && F1.game.spec.ers) out.emptyAt = n / 60; if (s.speed * 3.6 > out.vmax) out.vmax = s.speed * 3.6; }
    out.frames = n; out.v11 = s.speed * 3.6; out.hud = { battery: __v.hud.battery, deploy: __v.hud.deploy, team: __v.hud.team, car: __v.hud.car }; out.boostIn = F1.game.boost || F1.gamepad.state.boost; return out; })()`);
  if (how === 'E' || how === 'A') await w.shot('ers-drive-' + carId + '-' + how, true);
  w.key('E', false);
  const ers = await w.js(`F1.game.spec.ers`);
  await w.noErrors();
  w.destroy();
  return Object.assign({ spec, ers, v3, card }, r);
}
async function partErs() {
  state.part = 'ers';
  const out = {};
  const cars = [[2014, '2014-mercedes', 'E'], [2015, '2015-mclaren', 'E'], [2011, '2011-hrt', 'E'], [2011, '2011-hrt', 'A'], [2011, '2011-red-bull', 'E'],
    [2026, '2026-aston-martin', 'E'], [2026, '2026-mercedes', 'E'], [2026, '2026-ferrari', 'E'], [2026, '2026-standard', 'A']];
  for (const c of cars) {
    const a = await ersRun('ers-' + c[1] + '-0', c[0], c[1], c[2] === 'E' && c[1] === '2011-hrt' ? 'shot' : ''), b = await ersRun('ers-' + c[1] + '-' + c[2], c[0], c[1], c[2]);
    const gain = b.vmax - a.vmax, dgain = b.dist - a.dist;
    out[c[1] + '/' + c[2]] = { gain, dgain, a, b };
    note(c[1] + ' (' + c[2] + '): ' + J({ ers: b.ers, vmax: [+a.vmax.toFixed(2), +b.vmax.toFixed(2)], gain: +gain.toFixed(2), metresAhead: +dgain.toFixed(2),
      traceNoE: a.trace, traceE: b.trace, minBattery: +b.minBattery.toFixed(3), emptyAt: b.emptyAt,
      maxDeploy: +b.maxDeploy.toFixed(3), meanDeploy: +(b.sumDeploy / b.frames).toFixed(3), hud: b.hud, card: b.card }));
    check(c[1] + ': the car is driven (' + a.spec + '), identical until ' + c[2], a.spec === c[1] && b.spec === c[1] && a.v3 === b.v3, { spec: [a.spec, b.spec], v3: [a.v3, b.v3] });
    if (c[1] === '2011-hrt') {
      check('2011 HRT (no KERS, ' + c[2] + '): no battery in the telemetry (null), ' + c[2] + ' deploys nothing, the same speed to the last digit; the card says 無 KERS, no 電池 bar',
        b.ers === null && b.hud.battery === null && b.maxDeploy === 0 && b.vmax === a.vmax && b.v11 === a.v11 && b.boostIn === true && /無 KERS/.test(b.card) && !/電池\s*\d/.test(b.card), { ers: b.ers, hud: b.hud, card: b.card, v: [a.vmax, b.vmax] });
    } else {
      check(c[1] + ' (' + c[2] + '): deploys, faster, the store drains', b.maxDeploy > 0.3 && gain > 1 && b.minBattery < 1, { gain, maxDeploy: b.maxDeploy, minBattery: b.minBattery });
    }
  }
  const g = k => out[k] ? out[k].gain : NaN;
  // the speed gained by the battery after s seconds of E (the 2026 deploy fades out from 290 to 345 km/h, the FIA rule:
  // by the end of Monza's straight every 2026 car with E is near that ceiling, so the battery's strength shows earlier)
  const gAt = (k, s) => out[k] ? out[k].b.trace[s - 1] - out[k].a.trace[s - 1] : NaN;
  check('2014 Mercedes gains more from its battery than the 2015 McLaren-Honda on the same straight (top speed, metres ahead)', g('2014-mercedes/E') > g('2015-mclaren/E') + 0.5 &&
    out['2014-mercedes/E'].dgain > out['2015-mclaren/E'].dgain + 1, { merc14: [g('2014-mercedes/E'), out['2014-mercedes/E'].dgain], mcl15: [g('2015-mclaren/E'), out['2015-mclaren/E'].dgain] });
  const g26 = ['2026-aston-martin/E', '2026-mercedes/E', '2026-ferrari/E', '2026-standard/A'].map(k => [k, +gAt(k, 2).toFixed(2), +gAt(k, 3).toFixed(2), +out[k].dgain.toFixed(2), +g(k).toFixed(2)]);
  note('2026 battery gain [car, km/h after 2 s of E, after 3 s, metres ahead after 6 s, top speed]: ' + J(g26));
  check('2026: the battery of the Aston Martin is the weakest (least speed gained after 2 and 3 s of E, fewest metres gained)',
    g26.slice(1).every(r => r[1] > g26[0][1] + 1 && r[2] > g26[0][2] + 1 && r[3] > g26[0][3]), g26);
  // the cards of the seasons
  const w = makeWin('ers-cards');
  await w.open();
  for (const y of [2011, 2014, 2015, 2026]) {
    await w.pickYear(y); await sleep(200);
    await w.js(`document.querySelector('#car-list').scrollTop = 0; true`);
    await w.shot('ers-cards-' + y);
    const t = await w.js(`Array.prototype.map.call(document.querySelectorAll('#car-list .car-card'), function (c) { var n = c.querySelector('.car-noers'), e = c.querySelector('.car-ers'); return c.getAttribute('data-id') + (n ? ' [' + n.textContent + ']' : '') + (e ? ' | ' + e.textContent : ''); })`);
    note(y + ' cards: ' + J(t));
  }
  // the 2011 list scrolled to its end (the three no-KERS cars)
  await w.pickYear(2011); await sleep(200);
  await w.js(`(function () { var c = document.querySelector('#car-list .car-card[data-id="2011-hrt"]'); c.scrollIntoView({ block: 'center' }); return true; })()`);
  await w.shot('ers-cards-2011-hrt');
  await w.noErrors();
  w.destroy();
}

/* ================= a room: overtaking and being overtaken, seen in the HUD mirrors (real time) ================= */
// A (host, grid slot 0) and B (slot 1, 8 m behind in the other column) leave the grid together with the limiter on (80
// km/h, W held); then B switches it off and pulls past A on a third of the throttle (fake pad RT). A's screen is captured
// every 250 ms: where B is relative to A at each capture (metres ahead / to the left of A's car) is printed.
const rel = `(function () { var me = F1.game.car.state, o = F1.net.players.filter(function (p) { return p.active; })[0]; if (!o) return null;
  var dx = o.state.x - me.x, dz = o.state.z - me.z, s = Math.sin(me.heading), c = Math.cos(me.heading);
  return { ahead: +(dx * s + dz * c).toFixed(1), left: +(dx * c - dz * s).toFixed(1), v: +(me.speed * 3.6).toFixed(0), vo: +(o.state.speed * 3.6).toFixed(0) }; })()`;
// In a real-time window: hold the car at lateral offset dT (m, as car.state.d) with the fake pad's stick, throttle thr on RT
// (a pure-pursuit loop on a 16 ms timer: the room cannot be time-warped).
const KEEP = `(function () {
  window.__keep = function (dT, thr) {
    clearInterval(window.__keepT);
    window.__keepT = setInterval(function () {
      var g = F1.game, st = g.car.state, track = g.track; if (!track || !g.running) return;
      var S = track.samples, N = S.length, ds = track.length / N, v = Math.max(0, st.speed);
      var la = Math.max(12, Math.min(40, 8 + 0.6 * v)), s = S[(st.sampleIndex + Math.round(la / ds)) % N];
      var tx = s.x + s.nx * dT, tz = s.z + s.nz * dT, gx = tx - st.x, gz = tz - st.z, sh = Math.sin(st.heading), ch = Math.cos(st.heading);
      var xf = gx * sh + gz * ch, yl = gx * ch - gz * sh, kap = 2 * yl / (xf * xf + yl * yl);
      var P = g.car.perf || F1.CAR_PERF, lock = P.steerLock / (1 + (v / P.steerSpeedRef) * (v / P.steerSpeedRef));
      var steer = Math.max(-1, Math.min(1, Math.atan(kap * P.wheelbase) / lock));
      window.__pad.axes[0] = Math.abs(steer) < 1e-4 ? 0 : -(steer > 0 ? 1 : -1) * (0.12 + 0.88 * Math.pow(Math.min(1, Math.abs(steer)), 1 / 1.6));
      var b = window.__pad.buttons[7]; b.value = thr; b.pressed = thr > 0.5;
    }, 16);
    return true;
  };
  return true;
})()`;
async function partRoom() {
  state.part = 'room';
  const A = makeWin('A'), B = makeWin('B');
  for (const w of [A, B]) { const e = await w.open({ fresh: true }); if (e) check(w.tag + ' boots', false, e); }
  await A.field('mp-name', 'Alice'); await A.field('mp-port', String(PORT));
  await B.field('mp-name', 'Bob'); await B.field('mp-addr', '127.0.0.1:' + PORT);
  await B.js(`document.querySelectorAll('.mp-swatch')[2].click(); true`);
  await A.click('#tab-mp'); await A.click('mp-create');
  check('A hosts a room', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.js(`__t.text('mp-status')`));
  await B.click('#tab-mp'); await B.click('mp-join');
  check('B joins', await B.until(`F1.net.connected`, 6000));
  await B.pickCar('2026-ferrari');
  // v7.2: the host sets the room's track in the lobby, B presses 準備, 開始: both load, the session after the barrier
  check('the host sets Monza in the lobby; 開始', await roomTrack(A, 'it-1922') && await roomStart(A, [B]));
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id && F1.net.room.st === 'session'`;
  check('both on Monza, on their grid slots', await A.until(onTrack, 15000) && await B.until(onTrack, 15000));
  for (const w of [A, B]) await w.js(`__t.fakePad(); ` + KEEP);
  await sleep(2500);
  const r0 = await A.js(rel);
  note('on the grid, B seen from A: ' + J(r0));
  await A.shot('room-01-A-grid-B-behind');
  await B.shot('room-02-B-grid');
  // off together at the limiter
  for (const w of [A, B]) { await w.tap('Q'); await w.js(`__keep(F1.game.car.state.d, 1)`); }
  await sleep(3500);
  const r1 = await A.js(rel);
  note('both at the limiter: ' + J(r1));
  await A.shot('room-03-A-cruise-B-behind');
  // B pulls past on a third of the throttle
  await B.tap('Q'); await B.js(`__keep(F1.game.car.state.d, 0.33)`);
  const seen = [];
  for (let k = 0; k < 28; k++) {
    const t0 = Date.now();
    const r = await A.js(rel), m = await A.js(`__p.mirrors()`);
    const img = await A.webContents.capturePage();
    const name = 'room-04-A-pass-' + String(k).padStart(2, '0');
    require('fs').writeFileSync(path.join(L.OUT, name + '.png'), img.toPNG());
    const bs = await B.js(`(function () { var s = F1.game.car.state, g = F1.gamepad.state; return [+s.d.toFixed(1), s.onGrass ? 'grass' : '', +s.throttle.toFixed(2), +s.brake.toFixed(2), +g.throttle.toFixed(2), s.hit > 0 ? 'hit' : '', F1.game.limiter ? 'lim' : '']; })()`);
    seen.push([k, r && r.ahead, r && r.left, r && r.vo, m.passes, bs]);
    if (r && r.ahead > 3 && r.ahead < 30 && k % 2 === 0) {         // B's own mirrors with A falling behind
      require('fs').writeFileSync(path.join(L.OUT, 'room-05-B-ahead-' + String(k).padStart(2, '0') + '.png'), (await B.webContents.capturePage()).toPNG());
    }
    await sleep(Math.max(0, 250 - (Date.now() - t0)));
  }
  note('A\'s captures during the pass [k, B ahead m, B left m, B km/h, passes]: ' + J(seen));
  const r2 = await B.js(rel);
  note('B ahead of A, A seen from B: ' + J(r2));
  await B.shot('room-06-B-ahead-A-far-behind');
  const hits = await A.js(`__v.hud && F1.game.car.state.hit`);
  for (const w of [A, B]) await w.js(`clearInterval(window.__keepT); window.__pad.buttons[7].value = 0; window.__pad.axes[0] = 0; true`);
  const passes = await A.js(`__p.mirrors()`);
  check('A: the mirrors drew all along (both every frame)', passes.visible && passes.passes > 600, passes);
  check('B came from behind A (in a mirror) to ahead of A, the two never touched', seen.some(s => s[1] < -5) && seen.some(s => s[1] > 5) && !hits, { first: seen[0], last: seen[seen.length - 1], hits });
  await A.noErrors(); await B.noErrors();
  await B.js(`F1.net.leave(); true`); await A.js(`F1.net.leave(); true`);
  await sleep(500);
  A.destroy(); B.destroy();
}

/* ================= the pit lane in the HUD mirrors (time warp) ================= */
// Share of the glass of each HUD mirror that shows a light curtain's colour (amber at the entry, green at the exit), from
// a capture of the window (device px = CSS px at DPR 1).
function tint(img, rects, kind) {
  const { width: W } = img.getSize(), bmp = img.toBitmap();          // BGRA
  return rects.map(q => {
    if (!q) return null;
    let n = 0, hit = 0;
    for (let y = Math.ceil(q[1] + 2); y < q[1] + q[3] - 2; y += 2) for (let x = Math.ceil(q[0] + 2); x < q[0] + q[2] - 2; x += 2) {
      const i = (y * W + x) * 4, b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      n++;
      if (kind === 'amber' ? (r > 150 && r > g + 30 && g > b + 30) : (g > 140 && g > r + 40 && g > b + 25)) hit++;
    }
    return n ? +(hit / n).toFixed(2) : null;
  });
}
async function partPit() {
  state.part = 'pit';
  const w = makeWin('pit');
  await w.open({ fresh: true, warp: true });
  check('Monza', await w.pickTrackWarp('it-1922'));
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.lap.started`, 90, 'timing');
  await w.pump(`(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - g.car.state.sampleIndex) % N + N) % N; return k * g.track.length / N < 400 && k * g.track.length / N > 360; })()`, 200, 'before the pit lane');
  await w.tap('Q');
  const plan = await w.js(`__v.pitPlan({ cruise: true })`);
  check('the pit-lane driver starts (limiter on)', plan && plan.ok && await w.js(`F1.game.limiter`), plan);
  const rects = (await w.js(`__p.mirrors()`)).rects;
  const series = async (tag, kind, cond) => {
    await w.pump(cond, 60, tag);
    const out = [];
    for (const t of [0, 0.5, 1, 1.5, 2, 3, 4]) {
      if (t) await w.frames(30);
      await w.js(`__e.draw()`);
      const img = await w.webContents.capturePage();
      const s = await w.js(`({ v: F1.game.car.state.speed * 3.6, svc: !!F1.game.pit.state.service, inLane: F1.game.pit.state.inLane })`);
      out.push([t, tint(img, rects, kind), Math.round(s.v), s.svc ? 'svc' : (s.inLane ? 'lane' : 'track')]);
      if (t === 0 || t === 1 || t === 2) require('fs').writeFileSync(path.join(L.OUT, 'pit-' + tag + '-' + t + 's.png'), img.toPNG());
    }
    return out;
  };
  const before = await series('a-before-entry', 'amber', `__v.plan.U >= __v.plan.uEn - Math.round(30 / (g.track.length / g.track.samples.length))`);
  const entry = await series('b-after-entry', 'amber', `F1.game.pit.state.inLane`);
  await w.pump(`!!F1.game.pit.state.service`, 60, 'service');
  await w.frames(30);
  await w.shot('pit-c-in-the-box', true);
  await w.pump(`!F1.game.pit.state.service`, 30, 'service done');
  const exit = await series('d-after-exit', 'green', `!F1.game.pit.state.inLane && __v.plan.U > __v.plan.uEx`);
  note('share of the HUD mirror glass [left, right] in the curtain colour, [s, tint, km/h, where]: ' + J({ before, entry, exit }));
  // (until 2026-10-01 the curtain just driven through filled both mirrors with amber / green for about a second: 0.5..0.65
  //  of the glass at the exit, where the car merges into the traffic; js/main.js now leaves the curtains out of the mirrors)
  const worst = Math.max(...entry.concat(exit, before.filter(r => r[3] === 'lane')).map(r => Math.max(r[1][0] || 0, r[1][1] || 0)));
  check('the light curtains just driven through do not fill the mirrors (entry and exit: under 10 % of the glass)', worst < 0.1, worst);
  await w.pump(`!__v.plan.active`, 90, 'out of the lane');
  await w.tap('Q');
  await w.noErrors();
  w.destroy();
}

/* ================= a solo Grand Prix: start lights, toasts and the results overlay with the mirrors, several sizes ================= */
const SIZES = [[1280, 720], [1920, 1080], [1100, 700], [1000, 700], [800, 600], [700, 520]];
async function layoutAt(w, tag, what) {
  const res = [];
  for (const [W, H] of SIZES) {
    await w.size(W, H);
    await w.frames(2);                                   // (the HUD canvases are redrawn by the frames after a resize)
    await w.js(`__e.draw()`); await sleep(120);
    const L2 = await w.js(`__p.layout()`), m = await w.js(`__p.mirrors()`);
    const name = tag + '-' + W + 'x' + H;
    require('fs').writeFileSync(path.join(L.OUT, name + '.png'), (await w.webContents.capturePage()).toPNG());
    const mirrorOver = L2.over.filter(o => /hud-mirror/.test(o));
    res.push({ size: W + 'x' + H, over: L2.over, off: L2.off, mirrorRects: m.rects, toast: await w.js(`__p.toast()`) });
    check(what + ' at ' + W + 'x' + H + ': nothing over the mirrors, both mirrors drawn in their frames', mirrorOver.length === 0 && m.frames[0] && m.frames[1] && m.rects[0] && m.rects[1], { over: L2.over, rects: m.rects });
  }
  note(what + ': ' + J(res));
  await w.size(1280, 720);
  return res;
}
async function partGp() {
  state.part = 'gp';
  const w = makeWin('gp');
  await w.open({ fresh: true, warp: true });
  check('Monza', await w.pickTrackWarp('it-1922'));
  await w.tap('Escape'); await w.until(`!F1.game.running`, 2000, 'menu');
  // (v7.2: the Grand Prix starts from the start panel: the loaded track's card, 大獎賽, 重新開始)
  await w.card('it-1922'); await w.mode('gp');
  await w.field('gp-q', '1'); await w.field('gp-r', '1');
  await w.go();
  check('the Grand Prix starts (qualifying)', await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 4000));
  await w.tap('Escape'); await w.until(`!F1.game.running`, 2000, 'menu');
  await w.click('#tab-gp'); await w.click('gp-skip');
  check('跳過排位: on the grid', await w.until(`F1.game.gp.phase === 'grid' && F1.game.running`, 4000));
  await w.pump(`g.gp.lights >= 3`, 30, 'three lights');
  await w.js(`F1.ui.toast('起跑位置 P1 / 1，燈號全滅就起跑', 60000); true`);   // (the grid toast, kept up for the captures)
  await layoutAt(w, 'gp-1-lights', 'start lights + toast');
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.gp.goFlash`, 30, 'lights out');
  await w.frames(20);
  await w.js(`__e.draw()`);
  await w.shot('gp-2-lights-out');
  check('the race: the flag after one lap, results', await w.pump(`g.gp.phase === 'results'`, 200, 'results'));
  await w.frames(30);
  await w.js(`F1.ui.toast('正賽結束：你是第 1 名（共 1 位車手）', 60000); true`);
  const res = await layoutAt(w, 'gp-3-results', 'results overlay + toast');
  // V with the results overlay open: off and on again
  await w.tap('V'); await w.js(`__e.draw()`);
  await w.shot('gp-4-results-V-off');
  const off = await w.js(`({ m: __p.mirrors(), lay: __p.layout() })`);
  await w.tap('V');
  check('V with the results overlay open: the mirrors go and come back, the overlay stays', !off.m.visible && off.lay.boxes.some(b => b.id === 'gp-results') && (await w.js(`__p.mirrors().visible`)), off.m);
  await w.noErrors();
  w.destroy();
}

const PARTS = { boot: partBoot, pad: partPad, ers: partErs, room: partRoom, pit: partPit, gp: partGp };

app.whenReady().then(async () => {
  const t0 = Date.now();
  L.host.register(ipcMain);
  try {
    for (const k of Object.keys(PARTS)) {
      if (ONLY.length && ONLY.indexOf(k) < 0) continue;
      console.log('=== ' + k);
      try { await PARTS[k](); } catch (e) { check('part ' + k + ' threw', false, String(e && e.stack || e)); }
    }
  } finally {
    const failed = results.filter(r => !r.ok);
    console.log('\n' + (results.length - failed.length) + ' / ' + results.length + ' checks passed in ' + Math.round((Date.now() - t0) / 1000) + ' s');
    for (const f of failed) console.log('FAILED: ' + f.name);
    try { await L.host.stopServer(); } catch (e) {}
    app.exit(failed.length ? 1 : 0);
  }
});
app.on('window-all-closed', () => {});
