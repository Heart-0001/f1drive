// v6.2 critic (node): do the real banked corners make the car faster? The racing line's corner speed (js/raceline.js with
// the car's own perf: grip on the banking and the bank-aware steering lock of js/car.js) through Zandvoort T3 / T14 and
// Madring's La Monumental, built as they are (trackData.bankOverrides) and built flat there (that override taken out:
// the curvature-derived bank, capped at 2.5 deg, remains), for the 2025 reference car and the 2026 standard car.
// Then the real car (js/car.js) driven through each corner (an analog pursuit of the line at the line's speed): the
// minimum and the mean speed through the section. Exit code 1 when a banked corner is not faster than flat.
//   node devtests/v62-critic/bank-ab.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
require(path.join(ROOT, 'js', 'tyres.js'));
require(path.join(ROOT, 'js', 'car.js'));
require(path.join(ROOT, 'js', 'raceline.js'));
require(path.join(ROOT, 'js', 'seasons-data.js'));
require(path.join(ROOT, 'js', 'cars.js'));
const F1 = global.F1;

const CORNERS = [
  { id: 'nl-1948', name: 'T3 Hugenholtzbocht', a: 420, b: 505 },
  { id: 'nl-1948', name: 'T14 Arie Luyendijkbocht', a: 1850, b: 1995 },
  { id: 'es-2026', name: 'T12 La Monumental', a: 1115, b: 1375 }
];
const CARS = [['2025-standard', 2025], ['2026-standard', 2026]];

function lineMin(track, perf, a, b) {
  const rl = F1.buildRaceLine(track, perf), P = rl.points, N = P.length;
  let mn = 1e9, sum = 0, n = 0;
  for (let i = a; i <= b; i++) { mn = Math.min(mn, P[i % N].speed); sum += P[i % N].speed; n++; }
  rl.dispose && rl.dispose();
  return { min: mn * 3.6, mean: sum / n * 3.6 };
}
// the real car through the corner: pure pursuit on the line, throttle / brake to the line's speed
function drive(track, spec, a, b) {
  const car = F1.createCar(spec, { tyres: false });
  const rl = F1.buildRaceLine(track, car.perf), P = rl.points, S = track.samples, N = S.length, ds = track.length / N;
  const start = (a - 150 + N) % N;
  car.reset(track, start);
  car.state.speed = P[start].speed;
  let mn = 1e9, hits = 0, grass = 0, steps = 0, sum = 0, n = 0;
  const input = { up: false, down: false, left: false, right: false, throttle: 0, brake: 0, steerAxis: 0 };
  while (steps++ < 120 * 30) {
    const st = car.state, i = st.sampleIndex, v = Math.max(0, st.speed);
    const k = ((i - start) % N + N) % N;
    if (k > ((b + 30 - start) % N + N) % N) break;
    const la = Math.min(30, Math.max(8, 5 + 0.3 * v)), j = (i + Math.round(la / ds)) % N;
    const dx = P[j].x - st.x, dz = P[j].z - st.z, lat = dx * Math.cos(st.heading) - dz * Math.sin(st.heading), d2 = dx * dx + dz * dz;
    const kap = 2 * lat / d2, lock = car.perf.steerLockAt(v, S[i].bank || 0, kap >= 0 ? 1 : -1);
    input.steerAxis = Math.max(-1, Math.min(1, Math.atan(kap * car.perf.wheelbase) / lock));
    const vt = P[(i + 3) % N].speed;
    input.throttle = v < vt - 0.3 ? 1 : (v < vt ? 0.3 : 0); input.brake = v > vt + 1 ? Math.min(1, (v - vt) / 4) : 0;
    car.update(1 / 120, input, track);
    const kk = ((car.state.sampleIndex - a) % N + N) % N;
    if (kk <= ((b - a) % N + N) % N) { mn = Math.min(mn, car.state.speed); sum += car.state.speed; n++; }
    if (car.state.hit > 0) hits++;
    if (car.state.onGrass) grass++;
  }
  return { min: mn * 3.6, mean: sum / Math.max(1, n) * 3.6, hits, grass };
}

const rows = [];
for (const c of CORNERS) {
  const td = F1_TRACKS.find(t => t.id === c.id);
  const flatTd = Object.assign({}, td, { bankOverrides: (td.bankOverrides || []).filter(o => o.name.indexOf(c.name.split(' ')[0] + ' ') !== 0 && o.name !== c.name) });
  const removed = (td.bankOverrides || []).filter(o => flatTd.bankOverrides.indexOf(o) < 0).map(o => o.name + ' ' + o.deg + ' deg');
  const tBank = F1.buildTrack(td, {}), tFlat = F1.buildTrack(flatTd, {});
  let maxBank = 0, maxFlat = 0;
  for (let i = c.a; i <= c.b; i++) { maxBank = Math.max(maxBank, Math.abs(tBank.samples[i].bank || 0)); maxFlat = Math.max(maxFlat, Math.abs(tFlat.samples[i].bank || 0)); }
  for (const [id, year] of CARS) {
    const spec = F1.cars.resolve(id, year), perf = F1.carPerf(spec);
    const lb = lineMin(tBank, perf, c.a, c.b), lf = lineMin(tFlat, perf, c.a, c.b);
    const db = drive(tBank, spec, c.a, c.b), df = drive(tFlat, spec, c.a, c.b);
    rows.push({ corner: c.id + ' ' + c.name, car: id, bankDeg: +(maxBank * 180 / Math.PI).toFixed(1), flatDeg: +(maxFlat * 180 / Math.PI).toFixed(1), removed: removed.join(', '),
      lineBanked: +lb.min.toFixed(1), lineFlat: +lf.min.toFixed(1), gainLine: +(lb.mean - lf.mean).toFixed(1),
      drivenBanked: +db.min.toFixed(1), drivenFlat: +df.min.toFixed(1), drivenMeanB: +db.mean.toFixed(1), drivenMeanF: +df.mean.toFixed(1),
      hits: [db.hits, df.hits], grass: [db.grass, df.grass] });
  }
}
// (min: the slowest point of the section, which for T14 is its entry from T13; mean: the average speed through it)
console.table(rows.map(r => ({ corner: r.corner, car: r.car, bank: r.bankDeg + ' / ' + r.flatDeg, 'line min': r.lineBanked + ' / ' + r.lineFlat, 'line mean gain': r.gainLine,
  'driven min': r.drivenBanked + ' / ' + r.drivenFlat, 'driven mean': r.drivenMeanB + ' / ' + r.drivenMeanF, hits: r.hits.join('/'), grass: r.grass.join('/') })));
let fails = 0;
for (const r of rows) {
  const ok = r.gainLine > 5 && r.drivenMeanB > r.drivenMeanF + 5 && r.hits[0] === 0;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + r.corner + ' ' + r.car + ': banked faster than flat (line mean +' + r.gainLine + ' km/h, driven mean ' + r.drivenMeanB + ' vs ' + r.drivenMeanF + ', min ' + r.drivenBanked + ' vs ' + r.drivenFlat + ')');
}
console.log(fails ? 'FAILURES: ' + fails : 'ALL PASS');
process.exit(fails ? 1 : 0);
