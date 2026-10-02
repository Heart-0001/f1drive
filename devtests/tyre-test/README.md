# tyre-test — js/tyres.js against real stint lengths (2026-10-02)

The user's report (10-02): "為啥我拿RB19跑SPA 我才用x1 跑到第二圈一半我已經爆胎了??? 我沒撞欸" — the 2023 Red Bull
at Spa, tyre wear x1, a puncture halfway through lap 2 without touching anything (and before that, in qualifying:
"outlap 都還沒跑完 輪胎沒一半了"). Qualifying stays at x1 (the user agreed); x1 must feel like real F1.

## Root cause

Not an impact, not the new elevation / banking / Raidillon data, not the kerbs, the steering law, the carcass life or
`state.load` (js/tyres.js never reads it): in every stint below the tyres saw no impact before the cliff except real
wall contacts of the human-like driver, and none on the racing line. The puncture was the **worn-through** rule
(raw wear past the carcass life, 1.03..1.12) reached far too early, because of the **wear constant**: js/tyres.js was
calibrated to "a medium set lasts 15 laps of 5 km" (WEAR_K 3.9e-6) with a soft wearing **2x** — so a soft at Spa:

| RB19, Spa, wear x1, soft | cliff (75 %) | 100 % | puncture (worn through) |
|---|---|---|---|
| before: racing line (keyboard) | 3.1 laps | 3.9 | 4.0 |
| before: human-like keyboard | 2.7 | 3.4 | 3.5 |
| before: "sloppy" keyboard (keys at 10 Hz, 50 % too much steering) | 1.7 | 2.4 | **2.4 — the user's "second lap"** |
| before: js/ai.js / analog autopilot | 3.7 / 4.4 | 4.9 / 5.6 | |
| **after**: racing line | **14.5** | 18.5 | 18.6 |
| after: human-like | 13.1 | 16.4 | 16.5 |
| after: sloppy | 8.8 | 11.3 | 11.3 |
| after: js/ai.js / analog autopilot | 17.7 / 20.7 | 23.4 / 26.1 | |

Real Spa stints: softs 12..18 laps, mediums 20..30. Mediums after the fix: racing line 23.6 laps to the cliff (30.2 to
100 %), human-like 20.8, analog 33.3, js/ai.js 28.9 (before: 6.1 and 5.3 laps on the racing line / human-like). Sliding, the kerbs and the grass add
only 10..35 % (ablations below), overheating no more than that: the base rate was ~4x too fast.

## The fix (js/tyres.js)

