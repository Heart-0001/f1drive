// node devtests/handling-test/compress.js [variant] [trackId ...]
// The "compression" a driver feels from the road's shape: the tyre load beyond what the same speed gives on a flat,
// level road, in g:  (normal load - (g + downforce v^2)) / g  - from the banking (centripetal x sin bank), dips (> 0)
// and crests (< 0). This is what a cockpit compression cue (eye drop / head nod, see the report) would show. The
// keyboard autopilot (driver.js) drives 3 laps; over laps 2-3, per track: the 3 strongest compressions (sample, speed,
// bank, vertical curvature) and the strongest lift (crest).
const L = require('./lib.js'), { drive } = require('./driver.js');
const args = process.argv.slice(2);
const name = args[0] || 'proposed';
const ids = args.length > 1 ? args.slice(1) : ['nl-1948', 'es-2026', 'sa-2021', 'us-1909', 'be-1925', 'br-1940', 'us-2012', 'mc-1929', 'it-1922', 'gb-1948', 'jp-1962'];
const F1 = L.load(L.variant(name));
const K = F1.CAR_PERF, G = 9.81, D = 180 / Math.PI;
for (const id of ids) {
  const tr = L.track(F1, id), S = tr.samples, N = S.length;
  const kv = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const p = S[(i - 1 + N) % N], a = S[i], q = S[(i + 1) % N];
    const gp = Math.hypot(a.x - p.x, a.z - p.z), gq = Math.hypot(q.x - a.x, q.z - a.z);
    kv[i] = gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10 ? -((q.y - a.y) / gq - (a.y - p.y) / gp) / (0.5 * (gp + gq)) : 0;
  }
  const r = drive(F1, tr, { mode: 'keys', trace: [0, N - 1], laps: 3 });
  const per = new Map();
  for (const q of r.trace) {
    if (q.lap < 1) continue;
    const k = (kv[(q.i - 1 + N) % N] + kv[q.i] + kv[(q.i + 1) % N]) / 3;
    const an = K.normalAccel(q.v, Math.atan(Math.tan(q.roll)), q.pitch, k, q.latG * G);
    const c = (an - (G + K.downforce * q.v * q.v)) / G;
    const o = per.get(q.i);
    if (!o || Math.abs(c) > Math.abs(o.c)) per.set(q.i, { i: q.i, c, v: q.v, bank: S[q.i].bank, k });
  }
  const all = [...per.values()].sort((a, b) => b.c - a.c);
  const top = [];
  for (const o of all) { if (top.length >= 3) break; if (top.every(t => Math.abs(((t.i - o.i + N) % N + N) % N) > 40 && Math.abs(((o.i - t.i + N) % N)) > 40)) top.push(o); }
  const lift = all[all.length - 1];
  const fmt = o => `${o.i} +${o.c.toFixed(2)} g @ ${(o.v * 3.6).toFixed(0)} km/h (bank ${(o.bank * D).toFixed(1)} deg, ${o.k < -1e-3 ? 'dip R ' + (1 / -o.k).toFixed(0) + ' m' : o.k > 1e-3 ? 'crest' : 'level'})`;
  console.log(`${id.padEnd(8)} compression: ${top.map(fmt).join(' | ')};  lift: ${lift.i} ${lift.c.toFixed(2)} g @ ${(lift.v * 3.6).toFixed(0)} km/h`);
}
