// A whole ONLINE Grand Prix in REAL TIME, driven to the chequered flag by autopilots: four offscreen windows of the real
// game in one Electron process, with the real preload / host IPC / server (net/host.js -> net/server.js).
//   npx electron devtests/gp-e2e/online.js            about 11 minutes; exit code 1 when a check fails
//   env PORT=24850 (the room's TCP port)   PATCH=<project file>=<replacement>,... (see lib.js: run against patched copies)
//       SKIP=quali1,race1  DEVELOPMENT ONLY: quali1 = the host skips the first qualifying after 8 s (grid = join order),
//                          race1 = the host ends the first race 40 s after the start (no finish); the checks of what is
//                          skipped are not run
// Screenshots go to devtests/gp-e2e/out/ (NN-phase-role.png).
//
// Cars are driven through the game's real input path: a fake standard-mapping controller behind navigator.getGamepads
// (page.js) whose stick / triggers are set by autopilot.js (pure pursuit of the racing line, scaled target speeds).
// Nothing is time-warped: the server's clock is real and it rejects laps quicker than length / 91.67 m/s. Track: Monaco
// (mc-1929, the shortest; a lap is 86 s at pace 1.0).
//
// Scenario (A = Alice, the host; B = Bob; C = Carol; D = Dave, who joins late). Pace = scale of the line's target speeds.
//   room     A creates the room, B and C join, A picks Monaco: free practice on the room slots, solid cars
//   run 1    A starts Q = 1, R = 2 from the menu panel.
//     quali  pace C 1.0, A 0.93, B 0.82, all at once as ghosts. C drives straight THROUGH A's standing car at the start
//            (on purpose; A catches and drives through B later in the lap): no impact. C reports three impossible laps
//            (too fast / too soon / more than the clock allows): toast, standings unchanged; its real lap still counts.
//            -> grid by itself when the last one finishes
//     grid   C, A, B in boxes 1, 2, 3, frozen; lights in step; lights out at the same session time; all three launch.
//            (A 12 ms main-thread stall is injected on the pole car right before its lights-out frame: the race clock
//            must still not run ahead of the session clock.)
//     race   B rams A at the start on purpose (impact on both sides), then parks beside the road 120 m after the line
//            until C and A have lapped it and drives on: it finishes a lap down ("+1 圈"). (CHANGED from the brief, which
//            suggests a pure pace difference: a car at under half the pace would have to be overtaken on the road by
//            autopilots; a long stop gives the same classification without that.) D joins during the race: spectator.
//            Live standings compared between the four windows every 3 s. Results on all four.
//   run 2    再來一場 (D takes part now) -> the host ends it from the menu (結束大獎賽) -> new Grand Prix Q = 1, R = 1 ->
//            跳過排位 at once (grid = join order A B C D) -> race: D leaves the room (離線 / DNF), B stops for good, A wins,
//            C finishes, the race closes 90 s after the winner (countdown), B is classified without a finish.
//   free     結束 -> free practice: roster box back, solid cars (C bumps A on purpose), A drives a timed lap: best lap in
//            the roster box of every window.
// Measured on the way: frame rate per window and phase, session-clock agreement between the windows, lights out per
// window (session clock and real time), the race clock against the session clock frame by frame after each start,
// lap / race times.
//
// v6 (2026-10-01): the menu's side panel is tabbed (車輛 / 大獎賽 / 多人連線 / 設定): the harness opens the tab whose
// controls it clicks (a control in a hidden tab cannot be clicked). The room's season is the host's (every window has
// the 2025 standard car = the v5 car picked before it boots, lib.js / ref-car.js: since v6.1 a fresh install would drive
// the 2026 one), and the results subtitle names it. The server wants every lap backed by
// driving it has seen: besides the three impossible laps C also reports a plausible one while it has covered less than
// a lap ('not-driven'), and in session 2 D drives a real lap but stands 55 s of it beside the road while its "network"
// delivers none of its car states ('no-data'); both refused with their toasts, the standings unchanged. Impacts are relayed by the server only
// between nearby cars with fresh positions: every contact here is driven (autopilot 'ram' through the pad).
// The v6 online scenario (password, seasons, liveries, ERS, pit stops) is devtests/gp-e2e/online-v6.js.
//
// Other files here: autopilot.js (the driver, pure logic), page.js (runs in the page: fake controller, programmes,
// recorders, DOM readers), lib.js (windows, checks, PATCH), and
//   node devtests/gp-e2e/ap-sim.js                 the autopilot against the real car physics in node (1 s)
//   npx electron devtests/gp-e2e/bench.js          N windows alone: frame rates, lap times, recovery (2.5 min)
//   npx electron devtests/gp-e2e/start-clock.js    the race clock at lights out over six online starts (80 s)
//   node devtests/gp-e2e/make-patched.js           writes the mutants (mutants/: deliberately broken copies) for PATCH=...
// (devtests/gp-e2e/solo.js is the single-player Grand Prix, time-warped: another harness with its own page script.)
'use strict';
const electron = require('electron');
const { app, ipcMain } = electron;
const path = require('path');
const L = require('./lib');                       // (PATCH is applied in here, before net/host.js is loaded)
require('../electron-userdata')(app, 'gp-e2e-online');
const host = require(path.join(L.ROOT, 'net', 'host'));
const { sleep, J, check, info, setPart, fmt, hudTime, hudGap } = L;

const PORT = Number(process.env.PORT || 24850);
const SKIP = (process.env.SKIP || '').split(',').filter(Boolean);
const SKIP_Q = SKIP.indexOf('quali1') >= 0, SKIP_R = SKIP.indexOf('race1') >= 0;
const TRACK = 'mc-1929';
const PACE = [1, 0.93, 0.82];                     // by qualifying position
const HITCH_MS = 12;                             // stall injected on the pole car at the first lights out (see "race clock")
const PARK = { index: 60, d: -5.6 };              // beside the road on the pit straight; the racing line is at d = +5.3 there
                                                  //   (the v6 pit lane is on the other side, d = +12.6)
const NODATA_S = 55;                              // s D stands with its car states dropped in session 2 ('no-data')
const NAMES = { A: 'Alice', B: 'Bob', C: 'Carol', D: 'Dave' };
const SWATCH = { A: 1, B: 2, C: 4, D: 5 };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const r3 = v => Math.round(v * 1000) / 1000;
const inBox = b => !!b && near(b.nose, 0.25, 0.02) && near(b.off, 0, 0.02) && near(b.turn, 0, 1e-6) && b.v === 0;
const all = (wins, fn) => Promise.all(wins.map(fn));
const posIs = (h, n, count) => h.pos.replace(/[^P0-9/]/g, '') === 'P' + n + '/' + count;
const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(0) + ' s';

const W = {};                                     // tag -> window
let YEAR = 2025;                                  // the room's season (read from the host once the room is up)
const fpsLog = [];                                // { label, tag, fps, maxGap, slow }
const timings = {};
const shots = [];

async function fpsMark(label, wins) {
  const rows = await all(wins, w => w.e('fps()'));
  rows.forEach((f, i) => fpsLog.push({ label, tag: wins[i].tag, fps: f.fps, maxGap: f.maxGap, slow: f.slow, frames: f.frames }));
  info('frame rate, ' + label + ': ' + rows.map((f, i) => wins[i].tag + ' ' + f.fps.toFixed(1) + ' fps (longest frame ' + f.maxGap.toFixed(0) + ' ms)').join(', '));
}
// every client's estimate of the server clock against the one real clock all the windows share (Date.now())
const clockLog = [];
async function clockMark(label, wins) {
  const off = await all(wins, w => w.js(`F1.net.serverNow() - Date.now()`));
  const spread = Math.max(...off) - Math.min(...off);
  clockLog.push({ label, spread, off: off.map(o => Math.round(o * 10) / 10) });
  info('session clock, ' + label + ': server clock - wall clock as each window has it: ' + off.map((o, i) => wins[i].tag + ' ' + o.toFixed(1) + ' ms').join(', ') + '  (spread ' + spread.toFixed(1) + ' ms)');
}
async function shot(w, name) { shots.push(path.basename(await w.shot(name))); }
async function waitAll(wins, code, ms, what) {
  const ok = await all(wins, w => w.until(code, ms, what));
  return ok.every(Boolean);
}

// the session as a window has it, comparable between windows
const sessKey = v => J({ phase: v.phase, sid: v.sid, q: v.q, r: v.r, rows: v.rows.map(r => [r.id, r.name, r.laps, r.best, r.time, r.gap, r.down, r.done, r.dnf, r.left]), spec: v.spectators.map(s => s.id) });
const domKey = h => J(h.rows.map(r => [r.pos, r.name, r.sub, r.val, r.out]));
async function agree(wins, tries) {
  let vs = null;
  for (let k = 0; k < (tries || 5); k++) {
    vs = await all(wins, w => w.js(`({ v: __e2e.view(), h: __e2e.hud() })`));
    if (vs.every(x => sessKey(x.v) === sessKey(vs[0].v)) && vs.every(x => domKey(x.h) === domKey(vs[0].h))) return { ok: true, tries: k + 1, vs };
    await sleep(130);
  }
  return { ok: false, tries: tries || 5, vs };
}
// what a row of the HUD session box / menu standings must say for a GpView row (js/ui.js is the implementation under test)
function rowText(v, r, i) {
  if (v.phase === 'race' || v.phase === 'results') {
    const fin = v.phase === 'results';
    if (fin && i === 0 && r.done && r.time != null) return hudTime(r.time);
    if (r.left && !r.done) return '離線';
    if (r.dnf || (fin && !r.done)) return '未完賽 DNF';
    if (i === 0) return r.done ? '完賽' : '領先';
    if (r.down > 0) return '+' + r.down + ' 圈';
    if (typeof r.gap === 'number') return hudGap(r.gap);
    return r.done ? '完賽' : '--';
  }
  return hudTime(r.best);
}
const domMatchesView = x => x.h.rows.length === x.v.rows.length && x.v.rows.every((r, i) => x.h.rows[i].name === r.name && x.h.rows[i].pos === String(i + 1) && x.h.rows[i].val === rowText(x.v, r, i) &&
  x.h.rows[i].self === r.isSelf);

// One car on the grid until the race is on: what its frames showed.
// row (one per simulated frame): [perf, session clock the frame decided with, wall clock then, phase, locked, lamps in the DOM,
//   gp.lights, go class, box shown, speed, x, z, caption]
function analyseStart(rec, goAt) {
  const locked = rec.filter(r => r[4] === 1), first = locked[0];
  const movedWhileLocked = first ? locked.filter(r => r[9] !== 0 || r[10] !== first[10] || r[11] !== first[11]).length : -1;
  const seq = [];
  rec.forEach(r => { if (r[3] === 'grid' && (!seq.length || seq[seq.length - 1][0] !== r[5])) seq.push([r[5], r[0]]); });
  const gaps = [];
  for (let i = 2; i < seq.length && seq[i][0] > 0; i++) gaps.push(Math.round(seq[i][1] - seq[i - 1][1]));
  const out = rec.find(r => r[7] === 1);                      // first frame with the green "lights out" state on screen
  const lit5 = rec.filter(r => r[5] === 5);
  return { frames: rec.length, lockedFrames: locked.length, movedWhileLocked, lamps: seq.map(s => s[0]).join(''), gaps,
    outClock: out ? Math.round(out[1] - goAt) : null, outWall: out ? out[2] : null, outCaption: out ? out[12] : null,
    lastRedClock: lit5.length ? Math.round(lit5[lit5.length - 1][1] - goAt) : null,
    goFrames: rec.filter(r => r[7] === 1).length, domMismatch: rec.filter(r => r[3] === 'grid' && r[5] !== r[6]).length,
    captions: Array.from(new Set(rec.filter(r => r[8] === 1).map(r => r[12]))).join('|') };
}

