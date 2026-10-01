// node devtests/handling-test/laps40.js [variant[:hookJSON] ...] [--old] [--tracks id,id] [--out name]
// Every track (or --tracks) with each variant (default: today proposed): the racing line's predicted lap, and the
// handling-test autopilot (driver.js: keys = bang-bang LEFT / RIGHT like the project's harness drivers, analog = the
// same pursuit as a stick), 3 laps from a standing start, the flying lap = the better of laps 2 and 3. --old: the
// drivers compute their steer with the v5 lock formula (what the project's harnesses do until they are updated).
// Prints a table of the differences to the first variant and writes out/<name>.json.
const fs = require('fs'), path = require('path'), L = require('./lib.js'), { drive } = require('./driver.js');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const old = argv.includes('--old'); if (old) argv.splice(argv.indexOf('--old'), 1);
const only = opt('--tracks'), outName = opt('--out') || 'laps40';
const names = argv.length ? argv : ['today', 'proposed'];
const res = {};
const t0 = Date.now();
let ids = null;
for (const a of names) {
  const [name, hj] = a.split(/:(.*)/s);
  const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
  ids = ids || (only ? only.split(',') : F1.TRACKS.map(t => t.id));
  res[a] = {};
  for (const id of ids) {
    const tr = L.track(F1, id);
    const line = F1.buildRaceLine(tr);
    const k = drive(F1, tr, { mode: 'keys', line, oldLock: old });
    const g = drive(F1, tr, { mode: 'analog', line, oldLock: old });
    res[a][id] = { pred: line.lapTime, keys: k.flying, analog: g.flying, kLaps: k.laps.length, gLaps: g.laps.length,
      grass: k.grass + g.grass, hits: k.hits + g.hits, flips: k.steerFlips, vmax: Math.max(k.vmax, g.vmax) };
  }
  process.stderr.write(`${a}: ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}
const base = names[0];
const f = (x) => (isFinite(x) ? x.toFixed(2) : '  -  ').padStart(7);
const fd = (x) => (isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '  -  ').padStart(7);
console.log(`track        ${base.padEnd(10)} pred / keys / analog   ` + names.slice(1).map(n => `| ${n.slice(0, 26).padEnd(26)} d pred / d keys / d analog  grass hits flips`).join(' '));
const sum = {};
for (const id of ids) {
  const b = res[base][id];
  let row = `${id.padEnd(9)} ${f(b.pred)} ${f(b.keys)} ${f(b.analog)}  g${String(b.grass).padStart(4)} h${String(b.hits).padStart(3)} `;
  for (const n of names.slice(1)) {
    const r = res[n][id];
    row += `| ${fd(r.pred - b.pred)} ${fd(r.keys - b.keys)} ${fd(r.analog - b.analog)}  g${String(r.grass).padStart(4)} h${String(r.hits).padStart(3)} fl${String(r.flips - b.flips).padStart(5)} `;
    const s = sum[n] = sum[n] || { pred: 0, keys: 0, analog: 0, worse: [], failed: [] };
    s.pred += r.pred - b.pred; s.keys += r.keys - b.keys; s.analog += r.analog - b.analog;
    if (r.keys - b.keys > 0.15 || r.analog - b.analog > 0.15) s.worse.push(id);
    if (!(r.kLaps >= 3 && r.gLaps >= 3) || !isFinite(r.keys) || !isFinite(r.analog)) s.failed.push(id);
  }
  console.log(row);
}
for (const n of names.slice(1)) {
  const s = sum[n];
  console.log(`${n}: sum over ${ids.length} tracks  pred ${s.pred.toFixed(2)} s, keys ${s.keys.toFixed(2)} s, analog ${s.analog.toFixed(2)} s; slower by > 0.15 s: ${s.worse.join(' ') || 'none'}; not lapping: ${s.failed.join(' ') || 'none'}`);
}
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', outName + '.json'), JSON.stringify({ old, names, res }, null, 1));
