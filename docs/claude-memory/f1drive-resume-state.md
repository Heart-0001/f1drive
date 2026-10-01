---
name: f1drive-resume-state
description: "F1Drive game — where the repo lives, that the user moves between machines, and where the authoritative work state is (CLAUDE.md + docs/v6-plan.md)"
metadata:
  node_type: memory
  type: project
  originSessionId: c2c193e6-e2b5-4b48-8955-beed8746e07e
  modified: 2026-10-01T07:12:02.794Z
---

F1Drive (this machine: `C:\Users\Heart\Desktop\f1Drive`, cloned 2026-09-30 from the private GitHub repo `Heart-0001/f1drive`): Electron 44 + Three.js r149 first-person F1 game — 40 circuits, Grand Prix mode, gamepad, seasons 2010-2026 with each team's car (F1DB data), synthesised sound, pit lane / tyres / ERS, detailed cockpit.

Paused on purpose on 2026-10-01 15:10 (the user's weekly usage was full; they will say "continue"). The authoritative state and the resume steps are in `CLAUDE.md` ("State when paused") and `docs/v6-plan.md` ("PAUSED" section); workflow scripts and agent reports to relaunch from are in `docs/agent-runs/2026-10-01/`. Last fully verified commit e02cf43; a WIP commit on top holds the half-done v6.1 integration. Nothing pushed.

**Why:** the user switches machines and Claude sessions; memory under ~/.claude does not travel, the repo does (copy in `docs/claude-memory/`). Workflow run ids only resume inside the same session.

**How to apply:** on "continue", read CLAUDE.md and docs/v6-plan.md first, then finish v6.1 (glue + critic), then v6.2 (steering for Monaco's hairpin, banking / slope feel, Monaco tunnel, visible pad compound choice, track audit + data fixes, recalibration), then npm run dist + exe smoke + local commit. See [[f1drive-workflow-preferences]] and [[f1drive-autonomous-runs]].
