// F1Drive - sound. Web Audio, fully synthesised: the project ships no sound files. See js/README-interfaces.md (v6).
//
//   F1.audio = F1.createAudio()            the game's instance (nothing is created until init())
//   F1.audio.init()                        creates / resumes the AudioContext and builds the graph; call it from a user
//                                          gesture, as often as you like. -> Promise<boolean> (true = graph built).
//                                          Electron lets an AudioContext start without a gesture (its default autoplay
//                                          policy), so there the sound starts at once; where a gesture is required the
//                                          context waits, suspended, and starts at the next init() or update() after one.
//   F1.audio.setVolume(v) / .volume        master volume 0..1 (gain = v * v: a slider at 0.5 is -12 dB)
//   F1.audio.setMuted(on) / .muted
//   F1.audio.setActive(on) / .active       true while the game loop runs; false = everything fades out (0.25 s)
//   F1.audio.setEngine(spec)               the own car's engine (a CarSpec: cylinders, aspiration, gearKmh / topKmh,
//                                          rpmIdle / rpmShift / rpmMax, shiftTime); missing / invalid fields keep the
//                                          reference car's. Remote cars without a spec of their own sound like this one.
//   F1.audio.update(dt, own, listener, others)   once per rendered frame; never throws; allocates nothing (on the node
//                                          fallback: the boxes V8 makes for the numbers handed to setTargetAtTime)
//   F1.audio.beep('light' | 'go')
//   F1.audio.play(kind, strength)          one-shots: 'pitgun', 'jack', 'limiterOn', 'limiterOff'; strength 0..1 (1)
//   F1.audio.setTunnel(k, width?, height?) (v6.2) how far the listener is inside a tunnel, 0..1: js/tunnels.js
//                                          tun.inTunnel(car.state.sampleIndex), once per frame (0 where there is none).
//                                          width / height (m, optional): that tunnel's size for its reverb (default
//                                          25 x 6.8, Monaco); a new size is taken at the next quiet moment. own.tunnel
//                                          (a number) given to update() does the same. Allocates nothing itself.
//   F1.audio.dispose()
//
// What sounds:
//   own car   engine (firing frequency rpm / 60 * cylinders / 2 and its harmonics, half orders and crank orders, shaped
//             by exhaust resonances; brighter and louder on throttle, burble and pops on the overrun; the V6 turbo
//             hybrid darker with a turbo whistle, the V8 brighter and cleaner), a gear change you hear (ignition cut of
//             the spec's shiftTime with a crack on upshifts, a blip and a pop on downshifts: timed on the audio thread,
//             so its length does not depend on the frame rate), rev-limiter stutter at rpmMax, pit-limiter stutter
//             (state.limiter while the car is held at the limit), ERS whine (deploy) / softer lower whine (harvest),
//             wind + road roar by speed, tyre scrub from slip, flat-spot thump at wheel rate from state.vib, grass
//             rumble, one thump per impact (state.hit)
//   others    the nearest MAX_VOICES cars, each a voice of its own: engine pitch from its speed through the shared
//             drivetrain formula (its own spec, else the own car's), throttle guessed from its acceleration, level by
//             distance (gone at D_MAX), left / right panning, Doppler shift from the two velocities along the line
//             between the cars (speed and heading smoothed over 0.1 s: the network delivers them as 20 Hz steps)
//   tunnel    (setTunnel k > 0) the whole mix through a convolution reverb of the tunnel's impulse response
//             (F1.tunnelImpulse of js/tunnels.js: road / soffit flutter, side-wall echoes, RT60 1.4 s) at T.tunWet * k
//             beside the dry mix, a mid boost (+T.tunMidDb * k dB around 450 Hz, a band added to the dry mix), the
//             own engine +T.tunEngDb * k dB (0: the reverb is its reflections) and the wind / road roar +T.tunRoarDb *
//             k dB, all ramped
//             (T.tunTau). The reverb and the mid band are only connected while in use (disconnected T.tunOff s after k
//             fell to 0), so at k = 0 the sound is exactly what it is without a tunnel. Without js/tunnels.js there is
//             no reverb (the rest still works).
// Fields missing from `own` (rpm, gear, shiftT, throttle, brake, harvest, slip) are derived from the speed and its
// change, so any car state works.
// While active, a game loop that stops calling update() for 0.5 s fades the sound out (no engine left droning at a
// fixed pitch); the next update() brings it back. A page that reports itself hidden (visibilitychange) fades it out
// too, and it stays out, whatever update() and setActive(true) do, until the page is visible again and update() comes.
// Electron with backgroundThrottling: false (the game's window) never reports the page hidden, minimised or not, and
// keeps requestAnimationFrame running: there the host silences a minimised / hidden window itself (main process:
// webContents.setAudioMuted, or setActive(false) here).
//
// Two back ends with the same control layer:
//   'worklet'  one AudioWorkletProcessor (loaded from a Blob URL: no files, works from file:// and inside an asar)
//              that accumulates phase per sample and sums the partials, so pitch glides without zipper noise
//   'nodes'    plain OscillatorNode / BiquadFilterNode / looped noise buffers, used when AudioWorklet is unavailable
// Both feed: mix -> subsonic high-pass -> active fade -> compressor -> soft clip (ceiling -1.1 dBFS) -> master volume;
// in a tunnel the high-pass also feeds the active fade through the reverb (convolver -> wet gain) and the mid band
// (band-pass -> gain), in parallel with the dry path.
//
// Tests: F1.createAudio({ context, worklet, mask }) renders the same graph into an OfflineAudioContext
// (context), forces the fallback (worklet: false) and solos sources (mask, see M_* below). devtests/audio-test/.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // ---- tuning -------------------------------------------------------------
  var MAX_VOICES = 6;               // remote cars that sound at once (the nearest ones)
  var MAX_OTHERS = 128;             // entries of `others` looked at per frame (a longer list is cut off here)
  var C_SOUND = 343;                // m/s, for the Doppler shift
  var DOPPLER_MIN = 0.55, DOPPLER_MAX = 1.9;
  var D_REF = 8;                    // m: a remote car is not louder than at this distance
  var D_EXP = 0.75;                 // level ~ (D_REF / d) ^ D_EXP   (-4.5 dB per doubling: gentler than free field,
                                    //   so a car 60 m away is still clearly there)
  var D_FADE = 120, D_MAX = 300;    // m: extra fade to silence between these two
  var D_ALLOC = D_MAX - 10;         // m: a car gets a voice only inside this (hysteresis against D_MAX)
  var VOICE_RELEASE = 0.3;          // s a voice takes to fade out before it is given to another car
  var STEAL_MARGIN = 1.25;          // a car without a voice takes over the farthest voice when it is this much closer
  var TELEPORT_SLACK = 6;           // m; a car that moved more than 3 * speed * dt + this between frames has been placed
  var REMOTE_TAU = 0.1;             // s: a remote car's speed and velocity are smoothed with this (snapshots at 20 Hz;
                                    //   js/net.js shows remote cars 100 ms late anyway)
  var DOP_TAU = 0.04;               // s: ... and its Doppler factor (the interpolated position jumps a little at each snapshot)
  var BLIP_TIME = 0.08;             // s of throttle blip on a downshift
  var HIT_MIN = 0.02;               // state.hit above this is an impact
  var HIT_REARM = 0.15;             // s without contact before the next impact thumps again
  var FADE_OUT = 0.25, FADE_IN = 0.12;   // s, setActive
  var VOLUME_TAU = 0.03;            // s, volume / mute smoothing
  var SUSPEND_AFTER_MS = 900;       // the context is suspended this long after the sound faded out (saves the CPU)
  var STALL_MS = 500, STALL_TICK = 125;   // active, but no update() for this long (stopped loop, hidden browser tab): fade out
  var SAMPLE_RATE = 48000;          // asked for; whatever the device gives is fine
  var NOISE_HZ = 9500;              // every noise source is white up to here and empty above (see workletMain)
  var SUBSONIC_HZ = 22;             // the mix is high-passed here (noise below it only costs headroom)
  var WHEEL_D = 0.72;               // m: tyre diameter; flat-spot thumps come at speed / (pi * WHEEL_D) per second
  var PIT_HOLD_ACC = 1.5;           // m/s^2: pit limiter on, throttle open and accelerating less than this = held at the limit
  var PIT_THR_HOLD = 0.35;          // s the pit-limiter stutter goes on after the throttle reading drops (the limiter
                                    //   may report the drive it cuts as a closed throttle)

  var BIG = 1e30;                   // numbers are taken seriously between -BIG and BIG
  function fin(v, d) { return typeof v === 'number' && v > -BIG && v < BIG ? v : d; }
  function lim(v, lo, hi) { return v > lo ? (v < hi ? v : hi) : lo; }            // NaN -> lo

  // stem masks (createAudio({ mask })): which sources reach the mix
  var M_ENGINE = 1, M_AERO = 2, M_SURFACE = 4, M_ERS = 8, M_REMOTE = 16, M_FX = 32, M_ALL = 63;

  // Levels are RMS at the mix bus (full scale = 1), before the master chain.
  var T = {
    engFull: 0.115,     // own engine, full throttle at rpmMax                        (-18.8 dBFS)
    engOff: 0.30,       //   share left with the throttle closed
    engLow: 0.62,       //   share left at idle speed
    // timbre of the V6 turbo hybrid ('hybrid'); T.na holds the naturally aspirated V8's where it differs
    tiltOff: 1400, tiltOn: 5000,       // Hz: spectral roll-off corner, throttle closed / open
    alphaOff: 2.0, alphaOn: 0.8,       // harmonic k has amplitude k ^ -alpha (a sawtooth is 1; an exhaust pulse train is flatter)
    idleOpen: 0.35,                    // spectral opening left at idle speed with the throttle closed (0 = as dull as the overrun)
    halfOff: 0.42, halfOn: 0.30,       // half orders (bank-to-bank differences) relative to the firing harmonics
    crankOff: 0.15, crankOn: 0.10,     // crank / cycle orders
    exOff: 0.10, exOn: 0.36,           // exhaust noise RMS relative to the engine tone
    exF0: 1200, exF1: 1500,            // exhaust noise band centre: Hz + Hz * load
    sigOn: 0.06, sigOff: 0.22,         // firing-to-firing strength variation, throttle open / closed
    gain: 1,
    na: { tiltOff: 1800, tiltOn: 7000, alphaOff: 1.8, alphaOn: 0.62, idleOpen: 0.4, halfOff: 0.36, halfOn: 0.2, crankOff: 0.12, crankOn: 0.06,
          exOff: 0.08, exOn: 0.24, exF0: 1500, exF1: 2200, sigOn: 0.035, sigOff: 0.18, gain: 1.12 },
    formants: [[380, 150, 0.8], [1150, 320, 1.4], [2600, 550, 1.0], [4300, 900, 0.5]],   // exhaust / intake resonances: Hz, half width, gain
    naFormantScale: 1.25,              // the V8's shorter pipes: resonances this much higher
    popRate: 7, popAmp: 0.35,          // overrun pops: per second, burst RMS relative to engFull
    cutDepth: 0.92,                    // share of the engine taken away during the ignition cut of an upshift
    crackAmp: 0.8, crackTau: 0.007, crackPop: 0.5,   // upshift crack: peak RMS relative to engFull at full load, decay (s), low pop with it
    crackAt: 0.5, crackRise: 0.0012,   //   when in the cut it comes (share of shiftTime: the drop is heard first), its attack (s)
    dnPop: 0.55,                       // pop on a downshift from high revs
    turF0: 2600, turF1: 3900, turAmp: 0.07,   // turbo whistle: Hz at rest, + Hz at full boost, level relative to engFull
    depF0: 1200, depF1: 34, depAmp: 0.011,    // ERS deploy whine: Hz + Hz per m/s, RMS
    harF0: 520, harF1: 17, harAmp: 0.0065,    // ERS harvest whine (lower, softer, two detuned tones)
    vRef: 92,           // m/s (330 km/h): speed the wind / road levels are given for
    windFull: 0.1, windExp: 2.4,       // wind RMS per channel at vRef; level ~ v ^ windExp (2 dB under the engine flat out
                                       //   at 330 km/h: the engine stays on top and a top-gear upshift is still heard)
    roadFull: 0.05, roadExp: 1.5,
    tyreFull: 0.06,     // tyre scrub at slip = 1
    grassFull: 0.085,   // grass rumble at 90 km/h and above
    vibAmp: 0.16, vibHz: 70, vibTau: 0.03, vibSlap: 5,   // flat-spot thump at vib = 1: level, body frequency, decay, tyre slap (noise < 400 Hz) with it
    vibNodes: 1.2,     //   the fallback's copy of it (same sound, pulse envelope on an oscillator): level match (measured)
    voiceFull: 0.075,   // remote engine at D_REF, full throttle (-3.7 dB re the own engine; one channel when it is alongside)
    voiceOff: 0.35,
    limHz: 24, limDuty: 0.42, limFloor: 0.1,  // rev limiter: cuts per second, share of the period cut, level while cut
    pitHz: 10.5, pitDuty: 0.45, pitFloor: 0.16, pitPop: 0.7,   // pit limiter: slower, rougher, with a pop per cut now and then
    thump: 0.42,        // peak of an impact with hit = 1
    beepHz: 740, beepGoHz: 1480, beepDur: 0.13, beepGoDur: 0.5, beepAmp: 0.14,
    shot: { pitgun: 0.2, jack: 0.3, limiterOn: 0.09, limiterOff: 0.09 },   // one-shot peaks at strength 1
    compThreshold: -10, compKnee: 8, compRatio: 8, compAttack: 0.004, compRelease: 0.2,
    compTrim: 0.662,     // undoes the compressor's built-in make-up gain, so the mix passes at unity below the threshold
    clipKnee: 0.7, clipRange: 0.2,     // soft clip: linear up to clipKnee, ceiling clipKnee + clipRange * tanh(1.5) = 0.881
    nodesEngTrim: 1.0, nodesVoiceTrim: 1.0,    // fallback graph: level match with the worklet (measured)
    // tunnel at k = 1 (setTunnel): reverb wet gain (the convolver normalises the impulse), mid band (Hz, Q, dB at its
    // centre), engine / roar reflections (dB), ramp time constant (s), s at k = 0 before the reverb is disconnected,
    // default size (m) and reverb time (s) of the impulse response (js/tunnels.js F1.tunnelImpulse; Monaco).
    // Measured (devtests/audio-test/tunnel.js, 290 km/h flat out): the tunnel report's 0.45 / +4 dB / engine +2.5 dB /
    // roar +3 dB drove the master compressor to 4.3 dB (the mix keeps it under 3 dB: ears.js); the reverb already is the
    // engine's reflections, so there is no dry engine boost, and a stronger wet (0.6) costs no level. These: 2.6 dB at
    // 290 km/h (0.3 dB outside), the 355..560 Hz band +4.7 dB, a reverb tail -26 dB 0.2 s after a sound stops.
    tunWet: 0.6, tunMidHz: 450, tunMidQ: 0.8, tunMidDb: 3, tunEngDb: 0, tunRoarDb: 2, tunTau: 0.05, tunOff: 2,
    tunWidth: 25, tunHeight: 6.8, tunRt60: 1.4
  };
  var LN10_20 = Math.LN10 / 20;     // dB -> gain: Math.exp(dB * LN10_20)
  // timbre sets as arrays (worklet and fallback read them by index)
  var TB_KEYS = ['tiltOff', 'tiltOn', 'alphaOff', 'alphaOn', 'halfOff', 'halfOn', 'crankOff', 'crankOn', 'exOff', 'exOn', 'idleOpen', 'gain', 'exF0', 'exF1', 'sigOn', 'sigOff'];
  function timbreSet(na) { return TB_KEYS.map(function (k) { return na && typeof T.na[k] === 'number' ? T.na[k] : T[k]; }); }

  // ---- engines. What the sound needs of a CarSpec, kept in fixed storage so that the per-frame path reads it
  //      without allocating. The drivetrain formula of the contract: gear by speed against gk (downshift DOWN_HYST
  //      km/h below the upshift speed of the lower gear), rpm = shift * v / top(g), floor idle, ceiling max. ----
  var MAXG = 12, DOWN_HYST = 8;
  function Engine() {
    this.gk = new Float64Array(MAXG);   // gk[g - 1]: upshift speed (km/h) of gear g, g = 1 .. n - 1
    this.n = 8; this.top = 345;         // forward gears; speed at `shift` rpm in the top gear
    this.idle = 4000; this.shift = 11800; this.max = 12500;
    this.cyl = 6; this.na = 0; this.shiftTime = 0.05;
    this.power = 970.4; this.dragK = 0.0012; this.traction = 11;      // for guessing a remote car's throttle
    this.src = null; this.gen = -1;
    var g = [60, 100, 140, 180, 220, 260, 300], i;
    for (i = 0; i < g.length; i++) this.gk[i] = g[i];
  }
  function copyEngine(d, s) {
    if (d === s) return;
    d.gk.set(s.gk); d.n = s.n; d.top = s.top; d.idle = s.idle; d.shift = s.shift; d.max = s.max; d.cyl = s.cyl; d.na = s.na;
    d.shiftTime = s.shiftTime; d.power = s.power; d.dragK = s.dragK; d.traction = s.traction;
  }
  function okNum(v, lo, hi) { return typeof v === 'number' && v >= lo && v <= hi; }
  // d <- spec; every field that is missing or invalid comes from base (d may be base)
  function fillEngine(d, spec, base) {
    var s = spec && typeof spec === 'object' ? spec : null, g, i, ok, prev, asp;
    copyEngine(d, base);
    d.src = spec;
    if (!s) return d;
    g = s.gearKmh;
    if (g && typeof g === 'object' && typeof g.length === 'number' && g.length >= 1 && g.length < MAXG) {
      ok = true; prev = 0;
      for (i = 0; i < g.length; i++) { if (!(okNum(g[i], 5, 600) && g[i] > prev)) { ok = false; break; } prev = g[i]; }
      if (ok && okNum(s.topKmh, prev + 0.001, 900)) { for (i = 0; i < g.length; i++) d.gk[i] = g[i]; d.n = g.length + 1; d.top = s.topKmh; }
    }
    if (okNum(s.rpmIdle, 300, 25000)) d.idle = s.rpmIdle;
    if (okNum(s.rpmShift, 300, 25000)) d.shift = s.rpmShift;
    if (okNum(s.rpmMax, 300, 25000)) d.max = s.rpmMax;
    if (!(d.shift > d.idle + 100)) d.shift = d.idle + 100;
    if (!(d.max >= d.shift)) d.max = d.shift;
    if (okNum(s.cylinders, 2, 16) && s.cylinders % 2 === 0) { d.cyl = s.cylinders; d.na = d.cyl >= 8 ? 1 : 0; }
    asp = s.aspiration;
    if (asp === 'na') d.na = 1; else if (asp === 'hybrid' || asp === 'turbo') d.na = 0;
    if (okNum(s.shiftTime, 0.01, 0.2)) d.shiftTime = s.shiftTime;
    if (okNum(s.power, 50, 5000)) d.power = s.power;
    if (okNum(s.dragK, 1e-5, 0.02)) d.dragK = s.dragK;
    if (okNum(s.traction, 1, 40)) d.traction = s.traction;
    return d;
  }
  var CONTRACT = new Engine();              // the contract's numbers
  var REF = new Engine(), refFrom = null, refPerf = null;
  // the reference car: F1.REF_SPEC when js/car.js defines it, else what F1.CAR_PERF carries, else the contract
  function refreshRef() {
    var rs = F1.REF_SPEC, p = F1.CAR_PERF, i, ok;
    if (rs === refFrom && p === refPerf) return;
    refFrom = rs; refPerf = p;
    copyEngine(REF, CONTRACT);
    if (p && typeof p === 'object') {
      if (p.GEAR_KMH && p.GEAR_KMH.length === 7) {
        ok = true;
        for (i = 0; i < 7; i++) if (!(okNum(p.GEAR_KMH[i], 5, 600) && p.GEAR_KMH[i] > (i ? p.GEAR_KMH[i - 1] : 0))) ok = false;
        if (ok && okNum(p.GEAR8_KMH, p.GEAR_KMH[6] + 0.001, 900)) { for (i = 0; i < 7; i++) REF.gk[i] = p.GEAR_KMH[i]; REF.n = 8; REF.top = p.GEAR8_KMH; }
      }
      if (okNum(p.RPM_IDLE, 300, 25000)) REF.idle = p.RPM_IDLE;
      if (okNum(p.RPM_SHIFT, REF.idle + 100, 25000)) REF.shift = p.RPM_SHIFT;
      if (okNum(p.RPM_MAX, REF.shift, 25000)) REF.max = p.RPM_MAX;
      if (okNum(p.power, 50, 5000)) REF.power = p.power;
      if (okNum(p.dragK, 1e-5, 0.02)) REF.dragK = p.dragK;
      if (okNum(p.traction, 1, 40)) REF.traction = p.traction;
    }
    if (rs && typeof rs === 'object') fillEngine(REF, rs, REF);
    REF.src = null;
  }
  // gear for the speed v (m/s), no hysteresis: 0 standing, -1 reverse
  function gearOf(e, v) {
    if (v < -0.5) return -1;
    if (!(v >= 0.5)) return 0;
    var kmh = v * 3.6, g = 1;
    while (g < e.n && kmh >= e.gk[g - 1]) g++;
    return g;
  }
  function rpmOf(e, v, g) {
    var kmh = (v < 0 ? -v : v) * 3.6, r;
    if (g === undefined) g = gearOf(e, v);
    if (g === 0) return e.idle;
    r = e.shift * kmh / (g >= e.n ? e.top : e.gk[g >= 1 ? g - 1 : 0]);
    return r > e.idle ? (r < e.max ? r : e.max) : e.idle;
  }
  // the car's longitudinal / lateral limits, for guessing the pedals and tyre slip when car.state lacks them
  var PH = {
    dragK: 0.0012, roll: 0.5, traction: 11, power: 970.4, brakeBase: 12, brakeAero: 0.0032,
    latBase: 20, latAero: 0.0045, latMax: 44, wheelbase: 3.6, steerLock: 0.35, steerSpeedRef: 22
  };
  function readPerf() {
    var p = F1.CAR_PERF, k;
    refreshRef();
    if (!p) return;
    for (k in PH) if (typeof p[k] === 'number' && p[k] === p[k] && p[k] > 0) PH[k] = p[k];
  }
  // level of a remote car by distance (1 at D_REF and closer, 0 from D_MAX)
  function attenuation(d) {
    if (!(d < D_MAX)) return 0;
    var g = d > D_REF ? Math.pow(D_REF / d, D_EXP) : 1, t;
    if (d > D_FADE) { t = (D_MAX - d) / (D_MAX - D_FADE); g *= t * t * (3 - 2 * t); }
    return g;
  }

  // ---- control vector: what the control layer hands to a back end each frame ----
  var C_RPM = 0, C_LOAD = 1, C_UP = 2, C_DN = 3, C_LIM = 4, C_SPD = 5, C_TUR = 6, C_DEP = 7, C_HAR = 8, C_SLIP = 9, C_GRASS = 10,
      C_VIB = 11, C_CYL = 12, C_ASP = 13, C_RIDLE = 14, C_RMAX = 15, C_STIME = 16, C_TUN = 17,   // tunnel 0..1 (setTunnel)
      C_V0 = 18, V_STRIDE = 5;       // per voice: firing Hz (Doppler included), load, gain, pan, brightness
  var NCTL = C_V0 + V_STRIDE * MAX_VOICES;
  // [name, default, min, max, scale] of the worklet's AudioParams, in control vector order. A parameter carries
  // value * scale rounded to a whole number: V8 hands a whole number to the AudioParam setter as it is, anything else
  // in a freshly allocated box (12 bytes of garbage per write). All of them stay below 2^24, exact in a float.
  function paramTable() {
    var p = [['rpm', 4000, 300, 30000, 64], ['load', 0, 0, 1, 1024], ['up', 0, 0, 1048575, 1], ['dn', 0, 0, 1048575, 1], ['lim', 0, 0, 2, 1],
      ['spd', 0, 0, 200, 64], ['tur', 0, 0, 1, 1024], ['dep', 0, 0, 1, 1024], ['har', 0, 0, 1, 1024], ['slip', 0, 0, 1, 1024], ['grass', 0, 0, 1, 1],
      ['vib', 0, 0, 1, 1024], ['cyl', 6, 2, 16, 1], ['asp', 1, 0, 1, 1], ['ridle', 4000, 300, 30000, 1], ['rmax', 12500, 300, 30000, 1], ['stime', 50, 5, 250, 1],
      ['tun', 0, 0, 1, 1024]], v;
    for (v = 0; v < MAX_VOICES; v++) p.push(['f' + v, 200, 20, 4000, 1024], ['l' + v, 0, 0, 1, 1024], ['g' + v, 0, 0, 2, 65536], ['p' + v, 0, -1, 1, 16384], ['b' + v, 1, 0, 1, 1024]);
    return p;
  }

  // ---- the synthesiser. Runs inside the AudioWorkletGlobalScope: it must not use anything from outside itself. ----
  function workletMain(CFG) {
    var SR = sampleRate, NV = CFG.NV, T = CFG.T, PI = Math.PI;
    var TBL = 16384, MASK = TBL - 1, RS = 4.656612873077393e-10;        // sine table; int32 -> -1..1
    var FMAX = Math.min(0.42 * SR, 12000);                               // no partial above this
    var KN = 0.5774 * Math.sqrt(PI / SR);   // RMS of white noise (-1..1) through a band-pass: KN * sqrt(fc / q), a low-pass: KN * sqrt(fc * q)
    var SIN = new Float32Array(TBL), SEED = new Int32Array([0x1F3D5B79]), i, k;
    for (i = 0; i < TBL; i++) SIN[i] = Math.sin(2 * PI * i / TBL);
    // (set-up only; process() runs the generator inline)
    function rnd() { SEED[0] = (Math.imul(SEED[0], 1664525) + 1013904223) | 0; return SEED[0] * RS; }
    // timbre sets (see timbreSet): hybrid V6 and naturally aspirated V8; blended per block by the 'asp' parameter
    var TS = new Float64Array(CFG.TS), TN = new Float64Array(CFG.TN), NTS = TS.length;
    var B_TILT0 = 0, B_TILT1 = 1, B_AL0 = 2, B_AL1 = 3, B_HALF0 = 4, B_HALF1 = 5, B_CR0 = 6, B_CR1 = 7, B_EX0 = 8, B_EX1 = 9, B_IDLE = 10, B_GAIN = 11,
        B_EXF0 = 12, B_EXF1 = 13, B_SIG0 = 14, B_SIG1 = 15;

    // process() allocates nothing: this is the audio thread, and a garbage collection here is a dropout. So all its
    // state lives in typed arrays, filters and noise generators are written out inline, and no function it calls
    // takes or returns a non-integer number (V8 would box it). devtests/audio-test/live.js ('dsp') measures it.

    // Noise: white up to NOISE_HZ and nothing above it (two looped tables of coprime length, read together: the
    // pattern repeats after a day). Nothing the synthesiser makes on purpose reaches beyond FMAX, so whatever a test
    // finds up there is a fault (a step in a gain, a phase jump).
    var NL = 65536, NM = NL - 1, LB = 65521, NA = new Float32Array(NL), NB = new Float32Array(LB);
    (function () {
      var taps = 95, h = new Float64Array(taps), fcn = Math.min(CFG.noiseHz, 0.2 * SR) / SR, c = (taps - 1) / 2, sum = 0, n, j, x, raw, acc;
      for (n = 0; n < taps; n++) {
        x = n - c;
        h[n] = (x === 0 ? 2 * fcn : Math.sin(2 * PI * fcn * x) / (PI * x)) * (0.42 - 0.5 * Math.cos(2 * PI * n / (taps - 1)) + 0.08 * Math.cos(4 * PI * n / (taps - 1)));
        sum += h[n];
      }
      for (n = 0; n < taps; n++) h[n] /= sum;
      [NA, NB].forEach(function (dst) {
        var len = dst.length;
        raw = new Float32Array(len + taps);
        for (j = 0; j < len; j++) raw[j] = rnd() * Math.SQRT1_2;
        for (j = 0; j < taps; j++) raw[len + j] = raw[j];
        sum = 0;
        for (j = 0; j < len; j++) { acc = 0; for (n = 0; n < taps; n++) acc += raw[j + n] * h[n]; dst[j] = acc; sum += acc; }
        for (j = 0; j < len; j++) dst[j] -= sum / len;                 // no mean: it would leave the low-pass filters as DC
      });
    })();
    // noise streams: read positions (a, b) in the two tables, per stream
    var N_EX = 0, N_POP = 1, N_WL = 2, N_WR = 3, N_RD = 4, N_TY = 5, N_GR = 6, N_BP = 7, N_CRK = 8, N_VIB = 9, N_V0 = 10, NSTREAM = N_V0 + NV;
    var STREAM_ID = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (i = 0; i < NV; i++) STREAM_ID.push(20 + i);

    // State variable filters (Zavalishin; stable while the corner moves): 6 numbers each in a Float64Array,
    // a1 a2 a3 k z1 z2. Output of one step with input x:
    //   v3 = x - z2; v1 = a1 z1 + a2 v3; v2 = z2 + a2 z1 + a3 v3; z1 = 2 v1 - z1; z2 = 2 v2 - z2
    //   low-pass = v2, band-pass with unity peak = v1 k
    var F_EX = 0, F_POP = 1, F_WL = 2, F_WR = 3, F_HL = 4, F_HR = 5, F_RD = 6, F_T1 = 7, F_T2 = 8, F_G1 = 9, F_G2 = 10, NFILT = 11;
    var ARG = new Float64Array(2);           // svfSet's arguments: corner (Hz), Q
    function svfSet(FB, f) {
      var fc = ARG[0], q = ARG[1], g = Math.tan(PI * Math.min(fc, 0.45 * SR) / SR), kq = 1 / q, a1 = 1 / (1 + g * (g + kq)), o = f * 6;
      FB[o] = a1; FB[o + 1] = g * a1; FB[o + 2] = g * g * a1; FB[o + 3] = kq;
    }
    var NFM = T.formants.length, FMC = new Float64Array(NFM), FMW = new Float64Array(NFM), FMG = new Float64Array(NFM);
    for (i = 0; i < NFM; i++) { FMC[i] = T.formants[i][0]; FMW[i] = T.formants[i][1]; FMG[i] = T.formants[i][2]; }

    // Own engine: partials at orders of the engine cycle (two crank revolutions: rpm / 120 Hz). With h = cylinders / 2:
    // orders n * h, n = 1 .. NHALF (even n = firing harmonics, odd n = half orders), plus the crank / cycle orders
    // below 2 * cylinders that are not multiples of h. Laid out for the cylinder count in layout().
    var NHALF = 52, NPMAX = NHALF + 32;
    // Remote engine: partials at multiples of half the firing frequency (even = firing harmonics, odd = half orders)
    var NPV = 16, VPH = new Float64Array(NPV);
    for (i = 0; i < NPV; i++) VPH[i] = (0.5 + 0.5 * rnd()) * TBL;
    var names = CFG.params.map(function (p) { return p[0]; }), V0 = names.indexOf('f0');
    // parameters arrive as value * scale (see paramTable): the factors that undo it
    var INV = {};
    CFG.params.forEach(function (p) { INV[p[0]] = 1 / p[4]; });
    var iRpm = INV.rpm, iLoad = INV.load, iSpd = INV.spd, iTur = INV.tur, iDep = INV.dep, iHar = INV.har, iSlip = INV.slip, iVib = INV.vib, iTun = INV.tun;
    var DB_K = Math.LN10 / 20;            // dB -> gain: Math.exp(dB * DB_K)
    var iVF = INV.f0, iVL = INV.l0, iVG = INV.g0, iVP = INV.p0, iVB = INV.b0;

    // own-car state (ST)
    var R1 = 0, R2 = 1, THE = 2, FG = 3, FGT = 4, CS = 5, GS = 6, LPH = 7, LOAD = 8, BLIP = 9, JIT = 10, POPT = 11, POPE = 12, EA = 13,
        TUR = 14, TPH = 15, TA = 16, TJ = 17, SPD = 18, DEP = 19, HAR = 20, DPH = 21, HPH = 22, HPH2 = 23, WA = 24, RA = 25, GUST = 26,
        SLIP = 27, TYA = 28, WAN = 29, GRASS = 30, GA = 31, BUMP = 32, BUMP2 = 33, ASP = 34, UPS = 35, DNS = 36, CUTN = 37, BLN = 38,
        CRK = 39, CRKT = 40, CRL = 41, LPR = 42, VBA = 43, WPH = 44, VBE = 45, VBP = 46, VLP = 47, VBT = 48, CRKD = 49, CRKS = 50,
        TUN = 51, TUNG = 52, NST = 53;      // tunnel 0..1 (smoothed), the engine's reflection gain at the end of the last block
    // per-voice state (VS, VSTR numbers per voice)
    var VGN = 0, VF1 = 1, VF2 = 2, VTH = 3, VPAN = 4, VLD = 5, VBR = 6, VGL = 7, VGR = 8, VWOB = 9, VNZ = 10, VNA = 11, VSTR = 12;

    class F1Synth extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return CFG.params.map(function (p) { return { name: p[0], defaultValue: p[1] * p[4], minValue: p[2] * p[4], maxValue: p[3] * p[4], automationRate: 'k-rate' }; });
      }
      constructor(o) {
        super();
        var po = (o && o.processorOptions) || {}, self = this, v, j;
        this.mask = typeof po.mask === 'number' ? po.mask : 63;
        this.alive = true;
        this.port.onmessage = function (e) { if (e.data === 'stop') self.alive = false; };
        this.ST = new Float64Array(NST);
        this.ST[R1] = 4000; this.ST[R2] = 4000; this.ST[FG] = 1; this.ST[FGT] = 1; this.ST[GS] = 1; this.ST[ASP] = 1; this.ST[LPR] = 1; this.ST[TUNG] = 1;
        this.ST[UPS] = NaN; this.ST[DNS] = NaN;             // the first block only takes the counters over
        this.IS = new Int32Array(1);                        // index of the last cylinder that fired
        this.FB = new Float64Array(NFILT * 6);
        ARG[0] = 1100; ARG[1] = 0.7; svfSet(this.FB, F_POP);
        ARG[0] = 430; ARG[1] = 1.3; svfSet(this.FB, F_T2);
        ARG[0] = 95; ARG[1] = 1.6; svfSet(this.FB, F_G1);
        ARG[0] = 1400; ARG[1] = 0.7; svfSet(this.FB, F_G2);
        this.NS = new Int32Array(NSTREAM * 2);
        for (j = 0; j < NSTREAM; j++) { this.NS[j * 2] = (STREAM_ID[j] * 9973 + 17) & NM; this.NS[j * 2 + 1] = (STREAM_ID[j] * 31337 + 101) % LB; }
        this.PM = new Float64Array(NPMAX); this.PT = new Int8Array(NPMAX); this.PK = new Float64Array(NPMAX); this.PPH = new Float64Array(NPMAX);
        for (j = 0; j < NPMAX; j++) this.PPH[j] = (0.5 + 0.5 * rnd()) * TBL;
        this.PA = new Float64Array(NPMAX); this.PD = new Float64Array(NPMAX); this.PG = new Float64Array(NPMAX);
        this.TB = new Float64Array(NTS);
        this.cyl = 0; this.NP = 0; this.fading = 0;
        this.layout(6);
        this.VS = new Float64Array(NV * VSTR); this.VA = new Float64Array(NV * NPV); this.VGT = new Float64Array(NPV);
        for (v = 0; v < NV; v++) { this.VS[v * VSTR + VF1] = 200; this.VS[v * VSTR + VF2] = 200; this.VS[v * VSTR + VBR] = 1; }
        this.size(128);
      }
      // partial layout for a cylinder count (even); rare (a car change), allocates nothing
      layout(cyl) {
        var h = cyl >> 1, n, m, np = 0, PM = this.PM, PT = this.PT, PK = this.PK;
        for (n = 1; n <= NHALF; n++) {
          PM[np] = n * h;
          if (n & 1) { PT[np] = 1; PK[np] = n > 1 ? n * 0.5 : 1; } else { PT[np] = 0; PK[np] = n * 0.5; }
          np++;
        }
        for (m = 1; m < 2 * cyl && np < NPMAX; m++) if (m % h !== 0) { PM[np] = m; PT[np] = 2; PK[np] = 1; np++; }
        this.NP = np; this.cyl = cyl;
        this.PA.fill(0); this.PD.fill(0); this.PG.fill(0);      // (the engine is at a new place anyway: start its partials at 0)
      }
      size(n) {
        this.N = n;
        this.TH = new Float64Array(n); this.ENG = new Float64Array(n); this.G = new Float64Array(n); this.VB = new Float64Array(n); this.MONO = new Float32Array(n);
        var kb = function (tau) { return 1 - Math.exp(-n / (tau * SR)); };      // one-pole coefficient for a whole block
        this.kb15 = kb(0.015); this.kb30 = kb(0.03); this.kb40 = kb(0.04); this.kb60 = kb(0.06); this.kbTun = kb(T.tunTau);
        // ... and per sample
        this.kR = 1 - Math.exp(-1 / (0.010 * SR)); this.kC = 1 - Math.exp(-1 / (0.004 * SR)); this.kG = 1 - Math.exp(-1 / (0.0025 * SR));
        this.kV = 1 - Math.exp(-1 / (0.012 * SR)); this.kPa = 1 - Math.exp(-1 / (0.001 * SR)); this.kPd = Math.exp(-1 / (0.012 * SR));
        this.kB = 1 - Math.exp(-2 * PI * 14 / SR);
        this.kCa = 1 - Math.exp(-1 / (T.crackRise * SR)); this.kCd = Math.exp(-1 / (T.crackTau * SR)); this.kCl = 1 - Math.exp(-2 * PI * 6000 / SR);
        this.kVd = Math.exp(-1 / (T.vibTau * SR)); this.kVl = 1 - Math.exp(-2 * PI * 400 / SR); this.kVa = 1 - Math.exp(-1 / (0.003 * SR));
      }
      process(inputs, outputs, P) {
        var out = outputs[0];
        if (!out || !out.length) return this.alive;
        var L = out[0], N = L.length, mask = this.mask;
        if (N !== this.N) this.size(N);
        var R = out.length > 1 ? out[1] : this.MONO;                    // (a mono output gets the left channel)
        var ST = this.ST, FB = this.FB, NS = this.NS, TH = this.TH, ENG = this.ENG, G = this.G, VB = this.VB, invN = 1 / N, sd = SEED[0];
        var i, p, q, v, a, b, c, d, x, f, w, n, sum, m, ph, y, e, tgt, o, na, nb, v1, v2, v3;
        var a1, a2, a3, kq, z1, z2;

        // ======================= own car =======================
        ST[SPD] += (P.spd[0] * iSpd - ST[SPD]) * this.kb60;
        var spd = ST[SPD];
        ST[TUN] += (P.tun[0] * iTun - ST[TUN]) * this.kbTun;
        var tun = ST[TUN];                   // (0 outside a tunnel: the reflection gains below are then exactly 1)

        if (mask & 1) {
          var cyl = P.cyl[0] | 0;
          if (cyl < 2) cyl = 2; else if (cyl > 16) cyl = 16;
          if (cyl & 1) cyl++;
          // another engine: its partials fade out over this block, the new layout starts from silence in the next one
          var relayout = cyl !== this.cyl && this.fading !== cyl;
          if (cyl !== this.cyl && !relayout) this.layout(cyl);
          this.fading = relayout ? cyl : 0;
          var PM = this.PM, PT = this.PT, PK = this.PK, PPH = this.PPH, NP = this.NP, TB = this.TB;
          ST[ASP] += (P.asp[0] - ST[ASP]) * this.kb60;
          var hy = ST[ASP], fms = 1 + (T.naFormantScale - 1) * (1 - hy);
          for (q = 0; q < NTS; q++) TB[q] = TN[q] + (TS[q] - TN[q]) * hy;
          var ridle = P.ridle[0], rmax = P.rmax[0] > ridle + 100 ? P.rmax[0] : ridle + 100;
          // gear changes arrive as counters: an upshift starts the ignition cut (stime ms, counted here in samples)
          // with a crack; a downshift a blip and, from high revs, a pop
          x = P.up[0];
          if (x !== ST[UPS]) { if (ST[UPS] === ST[UPS]) { ST[CUTN] = P.stime[0] * 0.001 * SR; ST[CRKD] = 1 + T.crackAt * ST[CUTN]; ST[CRKS] = 0.3 + 0.7 * ST[LOAD]; } ST[UPS] = x; }
          x = P.dn[0];
          if (x !== ST[DNS]) { if (ST[DNS] === ST[DNS]) { ST[BLN] = CFG.blip * SR; if (ST[R2] > ridle + 0.45 * (rmax - ridle)) ST[POPT] = Math.max(ST[POPT], T.dnPop); } ST[DNS] = x; }
          var rpmT = P.rpm[0] * iRpm, limMode = P.lim[0] | 0, PA = this.PA, PD = this.PD, PG = this.PG;
          ST[LOAD] += (P.load[0] * iLoad - ST[LOAD]) * this.kb30;
          ST[BLIP] += ((ST[BLN] > 0 ? 1 : 0) - ST[BLIP]) * this.kb15;
          if (ST[BLN] > 0) ST[BLN] -= N;
          var ld = Math.max(ST[LOAD] * (1 - 0.9 * ST[CS]), ST[BLIP] * 0.75);
          var rn = Math.min(1, Math.max(0, (ST[R2] - ridle) / (rmax - ridle)));
          var lvl = T.engFull * TB[B_GAIN] * (T.engOff + (1 - T.engOff) * Math.pow(ld, 0.75)) * (T.engLow + (1 - T.engLow) * rn);
          // --- spectrum for this block: source weights * tilt * formants, normalised to the level ---
          // (sb: how open the spectrum is. Throttle opens it; at low revs it never closes as far as on the overrun,
          //  so the idle is a rasp and not a hum)
          var sb = ld + (1 - ld) * TB[B_IDLE] * (1 - rn) * (1 - rn);
          var fc = TB[B_TILT0] + (TB[B_TILT1] - TB[B_TILT0]) * sb, alpha = TB[B_AL0] + (TB[B_AL1] - TB[B_AL0]) * sb;
          var gH = TB[B_HALF0] + (TB[B_HALF1] - TB[B_HALF0]) * sb, gC = TB[B_CR0] + (TB[B_CR1] - TB[B_CR0]) * sb, fcyc = ST[R2] / 120;
          sum = 0;
          for (p = 0; p < NP; p++) {
            f = PM[p] * fcyc; PG[p] = 0;
            if (f < FMAX) {
              w = PT[p] === 0 ? Math.pow(PK[p], -alpha) : (PT[p] === 1 ? gH * Math.pow(PK[p], -alpha) : gC);
              x = f / fc; x *= x;
              e = 1;
              for (q = 0; q < NFM; q++) { y = (f - FMC[q] * fms) / (FMW[q] * fms); e += FMG[q] / (1 + y * y); }
              w *= e / Math.sqrt(1 + x * x) * (f * f / (f * f + 4900));
              if (f > 0.9 * FMAX) w *= (FMAX - f) / (0.1 * FMAX);
              PG[p] = w; sum += w * w;
            }
          }
          x = relayout ? 0 : lvl * Math.sqrt(2 / Math.max(sum, 1e-30));
          for (p = 0; p < NP; p++) { PG[p] *= x; PD[p] = (PG[p] - PA[p]) * invN; }

          // --- phase of the engine cycle, per sample; firing-to-firing irregularity; cut and limiter gains ---
          sd = (Math.imul(sd, 1664525) + 1013904223) | 0; ST[JIT] += (sd * RS - ST[JIT]) * 0.06;
          var r1 = ST[R1], r2 = ST[R2], th = ST[THE], fi = this.IS[0], fg = ST[FG], fgT = ST[FGT], cs = ST[CS], gs = ST[GS], lph = ST[LPH], popT = ST[POPT], cutn = ST[CUTN], lpr = ST[LPR];
          var kR = this.kR, kC = this.kC, kG = this.kG, kF = 1 - Math.exp(-(r2 * cyl / 120) / (0.3 * SR)), jm = (1 + ST[JIT] * 0.012) / (120 * SR);
          var burble = ld < 0.1 && rn > 0.25, sig = TB[B_SIG0] + (TB[B_SIG1] - TB[B_SIG0]) * (1 - ld), gT, cutD = T.cutDepth;
          var limStep = (limMode === 2 ? T.pitHz : T.limHz) / SR, limDuty = limMode === 2 ? T.pitDuty : T.limDuty, limFloor = limMode === 2 ? T.pitFloor : T.limFloor;
          var popP = -1 + 2 * T.popRate / (r2 * cyl / 120);
          if (burble) sig += 0.15;
          for (i = 0; i < N; i++) {
            r1 += (rpmT - r1) * kR; r2 += (r1 - r2) * kR;
            th += r2 * jm;
            if (th >= 1) th -= 1;
            TH[i] = th;
            m = (th * cyl) | 0;
            if (m !== fi) {                      // a cylinder fires
              fi = m;
              sd = (Math.imul(sd, 1664525) + 1013904223) | 0;
              fgT = 1 + sig * sd * RS;
              if (burble) {
                sd = (Math.imul(sd, 1664525) + 1013904223) | 0;
                if (sd * RS > 1 - 0.5 * rn) fgT *= 0.3;                       // a weak one
                else if (sd * RS < popP) popT = 1;                            // unburnt fuel lights in the exhaust
              }
            }
            fg += (fgT - fg) * kF;
            if (cutn > 0) { cutn--; cs += (1 - cs) * kC; } else cs -= cs * kC;
            gT = 1;
            if (limMode !== 0) {
              lph += limStep * lpr;
              if (lph >= 1) {
                lph -= 1;
                if (limMode === 2) {              // the pit limiter is a rougher, uneven stutter with the odd pop
                  sd = (Math.imul(sd, 1664525) + 1013904223) | 0; lpr = 0.85 + 0.15 * (1 + sd * RS);
                  sd = (Math.imul(sd, 1664525) + 1013904223) | 0; if (sd * RS > 0.2) popT = T.pitPop;
                }
              }
              if (lph < limDuty) gT = limFloor;
            }
            gs += (gT - gs) * kG;
            G[i] = fg * (1 - cutD * cs) * gs;
            ENG[i] = 0;
          }
          ST[R1] = r1; ST[R2] = r2; ST[THE] = th; this.IS[0] = fi; ST[FG] = fg; ST[FGT] = fgT; ST[CS] = cs; ST[GS] = gs; ST[LPH] = lph; ST[CUTN] = cutn; ST[LPR] = lpr;

          // --- the partials ---
          for (p = 0; p < NP; p++) {
            a = PA[p]; d = PD[p];
            if (a === 0 && d === 0) continue;
            m = PM[p] * TBL; ph = PPH[p];
            for (i = 0; i < N; i++) { a += d; ENG[i] += a * SIN[(m * TH[i] + ph) & MASK]; }
            PA[p] = PG[p];
          }
          // --- exhaust noise, pulsing with the firing; overrun pops; the upshift crack ---
          ARG[0] = TB[B_EXF0] + TB[B_EXF1] * ld; ARG[1] = 0.8; svfSet(FB, F_EX);
          var ea = ST[EA], eaT = lvl * (TB[B_EX0] + (TB[B_EX1] - TB[B_EX0]) * ld) / (KN * Math.sqrt(ARG[0] / 0.8)) * 1.91, dea = (eaT - ea) * invN;
          var popE = ST[POPE], kPa = this.kPa, kPd = this.kPd, popA = T.engFull * T.popAmp / (KN * Math.sqrt(1100 * 0.7));
          var crk = ST[CRK], crkT = ST[CRKT], crl = ST[CRL], crkd = ST[CRKD], kCa = this.kCa, kCd = this.kCd, kCl = this.kCl, crkA = T.engFull * TB[B_GAIN] * T.crackAmp / 0.3;
          o = F_EX * 6; a1 = FB[o]; a2 = FB[o + 1]; a3 = FB[o + 2]; kq = FB[o + 3]; z1 = FB[o + 4]; z2 = FB[o + 5];
          var ob = F_POP * 6, b1 = FB[ob], b2 = FB[ob + 1], b3 = FB[ob + 2], y1 = FB[ob + 4], y2 = FB[ob + 5];
          na = NS[N_EX * 2]; nb = NS[N_EX * 2 + 1];
          var pa = NS[N_POP * 2], pb = NS[N_POP * 2 + 1], ca = NS[N_CRK * 2], cb = NS[N_CRK * 2 + 1];
          for (i = 0; i < N; i++) {
            ea += dea;
            x = NA[na] + NB[nb]; na = (na + 1) & NM; if (++nb === LB) nb = 0;
            v3 = x - z2; v1 = a1 * z1 + a2 * v3; v2 = z2 + a2 * z1 + a3 * v3; z1 = 2 * v1 - z1; z2 = 2 * v2 - z2;
            e = 0.5 - 0.5 * SIN[((TH[i] * cyl + 0.25) * TBL) & MASK];
            y = (ENG[i] + v1 * kq * e * e * ea) * G[i];
            if (crkd > 0) { crkd -= 1; if (crkd <= 0) { crkT = ST[CRKS]; if (popT < T.crackPop * crkT) popT = T.crackPop * crkT; } }     // the upshift crack, part-way into the cut
            if (popT > 1e-4 || popE > 1e-4) {
              popE += (popT - popE) * kPa; popT *= kPd;
              x = NA[pa] + NB[pb]; pa = (pa + 1) & NM; if (++pb === LB) pb = 0;
              v3 = x - y2; v1 = b1 * y1 + b2 * v3; v2 = y2 + b2 * y1 + b3 * v3; y1 = 2 * v1 - y1; y2 = 2 * v2 - y2;
              y += v2 * popE * popA;
            }
            if (crkT > 1e-4 || crk > 1e-4) {
              crk += (crkT - crk) * kCa; crkT *= kCd;
              x = NA[ca] + NB[cb]; ca = (ca + 1) & NM; if (++cb === LB) cb = 0;
              crl += (x - crl) * kCl;
              y += crl * crk * crkA;
            }
            ENG[i] = y;
          }
          FB[o + 4] = z1; FB[o + 5] = z2; FB[ob + 4] = y1; FB[ob + 5] = y2;
          NS[N_EX * 2] = na; NS[N_EX * 2 + 1] = nb; NS[N_POP * 2] = pa; NS[N_POP * 2 + 1] = pb; NS[N_CRK * 2] = ca; NS[N_CRK * 2 + 1] = cb;
          ST[EA] = eaT; ST[POPE] = popE; ST[POPT] = popT; ST[CRK] = crk; ST[CRKT] = crkT; ST[CRL] = crl; ST[CRKD] = crkd;
          // --- turbo whistle ---
          ST[TUR] += (P.tur[0] * iTur - ST[TUR]) * this.kb40;
          sd = (Math.imul(sd, 1664525) + 1013904223) | 0; ST[TJ] += (sd * RS - ST[TJ]) * 0.2;
          var ta = ST[TA], taT = T.engFull * T.turAmp * ST[TUR] * ST[TUR], dta = (taT - ta) * invN;
          if (ta > 1e-6 || taT > 1e-6) {
            var tph = ST[TPH], tst = (T.turF0 + T.turF1 * ST[TUR]) * (1 + 0.004 * ST[TJ]) / SR;
            for (i = 0; i < N; i++) {
              ta += dta; tph += tst; if (tph >= 1) tph -= 1;
              ENG[i] += ta * SIN[(tph * TBL) & MASK];
            }
            ST[TPH] = tph;
          }
          ST[TA] = taT;
          // in a tunnel the walls reflect the engine back: louder, ramped over the block
          var ge = ST[TUNG], geT = Math.exp(tun * T.tunEngDb * DB_K), dge = (geT - ge) * invN;
          for (i = 0; i < N; i++) { ge += dge; y = ENG[i] * ge; L[i] += y; R[i] += y; }
          ST[TUNG] = geT;
        }

        // --- ERS whine: deploy (higher, brighter) and harvest (lower, two detuned tones) ---
        if (mask & 8) {
          var dep0 = ST[DEP], har0 = ST[HAR];
          ST[DEP] += (P.dep[0] * iDep - ST[DEP]) * this.kb40; ST[HAR] += (P.har[0] * iHar - ST[HAR]) * this.kb40;
          if (dep0 > 1e-5 || ST[DEP] > 1e-5) {
            var dph = ST[DPH], dst = (T.depF0 + T.depF1 * spd) / SR, da = dep0 * T.depAmp * 1.33, dda = (ST[DEP] - dep0) * T.depAmp * 1.33 * invN;
            for (i = 0; i < N; i++) {
              da += dda; dph += dst; if (dph >= 1) dph -= 1;
              y = da * (SIN[(dph * TBL) & MASK] + 0.35 * SIN[(dph * 2 * TBL) & MASK] + 0.12 * SIN[(dph * 3 * TBL) & MASK]);
              L[i] += y; R[i] += y;
            }
            ST[DPH] = dph;
          }
          if (har0 > 1e-5 || ST[HAR] > 1e-5) {
            var hph = ST[HPH], hph2 = ST[HPH2], hst = (T.harF0 + T.harF1 * spd) / SR, ha = har0 * T.harAmp, dha = (ST[HAR] - har0) * T.harAmp * invN;
            for (i = 0; i < N; i++) {
              ha += dha; hph += hst; if (hph >= 1) hph -= 1; hph2 += hst * 1.011; if (hph2 >= 1) hph2 -= 1;
              y = ha * (SIN[(hph * TBL) & MASK] + 0.8 * SIN[(hph2 * TBL) & MASK] + 0.25 * SIN[(hph * 2 * TBL) & MASK]);
              L[i] += y; R[i] += y;
            }
            ST[HPH] = hph; ST[HPH2] = hph2;
          }
        }

        // --- wind (two decorrelated channels) and road roar ---
        if (mask & 2) {
          sd = (Math.imul(sd, 1664525) + 1013904223) | 0; ST[GUST] += (sd * RS - ST[GUST]) * 0.012;
          var vr = Math.min(spd, 120) / T.vRef, gu = Math.min(1.4, Math.max(0.6, 1 + 2.2 * ST[GUST]));
          var tr = Math.exp(tun * T.tunRoarDb * DB_K);                                 // (the tunnel's reflections)
          var waT = T.windFull * Math.pow(vr, T.windExp) * gu * tr, raT = T.roadFull * Math.pow(vr, T.roadExp) * tr, wa = ST[WA], ra = ST[RA];
          if (wa > 1e-6 || waT > 1e-6 || ra > 1e-6 || raT > 1e-6) {
            var f1 = 180 + 6 * spd, f2 = 700 + 26 * spd, f3 = 60 + 1.3 * spd;
            ARG[0] = f1; ARG[1] = 0.7; svfSet(FB, F_WL);                                 // (the right channel's filters have the same corners)
            ARG[0] = f2; ARG[1] = 0.55; svfSet(FB, F_HL);
            ARG[0] = f3; ARG[1] = 1.0; svfSet(FB, F_RD);
            var cLo = 0.8 / (KN * Math.sqrt(f1 * 0.7)), cHi = 0.6 / (KN * Math.sqrt(f2 / 0.55)), cRd = 1 / (KN * Math.sqrt(f3)), dwa = (waT - wa) * invN, dra = (raT - ra) * invN;
            var oL = F_WL * 6, oR = F_WR * 6, oH = F_HL * 6, oG = F_HR * 6, oD = F_RD * 6;
            var la1 = FB[oL], la2 = FB[oL + 1], la3 = FB[oL + 2], lz1 = FB[oL + 4], lz2 = FB[oL + 5], rz1 = FB[oR + 4], rz2 = FB[oR + 5];
            var ha1 = FB[oH], ha2 = FB[oH + 1], ha3 = FB[oH + 2], hk = FB[oH + 3], hz1 = FB[oH + 4], hz2 = FB[oH + 5], gz1 = FB[oG + 4], gz2 = FB[oG + 5];
            var ra1 = FB[oD], ra2 = FB[oD + 1], ra3 = FB[oD + 2], dz1 = FB[oD + 4], dz2 = FB[oD + 5], lo;
            var wla = NS[N_WL * 2], wlb = NS[N_WL * 2 + 1], wra = NS[N_WR * 2], wrb = NS[N_WR * 2 + 1], rda = NS[N_RD * 2], rdb = NS[N_RD * 2 + 1];
            for (i = 0; i < N; i++) {
              wa += dwa; ra += dra;
              x = NA[wla] + NB[wlb]; wla = (wla + 1) & NM; if (++wlb === LB) wlb = 0;
              v3 = x - lz2; v1 = la1 * lz1 + la2 * v3; v2 = lz2 + la2 * lz1 + la3 * v3; lz1 = 2 * v1 - lz1; lz2 = 2 * v2 - lz2; lo = v2;
              v3 = x - hz2; v1 = ha1 * hz1 + ha2 * v3; v2 = hz2 + ha2 * hz1 + ha3 * v3; hz1 = 2 * v1 - hz1; hz2 = 2 * v2 - hz2;
              a = (lo * cLo + v1 * hk * cHi) * wa;
              x = NA[wra] + NB[wrb]; wra = (wra + 1) & NM; if (++wrb === LB) wrb = 0;
              v3 = x - rz2; v1 = la1 * rz1 + la2 * v3; v2 = rz2 + la2 * rz1 + la3 * v3; rz1 = 2 * v1 - rz1; rz2 = 2 * v2 - rz2; lo = v2;
              v3 = x - gz2; v1 = ha1 * gz1 + ha2 * v3; v2 = gz2 + ha2 * gz1 + ha3 * v3; gz1 = 2 * v1 - gz1; gz2 = 2 * v2 - gz2;
              b = (lo * cLo + v1 * hk * cHi) * wa;
              x = NA[rda] + NB[rdb]; rda = (rda + 1) & NM; if (++rdb === LB) rdb = 0;
              v3 = x - dz2; v1 = ra1 * dz1 + ra2 * v3; v2 = dz2 + ra2 * dz1 + ra3 * v3; dz1 = 2 * v1 - dz1; dz2 = 2 * v2 - dz2;
              c = v2 * cRd * ra;
              L[i] += a * 0.92 + b * 0.3 + c; R[i] += b * 0.92 + a * 0.3 + c;
            }
            FB[oL + 4] = lz1; FB[oL + 5] = lz2; FB[oR + 4] = rz1; FB[oR + 5] = rz2; FB[oH + 4] = hz1; FB[oH + 5] = hz2; FB[oG + 4] = gz1; FB[oG + 5] = gz2;
            FB[oD + 4] = dz1; FB[oD + 5] = dz2;
            NS[N_WL * 2] = wla; NS[N_WL * 2 + 1] = wlb; NS[N_WR * 2] = wra; NS[N_WR * 2 + 1] = wrb; NS[N_RD * 2] = rda; NS[N_RD * 2 + 1] = rdb;
          }
          ST[WA] = waT; ST[RA] = raT;
        }

        // --- tyre scrub, flat-spot thump, grass rumble ---
        if (mask & 4) {
          ST[SLIP] += (P.slip[0] * iSlip - ST[SLIP]) * this.kb40;
          ST[GRASS] += (P.grass[0] - ST[GRASS]) * this.kb60;
          var tya = ST[TYA], tyT = T.tyreFull * ST[SLIP] * Math.min(1, spd / 22);
          if (tya > 1e-6 || tyT > 1e-6) {
            var dty = (tyT - tya) * invN;
            sd = (Math.imul(sd, 1664525) + 1013904223) | 0; ST[WAN] += (sd * RS - ST[WAN]) * 0.02;
            ARG[0] = 900 * (1 + 0.5 * ST[WAN]); ARG[1] = 6; svfSet(FB, F_T1);
            var c1 = 0.75 / (KN * Math.sqrt(ARG[0] / 6)), c2 = 0.65 / (KN * Math.sqrt(430 / 1.3)), oT = F_T1 * 6, oU = F_T2 * 6;
            var t1a = FB[oT], t2a = FB[oT + 1], t3a = FB[oT + 2], tk = FB[oT + 3], tz1 = FB[oT + 4], tz2 = FB[oT + 5];
            var u1a = FB[oU], u2a = FB[oU + 1], u3a = FB[oU + 2], uk = FB[oU + 3], uz1 = FB[oU + 4], uz2 = FB[oU + 5];
            na = NS[N_TY * 2]; nb = NS[N_TY * 2 + 1];
            for (i = 0; i < N; i++) {
              tya += dty;
              x = NA[na] + NB[nb]; na = (na + 1) & NM; if (++nb === LB) nb = 0;
              v3 = x - tz2; v1 = t1a * tz1 + t2a * v3; v2 = tz2 + t2a * tz1 + t3a * v3; tz1 = 2 * v1 - tz1; tz2 = 2 * v2 - tz2; a = v1 * tk;
              v3 = x - uz2; v1 = u1a * uz1 + u2a * v3; v2 = uz2 + u2a * uz1 + u3a * v3; uz1 = 2 * v1 - uz1; uz2 = 2 * v2 - uz2;
              y = (a * c1 + v1 * uk * c2) * tya;
              L[i] += y; R[i] += y;
            }
            FB[oT + 4] = tz1; FB[oT + 5] = tz2; FB[oU + 4] = uz1; FB[oU + 5] = uz2; NS[N_TY * 2] = na; NS[N_TY * 2 + 1] = nb;
          }
          ST[TYA] = tyT;
          // flat spot: one thump per wheel turn (a damped low tone with a little grit)
          ST[VBA] += (P.vib[0] * iVib * Math.min(1, spd / 8) - ST[VBA]) * this.kb40;
          var vbe = ST[VBE], vbt = ST[VBT];
          if (ST[VBA] > 1e-4 || vbe > 1e-4) {
            var wph = ST[WPH], wst = spd / (PI * CFG.wheelD) / SR, vbp = ST[VBP], vst = T.vibHz / SR, vlp = ST[VLP], kVd = this.kVd, kVl = this.kVl, kVa = this.kVa, vA = T.vibAmp * ST[VBA];
            na = NS[N_VIB * 2]; nb = NS[N_VIB * 2 + 1];
            for (i = 0; i < N; i++) {
              wph += wst;
              if (wph >= 1) { wph -= 1; vbt = 1; }                           // (the body tone runs on: no phase reset)
              vbe += (vbt - vbe) * kVa; vbt *= kVd; vbp += vst; if (vbp >= 1) vbp -= 1;
              x = NA[na] + NB[nb]; na = (na + 1) & NM; if (++nb === LB) nb = 0;
              vlp += (x - vlp) * kVl;
              y = vbe * (0.7 * SIN[(vbp * TBL) & MASK] + T.vibSlap * vlp) * vA;
              L[i] += y; R[i] += y;
            }
            ST[WPH] = wph; ST[VBP] = vbp; ST[VLP] = vlp; NS[N_VIB * 2] = na; NS[N_VIB * 2 + 1] = nb;
          }
          ST[VBE] = vbe; ST[VBT] = vbt;
          var ga = ST[GA], gaT = T.grassFull * ST[GRASS] * Math.min(1, spd / 25);
          if (ga > 1e-6 || gaT > 1e-6) {
            var dga = (gaT - ga) * invN, bump = ST[BUMP], bump2 = ST[BUMP2], kB = this.kB;
            var cB = 1.4 / (0.5774 * Math.sqrt(kB / (2 - kB))), g1 = 1 / (KN * Math.sqrt(95 * 1.6)), g2 = 0.3 / (KN * Math.sqrt(1400 / 0.7)), oA = F_G1 * 6, oB = F_G2 * 6;
            var q1a = FB[oA], q2a = FB[oA + 1], q3a = FB[oA + 2], qz1 = FB[oA + 4], qz2 = FB[oA + 5];
            var s1a = FB[oB], s2a = FB[oB + 1], s3a = FB[oB + 2], sk = FB[oB + 3], sz1 = FB[oB + 4], sz2 = FB[oB + 5];
            na = NS[N_GR * 2]; nb = NS[N_GR * 2 + 1];
            var ba = NS[N_BP * 2], bb = NS[N_BP * 2 + 1];
            for (i = 0; i < N; i++) {
              ga += dga;
              x = NA[na] + NB[nb]; na = (na + 1) & NM; if (++nb === LB) nb = 0;
              v3 = x - qz2; v1 = q1a * qz1 + q2a * v3; v2 = qz2 + q2a * qz1 + q3a * v3; qz1 = 2 * v1 - qz1; qz2 = 2 * v2 - qz2; lo = v2;
              v3 = x - sz2; v1 = s1a * sz1 + s2a * v3; v2 = sz2 + s2a * sz1 + s3a * v3; sz1 = 2 * v1 - sz1; sz2 = 2 * v2 - sz2;
              x = NA[ba] + NB[bb]; ba = (ba + 1) & NM; if (++bb === LB) bb = 0;
              bump += (x - bump) * kB; bump2 += (bump - bump2) * kB;
              a = Math.max(0.1, 0.7 + 0.45 * bump2 * cB);
              y = (lo * g1 * a + v1 * sk * g2) * ga;
              L[i] += y; R[i] += y;
            }
            FB[oA + 4] = qz1; FB[oA + 5] = qz2; FB[oB + 4] = sz1; FB[oB + 5] = sz2;
            NS[N_GR * 2] = na; NS[N_GR * 2 + 1] = nb; NS[N_BP * 2] = ba; NS[N_BP * 2 + 1] = bb;
            ST[BUMP] = bump; ST[BUMP2] = bump2;
          }
          ST[GA] = gaT;
        }

        // ======================= remote cars =======================
        if (mask & 16) {
          var kV = this.kV, kb40 = this.kb40, kb60 = this.kb60, kb15 = this.kb15, VS = this.VS, VA = this.VA, VGT = this.VGT;
          var vo, vao, base, gl, gr, dgl, dgr, f1v, f2v, thv, nav, dna, nz, kN, al, vfc, vlvl, vl, br, fh, naT, ang, vgT, vfT, vlT, vpT, vbT;
          for (v = 0; v < NV; v++) {
            vo = v * VSTR; vao = v * NPV; base = V0 + v * 5;
            vgT = P[names[base + 2]][0] * iVG;
            if (vgT <= 0 && VS[vo + VGN] < 1e-5) { VS[vo + VGN] = 0; VS[vo + VGL] = 0; VS[vo + VGR] = 0; VS[vo + VNA] = 0; continue; }
            vfT = P[names[base]][0] * iVF; vlT = P[names[base + 1]][0] * iVL; vpT = P[names[base + 3]][0] * iVP; vbT = P[names[base + 4]][0] * iVB;
            if (VS[vo + VGN] < 0.002) {                          // a voice that starts (or restarts): no glide
              VS[vo + VF1] = vfT; VS[vo + VF2] = vfT; VS[vo + VPAN] = vpT; VS[vo + VLD] = vlT; VS[vo + VBR] = vbT;
            }
            VS[vo + VGN] += (vgT - VS[vo + VGN]) * kb40; VS[vo + VPAN] += (vpT - VS[vo + VPAN]) * kb15;
            VS[vo + VLD] += (vlT - VS[vo + VLD]) * kb40; VS[vo + VBR] += (vbT - VS[vo + VBR]) * kb60;
            sd = (Math.imul(sd, 1664525) + 1013904223) | 0; VS[vo + VWOB] += (sd * RS - VS[vo + VWOB]) * 0.05;
            vl = VS[vo + VLD]; br = VS[vo + VBR]; fh = VS[vo + VF2] * 0.5;
            al = 1.9 - 1.0 * vl + 0.9 * (1 - br); vfc = (900 + 4300 * vl) * (0.3 + 0.7 * br);
            vlvl = T.voiceFull * (T.voiceOff + (1 - T.voiceOff) * Math.pow(vl, 0.8)) * (1 + 0.5 * VS[vo + VWOB]);
            sum = 0;
            for (n = 1; n <= NPV; n++) {
              f = n * fh; VGT[n - 1] = 0;
              if (f < FMAX) {
                w = (n & 1) ? 0.34 * Math.pow(Math.max(1, n * 0.5), -al) : Math.pow(n * 0.5, -al);
                x = f / vfc; x *= x;
                e = 1;
                for (q = 0; q < NFM; q++) { y = (f - FMC[q]) / FMW[q]; e += FMG[q] / (1 + y * y); }
                w *= e / Math.sqrt(1 + x * x);
                VGT[n - 1] = w; sum += w * w;
              }
            }
            x = vlvl * Math.sqrt(2 / Math.max(sum, 1e-30));
            f1v = VS[vo + VF1]; f2v = VS[vo + VF2]; thv = VS[vo + VTH];
            for (i = 0; i < N; i++) {
              f1v += (vfT - f1v) * kV; f2v += (f1v - f2v) * kV;
              thv += f2v * 0.5 / SR; if (thv >= 1) thv -= 1;
              TH[i] = thv; VB[i] = 0;
            }
            VS[vo + VF1] = f1v; VS[vo + VF2] = f2v; VS[vo + VTH] = thv;
            for (n = 1; n <= NPV; n++) {
              tgt = VGT[n - 1] * x; a = VA[vao + n - 1]; d = (tgt - a) * invN;
              if (a === 0 && d === 0) continue;
              m = n * TBL; ph = VPH[n - 1];
              for (i = 0; i < N; i++) { a += d; VB[i] += a * SIN[(m * TH[i] + ph) & MASK]; }
              VA[vao + n - 1] = tgt;
            }
            // exhaust roar: low-passed noise, darker with distance
            kN = 1 - Math.exp(-2 * PI * (600 + 2600 * br) / SR);
            nav = VS[vo + VNA]; naT = vlvl * (0.2 + 0.4 * vl) / (0.5774 * Math.sqrt(kN / (2 - kN)));
            dna = (naT - nav) * invN; nz = VS[vo + VNZ];
            na = NS[(N_V0 + v) * 2]; nb = NS[(N_V0 + v) * 2 + 1];
            ang = (VS[vo + VPAN] + 1) * PI / 4; gl = VS[vo + VGL]; gr = VS[vo + VGR];
            dgl = (VS[vo + VGN] * Math.cos(ang) - gl) * invN; dgr = (VS[vo + VGN] * Math.sin(ang) - gr) * invN;
            for (i = 0; i < N; i++) {
              nav += dna; gl += dgl; gr += dgr;
              x = NA[na] + NB[nb]; na = (na + 1) & NM; if (++nb === LB) nb = 0;
              nz += (x - nz) * kN;
              y = VB[i] + nz * nav;
              L[i] += y * gl; R[i] += y * gr;
            }
            VS[vo + VNA] = naT; VS[vo + VNZ] = nz; VS[vo + VGL] = gl; VS[vo + VGR] = gr;
            NS[(N_V0 + v) * 2] = na; NS[(N_V0 + v) * 2 + 1] = nb;
          }
        }
        SEED[0] = sd;
        return this.alive;
      }
    }
    try { registerProcessor('f1-synth', F1Synth); } catch (e) {}       // already there: a second instance on the same context
  }

  // the AudioWorklet module as source text (loaded from a Blob URL; devtests run it on the main thread to measure it)
  function workletSource() {
    return '(' + workletMain.toString() + ')(' + JSON.stringify({ NV: MAX_VOICES, T: T, TS: timbreSet(false), TN: timbreSet(true), params: paramTable(),
      noiseHz: NOISE_HZ, blip: BLIP_TIME, wheelD: WHEEL_D }) + ');';
  }

  // =====================================================================================================
  F1.createAudio = function (opts) {
    opts = opts || {};
    var AC = root.AudioContext || root.webkitAudioContext;
    var maskBits = typeof opts.mask === 'number' ? opts.mask : M_ALL;
    var ctx = null, ownCtx = false, offline = false, ready = false, building = false, wantInit = false, gen = 0, everRan = false;
    var backend = null, mix = null, act = null, master = null, chain = [], thumpBuf = null, shots = null, oneShots = [], suspendTimer = 0;
    var stalled = false, pageHidden = false, stallTimer = 0, visHandler = null, seenFrame = -1, stillTicks = 0;
    var ctl = new Float32Array(NCTL), frame = 0, warned = false;
    var fadeT0 = 0, fadeT1 = 0, fadeV0 = 0, fadeV1 = 0;        // the fade scheduled on the active gain (we are the only one who schedules it)
    // tunnel (setTunnel): the graph's tap (the high-pass), the mid band (band-pass -> gain) and the reverb (convolver ->
    // wet gain), whether their inputs are connected, the size the convolver's impulse response was made for
    var tunIn = null, tunBand = null, tunMid = null, tunConv = null, tunWet = null, tunOn = false, tunIrW = 0, tunIrH = 0;

    // ---- own car: what is remembered between frames, what the functions of the control layer hand each other and
    //      their scratch values. Every non-integer number of the per-frame path lives in this typed array (or in the
    //      voices' arrays, or in a local that is assigned once). V8 allocates a 12-byte box whenever such a number
    //        - is assigned to a closure variable,
    //        - is passed to or returned from a function that does not happen to be inlined,
    //        - meets, in one variable, a value read straight from an object (if / else assigning either),
    //      and that would be garbage every frame. devtests/audio-test/live.js measures it (0 bytes per call). ----
    var S = new Float64Array(48);
    var S_PREVV = 0, S_ACCEL = 1, S_SHIFT = 2, S_SPOOL = 3, S_GAP = 4, S_PEAK = 5,      // last speed, smoothed acceleration, s since the gear change, turbo, contact
        S_LX = 6, S_LY = 7, S_LZ = 8, S_LH = 9, S_LVX = 10, S_LVZ = 11,                // listener: position, heading, velocity
        S_DT = 12,                                                                     // this frame's dt
        S_V = 13, S_A = 14,                                                            // arguments of gearNow / pedals / revs: speed, acceleration
        S_ET = 15, S_EB = 16, S_RPM = 17,                                              // results of pedals() and revs()
        S_NX = 18, S_NY = 19, S_NZ = 20,                                               // the listener's new position
        S_PITT = 21, S_BLIP = 22,                                                      // s since the throttle was open with the pit limiter on; blip on (the fallback's)
        S_0 = 24, S_1 = 25, S_2 = 26, S_3 = 27, S_4 = 28, S_5 = 29, S_6 = 30, S_7 = 31, // scratch
        S_TUN = 32, S_TUNQ = 33, S_TUNZ = 34, S_TUNW = 35, S_TUNH = 36;                 // tunnel: k asked for, k sent to the graph, s at k = 0, size asked for
    var first = true, gearD = 0, prevGear = 0, shiftDir = 0, inContact = false, haveL = false, upN = 0, dnN = 0;
    function initS() { S.fill(0); S[S_SHIFT] = 9; S[S_GAP] = 9; S[S_PITT] = 9; S[S_TUNQ] = -1; S[S_TUNZ] = 9; S[S_TUNW] = T.tunWidth; S[S_TUNH] = T.tunHeight; }
    initS();
    // ---- engines: the own car's (setEngine), one per voice for the remote cars ----
    var OWN = new Engine(), ownSpec = null, ownGen = 0;
    var vEng = [];
    // ---- voices ----
    var vState = new Int8Array(MAX_VOICES);           // 0 free, 1 sounding, 2 fading out
    var vId = new Array(MAX_VOICES), vIdx = new Int16Array(MAX_VOICES), vTimer = new Float32Array(MAX_VOICES), vGear = new Int8Array(MAX_VOICES);
    var vSpd = new Float64Array(MAX_VOICES), vAcc = new Float64Array(MAX_VOICES), vX = new Float64Array(MAX_VOICES), vY = new Float64Array(MAX_VOICES),
        vZ = new Float64Array(MAX_VOICES), vMx = new Float64Array(MAX_VOICES), vMz = new Float64Array(MAX_VOICES), vVx = new Float64Array(MAX_VOICES),
        vVz = new Float64Array(MAX_VOICES), vDop = new Float64Array(MAX_VOICES), vFresh = new Uint8Array(MAX_VOICES);
    var oD = new Float32Array(MAX_OTHERS), oV = new Int8Array(MAX_OTHERS);
    var vi;
    for (vi = 0; vi < MAX_VOICES; vi++) { vId[vi] = null; vEng.push(new Engine()); ctl[C_V0 + vi * V_STRIDE] = 200; ctl[C_V0 + vi * V_STRIDE + 4] = 1; }
    function applyOwn() { ctl[C_CYL] = OWN.cyl; ctl[C_ASP] = OWN.na ? 0 : 1; ctl[C_RIDLE] = OWN.idle; ctl[C_RMAX] = OWN.max; ctl[C_STIME] = Math.round(OWN.shiftTime * 1000); }
    refreshRef(); copyEngine(OWN, REF); applyOwn();
    ctl[C_RPM] = OWN.idle;

    var dbg = {
      backend: 'none', ready: false, context: null, output: null, compressor: null, frames: 0, errors: 0, lastError: null,
      rpm: OWN.idle, gear: 0, throttle: 0, brake: 0, cut: 0, blip: 0, limiter: 0, speed: 0, deploy: 0, harvest: 0, slip: 0, turbo: 0, vib: 0,
      upshifts: 0, downshifts: 0, stalled: false, thumps: 0, beeps: 0, shots: 0, voices: 0, voiceStarts: 0, steals: 0, paramWrites: 0, voiceId: vId, voiceState: vState,
      voiceDist: new Float32Array(MAX_VOICES), voiceRpm: new Float32Array(MAX_VOICES), voiceDoppler: new Float32Array(MAX_VOICES), ctl: ctl, engine: OWN,
      tunnel: 0, reverb: false, reverbBuilds: 0,     // tunnel k sent to the graph, reverb connected, impulse responses made,
      tunnelWet: null, tunnelMid: null               //   the reverb's wet gain and the mid band's gain (AudioParams; tests)
    };
    var api = {
      supported: !!(opts.context || AC),
      volume: 1, muted: false, active: false,
      init: init, setVolume: setVolume, setMuted: setMuted, setActive: setActive, setEngine: setEngine, update: update, beep: beep, play: play, dispose: dispose,
      setTunnel: setTunnel,
      MAX_VOICES: MAX_VOICES, C_SOUND: C_SOUND, D_REF: D_REF, D_EXP: D_EXP, D_FADE: D_FADE, D_MAX: D_MAX, tuning: T,
      attenuation: attenuation,
      gearFor: function (v) { return gearOf(OWN, +v); },                  // the own engine's drivetrain (no hysteresis)
      rpmFor: function (v, g) { return rpmOf(OWN, +v, g === undefined ? undefined : g | 0); },
      debug: dbg
    };

    function fail(e) {
      dbg.errors++; dbg.lastError = e;
      if (!warned && root.console) { warned = true; try { root.console.warn('F1.audio: ' + (e && e.stack ? e.stack : e)); } catch (x) {} }
    }
    // May a suspended context be resumed now? Yes once it has run at all (the autoplay policy let it, or a gesture
    // did), or once the page has had a gesture. (Asking earlier only earns another console notice where a gesture is
    // required.)
    function mayResume() {
      if (everRan) return true;
      var ua = root.navigator && root.navigator.userActivation;
      return !ua || !!ua.hasBeenActive;
    }

    // ---------------------------------------------------------------- the own engine
    function setEngine(spec) {
      try {
        refreshRef();
        ownSpec = spec && typeof spec === 'object' ? spec : null;
        fillEngine(OWN, ownSpec, REF);
        ownGen++; applyOwn();
        gearD = prevGear = 0; first = true;
      } catch (e) { fail(e); }
    }

    // ---------------------------------------------------------------- tunnel
    // k 0..1 (NaN / junk: 0); width / height in metres, kept when missing or absurd. Only stores numbers (the next
    // update() applies them), so it can be called every frame without allocating.
    function setTunnel(k, width, height) {
      S[S_TUN] = typeof k === 'number' && k > 0 ? (k < 1 ? k : 1) : 0;
      if (typeof width === 'number' && width >= 2 && width <= 200) S[S_TUNW] = width;
      if (typeof height === 'number' && height >= 2 && height <= 60) S[S_TUNH] = height;
    }
    // The impulse response for the size asked for (rare: the first tunnel, or one of another size; allocates).
    function tunImpulse() {
      var mk = F1.tunnelImpulse, ir, buf, sr;
      if (typeof mk !== 'function' || !tunConv) return;
      try {
        sr = ctx.sampleRate;
        ir = mk(sr, { width: S[S_TUNW], height: S[S_TUNH], rt60: T.tunRt60 });
        buf = ctx.createBuffer(2, ir.left.length, sr);
        buf.getChannelData(0).set(ir.left); buf.getChannelData(1).set(ir.right);
        tunConv.buffer = buf;
        tunIrW = S[S_TUNW]; tunIrH = S[S_TUNH];
        dbg.reverbBuilds++;
      } catch (e) { fail(e); }
    }
    // Once per update(), after ctl[C_TUN] and S[S_TUNZ]: connects the reverb and the mid band while in use (and
    // disconnects them T.tunOff s after k fell to 0: no CPU outside tunnels), ramps their gains to k.
    function tunnelGraph() {
      var k = ctl[C_TUN], sized = tunIrW === S[S_TUNW] && tunIrH === S[S_TUNH];
      if (k > 0 && !tunOn) {
        if (!tunConv.buffer || !sized) tunImpulse();
        try { tunIn.connect(tunBand); if (tunConv.buffer) tunIn.connect(tunConv); } catch (e) { fail(e); }
        tunOn = true;
      } else if (tunOn && k === 0 && S[S_TUNZ] > T.tunOff) {
        try { tunIn.disconnect(tunBand); } catch (e) {}
        try { tunIn.disconnect(tunConv); } catch (e) {}
        tunOn = false;
      } else if (tunOn && !sized && k === 0 && S[S_TUNZ] > 0.4 && typeof F1.tunnelImpulse === 'function') {
        // another size asked for while the reverb is still connected but silent (its wet gain long at 0)
        try { tunIn.disconnect(tunConv); } catch (e) {}
        tunImpulse();
        try { if (tunConv.buffer) tunIn.connect(tunConv); } catch (e) { fail(e); }
      }
      if (k !== S[S_TUNQ]) {
        S[S_TUNQ] = k;
        tunWet.gain.setTargetAtTime(T.tunWet * k, 0, T.tunTau);
        tunMid.gain.setTargetAtTime(Math.exp(T.tunMidDb * k * LN10_20) - 1, 0, T.tunTau);
        dbg.paramWrites += 2;
      }
      dbg.tunnel = k; dbg.reverb = tunOn && !!tunConv.buffer;
    }

    // ---------------------------------------------------------------- start up
    function init(o) {
      wantInit = true;
      try {
        if (!api.supported) return Promise.resolve(false);
        if (ctx && ownCtx && ctx.state === 'closed') teardown();          // closed behind our back: start afresh
        if (!ctx) {
          readPerf();
          if (!ownSpec) { copyEngine(OWN, REF); ownGen++; applyOwn(); }
          if (opts.context) { ctx = opts.context; ownCtx = false; }
          else {
            try { ctx = new AC({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE }); } catch (e) { ctx = new AC(); }
            ownCtx = true;
          }
          offline = typeof ctx.startRendering === 'function';
          dbg.context = ctx;
          if (!offline) watch();
        }
        if (!offline && ctx.state === 'running') everRan = true;
        if (!offline && ctx.state === 'suspended' && (api.active || !ready) && mayResume()) resume();
        if (ready) return Promise.resolve(true);
        if (!building) building = build();
        return building;
      } catch (e) { fail(e); return Promise.resolve(false); }
    }
    function resume() {
      try { var p = ctx.resume(); if (p && p.then) p.then(null, function () {}); } catch (e) {}
    }
    // the stall watchdog and the page's visibility (real-time contexts only)
    function watch() {
      // (update() only counts frames: reading a clock there would allocate)
      if (!stallTimer && root.setInterval) stallTimer = root.setInterval(function () {
        if (frame !== seenFrame) { seenFrame = frame; stillTicks = 0; return; }
        if (++stillTicks * STALL_TICK >= STALL_MS && api.active && !stalled && ready) { stalled = true; dbg.stalled = true; gate(); }
      }, STALL_TICK);
      var doc = root.document;
      if (!visHandler && doc && doc.addEventListener) {
        visHandler = function () {                    // (pageHidden keeps the stall on while update() goes on)
          pageHidden = !!doc.hidden;
          if (pageHidden && api.active && !stalled) { stalled = true; dbg.stalled = true; gate(); }
        };
        doc.addEventListener('visibilitychange', visHandler);
      }
    }
    function unwatch() {
      if (stallTimer) { try { root.clearInterval(stallTimer); } catch (e) {} stallTimer = 0; }
      if (visHandler) { try { root.document.removeEventListener('visibilitychange', visHandler); } catch (e) {} visHandler = null; }
      pageHidden = false;
    }
    function softClipCurve() {
      var n = 8193, c = new Float32Array(n), i, x, a;
      for (i = 0; i < n; i++) {
        x = (i / (n - 1)) * 2 - 1; a = x < 0 ? -x : x;
        if (a > T.clipKnee) a = T.clipKnee + T.clipRange * Math.tanh((a - T.clipKnee) / T.clipRange);
        c[i] = x < 0 ? -a : a;
      }
      return c;
    }
    // ---- rendered once per graph: the impact thump and the one-shots of play() (all peak-normalised to 1) ----
    function render(dur, fn) {
      var sr = ctx.sampleRate, n = Math.round(sr * dur), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), i, pk = 0, y, fade = Math.round(sr * 0.01);
      var st = { sd: 0x51ED27 | 0, a: 0, b: 0, c: 0, p: 0, q: 0 };
      for (i = 0; i < n; i++) {
        y = fn(i / sr, st, sr);
        if (i > n - fade) y *= (n - i) / fade;
        d[i] = y;
        if (y > pk) pk = y; else if (-y > pk) pk = -y;
      }
      if (pk > 0) for (i = 0; i < n; i++) d[i] /= pk;
      return buf;
    }
    function noiseOf(st) { st.sd = (Math.imul(st.sd, 1664525) + 1013904223) | 0; return st.sd * 4.656612873077393e-10; }
    function makeThump() {                           // a falling thud, a burst of crunch and a short clank
      var k = 1 - Math.exp(-2 * Math.PI * 1200 / ctx.sampleRate), ph = 0;
      return render(0.45, function (t, st, sr) {
        ph += (40 + 70 * Math.exp(-t / 0.05)) / sr;
        var x = noiseOf(st), att = t < 0.003 ? 0.5 - 0.5 * Math.cos(Math.PI * t / 0.003) : 1;
        st.a += (x - st.a) * k; st.b += (st.a - st.b) * k; st.c += (st.b - st.c) * k;
        return att * (0.8 * Math.sin(2 * Math.PI * ph) * Math.exp(-t / 0.09) + 2.6 * st.c * Math.exp(-t / 0.04) +
          0.12 * (Math.sin(2 * Math.PI * 287 * t) + 0.8 * Math.sin(2 * Math.PI * 463 * t) + 0.6 * Math.sin(2 * Math.PI * 731 * t)) * Math.exp(-t / 0.03));
      });
    }
    function makeShots() {
      var TWO_PI = 2 * Math.PI, sr = ctx.sampleRate;
      // wheel gun: an air motor whining up, the hammer rattling at ~60 blows per second, the nut spinning off
      var kh = 1 - Math.exp(-TWO_PI * 5200 / sr), kl = 1 - Math.exp(-TWO_PI * 2600 / sr), wph = 0, hph = 0;
      var pitgun = render(0.42, function (t, st) {
        var x = noiseOf(st), env = Math.min(1, t / 0.012) * (t > 0.32 ? Math.exp(-(t - 0.32) / 0.03) : 1), f = 2300 + 1300 * Math.min(1, t / 0.08), blow, hit;
        wph += f / sr; hph += (58 + 6 * Math.sin(TWO_PI * 3 * t)) / sr;
        hit = hph - Math.floor(hph); blow = Math.exp(-hit / 0.12 * 8);
        st.a += (x - st.a) * kh; st.b += (st.a - st.b) * kl;           // hiss: noise band around 2.5 .. 5 kHz
        return env * (0.35 * Math.sin(TWO_PI * wph) + 0.15 * Math.sin(2 * TWO_PI * wph + 1) + 1.4 * (st.a - st.b) * (0.4 + blow) + 0.25 * blow * Math.sin(TWO_PI * 1650 * t));
      });
      // front jack: a metal clunk (a low knock, a short ring) with a hydraulic hiss behind it
      var kj = 1 - Math.exp(-TWO_PI * 900 / sr), kn = 1 - Math.exp(-TWO_PI * 4000 / sr);
      var jack = render(0.4, function (t, st) {
        var x = noiseOf(st), att = t < 0.002 ? t / 0.002 : 1;
        st.a += (x - st.a) * kj; st.b += (x - st.b) * kn;
        return att * (0.9 * Math.sin(TWO_PI * (85 * t + 20 * (1 - Math.exp(-t / 0.02)) * 0.02)) * Math.exp(-t / 0.07) +
          0.35 * (Math.sin(TWO_PI * 640 * t) + 0.7 * Math.sin(TWO_PI * 1130 * t + 2) + 0.5 * Math.sin(TWO_PI * 1710 * t + 4)) * Math.exp(-t / 0.05) +
          0.9 * st.a * Math.exp(-t / 0.025) + 0.14 * st.b * Math.exp(-t / 0.15));
      });
      // pit-limiter button: two short dashboard beeps, rising (on) or falling (off)
      function beeps(f1, f2) {
        return render(0.26, function (t) {
          var f = t < 0.13 ? f1 : f2, tl = t < 0.13 ? t : t - 0.13, env = tl < 0.004 ? tl / 0.004 : (tl > 0.07 ? Math.max(0, 1 - (tl - 0.07) / 0.005) : 1);
          return env * (Math.sin(TWO_PI * f * t) + 0.25 * Math.sin(TWO_PI * 2 * f * t));
        });
      }
      return { pitgun: pitgun, jack: jack, limiterOn: beeps(1000, 1500), limiterOff: beeps(1500, 1000) };
    }
    function build() {
      var my = ++gen, comp, trim, shaper, hp;
      mix = ctx.createGain();
      hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = SUBSONIC_HZ; hp.Q.value = -3.01;     // (Q in dB for a high-pass: -3.01 dB = 0.707, Butterworth)
      act = ctx.createGain(); act.gain.value = 0;
      fadeT0 = fadeT1 = 0; fadeV0 = fadeV1 = 0;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = T.compThreshold; comp.knee.value = T.compKnee; comp.ratio.value = T.compRatio;
      comp.attack.value = T.compAttack; comp.release.value = T.compRelease;
      trim = ctx.createGain(); trim.gain.value = T.compTrim;
      shaper = ctx.createWaveShaper(); shaper.curve = softClipCurve();
      master = ctx.createGain(); master.gain.value = api.muted ? 0 : api.volume * api.volume;
      mix.connect(hp); hp.connect(act); act.connect(comp); comp.connect(trim); trim.connect(shaper); shaper.connect(master); master.connect(ctx.destination);
      // tunnel (setTunnel): hp -> band-pass -> mid gain -> act and hp -> convolver -> wet gain -> act beside the dry
      // path; their inputs (hp -> ...) are connected by tunnelGraph() only while a tunnel is near (the impulse response
      // is made there too, the first time)
      tunBand = ctx.createBiquadFilter(); tunBand.type = 'bandpass'; tunBand.frequency.value = T.tunMidHz; tunBand.Q.value = T.tunMidQ;   // (linear Q for a band-pass)
      tunMid = ctx.createGain(); tunMid.gain.value = 0;
      tunConv = ctx.createConvolver(); tunConv.normalize = true;
      tunWet = ctx.createGain(); tunWet.gain.value = 0;
      tunBand.connect(tunMid); tunMid.connect(act); tunConv.connect(tunWet); tunWet.connect(act);
      tunIn = hp; tunOn = false; tunIrW = tunIrH = 0; S[S_TUNQ] = -1; dbg.tunnelWet = tunWet.gain; dbg.tunnelMid = tunMid.gain;
      chain = [mix, hp, tunBand, tunMid, tunConv, tunWet, act, comp, trim, shaper, master];
      dbg.output = master; dbg.compressor = comp;
      thumpBuf = makeThump(); shots = makeShots();

      function done(b) {
        if (my !== gen) { try { b.dispose(); } catch (e) {} return false; }       // disposed meanwhile
        backend = b; ready = true; building = false;
        dbg.backend = b.name; dbg.ready = true;
        gate();                                       // fade in if active (never a hard start)
        return true;
      }
      function nodes() { return done(makeNodesBackend()); }
      if (opts.worklet === false || !ctx.audioWorklet || typeof root.AudioWorkletNode !== 'function') {
        try { return Promise.resolve(nodes()); } catch (e) { fail(e); building = false; return Promise.resolve(false); }
      }
      var src = workletSource(), url = null, p;
      try {
        url = root.URL.createObjectURL(new root.Blob([src], { type: 'application/javascript' }));
        p = ctx.audioWorklet.addModule(url);
      } catch (e) { p = Promise.reject(e); }
      return p.then(null, function () {             // Blob URLs refused (a strict CSP): try a data: URL
        return ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(src));
      }).then(function () {
        if (url) try { root.URL.revokeObjectURL(url); } catch (e) {}
        if (my !== gen) return false;
        return done(makeWorkletBackend());
      }).then(null, function () {                   // no worklet after all
        if (my !== gen) return false;
        try { return nodes(); } catch (e) { fail(e); building = false; return false; }
      });
    }

    // ---------------------------------------------------------------- back end: AudioWorklet
    function makeWorkletBackend() {
      var tab = paramTable(), node = new root.AudioWorkletNode(ctx, 'f1-synth', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { mask: maskBits }
      });
      var wp = [], sent = new Float64Array(NCTL), scale = new Float64Array(NCTL), i;
      for (i = 0; i < NCTL; i++) { wp.push(node.parameters.get(tab[i][0])); sent[i] = NaN; scale[i] = tab[i][4]; }
      node.connect(mix);
      return {
        name: 'worklet',
        push: function () {
          var j, x;
          for (j = 0; j < NCTL; j++) {
            x = Math.round(ctl[j] * scale[j]) + 0;                  // a whole number (+ 0: never -0), see paramTable
            if (x !== sent[j] && x === x) { sent[j] = x; wp[j].value = x; dbg.paramWrites++; }
          }
        },
        dispose: function () { try { node.port.postMessage('stop'); } catch (e) {} try { node.disconnect(); } catch (e) {} }
      };
    }

    // ---------------------------------------------------------------- back end: plain nodes
    function makeNodesBackend() {
      var sr = ctx.sampleRate, srcs = [], all = [], np = [], ntau = [], nsent, i, v, n;
      function keep(x) { all.push(x); return x; }
      function gain(g) { var x = keep(ctx.createGain()); x.gain.value = g; return x; }
      // (q is the linear Q everywhere; Web Audio wants dB for low-pass / high-pass)
      function biq(type, f, q, g) {
        var x = keep(ctx.createBiquadFilter());
        x.type = type; x.frequency.value = f; x.Q.value = type === 'lowpass' || type === 'highpass' ? 20 * Math.log(q) / Math.LN10 : q;
        if (g !== undefined) x.gain.value = g;
        return x;
      }
      function reg(param, tau) { np.push(param); ntau.push(tau); return np.length - 1; }
      // periodic wave from partial amplitudes (index = harmonic number), unit RMS, fixed pseudo-random phases
      var sd = 0x2F6E2B1 | 0;
      function rnd() { sd = (Math.imul(sd, 1664525) + 1013904223) | 0; return sd * 4.656612873077393e-10; }
      var phases = [];
      for (i = 0; i <= 48; i++) phases.push(Math.PI * rnd());
      function wave(amps) {
        var re = new Float32Array(amps.length), im = new Float32Array(amps.length), s = 0, j, k;
        for (j = 1; j < amps.length; j++) s += amps[j] * amps[j];
        k = s > 0 ? Math.sqrt(2 / s) : 0;
        for (j = 1; j < amps.length; j++) { amps[j] *= k; re[j] = amps[j] * Math.cos(phases[j]); im[j] = amps[j] * Math.sin(phases[j]); }
        return ctx.createPeriodicWave(re, im, { disableNormalization: true });
      }
      function osc(w, f) { var x = keep(ctx.createOscillator()); if (typeof w === 'string') x.type = w; else x.setPeriodicWave(w); x.frequency.value = f; x.start(); srcs.push(x); return x; }
      // white noise, two decorrelated channels, looped
      // (white up to NOISE_HZ, empty above, like the worklet's)
      var nlen = 131072, nb = ctx.createBuffer(2, nlen, sr), c, d;
      (function () {
        var taps = 63, h = new Float64Array(taps), fcn = Math.min(NOISE_HZ, 0.2 * sr) / sr, mid = (taps - 1) / 2, sum = 0, raw = new Float32Array(nlen + taps), j, m, x, acc;
        for (m = 0; m < taps; m++) {
          x = m - mid;
          h[m] = (x === 0 ? 2 * fcn : Math.sin(2 * Math.PI * fcn * x) / (Math.PI * x)) * (0.42 - 0.5 * Math.cos(2 * Math.PI * m / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * m / (taps - 1)));
          sum += h[m];
        }
        for (c = 0; c < 2; c++) {
          d = nb.getChannelData(c);
          for (j = 0; j < nlen; j++) raw[j] = rnd();
          for (j = 0; j < taps; j++) raw[nlen + j] = raw[j];
          x = 0;
          for (j = 0; j < nlen; j++) { acc = 0; for (m = 0; m < taps; m++) acc += raw[j + m] * h[m]; d[j] = acc / sum; x += d[j]; }
          for (j = 0; j < nlen; j++) d[j] -= x / nlen;                   // no mean: it would leave the low-pass filters as DC
        }
      })();
      function noise(rate, off) { var x = keep(ctx.createBufferSource()); x.buffer = nb; x.loop = true; x.playbackRate.value = rate; x.start(0, off); srcs.push(x); return x; }
      function chainTo(a) { for (var j = 1; j < arguments.length; j++) { a.connect(arguments[j]); a = arguments[j]; } return a; }
      // RMS of white noise (uniform -1..1) after a 2-pole band-pass / low-pass
      function rBP(fc, q) { return 0.5774 * Math.sqrt(Math.PI * fc / (q * sr)); }
      function rLP(fc, q) { return 0.5774 * Math.sqrt(Math.PI * fc * q / sr); }

      // ---- own engine: two waves (throttle open / closed) at half the firing frequency + crank orders; laid out for
      //      the engine (cylinders, aspiration) in layoutEngine() ----
      var NW = 40, WON = new Float64Array(NW + 1), WOFF = new Float64Array(NW + 1), TBN = timbreSet(false), eCyl = 0, eNa = -1;
      var oOn = osc('sine', 100), oOff = osc('sine', 100), oCr = osc('sine', 33);
      var gOn = gain(0), gOff = gain(0), gCr = gain(0), eSum = gain(1), hpE = biq('highpass', 70, 0.707), tilt = biq('lowpass', T.tiltOff, 0.707);
      var am = gain(1), gate = gain(1), cut = gain(1), eOut = gain(T.nodesEngTrim), fmts = [];
      oOn.connect(gOn); gOn.connect(eSum); oOff.connect(gOff); gOff.connect(eSum); oCr.connect(gCr); gCr.connect(eSum);
      var last = chainTo(eSum, hpE);
      for (i = 0; i < T.formants.length; i++) { fmts.push(biq('peaking', T.formants[i][0], T.formants[i][0] / (2 * T.formants[i][1]), 20 * Math.log(1 + T.formants[i][2]) / Math.LN10)); last = chainTo(last, fmts[i]); }
      chainTo(last, tilt, am, gate, cut, eOut);
      function layoutEngine(cyl, na) {
        var h = cyl >> 1, wOn = [0], wOff = [0], wCr = [0], k, kk, m;
        TBN = timbreSet(!!na);
        for (k = 1; k <= NW; k++) {
          kk = k / 2;
          wOn.push((k & 1) ? TBN[5] * Math.pow(k > 1 ? kk : 1, -TBN[3]) : Math.pow(kk, -TBN[3]));
          wOff.push((k & 1) ? TBN[4] * Math.pow(k > 1 ? kk : 1, -TBN[2]) : Math.pow(kk, -TBN[2]));
        }
        for (m = 1; m < 2 * cyl; m++) wCr.push(m % h !== 0 ? 1 : 0);
        oOn.setPeriodicWave(wave(wOn)); oOff.setPeriodicWave(wave(wOff)); oCr.setPeriodicWave(wave(wCr));
        for (k = 1; k <= NW; k++) { WON[k] = wOn[k]; WOFF[k] = wOff[k]; }          // (wave() normalised them: what the oscillators play)
        for (k = 0; k < fmts.length; k++) fmts[k].frequency.value = T.formants[k][0] * (na ? T.naFormantScale : 1);
        eCyl = cyl; eNa = na;
      }
      layoutEngine(ctl[C_CYL] | 0 || 6, ctl[C_ASP] > 0.5 ? 0 : 1);
      // exhaust noise (into the same cut / limiter path)
      var exBp = biq('bandpass', 1500, 0.8), gEx = gain(0);
      chainTo(noise(1, 0.3), exBp, gEx, am);
      // firing-to-firing irregularity: slow noise on the amplitude
      var amDepth = gain(0.1);
      chainTo(noise(0.006, 1.1), biq('lowpass', 90, 0.7), amDepth).connect(am.gain);
      // limiter stutter: a smoothed square wave on the gate gain (rev limiter or pit limiter rate)
      var limDepth = gain(0), oLim = osc('square', T.limHz);
      chainTo(oLim, biq('lowpass', 140, 0.7), limDepth).connect(gate.gain);
      // turbo whistle
      var oTur = osc('sine', T.turF0), gTur = gain(0);
      chainTo(oTur, gTur, eOut);
      if (maskBits & M_ENGINE) eOut.connect(mix);
      // ---- ERS ----
      var oDep = osc(wave([0, 1, 0.35, 0.12]), T.depF0), gDep = gain(0), oH1 = osc('sine', T.harF0), oH2 = osc('sine', T.harF0 * 1.011), gHar = gain(0), ers = gain(1);
      chainTo(oDep, gDep, ers); oH1.connect(gHar); oH2.connect(gHar); gHar.connect(ers);
      if (maskBits & M_ERS) ers.connect(mix);
      // ---- wind and road ----
      var wLo = biq('lowpass', 180, 0.7), wHi = biq('bandpass', 700, 0.55), gWLo = gain(0), gWHi = gain(0), rLo = biq('lowpass', 60, 1.0), gRoad = gain(0), aero = gain(1);
      var wsrc = noise(1, 0.7);
      chainTo(wsrc, wLo, gWLo, aero); chainTo(wsrc, wHi, gWHi, aero);
      chainTo(noise(1, 1.3), rLo, gRoad, aero);
      if (maskBits & M_AERO) aero.connect(mix);
      // ---- tyres, flat spot and grass ----
      var gTyre = gain(0), gGrass = gain(0), surf = gain(1), tsrc = noise(1, 1.7), gsrc = noise(1, 2.3), tA = gain(0.75 / rBP(900, 6)), tB = gain(0.65 / rBP(430, 1.3));
      chainTo(tsrc, biq('bandpass', 900, 6), tA, gTyre); chainTo(tsrc, biq('bandpass', 430, 1.3), tB, gTyre); gTyre.connect(surf);
      var gAm = gain(0.7), gLo = gain(1 / rLP(95, 1.6)), gHi = gain(0.3 / rBP(1400, 0.7));
      chainTo(gsrc, biq('lowpass', 95, 1.6), gLo, gAm, gGrass); chainTo(gsrc, biq('bandpass', 1400, 0.7), gHi, gGrass); gGrass.connect(surf);
      chainTo(noise(0.004, 0.5), biq('lowpass', 14, 0.7), gain(1.5)).connect(gAm.gain);
      // flat spot: a 70 Hz body and tyre slap (noise < 400 Hz) whose level pulses once per wheel turn: the envelope is
      // one decaying pulse per period, an exact Fourier series on an oscillator added to its mean on a gain
      var oVib, gVib = gain(0), vEnv, vre = new Float32Array(33), vim = new Float32Array(33), vmean = 0;
      (function () {
        var K = 2048, j, k, s;
        for (j = 0; j < K; j++) { s = Math.exp(-j / K / 0.22) * Math.min(1, j / K / 0.03); vmean += s / K; for (k = 1; k <= 32; k++) { vre[k] += 2 * s * Math.cos(2 * Math.PI * k * j / K) / K; vim[k] += 2 * s * Math.sin(2 * Math.PI * k * j / K) / K; } }
      })();
      oVib = keep(ctx.createOscillator()); oVib.setPeriodicWave(ctx.createPeriodicWave(vre, vim, { disableNormalization: true })); oVib.frequency.value = 10; oVib.start(); srcs.push(oVib);
      vEnv = gain(vmean); oVib.connect(vEnv.gain);
      chainTo(noise(1, 2.9), biq('lowpass', 400, 0.7), gain(T.vibSlap * 0.25 / rLP(400, 0.707)), vEnv);
      chainTo(osc('sine', T.vibHz), gain(0.7), vEnv);
      chainTo(vEnv, gVib, surf);
      if (maskBits & M_SURFACE) surf.connect(mix);
      // ---- remote cars ----
      var NWV = 16, wV = [0], vo = [], vlp = [], vg = [], vp = [], rem = gain(T.nodesVoiceTrim), vNz = [];
      for (n = 1; n <= NWV; n++) wV.push((n & 1) ? 0.34 * Math.pow(n > 1 ? n / 2 : 1, -1.1) : Math.pow(n / 2, -1.1));
      var vw = wave(wV);
      for (v = 0; v < MAX_VOICES; v++) {
        vo.push(osc(vw, 100)); vlp.push(biq('lowpass', 2000, 0.707)); vg.push(gain(0)); vp.push(keep(ctx.createStereoPanner()));
        // the panner must be fed mono (a stereo input is panned by another law, not equal power): the two noise channels are
        // summed here, which costs 3 dB, hence the sqrt(2)
        vg[v].channelCount = 1; vg[v].channelCountMode = 'explicit'; vg[v].channelInterpretation = 'speakers';
        vNz.push(gain(0.35 * Math.SQRT2 / rLP(1800, 0.707)));
        chainTo(vo[v], vlp[v], vg[v], vp[v], rem);
        chainTo(noise(1, 0.11 + 0.37 * v), biq('lowpass', 1800, 0.707), vNz[v], vg[v]);
      }
      if (maskBits & M_REMOTE) rem.connect(mix);

      // ---- parameters driven every frame: [AudioParam, time constant] ----
      var N_FON = reg(oOn.frequency, 0.012), N_FOFF = reg(oOff.frequency, 0.012), N_FCR = reg(oCr.frequency, 0.012),
          N_GON = reg(gOn.gain, 0.02), N_GOFF = reg(gOff.gain, 0.02), N_GCR = reg(gCr.gain, 0.02), N_TILT = reg(tilt.frequency, 0.03),
          N_GATE = reg(gate.gain, 0.004), N_LIMD = reg(limDepth.gain, 0.004), N_LIMF = reg(oLim.frequency, 0.01),
          N_EXF = reg(exBp.frequency, 0.03), N_EXG = reg(gEx.gain, 0.02), N_AMD = reg(amDepth.gain, 0.05),
          N_TURF = reg(oTur.frequency, 0.04), N_TURG = reg(gTur.gain, 0.04),
          N_DEPF = reg(oDep.frequency, 0.06), N_DEPG = reg(gDep.gain, 0.04), N_H1F = reg(oH1.frequency, 0.06), N_H2F = reg(oH2.frequency, 0.06), N_HARG = reg(gHar.gain, 0.04),
          N_WLF = reg(wLo.frequency, 0.06), N_WHF = reg(wHi.frequency, 0.06), N_WLG = reg(gWLo.gain, 0.06), N_WHG = reg(gWHi.gain, 0.06),
          N_RDF = reg(rLo.frequency, 0.06), N_RDG = reg(gRoad.gain, 0.06), N_TYG = reg(gTyre.gain, 0.04), N_GRG = reg(gGrass.gain, 0.06),
          N_VBF = reg(oVib.frequency, 0.05), N_VBG = reg(gVib.gain, 0.05), N_V = np.length;
      for (v = 0; v < MAX_VOICES; v++) { reg(vo[v].frequency, 0.02); reg(vlp[v].frequency, 0.05); reg(vg[v].gain, 0.04); reg(vp[v].pan, 0.04); }
      // a tunnel's reflections (engine, wind / road): these two gains are automated only from the first tunnel on, so
      // until then they stay plain constants and the sound is bit-identical to the module without tunnels (an
      // automated gain, even one held at 1, takes another path in the browser: 1..3 LSB of difference)
      var tunG = new Float64Array(3);                   // [0] automated yet (0 / 1), [1] / [2] engine / roar gain last sent
      nsent = new Float32Array(np.length);
      for (i = 0; i < nsent.length; i++) nsent[i] = NaN;
      // targets of this frame; the loop at the end of push() sends the ones that changed
      var nt = new Float32Array(np.length), nfresh = new Uint8Array(np.length);
      for (i = 0; i < nt.length; i++) nt[i] = np[i].value;
      var KN = 0.5774 * Math.sqrt(Math.PI / sr);        // RMS of the noise after a band-pass is KN * sqrt(f / q), after a low-pass KN * sqrt(f * q)
      var NF = T.formants.length, FC = new Float64Array(NF), FW = new Float64Array(NF), FG = new Float64Array(NF);
      for (i = 0; i < NF; i++) { FC[i] = T.formants[i][0]; FW[i] = T.formants[i][1]; FG[i] = T.formants[i][2]; }
      // gear-change events: the counters as last seen (the blip comes from the control layer: S[S_BLIP])
      var lastUp = ctl[C_UP];
      function crack(ld, when) {                        // (a one-shot: allocates, but only at an upshift)
        try {
          var s = ctx.createBufferSource(), g = ctx.createGain();
          s.buffer = shots.crack; g.gain.value = T.engFull * T.crackAmp * 2.2 * (0.3 + 0.7 * ld);
          s.connect(g); g.connect(eOut); track(s, [s, g]); s.start(when);
        } catch (e) {}
      }
      // the crack: the band-limited noise above (nothing past NOISE_HZ, like the worklet's), low-passed, enveloped
      var kc = 1 - Math.exp(-2 * Math.PI * 6000 / sr), nd = nb.getChannelData(0);
      if (!shots.crack) shots.crack = render(0.05, function (t, st, r) { st.a += (nd[Math.round(t * r) + 977] - st.a) * kc; return st.a * Math.exp(-t / T.crackTau) * (1 - Math.exp(-t / T.crackRise)); });

      return {
        name: 'nodes',
        // (No helper functions with number arguments in here either, see the control layer. What is left per frame is
        //  what V8 allocates to hand a non-integer number to setTargetAtTime: two 12-byte boxes per changed parameter.)
        push: function () {
          var rpm = ctl[C_RPM], cyl = ctl[C_CYL] | 0, na = ctl[C_ASP] > 0.5 ? 0 : 1, t, ld, bl, spd = ctl[C_SPD];
          var rn, lvl, a, sb, fh, fc, s, j, q, w, f, x, g, k, tu, vr, f1, f2, f3, wa, b, vl, br, base, gT, fm, lm, ridle = ctl[C_RIDLE], rmax = ctl[C_RMAX];
          if (cyl < 2 || cyl > 16 || (cyl & 1)) cyl = 6;
          if (cyl !== eCyl || na !== eNa) layoutEngine(cyl, na);
          // gear changes: the cut is scheduled on the context clock (its length does not depend on the frame rate;
          // the clock is read only then: V8 boxes the number every read)
          if (ctl[C_UP] !== lastUp) {
            lastUp = ctl[C_UP]; t = ctx.currentTime;
            cut.gain.cancelScheduledValues(t); cut.gain.setTargetAtTime(1 - T.cutDepth, t, 0.004); cut.gain.setTargetAtTime(1, t + ctl[C_STIME] * 0.001, 0.004);
            crack(ctl[C_LOAD], t + T.crackAt * ctl[C_STIME] * 0.001);
          }
          ld = ctl[C_LOAD]; bl = S[S_BLIP] * 0.75;
          if (bl > ld) ld = bl;
          rn = (rpm - ridle) / (rmax - ridle); rn = rn > 0 ? (rn < 1 ? rn : 1) : 0;
          lvl = T.engFull * TBN[11] * (T.engOff + (1 - T.engOff) * Math.pow(ld, 0.75)) * (T.engLow + (1 - T.engLow) * rn);
          sb = ld + (1 - ld) * TBN[10] * (1 - rn) * (1 - rn);
          a = Math.pow(sb, 0.6); fh = rpm * cyl / 240; fc = TBN[0] + (TBN[1] - TBN[0]) * sb;
          fm = na ? T.naFormantScale : 1;
          // level after the formant and tilt filters, from the strongest partials
          s = 0;
          for (j = 1; j <= 14; j++) {
            w = WOFF[j] + (WON[j] - WOFF[j]) * a; f = j * fh; x = f / fc; x *= x;
            lm = 1;
            for (q = 0; q < NF; q++) { g = (f - FC[q] * fm) / (FW[q] * fm); lm += FG[q] / (1 + g * g); }
            g = w * lm * (f * f / (f * f + 4900)); s += g * g / (1 + x * x);
          }
          k = s > 0 ? lvl / Math.sqrt(s / 2) : 0;
          nt[N_FON] = fh; nt[N_FOFF] = fh; nt[N_FCR] = rpm / 120;
          nt[N_GON] = k * a; nt[N_GOFF] = k * (1 - a); nt[N_GCR] = k * 0.35 * (TBN[6] + (TBN[7] - TBN[6]) * ld);
          nt[N_TILT] = Math.round(fc / 10) * 10;
          // limiter: the gate gain swings between the floor and 1, at the rev limiter's or the pit limiter's rate
          lm = ctl[C_LIM];
          x = lm > 1.5 ? (1 - T.pitFloor) / 2 : (lm > 0.5 ? (1 - T.limFloor) / 2 : 0);
          nt[N_GATE] = 1 - x; nt[N_LIMD] = x; nt[N_LIMF] = lm > 1.5 ? T.pitHz : T.limHz;
          f = Math.round((TBN[12] + TBN[13] * ld) / 10) * 10;
          nt[N_EXF] = f; nt[N_EXG] = lvl * (TBN[8] + (TBN[9] - TBN[8]) * ld) / (KN * Math.sqrt(f / 0.8));
          nt[N_AMD] = 0.12 + 0.3 * (1 - ld);
          tu = ctl[C_TUR];
          nt[N_TURF] = T.turF0 + T.turF1 * tu; nt[N_TURG] = T.engFull * T.turAmp * tu * tu;
          nt[N_DEPF] = T.depF0 + T.depF1 * spd; nt[N_DEPG] = ctl[C_DEP] * T.depAmp;
          f = T.harF0 + T.harF1 * spd;
          nt[N_H1F] = f; nt[N_H2F] = f * 1.011; nt[N_HARG] = ctl[C_HAR] * T.harAmp;
          vr = (spd < 120 ? spd : 120) / T.vRef;
          f1 = 180 + 6 * spd; f2 = 700 + 26 * spd; f3 = 60 + 1.3 * spd; wa = T.windFull * Math.pow(vr, T.windExp);
          nt[N_WLF] = f1; nt[N_WHF] = f2; nt[N_WLG] = wa * 0.8 / (KN * Math.sqrt(f1 * 0.7)); nt[N_WHG] = wa * 0.6 / (KN * Math.sqrt(f2 / 0.55));
          nt[N_RDF] = f3; nt[N_RDG] = T.roadFull * Math.pow(vr, T.roadExp) / (KN * Math.sqrt(f3));
          nt[N_TYG] = T.tyreFull * ctl[C_SLIP] * (spd < 22 ? spd / 22 : 1);
          nt[N_GRG] = T.grassFull * ctl[C_GRASS] * (spd < 25 ? spd / 25 : 1);
          nt[N_VBF] = Math.max(1, spd / (Math.PI * WHEEL_D)); nt[N_VBG] = T.vibAmp * T.vibNodes * ctl[C_VIB] * (spd < 8 ? spd / 8 : 1);
          x = ctl[C_TUN];
          if (x > 0) tunG[0] = 1;
          if (tunG[0] === 1) {
            g = T.nodesEngTrim * Math.exp(x * T.tunEngDb * LN10_20);
            if (g !== tunG[1]) { tunG[1] = g; eOut.gain.setTargetAtTime(g, 0, T.tunTau); dbg.paramWrites++; }
            g = Math.exp(x * T.tunRoarDb * LN10_20);
            if (g !== tunG[2]) { tunG[2] = g; aero.gain.setTargetAtTime(g, 0, T.tunTau); dbg.paramWrites++; }
          }
          for (j = 0; j < MAX_VOICES; j++) {
            base = C_V0 + j * V_STRIDE; b = N_V + j * 4; gT = ctl[base + 2];
            if (gT <= 0) { nt[b + 2] = 0; continue; }
            vl = ctl[base + 1]; br = ctl[base + 4];
            nt[b] = ctl[base] * 0.5;
            nt[b + 1] = Math.round((900 + 4300 * vl) * (0.3 + 0.7 * br) / 10) * 10;
            nt[b + 2] = gT * T.voiceFull * (T.voiceOff + (1 - T.voiceOff) * Math.pow(vl, 0.8));
            nt[b + 3] = ctl[base + 3];
            if (vFresh[j]) { vFresh[j] = 0; nfresh[b] = 1; nfresh[b + 1] = 1; nfresh[b + 3] = 1; }        // a voice that starts: no glide
          }
          // (setTargetAtTime from time 0 = from now: a start time in the past is clamped to the current time)
          for (j = 0; j < nt.length; j++) {
            x = nt[j];
            if (nfresh[j]) { nfresh[j] = 0; nsent[j] = x; t = ctx.currentTime; np[j].cancelScheduledValues(t); np[j].setValueAtTime(x, t); }
            else if (x !== nsent[j]) { nsent[j] = x; np[j].setTargetAtTime(x, 0, ntau[j]); dbg.paramWrites++; }
          }
        },
        dispose: function () {
          var j;
          for (j = 0; j < srcs.length; j++) try { srcs[j].stop(); } catch (e) {}
          for (j = 0; j < all.length; j++) try { all[j].disconnect(); } catch (e) {}
        }
      };
    }

    // ---------------------------------------------------------------- master controls
    function setVolume(v) {
      v = lim(fin(+v, 1), 0, 1);
      api.volume = v;
      applyMaster();
    }
    function setMuted(on) { api.muted = !!on; applyMaster(); }
    function applyMaster() {
      if (!master) return;
      try { master.gain.setTargetAtTime(api.muted ? 0 : api.volume * api.volume, ctx.currentTime, VOLUME_TAU); } catch (e) { fail(e); }
    }
    function setActive(on) {
      on = !!on;
      if (on === api.active) { if (on && !stalled && ctx && !offline && ctx.state === 'suspended' && mayResume()) resume(); return; }
      api.active = on;
      if (on) { stalled = pageHidden; dbg.stalled = stalled; stillTicks = 0; seenFrame = frame; }
      gate();
    }
    // the active gain: open while active and not stalled; a linear fade from wherever it is now
    function gate() {
      try {
        if (suspendTimer) { root.clearTimeout(suspendTimer); suspendTimer = 0; }
        if (!ctx || !act) return;
        var on = api.active && !stalled, t = ctx.currentTime, g = act.gain, target = on ? 1 : 0, cur, dur;
        if (on && !offline && ctx.state === 'suspended' && mayResume()) resume();
        cur = t >= fadeT1 ? fadeV1 : (t <= fadeT0 ? fadeV0 : fadeV0 + (fadeV1 - fadeV0) * (t - fadeT0) / (fadeT1 - fadeT0));
        if (!(target === fadeV1 && cur === target)) {
          dur = (on ? FADE_IN : FADE_OUT) * Math.abs(target - cur);
          g.cancelScheduledValues(t);
          g.setValueAtTime(cur, t);
          if (dur > 0) g.linearRampToValueAtTime(target, t + dur);
          fadeT0 = t; fadeT1 = t + dur; fadeV0 = cur; fadeV1 = target;
        }
        if (!on && !offline && ownCtx && opts.autoSuspend !== false) {
          suspendTimer = root.setTimeout(function () {
            suspendTimer = 0;
            try { if (!(api.active && !stalled) && ctx && ctx.state === 'running') ctx.suspend(); } catch (e) {}
          }, SUSPEND_AFTER_MS);
        }
      } catch (e) { fail(e); }
    }

    // ---------------------------------------------------------------- one-shots: impact thump, beeps, play()
    function audible() { return ready && (offline || ctx.state === 'running'); }
    function track(src, nodes) {
      oneShots.push(src);
      src.onended = function () {
        var i = oneShots.indexOf(src), j;
        if (i >= 0) oneShots.splice(i, 1);
        for (j = 0; j < nodes.length; j++) try { nodes[j].disconnect(); } catch (e) {}
      };
    }
    function shot(buf, level, rate) {
      var s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = buf; s.playbackRate.value = rate;
      g.gain.value = level;
      s.connect(g); g.connect(mix);
      track(s, [s, g]);
      s.start();
    }
    function thump() {
      var strength = S[S_PEAK];
      dbg.thumps++;
      if (!audible() || !(maskBits & M_FX)) return;
      shot(thumpBuf, T.thump * (0.3 + 0.7 * strength), 1.12 - 0.24 * strength);          // a heavy hit sounds deeper
    }
    function play(kind, strength) {
      try {
        var buf = shots && typeof kind === 'string' && T.shot.hasOwnProperty(kind) ? shots[kind] : null, s = strength === undefined ? 1 : lim(fin(+strength, 1), 0, 1);
        if (!buf) return;
        dbg.shots++;
        if (!audible() || !(maskBits & M_FX) || s <= 0) return;
        shot(buf, T.shot[kind] * (0.25 + 0.75 * s), 1);
      } catch (e) { fail(e); }
    }
    function beep(kind) {
      try {
        dbg.beeps++;
        if (!audible() || !(maskBits & M_FX)) return;
        var go = kind === 'go', t = ctx.currentTime, f = go ? T.beepGoHz : T.beepHz, dur = go ? T.beepGoDur : T.beepDur;
        var o = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f; o2.type = 'sine'; o2.frequency.value = f * 2; g2.gain.value = 0.22;
        g.gain.value = 0;
        g.gain.setValueAtTime(0, t);
        g.gain.setTargetAtTime(T.beepAmp, t, 0.004);
        g.gain.setTargetAtTime(0, t + dur, 0.022);
        o.connect(g); o2.connect(g2); g2.connect(g); g.connect(mix);
        track(o, [o, o2, g2, g]);
        o.start(t); o2.start(t); o.stop(t + dur + 0.25); o2.stop(t + dur + 0.25);
      } catch (e) { fail(e); }
    }

    // ---------------------------------------------------------------- control layer
    // Written so that nothing is allocated (see S above): numbers travel between the functions through S, a value from
    // outside is checked where it is read and stored into S from there, clamps are Math.min / Math.max.
    //   typeof t === 'number' && t > -BIG && t < BIG     is false for NaN, +-Infinity and anything that is not a number

    // gear of engine e for the speed S[S_V] with the downshift hysteresis from the gear before (prev 0: none)
    function gearNow(e, prev) {
      var v = S[S_V], kmh = v * 3.6, n = e.n, g = prev >= 1 && prev <= n ? prev : 1;
      if (v < -0.5) return -1;
      if (!(v >= 0.5)) return 0;
      while (g < n && kmh >= e.gk[g - 1]) g++;
      while (g > 1 && kmh < e.gk[g - 2] - DOWN_HYST) g--;
      return g;
    }
    // pedal positions that explain the acceleration S[S_A] at the speed S[S_V] -> S[S_ET], S[S_EB]
    // (e: the engine, for its power / drag / traction; the brakes are the reference car's)
    function pedals(e, grass) {
      var v = S[S_V], acc = S[S_A], av = Math.abs(v), resist = PH.roll + e.dragK * av * av, dmax, t, b;
      if (grass) resist += 0.8 + 0.16 * av;
      dmax = Math.min(grass ? 5.6 : e.traction, e.power / Math.max(av, 1));
      S[S_ET] = 0; S[S_EB] = 0;
      if (v > 0.5) {
        t = (acc + resist) / dmax; b = (-acc - resist) / (PH.brakeBase + PH.brakeAero * av * av);
        if (t > 0.06) S[S_ET] = Math.min(t, 1);
        if (b > 0.06) S[S_EB] = Math.min(b, 1);
      } else if (v < -0.5) {
        if (acc < -0.3) S[S_ET] = 0.6;
        if (acc > 1) S[S_EB] = 0.5;
      } else if (acc > 0.5) S[S_ET] = 1;
    }
    // engine speed of engine e at the road speed S[S_V] in gear g -> S[S_RPM]   (rpmOf)
    function revs(e, g) {
      var kmh = Math.abs(S[S_V]) * 3.6;
      S[S_RPM] = e.idle;
      if (g !== 0) S[S_RPM] = Math.min(e.max, Math.max(e.idle, e.shift * kmh / (g >= e.n ? e.top : e.gk[g >= 1 ? g - 1 : 0])));
    }
    function release(v) {
      vState[v] = 2; vTimer[v] = VOICE_RELEASE;
      ctl[C_V0 + v * V_STRIDE + 2] = 0;
    }
    // Remote car o (entry i of others, oD[i] metres away) -> the control values of voice v.
    // fresh: the voice has just been given to this car.
    // false: the car has been placed somewhere else (the voice must fade, a new one starts at the new place)
    function voice(v, o, i, fresh) {
      var d = oD[i], dt = S[S_DT], lx = S[S_LX], ly = S[S_LY], lz = S[S_LZ], lh = S[S_LH], base = C_V0 + v * V_STRIDE, e = vEng[v], sp = o.spec;
      var x = o.x * 1, z = o.z * 1, t, haveS, haveH, y, hd, dx, dz, jump, as, k, a, inv, ux, uz, vl, vs, dop, cosb, r, p, b, g;
      // its engine: its own spec, else the own car's
      if (sp !== e.src || (!(sp && typeof sp === 'object') && e.gen !== ownGen)) { fillEngine(e, sp, OWN); e.gen = ownGen; }
      t = o.y; S[S_0] = ly; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_0] = t;
      y = S[S_0];
      t = o.speed; haveS = typeof t === 'number' && t > -BIG && t < BIG; S[S_1] = 0; if (haveS) S[S_1] = Math.min(150, Math.max(-150, t));
      t = o.heading; haveH = typeof t === 'number' && t > -BIG && t < BIG; S[S_2] = 0; if (haveH) S[S_2] = t;
      hd = S[S_2];
      k = dt > 0 ? 1 - Math.exp(-dt / REMOTE_TAU) : 0;
      if (!fresh && dt > 0) {
        dx = x - vX[v]; dz = z - vZ[v];
        jump = Math.sqrt(dx * dx + (y - vY[v]) * (y - vY[v]) + dz * dz);
        as = Math.max(Math.abs(vSpd[v]), Math.abs(S[S_1]));
        if (jump > 3 * as * dt + TELEPORT_SLACK) return false;
        a = 1 - Math.exp(-dt / 0.1);
        vMx[v] += (dx / dt - vMx[v]) * a; vMz[v] += (dz / dt - vMz[v]) * a;
      } else if (fresh) { vMx[v] = 0; vMz[v] = 0; }
      // its velocity (S_3, S_4): from speed and heading, or, when they are not given, from its movement
      if (haveS && haveH) { S[S_3] = S[S_1] * Math.sin(hd); S[S_4] = S[S_1] * Math.cos(hd); }
      else {
        S[S_3] = vMx[v]; S[S_4] = vMz[v];
        if (!haveS) S[S_1] = Math.sqrt(vMx[v] * vMx[v] + vMz[v] * vMz[v]);
      }
      // smoothed: speed and heading come in 20 Hz steps from the network; a step in them would be a step in pitch
      if (fresh) { vSpd[v] = S[S_1]; vVx[v] = S[S_3]; vVz[v] = S[S_4]; vAcc[v] = 0; }
      else if (dt > 0) {
        a = vSpd[v];
        vSpd[v] += (S[S_1] - vSpd[v]) * k;
        vVx[v] += (S[S_3] - vVx[v]) * k; vVz[v] += (S[S_4] - vVz[v]) * k;
        vAcc[v] += (Math.min(40, Math.max(-40, (vSpd[v] - a) / dt)) - vAcc[v]) * (1 - Math.exp(-dt / 0.25));
      }
      S[S_V] = vSpd[v];
      vGear[v] = fresh ? gearNow(e, 0) : gearNow(e, vGear[v]);
      vX[v] = x; vY[v] = y; vZ[v] = z;
      S[S_A] = vAcc[v];
      pedals(e, false);
      revs(e, vGear[v]);
      // Doppler (S_5): listener speed towards the car over car speed away from the listener, along the line between
      // them; S_6: cosine of the angle we are off its tail (+1: right behind its exhaust)
      dx = x - lx; dz = z - lz;
      S[S_5] = 1; S[S_6] = 0;
      if (d > 0.5) {
        inv = 1 / d; ux = dx * inv; uz = dz * inv;
        vl = S[S_LVX] * ux + S[S_LVZ] * uz; vs = vVx[v] * ux + vVz[v] * uz;
        S[S_5] = Math.min(DOPPLER_MAX, Math.max(DOPPLER_MIN, (C_SOUND + vl) / Math.max(C_SOUND + vs, 1)));
        if (haveH) S[S_6] = Math.sin(hd) * ux + Math.cos(hd) * uz;
      }
      if (fresh || !(dt > 0)) { if (fresh) vDop[v] = S[S_5]; } else vDop[v] += (S[S_5] - vDop[v]) * (1 - Math.exp(-dt / DOP_TAU));
      dop = vDop[v]; cosb = S[S_6];
      r = -dx * Math.cos(lh) + dz * Math.sin(lh);                        // metres to the listener's right
      ctl[base] = Math.min(4000, Math.max(20, S[S_RPM] * e.cyl / 120 * dop));
      ctl[base + 1] = Math.round(S[S_ET] * 64) / 64;
      // level by distance (attenuation(), written out) and by where its exhaust points
      ctl[base + 2] = 0;
      if (d < D_MAX) {
        g = Math.pow(D_REF / Math.max(d, D_REF), D_EXP);
        k = Math.min(1, (D_MAX - d) / (D_MAX - D_FADE));
        ctl[base + 2] = Math.round(g * k * k * (3 - 2 * k) * (0.8 + 0.2 * cosb) * 4096) / 4096;
      }
      p = 0.92 * r / Math.sqrt(dx * dx + dz * dz + 2.25);
      ctl[base + 3] = Math.round(Math.min(1, Math.max(-1, p)) * 256) / 256;
      b = (0.25 + 0.75 / (1 + d / 90)) * (0.85 + 0.15 * cosb);
      ctl[base + 4] = Math.round(Math.min(1, Math.max(0, b)) * 64) / 64;
      dbg.voiceDist[v] = d; dbg.voiceRpm[v] = S[S_RPM]; dbg.voiceDoppler[v] = dop;
      return true;
    }
    // jumped: our own car has been placed somewhere else (every voice starts afresh)
    function voices(others, jumped) {
      var dt = S[S_DT], lx = S[S_LX], ly = S[S_LY], lz = S[S_LZ];
      var n = 0, i, v, o, id, t, d, dx, dy, dz, far = -1, busy = 0, fading = 0, pass, best, free;
      if (others && typeof others.length === 'number' && others.length > 0) n = others.length < MAX_OTHERS ? others.length | 0 : MAX_OTHERS;
      for (v = 0; v < MAX_VOICES; v++) vIdx[v] = -1;
      for (i = 0; i < n; i++) {
        o = others[i]; oV[i] = 0;
        if (!o || typeof o !== 'object') { oD[i] = Infinity; continue; }
        t = o.y; S[S_0] = ly; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_0] = t;
        dx = o.x - lx; dz = o.z - lz; dy = S[S_0] - ly;
        d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!(d < 1e9)) { oD[i] = Infinity; continue; }                   // NaN / missing coordinates
        oD[i] = d;
        id = o.id; if (id === undefined || id === null) id = i;
        for (v = 0; v < MAX_VOICES; v++) if (vState[v] === 1 && vIdx[v] < 0 && vId[v] === id) { vIdx[v] = i; oV[i] = v + 1; break; }
      }
      S[S_7] = -1;                                                         // distance of the farthest car with a voice
      for (v = 0; v < MAX_VOICES; v++) {
        if (vState[v] === 2) {
          vTimer[v] -= dt;
          if (vTimer[v] <= 0) { vState[v] = 0; vId[v] = null; } else fading++;
          continue;
        }
        if (vState[v] !== 1) continue;
        i = vIdx[v];
        if (i < 0 || jumped || !(oD[i] < D_MAX)) { release(v); fading++; if (i >= 0 && oD[i] >= D_MAX) oV[i] = -1; continue; }
        if (!voice(v, others[i], i, false)) { release(v); fading++; oV[i] = 0; continue; }
        busy++;
        if (oD[i] > S[S_7]) { S[S_7] = oD[i]; far = v; }
      }
      // free voices go to the nearest cars without one; a much closer car takes over the farthest voice
      for (pass = 0; pass < MAX_VOICES; pass++) {
        best = -1; S[S_0] = D_ALLOC;
        for (i = 0; i < n; i++) if (oV[i] === 0 && oD[i] < S[S_0]) { S[S_0] = oD[i]; best = i; }
        if (best < 0) break;
        free = -1;
        for (v = 0; v < MAX_VOICES; v++) if (vState[v] === 0) { free = v; break; }
        if (free < 0) {
          if (!fading && far >= 0 && S[S_7] > S[S_0] * STEAL_MARGIN + 3) { release(far); dbg.steals++; }
          break;
        }
        o = others[best];
        id = o.id; if (id === undefined || id === null) id = best;
        vState[free] = 1; vId[free] = id; vFresh[free] = 1; oV[best] = free + 1; dbg.voiceStarts++;
        voice(free, o, best, true);
        busy++;
      }
      dbg.voices = busy;
    }

    function step(dtIn, own, listener, others) {
      var o = own || EMPTY, l = listener || o, t, dt, v, av, a, gear, rpm, thr, brk, grass, dep, har, slip, cut, blip, limiter, rn, target, spool, st;
      var lx, ly, lz, oh, jump, jumped = false, r, req, cap, haveOH, pitOn;
      S[S_DT] = 0;
      if (typeof dtIn === 'number' && dtIn > 0) S[S_DT] = Math.min(dtIn, 0.1);
      dt = S[S_DT];
      frame++; dbg.frames = frame;
      if (stalled && api.active && !pageHidden) { stalled = false; dbg.stalled = false; stillTicks = 0; gate(); }
      if ((frame & 31) === 0) {                          // started before a gesture where one is required: try again
        if (wantInit && !ctx) init();
        else if (ctx && !offline && api.active && !stalled && ctx.state === 'suspended' && mayResume()) resume();
      }

      // ---------- own car ----------
      t = o.speed; S[S_V] = 0;
      if (typeof t === 'number' && t > -BIG && t < BIG) S[S_V] = Math.min(150, Math.max(-150, t));
      v = S[S_V]; av = Math.abs(v);
      grass = !!o.onGrass;
      if (first) { first = false; S[S_PREVV] = v; gearD = prevGear = gearNow(OWN, 0); }
      if (dt > 0) {
        a = Math.min(60, Math.max(-60, (v - S[S_PREVV]) / dt));
        S[S_ACCEL] += (a - S[S_ACCEL]) * (1 - Math.exp(-dt / 0.08));
        S[S_PREVV] = v;
      }
      gearD = gearNow(OWN, gearD);
      t = o.gear; gear = gearD;
      if (typeof t === 'number' && t > -BIG && t < BIG) gear = Math.min(OWN.n, Math.max(-1, Math.round(t))) | 0;
      t = o.rpm;
      if (typeof t === 'number' && t > 0 && t < BIG) S[S_RPM] = Math.min(OWN.max, Math.max(300, t)); else revs(OWN, gear);
      rpm = S[S_RPM];
      S[S_A] = S[S_ACCEL];
      pedals(OWN, grass);                                // what the pedals must be doing; what the car says wins
      t = o.throttle; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_ET] = Math.min(1, Math.max(0, t));
      t = o.brake; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_EB] = Math.min(1, Math.max(0, t));
      thr = S[S_ET]; brk = S[S_EB];
      // gear change: an event for the back end (the cut / blip is timed there), and its direction
      if (gear !== prevGear) {
        if (gear >= 1 && prevGear >= 1) {
          shiftDir = gear > prevGear ? 1 : -1; S[S_SHIFT] = 0;
          t = o.shiftDir; if (t === 1 || t === -1) shiftDir = t;
          if (shiftDir === 1) { upN = (upN + 1) & 0xFFFFF; dbg.upshifts++; } else { dnN = (dnN + 1) & 0xFFFFF; dbg.downshifts++; }
        } else shiftDir = 0;
        prevGear = gear;
      } else S[S_SHIFT] += dt;
      t = o.shiftT; S[S_0] = S[S_SHIFT];
      if (typeof t === 'number' && t >= 0 && t < BIG) S[S_0] = t;
      cut = shiftDir === 1 && S[S_SHIFT] < 0.3 && S[S_0] < OWN.shiftTime ? 1 : 0;           // (for debug: the back end times it)
      blip = shiftDir === -1 && S[S_SHIFT] < 0.3 && S[S_0] < BLIP_TIME ? 1 : 0;
      S[S_BLIP] = blip;
      // limiters: the rev limiter at rpmMax on throttle; the pit limiter (state.limiter) while the car is held at the
      // limit (throttle open and hardly accelerating; the throttle reading may drop while the limiter cuts the drive)
      limiter = rpm >= OWN.max - 30 && thr > 0.3 ? 1 : 0;
      t = o.limiter; pitOn = t === true || t === 1;
      if (pitOn && thr > 0.2) S[S_PITT] = 0; else S[S_PITT] += dt;
      if (pitOn && S[S_PITT] < PIT_THR_HOLD && av > 4 && S[S_ACCEL] < PIT_HOLD_ACC) {
        limiter = 2;
        t = o.limitKmh; if (typeof t === 'number' && t > 0 && t < BIG && av * 3.6 < t - 4) limiter = 0;
      }
      t = o.deploy; S[S_1] = 0;
      if (typeof t === 'number' && t > -BIG && t < BIG) S[S_1] = Math.min(1, Math.max(0, t));
      dep = S[S_1];
      t = o.harvest; S[S_2] = 0;
      if (typeof t === 'number' && t > -BIG && t < BIG) S[S_2] = Math.min(1, Math.max(0, t));
      else if (brk > 0) S[S_2] = brk * Math.min(1, av / 70);             // the contract's harvest rule: braking ...
      else if (thr === 0 && av > 20) S[S_2] = 0.12;                      // ... and a little on lift-off
      har = S[S_2];
      t = o.slip; S[S_3] = 0;
      if (typeof t === 'number' && t > -BIG && t < BIG) S[S_3] = Math.min(1, Math.max(0, t));
      else {
        // how far past the grip limit the front tyres are asked to go (the car model's understeer condition, flat road)
        t = o.steer;
        if (av >= 5 && typeof t === 'number' && t > -BIG && t < BIG) {
          r = av / PH.steerSpeedRef;
          r = F1.CAR_PERF && typeof F1.CAR_PERF.steerLockAt === 'function' ? F1.CAR_PERF.steerLockAt(av, 0, t) : PH.steerLock / (1 + r * r);
          req = av * av * Math.abs(Math.tan(t * r)) / PH.wheelbase;
          cap = Math.min(PH.latBase + PH.latAero * av * av, PH.latMax) * (grass ? 0.45 : 1);
          S[S_3] = Math.min(1, Math.max(0, (req / cap - 1) / 0.6));
        }
      }
      slip = S[S_3];
      t = o.vib; S[S_4] = 0;
      if (typeof t === 'number' && t > -BIG && t < BIG) S[S_4] = Math.min(1, Math.max(0, t));
      // turbo (hybrid only): spools up with load and revs, lags behind both ways
      rn = Math.min(1, Math.max(0, (rpm - OWN.idle) / (OWN.max - OWN.idle)));
      target = OWN.na ? 0 : thr * (0.35 + 0.65 * rn);
      if (dt > 0) S[S_SPOOL] += (target - S[S_SPOOL]) * (1 - Math.exp(-dt / (target > S[S_SPOOL] ? 0.22 : 0.55)));
      spool = Math.min(1, Math.max(0, S[S_SPOOL]));

      ctl[C_RPM] = rpm;
      ctl[C_LOAD] = Math.round(thr * 128) / 128;
      ctl[C_UP] = upN; ctl[C_DN] = dnN; ctl[C_LIM] = limiter;
      ctl[C_SPD] = Math.round(av * 16) / 16;
      ctl[C_TUR] = Math.round(spool * 128) / 128;
      ctl[C_DEP] = Math.round(dep * 128) / 128; ctl[C_HAR] = Math.round(har * 128) / 128; ctl[C_SLIP] = Math.round(slip * 128) / 128;
      ctl[C_GRASS] = grass ? 1 : 0; ctl[C_VIB] = Math.round(S[S_4] * 128) / 128;
      // tunnel: own.tunnel (a number) or the last setTunnel(k); the time at k = 0 decides when the reverb is disconnected
      t = o.tunnel; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_TUN] = t > 0 ? (t < 1 ? t : 1) : 0;
      ctl[C_TUN] = Math.round(S[S_TUN] * 64) / 64;
      if (ctl[C_TUN] > 0) S[S_TUNZ] = 0; else S[S_TUNZ] += dt;
      dbg.rpm = rpm; dbg.gear = gear; dbg.throttle = thr; dbg.brake = brk; dbg.cut = cut; dbg.blip = blip; dbg.limiter = limiter;
      dbg.speed = v; dbg.deploy = dep; dbg.harvest = har; dbg.slip = slip; dbg.turbo = spool; dbg.vib = S[S_4];

      // ---------- impact: one thump when contact begins (or gets much harder), not one per frame ----------
      t = o.hit;
      if (typeof t === 'number' && t > HIT_MIN && t < BIG) {
        S[S_4] = Math.min(1, t);
        if (!inContact || S[S_4] > S[S_PEAK] * 1.6 + 0.12) { S[S_PEAK] = S[S_4]; thump(); }
        inContact = true; S[S_GAP] = 0;
      } else if (inContact) {
        S[S_GAP] += dt;
        if (S[S_GAP] > HIT_REARM) { inContact = false; S[S_PEAK] = 0; }
      }

      // ---------- listener (a missing field: the car's own, else 0) ----------
      t = l.x; if (!(typeof t === 'number' && t > -BIG && t < BIG)) t = o.x;
      S[S_NX] = 0; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_NX] = t;
      t = l.y; if (!(typeof t === 'number' && t > -BIG && t < BIG)) t = o.y;
      S[S_NY] = 0; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_NY] = t;
      t = l.z; if (!(typeof t === 'number' && t > -BIG && t < BIG)) t = o.z;
      S[S_NZ] = 0; if (typeof t === 'number' && t > -BIG && t < BIG) S[S_NZ] = t;
      t = o.heading; haveOH = typeof t === 'number' && t > -BIG && t < BIG;
      S[S_5] = 0; if (haveOH) S[S_5] = t;
      oh = S[S_5];
      lx = S[S_NX]; ly = S[S_NY]; lz = S[S_NZ];
      if (haveL && dt > 0) {
        jump = Math.sqrt((lx - S[S_LX]) * (lx - S[S_LX]) + (ly - S[S_LY]) * (ly - S[S_LY]) + (lz - S[S_LZ]) * (lz - S[S_LZ]));
        if (jump > 3 * av * dt + TELEPORT_SLACK) jumped = true;        // our own car was placed somewhere else
      }
      // our velocity, for the Doppler shift: from the car's speed and heading, else from the listener's movement
      st = own && typeof own.speed === 'number';
      if (st && haveOH) { S[S_LVX] = v * Math.sin(oh); S[S_LVZ] = v * Math.cos(oh); }
      else if (haveL && dt > 0 && !jumped) { S[S_LVX] = (lx - S[S_LX]) / dt; S[S_LVZ] = (lz - S[S_LZ]) / dt; }
      else if (jumped) { S[S_LVX] = 0; S[S_LVZ] = 0; }
      S[S_LX] = lx; S[S_LY] = ly; S[S_LZ] = lz; haveL = true;
      t = l.heading; S[S_LH] = oh;
      if (typeof t === 'number' && t > -BIG && t < BIG) S[S_LH] = t;

      voices(others, jumped);

      if (tunWet) tunnelGraph();
      if (backend && (offline || ctx.state === 'running')) { everRan = true; backend.push(); }
    }
    var EMPTY = {};
    function update(dt, own, listener, others) {
      try { step(dt, own, listener, others); } catch (e) { fail(e); }
    }

    // ---------------------------------------------------------------- shut down
    function teardown() {
      var i;
      gen++;
      unwatch();
      if (suspendTimer) { root.clearTimeout(suspendTimer); suspendTimer = 0; }
      for (i = 0; i < oneShots.length; i++) { try { oneShots[i].onended = null; oneShots[i].stop(); } catch (e) {} try { oneShots[i].disconnect(); } catch (e) {} }
      oneShots.length = 0;
      if (backend) try { backend.dispose(); } catch (e) {}
      for (i = 0; i < chain.length; i++) try { chain[i].disconnect(); } catch (e) {}
      if (ctx && ownCtx && ctx.close && ctx.state !== 'closed') { try { var p = ctx.close(); if (p && p.then) p.then(null, function () {}); } catch (e) {} }
      backend = null; mix = act = master = null; chain = []; thumpBuf = null; shots = null; ctx = null; ownCtx = false; offline = false;
      tunIn = tunBand = tunMid = tunConv = tunWet = null; tunOn = false; tunIrW = tunIrH = 0; dbg.tunnel = 0; dbg.reverb = false; dbg.tunnelWet = dbg.tunnelMid = null;
      ready = false; building = false; everRan = false; stalled = false; dbg.stalled = false;
      for (i = 0; i < MAX_VOICES; i++) { vState[i] = 0; vId[i] = null; ctl[C_V0 + i * V_STRIDE + 2] = 0; }
      first = true; haveL = false; inContact = false; initS(); gearD = prevGear = shiftDir = 0;
      dbg.backend = 'none'; dbg.ready = false; dbg.context = null; dbg.output = null; dbg.compressor = null; dbg.voices = 0;
    }
    function dispose() {
      try { teardown(); } catch (e) { fail(e); }
      wantInit = false;
    }

    return api;
  };

  F1.createAudio.workletSource = workletSource;
  F1.createAudio.paramTable = paramTable;
  F1.createAudio.masks = { ENGINE: M_ENGINE, AERO: M_AERO, SURFACE: M_SURFACE, ERS: M_ERS, REMOTE: M_REMOTE, FX: M_FX, ALL: M_ALL };
  F1.audio = F1.createAudio();
})(typeof window !== 'undefined' ? window : globalThis);
