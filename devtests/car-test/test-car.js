global.window = global;
require(require('path').resolve(__dirname, '..', '..') + '/js/car.js');
const F1 = global.F1;
const KMH = 3.6;

function mkTrack(samples, closed, walls) {
  const n = samples.length;
  samples.forEach(s => { s.wallPos = walls; s.wallNeg = walls; });
  return {
    samples, halfWidth: 7, wallDist: 12, length: n * 2,
    locate(x, z, hint) {
      let best = -1, bd = Infinity;
      const test = i => {
        const s = samples[i]; const dx = x - s.x, dz = z - s.z; const q = dx * dx + dz * dz;
        if (q < bd) { bd = q; best = i; }
      };
      if (hint < 0) for (let i = 0; i < n; i++) test(i);
      else for (let k = -40; k <= 40; k++) {
        let i = hint + k;
        if (closed) i = ((i % n) + n) % n; else if (i < 0 || i >= n) continue;
        test(i);
      }
      const s = samples[best];
      return { index: best, d: (x - s.x) * s.nx + (z - s.z) * s.nz };
    }
  };
}
function straight(len, walls) {
  const a = [];
  for (let i = 0; i * 2 <= len; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2 });
  return mkTrack(a, false, walls);
}
// circle turning LEFT (heading increases along racing direction); normal points to the driver's left (inside)
function circle(R, walls) {
  const n = Math.round(2 * Math.PI * R / 2), a = [];
  for (let i = 0; i < n; i++) {
    const h = i / n * 2 * Math.PI; // heading of tangent
    const tx = Math.sin(h), tz = Math.cos(h);
    const nx = Math.cos(h), nz = -Math.sin(h); // left of forward = -(right) = (cos h, -sin h)
    // centre is to the left at distance R: pos = centre - n*R
    a.push({ x: -nx * R, z: -nz * R, tx, tz, nx, nz, s: i * 2 * Math.PI * R / n });
  }
  return mkTrack(a, true, walls);
}
const DT = 1 / 60;
const none = {};

