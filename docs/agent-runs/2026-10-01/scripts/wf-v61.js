export const meta = {
  name: 'f1drive-v61',
  description: 'F1Drive v6.1 (user requests): per-car battery data, gamepad on A/B/X/Y, default season 2026, two HUD rear-view mirrors top-left / top-right; then a player-eyes critic and a full re-run',
  phases: [
    { title: 'Modules', detail: 'seasons data ERS · gamepad mapping' },
    { title: 'Glue', detail: 'main.js / ui.js / index.html: default year, HUD mirrors, hints, harness updates' },
    { title: 'Critic', detail: 'play it, fix, re-run everything' },
  ],
}
const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } },
    apiNotes: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, result: { type: 'string' } }, required: ['cmd', 'result'] } },
    bugsFound: { type: 'array', items: { type: 'string' } }, openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged', 'apiNotes', 'testsRun', 'bugsFound', 'openIssues'],
}
const SP = 'C:\\Users\\Heart\\AppData\\Local\\Temp\\claude\\C--Users-Heart-Desktop-f1Drive\\c2c193e6-e2b5-4b48-8955-beed8746e07e\\scratchpad\\'
const PRE = (owned) => `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — first-person F1 game (Electron 33 + Three.js r149, classic ES5 scripts on window.F1, no asset files). Windows 11, Node 24. Do NOT commit / push / npm run dist. The user is around but busy: decide sensible defaults, record them.
Read js/README-interfaces.md (v6 section), docs/v6-plan.md (section "User answers, 10-01 ~11:30 (v6.1)" is THIS task's requirement), devtests/README.md. Everything up to now is finished, reviewed and green (node suites test/*.test.js, devtests harnesses: v6-smoke, v6-critic, gp-smoke, ui-gp, ui-v6, gp-e2e solo / solo-v6 / online / online-v6, mp-e2e, laps / raceline / pit / track / scenery tests). Keep it that way.
Any Electron window MUST be muted: go through devtests/electron-userdata.js (mutes by default); never set SOUND=1 — the user is at the computer.
You own ONLY: ${owned}. Re-Read a file right before editing it. Verify by really running things; report exact results.`

phase('Modules')
const [data, pad] = await parallel([
  () => agent(`${PRE('tools/build-cars.mjs, js/cars.js, js/seasons-data.js (generated), test/cars.test.js, docs/seasons-data.md, devtests/seasons-calib/ (only if --check needs it)')}
YOUR TASK — per-car battery data (the user: "the battery should have different data for every car"). tools/ers-data.json (+ docs/ers-data.md) now holds, for every car 2011..2026, hasErs and deploy / harvest / store multipliers with sources. The researcher's notes are in ${SP}ers-report.txt — read them. Integrate:
- tools/build-cars.mjs reads tools/ers-data.json: deploy / harvest / store REPLACE the per-car perf.ersPower / perf.ersHarvest (do not multiply on top of the 2026 js/cars-data.js values — the file already folds them in); hasErs false -> that car's CarSpec has ers: null (no battery; the 2011-2012 cars that raced without KERS); store multiplies ers.store.
- js/cars.js: allow per-car ers null; widen the ERS multiplier sanitising to 0.75..1.15 (store 0.9..1.1); keep every other multiplier range as is; keep the Map-only lookups.
- ratings.ers: the bar must still spread sensibly (lower the gain to about 3-4 or clamp) and be 0 / hidden for no-battery cars; add the researcher's one-line Chinese battery note to the car's data (a field the menu can show, e.g. ersNote) where it is non-empty.
- IMPORTANT, changed today by the final review: the calibration now drives WITH the battery deployed (devtests/seasons-calib/driver.mjs, calibrate.mjs; docs/seasons-data.md), the 2026 ERS power fades with speed, and ERS deploy is traction-limited at low speed. So per-car ERS differences now change lap times: the per-car pace targets (each season's real qualifying order and ~1..1.5 % spread) must still hold — let the per-car level solve absorb the ERS differences (a car with a strong battery gets a correspondingly weaker chassis level, so its CHARACTER differs while its lap time stays on target), and re-run node devtests/seasons-calib/calibrate.mjs (~22 min) only if the standard cars change (they should not: the standard car of each season keeps multiplier 1). Confirm node tools/build-cars.mjs --check, node test/cars.test.js, node devtests/seasons-calib/drive-check.mjs (rank correlation) and check-drive.js pass (extend the tests: no-KERS cars have ers null, ERS ranges, 2014 Mercedes > Renault > Honda 2015 in deploy and harvest, 2026 order kept, determinism).
- docs/seasons-data.md: a short section on the battery data (source docs/ers-data.md).
Report the exact data changes and any field the UI should show.`, { label: 'seasons ERS data', phase: 'Modules', schema: REPORT }),
  () => agent(`${PRE('js/gamepad.js, devtests/gamepad-test/')}
YOUR TASK — the user wants the functions on the face buttons ("手把我是感覺做在ABXY那邊好一點"). New standard-mapping layout (decided): A (0) = battery boost (HOLD), B (1) = pit limiter (TOGGLE edge, pressed.limiter), X (2) = next tyre compound (edge, pressed.compound), Y (3) = reset (edge, pressed.reset), View / Back (8) = racing line (edge, pressed.line), Menu / Start (9) = menu (pressed.menu), RB (5) = battery too (hold), LB (4) = limiter too (edge), RS click (11) = recentre; triggers / sticks / D-pad unchanged. The raw XInput-style fallback layout (non-standard pads: buttons A0 B1 X2 Y3 LB4 RB5 Back6 Start7 LS8 RS9) mapped the same way. Keep the API (state.boost, state.pressed.{reset, line, menu, recentre, limiter, compound}, mergeInput, rumble, onChange, 500 ms edge resync) exactly; only the button indices change. Update the header comment and devtests/gamepad-test (its tests encode the old A/Y = reset, X = line, B = boost, Back = compound) and run it (node devtests/gamepad-test/gamepad.test.js). Report the final table for the integrator (hints text) and which harnesses elsewhere press pad buttons by index (grep devtests for buttons[ / pad indices) so the glue agent can update them.`, { label: 'gamepad ABXY', phase: 'Modules', schema: REPORT }),
])

