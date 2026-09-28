# CONTINUITY — YAZ-1990 Canvas panel remembers what you were doing

Parent issue: [YAZ-1990](https://linear.app/growprofit/issue/YAZ-1990). The 🔒 comments there hold every decision and the 19-scenario list.

## Goal

Closing and reopening the canvas panel leaves the Images tab (query, results, loaded pages, view, per-view scroll) and the Components tab (list, query, rows loaded, scroll) exactly as they were, for the life of the app; a restart starts empty. Done when 1A–3B are Done, `npm test` + `npm run typecheck` are green, and the branch is merged to main (no release).

## Constraints

- No Playwright runs, by agents or locally; behavior is proven with vitest/jsdom and a dev-app checklist Yasin runs.
- No release unless Yasin asks.
- Commit through the `/commit` skill (no attribution trailers).

## Key Decisions

- **🔒 D0:** in-memory only; an app restart starts fresh.
- **🔒 D1:** one module-scope session per window, shared by every drawing tab.
- **🔒 D2:** `image-studio/imageStudioSession.ts` owns the state AND `runSearch` (the request id and cursors live at module scope, so no stale-closure race).
- **🔒 D3:** each Images view keeps its own scroll offset (a plain module object, never rendered).
- **🔒 D4:** ⌘F focuses the search box and selects the kept query.
- **🔒 D5:** the Components tab gets the same treatment; Presentation is out.
- **Agent fix:** ⌘F's surface counter becomes a one-shot `searchFocusPending` flag, per surface.

## State

- Done:
  - [x] 0: Deep scope (YAZ-2155)
  - [x] 1A: session module (YAZ-2157)
  - [x] 1B: Images tab on the session + per-view scroll (YAZ-2158)
  - [x] 1C: ⌘F one-shot flag + select (YAZ-2159)
  - [x] 1D: Components tab (YAZ-2160)
  - [x] 2A: full run, scenario map, REGRESSION.md P4/F87 (YAZ-2162)
  - [x] 3A: audit (YAZ-2165)
  - [x] 3B: apply the audit (YAZ-2166)
- Now: [→] 2B: dev-app checklist for Yasin (YAZ-2163)

## Learnings

- `ExcalidrawSurface` has no unit test (DrawingEditor mocks it), so the ⌘F open-only rule is proven by hand (REGRESSION P4).
- The per-view scroll restore is exact only because tiles are a fixed 112 px and the rows come from the session on the first render; variable-height tiles would need a different restore.

## Open Questions

- None.

## Working Set

- Worktree: `/Users/yasin/Documents/GitHub/yaseen-draw-app-yaz-1990`, branch `yaz-1990-panel-memory`.
- Files:
  - `client/src/image-studio/{imageStudioSession.ts,ImageStudio.tsx}`
  - `client/src/drawings/{ExcalidrawSurface.tsx,CanvasSidebar.tsx}`
  - `client/src/components-library/SavedComponents.tsx`
  - `docs/CONTRACTS.md`, `docs/REGRESSION.md`
- Tests: `npm test`, `npm run typecheck`.
