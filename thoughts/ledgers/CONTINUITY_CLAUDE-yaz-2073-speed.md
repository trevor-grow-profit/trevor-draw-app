# Continuity ledger — YAZ-2073 Speed & Optimization

## Goal
- Make Yaseen Draw smaller, faster, smoother and more reliable with **zero feature loss** and **no visible/behavior change**; stay on Electron.
- Done = every subissue of YAZ-2073 Done, per-dimension targets met or explained (targets table: YAZ-2074 comment "Deep scope, 1 of 3"), unit + Playwright + budget gate green, demo vault + isolated dev app ready for Yasin. No push/merge/release until Yasin confirms.

## Constraints
- Locked decisions D1–D18: YAZ-2074 comment "Deep scope, 2 of 3".
- Yasin overrode YAZ-1805 OD1: Playwright is allowed and expected for this project.
- Never run the app against real vaults/userData; isolated profiles + seeded demo vaults only.
- Commits without Claude attribution; no push.

## Key Decisions
- Status of every decision (shipped / kept / parked / declined): `thoughts/yaz-2073-scope/decisions.md`.
- Stay on Electron (D1); 10× means per-dimension targets, gated in `tools/perf/budget.json` (D2).
- Looks and behavior stay identical: animations kept (D4), every visited tab stays mounted (D8).
- 3B locale trim (D3, YAZ-2087) landed on Yasin's OK (the app is English only): .app 367.5 → 319.9 MB,
  DMG 124.7 → 116.1 MB; on a non-English OS `Intl` / the Name sort are en-US (documented in CONTRACTS).
- 5B1 off-thread decode (D5, YAZ-2126): built twice, failed the gates both times, closed as tried. The
  budgeted cache is on fork branch `yaz-2073-5b1` (2d91e157, pushed): RSS 191 → 724 MB, long task
  329 → 140 ms, 86/90 export pixels. Follow-up idea: YAZ-2134 (pre-shrunk image copies).
- Declined: #12050 (≈0% dark-mode drag gain, visible handle colour change) and #12063 (D18); 2G
  force-kill of Chromium's helpers after quit.
- 5C thumbnails accepted with a softness flag (tiny text in a 121-tile grid a little lighter).

## State
- Done:
  - [x] 0 Deep scope (YAZ-2074)
  - [x] 1 Safety net: 1A budget gate, 1B perf harness, 1C Playwright suite + REGRESSION.md, 1D glue tests
  - [x] 2 Reliability: 2A 2B 2B1 2C 2D
  - [x] 3/4 Size and launch: 3A 3B 3C 3D 3E 4A 4B
  - [x] 5 Smoothness: 5A 5B (5B1 tried, closed) 5C 5D 5E 5F 5G 5H 5I 5J
  - [x] 6 Refactors: 6A 6B 6C 6D
  - [x] 7C demo vault + isolated dev app
  - [x] 8A audit
  - [x] 2E 2F 2G (found by the e2e suite), 5F1 FSEvents ready probe
  - [x] 7A before/after + ratchet, 7B packaged pass, 8B audit applied (all lanes merged)
  - [x] Yasin's review: fork pushed, mainBundleBytes raise OK'd, 3B landed, 5C OK'd, 5B1 closed
- Now: [→] Closeout: PR + merge to main (app and fork), release v0.1.12, clean worktrees
- Next: none for YAZ-2073. Follow-ups: YAZ-2133 (Playwright on CI/Lume), YAZ-2134 (pre-shrunk images),
  YAZ-2135 (fork duplicate element package), Futures YAZ-2117–2121.

## Open Questions
- None blocking. Launch → canvas (486 ms under load) still over the 450 ms target: re-measure on a quiet
  machine; if still over, Future YAZ-2119 (V8 snapshot) is triggered.

## Working Set
- Integration worktree: `/Users/yasin/Documents/GitHub/yaseen-draw-app-yaz-2073` (branch `yaz-2073-speed`)
- Engine fork worktree: `/Users/yasin/Documents/GitHub/yaseen-excalidraw-yaz-2073` (branch `yaz-2073-perf` @ 759e7dfd, pushed; merged into the fork's main at closeout)
- Tests: `npm test`, `npm run typecheck`, `npm run e2e`, `npm run perf:budget`, `npm run perf -- <scenario>`
- Flaky under heavy load, pass alone: e2e external-change reloads (`autosave`, `boardDocument`)
  at 4+ workers; `tools/dmg.test.mjs` hardened in 8B (retrying detach, 180 s, one retry).
