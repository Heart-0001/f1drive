export const meta = {
  name: 'f1drive-ai-press',
  description: 'F1Drive: settle the round-3 AI trade-off (pressing a slower car into a braking zone bumps it on lap 1 at Monza) without losing the passing that round 3 gave; independent check',
  phases: [
    { title: 'Fix', detail: 'js/ai.js owner' },
    { title: 'Check', detail: 'independent measurement, both directions' },
  ],
}
const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, result: { type: 'string' } }, required: ['cmd', 'result'] } },
    verdict: { type: 'string', enum: ['ok', 'regressed', 'n/a'] }, openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged', 'testsRun', 'verdict', 'openIssues'],
}
const CTX = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive (Electron 44 + Three.js, classic ES5 scripts on window.F1). Do NOT commit / push / npm run dist. The user is away; take the sensible decision and record it. Any Electron window MUST be muted (devtests/electron-userdata.js; never SOUND=1).
Background: review round 3 fixed 'faster bots cannot pass slower ones' in js/ai.js with a 'press a slower car' rule (see devtests/ai-test/README.md and docs/v6-plan.md). The re-run found a trade-off it left open: on lap 1 at Monza's first chicane (sample ~318) a bot pressing a slower car into the braking zone sometimes bumps it — devtests/gp-e2e/bots.js part 'pits' saw bumps of 0.16-0.20 in about 1 run in 5 (HEAD d1decf6's ai.js never did; limit 0.25; one run before a later guard hit 0.31). Scratch of that re-run: C:\\Users\\Heart\\AppData\\Local\\Temp\\claude\\C--Users-Heart-Desktop-f1Drive\\c2c193e6-e2b5-4b48-8955-beed8746e07e\\scratchpad\\rerun.`

phase('Fix')
const fix = await agent(`${CTX}
You own js/ai.js, test/ai.test.js and devtests/ai-test/ only.
TASK: keep the passing that round 3 gained, but never press into a car that is braking (or about to brake) for a corner: e.g. no pressing while the car ahead decelerates or while the profile's target speed drops within the closing distance + braking distance ahead, and keep a braking-zone gap like a real driver (follow, then pass on the exit / the straight). Reproduce first (devtests/gp-e2e/bots.js ONLY=pits repeated, and a node reproduction at Monza lap 1 with the pits scenario's grid), then fix at the root, then measure: bots.js part pits at least 15 runs (no bump above 0.12 at the chicane), devtests/ai-test matrix.js (passes and the finish-order Spearman from reversed / random grids must stay at round 3's level or better — compare with HEAD d1decf6's numbers and the round-3 numbers in devtests/ai-test/README.md), the critic stress suites, test/ai.test.js (add a regression test), allocation < 2 B per think(), fingerprint.js. Record the numbers in devtests/ai-test/README.md.`, { label: 'ai press fix', phase: 'Fix', schema: REPORT })

phase('Check')
const check = await agent(`${CTX}
An AI owner has just changed js/ai.js to stop pressing into braking cars (report below). You are an INDEPENDENT checker: do not trust the report; measure yourself, both directions — (1) contact: devtests/gp-e2e/bots.js full run twice and part pits 10 more times, devtests/bots-test/game.js, the AI stress suites (devtests/ai-test critic-*.js); (2) racing: devtests/ai-test/matrix.js passes and finishing-order Spearman from reversed / random grids vs HEAD d1decf6's js/ai.js (git show d1decf6:js/ai.js into a scratch copy and run the same sims against it); (3) all 12 node suites (for f in test/*.test.js). Say 'ok' only if contacts are no worse than HEAD d1decf6 and passing is no worse than round 3's numbers; otherwise 'regressed' with the evidence. You may fix only test harness bugs (not js/ai.js) and must list them.
Report: ${JSON.stringify(fix && { summary: fix.summary, openIssues: fix.openIssues }, null, 1)}`, { label: 'ai press check', phase: 'Check', schema: REPORT })
return { fix, check }
