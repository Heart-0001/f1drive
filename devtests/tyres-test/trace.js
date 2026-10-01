// node devtests/tyres-test/trace.js [life|temps|export|all] [track regex] [--keys] [--slipgain=2]
//
// Load traces of the REAL reference car for the tyre model (js/tyres.js), and what the model makes of them.
// car.js does not feed the tyres yet (and must not change the reference car), so the car driven here is the v5 car,
// devtests/tyres-test/car-v5.js (a copy of js/car.js taken before the v6 edits: the golden-rule car), stepped at
// 1/120 s with the end-to-end autopilot (devtests/gp-e2e/autopilot.js, racing line at pace 1, controller 60 Hz), or with
// --keys the keyboard pure pursuit of devtests/raceline-test/test.js (bang-bang keys: every brake / throttle is 100 %).
// Every step the load of the contract is derived from the car's state and F1.CAR_PERF exactly as car.js computes
// its limits:
//   lat    requested centripetal accel (bicycle model from steer and speed) / maxLatAccel; share capped at 1
//   slip   (requested / available - 1) * slipgain, 0..1, measured from the yaw rate the car really got (the only
//          exact way to see car.js's grip cap from outside); default slipgain 2 (1 at 50 % overshoot)
//   brake  the brake pedal (car.js brakes with pedal * the braking limit)
//   drive  throttle * (1 - brake) * min(traction, power / v) / traction
//   onGrass, hit: the car's own
// The second flying lap of each track is kept (in memory) and replayed through js/tyres.js:
//   life    laps until the most worn tyre reaches 100 % (and 75 %) for S / M / H at wear rate 1, per track, and the
//           distance-weighted average normalised to a 5 km lap (the calibration target: medium ~15 laps at rate 1)
//   temps   peak temperature / lowest grip of a set during 3 laps of hard racing (must stay in the window: grip 1)
//   export  writes out/lap-<id>.js: the lap as key points (simplified, linear in between) for test/tyres.test.js
//           and replays them at 1/120 s against the full trace
'use strict';
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(__dirname, 'car-v5.js'));
require(path.join(ROOT, 'js/raceline.js'));
const createLapCounter = require(path.join(ROOT, 'js/laps.js'));
const createAutopilot = require(path.join(ROOT, 'devtests/gp-e2e/autopilot.js'));
const T = require(path.join(ROOT, 'js/tyres.js'));
const F1 = global.F1, CP = F1.CAR_PERF;

const STEP = 1 / 120;
const args = process.argv.slice(2);
const mode = args.find(a => /^(life|temps|export|modes|all)$/.test(a)) || 'life';
const filt = args.find(a => !/^(life|temps|export|modes|all)$/.test(a) && !/^--/.test(a));
const KEYS = args.includes('--keys');
const SLIPGAIN = +((args.find(a => /^--slipgain=/.test(a)) || '=2').split('=')[1]);
const OUT = path.join(__dirname, 'out');
const fmt = t => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');

function pedal(key, analog) { const k = key ? 1 : 0; if (typeof analog !== 'number' || !(analog > k)) return k; return analog < 1 ? analog : 1; }

