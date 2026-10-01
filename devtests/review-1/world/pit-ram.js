// node devtests/review-1/world/pit-ram.js [id]
// Rams the pit wall (from the lane and from the track), the garage face and the entry-taper opening with the real car.
// Reports any step where the car ends up on the wrong side of the pit wall or beyond the outer wall.
const path = require('path');
const L = require('./load.js');
const ROOT = path.resolve(__dirname, '..', '..', '..');
require(path.join(ROOT, 'js', 'tyres.js'));
require(path.join(ROOT, 'js', 'car.js'));
const F1 = L.F1;
const ids = process.argv[2] ? [process.argv[2]] : L.TRACKS.map(t => t.id);
let total = 0;
for (const id of ids) {
  const td = L.TRACKS.find(t => t.id === id);
  const tr = F1.buildTrack(td), S = tr.samples, N = S.length, pit = tr.pit;
  if (!pit) { console.log(id, 'no pit'); continue; }
  const car = F1.createCar();
  const sg = pit.side, wq = q => ((q % N) + N) % N;
  const K = wq(pit.to - pit.from);
  let bad = 0, msgs = [];
  function run(name, k0, dStart, headingOff, steps, input) {
    const i0 = wq(pit.from + k0), s = S[i0];
    car.reset(tr, i0);
    car.state.x = s.x + s.nx * dStart; car.state.z = s.z + s.nz * dStart;
    car.state.heading = Math.atan2(s.tx, s.tz) + headingOff;
    car.update(1e-4, null, tr);
    car.state.speed = 0;
    let startSide = null;
    for (let t = 0; t < steps; t++) {
      car.update(1 / 120, input, tr);
      const st = car.state, i = st.sampleIndex, d = st.d, a = d * sg;
      const w = pit.wallD(i), k = wq(i - pit.from);
      const outer = sg > 0 ? S[i].wallPosDist : S[i].wallNegDist;
      if (Math.abs(d) > outer + 0.9 + 0.05) { bad++; msgs.push(`${name}: beyond outer wall at step ${t} k=${k} |d|=${Math.abs(d).toFixed(2)} outer=${outer.toFixed(2)}`); break; }
      if (isFinite(w)) {
        const side = a > Math.abs(w) ? 1 : -1;    // +1 lane side of the pit wall centre
        if (startSide === null) startSide = side;
        else if (side !== startSide && Math.abs(a - Math.abs(w)) > 0.3) { bad++; msgs.push(`${name}: crossed the pit wall at step ${t} k=${k} a=${a.toFixed(2)} wall=${Math.abs(w).toFixed(2)}`); break; }
      } else startSide = null;
      if (!isFinite(st.x) || !isFinite(st.z)) { bad++; msgs.push(`${name}: NaN`); break; }
    }
    return car.state;
  }
  const lane = k => Math.abs(pit.laneD(wq(pit.from + k)));
  const kMid = Math.round(K / 2), kEn = wq(pit.entry - pit.from), kEx = wq(pit.exit - pit.from);
  const W = { up: true, down: false, left: false, right: false }, WL = { up: true, down: false, left: true, right: false }, WR = { up: true, down: false, left: false, right: true };
  // 1. in the lane, full throttle, steering into the pit wall (towards the track)
  run('lane->pitwall', kMid, sg * lane(kMid), 0, 600, sg > 0 ? WR : WL);
  // 2. on the track edge, steering into the pit wall from the track side
  run('track->pitwall', kMid, sg * (S[wq(pit.from + kMid)].halfW - 2), 0, 600, sg > 0 ? WL : WR);
  // 3. in the lane, steering into the garage face
  run('lane->garage', kMid, sg * lane(kMid), 0, 600, sg > 0 ? WL : WR);
  // 4. in the lane at a 60 deg angle towards the pit wall, throttle
  run('lane-angle->pitwall', kMid + 20, sg * lane(kMid + 20), -sg * 1.0, 400, W);
  // 5. from the track through the entry taper into the lane at speed, then at an angle into the wall end
  run('taper-entry', 5, sg * lane(5), 0, 900, W);
  run('taper-angle', kEn - 30, sg * (S[wq(pit.entry - 30)].halfW - 1), sg * 0.5, 500, W);
  // 6. reverse into the pit wall from the lane
  run('reverse->pitwall', kMid + 40, sg * lane(kMid + 40), sg * 2.2, 500, W);
  total += bad;
  console.log(id.padEnd(8), bad ? 'BAD ' + msgs.join(' | ') : 'ok');
}
console.log('TOTAL bad', total);
