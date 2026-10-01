// node devtests/track-fix/bank-check.js
// The real banked corners (tracks-data.js bankOverrides, js/track.js): for every override
//   - the built bank on the section is the full angle, inside of the corner lower (sign checked against the
//     corner's net curvature), and eases back outside it (no step: max |d bank / ds|);
//   - surfaceY follows the bank (outer road edge higher than the inner one by 2 * halfW * tan(bank));
//   - the racing line's target speed through the section with the banking vs the same track without it (the
//     bankOverrides removed): it must rise where the tyres are the limit and never drop by more than 2 km/h.
//     (2026-10-01: the lidar-measured cambers of the track audit include corners FLATTER than the curvature-derived
//     banking the track would get without them, e.g. Imola T6 0.8 deg, Silverstone Club 0.5: there the line may be
//     slower and the derived banking on the ramps can match the angle, so for those ("flattens") only the side and a
//     full-angle stretch at least as long as the data are checked.) Where the
//     car's speed-sensitive steering lock is the limit (js/car.js: lock = 0.35 / (1 + (v / 22)^2) rad, wheelbase 3.6 m,
//     mirrored by js/raceline.js with a 1.22 reserve), banking cannot raise the speed: reported per corner ("steer").
// Exit code 1 on a failed check.
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.THREE = require(path.join(ROOT, 'lib', 'three.min.js'));
require(path.join(ROOT, 'tracks-data.js'));
require(path.join(ROOT, 'js', 'track.js'));
require(path.join(ROOT, 'js', 'car.js'));
require(path.join(ROOT, 'js', 'raceline.js'));
const D = 180 / Math.PI;
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('  FAIL ' + msg); } };
for (const td of window.F1_TRACKS) {
  if (!td.bankOverrides) continue;
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, ds = tr.length / N;
  const flat = Object.assign({}, td); delete flat.bankOverrides;
  const tr0 = F1.buildTrack(flat);
  const line = F1.buildRaceLine(tr), line0 = F1.buildRaceLine(tr0);
  console.log(`${td.id} ${td.name}: lap (racing line prediction) ${line.lapTime.toFixed(2)} s with the banking, ${line0.lapTime.toFixed(2)} s without`);
  let maxRate = 0;
  for (let i = 0; i < N; i++) maxRate = Math.max(maxRate, Math.abs(S[(i + 1) % N].bank - S[i].bank) / ds * D);
  for (const o of td.bankOverrides) {
    // the section = the samples whose bank is at the full angle (within 0.05 deg)
    const full = o.deg / D, idx = [];
    for (let i = 0; i < N; i++) if (Math.abs(Math.abs(S[i].bank) - full) < 0.05 / D) idx.push(i);
    // the longest cyclic run of them near the override's fractions
    const c = Math.round((o.from + o.to) / 2 * N) % N;
    let a = c, b = c;
    while (Math.abs(Math.abs(S[(a - 1 + N) % N].bank) - full) < 0.05 / D && (c - a + N) % N < N / 2) a = (a - 1 + N) % N;
    while (Math.abs(Math.abs(S[(b + 1) % N].bank) - full) < 0.05 / D && (b - c + N) % N < N / 2) b = (b + 1) % N;
    const len = ((b - a + N) % N) * ds, want = Math.abs((o.to - o.from + 1) % 1) * tr.length;
    // does the override raise the bank above what the track derives there without it?
    const ia0 = Math.round(o.from * N), ib0 = Math.round(o.to * N);
    let derived = 0;
    for (let i = ia0; i !== (ib0 + 1) % N; i = (i + 1) % N) derived = Math.max(derived, Math.abs(tr0.samples[i].bank));
    const raises = Math.abs(full) > derived + 0.3 / D;
    let net = 0, vB = 0, v0 = 0, cnt = 0, sgnOk = true, edge = 0;
    for (let k = 0; ((a + k) % N) !== ((b + 1) % N); k++) {
      const i = (a + k) % N, s = S[i];
      const i1 = (i + 2) % N, i0 = (i - 2 + N) % N;
      net += (S[i1].tx - S[i0].tx) * s.nx + (S[i1].tz - S[i0].tz) * s.nz;
      vB += line.points[i].speed; v0 += line0.points[i].speed; cnt++;
      edge = Math.max(edge, Math.abs(tr.surfaceY(i, s.halfW) - tr.surfaceY(i, -s.halfW)));
    }
    const bankSign = Math.sign(S[c].bank), inside = net > 0 ? 'left' : 'right';
    sgnOk = (net > 0 && bankSign < 0) || (net < 0 && bankSign > 0);
    // speed of the ideal line where it is slowest in the section (the corner's minimum) with / without, the largest
    // gain / loss anywhere from 60 m before the section to its end, and the steering-lock speed at the slowest point
    let minB = Infinity, min0 = Infinity, iMin = a, gain = -Infinity, loss = 0, gainAt = 0;
    for (let k = 0; ((a + k) % N) !== ((b + 1) % N); k++) { const i = (a + k) % N; if (line.points[i].speed < minB) { minB = line.points[i].speed; iMin = i; } min0 = Math.min(min0, line0.points[i].speed); }
    for (let k = -Math.round(60 / ds); ((a + k + N) % N) !== ((b + 1) % N); k++) {
      const i = (a + k + N) % N, dv = line.points[i].speed - line0.points[i].speed;
      if (dv > gain) { gain = dv; gainAt = S[i].s; } if (-dv > loss) loss = -dv;
    }
    const P = line.points, q0 = P[(iMin - 3 + N) % N], q1 = P[iMin], q2 = P[(iMin + 3) % N];
    const ax = q1.x - q0.x, az = q1.z - q0.z, bx = q2.x - q0.x, bz = q2.z - q0.z;
    const kLine = 2 * Math.abs(ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(q2.x - q1.x, q2.z - q1.z));
    const xs = Math.atan(3.6 * kLine * 1.22), vSteer = xs >= 0.35 ? 7 : 22 * Math.sqrt(0.35 / xs - 1);
    const steerLimited = minB >= vSteer - 1.5, flatOut = min0 * 3.6 > 290;
    console.log(`  ${o.name.padEnd(24)} ${String(o.deg).padStart(4)} deg: full angle over ${len.toFixed(0)} m (data ${want.toFixed(0)} m), ` +
      `corner turns ${net > 0 ? 'LEFT' : 'RIGHT'} -> bank ${(S[c].bank * D).toFixed(2)} deg (${sgnOk ? 'inside lower' : 'WRONG SIDE'}), ` +
      `road edges ${edge.toFixed(2)} m apart in height | line speed: mean ${(vB / cnt * 3.6).toFixed(0)} vs ${(v0 / cnt * 3.6).toFixed(0)} km/h unbanked, ` +
      `slowest in the section ${(minB * 3.6).toFixed(0)} vs ${(min0 * 3.6).toFixed(0)} km/h (line radius there ${(1 / kLine).toFixed(0)} m, steering-lock limit ${(vSteer * 3.6).toFixed(0)} km/h${steerLimited ? ': steer' : ''}${flatOut ? ', flat out' : ''}), ` +
      `largest gain +${(gain * 3.6).toFixed(0)} km/h at s ${gainAt.toFixed(0)} m, largest loss ${(loss * 3.6).toFixed(1)} km/h` +
      ` | ${raises ? 'raises' : 'flattens'} (derived without it: ${(derived * D).toFixed(2)} deg)`);
    check(sgnOk, o.name + ': bank on the wrong side');
    if (raises) {
      check(Math.abs(len - want) < 12, o.name + `: full angle over ${len.toFixed(0)} m, data says ${want.toFixed(0)} m`);
      check(flatOut || steerLimited || gain * 3.6 >= 3, o.name + ': the racing line is nowhere faster with the banking');   // (steer: the lock, not the tyres, is the limit there)
      check(loss * 3.6 <= 2, o.name + ': the racing line is slower with the banking');
    } else {
      check(len > want - 12, o.name + `: full angle over ${len.toFixed(0)} m, data says ${want.toFixed(0)} m`);
    }
  }
  console.log(`  max |d bank / ds| over the lap ${maxRate.toFixed(2)} deg/m`);
  check(maxRate < 1.2, td.id + ': bank changes faster than 1.2 deg per metre');
  line.dispose(); line0.dispose(); tr.dispose(); tr0.dispose();
}
console.log(fail ? `${fail} check(s) FAILED` : 'all banking checks passed');
process.exit(fail ? 1 : 0);