// Drive one track: out lap from 10 samples before the line, 2 timed laps; -> the second one as a load trace.
function record(td) {
  const track = F1.buildTrack(td), line = F1.buildRaceLine(track), car = F1.createCar();
  const S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  car.reset(track, N - 10);
  const lap = createLapCounter(N, st.sampleIndex);
  const ap = createAutopilot(); ap.cfg.mode = 'line'; ap.cfg.scale = 1;
  const input = { up: false, down: false, left: false, right: false, throttle: null, brake: null, steerAxis: null };
  const rows = []; let t = 0, n = 0, laps = [], grassSteps = 0, hitSteps = 0, capped = 0;
  while (laps.length < 2 && t < 600) {
    if (n++ % 2 === 0) {                                 // 60 Hz controller
      if (KEYS) {
        const v = Math.max(0, st.speed); line.update(st);
        const lv = line.levels[2];
        input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
        const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
        const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
        const la = dx * ch - dz * sh, d2 = dx * dx + dz * dz, lock = 0.35 / (1 + (v / 22) * (v / 22));
        const want = Math.max(-1, Math.min(1, Math.atan(2 * la / d2 * 3.6) / lock));
        input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
      } else {
        const o = ap.step({ t, st, track, line, locked: false, others: [] });
        input.throttle = o.throttle > 0 ? o.throttle : null;
        input.brake = o.brake > 0 ? o.brake : null;
        input.steerAxis = o.steer !== 0 ? o.steer : null;
      }
    }
    const h0 = st.heading, v0 = st.speed, av0 = Math.abs(v0);   // car.js turns with the speed at the start of the step
    car.update(STEP, input, track);
    t += STEP;
    // ---- the load, as car.js sees it
    const v = st.speed, av = Math.abs(v), thr = pedal(input.up, input.throttle), brk = pedal(input.down, input.brake);
    const ratio = av0 / CP.steerSpeedRef, delta = st.steer * CP.steerLock / (1 + ratio * ratio);
    const aReq = v0 * v0 * Math.tan(delta) / CP.wheelbase;
    let dh = st.heading - h0; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    const aGot = v0 * dh / STEP;
    let latMax = CP.maxLatAccel(v0, st.roll, st.pitch, 0, aReq >= 0 ? 1 : -1);
    if (st.onGrass) latMax *= 0.45;
    let share = latMax > 0 ? Math.min(1, Math.abs(aReq) / latMax) : 0, over = 0;
    if (st.hit === 0 && av0 > 3 && Math.abs(aReq) > 1 && Math.abs(aGot) < Math.abs(aReq) * 0.9995 && Math.sign(aGot) === Math.sign(aReq)) {
      over = Math.abs(aReq) / Math.max(Math.abs(aGot), 1e-6) - 1; share = 1; capped++;
    }
    const an = CP.normalAccel(v0, st.roll, st.pitch, 0, aGot);
    const trac = st.onGrass ? Math.min(5.6, 5.6 / 9.81 * an) : Math.min(CP.traction, CP.muTraction * an);
    let drive = 0, brake = 0;
    if (v > 0.5) { brake = brk; drive = thr * (1 - brk) * Math.min(trac, CP.power / Math.max(av, 1)) / trac; }
    else if (v >= -0.5 && thr > 0 && thr >= brk) drive = thr;
    if (st.onGrass) grassSteps++;
    if (st.hit > 0) hitSteps++;
    const c = lap.update(st.sampleIndex, st.speed, STEP);
    if (c === 2) laps.push(lap.last);
    if (laps.length === 1) rows.push([av, Math.sign(aReq) * share, brake, drive, Math.min(1, over * SLIPGAIN), st.onGrass ? 1 : 0, st.hit, over]);
  }
  track.dispose(); line.dispose();
  return { id: td.id, name: td.name, km: td.lengthKm, len: track.length, laps, rows, grassSteps, hitSteps, capped, pred: line.lapTime };
}

