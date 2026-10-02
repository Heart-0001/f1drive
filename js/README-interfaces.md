# F1Drive module interfaces

Plain classic scripts, no modules, no bundler. Everything hangs off `window.F1` (`window.F1 = window.F1 || {}`).
`THREE` is the global from `lib/three.min.js` (r149 UMD). Must work from `file://` and inside Electron.

The sections below are cumulative: v1 first, then what each version added (v2 .. v6, v6.1, v6.2, v7) and what review
round 3 (2026-10-02) changed. Where a later section changes an earlier rule, the earlier text says so. The CURRENT
script order is in the v7 section.

Script order in `index.html` (v1): `lib/three.min.js`, `tracks-data.js`, `js/track.js`, `js/car.js`, `js/cockpit.js`, `js/ui.js`, `js/main.js`.

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
Optional: `pitSide` (-1 = driver's right at the line, +1 = left: the real pit lane side where scenery-data.js has no pit
buildings or picks the wrong ones; Monaco, Silverstone) and `pitLimitKmh` (the current layout's pit lane speed limit
where below 80: Monaco, Sochi = 60). v6.2 adds `pitLimits`, `widthOverrides`, `bankMaxDeg`, `layout` (and documents
`bankOverrides`): see "v6.2 additions".

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
F1.buildScenery(track, trackData, sceneryData /* may be undefined */) -> { group, dispose(), stats, setStartLights(n, go) }
F1.createSky() -> THREE.Object3D   // sky dome / sun / distant horizon, added once to the scene by main.js
```
Nothing from scenery may stand inside the track corridor (within the walls of any part of the track).
`stats` = `{triangles, drawCalls, buildMs, phases, counts: {buildings, stands, dropped, fitted, trees, boards,
procBuildings, decks, decksSkipped}}`. `setStartLights(n, go)` (review r3): the start gantry's lamps follow the HUD's start
lights; main.js passes what it gives `ui.setLights` every frame (n = -1 or go = true: all dark; 1..5: that many columns lit
from the driver's left). The lamps are painted dark: in practice and after lights out the gantry is never lit.

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
In a room the host starts it; it also works alone (single player, local session, same rules). No AI cars in v5 (the
computer drivers came in v7: see "v7 additions"; with them, alone, the player starts from grid box 1 as in a room).

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
`js/boot.js`, `lib/three.min.js`, `tracks-data.js`, `js/seasons-data.js`, `js/cars.js`, `js/track.js`, `js/tyres.js`, `js/car.js`,
`js/cockpit.js`, `js/gamepad.js`, `js/audio.js`, `js/raceline.js`, `scenery-data.js`, `js/scenery.js`, `js/collide.js`,
`js/carmodel.js`, `js/laps.js`, `js/pit.js`, `net/session.js`, `js/net.js`, `js/gp.js`, `js/telemetry.js`, `js/ui.js`,
`js/main.js`. `index.html` has a Content-Security-Policy (no inline script, no inline handlers, no remote scripts):
`js/boot.js` holds what used to be the inline error / missing-script overlay. (v6.1, v6.2 and v7 add `js/hudmirrors.js`,
`js/track-names-zh.js`, `js/tunnels.js`, `js/ai.js`: the current order is in the v7 section.)

Golden rule for every module below: **the reference car on fresh medium tyres, with no boost, no limiter and no pit
stop, drives exactly as the v5 car did** (same accelerations, grip, braking, top speed). All existing tests, racing-line
checks and autopilots were tuned on it and must keep passing unchanged.

Controls (keyboard / controller) as of v6: W S A D or arrows / RT LT left stick; R / A or Y reset; L / X racing line;
Esc / Start menu; **Q / LB pit limiter (toggle)**; **E / RB or B battery (hold)**; **T / Back (View) next tyre compound**;
**M mute**; right stick look, RS click recentre. (v6.1 moved the controller functions onto A / B / X / Y and added V:
see "v6.1 additions".)

### CarSpec — what a car is (js/cars.js resolves it, js/car.js / audio / cockpit / HUD consume it)

```js
CarSpec = {
  id,                 // '<year>-<constructor>' e.g. '2004-ferrari', '<year>-standard'; /^[a-z0-9-]{1,40}$/
  year, team, teamZh, car, engine,     // display: 'Ferrari', '法拉利', 'F2004', 'Ferrari 3.0 V10'
  colour, colour2,                      // livery '#rrggbb'
  ratings: { topSpeed, accel, cornering, braking, ers },   // 0..100 inside its season, 50 = that season's standard car
                                        //   (50 + 50 * tanh(gain * x / 50): never pinned at 0 or 100)
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
  ers,                // null (no battery) | { store (J/kg), power (W/kg), harvest (W/kg), taperKmh? }
                      //   taperKmh: optional [from, to] km/h, the deploy power fades linearly to 0 between them
                      //   (2026 only: [290, 345], from FIA C5.2.8)
  cockpit             // style id: 'modern' (2010-2017, no halo) | 'halo' (2018-2021) | 'halo18' (2022 on: 18-inch wheels, wheel covers)
}
```
`F1.REF_SPEC` (defined by js/car.js) is the v5 car: its physics numbers are today's constants, 8 gears
(`gearKmh [60, 100, 140, 180, 220, 260, 300]`, `topKmh 345`), `rpmIdle 4000, rpmShift 11800, rpmMax 15000` (the V6 regulation limit),
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
                       ersHarvest, ersStore } /* multipliers on the era: 0.95..1.05; v6.1: ersPower / ersHarvest
                       0.75..1.15, ersStore 0.9..1.1 */, hasErs, ersNote, drivers, est, note }] }, ...]   // 2010..2026
F1.cars = {
  seasons,                       // [{year, label, engine, count}] ascending
  list(year) -> [CarSpec],       // that season's cars; first is '<year>-standard' (era car, every multiplier 1)
  get(id) -> CarSpec | null,
  resolve(id, year?) -> CarSpec, // never null: unknown id -> the same constructor in `year` if it raced then, else that
                                 //   year's standard car; no year -> DEFAULT_YEAR's standard car
  ersNote(id) -> string,         // (v6.1) one line about that car's battery for the car cards ('' none / unknown id)
  drivers(id) -> [{name, abbr, number}],   // (v7) its two real drivers (see "v7 additions"); [] for unknown ids
  DEFAULT_YEAR,                  // the newest season
  attribution                    // { f1db, f1dbShort, sources2026, disclaimer } strings for the menu
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
  car's, plus `gearFor(v)`, `rpmFor(v, gear?)`, `topSpeed`, `topSpeedBoost`, `ersDeploy(v)` = the W/kg the battery deploys at
  speed v, 0 without one); `F1.createCar(spec?)`, `car.setSpec(spec)`, `car.spec`,
  `car.perf`, `car.tyres` (the `F1.createTyres()` instance), `car.setBattery(v)`.
- `input` gains `boost` (bool, hold: deploy the battery) and `limiter` (bool: pit limiter engaged).
- `car.state` gains, refreshed every `update`: `throttle`, `brake` (0..1 pedals actually applied), `gear` (-1 reverse,
  0 neutral / standing, 1..n), `rpm`, `shiftT` (s since the last gear change), `battery` (0..1, 0 when the car has no
  ERS), `deploy`, `harvest` (0..1), `slip` (0..1 past the grip limit: tyre noise), `limiter` (bool), `inPit` (bool: in
  the pit lane between the entry and exit lines), `vib` (0..1 vibration from flat spots / punctures).
- Gear changes do not interrupt the drive (seamless-shift gearboxes throughout 2010..2026); `spec.shiftTime` only
  shapes the sound. `state.shiftT` restarts at 0 on every gear change, `state.shiftDir` is +1 (up) or -1 (down).
- ERS: only with `spec.ers`. Deploy while `input.boost`, throttle applied, battery > 0 and not braking: the engine's
  drive (traction cap included) is multiplied by `1 + ers.power / power`, up to what the tyres transmit (so below the
  traction cap's speed the battery deploys only part of its power: `state.deploy` < 1); `ers.taperKmh` fades the deploy
  power out linearly. Harvest under braking (proportional to pedal and speed, up to
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
  flat: [..],                   // flat-spot severity 0..1 (lock-ups / impacts): vibration, less braking grip
  temp: [..],                   // deg C; outside the working window the grip drops (overheating from sliding)
  dirt,                         // 0..1 after an excursion on the grass, cleans up in a few seconds on asphalt
  puncture,                     // -1 or the wheel index: from a worn-out tyre or a heavy impact; pit to fix
  grip: { lat, brake, traction },   // multipliers; exactly 1, 1, 1 for a new clean medium set in its window
  vib                           // 0..1
}
```
Medium = reference (multipliers exactly 1 when new); soft: a little more grip, wears 1.65 x as fast; hard: a little
less grip, wears 0.7 x as fast. Below 50 % wear the loss is under 1 % (existing short drive tests and autopilots are
not disturbed), about 4 % at 75 % (the cliff), then grip falls off towards 100 %.

**Stint lengths (2026-10-02, recalibrated to real F1).** At wear rate 1 the stints are the real ones; the Grand Prix
option x2..x5 divides them exactly by the rate (qualifying always runs at x1). The user's report "RB19 at Spa, x1, a
puncture halfway through lap 2, I hit nothing" was the old calibration (a medium set lasted 15 laps of 5 km, a soft
half that: a soft at Spa wore through and punctured after ~4 laps on the racing line, ~2.4 for a sliding keyboard
driver). Measured with the real cars driven on all 40 circuits until a tyre is worn through (`devtests/tyre-test`,
tables per circuit in its README; regression: `test/tyres.test.js` "the user's case"):

| wear x1, racing line at full pace (keyboard) | soft | medium | hard |
|---|---|---|---|
| 2023 Red Bull at Spa: laps to the cliff (75 %) — real Spa stints | 14.5 — 12..18 | 23.6 — 20..30 | 33 |
| 2023 Red Bull, 40 circuits: km to the cliff, mean (min..max) | 90 (70..118) | 147 (114..193) | 207 (160..272) |
| 2023 Red Bull, 40 circuits: km to 100 % | 116 | 189 | 266 |
| 2010 Red Bull / 2014 Mercedes / 2026 Mercedes: km to the cliff | 93 / 84 / 72 | 152 / 137 / 116 | 215 / 192 / 162 |

A human-like keyboard driver (late braking, kerbs, slides) wears a set ~10 % faster, the analog end-to-end autopilot
(~4 % off the pace) ~1.45 x slower; a computer driver alone lasts ~260 km on mediums (js/ai.js `WEAR_LAP0`). A tyre
punctures only when it is worn through (3..12 % of its life past 100 %) or from an impact (hit > 0.4, a real wall or car
contact): in 4320 driven stints (4 cars x 40 circuits x 3 drivers x S / M / H x wear 1 / 2 / 3) no puncture came
before 100 % except 11 from wall impacts, all past the cliff. Flat spots come from lock-ups (sliding with the brake on)
and impacts only, no longer from slides without the brakes.

