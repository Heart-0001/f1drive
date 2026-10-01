---
name: f1drive-autonomous-runs
description: The user leaves F1Drive work running unattended (overnight) and expects it to keep going without check-ins; watchdog and plan file exist
metadata:
  node_type: memory
  type: feedback
  originSessionId: c2c193e6-e2b5-4b48-8955-beed8746e07e
  modified: 2026-09-30T16:43:56.806Z
---

On F1Drive the user goes to sleep mid-session and wants the work to continue unattended: on waking they expect either the finished `dist/F1Drive.exe` or the work still visibly in progress. Do not stop to ask; take sensible defaults, record them, and report them afterwards.

**Why:** said on 2026-10-01: "我要去睡覺了 我需要醒來的時候可以看到完整的exe 或是持續在進行 … 需要的權限甚麼都給你 切記不要停下來 朝著目標做就好", and they asked for a tool that detects unexpected stops / long stalls so the cause gets looked at.

**How to apply:** keep the durable plan and state in `docs/v6-plan.md` (stages, run ids, decisions taken on the user's behalf) and update it as stages finish; use `node tools/watchdog.mjs` (exit 2 = stalled agent, 3 = nothing running) plus a session cron "watchdog tick" and `tools/keepawake.ps1` (keeps Windows awake) for long runs. Commit / push still only when the user asks. See [[f1drive-workflow-preferences]] and [[f1drive-resume-state]].
