// v6 critic: plays the REAL game like a player would (offscreen Electron, real keys / mouse, a fake controller, rooms
// with the real host IPC) and looks for what is wrong, confusing or broken. Screenshots in devtests/v6-critic/out/
// (READ them). Exit code 1 when a check fails.
//   npx electron devtests/v6-critic/critic.js
//   env ONLY=<parts> (default all; see PARTS at the end)   PORT=24870 (rooms; 24870..24879 are used)
'use strict';
const { app, ipcMain } = require('electron');
const fs = require('fs'), path = require('path');
require('../electron-userdata')(app, 'v6-critic');
const L = require('./lib');
const { OUT, host, sleep, J, results, state, check, note, makeWin, roomTrack, roomSettings, roomStart, roomBack } = L;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const PORT = Number(process.env.PORT || 24870);

/* ================= a new player: boot, menu, first drive ================= */
async function partNewbie() {
  state.part = 'newbie';
  const w = makeWin('newbie');
  const err = await w.open({ fresh: true });             // a new player: a fresh install (v6.1: the 2026 standard car)
  check('boots without the error overlay', !err, err);
  await w.shot('newbie-01-menu');
  const m = await w.js(`({ tab: document.querySelector('.menu-tabs button.on').getAttribute('data-tab'), grid: __t.rect('track-grid'), panel: __t.rect('mp-panel'),
    cards: document.querySelectorAll('#track-grid .card').length, firstCard: __t.rect('#track-grid .card'), body: __t.rect('.menu-body'),
    head: __t.rect('.menu-head'), keymap: __t.text('.keymap'), gpCar: __t.text('gp-car'), gpOpen: __t.shown('gp-open'),
    hint: __t.shown('gp-hint') ? __t.text('gp-hint') : '' })`);
  note('menu: ' + J(m));
  check('the track grid is visible next to the side panel (cards at least 150 px wide, not covered)', m.firstCard && m.firstCard.w >= 150 && m.grid.w > 300 && m.panel.x >= m.grid.x + m.grid.w - 2, m);
  check('the key map names Q / E / T / M / V', /限速器/.test(m.keymap) && /電池/.test(m.keymap) && /換胎配方/.test(m.keymap) && /靜音/.test(m.keymap) && /後照鏡/.test(m.keymap), m.keymap);
  for (const t of ['car', 'mp', 'set', 'gp']) { await w.click('#tab-' + t); await w.shot('newbie-02-tab-' + t); }
  const car = await w.js(`(function () { var c = document.querySelector('#car-list .car-card.on'); return { season: __t.text('car-season'), sel: c ? c.getAttribute('data-id') : null,
    selText: c ? c.innerText.replace(/\\s+/g, ' ') : '', year: document.getElementById('car-year').value }; })()`);
  note('car tab: ' + J(car));
  // first drive: Monza
  check('Monza picked with a mouse click', await w.pickTrack('it-1922'));
  await sleep(800);
  await w.shot('newbie-03-standing');
  const hint = await w.js(`({ keys: __t.text('hud-hint-keys'), shown: __t.shown('hud-hint-keys'), tel: __t.rect('hud-telemetry'), hintR: __t.rect('hud-hint'), toast: __t.shown('hud-toast') ? __t.text('hud-toast') : '' })`);
  note('HUD: ' + J(hint));
  check('the HUD hint names Q / E / T / M / V', hint.shown && /Q/.test(hint.keys) && /E/.test(hint.keys) && /T/.test(hint.keys) && /M/.test(hint.keys) && /V\s*後照鏡/.test(hint.keys), hint.keys);
  check('the hint does not overlap the telemetry graphic', hint.hintR && hint.tel && (hint.hintR.x >= hint.tel.x + hint.tel.w || hint.hintR.y + hint.hintR.h <= hint.tel.y), { hint: hint.hintR, tel: hint.tel });
  w.key('W', true); await sleep(2500);
  await w.shot('newbie-04-accelerating');
  w.key('E', true); await sleep(1200);
  await w.shot('newbie-05-boost');
  const b = await w.js(`({ deploy: F1.game.car.state.deploy, battery: F1.game.car.state.battery, v: F1.game.car.state.speed * 3.6, hud: __v.hud.deploy })`);
  w.key('E', false); w.key('W', false);
  check('E deploys while W is held', b.deploy > 0 && b.battery < 1, b);
  w.key('S', true); await sleep(1500); w.key('S', false);
  await w.shot('newbie-06-braking');
  await w.tap('Q'); await sleep(200);
  await w.shot('newbie-07-limiter-on');
  const q = await w.js(`({ lim: F1.game.limiter, strip: __t.text('hud-pit'), toast: __t.shown('hud-toast') ? __t.text('hud-toast') : '' })`);
  note('Q: ' + J(q));
  await w.tap('Q');
  await w.tap('T'); await sleep(200);
  const t = await w.js(`({ next: F1.game.nextCompound, toast: __t.text('hud-toast') })`);
  note('T: ' + J(t));
  await w.shot('newbie-08-next-compound');
  await w.tap('M'); await sleep(200);
  const mu = await w.js(`({ muted: F1.audio.muted, toast: __t.text('hud-toast') })`);
  await w.shot('newbie-09-muted');
  await w.tap('M');
  check('Q / T / M do what they say', q.lim === true && t.next === 'H' && mu.muted === true, { q, t, mu });
  await w.tap('Escape'); await sleep(300);
  await w.shot('newbie-10-menu-again');
  await w.noErrors();
  w.destroy();
  // other window sizes: the menu and the HUD
  for (const s of [[1024, 640], [1920, 1080], [800, 600]]) {
    const v = makeWin('size' + s[0], { w: s[0], h: s[1] });
    await v.open({ fresh: true });
    await v.shot('newbie-11-menu-' + s[0]);
    await v.click('#tab-car');
    await v.shot('newbie-12-car-' + s[0]);
    const r = await v.js(`({ grid: __t.rect('track-grid'), panel: __t.rect('mp-panel'), card: __t.rect('#track-grid .card'), scrollW: document.documentElement.scrollWidth, w: innerWidth })`);
    note(s[0] + 'x' + s[1] + ': ' + J(r));
    check(s[0] + 'x' + s[1] + ': no horizontal page scroll; the track grid still shows cards', r.scrollW <= r.w && r.card && r.card.w > 100 && r.card.h > 60, r);
    await v.pickTrack('it-1922');
    v.key('W', true); await sleep(1500); v.key('W', false);
    await v.shot('newbie-13-hud-' + s[0]);
    await v.noErrors();
    v.destroy();
  }
}

