// The computer drivers (js/ai.js in js/main.js) end to end in the REAL game: offscreen Electron windows, MUTED
// (devtests/electron-userdata.js; never set SOUND), real key / mouse events for the menus, the player's car driven through
// a fake controller by a computer driver of its own (devtests/gp-e2e/bots-page.js: it sees every car, so it races the bots
// instead of driving through them; the line autopilot of solo-page.js would not).
//
//   npx electron devtests/gp-e2e/bots.js            exit code 1 when a check fails (2: the 40-minute watchdog)
//   env ONLY=monza,monaco,panel,ram,pits,blue,suzuka,room,host,perf      (default: all)
//       PORT (24893: part room's in-game server), PORT2 (24894: part host's dedicated server)
//       FRAME_MS (1000/60: the warped frame pace)   VERBOSE=1 (the field after every race)
//   Screenshots: devtests/gp-e2e/out-bots/<part>-NN-<what>.png (READ them).
//
// Parts (time-warped like solo.js: the page's requestAnimationFrame pumped with synthetic 1/60 s frames, solo-page.js):
//   monza, monaco   a single-player Grand Prix with 15 computer drivers of mixed strength (混合), set up in the 大獎賽 tab
//                   (select 15, 混合, 輪胎損耗 ×2, Q 1 / R 3 typed): the field (real names, the season's cars, our teammate),
//                   the boxes, free practice, qualifying (ghosts: no contact; every car's lap; the player's lap = ground
//                   truth), the grid by the times (every car in the box of its place), the lights, the start (no pile-up),
//                   the race (overtakes, contacts, nobody stuck, bots' tyres / stops, at Monza our own stop through a lane
//                   with bots), the results (everybody classified, the order follows the strength: legends ahead of
//                   rookies, race times against each driver's own qualifying lap), the results overlay with AI tags, no
//                   error.
//   panel           the 電腦車手 / 強度 controls changed while on the track (Monza free practice): 15 -> 6 (the others'
//                   models gone), 傳奇, 15 again (new cars put down clear of everybody), 0.
//   ram             a bot running into us: we stop on the racing line out of Monza's Variante della Roggia for 45 s with
//                   15 bots lapping (free practice): they go round us (yellow flag), how hard anything hits us, the
//                   controller's rumble, nobody stuck behind us for long; then we run into the back of a bot on a
//                   straight (both cars take the impact, the pad rumbles, it drives on).
//   pits            the pit lane full of bots: a Monza race (R 3, qualifying skipped) in which we stall for 12 s at the
//                   start and then race through the field (overtakes by us); on lap 2 every bot and we are told to stop:
//                   the lane full at once, every car served in its own box, no speeding, no contact on the pit asphalt.
//   blue            blue flags: a Monaco race (R 3) in which one rookie parks in its box after lap 1 and is released when
//                   the leaders are a lap up: it gives way (ai.stats.yields), the cars a lap up get by, no heavy contact.
//   suzuka          Suzuka's bridge with a field of 15: a 1-lap race from the grid, every bot over and under the bridge on
//                   its own road (no lap-counter jump, no void lap, no rejected lap, no contact across the levels).
// Real time:
//   room            host A (in-game server) + guest B + 6 bots (混合) on Monaco, Q 1 / R 2, both players on their computer
//                   drivers: B sees the bots where A simulates them, the same standings live, the same grid and results,
//                   every bot lap accepted by the server; A leaves after the results: B has no bots left.
//   host            the dedicated server (host migration): A (host, 3 bots) + B; A leaves in the middle of the race: his
//                   bots are gone for B, the race closes with them DNF, B is the host.
//   perf            frame rate and main-thread ms per frame at a race start with 15 bots (the whole field in a pack,
//                   every contact resolved) on Monaco and Spa.
'use strict';
const electron = require('electron');
const { app, ipcMain, BrowserWindow } = electron;
const fs = require('fs'), path = require('path');
require('../electron-userdata')(app, 'gp-e2e-bots');
const L = require('./lib');
const refCar = require('../ref-car');
const host = require(path.join(L.ROOT, 'net', 'host'));
const { sleep, J, check, info, setPart } = L;
const ONLY = (process.env.ONLY || 'monza,monaco,panel,ram,pits,blue,suzuka,room,host,perf').toLowerCase().split(',').filter(Boolean);
const PORT = Number(process.env.PORT || 24893), PORT2 = Number(process.env.PORT2 || 24894);
const FRAME_MS = Number(process.env.FRAME_MS) || 1000 / 60;
const VERBOSE = !!process.env.VERBOSE;
const OUT = path.join(__dirname, 'out-bots');
fs.mkdirSync(OUT, { recursive: true });
const SOLO_PAGE = fs.readFileSync(path.join(__dirname, 'solo-page.js'), 'utf8');
const BOTS_PAGE = fs.readFileSync(path.join(__dirname, 'bots-page.js'), 'utf8');
const YEAR = 2026, CAR = '2026-ferrari', CAR_B = '2026-mclaren';
const wins = [];
setTimeout(() => { console.log('WATCHDOG: 40 minutes'); L.summary(); app.exit(2); }, 40 * 60 * 1000).unref();

const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;
const fmt = t => t == null || t !== t ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
// Spearman's rank correlation with average ranks for ties
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b), ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

/* ---------- a time-warped window (solo-page.js + bots-page.js) ---------- */
let winSeq = 0;
function warpWin(tag, pick) {
  const w = new BrowserWindow({ width: 1280, height: 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'bots-' + tag + '-' + (++winSeq),
      preload: path.join(L.ROOT, 'preload.js'), backgroundThrottling: false } });
  wins.push(w);
  w.webContents.setFrameRate(60);
  w.errors = []; w.shots = 0; w.tag = tag; w.wall = 0;
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    w.errors.push(msg);
    console.log('[' + tag + ' console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('renderer gone: ' + d.reason); console.log('[' + tag + '] renderer gone', d.reason); });
  w.js = code => w.webContents.executeJavaScript(code);
  w.overlay = () => w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  w.open = async (prep) => {
    await refCar.seed(w, pick || { year: YEAR, car: CAR });
    if (prep) await w.js(prep);                         // (more localStorage for the page, on the same origin)
    await w.loadFile(L.pageFile());
    await sleep(700);
    const a = await w.js(SOLO_PAGE);
    await w.js(`__e.renderEvery = 0; __e.setPace(${FRAME_MS}, false)`);
    const b = await w.js(BOTS_PAGE);
    return { a, b, overlay: await w.overlay() };
  };
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(30); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  // warped frames until cond (E = __e, F1, g = F1.game; __bots global) holds, at most maxS seconds of game time
  w.pump = async (cond, maxS, what) => {
    const start = await w.js(`__e.clock`), t0 = Date.now();
    try {
      for (;;) {
        const r = await w.js(`__e.run(200000, ${J(cond)}, 150)`);
        if (r.fatal) throw new Error('error overlay: ' + r.fatal);
        if (r.hit) return true;
        if (r.idle || r.clock - start > maxS * 1000) {
          const s = await w.js(`({ phase: F1.gp.phase, clock: __e.clock, running: F1.game.running, v: F1.game.car.state.speed, i: F1.game.car.state.sampleIndex, err: __bots.err })`);
          console.log((r.idle ? 'NOT RUNNING ' : 'TIMEOUT (' + maxS + ' s of game time) ') + tag + ': ' + (what || cond) + '  ' + J(s));
          return false;
        }
      }
    } finally { w.wall += Date.now() - t0; }
  };
  w.advance = async sec => { const t = await w.js(`__e.clock`); return w.pump(`E.clock >= ${t + sec * 1000}`, sec + 5, sec + ' s'); };
  w.shot = async (name, noDraw) => {
    if (!noDraw) await w.js(`__e.draw()`);
    await sleep(220);
    const file = tag + '-' + String(++w.shots).padStart(2, '0') + '-' + name + '.png';
    fs.writeFileSync(path.join(OUT, file), (await w.webContents.capturePage()).toPNG());
    return file;
  };
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: k });
  w.tap = async k => { w.key(k, true); await sleep(50); w.key(k, false); await sleep(80); };
  w.click = async sel => {
    const r = await w.js(`(function () { var e = document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, h: r.height, hit: !!top && (top === e || e.contains(top)), disabled: !!e.disabled }; })()`);
    if (!r || !(r.w > 0) || !r.hit || r.disabled) { console.log('click: ' + tag + ' ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
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
  w.esc = async toMenu => { await w.tap('Escape'); return w.until(toMenu ? `!F1.game.running && __e.shown('menu')` : `F1.game.running && !__e.shown('menu')`, 3000, toMenu ? 'Esc -> menu' : 'Esc -> resume'); };
  w.noErrors = async what => { const o = w.isDestroyed() ? 'destroyed' : await w.overlay(), pe = w.isDestroyed() ? '' : await w.js(`__bots.err`);
    return check(tag + ': no error overlay, no console errors / warnings, no harness error' + (what ? ' (' + what + ')' : ''), !o && w.errors.length === 0 && !pe, o || pe || w.errors.slice(0, 3)); };
  return w;
}
async function closeAll() { for (const w of wins.splice(0)) { try { if (!w.isDestroyed()) w.destroy(); } catch (e) {} } }

// the 電腦車手 select (a native select cannot be opened offscreen: its value set and 'change' fired, as a pick does)
const setBotsJs = n => `(function () { var s = document.getElementById('gp-bots'); if (s.disabled) return 'disabled'; s.value = ${J(String(n))};
  s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`;
const botsUiJs = `({ shown: __e.shown('gp-bots-box'), value: document.getElementById('gp-bots').value, disabled: document.getElementById('gp-bots').disabled,
  options: document.getElementById('gp-bots').options.length, skill: (document.querySelector('#gp-skill button.on') || { getAttribute: function () { return null; } }).getAttribute('data-s'),
  list: Array.from(document.querySelectorAll('#gp-bots-list .gp-bot')).map(function (e) { return e.textContent; }) })`;
// where every local car stands against the box it should be in: [id, metres from the box's placement] (box = slot + 1)
const boxDistJs = slotOf => `(function () { var g = F1.game, G = g.track.grid, out = [], s = F1.gp.snapshot;
  function d(st, k) { var b = G[k]; return Math.hypot(st.x - (b.x - Math.sin(b.heading) * 2.8), st.z - (b.z - Math.cos(b.heading) * 2.8)); }
  var slotOf = ${slotOf};
  out.push([F1.gp.selfId, +d(g.car.state, slotOf(F1.gp.selfId, 0)).toFixed(3)]);
  g.bots.forEach(function (b) { out.push([b.id, +d(b.car.state, slotOf(b.id, b.slot)).toFixed(3)]); });
  return out; })()`;
const GRID_SLOT = `function (id, slot) { return F1.gp.snapshot.grid.indexOf(id); }`;
const ROOM_SLOT = `function (id, slot) { return slot; }`;
// the session's rows with what the harness needs
const rowsJs = `F1.gp.view().rows.map(function (r) { return { pos: r.pos, id: r.id, name: r.name, bot: !!r.bot, skill: r.skill, laps: r.laps, best: r.best, time: r.time,
  done: r.done, dnf: r.dnf, self: r.isSelf, down: r.down, left: !!r.left }; })`;
const playersJs = `F1.gp.snapshot.players.map(function (p) { return { id: p.id, name: p.name, bot: !!p.bot, qBest: p.qBest, qDone: p.qDone, qLaps: p.qLaps, rLaps: p.rLaps, rTime: p.rTime,
  rBest: p.rBest, fin: p.fin, dnf: p.dnf, left: p.left }; })`;

// pick a track by its card (a real click), wait for it and hook the warp
async function loadTrack(w, id) {
  const idx = await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; })`);
  const t0 = Date.now();
  const ok = idx >= 0 && await w.click(`#track-grid .card[data-i="${idx}"]`) &&
    await w.until(`F1.game.track && F1.game.trackData.id === ${J(id)} && F1.game.running && __e.queued() === 1`, 30000, 'track ' + id);
  const hooked = ok && await w.js(`__e.hookRenderer() && __e.hookCar()`);
  return { ok: ok && hooked, ms: Date.now() - t0 };
}

