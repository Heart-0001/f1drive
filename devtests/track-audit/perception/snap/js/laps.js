// F1Drive - lap counting from the car's track sample index. Pure logic (no DOM, no THREE), also loadable
// in node (module.exports). Used by main.js for the lap timer, qualifying and race laps.
//
// The counter keeps the car's position as an UNWRAPPED sample count `pos`, measured from the start/finish
// line (between the last sample and sample 0) of the lap that is being timed: every step adds the wrapped
// change of the sample index. A lap is complete when pos reaches nSamples. pos < 0 means the car is still
// BEFORE that line: on the grid after arm(), after reversing back over the line, or in a lap that cannot
// count. So reversing over the line and coming back, spinning or driving the wrong way never credits
// anything, a lap is never counted twice, and nothing depends on quarter boundaries.
//
// The sample index can JUMP: where a track crosses itself on one level (Suzuka), car.js re-locates the
// car globally when it is off the road edge, and reports samples of the OTHER branch for as long as the car
// is closer to that centreline (~25 m of travel, which takes seconds at low speed). A jump is therefore
// not believed for as long as the index stays where it landed: the counter keeps its own position
// (lap.prevIdx, lap.jumping = true) and simply carries on when the index comes back.
// Only when the car has really driven on along the other stretch (STICK_SAMPLES from where it landed) is
// the jump taken for real, as a move to where it landed without driving there:
//   - to a place this lap has already been through (up to `hi`, the furthest point reached): fine, the
//     car merely lost ground (it took the crossing the long way round);
//   - to anywhere else: part of the lap was skipped. The lap in progress is `void`: the car counts as
//     being before the line again, the next crossing completes nothing and timing restarts there.
//     Going back to where the lap was left (a jump back, or driving back) makes it valid again.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var NEAR_SAMPLES = 60;      // ~120 m. An index change up to this is "the same stretch of road": longer than
                              //   the blind stretch of a crossing (Suzuka: up to 14 samples, car against the wall)
  var STICK_SAMPLES = 25;     // ~50 m the index must move on from where it landed before a jump is believed
                              //   (Suzuka: it drifts up to 8 samples along the other road while it is wrong)

  function createLapCounter(nSamples, startIdx) {
    var lap = {
      started: false,   // timing is running
      n: 0,             // number of the lap being driven (1 = first timed lap); laps completed = n - 1
      time: 0,          // seconds into the current lap (plain field: main.js sets it after arm())
      last: null, best: null,
      sector: 0,        // furthest quarter (0..3) reached in the lap being timed; informational
      prevIdx: 0,       // the sample index the counter believes the car is at
      void: false,      // the lap in progress cannot count (part of it was skipped)
      behind: false,    // the car is before the line of the lap it is on (grid start, reversed over it, void)
      jumping: false,   // an index jump is being waited out: prevIdx, not the car's index, is where the car is
      jumps: 0          // index jumps seen (diagnostics)
    };
    var N = Math.max(1, nSamples | 0);
    var near = Math.max(1, Math.min(NEAR_SAMPLES, Math.floor(N / 8)));
    var stick = Math.max(1, Math.min(STICK_SAMPLES, Math.floor(N / 16)));
    var pos = 0;          // samples from the line of the lap being timed; pos === prevIdx (mod N)
    var hi = 0;           // furthest pos reached by driving in that lap
    var land = 0;         // jump being waited out: where the index landed
    var raw = 0;          // index of the previous step, believed or not
    var placed = false;   // sync(): the next index is where the car was put, a jump needs no waiting

    function norm(idx) { idx = (idx | 0) % N; return idx < 0 ? idx + N : idx; }
    function delta(from, to) {                // shortest way round, -N/2 .. N/2
      var d = to - from;
      return d > N / 2 ? d - N : (d < -N / 2 ? d + N : d);
    }
    function flags() {
      lap.behind = lap.started && pos < 0;
      lap.sector = lap.started && !lap.void ? Math.min(3, Math.floor(hi * 4 / N)) : 0;
    }

    function place(idx) {
      idx = norm(idx);
      lap.started = false; lap.n = 0; lap.time = 0; lap.last = null; lap.best = null;
      lap.prevIdx = idx; lap.void = false; lap.jumping = false; lap.jumps = 0;
      pos = idx === 0 ? 0 : idx - N;          // (-N, 0]: distance to the line ahead
      hi = 0; land = raw = idx; placed = false;
    }

    /** The car was placed (track loaded, qualifying start): timing starts at the first crossing of the line. */
    lap.reset = function (idx) { place(idx); flags(); };

    /** Race start from the grid: the clock runs from now, and the first crossing of the line (the grid is
     *  behind it, however far) does not complete a lap. */
    lap.arm = function (idx) {
      place(idx);
      lap.started = true; lap.n = 1;
      flags();
    };

    /** The car was put somewhere on purpose (R reset): whatever index the next update() brings is where
     *  the car really is. Nothing is credited for the move; a line crossing is still seen by update(). */
    lap.sync = function (idx) { lap.jumping = false; placed = true; };

    // The car drove (or was carried a short way) from prevIdx to idx.
    function move(idx, d) {
      var was = pos;
      lap.prevIdx = idx;
      pos += d;
      if (!lap.started) {
        if (d > 0 && was < 0 && pos >= 0) {               // first forward crossing of the line
          lap.started = true; lap.n = 1; lap.time = 0; hi = pos;
          return 1;
        }
        if (pos > 0) pos -= N; else if (pos <= -N) pos += N;
        return 0;
      }
      if (d < 0) {
        if (lap.void && pos + N <= hi + near) { pos += N; lap.void = false; }   // back where the lap was left
        else if (pos <= -N) pos += N;                     // a whole lap backwards: only the position counts
        return 0;
      }
      if (lap.void) {
        if (pos >= 0) { lap.void = false; lap.time = 0; hi = pos; }             // the lap that did not count ends here
        return 0;
      }
      if (pos >= N) {                                     // forward over the line with the whole lap behind it
        lap.last = lap.time;
        if (lap.best == null || lap.time < lap.best) lap.best = lap.time;
        lap.n += 1; lap.time = 0; pos -= N; hi = pos;
        return 2;
      }
      if (pos > hi) hi = pos;
      return 0;                                           // (includes crossing the line from behind it)
    }

    // The car is at idx without having driven there.
    function jumpTo(idx, d) {
      if (lap.started && d > 0 && !lap.void && pos + d <= hi + near) return move(idx, d);   // been there this lap
      lap.prevIdx = idx;
      if (lap.started && idx <= hi + near) {              // a place this lap has already been through
        pos = idx; lap.void = false;
        if (pos > hi) hi = pos;
      } else {                                            // not reached by driving: before the line again
        if (lap.started && pos >= 0) lap.void = true;
        pos = idx === 0 ? 0 : idx - N;
      }
      return 0;
    }

    /** Call once per physics step with car.state.sampleIndex. `speed` is not used (the direction comes from
     *  the index itself). -> 0 nothing, 1 timing started, 2 lap completed (time in lap.last) */
    lap.update = function (idx, speed, dt) {
      var was = placed, d, w, res;
      placed = false;
      if (lap.started && dt > 0) lap.time += dt;
      idx = norm(idx);
      d = delta(lap.prevIdx, idx);
      if (d === 0) { lap.jumping = false; raw = idx; return 0; }
      if (d > near || d < -near) {
        // More than a car can travel in a step: the index jumped. Wait and see where it goes from where it
        // landed, unless the car was put there (sync).
        w = delta(raw, idx);
        if (!lap.jumping || w > stick || w < -stick) {
          if (!lap.jumping) lap.jumps++;
          lap.jumping = true; land = idx;
        }
        raw = idx;
        w = delta(land, idx);
        if (!was && w <= stick && w >= -stick) return 0;
        // believed: the car got to `land` without driving, and has driven on from there to idx
        lap.jumping = false;
        res = jumpTo(land, delta(lap.prevIdx, land));
        if (w !== 0) res = move(idx, w) || res;
      } else {
        lap.jumping = false; raw = idx;
        res = move(idx, d);
      }
      flags();
      return res;
    };

    /** Race distance covered, in laps: laps completed + fraction of the current lap. Negative before the
     *  line (grid). Continuous across the line; while an index jump is waited out it is the believed
     *  position, not idx. */
    lap.progress = function (idx) {
      var p = pos, d;
      if (typeof idx === 'number' && idx === idx) {
        d = delta(lap.prevIdx, norm(idx));
        if (d <= near && d >= -near) p += d;
      }
      return (lap.n > 0 ? lap.n - 1 : 0) + p / N;
    };

    lap.reset(startIdx || 0);
    return lap;
  }

  F1.createLapCounter = createLapCounter;
  if (typeof module !== 'undefined' && module.exports) module.exports = createLapCounter;
})(typeof window !== 'undefined' ? window : globalThis);
