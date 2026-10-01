// js/main.js in node: the REAL main.js with the real track / car / tyres / pit / laps / gp / raceline / cars modules,
// and stubs only for what needs a browser (DOM, WebGL renderer, js/ui.js, the cockpit). Keys go through main.js's own
// keydown listener, frames through its own requestAnimationFrame loop (pumped with 1/60 s timestamps here).
//
// Regression checks for the main.js findings of the final review (2026-10-01):
//   D1     R inside the pit lane put the car on the track's centreline: the rest of the lane (and its limit) skipped.
//   D5     the Grand Prix tyre wear option also ran in qualifying (x5: a puncture within a 3-lap run).
//   G3/D6  a Grand Prix ending while the car is held for its service dropped the service: released on the old set.
//   PKG-5  the track build (0.2..0.6 s) held the page with nothing on screen: now a note first, the build after it.
// v6.2 glue: the pit lane limit of the season (track.pit.setYear: Zandvoort 60 km/h up to 2024; js/pit.js rebound, during a
//   visit only after it), Monaco's tunnel (js/tunnels.js built / disposed with the track, the scene lights dimmed inside,
//   F1.audio.setTunnel with the tunnel's size), the next set of tyres (ui.setCompound / onCompound, the pit strip's
//   next, the telemetry's nextKeys, the prompt on entering the pit lane).
//
//   node test/main.test.js        -> exit code 1 on any failed check (about 1 s)
//   MAIN=<another main.js> runs the checks against it (e.g. the one from before the fixes: they must fail)
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- browser stand-ins ---------- */
global.window = global;
const winL = {};
global.addEventListener = (t, fn) => { (winL[t] = winL[t] || []).push(fn); };
global.removeEventListener = (t, fn) => { winL[t] = (winL[t] || []).filter(f => f !== fn); };
global.innerWidth = 1600; global.innerHeight = 900; global.devicePixelRatio = 1;
let rafQ = [], rafSeq = 0;
global.requestAnimationFrame = fn => { rafQ.push({ id: ++rafSeq, fn }); return rafSeq; };
global.cancelAnimationFrame = id => { rafQ = rafQ.filter(r => r.id !== id); };
global.document = {
  readyState: 'complete', hidden: false,
  getElementById: () => ({ style: {} }), querySelector: () => null,
  addEventListener() {}, createElement: () => ({ style: {} }), body: { appendChild() {} }
};
const THREE_REAL = require(path.join(ROOT, 'lib/three.min.js'));
global.THREE = Object.assign({}, THREE_REAL, { WebGLRenderer: function () { this.setPixelRatio = this.setSize = this.render = () => {}; } });

/* ---------- the real modules (index.html's order, minus DOM / WebGL ones) ---------- */
for (const f of ['tracks-data.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js', 'js/raceline.js',
  'js/tunnels.js', 'js/collide.js', 'js/laps.js', 'js/pit.js', 'net/session.js', 'js/gp.js']) require(path.join(ROOT, f));
const F1 = global.F1;
let builds = 0;
const buildTrack = F1.buildTrack;
F1.buildTrack = d => { builds++; return buildTrack(d); };
F1.createCockpit = () => ({ group: new THREE.Group(), update() {}, setCar() {}, setSources() {}, centreLook() {}, setLook() {} });
const U = { opts: null, toasts: [], loading: [], year: 2025, compound: null, pit: null, hud: null, tunnel: [] };
F1.ui = {
  init(o) { U.opts = o; }, setTrack() {}, showMenu() {}, hideMenu() {}, updateHUD(h) { U.hud = h; }, setPit(p) { U.pit = p; }, setGp() {}, setCars() {},
  setLights() {}, setResumeHandler() {}, toast(t) { U.toasts.push(t); }, setLoading(n) { U.loading.push(n); },
  setCompound(c) { U.compound = c; },
  getProfile: () => ({ name: 'T', colour: '#ff0000' }), getCar: () => null, getYear: () => U.year, getAudio: () => ({ volume: 0, muted: true })
};
// a silent F1.audio: what main.js asks of it for the tunnel (setTunnel once per frame)
F1.audio = {
  supported: true, muted: true, init() {}, setVolume() {}, setMuted() {}, setEngine() {}, setActive() {}, beep() {}, play() {},
  update() {}, setTunnel(k, w, h) { U.tunnel.push([k, w, h]); if (U.tunnel.length > 50) U.tunnel.shift(); }
};
require(process.env.MAIN ? path.resolve(process.env.MAIN) : path.join(ROOT, 'js/main.js'));   // boots (readyState 'complete')
const g = F1.game;

