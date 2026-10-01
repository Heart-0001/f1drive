// node test/pit.test.js — pit stops (js/pit.js), pure logic: a car driven along stub pit lanes (the contract's
// track.pit on a straight and on a curve) with an injected clock (the dt of every update) and a seeded random.
'use strict';
const assert = require('assert');
const createPit = require('../js/pit.js');

let failed = 0;
function test(name, fn) {
  try { const note = fn(); console.log('ok   ' + name + (note ? '  ' + note : '')); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack)); }
}

const DT = 1 / 128;                     // s per update(): exact in binary, so the service clock has no rounding
const KMH = 1 / 3.6;
const EVENTS = ['enter', 'exit', 'speeding', 'serviceStart', 'serviceDone', 'penaltyStart', 'penaltyDone', 'serviceAbort'];
const STATE_KEYS = ['inLane', 'speeding', 'inBox', 'service', 'stops', 'pending', 'boxAhead', 'boxPassed', 'visit',
  'flagged', 'served', 'slot', 'limitKmh'];
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// A closed loop of ~2 m samples with a pit lane shaped as js/track.js builds it (contract: "js/track.js additions
// — pit lane"). Positions are metres along the lap from the start / finish line (sample 0); negative = before it.
//   'stadium': 1000 m straights joined by 150 m radius left-handers; the lane beside the main straight (which
//              holds the line), on the right (side -1) by default. Default lane: entry line 200 m before the
//              start / finish line, exit line 100 m after it, so the sample index wraps inside the lane and the
//              16 boxes (7 m apart, box 1 = slot 0 nearest the exit) sit on both sides of the line.
//   'circle':  one constant 160 m radius left-hander; the lane on the inside (side +1): a curved lane.
// Cross-section from the centreline outwards: road edge 7 m, pit wall 8.0..8.5 m (open for 4 samples after the
// entry line and before the exit line), driving lane centre 12 m (half width 3.5), boxes at 18 m, garage face 21 m.
function makeTrack(o) {
  o = Object.assign({ shape: 'stadium', side: -1, sEntry: -200, sExit: 100, taper: 60, limitKmh: 80 }, o);
  let total, pointAt;
  if (o.shape === 'circle') {
    const R = 160;
    total = 2 * Math.PI * R;
    pointAt = s => [R - R * Math.cos(s / R), R * Math.sin(s / R)];
  } else {
    const Ls = 1000, R = 150;
    total = 2 * Ls + 2 * Math.PI * R;
    pointAt = s => {
      s = ((s % total) + total) % total;
      if (s < Ls / 2) return [0, s];
      s -= Ls / 2;
      if (s < Math.PI * R) return [R - R * Math.cos(s / R), Ls / 2 + R * Math.sin(s / R)];
      s -= Math.PI * R;
      if (s < Ls) return [2 * R, Ls / 2 - s];
      s -= Ls;
      if (s < Math.PI * R) return [R + R * Math.cos(s / R), -Ls / 2 - R * Math.sin(s / R)];
      s -= Math.PI * R;
      return [0, -Ls / 2 + s];
    };
  }
  const frame = s => {
    const p = pointAt(s), a = pointAt(s - 0.01), b = pointAt(s + 0.01);
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz);
    tx /= l; tz /= l;
    return { x: p[0], z: p[1], tx, tz, nx: tz, nz: -tx };      // n = driver's left
  };
  const N = Math.round(total / 2), ds = total / N;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const f = frame(i * ds);
    samples.push({ x: f.x, z: f.z, tx: f.tx, tz: f.tz, nx: f.nx, nz: f.nz, s: i * ds, halfW: 7 });
  }
  const cyc = v => ((v % N) + N) % N;
  const idx = s => cyc(Math.round(s / ds));
  const E = idx(o.sEntry), X = idx(o.sExit), F = idx(o.sEntry - o.taper), T = idx(o.sExit + o.taper);
  const L = cyc(X - E);
  const lp = i => { const u = cyc(i - E); return u <= L + (N - L) / 2 ? u : u - N; };    // samples from the entry line
  const lo = -cyc(E - F), hi = cyc(T - E), sd = o.side;
  const boxes = [];
  for (let k = 0; k < 16; k++) {
    const s = o.sExit - 30 - 7 * k, f = frame(s);
    boxes.push({ slot: k, index: idx(s), d: sd * 18, x: f.x + f.nx * sd * 18, y: 0, z: f.z + f.nz * sd * 18,
      heading: Math.atan2(f.tx, f.tz), s });                   // (s: the stub's own bookkeeping)
  }
  const pit = {
    side: sd, limitKmh: o.limitKmh, from: F, to: T, entry: E, exit: X,
    laneD(i) {
      const p = lp(i);
      if (p < lo || p > hi) return NaN;
      if (p < 0) return sd * (7 + 5 * (p - lo) / -lo);
      if (p > L) return sd * (12 - 5 * (p - L) / (hi - L));
      return sd * 12;
    },
    laneHalfW: 3.5,
    wallD(i) { const p = lp(i); return p > 4 && p < L - 4 ? sd * 8.25 : NaN; },
    wallHalfT: 0.25,
    boxes,
    inLane(i, d) { const p = lp(i); return p >= 0 && p <= L && sd * d > 8 && sd * d < 21; },
    contains(x, z) {
      let best = 0, bd = Infinity;
      samples.forEach((a, i) => { const e = (x - a.x) ** 2 + (z - a.z) ** 2; if (e < bd) { bd = e; best = i; } });
      const a = samples[best], d = (x - a.x) * a.nx + (z - a.z) * a.nz, p = lp(best);
      return p >= lo && p <= hi && sd * d > 7 && sd * d < 21;
    }
  };
  return { samples, length: total, pit, N, ds, frame, idx, lp, E, X, L, o, boxes };   // boxes: kept when pit is null
}

const STRAIGHT = makeTrack();                                   // lane across the start / finish line
const SHIFTED = makeTrack({ sEntry: 100, sExit: 400 });         // the same lane, clear of the line
const CURVED = makeTrack({ shape: 'circle', side: 1, sEntry: 150, sExit: 450 });

