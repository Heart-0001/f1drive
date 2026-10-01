// Final review, area "the game as a whole": states and transitions through js/main.js, js/ui.js, index.html in the
// real page (offscreen Electron, real inputs, muted). Not a regression suite: it prints NOTE lines and saves
// screenshots in ./out for a human (me) to read.
//   npx electron devtests/review-final/game/run.js      env ONLY=menu,drive,gp,room,migrate,pad,perf  PORT=24930
'use strict';
const { app, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), cp = require('child_process');
require('../../electron-userdata')(app, 'review-final-game');
const L = require('./lib');
L.host.register(ipcMain);
const { sleep, J, check, note, makeWin, state, results, ROOT } = L;
const PORT = Number(process.env.PORT || 24930);
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
fs.mkdirSync(L.OUT, { recursive: true });

const MENU_STATE = `({ tab: document.querySelector('.menu-tabs button.on').getAttribute('data-tab'), resume: __t.shown('menu-resume'), lock: __t.shown('track-lock') ? __t.text('track-lock') : '',
  gpStart: document.getElementById('gp-start').disabled, gpHint: __t.shown('gp-hint') ? __t.text('gp-hint') : '', gpCar: __t.shown('gp-car') ? __t.text('gp-car') : '',
  gpSession: __t.shown('gp-session') ? __t.text('gp-session') : '', carLock: __t.shown('car-lock') ? __t.text('car-lock') : '', yearDisabled: document.getElementById('car-year').disabled,
  year: document.getElementById('car-year').value, carSel: (document.querySelector('#car-list .car-card.on') || {}).getAttribute ? document.querySelector('#car-list .car-card.on').getAttribute('data-id') : null,
  mpStatus: __t.shown('mp-status') ? __t.text('mp-status') : '', toast: __t.shown('hud-toast') ? __t.text('hud-toast') : '', menuShown: __t.shown('menu'), hudShown: __t.shown('hud'),
  running: F1.game.running, phase: F1.game.gp.phase })`;
const HUD_STATE = `({ timing: __t.text('hud-timing'), gpBox: __t.shown('hud-gp') ? __t.text('hud-gp') : '', players: __t.shown('hud-players') ? __t.text('hud-players') : '',
  lights: __t.shown('hud-lights') ? __t.text('hud-lights') : '', pit: __t.shown('hud-pit') ? __t.text('hud-pit') : '', res: __t.shown('gp-results') ? __t.text('gp-results') : '',
  toast: __t.shown('hud-toast') ? __t.text('hud-toast') : '', hint: __t.shown('hud-hint') ? __t.text('hud-hint') : '', running: F1.game.running, phase: F1.game.gp.phase,
  rects: { timing: __t.rect('hud-timing'), gp: __t.rect('hud-gp'), lights: __t.rect('hud-lights'), pit: __t.rect('hud-pit'), tel: __t.rect('hud-telemetry'), map: __t.rect('hud-map'), hint: __t.rect('hud-hint'), res: __t.rect('gp-results'), toast: __t.rect('hud-toast') }, win: [innerWidth, innerHeight] })`;

