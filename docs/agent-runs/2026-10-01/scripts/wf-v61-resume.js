export const meta = {
  name: 'f1drive-v61-resume',
  description: 'F1Drive v6.1 (user requests): per-car battery data, gamepad on A/B/X/Y, default season 2026, two HUD rear-view mirrors top-left / top-right; then a player-eyes critic and a full re-run',
  phases: [
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

const data = { summary: 'DONE before the pause; full report in docs/agent-runs/2026-10-01/reports/v61-modules.txt (section seasons ERS data)' }
const pad = { summary: 'DONE before the pause; full report in docs/agent-runs/2026-10-01/reports/v61-modules.txt (section gamepad ABXY)' }
phase('Glue')
const glue = await agent(`${PRE('js/main.js, js/ui.js, index.html, and every devtests harness that needs updating for these changes; small surgical fixes elsewhere only if integration requires (list them)')}
The module changes just landed (reports):
### seasons ERS data
${JSON.stringify(data ? { summary: data.summary, apiNotes: data.apiNotes, openIssues: data.openIssues } : null, null, 1)}
### gamepad ABXY
${JSON.stringify(pad ? { summary: pad.summary, apiNotes: pad.apiNotes, openIssues: pad.openIssues } : null, null, 1)}
RESUMING AFTER A PAUSE: an earlier glue agent did part of this task and was stopped mid-way (it was adapting devtests/hudmirrors-test/run.js). Its partial edits are in js/main.js, js/ui.js, index.html and many harnesses (commit 27cea48 "WIP v6.1" vs e02cf43 shows exactly what changed: git diff e02cf43 27cea48). Review that partial work critically, keep what is right, finish what is missing, fix what is wrong.
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