function makeWin(tag) {
  const w = L.makeWin(electron, host, tag, { fps: 60 }); w.name = NAMES[tag]; W[tag] = w;
  // v6: the menu's side panel is tabbed; a control can only be clicked in the open tab (car / gp / mp / set)
  w.tab = async t => (await w.click('tab-' + t)) && w.js(`!document.getElementById(${J({ car: 'car-panel', gp: 'gp-panel', mp: 'mp-section', set: 'set-panel' }[t])}).classList.contains('hidden')`);
  return w;
}
const onTrack = `F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(TRACK)} && F1.net.trackId === ${J(TRACK)}`;
// The "network" of a window drops car states (the 's' messages) so that only one in `every` ms reaches the server:
// what a very bad connection does. Installed on WebSocket.prototype.send (js/net.js keeps its socket to itself).
const THIN = `(function () {
  if (!window.__thin) {
    var th = window.__thin = { on: false, every: 8000, last: -1e9, passed: 0, dropped: 0 }, send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (th.on && typeof data === 'string' && data.slice(0, 9) === '{"t":"s",') {
        var t = performance.now();
        if (t - th.last < th.every) { th.dropped++; return; }
        th.last = t; th.passed++;
      }
      return send.apply(this, arguments);
    };
  }
  return true;
})()`;

