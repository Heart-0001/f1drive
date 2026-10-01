// Shared loader for devtests/handling-test: the real game modules in node, optionally with COPIES of js/car.js /
// js/raceline.js (nothing in the project is edited). Every load is a fresh global F1 (vm-free: modules are evaluated
// with `new Function` on a sandbox object) so two variants can be compared in one process.
//   load({car: <file>, raceline: <file>, hook: {low, bank, lock, ref, old}}) -> F1 (F1.TRACKS = window.F1_TRACKS)
//   variant(name) -> the load options of a named variant: 'v5' (the project files), 'x' (variants/*-x.js, hook
//   given separately), 'proposed' (variants/*.proposed.js)
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
const SRC = {};
function src(file) { return SRC[file] || (SRC[file] = fs.readFileSync(file, 'utf8')); }
let tracksData = null;
function tracks() {
  if (tracksData) return tracksData;
  const sb = {};
  new Function('window', 'globalThis', src(path.join(ROOT, 'tracks-data.js')))(sb, sb);
  return (tracksData = sb.F1_TRACKS);
}
function load(opts) {
  opts = opts || {};
  const win = { THREE, F1: {} };
  if (opts.hook) win.HT_STEER = opts.hook;
  win.window = win;
  const files = [
    path.join(ROOT, 'js', 'track.js'),
    opts.car || path.join(ROOT, 'js', 'car.js'),
    opts.raceline || path.join(ROOT, 'js', 'raceline.js')
  ];
  for (const f of files) new Function('window', 'globalThis', 'THREE', src(f)).call(win, win, win, THREE);
  const F1 = win.F1;
  F1.TRACKS = tracks();
  F1.win = win;
  return F1;
}
const trackCache = new Map();
// track objects are shared between variants (js/track.js is not changed)
function track(F1, id) {
  if (trackCache.has(id)) return trackCache.get(id);
  const td = F1.TRACKS.find(t => t.id === id || t.name.toLowerCase().includes(String(id).toLowerCase()));
  if (!td) throw new Error('no track ' + id);
  const tr = F1.buildTrack(td);
  tr.td = td;
  trackCache.set(id, tr);
  return tr;
}
function variant(name, hook) {
  const V = path.join(__dirname, 'variants');
  if (name === 'v5' || name === 'today') return {};
  if (name === 'proposed') return { car: path.join(V, 'car.proposed.js'), raceline: path.join(V, 'raceline.proposed.js') };
  return { car: path.join(V, 'car-x.js'), raceline: path.join(V, 'raceline-x.js'), hook: hook || {} };
}
module.exports = { ROOT, load, track, tracks, variant, THREE };
