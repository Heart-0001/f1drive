// devtests/audio-test: page side of live.js. The real AudioContext, update() driven by requestAnimationFrame.
//   AT.live(opts)     drives a scripted car for a few seconds, taps the master output with an AnalyserNode
//   AT.bench(opts)    update() in a tight loop: time per call, JS heap growth per call
//   AT.robust()       rubbish in, nothing thrown; fallbacks; other sample rates
//   AT.gesture*()     the autoplay-policy path with the game's own instance, F1.audio
(function () {
  'use strict';
  var AT = window.AT, PI = Math.PI;
  var GEAR_KMH = [60, 100, 140, 180, 220, 260, 300], GEAR8 = 345, IDLE = 4000, SHIFT = 11800, MAXR = 12500;
  function gearStep(prev, v) {
    if (!(v >= 0.5)) return 0;
    var k = v * 3.6, g = prev >= 1 ? prev : 1;
    while (g < 8 && k >= GEAR_KMH[g - 1]) g++;
    while (g > 1 && k < GEAR_KMH[g - 2] - 8) g--;
    return g;
  }
  function rpmFor(v, g) { if (g === 0) return IDLE; return Math.min(MAXR, Math.max(IDLE, SHIFT * v * 3.6 / (g >= 8 ? GEAR8 : GEAR_KMH[g - 1]))); }
  function now() { return performance.now(); }
  // microsecond clock from the preload script; hrCost = what one reading costs (taken off every measurement)
  var hr = window.__h && window.__h.hr ? window.__h.hr : function () { return performance.now() * 1000; }, hrCost = 0;
  function calibrate() { var d = [], i, a, b; for (i = 0; i < 4000; i++) { a = hr(); b = hr(); d.push(b - a); } hrCost = quantile(d, 0.5); return { medianUs: hrCost, minUs: quantile(d, 0), p99Us: quantile(d, 0.99) }; }
  function quantile(a, q) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // a car for the live run: full v6 state, three remote cars around it
  function makeWorld() {
    var st = { x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, pitch: 0, roll: 0, sampleIndex: 0, d: 0, onGrass: false, hit: 0,
      throttle: 0, brake: 0, gear: 0, rpm: IDLE, shiftT: 9, battery: 1, deploy: 0, harvest: 0, slip: 0 };
    var L = { x: 0, y: 0.7, z: 0, heading: 0 };
    var others = [{ id: 'a', x: 3.5, y: 0, z: 14, heading: 0, speed: 0 }, { id: 'b', x: -3.5, y: 0, z: -9, heading: 0, speed: 0 }, { id: 'c', x: 0, y: 0, z: 60, heading: 0, speed: 0 }];
    return { st: st, L: L, others: others, step: function (dt, thr, brk) {
      var v = st.speed, g, k;
      v += ((thr > 0 ? Math.min(11, 970.4 / Math.max(v, 1)) * thr : 0) - 0.5 - 0.0012 * v * v - (12 + 0.0032 * v * v) * brk) * dt;
      if (v < 0) v = 0;
      st.speed = v; st.z += v * dt; st.throttle = thr; st.brake = brk;
      g = gearStep(st.gear, v);
      if (g !== st.gear) { st.gear = g; st.shiftT = 0; } else st.shiftT += dt;
      st.rpm = rpmFor(v, g);
      L.z = st.z;
      for (k = 0; k < others.length; k++) { others[k].speed = v * (1 + 0.02 * (k - 1)); others[k].z += others[k].speed * dt; }
    } };
  }

  // opts: { seconds, worklet: false = the node fallback, noWorklet: true = pretend AudioWorklet does not exist }
  AT.live = async function (opts) {
    opts = opts || {};
    var saved = window.AudioWorkletNode, out = { wanted: opts.worklet === false ? 'nodes (forced)' : (opts.noWorklet ? 'nodes (AudioWorkletNode hidden)' : 'worklet') };
    if (opts.noWorklet) window.AudioWorkletNode = undefined;
    var audio = F1.createAudio({ worklet: opts.worklet !== false }), t0 = now();
    var ok = await audio.init({ force: true });
    if (opts.noWorklet) window.AudioWorkletNode = saved;
    out.initMs = now() - t0; out.ready = ok; out.backend = audio.debug.backend;
    if (!ok) return out;
    var ctx = audio.debug.context, an = ctx.createAnalyser(), N = 4096;
    an.fftSize = N; an.smoothingTimeConstant = 0; an.minDecibels = -140;
    audio.debug.output.connect(an);
    var td = new Float32Array(N), fd = new Float32Array(N / 2), world = makeWorld(), dur = opts.seconds || 8.5;
    out.clock = calibrate();
    var frames = [], upd = [], hist = [], maxRed = 0, maxVoices = 0, last = now(), start = last, ctx0 = ctx.currentTime;
    out.sampleRate = ctx.sampleRate; out.baseLatencyMs = (ctx.baseLatency || 0) * 1000; out.outputLatencyMs = (ctx.outputLatency || 0) * 1000;
    if (opts.volume) audio.setVolume(opts.volume);
    var vgain = audio.volume * audio.volume;
    audio.setActive(true);
    await new Promise(function (done) {
      function frame() {
        var t = now(), dt = Math.min(0.1, (t - last) / 1000), el = (t - start) / 1000, a, b, i, s, k, best, f, fe, c, l, r, d;
        last = t;
        world.step(dt, el > 0.5 && el < dur - 2 ? 1 : 0, el >= dur - 1 ? 1 : 0);
        a = hr(); audio.update(dt, world.st, world.L, world.others); b = hr();
        upd.push(Math.max(0, b - a - hrCost));
        hist.push([ctx.currentTime, world.st.rpm, world.st.gear]);
        if (audio.debug.voices > maxVoices) maxVoices = audio.debug.voices;
        if (el > 1.5 && audio.debug.compressor.reduction < maxRed) maxRed = audio.debug.compressor.reduction;      // (the meter starts at -13 dB and needs a second to settle)
        an.getFloatTimeDomainData(td); an.getFloatFrequencyData(fd);
        for (s = 0, i = 0; i < N; i++) s += td[i] * td[i];
        // rpm when the middle of the analyser's window was rendered
        c = ctx.currentTime - N / 2 / ctx.sampleRate - 0.028;
        fe = IDLE / 20;
        for (i = hist.length - 1; i >= 0; i--) if (hist[i][0] <= c) { fe = hist[i][1] / 20; break; }
        best = -1e9; k = -1;
        for (i = Math.max(2, Math.floor(fe * 0.88 * N / ctx.sampleRate)); i <= Math.ceil(fe * 1.12 * N / ctx.sampleRate); i++) if (fd[i] > best) { best = fd[i]; k = i; }
        l = fd[k - 1]; r = fd[k + 1]; d = l - 2 * best + r;
        f = (k + (d < 0 ? 0.5 * (l - r) / d : 0)) * ctx.sampleRate / N;
        frames.push({ t: el, rms: Math.sqrt(s / N), f: f, fe: fe, db: best, rpm: world.st.rpm, gear: world.st.gear, dt: dt });
        if (el < dur) requestAnimationFrame(frame); else done();
      }
      requestAnimationFrame(frame);
    });
    out.state = ctx.state; out.frames = frames.length; out.seconds = (now() - start) / 1000; out.contextSeconds = ctx.currentTime - ctx0;
    out.fps = frames.length / out.seconds;
    var loud = frames.filter(function (x) { return x.t > 0.4; });
    out.silentFrames = loud.filter(function (x) { return !(x.rms > 0.002 * vgain); }).length;
    out.rmsMinDb = 20 * Math.log10(Math.max(1e-9, Math.min.apply(null, loud.map(function (x) { return x.rms; }))));
    out.rmsMaxDb = 20 * Math.log10(Math.max.apply(null, loud.map(function (x) { return x.rms; })));
    out.peak = Math.max.apply(null, frames.map(function (x) { return x.rms; }));
    // pitch: frames where the engine speed is not racing through the window and no gear change is inside it
    var shiftTimes = [];
    frames.forEach(function (x, i) { if (i && x.gear !== frames[i - 1].gear) shiftTimes.push(x.t); });
    var steady = frames.filter(function (x, i) {
      if (x.t < 0.6 || i < 8) return false;
      if (shiftTimes.some(function (s) { return x.t > s - 0.05 && x.t < s + 0.25; })) return false;
      return Math.abs(x.rpm - frames[i - 6].rpm) / (x.t - frames[i - 6].t) < 2500;
    });
    var errs = steady.map(function (x) { return Math.abs(x.f - x.fe) / x.fe; });
    out.pitchFrames = errs.length; out.pitchMedian = quantile(errs, 0.5); out.pitchP95 = quantile(errs, 0.95);
    out.rpmMin = Math.min.apply(null, frames.map(function (x) { return x.rpm; })); out.rpmMax = Math.max.apply(null, frames.map(function (x) { return x.rpm; }));
    out.topGear = Math.max.apply(null, frames.map(function (x) { return x.gear; })); out.shifts = shiftTimes.length;
    out.updMeanUs = upd.reduce(function (a, b) { return a + b; }, 0) / upd.length; out.updMedianUs = quantile(upd, 0.5); out.updP99Us = quantile(upd, 0.99); out.updMaxUs = Math.max.apply(null, upd);
    out.maxVoices = maxVoices; out.compReductionDb = maxRed; out.errors = audio.debug.errors; out.lastError = audio.debug.lastError ? String(audio.debug.lastError) : null;
    // setActive(false): silent after 0.3 s; the context is put to sleep; setActive(true) wakes it
    audio.setActive(false);
    await sleep(320);
    an.getFloatTimeDomainData(td);
    out.afterInactivePeak = Math.max.apply(null, Array.prototype.slice.call(td, N - 512).map(Math.abs));
    await sleep(900);
    out.stateInactive = ctx.state;
    audio.setActive(true);
    await sleep(400);
    for (var q = 0; q < 12; q++) { audio.update(1 / 60, world.st, world.L, world.others); await sleep(16); }
    an.getFloatTimeDomainData(td);
    out.stateReactivated = ctx.state;
    out.afterReactivateRms = Math.sqrt(Array.prototype.reduce.call(td, function (a, b) { return a + b * b; }, 0) / N);
    if (opts.keep) { AT.kept = { audio: audio, world: world, analyser: an }; return out; }
    audio.dispose();
    await sleep(50);
    out.stateDisposed = ctx.state; out.backendAfterDispose = audio.debug.backend;
    return out;
  };

  // update() in a tight loop with a busy scene (own car changing every call, 12 remote cars moving)
  AT.bench = async function (opts) {
    opts = opts || {};
    var audio = F1.createAudio({ worklet: opts.worklet !== false, autoSuspend: false }), out = {};
    out.ready = await audio.init({ force: true }); out.backend = audio.debug.backend;
    audio.setActive(true); audio.setVolume(0);
    var world = makeWorld(), others = [], i, k, n = opts.calls || 20000, t0, t1, res = 1e9, a, b;
    for (i = 0; i < 12; i++) others.push({ id: i, x: (i % 3 - 1) * 3.5, y: 0, z: (i - 6) * 25, heading: 0, speed: 50 });
    out.clock = calibrate();
    function run(count) {
      var dt = 1 / 60, j, q, o;
      for (j = 0; j < count; j++) {
        world.step(dt, (j % 600) < 450 ? 1 : 0, (j % 600) >= 500 ? 1 : 0);
        for (q = 0; q < others.length; q++) { o = others[q]; o.speed = 40 + 30 * Math.sin(j * 0.01 + q); o.z += o.speed * dt - world.st.speed * dt + world.st.speed * dt; o.x = (q % 3 - 1) * 3.5 + Math.sin(j * 0.02 + q); }
        world.others = others;
        audio.update(dt, world.st, world.L, others);
      }
    }
    // the same loop without update(): what the scripted world itself costs
    function runBare(count) {
      var dt = 1 / 60, j, q, o;
      for (j = 0; j < count; j++) {
        world.step(dt, (j % 600) < 450 ? 1 : 0, (j % 600) >= 500 ? 1 : 0);
        for (q = 0; q < others.length; q++) { o = others[q]; o.speed = 40 + 30 * Math.sin(j * 0.01 + q); o.z += o.speed * dt - world.st.speed * dt + world.st.speed * dt; o.x = (q % 3 - 1) * 3.5 + Math.sin(j * 0.02 + q); }
      }
    }
    run(3000); runBare(3000);                       // warm up
    await sleep(50);
    t0 = hr(); runBare(n); t1 = hr(); out.bareUs = (t1 - t0) / n;
    t0 = hr(); run(n); t1 = hr(); out.updateUs = (t1 - t0) / n - out.bareUs;
    // at the real rate: one call per timer tick (the audio thread consumes the parameter changes in between)
    var per = [];
    for (i = 0; i < 600; i++) {
      world.step(1 / 60, 1, 0);
      for (k = 0; k < others.length; k++) { others[k].speed = 40 + 30 * Math.sin(i * 0.01 + k); others[k].z += (others[k].speed - world.st.speed) / 60; }
      a = hr(); audio.update(1 / 60, world.st, world.L, others); b = hr(); per.push(Math.max(0, b - a - hrCost));
      await sleep(4);
    }
    out.spacedMeanUs = per.reduce(function (x, y) { return x + y; }, 0) / per.length; out.spacedMedianUs = quantile(per, 0.5); out.spacedP99Us = quantile(per, 0.99); out.spacedMaxUs = Math.max.apply(null, per);
    // JS heap per call (needs --js-flags=--expose-gc and --enable-precise-memory-info, see live.js)
    if (window.gc && performance.memory) {
      // Bytes the JS heap grows by per call, in batches short enough that no collection runs in between
      // (median of up to 40 batches), for: the loop with update(), the same loop without it, and a control that
      // allocates one two-number array per call on top of update() (to show an allocation would be seen).
      var batch = 500, keepRing = new Array(64), withJunk = function (count) { var j; for (j = 0; j < count; j++) { keepRing[j & 63] = [j, j + 0.5]; audio.update(1 / 60, world.st, world.L, others); } };
      // (each loop is run 30000 times first, so that it is measured as optimised code; a batch in which the collector ran is dropped)
      var heapOf = function (fn) { var v = new Array(40), j, k = 0, h0, h1; fn(30000); window.gc(); for (j = 0; j < 40; j++) { h0 = performance.memory.usedJSHeapSize; fn(batch); h1 = performance.memory.usedJSHeapSize; if (h1 >= h0) v[k++] = (h1 - h0) / batch; } v.length = k; return { n: k, median: quantile(v, 0.5), min: quantile(v, 0), max: quantile(v, 1) }; };
      var plain = function (count) { for (var j = 0; j < count; j++) audio.update(1 / 60, world.st, world.L, others); };
      out.heapBatch = batch; out.heapBare = heapOf(runBare); out.heapPlain = heapOf(plain); out.heapControl = heapOf(withJunk);
      var w0 = audio.debug.paramWrites, c0 = 0;
      out.heapUpdate = heapOf(function (count) { c0 += count; run(count); });
      out.paramWritesPerCall = (audio.debug.paramWrites - w0) / c0;
    }
    out.voices = audio.debug.voices; out.errors = audio.debug.errors; out.lastError = audio.debug.lastError ? String(audio.debug.lastError) : null;
    audio.dispose();
    return out;
  };

  // The synthesiser itself (the AudioWorkletProcessor) run on this thread, where it can be timed and its heap watched:
  // the module source from F1.createAudio.workletSource() evaluated with stand-ins for sampleRate / AudioWorkletProcessor /
  // registerProcessor, process() called on 128-frame blocks with a busy scene (flat out, ERS, slip, grass, 6 voices).
  AT.dsp = function (opts) {
    opts = opts || {};
    var reg = {}, src = F1.createAudio.workletSource(), sr = opts.sampleRate || 48000;
    function Base() { this.port = { onmessage: null, postMessage: function () {} }; }
    new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', src)(sr, Base, function (name, cls) { reg[name] = cls; });
    var Cls = reg['f1-synth'], desc = Cls.parameterDescriptors, params = {}, scale = {}, i;
    F1.createAudio().debug;   // (nothing: just to be sure the module is there)
    desc.forEach(function (d) { params[d.name] = new Float32Array([d.defaultValue]); });
    var tab = {}; desc.forEach(function (d) { tab[d.name] = d; });
    var scaleOf = {}; F1.createAudio.paramTable().forEach(function (p) { scaleOf[p[0]] = p[4]; });
    function set(name, value) { params[name][0] = Math.round(value * scaleOf[name]); }
    set('rpm', 11000); set('load', 1); set('spd', 80); set('tur', 0.9); set('dep', 1); set('har', 0); set('slip', 0.5); set('grass', 1); set('vib', 0.5);
    if (opts.v8) { set('cyl', 8); set('asp', 0); set('rpm', 17000); set('ridle', 4500); set('rmax', 18000); set('tur', 0); }
    for (i = 0; i < 6; i++) { set('f' + i, 400 + 30 * i); set('l' + i, 0.8); set('g' + i, 0.5); set('p' + i, -0.8 + 0.3 * i); set('b' + i, 0.7); }
    var proc = new Cls({ processorOptions: { mask: 63 } }), L = new Float32Array(128), R = new Float32Array(128), outs = [[L, R]], ins = [];
    function run(n) { for (var j = 0; j < n; j++) { L.fill(0); R.fill(0); proc.process(ins, outs, params); } }
    run(4000);                                                  // warm up (and let the voices fade in)
    var t0 = hr(); run(3000); var t1 = hr(), out = { blocks: 3000, usPerBlock: (t1 - t0) / 3000 };
    out.realTimeShare = out.usPerBlock / (128 / sr * 1e6);
    var pk = 0; for (i = 0; i < 128; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    out.peak = pk;
    if (window.gc && performance.memory) {
      var v = [], j, h0, h1;
      window.gc();
      for (j = 0; j < 30; j++) { h0 = performance.memory.usedJSHeapSize; run(200); h1 = performance.memory.usedJSHeapSize; if (h1 >= h0) v.push((h1 - h0) / 200); }
      out.heapPerBlock = quantile(v, 0.5); out.heapBatches = v.length;
    }
    return out;
  };

  // frequency of the strongest partial near f (Goertzel scan), for the sample-rate check
  function peakNear(x, sr, f, a, b) {
    var best = 0, at = 0, ff, w, s1, s2, s0, i, p;
    for (ff = f * 0.97; ff <= f * 1.03; ff += 0.1) {
      w = 2 * Math.cos(2 * PI * ff / sr); s1 = 0; s2 = 0;
      for (i = a; i < b; i++) { s0 = x[i] * (0.5 - 0.5 * Math.cos(2 * PI * (i - a) / (b - a))) + w * s1 - s2; s2 = s1; s1 = s0; }
      p = s1 * s1 + s2 * s2 - w * s1 * s2;
      if (p > best) { best = p; at = ff; }
    }
    return at;
  }

  AT.robust = async function () {
    var res = [], threw = 0;
    function check(name, ok, detail) { res.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) }); }
    function tryIt(fn) { try { fn(); return true; } catch (e) { threw++; return String(e); } }
    var junkOwn = [undefined, null, 0, 'car', {}, { speed: NaN }, { speed: Infinity, rpm: -Infinity, gear: 'x', throttle: -5, brake: 9, shiftT: NaN, deploy: 'a', harvest: {}, slip: [], hit: NaN, onGrass: 'yes' },
      { speed: 1e9, rpm: 1e9, gear: 99, throttle: 2, hit: 7, heading: NaN, x: NaN, y: NaN, z: NaN }, { speed: -40, gear: -1, rpm: 0 }, { speed: 80, rpm: 12500, throttle: 1, gear: 8, hit: 1, slip: 1, onGrass: true, deploy: 1, harvest: 1 }];
    var junkL = [undefined, null, {}, { x: NaN, y: NaN, z: NaN, heading: NaN }, { x: 1e12, y: 0, z: -1e12, heading: 1e9 }, 7, 'x'];
    var huge = [], i, k;
    for (i = 0; i < 20000; i++) huge.push({ id: i % 50, x: Math.sin(i) * 400, y: 0, z: Math.cos(i * 1.3) * 400, heading: i, speed: (i % 90) });
    var junkOthers = [undefined, null, [], 5, 'cars', {}, { length: 3 }, { length: -1 }, { length: 1e9 }, [null, undefined, 3, 'a', {}, { x: NaN, z: 2 }, { x: 1, z: NaN }, { id: {}, x: 1, y: NaN, z: 2, heading: NaN, speed: NaN },
      { id: 'a', x: Infinity, z: 0 }, { id: 'a', x: 3, z: 4, heading: 0, speed: 1e9 }, { id: 'a', x: 3, z: 4 }, { x: 5, z: 5 }, { id: null, x: 6, z: 6, speed: -30, heading: 2 }], huge];
    var junkDt = [1 / 60, 0, -1, NaN, Infinity, 'a', undefined, null, 5, 1e-9];

    // 1. before anything exists
    var a0 = F1.createAudio();
    var r = tryIt(function () { junkDt.forEach(function (dt) { junkOwn.forEach(function (o) { a0.update(dt, o, junkL[0], junkOthers[0]); }); }); a0.beep('light'); a0.beep(); a0.setActive(true); a0.setActive(false); a0.setVolume(0.4); a0.setMuted(true); a0.dispose(); a0.dispose(); });
    check('no context yet: update / beep / setActive / setVolume / setMuted / dispose do nothing and do not throw', r === true && a0.debug.errors === 0, r === true ? a0.debug.lastError && String(a0.debug.lastError) : r);

    // 2. every combination of rubbish, both back ends, rendered
    for (k = 0; k < 2; k++) {
      var ctx = new OfflineAudioContext(2, 48000 * 3, 48000), a = F1.createAudio({ context: ctx, worklet: k === 0 }), n = 0, slow = 0, t, worst = 0;
      await a.init();
      a.setActive(true);
      r = tryIt(function () {
        junkDt.forEach(function (dt) { junkOwn.forEach(function (o) { junkL.forEach(function (l) { junkOthers.forEach(function (ot) {
          var t0 = now(); a.update(dt, o, l, ot); t = now() - t0; if (t > worst) worst = t; n++;
        }); }); }); });
        [NaN, -1, 5, 'x', undefined, null, 0.5].forEach(function (v) { a.setVolume(v); });
        ['x', 0, 1, null].forEach(function (v) { a.setMuted(v); a.setActive(v); });
        a.setMuted(false); a.setActive(true); a.setVolume(1);
        ['light', 'go', 'nonsense', undefined, 3].forEach(function (b) { a.beep(b); });
      });
      for (i = 1; i < 170; i++) (function (j) { ctx.suspend(j / 60).then(function () {
        try { a.update(junkDt[j % junkDt.length], junkOwn[j % junkOwn.length], junkL[j % junkL.length], junkOthers[j % junkOthers.length]); if (j % 40 === 0) a.beep('light'); } catch (e) { threw++; }
        ctx.resume();
      }); })(i);
      var buf = await ctx.startRendering(), bad = 0, peak = 0, c, d;
      for (c = 0; c < 2; c++) { d = buf.getChannelData(c); for (i = 0; i < d.length; i++) { if (d[i] !== d[i] || d[i] === Infinity || d[i] === -Infinity) bad++; if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]); } }
      check(a.debug.backend + ': ' + n + ' combinations of bad dt / own / listener / others (NaN, Infinity, strings, null, missing fields, duplicate and missing ids, a 20000-entry list) + bad volume / mute / beep arguments: nothing thrown, nothing caught inside',
        r === true && a.debug.errors === 0, r === true ? (a.debug.lastError ? String(a.debug.lastError.stack || a.debug.lastError) : '') : r);
      check(a.debug.backend + ': the rendered output of that stays finite and unclipped (NaN / Infinity samples: ' + bad + ', peak ' + peak.toFixed(3) + ')', bad === 0 && peak < 0.95);
      check(a.debug.backend + ': volume and mute end up clamped (volume ' + a.volume + ', muted ' + a.muted + ')', a.volume === 1 && a.muted === false);
      check(a.debug.backend + ': never more than MAX_VOICES voices with the 20000-entry list (' + a.debug.voices + '), slowest single update() ' + (worst * 1000).toFixed(0) + ' us', a.debug.voices <= a.MAX_VOICES && worst < 2);
      a.dispose();
    }

    // 3. a car state whose fields throw when read: caught inside, counted, the game loop is not interrupted
    var ctx3 = new OfflineAudioContext(2, 4800, 48000), a3 = F1.createAudio({ context: ctx3 }), evil = {}, warn = console.warn, warned = 0;
    Object.defineProperty(evil, 'speed', { get: function () { throw new Error('boom'); } });
    await a3.init();
    console.warn = function () { warned++; };
    r = tryIt(function () { for (var j = 0; j < 5; j++) a3.update(1 / 60, evil, null, null); });
    console.warn = warn;
    check('a state that throws on access: update() returns normally (errors counted: ' + a3.debug.errors + ', console.warn once: ' + warned + ')', r === true && a3.debug.errors === 5 && warned === 1);
    a3.dispose();

    // 4. no AudioWorklet -> the node graph, by itself
    var savedNode = window.AudioWorkletNode, ctx4 = new OfflineAudioContext(2, 4800, 48000), a4;
    window.AudioWorkletNode = undefined;
    a4 = F1.createAudio({ context: ctx4 });
    var ok4 = await a4.init();
    window.AudioWorkletNode = savedNode;
    check('AudioWorkletNode missing: init() succeeds on the node fallback (' + a4.debug.backend + ')', ok4 === true && a4.debug.backend === 'nodes');
    a4.dispose();
    // ... and when the module cannot be loaded (what a Content-Security-Policy without blob: / data: would do)
    var ctx5 = new OfflineAudioContext(2, 4800, 48000), a5 = F1.createAudio({ context: ctx5 }), orig = ctx5.audioWorklet.addModule, calls = [];
    ctx5.audioWorklet.addModule = function (u) { calls.push(String(u).slice(0, 5)); return Promise.reject(new Error('refused')); };
    var ok5 = await a5.init();
    ctx5.audioWorklet.addModule = orig;
    check('worklet module refused (blob: URL, then data: URL): init() still succeeds, on the node fallback (' + a5.debug.backend + '; tried ' + calls.join(', ') + ')', ok5 === true && a5.debug.backend === 'nodes' && calls.length === 2 && calls[0] === 'blob:' && calls[1] === 'data:');
    a5.dispose();
    // the module itself loads from a data: URL too
    var ctx6 = new OfflineAudioContext(2, 4800, 48000), a6 = F1.createAudio({ context: ctx6 }), orig6 = ctx6.audioWorklet.addModule, n6 = 0;
    ctx6.audioWorklet.addModule = function (u) { n6++; return String(u).indexOf('blob:') === 0 ? Promise.reject(new Error('no blob')) : orig6.call(ctx6.audioWorklet, u); };
    var ok6 = await a6.init();
    check('blob: URL refused only: the worklet loads from the data: URL (' + a6.debug.backend + ')', ok6 === true && a6.debug.backend === 'worklet' && n6 === 2);
    a6.dispose();

    // 5. init() twice, two instances on one context, dispose while building, init after dispose
    var ctx7 = new OfflineAudioContext(2, 4800, 48000), a7 = F1.createAudio({ context: ctx7 }), b7 = F1.createAudio({ context: ctx7 });
    var p1 = a7.init(), p2 = a7.init(), r7 = await Promise.all([p1, p2, b7.init()]);
    check('init() is repeatable, and a second instance on the same context gets the worklet too (' + r7.join(', ') + '; ' + a7.debug.backend + ' / ' + b7.debug.backend + ')',
      r7[0] === true && r7[1] === true && r7[2] === true && a7.debug.backend === 'worklet' && b7.debug.backend === 'worklet');
    a7.dispose(); b7.dispose();
    var ctx8 = new OfflineAudioContext(2, 4800, 48000), a8 = F1.createAudio({ context: ctx8 }), p8 = a8.init();
    a8.dispose();
    var r8 = await p8;
    check('dispose() while the graph is being built: init() resolves false, nothing left behind (' + r8 + ', ' + a8.debug.backend + ')', r8 === false && a8.debug.backend === 'none' && a8.debug.ready === false);
    var r9 = await a8.init();
    check('init() after dispose() builds a fresh graph (' + r9 + ', ' + a8.debug.backend + ')', r9 === true && a8.debug.ready === true);
    a8.dispose();

    // 6. other sample rates: the pitch is the same
    var rates = [22050, 44100, 96000], got = [];
    for (k = 0; k < rates.length; k++) {
      for (var be = 0; be < 2; be++) {
        var sr = rates[k], cx = new OfflineAudioContext(2, sr * 1.5, sr), ax = F1.createAudio({ context: cx, worklet: be === 0, mask: 1 });
        await ax.init();
        ax.setActive(true);
        var stx = { speed: 150 / 3.6, gear: 4, rpm: 9833.33, throttle: 1 };
        ax.update(1 / 60, stx, null, null);
        for (i = 1; i < 85; i++) (function (j) { cx.suspend(j / 60).then(function () { ax.update(1 / 60, stx, null, null); cx.resume(); }); })(i);
        var bx = (await cx.startRendering()).getChannelData(0), fx = peakNear(bx, sr, 9833.33 / 20, Math.round(sr * 0.4), Math.round(sr * 1.4)), pk = 0;
        for (i = 0; i < bx.length; i++) if (Math.abs(bx[i]) > pk) pk = Math.abs(bx[i]);
        got.push({ rate: sr, backend: ax.debug.backend, hz: +fx.toFixed(2), peak: +pk.toFixed(3) });
        ax.dispose();
      }
    }
    check('sample rates 22.05 / 44.1 / 96 kHz: 9833 rpm is 491.67 Hz on both back ends (' + got.map(function (g) { return g.rate / 1000 + 'k ' + g.backend + ' ' + g.hz; }).join(', ') + ')',
      got.every(function (g) { return Math.abs(g.hz - 491.67) < 0.6 && g.peak > 0.05 && g.peak < 0.9; }));

    // 7. (second review) setEngine / play / per-car spec with rubbish; a context closed behind the module's back
    var ctxA = new OfflineAudioContext(2, 48000 * 2, 48000), aA = F1.createAudio({ context: ctxA }), specs = [null, undefined, 3, 'V8', {}, { cylinders: 7 }, { cylinders: 8 },
      { gearKmh: [300, 100], topKmh: 50 }, { gearKmh: 'x', rpmMax: NaN, rpmIdle: -5 }, { gearKmh: [80, 120, 160], topKmh: 200, rpmIdle: 5000, rpmShift: 17000, rpmMax: 18000, cylinders: 8, aspiration: 'na', shiftTime: 0.04 },
      { rpmIdle: 20000, rpmShift: 1000 }, { shiftTime: 5, aspiration: 42 }];
    await aA.init(); aA.setActive(true);
    r = tryIt(function () {
      specs.forEach(function (sp, j) {
        aA.setEngine(sp);
        aA.update(1 / 60, { speed: 20 + j * 7, throttle: 1 }, null, [{ id: 1, x: 5, z: 5, speed: 40, heading: 0, spec: specs[(j + 3) % specs.length] }, { id: 2, x: -5, z: 9, speed: 60, heading: 1, spec: sp }]);
      });
      ['pitgun', 'jack', 'limiterOn', 'limiterOff', 'nonsense', undefined, 7, 'toString', '__proto__', 'hasOwnProperty'].forEach(function (k) { aA.play(k); aA.play(k, NaN); aA.play(k, -3); aA.play(k, 99); });
    });
    var eng = aA.debug.engine;
    check('setEngine / play / others[].spec with rubbish: nothing thrown or caught, the engine stays sane (last: ' + eng.cyl + ' cylinders, ' + eng.idle + ' .. ' + eng.shift + ' .. ' + eng.max + ' rpm, ' + eng.n + ' gears, shift ' + eng.shiftTime + ' s)',
      r === true && aA.debug.errors === 0 && eng.idle < eng.shift && eng.shift <= eng.max && eng.n >= 2 && (eng.cyl % 2) === 0 && eng.shiftTime >= 0.01 && eng.shiftTime <= 0.2, r === true ? (aA.debug.lastError ? String(aA.debug.lastError) : '') : r);
    aA.setEngine({ gearKmh: [80, 120, 160], topKmh: 200, rpmIdle: 5000, rpmShift: 17000, rpmMax: 18000, cylinders: 8, aspiration: 'na' });
    check('setEngine takes a V8 spec (gear at 150 km/h ' + aA.gearFor(150 / 3.6) + ', rpm ' + Math.round(aA.rpmFor(150 / 3.6)) + '; 17000 * 150 / 160 = 15938)', aA.gearFor(150 / 3.6) === 3 && Math.abs(aA.rpmFor(150 / 3.6) - 15937.5) < 1 && aA.debug.engine.na === 1);
    aA.dispose();
    var aC = F1.createAudio();
    await aC.init();
    var c1 = aC.debug.context;
    await c1.close();
    var okC = await aC.init();
    await sleep(100);
    check('own context closed behind its back: init() builds a new one (' + okC + ', ' + (aC.debug.context && aC.debug.context.state) + ', old ' + c1.state + ')', okC === true && aC.debug.context !== c1 && aC.debug.context.state === 'running');
    aC.dispose();
    return { checks: res, threw: threw };
  };

  // (second review) The stall guard: a game loop that stops calling update(), and a hidden window. Real context.
  AT.stall = async function () {
    var a = F1.createAudio(), out = {};
    await a.init(); a.setActive(true);
    var ctx = a.debug.context, an = ctx.createAnalyser(), td = new Float32Array(2048), run = true;
    an.fftSize = 2048; a.debug.output.connect(an);
    function lvl() { an.getFloatTimeDomainData(td); var s = 0; for (var i = 0; i < td.length; i++) s += td[i] * td[i]; return Math.sqrt(s / td.length); }
    var st = { speed: 50, throttle: 1, x: 0, y: 0, z: 0, heading: 0 };
    function loop() { if (!run) return; a.update(1 / 60, st, null, []); setTimeout(loop, 16); }
    loop(); await sleep(800); out.running = lvl();
    run = false; await sleep(1000); out.stalledLevel = lvl(); out.stalledFlag = a.debug.stalled;
    run = true; loop(); await sleep(500); out.back = lvl(); out.backFlag = a.debug.stalled; out.stateBack = ctx.state;
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } });
    document.dispatchEvent(new Event('visibilitychange'));
    run = false;                                               // (a hidden window's requestAnimationFrame stops too)
    await sleep(400); out.hiddenLevel = lvl(); out.hiddenFlag = a.debug.stalled;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    run = true; loop(); await sleep(500); out.visibleAgain = lvl();
    // (third review) hidden while the loop goes on calling update() (a loop that is not requestAnimationFrame, or a
    // window that keeps it running): neither update() nor setActive(true) may bring the sound back while hidden, and
    // the context goes to sleep and stays asleep
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return true; } });
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(400); out.hiddenRunLevel = lvl(); out.hiddenRunFlag = a.debug.stalled;
    a.setActive(false); a.setActive(true); a.setActive(true);
    await sleep(300); out.hiddenReactivated = lvl(); out.hiddenReactivatedFlag = a.debug.stalled;
    await sleep(1400); out.hiddenRunState = ctx.state; out.hiddenRunFrames = a.debug.frames;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(500); out.visibleRun = lvl(); out.visibleRunFlag = a.debug.stalled; out.visibleRunState = ctx.state;
    run = false; out.errors = a.debug.errors;
    a.dispose();
    return out;
  };

  // (second review) Audio-thread load: the whole graph rendered as fast as it goes (OfflineAudioContext, 20 s), busy
  // scene: own engine flat out + ERS + slip + grass + flat spot + MAX_VOICES remote cars. Render time / audio time is
  // the share of one core the audio thread needs for this graph (the worklet plus Chromium's own nodes).
  AT.load = async function (opts) {
    opts = opts || {};
    var sr = opts.sampleRate || 48000, secs = 20, ctx = new OfflineAudioContext(2, sr * secs, sr), a = F1.createAudio({ context: ctx, worklet: opts.worklet !== false }), others = [], k;
    await a.init(); a.setActive(true);
    if (opts.v8) a.setEngine({ gearKmh: [100, 140, 175, 210, 245, 285], topKmh: 335, rpmIdle: 4500, rpmShift: 17800, rpmMax: 18000, cylinders: 8, aspiration: 'na' });
    for (k = 0; k < a.MAX_VOICES; k++) others.push({ id: k, x: (k - 3) * 4, y: 0, z: 8 + k * 7, speed: 70, heading: 0 });
    var st = { speed: 80, throttle: 1, deploy: 1, slip: 0.6, onGrass: true, vib: 0.5, x: 0, y: 0, z: 0, heading: 0 };
    a.update(1 / 60, st, { x: 0, y: 0.7, z: 0, heading: 0 }, others);
    var t0 = performance.now(), buf = await ctx.startRendering(), ms = performance.now() - t0, d = buf.getChannelData(0), s = 0, i;
    for (i = sr; i < d.length; i++) s += d[i] * d[i];
    var out = { backend: a.debug.backend, voices: a.debug.voices, sampleRate: sr, seconds: secs, renderMs: ms, load: ms / (secs * 1000), rmsDb: 10 * Math.log10(s / (d.length - sr)) };
    a.dispose();
    return out;
  };

  // ---- autoplay policy, with the game's own instance ----
  async function levelOf(a) {
    var an = a.debug.context.createAnalyser(), td = new Float32Array(2048), s = 0, i;
    a.debug.output.connect(an);
    await sleep(300);
    an.getFloatTimeDomainData(td);
    for (i = 0; i < td.length; i++) s += td[i] * td[i];
    return Math.sqrt(s / td.length);
  }
  AT.gestureDefault = async function () {
    var a = F1.audio, out = {}, i;
    out.activation = navigator.userActivation ? navigator.userActivation.hasBeenActive : null;
    out.init = await a.init();
    a.setActive(true);
    for (i = 0; i < 30; i++) { a.update(1 / 60, { speed: 60, throttle: 1 }, { x: 0, y: 0, z: 0, heading: 0 }, []); await sleep(16); }
    out.backend = a.debug.backend; out.state = a.debug.context ? a.debug.context.state : 'no context';
    out.rms = await levelOf(a); out.errors = a.debug.errors;
    a.dispose();
    return out;
  };
  AT.gestureBefore = async function () {
    var a = F1.audio, out = {};
    out.activation = navigator.userActivation ? navigator.userActivation.hasBeenActive : null;
    out.init = await a.init();
    out.state = a.debug.context ? a.debug.context.state : 'no context'; out.ready = a.debug.ready;
    try { a.setActive(true); for (var i = 0; i < 40; i++) a.update(1 / 60, { speed: 30 }, { x: 0, y: 0, z: 0, heading: 0 }, []); a.beep('light'); out.threw = false; } catch (e) { out.threw = String(e); }
    out.errors = a.debug.errors;
    window.addEventListener('keydown', function () { AT.gestureInit = F1.audio.init(); });
    // keep calling update() like the game loop does
    AT.gestureLoop = setInterval(function () { a.update(1 / 60, { speed: 60, throttle: 1 }, { x: 0, y: 0, z: 0, heading: 0 }, []); }, 16);
    return out;
  };
  AT.gestureAfter = async function () {
    var a = F1.audio, out = {};
    out.activation = navigator.userActivation ? navigator.userActivation.hasBeenActive : null;
    out.init = AT.gestureInit ? await AT.gestureInit : 'keydown handler did not run';
    await sleep(500);
    out.backend = a.debug.backend; out.state = a.debug.context ? a.debug.context.state : 'no context';
    if (a.debug.output) out.rms = await levelOf(a);
    clearInterval(AT.gestureLoop);
    out.errors = a.debug.errors;
    a.dispose();
    return out;
  };
  // the same without ever asking: update() alone must start it once a gesture has happened (init() was called too early)
  AT.lazyBefore = async function () {
    var a = F1.createAudio(), out = {};
    AT.lazy = a;
    out.init = await a.init();                   // too early: no gesture yet
    a.setActive(true);
    AT.gestureLoop = setInterval(function () { a.update(1 / 60, { speed: 60, throttle: 1 }, { x: 0, y: 0, z: 0, heading: 0 }, []); }, 16);
    out.state = a.debug.context ? a.debug.context.state : 'no context';
    return out;
  };
  AT.lazyAfter = async function () {
    var a = AT.lazy, out = {}, i;
    for (i = 0; i < 40 && !(a.debug.context && a.debug.context.state === 'running'); i++) await sleep(50);
    await sleep(300);
    out.ready = a.debug.ready; out.backend = a.debug.backend; out.state = a.debug.context ? a.debug.context.state : 'no context';
    clearInterval(AT.gestureLoop);
    a.dispose();
    return out;
  };

  // ---- minimise-test.js: the game's instance driven from requestAnimationFrame, as main.js does, in a window the
  //      harness minimises / hides. What the page sees of it, and the level at the master output ----
  AT.win = null;
  AT.winStart = async function () {
    var a = F1.audio, w = AT.win = { frames: 0, vis: [], run: true, an: null, td: new Float32Array(2048) }, last = 0;
    var st = { speed: 60, gear: 5, rpm: 9000, throttle: 1, brake: 0, x: 0, y: 0, z: 0, heading: 0 }, L = { x: 0, y: 0.7, z: 0, heading: 0 };
    var ok = await a.init();
    a.setActive(true);
    document.addEventListener('visibilitychange', function () { w.vis.push(document.visibilityState); });
    function loop(t) {
      if (!w.run) return;
      requestAnimationFrame(loop);
      var dt = last ? (t - last) / 1000 : 0; last = t;
      w.frames++; st.z += st.speed * Math.min(dt, 0.1); L.z = st.z;
      a.update(dt, st, L, []);
    }
    requestAnimationFrame(loop);
    w.an = a.debug.context.createAnalyser(); w.an.fftSize = 2048; a.debug.output.connect(w.an);
    return { init: ok, backend: a.debug.backend, state: a.debug.context.state };
  };
  AT.winSample = function () {
    var a = F1.audio, w = AT.win, s = 0, i;
    w.an.getFloatTimeDomainData(w.td);
    for (i = 0; i < w.td.length; i++) s += w.td[i] * w.td[i];
    return { frames: w.frames, hidden: document.hidden, vis: w.vis.slice(), active: a.active, stalled: a.debug.stalled, state: a.debug.context.state,
      rmsDb: Math.round(10 * Math.log10(s / w.td.length + 1e-20) * 10) / 10, errors: a.debug.errors };
  };
  AT.winStop = function () { AT.win.run = false; F1.audio.dispose(); };
})();