/* ================================================================================================================ */
async function scenario() {
  const A = makeWin('A'), B = makeWin('B'), C = makeWin('C'), D = makeWin('D');
  const ABC = [A, B, C], ABCD = [A, B, C, D];

  /* ---------------- room ---------------- */
  setPart('room');
  for (const w of ABCD) { const err = await w.open(); check(w.tag + ' boots without the error overlay', !err, err || undefined); }
  info('page: ' + L.pageFile() + (L.patched.length ? '   PATCHED: ' + L.patched.join(', ') : ''));
  check('preload API present: the host can create a room', await A.js(`!!window.f1host && F1.net.canCreate && !document.getElementById('mp-create').disabled`));
  const openMp = await all(ABCD, w => w.tab('mp'));
  check('v6 menu: the 多人連線 tab opens on every window', openMp.every(Boolean), openMp);
  for (const w of ABCD) {
    await w.field('mp-name', w.name);
    await w.js(`document.querySelectorAll('.mp-swatch')[${SWATCH[w.tag]}].click(); true`);
  }
  await A.field('mp-port', String(PORT));
  await A.click('mp-create');
  check('A creates the room (host)', await A.until(`F1.net.connected && F1.net.isHost`, 6000), await A.e(`text('mp-status')`));
  for (const w of [B, C]) {
    await w.field('mp-addr', '127.0.0.1:' + PORT);
    await w.click('mp-join');
    check(w.tag + ' joins', await w.until(`F1.net.connected && !F1.net.isHost`, 6000), await w.e(`text('mp-status')`));
  }
  await D.field('mp-addr', '127.0.0.1:' + PORT);           // (D joins later, in the middle of the race)
  await sleep(400);
  for (const w of ABC) { w.pid = await w.js(`F1.net.id`); w.slot = await w.js(`F1.net.slot`); }
  check('ids and room slots in join order', J(ABC.map(w => [w.pid, w.slot])) === '[[1,0],[2,1],[3,2]]', ABC.map(w => [w.tag, w.pid, w.slot]));
  check('menu: player list of three on every window', (await all(ABC, w => w.js(`__e2e.text('mp-players-title') + '|' + [].map.call(document.querySelectorAll('#mp-players li .mp-pname'), function (n) { return n.textContent; }).join(',')`)))
    .every(t => t === '玩家（3 / 16）|Alice,Bob,Carol'), await B.e(`text('mp-players')`));
  const openGp = await all(ABC, w => w.tab('gp'));
  const p0 = await all(ABC, w => w.e('panel()'));
  check('Grand Prix panel (大獎賽 tab): host must pick a track first; guests are told the host starts it', openGp.every(Boolean) && p0[0].setup && p0[0].startDisabled && p0[0].hint === '先幫房間選一條賽道' &&
    !p0[1].setup && p0[1].hint === '由房主開始大獎賽，開始後房間裡所有人會一起進入排位賽。' && p0[2].hint === p0[1].hint, p0.map(p => p.hint));
  const season = await all(ABC, w => w.js(`({ room: F1.net.year, car: F1.game.spec.id })`));
  YEAR = season[0].room;
  check('v6: the room has the host\'s season (its pick: 2025) and everybody drives the 2025 standard car (the v5 car)', season.every(s => s.room === 2025 && s.car === '2025-standard'), season);
  const picked = await A.pick(TRACK);
  check('A picks ' + picked + ': all three load it', await waitAll(ABC, onTrack, 25000, 'track'));
  const hostStatus = await A.e(`text('mp-status')`);
  check('host menu: once the room has a track the status line no longer asks the host to pick one', /你是房主/.test(hostStatus) && !/選一條賽道/.test(hostStatus), hostStatus);
  const guestBanner = await all([B, C], w => w.js(`document.getElementById('track-lock').textContent`));
  check('guest menu: once the room has a track the banner over the (locked) track grid no longer says it is waiting for the host to pick one', guestBanner.every(t => t && !/等待房主選擇賽道/.test(t)) &&
    (await B.js(`document.getElementById('track-grid').classList.contains('locked')`)), guestBanner);
  await sleep(1500);
  const len = await A.js(`F1.game.track.length`), N = await A.js(`F1.game.track.samples.length`), pred = await A.js(`F1.game.raceLine.lapTime`);
  const minLap = len / (330 / 3.6);
  info('track ' + len.toFixed(0) + ' m, ' + N + ' samples; the racing line predicts ' + fmt(pred) + '; the server rejects laps under ' + minLap.toFixed(2) + ' s');
  check('the fake controller is connected on every window (the game\'s real input path)', (await all(ABC, w => w.js(`F1.gamepad.state.connected && __e2e.shown('hud-hint-pad')`))).every(Boolean));
  let st = await all(ABC, w => w.e('state()'));
  let bx = await all(ABC, w => w.e(`box(${w.slot})`));
  check('free practice: every car in the grid box of its room slot, standing, no session', bx.every(inBox) && st.every(s => s.gp.phase === 'free' && s.gp.online && !s.gp.taking && s.running) &&
    st[0].car.d > 0 && st[1].car.d < 0 && st[2].car.d > 0, bx);
  let rem = await all(ABC, w => w.e('remotes()'));
  check('free practice: everybody sees the two others, solid, where they really are', ABC.every((w, i) => ABC.every((o, j) => i === j || (rem[i][o.name] && rem[i][o.name].active && rem[i][o.name].ghost === false &&
    rem[i][o.name].visible && Math.hypot(rem[i][o.name].x - st[j].car.x, rem[i][o.name].z - st[j].car.z) < 0.5))), rem[1]);
  let hud = await all(ABC, w => w.e('hud()')), ros = await all(ABC, w => w.e('roster()'));
  check('free practice HUD: roster box with the three players (no best laps yet), no session box, no lights', hud.every(h => h.roster && !h.gpShown && !h.lights.shown && !h.results && h.lapRow === '--') &&
    ros.every(r => J(r) === J([{ name: 'Alice', best: '--' }, { name: 'Bob', best: '--' }, { name: 'Carol', best: '--' }])), ros[1]);
  await shot(A, '01-free-host'); await shot(B, '01-free-guest');

  // B drives off its slot and over the line (timing starts) so that the qualifying placement really moves it back
  for (const w of ABC) await w.e('start()');
  await B.e(`set({ mode: 'line', scale: 0.5 })`);
  check('free practice: B drives over the line on the autopilot (lap timing starts)', await B.until(`F1.game.lap.started && F1.game.car.state.sampleIndex > 8 && F1.game.car.state.sampleIndex < 200`, 10000), await B.e('lap()'));
  await B.e(`set({ mode: 'stop' })`);
  await B.until(`Math.abs(F1.game.car.state.speed) < 0.1`, 5000);
  const bFree = await B.e('state()');
  check('free practice: B is timing lap 1, off its slot', bFree.lap.started && bFree.lap.n === 1 && bFree.car.i > 8 && (await B.e(`text('hud-lap')`)) === '1', bFree.lap);
  await fpsMark('room + free practice, incl. loading the track (D in the menu)', ABCD);

  /* ---------------- run 1: start from the menu panel ---------------- */
  setPart('run1 start');
  // grid order expected from the paces: C, A, B  (SKIP=quali1: join order A, B, C)
  const P = SKIP_Q ? [A, B, C] : [C, A, B];                  // P[0] pole ... P[2] last
  P.forEach((w, i) => { w.pace = PACE[i]; });
  // qualifying programmes: A waits 4 s in its box; C (directly behind it, 16 m) drives straight through it, then its lap
  await A.e(`arm({ onPhase: { quali: { mode: 'line', scale: ${A.pace}, holdFor: 4, acc: true, thrCap: 1, park: null } } })`);
  await B.e(`arm({ onPhase: { quali: { mode: 'line', scale: ${B.pace}, holdFor: 1, acc: true, thrCap: 1, park: null } } })`);
  await C.e(`arm({ onPhase: { quali: { mode: 'ram', ramId: ${A.pid}, ramSpeed: 40, scale: ${C.pace}, holdFor: 1, park: null } },
    ram: { id: ${A.pid}, untilDist: 1.0, timeout: 7, then: { mode: 'line' } } })`);
  await A.tap('Escape');
  check('host: Esc opens the menu', await A.js(`!F1.game.running && __e2e.shown('menu')`));
  check('host: Q / R fields take 1 / 2', (await A.field('gp-q', '1')) === '1' && (await A.field('gp-r', '2')) === '2');
  const p1 = await all(ABC, w => w.e('panel()'));
  check('host panel: 開始大獎賽 enabled with the room hint; guests have no setup', p1[0].setup && !p1[0].startDisabled && p1[0].hint === '房間裡所有人會一起進入排位賽。' && !p1[1].setup && !p1[2].setup, p1.map(p => p.hint));
  await shot(A, '02-menu-host');
  for (const w of ABC) { await w.e('prox(true)'); await w.e('stats(true)'); }
  const tQuali = Date.now();
  check('host clicks 開始大獎賽', await A.click('gp-start'));
  check('all three are in qualifying', await waitAll(ABC, `F1.game.gp.phase === 'quali'`, 4000, 'quali'));
  st = await all(ABC, w => w.e('state()'));
  bx = await all(ABC, w => w.e(`box(${w.slot})`));
  check('quali: session 1, everybody takes part, only the host may control; the host is out of the menu and driving', st.every(s => s.running && s.gp.taking && s.gp.online && s.gp.sid === 1 && s.gp.lap === 0 && s.gp.lapTotal === 1 && !s.gp.locked) &&
    st[0].gp.canControl && !st[1].gp.canControl && !st[2].gp.canControl && await A.js(`!__e2e.shown('menu') && __e2e.shown('hud')`), st.map(s => s.gp));
  check('quali: cars on their room slots (B was put back from beyond the line), lap counters reset', bx.every(inBox) && st.every(s => !s.lap.started && s.lap.n === 0 && s.car.v === 0), { bx, laps: st.map(s => s.lap) });
  await sleep(250);
  hud = await all(ABC, w => w.e('hud()'));
  const qRows0 = J([['1', 'Alice', '0/1', '--'], ['2', 'Bob', '0/1', '--'], ['3', 'Carol', '0/1', '--']]);
  check('quali HUD on every window: session box 排位賽 (replaces the roster box), P n / 3, 完成圈數 0 / 1, lap row 1 / 1, three rows, toast with the format',
    hud.every((h, i) => h.gpShown && !h.roster && h.title === '排位賽' && posIs(h, i + 1, 3) && h.lapShown && h.gpLap === '0 / 1' && h.lapRow === '1 / 1' &&
      J(h.rows.map(r => [r.pos, r.name, r.sub, r.val])) === qRows0 && h.rows[i].self && h.toast === '大獎賽開始：排位 1 圈，正賽 2 圈' && !h.lights.shown && !h.results), hud[1]);
  rem = await all(ABC, w => w.e('remotes()'));
  check('quali: everybody sees the others as ghosts (translucent, not solid)', ABC.every((w, i) => ABC.every((o, j) => i === j || (rem[i][o.name].ghost === true && rem[i][o.name].isGhost === true && rem[i][o.name].active))), rem[0]);
  await shot(B, '03-quali-guest');

  /* ---------------- run 1: qualifying ---------------- */
  setPart('run1 quali');
  // C through A
  const through = await C.until(`__e2e.ram && __e2e.ram.result`, 9000, 'C reaches A');
  await shot(A, '03-quali-host-ghost-through'); await shot(C, '03-quali-guest-inside-ghost');
  const ramQ = await C.e('ram.result'), aNow = await A.e('state()'), aBox = await A.e('box(0)');
  check('quali: C drives into A\'s standing car on purpose (centres under 1 m apart)', through && ramQ && ramQ.why === 'dist' && ramQ.dist < 1, ramQ);
  check('quali: A was not pushed (still in its box, standing, no impact)', inBox(aBox) && aNow.car.v === 0 && aNow.car.hit === 0, { aBox, hit: aNow.car.hit });
  await sleep(1500);
  let prox = await all(ABC, w => w.e('prox()'));
  check('quali: the two cars overlapped on both windows and neither felt an impact', prox[0][C.pid].minGhost < 1.6 && prox[2][A.pid].minGhost < 1.6 && prox[0][C.pid].hitGhost === 0 && prox[2][A.pid].hitGhost === 0 &&
    prox[0].hitMax === 0 && prox[2].hitMax === 0, { A: prox[0][C.pid], C: prox[2][A.pid] });

  // impossible laps from C: rejected with a toast, standings unchanged
  const snapKey = async () => J(await all(ABC, w => w.js(`(function () { var s = F1.gp.snapshot; return [s.phase, s.order, s.players.map(function (p) { return [p.id, p.qLaps, p.qBest, p.qDone]; })]; })()`)));
  const hudKey = async () => J((await all(ABC, w => w.e('hud()'))).map(h => [h.rows.map(r => [r.pos, r.name, r.sub, r.val]), h.gpLap, h.pos]));
  const before = await snapKey(), beforeHud = await hudKey();
  const reject = async (time, why, text) => {
    const n = await C.js(`__e2e.rejected.length`);
    const sent = await C.js(`F1.net.sendGpLap(F1.gp.sid, ${time})`);
    const got = await C.until(`__e2e.rejected.length > ${n}`, 3000, 'lapRejected');
    await sleep(200);
    const r = await C.js(`({ why: __e2e.rejected[__e2e.rejected.length - 1], toast: __e2e.hud().toast, gp: __e2e.gp() })`);
    check('rejected lap: a ' + time + ' s lap after ' + ((Date.now() - tQuali) / 1000).toFixed(0) + ' s of qualifying -> "' + why + '", toast "' + text + '"',
      sent === true && got && r.why === why && r.toast === text && r.gp.lap === 0 && r.gp.phase === 'quali', r);
    return got;
  };
  await reject(12.345, 'too-fast', '這一圈沒有被採計：圈速快得不合理');
  await shot(C, '04-quali-rejected-guest');
  await reject(45, 'too-soon', '這一圈沒有被採計：距離上一圈太近');
  check('rejected laps: the standings did not change on any window (session state and HUD rows)', (await snapKey()) === before && (await hudKey()) === beforeHud, before);
  if (!SKIP_Q) {
    while (Date.now() - tQuali < (minLap * 0.9 + 2.5) * 1000) await sleep(500);
    await reject(60, 'inconsistent', '這一圈沒有被採計：圈速和比賽時間對不上');
    // v6: a lap that passes every timing rule (not too fast, not too soon, fits the clock) but that the server has not
    // seen driven: C has covered well under a lap since qualifying began
    while (Date.now() - tQuali < (minLap + 3) * 1000) await sleep(250);
    const cPath = await C.js(`F1.game.lap.progress(F1.game.car.state.sampleIndex)`);
    await reject(r3((Date.now() - tQuali) / 1000 - 1.5), 'not-driven', '這一圈沒有被採計：伺服器沒有看到你跑完這一圈');
    info('C had driven ' + (cPath * 100).toFixed(0) + ' % of a lap past the line (the server wants 85 % of the track length covered)');
    check('rejected laps: still nothing changed; the other windows showed no such toast', (await snapKey()) === before && (await hudKey()) === beforeHud &&
      (await all([A, B], w => w.js(`__e2e.toasts.some(function (t) { return /沒有被採計/.test(t[1]); })`))).every(x => x === false), await C.e('toasts'));
  }

  let qTimes = null;
  if (SKIP_Q) {
    while (Date.now() - tQuali < 8000) await sleep(200);
    for (const w of ABC) await w.e('lightsRec()');
    await A.js(`F1.game.gp.action('skip')`);
  } else {
    // C finishes first
    let last = 0, cDone = false;
    while (Date.now() - tQuali < 150000 && !(cDone = await C.js(`F1.gp.view().done`))) {
      await sleep(500);
      if (Date.now() - last > 10000) { last = Date.now(); const s = await all(ABC, w => w.e('state()')); info('[' + secs() + '] quali ' + s.map((x, i) => ABC[i].tag + ' @' + x.car.i + ' ' + (x.car.v * 3.6).toFixed(0) + ' km/h').join('  ')); }
    }
    for (const w of ABC) await w.e('lightsRec()');
    await sleep(300);
    const ag = await agree(ABC), cLap = (await C.e('lapsDone')).filter(l => l.phase === 'quali'), hc = await C.e('hud()');
    check('quali: C\'s real lap counts although four were rejected before it', cDone && cLap.length === 1 && ag.vs[2].v.rows[0].name === 'Carol' && ag.vs[2].v.rows[0].best === r3(cLap[0].time) && ag.vs[2].v.rows[0].done &&
      ag.vs[2].v.phase === 'quali', { lap: cLap, row: ag.vs[2].v.rows[0] });
    check('quali: every window shows Carol first with that time and 完成, the others 0/1; C is told to wait', ag.ok && ag.vs.every(domMatchesView) &&
      J(ag.vs[1].h.rows.map(r => [r.name, r.sub, r.val])) === J([['Carol', '完成', hudTime(r3(cLap[0].time))], ['Alice', '0/1', '--'], ['Bob', '0/1', '--']]) &&
      hc.note === '排位完成，等待其他車手' && posIs(hc, 1, 3) && hc.gpLap === '1 / 1', { rows: ag.vs[1].h.rows, note: hc.note });
    // C drives on while it waits (nothing counts any more): its timing box has stopped at the counted lap
    await sleep(1500);
    const hc2 = await C.e('hud()');
    check('quali: while C waits, its timing box has stopped at the counted lap (本圈 --, 上一圈 = 最快圈 = the standings\' time) although it drives on', hc2.cur === '--' &&
      hc2.last === hudTime(r3(cLap[0].time)) && hc2.best === hc2.last && (await C.js(`F1.game.lap.started && F1.game.car.state.speed > 10`)), { cur: hc2.cur, last: hc2.last, best: hc2.best });
    await shot(B, '05-quali-times-guest');
  }

  /* ---------------- run 1: grid ---------------- */
  const gridAuto = await waitAll(ABC, `F1.game.gp.phase === 'grid'`, SKIP_Q ? 4000 : 170000 - (Date.now() - tQuali), 'grid');
  const tGrid = Date.now();
  setPart('run1 grid');
  timings.quali1 = (tGrid - tQuali) / 1000;
  check(SKIP_Q ? 'the host skipped qualifying -> grid' : 'the session went to the grid by itself when the last driver finished its lap (' + timings.quali1.toFixed(1) + ' s of qualifying)', gridAuto);
  if (!gridAuto) throw new Error('no grid: cannot go on');
  // race programmes: pole drives; P2 pulls away gently until it is hit; P3 rams P2, waits 1.5 s, parks until lapped by both
  await P[0].e(`arm({ onPhase: { grid: { mode: 'line', scale: ${PACE[0]}, holdFor: 0, thrCap: 1, park: null } }, ram: null })`);
  await P[1].e(`arm({ onPhase: {}, ram: null, onHit: { then: { thrCap: 1 } } })`);
  await P[2].e(`arm({ onPhase: {}, ram: { id: ${P[1].pid}, untilHit: true, after: 0.25, timeout: 7, then: { mode: 'line', holdFor: 1.5, park: ${J(PARK)} } },
    release: { ids: [${P[0].pid}, ${P[1].pid}], clear: 15, then: { park: null, scale: ${PACE[1]} } } })`);
  await P[0].e(`set({ mode: 'line', scale: ${PACE[0]}, holdFor: 0, thrCap: 1, park: null })`);
  await P[1].e(`set({ mode: 'line', scale: ${PACE[1]}, holdFor: 0, thrCap: 0.3, park: null })`);
  await P[2].e(`set({ mode: 'ram', ramId: ${P[1].pid}, ramSpeed: 30, scale: ${PACE[2]}, holdFor: 0, thrCap: 1, park: null })`);
  // fault injection: the pole car's main thread stalls for HITCH_MS right before its lights-out frame (less than one
  // frame: what a GC pause at that moment does). Nothing may come of it but a start that is that much later.
  await P[0].js(`__e2e.hitch = ${HITCH_MS}; true`);
  st = await all(P, w => w.e('state()'));
  bx = await all(P, (w, i) => w.e(`box(${i})`));
  const snaps = await all(ABC, w => w.e('snap()'));
  if (!SKIP_Q) {
    const laps = await all(ABC, w => w.e('lapsDone'));
    qTimes = laps.map(l => l.filter(x => x.phase === 'quali' && x.sid === 1).map(x => x.time));
    timings.qualiLaps = { A: qTimes[0][0], B: qTimes[1][0], C: qTimes[2][0] };
    info('qualifying laps (each car\'s own lap counter): C ' + fmt(qTimes[2][0]) + '  A ' + fmt(qTimes[0][0]) + '  B ' + fmt(qTimes[1][0]));
    check('quali: one timed lap each, in pace order C < A < B, none under the server minimum', qTimes.every(q => q.length === 1) && qTimes[2][0] < qTimes[0][0] - 2 && qTimes[0][0] < qTimes[1][0] - 2 && qTimes[2][0] > minLap, qTimes);
    const byId = {}; snaps[0].players.forEach(p => { byId[p.id] = p; });
    check('quali: the server has exactly those lap times', ABC.every((w, i) => byId[w.pid].qBest === r3(qTimes[i][0]) && byId[w.pid].qLaps === 1 && byId[w.pid].qDone), snaps[0].players.map(p => [p.name, p.qBest]));
    prox = await all(ABC, w => w.e('prox(true)'));
    const stats = await all(ABC, w => w.e('stats(true)'));
    check('quali: A caught B and drove through it; no impact of any kind on any car in the whole qualifying (ghosts, no wall)', prox[0][B.pid].minGhost < 2.5 && prox.every(p => p.hitMax === 0) &&
      stats.every(s => s.wall === 0 && s.car === 0 && s.resets === 0 && s.reverses === 0), { closest: { 'A-B': +prox[0][B.pid].minGhost.toFixed(2), 'A-C': +prox[0][C.pid].minGhost.toFixed(2), 'B-C': +prox[1][C.pid].minGhost.toFixed(2) },
      stats: stats.map(s => ({ wall: s.wall, grass: s.grass, resets: s.resets })) });
  }
  await fpsMark('qualifying', ABCD);
  await clockMark('on the grid', ABC);
  check('grid: slots in qualifying order on every window: ' + P.map(w => w.name).join(', ') + ' (pole first)', snaps.every(s => J(s.grid) === J(P.map(w => w.pid))) && st.every((s, i) => s.gp.gridSlot === i), snaps[0].grid);
  check('grid: each car stands in the painted box of its grid slot (box 1 left, 2 right, 3 left)', bx.every(inBox) && st[0].car.d > 0 && st[1].car.d < 0 && st[2].car.d > 0, bx);
  check('grid: all three locked and standing, lap counters reset, the game running', st.every(s => s.gp.locked && s.gp.phase === 'grid' && s.car.v === 0 && s.running && !s.lap.started && s.lap.n === 0), st.map(s => s.gp));
  // (the others were driving when the grid formed: their new positions take a network round trip + the 100 ms
  //  interpolation delay to show up)
  let seenMs = null;
  for (let k = 0; k < 40 && seenMs === null; k++) {
    rem = await all(P, w => w.e('remotes()'));
    if (P.every((w, i) => P.every((o, j) => i === j || (rem[i][o.name].active && Math.hypot(rem[i][o.name].x - st[j].car.x, rem[i][o.name].z - st[j].car.z) < 0.5)))) seenMs = Date.now() - tGrid;
    else await sleep(50);
  }
  timings.gridSeenMs = seenMs;
  check('grid: everybody sees the two others standing on their slots (within ' + seenMs + ' ms of the grid forming); still ghosts while the cars are being placed', seenMs !== null && seenMs < 1500 &&
    P.every((w, i) => P.every((o, j) => i === j || (rem[i][o.name].ghost === true && rem[i][o.name].isGhost === true))), rem[0]);
  hud = await all(P, w => w.e('hud()'));
  check('grid HUD: 起跑, lights box 準備起跑 with no lamp yet, toast with the grid position', hud.every((h, i) => h.title === '起跑' && h.lights.shown && h.lights.text === '準備起跑' && h.lights.on === 0 && !h.lights.go &&
    h.toast === '起跑位置 P' + (i + 1) + ' / 3，燈號全滅就起跑' && posIs(h, i + 1, 3) && !h.lapShown), hud.map(h => [h.title, h.toast, h.lights]));
  if (!SKIP_Q) {
    const ag = await agree(ABC);
    check('grid: standings on every window: same order and times (C, A, B with their qualifying laps)', ag.ok && ag.vs.every(domMatchesView) &&
      J(ag.vs[0].h.rows.map(r => [r.pos, r.name, r.val])) === J([['1', 'Carol', hudTime(r3(qTimes[2][0]))], ['2', 'Alice', hudTime(r3(qTimes[0][0]))], ['3', 'Bob', hudTime(r3(qTimes[1][0]))]]), ag.vs[0].h.rows);
  }
  let lampsTogether = true, solidSeen = false, shotLights = false, polls = 0;
  const endGrid = Date.now() + 17000;
  while (Date.now() < endGrid) {
    const s = await all(P, w => w.js(`({ l: __e2e.lightsNow(), g: __e2e.gp(), v: F1.game.car.state.speed })`));
    polls++;
    const lit = s.map(x => x.g.lights);
    if (Math.max(...lit) - Math.min(...lit) > 1) lampsTogether = false;
    if (!solidSeen && s.every(x => x.g.lights >= 1 && x.g.phase === 'grid')) {
      solidSeen = true;
      rem = await all(P, w => w.e('remotes()'));
      check('grid: the cars are solid for each other once the lights come on', P.every((w, i) => P.every((o, j) => i === j || (rem[i][o.name].ghost === false && rem[i][o.name].isGhost === false))), rem[0]);
    }
    if (!shotLights && s[0].l.on >= 3) { shotLights = true; await shot(A, '06-grid-host'); await shot(P[0], '06-grid-pole'); }
    if (s.every(x => x.g.phase === 'race' && x.v > 2)) break;
    await sleep(50);
  }
  setPart('run1 start lights');
  st = await all(P, w => w.e('state()'));
  const go = await all(P, w => w.e('go')), launch = await all(P, w => w.e('launch()'));
  const rec = await all(P, w => w.e('lightsStop()'));
  const an = rec.map((r, i) => analyseStart(r, go[i] ? go[i].goAt : 0));
  const snapR = await P[0].e('snap()');
  P.forEach((w, i) => info(w.tag + ' start: ' + J(an[i]) + ' go ' + J(go[i] && { afterGoAt: Math.round(go[i].server - go[i].goAt), phase: go[i].phase }) + ' launch ' + (launch[i] == null ? null : launch[i].toFixed(0)) + ' ms'));
  check('grid: no car moved in any frame while locked (autopilots pressing the throttle the whole time)', an.every(a => a.lockedFrames > 300 && a.movedWhileLocked === 0), an.map(a => [a.lockedFrames, a.movedWhileLocked]));
  check('grid: five lamps come on one per second on every window (DOM), in step between the windows', an.every(a => /12345/.test(a.lamps) && a.gaps.slice(0, 4).every(g => near(g, 1000, 120)) && a.domMismatch <= 6) && lampsTogether,
    an.map(a => ({ lamps: a.lamps, gaps: a.gaps, domMismatch: a.domMismatch })));
  const hold = snapR.goAt - snapR.lightsAt - 5000;
  check('grid: lights out 0.5 .. 2 s after the fifth lamp (random hold), 4 s after the grid formed', hold >= 500 && hold <= 2000, { holdMs: hold });
  const goSpread = Math.max(...go.map(g => g.wall)) - Math.min(...go.map(g => g.wall)), outSpread = Math.max(...an.map(a => a.outWall)) - Math.min(...an.map(a => a.outWall));
  timings.lightsOut1 = { goAfterGoAtMs: go.map(g => Math.round(g.server - g.goAt)), goWallSpreadMs: goSpread, screenAfterGoAtMs: an.map(a => a.outClock), screenWallSpreadMs: outSpread, lastRedBeforeGoAtMs: an.map(a => a.lastRedClock) };
  check('lights out at the same session-clock time on every window: "go" within 150 ms after goAt on each (own estimate of the server clock) and within 100 ms of each other in real time',
    go.every(g => g && g.goAt === go[0].goAt && g.server - g.goAt >= 0 && g.server - g.goAt < 150) && goSpread < 100, timings.lightsOut1);
  check('lights out on screen: the first frame with the green GO state is drawn within 150 ms after goAt on every window (never before), within 100 ms of each other; the last frame with red lamps is before goAt',
    an.every(a => a.outClock !== null && a.outClock >= -1 && a.outClock < 150 && a.outCaption === 'GO' && a.lastRedClock < 1 && a.goFrames > 5) && outSpread < 100 && an.every(a => a.captions === '準備起跑|GO'),
    an.map(a => [a.outClock, a.lastRedClock, a.captions]));
  check('all three launch at lights out (moving within 250 ms)', launch.every(l => l !== null && l < 250) && st.every(s => s.car.v > 2), launch);
  check('race: lap counters armed, race clock = time since lights out on every car', st.every(s => s.gp.phase === 'race' && !s.gp.locked && s.lap.started && s.lap.n === 1 && s.gp.sinceGo - s.lap.time > -0.02 && s.gp.sinceGo - s.lap.time < 0.03),
    st.map(s => [s.lap.time, s.gp.sinceGo]));
  const goWall = go[0].wall;

  /* ---------------- run 1: race ---------------- */
  setPart('run1 race');
  const ramOk = await P[2].until(`__e2e.ram && __e2e.ram.result`, 9000, 'ram');
  await shot(P[2], '07-race-contact-guest');
  await sleep(400);
  const ramR = await P[2].e('ram.result'), hitR = await P[1].e('onHit');
  prox = await all(P, w => w.e('prox()'));
  await P[1].e(`set({ thrCap: 1 })`);
  check('race: cars are solid: ' + P[2].tag + ' rams ' + P[1].tag + ' on purpose -> impact on BOTH sides (the hitter resolves it, the victim gets the report)', ramOk && ramR.why === 'hit' && prox[2][P[1].pid].hitSolid > 0.02 &&
    prox[1][P[2].pid].hitSolid > 0.02 && hitR && hitR.done > 0 && prox[2][P[1].pid].minSolid > 1.9, { ram: ramR, hitter: prox[2][P[1].pid], victim: prox[1][P[2].pid] });
  hud = await all(P, w => w.e('hud()'));
  check('race HUD: 正賽, 完成圈數 0 / 2, lap row 1 / 2, lights gone after the flash', (await waitAll(P, `!__e2e.shown('hud-lights')`, 3000)) && hud.every(h => h.title === '正賽' && h.gpLap === '0 / 2' && h.lapRow === '1 / 2' && h.lapShown), hud.map(h => [h.title, h.gpLap, h.lapRow]));

  // the race clock (lap counter) against the session clock, frame by frame since lights out
  await waitAll(P, `__e2e.raceClock && __e2e.raceClock.n >= 150`, 6000, 'race clock frames');
  const rc1 = await all(P, w => w.e('raceClock'));
  timings.raceClock1 = rc1.map((c, i) => ({ car: P[i].tag, aheadMaxMs: +c.max.toFixed(2), behindMaxMs: +(-c.min).toFixed(2), goFrameDelayMs: +c.goFrameDelay.toFixed(2) }));
  check('race clock: on no car is the lap counter ever ahead of the session clock (tolerance 3 ms) in the first 150 frames after lights out, not even on the pole car, whose lights-out frame was held up by ' + HITCH_MS +
    ' ms (the lap counter becomes the race time in the classification)',
    rc1.every(c => c.n >= 150 && c.max <= 3 && c.min >= -60), timings.raceClock1);

  // D joins in the middle of the race
  while (Date.now() - goWall < 14000) await sleep(200);
  setPart('run1 spectator');
  await D.click('mp-join');
  check('D joins during the race and loads the track', await D.until(`F1.net.connected && ${onTrack}`, 25000) && await D.until(`F1.game.gp.phase === 'race'`, 3000), await D.e(`text('mp-status')`));
  D.pid = await D.js(`F1.net.id`); D.slot = await D.js(`F1.net.slot`);
  await D.e('fps()');                                        // (building the track is one long frame: not counted)
  await sleep(1300);
  let ds = await D.e('state()'), dh = await D.e('hud()'), dBox = await D.e(`box(${D.slot})`);
  const d0 = ds.car;
  check('D is a spectator: not classified, not locked, on its own room slot (slot 3 = grid box 4), lap counter untouched', D.slot === 3 && !ds.gp.taking && !ds.gp.locked && ds.gp.gridSlot === -1 && ds.gp.lapTotal === 0 &&
    inBox(dBox) && !ds.lap.started && ds.running, { gp: ds.gp, dBox });
  check('D\'s HUD: session box 正賽 with 觀戰中, the three drivers, no position / lap row, no lights, toast', dh.gpShown && dh.title === '正賽' && dh.note === '觀戰中' && dh.pos === '' && !dh.lapShown && !dh.lights.shown && dh.rows.length === 3 &&
    dh.toast === '大獎賽進行中，你正在觀戰，下一場開始時才會加入' && dh.spec === '觀戰：Dave' && dh.lapRow === '--', dh);
  const others = await all(ABC, w => w.e('hud()'));
  check('D is listed as 觀戰 on every racer\'s HUD and is not in the classification', others.every(h => h.spec === '觀戰：Dave' && h.rows.length === 3) && (await A.js(`F1.gp.view().count === 3 && F1.gp.view().spectators.length === 1`)), others.map(h => h.spec));
  rem = await all(ABCD, w => w.e('remotes()'));
  const stAll = await all(ABC, w => w.e('state()'));
  check('D sees the race: the three cars, translucent, near where they really are; the racers see D as a ghost and each other solid',
    ABC.every((o, j) => rem[3][o.name] && rem[3][o.name].active && rem[3][o.name].visible && rem[3][o.name].ghost === true && Math.hypot(rem[3][o.name].x - stAll[j].car.x, rem[3][o.name].z - stAll[j].car.z) < 25) &&
    ABC.every((w, i) => rem[i].Dave && rem[i].Dave.ghost === true && rem[i].Dave.isGhost === true && ABC.every((o, j) => i === j || rem[i][o.name].isGhost === false)),
    { D: rem[3], err: ABC.map((o, j) => +Math.hypot(rem[3][o.name].x - stAll[j].car.x, rem[3][o.name].z - stAll[j].car.z).toFixed(1)) });
  await sleep(1500);
  ds = await D.e('state()');
  check('D was not moved by the session', ds.car.x === d0.x && ds.car.z === d0.z && ds.car.v === 0, ds.car);
  await D.e('start()');
  await D.e(`set({ mode: 'line', scale: 0.4, holdFor: 0, park: null })`);
  await sleep(2500);
  await D.e(`set({ mode: 'stop' })`);
  ds = await D.e('state()');
  check('D can drive around (not locked)', Math.hypot(ds.car.x - d0.x, ds.car.z - d0.z) > 5, Math.hypot(ds.car.x - d0.x, ds.car.z - d0.z));
  await shot(A, '08-race-host');
  await D.until(`Math.abs(F1.game.car.state.speed) < 0.2`, 5000);
  await D.tap('Escape');
  const dTab = await D.tab('gp');                            // (D's menu was left on 多人連線, where it joined)
  const dp = await D.e('panel()');
  await shot(D, '08-race-spectator-menu');
  check('D opens its menu (大獎賽 tab): the panel says that it is watching, lists the three drivers and itself as 觀戰; no skip / end buttons for a guest', dTab && (await D.js(`!F1.game.running && __e2e.shown('menu')`)) && dp.session &&
    dp.self === '你正在觀戰，下一場大獎賽開始時才會加入。' && !dp.skip && !dp.end && !dp.again && dp.spec === '觀戰：Dave' && dp.hint === '只有房主可以跳過排位或結束大獎賽。' && dp.rows.length === 3 && !dp.setup, dp);
  await D.tap('Escape');
  check('D resumes (Esc): driving view again, still a spectator', await D.js(`F1.game.running && !__e2e.shown('menu') && !F1.gp.taking && F1.gp.phase === 'race'`));
  check('a guest cannot end the race (F1.gp.action refuses, nothing changes)', (await B.js(`F1.gp.action('end')`)) === false && (await D.js(`F1.gp.action('end')`)) === false && await (async () => { await sleep(400);
    return (await all(ABCD, w => w.js(`F1.gp.phase`))).every(p => p === 'race'); })());
  await clockMark('race 1, four windows', ABCD);

  // the race, watched from all four windows
  setPart('run1 race');
  const racers = P, watch = ABCD;
  let polls2 = 0, disagree = 0, domBad = 0, orderBad = 0, parkedAt = null, releasedAt = null, lappedSeen = false, gapSeen = false, flagSeen = false, specShot = false, resultsAll = false;
  let lastLog = 0, lastAgree = 0;
  const raceEnd = goWall + (SKIP_R ? 40000 : 330000);
  while (Date.now() < raceEnd) {
    await sleep(700);
    const ph = await all(watch, w => w.js(`F1.gp.phase`));
    if (ph.every(p => p === 'results')) { resultsAll = true; break; }
    const live = await all(racers, w => w.js(`({ lap: __e2e.lap(), car: __e2e.car(), st: __e2e.stats(), rel: __e2e.release && __e2e.release.done })`));
    if (parkedAt === null && live[2].st.parked) { parkedAt = (live[2].st.events.filter(e => /^parked/.test(e[1])).pop() || [0])[0] - live[2].st.goPerf; info('[' + secs() + '] ' + P[2].tag + ' parked beside the road ' + parkedAt.toFixed(1) + ' s after the start (sample ' + live[2].car.i + ', d ' + live[2].car.d.toFixed(2) + ')'); }
    if (releasedAt === null && live[2].rel) { releasedAt = live[2].rel - live[2].st.goPerf; info('[' + secs() + '] ' + P[2].tag + ' has been lapped by both and drives on, ' + releasedAt.toFixed(1) + ' s after the start'); }
    if (!specShot && live[0].lap.n >= 2 && live[0].car.i < 40) { specShot = true; await shot(D, '08-race-spectator'); }
    if (Date.now() - lastAgree > 3000 && ph.every(p => p === 'race')) {
      lastAgree = Date.now();
      const ag = await agree(watch);
      polls2++;
      if (!ag.ok && ++disagree <= 3) info('DISAGREE ' + J(ag.vs.map(x => x.v.rows.map(r => [r.name, r.laps, r.gap, r.down, r.done]))));
      if (!ag.vs.every(domMatchesView) && ++domBad <= 3) info('HUD ROWS != SESSION ' + J(ag.vs.map(x => [x.h.rows.map(r => [r.name, r.val]), x.v.rows.map((r, i) => rowText(x.v, r, i))])));
      const v = ag.vs[0].v;
      // the live order against where the cars really are (each car's own race distance); only when they are clearly apart
      const lv = await all(racers, w => w.js(`({ p: __e2e.lap().prog, fin: F1.gp.view().done, laps: F1.gp.lap })`));
      const dist = {}; racers.forEach((w, i) => { dist[w.pid] = lv[i].fin ? lv[i].laps : lv[i].p; });
      const truth = racers.map(w => w.pid).sort((a, b) => dist[b] - dist[a]);
      const clear = truth.every((id, k) => k === 0 || dist[truth[k - 1]] - dist[id] > 0.03);
      if (clear && ag.ok && J(v.rows.map(r => r.id)) !== J(truth) && !lv.some(x => x.fin)) { orderBad++; info('ORDER ' + J(v.rows.map(r => r.id)) + ' but the cars are ' + J(truth) + ' ' + J(dist)); }
      // milestones
      const rowOf = w => v.rows.find(r => r.id === w.pid);
      if (!gapSeen && ag.ok && rowOf(P[0]).laps === 1 && rowOf(P[1]).laps === 1 && !rowOf(P[0]).done) {
        gapSeen = true;
        const l = await all([P[0], P[1]], w => w.e('lapsDone')), l0 = l[0].filter(x => x.phase === 'race')[0].time, l1 = l[1].filter(x => x.phase === 'race')[0].time;
        check('race: the gap shown for P2 after lap 1 is the difference of the two cars\' own lap-1 times, same text on every window', near(rowOf(P[1]).gap, r3(r3(l1) - r3(l0)), 0.0011) &&
          ag.vs.every(x => x.h.rows[1].val === hudGap(rowOf(P[1]).gap)) && rowOf(P[0]).gap === null, { gap: rowOf(P[1]).gap, laps: [l0, l1], text: ag.vs[3].h.rows[1].val });
      }
      if (!lappedSeen && ag.ok && rowOf(P[2]).down === 1 && !rowOf(P[2]).done) {
        lappedSeen = true;
        check('race, live: once the leader has lapped the parked car its row says "+1 圈" on every window (spectator too)', ag.vs.every(x => x.h.rows[2].name === P[2].name && x.h.rows[2].val === '+1 圈') && rowOf(P[2]).laps === 0,
          ag.vs.map(x => x.h.rows.map(r => r.val)));
        await shot(A, '09-race-lapped-host'); await shot(D, '09-race-lapped-spectator');
      }
      if (!flagSeen && v.endsInMs !== null) {
        flagSeen = true;
        const e = await all(watch, w => w.js(`({ ends: __e2e.hud().ends, left: (F1.gp.snapshot.endsAt - F1.net.serverNow()) / 1000, winnerAt: F1.gp.snapshot.winnerAt, endsAt: F1.gp.snapshot.endsAt, note: __e2e.hud().note, val: __e2e.hud().rows[0].val })`));
        const okText = e.every(x => { const m = /^比賽將在 (\d):(\d\d) 後結束$/.exec(x.ends); return m && Math.abs(Number(m[1]) * 60 + Number(m[2]) - Math.ceil(x.left)) <= 1; });
        check('race: the winner has finished: every window counts down the 90 s ("比賽將在 m:ss 後結束"), the winner is told 已完賽, its row says 完賽', okText && e.every(x => x.endsAt - x.winnerAt === 90000 && x.val === '完賽') &&
          e[watch.indexOf(P[0])].note === '已完賽，等待其他車手', e.map(x => [x.ends, +x.left.toFixed(1), x.note]));
        await shot(P[0], '10-race-flag-winner');
      }
    }
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      info('[' + secs() + '] race +' + ((Date.now() - goWall) / 1000).toFixed(0) + ' s  ' + racers.map((w, i) => w.tag + ' lap ' + live[i].lap.n + ' @' + live[i].car.i + ' ' + (live[i].car.v * 3.6).toFixed(0) + ' km/h').join('  '));
    }
  }
  check('race: live order, laps and gaps agree between the four windows at every one of ' + polls2 + ' simultaneous polls (up to 5 tries 130 ms apart for the 0.5 s refresh)', polls2 >= (SKIP_R ? 5 : 30) && disagree === 0, { polls: polls2, disagree });
  check('race: on every window the HUD rows (領先 / gap / +n 圈 / 完賽) say what its session says, at every poll', domBad === 0, { domBad });
  check('race: the live order is the order of the cars on the road (own race distance), whenever they are more than 3 % of a lap apart', orderBad === 0, { orderBad });
  await fpsMark('race 1 (4 windows: 3 racing + spectator)', ABCD);

  /* ---------------- run 1: results ---------------- */
  setPart('run1 results');
  if (SKIP_R) {
    await A.js(`F1.game.gp.action('end')`);
    check('DEV: the host ended the race -> results', await waitAll(ABCD, `F1.game.gp.phase === 'results'`, 4000));
  } else {
    timings.race1 = (Date.now() - goWall) / 1000;
    check('race: results on all four windows once the last car has taken the flag (' + timings.race1.toFixed(0) + ' s after lights out)', resultsAll && lappedSeen && gapSeen && flagSeen && parkedAt !== null && releasedAt !== null,
      { resultsAll, lappedSeen, gapSeen, flagSeen, parkedAt, releasedAt });
    await sleep(400);
    const laps = await all(P, w => w.e('lapsDone')), rl = laps.map(l => l.filter(x => x.phase === 'race' && x.sid === 1).map(x => x.time));
    timings.raceLaps1 = { [P[0].tag]: rl[0], [P[1].tag]: rl[1], [P[2].tag]: rl[2] };
    info('race laps (own lap counters): ' + P.map((w, i) => w.tag + ' ' + rl[i].map(fmt).join(' + ')).join('   '));
    const ag = await agree(ABCD), v = ag.vs[0].v, res = await all(ABCD, w => w.e('results()'));
    const sum = i => r3(rl[i].reduce((a, b) => a + r3(b), 0));
    check('results: P1 and P2 did 2 laps, P3 finished 1 lap (its first crossing after the winner): a lap down', rl[0].length === 2 && rl[1].length === 2 && rl[2].length === 1 && J(v.rows.map(r => [r.id, r.laps, r.done, r.down, r.dnf])) ===
      J([[P[0].pid, 2, true, 0, false], [P[1].pid, 2, true, 0, false], [P[2].pid, 1, true, 1, false]]), v.rows);
    check('results: total times are the sums of each car\'s own lap times (= time since lights out), gap P2 = the difference, best laps the quicker lap',
      v.rows.every((r, i) => near(r.time, sum(i), 0.0011) && r.best === r3(Math.min(...rl[i]))) && near(v.rows[1].gap, r3(v.rows[1].time - v.rows[0].time), 0.0011) && v.rows[0].gap === null && v.rows[2].gap === null &&
      near(v.rows[0].time, (v.winnerAt - snapR.goAt) / 1000, 0.6), { rows: v.rows.map(r => [r.name, r.time, r.gap, r.best]), sums: [0, 1, 2].map(sum), winnerClock: (v.winnerAt - snapR.goAt) / 1000 });
    // (each page notes the session clock at the moment its lap counter completed a lap)
    const over = P.map((w, i) => { const l = laps[i].filter(x => x.phase === 'race' && x.sid === 1).pop(); return +(v.rows[i].time * 1000 - (l.clock - snapR.goAt)).toFixed(1); });
    timings.raceTimeMinusSessionClockMs1 = over;
    check('results: nobody is classified with more race time than the session clock had counted when it crossed the line (tolerance 3 ms)', over.every(o => o <= 3 && o > -60), { msOver: over });
    const table = [['1', P[0].name, '2', hudTime(v.rows[0].time), '', hudTime(v.rows[0].best)], ['2', P[1].name, '2', hudTime(v.rows[1].time), hudGap(v.rows[1].gap), hudTime(v.rows[1].best)],
      ['3', P[2].name, '1', hudTime(v.rows[2].time), '+1 圈', hudTime(v.rows[2].best)]];
    check('results overlay on all four windows: identical classification, total times, gaps ("+1 圈" for the lapped car) and best laps', ag.ok && res.every(r => r.shown && J(r.rows.map(x => [x.pos, x.name, x.laps, x.time, x.gap, x.best])) === J(table) &&
      r.sub === 'Circuit de Monaco ‧ ' + YEAR + ' 賽季 ‧ 排位 1 圈 ‧ 正賽 2 圈' && r.spec === '觀戰：Dave') && res.every((r, i) => r.rows.every(x => x.you === (x.name === ABCD[i].name) && !x.out)), res[3]);
    const flBest = Math.min(...v.rows.map(r => r.best));
    check('results: the fastest race lap is marked, on the same row everywhere', res.every(r => J(r.rows.map(x => x.fl)) === J(v.rows.map(x => x.best === flBest))), res[0].rows.map(x => [x.name, x.best, x.fl]));
    check('results: host has 再來一場 / 結束 / 關閉, the guests and the spectator only 關閉 and a note', res[0].again && res[0].end && res[0].close && res[0].note === '' &&
      [1, 2, 3].every(i => !res[i].again && !res[i].end && res[i].close && res[i].note === '等待房主開始下一場或結束大獎賽'), res.map(r => [r.again, r.end, r.close, r.note]));
    const toasts = await all(ABCD, w => w.e('toasts'));
    const lastToast = t => t.length ? t[t.length - 1][1] : '';
    check('results: every driver is told its place; the spectator gets no such toast', P.every((w, i) => lastToast(toasts[ABCD.indexOf(w)]) === '正賽結束：你是第 ' + (i + 1) + ' 名（共 3 位車手）') && !/正賽結束/.test(lastToast(toasts[3])),
      toasts.map(lastToast));
    hud = await all(P, w => w.e('hud()'));
    check('results: each driver\'s timing box shows its last / best lap exactly as the table does; HUD session box rows agree with the table', hud.every((h, i) => h.last === hudTime(r3(rl[i][rl[i].length - 1])) && h.best === table[i][5]) &&
      ag.vs.every(domMatchesView), hud.map(h => [h.last, h.best]));
    const stats = await all(P, w => w.e('stats(true)'));
    P.forEach((w, i) => info(w.tag + ' autopilot in race 1: wall hits ' + stats[i].wall + ', car impacts ' + stats[i].car + ' (max ' + stats[i].carMax.toFixed(2) + '), grass frames ' + stats[i].grass + ', gap-keeping frames ' + stats[i].accSteps +
      ', avoid frames ' + stats[i].avoidSteps + ', reverses ' + stats[i].reverses + ', resets ' + stats[i].resets + ' ' + J(stats[i].events.slice(0, 8))));
    check('race 1: no autopilot needed the reset button or a reverse; no wall touched', stats.every(s => s.resets === 0 && s.reverses === 0 && s.wall === 0), stats.map(s => [s.wall, s.reverses, s.resets]));
    const late = stats.map(s => s.carAt.map(t => +(t - s.goPerf).toFixed(2)));
    check('race 1: the only contact between cars was the deliberate one at the start (within 4 s of lights out); the winner was never touched', late[0].length === 0 && late[1].length > 0 && late[2].length > 0 &&
      late[1].concat(late[2]).every(t => t >= 0 && t < 4), late);
    // D stands near the racing line just before the start line: the racers come past (or through) it every lap
    prox = await all(P, w => w.e('prox(true)'));
    check('race 1: the racers drove through / past the spectator’s car without any impact (closest ' + prox.map(p => p[D.pid] ? p[D.pid].minGhost.toFixed(1) : '?').join(' / ') + ' m)',
      prox.every(p => p[D.pid] && p[D.pid].hitGhost === 0 && p[D.pid].minGhost < 12 && p[D.pid].minSolid > 1e8), prox.map(p => p[D.pid]));
  }
  await shot(A, '11-results-host'); await shot(B, '11-results-guest'); await shot(D, '11-results-spectator');
  check('guest: 關閉 hides its overlay (still in the results phase)', await B.click('gp-close') && await B.js(`!__e2e.shown('gp-results') && F1.gp.phase === 'results'`));

  /* ---------------- run 2 ---------------- */
  setPart('run2 again');
  // everybody waits on its slot in the next qualifying
  for (const w of ABCD) { await w.e(`arm({ onPhase: { quali: { mode: 'idle', park: null, thrCap: 1, holdFor: 0 } }, ram: null, onHit: null, release: null, onGo: null })`); await w.e('start()'); }
  check('host clicks 再來一場 in the results overlay', await A.click('gp-res-again'));
  check('a new qualifying (session 2) for all four: D takes part now', await waitAll(ABCD, `F1.game.gp.phase === 'quali' && F1.game.gp.sid === 2 && F1.game.gp.taking`, 4000));
  await sleep(500);
  st = await all(ABCD, w => w.e('state()')); bx = await all(ABCD, w => w.e(`box(${w.slot})`)); hud = await all(ABCD, w => w.e('hud()'));
  check('again: every car back on its room slot (A, B, C, D in boxes 1..4), lap counters reset, overlay gone everywhere, four rows, same format', bx.every(inBox) && st.every(s => !s.lap.started && s.gp.lapTotal === 1 && s.running) &&
    hud.every((h, i) => !h.results && h.title === '排位賽' && h.rows.length === 4 && posIs(h, i + 1, 4) && h.toast === '大獎賽開始：排位 1 圈，正賽 2 圈' && h.spec === '' && h.lapRow === '1 / 1' && h.last === '--'), { bx, hud: hud[3] });

  // v6 proof of driving: D drives a real timed lap, but on the way it stops beside the road for NODATA_S seconds, and
  // while it stands its "network" delivers none of its car states (a connection that hangs). The positions that do
  // arrive cover the whole lap (standing still covers nothing), but they arrived for too little of its time (the server
  // credits a gap in the states with at most 5 s; a lap needs them for 3/4 of its time): refused 'no-data', nothing
  // changes in the standings. (States that stop while the car MOVES lose the path it drove meanwhile and the lap is
  // refused 'not-driven' first: the server checks the path before the time. A thinned stream, one state in 8 s for
  // the whole lap, is 'not-driven' on Monaco: the straight lines between positions 8 s apart cut the corners.)
  setPart('run2 no-data');
  const s2Before = J((await all(ABCD, w => w.e('hud()'))).map(h => h.rows.map(r => [r.pos, r.name, r.sub, r.val])));
  await D.js(THIN);
  await D.js(`__thin.on = false; __thin.passed = 0; __thin.dropped = 0; true`);
  const dRej0 = await D.js(`__e2e.rejected.length`), tNoData = Date.now();
  await D.e(`set({ mode: 'line', scale: 1, park: ${J(PARK)}, holdFor: 0, thrCap: 1 })`);
  const dParked = await D.until(`__e2e.ap.parked && F1.game.lap.started && F1.gp.phase === 'quali'`, 40000, 'D parked in its timed lap');
  await D.js(`__thin.every = 1e12; __thin.last = performance.now(); __thin.on = true; true`);       // silence: every state dropped
  const tSilent = Date.now();
  await sleep(NODATA_S * 1000);
  const silentS = (Date.now() - tSilent) / 1000;
  const dStill = await D.js(`({ v: F1.game.car.state.speed, i: F1.game.car.state.sampleIndex, lapT: F1.game.lap.time })`);
  await D.js(`__thin.on = false; true`);
  await D.e(`set({ park: null })`);
  const dLap = await D.until(`__e2e.lapsDone.filter(function (l) { return l.sid === 2; }).length >= 1`, 130000, 'D lap in session 2');
  const dGot = dLap && await D.until(`__e2e.rejected.length > ${dRej0}`, 4000, 'glno');
  await D.e(`set({ mode: 'stop' })`);
  await sleep(300);
  const th = await D.js(`({ passed: __thin.passed, dropped: __thin.dropped })`);
  const dr = await D.js(`({ why: __e2e.rejected[__e2e.rejected.length - 1], toast: __e2e.hud().toast, gp: __e2e.gp(), lap: __e2e.lapsDone.filter(function (l) { return l.sid === 2; })[0] })`);
  info('D\'s lap ' + (dr.lap ? fmt(dr.lap.time) : '-') + ' after ' + ((Date.now() - tNoData) / 1000).toFixed(0) + ' s, standing ' + silentS.toFixed(1) + ' s of it (sample ' + dStill.i + ', ' + dStill.v.toFixed(2) +
    ' m/s) with every car state dropped: ' + th.dropped + ' dropped');
  check('no-data: D drove a real lap (' + (dr.lap ? fmt(dr.lap.time) : '-') + ') but stood ' + NODATA_S + ' s of it with no car state reaching the server -> refused "no-data", toast "這一圈沒有被採計：這一圈的行車資料沒有傳到伺服器（連線不穩？）"',
    dParked && dLap && dGot && dr.why === 'no-data' && dr.toast === '這一圈沒有被採計：這一圈的行車資料沒有傳到伺服器（連線不穩？）' && dr.gp.lap === 0 && dr.gp.phase === 'quali' && th.passed === 0 &&
    th.dropped > NODATA_S * 15 && Math.abs(dStill.v) < 0.3, { dr, th, dStill });
  // D's own timing box agrees with the standings: the refused lap is shown as driven (上一圈) but is not D's best
  const dHud = await D.e('hud()'), dRow = dHud.rows.filter(r => r.name === 'Dave').map(r => [r.sub, r.val]);
  check('no-data: D\'s own timing box agrees with its standings row: 上一圈 ' + dHud.last + ' (the lap it drove), 最快圈 ' + dHud.best + ' (the refused lap is not its best: --)',
    !!dr.lap && dHud.last === hudTime(r3(dr.lap.time)) && dHud.best === '--' && dRow.length === 1 && dRow[0][0] === '0/1', { last: dHud.last, best: dHud.best, row: dRow });
  const s2After = J((await all(ABCD, w => w.e('hud()'))).map(h => h.rows.map(r => [r.pos, r.name, r.sub, r.val])));
  check('no-data: the standings did not change on any window (D still 0/1, no time); the others got no such toast', s2After === s2Before &&
    (await all([A, B, C], w => w.js(`__e2e.toasts.some(function (t) { return /行車資料沒有傳到/.test(t[1]); })`))).every(x => x === false), s2After);
  await shot(D, '12-again-no-data-guest');
  setPart('run2 again');
  await A.tap('Escape');
  const pm = await A.e('panel()');
  check('host menu during qualifying: state 排位賽, 跳過排位 and 結束大獎賽 (no setup, no 再來一場), standings of four', !pm.setup && pm.session && /^排位賽/.test(pm.state) && pm.skip && pm.end && !pm.again && pm.rows.length === 4 &&
    pm.self === '你已完成 0 / 1 圈', pm);
  await shot(A, '12-again-menu-host');
  check('host clicks 結束大獎賽 in the menu', await A.click('gp-end'));
  check('free practice for all four; the host\'s menu stays open with the setup back', await waitAll(ABCD, `F1.game.gp.phase === 'free'`, 4000) && await A.js(`!F1.game.running && __e2e.shown('gp-setup') && !document.getElementById('gp-start').disabled`));
  check('everybody is told: 大獎賽已結束，回到自由練習', (await all(ABCD, w => w.e('hud().toast'))).every(t => t === '大獎賽已結束，回到自由練習'));

  setPart('run2 start');
  check('host sets R = 1 and clicks 開始大獎賽', (await A.field('gp-r', '1')) === '1' && await A.click('gp-start'));
  check('session 3: qualifying for all four, Q = 1, R = 1', await waitAll(ABCD, `F1.game.gp.phase === 'quali' && F1.game.gp.sid === 3 && F1.game.gp.taking`, 4000) &&
    (await all(ABCD, w => w.e('hud().toast'))).every(t => t === '大獎賽開始：排位 1 圈，正賽 1 圈'), await D.e('hud().toast'));
  // race programmes (grid = join order): A pole pace 1.0, B parks for good, C 0.93, D 0.82; reaction time 0.5 s per slot
  const G = ABCD;
  await A.e(`arm({ onPhase: { grid: { mode: 'line', scale: 1, park: null } }, onGo: { holdFor: 0 } })`);
  await B.e(`arm({ onPhase: { grid: { mode: 'line', scale: 0.82, park: ${J(PARK)} } }, onGo: { holdFor: 0.5 } })`);
  await C.e(`arm({ onPhase: { grid: { mode: 'line', scale: 0.93, park: null } }, onGo: { holdFor: 1.0 } })`);
  await D.e(`arm({ onPhase: { grid: { mode: 'line', scale: 0.82, park: null } }, onGo: { holdFor: 1.5 } })`);
  await sleep(2500);
  await A.tap('Escape');
  for (const w of G) { await w.e('lightsRec()'); await w.e('prox(true)'); await w.e('stats(true)'); }
  check('host clicks 跳過排位 in the menu', await A.js(`__e2e.shown('gp-skip')`) && await A.click('gp-skip'));
  check('all four on the grid; the host is pulled out of the menu', await waitAll(G, `F1.game.gp.phase === 'grid' && F1.game.running`, 4000) && await A.js(`!__e2e.shown('menu')`));
  setPart('run2 grid');
  await sleep(400);
  st = await all(G, w => w.e('state()')); bx = await all(G, (w, i) => w.e(`box(${i})`)); hud = await all(G, w => w.e('hud()'));
  const snapG = await A.e('snap()');
  check('grid without any time: join order A, B, C, D; four cars frozen in boxes 1..4; toasts', J(snapG.grid) === J(G.map(w => w.pid)) && bx.every(inBox) && st.every((s, i) => s.gp.gridSlot === i && s.gp.locked && s.car.v === 0) &&
    hud.every((h, i) => h.toast === '起跑位置 P' + (i + 1) + ' / 4，燈號全滅就起跑' && h.title === '起跑' && h.rows.length === 4 && h.rows.every(r => r.val === '--')), { grid: snapG.grid, bx });
  let shot4 = false;
  lampsTogether = true;
  const endGrid2 = Date.now() + 17000;
  while (Date.now() < endGrid2) {
    const s = await all(G, w => w.js(`({ l: __e2e.lightsNow(), g: __e2e.gp(), v: F1.game.car.state.speed })`));
    const lit = s.map(x => x.g.lights);
    if (Math.max(...lit) - Math.min(...lit) > 1) lampsTogether = false;
    if (!shot4 && s[0].l.on >= 4) { shot4 = true; await shot(A, '13-grid4-host'); await shot(D, '13-grid4-guest-last'); }
    if (s.every(x => x.g.phase === 'race' && x.v > 2)) break;
    await sleep(50);
  }
  const go2 = await all(G, w => w.e('go')), launch2 = await all(G, w => w.e('launch()')), rec2 = await all(G, w => w.e('lightsStop()'));
  const an2 = rec2.map((r, i) => analyseStart(r, go2[i] ? go2[i].goAt : 0));
  G.forEach((w, i) => info(w.tag + ' start: ' + J(an2[i]) + ' go ' + J(go2[i] && { afterGoAt: Math.round(go2[i].server - go2[i].goAt), phase: go2[i].phase }) + ' launch ' + (launch2[i] == null ? null : launch2[i].toFixed(0)) + ' ms'));
  const goSpread2 = Math.max(...go2.map(g => g.wall)) - Math.min(...go2.map(g => g.wall)), outSpread2 = Math.max(...an2.map(a => a.outWall)) - Math.min(...an2.map(a => a.outWall));
  timings.lightsOut2 = { goAfterGoAtMs: go2.map(g => Math.round(g.server - g.goAt)), goWallSpreadMs: goSpread2, screenAfterGoAtMs: an2.map(a => a.outClock), screenWallSpreadMs: outSpread2 };
  check('second start, four cars: frozen while locked, lamps 1..5 in step, lights out within 150 ms after goAt on every window and within 100 ms of each other',
    an2.every(a => a.lockedFrames > 300 && a.movedWhileLocked === 0 && /12345/.test(a.lamps) && a.outClock !== null && a.outClock >= -1 && a.outClock < 150 && a.lastRedClock < 1) && lampsTogether &&
    go2.every(g => g && g.goAt === go2[0].goAt && g.server - g.goAt >= 0 && g.server - g.goAt < 150) && goSpread2 < 100 && outSpread2 < 100, timings.lightsOut2);
  check('all four launch (pole at once, the others after their reaction time of 0.5 s per slot)', launch2.every((l, i) => l !== null && l >= i * 500 - 30 && l < i * 500 + 250), launch2);
  await waitAll(G, `__e2e.raceClock && __e2e.raceClock.n >= 150`, 6000, 'race clock frames');
  const rc2 = await all(G, w => w.e('raceClock'));
  timings.raceClock2 = rc2.map((c, i) => ({ car: G[i].tag, aheadMaxMs: +c.max.toFixed(2), behindMaxMs: +(-c.min).toFixed(2), goFrameDelayMs: +c.goFrameDelay.toFixed(2) }));
  check('race clock, second start: never ahead of the session clock (tolerance 3 ms) on any of the four cars', rc2.every(c => c.n >= 150 && c.max <= 3 && c.min >= -60), timings.raceClock2);
  const goWall2 = go2[0].wall;

  /* ---------------- run 2: race ---------------- */
  setPart('run2 race');
  // after the flag A and C stop one behind the other shortly before the line (for the free-practice checks later)
  await A.e(`set({ park: null })`);
  let left = false, stopped = null, winner = null, cFin = false, lastCd = 0, cdChecks = 0, cdOk = true, results2 = false, resAt = null;
  polls2 = 0; disagree = 0; domBad = 0;
  lastLog = 0; lastAgree = 0;
  const live3 = [A, B, C];
  while (Date.now() - goWall2 < 260000) {
    await sleep(500);
    const t = (Date.now() - goWall2) / 1000;
    const ph = await all(live3, w => w.js(`F1.gp.phase`));
    if (ph.every(p => p === 'results')) { results2 = true; resAt = await A.js(`__e2e.phases.filter(function (p) { return p[1] === 'results' && p[2] === 3; })[0][3]`); break; }
    const live = await all(live3, w => w.js(`({ lap: __e2e.lap(), car: __e2e.car(), st: __e2e.stats(), v: __e2e.view() })`));
    if (stopped === null && live[1].st.parked) { stopped = (live[1].st.events.filter(e => /^parked/.test(e[1])).pop() || [0])[0] - live[1].st.goPerf; info('[' + secs() + '] B stopped for good ' + stopped.toFixed(1) + ' s after the start (sample ' + live[1].car.i + ', d ' + live[1].car.d.toFixed(2) + ')'); }
    if (!left && t > 20) {
      left = true;
      setPart('run2 leaver');
      const before4 = await agree(G);
      await D.tap('Escape');
      check('D opens the menu and clicks 離開房間 (多人連線 tab)', await D.js(`__e2e.shown('menu')`) && await D.tab('mp') && await D.click('mp-leave'));
      check('D is offline: back to single player, no session', await D.until(`!F1.net.connected && F1.game.gp.phase === 'free' && !F1.game.gp.online`, 4000) && (await D.e(`text('mp-status')`)) === '已離開房間', await D.e(`text('mp-status')`));
      await sleep(900);
      const ag = await agree(live3), v = ag.vs[0].v, row = v.rows.find(r => r.id === D.pid);
      check('the others: Dave stays in the classification, last, as 離線 (DNF, grey), race still on', ag.ok && ag.vs.every(domMatchesView) && v.phase === 'race' && v.count === 4 && row && row.left && row.dnf && !row.done && v.rows[3].id === D.pid &&
        ag.vs.every(x => x.h.rows[3].name === 'Dave' && x.h.rows[3].val === '離線' && x.h.rows[3].out && /136, 136, 136/.test(x.h.rows[3].colour)), { before: before4.vs[0].h.rows.map(r => [r.name, r.val]), after: ag.vs[0].h.rows });
      check('the others are told "Dave 離開了房間"; its car is gone from their track (two car models left)', (await all(live3, w => w.js(`__e2e.toasts.some(function (t) { return t[1] === 'Dave 離開了房間'; }) && !__e2e.remotes().Dave &&
        Object.keys(F1.game.remoteModels).length === 2`))).every(Boolean));
      await shot(A, '14-race2-left-host');
      setPart('run2 race');
    }
    if (winner === null && live[0].v.endsInMs !== null) {
      winner = t;
      info('[' + secs() + '] A took the flag ' + t.toFixed(1) + ' s after the start; the race closes 90 s later');
      await A.e(`set({ park: { index: 1570, d: 0 } })`);
    }
    if (!cFin && live[2].v.done) { cFin = true; info('[' + secs() + '] C took the flag ' + t.toFixed(1) + ' s after the start'); await C.e(`set({ park: { index: 1553, d: 0 } })`); }
    if (winner !== null && Date.now() - lastCd > 11000) {
      lastCd = Date.now();
      const e = await all(live3, w => w.js(`({ ends: __e2e.hud().ends, left: (F1.gp.snapshot.endsAt - F1.net.serverNow()) / 1000, shown: __e2e.shown('hud-gp-ends') })`));
      const ok = e.every(x => { const m = /^比賽將在 (\d):(\d\d) 後結束$/.exec(x.ends); return x.shown && m && Math.abs(Number(m[1]) * 60 + Number(m[2]) - Math.ceil(x.left)) <= 1; });
      cdChecks++; if (!ok) cdOk = false;
      info('[' + secs() + '] countdown ' + e.map((x, i) => live3[i].tag + ' "' + x.ends + '" (' + x.left.toFixed(1) + ' s left)').join('  ') + (ok ? '' : '   <-- WRONG'));
      if (cdChecks === 3) { await shot(B, '15-race2-countdown-stopped-guest'); await shot(A, '15-race2-countdown-host'); }
    }
    if (Date.now() - lastAgree > 3000 && ph.every(p => p === 'race') && left) {
      lastAgree = Date.now();
      const ag = await agree(live3);
      polls2++;
      if (!ag.ok && ++disagree <= 3) info('DISAGREE ' + J(ag.vs.map(x => x.v.rows.map(r => [r.name, r.laps, r.gap, r.down, r.done]))));
      if (!ag.vs.every(domMatchesView) && ++domBad <= 3) info('HUD ROWS != SESSION ' + J(ag.vs.map(x => [x.h.rows.map(r => [r.name, r.val]), x.v.rows.map((r, i) => rowText(x.v, r, i))])));
    }
    if (Date.now() - lastLog > 20000) {
      lastLog = Date.now();
      info('[' + secs() + '] race 2 +' + t.toFixed(0) + ' s  ' + live3.map((w, i) => w.tag + ' lap ' + live[i].lap.n + ' @' + live[i].car.i + ' ' + (live[i].car.v * 3.6).toFixed(0) + ' km/h').join('  '));
    }
  }
  const snapE = await A.e('snap()');
  timings.race2 = { winnerAfterGo: (snapE.winnerAt - snapE.goAt) / 1000, closedAfterWinnerMs: resAt - snapE.winnerAt };
  check('race 2: live standings agreed between the three remaining windows at every poll, HUD rows = session', polls2 >= 20 && disagree === 0 && domBad === 0, { polls: polls2, disagree, domBad });
  check('race 2: the countdown was right on every window each time it was read (every 11 s)', cdChecks >= 6 && cdOk, { cdChecks });
  check('race 2: B stopped and never finished; A won, C finished; the race closed by itself 90 s after the winner', results2 && stopped !== null && winner !== null && cFin && snapE.endsAt - snapE.winnerAt === 90000 &&
    resAt - snapE.endsAt >= -30 && resAt - snapE.endsAt < 400, { stopped, winner, closedMsAfterWinner: resAt - snapE.winnerAt });
  await fpsMark('race 2 (3 racing windows; D left after 20 s)', ABC);
  await clockMark('end of race 2', ABC);

  setPart('run2 results');
  await sleep(400);
  {
    const laps = await all(live3, w => w.e('lapsDone')), rl = laps.map(l => l.filter(x => x.phase === 'race' && x.sid === 3).map(x => x.time));
    timings.raceLaps2 = { A: rl[0], B: rl[1], C: rl[2] };
    const ag = await agree(live3), v = ag.vs[0].v, res = await all(live3, w => w.e('results()'));
    check('results 2: A and C classified after 1 lap, B without a finish (0 laps, not DNF-by-leaving), D last as a leaver', J(v.rows.map(r => [r.id, r.laps, r.done, r.dnf, r.left])) ===
      J([[A.pid, 1, true, false, false], [C.pid, 1, true, false, false], [B.pid, 0, false, false, false], [D.pid, 0, false, true, true]]) && rl[0].length >= 1 && rl[2].length >= 1 && rl[1].length === 0 &&
      near(v.rows[0].time, r3(rl[0][0]), 0.0011) && near(v.rows[1].time, r3(rl[2][0]), 0.0011) && near(v.rows[1].gap, r3(v.rows[1].time - v.rows[0].time), 0.0011), v.rows);
    const table = [['1', 'Alice', '1', hudTime(v.rows[0].time), '', hudTime(v.rows[0].best), false], ['2', 'Carol', '1', hudTime(v.rows[1].time), hudGap(v.rows[1].gap), hudTime(v.rows[1].best), false],
      ['3', 'Bob', '0', '--', '未完賽 DNF', '--', true], ['4', 'Dave', '0', '--', '離線', '--', true]];
    check('results overlay 2 on the three windows: identical; B "未完賽 DNF" with no time, Dave "離線"; R = 1 in the subtitle; no spectators', ag.ok && ag.vs.every(domMatchesView) &&
      res.every(r => r.shown && J(r.rows.map(x => [x.pos, x.name, x.laps, x.time, x.gap, x.best, x.out])) === J(table) && r.sub === 'Circuit de Monaco ‧ ' + YEAR + ' 賽季 ‧ 排位 1 圈 ‧ 正賽 1 圈' && r.spec === ''), res[1]);
    check('results 2: the overlay is open again on B (it closed the one of session 1); host has 再來一場 / 結束, guests only 關閉', res[0].again && res[0].end && res[0].close && !res[1].again && !res[1].end && res[1].close && !res[2].end);
    const toasts = await all(live3, w => w.e('hud().toast'));
    check('results 2: toasts: A first, C second of 4, B "你沒有完賽"', J(toasts) === J(['正賽結束：你是第 1 名（共 4 位車手）', '正賽結束：你沒有完賽', '正賽結束：你是第 2 名（共 4 位車手）']), toasts);
    const stats = await all(live3, w => w.e('stats(true)'));
    live3.forEach((w, i) => info(w.tag + ' autopilot in race 2: wall hits ' + stats[i].wall + ', car impacts ' + stats[i].car + ', grass frames ' + stats[i].grass + ', gap-keeping frames ' + stats[i].accSteps +
      ', avoid frames ' + stats[i].avoidSteps + ', reverses ' + stats[i].reverses + ', resets ' + stats[i].resets + ' ' + J(stats[i].events.slice(0, 8))));
    check('race 2: no contact, no wall, no reset / reverse on any autopilot', stats.every(s => s.resets === 0 && s.reverses === 0 && s.wall === 0 && s.car === 0), stats.map(s => [s.wall, s.car, s.reverses, s.resets]));
  }
  await shot(A, '16-results2-host'); await shot(B, '16-results2-guest-dnf');

  /* ---------------- free practice again ---------------- */
  setPart('free again');
  check('A and C are standing one behind the other before the line (where they stopped after the flag)', await waitAll([A, C], `__e2e.ap.parked`, 60000, 'parked'), await all([A, C], w => w.e('car()')));
  for (const w of live3) { await w.e('prox(true)'); await w.e('stats(true)'); }
  const nLaps = await all(live3, w => w.js(`__e2e.lapsDone.length`));
  check('host clicks 結束 in the results overlay', await A.click('gp-res-end'));
  check('free practice for everybody', await waitAll(live3, `F1.game.gp.phase === 'free'`, 4000));
  await sleep(600);
  st = await all(live3, w => w.e('state()')); hud = await all(live3, w => w.e('hud()')); ros = await all(live3, w => w.e('roster()')); rem = await all(live3, w => w.e('remotes()'));
  check('after 結束: no session box / overlay / lights, the roster box is back with the three players, lap counters reset (lap row "--"), toast', hud.every(h => !h.gpShown && !h.results && !h.lights.shown && h.roster && h.lapRow === '--' &&
    h.cur === '--' && h.last === '--' && h.toast === '大獎賽已結束，回到自由練習') && ros.every(r => J(r) === J([{ name: 'Alice', best: '--' }, { name: 'Bob', best: '--' }, { name: 'Carol', best: '--' }])) &&
    st.every(s => s.gp.phase === 'free' && !s.gp.taking && s.gp.lapTotal === 0 && !s.lap.started && s.running), { hud: hud[1], ros: ros[1] });
  check('after 結束: the cars are solid for each other again', live3.every((w, i) => live3.every((o, j) => i === j || (rem[i][o.name].ghost === false && rem[i][o.name].isGhost === false && rem[i][o.name].active))), rem[0]);
  await shot(B, '17-free-guest');
  // C bumps A from behind on purpose
  const gapAC = Math.hypot(st[0].car.x - st[2].car.x, st[0].car.z - st[2].car.z);
  await A.e(`arm({ onHit: { then: { mode: 'line', scale: 1, park: null, holdFor: 0 } } })`);
  await C.e(`arm({ ram: { id: ${A.pid}, untilHit: true, after: 0.2, timeout: 12, then: { mode: 'line', scale: 0.93, park: null, holdFor: 2.5 } } })`);
  await C.e(`set({ mode: 'ram', ramId: ${A.pid}, ramSpeed: 10, holdFor: 0 })`);
  const bump = await C.until(`__e2e.ram && __e2e.ram.result`, 14000, 'bump');
  await sleep(400);
  const bumpR = await C.e('ram.result');
  prox = await all(live3, w => w.e('prox()'));
  await A.e(`set({ mode: 'line', scale: 1, park: null })`);
  check('free practice: cars solid: C (standing ' + gapAC.toFixed(0) + ' m behind A) drives into A on purpose -> impact on both sides, no overlap', bump && bumpR.why === 'hit' && prox[2][A.pid].hitSolid > 0.02 && prox[0][C.pid].hitSolid > 0.02 &&
    prox[2][A.pid].minSolid > 4.5, { bump: bumpR, C: prox[2][A.pid], A: prox[0][C.pid] });
  await shot(C, '17-free-contact-guest');
  // A's timed lap
  const tFree = Date.now();
  check('free practice: lap timing starts when A crosses the line (lap row "1")', await A.until(`F1.game.lap.started && __e2e.text('hud-lap') === '1'`, 30000), await A.e('lap()'));
  let lastInfo = 0, done = false;
  while (Date.now() - tFree < 150000 && !(done = await A.js(`F1.game.lap.n >= 2`))) {
    await sleep(500);
    if (Date.now() - lastInfo > 20000) { lastInfo = Date.now(); const s = await all([A, C], w => w.e('state()')); info('[' + secs() + '] free ' + s.map((x, i) => [A, C][i].tag + ' lap ' + x.lap.n + ' @' + x.car.i + ' ' + (x.car.v * 3.6).toFixed(0) + ' km/h').join('  ')); }
  }
  await sleep(700);
  const aLap = await A.e('lap()'), aHud = await A.e('hud()');
  ros = await all(live3, w => w.e('roster()'));
  timings.freeLap = aLap.last;
  check('free practice: A completes a timed lap; its own timing box shows it (上一圈 / 最快圈), lap row "2"', done && aLap.last > minLap && aHud.last === hudTime(r3(aLap.last)) && aHud.best === aHud.last && aHud.lapRow === '2' && !aHud.gpShown,
    { lap: aLap.last, hud: [aHud.lapRow, aHud.last, aHud.best] });
  check('free practice: the roster box of every window shows Alice\'s best lap', ros.every(r => r.length === 3 && r[0].name === 'Alice' && r[0].best === hudTime(r3(aLap.last)) && r[1].name === 'Bob' && r[1].best === '--'), ros);
  const free = await all(live3, w => w.js(`__e2e.lapsDone.slice(-1)[0]`));
  check('free practice: that lap was not reported to any session', free[0].phase === 'free' && (await all(live3, w => w.js(`F1.gp.phase === 'free' && (!F1.gp.snapshot || F1.gp.snapshot.phase === 'free')`))).every(Boolean) && (await A.js(`__e2e.lapsDone.length`)) === nLaps[0] + 1, free[0]);
  const stats = await all(live3, w => w.e('stats()'));
  check('free practice: A and C drove past B\'s parked car without touching it, no wall, no reset', stats.every(s => s.resets === 0 && s.wall === 0) && stats[0].car <= 1 && stats[2].car <= 1 && stats[1].car === 0 && stats[1].parked,
    stats.map(s => ({ wall: s.wall, car: s.car, resets: s.resets, reverses: s.reverses, avoid: s.avoidSteps, acc: s.accSteps })));
  await shot(A, '18-free-host-lap'); await shot(B, '18-free-guest-roster');
  await fpsMark('free practice again', ABC);

  /* ---------------- the end ---------------- */
  setPart('end');
  for (const w of ABCD) await w.noErrors();
  check('D (left the room) is a working single-player game: track still loaded, Grand Prix panel offers a start', await D.js(`!F1.net.connected && !!F1.game.track && F1.game.gp.canControl && !document.getElementById('gp-start').disabled`));
  check('session clock: the estimates of the server clock in the windows never differ by more than 30 ms', clockLog.length === 3 && clockLog.every(c => c.spread < 30), clockLog);
  const drive = fpsLog.filter(f => f.label.indexOf('loading') < 0);
  check('frame rate: every window got at least 30 fps on average in every phase (60 requested), no frame longer than 1 s while driving', fpsLog.every(f => f.fps >= 30) && drive.every(f => f.maxGap <= 1000),
    { min: Math.min(...fpsLog.map(f => f.fps)).toFixed(1), longestFrameMs: Math.max(...drive.map(f => f.maxGap)).toFixed(0) });
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  host.register(ipcMain);
  try { await scenario(); } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  console.log('\n--- measured ---');
  console.log('frame rates (requested 60):');
  fpsLog.forEach(f => console.log('  ' + f.label.padEnd(58) + f.tag + '  ' + f.fps.toFixed(1).padStart(5) + ' fps   longest frame ' + f.maxGap.toFixed(0).padStart(4) + ' ms   frames over 50 ms: ' + f.slow));
  console.log('session clock: ' + clockLog.map(c => c.label + ': spread ' + c.spread.toFixed(1) + ' ms').join('; '));
  console.log('timings: ' + JSON.stringify(timings, null, 1));
  console.log('screenshots (' + L.OUT + '): ' + shots.join(' '));
  console.log('run duration ' + ((Date.now() - T0) / 1000).toFixed(0) + ' s');
  const bad = L.summary();
  try { await host.stopServer(); } catch (e) {}
  Object.keys(W).forEach(k => { try { W[k].destroy(); } catch (e) {} });
  app.exit(bad ? 1 : 0);
});
