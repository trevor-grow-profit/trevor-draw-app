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
- Stay on Electron (D1); 10× means per-dimension targets (D2).
- Keep animations (D4); full-res ImageBitmap (D5); no LRU of mounted tabs (D8) — all to keep looks/behavior identical.
- Work split into per-wave branches merged into `yaz-2073-speed`.

## State
- Done:
  - [x] 0 Deep scope (YAZ-2074): 8 research angles + decisions + tree
  - [x] Phase 2 merged (2A 2B 2C 2D); 2B1 (YAZ-2122) found → p5-mem
  - [x] Phase 3/4 merged (3A 3C 3D 3E 4A 4B); 3B PARKED for Yasin (locale trim changes Intl on non-English Macs)
  - [x] Main-process smoothness merged (5E 5F 5G 5H)
- Now: [→] 1A/1B/1D (p1-net), 1C (p1c-e2e), 5A/5B engine (p5-engine + fork wt), 2B1/5I/5J (p5-mem), 5D/6C (p5-sidebar), 5C (p5-thumbs)
- Remaining:
  - [ ] Wave 3 — 6A IPC contract, 6B board document, 6C sidebar split, 6D hygiene
  - [ ] 7A/7B/7C verify + demo
  - [ ] 8A/8B polish

## Open Questions
- UNCONFIRMED: which upstream engine perf PRs the fork lacks (audit running).
- UNCONFIRMED: RSS impact of full-res ImageBitmap (D5 guard: +25% → escalate).
- Baselines measured while other agents build → re-measure before/after on a quiet machine in 7A.

## Working Set
- Integration worktree: `/Users/yasin/Documents/GitHub/yaseen-draw-app-yaz-2073` (branch `yaz-2073-speed`)
- Wave worktrees: `../yaseen-draw-app-yaz-2073-{p1-net,p1c-e2e,p2-reliability,p34-size-launch,p5-main}`
- Engine fork: `/Users/yasin/Documents/GitHub/yaseen-excalidraw` @ e72242f8 (read-only; work in a separate worktree)
- Tests: `npm test`, `npm run typecheck`, `npm run e2e` (after 1C), `npm run perf:budget`, `npm run perf -- <scenario>` (after 1A/1B)
- Flaky under heavy load (seen once at load ~130, passed on rerun): tools/dmg.test.mjs lzmaDmg (real hdiutil) → check in 8A
