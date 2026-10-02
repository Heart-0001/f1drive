export const meta = {
  name: 'f1drive-lobby',
  description: 'F1Drive v7.2: a room lobby — everyone gathers in the room first, the host sets track / season / Grand Prix / computer drivers, players get ready, the host starts and everyone loads together; plus single player start panel and the Spa puncture bug; then e2e, a Fable review with verification, fixes and a full re-run',
  phases: [
    { title: 'Design', detail: 'today\'s flow played, lobby design + contract' },
    { title: 'Build', detail: 'protocol / session / gp · menu / main glue' },
    { title: 'E2E', detail: 'lobby harness, online harnesses updated, full re-run' },
    { title: 'Review', detail: 'Fable review, verification, fixes, final re-run', model: 'fable' },
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
const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic'] },
      description: { type: 'string' }, failureScenario: { type: 'string' }, suggestedFix: { type: 'string' },
    }, required: ['id', 'title', 'file', 'severity', 'description', 'failureScenario', 'suggestedFix'] } },
    coverage: { type: 'string' },
  },
  required: ['findings', 'coverage'],
}
const VERDICTS = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, real: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic', 'none'] },
    evidence: { type: 'string' }, fix: { type: 'string' },
  }, required: ['id', 'real', 'severity', 'evidence', 'fix'] } } },
  required: ['verdicts'],
}

