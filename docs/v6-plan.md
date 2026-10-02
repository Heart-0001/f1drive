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
| I | `npm run dist`, launch the exe, smoke it (remote-debugging port), screenshots | orchestrator | done per release from clean worktrees (v6.1 18/18, v6.2 18/18, v7.0 22/22, see "GitHub release"); the round 3 build is still to do (see "Remaining steps" at the end) |
| J0 | EARLY Fable review pass 1 of the stable modules (multiplayer / driving model / world + visual spot-check of 12 unvisited tracks / sound + graphics), each finding verified by an independent Opus agent; NO fixes in the run | workflow `f1drive-fable-review-1` (wf_83c1d2a6-190), launched ~03:30 in parallel with F | multiplayer / driving / media verified (15 real, mostly minor; scratchpad j0-confirmed.json); their fixes run in workflow f1drive-j0-fixes (wf_2d87efd2-7fc) since ~04:45 in parallel with G (disjoint files); world verified ~05:00: 5 real (banking synthetic — no real banked corners; COTA / Monaco / Las Vegas elevation; pit-building texture stacked; kerb paint on the pit taper; groundY beside the pit) -> workflow f1drive-world-fixes (wf_24e3e0cc-046): track data + track.js, scenery.js, then RE-CALIBRATION of the seasons data (track change invalidates it) |
| J | Fable review (independent: code + requirements, not conclusions; scope = everything since v1 incl. v6; visual spot-check of scenery on tracks nobody looked at; multiplayer protocol hardening) -> adversarial verification -> fixes by file owners -> all suites -> final `npm run dist` | workflow (reviewers `model: 'fable'`) | DONE ~13:50: workflow f1drive-fable-final (wf_64daa6f3-2d9): 34 confirmed findings fixed (pit-lane R / speeding exit-line hold, ERS traction-limited + 2026 fade, recalibration WITH the battery, Monaco start / grid / pit on the harbour straight via OSM start-finish node, Zandvoort pit 80, Singapore 60, CSP, crash handling, icon, Electron 44.5.1); re-run all green on Electron 44 (11 node suites, v6-smoke 133, critic 85, gp-smoke 197, ui 117 + 124, solo 588, solo-v6 295, online 141, online-v6 65, mp-e2e 30, track / pit / scenery / audio). Committed locally e02cf43 |
| K | docs: `CLAUDE.md` state section, `docs/claude-memory/`, README contract notes, `devtests/README.md` | orchestrator | DONE 2026-10-02 (docs stage of review round 3): contract v6.1 / v6.2 / v7 / r3 sections, every harness in devtests/README.md, this file, CLAUDE.md |

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
- ~13:50 stage J DONE, committed e02cf43 (local). ~13:55 v6.1 workflow launched (wf_7e983c92-8d1): per-car ERS, pad ABXY, default 2026, HUD mirrors, critic + full re-run. Then: npm run dist, exe smoke, CLAUDE.md / docs, local commit.

## User answers, 10-01 ~11:30 (v6.1)

1. Default year -> 2026 (START_YEAR in main.js; harnesses that rely on the 2025 reference car must select it explicitly).
2. Battery: every car should have its own data -> per-car ERS (deploy / harvest / store multipliers 0.75..1.15, and NO battery for the 2011-2013 cars that raced without KERS) from tools/ers-data.json (research running), applied by tools/build-cars.mjs + js/cars.js (allow per-car ers null, wider ERS range).
3. Gamepad: put the functions on A B X Y. Chosen: A = battery (hold), B = pit limiter (toggle), X = next compound, Y = reset; View / Back = racing line; Menu / Start = menu; RB = battery too, LB = limiter too; RS click = recentre.
4. 紅牛二隊: OK.
5. Commit only, no push (the user wants to change more) — committed locally as bb5591c at ~11:30 (review-final scratch excluded).
6. NEW: two small HUD rear-view mirrors at the top-left and top-right of the screen (js/hudmirrors.js, prep running), with a setting / key to hide them.

Prep DONE ~12:00: tools/ers-data.json + docs/ers-data.md (168 cars; 5 no-KERS cars 2011-2012; Mercedes 2014-16 strongest, Honda 2015 weakest; deploy/harvest REPLACE perf.ersPower/ersHarvest; widen sanitising to 0.75..1.15; lower the ratings.ers gain to ~3-4) and js/hudmirrors.js + devtests/hudmirrors-test (33/33; layout A: mirrors in the top corners, timing box / minimap / session box moved down under them; +0.45..0.6 ms; exact main.js / index.html edits in scratchpad mirrors-report.txt). Plan: after the final review finishes -> v6.1 integration workflow (script ready: scratchpad wf-v61.js; launch when the final review incl. its fixes + re-run has finished) (build-cars + cars.js ERS, gamepad remap, START_YEAR 2026, HUD mirrors in main / ui / index, harness updates for the default year and the pad map) -> full re-run -> npm run dist -> exe smoke -> docs -> local commit.