// A car driven over a stub track: `s` metres along the lap, `lat` metres to the left of the centreline. Every
// step() feeds the pit exactly as main.js does (one update per physics step) and checks what must always hold.
// o.main (or r.main = true): go() holds the car as main.js does while pit.state.service is set (a service, or a
// penalty hold at the exit line): the clock runs, the car stays where it is, then the drive goes on.
function rig(track, o) {
  o = o || {};
  const pit = createPit({ random: o.random || mulberry32(7), boxBack: o.boxBack });
  const car = { x: 0, y: 0, z: 0, heading: 0, speed: 0, sampleIndex: 0, d: 0, steer: 0 };
  const st = pit.state;
  const r = {
    pit, car, track, st, slot: o.slot === undefined ? 0 : o.slot, log: [], steps: 0, s: 0, lat: 0, main: !!o.main, held: 0,
    open: false, svc: false, visitSpeeding: 0, visitStarts: 0,
    // puts the car there (an R reset when it jumps), heading `off` radians left of the road direction
    put(s, lat, speed, off) {
      const f = track.frame(s), i = track.idx(s), a = track.samples[i];
      car.x = f.x + f.nx * lat; car.z = f.z + f.nz * lat;
      car.heading = Math.atan2(f.tx, f.tz) + (off || 0);
      car.speed = speed || 0; car.sampleIndex = i;
      car.d = (car.x - a.x) * a.nx + (car.z - a.z) * a.nz;       // what track.locate() reports
      r.s = s; r.lat = lat;
      return r;
    },
    step(dt, carState, trk) {
      const ev = pit.update(dt === undefined ? DT : dt, carState === undefined ? car : carState,
        trk === undefined ? track : trk, { slot: r.slot, limiter: true });
      r.steps++;
      assert(ev === null || EVENTS.includes(ev), 'event ' + ev);
      assert.strictEqual(pit.state, st, 'the state object is kept');
      if (ev) {
        r.log.push(ev);
        // events come out in the order they happened: enter / exit alternate, one speeding per visit, a service
        // ends (done / abort) before the next one starts, at most one service started per visit unless aborted
        if (ev === 'enter') { assert(!r.open, 'enter twice'); r.open = true; r.visitSpeeding = 0; r.visitStarts = 0; }
        if (ev === 'exit') { assert(r.open, 'exit without enter'); r.open = false; }
        // one speeding per visit, and one more after its stop began
        if (ev === 'speeding') { assert(r.open, 'speeding outside a visit'); assert(++r.visitSpeeding === 1, 'speeding twice'); }
        if (ev === 'serviceStart') { assert(!r.svc && r.open); r.svc = 'service'; r.visitSpeeding = 0; assert(++r.visitStarts === 1, 'two services in a visit'); }
        if (ev === 'penaltyStart') { assert(!r.svc && r.open); r.svc = 'hold'; }
        if (ev === 'serviceDone') { assert.strictEqual(r.svc, 'service'); r.svc = false; }
        if (ev === 'penaltyDone') { assert.strictEqual(r.svc, 'hold'); r.svc = false; }
        if (ev === 'serviceAbort') { assert(r.svc); if (r.svc === 'service') r.visitStarts--; r.svc = false; }
      }
      assert(!st.inLane || st.visit, 'in the lane = in a visit');
      assert(!st.speeding || st.inLane, 'speeding only in the lane');
      assert(!st.inBox || st.inLane, 'in the box = in the lane');
      assert(Number.isFinite(st.pending) && st.pending >= 0, 'pending ' + st.pending);
      assert(Number.isInteger(st.stops) && st.stops >= 0);
      assert(st.boxAhead === null || Number.isFinite(st.boxAhead), 'boxAhead ' + st.boxAhead);
      assert.strictEqual(st.boxPassed, st.boxAhead !== null && st.boxAhead < -createPit.BOX_ALONG);
      if (st.service) {
        const v = st.service;
        assert(near(v.total, v.work + v.penalty) && v.left >= 0 && v.left <= v.total, JSON.stringify(v));
        if (v.work === 0) assert(v.penalty > 0 && st.visit, 'a penalty hold: ' + JSON.stringify(v));
        else { assert(v.work >= 2 && v.work <= 4.5 && v.penalty >= 0); assert(st.served && st.visit); }
      }
      return ev;
    },
    // drives in a straight line in (s, lat) to (s1, lat1) at v m/s; backwards (negative speed) when s1 < s
    go(s1, lat1, v) {
      const s0 = r.s, l0 = r.lat, dS = s1 - s0, dL = lat1 - l0;
      const n = Math.max(1, Math.ceil(Math.hypot(dS, dL) / (v * DT)));
      const off = dS === 0 ? 0 : Math.atan(dL / dS);
      for (let k = 1; k <= n; k++) {
        while (r.main && st.service) { car.speed = 0; r.step(); r.held++; }      // main.js: held, the clock runs
        r.put(s0 + dS * k / n, l0 + dL * k / n, dS < 0 ? -v : v, off); r.step();
      }
      while (r.main && st.service) { car.speed = 0; r.step(); r.held++; }
      return r;
    },
    hold(n) { car.speed = 0; for (let k = 0; k < n; k++) r.step(); return r; },
    // steps at rest until `ev` comes out; -> number of steps it took
    until(ev, max) {
      car.speed = 0;
      for (let k = 1; k <= (max || 10000); k++) if (r.step() === ev) return k;
      throw new Error('no ' + ev + ' in ' + (max || 10000) + ' steps; log ' + r.log.join(' '));
    },
    take() { return r.log.splice(0, r.log.length); },
    // standard manoeuvres over the stub's lane
    side() { return track.o.side; },
    approach(v) { const t = track.o; return r.put(t.sEntry - 150, 0, v || 60).go(t.sEntry - t.taper, 0, v || 60); },
    enter(v) { const t = track.o; return r.approach(v).go(t.sEntry, 12 * r.side(), v || 20).go(t.sEntry + 10, 12 * r.side(), v || 20); },
    toBox(slot, v) {
      const b = track.boxes[slot], sd = r.side();
      return r.go(b.s - 20, 12 * sd, v || 20).go(b.s - 4, 18 * sd, 8).go(b.s, 18 * sd, 2);
    },
    leaveBox() { return r.go(r.s + 16, 12 * r.side(), 8); },
    out(v) {
      const t = track.o;
      return r.go(t.sExit, 12 * r.side(), v || 20).go(t.sExit + t.taper, 0, v || 20).go(t.sExit + 150, 0, 60);
    },
    lap() { const t = track.o; return r.go(t.sEntry - 150 + track.length, 0, 80).put(t.sEntry - 150, 0, 80); }
  };
  return r;
}

/* ---------------------------------------------------------------- */

test('API: F1.createPit / module export, reset, update, state fields, constants', () => {
  assert.strictEqual(typeof createPit, 'function');
  assert.strictEqual(globalThis.F1.createPit, createPit);
  const pit = createPit();
  assert.strictEqual(typeof pit.reset, 'function');
  assert.strictEqual(typeof pit.update, 'function');
  assert.deepStrictEqual(Object.keys(pit.state).sort(), STATE_KEYS.slice().sort());
  assert.deepStrictEqual(STATE_KEYS.map(k => pit.state[k]),
    [false, false, false, null, 0, 0, null, false, false, false, false, -1, 80]);
  assert.deepStrictEqual([createPit.LIMIT_TOL, createPit.PENALTY_S, createPit.REST_SPEED, createPit.BOX_ALONG,
    createPit.BOX_ACROSS, Math.round(createPit.BOX_HEADING * 180 / Math.PI)], [3, 5, 0.5, 2.5, 1.2, 20]);
  assert.strictEqual(typeof createPit.serviceTime, 'function');
  createPit({ random: 'x' }).update(DT, {}, STRAIGHT, {});        // a random that is not a function: Math.random
  // the stub lanes are what the tests think they are
  assert(STRAIGHT.E > STRAIGHT.X && STRAIGHT.L === 150, 'the lane wraps: entry ' + STRAIGHT.E + ' exit ' + STRAIGHT.X);
  assert(SHIFTED.E < SHIFTED.X && SHIFTED.L === 150);
  assert(STRAIGHT.pit.boxes[0].index < 100 && STRAIGHT.pit.boxes[15].index > STRAIGHT.N - 30, 'boxes on both sides of the line');
});

