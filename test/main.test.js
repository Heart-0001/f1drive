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
// v7 glue: the computer drivers (js/ai.js): the 電腦車手 setting (ui.getBots / onBots) -> the field alone (gp.setBots), their
//   cars in the grid boxes behind ours, driving, a Grand Prix's placements (qualifying from the room slots, the grid by
//   the session's order, held until the lights, the lap clocks armed at lights out), back to free practice, none again.
//   With none (the default) everything above runs exactly as before.
// Review round 3 (2026-10-02):
//   FLOW-1 a season change while the car is in the pit lane: the whole change (track limit, signs, the car's limiter AND
//          js/pit.js) waits until the car has left the pit stretch - the limiter held 80 while js/pit.js judged by 60 ->
//          a 5 s speeding hold for nothing (alone, and a room's guest when the host changes the year).
//   FLOW-2 the host's computer drivers in the roster were announced as players joining / leaving the room.
//   FLOW-3 the track search: 日本站 / 鈴鹿站 / 日本大獎賽 / 日本GP / ＪＡＰＡＮ found nothing (the real js/ui.js's search).
//   FLOW-4 V with no mirrors (js/hudmirrors.js failed) said nothing.
//   AI-4   the bots' blue flags in free practice (every lap counter started elsewhere): prog only in the race.
//   MP-3   two remote cars hit in one 50 ms tick: the second report was refused (one per reporting car per 40 ms) and
//          thrown away: now one report per tick, the others in the next.
//   MP-6   a bot lap the session refused ('botLapRejected') was not handled: now a toast for the one simulating it.
//   PKG-2  the 電腦車手 setting ran F1.AI.warmUp (~0.2 s) inside its change handler: now behind the loading note.
//   PRES-1 the start gantry's lamps (js/scenery.js setStartLights) follow the HUD's lights: dark in practice and after
//          lights out, n columns on the grid.
//   PRES-2 the tunnel reverb's impulse response is asked for at track load (setTunnel(0, w, h) of the longest stretch),
//          not first at the tunnel entry at speed.
//
//   node test/main.test.js        -> exit code 1 on any failed check (about 2 s)
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
  'js/tunnels.js', 'js/collide.js', 'js/laps.js', 'js/pit.js', 'js/ai.js', 'net/session.js', 'js/gp.js']) require(path.join(ROOT, f));
