// node devtests/handling-test/banking.js [variant[:hookJSON] ...]   (default: today proposed)
// What the real banked corners (tracks-data.js bankOverrides: Zandvoort T3 19 deg / T14 18 deg, Madring T12 13.5,
// Jeddah T13 12, Indianapolis T13 9.2) do in the game, per variant, with and without the override (the same track
// built from a copy of its data without bankOverrides: the derived banking of js/track.js, <= 6 deg, there instead):
//   - the section (samples where |bank| > 6.2 deg), its length, the full angle;
//   - the racing line: lap time, slowest / mean target speed on the section, the line's radius and offset there, and
//     what limits the target at the slowest point: grip (GRIP_MARGIN x maxLatAccel) or the steering lock (with margin);
//   - the autopilot (keys and analog, 3 laps, laps 2-3 counted): min / mean speed on the section, time through it,
//     peak horizontal lateral g, peak normal load (g; 1 = standing on the flat), the car's roll (= the cockpit
//     camera's: the camera is a child of the car), share of the section driven at full lock (|steer| > 0.97);
//   - the real 2025 / 2026 qualifying (ref/<prefix>-<id>.json: F1 live-timing positions put on this track by
//     ref/align.js): the pole lap's min / mean speed over the same samples.
const fs = require('fs'), path = require('path'), L = require('./lib.js'), { drive } = require('./driver.js');
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['today', 'proposed'];
const CORNERS = [
  { id: 'nl-1948', name: 'Zandvoort T3 Hugenholtzbocht', ref: 'nl', pick: 0 },
  { id: 'nl-1948', name: 'Zandvoort T14 Arie Luyendijkbocht', ref: 'nl', pick: 1 },
  { id: 'es-2026', name: 'Madring T12 La Monumental', ref: 'es', pick: 0 },
  { id: 'sa-2021', name: 'Jeddah T13', ref: 'sa', pick: 0 },
  { id: 'us-1909', name: 'Indianapolis T13 (oval turn 1)', ref: null, pick: 0 }
];
const D = 180 / Math.PI, G = 9.81;
const noBank = new Map();
function trackNoBank(F1, id) {
  if (noBank.has(id)) return noBank.get(id);
  const td = Object.assign({}, F1.TRACKS.find(t => t.id === id));
  delete td.bankOverrides;
  const tr = F1.buildTrack(td); tr.td = td;
  noBank.set(id, tr);
  return tr;
}
function sections(tr) {
  const S = tr.samples, N = S.length, out = [];
  let cur = null;
  for (let i = 0; i < N; i++) {
    const b = Math.abs(S[i].bank) * D;
    if (b > 6.2) { if (!cur) { cur = { a: i, b: i, max: 0 }; out.push(cur); } cur.b = i; cur.max = Math.max(cur.max, b); } else cur = null;
  }
  return out;
}
function inSec(i, sec) { return i >= sec.a && i <= sec.b; }
const refCache = {};
function refTrace(c) {
  if (!c.ref) return null;
  const f = path.join(__dirname, 'ref', c.ref + '-' + c.id + '.json');
  if (!fs.existsSync(f)) return null;
  return (refCache[f] = refCache[f] || JSON.parse(fs.readFileSync(f, 'utf8')));
}
const report = [];
for (const c of CORNERS) {
  console.log(`\n=== ${c.name} (${c.id})`);
  for (const a of names) {
    const [name, hj] = a.split(/:(.*)/s);
    const F1 = L.load(L.variant(name, hj ? JSON.parse(hj) : undefined));
    const K = F1.CAR_PERF;
    for (const bankOn of [true, false]) {
      const tr = bankOn ? L.track(F1, c.id) : trackNoBank(F1, c.id);
      const sec = sections(L.track(F1, c.id))[c.pick];          // the section of the banked build (same samples)
      const S = tr.samples, N = S.length, ds = tr.length / N;
      const line = F1.buildRaceLine(tr), P = line.points;
      let iMin = sec.a, vs = 0, n = 0;
      for (let i = sec.a; i <= sec.b; i++) { if (P[i].speed < P[iMin].speed) iMin = i; vs += P[i].speed; n++; }
      const p = P[iMin], sg = p.curvature < 0 ? 1 : -1, bank = S[iMin].bank;
      const k = Math.max(Math.abs(P[(iMin + N - 1) % N].curvature), Math.abs(p.curvature), Math.abs(P[(iMin + 1) % N].curvature));
      // what js/raceline.js cornerSpeed allows there: grip (0.86 x maxLatAccel) and the lock (x 1.22), each alone
      let lo = 1, hi = 120; for (let n = 0; n < 40; n++) { const m = 0.5 * (lo + hi); if (0.86 * K.maxLatAccel(m, bank, 0, 0, sg) >= m * m * k) lo = m; else hi = m; }
      const gripV = lo;
      const lockOf = v => typeof K.steerLockAt === 'function' ? K.steerLockAt(v, bank, sg) : 0.35 / (1 + (v / 22) ** 2);
      lo = 1; hi = 120; for (let n = 0; n < 40; n++) { const m = 0.5 * (lo + hi); if (Math.tan(lockOf(m)) >= 3.6 * k * 1.22) lo = m; else hi = m; }
      const lockV = lo, lockLimited = lockV < gripV;
      const lineTxt = `line ${line.lapTime.toFixed(2)} s; section ${sec.a}..${sec.b} (${((sec.b - sec.a) * ds).toFixed(0)} m, ${sec.max.toFixed(1)} deg${bankOn ? '' : ' -> derived ' + (Math.abs(S[iMin].bank) * D).toFixed(1)}): ` +
        `target min ${(p.speed * 3.6).toFixed(0)} km/h at ${iMin} (R ${(1 / k).toFixed(0)} m, d ${p.d.toFixed(1)}), mean ${(vs / n * 3.6).toFixed(0)}; ` +
        `${lockLimited ? 'LOCK-limited there (' + (lockV * 3.6).toFixed(0) + ' km/h; the grip would allow ' + (gripV * 3.6).toFixed(0) + ')' : 'grip-limited there (' + (gripV * 3.6).toFixed(0) + ' km/h; the lock would allow ' + (lockV * 3.6).toFixed(0) + ')'}`;
      const rows = [];
      for (const mode of ['keys', 'analog']) {
        const r = drive(F1, tr, { mode, line, trace: [sec.a, sec.b], laps: 3 });
        const fly = r.trace.filter(q => q.lap >= 1 && inSec(q.i, sec));
        if (!fly.length) { rows.push(`${mode}: no data`); continue; }
        let vmin = Infinity, vsum = 0, gmax = 0, anmax = 0, rollmax = 0, sat = 0, tSec = 0;
        for (const q of fly) {
          vmin = Math.min(vmin, q.v); vsum += q.v; gmax = Math.max(gmax, Math.abs(q.latG)); anmax = Math.max(anmax, q.an);
          rollmax = Math.max(rollmax, Math.abs(q.roll)); if (Math.abs(q.steer) > 0.97) sat++;
        }
        const laps = new Set(fly.map(q => q.lap)).size;
        tSec = fly.length / 120 / laps;
        rows.push(`${mode.padEnd(6)} lap ${r.flying.toFixed(2)}: min ${(vmin * 3.6).toFixed(0)} mean ${(vsum / fly.length * 3.6).toFixed(0)} km/h, ${tSec.toFixed(2)} s through, ` +
          `lat ${gmax.toFixed(2)} g, load ${(anmax / G).toFixed(2)} g, roll ${(rollmax * D).toFixed(1)} deg, full lock ${(100 * sat / fly.length).toFixed(0)} %, grass ${r.grass}, walls ${r.hits}`);
        report.push({ corner: c.name, variant: a, bank: bankOn, mode, lap: r.flying, vmin: vmin * 3.6, vmean: vsum / fly.length * 3.6, tSec, latG: gmax, loadG: anmax / G, rollDeg: rollmax * D, fullLock: sat / fly.length, lineMin: p.speed * 3.6, lineLock: lockLimited });
      }
      console.log(`  ${a} ${bankOn ? 'BANKED   ' : 'no bank  '} ${lineTxt}\n      ` + rows.join('\n      '));
    }
  }
  const J = refTrace(c);
  if (J) {
    const sec = sections(L.track(L.load(), c.id))[c.pick];
    const rr = J.poleTrace.filter(r => r[0] >= sec.a && r[0] <= sec.b);
    if (rr.length) {
      const v = rr.map(r => r[2]);
      console.log(`  REAL ${J.track} pole lap ${J.best} s (#${J.bestDriver}): min ${Math.min(...v).toFixed(0)} mean ${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(0)} km/h over the same samples (${rr.length} rows, offsets ${Math.min(...rr.map(r => r[1])).toFixed(1)}..${Math.max(...rr.map(r => r[1])).toFixed(1)} m); median of the fastest laps' min ${J.corners.find(q => q.bank) ? J.corners.filter(q => q.bank)[c.pick] ? J.corners.filter(q => q.bank)[c.pick].vMin : '-' : '-'} km/h`);
      report.push({ corner: c.name, variant: 'real', vmin: Math.min(...v), vmean: v.reduce((x, y) => x + y, 0) / v.length });
    }
  }
}
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'out', 'banking.json'), JSON.stringify(report, null, 1));
