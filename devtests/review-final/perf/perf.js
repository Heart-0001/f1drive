// Review soak: the REAL app entry (electron-main.js) in an offscreen, muted window. Drives for MINUTES (default 15)
// with a track change every SWITCH_S seconds, and samples: process memory (app.getAppMetrics), JS heap, DOM nodes /
// listeners (CDP), WebGL object counters (patched WebGL2RenderingContext.prototype), Web Audio node counters,
// main-thread frame cost (patched requestAnimationFrame), the hitch of every track load. At the end: variants with
// mirrors off / audio off / telemetry off, 20 s each.
//   npx electron devtests/review-final/perf/perf.js      env MINUTES, SWITCH_S, OUT
'use strict';
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const electron = require('electron');
const { app } = electron;
require(path.join(ROOT, 'devtests', 'electron-userdata'))(app, 'review-perf');
const MINUTES = Number(process.env.MINUTES || 15), SWITCH_S = Number(process.env.SWITCH_S || 150);
const OUT = path.join(__dirname, process.env.OUT || 'soak.json');
const RealBW = electron.BrowserWindow;
let win = null;
class OffscreenWindow extends RealBW {
  constructor(o) {
    o = Object.assign({}, o, { show: false, width: 1600, height: 900, useContentSize: true });
    o.webPreferences = Object.assign({}, o.webPreferences, { offscreen: true });
    super(o);
    this.webContents.setFrameRate(60);
    win = this;
  }
  maximize() {}
  setFullScreen() {}
}
const load = Module._load;
Module._load = function (request) {
  if (request === 'electron') return new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? OffscreenWindow : t[k]) });
  return load.apply(this, arguments);
};
const T0 = Date.now();
require(path.join(ROOT, 'electron-main.js'));
Module._load = load;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const INSTRUMENT = `(function(){
  if (window.__rv) return 'already';
  var rv = window.__rv = { gl: {}, au: {}, frames: [], hitch: 0, maxGap: 0, lastT: 0, loads: [] };
  // WebGL objects
  var P = WebGL2RenderingContext.prototype, kinds = ['Buffer','Texture','Program','Shader','Framebuffer','Renderbuffer','VertexArray','Query','Sampler'];
  kinds.forEach(function(k){ rv.gl[k] = 0;
    var c = P['create'+k], d = P['delete'+k];
    if (c) P['create'+k] = function(){ rv.gl[k]++; return c.apply(this, arguments); };
    if (d) P['delete'+k] = function(o){ if (o) rv.gl[k]--; return d.apply(this, arguments); };
  });
  // audio nodes created (no delete: nodes are GC'd when disconnected and unreferenced)
  var A = BaseAudioContext.prototype;
  ['createGain','createOscillator','createBufferSource','createBiquadFilter','createBuffer','createPanner','createStereoPanner','createDelay','createWaveShaper','createDynamicsCompressor','createAnalyser','createConstantSource'].forEach(function(k){
    rv.au[k] = 0; var f = A[k]; if (f) A[k] = function(){ rv.au[k]++; return f.apply(this, arguments); };
  });
  var W = window.AudioWorkletNode; rv.au.worklet = 0;
  if (W) { window.AudioWorkletNode = function(){ rv.au.worklet++; var n = new (Function.prototype.bind.apply(W, [null].concat([].slice.call(arguments)))); return n; }; window.AudioWorkletNode.prototype = W.prototype; }
  // frame cost + gaps
  var raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function(cb){ return raf.call(window, function(t){
    if (rv.lastT && t - rv.lastT > rv.maxGap) rv.maxGap = t - rv.lastT;
    rv.lastT = t;
    var s = performance.now(); cb(t); var c = performance.now() - s;
    rv.frames.push(c);
  }); };
  // track loads: wrap the card click path via F1.ui? simpler: time around a click we trigger from outside (see loadTrack)
  return 'ok';
})()`;

const SAMPLE = `(function(){
  var rv = window.__rv, f = rv.frames.slice(); rv.frames.length = 0; f.sort(function(a,b){return a-b;});
  var sum = 0; for (var i = 0; i < f.length; i++) sum += f[i];
  var m = performance.memory || {};
  var a = F1.audio && F1.audio.debug ? { backend: F1.audio.debug.backend, voices: F1.audio.debug.voices, state: F1.audio.debug.context && F1.audio.debug.context.state, errors: F1.audio.debug.errors } : null;
  var ck = F1.game.cockpit && F1.game.cockpit.info ? F1.game.cockpit.info() : null;
  var gap = rv.maxGap; rv.maxGap = 0;
  return { n: f.length, mean: f.length ? sum / f.length : 0, p50: f[f.length >> 1] || 0, p95: f[Math.floor(f.length * 0.95)] || 0, max: f[f.length - 1] || 0, maxGap: gap,
    heap: m.usedJSHeapSize, heapTotal: m.totalJSHeapSize, gl: Object.assign({}, rv.gl), au: Object.assign({}, rv.au), audio: a,
    mirrors: ck && ck.mirrors, speed: F1.game.car ? F1.game.car.state.speed : null, running: F1.game.running, track: F1.game.trackData && F1.game.trackData.id };
})()`;

function loadTrackJs(id) {
  return `(function(){ var i = F1_TRACKS.findIndex(function(t){ return t.id === ${JSON.stringify(id)}; });
    var c = document.querySelectorAll('#track-grid .card')[i]; var s = performance.now(); c.click(); var t = performance.now() - s;
    window.__rv.loads.push({ id: ${JSON.stringify(id)}, ms: t }); return t; })()`;
}