## User feedback 10-01 ~14:30 (after playing the preview build)

- 2023 Red Bull feels strong (good).
- Monaco: the slowest hairpin cannot be taken even at 20 km/h. Measured: Monaco's tightest centreline radius is 9.4 m (sample 631, s 1262 m), while the car's minimum turning radius is 10.0 m at 10 km/h, 10.5 m at 20, 13.3 m at 45 km/h, because js/car.js reduces the steering lock with speed from standstill on (lock = 0.35 / (1 + (v/22)^2)). Real F1 cars take it at ~45-50 km/h with full lock using the whole width. TODO after v6.1: give full lock at low speed (keep the reduction only where it matters, e.g. above ~70 km/h), check against the real hairpin geometry, update the golden oracle (devtests/car-v6/car-v5.js) and recalibrate (calibration fingerprints car.js).
- Battery: 'does it really never run out?' — explained (2014-2025 real cars may deploy 4 MJ = ~33 s per lap; Monaco has little full throttle and lots of braking, so running out there is rare even in reality; 2026 empties in ~11 s). The preview exe they played predates the final review's ERS fixes (traction-limited deploy, 2026 fade). Possible follow-up if wanted: the real per-lap deploy limit (KERS 400 kJ, ERS 4 MJ) shown in the HUD.

## More user feedback 10-01 ~14:40 -> v6.2

- Banked corners (Madring, Zandvoort) do not feel pronounced; Spa's steep climb is not felt visually; Monaco tunnel wanted; "re-check the data of ALL circuits".
- Running in parallel with v6.1 (research / new files only): f1drive-v62-prep (wf_637f2699-28a: Monaco tunnel module js/tunnels.js + data; steering-lock + banking analysis on copies) and f1drive-track-audit (wf_009442b9-534: 8 regional auditors + a perception analyst + verification -> tools/track-audit.json, docs/track-audit.md).
- User 10-01 ~14:50 asked for no tyre wear in qualifying, then (~14:55, after hearing qualifying is already fixed at x1 since the final review) said: KEEP qualifying at x1 — no change. Still to do: the pad's compound choice is not discoverable -> show it: pit strip / telemetry "下一組 M（T / X 切換）", a prompt on entering the pit lane, hints, and a starting-compound choice in the Grand Prix panel.
- After v6.1: v6.2 integration = steering law (Monaco hairpin), banking / slope presentation, Monaco tunnel (+ lighting + reverb), the verified track-data corrections via tools/build-tracks.mjs, recalibration, full re-run; then dist + exe smoke + docs + local commit.

## PAUSED 2026-10-01 15:10 (user's weekly usage full; they are updating Claude and will say "continue")

Stopped on purpose: workflows f1drive-v61 (wf_7e983c92-8d1), f1drive-v62-prep (wf_637f2699-28a), f1drive-track-audit
(wf_009442b9-534); the session cron watchdog tick; the keep-awake helper; leftover Electron / Overpass processes.
Workflow run ids only resume inside the SAME Claude session: after a restart, relaunch from the scripts copied to
docs/agent-runs/2026-10-01/scripts/ (agent reports in docs/agent-runs/2026-10-01/reports/; dump-journal.js reads a
workflow journal).

State of the tree: e02cf43 = last fully verified commit; on top of it a WIP commit with the paused v6.1 work. At pause:
11 node suites pass, build-cars --check passes, the game boots and drives; Electron harnesses NOT re-run.

v6.1 stream (script wf-v61.js; stages: Modules -> Glue -> Critic):
- Modules DONE: per-car ERS (tools/ers-data.json applied in tools/build-cars.mjs + js/cars.js, regenerated
  js/seasons-data.js, test/cars.test.js; devtests/seasons-calib/ers-effect.mjs), gamepad ABXY (js/gamepad.js,
  devtests/gamepad-test incl. game-map.js).
- Glue PARTIAL (stopped while adapting devtests/hudmirrors-test/run.js): js/main.js / js/ui.js / index.html edited
  (START_YEAR 2026?, HUD mirrors + V key + setting, hints) and many harnesses edited (gp-e2e, gp-smoke, ui-gp, ui-v6,
  v6-critic, v6-smoke) for the default year / pad indices — verify each against the task text before trusting.
- To resume: re-run the Glue stage's task on the current tree (it is idempotent: check what is already done),
  then the Critic stage (play + full re-run).

v6.2 prep (script f1drive-v62-prep.js): js/tunnels.js was being written (partial); devtests/tunnel-test/;
devtests/handling-test/ (steering-lock + banking analysis on copies; big ref dumps git-ignored). Relaunch both
agents (they create new files only) or fold them into the v6.2 integration.

Track audit (script f1drive-track-audit.js): stopped while fetching OSM / DEM data — devtests/track-audit/ has
caches (git-ignored cache/) and partial notes per region, no per-circuit results. Relaunch as is.

