// Node loader for the AI simulations / tests: the REAL game modules (THREE only for the racing line's mesh).
//   const L = require('./lib');  L.F1, L.track(id), L.line(track, perf), L.placeOnGrid(track, car, slot), L.refLap(...)
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global;
if (!global.THREE) global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
for (const f of ['tracks-data.js', 'js/seasons-data.js', 'js/cars.js', 'js/track.js', 'js/tyres.js', 'js/car.js',
  'js/raceline.js', 'js/collide.js', 'js/laps.js', 'js/pit.js', 'net/session.js']) require(path.join(ROOT, f));
const F1 = global.F1;
// (AI_JS=<path>: another copy of js/ai.js, for A/B experiments)
try { require(process.env.AI_JS ? path.resolve(process.env.AI_JS) : path.join(ROOT, 'js/ai.js')); } catch (e) { if (!/Cannot find module/.test(e.message)) throw e; }
const mainGrid = require('../laps-test/main-grid.js');

const cache = new Map();
function track(id) {
  if (cache.has(id)) return cache.get(id);
  const td = global.F1_TRACKS.find(t => t.id === id || t.name === id);
  if (!td) throw new Error('unknown track ' + id);
  const t = F1.buildTrack(td);
  t.id = td.id; t.name = td.name;
  cache.set(id, t);
  return t;
}
const lines = new Map();
// one racing line per (track, car spec id): F1.buildRaceLine(track, car.perf) as main.js builds it
function line(t, perf) {
  const key = t.id + '|' + (perf && perf.spec ? perf.spec.id + JSON.stringify([perf.power, perf.latBase, perf.downforce, perf.brakeBase, perf.traction, perf.dragK]) : 'ref');
  if (lines.has(key)) return lines.get(key);
  const l = F1.buildRaceLine(t, perf);
  lines.set(key, l);
  return l;
}
function placeOnGrid(t, car, slot) { return mainGrid(t, car)(slot); }

// The calibration's reference driver (devtests/seasons-calib/driver.mjs): keyboard pursuit on the line following the
// line's own advice (levels[2]), battery held on full throttle above 100 km/h. -> flying lap (best of laps 2..3).
function refLap(t, spec, opts) {
  opts = opts || {};
  const car = F1.createCar(spec, { tyres: false });
  const ln = F1.buildRaceLine(t, car.perf);
  const S = t.samples, N = S.length, ds = t.length / N, P = ln.points, st = car.state;
  car.reset(t, 0);
  const dt = 1 / 120, input = { up: false, down: false, left: false, right: false, boost: false };
  let time = 0, lapStart = 0, prevIdx = 0;
  const laps = [];
  const deploy = opts.deploy !== false;
  while (laps.length < 3 && time < 900) {
    ln.update(st);
    const v = Math.max(0, st.speed), lv = ln.levels[2];
    input.up = lv < 0.45 || v < 5; input.down = lv >= 0.6 && v >= 5;
    input.boost = deploy && input.up && !input.down && v > 100 / 3.6;
    const Ld = Math.min(35, Math.max(7, 5 + 0.3 * v));
    const tp = P[(st.sampleIndex + Math.round(Ld / ds)) % N];
    const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
    const kap = 2 * (dx * ch - dz * sh) / (dx * dx + dz * dz);
    const lock = 0.35 / (1 + (v / 22) * (v / 22));
    const want = Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
    input.left = want > st.steer + 0.03; input.right = want < st.steer - 0.03;
    car.update(dt, input, t);
    time += dt;
    if (prevIdx > N * 0.75 && st.sampleIndex < N * 0.25) {
      const s0 = S[0], along = (st.x - s0.x) * s0.tx + (st.z - s0.z) * s0.tz;
      const tc = time - Math.max(0, Math.min(along, 3)) / Math.max(st.speed, 1);
      laps.push(tc - lapStart); lapStart = tc;
    }
    prevIdx = st.sampleIndex;
  }
  const pred = ln.lapTime;
  ln.dispose();
  return { laps, flying: Math.min.apply(null, laps.slice(1)), pred };
}

const IDS = { monza: 'it-1922', monaco: 'mc-1929', spa: 'be-1925', suzuka: 'jp-1962', bahrain: 'bh-2002',
  zandvoort: 'nl-1948', singapore: 'sg-2008', silverstone: 'gb-1948', hungaroring: 'hu-1986', interlagos: 'br-1940',
  baku: 'az-2016', jeddah: 'sa-2021', austria: 'at-1969', vegas: 'us-2023', cota: 'us-2012', madring: 'es-2026' };
function fmt(t) { return t == null || !isFinite(t) ? '  --  ' : Math.floor(t / 60) + ':' + (t % 60).toFixed(3).padStart(6, '0'); }

module.exports = { F1, ROOT, track, line, placeOnGrid, refLap, IDS, fmt, CAR_NOSE: mainGrid.CAR_NOSE, START_BACK: mainGrid.START_BACK };
