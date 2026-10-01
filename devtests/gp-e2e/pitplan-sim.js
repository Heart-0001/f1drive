// node devtests/gp-e2e/pitplan-sim.js [track id = mc-1929] [year = 2014]
// Dry run of the harness drivers of online-v6.js against the REAL js/car.js (a season's cars, tyres, ERS, limiter),
// js/raceline.js (the car's own line), js/pit.js and js/laps.js in node, stepped as main.js steps the player's car
// (1/120 s physics, the pad read once per 60 Hz frame): for each of three cars (one per team, slot 0 / 1 / 2, pace
// 1 / 0.93 / 0.86) the race autopilot (autopilot.js) with ERS deployed on the straights (the rule of online-v6-page.js)
// from its grid box, then the pit plan (pitplan.js) from 320 m before pit.from on lap 1: into its box, the service
// (held there as main.js holds it), out again and a lap back on the racing line. Tyre wear x3.
// Checks per car: no wall / grass, the stop in its own box, the service held, at most the lane limit + 3 km/h
// between the lines, the limiter wanted over the whole lane, the laps counted through the lane, back on the line.
// Exit code 1 when a check fails. Prints the timeline (when each car is in the lane: which of them overlap).
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/seasons-data.js'));
require(path.join(ROOT, 'js/cars.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
const createPit = require(path.join(ROOT, 'js/pit.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const mainGrid = require(path.join(ROOT, 'devtests/laps-test/main-grid.js'));
const createAutopilot = require('./autopilot');
const createPitPlan = require('./pitplan');
const F1 = global.F1;

const trackId = process.argv[2] || 'mc-1929', year = Number(process.argv[3] || 2014);
const td = global.F1_TRACKS.find(t => t.id === trackId);
const track = F1.buildTrack(td), S = track.samples, N = S.length, ds = track.length / N, pit = track.pit;
const STEP = 1 / 120, EVERY = 2;
const TEAMS = F1.cars.list(year).slice(1, 4);
const PACE = [1, 0.93, 0.86];
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok    ' : '  FAIL  ') + what); if (!ok) failures++; };
const fmt = t => t == null ? '--' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0');
// ERS as online-v6-page.js presses it: on the straights while accelerating (throttle >= 0.5, no brake, > 20 m/s, steering < 0.2)
const wantsBoost = (o, st) => o.throttle >= 0.5 && !(o.brake > 0) && st.speed > 20 && Math.abs(o.steer) < 0.2 && st.battery > 0.02;

console.log(td.name + ', ' + year + ': ' + TEAMS.map((c, i) => c.id + ' pace ' + PACE[i]).join(', ') + '; pit entry ' + pit.entry + ', exit ' + pit.exit + ', boxes ' + [0, 1, 2].map(k => pit.boxes[k].index).join(' / '));
for (let k = 0; k < 3; k++) {
  const spec = TEAMS[k], car = F1.createCar(spec), st = car.state, line = F1.buildRaceLine(track, car.perf);
  car.setBattery(1); car.tyres.fit('M'); car.tyres.setWearRate(3);
  const ap = createAutopilot(), pitL = createPit();
  ap.cfg.mode = 'line'; ap.cfg.scale = PACE[k];
  const idx = mainGrid(track, car)(k);
  const lap = createLapCounter(N, idx); lap.arm(idx); lap.time = 0;
  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false };
  let t = 0, n = 0, plan = null, planDone = null, laps = [], boostT = 0, minBat = 1, maxDeploy = 0, hits = 0, grass = 0, laneT = [null, null], after = 0, events = [];
  while (t < 400) {
    if (n++ % EVERY === 0) {
      const P2 = pitL.state;
      if (!plan && !planDone && laps.length === 0) {
        const k2 = ((pit.from - st.sampleIndex) % N + N) % N * ds;
        if (k2 < 320 && k2 > 250) { plan = createPitPlan(track, line, st, { slot: k, scale: PACE[k], limiterM: 30 }); if (plan.error) { console.log('plan error', plan.error); break; } }
      }
      let o;
      if (plan && !plan.done) {
        o = plan.step(st, car.perf, EVERY * STEP, P2, false);
        input.limiter = o.limiter; input.boost = false;
        if (plan.done) { planDone = plan.info(); plan = null; }
      } else {
        o = ap.step({ t, st, track, line, locked: false, others: [] });
        input.limiter = false;
        input.boost = wantsBoost(o, st);
      }
      input.throttle = o.throttle > 0 ? o.throttle : null; input.brake = o.brake > 0 ? o.brake : null; input.steerAxis = o.steer;
      if (input.boost) boostT += EVERY * STEP;
    }
    if (pitL.state.service) {                   // held in the box like main.js does
      st.speed = 0; st.hit = 0; st.gear = 0;
      const ev = pitL.update(STEP, st, track, { slot: k, limiter: input.limiter });
      if (ev) { events.push([+t.toFixed(2), ev]); if (ev === 'serviceDone') car.tyres.fit('M'); }
      lap.update(st.sampleIndex, 0, STEP);
    } else {
      car.update(STEP, input, track);
      if (st.hit > 0) hits++;
      if (st.onGrass) grass++;
      const ev = pitL.update(STEP, st, track, { slot: k, limiter: input.limiter });
      if (ev) { events.push([+t.toFixed(2), ev]); if (ev === 'serviceStart') st.speed = 0; }
      if (lap.update(st.sampleIndex, st.speed, STEP) === 2) laps.push(lap.last);
    }
    if (pitL.state.inLane) { if (laneT[0] === null) laneT[0] = t; laneT[1] = t; }
    minBat = Math.min(minBat, st.battery); maxDeploy = Math.max(maxDeploy, st.deploy);
    t += STEP;
    if (planDone && laps.length >= 2 && ++after > 120 * 5) break;   // the lap with the stop completed, back on the race line
  }
  const r = planDone ? planDone.rec : null;
  console.log(spec.id + ': laps ' + laps.map(fmt).join(' + ') + '; in the lane ' + (laneT[0] || 0).toFixed(1) + ' .. ' + (laneT[1] || 0).toFixed(1) + ' s after the start; ERS ' + boostT.toFixed(1) + ' s (battery min ' + minBat.toFixed(2) + ', deploy max ' + maxDeploy.toFixed(2) + '); ' + J(events));
  check(!!planDone && !planDone.noService && planDone.served, spec.id + ': pit plan done, served in box ' + (k + 1) + (planDone && planDone.stopped ? ' (stopped ' + planDone.stopped.along.toFixed(2) + ' m along, ' + planDone.stopped.across.toFixed(2) + ' across)' : ''));
  check(hits === 0 && grass === 0, spec.id + ': no wall contact, no grass (' + hits + ' / ' + grass + ' steps)');
  check(r && r.maxLaneKmh <= pit.limitKmh + 3, spec.id + ': max ' + (r ? r.maxLaneKmh.toFixed(1) : '?') + ' km/h in the lane (limit ' + pit.limitKmh + ')');
  check(r && r.svcTotal >= 2 && r.maxServiceMove === 0, spec.id + ': service ' + (r && r.svcTotal ? r.svcTotal.toFixed(2) : '?') + ' s, held');
  check(laps.length >= 2 && laps[0] > 30, spec.id + ': laps counted through the lane: ' + laps.map(fmt).join(', '));
  check(boostT > 2 && minBat < 0.97, spec.id + ': ERS deployed ' + boostT.toFixed(1) + ' s');
}
function J(v) { return JSON.stringify(v); }
console.log(failures ? failures + ' FAILURES' : 'pit plan dry run: all checks passed');
process.exit(failures ? 1 : 0);