Then: v6.2 integration (steering law, banking / slope presentation, Monaco tunnel + lighting + reverb, pad compound
visibility, verified track-data corrections, recalibration ~22 min), full re-run, npm run dist, exe smoke, docs,
local commit (no push).

## RESUMED 2026-10-01 (after the usage reset)

- The user said "continue" (usage reset). Relaunched from the repo copies: wf-v61-resume.js (Glue + Critic on the WIP tree; run wf_a659accd-b86), f1drive-v62-prep-resume.js (tunnel + handling; wf_4f87d153-d3d), f1drive-track-audit-resume.js (wf_4089d207-948). Watchdog cron re-created. .claude/scheduled_tasks.lock untracked + ignored.

- User asked "isn't Suzuka missing?": it is there (jp-1962, 'Suzuka International Racing Course', 38th of 40) but the menu shows / searches English names only, so 鈴鹿 finds nothing. DONE ~17:30: js/track-names-zh.js (40 circuits, Taiwan usage checked by a second agent: e.g. 鈴鹿賽道, 蒙札賽道, 霍肯海姆賽道, 銀石賽道; 243 search aliases incl. mainland forms; report docs/agent-runs/2026-10-01/reports/track-names-zh.txt). Its location field holds the Chinese country (日本 鈴鹿) — the English country names still have to be added at integration; v6.2 integration: load it in index.html, show the Chinese name on the cards, search Chinese + aliases + English. The user searched "japan" (the data only has the city "Suzuka"): the search must also match the COUNTRY in English and Chinese (Japan / 日本, Italy / 義大利, United States / USA / 美國 ...) — add an English country (+ common short forms) per track id next to the Chinese data.

## Unattended run 2 (user away on a business trip for 1+ day, from 2026-10-01 ~16:30)

