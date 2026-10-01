export const meta = {
  name: 'f1drive-fable-final',
  description: 'F1Drive final independent Fable review of the whole game (v1..v6) incl. the packaged exe, a visual spot-check and multiplayer hardening; every finding adversarially verified; fixes by file group; full re-run',
  phases: [
    { title: 'Review', detail: 'six Fable reviewers, code + requirements only', model: 'fable' },
    { title: 'Verify', detail: 'independent verifiers reproduce or refute every finding' },
    { title: 'Fix', detail: 'one fixer per file group, disjoint files' },
    { title: 'Re-run', detail: 'every suite and harness, recalibration if needed' },
  ],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, line: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic'] },
      category: { type: 'string' }, description: { type: 'string' }, failureScenario: { type: 'string' }, suggestedFix: { type: 'string' },
    }, required: ['id', 'title', 'file', 'severity', 'category', 'description', 'failureScenario', 'suggestedFix'] } },
    coverage: { type: 'string' },
  },
  required: ['findings', 'coverage'],
}
const VERDICTS = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, real: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic', 'none'] },
    evidence: { type: 'string' }, fix: { type: 'string' }, primaryFile: { type: 'string', description: 'the one project file the fix belongs in (repo-relative)' },
  }, required: ['id', 'real', 'severity', 'evidence', 'fix', 'primaryFile'] } } },
  required: ['verdicts'],
}
const FIXREPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } },
    fixed: { type: 'array', items: { type: 'string' } }, notFixed: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, result: { type: 'string' } }, required: ['cmd', 'result'] } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged', 'fixed', 'notFixed', 'testsRun', 'notes'],
}

