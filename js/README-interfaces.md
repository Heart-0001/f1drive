# F1Drive module interfaces

Plain classic scripts, no modules, no bundler. Everything hangs off `window.F1` (`window.F1 = window.F1 || {}`).
`THREE` is the global from `lib/three.min.js` (r149 UMD). Must work from `file://` and inside Electron.

Script order in `index.html`: `lib/three.min.js`, `tracks-data.js`, `js/track.js`, `js/car.js`, `js/cockpit.js`, `js/ui.js`, `js/main.js`.

## Conventions

- Units: metres, seconds, radians. Y is up, ground is the XZ plane at y = 0.
- `heading h`: forward vector = `(sin h, 0, cos h)`. An Object3D with `rotation.y = h` has its local +Z pointing forward.
  Increasing `h` turns the car to the driver's LEFT (driver's right vector = `(-cos h, 0, sin h)`).
- Car is ~2 m wide, ~5.5 m long.

## tracks-data.js

```js
window.F1_TRACKS = [{ id, name, location, lengthKm, points: [[x, z], ...] }, ...]
```
`points`: closed centreline in metres, centred near the origin, first point NOT repeated at the end,
ordered in the racing direction, points[0] = start/finish line. Sorted by name.

## js/track.js

```js
F1.buildTrack(trackData) -> {
  group,        // THREE.Group with all track meshes (road, edge lines, kerbs, runoff, walls, start line, ground)
  samples,      // [{x, z, tx, tz, nx, nz, s, wallPos, wallNeg}], ~2 m spacing, closed loop
                //   (tx,tz) unit tangent in racing direction; (nx,nz) unit normal;
                //   s = distance along track from sample 0;
                //   wallPos / wallNeg: whether a wall exists on the +n / -n side at this sample
  length,       // total length in metres
  halfWidth,    // 7  (road edge = white line, lateral distance from centreline)
  wallDist,     // 12 (wall inner face, lateral distance from centreline)
  locate(x, z, hintIndex), // -> {index, d}: nearest sample and signed lateral offset d = (p - sample)·n.
                //   hintIndex >= 0: search only a local window around it (wrapping). hintIndex < 0: global search.
  dispose()     // free geometries/materials
}
```

## js/car.js

```js
F1.createCar() -> {
  state: { x, z, heading, speed /* m/s, signed, along heading */, steer /* smoothed -1..1, +1 = left */,
           sampleIndex, d, onGrass /* bool */, hit /* 0..1 wall impact strength this frame, else 0 */ },
  reset(track, sampleIndex),      // place on the centreline at that sample, facing the racing direction, stopped
  update(dt, input, track)        // input = {up, down, left, right} booleans; track = result of F1.buildTrack
}
```
`update` does physics, calls `track.locate`, and resolves wall collisions (respecting wallPos/wallNeg).

## js/cockpit.js

```js
F1.createCockpit(camera) -> {
  group,                 // THREE.Group: cockpit model + the camera (camera is added as a child)
  update(state, dt)      // positions group from car state, animates steering wheel/front wheels, FOV, hit shake
}
```

## js/ui.js

```js
F1.ui = {
  init({ onSelectTrack(trackData), onExitToMenu() }),
  showMenu(tracks), hideMenu(),
  setTrack(trackData),   // prepare minimap + track name for the HUD
  updateHUD({ speedKmh, gear, lap, curTime, lastTime, bestTime, x, z, heading }) // times in seconds or null
}
```
DOM ids/classes used by ui.js live in `index.html`; the 3D canvas is `<canvas id="game">`.

## v2 additions: elevation, banking, racing line

- `tracks-data.js`: each track gains `elev: [y, ...]`, one smoothed height in metres per entry of `points`
  (relative: the lowest point of the track is 0).
