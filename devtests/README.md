# devtests

Scratch suites written by the agents while building F1Drive: node-only tests that load the real `js/*.js` into
node, and Electron harnesses that drive the real game (or a small viewer page) in an offscreen window and save
screenshots. None of this ships (`package.json` `build.files` does not include it). The supported regression
tests are the ones in `test/` (`node test/*.test.js`, each an exit code; 12 suites): `ai` (js/ai.js, the computer drivers, with the
real track / car / collide / pit / tyres: about 5 s), `car`, `cars` (seasons data, CarSpec, the
golden anchor, `build-cars --check` incl. the docs table, the era index driven with E on 4 circuits: about 70 s),
`collide`, `gp`, `laps`, `main` (the real `js/main.js` in node against stubs, about 2 s; `MAIN=<file>` runs it against
another main.js), `pit`, `server`, `session`, `track` (Monaco's start line and harbour-side pit lane, the real pit speed
limits, the terrain behind the real bankings), `tyres`.

All paths are derived from `__dirname`, so the folder works wherever the repo is cloned. Run everything from the
project root. Times are from one run on a desktop PC (2026-09-30, Node 24, Electron 33); "40 tracks" suites scale
with the track list. On 2026-10-01 `package.json` moved to Electron `^44.5.1`; the suites re-run after the final review's
fixes that afternoon (the node suites, `track-test`, `laps-test`, `raceline-test drive`, `scenery-test`, `pit-test/check.js`,
`ui-gp`, `ui-v6`, `gp-smoke`, `gp-e2e` solo / solo-v6 / online / online-v6, `integration/mp-e2e`, `v6-smoke`, `v6-critic`,
`seasons-calib`, `scenery-pit`, `audio-test`, `pit-logic`) all passed on 44 in about the same time as on 33.
Since then everything below was re-run after v6.1 (2026-10-01 ~20:00), v6.2 (~23:00), the computer drivers (v7, 10-02
~03:30) and Fable review round 3 (10-02 morning, final tree): all 12 node suites, `node tools/build-cars.mjs --check`,
every node devtest and every Electron harness this README listed then passed, muted; the counts below are from those runs
(rows added on 10-02 for folders that had none, e.g. `car-v6`, `track-fix`, `tyres-test`, were checked when written). Known
non-zero verdicts: the v1 script `review/escape.js` (pit lanes count as escapes, see its row) and the DPR 2 child pass of
`telemetry-test` (an Electron 44 offscreen limitation, see its row).

- Since v6.1 a fresh install drives the 2026 standard car. Harnesses written for the reference car (`'2025-standard'`,
  the v5 car) pick it before the game boots with `devtests/ref-car.js`: `await require('../ref-car').seed(win[, {year,
  car}])` BEFORE `win.loadFile(index.html)` (it writes the menu's stored choice through `ref-car.html`, a blank page of the
  same `file://` origin). `gp-e2e/lib.js`, `v6-critic/lib.js` and `v6-smoke` do it unless `fresh` is asked for.

- Node-only: `node devtests/<folder>/<script>.js [args]`.
- Electron: `npx electron devtests/<folder>/<script>.js`. Each harness gets a throw-away userData dir
  (`devtests/electron-userdata.js`, under the OS temp dir, removed on exit), so several can run at once.
- Options go in environment variables. Git Bash: `SHOTS='a:?t=spa&v=60' npx electron ...` (quote it, the value
  contains `&`). PowerShell: `$env:SHOTS='a:?t=spa&v=60'; npx electron ...`.
- Screenshots / reports are written into the harness's own folder and are git-ignored (`devtests/**/*.png`,
  `devtests/review/e-report.json`).
- Only the scripts marked "exit code" fail the process; the others print a table or a verdict line to read.
- Order of the sections: v1..v4 folders, then the Grand Prix / gamepad (v5) ones (`laps-test`, `gp-test`, `net-gp`,
  `ui-gp`, `gp-smoke`, `gp-e2e`, `bots-test`), the v6 ones (`v6-smoke`, `v6-critic`, `pit-test`, `ui-v6`, `seasons-calib`,
  `audio-test`, `scenery-pit`, `hudmirrors-test`, `pit-logic`, `review-final`), then v6.1 / v6.2 / v7 (`v62-critic`,
  `v61-critic`, `tunnel-test`, `cockpit-test`, `car-v6`, `track-fix`, `ai-test`), the packaged game (`exe-smoke`) and the
  module workbenches (`telemetry-test`, `tyres-test`, `handling-test`), last the round 3 review's probes (`review-r3`).
- Harnesses that open a room listen on a TCP port (`PORT`, defaults below). Two harnesses running at the same time
  need different ports.

## DO NOT RUN: historical patch scripts

These are one-off edits that were applied to the project sources while the game was being written. They are kept
as a record only. Re-running one would try to rewrite `js/*.js`, `net/server.js`, `index.html` or a test with
stale content. (They still carry the old machine's absolute path `C:/Users/user/Desktop/f1drive`, on purpose: it
makes most of them fail harmlessly here. Do not "fix" that path.)

| Script | What it rewrote |
| --- | --- |
| `3d-test/patch-car.js` | `js/car.js` (tyre-load physics) |
| `3d-test/patch-build.js` | `3d-test/build.js` itself (added the groundY checks; already applied) |
| `car-test/patch.js`, `car-test/patch2.js` | `js/cockpit.js` (cockpit model tweaks) |
| `integration/patch3.js` | `js/collide.js`, `net/server.js`, `js/net.js`, `js/main.js` (impact reports) |
| `integration/patch4.js` | `js/net.js` (interpolation lead) |
| `integration/patch5.js` | `net/server.js` (Grand Prix session, first draft) |
| `integration/patch6.js` | `js/net.js`, `js/carmodel.js` (Grand Prix client side, ghost cars) |
| `integration/patch-html.js` | `index.html` (multiplayer panel) |
| `integration/patch-ui.js` | `js/ui.js` (multiplayer panel) |
| `integration/fix-re.js` | `net/server.js`, `js/net.js` (control-character filter) |
| `integration/patch2.js`, `integration/patch-e2e.js` | `mp-e2e.js` in the current directory |
| `raceline-test/patch1.js` ... `patch8.js`, `unpatch8.js` | `js/raceline.js` (`patch7.js` also `test.js`, `test3.js`, `dbg.js` in the current directory) |

Not scripts, also leave alone: `integration/tracks-data.before.js` (an older `tracks-data.js`: fewer points per
track, no `elev` / `geo`) and `raceline-test/rl_many.js` (an abandoned alternative racing-line solver, only loaded by
`raceline-test/test2.js` and `diag2.js`).

## track-test — `js/track.js` basics (node)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/track-test/test.js [id or name part]` | Every track builds; finite geometry, no down-facing road / ground triangles, unit tangents / normals, 2 m sample spacing, length within 5 % of `lengthKm`, `locate()` round trip, no wall standing on a non-adjacent piece of road, no wall fragments. Ends with `ALL PASS` or `FAILURES: n`. | 10 s |

## 3d-test — elevation, banking, walls, terrain, load-based physics

`load.js` is the shared loader (three, tracks-data, track.js, car.js). `FLAT=1` strips the elevation, `SYNTH=1`
replaces it with a synthetic profile.

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/3d-test/build.js [id or name part]` | Per track: `surfaceY` equals the road / runoff / paint mesh, wall margins and steps, drawn wall equals the exported wall distance, terrain never above the track and without holes, `groundY` / `nearest` / `inCorridor` against brute force, build under 250 ms. Since v6.2 a vertex is located with its own height (at Suzuka's bridge: the road it belongs to), and the abutment vertices under the deck are not counted as walls in the lower road (near the bridge only). Table, then `ALL PASS` or `FAILURES n`. | 35 s |
| `node devtests/3d-test/physics.js` | Prints cornering limits (flat / banked / off-camber), the lateral-g table, braking distances on slopes, crests and dips, stability over a sharp crest. Numbers to read, no verdict. | 1 s |
| `node devtests/3d-test/drive-all.js [id or name part]` | A centreline follower drives one timed lap on every track. Table: `lapCounted` must be true and `stuck` false. (`wallOnRoad` uses the old fixed 7 m road half width, so it is non-zero where the road is narrowed: Albert Park, Monaco. `build.js` is the real wall check.) | 12 s |
| `node devtests/3d-test/escape.js [name part] [starts=24]` | Rams and scrapes the walls from many start points in 8 ways; the car must never get through a wall, outside the track or onto a stale sample (near Suzuka's bridge judged with the car's height since v6.2). Last line must be `TOTAL {"through":0,"stale":0,"outside":0}`. | 40 s |
| `node devtests/3d-test/targeted.js` | Baku / Monaco shared mid walls (`over` must stay 0.000, `stale` 0) and the Suzuka crossover (written for the old same-level junction; since v6.2 it is a bridge, the roads 6.4 m apart: the A->B attempts now end on the grass against the walls of their own road, which is right; numbers to read). | 1 s |
| `npx electron devtests/3d-test/shot.js` | Renders `view.html` (track + car + cockpit, software WebGL) and saves `shot-<name>.png`. `SHOTS='name:?query,...'`, default `a:?t=spa`. Query: `t` track name part / id, `i` sample, `find=up\|down\|bankL\|bankR\|crest\|cross`, `back`, `d`, `h`, `v`, `steer`, `ext` (outside camera height), `eb`, `es`, `synth`. Prints the page title (`done ...` or `ERR ...`). | 4 s + 1.5 s per shot |

## car-test — `js/car.js` and `js/cockpit.js` on synthetic tracks

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/car-test/test-car.js` | Prints the performance sheet: 0-100 / 0-200 / 0-300, top speed, braking, coasting, reverse, steering sign, turning radius per speed, grass, wall impacts per angle, worst wall penetration (must stay at the 11 m limit). Numbers to read. | 2 s |
| `node devtests/car-test/test-cockpit.js` | Cockpit builds, 600 frames without NaN, camera looks along the heading. Throws on NaN. | 1 s |
| `npx electron devtests/car-test/shot.js` | Cockpit viewer on a flat strip: `shot-a.png` (standing), `shot-b.png` (90 m/s, full left lock), `shot-c.png` (outside view). `SHOTS` as above; query `x`, `v`, `steer`, `ext`. | 5 s |

