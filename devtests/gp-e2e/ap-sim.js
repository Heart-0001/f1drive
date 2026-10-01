// node devtests/gp-e2e/ap-sim.js [laps|recover|park|follow|race] [track id, default mc-1929]
// The autopilot of the end-to-end harnesses (autopilot.js) against the REAL js/car.js, js/raceline.js, js/laps.js and
// js/collide.js in node, at warp speed: the loop is main.js's (120 Hz physics steps, the controller sampled once per
// rendered frame, the lap counter fed after every step, each car resolving its own collisions).
//   laps     pace scale x controller rate (60 / 30 / 20 / 12 Hz): out lap + 2 timed laps, grass / wall counts
//   recover  thrown off mid-lap in six ways (sideways, into the wall, backwards, on the grass, nose on the wall, standing
//            across the road): must get back and finish the lap
//   park     one car parks beside the road, another laps past it; then parks ON the racing line: the other goes round
//   follow   a quick car behind a slow one: keeps a gap, no contact
//   race     the scenario of online.js run 1 (grid C, A, B; B rams A at the start, stops at the parking place until it
//            has been lapped) and run 2 (one car stops, the others finish): the timeline to expect
// Exit code 1 when a check fails.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
require(path.join(ROOT, 'js/collide.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const mainGrid = require(path.join(ROOT, 'devtests/laps-test/main-grid.js'));
const createAutopilot = require('./autopilot');
const F1 = global.F1;

const STEP = 1 / 120;
const only = process.argv[2] && /^(laps|recover|park|follow|race)$/.test(process.argv[2]) ? process.argv[2] : '';
const trackId = process.argv[3] || 'mc-1929';
const td = global.F1_TRACKS.find(t => t.id === trackId);
const track = F1.buildTrack(td), line = F1.buildRaceLine(track);
const S = track.samples, N = S.length, ds = track.length / N;
const fmt = t => t == null ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
let failures = 0;
function check(ok, what) { console.log((ok ? '  ok    ' : '  FAIL  ') + what); if (!ok) failures++; return ok; }

// One car + its autopilot + its lap counter, stepped as main.js steps the player's car.
function makeCar(id, hz) {
  const car = F1.createCar(), ap = createAutopilot();
  const c = { id, car, ap, st: car.state, lap: null, laps: [], every: Math.max(1, Math.round(120 / (hz || 60))), n: 0,
    input: { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null }, locked: false,
    hitCar: 0, hitWall: 0 };
  c.place = idx => { car.reset(track, idx); c.lap = createLapCounter(N, car.state.sampleIndex); };
  c.grid = slot => { const idx = mainGrid(track, car)(slot); c.lap = createLapCounter(N, idx); return idx; };
  return c;
}

// cars: all the cars on the track (solid for each other unless ghosts is true). -> runs until done(t) or tMax.
function run(cars, tMax, done, opts) {
  opts = opts || {};
  let t = opts.t0 || 0, steps = 0;
  const contacts = [];
  while (t < tMax) {
    for (const c of cars) {
      if (c.gone) continue;
      if (c.n++ % c.every === 0) {                       // a rendered frame: the pad is polled once
        const others = cars.filter(o => o !== c && !o.gone).map(o => ({ id: o.id, x: o.st.x, z: o.st.z, heading: o.st.heading, speed: o.st.speed, solid: !opts.ghosts }));
        const o = c.ap.step({ t, st: c.st, track, line, locked: c.locked, others });
        c.input.throttle = o.throttle > 0 ? o.throttle : null;
        c.input.brake = o.brake > 0 ? o.brake : null;
        c.input.steerAxis = o.steer !== 0 ? o.steer : null;
        if (o.reset && !c.locked) { c.car.reset(track, c.lap.jumping ? c.lap.prevIdx : c.st.sampleIndex); c.lap.sync(c.st.sampleIndex); }
        c.frameHit = 0;
      }
    }
    for (const c of cars) {
      if (c.locked || c.gone) continue;
      c.car.update(STEP, c.input, track);
      if (c.st.hit > 0) c.hitWall = Math.max(c.hitWall, c.st.hit);
      if (!opts.ghosts) {
        const others = cars.filter(o => o !== c && !o.gone).map(o => o.st);
        contacts.length = 0;
        const h = F1.resolveCarCollisions(c.st, others, STEP, contacts);
        if (h > 0) c.hitCar = Math.max(c.hitCar, h);
      }
      if (c.st.hit > c.frameHit) c.frameHit = c.st.hit;
      if (c.lap.update(c.st.sampleIndex, c.st.speed, STEP) === 2) { c.laps.push(c.lap.last); c.lapAt = t + STEP; if (opts.onLap) opts.onLap(c, t + STEP); }
      c.st.hit = c.frameHit;                              // main.js: the strongest impact of the frame stays visible
    }
    t += STEP; steps++;
    if (opts.each) opts.each(t);
    if (done && done(t)) break;
  }
  return t;
}

function dist(a, b) { return Math.hypot(a.st.x - b.st.x, a.st.z - b.st.z); }

/* ---------- laps ---------- */
function testLaps() {
  console.log('\nlaps on ' + td.name + ' (N ' + N + ', ' + track.length.toFixed(0) + ' m, line predicts ' + fmt(line.lapTime) + ', server minimum ' + (track.length / (330 / 3.6)).toFixed(1) + ' s)');
  for (const hz of [60, 30, 20, 12]) {
    for (const scale of [1, 0.93, 0.82, 0.6]) {
      const c = makeCar(1, hz);
      c.place(N - 10);
      c.ap.cfg.mode = 'line'; c.ap.cfg.scale = scale;
      const t = run([c], 900, () => c.laps.length >= 2);
      const s = c.ap.stats;
      const ok = c.laps.length === 2 && s.resets === 0 && s.reverses === 0 && (scale > 0.95 || (s.wall === 0 && s.grass === 0));
      check(ok, hz + ' Hz, pace ' + scale + ': laps ' + c.laps.map(fmt).join(' ') + '  grass steps ' + s.grass + ', wall hits ' + s.wall + ' (max ' + s.wallMax.toFixed(2) +
        '), max off the line ' + s.maxDev.toFixed(2) + ' m, reverses ' + s.reverses + ', resets ' + s.resets + (s.events.length ? '  ' + JSON.stringify(s.events.slice(0, 4)) : ''));
    }
  }
}

/* ---------- recovery ---------- */
function testRecover() {
  console.log('\nrecovery (30 Hz controller, pace 0.93)');
  const upset = {
    'heading + 0.6 rad at speed': c => { c.st.heading += 0.6; },
    'heading - 0.9 rad at speed': c => { c.st.heading -= 0.9; },
    'facing backwards, standing': c => { c.st.heading += Math.PI; c.st.speed = 0; },
    'on the grass at the wall, 20 m/s': c => { const s = S[c.st.sampleIndex]; const d = (s.wallPosDist || track.wallDist) - 1.2; c.st.x = s.x + s.nx * d; c.st.z = s.z + s.nz * d; c.st.speed = 20; },
    'nose on the wall, standing': c => { const s = S[c.st.sampleIndex]; const d = -((s.wallNegDist || track.wallDist) - 1.05); c.st.x = s.x + s.nx * d; c.st.z = s.z + s.nz * d;
      c.st.heading = Math.atan2(-s.nx, -s.nz); c.st.speed = 0; },
    'standing across the road': c => { const s = S[c.st.sampleIndex]; c.st.heading = Math.atan2(s.nx, s.nz); c.st.speed = 0; }
  };
  for (const at of [300, 610, 1010, 1320]) {
    for (const name of Object.keys(upset)) {
      const c = makeCar(1, 30);
      c.place(N - 10);
      c.ap.cfg.mode = 'line'; c.ap.cfg.scale = 0.93;
      let done = false, tUp = 0;
      const t = run([c], 400, tt => {
        if (!done && c.lap.started && c.st.sampleIndex >= at && c.st.sampleIndex < at + 40) { done = true; tUp = tt; upset[name](c); }
        return c.laps.length >= 1;
      });
      const s = c.ap.stats;
      check(c.laps.length === 1 && done, 'sample ' + at + ', ' + name + ': lap ' + fmt(c.laps[0]) + '  wall hits ' + s.wall + ', reverses ' + s.reverses + ', resets ' + s.resets +
        '  ' + JSON.stringify(s.events.slice(0, 5)));
    }
  }
}

/* ---------- a parked car ---------- */
function testPark(PARK) {
  console.log('\nparking place: sample ' + PARK.index + ', d ' + PARK.d + ' (racing line there d ' + line.points[PARK.index].d.toFixed(1) + ', road half width ' + S[PARK.index].halfW + ')');
  const b = makeCar(2, 30), c = makeCar(3, 30);
  b.grid(2); c.grid(0);
  b.ap.cfg.mode = 'line'; b.ap.cfg.scale = 0.82; b.ap.cfg.park = PARK;
  c.ap.cfg.mode = 'line'; c.ap.cfg.scale = 1; c.ap.cfg.holdUntil = 12;      // lets B get there first
  let minD = 1e9, parkedT = null;
  let t = run([b, c], 400, tt => { if (b.ap.parked && parkedT === null) parkedT = tt; return c.laps.length >= 2; }, { each: () => { minD = Math.min(minD, dist(b, c)); } });
  check(b.ap.parked && Math.abs(b.st.d - PARK.d) < 0.7 && Math.abs(b.st.speed) < 0.1, 'B parks there: after ' + (parkedT || 0).toFixed(1) + ' s at sample ' + b.st.sampleIndex + ', d ' + b.st.d.toFixed(2) +
    ', heading off the road direction by ' + wrapDeg(b.st.heading - Math.atan2(S[b.st.sampleIndex].tx, S[b.st.sampleIndex].tz)).toFixed(1) + ' deg');
  check(c.laps.length === 2 && c.hitCar === 0 && b.hitCar === 0 && minD > 5 && c.ap.stats.avoidSteps === 0,
    'C laps past it 3 times on the racing line without leaving it: laps ' + c.laps.map(fmt).join(' ') + ', closest ' + minD.toFixed(1) + ' m, impacts ' + c.hitCar + ', avoid steps ' + c.ap.stats.avoidSteps);
  // B leaves the parking place and drives on
  b.ap.cfg.park = null;
  const n0 = b.laps.length;
  t = run([b, c], t + 200, () => b.laps.length > n0, { t0: t });
  check(b.laps.length > n0 && b.hitCar === 0 && b.ap.stats.resets === 0, 'B drives on and completes its lap: ' + fmt(b.laps[b.laps.length - 1]) + ' (incl. the stop)');

  // parked ON the racing line
  const onLine = { index: 1380, d: line.points[1380].d };
  const p = makeCar(5, 30), q = makeCar(6, 30);
  p.place(1300); q.place(1100);
  p.ap.cfg.mode = 'line'; p.ap.cfg.scale = 0.8; p.ap.cfg.park = onLine;
  q.ap.cfg.mode = 'line'; q.ap.cfg.scale = 1; q.ap.cfg.holdUntil = 10;
  minD = 1e9;
  run([p, q], 300, () => q.laps.length >= 2, { each: () => { minD = Math.min(minD, dist(p, q)); } });
  check(p.ap.parked && q.laps.length === 2 && q.hitCar === 0 && p.hitCar === 0 && q.ap.stats.avoidSteps > 0 && q.ap.stats.resets === 0,
    'a car parked ON the racing line (sample 1380): the other goes round it 3 times: laps ' + q.laps.map(fmt).join(' ') + ', closest ' + minD.toFixed(2) + ' m, impacts ' + q.hitCar +
    ', avoid steps ' + q.ap.stats.avoidSteps + ', wall hits ' + q.ap.stats.wall + ', grass ' + q.ap.stats.grass);
}
function wrapDeg(a) { return Math.atan2(Math.sin(a), Math.cos(a)) * 180 / Math.PI; }

/* ---------- following ---------- */
function testFollow() {
  console.log('\nfollowing');
  const slow = makeCar(1, 30), fast = makeCar(2, 30);
  slow.grid(0); fast.grid(2);
  slow.ap.cfg.mode = 'line'; slow.ap.cfg.scale = 0.6;
  fast.ap.cfg.mode = 'line'; fast.ap.cfg.scale = 1;
  let minD = 1e9;
  run([slow, fast], 400, () => slow.laps.length >= 1, { each: () => { minD = Math.min(minD, dist(slow, fast)); } });
  check(slow.hitCar === 0 && fast.hitCar === 0 && minD > 5.6 && fast.ap.stats.accSteps > 100 && fast.ap.stats.resets === 0 && fast.ap.stats.reverses === 0,
    'pace 1.0 behind pace 0.6 for a lap: no contact, closest ' + minD.toFixed(1) + ' m (centres), gap-keeping steps ' + fast.ap.stats.accSteps + ', slow lap ' + fmt(slow.laps[0]) +
    ', wall hits ' + fast.ap.stats.wall);
}

/* ---------- the scenarios of online.js ---------- */
function testRace(PARK) {
  console.log('\nrun 1: qualifying as ghosts (A launches 2.5 s late: C drives through it)');
  const PACE = { A: 0.93, B: 0.82, C: 1 };
  let A = makeCar(1, 30), B = makeCar(2, 30), C = makeCar(3, 30);
  A.grid(0); B.grid(1); C.grid(2);
  for (const [c, k] of [[A, 'A'], [B, 'B'], [C, 'C']]) { c.ap.cfg.mode = 'line'; c.ap.cfg.scale = PACE[k]; c.ap.cfg.acc = false; c.name = k; }
  A.ap.cfg.holdUntil = 3;
  C.ap.cfg.mode = 'ram'; C.ap.cfg.ramId = 1; C.ap.cfg.ramSpeed = 40;       // straight at A, which is still standing in its box
  let minAC = 1e9, tq = run([A, B, C], 400, () => A.laps.length >= 1 && B.laps.length >= 1 && C.laps.length >= 1, { ghosts: true, each: tt => {
    minAC = Math.min(minAC, dist(A, C));
    if (C.ap.cfg.mode === 'ram' && (dist(A, C) < 1 || tt > 5)) C.ap.cfg.mode = 'line';
  } });
  check(minAC < 1.5, 'C passes through A: closest ' + minAC.toFixed(2) + ' m');
  check(C.laps[0] < A.laps[0] - 2 && A.laps[0] < B.laps[0] - 2 && C.laps[0] > track.length / (330 / 3.6),
    'qualifying laps C ' + fmt(C.laps[0]) + '  A ' + fmt(A.laps[0]) + '  B ' + fmt(B.laps[0]) + '; everybody done after ' + tq.toFixed(1) + ' s');

  console.log('run 1: race, 2 laps, grid C A B; B rams A at the start, then stops at the parking place until C and A have lapped it');
  A = makeCar(1, 30); B = makeCar(2, 30); C = makeCar(3, 30);
  C.grid(0); A.grid(1); B.grid(2);
  for (const [c, k] of [[A, 'A'], [B, 'B'], [C, 'C']]) { c.lap.arm(c.st.sampleIndex); c.ap.cfg.mode = 'line'; c.ap.cfg.scale = PACE[k]; c.name = k; }
  A.ap.cfg.thrCap = 0.3;
  B.ap.cfg.mode = 'ram'; B.ap.cfg.ramId = 1; B.ap.cfg.ramSpeed = 30;
  let rammed = null, passed = { C: 0, A: 0 }, prev = { C: C.st.sampleIndex, A: A.st.sampleIndex }, released = null;
  const fin = {};
  let winnerAt = null;
  const t1 = run([A, B, C], 600, tt => fin.A && fin.B && fin.C, {
    onLap: (c, tt) => {
      if (fin[c.name]) return;
      if (c.laps.length >= 2 || winnerAt !== null) { fin[c.name] = { t: tt, laps: c.laps.length }; if (winnerAt === null) winnerAt = tt; }
    },
    each: tt => {
      if (!rammed && (A.hitCar > 0 || B.hitCar > 0)) rammed = { t: tt, a: A.hitCar, b: B.hitCar };
      if ((rammed && tt > rammed.t + 0.3 || tt > 6) && B.ap.cfg.mode === 'ram') {
        B.ap.cfg.mode = 'line'; B.ap.cfg.holdUntil = tt + 1.5; B.ap.cfg.park = PARK;
        A.ap.cfg.thrCap = 1;
      }
      // B waits at the parking place until both have come past it again
      for (const c of [C, A]) {
        const was = prev[c.name], now = c.st.sampleIndex;
        if (B.ap.parked && was < PARK.index + 15 && now >= PARK.index + 15 && now - was < 100) passed[c.name]++;
        prev[c.name] = now;
      }
      if (B.ap.parked && passed.C >= 1 && passed.A >= 1 && released === null) { released = tt; B.ap.cfg.park = null; }
    }
  });
  check(!!rammed && rammed.t < 6, 'B rams A ' + (rammed ? rammed.t.toFixed(2) + ' s after lights out (impact A ' + rammed.a.toFixed(2) + ', B ' + rammed.b.toFixed(2) + ')' : 'NEVER'));
  check(fin.C && fin.A && fin.B && fin.C.t < fin.A.t && fin.C.laps === 2 && fin.A.laps === 2 && fin.B.laps === 1 && fin.B.t > fin.C.t,
    'finish: C ' + (fin.C ? fmt(fin.C.t) : '--') + ' (2 laps)  A ' + (fin.A ? fmt(fin.A.t) : '--') + ' (' + (fin.A && fin.A.laps) + ' laps)  B ' + (fin.B ? fmt(fin.B.t) : '--') + ' (' + (fin.B && fin.B.laps) +
    ' lap: lapped); B parked until ' + (released || 0).toFixed(1) + ' s; race over after ' + t1.toFixed(1) + ' s');
  for (const c of [A, B, C]) {
    const s = c.ap.stats;
    console.log('    ' + c.name + ': laps ' + c.laps.map(fmt).join(' ') + '  wall hits ' + s.wall + ', car impacts ' + s.car + ' (max ' + s.carMax.toFixed(2) + '), grass steps ' + s.grass +
      ', gap-keeping steps ' + s.accSteps + ', avoid steps ' + s.avoidSteps + ', reverses ' + s.reverses + ', resets ' + s.resets + '  ' + JSON.stringify(s.events.slice(0, 6)));
  }
  check([A, B, C].every(c => c.ap.stats.resets === 0), 'nobody needed the reset button');

  console.log('run 2: race, 1 lap, grid A B C D (join order); B stops at the parking place for good, D leaves after 20 s');
  A = makeCar(1, 30); B = makeCar(2, 30); C = makeCar(3, 30);
  const D = makeCar(4, 30);
  A.grid(0); B.grid(1); C.grid(2); D.grid(3);
  const PACE2 = { A: 1, B: 0.82, C: 0.93, D: 0.82 };
  for (const [c, k] of [[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D']]) { c.lap.arm(c.st.sampleIndex); c.ap.cfg.mode = 'line'; c.ap.cfg.scale = PACE2[k]; c.name = k; }
  B.ap.cfg.park = PARK;
  [A, B, C, D].forEach((c, slot) => { c.ap.cfg.holdUntil = 0.5 * slot; });     // reaction times: nobody turns in on the car beside it
  const fin2 = {};
  let w2 = null, minB = 1e9;
  const t2 = run([A, B, C, D], 400, tt => fin2.A && fin2.C, {
    onLap: (c, tt) => { if (!fin2[c.name]) { fin2[c.name] = { t: tt, laps: c.laps.length }; if (w2 === null) w2 = tt; } },
    each: tt => { if (tt > 20) D.gone = true; minB = Math.min(minB, dist(B, C), dist(B, A)); }
  });
  check(fin2.A && fin2.C && !fin2.B && fin2.A.t < fin2.C.t && B.ap.parked, 'finish: A ' + (fin2.A ? fmt(fin2.A.t) : '--') + '  C ' + (fin2.C ? fmt(fin2.C.t) : '--') + '  B parked at sample ' + B.st.sampleIndex +
    ' (closest another car came: ' + minB.toFixed(1) + ' m); results 90 s after the winner: ' + ((w2 || 0) + 90).toFixed(0) + ' s');
  for (const c of [A, B, C, D]) {
    const s = c.ap.stats;
    console.log('    ' + c.name + ': laps ' + c.laps.map(fmt).join(' ') + '  wall hits ' + s.wall + ', car impacts ' + s.car + ', grass steps ' + s.grass + ', gap-keeping steps ' + s.accSteps +
      ', avoid steps ' + s.avoidSteps + ', reverses ' + s.reverses + ', resets ' + s.resets + '  ' + JSON.stringify(s.events.slice(0, 6)));
  }
  check([A, B, C, D].every(c => c.ap.stats.resets === 0 && c.ap.stats.car === 0), 'no contact, nobody needed the reset button');
}

const PARK = { index: 60, d: -5.6 };
const t0 = Date.now();
if (!only || only === 'laps') testLaps();
if (!only || only === 'recover') testRecover();
if (!only || only === 'park') testPark(PARK);
if (!only || only === 'follow') testFollow();
if (!only || only === 'race') testRace(PARK);
console.log('\n' + (failures ? failures + ' check(s) FAILED' : 'all autopilot checks passed') + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
process.exit(failures ? 1 : 0);