/* ================= menu: boot, tabs, texts, sizes ================= */
async function partMenu() {
  state.part = 'menu';
  const w = makeWin('menu');
  const err = await w.open();
  check('boots without the error overlay', !err, err);
  note('menu: ' + J(await w.js(MENU_STATE)));
  for (const t of ['gp', 'car', 'mp', 'set']) { await w.click('#tab-' + t); await w.shot('menu-01-tab-' + t); note(t + ': ' + J(await w.js(`__t.text('#mp-panel')`))); }
  // all user-visible strings of the page (static DOM) for a text review
  const texts = await w.js(`(function () { var out = []; var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); var n; while ((n = walk.nextNode())) { var s = n.nodeValue.replace(/\\s+/g, ' ').trim(); if (s && n.parentNode.tagName !== 'SCRIPT' && n.parentNode.tagName !== 'STYLE') out.push(s); }
    document.querySelectorAll('[placeholder],[title],[aria-label]').forEach(function (e) { ['placeholder','title','aria-label'].forEach(function (a) { if (e.getAttribute(a)) out.push(a + '=' + e.getAttribute(a)); }); }); return out; })()`);
  fs.writeFileSync(path.join(L.OUT, 'texts.json'), JSON.stringify(texts, null, 1));
  // the car list: notes of every season (text review)
  const notes = await w.js(`(function () { var o = {}; F1.cars.seasons.forEach(function (s) { o[s.year] = F1.cars.list(s.year).map(function (c) { return [c.id, c.teamZh, c.team, c.car, c.engine, c.note]; }); }); return o; })()`);
  fs.writeFileSync(path.join(L.OUT, 'cars.json'), JSON.stringify(notes, null, 1));
  // keyboard: Esc in the search box, Enter on a card
  await w.click('#track-search');
  await w.js(`document.getElementById('track-search').value = 'mon'; document.getElementById('track-search').dispatchEvent(new Event('input')); true`);
  await w.shot('menu-02-search');
  note('search: ' + J(await w.js(`({ count: __t.text('track-count'), shown: [].slice.call(document.querySelectorAll('#track-grid .card:not(.hidden) .card-name')).map(function (e) { return e.textContent; }) })`)));
  await w.tap('Escape');
  note('after Esc in the search box: ' + J(await w.js(`({ active: document.activeElement && document.activeElement.id, running: F1.game.running })`)));
  // sizes of the menu
  for (const s of [[1920, 1080], [1024, 600], [700, 500], [560, 700]]) {
    await w.size(s[0], s[1]);
    await w.click('#tab-gp');
    await w.shot('menu-03-' + s[0] + 'x' + s[1]);
    const r = await w.js(`({ grid: __t.rect('track-grid'), panel: __t.rect('mp-panel'), card: __t.rect('#track-grid .card'), scrollW: document.documentElement.scrollWidth, w: innerWidth, keymap: __t.rect('.keymap'), head: __t.rect('.menu-head'), hints: __t.rect('.hints') })`);
    note(s.join('x') + ': ' + J(r));
    check(s.join('x') + ': no horizontal page scroll', r.scrollW <= r.w, r);
  }
  await w.noErrors();
  await L.close(w);
}