test('a full visit: enter, limiter speed, stop in the own box, service counts down with the clock, done, exit', () => {
  for (const [name, track] of [['straight across the line', STRAIGHT], ['straight', SHIFTED], ['curved', CURVED]]) {
    for (const slot of [0, 5, 15]) {
      const r = rig(track, { slot });
      r.approach();
      assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit], [[], false, false], name + ': nothing on the track');
      r.go(track.o.sEntry, 12 * r.side(), 80 * KMH);
      assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit, r.st.speeding], [['enter'], true, true, false], name);
      assert.strictEqual(r.st.limitKmh, 80);
      // boxAhead counts down towards the own box
      let prev = Infinity;
      const b = track.pit.boxes[slot];
      while (r.s < b.s - 20) {
        r.go(Math.min(r.s + 5, b.s - 20), 12 * r.side(), 80 * KMH);
        assert(r.st.boxAhead < prev && r.st.boxAhead > 15, name + ' ' + r.st.boxAhead);
        prev = r.st.boxAhead;
      }
      r.toBox(slot);
      assert.strictEqual(r.st.inBox, true, name + ' slot ' + slot + ': in the box');
      assert(near(r.st.boxAhead, 0, 0.05), name + ' boxAhead at the box ' + r.st.boxAhead);
      assert.deepStrictEqual(r.take(), [], 'no service while rolling in');
      assert.strictEqual(r.step(), null, 'still rolling at 2 m/s on the box point: nothing');
      r.car.speed = 0;
      assert.strictEqual(r.step(), 'serviceStart', 'the first step at rest starts the service');
      const sv = r.st.service;
      assert(sv && sv.penalty === 0 && sv.total === sv.work && sv.left === sv.total && sv.total >= 2 && sv.total <= 4.5);
      assert.deepStrictEqual([r.st.served, r.st.stops], [true, 0]);
      for (let k = 1; k * DT < sv.total - 1e-9; k++) {
        assert.strictEqual(r.step(), null);
        assert(near(sv.left, sv.total - k * DT, 1e-9), 'left = total - elapsed');
        assert.strictEqual(r.st.service, sv, 'the same service object all along');
      }
      assert.strictEqual(r.step(), 'serviceDone', 'at total / dt steps');
      assert.deepStrictEqual([r.st.service, sv.left, r.st.stops], [null, 0, 1]);
      r.take();
      r.leaveBox().out();
      assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit, r.st.boxAhead], [['exit'], false, false, null], name);
      assert.strictEqual(r.st.stops, 1);
    }
  }
});

test('the service time is the injected random draw; dt that is not a positive number does not count', () => {
  const seed = 99, r = rig(SHIFTED, { random: mulberry32(seed) });
  r.enter().toBox(0).hold(1);
  const want = createPit.serviceTime(mulberry32(seed));
  assert(r.st.service && r.st.service.work === want);
  const left = r.st.service.left;
  for (const bad of [NaN, -1, 0, undefined, null, Infinity, -Infinity, '0.5']) r.step(bad === undefined ? NaN : bad);
  assert.strictEqual(r.st.service.left, left);
  r.step(0.25);
  assert(near(r.st.service.left, left - 0.25));
  r.step(100);                                          // one huge step ends it
  assert.deepStrictEqual([r.take().pop(), r.st.service, r.st.stops], ['serviceDone', null, 1]);
});

test('speed limit: over by more than 3 km/h, once per visit, from the entry line to the exit line', () => {
  const r = rig(SHIFTED, { main: true });
  r.approach(90).go(SHIFTED.o.sEntry - 1, 12 * r.side(), 300 * KMH);     // flat out up to the line: allowed
  assert.deepStrictEqual([r.take(), r.st.speeding, r.st.pending], [[], false, 0]);
  r.go(SHIFTED.o.sEntry + 20, 12 * r.side(), 82.99 * KMH);
  assert.deepStrictEqual([r.take(), r.st.speeding, r.st.flagged], [['enter'], false, false], '82.99 km/h is fine');
  r.go(r.s + 10, r.lat, 83.01 * KMH);
  assert.deepStrictEqual([r.take(), r.st.speeding, r.st.flagged, r.st.pending], [['speeding'], true, true, 5]);
  r.go(r.s + 10, r.lat, 70 * KMH);
  assert.deepStrictEqual([r.st.speeding, r.st.flagged, r.st.pending], [false, true, 5], 'live flag off, penalty stays');
  r.go(r.s + 30, r.lat, 120 * KMH);
  assert.deepStrictEqual([r.take(), r.st.speeding, r.st.pending], [[], true, 5], 'flagged once per visit');
  r.go(r.s - 10, r.lat, 90 * KMH);
  assert.deepStrictEqual([r.take(), r.st.pending], [[], 5], 'reversing counts by the magnitude, still once');
  r.out(200 * KMH);                                         // no stop: the 5 s are served at the exit line
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.flagged, r.st.stops], [['penaltyStart', 'penaltyDone', 'exit'], 0, false, 0]);
  // flat out on the track beside the lane: nothing
  r.put(SHIFTED.o.sEntry - 100, 0, 80).go(SHIFTED.o.sExit + 100, 0, 80);
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.visit], [[], 0, false]);
  // a lane with its own limit
  const t60 = makeTrack({ sEntry: 100, sExit: 400, limitKmh: 60 }), k = rig(t60);
  k.enter(62 * KMH);
  assert.deepStrictEqual([k.take(), k.st.limitKmh], [['enter'], 60]);
  k.go(k.s + 5, k.lat, 64 * KMH);
  assert.deepStrictEqual(k.take(), ['speeding']);
});

test('speeding at the entry: enter and speeding come out one per update, in order', () => {
  const r = rig(SHIFTED);
  r.approach(100 * KMH);
  const t = SHIFTED.o, sd = r.side();
  r.go(t.sEntry - 1, 12 * sd, 100 * KMH);
  r.put(t.sEntry + 1, 12 * sd, 100 * KMH);
  assert.strictEqual(r.step(), 'enter');
  assert.deepStrictEqual([r.st.flagged, r.st.pending], [true, 5], 'the state is already up to date');
  r.car.speed = 10;                                         // braked hard since: the queued event still comes
  assert.strictEqual(r.step(), 'speeding');
  assert.strictEqual(r.step(), null);
});

test('speeding and stopping in the same visit: the 5 s hold is added to that stop, then gone', () => {
  const r = rig(STRAIGHT);
  r.enter(100 * KMH);
  assert.deepStrictEqual(r.take(), ['enter', 'speeding']);
  r.toBox(0, 70 * KMH).hold(1);
  const sv = r.st.service;
  assert.deepStrictEqual([r.take(), sv.penalty, r.st.pending], [['serviceStart'], 5, 0]);
  assert(near(sv.total, sv.work + 5));
  const n = r.until('serviceDone');
  assert.strictEqual(n, Math.ceil((sv.total - 1e-9) / DT), 'held for work + 5 s');
  assert(n * DT > 7);
  r.leaveBox().out();
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.stops], [['serviceDone', 'exit'], 0, 1]);
  // next visit, clean: no hold
  r.lap().enter().toBox(0).hold(1);
  assert.strictEqual(r.st.service.penalty, 0);
});

