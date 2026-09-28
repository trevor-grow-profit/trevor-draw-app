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
- Parked for Yasin: 3B locale trim (D3, YAZ-2087 — changes `Intl` / sort on non-English Macs) and
  5B1 off-thread full-res decode (D5, YAZ-2126 — RSS 211 → 1,863 MB on 3×121-image tabs).
- Declined: #12050 (≈0% dark-mode drag gain, visible handle colour change) and #12063 (D18); 2G
  force-kill of Chromium's helpers after quit.
- 5C thumbnails accepted with a softness flag (tiny text in a 121-tile grid a little lighter).

## State
- Done:
  - [x] 0 Deep scope (YAZ-2074)
  - [x] 1 Safety net: 1A budget gate, 1B perf harness, 1C Playwright suite + REGRESSION.md, 1D glue tests
  - [x] 2 Reliability: 2A 2B 2B1 2C 2D
  - [x] 3/4 Size and launch: 3A 3C 3D 3E 4A 4B (3B parked)
  - [x] 5 Smoothness: 5A 5B (5B1 parked) 5C 5D 5E 5F 5G 5H 5I 5J
  - [x] 6 Refactors: 6A 6B 6C 6D
  - [x] 7C demo vault + isolated dev app
  - [x] 8A audit
  - [x] 2E 2F 2G (found by the e2e suite), 5F1 FSEvents ready probe
  - [x] 7A before/after + ratchet, 7B packaged pass, 8B audit applied (all lanes merged)
- Now: [→] Yasin reviews: push fork yaz-2073-perf, OK mainBundleBytes raise, decide 3B/5B1, eyeball 5C, try the demo
- Next: after Yasin's OK — push fork branch, merge `yaz-2073-speed` to main (no release), clean worktrees + Desktop demo

## Open Questions
- Needs Yasin: push fork branch `yaz-2073-perf` @ 759e7dfd (and fast-forward the fork's main)
  before the app merges — `client/vendor/README.md` says the tarballs come from the public fork.
- Needs Yasin: raise the `mainBundleBytes` ceiling (285,442 → ~356 KB: the bundled chokidar
  fallback plus 5F/6A) — the ratchet says raising needs his OK.
- Needs Yasin: eyeball the 5C preview softness (before/after PNGs in commit `cb1f5a2`; reverting
  `a8388a6` alone restores the old look).
- Needs Yasin: land or drop 3B (branch `yaz-2073-parked-3b-locale-trim`) and 5B1 (fork branch
  `yaz-2073-parked-5b1-bitmap-decode`; recommended: a byte-budgeted bitmap cache).
- Latent FSEvents reopen race in the watcher: follow-up issue to be created by the lead.

## Working Set
- Integration worktree: `/Users/yasin/Documents/GitHub/yaseen-draw-app-yaz-2073` (branch `yaz-2073-speed`)
- 8B worktree: `../yaseen-draw-app-yaz-2073-8b-main` (branch `yaz-2073-8b-main`, all three 8B code lanes merged)
- Engine fork worktree: `/Users/yasin/Documents/GitHub/yaseen-excalidraw-yaz-2073` (branch `yaz-2073-perf` @ 759e7dfd, on no remote yet)
- Tests: `npm test`, `npm run typecheck`, `npm run e2e`, `npm run perf:budget`, `npm run perf -- <scenario>`
- Flaky under heavy load, pass alone: e2e external-change reloads (`autosave`, `boardDocument`)
  at 4+ workers; `tools/dmg.test.mjs` hardened in 8B (retrying detach, 180 s, one retry).
