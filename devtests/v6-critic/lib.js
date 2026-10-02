// Shared helpers of devtests/v6-critic (Electron main process): offscreen windows on the real index.html with the real
// preload / host IPC, real key / mouse events, screenshots, the time warp + fake controller of gp-e2e/solo-page.js and
// the observers / pit driver of v6-smoke/page.js. Checks are collected in results[] (see check()).
'use strict';
const { BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const host = require(path.join(ROOT, 'net', 'host'));
const refCar = require('../ref-car');
const OUT = path.join(__dirname, 'out');
const WARP = fs.readFileSync(path.join(ROOT, 'devtests', 'gp-e2e', 'solo-page.js'), 'utf8');   // time warp, fake pad, autopilot
const V6 = fs.readFileSync(path.join(ROOT, 'devtests', 'v6-smoke', 'page.js'), 'utf8');         // observers, pit driver
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);
const results = [];
const state = { part: '' };
function check(name, ok, detail) {
  results.push({ name: state.part + ': ' + name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + state.part + ': ' + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : J(detail)) : ''));
  return !!ok;
}
function note(text) { console.log('NOTE ' + state.part + ': ' + text); }

const T_LIB = `(function () {
  window.__t = {
    shown: function (id) { var e = typeof id === 'string' ? (document.getElementById(id) || document.querySelector(id)) : id; if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; },
    text: function (id) { var e = document.getElementById(id) || document.querySelector(id); return e ? e.innerText.replace(/\\s+/g, ' ').trim() : null; },
    rect: function (id) { var e = document.getElementById(id) || document.querySelector(id); if (!e) return null; var r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; },
    fakePad: function () {
      var b = []; for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
      window.__pad = { index: 0, id: 'Fake Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b,
        vibrationActuator: { type: 'dual-rumble', playEffect: function () { return Promise.resolve('complete'); } } };
      window.__padOn = true;
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: function () { return window.__padOn ? [window.__pad, null, null, null] : [null, null, null, null]; } });
      window.__btn = function (i, v) { var x = window.__pad.buttons[i]; x.value = v; x.pressed = v > 0.5; return true; };
      return true;
    }
  };
  // every uncaught page error / rejection, whatever the console says
  window.__errs = [];
  window.addEventListener('error', function (e) { window.__errs.push(String(e && (e.message || e.type))); });
  window.addEventListener('unhandledrejection', function (e) { window.__errs.push('rejection: ' + String(e && e.reason)); });
  return true;
})()`;

