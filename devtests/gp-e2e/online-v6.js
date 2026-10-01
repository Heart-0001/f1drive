// A whole v6 ONLINE Grand Prix in REAL TIME on Monaco, driven to the flag by autopilots: offscreen windows of the real
// game in one Electron process with the real preload / host IPC / server (net/host.js -> net/server.js), as online.js.
//   npx electron devtests/gp-e2e/online-v6.js        about 10 minutes; exit code 1 when a check fails
//   env PORT=24880 (the room's TCP port)   SPECTATOR=0 (no fourth window)   PATCH=<project file>=<replacement>,... (lib.js)
// Every window is muted (devtests/electron-userdata.js: --mute-audio + webContents.setAudioMuted; the audio graph keeps
// running). Screenshots: devtests/gp-e2e/out/v6-NN-phase-role.png (READ them).
//
// Cars are driven through the game's real input path (page.js: a fake standard controller; autopilot.js), on top of it
// online-v6-page.js: RB (ERS) on the straights, LB (pit limiter) and X (next compound) tapped by the pit plan
// (pitplan.js: into the lane, into the box of the room slot, held for the service, out again). Nothing is time-warped.
//
// Scenario (A = Alice, the host; B = Bob; C = Carol; D = Dave, a spectator who joins during the race):
//   room     A creates the room WITH A PASSWORD; B joins with it; C first with a wrong one (refused: the server's error
//            'password', the status 房間密碼錯誤, not in the room), then with the right one. A picks Monaco.
//   season   in free practice the host picks 2014 (車輛 tab, 年份): B and C follow (toast "房間是 2014 賽季：你的車換成 ...":
//            the 2014 standard car); each picks a 2014 team (A Mercedes, B Red Bull, C Williams): the roster carries the
//            cars, every window resolves the others' cars and paints their models in the team's livery (screenshots).
//   quali    A starts a Grand Prix Q = 1, R = 3, 輪胎損耗 x3 from the 大獎賽 tab: the season (2014) and the wear (x3) on
//            every window and every car's tyres; parc fermé: the car pickers are locked (guest and host: the year select
//            disabled, a click on another car changes nothing). One lap each at pace A 1.0, B 0.93, C 0.86 with ERS:
//            grid A, B, C. (D joins with the password after lights out and watches: a player who joins during
//            qualifying takes part in it.)
//   race     race paces the other way round (A 0.90, B 0.95, C 1.0): B and C catch A and follow it (the autopilot keeps
//            a gap to a solid car ahead), so the three reach the pit lane together at the end of lap 1. Each stops in the
//            box of its ROOM slot (0, 1, 2): limiter on before the entry line, off after the exit line, X for the next
//            compound (A and C hard, B medium); the light curtains on screen; two or three cars in the lane at once,
//            ghosts to each other (translucent, no impact); the service a random 2.0 .. 4.5 s with the car held and the
//            lap clock running on; new tyres. All three deploy ERS.
//   results  identical on every window (D too); race times = the sums of each car's own lap times = the session clock
//            at its finish; the lap with the stop longer than the others by more than the service; parc fermé still on.
//   free     結束: free practice for everybody with the same cars, the car pickers open again.
// Measured: frame rate and main-thread ms per frame (all rAF callbacks: game + recorders) per window and phase with the
// v6 load (worklet audio, live mirrors, telemetry); the audio back end and mute state of every window.
'use strict';
const electron = require('electron');
const { app, ipcMain } = electron;
const fs = require('fs'), path = require('path');
const L = require('./lib');                       // (PATCH is applied in here, before net/host.js is loaded)
require('../electron-userdata')(app, 'gp-e2e-online-v6');
const host = require(path.join(L.ROOT, 'net', 'host'));
const { sleep, J, check, info, setPart, fmt, hudTime, hudGap } = L;

const PORT = Number(process.env.PORT || 24880);
const WITH_D = process.env.SPECTATOR !== '0';
const TRACK = 'mc-1929';
const YEAR = 2014;
const PASSWORD = 'box box 2014';
const WRONG = 'box box 2015';
const NAMES = { A: 'Alice', B: 'Bob', C: 'Carol', D: 'Dave' };
const SWATCH = { A: 1, B: 2, C: 4, D: 5 };
const TEAM = { A: '2014-mercedes', B: '2014-red-bull', C: '2014-williams' };
const QPACE = { A: 1, B: 0.93, C: 0.86 };          // qualifying: grid A, B, C
const RPACE = { A: 0.90, B: 0.95, C: 1.0 };         // race: B and C catch A and follow it into the pit lane
const PIT_SCALE = 0.90;                             // the pit plan's pace (the same for all: the train keeps its spacing)
const COMPOUND = { A: 'H', B: 'M', C: 'H' };        // fitted at the stop (start: medium)
const REACT = { A: 0, B: 0.4, C: 0.8 };             // s after lights out
const PITGEO = path.join(__dirname, 'pitplan.js'), V6PAGE = path.join(__dirname, 'online-v6-page.js');
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const r3 = v => Math.round(v * 1000) / 1000;
const all = (wins, fn) => Promise.all(wins.map(fn));
const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(0) + ' s';

const W = {};
const fpsLog = [];                                  // { label, tag, fps, maxGap, slow, cost }
const shots = [];
const timings = {};

async function shot(w, name) { shots.push(path.basename(await w.shot('v6-' + name))); }
async function waitAll(wins, code, ms, what) { return (await all(wins, w => w.until(code, ms, what))).every(Boolean); }
async function fpsMark(label, wins) {
  const rows = await all(wins, w => w.js(`({ f: __e2e.fps(), c: __v6.cost(true) })`));
  rows.forEach((r, i) => fpsLog.push({ label, tag: wins[i].tag, fps: r.f.fps, maxGap: r.f.maxGap, slow: r.f.slow, cost: r.c }));
  info('frame rate, ' + label + ': ' + rows.map((r, i) => wins[i].tag + ' ' + r.f.fps.toFixed(1) + ' fps (longest frame ' + r.f.maxGap.toFixed(0) + ' ms; script+render ' +
    r.c.mean + ' ms/frame, p95 ' + r.c.p95 + ')').join(', '));
}

