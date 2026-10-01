// The live path of js/audio.js: the real AudioContext in an Electron window, update() called from requestAnimationFrame
// with a scripted car, the master output tapped with an AnalyserNode.
//   npx electron devtests/audio-test/live.js                 robustness + live (worklet, forced fallback, AudioWorklet
//                                                            hidden) + update() timing and heap growth. The sound card
//                                                            is muted (Chromium --mute-audio): same graph, same clock.
//   SOUND=0.15 npx electron devtests/audio-test/live.js      the same through the speakers at master volume 0.15 (quiet)
//   MODE=gesture npx electron devtests/audio-test/live.js    WITHOUT the autoplay switch: Electron's default policy (sound
//                                                            at once), then pages that require a gesture (the context
//                                                            waits; a key press / click starts it)
//   env ONLY=bench,dsp,robust,live,nodes,hidden,load,stall   parts of the default mode
// Exit code 1 when a check fails.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('../electron-userdata')(app, 'audio-live');
const MODE = process.env.MODE || 'live';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const SOUND = process.env.SOUND ? Math.max(0, Math.min(1, Number(process.env.SOUND) || 0)) : 0;
const want = p => !ONLY.length || ONLY.indexOf(p) >= 0;
if (MODE !== 'gesture') app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');     // what electron-main.js is to set
if (!SOUND) app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.commandLine.appendSwitch('enable-precise-memory-info');

// The worklet path allocates nothing at all per update(). The node fallback cannot avoid one thing: V8 boxes each
// non-integer number handed to setTargetAtTime (the value and the time constant: 2 x 12 bytes per parameter written).
const HEAP_PER_WRITE = 25;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined && detail !== '' ? '   ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const f1 = x => Number(x).toFixed(1), f2 = x => Number(x).toFixed(2);
ipcMain.handle('at-save', () => true);
ipcMain.on('at-log', (e, msg) => console.log('[page]', msg));

function makeWin(extra) {
  const w = new BrowserWindow({
    width: 640, height: 360, show: false,
    // sandbox: false only so that the preload script can offer process.hrtime to the page (see preload.js)
    webPreferences: Object.assign({ offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }, extra || {})
  });
  w.webContents.setFrameRate(60);
  w.warnings = [];
  w.webContents.on('console-message', (e, level, msg, line, src) => {
    if (level < 2 || msg.indexOf('Electron Security Warning') >= 0) return;
    w.warnings.push(msg);
    console.log('[console ' + level + ']', msg, (src || '').split('/').pop() + ':' + line);
  });
  w.js = code => w.webContents.executeJavaScript(code, false);        // false: not a user gesture
  return w;
}

