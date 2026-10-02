# F1Drive

First-person F1 driving game: Electron 44 + Three.js r149 (UMD, `lib/three.min.js`), classic browser scripts on
`window.F1`, no bundler, no asset files (sound, textures, data are generated in code). 40 real circuits with real
elevation, OpenStreetMap scenery, racing line, multiplayer, Grand Prix mode, seasons 2010..2026 with each team's car,
computer drivers (offline and in rooms). The user writes Traditional Chinese; UI text is Traditional Chinese (Taiwan usage).

- Run: `npm install`, then `npm start`. Package: `npm run dist` → `dist/F1Drive.exe` (portable).
- Dedicated multiplayer server: `npm run server` (TCP 24500).
- Module contract: `js/README-interfaces.md` (read this first; v5, v6, v6.1, v6.2, v7 and review-round-3 sections; the
  current script order is in the v7 section). Original plan: `docs/original-plan.md`. Live plan, decisions taken for the
  user, round outcomes and the remaining steps: `docs/v6-plan.md`. Agent reports: `docs/agent-runs/2026-10-01/reports/`.
- Data: `node tools/build-tracks.mjs [--check]` (tracks-data.js; DEM caches tools/elevation-cache*.json),
  `node tools/build-scenery.mjs` (Overpass cache not in git, ~45 min to refetch), `node tools/build-seasons.mjs`
  (F1DB → tools/seasons-raw.json), `node tools/build-cars.mjs [--check]` (js/seasons-data.js incl. each car's drivers, from
  seasons-raw, tools/eras.json, tools/liveries/, tools/ers-data.json, js/cars-data.js and the driven calibration
  devtests/seasons-calib/calibration.json + ers-effect.json). Whenever js/car.js physics, js/raceline.js, js/track.js,
  tracks-data.js or tools/eras.json change: `node devtests/seasons-calib/calibrate.mjs` (~20-26 min), then
  `node devtests/seasons-calib/ers-effect.mjs`, then `node tools/build-cars.mjs`; also re-check the AI levels with
  `node devtests/ai-test/calibrate.js` (paste its PACE table into js/ai.js if it moved by more than the solver's step).
- Tests: `for f in test/*.test.js; do node $f; done` (12 suites). Electron harnesses and how to run them:
  `devtests/README.md` (a row per harness: lobby-test (v7.2), v6-smoke, v6-critic, v61-critic, v62-critic, gp-smoke, ui-gp,
  ui-v6, hudmirrors-test, tunnel-test, gp-e2e solo / solo-v6 / online / online-v6 / bots, bots-test, mp-e2e, exe-smoke ...).
  Every harness window is MUTED by devtests/electron-userdata.js (the user heard the offscreen windows' engines once;
  never set SOUND=1 unless the user asks). Golden rule: the reference car ('2025-standard') drives bit-identically to the
  oracle devtests/car-v6/car-v5.js (test/car.test.js).
- `package.json` sets `signAndEditExecutable: false` because electron-builder's winCodeSign extraction fails
  without the symlink privilege.

## How the user wants the work done

- Delegate freely to Opus subagents / workflows (any number), one owner per file, contract in `js/README-interfaces.md`.
- After a round of work, have Fable agents do an independent review (code + requirements, not conclusions), verify
  each finding with a second agent, fix what is confirmed, re-run everything, repackage.
- GitHub: since 2026-10-01 ~22:00 the user wants each finished, verified round PUSHED to origin main and published as a
  GitHub release with the portable exe ("最後好了幫我丟github吧 讓我筆電可以玩"). Never push unverified WIP; build
  release exes from a clean worktree of the commit; push the tag before `gh release create` (a bare sha as --target
  fails with 422); release notes in Traditional Chinese.
- The user leaves work running unattended (overnight / while out): keep going, take sensible defaults, record them
  in docs/v6-plan.md; `node tools/watchdog.mjs` + `tools/keepawake.ps1` exist for that.

## State (2026-10-03 05:45, v7.2 released)

GitHub (PUBLIC repo Heart-0001/f1drive; history rewritten 2026-10-02 to drop two personal e-mail addresses — never write
anyone's address into files, commits or requests): releases v6.1, v6.2, v7.0 (prereleases), v7.1 and **v7.2 = 5ded440
(latest, F1Drive-v7.2.exe; also in dist/)**: room lobby (protocol 2, docs/lobby-design.md, contract 'v7.2 room lobby'),
single-player start panel, tyre wear fixed (was ~4x too fast). Everything green: 12 node suites (main 160), build-cars
--check, every node devtest, every Electron harness incl. devtests/lobby-test, exe smoke on the clean-worktree build.
Nothing is running.

Known leftovers: kerbs outside the white line count as grass in js/car.js (a little extra tyre wear / dirt);
ai-test/critic-mixed 'erratic' at Baku (a legend rear-ends a blind brake-testing human); Monaco x2 soft stints of bots
can pass 93 %; passing between cars 1-2 % apart is rare (no slipstream); Raidillon taken at 222-250 km/h (real ~300);
review/escape.js counts pit lanes as escapes; while the host is in the menu his bots stand still. Never verified: real
two-machine internet play (only a delaying proxy), a physical controller, the sound by ear, another machine / GPU.
Lesson: SendMessage to a running workflow agent's id resumes a parallel COPY of it — never message workflow agents.

`docs/claude-memory/` is a copy of the Claude Code project memory (for other machines).