- `track.samples[i]` gains `y` (centreline height) and `bank` (radians, road roll about the tangent;
  positive = the +n side, i.e. the driver's left, is higher).
- `track.surfaceY(index, d)` -> height of the surface at lateral offset `d` from sample `index`
  (`samples[index].y + d * Math.tan(samples[index].bank)`). `locate` stays 2D (x, z).
- `car.state` gains `y`, `pitch` (nose up positive), `roll` (same sign as `bank`).

### js/raceline.js

```js
F1.buildRaceLine(track) -> {
  group,               // THREE.Group with the line mesh, add to scene
  points,              // [{x, z, d, sampleIndex, speed}]  speed = target speed in m/s on the ideal line
  update(carState),    // recolour the stretch ahead of the car from its current speed (green / yellow / red)
  setVisible(bool),
  dispose()
}
```
Must work when `track.surfaceY` / `samples[i].y` are absent (treat height as 0).

## v3 additions: load-based physics, scenery

- `tracks-data.js`: each track gains `geo: {lon0, lat0, kx, kz}` — the exact projection used for `points`
  (after the official-length rescale): `x = (lon - lon0) * kx`, `z = (lat - lat0) * kz` (kz is negative).
- `track.groundY(x, z)` -> height of the terrain at any world point (matches the rendered terrain mesh;
  inside the road/runoff corridor it returns the track surface height).
- car.js physics uses tyre load: gravity on the banked/sloped surface, centripetal load in banked corners,
  vertical curvature (light over crests, heavy in dips) and speed-squared downforce. `F1.CAR_PERF` exposes
  the constants raceline.js needs.

As implemented:
- `samples[i]` also carry `grade` (dy/ds), `halfW` (actual road half width), `wallPosDist` / `wallNegDist`
  (actual inner wall face offsets; close parallel roads share a mid wall).
- `track.nearest(x, z)` -> `{index, dist, d}` (global), `track.inCorridor(x, z, margin)` -> bool,
  `track.crossings` -> `[[i, j]]` (genuine crossings, e.g. Suzuka).
- `F1.CAR_PERF`: constants plus `normalAccel(v, bank, pitch, kappaV, latAccelLeft)`,
  `maxLatAccel(v, bank, pitch, kappaV, turnSign)`, `maxAccel(...)`, `maxDecel(...)`; kappaV > 0 over a crest.

### scenery-data.js (generated by tools/build-scenery.mjs from OpenStreetMap, ODbL)

```js
window.F1_SCENERY = {
  [trackId]: {
    buildings: [{ k, h, p }],   // k: 'grandstand' | 'building' | 'pit' | 'tower' | 'bridge'; h: height in m;
                                // p: footprint polygon [[x, z], ...] in track metres (not closed)
    areas: [{ k, p }],          // k: 'water' | 'forest' | 'sand' | 'grass' | 'asphalt' | 'urban'
    trees: [[x, z], ...]        // individual mapped trees (optional)
  }
}
```
A track id may be missing or sparse; scenery.js must fall back to procedural scenery.

### js/scenery.js

```js
F1.buildScenery(track, trackData, sceneryData /* may be undefined */) -> { group, dispose() }
F1.createSky() -> THREE.Object3D   // sky dome / sun / distant horizon, added once to the scene by main.js
```
Nothing from scenery may stand inside the track corridor (within the walls of any part of the track).

## js/main.js

Owns renderer/scene/camera/lights/sky/fog, keyboard input (WASD + arrows, R reset to nearest centreline sample,
Esc back to menu), main loop with clamped dt, lap timing, track switching (dispose old track).

## v4 additions: multiplayer

Script order gains `js/collide.js`, `js/carmodel.js`, `js/net.js` (before `js/ui.js`). Tests: `node test/collide.test.js`,
`node test/server.test.js`. Dedicated server: `node net/server.js [port]` (default 24500).

- `net/server.js` (Node, `ws`): `createServer({port, host, hostToken, maxPlayers, log}) -> Promise<{port, close(), info()}>`,
  `lanAddresses()`. Thin relay: roster, current track, host, 20 Hz snapshots, impact reports.
- `net/host.js` + `preload.js`: `window.f1host.startServer(port) -> {ok, port, addresses, token, error}`, `stopServer()`.
- `F1.net` (js/net.js): `create(port)`, `join(address)`, `leave()`, `setProfile({name, colour})`, `sendState(carState)`,
  `park()`, `sendLap(last, best)`, `sendHit(id, ix, iz)`, `selectTrack(trackId)` (host), `update()` (once per frame),
  `on('connected' | 'disconnected' | 'players' | 'track' | 'hit', fn)`; fields `connected, isHost, id, slot, trackId,
  hostInfo, roster, players` (`players[i] = {id, name, colour, slot, active, state}` with an interpolated car state).
- `F1.createCarModel(colour, name) -> {group, update(state, dt, eye), setColour, setName, dispose}` (js/carmodel.js).
- `F1.resolveCarCollisions(state, others, dt, contacts?)` and `F1.applyCarImpulse(state, ix, iz)` (js/collide.js, pure math).
- `F1.ui`: `init` also takes `onCreateRoom(port), onJoinRoom(address), onLeaveRoom(), onProfile({name, colour})`;
  `setNet(view)`, `getProfile()`, `toast(text, ms)`; `updateHUD` accepts `others: [{x, z, colour}]` for the minimap.

Wire protocol (JSON text frames, protocol version 1, max 2 KB per message):
client -> server `hello {v, name, colour, token?}`, `s {k: trackSeq, c: senderClockMs, s: [x, y, z, heading, pitch, roll, speed, steer]}`,
`track {id}` (host), `profile {name, colour}`, `lap {last, best}`, `hit {k, to, i: [ix, iz]}`;
server -> client `welcome {id, host, track, seq, players}`, `players {host, players: [{id, name, colour, slot, last, best}]}`,
`track {id, seq}`, `snap {p: [[id, c, x, y, z, heading, pitch, roll, speed, steer], ...]}`, `hit {from, i}`, `gone {id}`, `error {code}`.

## v5 additions: gamepad, lap counter, Grand Prix

Final script order in `index.html`:
`lib/three.min.js`, `tracks-data.js`, `js/track.js`, `js/car.js`, `js/cockpit.js`, `js/gamepad.js`, `js/raceline.js`,
`scenery-data.js`, `js/scenery.js`, `js/collide.js`, `js/carmodel.js`, `js/laps.js`, `net/session.js`, `js/net.js`,
`js/gp.js`, `js/ui.js`, `js/main.js`.

Tests: `node test/collide.test.js`, `test/server.test.js`, `test/session.test.js`, `test/laps.test.js`, `test/gp.test.js`.

### Already implemented building blocks (APIs are fixed; additive changes only)

- `F1.gamepad` (js/gamepad.js, see its header): `poll() -> state {connected, id, throttle, brake, steer, lookX, lookY,
  up, down, left, right, pressed: {reset, line, menu, recentre}}`, `mergeInput(keys, out) -> out`, `rumble(strength, ms)`,
  `active`, `onChange(connected, id)`. `poll()` gaps longer than 500 ms swallow button presses (edge resync).
- `car.update(dt, input, track)`: `input` may also carry `throttle`, `brake` (0..1 or null) and `steerAxis` (-1..1, +1 = left, or null).
- `cockpit.setLook(x, y)` (normalised -1..1, call every frame) and `cockpit.centreLook()`.
- `carModel.setGhost(on)`: translucent remote car.
- `F1.createLapCounter(nSamples, startIdx)` (js/laps.js) -> `lap {started, n, time, last, best, sector, void, behind,
  reset(idx), arm(idx), sync(idx), update(idx, speed, dt) -> 0 | 1 (timing started) | 2 (lap completed, time in lap.last),
  progress(idx)}`.
- `F1.createSession({random})` (net/session.js, also `require('./net/session')` in node): pure Grand Prix rules.
  `addPlayer(id, name, now)`, `removePlayer`, `rename`, `start({q, r, len}, now)`, `skip(now)`, `end()`, `again(now)`,
  `lap(id, time, now) -> '' | reason`, `progress(id, v)`, `tick(now)`, `snapshot()`, `phase`, `sid`.
  Snapshot: `{sid, phase, q, r, len, lightsAt, goAt, winnerAt, endsAt, grid: [id], order: [id],
  players: [{id, name, spec, left, qLaps, qBest, qDone, rLaps, rTime, rBest, fin, dnf, gap, down}]}` (times in s, clocks in ms).
- `F1.net` Grand Prix additions: `session` (last snapshot or null), `on('gp', fn(snapshot))`, `on('lapRejected', fn(why))`,
  `gp(action, cfg)` (host only), `sendGpLap(sid, time)`, `setProgress(v | null)`, `serverNow()`.
- Wire protocol additions: client -> server `ping {c}`, `gp {a: 'start' | 'skip' | 'end' | 'again', q, r, len}` (host),
  `gl {k: trackSeq, sid, time}`, and `s` may carry `g` (race progress); server -> client `pong {c, s}`,
  `gp {now, s: snapshot}`, `glno {why}`, and `welcome` carries `now`.

### Grand Prix: what the player gets (requirement)

Q laps of individual qualifying decide the grid, then an R-lap race. Q and R are configurable (1..20 / 1..99).
In a room the host starts it; it also works alone (single player, local session, same rules). No AI cars.

- `free`: free practice exactly as before (no session).
- `quali`: everybody drives at the same time but alone: the other cars are ghosts (translucent, no collisions, no impact
  reports). Cars start from the multiplayer start slot (`placeOnGrid(net.slot)` in a room; alone the free-practice start:
  on the centreline, 10 samples before the line); timing starts at the first
  crossing of the line; each completed timed lap is reported. After Q laps the driver is done and may keep driving (nothing
  counts any more). When everybody is done (or the host skips) -> `grid`.
- `grid`: every classified driver is put on the grid slot of their qualifying position (`placeOnGrid(gridSlot)`), input is
  locked and the car is frozen. Five red lights come on one per second from `lightsAt`; all go out at `goAt` (synchronised
  through the session clock). At lights out the input unlocks and the lap counter is armed (`lap.arm`), the clock running
  from `goAt`.
- `race`: cars are solid again. Live order by distance; finishing = completing R laps, or the first crossing of the line
  after the winner has finished. 90 s after the winner the race closes. Then `results`.
- `results`: classification table; whoever may control can start another one ("again") or end it (back to `free`).
- Players who join during grid / race / results are spectators until the next session: free-roaming ghosts, not classified.
  A spectator on the room's track sees the start lights too (not locked, no `go` event; caption 正賽即將起跑 / 正賽開始).
- Grid slots are the painted grid boxes: `track.grid[slot]` (js/track.js, 16 boxes: box `slot + 1` has its front bar
  `(slot + 1) * 8` m behind the line, 3 m to the driver's left for even slots / right for odd ones, closer to the centreline
  where the road is narrow) = `{index, d, x, z, heading}`: the sample the front of the bar is on, the lateral offset of the
  box centreline, the point where the car's NOSE goes (middle of the rear edge of the front bar) and the box direction.
  `placeOnGrid(slot)` puts the car's origin 2.8 m (`CAR_NOSE`) behind that point, facing `heading`.
- A driver who leaves during the race is classified DNF. Picking another track ends the Grand Prix.

### js/gp.js — `F1.gp` (client-side Grand Prix controller)

Pure logic: no DOM, no THREE; loadable in node (`module.exports = F1.gp`, tests in `test/gp.test.js` with a stub `net`).
One object for both modes: online it mirrors the room's session (`net.session`, clock `net.serverNow()`), offline it owns a
local `F1.createSession()` with one player (id 1) and a GAME clock that only advances in `update(dt)` (so the menu pauses it).

```js
F1.gp = {
  init({ net, getProfile }),  // net: F1.net or null; getProfile() -> {name, colour} (the offline driver). Call once at boot.
  on(name, fn),               // 'phase'       fn(phase, prevPhase): phase changed, or a new session id started
                              // 'go'          fn(): lights out, once per session, only when we take part
                              // 'change'      fn(): anything view() reports changed (snapshot, phase, role, connection)
                              // 'lapRejected' fn(why)
  // read-only state, kept current by events and update()
  online,        // the session is the room's
  phase,         // 'free' | 'quali' | 'grid' | 'race' | 'results'
  sid,           // session id; a new Grand Prix (or "again") gets a new one
  snapshot,      // last session snapshot or null
  selfId,        // our id in the snapshot: net.id online, 1 offline
  taking,        // we are classified in this session (in the snapshot, not spec, not left); false in 'free'
  canControl,    // we may start / skip / end / again: always offline, only the host online
  inputLocked,   // phase 'grid', taking, and now() < goAt
  lights,        // red lights lit, 0..5 (0 before lightsAt and from goAt on)
  goFlash,       // true during the 1500 ms after goAt ("lights out" indicator)
  sinceGo,       // seconds since lights out (0 before / outside grid+race)
  gridSlot,      // our index in snapshot.grid, -1 when not on the grid
  lap, lapTotal, // our laps completed in this phase (qLaps / rLaps) and the target (q / r); 0 / 0 in 'free'
  // calls
  now(),                         // session clock, ms
  start({q, r}, trackLength),    // -> bool. offline: starts the local session; online host: net.gp('start', {q, r, len})
  action(a),                     // 'skip' | 'end' | 'again' -> bool
  update(dt),                    // every rendered frame while the game loop runs, FIRST thing in the frame (only main.js's
                                 //   controller poll comes before it: Start opens the menu instead); dt = the frame's
                                 //   clamped dt in seconds. Advances the offline clock, ticks the local session, refreshes
                                 //   inputLocked / lights / goFlash / sinceGo, fires 'go'.
  lapDone(time),                 // the lap counter completed a timed lap (s). Ignored unless taking in quali / race.
  setProgress(v),                // race distance (lapCounter.progress(idx)); forwarded only while racing, else cleared
  isGhost(playerId),             // -> bool: draw that remote car translucent and do not collide with it
  trackChanged(),                // main.js is loading another track: an offline session ends (-> 'free')
  view()                         // -> GpView, a fresh plain object for F1.ui.setGp
}
```

`isGhost(id)`: `free` -> false; `quali` -> true; `grid` before `lightsAt` -> true (cars are still being placed);
`grid` / `race` / `results` -> true when we are not taking part, or that player is a spectator / not in the snapshot.

Connecting to a room abandons an offline session; disconnecting goes back to an idle offline one (both fire `phase` when
the phase changes). Events are fired from net events too (not only from `update`), so they arrive while the menu is open.

```js
GpView = {
  phase, online, canControl, taking,
  spectating,        // a session is on and we are in the room but not classified
  q, r,              // laps of the running / last session (defaults 3 / 5)
  lap, lapTotal,     // as above
  pos, count,        // our place (1-based, 0 = none) among `count` classified drivers
  done,              // we completed qualifying (qDone) / finished the race (fin)
  endsInMs,          // race: ms until the race closes once the winner has finished, else null
  rows: [{           // classified drivers in order (qualifying / grid: by best time; race / results: by distance, time)
    pos, id, name, colour, isSelf,
    laps,            // qLaps or rLaps
    best,            // best lap in s or null (qBest in quali / grid, rBest in race / results)
    time,            // race / results: total race time in s once finished, else null
    gap,             // race / results: s behind the leader on the same lap, else null
    down,            // race / results: laps behind the leader (0 = same lap)
    done,            // qDone / fin
    dnf, left
  }],
  spectators: [{id, name, colour}],
  // added by main.js before it hands the view to the UI:
  canStart,          // a track is loaded (offline) / the room has a track and we are on it (host)
  startHint          // why not, e.g. '先選一條賽道'
}
```
Colours come from `net.roster` online (`'#888888'` for drivers who left), from `getProfile()` offline.

### js/ui.js + index.html (Grand Prix, gamepad)

```js
F1.ui.init({ ..., onGpStart({q, r}), onGpAction('skip' | 'end' | 'again') })
F1.ui.setGp(view)            // menu: 大獎賽 panel (Q / R inputs, 開始 / 跳過排位 / 結束 buttons, state, standings);
                             // HUD: session box (排位賽 / 正賽, lap n / N, position, live standings; replaces the room roster
                             //      box while a session is on); results overlay with 再來一場 / 結束 (canControl) and 關閉.
F1.ui.setLights(n, go, watching)
                             // start lights in the HUD: n = -1 hidden, 0..5 red lights lit; go = true: lights-out flash.
                             // watching (optional) = true: the viewer is a spectator: caption 正賽即將起跑 / 正賽開始 instead of
                             // 準備起跑 / GO. Called every frame: cache, touch the DOM only on change.
F1.ui.setPad(connected, id)  // controller connected / gone: shows / hides the controller hints
F1.ui.updateHUD(h)           // h.lapTotal (number | null): the lap row shows "lap / lapTotal"
```
Q and R are remembered in localStorage. All UI text is Traditional Chinese. The HUD layer is `pointer-events: none`
except its buttons. `index.html` owns the DOM, CSS and the script order above.
`F1.ui.toast()` shows in both states: `#hud-toast` is a layer of its own (not inside `#hud`), at the top while driving and
at the bottom while the menu is open. `F1.ui.init` looks up every element before it wires anything and calls `onProfile`
last, so that callback may use the whole API (`setGp`, `setNet`, ...).

### js/main.js (v5 glue)

- Lap timing uses `F1.createLapCounter` (the inline quarter logic is gone); `R` reset -> `lap.sync(idx)`.
- Gamepad: every frame `ps = F1.gamepad.poll()`, the first thing in the frame; `cockpit.setLook(ps.lookX, ps.lookY)`;
  `ps.pressed.recentre` -> `cockpit.centreLook()`; `ps.pressed.menu` = Esc (the menu opens before the frame counts for
  anything: no `gp.update`, so the session clock does not advance), `.reset` = R, `.line` = L; `car.update(STEP,
  F1.gamepad.mergeInput(input, driveInput), track)`; `F1.gamepad.rumble` on wall / car hits; while the menu is open a
  ~100 ms interval polls the pad so Start resumes; `F1.gamepad.onChange` -> `ui.setPad` + toast.
- Grand Prix: `F1.gp.init`, `gp.update(dt)` first in the frame (after the pad poll); `gp.on('phase')` places the car (see
  the rules above), resets the lap counter and leaves the menu for `quali` / `grid`; `gp.on('go')` -> `lap.arm(idx);
  lap.time = gp.sinceGo` at this frame's timestamp (the lap clock advances by the frames' timestamp differences; in a room
  `gp.sinceGo` is read from `net.serverNow()` when the frame's callback runs, so the delay since the timestamp,
  `performance.now() - t`, is taken off: otherwise the race clock would run ahead of the session clock by it);
  lap counter result 2 -> `gp.lapDone(lap.last)`; `gp.setProgress(lap.progress(idx))` every frame;
  `gp.on('change')` -> `ui.setGp(view + canStart / startHint)`; `ui.setLights(n, go, !gp.taking)` every frame: shown during
  `grid` / the go flash to everybody on the session's track (alone, or in a room on the room's track).