const F1 = global.F1;
// F1.AI.warmUp counted (PKG-2: when it runs)
let warms = 0;
const warmUp = F1.AI.warmUp;
F1.AI.warmUp = function () { warms++; return warmUp.apply(this, arguments); };
// a js/net.js stand-in: as in the game F1.net is there from boot, disconnected (alone) until the room section at the end
const NET = {
  connected: false, isHost: false, canCreate: true, hostInfo: null, id: 0, slot: 0, year: null, trackId: null,
  roster: [], players: [], bots: [], session: null, hits: [], h: {},
  on(n, fn) { (this.h[n] = this.h[n] || []).push(fn); },
  emit(n, a, b) { (this.h[n] || []).slice().forEach(fn => fn(a, b)); },
  setProfile() {}, update() {}, park() {}, sendState() {}, sendLap() { return true; }, sendBotStates() {}, setProgress() {},
  setBotProgress() {}, sendGpLap() { return true; }, setBots() { return false; }, gp() { return false; }, serverNow: () => Date.now(),
  leave() {}, selectTrack() { return false; }, setYear() { return false; },
  create() { return Promise.resolve({ ok: false }); }, join() { return Promise.resolve({ ok: false }); },
  sendHit(to, ix, iz, from) { this.hits.push({ to, ix, iz, from, t: performance.now() }); return this.connected; }
};
F1.net = NET;
let builds = 0;
const buildTrack = F1.buildTrack;
F1.buildTrack = d => { builds++; return buildTrack(d); };
F1.createCockpit = () => ({ group: new THREE.Group(), update() {}, setCar() {}, setSources() {}, centreLook() {}, setLook() {} });
const U = { opts: null, toasts: [], loading: [], loadTitle: [], year: 2025, compound: null, pit: null, hud: null, tunnel: [], primes: [], lamps: [], gp: null };
F1.ui = {
  init(o) { U.opts = o; }, setTrack() {}, showMenu() {}, hideMenu() {}, updateHUD(h) { U.hud = h; }, setPit(p) { U.pit = p; }, setGp(v) { U.gp = v; }, setCars() {},
  setLights() {}, setResumeHandler() {}, toast(t) { U.toasts.push(t); }, setLoading(n, title) { U.loading.push(n); U.loadTitle.push(title); },
  setCompound(c) { U.compound = c; },
  getProfile: () => ({ name: 'T', colour: '#ff0000' }), getCar: () => null, getYear: () => U.year, getAudio: () => ({ volume: 0, muted: true })
};
// a silent F1.audio: what main.js asks of it for the tunnel (setTunnel once per frame)
F1.audio = {
  supported: true, muted: true, init() {}, setVolume() {}, setMuted() {}, setEngine() {}, setActive() {}, beep() {}, play() {},
  update() {}, setTunnel(k, w, h) { U.tunnel.push([k, w, h]); if (U.tunnel.length > 50) U.tunnel.shift(); if (k === 0 && w !== undefined) U.primes.push([w, h]); }
};
// the scenery stand-in: only the start gantry's lamps (setStartLights, review r3 PRES-1), the last call kept
F1.buildScenery = () => ({ group: new THREE.Group(), dispose() {}, stats: {}, setStartLights(n, go) { U.lamps.length = 0; U.lamps.push([n, go]); } });
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
  check('PRES-1: the gantry dark on the grid before the lights', U.lamps.length === 1 && !(U.lamps[0][0] > 0) && !U.lamps[0][1], U.lamps);
  check('PRES-1: three lights: the gantry lights three columns', pumpUntil(() => g.gp.phase === 'grid' && g.gp.lights === 3, 60 * 12) && (frames(1), U.lamps.length === 1 && U.lamps[0][0] === 3 && !U.lamps[0][1]),
    { phase: g.gp.phase, lights: g.gp.lights, lamps: U.lamps });
  check('D5: the race: x5', pumpUntil(() => g.gp.phase === 'race', 60 * 12) && g.tyres.wearRate === 5, { phase: g.gp.phase, rate: g.tyres.wearRate });
  check('PRES-1: lights out: the gantry dark (go, or no lamps)', (frames(1), U.lamps.length === 1 && (U.lamps[0][1] === true || !(U.lamps[0][0] > 0))), U.lamps);
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
    // FLOW-1: the whole change waits for the end of the visit (it was: the track 60 at once, js/pit.js 80)
    check('FLOW-1: changed during a pit visit: the whole change waits - track, signs (year), the limiter of the car and js/pit.js all 80 to its end',
      g.pit.state.visit && g.track.pit.limitKmh === 80 && g.track.pit.year === 2025 && g.pit.state.limitKmh === 80 && g.car.state.limitKmh === 80,
      { visit: g.pit.state.visit, lim: g.track.pit.limitKmh, year: g.track.pit.year, pit: g.pit.state.limitKmh, car: g.car.state.limitKmh });
    g.car.reset(g.track, (P.exit + Math.floor(N / 2)) % N);
    pumpUntil(() => !g.pit.state.visit, 120);
    frames(2);
    check('v6.2: ... then the 60 of that season: the track (2024), js/pit.js and the limiter', !g.pit.state.visit && g.track.pit.limitKmh === 60 && g.track.pit.year === 2024 &&
      g.pit.state.limitKmh === 60 && g.car.state.limitKmh === 60, { visit: g.pit.state.visit, lim: g.track.pit.limitKmh, pit: g.pit.state.limitKmh, car: g.car.state.limitKmh });
  }
  // FLOW-1, the review's case: 2024 -> 2025 while driving down the lane on the limiter (60): it held 80 at once while
  // js/pit.js judged by 60 -> 'speeding', a 5 s hold, the toast '維修區超速（限速 60 km/h）'
  {
    const P = g.track.pit, N = g.track.samples.length;
    putInLane(((P.entry + 4) % N + N) % N, 14);
    tap('KeyQ');                                // limiter on
    key('KeyW', true);
    frames(20);
    const before = { car: g.car.state.limitKmh, pit: g.pit.state.limitKmh, v: g.car.state.speed * 3.6 };
    const from = U.toasts.length;
    U.year = 2025;
    U.opts.onYear(2025);                        // (picked in the 車輛 tab: the menu, then back to driving)
    let worst = null, maxV = 0, steps = 0;
    while (steps++ < 60 * 20 && g.pit.state.visit) {
      frames(1);
      const st = g.car.state;
      if (g.pit.state.inLane) {
        maxV = Math.max(maxV, st.speed * 3.6);
        if (!worst && (st.limitKmh !== g.pit.state.limitKmh || g.track.pit.limitKmh !== g.pit.state.limitKmh || g.pit.state.speeding))
          worst = { car: st.limitKmh, pit: g.pit.state.limitKmh, track: g.track.pit.limitKmh, v: +(st.speed * 3.6).toFixed(1) };
      }
    }
    key('KeyW', false);
    check('FLOW-1: 2024 -> 2025 in the lane on the limiter: car limit = js/pit.js limit = track limit (60) to the end of the visit, never speeding',
      before.car === 60 && before.pit === 60 && worst === null && maxV > 40 && maxV <= 63, { before, worst, maxV: +maxV.toFixed(1) });
    check('FLOW-1: ... no hold, no speeding toast', g.pit.state.pending === 0 && !U.toasts.slice(from).some(t => /超速/.test(t)), { pending: g.pit.state.pending, toasts: U.toasts.slice(from) });
    frames(2);
    check('FLOW-1: ... and out of the pit stretch: the 80 of 2025 everywhere', !g.pit.state.visit && g.track.pit.limitKmh === 80 && g.track.pit.year === 2025 &&
      g.pit.state.limitKmh === 80 && g.car.state.limitKmh === 80, { lim: g.track.pit.limitKmh, pit: g.pit.state.limitKmh, car: g.car.state.limitKmh });
    tap('KeyQ');
  }

  /* ================= FLOW-4: V when the mirrors cannot be drawn ================= */
  {
    const from = U.toasts.length;
    tap('KeyV');
    check('FLOW-4: no mirrors (js/hudmirrors.js missing / failed): V says so instead of nothing', g.running && !g.hudMirrors &&
      U.toasts.slice(from).indexOf('後照鏡無法顯示（顯示卡不支援）') >= 0, U.toasts.slice(from));
  }

  /* ================= v6.2: Monaco's tunnel ================= */
  await load('mc-1929');
  {
    const tn = g.tunnels, N = g.track.samples.length, L = g.lights;
    const T0 = tn && tn.tunnels.find(t => t.kind === 'tunnel');
    check('v6.2: Monaco: the covered stretches built with the track and in the scene (the tunnel ' + (T0 && T0.length) + ' m)',
      !!(tn && tn.group.parent && T0 && T0.length > 300 && tn.tunnels.length >= 2), tn && tn.tunnels.map(t => t.name + ' ' + t.length));
    const big = tn.tunnels.reduce((a, b) => (b.length > a.length ? b : a)), pr = U.primes[U.primes.length - 1];
    check('PRES-2: the reverb primed at track load with the longest stretch (' + big.width + ' x ' + big.height + ' m)', !!pr && pr[0] === big.width && pr[1] === big.height, { pr, big: [big.width, big.height] });
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

  /* ================= v7: computer drivers ================= */
  if (!g.bots) check('v7: F1.game.bots (this main.js has no computer drivers)', false);
  else {
    check('v7: none by default: no bots, ours alone (everything above ran without any)', g.bots.length === 0 && g.gp.bots().length === 0 && U.gp && U.gp.bots && U.gp.bots.available === true);
    const G = g.track.grid;
    const inBox = (st, k) => Math.hypot(st.x - (G[k].x - Math.sin(G[k].heading) * 2.8), st.z - (G[k].z - Math.cos(G[k].heading) * 2.8)) < 0.6;
    toMenu();
    const w0 = warms, l0 = U.loading.length;
    U.opts.onBots({ count: 5, skill: 'pro' });
    const B = g.bots, desc = g.gp.bots();
    check('PKG-2: 5 set in the menu on a loaded track: the cars made at once, F1.AI.warmUp not in the change handler; the note up first',
      B.length === 5 && warms === w0 && U.loading.length === l0 + 1 && last(U.loading) === g.trackData.name && last(U.loadTitle) === '電腦車手熟悉賽道中…',
      { bots: B.length, warms: warms - w0, loading: U.loading.slice(l0), title: last(U.loadTitle) });
    frames(1); await tick(5);
    check('PKG-2: ... the warm-up right after the next frame (once), the note gone', warms === w0 + 1 && last(U.loading) === null, { warms: warms - w0, loading: U.loading.slice(l0) });
    check('v7: 5 set in the menu (free practice): F1.gp holds them (ids 2..6, slots 1..5, real names, the season\'s cars)',
      desc.length === 5 && desc.every((d, i) => d.id === i + 2 && d.slot === i + 1 && /^2025-/.test(d.car) && !/standard/.test(d.car) && !/^AI /.test(d.name)),
      desc.map(d => d.name + ' ' + d.car));
    // (ours stands where the track put it alone - on the centreline 10 samples before the line, beside boxes 2 and 3: a box
    // with a car on it is not used, that bot goes on along the track to a free spot)
    const clear = st => B.concat([{ car: g.car }]).every(o => o.car.state === st || Math.hypot(o.car.state.x - st.x, o.car.state.z - st.z) >= 7);
    check('v7: their cars on Monza, each in its grid box (slot + 1) or (a box beside our car) on a free spot, stopped, pro (skill ~0.7)',
      B.length === 5 && B.filter(b => inBox(b.car.state, b.slot)).length >= 3 && B.every(b => (inBox(b.car.state, b.slot) || clear(b.car.state)) && b.car.state.speed === 0 &&
        Math.abs(b.skill - 0.7) < 0.05), B.map(b => [b.slot, b.skill, inBox(b.car.state, b.slot)]));
    check('v7: the view for the 大獎賽 tab: 5 of 15, editable, the field listed', U.gp.bots.count === 5 && U.gp.bots.max === 15 && U.gp.bots.canEdit === true && U.gp.botList.length === 5, U.gp.bots);
    tap('Escape');
    frames(60 * 8);
    check('v7: free practice 8 s: the bots drive off (ours stands still), nothing NaN',
      B.filter(b => Math.abs(b.car.state.speed) > 10).length >= 2 && B.every(b => [b.car.state.x, b.car.state.z, b.car.state.speed].every(Number.isFinite)),
      B.map(b => +b.car.state.speed.toFixed(1)));
    check('v7: think() sees ours + the 5 (views)', g.botViews.length === 6 && g.botViews[0].id === 1);
    // AI-4: our lap counter ran from the track load (laps driven above), theirs from their placing: no race distances (no
    // blue flags) in free practice
    check('AI-4: free practice: no race distance in any view (no blue flags)', g.botViews.every(v => v.prog !== v.prog) && B.every(b => b.ctx.prog !== b.ctx.prog),
      g.botViews.map(v => v.prog));
    // a Grand Prix with them
    toMenu();
    U.opts.onGpStart({ q: 1, r: 1, wear: 1 });
    frames(2);
    check('v7: qualifying: 6 in the session, ours in grid box 1, the bots from their room slots (boxes 2..6)',
      g.gp.phase === 'quali' && g.gp.snapshot.players.length === 6 && inBox(g.car.state, 0) && B.every(b => inBox(b.car.state, b.slot)));
    check('v7: the 電腦車手 rows locked during the session', U.gp.bots.canEdit === false);
    g.gp.action('skip');
    frames(2);
    const s = g.gp.snapshot;
    check('v7: the grid (join order: ours on pole): every bot in the box of its place', g.gp.phase === 'grid' && s.grid[0] === 1 && B.every(b => inBox(b.car.state, s.grid.indexOf(b.id))),
      { grid: s.grid });
    frames(120);
    check('v7: held on the grid before the lights', B.every(b => inBox(b.car.state, s.grid.indexOf(b.id)) && b.car.state.speed === 0));
    check('v7: lights out -> the race', pumpUntil(() => g.gp.phase === 'race', 60 * 12));
    check('v7: their lap clocks armed at lights out (as ours)', B.every(b => b.lap.started && b.lap.n === 1) && g.lap.started);
    frames(60 * 6);
    check('v7: the race: they start (6 s)', B.filter(b => Math.abs(b.car.state.speed) > 15).length >= 3, B.map(b => +b.car.state.speed.toFixed(1)));
    check('AI-4: the race: every view has its race distance (blue flags on)', g.botViews.every(v => Number.isFinite(v.prog) && v.prog > -1 && v.prog < 2),
      g.botViews.map(v => v.prog));
    // MP-6: a bot lap the session refuses is said (here the local session: 'too-fast'), once per 8 s
    {
      const from = U.toasts.length, b0 = B[0];
      const why = g.gp.botLap(b0.id, 0.5), why2 = g.gp.botLap(B[1].id, 0.5);
      const said = U.toasts.slice(from);
      check('MP-6: a bot lap refused by the session (botLapRejected): a toast with its name and why, a second within 8 s not',
        why === 'too-fast' && why2 === 'too-fast' && said.length === 1 && said[0] === '電腦車手 ' + b0.name + ' 的一圈沒有被採計：圈速快得不合理', { why, why2, said });
    }
    g.gp.action('end');
    frames(2);
    g.gp.action('end');
    frames(2);
    check('v7: back to free practice: the bots in their room slots again, the setting editable',
      g.gp.phase === 'free' && B.every(b => inBox(b.car.state, b.slot)) && U.gp.bots.canEdit === true);
    toMenu();
    U.opts.onBots({ count: 0, skill: 'pro' });
    check('v7: none again: no bots left', g.bots.length === 0 && g.gp.bots().length === 0);
    {
      const w1 = warms, l1 = U.loading.length;
      U.opts.onBots({ count: 3, skill: 'pro' });
      frames(1); await tick(5);
      check('PKG-2: the warm-up is once per track: 3 more on the same track, no note, no warm-up', g.bots.length === 3 && warms === w1 && U.loading.length === l1,
        { warms: warms - w1, loading: U.loading.slice(l1) });
      await load('mc-1929');
      check('PKG-2: another track with bots: warmed up with its build (behind its own note)', g.bots.length === 3 && warms === w1 + 1 && last(U.loading) === null &&
        U.loadTitle[U.loadTitle.length - 2] === undefined, { warms: warms - w1, titles: U.loadTitle.slice(-3) });
      toMenu();
      U.opts.onBots({ count: 0, skill: 'pro' });
    }
  }

  /* ================= a room (the js/net.js stand-in): we are a guest ================= */
  {
    // remote cars need a model (js/carmodel.js is not loaded here)
    F1.createCarModel = () => ({ group: new THREE.Group(), setName() {}, setGhost() {}, update() {}, setColour() {}, setLivery() {}, setHalo() {}, dispose() {} });
    toMenu();
    const me = { id: 5, name: 'T', isSelf: true }, host = { id: 3, name: 'Host' };
    const botRow = (id, name) => ({ id, name, bot: true, owner: 3, skill: 0.7, bi: id - 6, car: '2024-mclaren' });
    Object.assign(NET, { connected: true, isHost: false, id: 5, slot: 1, year: 2024, roster: [host, me] });
    NET.emit('connected'); NET.emit('year', 2024); NET.emit('players', NET.roster);
    /* ---- FLOW-2: the host's computer drivers are no players joining / leaving ---- */
    let from = U.toasts.length;
    NET.roster = [host, me, botRow(6, 'Lando Norris'), botRow(7, 'Oscar Piastri'), botRow(8, 'Max Verstappen')];
    NET.emit('players', NET.roster);
    let said = U.toasts.slice(from);
    check('FLOW-2: the host adds 3 computer drivers: no "加入了房間" for them, one toast with their number',
      !said.some(t => /加入了房間|離開了房間/.test(t)) && said.length === 1 && said[0] === '房間的電腦車手：3 位', said);
    from = U.toasts.length;
    NET.roster = [host, me, { id: 9, name: 'Guest2' }, botRow(6, 'Lando Norris'), botRow(7, 'Oscar Piastri')];   // (a human took a seat)
    NET.emit('players', NET.roster);
    said = U.toasts.slice(from);
    check('FLOW-2: a player joins (and a bot gives him its seat): his join is the news', said.length === 1 && said[0] === 'Guest2 加入了房間', said);
    from = U.toasts.length;
    NET.roster = [host, me, { id: 9, name: 'Guest2' }];
    NET.emit('players', NET.roster);
    said = U.toasts.slice(from);
    check('FLOW-2: the host removes his computer drivers: no "離開了房間", one toast', said.length === 1 && said[0] === '房間的電腦車手：無', said);
    from = U.toasts.length;
    NET.roster = [host, me];
    NET.emit('players', NET.roster);
    check('FLOW-2: a player leaves: still said', U.toasts.slice(from).join() === 'Guest2 離開了房間', U.toasts.slice(from));

    /* ---- FLOW-1 in a room: the host changes the season while we are in the pit lane ---- */
    NET.trackId = 'nl-1948';
    NET.emit('track', 'nl-1948');
    frames(1); await tick(5);
    check('room: Zandvoort loaded for the room, 2024 (limit 60), driving', g.running && g.trackData.id === 'nl-1948' && g.track.pit.limitKmh === 60 && g.track.pit.year === 2024,
      { running: g.running, id: g.trackData && g.trackData.id, lim: g.track.pit.limitKmh });
    {
      const P = g.track.pit, N = g.track.samples.length;
      putInLane(((P.entry + 4) % N + N) % N, 14);
      tap('KeyQ');
      key('KeyW', true);
      frames(20);
      from = U.toasts.length;
      NET.year = 2025; NET.emit('year', 2025);  // the host picked 2025 in the 車輛 tab
      let worst = null, steps = 0;
      while (steps++ < 60 * 20 && g.pit.state.visit) {
        frames(1);
        const st = g.car.state;
        if (g.pit.state.inLane && !worst && (st.limitKmh !== g.pit.state.limitKmh || g.pit.state.speeding)) worst = { car: st.limitKmh, pit: g.pit.state.limitKmh, v: st.speed * 3.6 };
      }
      key('KeyW', false);
      frames(2);
      check('FLOW-1 (guest): the room goes 2024 -> 2025 while we drive down the lane on the limiter: no penalty, then 80 everywhere',
        worst === null && g.pit.state.pending === 0 && !U.toasts.slice(from).some(t => /超速/.test(t)) && g.track.pit.limitKmh === 80 && g.pit.state.limitKmh === 80 && g.car.state.limitKmh === 80,
        { worst, pending: g.pit.state.pending, toasts: U.toasts.slice(from), lim: g.track.pit.limitKmh, pit: g.pit.state.limitKmh });
      tap('KeyQ');
    }

    /* ---- MP-3: two remote cars hit in the same 50 ms tick: one report per tick, the other one in the next ---- */
    {
      const st = g.car.state, N = g.track.samples.length;
      g.car.reset(g.track, Math.floor(N / 3)); st.speed = 0;
      frames(2);
      const h = st.heading, fx = Math.sin(h), fz = Math.cos(h);
      // one closing from behind, one coming the other way, both overlapping our car by 0.3 m
      const behind = { x: st.x - fx * 5.1, z: st.z - fz * 5.1, y: st.y, heading: h, speed: 15 };
      const ahead = { x: st.x + fx * 5.1, z: st.z + fz * 5.1, y: st.y, heading: h + Math.PI, speed: 15 };
      NET.players = [{ id: 11, name: 'A', colour: '#00ff00', car: null, active: true, state: behind }, { id: 12, name: 'B', colour: '#0000ff', car: null, active: true, state: ahead }];
      await tick(60);                          // (no report for 50 ms before)
      NET.hits.length = 0;
      frames(1);
      const first = NET.hits.slice();
      NET.players[0].state = { x: st.x - fx * 60, z: st.z - fz * 60, y: st.y, heading: h, speed: 0 };   // gone again: no new contact
      NET.players[1].state = { x: st.x + fx * 60, z: st.z + fz * 60, y: st.y, heading: h, speed: 0 };
      frames(1);
      const sameTick = NET.hits.length;
      await tick(60);
      frames(1);
      const all = NET.hits.slice(), ids = all.map(x => x.to).sort();
      check('MP-3: both remote cars hit in one frame: ONE report in that tick (the server takes one per car per 40 ms)', first.length === 1 && sameTick === 1, { first, sameTick });
      check('MP-3: ... the other one goes out in the next tick (>= 40 ms later), with its impulse', all.length === 2 && ids.join() === '11,12' &&
        all[1].t - all[0].t >= 40 && Math.hypot(all[1].ix, all[1].iz) > 0.2, all);
      NET.players = [];
    }

    // back alone
    NET.connected = false; NET.trackId = null; NET.roster = [];
    NET.emit('disconnected', '已離開房間');
    frames(1);
    check('room: left: alone again, our own season (2025)', !g.gp.online && g.spec && g.spec.year === 2025, g.spec && g.spec.year);
  }

  /* ================= FLOW-3: the track search (the real js/ui.js, without the DOM) ================= */
  {
    const stub = F1.ui;
    require(path.join(ROOT, 'js/track-names-zh.js'));
    require(path.join(ROOT, 'js/ui.js'));
    const real = F1.ui;
    F1.ui = stub;                               // (main.js keeps the stand-in it booted with)
    const T = global.F1_TRACKS, sameSet = (a, b) => a.length === b.length && a.slice().sort().join() === b.slice().sort().join();
    const IT = ['it-1922', 'it-1953', 'it-1914'], US = ['us-1909', 'us-1956', 'us-2012', 'us-2022', 'us-2023'];
    const Q = [
      // the review's finds that failed: the Taiwanese 'X站' / 'X大獎賽' forms, CJK + Latin in one word, full-width letters
      ['日本站', ['jp-1962']], ['鈴鹿站', ['jp-1962']], ['義大利站', IT], ['沙烏地阿拉伯站', ['sa-2021']], ['卡達站', ['qa-2004']], ['新加坡站', ['sg-2008']],
      ['日本大獎賽', ['jp-1962']], ['日本大奖赛', ['jp-1962']], ['日本分站', ['jp-1962']], ['日本GP', ['jp-1962']], ['ＪＡＰＡＮ', ['jp-1962']], ['F1日本大獎賽', ['jp-1962']],
      ['F1 日本站', ['jp-1962']], ['美國站', US], ['japan站', ['jp-1962']],
      // what worked before still does
      ['japan', ['jp-1962']], ['日本', ['jp-1962']], ['鈴鹿', ['jp-1962']], ['铃鹿', ['jp-1962']], ['japanese gp', ['jp-1962']], ['日本 鈴鹿', ['jp-1962']],
      ['鈴鹿賽道', ['jp-1962']], ['us', US], ['uk', ['gb-1948']], ['italy', IT], ['nürburgring', ['de-1927']], ['sao paulo', ['br-1940']],
      ['蒙札', ['it-1922']], ['xyz', []], ['japan monza', []], ['大獎賽', T.map(t => t.id)], ['站', T.map(t => t.id)]
    ];
    const bad = Q.filter(([q, e]) => !real.searchTracks || !sameSet(real.searchTracks(T, q), e)).map(([q, e]) => ({ q, got: real.searchTracks ? real.searchTracks(T, q) : null, e }));
    check('FLOW-3: the search finds the Taiwanese round names (日本站, 日本大獎賽), 日本GP and ＪＡＰＡＮ; ' + Q.length + ' queries', bad.length === 0, bad);
  }

  console.log('\n' + passed + ' / ' + (passed + failed) + ' checks passed' + (failed ? '' : ': all main tests passed'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
