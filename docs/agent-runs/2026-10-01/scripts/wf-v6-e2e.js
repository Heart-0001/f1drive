export const meta = {
  name: 'f1drive-v6-e2e',
  description: 'F1Drive v6: bring the autopilot end-to-end Grand Prix harnesses up to v6 (solo time-warped, online real time) and add a full v6 Grand Prix with years, tyre wear, pit stops and battery; testers report, then one fixer applies and re-runs everything',
  phases: [
    { title: 'E2E', detail: 'solo (time-warped) and online (real time) testers, report-only' },
    { title: 'Fix', detail: 'one fixer, all files, full re-run' },
  ],
}
const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, result: { type: 'string' } }, required: ['cmd', 'result'] } },
    bugsFound: { type: 'array', items: { type: 'object', properties: {
      file: { type: 'string' }, line: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'cosmetic'] },
      symptom: { type: 'string' }, cause: { type: 'string' }, proposedFix: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'not-fixed', 'worked-around-in-harness'] },
      evidence: { type: 'string' } }, required: ['file', 'severity', 'symptom', 'cause', 'proposedFix', 'status'] } },
    notes: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged', 'testsRun', 'bugsFound', 'notes', 'openIssues'],
}
const PRE = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — first-person F1 driving game (Electron 33 + Three.js r149, classic ES5 scripts on window.F1). Windows 11, Node 24. Do NOT commit or push, do NOT run npm run dist. The user is asleep: decide sensible defaults, record them.
Read: js/README-interfaces.md (v5 Grand Prix rules and the v6 section: years 2010..2026 and cars, battery E, pit limiter Q, compounds T, tyre wear, pit lane with light curtains and random tyre changes), docs/v6-plan.md, devtests/README.md. v6 is now fully wired into js/main.js; devtests/v6-smoke/smoke.js (129 checks) shows how each v6 feature is driven from Electron; devtests/gp-e2e/ holds the v5 autopilot end-to-end harnesses: solo.js (single-player Grand Prix, time-warped rAF pump, 4 tracks) and online.js (4 windows, real host IPC + server, real time, Monaco) with their shared lib.js / page.js / autopilot.js — read them first.
Known state (from the glue agent): solo.js on Monza now fails 4 of 137 checks — three are expected v6 changes (localStorage 'f1drive.gp' is now {q, r, wear}; #hud-speed is gone: read F1.game.car.state or the telemetry; the results subtitle now names the season) and one, 'a lap after the upsets', timed out, probably because the deliberate wall upsets now flat-spot or puncture a tyre (tyre damage is real in v6). Since v6 the server also rejects laps not backed by driving (glno 'not-driven' / 'no-data'), relays impacts only between nearby fresh cars, and supports an optional room password.
Each Electron harness needs its own userData dir (devtests/electron-userdata.js). SOUND: the user is at the computer and heard the harness windows' engines through the speakers. devtests/electron-userdata.js now mutes every harness window (Chromium --mute-audio + webContents.setAudioMuted; the audio graph still runs, so F1.audio.debug and analysers keep working) unless SOUND=1 is set. Every Electron harness you write or run MUST go through it (or mute itself the same way); never set SOUND. Check with the Windows volume mixer idea in mind: nothing may be audible. Verify by really running; report exact commands and results.`

phase('E2E')
const E2E_RULES = `You are a TESTER: another tester runs a different harness at the same time, so do NOT edit product files (js/, net/, index.html, electron-main.js, preload.js, tools/, test/). Pin down product bugs (file:line, cause, minimal patch), prove a proposed patch against a patched COPY through the harness's PATCH mechanism (devtests/gp-e2e/lib.js), and report them (status 'not-fixed' or 'worked-around-in-harness'). Tell harness mistakes from product bugs. Your harness must be re-runnable with one documented command and exit non-zero on any failed check.`

const [solo, online] = await parallel([
  () => agent(`${PRE}

${E2E_RULES}

YOUR TASK: devtests/gp-e2e/solo.js up to v6, then a new v6 scenario. You own devtests/gp-e2e/solo.js, solo-page.js, autopilot.js and a new devtests/gp-e2e/solo-v6.js (+ page code). lib.js / page.js are shared with the online tester: coordinate by only adding, never changing behaviour the online harness relies on (or copy what you need).
1. Make solo.js green again on all four tracks: update the three expected v6 expectations; for the upsets, decide whether the car must be allowed to recover (pit stop, or setWearRate(0) for that part) — do not weaken what the check proves about recovery. Keep time-warping: the offline Grand Prix clock is the game clock; pit services and toasts use the game clock or the wall clock? — find out and make the harness robust to it.
2. New devtests/gp-e2e/solo-v6.js — single-player Grand Prix with v6 features, time-warped, driven by the autopilot through the real input path (fake pad / keys), on Monza (it-1922), Suzuka (jp-1962) and one of Zandvoort (nl-1948) or Indianapolis (us-1909) whose banking may have just changed:
   - choose year 2012 through the real menu controls, pick a 2012 car (not the standard one); start with Q = 1, R = 6, wear x5;
   - the autopilot deploys the battery (E) on straights and manages it (KERS in 2012), and makes ONE pit stop in the race: toggles the limiter (Q) before the entry curtain, drives the lane at the limit, stops in its own box (slot 0), waits for the random service, takes the compound chosen with T, leaves, turns the limiter off after the exit curtain;
   - check: year and car shown in menu / HUD / telemetry; KERS battery behaviour (small store, drains, recharges); tyre wear rising in the telemetry icons and grip dropping, restored by the stop; the service time in 2.0..4.5 s (+5 s only when speeding); the lap through the pit lane counted and its time including the stop; race time = session clock from lights out (the stop costs time); results correct; no error overlay, no console errors;
   - a second run with year 2026 and the Mercedes: ERS deploys much more power (check the speed gain on a straight vs not deploying), a pit stop with speeding on purpose (penalty +5 s applied at that stop).
   READ screenshots at: the year / car menu, grid with lights, KERS / ERS deploying on a straight (telemetry), entering the pit lane through the curtain, the service countdown, leaving, results.`, { label: 'e2e solo v6', phase: 'E2E', schema: REPORT }),
  () => agent(`${PRE}
TCP ports reserved for you: 24850-24899.

${E2E_RULES}

YOUR TASK: devtests/gp-e2e/online.js up to v6 and a v6 online scenario. You own devtests/gp-e2e/online.js, bench.js, start-clock.js and a new devtests/gp-e2e/online-v6.js (+ page code). lib.js / page.js are shared with the solo tester: only add, never change existing behaviour.
1. Make online.js green again (Monaco, 3-4 windows, real time): adapt to the v6 changes (HUD, storage, the server's new proof-of-driving and impact rules — the harness's forged-lap checks must now expect 'not-driven' / 'no-data' where they fake laps without driving; the deliberate nudge between cars must use real driving).
2. New devtests/gp-e2e/online-v6.js — a room with a PASSWORD: host A creates it with a password, B joins with the right password, C first with a wrong one (refused with the Chinese message, error 'password'), then the right one. Host picks 2014 in free practice: B and C follow (toast, car switched to a 2014 car); each picks a different 2014 team (liveries visible on the others' cars — screenshot); host starts a Grand Prix Q = 1, R = 3, wear x3 on Monaco; all three autopilots deploy ERS; each makes one pit stop in the race in its own box (slots 0, 1, 2) — at least two of them in the lane at the same time (they must be ghosts to each other: no impact), light curtains visible; results identical on every window with the stops' time included; parc fermé blocks the car pickers during the session; after 結束 everyone back in free practice with their cars.
   Also measure what the v6 load (worklet audio x 3-4 windows, live mirrors, telemetry) does to the frame rate each window gets; if the machine cannot hold a usable rate with 4 windows, run 3 and say so.
   READ screenshots per phase per role.`, { label: 'e2e online v6', phase: 'E2E', schema: REPORT }),
])

phase('Fix')
const fix = await agent(`${PRE}
TCP ports reserved for you: 24800-24899.

You are now the ONLY agent editing the project and may edit any file. The two testers have finished; their reports:
### solo
${JSON.stringify(solo, null, 1)}
### online
${JSON.stringify(online, null, 1)}

ALSO FIX (reported by the integration critic): at Las Vegas and Monaco box 1 lies inside the exit light curtain, so the translucent green planes fill the driver's whole view during the stop — in js/track.js make sure no box (and no stopped car) is ever inside or within a few metres of either curtain on any of the 40 tracks (move the curtain to after the last box / before the first, or shift the boxes), and add that as a check in devtests/pit-test/check.js. NOTE: devtests/seasons-calib/calibration.json fingerprints js/track.js; if node tools/build-cars.mjs --check reports 'stale' after your change, re-run node devtests/seasons-calib/calibrate.mjs then node tools/build-cars.mjs (about 3 min) and confirm the calibration table did not move (the change is visual / layout only).
YOUR TASK: verify each reported product bug yourself (testers can be wrong), fix the root cause with minimal changes in the style of the file (with a node regression test where the logic is pure), remove harness workarounds, finish any scenario a tester could not complete, and re-run EVERYTHING on the final tree: the nine node suites (collide, session, laps, gp, server, car, tyres, pit, cars), node tools/build-cars.mjs --check, devtests/gp-e2e/solo.js, solo-v6.js, online.js, online-v6.js, devtests/v6-smoke/smoke.js, devtests/gp-smoke/smoke.js, devtests/ui-gp/shots.js, devtests/ui-v6/shots.js, mp-e2e (PORT=24810 DEAD_PORT=24811), node devtests/laps-test/drive.js, node devtests/raceline-test/test.js drive, node devtests/pit-test/check.js (it fails 30 checks on 18 tracks since tonight's real-banking and pit-kerb fixes changed legitimately what it compares; devtests/track-fix/pit-check.js is an adapted copy that passes 40/40 — fold its adaptations into devtests/pit-test/check.js so the original harness is green again, without weakening the other checks), node devtests/track-test/test.js, node devtests/scenery-test/test.js, node devtests/scenery-pit/check.js. READ a few final screenshots. Update devtests/README.md for the new / changed harnesses. Report every product change and everything still unverified.`, { label: 'e2e fix + full re-run', phase: 'Fix', schema: REPORT })
return { solo, online, fix }
