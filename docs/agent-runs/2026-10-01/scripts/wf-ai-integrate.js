export const meta = {
  name: 'f1drive-ai-integrate',
  description: 'F1Drive: integrate AI computer drivers (js/ai.js) into single player and rooms — count + skill controls, host-simulated bots in the protocol / session, driver names, lap / pit / tyre handling, end-to-end races with bots; critic + full re-run',
  phases: [
    { title: 'Owners', detail: 'net + session + gp bots · seasons data driver names · ai.js tweaks' },
    { title: 'Glue', detail: 'main.js / ui.js / index.html: bot loop, models, collisions, controls' },
    { title: 'E2E + critic', detail: 'races with bots solo + online, full re-run' },
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
const PRE = (owned) => `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — first-person F1 game (Electron 44 + Three.js r149, classic ES5 scripts on window.F1, multiplayer relay in net/). Windows 11, Node 24. Do NOT commit / push / npm run dist. The user is away on a business trip and wants it finished: decide sensible defaults, record them.
Read first: CLAUDE.md, js/README-interfaces.md (v5 Grand Prix rules said "no AI cars" — the user has now asked for them: "add computer players; in the room you can choose how many and how strong"), docs/v6-plan.md, devtests/README.md, and the AI brain's full report docs/agent-runs/2026-10-01/reports/ai-report.txt (API of js/ai.js: F1.createAIDriver, F1.AI views / contexts / lineup / names, the per-step loop reference implementation devtests/ai-test/sim.js, and the detailed integration design: offline, host-simulated bots online with proposed protocol messages, room UI, naming from the season's drivers, liveries from the cars humans did not take).
Since the AI was written, v6.2 changed: the steering law (perf.steerLockAt), track data (new start lines, elevation, Suzuka over / under crossing with track.locate(x, z, hint, y) — bots must pass their car's height), tunnels, cockpit, Chinese names. Any Electron window MUST be muted (devtests/electron-userdata.js; never SOUND=1).
Ownership: you own ONLY ${owned}; other agents own the other files right now. Re-Read a file right before editing it. Verify by running; report exact results.`

phase('Owners')
const [net, data, ai] = await parallel([
  () => agent(`${PRE('net/server.js, net/session.js, js/net.js, js/gp.js, test/server.test.js, test/session.test.js, test/gp.test.js, devtests/net-gp/')}
TCP ports 24700-24799.
YOUR TASK — bots in the protocol, the session and the Grand Prix controller, following the AI report's design (refine it where it is wrong):
- Session (net/session.js): players can be bots ({bot: true, owner}) — classified like humans (quali, grid by quali time, race, DNF), named, never 'left' unless removed; snapshot rows carry bot: true.
- Server (net/server.js): host-only 'bots {n, skill}' in the free phase (n 0..16 - humans, skill level), creating / removing bot players with ids, room slots (= pit boxes / grid columns), names and car ids sent by the host (validated), shown in the roster (bot: true, skill); the host's connection publishes their states in a batched message (e.g. 'bs' with [id, ...state] rows, the same validation as 's', rate-limited, relayed in the normal snapshots so guests interpolate bots like players) and their laps ('gl' with a bot id from the host's connection only) — the proof-of-driving checks must accept bot laps backed by the published bot states; impacts to / from bots relayed under the same rules; when the host leaves, the bots go (in-game server: the room closes anyway; dedicated server: remove the bots and end a running session cleanly); a joining guest sees the bots in the roster immediately. Keep every existing validation / rate limit / test green and add tests for all of this (incl. hostile bots messages from a guest, oversized n, garbage skill).
- js/net.js: setBots(n, skill), bot rows in roster / players (players[i].bot, skill), sendBotStates(rows), sendGpLap for a bot id; sanitising.
- js/gp.js: offline the local session gets bot players too (gp.setBots(list) or similar), view() rows carry bot: true and the skill; online it mirrors the server.
Report the exact wire format and APIs for the glue agent.`, { label: 'net + session + gp bots', phase: 'Owners', schema: REPORT }),
  () => agent(`${PRE('tools/build-cars.mjs, js/cars.js, js/seasons-data.js (generated), test/cars.test.js, docs/seasons-data.md, devtests/ai-test/build-drivers.mjs, devtests/ai-test/drivers.json')}
YOUR TASK — driver names for the bots: fold the season's two real drivers per car (devtests/ai-test/build-drivers.mjs from tools/seasons-raw.json; name, abbreviation, number) into tools/build-cars.mjs -> js/seasons-data.js cars[].drivers, and expose F1.cars.drivers(id) -> [{name, abbr, number}, ...] (Map-only lookup; the standard car gets invented neutral names). Chinese display: keep the Latin names (Taiwanese media mostly do) unless a sourced Taiwan form is trivial — say what you chose. The physics / calibration is untouched: node tools/build-cars.mjs --check and node test/cars.test.js must pass (the calibration fingerprint must not change; if the recalibration stage of v6.2 has just rewritten calibration.json, use it as is).`, { label: 'driver names data', phase: 'Owners', schema: REPORT }),
  () => agent(`${PRE('js/ai.js, test/ai.test.js, devtests/ai-test/ (except build-drivers.mjs / drivers.json)')}
YOUR TASK — bring js/ai.js up to v6.2 and ready for the game loop: pass the bot car's height to every track.locate / nearest call (Suzuka's bridge; verify bots on both roads at the crossing never jump levels), re-check the pace levels against the current steering law / track data with devtests/ai-test/calibrate.js and pace.js (keep +8 / +5 / +2.5 / +1 %), make sure Monaco's hairpin is taken at a sensible speed now that the steering law allows ~45-50 km/h (the critic measured 25 km/h before the v6.2 data landed), re-run the author's matrix and the critic's stress suites (devtests/ai-test/*.js) and test/ai.test.js, and keep think() allocation-free. Report anything the glue agent must do differently from the AI report's design.`, { label: 'ai.js update', phase: 'Owners', schema: REPORT }),
])

phase('Glue')
const notes = JSON.stringify({ net: net && { summary: net.summary, apiNotes: net.apiNotes, openIssues: net.openIssues }, data: data && { summary: data.summary, apiNotes: data.apiNotes }, ai: ai && { summary: ai.summary, apiNotes: ai.apiNotes, openIssues: ai.openIssues } }, null, 1)
const glue = await agent(`${PRE('js/main.js, js/ui.js, index.html, js/carmodel.js (only if needed), and the harnesses that need updating; small surgical fixes elsewhere if integration requires (list them)')}
TCP ports 24800-24849. The owners just finished: ${notes}
YOUR TASK — wire the bots into the game:
1. UI: in the 大獎賽 panel (single player and room host): 電腦車手 count (0..16 - humans) and 強度 (新手 / 業餘 / 職業 / 傳奇, plus 混合), persisted; guests see them read-only; the standings / results / session box / minimap / name tags mark bots (e.g. an 'AI' tag) with their team colours; the car picker reserves cars humans picked (bots take the other teams of the season, two seats per team as the AI report designs).
2. Offline: create the bots at track load / when the count or skill changes in the free phase (lineup with names / cars from F1.cars and drivers), each with its own car (F1.createCar(spec)), tyres, lap counter, pit state, F1.createAIDriver; run the per-step loop exactly like devtests/ai-test/sim.js (think -> car.update -> collisions with every other car (bots and the player) via js/collide.js, both directions -> lap counter -> gp.lapDone for that bot -> pit events), place them on the grid / start slots with the player like rooms do, freeze them on the grid / during services, draw them with js/carmodel.js (livery, setHalo, ghost rules), feed them to the audio (others with spec), the minimap and the HUD mirrors.
3. Online host: simulate the bots locally exactly as offline and publish them (net.sendBotStates at ~20 Hz, bot laps); guests draw / collide / hear bots as remote cars; the host leaving ends them.
4. Performance: 15 bots + 1 player on this machine — measure frame time and physics cost; keep 60 fps (cheaper LOD for far bots if needed).
5. Update and run: all node suites, build-cars --check, v6-smoke, v6-critic, v61-critic, gp-smoke, ui-gp, ui-v6, hudmirrors-test, tunnel-test, gp-e2e solo / solo-v6 / online / online-v6, mp-e2e — keep them green (bots default to 0 so existing scenarios are unchanged).`, { label: 'glue: bots in the game', phase: 'Glue', schema: REPORT })

phase('E2E + critic')
const critic = await agent(`${PRE('everything (you are the only agent editing now); keep changes minimal and list them; new harness devtests/gp-e2e/bots.js')}
TCP ports 24850-24899. Reports: ${JSON.stringify({ glue: glue && { summary: glue.summary, apiNotes: glue.apiNotes, openIssues: glue.openIssues } }, null, 1)}
YOUR TASK — end-to-end with bots and a player-eyes check (MUTED Electron; READ screenshots):
- devtests/gp-e2e/bots.js: (a) single player, time-warped (see devtests/gp-e2e/solo.js), Grand Prix on Monza and Monaco with 15 bots of mixed skill, Q 1 / R 3, wear x2 — the autopilot player races them: grid by quali times, lights, starts without pile-ups, overtakes, pit stops, results with the bots classified sensibly (legend near the front, rookies at the back), no stuck bot, no error; (b) online in real time: host + guest + 6 bots on Monaco, Q 1 / R 2 — guests see identical bot positions / standings / results, bot laps accepted by the server, the host leaving ends the bots.
- Play it: change count / skill in the panel, a bot running into you, overtaking bots, blue flags, the pit lane full of bots, Suzuka crossing with bots, frame rate with 15 bots at Monaco and Spa.
Fix what is wrong, then re-run EVERYTHING (all node suites, build-cars --check, every Electron harness in devtests/README.md) and report exact results.`, { label: 'bots e2e + critic + re-run', phase: 'E2E + critic', schema: REPORT })
return { net, data, ai, glue, critic }