The user asked: keep working on your own until it is finished. Keep-awake restarted for 60 h. Remaining pipeline, in order:
1. v6.1 DONE ~20:10 (glue + critic: v61-critic 98/98, every suite green; light curtains kept out of the mirrors; reports v61-glue.txt / v61-critic.txt) — committed 58f0ac0 (local).
2. v6.2 prep DONE ~18:40 (reports docs/agent-runs/2026-10-01/reports/tunnel-report.txt, handling-report.txt): js/tunnels.js + tools/tunnels.json (Monaco 368 m tunnel with the sea-side colonnade + Fairmont portal, Portier, Monza underpass, Madring 2 tunnels, Singapore 2 passages, Yas W hotel bridge; 4 draw calls; reverb impulse F1.tunnelImpulse; exact main.js / audio.js integration steps in the report); steering law ready as diffs in devtests/handling-test/variants/ (perf.steerLockAt: never below 1.25x mechanical grip, max 0.40 rad = 8.5 m radius, bank-aware; Monaco hairpin 47-52 km/h like reality, all 40 tracks clean, -47 s total; raceline / build-cars / calib driver / golden oracle diffs; then recalibrate) + cues (head keeps 45 % of the roll, compression eye-sink / nod for banking and Spa dips). Track audit (wf_4089d207-948), Chinese track names (wf_0c4323e7-f4c) finish.
3. Track audit DONE ~18:50 (docs/track-audit.md, tools/track-audit.json: 33 major findings, 32 fully + 1 partly confirmed — e.g. Spa Raidillon only 3-5 % in the game vs 15 % real (GLO-90 + tree canopy), 6 phantom scenery bridges over the road, Silverstone start / pits on the pre-2011 straight, start lines off at Hungaroring / Sepang / Shanghai, Albert Park / Estoril / Madring geometry, Baku castle width, Suzuka crossover levelled flat, derived banking up to 6 deg everywhere). v6.2 integration DONE ~23:00 (run wf_6d7b5834-24a; all reports docs/agent-runs/2026-10-01/reports/v62-reports.txt): critic found no defect in the v6.2 features (Monaco hairpin 14/14 runs keys + pad at 20-50 km/h, tunnel light + reverb, Raidillon reads as a climb, banking +34 / +39 km/h vs flat, Suzuka bridge both roads, Silverstone Wing, 26 searches, pad compound prompt, FOV, pit limits by season); all 12 node suites, build-cars --check, every node devtest and all 25 Electron harnesses green. Open: Raidillon taken at 222-250 km/h (real ~300, physics unchanged); docs rows for the new harnesses (docs stage).1 critic has finished. v6.2 integration workflow: steering law (Monaco hairpin drivable, Zandvoort / Madring banking felt), slope / banking presentation (perception findings), Monaco tunnel (js/tunnels.js + lighting + reverb), visible pad compound choice (pit-lane prompt, telemetry / pit strip, GP starting compound), Chinese names + country search on the cards, the verified track-data corrections (tools/track-audit.json via tools/build-tracks.mjs), recalibration (~22 min), harness updates; then a player-eyes critic.
- v6.2 stage 1 DONE ~21:20: steering law + cues + Suzuka height-aware locate + tunnel reverb (physics); Spa Wallonia lidar CC-BY 4.0 (Raidillon +14.2 % / 50 m, range 102.1 m), IGN MDT05 Barcelona / Madring, Emilia-Romagna Imola, Tuscany Mugello, TINITALY Monza (+5 m dip), USGS Miami, GLO-30 Interlagos / Sepang / Portimao, START_AT Silverstone Wing / Hungaroring / Sepang / Shanghai, per-season pit limits (track); cockpit: head keeps 45 % roll / 50 % pitch, compression cue, FOV 60 (setFov 50..75), lens shift keeps the wheel display above the telemetry. Notes for AI integration: js/ai.js must pass the car height to locate (Suzuka bridge); Monaco hairpin grip with the 1.5 deg street bank cap to be checked by the critic.
3b. AI computer drivers (user request ~16:35: "add computer players; in the room choose how many and how strong"; overrides v5's "no AI"): brain js/ai.js DONE ~21:40 (wf_ccc80dcc-32f author + critic; report docs/agent-runs/2026-10-01/reports/ai-report.txt: 4 levels +8 / +5 / +2.5 / +1 %, 42-race matrix 10 contacts, 40/40 circuits clean, think() ~2 us, alloc-free; critic fixed rear-ends, hidden stopped cars, stuck queues, pit-lane rubbing, tyre planner) -> integration script READY docs/agent-runs/2026-10-01/scripts/wf-ai-integrate.js, launched right AFTER the v6.2 run finishes (it shares main.js / ui.js / build-cars with v6.2) -> integration workflow after / with v6.2: offline (AI players in the local session, local car instances, carmodel liveries of that season, collisions), online (the HOST simulates the bots: server-side bot players owned by the host, batched bot states, bot laps through the proof-of-driving checks, host-leave behaviour), room / GP panel controls (count 0..16-humans, skill level), names from the season's drivers, end-to-end races with AI (solo + online).
4. Fable review round 3 of everything changed since e02cf43 (independent; verify each finding; fixes by file group; full re-run). DONE 2026-10-02: see "Fable review round 3 — outcome" at the end.
5. npm run dist; node devtests/exe-smoke/smoke-exe.js dist/win-unpacked/F1Drive.exe; read a few screenshots. (v6.1, v6.2, v7.0 done; the round 3 build: TODO)
6. Docs: CLAUDE.md state, README contract, devtests/README, docs/claude-memory; local commit (NO push). Docs DONE 2026-10-02; since 10-01 ~22:00 the user wants verified rounds pushed and released (see "GitHub release"): commit, push, release TODO.
If the usage limit stops the agents: stop everything cleanly, record the exact state here and in CLAUDE.md, commit WIP locally, and wait.

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


## GitHub release (user request 10-01 ~22:00: "最後好了幫我丟github吧 讓我筆電可以玩 或是你現在先丟一版目前最新的release上去 我想玩")
- DONE ~22:05: pushed main (a4eff5c..c50dc5a) and published release v6.1 (prerelease) with F1Drive-v6.1.exe (96 MB), built from a clean worktree of c50dc5a (the verified v6.1), exe smoke 18/18 PASS. https://github.com/Heart-0001/f1drive/releases/tag/v6.1
- User 10-01 ~22:15 played v6.1 Suzuka: the crossover is a flat crossroads (known: audit finding, fixed in v6.2 as a real bridge, 6.22 m apart, 5.18 m clearance). Decision: as soon as the v6.2 critic + full re-run is green -> commit, build from a clean worktree, exe smoke, push, release v6.2 (prerelease) BEFORE starting the AI integration, so the user can play the fixes now.
- DONE ~22:40: v6.2 committed dd08276, pushed, release v6.2 (prerelease) with F1Drive-v6.2.exe (clean worktree build, exe smoke 18/18, Chinese names in the packaged menu). https://github.com/Heart-0001/f1drive/releases/tag/v6.2
- AI integration decisions (owners + glue, ~01:00): bots set by the host (bots {n, skill, list}), owned by the host connection, laps via gl with id, no gone message on removal, +4 msg/s per owned bot; offline gp assigns ids 2..16 and republishes standings every 500 ms; drivers = the 2 with most starts in that car (Latin names), standard car Alex Rowan / Sam Ellery (never used by bots); defaults 0 bots, level 職業; with bots offline the player starts in grid box 1 (also qualifying); bots return to their boxes after a session; lineup seed = season year; bots keep the first racing line; AI warm-up at load only with bots (Monaco load 846 ms vs 328); 15 bots = +0.6 ms per frame, 60 fps at Monaco / Spa. Known: a bot behind a player parked on pole in free practice waits up to ~16 s at Monaco before going round.
- DONE ~04:20: v7.0 committed 766a0e1, clean worktree build, exe smoke 22/22 (new v7 checks: 5 bots from the 大獎賽 tab, grid, race start, standings), pushed, release v7.0 (prerelease) https://github.com/Heart-0001/f1drive/releases/tag/v7.0. Fable round 3 RUNNING since ~04:25 (run wf_07a7593a-444, script wf-fable-r3.js; the usage limit hit ~05:30 and reset ~06:10: the world reviewer was restarted by the workflow, the scratch of its first attempt is in devtests/review-r3/world/; 6 areas reviewed + verified before that: 32 findings, 23 confirmed, none critical); all 7 areas done ~06:45: 30 confirmed (7 major: bots keep a stale pit limit after a season change, AI per-car memory keyed by id & 63 collides in rooms, faster bots cannot pass slower ones (trains), js/net.js __proto__ snap row from a hostile server, Silverstone grid wraps round Club, missing attribution of the 6 new elevation sources, + minors / cosmetics incl. the static red gantry lamps, external links dead in the exe, README contract gaps) -> fixers DONE ~07:30 (media: tunnel IR cached per size; world: Silverstone loop from the Wing line node 13036050130 (16 boxes on the straight, pit right side 80), Baku range scaled to 26.8 m, Toscana labelled photogrammetric DSM, Suzuka verge under the deck, gantry lamps dark + a lamp mesh API; ui: 9 fixes incl. pit limit on a season change in the lane, bot join toasts, X站 / X大獎賽 search, credits for the new elevation sources, bot impulses deferred, bot lap rejection; net: __proto__ snap rows dropped, dedicated server: the bots leave as DNF and the race goes on, credit links open in the browser (https allow-list); ai: live pit limit, full-id memories, passing reworked, concede only to faster humans, wrong-way handling). Re-run DONE ~09:00: recalibrated (17 seasons within 0.03 %, team order unchanged), AI PACE kept (7.95 / 4.98 / 2.50 / 0.97 %), gantry lamps + tunnel IR priming hooked into main.js, bots.js ram / host parts updated, every suite and harness green (review/escape.js 203 = pre-existing v1 script counting pit lanes); bots do not press while a stop is planned. OPEN trade-off: pressing a slower car into Monza T1 braking zone on lap 1 bumps in ~1 run in 5 (0.16-0.20) -> follow-up workflow docs/agent-runs/2026-10-01/scripts/wf-ai-press.js after the docs stage, then dist / smoke / commit / push / release. (Earlier note) Cross-file leftovers to check after the re-run: main.js hookup of the gantry lamps (scenery setStartLights) and of the tunnel IR priming (audio.setTunnel(0, w, h)), devtests/gp-e2e/bots.js host part (new dedicated-server rule) and ram part (times out with the new AI); afterwards: dist from a clean worktree, exe smoke, commit, push, release (final v7.x).
- Plan after the AI critic: commit, clean build + exe smoke, push, release v7.0 preview (AI drivers) so the user can play it; then Fable round 3 (docs/agent-runs/2026-10-01/scripts/wf-fable-r3.js: 7 Fable reviewers flow / ai / multiplayer / driving / world / media / product, verifiers, fixers by file group, re-run, docs) -> dist + exe smoke -> commit, push, release.
- AI integration DONE ~03:30 (run wf_76c677c2-d76; reports docs/agent-runs/2026-10-01/reports/ai-integrate-reports.txt): new harness gp-e2e/bots.js 193/193 (Monza + Monaco 15 mixed bots, online host + guest + 6 bots, Suzuka bridge, pit lane with 16 cars, blue flags, host leaving), all 82 suite / harness runs green. Net decisions: host leaving removes his bots (review r3 MP-2, 2026-10-02: they leave a running session as any leaver: quali / grid out, race DNF; the humans race on; was: the session ended); a human joining a full room in free practice takes the newest bot seat; room level default pro; bot names max 16 chars; protocol stays v1. Critic fixes: creep past stopped cars (field by in 9 s at Monaco), per-seat skill kept when a human joins, botViews cleared. Open: gap column after pit stops can look out of order (pre-existing), ai.pace is not a lap-time prediction. -> Fable round 3 over everything since e02cf43 -> docs -> dist + exe smoke -> commit, push, release.
- At the end of this run: after v6.2 + AI + Fable round 3 + full re-run + dist + exe smoke: commit, push main, tag v6.2 (or v7), publish a release with the exe and Traditional Chinese notes.

## Fable review round 3 — outcome (2026-10-02)

Run wf_07a7593a-444 (script `docs/agent-runs/2026-10-01/scripts/wf-fable-r3.js`): 7 Fable reviewers (flow, ai,
multiplayer, driving, world, media, product) over everything since e02cf43 (v6.1, v6.2, v7.0), each finding checked by a
second agent, fixes by file group (ui, net, ai, world, media), a full re-run, then the docs. Probes and evidence:
`devtests/review-r3/`. 39 findings, **30 confirmed** (verifier severity: 6 major, 17 minor, 7 cosmetic), 9 refuted
(DRV-3 remote scrub, PRES-3 hemisphere overshoot, PRES-4 lens shift after a resize behind the menu, PRES-5 compression cue
too small, PKG-1 "無 does not remove the bots", PKG-4 standings DOM churn, AI-7 R completing a lap, AI-8 strategy at high
wear, MP-4 rate budget). Nothing critical.

| Id | Sev. | Finding | Fix (file) |
| --- | --- | --- | --- |
| AI-1 | major | bots kept a stale pit-lane limit after a season change (Zandvoort / Singapore): a penalty at every stop | the limit read live from `track.pit.limitKmh`, the stop's time cost recomputed (js/ai.js); main.js rebinds the bots' js/pit.js |
| AI-2 | major | per-car memories keyed by `id & 63`: colliding ids in rooms hid a stopped car (queue, then R after 30 s) | keyed by the full id (128-slot table) (js/ai.js) |
| AI-3 | major | faster bots could not pass slower ones: trains, the order from a reversed grid ~ the grid | pressing a known-slower car on straights + four attack fixes (js/ai.js): matrix Spearman 0.70 -> 0.78, passes 139 -> 174, contacts 5 -> 3 |
| MP-1 | major | a hostile server's snap row `"__proto__"` polluted `Object.prototype` and killed the guest's game | snap rows need a numeric id of an own remote (js/net.js) |
| W1 | major | Silverstone's grid wrapped round Club (line at the OSM finish node) | the loop starts at the Wing's start line, node 13036050130; pit lane right side, 80 km/h (tools/build-tracks.mjs, tracks-data.js) |
| W2 | major | the six new elevation sources (CC BY 4.0 / Copernicus) were not credited | 設定 → 資料來源與授權 lists every source with its licence and address (index.html) |
| FLOW-1 | minor | a season change while in the pit lane: the limiter took the new limit, js/pit.js the old -> speeding on the limiter | the whole change waits until the car has left the pit stretch (js/main.js `syncPitYear` / `pitRebind`) |
| FLOW-2 | minor | every bot announced as a player joining / leaving | bot rows not announced; a guest gets one count toast (js/main.js) |
| FLOW-3 | minor | 'X站' / 'X大獎賽' / '日本GP' found nothing | NFKD, Chinese / Latin runs split, round suffixes dropped, 'F1' in every key; `ui.searchTracks` (js/ui.js) |
| AI-4 | minor | free practice: bots gave blue-flag way to a player on the same lap | `view.prog` NaN outside race / results (js/main.js) |
| AI-5 | minor | a bot conceded to any human who followed long enough, faster or not | only to a human seen closing > 1.5 m/s while the bot is flat out (js/ai.js) |
| AI-6 | minor | a car coming the wrong way at speed: head-ons at full strength, pile-ups | the swerve aims beside the meeting point (js/ai.js): 40 m/s head-ons 57 -> 12, pile-ups 14 -> 2 |
| MP-2 | minor | dedicated server: the bots' owner leaving aborted the race for everybody | his bots leave as any leaver (DNF), the humans race on (net/server.js) |
| MP-3 | minor | a bot's second impact in the same 50 ms tick was discarded | one report per car per tick, longest owed first, kept 400 ms (js/main.js `sendOwed`) |
| PRES-1 | minor | the 3D start gantry's lamps were painted lit red (all 10, also in practice / after lights out) | lamps painted dark + `scenery.setStartLights(n, go)` driven by main.js (js/scenery.js, js/main.js) |
| PRES-2 | minor | the tunnel reverb's impulse response was rebuilt twice per lap at Monaco (23.5 vs 25 m) | reused within 15 % / 1 m; primed at track load with the longest stretch (js/audio.js, js/main.js) |
| PKG-3 | minor | the credits' links did nothing in the exe | https links to github.com / creativecommons.org / www.openstreetmap.org open in the user's browser (electron-main.js) |
| W4 | minor | Baku's range 34.4 m vs the published 26.8 m | heights scaled x0.777 (tools/build-tracks.mjs) |
| DRV-1, W3, MP-5, AI-9 | minor | the contract had no v6.1 / v6.2 / v7 sections; CLAUDE.md said 11 suites; the concede device not recorded | this docs stage (js/README-interfaces.md, devtests/README.md, CLAUDE.md, this file) |
| DRV-2 | minor | the calibration's keyboard driver under-drives 2026 in grip-limited slow corners (-0.47 % over 40 circuits) | NOT changed: documented in docs/seasons-data.md (a fix = a new driver + ~30 min of recalibration) |
| PKG-2 | cosmetic | 15 bots set on a loaded track froze the UI 0.2..0.75 s | the warm-up runs behind the loading note 電腦車手熟悉賽道中… (js/main.js, js/ui.js) |
| FLOW-4 | cosmetic | V after a mirror failure gave no feedback | a toast; the V hints hidden (`#hud.mirrors-na`) |
| MP-6 | cosmetic | the host ignored a rejected bot lap | a toast at most once per 8 s; the session stays authoritative |
| W5 | cosmetic | Suzuka bridge: green terrain sheets under the deck | the verge stays at the deck's underside over the opening, concrete wing walls (js/track.js) |
| W6 | cosmetic | the Toscana DSM was labelled lidar | labelled a photogrammetric surface model |
| W7 | cosmetic | test/track.test.js still exempted Silverstone from "line beside the pit buildings" | exemption removed |
| PKG-5 | cosmetic | exe-smoke left its temporary profile in %TEMP% | removal retried for 5 s (devtests/exe-smoke/smoke-exe.js) |

### Decisions taken for the user (round 3)

- FLOW-1: a season change during a pit visit waits entirely until the car leaves the pit stretch (not a live limit in
  js/pit.js: an 80 -> 60 change at 79.8 km/h would flag speeding at once). A hold still pending is dropped on a year change
  (free practice only).
- FLOW-2: guests get one toast 房間的電腦車手：N 位 / 無, never the host, and none when a human joined / left in the same roster.
- FLOW-3: trailing round suffixes dropped, Chinese and Latin runs split, NFKD, 'F1' in every key. FLOW-4: a toast on every
  V press, the V hints hidden while the mirrors cannot be drawn.
- AI-4: no race distances (blue flags) outside race and results. MP-3: one report per reporting car per 50 ms tick, longest
  owed first, kept up to 400 ms. MP-6: a toast at most once per 8 s, the session stays authoritative. PKG-2: the warm-up
  runs behind the loading note titled 電腦車手熟悉賽道中….
- MP-2: when the bots' owner leaves, his bots leave the running session as any player does (quali / grid: out; race: DNF;
  results: row kept) and the humans race on; on a dedicated server the next host can end it; in a token room the session
  goes on without a host, as when a host without bots leaves (a room hosted in the game closes with its host anyway).