// Review D4: the hold used to wait for a NEXT stop, so speeding with no stop to come (after the last stop, a no-stop
// race, qualifying) was free: flat out from box 16 to the exit gained up to 7.6 s at Monza. Now it is served at the exit
// line of the same visit: a stop-go without tyres.
test('speeding the visit\'s stop does not serve (no stop, or after it): held at the exit line, a stop-go without tyres', () => {
  const t = STRAIGHT.o, sd = -1;
  // (a) driven through at 90 km/h: held for 5 s the moment it crosses the exit line, then on its way
  const r = rig(STRAIGHT, { slot: 3 });
  r.enter(90 * KMH).go(t.sExit - 3, 12 * sd, 90 * KMH);
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.service], [['enter', 'speeding'], 5, null], 'nothing before the exit line');
  let ev = null;
  while (!ev) { r.put(r.s + 90 * KMH * DT, 12 * sd, 90 * KMH); ev = r.step(); }
  assert.strictEqual(ev, 'penaltyStart');
  assert.strictEqual(STRAIGHT.lp(r.car.sampleIndex), STRAIGHT.L, 'on the exit line');
  const sv = r.st.service;
  assert.deepStrictEqual([sv.total, sv.left, sv.penalty, sv.work, r.st.pending, r.st.stops, r.st.served, r.st.visit, r.st.flagged],
    [5, 5, 5, 0, 0, 0, false, true, true]);
  const n = r.until('penaltyDone');                         // held (main.js freezes the car for any state.service)
  assert.strictEqual(n, Math.ceil((5 - 1e-9) / DT), 'held 5 s');
  assert.deepStrictEqual([r.st.service, r.st.stops, r.st.pending, r.take()], [null, 0, 0, ['penaltyStart', 'penaltyDone']], 'no serviceDone: no tyres');
  r.main = true;
  r.out();
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.stops], [['exit'], 0, 0]);
  // (b) a clean stop, then flat out from the box: speeding again (the stop began a new count), held at the exit
  r.lap().enter().toBox(3).hold(1);
  r.until('serviceDone');
  assert.deepStrictEqual([r.take(), r.st.service, r.st.stops], [['enter', 'serviceStart', 'serviceDone'], null, 1]);
  r.go(r.s + 16, 12 * sd, 30);
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.speeding], [['speeding'], 5, true]);
  r.held = 0;
  r.out(30);
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.stops, r.held], [['penaltyStart', 'penaltyDone', 'exit'], 0, 1, Math.ceil((5 - 1e-9) / DT)]);
  // (c) speeding before AND after the stop: 5 s at the stop, 5 s more at the exit line
  r.lap().enter(100 * KMH).toBox(3).hold(1);
  assert.deepStrictEqual([r.take(), r.st.service.penalty, r.st.pending], [['enter', 'speeding', 'serviceStart'], 5, 0]);
  r.until('serviceDone');
  r.leaveBox().go(r.s + 30, 12 * sd, 30).out(30);
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.stops], [['serviceDone', 'speeding', 'penaltyStart', 'penaltyDone', 'exit'], 0, 2]);
  // (d) a clean visit after it: no hold anywhere
  r.lap().enter().out();
  assert.deepStrictEqual([r.take(), r.st.pending], [['enter', 'exit'], 0]);
  // (e) a hold the car is not held for (moved more than 1 m): aborted, the rest waits; no new hold on the same crossing;
  //     the next visit's stop serves it
  const k = rig(SHIFTED, { slot: 2 });
  k.enter(100 * KMH).go(SHIFTED.o.sExit + 4, 12 * sd, 100 * KMH);
  assert.deepStrictEqual(k.take(), ['enter', 'speeding', 'penaltyStart', 'serviceAbort'], 'and no second speeding: one offence');
  assert(k.st.pending > 4.9 && k.st.pending < 5 && k.st.service === null, 'pending ' + k.st.pending);
  k.out();
  const left = k.st.pending;
  k.lap().enter().toBox(2).hold(1);
  assert.deepStrictEqual([k.take(), k.st.service.penalty, k.st.pending], [['exit', 'enter', 'serviceStart'], left, 0]);
  // (f) reversed out over the entry line after speeding: the visit ends with the hold pending; the next visit's exit
  //     line serves it
  const q = rig(SHIFTED, { main: true });
  q.enter(100 * KMH).go(SHIFTED.o.sEntry - 12, 12 * sd, 5);
  assert.deepStrictEqual([q.take(), q.st.pending, q.st.visit], [['enter', 'speeding', 'exit'], 5, false]);
  q.enter().out();
  assert.deepStrictEqual([q.take(), q.st.pending], [['enter', 'penaltyStart', 'penaltyDone', 'exit'], 0]);
  // (g) into the lane BACKWARDS over the exit line with a hold pending: no hold until it crosses the line forwards
  const g = rig(SHIFTED, { main: true });
  g.enter(100 * KMH).go(SHIFTED.o.sEntry - 12, 12 * sd, 5);
  g.put(SHIFTED.o.sExit + 12, 12 * sd, -3).go(SHIFTED.o.sExit - 20, 12 * sd, 3);
  assert.deepStrictEqual([g.take(), g.st.pending, g.st.visit], [['enter', 'speeding', 'exit', 'enter'], 5, true]);
  g.out();
  assert.deepStrictEqual([g.take(), g.st.pending], [['penaltyStart', 'penaltyDone', 'exit'], 0]);
});

test('wrong box, crooked, astride, outside a box, still rolling: no service; where the own box is', () => {
  const r = rig(STRAIGHT, { slot: 5 });
  const B = STRAIGHT.pit.boxes, sd = r.side();
  r.enter();
  // somebody else's box after ours (box 4, slot 3: nearer the exit)
  r.toBox(3).hold(60);
  assert.deepStrictEqual([r.take(), r.st.inBox, r.st.service, r.st.inLane], [['enter'], false, null, true]);
  assert(near(r.st.boxAhead, B[5].s - B[3].s, 0.05) && r.st.boxAhead < 0 && r.st.boxPassed, 'passed by 14 m: ' + r.st.boxAhead);
  // and one before it
  r.go(B[7].s, 18 * sd, 3).hold(60);
  assert(near(r.st.boxAhead, 14, 0.05) && !r.st.boxPassed && r.st.service === null, String(r.st.boxAhead));
  // in the own box but crooked (25 degrees), astride the line (1.4 m across), 2.6 m short, still rolling
  r.go(B[5].s - 6, 18 * sd, 2);
  for (const [ds, dl, off, v] of [[0, 0, 25, 0], [0, 0, -25, 0], [0, 1.4, 0, 0], [0, -1.4, 0, 0], [-2.6, 0, 0, 0],
    [2.6, 0, 0, 0], [0, 0, 0, 0.6], [0, 0, 0, -0.6], [0, 0, 180, 0]]) {
    r.put(B[5].s + ds, (18 + dl) * sd, v, off * Math.PI / 180);
    r.step(); r.step();
    assert.deepStrictEqual([r.st.service, r.take()], [null, []], JSON.stringify([ds, dl, off, v]));
    assert.strictEqual(r.st.inBox, v !== 0 && ds === 0 && dl === 0 && off === 0, 'inBox ' + JSON.stringify([ds, dl, off, v]));
  }
  // just inside every tolerance, creeping at 0.45 m/s: that is a stop
  r.put(B[5].s + 2.4, (18 - 1.1) * sd, 0.45, -19 * Math.PI / 180);
  assert.strictEqual(r.step(), 'serviceStart');
  assert.strictEqual(r.st.inBox, true);
});