/* ---------- helpers ---------- */
let failed = 0, passed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || info === undefined ? '' : '  ' + JSON.stringify(info)));
}
let T = 1000;
function frames(n) { for (let k = 0; k < n; k++) { T += 1000 / 60; const q = rafQ; rafQ = []; q.forEach(r => r.fn(T)); } }
function pumpUntil(cond, max) { for (let k = 0; k < max; k++) { if (cond()) return true; frames(1); } return cond(); }
const tick = ms => new Promise(r => setTimeout(r, ms));
function key(code, down) {
  const ev = { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: {}, preventDefault() {} };
  (winL[down === false ? 'keyup' : 'keydown'] || []).slice().forEach(fn => fn(ev));
}
function tap(code) { key(code, true); key(code, false); }
const trackData = id => global.F1_TRACKS.find(t => t.id === id);
const wrap = (a, n) => { a = ((a % n) + n) % n; return a > n / 2 ? a - n : a; };
const angle = a => Math.atan2(Math.sin(a), Math.cos(a));
const last = a => a[a.length - 1];
// to the menu (Esc) if driving: what a player does before picking another track
function toMenu() { if (g.running) tap('Escape'); }
async function load(id) {
  toMenu();
  U.opts.onSelectTrack(trackData(id));
  frames(1);
  await tick(5);
  return g.trackData && g.trackData.id === id && g.running;
}
// the car where the lane's centre is at sample i, along the track, moving
function putInLane(i, v) {
  const P = g.track.pit, S = g.track.samples, s = S[i], d = P.laneD(i), st = g.car.state;
  g.car.reset(g.track, i);
  st.x = s.x + s.nx * d; st.z = s.z + s.nz * d;
  g.car.update(1e-4, null, g.track);
  st.speed = v;
}
function laneTangent(i) {
  const P = g.track.pit, S = g.track.samples, n = S.length, a = (i + n - 1) % n, b = (i + 1) % n;
  const pa = { x: S[a].x + S[a].nx * P.laneD(a), z: S[a].z + S[a].nz * P.laneD(a) }, pb = { x: S[b].x + S[b].nx * P.laneD(b), z: S[b].z + S[b].nz * P.laneD(b) };
  return Math.atan2(pb.x - pa.x, pb.z - pa.z);
}
// into box `slot` at walking pace, then the brake: the service starts (pit.js: driven in, at rest in the own box)
function stopInBox(slot) {
  const b = g.track.pit.boxes[slot], st = g.car.state;
  g.car.reset(g.track, b.index); st.heading = b.heading; st.x = b.x; st.z = b.z;
  g.car.update(1e-4, null, g.track); st.speed = 1;
  key('KeyS', true);
  const ok = pumpUntil(() => !!g.pit.state.service, 60);
  key('KeyS', false);
  return ok;
}