- PKG-3: only https links to github.com, creativecommons.org and www.openstreetmap.org open (in the user's browser); every
  other navigation and window stays denied (the other source addresses in the credits are text).
- AI: (1) the pit limit is read live by the bots; (2) memories by full id; (3) a bot presses a car known to be slower
  (bots' pace) on straights only (radius > 80 m at both): 0.3 x the time gap, its normal braking not anticipated; not in
  corners (four times the heavy contacts there); not while it has a stop planned, from the decision to 90 m past the lane
  (re-run stage: the merge after a full-field stop); the longer attack reach was tested and dropped; (4) the concede device
  (the stand-in for the missing slipstream) is unchanged in what it does - the edge, max(follower speed - 8 m/s, 78 % of
  own pace) for up to 8 s, rookies after ~2 s, legends never - but pressure is a time gap (within 0.5 s, released beyond
  1 s) and a human of unknown pace counts only after closing faster than 1.5 m/s while the bot is flat out; (5) a
  wrong-way car is swerved round beside the meeting point (braking for it and longer yellow gaps were tested: worse).
- World: (1) Silverstone timing at the Wing's start line, 151 m after the real timing line, so that the grid behind the
  line lies on the straight (a per-track "grid ahead of the line" offset was rejected: laps are counted at the start
  line); (2) Baku scaled to the published 26.8 m rather than the surface model's 34.4 m (no open DTM for Azerbaijan); (3)
  the Toscana DSM labelled photogrammetric, Mugello's settings unchanged; (4) Suzuka bridge: the verge at the deck's
  underside over the opening, a 1:1.5 embankment elsewhere, concrete wing walls; (5) the gantry lamps dark unless
  `setStartLights` lights them: they follow the HUD lights (dark in practice and after lights out, n columns from the
  driver's left on the grid).
- Media: an impulse response is reused for sizes within 15 % of its width and 1 m of its height (23.5 vs 25 m = echo
  spacing 68.5 vs 72.9 ms, inaudible; a new one costs 10-20 ms of main thread); it is built at track load for the longest
  covered stretch (`setTunnel(0, w, h)`), silently.
- AI PACE kept after the re-check on the new track data: 7.95 / 4.98 / 2.50 / 0.97 %, within the solver's 0.001 step of
  the targets.

### Re-run on the final tree (2026-10-02)

All green, muted (devtests/electron-userdata.js; SOUND never set): the 12 node suites (main.test 91 checks, ai.test 34
tests), `build-cars --check` after a recalibration (calibrate.mjs 26 min, then ers-effect.mjs and build-cars: all 17
seasons within 0.03 % of their index, team order unchanged in every season, reference laps Baku 101.833 -> 101.850 s and
Silverstone 95.017 -> 94.908 s, check-drive within 0.3 %, drive-check "all seasons ok"), every node devtest, every Electron
harness (gp-e2e/bots.js 193/193, bots-test/game.js 72/72, v62-critic 134, v61-critic 98, v6-smoke 150, v6-critic 85,
gp-smoke 197, ui-gp 117, ui-v6 154, hudmirrors-test 41, gp-e2e solo 584 / solo-v6 295 / online 141 / online-v6 65,
mp-e2e 30 ...). Only `review/escape.js` prints 203 escapes (a v1 script that counts the pit lanes; 204 at HEAD 17170a2).
Fixed during the re-run: gp-e2e/bots.js parts `ram` (it now picks a bot not faster than us, re-picks beyond 60 m) and
`host` (the new MP-2 rule); hudmirrors-test's V check (FLOW-4); review/e-main / e-fps / e-blur hung on `#hud-speed`
(gone since v6; broken at HEAD too); check-v62's Silverstone line; the two main.js hookups (gantry lamps, reverb priming);
exe-smoke's cleanup; the bots' "no pressing with a stop planned" guard (part `pits` once failed with a 0.31 bump).
Reports (every reviewer's findings, the verdicts, the fixers' and the re-run's summaries): docs/agent-runs/2026-10-01/reports/r3-reports.txt.

### Still open after round 3 (known, not fixed)

- Pressing into the braking zone of Monza's first chicane on lap 1 gives bumps of 0.16..0.20 in about 1 race in 5 (HEAD
  never did; heavy is 0.25). Needs a decision on the passing behaviour in js/ai.js (e.g. no pressing within N m of a
  braking zone, or on lap 1).
- Passing between cars 1..2 % apart stays rarer than real racing (js/car.js has no slipstream); a pro-paced human behind
  an amateur bot at Monza is never let by (he never shows closing speed while the bot is flat out).
- At 8 m/s in a Monaco street too narrow to pass, bots meeting a wrong-way car stop and back off slower than it comes on
  (5 hits, max 0.42); a human would stop too.
- DRV-2: the calibration driver's 2026 bias (-0.47 %): a line-following player finds 2026 ~0.4 % quicker than its index.
- Credits: a docs/CREDITS (or README) section mirroring the in-game list, and generating it from tools/build-tracks.mjs
  SOURCES, were suggested (W2 follow-ups). tools/track-audit.json still records Silverstone's finish node and 'lidar' for
  Toscana / Mugello (the builder is the reference; docs/track-audit.md is updated).
- By design: while the host has the menu open his bots stand still for everybody; no bot ownership transfer on host
  migration; the standings' gap column can look out of order after a pit stop (gap taken at the last line crossing);
  `ai.pace` is not a lap-time prediction.
- Not verified by anyone: a physical controller (stubbed only), the sound by ear (measured only), real two-machine
  internet play, a weaker GPU / a visible window with 15 bots, Electron 44 on another machine.

### Remaining steps (in order)

1. Commit the round 3 tree locally (code + harness fixes + recalibrated seasons data + docs) on main.
2. `npm run dist` from a CLEAN worktree of that commit (not the working tree: untracked scratch must not ship).
3. `node devtests/exe-smoke/smoke-exe.js <worktree>/dist/win-unpacked/F1Drive.exe` (expect 22 / 22, no page errors) and
   read its screenshots (devtests/exe-smoke/out/), incl. the gantry lamps and the bots at the start.
4. Push main (the user wants verified rounds pushed: "最後好了幫我丟github吧").
5. GitHub release: push the tag first (`gh release create` with a bare sha as --target fails with 422), prerelease, the
   portable exe as the asset, Traditional Chinese notes (round 3 changes: smarter overtaking, the bots' pit limit, the
   Silverstone grid, the start gantry lights, the credits, search by 日本站 ...). Suggested tag: v7.1.
6. Then update CLAUDE.md's state (commit id, release) and refresh docs/claude-memory/.

- ~09:30: Fable round 3 committed + pushed 541115e (no release yet). AI pressing follow-up RUNNING (run wf_e576af1f-aa0, script wf-ai-press.js: fix + independent check). Then: dist from a clean worktree, exe smoke, commit, push, release v7.1 (final of this run).
- ~12:40: AI pressing follow-up DONE (reports docs/agent-runs/2026-10-01/reports/ai-press-reports.txt): press released 2.5..1 s before the car ahead brakes, gap held, pass set up on the inside of the coming corner; 672 races: passes 4328 vs round 3 3961, contacts 48 (5 heavy) vs 58 (8), offs 147 vs 392, finish order level; lap-1 chicane bump 0 / 40 Electron runs; independent check verdict ok. Open (minor): Monaco wear x2 soft stint can reach 93 % (1 run in 8), a hairpin alongside misjudgement at Bahrain T10. Next: commit, clean build, exe smoke, push, release v7.1.