### js/track.js additions — pit lane

Every track gets a pit lane next to the start / finish straight, on the side given by `trackData.pitSide`, else of the
real pit buildings where the scenery data has them (else the side with room). `track.pit` is `null` only if a track
really has no room.
```js
track.pit = {
  side,               // +1 on the +n side (driver's left), -1 on the other
  limitKmh,           // 80; trackData.pitLimitKmh where lower (60 at Monaco, Sochi); v6.2: the season's
                      //   (trackData.pitLimits: Zandvoort / Singapore 60 up to 2024) - limitFor / setYear below
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
    // 'enter' (crossed the entry line into the lane), 'exit', 'speeding' (first time over the limit in this visit, and
    // again the first time after its stop began), 'serviceStart', 'serviceDone', 'penaltyStart', 'penaltyDone' (a hold
    // at the exit line), 'serviceAbort' (the car left its box / hold before the end: main.js may ignore it)
pit.state = { inLane, speeding, inBox, service /* null | {total, left, penalty, work} (work 0: a hold at the exit line) */,
              stops, pending /* s of hold still to serve */, boxAhead, boxPassed, visit, flagged, served, slot, limitKmh }
```
- Stop in YOUR box (`track.pit.boxes[slot]`: within about 2.5 m along, 1.2 m across, roughly aligned, speed below
  0.5 m/s): the service starts and takes a random 2.0..4.5 s (the occasional slow stop). During the service the car is
  held (main.js freezes it as on the grid). At 'serviceDone' main.js fits the chosen compound and releases the car.
- Speeding in the lane (more than 3 km/h over `limitKmh` between the lines) adds a 5 s hold. It is served at that
  visit's stop when the stop comes after it, else (sped after the stop, or no stop) as a stop-go at the exit line:
  'penaltyStart', `state.service = {total, left, penalty, work: 0}` (main.js freezes the car as for a service, no tyres),
  'penaltyDone'. Speeding after the stop is a new offence. A pending hold only outlives a visit that reverses out over
  the entry line.
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
- HUD: pit overlay text (`setPit({inLane, limiter, speeding, service: {left, total, penalty} | null, limitKmh, boxAhead,
  slot, pending, served})`: 維修區限速 80、超速、換胎中 2.3 s、罰停中 ...; `pending` = s of hold still to serve, `served` =
  the visit has had its stop, so that hold waits for the exit line), next-compound indicator through the telemetry
  graphic; hints updated for Q / E / T / M and the controller mapping; volume slider + mute in the menu; F1DB attribution
  next to OpenStreetMap (the credits line opens 設定 → 資料來源與授權: every data source with its licence and address).
- `ui.setLoading(name | null, title?)`: the 載入賽道中… note while a track is built (main.js builds it after the next
  frame). v6.2: `name` is the English name, the note shows the card's Chinese one. v7 / review r3: `title` replaces the
  heading (`#loading-title`); main.js passes 電腦車手熟悉賽道中… while `F1.AI.warmUp` runs for bots made on a loaded track.
- `#hud.res-open` while the results overlay is open: in windows under 1260 px the overlay sits below the top row of boxes
  and the session box makes way for it.

### js/main.js + electron-main.js (v6 glue)

- Keys as listed above; pad through `F1.gamepad.mergeInput` (`boost`, `limiter` toggle, `pressed.compound`).
- Year / car: `F1.cars`; on change `car.setSpec`, `cockpit.setCar`, `F1.audio.setEngine`, racing line rebuilt with
  `F1.buildRaceLine(track, car.perf)`, profile sent; remote cars get livery and engine from `F1.cars.resolve(p.car, year)`.
- Audio: `init()` on the first key / click, `setActive(running)`, `update` every frame, beeps with the start lights,
  pit sounds.
- Battery full and a fresh set of tyres (medium by default, the chosen compound otherwise) on track load, at the start of
  qualifying and on the grid; `tyres.setWearRate(view.wear)` from the grid on (grid / race / results); 1 in qualifying
  and free practice (the 輪胎損耗 option is for the race only).
- Pit: `pit.update` every step; the car is frozen during a service and during a hold at the exit line (any
  `pit.state.service`); 'serviceDone' -> `car.tyres.fit(next)`; 'penaltyStart' / 'penaltyDone' -> toasts; remote and
  own cars in the lane are ghosts; toasts / `ui.setPit`. A Grand Prix that ends while the car is held in its box
  finishes the tyre change on the spot (a hold at the exit line is just dropped).
- R inside the pit lane (asphalt, tapers or a box) puts the car on the lane centre at the same place, stopped, facing
  along the lane; the limiter and the pit visit are kept (the lane and its speed limit still have to be driven). R is
  ignored while the car is held for a service or a hold.
- `F1.buildRaceLine(track, perf?)` (js/raceline.js) takes the car's perf (default `F1.CAR_PERF`).
- `electron-main.js`: autoplay policy `no-user-gesture-required`.

### v6 review additions (early review J0 and the final review, 2026-10-01; documented here in 2026-10-02)

- `car.bump(strength 0..1)`: a car-to-car impact; main.js calls it with the return value of `F1.resolveCarCollisions`
  (local contacts only, never for reported impacts); the next `update` feeds it to the tyres and to `state.hit` (`hit` =
  the strongest wall or car impact of the frame). `track.pit.paved(index, d)`: on the pit asphalt (car.js: not grass).
- `cockpit.setMirrors(on)` (live rear-view glass, default on; objects with `userData.mirror === false` stay out of it),
  `cockpit.info().mirrors`, `F1.COCKPIT_HALO` (the halo's centre line; js/carmodel.js draws the other cars' halo along
  it), `carModel.setHalo(on)` (main.js: `!spec || spec.cockpit !== 'modern'`).
