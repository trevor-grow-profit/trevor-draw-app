# YAZ-2073 before / after (7A, YAZ-2111)

**Before** = v0.1.11 (`51e85cd`), **after** = `yaz-2073-speed`. Both built and packaged on 2026-09-28
on the same M1 Max (`npm ci` + `npm run desktop:build`) and measured with this branch's tools:
`npm run perf:budget` for size, and `npm run perf -- <scenario> --runs 7 --app <after> --vs <before>`
for speed. `--vs` interleaves the two apps run by run (ABBA order), and each app gets its own
discarded warm-up, fixtures and profile. Every number below comes from that run; none is estimated.
The raw runs are in `tools/perf/baseline.json` (before) and the lead's scratch `p7/runs/*.json`.

**Load.** Other agents were building and testing on the same machine throughout (1-minute load
29–159). The interleaving spreads that load over both apps alike, so each Δ is fair, but the
absolute times run higher than on an idle Mac. **Load-sensitive:** launch, draw.io open, `openMs`,
the hover preview times, storm `settleMs` / `ipcMaxMs`, and the GPU footprints. **Load-insensitive:**
sizes, drag frame p50 (display-bound at 10 ms here), storm CPU seconds and peak MB, and `quitFlushPushed`.

## Targets (YAZ-2074 "Deep scope, 1 of 3")

| Dimension | Before | Target | After | Met |
|---|---:|---:|---:|:--:|
| DMG | 172.5 MB | ≤ 115 MB | **116.1 MB** (−33 %; 124.7 MB before 3B) | ✗ by 1.1 MB |
| Installed (.app) | 387.2 MB | ≤ 300 MB | **319.9 MB** (−17 %; 367.5 MB before 3B) | ✗ (Electron Framework is still 239.8 MB of it) |
| Launch → canvas (median · p95) | 509.5 · 517.9 ms | ≤ 450 ms | **486.4 · 512.6 ms** (−5 %) | ✗ **still > 450 ms → this triggers the Future "V8 startup snapshot" issue (D15)** |
| draw.io open | 778.1 · 795.5 ms | ≤ 650 ms | **722 · 830.8 ms** (−7 %) | ✗ (load-sensitive) |
| Hover preview, 121-image board: worst frame | 310 · 320 ms | ≤ 20 ms | **20 · 20.5 ms** | ✓ (at the limit: 2 frames at 100 Hz) |
| Hover preview, 121-image board: time to picture (incl. 400 ms dwell) | 785.8 · 827.8 ms | ≤ 700 ms | **509.7 · 601.6 ms** (−35 %) | ✓ |
| Image-heavy open: longest task | 312 · 335 ms | ≤ 50 ms | **316 · 340 ms** (±0) | ✗ (5B1 off-thread decode tried and closed; follow-up YAZ-2134) |
| Drag at 1k: frame p50 | 20 · 20.1 ms | — | **10 · 10 ms** (2×, display-bound) | ✓ |
| Drag at 4k: frame p50 | 460.1 · 480 ms | ≥ 5× faster (≤ 95 ms) | **10 · 10 ms** (46×) | ✓ |
| Tree storm, main CPU | 31.5 · 34.3 s | ≤ 1 s | **0.3 · 0.3 s** (−99 %) | ✓ |
| Tree storm, main peak | 3 269.5 MB | ≤ 250 MB | **113.6 MB** (−97 %) | ✓ |
| Tree storm, worst IPC stall | 1 723 ms | — | **4.4 · 11.3 ms** | ✓ |
| Sidebar hover | whole tree re-renders | 0 Sidebar renders | **0** (`Sidebar.render.test.tsx`: a 20-row sweep renders neither the sidebar nor the tree) | ✓ |
| Idle memory (main · renderer · GPU) | 45.3 · 56.7 · 102.9 MB | no regression | **45.0 · 54.9 · 102.1 MB** | ✓ |
| Quit flush (edit, then ⌘Q 2.5 s later, reaches the origin) | 0 / 7 runs | 1 | **7 / 7** | ✓ |
| Prod LOC (client, desktop, share, shared) | 32 699 | — | 33 262 (+563) | |
| Test LOC (unit + e2e) · tools | 33 161 · 3 179 | — | 39 908 · 4 180 | |
| Unit tests (vitest) | 2 575 in 168 files | — | **2 861** in 208 files, all green | |
| Playwright e2e | — | green | **131 / 131** (`npm run e2e`) · **125 passed + 6 skipped** (`E2E_PACKAGED=1`; the share specs run unpackaged only) | ✓ |
| **Features lost** | — | **0** | **0**: e2e green on both builds, and the 7B packaged pass is clean | ✓ |

