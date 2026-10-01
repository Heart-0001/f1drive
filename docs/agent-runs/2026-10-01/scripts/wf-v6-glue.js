export const meta = {
  name: 'f1drive-v6-glue',
  description: 'F1Drive v6: wire every v6 module into js/main.js (+ electron-main.js), verify each feature in the real game, then an independent integration critic',
  phases: [
    { title: 'Glue', detail: 'main.js wiring + devtests/v6-smoke' },
    { title: 'Critic', detail: 'fresh eyes: play every feature in the real game, fix' },
  ],
}

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    apiNotes: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, result: { type: 'string' } }, required: ['cmd', 'result'] } },
    bugsFound: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesChanged', 'apiNotes', 'testsRun', 'bugsFound', 'openIssues'],
}

const A = (typeof args === 'object' && args) || {}
const NOTES = A.notes || '(no notes given: read the modules yourself)'

const PRE = `Project: F1Drive at C:\\Users\\Heart\\Desktop\\f1Drive — a first-person F1 driving game: Electron 33 + Three.js r149, classic ES5-style browser scripts on window.F1, no bundler, no asset files. Windows 11, Node 24, deps installed. Do NOT commit or push, do NOT run \`npm run dist\`. The user is asleep and cannot answer: decide sensible defaults and record them.
Read first: js/README-interfaces.md — the "v6 additions" section is the contract (the user's requests are quoted at its top; the controls list; the GOLDEN RULE: the reference car on fresh medium tyres with no boost / limiter / pit drives exactly as v5). docs/v6-plan.md is the overall plan and has "Notes for stage G". devtests/README.md lists the harnesses: devtests/gp-smoke/smoke.js is the model for driving the real game from Electron (executeJavaScript, real key / mouse events, a fake Gamepad API, several windows with the real host IPC, screenshots you then READ, the F1.game peek).
All v6 modules now exist and were verified on their own: js/seasons-data.js + js/cars.js (F1.cars), js/track.js (track.pit, light curtains, track.update), js/tyres.js, js/car.js (F1.REF_SPEC, carPerf, setSpec, ERS, limiter, tyres, pit wall, new state fields), js/gamepad.js (boost, limiter, compound), js/audio.js (F1.audio), js/raceline.js (buildRaceLine(track, perf)), js/pit.js, js/cockpit.js (setCar), js/carmodel.js (setLivery), js/telemetry.js, net/session.js + net/server.js + js/net.js + js/gp.js (car, year, wear), js/ui.js + index.html (year / car picker, GP panel with year and wear, pit strip, telemetry canvas, audio settings, hints), js/scenery.js (respects the pit lane). Only js/main.js (and electron-main.js) are not wired yet.
CONCURRENCY: while you work, other agents are fixing review findings in net/server.js, net/session.js, js/net.js, js/gp.js, preload.js, net/host.js (anti-cheat lap validation, impact limits, an OPTIONAL ROOM PASSWORD: net.create(port, {password}) / net.join(address, {password}), error code 'password'), js/audio.js (hidden-window behaviour), js/cockpit.js + js/carmodel.js (real rear-view mirrors, maybe a per-frame call for them), js/car.js (car.bump(strength) for car-to-car impacts; ers sanitising). Do NOT edit those files; if you need a change there, put it in openIssues. Code to the APIs as announced here (use feature checks like typeof net.join.length / typeof car.bump === 'function' so the glue works before and after their changes), and add the password field to the multiplayer panel (create and join) in js/ui.js / index.html.
The module owners' notes (their apiNotes are the real APIs; openIssues may name things you must handle):

${NOTES}`

