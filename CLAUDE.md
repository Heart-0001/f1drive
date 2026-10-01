# F1Drive

First-person F1 driving game: Electron 44 + Three.js r149 (UMD, `lib/three.min.js`), classic browser scripts on
`window.F1`, no bundler, no asset files (sound, textures, data are generated in code). 40 real circuits with real
elevation, OpenStreetMap scenery, racing line, multiplayer, Grand Prix mode, seasons 2010..2026 with each team's car.
The user writes Traditional Chinese; UI text is Traditional Chinese (Taiwan usage).

- Run: `npm install`, then `npm start`. Package: `npm run dist` → `dist/F1Drive.exe` (portable).
- Dedicated multiplayer server: `npm run server` (TCP 24500).
- Module contract: `js/README-interfaces.md` (read this first; v5 and v6 sections). Original plan: `docs/original-plan.md`.
  Live plan, decisions taken for the user, and the pause state: `docs/v6-plan.md`.
- Data: `node tools/build-tracks.mjs` (tracks-data.js; DEM caches tools/elevation-cache*.json),
  `node tools/build-scenery.mjs` (Overpass cache not in git, ~45 min to refetch), `node tools/build-seasons.mjs`
  (F1DB → tools/seasons-raw.json), `node tools/build-cars.mjs [--check]` (js/seasons-data.js from seasons-raw,
  tools/eras.json, tools/liveries/, tools/ers-data.json, js/cars-data.js and the driven calibration
  devtests/seasons-calib/calibration.json — rerun `node devtests/seasons-calib/calibrate.mjs` (~22 min) whenever
  js/car.js physics, js/raceline.js, js/track.js, tracks-data.js or tools/eras.json change).
- Tests: `for f in test/*.test.js; do node $f; done` (11 suites). Electron harnesses and how to run them:
  `devtests/README.md` (v6-smoke, v6-critic, gp-smoke, ui-gp, ui-v6, hudmirrors-test, gp-e2e solo / solo-v6 /
  online / online-v6, mp-e2e, exe-smoke ...). Every harness window is MUTED by devtests/electron-userdata.js (the
  user heard the offscreen windows' engines once; never set SOUND=1 unless the user asks).
- `package.json` sets `signAndEditExecutable: false` because electron-builder's winCodeSign extraction fails
  without the symlink privilege.

## How the user wants the work done

- Delegate freely to Opus subagents / workflows (any number), one owner per file, contract in `js/README-interfaces.md`.
- After a round of work, have Fable agents do an independent review (code + requirements, not conclusions), verify
  each finding with a second agent, fix what is confirmed, re-run everything, repackage.
- GitHub: since 2026-10-01 ~22:00 the user wants each finished, verified round PUSHED to origin main and published as a
  GitHub release with the portable exe ("最後好了幫我丟github吧 讓我筆電可以玩"); v6.1 = tag v6.1, prerelease, asset
  F1Drive-v6.1.exe. Never push unverified WIP; build release exes from a clean worktree of the commit.
- The user leaves work running unattended (overnight / while out): keep going, take sensible defaults, record them
  in docs/v6-plan.md; `node tools/watchdog.mjs` + `tools/keepawake.ps1` exist for that.

## State when paused (2026-10-01 15:10) — paused on purpose (the user's weekly usage was full; they are updating
Claude and will say "continue")

Last fully verified commit: `e02cf43` (v5 + v6 + the final Fable review's fixes; all node suites and every Electron
harness green on Electron 44.5.1). Built exes: `dist/F1Drive-v5-GrandPrix.exe` (01:46), `dist/F1Drive-v6-preview.exe`
(07:47, older than e02cf43). The FINAL `dist/F1Drive.exe` has NOT been built yet.

Working tree = WIP v6.1 on top of e02cf43, committed as a separate WIP commit (see git log). At pause time the 11
node suites pass, `build-cars --check` passes, and the game boots and drives (devtests/integration/shot.js), but the
Electron harnesses were mid-update and were NOT re-run.

What was in flight (details, run ids, reports: `docs/v6-plan.md` "PAUSED" section and `docs/agent-runs/2026-10-01/`):
1. v6.1 (user requests 10-01 ~11:30) — workflow script `docs/agent-runs/2026-10-01/scripts/wf-v61.js`:
   DONE: per-car battery data (tools/ers-data.json → build-cars / js/cars.js; 5 cars without KERS in 2011-12),
   gamepad on A/B/X/Y (A battery hold, B limiter, X next compound, Y reset, View racing line, RB / LB alternates).
   PARTIAL (glue agent stopped mid-way): START_YEAR 2026 in js/main.js, HUD rear-view mirrors top-left / top-right
   (js/hudmirrors.js, layout A, setting + key V — the V hint already shows), hints, harness updates for the new
   default year and pad indices. NOT DONE: the critic + full re-run stage.
2. v6.2 prep (stopped): js/tunnels.js (Monaco tunnel module, partial, not wired), devtests/tunnel-test/,
   devtests/handling-test/ (steering-lock + banking analysis on copies, partial).
3. Track data audit of all 40 circuits (stopped early: only caches / partial notes in devtests/track-audit/, no
   per-circuit results yet) — script `docs/agent-runs/2026-10-01/scripts/f1drive-track-audit.js`.

Next, in order: finish v6.1 (re-run its glue / critic stages on the current tree), then v6.2 (steering law so
Monaco's hairpin is drivable — today the car's min turning radius is 10 m at 10 km/h vs a 9.4 m centreline radius;
banking / slope presentation (Zandvoort, Madring, Spa Raidillon "not felt"); Monaco tunnel with lighting + reverb;
the pad compound choice made visible (pit-lane prompt, telemetry / pit strip "下一組 … X / T", GP starting
compound); the track audit and its verified data corrections; recalibration), then the full re-run, `npm run dist`,
`node devtests/exe-smoke/smoke-exe.js dist/win-unpacked/F1Drive.exe`, docs, local commit.

Known leftovers / not verified: real two-machine internet play, a physical controller (only stubbed), anyone
listening to the sound (only measured), Electron 44 on another machine; COTA total elevation 30 m vs the published
41 m (lidar says the surface cannot reach 41 m).

`docs/claude-memory/` is a copy of the Claude Code project memory (for other machines).
