// Shared helpers of devtests/v61-critic: the windows, keys, clicks, time warp and observers of devtests/v6-critic/lib.js
// (which builds on gp-e2e/solo-page.js and v6-smoke/page.js), with the screenshots written into v61-critic/out/, plus
// page-side probes for the v6.1 parts (HUD mirrors, the pad layout, the HUD layout).
'use strict';
const fs = require('fs'), path = require('path');
const L = require('../v6-critic/lib');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const { sleep, J } = L;

// In the page: what is on screen, and which HUD boxes overlap (CSS px, rounded)
const PROBE = `(function () {
  if (window.__p) return 'already';
  var P = window.__p = {};
  var IDS = ['hud-mirror-l', 'hud-mirror-r', 'hud-timing', 'hud-players', 'hud-gp', 'hud-lights', 'hud-pit', 'gp-results', 'hud-map', 'hud-telemetry', 'hud-hint', 'hud-toast'];
  function vis(e) {
    if (!e) return false;
    var r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !e.classList.contains('hidden');
  }
  // every shown HUD box, the overlapping pairs (more than 2 px both ways), the boxes leaving the window
  P.layout = function () {
    var R = [], over = [], off = [], W = innerWidth, H = innerHeight;
    for (var i = 0; i < IDS.length; i++) {
      var e = document.getElementById(IDS[i]);
      if (!vis(e)) continue;
      var r = e.getBoundingClientRect();
      R.push({ id: IDS[i], x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) off.push(IDS[i]);
    }
    for (i = 0; i < R.length; i++) for (var j = i + 1; j < R.length; j++) {
      var a = R[i], b = R[j];
      var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 2 && oy > 2) over.push(a.id + '/' + b.id + ' ' + ox + 'x' + oy);
    }
    return { W: W, H: H, boxes: R, over: over, off: off };
  };
  P.mirrors = function () {
    var hm = F1.game.hudMirrors, i = hm ? hm.info() : null;
    return { game: F1.game.mirrors, inst: !!hm, visible: i ? i.visible : null, passes: i ? i.passes : null, blits: i ? i.blits : null, rects: i ? i.rects : null,
      ms: i ? i.ms : null, rate: i ? i.rate : null, noMirrors: document.getElementById('hud').classList.contains('no-mirrors'),
      frames: [vis(document.getElementById('hud-mirror-l')), vis(document.getElementById('hud-mirror-r'))],
      setting: F1.ui.getMirrors(), sw: document.getElementById('set-mirrors').checked, swText: document.getElementById('set-mirrors-text').textContent,
      swDisabled: document.getElementById('set-mirrors').disabled,
      timingTop: Math.round(document.getElementById('hud-timing').getBoundingClientRect().top),
      stored: (function () { try { return localStorage.getItem('f1drive.hud'); } catch (e) { return 'ERR'; } })() };
  };
  P.toast = function () { var t = document.getElementById('hud-toast'); return vis(t) ? t.innerText.replace(/\\s+/g, ' ').trim() : ''; };
  return 'ok';
})()`;

function makeWin(tag, opts) {
  const w = L.makeWin(tag, opts);
  w.shot = async (n, draw) => {
    if (draw) await w.js(`window.__e && __e.draw ? __e.draw() : true`);
    await sleep(draw ? 120 : 250);
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, n + '.png'), img.toPNG());
    console.log('shot ' + n + '.png ' + J(img.getSize()));
    return img;
  };
  const open = w.open;
  w.open = async o => { const e = await open(o); await w.js(PROBE); return e; };
  w.size = async (W, H) => { w.setContentSize(W, H); await sleep(700); return w.js('[innerWidth, innerHeight, devicePixelRatio]'); };
  // a pad button pressed for a few frames (warp: pumped; real time: waited)
  w.button = async (i, frames, warp) => {
    await w.js(`(function () { var p = window.__e ? __e.pad : window.__pad, b = p.buttons[${i}]; b.value = 1; b.pressed = true; return true; })()`);
    if (warp) await w.frames(frames || 3); else await sleep(frames ? frames * 17 : 120);
    await w.js(`(function () { var p = window.__e ? __e.pad : window.__pad, b = p.buttons[${i}]; b.value = 0; b.pressed = false; return true; })()`);
    if (warp) await w.frames(3); else await sleep(120);
  };
  return w;
}

module.exports = Object.assign({}, L, { OUT, makeWin, PROBE });
