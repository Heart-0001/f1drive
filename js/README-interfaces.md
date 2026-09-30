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
