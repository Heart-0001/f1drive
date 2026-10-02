// F1Drive - computer drivers (F1.createAIDriver, F1.AI). Pure logic: no DOM, no THREE, no timers, no Math.random:
// works in the browser (classic script after js/car.js, js/collide.js, js/pit.js) and in node (module.exports = F1.AI).
// Tests: test/ai.test.js; race simulations with the real js/car.js + js/collide.js + js/pit.js + js/tyres.js + js/laps.js
// + net/session.js: devtests/ai-test/ (README there).
//
//   var ai = F1.createAIDriver({ track, raceLine, car, skill, seed, id, slot, name })
//     track     F1.buildTrack(...)
//     raceLine  any F1.buildRaceLine(track, perf) of this track: only its GEOMETRY is used (points x / z / y / d /
//               curvature do not depend on the car), so the player's line serves every computer car
//     car       the F1.createCar(spec) this driver drives (car.perf / state / tyres are read, never written); its
//               own speed profile is built from the line's geometry with THIS car's limits (cached per spec + skill)
//     skill     0..1, or a level id / name of F1.AI.LEVELS ('rookie' | '新手', 'amateur' | '業餘', 'pro' | '職業',
//               'legend' | '傳奇'); seed: integer, every random decision comes from it (a race is reproducible)
//     id        this car's id in `others` (skipped there); slot: its pit box, track.pit.boxes[slot] (= its room slot)
//     mistakeRate (optional, tests) the chance of a mistake per braking zone instead of the level's
//   ai.think(dt, others, ctx) -> input     once per PHYSICS STEP (main.js's STEP 1/120 s), right before
//               car.update(dt, input, track). The same object every time: {up, down, left, right (false), throttle,
//               brake, steerAxis, boost, limiter, reset}. reset = true: please do the player's R for this car
//               (F1.AI.resetCar(car, track, idx, others, id) + lap.sync); the driver notices the move by itself.
//               ~2..3 us per call. Allocation: ~0 once V8 has optimised it (< 2 B per call in test/ai.test.js with race
//               contexts; 0.4..1 B in devtests/ai-test/alloc.js between V8's rare re-optimisations). The step runs in
//               phases, each its own function (see "the step" below), so that a branch reached for the first time
//               de-optimises one phase, not the whole step. Call F1.AI.warmUp(track, raceLine) while the track loads:
//               the first race of a session then allocates ~30 MB instead of ~160 MB (devtests/ai-test/warmup.js).
//     others    every other car as views made by F1.AI.createView(id) and refreshed in place each step (it may hold
//               this car too): {id, x, z, heading, speed, sampleIndex, d, ghost, prog, pace, y}. sampleIndex / d as
//               car.state has them (F1.AI.updateView locates remote cars, with their height y at a bridge); ghost:
//               not solid for anybody (Grand Prix ghost rules; cars on the pit asphalt are recognised here anyway);
//               prog: race distance in laps (lap.progress: blue flags); pace: ai.pace of a computer car, NaN for a
//               human (unknown); y: the car's height (NaN unknown: only F1.AI.resetCar uses it). Fill every field of a
//               view in place and add none (one shape for all: think() stays optimised and allocation-free). id: a
//               number >= 0, any size (a room's ids grow past 63): what a driver remembers of a car is keyed by it.
//     ctx       F1.AI.createContext(), refreshed in place: { phase: 'free' | 'quali' | 'grid' | 'race' | 'results',
//               locked (the grid before lights out: pad at rest), lap (timed laps completed in this phase), laps (laps
//               of the phase: Q / R; 0 = open-ended), done (took the flag / did its qualifying laps), prog (own race
//               distance in laps; a number - NaN when unknown), pit (this car's F1.createPit().state; none: no pit
//               stops), wear (wear multiplier) }. Fill it in place; done: true / false (not a number or undefined).
//   ai.onPit(event) -> compound | null    the events of this car's F1.createPit().update(dt, car.state, track,
//               {slot}); at 'serviceDone' -> the compound to fit (car.tyres.fit(it))
//   ai.startCompound(raceLaps, wear) -> 'S' | 'M' | 'H'   the set to fit on the grid (F1.AI.startCompound too)
//   ai.reset()  after every placement (grid, qualifying start, a new track); ai.setSkill(s); ai.setSlot(slot)
//   ai.pace     the lap time (s) of its profile: put it in its view (others[i].pace)
//   ai.planStop(compound, park)   a stop at the next chance (the window before the pit entry), or park in the box
//   ai.state    live: mode ('race' | 'follow' | 'overtake' | 'defend' | 'yield' | 'pit' | 'parked' | 'start' | 'grid' |
//               'reverse' | 'recover'), targetSpeed, cap (what holds it back), capBy (id of the car whose follow cap
//               binds, -1), tgt (id of the car being passed / driven round, -1), obs (sample of the stopped car it
//               swerves round, -1), offset, idx, plan, mistake, compound... (a debug overlay can show these)
//   ai.stats    counters: mistakes, offs, wallHits, resets, reverses, stuck, passes, passTries, defends, yields,
//               concedes, pitStops; ai.log: the last 24 rare events [t, what, sample]
//   F1.AI = { LEVELS, skillOf, levelOf, params, PACE, paceOf, prepare, profile, makeRandom, createView, createContext,
//             updateView, placeOnGrid(car, track, slot), resetCar(car, track, idx?, others?, selfId?), createContacts(),
//             warmUp(track, raceLine, opts?), lineup(opts),
//             shortName, INVENTED, startCompound(laps, wear, trackLength) }
//   Heights: every track.locate of this module passes the car's height (state.y / a view's y), as js/car.js does: at an
//   over / under crossing (Suzuka) a car stays on its road (devtests/ai-test/bridge.js).
//
// Driving: the racing line's path (track sample i <-> raceLine.points[i]) with a lateral offset for racecraft, pure
// pursuit steering through the car's own steering law (car.perf.steerLockAt when js/car.js has it, else the v5 law),
// the speed profile followed with analog pedals (the profile's deceleration fed forward, the error fed back, a braking
// scan of everything ahead with the profile's own braking model), battery on the straights, the limiter in the pit
// lane. A corner tighter than full lock with the steering margin (with js/car.js's v6.2 law: the Monaco hairpin) is
// taken at the top of the full-lock range (~45..50 km/h, as js/raceline.js does), not at a crawl.
// Skill sets the share of the line's grip / braking margins the profile uses (calibrated: rookie +8 %, amateur
// +5 %, pro +2.5 %, legend +1 % median lap over the circuits against the line's own pace driven perfectly), the
// reaction at lights out, throttle / brake application, lap-to-lap noise, lateral wander, the following gap, the
// patience before a pass, how long it resists a quicker car, and the mistakes (late braking / too fast into a corner,
// rarely a big one), all from the seeded generator.
//
// Racecraft: EVERY car on its path gives a speed cap (a relative speed law with the other car's measured deceleration,
// and at the cap the deceleration that keeps the gap fed forward to the pedals), not only the nearest one (which may
// hide a stopped one). "On the path" is looked at where the other car is now, where its sideways motion takes it in a
// second, where both cars are actually heading (a car sliding wide in a tight corner), and - closing fast - where this
// car will catch it (the racing line may swing across the road on the way); a car found there stays found for 0.3 s.
// A car known to be slower (its pace: a computer car) is pressed on the straights (radius > PRESS_R at both cars; not
// with a stop planned, from the decision to 90 m past the lane):
// followed at PRESS_GAP of the time gap and its braking - no harder than this car's own plan - not anticipated, so that
// the quicker car gains in the braking zone instead of braking with it from 100 m back (js/car.js has no slipstream:
// without this a car 2..4 % quicker sat in a train behind a slower one for whole races; review r3). A slower one (by
// pace, or held up) is attacked on the side with room at ITS place - beside it on the straight (more room the faster it
// is gone by), the inside edge into the corner unless it is there itself - while the gap keeps shrinking; the path is
// checked for it where the two will meet until this car is alongside; a car alongside always gets room (both boxes'
// extent across the road and the corner's chord) and whoever is behind gives way when there is none (level: the lower
// id keeps its line); mild defence (covers the inside once, no weaving); a slower driver under pressure from a quicker
// one gives it room on a straight after a while (rookies after ~2 s, legends never): pressure = within PRESS_NEAR s
// behind (a time gap: 28 m at least), let go beyond PRESS_FAR s; a car of unknown pace (a human) presses at half rate
// and only while it has been seen to be quicker (closing by PRESS_DV m/s while this car is flat out, in the last
// PRESS_SEEN s) - never for merely sitting behind at the same pace; the room given: the edge, and max(its speed - 8
// m/s, 78 % of this car's pace) for up to 8 s; blue flags (a car a lap up) and, after the flag, out of everybody's way:
// the side chosen once and the edge held (anchored path: not swinging across with the racing line in front of the car
// coming by); ghosts ignored. Through a corner tighter than full lock (from 30 m before it to 40 m after: the Monaco
// hairpin) nobody attacks or defends - every car turns its tightest, there is no line to choose - and the queue keeps 5
// m more gap (cars at different points of the turn are closer than the gap along the centreline says).
// Stopped cars (standing > 1.5 s) and cars coming the wrong way: a yellow flag (no racing past moving cars, no
// defending or conceding); the nearest one on (or beside) the path is driven round in single file - a swerve from where
// the path is to a place beside it (on a side it can still reach; in a tight corner its outside) and back, the meeting
// point for a car coming the wrong way (taken on from 50 m + 1.5 s of the closing at both speeds; beside where it will
// be there - on the racing line it follows the line - and the side chosen there: aimed beside where it was, the cars
// swerved into it at full strength; review r3); one queuing behind another is followed, not passed; creeping past once
// its box clears, backing off when nose to tail; a car that cannot get there is braked for (reachability);
// no room at all (a car across a narrow street): R after 8 s, which puts it down past (F1.AI.resetCar with others).
// Start: reaction, then its grid lane for the first 120 m. Recovery: off the road it slows and steers back; facing
// the wrong way it stops and asks for R; no progress: reverse, then R (30 s in a jam: R anyway); after R it waits for
// the traffic coming before rejoining. Pit stops: a stint optimiser once a lap (grip lost to wear over the laps left
// against the pit lane's time loss; punctures at once; stints planned to 88 %, in at the latest before 93 %), the
// softest compound that lasts, the lane at the limit with the limiter (track.pit.limitKmh read live: track.pit.setYear
// moves it under the cars), its own box, out through the taper; the cars heading for the lane see each other until
// they are on the pit asphalt. Qualifying: laps alone (others are ghosts),
// then back to its box when there is time.
(function (root) {
  'use strict';
  var F1 = root.F1 = root.F1 || {};

  // ---- constants ------------------------------------------------------------------------------------------------
  var CAR_LEN = 5.4, CAR_WID = 1.9;          // js/collide.js box
  var EDGE = 1.2;                            // m: the car's centre at least this far inside the white line
  var WALL_GAP = 1.6;                        // m: ... and from a wall face
  var SEP = CAR_WID + 0.8;                   // m centre to centre kept from a car alongside (+ the angle's share)
  var ALONG = CAR_LEN + 1.5;                 // m: closer than this along the track = alongside
  var GRAV = 9.81, TWO_PI = 2 * Math.PI;
  var STEER_MARGIN = 1.22;                   // js/raceline.js: steering-lock reserve at low speed
  var MIN_SPEED = 7;                         // m/s floor of the profile (js/raceline.js)
  var TOP = 140;                             // m/s: "no corner limit"
  var CREST_SPAN = 3;
  var LATENCY = 0.07;                        // s: the profile is read this far ahead
  var KP = 2.4;                              // 1/s speed error -> acceleration
  var SCAN_STEP = 2;                         // samples between two looks of the braking scan
  var LOOK_MIN = 7, LOOK_MAX = 35;           // m: pursuit look-ahead 5 + 0.3 v, clamped
  var NOISE_TAU = 3;                         // s: pace noise correlation time
  var WANDER_TAU = 4;                        // s: lateral wander correlation time
  var FOLLOW_A = 7;                          // m/s^2 of deceleration a follower keeps in hand over the car ahead
  var PRESS_PACE = 0.01;                     // a car ahead known to be this much slower (pace) is pressed: closed up on
  var PRESS_GAP = 0.3;                       //   to this share of the time gap (K.gapT), its braking not anticipated
  var PRESS_R = 80;                          //   (m: on a road no tighter than this at either car)
  var PRESS_NEAR = 0.5, PRESS_FAR = 1;       // s: a quicker car this close behind presses (concede), let go beyond
  var PRESS_DV = 1.5, PRESS_SEEN = 2;        // m/s of closing while this car is flat out: a car of unknown pace is seen to
                                             //   be quicker, and presses for PRESS_SEEN s after that
  var PEDAL_BAND = 1.5;                      // m/s^2 of coasting between throttle and brake (no pedal flipping)
  var IN_PATH_HOLD = 0.3;                    // s a car found on the path stays on it (hysteresis)
  var LAT_REACH = 3;                         // m/s: how fast a car is counted on to get across the road (reachability)
  var OBS_AFTER = 8, OBS_OUT = 30;           // m: a stopped car is passed beside it until this far past it, then the
                                             //   path blends back to the line over OBS_OUT
  var LOG_N = 24;                            // ai.log entries kept
  var TIGHT_GAP = 5;                         // m more following gap round a corner tighter than full lock
  var LEVEL_DY = 3;                          // m: another car this much higher / lower is on the other road of a bridge
  var OUT_NONE = -1e9;                       // plan.outFrom: not leaving the box yet (a number: the field keeps one kind)
  var SLOW_EVERY = 12;                       // steps between two updates of the slow processes (noise, strategy)
  var STUCK_S = 5;                           // s without progress before a reverse attempt
  var STUCK_HARD_S = 14;                     // s without progress (not waiting in a queue): R
  var STUCK_JAM_S = 30;                      // s without progress at all (a jam): R
  var WRONG_S = 0.8;                         // s facing the wrong way before stopping for R
  var REV_S = 1.3;                           // s of a reverse attempt
  var RESET_GAP_S = 2;                       // s between two R requests
  var REJOIN_MAX_S = 6;                      // s waiting for traffic before rejoining at most
  var PIT_DECIDE_FAR = 330, PIT_DECIDE_NEAR = 110;   // m before track.pit.from: the stop is decided in this window
  var PIT_BLEND = 60;                        // samples (~120 m) before pit.from over which the car moves over
  var BOX_IN = 16, BOX_OUT = 12;             // samples of the lateral move into / out of the box
  var BOX_STOP_A = 4.5;                      // m/s^2 braking into the box
  var LIMIT_MARGIN = 1.3;                    // m/s under the pit limit
  var TAPER_DV = 2;                          // m/s over the pit limit through the exit taper (it bends: the car
                                             //   must not cut onto the grass beside it)
  var WEAR_END = 0.82;                       // a set chosen to last the rest is planned to reach the flag under this
  var W_LAST = 0.78;                         // free practice: a set that would pass this is changed
  var W_PUNCT = 0.93;                        // a set never runs on past this: in at the chance before (js/tyres.js: punctures
                                             //   from 1.03 raw; the cliff costs ~12 % grip at 90 %)
  var W_PLAN = 0.88;                         // ... and stints are planned to end below this (the wear per lap is an estimate:
                                             //   js/tyres.js wears 11.5..18.6 laps of 5 km per medium set, and an overheating
                                             //   soft wears faster than its 2x)
  var W_SAFE = 0.85;                         // a set this worn is changed at the next chance whatever the strategy says
  var WEAR_LAP0 = 1 / 15 / 5000 * 1.15;      // wear per lap and metre of a medium set at rate 1 before it has been
                                             //   measured (js/tyres.js: 15 laps of 5 km; +15 % for racing in traffic)
  var COMPOUND_WEAR = { S: 2.4, M: 1, H: 0.5 }; // js/tyres.js wear multipliers (S 2, + its overheating in hard racing) ...
  var COMPOUND_GRIP = { S: 1.015, M: 1, H: 0.985 };   // ... and grip
  var ORDER = ['S', 'M', 'H'];                // the compounds, softest first

  // ---- skill levels (lapPct: measured gap to the reference driver of the car, devtests/ai-test/pace.js) -----------
  var LEVELS = [
    { id: 'rookie', name: '新手', skill: 0, lapPct: 8 },
    { id: 'amateur', name: '業餘', skill: 0.35, lapPct: 5 },
    { id: 'pro', name: '職業', skill: 0.7, lapPct: 2.5 },
    { id: 'legend', name: '傳奇', skill: 1, lapPct: 1 }
  ];
  // Pace: the profile uses PACE x the racing line's own margins (js/raceline.js: 0.86 of the lateral grip, 0.80 of the
  // braking) as grip = LINE_GRIP * p, brake = LINE_BRAKE * p^1.5. p per level, calibrated so that the median lap over
  // the circuits is lapPct slower than the REFERENCE (the line's margins, p = 1, driven perfectly: no noise, no
  // mistakes, battery as the AI uses it): devtests/ai-test/calibrate.js. Linear in between.
  var LINE_GRIP = 0.86, LINE_BRAKE = 0.80;
  var PACE = [[0, 0.841], [0.35, 0.89], [0.7, 0.942], [1, 0.977]];   // 2026-10-01 (v6.2 steering law + track data, the
                                                                     // Monaco hairpin at full lock): 8.02 / 5.03 / 2.50 / 1.00 %
  function paceOf(s) {
    for (var i = 1; i < PACE.length; i++) if (s <= PACE[i][0]) return lerp(PACE[i - 1][1], PACE[i][1], (s - PACE[i - 1][0]) / (PACE[i][0] - PACE[i - 1][0]));
    return PACE[PACE.length - 1][1];
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(x) { x = x < 0 ? 0 : (x > 1 ? 1 : x); return x * x * (3 - 2 * x); }
  function isNum(v) { return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity; }

  // mulberry32: a small, fast, seedable generator -> [0, 1)
  function makeRandom(seed) {
    var A = new Int32Array(1);
    A[0] = (seed | 0) ^ 0x9e3779b9;
    return function () {
      var a = A[0] = (A[0] + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** skill 0..1 from a number or a level id / name; anything else -> the 'pro' level */
  function skillOf(x) {
    if (typeof x === 'number' && x === x) return clamp(x, 0, 1);
    if (typeof x === 'string') for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === x || LEVELS[i].name === x) return LEVELS[i].skill;
    return LEVELS[2].skill;
  }
  /** the level nearest to a skill (for the UI) */
  function levelOf(s) {
    s = skillOf(s);
    var best = LEVELS[0];
    for (var i = 1; i < LEVELS.length; i++) if (Math.abs(LEVELS[i].skill - s) < Math.abs(best.skill - s)) best = LEVELS[i];
    return best;
  }

  // What every number of the behaviour is at skill s.
  function params(s, ref) {
    var p = ref ? 1 : paceOf(s);
    return {
      pace: p,
      grip: LINE_GRIP * p,                    // share of the lateral grip used by the corner speeds
      brake: LINE_BRAKE * Math.pow(p, 1.5),   // share of the braking used by the braking points
      thrRate: lerp(2.5, 8, s),               // 1/s: throttle application
      brkRate: lerp(6, 14, s),                // 1/s: brake application
      react: lerp(0.38, 0.19, s),             // s: reaction at lights out ...
      reactSpread: lerp(0.18, 0.05, s),       //   ... plus up to this
      mistake: lerp(0.022, 0.0012, s),        // chance per braking zone
      big: lerp(0.15, 0.03, s),               // share of the mistakes that are big ones (a heavy off)
      noise: lerp(0.010, 0.0035, s),          // pace noise (share of the target speed, 1 sigma)
      wander: lerp(0.40, 0.10, s),            // m: lateral wander (1 sigma)
      gapT: lerp(0.65, 0.35, s),              // s: time gap kept to a car ahead
      sideRate: lerp(2.2, 3.4, s),            // m/s: how fast the path moves sideways (racecraft)
      patience: lerp(4.5, 1.2, s),            // s held up before trying a pass anyway
      attack: lerp(3.0, 1.2, s),              // m/s speed advantage that is worth a pass
      defend: s < 0.45 ? 0 : lerp(0.25, 0.75, (s - 0.45) / 0.55),   // chance to cover the inside once per attack
      reserve: lerp(0.30, 0.08, s),           // battery kept for attacking / defending
      concede: s >= 0.95 ? Infinity : lerp(2, 8, s / 0.95)    // s under pressure from a faster car before giving
                                                              //   it room on a straight (js/car.js has no slipstream)
    };
  }
  // the reference driver (opts.reference): the racing line's margins, driven perfectly
  function refParams() {
    var k = params(1, true);
    k.noise = 0; k.wander = 0; k.mistake = 0; k.big = 0; k.thrRate = 30; k.brkRate = 30; k.reserve = 0; k.concede = Infinity;
    return k;
  }

  // ---- track geometry shared by every driver of a track (cached per racing line) ------------------------------
  var geoCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  /** F1.AI.prepare(track, raceLine) -> the per-track geometry the drivers share (cached per raceLine.points) */
  function prepare(track, line) {
    var P = line && line.points ? line.points : line;
    if (!P || !P.length) throw new Error('F1.AI: raceLine.points missing');
    var hit = geoCache && geoCache.get(P);
    if (hit && hit.track === track) return hit;
    var S = track.samples, N = S.length, ds = track.length / N, i, j;
    if (P.length !== N) throw new Error('F1.AI: the racing line is not of this track');
    var G = {
      track: track, P: P, N: N, ds: ds,
      d: new Float64Array(N), curv: new Float64Array(N), absK: new Float64Array(N), sign: new Float64Array(N),
      bank: new Float64Array(N), pitch: new Float64Array(N), kv: new Float64Array(N), seg: new Float64Array(N),
      lo: new Float64Array(N), hi: new Float64Array(N), tx: new Float64Array(N), tz: new Float64Array(N),
      hdg: new Float64Array(N), lhdg: new Float64Array(N), pit: null, profiles: {}, lapT: {}, tight: {}, pitLoss: 0, warmed: false,
      pitTrackT: 0, pitLossV: 0                // (pitLossOf: the track's time over the lane's stretch, the limit pitLoss is for)
    };
    for (i = 0; i < N; i++) {
      var p = P[i], s = S[i];
      G.d[i] = isNum(p.d) ? p.d : 0;
      G.curv[i] = isNum(p.curvature) ? p.curvature : 0;
      G.bank[i] = isNum(s.bank) ? s.bank : 0;
      G.tx[i] = s.tx; G.tz[i] = s.tz; G.hdg[i] = Math.atan2(s.tx, s.tz);
      var hw = (s.halfW > 0 ? s.halfW : track.halfWidth) - EDGE;
      var wp = (isNum(s.wallPosDist) ? s.wallPosDist : track.wallDist) - WALL_GAP;
      var wn = (isNum(s.wallNegDist) ? s.wallNegDist : track.wallDist) - WALL_GAP;
      G.hi[i] = Math.max(0, Math.min(hw, wp));
      G.lo[i] = -Math.max(0, Math.min(hw, wn));
      j = (i + 1) % N;
      var sl = Math.hypot(P[j].x - p.x, P[j].z - p.z);
      G.seg[i] = sl < 0.05 ? 0.05 : sl;
    }
    for (i = 0; i < N; i++) {                // the racing line's own direction (it leads the centreline in a corner)
      var pa = P[(i - 2 + N) % N], pb = P[(i + 2) % N];
      G.lhdg[i] = Math.atan2(pb.x - pa.x, pb.z - pa.z);
    }
    for (i = 0; i < N; i++) {
      var c = G.curv[i];
      G.absK[i] = Math.max(Math.abs(c), Math.abs(G.curv[(i + 1) % N]), Math.abs(G.curv[(i - 1 + N) % N]));
      G.sign[i] = c < 0 ? 1 : -1;            // js/raceline.js: curvature < 0 is a left turn
    }
    // slope of the line (sin of the climb angle) over +-6 m, vertical curvature of the centreline (> 0 over a crest)
    var ly = new Float64Array(N), kv0 = new Float64Array(N);
    for (i = 0; i < N; i++) ly[i] = isNum(P[i].y) ? P[i].y : (isNum(S[i].y) ? S[i].y : 0);
    for (i = 0; i < N; i++) {
      var i3 = (i + 3) % N, im3 = (i - 3 + N) % N, run = 0;
      for (j = 0; j < 6; j++) run += G.seg[(im3 + j) % N];
      var rise = ly[i3] - ly[im3];
      G.pitch[i] = Math.asin(clamp(rise / Math.hypot(run, rise), -0.9, 0.9));
      var sp = S[(i - 1 + N) % N], sc = S[i], sq = S[(i + 1) % N], k0 = 0;
      var gp = Math.hypot(sc.x - sp.x, sc.z - sp.z), gq = Math.hypot(sq.x - sc.x, sq.z - sc.z);
      if (isNum(sc.y) && isNum(sp.y) && isNum(sq.y) && gp > 1e-6 && gq > 1e-6 && gp <= 10 && gq <= 10) {
        k0 = -((sq.y - sc.y) / gq - (sc.y - sp.y) / gp) / (0.5 * (gp + gq));
      }
      kv0[i] = isNum(k0) ? k0 : 0;
    }
    for (i = 0; i < N; i++) {
      var km = kv0[i];
      for (j = -CREST_SPAN; j <= CREST_SPAN; j++) { var kq = kv0[((i + j) % N + N) % N]; if (kq > km) km = kq; }
      G.kv[i] = km;
    }
    // pit lane: the lane's centre per sample (NaN outside from..to), lane positions counted from pit.from
    var pit = track.pit;
    if (pit && typeof pit.laneD === 'function' && isNum(pit.from) && isNum(pit.to) && isNum(pit.entry) && isNum(pit.exit)) {
      var L = ((pit.to - pit.from) % N + N) % N, lane = new Float64Array(L + 1), ok = true;
      for (i = 0; i <= L; i++) { lane[i] = pit.laneD((pit.from + i) % N); if (!isNum(lane[i])) ok = false; }
      if (ok) {
        G.pit = {
          from: pit.from, L: L, lane: lane, side: pit.side < 0 ? -1 : 1,
          entryU: ((pit.entry - pit.from) % N + N) % N, exitU: ((pit.exit - pit.from) % N + N) % N,
          limitV: 80 / 3.6,                    // (live: pitLimitOf)
          boxes: pit.boxes || [], paved: typeof pit.paved === 'function' ? pit.paved : null,
          pavLo: new Float64Array(L + 1), pavHi: new Float64Array(L + 1)
        };
        pitLimitOf(G);
        // the pit asphalt across the road at each lane sample (side x d from pavLo to pavHi; NaN: none), sampled
        // from pit.paved once here, so that think() tests it without calling out
        for (i = 0; i <= L; i++) {
          var lo = NaN, hi = NaN, q = (pit.from + i) % N;
          for (var a10 = 0; a10 <= 400 && G.pit.paved; a10++) {
            var a = a10 * 0.1;
            if (G.pit.paved(q, a * G.pit.side)) { if (!(lo === lo)) lo = a; hi = a; }
          }
          G.pit.pavLo[i] = lo; G.pit.pavHi[i] = hi;
        }
      }
    }
    if (geoCache) geoCache.set(P, G);
    return G;
  }

  function lockAt(perf, v, bank, sign) {
    if (typeof perf.steerLockAt === 'function') return perf.steerLockAt(v, bank, sign);
    var r = v / perf.steerSpeedRef;
    return perf.steerLock / (1 + r * r);
  }

  /** The target speed profile (m/s per sample) of a car (perf = car.perf) on G at grip / brake shares: corner speeds
   *  from the line's curvature against the car's load model and steering lock, then the braking pass. Cached on G. */
  function profileKeyOf(perf, grip, brake) {
    return (perf.spec ? perf.spec.id : '?') + '|' + [perf.power, perf.latBase, perf.downforce, perf.brakeBase, perf.traction,
      perf.dragK, perf.latMax, perf.steerLock].join(',') + '|' + grip.toFixed(4) + '|' + brake.toFixed(4);
  }
  // The pit lane's speed limit, read live into G.pit.limitV (m/s): track.pit.setYear changes track.pit.limitKmh in
  // place when the season changes (Zandvoort, Singapore: 60 km/h up to 2024, 80 from 2025), and G is shared by every
  // driver of the track for the whole session - a copy taken once in prepare() kept the computer cars on the old limit
  // (60 -> 80: a speeding penalty at every stop; 80 -> 60: a crawl at 55 km/h; review r3). Every step and every stop
  // decision read it again.
  function pitLimitOf(G) {
    var tp = G.track.pit, lk = tp ? tp.limitKmh : NaN;
    G.pit.limitV = (isNum(lk) && lk > 0 ? lk : 80) / 3.6;
  }
  // the time a stop costs (G.pitLoss, from the first profile a driver uses on the track): the lane at the limit against
  // the track at speed, the service, slowing / pulling away; the lane's part again when the limit changed since
  function pitLossOf(G, va, perf) {
    if (!G.pit) return;
    var Pq = G.pit, N = G.N, tl = 0, tr = 0, i, q;
    pitLimitOf(G);
    if (G.pitLoss > 0) {
      if (G.pitLossV === Pq.limitV) return;
      for (i = 0; i <= Pq.L; i++) tl += G.seg[(Pq.from + i) % N] / Pq.limitV;
      G.pitLoss = tl - G.pitTrackT + 2.8 + 3; G.pitLossV = Pq.limitV;
      return;
    }
    for (i = 0; i <= Pq.L; i++) { q = (Pq.from + i) % N; var vt = va[q] < perf.topSpeed ? va[q] : perf.topSpeed; tl += G.seg[q] / Pq.limitV; tr += G.seg[q] / vt; }
    G.pitLoss = tl - tr + 2.8 + 3; G.pitTrackT = tr; G.pitLossV = Pq.limitV;
  }
  function profile(G, perf, grip, brake) {
    var key = profileKeyOf(perf, grip, brake);
    if (G.profiles[key]) { pitLossOf(G, G.profiles[key], perf); return G.profiles[key]; }
    var N = G.N, va = new Float64Array(N), tt = new Uint8Array(N), i, j, m, iMin = 0;
    var wb = perf.wheelbase || 3.6;
    for (i = 0; i < N; i++) {
      var k = G.absK[i], v = TOP, bk = G.bank[i], pt = G.pitch[i], kv = G.kv[i], sg = G.sign[i];
      if (k > 1e-6) {
        if (grip * perf.maxLatAccel(v, bk, pt, kv, sg) < v * v * k) {
          var lo = MIN_SPEED, hi = TOP;
          if (grip * perf.maxLatAccel(lo, bk, pt, kv, sg) < lo * lo * k) v = lo;
          else {
            for (var it = 0; it < 22; it++) {
              var mid = 0.5 * (lo + hi);
              if (grip * perf.maxLatAccel(mid, bk, pt, kv, sg) >= mid * mid * k) lo = mid; else hi = mid;
            }
            v = lo;
          }
        }
        // steering lock: tan(lock(v)) / wheelbase >= k * margin. With the car's own law (js/car.js perf.steerLockAt,
        // v6.2; js/raceline.js does the same) a path tighter than full lock with the margin cannot be followed any
        // better slower - below ~52 km/h the radius at full lock does not shrink any more: the target is the top of the
        // full-lock range (the Monaco hairpin at ~50 km/h, as in reality), not a crawl at MIN_SPEED
        var need = Math.atan(wb * k * STEER_MARGIN);
        // (tt: a corner tighter than full lock - no line to choose there: computer cars do not attack in it)
        var lk0 = lockAt(perf, MIN_SPEED, bk, sg);
        if (lk0 < need) { tt[i] = 1; if (typeof perf.steerLockAt === 'function') need = lk0; }
        if (lockAt(perf, v, bk, sg) < need) {
          var a = MIN_SPEED, b = v;
          if (lockAt(perf, a, bk, sg) < need) v = MIN_SPEED;
          else {
            for (var it2 = 0; it2 < 22; it2++) { var c = 0.5 * (a + b); if (lockAt(perf, c, bk, sg) >= need) a = c; else b = c; }
            v = a;
          }
        }
      }
      va[i] = v < MIN_SPEED ? MIN_SPEED : v;
      if (va[i] < va[iMin]) iMin = i;
    }
    // braking: backwards from the slowest point, two laps so that the loop closes (js/raceline.js's pass)
    var latMax = perf.latMax, roll = perf.roll, dragK = perf.dragK;
    for (m = 0; m < 2 * N; m++) {
      i = ((iMin - 1 - m) % N + N) % N; j = (i + 1) % N;
      var v1 = va[j], gs = GRAV * Math.sin(G.pitch[i]);
      var lat = v1 * v1 * Math.abs(G.curv[i]); if (lat > latMax) lat = latMax;
      var coast = roll + dragK * v1 * v1 + gs;
      var dec = perf.maxDecel(v1, G.bank[i], G.pitch[i], G.kv[i], lat * G.sign[i]) - coast;
      dec = brake * dec + coast;
      if (dec < 1) dec = 1;
      var vb = Math.sqrt(v1 * v1 + 2 * dec * G.seg[i]);
      if (vb < va[i]) va[i] = vb;
    }
    G.profiles[key] = va; G.tight[key] = tt;
    var lt = 0;
    for (i = 0; i < N; i++) { var vv = va[i] < perf.topSpeed ? va[i] : perf.topSpeed; lt += G.seg[i] / (vv > 1 ? vv : 1); }
    G.lapT[key] = lt;
    pitLossOf(G, va, perf);
    return va;
  }

  // ---- the driver ----------------------------------------------------------------------------------------------
  var EMPTY_CTX = {};
  var EMPTY = [];

  function createAIDriver(opts) {
    opts = opts || {};
    var track = opts.track, car = opts.car;
    if (!track || !car || !car.state || !car.perf) throw new Error('F1.createAIDriver: track and car are required');
    var G = prepare(track, opts.raceLine);
    var S = track.samples, N = G.N, ds = G.ds, LD = G.d, CV = G.curv, LO = G.lo, HI = G.hi, HALF_N = N >> 1;
    var seed = isNum(opts.seed) ? opts.seed | 0 : 1;
    // the seeded generator (mulberry32, as makeRandom): rndF() puts the next number in F[6] (no allocation), rnd()
    // returns it (rare calls)
    var RS = new Int32Array(1);
    RS[0] = (seed | 0) ^ 0x9e3779b9;
    function rndF() {
      var a = RS[0] = (RS[0] + 0x6D2B79F5) | 0;
      var q = Math.imul(a ^ (a >>> 15), 1 | a);
      q = (q + Math.imul(q ^ (q >>> 7), 61 | q)) ^ q;
      F[6] = ((q ^ (q >>> 14)) >>> 0) / 4294967296;
    }
    function rnd() { rndF(); return F[6]; }
    var selfId = opts.id !== undefined ? opts.id : null;
    var slot = isNum(opts.slot) ? Math.max(0, Math.floor(opts.slot)) : 0;
    var skill = skillOf(opts.skill === undefined ? 'pro' : opts.skill);
    var isRef = !!opts.reference;
    // (opts.mistakeRate: the chance of a mistake per braking zone instead of the level's - tests, F1.AI.warmUp)
    var mistakeRate = isNum(opts.mistakeRate) ? clamp(opts.mistakeRate, 0, 1) : -1;
    var K = isRef ? refParams() : params(skill);
    if (mistakeRate >= 0) K.mistake = mistakeRate;
    var perfFor = null, VA = null, TT = null, profileKey = '', hasLockAt = false, WB = 3.6;   // the car's perf the profile was built for, the profile

    // (the pedals and the axis start as doubles - 0.5, then 0 - so that the object's fields hold doubles from the first
    // think on: a field created with 0 holds small integers, and the first double stored into it changes the object's
    // shape, which throws every optimised function that has seen it - js/car.js's update included - back to the
    // interpreter)
    var input = { up: false, down: false, left: false, right: false, throttle: 0.5, brake: 0.5, steerAxis: 0.5,
                  boost: false, limiter: false, reset: false };
    input.throttle = 0; input.brake = 0; input.steerAxis = 0;
    var st = car.state;

    // live state (ai.state) and counters (ai.stats)
    var info = { mode: 'race', targetSpeed: 0.5, offset: 0.5, offTarget: 0.5, idx: 0, plan: null, mistake: null,
                 lapsSeen: 0, wearPerLap: 0.5, compound: 'M', cap: '', lastReset: '', tgt: -1, capBy: -1, obs: -1 };
    info.wearPerLap = 0;                       // (a field of doubles: see input)
    // the last few rare events (reverse, R, pit decisions, mistakes): [t, what, sample] for debugging, LOG_N kept
    var log = [], logN = 0;
    function note(what) {
      var e = log.length < LOG_N ? (log[log.length] = [0, '', 0]) : log[logN % LOG_N];
      e[0] = Math.round(M.t * 10) / 10; e[1] = what; e[2] = idx; logN++;
    }
    var stats = { mistakes: 0, bigMistakes: 0, offs: 0, wallHits: 0, resets: 0, reverses: 0, stuck: 0, passes: 0,
                  passTries: 0, defends: 0, yields: 0, concedes: 0, pitStops: 0, steps: 0, rejoinWaits: 0 };

    // ---- per-run state (reset()) ----
    // the per-step numbers live in one object whose fields hold doubles (V8 updates them in place: closure variables
    // holding doubles would allocate a heap number at every store)
    // helpers hand their numbers back through F (a function result that is a double would be boxed - allocated -
    // whenever V8 does not inline the call into think()): F[0] pathD, F[1] alongOf, F[2] targetAt, F[3] inPathOf (in: F[8..12]), F[5] accOf
    // (in and out), F[6] the random generator / gauss, F[7] walkTo, F[13] (+ F[16]) chooseSide / yieldSide in
    var F = new Float64Array(20);
    var M = {
      t: 0.5, lastX: 0.5, lastZ: 0.5, offset: 0.5, offTarget: 0.5, wander: 0.5, noise: 0.5, thrOut: 0.5, brkOut: 0.5,
      goT: 0.5, reactT: 0.5, progT: 0.5, hardT: 0.5, stuckT: 0.5, wrongT: 0.5, revUntil: 0.5, revSteer: 0.5,
      revAt: 0.5, resetAt: 0.5, rejoinT: 0.5, tgtT: 0.5, tgtCool: 0.5, tgtBlock: 0.5, tgtBest: 0.5,
      tgtBestT: 0.5, followT: 0.5, defT: 0.5, pressT: 0.5, concedeT: 0.5, holdT: 0.5, boxWait: 0.5, wearRef: 0.5,
      cLo: 0.5, cHi: 0.5, c0: 0.5, c2: 0.5, anchor: 0.5, absTgt: 0.5, sepT: 0.5, myD: 0.5, vMine: 0.5, obsD: 0.5, obsLb: 0.5, obsFrom: 0.5, myRot: 0.5, myVLat: 0.5, backT: 0.5, gT: 0.5, blockT: 0.5,
      startLane: 0.5, fastT: 0.5, closeR: 0.5, gBPrev: 0.5, closeT: 0.5
    };
    var steps, idx, prevIdx, wasLocked, startLaneOn, startDone, startFrom;
    var progIdx, rev, backing, revN, resetPending, onGrassPrev, hitPrev;
    var mist = { on: false, idx0: 0, span: 0, from: 0, lock: false, shift: 0, mul: 1.5 }, zoneOn;
    var tgt, tgtSide, tgtSlow, defId, yieldId, pressId, closeB, ySide, yFor, obsOn, obsK, obsKFrom, obsTgt;
    var plan, pending = null, served, lapCount, wearRefLap, lastStops, nextCompound, decidedLap;
    var cOn, pitU0, inPitArea;

    function reset() {
      M.t = 0; steps = 0;
      idx = st.sampleIndex | 0; if (!(idx >= 0 && idx < N)) idx = 0;
      M.lastX = st.x; M.lastZ = st.z; prevIdx = idx;
      M.offset = Math.min(Math.max(st.d - LD[idx], -12), 12); M.offTarget = 0; M.wander = 0; M.noise = 0; M.thrOut = 0; M.brkOut = 0;
      wasLocked = false; M.goT = -1; M.reactT = 0; startLaneOn = false; startDone = true; startFrom = idx;
      progIdx = idx; M.progT = 0; M.hardT = 0; M.stuckT = 0; M.wrongT = 0; rev = false; M.revUntil = 0; M.revSteer = 0; revN = 0; M.revAt = -1e9; M.resetAt = -1e9;
      resetPending = false; M.rejoinT = 0; onGrassPrev = false; hitPrev = false; backing = false; M.gT = 0;
      mist.on = false; zoneOn = false;
      tgt = null; tgtSide = 0; tgtSlow = false; M.tgtT = 0; M.tgtCool = 0; M.tgtBlock = 0; M.tgtBest = 0; M.tgtBestT = 0; M.followT = 0; defId = null; M.defT = 0; yieldId = null;
      pressId = null; M.pressT = 0; M.fastT = -1e9; M.closeR = 0; M.gBPrev = 0; M.closeT = -1e9; closeB = null; M.concedeT = 0; M.holdT = 0; M.backT = 0; M.blockT = 0; M.anchor = 0; M.absTgt = 0; M.sepT = SEP; ySide = 0; yFor = null;
      obsOn = false; obsK = 0; obsKFrom = 0; obsTgt = null; M.obsD = 0; M.obsLb = 40; M.obsFrom = 0;
      plan = null; pending = null; served = false; M.boxWait = 0; lapCount = 0; decidedLap = -1;
      M.wearRef = -1; wearRefLap = 0; lastStops = -1;
      M.cLo = -1e9; M.cHi = 1e9; cOn = false; pitU0 = 0; inPitArea = false;
      memId.fill(-1); oSlot = -1;              // (the memories of the other cars: their times are on the clock restarted here)
      info.plan = null; info.mistake = null; info.mode = 'race';
      if (car.tyres && car.tyres.state && car.tyres.state.compound) info.compound = car.tyres.state.compound;
      nextCompound = null;
    }

    function setSkill(s) {
      skill = skillOf(s);
      K = isRef ? refParams() : params(skill);
      if (mistakeRate >= 0) K.mistake = mistakeRate;
      perfFor = null;                         // the profile is rebuilt at the next think
      api.skill = skill; api.level = levelOf(skill);
    }

    function ensureProfile() {
      if (perfFor !== car.perf) {
        perfFor = car.perf; VA = profile(G, car.perf, K.grip, K.brake); profileKey = profileKeyOf(car.perf, K.grip, K.brake);
        TT = G.tight[profileKey];
        hasLockAt = typeof perfFor.steerLockAt === 'function';
        for (var r0 = 0; r0 < LOCK_ROWS; r0++) lockRows[r0] = null;
        WB = perfFor.wheelbase || 3.6;
      }
    }

    // The car's steering lock (js/car.js perf.steerLockAt, v6.2) for the pursuit: F[14] speed, F[15] bank in, F[14] the
    // lock out. Read from rows of the law over the speed (0.25 m/s steps) per bank bin (0.01 rad) and turn side, each
    // built the first time it is needed: calling the law itself every step would box its arguments (an allocation per
    // call: V8 does not inline a function of another module into think()).
    var TIGHT_BACK = Math.round(40 / ds), TIGHT_ON = Math.round(30 / ds);   // samples: the reach of a tight corner (above)
    var LOCK_DV = 0.25, LOCK_N = 480, LOCK_ROWS = 182, lockRows = [];
    for (var r1 = 0; r1 < LOCK_ROWS; r1++) lockRows.push(null);
    function lockRow(key, bi, si) {             // (its own function: the rare loop stays out of the steering phase)
      var row = new Float64Array(LOCK_N + 1);
      for (var j = 0; j <= LOCK_N; j++) row[j] = perfFor.steerLockAt(j * LOCK_DV, bi / 100, si > 0 ? 1 : -1);
      lockRows[key] = row;
      return row;
    }
    function lockFor(si) {
      var v = F[14], b = F[15];
      var bi = Math.round(b * 100) | 0; if (bi < -45) bi = -45; else if (bi > 45) bi = 45;
      var key = (bi + 45) * 2 + (si > 0 ? 1 : 0), row = lockRows[key];
      if (row === null) row = lockRow(key, bi, si);
      var x = (v < 0 ? -v : v) / LOCK_DV, j0 = x | 0;
      if (j0 >= LOCK_N) { F[14] = row[LOCK_N]; return; }
      F[14] = row[j0] + (row[j0 + 1] - row[j0]) * (x - j0);
    }

    // Would this car, rolled on 1.5 m and 3 m along its heading (0.25 m closer to the other car, side = where that one
    // is across the road), stay clear of the other car's box (js/collide.js)? Creeping past a stopped car.
    var probe = { x: 0.5, z: 0.5, heading: 0.5 };
    // (n: probes 1.5 m apart, 2 by default; mar: m the probe is moved towards it, 0.25 by default)
    function boxClear(o, side, n, mar) {
      var ovl = F1.resolveCarCollisions && F1.resolveCarCollisions.overlap;
      if (typeof ovl !== 'function') return false;
      var sh = Math.sin(st.heading), ch = Math.cos(st.heading), s0 = S[idx], kn = n > 2 ? n : 2, mg = mar > 0 ? mar : 0.25;
      for (var k = 1; k <= kn; k++) {
        probe.x = st.x + sh * 1.5 * k + s0.nx * mg * side; probe.z = st.z + ch * 1.5 * k + s0.nz * mg * side;
        probe.heading = st.heading;
        if (ovl(probe, o) > 0) return false;
      }
      return true;
    }

    // ---- helpers on the path ----
    // idx -> the nearest sample to the car by walking from idx (forwards / backwards while it gets nearer); F[7] = distance^2
    function walkTo() {
      var x = st.x, z = st.z, s = S[idx], dx = x - s.x, dz = z - s.z, best = dx * dx + dz * dz, k, n, d2, steps = 0;
      for (k = idx; steps < 60; steps++) {
        n = k + 1 === N ? 0 : k + 1; s = S[n]; dx = x - s.x; dz = z - s.z; d2 = dx * dx + dz * dz;
        if (d2 >= best) break;
        best = d2; k = n;
      }
      if (k === idx) {
        for (steps = 0; steps < 60; steps++) {
          n = k === 0 ? N - 1 : k - 1; s = S[n]; dx = x - s.x; dz = z - s.z; d2 = dx * dx + dz * dz;
          if (d2 >= best) break;
          best = d2; k = n;
        }
      }
      idx = k;
      F[7] = best;
    }
    // (| 0: int32 results - a helper that V8 does not inline would box any other number it returns, and -0 from %
    // is not a small integer)
    function cyc(i) { i = (i % N) | 0; return (i < 0 ? i + N : i) | 0; }
    function wrapN(d) { d = d | 0; return (d > HALF_N ? d - N : (d < -HALF_N ? d + N : d)) | 0; }
    function alongOf(x, z, i) { var s = S[i]; F[1] = (x - s.x) * s.tx + (z - s.z) * s.tz; }

    // Lateral offset of the path at sample k, m samples ahead of the car (m may be < 0 for samples just behind).
    function pathD(k, m) {
      if (plan && G.pit) pitPathD(k, m); else racePathD(k);
      var d = F[0];
      if (cOn && m < 30) { if (d > M.cHi) d = M.cHi; if (d < M.cLo) d = M.cLo; }
      F[0] = d;
    }
    // the racing path at sample k (no pit route): the line + the racecraft offset, anchored, round a stopped car, the
    // grid lane at the start; inside the road -> F[0]
    function racePathD(k) {
      var d = LD[k] + M.offset;
      {
        // anchored (yielding, going round a stopped car): the lateral position at the car is held ahead instead of
        // following the racing line's swing across the road
        if (M.anchor > 0) d += M.anchor * (LD[idx] - LD[k]);
        // round a stopped / crawling / oncoming car: a swerve to the place beside it (M.obsD at sample obsK), blended
        // in over M.obsLb metres before it and out over OBS_OUT after it
        if (obsOn) {
          // before it: from where the path was when the pass was decided (held; not the racing line, which may swing
          // towards the obstacle on the way) over the last M.obsLb metres to the place beside it; after it: back
          var u = wrapN(k - obsK) * ds;
          if (u < 0) {
            var span = -wrapN(obsKFrom - obsK) * ds;
            if (span > M.obsLb) span = M.obsLb; else if (span < 15) span = 15;
            // (smooth() written out here and below: a call that V8 does not inline boxes its argument and its result)
            if (u <= -span) d = M.obsFrom;
            else { var s1 = 1 + u / span; s1 = s1 < 0 ? 0 : (s1 > 1 ? 1 : s1); d = M.obsFrom + (M.obsD - M.obsFrom) * (s1 * s1 * (3 - 2 * s1)); }
          } else if (u < OBS_AFTER + OBS_OUT) {
            if (u < OBS_AFTER) d = M.obsD;
            else { var s2 = (u - OBS_AFTER) / OBS_OUT; s2 = s2 < 0 ? 0 : (s2 > 1 ? 1 : s2); d = M.obsD + (d - M.obsD) * (s2 * s2 * (3 - 2 * s2)); }
          }
        }
        if (startLaneOn && !startDone) {
          var w = (cyc(k - startFrom) * ds - 120) / 180;
          w = w < 0 ? 0 : (w > 1 ? 1 : w); w = w * w * (3 - 2 * w);
          d = M.startLane + (LD[k] - M.startLane) * w;
        }
        if (d > HI[k]) d = HI[k]; else if (d < LO[k]) d = LO[k];
      }
      F[0] = d;
    }

    // Is a car at sample oi, lateral od, g m ahead (along-track speed ov, sideways speed vLat, box width wPath across
    // this car's path) on this car's path? -> F[3] = 1 / 0. Looked at where it is now, and halfway to and at the
    // place where this car would catch it (the racing line may swing across the road in between: a car to the side
    // now can be right on the path there): its lateral place then is its sideways motion carried on (1 s at most,
    // inside the white lines), or, for a car on the racing line, the racing line.
    function inPathOf(oi, mOi, o) {
      var od = F[8], g = F[9], ov = F[10], vLat = F[11], wPath = F[12];   // (doubles in through F: no boxing)
      F[3] = 0;
      pathD(oi, mOi); var pd0 = F[0];
      if (Math.abs(od - pd0) < wPath || (g < 22 && Math.abs(od - M.myD) < wPath + M.myRot)) { F[3] = 1; return; }
      var cl = M.vMine - ov;                                   // closing speed
      var t1 = g / (cl > 1 ? cl : 1); if (t1 > 1) t1 = 1;
      var dP = od + vLat * t1;                                 // its sideways motion over the next second
      if ((dP - pd0) * (od - pd0) <= 0 || Math.abs(dP - pd0) < wPath) { F[3] = 1; return; }
      if (g < 25 && !(o === tgt && Math.abs(od - M.myD) > 1.5 && g < ALONG)) {
        // where this car is actually going (it may slide off its path in a tight corner): both cars carried on
        // sideways for a moment (not for the car being passed once this one is beside it - but while still behind it:
        // pure pursuit cuts across to a path laid beside it further on, and a quicker car closing from 8 m behind
        // turned into it; review r3)
        var tme = g / (cl > 1 ? cl : 1); if (tme > 0.6) tme = 0.6;
        if (Math.abs(M.myD + M.myVLat * tme - (od + vLat * tme)) < wPath + M.myRot) { F[3] = 1; return; }
      }
      // (not for the car being overtaken once this one is beside it: the path is laid beside it on purpose - but while
      // still behind it, where the two will meet: the path is beside it at ITS place, and the racing line may swing
      // back into it further on - a quicker car closing at 25 m/s on a car giving room at the edge ran into it; review r3)
      if (!(cl > 0.5) || (o === tgt && g < ALONG)) return;
      // (the two meet in tm s: beyond the horizon there is no meeting to look at - capping tm would test the road far
      // ahead against a car that will not be there with this one)
      var tm = g / cl; if (tm > 3.5) return;
      var onLine = Math.abs(od - LD[oi]) < 1.5;
      for (var q = 1; q <= 2; q++) {
        var tq = q === 1 ? 0.5 * tm : tm;
        var kq = cyc(oi + ((ov * tq / ds) | 0)), mq = wrapN(kq - idx); if (mq < 0) mq = 0;
        pathD(kq, mq); var pq = F[0];
        var dq = od + vLat * (tq < 1 ? tq : 1);
        if (dq > HI[kq] + EDGE) dq = HI[kq] + EDGE; else if (dq < LO[kq] - EDGE) dq = LO[kq] - EDGE;
        if (Math.abs(dq - pq) < wPath) { F[3] = 1; return; }
        if (onLine && Math.abs(LD[kq] + (od - LD[oi]) - pq) < 0.8 * wPath) { F[3] = 1; return; }
      }
    }

    // The pit route: towards the lane before pit.from, the lane centre (pit.laneD), into / out of the box, the taper
    // back to the racing line after pit.to. u = lane position (samples from pit.from) of the sample m ahead.
    function pitPathD(k, m) {
      var Pp = G.pit, u = pitU0 + m, d;
      racePathD(k); var race = F[0];
      if (u < 0) {                                        // before the lane: move over towards its mouth
        var w = 1 + u / PIT_BLEND; w = w < 0 ? 0 : (w > 1 ? 1 : w); w = w * w * (3 - 2 * w);   // (smooth, lerp written out:
        F[0] = race + (Pp.lane[0] - race) * w; return;                                       //  see racePathD)
      }
      if (u > Pp.L) {                                     // past the exit taper: back to the line
        var w2 = (u - Pp.L) / 40; w2 = w2 < 0 ? 0 : (w2 > 1 ? 1 : w2); w2 = w2 * w2 * (3 - 2 * w2);
        F[0] = Pp.lane[Pp.L] + (race - Pp.lane[Pp.L]) * w2; return;
      }
      d = Pp.lane[u];
      var b = plan.box;
      if (b && !plan.through) {
        if (!served) {
          var w3 = (u - (b.u - BOX_IN - 2)) / BOX_IN; w3 = w3 < 0 ? 0 : (w3 > 1 ? 1 : w3); w3 = w3 * w3 * (3 - 2 * w3);
          d = d + (b.d - d) * w3;
        } else if (plan.outFrom > OUT_NONE) {
          var w4 = (u - plan.outFrom) / BOX_OUT; w4 = w4 < 0 ? 0 : (w4 > 1 ? 1 : w4); w4 = w4 * w4 * (3 - 2 * w4);
          if (u >= plan.outFrom - 3) d = b.d + (d - b.d) * w4;
        }
      }
      F[0] = d;
    }

    M.c0 = 10; M.c2 = 0.003;                  // braking model of the scan: c0 + c2 v^2 (m/s^2), set every step

    // ---- strategy ----
    function wearMax() {
      var ty = car.tyres && car.tyres.state;
      if (!ty || !ty.wear) return 0;
      var w = ty.wear;
      return Math.max(w[0], w[1], w[2], w[3]);
    }
    var wearLap0 = WEAR_LAP0 * track.length;
    function compoundFor(lapsLeft, perLapNow, cur) {
      // the softest set that lasts the rest under WEAR_END (softer = faster); H if none does
      var base = perLapNow / (COMPOUND_WEAR[cur] || 1);
      if (!(base > 0)) base = wearLap0;
      for (var i = 0; i < ORDER.length; i++) if (base * COMPOUND_WEAR[ORDER[i]] * lapsLeft <= WEAR_END - 0.06) return ORDER[i];
      return 'H';
    }
    function startCompound(laps, wear) { return AI.startCompound(laps, wear, track.length); }

    // Grip lost at wear w (js/tyres.js: 0.8 % at 50 %, 4 % at 75 %, then the cliff) and the time it costs on a lap
    // (a lap loses about half the grip's share in time)
    function gripLoss(w) {
      var a = w > 0.2 ? 0.008 * Math.pow((w - 0.2) / 0.3, 2.66) : 0;
      var c = w > 0.75 ? 0.2 * Math.pow((w - 0.75) / 0.25, 3) : 0;
      return a + c;
    }
    // time lost over a stint of n laps starting at wear w0 (Infinity: a tyre would be run past ~97 %: a puncture)
    function stint(w0, per, n, lapT) {
      if (w0 + per * n > W_PLAN) return Infinity;
      var s = 0;
      for (var k = 0; k < n && k < 99; k++) s += 0.5 * lapT * gripLoss(w0 + per * (k + 0.5));
      return s;
    }
    // the best way to cover n laps on new tyres (base = wear per lap of a medium set): compound and time lost
    // (grip of the compound against the current set's included); a set that does not last is split by another stop
    var bestC = 'M';
    function freshStint(n, base, lapT, cur) {
      var best = Infinity;
      for (var i = 0; i < 3; i++) {
        var c = ORDER[i], p = base * COMPOUND_WEAR[c], gain = n * 0.5 * lapT * (COMPOUND_GRIP[c] - COMPOUND_GRIP[cur]);
        var v = stint(0, p, n, lapT);
        if (v === Infinity) { var h = Math.ceil(n / 2); v = G.pitLoss + stint(0, p, h, lapT) + stint(0, p, n - h, lapT); }
        v -= gain;
        if (v < best) { best = v; bestC = c; }
      }
      return best;
    }
    // Decide a stop (once per lap, in the window before pit.from): no stop against one stop after k more laps
    // (k = 0: this lap); stop now when k = 0 is the cheapest, or the set would not last another lap; a puncture always.
    function decidePit(ctx) {
      if (!G.pit || !ctx.pit) return null;
      pitLossOf(G, VA, perfFor);               // (the time a stop costs at the season's limit now)
      var ph = ctx.phase || 'free', ty = car.tyres && car.tyres.state;
      if (ctx.done || ph === 'results') return { park: true, compound: nextCompound || info.compound };
      if (ph === 'quali' || ph === 'grid') return null;
      var lapsLeft = ctx.laps > 0 ? ctx.laps - (ctx.lap | 0) : Infinity;   // incl. the lap being driven
      if (!ty || lapsLeft <= 1) return null;
      var w = wearMax(), cur = info.compound || 'M';
      var per = info.wearPerLap > 0 ? info.wearPerLap : wearLap0 * (COMPOUND_WEAR[cur] || 1) * (ctx.wear || 1);
      var base = per / (COMPOUND_WEAR[cur] || 1);
      var lapT = G.lapT[profileKey] || 90, rest = lapsLeft - 1;          // laps after this one
      if (ty.puncture >= 0) { freshStint(Math.min(rest, 60), base, lapT, cur); return { compound: bestC }; }
      if (rest === Infinity) return w + per > W_LAST ? { compound: 'M' } : null;     // free practice
      // the wear at the end of this lap (the decision window is near its end: only the rest of the lap to go - taking
      // a whole lap here made the plan one lap too pessimistic and cost needless stops) and at the next chance (a lap
      // on, here again)
      var wEnd = w + per * (cyc(N - idx) / N), wNow = w + per;
      // worn out by the next chance (or already past W_SAFE): in now, whatever the sums say (the search below cannot
      // even start from a set that is past W_PLAN: it used to plan no stop at all, and the car ran on to a puncture)
      if (wNow > W_PUNCT || w > W_SAFE || stint(wEnd, per, 0, lapT) === Infinity) {
        freshStint(Math.min(rest, 60), base, lapT, cur);
        note('stop: worn ' + w.toFixed(2) + ' +' + per.toFixed(3) + '/lap');
        return { compound: bestC };
      }
      var noStop = stint(wEnd, per, rest, lapT), best = noStop, bestK = -1, cNow = 'M';
      for (var k = 0; k <= rest - 1 && k <= 12; k++) {
        var first = stint(wEnd, per, k, lapT);
        if (first === Infinity) break;
        var v = first + G.pitLoss + freshStint(rest - k, base, lapT, cur);
        if (k === 0) cNow = bestC;
        if (v < best) { best = v; bestK = k; }
      }
      if (bestK === 0 || (wNow + per > W_PUNCT && bestK !== -1)) {
        note('stop: ' + best.toFixed(1) + ' s (no stop ' + noStop.toFixed(1) + ' s), wear ' + w.toFixed(2) + ' +' + per.toFixed(3) + '/lap, ' + rest + ' laps after, pit ' + G.pitLoss.toFixed(1) + ' s');
        return { compound: cNow };
      }
      return null;
    }

    function startPlan(p) {
      var Pp = G.pit, b = null;
      var bx = Pp.boxes[slot % Math.max(1, Pp.boxes.length)];
      if (bx && isNum(bx.index) && isNum(bx.d)) {
        var bu = cyc(bx.index - Pp.from);
        alongOf(bx.x, bx.z, bx.index); var lon = F[1];
        if (bu > Pp.entryU + 2 && bu < Pp.exitU - 2) b = { u: bu, d: bx.d, lon: lon, x: bx.x, z: bx.z, heading: bx.heading };
      }
      plan = { compound: p.compound || 'M', park: !!p.park, box: b, through: !b, outFrom: OUT_NONE };
      served = false; M.boxWait = 0;
      nextCompound = plan.compound;
      info.plan = plan.park ? 'park' : 'pit ' + plan.compound;
      var ty = car.tyres && car.tyres.state;
      note((plan.park ? 'park' : 'pit for ' + plan.compound) + (ty ? ' wear ' + wearMax().toFixed(2) + ' punct ' + ty.puncture : ''));
    }
    function endPlan() {
      // back on the track: the race offset starts where the car is
      M.offset = Math.min(Math.max(st.d - LD[idx], LO[idx] - LD[idx]), HI[idx] - LD[idx]);
      M.offTarget = 0;
      plan = null; info.plan = null; served = false;
    }

    // ---- the step ----
    // think() runs the phases below in order, each its own function. V8 optimises each one separately, and when a
    // rarely taken branch is reached for the first time (optimised code has no type feedback there) only that phase is
    // de-optimised, not the whole step: one big think() went back to the interpreter at every such branch - braking
    // scan and traffic loop included, boxing every number they computed - and allocated ~1 GB in a first 15-car race.
    // The phases hand doubles over in Z (fields that hold doubles: stored in place, never boxed), integers, objects and
    // flags in closure variables (a double in a closure variable would be boxed at every store).
    var Z = { dt: 0.5, myD: 0.5, myAlong: 0.5, gA: 0.5, vA: 0.5, dA: 0.5, gB: 0.5, vB: 0.5, dB: 0.5, gBlue: 0.5,
              gSx: 0.5, dSx: 0.5, vSx: 0.5, capF: 0.5, accF: 0.5, vSq: 0.5, capV: 0.5, steer: 0.5, target: 0.5,
              ff: 0.5, paceMul: 0.5, zoneMin: 0.5, gBrk: 0.5, head: 0.5, thr: 0.5, brk: 0.5 };
    var ph = 'free', sI = S[0], crossed = false, ps = null, inLaneNow = false, yellow = false, A = null, iA = 0,
        B = null, blue = null, Sx = null, iSx = 0, capFid = -1, squeezed = false, mode = 'race', capWhy = '', creepCap = false,
        finished = false, blockedNow = false, tightHere = false, off = false, gr = null, scanAt = -1, hold = false, limiter = false,
        boost = false;

    function think(dt, others, ctx) {
      ctx = ctx || EMPTY_CTX; others = others || EMPTY;
      if (!(dt > 0)) dt = 1 / 120;
      if (dt > 0.1) dt = 0.1;
      ensureProfile();
      M.t += dt; steps++; stats.steps++;
      Z.dt = dt;
      input.throttle = 0; input.brake = 0; input.steerAxis = 0; input.boost = false; input.reset = false;
      if (stepPlace(ctx)) return input;        // locked on the grid, held in the box, reacting at lights out
      stepBook(ctx);                           // noise and wander, wear, offs, the pit route
      stepTraffic(others, ctx);                // the other cars: room alongside, caps, attackers, blue flags
      stepRacecraft(others, ctx);              // the lateral target: passing, driving round, yielding, defending
      stepSteer();                             // pure pursuit
      stepSpeed(ctx);                          // the target speed (the braking scan: scanAhead), caps, the box
      stepPedals();                            // throttle / brake, battery, limiter
      return stepRecover();                    // wrong way, stuck, reverse, R; the pad
    }

    // where the car is; -> 1 when the pad stays at rest this step (locked, in service, the reaction at lights out)
    function stepPlace(ctx) {
      ph = ctx.phase || 'free';
      // ---- where the car is (own index; a jump of the car = it was placed: start over from there)
      var mx = st.x - M.lastX, mz = st.z - M.lastZ;
      if (mx * mx + mz * mz > 400 || (resetPending && mx * mx + mz * mz > 4)) relocate();
      M.lastX = st.x; M.lastZ = st.z;
      // own index: a walk from the previous one to the nearest sample (no allocation; a car moves under a sample per
      // step), track.locate only when that is lost (more than 30 m away: the car was put somewhere else) - with the
      // car's height: at an over / under crossing (Suzuka) the road the car is on, not the one above / below it
      walkTo(); var e2 = F[7];
      if (e2 > 900) {
        var y = isNum(st.y) ? st.y : undefined;
        var loc = track.locate(st.x, st.z, (st.sampleIndex | 0) >= 0 ? st.sampleIndex | 0 : -1, y);
        var sl = S[loc.index], lx = st.x - sl.x, lz = st.z - sl.z;
        if (lx * lx + lz * lz > 900) loc = track.locate(st.x, st.z, -1, y);
        idx = loc.index;
      }
      sI = S[idx];
      var myD = (st.x - sI.x) * sI.nx + (st.z - sI.z) * sI.nz;
      Z.myD = myD;
      info.idx = idx;
      crossed = prevIdx > N * 0.75 && idx < N * 0.25;
      prevIdx = idx;

      // ---- locked on the grid / held in the box: pad at rest
      if (ctx.locked) {
        wasLocked = true; info.mode = 'grid'; input.limiter = false; M.thrOut = M.brkOut = 0;
        progIdx = idx; M.progT = M.t; M.hardT = M.t;
        return 1;
      }
      ps = ctx.pit || null;
      if (ps && ps.service) {
        info.mode = 'pit';
        M.thrOut = M.brkOut = 0; progIdx = idx; M.progT = M.t; M.hardT = M.t;
        input.limiter = true;
        return 1;
      }
      if (ps && lastStops >= 0 && ps.stops > lastStops && plan) served = true;
      if (ps) lastStops = ps.stops;
      if (wasLocked) {                         // lights out: the reaction, then the launch holding the grid lane
        wasLocked = false; M.goT = M.t;
        rndF(); M.reactT = K.react + F[6] * K.reactSpread;
        M.startLane = myD; startLaneOn = true; startFrom = idx; startDone = false; M.offset = 0; M.offTarget = 0;
      }
      if (M.goT >= 0 && M.t - M.goT < M.reactT) { info.mode = 'start'; progIdx = idx; M.progT = M.t; M.hardT = M.t; return 1; }
      if (!startDone && (cyc(idx - startFrom) * ds > 300 || M.t - M.goT > 12)) { startDone = true; M.offset = Math.min(Math.max(myD - LD[idx], -12), 12); }
      return 0;
    }

    function stepBook(ctx) {
      var dt = Z.dt, myD = Z.myD;
      // ---- the slow processes: pace noise, wander, wear bookkeeping
      if (steps % SLOW_EVERY === 0) {
        var h = SLOW_EVERY * dt;
        gauss(); M.noise += -M.noise * h / NOISE_TAU + K.noise * Math.sqrt(2 * h / NOISE_TAU) * F[6];
        M.noise = Math.min(Math.max(M.noise, -2.2 * K.noise), 2.2 * K.noise);
        gauss(); M.wander += -M.wander * h / WANDER_TAU + K.wander * Math.sqrt(2 * h / WANDER_TAU) * F[6];
        M.wander = Math.min(Math.max(M.wander, -2 * K.wander), 2 * K.wander);
      }
      if (crossed) {
        lapCount++; info.lapsSeen = lapCount;
        var w = wearMax();
        if (M.wearRef >= 0 && lapCount - wearRefLap >= 1 && w >= M.wearRef) info.wearPerLap = (w - M.wearRef) / (lapCount - wearRefLap);
        if (M.wearRef < 0 || lapCount - wearRefLap >= 1) { M.wearRef = w; wearRefLap = lapCount; }
      }
      if (car.tyres && car.tyres.state) info.compound = car.tyres.state.compound || info.compound;

      // ---- events from the car: offs, wall hits
      if (st.onGrass && !onGrassPrev) { stats.offs++; note('off d ' + myD.toFixed(1) + (plan ? ' (pit ' + pitU0 + ')' : '')); }
      onGrassPrev = st.onGrass;
      var hitNow = st.hit > 0.02;
      if (hitNow && !hitPrev) stats.wallHits++;
      hitPrev = hitNow;

      // ---- the pit route
      var Pp = G.pit;
      if (Pp) {
        pitLimitOf(G);                         // (the season's limit: it may change under the cars)
        var cu = cyc(idx - Pp.from);
        pitU0 = cu <= Pp.L + (N - Pp.L) / 2 ? cu : cu - N;
        var aMe = myD * Pp.side;
        inPitArea = pitU0 >= 0 && pitU0 <= Pp.L && aMe >= Pp.pavLo[pitU0] && aMe <= Pp.pavHi[pitU0];
        if (!plan && pitU0 < -PIT_DECIDE_NEAR / ds && pitU0 > -PIT_DECIDE_FAR / ds && steps % 6 === 0) {
          if (pending) { startPlan(pending); pending = null; }
          // (the strategy once a lap, at the start of the window - every few steps it cost ~2 B per think() call)
          else if (ctx.pit && decidedLap !== lapCount) { decidedLap = lapCount; var dec = decidePit(ctx); if (dec) startPlan(dec); }
        }
        // back on the track after the exit taper (or the lane was missed: forget the stop; a car going to park tries
        // again next lap)
        if (plan && !plan.park && pitU0 > Pp.L + 45) endPlan();
      } else { pitU0 = -1e9; inPitArea = false; }
      inLaneNow = !!(Pp && plan && pitU0 >= 0 && pitU0 <= Pp.L);
    }

    // ---- traffic: alongside constraints, the cars ahead on the path, attackers, blue flags
    function stepTraffic(others, ctx) {
      var v = st.speed, av = v < 0 ? -v : v, myD = Z.myD, i, o;
      cOn = false; M.cLo = -1e9; M.cHi = 1e9;
      var gHi = 0, vHi = 0, gLo = 0, vLo = 0, idHi = -1, idLo = -1, stHi = false, stLo = false;
      // yellow flag: a car standing (or coming the wrong way) on the road ahead: single file, no racing past it
      var yellowWas = yellow;                  // (the last step's: this one's is known after the loop)
      yellow = false;
      var myPace = G.lapT[profileKey] || 0;
      // (others are ghosts on the pit asphalt only: between pit.from and the lane the cars heading for it are solid and
      // must see each other, or two stopping on the same lap merge into one another)
      var ignoreAll = ph === 'quali' || inPitArea;
      A = null; iA = 0; B = null; blue = null;
      var gA = 1e9, vA = 0, dA = 0, gB = -1e9, vB = 0, dB = 0, gBlue = -1e9;
      // the nearest stopped / crawling / oncoming car on the path (it is driven round first, whatever else goes on)
      Sx = null; iSx = 0;
      var gSx = 1e9, dSx = 0, vSx = 0, nSlow = 0;
      // the nearest car standing near the path (reachability check after the loop)
      var Sn = null, gSn = 1e9, dSn = 0, iSn = 0, wSn = 0;
      // every car on the path gives a speed cap (the nearest one may hide a stopped one) and the deceleration that
      // keeps its gap (fed forward to the pedals: the speed loop alone brakes too late when the gap closes fast)
      var capF = 1e9, accF = 1e9;
      capFid = -1; creepCap = false;
      var myAlong = (st.x - sI.x) * sI.tx + (st.z - sI.z) * sI.tz;
      // (own race distance, NaN = unknown: a number in every case - a variable that is a number or null is kept boxed, a
      // new heap number at every call)
      var myProg = ctx.prog; if (typeof myProg !== 'number') myProg = NaN;
      var vMine = v * (Math.sin(st.heading) * G.tx[idx] + Math.cos(st.heading) * G.tz[idx]);
      M.myD = myD; M.vMine = vMine; M.myVLat = v * (Math.sin(st.heading) * sI.nx + Math.cos(st.heading) * sI.nz);
      var myR = Math.sin(st.heading - G.hdg[idx]); M.myRot = 0.5 * CAR_LEN * (myR < 0 ? -myR : myR);   // this car turned against the road
      var Pp = G.pit;
      // a corner tighter than full lock within the last 40 m or the next 30 m (the Monaco hairpin, its exit included):
      // every car turns its tightest there and nobody can lay a path beside another - no attack is started or carried
      // on through it (it is followed), no defending move - and the cars of a queue are at different points of the
      // turn, closer than the gap along the centreline says: TIGHT_GAP more of it
      tightHere = false;
      for (var kt = -TIGHT_BACK; kt <= TIGHT_ON && !tightHere; kt++) if (TT[cyc(idx + kt)]) tightHere = true;
      if (!ignoreAll) {
        for (i = 0; i < others.length; i++) {
          o = others[i];
          if (!o || o.ghost || (selfId !== null && o.id === selfId) || o === st) continue;
          var spO = o.speed || 0; slowFor(o, spO < 3 && spO > -3); var stopT = F[4];   // how long it has stood
          var ox = o.x - st.x, oz = o.z - st.z, o2 = ox * ox + oz * oz;
          if (o2 > 90000) continue;                                 // further than 300 m (200 m: see below)
          var oi = o.sampleIndex;
          if (!(oi >= 0 && oi < N)) continue;
          oi = oi | 0;
          var od = typeof o.d === 'number' && o.d === o.d ? o.d : 0;
          if (Pp) {                                                 // on the pit asphalt: a ghost
            var uo = oi - Pp.from; if (uo < 0) uo += N;
            if (uo <= Pp.L) { var ao = od * Pp.side; if (ao >= Pp.pavLo[uo] && ao <= Pp.pavHi[uo]) continue; }
          }
          var sO = S[oi], g = wrapN(oi - idx) * ds + (o.x - sO.x) * sO.tx + (o.z - sO.z) * sO.tz - myAlong;
          var ov = (o.speed || 0) * (Math.sin(o.heading) * G.tx[oi] + Math.cos(o.heading) * G.tz[oi]);
          // (a car coming the wrong way is looked for further ahead: the two close at both speeds)
          if (g < -120 || (ov < -5 ? g > 300 : (g > 160 || o2 > 40000))) continue;
          if (g > 0 && (stopT > 1.5 || ov < -1)) yellow = true;
          // alongside (overlapping, or about to: a car closing from behind counts a little earlier): keep its room.
          // The constraint is on this car's own path (never closer than SEP across), so a car well to the side costs
          // nothing until this one would turn in towards it.
          var adl = od - myD; if (adl < 0) adl = -adl;
          var closing = ov - vMine;
          if (g < ALONG && g > -(ALONG + (closing > 0 ? closing * 0.6 : 0)) && adl > 0.9 && adl < 9) {
            // the clearance: both cars' extents across the road (a box turned against the road reaches further with its
            // corners) and a margin, + the chord pure pursuit cuts to the inside of a corner (L^2 / 8R at the shortened
            // look-ahead)
            sepOf(o, oi);
            var Lc = 0.75 * Math.min(Math.max(5 + 0.3 * av, LOOK_MIN), LOOK_MAX), kc = CV[idx] < 0 ? -CV[idx] : CV[idx];
            var sep = M.sepT + M.myRot + 0.3 + Lc * Lc * kc / 8;
            var stillO = spO < 3 && spO > -3;
            cOn = true;
            if (od > myD) { if (od - sep < M.cHi) { M.cHi = od - sep; gHi = g; vHi = ov; idHi = o.id; stHi = stillO; } }
            else if (od + sep > M.cLo) { M.cLo = od + sep; gLo = g; vLo = ov; idLo = o.id; stLo = stillO; }
          }
          if (g > 0) {
            var mOi = wrapN(oi - idx); if (mOi < 0) mOi = 0;
            // the boxes would touch: both half widths across the road (its box turned against the road at its place
            // reaches further; the angle between the two cars themselves means nothing when they are at different
            // places of a corner) and a margin
            sepOf(o, oi); var wPath = M.sepT - (SEP - CAR_WID) + 0.35;
            var vLat = (o.speed || 0) * (Math.sin(o.heading) * S[oi].nx + Math.cos(o.heading) * S[oi].nz);
            var oSlow = ov < 3 || (ov < 12 && ov < 0.4 * VA[oi]);     // stopped, crawling, or coming the wrong way
            // an obstacle to drive round: coming the wrong way, or stopped / crawling for a while (not a car that is
            // just pulling away from the grid, or braking hard in front: that one is followed)
            var oObs = ov < -1 || stopT > 1.5;
            if (oSlow && nSlow < 32) slowG[nSlow++] = g;
            F[8] = od; F[9] = g; F[10] = ov; F[11] = vLat; F[12] = wPath; inPathOf(oi, mOi, o);
            // (a car found on the path stays on it for IN_PATH_HOLD s unless it is clearly off it now: the predictions
            // sit on their thresholds for a while, and a cap switched on and off at 120 Hz flips the pedals)
            if (oSlot >= 0) {
              var hk = oSlot;
              if (F[3] > 0) ipUntil[hk] = M.t + IN_PATH_HOLD;
              else if (M.t < ipUntil[hk]) { pathD(oi, mOi); if (Math.abs(od - F[0]) < wPath + 1.5) F[3] = 1; }
            }
            if (F[3] > 0) {
              // its cap: never closer than the time gap, a speed it can always brake to (its measured deceleration)
              var wantO = CAR_LEN + 1.5 + (o === tgt || M.followT > 1 ? 0.6 : 1) * K.gapT * av;
              if (oSlow) wantO = Math.max(wantO, CAR_LEN + 8);          // a stopped / crawling car: room to steer round it
              if (tightHere) wantO += TIGHT_GAP;
              F[5] = ov; accOf(o); var aO = F[5], vOp = ov + (aO < 0 ? aO * 0.35 : 0), capO;
              // a car known to be slower (its pace: a computer car) is pressed: closed up on to a shorter gap, and its
              // braking - no harder than this car's own braking plan: its plan, not a brake test or a crash - is not
              // anticipated. Held at the full time gap with the other car's braking anticipated, a quicker car had to
              // brake with it from 100 m back in every braking zone and never got close enough to try a pass: whole
              // races in a train behind slower cars (js/car.js has no slipstream; review r3). Not in a corner (radius
              // under PRESS_R at either car): cars at different points of a turn are closer than the gap along the
              // track says, and the one in front turns in across the nose of one pressing close behind. Nor on the way
              // into, through and out of the pit lane (a stop planned: plan): cars leave the lane in a queue at the limit
              // and the one pressed is still pulling away from it (2026-10-02: bots.js part pits, the whole field out of
              // Monza's lane at once: pressing doubled the bumps at the merge, once on the pit asphalt)
              if (myPace > 0 && !plan && o.pace > myPace * (1 + PRESS_PACE) && !oSlow && !tightHere && !yellowWas &&
                  G.absK[idx] < 1 / PRESS_R && G.absK[oi] < 1 / PRESS_R) {
                wantO = CAR_LEN + 1.5 + PRESS_GAP * K.gapT * av;
                if (aO > -(M.c0 + M.c2 * ov * ov)) vOp = ov;
              }
              if (vOp < 0) vOp = 0;
              if (g > wantO) capO = vOp + Math.sqrt(2 * FOLLOW_A * (g - wantO));
              else capO = Math.max(0, vOp - 1.2 * (wantO - g));
              // at (or over) that cap: the deceleration that holds it - the cap curve's own FOLLOW_A relative to the
              // other car's braking, more when the closing cannot be stopped that way before the wanted gap (a car well
              // under the cap is left to the speed loop)
              var wO = vMine - vOp, accO = 1e9, crept = false;
              if (wO > 0 && vMine > capO - 1.5) {
                var relA = wO * wO / (2 * Math.max(g - wantO, 0.5));
                accO = (aO < 0 ? aO : 0) - (relA > FOLLOW_A ? relA : FOLLOW_A);
              }
              // going round a stopped / crawling car: once the planned path clears it, creep on (it cannot be left
              // from a standstill straight behind it)
              if (o === tgt && oSlow) {
                pathD(oi, mOi);
                if (Math.abs(F[0] - od) >= CAR_WID + 0.6) {
                  var creep = (g - CAR_LEN - 1) * 0.8;
                  sepOf(o, oi);
                  if (creep < 2.5 && boxClear(o, od > M.myD ? 1 : -1)) creep = 2.5;   // rolling on along its heading clears it
                  creep = creep > 5 ? 5 : creep;
                  // the way on along its heading clear of it for 9 m with half a metre to spare (beside it, or turned
                  // out past it): by at a running pace, not at a crawl (2026-10-02: a crawl past a car stalled on the
                  // grid held a whole column up for 10..20 s - devtests/gp-e2e/bots.js part pits; a car parked out of
                  // Monza's Roggia cost 4..5 s per car of the queue behind it). Only where the road bends less than the
                  // straight probe misses by 0.35 m over its 9 m (radius > ~115 m): in a corner the car turns away
                  if (creep < 8 && CV[idx] < 0.0086 && CV[idx] > -0.0086 && CV[oi] < 0.0086 && CV[oi] > -0.0086 &&
                      boxClear(o, od > M.myD ? 1 : -1, 6, 0.5)) creep = 8;
                  if (creep > capO) { capO = creep; accO = 1e9; crept = true; }
                }
              }
              if (capO < capF) { capF = capO; capFid = o.id; creepCap = crept; }
              if (accO < accF) accF = accO;
              if (g < gA) { A = o; gA = g; vA = ov; dA = od; iA = oi; }
              if (oObs && g < gSx) { Sx = o; gSx = g; dSx = od; iSx = oi; vSx = ov; }
            }
            if (stopT > 0 && g < gSn) {
              pathD(oi, mOi);
              if (Math.abs(od - F[0]) < wPath + 4) { Sn = o; gSn = g; dSn = od; iSn = oi; wSn = wPath; }
            }
            if (F[3] === 0 && oObs && g < gSx && g < 50 + av * 2) {
              // standing just beside the path: driven round as well (the path may come back to it - the end of a
              // yield, the line swinging over)
              pathD(oi, mOi);
              if (Math.abs(od - F[0]) < wPath + 2.5) { Sx = o; gSx = g; dSx = od; iSx = oi; vSx = ov; }
            }
          } else {
            if (g > gB && g < -2) { B = o; gB = g; vB = ov; dB = od; }
            if (myProg === myProg && typeof o.prog === 'number' && o.prog > myProg + 0.5 && g > -90 && g > gBlue) { blue = o; gBlue = g; }
          }
        }
      }
      // a car standing near the path: can this car get to where its path passes it (it moves across at LAT_REACH m/s
      // at most, and not through a car alongside now)? If not, it brakes for it as for a car on its path
      if (Sn && gSn > CAR_LEN + 8) {
        var tR = gSn / (vMine > 1 ? vMine : 1), reach = LAT_REACH * tR;
        pathD(iSn, wrapN(iSn - idx));
        var dCan = F[0] - myD; dCan = myD + (dCan > reach ? reach : (dCan < -reach ? -reach : dCan));
        if (cOn) { if (dCan > M.cHi) dCan = M.cHi; if (dCan < M.cLo) dCan = M.cLo; }
        if (Math.abs(dSn - dCan) < wSn) {
          var wantS = CAR_LEN + 8, capS = Math.sqrt(2 * FOLLOW_A * (gSn - wantS));
          if (capS < capF) { capF = capS; capFid = Sn.id; creepCap = false; }
          if (vMine > capS - 1.5) { var relS = vMine * vMine / (2 * Math.max(gSn - wantS, 0.5)); relS = relS > FOLLOW_A ? relS : FOLLOW_A; if (-relS < accF) accF = -relS; }
        }
      }
      // a stopped car with another stopped car just ahead of it is queuing, not crashed: followed, not driven round
      if (Sx) for (var q = 0; q < nSlow; q++) if (slowG[q] > gSx + 1 && slowG[q] < gSx + CAR_LEN + 12) { Sx = null; break; }
      // no room between a car alongside and the edge (or between two cars): whoever is behind gives way, the
      // car ahead keeps its line (at the edge of what is left)
      squeezed = false;
      var vSq = 0;
      if (cOn) {
        // (level within half a metre: the car with the lower id keeps its line, so that two never both stop)
        // (a standing car beside this one squeezes nothing: it is driven past, the follow / creep rules see to that)
        var behHi = !stHi && (gHi > 0.5 || (gHi > -0.5 && !(selfId !== null && selfId < idHi)));
        var behLo = !stLo && (gLo > 0.5 || (gLo > -0.5 && !(selfId !== null && selfId < idLo)));
        if (M.cHi < LO[idx] + 0.2 && behHi) { squeezed = true; vSq = vHi; }
        if (M.cLo > HI[idx] - 0.2 && behLo) { squeezed = true; vSq = vLo; }
        if (M.cLo > M.cHi) {
          if (behHi || behLo) { squeezed = true; vSq = gHi > gLo ? vHi : vLo; }
          var mid = 0.5 * (M.cLo + M.cHi); M.cLo = M.cHi = mid;
        }
      }
      Z.myAlong = myAlong; Z.gA = gA; Z.vA = vA; Z.dA = dA; Z.gB = gB; Z.vB = vB; Z.dB = dB; Z.gBlue = gBlue;
      Z.gSx = gSx; Z.dSx = dSx; Z.vSx = vSx; Z.capF = capF; Z.accF = accF; Z.vSq = vSq;
    }

    // ---- racecraft: the lateral target
    function stepRacecraft(others, ctx) {
      var dt = Z.dt, v = st.speed, av = v < 0 ? -v : v, myD = Z.myD, myAlong = Z.myAlong, vMine = M.vMine, i;
      var gA = Z.gA, vA = Z.vA, dA = Z.dA, gB = Z.gB, vB = Z.vB, dB = Z.dB, gBlue = Z.gBlue, gSx = Z.gSx, dSx = Z.dSx, vSx = Z.vSx;
      var Pp = G.pit, capV = 1e9;
      mode = 'race'; capWhy = '';
      // how fast the car behind closes the gap, over ~1 s (the pressure of a car of unknown pace, below; a jump of the
      // gap - an R, a step not driven - is no closing)
      if (B && B === closeB && M.t - M.closeT < 0.1) {
        var cr = (gB - M.gBPrev) / dt; cr = cr > 30 ? 30 : (cr < -30 ? -30 : cr);
        M.closeR += (cr - M.closeR) * (dt < 1 ? dt : 1);
      } else M.closeR = 0;
      closeB = B; M.gBPrev = gB; M.closeT = M.t;
      finished = !!ctx.done || ph === 'results';
      if (plan && Pp) mode = 'pit';
      if (M.tgtCool > 0) M.tgtCool -= dt;
      var myPace = G.lapT[profileKey] || 0;
      var absOn = false, absTgt = 0;                 // this step's lateral target is an absolute place (anchored path)
      // a stopped / crawling / oncoming car on the path is driven round first (it may be hidden behind the car being
      // followed or attacked); at the start too (a car stalled on the grid)
      blockedNow = false;
      // (taken on below 50 m + 1.5 s, dropped beyond 60 m + 1.5 s: a car coming the wrong way was taken on from 300 m
      // and a stopped one from 50 m + 2 s, but dropped again in the same step - every step - beyond 50 m + 1.5 s)
      // (a car coming the wrong way: from further off, the closing at both speeds; its side chosen where the two will
      // meet - on the racing line it follows the line there; review r3)
      if (Sx && tgt !== Sx && !inLaneNow && ph !== 'quali' && gSx < 50 + (av - (vSx < 0 ? vSx : 0)) * 1.5 && (!A || gSx <= gA + 1 || vSx < -1)) {
        var iS = iSx, dS = dSx;
        if (vSx < -1) {
          var tmS = gSx / (vMine - vSx > 1 ? vMine - vSx : 1); if (tmS > 4) tmS = 4;
          iS = cyc(iSx + ((vSx * tmS / ds) | 0));
          if (dSx - LD[iSx] < 1.5 && dSx - LD[iSx] > -1.5) dS = LD[iS] + (dSx - LD[iSx]);
        }
        var sideS = (F[13] = dS, F[16] = gSx, chooseSide(iS, Sx));
        if (!sideS && gSx < 25) blockedNow = true;            // no room on either side of it
        if (sideS) {
          tgt = Sx; tgtSide = sideS; tgtSlow = true; M.tgtT = 0; M.tgtBlock = 0; M.tgtBest = gSx; M.tgtBestT = 0; stats.passTries++;
          if (!startDone) { startDone = true; M.offset = Math.min(Math.max(myD - LD[idx], -12), 12); }
        }
      }
      if (A) {
        M.followT += dt;
        var mine = VA[iA] * (1 + M.noise);
        // worth a pass: a car known to be slower (its pace, from the integrator: computer cars), a car that is much
        // slower right now (stopped, crawling), or - a car of unknown pace (a human) - being held up for a while
        var faster;
        var knownA = typeof A.pace === 'number' && A.pace > 0 && myPace > 0;
        if (vA < 0.75 * VA[iA] && vA < 20) faster = true;
        else if (knownA) faster = A.pace > myPace * (1 + PRESS_PACE);
        else faster = mine > vA + K.attack && M.followT > K.patience;
        var slowA = vA < 3 || (vA < 12 && vA < 0.4 * VA[iA]);    // stopped / crawling: go round it early
        if (!plan && !finished && ph !== 'quali' && tgt !== A && !(tgt && tgtSlow) && (!slowA || A === Sx) && !(yellow && !slowA) && (M.tgtCool <= 0 || vA < 3) && faster && M.concedeT <= 0 && (slowA || !tightHere) &&
            gA < (slowA ? 40 + av * 1.5 : 18 + av * 0.25)) {
          var side = (F[13] = dA, F[16] = gA, chooseSide(iA, A));
          if (side) { tgt = A; tgtSide = side; tgtSlow = slowA; M.tgtT = 0; M.tgtBlock = 0; M.tgtBest = gA; M.tgtBestT = 0; stats.passTries++; }
        }
      } else M.followT = 0;
      if (tgt) {
        var gT = 1e9, dT = 0, iT = idx, found = false, vT = 0;
        for (i = 0; i < others.length; i++) if (others[i] === tgt) found = true;
        if (found && !tgt.ghost && tgt.sampleIndex >= 0) {
          iT = tgt.sampleIndex | 0; dT = typeof tgt.d === 'number' && tgt.d === tgt.d ? tgt.d : 0;
          var sT = S[iT]; gT = wrapN(iT - idx) * ds + (tgt.x - sT.x) * sT.tx + (tgt.z - sT.z) * sT.tz - myAlong;
          vT = (tgt.speed || 0) * (Math.sin(tgt.heading) * G.tx[iT] + Math.cos(tgt.heading) * G.tz[iT]);
        }
        // stopped, crawling or coming the wrong way (along-track speed: a car facing the wrong way has speed > 0)
        var slowT = found && (vT < 3 || (vT < 12 && vT < 0.4 * VA[iT]));
        tgtSlow = slowT;
        sepOf(tgt, iT); var sepT = M.sepT;          // its width across the road counts (a car standing across)
        M.tgtT += dt; M.gT = gT;
        // blocked: the other car is on our side of the road (here; for a stopped one, where it stands)
        var rI = slowT ? iT : idx;
        var roomHere = tgtSide > 0 ? HI[rI] - (dT + sepT) : (dT - sepT) - LO[rI];
        if (roomHere < -0.6 && gT > -2) M.tgtBlock += dt; else M.tgtBlock = 0;
        // progress: the gap must keep shrinking (3 m in 4 s), else back to the line for a while
        if (gT < M.tgtBest - 3) { M.tgtBest = gT; M.tgtBestT = 0; } else M.tgtBestT += dt;
        // (a stopped car or one coming the wrong way is taken on below 50 m + 1.5 s, the attack on a moving one below
        // 18 m + 0.25 s: each is dropped only further away than that)
        var farT = slowT ? 60 + (av - (vT < 0 ? vT : 0)) * 1.5 : 60;
        if (!found || gT > farT || M.tgtBlock > 1.8 || (!slowT && (yellow || M.tgtT > 12 || M.tgtBestT > 4 || plan || ph === 'quali' || finished || M.concedeT > 0 || (tightHere && gT > 1)))) {
          tgt = null; tgtSlow = false; M.tgtCool = found && gT < farT ? 4 : 1;
        }
        else if (gT < -(CAR_LEN + 2.5)) { tgt = null; tgtSlow = false; stats.passes++; M.tgtCool = 1; }
        else if (slowT) {
          // round a stopped / crawling / oncoming car: the path swerves to a place beside it (pathD) and back
          mode = 'overtake';
          var aT = dT + tgtSide * (sepT + 1), kO = iT;
          if (vT < -1) {
            // coming the wrong way: beside the place where the two meet, with more room (it moves across too)
            var clT = vMine - vT, tmT = gT / (clT > 1 ? clT : 1); if (tmT > 4) tmT = 4;
            var vLT = (tgt.speed || 0) * (Math.sin(tgt.heading) * S[iT].nx + Math.cos(tgt.heading) * S[iT].nz);
            kO = cyc(iT + ((vT * tmT / ds) | 0));
            // (where it will be: a car on the racing line follows the line - which may swing across the road on the way
            // - as inPathOf counts on; any other one carries on sideways for a second; review r3)
            var dMeet = dT - LD[iT] < 1.5 && dT - LD[iT] > -1.5 ? LD[kO] + (dT - LD[iT]) : dT + vLT * (tmT < 1 ? tmT : 1);
            aT = dMeet + tgtSide * (sepT + 1.8);
          }
          if (!obsOn || obsTgt !== tgt) {                  // a new swerve starts where the path is now
            obsTgt = tgt; obsKFrom = idx; pathD(idx, 0); M.obsFrom = F[0];
          }
          obsOn = true; obsK = kO; M.obsD = aT < LO[kO] ? LO[kO] : (aT > HI[kO] ? HI[kO] : aT);
          M.obsLb = 25 + av + (vT < -1 ? -vT : 0); M.offTarget = 0;
        }
        else {
          mode = 'overtake';
          // beside it on the straight; the inside edge into the corner it goes for (the side follows the corner
          // that comes, when there is room on its inside: the other car is then on the outside for its turn-in)
          var cin = nextCornerSide(iT, 140), absT;
          // (the room at ITS place, with a margin over the test below that takes the side back: the road may be wider
          // here, and a car giving room keeps to the edge it chose - the inside measured here sent the quicker car into
          // it at 70 km/h more; review r3)
          if (cin && cin !== tgtSide && gT > 15) {
            var roomIn = cin > 0 ? HI[iT] - (dT + SEP) : (dT - SEP) - LO[iT];
            if (roomIn > 1) { tgtSide = cin; M.tgtBlock = 0; }
          }
          // the other car moved over (it gives room, or covers this side): take the side that is open - the inside of
          // the corner too, when it is the one that is shut
          if (gT > 12) {
            var rL = HI[iT] - (dT + SEP), rR = (dT - SEP) - LO[iT], rCur = tgtSide > 0 ? rL : rR, rOther = tgtSide > 0 ? rR : rL;
            if (rCur < 0.5 && rOther > 1.5) { tgtSide = -tgtSide; M.tgtBlock = 0; }
          }
          // (beside it with more room the faster it is gone by: a car lifting to let another by is passed 25 m/s faster)
          var clT2 = vMine - vT;
          if (cin === tgtSide && gT < 70) absT = tgtSide > 0 ? HI[idx] - 0.2 : LO[idx] + 0.2;
          else absT = dT + tgtSide * (SEP + 0.3 + (clT2 > 0 ? (clT2 < 25 ? 0.06 * clT2 : 1.5) : 0));
          // (beside it: the offset that puts the path there at ITS sample - the racing line may be elsewhere here)
          var lT = cin === tgtSide && gT < 70 ? LD[idx] : LD[iT];
          M.offTarget = Math.min(Math.max(absT, LO[iT]), HI[iT]) - lT;
        }
      }
      // the swerve round a stopped car ends once this car is through it (or never got to it)
      if (obsOn && !(tgt && tgtSlow)) {
        var uO = wrapN(idx - obsK) * ds;
        if (uO < -CAR_LEN || uO > OBS_AFTER + OBS_OUT) obsOn = false;
      }
      if (!tgt) {
        M.offTarget = 0;
        // whom this car gets out of the way of (blue flag, after the flag, a quicker car let by): a side chosen once,
        // held at the edge (anchored: not swinging across with the racing line in front of the car coming by)
        var yieldFrom = null, yieldD = 0;
        // blue flag: a car a lap (or more) up the road is right behind: off the line, a little slower
        if (blue && !plan) {
          mode = 'yield';
          if (yieldId !== blue) { yieldId = blue; stats.yields++; }
          yieldFrom = blue; yieldD = typeof blue.d === 'number' && blue.d === blue.d ? blue.d : 0;
          if (gBlue > -45) { capV = Math.min(capV, VA[cyc(idx + 4)] * 0.93); capWhy = 'blue'; }
        } else yieldId = null;
        // finished: out of everybody's way
        if (finished && !plan && !blue && B && gB > -80) { mode = 'yield'; yieldFrom = B; yieldD = dB; }
        // defend: an attacker close behind, a corner coming: cover its inside once (no weaving)
        if (!blue && !finished && !plan && !yellow && !tightHere && B && ph === 'race' && gB > -22 && vB > vMine + 0.5 &&
            !(typeof B.pace === 'number' && B.pace > 0 && myPace > 0 && B.pace < myPace * 0.985)) {
          if (defId !== B) {
            defId = B; M.defT = 0;
            rndF(); if (F[6] < K.defend) { M.defT = 1; stats.defends++; }
          }
        } else if (!B || gB < -45) { defId = null; M.defT = 0; }
        if (M.defT > 0 && defId === B && !blue && !finished && !tightHere) {
          var inside = nextCornerSide(idx, 110);
          if (inside) {
            mode = 'defend';
            var cover = inside > 0 ? Math.min(HI[idx], LD[idx] + 2.2) : Math.max(LO[idx], LD[idx] - 2.2);
            M.offTarget = cover - LD[idx];
          }
        }
        // pressure from a quicker car close behind: its pace known and at least 1 % better (a computer car), or - a car
        // of unknown pace (a human) - seen to be quicker: closing the gap by more than PRESS_DV m/s (over ~1 s) while
        // this car is flat out (on a straight: what the car and driver can do, not a braking point) within the last
        // PRESS_SEEN s, counted at half rate. A human merely sitting behind at the same pace counted too, and was let
        // by (review r3). Close = within PRESS_NEAR s (28 m at least), let go beyond PRESS_FAR s (45 m at least): the
        // gaps in time - a car following at a steady time gap is twice as many metres back at the end of a straight as
        // in the corner, and the pressure was lost on every straight (review r3)
        var vRef = av > 10 ? av : 10, nearB = B && gB > -Math.max(28, PRESS_NEAR * vRef);
        if (B && M.closeR > PRESS_DV && M.thrOut > 0.95 && gB > -Math.max(45, PRESS_FAR * vRef)) M.fastT = M.t;
        if (M.concedeT > 0) { /* keep the car being let by */ }
        else if (nearB && !finished && ph === 'race' && !plan) {
          if (pressId !== B) { pressId = B; M.pressT = 0; }
          var known = typeof B.pace === 'number' && B.pace > 0 && myPace > 0;
          if (!known) { if (M.t - M.fastT < PRESS_SEEN) M.pressT += 0.5 * dt; }
          else if (B.pace < myPace * 0.99) M.pressT += dt;
        } else if (!B || gB < -Math.max(45, PRESS_FAR * vRef)) { pressId = null; M.pressT = 0; }
        if (M.concedeT > 0) M.concedeT = yellow ? 0 : M.concedeT - dt;
        if (pressId && pressId === B && nearB && M.pressT > K.concede && M.concedeT <= 0 && av > 40 && !yellow && !nextCornerSide(idx, 220)) { M.concedeT = 8; M.pressT = 0; stats.concedes++; note('concede'); }
        // (the car being let by may be level or just ahead: that is still B, or the nearest car ahead)
        var letBy = M.concedeT > 0 ? (pressId === B && B ? B : null) : null, gLet = letBy ? gB : 0;
        if (M.concedeT > 0 && !letBy && pressId) {
          for (i = 0; i < others.length; i++) if (others[i] === pressId && pressId.sampleIndex >= 0) {
            var sP = S[pressId.sampleIndex | 0];
            letBy = pressId; gLet = wrapN((pressId.sampleIndex | 0) - idx) * ds + (pressId.x - sP.x) * sP.tx + (pressId.z - sP.z) * sP.tz - myAlong;
          }
        }
        if (M.concedeT > 0 && letBy && gLet < CAR_LEN + 3 && gLet > -Math.max(45, PRESS_FAR * vRef)) {
          var dLet = typeof letBy.d === 'number' && letBy.d === letBy.d ? letBy.d : 0, vLB = (letBy.speed || 0);
          // give it room on the straight: off the line, a little slower until it is by
          mode = 'yield'; yieldFrom = letBy; yieldD = dLet;
          // a little slower than the car being let by, but never below 78 % of its own pace here (a cap taken only from
          // the follower's speed would feed back into a standstill when the follower is stuck behind it)
          var vOwn = Math.min(VA[cyc(idx + 4)], perfFor.topSpeed);
          var vLet = Math.max(vLB - 8, 0.78 * vOwn);
          if (vLet < capV) { capV = vLet; capWhy = 'concede'; }
        } else if (M.concedeT > 0) { M.concedeT = 0; pressId = null; M.pressT = 0; }
        if (yieldFrom) {
          if (yFor !== yieldFrom || ySide === 0) { yFor = yieldFrom; F[13] = yieldD; ySide = yieldSide(); }
          absOn = true; absTgt = ySide > 0 ? HI[idx] - 0.5 : LO[idx] + 0.5;
        } else { yFor = null; ySide = 0; }
        if (mode === 'race' || mode === 'pit') M.offTarget = M.wander;
      }
      if (!startDone) { M.offTarget = 0; absOn = false; }
      if (M.holdT > 0) { M.holdT -= dt; if (mode !== 'overtake') { if (absOn) absTgt = LD[idx] + M.offset; else M.offTarget = M.offset; } }
      // move the path towards the target at the skill's lateral rate: the offset from the racing line, or (anchored)
      // the lateral place itself
      var rate = K.sideRate * (mode !== 'overtake' ? 1 : (tgt && tgtSlow ? 2.5 : 1.5)) * dt;
      if (absOn) {
        var cur = LD[idx] + M.offset, dc = absTgt - cur;
        cur += dc > rate ? rate : (dc < -rate ? -rate : dc);
        M.offset = cur - LD[idx]; M.offTarget = absTgt - LD[idx];
        if (M.anchor < 1) M.anchor = M.anchor + 3 * dt > 1 ? 1 : M.anchor + 3 * dt;
      } else {
        var dOff = M.offTarget - M.offset;
        M.offset += dOff > rate ? rate : (dOff < -rate ? -rate : dOff);
        if (M.anchor > 0) M.anchor = M.anchor - 1.2 * dt < 0 ? 0 : M.anchor - 1.2 * dt;
      }
      Z.capV = capV;
    }

    // ---- steering: pure pursuit of the path point L metres on
    function stepSteer() {
      var v = st.speed, av = v < 0 ? -v : v, myD = Z.myD;
      var L = Math.min(Math.max(5 + 0.3 * av, LOOK_MIN), LOOK_MAX);
      pathD(idx, 0);
      off = st.onGrass || Math.abs(myD - F[0]) > 3;
      if (off) L *= 1.35;
      else if (cOn) L *= 0.75;                 // a car alongside: follow the (constrained) path more tightly
      var mL = (L / ds + 0.5) | 0, kL = cyc(idx + mL);           // (| 0: indices stay small integers)
      pathD(kL, mL); var dL = F[0];
      var px = S[kL].x + S[kL].nx * dL, pz = S[kL].z + S[kL].nz * dL;
      var steer = 0, pdx = px - st.x, pdz = pz - st.z, pd2 = pdx * pdx + pdz * pdz;
      if (pd2 > 1e-6) {
        var kap = 2 * (pdx * Math.cos(st.heading) - pdz * Math.sin(st.heading)) / pd2, lock;
        if (hasLockAt) { F[14] = av; F[15] = st.roll || 0; lockFor(kap >= 0 ? 1 : -1); lock = F[14]; }
        else { var rr = av / perfFor.steerSpeedRef; lock = perfFor.steerLock / (1 + rr * rr); }
        steer = Math.atan(kap * WB) / lock;
        steer = steer > 1 ? 1 : (steer < -1 ? -1 : steer);
      }
      Z.steer = steer;
    }

    // ---- speed: the profile, pace, offsets, pit route, mistakes, traffic
    function stepSpeed(ctx) {
      var dt = Z.dt, v = st.speed, av = v < 0 ? -v : v, myD = Z.myD, myAlong = Z.myAlong, Pp = G.pit;
      var capV = Z.capV, capF = Z.capF, vSq = Z.vSq, gB = Z.gB, vB = Z.vB, dB = Z.dB;
      gr = car.tyres && car.tyres.state && car.tyres.state.grip;
      var gLat = gr ? gr.lat : 1, gBrk = gr ? gr.brake : 1;
      var gripMul = gLat < 1 ? Math.sqrt(gLat) : 1;
      M.c0 = K.brake * perfFor.brakeBase * gBrk + perfFor.roll;
      M.c2 = K.brake * perfFor.brakeAero * gBrk + perfFor.dragK;
      var paceMul = (1 + M.noise) * gripMul;
      var la = (av * LATENCY / ds + 0.5) | 0, k0 = cyc(idx + la);
      targetAt(k0, la); var target = F[2] * paceMul;
      // feed-forward: the slope of the target along the path (a braking zone of the profile: its deceleration)
      targetAt(cyc(k0 + 2), la + 2); var t2 = F[2] * paceMul;
      var ff = (t2 * t2 - target * target) / (4 * ds);
      if (ff > 0) ff = 0;
      Z.target = target; Z.ff = ff; Z.paceMul = paceMul;
      scanAhead(la);
      target = Z.target; ff = Z.ff;
      var zoneMin = Z.zoneMin, zoneAt = scanAt;
      // braking zone ahead? (a corner at least 15 % slower than here): a chance of a mistake, once per zone
      var zone = zoneMin < VA[idx] * 0.85 && zoneAt > 0;
      if (zone && !zoneOn && !plan && ph !== 'grid' && startDone) {
        zoneOn = true;
        var p = K.mistake * (ph === 'quali' ? 0.6 : 1) * (finished ? 0 : 1);
        rndF(); if (F[6] < p) startMistake(zoneAt);
      } else if (!zone && zoneOn) zoneOn = false;
      if (mist.on && cyc(idx - mist.idx0) > mist.span) { mist.on = false; info.mistake = null; }

      // the cars ahead on the path (traffic loop): never closer than the gap the time gap gives, a speed each can always
      // be braked to (relative law: its speed a moment ahead from its measured deceleration, plus what this car can
      // still take off on top of the braking it plans, FOLLOW_A, over the gap beyond the wanted one)
      if (capF < 1e9) {
        if (capF < capV) { capV = capF; capWhy = 'follow'; }
        if (mode === 'race') mode = 'follow';
      }
      // alongside with no room and behind: drop back behind it (and give up the attack)
      if (squeezed) {
        var vq = Math.min(av - 1.5, vSq - 2);
        if (vq < 0) vq = 0;
        if (vq < capV) { capV = vq; capWhy = 'squeezed'; }
        if (tgt && !tgtSlow) { tgt = null; M.tgtCool = 2; }
        M.holdT = 1.5;                          // and keep this lane meanwhile (not back across the other car)
      }
      // off the road / far off the path / sideways: slow, get back first
      var head = st.heading - G.hdg[idx];                          // against the road (wrong way)
      head -= TWO_PI * Math.round(head / TWO_PI);
      var slide = st.heading - G.lhdg[idx];                        // against the line's direction (sideways)
      slide -= TWO_PI * Math.round(slide / TWO_PI);
      if (st.onGrass) { capV = Math.min(capV, Math.max(14, 0.55 * target)); capWhy = 'grass'; }
      else if (off) capV = Math.min(capV, 0.8 * target);
      if (Math.abs(slide) > 0.9 && Math.abs(head) > 0.7) { capV = Math.min(capV, 9); capWhy = 'sideways'; }
      // rejoining after R / an off: wait for the traffic coming on the line
      if (M.rejoinT > 0) {
        M.rejoinT -= dt;
        if (B && gB > -110 && vB > av + 4 && (-gB) / Math.max(1, vB - av) < 3.5 && Math.abs(dB - myD) < SEP + 2) {
          capV = Math.min(capV, av > 3 ? av * 0.7 : 0); capWhy = 'rejoin'; stats.rejoinWaits++;
        }
      }
      // (creeping past a stopped car, the creep speed is the target: the profile's slope fed forward to the pedals
      // would brake for what the creep never reaches - it cancelled every bit of throttle and the car crawled at
      // 0.5 m/s instead of 2.5, nose to tail behind a car stalled on the grid, for 15 s; 2026-10-02)
      if (capV < target) { target = capV; if (creepCap && capWhy === 'follow') ff = 0; }
      if (target < 0) target = 0;
      info.tgt = tgt ? tgt.id : -1; info.capBy = capWhy === 'follow' ? capFid : -1; info.obs = obsOn ? obsK : -1;
      info.targetSpeed = target; info.cap = capWhy; info.offset = M.offset; info.offTarget = M.offTarget;
      info.mode = mode;

      // ---- the box: stop exactly on it
      hold = false;
      if (plan && Pp && plan.box && !plan.through) {
        var b = plan.box, dBox = (b.u - pitU0) * ds + b.lon - myAlong;
        if (!served) {
          if (pitU0 > b.u - 40) {
            var vStop = Math.sqrt(2 * BOX_STOP_A * Math.max(0, dBox - 0.25));
            if (vStop < target) target = vStop;
            if (dBox < 0.6 && av < 1.2) hold = true;
            if (hold) {
              M.boxWait += dt;
              // no service (no pit.js state, or not accepted): leave after a while
              if ((!ctx.pit && M.boxWait > 3) || M.boxWait > 8) { served = true; plan.outFrom = pitU0; }
            }
          }
        } else {
          if (!(plan.outFrom > OUT_NONE)) plan.outFrom = pitU0;
          if (plan.park) { hold = true; info.mode = 'parked'; }
        }
      }
      Z.target = target; Z.ff = ff; Z.gBrk = gBrk; Z.head = head;
    }

    // the braking scan: the most speed from which every target ahead can still be met at the planned braking
    // (c0 + c2 v^2: the profile's own braking model on the flat, so on the line it reproduces the profile). In:
    // Z.target / Z.ff (the target here and its feed-forward), Z.paceMul, Z.myAlong; out: Z.target, Z.ff, Z.zoneMin and
    // scanAt (the slowest profile point within reach and where it is: a braking zone)
    function scanAhead(la) {
      var v = st.speed, av = v < 0 ? -v : v, target = Z.target, ff = Z.ff, paceMul = Z.paceMul, myAlong = Z.myAlong;
      var reach = ((Math.log((M.c0 + M.c2 * av * av) / M.c0) / (2 * M.c2) + 25) / ds + 1) | 0;
      if (reach > 260) reach = 260;
      var zoneMin = 1e9, zoneAt = -1;
      for (var m = la + SCAN_STEP; m <= reach; m += SCAN_STEP) {
        var k = cyc(idx + m), vk = VA[k];
        if (vk < zoneMin) { zoneMin = vk; zoneAt = m; }
        targetAt(k, m); var tk = F[2] * paceMul;
        if (tk < target) {
          var Dm = m * ds - myAlong, vb2 = tk;
          if (Dm > 0) { var vq2 = ((M.c0 + M.c2 * tk * tk) * Math.exp(2 * M.c2 * Dm) - M.c0) / M.c2; vb2 = vq2 > 0 ? Math.sqrt(vq2) : 0; }
          if (vb2 < target) { target = vb2; ff = -(M.c0 + M.c2 * av * av); }
        }
      }
      Z.target = target; Z.ff = ff; Z.zoneMin = zoneMin; scanAt = zoneAt;
    }

    // ---- pedals: feed-forward + feedback on the target; the battery on the straights, the limiter in the pit lane
    function stepPedals() {
      var dt = Z.dt, v = st.speed, av = v < 0 ? -v : v, target = Z.target, ff = Z.ff, accF = Z.accF, gBrk = Z.gBrk;
      var steer = Z.steer, Pp = G.pit;
      var sinP = Math.sin(st.pitch || 0);
      var resist = perfFor.roll + perfFor.dragK * av * av + GRAV * sinP;
      // braking towards a target ahead: the planned deceleration fed forward, the error fed back
      var accCmd = KP * (target - v) + (target < av + 2 ? ff : 0);
      if (accF < accCmd && !hold) accCmd = accF;                       // following: the deceleration that keeps the gap
      var drvMax = Math.min(perfFor.traction * (gr ? gr.traction : 1), perfFor.power / Math.max(av, 1));
      var brkMax = (perfFor.brakeBase + perfFor.brakeAero * av * av) * gBrk;
      var thr = 0, brk = 0;
      if (hold) {
        if (v > 0.6) brk = v > 2 ? 1 : 0.5;
        else if (v < -0.6) thr = 0.5;
        else if (v >= 0.3) brk = 0.5;
        else if (v <= -0.3) thr = 0.5;
      } else if (v < 0.5 && target > 0.5) thr = 1;
      // (from one pedal to the other only past a coasting band of PEDAL_BAND m/s^2 round the rolling resistance: a
      // command hovering there would flip throttle and brake several times a second)
      else if (accCmd > -resist + (M.brkOut > 0 ? PEDAL_BAND : 0)) thr = Math.min(Math.max((accCmd + resist) / drvMax, 0), 1);
      else if (v > 0.6 && accCmd < -resist - (M.thrOut > 0 ? PEDAL_BAND : 0)) brk = Math.min(Math.max((-accCmd - resist) / brkMax, 0), 1);
      // traction-aware exits: progressive throttle, a lift while the tyres slide
      if (thr > M.thrOut + K.thrRate * dt) thr = M.thrOut + K.thrRate * dt;
      if (st.slip > 0.25 && thr > 0.65) thr = 0.65;
      if (brk > M.brkOut + K.brkRate * dt && !hold && av > 3) brk = M.brkOut + K.brkRate * dt;
      if (mist.on && mist.lock && brk > 0.5) steer *= 0.6;              // locked fronts: the steering does less
      M.thrOut = thr; M.brkOut = brk;

      // ---- battery on the straights, the limiter in the pit lane
      limiter = false;
      if (plan && Pp && pitU0 >= Pp.entryU - 22 && pitU0 <= Pp.exitU + 2) limiter = true;
      var bat = st.battery;
      boost = false;
      if (perfFor.ers && thr >= 0.98 && brk === 0 && av > 100 / 3.6 && !limiter && !st.onGrass && ph !== 'grid') {
        var keep = mode === 'overtake' || mode === 'defend' ? 0.02 : K.reserve;
        if (bat > keep) boost = true;
      }
      Z.thr = thr; Z.brk = brk; Z.steer = steer;
    }

    // ---- recovery: wrong way, stuck, reverse attempts, R; then the pad -> input
    function stepRecover() {
      var dt = Z.dt, v = st.speed, av = v < 0 ? -v : v, steer = Z.steer, thr = Z.thr, brk = Z.brk, target = Z.target;
      var head = Z.head, gB = Z.gB;
      if (rev) {
        // (backing off from a stopped car: until there is room to steer round it, or a car comes close behind)
        var revOn = M.t < M.revUntil;
        if (backing && (!tgt || M.gT > CAR_LEN + 11 || (B && gB > -(CAR_LEN + 2)))) revOn = false;
        if (revOn) {
          // (the brake pedal: braking while still rolling forwards, reversing from a standstill)
          input.steerAxis = -M.revSteer; input.throttle = 0; input.brake = v > 0.5 ? 1 : 0.8;
          input.boost = false; input.limiter = limiter; info.mode = 'reverse'; return input;
        }
        rev = false; backing = false; M.stuckT = 0; progIdx = idx; M.progT = M.t;
      }
      if (Math.abs(head) > 2.0 && !inLaneNow) M.wrongT += dt; else M.wrongT = 0;
      if (M.wrongT > WRONG_S) {
        if (av > 1) { input.steerAxis = 0; input.throttle = v < 0 ? 1 : 0; input.brake = v > 0 ? 1 : 0; input.boost = false; input.limiter = false; info.mode = 'recover'; return input; }
        return requestReset('wrong way');
      }
      // standing behind a stopped car with no room on either side of it (a car across a narrow street): R, which puts
      // a computer car down past it (F1.AI.resetCar with the others)
      if (blockedNow && av < 1) M.blockT += dt; else M.blockT = 0;
      if (M.blockT > 8) { M.blockT = 0; stats.stuck++; return requestReset('blocked by a stopped car'); }
      // standing nose to tail behind a stopped car it means to drive round (no room to steer past it from here):
      // back off a few metres, when nothing is close behind
      if (tgt && tgtSlow && av < 0.5 && target < 0.6 && !hold && info.capBy === tgt.id && M.gT < CAR_LEN + 6 && (!B || gB < -(CAR_LEN + 5))) M.backT += dt; else M.backT = 0;
      if (M.backT > 1.5) {
        M.backT = 0; stats.reverses++; note('back off');
        rev = true; backing = true; M.revUntil = M.t + 4; M.revSteer = 0; M.revAt = M.t;
        input.steerAxis = 0; input.throttle = 0; input.brake = 0.8; input.boost = false; input.limiter = limiter; info.mode = 'reverse';
        return input;
      }
      var moved = cyc(idx - progIdx);
      if (moved >= 3 && moved < N / 2) { progIdx = idx; M.progT = M.t; M.hardT = M.t; }
      if (hold || (ps && ps.service)) M.hardT = M.t;
      if (M.t - M.hardT > STUCK_JAM_S) { M.hardT = M.t; stats.stuck++; return requestReset('no progress for ' + STUCK_JAM_S + ' s'); }
      var queued = capWhy === 'follow' || capWhy === 'squeezed' || capWhy === 'rejoin';
      if (target < 1.5 || hold || queued) M.progT = M.t;                // waiting on purpose / in a queue is not being stuck
      if (thr > 0.3 && av < 0.6 && !queued) M.stuckT += dt; else M.stuckT = 0;
      if (M.t - M.progT > STUCK_HARD_S) { stats.stuck++; return requestReset('no progress'); }
      if (M.stuckT > 1.5 || M.t - M.progT > STUCK_S) {
        stats.stuck++;
        if (M.t - M.revAt > 20) revN = 0;
        if (revN >= 2) { revN = 0; return requestReset('stuck'); }
        revN++; M.revAt = M.t; stats.reverses++; note('reverse v ' + av.toFixed(1) + ' ' + info.cap);
        rev = true; M.revUntil = M.t + REV_S; M.revSteer = steer;
        M.stuckT = 0; progIdx = idx; M.progT = M.t;
        input.steerAxis = -steer; input.throttle = 0; input.brake = 1; input.boost = false; input.limiter = limiter; info.mode = 'reverse';
        return input;
      }
      input.steerAxis = steer; input.throttle = thr; input.brake = brk; input.boost = boost; input.limiter = limiter;
      return input;
    }

    function requestReset(why) {
      info.mode = 'recover';
      input.steerAxis = 0; input.throttle = 0; input.brake = 0; input.boost = false;
      if (M.t - M.resetAt > RESET_GAP_S) {
        M.resetAt = M.t; input.reset = true; resetPending = true; stats.resets++;
        info.lastReset = why; note('R: ' + why);
      }
      return input;
    }

    // The car was moved (R, a placement): carry on from where it is now.
    function relocate() {
      var i0 = st.sampleIndex | 0;
      idx = i0 >= 0 && i0 < N ? i0 : track.locate(st.x, st.z, -1, isNum(st.y) ? st.y : undefined).index;
      prevIdx = idx; progIdx = idx; M.progT = M.t; M.hardT = M.t; M.stuckT = 0; M.wrongT = 0; rev = false; backing = false;
      M.offset = Math.min(Math.max(st.d - LD[idx], -12), 12); M.offTarget = 0; M.thrOut = M.brkOut = 0;
      mist.on = false; info.mistake = null; tgt = null; tgtSlow = false; obsOn = false;
      if (resetPending) { resetPending = false; M.rejoinT = REJOIN_MAX_S; }
      // (a planned stop stays planned: the car takes the lane at the next pass)
    }

    // M.sepT = the centre-to-centre distance across the road to keep from car o at sample iO: both half widths (its
    // box turned across the road reaches further: a car standing across) and a margin; SEP for parallel cars
    function sepOf(o, iO) {
      var a = o.heading - G.hdg[iO], sa = Math.sin(a), ca = Math.cos(a);
      M.sepT = 0.5 * CAR_WID + 0.5 * CAR_WID * (ca < 0 ? -ca : ca) + 0.5 * CAR_LEN * (sa < 0 ? -sa : sa) + (SEP - CAR_WID);
    }
    // the side (+1 left / -1 right) to get out of the way to, from a car at lateral dO behind: away from it when it is
    // clearly to one side, else away from where the racing line goes over the next ~150 m (where it will drive)
    function yieldSide() {
      var dO = F[13];
      if (dO > M.myD + 1.2) return -1;
      if (dO < M.myD - 1.2) return 1;
      var s = 0, n = (150 / ds) | 0;
      for (var m = 5; m <= n; m += 5) s += LD[cyc(idx + m)];
      return s >= 0 ? -1 : 1;
    }
    // pass on the side with room at the other car's place; the inside of the next corner first
    function chooseSide(iO, o) {
      var dO = F[13];
      var sp = SEP;
      if (o) { sepOf(o, iO); sp = M.sepT; }
      var roomL = HI[iO] - (dO + sp), roomR = (dO - sp) - LO[iO];
      if (roomL < -0.3 && roomR < -0.3) return 0;
      if (roomL < -0.3) return -1;
      if (roomR < -0.3) return 1;
      // a car standing: a side this car can still get to before it (a move across of s m takes ~2.5 s + 6 m of road,
      // F[16] = the gap): in a tight corner its outside (the inside asks for more steering lock than a car at the
      // corner's speed has), else the smaller move (not across in front of it); neither: the smaller move all the same
      // (backing off makes the room)
      if (o && (o.speed || 0) < 3 && (o.speed || 0) > -3) {
        var gO = F[16], shL = dO + sp + 1 - M.myD, shR = M.myD - (dO - sp - 1);
        if (shL < 0) shL = -shL; if (shR < 0) shR = -shR;
        var okL = roomL > 0 && gO > 2.5 * shL + 6, okR = roomR > 0 && gO > 2.5 * shR + 6;
        var cK = CV[iO];
        if (cK < -1 / 150 && okR) return -1;              // (curvature < 0: a left turn, the outside is -n)
        if (cK > 1 / 150 && okL) return 1;
        if (okL && (!okR || shL <= shR)) return 1;
        if (okR) return -1;
        return shL <= shR ? 1 : -1;
      }
      if (roomL - roomR > 2) return 1;              // it is clearly over on one side (giving room): the other side
      if (roomR - roomL > 2) return -1;
      var inside = nextCornerSide(iO, 160);
      if (inside) return inside;
      return roomL >= roomR ? 1 : -1;
    }
    // +1 / -1: the inside (left / right) of the next real corner within `metres` of sample i, 0 = none
    function nextCornerSide(i, metres) {
      var n = Math.round(metres / ds);
      for (var m = 0; m <= n; m += 3) {
        var k = cyc(i + m), c = CV[k];
        if (c < -1 / 140) return 1;           // left turn: inside = +n
        if (c > 1 / 140) return -1;
      }
      return 0;
    }

    // target speed at sample k (m ahead) before pace / grip: the profile x the offset path, the pit route, mistakes
    function targetAt(k, m) {
      var vk = VA[k];
      if (plan && G.pit) {
        var Pp = G.pit, u = pitU0 + m;
        if (u >= Pp.entryU - 4 && u <= Pp.exitU + 1) { var lim = Pp.limitV - LIMIT_MARGIN; if (vk > lim) vk = lim; }
        else if (u > Pp.exitU + 1 && u <= Pp.L + 8) { var tv = Pp.limitV + TAPER_DV; if (vk > tv) vk = tv; }
        else if (u >= -6 && u < Pp.entryU - 4) { if (vk > 30) vk = 30; }
        if (plan.box && !plan.through && !served && u >= plan.box.u) vk = 0;
        F[2] = vk; return;
      }
      pathD(k, m);
      var x = 1 + (F[0] - LD[k]) * CV[k];              // an offset to the inside of a corner tightens it
      // (the grip asks sqrt(x); slow and tight, the steering lock asks about x)
      if (x < 1) { var xs = x <= 0.3 ? 0.5477 : Math.sqrt(x); vk *= vk < 30 ? (x <= 0.3 ? 0.3 : x) : xs; }
      if (mist.on && m >= 0) {
        var r = cyc(k - mist.idx0);
        if (r <= mist.span) {
          if (mist.shift) vk = VA[cyc(k - mist.shift)] > vk ? VA[cyc(k - mist.shift)] : vk;
          vk *= mist.mul;
        }
      }
      F[2] = vk;
    }

    function startMistake(zoneAt) {
      rndF(); var big = F[6] < K.big; rndF(); var kind = F[6]; rndF(); var r3 = F[6];
      mist.on = true; mist.idx0 = idx; mist.span = zoneAt + 40; mist.from = zoneAt; mist.lock = kind < 0.55;
      mist.shift = kind < 0.55 ? (big ? 14 : (5 + 7 * r3 + 0.5) | 0) : 0;                 // late braking (samples)
      mist.mul = kind < 0.55 ? 1 : (big ? 1.13 + 0.05 * r3 : 1.04 + 0.04 * r3);          // too fast into the corner
      stats.mistakes++; if (big) stats.bigMistakes++;
      info.mistake = (big ? 'big ' : '') + (mist.lock ? 'late braking' : 'too fast');
      note('mistake: ' + info.mistake);
    }

    // What this driver remembers of each other car (how long it has stood, its measured deceleration, the in-path
    // hold), in a table keyed by the car's FULL id (open addressing, linear probing): in a room ids grow past 63
    // (net/server.js counts one up for every human and every computer car made), and slots by id & 63 let two cars 64
    // apart reset each other's memory every step - a car stopped on the line was never seen as stopped, the cars behind
    // queued 30 s and then asked for R (review r3). memSlot(id) -> oSlot (-1: no usable id); a slot not looked at for
    // MEM_STALE s (a car gone, or a ghost) goes to a new id that needs it; reset() empties the table (its times are on
    // this driver's clock, which reset() restarts). Slots are never emptied otherwise, so no probe chain is broken.
    var MEM_N = 128, MEM_STALE = 5, oSlot = -1;
    var memId = new Float64Array(MEM_N), memSeen = new Float64Array(MEM_N);
    // the along-track acceleration of another car (F[5]: its along-track speed in, the acceleration out), from its
    // speed at the previous think
    var accMem = new Float64Array(MEM_N), accT = new Float64Array(MEM_N), accA = new Float64Array(MEM_N);
    // how long another car has been standing (|speed| < 3 m/s): F[4] = seconds (0: moving)
    var slowSince = new Float64Array(MEM_N), slowG = new Float64Array(32);
    var ipUntil = new Float64Array(MEM_N);    // in-path hold
    function memSlot(oid) {
      oSlot = -1;
      if (!(typeof oid === 'number' && oid >= 0)) return;
      var h = (oid & (MEM_N - 1)) | 0, free = -1, k = h;
      for (var n = 0; n < MEM_N; n++) {
        k = (h + n) & (MEM_N - 1);
        var key = memId[k];
        if (key === oid) { memSeen[k] = M.t; oSlot = k; return; }
        if (key < 0) { if (free < 0) free = k; break; }
        if (free < 0 && M.t - memSeen[k] > MEM_STALE) free = k;
      }
      if (free < 0) free = h;                  // (every slot a car seen in the last MEM_STALE s: not with < 128 cars)
      memId[free] = oid; memSeen[free] = M.t;
      slowSince[free] = -1; accT[free] = -1e9; accA[free] = 0; ipUntil[free] = -1;
      oSlot = free;
    }
    // (once per view and step, before anything else looks at the car: the slot is oSlot for the rest of its turn)
    function slowFor(o, isSlow) {
      memSlot(o.id); F[4] = 0;
      var k = oSlot;
      if (k < 0) return;
      if (!isSlow) { slowSince[k] = -1; return; }
      if (slowSince[k] < 0) slowSince[k] = M.t;
      F[4] = M.t - slowSince[k];
    }
    function accOf(o) {
      var ov = F[5], id = oSlot;
      if (id < 0) { F[5] = 0; return; }
      var dtm = M.t - accT[id];
      if (dtm > 0 && dtm < 0.2) { var a = (ov - accMem[id]) / dtm; accA[id] += (a - accA[id]) * 0.3; }
      else if (dtm >= 0.2) accA[id] = 0;
      if (dtm > 0) { accMem[id] = ov; accT[id] = M.t; }
      F[5] = accA[id];
    }

    function gauss() {                         // ~N(0, 1): sum of three uniforms, scaled -> F[6]
      rndF(); var a = F[6]; rndF(); var b = F[6]; rndF();
      F[6] = (a + b + F[6] - 1.5) * 2;
    }

    /** a pit event of this car's F1.createPit: at 'serviceDone' -> the compound to fit */
    function onPit(ev) {
      if (ev === 'serviceDone') {
        served = true; stats.pitStops++;
        if (plan) plan.outFrom = pitU0;
        var c = plan ? plan.compound : (nextCompound || info.compound || 'M');
        info.compound = c; info.wearPerLap = 0; M.wearRef = -1;
        return c;
      }
      // ('exit' comes 6..8 m after the exit line, in the taper: the plan ends once the car is back on the track)
      return null;
    }

    ensureProfile();                           // (the profile is built here, not in the first think)
    var api = {
      think: think, reset: reset, setSkill: setSkill, onPit: onPit, startCompound: startCompound,
      skill: skill, level: levelOf(skill), id: selfId, name: opts.name || '', slot: slot, seed: seed,
      state: info, stats: stats, log: log,
      get plan() { return plan; },
      /** the lap time (s) this driver's profile gives with this car on this track: put it in the views of computer
       *  cars (others[i].pace) so the others know whom to let by / whom to attack */
      get pace() { ensureProfile(); return G.lapT[profileKey] || 0; },
      setSlot: function (s) { slot = isNum(s) ? Math.max(0, Math.floor(s)) : 0; api.slot = slot; },
      /** a stop at the next chance (the decision window before the pit entry): fit `compound`, or park in the box */
      planStop: function (compound, park) { if (G.pit) pending = { compound: compound || 'M', park: !!park }; },
      profile: function () { ensureProfile(); return VA; }
    };
    reset();
    return api;
  }

  // ---- placement helpers (main.js's own rules, for the integrator and the node simulations) -----------------------
  var CAR_NOSE = 2.8;
  /** main.js placeOnGrid(slot): the car's nose at the grid box's front bar, facing the box. -> sample index */
  function placeOnGrid(car, track, slot) {
    var Gd = track.grid, g = Gd[Math.max(0, Math.min(Gd.length - 1, Math.floor(slot) || 0))];
    car.reset(track, g.index);
    car.state.heading = g.heading;
    car.state.x = g.x - Math.sin(g.heading) * CAR_NOSE;
    car.state.z = g.z - Math.cos(g.heading) * CAR_NOSE;
    car.update(1e-4, null, track);
    car.state.speed = 0;
    return car.state.sampleIndex;
  }
  /** main.js resetCar (R): the centreline at the car's place, or the pit lane's centre when it is in the pit lane.
   *  idx: the sample (default car.state.sampleIndex; pass lap.prevIdx while the lap counter waits out a jump).
   *  others, selfId (optional, for a computer car): the other cars (views: x, z, speed, sampleIndex, ghost, id; the
   *  car's own view is skipped by selfId): the place moves on along the track (up to ~80 m) to the first spot with no
   *  solid car within 7 m and no car standing in the 30 m ahead of it - a computer car put down on, or right behind, a
   *  stopped car would only be stuck there again.
   *  -> the new sample index (then lap.sync(it)) */
  function resetCar(car, track, idx, others, selfId) {
    var P = track.pit, S = track.samples, n = S.length, s = car.state;
    var i = ((Math.round(isNum(idx) ? idx : s.sampleIndex) % n) + n) % n;
    var inPit = P && ((typeof P.paved === 'function' && P.paved(s.sampleIndex, s.d)) || (P.inLane && P.inLane(s.sampleIndex, s.d)));
    if (!inPit && others && others.length) {
      var dsR = track.length / n, stepR = Math.max(1, Math.round(3 / dsR)), maxR = Math.round(80 / dsR);
      for (var k = 0; k <= maxR; k += stepR) {
        var j = (i + k) % n, free = true;
        for (var q = 0; q < others.length && free; q++) {
          var o = others[q];
          if (!o || o.ghost || o === s || (selfId !== undefined && o.id === selfId)) continue;
          // (a car on the other road of an over / under crossing is no obstacle here)
          if (isNum(o.y) && isNum(S[j].y) && Math.abs(o.y - S[j].y) > LEVEL_DY) continue;
          var ex = o.x - S[j].x, ez = o.z - S[j].z;
          if (ex * ex + ez * ez < 49) free = false;
          // (nor just behind a car standing in the road: the R that is asked for when blocked by one must get past it)
          var spo = o.speed || 0, ahead = (((o.sampleIndex | 0) - j) % n + n) % n;
          if (spo < 3 && spo > -3 && ahead * dsR < 30 && ex * ex + ez * ez < 900) free = false;
        }
        if (free) { i = j; break; }
      }
    }
    car.reset(track, i);
    if (!inPit) return car.state.sampleIndex;
    var a = (i + n - 1) % n, b = (i + 1) % n, d = P.laneD(i), da = P.laneD(a), db = P.laneD(b);
    if (!(d === d)) return car.state.sampleIndex;
    if (!(da === da)) { a = i; da = d; }
    if (!(db === db)) { b = i; db = d; }
    s.x = S[i].x + S[i].nx * d; s.z = S[i].z + S[i].nz * d;
    s.heading = Math.atan2(S[b].x + S[b].nx * db - S[a].x - S[a].nx * da, S[b].z + S[b].nz * db - S[a].z - S[a].nz * da);
    car.update(1e-4, null, track);
    s.speed = 0;
    return s.sampleIndex;
  }

  /** A view of a car for think()'s `others`. Create every view with this (and fill it with updateView): all views
   *  then share one shape and their numbers stay unboxed, which keeps think() allocation-free. prog / pace NaN =
   *  unknown (a human driver's pace is not known); y: the car's height (NaN = unknown; F1.AI.resetCar uses it at an
   *  over / under crossing). Add no other fields to a view (one more shape and think() slows down and allocates). */
  function createView(id) {
    return { id: id, x: 0.5, z: 0.5, heading: 0.5, speed: 0.5, sampleIndex: 0, d: 0.5, ghost: false, prog: NaN, pace: NaN,
             y: NaN };
  }
  /** The context of a think() call (one per computer car, refreshed in place every step): see the header. */
  function createContext() {
    return { phase: 'free', locked: false, lap: 0, laps: 0, done: false, prog: NaN, pit: null, wear: 1.5 };
  }
  /** Fill a view of another car for think()'s `others` from a car state ({x, z, heading, speed[, y, sampleIndex, d]}),
   *  locating it on the track when the state has no sample index (remote cars; the hint is kept in the view) - with its
   *  height y when the state has one: at an over / under crossing (Suzuka) the road it is on, not the one above / below
   *  (a remote state from the network has y). */
  function updateView(view, state, track) {
    view.x = state.x; view.z = state.z; view.heading = state.heading; view.speed = state.speed;
    var y = isNum(state.y) ? state.y : NaN;
    view.y = y;
    if (isNum(state.sampleIndex) && isNum(state.d)) { view.sampleIndex = state.sampleIndex; view.d = state.d; }
    else {
      var hint = isNum(view.sampleIndex) ? view.sampleIndex : -1, yl = y === y ? y : undefined;
      var loc = track.locate(state.x, state.z, hint, yl);
      var s = track.samples[loc.index], ex = state.x - s.x, ez = state.z - s.z;
      if (hint >= 0 && ex * ex + ez * ez > 900) loc = track.locate(state.x, state.z, -1, yl);
      view.sampleIndex = loc.index; view.d = loc.d;
    }
    return view;
  }

  /** Car-to-car contacts of locally simulated cars (offline: the player + the computer cars; online host: its own
   *  computer cars): every solid car is resolved against a snapshot of the others taken before any moved, as each
   *  game resolves its own car (js/collide.js). resolveAll(entries, dt, onContact?): entries [{state, car?, solid}]
   *  (solid false: a ghost - Grand Prix rules, pit asphalt); car.bump(hit) for every car that was hit;
   *  onContact(i, j, dv, hit) per impact on car i from car j (dv = its velocity change, m/s). -> the strongest hit.
   *  Allocation-free after warm-up when nothing touches (js/collide.js allocates a record per impact). */
  function createContacts() {
    // (no allocation per call: the candidate lists come from a pool, one array per length, filled by index - an array
    // emptied with length = 0 drops its storage and the next push allocates a new one; the snapshots hold doubles)
    var snap = [], pool = [], map = new Int32Array(64), scratch = [];
    return function resolveAll(entries, dt, onContact) {
      var n = entries.length, i, j, e, s, max = 0;
      if (typeof F1.resolveCarCollisions !== 'function') return 0;
      for (i = 0; i < n; i++) {
        e = entries[i]; s = snap[i] || (snap[i] = { x: 0.5, z: 0.5, y: 0.5, heading: 0.5, speed: 0.5 });
        s.x = e.state.x; s.z = e.state.z; s.y = e.state.y || 0; s.heading = e.state.heading; s.speed = e.state.speed;
      }
      for (i = 0; i < n; i++) {
        e = entries[i];
        if (!e.solid) continue;
        var cnt = 0;
        for (j = 0; j < n && cnt < 64; j++) {
          if (j === i || !entries[j].solid) continue;
          var dx = snap[j].x - snap[i].x, dz = snap[j].z - snap[i].z;
          if (dx * dx + dz * dz < 400) map[cnt++] = j;
        }
        if (!cnt) continue;
        var list = pool[cnt];
        if (!list) { list = pool[cnt] = []; for (j = 0; j < cnt; j++) list.push(snap[0]); }
        for (j = 0; j < cnt; j++) list[j] = snap[map[j]];
        if (scratch.length) scratch.length = 0;
        var h = F1.resolveCarCollisions(e.state, list, dt, onContact ? scratch : undefined);
        if (h > 0) { if (e.car && e.car.bump) e.car.bump(h); if (h > max) max = h; }
        if (onContact) for (var c = 0; c < scratch.length; c++) onContact(i, map[scratch[c].i], Math.sqrt(scratch[c].ix * scratch[c].ix + scratch[c].iz * scratch[c].iz), h);
      }
      return max;
    };
  }


  /** F1.AI.warmUp(track, raceLine, opts?) -> {steps, calls, pitStops, resets, passTries, offs, yields, mistakes} | null. Optional, for the loading screen: six computer cars
   *  of this module's own drive through a short scripted session on this track - the grid and lights out, a pack in
   *  traffic, a car stopped on the road, a blue flag, a pit stop in a box, R after facing the wrong way, the grass,
   *  qualifying, after the flag - ~35 000 think() calls with the real js/car.js (~0.3 s of CPU, once per track: later
   *  calls return at once unless opts.force). V8 then has type feedback for nearly every branch and has optimised the
   *  drivers' code before the session starts: without it the first race of a session allocates ~100 MB more (the
   *  drivers' code de-optimised again and again while V8 learns it: devtests/ai-test/warmup.js). The real drivers drive
   *  exactly as without it (own cars and seeds; G.pitLoss is left to the first real driver). Needs js/car.js
   *  (F1.createCar); js/pit.js for the stop. opts: spec (CarSpec, default F1.REF_SPEC), force. */
  function warmUp(track, raceLine, opts) {
    opts = opts || {};
    if (typeof F1.createCar !== 'function' || !track || !track.samples) return null;
    var G = prepare(track, raceLine);
    if (G.warmed && !opts.force) return { steps: 0, calls: 0 };
    var keepLoss = G.pitLoss, keepLossV = G.pitLossV, S = track.samples, N = S.length, ds = track.length / N, STEPW = 1 / 120, n = 6;
    var spec = opts.spec || F1.REF_SPEC, SK = [0, 0.35, 0.7, 1, 0.5, 0.2];
    var cars = [], ais = [], views = [], ctxs = [], pits = [], ents = [], held = [], calls = 0, steps = 0, i;
    var contacts = createContacts(), hasPit = !!(G.pit && typeof F1.createPit === 'function');
    // seconds of a phase for the cars in the bit mask `active` (the others are ghosts, not moved); until(): stop early
    function run(seconds, phase, locked, active, until) {
      var nS = Math.round(seconds / STEPW);
      for (var k = 0; k < nS && !(until && until()); k++, steps++) {
        for (var j = 0; j < n; j++) {
          var st = cars[j].state, v = views[j];
          v.x = st.x; v.z = st.z; v.y = st.y; v.heading = st.heading; v.speed = st.speed; v.sampleIndex = st.sampleIndex; v.d = st.d;
          v.ghost = phase === 'quali' || !(active & (1 << j));
          v.prog = (j === 5 ? 1 : 0) + st.sampleIndex / N; v.pace = ais[j].pace;   // (car 5 a lap up: blue flags)
        }
        for (j = 0; j < n; j++) {
          var c = cars[j], s = c.state, cx = ctxs[j];
          if (!(active & (1 << j))) continue;
          if (held[j]) { s.speed = 0; continue; }     // stopped on the road
          cx.phase = phase; cx.locked = locked; cx.laps = phase === 'race' ? 20 : 0; cx.lap = 1; cx.prog = views[j].prog;
          cx.wear = 3; cx.pit = pits[j] ? pits[j].state : null; cx.done = phase === 'results';
          var inp = ais[j].think(STEPW, views, cx); calls++;
          if (locked) { s.speed = 0; continue; }
          var ev = null;
          if (pits[j] && pits[j].state.service) { s.speed = 0; ev = pits[j].update(STEPW, s, track, { slot: j }); }
          else if (inp.reset) { resetCar(c, track, s.sampleIndex, views, 9001 + j); continue; }
          else { c.update(STEPW, inp, track); if (pits[j]) ev = pits[j].update(STEPW, s, track, { slot: j, limiter: inp.limiter }); }
          if (ev) { var cmp = ais[j].onPit(ev); if (cmp && c.tyres) c.tyres.fit(cmp); }
        }
        for (j = 0; j < n; j++) ents[j].solid = phase !== 'quali' && !!(active & (1 << j)) && !(pits[j] && pits[j].state.service);
        contacts(ents, STEPW);
      }
    }
    try {
      for (i = 0; i < n; i++) {
        var car = F1.createCar(spec, { random: makeRandom(9101 + i) });
        cars.push(car);
        ais.push(createAIDriver({ track: track, raceLine: raceLine, car: car, skill: SK[i], seed: 9001 + i, id: 9001 + i, slot: i,
                                 mistakeRate: i === 0 || i === 4 ? 0.5 : -1 }));
        views.push(createView(9001 + i)); ctxs.push(createContext());
        pits.push(hasPit ? F1.createPit({ random: makeRandom(9201 + i) }) : null);
        ents.push({ state: car.state, car: car, solid: true }); held.push(false);
        if (track.grid && track.grid.length > i) placeOnGrid(car, track, i); else car.reset(track, (N - 12 * i) % N);
        if (car.setBattery) car.setBattery(1);
        if (car.tyres && car.tyres.setWearRate) car.tyres.setWearRate(3);
        ais[i].reset();
      }
      var ALL = (1 << n) - 1;
      run(0.5, 'grid', true, ALL);                   // on the grid, locked
      run(9, 'race', false, ALL);                    // lights out, the pack, the first corners
      var lead = 0;                                  // the car furthest on: stopped on the road for a while
      for (i = 1; i < n; i++) {
        var dl = (cars[i].state.sampleIndex - cars[lead].state.sampleIndex) % N; if (dl < 0) dl += N;
        if (dl > 0 && dl < N / 2) lead = i;
      }
      held[lead] = true; run(7, 'race', false, ALL); held[lead] = false;
      if (hasPit) {                                  // a stop in the box (two cars), until both are back on the track
        for (i = 1; i <= 2; i++) {
          var at = (G.pit.from - Math.round((300 + 15 * i) / ds)) % N; if (at < 0) at += N;
          cars[i].reset(track, at); ais[i].planStop('H');
        }
        run(45, 'race', false, 6, function () { return ais[1].stats.pitStops > 0 && ais[2].stats.pitStops > 0 && !ais[1].plan && !ais[2].plan; });
      }
      var w = cars[3].state; w.heading += Math.PI; cars[3].update(1e-4, null, track);   // facing the wrong way: R
      var g = cars[4].state, sg = S[g.sampleIndex], side = (sg.wallPosDist || 12) >= 12 ? 1 : -1;
      g.x += sg.nx * side * 10; g.z += sg.nz * side * 10; cars[4].update(1e-4, null, track);   // on the grass
      run(5, 'race', false, ALL);
      run(3, 'quali', false, ALL);
      run(3, 'results', false, ALL);
    } catch (e) { G.warmed = true; G.pitLoss = keepLoss; G.pitLossV = keepLossV; return null; }
    G.warmed = true; G.pitLoss = keepLoss; G.pitLossV = keepLossV;         // (the first real driver's profile sets it, as without a warm-up)
    var sum = { steps: steps, calls: calls, pitStops: 0, resets: 0, passTries: 0, offs: 0, yields: 0, mistakes: 0 };
    for (i = 0; i < n; i++) for (var key in sum) if (key !== 'steps' && key !== 'calls') sum[key] += ais[i].stats[key];
    return sum;
  }

  // ---- names and cars for the computer drivers -------------------------------------------------------------------
  var INVENTED = ['A. Moreau', 'K. Tanaka', 'L. Rossi', 'J. Novak', 'M. Silva', 'T. Becker', 'R. Okafor', 'S. Lindqvist',
    'D. Kowalski', 'E. Laurent', 'H. Nakamura', 'P. Romano', 'C. Duarte', 'N. Petrov', 'O. Hansen', 'V. Costa',
    'B. Keller', 'I. Moretti', 'F. Dubois', 'G. Andersen', 'Y. Sato', 'W. Fischer', 'Z. Horvat', 'U. Martins'];

  // an integer seed for one seat of the field: the field's seed, the car id and the seat (FNV-1a)
  function seatSeed(seed, car, seat) {
    var h = 2166136261 ^ (seed | 0), str = String(car) + '#' + seat;
    for (var k = 0; k < str.length; k++) h = Math.imul(h ^ str.charCodeAt(k), 16777619);
    return ((h >>> 0) % 2147483646) + 1;
  }

  function shortName(name) {
    name = String(name || '').replace(/\s+/g, ' ').trim();
    if (Array.from(name).length <= 16) return name;
    var parts = name.split(' ');
    var s = parts[0].charAt(0) + '. ' + parts.slice(1).join(' ');
    return Array.from(s).slice(0, 16).join('');
  }

  /** The computer field of a session.
   *  opts = { cars: [CarSpec] (that season's, F1.cars.list(year)), taken: [car ids the humans drive], count,
   *           skill (0..1 / level, or 'mixed'), seed, drivers: fn(carId) -> [{name, abbr?, number?}] (optional: the
   *           season's real drivers; else invented names), names: [names already used] }
   *  -> [{ name, car, skill, seed, abbr }]: every team fields two cars; seats taken by humans are left out; teams are
   *  filled in the order of the list (one seat of every team first, then the second seats), so a small field still
   *  has many liveries. */
  function lineup(opts) {
    opts = opts || {};
    var cars = (opts.cars || []).filter(function (c) { return c && c.id && !/-standard$/.test(c.id); });
    var count = Math.max(0, Math.min(15, Math.floor(opts.count || 0)));
    var rnd0 = isNum(opts.seed) ? Math.floor(opts.seed) : 7;
    var taken = {}, used = {}, i, j;
    (opts.taken || []).forEach(function (id) { taken[id] = (taken[id] || 0) + 1; });
    (opts.names || []).forEach(function (n) { used[n] = 1; });
    var seats = [];
    for (j = 0; j < 2; j++) for (i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (taken[c.id] > 0) { taken[c.id]--; continue; }
      seats.push({ car: c.id, seat: j });
    }
    if (!cars.length) for (i = 0; i < count; i++) seats.push({ car: opts.fallbackCar || '', seat: 0 });
    while (seats.length < count && cars.length) seats.push({ car: cars[seats.length % cars.length].id, seat: 2 });
    var out = [], inv = 0;
    var mixed = opts.skill === 'mixed';
    for (i = 0; i < count && i < seats.length; i++) {
      var s = seats[i], list = typeof opts.drivers === 'function' ? opts.drivers(s.car) || [] : [];
      var dr = list[s.seat] || null, name = dr ? shortName(dr.name) : '';
      if (!name || used[name]) {
        while (inv < INVENTED.length * 4 && used[INVENTED[inv % INVENTED.length] + (inv >= INVENTED.length ? ' ' + (1 + Math.floor(inv / INVENTED.length)) : '')]) inv++;
        name = INVENTED[inv % INVENTED.length] + (inv >= INVENTED.length ? ' ' + (1 + Math.floor(inv / INVENTED.length)) : '');
        inv++; dr = null;
      }
      used[name] = 1;
      // a seat's level and randomness come from the seed and the SEAT (car, seat), not from its place in the list: a
      // human taking another seat (a player joining the room, another car picked) leaves every other driver as he
      // was - with one generator for the whole list everybody after that seat got another level (2026-10-02)
      var rs = makeRandom(seatSeed(rnd0, s.car, s.seat >= 2 ? 2 + i : s.seat));
      var sk = mixed ? LEVELS[Math.floor(rs() * LEVELS.length)].skill : skillOf(opts.skill);
      sk = clamp(sk + (rs() - 0.5) * 0.08, 0, 1);        // nobody is exactly like a teammate
      out.push({ name: name, car: s.car, skill: Math.round(sk * 1000) / 1000, seed: (rs() * 2147483647) | 0,
                 abbr: dr && dr.abbr ? dr.abbr : name.replace(/[^A-Za-z]/g, '').slice(-3).toUpperCase() });
    }
    return out;
  }

  var AI = {
    LEVELS: LEVELS, skillOf: skillOf, levelOf: levelOf, params: params, PACE: PACE, paceOf: paceOf,
    prepare: prepare, profile: profile, makeRandom: makeRandom,
    placeOnGrid: placeOnGrid, resetCar: resetCar, updateView: updateView, createView: createView,
    createContext: createContext, createContacts: createContacts, warmUp: warmUp,
    lineup: lineup, shortName: shortName, INVENTED: INVENTED,
    // the set to start a race of `laps` laps on at wear multiplier `wear` on a track of `length` m: the softest that
    // lasts it (the stop strategy takes over when the measured wear says otherwise)
    startCompound: function (laps, wear, length) {
      var w = isNum(wear) && wear > 0 ? wear : 1, n = isNum(laps) && laps > 0 ? laps : 5;
      var base = WEAR_LAP0 * (isNum(length) && length > 500 ? length : 5000) * w;
      for (var i = 0; i < ORDER.length; i++) if (base * COMPOUND_WEAR[ORDER[i]] * n <= WEAR_END - 0.06) return ORDER[i];
      return 'H';
    },
    CAR_LEN: CAR_LEN, CAR_WID: CAR_WID, SEP: SEP
  };
  F1.AI = AI;
  F1.createAIDriver = createAIDriver;
  AI.createAIDriver = createAIDriver;
  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
})(typeof window !== 'undefined' ? window : globalThis);