## gamepad-test — `js/gamepad.js`, analog input in `car.js`, head-look in `cockpit.js`

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/gamepad-test/gamepad.test.js` | 25 tests with a stubbed Gamepad API: deadzones, signs, triggers, edge-triggered buttons, suspended polling, d-pad, `mergeInput`, rumble, connect / disconnect, non-standard pads; v6.1: every standard button (0-16) and every raw one (0-10) pressed alone against the A / B / X / Y table (A / RB battery, B / LB limiter OR-ed, X compound, Y reset, View line). Exit code. | 1 s |
| `npx electron devtests/gamepad-test/game-map.js` | The v6.1 mapping in the REAL game (one muted offscreen window, a fake standard pad, the reference car): A and RB deploy, B does not; B and LB toggle the limiter; X cycles the compound (M -> H -> S), View does not; View toggles the racing line, X does not; Y resets, A does not; Menu opens and resumes; RS click recentres; no console errors. `ALL PASS 11 checks`. Exit code (2 = 120 s watchdog). Env `TRACK` (monza). | 20 s |
| `node devtests/gamepad-test/car.test.js` | Analog throttle / brake / steer in `car.update` (10 tests). Exit code. Two more tests compare bit-for-bit against `car.orig.js` (car.js from before the change); that file is not in the repo, so they print `SKIP`. | 1 s |
| `node devtests/gamepad-test/cockpit.test.js` | Head-look limits, smoothing, return to centre (on a level road since v6.2: the head's road-shape cues tilt the camera on a slope). Exit code. The "identical to the old camera when centred" check needs `cockpit.orig.js` (not in the repo) and prints `SKIP`. | 1 s |
| `npx electron devtests/gamepad-test/shot.js` | Same viewer as 3d-test plus `lx`, `ly` (head-look, -1..1). Default `a:?t=spa`. | 4 s + 1.5 s per shot |

## raceline-test — `js/raceline.js`

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/raceline-test/test.js build` | Builds the line on all 40 tracks: no NaN, inside the road, build time, `update()` cost. Last lines: `worst build ms ... bad tracks 0`. | 4 s |
| `node devtests/raceline-test/test.js drive [delay s] [name regex] [hz]` | A driver that only follows the line and its colour (throttle on green, brake on red) does 3 laps per track without touching grass or walls. Must end `passed 40 / 40`. `LVI` picks the colour sample it looks at. | 10 s |
| `node devtests/raceline-test/test3.js` | Six hilly tracks: ribbon sits on the surface, the drive test passes, the flat v1 fallback (no `y` / `bank`) works. `OK` / `FAIL` per track. | 2 s |
| `node devtests/raceline-test/test2.js [build\|drive]` | Same as `test.js` but against the abandoned `rl_many.js` solver (its drive test fails Monaco; that is not the shipped line). | 3 s / 6 s |
| `dbg.js <name> <from> <to>`, `diag.js <name> [sample]`, `diag2.js <name> [sample]`, `insp.js <name> <sample>` | Dumps for one track: per-sample speed / limit / colour on a flying lap, slowest corners, line offsets around a sample. | < 1 s |
| `wob.js [name\|all] [other raceline.js]`, `wob2.js`, `zz.js` | Smoothness metrics over all tracks (wobble lobes, mid-scale waves, 2 m kinks, direction reversals). Numbers to compare between versions. | 3 s each |

## scenery-test — `js/scenery.js` + `scenery-data.js`

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/scenery-test/test.js [trackId]` | Every track twice (OSM data, procedural fallback): no NaN, nothing inside the track corridor (vertices and footprints), gantries high enough, at most 400 000 triangles and 25 draw calls, `dispose()` leaves nothing. Must end `FAILS 0`. | 90 s |
| `node devtests/scenery-test/prof.js <trackId>...`, `prof1.js <trackId>` | Build time per phase (warm / cold). | 1 s |
| `npx electron devtests/scenery-test/shot.js` | Renders `view.html` (track + scenery + sky). `SHOTS` is required (nothing by default), e.g. `SHOTS='monza:?t=it-1922&f=0.02,spa-proc:?t=be-1925&f=0.05&data=0'`. Query: `t` track id, `data=0` procedural only, `f` lap fraction or `s` metres, `h` eye height, `d`, `yaw`, `pitch`, `back`, `fov`, `sd=<path>` (another scenery-data file: before / after shots). | 4 s + 0.5 s per shot |
| `node devtests/scenery-test/bridges.js [trackId...] [--json out.json]` | v6.2: every scenery deck built over the road (s range, OSM id, underside) and the audit's checks: the 6 phantom decks (the lap's own deck over an underpass: Spa, Zandvoort, Hockenheim x3, Nürburgring) not built, the 5 real ones kept, the Montréal / Marina Bay structures present, no deck over a js/tunnels.js stretch or the track's own bridge (Suzuka), every deck at least 6.5 m above the road, no pier in the corridor; plus js/scenery.js's runtime rule on made-up decks. Ends `all bridge checks passed`. Exit code. | 3 s (10-02) |
| `node devtests/scenery-test/pitside.js <old scenery-data file> [trackId...]` | After a scenery rebuild: builds every track whose scenery data changed with the old and the new file and compares `track.pit` and a hash of the samples (js/track.js takes the pit side from the 'pit' buildings). Exit code 1 when a track differs (10-02 against `scenery-test/out/scenery-data.before.js`: 19 changed, 0 differ). | 2 s |

## review — scripts of the first independent review (v1)

`load.js` is the loader. These print findings to read; most have no verdict line.

| Run | Shows | Time |
| --- | --- | --- |
| `node devtests/review/build-all.js` | Table per track: samples, length, wall coverage and gaps, closest parallel section, tightest radius. | 3 s |
| `node devtests/review/drive-all.js [id or name part]` | 60 Hz version of `3d-test/drive-all.js`. | 9 s |
| `node devtests/review/escape.js [name part]` | 60 Hz wall-escape test, written before the pit lanes (v6): a car steered into a pit lane (|d| about 13 m, no wall there) counts as an escape, so it no longer ends `total escapes 0` (204 at commit d1decf6, 203 after review r3; Albert Park, Monza ... at the pit entry / exit). `3d-test/escape.js` is the wall check that knows the lanes. | 7 s |
| `node devtests/review/dir-clamp.js` | Racing direction of the data against a table of real directions (`ok` / `MISMATCH`), then walls drawn inside the collision limit (list must be empty). | 2 s |
| `node devtests/review/wall-geom.js` | Where walls stand closer than 9 m to the centreline (expected at narrowed roads and shared mid walls). | 25 s |
| `node devtests/review/cross.js`, `gaps.js`, `pinch.js` | Traces for Monaco / Baku / Suzuka wall gaps and crossings, road pinch at four tight corners. | < 1 s |
| `npx electron devtests/review/e-main.js` | Real game, offscreen: menu, Monaco, keys, search box, six track switches, resize. Saves `01-menu.png` ... `07-resized.png` and `e-report.json` (also printed). Written for the v1 menu: read the numbers, e.g. Esc inside the search box now only blurs it, so the later "resume" values repeat. Since v6 the HUD has no `#hud-speed` / `#hud-gear` (the telemetry graphic): speed and gear are read from the car (`(car)`); a page script that fails ends it (exit 1) instead of hanging (it hung from v6 until 2026-10-02). | 20 s |
| `npx electron devtests/review/e-fps.js` | Opens a VISIBLE window: frames per 4 s, speed after 4 s of W, input cleared on blur. Saves `08-monza.png`. (As `e-main.js`: the speed read from the car since v6; ends itself on a failed page script or after 60 s.) | 11 s |
| `npx electron devtests/review/e-blur.js` | Opens two VISIBLE windows and takes the focus: blur handling and Ctrl+R. It does not load `electron-main.js`, so Ctrl+R reloads here (the real app removes the default menu). (Speed from the car since v6, as `e-fps.js`.) | 10 s |