/* ================= drive: states and transitions ================= */
async function partDrive() {
  state.part = 'drive';
  const w = makeWin('drive');
  await w.open();
  // Esc / resume before any track
  await w.tap('Escape');
  note('Esc with no track: ' + J(await w.js(MENU_STATE)));
  check('Monza loads', await w.pickTrack('it-1922'));
  await sleep(500);
  note('HUD standing: ' + J(await w.js(HUD_STATE)));
  await w.shot('drive-01-standing');
  // hold W, Esc with W held, resume: does the car keep moving?
  w.key('W', true); await sleep(2000);
  const v1 = await w.js(`F1.game.car.state.speed * 3.6`);
  await w.tap('Escape');
  await sleep(300);
  const m1 = await w.js(MENU_STATE);
  note('Esc while W held: ' + J(m1) + ' speed ' + v1.toFixed(0));
  check('Esc opens the menu with 繼續駕駛 and the HUD hidden', m1.menuShown && !m1.hudShown && m1.resume && !m1.running, m1);
  await w.shot('drive-02-menu-paused');
  await w.tap('Escape');  // resume
  await sleep(1000);
  const v2 = await w.js(`({ v: F1.game.car.state.speed * 3.6, up: F1.game.input.up, running: F1.game.running })`);
  note('after resume with W still physically held: ' + J(v2));
  w.key('W', false);
  // the 繼續駕駛 button and the HUD 選單 button
  await w.tap('Escape'); await sleep(200);
  check('繼續駕駛 button resumes', await w.click('menu-resume') && await w.js(`F1.game.running`));
  await sleep(200);
  check('HUD 選單 button opens the menu', await w.click('hud-menu-btn') && await w.js(`!F1.game.running && __t.shown('menu')`));
  await w.tap('Escape'); await sleep(200);
  // R, L, Q (limiter strip outside the lane), T, M, E
  await w.tap('L'); await sleep(100);
  note('L: ' + J(await w.js(`({ lineVisible: F1.game.raceLine && F1.game.raceLine.group.visible })`)));
  await w.tap('L');
  await w.tap('Q'); await sleep(300);
  await w.shot('drive-03-limiter-on-track');
  note('Q outside the lane: ' + J(await w.js(HUD_STATE)));
  w.key('W', true); await sleep(4000);
  await w.shot('drive-04-limiter-held');
  note('Q held with W 4 s: ' + J(await w.js(`({ v: F1.game.car.state.speed * 3.6, lim: F1.game.limiter, pit: __t.text('hud-pit'), tel: __v.hud.limiter })`)));
  w.key('W', false);
  await w.tap('Q'); await sleep(200);
  for (let i = 0; i < 3; i++) { await w.tap('T'); await sleep(60); }
  note('T x3: ' + J(await w.js(`({ next: F1.game.nextCompound, toast: __t.text('hud-toast') })`)));
  await w.tap('M'); await sleep(100);
  note('M: ' + J(await w.js(`({ muted: F1.audio && F1.audio.muted, toast: __t.text('hud-toast'), setting: __t.text('set-mute-text') })`)));
  await w.tap('M');
  // reset in motion
  w.key('W', true); await sleep(1500); w.key('A', true); await sleep(600); w.key('A', false); w.key('W', false);
  await w.tap('R'); await sleep(200);
  note('R: ' + J(await w.js(`({ d: F1.game.car.state.d, v: F1.game.car.state.speed, lapStarted: F1.game.lap.started, lapTime: F1.game.lap.time })`)));
  // key held on blur
  w.key('W', true); await sleep(500);
  await w.js(`window.dispatchEvent(new Event('blur')); true`);
  await sleep(100);
  note('blur with W held: ' + J(await w.js(`F1.game.input`)));
  w.key('W', false);
  // HUD at sizes
  for (const s of [[1920, 1080], [1024, 600], [700, 500], [560, 700]]) {
    await w.size(s[0], s[1]);
    await sleep(300);
    await w.shot('drive-05-hud-' + s[0] + 'x' + s[1]);
    const h = await w.js(HUD_STATE);
    note('HUD ' + s.join('x') + ': ' + J(h.rects) + ' hint=' + J(h.hint));
  }
  await w.size(1280, 720);
  // year / car change in free practice while standing (menu), then the HUD
  await w.tap('Escape'); await sleep(200);
  const y = await w.pickYear(2012);
  await sleep(300);
  const cars = await w.js(`[].slice.call(document.querySelectorAll('#car-list .car-card')).map(function (e) { return e.getAttribute('data-id'); })`);
  note('2012 list: ' + J(cars));
  await w.pickCar('2012-ferrari'); await sleep(300);
  note('2012 ferrari picked: ' + J(await w.js(MENU_STATE)) + ' spec=' + J(await w.js(`({ id: F1.game.spec.id, cockpit: F1.game.spec.cockpit, battery: F1.game.car.state.battery })`)));
  await w.shot('drive-06-car-tab-2012');
  await w.click('#tab-gp');
  await w.shot('drive-07-gp-tab-2012');
  await w.tap('Escape'); await sleep(400);
  await w.shot('drive-08-hud-2012-ferrari');
  note('HUD 2012: ' + J(await w.js(`({ tel: { team: __v.hud.team, car: __v.hud.car, battery: __v.hud.battery, rpmMax: __v.hud.rpmMax } })`)));
  // another track mid-drive
  await w.tap('Escape'); await sleep(200);
  check('Monaco loads from the menu', await w.pickTrack('mc-1929'));
  await sleep(400);
  note('Monaco HUD: ' + J(await w.js(HUD_STATE)));
  await w.shot('drive-09-monaco');
  await w.noErrors();
  await L.close(w);
}