(async function () {
  /* ================= PKG-5: the note first, the build after it ================= */
  check('boot: menu, no track, nothing queued', !g.running && !g.track && rafQ.length === 0);
  U.opts.onSelectTrack(trackData('it-1922'));
  check('PKG-5: a pick puts the loading note up (the track name) and builds nothing yet', builds === 0 && !g.track && last(U.loading) === trackData('it-1922').name, U.loading);
  frames(1);
  check('PKG-5: still nothing built inside the next frame (the note is painted first)', builds === 0 && !g.track);
  await tick(5);
  check('PKG-5: built right after that frame: Monza, driving, the note gone, only the game loop queued',
    builds === 1 && g.trackData.id === 'it-1922' && g.running && last(U.loading) === null && rafQ.length === 1, { builds, loading: U.loading, q: rafQ.length });
  // a window that paints nothing (or a harness that does not pump frames): built after LOAD_WAIT_MS anyway
  toMenu();
  U.opts.onSelectTrack(trackData('mc-1929'));
  await tick(160);
  check('PKG-5: no frame at all: built after the wait, the frame request withdrawn (only the game loop queued)',
    builds === 2 && g.trackData.id === 'mc-1929' && g.running && rafQ.length === 1 && last(U.loading) === null, { builds, q: rafQ.length });
  // two picks before the build: the second one wins, one build
  toMenu();
  U.opts.onSelectTrack(trackData('be-1925'));
  U.opts.onSelectTrack(trackData('it-1922'));
  check('PKG-5: a second pick while one waits: the note shows it', last(U.loading) === trackData('it-1922').name);
  frames(1); await tick(5);
  check('PKG-5: ... and only it is built (once)', builds === 3 && g.trackData.id === 'it-1922' && g.running && rafQ.length === 1, { builds, id: g.trackData.id });

  /* ================= D1: R in the pit lane ================= */
  for (const id of ['it-1922', 'mc-1929', 'gb-1948', 'be-1925']) {
    if (g.trackData.id !== id) await load(id);
    const P = g.track.pit, S = g.track.samples, N = S.length, K = wrap(P.to - P.from, N);
    let bad = [], n = 0;
    for (let k = 1; k < K; k += 3) {
      const i = (P.from + k) % N;
      putInLane(i, 22);
      const before = g.car.state.sampleIndex, wasPaved = P.paved(before, g.car.state.d) || g.pit.state.inLane;
      if (!wasPaved) continue;
      tap('KeyR');
      const st = g.car.state, dIdx = wrap(st.sampleIndex - before, N), dl = P.laneD(st.sampleIndex);
      const dh = Math.abs(angle(st.heading - laneTangent(st.sampleIndex)));
      n++;
      if (!(st.speed === 0 && Math.abs(dIdx) <= 2 && Math.abs(st.d - dl) < 0.35 && dh < 0.08)) bad.push({ k, dIdx, d: +st.d.toFixed(2), laneD: +dl.toFixed(2), dh: +dh.toFixed(3), v: st.speed });
    }
    check(id + ' D1: R anywhere on the pit lane (' + n + ' spots, tapers included): stopped on the lane centre, same progress, along the lane', n > 20 && bad.length === 0, bad.slice(0, 4));
    // every box: R puts the car on the lane beside it, not onto the track
    bad = [];
    for (let slot = 0; slot < P.boxes.length; slot++) {
      const b = P.boxes[slot], st = g.car.state;
      g.car.reset(g.track, b.index); st.heading = b.heading; st.x = b.x; st.z = b.z; g.car.update(1e-4, null, g.track); st.speed = 0;
      const before = st.sampleIndex;
      tap('KeyR');
      const dIdx = wrap(st.sampleIndex - before, N), side = st.d * P.side, hw = S[st.sampleIndex].halfW || g.track.halfWidth;
      if (!(Math.abs(dIdx) <= 2 && side > hw + 1 && P.paved(st.sampleIndex, st.d) && P.inLane(st.sampleIndex, st.d))) bad.push({ slot, dIdx, side: +side.toFixed(2), hw });
    }
    check(id + ' D1: R in each of the 16 boxes: in the lane beside the box (pit side, off the road), same progress', bad.length === 0, bad.slice(0, 4));
  }
  // the whole stop: service in box 1, R the moment it is done, then drive on with the limiter
  await load('it-1922');
  {
    const P = g.track.pit, N = g.track.samples.length;
    check('D1: free practice, Monza: the service starts in box 1', stopInBox(0));
    check('D1: R is ignored while held', (tap('KeyR'), !!g.pit.state.service && g.car.state.speed === 0));
    check('D1: the service runs out', pumpUntil(() => !g.pit.state.service, 60 * 6) && g.pit.state.stops === 1);
    const before = g.car.state.sampleIndex;
    tap('KeyR');
    const st = g.car.state;
    frames(2);
    check('D1: R right after the service: still in the lane (visit open, a ghost on the pit asphalt), same progress, not on the track',
      g.pit.state.inLane && g.pit.state.visit && P.paved(st.sampleIndex, st.d) && Math.abs(wrap(st.sampleIndex - before, N)) <= 2 && st.d * P.side > g.track.samples[st.sampleIndex].halfW + 1,
      { inLane: g.pit.state.inLane, d: st.d, i: st.sampleIndex, before });
    frames(120);
    check('D1: standing there 2 s: no second service (one per visit)', !g.pit.state.service && g.pit.state.stops === 1);
    tap('KeyQ');                                // limiter on
    key('KeyW', true);
    let maxV = 0, hit = 0, steps = 0;
    while (steps++ < 60 * 4 && g.pit.state.inLane) { frames(1); maxV = Math.max(maxV, st.speed * 3.6); hit = Math.max(hit, st.hit); }
    key('KeyW', false);
    check('D1: drives off along the lane on the limiter: no wall, the limit kept (the rest of the lane is driven)', hit === 0 && maxV <= P.limitKmh + 3 && maxV > 40,
      { maxV: +maxV.toFixed(1), hit, limit: P.limitKmh });
    tap('KeyQ');
  }
  // off the pit lane R is what it was: the centreline at the same progress
  {
    const st = g.car.state;
    g.car.reset(g.track, 900); st.x += g.track.samples[900].nx * 4; st.z += g.track.samples[900].nz * 4; g.car.update(1e-4, null, g.track); st.speed = 30;
    tap('KeyR');
    check('D1: on the track R still puts the car on the centreline (unchanged)', Math.abs(st.d) < 0.01 && st.sampleIndex === 900 && st.speed === 0, { d: st.d, i: st.sampleIndex });
  }

  /* ================= D5: the wear option is for the race ================= */
  await load('it-1922');
  U.opts.onGpStart({ q: 3, r: 5, wear: 5 });
  frames(2);
  check('D5: Grand Prix x5: qualifying runs at wear x1 (the session says x5)', g.gp.phase === 'quali' && g.gp.snapshot.wear === 5 && g.tyres.wearRate === 1,
    { phase: g.gp.phase, wear: g.gp.snapshot && g.gp.snapshot.wear, rate: g.tyres.wearRate });
  g.gp.action('skip');
  frames(2);
  check('D5: the grid: x5', g.gp.phase === 'grid' && g.tyres.wearRate === 5, { phase: g.gp.phase, rate: g.tyres.wearRate });
  check('D5: the race: x5', pumpUntil(() => g.gp.phase === 'race', 60 * 12) && g.tyres.wearRate === 5, { phase: g.gp.phase, rate: g.tyres.wearRate });
  g.gp.action('end');                        // (the race ended early: its results first, then free practice)
  frames(2);
  check('D5: the results: x5', g.gp.phase === 'results' && g.tyres.wearRate === 5, { phase: g.gp.phase, rate: g.tyres.wearRate });
  g.gp.action('end');
  frames(2);
  check('D5: back to free practice: x1', g.gp.phase === 'free' && g.tyres.wearRate === 1, { phase: g.gp.phase, rate: g.tyres.wearRate });

  /* ================= G3 / D6: the session ends during a service ================= */
  U.opts.onGpStart({ q: 3, r: 5, wear: 1 });
  frames(2);
  tap('KeyT');                                // next set: M -> H
  check('G3: qualifying; the next set is the hards', g.gp.phase === 'quali' && g.nextCompound === 'H' && g.tyres.state.compound === 'M');
  check('G3: the service starts in box 1', stopInBox(0));
  frames(30);
  g.tyres.state.puncture = 1;                 // the puncture that brought the car in (the set has worn a little too)
  frames(2);
  const held = g.pit.state.service ? g.pit.state.service.left : null;
  let from = U.toasts.length;
  g.gp.action('end');                         // = the host's 結束大獎賽 / a disconnect: onGpPhase('free')
  frames(2);
  const ty = g.tyres.state;
  check('G3: still held when the session ended (' + (held && held.toFixed(2)) + ' s left)', held > 0);
  check('G3: back to free practice: the service finished on the spot: the hards fitted, the puncture gone, a new set (no wear)',
    g.gp.phase === 'free' && !g.pit.state.service && ty.compound === 'H' && ty.puncture === -1 && Math.max.apply(null, ty.wear) === 0,
    { phase: g.gp.phase, svc: g.pit.state.service, compound: ty.compound, puncture: ty.puncture, wear: ty.wear });
  check('G3: the toast says so', U.toasts.slice(from).some(t => t === '大獎賽已結束，回到自由練習（已換上新胎：硬胎）'), U.toasts.slice(from));
  key('KeyW', true); frames(60); key('KeyW', false);
  check('G3: the car is released (drives off)', g.car.state.speed > 3, g.car.state.speed);
  // without a service: the old toast, nothing fitted
  U.opts.onGpStart({ q: 3, r: 5, wear: 1 });
  frames(2);
  tap('KeyT');                                // H -> S (the set on the car stays)
  const comp = g.tyres.state.compound;
  from = U.toasts.length;
  g.gp.action('end');
  frames(2);
  check('G3: a session ending with no service: no tyres fitted, the plain toast', g.tyres.state.compound === comp && U.toasts.slice(from).indexOf('大獎賽已結束，回到自由練習') >= 0,
    { comp, now: g.tyres.state.compound, toasts: U.toasts.slice(from) });
  // a penalty hold (js/pit.js: a service with work 0, no tyres) when the session ends: no tyres either
  U.opts.onGpStart({ q: 3, r: 5, wear: 1 });
  frames(2);
  tap('KeyT');                                // S -> M: a set that would show if one were fitted
  const comp2 = g.tyres.state.compound;
  g.pit.state.service = { total: 5, left: 4, penalty: 5, work: 0 };
  from = U.toasts.length;
  g.gp.action('end');
  check('G3: a session ending during a penalty hold (work 0): no tyres fitted, the plain toast, the hold dropped',
    g.nextCompound !== comp2 && g.tyres.state.compound === comp2 && !g.pit.state.service && U.toasts.slice(from).indexOf('大獎賽已結束，回到自由練習') >= 0,
    { was: comp2, now: g.tyres.state.compound, toasts: U.toasts.slice(from) });

  /* ================= v6.2: the next set of tyres ================= */
  await load('it-1922');
  check('v6.2: the 大獎賽 tab shows the next set (ui.setCompound) and T keeps it current', (tap('KeyT'), U.compound === g.nextCompound),
    { ui: U.compound, next: g.nextCompound });
  U.opts.onCompound('S');
  frames(1);
  check('v6.2: 起跑輪胎 picked in the tab (onCompound S): the next set, the pit strip\'s next, the telemetry\'s keys T / X',
    g.nextCompound === 'S' && U.pit && U.pit.next === 'S' && U.hud && U.hud.nextKeys === 'T / X', { next: g.nextCompound, pit: U.pit && U.pit.next, keys: U.hud && U.hud.nextKeys });
  U.opts.onCompound('X');
  check('v6.2: junk from the tab is ignored', g.nextCompound === 'S');
  U.opts.onGpStart({ q: 3, r: 5, wear: 1 });
  frames(2);
  check('v6.2: a Grand Prix starts on it (qualifying: a new set of softs)', g.gp.phase === 'quali' && g.tyres.state.compound === 'S', { phase: g.gp.phase, c: g.tyres.state.compound });
  g.gp.action('skip');
  frames(2);
  check('v6.2: ... and the grid too', g.gp.phase === 'grid' && g.tyres.state.compound === 'S', { phase: g.gp.phase, c: g.tyres.state.compound });
  g.gp.action('end'); frames(2); g.gp.action('end'); frames(2);
  {
    const P = g.track.pit, N = g.track.samples.length;
    let from = U.toasts.length;
    g.car.reset(g.track, ((P.entry - 30) % N + N) % N);
    g.car.state.speed = 20;
    putInLane(((P.entry + 6) % N + N) % N, 15);
    frames(3);
    check('v6.2: entering the pit lane: the prompt (keyboard) with the next set', g.pit.state.inLane &&
      U.toasts.slice(from).indexOf('按 T（手把 X）選擇輪胎：軟 / 中 / 硬（下一組：軟胎）') >= 0, U.toasts.slice(from));
    g.car.reset(g.track, (P.exit + Math.floor(N / 2)) % N);
    frames(80);
  }

  /* ================= v6.2: the pit lane limit of the season ================= */
  U.year = 2024;
  U.opts.onYear(2024);
  await load('nl-1948');
  frames(2);
  check('v6.2: Zandvoort in 2024: built for the season (limit 60), js/pit.js judges by 60',
    g.track.pit.limitKmh === 60 && g.track.pit.year === 2024 && g.pit.state.limitKmh === 60, { lim: g.track.pit.limitKmh, year: g.track.pit.year, pit: g.pit.state.limitKmh });
  U.year = 2025;
  U.opts.onYear(2025);
  frames(2);
  check('v6.2: 2025 picked in the menu: 80 at once (track and js/pit.js)', g.track.pit.limitKmh === 80 && g.track.pit.year === 2025 && g.pit.state.limitKmh === 80,
    { lim: g.track.pit.limitKmh, pit: g.pit.state.limitKmh });
  {
    const P = g.track.pit, N = g.track.samples.length;
    putInLane(((P.entry + 10) % N + N) % N, 10);
    frames(3);
    U.year = 2024;
    U.opts.onYear(2024);
    frames(2);
    check('v6.2: changed during a pit visit: the track says 60 at once, the visit is judged by 80 to its end',
      g.pit.state.visit && g.track.pit.limitKmh === 60 && g.pit.state.limitKmh === 80, { visit: g.pit.state.visit, lim: g.track.pit.limitKmh, pit: g.pit.state.limitKmh });
    g.car.reset(g.track, (P.exit + Math.floor(N / 2)) % N);
    pumpUntil(() => !g.pit.state.visit, 120);
    frames(2);
    check('v6.2: ... then js/pit.js is rebound to 60', !g.pit.state.visit && g.pit.state.limitKmh === 60, { visit: g.pit.state.visit, pit: g.pit.state.limitKmh });
  }
  U.year = 2025;
  U.opts.onYear(2025);

  /* ================= v6.2: Monaco's tunnel ================= */
  await load('mc-1929');
  {
    const tn = g.tunnels, N = g.track.samples.length, L = g.lights;
    const T0 = tn && tn.tunnels.find(t => t.kind === 'tunnel');
    check('v6.2: Monaco: the covered stretches built with the track and in the scene (the tunnel ' + (T0 && T0.length) + ' m)',
      !!(tn && tn.group.parent && T0 && T0.length > 300 && tn.tunnels.length >= 2), tn && tn.tunnels.map(t => t.name + ' ' + t.length));
    const mid = (T0.from + Math.round((((T0.to - T0.from) % N) + N) % N / 2)) % N;
    g.car.reset(g.track, mid);
    frames(3);
    const i = g.car.state.sampleIndex, k = tn.inTunnel(i), last = U.tunnel[U.tunnel.length - 1];
    check('v6.2: mid-tunnel (beside the sea-side openings): the sun out, the sky light as tunnels.sceneLight says',
      L.sun.intensity === L.sun0 * tn.sceneLight(i, 'sun') && L.sun.intensity < 0.05 && L.hemi.intensity === L.hemi0 * tn.sceneLight(i, 'hemi'),
      { sun: L.sun.intensity, hemi: L.hemi.intensity });
    check('v6.2: mid-tunnel: the reverb asked for at full depth with the tunnel\'s size', k === 1 && last && last[0] === 1 && last[1] === T0.width && last[2] === T0.height, { k, last, w: T0.width, h: T0.height });
    g.car.reset(g.track, ((T0.to - 30) % N + N) % N);   // the enclosed end, 60 m before the exit
    frames(3);
    const j = g.car.state.sampleIndex;
    check('v6.2: in the enclosed end: the sun out, the sky light dimmed (' + L.hemi.intensity.toFixed(3) + ')',
      L.sun.intensity < 0.05 && L.hemi.intensity === L.hemi0 * tn.sceneLight(j, 'hemi') && L.hemi.intensity < L.hemi0, { sun: L.sun.intensity, hemi: L.hemi.intensity });
    g.car.reset(g.track, (T0.to + 40) % N);
    frames(3);
    const out = U.tunnel[U.tunnel.length - 1];
    check('v6.2: out of the tunnel: daylight, no reverb', L.sun.intensity === L.sun0 && L.hemi.intensity === L.hemi0 && out[0] === 0, { sun: L.sun.intensity, hemi: L.hemi.intensity, out });
    g.car.reset(g.track, mid);
    frames(2);
    await load('it-1922');
    check('v6.2: another track: Monaco\'s tunnels gone from the scene, daylight', !tn.group.parent && g.tunnels !== tn && L.sun.intensity === L.sun0 && L.hemi.intensity === L.hemi0,
      { parent: !!tn.group.parent, sun: L.sun.intensity });
  }

  console.log('\n' + passed + ' / ' + (passed + failed) + ' checks passed' + (failed ? '' : ': all main tests passed'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