// Replay a trace through a tyre set until `stop(ty, lapsDone)` -> number of laps (fractional).
function replay(tr, compound, rate, maxLaps, onStep) {
  let k = 0; const R = tr.rows, ty = T.createTyres({ random: seeded(1) });
  ty.fit(compound); ty.setWearRate(rate);
  const load = { speed: 0, lat: 0, brake: 0, drive: 0, slip: 0, onGrass: false, hit: 0 };
  for (let lapN = 0; lapN < maxLaps; lapN++) {
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      load.speed = r[0]; load.lat = r[1]; load.brake = r[2]; load.drive = r[3]; load.slip = r[4]; load.onGrass = r[5] === 1; load.hit = r[6];
      ty.update(STEP, load);
      k++;
      if (onStep && onStep(ty, lapN + i / R.length)) return lapN + i / R.length;
    }
  }
  return maxLaps;
}
function seeded(s) { return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function stats(tr) {
  const R = tr.rows; let lat9 = 0, brk = 0, drv = 0, slip = 0, slipMax = 0, overMax = 0, left = 0, right = 0;
  for (const r of R) { if (Math.abs(r[1]) > 0.9) lat9++; if (r[1] > 0.3) left++; if (r[1] < -0.3) right++; if (r[2] > 0.05) brk++; if (r[3] > 0.9) drv++; if (r[4] > 0) slip++; slipMax = Math.max(slipMax, r[4]); overMax = Math.max(overMax, r[7]); }
  const f = x => (100 * x / R.length).toFixed(0).padStart(3) + '%';
  return 'lat>0.9 ' + f(lat9) + ' L ' + f(left) + ' R ' + f(right) + ' brake ' + f(brk) + ' full drive ' + f(drv) + ' slip ' + f(slip) + ' max slip ' + slipMax.toFixed(2) + ' (overshoot ' + (overMax * 100).toFixed(1) + '%)';
}

const traces = [];
const t0 = Date.now();
for (const td of global.F1_TRACKS) {
  if (filt && !new RegExp(filt, 'i').test(td.id + ' ' + td.name)) continue;
  const tr = record(td);
  traces.push(tr);
  console.log(td.id.padEnd(8), td.name.slice(0, 34).padEnd(34), (tr.len / 1000).toFixed(2), 'km  laps', tr.laps.map(fmt).join(' '), '(line ' + fmt(tr.pred) + ')',
    ' grass', tr.grassSteps, 'hit', tr.hitSteps, ' ', stats(tr));
}
console.log('recorded', traces.length, 'tracks in', ((Date.now() - t0) / 1000).toFixed(1), 's', KEYS ? '(keys)' : '(autopilot)', 'slipgain', SLIPGAIN);

if (mode === 'modes' || mode === 'all') {
  // the work per lap by way of loading (js/tyres.js formulas, before the per-wheel split), in % of the lap's total
  console.log('\nwork per lap: cornering / braking / traction / rolling (% of the total), total');
  for (const tr of traces) {
    let wl = 0, wb = 0, wd = 0, wr = 0;
    for (const r of tr.rows) {
      const v = r[0], ul = Math.abs(r[1]), surf = r[5] ? 0.45 : 1;
      const aLat = Math.min(44, 20 + 0.0045 * v * v), aBrk = 12 + 0.0032 * v * v, aF = 11 / 9.81 * (9.81 + 0.0045 / (20 / 9.81) * v * v);
      const ud = aF > 11 ? r[3] * 11 / aF : r[3];
      wl += ul * ul * aLat * v * surf; wb += r[2] * r[2] * aBrk * v * surf; wd += ud * ud * aF * v * surf; wr += 4 * v;
    }
    const tot = wl + wb + wd + wr, p = x => (100 * x / tot).toFixed(0).padStart(3);
    console.log(tr.id.padEnd(8), p(wl), p(wb), p(wd), p(wr), (tot * STEP / 1e6).toFixed(2) + 'e6');
  }
}

if (mode === 'life' || mode === 'all') {
  console.log('\nlaps until the most worn tyre reaches 100 % (75 %) at wear rate 1; which tyre; 5 km-equivalent laps (M)');
  const W = ['FL', 'FR', 'RL', 'RR'];
  let sumKm = 0, sumW = 0; const perKm = [];
  for (const tr of traces) {
    const res = {};
    for (const c of ['S', 'M', 'H']) {
      let l75 = null, worst = -1;
      const l100 = replay(tr, c, 1, 200, (ty, x) => {
        const w = ty.state.wear, m = Math.max(...w);
        if (l75 === null && m >= 0.75) l75 = x;
        if (m >= 1) { worst = w.indexOf(m); return true; }
      });
      res[c] = { l100, l75, worst };
    }
    const kmLife = res.M.l100 * tr.len / 1000;
    perKm.push(kmLife); sumKm += kmLife;
    // the wear distribution after one lap (medium, rate 1)
    const ty = T.createTyres({ random: seeded(2) }); ty.fit('M');
    const load = {};
    for (const r of tr.rows) { load.speed = r[0]; load.lat = r[1]; load.brake = r[2]; load.drive = r[3]; load.slip = r[4]; load.onGrass = r[5] === 1; load.hit = r[6]; ty.update(STEP, load); }
    const w = ty.state.wear, mx = Math.max(...w);
    console.log(tr.id.padEnd(8), tr.name.slice(0, 30).padEnd(30), (tr.len / 1000).toFixed(2), 'km',
      ['S', 'M', 'H'].map(c => c + ' ' + res[c].l100.toFixed(1).padStart(5) + ' (' + (res[c].l75 || 0).toFixed(1).padStart(5) + ') ' + (W[res[c].worst] || '--')).join('   '),
      '  5km-eq', (kmLife / 5).toFixed(1).padStart(5), '  lap-1 wear %', w.map(x => (x * 100).toFixed(2)).join(' '), ' rel', w.map(x => (x / mx).toFixed(2)).join(' '));
  }
  perKm.sort((a, b) => a - b);
  console.log('medium life, rate 1: mean', (sumKm / traces.length).toFixed(1), 'km = ', (sumKm / traces.length / 5).toFixed(1), 'laps of 5 km; median',
    (perKm[perKm.length >> 1] / 5).toFixed(1), 'min', (perKm[0] / 5).toFixed(1), 'max', (perKm[perKm.length - 1] / 5).toFixed(1));
}

if (mode === 'temps' || mode === 'all') {
  console.log('\n3 laps of hard racing from a new set, wear rate 1: peak temperature, lowest grip multipliers, flat spots, vib');
  for (const tr of traces) {
    const line = [];
    for (const c of ['S', 'M', 'H']) {
      let tMax = 0, gl = 9, gb = 9, gt = 9, vib = 0, fl = 0;
      replay(tr, c, 1, 3, ty => {
        const s = ty.state; tMax = Math.max(tMax, ...s.temp); gl = Math.min(gl, s.grip.lat); gb = Math.min(gb, s.grip.brake); gt = Math.min(gt, s.grip.traction);
        vib = Math.max(vib, s.vib); fl = Math.max(fl, ...s.flat);
      });
      const hot = T.COMPOUNDS[c].hot;
      line.push(c + ' Tmax ' + tMax.toFixed(1) + (tMax > hot ? '!' : ' ') + ' grip ' + [gl, gb, gt].map(x => x.toFixed(4)).join('/') + ' flat ' + fl.toFixed(3) + ' vib ' + vib.toFixed(2));
    }
    console.log(tr.id.padEnd(8), line.join('  |  '));
  }
}

if (mode === 'export' || mode === 'all') {
  // The lap as key points for test/tyres.test.js: the 120 Hz rows simplified (Ramer-Douglas-Peucker over all channels
  // at once: linear interpolation between the kept points stays within TOL of every row), slip / grass / hit left out
  // (zero in clean racing). Flat list [step, speed, lat, brake, drive, ...], step in 1/120 s from the start of the lap.
  const TOL = [1.0, 0.08, 0.08, 0.08];          // m/s, shares
  fs.mkdirSync(OUT, { recursive: true });
  for (const tr of traces) {
    const R = tr.rows, n = R.length, keep = new Uint8Array(n), stack = [[0, n - 1]];
    keep[0] = keep[n - 1] = 1;
    while (stack.length) {
      const [a, b] = stack.pop();
      let worst = 1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const f = (i - a) / (b - a);
        for (let c = 0; c < 4; c++) {
          const e = Math.abs(R[a][c] + (R[b][c] - R[a][c]) * f - R[i][c]) / TOL[c];
          if (e > worst) { worst = e; wi = i; }
        }
      }
      if (wi >= 0) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
    }
    const flat = [];
    for (let i = 0; i < n; i++) if (keep[i]) flat.push(i, +R[i][0].toFixed(1), +R[i][1].toFixed(3), +R[i][2].toFixed(3), +R[i][3].toFixed(3));
    const text = 'const LAP = { id: ' + JSON.stringify(tr.id) + ', len: ' + Math.round(tr.len) + ', steps: ' + n + ', time: ' + tr.laps[1].toFixed(3) + ', k: [\n' +
      flat.join(',').replace(/((?:[^,]*,){60})/g, '$1\n') + '\n] };\n';
    const file = path.join(OUT, 'lap-' + tr.id + '.js');
    fs.writeFileSync(file, text);
    // replay the key points at 1/120 s (as the test does) against the full trace: medium, rate 1, laps to 100 %
    const full = replay(tr, 'M', 1, 200, ty => Math.max(...ty.state.wear) >= 1);
    const ty = T.createTyres({ random: seeded(1) }); ty.fit('M');
    const load = { slip: 0, onGrass: false, hit: 0 }; let laps = 0, j = 0;
    outer: for (; laps < 200; laps++) {
      j = 0;
      for (let i = 0; i < n; i++) {
        while (flat[(j + 1) * 5] <= i && (j + 1) * 5 < flat.length - 5) j++;
        const a = j * 5, b = a + 5, f = (i - flat[a]) / (flat[b] - flat[a]);
        load.speed = flat[a + 1] + (flat[b + 1] - flat[a + 1]) * f; load.lat = flat[a + 2] + (flat[b + 2] - flat[a + 2]) * f;
        load.brake = flat[a + 3] + (flat[b + 3] - flat[a + 3]) * f; load.drive = flat[a + 4] + (flat[b + 4] - flat[a + 4]) * f;
        ty.update(STEP, load);
        if (Math.max(...ty.state.wear) >= 1) { laps += i / n; break outer; }
      }
    }
    console.log('export', tr.id, flat.length / 5, 'key points of', n, (text.length / 1024).toFixed(1), 'KB  medium life 120 Hz', full.toFixed(2), 'laps, key points', laps.toFixed(2));
  }
}
