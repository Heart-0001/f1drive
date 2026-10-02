---
name: f1drive-github-release
description: F1Drive — the user now wants finished rounds pushed to GitHub and published as a release with the exe (plays on a laptop)
metadata:
  type: feedback
---

From 2026-10-01 ~22:00 the user asked: "最後好了幫我丟github吧 讓我筆電可以玩 或是你現在先丟一版目前最新的release上去 我想玩". This replaces the earlier "commit 就好, do not push".

**Why:** they want to play the game on their laptop, so the exe has to be downloadable from GitHub (repo Heart-0001/f1drive, PUBLIC since 2026-10-02; history rewritten to remove personal e-mail addresses — never put the user's e-mail in files, commits or requests).

**How to apply:** when a round is finished and verified, push main and publish a GitHub release (gh release create with a tag pushed first; --target with a bare sha fails with 422) whose asset is the portable exe built from a clean worktree of that commit, with release notes in Traditional Chinese. Never push or release unverified WIP. v6.1 was released this way (tag v6.1, prerelease). See [[f1drive-resume-state]] and [[f1drive-workflow-preferences]].