/* ================= a Grand Prix with 15 bots, time-warped ================= */
const RACES = {
  monza: { id: 'it-1922', Q: 1, R: 3, wear: 2, pitSelf: 2 },
  monaco: { id: 'mc-1929', Q: 1, R: 3, wear: 2 }
};
async function partRace(key) {
  const cfg = RACES[key];
  setPart(key);
  const w = warpWin(key);
  const boot = await w.open();
  check('boots (' + YEAR + ' Ferrari picked), page helpers installed', !boot.overlay && boot.a === 'ok' && boot.b === 'ok', boot);
  /* the 大獎賽 tab: 15 bots, 混合, wear x2, Q / R typed */
  check('大獎賽 tab opened', await w.click('#tab-gp'));
  let u = await w.js(botsUiJs);
  check('the 電腦車手 rows: none (無) by default, 職業, 0..15', u.shown && u.value === '0' && u.skill === 'pro' && !u.disabled && u.options === 16, u);
  check('15 picked in the select', (await w.js(setBotsJs(15))) === '15');
  check('混合 clicked', await w.click('#gp-skill button[data-s="mixed"]'));
  check('輪胎損耗 ×' + cfg.wear + ' clicked', await w.click(`#gp-wear button[data-w="${cfg.wear}"]`));
  const q = await w.type('#gp-q', String(cfg.Q)), r = await w.type('#gp-r', String(cfg.R));
  check('Q / R typed: ' + cfg.Q + ' / ' + cfg.R, q === String(cfg.Q) && r === String(cfg.R), [q, r]);
  u = await w.js(botsUiJs);
  const stored = await w.js(`[localStorage.getItem('f1drive.bots'), localStorage.getItem('f1drive.gp')]`);
  check('the panel lists the field (15), remembered: f1drive.bots ' + stored[0] + ', f1drive.gp ' + stored[1],
    u.value === '15' && u.skill === 'mixed' && u.list.length === 15 && stored[0] === J({ count: 15, skill: 'mixed' }) && stored[1] === J({ q: cfg.Q, r: cfg.R, wear: cfg.wear }), u);
  await w.shot('panel', true);
  /* the track */
  const ld = await loadTrack(w, cfg.id);
  check(cfg.id + ' loads (' + ld.ms + ' ms, the warm-up included), warp hooked', ld.ok);
  let field = await w.js(`__bots.field()`);
  const levels = {};
  field.forEach(b => { levels[b.level] = (levels[b.level] || 0) + 1; });
  info('field: ' + field.map(b => b.name + ' (' + b.car.replace(/^2026-/, '') + ', ' + b.level + ')').join(' | '));
  check('15 bots of mixed strength (' + J(levels) + '), real names, the 2026 cars, the other Ferrari seat taken by Hamilton',
    field.length === 15 && Object.keys(levels).length >= 3 && field.every(b => /^2026-/.test(b.car) && !/standard/.test(b.car) && !/^AI \d/.test(b.name)) &&
    field.filter(b => b.car === CAR).length === 1 && /Hamilton/.test(field.find(b => b.car === CAR).name), levels);
  let bd = await w.js(boxDistJs(ROOM_SLOT));
  check('free practice: we stand in grid box 1, every bot in box slot + 1 (within 0.6 m)', bd.every(x => x[1] < 0.6), bd);
  /* free practice */
  await w.js(`__bots.skill = 0.85; __bots.resetRec(); __bots.start()`);
  await w.advance(20);
  field = await w.js(`__bots.field()`);
  const fp = await w.js(`({ c: __bots.contactSummary(), stuck: __bots.rec.stuck, v: F1.game.car.state.speed, ds: F1.game.track.length / F1.game.track.samples.length,
    moved: F1.game.bots.map(function (b) { return __bots.rec.prog[b.id] ? __bots.rec.prog[b.id].U : 0; }) })`);
  // (20 s from the boxes: the whole field queues into the first corner together, a lap-1 jam; the last boxes wait for
  //  the cars in front to pull away - free practice has no lights: they go one after another, an accordion of up to ~6 s)
  check('free practice 20 s: every bot drove off (> 300 m on, never standing 8 s), we drive too (our computer driver through the controller)',
    fp.moved.every(u => u * fp.ds > 300) && field.every(b => b.worstStill < 8) && fp.v > 15 && fp.stuck.length === 0,
    { m: fp.moved.map(u => Math.round(u * fp.ds)), still: field.map(b => r1(b.worstStill)), v: r1(fp.v) });
  info('free practice contacts: ' + J(fp.c));
  await w.shot('free-practice');
  /* the Grand Prix from the menu */
  check('Esc -> menu', await w.esc(true));
  await w.js(`__bots.resetRec()`);
  check('開始大獎賽 clicked -> qualifying, out of the menu', await w.click('#gp-start') && await w.until(`F1.gp.phase === 'quali' && F1.game.running && __e.queued() === 1`, 3000));
  let s = await w.js(`({ q: F1.gp.snapshot.q, r: F1.gp.snapshot.r, wear: F1.gp.snapshot.wear, year: F1.gp.snapshot.year, n: F1.gp.snapshot.players.length,
    bots: F1.gp.snapshot.players.filter(function (p) { return p.bot; }).length })`);
  check('qualifying: Q ' + cfg.Q + ', R ' + cfg.R + ', wear x' + cfg.wear + ', season ' + YEAR + ', 16 drivers of whom 15 bots', s.q === cfg.Q && s.r === cfg.R && s.wear === cfg.wear && s.year === YEAR && s.n === 16 && s.bots === 15, s);
  bd = await w.js(boxDistJs(ROOM_SLOT));
  check('qualifying start: everybody from the box of his room slot (we: box 1)', bd.every(x => x[1] < 0.6), bd);
  const qClock0 = await w.js(`__e.clock`), crossesQ = await w.js(`__e.n.cross || 0`);
  const qOk = await w.pump(`F1.gp.phase === 'grid'`, 600, 'qualifying done');
  const qS = (await w.js(`__e.clock`) - qClock0) / 1000;
  check('qualifying ends by itself once all 16 have done their lap (' + r1(qS) + ' s of game time)', qOk);
  const quali = await w.js(playersJs), grid = await w.js(`F1.gp.snapshot.grid.slice()`);
  const qc = await w.js(`__bots.contactSummary(function (c) { return c.phase === 'quali'; })`);
  check('qualifying: no contact at all (everybody a ghost)', qc.n === 0, qc);
  check('qualifying: every car did its timed lap (qDone, a time)', quali.length === 16 && quali.every(p => p.qDone && p.qBest > 0), quali.filter(p => !(p.qDone && p.qBest > 0)));
  const byTime = quali.slice().sort((a, b) => a.qBest - b.qBest).map(p => p.id);
  check('the grid is the qualifying order (16, by time)', J(grid) === J(byTime), { grid, byTime });
  field = await w.js(`__bots.field()`);
  // (ai.pace is the profile's lap without an acceleration limit - a yardstick between drivers, 10..15 % under a driven
  //  lap: the bots must all drive the same share of it)
  const qRatio = field.map(b => { const p = quali.find(x => x.id === b.id); return [b.name, b.level, r3(p.qBest / b.pace)]; }), qr = qRatio.map(x => x[2]);
  const qRho = spearman(field.map(b => quali.find(x => x.id === b.id).qBest), field.map(b => -b.skill));
  check('qualifying laps: every bot the same share of its own pace (lap / ai.pace ' + Math.min(...qr) + '..' + Math.max(...qr) + ', spread under 4 %); the times follow the strength (Spearman ' + r3(qRho) + ' >= 0.6)',
    Math.max(...qr) / Math.min(...qr) < 1.04 && qRho >= 0.6, qRatio);
  const me = quali.find(p => p.id === 1), cr = await w.js(`__e.log.filter(function (e) { return e.type === 'cross'; }).map(function (e) { return e.steps; })`);
  const truth = cr.length >= crossesQ + 2 ? (cr[crossesQ + 1] - cr[crossesQ]) * (1 / 120) : NaN;
  check('our qualifying lap ' + fmt(me.qBest) + ' = physics steps between our two crossings (ground truth ' + fmt(truth) + ')', Math.abs(me.qBest - Math.round(truth * 1000) / 1000) < 0.0011, { qBest: me.qBest, truth });
  info('qualifying: ' + byTime.map((id, k) => { const p = quali.find(x => x.id === id), b = field.find(x => x.id === id); return (k + 1) + '. ' + p.name + (b ? ' (' + b.level + ')' : ' (us)') + ' ' + fmt(p.qBest); }).join(' | '));
  /* the grid */
  await w.pump(`F1.gp.lights >= 1`, 8, 'first light');
  bd = await w.js(boxDistJs(GRID_SLOT));
  check('grid: every car in the box of its qualifying place (within 0.6 m), standing', bd.every(x => x[1] < 0.6) && await w.js(`F1.game.bots.every(function (b) { return b.car.state.speed === 0; }) && F1.game.car.state.speed === 0`), bd);
  const tyresGrid = await w.js(`F1.game.bots.map(function (b) { return b.car.tyres.state.compound + ' x' + b.car.tyres.wearRate; })`);
  check('grid: the bots on the set their drivers chose for ' + cfg.R + ' laps at wear x' + cfg.wear + ', wearing at x' + cfg.wear, tyresGrid.every(t => new RegExp('^[SMH] x' + cfg.wear + '$').test(t)), tyresGrid);
  await w.pump(`F1.gp.lights >= 4`, 6, '4 lights');
  await w.shot('grid-4-lights');
  /* lights out, the start */
  check('lights out -> race', await w.pump(`F1.gp.phase === 'race'`, 10, 'race'));
  const go = await w.js(`({ clock: __e.clock, locked: F1.game.bots.filter(function (b) { return b.ctx.locked; }).length })`);
  await w.advance(3);
  await w.shot('start-3s');
  await w.pump(`F1.gp.sinceGo >= 25`, 30, '25 s');
  const st = await w.js(`({ c: __bots.contactSummary(function (c) { return c.phase === 'race' && c.sinceGo < 25; }), list: __bots.contacts.filter(function (c) { return c.phase === 'race'; }).map(function (c) { return [c.id, +c.max.toFixed(2), +c.sinceGo.toFixed(1), c.idx]; }),
    field: __bots.field().map(function (b) { return [b.name, b.stats.resets, b.stats.offs, b.stats.wallHits]; }), stuck: __bots.rec.stuck })`);
  check('the start (first 25 s): no pile-up: at most 3 contacts, none heavier than 0.35, no bot needed an R, nobody stuck',
    st.c.n <= 3 && st.c.max <= 0.35 && st.field.every(f => f[1] === 0) && st.stuck.length === 0, st);
  /* the race */
  if (cfg.pitSelf) {
    // our own stop: told on lap pitSelf (our computer driver takes the lane with the limiter through B, box 1)
    await w.pump(`F1.gp.lap >= ${cfg.pitSelf - 1}`, 200, 'lap ' + (cfg.pitSelf - 1) + ' done');
    // the hards picked with X (the controller's next-compound button: M -> H), as a player does before the stop
    const nc0 = await w.js(`F1.game.nextCompound`);
    await w.js(`__bots.tap(2)`);
    await w.advance(0.2);
    if (await w.js(`F1.game.nextCompound !== 'H'`)) { await w.js(`__bots.tap(2)`); await w.advance(0.2); }
    const nc1 = await w.js(`F1.game.nextCompound`);
    await w.js(`__bots.stop('H')`);
    const pitOk = await w.pump(`F1.game.pit.state.stops >= 1 && !F1.game.pit.state.inLane`, 200, 'our pit stop');
    await w.advance(5);
    const pr = await w.js(`({ stops: F1.game.pit.state.stops, compound: F1.game.tyres.state.compound, wear: Math.max.apply(null, F1.game.tyres.state.wear), presses: __bots.limiterPresses,
      limiter: F1.game.limiter, toasts: __e.toasts.filter(function (t) { return /限速|罰|超速|輪胎/.test(t.text); }).map(function (t) { return t.text; }) })`);
    check('our stop on lap ' + cfg.pitSelf + ' (X: next set ' + nc0 + ' -> ' + nc1 + '; our driver in the lane among the bots, the limiter on and off through B): served, the new hards, limiter off again, no speeding',
      nc1 === 'H' && pitOk && pr.stops === 1 && pr.compound === 'H' && pr.wear < 0.01 && !pr.limiter && pr.presses >= 2 && !pr.toasts.some(t => /超速|罰/.test(t)), pr);
  }
  await w.pump(`F1.gp.lap >= 1 && __e.frac() >= 0.45`, 300, 'mid race');
  await w.shot('race');
  const rOk = await w.pump(`F1.gp.phase === 'results'`, cfg.R * 140 + 150, 'the results');
  check('the race runs to the results (everybody finished, or 90 s after the winner)', rOk);
  await w.advance(2);
  const res = await w.js(rowsJs), pl = await w.js(playersJs);
  field = await w.js(`__bots.field()`);
  const rec = await w.js(`({ stuck: __bots.rec.stuck, laneMax: __bots.rec.laneMax, speeding: __bots.rec.speeding, maxLaneKmh: __bots.rec.maxLaneKmh, ot: __bots.overtakes(), ot20: __bots.overtakes(${go.clock / 1000 + 20}),
    c: __bots.contactSummary(function (c) { return c.phase === 'race' || c.phase === 'results'; }), limit: F1.game.track.pit.limitKmh, blue: __bots.rec.blue, wrong: __bots.rec.wrong,
    heavy: __bots.contacts.filter(function (c) { return c.max > 0.25; }).map(function (c) { return [c.id, +c.max.toFixed(2), c.phase, +c.sinceGo.toFixed(1), c.idx, c.self]; }) })`);
  info('results: ' + res.map(x => x.pos + '. ' + x.name + (x.bot ? ' (' + (field.find(b => b.id === x.id) || {}).level + ')' : ' (us)') + ' ' + (x.time ? fmt(x.time) : (x.dnf ? 'DNF' : (x.down ? '+' + x.down + ' lap' : '--')))).join(' | '));
  check('results: all 16 classified, nobody DNF, every bot took the flag after ' + cfg.R + ' laps', res.length === 16 && res.every(x => !x.dnf) && pl.filter(p => p.bot).every(p => p.fin && p.rLaps === cfg.R), res.filter(x => x.dnf || !x.done));
  const bots = res.filter(x => x.bot).map(x => ({ pos: x.pos, skill: (field.find(b => b.id === x.id) || {}).skill, level: (field.find(b => b.id === x.id) || {}).level, id: x.id }));
  const rho = spearman(bots.map(b => b.pos), bots.map(b => -b.skill));
  const lv = {}; bots.forEach(b => { (lv[b.level] = lv[b.level] || []).push(b.pos); });
  const lvMean = {}; Object.keys(lv).forEach(k => { lvMean[k] = r1(mean(lv[k])); });
  check('the order follows the strength: Spearman(place, skill) among the bots ' + r3(rho) + ' >= 0.5; mean place by level ' + J(lvMean) + ' (legends ahead of rookies)',
    rho >= 0.5 && (!lv.legend || !lv.rookie || mean(lv.legend) < mean(lv.rookie)), { rho, lvMean });
  const times = pl.filter(p => p.bot).map(p => { const b = field.find(x => x.id === p.id); return [p.name, b.level, r3(p.rTime / (cfg.R * p.qBest))]; });
  // (at Monaco the drivers start on softs at wear x2 and end the 3 laps near 85 % wear: their last laps are slow)
  check('every bot\'s race time against ' + cfg.R + ' x its own qualifying lap: 0.98..1.16 (standing start, traffic, worn tyres)', times.every(x => x[2] > 0.98 && x[2] < 1.16), times);
  check('nobody stuck in the race (no bot without progress for 15 s while racing); longest standstill ' + r1(Math.max(...field.map(b => b.worstStill))) + ' s',
    rec.stuck.length === 0, rec.stuck);
  check('no bot drove the wrong way or needed an R in the race', field.every(b => b.stats.resets === 0) && Object.keys(rec.wrong).length === 0, { resets: field.filter(b => b.stats.resets).map(b => [b.name, b.stats.resets, b.log]), wrong: rec.wrong });
  check('race contacts (bots and us): ' + J(rec.c) + ': none heavier than 0.5, at most 4 over 0.25', rec.c.max <= 0.5 && rec.heavy.length <= 4, rec.heavy);
  check('overtakes in the race: ' + rec.ot.total + ' place changes (' + rec.ot20.total + ' after the first 20 s), ' + field.reduce((a, b) => a + b.stats.passes, 0) + ' passes counted by the drivers', rec.ot.total > 0, rec.ot);
  const stops = field.map(b => [b.name, b.stops, b.compound, r3(b.wear)]);
  check('tyres: no puncture, no set past 93 % wear; bot stops ' + field.reduce((a, b) => a + b.stops, 0) + ', no bot speeding in the lane (limit ' + rec.limit + ' km/h)',
    field.every(b => b.puncture === -1 && b.wear < 0.93) && Object.keys(rec.speeding).length === 0, { stops, maxLaneKmh: rec.maxLaneKmh, speeding: rec.speeding });
  if (VERBOSE) info('field: ' + J(field.map(b => [b.name, b.level, b.stats, b.worstStill])));
  // the results overlay
  const dom = await w.js(`({ shown: __e.shown('gp-results'), rows: document.querySelectorAll('#gp-results-body tbody tr').length, ai: document.querySelectorAll('#gp-results-body .gp-ai').length,
    hudAi: document.querySelectorAll('#hud-gp-rows .gp-ai').length, hudRows: document.querySelectorAll('#hud-gp-rows .gp-row').length })`);
  check('results overlay: 16 rows, 15 with an AI tag; the HUD session box: ' + dom.hudRows + ' rows, ' + dom.hudAi + ' AI tags', dom.shown && dom.rows === 16 && dom.ai === 15 && dom.hudAi === dom.hudRows - 1, dom);
  await w.shot('results');
  const ourRow = res.find(x => x.self);
  info('we (a computer driver at skill 0.85 in the Ferrari) finished P' + ourRow.pos + ' ' + fmt(ourRow.time) + '; ' + rec.ot.bySelf + ' places gained by us, ' + rec.ot.onSelf + ' lost; most cars in the pit lane at once ' + rec.laneMax +
    '; warp: ' + r1((await w.js(`__e.clock`) - 1000000) / 1000) + ' s of game time in ' + r1(w.wall / 1000) + ' s');
  await w.noErrors('Grand Prix');
  await closeAll();
}