/* ================= battery: 2011 (KERS), 2014, 2026 ================= */
// Two runs per car in lock-step (time warp, the same frames): W for 4 s from the start of Monza, then W (+ E) for 8 s.
async function ersRun(tag, year, carId, boost) {
  const w = makeWin(tag);
  await w.open({ warp: true });
  await w.pickYear(year); await w.pickCar(carId); await sleep(150);
  const spec = await w.js(`F1.game.spec.id`);
  await w.pickTrackWarp('it-1922');
  w.key('W', true);
  await w.until(`F1.game.input.up`, 3000, 'W');
  const r = await w.js(`(function () { __v.follow(true); var out = { maxDeploy: 0, minBattery: 1, empty: -1, grass: 0 }, n = 0;
    while (n < 240) { n += __e.run(1, '', 5000).n; }
    out.v4 = F1.game.car.state.speed * 3.6; return out; })()`);
  if (boost) { w.key('E', true); await w.until(`F1.game.boost`, 3000, 'E'); }
  const r2 = await w.js(`(function () { var out = { maxDeploy: 0, minBattery: 1, emptyAt: -1, grass: 0 }, n = 0;
    while (n < 480) { var k = __e.run(1, '', 5000).n; if (!k) break; n += k; var s = F1.game.car.state;
      if (s.deploy > out.maxDeploy) out.maxDeploy = s.deploy; if (s.battery < out.minBattery) out.minBattery = s.battery;
      if (out.emptyAt < 0 && s.battery <= 0 && F1.game.spec.ers) out.emptyAt = n / 60; if (s.onGrass) out.grass++; if (s.speed * 3.6 > (out.vmax || 0)) out.vmax = s.speed * 3.6; }
    out.v12 = s.speed * 3.6; out.gear = s.gear; out.rpm = s.rpm; out.hud = { battery: __v.hud.battery, deploy: __v.hud.deploy, team: __v.hud.team, car: __v.hud.car }; return out; })()`);
  if (boost) await w.shot('ers-' + tag, true);
  w.key('E', false); w.key('W', false);
  const ers = await w.js(`F1.game.spec.ers`);
  const errs = await w.noErrors();
  w.destroy();
  return Object.assign({ spec, ers, v4: r.v4 }, r2);
}
async function partErs() {
  state.part = 'ers';
  for (const c of [[2011, '2011-red-bull'], [2014, '2014-mercedes'], [2026, '2026-mercedes'], [2025, '2025-standard']]) {
    const a = await ersRun('ers-' + c[0] + '-w', c[0], c[1], false), b = await ersRun('ers-' + c[0] + '-we', c[0], c[1], true);
    note(c[1] + ': ' + J({ ers: a.ers, noE: { v4: a.v4.toFixed(1), v12: a.v12.toFixed(1) }, E: { v4: b.v4.toFixed(1), v12: b.v12.toFixed(1), minBattery: b.minBattery.toFixed(3), emptyAt: b.emptyAt, maxDeploy: b.maxDeploy.toFixed(2) }, hud: b.hud, grass: [a.grass, b.grass] }));
    check(c[1] + ': the car of the season is driven (' + a.spec + ')', a.spec === c[1] && b.spec === c[1]);
    check(c[1] + ': identical until E, E deploys and gains speed (top speed before the chicane), the battery drains', a.v4 === b.v4 && b.maxDeploy > 0.3 && b.vmax > a.vmax + 1 && b.minBattery < 1 && a.minBattery === 1,
      { v4: [a.v4, b.v4], vmax: [a.vmax, b.vmax], minBattery: [a.minBattery, b.minBattery] });
  }
}

/* ================= pit lane: three tracks + what a player might do in the box ================= */
const PIT_BEFORE = 420;
const nearPit = m => `(function () { var p = g.track.pit, N = g.track.samples.length, k = ((p.from - g.car.state.sampleIndex) % N + N) % N, m = k * g.track.length / N;
  return g.lap.started && m < ${m} && m > ${m - 40}; })()`;
const svcState = `(function () { var p = F1.game.pit.state, s = F1.game.car.state; return { svc: p.service ? { left: p.service.left, total: p.service.total, penalty: p.service.penalty } : null,
  stops: p.stops, pending: p.pending, x: s.x, z: s.z, v: s.speed, gear: s.gear, lap: F1.game.lap.time, running: F1.game.running, tyres: F1.game.tyres.state.compound }; })()`;
// Into the pit lane with the pit driver of v6-smoke/page.js, stop in our box, out again. o = {limiter, vLane, onService(w), noExit, name}
async function pitVisit(w, name, o) {
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  if (!await w.pump(nearPit(PIT_BEFORE), 260, name + ': ' + PIT_BEFORE + ' m before the pit lane')) return null;
  if (o.limiter) { await w.tap('Q'); if (!await w.until(`F1.game.limiter === true`, 2000, 'Q')) return null; }
  const plan = await w.js(`__v.pitPlan(${J({ cruise: !!o.limiter, vLane: o.vLane || 0, vLaneOut: o.vLaneOut || 0 })})`);
  if (!plan || !plan.ok) { note('pitPlan ' + J(plan)); return null; }
  const out = { plan };
  await w.pump(`__v.plan.U >= __v.plan.uEn - 25`, 60, 'before the entry line');
  await w.shot(name + '-1-entry', true);
  if (o.onLane) { out.lane = await o.onLane(w); if (out.lane === 'stop') return out; }
  await w.pump(`F1.game.pit.state.inLane && F1.game.pit.state.boxAhead !== null && F1.game.pit.state.boxAhead < 40 && !F1.game.pit.state.service`, 60, 'box ahead');
  out.strip = await w.js(`({ box: __t.text('hud-pit-box'), limit: __t.text('hud-pit-limit'), lim: __t.text('hud-pit-lim'), warn: __t.shown('hud-pit-warn') ? __t.text('hud-pit-warn') : '',
    pending: __t.shown('hud-pit-pending') ? __t.text('hud-pit-pending') : '', shown: __t.shown('hud-pit'), speeding: F1.game.pit.state.speeding, pit: __v.pit })`);
  await w.shot(name + '-2-lane', true);
  out.svcStarted = await w.pump(`!!F1.game.pit.state.service`, 60, 'service');
  if (!out.svcStarted) return out;
  await w.frames(20);
  out.during = await w.js(svcState);
  out.strip2 = await w.js(`__t.text('hud-pit')`);
  await w.shot(name + '-3-service', true);
  if (o.onService) { out.svcTest = await o.onService(w); if (out.svcTest === 'stop') return out; }
  await w.pump(`!F1.game.pit.state.service`, 30, 'service done');
  out.after = await w.js(svcState);
  out.toasts = await w.js(`__v.toasts.slice(-4).map(function (t) { return t.text; })`);
  if (!o.noExit) await w.pump(`!__v.plan.active`, 90, name + ': out of the lane');
  if (o.limiter) { await w.tap('Q'); await w.until(`F1.game.limiter === false`, 2000, 'Q off'); }
  out.info = await w.js(`__v.planInfo()`);
  return out;
}

