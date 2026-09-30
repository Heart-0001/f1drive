---
name: f1drive-resume-state
description: "F1Drive game — where work was paused on 2026-09-30 and that the full handoff lives in the repo's CLAUDE.md on GitHub"
metadata:
  node_type: memory
  type: project
  originSessionId: 77b8c77e-7ecb-4df1-87bf-be9fc0f46612
  modified: 2026-09-30T09:40:33.310Z
---

F1Drive (C:\Users\user\Desktop\f1drive): Electron + Three.js r149 first-person F1 game, 40 real circuits with elevation, OSM scenery, racing line, multiplayer, gamepad module.

Paused on 2026-09-30 (user shut down, will continue from ANOTHER computer). Everything was pushed to a new private GitHub repo `Heart-0001/f1drive`. The authoritative, detailed state and remaining-work list is `CLAUDE.md` in the repo root; this memory is only a pointer.

**Why:** the user switches machines; memory under ~/.claude does not travel, the repo does. A copy of this memory folder is in `docs/claude-memory/`.

**How to apply:** on resume, read `CLAUDE.md` and `js/README-interfaces.md`. Remaining: wire gamepad into main.js/index.html; finish Grand Prix mode (partial `net/session.js`, `js/laps.js`, server/net edits from a stopped agent); `npm run dist`; second Fable review (see [[f1drive-workflow-preferences]]).