/* ================= Grand Prix solo: real time (lights) + warp (whole race, results) ================= */
async function partGp() {
  state.part = 'gp';
  const w = makeWin('gp');
  await w.open();
  await w.pickTrack('it-1922');
  await sleep(300);
  await w.tap('Escape'); await sleep(200);
  await w.click('#tab-gp');
  await w.field('gp-q', '1'); await w.field('gp-r', '2');
  await w.click('#gp-wear button[data-w="3"]');
  await w.shot('gp-01-panel-before-start');
  note('panel before start: ' + J(await w.js(MENU_STATE)));
  check('開始大獎賽 starts qualifying and leaves the menu', await w.click('gp-start') && await w.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  await sleep(300);
  note('quali HUD: ' + J(await w.js(HUD_STATE)));
  await w.shot('gp-02-quali-hud');
  await w.tap('Escape'); await sleep(200);
  await w.shot('gp-03-quali-menu');
  note('quali menu: ' + J(await w.js(MENU_STATE)));
  // parc fermé: the year select and the car list are locked
  await w.click('#tab-car');
  await w.shot('gp-04-quali-car-tab');
  note('car tab during quali: ' + J(await w.js(MENU_STATE)));
  const clicked = await w.click('#car-list .car-card:nth-child(2)');
  note('click a car during parc fermé: clicked=' + clicked + ' ' + J(await w.js(`({ sel: document.querySelector('#car-list .car-card.on').getAttribute('data-id'), spec: F1.game.spec.id })`)));
  await w.click('#tab-gp');
  check('跳過排位 puts the car on the grid', await w.click('gp-skip') && await w.until(`F1.game.gp.phase === 'grid'`, 3000));
  await sleep(300);
  note('grid: ' + J(await w.js(MENU_STATE)));
  // the menu closed itself? (leaveMenu) - the lights are shown; Esc during the lights
  const g1 = await w.js(HUD_STATE);
  note('grid HUD: ' + J(g1));
  await w.shot('gp-05-grid');
  w.key('W', true);
  await w.until(`F1.game.gp.lights >= 2`, 8000, 'two lights');
  await w.shot('gp-06-lights-2');
  await w.tap('Escape'); await sleep(1200);   // paused with two lights on (offline: the clock stops)
  const paused = await w.js(`({ lights: F1.game.gp.lights, menu: __t.shown('menu'), v: F1.game.car.state.speed })`);
  note('Esc with 2 lights on, 1.2 s later: ' + J(paused));
  await w.shot('gp-07-menu-during-lights');
  await w.tap('Escape');
  w.key('W', false); w.key('W', true);   // (a synthetic key does not auto-repeat; a real one re-sets input.up after the menu)
  await w.until(`F1.game.gp.lights >= 5`, 8000, 'five lights');
  await w.shot('gp-08-lights-5');
  const go = await w.until(`F1.game.gp.phase === 'race'`, 6000, 'race');
  check('lights out -> race, the car moves with W held', go && await w.until(`F1.game.car.state.speed > 5`, 3000));
  await sleep(600);
  await w.shot('gp-09-race-go');
  note('race HUD: ' + J(await w.js(HUD_STATE)));
  await sleep(1500);
  await w.shot('gp-10-race');
  w.key('W', false);
  // size while a session box is shown
  for (const s of [[700, 500], [1024, 600]]) { await w.size(s[0], s[1]); await w.shot('gp-11-race-hud-' + s[0]); note('race HUD ' + s.join('x') + ': ' + J((await w.js(HUD_STATE)).rects)); }
  await w.size(1280, 720);
  // another track during the race ends the Grand Prix
  await w.tap('Escape'); await sleep(200);
  await w.shot('gp-12-menu-during-race');
  note('menu during race: ' + J(await w.js(MENU_STATE)));
  await w.pickTrack('mc-1929');
  await sleep(500);
  note('after Monaco: ' + J(await w.js(HUD_STATE)) + ' ' + J(await w.js(`({ phase: F1.game.gp.phase, lapN: F1.game.lap.n, wear: F1.game.tyres.wearRate })`)));
  await w.shot('gp-13-after-track-change');
  await w.noErrors();
  await L.close(w);

  // whole Grand Prix on the autopilot (time warp): results overlay, 關閉 / 再來一場 / 結束
  const v = makeWin('gpw');
  await v.open({ warp: true });
  await v.pickTrackWarp('it-1922');
  await v.tap('Escape');
  await v.click('#tab-gp');
  await v.field('gp-q', '1'); await v.field('gp-r', '1');
  await v.click('#gp-wear button[data-w="1"]');
  check('warp: Grand Prix starts', await v.click('gp-start') && await v.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 3000));
  await v.js(`__e.ap.on = true; __e.ap.mode = 'line'; true`);
  check('warp: qualifying lap done -> grid', await v.pump(`g.gp.phase === 'grid'`, 200, 'grid'));
  const gridHud = await v.js(HUD_STATE);
  note('warp grid HUD timing: ' + J(gridHud.timing) + ' gp=' + J(gridHud.gpBox));
  check('warp: race', await v.pump(`g.gp.phase === 'race'`, 30, 'race'));
  check('warp: results', await v.pump(`g.gp.phase === 'results'`, 200, 'results'));
  await v.frames(5);
  await v.shot('gp-20-results', true);
  const res = await v.js(HUD_STATE);
  note('results: ' + J(res));
  await v.size(700, 500); await v.frames(3); await v.shot('gp-21-results-700', true);
  await v.size(560, 700); await v.frames(3); await v.shot('gp-22-results-560', true);
  await v.size(1280, 720); await v.frames(3);
  // lap counter after the flag: does the timing box stay frozen while the car drives on?
  await v.pump(`g.lap.time > 20`, 60, 'drive on after the flag');
  const after = await v.js(`({ timing: __t.text('hud-timing'), lapN: F1.game.lap.n, last: F1.game.lap.last, best: F1.game.lap.best, res: __t.text('gp-results-body') })`);
  note('after the flag, 20 s on: ' + J(after));
  check('關閉 hides the results overlay', await v.click('gp-close') && !(await v.js(`__t.shown('gp-results')`)));
  await v.tap('Escape');
  await v.shot('gp-23-results-menu');
  note('results menu: ' + J(await v.js(MENU_STATE)));
  check('再來一場 (menu) starts a new session', await v.click('gp-again') && await v.until(`F1.game.gp.phase === 'quali'`, 3000));
  await v.frames(3);
  note('again: ' + J(await v.js(HUD_STATE)));
  await v.tap('Escape');
  await v.click('#tab-gp');
  check('結束大獎賽 goes back to free practice', await v.click('gp-end') && await v.until(`F1.game.gp.phase === 'free'`, 3000));
  await v.frames(3);
  note('after end: ' + J(await v.js(MENU_STATE)) + ' ' + J(await v.js(`({ timing: __t.text('hud-timing'), lapN: F1.game.lap.n, running: F1.game.running })`)));
  await v.shot('gp-24-after-end');
  await v.noErrors();
  await L.close(v);
}