/* ================= playing with the bots (time-warped) ================= */

// a warped window with the 電腦車手 setting and the Grand Prix setup remembered (as a player who set them earlier), on track id
async function warpOn(tag, id, bots, gpCfg, pick) {
  const w = warpWin(tag, pick);
  const prep = `localStorage.setItem('f1drive.bots', ${J(J(bots))}); localStorage.setItem('f1drive.gp', ${J(J(gpCfg || { q: 1, r: 3, wear: 1 }))}); true`;
  const boot = await w.open(prep);
  check('boots, ' + bots.count + ' bots (' + bots.skill + ') remembered', !boot.overlay && boot.a === 'ok' && boot.b === 'ok', boot);
  const ld = await loadTrack(w, id);
  check(id + ' loads with ' + bots.count + ' bots', ld.ok && (await w.js(`F1.game.bots.length`)) === bots.count, ld);
  return w;
}
// a Grand Prix from the menu with qualifying skipped: on the grid (we P1: join order)
async function gridNow(w) {
  if (await w.js(`F1.game.running`)) await w.esc(true);
  await w.click('#tab-gp');
  const a = await w.click('#gp-start') && await w.until(`F1.gp.phase === 'quali' && F1.game.running`, 3000, 'quali');
  const b = await w.esc(true) && await w.click('#gp-skip') && await w.until(`F1.gp.phase === 'grid' && F1.game.running`, 3000, 'grid');
  return a && b;
}
const fieldOf = w => w.js(`__bots.field()`);
const progJs = `(function () { var g = F1.game, o = {}; o[F1.gp.selfId] = g.lap.progress(g.car.state.sampleIndex);
  g.bots.forEach(function (b) { o[b.id] = b.lap.progress(b.car.state.sampleIndex); }); return o; })()`;