test('driving through without stopping; stopping twice in a visit counts once, in two visits twice', () => {
  const r = rig(CURVED, { slot: 2 });
  r.enter();
  let passedAt = null;
  const b = CURVED.pit.boxes[2];
  while (r.s < CURVED.o.sExit - 1) {
    r.go(r.s + 1, 12 * r.side(), 20);
    if (r.st.boxPassed && passedAt === null) passedAt = r.s;
  }
  assert(passedAt !== null && near(passedAt, b.s + 2.5 / 0.9, 1.5), 'passed about 2.5 m (along the inner row) after the box: ' + passedAt + ' vs ' + b.s);
  r.out();
  assert.deepStrictEqual([r.take(), r.st.stops, r.st.pending], [['enter', 'exit'], 0, 0]);
  // twice in one visit
  r.lap().enter().toBox(2).hold(1);
  r.until('serviceDone');
  r.go(r.s + 10, 18 * r.side(), 2).go(b.s, 18 * r.side(), 2).hold(1000);        // out of the box and back in, stop
  r.go(r.s - 1, 18 * r.side(), 1).go(b.s, 18 * r.side(), 1).hold(1000);
  assert.deepStrictEqual([r.take(), r.st.stops, r.st.served, r.st.inBox], [['enter', 'serviceStart', 'serviceDone'], 1, true, true]);
  r.leaveBox().out();
  r.lap().enter().toBox(2).hold(1);
  r.until('serviceDone');
  r.leaveBox().out();
  assert.deepStrictEqual([r.take(), r.st.stops], [['exit', 'enter', 'serviceStart', 'serviceDone', 'exit'], 2]);
});

test('R reset inside the lane: back on the track, the visit ends past the exit; nothing counts on the track', () => {
  const r = rig(STRAIGHT);
  r.enter().go(r.s + 40, r.lat, 20);
  r.put(r.s, 0, 0).step();                                  // R: onto the centreline, same sample, stopped
  assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit, r.st.speeding], [['enter'], false, true, false]);
  r.go(STRAIGHT.o.sExit - 1, 0, 80);                        // flat out on the track beside the lane
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.visit], [[], 0, true]);
  r.go(STRAIGHT.o.sExit + 5, 0, 80);
  assert.deepStrictEqual([r.take(), r.st.visit], [[], true], 'not yet: 6 m past the exit line');
  r.go(STRAIGHT.o.sExit + 8, 0, 80);
  assert.deepStrictEqual([r.take(), r.st.visit], [['exit'], false]);
  // R in the lane put back IN the lane (a main.js that resets to the lane centre): the visit simply goes on, the
  // speeding hold is served at the exit line
  r.main = true;
  r.lap().enter(100 * KMH);
  r.put(r.s - 1, 12 * r.side(), 0).step();
  r.go(r.s + 30, r.lat, 70 * KMH).out();
  assert.deepStrictEqual([r.take(), r.st.pending], [['enter', 'speeding', 'penaltyStart', 'penaltyDone', 'exit'], 0]);
  // R onto the track after speeding: the visit goes on (beside the lane), its exit line still holds the car
  r.lap().enter(100 * KMH).go(r.s + 20, r.lat, 70 * KMH);
  r.put(r.s, 0, 0).step();
  r.held = 0;
  r.go(STRAIGHT.o.sExit + 150, 0, 60);
  assert.deepStrictEqual([r.take(), r.st.pending, r.held], [['enter', 'speeding', 'penaltyStart', 'penaltyDone', 'exit'], 0, Math.ceil((5 - 1e-9) / DT)]);
  // R reset outside: on the track next to the lane, far away, on the grass across from it
  r.main = false;
  r.put(0, 3, 50).step(); r.put(0, 0, 0).step();
  r.put(900, 5, 50).step(); r.put(900, 0, 0).step();
  r.put(STRAIGHT.o.sEntry + 50, 25 * r.side(), 0).step(); r.put(STRAIGHT.o.sEntry + 50, 0, 0).step();
  r.put(STRAIGHT.o.sEntry + 50, -25 * r.side(), 0).step();
  assert.deepStrictEqual([r.take(), r.st.visit, r.st.pending], [[], false, 0]);
});

test('R reset (or any move) during a service: aborted, no tyres, the unserved part of the hold waits', () => {
  const r = rig(SHIFTED, { slot: 1 });
  r.enter(100 * KMH).toBox(1).hold(1);
  const sv = r.st.service;
  assert.deepStrictEqual([r.take(), sv.penalty], [['enter', 'speeding', 'serviceStart'], 5]);
  r.hold(128);                                              // 1 s of the 5 s hold served
  r.put(r.s, 0, 0);                                         // R
  assert.strictEqual(r.step(), 'serviceAbort');
  assert.deepStrictEqual([r.st.service, r.st.stops, r.st.served, r.st.inLane, r.st.visit], [null, 0, false, false, true]);
  assert(near(r.st.pending, 4, 1e-9), 'the 4 s not served yet: ' + r.st.pending);
  // back into the box in the same visit: that stop serves them
  r.go(r.s, 18 * r.side(), 2).hold(1);
  assert.deepStrictEqual(r.take(), ['serviceAbort', 'serviceStart']);
  assert(near(r.st.service.penalty, 4, 1e-9));
  // held past the penalty (work started): nothing goes back; drove off without being held
  r.hold(4 * 128 + 10);
  r.go(r.s + 1.5, r.lat, 3);
  assert.deepStrictEqual([r.take().pop(), r.st.pending, r.st.served], ['serviceAbort', 0, false]);
  // may stop again in the same visit (it got nothing)
  r.go(r.s - 1.5, r.lat, 1).hold(1);
  assert.deepStrictEqual([r.take(), r.st.service && r.st.service.penalty], [['serviceStart'], 0]);
  r.until('serviceDone');
  assert.strictEqual(r.st.stops, 1);
  // a little wobble while held (under 1 m) is no drive-off
  r.leaveBox().out().lap().enter().toBox(1).hold(1);
  r.put(r.s + 0.6, r.lat + 0.5, 0).step();
  assert(r.st.service !== null);
  r.until('serviceDone');
});