phase('Glue')
const glue = await agent(`${PRE}

You own js/main.js, electron-main.js and devtests/v6-smoke/ (new). You may make small, surgical fixes in any other file when integration really requires it (re-Read the file first, keep the change minimal, and list every such edit with the reason) — the module owners have finished.
TCP ports reserved for you: 24800-24849.

YOUR TASK: wire all of v6 into the game exactly as the contract's "js/main.js + electron-main.js (v6 glue)" section and the owners' notes describe, without regressing anything v5 does (the v5 harnesses must stay green):
1. Year and car: on boot F1.cars; the selected year / car from ui (persisted); offline any year; in a room the room's year (host: net.setYear when connecting as host and whenever the host picks another year in the free phase; guests follow the 'year' event — their car switches with F1.cars.resolve(id, year) and they are told with a toast); car.setSpec(spec), cockpit.setCar(spec, profile colour), F1.audio.setEngine(spec), the racing line rebuilt with F1.buildRaceLine(track, car.perf), net.setProfile({name, colour, car: id}); ui.setCars({...}) with canPickYear (offline, or host in free phase), canPickCar (not during a session) and the reason; remote cars: F1.cars.resolve(p.car, year) -> model.setLivery(colour, colour2, player colour) and their spec for the audio; minimap / standings dots use two colours where the UI supports it.
2. Battery, limiter, compound, mute: E (hold) boost, Q toggles the limiter (keyboard) and LB (pad, pressed.limiter), T / Back cycles the next compound (S -> M -> H), M toggles mute; limiter state shown in the telemetry graphic and the pit strip; car.setBattery(1) and car.tyres.fit(next compound, default medium) on track load, at the start of qualifying and on the grid; tyres.setWearRate(view.wear) during a session, 1 in free practice.
3. Pit: pit = F1.createPit(); pit.update every physics step (or every frame with the frame dt — follow the owner's note: it must keep running while the car is frozen for a service) with slot = the room slot (0 offline); freeze the car during a service exactly like the grid lock (no car.update, R ignored, Esc / Start still open the menu); 'serviceStart' -> F1.audio.play('jack') / ('pitgun'), 'serviceDone' -> car.tyres.fit(next), audio, release; 'speeding' -> toast; ui.setPit(...) every frame; pit.reset() on every placement; cars in the pit lane (own or remote, by track.pit.contains or inLane) are ghosts to each other and to track cars (skip in collisions and impact reports); track.update(t) every frame.
4. Telemetry: every frame pass the contract's fields (speedKmh, gear, rpm, rpmIdle / rpmShift / rpmMax from car.spec, throttle, brake, battery (null without ERS), deploy, harvest, limiter, inPit, limitKmh, tyres {compound, wear, flat, puncture}, nextCompound, team, car, colour) through ui.updateHUD without allocating per frame.
5. Audio: F1.audio.init() at boot (Electron allows autoplay; electron-main.js adds app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')) and again on the first key / click / pad input; setActive(running); update(dt, car.state, head pose including the head-look yaw, remote cars with their spec) every frame; beep('light') each time the start lights increase and beep('go') at lights out (also for spectators); ui volume / mute -> setVolume / setMuted.
6. Grand Prix: onGpStart({q, r, wear}) -> gp.start({q, r, year, wear}, track.length); the session year decides the cars (a player whose car is not of the session year is switched at quali start with a toast); parc fermé: car choice locked while a session is on.
7. F1.game peek additionally exposes cockpit, pit, tyres (car.tyres), spec (car.spec) — read-only getters — for the end-to-end tests.
VERIFY in devtests/v6-smoke/ (offscreen Electron, own userData dir, READ the screenshots) and report exact results:
 a. boots clean; every v5 flow still works: run npx electron devtests/gp-smoke/smoke.js (full), devtests/ui-gp/shots.js, PORT=24810 DEAD_PORT=24811 devtests/integration/mp-e2e.js, and the five node suites plus test/car.test.js, test/tyres.test.js, test/pit.test.js, test/cars.test.js — all green (update expectations only where v6 legitimately changed the DOM / HUD, and say which).
 b. year / car: pick 2012 and a 2012 car in the menu -> car.spec is that car (7 gears, V8 rpm, KERS battery), the cockpit style is 'modern', the telemetry shows its team; switch to 2021 and a car -> halo; 2025 standard car -> car.spec deep-equals F1.REF_SPEC and driving 10 s of recorded input gives the same trajectory as v5 would (compare with a reference run of the git HEAD game if practical, else with F1.REF_SPEC physics directly).
 c. battery: E held on a straight -> state.deploy > 0, battery drains, speed gain vs not deploying; braking -> harvest; 2010 car -> no battery (telemetry hides it, E does nothing).
 d. pit: drive (scripted inputs through the real input path) into the pit lane of Monza with Q (limiter) on: speed capped at the limit, the pit strip shows the box distance, stop in box 1 -> service countdown, jack / gun sounds requested, car frozen, released with fresh tyres of the chosen compound (T pressed before); again at 120 km/h without the limiter -> speeding toast and a 5 s longer stop; the lap counts through the pit lane; the light curtains visible in a screenshot; Monaco (entry after the line) works too.
 e. tyres: a few laps at wear x5 on Monza (time-warp the rAF like devtests/gp-e2e/solo.js does) -> wear visible in the telemetry tyre icons, grip dropping, a pit stop restores them.
 f. audio: F1.audio.debug shows the worklet backend running, the own engine rpm tracking car.state.rpm, shifts counted, remote voices present when another car is near (two-window room), beeps on the lights; muting via M and the slider works.
 g. room: host picks 2014, guest follows (toast, car switched to a 2014 car), both pick different teams, liveries visible on each other's car (screenshot), a Grand Prix with wear x3 starts with the year shown, parc fermé blocks the car picker, cars in the pit lane are ghosts to each other.
 h. gamepad (fake pad): RB boost, LB limiter, Back compound, still everything v5 did.
Report every product change and every bug found (file:line, cause, fix).`, { label: 'main.js v6 glue', phase: 'Glue', schema: REPORT })

