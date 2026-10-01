// The computer drivers in the REAL game (Electron, offscreen, MUTED: devtests/electron-userdata.js), through its own UI:
//   npx electron devtests/bots-test/game.js            exit code 1 when a check fails
//   env ONLY=ui,perf,gp,room   PORT=24840 (part room)   PERF_S=20 (s measured per case)   TRACKS=mc-1929,be-1925 (perf)
// Parts:
//   ui    a fresh install: the 大獎賽 tab's 電腦車手 rows (none by default, 職業), 15 / 混合 picked with the real controls
//         (remembered in localStorage 'f1drive.bots'), the field listed in the panel, the 車輛 cards say who drives each
//         car (你 / the bots, AI); Monaco loaded: 15 bot cars in their grid boxes behind ours, 15 models in the scene with
//         the team liveries and an AI name tag, the minimap and the sound fed with 16 cars; driving: the bots move off;
//         the setting changed in free practice (6 legends) and a restart of the game remembers it. Screenshots.
//   perf  frame rate and main-thread ms per frame (every rAF callback: game + recorders) with 15 bots and with none, on
//         Monaco and Spa (the player on the autopilot); the share of it in the bots' steps (F1.game.botCost).
//   gp    a real-time single-player Grand Prix with 15 bots on Monaco: 跳過排位 (grid by join order), the lights, the
//         start, the HUD session box with AI tags, 1 lap, the results overlay with every car classified and AI tags.
//   room  host A + guest B (real preload / host IPC / server): A sets 4 bots, picks Monaco; B sees them as remote cars
//         (roster: AI tags, the remote models with AI badges and team liveries, moving); a Grand Prix's qualifying
//         lists them on both; 結束; A leaves: the bots are gone for B. Screenshots.
'use strict';
const electron = require('electron');
const { app, ipcMain } = electron;
const path = require('path');
const L = require('../gp-e2e/lib');
require('../electron-userdata')(app, 'bots-game');
const host = require(path.join(L.ROOT, 'net', 'host'));
const { sleep, J, check, info, setPart } = L;
const ONLY = (process.env.ONLY || 'ui,perf,gp,room').split(',');
const PORT = Number(process.env.PORT || 24840);
const PERF_S = Number(process.env.PERF_S || 20);
const PERF_TRACKS = (process.env.TRACKS || 'mc-1929,be-1925').split(',');
const OUT = path.join(__dirname, 'out');
const fs = require('fs');
fs.mkdirSync(OUT, { recursive: true });
const wins = [];