function metrics() {
  const list = app.getAppMetrics();
  const out = {};
  for (const p of list) {
    const key = p.type + (p.name ? ':' + p.name : '') + (p.serviceName ? ':' + p.serviceName : '');
    out[key] = { pid: p.pid, ws: Math.round(p.memory.workingSetSize / 1024), priv: Math.round(p.memory.privateBytes / 1024), cpu: +p.cpu.percentCPUUsage.toFixed(1) };
  }
  return out;
}

app.whenReady().then(async () => {
  const log = { t0: T0, samples: [], loads: [], variants: [], errors: [] };
  for (let i = 0; i < 100 && !win; i++) await sleep(50);
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && msg.indexOf('Electron Security Warning') < 0) log.errors.push(msg); });
  await new Promise(r => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', r); else r(); });
  const js = c => win.webContents.executeJavaScript(c);
  for (let i = 0; i < 100; i++) { if (await js('!!(window.F1 && F1.game)')) break; await sleep(50); }
  log.bootMs = Date.now() - T0;
  console.log('boot (main start -> F1.game):', log.bootMs, 'ms');
  console.log('instrument:', await js(INSTRUMENT));
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); await dbg.sendCommand('Performance.enable'); } catch (e) { console.log('cdp', e.message); }
  const cdp = async () => { try { const r = await dbg.sendCommand('Performance.getMetrics'); const o = {}; r.metrics.forEach(m => { if (/JSEventListeners|Nodes|Documents|JSHeapUsedSize|Frames|LayoutCount|RecalcStyleCount/.test(m.name)) o[m.name] = m.value; }); return o; } catch (e) { return {}; } };

  const TRACKS = ['it-1922', 'be-1925', 'mc-1929', 'jp-1962', 'us-2023', 'az-2016', 'gb-1948', 'nl-1948', 'sg-2008', 'au-1953'];
  const ids = await js('F1_TRACKS.map(function(t){return t.id;})');
  const order = TRACKS.filter(id => ids.includes(id));
  console.log('tracks:', order.join(' '));
  let ti = 0;
  const loadTrack = async () => {
    const id = order[ti++ % order.length];
    const gapBefore = await js('window.__rv.maxGap = 0; true');
    const ms = await js(loadTrackJs(id));
    await sleep(1500);
    const gap = await js('(function(){ var g = window.__rv.maxGap; window.__rv.maxGap = 0; return g; })()');
    const rec = { id, clickMs: Math.round(ms), maxGapMs: Math.round(gap), at: Math.round((Date.now() - T0) / 1000) };
    log.loads.push(rec);
    console.log('load', JSON.stringify(rec));
    void gapBefore;
  };
  await loadTrack();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
  const end = Date.now() + MINUTES * 60000;
  let nextSwitch = Date.now() + SWITCH_S * 1000, nextReset = Date.now() + 8000, k = 0;
  while (Date.now() < end) {
    await sleep(10000);
    const s = await js(SAMPLE);
    if (Date.now() > nextReset) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R' }); await sleep(50); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R' }); nextReset = Date.now() + 8000; }
    s.at = Math.round((Date.now() - T0) / 1000); s.proc = metrics(); s.cdp = await cdp();
    log.samples.push(s);
    if (k++ % 3 === 0 || s.at < 60) console.log(JSON.stringify({ at: s.at, track: s.track, frame: { mean: +s.mean.toFixed(2), p95: +s.p95.toFixed(2), max: +s.max.toFixed(1), gap: +s.maxGap.toFixed(0) }, heapMB: +(s.heap / 1048576).toFixed(1), gl: s.gl, au: s.au, voices: s.audio && s.audio.voices, listeners: s.cdp.JSEventListeners, nodes: s.cdp.Nodes, proc: Object.fromEntries(Object.entries(s.proc).map(([a, b]) => [a, b.ws + 'K/' + b.cpu + '%'])), speed: s.speed && +s.speed.toFixed(0) }));
    if (Date.now() > nextSwitch) { win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' }); await loadTrack(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' }); nextSwitch = Date.now() + SWITCH_S * 1000; }
    fs.writeFileSync(OUT, JSON.stringify(log, null, 1));
  }
  // variants (same track, driving): baseline, mirrors off, audio off, telemetry off, all off
  const variant = async (name, setup, teardown) => {
    await js(setup);
    await js('window.__rv.frames.length = 0; true');
    await sleep(20000);
    const s = await js(SAMPLE);
    s.proc = metrics();
    const r = { name, mean: +s.mean.toFixed(2), p50: +s.p50.toFixed(2), p95: +s.p95.toFixed(2), max: +s.max.toFixed(1), n: s.n, cpu: Object.fromEntries(Object.entries(s.proc).map(([a, b]) => [a, b.cpu])) };
    log.variants.push(r); console.log('variant', JSON.stringify(r));
    await js(teardown);
  };
  await variant('baseline', 'true', 'true');
  await variant('mirrors-off', 'F1.game.cockpit.setMirrors(false); true', 'F1.game.cockpit.setMirrors(true); true');
  await variant('audio-off', 'F1.audio.setActive(false); window.__au = F1.audio.update; F1.audio.update = function(){}; true', 'F1.audio.update = window.__au; F1.audio.setActive(true); true');
  await variant('telemetry-off', 'window.__td = F1.telemetry.draw; F1.telemetry.draw = function(){}; true', 'F1.telemetry.draw = window.__td; true');
  await variant('all-off', 'F1.game.cockpit.setMirrors(false); F1.audio.setActive(false); F1.audio.update = function(){}; F1.telemetry.draw = function(){}; true', 'true');
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
  fs.writeFileSync(OUT, JSON.stringify(log, null, 1));
  console.log('errors:', log.errors.length, log.errors.slice(0, 5));
  console.log('written', OUT);
  app.exit(0);
});