// the 電腦車手 / 強度 controls while on the track
async function partPanel() {
  setPart('panel');
  const w = await warpOn('panel', 'it-1922', { count: 15, skill: 'mixed' });
  await w.js(`__bots.start()`);
  await w.advance(12);
  await w.js(`window.__old = F1.game.bots.slice(); true`);
  check('Esc -> menu, 大獎賽 tab', await w.esc(true) && await w.click('#tab-gp'));
  check('15 -> 6 in the select', (await w.js(setBotsJs(6))) === '6');
  let r = await w.js(`(function () { var b = F1.game.bots, gone = __old.filter(function (x) { return b.indexOf(x) < 0; });
    return { n: b.length, same: b.every(function (x) { return __old.indexOf(x) >= 0; }), gone: gone.length, disposed: gone.every(function (x) { return x.dead && !x.model; }),
      inScene: b.every(function (x) { return !!(x.model && x.model.group.parent); }), list: document.querySelectorAll('#gp-bots-list .gp-bot').length }; })()`);
  check('6 bots now: the first 6 of the field kept where they were (same cars), the other 9 gone with their models; the panel lists 6', r.n === 6 && r.same && r.gone === 9 && r.disposed && r.inScene && r.list === 6, r);
  check('傳奇 clicked', await w.click('#gp-skill button[data-s="legend"]'));
  r = await w.js(`({ n: F1.game.bots.length, sk: F1.game.bots.map(function (b) { return b.skill; }), lv: F1.game.bots.map(function (b) { return F1.AI.levelOf(b.skill).id; }),
    same: F1.game.bots.every(function (b) { return __old.indexOf(b) >= 0; }) })`);
  check('6 legends (skill ~1, the drivers updated in place)', r.n === 6 && r.sk.every(s => s > 0.9) && r.same, r);
  check('6 -> 15 in the select', (await w.js(setBotsJs(15))) === '15');
  r = await w.js(`(function () { var g = F1.game, cars = [g.car.state].concat(g.bots.map(function (b) { return b.car.state; })), min = 1e9, S = g.track.samples;
    for (var i = 0; i < cars.length; i++) for (var j = i + 1; j < cars.length; j++) min = Math.min(min, Math.hypot(cars[i].x - cars[j].x, cars[i].z - cars[j].z));
    var off = g.bots.filter(function (b) { var s = S[b.car.state.sampleIndex]; return Math.abs(b.car.state.d) > (s.halfW || g.track.halfWidth); }).length;
    return { n: g.bots.length, min: +min.toFixed(2), off: off, models: g.bots.filter(function (b) { return b.model && b.model.group.parent; }).length }; })()`);
  check('15 again: the 9 new cars put down clear of everybody (closest two cars ' + r.min + ' m apart), on the road, all 15 drawn', r.n === 15 && r.min > 4 && r.off === 0 && r.models === 15, r);
  await w.shot('menu-15', true);
  check('Esc -> driving again', await w.esc(false));
  await w.js(`__bots.resetRec()`);
  await w.advance(20);
  const c = await w.js(`__bots.contactSummary()`), st = await w.js(`__bots.rec.stuck`);
  check('20 s of driving with the new field: no contact heavier than 0.25, nobody stuck', c.max <= 0.25 && st.length === 0, { c, st });
  await w.shot('driving-15');
  await w.esc(true); await w.click('#tab-gp');
  check('15 -> 0 (無)', (await w.js(setBotsJs(0))) === '0');
  r = await w.js(`({ n: F1.game.bots.length, gp: F1.gp.bots().length, views: F1.game.botViews.length, list: document.querySelectorAll('#gp-bots-list .gp-bot').length,
    stored: localStorage.getItem('f1drive.bots') })`);
  check('no bots left (the game, the session, the views, the panel), remembered as 0', r.n === 0 && r.gp === 0 && r.views === 0 && r.list === 0 && r.stored === J({ count: 0, skill: 'legend' }), r);
  check('Esc -> driving alone', await w.esc(false));
  await w.advance(5);
  await w.noErrors();
  await closeAll();
}

