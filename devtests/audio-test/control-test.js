// devtests/audio-test/control-test.js - the control layer of js/audio.js in plain node (no Web Audio: the module runs
// its per-frame logic and reports through .debug; part 6 gives it a fake offline context to watch the tunnel reverb's
// graph). Deterministic, fast.   node devtests/audio-test/control-test.js
'use strict';
const path = require('path');
let fails = 0, n = 0;
function check(name, ok, detail) { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
function load(pre) {                                   // a fresh copy of the module with F1 set up as `pre` says
  delete require.cache[require.resolve('../../js/audio.js')];
  globalThis.F1 = pre || {};
  require('../../js/audio.js');
  return globalThis.F1;
}
const near = (a, b, e) => Math.abs(a - b) <= e;

// 1. defaults: the contract's drivetrain
let F1 = load();
let a = F1.createAudio();
check('no Web Audio here: supported false, init() resolves false', a.supported === false);
check('contract drivetrain: 150 km/h is gear 4 at 11800 * 150 / 180 = 9833 rpm', a.gearFor(150 / 3.6) === 4 && near(a.rpmFor(150 / 3.6), 9833.3, 0.5));
check('contract drivetrain: 0 km/h idles at 4000, 400 km/h is capped at 12500', a.rpmFor(0) === 4000 && a.rpmFor(400 / 3.6) === 12500);

// 2. F1.CAR_PERF (today's car.js) and F1.REF_SPEC (the v6 car.js) are picked up
F1 = load({ CAR_PERF: { GEAR_KMH: [50, 90, 130, 170, 210, 250, 290], GEAR8_KMH: 330, RPM_IDLE: 3800, RPM_SHIFT: 11500, RPM_MAX: 12000, power: 900 } });
a = F1.createAudio();
check('F1.CAR_PERF drivetrain: 100 km/h is gear 3 at 11500 * 100 / 130', a.gearFor(100 / 3.6) === 3 && near(a.rpmFor(100 / 3.6), 11500 * 100 / 130, 0.5));
F1 = load({ REF_SPEC: { gearKmh: [70, 110, 150, 190, 230, 270, 310], topKmh: 350, rpmIdle: 4200, rpmShift: 12000, rpmMax: 13000, cylinders: 6, aspiration: 'hybrid', shiftTime: 0.06 } });
a = F1.createAudio();
check('F1.REF_SPEC drivetrain: 100 km/h is gear 2 at 12000 * 100 / 110; shift time 60 ms', a.gearFor(100 / 3.6) === 2 && near(a.rpmFor(100 / 3.6), 12000 * 100 / 110, 0.5) && a.debug.engine.shiftTime === 0.06);

// 3. setEngine: a V8, and what the control vector carries
F1 = load();
a = F1.createAudio();
const V8 = { gearKmh: [100, 140, 175, 210, 245, 285], topKmh: 335, rpmIdle: 4500, rpmShift: 17800, rpmMax: 18000, cylinders: 8, aspiration: 'na', shiftTime: 0.04 };
a.setEngine(V8);
const tab = F1.createAudio.paramTable(), ix = {}; tab.forEach((p, i) => ix[p[0]] = i);
check('setEngine(V8): 7 gears, 18 000 rpm, 8 cylinders, NA, 40 ms cut in the control vector', a.debug.engine.n === 7 && a.debug.ctl[ix.cyl] === 8 && a.debug.ctl[ix.asp] === 0 && a.debug.ctl[ix.rmax] === 18000 && a.debug.ctl[ix.stime] === 40);
check('setEngine(V8): 300 km/h is gear 7 at 17800 * 300 / 335', a.gearFor(300 / 3.6) === 7 && near(a.rpmFor(300 / 3.6), 17800 * 300 / 335, 0.5));
a.setEngine(null);
check('setEngine(null): back to the reference car', a.debug.engine.cyl === 6 && a.debug.engine.max === 12500);

// 4. own car: rpm / gear fallbacks, shift events, cut / blip, rev and pit limiter
F1 = load(); a = F1.createAudio();
const L = { x: 0, y: 0.7, z: 0, heading: 0 };
let st = { speed: 0, x: 0, y: 0, z: 0, heading: 0 };
a.update(1 / 60, st, L, []);
check('speed only: standing = gear 0, idle rpm', a.debug.gear === 0 && a.debug.rpm === 4000);
// accelerate through gear 1 -> 2 with speed only
let ups0 = a.debug.upshifts;
for (let v = 10; v <= 70; v += 0.5) { st.speed = v / 3.6; st.z += st.speed / 60; a.update(1 / 60, st, L, []); }
check('speed only: an upshift is detected and counted (gear ' + a.debug.gear + ', upshifts ' + a.debug.upshifts + ')', a.debug.gear === 2 && a.debug.upshifts === ups0 + 1 && a.debug.ctl[ix.up] === a.debug.upshifts);
check('speed only: the throttle is guessed from the acceleration (' + a.debug.throttle.toFixed(2) + ')', a.debug.throttle > 0.3);
// car.js-style state with gear / rpm / shiftDir: downshift counts as a downshift
st = { speed: 150 / 3.6, gear: 4, rpm: 9833, throttle: 1, brake: 0, x: 0, y: 0, z: 0, heading: 0 };
a.update(1 / 60, st, L, []);
let dn0 = a.debug.downshifts;
st.gear = 3; st.rpm = 11000; st.shiftDir = -1; st.shiftT = 0; st.throttle = 0;
a.update(1 / 60, st, L, []);
check('car.state gear 4 -> 3: a downshift, blip on, the given rpm used', a.debug.downshifts === dn0 + 1 && a.debug.blip === 1 && a.debug.rpm === 11000 && a.debug.ctl[ix.dn] === a.debug.downshifts);
st.rpm = 12500; st.throttle = 1; a.update(1 / 60, st, L, []);
check('rpm at rpmMax on throttle: rev limiter (mode 1)', a.debug.ctl[ix.lim] === 1);
// pit limiter: held at 80 km/h, throttle open -> mode 2; accelerating below the limit -> not
st = { speed: 50 / 3.6, gear: 2, rpm: 9000, throttle: 1, limiter: true, x: 0, y: 0, z: 0, heading: 0 };
for (let i = 0; i < 20; i++) { st.speed += 8 / 60; a.update(1 / 60, st, L, []); }
const accel = a.debug.ctl[ix.lim];
st.speed = 80 / 3.6; for (let i = 0; i < 30; i++) a.update(1 / 60, st, L, []);
const held = a.debug.ctl[ix.lim];
st.throttle = 0; for (let i = 0; i < 30; i++) a.update(1 / 60, st, L, []);
const lifted = a.debug.ctl[ix.lim];
st.throttle = 1; st.limiter = false; for (let i = 0; i < 5; i++) a.update(1 / 60, st, L, []);
check('pit limiter: accelerating below the limit no (' + accel + '), held at the limit yes (' + held + '), throttle closed no (' + lifted + '), limiter off no (' + a.debug.ctl[ix.lim] + ')', accel === 0 && held === 2 && lifted === 0 && a.debug.ctl[ix.lim] === 0);
st.limiter = true; st.limitKmh = 60; for (let i = 0; i < 30; i++) a.update(1 / 60, st, L, []);
check('pit limiter with own.limitKmh 60 at 80 km/h: stutters', a.debug.ctl[ix.lim] === 2);
st.limitKmh = 100; for (let i = 0; i < 30; i++) a.update(1 / 60, st, L, []);
check('pit limiter with own.limitKmh 100 at 80 km/h (below it): no stutter', a.debug.ctl[ix.lim] === 0);
st.vib = 0.7; a.update(1 / 60, st, L, []);
check('state.vib reaches the control vector', near(a.debug.ctl[ix.vib] / 1, 0.7, 0.01) || near(a.debug.ctl[ix.vib], 0.703125, 0.01));

// 5. remote cars: own spec per car, Doppler, voices
F1 = load(); a = F1.createAudio();
const me = { speed: 0, x: 0, y: 0, z: 0, heading: 0 };
const others = [{ id: 'v6', x: 5, y: 0, z: -100, heading: 0, speed: 300 / 3.6 }, { id: 'v8', x: -5, y: 0, z: -100, heading: 0, speed: 300 / 3.6, spec: V8 }];
for (let i = 0; i < 30; i++) a.update(1 / 60, me, L, others);
const vi = id => a.debug.voiceId.indexOf(id);
const d6 = a.debug.voiceDoppler[vi('v6')], r6 = a.debug.voiceRpm[vi('v6')], r8 = a.debug.voiceRpm[vi('v8')];
const theory = 343 / (343 - 300 / 3.6 * 100 / Math.hypot(5, 100, 0.7));
check('remote without a spec uses the own engine (V6 rpm ' + Math.round(r6) + ' = 11800 * 300 / 345)', near(r6, 11800 * 300 / 345, 2));
check('remote with a V8 spec uses it (rpm ' + Math.round(r8) + ' = 17800 * 300 / 335)', near(r8, 17800 * 300 / 335, 2));
const f6 = a.debug.ctl[ix.f0 + vi('v6') * 5], f8 = a.debug.ctl[ix.f0 + vi('v8') * 5];
check('firing frequencies: V6 rpm / 20 * Doppler (' + f6.toFixed(1) + ' Hz), V8 rpm / 15 * Doppler (' + f8.toFixed(1) + ' Hz)', near(f6, r6 / 20 * d6, 0.5) && near(f8, r8 / 15 * a.debug.voiceDoppler[vi('v8')], 0.5));
check('Doppler approaching at 300 km/h: ' + d6.toFixed(4) + ' vs theory ' + theory.toFixed(4), near(d6, theory, 0.003));
// 40 cars: never more than MAX_VOICES
const many = []; for (let k = 0; k < 40; k++) many.push({ id: k, x: (k % 5) * 3, y: 0, z: 10 + k * 5, heading: 0, speed: 50 });
for (let i = 0; i < 60; i++) a.update(1 / 60, me, L, many);
check('40 remote cars: ' + a.debug.voices + ' voices (MAX_VOICES ' + a.MAX_VOICES + ')', a.debug.voices === a.MAX_VOICES);
// dt 0 and huge dt, NaN fields
let threw = false;
try { a.update(0, { speed: NaN, rpm: 'x', gear: {}, throttle: Infinity }, null, [{ x: NaN }, null, 5]); a.update(1e9, me, L, many); a.update(-1, undefined, undefined, undefined); } catch (e) { threw = true; }
check('dt 0 / 1e9 / -1, NaN and junk fields: nothing thrown, nothing caught (' + a.debug.errors + ')', !threw && a.debug.errors === 0);

// 6. tunnel reverb (review r3 PRES-2): the impulse response is made once per size class, not at every stretch of a
//    slightly other size (Monaco: Portier 23.5 m, the tunnel 25 m; each new one costs 10-20 ms on the main thread).
//    A fake offline context (plain nodes back end) records the graph; F1.tunnelImpulse is a stub that counts calls.
function fakeContext() {
  const made = { convolvers: [], bufferSets: 0 };
  const param = v => ({ value: v, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    cancelScheduledValues() {}, cancelAndHoldAtTime() {} });
  function node(kind, params) {
    const o = { kind, ins: new Set(), outs: new Set(), start() {}, stop() {}, setPeriodicWave() {} };
    o.connect = d => { o.outs.add(d); if (d && d.ins) d.ins.add(o); return d; };
    o.disconnect = d => {
      if (d === undefined) { for (const x of o.outs) if (x && x.ins) x.ins.delete(o); o.outs.clear(); return; }
      if (!o.outs.has(d)) throw new Error('InvalidAccessError: not connected');
      o.outs.delete(d); if (d.ins) d.ins.delete(o);
    };
    for (const p of params || []) o[p] = param(0);
    return o;
  }
  const ctx = {
    sampleRate: 48000, currentTime: 0, state: 'running', destination: node('destination'),
    startRendering() {}, resume() { return Promise.resolve(); }, suspend() { return Promise.resolve(); },
    createGain: () => node('gain', ['gain']),
    createBiquadFilter: () => node('biquad', ['frequency', 'Q', 'gain', 'detune']),
    createDynamicsCompressor: () => node('compressor', ['threshold', 'knee', 'ratio', 'attack', 'release']),
    createWaveShaper: () => node('shaper'),
    createOscillator: () => node('oscillator', ['frequency', 'detune']),
    createBufferSource: () => node('source', ['playbackRate', 'detune']),
    createStereoPanner: () => node('panner', ['pan']),
    createPeriodicWave: () => ({}),
    createBuffer: (ch, len, sr) => { const d = []; for (let c = 0; c < ch; c++) d.push(new Float32Array(len)); return { numberOfChannels: ch, length: len, sampleRate: sr, getChannelData: c => d[c] }; },
    createConvolver: () => {
      const o = node('convolver'); let buf = null;
      Object.defineProperty(o, 'buffer', { get: () => buf, set: b => { buf = b; made.bufferSets++; } });
      made.convolvers.push(o); return o;
    }
  };
  return { ctx, made };
}
function irStub(log, fail) {
  return function (sr, o) { log.push([o.width, o.height]); if (fail) throw new Error('no impulse'); const n = 64, l = new Float32Array(n), r = new Float32Array(n); l[0] = r[0] = 1; return { sampleRate: sr, left: l, right: r }; };
}
async function tunnelRig(fail) {
  const log = [], F = load({ tunnelImpulse: irStub(log, fail) }), fk = fakeContext();
  const au = F.createAudio({ context: fk.ctx, worklet: false });
  const ok = await au.init();
  au.setActive(true);
  const conv = fk.made.convolvers[0], st = { speed: 50, x: 0, y: 0, z: 0, heading: 0 }, LL = { x: 0, y: 0.7, z: 0, heading: 0 };
  // as js/main.js does: k every frame, the stretch's size only while k > 0
  const frames = (sec, k, w, h) => { for (let i = 0; i < Math.round(sec * 60); i++) { if (k > 0 && w) au.setTunnel(k, w, h); else au.setTunnel(k); au.update(1 / 60, st, LL, []); } };
  return { au, ok, conv, log, fk, frames, fed: () => conv.ins.size > 0 };
}
// one lap of Monaco as the critic log shows it: Portier (k up to ~0.2), 2.5 s on (more than T.tunOff), the tunnel (k 1)
function monacoLap(r) { r.frames(10, 0); r.frames(0.4, 0.2, 23.5, 6.8); r.frames(2.5, 0); r.frames(1, 0.5, 25, 6.8); r.frames(5, 1, 25, 6.8); r.frames(30, 0); }
(async () => {
  let r = await tunnelRig();
  check('fake context: graph built on the plain nodes back end, one convolver', r.ok === true && r.au.debug.backend === 'nodes' && !!r.conv);
  r.frames(5, 0);
  check('no tunnel asked: no impulse response made, the reverb not fed', r.au.debug.reverbBuilds === 0 && r.log.length === 0 && !r.fed());
  r.frames(0.4, 0.2, 23.5, 6.8);
  check('Portier (23.5 m): the impulse made for its size, the reverb fed', r.au.debug.reverbBuilds === 1 && r.log[0][0] === 23.5 && r.fed() && r.au.debug.reverb === true);
  r.frames(2.5, 0);
  check('2.5 s after it: the reverb disconnected again', !r.fed() && r.au.debug.reverb === false);
  r.frames(6, 1, 25, 6.8);
  check('the tunnel (25 m, 1.5 m wider): the same impulse kept (builds ' + r.au.debug.reverbBuilds + ', buffer sets ' + r.fk.made.bufferSets + '), fed', r.au.debug.reverbBuilds === 1 && r.fk.made.bufferSets === 1 && r.fed());
  r.frames(30, 0);
  for (let lap = 0; lap < 3; lap++) monacoLap(r);
  check('three more Monaco laps: still one impulse response in all (builds ' + r.au.debug.reverbBuilds + ', sizes ' + JSON.stringify(r.log) + ')', r.au.debug.reverbBuilds === 1 && r.log.length === 1 && r.fk.made.bufferSets === 1);
  // Singapore: soffits 4.5 m / 5 m
  r = await tunnelRig();
  for (let lap = 0; lap < 3; lap++) { r.frames(10, 0); r.frames(0.5, 0.3, 25, 4.5); r.frames(5, 0); r.frames(1, 0.6, 25, 5); r.frames(20, 0); }
  check('Singapore (soffits 4.5 / 5 m), three laps: one impulse response (builds ' + r.au.debug.reverbBuilds + ')', r.au.debug.reverbBuilds === 1);
  // a clearly other size (another track: Abu Dhabi's 9 m soffit): made anew at its portal
  r.frames(1, 0.5, 25, 9);
  check('a clearly other size (25 x 9 after 25 x 5): made anew (builds ' + r.au.debug.reverbBuilds + ', last ' + JSON.stringify(r.log[r.log.length - 1]) + ')', r.au.debug.reverbBuilds === 2 && r.log[1][1] === 9 && r.fed());
  r.frames(1, 0.5, 45, 9);
  check('a much wider stretch (45 m) asked for while the reverb sounds: not made yet (no swap mid-tunnel)', r.au.debug.reverbBuilds === 2);
  r.frames(1, 0);
  check('... 1 s after it (k 0, the wet gain long at 0): made for 45 m while still connected', r.au.debug.reverbBuilds === 3 && r.log[2][0] === 45 && r.fed());
  r.frames(2, 0);
  check('... and disconnected after T.tunOff', !r.fed());
  // primed at track load: setTunnel(0, w, h) -> made at the next update(), silently; the laps then make none
  r = await tunnelRig();
  r.au.setTunnel(0, 25, 6.8); r.au.update(1 / 60, { speed: 0 }, { x: 0, y: 0, z: 0 }, []);
  check('setTunnel(0, 25, 6.8) at track load: made at the next update(), the reverb not fed (k 0)', r.au.debug.reverbBuilds === 1 && !r.fed() && r.au.debug.reverb === false && r.au.debug.tunnel === 0);
  for (let lap = 0; lap < 3; lap++) monacoLap(r);
  check('primed, three Monaco laps: no impulse response made while driving (builds ' + r.au.debug.reverbBuilds + ')', r.au.debug.reverbBuilds === 1 && r.log.length === 1);
  // F1.tunnelImpulse throwing: one attempt per size, not one per frame
  r = await tunnelRig(true);
  const warn = console.warn; console.warn = () => {};          // (the module warns once: expected here)
  r.au.setTunnel(0, 25, 6.8); r.frames(5, 0);
  console.warn = warn;
  check('F1.tunnelImpulse throws: one attempt (' + r.log.length + '), one error (' + r.au.debug.errors + '), no reverb', r.log.length === 1 && r.au.debug.errors === 1 && !r.fed());

  console.log('\n' + (n - fails) + ' / ' + n + ' checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