let winSeq = 0;
function makeWin(tag, opts) {
  opts = opts || {};
  const w = new BrowserWindow({
    width: opts.w || 1280, height: opts.h || 720, show: false, useContentSize: true,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, partition: opts.partition || ('v6c-' + tag + '-' + (++winSeq)),
      preload: path.join(ROOT, 'preload.js'), backgroundThrottling: false
    }
  });
  w.webContents.setFrameRate(60);
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
  w.shot = async (n, draw) => {
    if (draw) await w.js(`window.__e && __e.draw ? __e.draw() : true`);
    await sleep(draw ? 120 : 250);
    fs.writeFileSync(path.join(OUT, n + '.png'), (await w.webContents.capturePage()).toPNG());
    console.log('shot ' + n + '.png');
  };
  const CODES = { Escape: 'Escape', Enter: 'Return' };
  w.key = (k, down) => w.webContents.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode: CODES[k] || k });
  w.tap = async (k, holdMs) => { w.key(k, true); await sleep(holdMs || 50); w.key(k, false); await sleep(90); };
  w.until = async (code, ms, what) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { if (await w.js('!!(' + code + ')')) return true; await sleep(40); }
    console.log('TIMEOUT ' + tag + ': ' + (what || code));
    return false;
  };
  // o.warp: the time warp + fake controller; o.fresh: a fresh install (v6.1: the 2026 standard car) - else the window
  // drives the reference car (2025-standard), picked before the game boots (devtests/ref-car.js), as the critic's
  // drivers, timings and car lists (2025 cars) were written for it
  w.open = async o => {
    o = o || {};
    if (!o.fresh) await refCar.seed(w);
    await w.loadFile(path.join(ROOT, 'index.html'));
    await sleep(900);
    await w.js(T_LIB);
    if (o.warp) { await w.js(WARP); await w.js(`__e.renderEvery = 0; true`); }
    await w.js(V6);
    return w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  };
  w.field = (id, v) => w.js(`(function () { var e = document.getElementById(${J(id)}); e.value = ${J(v)};
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
  w.click = async sel => {
    const r = await w.js(`(function () { var e = document.getElementById(${J(sel)}) || document.querySelector(${J(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
      var r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x: x, y: y, w: r.width, hit: !!top && (top === e || e.contains(top)), top: top ? (top.id || top.className || top.tagName) : null, disabled: !!e.disabled }; })()`);
    if (!r || !(r.w > 0) || !r.hit || r.disabled) { console.log('click: ' + sel + ' cannot be clicked ' + J(r)); return false; }
    const x = Math.round(r.x), y = Math.round(r.y);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
  };
  w.trackIndex = id => w.js(`F1_TRACKS.findIndex(function (t) { return t.id === ${J(id)}; })`);
  // v7.2: a card opens the start panel; 開始 (#setup-go) drives. mode: 'free' (default) | 'gp' (the panel's Grand Prix
  // fields #gp-q / #gp-r / #gp-wear are set by the caller between w.card() and w.go())
  w.card = async id => { const i = await w.trackIndex(id); return i >= 0 && await w.click(`#track-grid .card[data-i="${i}"]`) && await w.until(`F1.game.setup && F1.game.setup.show === 'setup'`, 2000, 'start panel'); };
  w.mode = m => w.click(`#setup-mode [data-m="${m}"]`);
  w.go = () => w.click('#setup-go');
  w.pickTrack = async (id, ms) => {
    if (!await w.card(id) || !await w.mode('free') || !await w.go()) return false;
    return w.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, ms || 20000, 'track ' + id);
  };
  // (warp: the loop is pumped by __e.run, so "running" is enough; the first frame is queued)
  w.pickTrackWarp = async id => {
    if (!await w.card(id) || !await w.mode('free') || !await w.go()) return false;
    const ok = await w.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)} && __e.queued() === 1`, 20000, 'track ' + id);
    if (ok) await w.js(`__v.hookRenderer() && __e.hookCar()`);
    return ok;
  };
  w.pickYear = async y => {
    await w.click('#tab-car');
    return w.js(`(function () { var s = document.getElementById('car-year'); if (s.disabled) return 'disabled'; s.value = ${J(String(y))}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  };
  w.pickCar = async id => { await w.click('#tab-car'); return w.click(`#car-list .car-card[data-id="${id}"]`); };
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
  w.frames = n => w.js(`__e.run(${n}, '', 20000)`);
  w.overlay = () => w.js(`document.getElementById('error').classList.contains('hidden') ? '' : document.getElementById('error-text').textContent`);
  w.noErrors = async what => {
    const overlay = await w.overlay();
    const pageErrs = await w.js(`window.__errs || []`);
    return check(tag + ': no error overlay, no console / page errors' + (what ? ' (' + what + ')' : ''), !overlay && w.errors.length === 0 && pageErrs.length === 0,
      overlay || w.errors.slice(0, 4).concat(pageErrs.slice(0, 4)));
  };
  return w;
}

/* ---- v7.2 rooms: the lobby (docs/lobby-design.md). Nobody drives until the host's 開始 and the loading barrier. ---- */
// The host picks the room's track in the lobby: the picker (選賽道 / 換賽道, open by itself in a fresh room), a card.
async function roomTrack(hostW, id) {
  if ((await hostW.js(`F1.game.setup && F1.game.setup.show`)) !== 'picker' && !await hostW.click('#setup-track-btn')) return false;
  const i = await hostW.trackIndex(id);
  if (i < 0 || !await hostW.click(`#track-grid .card[data-i="${i}"]`)) return false;
  return hostW.until(`F1.net.room.set.track === ${J(id)} && F1.game.setup.show === 'setup'`, 3000, 'room track ' + id);
}
// The host's lobby settings: {mode: 'free' | 'gp', q, r, wear} through the lobby's own controls.
async function roomSettings(hostW, o) {
  if (o.mode) await hostW.click(`#setup-mode [data-m="${o.mode}"]`);
  if (o.q !== undefined) await hostW.field('gp-q', String(o.q));
  if (o.r !== undefined) await hostW.field('gp-r', String(o.r));
  if (o.wear !== undefined) await hostW.click(`#gp-wear button[data-w="${o.wear}"]`);
  return hostW.until(`(function () { var s = F1.net.room.set; return ${J(o.mode || null)} === null || s.mode === ${J(o.mode || null)}; })()`, 2000, 'room settings');
}
// The guests press 準備 (those not ready yet), the host 開始 (a second try after START_MIN_MS when the server said
// busy); everybody loads, the session begins after the barrier. gp: wait for qualifying. -> every window drives
async function roomStart(hostW, guests, o) {
  o = o || {};
  for (const g of guests) {
    if (!await g.js(`!!(F1.net.room && F1.net.room.ready.indexOf(F1.net.id) >= 0)`)) await g.click('#setup-ready');
  }
  if (!await hostW.until(`F1.game.setup && F1.game.setup.go.enabled`, 5000, 'everybody ready')) return false;
  for (let k = 0; k < 3; k++) {
    await hostW.click('#setup-go');
    if (await hostW.until(`F1.net.room.st !== 'lobby'`, 1500, 'room loading')) break;
    await sleep(1100);
  }
  const cond = `F1.net.room && F1.net.room.st === 'session' && F1.game.running` + (o.gp ? ` && F1.game.gp.phase === 'quali'` : '');
  let ok = true;
  for (const w of [hostW].concat(guests)) ok = await w.until(cond, o.ms || 40000, 'room session') && ok;
  return ok;
}
// The host takes the room back to the lobby (Esc: the room menu, 回到大廳, confirmed where a Grand Prix would end).
async function roomBack(hostW, all) {
  if (await hostW.js(`F1.game.running`)) await hostW.tap('Escape');
  // (again after START_MIN_MS: the server drops a back within 1 s of the host's last start)
  for (let k = 0; k < 3 && await hostW.js(`F1.net.room.st !== 'lobby'`); k++) {
    await hostW.click('#setup-lobby');
    if (await hostW.js(`!document.getElementById('setup-confirm').classList.contains('hidden')`)) await hostW.click('#setup-force-yes');
    if (await hostW.until(`F1.net.room.st === 'lobby'`, 1500, 'back')) break;
    await sleep(1100);
  }
  let ok = true;
  for (const w of all || [hostW]) ok = await w.until(`F1.net.room.st === 'lobby' && !F1.game.running`, 5000, 'lobby') && ok;
  return ok;
}

module.exports = { ROOT, OUT, host, sleep, J, results, state, check, note, makeWin, roomTrack, roomSettings, roomStart, roomBack };