// a bot running into us: we stop dead on the racing line out of the Variante della Roggia (free practice, 15 bots)
async function partRam() {
  setPart('ram');
  const w = await warpOn('ram', 'it-1922', { count: 15, skill: 'mixed' });
  // where: 50 m after the slowest point of the racing line between 18 % and 32 % of the lap (the Roggia's exit)
  const at = await w.js(`(function () { var P = F1.game.raceLine.points, N = P.length, best = -1, v = 1e9, ds = F1.game.track.length / N;
    for (var i = Math.floor(N * 0.18); i < N * 0.32; i++) if (P[i].limit < v) { v = P[i].limit; best = i; }
    return { at: (best + Math.round(50 / ds)) % N, apex: best, kmh: Math.round(v * 3.6), N: N }; })()`);
  info('we stop at sample ' + at.at + ' (50 m after the Roggia\'s slowest point, ' + at.kmh + ' km/h)');
  // a lap first: the field spread round the track, then we stop there for 45 s with everybody coming by
  await w.js(`__bots.start()`);
  await w.pump(`F1.game.lap.progress(F1.game.car.state.sampleIndex) >= 1.05`, 300, 'a lap');
  await w.js(`__bots.resetRec(); window.__r0 = __e.rumbles; __bots.holdAt = { at: ${at.at}, s: 45, kmh: 0 }; true`);
  check('we brake to a standstill on the line out of the corner', await w.pump(`__bots.holdAt.on && Math.abs(F1.game.car.state.speed) < 0.3`, 200, 'stopped'));
  const p0 = await w.js(progJs);
  const h = await w.js(`({ v0: __bots.holdAt.v0, d: F1.game.car.state.d, line: F1.game.raceLine.points[F1.game.car.state.sampleIndex].d })`);
  info('stopped from ' + r1(h.v0 * 3.6) + ' km/h, ' + r3(h.d) + ' m off the centreline (racing line at ' + r3(h.line) + ' m)');
  await w.advance(4);
  await w.shot('stopped-on-the-line');
  if (process.env.WATCH) {      // (diagnostic: one bot's every think() from 25 s into the stop, for 4 s)
    await w.advance(21);
    await w.js(`__bots.watch(${Number(process.env.WATCH)}, 4)`);
    await w.advance(4.2);
    const wl = await w.js(`__bots.watchLog.filter(function (x, k) { return k % 15 === 0; })`);
    info('watch ' + process.env.WATCH + ':\n       ' + wl.map(x => J(x)).join('\n       '));
    info('us: ' + J(await w.js(`({ i: F1.game.car.state.sampleIndex, d: F1.game.car.state.d, h: F1.game.car.state.heading })`)));
  }
  await w.pump(`!(__e.clock / 1000 < __bots.hold.until)`, 60, 'the 45 s');
  const p1 = await w.js(progJs);
  const rec = await w.js(`({ c: __bots.contactSummary(), self: __bots.contacts.filter(function (c) { return c.self || (c.other && c.other[0] === F1.gp.selfId); }).map(function (c) { return [c.id, +c.max.toFixed(3), c.other, +(c.v * 3.6).toFixed(0)]; }),
    rumbles: __e.rumbles - __r0, stuck: __bots.rec.stuck, field: __bots.field().map(function (b) { return [b.name, +b.worstStill.toFixed(1), b.stats.resets, b.worstMode]; }) })`);
  const by = Object.keys(p1).filter(id => +id !== 1 && p1[id] > p0[1] + 0.001 && p0[id] < p0[1]).length;
  info('during the 45 s: ' + by + ' bots came past us; contacts ' + J(rec.c) + ' ' + J(await w.js(`__bots.contacts.map(function (c) { return [c.id, +c.max.toFixed(3), c.other, c.idx]; })`)) +
    '; on us ' + J(rec.self) + '; controller rumbles ' + rec.rumbles);
  check('the bots go round our stopped car: ' + by + ' came past (at least 8)', by >= 8, p1);
  check('nobody runs into us hard: at most 2 touches, none heavier than 0.25', rec.self.length <= 2 && rec.self.every(x => x[1] <= 0.25), rec.self);
  check('when touched, the controller rumbles (main.js: a bot\'s impact on our car)', rec.self.filter(x => x[1] > 0.1).length === 0 || rec.rumbles > 0, rec);
  check('no bot waits behind us more than 20 s, none needs an R', rec.field.every(f => f[1] < 20 && f[2] === 0), rec.field);
  if (VERBOSE || !rec.field.every(f => f[1] < 20)) {
    const dump = await w.js(`(function () { var g = F1.game, N = g.track.samples.length, me = g.car.state; return __bots.field().filter(function (b) { return b.worstStill > 10; }).map(function (b) {
      var rel = ((b.i - me.sampleIndex) % N + N) % N; if (rel > N / 2) rel -= N; return [b.name, b.worstStill.toFixed(1), 'worst@' + b.worstAt, 'now rel ' + rel, 'd ' + b.d.toFixed(2), b.mode, J(b.log)]; }); })().map(function (x) { return x.join(' '); })`.replace('J(b.log)', 'JSON.stringify(b.log)'));
    info('us: ' + J(await w.js(`({ i: F1.game.car.state.sampleIndex, d: F1.game.car.state.d, line: F1.game.raceLine.points[F1.game.car.state.sampleIndex].d })`)) + '\n       ' + dump.join('\n       '));
  }
  await w.advance(10);
  const v = await w.js(`F1.game.car.state.speed`);
  check('we drive on afterwards (our driver reset when the hold ended)', v > 15, v);
  // and the other way round: we run into the back of a bot ahead on a straight (closing at 36 km/h), as a careless human does
  await w.js(`window.__r1 = __e.rumbles; __bots.ram = { id: 0, closing: 10, s: 15 }; true`);
  const found = await w.pump(`__bots.ram.id > 0`, 400, 'a bot 15..45 m ahead on a straight');
  const tgt = found ? await w.js(`(function () { window.__tg = F1.game.bots.filter(function (b) { return b.id === __bots.ram.id; })[0]; return { id: __bots.ram.id, name: __bots.ram.name, ahead: Math.round(__bots.ram.ahead) }; })()`) : null;
  check('a bot ahead to run into: ' + (tgt ? tgt.name + ', ' + tgt.ahead + ' m ahead' : 'none'), !!tgt);
  if (tgt) {
    const hit = await w.pump(`__bots.ram.done`, 45, 'the ram');
    await w.advance(4);
    const r = await w.js(`({ ram: __bots.ram, c: __bots.contacts.filter(function (c) { return c.t >= __bots.ram.t0; }).map(function (c) { return [c.id, +c.max.toFixed(3), c.other, +(c.v * 3.6).toFixed(0)]; }),
      rumbles: __e.rumbles - __r1, bot: { v: __tg.car.state.speed, mode: __tg.ai.state.mode, resets: __tg.ai.stats.resets, puncture: __tg.car.tyres.state.puncture, x: __tg.car.state.x },
      us: { v: F1.game.car.state.speed, puncture: F1.game.tyres.state.puncture } })`);
    info('ram: ' + J(r));
    check('we ran into it (' + (r.ram.done) + ' after ' + (r.ram.at ? r1(r.ram.at - r.ram.t0) : '?') + ' s, ' + (r.ram.vUs ? r1((r.ram.vUs - r.ram.vIt) * 3.6) : '?') + ' km/h faster): both cars took the impact (contact records on both), the controller rumbled',
      hit && r.ram.done === 'hit' && r.c.some(x => x[0] === 1) && r.c.some(x => x[0] === tgt.id) && r.rumbles > 0, r);
    check('the bot drives on afterwards (no R, moving, finite)', Number.isFinite(r.bot.x) && r.bot.resets === 0 && Math.abs(r.bot.v) > 5, r.bot);
    await w.shot('after-the-ram');
  }
  await w.noErrors();
  await closeAll();
}