// --- top speed and 0-100 / 0-200 / 0-300
{
  const t = straight(20000, false), car = F1.createCar(); car.reset(t, 0);
  let time = 0, t100 = null, t200 = null, t300 = null;
  while (time < 60) {
    car.update(DT, { up: true }, t); time += DT;
    const k = car.state.speed * KMH;
    if (t100 === null && k >= 100) t100 = time;
    if (t200 === null && k >= 200) t200 = time;
    if (t300 === null && k >= 300) t300 = time;
  }
  console.log('0-100 %ss  0-200 %ss  0-300 %ss  top speed %s km/h (x drift %s)', t100.toFixed(2), t200.toFixed(2), t300.toFixed(2), (car.state.speed * KMH).toFixed(1), car.state.x.toFixed(3));
}
// --- braking from 300, coasting
{
  const t = straight(20000, false);
  for (const mode of ['brake', 'coast']) {
    const car = F1.createCar(); car.reset(t, 0); car.state.speed = 300 / KMH;
    const z0 = car.state.z; let time = 0, peak = 0, t200 = null;
    while (car.state.speed > 0.01 && time < 200) {
      const v0 = car.state.speed;
      car.update(DT, mode === 'brake' ? { down: true } : none, t); time += DT;
      peak = Math.max(peak, (v0 - car.state.speed) / DT);
      if (t200 === null && car.state.speed * KMH <= 200) t200 = time;
      if (mode === 'brake' && car.state.speed === 0) break;
    }
    console.log('%s from 300: distance %sm time %ss, peak decel %s g, 300->200 in %ss', mode, (car.state.z - z0).toFixed(1), time.toFixed(2), (peak / 9.81).toFixed(2), t200.toFixed(2));
  }
}
// --- reverse
{
  const t = straight(2000, false), car = F1.createCar(); car.reset(t, 500);
  for (let i = 0; i < 600; i++) car.update(DT, { down: true }, t);
  console.log('reverse speed after 10s: %s km/h', (car.state.speed * KMH).toFixed(1));
  const h0 = car.state.heading;
  for (let i = 0; i < 60; i++) car.update(DT, { down: true, left: true }, t);
  console.log('reversing + left: heading change %s rad (negative = tail swings to driver-left, like a real car), x %s', (car.state.heading - h0).toFixed(3), car.state.x.toFixed(2));
  // brake to stop then reverse
  car.reset(t, 100); car.state.speed = 30;
  let stopped = null;
  for (let i = 0; i < 600; i++) { car.update(DT, { down: true }, t); if (stopped === null && car.state.speed <= 0) stopped = i * DT; }
  console.log('brake from 108 km/h: stopped at %ss then reversing at %s km/h', stopped.toFixed(2), (car.state.speed * KMH).toFixed(1));
}
// --- left turns left
{
  const t = straight(2000, false), car = F1.createCar(); car.reset(t, 10); car.state.speed = 30;
  const h0 = car.state.heading;
  for (let i = 0; i < 30; i++) car.update(DT, { left: true }, t);
  const s = car.state;
  // driver's left vector at heading 0 = -(right) = (cos h, -sin h) = (+1, 0)
  console.log('hold LEFT 0.5s at 108 km/h: heading %s -> %s (must increase), x moved %s (driver-left is +x at h=0), steer %s', h0.toFixed(3), s.heading.toFixed(3), s.x.toFixed(2), s.steer.toFixed(2));
  if (!(s.heading > h0 && s.x > 0 && s.steer > 0)) throw new Error('LEFT CONVENTION BROKEN');
  for (let i = 0; i < 30; i++) car.update(DT, none, t);
  console.log('steer after 0.5 s released: %s', s.steer);
}
// --- steady-state full-lock radius at fixed speeds
{
  const t = straight(200000, false);
  let out = [];
  for (const k of [40, 60, 80, 100, 150, 200, 250, 300, 330]) {
    const car = F1.createCar(); car.reset(t, 10); car.state.steer = 1;
    car.state.speed = k / KMH;
    const h0 = car.state.heading; car.update(1 / 240, { left: true, up: true }, null);
    const yaw = (car.state.heading - h0) * 240; const v = k / KMH;
    out.push(k + 'km/h: R=' + (v / yaw).toFixed(0) + 'm ' + (v * yaw / 9.81).toFixed(2) + 'g');
  }
  console.log('full-lock turning: ' + out.join(' | '));
}
// --- keyboard driver on a circle: max speed that stays on the road
function lapCircle(R, targetKmh, dt) {
  const t = circle(R, false), car = F1.createCar(); car.reset(t, 0);
  car.state.speed = targetKmh / KMH;
  let maxD = 0, time = 0, minK = 1e9; const laps = 2 * 2 * Math.PI * R / (targetKmh / KMH);
  while (time < Math.max(laps, 20)) {
    const s = car.state, smp = t.samples[s.sampleIndex];
    // heading error relative to tangent
    let he = Math.atan2(smp.tx, smp.tz) - s.heading; he = Math.atan2(Math.sin(he), Math.cos(he));
    // bang-bang keyboard: want to move toward d=0 (normal points left => d>0 means car is left of centre)
    const want = he * 1.0 - s.d * 0.03 + 0.0; // >0 => steer left
    const curv = 1 / R; // feed-forward: track turns left
    const cmd = want + curv * 8;
    const input = { left: cmd > 0.02, right: cmd < -0.02, up: s.speed * KMH < targetKmh, down: false };
    car.update(dt, input, t); time += dt;
    maxD = Math.max(maxD, Math.abs(car.state.d)); minK = Math.min(minK, car.state.speed * KMH);
  }
  return { maxD, minK };
}
for (const R of [20, 50, 120, 300]) {
  let best = 0, info = null;
  for (let k = 40; k <= 330; k += 2) {
    const r = lapCircle(R, k, DT);
    if (r.maxD < 6 && r.minK > k - 6) { best = k; info = r; }
  }
  console.log('R=%sm: max sustained keyboard-driven speed %s km/h (%s g), max |d| %sm', R, best, ((best / KMH) ** 2 / R / 9.81).toFixed(2), info ? info.maxD.toFixed(2) : '-');
}
// --- grass
{
  const t = straight(20000, false);
  const car = F1.createCar(); car.reset(t, 10); car.state.x = 9; car.state.speed = 300 / KMH;
  let log = [];
  for (let i = 0; i <= 600; i++) { car.update(DT, { up: true }, t); if (i % 120 === 0) log.push((i / 60) + 's:' + (car.state.speed * KMH).toFixed(0)); }
  console.log('grass, full throttle from 300 km/h: %s  onGrass=%s', log.join(' '), car.state.onGrass);
  const c2 = F1.createCar(); c2.reset(t, 10); c2.state.x = 9;
  for (let i = 0; i < 1200; i++) c2.update(DT, { up: true }, t);
  console.log('grass from standstill, 20 s full throttle: %s km/h', (c2.state.speed * KMH).toFixed(1));
}
// --- walls
{
  let worst = 0, rows = [];
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 20]) {
    for (const deg of [2, 5, 10, 20, 30, 45, 60, 75, 90]) {
      for (const side of [1, -1]) {
        for (const kind of ['straight', 'circle']) {
          const t = kind === 'straight' ? straight(4000, true) : circle(80, true);
          const car = F1.createCar(); car.reset(t, 20);
          car.state.heading += side * deg * Math.PI / 180; car.state.speed = 300 / KMH;
          let maxAbs = 0, hitMax = 0, firstAfter = null, t0 = 0;
          for (let i = 0; i < Math.round(4 / dt); i++) {
            car.update(dt, { up: true }, t);
            const chk = t.locate(car.state.x, car.state.z, -1);
            maxAbs = Math.max(maxAbs, Math.abs(chk.d));
            if (car.state.hit > 0) { hitMax = Math.max(hitMax, car.state.hit); if (!t0) t0 = i; }
            if (t0 && firstAfter === null && i >= t0 + Math.round(0.25 / dt)) firstAfter = car.state.speed * KMH;
            if (!isFinite(car.state.x + car.state.z + car.state.heading + car.state.speed)) throw new Error('NaN');
          }
          worst = Math.max(worst, maxAbs);
          if (dt === 1 / 20 && side === 1 && kind === 'straight') rows.push(deg + 'deg: hit ' + hitMax.toFixed(2) + ', ' + (firstAfter === null ? '?' : firstAfter.toFixed(0)) + ' km/h 0.25s after');
        }
      }
    }
  }
  console.log('wall @300 km/h (dt=1/20, straight): ' + rows.join(' | '));
  console.log('wall: worst |d| seen over all angles/sides/dt/straight+circle = %s (limit 11, wall 12)', worst.toFixed(4));
  if (worst > 11.05) throw new Error('TUNNEL');
  // reversing into wall
  const t = straight(4000, true), car = F1.createCar(); car.reset(t, 100); car.state.heading += Math.PI / 2 + 0.3; // facing away from +n... reverse goes toward +x? heading PI/2 faces +x, so reverse goes -x
  let m = 0; for (let i = 0; i < 900; i++) { car.update(DT, { down: true }, t); m = Math.max(m, Math.abs(car.state.d)); }
  console.log('reverse into wall: max |d| %s, speed %s', m.toFixed(3), car.state.speed.toFixed(2));
  // no wall flag => no collision
  const t2 = straight(4000, false), c2 = F1.createCar(); c2.reset(t2, 20); c2.state.heading += 0.5; c2.state.speed = 80;
  for (let i = 0; i < 120; i++) c2.update(DT, none, t2);
  console.log('no wall flags: d after 2 s = %s (passes through), hit=%s', c2.state.d.toFixed(1), c2.state.hit);
}
// --- v6: battery (ERS), pit limiter, gears, a puncture (the rest above is the v5 car, unchanged by v6)
{
  const t = straight(40000, false), E = F1.REF_SPEC.ers;
  const car = F1.createCar(); car.reset(t, 0); car.setBattery(1);
  let time = 0, t100 = null, t200 = null, t300 = null, empty = null;
  while (time < 60) {
    car.update(DT, { up: true, boost: true }, t); time += DT;
    const k = car.state.speed * KMH;
    if (t100 === null && k >= 100) t100 = time;
    if (t200 === null && k >= 200) t200 = time;
    if (t300 === null && k >= 300) t300 = time;
    if (empty === null && car.state.battery === 0) empty = { time, kmh: k };
  }
  console.log('ERS power %s W/kg, store %s J/kg (%s s), harvest up to %s W/kg', E.power.toFixed(1), E.store.toFixed(0), (E.store / E.power).toFixed(1), E.harvest);
  console.log('boost from standstill, full battery: 0-100 %ss  0-200 %ss  0-300 %ss, %s km/h after 60 s (perf.topSpeedBoost %s), empty after %ss at %s km/h',
    t100.toFixed(2), t200.toFixed(2), t300.toFixed(2), (Math.max(car.state.speed, 0) * KMH).toFixed(1), (car.perf.topSpeedBoost * KMH).toFixed(1), empty.time.toFixed(1), empty.kmh.toFixed(1));
  const c2 = F1.createCar(); c2.reset(t, 0); c2.setBattery(0); c2.state.speed = 300 / KMH;
  while (c2.state.speed > 0.1) c2.update(DT, { down: true }, t);
  console.log('braking from 300 to a stop harvests %s %% of the store', (c2.state.battery * 100).toFixed(1));
  const c3 = F1.createCar(); c3.reset(t, 0); let max = 0;
  for (let i = 0; i < 600; i++) { c3.update(DT, { up: true, limiter: true }, t); max = Math.max(max, c3.state.speed * KMH); }
  console.log('pit limiter (80 km/h without a pit lane): max %s, holding %s km/h', max.toFixed(2), (c3.state.speed * KMH).toFixed(2));
  const c4 = F1.createCar(); c4.reset(t, 0); const shifts = [];
  for (let i = 0; i < 60 * 30; i++) { const g = c4.state.gear; c4.update(DT, { up: true }, t); if (c4.state.gear !== g) shifts.push(c4.state.gear + '@' + (c4.state.speed * KMH).toFixed(0)); }
  console.log('gears on a full-throttle launch: %s, rpm at 330 km/h %s', shifts.join(' '), c4.state.rpm.toFixed(0));
}
