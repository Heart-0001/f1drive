// node devtests/bots-test/node-race.js [trackId=it-1922] [bots=15] [skill=mixed] [q=1] [r=2]
// The computer drivers in the REAL js/main.js, in node: the real track / car / tyres / pit / laps / session / gp / raceline
// / cars / ai modules, stubs only for what needs a browser (as test/main.test.js). The player's car is driven by a
// computer driver of its own through a fake controller (F1.gamepad stub: its throttle / brake / steering every frame),
// frames pumped at 1/120 s (one physics step each).
// Checks: the 電腦車手 setting -> the lineup (real names, the season's cars, our seat taken, our teammate in the other),
// every bot in its own grid box, free practice driven (all move, nothing NaN, no pile-up), a whole offline Grand Prix
// (qualifying -> grid by the times -> lights -> race -> results): the bots classified, sensible order, no stuck bot; the
// count / skill changed in free practice; the field rebuilt on another track; the physics cost per frame.
// Exit code 1 on a failed check. About 1-3 min (a Monza race of 2 laps with 16 cars, simulated 120 Hz).
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const TRACK = process.argv[2] || 'it-1922';
const NBOTS = Number(process.argv[3] || 15);
const SKILL = process.argv[4] || 'mixed';
const Q = Number(process.argv[5] || 1), R = Number(process.argv[6] || 2);

/* ---------- browser stand-ins (as test/main.test.js) ---------- */
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
for (const f of ['tracks-data.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js', 'js/raceline.js',
  'js/tunnels.js', 'js/collide.js', 'js/laps.js', 'js/pit.js', 'js/ai.js', 'net/session.js', 'js/gp.js']) require(path.join(ROOT, f));
const F1 = global.F1;
F1.createCockpit = () => ({ group: new THREE.Group(), update() {}, setCar() {}, setSources() {}, centreLook() {}, setLook() {} });
const U = { opts: null, toasts: [], gp: null, cars: null, bots: { count: NBOTS, skill: SKILL } };
F1.ui = {
  init(o) { U.opts = o; }, setTrack() {}, showMenu() {}, hideMenu() {}, updateHUD(h) { U.hud = h; }, setPit() {}, setGp(v) { U.gp = v; },
  setCars(v) { U.cars = v; }, setLights() {}, setResumeHandler() {}, toast(t) { U.toasts.push(t); }, setLoading() {}, setCompound() {},
  getProfile: () => ({ name: 'Tester', colour: '#ff0000' }), getCar: () => '2026-ferrari', getYear: () => 2026,
  getAudio: () => ({ volume: 0, muted: true }), getBots: () => ({ count: U.bots.count, skill: U.bots.skill })
};
// the player's "controller": a computer driver of its own drives our car through main.js's own input path
const PAD = { throttle: null, brake: null, steer: null, boost: false, reset: false, on: false };
F1.gamepad = {
  state: { connected: true, id: 'ai-pad' }, active: false, onChange: null,
  poll() { const p = { reset: PAD.reset, line: false, menu: false, recentre: false, limiter: false, compound: false }; PAD.reset = false; return { lookX: 0, lookY: 0, pressed: p }; },
  mergeInput(keys, out) {
    driveSelf();
    out.up = !!keys.up; out.down = !!keys.down; out.left = !!keys.left; out.right = !!keys.right;
    out.throttle = PAD.on ? PAD.throttle : null; out.brake = PAD.on ? PAD.brake : null; out.steerAxis = PAD.on ? PAD.steer : null;
    out.boost = PAD.on && PAD.boost; out.limiter = !!keys.limiter;
    return out;
  },
  rumble() { return false; }
};
F1.audio = { supported: true, muted: true, init() {}, setVolume() {}, setMuted() {}, setEngine() {}, setActive() {}, beep() {}, play() {}, update() {}, setTunnel() {} };
require(path.join(ROOT, 'js/main.js'));
const g = F1.game;

