# devtests/ai-test: the computer drivers (js/ai.js) in node

Everything here runs the REAL game modules in node (js/car.js at 1/120 s, js/tyres.js, js/collide.js, js/pit.js,
js/laps.js, net/session.js; THREE only for the racing line's mesh). No Electron, no sound.
The unit tests are `node test/ai.test.js` (29 tests, a few seconds). `AI_JS=<path>` makes `lib.js` load another copy
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

`sim.js` is the reference implementation of the per-step loop the game needs (placements, views, contexts, think,
R, the frozen pit service and its events, car-to-car contacts, pit events, lap counter, session laps);
`critic-sim.js` is a second, independent harness with "actor" cars (parked, wrong-way, erratic, human) and contacts
attributed to the striker (`trace: {ids, from, to}` records both cars' decisions step by step); `lib.js` loads the
modules.

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