/* ================= room: password, XSS names, year lock, host leaves ================= */
async function partRoom() {
  state.part = 'room';
  const A = makeWin('A'), B = makeWin('B');
  for (const w of [A, B]) { const e = await w.open(); if (e) check(w.tag + ' boots', false, e); }
  await A.field('mp-name', 'Host<b>x</b>'); await A.field('mp-port', String(PORT)); await A.field('mp-create-pass', 'pw1');
  await B.field('mp-name', '<img src=x onerror=window.__xss=1>'); await B.field('mp-addr', '127.0.0.1:' + PORT);
  await A.click('#tab-mp'); await A.click('mp-create');
  check('A hosts', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.js(`__t.text('mp-status')`));
  await A.shot('room-01-host');
  note('host menu: ' + J(await A.js(MENU_STATE)));
  await B.click('#tab-mp');
  await B.field('mp-join-pass', 'wrong'); await B.click('mp-join');
  await B.until(`!F1.net.connecting`, 6000);
  await sleep(300);
  note('B wrong password: ' + J(await B.js(`__t.text('mp-status')`)));
  await B.shot('room-02-guest-wrong-pw');
  await B.field('mp-join-pass', 'pw1'); await B.click('mp-join');
  check('B joins with the password', await B.until(`F1.net.connected`, 6000), await B.js(`__t.text('mp-status')`));
  await sleep(500);
  await B.shot('room-03-guest-joined');
  note('guest menu: ' + J(await B.js(MENU_STATE)));
  const xss = await A.js(`({ xss: window.__xss, imgs: document.querySelectorAll('img').length, roster: __t.text('mp-players'), toast: __t.text('hud-toast') })`);
  note('A sees the hostile name: ' + J(xss));
  check('no script from a hostile name on the host', !xss.xss && xss.imgs === 0, xss);
  // guest: year select locked, car list of the room year
  await B.click('#tab-car');
  await B.shot('room-04-guest-car-tab');
  note('guest car tab: ' + J(await B.js(MENU_STATE)));
  // host picks the year 2016 and the track
  await A.pickYear(2016);
  check('B follows 2016', await B.until(`F1.net.year === 2016 && F1.game.spec.year === 2016`, 5000));
  note('B toast: ' + J(await B.js(`__t.text('hud-toast')`)));
  await B.shot('room-05-guest-year-toast');
  await A.pickTrack('it-1922');
  const onTrack = `F1.game.running && F1.game.trackData && F1.net.trackId === F1.game.trackData.id`;
  check('both on the room track', await A.until(onTrack, 15000) && await B.until(onTrack, 15000));
  await sleep(1500);
  await A.shot('room-06-host-hud'); await B.shot('room-07-guest-hud');
  note('A HUD: ' + J(await A.js(HUD_STATE)));
  const xss2 = await A.js(`({ xss: window.__xss, imgs: document.querySelectorAll('img').length, players: __t.text('hud-players') })`);
  check('no script from a hostile name in the HUD list', !xss2.xss && xss2.imgs === 0, xss2);
  // guest opens the menu: resume button, lock text, grid locked
  await B.tap('Escape'); await sleep(200);
  await B.shot('room-08-guest-menu');
  note('guest menu on track: ' + J(await B.js(MENU_STATE)));
  // the guest tries the track grid
  const gi = await B.trackIndex('mc-1929');
  await B.click(`#track-grid .card[data-i="${gi}"]`);
  await sleep(500);
  note('guest clicked a track: ' + J(await B.js(`({ track: F1.game.trackData.id, net: F1.net.trackId })`)));
  // host starts a GP with the guest in the menu: does the guest leave the menu?
  await A.tap('Escape'); await A.click('#tab-gp'); await A.field('gp-q', '1'); await A.field('gp-r', '1');
  check('host starts a Grand Prix', await A.click('gp-start') && await A.until(`F1.game.gp.phase === 'quali'`, 4000));
  check('guest (in the menu) is taken into qualifying and out of the menu', await B.until(`F1.game.gp.phase === 'quali' && F1.game.running`, 4000));
  await sleep(500);
  await B.shot('room-09-guest-quali');
  note('guest quali HUD: ' + J(await B.js(HUD_STATE)));
  note('host quali HUD: ' + J(await A.js(HUD_STATE)));
  const xss3 = await A.js(`({ xss: window.__xss, imgs: document.querySelectorAll('img').length, gp: __t.text('hud-gp') })`);
  check('no script from a hostile name in the standings', !xss3.xss && xss3.imgs === 0, xss3);
  // the host leaves mid-session
  await A.tap('Escape'); await A.click('#tab-mp'); await A.click('mp-leave');
  await sleep(1500);
  const bAfter = await B.js(`({ connected: F1.net.connected, phase: F1.game.gp.phase, running: F1.game.running, status: __t.text('mp-status'), toast: __t.text('hud-toast'), hud: __t.text('hud-gp'), hudShown: __t.shown('hud-gp'), spec: F1.game.spec.id, year: F1.net.year })`);
  note('B after the host left: ' + J(bAfter));
  await B.shot('room-10-guest-host-left');
  check('guest: back to free practice and own season when the host leaves', !bAfter.connected && bAfter.phase === 'free' && !bAfter.hudShown, bAfter);
  await B.tap('Escape'); await sleep(200);
  note('B menu after the host left: ' + J(await B.js(MENU_STATE)));
  await B.shot('room-11-guest-menu-after');
  note('A after leaving: ' + J(await A.js(MENU_STATE)));
  await A.noErrors(); await B.noErrors();
  await L.close(A); await L.close(B);
}