- HUD timing box in a Grand Prix: once our laps of the phase are done (`view.taking` and `view.done`, or phase `results`)
  it stops: 本圈 `--`, 上一圈 / 最快圈 keep the counted laps (a lap driven afterwards counts for nothing and must not
  replace them); it runs again in the next phase / session.
- Room texts: the host's status 房間已建立，你是房主。選一條賽道開始。 drops the second sentence once the room has a track;
  `ui.setNet(view)` gets `roomTrack` (bool: the room has a track), and a guest's banner over the locked track grid says
  賽道由房主選擇；房主換賽道時，所有人會一起載入。 instead of 等待房主選擇賽道… (`lockText` still overrides it).
- While `gp.inputLocked` the car is frozen: no `car.update`, speed 0, R / pad reset ignored (Esc / Start still open the menu).
- Remote cars: `model.setGhost(gp.isGhost(id))`; ghosts are left out of `others` (collisions) and their impact reports
  are ignored; nothing is reported against them.
- `F1.game` (debug peek) also exposes `gp`, `lap`, `input`, `raceLine`.

## v6 additions: sound, seasons and cars, drivetrain + battery, tyres, pit lane, broadcast HUD, detailed cockpit

What the user asked for (translated, in the order it was asked):
1. Engine sound for the own car and for nearby cars ("no immersion without it"); gear changes must be clearly audible.
2. Speed, throttle and brake shown in the bottom CENTRE of the screen like the driver graphic of the F1 TV broadcast.
3. A battery system.
4. Cars of the different teams with their own numbers from real data. The Grand Prix starts by choosing a YEAR; everybody
   in the room then picks a team's car of that year. Seasons offered: 2010..2026 (the user narrowed it from "all years").