test('reversing over the entry line (and dithering on the exit line): no repeated events', () => {
  const r = rig(STRAIGHT, { main: true });
  const t = STRAIGHT.o, sd = r.side();
  r.enter(90 * KMH);
  assert.deepStrictEqual(r.take(), ['enter', 'speeding']);
  for (let k = 0; k < 20; k++) r.go(t.sEntry - 5, 12 * sd, 3).go(t.sEntry + 4, 12 * sd, 3);   // 5 m back over it
  r.go(t.sEntry + 20, 12 * sd, 95 * KMH);
  assert.deepStrictEqual([r.take(), r.st.pending, r.st.visit], [[], 5, true], 'the same visit: no enter, no second penalty');
  r.go(t.sEntry - 5, 12 * sd, 5);
  assert.deepStrictEqual([r.st.inLane, r.st.visit], [false, true]);
  r.go(t.sEntry - 12, 12 * sd, 5);                          // more than 6 m back: the visit is over
  assert.deepStrictEqual([r.take(), r.st.visit, r.st.flagged], [['exit'], false, false]);
  r.go(t.sEntry + 20, 12 * sd, 95 * KMH);
  assert.deepStrictEqual([r.take(), r.st.pending], [['enter', 'speeding'], 10], 'a new visit');
  // the exit line: over it, back, over, back ... one exit; the 10 s pending are held at the first crossing, once
  r.go(t.sExit - 2, 12 * sd, 20);
  for (let k = 0; k < 30; k++) r.go(t.sExit + 5, 12 * sd, 2).go(t.sExit - 3, 12 * sd, 2);
  assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit, r.st.pending], [['penaltyStart', 'penaltyDone'], true, true, 0], 'up to 5 m over it and back: still the visit');
  r.go(t.sExit + 50, 12 * sd, 20);
  assert.deepStrictEqual([r.take(), r.st.visit], [['exit'], false]);
  // backwards into the lane over the exit line after the visit ended: a visit of its own
  r.go(t.sExit - 10, 12 * sd, 5);
  assert.deepStrictEqual([r.take(), r.st.inLane], [['enter'], true]);
  r.go(t.sExit + 50, 12 * sd, 20);
  assert.deepStrictEqual(r.take(), ['exit']);
  // a single-step index glitch in the middle of the lane changes nothing
  r.lap().enter().go(t.sEntry + 80, 12 * sd, 20);
  r.car.sampleIndex = (r.car.sampleIndex + 700) % STRAIGHT.N; r.step();
  r.put(r.s + 0.1, r.lat, 20).step();
  assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit], [['enter'], true, true]);
});

test('the lane over the start / finish line: the same visits whether the index wraps in it or not', () => {
  const runs = [STRAIGHT, SHIFTED].map(track => {
    const r = rig(track, { slot: 14, random: mulberry32(5) });
    const b = track.pit.boxes[14], ahead = [];
    r.enter(95 * KMH);
    for (let k = 0; k < 20; k++) { r.go(r.s + 6, r.lat, 70 * KMH); ahead.push(Math.round(r.st.boxAhead * 1000)); }
    r.toBox(14).hold(1);
    const total = r.st.service.total;
    r.until('serviceDone');
    r.leaveBox().out();
    return { log: r.take(), ahead, total, stops: r.st.stops, wraps: track.pit.entry > track.pit.exit, box: b.index };
  });
  assert.deepStrictEqual([runs[0].wraps, runs[1].wraps], [true, false]);
  assert(runs[0].box > STRAIGHT.N - 20, 'box 15 is before the line in the wrapping lane: ' + runs[0].box);
  assert.deepStrictEqual(runs[0].log, ['enter', 'speeding', 'serviceStart', 'serviceDone', 'exit']);
  assert.deepStrictEqual(runs[0].log, runs[1].log);
  assert.deepStrictEqual(runs[0].ahead, runs[1].ahead, 'boxAhead the same to the mm');
  assert.strictEqual(runs[0].total, runs[1].total);
  // the car's index wraps from N - 1 to 0 in the lane without anything happening
  const r = rig(STRAIGHT);
  r.enter().go(-3, 12 * r.side(), 20);
  assert(r.car.sampleIndex > STRAIGHT.N - 3);
  r.go(3, 12 * r.side(), 20);
  assert(r.car.sampleIndex < 3);
  assert.deepStrictEqual([r.take(), r.st.inLane, r.st.visit], [['enter'], true, true]);
});

test('track.pit === null (or unusable): everything inert, nothing throws', () => {
  const noPit = Object.assign({}, STRAIGHT, { pit: null });
  const bad = [null, undefined, 0, 'track', {}, { pit: null }, noPit, { pit: {} }, { pit: { inLane: 5 } },
    { samples: STRAIGHT.samples, pit: { inLane: () => true } },                            // no entry / exit
    { samples: STRAIGHT.samples, pit: { inLane: () => true, entry: 'a', exit: 3 } },
    { samples: [], length: 0, pit: { inLane: () => true, entry: 0, exit: 3 } },
    { samples: null, pit: STRAIGHT.pit }];
  const cars = [null, undefined, {}, 5, 'car', { x: 0, z: 0, heading: 0, speed: 0, sampleIndex: 0, d: -12 }];
  const pit = createPit({ random: mulberry32(1) });
  for (const t of bad) for (const c of cars) for (const o of [undefined, null, { slot: 3 }, 'x']) {
    assert.strictEqual(pit.update(DT, c, t, o), null);
    assert.deepStrictEqual(STATE_KEYS.map(k => pit.state[k]), [false, false, false, null, 0, 0, null, false, false, false, false, -1, 80]);
  }
  // a full drive over a track without a pit
  const r = rig(noPit);
  r.enter(100 * KMH).toBox(0).hold(500).leaveBox().out();
  assert.deepStrictEqual([r.log, r.st.inLane, r.st.slot], [[], false, -1]);
  // a pit without boxes: the lane and its limit work, no stop is possible
  const noBoxes = Object.assign({}, STRAIGHT, { pit: Object.assign({}, STRAIGHT.pit, { boxes: null }) });
  const k = rig(noBoxes, { main: true });
  k.enter(100 * KMH).toBox(0).hold(500).leaveBox().out();
  assert.deepStrictEqual([k.log, k.st.pending, k.st.stops, k.st.boxAhead, k.st.slot], [['enter', 'speeding', 'penaltyStart', 'penaltyDone', 'exit'], 0, 0, null, -1]);
});