/* ================= host migration on a dedicated server ================= */
async function partMigrate() {
  state.part = 'migrate';
  const port = PORT + 5;
  const srv = cp.spawn(process.execPath, [path.join(ROOT, 'net', 'server.js'), String(port)], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => console.log('[srv] ' + String(d).trim()));
  srv.stderr.on('data', d => console.log('[srv err] ' + String(d).trim()));
  await sleep(1200);
  const A = makeWin('MA'), B = makeWin('MB');
  for (const w of [A, B]) await w.open();
  await A.field('mp-name', 'Ann'); await A.field('mp-addr', '127.0.0.1:' + port);
  await B.field('mp-name', 'Ben'); await B.field('mp-addr', '127.0.0.1:' + port);
  await A.click('#tab-mp'); await A.click('mp-join');
  check('A joins the dedicated server as host', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.js(`__t.text('mp-status')`));
  note('A status: ' + J(await A.js(MENU_STATE)));
  await A.shot('migrate-01-first-joiner');
  await B.click('#tab-mp'); await B.click('mp-join');
  check('B joins', await B.until(`F1.net.connected && !F1.net.isHost`, 6000));
  await A.pickYear(2021);
  await B.until(`F1.net.year === 2021`, 4000);
  await A.pickTrack('it-1922');
  await B.until(`F1.game.running`, 15000);
  await sleep(800);
  await A.tap('Escape'); await A.click('#tab-mp'); await A.click('mp-leave');
  check('B becomes the host', await B.until(`F1.net.isHost`, 6000));
  await sleep(600);
  await B.tap('Escape'); await sleep(200);
  const m = await B.js(MENU_STATE);
  note('B menu as the new host: ' + J(m));
  await B.shot('migrate-02-new-host-menu');
  await B.click('#tab-mp'); await B.shot('migrate-03-new-host-mp-tab');
  note('B mp tab: ' + J(await B.js(`({ host: __t.shown('mp-host'), status: __t.text('mp-status'), players: __t.text('mp-players') })`)));
  check('new host: year unlocked, track grid unlocked, GP start enabled', !m.yearDisabled && !m.gpStart && !/等待房主/.test(m.lock), m);
  // the new host picks another track and starts a GP
  check('new host picks a track', await B.pickTrack('mc-1929', 15000));
  await B.tap('Escape'); await B.click('#tab-gp');
  check('new host starts a Grand Prix', await B.click('gp-start') && await B.until(`F1.game.gp.phase === 'quali'`, 4000));
  await B.noErrors(); await A.noErrors();
  await L.close(A); await L.close(B);
  srv.kill();
}

