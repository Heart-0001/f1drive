# F1Drive

First-person F1 driving game: Electron + Three.js r149 (UMD, `lib/three.min.js`), classic browser scripts on
`window.F1`, no bundler. 40 real circuits with real elevation, OpenStreetMap scenery, racing line, multiplayer.
The user writes Traditional Chinese; UI text is Traditional Chinese.

- Run: `npm install`, then `npm start`. Package: `npm run dist` → `dist/F1Drive.exe` (portable).
- Dedicated multiplayer server: `npm run server` (TCP 24500).
- Module contract: `js/README-interfaces.md` (read this first). Original plan: `docs/original-plan.md`.
- Regenerate data: `node tools/build-tracks.mjs` (elevation cached in `tools/elevation-cache.json`),
  `node tools/build-scenery.mjs` (Overpass cache `tools/scenery-cache/` is NOT in git: ~54 MB, ~45 min to refetch;
  `scenery-data.js` itself is committed).
- Tests: `node test/collide.test.js`, `node test/server.test.js`, `node test/session.test.js`.
  `devtests/` holds the agents' scratch suites (track build, physics, raceline drive test, scenery corridor
  check, gamepad, Electron screenshot harnesses). They were written against absolute paths under
  `C:\Users\user\Desktop\f1drive` and `%TEMP%\f1drive-*-test` — fix the paths before running elsewhere.
- `package.json` sets `signAndEditExecutable: false` because electron-builder's winCodeSign extraction fails
  without the symlink privilege.

## How the user wants the work done

- Delegate freely to Opus subagents (any number), one owner per file, contract in `js/README-interfaces.md`.
- When everything is finished, have a Fable agent do an independent review (give it code + requirements, not
  conclusions), fix what it confirms, then repackage. A first review was done on v1; a SECOND one is still owed.

## State when paused (2026-09-30) — work was interrupted mid-task

Done and working (game launches, smoke-tested on Monza/Spa):
- 3D tracks: elevation (`elev`), curvature-derived banking, shared mid walls at close parallel roads,
  per-sample wall distances, terrain, `groundY` / `terrainY` / `nearest` / `inCorridor`.
- Load-based car physics (banking, slope gravity, crest/dip load, v² downforce), `F1.CAR_PERF` helpers.
- Racing line (`js/raceline.js`, `L` toggles): 40/40 tracks pass the colour-following drive test.
- Scenery: `scenery-data.js` (OSM, ODbL — credit shown in the menu) + `js/scenery.js`, sky dome.
- Multiplayer: `net/server.js`, `net/host.js`, `preload.js`, `js/net.js`, `js/carmodel.js`, `js/collide.js`.
  Host clicks 建立房間, others 加入房間 with IP[:port]. Tested with two windows in one process only.
- Gamepad module `js/gamepad.js`, analog input in `js/car.js`, head-look in `js/cockpit.js` (`setLook`,
  `centreLook`) — all tested with a stubbed Gamepad API.

IN PROGRESS / NOT DONE (the agent doing these was stopped part-way; review its partial work before trusting it):
1. **Gamepad is NOT wired** into `js/main.js` / `index.html` yet. Wiring: add `<script src="js/gamepad.js">`
   after cockpit.js; in `frame()` poll the pad, `cockpit.setLook(ps.lookX, ps.lookY)`, handle
   `ps.pressed.{menu,reset,line,recentre}`, pass `F1.gamepad.mergeInput(input, driveInput)` to `car.update`,
   `F1.gamepad.rumble(...)` on hits, poll on an interval while the menu is open so Start can resume, add a
   controller hint to both hint blocks. Must respect the Grand Prix start-light input lock.
2. **Grand Prix mode** (user request: X laps of individual qualifying decide the grid, then an X-lap race; both
   X configurable; host starts it; also usable single-player; no AI cars). Partial: `net/session.js` (rules
   module) + `test/session.test.js`, `js/laps.js`, and partial edits in `net/server.js` / `js/net.js`.
   Not yet done: `js/main.js`, `js/ui.js`, `index.html` integration (config panel, quali HUD + timing table,
   ghost cars in quali, grid placement, synchronised 5-light start with input lock, race standings,
   chequered-flag rule, results screen), server integration tests, end-to-end Electron test. Also verify lap
   counting at Suzuka's flat crossover, where `car.state.sampleIndex` can briefly jump to the other branch.
3. `npm run dist`, launch the exe, then the second Fable review (include: all of the above, a visual spot-check
   of scenery on tracks nobody looked at, multiplayer protocol hardening).

Known leftovers:
- COTA elevation is too flat (90 m DEM; a 30 m source for that track would fix it); Monaco is exaggerated.
- Monaco's `points[0]` is up the hill towards Casino, not on the harbour start straight.
- Kyalami's racing direction may be reversed in the dataset (unverified).
- Never tested: real two-machine / internet multiplayer (port forwarding, firewall), a physical controller,
  the packaged exe with multiplayer.
- Cosmetic: no Monaco tunnel, raster-stepped sand/water patch edges, no driver arms in the cockpit.
- Low-speed slide down banking was requested as optional and not implemented.

`docs/claude-memory/` is a copy of the Claude Code project memory from the original machine.
