// node devtests/car-v6/pit-fuzz.js [track regex | all] [runs per track = 240] [seed = 1]
//
// Adversarial: the REAL v6 car (js/car.js) thrown at the pit complex of every track (js/track.js, scenery-data.js as
// in the game) from random places, headings, speeds (up to 95 m/s, forwards and backwards) with random inputs
// (keys / analog steering, throttle, brake, boost, limiter, a random frame time now and then), plus targeted runs:
// ramming the pit wall from the track and from the lane at 5..90 deg, head-on into both of its ends (the
// attenuators), reversing into it, ramming the garage face. Checks every step against the ground truth
// (track.nearest, global):
//   wall    the car's origin never inside the pit wall grown by the car (|d - wallD| >= wallHalfT + 1 m wherever the
//           wall stands, 0.9 m beyond its ends included)
//   cross   the car never changes sides of the pit wall while beside it (it can only go round its ends)
//   outer   never beyond a flagged outer wall / the garage face: at the car's own sample |d| <= wall distance - 1 m
//           (as devtests/3d-test/escape.js), and at the true nearest sample within 0.5 m of that (the walls are
//           resolved per sample, and the wall distance can step by a few decimetres between two samples)
//   stale   the car's sample never more than 3 m worse than the nearest one for more than 1 s
//   nan     no NaN / Infinity in the state
// Ends with TOTAL {...}; exit code 1 when any of them is non-zero.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, "..", "..", "..");
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
const F1 = global.F1;

const arg = process.argv[2] || 'all';
const filter = arg === 'all' ? null : new RegExp(arg, 'i');
const RUNS = +(process.argv[3] || 240);
let seed = (+(process.argv[4] || 1)) >>> 0;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
const pick = a => a[Math.floor(rnd() * a.length)];
const STEP = 1 / 120;
const tot = { wall: 0, cross: 0, outer: 0, stale: 0, nan: 0 };
const seen = { pitWallHits: 0, endHits: 0, laneSideHits: 0, trackSideHits: 0, outerHits: 0, runs: 0, steps: 0 };
const t0 = Date.now();

