// Shared helpers of devtests/v6-critic (Electron main process): offscreen windows on the real index.html with the real
// preload / host IPC, real key / mouse events, screenshots, the time warp + fake controller of gp-e2e/solo-page.js and
// the observers / pit driver of v6-smoke/page.js. Checks are collected in results[] (see check()).
'use strict';
const { BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const host = require(path.join(ROOT, 'net', 'host'));
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
  w.open = async o => {
    o = o || {};
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
  w.pickTrack = async (id, ms) => {
    const i = await w.trackIndex(id);
    if (i < 0 || !await w.click(`#track-grid .card[data-i="${i}"]`)) return false;
    return w.until(`F1.game.running && F1.game.trackData && F1.game.trackData.id === ${J(id)}`, ms || 20000, 'track ' + id);
  };
  // (warp: the loop is pumped by __e.run, so "running" is enough; the first frame is queued)
  w.pickTrackWarp = async id => {
    const i = await w.trackIndex(id);
    if (i < 0 || !await w.click(`#track-grid .card[data-i="${i}"]`)) return false;
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

module.exports = { ROOT, OUT, host, sleep, J, results, state, check, note, makeWin };
