---
name: f1drive-resume-state
description: "F1Drive game — where the repo lives, that the user moves between machines, and where the authoritative work state is (CLAUDE.md + docs/v6-plan.md)"
metadata:
  type: project
---

F1Drive (this machine: `C:\Users\Heart\Desktop\f1Drive`, cloned 2026-09-30 from the private GitHub repo `Heart-0001/f1drive`): Electron 44 + Three.js r149 first-person F1 game — 40 circuits (re-audited, lidar elevation), Grand Prix mode, gamepad, seasons 2010-2026 with each team's car, sound, pit lane / tyres / ERS, HUD mirrors, tunnels, Suzuka bridge, computer drivers (AI) offline and in rooms.

State 2026-10-03 05:45: v7.2 released (latest; room lobby, single-player start panel, tyre wear fixed); repo is PUBLIC (history rewritten to remove e-mail addresses). Nothing running; waiting for the user's next feedback.

**Why:** the user switches machines and Claude sessions; memory under ~/.claude does not travel, the repo does (copy in `docs/claude-memory/`). Workflow run ids only resume inside the same session.

**How to apply:** on "continue", read CLAUDE.md and docs/v6-plan.md first (they hold the live plan and every decision taken for the user). See [[f1drive-workflow-preferences]], [[f1drive-autonomous-runs]] and [[f1drive-github-release]].
