# Locked Linear tree for YAZ-2073 (Speed & Optimization). Parent issue YAZ-2073; existing child YAZ-2074 "0-Deep Scope (initial)".
Decisions D1–D18 are in the YAZ-2074 comment "Deep scope, 2 of 3" (text in $SCRATCH/c2-decisions.md). Findings in $SCRATCH/findings/*.md.
Worktree: /Users/yasin/Documents/GitHub/yaseen-draw-app-yaz-2073 on branch yaz-2073-speed. No push/merge/release until Yasin confirms.

1- Build the safety net and baselines
  1A- Size and integrity budget gate + frozen v0.1.11 baseline  (feature-safety-net E1/E2, size-forensics #8, discipline #10; D17 ratchet; CI step --out-only)
  1B- Perf harness: launch, draw.io open, drag/pan/zoom frame time, hover preview, tree storm — with baseline numbers  (renderer-bundle #4, renderer-smoothness #9, main-process storm bench, discipline #4/#6; fixtures 1k/4k elements + 121-image board + 2k-board vault)
  1C- Playwright E2E suite over the feature inventory + docs/REGRESSION.md  (D17: Yasin overrides YAZ-1805 OD1; Playwright _electron, isolated userData, seeded demo vaults; feature-safety-net inventory + E3)
  1D- Backfill tests for untested glue: startup order, scheme privileges, engine selector pin, watcher, ConflictBar, SaveIndicator, diagram IPC, share viewer  (feature-safety-net E6/E7/E8, code-health #15)
2- Fix the reliability bugs the scope found
  2A- Restore the quit flush through a tested runQuitSequence  (D11; main-process F2; also last-150ms state flush)
  2B- fsync every atomicWrite, landAssets included; secrets tmp opened 0600  (D12; main-process F4)
  2C- Fix the watch subscribe/unsubscribe race  (main-process F8)
  2D- Windows-safe path containment and file links (fixes double-click open and Add favorite on Windows)  (code-health R6 / #4)
3- Make the app smaller
  3A- Build the DMG with LZMA (ULMO)  (size-forensics F1; −33.6 MB)
  3B- Trim Chromium locale paks in afterPack, keep the app .lproj folders  (D3; −48.7 MB installed)
  3C- Ship the Excalidraw fonts once: share setup reads the app's copy  (size-forensics F2/F5/F7, code-health R1, feature-safety-net E9; −13.7 MB)
  3D- Minify the renderer; keep hidden sourcemaps outside the app  (D14; −5.3 MB)
  3E- Really bundle chokidar; fix the stale comment and CONTRACTS; assert no node_modules in the asar  (size-forensics F6)
4- Make it launch and open faster
  4A- Turn on the V8 code cache for app://  (D13)
  4B- Start loading the engine at boot for drawing windows  (renderer-bundle C3)
5- Make the canvas and sidebar smoother
  5A- Bring upstream Excalidraw perf fixes into the fork (no visual changes)  (D18; audit result pending — fill from $SCRATCH/findings/engine-upstream-perf.md if it exists, else say "audit in progress, see comment")
  5B- Engine: decode images off the UI thread (full-res ImageBitmap) + fork hygiene, one repack  (D5; renderer-smoothness F1-A; renderer-bundle C4)
  5C- Preview-sized thumbnails in main + lean legacy-board load  (D6, D7; renderer-smoothness F1-B/F2)
  5D- Sidebar render isolation: hover store, memo(Tree), resize without app churn, save chips via store  (D16; code-health R4/R5; renderer-smoothness #4/#6)
  5E- Coalesce tree refresh: one walk per root at a time + renderer debounce  (D10; main-process F1A/F1B)
  5F- Watcher engine: recursive fs.watch + conformance suite + bundled chokidar polling fallback  (D9)
  5G- Save path: one parse, one stringify; skip identical state-file writes; parallel quit flush across windows  (main-process F6/F9)
  5H- Lean idle sync poll  (main-process F7)
  5I- Investigate the 2.9 s first-pan gap on heavy image boards  (renderer-smoothness #8)
  5J- Memory: main-process heap audit, bound the Image Studio preview cache, idle-RSS budget  (runtime-shell #4, code-health R10)
6- Refactor for less code (feature-neutral)
  6A- IPC contract as data: one table in shared/ipc.ts generates preload and renderer wrappers  (D16; code-health AD1/R2, #5/#6)
  6B- useBoardDocument hook + shell for both editors; unify fs/boardDocument  (D16; code-health R3/#7/#8/#12)
  6C- Split Sidebar.tsx into feature hooks  (code-health #9)
  6D- Request-validation helpers, a seed kit for tools, small hygiene  (code-health #11/#13/#14)
7- Verify end-to-end
  7A- Full before/after run: unit, Playwright, perf harness, budget gate; publish the before/after table
  7B- Packaged-app pass: DMG install, launch, locales, share setup, draw.io, fonts offline, Windows build
  7C- Demo vault "Speed & Optimization" on the Desktop + dev app in an isolated profile for Yasin
8- Polish and anti-slop pass
  8A- Audit the change set and scope the polish (comment only)
  8B- Apply the audit: simplify, finalize, docs, ledger, cleanup

Future issues (Backlog, project "Yaseen Draw App", no parent; each links YAZ-2073/YAZ-2074):
- Future: WebKit readiness spike before ever reconsidering Tauri  (runtime-shell AD-1 option 4 checklist)
- Future: Incremental TreeIndex in main  (D10; trigger: vault walk >100 ms or >10k files)
- Future: V8 startup snapshot  (D15; trigger: launch budget still missed)
- Future: Engine vendoring model (prod-only tgz + Git LFS, or private registry)  (code-health AD4)
- Future: React Compiler spike for the client  (code-health AD3 option 2)
