// F1Drive - pit stops (F1.createPit): pit-lane visits, the lane speed limit, the stop in the driver's own box
// and the service (tyre change) that follows. Pure logic: no DOM, no THREE, no timers; also loadable in node
// (module.exports = createPit). See js/README-interfaces.md, "js/pit.js". The lane is track.pit (js/track.js).
//
// main.js calls pit.update(dt, car.state, track, {slot, limiter}) every physics step, and while the car is frozen
// for a service (no physics steps) once a frame with the frame's dt: the service only counts down in update().
// update() returns at most one event per call; several events of one step are queued and come out in order on
// the following calls. pit.reset() forgets everything (track loaded or changed, new session); a track.pit object
// other than the one of the previous call does the same by itself.
//
// Lane positions are counted in samples from the entry line in lap order (entry line = 0, exit line = L), so a
// lane across the start / finish line, where the sample index wraps, is one piece.
//
// Visits. The car is in the lane when track.pit.inLane(sampleIndex, d) says so, or when it stands in its own box
// (in case the boxes lie outside what inLane covers). Getting into the lane opens a visit: 'enter'. The visit is
// over ('exit') once the car is out of the lane AND more than LEAVE_M metres past the exit line, or back before
// the entry line, on GONE_STEPS updates running: so 'exit' comes 6..8 m after the exit line; a car on a line whose
// index flickers, that reverses a little over a line and comes back, or whose index glitches for one step, keeps
// its visit and nothing fires twice. Every event of a visit comes between its 'enter' and its 'exit', 'enter' and
// 'exit' alternate (reset() ends a visit silently). A car put back on the track with R keeps its visit (out of the
// lane: no speeding, no box) until it has left the lane's stretch of track as above; one that reverses out over
// the entry line and away ends it, and gets a new visit (penalty and service allowances of its own) when it comes
// back in.
//
// Speeding: in the lane at more than LIMIT_TOL km/h over track.pit.limitKmh (80 if the pit has none), by the
// magnitude of the speed, reversing included. state.speeding is that, live. The first time in a visit, and again the
// first time after the visit's stop began: 'speeding', and PENALTY_S seconds of hold are added to state.pending.
//
// The hold is served at the visit's stop (below) when it comes after the offence; otherwise at the exit line: a car
// of a visit that crosses the exit line forwards with state.pending > 0 (sped after its stop, or did not stop) is
// held there at once, a stop-go without tyres: 'penaltyStart', state.service = {total, left, penalty, work: 0} with
// total = penalty = left = everything in state.pending (pending goes to 0), counted down as a service (main.js
// freezes the car for any state.service); at left = 0: 'penaltyDone', state.service = null (no tyres, stops
// unchanged). Moved more than ABORT_MOVE: 'serviceAbort', the part not served goes back to state.pending. So an
// offence always costs its time in the visit it was committed in (speeding after the stop gains up to ~7 s at Monza:
// unserved, it was free time), and pending only outlives a visit that ends back over the entry line or by reset().
//
// Service: the car is in its own box (boxes[slot]: within BOX_ALONG m along the box, BOX_ACROSS m across,
// heading within BOX_HEADING) = state.inBox; at rest there (|speed| < REST_SPEED) during a visit that has not had
// its service yet, and driven there (the car has been moving at some point of the visit: a car PUT at rest in its
// box does not get one), the service starts: 'serviceStart', state.service = {total, left, penalty, work}: `work` the
// tyre change (serviceTime below, 2.0 .. 4.5 s), `penalty` = everything in state.pending (served now: pending goes
// to 0), total = work + penalty, left counts down from total (the penalty hold comes first: left > work means the car
// is still serving it). One service per visit. At left = 0: 'serviceDone', state.service = null, stops + 1;
// main.js then fits the new tyres and releases the car. A car that moves more than ABORT_MOVE m from where its
// service started (it was not held, or was put elsewhere) goes without: 'serviceAbort' (not in the contract;
// main.js may ignore it), service null, the visit may stop again, the part of the penalty not yet served goes
// back to state.pending. Stopping in another slot's box, crooked, or outside a box does nothing.
//
// Service time (the tyre change, s), two calls of random() per draw:
//    5 %  quick        uniform 2.0 .. 2.2
//   85 %  normal       symmetric triangular 2.2 .. 3.2 (mode 2.7)
//   10 %  slow stop    3.2 + 1.3 * v^2, v uniform: 3.2 .. 4.5, most of them just over 3.2 (2 % over 4.0)
//   -> always 2.0 .. 4.5, mean 2.76, median ~2.7; 85 % inside 2.2 .. 3.2.
//
// HUD: state.boxAhead = metres from the car to its own box along the row of boxes (the offset curve at the box's
// d; + ahead, - passed), null when the car is not on the pit's stretch of track (track.pit.from .. to) or there
// is no box; state.boxPassed = the car is more than BOX_ALONG past it.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var LIMIT_DEFAULT = 80;          // km/h when track.pit has no usable limitKmh
  var LIMIT_TOL = 3;               // km/h over the limit before it counts
  var PENALTY_S = 5;               // hold for every speeding offence: at the visit's stop, else at the exit line
  var REST_SPEED = 0.5;            // m/s: at rest, the service may start
  var BOX_ALONG = 2.5;             // m: the car's origin within this of the box point along the box ...
  var BOX_ACROSS = 1.2;            // ... and within this across it ...
  var BOX_HEADING = 20 * Math.PI / 180;   // ... and pointing the box's way within this
  var ABORT_MOVE = 1;              // m: moved this far from where the service started = drove off without it
  var LEAVE_M = 6;                 // m out past a line before a visit is over ...
  var GONE_STEPS = 2;              // ... on this many updates running (a one-step index glitch ends nothing)
  var STEP_M = 2;                  // sample spacing when the track does not tell
  var QUEUE = 8;                   // events waiting to be returned (at most 4 can arise in one step)

  var FAST_P = 0.05, SLOW_P = 0.10;          // shares of quick / slow stops (the rest is normal)
  var FAST_MIN = 2.0, NORMAL_MIN = 2.2, NORMAL_MAX = 3.2, SLOW_MAX = 4.5;

  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }
  function unit(random) {                    // a number in [0, 1) whatever the generator returns
    var r = random();
    r = typeof r === 'number' ? r : +r;
    return r >= 0 ? (r < 1 ? r : 0.9999999) : 0;   // NaN, negatives -> 0
  }

  /** One tyre-change time in seconds (2.0 .. 4.5) from two calls of random(); see the header. */
  function serviceTime(random) {
    if (typeof random !== 'function') random = Math.random;
    var p = unit(random), v = unit(random);
    if (p < FAST_P) return FAST_MIN + (NORMAL_MIN - FAST_MIN) * v;
    if (p < 1 - SLOW_P) {
      var t = v < 0.5 ? Math.sqrt(v / 2) : 1 - Math.sqrt((1 - v) / 2);   // symmetric triangular on [0, 1]
      return NORMAL_MIN + (NORMAL_MAX - NORMAL_MIN) * t;
    }
    return NORMAL_MAX + (SLOW_MAX - NORMAL_MAX) * v * v;
  }

  /**
   * createPit({ random }) -> pit. random() -> [0, 1), default Math.random (injected for tests / replays).
   * Optional opts.boxBack: metres from track.pit.boxes[slot].(x, z) back along the box heading to where the car's
   * ORIGIN (car.state.x / z) stops; 0 = the box point is the car's position (default).
   */
  function createPit(opts) {
    opts = opts || {};
    var random = typeof opts.random === 'function' ? opts.random : Math.random;
    var boxBack = isNum(opts.boxBack) ? opts.boxBack : 0;

    var state = {
      inLane: false,       // in the pit lane: between the entry and exit lines, beyond the pit wall (or in the own box)
      speeding: false,     // in the lane and over the limit + 3 km/h right now
      inBox: false,        // in the own box (position + heading), moving or not
      service: null,       // null | {total, left, penalty, work} (s); work 0: a penalty hold at the exit line
      stops: 0,            // services completed since reset()
      pending: 0,          // s of speeding hold waiting for the visit's stop or its exit line
      boxAhead: null,      // m to the own box along the lane: + ahead, - passed; null off the pit's stretch
      boxPassed: false,    // more than BOX_ALONG past the own box
      visit: false,        // a pit visit is open (in the lane, or just out of it: see the header)
      flagged: false,      // this visit has had its speeding penalty (since its stop began)
      served: false,       // this visit has had (or is having) its service
      slot: -1,            // the box used: boxes[slot]; -1 = none (no pit / no boxes)
      limitKmh: LIMIT_DEFAULT
    };
    var pit = { state: state };

    // the lane of the current track.pit, set up when it changes
    var lastPit;                               // undefined: nothing set up yet
    var P = null, N = 0, S = null, E = 0, L = 0, H = 1, lo = 0, hi = 0, len = 0;
    var gone = 0;                              // consecutive steps out of the lane and past a line by LEAVE_M
    var moved = false;                         // the car has been moving in this visit (a car PUT at rest in its box
                                               //   has not stopped there: no service until it drives in)
    var svcX = 0, svcZ = 0;                    // where the running service started
    var svcHold = false;                       // the running service is a penalty hold at the exit line (no tyres)
    var lastPos = NaN;                         // lane position at the last readable update (exit line crossing)
    var queue = new Array(QUEUE), qHead = 0, qLen = 0;

    function push(ev) { if (qLen < QUEUE) { queue[(qHead + qLen) % QUEUE] = ev; qLen++; } }
    function next() {
      if (!qLen) return null;
      var ev = queue[qHead];
      queue[qHead] = null; qHead = (qHead + 1) % QUEUE; qLen--;
      return ev;
    }
    function cyc(v) { v %= N; return v < 0 ? v + N : v; }
    // lane position (samples from the entry line, lap order) of sample index i: -(N - L) / 2 .. L + (N - L) / 2
    function lanePos(i) { var u = cyc(i - E); return u <= L + (N - L) / 2 ? u : u - N; }

    function clear() {
      state.inLane = state.speeding = state.inBox = state.boxPassed = false;
      state.visit = state.flagged = state.served = false;
      state.service = null; state.stops = 0; state.pending = 0; state.boxAhead = null;
      state.slot = -1; state.limitKmh = LIMIT_DEFAULT;
      moved = false; gone = 0; svcHold = false; lastPos = NaN;
      qHead = qLen = 0;
      for (var q = 0; q < QUEUE; q++) queue[q] = null;
    }

    function usable(pitObj, track) {
      return !!(pitObj && typeof pitObj === 'object' && typeof pitObj.inLane === 'function' &&
        isNum(pitObj.entry) && isNum(pitObj.exit) &&
        track.samples && typeof track.samples.length === 'number' && track.samples.length >= 3);
    }

    function setup(pitObj, track) {
      P = pitObj;
      if (!P) { S = null; N = 0; return; }
      S = track.samples; N = S.length;
      len = isNum(track.length) && track.length > 0 ? track.length : N * STEP_M;
      H = Math.max(1, Math.ceil(LEAVE_M / (len / N)));
      E = cyc(Math.round(P.entry)); L = cyc(Math.round(P.exit) - E);
      lo = isNum(P.from) ? -cyc(E - Math.round(P.from)) : -H;        // the pit's stretch: from .. to
      hi = isNum(P.to) ? cyc(Math.round(P.to) - E) : L + H;
      if (hi < L) hi = L + H;
      state.limitKmh = isNum(P.limitKmh) && P.limitKmh > 0 ? P.limitKmh : LIMIT_DEFAULT;
    }

    // the own box, or null: boxes[slot] with every field needed
    function ownBox(o) {
      var boxes = P.boxes, n = boxes && typeof boxes.length === 'number' ? boxes.length : 0;
      if (!n) { state.slot = -1; return null; }
      var slot = o && isNum(o.slot) && o.slot >= 0 ? Math.floor(o.slot) % n : 0;
      state.slot = slot;
      var b = boxes[slot];
      return b && isNum(b.x) && isNum(b.z) && isNum(b.heading) && isNum(b.index) && isNum(b.d) ? b : null;
    }

    // metres along the row of boxes (offset curve at the box's d) from the car at sample i (lane position pc)
    // to box b; + when the box is ahead
    function rowDistance(i, pc, car, b) {
      var bi = cyc(Math.round(b.index)), pb = lanePos(bi), bd = b.d;
      var a = S[i], c = S[bi], k, from, n, sum = 0, s0, s1, ax, az, bx, bz;
      var fa = (car.x - a.x) * a.tx + (car.z - a.z) * a.tz;                 // car ahead of its sample
      var bxp = b.x - Math.sin(b.heading) * boxBack, bzp = b.z - Math.cos(b.heading) * boxBack;
      var fb = (bxp - c.x) * c.tx + (bzp - c.z) * c.tz;                      // box ahead of its sample
      from = pb >= pc ? i : bi; n = pb >= pc ? pb - pc : pc - pb;
      s0 = S[from];
      ax = s0.x + s0.nx * bd; az = s0.z + s0.nz * bd;
      for (k = 1; k <= n; k++) {
        s1 = S[(from + k) % N];
        bx = s1.x + s1.nx * bd; bz = s1.z + s1.nz * bd;
        sum += Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
        ax = bx; az = bz;
      }
      return (pb >= pc ? sum : -sum) + fb - fa;
    }

    // (a new offence after the stop is penalised again: flagged is cleared)
    function startService(car) {
      var work = serviceTime(random), pen = state.pending, total = work + pen;
      state.pending = 0; state.flagged = false;
      state.service = { total: total, left: total, penalty: pen, work: work };
      state.served = true; svcHold = false;
      svcX = car.x; svcZ = car.z;
      push('serviceStart');
    }

    // the exit line with a hold the visit's stop did not serve: held here for all of it (a stop-go, no tyres)
    function startHold(car) {
      var pen = state.pending;
      state.pending = 0;
      state.service = { total: pen, left: pen, penalty: pen, work: 0 };
      svcHold = true;
      svcX = car.x; svcZ = car.z;
      push('penaltyStart');
    }

    // the car went without its service / hold: the part of the penalty hold not yet served waits for the next stop or
    // forward exit-line crossing (an aborted hold's line is already crossed: in practice the next visit's)
    function abortService() {
      var sv = state.service, held = sv.total - sv.left;
      if (held < sv.penalty) state.pending += sv.penalty - held;
      if (!svcHold) { state.served = false; moved = false; }
      state.service = null; svcHold = false;
      push('serviceAbort');
    }

    // counts the running service down; `car` may be unusable (then it only counts). -> false: aborted
    function runService(dt, car) {
      var sv = state.service;
      if (car && isNum(car.x) && isNum(car.z) &&
          (car.x - svcX) * (car.x - svcX) + (car.z - svcZ) * (car.z - svcZ) > ABORT_MOVE * ABORT_MOVE) {
        abortService();
        return false;
      }
      sv.left -= dt;
      if (sv.left <= 1e-9) {
        sv.left = 0;
        state.service = null;
        if (svcHold) { svcHold = false; push('penaltyDone'); }
        else { state.stops++; push('serviceDone'); }
      }
      return true;
    }

    /** Forget everything: no visit, no service, no stops, no pending penalty, no queued events. */
    pit.reset = function () { clear(); lastPit = undefined; P = null; S = null; N = 0; };

    /**
     * One step. car = car.state ({x, z, heading, speed, sampleIndex, d}); track = F1.buildTrack(...) (uses
     * track.pit, track.samples, track.length); o = {slot, limiter} (slot: the room slot, boxes[slot]; missing -> 0;
     * limiter is accepted and not used). -> 'enter' | 'exit' | 'speeding' | 'serviceStart' | 'serviceDone' |
     * 'penaltyStart' | 'penaltyDone' | 'serviceAbort' | null
     */
    pit.update = function (dt, car, track, o) {
      var pitObj = track && typeof track === 'object' ? track.pit : null;
      if (!usable(pitObj, track)) pitObj = null;
      if (pitObj !== lastPit) { clear(); lastPit = pitObj; setup(pitObj, track); }
      if (!P) return next();                                  // no pit lane: everything stays off
      dt = isNum(dt) && dt > 0 ? dt : 0;

      var ok = car && typeof car === 'object' && isNum(car.sampleIndex) && isNum(car.d);
      if (!ok) {                                              // nothing to judge this step: keep the state, run the clock
        if (state.service) runService(dt, null);
        return next();
      }
      var i = cyc(Math.round(car.sampleIndex)), pos = lanePos(i);
      var hasXZ = isNum(car.x) && isNum(car.z);
      var speed = isNum(car.speed) ? Math.abs(car.speed) : NaN;

      // the running service first: it does not count down in the step it starts, and a car carried away from its
      // box has its service aborted before anything else is said about where it is now
      var aborted = false;
      if (state.service) aborted = !runService(dt, car);

      // own box
      var b = ownBox(o), inBox = false;
      if (b && hasXZ && isNum(car.heading)) {
        var hs = Math.sin(b.heading), hc = Math.cos(b.heading);
        var ex = car.x - (b.x - hs * boxBack), ez = car.z - (b.z - hc * boxBack);
        var along = ex * hs + ez * hc, across = ez * hs - ex * hc;
        var dh = (car.heading - b.heading) % (2 * Math.PI);
        if (dh > Math.PI) dh -= 2 * Math.PI; else if (dh < -Math.PI) dh += 2 * Math.PI;
        inBox = along <= BOX_ALONG && along >= -BOX_ALONG && across <= BOX_ACROSS && across >= -BOX_ACROSS &&
          dh <= BOX_HEADING && dh >= -BOX_HEADING;
      }
      state.inBox = inBox;
      var inside = !!P.inLane(i, car.d) || inBox;
      state.inLane = inside;

      // visit
      if (inside) {
        gone = 0;
        if (!state.visit) {
          state.visit = true; state.flagged = false; state.served = false; moved = false;
          push('enter');
        }
      } else if (state.visit) {
        if (pos > L + H || pos < -H) {
          if (++gone >= GONE_STEPS) {
            if (state.service) abortService();                // (only a car whose x / z cannot be read gets here)
            state.visit = false; state.flagged = false; state.served = false; moved = false; gone = 0;
            push('exit');
          }
        } else gone = 0;
      }
      if (state.visit && speed >= REST_SPEED) moved = true;

      // speed limit
      state.speeding = inside && speed * 3.6 > state.limitKmh + LIMIT_TOL;
      if (state.speeding && !state.flagged) {
        state.flagged = true; state.pending += PENALTY_S;
        push('speeding');
      }

      // the stop: driven into the own box and at rest there
      if (!state.service && !aborted && inBox && state.visit && moved && !state.served && speed < REST_SPEED) {
        startService(car);
      }
      // the exit line crossed forwards with a hold still to serve: held right there
      if (!state.service && !aborted && hasXZ && state.visit && state.pending > 0 && lastPos < L && pos >= L &&
          pos <= L + H) {
        startHold(car);
      }
      lastPos = pos;

      // where the own box is
      var ahead = b && hasXZ && pos >= lo && pos <= hi ? rowDistance(i, pos, car, b) : NaN;
      if (isNum(ahead)) {                                     // (absurd coordinates can make it NaN / infinite)
        state.boxAhead = ahead;
        state.boxPassed = ahead < -BOX_ALONG;
      } else {
        state.boxAhead = null; state.boxPassed = false;
      }
      return next();
    };

    return pit;
  }

  createPit.serviceTime = serviceTime;
  createPit.LIMIT_DEFAULT = LIMIT_DEFAULT;
  createPit.LIMIT_TOL = LIMIT_TOL;
  createPit.PENALTY_S = PENALTY_S;
  createPit.REST_SPEED = REST_SPEED;
  createPit.BOX_ALONG = BOX_ALONG;
  createPit.BOX_ACROSS = BOX_ACROSS;
  createPit.BOX_HEADING = BOX_HEADING;
  createPit.ABORT_MOVE = ABORT_MOVE;
  createPit.LEAVE_M = LEAVE_M;

  F1.createPit = createPit;
  if (typeof module !== 'undefined' && module.exports) module.exports = createPit;
})(typeof window !== 'undefined' ? window : globalThis);