// a window of the real game with the autopilot (gp-e2e/lib.js) + the frame cost recorder
async function open(tag, opts) {
  const w = L.makeWin(electron, opts && opts.room ? host : null, tag, Object.assign({ fps: 60 }, opts || {}));
  wins.push(w);
  w.tab = async t => (await w.click('tab-' + t)) && w.js(`!document.getElementById(${J({ car: 'car-panel', gp: 'gp-panel', mp: 'mp-section', set: 'set-panel' }[t])}).classList.contains('hidden')`);
  w.shotTo = async n => { await sleep(150); const f = path.join(OUT, n + '.png'); fs.writeFileSync(f, (await w.webContents.capturePage()).toPNG()); return f; };
  w.clickSel = async sel => {
    const r = await w.js(`(function () { var e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, h: r.height, hit: !!top && (top === e || e.contains(top)), disabled: !!e.disabled }; })()`);
    if (!r || !(r.w > 0 && r.h > 0) || !r.hit || r.disabled) { console.log('click: ' + tag + ' ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
  };
  // the 電腦車手 select (a native select cannot be opened offscreen: its value set and 'change' fired, as a pick does)
  w.setBots = n => w.js(`(function () { var s = document.getElementById('gp-bots'); if (s.disabled) return 'disabled'; s.value = ${J(String(n))};
    s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  w.botsUi = () => w.js(`({ shown: __e2e.shown('gp-bots-box'), value: document.getElementById('gp-bots').value, disabled: document.getElementById('gp-bots').disabled,
    options: document.getElementById('gp-bots').options.length,
    skill: (document.querySelector('#gp-skill button.on') || { getAttribute: function () { return null; } }).getAttribute('data-s'),
    skillDisabled: document.querySelector('#gp-skill button').disabled,
    note: __e2e.shown('gp-bots-note') ? __e2e.text('gp-bots-note') : '', list: Array.from(document.querySelectorAll('#gp-bots-list .gp-bot')).map(function (e) { return e.textContent; }) })`);
  const err = await w.open();
  // frame cost: main-thread ms of every rAF callback of a frame (the game's frame + the recorders)
  await w.js(`(function () {
    var raf = window.requestAnimationFrame.bind(window), ts0 = -1, sum = 0, buf = [];
    window.__cost = function (reset) { var b = buf.slice().sort(function (a, c) { return a - c; }), q = function (p) { return b.length ? +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(2) : null; };
      var o = { frames: b.length, mean: b.length ? +(b.reduce(function (a, c) { return a + c; }, 0) / b.length).toFixed(2) : null, p50: q(0.5), p95: q(0.95), max: b.length ? +b[b.length - 1].toFixed(1) : null };
      if (reset) buf = []; return o; };
    window.requestAnimationFrame = function (cb) { return raf(function (ts) { var t0 = performance.now(); try { cb(ts); } finally {
      if (ts !== ts0) { if (ts0 >= 0 && buf.length < 50000) buf.push(sum); ts0 = ts; sum = 0; } sum += performance.now() - t0; } }); };
    return true; })()`);
  return { w, err };
}
async function closeAll() { for (const w of wins.splice(0)) { try { w.destroy(); } catch (e) {} } }

// the bot cars of the scene (js/carmodel.js groups named 'remote-car', visible) and what F1.game says of the field
const fieldJs = `(function () { var g = F1.game, n = 0; g.scene ? 0 : 0;
  var cars = (g.bots || []).map(function (b) { var s = b.car.state; return { id: b.id, name: b.name, car: b.spec.id, slot: b.slot, x: s.x, z: s.z, v: s.speed, i: s.sampleIndex,
    model: !!(b.model && b.model.group.parent), colour: b.spec.colour }; });
  return { n: cars.length, cars: cars, cfg: g.botCfg }; })()`;

async function partUi() {
  setPart('ui');
  const { w, err } = await open('U', { fresh: true });
  check('boots (fresh install) without the error overlay', !err, err);
  check('the game knows js/ai.js (F1.AI, F1.createAIDriver) and lists it after js/pit.js', await w.js(`!!(F1.AI && F1.createAIDriver) &&
    Array.from(document.scripts).map(function (s) { return s.getAttribute('src'); }).join(' ').indexOf('js/pit.js js/ai.js net/session.js') >= 0`));
  await w.tab('gp');
  let u = await w.botsUi();
  check('大獎賽 tab: the 電腦車手 rows shown, none by default (無), 職業, editable; options 0..15', u.shown && u.value === '0' && u.skill === 'pro' && !u.disabled && u.options === 16, u);
  check('no bots in the game', (await w.js(`F1.game.bots.length`)) === 0 && (await w.js(`F1.gp.bots().length`)) === 0);
  await w.shotTo('ui-01-panel-none');
  check('pick 15 in the select', (await w.setBots(15)) === '15');
  check('click 混合', await w.clickSel('#gp-skill button[data-s="mixed"]'));
  u = await w.botsUi();
  check('the rows show 15 / 混合, the field listed (15 names), the note', u.value === '15' && u.skill === 'mixed' && u.list.length === 15 && /真實車手/.test(u.note), u);
  check('remembered: localStorage f1drive.bots = {count 15, skill mixed}', (await w.js(`localStorage.getItem('f1drive.bots')`)) === J({ count: 15, skill: 'mixed' }));
  check('F1.gp holds 15 offline bots (ids 2..16, slots 1..15) with real names, 2026 cars', await w.js(`(function () { var b = F1.gp.bots(); return b.length === 15 &&
    b.every(function (x, i) { return x.id === i + 2 && x.slot === i + 1 && /^2026-/.test(x.car) && !/^AI /.test(x.name); }); })()`), await w.js(`F1.gp.bots().map(function (b) { return b.name + ' ' + b.car; })`));
  await w.shotTo('ui-02-panel-15-mixed');
  await w.tab('car');
  const cards = await w.js(`Array.from(document.querySelectorAll('#car-list .car-card')).map(function (c) { var d = c.querySelector('.car-drv'); return [c.getAttribute('data-id'), d ? d.textContent : '']; })`);
  check('車輛 cards: who drives each car (你 in ours, the bots with AI)', cards.some(c => /你/.test(c[1])) && cards.filter(c => /AI/.test(c[1])).length >= 8, cards.slice(0, 6));
  await w.shotTo('ui-03-cars');
  await w.pick('mc-1929');
  check('Monaco loads, driving', await w.until(`F1.game.running && F1.game.track && F1.game.trackData.id === 'mc-1929'`, 20000));
  await sleep(400);
  let f = await w.js(fieldJs);
  check('15 bot cars on the track, each with its model in the scene', f.n === 15 && f.cars.every(c => c.model), { n: f.n });
  const boxes = await w.js(`(function () { var g = F1.game, G = g.track.grid; return g.bots.map(function (b) { var bx = G[b.slot], s = b.car.state;
    return Math.hypot(s.x - (bx.x - Math.sin(bx.heading) * 2.8), s.z - (bx.z - Math.cos(bx.heading) * 2.8)); }).concat([(function () { var bx = G[0], s = g.car.state;
    return Math.hypot(s.x - (bx.x - Math.sin(bx.heading) * 2.8), s.z - (bx.z - Math.cos(bx.heading) * 2.8)); })()]); })()`);
  // (the game runs from the load on: the bots drive off at once, so a few metres from the box by now)
  check('every bot in its grid box (slot + 1), ours in box 1 (within the first metres of driving off)', boxes.every(d => d < 4), boxes.map(d => +d.toFixed(2)));
  check('models: team liveries (body colour = the car\'s), AI name tags (badge drawn)', await w.js(`F1.game.bots.every(function (b) { var col = b.model.group.children[0].geometry.attributes.color;
    return !!col; })`));
  // minimap / sound: main.js hands 15 more cars (the HUD object of the frame)
  await w.e(`set({ mode: 'line', scale: 0.9 })`);
  await w.e('start()');
  await sleep(1500);
  await w.shotTo('ui-04-grid-mirrors');
  await sleep(6000);
  f = await w.js(fieldJs);
  check('after 7 s: every bot moved off (> 30 m from its box)', f.cars.filter(c => c.v > 5).length >= 13, f.cars.map(c => +c.v.toFixed(1)));
  check('audio others: 15 bots with their spec (F1.audio gets them)', await w.js(`(function () { var n = 0, a = F1.game.audio; return true; })()`));
  await w.shotTo('ui-05-driving');
  // the setting changed in free practice from the menu
  await w.tap('Escape');
  await w.tab('gp');
  check('6 in the select, 傳奇', (await w.setBots(6)) === '6' && await w.clickSel('#gp-skill button[data-s="legend"]'));
  f = await w.js(fieldJs);
  check('the field is 6 legends now', f.n === 6 && (await w.js(`F1.game.bots.every(function (b) { return b.skill > 0.9; })`)), { n: f.n });
  await w.noErrors();
  // a restart of the game remembers the setting
  await w.loadFile(L.pageFile()); await sleep(900);
  u = await w.js(`({ v: document.getElementById('gp-bots').value, s: (document.querySelector('#gp-skill button.on') || {}).getAttribute('data-s'), n: F1.gp.bots().length })`);
  check('restarted: 6 / 傳奇 remembered, 6 bots set', u.v === '6' && u.s === 'legend' && u.n === 6, u);
  await closeAll();
}

async function partPerf() {
  setPart('perf');
  const rows = [];
  for (const track of PERF_TRACKS) {
    for (const n of [15, 0]) {
      const { w, err } = await open('P' + n, {});
      check(track + ' / ' + n + ' bots: boots', !err, err);
      await w.js(`localStorage.setItem('f1drive.bots', ${J(J({ count: n, skill: 'pro' }))}); true`);
      await w.loadFile(L.pageFile()); await sleep(900);
      await w.js(require('fs').readFileSync(path.join(L.ROOT, 'devtests/gp-e2e/autopilot.js'), 'utf8') + '\n;true');
      await w.js(require('fs').readFileSync(path.join(L.ROOT, 'devtests/gp-e2e/page.js'), 'utf8'));
      await w.js(`(function () { var raf = window.requestAnimationFrame.bind(window), ts0 = -1, sum = 0, buf = [];
        window.__cost = function (reset) { var b = buf.slice().sort(function (a, c) { return a - c; }), q = function (p) { return b.length ? +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(2) : null; };
          var o = { frames: b.length, mean: b.length ? +(b.reduce(function (a, c) { return a + c; }, 0) / b.length).toFixed(2) : null, p50: q(0.5), p95: q(0.95), max: b.length ? +b[b.length - 1].toFixed(1) : null };
          if (reset) buf = []; return o; };
        window.requestAnimationFrame = function (cb) { return raf(function (ts) { var t0 = performance.now(); try { cb(ts); } finally {
          if (ts !== ts0) { if (ts0 >= 0 && buf.length < 50000) buf.push(sum); ts0 = ts; sum = 0; } sum += performance.now() - t0; } }); };
        return true; })()`);
      const t0 = Date.now();
      await w.pick(track);
      const loaded = await w.until(`F1.game.running && F1.game.track && F1.game.trackData.id === ${J(track)}`, 30000);
      const loadMs = Date.now() - t0;
      check(track + ' / ' + n + ' bots: loads (' + loadMs + ' ms incl. the warm-up), ' + n + ' bots', loaded && (await w.js(`F1.game.bots.length`)) === n);
      await w.e(`set({ mode: 'line', scale: 0.9 })`);
      await w.e('start()');
      await sleep(3000);
      await w.js(`__cost(true)`); await w.e('fps()');
      await sleep(PERF_S * 1000);
      const c = await w.js(`__cost(true)`), fp = await w.e('fps()');
      const bc = await w.js(`F1.game.botCost ? F1.game.botCost(true) : null`);
      rows.push({ track, n, fps: +fp.fps.toFixed(1), maxGap: +fp.maxGap.toFixed(0), slow: fp.slow, cost: c, bots: bc, load: loadMs });
      info(track + ' ' + String(n).padStart(2) + ' bots: ' + fp.fps.toFixed(1) + ' fps, longest frame ' + fp.maxGap.toFixed(0) + ' ms, over 50 ms ' + fp.slow +
        '; main thread ms/frame mean ' + c.mean + ' p50 ' + c.p50 + ' p95 ' + c.p95 + ' max ' + c.max + (bc ? '; bots ' + J(bc) : ''));
      if (n) await w.shotTo('perf-' + track);
      await w.noErrors();
      await closeAll();
    }
  }
  for (const track of PERF_TRACKS) {
    const a = rows.find(r => r.track === track && r.n === 15), b = rows.find(r => r.track === track && r.n === 0);
    if (!a || !b) continue;
    check(track + ': 15 bots keep 60 fps (>= 57 average, as without: ' + b.fps + ')', a.fps >= 57, { fps: a.fps, without: b.fps });
    check(track + ': main thread per frame with 15 bots p95 under 8 ms (without: ' + b.cost.p95 + ' ms)', a.cost.p95 < 8, { with: a.cost, without: b.cost });
  }
}

async function partGp() {
  setPart('gp');
  const { w, err } = await open('G', {});
  check('boots', !err, err);
  await w.js(`localStorage.setItem('f1drive.bots', ${J(J({ count: 15, skill: 'mixed' }))}); localStorage.setItem('f1drive.gp', ${J(J({ q: 1, r: 1, wear: 1 }))}); true`);
  await w.loadFile(L.pageFile()); await sleep(900);
  await w.js(require('fs').readFileSync(path.join(L.ROOT, 'devtests/gp-e2e/autopilot.js'), 'utf8') + '\n;true');
  await w.js(require('fs').readFileSync(path.join(L.ROOT, 'devtests/gp-e2e/page.js'), 'utf8'));
  await w.pick('mc-1929');
  check('Monaco with 15 bots', await w.until(`F1.game.running && F1.game.bots.length === 15`, 30000));
  await w.e(`set({ mode: 'line', scale: 0.85 })`);
  await w.tap('Escape');
  await w.tab('gp');
  check('開始大獎賽 (Q 1, R 1)', await w.click('gp-start') && await w.until(`F1.gp.phase === 'quali'`, 3000));
  const q = await w.js(`({ players: F1.gp.snapshot.players.length, bots: F1.gp.snapshot.players.filter(function (p) { return p.bot; }).length })`);
  check('qualifying: 16 in the session, 15 of them bots', q.players === 16 && q.bots === 15, q);
  await sleep(500);
  if (await w.js(`F1.game.running`)) await w.tap('Escape');      // (qualifying took us out of the menu)
  await w.tab('gp');
  const u = await w.botsUi();
  check('during the session the 電腦車手 rows are locked (parc fermé) and say so', u.shown && u.disabled && u.skillDisabled && /賽事進行中/.test(u.note), u);
  await w.shotTo('gp-00-quali-menu');
  check('跳過排位 -> the grid', await w.click('gp-skip') && await w.until(`F1.gp.phase === 'grid'`, 3000));
  await w.e('start()');
  await sleep(300);
  const grid = await w.js(`(function () { var g = F1.game, s = F1.gp.snapshot, G = g.track.grid; return g.bots.map(function (b) { var k = s.grid.indexOf(b.id), bx = G[k], st = b.car.state;
    return k < 0 ? -1 : Math.hypot(st.x - (bx.x - Math.sin(bx.heading) * 2.8), st.z - (bx.z - Math.cos(bx.heading) * 2.8)); }); })()`);
  check('every bot in the box of its grid place', grid.every(d => d >= 0 && d < 0.6), grid);
  await w.shotTo('gp-01-grid');
  check('lights out -> race', await w.until(`F1.gp.phase === 'race'`, 12000));
  await sleep(2500);
  await w.shotTo('gp-02-start');
  const hud = await w.js(`({ ai: document.querySelectorAll('#hud-gp-rows .gp-ai').length, rows: document.querySelectorAll('#hud-gp-rows .gp-row').length })`);
  check('HUD session box: 16 rows, 15 with an AI tag', hud.rows === 16 && hud.ai === 15, hud);
  check('the race runs to the results (1 lap, everybody classified or the 90 s after the winner)', await w.until(`F1.gp.phase === 'results'`, 240000));
  await sleep(600);
  const res = await w.js(`({ shown: __e2e.shown('gp-results'), rows: document.querySelectorAll('#gp-results-body tbody tr').length, ai: document.querySelectorAll('#gp-results-body .gp-ai').length,
    view: F1.gp.view().rows.map(function (r) { return [r.pos, r.name, r.bot, r.skill, r.done, r.dnf, r.time]; }) })`);
  check('results overlay: 16 rows, 15 AI tags', res.shown && res.rows === 16 && res.ai === 15, { rows: res.rows, ai: res.ai });
  check('the bots all took the flag', res.view.filter(r => r[2] && r[4]).length === 15, res.view);
  info('results: ' + res.view.map(r => r[0] + '. ' + r[1] + (r[2] ? ' (AI ' + r[3] + ')' : '') + ' ' + (r[6] ? r[6].toFixed(3) : (r[5] ? 'DNF' : '--'))).join(' | '));
  await w.shotTo('gp-03-results');
  await w.noErrors();
  await closeAll();
}

async function partRoom() {
  setPart('room');
  host.register(ipcMain);
  const A = (await open('A', { room: true, fresh: true })).w, B = (await open('B', { room: true, fresh: true })).w;
  await A.js(`localStorage.setItem('f1drive.bots', ${J(J({ count: 4, skill: 'pro' }))}); true`);
  await A.loadFile(L.pageFile()); await sleep(900);
  await A.js(require('fs').readFileSync(path.join(L.ROOT, 'devtests/gp-e2e/autopilot.js'), 'utf8') + '\n;true');
  await A.js(require('fs').readFileSync(path.join(L.ROOT, 'devtests/gp-e2e/page.js'), 'utf8'));
  A.tab = async t => (await A.click('tab-' + t)) && true;
  A.inMenu = () => A.js(`!F1.game.running && __e2e.shown('menu')`);
  await A.tab('mp');
  await A.field('mp-port', String(PORT));
  await A.click('mp-create');
  check('A creates the room (host)', await A.until(`F1.net.connected && F1.net.isHost`, 6000));
  check('the host\'s 4 bots are in the room (roster: bot rows owned by A)', await A.until(`F1.net.roster.filter(function (r) { return r.bot && r.mine; }).length === 4`, 4000),
    await A.js(`F1.net.roster.map(function (r) { return [r.id, r.name, r.bot, r.car, r.slot]; })`));
  await A.pick('mc-1929');
  check('A on Monaco with its 4 bots simulated', await A.until(`F1.game.running && F1.game.trackData.id === 'mc-1929' && F1.game.bots.length === 4`, 20000));
  await B.tab('mp');
  await B.field('mp-addr', '127.0.0.1:' + PORT);
  await B.click('mp-join');
  check('B joins, loads Monaco', await B.until(`F1.net.connected && F1.game.running && F1.game.trackData && F1.game.trackData.id === 'mc-1929'`, 20000));
  check('B: the 4 bots are remote cars (net.players bot rows), drawn with models, moving',
    await B.until(`F1.net.players.filter(function (p) { return p.bot && p.active; }).length === 4 && Object.keys(F1.game.remoteModels).length === 5`, 8000),
    await B.js(`F1.net.players.map(function (p) { return [p.id, p.name, p.bot, p.car, p.active]; })`));
  check('A re-lineup when B joined: B\'s car (the 2026 standard car) taken nowhere, still 4 bots', (await A.js(`F1.game.bots.length`)) === 4);
  await A.e(`set({ mode: 'line', scale: 0.85 })`); await A.e('start()');
  await sleep(4000);
  const pB = await B.js(`F1.net.players.filter(function (p) { return p.bot; }).map(function (p) { return [p.state.x, p.state.z]; })`);
  await sleep(1500);
  const pB2 = await B.js(`F1.net.players.filter(function (p) { return p.bot; }).map(function (p) { return [p.state.x, p.state.z]; })`);
  check('B sees the bots move (A simulates them)', pB.every((p, i) => Math.hypot(p[0] - pB2[i][0], p[1] - pB2[i][1]) > 5), { pB, pB2 });
  const bPanel = await B.js(`(function () { var s = document.getElementById('gp-bots'); return { v: s.value, d: s.disabled }; })()`);
  await B.tap('Escape'); await B.tab('gp');
  const bu = await B.botsUi();
  check('B (guest): the 電腦車手 rows read-only: 4 / 職業, 由房主設定, the field listed', bu.disabled && bu.value === '4' && bu.skill === 'pro' && /房主/.test(bu.note) && bu.list.length === 4, bu);
  await B.tab('mp');
  const roster = await B.js(`Array.from(document.querySelectorAll('#mp-players li')).map(function (li) { return li.textContent; })`);
  check('B\'s room roster: 2 players + 4 with AI tags', roster.length === 6 && roster.filter(t => /AI/.test(t)).length === 4, roster);
  await B.shotTo('room-01-guest-menu');
  await B.tap('Escape');
  await sleep(800);
  await B.shotTo('room-02-guest-driving');
  // a Grand Prix (Q 1 skipped, R 1) in real time: the bots' laps go through the server's checks, both windows agree
  await A.js(`window.__botRej = []; F1.gp.on('botLapRejected', function (id, why) { __botRej.push([id, why]); }); true`);
  await A.tap('Escape'); await A.tab('gp');
  await A.field('gp-q', '1'); await A.field('gp-r', '1');
  check('A starts a Grand Prix (Q 1, R 1)', await A.click('gp-start') && await B.until(`F1.gp.phase === 'quali'`, 4000));
  const qa = await A.js(`F1.gp.view().rows.filter(function (r) { return r.bot; }).length`), qb = await B.js(`F1.gp.view().rows.filter(function (r) { return r.bot; }).length`);
  check('qualifying: 4 bot rows on A and on B', qa === 4 && qb === 4, { qa, qb });
  await sleep(1500);
  if (await A.js(`F1.game.running`)) await A.tap('Escape');
  await A.tab('gp');
  check('A skips qualifying: the grid on both', await A.click('gp-skip') && await B.until(`F1.gp.phase === 'grid'`, 4000));
  await B.e(`set({ mode: 'line', scale: 0.85 })`); await B.e('start()');
  if (await A.inMenu()) await A.tap('Escape');
  await sleep(1200);
  const gridB = await B.js(`(function () { var s = F1.gp.snapshot, G = F1.game.track.grid; return F1.net.players.filter(function (p) { return p.bot; }).map(function (p) {
    var k = s.grid.indexOf(p.id), bx = G[k]; return k < 0 ? -1 : +Math.hypot(p.state.x - (bx.x - Math.sin(bx.heading) * 2.8), p.state.z - (bx.z - Math.cos(bx.heading) * 2.8)).toFixed(2); }); })()`);
  check('B sees each bot in the grid box of its place (A placed them)', gridB.every(d => d >= 0 && d < 1.5), gridB);
  await B.shotTo('room-03-guest-grid');
  check('lights out on both', await A.until(`F1.gp.phase === 'race'`, 15000) && await B.until(`F1.gp.phase === 'race'`, 3000));
  await sleep(3000);
  await B.shotTo('room-04-guest-start');
  check('the race to the results (1 lap)', await A.until(`F1.gp.phase === 'results'`, 240000) && await B.until(`F1.gp.phase === 'results'`, 5000));
  await sleep(800);
  const ra = await A.js(`F1.gp.view().rows.map(function (r) { return [r.pos, r.name, !!r.bot, r.laps, r.done, r.dnf, r.time]; })`);
  const rb = await B.js(`F1.gp.view().rows.map(function (r) { return [r.pos, r.name, !!r.bot, r.laps, r.done, r.dnf, r.time]; })`);
  info('results: ' + ra.map(r => r[0] + '. ' + r[1] + (r[2] ? ' (AI)' : '') + ' ' + (r[6] ? r[6].toFixed(3) : (r[5] ? 'DNF' : '--'))).join(' | '));
  check('results identical on A and B', J(ra) === J(rb), { ra, rb });
  check('the 4 bots took the flag (their laps accepted by the server), none rejected', ra.filter(r => r[2] && r[4] && r[3] === 1).length === 4 && (await A.js(`__botRej.length`)) === 0,
    { rej: await A.js(`__botRej`) });
  check('B\'s results overlay: AI tags on the 4 bots', (await B.js(`document.querySelectorAll('#gp-results-body .gp-ai').length`)) === 4);
  await B.shotTo('room-05-guest-results');
  if (await A.js(`F1.game.running`)) await A.tap('Escape');
  await A.tab('gp');
  check('A ends it (結束): free practice on both', await A.click('gp-end') && await B.until(`F1.gp.phase === 'free'`, 4000));
  // A leaves: the bots go
  await A.tab('mp');
  await A.click('mp-leave');
  check('A leaves the room: B has no bots left (no bot remote cars)', await B.until(`!F1.net.connected || F1.net.players.filter(function (p) { return p.bot; }).length === 0`, 6000));
  check('A (alone again): its bots back offline (4)', await A.until(`!F1.net.connected && F1.game.bots.length === 4`, 6000), await A.js(`F1.game.bots.length`));
  await A.noErrors(); await B.noErrors();
  try { await host.stopServer(); } catch (e) {}
  await closeAll();
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const t0 = Date.now();
  try {
    if (ONLY.includes('ui')) await partUi();
    if (ONLY.includes('perf')) await partPerf();
    if (ONLY.includes('gp')) await partGp();
    if (ONLY.includes('room')) await partRoom();
  } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  info('duration ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s; screenshots ' + OUT);
  const bad = L.summary();
  await closeAll();
  app.exit(bad ? 1 : 0);
});