5. The first-person car (cockpit) must look refined and detailed; cars seen from a distance may stay as they are.
6. A pit lane on every track; a pit speed-limiter mode on a button; stopping in your pit box changes the tyres, which
   takes a random number of seconds; tyres wear in several ways; the pit entry and exit are marked by light curtains
   everybody can see. Keyboard: Q = pit limiter, E = battery; controller mapping is ours to choose.

Final script order in `index.html`:
`lib/three.min.js`, `tracks-data.js`, `js/seasons-data.js`, `js/cars.js`, `js/track.js`, `js/tyres.js`, `js/car.js`,
`js/cockpit.js`, `js/gamepad.js`, `js/audio.js`, `js/raceline.js`, `scenery-data.js`, `js/scenery.js`, `js/collide.js`,
`js/carmodel.js`, `js/laps.js`, `js/pit.js`, `net/session.js`, `js/net.js`, `js/gp.js`, `js/telemetry.js`, `js/ui.js`,
`js/main.js`.

Golden rule for every module below: **the reference car on fresh medium tyres, with no boost, no limiter and no pit
stop, drives exactly as the v5 car did** (same accelerations, grip, braking, top speed). All existing tests, racing-line
checks and autopilots were tuned on it and must keep passing unchanged.

Controls (keyboard / controller): W S A D or arrows / RT LT left stick; R / A or Y reset; L / X racing line;
Esc / Start menu; **Q / LB pit limiter (toggle)**; **E / RB or B battery (hold)**; **T / Back (View) next tyre compound**;
**M mute**; right stick look, RS click recentre.