const USER = `The user (Traditional Chinese, Taiwan) just played multiplayer and wrote: "阿多人叫我選賽道 然後就直接跑進畫面了? 不應該等大家都到才開始嗎" — in multiplayer the game asks them to pick a track and then drops them straight onto the track; they expect everybody to gather first and the game to start only when everyone is there. Then, about single player: "個人也是阿 為啥都是點賽道就開始了阿" — single player too: clicking a track card should NOT drop them onto the track at once; they want to choose first and then start.`
const CTX = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — first-person F1 game (Electron 44 + Three.js r149, classic ES5 scripts on window.F1, multiplayer relay in net/ running inside the host's game or as node net/server.js). Windows 11, Node 24. Public GitHub repo; NEVER write anyone's e-mail address into files, commits or network requests. Do NOT commit / push / npm run dist. Read first: CLAUDE.md, js/README-interfaces.md (v5 Grand Prix, v6, v7 computer drivers sections), docs/v6-plan.md, devtests/README.md.
${USER}
Any Electron window MUST be muted (devtests/electron-userdata.js; never SOUND=1). Verify by running; report exact results.`


// ---- tyre bug (user, same evening), runs alongside design + build; E2E waits for it
const TYRE = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive (Electron 44 + Three.js, classic ES5 scripts on window.F1). Public repo: NEVER write anyone's e-mail address anywhere. Do NOT commit / push / npm run dist. Any Electron window MUST be muted (devtests/electron-userdata.js; never SOUND=1).
The user just played and wrote: "為啥我拿RB19跑SPA 我才用x1 跑到第二圈一半我已經爆胎了??? 我沒撞欸" — with the 2023 Red Bull (RB19) at Spa, tyre wear x1, a puncture halfway through lap 2, without hitting anything. Earlier the user also said qualifying wear felt too fast ("outlap 都還沒跑完 輪胎沒一半了") and then agreed to keep wear x1 — so x1 must feel like real F1: a soft set lasts a sensible stint (real Spa softs ~12-18 laps, mediums ~20-30), no puncture from clean driving, wear x2..x5 scales it.
Other agents are building a room lobby in js/main.js, js/ui.js, index.html, net/* and js/gp.js right now — do not touch those files; do not run the Electron Grand Prix harnesses (a later stage re-runs everything).`
const tyreChain = (async () => {
  const fix = await agent(`${TYRE}
You own js/tyres.js, test/tyres.test.js, docs about tyres, and devtests/tyre-test/ (new). Touch js/car.js ONLY if the root cause is there — then also re-run node devtests/seasons-calib/calibrate.mjs (~25 min), ers-effect.mjs, node tools/build-cars.mjs and --check, and say so (the calibration fingerprints js/car.js).
1. Reproduce in node with the real modules (see devtests/ai-test/lib.js / sim.js for loading them): the 2023 Red Bull spec on Spa at wear x1, driven (a) by the racing-line driver, (b) by a human-like driver (late braking, kerbs, some sliding, the keyboard driver of devtests/seasons-calib/driver.mjs), (c) by js/ai.js — log per tyre per second: raw wear, temperature, overheat, slide work, flat spots, impacts / hits (and what produced them: walls, kerbs, terrain, the new Raidillon compression, bridge / deck geometry, car.bump), and the moment and reason of the puncture.
2. Find the ROOT cause (wrong wear constant? overheat runaway? a spurious impact from the new elevation / bank data, kerbs or the steering law? carcass life? load factor from state.load?) and fix it there, with a regression test.
3. Calibrate x1 against real stint lengths: per compound km-to-cliff for several cars (2010 V8, 2014, RB19 2023, 2026) on all 40 circuits with the racing-line driver and the human-like driver — no puncture without contact / lock-ups in any of them at x1..x3; record the table in docs (tyre section) and devtests/tyre-test/README.md. Qualifying stays at x1 as the user agreed. The AI's stint planning (js/ai.js W_PLAN etc.) reads wear: run node test/ai.test.js, devtests/ai-test/matrix.js and critic-mixed.js and report if the bots' strategy needs the AI owner (do not edit js/ai.js yourself unless the change is a constant it derives from tyres).
4. Run node test/tyres.test.js, test/car.test.js (golden rule: wear rate 0 unchanged), test/pit.test.js, test/ai.test.js, test/cars.test.js, devtests/car-v6/pit-drive.js all.`, { label: 'tyres: puncture at Spa', phase: 'Build', schema: REPORT })
  const check = await agent(`${TYRE}
An owner has just changed the tyre model (report below). You are an INDEPENDENT checker: do not trust the report. Reproduce the user's case before (git stash-free: copy HEAD's files into a scratch folder with git show HEAD:js/tyres.js etc.) and after, in node: RB19 at Spa, x1, clean driving, 5 laps — the puncture must be gone, the wear plausible; then sample 12 other car / track / driver combinations (incl. Monaco, Bahrain hot and abrasive, Suzuka, Silverstone, Jeddah, a 2010 car, a 2026 car, the keyboard driver) at x1 and x3 and judge the stint lengths against real F1; check flat spots / punctures still happen from real causes (a heavy impact, a long lock-up). You may fix only test harness bugs and must list them.
Report: ${JSON.stringify(fix && { summary: fix.summary, openIssues: fix.openIssues, filesChanged: fix.filesChanged }, null, 1)}`, { label: 'tyres: independent check', phase: 'Build', schema: REPORT })
  return { fix, check }
})()

phase('Design')
const design = await agent(`${CTX}
You own docs/lobby-design.md (new) and the new 'v7.2 room lobby' section of js/README-interfaces.md only.
1. Reproduce exactly what the user saw: play today's multiplayer flow in two muted offscreen Electron windows (create a room, join it, as host and as guest; READ screenshots): when is a track picked, by whom, who drives when, what happens to a guest joining while the host is on a track, how the Grand Prix starts today.
2. Design the room lobby (decide for the user, they are away; Traditional Chinese UI, Taiwan usage), at least:
   - After creating / joining a room everyone is in the 房間大廳 (menu state, nobody on track): room code / address, the players (name, car, ready, host mark, computer drivers), and the room settings: track (the host picks from the track cards — in the lobby a card click by the host SETS the room's track instead of driving; guests see the choice), season year, mode (大獎賽 with Q / R laps, tyre wear, starting compound; or 自由練習), computer drivers count / strength — host edits, guests read-only; every player picks their own car of the season and toggles 準備.
   - 開始 (host): enabled when every human is ready (the host counts as ready; say what happens with a player who never readies — e.g. the host may start anyway after a confirmation, the unready player loads too); everyone loads the track at the same time; a loading barrier (all loaded or a timeout) before the session starts (Grand Prix: qualifying starts only then; free practice: cars appear together).
   - After the Grand Prix results: the host chooses 再來一場 or 回到大廳; leaving the track in a room returns to the lobby, not to single player.
   - Joining while a session runs: spectate / join as today's rules say, then the lobby when the room returns there.
   - Host leaving in the lobby / during loading; a guest leaving during loading; the dedicated server (node net/server.js) — who is the host there; old clients (protocol version: keep v1-compatible or bump with a clear message).
   - Single player gets the same idea: a card click SELECTS the track and opens a start panel (the chosen track, own car / season, mode 自由練習 or 大獎賽 with its settings, computer drivers, starting compound) with a clear 開始 button (Enter and pad A start too; Esc / B back to the cards); nothing drives before 開始. Keep it one click away for a quick practice (e.g. 開始 focused by default), and list every harness / exe smoke that clicks a card and expects driving, so it can be updated.
3. Write docs/lobby-design.md (flows, states, protocol messages and fields, server validation and rate limits, UI layout incl. 1280x720 and narrow windows, texts, edge cases, what every existing harness must change) and the contract section in js/README-interfaces.md, precise enough for two owners to build in parallel (net / session / gp owner and menu / main glue owner).`, { label: 'lobby design', phase: 'Design', schema: REPORT })

phase('Build')
const dnotes = JSON.stringify(design && { summary: design.summary, apiNotes: design.apiNotes, openIssues: design.openIssues }, null, 1)
const [net, ui] = await parallel([
  () => agent(`${CTX}
Design (docs/lobby-design.md, contract in js/README-interfaces.md 'v7.2 room lobby'): ${dnotes}
You own net/server.js, net/session.js, net/host.js, js/net.js, js/gp.js, test/server.test.js, test/session.test.js, test/gp.test.js, devtests/net-gp/. TCP ports 24700-24799.
Build the lobby's protocol, server room state, validation, rate limits, loading barrier, return to the lobby, ready states, host-only settings (track, year, mode, Grand Prix settings, bots), the dedicated server's behaviour, joining / leaving in every state; keep every existing validation / anti-cheat / rate limit and test green, add tests for every new message incl. hostile ones from a guest (settings, start, ready flooding, loaded spoofing, bogus track ids). Follow the contract; if it is wrong, fix the contract section and say so in apiNotes.`, { label: 'lobby: net + session + gp', phase: 'Build', schema: REPORT }),
  () => agent(`${CTX}
Design (docs/lobby-design.md, contract in js/README-interfaces.md 'v7.2 room lobby'): ${dnotes}
You own js/main.js, js/ui.js, index.html, test/main.test.js. Another agent is building the net / session / gp side right now against the same contract: code against the contract, re-read their files before wiring.
Build the 房間大廳 in the menu and the game glue: lobby view (players, ready, host mark, AI rows, settings host-editable / guest read-only, track choice via the cards, own car pick, 準備, 開始 with the rules of the design, loading screen with who is still loading), entering the track together, Grand Prix / free practice from the lobby, 再來一場 / 回到大廳 after results, Esc behaviour in a room, leaving, the hints; Traditional Chinese texts (Taiwan usage); layouts at 1280x720, 1920x1080 and narrow windows (READ screenshots, muted Electron). Single player: the card click selects the track and opens the start panel of the design (開始 / Enter / pad A to drive, Esc / B back); nothing drives before 開始.`, { label: 'lobby: menu + main glue', phase: 'Build', schema: REPORT }),
])

const tyres = await tyreChain
phase('E2E')
const e2e = await agent(`${CTX}
The lobby was just built (reports below). You are now the ONLY agent editing; keep changes minimal and list them. TCP ports 24800-24899.
1. New harness devtests/lobby-test/ (muted, offscreen; READ screenshots): host + 2 guests: create, join, everyone sees everyone in the lobby, nobody is on track; the host picks track / year / mode / bots; guests pick cars and ready up; 開始 only when allowed; all three load and the session starts only after the barrier (check every window's phase / clock); a Grand Prix to results with bots; 回到大廳; 再來一場; a latecomer during the race; the host leaving in the lobby and during loading; a guest leaving during loading; the dedicated server (node net/server.js) flow; single player: card -> start panel -> 開始 (keyboard, mouse and pad), free practice and a Grand Prix with bots.
2. Update every harness to the new flows without weakening a check — every one that clicks a track card and expects driving (devtests/exe-smoke/smoke-exe.js, v6-smoke, gp-smoke, gp-e2e solo / solo-v6 / bots, cockpit / ui shots ...) and every online one (devtests/mp-e2e, gp-e2e online / online-v6 / bots (room parts), net-gp electron-*, v6-critic / v61-critic / v62-critic room parts, ui-gp / ui-v6 room screenshots, exe-smoke if it touches rooms).
3. Re-run EVERYTHING (all node suites, build-cars --check, every node devtest, every Electron harness in devtests/README.md), fix what broke (root causes), add the new harness to devtests/README.md, report exact results.
The tyre model was also changed this round (the user's puncture at Spa) — the Grand Prix / bots harnesses' tyre checks may move legitimately; judge, never weaken blindly.
Reports: ${JSON.stringify({ net: net && { summary: net.summary, apiNotes: net.apiNotes, openIssues: net.openIssues }, ui: ui && { summary: ui.summary, apiNotes: ui.apiNotes, openIssues: ui.openIssues }, tyres: tyres && { fix: tyres.fix && { summary: tyres.fix.summary, openIssues: tyres.fix.openIssues }, check: tyres.check && { summary: tyres.check.summary, openIssues: tyres.check.openIssues } } }, null, 1)}`, { label: 'lobby e2e + re-run', phase: 'E2E', schema: REPORT })

phase('Review')
const review = await agent(`${CTX}
Do NOT edit project files; scratch under devtests/review-lobby/ (git-ignored). You are an independent reviewer: nobody gives you conclusions. Review the new room lobby (git diff HEAD, docs/lobby-design.md) against the user's request and the whole game: play it in 2-3 muted offscreen Electron windows and with hostile raw WebSocket clients against the server; look for ways to get stuck (in the lobby, in loading, after results), desync (different tracks / years / settings / phases on different windows), host / guest leaving at every moment, a guest driving before the start, cheating the ready / loading barrier, single player's new start panel (card -> panel -> 開始, keyboard / mouse / pad), texts (Traditional Chinese, Taiwan usage), layout at 1280x720 / narrow windows (READ screenshots). Report only real problems with a concrete failure scenario.`, { label: 'fable review: lobby', phase: 'Review', model: 'fable', schema: FINDINGS })
let verdicts = null, fixes = null
if (review && review.findings && review.findings.length) {
  verdicts = await agent(`${CTX}
Do NOT edit project files; scratch under devtests/review-lobby/verify/. An independent reviewer reported the findings below about the new room lobby. You are the VERIFIER: reproduce each (or refute it by careful reading); default to real=false when you cannot demonstrate it; re-rate severity; recommend the fix.
Findings: ${JSON.stringify(review.findings, null, 1)}`, { label: 'verify: lobby', phase: 'Review', schema: VERDICTS })
  const byId = {}
  for (const f of review.findings) byId[f.id] = f
  const confirmed = ((verdicts && verdicts.verdicts) || []).filter(v => v.real && v.severity !== 'none').map(v => ({ ...byId[v.id], verifiedSeverity: v.severity, evidence: v.evidence, verifiedFix: v.fix }))
  log('lobby review: ' + review.findings.length + ' findings, ' + confirmed.length + ' confirmed')
  if (confirmed.length) fixes = await agent(`${CTX}
You are now the ONLY agent editing. Fix every confirmed finding below at its root (minimal changes in the style of each file, regression tests where testable in node), then re-run EVERYTHING (all node suites, build-cars --check, every node devtest, every Electron harness in devtests/README.md incl. devtests/lobby-test) and report exact results. Also record the lobby's decisions in docs/v6-plan.md (a 'v7.2 room lobby' section) and update CLAUDE.md's state (lobby built, not yet released) and test counts.
Confirmed findings: ${JSON.stringify(confirmed, null, 1)}`, { label: 'fix + final re-run', phase: 'Review', schema: REPORT })
}
return { design, net, ui, tyres, e2e, review, verdicts, fixes }