for (const td of global.F1_TRACKS) {
  if (filter && !filter.test(td.id) && !filter.test(td.name)) continue;
  const track = F1.buildTrack(td), S = track.samples, N = S.length, L = track.length, pit = track.pit, ds = L / N;
  if (!pit) continue;
  const wq = q => ((q % N) + N) % N, kOf = i => wq(i - pit.from), K = kOf(pit.to), sg = pit.side;
  // the pit wall run(s)
  const runs = [];
  for (let k = 0, r = null; k <= K; k++) {
    const i = wq(pit.from + k), w = pit.wallD(i);
    if (Number.isFinite(w)) { if (!r) { r = { k0: k, k1: k, i0: i, s0: S[i].s, len: 0, wD: w }; runs.push(r); } r.k1 = k; r.i1 = i; r.len = ((S[i].s - r.s0) % L + L) % L; }
    else r = null;
  }
  const lim = pit.wallHalfT + 1.0;
  function frame(x, z) {                      // ground truth: nearest sample, d, along the wall run
    const g = track.nearest(x, z), s = S[g.index], k = kOf(g.index);
    const out = { i: g.index, d: g.d, k, run: null, sa: 0, rel: 0 };
    for (const r of runs) {
      if (k < r.k0 - 4 || k > r.k1 + 4) continue;
      let sa = ((s.s + (x - s.x) * s.tx + (z - s.z) * s.tz - r.s0) % L + L) % L;
      if (sa > L / 2) sa -= L;
      out.run = r; out.sa = sa; out.rel = g.d - r.wD;
    }
    return out;
  }
  const car = F1.createCar(null, { random: rnd }), st = car.state;
  car.tyres.setWearRate(0);
  const ex = [];
  let fails = { wall: 0, cross: 0, outer: 0, stale: 0, nan: 0 };
  const note = (what, o) => { fails[what]++; if (ex.length < 6) ex.push(Object.assign({ what }, o)); };

  for (let run = 0; run < RUNS; run++) {
    seen.runs++;
    const kind = pick(['random', 'random', 'random', 'ramTrack', 'ramLane', 'endUp', 'endDown', 'reverse', 'garage']);
    const r = runs[0];
    // start: a sample along the complex, a lateral offset, a heading, a speed
    let k, dd, hd, v;
    const tan = i => Math.atan2(S[i].tx, S[i].tz);
    if (kind === 'ramTrack' || kind === 'ramLane') {
      k = r.k0 + Math.floor(rnd() * (r.k1 - r.k0 + 1)); const i = wq(pit.from + k);
      const fromLane = kind === 'ramLane';
      dd = r.wD + (fromLane ? sg : -sg) * (lim + 2 + rnd() * 5);
      const ang = (5 + rnd() * 85) * Math.PI / 180;          // into the wall at this angle
      hd = tan(i) + (fromLane ? -sg : sg) * ang;             // turning towards +n = increasing heading... (+n is the driver's left)
      v = 15 + rnd() * 115;
    } else if (kind === 'endUp' || kind === 'endDown') {
      const up = kind === 'endUp';
      k = up ? r.k0 - 3 - Math.floor(rnd() * 25) : r.k1 + 3 + Math.floor(rnd() * 25);
      const i = wq(pit.from + k);
      dd = r.wD + (rnd() - 0.5) * 2 * lim;                   // in line with the wall
      hd = tan(i) + (up ? 0 : Math.PI) + (rnd() - 0.5) * 0.6;
      v = 10 + rnd() * 120;
    } else if (kind === 'reverse') {
      k = r.k0 + Math.floor(rnd() * (r.k1 - r.k0 + 1)); const i = wq(pit.from + k);
      const fromLane = rnd() < 0.5;
      dd = r.wD + (fromLane ? sg : -sg) * (lim + 1 + rnd() * 3);
      hd = tan(i) + (fromLane ? sg : -sg) * (0.2 + rnd() * 1.3);   // nose pointing away: reversing goes into the wall
      v = -(3 + rnd() * 8);
    } else if (kind === 'garage') {
      k = Math.floor(rnd() * (K + 1)); const i = wq(pit.from + k);
      dd = (typeof pit.laneD(i) === 'number' && Number.isFinite(pit.laneD(i))) ? pit.laneD(i) : sg * 10;
      hd = tan(i) + sg * (0.3 + rnd() * 1.2);
      v = 10 + rnd() * 70;
    } else {
      k = -40 + Math.floor(rnd() * (K + 80)); const i = wq(pit.from + k);
      const wdOut = sg > 0 ? S[i].wallPosDist : S[i].wallNegDist, wdIn = sg > 0 ? S[i].wallNegDist : S[i].wallPosDist;
      dd = sg * (-(wdIn - 1.2) + rnd() * (wdOut - 1.2 + wdIn - 1.2));
      hd = rnd() * 2 * Math.PI;
      v = (rnd() < 0.15 ? -8 : 0) + rnd() * 130;
    }
    const i0 = wq(pit.from + k), s0 = S[i0];
    car.reset(track, i0);
    st.x = s0.x + s0.nx * dd; st.z = s0.z + s0.nz * dd; st.heading = hd;
    // not placed inside the pit wall / beyond the outer walls (main.js never does that)
    let f = frame(st.x, st.z);
    const wdF = (f.d > 0 ? S[f.i].wallPosDist : S[f.i].wallNegDist);
    if (Math.abs(f.d) > wdF - 1.05) continue;
    if (f.run && f.sa > -1.2 && f.sa < f.run.len + 1.2 && Math.abs(f.rel) < lim + 0.05) continue;
    car.update(1e-4, null, track); st.speed = v;           // located there (as main.js's placeOnGrid does)
    car.setBattery(1);

    const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null, boost: false, limiter: false };
    const T = 4 + rnd() * 6;
    let t = 0, hold = 0, prev = frame(st.x, st.z), staleT = 0;
    const targeted = kind !== 'random';
    while (t < T) {
      if (hold <= 0) {
        hold = 0.1 + rnd() * 1.4;
        if (targeted && t < 1.5) { input.up = kind !== 'reverse'; input.down = kind === 'reverse'; input.left = input.right = false; input.steerAxis = null; input.throttle = input.brake = null; }
        else {
          const m = rnd();
          input.up = m < 0.55; input.down = m > 0.8;
          input.throttle = rnd() < 0.3 ? rnd() : null; input.brake = rnd() < 0.15 ? rnd() : null;
          if (rnd() < 0.5) { input.steerAxis = rnd() * 2 - 1; input.left = input.right = false; }
          else { input.steerAxis = null; const q = rnd(); input.left = q < 0.35; input.right = q > 0.65; }
          input.boost = rnd() < 0.3; input.limiter = rnd() < 0.15;
        }
      }
      const dt = rnd() < 0.5 ? pick([1 / 60, 1 / 30, 0.1, 0.1]) : STEP;
      car.update(dt, input, track); t += dt; hold -= dt; seen.steps++;
      if (!Number.isFinite(st.x + st.z + st.y + st.speed + st.heading + st.pitch + st.roll + st.battery + st.rpm)) { note('nan', { kind, run }); break; }
      const c = frame(st.x, st.z);
      if (st.hit > 0) {
        if (c.run && c.sa > -3 && c.sa < c.run.len + 3 && Math.abs(c.rel) <= lim + 0.2) {
          seen.pitWallHits++;
          if (c.sa < 0.5 || c.sa > c.run.len - 0.5) seen.endHits++;
          else if (c.rel * sg > 0) seen.laneSideHits++; else seen.trackSideHits++;
        } else seen.outerHits++;
      }
      // wall: never inside the pit wall grown by the car (beside it and 0.9 m beyond its ends)
      if (c.run && c.sa >= -0.9 && c.sa <= c.run.len + 0.9 && Math.abs(c.rel) < lim - 0.02) note('wall', { kind, run, k: c.k, sa: +c.sa.toFixed(2), rel: +c.rel.toFixed(3), v: +st.speed.toFixed(1) });
      // cross: beside the wall at both steps, on the same side
      if (c.run && prev.run === c.run && c.sa > 0 && c.sa < c.run.len && prev.sa > 0 && prev.sa < c.run.len && Math.sign(c.rel) !== Math.sign(prev.rel))
        note('cross', { kind, run, k: c.k, sa: +c.sa.toFixed(2), rel: +c.rel.toFixed(3), prevRel: +prev.rel.toFixed(3) });
      // outer walls / garage face
      const s = S[c.i], flag = c.d > 0 ? s.wallPos : s.wallNeg, wd = c.d > 0 ? s.wallPosDist : s.wallNegDist;
      const so = S[st.sampleIndex], flagO = st.d > 0 ? so.wallPos : so.wallNeg, wdO = st.d > 0 ? so.wallPosDist : so.wallNegDist;
      if ((flagO && Math.abs(st.d) > wdO - 1 + 0.02) || (flag && Math.abs(c.d) > wd - 1 + 0.5))
        note('outer', { kind, run, k: c.k, d: +c.d.toFixed(2), wd: +wd.toFixed(2), own: st.sampleIndex, ownD: +st.d.toFixed(2), ownWd: +wdO.toFixed(2) });
      // stale sample
      const own = S[st.sampleIndex], dOwn = Math.hypot(st.x - own.x, st.z - own.z), dTrue = Math.hypot(st.x - s.x, st.z - s.z);
      staleT = dOwn - dTrue > 3 ? staleT + dt : 0;
      if (staleT > 1) { note('stale', { kind, run, own: st.sampleIndex, near: c.i }); staleT = 0; }
      prev = c;
    }
  }
  for (const key in tot) tot[key] += fails[key];
  const bad = Object.keys(fails).filter(key => fails[key]).map(key => key + ' ' + fails[key]).join(', ');
  console.log((bad ? 'FAIL ' : 'ok   ') + td.id.padEnd(9) + (bad ? ' ' + bad : ''));
  for (const e of ex) console.log('       ' + JSON.stringify(e));
  track.dispose();
}
console.log('exercised: ' + JSON.stringify(seen) + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
console.log('TOTAL ' + JSON.stringify(tot));
process.exit(Object.keys(tot).some(key => tot[key]) ? 1 : 0);
