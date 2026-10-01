// shared loader for the review probes: the real modules + the v5 car in a sandbox
'use strict';
const path = require('path'), fs = require('fs'), vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib/three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'scenery-data.js'));
require(path.join(ROOT, 'js/seasons-data.js'));
require(path.join(ROOT, 'js/cars.js'));
require(path.join(ROOT, 'js/track.js'));
require(path.join(ROOT, 'js/tyres.js'));
require(path.join(ROOT, 'js/car.js'));
require(path.join(ROOT, 'js/raceline.js'));
require(path.join(ROOT, 'js/laps.js'));
require(path.join(ROOT, 'js/pit.js'));
require(path.join(ROOT, 'js/collide.js'));
function sandbox(file) {
  const g = {}; g.globalThis = g;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), g, { filename: path.basename(file) });
  return g.F1;
}
const V5 = sandbox(path.join(ROOT, 'devtests/car-v6/car-v5.js'));
const F1 = global.F1;
const STEP = 1 / 120, KMH = 3.6;
const built = {};
function track(id) {
  if (!built[id]) {
    const td = global.F1_TRACKS.find(t => t.id === id);
    const tr = F1.buildTrack(td);
    built[id] = { track: tr, line: F1.buildRaceLine(tr), data: td };
  }
  return built[id];
}
function strip(len) {
  const a = [], n = Math.round((len || 20000) / 2);
  for (let i = 0; i < n; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: 0, bank: 0, wallPos: false, wallNeg: false, halfW: 50, wallPosDist: 60, wallNegDist: 60 });
  return { samples: a, halfWidth: 50, wallDist: 60, length: n * 2, locate(x, z) { return { index: Math.max(0, Math.min(a.length - 1, Math.round(z / 2))), d: x }; } };
}
function pursuit(tr, st, dOff) {
  const S = tr.samples, N = S.length, ds = tr.length / N, v = Math.max(0, st.speed);
  const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), s = S[(st.sampleIndex + Math.round(L / ds)) % N];
  const dx = s.x + s.nx * (dOff || 0) - st.x, dz = s.z + s.nz * (dOff || 0) - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
  const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
  return Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock));
}
function keysSteer(inp, st, want) { inp.left = want > st.steer + 0.03; inp.right = want < st.steer - 0.03; }
function lineWant(tr, line, st) {
  line.update(st);
  const S = tr.samples, N = S.length, ds = tr.length / N, P = line.points, v = Math.max(0, st.speed);
  const L = Math.min(35, Math.max(7, 5 + 0.3 * v)), tp = P[(st.sampleIndex + Math.round(L / ds)) % N];
  const dx = tp.x - st.x, dz = tp.z - st.z, ch = Math.cos(st.heading), sh = Math.sin(st.heading);
  const lat = dx * ch - dz * sh, kap = 2 * lat / (dx * dx + dz * dz), lock = 0.35 / (1 + (v / 22) * (v / 22));
  return { level: line.levels[2], steer: Math.max(-1, Math.min(1, Math.atan(kap * 3.6) / lock)) };
}
function inPitArea(tr, st) {
  const pit = tr.pit; if (!pit) return false;
  const N = tr.samples.length, k = ((st.sampleIndex - pit.from) % N + N) % N, K = ((pit.to - pit.from) % N + N) % N;
  return k <= K + 3 && st.d * pit.side > tr.samples[st.sampleIndex].halfW - 0.5;
}
module.exports = { ROOT, F1, V5, STEP, KMH, track, strip, pursuit, keysSteer, lineWant, inPitArea, createAutopilot: require(path.join(ROOT, 'devtests/gp-e2e/autopilot.js')) };