function liveChecks(tag, r, wantBackend, volume) {
  const gain = volume * volume;
  console.log('  ' + tag + ': ' + JSON.stringify(Object.assign({}, r, { lastError: undefined })));
  check(tag + ': init() ready on the ' + wantBackend + ' back end in ' + f1(r.initMs) + ' ms (context ' + r.sampleRate + ' Hz, base latency ' + f1(r.baseLatencyMs) + ' ms, output latency ' + f1(r.outputLatencyMs) + ' ms)', r.ready === true && r.backend === wantBackend);
  check(tag + ': the context runs in real time (' + f2(r.contextSeconds) + ' s of audio in ' + f2(r.seconds) + ' s, ' + r.frames + ' frames = ' + f1(r.fps) + ' fps)', r.state === 'running' && Math.abs(r.contextSeconds - r.seconds) < 0.25 && r.fps > 20);
  check(tag + ': real-time output is never silent (level ' + f1(r.rmsMinDb) + ' .. ' + f1(r.rmsMaxDb) + ' dBFS at the master output, ' + r.silentFrames + ' silent frames)', r.silentFrames === 0 && r.rmsMaxDb - 20 * Math.log10(gain) > -30 && r.peak < 0.9);
  check(tag + ': pitch follows the engine in real time (' + r.pitchFrames + ' frames, median error ' + f2(r.pitchMedian * 100) + ' %, 95 % ' + f2(r.pitchP95 * 100) + ' %; ' + Math.round(r.rpmMin) + ' .. ' + Math.round(r.rpmMax) + ' rpm, ' + r.shifts + ' gear changes up to gear ' + r.topGear + ')',
    r.pitchFrames > 100 && r.pitchMedian < 0.01 && r.pitchP95 < 0.04 && r.topGear >= 4);
  check(tag + ': update() costs ' + f1(r.updMeanUs) + ' us per frame on average (median ' + f1(r.updMedianUs) + ' us, 99 % ' + f1(r.updP99Us) + ' us, worst ' + f1(r.updMaxUs) + ' us of ' + r.frames + ' frames; budget 200 us; clock: process.hrtime, ' +
    f2(r.clock.medianUs) + ' us per reading taken off), ' + r.maxVoices + ' remote voices', r.updMeanUs < 100 && r.updP99Us < 200 && r.maxVoices === 3);
  check(tag + ': nothing caught inside update(); the master compressor takes off at most ' + f1(-r.compReductionDb) + ' dB', r.errors === 0 && r.compReductionDb > -6, r.lastError || undefined);
  check(tag + ': setActive(false) is silent after 0.32 s (largest sample ' + r.afterInactivePeak.toExponential(1) + ') and the context sleeps (' + r.stateInactive + '); setActive(true) wakes it (' + r.stateReactivated + ', level ' +
    f1(20 * Math.log10(Math.max(r.afterReactivateRms, 1e-9))) + ' dBFS)', r.afterInactivePeak < 1e-4 && r.stateInactive === 'suspended' && r.stateReactivated === 'running' && r.afterReactivateRms > 0.002 * gain);
  check(tag + ': dispose() closes the context (' + r.stateDisposed + ', back end ' + r.backendAfterDispose + ')', r.stateDisposed === 'closed' && r.backendAfterDispose === 'none');
}
function benchChecks(tag, r) {
  console.log('  ' + tag + ': ' + JSON.stringify(r));
  check(tag + ': update() with 12 remote cars, everything changing every call: ' + f2(r.updateUs) + ' us per call in a tight loop of 20000 (the scripted world itself ' + f2(r.bareUs) + ' us); one call every 4 ms, 600 calls: mean ' + f2(r.spacedMeanUs) +
    ' us, median ' + f2(r.spacedMedianUs) + ' us, 99 % ' + f1(r.spacedP99Us) + ' us, worst ' + f1(r.spacedMaxUs) + ' us; budget 200 us', r.ready && r.updateUs < 40 && r.spacedMeanUs < 60 && r.spacedP99Us < 200 && r.errors === 0, r.lastError || undefined);
  if (r.heapUpdate) {
    const h = x => f2(x.median) + ' (' + f2(x.min) + ' .. ' + f2(x.max) + ')';
    const perWrite = r.paramWritesPerCall > 0 ? (r.heapUpdate.median - r.heapBare.median) / r.paramWritesPerCall : 0;
    check(tag + ': JS heap growth per update() call, median (range) of ' + r.heapPlain.n + ' batches of ' + r.heapBatch + ' calls: ' + h(r.heapPlain) + ' bytes with a fixed scene, ' + h(r.heapUpdate) + ' bytes with everything changing (' +
      f1(r.paramWritesPerCall) + ' AudioParam writes per call' + (r.backend === 'nodes' ? ' = ' + f1(perWrite) + ' bytes per write' : '') + '; the scripted world alone: ' + h(r.heapBare) +
      '); control, the same plus one 2-element array per call: ' + h(r.heapControl) + ' bytes',
      r.heapPlain.median < 0.5 && r.heapControl.median > 24 && (r.backend === 'nodes' ? perWrite < HEAP_PER_WRITE : r.heapUpdate.median - r.heapBare.median < 0.5));
  } else check(tag + ': heap measurement available', false);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  try {
    if (MODE === 'gesture') {
      // ---- 1. Electron's own default (no switch): F1.audio.init() at load, before any gesture ----
      let w = makeWin();
      await w.loadFile(path.join(__dirname, 'page.html'));
      const d = await w.js('AT.gestureDefault()');
      console.log('  Electron default policy, init() at load: ' + JSON.stringify(d));
      check('Electron default policy: init() before any gesture starts the sound at once (' + d.backend + ', ' + d.state + ', ' + f1(20 * Math.log10(Math.max(d.rms || 0, 1e-9))) + ' dBFS; activation ' + d.activation + ')',
        d.activation === false && d.init === true && d.state === 'running' && d.rms > 0.003 && d.errors === 0);
      check('... with nothing on the console', w.warnings.length === 0, w.warnings.slice(0, 2));
      w.destroy();
      // ---- 2. a page that requires a gesture: init() too early, then a key ----
      w = makeWin({ autoplayPolicy: 'document-user-activation-required' });
      await w.loadFile(path.join(__dirname, 'page.html'));
      const before = await w.js('AT.gestureBefore()');
      console.log('  gesture required, before it: ' + JSON.stringify(before));
      check('gesture required: init() before it builds the graph on a context that waits (' + before.state + '); update / beep / setActive do not throw',
        before.activation === false && before.state === 'suspended' && before.threw === false && before.errors === 0);
      const policyNotes = w.warnings.filter(m => /AudioContext was not allowed to start/.test(m)).length;
      check('... the console has Chromium\'s autoplay notice (' + policyNotes + ') and nothing else', w.warnings.length === policyNotes, w.warnings.slice(0, 3));
      w.warnings.length = 0;
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
      await sleep(80);
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      const after = await w.js('AT.gestureAfter()');
      console.log('  after a key press: ' + JSON.stringify(after));
      check('after a key press: init() from the key handler starts it (' + after.backend + ', ' + after.state + ') and there is sound (' + f1(20 * Math.log10(Math.max(after.rms || 0, 1e-9))) + ' dBFS)',
        after.activation === true && after.init === true && after.state === 'running' && after.backend === 'worklet' && after.rms > 0.003 && after.errors === 0);
      check('... with nothing more on the console', w.warnings.length === 0, w.warnings.slice(0, 2));
      w.destroy();
      // ---- 3. gesture required, init() called once too early and never again: update() starts it after a click ----
      w = makeWin({ autoplayPolicy: 'document-user-activation-required' });
      await w.loadFile(path.join(__dirname, 'page.html'));
      const lb = await w.js('AT.lazyBefore()');
      await sleep(700);
      const still = await w.js('AT.lazy.debug.context.state');
      w.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 });
      w.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 50, button: 'left', clickCount: 1 });
      const la = await w.js('AT.lazyAfter()');
      console.log('  lazy start: ' + JSON.stringify({ before: lb, stateBeforeClick: still, after: la }));
      check('gesture required, init() only ever called too early: the context waits for 0.7 s of update() calls (' + still + '), a click, and update() starts it (' + la.backend + ', ' + la.state + ')',
        still === 'suspended' && la.ready === true && la.state === 'running');
      w.destroy();
    } else {
      console.log('sound card: ' + (SOUND ? 'ON, master volume ' + SOUND : 'muted (--mute-audio); SOUND=0.15 to hear it'));
      if (want('bench')) {
        // (in a window of its own, before anything else: the robustness part feeds update() every kind of rubbish, and
        //  code that has seen rubbish is compiled for it)
        const wb = makeWin();
        await wb.loadFile(path.join(__dirname, 'page.html'));
        benchChecks('bench / worklet', await wb.js('AT.bench({})'));
        benchChecks('bench / node fallback', await wb.js('AT.bench({ worklet: false })'));
        check('bench: nothing on the console', wb.warnings.length === 0, wb.warnings.slice(0, 3));
        wb.destroy();
      }
      const w = makeWin();
      await w.loadFile(path.join(__dirname, 'page.html'));
      if (want('robust')) {
        const r = await w.js('AT.robust()');
        r.checks.forEach(c => check('robust: ' + c.name, c.ok, c.ok ? undefined : c.detail));
        check('robust: nothing escaped as an exception (' + r.threw + ')', r.threw === 0);
      }
      const vol = SOUND || 1, opt = extra => JSON.stringify(Object.assign({ seconds: 8.5, volume: vol }, extra));
      if (want('live')) liveChecks('live / worklet', await w.js('AT.live(' + opt({}) + ')'), 'worklet', vol);
      if (want('nodes')) liveChecks('live / node fallback (forced)', await w.js('AT.live(' + opt({ worklet: false }) + ')'), 'nodes', vol);
      if (want('hidden')) liveChecks('live / AudioWorkletNode hidden', await w.js('AT.live(' + opt({ noWorklet: true }) + ')'), 'nodes', vol);
      if (want('dsp')) {
        const d = await w.js('AT.dsp()');
        console.log('  dsp: ' + JSON.stringify(d));
        check('dsp: the synthesiser (own engine flat out + ERS + slip + grass + 6 remote voices) costs ' + f1(d.usPerBlock) + ' us per 128-frame block = ' + f1(d.realTimeShare * 100) + ' % of real time at 48 kHz (run on the main thread)',
          d.usPerBlock > 0 && d.realTimeShare < 0.15);
        check('dsp: process() allocates nothing on the audio thread (' + f2(d.heapPerBlock) + ' bytes per block, median of ' + d.heapBatches + ' batches)', d.heapPerBlock < 1);
      }
      if (want('dsp')) {
        const d8 = await w.js('AT.dsp({ v8: true })');
        console.log('  dsp (V8): ' + JSON.stringify(d8));
        check('dsp: the same with a V8 at 17 000 rpm: ' + f1(d8.usPerBlock) + ' us per block = ' + f1(d8.realTimeShare * 100) + ' % of real time; ' + f2(d8.heapPerBlock) + ' bytes of heap per block', d8.realTimeShare < 0.15 && d8.heapPerBlock < 1);
      }
      if (want('load')) {
        for (const o of [{}, { v8: true }, { worklet: false }]) {
          const r = await w.js('AT.load(' + JSON.stringify(o) + ')');
          console.log('  load: ' + JSON.stringify(r));
          check('audio-thread load, whole graph rendered offline (' + r.backend + (o.v8 ? ', V8' : '') + ', ' + r.voices + ' remote voices, everything on, 48 kHz): ' + f1(r.load * 100) + ' % of one core (' + Math.round(r.renderMs) + ' ms for ' + r.seconds + ' s)', r.load < 0.25 && r.voices === 6 && r.rmsDb > -40);
        }
      }
      if (want('stall')) {
        const r = await w.js('AT.stall()');
        console.log('  stall: ' + JSON.stringify(r));
        const dB = x => f1(20 * Math.log10(Math.max(x, 1e-9)));
        check('stall guard: update() stops for 1 s -> silent (' + dB(r.stalledLevel) + ' dBFS, was ' + dB(r.running) + '), update() again -> back (' + dB(r.back) + ' dBFS, ' + r.stateBack + ')', r.stalledFlag === true && r.stalledLevel < r.running * 0.01 && r.back > r.running * 0.5 && r.backFlag === false);
        check('stall guard: window hidden -> silent within 0.4 s (' + dB(r.hiddenLevel) + ' dBFS), visible + update() -> back (' + dB(r.visibleAgain) + ' dBFS)', r.hiddenFlag === true && r.hiddenLevel < r.running * 0.01 && r.visibleAgain > r.running * 0.5 && r.errors === 0);
        check('stall guard: hidden while update() keeps coming -> silent within 0.4 s (' + dB(r.hiddenRunLevel) + ' dBFS), setActive(false / true) meanwhile -> still silent (' + dB(r.hiddenReactivated) + ' dBFS), the context sleeps (' +
          r.hiddenRunState + ', ' + r.hiddenRunFrames + ' update() calls so far); visible -> back (' + dB(r.visibleRun) + ' dBFS, ' + r.visibleRunState + ')',
          r.hiddenRunFlag === true && r.hiddenRunLevel < r.running * 0.01 && r.hiddenReactivatedFlag === true && r.hiddenReactivated < r.running * 0.01 && r.hiddenRunState === 'suspended' &&
          r.visibleRunFlag === false && r.visibleRun > r.running * 0.5 && r.visibleRunState === 'running' && r.errors === 0);
      }
      check('nothing on the console during the whole run', w.warnings.length === 0, w.warnings.slice(0, 3));
      w.destroy();
    }
  } catch (e) {
    check('harness ran to the end', false, e && e.stack ? e.stack : String(e));
  }
  const bad = results.filter(r => !r.ok);
  console.log('\n' + (results.length - bad.length) + ' / ' + results.length + ' checks passed' + (bad.length ? '\nFAILED:\n  ' + bad.map(r => r.name).join('\n  ') : ''));
  app.exit(bad.length ? 1 : 0);
});