phase('Glue')
const glue = await agent(`${PRE('js/main.js, js/ui.js, index.html, and every devtests harness that needs updating for these changes; small surgical fixes elsewhere only if integration requires (list them)')}
The module changes just landed (reports):
### seasons ERS data
${JSON.stringify(data ? { summary: data.summary, apiNotes: data.apiNotes, openIssues: data.openIssues } : null, null, 1)}
### gamepad ABXY
${JSON.stringify(pad ? { summary: pad.summary, apiNotes: pad.apiNotes, openIssues: pad.openIssues } : null, null, 1)}
YOUR TASK — the v6.1 glue:
1. Default season 2026: START_YEAR in js/main.js -> 2026 (a fresh install opens on 2026 and its standard car). Every harness that relied on the 2025 reference car being the default (the golden-rule checks, autopilots tuned on the reference car, solo / online e2e, gp-smoke, v6-smoke, v6-critic, ui tests ...) must now select 2025 / '2025-standard' explicitly before driving (e.g. a localStorage seed before boot or the real menu controls) — find them all (grep for 2025-standard, REF_SPEC, START_YEAR, golden) and keep every check meaning what it meant.
2. HUD rear-view mirrors (the user: two small mirrors at the upper left and upper right of the screen): integrate js/hudmirrors.js exactly as its author describes in ${SP}mirrors-report.txt (script tag after js/cockpit.js, the two frame divs as first children of #hud, the layout-A CSS: mirrors in the top corners and the timing box / session box / roster box / minimap / narrow-layout rules moved down under them — re-base the numbers on today's index.html, which the final review may have changed; main.js creates it once with exclude [cockpit.group] and calls hm.render(car.state, dt) right after the main render; hidden in the menu). Add a setting in the 設定 tab (後照鏡: 開 / 關, persisted) and a key (V) to toggle the HUD mirrors; keep the in-car glass mirrors as they are. Run devtests/hudmirrors-test/run.js against the integrated game (adapt it: it used to patch the module in) and READ the screenshots at 1280x720 and 1920x1080 (the start lights, toasts, session box and results overlay must not collide with the mirrors).
3. Battery per car in the UI: the car cards show the battery note (ersNote) when present and '無 KERS' / no battery bar for no-battery cars; the telemetry already hides the battery when spec.ers is null — check 2011 HRT in game.
4. Hints: both hint blocks (menu .keys and #hud-hint) describe the new pad layout (A 電池 (按住), B 限速器, X 換胎配方, Y 重置, View 行車線, Start 選單) and the V key.
5. Run and make green: all node suites (for f in test/*.test.js), node tools/build-cars.mjs --check, devtests/gamepad-test/*.test.js, and the Electron harnesses v6-smoke, v6-critic, gp-smoke, ui-gp, ui-v6, hudmirrors-test, gp-e2e/solo.js, solo-v6.js, online.js, online-v6.js, mp-e2e (PORT=24810 DEAD_PORT=24811) — update their pad-index presses and default-year assumptions; never weaken a check. Report every change.`, { label: 'v6.1 glue', phase: 'Glue', schema: REPORT })

phase('Critic')
const critic = await agent(`${PRE('js/main.js, js/ui.js, index.html, js/hudmirrors.js, js/gamepad.js, devtests/v61-critic/ (new); small fixes elsewhere when needed (list them)')}
The v6.1 changes (per-car battery data, A/B/X/Y pad layout, default season 2026, HUD rear-view mirrors top-left / top-right) were just integrated by another agent:
${JSON.stringify(glue ? { summary: glue.summary, apiNotes: glue.apiNotes, openIssues: glue.openIssues } : null, null, 1)}
Play it as a player with fresh eyes (offscreen Electron, muted, real keys and a fake pad; READ screenshots): first boot (2026 default), the 設定 mirror toggle and V, the HUD mirrors while overtaking / being overtaken (a second window in a room, or remote models), in the pit lane, at the start lights, with the results overlay and toasts, at 1280x720 / 1920x1080 / narrow; the pad on A/B/X/Y (battery hold on A while steering, limiter on B, compound on X, reset on Y, line on View); per-car battery: 2014 Mercedes vs 2015 McLaren-Honda deploy on the same straight, 2011 HRT without KERS (no bar, E / A does nothing), 2026 Aston Martin weakest. Fix what is wrong, then re-run everything listed in the glue task (all node suites, build-cars --check, gamepad tests, v6-smoke, v6-critic, gp-smoke, ui-gp, ui-v6, hudmirrors-test, solo, solo-v6, online, online-v6, mp-e2e) and report exact results.`, { label: 'v6.1 critic + re-run', phase: 'Critic', schema: REPORT })
return { data, pad, glue, critic }