Missed targets and the next lever:
- **Launch 486 ms > 450 ms**: this is the D15 trigger for the Future "V8 startup snapshot" issue.
- **draw.io open 722 ms > 650 ms**: the time is draw.io's own boot inside its frame. The next lever is to prewarm the draw.io frame after first paint.
- **DMG 116.1 MB and .app 319.9 MB**: 3B (Chromium locale trim, landed on Yasin's OK after the 7A run — YAZ-2087) took 8.6 MB off the DMG and 47.6 MB off the app. What is left over the targets is Electron itself (the framework is 239.8 MB); the app is English only, so on a non-English OS Chromium's strings, `navigator.language` and the default `Intl` locale are en-US (the sidebar Name sort collates as English).
- **Image-heavy open, 316 ms long task**: 5B1 (bitmap decode under a 512 MB budget) was built and failed its gates (RSS 191 → 724 MB, long task 140 ms); closed, follow-up YAZ-2134 (pre-shrunk copies).

## Size (`npm run perf:budget`, both packaged today)

| Metric | Before v0.1.11 | After | Δ | Target |
|---|---:|---:|---:|---:|
| appBytes | 387.2 MB | 319.9 MB | -17 % | 300.0 MB |
| frameworksBytes | 287.4 MB | 239.8 MB | -17 % |  |
| asarBytes | 76.0 MB | 70.6 MB | -7 % |  |
| shareViewerBytes | 23.4 MB | 9.2 MB | -61 % |  |
| dmgBytes | 172.5 MB | 116.1 MB | -33 % | 115.0 MB |
| lprojCount | 55 | 55 | 0 % |  |
| chromiumLocaleBytes | 48.7 MB | 1.1 MB | -98 % |  |
| chromiumLocaleCount | 220 | 8 | -96 % |  |
| asarNodeModulesFiles | 12 | 0 | -100 % | 0 |
| duplicateBytes | 13.6 MB | 81 KB | -99 % | 0 |
| rendererEagerJsBytes | 1.0 MB | 0.4 MB | -58 % |  |
| rendererEagerCssBytes | 93 KB | 53 KB | -42 % |  |
| rendererReachableChunks | 125 | 125 | 0 % |  |
| rendererTotalBytes | 28.3 MB | 23.0 MB | -19 % |  |
| rendererMapBytes | 0 | 0 | = |  |
| mainBundleBytes | 0.3 MB | 0.4 MB | +25 % |  |

The Chromium locale rows (and with them appBytes, frameworksBytes and dmgBytes) are the 3B package, measured after the rest: `npm run perf:budget` on 2026-09-28 against the same branch with 3B merged; before 3B they read 367.5 · 287.4 · 124.7 MB and 48.7 MB / 220. The Windows installer went 140.4 → 132.0 MB (locales 55 → 2 `.pak`).

`mainBundleBytes` grew (+70.9 KB): chokidar is now bundled into main rather than shipped as asar
`node_modules` (12 files → 0), and the IPC CONTRACT table (6A) adds to it. Its ceiling is raised
in budget.json and needs Yasin's OK (D17).

## Speed: every scenario (7 interleaved runs each, median · p95)

Load (1-minute, before → after each scenario, both apps together): launch 33.7→54.5 · drawio 54.5→36.4 ·
canvas-1k 36.4→41.5 · canvas-4k 41.5→28.6 · canvas-1k-dark 28.6→80.7 · canvas-4k-dark 80.7→40.3 ·
canvas-images 37.5→51.6 · canvas-legacy 51.6→58.3 · hover 56.6→110.5 · drawers 110.5→94.8 ·
storm 94.8→159.4 · heavy-tabs 158.1→66.1 · quit-flush 66.1→87.5 · idle 87.5→96.2.
Rows where both builds read a flat 10 ms frame or 0 ms long task are left out. **Bold** rows carry
a budget.json ceiling.

| Scenario · metric | Before median · p95 | After median · p95 | Δ median | Target |
|---|---:|---:|---:|---:|
| canvas-1k-dark.openMs | 31 · 46.7 | 34.2 · 41.8 | +10 % |  |
| canvas-1k-dark.openFrameP95Ms | 10.8 · 10.9 | 10.8 · 11 | 0 % |  |
| canvas-1k-dark.openFrameMaxMs | 80 · 90.1 | 80 · 590.1 | 0 % |  |
| canvas-1k-dark.openLongTaskMaxMs | 87 · 95 | 87 · 92 | 0 % |  |
| canvas-1k-dark.panFrameP95Ms | 10.8 · 10.9 | 10.8 · 10.9 | 0 % |  |
| canvas-1k-dark.panFrameMaxMs | 11 · 1009.9 | 11.1 · 1000 | +1 % |  |
| canvas-1k-dark.zoomFrameP95Ms | 10.8 · 10.9 | 10.8 · 10.9 | 0 % |  |
| canvas-1k-dark.zoomFrameMaxMs | 11 · 11.1 | 11 · 170.2 | 0 % |  |
| canvas-1k-dark.selectFrameP95Ms | 10.9 · 11 | 10.9 · 11 | 0 % |  |
| canvas-1k-dark.selectFrameMaxMs | 11 · 19.1 | 10.9 · 20 | -1 % |  |
| canvas-1k-dark.dragSelected | 1000 · 1000 | 1000 · 1000 | 0 % |  |
| **canvas-1k-dark.dragFrameP50Ms** | 20.1 · 29.2 | 10 · 10 | -50 % |  |
| canvas-1k-dark.dragFrameP95Ms | 30.7 · 31 | 10.8 · 10.9 | -65 % |  |
| canvas-1k-dark.dragFrameMaxMs | 59.9 · 1009.1 | 11 · 1010 | -82 % |  |
| canvas-1k-dark.dragLongTaskMaxMs | 52 · 53 | 0 · 0 | -100 % |  |
| canvas-1k.openMs | 31.6 · 128.3 | 39.7 · 44 | +26 % |  |
| canvas-1k.openFrameP95Ms | 11.4 · 11.5 | 11.5 · 11.5 | +1 % |  |
| canvas-1k.openFrameMaxMs | 80 · 80.3 | 80 · 90.7 | 0 % |  |
| canvas-1k.openLongTaskMaxMs | 83 · 84 | 82 · 84 | -1 % |  |
| canvas-1k.panFrameP95Ms | 11.4 · 11.5 | 11.4 · 11.5 | 0 % |  |
| canvas-1k.panFrameMaxMs | 12 · 12 | 12 · 12 | 0 % |  |
| canvas-1k.zoomFrameP95Ms | 11.4 · 11.4 | 11.4 · 11.5 | 0 % |  |
| canvas-1k.zoomFrameMaxMs | 11.9 · 12 | 12 · 12 | +1 % |  |
| canvas-1k.selectFrameP95Ms | 11.3 · 11.6 | 11.3 · 11.6 | 0 % |  |
| canvas-1k.selectFrameMaxMs | 11.5 · 19.9 | 11.9 · 30 | +3 % |  |
| canvas-1k.dragSelected | 1000 · 1000 | 1000 · 1000 | 0 % |  |
| **canvas-1k.dragFrameP50Ms** | 20 · 20.1 | 10 · 10 | -50 % |  |
| canvas-1k.dragFrameP95Ms | 30.8 · 31.8 | 11.4 · 11.6 | -63 % |  |
| canvas-1k.dragFrameMaxMs | 60 · 60.1 | 12 · 20 | -80 % |  |
| canvas-1k.dragLongTaskMaxMs | 51 · 52 | 0 · 0 | -100 % |  |
| canvas-4k-dark.openMs | 65.3 · 79.3 | 53.9 · 62.7 | -17 % |  |
| canvas-4k-dark.openFrameP95Ms | 10.7 · 10.9 | 10.8 · 10.8 | +1 % |  |
| canvas-4k-dark.openFrameMaxMs | 290.1 · 320 | 290 · 1010 | -0 % |  |
| canvas-4k-dark.openLongTaskMaxMs | 285 · 296 | 279 · 291 | -2 % |  |
| canvas-4k-dark.panFrameP95Ms | 10.7 · 10.9 | 10.7 · 10.9 | 0 % |  |
| canvas-4k-dark.panFrameMaxMs | 20 · 20.1 | 20 · 20.9 | 0 % |  |
| canvas-4k-dark.zoomFrameP95Ms | 10.9 · 19 | 11 · 11.1 | +1 % |  |
| canvas-4k-dark.zoomFrameMaxMs | 20.2 · 20.5 | 20.2 · 21 | 0 % |  |
| canvas-4k-dark.selectFrameP95Ms | 10.8 · 11 | 10.7 · 11 | -1 % |  |
| canvas-4k-dark.selectFrameMaxMs | 20.1 · 30 | 20.9 · 40 | +4 % |  |
| canvas-4k-dark.dragSelected | 4000 · 4000 | 4000 · 4000 | 0 % |  |
| **canvas-4k-dark.dragFrameP50Ms** | 460.1 · 480 | 10 · 10 | -98 % | 95 |
| canvas-4k-dark.dragFrameP95Ms | 510 · 539 | 10.7 · 10.9 | -98 % |  |
| canvas-4k-dark.dragFrameMaxMs | 570.1 · 1210.2 | 40.1 · 60 | -93 % |  |
| canvas-4k-dark.dragLongTaskMaxMs | 540 · 555 | 0 · 50 | -100 % |  |
| canvas-4k.openMs | 68.6 · 72.6 | 65.8 · 332.8 | -4 % |  |
| canvas-4k.openFrameP95Ms | 10.7 · 10.8 | 10.7 · 10.9 | 0 % |  |
| canvas-4k.openFrameMaxMs | 300 · 1060 | 300 · 1279.8 | 0 % |  |
| canvas-4k.openLongTaskMaxMs | 268 · 289 | 274 · 317 | +2 % |  |
| canvas-4k.panFrameP95Ms | 10.7 · 10.8 | 10.8 · 10.9 | +1 % |  |
| canvas-4k.panFrameMaxMs | 20 · 20.4 | 20 · 1010 | 0 % |  |
| canvas-4k.zoomFrameP95Ms | 10.9 · 19.9 | 11 · 30 | +1 % |  |
| canvas-4k.zoomFrameMaxMs | 20.1 · 20.7 | 20.6 · 1009.9 | +2 % |  |
| canvas-4k.zoomLongTaskMaxMs | 0 · 0 | 0 · 183 | = |  |
| canvas-4k.selectFrameP95Ms | 10.9 · 11.1 | 10.8 · 11 | -1 % |  |
| canvas-4k.selectFrameMaxMs | 29.9 · 50.8 | 20.2 · 70 | -32 % |  |
| canvas-4k.selectLongTaskMaxMs | 0 · 55 | 0 · 0 | = |  |
| canvas-4k.dragSelected | 4000 · 4000 | 4000 · 4000 | 0 % |  |
| **canvas-4k.dragFrameP50Ms** | 460 · 470 | 10 · 10 | -98 % | 95 |
| canvas-4k.dragFrameP95Ms | 500 · 510 | 10.7 · 11 | -98 % |  |
| canvas-4k.dragFrameMaxMs | 560 · 1219.7 | 40.1 · 59.9 | -93 % |  |
| canvas-4k.dragLongTaskMaxMs | 531 · 539 | 0 · 0 | -100 % |  |
| canvas-images.openMs | 65.9 · 76 | 64.8 · 72.9 | -2 % |  |
| canvas-images.openFrameP95Ms | 10.7 · 10.9 | 10.7 · 10.9 | 0 % |  |
| canvas-images.openFrameMaxMs | 310 · 340.7 | 319.9 · 340.2 | +3 % |  |
| **canvas-images.openLongTaskMaxMs** | 312 · 335 | 316 · 340 | +1 % | 50 |
| canvas-images.panFrameP95Ms | 10.7 · 10.8 | 10.7 · 10.7 | 0 % |  |
| canvas-images.panFrameMaxMs | 11 · 11.1 | 11 · 11.2 | 0 % |  |
| canvas-images.zoomFrameP95Ms | 10.7 · 10.9 | 10.5 · 10.8 | -2 % |  |
| canvas-images.zoomFrameMaxMs | 11 · 11.1 | 11 · 11.1 | 0 % |  |
| canvas-images.selectFrameP95Ms | 10.5 · 10.9 | 10.7 · 11 | +2 % |  |
| canvas-images.selectFrameMaxMs | 10.8 · 20 | 10.8 · 11 | 0 % |  |
| canvas-images.dragSelected | 121 · 121 | 121 · 121 | 0 % |  |
| canvas-images.dragFrameP95Ms | 10.6 · 10.8 | 10.5 · 10.9 | -1 % |  |
| canvas-images.dragFrameMaxMs | 11 · 11.1 | 11 · 11 | 0 % |  |
| canvas-legacy.openMs | 232.6 · 286.6 | 210.4 · 238.7 | -10 % |  |
| canvas-legacy.openFrameP95Ms | 10.7 · 10.9 | 10.8 · 10.9 | +1 % |  |
| canvas-legacy.openFrameMaxMs | 99.9 · 110.5 | 100 · 109.7 | +0 % |  |
| **canvas-legacy.openLongTaskMaxMs** | 109 · 115 | 110 · 120 | +1 % |  |
| canvas-legacy.panFrameP95Ms | 10.6 · 10.9 | 10.7 · 10.9 | +1 % |  |
| canvas-legacy.panFrameMaxMs | 11 · 11.1 | 11 · 20 | 0 % |  |
| canvas-legacy.zoomFrameP95Ms | 10.7 · 10.8 | 10.8 · 10.9 | +1 % |  |
| canvas-legacy.zoomFrameMaxMs | 11 · 11.2 | 11 · 11.1 | 0 % |  |
| canvas-legacy.selectFrameP95Ms | 10.4 · 10.8 | 10.6 · 10.9 | +2 % |  |
| canvas-legacy.selectFrameMaxMs | 10.9 · 11 | 11 · 11 | +1 % |  |
| canvas-legacy.dragSelected | 15 · 15 | 15 · 15 | 0 % |  |
| canvas-legacy.dragFrameP95Ms | 10.7 · 10.9 | 10.8 · 10.9 | +1 % |  |
| canvas-legacy.dragFrameMaxMs | 11 · 11.1 | 11 · 20 | 0 % |  |
| **drawers.panelFrameP95Ms** | 10.8 · 11 | 10.9 · 10.9 | +1 % |  |
| drawers.panelFrameMaxMs | 11.1 · 20.1 | 19.9 · 1010.7 | +79 % |  |
| drawers.panelTabsFrameP95Ms | 10.7 · 11 | 10.8 · 11 | +1 % |  |
| drawers.panelTabsFrameMaxMs | 11.1 · 1010.4 | 11.1 · 1010 | 0 % |  |
| **drawers.sidebarFrameP95Ms** | 10.7 · 11 | 10.8 · 11 | +1 % |  |
| drawers.sidebarFrameMaxMs | 11.1 · 11.1 | 11 · 11.1 | -1 % |  |
| **drawers.switcherFrameP95Ms** | 10.8 · 11 | 10.8 · 10.9 | 0 % |  |
| drawers.switcherFrameMaxMs | 11.1 · 1010.1 | 11 · 1000 | -1 % |  |
| **drawio.drawioOpenMs** | 778.1 · 795.5 | 722 · 830.8 | -7 % | 650 |
| **heavy-tabs.rendererFootprintMb** | 98.9 · 103.2 | 96.7 · 99.2 | -2 % |  |
| **heavy-tabs.gpuFootprintMb** | 87.9 · 104 | 75.7 · 113.9 | -14 % |  |
| heavy-tabs.mainFootprintMb | 69.2 · 72.1 | 68.5 · 72.7 | -1 % |  |
| **hover.hover121PreviewMs** | 785.8 · 827.8 | 509.7 · 601.6 | -35 % | 700 |
| hover.hover121FrameP95Ms | 10.8 · 10.9 | 10.8 · 10.9 | 0 % |  |
| **hover.hover121FrameMaxMs** | 310 · 320 | 20 · 20.5 | -94 % | 20 |
| hover.hover121LongTaskMaxMs | 314 · 326 | 0 · 0 | -100 % |  |
| hover.hover90PreviewMs | 700.7 · 707.6 | 481.4 · 564.1 | -31 % |  |
| hover.hover90FrameP95Ms | 10.8 · 11 | 10.9 · 11 | +1 % |  |
| hover.hover90FrameMaxMs | 230 · 230.5 | 19.9 · 20 | -91 % |  |
| hover.hover90LongTaskMaxMs | 236 · 240 | 0 · 0 | -100 % |  |
| **hover.hoverLegacyPreviewMs** | 671 · 680 | 609.5 · 1380 | -9 % |  |
| hover.hoverLegacyFrameP95Ms | 10.8 · 10.9 | 10.9 · 10.9 | +1 % |  |
| hover.hoverLegacyFrameMaxMs | 120 · 120 | 30 · 30.4 | -75 % |  |
| idle.mainCpuPct | 0.1 · 0.2 | 0.1 · 0.8 | 0 % |  |
| **idle.mainFootprintMb** | 45.3 · 46.4 | 45 · 49.7 | -1 % |  |
| idle.gpuCpuPct | 0 · 0.1 | 0 · 0.5 | = |  |
| idle.gpuFootprintMb | 102.9 · 104.9 | 102.1 · 103.2 | -1 % |  |
| idle.utilityFootprintMb | 6.7 · 6.7 | 6.7 · 6.8 | 0 % |  |
| idle.rendererCpuPct | 0.1 · 0.1 | 0.1 · 0.9 | 0 % |  |
| idle.rendererFootprintMb | 56.7 · 61.7 | 54.9 · 59.7 | -3 % |  |
| **launch.spawnToCanvasMs** | 509.5 · 517.9 | 486.4 · 512.6 | -5 % | 450 |
| launch.spawnToNavMs | 275.4 · 288.3 | 272.9 · 288.1 | -1 % |  |
| launch.navToFirstPaintMs | 188 · 200 | 188 · 216 | 0 % |  |
| **launch.navToCanvasMs** | 244.7 · 252.4 | 226.3 · 246.4 | -8 % |  |
| launch.jsHeapMb | 11.9 · 12.1 | 10.7 · 10.8 | -10 % |  |
| quit-flush.quitFlushPushed | 0 · 0 | 1 · 1 | new |  |
| **storm.mainCpuSec** | 31.5 · 34.3 | 0.3 · 0.3 | -99 % | 1 |
| storm.settleMs | 11117 · 13214.4 | 1048.2 · 1203.6 | -91 % |  |
| **storm.mainPeakMb** | 3269.5 · 3324 | 113.6 · 115.3 | -97 % | 250 |
| **storm.ipcMaxMs** | 1723.3 · 2466.3 | 4.4 · 11.3 | -100 % |  |
| storm.ipcAvgMs | 388.2 · 431.4 | 0.4 · 0.9 | -100 % |  |