/* ================= gamepad connect / disconnect ================= */
async function partPad() {
  state.part = 'pad';
  const w = makeWin('pad');
  await w.open();
  await w.pickTrack('it-1922');
  await sleep(300);
  await w.js(`__t.fakePad(); true`);
  await w.js(`__btn(0, 1); true`); await sleep(250); await w.js(`__btn(0, 0); true`); await sleep(250);
  const p1 = await w.js(`({ connected: F1.gamepad.state.connected, hintKeys: __t.shown('hud-hint-keys'), hintPad: __t.shown('hud-hint-pad'), toast: __t.text('hud-toast') })`);
  note('pad appears (A pressed): ' + J(p1));
  await w.shot('pad-01-connected');
  await w.tap('Escape'); await sleep(200);
  await w.shot('pad-02-menu-pad');
  note('menu pad status: ' + J(await w.js(`({ st: __t.shown('pad-status'), title: document.getElementById('pad-status').title })`)));
  // Start resumes
  await w.js(`__btn(9, 1); true`); await sleep(200); await w.js(`__btn(9, 0); true`); await sleep(200);
  note('Start in the menu: running=' + await w.js(`F1.game.running`));
  // Start opens the menu
  await w.js(`__btn(9, 1); true`); await sleep(200); await w.js(`__btn(9, 0); true`); await sleep(200);
  note('Start while driving: running=' + await w.js(`F1.game.running`));
  await w.js(`__btn(9, 1); true`); await sleep(200); await w.js(`__btn(9, 0); true`); await sleep(200);
  // unplug while RT held
  await w.js(`__btn(7, 1); true`); await sleep(1500);
  const v1 = await w.js(`F1.game.car.state.speed * 3.6`);
  await w.js(`window.__padOn = false; window.dispatchEvent(new Event('gamepaddisconnected')); true`); await sleep(600);
  const p2 = await w.js(`({ connected: F1.gamepad.state.connected, hintKeys: __t.shown('hud-hint-keys'), hintPad: __t.shown('hud-hint-pad'), toast: __t.text('hud-toast'), thr: F1.game.car.state.throttle, v: F1.game.car.state.speed * 3.6 })`);
  note('pad unplugged with RT held (v was ' + v1.toFixed(0) + '): ' + J(p2));
  await w.shot('pad-03-disconnected');
  await w.noErrors();
  await L.close(w);
}