const CTX = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — a first-person Formula 1 driving game: Electron 33 + Three.js r149 (lib/three.min.js), classic ES5-style browser scripts on window.F1, no bundler, no asset files (everything is code and generated data). Multiplayer through a WebSocket relay that runs inside the host's game (or node net/server.js) and is reachable from the internet when a player port-forwards. Windows 11, Node 24, deps installed. A packaged build of the current code is dist/F1Drive-v6-preview.exe (its unpacked form can be rebuilt with npm run dist into a scratch copy only — do NOT overwrite dist/). Do NOT edit project files in the review, do NOT commit; put your scratch under devtests/review-final/<area>/.
Any Electron window you start (harness or the packaged exe) MUST be muted: the user is at the computer and does not want to hear engines — use devtests/electron-userdata.js (mutes by default) or pass --mute-audio to the exe; never set SOUND=1.
Requirements to judge against: docs/original-plan.md (the original brief), js/README-interfaces.md (module contracts v1..v6; the v6 section quotes the user's latest requests), docs/v6-plan.md (decisions taken on the user's behalf — judge whether they are reasonable, flag the ones that are not). The user's requests over time: all F1 circuits with real shapes, WASD, walls with collision, F1 cockpit first-person view; real elevation / banking; racing line; OSM scenery; load-based physics; LAN / internet multiplayer; gamepad; Grand Prix (Q-lap individual qualifying -> grid, R-lap race, host starts, single player too, no AI); engine sound (own + nearby, audible gear changes); broadcast-style centre telemetry; battery; seasons 2010..2026 with each team's car from real data and a year chosen for the Grand Prix / room; a refined, detailed first-person car (distant cars may stay simple); pit lane with light curtains, a pit limiter on a button (Q; E battery), random-duration tyre changes, several kinds of tyre wear.
You are reviewing independently: nobody gives you conclusions or test results — form your own by reading the code line by line and running things (node; offscreen Electron — see devtests/README.md for how every harness drives the game). Report only real problems with a concrete failure scenario, ranked honestly (critical = crash / security hole / data loss / game-breaking; major = clearly wrong behaviour a player hits; minor; cosmetic), plus requirement gaps.`

const AREAS = [
  { key: 'flow', prompt: `${CTX}\n\nYOUR AREA: the game as a whole through js/main.js, js/ui.js and index.html — every state and transition (boot, menu tabs, track pick, driving, Esc / resume, free practice, Grand Prix phases, pit visits and services, year / car changes, parc fermé, room create / join / leave / host migration / password, gamepad connect / disconnect), what the player sees and hears in each, consistency of texts (Traditional Chinese, Taiwan usage), the HUD layout at 1280x720 / 1920x1080 / narrow windows, XSS through names / car data / anything rendered, per-frame costs, anything that can get stuck or show stale state. Play it in offscreen Electron with real inputs and READ your screenshots.` },
  { key: 'data', prompt: `${CTX}\n\nYOUR AREA: the seasons and cars — js/seasons-data.js, js/cars.js, tools/build-cars.mjs, tools/build-seasons.mjs, devtests/seasons-calib/, docs/seasons-data.md, docs/eras-research.md, docs/cars-data-sources.md, js/cars-data.js, and how js/car.js / js/raceline.js consume a CarSpec. Check the method and the result: pick at least 12 cars across the years and verify their facts (team name as raced that year, chassis, engine, livery colours, Chinese team name as used in Taiwan, note text) against the web (load WebSearch / WebFetch with ToolSearch); check that each season's order and character are believable (champions quick, backmarkers slow, famous characteristics such as the 2014 Mercedes power advantage, 2023 Red Bull dominance), the era physics believable (V8 vs hybrid, KERS vs ERS, 2017 cornering jump, 2022 heavier), the attribution / licence obligations of F1DB (CC BY 4.0) met in the UI, and the generator deterministic and the calibration reproducible.` },
  { key: 'multiplayer', prompt: `${CTX}\n\nYOUR AREA: multiplayer and the Grand Prix rules — net/server.js, net/session.js, net/host.js, preload.js, electron-main.js (IPC, navigation, window security, autoplay / mute), js/net.js, js/gp.js. An earlier review led to anti-cheat lap proofs, impact limits, a room password and idle drops: attack them again from the internet (hostile raw WebSocket clients, protocol fuzzing, resource exhaustion, forged laps / progress / impacts, prototype-pollution-like ids, password brute force, desyncing others, crashing the host's game through the relay or the preload API) and play them as a player (lag, clock skew at lights out, joining mid-session, host leaving, reconnects, 16 players, year / car / wear rules, pit stops in a race, spectators).` },
  { key: 'driving', prompt: `${CTX}\n\nYOUR AREA: the driving model — js/car.js (CarSpec physics, drivetrain, ERS, limiter, tyres hook, pit lane and pit wall, car.bump), js/tyres.js, js/pit.js, js/laps.js, js/collide.js, js/gamepad.js, and their use in js/main.js (freeze during grid / service, lap clock during a service, pit.update, tyre / battery resets). Look for NaN / blow-ups, tunnelling, soft-locks, cheatable or lost laps (pit lane, cuts, reversing, R resets), pit logic exploits, tyre model artefacts, ERS behaviour (is the standing-start boost of +37 km/h in 8 s sensible?), gamepad edge cases, and verify the golden rule (the reference car on new medium tyres at wear rate 0, no boost / limiter / pit, behaves exactly as v5 — test/car.test.js claims it; check the claim yourself).` },
  { key: 'world', prompt: `${CTX}\n\nYOUR AREA: the world — js/track.js (geometry, walls, locate, banking incl. the new real banked corners, the pit lane, boxes, light curtains), tracks-data.js and tools/build-tracks.mjs (the new lidar elevation for COTA, Monaco, Las Vegas, Suzuka, Zandvoort, Indianapolis, Watkins Glen, Magny-Cours, Paul Ricard), js/scenery.js, js/raceline.js. VISUAL SPOT-CHECK: an earlier review already looked closely at 12 tracks and the builders at Monza, Monaco, Spa, Suzuka, Singapore, Las Vegas, Interlagos, Bahrain, Albert Park, Silverstone, Mexico, Zandvoort, COTA — cover EVERY OTHER track of the 40 (list them from tracks-data.js), from the cockpit at several points of the lap, at the pit entry / lane / exit, and from above, and READ every screenshot: floating / sunk / intersecting scenery, anything on the track or in the pit lane, walls across the road, missing walls where the car can escape, z-fighting, terrain spikes, wrong racing direction, a box inside a light curtain, curtains invisible or blinding.` },
  { key: 'exe', prompt: `${CTX}\n\nYOUR AREA: the packaged product and its performance / robustness — start dist/F1Drive-v6-preview.exe (or its win-unpacked copy rebuilt into a scratch folder) with a remote-debugging port (see devtests/exe-smoke/smoke-exe.js) and measure: cold start time, memory over 15 minutes of driving with track changes every few minutes (leaks: geometries, textures, audio nodes, listeners — watch renderer memory and WebGL info), frame time on this machine with and without mirrors / audio / telemetry, the worst hitch when loading a track, CPU of the audio worklet; check the Electron security posture (contextIsolation, nodeIntegration, sandbox, CSP, navigation / window-open handlers, what preload exposes and how net/host.js validates IPC input), what the package contains (package.json build.files: is anything needed missing or anything unneeded shipped — e.g. devtests, tools caches), the portable exe's behaviour on first run, and what happens when WebGL or audio is unavailable.` },
]