- `WEAR_K` 3.9e-6 -> **1.0e-6**, compound wear **S 2.0 -> 1.65, H 0.5 -> 0.7** (real neighbouring Pirelli compounds:
  a soft lasts ~0.6 x a medium's stint, a hard ~1.4 x). The grip-vs-wear curve, the cliff, temperatures, dirt, impacts
  and punctures are unchanged.
- Flat spots only from lock-ups (sliding with the brake on, in proportion to the brake) and impacts: `FLAT_LAT`
  0.2 -> 0. With real-length stints the throttle-on slides of the human-like keyboard driver flat-spotted the tyres
  to 1.0 (the rear-left by lap 16, the front-left by lap 19 of a medium stint at Spa: constant vibration, 6 % less
  braking); now the worst is 0.16 at the cliff (lap 22).
- js/ai.js constants derived from the tyres: `WEAR_LAP0` = 1 / 260 km x 1.15 (a computer driver alone wears a medium set
  out in 230..290 km, measured with `ai` stints on 10 circuits), `COMPOUND_WEAR` = { S: 1.9 (1.65 + an overheating
  margin, as 2.4 was for 2.0), M: 1, H: 0.7 }.
- test/tyres.test.js: the stint / ratio expectations, and the regression "the user's case" (the real RB19 at Spa with the
  real js/car.js: soft cliff in 12..18 laps, medium 20..30, the human-like driver > 11, no puncture before the tyre is
  worn through, x3 = a third; it fails on the old model: cliff after 3.1 laps). test/ai.test.js: two expectations that
  encoded the old life (`startCompound(30, 1, 5000)` is now 'M'; the x5 stop test starts on softs for 10 laps).
- js/car.js untouched (the golden rule at wear rate 0 is unchanged; no recalibration of the seasons needed).

## Scripts (node, the real modules)

| Run | What | Time |
|---|---|---|
| `node devtests/tyre-test/repro-spa.js [line / human / sloppy / ap / ai] [S / M / H] [rate] [--car=2023-red-bull] [--track=be-1925] [--laps=N] [--ablate=slip,hit,grass] [--every=5]` | One stint until the puncture: per tyre every N s wear, temperature, flat spot, the second's max slip / grass / impact, tyre load (g), grip; then km to 50 / 75 / 90 / 100 %, the puncture (when, which tyre, worn through or impact, the last impact and what it hit), every impact (outer wall / pit wall / other, where, how hard). `--ablate` zeroes an input before the tyres see it (what each cause costs). | 1..5 s |
| `node devtests/tyre-test/laps.js [driver] [compound] [rate] [--car] [--track]` | The same stint, one line per lap: wear, flat spots, the lap's hottest tyre, seconds sliding / off the asphalt, impacts, grip, lap time (when the flat spots / overheating come). | 1..5 s |
| `node devtests/tyre-test/calib.js [--cars=..] [--tracks=re or all] [--drivers=line,human,ap] [--compounds=S,M,H] [--rates=1,2,3] [--workers=14] [--tag=v1] [--maxkm=700]` | The calibration matrix in parallel worker processes: every stint DRIVEN from a standing start until a tyre is worn through; `out/calib-<tag>.json` (git-ignored) + tables. Default cars 2010 Red Bull, 2014 Mercedes, 2023 Red Bull, 2026 Mercedes. | 15 min for the full 4320 stints (16 cores) |
| `node devtests/tyre-test/report.js [out/calib-<tag>.json]` | The markdown tables below from a matrix run. | < 1 s |

`drivers.js` (the library): `line` = the seasons calibration's keyboard driver (devtests/seasons-calib/driver.mjs: pure
pursuit on the car's own racing line, keys from the line's advice, battery on full throttle); `human` = the same driver
braking late (red >= 0.78), riding the kerbs (path 1.1 m wider at the edges: over the paint, which the game counts as
off the asphalt), 25 % more steering than asked (understeer slides); `sloppy` = keys decided at 10 Hz, 50 % too much
steering, brakes at red >= 0.85 (a bad keyboard lap: walls, slides); `ap` = the end-to-end analog autopilot
(devtests/gp-e2e/autopilot.js, pace 1, ~4 % off the line's pace); `ai` = js/ai.js alone ('pro').

Ablations, soft, wear x1, Spa, BEFORE the fix (km to 100 %): line 27.4 (no slip 27.8, no grass 27.4, no impacts 27.4);
human 23.7 (no slip 25.8, no grass 23.7); sloppy medium 31.8 (no slip and no grass 42.7). The base rate dominates.

## What else the 4320 stints say

- Punctures before the tyre was worn through: 11, every one from a wall impact of 0.47..0.62 (a real contact) past the
  cliff (the worst tyre at 75..100 %: a car on worn-out tyres running into a wall); none on the racing line or the
  analog driver before the cliff, none at all from kerbs, terrain, bridges or banking. No puncture "without contact".
- The racing line and the analog driver never touched a wall before the cliff; the human-like driver brushed walls
  (mostly < 0.3, the hardest 0.46) where it runs wide (Montreal, Magny-Cours, Monaco, Shanghai).
- Overheating (15 deg C over the window) before the cliff: never on the racing line / analog; 20 of 480 human-like
  stints. At the cliff the line's car slides (31 % less grip at 100 %), so the last lap runs hot - by design.
- Wear x2 / x3: km to the cliff x rate / x1 = 0.96..1.03 for every stint: the multiplier scales the stint exactly.
- Car generations: the work is weighed with the reference car's limits, so a car with less grip at its limit is
  charged a little more per km: 2026 cars ~20 % shorter stints than 2023, 2014 ~7 %, 2010 ~3 % longer.

## The computer drivers (js/ai.js) with the new tyres

- `node test/ai.test.js`: all pass (after the two expectations above).
- `node devtests/ai-test/matrix.js`: exit 0; 42 races, 1246 laps, Spearman 0.74, 4 contacts, 0 R / stuck; **0 pit
  stops** — race C (15 cars, 3 laps, wear x4) no longer needs one (a soft at x4 lasts ~4.5 laps of 5 km). The matrix
  no longer exercises race stops: the AI owner may want C at x5 over 8+ laps.
- `node devtests/ai-test/critic-mixed.js`: wear x5 / 10 laps: 0 punctures, 0 steps past 97 %, stops where needed
  (Silverstone 4 cars, Suzuka / Jeddah 2, Bahrain none: hards last 10 laps there at x5). One FAIL in `erratic`: at
  Baku a legend rear-ended the blind brake-testing "human" at 0.74 (the original model: no heavy AI strike). The race
  is chaotic (the grip now stays exactly 1 for the 5 laps at x1 where it used to drop a little after 20 %); the
  failure is the AI's following of a blind brake-tester: for the AI owner.

## Electron harnesses whose tyre checks assumed the old (fast) wear (not run here: a later stage re-runs them)

At wear x5 on Monza the end-to-end autopilot now wears a medium set ~8.4 % a lap (soft ~13.7 %), so after 2 laps the
most worn tyre is at ~17 % and the grip is still exactly 1 (no loss below 20 %); a medium wears through after ~11.4
laps, punctures after ~12 (measured: `drivers.js` 'ap', reference car / 2012 Red Bull). Before: ~35 % a lap. Softs at
x5 on the autopilot: ~14..17 % a lap (45..51 % after 3 laps from the start at Monza / Suzuka / Zandvoort with the
2012 and 2026 cars of solo-v6, ~55 % after 4, ~80 % after 6); hards ~7 %. The grip only drops below 0.97 from ~70 %
wear. Keep the checks' intent, move their setup:
- `devtests/v6-smoke/smoke.js` part `golden` (~l.408, v5 build only): "the slides left flat spots" after the flick —
  the flick has no brake, so since `FLAT_LAT` 0 it leaves none: expect none (the 1 cm path check is unaffected).
  Part `tyres` (~l.607 / 609, Monza, x5, medium, 2 laps): "+0.1 per lap" and `grip.lat < 0.97` after lap 2 fail —
  softs (T in qualifying) and ~6 laps, or the grip bar at the wear actually reached; the "new medium, grip 1 / 1 / 1"
  check after the stop (~l.612) then follows the compound fitted.
- `devtests/v6-critic/critic.js` part `tyres` (~l.319..328, Monza, R 8, x5, medium): "a puncture within 7 laps" — a
  medium needs ~12 laps now: softs, R ~12 and a loop of up to 11 laps (puncture at ~7..8); also ~l.340
  `t2.grip.lat === 1`. Its "full-lock stamp on the brakes" flat spot still holds (it brakes).
- `devtests/gp-e2e/solo-v6.js` (~l.632..636, hards, x5, R 6, the stop after `PIT_AFTER` 2): "most worn > 45 % at the
  stop" and "the grip drops by > 0.005" fail (hards at x5: ~7 % a lap) — `NEXT = 'S'` and `PIT_AFTER = 4` (3 laps
  give 45..51 %: too close to the bar); that takes two T presses (~l.451) and a cycle check (~l.534) that does not
  hard-code S -> M -> H.
