# CONTINUITY — YAZ-1999 name-first board birth + "New dated Excalidraw drawing"

## Goal
- Right-click → New dated Excalidraw drawing → inline box seeded `MM_DD- ` → type → Enter creates + opens. Every board item is name-first; no `Untitled` births. Merged to main, Linear Done, no release.

## Constraints
- LOCKED D1–D6 + S1–S18: comments on YAZ-1999.
- No Playwright, by anyone. Hand pass by Yasin on `YASEEN_DRAW_USER_DATA_DIR`.
- No release cut (Yasin batches releases).

## Key Decisions
- D1 name-first for every board (reverses YAZ-1775 R1) · D2 Excalidraw only · D3 dated item under "New Excalidraw drawing" · D4 Rename unchanged · D5 draw.io name-first too · D6 `EntryKind = FileKind | 'dir'`.

## State
- Done:
  - [x] 1- Scope (YAZ-2029)
  - [x] 2A-2D- Build + CONTRACTS.md (YAZ-2031..2034) — 2505 tests green, typecheck clean
  - [x] 3- Hand pass S1–S18 (YAZ-2035) — Yasin: "all good"
  - [x] 4A- Audit (YAZ-2037) — comment-only, 2 fixes, 2 declined
  - [x] 4B- Apply, merge, cleanup (YAZ-2038) — comments fixed, ledger closed, rig + worktree removed
- CLOSED 2026-09-27.

## Open Questions
- none

## Working Set
- Worktree `../yaseen-draw-app-yaz-1999`, branch `yaz-1999-dated-drawing`
- `npx vitest run` · `npm run typecheck`
