// node devtests/seasons-calib/check-drive.js [--tracks id,id,...] [--years 2010,2014] [--teams] [--json out.json]
//
// INDEPENDENT check of the seasons physics (not the builder's calibration code): its own analog autopilot drives
// the REAL js/car.js (tyres off = a new medium set, no boost, no limiter) on the racing line built for each car
// (F1.buildRaceLine(track, car.perf)), with the CarSpecs js/cars.js gives from js/seasons-data.js.
//   - pedals: analog; the wanted acceleration comes from the line's own speed profile (points[i].speed) a short
//     distance ahead, turned into throttle / brake with the car's own limits (car.perf) - not the line's colour levels
//   - steering: analog stick (input.steerAxis), pure pursuit on the line + the line's curvature as feed-forward
//   - 3 laps from a standing start at sample 0; flying lap = the better of laps 2 and 3, timed inside the step
// Default: every season's standard car on 4 circuits (Sepang, COTA, Jeddah, Zandvoort: chosen on 2026-10-01 because
// none was among the builder's then 12 calibration circuits; the calibration now uses all 40); ratio = flying lap / the
// 2025 standard car's (= F1.REF_SPEC) on the same circuit, compared with the era pace index of tools/seasons-raw.json.
// --tracks a,b,c other circuits (tracks-data.js ids); --teams also drives every team car of the chosen years;
// --years 2014,2026 only these seasons; --json file writes the results. About 3 s (4 circuits), 30 s (all 40).
// Result on 2026-10-01 after the fix: every season within 0.48 % on the 4 circuits, within 0.16 % over all 40.
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js', 'seasons-data.js'));
require(path.join(ROOT, 'js', 'cars.js'));
require(path.join(ROOT, 'js', 'track.js'));
require(path.join(ROOT, 'js', 'car.js'));
require(path.join(ROOT, 'js', 'raceline.js'));
const F1 = global.F1;
const RAW = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'seasons-raw.json'), 'utf8'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const TRACKS = arg('--tracks', 'my-1999,us-2012,sa-2021,nl-1948').split(',');
const YEARS = arg('--years', '').split(',').filter(Boolean).map(Number);
const TEAMS = process.argv.includes('--teams');
const JSON_OUT = arg('--json', '');
const HZ = 120, LAPS = 3, KMH = 3.6;