async function pitLasVegas() {
  const tag = 'pit-vegas', w = makeWin(tag);
  await w.open({ warp: true });
  check(tag + ': track loads', await w.pickTrackWarp('us-2023'));
  await w.tap('T'); await w.tap('T');
  check(tag + ': T, T: the next set will be softs', (await w.js(`F1.game.nextCompound`)) === 'S');
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.lap.started`, 60, 'timing');
  const v = await pitVisit(w, tag, {
    limiter: true,
    onService: async w => {
      const r = {};
      r.s0 = await w.js(svcState);
      // R and the pad's reset button (Y since v6.1) in the box: ignored
      await w.tap('R'); await w.frames(3);
      await w.js(`__e.pad.buttons[3].value = 1; __e.pad.buttons[3].pressed = true; true`); await w.frames(3);
      await w.js(`__e.pad.buttons[3].value = 0; __e.pad.buttons[3].pressed = false; true`); await w.frames(3);
      r.s1 = await w.js(svcState);
      // Esc: the menu over the box
      await w.tap('Escape');
      await w.until(`!F1.game.running`, 2000, 'menu');
      r.menu = await w.js(svcState);
      r.menuFrames = await w.js(`__e.run(30, '', 2000)`);
      // the car list: another 2025 car picked while held in the box
      await w.pickCar('2025-ferrari');
      await sleep(200);
      r.picked = await w.js(`({ spec: F1.game.spec.id, locked: document.getElementById('car-list').classList.contains('locked'), lock: __t.shown('car-lock') ? __t.text('car-lock') : '' })`);
      await w.shot(tag + '-4-menu-during-service');
      r.s2 = await w.js(svcState);
      await w.tap('Escape');
      await w.until(`F1.game.running`, 2000, 'resume');
      // the service goes on from where it was; the car stays until it is over
      r.moveBad = await w.js(`(function () { var p = F1.game.pit.state, s = F1.game.car.state, x = s.x, z = s.z, bad = 0, n = 0; W: while (p.service && n < 2000) { __e.run(1, '', 2000); n++;
        if (p.service && (Math.abs(s.x - x) > 1e-9 || Math.abs(s.z - z) > 1e-9 || s.speed !== 0)) bad++; } return { bad: bad, frames: n }; })()`);
      r.s3 = await w.js(svcState);
      return r;
    }
  });
  if (!v || !v.svcStarted) { check(tag + ': a stop in the box', false, v); await w.noErrors(); w.destroy(); return; }
  const t = v.svcTest;
  note(tag + ': ' + J({ strip: v.strip, during: v.during, svcTest: t, after: v.after, toasts: v.toasts, info: v.info && { stopped: v.info.stopped, rec: { maxLane: v.info.rec.maxLaneKmh, hits: v.info.rec.hits, grass: v.info.rec.grass } } }));
  check(tag + ': R / pad Y in the box change nothing (service on, car still)', t.s1.svc && t.s1.x === t.s0.x && t.s1.z === t.s0.z && t.s1.svc.left < t.s0.svc.left, { s0: t.s0, s1: t.s1 });
  check(tag + ': Esc during the service: the menu opens, the service waits (paused), the car stays', t.menu.running === false && t.menuFrames.idle && t.s2.svc && t.s2.svc.left === t.menu.svc.left && t.s2.x === t.menu.x,
    { menu: t.menu, s2: t.s2 });
  note(tag + ': car picked in the box: ' + J(t.picked));
  check(tag + ': resumed: the service runs to its end with the car held (not released early), then new softs', t.moveBad.bad === 0 && t.moveBad.frames > 10 && !t.s3.svc && v.after.tyres === 'S' && v.after.stops === 1, { moveBad: t.moveBad, s3: t.s3, after: v.after });
  check(tag + ': no contact / grass in the short lane, speed capped', v.info && v.info.rec.hits === 0 && v.info.rec.grass === 0 && v.info.rec.maxLaneKmh < 81, v.info && v.info.rec);
  const exitToast = await w.js(`__v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /已離開維修區/.test(t); })`);
  check(tag + ': leaving the lane with the limiter still on: a reminder to switch it off (B: a pad is connected)', exitToast.length === 1 && /按 B 關閉限速器/.test(exitToast[0]), exitToast);
  await w.noErrors();
  w.destroy();
}

async function pitMonaco() {
  const tag = 'pit-monaco', w = makeWin(tag);
  await w.open({ warp: true });
  check(tag + ': track loads', await w.pickTrackWarp('mc-1929'));
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.lap.started`, 60, 'timing');
  // 1. into the box at ~95 km/h without the limiter: speeding, the stop costs 5 s more (then at the limit to the exit:
  //    speeding after the stop would be a second offence, held at the exit line; v6-smoke's pit part covers that)
  const v = await pitVisit(w, tag + '-fast', { limiter: false, vLane: 95 / 3.6, vLaneOut: 58 / 3.6 });
  if (!v || !v.svcStarted) { check(tag + ': speeding visit with a stop', false, v); }
  else {
    note(tag + ' speeding: ' + J({ strip: v.strip, during: v.during, strip2: v.strip2, after: v.after, toasts: v.toasts }));
    const sp = await w.js(`__v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /超速/.test(t); })`);
    check(tag + ': speeding in the 60 km/h lane: toast, the strip tells of the pending 5 s, served in the stop', sp.length === 1 && (/超速/.test(v.strip.warn) || v.strip.pending.indexOf('下次停站罰停 +5 s') >= 0) && v.during.svc.penalty === 5 && /罰停/.test(v.strip2), { sp, strip: v.strip, during: v.during, strip2: v.strip2 });
  }
  // 2. R in the pit lane: the car is put on the lane centre at the same place (js/main.js: not out of the lane, which would
  //    skip it), stopped, the visit and the limiter kept; driven on along the lane (__v.laneOut: the line autopilot would
  //    steer into the pit wall from in there), the next lap counts, the visit ends
  const v2 = await pitVisit(w, tag + '-reset', {
    limiter: true,
    onLane: async w => {
      await w.pump(`F1.game.pit.state.inLane && F1.game.car.state.speed > 5`, 30, 'in the lane');
      const before = await w.js(`__v.car()`);
      await w.js(`__v.plan.active = false; __e.ap.on = false; __e.pad.buttons[7].value = 0; __e.pad.buttons[7].pressed = false; __e.pad.axes[0] = 0; true`);
      await w.tap('R'); await w.frames(5);
      const after = await w.js(`({ car: __v.car(), laneD: F1.game.track.pit.laneD(F1.game.car.state.sampleIndex), pit: __v.pitState(), limiter: F1.game.limiter, lap: { n: F1.game.lap.n, time: F1.game.lap.time, jumping: F1.game.lap.jumping } })`);
      await w.shot(tag + '-4-after-R-in-lane', true);
      // drive on along the lane and out: the lap counts, the pit visit ends cleanly
      await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; __v.laneOut()`);
      const lapN = after.lap.n;
      const lapped = await w.pump(`g.lap.n > ${lapN} && !F1.game.pit.state.visit && !__v.lane.active`, 200, 'the next lap, out of the lane');
      const end = await w.js(`({ pit: __v.pitState(), lap: F1.game.lap.last, car: __v.car() })`);
      await w.tap('Q');
      note(tag + ' R in the lane: ' + J({ before, after, lapped, end }));
      check(tag + ': R in the pit lane puts the car on the lane centre (d ' + after.car.d.toFixed(2) + ' vs ' + (after.laneD === after.laneD ? after.laneD.toFixed(2) : after.laneD) + '), stopped, still in the lane with its visit and the limiter; driven on, the next lap counts, the visit ends (no service, no penalty)',
        Math.abs(after.car.d - after.laneD) < 0.5 && after.car.v === 0 && after.pit.inLane && after.pit.visit && after.limiter && lapped && !end.pit.visit && end.pit.pending === 0 && end.pit.stops === 1 && end.car.hit === 0,
        { after, pit: end.pit });
      return 'stop';
    }
  });
  await w.noErrors();
  w.destroy();
}

async function pitZandvoort() {
  const tag = 'pit-zandvoort', w = makeWin(tag);
  await w.open({ warp: true });
  check(tag + ': track loads', await w.pickTrackWarp('nl-1948'));
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  await w.pump(`g.lap.started`, 60, 'timing');
  const v0 = await pitVisit(w, tag + '-full', { limiter: true });
  const zLim = await w.js(`F1.game.track.pit.limitKmh`);
  check(tag + ': a full stop in box 1 of the ' + zLim + ' km/h lane (limiter, service, out again)', v0 && v0.svcStarted && v0.after && !v0.after.svc && v0.after.stops === 1 && v0.info && v0.info.rec.hits === 0 &&
    v0.info.rec.maxLaneKmh < zLim + 1, v0 && { after: v0.after, rec: v0.info && v0.info.rec });
  const v = await pitVisit(w, tag, {
    limiter: true,
    onService: async w => {
      const s0 = await w.js(svcState);
      // held in the box: W revs the engine in neutral (sound, rev lights, telemetry), the car does not move
      w.key('W', true); await w.until(`F1.game.input.up`, 2000); await w.frames(40);
      const rev = await w.js(`({ rpm: F1.game.car.state.rpm, thr: F1.game.car.state.throttle, gear: F1.game.car.state.gear, hudThr: __v.hud.throttle, v: F1.game.car.state.speed, idle: F1.game.spec.rpmIdle, x: F1.game.car.state.x })`);
      w.key('W', false); await w.until(`!F1.game.input.up`, 2000); await w.frames(60);
      const rev2 = await w.js(`({ rpm: F1.game.car.state.rpm, thr: F1.game.car.state.throttle })`);
      check(tag + ': W in the box revs the engine in neutral (rpm up, throttle shown, gear N, the car still), back to idle when released', rev.rpm > rev.idle * 2 && rev.thr === 1 &&
        rev.hudThr === 1 && rev.gear === 0 && rev.v === 0 && rev.x === s0.x && rev2.thr === 0 && rev2.rpm < rev.idle * 1.2, { rev, rev2 });
      // another track while held in the box
      await w.tap('Escape');
      await w.until(`!F1.game.running`, 2000, 'menu');
      await w.js(`__v.plan.active = false; __e.ap.on = false; true`);
      const ok = await w.pickTrackWarp('it-1922');
      const s1 = await w.js(`({ pit: __v.pitState(), car: __v.car(), lap: { started: F1.game.lap.started, n: F1.game.lap.n }, limiter: F1.game.limiter, strip: __t.shown('hud-pit'), tyres: __v.tyres() })`);
      w.key('W', true); await w.js(`__v.follow(true)`); await w.frames(180); w.key('W', false);
      const s2 = await w.js(`({ car: __v.car(), pit: __v.pitState() })`);
      await w.shot(tag + '-4-new-track', true);
      note(tag + ' track change during the service: ' + J({ s0, s1, s2 }));
      check(tag + ': another track during the service: loaded, no service / visit carried over, the car drives', ok && !s1.pit.service && !s1.pit.visit && s1.pit.stops === 0 && s1.limiter === false &&
        !s1.strip && s2.car.v > 20, { s1, s2 });
      return 'stop';
    }
  });
  if (!v || !v.svcStarted) check(tag + ': a stop in the box', false, v);
  await w.noErrors();
  w.destroy();
}

async function partPit() {
  state.part = 'pit';
  await pitLasVegas();
  await pitMonaco();
  await pitZandvoort();
}

/* ================= tyres: wear x5 to a puncture, limping in; flat spots; dirt ================= */
async function tyresPuncture() {
  const tag = 'tyre-wear', w = makeWin(tag);
  await w.open({ warp: true });
  await w.pickTrackWarp('it-1922');
  // (2026-10-02: the wear is real F1 stints at x1; at x5 a medium set wears through in ~12 laps, a soft in ~7..8:
  // the race starts on softs (the start panel's 起跑輪胎) and runs up to 11 laps)
  await w.tap('Escape');
  await w.card('it-1922');
  await w.mode('gp');
  await w.field('gp-q', '1'); await w.field('gp-r', '12');
  await w.click('#gp-wear button[data-w="5"]');
  await w.click('#setup-tyre [data-c="S"]');
  check(tag + ': a Grand Prix with wear x5 on softs starts from the start panel', await w.go() && await w.until(`F1.game.gp.phase === 'quali' && F1.game.running && F1.game.nextCompound === 'S'`, 3000));
  // the wear option is for the race only (qualifying wears at x1): straight to the race
  await w.js(`F1.game.gp.action('skip'); __e.ap.on = true; __e.ap.mode = 'line'; window.__lapLog = []; true`);
  check(tag + ': qualifying skipped: the race, wear x5 from the grid on', await w.pump(`g.gp.phase === 'race' && !g.gp.inputLocked`, 30, 'race') && (await w.js(`F1.game.tyres.wearRate`)) === 5);
  const laps = [];
  let punct = false;
  for (let k = 1; k <= 11 && !punct; k++) {
    const ok = await w.pump(`g.gp.lap >= ${k} || g.tyres.state.puncture >= 0`, 220, 'race lap ' + k);
    const s = await w.js(`({ lapN: F1.game.gp.lap, last: F1.game.lap.last, tyres: __v.tyres(), hudPunct: __v.hud.tyres && __v.hud.tyres.puncture })`);
    laps.push({ lapN: s.lapN, last: s.last, wear: s.tyres.wear.map(x => +x.toFixed(2)), grip: s.tyres.grip, punct: s.tyres.puncture });
    if (s.tyres.puncture >= 0) punct = true;
    if (!ok) break;
  }
  note(tag + ': ' + J(laps));
  check(tag + ': the softs wear out to a puncture within 11 laps at x5', punct && laps[0].wear.every(x => x < 0.3), laps[laps.length - 1]);
  if (!punct) { await w.noErrors(); w.destroy(); return; }
  await w.frames(30);
  await w.shot(tag + '-1-puncture', true);
  const p = await w.js(`({ car: __v.car(), tyres: __v.tyres(), toasts: __v.toasts.slice(-3).map(function (t) { return t.text; }) })`);
  note(tag + ' puncture: ' + J(p));
  check(tag + ': the puncture is announced (toast naming the wheel, pit to change)', p.toasts.some(t => /爆胎/.test(t) && /維修/.test(t)), p.toasts);
  // limp on to the pits
  await w.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  const v = await pitVisit(w, tag + '-limp', { limiter: true });
  note(tag + ' limp: ' + J(v && { after: v.after, info: v.info && v.info.rec && { hits: v.info.rec.hits, grass: v.info.rec.grass } }));
  const t2 = await w.js(`__v.tyres()`);
  // (a new set: no wear, the full grip of its compound: js/tyres.js S 1.015 / M 1 / H 0.985)
  check(tag + ': limped to the box on the puncture, a new set cures it', v && v.svcStarted && t2.puncture === -1 && Math.max.apply(null, t2.wear) < 0.01 && t2.grip.lat === { S: 1.015, M: 1, H: 0.985 }[t2.compound], { v: v && v.after, t2 });
  await w.noErrors();
  w.destroy();
}
async function tyresFlatDirt() {
  const tag = 'tyre-flat', w = makeWin(tag);
  await w.open({ warp: true });
  await w.pickTrackWarp('it-1922');
  // W along the straight to ~250 km/h (centreline follower on the stick), then full brake + full lock: a lock-up
  w.key('W', true); await w.until(`F1.game.input.up`, 2000);
  await w.js(`__v.follow(true); __e.run(600, 'g.car.state.speed > 250 / 3.6', 5000)`);
  w.key('W', false);
  await w.js(`__v.follow(false); true`);
  w.key('S', true); w.key('A', true); await w.until(`F1.game.input.down && F1.game.input.left`, 2000);
  await w.frames(50);
  w.key('S', false); w.key('A', false); await w.until(`!F1.game.input.down && !F1.game.input.left`, 2000);
  await w.frames(10);
  const f = await w.js(`({ tyres: __v.tyres(), car: __v.car(), vib: F1.game.car.state.vib })`);
  note(tag + ': ' + J(f));
  check(tag + ': a full-lock stamp on the brakes at 250 km/h leaves a flat spot (braking grip < 1)', Math.max.apply(null, f.tyres.flat) > 0 && f.tyres.grip.brake < 1, f.tyres);
  await w.shot(tag + '-1-flat-spot', true);
  // R, then onto the grass beside the straight and back
  await w.tap('R'); await w.frames(5);
  w.key('W', true); await w.until(`F1.game.input.up`, 2000);
  await w.js(`__v.follow(true); __e.run(400, 'g.car.state.speed > 150 / 3.6', 5000); __v.follow(false); true`);
  w.key('D', true); await w.until(`F1.game.input.right`, 2000);
  await w.js(`__e.run(200, 'g.car.state.onGrass', 5000)`);
  w.key('D', false); await w.frames(40);
  const g1 = await w.js(`({ tyres: __v.tyres(), grass: F1.game.car.state.onGrass })`);
  await w.tap('R'); await w.frames(5);
  await w.js(`__v.follow(true); true`);
  // the dirt wears off with the distance driven on asphalt (about 150 m): drive 300 m (the excursion may also have hit
  // the wall hard enough for a puncture, and a car on a punctured rear tyre covers far less ground in a fixed time)
  const g2 = await w.js(`(function () { var s = F1.game.car.state, n = 0, dist = 0; while (n < 1800 && dist < 300) { n += __e.run(1, '', 2000).n; if (!s.onGrass) dist += Math.abs(s.speed) * __e.dt; } return { tyres: __v.tyres(), dist: dist, frames: n }; })()`);
  w.key('W', false);
  note(tag + ' dirt: ' + J({ g1: g1.tyres.dirt, grip1: g1.tyres.grip, puncture: g1.tyres.puncture, g2: g2.tyres.dirt, asphalt: Math.round(g2.dist) + ' m in ' + g2.frames + ' frames' }));
  check(tag + ': grass dirties the tyres (grip down), they clean up on the asphalt (' + Math.round(g2.dist) + ' m)', g1.tyres.dirt > 0.2 && g1.tyres.grip.lat < 1 && g2.dist >= 300 && g2.tyres.dirt < g1.tyres.dirt * 0.3, { g1: g1.tyres, g2: g2.tyres, dist: g2.dist });
  await w.noErrors();
  w.destroy();
}
async function partTyres() {
  state.part = 'tyres';
  await tyresFlatDirt();
  await tyresPuncture();
}

/* ================= room: host + 2 guests, year change, garbage cars, a Grand Prix with a race pit stop ================= */
const DRIVER = fs.readFileSync(path.join(__dirname, 'driver.js'), 'utf8');
async function partRoom() {
  state.part = 'room';
  const port = PORT;
  const A = makeWin('A'), B = makeWin('B'), C = makeWin('C');
  for (const w of [A, B, C]) { const e = await w.open(); if (e) check(w.tag + ' boots', false, e); }
  // remote car models: remember what setHalo was told, per player name
  await A.js(`(function () { var orig = F1.createCarModel; window.__halo = {}; F1.createCarModel = function (c, n) { var m = orig.apply(this, arguments), sh = m.setHalo;
    if (sh) m.setHalo = function (on) { window.__halo[n] = on; return sh.apply(m, arguments); }; return m; }; return true; })()`);
  await A.field('mp-name', 'Alice'); await A.field('mp-port', String(port)); await A.field('mp-create-pass', 'box-box');
  await B.field('mp-name', 'Bob'); await B.field('mp-addr', '127.0.0.1:' + port); await B.field('mp-join-pass', 'box-box');
  await C.field('mp-name', 'Carol'); await C.field('mp-addr', '127.0.0.1:' + port); await C.field('mp-join-pass', 'box-box');
  await B.js(`document.querySelectorAll('.mp-swatch')[2].click(); true`);
  await C.js(`document.querySelectorAll('.mp-swatch')[4].click(); true`);
  await A.click('#tab-mp'); await A.click('mp-create');
  check('A hosts a room with a password', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.js(`__t.text('mp-status')`));
  await A.shot('room-01-host-status');
  const st = await A.js(`__t.text('mp-status')`);
  check('the host status says the room has a password', /已設定房間密碼/.test(st), st);
  await B.click('#tab-mp'); await B.click('mp-join');
  await C.click('#tab-mp'); await C.click('mp-join');
  check('B and C join', await B.until(`F1.net.connected`, 6000) && await C.until(`F1.net.connected`, 6000));
  // the host picks 2014, cars of three teams
  await A.pickYear(2014);
  check('the room is 2014 for everybody', await B.until(`F1.net.year === 2014 && F1.game.spec.year === 2014`, 5000) && await C.until(`F1.net.year === 2014 && F1.game.spec.year === 2014`, 5000));
  await A.pickCar('2014-mercedes'); await B.pickCar('2014-red-bull'); await C.pickCar('2014-ferrari');
  const ids = { a: await A.js(`F1.net.id`), b: await B.js(`F1.net.id`), c: await C.js(`F1.net.id`) };
  check('everybody sees the others\' cars', await A.until(`F1.net.players.length === 2 && F1.net.players.every(function (p) { return /^2014-(red-bull|ferrari)$/.test(p.car); })`, 4000));
  // v7.2: the host picks the room's track in the lobby; the guests press 準備; 開始; everybody loads (the barrier)
  check('the host sets Monza in the lobby', await roomTrack(A, 'it-1922'));
  check('nobody is on a track in the lobby', (await Promise.all([A, B, C].map(w => w.js(`!F1.game.running && !F1.game.track`)))).every(Boolean));
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id && F1.net.room.st === 'session'`;
  check('all three on the room track (free practice after the barrier)', await roomStart(A, [B, C]) && await A.until(onTrack, 15000) && await B.until(onTrack, 15000) && await C.until(onTrack, 15000));
  await sleep(1500);
  // the host changes the year (v7.2: in the lobby: 回到大廳, the season, 開始 again)
  check('the host takes the room back to the lobby', await roomBack(A, [A, B, C]));
  const y16 = await A.pickYear(2016);
  const fol = await B.until(`F1.net.year === 2016 && F1.game.spec.id === '2016-red-bull'`, 5000, 'B 2016') && await C.until(`F1.net.year === 2016 && F1.game.spec.id === '2016-ferrari'`, 5000, 'C 2016');
  const toastsB = await B.js(`__v.toasts.map(function (t) { return t.text; }).filter(function (t) { return /2016/.test(t); })`);
  const aSpec = await A.js(`F1.game.spec.id`);
  check('the host picks 2016 in the lobby: guests follow to the same team\'s 2016 car, told by a toast', y16 === '2016' && fol && toastsB.length === 1 && aSpec === '2016-mercedes', { y16, toastsB, aSpec });
  check('the season change cleared 準備; free practice again after 開始', (await A.js(`F1.net.room.ready.length`)) === 0 && await roomStart(A, [B, C]) && await B.until(onTrack, 15000) && await C.until(onTrack, 15000));
  await sleep(1500);
  const rc = await A.js(`(function () { var r = F1.game.remoteCars, o = {}; for (var k in r) o[k] = r[k].spec ? r[k].spec.id : null; return o; })()`);
  check('the host resolves the guests\' 2016 cars (liveries)', rc[ids.b] === '2016-red-bull' && rc[ids.c] === '2016-ferrari', rc);
  const halo16 = await A.js(`window.__halo`);
  check('2016 cars seen from the host: no halo on the remote models (cockpit style modern)', halo16.Bob === false && halo16.Carol === false, halo16);
  await B.js(`(function () { var s = F1.game.car.state, o = F1.net.players.filter(function (p) { return p.name === 'Alice'; })[0].state; s.x = o.x - Math.sin(o.heading) * 10; s.z = o.z - Math.cos(o.heading) * 10; s.heading = o.heading; s.speed = 0; return true; })()`);
  await sleep(1200);
  await B.shot('room-06-guest-sees-host-2016-no-halo');
  // guests send car ids that do not exist / are hostile
  for (const bad of ['zzz-bogus', 'constructor', '2031-mercedes', '__proto__', 'x'.repeat(60)]) {
    await C.js(`F1.net.setProfile({ car: ${J(bad)} }); true`);
    await sleep(500);
    const seen = await A.js(`(function () { var p = F1.net.players.filter(function (p) { return p.id === ${ids.c}; })[0], r = F1.game.remoteCars[${ids.c}]; return { car: p ? p.car : null, spec: r && r.spec ? r.spec.id : null }; })()`);
    note('C sends car ' + J(bad).slice(0, 20) + ' -> A sees ' + J(seen));
  }
  const errsA = await A.js(`window.__errs.length`);
  check('garbage car ids from a guest: the host keeps going (no page error), shows a real car', errsA === 0 && /^2016-/.test((await A.js(`(function () { var r = F1.game.remoteCars[${ids.c}]; return r && r.spec ? r.spec.id : ''; })()`))));
  await C.tap('Escape'); await C.pickCar('2016-ferrari'); await C.tap('Escape');
  // a Grand Prix: wear x2, skip qualifying, race of 2 laps (v7.2: set in the lobby, started with 開始)
  await roomBack(A, [A, B, C]);
  await roomSettings(A, { mode: 'gp', q: 1, r: 2, wear: 2 });
  check('the Grand Prix starts for everybody (qualifying)', await roomStart(A, [B, C], { gp: true }));
  // year / car switching attempts during the session
  await A.tap('Escape');
  const ya = await A.pickYear(2020);
  const direct = await A.js(`F1.net.setYear(2020)`);
  await sleep(1500);
  await B.tap('Escape');
  const yb = await B.pickYear(2012);
  await B.pickCar('2016-mercedes');
  await sleep(300);
  const after = { aYear: await A.js(`F1.net.year`), aSpec: await A.js(`F1.game.spec.id`), bSpec: await B.js(`F1.game.spec.id`), bLock: await B.js(`__t.text('car-lock')`) };
  check('parc fermé: the year select is disabled (host and guest), a direct net.setYear is refused by the server, a car click changes nothing', ya === 'disabled' && yb === 'disabled' && after.aYear === 2016 &&
    after.aSpec === '2016-mercedes' && after.bSpec === '2016-red-bull', { ya, yb, direct, after });
  await B.shot('room-02-guest-parc-ferme');
  await A.tap('Escape'); await B.tap('Escape');
  const wearQ = { a: await A.js(`F1.game.tyres.wearRate`), b: await B.js(`F1.game.tyres.wearRate`), c: await C.js(`F1.game.tyres.wearRate`) };
  check('qualifying: tyre wear x1 on every car (the x2 is for the race only)', wearQ.a === 1 && wearQ.b === 1 && wearQ.c === 1, wearQ);
  await A.js(`F1.game.gp.action('skip'); true`);
  check('grid, then the race', await A.until(`F1.game.gp.phase === 'grid'`, 5000) && await A.until(`F1.game.gp.phase === 'race'`, 20000) && await B.until(`F1.game.gp.phase === 'race' && !F1.game.gp.inputLocked`, 5000));
  const wear = { a: await A.js(`F1.game.tyres.wearRate`), b: await B.js(`F1.game.tyres.wearRate`), c: await C.js(`F1.game.tyres.wearRate`) };
  check('the race: tyre wear x2 on every car', wear.a === 2 && wear.b === 2 && wear.c === 2, wear);
  // B drives a lap into its box (the limiter on LB near the lane), A and C stay on the grid
  await B.js(DRIVER);
  const bSlot = await B.js(`F1.net.slot`);
  const plan = await B.js(`__d.lapPlan({ slot: ${bSlot} })`);
  note('B lap plan: ' + J(plan));
  const nearLane = `(function () { var p = F1.game.track.pit, N = F1.game.track.samples.length, k = ((p.entry - F1.game.car.state.sampleIndex) % N + N) % N; return __d.plan.U > 200 && k * F1.game.track.length / N < 350; })()`;
  const near = await B.until(nearLane, 200000, 'B near the pit lane');
  await B.js(`__d.btn(4, 1); true`); await sleep(150); await B.js(`__d.btn(4, 0); true`);
  const lim = await B.js(`F1.game.limiter`);
  const inLane = await B.until(`F1.game.pit.state.inLane`, 30000, 'B in the lane');
  await sleep(300);
  const ghostA = await A.js(`(function () { var m = F1.game.remoteModels[${ids.b}], g = false; if (!m) return null; m.group.traverse(function (o) { if (o.isMesh && o.material && o.material.transparent && o.material.opacity < 0.9) g = true; }); return g; })()`);
  await A.shot('room-03-host-sees-B-in-lane');
  const svc = await B.until(`!!F1.game.pit.state.service`, 40000, 'B service');
  await sleep(600);
  await B.shot('room-04-B-service-in-race');
  const svcView = await B.js(`({ svc: __v.pitState().service, strip: __t.text('hud-pit'), gp: __t.text('hud-gp') })`);
  const done = await B.until(`!F1.game.pit.state.service && F1.game.pit.state.stops >= 1`, 20000, 'B service done');
  const lap1 = await B.until(`F1.game.gp.lap >= 1`, 60000, 'B lap 1 counted');
  const bi = await B.js(`__d.info()`);
  note('B race stop: ' + J({ near, lim, inLane, ghostA, svc, svcView, done, lap1, rec: bi && bi.rec, err: bi && bi.err }));
  check('B (guest) pits in the race: limiter on LB, a ghost to the host in the lane, service, lap 1 counted by the session', near && lim && inLane && ghostA === true && svc && done && lap1, { near, lim, inLane, ghostA, svc, done, lap1 });
  if (bi && bi.rec.svcStart) {
    const held = (bi.rec.svcDone - bi.rec.svcStart) / 1000, lapRan = bi.rec.svcLap1 - bi.rec.svcLap0;
    check('the race stop: car frozen, the lap clock ran on through it (' + held.toFixed(2) + ' s held, lap clock +' + lapRan.toFixed(2) + ' s)', bi.rec.maxServiceMove === 0 && bi.rec.frozenBad === 0 && Math.abs(lapRan - held) < 0.25, bi.rec);
  }
  const rows = await A.js(`F1.game.gp.view().rows.map(function (r) { return [r.name, r.laps, r.team, r.colour2, r.best]; })`);
  note('A standings: ' + J(rows));
  // C drops out and comes back mid-race: a spectator
  await C.js(`document.getElementById('mp-leave').click(); true`);
  await C.until(`!F1.net.connected`, 4000, 'C left');
  await sleep(500);
  await C.tap('Escape');
  await C.click('#tab-mp'); await C.click('mp-join');
  const back = await C.until(`F1.net.connected && F1.game.gp.phase === 'race'`, 8000, 'C back');
  await sleep(2500);
  const cv = await C.js(`({ spec: F1.game.gp.view().spectating, car: F1.game.spec.id, running: F1.game.running, toast: __t.text('hud-toast'), status: __t.text('mp-status') })`);
  note('C after reconnect: ' + J(cv));
  check('C reconnects mid-race: back in the room as a spectator, a 2016 car', back && cv.spec === true && /^2016-/.test(cv.car), cv);
  await C.shot('room-05-C-spectating');
  await B.js(`__d.stop()`);
  await A.js(`F1.game.gp.action('end'); true`);
  await A.until(`F1.game.gp.phase === 'results'`, 4000, 'results');
  await A.js(`F1.game.gp.action('end'); true`);
  // (v7.2: a room does not fall back to free practice: the second end takes it back to the lobby)
  check('the host ends the Grand Prix: the results, then everybody in the lobby (no session)', await A.until(`F1.game.gp.phase === 'free' && F1.net.room.st === 'lobby'`, 4000) &&
    await B.until(`F1.game.gp.phase === 'free' && F1.net.room.st === 'lobby'`, 4000) && await C.until(`F1.game.gp.phase === 'free' && F1.net.room.st === 'lobby'`, 4000));
  for (const w of [A, B, C]) await w.noErrors();
  for (const w of [C, B, A]) { await w.js(`document.getElementById('mp-leave') && document.getElementById('mp-leave').click(); true`); }
  await sleep(400);
  A.destroy(); B.destroy(); C.destroy();
}

/* ================= robustness: key / button mashing ================= */
async function partMash() {
  state.part = 'mash';
  const w = makeWin('mash');
  await w.open();
  await w.js(`__t.fakePad()`);
  await w.pickTrack('it-1922');
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const KEYS = ['Q', 'E', 'T', 'M', 'R', 'Escape', 'W', 'S', 'A', 'D', 'L', 'V'];   // (V: the HUD mirrors, v6.1)
  const held = {};
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < 20000) {
    const k = KEYS[Math.floor(rnd() * KEYS.length)];
    if (k === 'W' || k === 'S' || k === 'A' || k === 'D' || k === 'E') { held[k] = !held[k]; w.key(k, held[k]); }
    else { w.key(k, true); await sleep(5 + rnd() * 30); w.key(k, false); }
    if (rnd() < 0.15) { const bI = [0, 1, 3, 4, 5, 8, 9, 2][Math.floor(rnd() * 8)]; await w.js(`__btn(${bI}, 1)`); await sleep(20 + rnd() * 60); await w.js(`__btn(${bI}, 0)`); }
    if (rnd() < 0.05) { await w.js(`window.__padOn = !window.__padOn; true`); }
    await sleep(5 + rnd() * 40);
    n++;
  }
  for (const k of Object.keys(held)) if (held[k]) w.key(k, false);
  await w.js(`window.__padOn = true; for (var i = 0; i < 17; i++) __btn(i, 0); true`);
  await sleep(600);
  note('mashed ' + n + ' inputs in 20 s');
  await w.shot('mash-1-after');
  // not soft-locked: back to driving, the car moves
  const st = await w.js(`({ running: F1.game.running, limiter: F1.game.limiter, overlay: !document.getElementById('error').classList.contains('hidden'), muted: F1.audio.muted })`);
  if (!st.running) { await w.tap('Escape'); await sleep(300); }
  await w.tap('R'); await sleep(200);
  w.key('W', true); await sleep(2500);
  const v = await w.js(`({ v: F1.game.car.state.speed * 3.6, running: F1.game.running, limiter: F1.game.limiter, muted: F1.audio.muted, boost: F1.game.boost, input: F1.game.input })`);
  w.key('W', false);
  note('after mashing: ' + J({ st, v }));
  check('after 20 s of mashing Q / E / T / M / R / Esc / WASD / L / V and pad buttons: nothing threw, the car drives again', !st.overlay && v.running && v.v > 20, { st, v });
  await w.noErrors('mash');
  // the same on the grid of an offline Grand Prix (lights: input locked)
  await w.tap('Escape');
  await w.card('it-1922');
  await w.mode('gp');
  await w.field('gp-q', '1'); await w.field('gp-r', '1');
  await w.go();
  await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000, 'quali');
  await w.js(`F1.game.gp.action('skip'); true`);
  await w.until(`F1.game.gp.phase === 'grid'`, 3000, 'grid');
  const g0 = await w.js(`__v.car()`);
  const t1 = Date.now();
  while (Date.now() - t1 < 4000) {
    const k = ['Q', 'E', 'T', 'M', 'R', 'W', 'L'][Math.floor(rnd() * 7)];
    w.key(k, true); await sleep(10 + rnd() * 30); w.key(k, false); await sleep(10 + rnd() * 30);
  }
  // W held on the grid: the engine revs, the car stays
  if ((await w.js(`F1.game.gp.phase`)) === 'grid') {
    w.key('W', true); await sleep(700);
    const gr = await w.js(`({ rpm: F1.game.car.state.rpm, thr: F1.game.car.state.throttle, idle: F1.game.spec.rpmIdle, locked: F1.game.gp.inputLocked, car: __v.car() })`);
    w.key('W', false);
    check('W held on the grid: the engine revs (rpm, throttle), the car does not move', !gr.locked || (gr.rpm > gr.idle * 2 && gr.thr === 1 && gr.car.x === g0.x), gr);
  }
  const g1 = await w.js(`({ car: __v.car(), phase: F1.game.gp.phase, locked: F1.game.gp.inputLocked })`);
  check('mashing on the grid: the car does not move before the lights go out', g1.phase !== 'grid' || (g1.car.x === g0.x && g1.car.z === g0.z), { g0: { x: g0.x, z: g0.z }, g1 });
  await w.until(`F1.game.gp.phase === 'race'`, 15000, 'race');
  await w.tap('Escape');
  const yr = await w.pickYear(2012);
  const cc = await w.click('#car-list .car-card[data-id="2025-ferrari"]');
  const pf = await w.js(`({ spec: F1.game.spec.id, year: document.getElementById('car-year').value, lock: __t.text('car-lock') })`);
  check('offline Grand Prix: year and car are locked (parc fermé)', yr === 'disabled' && pf.spec === '2025-standard' && /賽事進行中/.test(pf.lock), { yr, cc, pf });
  await w.tap('Escape');
  await w.js(`F1.game.gp.action('end'); true`);
  await w.noErrors('grid mash');
  w.destroy();
}

const PARTS = { newbie: partNewbie, ers: partErs, pit: partPit, tyres: partTyres, room: partRoom, mash: partMash };
module.exports.PARTS = PARTS;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  host.register(ipcMain);
  for (const name of Object.keys(PARTS)) {
    if (ONLY.length && ONLY.indexOf(name) < 0) continue;
    try { await PARTS[name](); } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '  FAILED: ' + bad.map(r => r.name).join(' | ') : ''));
  await host.stopServer();
  app.exit(bad.length ? 1 : 0);
});
