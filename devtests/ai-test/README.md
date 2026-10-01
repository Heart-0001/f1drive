# devtests/ai-test: the computer drivers (js/ai.js) in node

Everything here runs the REAL game modules in node (js/car.js at 1/120 s, js/tyres.js, js/collide.js, js/pit.js,
js/laps.js, net/session.js; THREE only for the racing line's mesh). No Electron, no sound.
The unit tests are `node test/ai.test.js` (23 tests, a few seconds). `AI_JS=<path>` makes `lib.js` load another copy
of js/ai.js (A/B experiments).

| script | what it does | time |
|---|---|---|
| `node devtests/ai-test/matrix.js` | the scenario matrix: on 14 circuits a 4-car Grand Prix with qualifying, an 8-car race from a reversed grid and a 15-car race (random grid, tyre wear x4); finishing order vs skill, passes, contacts, offs, resets, stuck cars, pit stops, lap gap per level, CPU cost; `out/matrix.json` | ~1 min |
| `node devtests/ai-test/race.js track=monza n=15 laps=5 quali=2 grid=quali wear=3 skills=mixed year=2026` | one Grand Prix with the full classification table (`AILOG=1` prints every driver's event log) | seconds |
| `node devtests/ai-test/alltracks.js` | all 40 circuits: laps alone at skill 0 and 1, then a pit stop in box 7 (limiter, own box, tyre change, exit taper) | ~10 s |
| `node devtests/ai-test/pace.js tracks=monza,spa laps=4` | one car alone per level: lap times against the reference (the racing line's own margins driven perfectly), the keyboard calibration driver and the line's prediction | ~10 s |
| `node devtests/ai-test/calibrate.js` | solves `PACE` in js/ai.js (the pace factor per level) so that the median gap over 10 circuits is each level's `lapPct`. Re-run after ANY change to js/car.js physics, js/raceline.js or the track data, paste the printed table | ~30 s |
| `node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 devtests/ai-test/alloc.js monza 8` | think()'s allocation per call after only 1 min of warm-up (V8 needs 3..6 min of racing to settle think(): test/ai.test.js measures after 6) | ~10 s |
| `node devtests/ai-test/build-drivers.mjs [--js out.js]` | the two drivers of every car 2010..2026 from tools/seasons-raw.json (F1DB) -> `drivers.json` (names of the computer drivers) | 1 s |
| `node devtests/ai-test/critic-start.js` | the critic's start stress: 15 cars, standing start on the painted grid (random order, mixed levels) into the tight first corners of 12 circuits, 3 seeds, 2 laps: contacts (lap 1 / later; who ran into whom), pile-ups, R, stuck | ~40 s |
| `node devtests/ai-test/critic-obstacle.js [mode=parked\|wrong] [tracks=..] [v=1]` | a stream of 10 cars meets a car standing on the racing line (blind walled apex, hairpin exit, mid-straight, braking zone, across the road) and a car coming the wrong way (15 / 45 m/s; a kinematic ghost that never gives way: reported, not judged) | ~1 min |
| `node devtests/ai-test/critic-mixed.js [only=lapping,erratic,pit,wear,seasons,hairpin,determinism]` | lapping a backmarker, two erratic "humans" (brake tests, weaving, one blind), 10 cars stopping on the same lap, tyre wear x5, 2010 V8 vs 2026 cars, the Monaco hairpin, the same race twice | ~45 s |

`sim.js` is the reference implementation of the per-step loop the game needs (placements, views, contexts, think,
R, the frozen pit service, car-to-car contacts, pit events, lap counter, session laps); `critic-sim.js` is a second,
independent harness with "actor" cars (parked, wrong-way, erratic, human) and contacts attributed to the striker
(`trace: {ids, from, to}` records both cars' decisions step by step); `lib.js` loads the modules.

Measured 2026-10-01 (after the critic's fixes, with the v6.2 steering law and track data):
- matrix (14 circuits x 3 races, 378 cars, 1246 race laps): every car finished, 0 R, 0 stuck, 0 pit-lane speeding;
  contacts 10 = 0.8 per 100 car-laps (1 over 0.25, max 0.31; before the fixes 43, 5 over 0.25); offs 27 (77 before);
  on-track passes ~140..150 (197 before); finishing order vs skill Spearman median 0.74 (A 1.00, B reversed grid 0.55,
  C random grid 0.61; before 0.74 / 1.00 / 0.50 / 0.53).
- critic-start (36 races of 15 cars): 7 contacts (max 0.29), 0 pile-ups, 0 R (before: 41 contacts, 13 over 0.25, max
  0.71, 5 pile-ups).
- critic-obstacle, standing car (41 runs): 2 touches (max 0.11), R 5 in all, every run finished (before: hits up to
  1.0 - full speed -, 1080 R, whole fields stuck behind it for minutes). Wrong way: still head-on hits against the
  unstoppable ghost (about half of the earlier count).
- critic-mixed: the computer car was the striker in 4 of 36 contacts with the erratic humans (max 0.24); 10 cars on the
  same lap: all served in their own boxes, lane top speed 78 / 80 km/h, no contacts at the pit entry; wear x5: no
  puncture, never past 97 %; 2010 cars 0 % ERS; Monaco hairpin taken at 25 km/h without touching a wall; deterministic.
- alone: rookie / amateur / pro / legend +8.0 / +5.0 / +2.5 / +1.0 % median over the calibration's 10 circuits.
- think() 1.5..3 us per call; < 1 B per call once V8 has optimised it.