function drive(track, spec) {
  const car = F1.createCar(spec, { tyres: false });
  const line = F1.buildRaceLine(track, car.perf);
  const K = car.perf, S = track.samples, N = S.length, ds = track.length / N, P = line.points, st = car.state;
  car.reset(track, 0);
  const dt = 1 / HZ;
  const input = { up: false, down: false, left: false, right: false, throttle: 0, brake: 0, steerAxis: 0, boost: false, limiter: false };
  let time = 0, lapStart = 0, prevIdx = st.sampleIndex, grass = 0, hits = 0, vmax = 0;
  const laps = [];
  while (laps.length < LAPS && time < 900) {
    const v = Math.max(0, st.speed), i0 = st.sampleIndex;
    // ---- pedals: wanted acceleration to meet the profile speed over the look-ahead
    const look = Math.max(4, 0.12 * v);
    const n = Math.max(1, Math.round(look / ds));
    let vt = Infinity, dist = 0, dAt = look;
    for (let m = 1; m <= n; m++) {
      const p = P[(i0 + m) % N];
      dist += ds;
      // the tightest requirement inside the look-ahead window
      const need = (p.speed * p.speed - v * v) / (2 * dist);
      if (vt === Infinity || need < (vt * vt - v * v) / (2 * dAt)) { vt = p.speed; dAt = dist; }
    }
    const aWant = (vt * vt - v * v) / (2 * dAt);
    const pitch = st.pitch, sinP = Math.sin(pitch);
    const coast = K.roll + K.dragK * v * v + K.gravity * sinP;             // deceleration with no pedal
    const an = K.normalAccel(v, 0, pitch, 0, 0);
    const driveMax = Math.min(K.traction, K.muTraction * an, K.power / Math.max(v, 1));
    const brakeMax = K.muBrake * an + K.brakeDrag * v * v;
    let thr = 0, brk = 0;
    if (v < 3) thr = 1;
    else if (aWant + coast > 0) thr = Math.min(1, (aWant + coast) / driveMax + (vt - v > 0.4 ? 1 : 0));
    else brk = Math.min(1, -(aWant + coast) / brakeMax * 1.1);
    input.throttle = thr; input.brake = brk;
    // ---- steering: pure pursuit on the line, analog
    const Ld = Math.min(28, Math.max(6, 3 + 0.22 * v));
    const tp = P[(i0 + Math.max(1, Math.round(Ld / ds))) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const lat = dx * ch - dz * sh, d2 = dx * dx + dz * dz;
    const kap = 2 * lat / Math.max(d2, 1);
    const lock = K.steerLock / (1 + (v / K.steerSpeedRef) * (v / K.steerSpeedRef));
    input.steerAxis = Math.max(-1, Math.min(1, Math.atan(kap * K.wheelbase) / lock));
    car.update(dt, input, track);
    time += dt;
    if (laps.length >= 1) { if (st.onGrass) grass++; if (st.hit > 0) hits++; if (st.speed > vmax) vmax = st.speed; }
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prevIdx = st.sampleIndex;
  }
  const out = { laps, flying: laps.length >= 2 ? Math.min(...laps.slice(1)) : NaN, pred: line.lapTime, grass, hits, vmaxKmh: vmax * KMH,
    topKmh: K.topSpeed * KMH };
  line.dispose();
  return out;
}

const median = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
const pct = x => (x >= 0 ? '+' : '') + (100 * x).toFixed(2) + '%';

const t0 = Date.now();
const tracks = TRACKS.map(id => {
  const td = global.F1_TRACKS.find(t => t.id === id);
  if (!td) throw new Error('no track ' + id);
  return { id, name: td.name, track: F1.buildTrack(td) };
});
const ref = F1.cars.get('2025-standard');
if (JSON.stringify(ref) !== JSON.stringify(F1.REF_SPEC)) console.log('WARNING 2025-standard differs from F1.REF_SPEC');
const refRuns = tracks.map(t => drive(t.track, F1.REF_SPEC));
console.log('2025 standard (F1.REF_SPEC): ' + tracks.map((t, i) => t.id + ' ' + refRuns[i].flying.toFixed(3) + ' s (line ' + refRuns[i].pred.toFixed(3) + ', ' + refRuns[i].laps.map(x => x.toFixed(2)).join('/') + ')' +
  (refRuns[i].grass || refRuns[i].hits ? ' OFF' : '')).join('  '));
const years = YEARS.length ? YEARS : F1.cars.seasons.map(s => s.year);
const result = { tracks: TRACKS, ref: refRuns.map(r => ({ flying: r.flying, pred: r.pred })), seasons: [] };
console.log('\nyear  index   driven(median)  err      line(median)  err     per track driven ratio                     top km/h  off');
for (const y of years) {
  const idx = RAW.seasons.find(s => s.year === y).eraIndex;
  const specs = TEAMS ? F1.cars.list(y) : [F1.cars.get(y + '-standard')];
  const rows = [];
  for (const spec of specs) {
    const runs = tracks.map(t => drive(t.track, spec));
    const ratios = runs.map((r, i) => r.flying / refRuns[i].flying);
    const lratios = runs.map((r, i) => r.pred / refRuns[i].pred);
    const off = runs.reduce((a, r) => a + (r.grass || r.hits || !(r.flying > 0) ? 1 : 0), 0);
    rows.push({ id: spec.id, ratios, lratios, median: median(ratios), lmedian: median(lratios), off, top: runs[0].topKmh, flying: runs.map(r => r.flying) });
  }
  const std = rows[0];
  console.log(String(y).padEnd(6) + idx.toFixed(4) + '   ' + std.median.toFixed(4) + '          ' + pct(std.median / idx - 1).padEnd(8) + ' ' + std.lmedian.toFixed(4) + '        ' +
    pct(std.lmedian / idx - 1).padEnd(8) + std.ratios.map(r => r.toFixed(4)).join(' ') + '   ' + std.top.toFixed(1) + '    ' + std.off);
  if (TEAMS) {
    for (const r of rows.slice(1)) {
      console.log('      ' + r.id.padEnd(24) + ' vs std ' + pct(r.median / std.median - 1).padStart(7) + '  mean ' + pct(r.ratios.reduce((a, x, i) => a + x / std.ratios[i], 0) / r.ratios.length - 1).padStart(7) +
        '  top ' + r.top.toFixed(1) + (r.off ? '  OFF ' + r.off : ''));
    }
  }
  result.seasons.push({ year: y, index: idx, rows });
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 1));
console.log('\n(' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