### CarSpec — what a car is (js/cars.js resolves it, js/car.js / audio / cockpit / HUD consume it)

```js
CarSpec = {
  id,                 // '<year>-<constructor>' e.g. '2004-ferrari', '<year>-standard'; /^[a-z0-9-]{1,40}$/
  year, team, teamZh, car, engine,     // display: 'Ferrari', '法拉利', 'F2004', 'Ferrari 3.0 V10'
  colour, colour2,                      // livery '#rrggbb'
  ratings: { topSpeed, accel, cornering, braking, ers },   // 0..100 inside its season, 50 = that season's standard car
  note,                                 // one line, Traditional Chinese, or ''
  // physics — ABSOLUTE values in js/car.js units (everything is per kg):
  power,              // W/kg
  dragK,              // aero drag deceleration = dragK * v^2
  downforce,          // aero load, m/s^2 per (m/s)^2
  latBase, latMax,    // mechanical lateral grip on the flat (m/s^2) and the overall cap
  brakeBase,          // mechanical braking (m/s^2)
  traction,           // traction limit (m/s^2)
  // drivetrain
  gearKmh,            // upshift speeds of gears 1..n-1 (km/h); n = gearKmh.length + 1 forward gears
  topKmh,             // speed at rpmShift in top gear
  rpmIdle, rpmShift, rpmMax,
  shiftTime,          // s: how long a gear change SOUNDS (ignition cut), 0.03..0.08; the drive is not interrupted
  cylinders, aspiration,   // 8 (2.4 l V8, 2010-2013) or 6 (1.6 l V6 turbo-hybrid, 2014 on); 'na' | 'hybrid'
  ers,                // null (no battery) | { store (J/kg), power (W/kg), harvest (W/kg) }
  cockpit             // style id: 'modern' (2010-2017, no halo) | 'halo' (2018-2021) | 'halo18' (2022 on: 18-inch wheels, wheel covers)
}
```
`F1.REF_SPEC` (defined by js/car.js) is the v5 car: its physics numbers are today's constants, 8 gears
(`gearKmh [60, 100, 140, 180, 220, 260, 300]`, `topKmh 345`), `rpmIdle 4000, rpmShift 11800, rpmMax 12500`,
`shiftTime 0.05`, 6 cylinders, `'hybrid'`, `ers {store 4656.67, power 145.52, harvest 230}` (per kg), cockpit `'halo18'`, id `'2025-standard'`.

