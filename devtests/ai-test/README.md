# devtests/ai-test: the computer drivers (js/ai.js) in node

Everything here runs the REAL game modules in node (js/car.js at 1/120 s, js/tyres.js, js/collide.js, js/pit.js,
js/laps.js, net/session.js; THREE only for the racing line's mesh). No Electron, no sound.
The unit tests are `node test/ai.test.js` (36 tests, ~10 s; five are review r3's regressions, the last two the press follow-up's). `AI_JS=<path>` makes `lib.js` load another copy
of js/ai.js (A/B experiments; `fingerprint.js` shows whether two copies drive identically).

| script | what it does | time |
|---|---|---|
| `node devtests/ai-test/matrix.js` | the scenario matrix: on 14 circuits a 4-car Grand Prix with qualifying, an 8-car race from a reversed grid and a 15-car race (random grid, tyre wear x4); finishing order vs skill, passes, contacts, offs, resets, stuck cars, pit stops, lap gap per level, CPU cost; `out/matrix.json` (git-ignored) | ~1.5 min |
| `node devtests/ai-test/race.js track=monza n=15 laps=5 quali=2 grid=quali wear=3 skills=mixed year=2026` | one Grand Prix with the full classification table (`AILOG=1` prints every driver's event log) | seconds |
| `node devtests/ai-test/alltracks.js [warm=1]` | all 40 circuits: `F1.AI.warmUp` (two stops, at most 3 R), then laps alone at skill 0 and 1 and a pit stop in box 7 (limiter, own box, tyre change, exit taper) | ~15 s |
| `node devtests/ai-test/pace.js tracks=monza,spa laps=4` | one car alone per level: lap times against the reference (the racing line's own margins driven perfectly), the keyboard calibration driver and the line's prediction | ~10 s |
| `node devtests/ai-test/calibrate.js` | solves `PACE` in js/ai.js (the pace factor per level) so that the median gap over 10 circuits is each level's `lapPct`. Re-run after ANY change to js/car.js physics, js/raceline.js or the track data, paste the printed table | ~30 s |
| `node devtests/ai-test/bridge.js` | Suzuka's over / under crossing: one computer car on each road, timed to meet at the crossing (3 skills x 9 timings): no level jump (index, driver index, height, a remote view located by `F1.AI.updateView`), no contact, speed and place identical to the same car alone; also how often a locate WITHOUT the height lands on the wrong road | ~1 s |
| `node devtests/ai-test/fingerprint.js [only=..] [warm=1]` | a bit-exact fingerprint of the driving (4 races, a parked car, a wrong-way car, erratic humans: every car's x / z / heading / speed bits hashed each step). Two copies of js/ai.js that drive identically print identical lines (`AI_JS=old.js` for the other one); `warm=1` must print the same lines as without (the warm-up changes no driving) | ~12 s |
| `node devtests/ai-test/warmup.js [track=suzuka] [races=1] [sync=1]` | what `F1.AI.warmUp` buys: think()'s allocation in the first races of a fresh process (15 cars, quali + 5 laps), without and with the warm-up (sampling heap profiler, young garbage included). `sync=1`: `--no-concurrent-recompilation` (the sim runs ~170x real time: with background compiles the waits would cover far more calls than in the game) | ~1.5 min |
| `node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 devtests/ai-test/alloc.js suzuka 15 [races=1] [minutes=4] [warm=60] [sample=K]` | think()'s allocation per call in steady state: optionally real warm-up races, then `cars` computer cars with worn tyres and race contexts moved along the line, per-minute windows; `sample=K` lists the allocating functions from minute K on | ~1 min |
| `node devtests/ai-test/build-drivers.mjs [--js out.js]` | the two drivers of every car 2010..2026 from tools/seasons-raw.json (F1DB) -> `drivers.json` (names of the computer drivers) | 1 s |
| `node devtests/ai-test/critic-start.js` | the critic's start stress: 15 cars, standing start on the painted grid (random order, mixed levels) into the tight first corners of 12 circuits, 3 seeds, 2 laps: contacts (lap 1 / later; who ran into whom), pile-ups, R, stuck | ~45 s |
| `node devtests/ai-test/critic-obstacle.js [mode=parked\|wrong] [tracks=..] [v=1]` | a stream of 10 cars meets a car standing on the racing line (blind walled apex, hairpin exit, mid-straight, braking zone, across the road) and a car coming the wrong way (15 / 45 m/s; a kinematic ghost that never gives way: reported, not judged) | ~1 min |
| `node devtests/ai-test/critic-mixed.js [only=lapping,erratic,pit,wear,seasons,hairpin,determinism]` | lapping a backmarker, two erratic "humans" (brake tests, weaving, one blind), 10 cars stopping on the same lap, tyre wear x5, 2010 V8 vs 2026 cars, the Monaco hairpin (alone and 15 cars), the same race twice | ~50 s |
| `node devtests/ai-test/passing.js [seeds=1,2,3] [sc=B,C] [tracks=..] [list=1]` | matrix.js's races B (reversed grid) and C (15 cars, random grid, wear x4) on its 14 circuits with other seeds: passes, contacts (heavy, max; `list=1` every heavy one with the modes), offs, R, stuck, finishing order vs skill. Over several seeds a version comparison is not decided by one chaotic race | ~4 min per seed |
| `node devtests/ai-test/press.js [runs=24] [zone=280-345] [hold=12] [v=1] [trace=run:id1,id2[:from:to]]` | the field of gp-e2e/bots.js part pits on lap 1 (Monza 2026, the player's Ferrari stalled 12 s on pole, the 15 cars of `F1.AI.lineup` behind it in join order; run k shifts every seed by k): every contact, the ones at the first chicane apart, the striker and whether it had been pressing the car it hit (`ai.state.press`). Exit 1 on a chicane contact over 0.12 | ~0.4 s per run |
| `node devtests/ai-test/wrongway.js [v=8,15,40] [tracks=..] [pos=..]` | a kinematic car coming the wrong way along the racing line (never gives way) meets a stream of 8 computer cars on 5 circuits from 3 places: head-ons (heavy, summed severity), AI-AI contacts, pile-ups, R, wall hits per speed | ~1 min per speed |

`sim.js` is the reference implementation of the per-step loop the game needs (placements, views, contexts, think,
R, the frozen pit service and its events, car-to-car contacts, pit events, lap counter, session laps);
`critic-sim.js` is a second, independent harness with "actor" cars (parked, wrong-way, erratic, human) and contacts
attributed to the striker (`trace: {ids, from, to}` records both cars' decisions step by step; a car spec's `holdS`
is a stalled start, as bots-page.js's holdAfterGo); `sim.js` also returns its `res` (passes as they happen); `lib.js`
loads the modules.

## Review r3 fixes (2026-10-02)

Fable review round 3 found five problems in js/ai.js (evidence: `devtests/review-r3/ai`, `verify-ai`). Each one now has
a regression test in test/ai.test.js that fails on the old file. Decisions taken for the user (also for docs/v6-plan.md):
- AI-1, the pit lane limit: read live from `track.pit.limitKmh` every step and at every stop decision (G.pit.limitV is
  refreshed, `G.pitLoss` recomputed when the limit changed). Before, the limit was copied into the shared geometry
  once: after a season change at Zandvoort / Singapore the bots drove the lane at 78 km/h under a 60 limit (a 5 s
  penalty at every stop) or crawled at 55 under an 80 limit. Probe `review-r3/ai/yearscen.js` (real main.js): now
  57..58 km/h under 60, no speeding.
- AI-2, per-car memories (standing time, measured deceleration, in-path hold): an open-addressed table of 128 slots
  keyed by the full id (slots not seen for 5 s go to a new id; `reset()` empties it), not `id & 63`. Ids 66 and 2 used
  to wipe each other every step: a car parked on the line was never seen as stopped (queue, then R after 30 s). Probe
  `review-r3/ai/idcoll.js`: past it at 14.8 s, no R, for every id pair. Driving is bit-identical where ids are below 64
  (fingerprint.js).
- AI-3, passing: a car known to be slower (pace) is PRESSED on the straights (radius > 80 m at both cars): followed at
  0.3 of the time gap, its braking not anticipated as long as it brakes no harder than this car's own braking plan
  (harder - a brake test, a crash - is anticipated as before). The concede device counts pressure by TIME gap (within
  0.5 s / 28 m, let go beyond 1 s / 45 m - in metres the gap doubles down a straight). Attack fixes found while
  measuring: the side's room is measured at the other car's place (not this car's), the shut inside is given up for
  the open side, the car being passed is still checked on the path (where the two meet, where both are heading)
  until this car is alongside, and "beside it" leaves more room the faster it is gone by. Tried and NOT kept: the
  review's longer attack reach on the straights (40 + 0.3 v m: the attacker took the slow inside line from too far
  back, Spearman down to 0.2 at Bahrain) and pressing in corners too (Spearman 0.8 but four times the heavy contacts:
  the car in front turns in across the nose of one pressing close behind). Measured, old file -> fixed: matrix.js
  Spearman median 0.70 -> 0.78 (B 0.50 -> 0.64), passes 139 -> 174, contacts 5 -> 3, offs 36 -> 14; passing.js seeds
  1..3 (84 races) passes 342 -> 437, contacts 22 (2 heavy) -> 3 (1 heavy), offs 98 -> 48; race.js Bahrain 8 cars
  2025-standard reversed 6 laps seeds 1..3: Spearman -0.76 / -0.64 / -0.83 -> 0.57 / 0.57 / 0.40. Passing stays rarer
  than in real racing between cars 1..2 % apart (no slipstream in js/car.js).
- AI-5, giving room to a human: a car of unknown pace presses only while it has been seen to be quicker (closing the
  gap by 1.5 m/s over ~1 s while the bot is flat out, in the last 2 s), at half rate as before. A human sitting behind at
  the same pace is never let by (verify-ai/concede.js: 0 concedes at every level, was every 15..25 s); a quicker one
  still is (review-r3/ai/dbg1.js-like duels: 8 of 9 let by). The room given is unchanged: the edge, and
  max(its speed - 8 m/s, 78 % of the bot's pace) for up to 8 s - the stand-in for the slipstream js/car.js lacks.
- AI-6, a car coming the wrong way: the swerve aims beside where it WILL be when the two meet (on the racing line it
  follows the line - which swings across the road on the way), the side is chosen there, and it is taken on from
  50 m + 1.5 s of the closing at both speeds. wrongway.js, old -> fixed: 40 m/s head-ons 57 (52 heavy) -> 12 (10),
  pile-ups 14 -> 2; 15 m/s 23 (19) -> 3 (0), pile-ups 7 -> 0; 8 m/s 16 (13) -> 6 (5). verify-ai/wrong.js at 40 m/s:
  Monaco 19 contacts -> 6, Baku 7 -> 1, Spa 12 -> 3, Monza 2 -> 0. Tried and NOT kept (both made it worse against this
  ghost, which never stops): braking for it as for a car standing at the meeting point (40 m/s head-ons 57 -> 68) and
  twice the following gap under the yellow flag. Left: at 8 m/s in a Monaco street too narrow to pass, the bots stop
  and back off slower than the ghost comes on (5 light-to-medium hits, max 0.42); a human would stop too.
- critic-start (36 races of 15 cars) old -> fixed: contacts 12 -> 5, heavy 3 -> 1, offs 35 -> 13, one light pile-up
  (0.15 + 0.12 at Austria, lap 1) where there was none. critic-obstacle: hits on the obstacle 248 -> 57, AI-AI 51 (37
  heavy) -> 13 (1 heavy), R 35 -> 10 (the parked-car runs alone: 2 -> 4 light-to-medium hits, max 0.40 -> 0.32).

## The press follow-up (2026-10-02): never pressing into a car that brakes

Review r3 gained its passing by pressing a slower car: following it at PRESS_GAP of the time gap and not anticipating
its braking as long as it braked no harder than this car's own plan. The re-run found the price: on lap 1 at Monza's
first chicane (bots.js part pits) bumps of 0.16..0.20 in about 1 race in 5.

Reproduced first. gp-e2e/bots.js part pits with a contact dump (a scratch copy; the harness itself is unchanged), round
3's file: 7 of 40 runs touch at sample 316..319, 17.1 s after lights out, always the same pair - G. Bortoleto (legend,
Audi) and F. Alonso (0.98, Aston Martin): 0.158 (4x) and 0.203 (3x); HEAD d1decf6's file never did. In node,
`press.js` (the same field through critic-sim.js, the player's stall included) puts the same two cars into the same
side contact at 316..319 and 17.1 s: round 3 19 of 160 runs (max 0.34, 4 over 0.25), d1decf6 0 of 48, pressing off 0
of 48. The chain (`press.js trace=8:2,6,8,10:11:17.3`): R. Russell (amateur) concedes and is still giving room as it
brakes for the chicane; F. Colapinto presses it (P#2) and attacks into the braking zone, G. Bortoleto presses it too
from behind Colapinto; three cars arrive at the chicane together, Bortoleto at 15 m/s, 5..10 under its corner speed;
Alonso - not pressing, behind - takes that for "a car much slower right now", attacks it in the middle of the chicane
and they touch side to side. Pressed into the braking zone, the quicker car closes in on a car that brakes earlier, with
less in hand at the end of the zone than the relative law's FOLLOW_A (at 30 m/s a car brakes 3..5 m/s^2 harder than
the computer drivers' plans, not 7), so cars bunch at slow corners.

What js/ai.js does now (decisions taken for the user):
- the press is let go before the car pressed brakes: fully pressed while it is PRESS_T0 (2.5) s or more from where it
  must brake for a corner, not at all within PRESS_T1 (1) s of it, and not while it decelerates (PRESS_DEC0..1, 2..6
  m/s^2: a lift, braking for traffic, a brake test). "Where it must brake": the next local minima of this car's profile
  (a table per profile, `G.apex`) and a slower car's braking - PRESS_BRK 0.75 of this car's plan down to PRESS_VK 0.9 of
  its corner speeds - from this car's speed, minus the gap (`M.pRoom`, once per step, ~0.1 us);
- released, the gap is held: it goes towards the following gap but never by dropping back (a lift on the straight cost
  the quicker car metres before every braking zone) and never closer than it is (no closing in on a car that brakes);
  the car's braking is anticipated as anybody's (0.35 s of it) as far as this car does not brake as hard yet - braking
  with it, the gap held is the margin;
- the pass is set up for the braking zone instead (`stepRacecraft`): in that 2.5..1 s window a car known to be slower
  is attacked (a failed attack's cool-down notwithstanding) on the inside of the corner it brakes for (looked for 450 m
  on), the attack is not dropped for lack of progress until the corner, and it is given up when this car is not
  alongside by the turn-in (radius under PRESS_R here): the car in front has the corner, it is followed and tried again
  on the exit / the next straight. No attack on a moving car is started in a corner (unless alongside) nor within 2.5 s
  of a corner tighter than full lock (the Monaco hairpin test);
- `ai.state.press`: the id of the nearest car pressed (-1), for traces and the tests.
Two more changes found while measuring: a standing car is also looked for where this car's path is going (its offset on
the way to its target): a car going back to the line after a concede saw a car parked on the racing line 150 m on only
66 m before it at 48 m/s and hit it at 0.50 (critic-obstacle mx-1962 braking zone; now no hit there); and
`F1.AI.warmUp` drives a train of the 6 cars into the slowest corner (12 s, ~8 600 more think() calls, 0.1..0.25 s in
all) so that the racecraft branches are warm before the race.
Tried and not kept: the literal release to the normal following gap with the braking anticipated in full - no bump, but
the quicker car fell 20..30 m back in every braking zone, lost the pressure on the next straight, and the order from a
reversed grid fell below the old file's (120 races: B 0.23 against r3 0.60 and d1decf6 0.29; matrix passes 118, Spearman
0.62); keeping the press gap with full anticipation (B 0.48); pressing on into the braking zone with a corner-aware cap
(arrive a following gap behind it at its corner speed): 13 bumps in 160; a shorter / later release window (T0 1..2 s):
1..3 bumps in 160 and no more passes; an earlier concede (lerp 1.5..5.5 s) +0.05 on B only (not worth changing AI-5's
give-room character); no attack started in a braking zone at all: no gain.

Measured (final js/ai.js; round 3 = f925513's js/ai.js, d1decf6 = the file before review r3):
- the target: gp-e2e/bots.js part pits, 40 runs, 40 x 14 / 14 checks; no contact at the first chicane on lap 1 (round 3:
  7 of 40, 0.158..0.203; at the chicane only one 0.043 touch at 6..8 m/s, on lap 2). The pit-exit merge
  (lap 2, the whole field out of the lane at once, still in the exit taper with its stop planned, where none of the
  press / attack changes acts): light contacts 0.001..0.114 in 21 of 40 runs, round 3's file 0.04..0.097 in 13 of 40 - other race
  histories, never on the pit asphalt, under the 0.25 line. The full bots.js twice: 193 / 193 and 192 / 193 - part
  monaco's "no set past 93 % wear" (a soft set at 93.2 % at the flag); that check fails on round 3's file as well, in 2
  of 8 Monaco runs (0.936, 0.945; this file 1 of 8, 0.932): the stint plan's margin (W_PLAN 0.88) on softs at wear x2
  over three laps, not this change - left open.
- press.js, 160 runs: no contact at the chicane (round 3: 19, max 0.34). test/ai.test.js: 36 tests; the two new ones
  fail on round 3's file (its pits field bumps 0.16 / 0.16 / 0.31 / 0.32 in runs 8 / 16 / 26 / 39; with the press
  diagnostic added to it, it presses a car braking for the chicane for 42 steps).
- passing.js seeds 0..5 (matrix.js's races B and C on its 14 circuits, 168 races), d1decf6 / round 3 / now: passes 727
  / 959 / 1076; contacts 31 (10 over 0.25) / 16 (0) / 12 (1: 0.31, Bahrain C seed 2, a concede ending in the middle of
  the slow T10 with the car being let by on the outside); offs 220 / 112 / 38; finishing order vs skill, mean of the
  per-seed medians: all 0.573 / 0.668 / 0.667, B (reversed grid) 0.472 / 0.668 / 0.675, C (random grid) 0.598 / 0.685 /
  0.667. Per seed (all): round 3 0.69 0.72 0.55 0.77 0.68 0.60, now 0.62 0.76 0.65 0.69 0.71 0.57.
- matrix.js (seed 0 and race A): passes 115 / 166 / 187, contacts 6 (2 over 0.25, max 0.35) / 4 (0, 0.20) / 3 (0, 0.24),
  offs 30 / 23 / 4, Spearman median 0.74 (A 1.00, B 0.57, C 0.60) / 0.79 (1.00, 0.69, 0.71) / 0.72 (1.00, 0.57, 0.64) -
  one seed; over the six seeds above B is at round 3's level (0.675 / 0.668) and C 0.02 under it (0.667 / 0.685, the
  seeds spread 0.57..0.77). think() 2.41 us per call (round 3 2.51).
- critic-start (36 races of 15): contacts 2 -> 3, heavy 0 -> 0, max 0.13 -> 0.21, pile-ups 0, R 0, offs 11 -> 5.
  critic-obstacle parked (41 runs): obstacle hits 4 -> 4 (max 0.32 -> 0.39), AI-AI 9 -> 1, R 3 -> 8, no FAIL line
  either way; with PACE nudged by 0.001 (two nudges each) round 3 R 7 / 4 and a FAIL line each (a jam of 4 R at
  Singapore, a 0.45 hit), now R 5 / 6 and none - the jams and R counts move with any change (chaotic). Wrong-way ghost
  (22 runs, reported): hits on it 53 -> 43, AI-AI 4 (1 over 0.25) -> 6 (6), nudged 6 (6) / 3 (0) -> 7 (7) / 2 (2): the
  pile-ups behind head-ons with a car that never gives way. wrongway.js 8 / 15 / 40 m/s: head-ons 7 (6) / 3 (0) / 10
  (9) -> 6 (4) / 2 (0) / 13 (11), AI-AI 1 / 0 / 1 -> 2 / 0 / 1, pile-ups 2 / 0 / 1 -> 2 / 0 / 2. critic-mixed: the
  computer car the striker in 0 -> 2 of 34 -> 43 contacts with the erratic humans (max 0.21); 10 cars stopping on the
  same lap: every car served in its own box, lane top 78 / 80 km/h, nothing near the lane over 0.00 (Bahrain: two
  rear-ends on lap 1, 0.20 and 0.26, at T1 and T10, both from a "squeezed" car - none in round 3's run); wear x5 2..4
  stops, no puncture; the Monaco hairpin with 15 cars 0 contacts; deterministic.
- allocation: test/ai.test.js 1.49 B per call; alloc.js (suzuka 15, 5 minutes) per minute 271 / 10 / 21 / 1.1 / 0.62 B
  (round 3 284 / 9.8 / 20 / -1.1 / 0.62); warmup.js (sync) first race without the warm-up 170 -> 193 MB, with it 22.6 ->
  21.5 MB (the train in the warm-up: without it 36 MB). fingerprint.js: new driving (warm=1 prints the same lines);
  bridge.js and alltracks.js all ok; driving alone is unchanged (the press needs a car ahead): pace / calibration hold.

## The JIT (allocation) work of 2026-10-02

think() used to be one 26 KB-bytecode function. Each branch reached for the first time in optimised code (no type
feedback there) threw ALL of it back to V8's interpreter, braking scan and traffic loop included, which boxes every
number it computes: a first 15-car race allocated ~1.1 GB in think() (~900 B per call; the v6.2 critic's "75 MB in one
minute"), a second one ~240 MB. Found with `--trace-deopt-verbose` (exact source positions) and the sampling heap
profiler (warmup.js / alloc.js `sample=`). Fixed in js/ai.js:
- the step runs in phases, each its own function (place, book-keeping, traffic, racecraft, steer, speed + braking scan,
  pedals, recovery): a cold branch de-optimises one phase only; doubles pass between phases in an object of double
  fields, integers / objects / flags in closure variables (bit-identical driving: fingerprint.js);
- shapes that changed under V8's feet: `input` / `info.wearPerLap` / the contact snapshots started as small integers,
  `plan.outFrom` as null, `startLane` was a double in a closure variable, the steering-lock row table went from packed
  to holey; `ctx.prog` was copied into a variable that was a number or null (boxed at every call: ~16 B);
- the contact resolver emptied its arrays with `length = 0` (a new backing store per car per step): pooled now;
- `smooth()` / `lerp()` written out in the path helpers (a call not inlined boxes its argument and result);
- the tyre strategy runs once a lap at the start of the decision window (it ran every 6 steps through it);
- `F1.AI.warmUp(track, raceLine)`: a scripted 6-car session (~29 000 think() calls, ~0.1..0.5 s) for the loading
  screen, so V8 has seen nearly every branch before the race.
Result (warmup.js, sync compiles): first race 160 MB without the warm-up, 24 MB with it; later races 15..30 MB (pit
windows, V8 invalidations at session phase changes); steady state 1..2 B per call (alloc.js, test/ai.test.js).
Not ai.js (other owners): car.state's numeric fields start as small integers in js/car.js, so the first double stored
into each changes its shape and de-optimises every function that reads it (car.js, collide.js, ai.js) once.

## Measured 2026-10-02 (v6.2 steering law and track data, final js/ai.js)

- pace alone (calibrate.js, 10 circuits): rookie / amateur / pro / legend +8.02 / +5.03 / +2.50 / +1.00 % (PACE
  [[0,0.841],[0.35,0.89],[0.7,0.942],[1,0.977]]); pace.js (its 7 circuits, best lap) 7.05 / 4.63 / 2.27 / 0.86 %.
  Re-checked after review r3's track data (Silverstone's loop starting 151 m later, at the Wing's start line; Baku's
  heights x0.777): calibrate.js with this PACE 7.95 / 4.98 / 2.50 / 0.97 %; its re-solve [[0,0.84],[0.35,0.89],[0.7,0.941],
  [1,0.976]] gives 7.98 / 4.98 / 2.53 / 1.01 % - the same within the solver's 0.001 step, so PACE is kept; pace.js
  (no Silverstone / Baku) unchanged, 7.05 / 4.63 / 2.27 / 0.86 %.
- No pressing with a stop planned (the re-run stage after review r3, 2026-10-02): in gp-e2e/bots.js part pits (the whole
  field told into Monza's lane on lap 2) the cars leaving the lane in a queue pressed each other at the merge: bumps up to
  0.12 there in 2 of 14 runs, once a contact on the pit asphalt (a failed check); the old file 0.06 in 5 of 14. With
  `!plan` in the press condition: 0.065..0.097 in 5 of 14, none on the asphalt. fingerprint.js prints the same lines
  (monza8 with its 8 stops included), matrix.js the same numbers, critic-mixed pit 0 contacts either way. Then still
  open: pressing into the braking zone of Monza's first chicane on lap 1 gave 0.16..0.20 bumps in about 1 run in 5 (none
  with pressing off, none with the old file); one full bots.js run (before this guard) failed part pits with a 0.31 bump
  (over its 0.25 line). Fixed by the press follow-up below.
- Monaco hairpin: the profile's slowest point 49 km/h (was 25: js/ai.js now aims at the top of the full-lock range as
  js/raceline.js does); taken at 40.1 km/h (rookie) / 45.4 km/h (legend), steering 0.93..1.00, no wall, no grass;
  15 cars x 10 seeds: 0 contacts (the old file: 4) - no attack or defence through a corner tighter than full lock,
  5 m more following gap there.
- Suzuka bridge (bridge.js): 27 runs, cars as close as 0.8 m in plan (6.2 m apart in height): no contact, no level
  jump, driving identical to alone; a locate without the height would put the car on the other road 30..32 steps per
  pass.
- matrix (14 circuits x 3 races, 378 cars, 1246 race laps): every car finished, 0 R, 0 stuck, 0 pit-lane speeding;
  contacts 3 (none over 0.25, max 0.24); offs 33; passes 133; finishing order vs skill median 0.73 (A 1.00, B 0.50,
  C 0.62). The pre-update file on today's data: 6 contacts (1 over 0.25), 36 offs, 131 passes, 0.67.
- critic-start (36 races of 15 cars): 13 contacts (3 over 0.25, max 0.30), 0 pile-ups, 0 R (pre-update file today: 10,
  3 over 0.25, 1 pile-up); 72 races (seeds=6): 18 / 18 contacts, 0 / 2 pile-ups.
- critic-obstacle, parked car (41 runs, judged): 1 touch (max 0.11), AI-AI 6 (none heavy), 5 R, every run finished
  (pre-update file: 2 touches, AI-AI 14 with 2 heavy, 5 R). Wrong-way ghost (22 runs): 262 hits on the ghost (the
  pre-update file 246); swapping only PACE (0.001 per level) between the two files swaps these results (checked on 4
  circuits): chaotic sensitivity, not a code difference.
- critic-mixed: the computer car the striker in 2 of 44 contacts with the erratic humans (max 0.25); 10 cars on the
  same lap all served in their own boxes (lane top 77..78 / 80 km/h, no contact); wear x5: 2..4 stops, no puncture,
  never past 97 %; 2010 cars 0 % battery; deterministic.
- think() 1.7..2.2 us per call (matrix; the phase calls cost ~0.2 us), car.update ~0.8 us per step.
