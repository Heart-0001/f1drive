global.window = global;
require('C:/Users/user/Desktop/f1drive/js/car.js');
const F1 = global.F1, P = F1.CAR_PERF, DT = 1 / 120, D2R = Math.PI / 180;
// straight track along +z with a height profile y(z) and a constant bank
function strip(yFn, bank, len) {
  const a = [];
  for (let i = 0; i * 2 <= len; i++) a.push({ x: 0, z: i * 2, tx: 0, tz: 1, nx: 1, nz: 0, s: i * 2, y: yFn(i * 2), bank: bank || 0, wallPos: false, wallNeg: false, halfW: 1e6 });
  return { samples: a, halfWidth: 1e6, wallDist: 1e6, locate(x, z) { const i = Math.max(0, Math.min(a.length - 1, Math.round(z / 2))); return { index: i, d: x }; } };
}
// circle turning LEFT (n = inside). bank > 0 = left (inside) higher = off-camber; bank < 0 = banked in.
function circle(R, bank) {
  const n = Math.round(2 * Math.PI * R / 2), a = [];
  for (let i = 0; i < n; i++) { const h = i / n * 2 * Math.PI; const tx = Math.sin(h), tz = Math.cos(h), nx = Math.cos(h), nz = -Math.sin(h);
    a.push({ x: -nx * R, z: -nz * R, tx, tz, nx, nz, s: i * 2, y: 0, bank, wallPos: false, wallNeg: false, halfW: 1e6 }); }
  return { samples: a, halfWidth: 1e6, wallDist: 1e6, locate(x, z, hint) { let b = 0, bd = 1e18; for (let i = 0; i < n; i++) { const d = (x - a[i].x) ** 2 + (z - a[i].z) ** 2; if (d < bd) { bd = d; b = i; } } return { index: b, d: (x - a[b].x) * a[b].nx + (z - a[b].z) * a[b].nz }; } };
}
console.log('--- max cornering speed, 100 m radius (analytic from CAR_PERF.maxLatAccel, and measured in the sim)');
for (const [label, bank] of [['flat', 0], ['6 deg banked in', -6 * D2R], ['6 deg off-camber', 6 * D2R], ['3 deg banked in', -3 * D2R]]) {
  let lo = 1, hi = 95; for (let k = 0; k < 50; k++) { const v = (lo + hi) / 2; if (v * v / 100 <= P.maxLatAccel(v, bank, 0, 0, 1)) lo = v; else hi = v; }
  // sim: hold the radius-100 circle with a P steering controller, ramp speed until it runs wide by > 3 m
  const tr = circle(100, bank), car = F1.createCar(), st = car.state; car.reset(tr, 0);
  let vmax = 0, target = 20;
  for (let t = 0; t < 240; t += DT) {
    target = 20 + t * 0.3;
    const s = tr.samples[st.sampleIndex];
    const err = Math.atan2(s.tx, s.tz) - st.heading + (-st.d) * 0.08; let e = Math.atan2(Math.sin(err), Math.cos(err));
    car.update(DT, { up: st.speed < target, down: false, left: e > 0.005, right: e < -0.005 }, tr);
    if (Math.abs(st.d) > 3) break; vmax = st.speed;
  }
  console.log(`  ${label.padEnd(18)} analytic ${(lo * 3.6).toFixed(1)} km/h (${(lo * lo / 100 / 9.81).toFixed(2)} g)   sim: holds the circle up to ${(vmax * 3.6).toFixed(0)} km/h`);
}
console.log('--- lateral limit table (g): speed | flat | 6deg in | 6deg off | crest k=1/600 | dip k=-1/600');
for (const k of [100, 200, 300]) { const v = k / 3.6; console.log(`  ${k} km/h  ${(P.maxLatAccel(v, 0, 0, 0, 1) / 9.81).toFixed(2)}  ${(P.maxLatAccel(v, -6 * D2R, 0, 0, 1) / 9.81).toFixed(2)}  ${(P.maxLatAccel(v, 6 * D2R, 0, 0, 1) / 9.81).toFixed(2)}  ${(P.maxLatAccel(v, 0, 0, 1 / 600, 1) / 9.81).toFixed(2)}  ${(P.maxLatAccel(v, 0, 0, -1 / 600, 1) / 9.81).toFixed(2)}`); }
console.log('--- braking 300 -> 100 km/h');
const Z0 = 1000;
const profiles = {
  'flat': z => 0,
  '8% downhill': z => -0.08 * z,
  '8% uphill': z => 0.08 * z,
  'over a crest (+6% -> -6% in 120 m, R=1000 m)': z => { const u = z - Z0; return u < 0 ? 0.06 * u : (u < 120 ? 0.06 * u - u * u / 2000 : 0.06 * 120 - 7.2 - 0.06 * (u - 120)); },
  'sharp crest (+8% -> -8% in 60 m, R=375 m)': z => { const u = z - Z0; return u < 0 ? 0.08 * u : (u < 60 ? 0.08 * u - u * u / 750 : 0.08 * 60 - 4.8 - 0.08 * (u - 60)); },
  'through a dip (-6% -> +6% in 120 m)': z => { const u = z - Z0; return u < 0 ? -0.06 * u : (u < 120 ? -0.06 * u + u * u / 2000 : -7.2 + 7.2 + 0.06 * (u - 120)); }
};
for (const name in profiles) {
  const tr = strip(profiles[name], 0, 4000), car = F1.createCar(), st = car.state; car.reset(tr, 0);
  st.z = Z0 - 30; st.speed = 300 / 3.6; tr.locate(0, st.z); car.update(1e-6, {}, tr);
  for (let i = 0; i < 40; i++) { st.speed = 300 / 3.6; car.update(DT, { up: true }, tr); } st.speed = 300 / 3.6;   // settle attitude / curvature
  const z0 = st.z; let t = 0, minDec = 1e9, maxDec = 0, bad = false;
  while (st.speed > 100 / 3.6 && t < 30) { const v = st.speed; car.update(DT, { down: true }, tr); t += DT; const dec = (v - st.speed) / DT; minDec = Math.min(minDec, dec); maxDec = Math.max(maxDec, dec); if (!Number.isFinite(st.speed + st.y + st.pitch)) bad = true; }
  console.log(`  ${name.padEnd(46)} ${(st.z - z0).toFixed(1)} m in ${t.toFixed(2)} s, decel ${(minDec / 9.81).toFixed(2)}..${(maxDec / 9.81).toFixed(2)} g${bad ? ' NaN!' : ''}`);
}
console.log('--- very sharp crest at 300 km/h, full lock left (a_n floor): stability');
{
  const tr = strip(z => { const u = z - Z0; return u < 0 ? 0.15 * u : (u < 30 ? 0.15 * u - u * u / 200 : -0.15 * (u - 30)); }, 0, 4000), car = F1.createCar(), st = car.state; car.reset(tr, 0);
  st.z = Z0 - 60; st.speed = 300 / 3.6; let maxYaw = 0, maxDp = 0, ph = st.heading, pp = st.pitch, bad = false;
  for (let t = 0; t < 3; t += DT) { car.update(DT, { up: true, left: true }, tr); maxYaw = Math.max(maxYaw, Math.abs(st.heading - ph) / DT); maxDp = Math.max(maxDp, Math.abs(st.pitch - pp) / DT); ph = st.heading; pp = st.pitch; if (!Number.isFinite(st.x + st.z + st.y + st.speed + st.heading + st.pitch + st.roll)) bad = true; }
  console.log(`  finite: ${!bad}, max yaw rate ${maxYaw.toFixed(2)} rad/s, max pitch rate ${maxDp.toFixed(2)} rad/s, speed ${(st.speed * 3.6).toFixed(0)} km/h`);
}