phase('Review')
const reviewed = await pipeline(
  AREAS,
  a => agent(a.prompt, { label: 'fable final: ' + a.key, phase: 'Review', model: 'fable', schema: FINDINGS }),
  (rev, a) => {
    if (!rev || !rev.findings || !rev.findings.length) return { area: a.key, review: rev, verdicts: [] }
    return agent(`${CTX.split('You are reviewing independently')[0]}
An independent reviewer reported the findings below about the area "${a.key}". You are the VERIFIER: for EACH finding reproduce it (probe under devtests/review-final/verify-${a.key}/) or refute it by careful reading; default to real=false when you cannot demonstrate it or the scenario is impossible in practice; re-rate severity from what you observed; recommend the fix you would apply; name the ONE project file the fix belongs in (primaryFile).
Findings:
${JSON.stringify(rev.findings, null, 1)}`, { label: 'verify final: ' + a.key, phase: 'Verify', schema: VERDICTS }).then(v => ({ area: a.key, review: rev, verdicts: v ? v.verdicts : null }))
  },
)

const confirmed = []
for (const r of reviewed.filter(Boolean)) {
  const byId = {}
  for (const f of (r.review && r.review.findings) || []) byId[f.id] = f
  for (const v of r.verdicts || []) if (v.real && v.severity !== 'none') confirmed.push({ area: r.area, ...byId[v.id], verifiedSeverity: v.severity, evidence: v.evidence, verifiedFix: v.fix, primaryFile: v.primaryFile })
}
log('confirmed: ' + confirmed.length)

// group by file ownership so fixers never share a file
const GROUPS = [
  { key: 'ui', re: /(^|\/)(js\/main\.js|js\/ui\.js|index\.html)$/, owned: 'js/main.js, js/ui.js, index.html' },
  { key: 'net', re: /(^|\/)(net\/.*|js\/net\.js|js\/gp\.js|preload\.js|electron-main\.js|package\.json)$/, owned: 'net/*, js/net.js, js/gp.js, preload.js, electron-main.js, package.json, test/server.test.js, test/session.test.js, test/gp.test.js' },
  { key: 'driving', re: /(^|\/)js\/(car|tyres|pit|laps|collide|gamepad)\.js$/, owned: 'js/car.js, js/tyres.js, js/pit.js, js/laps.js, js/collide.js, js/gamepad.js and their test/*.test.js' },
  { key: 'world', re: /(^|\/)(js\/track\.js|js\/scenery\.js|js\/raceline\.js|tracks-data\.js|tools\/build-tracks\.mjs)$/, owned: 'js/track.js, js/scenery.js, js/raceline.js, tracks-data.js, tools/build-tracks.mjs' },
  { key: 'data', re: /(^|\/)(js\/cars\.js|js\/seasons-data\.js|js\/cars-data\.js|tools\/build-cars\.mjs|tools\/build-seasons\.mjs|tools\/liveries\/.*|tools\/eras\.json|docs\/.*)$/, owned: 'js/cars.js, js/seasons-data.js (generated), js/cars-data.js, tools/build-cars.mjs, tools/build-seasons.mjs, tools/liveries/*, tools/eras.json, docs/*.md except docs/v6-plan.md' },
  { key: 'media', re: /(^|\/)js\/(audio|cockpit|carmodel|telemetry)\.js$/, owned: 'js/audio.js, js/cockpit.js, js/carmodel.js, js/telemetry.js' },
]
const buckets = {}
for (const f of confirmed) {
  const file = String(f.primaryFile || f.file || '').replace(/\\/g, '/')
  const g = GROUPS.find(g => g.re.test(file)) || GROUPS[0]
  ;(buckets[g.key] = buckets[g.key] || []).push(f)
}