/* ================= per-frame cost (JS, excluding the render) ================= */
async function partPerf() {
  state.part = 'perf';
  const w = makeWin('perf');
  await w.open();
  await w.js(`(function () { var raf = window.requestAnimationFrame; window.__perf = { s: [], render: 0 };
    window.requestAnimationFrame = function (fn) { return raf.call(window, function (t) { var a = performance.now(); __perf.render = 0; fn(t); var b = performance.now(); __perf.s.push([b - a, __perf.render]); if (__perf.s.length > 2000) __perf.s.shift(); }); };
    __perf.hook = function () { var cam = F1.game.camera, sc = cam; while (sc && !sc.isScene) sc = sc.parent; if (!sc) return false;
      sc.onBeforeRender = function (r) { if (r.__hooked) return; r.__hooked = true; var real = r.render; r.render = function (s, c) { var a = performance.now(); var out = real.call(r, s, c); __perf.render += performance.now() - a; return out; }; }; return true; };
    __perf.stats = function () { var s = __perf.s.slice(-600), js = s.map(function (x) { return x[0] - x[1]; }).sort(function (a, b) { return a - b; }), tot = s.map(function (x) { return x[0]; }).sort(function (a, b) { return a - b; });
      var q = function (arr, p) { return +arr[Math.floor(arr.length * p)].toFixed(2); }; return { n: s.length, jsMed: q(js, 0.5), js90: q(js, 0.9), js99: q(js, 0.99), totMed: q(tot, 0.5), tot90: q(tot, 0.9) }; };
    return true; })()`);
  for (const id of ['it-1922', 'mc-1929', 'be-1925']) {
    await w.pickTrack(id);
    note('hook ' + await w.js(`__perf.hook()`));
    w.key('W', true); await sleep(5000);
    note(id + ' driving: ' + J(await w.js(`__perf.stats()`)));
    w.key('W', false);
    await w.tap('Escape'); await sleep(100);
  }
  await w.noErrors();
  await L.close(w);
}

const PARTS = { menu: partMenu, drive: partDrive, gp: partGp, room: partRoom, migrate: partMigrate, pad: partPad, perf: partPerf };
app.whenReady().then(async () => {
  const t0 = Date.now();
  for (const k of Object.keys(PARTS)) {
    if (ONLY.length && ONLY.indexOf(k) < 0) continue;
    try { await PARTS[k](); } catch (e) { check(k + ' part threw', false, String(e && e.stack || e)); }
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed in ' + Math.round((Date.now() - t0) / 1000) + ' s' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  await L.host.stopServer();
  app.exit(bad.length ? 1 : 0);
});
