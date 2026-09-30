---
name: f1drive-workflow-preferences
description: "How the user wants F1Drive work run — many Opus subagents, then an independent Fable agent review at the end"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 77b8c77e-7ecb-4df1-87bf-be9fc0f46612
  modified: 2026-09-30T09:40:33.370Z
---

For the F1Drive project the user wants work delegated to Opus subagents (any number, in parallel) and, once everything is finished, a Fable agent to check it; after further feature rounds they asked for the Fable check again.

**Why:** stated explicitly by the user on 2026-09-30 ("你可以用任意數量的opus subagent 最後做完之後讓fable agent來檢查", later "做完之後再讓fable agent檢查一次").

**How to apply:** one owner per file with the contract in `js/README-interfaces.md`; don't skip the final Fable review before calling the work done; fix what it confirms and repackage. The user replies in Traditional Chinese. See [[f1drive-resume-state]].