test('garbage car state: never throws, never NaN; an unreadable state changes nothing, a service keeps counting', () => {
  // unreadable: no usable sample index / d (x / z unreadable: the position cannot be judged either)
  const unreadable = [null, undefined, {}, [], 'x', 7, true, { sampleIndex: NaN, d: 0 }, { sampleIndex: 5, d: NaN },
    { sampleIndex: 'x', d: 1 }, { sampleIndex: Infinity, d: -12 }, { sampleIndex: 5, d: '-12' }, { sampleIndex: null, d: null }];
  // readable but odd: judged as what they say (somewhere on the loop, at odd speeds / headings)
  const odd = [{ sampleIndex: 1e308, d: -12, x: 1e308, z: -1e308, heading: 1e308, speed: 1e308 },
    { sampleIndex: -5, d: -12, speed: NaN }, { sampleIndex: 2.7, d: -12, x: NaN, z: 0, heading: 0, speed: 0 },
    { sampleIndex: 12, d: -12, x: 0, z: 0, heading: 'n', speed: '5' }, { sampleIndex: 12, d: -12, x: 0, z: 0, heading: 0, speed: Infinity },
    { sampleIndex: -1e9, d: 1e9, x: -1e9, z: 1e9, heading: -1e9, speed: -1e9 }];
  const r = rig(STRAIGHT, { slot: 4 });
  const snap = () => JSON.stringify(r.st);
  const feed = list => list.forEach(g => r.step(DT, g));
  for (const stage of ['track', 'lane', 'box']) {
    if (stage === 'lane') r.enter(100 * KMH).take();
    if (stage === 'box') r.toBox(4).hold(1).take();
    r.step();
    const before = snap();
    feed(unreadable);
    if (stage !== 'box') assert.strictEqual(snap(), before, stage + ': nothing changes');
  }
  const sv = r.st.service;
  assert(sv, 'stopped in the box');
  const left = sv.left;
  feed(unreadable);
  const xyBad = Object.assign({}, r.car, { x: NaN, z: undefined });      // index and d fine, position unreadable
  r.step(DT, xyBad); r.step(DT, xyBad);
  assert.strictEqual(r.st.service, sv, 'an unreadable state never aborts a service');
  assert(near(sv.left, left - (unreadable.length + 2) * DT, 1e-9), 'and the service keeps counting');
  assert.deepStrictEqual(r.take(), []);
  r.until('serviceDone');
  // the odd ones, in every situation: no throw, no NaN / Infinity anywhere in the state
  for (let k = 0; k < 3; k++) {
    feed(odd);
    for (const key of STATE_KEYS) assert(!(typeof r.st[key] === 'number' && !Number.isFinite(r.st[key])), key + ' ' + r.st[key]);
    r.put(STRAIGHT.boxes[4].s, -18, 0).step();
  }
  // absurd coordinates with a sample index in the lane of a curve (both tangent components non-zero): the distance
  // to the box overflows; boxAhead must be null, not NaN / -Infinity (step() checks it)
  const c = rig(CURVED, { slot: 4 });
  c.enter();
  for (const [big, want] of [[1.7e308, null], [-1.7e308, null], [1e308, 'finite']]) {
    c.step(DT, Object.assign({}, c.car, { x: big, z: big }));
    assert(want === null ? c.st.boxAhead === null : Number.isFinite(c.st.boxAhead), big + ': ' + c.st.boxAhead);
  }
  // odd opts
  for (const o of [null, undefined, 5, 'x', {}, { slot: 'x' }, { slot: NaN }, { slot: -1 }, { slot: 3.7 }, { slot: 1e9 }, { slot: 17 }]) {
    const p = createPit({ random: mulberry32(2) });
    const c = { x: 0, z: 0, heading: 0, speed: 0, sampleIndex: 0, d: 0 };
    assert.strictEqual(p.update(DT, c, STRAIGHT, o), null);
    const want = o && typeof o.slot === 'number' && o.slot >= 0 && Number.isFinite(o.slot) ? Math.floor(o.slot) % 16 : 0;
    assert.strictEqual(p.state.slot, want, JSON.stringify(o));
  }
});

test('slots: the room slot picks its own box; out-of-range slots wrap; boxBack moves the stopping point', () => {
  for (const slot of [0, 7, 15]) {
    const r = rig(SHIFTED, { slot: slot + 16 });
    r.enter().toBox(slot).hold(1);
    assert.deepStrictEqual([r.st.slot, !!r.st.service], [slot, true], 'slot ' + (slot + 16));
  }
  // track.js may give the NOSE point of the box (as track.grid does): main.js passes boxBack = CAR_NOSE
  const r = rig(SHIFTED, { slot: 2, boxBack: 2.8 });
  const b = SHIFTED.pit.boxes[2], sd = r.side();
  r.enter().go(b.s - 20, 12 * sd, 20).go(b.s - 6, 18 * sd, 8).go(b.s, 18 * sd, 2).hold(2);
  assert.deepStrictEqual([r.st.inBox, r.st.service], [false, null], 'origin on the box point = 2.8 m too far');
  assert(near(r.st.boxAhead, -2.8, 0.05), String(r.st.boxAhead));
  r.go(b.s - 2.8, 18 * sd, 1).hold(1);
  assert.deepStrictEqual([r.st.inBox, !!r.st.service], [true, true]);
  assert(near(r.st.boxAhead, 0, 0.05));
});

test('the slot can change between visits (a new room slot): the next stop is in the new box', () => {
  const r = rig(SHIFTED, { slot: 1 });
  r.enter().toBox(1).hold(1);
  r.until('serviceDone');
  r.leaveBox().out();
  r.slot = 6;
  r.lap().enter().toBox(1).hold(100);
  assert.strictEqual(r.st.service, null, 'the old box is somebody else\'s now');
  r.go(r.s - 1, r.lat, 1).toBox(6).hold(1);
  assert(r.st.service);
});

test('a car put at rest in its own box gets no service until it has driven there', () => {
  const r = rig(SHIFTED, { slot: 0 });
  const b = SHIFTED.pit.boxes[0], sd = r.side();
  r.put(b.s, 18 * sd, 0).hold(300);
  assert.deepStrictEqual([r.take(), r.st.inBox, r.st.service], [['enter'], true, null]);
  r.go(b.s + 3, 18 * sd, 1).go(b.s, 18 * sd, 1).hold(1);
  assert.deepStrictEqual(r.take(), ['serviceStart']);
});

test('track change: reset() forgets visit, service, stops and penalties; a new track.pit object does it by itself', () => {
  const r = rig(STRAIGHT);
  r.enter(100 * KMH).toBox(0).hold(1);
  r.until('serviceDone');
  r.leaveBox().out().lap().enter(100 * KMH).toBox(0).hold(20);
  assert(r.st.service && r.st.stops === 1 && r.st.visit);
  r.pit.reset();
  assert.deepStrictEqual(STATE_KEYS.map(k => r.st[k]), [false, false, false, null, 0, 0, null, false, false, false, false, -1, 80]);
  r.log.length = 0; r.open = false; r.svc = false;
  // the next update on another track: nothing left over, nothing queued
  const k = rig(CURVED);
  k.pit = r.pit;                                            // (the same pit object goes on with the new track)
  const c = { x: 0, z: 0, heading: 0, speed: 0, sampleIndex: 0, d: 0 };
  assert.strictEqual(r.pit.update(DT, c, CURVED, { slot: 0 }), null);
  assert.deepStrictEqual([r.st.stops, r.st.pending, r.st.visit, r.st.limitKmh], [0, 0, false, 80]);
  // no reset(): switching the track object mid-service clears it all too (silently)
  const q = rig(SHIFTED);
  q.enter(100 * KMH).toBox(0).hold(20);
  assert(q.st.service && q.st.pending === 0 && q.st.visit);
  assert.strictEqual(q.pit.update(DT, c, CURVED, { slot: 0 }), null);
  assert.deepStrictEqual([q.st.service, q.st.visit, q.st.stops], [null, false, 0]);
  // and back: a fresh start on the first track
  assert.strictEqual(q.pit.update(DT, c, SHIFTED, { slot: 0 }), null);
  assert.deepStrictEqual([q.st.service, q.st.visit, q.st.slot], [null, false, 0]);
});