Drivetrain formula (shared by car.js for the own car and by audio.js for remote cars): gear by speed against `gearKmh`
(downshift 8 km/h below the upshift speed of the lower gear: hysteresis); `rpm = rpmShift * v / top(g)` with
`top(g) = gearKmh[g - 1]` (`topKmh` for the top gear), floor `rpmIdle`, ceiling `rpmMax`; firing frequency =
`rpm / 60 * cylinders / 2` Hz.

### js/seasons-data.js + js/cars.js (generated data + lookup)

```js
window.F1_SEASONS = [{ year, label, engine, era: { ...the CarSpec physics / drivetrain / ers / cockpit fields of that
                       season's STANDARD car }, cars: [{ id, team, teamZh, car, engine, cylinders?, aspiration?,
                       colour, colour2, ratings, perf: { power, drag, downforce, grip, brake, traction, ersPower,
                       ersHarvest } /* multipliers 0.95..1.05 on the era */, note }] }, ...]   // 2010..2026
F1.cars = {
  seasons,                       // [{year, label, engine, count}] ascending
  list(year) -> [CarSpec],       // that season's cars; first is '<year>-standard' (era car, every multiplier 1)
  get(id) -> CarSpec | null,
  resolve(id, year?) -> CarSpec, // never null: unknown id -> the same constructor in `year` if it raced then, else that
                                 //   year's standard car; no year -> DEFAULT_YEAR's standard car
  DEFAULT_YEAR                   // the newest season
}
```
- Generated by `tools/build-seasons.mjs` from the open F1DB database (CC BY 4.0, credited in the menu next to
  OpenStreetMap), the era research (`tools/eras.json`), the liveries (`tools/liveries/*.json`) and the hand-researched
  current season (`devtests/cars-data/`). Sources and method: `docs/seasons-data.md`, `docs/eras-research.md`,
  `docs/cars-data-sources.md`. The menu states that the figures are estimates derived from public data.
- Inside a season the cars differ by at most about 1..1.5 % in lap time, each with a recognisable character; between
  seasons the era physics is calibrated so that simulated lap times follow the real pole-time index of the eras.
- The era whose physics equals `F1.REF_SPEC` is the calibration anchor.

### js/car.js additions

