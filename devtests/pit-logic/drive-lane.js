// devtests/pit-logic/drive-lane.js — drives js/pit.js over a REAL track (js/track.js) by kinematics: the car is
// moved along the track.pit geometry (laneD, boxes) and located with track.locate(x, z, hint) exactly as js/car.js
// locates it, then fed to pit.update() every 1/120 s step. No car physics: this checks pit.js against the real
// track.pit data (and that data against the contract), not the driving.
// Classic script: node (module.exports) and a browser page (window.PitDrive) share it.
(function (root) {
  'use strict';
  var STEP = 1 / 120;
  var KMH = 1 / 3.6;
  var FIELDS = ['side', 'limitKmh', 'from', 'to', 'entry', 'exit', 'laneD', 'laneHalfW', 'wallD', 'wallHalfT', 'boxes', 'inLane', 'contains'];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // -> { ok, fails: [..], notes: [..], summary }
  function checkTrack(F1, track, opts) {
    opts = opts || {};
    var fails = [], notes = [];
    function check(ok, what) { if (!ok) fails.push(what); return ok; }
    var S = track.samples, N = S.length, P = track.pit;
    var cyc = function (v) { v %= N; return v < 0 ? v + N : v; };

    if (!P) {
      // no pit: everything inert on a lap of the track
      var p0 = F1.createPit({ random: function () { return 0.5; } });
      var car0 = { x: 0, z: 0, heading: 0, speed: 60, sampleIndex: 0, d: 0 }, ev0 = 0;
      for (var i0 = 0; i0 < N; i0 += 3) {
        car0.x = S[i0].x; car0.z = S[i0].z; car0.sampleIndex = i0; car0.d = 0;
        if (p0.update(STEP, car0, track, { slot: 0 })) ev0++;
      }
      check(ev0 === 0 && p0.state.inLane === false && p0.state.slot === -1, 'no pit: inert');
      return { ok: !fails.length, fails: fails, notes: ['track.pit = ' + P], summary: 'no pit' };
    }

    FIELDS.forEach(function (f) { check(P[f] !== undefined, 'track.pit.' + f + ' missing'); });
    check(P.boxes && P.boxes.length === 16, 'boxes: ' + (P.boxes && P.boxes.length));
    var E = cyc(P.entry), X = cyc(P.exit), Fr = cyc(P.from), T = cyc(P.to), L = cyc(X - E);
    check(cyc(E - Fr) < N / 4 && cyc(T - X) < N / 4, 'from before entry, to after exit');
    check(cyc(0 - E) <= L, 'the start / finish line lies between the entry and exit lines (entry ' + E + ', exit ' + X + ', N ' + N + ')');

    // lateral offset of the path at a (fractional) index: the lane centre where laneD is a number, else 0
    function laneAt(u) {
      var i = cyc(Math.round(u)), d = P.laneD(i);
      return isNum(d) ? d : 0;
    }
    // position at fractional sample u, lateral d
    function put(car, u, d, heading, speed) {
      var i = Math.floor(u), f = u - i, a = S[cyc(i)], b = S[cyc(i + 1)];
      var x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
      var nx = a.nx + (b.nx - a.nx) * f, nz = a.nz + (b.nz - a.nz) * f, nl = Math.sqrt(nx * nx + nz * nz);
      car.x = x + nx / nl * d; car.z = z + nz / nl * d;
      var tx = a.tx + (b.tx - a.tx) * f, tz = a.tz + (b.tz - a.tz) * f;
      car.heading = heading !== undefined ? heading : Math.atan2(tx, tz);
      car.speed = speed;
      var loc = track.locate(car.x, car.z, car.sampleIndex);   // as car.js: local window around the last index
      car.sampleIndex = loc.index; car.d = loc.d;
    }

    function drive(slot, speedKmh, stop, seed) {
      var s = seed || 1;
      var pit = F1.createPit({ random: function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; } });
      var car = { x: 0, z: 0, heading: 0, speed: 0, sampleIndex: cyc(Fr - 60), d: 0 };
      var log = [], r = { log: log, inLaneBad: 0, trackBad: 0, service: null, speedingSeen: false };
      var box = P.boxes[slot], bu = box.index;
      function step(u, d, v, h, where) {
        while (pit.state.service) {               // held as main.js holds the car for any state.service (exit-line hold)
          car.speed = 0;
          var hv = pit.update(STEP, car, track, { slot: slot, limiter: true });
          if (hv) log.push(hv);
          r.heldExit = (r.heldExit || 0) + STEP;
        }
        put(car, u, d, h, v);
        var ev = pit.update(STEP, car, track, { slot: slot, limiter: true });
        if (ev) log.push(ev);
        var lp = cyc(car.sampleIndex - E);
        if (where === 'lane' && lp > 2 && lp < L - 2 && !pit.state.inLane) r.inLaneBad++;
        if (where === 'track' && pit.state.inLane) r.trackBad++;
        if (pit.state.speeding) r.speedingSeen = true;
        return ev;
      }
      // on the track to `from`, then the taper and the lane (laneD) up to the box / the exit, then back out
      var u = Fr - 60, end = Fr + cyc(T - Fr) + 60, v = speedKmh * KMH, ds = track.length / N;   // u: unwrapped, put() wraps
      var per = v * STEP / ds;                                    // samples per step
      for (; u < Fr; u += per) step(u, 0, 60, undefined, 'track');
      var uBox = Fr + cyc(bu - Fr);
      var until = stop ? uBox - 12 / ds : end;
      for (; u < until; u += per) step(u, laneAt(u), v, undefined, cyc(Math.round(u) - E) <= L ? 'lane' : 'pit');
      if (stop) {
        // swing over to the box line (5 m short of the box), then creep along it facing the way the lane goes and
        // stop where the HUD (state.boxAhead) says the box is: the driver's view of it
        var d0 = laneAt(u), uS = uBox - 5 / ds, n = Math.ceil((uS - u) / (3 * STEP / ds));
        for (var k = 1; k <= n; k++) {
          var t = k / n;
          step(u + (uS - u) * t, d0 + (box.d - d0) * Math.min(1, t * 1.6), 3, undefined, 'lane');
        }
        u = uS;
        for (var g = 0; g < 2000 && !(pit.state.boxAhead !== null && pit.state.boxAhead <= 0.01); g++) {
          u += 1 * STEP / ds;
          step(u, box.d, 1, undefined, 'lane');
        }
        car.speed = 0;
        r.inLaneAtBox = P.inLane(car.sampleIndex, car.d);
        r.headingOff = Math.abs(((car.heading - box.heading) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * 180 / Math.PI;
        r.stopErr = Math.hypot(car.x - box.x, car.z - box.z);
        var ev, held = 0;
        for (var w = 0; w < 1200 && !(ev === 'serviceDone'); w++) {
          ev = pit.update(STEP, car, track, { slot: slot, limiter: true });
          if (ev) log.push(ev);
          if (ev === 'serviceStart') r.service = pit.state.service.total;
          if (pit.state.service) held++;
        }
        r.held = held * STEP;
        r.boxAheadAtBox = pit.state.boxAhead;
        // out: back to the lane line over 16 m, then the lane to the end
        u = uBox;
        var dl = laneAt(u + 16 / ds);
        for (k = 1; k <= 40; k++) step(u + 16 / ds * k / 40, box.d + (dl - box.d) * k / 40, 4, undefined, 'lane');
        u += 16 / ds;
        for (; u < end; u += per) step(u, laneAt(u), v, undefined, cyc(Math.round(u) - E) <= L ? 'lane' : 'pit');
      }
      for (var e2 = 0; e2 < 40; e2++) { step(u, 0, 60, undefined, 'track'); u += 60 * STEP / ds; }
      r.stops = pit.state.stops; r.pending = pit.state.pending; r.visit = pit.state.visit;
      return r;
    }

    // 1. the own box of slots 0, 7, 15 just under the lane's limit: enter, service, done, exit
    var lim = isNum(P.limitKmh) ? P.limitKmh : 80;
    [0, 7, 15].forEach(function (slot) {
      var r = drive(slot, lim - 2, true, slot + 1);
      var want = ['enter', 'serviceStart', 'serviceDone', 'exit'];
      check(r.log.join() === want.join(), 'slot ' + slot + ': events ' + r.log.join(' '));
      check(r.inLaneBad === 0, 'slot ' + slot + ': not inLane on the lane for ' + r.inLaneBad + ' steps');
      check(r.trackBad === 0, 'slot ' + slot + ': inLane on the track for ' + r.trackBad + ' steps');
      check(r.inLaneAtBox === true, 'slot ' + slot + ': inLane(box) = ' + r.inLaneAtBox + ' (pit.js still works: own box counts as in the lane)');
      check(r.service >= 2 && r.service <= 4.5 && Math.abs(r.held - r.service) < 2 * STEP, 'slot ' + slot + ': service ' + r.service + ' held ' + r.held);
      check(r.boxAheadAtBox !== null && Math.abs(r.boxAheadAtBox) < 0.05, 'slot ' + slot + ': boxAhead at the box ' + r.boxAheadAtBox);
      check(r.stopErr < 0.3 && r.headingOff < 5, 'slot ' + slot + ': stopped ' + (r.stopErr || 0).toFixed(2) + ' m from the box point, ' +
        (r.headingOff || 0).toFixed(1) + ' deg off the box heading (lane direction vs box heading)');
      check(r.stops === 1 && r.pending === 0 && !r.visit && !r.speedingSeen, 'slot ' + slot + ': end state');
    });
    // 2. through at the limit + 20 km/h: speeding once, held 5 s at the exit line (no stop to serve it), nothing pending
    var sp = drive(4, lim + 20, false);
    check(sp.log.join() === 'enter,speeding,penaltyStart,penaltyDone,exit' && sp.pending === 0 && sp.stops === 0 &&
      Math.abs(sp.heldExit - 5) < 2 * STEP, 'speeding run: ' + sp.log.join(' ') + ' pending ' + sp.pending + ' held ' + sp.heldExit);
    // 3. flat out on the track beside the lane: nothing
    var pit3 = F1.createPit(), car3 = { x: 0, z: 0, heading: 0, speed: 80, sampleIndex: cyc(Fr - 60), d: 0 }, ev3 = [];
    for (var u3 = Fr - 60, e3 = Fr + cyc(T - Fr) + 60; u3 < e3; u3 += 80 * STEP / (track.length / N)) {
      put(car3, u3, 0, undefined, 80);
      var q = pit3.update(STEP, car3, track, { slot: 0 });
      if (q) ev3.push(q);
    }
    check(ev3.length === 0 && pit3.state.inLane === false, 'on the track: ' + ev3.join(' '));

    var lenM = Math.round(L * track.length / N);
    notes.push('side ' + P.side + ', limit ' + P.limitKmh + ', lane ' + lenM + ' m (entry ' + E + ', exit ' + X + ', N ' + N + ')');
    return { ok: !fails.length, fails: fails, notes: notes, summary: notes[0] };
  }

  // A contract-shaped track.pit built on the real samples of `track` (to check this harness and pit.js on real
  // geometry independently of js/track.js's own lane): side `sd` (-1 right, +1 left), entry line 200 m before the
  // start / finish line, exit 120 m after it, 60 m tapers, lane centre 12 m, pit wall 8.25 m, boxes at 18 m, 7 m
  // apart from 30 m before the exit line backwards (box 1 = slot 0 nearest the exit), garage face 21 m.
  function mockPit(track, sd) {
    var S = track.samples, N = S.length, ds = track.length / N;
    sd = sd === 1 ? 1 : -1;
    var cyc = function (v) { v %= N; return v < 0 ? v + N : v; }, m = function (v) { return Math.round(v / ds); };
    var E = cyc(-m(200)), X = m(120), Fr = cyc(E - m(60)), T = X + m(60), L = cyc(X - E);
    var lp = function (i) { var u = cyc(i - E); return u <= L + (N - L) / 2 ? u : u - N; };
    var lo = -cyc(E - Fr), hi = cyc(T - E), boxes = [];
    for (var k = 0; k < 16; k++) {
      var i = cyc(X - m(30 + 7 * k)), a = S[i];
      boxes.push({ slot: k, index: i, d: sd * 18, x: a.x + a.nx * sd * 18, y: 0, z: a.z + a.nz * sd * 18, heading: Math.atan2(a.tx, a.tz) });
    }
    return {
      side: sd, limitKmh: 80, from: Fr, to: T, entry: E, exit: X,
      laneD: function (i) {
        var p = lp(i);
        if (p < lo || p > hi) return NaN;
        if (p < 0) return sd * (7 + 5 * (p - lo) / -lo);
        if (p > L) return sd * (12 - 5 * (p - L) / (hi - L));
        return sd * 12;
      },
      laneHalfW: 3.5, wallD: function (i) { var p = lp(i); return p > 4 && p < L - 4 ? sd * 8.25 : NaN; }, wallHalfT: 0.25,
      boxes: boxes, inLane: function (i, d) { var p = lp(i); return p >= 0 && p <= L && sd * d > 8 && sd * d < 21; },
      contains: function () { return false; }
    };
  }

  var api = { checkTrack: checkTrack, mockPit: mockPit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PitDrive = api;
})(typeof window !== 'undefined' ? window : globalThis);