// the session as a window has it, comparable between windows (as online.js)
const sessKey = v => J({ phase: v.phase, sid: v.sid, q: v.q, r: v.r, year: v.year, wear: v.wear, rows: v.rows.map(r => [r.id, r.name, r.laps, r.best, r.time, r.gap, r.down, r.done, r.dnf, r.left]), spec: v.spectators.map(s => s.id) });
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

function makeWin(tag) {
  // (fresh installs: the room starts in the host's default season, 2026 since v6.1; the race is driven in 2014 cars)
  const w = L.makeWin(electron, host, tag, { fps: 60, fresh: true }); w.name = NAMES[tag]; W[tag] = w;
  // v6: the menu's side panel is tabbed; a control can only be clicked in the open tab (car / gp / mp / set)
  w.tab = async t => (await w.click('tab-' + t)) && w.js(`!document.getElementById(${J({ car: 'car-panel', gp: 'gp-panel', mp: 'mp-section', set: 'set-panel' }[t])}).classList.contains('hidden')`);
  // a real mouse click on the element a CSS selector finds (scrolled into view first)
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
  // the 年份 select of the 車輛 tab (a native select cannot be opened offscreen: its value is set and 'change' fired)
  w.pickYear = async y => {
    await w.tab('car');
    return w.js(`(function () { var s = document.getElementById('car-year'); if (s.disabled) return 'disabled'; s.value = ${J(String(y))}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  };
  w.pickCar = async id => (await w.tab('car')) && w.clickSel(`#car-list .car-card[data-id="${id}"]`);
  w.carUi = () => w.js(`({ locked: document.getElementById('car-list').classList.contains('locked'), yearDisabled: document.getElementById('car-year').disabled, year: document.getElementById('car-year').value,
    lock: __e2e.shown('car-lock') ? __e2e.text('car-lock') : '', on: (document.querySelector('#car-list .car-card.on') || { getAttribute: function () { return null; } }).getAttribute('data-id'),
    spec: F1.game.spec ? F1.game.spec.id : null, profile: F1.net.getProfile().car })`);
  w.inMenu = () => w.js(`!F1.game.running && __e2e.shown('menu')`);
  w.resume = async () => { if (await w.inMenu()) await w.tap('Escape'); return w.js(`F1.game.running && !__e2e.shown('menu')`); };
  w.menu = async () => { if (!(await w.inMenu())) await w.tap('Escape'); return w.inMenu(); };
  return w;
}
const onTrack = `F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(TRACK)} && F1.net.trackId === ${J(TRACK)}`;

/* ================================================================================================================ */
async function scenario() {
  const A = makeWin('A'), B = makeWin('B'), C = makeWin('C'), D = WITH_D ? makeWin('D') : null;
  const ABC = [A, B, C], ALL = D ? [A, B, C, D] : ABC;
  const PIT_SRC = fs.readFileSync(PITGEO, 'utf8'), V6_SRC = fs.readFileSync(V6PAGE, 'utf8');

  /* ---------------- room with a password ---------------- */
  setPart('room');
  for (const w of ALL) {
    const err = await w.open();
    await w.js(PIT_SRC + '\n;true');
    const v6 = await w.js(V6_SRC);
    check(w.tag + ' boots without the error overlay; the harness page code is in (pit plan, v6 recorders)', !err && v6 === 'ok', err || v6);
  }
  info('page: ' + L.pageFile() + (L.patched.length ? '   PATCHED: ' + L.patched.join(', ') : ''));
  // (the pit service time is Math.random's: the windows must not share a sequence)
  info('Math.random in each window: ' + J(await all(ALL, w => w.js(`[Math.random(), Math.random(), Math.random()].map(function (v) { return +v.toFixed(5); })`))));
  const muted = ALL.map(w => w.webContents.isAudioMuted());
  check('every window is muted (devtests/electron-userdata.js: --mute-audio ' + app.commandLine.hasSwitch('mute-audio') + ', webContents muted)', !process.env.SOUND && app.commandLine.hasSwitch('mute-audio') && muted.every(Boolean), muted);
  const openMp = await all(ALL, w => w.tab('mp'));
  check('the 多人連線 tab opens on every window', openMp.every(Boolean), openMp);
  for (const w of ALL) { await w.field('mp-name', w.name); await w.js(`document.querySelectorAll('.mp-swatch')[${SWATCH[w.tag]}].click(); true`); }
  await A.field('mp-port', String(PORT));
  await A.field('mp-create-pass', PASSWORD);
  await A.click('mp-create');
  check('A creates the room with a password (host); its status says so', await A.until(`F1.net.connected && F1.net.isHost`, 6000) && (await A.js(`F1.net.hostInfo.hasPassword`)) === true &&
    /已設定房間密碼/.test(await A.e(`text('mp-status')`)), await A.e(`text('mp-status')`));
  await B.field('mp-addr', '127.0.0.1:' + PORT); await B.field('mp-join-pass', PASSWORD);
  await B.click('mp-join');
  check('B joins with the password', await B.until(`F1.net.connected && !F1.net.isHost`, 6000), await B.e(`text('mp-status')`));
  // C: a wrong password first
  await C.field('mp-addr', '127.0.0.1:' + PORT); await C.field('mp-join-pass', WRONG);
  await C.click('mp-join');
  const refused = await C.until(`!F1.net.connected && !F1.net.connecting && __v6.ws.some(function (m) { return m.t === 'error'; })`, 8000, 'C refused');
  await sleep(300);
  const cr = await C.js(`({ ws: __v6.ws, status: __e2e.text('mp-status'), connected: F1.net.connected, players: F1.net.players.length })`);
  const roster1 = await A.js(`F1.net.roster.map(function (r) { return r.name; })`);
  check('C with a wrong password is refused: the server answers error "password", C\'s status says 房間密碼錯誤, C is not in the room (host roster Alice, Bob)',
    refused && cr.ws.length === 1 && cr.ws[0].t === 'error' && cr.ws[0].code === 'password' && cr.status === '房間密碼錯誤' && !cr.connected && J(roster1) === J(['Alice', 'Bob']), { cr, roster1 });
  await shot(C, '01-room-wrong-password-C');
  await C.field('mp-join-pass', PASSWORD);
  await C.click('mp-join');
  check('C joins with the right password (welcome)', await C.until(`F1.net.connected && !F1.net.isHost`, 6000) && (await C.js(`__v6.ws.length === 2 && __v6.ws[1].t === 'welcome'`)), await C.e(`text('mp-status')`));
  if (D) await D.field('mp-addr', '127.0.0.1:' + PORT);          // (D joins during qualifying)
  await sleep(400);
  for (const w of ABC) { w.pid = await w.js(`F1.net.id`); w.slot = await w.js(`F1.net.slot`); }
  check('room slots in join order: A 0, B 1, C 2 (C\'s refused attempt took no slot)', J(ABC.map(w => w.slot)) === '[0,1,2]', ABC.map(w => [w.tag, w.pid, w.slot]));
  check('player list of three on every window', (await all(ABC, w => w.js(`__e2e.text('mp-players-title') + '|' + [].map.call(document.querySelectorAll('#mp-players li .mp-pname'), function (n) { return n.textContent; }).join(',')`)))
    .every(t => t === '玩家（3 / 16）|Alice,Bob,Carol'));
  const picked = await A.pick(TRACK);
  check('A picks ' + picked + ': all three load it, free practice', await waitAll(ABC, onTrack, 25000, 'track') && (await all(ABC, w => w.js(`F1.gp.phase`))).every(p => p === 'free'));
  await sleep(1200);
  const pit = await A.js(`(function () { var p = F1.game.track.pit; return { from: p.from, to: p.to, entry: p.entry, exit: p.exit, limit: p.limitKmh, boxes: p.boxes.slice(0, 4).map(function (b) { return { index: b.index, d: +b.d.toFixed(2), x: b.x, z: b.z, heading: b.heading }; }), N: F1.game.track.samples.length, len: F1.game.track.length }; })()`);
  info('Monaco pit lane: entry line at sample ' + pit.entry + ', exit line ' + pit.exit + ', limit ' + pit.limit + ' km/h, boxes of slots 0 / 1 / 2 at samples ' + pit.boxes.slice(0, 3).map(b => b.index).join(' / '));
  const season0 = await all(ABC, w => w.js(`({ room: F1.net.year, car: F1.game.spec.id })`));
  check('the room starts in the host\'s season (a fresh install: 2026) with the 2026 standard car everywhere', season0.every(s => s.room === 2026 && s.car === '2026-standard'), season0);
  await shot(B, '01-room-free-B');

  /* ---------------- season and cars (free practice) ---------------- */
  setPart('season');
  check('A opens its menu in free practice', await A.menu());
  const y = await A.pickYear(YEAR);
  const followed = await waitAll(ABC, `F1.net.year === ${YEAR} && F1.game.spec && F1.game.spec.year === ${YEAR}`, 5000, 'year ' + YEAR);
  await sleep(300);
  const sy = await all(ABC, w => w.js(`({ spec: F1.game.spec.id, cockpit: F1.game.spec.cockpit, toasts: __e2e.toasts.map(function (t) { return t[1]; }).filter(function (t) { return /賽季/.test(t); }), running: F1.game.running })`));
  check('the host picks ' + YEAR + ' (車輛 tab, 年份) in free practice: the room follows; B and C (driving) are told "房間是 ' + YEAR + ' 賽季：你的車換成 ..." and now drive the ' + YEAR + ' standard car (cockpit without a halo)',
    y === String(YEAR) && followed && sy.every(s => s.spec === YEAR + '-standard' && s.cockpit === 'modern') && sy[1].running && sy[2].running &&
    [1, 2].every(i => sy[i].toasts.length === 1 && /^房間是 2014 賽季：你的車換成 /.test(sy[i].toasts[0])) && sy[0].toasts.length === 0, sy);
  const gl = await B.js(`({ disabled: document.getElementById('car-year').disabled, value: document.getElementById('car-year').value })`);
  check('guest: its 年份 select shows ' + YEAR + ' and is disabled (the host picks the year)', gl.disabled && gl.value === String(YEAR), gl);
  // each picks a team
  check('A picks the 2014 Mercedes (card clicked)', await A.pickCar(TEAM.A));
  await A.resume();
  for (const w of [B, C]) { await w.menu(); check(w.tag + ' picks ' + TEAM[w.tag] + ' (card clicked)', await w.pickCar(TEAM[w.tag])); await w.resume(); }
  await sleep(800);
  const specs = await all(ABC, w => w.js(`({ spec: F1.game.spec.id, profile: F1.net.getProfile().car, roster: F1.net.roster.map(function (r) { return [r.name, r.car]; }) })`));
  const rosterWant = J([['Alice', TEAM.A], ['Bob', TEAM.B], ['Carol', TEAM.C]]);
  check('everybody drives its team\'s 2014 car; the room roster carries the three cars on every window', ABC.every((w, i) => specs[i].spec === TEAM[w.tag] && specs[i].profile === TEAM[w.tag] && J(specs[i].roster) === rosterWant), specs);
  await sleep(600);
  const liv = await all(ABC, w => w.js(`__v6.liveries()`));
  const livOk = ABC.every((w, i) => ABC.every(o => o === w || (liv[i][o.pid] && liv[i][o.pid].spec === TEAM[o.tag] && liv[i][o.pid].painted1 && liv[i][o.pid].painted2 && liv[i][o.pid].visible)));
  check('liveries: every window resolves the two others\' cars and paints their models in the team colours (body colour and second colour found in the model)', livOk, liv);
  // the cars stand in their room boxes (A in front, B 8 m behind on the right, C 16 m behind on the left)
  await sleep(500);
  await shot(C, '02-season-liveries-C-sees-A-B'); await shot(B, '02-season-liveries-B-sees-A'); await shot(A, '02-season-liveries-A-mirrors');
  check('liveries on each other\'s car: screenshots v6-02-season-liveries-* (READ them: C sees the silver Mercedes and the dark blue Red Bull ahead)', true);

  /* ---------------- Grand Prix: qualifying ---------------- */
  setPart('quali');
  for (const w of ABC) {
    await w.e(`arm({ onPhase: { quali: { mode: 'line', scale: ${QPACE[w.tag]}, holdFor: 16, acc: true, thrCap: 1, park: null } }, onGo: null, ram: null, onHit: null, release: null })`);
    await w.e('start()');
  }
  check('A opens the menu, 大獎賽 tab', (await A.menu()) && (await A.tab('gp')));
  check('host sets Q = 1, R = 3, 輪胎損耗 x3', (await A.field('gp-q', '1')) === '1' && (await A.field('gp-r', '3')) === '3' && (await A.clickSel('#gp-wear button[data-w="3"]')) &&
    (await A.js(`document.querySelector('#gp-wear button[data-w="3"]').classList.contains('on')`)));
  const gpCar = await A.js(`__e2e.shown('gp-car') ? __e2e.text('gp-car') : ''`);
  info('大獎賽 tab, car line: ' + gpCar);
  await shot(A, '03-quali-menu-host');
  await all(ALL, w => w.js(`__e2e.fps(); __v6.cost(true); true`));     // (the frame-rate windows start here: not the track load)
  const tQuali = Date.now();
  check('host clicks 開始大獎賽: all three in qualifying', (await A.click('gp-start')) && await waitAll(ABC, `F1.game.gp.phase === 'quali'`, 4000, 'quali'));
  await sleep(500);
  const qv = await all(ABC, w => w.js(`({ v: F1.gp.view(), rate: F1.game.tyres.wearRate, comp: F1.game.tyres.state.compound, wear: F1.game.tyres.state.wear.slice(), year: __e2e.text('hud-gp-year'), toast: __e2e.hud().toast,
    chips: [].map.call(document.querySelectorAll('#hud-gp-rows .gp-row'), function (r) { var c = r.querySelector('.gp-chip'); return [r.querySelector('.mp-pname').textContent, c ? c.style.background : null]; }),
    teams: [].map.call(document.querySelectorAll('#gp-standings .gp-row'), function (r) { var t = r.querySelector('.gp-team'); return [r.querySelector('.mp-pname').textContent, t ? t.textContent : null]; }) })`));
  check('quali on every window: the session\'s year 2014 (HUD box) and wear x3; every car on fresh mediums wearing x1 (the wear option is for the race only); toast with the format',
    qv.every(x => x.v.year === YEAR && x.v.wear === 3 && x.year === String(YEAR) && x.rate === 1 && x.comp === 'M' && x.wear.every(v => v === 0) && /^大獎賽開始：排位 1 圈，正賽 3 圈/.test(x.toast) && x.v.q === 1 && x.v.r === 3),
    qv.map(x => ({ year: x.v.year, wear: x.v.wear, hud: x.year, rate: x.rate, comp: x.comp, toast: x.toast })));
  check('standings: every row has the livery chip of its car (HUD box) and its team in the menu panel (賓士 / 紅牛 / 威廉斯)', qv.every(x => x.chips.length === 3 && x.chips.every(c => !!c[1])) &&
    J(qv[1].teams) === J([['Alice', '賓士'], ['Bob', '紅牛'], ['Carol', '威廉斯']]), { chips: qv[0].chips, teams: qv[1].teams });
  // parc fermé while the cars wait 16 s on their slots
  setPart('parc ferme');
  await B.menu();
  const pb0 = await (async () => { await B.tab('car'); return B.carUi(); })();
  const bClick = await B.clickSel('#car-list .car-card[data-id="2014-ferrari"]');
  await sleep(400);
  const pb1 = await B.carUi();
  await shot(B, '04-quali-parc-ferme-B');
  check('guest (B): the car list is locked, 賽事進行中不能換車, the year select disabled; a real click on the 2014 Ferrari changes nothing (car, card, profile)',
    pb0.locked && pb0.yearDisabled && /賽事進行中不能換車/.test(pb0.lock) && pb1.spec === TEAM.B && pb1.on === TEAM.B && pb1.profile === TEAM.B, { pb0, bClick, pb1 });
  await B.resume();
  await A.menu();
  const ya = await A.pickYear(2010);
  const aClick = await A.clickSel('#car-list .car-card[data-id="2014-ferrari"]');
  const direct = await A.js(`F1.net.setYear(2010)`);
  await sleep(500);
  const pa = await A.carUi();
  check('host (A): the year select is disabled (2010 cannot be picked), js/net.js refuses setYear during the session, a click on another car changes nothing; the room stays 2014',
    ya === 'disabled' && direct === false && pa.locked && pa.spec === TEAM.A && pa.on === TEAM.A && (await all(ABC, w => w.js(`F1.net.year`))).every(v => v === YEAR), { ya, aClick, direct, pa });
  await A.resume();
  const pc = await C.carUi();
  check('C\'s car list (not opened) is locked too', pc.locked && pc.yearDisabled && pc.spec === TEAM.C, pc);
  check('the parc fermé checks were done while the cars still waited on their slots', Date.now() - tQuali < 15000, ((Date.now() - tQuali) / 1000).toFixed(1) + ' s');

  // race programmes, applied when the grid forms / the lights go out (the pit stop is armed after lights out)
  setPart('quali');
  for (const w of ABC) await w.e(`arm({ onPhase: { grid: { mode: 'line', scale: ${RPACE[w.tag]}, holdFor: 0, thrCap: 1, park: null, acc: true } }, onGo: { holdFor: ${REACT[w.tag]} } })`);
  let last = 0;
  while (Date.now() - tQuali < 200000 && !(await A.js(`F1.gp.phase === 'grid'`))) {
    await sleep(500);
    if (Date.now() - last > 15000) { last = Date.now(); const s = await all(ABC, w => w.js(`({ i: F1.game.car.state.sampleIndex, v: F1.game.car.state.speed, done: F1.gp.view().done, bat: F1.game.car.state.battery })`)); info('[' + secs() + '] quali ' + s.map((x, i) => ABC[i].tag + ' @' + x.i + ' ' + (x.v * 3.6).toFixed(0) + ' km/h' + (x.done ? ' done' : '') + ' battery ' + (x.bat * 100).toFixed(0) + ' %').join('  ')); }
  }
  await shot(A, '05-quali-host');
  const qLaps = await all(ABC, w => w.js(`__e2e.lapsDone.filter(function (l) { return l.phase === 'quali'; }).map(function (l) { return l.time; })`));
  timings.qualiLaps = { A: qLaps[0], B: qLaps[1], C: qLaps[2] };
  info('qualifying laps: ' + ABC.map((w, i) => w.tag + ' ' + qLaps[i].map(fmt).join(',')).join('  '));
  check('qualifying: one lap each, in pace order A < B < C; the session went to the grid by itself', qLaps.every(q => q.length === 1) && qLaps[0][0] < qLaps[1][0] && qLaps[1][0] < qLaps[2][0] &&
    await waitAll(ABC, `F1.gp.phase === 'grid'`, 3000), qLaps);
  const qe = await all(ABC, w => w.js(`({ ers: __v6.ers, wear: F1.game.tyres.state.wear.slice() })`));
  info('quali ERS: ' + ABC.map((w, i) => w.tag + ' RB ' + qe[i].ers.boostFrames + ' frames, deploy ' + qe[i].ers.deployFrames).join(', '));
  await fpsMark('qualifying (' + ALL.length + ' windows)', ALL);

  /* ---------------- grid and start ---------------- */
  setPart('grid');
  const tGrid = Date.now();
  await sleep(400);
  const gs = await all(ABC, w => w.js(`({ gp: __e2e.gp(), box: __e2e.box(F1.gp.gridSlot), comp: F1.game.tyres.state.compound, wear: F1.game.tyres.state.wear.slice(), rate: F1.game.tyres.wearRate, bat: F1.game.car.state.battery })`));
  check('grid A, B, C (qualifying order) in boxes 1..3, locked; fresh mediums wearing x3 from here on and a full battery on every car', gs.every((g, i) => g.gp.gridSlot === i && g.gp.locked && Math.abs(g.box.nose - 0.25) < 0.02 && Math.abs(g.box.off) < 0.02) &&
    gs.every(g => g.comp === 'M' && g.wear.every(v => v === 0) && g.rate === 3 && g.bat === 1), gs);
  for (const w of ABC) await w.js(`__v6.ers.minBattery = 1; __v6.ers.boostFrames = 0; __v6.ers.deployFrames = 0; __v6.ers.frames = 0; __e2e.stats(true); true`);
  const goOk = await waitAll(ABC, `F1.gp.phase === 'race' && !F1.gp.inputLocked`, 20000, 'lights out');
  const go = await all(ABC, w => w.e('go'));
  check('lights out on every window; the race is on', goOk && go.every(g => g && g.goAt === go[0].goAt), go.map(g => g && Math.round(g.server - g.goAt)));
  const goWall = go[0].wall, goAt = go[0].goAt;
  for (const w of ABC) await w.js(`__v6.armPit({ onLap: 1, startM: 320, scale: ${PIT_SCALE}, compound: ${J(COMPOUND[w.tag])} })`);
  await fpsMark('grid + lights (' + ALL.length + ' windows, D in the menu)', ALL);
  // D joins (with the password) after lights out: a spectator (a player who joins during qualifying takes part in it)
  if (D) {
    setPart('spectator');
    await D.field('mp-join-pass', PASSWORD);
    await D.click('mp-join');
    check('D joins during the race with the password: a spectator on its room slot, the 2014 standard car (the room\'s season)', await D.until(`F1.net.connected && ${onTrack}`, 25000) &&
      await D.until(`F1.gp.phase === 'race' && !F1.gp.taking && F1.game.spec && F1.game.spec.id === '2014-standard'`, 4000), await D.js(`({ spec: F1.game.spec && F1.game.spec.id, taking: F1.gp.taking, slot: F1.net.slot, ws: __v6.ws })`));
    D.pid = await D.js(`F1.net.id`); D.slot = await D.js(`F1.net.slot`);
    await D.e('fps()'); await D.js(`__v6.cost(true)`);
    await sleep(1500);
    const dl = await D.js(`__v6.liveries()`);
    check('D sees the three racers in their team liveries', ABC.every(o => dl[o.pid] && dl[o.pid].spec === TEAM[o.tag] && dl[o.pid].painted1), dl);
  }

  /* ---------------- race ---------------- */
  setPart('race');
  const N = pit.N, wrap = k => ((k % N) + N) % N;
  const shotsDone = {}, curtainSeen = {}, laneTogether = [], seenTogether = {};
  let maxTogether = 0, lastLog = 0, lastAgree = 0, polls = 0, disagree = 0, results = false, specShot = false;
  const raceEnd = goWall + 480000;
  while (Date.now() < raceEnd) {
    await sleep(250);
    const s = await all(ABC, w => w.js(`(function () { var g = F1.game, P = g.pit.state, pl = __v6.plan ? __v6.plan.info() : __v6.planInfo; return { ph: F1.gp.phase, inLane: P.inLane, svc: !!P.service, stops: P.stops,
      i: g.car.state.sampleIndex, v: g.car.state.speed, lapN: g.lap ? g.lap.n : 0, gpLap: F1.gp.lap, plan: pl ? pl.phase : null, planErr: __v6.planErr, limiter: g.limiter, bat: g.car.state.battery, next: g.nextCompound }; })()`));
    if (s.every(x => x.ph === 'results')) { results = true; break; }
    const t = (Date.now() - goWall) / 1000;
    const inLane = ABC.filter((w, k) => s[k].inLane);
    if (inLane.length >= 2) {
      laneTogether.push([+t.toFixed(1), inLane.map(w => w.tag).join('')]);
      if (inLane.length > maxTogether) maxTogether = inLane.length;
      for (const w of inLane) {
        if (!seenTogether[w.tag]) {
          seenTogether[w.tag] = true;
          await shot(w, '07-race-lane-together-' + w.tag);
          info('[' + secs() + '] ' + inLane.map(x => x.tag).join(' + ') + ' in the pit lane at once (+' + t.toFixed(1) + ' s); screenshot from ' + w.tag);
        }
      }
    }
    for (let k = 0; k < ABC.length; k++) {
      const w = ABC[k], x = s[k];
      const toEntry = wrap(pit.entry - x.i), toExit = wrap(pit.exit - x.i);
      if (!shotsDone['entry' + w.tag] && x.plan === 'approach' && toEntry >= 6 && toEntry <= 30) {
        shotsDone['entry' + w.tag] = true;
        curtainSeen['entry' + w.tag] = await w.js(`__v6.curtains()`);
        await shot(w, '06-race-pit-entry-' + w.tag);
      }
      if (!shotsDone['svc' + w.tag] && x.svc) { shotsDone['svc' + w.tag] = true; await sleep(300); await shot(w, '08-race-service-' + w.tag); }
      if (!shotsDone['exit' + w.tag] && x.plan === 'out' && toExit >= 3 && toExit <= 22) {
        shotsDone['exit' + w.tag] = true;
        curtainSeen['exit' + w.tag] = await w.js(`__v6.curtains()`);
        await shot(w, '09-race-pit-exit-' + w.tag);
      }
      if (x.planErr && !shotsDone['err' + w.tag]) { shotsDone['err' + w.tag] = true; info('PIT PLAN ERROR ' + w.tag + ': ' + x.planErr); }
    }
    // the spectator's view once the stops are done, at a moment a racer is in front of D (12..90 m ahead, within ~30 deg)
    if (D && !specShot && s[0].lapN >= 2 && s.every(x => x.stops >= 1 && !x.inLane) && await D.js(`(function () {
      var c = F1.game.car.state, fx = Math.sin(c.heading), fz = Math.cos(c.heading), n = 0;
      F1.net.players.forEach(function (p) { if (!p.active || p.id === F1.net.id || !p.state) return;
        var dx = p.state.x - c.x, dz = p.state.z - c.z, f = dx * fx + dz * fz, l = Math.abs(dx * fz - dz * fx);
        if (f > 12 && f < 90 && l < 0.6 * f) n++; });
      return n > 0; })()`)) { specShot = true; await shot(D, '10-race-spectator-D'); }
    if (Date.now() - lastAgree > 3000 && s.every(x => x.ph === 'race')) {
      lastAgree = Date.now(); polls++;
      const ag = await agree(ALL);
      if (!ag.ok && ++disagree <= 3) info('DISAGREE ' + J(ag.vs.map(x => x.v.rows.map(r => [r.name, r.laps, r.gap, r.down, r.done]))));
    }
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      info('[' + secs() + '] race +' + t.toFixed(0) + ' s  ' + ABC.map((w, k) => w.tag + ' lap ' + s[k].lapN + ' @' + s[k].i + ' ' + (s[k].v * 3.6).toFixed(0) + ' km/h' + (s[k].plan ? ' pit:' + s[k].plan : '') +
        (s[k].inLane ? ' IN LANE' : '') + ' stops ' + s[k].stops + ' battery ' + (s[k].bat * 100).toFixed(0) + ' % next ' + s[k].next).join('  '));
    }
  }
  timings.race = (Date.now() - goWall) / 1000;
  if (D && !specShot) { info('no racer came into the spectator\'s view after the stops: its screenshot is taken now'); await shot(D, '10-race-spectator-D'); }
  timings.laneTogether = laneTogether.length ? { first: laneTogether[0], last: laneTogether[laneTogether.length - 1], polls: laneTogether.length, max: maxTogether } : null;
  await fpsMark('race (' + ALL.length + ' windows: 3 racing' + (D ? ' + spectator' : '') + ')', ALL);
  check('race: live standings agreed between the windows at every one of ' + polls + ' polls', polls >= 30 && disagree === 0, { polls, disagree });

  /* ---------------- the pit stops ---------------- */
  setPart('pit stops');
  const vi = await all(ABC, w => w.js(`__v6.info()`));
  ABC.forEach((w, k) => {
    const x = vi[k], p = x.plan || {}, r = p.rec || {};
    info(w.tag + ' (slot ' + w.slot + '): plan ' + J({ phase: p.phase, stopped: p.stopped, served: p.served, noService: p.noService, err: x.err }) + ' lane ' + J(x.lane) + ' events ' + J(x.events) + ' taps ' + J(x.taps.map(t => t[1] + ':' + t[2])) +
      ' rec ' + J({ maxLaneKmh: r.maxLaneKmh && +r.maxLaneKmh.toFixed(1), hits: r.hits, grass: r.grass, svcTotal: r.svcTotal, maxServiceMove: r.maxServiceMove, frozenBad: r.frozenBad, limiterFrames: r.limiterFrames }));
  });
  check('each car made exactly one stop, in the race, stopped in the box of its room slot (within 0.5 m along, 0.3 m across) and was served there',
    vi.every((x, k) => x.stops === 1 && x.plan && x.plan.served && !x.plan.noService && x.plan.slot === ABC[k].slot && x.plan.stopped && Math.abs(x.plan.stopped.along) < 0.5 && Math.abs(x.plan.stopped.across) < 0.3 &&
      x.lane.length === 1 && x.lane[0].phase === 'race'), vi.map(x => ({ stops: x.stops, slot: x.plan && x.plan.slot, stopped: x.plan && x.plan.stopped, lane: x.lane.length })));
  const svcOn = vi.map(x => x.events.filter(e => e.ev === 'on')[0] || null), svcOff = vi.map(x => x.events.filter(e => e.ev === 'off' && e.stops === 1)[0] || null);
  const boxErr = ABC.map((w, k) => { const b = pit.boxes[w.slot], e = svcOn[k]; return e ? +Math.hypot(e.x - b.x, e.z - b.z).toFixed(2) : null; });
  check('the service started with each car at its own box (slots 0 / 1 / 2: within 0.6 m of track.pit.boxes[slot])', boxErr.every(d => d !== null && d < 0.6), boxErr);
  const svc = svcOn.map(e => e && e.total);
  timings.service = svc;
  check('the services took a random 2.0 .. 4.5 s each (not all the same)', svc.every(s => s >= 2 && s <= 4.5) && new Set(svc).size > 1, svc);
  const held = vi.map(x => x.plan && x.plan.rec ? [x.plan.rec.maxServiceMove, x.plan.rec.frozenBad] : null);
  const lapRan = ABC.map((w, k) => svcOn[k] && svcOff[k] ? { lap: +(svcOff[k].lapT - svcOn[k].lapT).toFixed(3), wall: +((svcOff[k].perf - svcOn[k].perf) / 1000).toFixed(3) } : null);
  check('during the service the car was held (did not move) while its lap clock ran on (lap clock = real time = the service)', held.every(h => h && h[0] === 0 && h[1] === 0) &&
    lapRan.every((l, k) => l && near(l.lap, l.wall, 0.12) && near(l.lap, svc[k], 0.15)), { held, lapRan, svc });
  const tyres = ABC.map((w, k) => ({ before: svcOn[k] && { c: svcOn[k].compound, wear: svcOn[k].wear }, after: svcOff[k] && { c: svcOff[k].compound, wear: svcOff[k].wear }, want: COMPOUND[w.tag] }));
  check('new tyres at the stop: the compound chosen with X (A hard, B medium, C hard), wear back to 0; the old set had worn (x3) over the first lap', tyres.every(t => t.before && t.after && t.before.c === 'M' &&
    Math.max(...t.before.wear) > 0.02 && t.after.c === t.want && t.after.wear.every(v => v < 0.001)), tyres);
  check('the pit strip showed the service countdown (換胎)', svcOn.every(e => e && /換胎/.test(e.strip)), svcOn.map(e => e && e.strip));
  const laneSpeed = vi.map(x => x.plan && x.plan.rec ? x.plan.rec.maxLaneKmh : null);
  check('no car faster than the lane limit + 3 km/h between the lines; no speeding toast; the limiter switched on and off through the pad (LB)', laneSpeed.every(v => v !== null && v <= pit.limit + 3) &&
    (await all(ABC, w => w.js(`__e2e.toasts.some(function (t) { return /維修區超速/.test(t[1]); })`))).every(x => !x) && vi.every(x => x.taps.filter(t => t[1] === 4).length >= 2 && !x.limiter), { laneSpeed });
  check('at least two cars in the pit lane at the same time (most at once: ' + maxTogether + ')', maxTogether >= 2, timings.laneTogether);
  // ghosts in the lane: what each car saw of the others while both were in the lane
  const seen = ABC.map((w, k) => { const o = {}; ABC.forEach(x => { if (x !== w && vi[k].seen[x.pid]) o[x.tag] = vi[k].seen[x.pid]; }); return o; });
  const pairs = [];
  ABC.forEach((w, k) => Object.keys(seen[k]).forEach(t => pairs.push({ me: w.tag, other: t, frames: seen[k][t].frames, translucent: seen[k][t].translucentChecks, opaque: seen[k][t].opaqueChecks, minDist: +seen[k][t].minDist.toFixed(1), hit: seen[k][t].hitWhile })));
  info('cars seen in the lane while in it: ' + J(pairs));
  check('in the lane together the cars are ghosts to each other: drawn translucent every time they were looked at, no impact on either while both were in the lane (closest ' +
    (pairs.length ? Math.min(...pairs.map(p => p.minDist)).toFixed(1) : '?') + ' m)', pairs.length >= 2 && pairs.every(p => p.translucent > 0 && p.opaque === 0 && p.hit === 0), pairs);
  // every impact during the stop (from 320 m before the lane to back on the racing line), and the race as the autopilot saw it
  const rstats = await all(ABC, w => w.e('stats()'));
  ABC.forEach((w, k) => {
    const hl = vi[k].hitLog || [], s = rstats[k];
    info(w.tag + ' race autopilot: wall hits ' + s.wall + ' (max ' + s.wallMax.toFixed(2) + '), car impacts ' + s.car + ' (max ' + s.carMax.toFixed(2) + ', at ' + J(s.carAt.map(t => +(t - s.goPerf).toFixed(1))) + ' s after the start), gap-keeping frames ' + s.accSteps +
      ', resets ' + s.resets + ' ' + J(s.events.slice(0, 6)));
    info(w.tag + ' impacts during its stop: ' + hl.length + ' frames' + (hl.length ? ': first ' + J(hl.slice(0, 4)) + ' last ' + J(hl[hl.length - 1]) : ''));
  });
  check('no impact of any kind during the stops (plan from 320 m before the lane until back on the racing line) and no wall in the race',
    vi.every(x => x.plan && x.plan.rec && x.plan.rec.hits === 0) && rstats.every(s => s.wall === 0 && s.resets === 0), vi.map((x, k) => ({ planHitFrames: x.plan && x.plan.rec ? x.plan.rec.hits : null, wall: rstats[k].wall, car: rstats[k].car })));
  const cur = ABC.map(w => ({ entry: curtainSeen['entry' + w.tag] || null, exit: curtainSeen['exit' + w.tag] || null }));
  check('light curtains: the entry curtain was on screen (ahead, under 70 m) when each car approached it, the exit curtain when it left the box; the curtain mesh visible (screenshots v6-06 / v6-09: READ them)',
    cur.every(c => c.entry && c.entry.visible && c.entry.entry.onScreen && c.entry.entry.dist < 70 && c.exit && c.exit.exit.onScreen && c.exit.exit.dist < 70), cur);
  const ers = vi.map(x => x.ers);
  check('ERS: all three deployed the battery in the race (RB held on the straights: deploy > 0, the battery drawn down)', ers.every(e => e.boostFrames > 120 && e.deployFrames > 120 && e.maxDeploy > 0.5 && e.minBattery < 0.95),
    ers.map(e => ({ rbFrames: e.boostFrames, deployFrames: e.deployFrames, maxDeploy: +e.maxDeploy.toFixed(2), minBattery: +e.minBattery.toFixed(3) })));

  /* ---------------- results ---------------- */
  setPart('results');
  check('results on every window (' + timings.race.toFixed(0) + ' s after lights out)', results && await waitAll(ALL, `F1.gp.phase === 'results'`, 3000));
  await sleep(500);
  // (a car that has finished drives on: only its first three race laps are the race)
  const laps = await all(ABC, w => w.js(`__e2e.lapsDone.filter(function (l) { return l.phase === 'race'; }).slice(0, 3)`));
  const rl = laps.map(l => l.map(x => x.time));
  timings.raceLaps = { A: rl[0], B: rl[1], C: rl[2] };
  info('race laps (own lap counters): ' + ABC.map((w, k) => w.tag + ' ' + rl[k].map(fmt).join(' + ')).join('   '));
  const ag = await agree(ALL), v = ag.vs[0].v, res = await all(ALL, w => w.e('results()'));
  const byId = {}; v.rows.forEach(r => { byId[r.id] = r; });
  const sum = k => r3(rl[k].reduce((a, b) => a + r3(b), 0));
  check('results: everybody finished 3 laps; each race time = the sum of the car\'s own lap times (stop included) = the session clock at its finish (within 60 ms)',
    ABC.every((w, k) => rl[k].length === 3 && byId[w.pid] && byId[w.pid].laps === 3 && byId[w.pid].done && near(byId[w.pid].time, sum(k), 0.0011) &&
      near(byId[w.pid].time, (laps[k][2].clock - goAt) / 1000, 0.06)), ABC.map((w, k) => ({ tag: w.tag, time: byId[w.pid] && byId[w.pid].time, sum: sum(k), clock: r3((laps[k][2].clock - goAt) / 1000) })));
  const stopLap = ABC.map((w, k) => { const l = rl[k], s2 = l[1], others = (l[0] + l[2]) / 2; return { stopLap: r3(s2), otherLaps: r3(others), extra: r3(s2 - l[2]), service: svc[k] }; });
  check('the stop is in the race time: the lap with the stop (lap 2) is longer than the last lap by more than the service time', stopLap.every(s => s.extra > s.service + 2), stopLap);
  const table = v.rows.map((r, i) => [String(i + 1), r.name, '3', hudTime(r.time), i === 0 ? '' : hudGap(r.gap), hudTime(r.best)]);
  const sub = 'Circuit de Monaco ‧ ' + YEAR + ' 賽季 ‧ 排位 1 圈 ‧ 正賽 3 圈 ‧ 輪胎損耗 ×3';
  check('results overlay identical on every window (' + ALL.map(w => w.tag).join(', ') + '): classification, race times, gaps, best laps; subtitle "' + sub + '"',
    ag.ok && res.every(r => r.shown && J(r.rows.map(x => [x.pos, x.name, x.laps, x.time, x.gap, x.best])) === J(table) && r.sub === sub), { table, sub: res.map(r => r.sub), rows: res[0].rows });
  timings.results = v.rows.map(r => [r.name, r.time, r.gap, r.best]);
  await shot(A, '11-results-host'); await shot(B, '11-results-B'); if (D) await shot(D, '11-results-spectator-D');
  // parc fermé still on in the results
  await C.menu();
  await C.tab('car');
  const cRes0 = await C.carUi();
  await C.clickSel('#car-list .car-card[data-id="2014-ferrari"]');
  await sleep(300);
  const cRes1 = await C.carUi();
  check('parc fermé still on in the results: C\'s car list locked, a click changes nothing', cRes0.locked && cRes1.spec === TEAM.C && cRes1.on === TEAM.C, { cRes0, cRes1 });
  await C.resume();

  /* ---------------- back to free practice ---------------- */
  setPart('free');
  check('host clicks 結束 in the results overlay: free practice for everybody', (await A.click('gp-res-end')) && await waitAll(ALL, `F1.gp.phase === 'free'`, 4000));
  await sleep(800);
  const fr = await all(ABC, w => w.carUi());
  const fr2 = await all(ABC, w => w.js(`({ year: F1.net.year, roster: F1.net.roster.map(function (r) { return [r.name, r.car]; }), toast: __e2e.hud().toast, results: __e2e.shown('gp-results') })`));
  const rosterWant2 = D ? rosterWant.slice(0, -1) + ',["Dave","2014-standard"]]' : rosterWant;     // (D: the room's season, its default car)
  check('free practice again: everybody keeps its 2014 team car, the room stays 2014, the roster still carries the cars, overlay gone, toast', ABC.every((w, k) => fr[k].spec === TEAM[w.tag] && fr[k].profile === TEAM[w.tag]) &&
    fr2.every(x => x.year === YEAR && J(x.roster) === rosterWant2 && !x.results && x.toast === '大獎賽已結束，回到自由練習'), { fr, fr2 });
  check('the car pickers are open again (no lock); the year select: enabled for the host, disabled for the guests (房主選)', fr.every(x => !x.locked) && !fr[0].yearDisabled && fr[1].yearDisabled && fr[2].yearDisabled &&
    !/賽事進行中/.test(fr[1].lock), fr.map(x => ({ locked: x.locked, yearDisabled: x.yearDisabled, lock: x.lock })));
  const liv2 = await all(ABC, w => w.js(`__v6.liveries()`));
  check('the liveries are still on the remote cars', ABC.every((w, i) => ABC.every(o => o === w || (liv2[i][o.pid] && liv2[i][o.pid].spec === TEAM[o.tag] && liv2[i][o.pid].painted1))), liv2);
  await shot(C, '12-free-again-C');
  await fpsMark('free practice again', ALL);

  /* ---------------- the end ---------------- */
  setPart('end');
  const audio = await all(ALL, w => w.js(`(function () { var a = F1.audio, d = a && a.debug; return d ? { backend: d.backend, ready: d.ready, state: d.context ? d.context.state : null, frames: d.frames, voices: d.voices, muted: a.muted, volume: a.volume } : null; })()`));
  const audible = ALL.map(w => ({ muted: w.webContents.isAudioMuted(), audible: w.webContents.isCurrentlyAudible() }));
  ALL.forEach((w, k) => info(w.tag + ' audio: ' + J(audio[k]) + ' webContents ' + J(audible[k])));
  check('audio: the game\'s sound runs in every window (back end ready, context running, frames rendered) and every window is muted at the browser level', audio.every(a => a && a.ready && a.state === 'running' && a.frames > 0) &&
    audible.every(a => a.muted), { audio, audible });
  for (const w of ALL) await w.noErrors();
  const drive = fpsLog.filter(f => !/loading/.test(f.label));
  check('frame rate: every window got at least 30 fps on average in every phase (60 requested)', fpsLog.every(f => f.fps >= 30), { min: Math.min(...fpsLog.map(f => f.fps)).toFixed(1), longestFrameMs: Math.max(...drive.map(f => f.maxGap)).toFixed(0) });
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  host.register(ipcMain);
  try { await scenario(); } catch (e) { check('harness ran to the end', false, e && e.stack ? e.stack : String(e)); }
  console.log('\n--- measured ---');
  console.log('frame rate (requested 60) and main-thread ms per frame (all rAF callbacks: game + recorders):');
  fpsLog.forEach(f => console.log('  ' + f.label.padEnd(46) + f.tag + '  ' + f.fps.toFixed(1).padStart(5) + ' fps   longest frame ' + f.maxGap.toFixed(0).padStart(4) + ' ms   over 50 ms: ' + String(f.slow).padStart(3) +
    '   script+render ms/frame mean ' + String(f.cost.mean).padStart(5) + ' p50 ' + String(f.cost.p50).padStart(5) + ' p95 ' + String(f.cost.p95).padStart(5) + ' max ' + String(f.cost.max).padStart(6)));
  console.log('timings: ' + JSON.stringify(timings, null, 1));
  console.log('screenshots (' + L.OUT + '): ' + shots.join(' '));
  console.log('run duration ' + ((Date.now() - T0) / 1000).toFixed(0) + ' s');
  const bad = L.summary();
  try { await host.stopServer(); } catch (e) {}
  Object.keys(W).forEach(k => { try { W[k].destroy(); } catch (e) {} });
  app.exit(bad ? 1 : 0);
});
