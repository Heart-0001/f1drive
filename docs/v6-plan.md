# F1Drive v6 — overnight plan and live state

Owner of this file: the orchestrating Claude session. It is the durable memory of the run: read it first after any
interruption, keep the "State" table current, and continue from the first stage that is not done.
The user is asleep (from about 2026-10-01 00:30 local) and asked, in their words: do not stop, keep working towards the
goal; on waking they want either a complete `dist/F1Drive.exe` or the work still visibly in progress; all permissions
needed are granted. Do not wait for the user; decide sensible defaults and record them under "Decisions".

## Goal

`dist/F1Drive.exe` containing everything below, verified, then an independent Fable review, fixes, final repackage.

1. v5 (done, being end-to-end tested): gamepad wired, Grand Prix mode (qualifying -> grid -> race -> results), lap counter.
2. v6 (contract: `js/README-interfaces.md`, section "v6 additions"):
   sound (own + nearby engines, clearly audible gear changes) · battery / ERS (key E) · broadcast-style telemetry graphic
   in the bottom centre (speed, gear, rpm, throttle, brake, battery, tyres, limiter) · seasons 2010..2026 with each
   team's car from real data, year chosen for the room / Grand Prix, everybody picks a car of that year · detailed
   first-person cockpit (3 styles: no halo / halo / halo + 18-inch wheels), remote cars only get liveries · pit lane on
   every track with light curtains at entry and exit, pit limiter (key Q), stop in your box -> random-duration tyre
   change, tyre wear of several kinds, compounds S / M / H (key T) · volume / mute (key M).

## Stages

