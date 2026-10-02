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

## State (2026-10-03 ~06:00): v7.2 built in the working tree, NOT committed, NOT released

Working tree on top of HEAD 0f4e3af (= v7.1 + docs), uncommitted: **v7.2** = the room lobby (房間大廳: everybody gathers,
guests press 準備, the host's 開始 loads the track on every window behind a loading barrier; protocol 2) and the
single-player start panel (出發面板: a track card no longer drives; 開始 / Enter / pad A) — the user's 10-02 ~23:20 / 23:35
requests — plus the tyre wear recalibrated to real F1 stints (the user's "RB19 at Spa x1, puncture on lap 2": js/tyres.js
WEAR_K 3.9e-6 -> 1.0e-6, soft 1.65, hard 0.7, no flat spots from an unbraked slide; RB19 Spa x1 medium, human-like
driving: ~42 % after 12 laps, no puncture; devtests/tyre-test) and the lobby review's 2 confirmed findings fixed in
js/main.js (LOBBY-1 a host click on 取消 / 不等了 / 回到大廳 within 1 s of a room transition was dropped silently: now held
for the rest of that second; LOBBY-2 a double click on 開始 over a slow link: one start until its answer). Design
docs/lobby-design.md, contract js/README-interfaces.md "v7.2 room lobby", decisions docs/v6-plan.md "v7.2 room lobby".
Final re-run (2026-10-03 ~04:45..06:00, muted, working tree): 12 node suites (main 160 checks), build-cars --check,
every node devtest, every Electron harness: lobby-test 181/181, gp-e2e/bots 197/197, online 144/144, online-v6 66/66,
gp-smoke 203/203, v6-smoke 153/153, v6-critic 89/89, ui-gp 121/121, ui-v6 154/154; exe smoke 23/23 on an unpacked copy
of the working tree (no `npm run dist`). Known non-zero verdicts, all pre-existing: ai-test/critic-mixed (`erratic` at
Baku, 0.74), audio-test/minimise-test 5/7 (needs an audible window), tunnel-test/make-data --check (only the "checked"
notes), telemetry-test's DPR 2 pass, review/escape.js (pit lanes), start-clock against its mutant (it must fail).
Next (when the user / orchestrator says so): commit, `npm run dist` from a clean worktree, exe smoke on it, push, release
v7.2 (Traditional Chinese notes: the lobby, the start panel, the tyre wear).

## State before v7.2 (2026-10-02 13:30)

Released on GitHub (PUBLIC repo Heart-0001/f1drive since 2026-10-02 23:30; history rewritten that night to drop two personal e-mail addresses — every commit id before then changed, the docs were updated to the new ids; pre-rewrite backup bundle in the session scratchpad only): v6.1 = c2bd064, v6.2 = 6eb2c29, v7.0 = 9890cad (prereleases) and
**v7.1 = 79335dd (latest, F1Drive-v7.1.exe)**: computer drivers + Fable review round 3 (30 confirmed findings fixed) +
the AI pressing follow-up (no pressing into a braking car; passes 4328 vs 3961, contacts 48 vs 58 in 672 races).
HEAD = origin/main = 79335dd + docs commits (0f4e3af). Everything green: 12 node suites, build-cars --check, every node
devtest, every Electron harness (gp-e2e/bots.js 193/193), exe smoke 22/22 on the clean-worktree build.
(Then the user played v7.1 and asked for the lobby / start panel and reported the Spa puncture: v7.2 above.)

Known leftovers / not verified: Monaco wear x2 soft stints of bots can pass 93 % (1 run in 8); a hairpin alongside
misjudgement (Bahrain T10, 1 heavy contact in 168 races); passing between cars 1-2 % apart is rare (no slipstream in
js/car.js); Raidillon taken at 222-250 km/h (real ~300, flat out); the calibration driver's 2026 bias (-0.47 %,
documented); `review/escape.js` counts pit lanes as escapes (203, v1 script); while the host is in the menu his bots
stand still; no bot ownership transfer on host migration. Never verified: real two-machine internet play, a physical
controller (stubbed only), the sound by ear (measured only), Electron 44 on another machine / a weaker GPU; COTA total
elevation 30 m vs the published 41 m (lidar says the surface cannot reach 41 m).

`docs/claude-memory/` is a copy of the Claude Code project memory (for other machines).