let failed = 0, passed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (info === undefined ? '' : '  ' + JSON.stringify(info)));
}
const FRAME = 1000 / 120;
let T = 1000;
const frameMs = [];
function frames(n) {
  for (let k = 0; k < n; k++) {
    T += FRAME; const q = rafQ; rafQ = [];
    const t0 = process.hrtime.bigint();
    q.forEach(r => r.fn(T));
    frameMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (frameMs.length > 5000) frameMs.splice(0, 1000);
  }
}
function pumpUntil(cond, max) { for (let k = 0; k < max; k++) { if (cond()) return true; frames(1); } return cond(); }
const tick = ms => new Promise(r => setTimeout(r, ms));
const trackData = id => global.F1_TRACKS.find(t => t.id === id);
function key(code, down) {
  const ev = { code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: {}, preventDefault() {} };
  (winL[down === false ? 'keyup' : 'keydown'] || []).slice().forEach(fn => fn(ev));
}
function tap(code) { key(code, true); key(code, false); }
async function load(id) {
  if (g.running) tap('Escape');
  U.opts.onSelectTrack(trackData(id));
  frames(1); await tick(5);
  return g.trackData && g.trackData.id === id && g.running;
}

// the player's driver (made per track; the views are main.js's own: ours + the bots)
let me = null, meCtx = null, meEntry = {};
function makeSelf() {
  me = F1.createAIDriver({ track: g.track, raceLine: g.raceLine, car: g.car, skill: 0.7, seed: 4242, id: 1, slot: 0, name: 'Tester' });
  meCtx = F1.AI.createContext(); me.reset();
}
function driveSelf() {
  if (!me || !PAD.on || !g.track) return;
  const e = g.gp.entry(1, meEntry);
  meCtx.phase = g.gp.phase; meCtx.locked = e.locked; meCtx.lap = e.lap; meCtx.laps = e.lapTotal; meCtx.done = e.done === true;
  meCtx.prog = g.lap ? g.lap.progress(g.car.state.sampleIndex) : NaN; meCtx.pit = null; meCtx.wear = 1;
  const views = g.botViews.length ? g.botViews : [F1.AI.createView(1)];
  const inp = me.think(1 / 120, views, meCtx);
  PAD.throttle = inp.throttle > 0 ? inp.throttle : null; PAD.brake = inp.brake > 0 ? inp.brake : null;
  PAD.steer = inp.steerAxis || null; PAD.boost = !!inp.boost;
  if (inp.reset) PAD.reset = true;
}

