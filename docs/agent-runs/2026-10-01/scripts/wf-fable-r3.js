export const meta = {
  name: 'f1drive-fable-r3',
  description: 'F1Drive Fable review round 3 of everything since e02cf43 (v6.1 mirrors / pad / per-car battery, v6.2 steering / track data / bridge / tunnels / cockpit / names, v7 AI drivers offline + online); every finding verified; fixes by file group; full re-run; docs',
  phases: [
    { title: 'Review', detail: 'seven Fable reviewers, code + requirements only', model: 'fable' },
    { title: 'Verify', detail: 'independent verifiers reproduce or refute every finding' },
    { title: 'Fix', detail: 'one fixer per file group, disjoint files' },
    { title: 'Re-run', detail: 'recalibration if needed, every suite and harness' },
    { title: 'Docs', detail: 'contract, harness list, plan, CLAUDE.md' },
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

const CTX = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — a first-person Formula 1 driving game: Electron 44 + Three.js r149 (lib/three.min.js), classic ES5-style browser scripts on window.F1, no bundler, no asset files (everything is code and generated data). Multiplayer through a WebSocket relay inside the host's game (or node net/server.js), reachable from the internet when a player port-forwards. Windows 11, Node 24, deps installed. Do NOT edit project files in the review, do NOT commit; put your scratch under devtests/review-r3/<area>/ (git-ignored). To test a packaged build, make it in a scratch git worktree of HEAD with a node_modules junction (never overwrite dist/).
Any Electron window you start MUST be muted: use devtests/electron-userdata.js (mutes by default) or pass --mute-audio to an exe; never set SOUND=1.
The last full review (round 2) ended at commit e02cf43; review what changed since (git diff e02cf43..HEAD) in the context of the whole game. Requirements: docs/original-plan.md, js/README-interfaces.md (contracts; parts of v6.1 / v6.2 / AI may still be undocumented there — the code and the reports are then the reference), docs/v6-plan.md (decisions taken on the user's behalf: judge whether they are reasonable), docs/track-audit.md, the reports in docs/agent-runs/2026-10-01/reports/ (v61-*.txt, v62-reports.txt, ai-report.txt — read them as claims to check, not as truth).
The user's requests since round 2: default season 2026; battery data per car; gamepad on A/B/X/Y (A battery hold, B limiter, X next compound, Y reset); two small HUD rear-view mirrors top-left / top-right; Monaco's slowest hairpin must be drivable; banked corners (Zandvoort, Madring) and Spa's steep climb must be felt; recreate the Monaco tunnel; re-check ALL circuits' data; qualifying tyre wear stays x1; the pad's tyre-compound choice must be discoverable; Suzuka must be findable ('japan', Chinese names); Suzuka's crossover must be a bridge (one road over the other), not a crossroads; computer players (AI): in the room you choose how many and how strong, single player too.
You are reviewing independently: nobody gives you conclusions or test results — form your own by reading the code line by line and running things (node; offscreen Electron — devtests/README.md explains how every harness drives the game). Report only real problems with a concrete failure scenario, ranked honestly (critical = crash / security hole / data loss / game-breaking; major = clearly wrong behaviour a player hits; minor; cosmetic), plus requirement gaps.`

const AREAS = [
  { key: 'flow', prompt: `${CTX}\n\nYOUR AREA: the game flow in js/main.js, js/ui.js and index.html as changed since e02cf43 — the HUD mirrors (V, setting, failure path), the pad on A/B/X/Y, the fresh-install 2026 default, Chinese names + country search (try many queries in English, Traditional and Simplified Chinese), the tyre-compound prompt / pit strip / telemetry badge / starting compound, the FOV setting, per-season pit limits when the year changes (menu, room, Grand Prix, mid-practice), tunnel lighting glue, and the AI controls (count, skill, persistence, guests read-only, locks during a session, lineup display, AI tags in standings / results / roster / minimap / name tags). Play it in offscreen Electron with real keys and a fake pad, at 1280x720, 1920x1080 and narrow windows, and READ your screenshots. Look for stuck or stale state, wrong texts (Traditional Chinese, Taiwan usage), XSS through bot / driver names, per-frame costs.` },
  { key: 'ai', prompt: `${CTX}\n\nYOUR AREA: the computer drivers — js/ai.js and how js/main.js runs them offline (per-step loop, placement on the grid / in boxes, freezing, collisions with the player and each other, pit events, lap counting, the Grand Prix phases, warm-up). Race against them as a player would (offscreen Electron with an autopilot or scripted inputs, and the node sims in devtests/ai-test/): do they race believably at each level (新手 ... 傳奇, 混合), pass and defend fairly, avoid / survive the player's mistakes (spins, stopping on the line, driving the wrong way, R resets), obey blue flags, pit sensibly (wear x1..x5), never get stuck or cheat (cutting, pit-lane shortcuts, lap counted wrong), at every circuit type (Monaco, Suzuka's bridge, Baku castle, Spa, Las Vegas, Zandvoort banking)? Is the 'slower car moves aside on a straight' device sensible? Frame cost with 15 bots, GC churn over a long race.` },
  { key: 'multiplayer', prompt: `${CTX}\n\nYOUR AREA: multiplayer with bots — net/server.js, net/session.js, js/net.js, js/gp.js, preload.js, electron-main.js and the online host / guest paths in js/main.js. Attack the new bot messages from the internet (hostile raw WebSocket clients: bots / bot states / bot laps / impacts from a guest, oversized or malformed fields, ids colliding with humans, flooding, forged bot laps without driving, bots surviving the host, prototype-pollution-like names) and play it: host + guests + bots in a real two-window room (offscreen, muted) through qualifying, grid, lights, race, pit stops and results — do guests see the same bots, positions, standings and results; what happens on lag, a guest joining mid-session, the host leaving (in-game server and dedicated server), reconnects, 16 cars, year / car rules with bots taking teams.` },
  { key: 'driving', prompt: `${CTX}\n\nYOUR AREA: the driving model as changed since e02cf43 — js/car.js (steering law perf.steerLockAt / steerLockMax / steerLowGrip, the load / compress cues, height-aware locate at Suzuka's bridge, per-car ERS), js/raceline.js (cornerSpeed with the law), js/pit.js and js/track.js pit limits by season, js/tyres.js, js/laps.js across the bridge, the golden rule (the reference car on new medium tyres at wear rate 0, no boost / limiter / pit behaves exactly as the updated oracle devtests/car-v6/car-v5.js — check the claim AND that the oracle differs from v5 only by the steering law), and the seasons calibration (devtests/seasons-calib, js/seasons-data.js: is every season on its pace index, is the order believable). Drive Monaco's hairpin, Loews, Suzuka's hairpin and crossover, Zandvoort T3, high-speed corners (is the law unchanged >= 85 km/h?), look for NaN, tunnelling through the bridge deck, R resets on / under the bridge, cheatable laps.` },
  { key: 'world', prompt: `${CTX}\n\nYOUR AREA: the world data and geometry as changed since e02cf43 — tools/build-tracks.mjs + tracks-data.js (new DEM / lidar sources, START_AT, pit sides, layout fixes, widths, banking cap and cambers, Suzuka bridge), js/track.js (bridges, widthOverrides, bank profile, pit.limitFor / setYear), js/tunnels.js + tools/tunnels.json, tools/build-scenery.mjs + scenery-data.js + js/scenery.js (phantom-bridge rule, new decks), js/track-names-zh.js. Check the data against the real world (load WebSearch / WebFetch with ToolSearch): elevation profiles of Spa, Barcelona, Imola, Mugello, Monza, Interlagos, Portimão; start lines of Silverstone, Hungaroring, Sepang, Shanghai; the Chinese names as used in Taiwan; licences of every new elevation source and whether the attribution obligations are met in the UI / docs. VISUAL CHECK from the cockpit and from above, READING every screenshot: Suzuka's bridge from both roads, every tunnel (Monaco, Yas, Singapore, Madring, Monza underpasses), the new decks (Montréal, Marina Bay, Silverstone Wing, Las Vegas, Miami, Mexico), Baku castle, Albert Park's fixed stretches, Silverstone's new pits / grid, and the 6 places where phantom bridges were removed.` },
  { key: 'media', prompt: `${CTX}\n\nYOUR AREA: presentation — js/cockpit.js (head roll 45 % / pitch 50 %, compression cue, FOV 50..75 with the lens shift that keeps the wheel display above the telemetry, camera.rotation.y = PI + yaw contract), js/hudmirrors.js (layout, what is excluded, cost, overlaps), js/audio.js (tunnel reverb: convolver, mid band, ramps, disconnect, compressor headroom, the fallback path), js/telemetry.js (next-compound badge), js/carmodel.js with bots (liveries, AI badge). Render and measure (devtests/cockpit-test, devtests/audio-test incl. tunnel.js, hudmirrors-test) and READ screenshots at Spa Raidillon, Zandvoort T3, Madring, Monaco tunnel, a flat corner, a straight; judge whether the climb / banking now read as the user asked without causing discomfort (sudden swings, horizon jitter), and the tunnel lighting / sound transitions.` },
  { key: 'product', prompt: `${CTX}\n\nYOUR AREA: the packaged product — build HEAD into a scratch worktree (npm run dist there), start its win-unpacked exe muted with a remote-debugging port (see devtests/exe-smoke/smoke-exe.js) and measure: cold start, track-load time with 0 and 15 bots, frame time at Monaco / Spa / Las Vegas with 15 bots, memory over 20 minutes of racing with bots and track changes (leaks: geometries, textures, audio nodes, bots' objects, listeners — watch renderer memory and WebGL info), the worst hitch; check package.json build.files (is anything needed missing — js/ai.js, js/tunnels.js, js/track-names-zh.js, js/hudmirrors.js — or anything unneeded shipped), the portable exe's first run, the GitHub release notes in docs/v6-plan.md's release section vs what the exe really does, and what happens when WebGL or audio is unavailable.` },
]

phase('Review')
const reviewed = await pipeline(
  AREAS,
  a => agent(a.prompt, { label: 'fable r3: ' + a.key, phase: 'Review', model: 'fable', schema: FINDINGS }),
  (rev, a) => {
    if (!rev || !rev.findings || !rev.findings.length) return { area: a.key, review: rev, verdicts: [] }
    return agent(`${CTX.split('You are reviewing independently')[0]}
An independent reviewer reported the findings below about the area "${a.key}". You are the VERIFIER: for EACH finding reproduce it (probe under devtests/review-r3/verify-${a.key}/) or refute it by careful reading; default to real=false when you cannot demonstrate it or the scenario is impossible in practice; re-rate severity from what you observed; recommend the fix you would apply; name the ONE project file the fix belongs in (primaryFile).
Findings:
${JSON.stringify(rev.findings, null, 1)}`, { label: 'verify r3: ' + a.key, phase: 'Verify', schema: VERDICTS }).then(v => ({ area: a.key, review: rev, verdicts: v ? v.verdicts : null }))
  },
)

const confirmed = []
for (const r of reviewed.filter(Boolean)) {
  const byId = {}
  for (const f of (r.review && r.review.findings) || []) byId[f.id] = f
  for (const v of r.verdicts || []) if (v.real && v.severity !== 'none') confirmed.push({ area: r.area, ...byId[v.id], verifiedSeverity: v.severity, evidence: v.evidence, verifiedFix: v.fix, primaryFile: v.primaryFile })
}
log('confirmed: ' + confirmed.length)

const GROUPS = [
  { key: 'ui', re: /(^|\/)(js\/main\.js|js\/ui\.js|index\.html)$/, owned: 'js/main.js, js/ui.js, index.html, test/main.test.js' },
  { key: 'net', re: /(^|\/)(net\/.*|js\/net\.js|js\/gp\.js|preload\.js|electron-main\.js|package\.json)$/, owned: 'net/*, js/net.js, js/gp.js, preload.js, electron-main.js, package.json, test/server.test.js, test/session.test.js, test/gp.test.js' },
  { key: 'ai', re: /(^|\/)(js\/ai\.js|test\/ai\.test\.js|devtests\/ai-test\/.*)$/, owned: 'js/ai.js, test/ai.test.js, devtests/ai-test/*' },
  { key: 'driving', re: /(^|\/)(js\/(car|tyres|pit|laps|collide|gamepad)\.js|devtests\/car-v6\/.*)$/, owned: 'js/car.js, js/tyres.js, js/pit.js, js/laps.js, js/collide.js, js/gamepad.js, devtests/car-v6/* (incl. the oracle) and their test/*.test.js' },
  { key: 'world', re: /(^|\/)(js\/(track|scenery|raceline|tunnels|track-names-zh)\.js|tracks-data\.js|scenery-data\.js|tools\/(build-tracks|build-scenery)\.mjs|tools\/tunnels\.json|tools\/track-audit\.json)$/, owned: 'js/track.js, js/scenery.js, js/raceline.js, js/tunnels.js, js/track-names-zh.js, tracks-data.js, scenery-data.js, tools/build-tracks.mjs, tools/build-scenery.mjs, tools/tunnels.json, test/track.test.js' },
  { key: 'data', re: /(^|\/)(js\/cars\.js|js\/seasons-data\.js|js\/cars-data\.js|tools\/build-cars\.mjs|tools\/build-seasons\.mjs|tools\/liveries\/.*|tools\/eras\.json|tools\/ers-data\.json|docs\/.*)$/, owned: 'js/cars.js, js/seasons-data.js (generated), js/cars-data.js, tools/build-cars.mjs, tools/build-seasons.mjs, tools/liveries/*, tools/eras.json, tools/ers-data.json, test/cars.test.js, docs/*.md except docs/v6-plan.md' },
  { key: 'media', re: /(^|\/)js\/(audio|cockpit|carmodel|telemetry|hudmirrors)\.js$/, owned: 'js/audio.js, js/cockpit.js, js/carmodel.js, js/telemetry.js, js/hudmirrors.js' },
]
const buckets = {}
for (const f of confirmed) {
  const file = String(f.primaryFile || f.file || '').replace(/\\/g, '/')
  const g = GROUPS.find(g => g.re.test(file)) || GROUPS[0]
  ;(buckets[g.key] = buckets[g.key] || []).push(f)
}

phase('Fix')
const fixes = await parallel(GROUPS.filter(g => buckets[g.key] && buckets[g.key].length).map(g => () => agent(`Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive (Electron 44 + Three.js, classic ES5 scripts on window.F1). Do NOT commit / push / npm run dist. The user is away: decide sensible defaults and record them.
Contract: js/README-interfaces.md; plan and decisions: docs/v6-plan.md; harness list: devtests/README.md. THE GOLDEN RULE: the reference car on new medium tyres at wear rate 0, no boost / limiter / pit, behaves exactly as the oracle devtests/car-v6/car-v5.js (test/car.test.js). Any Electron window MUST be muted (devtests/electron-userdata.js; never SOUND=1).
Review round 3 (Fable) found the problems below in your area, and an independent verifier confirmed each (evidence and probes under devtests/review-r3/). Fix every one at its ROOT with a minimal change in the style of the file, add a regression test where the logic is testable in node, re-run the relevant suites and harnesses, and report. Where a finding asks for a product decision, take the sensible one and record it.
You own ONLY: ${g.owned}. Other fixers own the other files right now; if a fix needs a change elsewhere, describe it exactly in notes.
NOTE: devtests/seasons-calib/calibration.json fingerprints js/car.js, js/raceline.js, js/track.js, tracks-data.js and tools/eras.json; if you change any of those, say so in notes (the re-run stage recalibrates).
Findings:
${JSON.stringify(buckets[g.key], null, 1)}`, { label: 'fix r3: ' + g.key, phase: 'Fix', schema: FIXREPORT }).then(r => ({ group: g.key, report: r }))))

phase('Re-run')
const fixNotes = JSON.stringify(fixes.filter(Boolean).map(f => ({ group: f.group, summary: f.report && f.report.summary, notes: f.report && f.report.notes, notFixed: f.report && f.report.notFixed })), null, 1)
const rerun = await agent(`Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive. Do NOT commit / push / npm run dist. Review round 3's fixes have just been applied by several agents (reports below). You are now the ONLY agent editing the project. Any Electron window MUST be muted.
1. If node tools/build-cars.mjs --check reports stale, re-run node devtests/seasons-calib/calibrate.mjs (~22 min), ers-effect.mjs, node tools/build-cars.mjs, and compare the calibration table with the previous one (every season on its pace index, same within-season order). If the AI pace levels depend on what changed, re-check them (devtests/ai-test/pace.js).
2. Re-run EVERYTHING listed in devtests/README.md (all node suites, build-cars --check, every node devtest, every Electron harness incl. v6-smoke, v6-critic, v61-critic, v62-critic, bots-test / gp-e2e bots, gp-smoke, ui-gp, ui-v6, hudmirrors-test, tunnel-test, gp-e2e solo / solo-v6 / online / online-v6, mp-e2e, cockpit-test, audio-test) and fix what broke (root causes, minimal). Report exact results per command.
Fix reports:
${fixNotes}`, { label: 'r3 re-run', phase: 'Re-run', schema: FIXREPORT })

phase('Docs')
const docs = await agent(`Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive. Do NOT commit / push / npm run dist; do not change code. Bring the documentation up to the current code (v6.1, v6.2, AI drivers and review round 3), reading the code and these sources: docs/agent-runs/2026-10-01/reports/ (v61-*.txt, v62-reports.txt, ai-report.txt) and the AI integration + round 3 reports below.
- js/README-interfaces.md: v6.1 (mirrors, pad ABXY, per-car ERS, ref-car harness helper), v6.2 (steerLockAt / steerLockMax / steerLowGrip, state.load / compress, locate / nearest / groundY with y, bridges, widthOverrides, bank cap, pit.limitFor / setYear / F1.pitLimitFor, tunnels API and glue, audio setTunnel, cockpit setFov / F1.COCKPIT_FOV, track-names-zh, search) and a v7 section for the AI drivers (F1.createAIDriver, F1.AI views / contexts / lineup / warmUp, F1.cars.drivers, the bot wire format, gp bot APIs, main.js loop) — accurate signatures, no invented APIs.
- devtests/README.md: a row for every harness (v61-critic, v62-critic, bots, tunnel-test, car-v6/crossing, audio-test/tunnel.js, scenery-test/bridges + pitside, track-fix/check-v62 / bridge-check / pit-summary, cockpit-test, ai-test/*), with how to run it and its expected result; fix stale text (hudmirrors 'not wired').
- docs/v6-plan.md: append the round 3 outcome (findings, fixes, decisions) and mark the remaining steps (dist, exe smoke, commit, push, GitHub release).
- CLAUDE.md: rewrite 'State' for the current situation (last verified commit = what is about to be committed; releases v6.1 / v6.2 on GitHub; the user wants verified rounds pushed + released; known leftovers) — keep it concise; update the test counts ('N suites').
- docs/claude-memory/: copy of C:\\Users\\Heart\\.claude\\projects\\C--Users-Heart-Desktop-f1Drive\\memory\\*.md (refresh it).
Reports: ${JSON.stringify({ rerun: rerun && { summary: rerun.summary, notes: rerun.notes }, fixes: fixNotes }, null, 1)}`, { label: 'docs', phase: 'Docs', schema: FIXREPORT })

return { confirmed, fixes, rerun, docs, refuted: reviewed.filter(Boolean).map(r => ({ area: r.area, total: r.review && r.review.findings ? r.review.findings.length : 0, confirmed: (r.verdicts || []).filter(v => v.real).length })) }