test('curved lane: box heading follows the curve, boxAhead is measured along the row of boxes', () => {
  const r = rig(CURVED, { slot: 8 });
  const b = CURVED.pit.boxes[8], sd = r.side();
  r.enter().go(b.s - 40, 12 * sd, 20);
  // 40 m of centreline on a 160 m radius = 35.5 m along the boxes 18 m inside it
  assert(near(r.st.boxAhead, 40 * (160 - 18) / 160, 0.3), String(r.st.boxAhead));
  assert(Math.abs(b.heading - CURVED.pit.boxes[0].heading) > 0.3, 'the boxes point different ways');
  r.toBox(8);
  assert(near(r.st.boxAhead, 0, 0.05) && r.st.inBox, String(r.st.boxAhead));
  // the car still pointing the way it pointed 10 m back: 3.6 degrees off: in; 25 m back: 9 degrees: in;
  // 80 m back: 29 degrees: out
  for (const [back, ok] of [[10, true], [25, true], [80, false]]) {
    const f = CURVED.frame(b.s - back);
    r.car.heading = Math.atan2(f.tx, f.tz);
    r.car.speed = 0.3;
    r.step();
    assert.strictEqual(r.st.inBox, ok, back + ' m');
    if (r.st.service) break;
  }
  assert(r.st.service);
});

test('determinism: the same seed and drive give the same events, services and states', () => {
  const drive = seed => {
    const r = rig(STRAIGHT, { slot: 3, random: mulberry32(seed), main: true });
    const out = [];
    for (let v = 0; v < 6; v++) {
      r.enter(v % 2 ? 95 * KMH : 20);
      if (v % 3 !== 2) { r.toBox(3).hold(1); out.push(r.st.service.total); r.until('serviceDone'); r.leaveBox(); }
      r.out().lap();
    }
    return { out, log: r.take(), stops: r.st.stops, pending: r.st.pending };
  };
  const a = drive(1234), b = drive(1234), c = drive(4321);
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a.out, c.out);
  // every stop consumes exactly two draws, nothing else touches the generator
  const g = mulberry32(1234), want = a.out.map((t, k) => createPit.serviceTime(g));
  // visits 0..5: stops in 0, 1, 3, 4; speeding in 1, 3, 5 -> holds 0, 5, 5, 0 at the stops, visit 5's at its exit line
  const pen = [0, 5, 5, 0];
  assert.strictEqual(pen.length, a.out.length);
  a.out.forEach((t, k) => assert(near(t, want[k] + pen[k], 1e-12), 'stop ' + k + ': ' + t + ' vs ' + want[k]));
  assert.deepStrictEqual([a.stops, a.pending], [4, 0], 'visit 5 sped without stopping: held at the exit');
  assert.deepStrictEqual(a.log.filter(e => e.startsWith('penalty')), ['penaltyStart', 'penaltyDone']);
});

test('service times: 10 000 draws — always 2.0..4.5 s, mostly 2.2..3.2, the occasional slow stop', () => {
  const g = mulberry32(42), n = 10000, t = [];
  for (let k = 0; k < n; k++) t.push(createPit.serviceTime(g));
  t.sort((a, b) => a - b);
  const share = f => t.filter(f).length / n;
  const mean = t.reduce((a, b) => a + b, 0) / n, median = t[n / 2];
  const fast = share(v => v < 2.2), normal = share(v => v >= 2.2 && v <= 3.2), slow = share(v => v > 3.2), four = share(v => v > 4);
  assert(t[0] >= 2 && t[n - 1] <= 4.5, t[0] + ' .. ' + t[n - 1]);
  assert(t[0] < 2.01 && t[n - 1] > 4.4, 'the whole range is used');
  assert(fast > 0.04 && fast < 0.06, 'quick ' + fast);
  assert(normal > 0.83 && normal < 0.87, 'normal ' + normal);
  assert(slow > 0.085 && slow < 0.115, 'slow ' + slow);
  assert(four > 0.012 && four < 0.032, 'over 4 s ' + four);
  assert(Math.abs(mean - 2.7633) < 0.02, 'mean ' + mean);
  assert(median > 2.68 && median < 2.75, 'median ' + median);
  // the normal stops peak in the middle: 2.6..2.8 holds more than twice 2.2..2.4
  assert(share(v => v >= 2.6 && v < 2.8) > 2 * share(v => v >= 2.2 && v < 2.4));
  // any generator output, even broken, stays inside the range
  for (const x of [0, 0.999999999, 1, -1, 2, NaN, Infinity, -Infinity, undefined, null, '0.5', {}]) {
    const v = createPit.serviceTime(() => x);
    assert(v >= 2 && v <= 4.5, String(x) + ' -> ' + v);
  }
  const hist = [];
  for (let a = 2.0; a < 4.5 - 1e-9; a += 0.25) hist.push(Math.round(share(v => v >= a && v < a + 0.25) * 1000) / 10);
  return '(mean ' + mean.toFixed(3) + ' s, median ' + median.toFixed(3) + ', <2.2: ' + (fast * 100).toFixed(1) +
    ' %, 2.2..3.2: ' + (normal * 100).toFixed(1) + ' %, >3.2: ' + (slow * 100).toFixed(1) + ' %, >4.0: ' +
    (four * 100).toFixed(1) + ' %; % per 0.25 s from 2.0: ' + hist.join(' ') + ')';
});

test('random driving: events stay paired and ordered, the state stays consistent', () => {
  let seed = 2024;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let services = 0, visits = 0, holds = 0;
  for (const track of [STRAIGHT, SHIFTED, CURVED]) {
    for (let run = 0; run < 8; run++) {
      const r = rig(track, { slot: Math.floor(rnd() * 16), random: mulberry32(run) });
      const t = track.o, sd = r.side(), b = track.pit.boxes[r.slot];
      r.put(t.sEntry - 30, 0, 20);
      for (let k = 0; k < 400; k++) {
        const x = rnd();
        if (x < 0.03) r.put(r.s, 0, 0).step();                                          // R
        else if (x < 0.05) r.put(t.sEntry + rnd() * 400 - 100, (rnd() * 40 - 20), 0).step();   // teleport
        else if (x < 0.25) r.go(b.s + rnd() * 6 - 3, 18 * sd + rnd() * 2 - 1, 1 + rnd() * 5).hold(Math.floor(rnd() * 600));
        else if (x < 0.35) r.hold(Math.floor(rnd() * 300));
        else if (x < 0.5) r.go(r.s - rnd() * 15, r.lat, 1 + rnd() * 4);                  // reverse
        else if (x < 0.55) { r.pit.reset(); r.open = false; r.svc = false; }
        else r.go(r.s + rnd() * 30, rnd() < 0.5 ? 12 * sd : (rnd() < 0.5 ? 0 : 18 * sd), 1 + rnd() * 35);
        if (r.st.service && rnd() < 0.5) r.until(r.st.service.work ? 'serviceDone' : 'penaltyDone');
      }
      services += r.log.filter(e => e === 'serviceDone').length;
      visits += r.log.filter(e => e === 'enter').length;
      holds += r.log.filter(e => e === 'penaltyStart').length;
    }
  }
  assert(services > 20 && visits > 50 && holds > 3, 'the fuzz really exercises it: ' + services + ' services, ' + visits + ' visits, ' + holds + ' holds');
  return '(' + visits + ' visits, ' + services + ' services, ' + holds + ' exit-line holds)';
});

console.log(failed ? '\n' + failed + ' test(s) FAILED' : '\nall pit tests passed');
process.exit(failed ? 1 : 0);