| # | Stage | How | State |
|---|-------|-----|-------|
| A | v5 polish + autopilot end-to-end (solo, online) + fix | workflow `f1drive-v5-e2e` (run wf_61df0403-f8f) | DONE 01:40: online 135/135, solo 580/580, smoke 196/196, ui-gp 117/117, mp-e2e 30/30, node suites green; 4 defects fixed (race clock, timing box after the flag, room texts, pad Start) |
| B | `js/audio.js` author + critique | workflow `f1drive-v6-audio` (wf_0431b855-826) | DONE 02:2x: worklet + node fallback, 367/367 offline checks, live 50/50, asar 4/4; the critic ALSO implemented the v2 contract (setEngine, play(pitgun/jack/limiterOn/Off), others[].spec, V8 vs V6 by cylinders, upshift crack, limiter stutter, flat-spot slap), so no separate audio v2 run is needed. WAVs for the user: devtests/audio-test/out/worklet/*.wav (git-ignored, 287 MB). Not listened to by anyone yet (measured only). |
| C | 2026 cars hand research -> `js/cars-data.js`, `devtests/cars-data/`, `docs/cars-data-sources.md` | workflow `f1drive-v6-cars-data` (wf_a630de1b-658) | DONE 01:3x: 11 teams + standard, fact-checked, 1.23 % spread driven; note: Haas / Racing Bulls / Cadillac are all mainly white -> minimap / HUD dots should use two colours (fill colour, ring colour2) |
| D | seasons 2010..2026 raw data: `tools/build-seasons.mjs`, `tools/seasons-raw.json`, `tools/eras.json`, `tools/liveries/*.json` | workflow `f1drive-seasons-data-2010` (wf_0d40c5aa-081) | DONE 02:0x: 17 seasons, 180 entries (F1DB v2026.15.1, CC BY 4.0), era index 2010..2026 (2025 = 1), eras.json fact-checked, liveries 2010-2017 / 2018-2026 fact-checked. Raw-data corrections still to apply in stage F: 2019/2020 Racing Point engine designation M10 EQ Power+ / M11 EQ Performance; display names 2010 BMW Sauber, 2011 Lotus (Team Lotus), 2016 Manor (MRT); full chassis names (F1 W05 Hybrid ...); Toro Rosso lineage is 紅牛二隊 in both livery files |
| E | v6 modules, parallel file owners (after A): track.js pit lane · car.js (spec, drivetrain, ERS, limiter, tyres hook, pit wall) + gamepad.js · tyres.js · pit.js · audio.js v2 (after B) · cockpit.js + carmodel.js · net stack (car, year, wear) + gp.js · telemetry.js · ui.js + index.html | workflow `f1drive-v6-modules` (run wf_d49591ea-dd9, launched 01:42) | DONE ~03:25: track pit lane 40/40 (Monaco entry 22 m after the line), tyres, pit, telemetry, net year/car/wear, cockpit 3 styles, carmodel.setLivery, car.js (golden rule bit-identical over 134k steps; ERS 32 s store, +16..20 km/h per straight; limiter; pit wall fuzzed 39M steps), gamepad RB/B LB Back, ui.js + index.html v6. Owners' reports: scratchpad car-report.txt, ui-report.txt, e1-reports.txt. Extra: scenery-vs-pit DONE |
| F | seasons builder: `js/seasons-data.js` + `js/cars.js` from C + D, era physics calibrated against the pace index with the real car model; `raceline.js` takes perf (after E's car.js, C, D) | workflow / agent | DONE ~04:40: js/seasons-data.js (17 seasons, 180 cars + standard per season), js/cars.js (Map lookups, sanitised to car.js ranges), tools/build-cars.mjs (deterministic, --check), raceline perf; calibrated on all 40 circuits, champions fastest or 2nd, rank correlation 0.95..1.00; 9 node suites green. Limits: circuit-to-circuit scatter ~1 %, 2026 ERS speed taper not modelled. Report: scratchpad seasons-report.txt |
| G | main.js + electron-main.js glue, Electron smoke of every feature | workflow f1drive-v6-glue (wf_7f774cc7-65a): glue agent, then an integration critic | DONE ~06:20: glue (v6-smoke 129/129, app-check 7/7) + critic (v6-critic 83/83; 9 defects fixed incl. the J0 leftovers setHalo / syncMute / bump, puncture + pit-exit toasts, rev in neutral while held, readable hint chips); all suites green. Open: box 1 inside the exit curtain at Las Vegas / Monaco (added to stage H fix) |
| H | end-to-end: update `devtests/gp-e2e` (solo + online) for v6, new pit / tyre / year scenarios, fix loop | workflow f1drive-v6-e2e (wf_f1d4d7c9-b43) | DONE ~10:40: solo 588/588, solo-v6 295/295 (2012 KERS + 2026 ERS, wear x5, one-stop races, speeding penalty), online 141/141, online-v6 65/65 (password room, 2014, three cars in the lane at once), v6-smoke 129/129, gp-smoke 197/197, ui 117 + 124, mp-e2e 30/30, all node + devtests suites; fixed: box vs curtain clearance (PIT_BOX_MARGIN 12 m; Monaco entry 14 m after the line), Monaco gantry vs curtain, refused lap shown as best lap, car card name wrap; harness windows proven silent (Windows mixer, 49 min) |
| I | `npm run dist`, launch the exe, smoke it (remote-debugging port), screenshots | orchestrator | not started |
| J0 | EARLY Fable review pass 1 of the stable modules (multiplayer / driving model / world + visual spot-check of 12 unvisited tracks / sound + graphics), each finding verified by an independent Opus agent; NO fixes in the run | workflow `f1drive-fable-review-1` (wf_83c1d2a6-190), launched ~03:30 in parallel with F | multiplayer / driving / media verified (15 real, mostly minor; scratchpad j0-confirmed.json); their fixes run in workflow f1drive-j0-fixes (wf_2d87efd2-7fc) since ~04:45 in parallel with G (disjoint files); world verified ~05:00: 5 real (banking synthetic — no real banked corners; COTA / Monaco / Las Vegas elevation; pit-building texture stacked; kerb paint on the pit taper; groundY beside the pit) -> workflow f1drive-world-fixes (wf_24e3e0cc-046): track data + track.js, scenery.js, then RE-CALIBRATION of the seasons data (track change invalidates it) |
| J | Fable review (independent: code + requirements, not conclusions; scope = everything since v1 incl. v6; visual spot-check of scenery on tracks nobody looked at; multiplayer protocol hardening) -> adversarial verification -> fixes by file owners -> all suites -> final `npm run dist` | workflow (reviewers `model: 'fable'`) | running: workflow f1drive-fable-final (wf_64daa6f3-2d9) since ~10:45 |
| K | docs: `CLAUDE.md` state section, `docs/claude-memory/`, README contract notes, `devtests/README.md` | orchestrator | not started |

Stage E's workflow script is already written: `%TEMP%\claude\C--Users-Heart-Desktop-f1Drive\c2c193e6-e2b5-4b48-8955-beed8746e07e\scratchpad\wf-v6-modules.js`
(launch with `Workflow({scriptPath, args: {audioReady: <true once stage B has finished>}})`; when `audioReady` is false the
audio v2 agent is skipped and must be run afterwards with the `audioPrompt` of that script). Before launching E: read
stage A's fix report, re-run the node suites, update the row above.

Stage F's workflow script is written too: `...\scratchpad\wf-v6-seasons.js` (same folder). Launch it when stage E's car.js
agent has finished, with `args: {carNotes: "<the car.js owner's apiNotes + summary as text>"}`.

Stage G's workflow script: `...\scratchpad\wf-v6-glue.js`; launch after F with `args: {notes: "<E + F owners' apiNotes /
openIssues relevant to main.js, as text>"}` (the E first-half notes are summarised under "Notes for stage G" below).

Stage H's script: `...\scratchpad\wf-v6-e2e.js` (running). Stage J's script (final Fable review -> verify -> fixes by
file group -> full re-run): `...\scratchpad\wf-fable-final.js` — launch when H has finished; afterwards: npm run dist,
devtests/exe-smoke/smoke-exe.js on dist/win-unpacked/F1Drive.exe, docs (stage K).

Order constraints: E needs A finished (same files are under test). F needs E's car.js plus C and D. G needs E and F.
Never run two agents that own the same file at the same time; heavy Electron harnesses disturb the real-time online test.

## Notes for stage G (main.js glue) from the module owners

- pit: call pit.update with the frame dt also while the car is frozen for a service (else it never ends); reset() at every session placement; events enter / exit / speeding / serviceStart / serviceDone / serviceAbort; boxAhead for the HUD.
- tyres: F1DB-independent; rate 0 = exact reference; car.js must cope without F1.createTyres.
- cockpit: cockpit.setCar(spec, profileColour) on car / colour change; cockpit.setSources({car, lap}) after each new lap counter; expose F1.game.cockpit for tests.
- carmodel: model.setLivery(colour, colour2, accent) instead of setColour for remote cars.
- track: call track.update(performance.now() / 1000) each frame (curtain pulse).
- telemetry: 520 x 156 CSS px bottom centre; it overlaps the in-car wheel display (accepted: user asked for the centre); hint line must move.
- net: host sends setYear on connect / when the year changes; car in setProfile; 'year' event; gp.start({q, r, year, wear}); ids from the wire must be looked up as own properties only.
- EARLY FABLE FINDINGS to honour in G (pending verification): the lap clock must keep running while the car is frozen for a
  pit service (a stop costs time; freezing lap.time would make pit stops free) — keep calling lap.update with speed 0 /
  add dt, but not on the grid (lap not armed yet); carModel.setLivery allocates on every call — call it only on change.
- From F: show F1.cars.attribution.f1dbShort next to the OSM credit + the disclaimer; own car = F1.cars.resolve(ui.getCar(), year); CarSpecs are frozen shared objects (copy before changing).
- From the J0 fix run (in parallel with G): an optional room password is being added to the server / js/net.js (create / join take it) — G adds the password field to the multiplayer panel; car.bump(strength) (new) must be called after car-to-car contacts (resolveCarCollisions contacts and applyCarImpulse) so tyres see impacts.
- For F / the fix stage: spec.traction caps top speed (the reference car is 0.4 m/s^2 below its 11 m/s^2 traction cap at
  330 km/h), so a traction multiplier below ~0.965 lowers top speed regardless of power — check F's multipliers.
- 2026 / minimap: three 2026 liveries are mainly white -> two-colour dots (fill colour, ring colour2) on minimap / standings.

## Leftovers to apply right after G (from the J0 fix run, ~05:25; full text scratchpad j0-fix-report.txt)

- electron-main.js: mute while minimised / hidden — `const syncMute = () => { if (!win.isDestroyed()) win.webContents.setAudioMuted(win.isMinimized() || !win.isVisible()); };` on 'minimize', 'restore', 'hide', 'show' (backgroundThrottling:false means the page never learns it is hidden).
- main.js: `var ch = collide ? F1.resolveCarCollisions(...) : 0; if (ch > 0) car.bump(ch);` — LOCAL contacts only, never for reported impacts (a hostile client could puncture others).
- main.js: remote models `model.setHalo(!spec || spec.cockpit !== 'modern')`.
- ui / main: optional room password (net.create(port, {password}), net.join(address, {password}); error codes 'password', 'wait', 'idle'); the lap report now carries `at` (gp.lapDone does it).
- Optional: a mirror on/off setting (cockpit.setMirrors); objects with userData.mirror = false stay out of the mirrors.
- Contract (stage K): car.bump, state.hit wording, track.pit.paved, cockpit.setMirrors / info().mirrors / COCKPIT_HALO, carModel.setHalo, traction cap note (47 of 197 cars capped 0.07..7.6 km/h, calibrated with it), password / idle / 'not-driven' / 'no-data' reason codes, gl.at.

## Decisions to mention in the morning (from G)

- Fresh install defaults to 2025 / the 2025 standard car (= the v5 car); one constant START_YEAR in main.js if the user prefers 2026.
- ERS from a standing start is strong (+37 km/h after 8 s at Monza): deploy is limited by tyre friction, not the traction cap that holds the car without boost; tunable in car.js.
- Limiter switched off at every placement; a car change in free practice refills the battery; pit-lane ghosts drawn translucent; M works while driving (the 設定 tab in the menu); the next compound is not remembered between runs.

## More decisions from the G critic

- Puncture toast and pit-exit limiter reminder; the engine revs in neutral while held (grid / box) up to 90 % of the shift rpm; a car change is allowed while held in the box in free practice; Esc pauses a service (online too); the limiter stays on after R; free practice keeps tyre wear x1 (a hard hit can puncture).

## Decisions taken for the user (tell them in the morning)

- Seasons 2010..2026 (user's correction). Each season also has a `<year>-standard` car (equal-car races); the 2025
  standard car is the calibration anchor = the v5 reference car.
- Keys: Q pit limiter (toggle), E battery (hold), T next tyre compound, M mute. Controller: LB limiter, RB or B battery,
  Back next compound.
- Tyre compounds soft / medium / hard; Grand Prix option "tyre wear x1..x5".
- Speeding in the pit lane = 5 s extra hold at that stop (no time penalty in the protocol). Cars in the pit lane are ghosts.
- Car numbers are estimates derived from public data (F1DB, CC BY 4.0, credited in the menu); the menu says so.
- No DRS and no 2026 active aero (not requested).
- Nothing is committed or pushed (the user has not asked); ask in the morning.

## Morning of 10-01

- 08:04 the user woke up; got the summary and 5 questions (default year, ERS strength, pad mapping, 紅牛二隊, commit / push) — NOT answered; the user went out again (~08:20) and said to carry on alone as last night. Until they answer: keep the current choices (2025 default, ERS as is, pad mapping as is, 紅牛二隊) and do NOT commit / push.
- 08:10 the user heard engines from the speakers: the offscreen harness windows played sound. Stage H stopped, Electron killed, devtests/electron-userdata.js now mutes every harness (SOUND=1 to hear one), ui-gp/shots.js muted too; stage H resumed (testers restarted). Every prompt now says: all Electron windows muted.
- 08:20 keep-awake restarted for 16 h (pid in tools/watchdog-out/keepawake.pid).
- ~10:40 stage H DONE; ~10:45 final Fable review (stage J) launched.
- ~12:10 stage J: 34 confirmed findings (R in the pit lane skips the lane, pit speeding unpunished without a stop, ERS bypasses the traction cap / no 2026 taper, seasons uncalibrated with the battery, Monaco start at Casino Square, Electron 33 EOL, no CSP, renderer crash handling, portable exe self-extract, ...). Fixers done except data; the net fixer moved package.json to Electron ^44.5.1 (+ icon, electronLanguages zh-TW / en-US, js/cars-data.js no longer packaged) and I ran npm install at ~12:40 (installed 44.5.1). The re-run stage verifies everything on 44.

## User answers, 10-01 ~11:30 (v6.1)

1. Default year -> 2026 (START_YEAR in main.js; harnesses that rely on the 2025 reference car must select it explicitly).
2. Battery: every car should have its own data -> per-car ERS (deploy / harvest / store multipliers 0.75..1.15, and NO battery for the 2011-2013 cars that raced without KERS) from tools/ers-data.json (research running), applied by tools/build-cars.mjs + js/cars.js (allow per-car ers null, wider ERS range).
3. Gamepad: put the functions on A B X Y. Chosen: A = battery (hold), B = pit limiter (toggle), X = next compound, Y = reset; View / Back = racing line; Menu / Start = menu; RB = battery too, LB = limiter too; RS click = recentre.
4. 紅牛二隊: OK.
5. Commit only, no push (the user wants to change more) — committed locally as bb5591c at ~11:30 (review-final scratch excluded).
6. NEW: two small HUD rear-view mirrors at the top-left and top-right of the screen (js/hudmirrors.js, prep running), with a setting / key to hide them.

Prep DONE ~12:00: tools/ers-data.json + docs/ers-data.md (168 cars; 5 no-KERS cars 2011-2012; Mercedes 2014-16 strongest, Honda 2015 weakest; deploy/harvest REPLACE perf.ersPower/ersHarvest; widen sanitising to 0.75..1.15; lower the ratings.ers gain to ~3-4) and js/hudmirrors.js + devtests/hudmirrors-test (33/33; layout A: mirrors in the top corners, timing box / minimap / session box moved down under them; +0.45..0.6 ms; exact main.js / index.html edits in scratchpad mirrors-report.txt). Plan: after the final review finishes -> v6.1 integration workflow (script ready: scratchpad wf-v61.js; launch when the final review incl. its fixes + re-run has finished) (build-cars + cars.js ERS, gamepad remap, START_YEAR 2026, HUD mirrors in main / ui / index, harness updates for the default year and the pad map) -> full re-run -> npm run dist -> exe smoke -> docs -> local commit.

## Watchdog (asked for by the user)

- `node tools/watchdog.mjs` — exit 0 moving, 2 an agent has been silent for more than 25 min, 3 nothing is running.
  Writes `tools/watchdog-out/status.md` (readable summary) and appends to `tools/watchdog-out/log.txt`.
  Workflow ids listed in `tools/watchdog-out/ignore.txt` are treated as finished.
- `tools/keepawake.ps1` runs detached (pid in `tools/watchdog-out/keepawake.pid`, 16 h) so Windows does not sleep.
- A session cron job fires a "watchdog tick" prompt every 20 minutes while the session is idle: run the watchdog; on a
  stall read the agent's transcript tail to see why (hung command, waiting on a dialog, API errors), stop the workflow
  (TaskStop) and resume it from its run id (finished agents are cached), or relaunch the stage; on "nothing running"
  start the next stage of the table above.
- Orphaned Electron processes older than 45 min are reported; kill them only when no harness is supposed to be running.

## Log (newest last)

- 09-30 19:32 cloned; 19:42-21:52 v5 modules + main.js glue (workflow f1drive-v5-implement): all node suites green,
  gp-smoke 171/171.
- 09-30 21:55 trial `npm run dist` OK (72 MB).
- 09-30 22:28 polish pass done (grid boxes, menu toasts, lights for spectators, ui init order).
- 10-01 00:05 seasons research restarted for 2010..2026 only.
- 10-01 00:45 watchdog + keep-awake + this plan in place.
- 10-01 01:3x stage C done (2026 cars). 01:40 stage A done. 01:42 stage E launched (audio v2 skipped: stage B still in its critique).
- 10-01 02:0x stage D done. 02:2x stage B done (includes audio v2). ~02:40 stage E first half done; scenery-vs-pit fix launched. ~03:20 scenery-vs-pit DONE. ~03:25 stage E DONE. ~03:27 stage F launched. ~03:30 early Fable review pass 1 launched. ~04:40 stage F DONE (9 node suites green). ~04:45 stage G + J0 fixes launched in parallel. ~05:00 early review done (20 real findings in total); world fixes + recalibration launched. ~05:25 J0 fixes DONE (anti-cheat lap proof, impact limits, room password + idle drop, track-then-start, race-time latency; audio hidden-page; live rear-view mirrors +0.2 ms; remote halo; car.bump; ers sanitising) — leftovers for after G listed below. ~05:50 G glue DONE. ~06:20 G critic DONE (all J0 leftovers wired). ~06:30 world fixes + recalibration DONE (real banking at Zandvoort / Indianapolis / Jeddah / Madring; lidar elevation for COTA, Monaco, Las Vegas, Suzuka, Zandvoort ...; all 17 seasons back on their index). ~06:35 stage H launched; v6 preview build from snapshot 3b749ff (not on any branch; worktree scratchpad/v6build): 07:47 dist/F1Drive-v6-preview.exe, packaged-exe smoke 18/18 incl. 17 seasons, pit lane, spec / tyres / battery, telemetry canvas, worklet audio running (nothing over the lane on 80/80 builds, pit building behind the garage face, curtains visible; identical output where pit is null). Until stage F writes js/seasons-data.js + js/cars.js the real game shows the missing-script overlay (index.html already references them) — expected.
- 10-01 01:45 interim build of the verified v5 tree (snapshot commit 0dbd9c8, not on any branch; detached worktree in the scratchpad: v5build) -> dist/F1Drive-v5-GrandPrix.exe; packaged-exe smoke devtests/exe-smoke/smoke-exe.js 13/13 (menu, host API, drive, Esc, Grand Prix quali from the panel, grid lights, no page errors). The stale 21:55 trial build was removed from dist/.