// a stalled start from pole, racing through the field, and the pit lane full of bots on lap 2 (Monza, R 3)
async function partPits() {
  setPart('pits');
  const w = await warpOn('pits', 'it-1922', { count: 15, skill: 'mixed' }, { q: 1, r: 3, wear: 1 });
  check('Grand Prix started, qualifying skipped: on the grid (we on pole: join order)', await gridNow(w));
  await w.js(`__bots.skill = 1; __bots.holdAfterGo = 12; __bots.resetRec(); __bots.start()`);
  check('lights out', await w.pump(`F1.gp.phase === 'race'`, 15, 'race'));
  await w.advance(2.5);
  await w.shot('stalled-on-pole');
  await w.pump(`F1.gp.sinceGo >= 13`, 20, 'the stall');
  const st = await w.js(`({ c: __bots.contactSummary(), on: __bots.contacts.filter(function (c) { return c.self || (c.other && c.other[0] === F1.gp.selfId); }).map(function (c) { return [c.id, +c.max.toFixed(3), c.other]; }),
    pos: F1.gp.view().pos, v: F1.game.car.state.speed })`);
  // (single file round a stalled car - js/ai.js's yellow flag: the right-hand column goes at once, the cars behind us one by one)
  check('stalled on pole for 12 s: the field goes round us (P' + st.pos + ' 13 s after lights out; at least 9 by), nobody hits us harder than 0.25 (' + st.on.length + ' touches)', st.pos >= 10 && st.on.every(x => x[1] <= 0.25), st);
  const t0 = await w.js(`__e.clock / 1000`);
  // lap 2: everybody told to stop (the bots and we): the lane full at once
  await w.pump(`F1.gp.lap >= 1`, 200, 'lap 1 done');
  const ot1 = await w.js(`__bots.overtakes(${t0})`);
  await w.js(`F1.game.bots.forEach(function (b) { b.ai.planStop('H'); }); __bots.tap(2); __bots.stop('H'); true`);
  check('in the lane among the bots', await w.pump(`F1.game.pit.state.inLane`, 150, 'our lane'));
  await w.pump(`F1.game.pit.state.service || !F1.game.pit.state.inLane`, 60, 'our box');
  await w.shot('pit-lane-full');
  await w.pump(`F1.game.bots.every(function (b) { return b.pit.state.stops >= 1 && !b.pit.state.inLane; }) && F1.game.pit.state.stops >= 1 && !F1.game.pit.state.inLane`, 250, 'all served');
  const pr = await w.js(`({ laneMax: __bots.rec.laneMax, speeding: __bots.rec.speeding, maxKmh: __bots.rec.maxLaneKmh, limit: F1.game.track.pit.limitKmh,
    bots: F1.game.bots.map(function (b) { return [b.name, b.pit.state.stops, b.car.tyres.state.compound, +Math.max.apply(null, b.car.tyres.state.wear).toFixed(3)]; }),
    us: [F1.game.pit.state.stops, F1.game.tyres.state.compound], c: __bots.contactSummary(function (c) { return c.t > ${t0}; }),
    lane: __bots.contacts.filter(function (c) { return c.paved; }).map(function (c) { return [c.id, +c.max.toFixed(2), c.other, c.idx]; }) })`);
  const maxKmh = Math.max(...Object.values(pr.maxKmh));
  check('the pit lane full: ' + pr.laneMax + ' cars in it at once (at least 8)', pr.laneMax >= 8, pr.laneMax);
  check('every bot served in its own box (one stop, new hards), we too (our box, the hards picked with X)', pr.bots.every(b => b[1] === 1 && b[2] === 'H' && b[3] < 0.05) && pr.us[0] === 1 && pr.us[1] === 'H', pr);
  check('no bot speeding in the lane (top ' + r1(maxKmh) + ' km/h, limit ' + pr.limit + ')', Object.keys(pr.speeding).length === 0 && maxKmh <= pr.limit + 1, { speeding: pr.speeding, maxKmh: pr.maxKmh });
  check('no contact on the pit asphalt (cars there are ghosts); after the stall none heavier than 0.25', pr.lane.length === 0 && pr.c.max <= 0.25, { lane: pr.lane, c: pr.c });
  check('the race to the results', await w.pump(`F1.gp.phase === 'results'`, 400, 'results'));
  const ot = await w.js(`__bots.overtakes(${t0})`), res = await w.js(rowsJs);
  info('from P' + st.pos + ' after the stall: lap 1 ' + J(ot1) + ', whole race ' + J(ot) + '; finished P' + res.find(x => x.self).pos);
  check('we (a legend, skill 1) race through the field after the stall: at least 4 places gained on track', ot.bySelf >= 4, ot);
  check('all 16 classified, no DNF', res.length === 16 && res.every(x => !x.dnf && x.done), res.filter(x => x.dnf || !x.done));
  await w.shot('results');
  await w.noErrors();
  await closeAll();
}

// blue flags: a rookie parked in its box after lap 1, released when the leaders are a lap up (Monaco, R 3)
async function partBlue() {
  setPart('blue');
  const w = await warpOn('blue', 'mc-1929', { count: 15, skill: 'mixed' }, { q: 1, r: 3, wear: 1 });
  check('on the grid (qualifying skipped)', await gridNow(w));
  await w.js(`__bots.skill = 0.85; __bots.resetRec(); __bots.start()`);
  check('lights out', await w.pump(`F1.gp.phase === 'race'`, 15, 'race'));
  const victim = await w.js(`(function () { var v = F1.game.bots.filter(function (b) { return b.skill < 0.2; })[0] || F1.game.bots[F1.game.bots.length - 1];
    window.__victim = v; v.ai.planStop('M', true); return { id: v.id, name: v.name, skill: v.skill }; })()`);
  info('the backmarker: ' + victim.name + ' (skill ' + victim.skill + '), told to park in its box at the end of lap 1');
  check('it parks in its box', await w.pump(`__victim.ai.state.mode === 'parked'`, 200, 'parked'));
  const lapUp = `(function () { var v = __victim, g = F1.game, pv = v.lap.progress(v.car.state.sampleIndex), mx = g.lap.progress(g.car.state.sampleIndex);
    g.bots.forEach(function (b) { if (b !== v) mx = Math.max(mx, b.lap.progress(b.car.state.sampleIndex)); }); return mx - pv; })()`;
  check('the leaders come round: one is 0.85 lap ahead of it', await w.pump(lapUp + ' >= 0.85', 200, 'a lap up'));
  const y0 = await w.js(`({ y: __victim.ai.stats.yields, t: __e.clock / 1000 })`);
  await w.js(`__victim.ai.plan.park = false; true`);       // released: out of the box, a lap down
  await w.pump(`__victim.ai.state.mode !== 'parked' && !__victim.pit.state.inLane`, 60, 'out of the lane');
  await w.pump(`__victim.ai.state.mode === 'yield'`, 120, 'a blue flag');
  await w.shot('blue-flag');
  check('the race to the results', await w.pump(`F1.gp.phase === 'results'`, 400, 'results'));
  const res = await w.js(rowsJs), f = await fieldOf(w);
  const v = f.find(b => b.id === victim.id), row = res.find(x => x.id === victim.id);
  const rec = await w.js(`({ blue: __bots.rec.blue[${victim.id}] || 0, c: __bots.contacts.filter(function (c) { return c.t > ${y0.t} && (c.id === ${victim.id} || (c.other && c.other[0] === ${victim.id})); }).map(function (c) { return [c.id, +c.max.toFixed(3), c.other]; }),
    stuck: __bots.rec.stuck })`);
  info(victim.name + ' after its release: ' + (v.stats.yields - y0.y) + ' blue-flag yields, ' + rec.blue + ' frames giving way, finished P' + row.pos + ' ' + (row.down ? row.down + ' lap down' : '') + '; contacts with it ' + J(rec.c));
  check('blue flags: it gives way to the cars a lap up (' + (v.stats.yields - y0.y) + ' yields)', v.stats.yields - y0.y >= 2 && rec.blue > 0, { yields: v.stats.yields, y0: y0.y, frames: rec.blue });
  check('lapped without a heavy contact (none over 0.25), nobody stuck behind it', rec.c.every(x => x[1] <= 0.25) && rec.stuck.length === 0, rec);
  check('classified a lap down, the others on the lead lap or a lap down, all finished', row && row.down >= 1 && res.length === 16 && res.every(x => !x.dnf && x.done), res.map(x => [x.pos, x.name, x.laps, x.down]));
  await w.noErrors();
  await closeAll();
}

// Suzuka's bridge with a field of 15: a 1-lap race from the grid
async function partSuzuka() {
  setPart('suzuka');
  const w = await warpOn('suzuka', 'jp-1962', { count: 15, skill: 'mixed' }, { q: 1, r: 1, wear: 1 });
  const br = await w.js(`(F1.game.track.bridges || []).map(function (b) { return { up: b.up, lo: b.lo }; })`);
  check('Suzuka has its bridge', br.length === 1, br);
  await w.js(`window.__rej = []; F1.gp.on('botLapRejected', function (id, why) { __rej.push([id, why]); }); true`);
  check('on the grid (qualifying skipped)', await gridNow(w));
  await w.js(`__bots.skill = 0.85; __bots.resetRec(); __bots.start()`);
  check('lights out', await w.pump(`F1.gp.phase === 'race'`, 15, 'race'));
  // a picture from our cockpit as we come to the bridge (the upper road over us, or we on it)
  await w.pump(`(function () { var i = F1.game.car.state.sampleIndex, N = F1.game.track.samples.length, b = F1.game.track.bridges[0];
    function near(a) { var k = ((a - i) % N + N) % N; return k > 15 && k < 40; } return near(b.lo) || near(b.up); })()`, 200, 'near the bridge');
  await w.shot('bridge');
  check('the race to the results', await w.pump(`F1.gp.phase === 'results'`, 300, 'results'));
  const r = await w.js(`({ jumps: __bots.rec.jumps, voids: __bots.rec.voids, rej: __rej, lapJumps: F1.game.bots.map(function (b) { return b.lap.jumps; }),
    c: __bots.contacts.map(function (c) { return [c.id, +c.max.toFixed(3), c.idx, c.other]; }) })`);
  const res = await w.js(rowsJs);
  check('every bot over and under the bridge on its own road: no sample jump, no lap-counter jump, no void lap', Object.keys(r.jumps).length === 0 && r.lapJumps.every(j => j === 0) && Object.keys(r.voids).length === 0, r);
  check('no bot lap rejected; all 16 finished their lap', r.rej.length === 0 && res.length === 16 && res.every(x => x.done && !x.dnf && x.laps === 1), { rej: r.rej, res: res.map(x => [x.pos, x.name, x.laps, x.done]) });
  check('no contact across the two levels (every contact\'s nearest car on the same level, within 1.5 m of height)', r.c.every(x => !x[3] || Math.abs(x[3][2]) <= 1.5), r.c);
  info('contacts in the 1-lap race: ' + J(r.c));
  await w.noErrors();
  await closeAll();
}

/* ================= real time: rooms, frame rate ================= */