phase('Critic')
const critic = await agent(`${PRE}

Another agent has just wired v6 into js/main.js and verified it with devtests/v6-smoke/. Its report, only so you know what exists (do not trust its conclusions):
${JSON.stringify(glue ? { summary: glue.summary, apiNotes: glue.apiNotes, openIssues: glue.openIssues } : null, null, 1)}

You are a fresh pair of eyes and now own js/main.js, js/ui.js, index.html, electron-main.js and devtests/v6-critic/ (new); small surgical fixes elsewhere are allowed when needed (list them) — EXCEPT in the files other fixers may still be editing (net/*, js/net.js, js/gp.js, preload.js, js/audio.js, js/cockpit.js, js/carmodel.js, js/car.js): report defects there in openIssues instead. TCP ports 24850-24899.
Play the game the way a player would, in offscreen Electron with real key events and a fake pad, and look for everything that is wrong, confusing or broken — READ your screenshots:
- the first minutes of a new player: boot, the menu (is the year / car picker understandable, does the side panel still let you reach the track grid, the multiplayer panel, the Grand Prix panel, the settings), pick a track, drive: does the telemetry graphic read well over the cockpit, do hints mention Q / E / T / M, do toasts make sense;
- every v6 feature end to end: battery (E) in 2011 (KERS), 2014, 2026 cars; pit limiter + a full pit stop at three tracks incl. Monaco and one where the lane is short; speeding penalty; compound choice; tyre wear at x5 until a puncture, then limping to the pits; flat spots from a lock-up / spin; dirty tyres after grass; the light curtains; year switching mid-session attempts (must be blocked); a room with host + 2 guests in different teams, the host changing the year in free practice, a Grand Prix with wear x2 and a pit stop in the race;
- robustness: rapid key mashing (Q / E / T / M / R / Esc), Esc during a pit service (the service must continue or restart sanely and the car must not be released early), R inside the pit lane, a track change during a service, switching cars while stopped in the pit box (blocked or sane), reconnecting, a guest whose car id is unknown (garbage via net.setProfile) — nothing may throw (watch the console), nothing may soft-lock the car.
Fix what you find (root causes, minimal changes in the style of the file), then re-run: node suites (collide, session, laps, gp, server, car, tyres, pit, cars), devtests/gp-smoke/smoke.js, devtests/v6-smoke (the glue agent's harness), devtests/ui-gp/shots.js, mp-e2e. Report every defect (file:line, symptom, cause, fix) and what is still weak.`, { label: 'v6 integration critic', phase: 'Critic', schema: REPORT })

return { glue, critic }