- Rooms: an optional password: `F1.net.create(port, {password})`, `F1.net.join(address, {password})`; server errors
  `'password'`, `'wait'` (too many wrong ones from one address in a minute), `'idle'` (a player silent for 180 s). Lap
  reports carry `at` (`gl {k, sid, time, at?}`: the server's clock when the car crossed the line); new rejection reasons
  `'not-driven'` (the server did not see the car cover the lap) and `'no-data'` (too few car states during it).
- `spec.traction` also caps top speed (`sqrt((traction - 0.5) / dragK)`): 48 of the 197 cars are capped, by up to 6.3 km/h
  (2026-10-02 data); `perf.topSpeed` includes it and the seasons are calibrated with it (devtests/car-v6/traction-cap.js).

## v6.1 additions: HUD mirrors, the controller on A / B / X / Y, default season 2026, a battery per car

What the user asked (2026-10-01 ~11:30, translated): the game opens on 2026; every car its own battery data; the
controller functions on A B X Y; two small rear-view mirrors at the top left / top right of the screen, with a setting
and a key to hide them.

### Controls (current)

Keyboard: W S A D or arrows drive; R reset; L racing line; Esc menu; Q pit limiter (toggle); E battery (hold); T next tyre
compound; M mute; **V HUD mirrors (toggle)**; F11 full screen. Controller (`js/gamepad.js`, standard-mapping index in
brackets; the API is unchanged, only the indices moved):

| Button | Function | `F1.gamepad.state` |
| --- | --- | --- |
| A [0] or RB [5], held | battery deploy (E) | `boost` |
| B [1] or LB [4] | pit limiter toggle (Q) | `pressed.limiter` (main.js keeps the toggle) |
| X [2] | next tyre compound (T) | `pressed.compound` |
| Y [3] | reset to the track (R) | `pressed.reset` |
| View / Back [8] | racing line (L) | `pressed.line` |
| Menu / Start [9] | menu (Esc) | `pressed.menu` |
| RS click [11] | recentre the view | `pressed.recentre` |
| RT [7] / LT [6] / left stick / right stick / D-pad [12-15] | throttle / brake / steer / look / digital keys | as v5 |

Two buttons for one function (A / RB, B / LB) are OR-ed: the second going down while the first is held is not a new
press. Unmapped pads with 6+ axes (raw XInput order A0 B1 X2 Y3 LB4 RB5 Back6 Start7 Guide8 LS9 RS10) are mapped by name
the same way (Back 6 line, Start 7 menu, RS 10 recentre). The mirrors have no pad button. With a pad connected the
pit-lane prompts name B (請開啟限速器（B）, 按 B 關閉限速器).

### Default season

`js/main.js` `START_YEAR = 2026`: a fresh install (no stored 車輛 pick) drives `'2026-standard'`. The reference car
`F1.REF_SPEC` is `'2025-standard'` (the v5 car), now a pick in the 車輛 tab. Harnesses written for the reference car pick
it before the game boots with `devtests/ref-car.js`: `await require('../ref-car').seed(win[, {year, car}])` BEFORE
`win.loadFile(index.html)` writes the menu's stored choice (localStorage `'f1drive.car'`) through a blank page of the same
`file://` origin (`devtests/ref-car.html`). `gp-e2e/lib.js` `makeWin`, `v6-critic/lib.js` `w.open` and `v6-smoke` seed it
unless `opts.fresh` is set.

### js/hudmirrors.js — `F1.createHudMirrors` (after `js/cockpit.js` in the script order)

```js
var hm = F1.createHudMirrors(renderer, scene, {
  exclude: [cockpit.group],          // never drawn in the mirrors (our own car)
  elements: [frameLeft, frameRight]  // optional: each mirror fills the padding box of its element (CSS owns the layout);
                                     //   without them F1.hudMirrorsLayout(w, h) places them
  // optional too: hfov, yaw, pitch, rate, trees, msaa (as setOptions below)
});
hm.render(car.state, dt)   // = hm.update(pose, dt); hm.render(): every frame, right AFTER renderer.render(scene, camera)
hm.update(pose, dt)        // pose {x, y, z, heading, pitch, roll}; dt smooths the attitude
hm.setVisible(on) -> on, hm.visible   // hidden: no work at all, render targets released; also sets the frames' display
hm.setRects(fn | null)     // custom placement fn(cssW, cssH) -> [[x, y, w, h] left, [..] right]
hm.relayout(), hm.setExclude(list), hm.dispose()
hm.setOptions({hfov, yaw, pitch, rate: 1 | 2 | 'auto', trees, msaa})   // defaults 40 deg, 12, -1.5, 'auto', true, 4
hm.info() -> {visible, lost, rate, rateMode, passes, blits, ms, msMax, pixelRatio, rects, target, hfov, yaw, pitch, source}
F1.hudMirrorsLayout(w, h) -> [[x, y, w, h], [x, y, w, h]]   // the layout index.html's frames use (glass 176..400 px wide)
```
Each mirror is its own small render target drawn by a camera beside the driver's head looking back, copied into the canvas
flipped left-right. Left out of the pass: `exclude` and every scene child or grandchild with `userData.mirror === false`
(the cars' name tags; since v6.1 also the track's `pitCurtains` mesh, which main.js marks, so the light curtains just
driven through never fill the HUD or the cockpit glass mirrors). rate `'auto'`: both mirrors every frame, alternately
while they average over 1 ms of CPU.

- `index.html`: the frames `#hud-mirror-l` / `#hud-mirror-r` (`.hud-mirror`) are the first children of `#hud`; layout A
  from the `--mir-*` variables (`--mir-gw` = clamp(176px, 18.75vw, 400px)); `#hud.no-mirrors` hides them and puts every
  box back where it was without mirrors; `#hud.mirrors-na` (review r3 FLOW-4) hides the V hints (`.hk-mirrors`).
- `F1.ui`: `init({..., onMirrors(on)})` (the 設定 → 畫面 → 後照鏡 switch); `getMirrors()` -> bool (default true, stored in
  localStorage `'f1drive.hud'` as `{mirrors}`); `setMirrors({on?, available?})` shows and stores a change made elsewhere
  without calling `onMirrors`; `available: false` = the game cannot draw them: the switch says 無法顯示, the HUD is laid
  out without them, `#hud.mirrors-na`.
- `js/main.js`: creates them once with the cockpit (`exclude: [cockpit.group]`, the two frames); draws them after the main
  render (`renderMirrors`); a missing module, a throwing `createHudMirrors` or a throwing `render()` switches them off for
  the session (`hudMirrors = null`, `ui.setMirrors({available: false})`), never the game. V toggles them while driving
  (toast 後照鏡：開／關（V）; ignored while typing or in the menu); after a failure V says 後照鏡無法顯示（顯示卡不支援）
  (review r3 FLOW-4). `F1.game.hudMirrors` (null until the first track or after a failure), `F1.game.mirrors` (the setting).

### A battery per car (tools/ers-data.json -> tools/build-cars.mjs -> js/seasons-data.js -> js/cars.js)

- Every car of 2011..2026 has its own battery: `perf.ersPower` / `perf.ersHarvest` (0.75..1.15) and `perf.ersStore`
  (0.9..1.1) REPLACE the era's battery multipliers; every other multiplier stays 0.95..1.05.
- `hasErs: false` -> `CarSpec.ers === null`: all of 2010 and five cars that raced without KERS (2011 Lotus Racing, HRT,
  Virgin; 2012 HRT, Marussia); their `ratings.ers` is 0. The `'<year>-standard'` car always has the era's battery.
- `ersNote`: one line (Traditional Chinese) per car, read through `F1.cars.ersNote(id)` ('' for unknown / hostile ids;
  the CarSpec does not carry it). `est.ersPct`: the battery's share of `est.lapPct` (the lap with the battery deployed).
- Lap-time targets hold with the battery: `devtests/seasons-calib/ers-effect.mjs` drives each distinct battery of a season
  on the 40 circuits and `tools/build-cars.mjs` solves the chassis level so that profile delta + battery effect = target
  (a strong battery gets a weaker chassis). Re-run it after `calibrate.mjs` and whenever `tools/ers-data.json` changes.
- The car cards (`F1.ui.setCars`): a line 電池 + the note; a car without a battery gets a dashed 無 KERS chip where the
  電池 bar would be.

## v6.2 additions: steering law, road-shape cues, the 40-circuit data audit, bridges, tunnels, FOV, Chinese names

What the user asked (2026-10-01 ~14:30-17:30, translated): Monaco's hairpin cannot be taken even at 20 km/h; the banked
corners (Zandvoort, Madring) and Spa's climb are not felt; a Monaco tunnel; re-check the data of ALL circuits; the
controller's compound choice is not discoverable; Suzuka must be found by 鈴鹿 and by its country ('japan', 日本).

### js/car.js — the steering law (the one deliberate change to the golden rule) and the road-shape load

- `F1.CAR_PERF` / `F1.carPerf(spec)` gain `steerLockAt(v, bank, turnSign) -> rad` (the lock at the road wheels for
  `state.steer = +-1` at speed v m/s, on a road banked `bank` rad (left higher > 0), turning towards `turnSign` (+1
  left)), `steerLockMax` (0.40 rad = 23 deg: an 8.5 m radius on the 3.6 m wheelbase) and `steerLowGrip` (1.25). The law:
  the v5 lock `0.35 / (1 + (v/22)^2)`, never less than the lock that asks `steerLowGrip` x the mechanical grip, more on a
  real banked corner turned into (from 6 deg, in full from 9 deg), at most `steerLockMax`: full lock up to ~52 km/h,
  exactly the v5 law above ~85 km/h on flat roads. `js/raceline.js`, `tools/build-cars.mjs`, the calibration driver
  (`devtests/seasons-calib/driver.mjs`), `js/ai.js` and the sound's remote-car scrub use it. The golden-rule oracle
  `devtests/car-v6/car-v5.js` has the identical function (test/car.test.js: bit-identical).
- `js/raceline.js`: `cornerSpeed` limits by `perf.steerLockAt`; a path tighter than full lock targets the top of the
  full-lock range (~45..50 km/h: Monaco's hairpin ~49) instead of the 25 km/h floor.
- `car.state` gains `load` (g: the tyres' normal load in the last sub-step; 1 standing on the flat; + downforce, banking,
  dips) and `compress` (g: the road shape's share alone, load - 1 - downforce: > 0 in a banked corner or a dip, < 0 over
  a crest; Zandvoort T3 ~ +1.8, Eau Rouge ~ +1.6). Read-only cues: no effect on the path.
- Every `track.locate` of js/car.js passes the car's height (`state.y`; on `reset` the sample's), so at a grade-separated
  crossing (Suzuka) the car stays on the road it is on.

### tracks-data.js (tools/build-tracks.mjs) — new optional fields

```js
{ ...,
  bankOverrides: [{name, from, to, deg}],     // (since v6, J0) real banked / cambered corners: lap fractions of the
                                              //   input polyline; deg > 0 = inside of the corner lower; the full angle
                                              //   between from and to, eased over 35 m outside them, capped at 30 deg
  bankMaxDeg,                                 // cap of the curvature-derived banking (default 2.5; 1.5 on the 10 street
                                              //   circuits; it was 6 before v6.2)
  widthOverrides: [{name, from, to, halfW}],  // narrow stretches (Baku's castle: 3.8): the road's half width capped,
                                              //   eased back over 40 m; walls 1 m outside the road edge (eased over 50 m)
  pitLimits: [{from?, to?, kmh}],             // pit speed limit by season (years inclusive): Zandvoort and Singapore
                                              //   [{to: 2024, kmh: 60}]; otherwise pitLimitKmh, else 80
  layout                                      // a note when the built layout is not what the name suggests (Estoril:
}                                             //   'post-2000 layout ...'); the card's tooltip is its Chinese version
```
The data comes from the track audit (`docs/track-audit.md`, `tools/track-audit.json` `apply`): new elevation sources
(Wallonia lidar for Spa, IGN MDT05 for Barcelona / Madring, Emilia-Romagna DTM for Imola, Regione Toscana DSM for Mugello,
TINITALY + a 5 m dip for Monza, USGS for Miami, Copernicus GLO-30 for Interlagos / Sepang / Portimão), START_AT moved
(Silverstone, Hungaroring, Sepang, Shanghai), layout fixes (Albert Park, Estoril, Madring), Baku's width, measured cambers
and the season pit limits. `node tools/build-tracks.mjs --check` rebuilds in memory (dataset from the pinned commit,
heights from `tools/elevation-cache*.json`) and compares with tracks-data.js; `--out <file>` writes elsewhere. Review r3
moved Silverstone's points[0] to the Wing's START line (OSM node 13036050130, 151 m after the timing line: the 16 grid
boxes then lie on the straight) and scaled Baku's heights to the published 26.8 m range (x0.777).

### js/track.js additions

```js
F1.buildTrack(trackData, opts?)       // opts.year: the session's season (the pit limit and its painted signs)
track.locate(x, z, hintIndex, y?)     // y (optional): at a grade-separated crossing the road whose surface at (x, z) is
track.nearest(x, z, y?)               //   closest to y (the other road only where (x, z) is inside its corridor);
track.groundY(x, z, y?)               //   without y exactly as before
track.inCorridor(x, z, margin)        // true inside either level's corridor
track.terrainY(x, z)                  // the terrain height field alone (valid away from the corridor)
track.bridges = [{up, lo, separation, deckFrom, deckTo, deckLength, clearance, abutmentSegments, wingSegments}]
                                      // a crossing whose roads are >= 3 m apart in height (Suzuka: 6.2 m) is a bridge:
                                      //   up / lo = the sample of the upper / lower road at the crossing; deckFrom..deckTo
                                      //   = the upper-road samples the deck spans; clearance = deck underside above the
                                      //   lower road (~5.2 m). track.crossings is unchanged ([[1160, 2345]] at Suzuka).
track.pit.limitFor(year) -> km/h      // that season's limit, never above pit.layoutLimitKmh (what the lane allows)
track.pit.setYear(year) -> km/h       // makes it pit.limitKmh, sets pit.year, shows the matching painted signs
track.pit.layoutLimitKmh, track.pit.year   // year: the season limitKmh is for (null = the current layout's rule)
track.pit.paved(index, d) -> bool     // (since v6) on the pit asphalt (lane, boxes, tapers; never the road itself)
F1.pitLimitFor(trackData, year)       // the data's limit, before the lane geometry's cap
```
- The upper road of a bridge gets a 0.9 m deck slab, its walls as parapets, abutment walls behind the lower road's walls;
  through the deck range its verge stays at the deck's underside over the opening and ends on concrete wing walls
  (review r3 W5). Both roads keep their walls, kerbs and lines; the terrain stays under both.
- On tracks with `pitLimits` the 'paint' mesh has material groups `'paint'`, `'pitSign60'`, `'pitSign80'` (the inactive
  sign's material `visible = false`); the child mesh count is unchanged.
- A pit lane that is a little short retries shorter tapers (Silverstone's lane fits at 80 km/h).
- Glue (main.js): `F1.buildTrack(data, {year: activeYear()})`; `syncPitYear()` at the start of every `applyCar()` calls
  `track.pit.setYear(activeYear())` and `pit.reset()` when js/pit.js's bound limit differs (the bots' pits too, unless
  mid-visit). Review r3 FLOW-1: during a pit visit or service the whole change waits until the car has left the pit
  stretch (`pitRebind`): the limiter, the signs, the strip and js/pit.js keep the limit the visit began with. js/car.js
  reads `track.pit.limitKmh` every step; js/ai.js reads it live (review r3 AI-1).

### js/tunnels.js — covered stretches (after `js/scenery.js` in the script order)

```js
var tun = F1.buildTunnels(track, trackData, tunnelData?)  // default F1.TUNNEL_DATA[trackData.id]; none -> empty group
tun.group                       // THREE.Group (4 draw calls for the whole track)
tun.inTunnel(i) -> 0..1         // 0 outside, 1 deep inside, smooth over the first / last 30 m (sound)
tun.lightAt(i) -> 0..1          // daylight reaching sample i (0.3 deep inside, 0.5 beside openings to the sea)
tun.sceneLight(i, 'hemi' | 'sun')   // factor for the scene lights while the CAMERA is at sample i (eye adaptation)
tun.covered(i) -> bool          // between the portals of a covered stretch
tun.update(t, viewIndex, sceneScaled?)   // once per frame before rendering (allocation-free); viewIndex = the camera's
                                //   sample (null: outside every tunnel); sceneScaled default true
tun.tunnels                     // [{name, kind, from, to, length, sFrom, sTo, width, height, open: [{side, from, to}]}]
tun.stats, tun.dispose()
F1.tunnelImpulse(sampleRate, {width, height, rt60, seconds}) -> {sampleRate, left, right}   // reverb impulse response
F1.TUNNEL_DATA                  // copy of tools/tunnels.json "tracks" (devtests/tunnel-test/make-data.js --check)
```
Stretches: Monza (Sopraelevata underpass), Monaco (Portier; the 368 m tunnel under the Fairmont with the sea-side
colonnade), Madring (two tunnels under the motorway), Singapore (two Raffles Boulevard passages), Yas Marina (the W hotel
bridge). Glue (main.js): built after the scenery inside a try (decoration), disposed with the track (the lights go back to
daylight); `tunnelView(t)` before every render of the cockpit view (the frame and the still behind the menu): hemisphere
light = 0.85 x `sceneLight(i, 'hemi')`, sun = 0.9 x `sceneLight(i, 'sun')`, then `tunnels.update(t, i)`; every frame
`F1.audio.setTunnel(inTunnel(i), width, height)` of the stretch at i; at track load `F1.audio.setTunnel(0, w, h)` of the
longest stretch (review r3 PRES-2: the impulse response is made then, silently). `F1.game.tunnels`, `F1.game.lights`
(`{hemi, sun, hemi0, sun0}`). `js/scenery.js` builds no mapped deck within 12 m of a covered stretch or of the upper road
of `track.bridges`.

### js/audio.js — `F1.audio.setTunnel(k, width?, height?)`

k 0..1 = how deep the listener is in a tunnel (`tun.inTunnel(car.state.sampleIndex)`, 0 where there is none; or
`own.tunnel` handed to `update`). Inside: the whole mix through a convolution reverb of `F1.tunnelImpulse` at
`T.tunWet` (0.6) x k beside the dry mix, a mid band (+`T.tunMidDb` 3 dB x k around 450 Hz), the wind / road roar
+`T.tunRoarDb` (2 dB) x k, all ramped (`T.tunTau` 0.05 s); reverb and mid band disconnected 2 s after k fell to 0 (at k = 0
the sound is exactly the one without a tunnel). width / height (m, default 25 x 6.8) size the impulse response; a size
within `T.tunSizeTol` (15 %) of the width and `T.tunHeightTol` (1 m) of the height of the one already made reuses it
(review r3 PRES-2: Monaco's Portier 23.5 m and tunnel 25 m share one; making one costs 10-20 ms on the main thread);
`setTunnel(0, w, h)` makes it silently at the next `update()`; a throwing `F1.tunnelImpulse` is tried once per size.
Without js/tunnels.js: no reverb (the rest works). Debug: `F1.audio.debug.tunnel / reverb / reverbBuilds / tunnelWet /
tunnelMid`; the control vector gained `C_TUN = 17` (read `debug.ctl` by the paramTable names).

### js/cockpit.js — FOV setting and road-shape cues

- `cockpit.setFov(deg) -> deg in use`: the vertical FOV at a standstill, clamped to `F1.COCKPIT_FOV.min..max`; numeric
  strings are taken, anything else gives the default; applied at once. `F1.COCKPIT_FOV = {def: 60, min: 50, max: 75,
  widen: 12/70}`: the speed widening stays proportional (60 -> 70.3 deg at top speed; 70 -> 82 as v5).
- A framing lens shift (only `camera.projectionMatrix.elements[9]`, re-applied by `update` while the setting is not 70)
  keeps the wheel display where v5 drew it, above the telemetry graphic; an outside `camera.updateProjectionMatrix()`
  gives a plain centred projection until the next `update`.
- Head cues, `F1.COCKPIT_HEAD = {rollKeep 0.45, rollTau 0.25 s, pitchKeep 0.5, pitchTau 0.6 s, compressEye 0.012 m/g,
  compressNod 0.004 rad/g, compressMin -1, compressMax 2.5, compressTau 0.08 s}`: the head takes out 45 % of the car's
  roll (banking reads as the road and the cockpit tilting) and slowly 50 % of its pitch (a steady climb shows the road
  rising against the horizon); the eye sinks and nods under `state.compress` (else `state.seatG - 1`, the seat load
  WITHOUT downforce: never pass `state.load`). Both turn about the car's axes: `camera.rotation.y` stays exactly
  `PI + head yaw`. On a level road with no compression at `setFov(70)` the camera is v5's, bit for bit.
- `cockpit.info()` gains `fov: {setting, now, shift}` and `head: {roll, pitch, compress}`.
- Glue: `cockpit.setFov(ui.getFov())` when the cockpit is created and on `onFov` (guarded: the test stubs have none).

### Chinese names and the track search (js/track-names-zh.js, right after tracks-data.js)

```js
window.F1_TRACK_NAMES_ZH = { '<track id>': { name, short, location, aliases: [...], layout? }, ... }   // all 40 ids
```
`name` as Taiwanese F1 coverage writes it (鈴鹿賽道, 蒙札賽道, 銀石賽道 ...), `short` (鈴鹿), `location` ('日本 鈴鹿'),
`aliases` (search only: zh-tw Wikipedia forms, mainland / Hong Kong forms, ASCII spellings), `layout` (optional Chinese
tooltip, preferred over trackData.layout). Sources are in the file's header.
- Cards: the Chinese name, the English one under it (`.card-en`), the Chinese location; card i is still `F1_TRACKS[i]`
  (English order). The HUD timing box, the results subtitle and the loading note use the Chinese name.
- Search (`js/ui.js`): the English name, location and id; the Chinese name, short, location and aliases; the country in
  English with short forms and adjectives and in Chinese (`COUNTRY` / `EXTRA` tables in ui.js); 'F1 GP Grand Prix 大獎賽'
  in every key. Lower-cased; review r3 FLOW-3: NFKD folding (accents, full-width letters), Chinese and Latin runs split
  ('日本GP'), a trailing round suffix (分站 / 站 / 大獎賽 / 大奖赛 / 獎賽 / 奖赛 / 賽 / 赛) dropped from a Chinese term
  ('日本站', '日本大獎賽'); the various middle dots / dashes are one. Latin terms of 1..3 letters must start a word ('us'
  finds the 5 US circuits, not Austria). `F1.ui.searchTracks(list, query) -> [ids]`: the same search without the DOM.

### js/ui.js + index.html + js/telemetry.js (v6.2)

- `init({..., onFov(deg), onCompound(c)})`; `getFov()` -> the stored FOV (whole degrees, localStorage `'f1drive.fov'` =
  `{fov}`, stored only once the 設定 → 畫面 → 視野 slider moved; junk ignored, clamped 50..75), else `F1.COCKPIT_FOV.def`.
- `setCompound('S' | 'M' | 'H')`: the 大獎賽 tab's 起跑輪胎 row (下一組輪胎 during a session) shows main.js's next set; does
  not call `onCompound`. The next set is not stored (a new game starts on mediums); `onGpStart` stays `{q, r, wear}`.
- `setPit(p)`: `p.next` ('S' | 'M' | 'H') -> the line 下一組：中性胎（T / X 切換）(X / T first while a pad is connected).
- `F1.telemetry.draw(t)`: `t.nextKeys` (string, at most 12 characters, default 'T / X'), drawn under the 下一組 badge as
  '<keys> 切換'; main.js hands 'X / T' while a pad is connected.
- main.js: pit event 'enter' -> toast 按 X（鍵盤 T）選擇輪胎：軟 / 中 / 硬（下一組：…）(按 T（手把 X）… without a pad).

### scenery-data.js / tools/build-scenery.mjs / js/scenery.js (v6.2)

- A 'bridge' entry may carry `o` (OSM way id, debug), `c` (underside above the road, m, at least 6.5) and `t` (deck
  thickness, default 1.4); without them js/scenery.js builds what it built before. Decks thicker than 2.5 m (buildings
  spanning the road) get no parapet. A deck over the road stamps its footprint (no tree or object under it).
- The builder leaves out the lap's own deck over an underpass (the six phantom bridges of Spa, Zandvoort, Hockenheim x3,
  Nürburgring) and adds linear bridges / buildings spanning the lap (Montréal, Marina Bay, Silverstone's Wing footbridge,
  Las Vegas, Miami, Mexico, COTA ...). Options `--only <ids> --merge` (replace only those tracks), `--offline`, `--out`.
  Buildings named as pits count only within 450 m of the line (Silverstone's Wing is 'pit').

## v7 additions: computer drivers (offline and in rooms)

What the user asked (2026-10-01 ~16:35, translated): add computer players; in the room you choose how many and how strong.
(This overrides v5's "no AI cars".)

Current script order in `index.html`: `js/boot.js`, `lib/three.min.js`, `tracks-data.js`, `js/track-names-zh.js`,
`js/seasons-data.js`, `js/cars.js`, `js/track.js`, `js/tyres.js`, `js/car.js`, `js/cockpit.js`, `js/hudmirrors.js`,
`js/gamepad.js`, `js/audio.js`, `js/raceline.js`, `scenery-data.js`, `js/scenery.js`, `js/tunnels.js`, `js/collide.js`,
`js/carmodel.js`, `js/laps.js`, `js/pit.js`, `js/ai.js`, `net/session.js`, `js/net.js`, `js/gp.js`, `js/telemetry.js`,
`js/ui.js`, `js/main.js` (checked by devtests/ui-v6 and ui-gp). Node test suites: 12 (`test/ai.test.js` added).

### js/ai.js — `F1.createAIDriver` and `F1.AI` (pure logic: no DOM, no THREE, no timers, no Math.random; node: `module.exports = F1.AI`)

```js
var ai = F1.createAIDriver({ track, raceLine, car, skill, seed, id, slot, name, mistakeRate? })
//   track     F1.buildTrack(...); raceLine: any F1.buildRaceLine of this track (only its geometry is used; the AI caches
//             it per raceLine.points object: give every bot of a track the SAME line); car: the F1.createCar(spec) it
//             drives (car.perf / state / tyres read, never written); skill 0..1 or a level id / name; seed: every random
//             decision comes from it; id: its id in `others` (skipped there; any size); slot: its pit box
//             (track.pit.boxes[slot] = its room slot); mistakeRate (tests): the chance of a mistake per braking zone
ai.think(dt, others, ctx) -> input   // once per PHYSICS STEP (1/120 s), right before car.update(dt, input, track); the same
                                     //   object every call {up, down, left, right, throttle, brake, steerAxis, boost,
                                     //   limiter, reset}; reset true = please do its R (F1.AI.resetCar + lap.sync)
ai.onPit(event) -> compound | null   // every event of ITS js/pit.js update (also from the update made while held for the
                                     //   service: 'serviceDone' happens there) -> the compound to fit (car.tyres.fit)
ai.startCompound(raceLaps, wear) -> 'S' | 'M' | 'H'   // the set for the grid
ai.reset()                           // after EVERY placement (grid, qualifying start, a new track)
ai.setSkill(s), ai.setSlot(slot), ai.planStop(compound, park)   // a stop (or parking in the box) at the next chance
ai.pace                              // its profile's lap time (s): put it in its view (others[i].pace). Comparable between
                                     //   bots, NOT a lap-time prediction (it runs 9..15 % under their real laps)
ai.skill, ai.level, ai.id, ai.name, ai.slot, ai.seed, ai.plan
ai.state                             // live: mode ('race' | 'follow' | 'overtake' | 'defend' | 'yield' | 'pit' | 'parked' |
                                     //   'start' | 'grid' | 'reverse' | 'recover'), targetSpeed, cap, capBy, tgt, obs,
                                     //   offset, idx, plan, mistake, compound ...
ai.stats                             // mistakes, offs, wallHits, resets, reverses, stuck, passes, passTries, defends, yields,
                                     //   concedes, pitStops; ai.log: the last 24 rare events [t, what, sample]

F1.AI = {
  LEVELS,            // [{id: 'rookie', name: '新手', skill: 0, lapPct: 8}, {'amateur', '業餘', 0.35, 5}, {'pro', '職業', 0.7,
                     //   2.5}, {'legend', '傳奇', 1, 1}]: lapPct = median lap gap to the reference (the racing line's own
                     //   margins driven perfectly, battery included)
  skillOf(x) -> 0..1 (a number, a level id or name; anything else 'pro'), levelOf(s) -> the nearest LEVELS entry,
  PACE, paceOf(s), params(s, ref?), prepare(track, raceLine), profile(...), makeRandom(seed) -> () => [0, 1),
  createView(id) -> {id, x, z, heading, speed, sampleIndex, d, ghost, prog, pace, y}   // make EVERY view with this
  createContext() -> {phase, locked, lap, laps, done, prog, pit, wear}                // one per bot
  updateView(view, state, track)       // fill a view from a car state; locates it (with its y at a bridge) when the
                                       //   state has no sampleIndex (remote cars; the hint is kept in the view)
  placeOnGrid(car, track, slot) -> sample index   // main.js's placeOnGrid: nose at the box's front bar
  resetCar(car, track, idx?, others?, selfId?) -> sample index   // main.js's R; with others (a bot's R): moved up to
                                       //   ~80 m on to the first spot with no solid car within 7 m and no car standing
                                       //   in the 30 m ahead (a car on the other level of a bridge does not count)
  createContacts() -> resolveAll(entries, dt, onContact?)   // car against car among locally simulated cars; entries
                                       //   [{state, car?, solid}], car.bump on hits, onContact(i, j, dv, hit) per impact;
                                       //   -> the strongest hit; allocation-free; needs F1.resolveCarCollisions and its
                                       //   own properties (.overlap: a wrapper must copy them)
  warmUp(track, raceLine, opts?) -> {steps, calls, pitStops, resets, passTries, offs, yields, mistakes} | null
                                       // optional, at track load: six cars through a scripted session (~29 000 think()
                                       //   calls, 0.1..0.5 s once per track; later calls return {steps: 0, calls: 0})
                                       //   so V8 optimises the drivers' code before the race (first race ~24 MB of
                                       //   garbage instead of ~160 MB); changes no real driver's driving. opts: spec, force
  lineup(opts) -> [{name, car, skill, seed, abbr}]   // the field; see below
  shortName(name) -> <= 16 characters, INVENTED (fallback names),
  startCompound(laps, wear, trackLength) -> 'S' | 'M' | 'H', CAR_LEN, CAR_WID, SEP, createAIDriver
}
```
- Views: `x, z, heading, speed` (signed), `sampleIndex, d` as `car.state` has them, `y` (height, NaN unknown), `ghost`
  (not solid for anybody: Grand Prix ghost rules, the pit asphalt, a car held in its box), `prog` (race distance in laps,
  `lap.progress(idx)`: blue flags; NaN outside the race and results, review r3 AI-4), `pace` (`ai.pace` of a bot, NaN for a
  human). Fill every field in place and add none: one object shape keeps think() optimised and allocation-free.
- Context: `phase` (gp.phase), `locked` (the grid before lights out: think() returns a pad at rest, and seeing it arms the
  start reaction), `lap` / `laps` (timed laps done / the phase's Q or R; 0 = open-ended), `done` (a boolean), `prog` (a
  number, NaN unknown), `pit` (its js/pit.js state), `wear` (the wear multiplier).
- Levels (median over the circuits, `devtests/ai-test/calibrate.js`): +8 / +5 / +2.5 / +1 % against the reference;
  `PACE = [[0, 0.841], [0.35, 0.89], [0.7, 0.942], [1, 0.977]]` (2026-10-01, kept after review r3's track data: within the
  solver's step). Re-solve after ANY change to js/car.js physics, js/raceline.js or the track data and paste the table.
- Behaviour the player sees: every car on the path gives a speed cap (also a stopped one hidden behind another); a car
  known to be slower (its pace) is pressed on the straights (radius > 80 m at both; 0.3 of the time gap, its normal
  braking not anticipated; not while a stop is planned) and attacked on the side with room; a car alongside always gets
  room; mild defence; a slower bot under sustained pressure from a quicker car (within 0.5 s, let go beyond 1 s) gives it
  room on a straight after a while (rookies ~2 s, legends never: the stand-in for the slipstream js/car.js lacks); a
  human of unknown pace counts only after closing by more than 1.5 m/s while the bot is flat out (review r3 AI-5); blue
  flags (a car a lap up): the side chosen once, the edge held. A car standing > 1.5 s or coming the wrong way: a yellow flag
  (single file, no racing past, no defending), driven round (the wrong-way car beside where it will be when they meet,
  review r3 AI-6); blocked across a narrow street: R after 8 s, put down past the obstacle. Through a corner tighter than
  full lock (Monaco's hairpin, ~45 km/h) nobody attacks or defends and the queue keeps 5 m more gap. Pit stops: a stint
  optimiser once a lap (the softest compound that lasts; stints to 88 %, in before 93 %; punctures at once), the lane at
  `track.pit.limitKmh` read live (review r3 AI-1), its own box. What a bot remembers of another car is keyed by its full
  id (review r3 AI-2: a room's ids grow past 63). Every `track.locate` passes the car's height (Suzuka's bridge).
- Cost: think() ~2 us per call, ~0 allocation once optimised (< 2 B per call in test/ai.test.js); 15 bots in the game
  ~ +0.6 ms of main thread per frame; Monaco loads in ~850 ms with bots (warm-up) instead of ~330.

### The field: `F1.AI.lineup` and `F1.cars.drivers`

```js
F1.AI.lineup({ cars: F1.cars.list(year), taken: [car ids the humans drive], count, skill: 0..1 | level | 'mixed', seed,
               drivers: F1.cars.drivers, names: [names already used] }) -> [{name, car, skill, seed, abbr}]
F1.cars.drivers(carId) -> [{name, abbr, number}, {name, abbr, number}]
```
- `lineup`: every team fields two seats; a human takes seat 0 of his team (his teammate still races); one seat of every
  team before the second seats; standard cars never used; at most 15; names <= 16 characters (`shortName`), unique
  (`INVENTED` where there is no data); skill = the level +-0.04 ('mixed': a random level per seat). Each seat's level, jitter
  and seed come from (seed, car, seat): a human taking another seat leaves every other driver as he was.
- `F1.cars.drivers(id)`: the car's two real drivers of that season from F1DB (`js/seasons-data.js` `cars[].drivers`, built
  by `tools/build-cars.mjs`), the one with the most starts in that car first; `name` in F1DB's Latin spelling with accents
  (up to 19 characters: use `F1.AI.shortName` for the rooms' 16), `abbr` three capitals, `number` 0..99 (null if unknown).
  The standard car's two are invented (Alex Rowan #90, Sam Ellery #91). A new array of new objects every call; [] for an
  unknown / hostile id (Map lookups only). Not part of the CarSpec.

### net/session.js, js/gp.js — bots are players of the session

- `session.addPlayer(id, name, now, {bot: true, owner})` adds a bot (anything else a human); `session.isBot(id)`; snapshot
  rows of bots carry `bot: true`. Bots are classified exactly like humans.
- `F1.gp` (offline: ids 2..16, room slots 1..15; the player is id 1, slot 0):
  - `setBots(list | n, level) -> bool`: free practice only; `list = [{name, car, colour, skill}]`, entry i = bot i
    (cleaned: name <= 16, 'AI n' by default); offline applied at once (at most 15), online forwarded to `net.setBots`.
  - `bots()` -> a fresh copy `[{id, name, colour, car, skill, slot, bi}]` (online: `net.bots`).
  - `botLap(id, time) -> ''` when accepted (offline) / sent (online), else 'not-ours' | 'not-racing' | 'done' |
    'no-session' | 'not-sent' | a session reason (offline also fired as 'botLapRejected').
  - `botProgress(id, v)` every frame (online it rides with the bot's next state).
  - `entry(id, out?) -> {id, bot, taking, lap, lapTotal, done, fin, dnf, gridSlot, locked}` for any car (fills `out`: no
    allocation per step); `solid(a, b)`: the session's rule for any two cars (always in free practice, never in
    qualifying or on the grid before the lights, else both classified and in the session; the pit lane is main.js's).
  - events `'bots'(list)`, `'botsGo'` (once per session at lights out when any of our bots takes part: arm their lap
    counters), `'botLapRejected'(id, why)`.
  - `view()` rows gain `bot`, `skill` (0..1 | null), `car`; `view().bots = {count, skill: level, max (16 - humans; 15
    offline), canEdit (offline or host, free practice only)}`. The offline race republishes live standings every 500 ms
    of game clock when they changed (as a room does).

### Wire format (protocol stays 1; additive: an older client sees bots as ordinary players)

The HOST's game simulates its bots; the server knows them as players his connection owns (ids from the players' counter,
room slots from the same pool, humans + bots <= 16) and treats what he sends for them exactly like a player's own
(validation, proof-of-driving, impact checks, rate limits).
- client -> server: `bots {n, skill?, list?: [{name?, car?, colour?, skill?}]}` (host, free practice only; n clamped to
  the free seats; bots 0..n-1 that exist keep id and slot; skill = the room level 'rookie' | 'amateur' | 'pro' | 'legend' |
  'mixed', default 'pro'); `bs {k, c, b: [[id, x, y, z, heading, pitch, roll, speed, steer, g?], ...]}` (his bots' states,
  at most 16 rows, the first per bot; js/net.js splits frames over 1900 bytes); `gl {..., id}`, `lap {..., id}`,
  `hit {..., from: botId}` (a lap / lap times / an impact of one of HIS bots; any other id is dropped silently).
- server -> client: roster rows of bots `{id, name, colour, car, slot, last, best, bot: true, skill, owner, bi}` (human rows
  unchanged); `welcome` and every `players` carry `bots: {n, skill}`; snap rows and session rows as a player's (session
  rows `bot: true`); `glno {why, id}` to the owner; `hit {from, i, bot: botId}` to the owner when a guest hit his bot,
  `hit {from: botId, i}` to a player a bot hit. No `gone` message for a bot (the roster carries the change).
- Server rules: a connection's message budget grows by `BOT_RATE` (4) per second and its burst by 8 per bot it owns; a
  human joining a full room in free practice takes the newest bot's seat (during a session: 'full'); hits among one
  owner's own cars are never relayed. When the owner leaves, his bots leave too, each as a player leaving: out of
  qualifying / the grid, DNF in the race, a row kept in final results; the others' session goes on (review r3 MP-2; a
  dedicated server's next host can end it; before: the race closed for everybody). `srv.info()` gains `bots: {n, skill}`.

### js/net.js additions

- `setBots(list | n, skill) -> bool` (host, free practice); `sendBotStates([{id, state, g?}], force?)` every frame (it
  sends at most every 45 ms, only OUR bots; while the loop stands still keepalive repeats the last rows parked);
  `setBotProgress(id, v | null)`; `sendGpLap(sid, time, at, botId?)`, `sendLap(last, best, botId?)`,
  `sendHit(toId, ix, iz, fromBotId?)` (one report per bot per 40 ms; never against our own cars) -> bool.
- `net.bots` (OUR bots in list order: `[{id, name, colour, car, slot, skill, bi, last, best}]`), `net.botSettings` (`{n,
  skill}`); `net.roster` rows gain `bot, skill, owner, mine`; `net.players` rows gain `bot, skill, owner` (OUR bots are not
  in `net.players`: they are local cars). Events `'bots'(net.bots)` (also [] when we leave), `'botHit'(botId, fromId,
  [ix, iz])`, `'botLapRejected'(botId, why)`.
- Review r3 MP-1: a `snap` row whose id is not a number or not one of our own remotes is dropped (a hostile server's
  `"__proto__"` row can no longer reach `Object.prototype`).

### js/ui.js + index.html + js/carmodel.js (v7)

- 大獎賽 tab: 電腦車手 (無 / 1..max) and 強度 (新手 / 業餘 / 職業 / 傳奇 / 混合) rows; `init({..., onBots({count, skill})})`;
  `getBots()` -> `{count 0..15, skill}` (localStorage `'f1drive.bots'`, default `{0, 'pro'}`); read-only for a room's guests
  (電腦車手由房主設定。) and during a session (賽事進行中不能更改電腦車手。). DOM: `#gp-bots-box`, `#gp-bots` (select),
  `#gp-skill` (buttons `data-s`), `#gp-bots-note`, `#gp-bots-list`; classes `.gp-bot`, `.car-drv`, `.gp-ai`.
- `setGp(v)`: `v.bots = {count, skill, max, canEdit, available}` (available false hides the rows), `v.botList = [{name,
  colour, colour2, team, skill}]` (the field, listed in free practice), `rows[i].bot / skill` -> an AI tag (tooltip
  電腦車手（level）) in the standings, the HUD session box and the results; room roster rows with `bot` get the tag and the
  title 玩家（n 人 + 電腦 m，k / 16）.
- `setCars(v)`: optional `v.drivers = {carId: [{name, bot, self}]}` -> the card line 車手 … (only while there are bots).
- `updateHUD(h)`: `h.others[i].ring` (optional) rings a minimap dot (a bot's second livery colour).
- `carModel.setName(name, badge?)`: badge (e.g. 'AI') drawn as a light pill before the name.

### js/main.js (v7 glue)

- The setting -> `F1.AI.lineup({cars: F1.cars.list(activeYear), taken: the humans' cars (ours alone; in a room every
  non-bot roster row's car resolved to the room year), count: min(count, 15 alone / 16 - humans), skill, seed: the year,
  drivers: F1.cars.drivers, names: the humans' names})` -> `gp.setBots(list, level)`: alone, or as the host in free
  practice, only when the field changed; re-sent once on every return to free practice.
- `gp.on('bots')` -> each bot: `F1.createCar(spec, {random})`, `F1.createPit`, `F1.createLapCounter`,
  `F1.createAIDriver({track, raceLine: botLine, car, skill, seed, id, slot, name})`, a `F1.createCarModel` with its
  livery, halo (not before 2018) and the AI badge; updated in place on a car / skill / name / slot change. `botLine` is the
  track's first racing line (kept when ours is rebuilt for another car). `F1.AI.warmUp(track, botLine)` runs with the track
  build when there are bots, or behind the loading note (`ui.setLoading(name, '電腦車手熟悉賽道中…')`) for bots made on a
  loaded track (review r3 PKG-2).
- Placement: alone with bots we start in grid box 1 (also qualifying), bots in boxes slot + 1 (2..16); the grid: the box of
  each one's qualifying place with `ai.startCompound(r, wear)`; back to free practice: their boxes again (ours stays). A
  box with a car on it is skipped (`F1.AI.resetCar` moves the bot on).
- Every physics step, right after our `car.update` (also while our car is held in its box): `stepBots` = the views
  (ours first) and contexts (from `gp.entry`), `think` for each, then locked -> stand; in service -> held, its pit
  updated, its lap clock running; `input.reset` -> `F1.AI.resetCar(car, track, idx, views, id)` + `lap.sync`; else
  `car.update`. Contacts: `F1.AI.createContacts()` over [our car, bots] (solid = `gp.solid(id, id)`, not on the pit
  asphalt, not in service, not locked); the host also resolves each bot against the remote solid cars and reports those
  hits. Then each bot's pit (events -> `ai.onPit`) and lap counter (2 -> `gp.botLap(id, lap.last)`). On the frozen grid
  `botsHeld` lets them think once per frame. 'botsGo' -> `lap.arm(idx)`, `lap.time = gp.sinceGo` (online minus the frame's
  delay), as ours.
- Per frame: their models (ghost rules as for remote cars), the minimap (dots in livery colours, ringed), the sound list;
  the host publishes (`net.sendBotStates`, `net.sendLap(last, best, id)` on change, bot hits). Guests see bots as remote
  cars with the AI badge (`net.players[i].bot`); 'botHit' applies the impulse to the bot's car with the same "already
  applied" bookkeeping as our own hits.
- Review r3: impact reports go out one per reporting car per `HIT_SEND_MS` (50 ms) tick, the longest owed first, kept for
  `HIT_MEMORY_MS` (400 ms) (MP-3: a second one in the same tick used to be lost); a rejected bot lap -> toast
  電腦車手 <name> 的一圈沒有被採計… at most once per 8 s (MP-6); bot roster rows are not announced as players joining /
  leaving: a guest gets one count toast 房間的電腦車手：N 位 / 無 when their number changes (FLOW-2).
- `F1.game` gains `bots` (`{id, name, spec, car, ai, pit, lap, model, ctx, ...}`), `botCfg`, `botViews` (the views think()
  sees, ours first; empty without bots) and `botCost(reset) -> {frames, mean, max}` (main-thread ms per frame on the bots).
- Known limits: while the host has the menu open his bots stand still for everybody (keepalive parks them); bot ownership
  is not transferred on host migration; js/car.js has no slipstream, so passing between cars 1..2 % apart stays rarer than
  in real racing.

## Review round 3 (2026-10-02): what changed in the contract

Findings by area (30 confirmed of 39; the rest refuted by a second agent). The ones that touch an interface are folded into
the sections above; this list says where:
- AI-1 live pit limit, AI-2 full-id memories, AI-3 pressing / passing, AI-4 `view.prog` NaN outside the race, AI-5 concede
  only to a human seen to be quicker, AI-6 wrong-way swerve: js/ai.js (v7 section).
- FLOW-1 season change during a pit visit waits (`syncPitYear` / `pitRebind`), FLOW-2 bot count toast, FLOW-3 search
  forms (`ui.searchTracks`), FLOW-4 V after a mirror failure (`#hud.mirrors-na`).
- MP-1 snap row ids (js/net.js), MP-2 the bots' owner leaving no longer ends the session (net/server.js), MP-3 deferred hit
  reports, MP-6 bot lap rejection toast.
- PRES-1 gantry lamps (`scenery.setStartLights`), PRES-2 tunnel impulse response reuse / priming (`audio.setTunnel`).
- PKG-2 the warm-up behind the loading note (`ui.setLoading(name, title)`), PKG-3 the credits' links open in the user's
  browser in the exe (`electron-main.js`: https links to github.com, creativecommons.org and www.openstreetmap.org only;
  every other navigation / window is still denied), PKG-5 exe-smoke cleanup.
- W1 Silverstone's line at the Wing's start line, W2 the six new elevation sources credited in 設定 → 資料來源與授權, W4
  Baku's range 26.8 m, W5 Suzuka's bridge verge, W6 Toscana labelled a photogrammetric DSM, W7 test/track.test.js.
- DRV-1 / W3 / MP-5 / AI-9: this document (v6.1 / v6.2 / v7 sections). DRV-2 (the calibration driver under-drives 2026 in
  slow corners by ~0.47 %) is documented in docs/seasons-data.md, not changed.

## v7.2 room lobby: the room lobby (房間大廳) and the single-player start panel (出發面板)

What the user asked (2026-10-02 ~23:20 / ~23:35, translated):
- In a room the game asks for a track and then drops everybody straight onto it. Everybody should gather first, and the
  game should start only when everybody is there.
- Single player too: a click on a track card must not start driving. Choose first, then start.

Flows, layouts, texts, edge cases, the reproduction of the v7.1 behaviour and the list of harnesses to update are in
`docs/lobby-design.md`. This section is the binding contract. Owners:
- **net owner**: `net/*`, `js/net.js`, `js/gp.js` and their tests.
- **menu owner**: `js/main.js`, `js/ui.js`, `index.html`, `test/main.test.js`.

The script order is unchanged.

### Summary of the rules

- **Single player**: a card click opens the start panel for that track (nothing loads). **開始** (or Enter: it has focus;
  or pad A) starts the chosen mode on that track. Esc / pad B go back to the cards.
- **Room**: after create / join everybody is in the lobby, with no track running.
  - The host sets the room's track (from the cards), season, mode, Q / R / tyre wear and the computer drivers. Guests see
    them read-only.
  - Everybody picks his own car and starting tyres. Guests press **準備**.
  - The host's **開始** needs every guest ready, or his confirmation; the guests who are not ready load too.
  - Everybody then loads at once. The session begins when all have loaded, after `LOAD_TIMEOUT_MS` (20 s), or when the
    host presses 「不等了，開始」.
  - After the results the host chooses 再來一場 or 回到大廳.
- **Protocol 2** (incompatible with 1): a server refuses `hello.v !== 2` with `error {code: 'version', need: 2}`.

### Wire format, protocol 2 (everything not listed is as in v4..v7)

Room state on the server: `st` = `'lobby'` (nobody on a track, no session) -> `'loading'` (the settings frozen, every
client building the track) -> `'session'` (free practice, or a Grand Prix through `net/session.js`) -> `'lobby'`.
`rs` = the load cycle: 0 until the first start, +1 at every `start`. It replaces v1's track seq: the `k` of `s`, `bs`,
`gl` and `hit` must equal `rs`.

Client -> server (the room state(s) in which each is accepted; anything else is dropped silently, except `start`):

| Message | Who, when | Cleaning / effect |
| --- | --- | --- |
| `hello {v: 2, ...}` | anybody | `v !== 2` -> `error {code: 'version', need: 2}` |
| `set {track?, year?, mode?, q?, r?, wear?}` | host, lobby | `track` `/^[A-Za-z0-9_.\-]{1,64}$/`; `year` `cleanYear`; `mode` `'free'` \| `'gp'`; `q` 1..20, `r` 1..99, `wear` 1..5 after `Math.round`. An invalid field is ignored (never clamped) and the others apply. A changed `track`, `year` or `mode` clears every guest's ready flag (`rr` + 1). At most `SET_PER_S` (10) per second per connection. |
| `bots {n, skill?, list?}` | host, **lobby only** | as v7; also `set.bots = clamp(floor(n), 0, 15)`, `set.skill = level` (the room's wish; the roster has the real field) |
| `ready {on}` | guest (the host is ignored), lobby | `on` must be a boolean; at most `READY_PER_S` (5) per second per player |
| `start {len, force?}` | host, lobby | `len` 200..100000 (the host sends `round(trackData.lengthKm * 1000)`). Refused with `nostart {why}`: `'state'`, `'track'` (`set.track` null), `'len'`, `'busy'` (within `START_MIN_MS` = 1000 of the host's last start / back / go), `'not-ready'` (a guest not ready and `force !== true`; `wait` = their ids). Accepted: `st = 'loading'`, `rs + 1`, every car's state / trail / last / best cleared (as v1's `setTrack`), `load = {at: now, until: now + LOAD_TIMEOUT_MS, wait: [every human id], done: [], fail: []}`. |
| `loaded {rs, ok, why?, len?}` | anybody, loading / session | ignored unless `rs === room.rs`; first per player per rs only. `ok === true` -> `done`, else `fail`. `why` `/^[a-z-]{1,16}$/` (log only). `len` 200..100000 is used only from the host (and only with `ok`). A newcomer in session is recorded the same way; no barrier then: his `ok: false` takes him out of the session for this cycle (`session.removePlayer`; back in when the room returns to the lobby). |
| `go {}` | host, loading, after his own `loaded {ok: true}` | ends the barrier now (`START_MIN_MS` applies) |
| `back {}` | host, loading / session | -> lobby (below) (`START_MIN_MS` applies) |
| `gp {a}` | host, session | `'skip'`, `'again'` as v5; `'end'`: race -> results, quali / grid / results / a free-practice session -> same as `back` (`START_MIN_MS` applies to that one); `'start'` ignored |
| `s`, `bs`, `gl`, `hit`, `lap` | session only, `k === rs` | as v5..v7; `lap` carries `k` too in protocol 2 |
| `profile {name, colour, car}` | anybody | `car` applied only in the lobby and in a free-practice session (parc fermé while loading and in a Grand Prix) |
| `track`, `year` (protocol 1) | - | ignored |

The barrier (server tick and every `loaded` / leave):
1. When `load.wait` is empty, or `clock() >= load.until`, or on the host's `go`:
   - if `load.done` is empty: back to the lobby, and `nostart {why: 'load'}` to the host;
   - else every id in `load.fail` is taken out of the session (`session.removePlayer`), `st = 'session'`, `load = null`,
     `room.len` = the host's `loaded.len` if it is within ±15 % of `start.len`, else `start.len`;
   - mode `'gp'`: `session.start({q, r, len, year, wear} = room.set + len, now)`.
2. Players still loading stay in the session and join it when their track is built.

`back`, `gp end` outside the race, the room becoming empty, or a Grand Prix session that went back to `'free'` by itself
(every classified car left it; only spectators remain):
- the session `end()` until `'free'`; every car's state / trail / last / best cleared;
- `ready` cleared (`rr` unchanged: not a settings change); `load = null`; the failed loaders added back
  (`session.addPlayer`); `st = 'lobby'`; `len = 0`;
- `room.set` and `rs` kept.

`START_MIN_MS` is real time between two of the host's accepted start / back / go (and `gp end` acting as back); a refused
start does not count. It is `createServer` opt `startMinMs` (tests make it 0). A start inside it is answered
`nostart busy`; a go / back / gp end inside it is dropped without an answer, so js/main.js holds those until
`START_MIN_MS` after it saw the room's `st` change (lobby review LOBBY-1, below).

Joining:
- lobby / free-practice session: a full room makes room by removing the newest bot (as v7);
- loading: the newcomer is appended to `load.wait` (the deadline does not move); a full room -> `error full`;
- Grand Prix session: the v5 rules (qualifying: a participant; grid / race / results: a spectator); a full room ->
  `error full`.

Leaving while loading removes the player from `load.wait`, `load.done` and `load.fail` (every list holds players present
only); when `wait` is then empty the barrier ends (with `done` empty: the lobby and `nostart load`). A dedicated server's
new host is taken out of `ready` (the host is never listed).

Host:
- in-game server (host token): the creator, never migrates; the room closes with him. His leaving runs no transition
  (no barrier end, no return to the lobby): net/host.js is stopping the server, and the guests go back to single player
  instead of being put into a session a moment before they are disconnected. Should the server stay up, a later
  `loaded` or the timeout still ends the barrier.
- dedicated server (`ded`): the first player; on leaving, the longest-connected player; `room.set` survives both.

Server -> client:

| Message | Fields |
| --- | --- |
| `welcome` | `{v: 2, id, host, ded, now, room, bots, players}`; `ded` = dedicated server (no host token). No `track` / `seq` / `year`. |
| `room` | `{st, rs, set: {track, year, mode, q, r, wear, bots, skill}, ready: [guest ids], rr, load: null \| {at, until, wait: [ids], done: [ids], fail: [ids]}, len}`. Defaults: `mode 'free'`, `q 3`, `r 5`, `wear 1`, `bots 0`, `skill 'pro'`. The host is never in `ready` (he counts as ready); bots count as ready. `len` is 0 in the lobby. |
| `players` | as v7 without `year` (the year is `room.set.year`) |
| `nostart` | `{why, wait?}` to the host only (whys above) |
| `error` | `version` carries `need: 2` |

Ordering:
- A state transition sends its `room` message at once, and before the `gp` message the same transition causes:
  - start -> loading;
  - the barrier -> session (then `gp` with the qualifying snapshot);
  - back / end -> lobby (then `gp` free).
- Other room changes (settings, ready, loaded, join / leave) are coalesced like the roster: one at once, then at most one
  per `COALESCE_MS` tick, carrying the state as it is then.
- `welcome` (with `room`) comes first, then the current `gp`, as in v5.

`createServer(opts)` gains `loadTimeoutMs` (default `LOAD_TIMEOUT_MS` = 20000, on the session clock `now`; tests make it
short or step a manual clock past `load.until`) and `startMinMs` (default `START_MIN_MS` = 1000, real time). `srv.info()`
gains `room` (the `room` message's fields) and `ded`; its `track` / `year` stay, as `room.set.track` / `room.set.year`
(`seq` is gone). The module exports `LOAD_TIMEOUT_MS`, `START_MIN_MS`, `SET_PER_S`, `READY_PER_S` too.
`net/session.js` is unchanged.

### js/net.js additions (protocol 2)

```js
F1.net.room       // null outside a room; else a sanitised copy of the last `room` message: every field present and of
                  //   its type (st one of the three, rs >= 0 integer, set.* cleaned as the server cleans them, id lists
                  //   numbers only, at most 64 each, load null or {at, until, wait, done, fail}). A setting that is not
                  //   valid gets its default; load is null outside 'loading'; a `room` message whose st is not one of
                  //   the three is not a room (ignored); a welcome without a usable room gives the default lobby.
F1.net.loadedRs   // the rs of our last sendLoaded(rs, true); -1 none (reset on connect / disconnect)
F1.net.ded        // the room is a dedicated server's (welcome.ded)
F1.net.address    // the address we joined ('203.0.113.5:24500'); null for the host (net.hostInfo has his)
F1.net.trackId    // = room.set.track (the room's chosen track: in the lobby it is NOT loaded yet)
F1.net.year       // = room.set.year ('year' still fires when it changes)
F1.net.roster[i]  // gains ready (bool: guests from room.ready; the host and bots true) and
                  //   load ('' | 'wait' | 'done' | 'fail' from room.load), merged when `players` or `room` arrives

F1.net.setRoom(partial) -> bool     // host, lobby: partial of {track, year, mode, q, r, wear}, cleaned as the server does;
                                    //   false when not allowed or nothing valid
F1.net.setReady(on) -> bool         // guest, lobby
F1.net.startRoom({len, force}) -> bool   // host, lobby, room.set.track set, len 200..100000
F1.net.goNow() -> bool              // host, loading, loadedRs === room.rs
F1.net.backToLobby() -> bool        // host, loading or session
F1.net.sendLoaded(rs, ok, opts?) -> bool  // loading / session, rs === room.rs, once per rs; opts {why, len}; ok sets loadedRs
F1.net.selectTrack(id) -> bool      // = setRoom({track: id})   (lobby only now)
F1.net.setYear(y) -> bool           // = setRoom({year: y})     (lobby only now)
F1.net.setBots(list, skill) -> bool // as v7, lobby only
F1.net.gp(action) -> bool           // host, room.st 'session': 'skip' | 'end' | 'again'; 'start' -> false
```

Events:
- `'room'(room, prev)`: every accepted `room`, and on `welcome`.
- `'load'(trackId, rs)`: once per rs, when the room is `loading` or `session` with a track. That covers a new start
  and a newcomer joining either state.
- `'go'(rs)`: only on the transition loading -> session.
- `'lobby'()`: on loading / session -> lobby.
- `'nostart'(why, waitIds)`.
- `'track'` is never emitted in protocol 2.
- Order for one message: `'year'` (if the year changed), `'room'`, then the transition event. On `welcome`:
  `'connected'`, `'year'`, `'room'`, `'load'`.

Sending:
- `sendState`, `sendBotStates`, `sendGpLap`, `sendHit`, `sendLap` and the keepalive send nothing (-> false) unless
  `room.st === 'session'` and `loadedRs === room.rs` (the server drops them anyway); their `k` is `room.rs`, `sendLap`'s
  included;
- the car resync of parc fermé (a car chosen while the server kept the old one) goes out on `'lobby'` and on `'go'` of a
  free-practice session, no longer on a `gp` phase change;
- on `'load'` and `'lobby'` the last state, the bot rows, our progress, the bots' progress and every remote pose are
  dropped.

`version` error text by `need`:
- no `need` (an old server): 房間的遊戲版本比較舊（F1Drive v7.1 以前），請房主更新到 v7.2 以上。
- `need > 2`: 你的遊戲版本比較舊，請更新後再加入。
- else: 遊戲版本與房間不同，無法加入。

### js/gp.js changes

- Online `start()` returns false (a room starts through `net.startRoom`). Offline it is unchanged.
- `view().bots.canEdit` online = `net.isHost && net.room && net.room.st === 'lobby'`.
- Nothing else changes: the room's session after the barrier is handled as before (`'phase'` quali places the car).

### js/ui.js + index.html

```js
F1.ui.init({ ...,
  onSelectTrack(trackData),   // CHANGED: a card was clicked (tracks view or the host's picker). It no longer means "drive":
                              //   main.js opens the start panel (solo) or sets the room's track (host, picker)
  onSetupStart(cfg),          // 開始 / Enter in Q or R / (main.js: pad A). cfg = {mode, q, r, wear, force} (force: the host
                              //   confirmed 仍要開始)
  onSetupBack(),              // ← 選擇其他賽道 (solo panel) / ← 返回大廳 (host's picker)
  onSetup(partial),           // {mode} | {q} | {r} | {wear} changed in the panel / lobby (solo: already stored)
  onReady(on),                // guest: 準備 toggled
  onRoomTrackPicker(),        // host: 選賽道 / 換賽道
  onRoomBack(),               // host: 回到大廳 / 取消，回到大廳 (confirmed in ui while a Grand Prix is not in its results)
  onRoomGo(),                 // host: 不等了，開始 (loading screen)
  onGpOpen()                  // 大獎賽 tab, solo with a track loaded: 在目前賽道開大獎賽…
})                            // onGpStart is gone (no #gp-start); onGpAction stays ('skip' | 'end' | 'again')
F1.ui.setSetup(v)             // the left area of the menu, from a SetupView (below); cheap to call often
F1.ui.setRoomLoading(v)       // the room's loading screen; null hides it
F1.ui.getSetup()              // -> {mode, q, r, wear}: the stored solo setup (localStorage 'f1drive.gp' = {q, r, wear, mode};
                              //   mode default 'free')
F1.ui.setGp(v)                // v.room (bool): results / 大獎賽 tab show 回到大廳 (host) instead of 結束
```

```js
SetupView = {
  show: 'tracks' | 'setup' | 'picker',   // the card grid / the start panel or lobby / the host's track picker (cards)
  room: bool,
  track: trackData | null, trackId: string | null, trackMissing: bool,   // trackMissing: this version lacks the room's track
  current: bool,                          // solo: it is the loaded track (開始 reads 重新開始, chip 目前賽道)
  mode, q, r, wear,                       // solo: the stored setup; room: room.set
  canEdit: bool,                          // solo true; room: host and st 'lobby'
  go: {show, enabled, label, sub},        // the 開始 button (#setup-go)
  hint: string, note: string, banner: string,
  // room only
  st, phase, isHost, ded, address: string, hasPassword: bool,
  players: [{id, name, colour, colour2, team, carName, isHost, isSelf, ready, load}],   // humans, slot order
  counts: {humans, ready},                // ready includes the host
  unready: [names],                       // for the confirm row
  ready: {show, on, enabled, status},     // the guest's toggle (#setup-ready)
  force: bool,                            // host: 不等了，直接開始 shown
  canPick: bool, resume: bool, lobbyBtn: bool
}
RoomLoadingView = { title, sub, rows: [{id, name, colour, isSelf, isHost, state: 'wait' | 'done' | 'fail'}], leftS,
                    canGo, canCancel }
```

DOM (ids the harnesses use):
- `#menu.setup-open` / `#menu.picker` while those views show. In both, `#track-search` / `#track-count` are hidden in the
  setup view, and `#track-grid` is hidden in the setup view and shown in the picker.
- The panel / lobby: `#setup` (class `room` in a room), `#setup-back`, `#setup-title`, `#setup-state`, `#setup-current`.
- Track: `#setup-track` (`#setup-track-name`), `#setup-track-btn`.
- Own settings: `#setup-car` (`#setup-car-change` opens the 車輛 tab), `#setup-year` (select), `#setup-tyre` (buttons
  `data-c` S / M / H).
- Mode and Grand Prix settings: `#setup-mode` (buttons `data-m` free / gp); `#setup-gp` holds `#gp-q`, `#gp-r` and
  `#gp-wear`, **moved here with their ids**; `#gp-bots-box` with `#gp-bots`, `#gp-skill`, `#gp-bots-note`,
  `#gp-bots-list`, **moved here**.
- `#setup-note`.
- The action block `#setup-foot`: `#setup-go` (+ `#setup-go-sub`), `#setup-ready` (`aria-pressed`), `#setup-status`,
  `#setup-force`, `#setup-confirm` (`#setup-force-yes`, `#setup-force-no`), `#setup-resume`, `#setup-lobby`,
  `#setup-hint`.
- Room header and players: `#setup-room` (`#setup-addr`, `#setup-copy`, `#setup-pw`, `#setup-leave`), `#setup-players`
  (rows `.lobby-row[data-id]`, state `.lobby-st[data-state="host|ready|wait|load-wait|load-done|load-fail"]`),
  `#setup-bots-line`.
- Loading screen: `#room-loading` (`#room-loading-title`, `#room-loading-sub`, `#room-loading-list` rows
  `.rl-row[data-id][data-state]`, `#room-loading-left`, `#room-loading-go`, `#room-loading-cancel`,
  `#room-loading-leave`).
- Results: `#gp-res-lobby` (room host: 回到大廳). `#gp-res-end` is shown in single player only.
- 大獎賽 tab: `#gp-open`, `#gp-lobby` (room host, results). **Removed**: `#gp-setup`, `#gp-start`. The tab keeps
  `#gp-car`, `#gp-tyre` (下一組輪胎 during a session) and the session part.
- `ui.setCompound` renders `#gp-tyre` and `#setup-tyre` alike.

Behaviour:
- A card click shows the panel synchronously (main.js calls `setSetup` inside `onSelectTrack`), with `#setup-go` focused.
  So `click(card)` followed by `click('#setup-go')` works.
- The focus moves only when the view changes (open panel / lobby: `#setup-go` for the host and solo, `#setup-ready` for
  a guest), never while the user types.
- Layouts at 1280x720, 1920x1080, 721..1099 and <= 720 px follow `docs/lobby-design.md` §9. The action block is always on
  screen without scrolling.

### js/main.js glue

- **Solo**:
  - `onSelectTrack` opens the panel; `onSetupBack` / Esc / pad B (`pressed.limiter`) return to the cards.
  - `onSetupStart(cfg)`:
    1. a running solo Grand Prix ends;
    2. load the track unless it is the loaded one (the same one: no rebuild, `placeStart` + `freshStart` + lap reset,
       bots re-placed);
    3. `'free'` -> resume; `'gp'` -> `gp.start({q, r, wear, year}, track.length)`.
  - Pad A in the menu = the rising edge of `pad.state.boost`, taken from the state when the menu opened.
  - Esc while driving opens the tracks view (繼續駕駛 as today).
- **Room**:
  - `'connected'` as host of a fresh room (`rs 0`, no track): send the stored setup (`setRoom({year: ownYear(), mode, q,
    r, wear})` + the bots field) and open the picker.
  - `'room'` -> SetupView; toast on `rr` when we were ready.
  - `'load'` -> `#room-loading`, build with no resume (car frozen in its slot; the host makes his bots; same track: no
    rebuild), then `sendLoaded(rs, true, {len: track.length})`. On an unknown track or a build error:
    `sendLoaded(rs, false, {why: 'no-track' | 'error'})`.
  - `'go'` -> hide the loading screen; free: `resume()`; gp: wait for `onGpPhase('quali')`.
  - A newcomer whose `'load'` completes in session resumes at once (free practice, qualifying placement or spectator).
  - `'lobby'` -> stop the loop, menu on the lobby view, clear the remote models, guests' toast 房主回到房間大廳.
  - The host's 開始 goes out once until its answer (a `'room'` or `'nostart'`; `startPending`): a double click over a slow
    link sent a second start, refused with `nostart state`. `'nostart'` toasts its reason, except `'state'` once the room
    is no longer in the lobby (a second start that crossed the first one's answer) (lobby review LOBBY-2).
  - The host's go (不等了，開始), back (回到大廳 / 取消，回到大廳) and gp `'end'` (結束大獎賽) within `ROOM_ACT_MS` (1000 =
    the server's `START_MIN_MS`) of the last change of `room.st` it saw are held for the rest of that second (`roomAct`;
    the latest one asked for wins), then sent if the load cycle (`rs`) is the same and it is still the host; the wait
    is checked again then. The server took the action before it sent that change, so the wait always clears its gate
    (lobby review LOBBY-1: such a click used to be dropped without a word).
  - `onGpPhase` acts only while `room.st === 'session'`; no 「回到自由練習」 toast while the room is in the lobby.
- **Rules**:
  - `inRoomTrack()` = connected and `room.st === 'session'` and `trackData.id === room.set.track` and
    `net.loadedRs === room.rs`. Remote cars, impacts, `sendState` and the bots' publishing follow it.
  - `canResume()` in a room = `inRoomTrack()`.
  - A host's bot field uses `room.set.bots` / `skill` once the room has settings.
- `F1.game` gains `setup` (the last SetupView), `room` (`net.room`) and `loadedRs`.
