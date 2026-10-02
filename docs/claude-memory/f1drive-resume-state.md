---
name: f1drive-resume-state
description: "F1Drive game — where the repo lives, that the user moves between machines, and where the authoritative work state is (CLAUDE.md + docs/v6-plan.md)"
metadata:
  type: project
---

F1Drive (this machine: `C:\Users\Heart\Desktop\f1Drive`, cloned 2026-09-30 from the private GitHub repo `Heart-0001/f1drive`): Electron 44 + Three.js r149 first-person F1 game — 40 circuits (re-audited, lidar elevation), Grand Prix mode, gamepad, seasons 2010-2026 with each team's car, sound, pit lane / tyres / ERS, HUD mirrors, tunnels, Suzuka bridge, computer drivers (AI) offline and in rooms.

State 2026-10-02 ~09:30: v6.1, v6.2 and v7.0 are pushed and released on GitHub as prereleases (tags v6.1, v6.2, v7.0 with the portable exe). Fable review round 3 is done and pushed (541115e). Running: a follow-up on the AI pressing trade-off (docs/agent-runs/2026-10-01/scripts/wf-ai-press.js); after it: clean-worktree dist, exe smoke (incl. the v7 bot checks), commit, push, final release (v7.1).

**Why:** the user switches machines and Claude sessions; memory under ~/.claude does not travel, the repo does (copy in `docs/claude-memory/`). Workflow run ids only resume inside the same session.

**How to apply:** on "continue", read CLAUDE.md and docs/v6-plan.md first (they hold the live plan and every decision taken for the user). See [[f1drive-workflow-preferences]], [[f1drive-autonomous-runs]] and [[f1drive-github-release]].
