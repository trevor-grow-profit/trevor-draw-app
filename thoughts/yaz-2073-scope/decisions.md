# YAZ-2073 decisions (D1–D18) and where each ended up

The docs cite these as "🔒 YAZ-2073 Dn". Yasin approved every recommendation on 2026-09-27 under
three guardrails: stay on Electron, nothing changes how a feature looks or works, and no
push/merge/release until he confirms. The full text with options and evidence is the YAZ-2074
comments ("Deep scope, 1–3 of 3"); the research behind them is in `research/`.

Baseline (v0.1.11, arm64): 371 MB installed, 172.5 MB DMG, launch → canvas ≈580 ms, draw.io open
782 ms, 14.7 MB unminified renderer JS, V8 code cache off, a 121-image hover preview froze the UI
108–168 ms, a 230-file tree storm cost main 33 s CPU / 3.16 GB. The per-dimension targets are the
ceilings in `tools/perf/budget.json` (D2).

| D | Decision | Status |
|---|---|---|
| D1 | Stay on Electron (not Tauri / Electrobun / Wails / native) | kept |
| D2 | "10×" means per-dimension targets, each a gate in `tools/perf/budget.json` | shipped (1A) |
| D3 | Trim Chromium's locale paks in `afterPack`, keep the app `.lproj` folders | shipped (3B, YAZ-2087) after a pause for Yasin's OK (2026-09-28: the app is English only): Mac framework `.lproj` 220 → 8 `en*` (48.7 → 1.1 MB), .app 367.5 → 319.9 MB, DMG 124.7 → 116.1 MB; Windows keeps `en-*.pak` (55 → 2). Known consequence: on a non-English OS, Chromium-drawn strings, `navigator.language` and the default `Intl` locale are en-US, so the sidebar Name sort collates as English and default-locale numbers read English; the app `.lproj` markers keep AppKit's Open/Save panels and menus in the OS language |
| D4 | Drawer and panel animations stay exactly as they are | kept |
| D5 | Off-thread `createImageBitmap` decode at full resolution in the engine fork, with a +25% RSS guard | **revised → closed** (5B1, YAZ-2126): full-res bitmaps took three 121-image tabs 211 → 1,863 MB RSS; a 512 MB byte-budgeted cache (fork `yaz-2073-5b1`, 2d91e157) still failed: RSS 191 → 724 MB, long task 329 → 140 ms (50 ms gate), 86/90 export pixels. Next idea: pre-shrunk copies (YAZ-2134) |
| D6 | Hover previews from preview-sized thumbnails made in main, cached per immutable asset in `userData/thumbs/` | shipped (5C), **accepted with a softness flag**: tiny text in a 121-tile grid reads slightly lighter (4.4/255 mean); reverting `a8388a6` alone restores the old look. The before/after PNGs are in commit `cb1f5a2` (`thoughts/yaz-2073-scope/5c-preview-compare/`), removed from the tree since |
| D7 | A legacy embedded-image board's load sends the image bytes once; no notice, no auto-shrink | shipped (5C, `d712c07`) |
| D8 | Every visited tab stays mounted (no LRU) | kept |
| D9 | Recursive `fs.watch` watcher behind a conformance suite; chokidar only as a bundled polling fallback | shipped (5F, 3E) |
| D10 | Coalesce tree walks (one per root + one trailing) and debounce the renderer; incremental `TreeIndex` is Future | shipped (5E) |
| D11 | Restore the quit flush through a tested `runQuitSequence` | shipped (2A); force-killing Chromium's helpers after it (2G) **declined** — 180 ms quit on a quiet Mac, the long tails only under extreme load |
| D12 | fsync on every `atomicWrite`, `landAssets` included; secrets tmp file 0600 | shipped (2B) |
| D13 | V8 code cache on for `app://` at Chromium's default location | shipped (4A) |
| D14 | Minify the renderer; hidden sourcemaps kept outside the app in `desktop/.maps/<version>/` | shipped (3D) |
| D15 | Keep as-is: dialogs not code-split, Excalidraw's locale chunks, draw.io uncompressed, `plugins: true`, arm64-only, no V8 snapshot | kept |
| D16 | Feature-neutral refactors: IPC contract as data (`shared/ipc.ts`), `useBoardDocument`, Sidebar hooks + render isolation, engine-selector pin | shipped (6A–6D, 5D, 1D) |
| D17 | The safety net: Playwright E2E ON (⚡ amends YAZ-1805 OD1), `docs/REGRESSION.md`, `tools/perf/` budget gate + harness + ratchet, Windows packaging CI | shipped (1A–1D) |
| D18 | Cherry-pick upstream engine perf fixes with no visible change | shipped: #12180 (resize) and #12183 (drag) are fork commits on `yaz-2073-perf` (5A). **Declined:** #12050 (≈0% dark-mode drag gain in Electron, and a visible handle colour change) and #12063 (a sub-pixel rendering shift, not a speed fix) |
