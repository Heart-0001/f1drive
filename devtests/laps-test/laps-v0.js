// BASELINE, NOT USED BY THE GAME: js/laps.js as it was before the review (git a4eff5c), kept so that
// devtests/laps-test/drive.js can show on the same index stream what it got wrong. Only change: it does not
// register itself as F1.createLapCounter.
// F1Drive - lap counting from the car's track sample index. Pure logic (no DOM, no THREE), also loadable
// in node (module.exports). Used by main.js for the lap timer, qualifying and race laps.
//
// The lap is split in 4 quarters. `sector` is the furthest quarter reached IN ORDER since the last valid
// start/finish crossing; a lap only counts when quarters 1, 2, 3 were each entered from the previous one.
//
// The sample index can JUMP: where a track crosses itself on one level (Suzuka), car.js re-locates the
// car globally when it is off the road edge and can briefly report a sample of the other branch. A jump
// (more samples in one step than a car can travel) is ignored while it lasts; if the car really stays
// on the other part of the track (it took the crossing as a shortcut), the new position is accepted but
// the lap in progress is void: it cannot complete, and timing restarts at the next line crossing.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  var JUMP_SAMPLES = 25;      // ~50 m in one 1/120 s step: not driving
  var JUMP_HOLD = 120;        // steps (1 s) a jump must persist before it is believed

  function createLapCounter(nSamples, startIdx) {
    var lap = {
      started: false,   // timing is running
      n: 0,             // number of the lap being driven (1 = first timed lap); laps completed = n - 1
      time: 0,          // seconds into the current lap
      last: null, best: null,
      sector: 0, prevIdx: 0,
      void: false,      // the lap in progress cannot count (index jump that stuck)
      behind: false,    // the car is before the line of the lap it is on (grid start, or reversed back over it)
      jumps: 0          // index jumps seen (diagnostics)
    };
    var N = Math.max(1, nSamples | 0), pending = 0;
    var jump = Math.max(3, Math.min(JUMP_SAMPLES, Math.floor(N / 8)));

    lap.reset = function (idx) {
      lap.started = false; lap.n = 0; lap.time = 0; lap.last = null; lap.best = null;
      lap.sector = 0; lap.prevIdx = idx | 0; lap.void = false; lap.behind = false; lap.jumps = 0;
      pending = 0;
    };

    /** Race start from the grid: the clock runs from now, and the first crossing of the line (the grid is
     *  behind it) does not complete a lap. */
    lap.arm = function (idx) {
      lap.reset(idx);
      lap.started = true; lap.n = 1; lap.behind = true;
    };

    /** The car was put somewhere on purpose (R reset): continue from there without crediting anything. */
    lap.sync = function (idx) { lap.prevIdx = idx | 0; pending = 0; };

    /** Call once per physics step. -> 0 nothing, 1 timing started, 2 lap completed (time in lap.last) */
    lap.update = function (idx, speed, dt) {
      var prev = lap.prevIdx;
      if (lap.started) lap.time += dt;
      if (idx === prev) { pending = 0; return 0; }

      var d = idx - prev;
      if (d > N / 2) d -= N; else if (d < -N / 2) d += N;
      if (d > jump || d < -jump) {
        if (pending === 0) lap.jumps++;
        if (++pending < JUMP_HOLD) return 0;          // wait: most jumps are gone a few steps later
        pending = 0;
        lap.prevIdx = idx;                            // it stuck: the car is really there now
        if (lap.started) lap.void = true;
        return 0;
      }
      pending = 0;
      lap.prevIdx = idx;

      var q = Math.min(3, Math.floor(idx * 4 / N));
      var pq = Math.min(3, Math.floor(prev * 4 / N));
      if (pq === 3 && q === 0) {
        if (!(speed > 0)) return 0;
        // forward crossing of the start/finish line
        lap.behind = false;
        if (!lap.started) {
          lap.started = true; lap.n = 1; lap.time = 0; lap.sector = 0; lap.void = false;
          return 1;
        }
        if (lap.void) {                               // the lap that just ended does not count
          lap.void = false; lap.time = 0; lap.sector = 0;
          return 0;
        }
        if (lap.sector === 3) {
          lap.last = lap.time;
          if (lap.best == null || lap.time < lap.best) lap.best = lap.time;
          lap.n += 1; lap.time = 0; lap.sector = 0;
          return 2;
        }
        // otherwise: crossed without completing the loop (e.g. reversed over the line and came back) — ignore
        return 0;
      }
      if (pq === 0 && q === 3) {                      // went back over the line
        if (lap.sector === 0) lap.behind = true;
        return 0;
      }
      if (lap.started && q === lap.sector + 1 && pq === lap.sector) lap.sector = q;
      return 0;
    };

    /** Race distance covered: laps completed + fraction of the current lap (negative on the grid). */
    lap.progress = function (idx) {
      var done = lap.n > 0 ? lap.n - 1 : 0;
      return done + idx / N - (lap.behind ? 1 : 0);
    };

    lap.reset(startIdx || 0);
    return lap;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createLapCounter;
})(typeof window !== 'undefined' ? window : globalThis);