## integration — the real game end to end (Electron)

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/integration/shot.js` | Smoke test: menu, click a track, hold keys, screenshots `<OUT>-menu / -start / -stepN.png`, prints the HUD text. `TRACK` (default Monza), `STEPS` (default `W:4000,WA:1200,:300` = keys:ms), `OUT` (default `g`). | 10 s |
| `npx electron devtests/integration/mp-e2e.js` | Multiplayer end to end with two windows + real preload / host IPC / server: create, join, the room texts once the host has picked the track, grid slots (each car in its painted grid box), interpolation, car-to-car collision, menu while in a room, track change, host leaves, port reuse, browser mode without preload, failed join. 30 checks, screenshots `mp-<A\|B\|C>-*.png`. Exit code. `PORT` (default 24731) is the room's TCP port, `DEAD_PORT` (default 24999) must have no listener, `TRACK`. | 30 s |
| `npx electron devtests/integration/keys.js` | Key events reach the game: speed after W, then S held (brake, then reverse). | 12 s |
| `npx electron devtests/integration/smooth.js` | Diagnostic: how smoothly B sees A while A accelerates (worst per-frame deviation, snapshot gaps). Hosts on `PORT` (default 24741). | 15 s |
| `npx electron devtests/integration/smooth2.js` | Same, against a dedicated server: start `node net/server.js <port>` first, then run with `PORT=<port>`. | 15 s |
| `npx electron devtests/integration/svg2png.js <dir> <id,id,...>` | Utility: renders `<dir>/<id>.svg` to `<dir>/<id>.png` (longest side 1000 px). | 3 s |
| `node devtests/integration/t.js` | OBSOLETE v1 leftover: ran `js/ui.js` + `js/main.js` in node against a hand-made DOM stub to print lap-counting values. It still worked against the v4 files, but the stub is too small for the v5 `js/ui.js` (`TypeError: el.lights.getElementsByTagName is not a function`). Lap counting is now `js/laps.js`, tested by `node test/laps.test.js`. | - |

## laps-test — `js/laps.js` on the real tracks with the real car, the starting grid (node)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/laps-test/drive.js [track regex] [laps\|cross]` | The lap counter fed exactly as `main.js` feeds it (after every 1/120 s `car.update`), against a ground truth (the car's own continuous position). `laps`: every track, qualifying start (out lap + 2 timed laps) and race starts from grid slots 0 and 15, then a start from each of the 16 slots (the first crossing credits nothing, the next lap counts). `cross`: Suzuka's crossover on both roads, both ways, a real shortcut (void lap), the long way round, R in the blind zone; since v6.2 the crossing is a bridge (`track.bridges`), so there the index must never be on the other road (132 runs + the wide race), the shortcut and the long way cannot be driven (the car stays on its own road, nothing void) and R under the deck keeps the car on the lower road (the same-level expectations stay for a crossing that is not a bridge). Also shows what the old counter (`laps-v0.js`, kept as a baseline only) got wrong. Ends `all lap drive checks passed`. Exit code. | 23 s |
| `node devtests/laps-test/grid.js [track regex] [-v]` | The 16 painted grid boxes of `js/track.js` against the rule (box k = slot + 1: front bar k * 8 m behind the line, 3 m left / right), `track.grid`, and where `main.js`'s `placeOnGrid` really puts the car: nose at the bar, on the box centreline, on the road, clear of walls and of the other 15 cars, behind the line. `-v` prints every slot. Ends `40 / 40 tracks ok`. Exit code. | 1.5 s |

`main-grid.js` is a helper: it takes `placeOnGrid` and `CAR_NOSE` out of the source text of `js/main.js` (renaming either
breaks `drive.js` / `grid.js` loudly).

## gp-test — `js/gp.js` outside the unit tests

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/gp-test/net-glue.js` | `F1.gp` against the REAL `js/net.js` (a fake WebSocket whose other end is a real `net/session.js`, fake clocks): snapshots, roles, lights, laps, rejected laps. Ends `net-glue: all checks passed`. Exit code. | < 1 s |
| `npx electron devtests/gp-test/browser-load.js` | `js/gp.js` as a classic browser script (`page.html`: laps.js, session.js, net.js, gp.js in the contract's order), a whole offline Grand Prix through `F1.gp`. Ends `browser-load: all checks passed`. Exit code. | 2 s |

## net-gp — `js/net.js` + `net/server.js` + `net/session.js`

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/net-gp/electron-net.js` | The real `js/net.js` in two Chromium pages against the real server, a whole Grand Prix on a 200 m "track" in real time: clock sync, snapshots, lights timing, rejected laps, teardown. 20 checks. Exit code. `PORT` (default 24770). | 16 s |
| `node devtests/net-gp/fuzz-server.js [seconds=12] [seed]` | Eight clients throw random and half-valid messages at the real server (v7: also `bots` / `bs` / bot-id messages, bot roster rows validated): nothing may throw in the server, every `gp` / `players` message must be well-formed, a normal client is served afterwards. Ends `FUZZ OK`. Exit code. `PORT` (default 24775). | 13 s |
| `node devtests/net-gp/fuzz-session.js [runs=3000] [seed]` | Random walks over the session rules: nothing throws, snapshots stay plain, finite and consistent, a session is never stuck. Prints a coverage line (v7: bot players added, the bot flag checked). Exit code. | 2.5 s |
| `npx electron devtests/net-gp/electron-bots.js` | v7: computer drivers over the wire, the real js/net.js + js/gp.js in two pages against the real server: the host sets 6 bots through `F1.gp.setBots` and drives them (`sendBotStates`, `botProgress`, `botLap`), a real-time Grand Prix on a 200 m "track": roster, remote poses, parc fermé, bot laps rejected by id, the grid with bots, `botsGo`, live order, identical results, the guest's view rows, the host leaving takes his bots. 29 checks. Exit code. `PORT` (default 24772). | 20 s |
| `npx electron devtests/net-gp/electron-host.js` | "Create room" with a password through the real preload.js + net/host.js IPC: the host joins with its token, a guest page is refused without / with a wrong password and gets in with the right one; closing the host's room ends it. 8 checks. Exit code. `PORT` (default 24790). | - |
| `npx electron devtests/net-gp/electron-v6.js` | v6 network features in real pages: cars in the profile / roster, the room year and its event order, the Grand Prix year and tyre wear through `F1.gp`, parc fermé and the car sent again afterwards, an offline Grand Prix with year / wear, joining with a password. 25 checks. Exit code. `PORT` (default 24780, and `PORT + 1`). | a few s |

## ui-gp — the Grand Prix / controller parts of `js/ui.js` + `index.html`

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/ui-gp/shots.js` | The real page fed with mock `GpView`s (`setGp`, `setLights`, `setPad`, `updateHUD`) at 1280 / 1920 / 700 px: menu panel, HUD session box, lights, results overlay, toasts over the menu, layout (nothing clipped or overlapping), texts; part `real` drives the page's own offline `F1.gp` through a Grand Prix; part `init` checks the init order. 117 checks, screenshots `ui-gp/out/`. Exit code. Env `ONLY=menu\|hud\|checks\|real\|init`, `TRACK` (default monza), `UI=<other ui.js>` (part init against a mutant). | 40 s |

## gp-smoke — the v5 glue in `js/main.js`, in the real game

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/gp-smoke/smoke.js` | Parts: `free` (keys, R, L, Esc, free-practice lap), `solo` (single-player Grand Prix through the menu: grid box, frozen car, lights, go, results, another track ends it), `lap` (real lap-counter laps at warp speed: rejected lap (the timing box keeps it as 上一圈, not as 最快圈), grid, race lap, again, end, toast over the menu), `pad` (stubbed Gamepad API: triggers, sticks, head look, buttons, rumble, grid lock, Start adds nothing to the session clock, unplugging), `nopad` (page without `js/gamepad.js`), `suzuka` (since v6.2 a bridge: the car stays on its own road over and under it, R on and under the deck keeps its level), `room` (host + guest + late joiner: ghosts in qualifying, grid by qualifying, synchronised start, race clock never ahead, spectator, results, track change), `spec` (joining while the grid forms: spectator lights, toasts over the menu). 197 checks, screenshots `gp-smoke/out/`. Exit code. Env `ONLY=<parts>`, `PORT` (default 24800, parts room / spec), `TRACK` (monza), `ROOM_TRACK` (monaco), `MAIN=<other main.js>` (run against a mutant). | 3.5 min |
| `npx electron devtests/gp-smoke/grid-shots.js` | The starting grid in the real game: the car put on slots 0 / 1 / 15 by `main.js`, measured against the painted box; the other boxes filled with parked models; cockpit and overhead screenshots `gp-smoke/out/grid-<track>-slot<N>\|top\|front.png`. 27 checks. Exit code. Env `TRACKS=monza,monaco,spa,suzuka,rodr` (name parts), `SLOTS=0,1,15`, `PORT` (default 24806). | 25 s |

## gp-e2e — whole Grand Prix driven to the flag by an autopilot

The cars are driven through the game's real input path: a fake standard-mapping controller behind
`navigator.getGamepads` whose stick / triggers are set by an autopilot (pure pursuit of the racing line). Menus, fields and
buttons are real key / mouse events. `PATCH='<project file>=<copy>,...'` runs a harness against modified copies of
project files without touching the project (page scripts through a copy of `index.html`, main-process files through
`require`); `node devtests/gp-e2e/make-patched.js` writes deliberately broken copies (`mutants/`) to see that the checks
notice them.

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/gp-e2e/solo.js` | A whole SINGLE-PLAYER Grand Prix on Monza, Monaco, Suzuka and Spa, time-warped (the page's `requestAnimationFrame` is pumped with synthetic 1/60 s timestamps, several hundred times real time): Q = 2 / R = 3 typed into the panel, qualifying (R reset; at Suzuka since v6.2 a bridge check and a second race through the crossover replace the two cut-lap scenarios the bridge made impossible), grid, lights with the throttle held, race (Esc pause), results, the timing box stopping at the flag, 再來一場 / 結束 / 關閉 / another track mid-race, recovery of the autopilot (v6: the deliberate wall upsets damage the tyres, so the recovery includes a pit stop for a new set). Every lap time against a ground truth (physics steps between line crossings), the session and every HUD / table cell to the millisecond. v6: the stored setup is `{q, r, wear}`, the speed is read from what `main.js` hands the telemetry graphic, the results subtitle names the season. Last part `sound` (`silence.js`): every window muted and never audible, and no Windows volume-mixer session of the harness's process tree. 584 checks (588 before v6.2), screenshots `gp-e2e/out-solo/`. Exit code (2 = 15-minute watchdog). Env `ONLY=monza,monaco,suzuka,spa`, `VERBOSE=1`, `RENDER_EVERY=n` (600), `FRAME_MS=n` (another frame pace), `JITTER=1` (5..35 ms frames), `PATCH`. Page side: `solo-page.js`. | 1 min |
| `npx electron devtests/gp-e2e/solo-v6.js` | The SINGLE-PLAYER v6 Grand Prix, time-warped, on Monza / Suzuka / Zandvoort (2012 Red Bull, McLaren, Ferrari) and Monza 2026 (Mercedes W17): the year typed with real keys into the 年份 select and the car card clicked (checked in the menu, the 大獎賽 tab, the HUD session box, the telemetry and the results); Q 1 / R 6 / 輪胎損耗 ×5 (qualifying wears at x1, x5 from the grid on); parc fermé; a battery A/B on the start straight (2012 KERS against 2026 ERS; since the deploy is traction-limited (2026-10-01) the 2012 store is no longer empty after Monza's 422 m: the share used is checked); the race with the autopilot deploying on the straights and pacing itself on the grip left (`ap.gripPace`); T cycling the next compound; one pit stop at half distance (Q before the entry curtain, the lane at the limit, box 1, the random service, Esc during it, the hards chosen with T, Q off after the exit curtain; 2026: driven 25 km/h over the limit into the box, at the limit after it (`vLaneOut`), +5 s at that stop); tyre wear and grip lap by lap in the telemetry, restored by the stop; every lap against the ground truth incl. the steps held in the box, the lap through the lane, race total = session clock; results; 結束; part `sound` as in `solo.js`. 295 checks (2026-10-01: 45 s), screenshots `gp-e2e/out-solo-v6/` (`PATCH` runs: `out-solo-v6/patched/`). Exit code. Env `ONLY=monza,suzuka,zandvoort,monza26`, `VERBOSE`, `RENDER_EVERY`, `PIT_AFTER` (2), `FRAME_MS`, `JITTER`, `PATCH` (`index.html` too). Page side: `solo-v6-page.js`. | 1 min |
| `npx electron devtests/gp-e2e/online.js` | A whole ONLINE Grand Prix in real time on Monaco, four windows in one process with the real preload / host IPC / server: room texts (v6: through the 多人連線 / 大獎賽 tabs; the room's season, the 2025 standard car), qualifying as ghosts (a car driven through another, impossible laps rejected: too-fast / too-soon / inconsistent, and a plausible lap the server has not seen driven: `not-driven`; the timing box stopped while waiting), grid by qualifying, lights in step (a 12 ms stall injected on the pole car's lights-out frame), race clock never ahead of the session clock, a deliberate ram (driven), a spectator joining mid-race, live standings agreeing on all windows, a lapped car ("+1 圈", parked on Monaco's v6 slopes: `autopilot.js` holds it with a firm pedal), results (subtitle with the season); 再來一場 with a real lap that stood 55 s with its car states dropped (`no-data`; the driver's own timing box then shows it as 上一圈 but not as 最快圈, like the standings), 結束大獎賽, a new Grand Prix with 跳過排位, a leaver (離線 / DNF), the 90 s close after the winner, back to free practice. Frame rates, clock agreement and lap times are printed at the end. 141 checks, screenshots `gp-e2e/out/NN-phase-role.png`. Exit code. Env `PORT` (default 24850), `PATCH`, `SKIP=quali1,race1` (development only: skips parts and their checks). | 13 min (2026-10-01: 141 checks, Monaco's parking samples still on the road after its start line moved) |
| `npx electron devtests/gp-e2e/online-v6.js` | The v6 ONLINE Grand Prix in real time on Monaco (A host, B, C; D joins as a spectator after lights out): a room with a PASSWORD (C refused with a wrong one: server error `password`, 房間密碼錯誤; then admitted), the host picks 2014 in free practice (guests follow: toast, the 2014 standard car), three 2014 teams (roster, liveries painted on the remote models, screenshots), Q = 1 / R = 3 / 輪胎損耗 ×3 (year and wear on every window and car; the tyres wear x1 in qualifying, x3 from the grid on), parc fermé (car pickers locked, host and guests, also in the results), ERS on the straights (RB), one pit stop each in the race in the box of its room slot (LB limiter, X compound (Back until v6.1), the three in the lane at once as ghosts, light curtains on screen, a random 2.0..4.5 s service with the car held and the lap clock running, new tyres), results identical on four windows with the stops in the race times, 結束 back to free practice with the same cars. Frame rate and main-thread ms per frame per window and phase, audio back end and mute state. 65 checks, screenshots `gp-e2e/out/v6-NN-phase-role.png`. Exit code. Env `PORT` (default 24880), `SPECTATOR=0` (three windows), `PATCH`. Page side: `online-v6-page.js` + `pitplan.js` (`node devtests/gp-e2e/pitplan-sim.js`: the pit plan dry run in node). | 8 min |
| `npx electron devtests/gp-e2e/start-clock.js` | The online race clock at lights out over six starts (host + guest; every second start a 12 ms stall on the guest's lights-out frame): the lap clock must never be ahead of the session clock, nor behind by more than a step + two frames. 26 checks and a table of the measurements. Exit code. Env `ROUNDS` (6), `HITCH` (12 ms), `PORT` (default 24860), `PATCH` (`js/main.js=devtests/gp-e2e/mutants/main.go-clock.js` must fail it: 3 of the 26 fail). | 100 s |
| `npx electron devtests/gp-e2e/bench.js` | N offscreen windows alone (no room), each driving Monaco on the autopilot at another pace: frame rate per window with N windows rendering, lap times against the node simulation, recovery when thrown off. 28 checks. Exit code. Env `WINDOWS` (4, 1..6), `PACES=1,0.93,0.82,0.6`, `LAPS` (1), `TRACK` (mc-1929), `FPS` (60), `UPSET=1`, `PATCH`. | 2.5 min |
| `node devtests/gp-e2e/ap-sim.js [laps\|recover\|park\|follow\|race] [track id]` | The autopilot against the real car physics, racing line, lap counter and collisions in node: pace x controller rate, six kinds of upset, parking / lapping, following, the timeline of both `online.js` races. Exit code. | 0.5 s |
| `node devtests/gp-e2e/make-patched.js` | Writes the mutants into `mutants/`: `ui.lap-text.js` (the "+n 圈" text), `session.timeout60.js` (60 s race close), `main.go-clock.js` (the online race clock started when the lights-out frame runs instead of at its timestamp). | < 1 s |
| `npx electron devtests/gp-e2e/bots.js` | The COMPUTER DRIVERS (v7) end to end; our car is driven by a computer driver of its own through the fake controller (`bots-page.js`), so it races the bots. Time-warped: `monza` / `monaco` (15 bots 混合 set in the 大獎賽 tab, ×2 wear, Q 1 / R 3: the field, the boxes, qualifying as ghosts with our lap = ground truth, the grid by the times, the start without a pile-up, overtakes, our own stop at Monza (X for the hards, B for the limiter), the order by strength (Spearman), results with AI tags), `panel` (15 -> 6 -> 傳奇 -> 15 -> 0 while on the track), `ram` (we stop on the line out of the Roggia for 45 s with 15 bots lapping: they go round, nobody hits us; then we run into a bot (one 15..45 m ahead on a straight and not faster than us; one that gets 60 m away is dropped for another): both feel it, the pad rumbles, it drives on), `pits` (stalled 12 s on pole, then through the field; every bot and we told to stop on lap 2: the lane full, own boxes, no speeding, no contact on the pit asphalt), `blue` (a rookie parked a lap down at Monaco gives way to the cars a lap up), `suzuka` (a 1-lap race over and under the bridge: no jump, no void lap). Real time: `room` (host + guest + 6 bots on Monaco, Q 1 / R 2: positions and standings the same on both, every bot lap accepted, the host leaving takes the bots), `host` (dedicated server: the host leaves mid-race, his bots go (DNF), the guest races on as the new host; he ends it: results, then free practice), `perf` (race start with 15 bots at Monaco and Spa: 60 fps, main thread p95 ~2 ms). 193 checks, screenshots `out-bots/` (read them). Exit code (2 = 40-minute watchdog). Env `ONLY=<parts>`, `PORT` (24893), `PORT2` (24894), `FRAME_MS`, `VERBOSE`, `WATCH=<bot id>` (part ram: that bot's every think() for 4 s), `PATCH`. | 7.5 min |

Shared files: `lib.js` (windows, checks, `PATCH`), `page.js` (runs in the page for `online.js`, `start-clock.js` and
`bench.js`: fake controller, programmes, recorders, DOM readers), `autopilot.js` (the driver, pure logic, used by the
pages and by `ap-sim.js`; where it means to stand (mode `stop`, parked) it holds the car with a firm half pedal between
0.3 and 0.6 m/s, because `js/car.js` only holds a car on a slope below 0.3 m/s: `stats.holds`). Until 2026-10-01 `solo.js`
was called `solo-gp.js` (page `solo-gp-page.js`, output `out-solo-gp/`) and `bench.js` was called `solo.js`. For
`solo.js` / `solo-v6.js`: `solo-page.js` (the time-warp pump, recorders, the pit-lane driver, the battery manager, the
opt-in `ap.gripPace`) and `solo-v6-page.js` (battery / tyre / service recorders, the steer-only A/B driver). For
`online-v6.js`: `online-v6-page.js` (ERS on RB, the pit stop through LB / X, recorders: ERS, pit lane, service, frame
cost, server error / welcome messages, livery colours, light curtains on screen) and `pitplan.js` (the pit-stop driver,
pure logic). For `bots.js`: `bots-page.js` (`__bots`: our computer driver through the fake controller, warped or real
time; programmes hold / holdAt / holdAfterGo / ram / stop / tap; recorders: contacts by wrapping `F1.resolveCarCollisions`
(its helpers such as `.overlap` copied onto the wrapper - js/ai.js needs them), stuck bots, overtakes, the pit lane, the
field; `watch(id, s)`). Every harness here mutes its windows through `devtests/electron-userdata.js` (`SOUND=1` would make one
audible: do not set it while somebody is at the PC). `silence.js` proves it from inside (every window `isAudioMuted`,
never `isCurrentlyAudible`) and outside: `mixer-watch.ps1` reads the Windows volume mixer's per-session peak meters
(read-only; `powershell -NoProfile -ExecutionPolicy Bypass -File devtests/gp-e2e/mixer-watch.ps1 -Seconds 20` by hand).

## bots-test — the computer drivers in `js/main.js` (v7)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/bots-test/node-race.js [track=it-1922] [bots=15] [skill=mixed] [q=1] [r=2]` | The real `js/main.js` in node with `js/ai.js` (stubs as `test/main.test.js`); our car driven by its own computer driver through a fake controller, frames at 1/120 s: the lineup (real names, the season's cars, our teammate in the other seat), the grid boxes, free practice, a whole offline Grand Prix (grid by times, lights, race, results, Spearman vs skill), a count / skill change, another track, count 0. 35 checks. Exit code. | 30 s |
| `npx electron devtests/bots-test/game.js` | The real game, muted. `ONLY=ui,perf,gp,room`; `PORT` (24840); `PERF_S` (20); `TRACKS` (mc-1929,be-1925). The panel and the remembered setting, models / badges / minimap / mirrors, fps and frame cost with 15 vs 0 bots, a real-time solo Grand Prix with 15 bots and AI tags in the HUD and results, a room (the host's 4 bots seen by the guest, a 1-lap online race with identical results and every bot lap accepted, the host leaving). 72 checks, screenshots `bots-test/out/`. Exit code. | 6 min |

## v6-smoke — the v6 glue in `js/main.js` (+ `electron-main.js`), in the real game

The real `index.html` in offscreen windows with real key / mouse events, a fake Gamepad API, the real preload / host IPC /
server for the room; the pit, tyre, battery and golden-rule parts run time-warped (the `requestAnimationFrame` pump of
`gp-e2e/solo-page.js`, 1/60 s synthetic frames, the car driven through the fake controller). `page.js` (injected) wraps
`F1.ui.updateHUD` / `setPit` / `toast` and `F1.audio.play` / `beep` to see what `main.js` hands them, and has a pit-lane
driver (the control law of `car-v6/pit-drive.js`; `vLaneOut` = the speed from the box to the exit line; its recorder keeps
the box service (`service.work > 0`) and a hold at the exit line (`work 0`) apart) and `V.laneOut()` (from INSIDE the lane,
e.g. after R there: along the lane centre and out, then back to the line autopilot, which would steer into the pit wall
from in there); `golden-node.js` replays the same keys on `F1.createCar(F1.REF_SPEC)` in node.

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/v6-smoke/smoke.js` | Parts: `boot` (F1.game peek; a fresh install drives the 2026 standard car (v6.1), every other window the reference car picked through `ref-car.js`; the 設定 → 視野 FOV slider (v6.2), 車輛 tab, credits, password fields), `year` (2012 / 2021 / 2025 cars from the menu: spec, cockpit style, telemetry, racing line), `golden` (the 2025 standard car against the v5 build, bit for bit, and against node; a keyboard flick at speed flat-spots the tyres: < 1 cm in 10 s), `battery` (E deploys / braking harvests / 2010 has none), `pit` (Monza: T, a lap, Q, the lane at the limit, the pit strip, box 1, the service frozen with the lap clock running, jack / gun, new tyres; again at 120 km/h all the way: speeding, +5 s at the stop, and over the limit again after it: a second offence, held 5 s at the exit line (`penaltyStart` / `penaltyDone` toasts, frozen, the lap clock running, no tyres)), `monaco` (the 60 km/h lane on the harbour side), `tyres` (Grand Prix wear x5 in the RACE (qualifying wears at x1; skipped): 2 race laps, wear and grip, a stop), `audio` (worklet, rpm, shifts, beeps, M, slider), `room` (password, host picks 2014, guest follows, liveries, voices, Grand Prix x3 with the year (x1 in qualifying), parc fermé, pit-lane ghosts), `pad` (v6.1 map: A / RB held deploy (share above 0.25: it is traction-limited from a standstill), B / LB limiter, X compound; the pit-lane prompt, the strip's and the telemetry's key names (v6.2)). Screenshots `v6-smoke/out/` (read them). Exit code. Env `ONLY=<parts>`, `PORT` (default 24820), `V5=<folder of a v5 build>` (golden; default: the v5 snapshot worktree in the session scratchpad). | 2 min (150 checks since v6.2; 133 on 2026-10-01) |
| `npx electron devtests/v6-smoke/app-check.js` | The real app entry `electron-main.js` (its window made offscreen, a throw-away userData): the autoplay switch, boot without the error overlay, the sound running with no user gesture (worklet), Monza drives. 7 checks. Exit code. | 15 s |

## v6-critic — the game played like a player would (v6), looking for what is wrong or confusing

`lib.js` (windows, checks, keys / clicks, `pump` for time-warped windows; uses `gp-e2e/solo-page.js` and `v6-smoke/page.js`),
`driver.js` (a REAL-TIME pad driver for room windows, where the time warp cannot be used: centreline speed profile around
the lap into the pit lane, the own box, out again). Screenshots in `v6-critic/out/` (read them); most parts also print
`NOTE` lines with what was seen.

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/v6-critic/critic.js` | Parts: `newbie` (boot, the four menu tabs, first drive on Monza with E / Q / T / M, the HUD hint over the cockpit, menu and HUD at 1024 / 1920 / 800 px), `ers` (2011 KERS, 2014, 2026, 2025 standard: E against no E in lock-step), `pit` (Las Vegas: softs, R / pad Y / Esc / a car change while held in the box, the service resumes and runs out; Monaco: speeding into the box in the 60 km/h lane (at the limit after it), R inside the lane: the car put on the lane centre, stopped, visit and limiter kept, then driven out along the lane (`__v.laneOut`); Zandvoort: another track during the service), `tyres` (lock-up flat spot, grass dirt; Grand Prix wear x5 in the race (qualifying skipped: it wears at x1) to a puncture, the toast, limping into the box), `room` (password room, host + 2 guests in three teams, the host changes the year in free practice, garbage / hostile car ids, parc fermé attempts, Grand Prix wear x2 (x1 in qualifying, x2 in the race), a guest pits in the race (ghost, service, lap counted), a guest reconnects mid-race), `mash` (20 s of random keys and pad buttons, then on the grid). Exit code. Env `ONLY=<parts>`, `PORT` (default 24870). | 5 min (85 checks) |

## pit-test — the pit lane of `js/track.js` (`track.pit`)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/pit-test/check.js [track regex]` | Every track from the exported data: a pit lane exists, on the side of the real pit buildings; the complex (lane, boxes, tapers, out to the outer wall) belongs to its own stretch only; walls flagged and drawn; 16 boxes in slot order outside the driving lane, reachable over asphalt; **curtains**: no painted box within 10 m and no car stopped in a box (anywhere `js/pit.js` serves it: its origin within `BOX_ALONG` of the box point) within 8 m of a light curtain as drawn (the `pitCurtains` mesh), along the lane; entry < line < exit (a 'late' layout would be a warning; none since Monaco's line moved to Boulevard Albert 1er on 2026-10-01); the lane centre drivable at the limit; `laneD` / `wallD` / `inLane` / `paved` / `contains` consistent on a dense grid; "nothing else changed" against git HEAD and the v5 baseline `track-v5.js` (allowing for the real banked corners and the kerbs taken off the lane's asphalt: compared on a build without `bankOverrides`, the v5 pit-side kerb triangles skipped; where HEAD's own lane lies elsewhere, as Monaco's before it moved to the harbour side, HEAD's widening of its own pit-side wall is allowed for too); build time. Table (`boxCur` / `carCur` = the curtain clearances) and `all pit checks passed`. Exit code. | 75 s (84 s on 2026-10-01) |
| `node devtests/pit-test/drive.js [track regex\|all] [today\|paved\|both]` | The real `js/car.js` and `js/laps.js` drive into the lane, stop in boxes 14 and 3, cross the line in the lane and leave, against a ground truth (no wall, at most the limit, stopped within 0.3 m, the lap counted in the lane). Default 8 tracks, `all` for 40. Ends `all pit drive checks passed`. Exit code. (Written before `car.js` knew the pit lane: `paved` widens the lane's samples through a proxy; both modes now drive the same.) | 7 s (all) |
| `node devtests/pit-test/plot.js [ids\|all] [whole\|entry\|exit\|all]` | Top-view SVGs of the pit complex in `pit-test/out/` (render with `npx electron devtests/pit-test/svg2png.js <names>`). Not re-run on 2026-10-01. | - |
| `npx electron devtests/pit-test/shots.js` | Cockpit pictures of the lane in the real game (`TRACKS`, `VIEWS=far,approach,entry,lane,box,exit,across,top,topbare`). Not re-run on 2026-10-01. | - |

`devtests/track-fix/pit-check.js` was the copy of `check.js` adapted for the real banking / pit-kerb fixes of 2026-10-01; its
adaptations are folded into `check.js`, which supersedes it. `devtests/track-fix/shots.js` (`TRACK`, `SHOTS='[{"n":"box1","i":72,"d":17.8}]'`)
puts the car at any sample / offset for a cockpit picture, e.g. standing in box 1 to see the exit curtain ahead.

Note for time-warped harnesses: the cockpit's live mirrors render from inside the main render (the glass's
`onBeforeRender`). A render skip that also swallows those nested renders breaks three.js's render state (`Cannot read
properties of null (reading 'state')`): skip only the main camera's render (`v6-smoke/page.js` `__v.hookRenderer`).

## ui-v6 — the v6 parts of `js/ui.js` + `index.html` (menu tabs, 年份 / 車輛, 輪胎損耗, 設定, telemetry canvas, pit strip)

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/ui-v6/shots.js` | The real `index.html` without `js/main.js`, fed with the mock data of `mock.js` (part `real` loads the whole game): script order exactly the contract's (`js/boot.js` first: `index.html` has a Content-Security-Policy, no inline script), ids, the menu at several widths, the telemetry graphic bottom centre and clear of every HUD box, the pit strip texts (罰停中 / 換胎中 / 下次停站罰停 / 出口線罰停), the results overlay: clear of the graphic from 1260 px up; narrower, below the timing box / minimap (and the 選單 button under 1000 px) with the session box hidden (`#hud.res-open`), above the graphic when 250 px are left there, else 250 px tall over its top. 154 checks (v6.2 part `v62`: the Chinese cards, the search, 視野, 起跑輪胎), screenshots `ui-v6/out/`. Exit code. Env `ONLY=static,menu,hud,pit,checks,real,v62`, `DPR`, `TRACK`. | 35 s (2026-10-01) |

(`ui-gp/shots.js` checks the same script order, `js/boot.js` first.)

## seasons-calib — the driven calibration of the era physics (node)

`driver.mjs` is the node autopilot (the keyboard racing-line driver on the real `js/car.js`, 120 Hz, flying lap = best of
laps 2..3); with `{deploy: true}` it holds E on full throttle above 100 km/h, the battery refilled only by harvesting.
Since 2026-10-01 (the final review's S1: calibrated without the battery, pressing E put 2026 ahead of 2025 and 2014 ahead
of 2013) the calibration drives both the season's car and the 2025 standard car that way (`calibration.json` `deploy: true`).

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/seasons-calib/calibrate.mjs [--profile] [--check] [years...]` | Solves every season's grip scale so that the median over all 40 circuits of (its standard car's flying lap / the 2025 standard car's) equals the era pace index (target 0.03 %; `tools/build-cars.mjs` refuses more than 0.3 %), for KERS / 2026 the ERS harvest first (the per-lap recovery budget), repeated until it settles. Bracketed secant with a bisection fallback. Also records `noDeployMedian` (both cars without E). Writes `calibration.json` (fingerprinted: `js/car.js`, `js/raceline.js`, `js/track.js`, `tracks-data.js`, `tools/eras.json`; `node tools/build-cars.mjs --check` says when it is stale). Then `node devtests/seasons-calib/ers-effect.mjs` and `node tools/build-cars.mjs`. | 19..26 min (1151 s on 2026-10-01 evening; 26 min in the review r3 re-run, 2026-10-02) |
| `node devtests/seasons-calib/ers-effect.mjs [--check] [--jobs N] [years...] [--probe <year> <key> <tracks>]` | v6.1: the DRIVEN lap-time effect of every distinct battery of a season (tools/ers-data.json; E held, as the calibration drives) against that season's standard car on the 40 circuits -> `ers-effect.json` (fingerprinted with calibration.json; `tools/build-cars.mjs` refuses a stale one or one missing a battery some car has). Re-run after every `calibrate.mjs` and when tools/ers-data.json changes. `--check`: exit 1 when a re-run differs. | 4..5 min with 4 jobs |
| `node devtests/seasons-calib/check-drive.js [--tracks ..] [--years ..] [--teams] [--json f]` | Independent: its own analog autopilot (no E: it follows the line's no-battery speed profile) on 4 circuits the calibration did not pick; with `deploy` in calibration.json it compares with `noDeployMedian`. Every season within 0.3 % (0.26 % on 2026-10-01 evening; review r3 re-run: within 0.3 %). | 4 s |
| `node devtests/seasons-calib/drive-check.mjs [years...]` | Every car of every season on Monza / Silverstone / the Hungaroring (with E when the calibration used it): rank correlation with the real qualifying order (0.95..1.00 since the v6.2 recalibration; `all seasons ok`), character, off-track runs. Writes `drive-check.json`. Exit code. | 2.7 min |

## audio-test — `js/audio.js` (rendered offline, measured in node)

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/audio-test/render.js` | Renders the scripted scenes of `scenes.js` (launch, lap, pass-by, pack, lights, fades, V8, pit, one-shots ...; v6.2: `o_tunnel` (290 km/h through a tunnel) and `o_tail`, with stems; the page loads js/tunnels.js too) through `js/audio.js` into `out/<worklet\|nodes>/*.wav` + `.json` timelines (OfflineAudioContext, 60 Hz updates). `ONLY`, `BACKEND`, `STEMS=0`, `FPS=0`. The page loads `js/audio.js` alone, so the scenes use its built-in (v5) drivetrain, 12 500 rpm. | 45 s |
| `node devtests/audio-test/analyze.js [worklet] [nodes] [--selftest]` | The first author's analysis of those files: pitch, clicks, zipper, fades, peaks, Doppler, levels, events. 358 checks on 2026-10-01. Exit code. | 12 s |
| `node devtests/audio-test/ears.js [worklet\|nodes] [--png]` | The second reviewer's independent analysis (`dsp-lib.js`). 45 checks per back end. Exit code. | 30 s |
| `node devtests/audio-test/control-test.js` | The control layer in plain node (drivetrain, fallbacks, shifts, limiters, voices, junk input), and the tunnel reverb's graph on a fake offline context (review r3 PRES-2: one impulse response for Monaco's Portier 23.5 m + tunnel 25 m and for Singapore's 4.5 / 5 m soffits over several laps, a clearly other size made anew, `setTunnel(0, w, h)` priming it silently, a throwing `F1.tunnelImpulse` tried once). 37 checks. Exit code. | < 1 s |
| `node devtests/audio-test/tunnel.js [worklet] [nodes]` | v6.2, after `render.js`: the tunnel sound on the `o_tunnel` / `o_tail` renders, k = 1 against k = 0: louder inside by the designed amounts, the master compressor never over 3 dB, the 355..560 Hz band up more than the mix (+4.7 dB) and the 4..8 kHz band less, no level step in or out (the ramps checked on the rendered gains), the reverb connected while k > 0 and disconnected ~2 s after, a reverb tail inside (RT60 ~1.1 s) and none outside. 28 checks. Exit code. | < 1 s |
| `npx electron devtests/audio-test/live.js` | The live path: the real AudioContext in a muted Electron window (`--mute-audio`), `update()` from requestAnimationFrame with a scripted car: robustness, worklet / forced fallback / AudioWorklet hidden, `update()` timing and heap growth. 60 checks on 2026-10-01. `ONLY=bench,dsp,robust,live,nodes,hidden,load,stall`; `MODE=gesture` (pages that need a gesture); `SOUND=0.15` plays it through the speakers - do not set it while somebody is at the PC. Exit code. | - |
| `npx electron devtests/audio-test/asar-test.js` | js/audio.js from inside an asar archive, as the packaged game loads it (the worklet from a Blob URL). Exit code. | - |
| `npx electron devtests/audio-test/minimise-test.js` | The game's window minimised / hidden (backgroundThrottling false: the page is never told): without the main process's wiring the engine sounds on; `webContents.setAudioMuted` on minimise / hide (what electron-main.js does) and the page-side `F1.audio.setActive(false)` both silence it. Fake audio device, small unfocused windows. Exit code. | - |
| `npx electron devtests/audio-test/alloc-profile.js` | Diagnostic: where `update()` allocates (V8 sampling heap profiler). `BACKEND=nodes` for the fallback. No verdict. | - |

## scenery-pit — `js/scenery.js` against the pit lane (node)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/scenery-pit/check.js [trackId]` | Every track twice (OSM data, procedural): no scenery inside the pit lane, the light curtains visible from the track and the lane, a building behind the garage face, the facade texture's level. Ends `FAILS 0`. (`shots.js`, `cover.js`, `facade.js`, ...: pictures and probes.) | 16 s |

## hudmirrors-test — the HUD rear-view mirrors (`js/hudmirrors.js`, drawn by `js/main.js` since v6.1)

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/hudmirrors-test/run.js` | The mirrors as the game draws them (nothing in the project edited): layouts, cost per frame, robustness (a mirror pass that throws: switched off for good; V then only says 後照鏡無法顯示 and the V hints are hidden, review r3 FLOW-4). `ONLY=layouts\|cost\|robust`, `TRACK`. Screenshots and `out/results.json`. 41 checks on 2026-10-02. Exit code. | 72 s |

## pit-logic — `js/pit.js` over the real pit lanes (node)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/pit-logic/real-track.js [track regex]` | `drive-lane.js` moves a car by kinematics along every track's `track.pit` (no car physics) and feeds `pit.update` every 1/120 s step: the own box of slots 0 / 7 / 15 at the limiter speed (enter, service, done, exit), a run through at the limit + 20 km/h without stopping (speeding once, held 5 s at the exit line: `penaltyStart` / `penaltyDone`, held as main.js holds the car for any `pit.state.service`, nothing pending), flat out on the track beside the lane (nothing). `MOCK=1`: a contract-shaped mock lane instead. Ends `all ok`. Exit code. (`page-check.js` / `page.html`: the same in a browser page.) | 2 s |

## review-final — scripts of the final independent review (2026-10-01)

The reviewer's and the verifiers' probes (`game/`, `driving/`, `multiplayer/`, `perf/`, `seasons/`, `world/`,
`verify-*`) with their evidence. Not regression tests: most print NOTE lines; several assert the bug they were written to
confirm and now fail by design (e.g. `verify-flow/run.js` part g3, a Grand Prix ending during a pit service, and
`verify-driving/d4-exit-speeding.js`, which does not model main.js's hold). `package/` (a packaged copy of the app, about
600 MB) is git-ignored.

## v62-critic — the v6.2 changes played like the user would (2026-10-01)

`page.js` (injected after `gp-e2e/solo-page.js` and `v6-smoke/page.js`) is a player: it drives through the game's own input
paths only, the keys as main.js's own key handlers see them (KeyW / KeyS / KeyA / KeyD; the steering "tapped" like a keyboard
player does: held while the car's steer is short of what the corner needs) or the fake controller, aiming at the racing line
or the centreline at an offset with the car's own steering law (`perf.steerLockAt`), the speed held at a target. It records
speed, steer, wall contact, grass, wall clearance, the car's and the camera's pitch / roll, the tunnel light and sound values.

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/v62-critic/critic.js` | Parts: `hairpin` (Monaco's Fairmont hairpin at 45 / 50 km/h on the keys on the line, in the middle, from the outside, at 20 km/h, on the pad; the 2026 car and the 2025 reference car; the 2025 car on the keys from the start line), `tunnel` (Monaco: main.js's lights dimmed inside, `F1.audio.debug` reverb / k / wet gain, both kinds of mirror, disconnected again after), `spa` (Eau Rouge -> Raidillon at speed and standing: car / camera pitch), `bank` (Zandvoort T3 / T14, Madring's La Monumental: car / camera roll, speeds), `suzuka` (both roads through the bridge, R on and under the deck), `silver` (Silverstone's line / pits: a pit stop on the pad with the compound prompt and X; a Grand Prix on softs from the 大獎賽 tab, the grid), `names` (the cards' Chinese names, 26 searches typed with real keys / IME text: japan, 日本, 鈴鹿, suzuka, monza, 蒙札, us, uk, 英國 ...; the found card clicked), `fov` (設定 → 視野 with real keys, the camera, remembered after a restart), `pits` (Zandvoort and Singapore in 2024 at 60 km/h, then 2025 / 2026 at 80 after a year change in free practice: B, X, box 1). 134 checks, screenshots `v62-critic/out/` (read them), NOTE lines with the measurements. Exit code. Env `ONLY=<parts>`. | 75 s |
| `node devtests/v62-critic/bank-ab.js` | Zandvoort T3 / T14 and La Monumental built as they are and with that banking taken out: the racing line's and a driven car's speed through the corner, 2025 reference and 2026 standard car. The banked one must be faster (mean speed through the section). Exit code. | 20 s |

## v61-critic — the v6.1 changes played like a player would (2026-10-01)

`lib.js` (windows, checks, keys / clicks, the time-warp pump; also used by `v62-critic`). Muted offscreen windows, real
keys / mouse, a fake pad, a real room.

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/v61-critic/critic.js` | Parts: `boot` (the first boot opens on 2026 with its standard car, the key map's 後照鏡 / V column and pad row, the 設定 mirrors switch remembered after a restart, V toggles with a toast, held V toggles once, V ignored in the menu / while typing), `pad` (A / RB held with RT deploys while steering, not while braking; B and LB toggle the limiter once even pressed together; X cycles the compound; Y resets; View the racing line; Start the menu; the pit-lane prompts say B), `ers` (2014 Mercedes vs the 2015 McLaren-Honda on Monza's straight, the 2011 HRT without KERS: no bar, 無 KERS chip, E / A change nothing; the 2026 Aston Martin's weaker deploy), `room` (overtaking in a two-window room seen in the right mirror), `pit` (the light curtains stay out of the mirrors: 0 % of the mirror area at the entry and the exit), `gp` (start lights + toast, results overlay + toast at 1280x720 / 1920x1080 / 1100 / 1000 / 800 / 700 px: nothing covers the mirrors). 98 checks, screenshots `v61-critic/out/` (read them), NOTE lines. Exit code. Env `ONLY=boot,pad,ers,room,pit,gp`, `PORT` (24890). | 110 s |

## tunnel-test — the covered stretches of `js/tunnels.js` (v6.2)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/tunnel-test/check.js` | js/tunnels.js against the real track, scenery and car modules (node, no network): the API (Monaco's two stretches, `inTunnel` / `lightAt` / `sceneLight` / `covered`, `update`, NaN-free, deterministic, `dispose`, every circuit builds); per circuit with data: the tunnel walls coincide with js/track.js's barriers (the barrier is what the car hits), nothing of the tunnel in the drivable volume or over another part of the corridor, the soffit 6.8 m up, js/car.js steered into both walls stopped by the barrier, no scenery triangle inside; a synthetic stretch; `F1.tunnelImpulse`; `F1.TUNNEL_DATA` equals tools/tunnels.json. `OK (68/68)`, `out/check.json`. Exit code. | 8 s |
| `node devtests/tunnel-test/make-data.js [--check]` | Builds tools/tunnels.json (the covered stretches with their OSM sources and the decisions per candidate way) from the cached Overpass responses; prints the `F1.TUNNEL_DATA` literal to paste into js/tunnels.js. `--check`: exit 1 unless both are what it makes (`PASS ... == tools/tunnels.json "tracks"`). Re-run after a track's geometry changes (Madring was regenerated in v6.2). | 2 s |
| `node devtests/tunnel-test/osm-fetch.mjs [trackId...]` | NETWORK: fetches the covered / overpassing ways near each circuit from Overpass into `tunnel-test/cache/<id>.json` (git-ignored; re-runs do not refetch). All 40 fetched 2026-10-01 (~10 min with retries). | - |
| `npx electron devtests/tunnel-test/run.js` | The tunnel in the real game (muted): index.html loads js/tunnels.js, main.js builds one copy, the lights equal `tunnels.sceneLight` in every cockpit render, the reverb asked for (`F1.audio.debug`), no page errors; cockpit screenshots `out/<TAG>/*.png` (read them), numbers `out/<TAG>/results.json`. `OK 12/12` per circuit. Env `TRACK` (mc-1929; es-2026, sg-2008 also checked), `TAG`, `ONLY=shots,drive,perf`, `MODE=rec\|off`, `WHICH=<n>`. Exit code. | - |

## cockpit-test — `js/cockpit.js` + `js/carmodel.js`

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/cockpit-test/api.test.js` | Node, no WebGL (stub canvas): the contract API, what `setCar` builds / redraws / disposes, the wheel display's redraw budget, tyre wear and vibration, the display's lap delta with the real lap counter, the live mirrors (texture coordinates, rear cameras, the extra pass, `setMirrors`), the remote car against the v5 carmodel (`carmodel-v5.js`), `setHalo` along `F1.COCKPIT_HALO`; v6.2: `setFov` / `F1.COCKPIT_FOV` (range, clamps, proportional widening), the framing lens shift, the head cues of `F1.COCKPIT_HEAD`; the camera bit-identical to the v5 cockpit (`cockpit-v5.js`) at `setFov(70)` on a level road. `ALL PASS` (71 checks). Exit code. | 1 s |
| `npx electron devtests/cockpit-test/shots.js` | Cockpit screenshots + performance in the real game (muted, offscreen; the page is a copy of index.html with a hook file before js/main.js, since the CSP blocks inline scripts). Groups `tracks, lock, look, light, livery, display, remote, mirror, ext, perf, shape` (v6.2: Eau Rouge dip and Raidillon, Zandvoort T3, Madring's La Monumental, a flat corner, Monza's straight: camera / car pitch and roll -> `out/<TAG>/shape.json`). Env `TAG`, `ONLY`, `PERF=0`, `MIRRORS=0`, `APP_ROOT` (another copy of the game), `COCKPIT=<other cockpit.js>`, `FOV`, `HUD=1`, `SHAPE_WAIT`. Pictures to read, perf numbers; no verdict. | - |
| `npx electron devtests/cockpit-test/compare.js` | Before / after pictures side by side (`out/compare-<name>.png`): `PAIRS=...` (TAG before / after) or `BEFORE`, `AFTER`, `NAMES`, `LABELS`, `PREFIX`. | - |

## car-v6 — `js/car.js` v6 / v6.2 against the real tracks (node unless noted)

`car-v5.js` is the golden-rule ORACLE (the v5 car with the v6.2 steering law copied in; test/car.test.js drives the
reference car against it bit for bit). Do not edit it except for a deliberate, documented golden-rule change.

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/car-v6/crossing.js [track id = jp-1962]` | v6.2: Suzuka's bridge with the real car stepped as main.js steps it: both roads both ways at 6..90 m/s and 5 lateral offsets (the index never on the other road, no height step, no wall, no grass, no lap jump), R on every sample of both roads near the crossing (stays on its level), the car placed with a stale index (lands on the road whose height it has; a control without the height picks the wrong road). `16 / 16 crossing checks passed`. Exit code. | 1 s |
| `node devtests/car-v6/pit-drive.js [track regex \| all] [boxes]` | The real v6 car into every box of every pit lane and out (limiter, solid pit wall, asphalt): no wall contact, no grass on the pit asphalt, at most the limit + 0.5 km/h between the lines, stopped within 0.3 m / 0.2 m / 3 deg of the box. `all pit drives passed (640 lane visits ...)`. Exit code. | 4 s (all) |
| `node devtests/car-v6/pit-fuzz.js [track regex \| all] [runs = 240] [seed]` | The car thrown at every pit complex from random places / headings / speeds / inputs, plus targeted rams of the pit wall, its ends and the garage face: never through the wall, never across it, never beyond the outer wall, no stale sample, no NaN. Last line `TOTAL {"wall":0,"cross":0,"outer":0,"stale":0,"nan":0}`. Exit code. | 3 s (40 runs per track) |
| `node devtests/car-v6/ers.js [track regex \| all]` | The reference car's battery on the real tracks: a full store lasts ~32 s, a lap without deploying recovers 50..80 %, +15..20 km/h at the end of a long straight, the lap time gained. Ends `all ERS targets met`. Exit code. | 4 s |
| `node devtests/car-v6/car-bump.js [seeds = 200]` | `car.bump`: car-to-car impacts reach the tyres like wall impacts (flat spots, punctures); without it they did not; the path is bit-identical with and without it. Ends `OK`. Exit code. | < 1 s |
| `node devtests/car-v6/traction-cap.js` | Lists every CarSpec whose top speed `spec.traction` caps (48 of 197 on 2026-10-02, worst 2013 Marussia -6.3 km/h). No verdict. | < 1 s |
| `npx electron devtests/car-v6/game-check.js` | The v6 car and the v6.1 pad in the real game (the reference car through `ref-car.js`): gears, rpm, shift timing, tyre wear, the battery on A / RB (traction-limited from a standstill), harvest on S, B / LB limiter and X compound edges. Ends `n / n checks passed`. Exit code. Env `TRACK`, `SHOTS=0`. | - |
| `npx electron devtests/car-v6/smoke-wrap.js [harness]` | HISTORICAL (stage E): ran a harness against index.html minus the script tags whose files did not exist yet. Not needed any more. | - |

## track-fix — the track data fixes (2026-10-01 final review and the v6.2 audit corrections; node)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/track-fix/check-v62.js [tracks-data.js] [--before <old>]` | The audit corrections measured on the built tracks: the elevation features (grades over 20 / 50 / 100 m, rises and drops: Raidillon, Imola, Mugello, Monza's dip, Interlagos, Portimão ...), the start lines (Silverstone's at the Wing's start line since review r3), lengths, banking, Baku's width, the Suzuka bridge, the pit limits by season. Feature windows are mapped from the old lap through lat / lon. Ends `all v6.2 track checks passed` (or `FAILED n`). Exit code. | 2 s |
| `node devtests/track-fix/bridge-check.js [track id = jp-1962]` | A grade-separated crossing on both levels: road / runoff / paint vertices on the `surfaceY` of their own level, no wall / deck / abutment vertex inside the road of its level, the deck's underside above the lower road everywhere (clearance ~5.2 m), terrain under both roads, `locate` / `nearest` / `groundY` / `inCorridor` with y pick the right level. Ends `bridge checks passed`. Exit code. | 1 s |
| `node devtests/track-fix/bank-check.js` | Every real banked corner (`bankOverrides`): the full angle on its section, inside lower, eased out without a step; `surfaceY` follows it; the racing line's speed with vs without it (faster where grip limits; corners flatter than the derived banking and steering-lock-limited ones are only checked for side / extent). Ends `all banking checks passed`. Exit code. | 1 s |
| `node devtests/track-fix/pit-summary.js [tracks-data.js] > out.txt` | One line per track: the pit lane js/track.js lays out (side, limit, cross-section, from / entry / exit / to). For before / after diffs. | 2 s |
| `sh devtests/track-fix/run-suite.sh <outdir>` | The track battery in 14 steps (track-test, 3d build, raceline build / drive, laps drive / grid, pit check / drive, test/car, test/laps, test/track, check-v62, bridge-check, bank-check); logs and `summary.txt` (`rc=` per step) in `track-fix/<outdir>/`. | a few min |
| `node devtests/track-fix/xcheck.mjs [tracks-data.js]` | NETWORK (OpenTopoData, cached in `track-fix/cache/`): every circuit's elevation range against SRTM 30 m, NED 10 m (US) and the published ranges. Numbers to read. | - |
| `node devtests/track-fix/compare-ref.js`, `diff-data.js <old> [new]`, `corners.js <id> [minR]` | The game's heights against the verifiers' reference profiles (US, Monaco); what changed between two tracks-data.js files; the corners of a track with lat / lon (to place `bankOverrides`). Numbers to read. | < 2 s |
| `npx electron devtests/track-fix/shots.js` | The car standing anywhere (`TRACK`, `SHOTS='[{"n":"box1","i":72,"d":17.8}]'`, lat / lon, lap fraction, outside cameras, `DATA=<other tracks-data.js>`) for a cockpit picture. | seconds |

`pit-check.js` was folded into `pit-test/check.js`. `cache/` holds the DEM windows and the old tracks-data copies
(git-ignored), `base-v62/` and `after-v62/` the suite logs before / after the v6.2 data.

## ai-test — the computer drivers (`js/ai.js`) in node (v7)

The real game modules in node (js/car.js at 1/120 s, js/tyres.js, js/collide.js, js/pit.js, js/laps.js, net/session.js),
no Electron. Every script, its options and the latest numbers (old -> new for review r3) are in
`devtests/ai-test/README.md`; `AI_JS=<path>` runs another copy of js/ai.js. `sim.js` is the reference per-step loop the game
follows (`js/main.js` `stepBots`), `critic-sim.js` an independent harness with "actor" cars, `lib.js` the loader.

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/ai-test/matrix.js` | 14 circuits x {4 cars with qualifying, 8 cars reversed grid, 15 cars random grid wear x4}: every car finishes, 0 R, 0 stuck, 0 pit-lane speeding; contacts, passes, offs, order vs skill (Spearman). Exit code. Review r3: Spearman median 0.78, 174 passes, 3 contacts. | 1.5 min |
| `node devtests/ai-test/passing.js [seeds=1,2,3] [sc=B,C] [tracks=..] [list=1]` | Review r3: matrix races B / C with other seeds (84 races): passes, contacts (heavy), offs, order vs skill. Numbers to compare versions over several seeds. | 4 min per seed |
| `node devtests/ai-test/wrongway.js [v=8,15,40] [tracks=..]` | Review r3: a kinematic car coming the wrong way (never yields) meets 8 computer cars: head-ons, AI-AI contacts, pile-ups, R per speed. Reported, not judged (40 m/s: 12 head-ons, was 57). | 1 min per speed |
| `node devtests/ai-test/race.js track=.. n=.. laps=.. quali=.. grid=quali wear=.. skills=mixed year=..` | One Grand Prix with the full classification (`AILOG=1`: every driver's event log). | seconds |
| `node devtests/ai-test/alltracks.js [warm=1]` | All 40 circuits: `F1.AI.warmUp`, laps alone at skill 0 and 1, a pit stop in box 7. Exit code. | 15 s |
| `node devtests/ai-test/pace.js`, `calibrate.js` | The lap gap per level; `calibrate.js` solves `PACE` (paste the printed table into js/ai.js after any change to js/car.js physics, js/raceline.js or the track data; 2026-10-02: kept, 7.95 / 4.98 / 2.50 / 0.97 %). | 10 s / 30 s |
| `node devtests/ai-test/bridge.js` | Suzuka's bridge: one car on each road timed to meet (27 runs): no level jump, no contact, driving identical to alone. Exit code. | 1 s |
| `node devtests/ai-test/fingerprint.js [only=..] [warm=1]` | A bit-exact fingerprint of the driving (races, a parked car, a wrong-way car, erratic humans): two copies of js/ai.js that drive the same print the same lines; `warm=1` must print the same as without. | 12 s |
| `node devtests/ai-test/warmup.js`, `alloc.js` | think()'s allocation without / with `F1.AI.warmUp` in the first races, and per call in steady state (`node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 ... alloc.js suzuka 15`). Numbers to read. | 1.5 min / 1 min |
| `node devtests/ai-test/critic-start.js`, `critic-obstacle.js [mode=parked\|wrong]`, `critic-mixed.js [only=..]` | The AI critic's stress suites: 15-car standing starts into tight first corners (36 races), a stream of 10 cars meeting a stopped car / a wrong-way car, lapping, erratic humans, 10 cars pitting on the same lap, wear x5, seasons, the Monaco hairpin, determinism. Exit code (the wrong-way part is reported, not judged). | 45 s / 1 min / 50 s |
| `node devtests/ai-test/build-drivers.mjs [--js out.js]` | The two drivers of every car 2010..2026 (the rule of tools/build-cars.mjs) -> `drivers.json`; exit 1 if js/seasons-data.js disagrees. | 1 s |

## exe-smoke — the PACKAGED game

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/exe-smoke/smoke-exe.js [path/to/F1Drive.exe]` | Starts the exe (default `dist/win-unpacked/F1Drive.exe`) with `--mute-audio` and a remote-debugging port, drives it over the DevTools protocol: the menu, the host API, a drive (W), Esc, a Grand Prix's qualifying from the panel, the grid lights, v6: 17 seasons, a pit lane with 16 boxes, car spec + tyres + battery, the telemetry canvas, the audio engine running; v7: 5 computer drivers set in the 大獎賽 tab, the grid and the race start with them, the standings; no page errors; screenshots `exe-smoke/out/<prefix>-*.png`. 22 / 22 for v7.0 (2026-10-02). A window appears for ~30 s. Its temporary profile is removed with retries (review r3 PKG-5). Exit code. Env `PORT` (9333), `TRACK` (monza), `OUT`. | ~30 s |

## telemetry-test — `js/telemetry.js` (the broadcast graphic), no main.js

| Run | Checks | Time |
| --- | --- | --- |
| `npx electron devtests/telemetry-test/shots.js` | The canvas over a game screenshot, fed with scripted states: contact sheets and whole-window shots per size, then checks (backing store = CSS box x devicePixelRatio, the speed digits' right edge, junk input, pedal smoothing, a team change, no DOM access and only boxed numbers per frame, hidden canvas skipped, zoom), then a bench. Runs itself again at devicePixelRatio 2 in a child process: on Electron 44 that child's offscreen windows keep devicePixelRatio 1, so 5 of its 17 checks fail (environment, not js/telemetry.js); the DPR 1 pass is 17 / 17. Env `DPR`, `ONLY=shots,checks,bench`, `FRAMES`. Exit code. | 3.5 min |
| `npx electron devtests/telemetry-test/probe-cost.js`, `probe-alloc.js` | Diagnostics: where a frame's time goes, which lines allocate. No verdict. | - |

## tyres-test — `js/tyres.js` (written in stage E, before js/car.js used the tyres)

| Run | Checks | Time |
| --- | --- | --- |
| `node devtests/tyres-test/alloc.js` | `tyres.update()` allocates nothing over 3 million calls (GC trace, with a control that allocates). Ends `ok: update() allocates nothing`. Exit code. | 1 s |
| `node devtests/tyres-test/golden.js [track] [S\|M\|H] [rate] [laps]` | The v5 car (`car-v5.js`, a copy from before v6) patched in memory with the tyres: a new medium set bit-identical to the untouched car for 2 laps; a stint until the set is finished. Ends `all checks passed`. Exit code. | 1 s |
| `npx electron devtests/tyres-test/browser-load.js`, `node devtests/tyres-test/trace.js [life\|temps\|export\|all]` | js/tyres.js as a classic browser script gives the same states as in node; load traces of the reference car (numbers to read). | - |

## handling-test — the v6.2 steering-law / banking analysis (node unless noted)

The analysis behind v6.2's steering law and road-shape cues, run on COPIES (`make-variants.js` writes `variants/`; the
`today` variant is the project's files, `proposed` the law that was applied: since v6.2 they are the same). `ref/` holds
the F1 live-timing reference (git-ignored where large). Numbers to read, no verdicts: `hairpin.js` (Monaco's Fairmont
hairpin: radius, line speed, autopilot minimum, full-lock radius by speed), `hairpin-player.js` (turn-in windows for a
"player" on the keys at 20..55 km/h), `hairpin-follow.js`, `banking.js` (the real banked corners with / without their
override), `compress.js` (the road-shape load per track), `laps40.js` / `realism.js` (every track's lap with each variant;
lap time / real pole ratio), `stability.js` (keyboard step / tap response). `npx electron devtests/handling-test/bank-shots.js`:
screenshots at the banked corners (muted; `APP_ROOT`, `SHOTS`, `HEADROLL`).

## review-r3 — scripts of Fable review round 3 (2026-10-02)

The reviewers' and the verifiers' probes per area: `flow/` (`run.js`: the game played, `ONLY=search,menu,mirrors,pad,
pityear,xss,tunnel,drive,room`, `PORT` 24911), `ai/` (scenario scripts and logs: `yearscen.js` season change in the pit lane,
`idcoll.js` id collisions, `dbg1.js` ...), `net-bots/` (hostile server / bot messages), `driving/`, `world/`, `presentation/`,
`packaged/` (a packaged build over CDP), and `verify-ai/`, `verify-driving/`, `verify-flow/`, `verify-media/`,
`verify-multiplayer/` (`mp1-proto.js` ... `mp6-botlap.js`), `verify-product/`, `verify-world/`. Not regression tests: most
print NOTE / PASS / FAIL lines about the state they were written against, and several assert the bug they confirmed, so they
FAIL by design on the fixed tree. Every confirmed finding has its regression check in `test/` or in the harnesses above.

Older review folders: `review-1/` (the early review J0, 2026-10-01: driving / multiplayer / sound-graphics / world and
their verifiers) and `review-final/` (above). `track-audit/` holds the 40-circuit audit's per-circuit JSON and regional
notes (its OSM / DEM caches are git-ignored; the result is `docs/track-audit.md` + `tools/track-audit.json`).
`cars-data/` is stage C's 2026 car research (`node devtests/cars-data/check.js`: js/cars-data.js format, exit code;
`drive-check.js`: the estimates driven).