phase('Fix')
const fixes = await parallel(GROUPS.filter(g => buckets[g.key] && buckets[g.key].length).map(g => () => agent(`Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive (Electron + Three.js, classic ES5 scripts on window.F1). Do NOT commit / push / npm run dist. The user is asleep: decide sensible defaults and record them.
Contract: js/README-interfaces.md; plan and decisions: docs/v6-plan.md; harness list: devtests/README.md. THE GOLDEN RULE: the reference car on new medium tyres at wear rate 0, no boost / limiter / pit, behaves exactly as v5 (test/car.test.js).
The final independent Fable review found the problems below in your area, and an independent verifier confirmed each (evidence and probes under devtests/review-final/). Fix every one at its ROOT with a minimal change in the style of the file, add a regression test where the logic is testable in node, re-run the relevant suites and harnesses, and report. Where a finding asks for a product decision, take the sensible one and record it.
You own ONLY: ${g.owned}. Other fixers own the other files right now; if a fix needs a change elsewhere, describe it exactly in notes.
NOTE: devtests/seasons-calib/calibration.json fingerprints js/car.js, js/raceline.js, js/track.js, tracks-data.js and tools/eras.json; if you change any of those, say so in notes (the re-run stage recalibrates).
Findings:
${JSON.stringify(buckets[g.key], null, 1)}`, { label: 'fix final: ' + g.key, phase: 'Fix', schema: FIXREPORT }).then(r => ({ group: g.key, report: r }))))

phase('Re-run')
const rerun = await agent(`Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive. Do NOT commit / push. The final review's fixes have just been applied by several agents (reports below). You are now the ONLY agent editing the project.
1. If node tools/build-cars.mjs --check reports stale, re-run node devtests/seasons-calib/calibrate.mjs, then node tools/build-cars.mjs, and compare the calibration table with the previous one (every season must still hit its pace index).
2. Re-run EVERYTHING and fix what broke (root causes, minimal): the node suites (for f in test/*.test.js), node tools/build-cars.mjs --check, devtests/v6-smoke/smoke.js, devtests/v6-critic/critic.js, devtests/gp-smoke/smoke.js, devtests/ui-gp/shots.js, devtests/ui-v6/shots.js, devtests/gp-e2e/solo.js, solo-v6.js, online.js, online-v6.js, mp-e2e (PORT=24810 DEAD_PORT=24811), node devtests/laps-test/drive.js, node devtests/raceline-test/test.js drive, node devtests/pit-test/check.js, node devtests/track-test/test.js, node devtests/scenery-test/test.js, node devtests/scenery-pit/check.js, the audio harnesses (devtests/audio-test render + analyze).
3. Update devtests/README.md for anything new.
Report exact results.
Fix reports:
${JSON.stringify(fixes.filter(Boolean).map(f => ({ group: f.group, summary: f.report && f.report.summary, notes: f.report && f.report.notes, notFixed: f.report && f.report.notFixed })), null, 1)}`, { label: 'final re-run', phase: 'Re-run', schema: FIXREPORT })

return { confirmed, fixes, rerun, refuted: reviewed.filter(Boolean).map(r => ({ area: r.area, total: r.review && r.review.findings ? r.review.findings.length : 0, confirmed: (r.verdicts || []).filter(v => v.real).length })) }
