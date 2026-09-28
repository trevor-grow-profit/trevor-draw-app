# CONTINUITY — YAZ-1989 Laser pointer changes

Parent issue: [YAZ-1989](https://linear.app/growprofit/issue/YAZ-1989). The 🔒 FINAL comment there holds the whole model, D1–D13 and the 24-scenario list.

## Goal

The laser (K) gets Fade / Hold / Sticky trails, colour and size, Keep (↵), Make permanent (⇧↵), Clear, Esc-clears, and its own undo that every undo control follows while the laser is out — from a laser bar in the contextual toolbar — with the three settings remembered as canvas prefs. Done when every YAZ-1989 child is Done, both repos' gates are green, the fork PR and the app PR are merged to their `main`s, and Yasin has passed the hand checklist (no release).

## Constraints

- No Playwright, no `npm run e2e`, no UI driver in subagents; behaviour is proven with vitest/jsdom and a dev-app checklist Yasin runs.
- The engine is the fork's build as-is (YAZ-868 D1/D2): laser code lives in `yaseen-excalidraw`, the app only re-packs it with `tools/packEngine.mjs`.
- No release unless Yasin asks. Commit through the `/commit` skill (no attribution trailers).

## Key Decisions

- **🔒 D1:** `laserTrailMode` / `laserColor` / `laserSize` are engine appState (`browser: true, export: false`) and `CanvasPrefs` keys of the same names; colours are the five presets only, on both sides.
- **🔒 D2/D3:** Fade (2 s, 100 points), Hold (5 s after the last activity, then a 2 s fade), Sticky; the mode is captured per stroke.
- **🔒 D5:** the bar is `[Fade | Hold | Sticky] · 5 swatches · S M L · ↶ ↷ · Keep · Make permanent · Clear`, full desktop panel only.
- **🔒 D6:** each stroke keeps its colour and size.
- **🔒 D7/D11:** the laser's own history of the sticky set; undo/redo actions route to it while the laser is active (keys, footer, bar).
- **🔒 D8/D9:** ↵ keeps what is visible; ⇧↵ turns it into grouped, selected freedraw (one board undo step).
- **🔒 D10:** marks are never persisted; Make permanent is the only way to keep one.
- **🔒 D12/D13:** switching tools keeps the marks; Esc on the laser clears them and selects V.
- **🔒 D14:** marks and laser history belong to the open tab; closing it or opening another board in it drops them.

## State

- Done:
  - [x] 0: Deep scope + live demo (YAZ-2214)
  - [x] 1A–1F: fork PR yaseenarshad/yaseen-excalidraw#19 merged → fork `main` `aaba056e` (YAZ-2215…2221)
  - [x] 2A: `packEngine --commit aaba056e`, tarballs `*-aaba056e.tgz` (YAZ-2223)
  - [x] 2B: prefs + engine parity test (YAZ-2224)
  - [x] 2C: keys reach the engine — code evidence + hand pass (YAZ-2225)
  - [x] 3A: gates — fork `yarn test:all` 2980 ✓; app `npm test` 2891 ✓, typecheck ✓, build ✓, `perf:budget:ci` PASS after a +908 B / +645 B ceiling raise for the prefs (YAZ-2227)
  - [x] 3B: seed + REGRESSION 1989-1…25 + LAUNCH; Yasin: "all passed" (YAZ-2228)
  - [x] 4A/4B: audit + polish (YAZ-2230, YAZ-2231)
  - [x] Merged: app PR yaseenarshad/yaseen-draw-app#19 → `ca21529`; released `v0.1.13` (`2babaee`); share-viewer ceiling +12 KB (`d3c551d`); installed on Yasin's Mac; worktrees and branches removed
- Remaining: none — YAZ-1989 closed; handoff comment on YAZ-1989

## Learnings

- Swapping the engine's `dist` by hand needs BOTH Vite caches cleared (`node_modules/.vite`, `client/node_modules/.vite`); a real `packEngine` bump changes the lockfile, so Vite re-optimises by itself.
- In the fork, a relative FOLDER import (`from "../.."`) resolves through `packages/excalidraw/package.json` `exports` to `dist/dev` whenever `dist` exists — two engines, two React contexts. Tests import `../../index` instead (1F).

## Open Questions

- None. (Edit › Undo from the menu bar calls Electron's native `webContents.undo()`, as it always did for the board; Yasin's hand pass accepted it.)

## Working Set

- Fork worktree: `/Users/yasin/Documents/GitHub/yaseen-excalidraw-laser`, branch `yaz-1989-laser`.
- App worktree: `/Users/yasin/Documents/GitHub/yaseen-draw-app-laser`, branch `yaz-1989-laser`.
- Fork files: `packages/excalidraw/{laserTrails.ts,animatedTrail.ts,components/App.tsx,components/Actions.tsx,components/LaserToolbarSection.tsx,actions/actionHistory.tsx,actions/manager.tsx,actions/types.ts,data/restore.ts,appState.ts,types.ts,index.tsx}`, `packages/common/src/constants.ts`, `packages/element/src/shape.ts`.
- App files: `shared/types/canvas.ts`, `shared/canvasPrefs.ts`, `client/src/drawings/{boardAppState.ts,canvasPrefsEngine.test.ts}`, `docs/CONTRACTS.md`.
- Tests: fork `yarn test:all`; app `npm test`, `npm run typecheck`, `npm run build`.