- `devtests/README.md` rows of v6-smoke, v6-critic and solo-v6 describe the old numbers.

## Independent reproduction (a second copy of the tyre agent, 10-02 23:25..00:06, which changed no project file)

Its scripts stay here: `lib.js` (drivers `line` = the analog autopilot, `keys` = the calibration keyboard driver,
`kerb`, `human` (keys looked at `lookHz` times a second, so they pulse; late braking; `cut` m inside the line), `pad`
(the stick at `gain` x what the corner needs), `ai`; two shadow tyre sets fed the same loads without the slip / without
slip, hits and grass; `TYRES_JS=<copy>` loads another js/tyres.js, e.g. HEAD's: `git show HEAD:js/tyres.js >
devtests/tyre-test/out/head/tyres.js`), `spa-repro.js [line,keys,kerb,human,pad,ai] [--compound=S] [--laps=N]
[--seconds]`, `clean-lap-trace.js [S|M] [--every=N]` (a clean human-like lap per second) and `flat-understeer.js`
(the flat spots from understeer without the brakes: synthetic and closed loop). Its findings agree:

| % of a soft set per Spa lap, RB19, x1 | line (analog) | ai | keys | kerb | human 15 Hz | pad 1.5x |
|---|---|---|---|---|---|---|
| HEAD (before) | 17 | 20 | 24 | 26 | ~31 (worn through at lap ~3) | |
| after (`node devtests/tyre-test/spa-repro.js line,keys,kerb,human,pad,ai --compound=S --laps=6`) | 3.6 | 4.2 | 5.1 | 5.4 | 7.0 | 5.8 |

- Before, every human-like keyboard / pad stint on softs wore through at 263..322 s (2.3..2.8 laps), none from an
  impact; the whole cliff (75 % -> 100 % -> puncture) passed inside one lap at 30..45 % a lap, so the player had no
  usable warning (the vibration starts past 95 %). Now the cliff takes ~4 laps and the puncture comes 0.2..1.5 laps
  after 100 %.
- No spurious impacts: `state.hit` comes only from a wall face, the pit wall or `car.bump`; js/tyres.js reads neither
  `state.load` nor `state.compress` (Raidillon: +0.1..0.2 g); the only hits came from drivers cutting inside at La
  Source (d = +11, the inside wall, hit 0.13..0.27: flat spots at most).
- A clean human-like soft lap (keys at 20 Hz, 0.2 m inside) took ~29 % a Spa lap before, inside the temperature window
  (90..97 deg C): the base rate, not overheating. Sliding added ~10 %, grass / kerbs / hits ~4 %.
- Flat spots from understeer without the brakes (HEAD): 30 s at 150 km/h, slip 0.6, no brake: FL 0.31 / FR 0.80 /
  RL 0.13 / RR 0.34; the pad at 4x over 3 laps of softs: 1.00 / 0.95 / 1.00 / 0.95. Now 0 and what lock-ups leave.
- Still open (js/car.js, not the tyres): the painted kerbs lie outside the white line, and car.js counts `|d| > halfW`
  as grass, so riding a kerb costs grass grip (0.45), grass scrub and dirt. A few % of the wear here; a handling
  question for the car / track owners.

## Calibration tables (calib.js --drivers=line,human,ap --rates=1,2,3; 2026-10-02, tag v1: WEAR_K 1.0e-6, S 1.65, H 0.7, FLAT_LAT 0)

### Summary, wear x1: km to the cliff (75 %, 4 % grip lost) and to 100 % — mean over the 40 circuits (min .. max)

| car | driver | soft: cliff | soft: 100 % | medium: cliff | medium: 100 % | hard: cliff | hard: 100 % |
|---|---|---|---|---|---|---|---|
| '10 Red Bull | line | 93 km (72..115) | 121 km (93..151) | 152 km (118..188) | 197 km (151..246) | 215 km (165..266) | 277 km (212..349) |
| '14 Mercedes | line | 84 km (64..109) | 108 km (82..142) | 137 km (104..178) | 175 km (132..231) | 192 km (147..251) | 247 km (186..326) *1 |
| '23 Red Bull | line | 90 km (70..118) | 116 km (90..154) | 147 km (114..193) | 189 km (145..252) | 207 km (160..272) | 266 km (202..355) |
| '26 Mercedes | line | 72 km (53..94) | 91 km (67..120) | 116 km (85..153) | 147 km (107..194) | 162 km (119..214) | 204 km (148..270) |
| '10 Red Bull | human | 85 km (65..114) | 108 km (79..148) | 137 km (100..185) | 174 km (123..243) *1 | 191 km (132..262) | 243 km (164..343) *1 |
| '14 Mercedes | human | 73 km (46..104) | 91 km (54..133) | 116 km (70..169) | 144 km (83..215) | 159 km (96..237) | 199 km (115..300) |
| '23 Red Bull | human | 82 km (60..117) | 103 km (71..151) | 131 km (90..191) | 166 km (110..245) | 181 km (118..268) | 231 km (147..346) *1 |
| '26 Mercedes | human | 59 km (36..88) | 73 km (41..108) | 93 km (53..142) | 116 km (63..177) *1 | 127 km (74..196) | 157 km (87..240) |
| '10 Red Bull | ap | 129 km (97..155) | 167 km (125..201) | 209 km (156..251) | 269 km (201..325) | 292 km (218..352) | 376 km (281..456) |
| '14 Mercedes | ap | 127 km (93..161) | 162 km (119..206) | 204 km (149..261) | 261 km (191..332) | 283 km (207..364) | 362 km (265..465) |
| '23 Red Bull | ap | 133 km (101..164) | 171 km (130..213) | 215 km (161..266) | 275 km (207..344) | 299 km (225..372) | 383 km (288..481) |
| '26 Mercedes | ap | 116 km (85..150) | 149 km (109..192) | 187 km (136..242) | 238 km (174..310) | 259 km (190..338) | 330 km (241..431) |

(* n: n stints ended before that - a puncture from a wall impact past the cliff, listed below - or ran out of distance.) In laps of a 5 km circuit divide by 5.

### Per circuit, wear x1: laps to the cliff (75 %) — '23 Red Bull (S / M / H, and M to 100 %), the other cars on mediums, the human-like driver

| circuit | km | lap (s) | S | M | H | M 100 % | '10 Red Bull M | '14 Mercedes M | '26 Mercedes M | human S | human M | analog M |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Albert Park Circuit | 5.28 | 86.1 | 18.4 | 29.9 | 42.3 | 39.0 | 30.5 | 26.5 | 22.8 | 17.5 | 28.3 | 43.1 |
| Autódromo do Estoril | 4.17 | 73.5 | 18.4 | 29.8 | 41.7 | 37.4 | 32.1 | 28.5 | 24.1 | 14.3 | 21.5 | 42.6 |
| Autodromo Enzo e Dino Ferrari | 4.91 | 81.8 | 21.6 | 35.2 | 49.8 | 45.9 | 35.8 | 32.5 | 27.5 | 20.0 | 32.2 | 51.6 |
| Autódromo Hermanos Rodríguez | 4.30 | 80.6 | 25.6 | 41.9 | 58.9 | 54.2 | 42.5 | 39.1 | 33.1 | 23.9 | 38.3 | 61.8 |
| Autódromo Internacional do Algarve | 4.65 | 84.4 | 17.1 | 27.7 | 39.0 | 35.4 | 29.2 | 26.0 | 21.8 | 14.9 | 23.5 | 40.6 |
| Autódromo Internacional Nelson Piq | 5.04 | 83.9 | 14.0 | 22.7 | 31.8 | 28.9 | 23.9 | 22.0 | 19.3 | 12.6 | 19.8 | 32.2 |
| Autodromo Internazionale del Mugel | 5.25 | 84.9 | 15.3 | 25.0 | 35.1 | 31.8 | 25.8 | 23.3 | 19.8 | 14.3 | 22.9 | 36.3 |
| Autódromo José Carlos Pace - Inter | 4.31 | 75.8 | 18.2 | 29.4 | 41.5 | 38.0 | 31.0 | 27.6 | 23.0 | 16.6 | 26.6 | 41.5 |
| Autodromo Nazionale Monza | 5.79 | 84.6 | 20.5 | 33.3 | 47.0 | 43.4 | 32.5 | 30.8 | 26.3 | 20.3 | 33.0 | 44.2 |
| Autódromo Oscar y Juan Gálvez | 4.32 | 82.4 | 17.0 | 27.6 | 38.6 | 34.5 | 29.0 | 25.8 | 22.3 | 14.6 | 22.9 | 41.3 |
| Bahrain International Circuit | 5.41 | 96.0 | 19.2 | 31.2 | 44.0 | 40.4 | 32.5 | 29.1 | 24.5 | 17.2 | 27.4 | 46.4 |
| Baku City Circuit | 6.00 | 102.7 | 19.2 | 31.3 | 44.3 | 41.1 | 30.8 | 29.2 | 24.5 | 18.4 | 30.0 | 44.3 |
| Circuit de Barcelona-Catalunya | 4.65 | 80.0 | 16.3 | 26.5 | 37.3 | 34.2 | 28.3 | 25.4 | 21.6 | 15.5 | 24.8 | 37.7 |
| Circuit de Monaco | 3.33 | 80.5 | 27.9 | 45.6 | 64.6 | 59.4 | 49.1 | 42.8 | 34.7 | 23.1 | 37.2 | 73.9 |
| Circuit de Nevers Magny-Cours | 4.41 | 79.7 | 20.9 | 34.1 | 48.2 | 43.6 | 36.2 | 31.7 | 26.5 | 18.8 | 30.6 | 51.6 |
| Circuit de Spa-Francorchamps | 7.00 | 109.8 | 14.5 | 23.6 | 33.2 | 30.2 | 23.6 | 21.3 | 18.3 | 13.1 | 20.8 | 33.3 |
| Circuit Gilles-Villeneuve | 4.36 | 76.2 | 24.9 | 40.5 | 56.4 | 51.4 | 40.7 | 37.2 | 31.9 | 19.9 | 30.8 | 60.6 |
| Circuit of the Americas | 5.51 | 106.5 | 16.0 | 25.9 | 36.6 | 33.3 | 27.9 | 24.9 | 21.5 | 14.1 | 22.5 | 41.1 |
| Circuit Paul Ricard | 5.84 | 99.8 | 15.7 | 25.5 | 36.2 | 33.3 | 26.9 | 23.9 | 20.4 | 14.3 | 23.3 | 38.2 |
| Circuit Zandvoort | 4.26 | 74.2 | 16.5 | 26.9 | 37.7 | 34.3 | 27.6 | 24.5 | 20.1 | 14.9 | 23.9 | 37.9 |
| Circuito de Madring | 5.42 | 104.2 | 13.6 | 22.3 | 31.7 | 28.9 | 23.8 | 21.1 | 17.7 | 12.8 | 20.6 | 34.3 |
| Hockenheimring | 4.57 | 80.3 | 19.8 | 32.4 | 45.4 | 41.7 | 34.2 | 30.2 | 25.4 | 17.5 | 27.6 | 47.5 |
| Hungaroring | 4.38 | 83.7 | 18.4 | 30.0 | 42.1 | 38.3 | 32.6 | 28.7 | 24.1 | 16.3 | 26.1 | 45.6 |
| Indianapolis Motor Speedway | 4.19 | 67.9 | 17.9 | 28.9 | 40.7 | 37.2 | 29.0 | 25.9 | 22.5 | 16.0 | 25.4 | 39.0 |
| Intercity Istanbul Park | 5.34 | 91.6 | 16.0 | 25.9 | 36.6 | 33.1 | 27.6 | 24.6 | 21.2 | 14.4 | 23.2 | 36.6 |
| Jeddah Corniche Circuit | 6.18 | 96.2 | 15.0 | 24.5 | 34.6 | 31.7 | 25.0 | 22.3 | 18.8 | 14.3 | 23.1 | 34.7 |
| Kyalami Grand Prix Circuit | 4.53 | 79.2 | 18.5 | 30.1 | 42.4 | 38.6 | 31.4 | 28.1 | 24.1 | 16.2 | 25.6 | 44.3 |
| Las Vegas Street Circuit | 6.20 | 96.9 | 18.8 | 30.5 | 42.9 | 39.0 | 29.5 | 27.8 | 24.4 | 17.1 | 27.2 | 42.2 |
| Losail International Circuit | 5.38 | 89.7 | 13.6 | 22.2 | 31.2 | 28.5 | 23.3 | 21.2 | 17.9 | 12.7 | 20.4 | 31.8 |
| Marina Bay Street Circuit | 4.92 | 99.3 | 19.5 | 31.9 | 45.1 | 41.5 | 34.5 | 29.7 | 24.6 | 17.9 | 29.1 | 50.0 |
| Miami International Autodrome | 5.41 | 93.0 | 18.4 | 30.0 | 42.4 | 38.7 | 31.2 | 27.8 | 23.9 | 17.3 | 27.8 | 43.2 |
| Nürburgring | 5.15 | 95.7 | 17.9 | 29.0 | 40.9 | 36.8 | 31.0 | 27.1 | 22.9 | 14.7 | 23.0 | 44.1 |
| Red Bull Ring | 4.32 | 71.3 | 24.8 | 40.5 | 57.3 | 52.9 | 41.5 | 37.2 | 31.2 | 23.6 | 38.3 | 59.1 |
| Sepang International Circuit | 5.54 | 99.8 | 14.7 | 24.1 | 33.9 | 31.1 | 25.5 | 22.4 | 18.5 | 13.4 | 21.5 | 35.3 |
| Shanghai International Circuit | 5.45 | 99.5 | 16.1 | 26.2 | 36.9 | 33.7 | 27.8 | 25.2 | 21.9 | 14.2 | 22.5 | 37.7 |
| Silverstone Circuit | 5.89 | 96.2 | 14.3 | 23.4 | 32.9 | 29.8 | 24.2 | 21.8 | 18.6 | 12.7 | 20.2 | 33.7 |
| Sochi Autodrom | 5.85 | 104.1 | 16.2 | 26.5 | 37.4 | 34.1 | 27.0 | 23.5 | 20.2 | 15.5 | 25.0 | 40.4 |
| Suzuka International Racing Course | 5.81 | 96.9 | 14.0 | 22.9 | 32.4 | 29.2 | 23.8 | 21.0 | 17.8 | 12.8 | 20.5 | 34.5 |
| Watkins Glen International | 5.43 | 78.8 | 15.9 | 25.8 | 36.2 | 33.2 | 24.9 | 22.9 | 19.7 | 15.4 | 25.0 | 34.8 |
| Yas Marina Circuit | 5.28 | 93.0 | 18.5 | 29.9 | 42.2 | 38.3 | 32.1 | 28.1 | 23.8 | 16.8 | 27.1 | 44.9 |

### Wear multiplier: km to the cliff at xN times N, against x1 (all stints of every car / driver / compound / circuit)

| rate | stints | (km to 75 %) x rate / x1: mean | min | max | punctures before 100 % |
|---|---|---|---|---|---|
| x1 | 1440 | 1.000 | 1.000 | 1.000 | 7 |
| x2 | 1440 | 1.000 | 0.972 | 1.025 | 4 |
| x3 | 1440 | 0.999 | 0.962 | 1.031 | 0 |

### Punctures before the tyre was worn through: 11 of 4320 stints

| car | circuit | driver | set | rate | at (laps) | wheel | cause | wear | the impact |
|---|---|---|---|---|---|---|---|---|---|
| '14 Mercedes | ar-1952 | line | H | x1 | 44.09 | RL | impact | 98 / 81 / 77 / 67 | outer wall 77 km/h, hit 0.62 (d 11 m, wall 12) |
| '10 Red Bull | ar-1952 | human | H | x1 | 41.51 | FL | impact | 99 / 80 / 81 / 70 | outer wall 124 km/h, hit 0.584 (d 11 m, wall 12) |
| '23 Red Bull | ar-1952 | human | H | x1 | 36.16 | RL | impact | 91 / 76 / 69 / 62 | outer wall 83 km/h, hit 0.599 (d -11 m, wall 12) |
| '26 Mercedes | ca-1978 | human | H | x1 | 43.22 | RL | impact | 100 / 81 / 77 / 64 | outer wall 48 km/h, hit 0.475 (d 11 m, wall 12) |
| '10 Red Bull | ca-1978 | human | M | x1 | 41.2 | FL | impact | 97 / 77 / 95 / 82 | outer wall 58 km/h, hit 0.466 (d 11 m, wall 12) |
| '26 Mercedes | ar-1952 | human | M | x1 | 18.52 | FR | impact | 87 / 75 / 57 / 52 | outer wall 103 km/h, hit 0.59 (d -11 m, wall 12) |
| '10 Red Bull | ca-1978 | human | H | x2 | 29.35 | FL | impact | 99 / 79 / 98 / 83 | outer wall 50 km/h, hit 0.504 (d 11 m, wall 12) |
| '23 Red Bull | ar-1952 | human | H | x2 | 18.51 | RL | impact | 94 / 78 / 72 / 64 | outer wall 86 km/h, hit 0.606 (d 11 m, wall 12) |
| '26 Mercedes | fr-1960 | human | H | x2 | 18.69 | RL | impact | 100 / 92 / 74 / 66 | outer wall 61 km/h, hit 0.619 (d -11 m, wall 12) |
| '23 Red Bull | ar-1952 | line | S | x1 | 21.49 | FR | impact | 100 / 85 / 84 / 74 | outer wall 84 km/h, hit 0.604 (d 11 m, wall 12) |
| '23 Red Bull | ar-1952 | human | M | x2 | 14.07 | RL | impact | 100 / 83 / 77 / 67 | outer wall 122 km/h, hit 0.606 (d 11 m, wall 12) |

### Up to the cliff (75 %): flat spots, overheating, impacts

- line: largest flat spot at the cliff mean 0.00, max 0.20; stints with a tyre 15 deg C over its window before 75 %: 0 / 480; wall impacts before the cliff: 0 in 480 stints
- human: largest flat spot at the cliff mean 0.39, max 1.00; stints with a tyre 15 deg C over its window before 75 %: 20 / 480; wall impacts before the cliff: 846 in 480 stints
- ap: largest flat spot at the cliff mean 0.00, max 0.00; stints with a tyre 15 deg C over its window before 75 %: 0 / 480; wall impacts before the cliff: 0 in 480 stints