- `F1.REF_SPEC`; `F1.carPerf(spec) -> perf` (same fields and functions as `F1.CAR_PERF`, which stays the reference
  car's, plus `gearFor(v)`, `rpmFor(v, gear?)`, `topSpeed`); `F1.createCar(spec?)`, `car.setSpec(spec)`, `car.spec`,
  `car.perf`, `car.tyres` (the `F1.createTyres()` instance), `car.setBattery(v)`.
- `input` gains `boost` (bool, hold: deploy the battery) and `limiter` (bool: pit limiter engaged).
- `car.state` gains, refreshed every `update`: `throttle`, `brake` (0..1 pedals actually applied), `gear` (-1 reverse,
  0 neutral / standing, 1..n), `rpm`, `shiftT` (s since the last gear change), `battery` (0..1, 0 when the car has no
  ERS), `deploy`, `harvest` (0..1), `slip` (0..1 past the grip limit: tyre noise), `limiter` (bool), `inPit` (bool: in
  the pit lane between the entry and exit lines), `vib` (0..1 vibration from flat spots / punctures).
- Gear changes do not interrupt the drive (seamless-shift gearboxes throughout 2010..2026); `spec.shiftTime` only
  shapes the sound. `state.shiftT` restarts at 0 on every gear change, `state.shiftDir` is +1 (up) or -1 (down).
- ERS: only with `spec.ers`. Deploy while `input.boost`, throttle applied, battery > 0 and not braking: `ers.power` is
  added to the engine power (still traction-limited). Harvest under braking (proportional to pedal and speed, up to
  `ers.harvest`) and a little on lift-off above 20 m/s; bookkeeping only, braking distances do not change. Reference
  car: a full store lasts ~32 s, a racing lap without deploying recovers 50..70 % of it, +15..20 km/h at the end of a
  long straight. `car.reset()` leaves the battery alone; main.js calls `car.setBattery(1)`.
- Pit limiter: while `input.limiter` the drive is cut above `track.pit.limitKmh` (80 when there is no pit) — it does not
  brake the car, the driver must slow down before the entry line.
- Tyres: the grip multipliers of `car.tyres.state.grip` scale lateral grip, braking and traction; car.js feeds
  `car.tyres.update` every step.
- Pit lane: inside `track.pit` the lane is asphalt (not grass), the car collides with the pit wall (`track.pit.wallD`)
  from both sides and with the outer wall as usual.

### js/tyres.js — `F1.createTyres(opts)` (pure logic, node-testable: `test/tyres.test.js`)

```js
tyres = F1.createTyres({ random })
tyres.fit(compound)             // 'S' | 'M' | 'H': a new, clean set at working temperature
tyres.setWearRate(mult)         // 0 = no wear (tests); 1 normal; Grand Prix option up to 5
tyres.update(dt, load)          // load = { speed, lat (-1..1 share of the lateral grip used, + = turning left),
                                //   brake (0..1 share of braking grip), drive (0..1 share of traction), slip (0..1),
                                //   onGrass, hit (0..1 impact this step) }
tyres.state = {
  compound,
  wear: [FL, FR, RL, RR],       // 0 new .. 1 gone
  flat: [..],                   // flat-spot severity 0..1 (slides / lock-ups / impacts): vibration, less braking grip
  temp: [..],                   // deg C; outside the working window the grip drops (overheating from sliding)
  dirt,                         // 0..1 after an excursion on the grass, cleans up in a few seconds on asphalt
  puncture,                     // -1 or the wheel index: from a worn-out tyre or a heavy impact; pit to fix
  grip: { lat, brake, traction },   // multipliers; exactly 1, 1, 1 for a new clean medium set in its window
  vib                           // 0..1
}
```
Medium = reference (multipliers exactly 1 when new); soft: a little more grip, wears about twice as fast; hard: a
little less grip, lasts about twice as long. Below 50 % wear the loss is under 1 % (existing short drive tests and
autopilots are not disturbed), about 4 % at 75 %, then grip falls off a cliff towards 100 %. At wear rate 1 a medium
set lasts roughly 15 hard laps of an average track.

### js/track.js additions — pit lane

Every track gets a pit lane next to the start / finish straight, on the side of the real pit buildings where the
scenery data has them (else the side with room). `track.pit` is `null` only if a track really has no room.
```js
track.pit = {
  side,               // +1 on the +n side (driver's left), -1 on the other
  limitKmh,           // 80 (60 on the tight street circuits)
  from, to,           // sample indices: first / last sample of the lane incl. its tapers (cyclic, `from` before the line)
  entry, exit,        // sample indices of the entry line and exit line (the light curtains, speed limit between them)
  laneD(index),       // signed lateral offset of the lane's centre at that sample, NaN outside from..to
  laneHalfW,          // half width of the driving lane
  wallD(index),       // signed lateral offset of the pit wall between track and lane, NaN where it is open (entry / exit)
  wallHalfT,          // half thickness of the pit wall
  boxes,              // 16 x {slot, index, d, x, y, z, heading}: the stopping position of each room slot, outside the driving lane,
                      //   every box at least 12 m from the entry / exit line (a car stopped in it never has a curtain in its face)
  inLane(index, d),   // -> bool: between the entry and exit lines, on the lane side of the pit wall
  contains(x, z)      // -> bool (global search)
}
```
- Geometry: lane surface, entry / exit tapers from the track edge, pit wall with openings, painted boxes (numbered, in
  slot order), speed-limit lines, a garage / pit building face behind the boxes; **light curtains** at `entry` and `exit`:
  translucent glowing planes across the lane (visible from the cockpit and from far away, distinct colours for entry and
  exit). `track.update(t)` (optional) may animate them.
- `samples[i].wallPosDist / wallNegDist` on the pit side include the lane and boxes (the outer wall is the garage face);
  `inCorridor` covers the pit lane too (no scenery in it); `locate` / `nearest` keep working with the car in the lane,
  so laps count through the pit lane (the line extends across it).

### js/pit.js — `F1.createPit(opts)` (pure logic, node-testable: `test/pit.test.js`)

```js
pit = F1.createPit({ random })
pit.reset()
pit.update(dt, carState, track, { slot, limiter }) -> event | null
    // 'enter' (crossed the entry line into the lane), 'exit', 'speeding' (first time over the limit in this visit),
    // 'serviceStart', 'serviceDone'
pit.state = { inLane, speeding, inBox, service /* null | {total, left, penalty} */, stops }
```
- Stop in YOUR box (`track.pit.boxes[slot]`: within about 2.5 m along, 1.2 m across, roughly aligned, speed below
  0.5 m/s): the service starts and takes a random 2.0..4.5 s (the occasional slow stop). During the service the car is
  held (main.js freezes it as on the grid). At 'serviceDone' main.js fits the chosen compound and releases the car.
- Speeding in the lane (more than 3 km/h over `limitKmh` between the lines) adds a 5 s hold to that visit's stop; in the
  next stop if the driver did not stop this time.
- Cars in the pit lane are ghosts to each other and to cars on the track (no collisions in the lane).

### js/audio.js — `F1.audio` (Web Audio, fully synthesised: the project ships no sound files)

```js
F1.audio = {
  supported, init(), setVolume(v), volume, setMuted(on), muted, setActive(on),
  setEngine(spec),              // the own car's engine: cylinders, aspiration, rpm range, shiftTime (CarSpec)
  update(dt, own, listener, others),
      // own: car.state; listener: {x, y, z, heading}; others: [{id, x, y, z, heading, speed, spec}] (spec optional)
  beep(kind),                   // 'light' | 'go'
  play(kind, strength),         // one-shots: 'pitgun', 'jack', 'limiterOn', 'limiterOff'
  dispose()
}
```
Own car: engine (pitch from rpm through the spec's cylinder count; timbre by load and by aspiration — the 2010-2013
2.4 l V8 screams to 18 000 rpm, the V6 turbo-hybrid is lower with a turbo whistle), a **clearly audible gear change** (torque cut of
`shiftTime`, an upshift bang / ignition-cut crack, a rev-matching blip on downshifts), the limiter stutter at `rpmMax` and the pit-limiter stutter, ERS whine, wind / road noise, tyre scrub from
`slip`, flat-spot thump from `vib` at wheel frequency, grass rumble, impact thump. Remote cars: their own spec's engine
through the drivetrain formula, distance attenuation, panning, Doppler; nearest `MAX_VOICES` only.

### js/cockpit.js + js/carmodel.js

- `cockpit.setCar(spec, accent)`: cockpit style by `spec.cockpit` and livery by `spec.colour / colour2` (accent = the
  player's own colour). The first-person car is detailed: procedural textures (carbon weave, tyre sidewalls with
  lettering and a wear / compound band, livery panels with stripes and number), modelled suspension arms, wing elements
  and endplates, mirrors, halo from 2018, a steering wheel whose display / shift
  lights show the live gear, speed, rpm lights, battery and pit-limiter state. `update(state, dt)` also shakes with
  `state.vib`. Everything is generated in code (canvas textures), no asset files.
- `carModel.setLivery(colour, colour2, accent)`; remote cars otherwise stay as they are.

### js/telemetry.js — `F1.telemetry` (the bottom-centre broadcast graphic)

```js
F1.telemetry.init(canvasElement)
F1.telemetry.draw(t)   // every frame; t = { speedKmh, gear, rpm, rpmIdle, rpmShift, rpmMax, throttle, brake,
                       //   battery (0..1 | null = no ERS: hide), deploy, harvest, limiter, inPit, limitKmh,
                       //   tyres: {compound, wear: [4], flat: [4], puncture}, nextCompound, team, car, colour }
```
Speed big in the middle with KM/H, gear, rpm arc with shift lights, throttle (green) and brake (red) gauges, battery
bar with percentage and deploy / harvest indication, four tyre wear indicators with the compound letter, a flashing
PIT LIMITER state, the team colour and car name. One canvas, no DOM work per frame, crisp at any device pixel ratio.

### Network, session, Grand Prix controller (net/session.js, net/server.js, js/net.js, js/gp.js)

- Profile: `hello` / `profile` and every roster row gain `car` (a CarSpec id; invalid -> dropped / kept as the previous).
  `F1.net.setProfile({name, colour, car})`; roster and `players[i]` carry `car`.
- Room year: the room has a `year` (the host's; host-only message `year {y}`, only in phase `free`), sent in `welcome`
  and with every `players` roster message; `F1.net.year`, `F1.net.setYear(y)`, event `'year'`. Everybody in the room
  picks among that year's cars; a client whose car is of another year switches to `F1.cars.resolve(id, year)`.
- Grand Prix config gains `year` (the room year at the start) and `wear` (tyre wear multiplier 1..5, default 1):
  `start({q, r, len, year, wear})`; the snapshot carries both. Cars cannot be changed while a session is on (parc fermé).
- `F1.gp`: `start({q, r, year, wear}, trackLength)`; `view()` gains `year`, `wear`; `isGhost(id)` unchanged (main.js adds
  the pit-lane ghost rule).

### js/ui.js + index.html (v6)

- The speed / gear box in the corner is replaced by `<canvas id="hud-telemetry">` in the bottom centre (js/telemetry.js).
- Menu: **年份** selector (every season; in a room only the host can change it, everybody sees it) and the **車輛** list of
  that year (team, car, engine, rating bars, note; the chosen one highlighted); both disabled while a session is on.
  `init({..., onYear(year), onCar(id), onAudio({volume, muted})})`, `setCars({year, cars, selected, canPickYear,
  canPickCar, seasons})`, `getCar()`, `getAudio()`; the choice and the audio settings persist in localStorage.
- Grand Prix panel: shows the year, and a 輪胎損耗 (wear x1..x5) control next to Q / R; `onGpStart({q, r, wear})`.
- HUD: pit overlay text (`setPit({inLane, limiter, speeding, service: {left, total, penalty} | null, limitKmh})`:
  維修區限速 80、超速、換胎中 2.3 s ...), next-compound indicator through the telemetry graphic; hints updated for
  Q / E / T / M and the controller mapping; volume slider + mute in the menu; F1DB attribution next to OpenStreetMap.

### js/main.js + electron-main.js (v6 glue)

- Keys as listed above; pad through `F1.gamepad.mergeInput` (`boost`, `limiter` toggle, `pressed.compound`).
- Year / car: `F1.cars`; on change `car.setSpec`, `cockpit.setCar`, `F1.audio.setEngine`, racing line rebuilt with
  `F1.buildRaceLine(track, car.perf)`, profile sent; remote cars get livery and engine from `F1.cars.resolve(p.car, year)`.
- Audio: `init()` on the first key / click, `setActive(running)`, `update` every frame, beeps with the start lights,
  pit sounds.
- Battery full and a fresh set of tyres (medium by default, the chosen compound otherwise) on track load, at the start of
  qualifying and on the grid; `tyres.setWearRate(view.wear)` during a session, 1 otherwise.
- Pit: `pit.update` every step; the car is frozen during a service; 'serviceDone' -> `car.tyres.fit(next)`; remote and
  own cars in the lane are ghosts; toasts / `ui.setPit`.
- `F1.buildRaceLine(track, perf?)` (js/raceline.js) takes the car's perf (default `F1.CAR_PERF`).
- `electron-main.js`: autoplay policy `no-user-gesture-required`.
