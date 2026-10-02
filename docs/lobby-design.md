# v7.2: the room lobby (房間大廳) and the single-player start panel (出發面板)

Design for the v7.2 build. The binding contract (wire format, APIs, DOM ids) is the section "v7.2 additions: the room
lobby and the start panel" at the end of `js/README-interfaces.md`. This document explains it and adds the flows, layouts,
texts, edge cases, the harness changes and the acceptance checks. Where the two disagree, the contract wins and this file
gets fixed.

Owners in the build stage:
- **net owner**: `net/server.js`, `net/session.js`, `net/host.js`, `js/net.js`, `js/gp.js`, `test/server.test.js`,
  `test/session.test.js`, `test/gp.test.js`, `devtests/net-gp/`.
- **menu owner**: `js/main.js`, `js/ui.js`, `index.html`, `test/main.test.js`.
- The E2E stage owns every other harness (section 12) and the new `devtests/lobby-test/`.

## 1. What the user asked (2026-10-02 ~23:20 / ~23:35)

- 「阿多人叫我選賽道 然後就直接跑進畫面了? 不應該等大家都到才開始嗎」: in a room the game asks for a track and then drops
  everybody straight onto it. Everybody should gather first, and the game should start only once everybody is there.
- 「個人也是阿 為啥都是點賽道就開始了阿」: single player too. A click on a track card must not start driving. The player
  wants to choose first, then start.
- In the same message: 「為啥我拿RB19跑SPA 我才用x1 跑到第二圈一半我已經爆胎了??? 我沒撞欸」. That is a tyre-model bug. A
  separate branch of the workflow handles it, so it is not part of this design.

## 2. Today's flow, reproduced (v7.1 tree `0f4e3af`, 2026-10-02)

Method: a throw-away Electron script in the session scratchpad. It used muted offscreen 1280x720 windows
(`devtests/electron-userdata.js`), the real `preload.js`, `net/host.js` IPC and an in-game server on TCP 24688. A second
script used a dedicated `createServer` on 24689 and a raw `ws` client. Window state was polled from the main process
and recorded by a page-side timeline. Screenshots were read.

| Step | What happened (measured) |
| --- | --- |
| Single player, Monza card clicked | Driving after **0.66 s** with no further input: menu hidden, HUD up, car on the start, free practice (`S` timeline `stop MENU` -> `RUN hud it-1922 free`). |
| A creates a room | A stays in the menu. Status 「房間已建立，你是房主。選一條賽道開始。」, banner over the grid 「你是房主：點選賽道，房間裡所有人會一起載入並回到起跑格。」, 開始大獎賽 disabled 「先幫房間選一條賽道」. |
| B joins (no track yet) | B is in the menu with the track grid greyed out and 「等待房主選擇賽道…」. Roster: Alice (房主), Bob (你). |
| **A clicks the Monaco card** (the "pick a track" the user was asked for) | **A was driving after 0.43 s and B after 0.48 s.** B gave no input: the menu closed, both cars stood in their grid boxes, in free practice. Nothing asked whether everybody was there. |
| C joins while the room drives | C was driving **0.38 s** after clicking 加入房間. It went straight from the 多人連線 tab onto the track. |
| B in the menu (車輛 tab, choosing a car), A clicks 開始大獎賽 in the 大獎賽 tab | Qualifying started on all three windows **0.65 s** after the click. B's menu was closed under him and he was put on the track with the qualifying clock already running (toast 「大獎賽開始：排位 1 圈，正賽 1 圈」). There is no loading barrier: the server starts the session the moment the host asks. |
| A skips qualifying | All three go to the grid, frozen, lights. |
| D joins during the grid | D lands on the track as a ghost spectator with the toast 「大獎賽進行中，你正在觀戰，下一場開始時才會加入」 and the caption 正賽即將起跑. |
| A ends the race (結束 twice) | Results overlay on the track, then 「大獎賽已結束，回到自由練習」. Everybody stays on the track in free practice. |
| C leaves the room | C goes back to the single-player menu with the room's track still loaded (繼續駕駛 offered). |
| A (the in-game host) leaves | B keeps driving alone. Toast 「連線中斷：房主已關閉房間，已回到單人模式」. |
| Dedicated server | The first player to join (Ann) is the host. His status wrongly says 「房間已建立，你是房主。選一條賽道開始。」. His card click drops both onto the track. When Ann leaves, Ben becomes host (「原本的房主離開了，現在你是房主。」) and the track stays. |
| A client saying `hello {v: 2}` to today's server | `{"t":"error","code":"version"}`, then close 1008. Old servers already refuse a newer protocol cleanly. |

So the complaint is accurate. The room has no state in which "everybody is here and nobody drives". The host's track
pick and his Grand Prix start each act on everybody at once. Latecomers go straight onto the track.

## 3. Decisions taken for the user (they are away)

1. **Single player**: a card click selects the track and opens the start panel (出發面板) in place of the card grid. The
   panel shows the track, your car and season, mode (自由練習 / 大獎賽 with its settings), computer drivers and starting
   tyres, plus one big **開始** button. 開始 has focus, so a quick practice is card + Enter (or card + click on 開始). Esc / pad B
   go back to the cards. Pad A or Enter starts. Nothing drives before 開始.
