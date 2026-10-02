// v7.2 acceptance harness: the room lobby (房間大廳) and the single-player start panel (出發面板), in the REAL game.
// Muted offscreen windows (devtests/electron-userdata.js), the real preload.js + net/host.js IPC + net/server.js, real
// mouse / key events and a fake controller. docs/lobby-design.md §13 lists what it checks; screenshots in out/ (read them).
//
//   npx electron devtests/lobby-test/run.js
//
// Parts (ONLY=solo,room,leave,ded,proto,early):
//   solo   card -> start panel -> 開始 by mouse, Enter and pad A; Esc / pad B back to the cards; nothing drives before 開始;
//          重新開始 on the loaded track without a rebuild; free practice with computer drivers; a Grand Prix with
//          computer drivers to the results; the Grand Prix warning; 在目前賽道開大獎賽…; the panel at 7 window sizes
//   room   in-game server, host + 2 guests (+ a latecomer): everybody in the lobby and nobody on a track; the host's
//          track / season / mode / laps / wear / bots seen by the guests within 0.5 s; a guest's own `set` ignored;
//          cars, 準備 (mouse and pad A), 開始 only when allowed (disabled, nostart not-ready, 不等了 + confirm); the loading
//          barrier (no state on the wire before the session, the session begins on every window together; a slow
//          loader is waited for); Esc / the room menu; 回到大廳; a Grand Prix with 3 computer drivers: qualifying only
//          after the barrier (the gp message after the room's session message), every window's phase / sid / session
//          clock; a latecomer during the race (spectator); results; 再來一場 (no rebuild); 回到大廳 with the latecomer;
//          the lobby at 4 window sizes; the host leaving in the lobby
//   leave  a guest leaving while the others wait for him (the barrier completes without him); the in-game host leaving
//          during loading while a guest still loads, and while he is the last one loading (no session starts)
//   ded    `node net/server.js <port>` as a child process: the first player to join is host; migration in the lobby
//          (track and bots survive) and during loading; the new host starts; the server's log lines
//   proto  a raw hello {v: 1} / {v: '2'} / no v -> error version need 2; the page against a protocol-1 stub server
//          (the old-server text) and a newer one (need 3)
//   early  the lobby review's LOBBY-1 / LOBBY-2: the host's 取消，回到大廳 / 不等了，開始 / the room menu's 回到大廳 clicked
//          at once (inside the server's 1 s between two of his start / go / back) are carried out with ONE click, no
//          toast; a double click on 開始 over a slow link (a dedicated server behind a TCP proxy of RTT 150 / 400 ms)
//          sends one start and shows no 「現在無法開始」
// Exit code 0 = all checks passed, 1 = a check failed, 2 = watchdog. Env: ONLY, PORT (24830; parts use PORT..PORT+8).
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'), path = require('path'), cp = require('child_process'), nodeNet = require('net');
const ROOT = path.resolve(__dirname, '..', '..');
require('../electron-userdata')(app, 'lobby-test');
const host = require(path.join(ROOT, 'net', 'host'));
const relay = require(path.join(ROOT, 'net', 'server'));
const WS = require(path.join(ROOT, 'node_modules', 'ws'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 24830);
const ONLY = (process.env.ONLY || 'solo,room,leave,ded,proto,early').split(',').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

// every in-game server net/host.js starts (createServer is looked up at call time): its info() and its log
const servers = [];
const createServer0 = relay.createServer;
relay.createServer = function (o) {
  const rec = { log: [], srv: null };
  servers.push(rec);
  return createServer0(Object.assign({}, o, { log: s => rec.log.push([Date.now(), s]) })).then(s => { rec.srv = s; return s; });
};
const lastServer = () => servers[servers.length - 1];

let part = '';
const results = [];
function check(name, ok, detail) {
  results.push({ name: part + ': ' + name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + part + ': ' + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
  return !!ok;
}
function note(s) { console.log('NOTE ' + part + ': ' + s); }

// page helpers: the wire recorder (every message in / out with the room state at that moment), a fake controller,
// uncaught errors
const PAGE_LIB = `(function () {
  if (window.__lt) return true;
  window.__lt = true;
  window.__errs = [];
  window.addEventListener('error', function (e) { window.__errs.push(String(e && (e.message || e.type))); });
  window.addEventListener('unhandledrejection', function (e) { window.__errs.push('rejection: ' + String(e && e.reason)); });
  var W = window.WebSocket;
  window.__ws = [];
  function rec(d, m) {
    var r = window.F1 && F1.net ? F1.net.room : null;
    var e = { d: d, t: m.t, wall: Date.now(), st: r ? r.st : null, rs: r ? r.rs : null, run: !!(F1.game && F1.game.running) };
    if (m.t === 'room') { e.rst = m.st; e.rrs = m.rs; }
    if (m.t === 'welcome' && m.room) { e.rst = m.room.st; e.rrs = m.room.rs; }
    if (m.t === 'gp' && m.s) { e.ph = m.s.phase; e.sid = m.s.sid; }
    if (m.t === 'snap') e.n = Array.isArray(m.p) ? m.p.length : 0;
    if (m.t === 'nostart') { e.why = m.why; e.wait = m.wait; }
    if (m.t === 'error') { e.code = m.code; e.need = m.need; }
    window.__ws.push(e);
    if (window.__ws.length > 30000) window.__ws.splice(0, 10000);
  }
  function X(u, p) {
    var s = p === undefined ? new W(u) : new W(u, p), send = s.send;
    window.__sock = s;
    s.send = function (data) { try { var m = JSON.parse(data); if (m.t !== 'ping') rec('out', m); } catch (e) {} return send.call(s, data); };
    s.addEventListener('message', function (ev) { try { var m = JSON.parse(ev.data); if (m.t !== 'pong') rec('in', m); } catch (e) {} });
    return s;
  }
  X.prototype = W.prototype; X.CONNECTING = 0; X.OPEN = 1; X.CLOSING = 2; X.CLOSED = 3;
  window.WebSocket = X;
  // the game's events with the wall clock (all windows share it): when each window saw its room's transitions
  window.__ev = [];
  ['room', 'load', 'go', 'lobby', 'nostart', 'disconnected', 'connected'].forEach(function (n) {
    F1.net.on(n, function (a) { window.__ev.push({ n: n, wall: Date.now(), st: F1.net.room ? F1.net.room.st : null, run: F1.game.running, a: n === 'room' ? (a && a.st) : a }); });
  });
  window.__fakePad = function () {
    var b = []; for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
    window.__pad = { index: 0, id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b,
      vibrationActuator: { type: 'dual-rumble', playEffect: function () { return Promise.resolve('complete'); } } };
    window.__padOn = true;
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return window.__padOn ? [window.__pad, null, null, null] : [null, null, null, null]; } });
    return true;
  };
  // every toast main.js shows, with the wall clock (a toast may be gone by the time the harness looks)
  window.__toasts = [];
  var toast0 = F1.ui.toast;
  F1.ui.toast = function (text, ms) { if (text) window.__toasts.push([Date.now(), String(text)]); return toast0.apply(this, arguments); };
  window.__shown = function (sel) { var e = document.getElementById(sel) || document.querySelector(sel); if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  window.__txt = function (sel) { var e = document.getElementById(sel) || document.querySelector(sel); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
  return true;
})()`;

// the state of a window as the harness reads it
const ST = `(function () { var s = F1.game.setup, r = F1.net.room, t = document.getElementById('hud-toast');
  return { conn: F1.net.connected, host: F1.net.isHost, id: F1.net.id, running: F1.game.running, show: s && s.show, room: !!(s && s.room), st: r && r.st, rs: r && r.rs,
    set: r && r.set, ready: r && r.ready, loadedRs: F1.net.loadedRs, phase: F1.game.gp.phase, sid: F1.game.gp.sid, taking: F1.game.gp.taking,
    track: F1.game.trackData ? F1.game.trackData.id : null, rl: !document.getElementById('room-loading').classList.contains('hidden'),
    go: s && s.go, rd: s && s.ready, force: s && s.force, menu: !document.getElementById('menu').classList.contains('hidden'),
    toast: t.classList.contains('hidden') ? '' : t.textContent }; })()`;

let winSeq = 0;
function makeWin(tag, o) {
  o = o || {};
  const w = new BrowserWindow({ width: o.w || 1280, height: o.h || 720, show: false, useContentSize: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, partition: 'lobbytest-' + tag + '-' + (++winSeq),
      preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false } });
  w.webContents.setFrameRate(30);
  w.errors = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    w.errors.push(msg);
    console.log('[' + tag + ' console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.webContents.on('render-process-gone', (e, d) => { w.errors.push('renderer gone: ' + d.reason); console.log('[' + tag + '] renderer gone', d.reason); });
  host.attach(w);
  w.tag = tag;
  w.js = code => w.webContents.executeJavaScript(code);
  w.st = () => w.js(ST);
  w.shot = async n => { await sleep(200); fs.writeFileSync(path.join(OUT, part + '-' + n + '-' + tag + '.png'), (await w.webContents.capturePage()).toPNG()); };
  const CODES = { Escape: 'Escape', Enter: 'Return' };
  w.key = async (k, holdMs) => {
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: CODES[k] || k });
    if (k === 'Enter') w.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    await sleep(holdMs || 40);
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: CODES[k] || k });
    await sleep(120);
  };
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 6000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(30); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  // a real mouse click in the middle of the element (scrolled into view; it must be the element hit there and enabled)
  w.click = async sel => {
    const r = await w.js(`(function () { var e = document.getElementById(${J(sel)}) || document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, hit: !!top && (top === e || e.contains(top)), top: top ? (top.id || top.className || top.tagName) : null, disabled: !!e.disabled }; })()`);
    if (!r || !(r.w > 0) || !r.hit || r.disabled) { console.log('click ' + tag + ': ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
    return true;
  };
  w.field = (id, v) => w.js(`(function () { var e = document.getElementById(${J(id)}); e.value = ${J(v)};
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  w.cardSel = async id => '#track-grid .card[data-i="' + await w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; })`) + '"]';
  w.card = async id => w.click(await w.cardSel(id));
  w.open = async () => {
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(800);
    await w.js(PAGE_LIB);
    return w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  };
  w.pad = async (btn, ms) => {
    await w.js(`(window.__pad.buttons[${btn}].pressed = true, window.__pad.buttons[${btn}].value = 1)`);
    await sleep(ms || 220);
    await w.js(`(window.__pad.buttons[${btn}].pressed = false, window.__pad.buttons[${btn}].value = 0)`);
    await sleep(220);
  };
  w.create = async (name, port) => {
    await w.field('mp-name', name); await w.click('#tab-mp'); await w.field('mp-port', String(port));
    await w.click('#mp-create');
    return w.until(`F1.net.connected && F1.net.isHost && F1.game.setup && F1.game.setup.room`, 8000, 'create');
  };
  w.join = async (name, port) => {
    await w.field('mp-name', name); await w.click('#tab-mp'); await w.field('mp-addr', '127.0.0.1:' + port);
    await w.click('#mp-join');
    return w.until(`F1.net.connected && F1.game.setup && F1.game.setup.room && F1.net.room`, 8000, 'join');
  };
  w.noErrors = async what => {
    const overlay = await w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
    const pageErrs = await w.js(`window.__errs || []`);
    return check(tag + ': no error overlay, no console / page errors' + (what ? ' (' + what + ')' : ''), !overlay && !w.errors.length && !pageErrs.length,
      overlay || w.errors.slice(0, 4).concat(pageErrs.slice(0, 4)));
  };
  return w;
}
const closeAll = ws => { for (const w of ws) { try { if (w && !w.isDestroyed()) w.destroy(); } catch (e) {} } };
const spread = a => Math.max.apply(null, a) - Math.min.apply(null, a);
// a page busy for ms when the next track build starts (a slow machine; the harness must not query it meanwhile)
const SLOW_BUILD = ms => `(function () { var bt = F1.buildTrack; F1.buildTrack = function (d, o) { F1.buildTrack = bt; var t = performance.now(); while (performance.now() - t < ${ms}) {} return bt(d, o); }; return true; })()`;
// hold the next `loaded` report (the window then stays in the barrier's wait list as long as the harness wants)
const HOLD_LOADED = `(function () { var sl = F1.net.sendLoaded; window.__held = null; F1.net.sendLoaded = function () { window.__held = [].slice.call(arguments); F1.net.sendLoaded = sl; window.__release = function () { return sl.apply(F1.net, window.__held); }; return true; }; return true; })()`;
// the layout checks of docs/lobby-design.md §9 for the action button sel
const LAYOUT = sel => `(function () { var g = document.getElementById(${J(sel)}).getBoundingClientRect(), mb = document.querySelector('.menu-body'), mm = document.querySelector('.menu-main');
  var foot = document.getElementById('setup-foot').getBoundingClientRect();
  F1.ui.toast('測試訊息：版面檢查', 4000);
  var t = document.getElementById('hud-toast').getBoundingClientRect();
  var over = !(t.right <= foot.left || t.left >= foot.right || t.bottom <= foot.top || t.top >= foot.bottom);
  var hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2), btn = document.getElementById(${J(sel)});
  F1.ui.toast('');
  return { w: innerWidth, h: innerHeight, btn: { top: Math.round(g.top), bottom: Math.round(g.bottom), left: Math.round(g.left), right: Math.round(g.right) },
    hit: !!hit && (hit === btn || btn.contains(hit)), toastOverFoot: over,
    hscroll: Math.max(document.documentElement.scrollWidth - innerWidth, mb.scrollWidth - mb.clientWidth, mm ? mm.scrollWidth - mm.clientWidth : 0) }; })()`;
const layoutOk = m => m.btn.top >= 0 && m.btn.bottom <= m.h && m.btn.left >= 0 && m.btn.right <= m.w && m.hit && !m.toastOverFoot && m.hscroll <= 0;

/* ======================================================================================================== solo */
async function partSolo() {
  const w = makeWin('S');
  try {
    check('boot without the error overlay', !(await w.open()));
    let s = await w.st();
    check('boot: the cards, nothing built, not driving', s.show === 'tracks' && !s.running && !s.track && await w.js(`!F1.game.track`), s);
    await w.shot('01-cards');
    // ---- a card by mouse: the panel, nothing loads ----
    check('mouse click on the Monza card', await w.card('it-1922'));
    s = await w.st();
    const p1 = await w.js(`({ focus: document.activeElement && document.activeElement.id, menu: document.getElementById('menu').className, track: !!F1.game.track,
      title: __txt('setup-track-name'), label: __txt('setup-go-label'), sub: __txt('setup-go-sub'), hint: __txt('setup-hint'), grid: __shown('track-grid') })`);
    check('card click: the start panel of Monza (開始 focused, the cards hidden), nothing built, not driving', s.show === 'setup' && !s.running && !p1.track && p1.focus === 'setup-go' &&
      /setup-open/.test(p1.menu) && !p1.grid && p1.label === '開始' && /自由練習/.test(p1.sub) && /蒙札/.test(p1.title), Object.assign({ show: s.show }, p1));
    await sleep(1500);
    check('1.5 s later still nothing built, not driving (the panel waits for 開始)', await w.js(`!F1.game.running && !F1.game.track && F1.game.setup.show === 'setup'`));
    await w.shot('02-panel');
    // Esc: back to the cards; the card again; Enter starts (the keyboard)
    await w.key('Escape');
    check('Esc in the panel: back to the cards, nothing built', await w.until(`F1.game.setup.show === 'tracks' && !F1.game.track && __shown('track-grid')`, 2000));
    await w.card('it-1922');
    await w.key('Enter');
    check('Enter (開始 has the focus): Monza built, free practice, driving', await w.until(`F1.game.running && F1.game.trackData.id === 'it-1922' && F1.game.gp.phase === 'free'`, 15000));
    await w.js(`window.__t0 = F1.game.track; window.__start0 = [F1.game.car.state.x, F1.game.car.state.z]; true`);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' }); await sleep(1500); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
    await sleep(200);
    await w.shot('03-driving');
    await w.key('Escape');
    s = await w.st();
    check('Esc while driving: the cards with 繼續駕駛, the loaded card marked 目前賽道', s.show === 'tracks' && !s.running && await w.js(`__shown('menu-resume') && document.querySelectorAll('.card.current').length === 1 &&
      document.querySelector('.card.current').getAttribute('data-i') == F1_TRACKS.findIndex(function (t) { return t.id === 'it-1922'; })`), s);
    await w.shot('04-cards-current');
    // the loaded track's card: 重新開始 by mouse, no rebuild, back on the start
    await w.card('it-1922');
    const p2 = await w.js(`({ cur: F1.game.setup.current, label: __txt('setup-go-label'), chip: __shown('setup-current'), moved: Math.hypot(F1.game.car.state.x - __start0[0], F1.game.car.state.z - __start0[1]) })`);
    check('the loaded track\'s card: chip 目前賽道, 開始 reads 重新開始 (the car had driven ' + p2.moved.toFixed(0) + ' m)', p2.cur && p2.chip && p2.label === '重新開始' && p2.moved > 5, p2);
    await w.click('#setup-mode [data-m="free"]');
    check('重新開始 by mouse: driving again', await w.click('#setup-go') && await w.until(`F1.game.running`, 5000));
    const p3 = await w.js(`({ same: F1.game.track === __t0, d: Math.hypot(F1.game.car.state.x - __start0[0], F1.game.car.state.z - __start0[1]), v: F1.game.car.state.speed })`);
    check('重新開始: the same track object (no rebuild), the car back on its start, standing', p3.same && p3.d < 0.5 && Math.abs(p3.v) < 0.5, p3);
    // ---- the controller: B back, A starts ----
    await w.js(`__fakePad()`);
    await sleep(600);
    check('fake pad connected', await w.js(`F1.gamepad.state.connected`));
    await w.key('Escape');
    await w.card('gb-1948');
    check('Silverstone card: the panel', await w.until(`F1.game.setup.show === 'setup' && F1.game.setup.trackId === 'gb-1948'`, 1500));
    await w.pad(1);
    check('pad B in the panel: back to the cards (Monza still loaded, nothing built)', await w.until(`F1.game.setup.show === 'tracks'`, 1500) && await w.js(`F1.game.trackData.id === 'it-1922' && !F1.game.running`));
    await w.card('gb-1948');
    await sleep(150);
    await w.pad(0);
    check('pad A in the panel: 開始 (Silverstone, free practice)', await w.until(`F1.game.running && F1.game.trackData.id === 'gb-1948' && F1.game.gp.phase === 'free'`, 15000));
    await w.pad(9);
    check('pad Start while driving: the menu', await w.until(`!F1.game.running`, 1500));
    await w.pad(9);
    check('pad Start on the cards: driving again', await w.until(`F1.game.running`, 1500));
    await w.js(`window.__padOn = false; true`);
    await sleep(300);
    // ---- free practice with computer drivers, from the panel ----
    await w.key('Escape');
    await w.card('gb-1948');
    await w.js(`(function () { var e = document.getElementById('gp-bots'); e.value = '3'; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(500);
    check('the panel: 3 computer drivers asked for (made at once on the loaded track)', await w.until(`F1.game.bots.length === 3`, 3000), await w.js(`F1.game.bots.length`));
    await w.shot('05-panel-bots');
    await w.click('#setup-go');
    check('重新開始: free practice with the 3 computer drivers', await w.until(`F1.game.running && F1.game.bots.length === 3 && F1.game.gp.phase === 'free'`, 5000));
    await w.js(`window.__b0 = F1.game.bots.map(function (b) { return [b.car.state.x, b.car.state.z]; }); true`);
    await sleep(8000);                                       // (they leave their grid boxes one after the other, round our parked car)
    const bv = await w.js(`F1.game.bots.map(function (b, i) { return { kmh: Math.round(b.car.state.speed * 3.6), m: Math.round(Math.hypot(b.car.state.x - __b0[i][0], b.car.state.z - __b0[i][1])) }; })`);
    check('the computer drivers drive (km/h now, metres from their boxes after 8 s)', bv.length === 3 && bv.every(v => v.m > 30), bv);
    await w.shot('06-free-bots');
    // ---- a Grand Prix with computer drivers from the panel, on another track ----
    await w.key('Escape');
    await w.card('mc-1929');
    await w.click('#setup-mode [data-m="gp"]');
    await w.field('gp-q', '1'); await w.field('gp-r', '1');
    await w.click('#gp-wear button[data-w="2"]');
    const p4 = await w.js(`({ gp: __shown('setup-gp'), sub: __txt('setup-go-sub'), label: __txt('setup-go-label'), cur: F1.game.setup.current, bots: document.getElementById('gp-bots').value, built: F1.game.trackData.id })`);
    check('Monaco panel, mode 大獎賽: Q / R / wear shown, the line reads 大獎賽 ‧ 排位 1 圈 ‧ 正賽 1 圈, 3 bots kept, Silverstone still the loaded track', p4.gp && p4.sub === '大獎賽 ‧ 排位 1 圈 ‧ 正賽 1 圈' &&
      p4.label === '開始' && !p4.cur && p4.bots === '3' && p4.built === 'gb-1948', p4);
    await w.shot('07-panel-gp');
    await w.click('#setup-go');
    check('開始 (大獎賽): Monaco built, qualifying, driving, 3 computer drivers in the session', await w.until(`F1.game.running && F1.game.trackData.id === 'mc-1929' && F1.game.gp.phase === 'quali'`, 20000) &&
      await w.until(`F1.game.bots.length === 3 && F1.game.gp.snapshot.players.length === 4`, 3000), await w.js(`({ bots: F1.game.bots.length, players: F1.game.gp.snapshot && F1.game.gp.snapshot.players.length, wear: F1.game.gp.snapshot && F1.game.gp.snapshot.wear })`));
    // another card during the Grand Prix: the warning
    await w.key('Escape');
    await w.card('be-1925');
    check('another card during the Grand Prix: the panel warns 大獎賽進行中…', await w.js(`__shown('setup-note') && __txt('setup-note') === '大獎賽進行中：開始新的賽事會結束目前的大獎賽。'`), await w.js(`__txt('setup-note')`));
    await w.shot('08-panel-gp-warning');
    await w.key('Escape');
    check('Esc: the cards, the Grand Prix still on', await w.until(`F1.game.setup.show === 'tracks' && F1.game.gp.phase === 'quali'`, 1500));
    await w.key('Escape');
    check('Esc on the cards: back to qualifying', await w.until(`F1.game.running && F1.game.gp.phase === 'quali'`, 1500));
    await w.js(`F1.game.gp.action('skip'); true`);
    check('qualifying skipped: the grid', await w.until(`F1.game.gp.phase === 'grid'`, 3000));
    check('lights out: the race', await w.until(`F1.game.gp.phase === 'race'`, 15000));
    await sleep(1500);
    await w.js(`F1.game.gp.action('end'); true`);
    check('the race ended: the results with our car and the 3 computer drivers (AI tags)', await w.until(`F1.game.gp.phase === 'results'`, 3000) &&
      await w.until(`__shown('gp-results') && document.querySelectorAll('#gp-results-body .gp-ai').length >= 3`, 3000),
      await w.js(`({ ph: F1.game.gp.phase, rows: F1.game.gp.view().rows.map(function (r) { return r.bot ? 'AI ' + r.name : r.name; }) })`));
    await w.shot('09-results');
    check('results alone: 再來一場 / 結束 / 關閉 (no 回到大廳)', await w.js(`__shown('gp-res-again') && __shown('gp-res-end') && __shown('gp-close') && !__shown('gp-res-lobby')`));
    await w.click('#gp-res-end');
    check('結束: free practice on Monaco', await w.until(`F1.game.gp.phase === 'free' && F1.game.trackData.id === 'mc-1929'`, 3000));
    // the 大獎賽 tab with a track loaded: 在目前賽道開大獎賽…
    await w.key('Escape');
    await w.click('#tab-gp');
    check('大獎賽 tab: the hint and 在目前賽道開大獎賽… (no #gp-start / #gp-setup any more)', await w.js(`__shown('gp-open') && __txt('gp-hint') === '點一條賽道，在出發面板選「大獎賽」再按開始。' && !document.getElementById('gp-start') && !document.getElementById('gp-setup')`),
      await w.js(`__txt('gp-hint')`));
    await w.click('#gp-open');
    const p5 = await w.js(`({ show: F1.game.setup.show, track: F1.game.setup.trackId, mode: F1.game.setup.mode, label: __txt('setup-go-label') })`);
    check('在目前賽道開大獎賽…: the panel of the loaded track (Monaco), mode 大獎賽, 重新開始', p5.show === 'setup' && p5.track === 'mc-1929' && p5.mode === 'gp' && p5.label === '重新開始', p5);
    await w.click('#setup-mode [data-m="free"]');
    // the panel at other sizes (the Grand Prix fields shown: the tallest panel)
    await w.click('#setup-mode [data-m="gp"]');
    for (const [W, H] of [[1280, 720], [1920, 1080], [1100, 720], [1000, 700], [800, 600], [700, 700], [480, 800], [360, 740]]) {
      w.setContentSize(W, H);
      await sleep(450);
      const m = await w.js(LAYOUT('setup-go'));
      check('panel ' + W + 'x' + H + ': 開始 fully on screen and clickable, the toast clear of it, no horizontal scroll', layoutOk(m), m);
      await w.shot('10-panel-' + W + 'x' + H);
    }
    w.setContentSize(1280, 720);
    await sleep(300);
    await w.click('#setup-mode [data-m="free"]');
    await w.noErrors();
  } finally { closeAll([w]); }
}

/* ======================================================================================================== room */
async function partRoom() {
  const port = PORT;
  const H = makeWin('H'), A = makeWin('A'), B = makeWin('B'), C = makeWin('C');
  const all = [H, A, B], allJs = code => Promise.all(all.map(w => w.js(code)));
  try {
    const errs = await Promise.all([H, A, B, C].map(w => w.open()));
    check('four windows boot', errs.every(e => !e), errs);
    // ---- create / join: the lobby, nobody on a track ----
    check('H creates a room (in-game server)', await H.create('Hana', port));
    const srv = () => lastServer().srv;
    let s = await H.st();
    check('H: a fresh room: the lobby with the track picker open (its banner), not driving', s.show === 'picker' && !s.running && s.st === 'lobby' && s.rs === 0 &&
      await H.js(`__txt('track-lock') === '房間已建立。先幫房間選一條賽道（點卡片不會馬上開始）。' && __shown('track-lock')`), s);
    await H.shot('01-picker');
    check('A joins', await A.join('Alan', port));
    check('B joins', await B.join('Bea', port));
    await sleep(500);
    const rosters = await allJs(`F1.game.setup.players.map(function (p) { return p.id + ':' + p.name + (p.isHost ? '*' : ''); }).join(',')`);
    const sets = await allJs(`JSON.stringify(F1.net.room)`);
    const states = await Promise.all(all.map(w => w.st()));
    check('after create / join: all three in the lobby view, the same roster and the same room, nobody driving, no track built',
      rosters.every(r => r === rosters[0]) && rosters[0].split(',').length === 3 && sets.every(x => x === sets[0]) &&
      states.every(x => !x.running && !x.track && x.st === 'lobby') && states.slice(1).every(x => x.show === 'setup'), { rosters, states: states.map(x => [x.show, x.running, x.track, x.st]) });
    check('the guests: 準備 shown but disabled (no track yet), status 等待房主選擇賽道…', (await Promise.all([A, B].map(w => w.js(`document.getElementById('setup-ready').disabled && __shown('setup-ready') && __txt('setup-status') === '等待房主選擇賽道…'`)))).every(Boolean));
    await A.shot('02-lobby-no-track');
    // ---- the host sets the room up; the guests see each change within 0.5 s ----
    const seen = async (what, cond) => {
      const t0 = Date.now();
      const ok = await Promise.all([A, B].map(w => w.until(cond, 3000, what)));
      const ms = Date.now() - t0;
      check('the guests see ' + what + ' within 0.5 s (' + ms + ' ms)', ok.every(Boolean) && ms <= 500, ms);
    };
    await H.card('mc-1929');
    check('H: a card in the picker sets the room\'s track and closes the picker (nothing loads)', await H.until(`F1.game.setup.show === 'setup' && F1.net.room.set.track === 'mc-1929'`, 2000) &&
      await H.js(`!F1.game.track && !F1.game.running`));
    await seen('the track (Monaco)', `F1.net.room.set.track === 'mc-1929' && F1.game.setup.trackId === 'mc-1929' && __txt('setup-track-name').indexOf('摩納哥') >= 0`);
    check('nobody loads a track in the lobby', (await allJs(`!F1.game.track && !F1.game.running && F1.game.roomLoad === null`)).every(Boolean));
    await H.js(`(function () { var s = document.getElementById('setup-year'); s.value = '2014'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
    await seen('the season (2014) and their cars follow it', `F1.net.room.set.year === 2014 && F1.game.spec && F1.game.spec.year === 2014 && document.getElementById('setup-year').value === '2014'`);
    await H.click('#setup-mode [data-m="gp"]');
    await seen('the mode (大獎賽)', `F1.net.room.set.mode === 'gp' && F1.game.setup.mode === 'gp'`);
    await H.field('gp-q', '1');
    await seen('the qualifying laps (1)', `F1.net.room.set.q === 1 && document.getElementById('gp-q').value === '1'`);
    await H.field('gp-r', '2');
    await seen('the race laps (2)', `F1.net.room.set.r === 2 && document.getElementById('gp-r').value === '2'`);
    await H.click('#gp-wear button[data-w="3"]');
    await seen('the tyre wear (x3)', `F1.net.room.set.wear === 3`);
    await H.js(`(function () { var e = document.getElementById('gp-bots'); e.value = '3'; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await seen('3 computer drivers', `F1.net.room.set.bots === 3 && F1.game.setup.botList.length === 3`);
    await H.click('#gp-skill button[data-s="legend"]');
    await seen('their strength (傳奇)', `F1.net.room.set.skill === 'legend' && F1.game.setup.botSkill === 'legend'`);
    const ro = await Promise.all([A, B].map(w => w.js(`({ canEdit: F1.game.setup.canEdit, q: document.getElementById('gp-q').disabled, mode: document.querySelector('#setup-mode [data-m="free"]').disabled,
      year: document.getElementById('setup-year').disabled, bots: document.getElementById('gp-bots').disabled, pick: __shown('setup-track-btn'), note: __shown('setup-opts-note') })`)));
    check('the guests: the room settings read-only (由房主設定), no 換賽道', ro.every(x => !x.canEdit && x.q && x.mode && x.year && x.bots && !x.pick && x.note), ro);
    // a guest's own set / start / back / go: no effect (sent raw on his socket)
    const room0 = await H.js(`JSON.stringify(F1.net.room.set)`);
    await A.js(`(function () { var s = window.__sock; ['{"t":"set","track":"be-1925","mode":"free","q":5}', '{"t":"start","len":3337,"force":true}', '{"t":"back"}', '{"t":"go"}', '{"t":"bots","n":0}'].forEach(function (m) { s.send(m); }); return true; })()`);
    await sleep(400);
    check('a guest\'s raw set / start / back / go / bots change nothing', (await allJs(`JSON.stringify(F1.net.room.set) === ${J(room0)} && F1.net.room.st === 'lobby'`)).every(Boolean) &&
      J(srv().info().room.set) === room0, srv().info().room.set);
    // ---- cars, 準備 ----
    await A.click('#setup-car-change');
    await sleep(150);
    const carA = await A.js(`(function () { var c = document.querySelectorAll('#car-list .car-card')[2]; c.click(); return c.getAttribute('data-id'); })()`);
    await B.click('#setup-car-change');
    await sleep(150);
    const carB = await B.js(`(function () { var c = document.querySelectorAll('#car-list .car-card')[4]; c.click(); return c.getAttribute('data-id'); })()`);
    const aId = await A.js('F1.net.id'), bId = await B.js('F1.net.id'), hId = await H.js('F1.net.id');
    check('the guests pick their 2014 cars (H\'s roster shows them)', /^2014-/.test(carA) && /^2014-/.test(carB) &&
      await H.until(`(function () { var r = F1.net.roster; return r.some(function (p) { return p.id === ${aId} && p.car === ${J(carA)}; }) && r.some(function (p) { return p.id === ${bId} && p.car === ${J(carB)}; }); })()`, 3000), [carA, carB]);
    await A.click('#tab-gp');
    s = await H.st();
    check('H: nobody ready: 開始 disabled, 「不等了，直接開始」 offered', s.go.show && !s.go.enabled && s.force && await H.js(`document.getElementById('setup-go').disabled && __shown('setup-force')`), s.go);
    await A.click('#setup-ready');
    check('A presses 準備 (mouse): ready on every window', (await Promise.all(all.map(w => w.until(`F1.net.room.ready.indexOf(${aId}) >= 0 && F1.game.setup.players.some(function (p) { return p.id === ${aId} && p.ready; })`, 2000)))).every(Boolean) &&
      await A.js(`F1.game.setup.ready.on && document.getElementById('setup-ready').getAttribute('aria-pressed') === 'true'`));
    check('the lobby rows: A 準備好了 (data-state ready), B 還沒準備 (wait), H 房主', await H.until(`(function () { var a = document.querySelector('#setup-players .lobby-row[data-id="${aId}"] .lobby-st'), b = document.querySelector('#setup-players .lobby-row[data-id="${bId}"] .lobby-st'), h = document.querySelector('#setup-players .lobby-row[data-id="${hId}"] .lobby-st');
      return a && b && h && a.getAttribute('data-state') === 'ready' && b.getAttribute('data-state') === 'wait' && h.getAttribute('data-state') === 'host'; })()`, 2000));
    // 開始 while B is not ready: the button is disabled; a start without force is refused by the server
    check('H: 開始 still disabled while B is not ready (a click does nothing)', !(await H.click('#setup-go')) && (await H.st()).st === 'lobby');
    await H.js(`F1.net.startRoom({ len: 3337, force: false }); true`);
    check('a start without force while B is not ready: nostart not-ready [B] from the server, the room stays in the lobby', await H.until(`window.__ws.some(function (e) { return e.t === 'nostart' && e.why === 'not-ready' && e.wait && e.wait.length === 1 && e.wait[0] === ${bId}; })`, 2000) &&
      (await allJs(`F1.net.room.st === 'lobby' && !F1.game.running`)).every(Boolean));
    await sleep(1100);                                       // (START_MIN_MS counts accepted starts only; keep clear anyway)
    // B with the pad: A toggles 準備 on, A again off, A on
    await B.js(`__fakePad()`);
    await sleep(600);
    await B.pad(0);
    check('B: pad A toggles 準備 on', await B.until(`F1.net.room.ready.indexOf(${bId}) >= 0`, 2000));
    s = await H.st();
    check('H: everybody ready: 開始 enabled (focused), 不等了 gone', s.go.enabled && !s.force && await H.until(`!document.getElementById('setup-go').disabled && !__shown('setup-force')`, 1000),
      [s.go, await H.js(`document.activeElement && document.activeElement.id`)]);
    await H.shot('03-lobby-all-ready');
    await A.shot('03-lobby-ready');
    await B.pad(0);
    check('B: pad A again: 準備 off; H\'s 開始 disabled again', await B.until(`F1.net.room.ready.indexOf(${bId}) < 0`, 2000) && await H.until(`F1.game.setup.go.enabled === false && F1.game.setup.force`, 2000));
    await B.js(`window.__padOn = false; true`);
    // the wear does not clear 準備; the mode does (a toast)
    await H.click('#gp-wear button[data-w="2"]');
    await sleep(400);
    check('the host changes the tyre wear: A stays ready', await A.js(`F1.net.room.set.wear === 2 && F1.net.room.ready.indexOf(${aId}) >= 0`));
    await H.click('#setup-mode [data-m="free"]');
    check('the host changes the mode: A\'s 準備 cleared, A told 房主改了…請再按一次「準備」。', await A.until(`F1.net.room.ready.length === 0 && F1.net.room.set.mode === 'free'`, 2000) &&
      await A.until(`/^房主改了.*請再按一次「準備」。$/.test(__txt('hud-toast'))`, 1500), await A.js(`__txt('hud-toast')`));
    // ---- start 1: free practice, forced (B not ready), with B slow to load: the barrier ----
    await A.click('#setup-ready');
    await H.until(`F1.net.room.ready.indexOf(${aId}) >= 0`, 2000);
    await H.click('#setup-force');
    check('H: 不等了，直接開始 asks first, naming Bea', await H.until(`__shown('setup-confirm') && /Bea 還沒按準備。仍要開始嗎？/.test(__txt('setup-confirm-text'))`, 1000), await H.js(`__txt('setup-confirm-text')`));
    await H.shot('04-confirm');
    await H.click('#setup-force-no');
    check('再等等: the action block again, still the lobby', await H.until(`!__shown('setup-confirm') && __shown('setup-go')`, 1000) && (await H.st()).st === 'lobby');
    await B.js(HOLD_LOADED);                                 // B builds the track but the harness holds its report: the others wait
    await H.click('#setup-force');
    await sleep(100);
    const tStart = Date.now();
    await H.click('#setup-force-yes');
    check('仍要開始: the room loads (rs 1); B, not ready, is told 房主開始了：你還沒按準備，也一起載入。', await H.until(`F1.net.room.rs === 1`, 3000) &&
      await B.until(`window.__toasts.some(function (t) { return t[1] === '房主開始了：你還沒按準備，也一起載入。'; })`, 5000), await B.js(`window.__toasts.slice(-3)`));
    check('H and A: the loading screen, B waited for (載入中), not driving', (await Promise.all([H, A].map(w => w.until(`__shown('room-loading') && F1.net.loadedRs === 1 && !F1.game.running &&
      document.querySelector('#room-loading-list .rl-row[data-id="${bId}"]') && document.querySelector('#room-loading-list .rl-row[data-id="${bId}"]').getAttribute('data-state') === 'wait'`, 6000)))).every(Boolean),
      await H.js(`({ st: F1.net.room.st, load: F1.net.room.load, rows: [].map.call(document.querySelectorAll('#room-loading-list .rl-row'), function (r) { return r.getAttribute('data-id') + ':' + r.getAttribute('data-state'); }) })`));
    check('H (loaded): 不等了，開始 and 取消，回到大廳 offered; A: neither', await H.js(`__shown('room-loading-go') && __shown('room-loading-cancel') && __shown('room-loading-leave')`) &&
      await A.js(`!__shown('room-loading-go') && !__shown('room-loading-cancel') && __shown('room-loading-leave')`));
    check('B built the track (its report held)', await B.until(`window.__held !== null && !F1.game.running && __shown('room-loading')`, 15000));
    await sleep(1500);
    check('1.5 s later: still nobody driving, the room loading (the barrier waits for B)', (await allJs(`!F1.game.running && F1.net.room.st === 'loading'`)).every(Boolean));
    await H.shot('05-loading');
    await A.shot('05-loading');
    const tRel = Date.now();
    await B.js(`window.__release(); true`);
    const started = await Promise.all(all.map(w => w.until(`F1.game.running && F1.net.room.st === 'session'`, 25000).then(ok => ({ ok, t: Date.now() - tRel }))));
    check('free practice: all three drive once B has reported its track (' + J(started.map(x => x.t)) + ' ms after)', started.every(x => x.ok) && started.every(x => x.t < 1500), started);
    const ev1 = await allJs(`(function () { var g = window.__ev.filter(function (e) { return e.n === 'go'; }).pop(); var l = window.__ev.filter(function (e) { return e.n === 'load'; }).pop(); return { go: g && g.wall, load: l && l.wall }; })()`);
    check('the session began on all three windows together (go events within 100 ms)', ev1.every(e => e.go) && spread(ev1.map(e => e.go)) <= 100, ev1.map(e => e.go - ev1[0].go));
    const wire1 = await allJs(`(function () { var bad = window.__ws.filter(function (e) { return (e.d === 'out' && (e.t === 's' || e.t === 'bs' || e.t === 'lap' || e.t === 'gl' || e.t === 'hit') && e.st !== 'session') ||
      (e.d === 'in' && e.t === 'snap' && e.st !== 'session'); }); return { bad: bad.length, first: bad[0] || null, sOut: window.__ws.filter(function (e) { return e.d === 'out' && e.t === 's'; }).length }; })()`);
    check('the barrier on the wire: no car state sent and no car snapshot received outside the session, on any window', wire1.every(x => x.bad === 0), wire1);
    const log1 = lastServer().log.map(x => x[1]);
    check('the server: start rs=1 ... mode=free, room loading, go (all loaded), room session', log1.some(l => /^start rs=1 track=mc-1929 mode=free/.test(l)) && log1.some(l => /^go +\(all loaded\) rs=1/.test(l)),
      log1.filter(l => /^(start|room|go|loaded)/.test(l)));
    await sleep(1500);
    const remote = await allJs(`Object.keys(F1.game.remoteModels).length`);
    check('each window sees the other two cars (the guests also the 3 computer drivers of the host)', remote[0] === 2 && remote[1] === 5 && remote[2] === 5, remote);
    check('the 3 computer drivers: simulated by H, seen by the guests', await H.js(`F1.game.bots.length === 3`) && (await Promise.all([A, B].map(w => w.until(`F1.net.roster.filter(function (p) { return p.bot; }).length === 3`, 2000)))).every(Boolean));
    await A.shot('06-driving');
    // Esc: the room menu during the session; Esc again drives
    await A.key('Escape');
    check('A: Esc: the room menu (自由練習中, 繼續駕駛, no 回到大廳 for a guest)', await A.until(`!F1.game.running && F1.game.setup.show === 'setup' && __txt('setup-state') === '自由練習中' && __shown('setup-resume') && !__shown('setup-lobby')`, 1500));
    await A.shot('07-room-menu');
    await A.key('Escape');
    check('A: Esc again: driving', await A.until(`F1.game.running`, 1500));
    // 回到大廳 (free practice: no question)
    await H.key('Escape');
    check('H: Esc: the room menu with 回到大廳', await H.until(`__shown('setup-lobby') && __shown('setup-resume')`, 1500));
    await H.click('#setup-lobby');
    const back1 = await Promise.all(all.map(w => w.until(`!F1.game.running && F1.net.room.st === 'lobby' && F1.game.setup.st === 'lobby' && F1.net.room.ready.length === 0`, 3000)));
    check('回到大廳: all three in the lobby, off the track, ready cleared', back1.every(Boolean), back1);
    check('the guests are told 房主回到房間大廳', (await Promise.all([A, B].map(w => w.until(`__txt('hud-toast') === '房主回到房間大廳'`, 1500)))).every(Boolean));
    check('the track stays loaded in the lobby (the next start on it is instant)', (await allJs(`F1.game.trackData && F1.game.trackData.id === 'mc-1929'`)).every(Boolean));
    await all.reduce((p, w) => p.then(() => w.js(`window.__t0 = F1.game.track; true`)), Promise.resolve());
    // ---- start 2: a Grand Prix with the 3 computer drivers, everybody ready, 開始 by mouse ----
    await H.click('#setup-mode [data-m="gp"]');
    await H.field('gp-q', '1'); await H.field('gp-r', '2');
    await Promise.all([A, B].map(w => w.until(`F1.net.room.set.mode === 'gp' && F1.net.room.set.r === 2`, 2000)));
    await A.click('#setup-ready'); await B.click('#setup-ready');
    check('H: everybody ready: 開始 enabled', await H.until(`F1.game.setup.go.enabled && !F1.game.setup.force`, 3000));
    const sid0 = await H.js(`F1.game.gp.sid`);
    await sleep(1100);                                       // (START_MIN_MS after 回到大廳)
    await H.click('#setup-go');
    const q = await Promise.all(all.map(w => w.until(`F1.game.running && F1.game.gp.phase === 'quali'`, 25000)));
    check('Grand Prix: all three in qualifying after the barrier', q.every(Boolean), await Promise.all(all.map(w => w.st())));
    const order = await allJs(`(function () { var i0 = -1, i1 = -1, i2 = -1; window.__ws.forEach(function (e, i) { if (e.d !== 'in') return;
      if (e.t === 'room' && e.rst === 'loading' && e.rrs === 2 && i0 < 0) i0 = i; if (e.t === 'room' && e.rst === 'session' && e.rrs === 2 && i1 < 0) i1 = i; if (e.t === 'gp' && e.ph === 'quali' && i2 < 0 && i0 >= 0) i2 = i; });
      return { loading: i0, session: i1, quali: i2 }; })()`);
    check('qualifying began only after the barrier: room loading -> room session -> gp quali, in that order on every window', order.every(o => o.loading >= 0 && o.session > o.loading && o.quali > o.session), order);
    const g = await Promise.all(all.map(w => w.js(`({ sid: F1.game.gp.sid, ph: F1.game.gp.phase, off: F1.game.gp.now() - Date.now(), same: F1.game.track === window.__t0, n: F1.game.gp.snapshot.players.length })`)));
    check('every window: the same new session (sid), qualifying, the session clocks agree within 50 ms, 3 humans + 3 bots, the track not rebuilt',
      g.every(x => x.sid === g[0].sid && x.ph === 'quali' && x.same && x.n === 6) && g[0].sid !== sid0 && spread(g.map(x => x.off)) <= 50, g);
    const wire2 = await allJs(`window.__ws.filter(function (e) { return ((e.d === 'out' && (e.t === 's' || e.t === 'bs' || e.t === 'gl' || e.t === 'lap')) || (e.d === 'in' && e.t === 'snap')) && e.st !== 'session'; }).length`);
    check('the barrier on the wire (Grand Prix): no state / lap out, no snapshot in, outside the session', wire2.every(n => n === 0), wire2);
    await sleep(800);
    await B.shot('08-quali');
    // the race: skip qualifying, lights out
    await H.js(`F1.game.gp.action('skip'); true`);
    check('qualifying skipped: the grid on all three', (await Promise.all(all.map(w => w.until(`F1.game.gp.phase === 'grid'`, 4000)))).every(Boolean));
    check('lights out: the race on all three', (await Promise.all(all.map(w => w.until(`F1.game.gp.phase === 'race'`, 15000)))).every(Boolean));
    // ---- the latecomer C joins during the race ----
    await C.js(PAGE_LIB);
    check('C joins during the race', await C.join('Cara', port));
    check('C: loads Monaco and watches the race (a spectator: driving view, not classified)', await C.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === 'mc-1929' && F1.game.gp.phase === 'race' && !F1.game.gp.taking`, 20000),
      await C.st());
    await sleep(1000);
    await C.shot('09-spectator');
    await H.js(`F1.game.gp.action('end'); true`);
    check('the race ended: the results on all four windows', (await Promise.all([H, A, B, C].map(w => w.until(`F1.game.gp.phase === 'results'`, 5000)))).every(Boolean));
    const res = await Promise.all([H, A, B, C].map(w => w.js(`F1.game.gp.view().rows.map(function (r) { return (r.bot ? 'AI ' : '') + r.name; }).join(',')`)));
    check('the results: the same 6 rows (3 humans + 3 AI) on every window', res.every(r => r === res[0]) && res[0].split(',').length === 6 && (res[0].match(/AI /g) || []).length === 3, res[0]);
    await sleep(800);
    check('H: the results offer 再來一場 / 回到大廳 (no 結束)', await H.until(`__shown('gp-res-again') && __shown('gp-res-lobby') && !__shown('gp-res-end')`, 2000));
    check('the guests: 等待房主選擇再來一場或回到大廳, no host buttons', (await Promise.all([A, B].map(w => w.js(`__txt('gp-results-note') === '等待房主選擇再來一場或回到大廳' && !__shown('gp-res-lobby') && !__shown('gp-res-again')`)))).every(Boolean));
    await H.shot('10-results');
    await A.shot('10-results');
    // 再來一場: qualifying again, the same track, no rebuild
    const sid1 = await H.js(`F1.game.gp.sid`);
    await H.click('#gp-res-again');
    const again = await Promise.all([H, A, B, C].map(w => w.until(`F1.game.gp.phase === 'quali' && F1.game.running && F1.game.gp.sid !== ${sid1}`, 6000)));
    check('再來一場: qualifying again on all four (the latecomer too), the same track object', again.every(Boolean) && (await allJs(`F1.game.track === window.__t0`)).every(Boolean) &&
      (await H.js(`F1.net.room.st === 'session' && F1.net.room.rs === 2`)), again);
    await H.js(`F1.game.gp.action('skip'); true`);
    await H.until(`F1.game.gp.phase === 'race'`, 15000);
    await sleep(300);
    await H.js(`F1.game.gp.action('end'); true`);
    await H.until(`F1.game.gp.phase === 'results'`, 5000);
    await sleep(500);
    await H.click('#gp-res-lobby');
    const back2 = await Promise.all([H, A, B, C].map(w => w.until(`!F1.game.running && F1.net.room.st === 'lobby' && F1.game.setup.st === 'lobby' && F1.game.setup.show === 'setup'`, 4000)));
    check('回到大廳 from the results: all four in the lobby (the latecomer too), ready cleared', back2.every(Boolean) && (await H.js(`F1.net.room.ready.length`)) === 0, back2);
    await sleep(300);
    const toasts = await Promise.all([H, A, B, C].map(w => w.js(`__txt('hud-toast') || ''`)));
    check('no 回到自由練習 toast in the lobby', toasts.every(t => !/回到自由練習/.test(t)), toasts);
    check('C in the lobby: a guest, 準備 off', await C.js(`!F1.net.isHost && F1.game.setup.ready.show && !F1.game.setup.ready.on`));
    await C.shot('11-lobby-after-gp');
    // ---- the lobby at other sizes (a guest's 準備, the host's 開始) ----
    for (const [W, Hh] of [[1920, 1080], [1100, 720], [1000, 700], [800, 600], [700, 700], [480, 800]]) {
      B.setContentSize(W, Hh); H.setContentSize(W, Hh);
      await sleep(450);
      const mb = await B.js(LAYOUT('setup-ready')), mh = await H.js(LAYOUT('setup-go'));
      check('lobby ' + W + 'x' + Hh + ': 準備 (guest) and 開始 (host) fully on screen and clickable, the toast clear, no horizontal scroll', layoutOk(mb) && layoutOk(mh), { guest: mb, host: mh });
      await B.shot('12-lobby-' + W + 'x' + Hh);
      await H.shot('12-lobby-' + W + 'x' + Hh);
    }
    B.setContentSize(1280, 720); H.setContentSize(1280, 720);
    await sleep(300);
    for (const w of [H, A, B, C]) await w.noErrors();
    // ---- the host leaves in the lobby ----
    await H.click('#setup-leave');
    const gone = await Promise.all([A, B, C].map(w => w.until(`!F1.net.connected && F1.game.setup && F1.game.setup.show === 'tracks' && !F1.game.setup.room`, 5000)));
    const tt = await Promise.all([A, B, C].map(w => w.js(`__txt('hud-toast')`)));
    check('the host left in the lobby: A, B and C back to the single-player cards, told 房主關閉了房間，已回到單人模式', gone.every(Boolean) && tt.every(t => t === '房主關閉了房間，已回到單人模式'), { gone, tt });
    check('... not driving', (await Promise.all([A, B, C].map(w => w.js(`!F1.game.running`)))).every(Boolean));
    await A.shot('13-host-left');
  } finally { closeAll([H, A, B, C]); }
}

/* ======================================================================================================== leave */
async function partLeave() {
  const port = PORT + 1;
  const H = makeWin('H'), A = makeWin('A'), B = makeWin('B');
  try {
    const errs = await Promise.all([H, A, B].map(w => w.open()));
    check('three windows boot', errs.every(e => !e), errs);
    // ---- a guest leaves while the others wait for him ----
    check('H creates, A and B join', await H.create('Hana', port) && await A.join('Alan', port) && await B.join('Bea', port));
    await H.card('gb-1948');
    await Promise.all([A, B].map(w => w.until(`F1.net.room.set.track === 'gb-1948'`, 2000)));
    await A.click('#setup-ready'); await B.click('#setup-ready');
    await H.until(`F1.game.setup.go.enabled`, 3000);
    await A.js(HOLD_LOADED);
    const aId = await A.js('F1.net.id');
    await H.click('#setup-go');
    check('A builds Silverstone but has not reported it: H and B wait for A', await H.until(`F1.net.room.st === 'loading' && F1.net.room.load.done.length === 2 && F1.net.room.load.wait.length === 1 && F1.net.room.load.wait[0] === ${aId}`, 15000) &&
      await A.until(`window.__held !== null`, 15000), await H.js(`F1.net.room.load`));
    await sleep(500);
    check('H, B: still on the loading screen, not driving', (await Promise.all([H, B].map(w => w.js(`__shown('room-loading') && !F1.game.running && F1.net.room.st === 'loading'`)))).every(Boolean));
    await B.shot('01-wait-for-A');
    await A.click('#room-loading-leave');
    check('A leaves from the loading screen: alone, the cards, no loading screen', await A.until(`!F1.net.connected && F1.game.setup.show === 'tracks' && !__shown('room-loading')`, 4000), await A.st());
    check('H and B: the barrier completes without A, both drive (free practice)', (await Promise.all([H, B].map(w => w.until(`F1.game.running && F1.net.room.st === 'session'`, 5000)))).every(Boolean));
    check('the server: go (all loaded) once A was gone', lastServer().log.some(x => /^go +\(all loaded\) rs=1/.test(x[1])), lastServer().log.map(x => x[1]).filter(l => /^(go|leave|room)/.test(l)));
    // ---- the host leaves during loading while a guest still loads ----
    await H.key('Escape');
    await H.click('#setup-lobby');
    await Promise.all([H, B].map(w => w.until(`F1.net.room.st === 'lobby'`, 3000)));
    await H.click('#setup-track-btn');
    await H.card('mc-1929');
    await B.until(`F1.net.room.set.track === 'mc-1929'`, 2000);
    await B.click('#setup-ready');
    await H.until(`F1.game.setup.go.enabled`, 3000);
    await B.js(HOLD_LOADED);
    await sleep(1100);
    await H.click('#setup-go');
    check('B builds Monaco and holds its report; H loaded', await H.until(`F1.net.room.st === 'loading' && F1.net.loadedRs === F1.net.room.rs`, 15000) && await B.until(`window.__held !== null`, 15000));
    await H.shot('02-host-before-leaving');
    await H.click('#room-loading-leave');
    check('the host left during loading: B back to the single-player cards, told, no loading screen, not driving',
      await B.until(`!F1.net.connected && F1.game.setup.show === 'tracks' && !__shown('room-loading') && !F1.game.running`, 5000) &&
      await B.until(`__txt('hud-toast') === '房主關閉了房間，已回到單人模式'`, 2000), await B.st());
    await B.shot('03-host-left-loading');
    await B.js(`window.__release = null; true`);
    // ---- the host leaves during loading as the last one loading: no session may start for the guests ----
    await sleep(500);
    check('H creates again, A and B join', await H.create('Hana', port) && await A.join('Alan', port) && await B.join('Bea', port));
    await H.card('it-1922');
    await Promise.all([A, B].map(w => w.until(`F1.net.room.set.track === 'it-1922'`, 2000)));
    await A.click('#setup-ready'); await B.click('#setup-ready');
    await H.until(`F1.game.setup.go.enabled`, 3000);
    await H.js(HOLD_LOADED);
    const n0 = await Promise.all([A, B].map(w => w.js(`[window.__ws.length, window.__ev.length]`)));
    await H.click('#setup-go');
    check('A and B loaded Monza; H (the host) built it but has not reported: the barrier waits for H only', await A.until(`F1.net.room.st === 'loading' && F1.net.room.load.done.length === 2 && F1.net.room.load.wait.length === 1 && F1.net.room.load.wait[0] === F1.net.hostId`, 15000) &&
      await H.until(`window.__held !== null`, 15000), await A.js(`F1.net.room.load`));
    await H.click('#room-loading-leave');
    const back = await Promise.all([A, B].map(w => w.until(`!F1.net.connected && F1.game.setup.show === 'tracks' && !__shown('room-loading')`, 5000)));
    await sleep(300);
    const after = await Promise.all([A, B].map((w, i) => w.js(`({ running: F1.game.running, toast: __txt('hud-toast'), session: window.__ws.slice(${n0[i][0]}).filter(function (e) { return e.t === 'room' && e.rst === 'session'; }).length,
      go: window.__ev.slice(${n0[i][1]}).filter(function (e) { return e.n === 'go'; }).length })`)));
    check('A and B: back to the cards with the toast; no session started (no room session message, no go, not driving) although the host was the last one loading',
      back.every(Boolean) && after.every(x => !x.running && x.session === 0 && x.go === 0 && x.toast === '房主關閉了房間，已回到單人模式'), after);
    for (const w of [H, A, B]) await w.noErrors();
  } finally { closeAll([H, A, B]); }
}

/* ======================================================================================================== ded */
async function partDed() {
  const port = PORT + 2;
  const out = [];
  const child = cp.spawn('node', [path.join(ROOT, 'net', 'server.js'), String(port)], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => { if (l.trim()) out.push(l.replace(/^\d\d:\d\d:\d\d /, '')); }));
  child.stderr.on('data', d => out.push('ERR ' + String(d).trim()));
  child.on('error', e => out.push('ERR spawn: ' + e.message));
  const A = makeWin('A'), B = makeWin('B'), C = makeWin('C');
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !out.some(l => /listening/.test(l))) await sleep(100);
    check('node net/server.js ' + port + ' listening; its start-up line describes the lobby', out.some(l => /listening on 0\.0\.0\.0:/.test(l)) && out.some(l => /The first player to join is the host: he sets the room up in the lobby/.test(l)), out.slice(0, 3));
    const errs = await Promise.all([A, B, C].map(w => w.open()));
    check('three windows boot', errs.every(e => !e), errs);
    check('A joins first', await A.join('Ann', port));
    await sleep(300);
    let s = await A.st();
    check('A is the host (the first player): the picker of a fresh room, 你是房主（第一位進房的玩家）…', s.host && s.show === 'picker' && /你是房主（第一位進房的玩家）/.test(await A.js(`__txt('mp-status')`)), [s.show, s.host, await A.js(`__txt('mp-status')`)]);
    check('B and C join (guests)', await B.join('Ben', port) && await C.join('Cid', port) && !(await B.js('F1.net.isHost')) && !(await C.js('F1.net.isHost')));
    await A.card('it-1922');
    await A.js(`(function () { var e = document.getElementById('gp-bots'); e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    check('A sets Monza and 2 computer drivers: B and C see them', (await Promise.all([B, C].map(w => w.until(`F1.net.room.set.track === 'it-1922' && F1.game.setup.botList.length === 2`, 4000)))).every(Boolean));
    await B.click('#setup-ready');
    await A.until(`F1.net.room.ready.length === 1`, 2000);
    // ---- migration in the lobby ----
    await A.click('#setup-leave');
    check('A left in the lobby: B (the longest-connected) is the host, told 你現在是房主…', await B.until(`F1.net.isHost`, 5000) && await B.until(`/你現在是房主/.test(__txt('hud-toast'))`, 2000), await B.js(`__txt('hud-toast')`));
    check('the room\'s settings survive: Monza, 2 computer drivers (B\'s game makes them), B no longer listed as ready', await B.until(`F1.net.room.set.track === 'it-1922' && F1.net.room.set.bots === 2 && F1.game.setup.botList.length === 2 && F1.net.room.ready.length === 0 && F1.game.setup.go.show`, 4000),
      await B.js(`({ set: F1.net.room.set, ready: F1.net.room.ready, bots: F1.game.setup.botList.length })`));
    check('C sees B as the host and the 2 computer drivers', await C.until(`F1.net.hostId === ${await B.js('F1.net.id')} && F1.game.setup.botList.length === 2`, 3000));
    await B.shot('01-new-host');
    check('A joins again: a guest now', await A.join('Ann', port) && !(await A.js('F1.net.isHost')) && await A.until(`F1.game.setup.show === 'setup' && F1.game.setup.ready.show`, 2000));
    // ---- migration during loading: A is slow (his page busy 9 s in the build), C holds its report, the host B leaves ----
    await A.click('#setup-ready'); await C.click('#setup-ready');
    await B.until(`F1.game.setup.go.enabled`, 3000);
    await C.js(HOLD_LOADED);
    const cId = await C.js('F1.net.id'), aId2 = await A.js('F1.net.id');
    await A.js(SLOW_BUILD(9000));                            // (A is not queried until it is done)
    await B.click('#setup-go');
    check('loading: B (host) loaded; C built the track but holds its report; A still building', await B.until(`F1.net.room.st === 'loading' && F1.net.room.load.done.length === 1 && F1.net.loadedRs === F1.net.room.rs`, 15000) &&
      await C.until(`window.__held !== null`, 15000) && await B.js(`F1.net.room.load.wait.indexOf(${aId2}) >= 0`), await B.js(`F1.net.room.load`));
    await B.click('#room-loading-leave');
    check('B (host) left during loading: C (the longest-connected now) is the host, the room still loading', await C.until(`F1.net.isHost && F1.net.room.st === 'loading'`, 4000),
      await C.js(`({ host: F1.net.isHost, st: F1.net.room.st, load: F1.net.room.load })`));
    check('C (not loaded yet): no 不等了，開始 yet; 取消，回到大廳 offered', await C.until(`__shown('room-loading') && !__shown('room-loading-go') && __shown('room-loading-cancel')`, 2000));
    await C.shot('02-new-host-loading');
    await C.js(`window.__release(); true`);
    check('C reported its track: 不等了，開始 offered to the new host, A still waited for', await C.until(`__shown('room-loading-go') && F1.net.room.load && F1.net.room.load.wait.length === 1 && F1.net.room.load.wait[0] === ${aId2}`, 3000),
      await C.js(`F1.net.room.load`));
    await C.shot('03-new-host-go');
    await C.click('#room-loading-go');
    check('不等了，開始: C drives (free practice) while A still builds; the field starts without the bots of the old host', await C.until(`F1.game.running && F1.net.room.st === 'session'`, 4000) &&
      (await C.js(`F1.game.bots.length`)) === 0, await C.js(`({ run: F1.game.running, bots: F1.game.bots.length, ready: F1.net.roster.map(function (p) { return p.id + ':' + p.load; }) })`));
    check('A, slow, has his track built later: he drives in the session at once', await A.until(`F1.game.running && F1.net.room.st === 'session' && F1.net.loadedRs === F1.net.room.rs`, 15000), await A.st());
    // the new host can go back and start again
    await C.key('Escape');
    await C.click('#setup-lobby');
    await Promise.all([A, C].map(w => w.until(`F1.net.room.st === 'lobby' && !F1.game.running`, 3000)));
    await C.click('#setup-mode [data-m="gp"]');
    await C.field('gp-q', '1'); await C.field('gp-r', '1');
    await A.until(`F1.net.room.set.mode === 'gp'`, 2000);
    await A.click('#setup-ready');
    await C.until(`F1.game.setup.go.enabled`, 3000);
    await sleep(1100);
    await C.click('#setup-go');
    check('the new host starts a Grand Prix: A and C in qualifying with the 2 computer drivers', (await Promise.all([A, C].map(w => w.until(`F1.game.running && F1.game.gp.phase === 'quali'`, 20000)))).every(Boolean) &&
      await A.until(`F1.game.gp.snapshot.players.length === 4`, 3000), await A.js(`F1.game.gp.snapshot && F1.game.gp.snapshot.players.map(function (p) { return p.name; })`));
    await A.shot('03-quali');
    const L = out.join('\n');
    check('the server log: host migrations, start / room loading / go / room session lines', /host +#\d+/.test(L) && /start rs=1 track=it-1922 mode=free/.test(L) && /room +loading/.test(L) &&
      /go +\(host\) rs=1/.test(L) && /room +session/.test(L) && /start rs=2 track=it-1922 mode=gp q=1 r=1/.test(L), out.filter(l => /^(host|start|room|go|loaded)/.test(l)));
    for (const w of [A, B, C]) await w.noErrors();
  } finally {
    closeAll([A, B, C]);
    try { child.kill(); } catch (e) {}
  }
}

/* ======================================================================================================== proto */
async function partProto() {
  const port = PORT + 3, stubPort = PORT + 4;
  const srv = await createServer0({ port, host: '127.0.0.1' });
  const raw = hello => new Promise(resolve => {
    const ws = new WS('ws://127.0.0.1:' + port), got = [];
    ws.on('message', d => got.push(JSON.parse(String(d))));
    ws.on('open', () => ws.send(J(Object.assign({ t: 'hello', name: 'old', colour: '#123456' }, hello))));
    ws.on('close', code => resolve({ code, got }));
    ws.on('error', () => {});
    setTimeout(() => { try { ws.terminate(); } catch (e) {} resolve({ code: 'timeout', got }); }, 3000);
  });
  for (const [what, h] of [['{v: 1}', { v: 1 }], ['{v: \'2\'}', { v: '2' }], ['no v', {}]]) {
    const r = await raw(h);
    check('a raw hello ' + what + ': error version need 2, closed 1008', r.code === 1008 && r.got.length === 1 && r.got[0].t === 'error' && r.got[0].code === 'version' && r.got[0].need === 2, r);
  }
  const ok = await raw({ v: 2 });
  check('a raw hello {v: 2}: welcome with the lobby (no track / seq / year fields)', ok.got[0] && ok.got[0].t === 'welcome' && ok.got[0].v === 2 && ok.got[0].room && ok.got[0].room.st === 'lobby' &&
    !('track' in ok.got[0]) && !('seq' in ok.got[0]) && !('year' in ok.got[0]), ok.got[0]);
  await srv.close();
  // a stub server: protocol 1 (v7.1: error version without need), then a newer one (need 3)
  let need = null;
  const wss = new WS.Server({ port: stubPort, host: '127.0.0.1' });
  wss.on('connection', ws => ws.on('message', () => { ws.send(J(need === null ? { t: 'error', code: 'version' } : { t: 'error', code: 'version', need })); ws.close(1008, 'version'); }));
  const W = makeWin('P');
  try {
    check('a window boots', !(await W.open()));
    for (const [n, text] of [[null, '房間的遊戲版本比較舊（F1Drive v7.1 以前），請房主更新到 v7.2 以上。'], [3, '你的遊戲版本比較舊，請更新後再加入。'], [1, '遊戲版本與房間不同，無法加入。']]) {
      need = n;
      await W.field('mp-name', 'Pat'); await W.click('#tab-mp'); await W.field('mp-addr', '127.0.0.1:' + stubPort);
      await W.click('#mp-join');
      const shown = await W.until(`__txt('mp-status') === ${J(text)}`, 4000);
      check('joining a server that answers version' + (n === null ? ' without need (protocol 1)' : ' need ' + n) + ': 「' + text + '」, still alone on the cards', shown && await W.js(`!F1.net.connected && F1.game.setup.show === 'tracks'`),
        await W.js(`__txt('mp-status')`));
      if (n === null) await W.shot('01-old-server');
    }
    await W.noErrors();
  } finally {
    closeAll([W]);
    await new Promise(r => wss.close(r));
  }
}

/* ======================================================================================================== early */
// The lobby review (2026-10-03): LOBBY-1 the server drops the host's go / back within 1 s (START_MIN_MS) of the last one
// it took, without an answer: a click that early did nothing and said nothing (js/main.js now holds it for the rest of
// that second). LOBBY-2 a double click on 開始 over a slow link sent two starts: nostart state, 「現在無法開始」 over the
// loading screen (js/main.js now sends one start until its answer).

// a raw ws guest (this process): joins, says ready whenever the room is in the lobby, never reports a track (the barrier
// waits for it)
function rawGuest(port, name) {
  return new Promise((resolve, reject) => {
    const ws = new WS('ws://127.0.0.1:' + port);
    const g = { ws, id: 0 };
    g.send = o => { try { ws.send(J(o)); } catch (e) {} };
    ws.on('message', d => {
      const m = JSON.parse(String(d));
      if (m.t === 'welcome') { g.id = m.id; resolve(g); if (m.room && m.room.st === 'lobby') g.send({ t: 'ready', on: true }); }
      if (m.t === 'room' && m.st === 'lobby' && !(m.ready || []).includes(g.id)) g.send({ t: 'ready', on: true });
    });
    ws.on('open', () => g.send({ t: 'hello', v: 2, name: name, colour: '#33aa55' }));
    ws.on('error', e => reject(e));
    setTimeout(() => reject(new Error('raw guest: no welcome')), 5000);
  });
}
// a TCP proxy that delays every chunk by oneWayMs in each direction (an internet link of RTT 2 * oneWayMs)
function delayProxy(listenPort, targetPort, oneWayMs) {
  return new Promise(resolve => {
    const srv = nodeNet.createServer(c => {
      const up = nodeNet.connect(targetPort, '127.0.0.1');
      const pipe = (from, to) => from.on('data', d => setTimeout(() => { try { to.write(d); } catch (e) {} }, oneWayMs));
      pipe(c, up); pipe(up, c);
      const end = () => { try { c.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
      c.on('close', end); up.on('close', end); c.on('error', end); up.on('error', end);
    });
    srv.listen(listenPort, '127.0.0.1', () => resolve(srv));
  });
}
// a real double click: two press / release pairs gapMs apart (clickCount 1 then 2)
async function dblClick(w, sel, gapMs) {
  const r = await w.js(`(function () { var e = document.querySelector(${J(sel)}); var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const x = Math.round(r.x), y = Math.round(r.y);
  w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(gapMs);
  w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
  w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
}
// the window's wire since index i (no car states / snapshots / rosters / pings): 'out:back', 'in:room:lobby', 'in:nostart:state' ...
const wireSince = (w, i) => w.js(`__ws.slice(${i}).filter(function (e) { return e.t !== 'snap' && e.t !== 's' && e.t !== 'bs' && e.t !== 'ping' && e.t !== 'pong' && e.t !== 'players' && e.t !== 'gp'; })
  .map(function (e) { return e.d + ':' + e.t + (e.rst ? ':' + e.rst : '') + (e.why ? ':' + e.why : ''); })`);
const toastsSince = (w, i) => w.js(`__toasts.slice(${i}).map(function (t) { return t[1]; })`);
const count = (wire, re) => wire.filter(x => re.test(x)).length;

async function partEarly() {
  // ---- LOBBY-1: an in-game host with a raw guest that is ready (and never loads) ----
  const port = PORT + 5;
  const H = makeWin('H');
  let G = null;
  try {
    check('host window boots', !(await H.open()));
    check('H creates a room; Monza; a raw guest joins and is ready: 開始 enabled', await H.create('Hana', port) && await H.until(`F1.game.setup.show === 'picker'`, 3000) &&
      await H.card('it-1922') && await H.until(`F1.net.room.set.track === 'it-1922'`, 3000) && !!(G = await rawGuest(port, 'Guest')) &&
      await H.until(`F1.net.room.ready.length === 1 && F1.game.setup.go.enabled`, 3000));
    // 開始, then 取消，回到大廳 as soon as it shows
    let ti = await H.js('__toasts.length'), wi = await H.js('__ws.length');
    let t0 = Date.now();
    await H.click('#setup-go');
    await H.until(`__shown('room-loading-cancel')`, 3000, '取消 shown');
    const c1 = await H.click('#room-loading-cancel'), tc1 = Date.now() - t0;
    check('LOBBY-1: 取消，回到大廳 clicked ' + tc1 + ' ms after 開始 (inside the server\'s second): ONE click takes the room back to the lobby, the loading screen goes',
      c1 && tc1 < 1000 && await H.until(`F1.net.room.st === 'lobby' && !__shown('room-loading') && F1.game.setup.show === 'setup'`, 2500), await H.st());
    let wire = await wireSince(H, wi), toasts = await toastsSince(H, ti);
    check('LOBBY-1: ... one back on the wire, no nostart, no toast', count(wire, /^out:back$/) === 1 && !count(wire, /nostart/) && toasts.length === 0, { wire, toasts });
    // the same track (built at once), 開始, 不等了，開始 as soon as it shows
    check('H\'s Monza build is done (kept for the next start)', await H.until(`F1.game.trackData && F1.game.trackData.id === 'it-1922'`, 20000));
    await H.until(`F1.net.room.ready.length === 1 && F1.game.setup.go.enabled`, 3000);
    await sleep(1100);
    ti = await H.js('__toasts.length'); wi = await H.js('__ws.length');
    t0 = Date.now();
    await H.click('#setup-go');
    await H.until(`__shown('room-loading-go')`, 3000, '不等了 shown');
    const c2 = await H.click('#room-loading-go'), tc2 = Date.now() - t0;
    check('LOBBY-1: 不等了，開始 clicked ' + tc2 + ' ms after 開始 (the guest still loading): ONE click starts the session, H drives',
      c2 && tc2 < 1000 && await H.until(`F1.net.room.st === 'session' && F1.game.running && !__shown('room-loading')`, 2500), await H.st());
    await H.shot('01-go-at-once');
    wire = await wireSince(H, wi); toasts = await toastsSince(H, ti);
    check('LOBBY-1: ... one start, one go on the wire, no nostart; no toast but 自由練習開始', count(wire, /^out:start$/) === 1 && count(wire, /^out:go$/) === 1 && !count(wire, /nostart/) &&
      toasts.every(x => x === '自由練習開始'), { wire, toasts });
    // the room menu's 回到大廳 right after the session began
    wi = await H.js('__ws.length'); ti = await H.js('__toasts.length');
    t0 = Date.now();
    await H.key('Escape');
    const c3 = await H.click('#setup-lobby'), tc3 = Date.now() - t0;
    check('LOBBY-1: the room menu\'s 回到大廳 clicked ~' + tc3 + ' ms after the session began: ONE click, the lobby', c3 && await H.until(`F1.net.room.st === 'lobby' && !F1.game.running`, 2500), await H.st());
    wire = await wireSince(H, wi); toasts = await toastsSince(H, ti);
    check('LOBBY-1: ... one back, no toast', count(wire, /^out:back$/) === 1 && toasts.length === 0, { wire, toasts });
    // control: a double click on 開始 over localhost
    await H.until(`F1.net.room.ready.length === 1 && F1.game.setup.go.enabled`, 3000);
    await sleep(1100);
    wi = await H.js('__ws.length'); ti = await H.js('__toasts.length');
    await dblClick(H, '#setup-go', 100);
    await sleep(800);
    wire = await wireSince(H, wi); toasts = await toastsSince(H, ti);
    check('a double click on 開始 (localhost): one start, no 「現在無法開始」, loading', count(wire, /^out:start$/) === 1 && !toasts.includes('現在無法開始') && await H.js(`F1.net.room.st === 'loading'`), { wire, toasts });
    await H.noErrors();
  } finally {
    try { G && G.ws.close(); } catch (e) {}
    closeAll([H]);
    await sleep(300);
  }
  // ---- LOBBY-2: a dedicated server behind a delaying link; the host double-clicks 開始 ----
  for (const [k, rtt] of [[0, 150], [1, 400]]) {
    const sport = PORT + 6, pport = PORT + 7 + k;
    const srv = await createServer0({ port: sport, host: '127.0.0.1' });   // dedicated: no token, the first player is the host
    const proxy = await delayProxy(pport, sport, rtt / 2);
    const D = makeWin('D' + rtt);
    let G2 = null;
    try {
      check('RTT ' + rtt + ' ms: the window joins the dedicated server through the proxy, as its host; Monza; a raw guest ready',
        !(await D.open()) && await D.join('Host', pport) && await D.until(`F1.net.isHost && F1.game.setup.show === 'picker'`, 4000) && await D.card('it-1922') &&
        await D.until(`F1.net.room.set.track === 'it-1922'`, 4000) && !!(G2 = await rawGuest(sport, 'Guest')) &&
        await D.until(`F1.net.room.ready.length === 1 && F1.game.setup.go.enabled`, 4000));
      await sleep(300);
      const ti = await D.js('__toasts.length'), wi = await D.js('__ws.length');
      await dblClick(D, '#setup-go', 120);
      await sleep(Math.max(1000, rtt * 4));
      const wire = await wireSince(D, wi), toasts = await toastsSince(D, ti), s = await D.st();
      check('LOBBY-2: RTT ' + rtt + ' ms, a double click on 開始 (120 ms apart): ONE start on the wire, no nostart; no 「現在無法開始」; the room loading (rs 1), the loading screen up',
        count(wire, /^out:start$/) === 1 && !count(wire, /nostart/) && !toasts.includes('現在無法開始') && !/現在無法開始/.test(s.toast) && s.st === 'loading' && s.rs === 1 && s.rl,
        { wire, toasts, st: s.st, rs: s.rs, rl: s.rl, toast: s.toast });
      await D.shot('02-dblclick-rtt' + rtt);
      await D.noErrors();
    } finally {
      try { G2 && G2.ws.close(); } catch (e) {}
      closeAll([D]);
      await sleep(300);
      try { proxy.close(); } catch (e) {}
      try { await srv.close(); } catch (e) {}
    }
  }
}

app.on('window-all-closed', () => {});                 // (the parts close their windows; the harness decides when to quit)
app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { console.log('WATCHDOG: 15 minutes'); app.exit(2); }, 15 * 60 * 1000);
  host.register(ipcMain);
  const parts = { solo: partSolo, room: partRoom, leave: partLeave, ded: partDed, proto: partProto, early: partEarly };
  const t0 = Date.now();
  for (const name of ONLY) {
    if (!parts[name]) { console.log('unknown part ' + name); continue; }
    part = name;
    const t = Date.now();
    console.log('---- ' + name);
    try { await parts[name](); } catch (e) { check('no exception', false, e && e.stack || String(e)); }
    console.log('---- ' + name + ' ' + ((Date.now() - t) / 1000).toFixed(0) + ' s');
  }
  for (const r of servers) { try { if (r.srv) await r.srv.close(); } catch (e) {} }
  clearTimeout(watchdog);
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (failed.length ? failed.length + ' / ' + results.length + ' checks FAILED:\n  ' + failed.map(r => r.name).join('\n  ') : 'ALL PASS ' + results.length + ' checks') +
    '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  app.exit(failed.length ? 1 : 0);
});
