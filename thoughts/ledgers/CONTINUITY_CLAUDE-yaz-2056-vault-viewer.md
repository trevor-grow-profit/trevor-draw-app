# Continuity — YAZ-2056 vault viewer + sidebar fixes (port of Docs YAZ-1974, YAZ-2050, YAZ-1846 D2)

## Goal
- Port Docs' vault display names, one-line ⌘O rows with hover ⓘ, wider panel, ⇧⏎ open here + held-⇧ cue; search-row right-click menu; Files tab on a different-vault switch. Done = merged to main, S1–S48 pass by hand, vitest green, typecheck clean, docs true. No release.

## Constraints
- Linear YAZ-2056 pinned comments are the spec (🔒 inherited Docs decisions + YAZ-2056 D1–D7, S1–S48).
- No Playwright, ever. TDD. Code comments cite Docs D-numbers for inherited rules.

## Key Decisions
- D1 Files on vault switch · D2 `minWidth` beside `width` · D3 ported `components/TextField.tsx` · D4 Sharing page uses the display name · D5 pin `menu.lens` · D6 seven reveal-door items · D7 full CONTRACTS switcher section.
- 5A item 28 declined — cleanVaultName tests stay in store.test.ts (no shared test file)

## State
- Done:
  - [x] 1- Deep scope (YAZ-2058)
  - [x] 2- Build switcher (YAZ-2059)
  - [x] 3- Sidebar fixes (YAZ-2066, branch `yaz-2056-sidebar-fixes`)
  - [x] 4- Hand pass S1–S48 (YAZ-2069) — all good
  - [x] 5A- Audit (YAZ-2071) — 32 items, 31 do, 1 declined (28)
  - [x] 5B- Apply (YAZ-2072) — done with this commit
- Remaining:
  - [ ] Merge to main (YAZ-2072)
- CLOSED-READY 2026-09-27: close on merge.

## Open Questions
- UNCONFIRMED: ⇧ seen while the pointer is over the draw.io iframe (S36).

## Working Set
- Worktrees: `yaseen-draw-app-yaz-2056` (branch `yaz-2056-vault-viewer`), `yaseen-draw-app-yaz-2056-sidebar` (branch `yaz-2056-sidebar-fixes`).
- Tests: `npx vitest run`, `npm run typecheck`. Baseline 2505 green.