2. **Rooms get a lobby** (房間大廳), shown right after creating or joining. Nobody is on a track there. The host edits the
   room settings: track (picked from the cards; a card click in the lobby sets the room's track), season, mode,
   Q / R / tyre wear, and the number and strength of the computer drivers. Guests see the same settings read-only. Each
   player picks his own car of the season and his starting tyres, then presses **準備** (ready). The starting compound
   stays a per-player choice, as it has been since v6.2 (the next set is main.js's own state, cycled with T / X).
   Every driver choosing his own tyres is also how real teams work. So it sits under 「你的設定」, not under the
   room settings.
3. **開始 (host)** is the main button and is enabled once every human is ready. The host counts as ready, and so do the
   computer drivers. While somebody is not ready, the host sees 開始 disabled plus 「不等了，直接開始」. That asks for a
   confirmation naming the players who are not ready. If confirmed, they load too. A host alone (with or without bots)
   can start at once.
4. **Loading barrier**: after 開始 everybody builds the track at the same time behind a loading screen that lists who is
   still loading. The session begins when everybody has loaded, or after **20 s** at the latest. The host may also press
   「不等了，開始」 once his own track is built. A Grand Prix starts qualifying only then. In free practice, car states are
   accepted only from that moment, so all the cars appear together.
5. **After the results** the host chooses **再來一場** (same track and settings: straight into qualifying, as today) or
   **回到大廳** (everybody back to the lobby, ready flags cleared). A room never falls back to single player or to
   free practice on its own. 「結束大獎賽」 during the race still gives the results. During qualifying or the grid it
   returns the room to the lobby.
6. **Esc during a room session** opens the room menu (the lobby view, marked 「賽事進行中」) with 繼續駕駛. The host also
   gets 回到大廳 there.
7. **Joining while a session runs** follows today's rules. The newcomer loads the track and drives: free practice
   normally, qualifying as a participant, grid / race / results as a ghost spectator. When the room returns to the lobby,
   he goes there with everybody. A player who joins during loading is added to the barrier.
8. **The host leaving**: in a room created in the game, the room closes, as today. Guests in the lobby or the loading
   screen go back to the single-player menu with a toast. Guests on the track drive on alone, as today. On the dedicated
   server (`node net/server.js`) the first player to join is the host, and the role passes to the longest-connected
   player. The room settings stay with the room, and the new host's game rebuilds the computer drivers from them.
9. **Protocol 2**: the wire format changes incompatibly, so `PROTOCOL` becomes 2. A server refuses any other version with
   `error {code: 'version', need: 2}`. A 7.2 client tells an old server apart from a newer one by `need` and shows a
   clear text (section 10).
10. **Settings that reset readiness**: when the host changes the track, the season or the mode, every guest's 準備 is
    cleared (they get a toast). Laps, tyre wear and computer drivers do not clear it.
11. **Ownership of settings**: the solo setup (mode, Q, R, wear) is remembered per player (`localStorage 'f1drive.gp'`,
    now `{q, r, wear, mode}`; mode defaults to `'free'`). The host's lobby edits are remembered too, because they are his
    preferences. A fresh room (no track yet, `rs` 0) takes the host's remembered setup when he connects. A room that
    already has settings (dedicated server, a new host after migration) keeps them.
12. **Cars and bots are frozen at 開始.** Cars can be changed in the lobby and during a free-practice session (as today),
    not while loading and not during a Grand Prix (parc fermé). Computer drivers and the season can only change in the
    lobby.

## 4. Single player: the start panel

### Flow

```
 tracks view (cards)  --card click-->  start panel (track X)  --開始 / Enter / pad A-->  loading note  -->  driving
        ^                                   |  ^                                                            |
        +------- ← 選擇其他賽道 / Esc / pad B --+  +---------- card click (any card, incl. the current one) ------+
                                                                       Esc / Start: menu (tracks view) <----+
```

- **Card click (any time)**: main.js opens the panel for that track (`SetupView.show = 'setup'`). Nothing loads. If that
  track is the loaded one, the panel shows the chip 「目前賽道」 and 開始 reads 「重新開始」.
- **開始** (`onSetupStart(cfg)`, cfg = `{mode, q, r, wear}` from the panel):
  1. A running solo Grand Prix ends (as a track change ends one today). The panel then shows the warning
     「大獎賽進行中：開始新的賽事會結束目前的大獎賽。」.
  2. If track X is not the one loaded, it is built behind the loading note (`loadTrack`, as today), the car is placed on
     the start position, and the computer drivers are made on it. If X is already loaded, nothing is rebuilt: the car
     (and the bots) go back to their start positions with a fresh start (`freshStart`, lap counter reset).
  3. Mode `'free'`: the loop resumes and the player drives. Mode `'gp'`: `gp.start({q, r, wear, year}, track.length)`
     straight after the build. Qualifying places the car (`onGpPhase('quali')`) and resumes.
- **Esc while driving** opens the menu on the **tracks view** (as today), with 繼續駕駛 and the current track's card
  marked 目前賽道. Esc or Start resumes from the tracks view. In the start panel, Esc goes back to the cards and
  Start resumes (繼續駕駛), if a track is loaded.
- Settings in the panel take effect as they do today: year, car, starting compound and computer drivers apply at once
  through `onYear` / `onCar` / `onCompound` / `onBots`. Bots on a loaded free-practice track appear or leave at once.
  Mode, Q, R and wear are read at 開始.
- The 大獎賽 tab no longer starts anything. Before a session it shows 「點一條賽道，在出發面板選「大獎賽」再按開始。」.
  With a track loaded it also shows a button `#gp-open` 「在目前賽道開大獎賽…」, which opens the start panel for the
  current track with mode 大獎賽 selected. During a session it shows today's state, standings, 跳過排位 / 結束大獎賽 /
  再來一場 and the 下一組輪胎 row (`#gp-tyre`).
- Results (solo): 再來一場 / 結束 (back to free practice on this track, as today) / 關閉. These are unchanged.

### Keys and controller in the menu

| Input | Tracks view | Start panel | Room lobby | Room loading screen | Room menu during a session |
| --- | --- | --- | --- | --- | --- |
| Esc | resume (if a track is loaded) | back to the cards | closes the host's track picker / the confirm row; else nothing | nothing | resume |
| Enter | the focused button (cards are `<button>`s: Tab + Enter opens the panel) | the focused button; `#setup-go` has focus when the panel opens; Enter in Q / R starts | the focused button | - | - |
| pad Start | resume | resume (if a track is loaded) | nothing | nothing | resume |
| pad A (rising edge of `state.boost`: A or RB) | nothing | 開始 | host: 開始 (if not everybody is ready: the first A opens the confirm row, a second A confirms); guest: toggles 準備 | nothing | nothing |
| pad B (`pressed.limiter`: B or LB) | nothing | back to the cards | closes the picker / the confirm row | nothing | nothing |

`js/gamepad.js` is not changed. main.js's menu poll (every `PAD_MENU_MS`) reads `ps.pressed.limiter` for B and the rising
edge of `ps.boost` for A. The previous boost state is taken when the menu opens, so an A held while driving does not
count. Choosing a card with the pad is not supported; that is a known limit.

## 5. Rooms: states and flows

### Room state (server-authoritative, `room.st`)

```
             start (host, track set, all ready or force)           everybody loaded / 20 s / go (host)
   lobby  ------------------------------------------------>  loading  --------------------------------------->  session
   ^   ^                                                       |                                                  |
   |   +------------------------- back (host) ----------------+                                                  |
   +--------- back (host) / gp end in quali, grid, results / room empty / nobody loaded at the barrier ------------+
```

- **lobby**: nobody is on a track. There is no Grand Prix session (`session.phase` is `'free'`). The server drops car
  states, laps, lap times and impact reports. The host edits settings (`set`, `bots`), guests toggle `ready`, and
  everybody edits his profile (name, colour, car).
- **loading**: the settings, the field and the cars are frozen. Every client builds `room.set.track` and reports `loaded`.
  Car states are still dropped.
- **session**: free practice (`set.mode 'free'`: `session.phase` stays `'free'`) or a Grand Prix (`'gp'`: the server called
  `session.start` at the barrier: quali -> grid -> race -> results as today; `again` restarts qualifying without leaving the
  session). Car states are accepted with `k === room.rs`.

`room.rs` (the load cycle) goes up by one at every `start`. It replaces v1's `trackSeq`: the `k` of `s`, `bs`, `gl` and
`hit` must equal it.

### Flows

**Create / join.** Creating a room (in-game server) connects the creator with the host token. Joining connects as a
guest. `welcome` carries `room`.
- Host of a **fresh** room (`rs === 0 && set.track === null`): his game sends his remembered setup once
  (`set {year, mode, q, r, wear}` and his `bots` field), and the menu shows the lobby with the **track picker opened**
  (banner 「房間已建立。先幫房間選一條賽道（點卡片不會馬上開始）。」).
- Everybody else: the lobby view. A guest's 準備 starts off.

**Track pick (host).** In the lobby, 選賽道 / 換賽道 opens the picker (the card grid, banner, ← 返回大廳). A card click sends
`set {track}` and closes the picker. The other players see the new track in the lobby within one tick (100 ms), their
準備 is cleared, and they get the toast 「房主改了賽道，請再按一次「準備」。」.

**Ready.** A guest presses 準備 (`ready {on: true}`) and presses again to cancel. The lobby shows 「準備好了」 next to his
name for everybody.

**Start.** The host presses 開始. If a guest is not ready, the host's game first asks: 「Bob、Cara 還沒按準備。仍要開始
嗎？他們也會一起載入賽道。」 with [仍要開始] [再等等]. Then it sends `start {len, force}`. The server checks the rules
(section 7). Then it moves the room to `loading` (rs + 1), starts `load = {at, until: at + 20 s, wait: every human present,
done: [], fail: []}` and sends `room` at once.

**Loading.** Every client gets `'load'` and does the following:
1. Shows the loading screen (`#room-loading`) over the menu: track name, mode line, each human player with 載入中… /
   已載入 / 載入失敗, and 「最多再等 N 秒」.
2. Builds the track. It is not rebuilt if it is the one already loaded, as after 回到大廳 on the same track. The client
   places its car in its room slot's grid box, frozen. The host also makes his computer drivers.
3. Sends `loaded {rs, ok: true, len: track.length}`. If the track id is unknown to this version, it sends
   `{ok: false, why: 'no-track'}`; if the build throws, `{ok: false, why: 'error'}`.

A player still in the lobby view, choosing a car, gets the same screen. The game pulls him in, as the host confirmed.
He also gets the toast 「房主開始了：你還沒按準備，也一起載入。」.

**Barrier.** The session begins when one of these happens:
- `load.wait` becomes empty;
- the server clock reaches `load.until`;
- the host sends `go` (allowed once his own `loaded` arrived; the button 「不等了，開始」 appears for him then).

If nobody at all loaded (`done` empty), the room returns to the lobby and the host gets `nostart {why: 'load'}`.
Otherwise:
- Players in `fail` are taken out of the session for this time (`session.removePlayer`). They stay in the room, in the
  lobby view, with the note 「你的版本沒有這條賽道（id），請更新遊戲。這一場你在大廳等。」. They are added back
  (`session.addPlayer`) when the room returns to the lobby.
- Mode `'gp'`: `session.start({q, r, len, year, wear}, now)` with the frozen settings. `len` is the host's `loaded.len`
  when he sent one within ±15 % of `start.len`, else `start.len`.
- `room.st = 'session'`. The `room` message goes out **before** the `gp` message (see "Ordering" in section 6).
- Players still in `wait` at the timeout stay in the session. They join it when their track is built: free practice,
  or qualifying from their slot with the clock already running.

On the client, `'go'` hides the loading screen. Free practice: the loop starts (`resume`) and the car is free. Grand
Prix: the screen shows 「排位賽即將開始…」 until `onGpPhase('quali')`, which arrives with the next message, places the car
and resumes.

**Session.** Driving is as in v7.1. Esc opens the room menu (lobby view, session mode). The host's tools:
- 大獎賽 tab, during a Grand Prix: 跳過排位 (`gp skip`); 結束大獎賽 (`gp end`: race -> results; quali / grid -> lobby,
  after 「要結束這場大獎賽並回到房間大廳嗎？」); 再來一場 in results (`gp again`); 回到大廳 in results (`back`).
- Results overlay, host: 再來一場 (`#gp-res-again`) / 回到大廳 (`#gp-res-lobby`) / 關閉. Guests: 關閉 and the note
  「等待房主選擇再來一場或回到大廳」.
- Room menu, host: 回到大廳 (`#setup-lobby`), with the confirmation above while a Grand Prix is not in its results.

**Back to the lobby.** The host sends `back` (from loading or session). The server does the following:
1. Ends the session (`end()` until `'free'`).
2. Clears every car's state, trail, lap times and the ready flags.
3. Re-adds failed loaders to the session.
4. Sets `room.st = 'lobby'` and `load = null`, then sends `room`, then `gp`.

Every client gets `'lobby'`:
1. Stops the loop and opens the menu on the lobby view.
2. Clears the remote car models and stops sending states (`lastState` and the bot rows are dropped).
3. Shows the toast 「房主回到房間大廳」 (guests).
4. Keeps the track loaded, because the next 開始 on the same track is instant.

`gp` phase `'free'` arriving while `net.room.st === 'lobby'` must not toast 「大獎賽已結束，回到自由練習」.

**Joining in every state.**

| Room state when he joins | What the newcomer gets |
| --- | --- |
| lobby | The lobby view, 準備 off. He takes a bot's seat if the room is full (as in v7 free practice). |
| loading | `'load'` at once. He is added to `load.wait` (the deadline does not move) and loads with the others. Full room: `error full`. |
| session, free practice | `'load'`, then drives as soon as his track is built (no barrier). |
| session, qualifying | `'load'`, then qualifies from his slot (a participant, as today). |
| session, grid / race / results | `'load'`, then a ghost spectator (as today: lights caption 正賽即將起跑 / 正賽開始, not classified). |

Whoever joined during a session goes to the lobby with everybody on `back`.

**Leaving in every state.**

| Who / when | What happens |
| --- | --- |
| Guest, lobby | Leaves the roster; the others get the toast 「X 離開了房間」. If he was the last unready one, the host's 開始 becomes enabled. |
| Guest, loading | Taken out of `load.wait`; the barrier may complete. The loading lists drop his row. |
| Guest, session | As today: out of qualifying / the grid, DNF in the race, his row kept in the results. |
| In-game host, any state | The room closes, as today. Guests in the lobby or on the loading screen go back to the single-player tracks view with the toast 「房主關閉了房間，已回到單人模式」 (the half-built track may stay loaded; 繼續駕駛 then drives it alone). Guests on the track drive on alone with 「連線中斷：房主已關閉房間，已回到單人模式」 (unchanged). |
| Dedicated-server host, lobby | The longest-connected player becomes host (toast 「你現在是房主：可以設定房間並按「開始」」). The settings stay. The old host's computer drivers leave with him, and the new host's game rebuilds the field from `room.set.bots` / `skill`. |
| Dedicated-server host, loading | As in the lobby. The barrier runs on. The new host can use 「不等了，開始」 once he has loaded. The field starts without the old host's bots. |
| Dedicated-server host, session | As today (bots DNF, the session goes on). The new host has every host tool. |
| Everybody (dedicated server) | The room goes back to `lobby`, keeps its settings and clears `ready` / `load`. |

**Version mismatch.** A server refuses `hello.v !== 2` with `error {code: 'version', need: 2}`.
- A v7.1 client shows its own text, 「遊戲版本與房主不同，無法加入」.
- A 7.2 client that gets `version` without `need` is talking to an old server: 「房間的遊戲版本比較舊（F1Drive v7.1
  以前），請房主更新到 v7.2 以上。」
- With `need > 2`: 「你的遊戲版本比較舊，請更新後再加入。」
- With `need < 2` (cannot happen today): 「遊戲版本與房間不同，無法加入。」

## 6. Protocol 2 on the wire

JSON text frames, at most 2 KB inbound (unchanged). Everything not listed here is as in v1..v7 (`ping` / `pong`, `snap`,
`hit`, `glno`, `gone`, `bs`, the bot fields...).

### Client -> server

| Message | Who / when | Fields and cleaning |
| --- | --- | --- |
| `hello {v: 2, name, colour, car, token?, password?}` | anybody | `v` must be 2, else `error {code: 'version', need: 2}` |
| `set {track?, year?, mode?, q?, r?, wear?}` | host, lobby | `track`: `/^[A-Za-z0-9_.\-]{1,64}$/` (the server does not know the tracks); `year`: `cleanYear`; `mode`: `'free'` \| `'gp'`; `q`: whole 1..20, `r`: 1..99, `wear`: 1..5 (`Math.round`, out of range = field ignored, never clamped). An invalid field is ignored and the others apply. A change of `track`, `year` or `mode` clears every guest's ready flag (`rr` + 1). |
| `bots {n, skill?, list?}` | host, **lobby only** (v7: free practice) | as v7; `set.bots = clamp(floor(n), 0, 15)` (the wish), `set.skill = level` |
| `ready {on}` | a guest (not the host), lobby | `on === true` / `false`, anything else ignored |
| `start {len, force?}` | host, lobby | `len`: number 200..100000 (the client sends `round(trackData.lengthKm * 1000)`); `force === true` starts with guests not ready |
| `loaded {rs, ok, why?, len?}` | anybody, loading or session | `rs === room.rs`, else ignored; first per player per rs only; `ok === true` -> done, else fail; `why`: `/^[a-z-]{1,16}$/` (logged only); `len` (host only): 200..100000 |
| `go {}` | host, loading, after his own `loaded {ok: true}` | ends the barrier now |
| `back {}` | host, loading or session | room -> lobby |
| `gp {a}` | host, session | `a`: `'skip'` \| `'end'` \| `'again'`; `'start'` is ignored (v2 starts through `start`). `end`: race -> results; quali / grid / results -> same as `back` |
| `s`, `bs`, `gl`, `hit`, `lap` | session only, `k === room.rs` | as v7 (dropped in lobby / loading) |
| `profile {name, colour, car}` | anybody | name / colour always; `car` only in the lobby and in a free-practice session (else kept: parc fermé) |
| `track`, `year` (v1) | - | ignored (use `set`) |

### Server -> client

| Message | Fields |
| --- | --- |
| `welcome` | `{v: 2, id, host, ded, now, room, bots, players}`: `ded` = dedicated server (no host token: the host is the first player and migrates); no `track` / `seq` / `year` any more (they are in `room`) |
| `room` | `{st, rs, set: {track, year, mode, q, r, wear, bots, skill}, ready: [ids], rr, load, len}`, see below |
| `players` | `{host, bots: {n, skill}, players: [rows]}` (as v7 without `year`) |
| `nostart` | `{why, wait?}` to the host only: `'state'` (not in the lobby), `'track'` (no track), `'len'` (bad len), `'busy'` (within `START_MIN_MS`), `'not-ready'` (no force; `wait` = the guest ids not ready), `'load'` (nobody loaded at the barrier) |
| `gp` | as v7 (`{now, s: snapshot}`) |
| `error` | as v7, plus `need` on `version` |

`room` fields:
- `st`: `'lobby'` \| `'loading'` \| `'session'`.
- `rs`: integer >= 0, the load cycle (0 until the first start); the `k` of states, laps and impacts.
- `set`: the room settings, frozen from `start` until the room is back in the lobby. `track`: id or null; `year`: 2010..2100
  or null; `mode`: `'free'` \| `'gp'` (default `'free'`); `q` (3), `r` (5), `wear` (1); `bots` 0..15 (the host's wish; the
  roster has the real field); `skill`: level id.
- `ready`: the ids of the guests who are ready. The host is never listed; he counts as ready. Bots are not listed; they
  count as ready.
- `rr`: how many times the ready flags were cleared by a settings change (clients toast when it moves and they were ready).
- `load`: null outside `loading`; else `{at, until, wait: [ids], done: [ids], fail: [ids]}` (server clock ms; humans only).
- `len`: the length the session uses (0 in the lobby).

### Ordering

A transition always sends its `room` message **at once** (not coalesced) and **before** the `gp` message the same
transition causes. This applies to start -> loading, the barrier -> session (+ `gp` quali), back / end -> lobby (+ `gp`
free). Settings, ready, `loaded` and join / leave changes are coalesced like the roster: the first goes out at once,
then at most one `room` per `COALESCE_MS` (100 ms) tick, carrying the state as it is then. A newcomer gets `welcome` (with
`room`) and then the current `gp` snapshot, as today.

### Constants (net/server.js)

`PROTOCOL = 2`, `LOAD_TIMEOUT_MS = 20000`, `START_MIN_MS = 1000` (between two of the host's start / back / go),
`SET_PER_S = 10` (`set` messages per connection per second, the rest dropped silently), `READY_PER_S = 5` (per player).
`COALESCE_MS`, `RATE_*`, `BOT_RATE`, `IDLE_MS` are unchanged.

## 7. Server rules (net/server.js)

- **Which message counts where**: the table in section 6. A message in the wrong state, or from a player who may not send
  it, is dropped without an answer. The exception is `start`, which answers `nostart` to the host.
- **Validation**: as section 6. No field is clamped into another meaning: a bad year, q, r, wear or mode is ignored, not
  clamped. Ids in lists are numbers. Every list the server sends is bounded by the players present (at most 16 humans;
  the server keeps its `MAX_PLAYERS`).
- **Rate limits**: the token bucket of v7 stays in front of everything (flooding still ends with `error flood`). On top
  of it:
  - `set` at most `SET_PER_S` per second per connection;
  - `ready` at most `READY_PER_S` per second per player;
  - start / back / go at most one per `START_MIN_MS` from the host (`nostart busy` for start);
  - `loaded` once per player per rs.

  `room` broadcasts are coalesced, so nothing a client sends makes the server send more than about 10 `room` messages
  per second.
- **Hostile cases the tests must cover**:
  - a guest sending `set` / `start` / `go` / `back` / `bots` / `gp`: no effect;
  - `ready` flooding: bounded, no extra broadcasts beyond the tick;
  - `loaded` with another rs, twice, before `start`, or with `len` from a guest: ignored;
  - `loaded {ok: true}` from a guest who never built anything: harmless; only his own barrier entry moves;
  - `set {track: '../../x'}` / `'a'.repeat(65)` / `null` / `7`: ignored;
  - `set {q: 1e9, r: -1, wear: 2.5, year: 1999, mode: 'race'}`: those fields ignored (`wear: 2.5` rounds to 3: valid);
  - `start` without a track, with `len: 50`, during loading, twice within 1 s;
  - `s` / `bs` / `gl` / `hit` / `lap` in the lobby or while loading: dropped, nothing broadcast;
  - a car change during loading or a Grand Prix: kept;
  - `hello {v: 1}` / `{v: '2'}` / no `v`: `error version` with `need: 2`;
  - a `track` (v1) message from the host: ignored.
- **Session glue**:
  - `session.addPlayer` at join (as today: any room state).
  - `session.removePlayer` at leave (as today) and for failed loaders before `session.start`.
  - `session.start` at the barrier in mode `'gp'`.
  - `back` and `gp end` outside the race: `end()` until `'free'`.
  - `net/session.js` itself needs no change.
- **States at start / back**: like v1's `setTrack`: every player's and bot's `state`, `fresh`, `last`, `best` and `trail`
  are cleared, so the proof-of-driving sums start again.
- **Full room**: a human joining a full room takes the newest bot's seat in the lobby and in a free-practice session.
  While loading or in a Grand Prix: `error full`.
- **Room empty** (dedicated server): back to `lobby`; settings kept; `ready`, `load` cleared; the session ended.
- `srv.info()` gains `room` (the `room` message's fields).
- Dedicated server's start-up lines: 「The first player to join is the host: he sets the room up in the lobby (track,
  season, mode) and starts when everybody is ready.」. Log lines `room  lobby|loading|session`, `start rs=N track=..
  mode=..`, `loaded #id ok|fail`, `go (all loaded|timeout|host)`, `back`.

## 8. Client side

### js/net.js (net owner)

- `PROTOCOL = 2`. The `version` error text depends on `need` (section 5).
- `net.room` holds the sanitised `room`: every field present and of its type, ids as numbers, at most 64 per list; null
  outside a room.
- `net.trackId` = `net.room.set.track`. `net.year` = `net.room.set.year`, and 'year' still fires when it changes.
- Roster rows gain `ready` (bool: the host and bots true) and `load` (`''` | `'wait'` | `'done'` | `'fail'`), merged
  whenever `players` or `room` arrives.
- `net.loadedRs` is the last rs we reported `ok` for. `net.address` is the address we joined (guest) or null.
- Events:
  - `'room'(room, prev)` on every accepted `room` / `welcome`;
  - `'load'(trackId, rs)` once per rs when the room is `loading` or `session` with a track (also for a newcomer);
  - `'go'(rs)` on loading -> session only;
  - `'lobby'()` on loading / session -> lobby;
  - `'nostart'(why, waitIds)`.
  - `'track'` is no longer emitted.
- Order on one message: `'year'` (if it changed), `'room'`, then the transition event.
- Calls:
  - `setRoom(partial)`, `setReady(on)`, `startRoom({len, force})`, `goNow()`, `backToLobby()`,
    `sendLoaded(rs, ok, {why, len})`;
  - `selectTrack(id)` = `setRoom({track: id})` and `setYear(y)` = `setRoom({year: y})` (lobby only);
  - `setBots` in the lobby only; `gp('start')` -> false;
  - `sendState` / `sendBotStates` / keepalive send nothing unless `room.st === 'session'` and `loadedRs === room.rs`.
  - On `'lobby'` and `'load'`: `lastState`, `lastBotRows`, `progress`, bot progress and remote poses are cleared.

### js/gp.js (net owner)

- Online `start()` -> false (rooms start through `net.startRoom`). Offline it is unchanged.
- `view().bots.canEdit` online = host && `net.room.st === 'lobby'`.
- Everything else is unchanged: the session after the barrier is the room's session as before.

### js/main.js (menu owner)

- **Solo**: `onSelectTrack(td)` opens the panel (`setup = {show: 'setup', track: td}`). `onSetupStart(cfg)` runs the
  start of section 4. `onSetupBack()` returns to the cards. Esc and the pad follow the table in section 4.
- **Room**:
  - `'connected'` (host of a fresh room): send the remembered setup and open the picker.
  - `'room'`: rebuild the SetupView; toast on an `rr` change if we were ready; toast when the host changed.
  - `'load'`: show `#room-loading`, `loadTrack(data, {hold: true})` (no resume; the car frozen in its slot; the host makes
    his bots); then `net.sendLoaded(rs, true, {len: track.length})`; unknown track -> `sendLoaded(rs, false,
    {why: 'no-track'})`.
  - `'go'`: hide the loading screen; free -> `resume()`; gp -> wait for `onGpPhase('quali')`.
  - `'lobby'`: section 5. `'nostart'`: toast.
  - Late joiner: after his `'load'` completes with `room.st === 'session'`: resume (free / quali placement / spectator).
- `inRoomTrack()` = connected && `room.st === 'session'` && `trackData.id === room.set.track` && `net.loadedRs === room.rs`.
  Remote cars, impact reports, bot publishing and `sendState` all follow it.
- `onGpPhase` in a room acts only while `net.room.st === 'session'`. `'free'` while the room is in the lobby: no toast.
- The bots in a room: the host's lineup uses the room year and the humans' cars as today, with the count and skill from
  `room.set` (`bots` / `skill`), not from his own stored setting once the room has settings.
- `HOST_PICK` and the room texts change (section 10). `canResume()` in a room = session and `inRoomTrack()`.
- `F1.game` gains `setup` (the last SetupView), `room` (`net.room`) and `loadedRs` (for the harnesses).

### js/ui.js + index.html (menu owner)

`F1.ui.setSetup(v)` renders the left area from a SetupView, and `F1.ui.setRoomLoading(v | null)` renders the loading
screen. The callbacks and DOM ids are in the contract. The layout follows.

## 9. UI layout

The menu's left area (`.menu-body`, today the card grid) shows one of three views: **tracks** (cards + search, as today),
**setup** (the start panel or the lobby), and **picker** (the cards, for the host choosing the room's track).
`#menu.setup-open` is set while the setup view shows, `#menu.picker` while the picker shows. The side panel (車輛 / 大獎賽 /
多人連線 / 設定) stays where it is.

### 1280 x 720, single player, start panel (left area 920 x ~550 px)

```
 tools row: [← 選擇其他賽道]                                                   [繼續駕駛]* (only with a track loaded)
 +--------------------------------------+  +--------------------------------------------------+
 | 摩納哥賽道            [目前賽道]*       |  | 模式   [ 自由練習 | 大獎賽 ]                       |
 | Circuit de Monaco                     |  |        大獎賽：先跑排位賽決定起跑順序，再跑正賽。      |
 | (track outline, 170 px high)          |  | 排位圈數 [ 3 ]   正賽圈數 [ 5 ]     (大獎賽 only)    |
 | 摩納哥 蒙地卡羅 ‧ 3.337 km             |  | 輪胎損耗 [×1|×2|×3|×4|×5]          (大獎賽 only)    |
 +--------------------------------------+  | 電腦車手 [ 5 位 v ]  強度 [新手|業餘|職業|傳奇|混合]   |
 | 你的車  ● 法拉利 SF-26  [換車]          |  | (field chips: Leclerc  Hamilton ...)              |
 | 賽季    [ 2026 v ]                     |  | 大獎賽進行中：開始新的賽事會結束目前的大獎賽。 (*)    |
 | 起跑輪胎 [ 軟 | 中 | 硬 ]               |  | +----------------------------------------------+ |
 +--------------------------------------+  | |            開始                               | |
                                            | |   自由練習 ‧ 摩納哥賽道                         | |
                                            | +----------------------------------------------+ |
                                            |  Enter 或手把 A：開始 ‧ Esc 或手把 B：返回賽道列表     |
                                            +--------------------------------------------------+
```

- Two columns of `minmax(0, 1fr)` with a 20 px gap. Left column 400 px max; right column at least 420 px.
- The 開始 block (`#setup-foot`) is `position: sticky; bottom: 0` inside the right column. It is 56 px tall: label 20 px
  bold, sub line 12.5 px. It is always visible without scrolling.
- `.seg` / `.mp-field` / `.mp-btn` classes as in the side panel. The Q / R / wear / bots controls are the existing ones,
  moved with their ids (contract).

### 1280 x 720, room lobby (host and guest)

```
 tools row: 房間大廳   位址 192.168.18.3:24688 [複製]  [有密碼]                              [離開房間]
 +--------------------------------------------+  +--------------------------------------------+
 | 玩家（3 人 + 電腦 5，8 / 16）                 |  | 房間設定                     （由房主設定）*g |
 | ● Alice  房主  你   ▌法拉利 SF-26     房主   |  | 賽道   摩納哥賽道 3.337 km        [換賽道]*h |
 | ● Bob              ▌紅牛 RB22      準備好了 ✓ |  | 賽季   [ 2026 v ]                           |
 | ● Cara             ▌麥拉倫 MCL40    還沒準備   |  | 模式   [ 自由練習 | 大獎賽 ]                  |
 | 電腦車手 ×5（職業）：Verstappen、Norris …     |  | 排位 [3]  正賽 [5]  損耗 [×1…×5]  (大獎賽)   |
 +--------------------------------------------+  | 電腦車手 [5 位 v]  強度 [ … ]                 |
 | 你的設定                                     |  +--------------------------------------------+
 | 你的車  ● 法拉利 SF-26  [換車]                |  | host:  [        開始        ]               |
 | 起跑輪胎 [ 軟 | 中 | 硬 ]                    |  |        大獎賽 ‧ 2 / 3 已準備                 |
 +--------------------------------------------+  |        [不等了，直接開始]  (while not all ready)|
                                                 | guest: [   準備   ] / [ 已準備 ✓（再按取消）]    |
                                                 |        等待房主開始…                         |
                                                 +--------------------------------------------+
```

- Left column: players and your own settings. Right column: room settings and the action block (sticky bottom).
- The players list scrolls inside its box past 9 rows. Bots are one summary line plus chips (`#gp-bots-list` style), not
  15 rows.
- A guest's settings controls are disabled. They show the room's values with the note 「由房主設定」.
- The confirm row (`#setup-confirm`) replaces the action block until it is answered.
- During a session (Esc on the track) the same view shows the banner `#setup-state` 「大獎賽進行中：正賽」 /
  「自由練習中」. The settings are read-only, the ready column is hidden, and the action block holds [繼續駕駛]
  (`#setup-resume`) and, for the host, [回到大廳] (`#setup-lobby`).

### Loading screen (`#room-loading`, any size)

```
                  +------------------------------------------+
                  | 載入賽道中…   (等待其他玩家載入… once ours is)|
                  | 摩納哥賽道 ‧ 大獎賽（排位 3 圈、正賽 5 圈）     |
                  | ● Alice  房主         已載入              |
                  | ● Bob                 已載入              |
                  | ● Cara                載入中…             |
                  | 最多再等 14 秒                             |
                  | [不等了，開始]* [取消，回到大廳]*  [離開房間]  |
                  +------------------------------------------+
```

- Fixed, centred, z-index 30 (like `#loading`), `width: min(520px, calc(100vw - 32px))`. The list scrolls past
  `max-height: 50vh`.
- The menu under it is dimmed. `pointer-events` only on its buttons. `*` = host only.
- The plain `#loading` note (載入賽道中… while the page builds) may show at the same time, on top. That is fine.

### Other sizes

- **1920 x 1080**: the setup view is `max-width: 1180px`, left-aligned in the left area; everything else as at 1280.
- **721..1099 px wide**: the left area is under 740 px. The setup view is one column, in this order: track / room header,
  settings, players, your settings. The action block stays sticky at the bottom of the left area.
- **<= 720 px** (the menu is one column today, side panel first): while the setup or picker view shows, `.menu-body`
  comes first (`order: -2`) and the side panel after it. The action block is `position: sticky; bottom: 0` with the
  panel background, so 開始 / 準備 stay on screen while the page scrolls. Rows wrap; segmented controls may go to two
  lines. There is no horizontal page scroll at 360 px.
- Checks for the E2E stage at 1280x720, 1920x1080, 1100, 1000, 800, 700 and 480 px:
  - nothing clipped or overlapping;
  - `#setup-go` / `#setup-ready` fully inside the viewport without scrolling;
  - the toast clear of the action block;
  - no horizontal scroll.

## 10. Texts (Traditional Chinese, Taiwan usage)

| Where | Text |
| --- | --- |
| brand line (index.html) | 第一人稱賽道駕駛 ‧ 選賽道、按開始 |
| start panel back | ← 選擇其他賽道 |
| current track chip | 目前賽道 |
| section labels | 你的車 / 賽季 / 起跑輪胎 / 模式 / 自由練習 / 大獎賽 / 排位圈數 / 正賽圈數 / 輪胎損耗 / 電腦車手 / 強度 / 換車 |
| mode notes | 自由練習：不計成績，隨時可以按 Esc 回選單。 ‧ 大獎賽：先跑排位賽決定起跑順序，再跑正賽。 |
| 開始 button | 開始 (重新開始 for the loaded track); sub line 自由練習 ‧ <track> / 大獎賽 ‧ 排位 n 圈 ‧ 正賽 m 圈 |
| hint under 開始 | Enter 或手把 A：開始 ‧ Esc 或手把 B：返回賽道列表 |
| solo GP running | 大獎賽進行中：開始新的賽事會結束目前的大獎賽。 |
| 大獎賽 tab, no session | 點一條賽道，在出發面板選「大獎賽」再按開始。 / button 在目前賽道開大獎賽… / in a room: 大獎賽的圈數、輪胎損耗和電腦車手在房間大廳設定。 |
| lobby title | 房間大廳 |
| address | 位址 <addr> ‧ 複製 (copied: 已複製位址) ‧ 有密碼; guest: 已連線到 <addr> |
| leave | 離開房間 |
| players title | 玩家（n 人 + 電腦 m，k / 16） / 玩家（n / 16） |
| row tags / states | 房主 ‧ 你 ‧ 準備好了 ‧ 還沒準備 ‧ AI; loading: 載入中… ‧ 已載入 ‧ 載入失敗 |
| bots line | 電腦車手 ×m（<level>）：names… |
| settings title / guest note | 房間設定 ‧ 由房主設定 |
| track row | 還沒選賽道 ‧ 選賽道 / 換賽道 (host) ‧ 你的版本沒有這條賽道（<id>），請更新遊戲。 |
| picker banner | 點一張卡片設成房間的賽道（不會馬上開始）。 ‧ ← 返回大廳; fresh room: 房間已建立。先幫房間選一條賽道（點卡片不會馬上開始）。 |
| your settings | 你的設定 |
| host action | 開始 ‧ sub: <mode> ‧ k / n 已準備 (alone: 只有你一個人，可以直接開始) ‧ disabled without a track: 先選賽道 |
| host force | 不等了，直接開始 ‧ confirm: <names> 還沒按準備。仍要開始嗎？他們也會一起載入賽道。 [仍要開始] [再等等] |
| guest action | 準備 / 已準備 ✓（再按一下取消） ‧ status: 等待房主開始… / 等待其他玩家準備（k / n） |
| ready cleared | 房主改了賽道（賽季／模式），請再按一次「準備」。 |
| pulled in unready | 房主開始了：你還沒按準備，也一起載入。 |
| loading | 載入賽道中… ‧ 等待其他玩家載入… ‧ 最多再等 N 秒 ‧ 不等了，開始 ‧ 取消，回到大廳 ‧ 排位賽即將開始… |
| own load failed | 你的版本沒有這條賽道（<id>），請更新遊戲。這一場你在大廳等。 |
| nobody loaded | 沒有人載入成功，回到房間大廳。 |
| session started | 自由練習開始 / (Grand Prix: today's 大獎賽開始：排位 n 圈，正賽 m 圈) |
| session banner | 自由練習中 ‧ 大獎賽進行中：排位賽 / 起跑 / 正賽 / 成績 |
| back to lobby | host button 回到大廳 ‧ confirm 要結束這場大獎賽並回到房間大廳嗎？ [回到大廳] [取消] ‧ guests' toast 房主回到房間大廳 |
| results (room) | 再來一場 / 回到大廳 / 關閉 ‧ guests: 等待房主選擇再來一場或回到大廳 |
| host status (多人連線 tab) | 房間已建立，你是房主。在房間大廳選賽道和設定，大家準備好就按「開始」。 ‧ dedicated: 你是房主（第一位進房的玩家）。在房間大廳選賽道和設定，大家準備好就按「開始」。 |
| guest status | 已加入房間。選好車就按「準備」。 |
| new host | 你現在是房主：可以設定房間並按「開始」 |
| host closed | 房主關閉了房間，已回到單人模式 |
| nostart | track: 先選一條賽道 ‧ busy: 太快了，請稍等一下再按開始 ‧ not-ready: 還有玩家沒準備 ‧ load: (above) |
| version | old server: 房間的遊戲版本比較舊（F1Drive v7.1 以前），請房主更新到 v7.2 以上。 ‧ newer server: 你的遊戲版本比較舊，請更新後再加入。 ‧ other: 遊戲版本與房間不同，無法加入。 |

A text that names a button quotes it with 「」 (請再按一次「準備」。). Use full-width punctuation (，。：？（）) as everywhere
else in the game. 「位址」, 「設定」, 「伺服器」 and 「連線」 are the Taiwan forms already used in the menu.

## 11. Edge cases

- **Host picks a track his guests do not have** (a newer version with the same protocol). Guests see the id and the
  warning in the lobby, and their 準備 is disabled (「無法準備：你的版本沒有這條賽道」). If the host forces the start, they
  report `loaded {ok: false, why: 'no-track'}`, stay in the lobby view during the session, and are out of that session.
- **Rapid start -> back -> start**: every `loaded` carries the rs; stale ones are ignored. A client that is still
  building the old track replaces the pending build (`loadTrack` already lets a later pick replace a waiting one) and
  reports only for the newest rs.
- **back while a client is mid-build**: the build finishes, but the client stays in the lobby view and reports nothing.
- **The host's 取消 / 不等了 / 回到大廳 within 1 s of the last transition** (lobby review LOBBY-1): the server drops a go /
  back / gp end inside `START_MIN_MS` without an answer, so js/main.js holds such a click for the rest of that second and
  then sends it. **A double click on 開始 over a slow link** (LOBBY-2): one start goes out until its answer.
- **Host alone**: 開始 is enabled at once; the barrier waits only for him.
- **Everybody in `wait` leaves**: the barrier completes. If `done` is empty, the room returns to the lobby (`nostart load`).
- **Host never presses anything after the results**: the room stays in results. Players may leave; the idle kick is
  unchanged because the game pings every 10 s.
- **Guest presses 準備 then changes his car**: he stays ready (his own action). The host changing track, season or mode
  clears it.
- **Year change in the lobby**: guests' cars follow the new season (today's toast 「房間是 Y 賽季：你的車換成 …」) and
  their ready is cleared.
- **A player whose window is minimised during loading** (Electron: not throttled; the browser build: timers throttled):
  the 20 s timeout covers it, and he joins late.
- **Host's in-game window reloads** (Ctrl+R in a dev build): `net/host.js` drops the server and the room closes, as today.
- **Reconnect**: a dropped guest who joins again is a new player (new id, not ready). During a session he follows the
  join rules.
- **Pad A held while 開始 is pressed**: the race starts with A held = battery deploy, which is harmless. Edges are taken
  from the menu poll, so a press is never counted twice.
- **Enter in the room lobby while typing a name** (多人連線 tab field): the field gets it. Enter starts nothing.

## 12. What every existing harness must change

Every harness keeps its checks; only the path to the track or the session changes. The common helper becomes: click the
card, then click `#setup-go` (or press Enter: `#setup-go` has focus), then wait for `F1.game.running` as before. For a
Grand Prix: card, `#setup-mode [data-m="gp"]`, set `#gp-q` / `#gp-r` / `#gp-wear` / `#gp-bots` (now in the setup view,
same ids), then `#setup-go`. In a room: create / join, host `#setup-track-btn` + card (or `F1.net.setRoom({track})`),
guests `#setup-ready`, host `#setup-go`, then wait for `F1.net.room.st === 'session'` (and `F1.game.running`).
`#gp-start` and `#gp-setup` no longer exist.

### Card click -> driving (single player)

| Harness | Change |
| --- | --- |
| `devtests/integration/shot.js`, `keys.js` | `#setup-go` after the card |
| `devtests/review/e-main.js`, `e-fps.js`, `e-blur.js` (v1 review scripts, numbers to read) | `#setup-go` after each card (e-main: six track switches) |
| `devtests/car-v6/game-check.js`, `cockpit-test/shots.js`, `gamepad-test/game-map.js`, `handling-test/bank-shots.js` | `#setup-go` after the card |
| `devtests/hudmirrors-test/run.js`, `tunnel-test/run.js` (`pickTrack`) | same |
| `devtests/pit-test/shots.js`, `scenery-pit/facade.js`, `scenery-pit/shots.js`, `track-fix/shots.js`, `track-audit/perception/shots.js` | same |
| `devtests/v6-critic/lib.js` `pickTrack` / `pickTrackWarp` (used by `v6-critic`, `v61-critic`, `v62-critic`) | `#setup-go` after the card (warp: the loop starts after 開始) |
| `devtests/v6-smoke/smoke.js` `pickTrack` + the raw card clicks (around lines 365, 420), `app-check.js` | same |
| `devtests/gp-e2e/lib.js` `w.pick` (online, online-v6, start-clock, bench, bots) | solo use: `#setup-go`; room use: see below |
| `devtests/gp-smoke/smoke.js` `w.pick` + the "another track" card clicks (around lines 376, 912) | solo: card -> panel (the GP warning shown) -> 開始 ends the Grand Prix; part `free` "menu: Grand Prix panel asks for a track first" -> the 大獎賽 tab's new text |
| `devtests/gp-e2e/solo.js` | card + `#setup-go`; "another track mid-race" -> card, panel, 開始 (the warning line checked) |
| `devtests/gp-e2e/solo-v6.js` | "the same track card clicked again: car back on the start" -> card (目前賽道), 重新開始 |
| `devtests/ui-gp/shots.js` (part `real`), `ui-v6/shots.js` (mock `onSelectTrack`, part `real`) | the mock now expects `onSelectTrack` on a card click and `onSetupStart` on 開始; part `real` clicks 開始 |
| `devtests/bots-test/game.js` (`w.pick`), `gp-e2e/bots.js` | card + bots set in the setup view (`#gp-bots`, `#gp-skill`) + `#setup-go`; part `panel` (count changes while driving): Esc, card of the current track, change bots, 繼續駕駛 |
| `devtests/exe-smoke/smoke-exe.js` | card + `#setup-go`; the Grand Prix: Esc, card (目前賽道), mode 大獎賽, `#gp-bots` 5, `#setup-go` (no `#gp-start`) |
| `test/main.test.js` (menu owner), `devtests/bots-test/node-race.js` | `U.opts.onSelectTrack(td)` then `U.opts.onSetupStart({mode, q, r, wear})`; the stub `F1.ui` gains `setSetup`, `setRoomLoading`, `getSetup` |

### Grand Prix panel (moved to the setup view)

`gp-smoke` (solo / lap / pad parts), `v6-smoke` (`tyres`), `v6-critic` (`tyres`), `v61-critic` (`gp`), `v62-critic`
(`silver`: a Grand Prix on softs), `gp-e2e/solo.js`, `solo-v6.js`, `bots.js`, `bots-test/game.js`, `exe-smoke`: set the
mode and fields in the setup view and press `#setup-go` instead of `#gp-start`. `ui-gp/shots.js` (menu panel mocks) and
`ui-v6/shots.js` (輪胎損耗 in the 大獎賽 tab): the setup controls are checked in the setup view. The 大獎賽 tab keeps its
session part (state, standings, skip / end / again, `#gp-tyre`, `#gp-car`). `gp-e2e/page.js` (its panel recorder reads
`gp-setup` / `gp-start`) reads the setup view. `gp-e2e/mutants/*.js` are copies of the old `js/main.js` / `js/ui.js`:
regenerate them with `node devtests/gp-e2e/make-patched.js` after the build.

### Rooms (protocol 2 and the lobby)

| Harness | Change |
| --- | --- |
| `devtests/integration/mp-e2e.js` | Host card click no longer loads: lobby flow (picker, 準備, 開始, barrier). "B clicking a card does nothing" -> B sees the lobby, no cards. "both loaded the same track and are driving" -> after the barrier. "track change by host is followed by B" -> 回到大廳, another track, 開始. "B in menu: still visible to A" / "B resumes with Esc" -> the room menu (session). Disconnect parts unchanged. C (browser mode) single player: card + 開始. |
| `devtests/integration/smooth.js`, `smooth2.js` | the observer's raw `hello` -> `v: 2`; A's card click -> lobby start (B ready or force) |
| `devtests/gp-e2e/online.js`, `online-v6.js` | Settings (track, season 2014, Q / R / wear) set by the host in the lobby; guests pick cars and press 準備; 開始 + barrier. "host clicks 開始大獎賽" -> lobby 開始 with mode 大獎賽. "結束大獎賽 -> free practice for all four, setup back" -> results -> 回到大廳 -> lobby. "new Grand Prix with 跳過排位" -> from the lobby. "D (left the room) ... panel offers a start" -> card -> setup view. The 90 s close is unchanged; after it the host chooses. A spectator joining mid-race is unchanged. |
| `devtests/gp-e2e/start-clock.js` | each of the six starts: lobby 開始 (mode 大獎賽, Q 1) + barrier; between rounds 回到大廳 or 再來一場 |
| `devtests/gp-e2e/bots.js` (`room`, `host` parts) | bots set by the host in the lobby; 開始 + barrier; dedicated server: the first joiner is host, lobby flow |
| `devtests/gp-smoke/smoke.js` (`room`, `spec`), `gp-smoke/grid-shots.js` (`F1.net.selectTrack` -> `setRoom({track})` + `startRoom({len, force: true})`, wait for `room.st === 'session'`) | lobby flow; a late joiner during the grid is a spectator as before |
| `devtests/v6-smoke/smoke.js` (`room`), `v6-critic/critic.js` (`room`: the host changes the year -> in the lobby; a guest reconnecting mid-race -> late joiner), `v61-critic/critic.js` (`room`) | lobby flow |
| `devtests/bots-test/game.js` (`room`) | lobby flow, bots set in the lobby |
| `devtests/net-gp/electron-net.js`, `electron-bots.js`, `electron-v6.js`, `electron-host.js` (net owner) | `selectTrack` -> `setRoom` + `startRoom` + `sendLoaded`; `gp('start')` -> false; year in the lobby |
| `devtests/net-gp/fuzz-server.js` (net owner) | `hello v: 2`; the new messages (set / ready / start / loaded / go / back) in the random mix; `track` no longer used; every `room` message must be well-formed |
| `devtests/gp-test/net-glue.js` | the fake server speaks v2 (`welcome.room`, `room` messages; no `gp start`) |
| `test/server.test.js`, `test/gp.test.js` (net owner) | v2 hello, lobby, every new message incl. the hostile ones of section 7 |

Not regression tests, so no change: `review-r3/`, `review-final/`, `review-1/` (they assert old states by design).

## 13. Acceptance checks (devtests/lobby-test, E2E stage)

Muted offscreen windows only; read the screenshots.
- **Room, host + 2 guests (in-game server)**:
  1. After create / join, nobody has a track running (`F1.game.running === false` everywhere) and all three see the same
     roster and settings.
  2. The host picks track, season, mode, Q / R / wear and bots. Guests see each change within 0.5 s. A guest's `set`
     changes nothing.
  3. Guests pick cars and press 準備; ready shows on all windows. The host's 開始 is enabled only when all are ready.
     「不等了，直接開始」 with its confirmation works.
  4. All three load, the barrier holds: no window drives and the server accepts no `s` before `room.st === 'session'`.
     The session starts on all windows within one tick of each other. Grand Prix: qualifying begins after the barrier
     (`snapshot.sid` changes only then).
  5. A Grand Prix with bots runs to the results. Then 回到大廳 (everybody in the lobby, ready cleared) and 再來一場
     (qualifying again, same track).
  6. A latecomer joins during the race (spectator), then goes to the lobby with everybody.
  7. The host leaves in the lobby and during loading (guests back to single player with the toast). A guest leaves
     during loading (the barrier completes without him).
- **Dedicated server** (`createServer` without a token): the first joiner is host. Host migration happens in the lobby
  and during loading. The settings survive and the new host can start.
- **Protocol**: a raw `hello {v: 1}` gets `error version need 2`. A 7.2 page against a v1 stub server shows the
  old-server text.
- **Single player**: card -> panel -> 開始 by mouse, by Enter, and by pad A (fake pad). Esc and pad B go back to the
  cards. Nothing drives before 開始. Free practice and a Grand Prix with bots start from the panel. 重新開始 on the
  loaded track does not rebuild it (`F1.game.track` is the same object).
- **Layouts** at 1280x720 / 1920x1080 / 1100 / 1000 / 800 / 700 / 480 px: section 9's checks.

## 14. Out of scope and known limits

- Choosing a track card with the controller (A and B work in the panel and the lobby, not on the card grid).
- Chat, kicking players, host hand-over on an in-game server (the room still dies with its host).
- Transferring computer drivers to a new host mid-session (unchanged from v7).
- The tyre puncture at Spa ("RB19 x1, lap 2"): the parallel tyre branch of this workflow.