function finiteState(s) { return [s.x, s.z, s.y, s.heading, s.speed].every(Number.isFinite); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

(async function () {
  const ok0 = await load(TRACK);
  check('track loaded and driving: ' + TRACK, ok0);
  const B = g.bots;
  check('the setting gives ' + NBOTS + ' computer drivers on the track', B.length === NBOTS, B.length);
  const names = B.map(b => b.name), carsUsed = B.map(b => b.spec.id);
  console.log('  field: ' + B.map(b => b.name + ' (' + b.spec.id.replace(/^\d+-/, '') + ', ' + b.skill + ')').join(' | '));
  check('real, unique names of at most 16 characters', new Set(names).size === names.length && names.every(n => n && Array.from(n).length <= 16 && !/^AI \d/.test(n)), names);
  check('all of the season (2026), no standard car', carsUsed.every(id => /^2026-/.test(id) && !/standard/.test(id)), carsUsed);
  const fer = B.filter(b => b.spec.id === '2026-ferrari');
  check('our team (Ferrari): one bot in the other seat (Hamilton), not two', fer.length === 1 && /Hamilton/.test(fer[0].name), fer.map(b => b.name));
  const perCar = {}; carsUsed.forEach(c => { perCar[c] = (perCar[c] || 0) + 1; });
  check('at most two per team', Object.values(perCar).every(n => n <= 2), perCar);
  check('ids 2..16, slots 1..15 (we are slot 0)', B.every((b, i) => b.id === i + 2 && b.slot === i + 1));
  // grid boxes
  const G = g.track.grid;
  const offBox = B.filter(b => dist(b.car.state, { x: G[b.slot].x - Math.sin(G[b.slot].heading) * 2.8, z: G[b.slot].z - Math.cos(G[b.slot].heading) * 2.8 }) > 0.6);
  check('each bot in its own grid box (slot + 1)', offBox.length === 0, offBox.map(b => b.slot));
  check('we are in grid box 1 (slot 0) with bots on the track', dist(g.car.state, { x: G[0].x - Math.sin(G[0].heading) * 2.8, z: G[0].z - Math.cos(G[0].heading) * 2.8 }) < 0.6);
  check('the view rows / setting reach the UI: bots {count, skill, max 15, canEdit, available}, botList',
    U.gp && U.gp.bots && U.gp.bots.count === NBOTS && U.gp.bots.max === 15 && U.gp.bots.canEdit === true && U.gp.bots.available === true && U.gp.botList.length === NBOTS,
    U.gp && U.gp.bots);
  check('the car cards say who drives each car (drivers)', U.cars && U.cars.drivers && U.cars.drivers['2026-ferrari'] && U.cars.drivers['2026-ferrari'].length === 2,
    U.cars && U.cars.drivers && U.cars.drivers['2026-ferrari']);

  /* free practice: everybody drives */
  makeSelf(); PAD.on = true;
  const p0 = B.map(b => b.lap.progress(b.car.state.sampleIndex));
  frames(120 * 40);
  const moved = B.filter((b, i) => b.lap.progress(b.car.state.sampleIndex) - p0[i] > 0.3);
  check('free practice 40 s: every bot moved on (> 0.3 lap)', moved.length === B.length, B.map((b, i) => +(b.lap.progress(b.car.state.sampleIndex) - p0[i]).toFixed(2)));
  check('nothing NaN', B.every(b => finiteState(b.car.state)) && finiteState(g.car.state));
  check('we drove too (our AI through the fake pad)', g.lap.progress(g.car.state.sampleIndex) > 0.3, g.lap.progress(g.car.state.sampleIndex));
  const stats = () => B.reduce((a, b) => { const s = b.ai.stats; a.resets += s.resets; a.offs += s.offs; a.wall += s.wallHits; a.stuck += s.stuck; return a; }, { resets: 0, offs: 0, wall: 0, stuck: 0 });
  console.log('  free practice stats', JSON.stringify(stats()));

  /* the setting changes in free practice: fewer, another level */
  tap('Escape');
  U.bots = { count: 6, skill: 'legend' }; U.opts.onBots(U.bots);
  check('6 legends: the field shrinks to 6, skill ~1', g.bots.length === 6 && g.bots.every(b => b.skill > 0.9), g.bots.map(b => b.skill));
  U.bots = { count: NBOTS, skill: SKILL }; U.opts.onBots(U.bots);
  check('back to ' + NBOTS + ' ' + SKILL, g.bots.length === NBOTS, g.bots.length);
  tap('Escape');                                   // resume
  frames(10);

  /* a Grand Prix */
  U.opts.onGpStart({ q: Q, r: R, wear: 2 });
  frames(2);
  const Bq = g.bots;
  check('qualifying: the session holds us and every bot', g.gp.phase === 'quali' && g.gp.snapshot.players.length === NBOTS + 1, g.gp.phase);
  check('qualifying: everybody from their room slot (grid box slot + 1)', Bq.every(b => dist(b.car.state, { x: G[b.slot].x - Math.sin(G[b.slot].heading) * 2.8, z: G[b.slot].z - Math.cos(G[b.slot].heading) * 2.8 }) < 0.6));
  makeSelf();
  const qT0 = Date.now();
  const toGrid = pumpUntil(() => g.gp.phase === 'grid', 120 * (Q * 160 + 120));
  check('qualifying done by everybody -> the grid', toGrid, { phase: g.gp.phase, rows: U.gp.rows.map(r => [r.name, r.laps, r.done]) });
  console.log('  qualifying ' + ((Date.now() - qT0) / 1000).toFixed(1) + ' s wall');
  const s = g.gp.snapshot;
  const qOrder = s.grid.map(id => id === 1 ? 'YOU' : (g.bots.find(b => b.id === id) || {}).name);
  console.log('  grid: ' + qOrder.join(', '));
  const placed = g.bots.every(b => { const k = s.grid.indexOf(b.id); const gb = G[k]; return k >= 0 && dist(b.car.state, { x: gb.x - Math.sin(gb.heading) * 2.8, z: gb.z - Math.cos(gb.heading) * 2.8 }) < 0.6; });
  check('the grid: every bot in the box of its qualifying place', placed);
  const qRows = U.gp.rows;
  check('qualifying times for all (bots with a time)', qRows.every(r => typeof r.best === 'number' && r.best > 0), qRows.map(r => [r.name, r.best]));
  check('rows mark the bots (bot: true, skill) and us', qRows.filter(r => r.bot).length === NBOTS && qRows.filter(r => r.isSelf).length === 1);
  // frozen on the grid
  const gx = g.bots.map(b => [b.car.state.x, b.car.state.z]);
  frames(120);
  check('held on the grid before the lights', g.bots.every((b, i) => Math.hypot(b.car.state.x - gx[i][0], b.car.state.z - gx[i][1]) < 0.01));
  check('race starts (lights out)', pumpUntil(() => g.gp.phase === 'race', 120 * 12));
  check('the bots\' lap clocks are armed at lights out', g.bots.every(b => b.lap.started || b.lap.behind !== undefined));
  // the race
  const rT0 = Date.now();
  let maxStand = 0; const standT = {};
  let n = 0;
  const done = pumpUntil(() => {
    if (++n % 120 === 0) {
      for (const b of g.bots) {
        const v = Math.abs(b.car.state.speed);
        const e = g.gp.entry(b.id, {});
        if (v < 1 && !b.pit.state.service && !e.done && g.gp.phase === 'race') standT[b.id] = (standT[b.id] || 0) + 1; else standT[b.id] = 0;
        maxStand = Math.max(maxStand, standT[b.id]);
      }
    }
    return g.gp.phase === 'results';
  }, 120 * (R * 200 + 200));
  check('the race ends -> results', done, g.gp.phase);
  console.log('  race ' + ((Date.now() - rT0) / 1000).toFixed(1) + ' s wall');
  const res = U.gp.rows;
  console.log('  results:'); res.forEach(r => console.log('   ' + r.pos + '. ' + r.name + (r.bot ? ' [AI ' + r.skill + ']' : ' [YOU]') + ' laps ' + r.laps + ' ' + (r.done ? r.time.toFixed(3) : (r.dnf ? 'DNF' : '--')) + ' best ' + (r.best ? r.best.toFixed(3) : '--')));
  const fin = res.filter(r => r.done);
  check('every car classified with R laps (no DNF)', fin.length === NBOTS + 1, res.filter(r => !r.done).map(r => r.name));
  check('no bot stood still on the track for 15 s or more (outside the box)', maxStand < 15, { maxStand });
  const st2 = stats();
  console.log('  race stats', JSON.stringify(st2), 'pitStops', g.bots.reduce((a, b) => a + b.ai.stats.pitStops, 0));
  // order vs skill (bots only): Spearman
  const bres = res.filter(r => r.bot);
  if (bres.length > 3) {
    const rank = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const rr = new Array(a.length); idx.forEach((p, k) => { rr[p[1]] = k + 1; }); return rr; };
    const ra = rank(bres.map(r => r.pos)), rb = rank(bres.map(r => -r.skill)), nn = bres.length;
    let d2 = 0; for (let i = 0; i < nn; i++) d2 += (ra[i] - rb[i]) ** 2;
    const sp = 1 - 6 * d2 / (nn * (nn * nn - 1));
    console.log('  finishing order vs skill (Spearman): ' + sp.toFixed(2));
    check('finishing order follows skill (Spearman > 0.3)', sp > 0.3, sp);
  }
  // physics cost: frames of the race (node, no rendering)
  const fm = frameMs.slice(-3000);
  console.log('  frame (1 step, ' + (NBOTS + 1) + ' cars, node): median ' + pct(fm, 0.5).toFixed(3) + ' ms, p95 ' + pct(fm, 0.95).toFixed(3) + ' ms, max ' + Math.max(...fm).toFixed(2) + ' ms');
  check('physics + glue per step under 1.5 ms (p95)', pct(fm, 0.95) < 1.5, pct(fm, 0.95));

  /* end -> free practice: the bots back in their slots, driving on */
  g.gp.action('end');
  frames(2);
  check('back to free practice: bots in their room slots again', g.gp.phase === 'free' && g.bots.every(b => b.lap && Math.abs(b.car.state.speed) < 0.01));
  frames(120 * 10);
  check('... and driving', g.bots.filter(b => Math.abs(b.car.state.speed) > 5).length >= NBOTS - 2);

  /* another track: the field rebuilt there */
  const other = TRACK === 'mc-1929' ? 'it-1922' : 'mc-1929';
  await load(other);
  check('another track (' + other + '): ' + NBOTS + ' bots rebuilt on it', g.bots.length === NBOTS && g.bots.every(b => b.ai && b.lap && finiteState(b.car.state)));
  makeSelf();
  frames(120 * 20);
  check('... driving there 20 s, nothing NaN', g.bots.every(b => finiteState(b.car.state)));
  console.log('  stats after', JSON.stringify(stats()));

  /* none: the v6 game */
  tap('Escape');
  U.bots = { count: 0, skill: 'pro' }; U.opts.onBots(U.bots);
  check('count 0: no bots left', g.bots.length === 0 && g.gp.bots().length === 0);

  console.log('\n' + passed + ' / ' + (passed + failed) + ' checks passed' + (failed ? ': ' + failed + ' FAILED' : ''));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