// a real-time window of the real game with bots-page.js (our computer driver) and a frame-cost recorder
async function rtWin(tag, pick, room, prep) {
  const w = L.makeWin(electron, room ? host : null, tag, { fps: 60 });
  wins.push(w);
  await refCar.seed(w, pick);
  if (prep) await w.js(prep);
  await w.loadFile(L.pageFile());
  await sleep(900);
  const b = await w.js(BOTS_PAGE);
  await w.js(`(function () {
    window.__shown = function (id) { var e = document.getElementById(id); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    var raf = window.requestAnimationFrame.bind(window), ts0 = -1, sum = 0, buf = [], times = [];
    window.__cost = function (reset) { var b = buf.slice().sort(function (a, c) { return a - c; }), q = function (p) { return b.length ? +b[Math.min(b.length - 1, Math.floor(p * b.length))].toFixed(2) : null; };
      var span = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0, gaps = 0, maxGap = 0;
      for (var i = 1; i < times.length; i++) { var g = times[i] - times[i - 1]; if (g > maxGap) maxGap = g; if (g > 50) gaps++; }
      var o = { frames: b.length, fps: span ? +((times.length - 1) / span).toFixed(1) : null, maxGap: +maxGap.toFixed(0), over50: gaps,
        mean: b.length ? +(b.reduce(function (a, c) { return a + c; }, 0) / b.length).toFixed(2) : null, p50: q(0.5), p95: q(0.95), max: b.length ? +b[b.length - 1].toFixed(1) : null };
      if (reset) { buf = []; times = []; } return o; };
    window.requestAnimationFrame = function (cb) { return raf(function (ts) { var t0 = performance.now(); try { cb(ts); } finally {
      if (ts !== ts0) { if (ts0 >= 0 && buf.length < 50000) { buf.push(sum); times.push(ts); } ts0 = ts; sum = 0; } sum += performance.now() - t0; } }); };
    return true; })()`);
  w.boot = { b, overlay: await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`) };
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
  w.shotTo = async n => { await sleep(150); const f = path.join(OUT, n + '.png'); fs.writeFileSync(f, (await w.webContents.capturePage()).toPNG()); return f; };
  w.toMenu = async () => { if (await w.js(`F1.game.running`)) { await w.tap('Escape'); return w.until(`!F1.game.running`, 3000, 'menu'); } return true; };
  w.toTrack = async () => { if (!(await w.js(`F1.game.running`))) { await w.tap('Escape'); return w.until(`F1.game.running`, 3000, 'resume'); } return true; };
  w.noBotErr = async () => { const e = await w.js(`__bots.err`); return check(tag + ': page driver ran without an error', !e, e); };
  return w;
}

// host A (in-game server) + guest B + 6 bots on Monaco, Q 1 / R 2, in real time
async function partRoom() {
  setPart('room');
  host.register(ipcMain);
  const A = await rtWin('A', { year: YEAR, car: CAR }, true), B = await rtWin('B', { year: YEAR, car: CAR_B }, true);
  check('A and B boot', !A.boot.overlay && !B.boot.overlay && A.boot.b === 'ok' && B.boot.b === 'ok', [A.boot, B.boot]);
  await A.js(`window.__botRej = []; F1.gp.on('botLapRejected', function (id, why) { __botRej.push([id, why, F1.gp.phase]); }); true`);
  await A.click('tab-mp');
  await A.field('mp-port', String(PORT));
  check('A creates the room (host)', await A.click('mp-create') && await A.until(`F1.net.connected && F1.net.isHost`, 6000));
  await A.click('tab-gp');
  check('A: 6 bots picked in the select, 混合 clicked (host, free practice)', (await A.js(setBotsJs(6))) === '6' && await A.clickSel('#gp-skill button[data-s="mixed"]'));
  check('the room has A\'s 6 bots (roster rows owned by A)', await A.until(`F1.net.roster.filter(function (r) { return r.bot && r.mine; }).length === 6`, 5000),
    await A.js(`F1.net.roster.map(function (r) { return [r.id, r.name, r.bot, r.car, r.slot, r.skill]; })`));
  await A.pick('mc-1929');
  check('A on Monaco simulating them', await A.until(`F1.game.running && F1.game.trackData.id === 'mc-1929' && F1.game.bots.length === 6`, 30000));
  await B.click('tab-mp');
  await B.field('mp-addr', '127.0.0.1:' + PORT);
  check('B joins, loads Monaco', await B.click('mp-join') && await B.until(`F1.net.connected && F1.game.running && F1.game.trackData && F1.game.trackData.id === 'mc-1929'`, 30000));
  check('B sees the 6 bots as remote cars (+ A): 7 models', await B.until(`F1.net.players.filter(function (p) { return p.bot && p.active; }).length === 6 && Object.keys(F1.game.remoteModels).length === 7`, 10000),
    await B.js(`F1.net.players.map(function (p) { return [p.id, p.name, p.bot, p.car, p.active]; })`));
  const namesA = await A.js(`F1.game.bots.map(function (b) { return b.id + ' ' + b.name + ' ' + b.spec.id; }).sort()`);
  const namesB = await B.js(`F1.net.players.filter(function (p) { return p.bot; }).map(function (p) { return p.id + ' ' + p.name + ' ' + p.car; }).sort()`);
  check('the same 6 drivers / cars on both (B took a McLaren seat: the bots\' lineup leaves it to B)', J(namesA) === J(namesB) && namesA.length === 6, { namesA, namesB });
  await A.js(`__bots.skill = 0.85; __bots.start()`); await B.js(`__bots.skill = 0.8; __bots.seed = 99; __bots.start()`);
  await sleep(6000);
  // positions: A's bots (local) against B's view of them (remote, interpolated 100 ms back + the lead)
  const pos = async () => {
    const [a, b] = await Promise.all([A.js(`F1.game.bots.map(function (x) { return [x.id, x.car.state.x, x.car.state.z, x.car.state.speed]; })`),
      B.js(`F1.net.players.filter(function (p) { return p.bot; }).map(function (p) { return [p.id, p.state.x, p.state.z, p.state.speed]; })`)]);
    return a.map(x => { const y = b.find(q => q[0] === x[0]); return y ? [x[0], r1(Math.hypot(x[1] - y[1], x[2] - y[2])), r1(x[3])] : [x[0], 999, r1(x[3])]; });
  };
  const fp = await pos();
  check('free practice: B draws each bot where A drives it (within 0.3 s of its motion + 3 m)', fp.every(x => x[1] < Math.abs(x[2]) * 0.3 + 3), fp);
  await B.shotTo('room-01-guest-free');
  /* the Grand Prix */
  await A.toMenu(); await A.click('tab-gp');
  await A.field('gp-q', '1'); await A.field('gp-r', '2');
  check('A starts a Grand Prix (Q 1, R 2): qualifying on both', await A.click('gp-start') && await B.until(`F1.gp.phase === 'quali'`, 5000) && await A.until(`F1.gp.phase === 'quali'`, 2000));
  await A.toTrack(); await B.toTrack();
  const q = await B.js(`({ n: F1.gp.snapshot.players.length, bots: F1.gp.snapshot.players.filter(function (p) { return p.bot; }).length })`);
  check('qualifying: 8 drivers, 6 bots (B\'s snapshot)', q.n === 8 && q.bots === 6, q);
  check('qualifying done for all 8 (real time): the grid on both', await A.until(`F1.gp.phase === 'grid'`, 300000, 'grid') && await B.until(`F1.gp.phase === 'grid'`, 3000));
  const qa = await A.js(playersJs), ga = await A.js(`F1.gp.snapshot.grid.slice()`), gb = await B.js(`F1.gp.snapshot.grid.slice()`);
  check('every bot\'s qualifying lap accepted by the server (a time, qDone; no botLapRejected)', qa.filter(p => p.bot).every(p => p.qDone && p.qBest > 0) && (await A.js(`__botRej.length`)) === 0,
    { q: qa.map(p => [p.name, p.qBest, p.qDone]), rej: await A.js(`__botRej`) });
  const byT = qa.slice().sort((x, y) => (x.qBest || 1e9) - (y.qBest || 1e9)).map(p => p.id);
  check('the grid is the qualifying order, the same on A and B', J(ga) === J(gb) && J(ga) === J(byT), { ga, gb, byT });
  await sleep(1500);
  const gridB = await B.js(`(function () { var s = F1.gp.snapshot, G = F1.game.track.grid; return F1.net.players.filter(function (p) { return p.bot; }).map(function (p) {
    var k = s.grid.indexOf(p.id), bx = G[k]; return [p.id, k, k < 0 ? -1 : +Math.hypot(p.state.x - (bx.x - Math.sin(bx.heading) * 2.8), p.state.z - (bx.z - Math.cos(bx.heading) * 2.8)).toFixed(2)]; }); })()`);
  check('B sees each bot in the grid box of its place', gridB.every(x => x[2] >= 0 && x[2] < 1.5), gridB);
  await B.shotTo('room-02-guest-grid');
  check('lights out on both', await A.until(`F1.gp.phase === 'race'`, 20000) && await B.until(`F1.gp.phase === 'race'`, 3000));
  await sleep(3000);
  await B.shotTo('room-03-guest-start');
  // live standings and positions, sampled during the race
  let same = 0, samples = 0, worst = [];
  for (let k = 0; k < 8; k++) {
    await sleep(9000);
    if (!(await A.js(`F1.gp.phase === 'race'`))) break;
    const [oa, ob] = await Promise.all([A.js(`F1.gp.view().rows.map(function (r) { return r.id; }).join()`), B.js(`F1.gp.view().rows.map(function (r) { return r.id; }).join()`)]);
    samples++; if (oa === ob) same++;
    const p = await pos(); worst = worst.concat(p.filter(x => x[1] >= Math.abs(x[2]) * 0.3 + 3));
  }
  check('live standings: the same order on A and B in ' + same + ' of ' + samples + ' samples (at least all but one)', samples >= 4 && same >= samples - 1, { same, samples });
  check('race: B draws every bot where A drives it (within 0.3 s of its motion + 3 m) in every sample', worst.length === 0, worst);
  check('the race to the results on both', await A.until(`F1.gp.phase === 'results'`, 300000, 'results') && await B.until(`F1.gp.phase === 'results'`, 5000));
  await sleep(1500);
  const ra = await A.js(rowsJs), rb = await B.js(rowsJs);
  info('results: ' + ra.map(x => x.pos + '. ' + x.name + (x.bot ? ' (AI)' : '') + ' ' + (x.time ? fmt(x.time) : (x.dnf ? 'DNF' : '--'))).join(' | '));
  check('results identical on A and B', J(ra) === J(rb.map(x => Object.assign({}, x, { self: ra.find(y => y.id === x.id).self }))), { ra, rb });
  check('every bot took the flag after 2 laps (all its laps accepted by the server), no bot lap rejected', ra.filter(x => x.bot).every(x => x.done && x.laps === 2 && !x.dnf) && (await A.js(`__botRej.length`)) === 0,
    { rows: ra.filter(x => x.bot), rej: await A.js(`__botRej`) });
  const dom = await B.js(`({ rows: document.querySelectorAll('#gp-results-body tbody tr').length, ai: document.querySelectorAll('#gp-results-body .gp-ai').length })`);
  check('B\'s results overlay: 8 rows, 6 AI tags', dom.rows === 8 && dom.ai === 6, dom);
  await B.shotTo('room-04-guest-results');
  check('A ends it (結束 on the results overlay): free practice on both', await A.click('gp-res-end') && await B.until(`F1.gp.phase === 'free'`, 5000));
  await A.toMenu(); await A.click('tab-mp');
  check('A leaves the room: B has no bot left (disconnected: the in-game room closes with its host)', await A.click('mp-leave') &&
    await B.until(`(!F1.net.connected || F1.net.players.filter(function (p) { return p.bot; }).length === 0) && Object.keys(F1.game.remoteModels).length === 0`, 8000),
    await B.js(`({ c: F1.net.connected, p: F1.net.players.length, m: Object.keys(F1.game.remoteModels).length })`));
  check('A alone again: his 6 bots back offline', await A.until(`!F1.net.connected && F1.game.bots.length === 6`, 8000), await A.js(`F1.game.bots.length`));
  await A.noBotErr(); await B.noBotErr();
  await A.noErrors(); await B.noErrors();
  try { await host.stopServer(); } catch (e) {}
  await closeAll();
}

// the dedicated server: A (host) leaves in the middle of the race
async function partHost() {
  setPart('host');
  const srv = await require(path.join(L.ROOT, 'net', 'server')).createServer({ port: PORT2, log: null });
  try {
    const A = await rtWin('HA', { year: YEAR, car: CAR }, false), B = await rtWin('HB', { year: YEAR, car: CAR_B }, false);
    for (const w of [A, B]) { await w.click('tab-mp'); await w.field('mp-addr', '127.0.0.1:' + PORT2); }
    check('A joins the dedicated server first: the host', await A.click('mp-join') && await A.until(`F1.net.connected && F1.net.isHost`, 6000));
    await A.click('tab-gp');
    check('A: 3 bots', (await A.js(setBotsJs(3))) === '3' && await A.until(`F1.net.roster.filter(function (r) { return r.bot; }).length === 3`, 5000));
    await A.pick('mc-1929');
    check('A on Monaco with his 3 bots', await A.until(`F1.game.running && F1.game.bots.length === 3`, 30000));
    check('B joins', await B.click('mp-join') && await B.until(`F1.net.connected && F1.game.running && F1.net.players.filter(function (p) { return p.bot && p.active; }).length === 3`, 30000));
    await A.toMenu(); await A.click('tab-gp');
    await A.field('gp-q', '1'); await A.field('gp-r', '3');
    const started = await A.click('gp-start') && await A.until(`F1.gp.phase === 'quali'`, 4000);
    await A.toMenu();
    check('A starts (Q 1, R 3) and skips qualifying: the grid', started && await A.click('gp-skip') && await B.until(`F1.gp.phase === 'grid'`, 5000));
    await A.toTrack(); await B.toTrack();
    await A.js(`__bots.start()`); await B.js(`__bots.start()`);
    check('lights out', await B.until(`F1.gp.phase === 'race'`, 20000));
    await sleep(20000);
    const before = await B.js(rowsJs);
    await A.toMenu(); await A.click('tab-mp');
    check('A (the host, owner of the bots) leaves in the middle of the race', await A.click('mp-leave') && await A.until(`!F1.net.connected`, 5000));
    check('B: A\'s bots are gone (no bot car, no bot model), B is the host now', await B.until(`F1.net.players.filter(function (p) { return p.bot; }).length === 0 && Object.keys(F1.game.remoteModels).length === 0 && F1.net.isHost`, 8000),
      await B.js(`({ p: F1.net.players.map(function (p) { return [p.id, p.bot, p.active]; }), host: F1.net.isHost, m: Object.keys(F1.game.remoteModels).length })`));
    check('the race closes with the bots (and A) out: the results as they stood, B classified', await B.until(`F1.gp.phase === 'results'`, 5000), await B.js(`F1.gp.phase`));
    const after = await B.js(rowsJs);
    info('before: ' + before.map(x => x.pos + '. ' + x.name + (x.bot ? ' (AI)' : '')).join(' | ') + '  after: ' + after.map(x => x.pos + '. ' + x.name + (x.bot ? ' (AI)' : '') + (x.dnf ? ' DNF' : '')).join(' | '));
    check('B\'s results: the bots and A DNF (left), B classified', after.some(x => x.self && !x.dnf) && after.filter(x => !x.self).every(x => x.dnf || x.left), after);
    await B.shotTo('host-01-B-after');
    check('B (now host) ends it: free practice', await B.toMenu() && await B.click('tab-gp') && await B.click('gp-end') && await B.until(`F1.gp.phase === 'free'`, 4000));
    await A.noBotErr(); await B.noBotErr();
    await A.noErrors(); await B.noErrors();
  } finally { await closeAll(); try { await srv.close(); } catch (e) {} }
}

// frame rate at a race start with 15 bots (real time)
async function partPerf() {
  setPart('perf');
  for (const id of ['mc-1929', 'be-1925']) {
    const w = await rtWin('P' + id, { year: YEAR, car: CAR }, false,
      `localStorage.setItem('f1drive.bots', ${J(J({ count: 15, skill: 'mixed' }))}); localStorage.setItem('f1drive.gp', ${J(J({ q: 1, r: 3, wear: 1 }))}); true`);
    await w.pick(id);
    check(id + ': 15 bots', await w.until(`F1.game.running && F1.game.bots.length === 15`, 30000));
    await w.js(`__bots.start()`);
    await w.toMenu(); await w.click('tab-gp');
    check(id + ': Grand Prix, qualifying skipped: the grid', await w.click('gp-start') && await w.until(`F1.gp.phase === 'quali'`, 3000) && await w.toMenu() && await w.click('gp-skip') &&
      await w.until(`F1.gp.phase === 'grid' && F1.game.running`, 4000));
    check(id + ': lights out', await w.until(`F1.gp.phase === 'race'`, 15000));
    await sleep(1500);
    await w.js(`__cost(true); F1.game.botCost(true); true`);
    await sleep(15000);
    const c = await w.js(`__cost(true)`), bc = await w.js(`F1.game.botCost(true)`), cs = await w.js(`__bots.contactSummary()`);
    info(id + ': race start with 15 bots: ' + c.fps + ' fps, longest frame gap ' + c.maxGap + ' ms (' + c.over50 + ' over 50 ms); main thread ms/frame mean ' + c.mean + ' p95 ' + c.p95 + ' max ' + c.max + '; the bots\' share ' + J(bc) + '; contacts ' + J(cs));
    check(id + ': 60 fps held at the start with 15 bots (>= 57; ' + c.fps + '), main thread p95 under 8 ms (' + c.p95 + ')', c.fps >= 57 && c.p95 < 8, c);
    await w.shotTo('perf-' + id);
    await w.noBotErr();
    await w.noErrors();
    await closeAll();
  }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const t0 = Date.now();
  const parts = { panel: partPanel, ram: partRam, pits: partPits, blue: partBlue, suzuka: partSuzuka, room: partRoom, host: partHost, perf: partPerf };
  for (const k of ['monza', 'monaco', 'panel', 'ram', 'pits', 'blue', 'suzuka', 'room', 'host', 'perf']) {
    if (!ONLY.includes(k)) continue;
    try { if (RACES[k]) await partRace(k); else await parts[k](); }
    catch (e) { check(k + ': part ran to the end', false, e && e.stack ? e.stack : String(e)); await closeAll(); }
  }
  info('duration ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s; screenshots ' + OUT);
  const bad = L.summary();
  await closeAll();
  app.exit(bad ? 1 : 0);
});
