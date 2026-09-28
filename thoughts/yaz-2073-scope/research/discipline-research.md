# discipline-research — external grounding for YAZ-2073 "Speed & Optimization"

Angle: what DHH actually said, the performance disciplines, Electron and Excalidraw practice, and a size calibration table. Research-first, but every claim here that touches this repo was checked locally (commands below). Repo at 51e85cd (v0.1.11).

---

## 1. What I measured (local, reproducible)

- **Installed sizes, runtime and Electron build for 60+ apps in /Applications.** I ran `du -sk` on each app, checked `lipo -archs` on the framework binary, and read `PlistBuddy CFBundleVersion` from `Electron Framework.framework/Versions/A/Resources/Info.plist`. The table is in §6.
- **Electron framework breakdown.** For each app: the framework binary, `Resources/`, `Libraries/` and the `*.lproj` count and size (`du -smc …/*.lproj`).
  - Yaseen Draw, Electron **43.4.1**: bin 183M, Resources 66M, Libraries 24M. It has **220 lproj dirs = 48 MB**: 55 locales, each with gendered variants such as `af_FEMININE.lproj`.
  - Todoist, Electron 41.2.0, keeps only **18 lproj = 12 MB**. Its framework is **226 MB**, against 273 MB for Yaseen Draw.
- **V8 code cache (checked on disk).** `~/Library/Application Support/Yaseen Draw/Code Cache` holds **36 KB** in 5 files. The only real entry is `electron-preload/*.cache`, and `js/index` is empty, so **the renderer bundle is never code-cached**. For comparison, Obsidian, which serves `app://obsidian.md` with code cache on, has **27 MB** in `Code Cache`.
- **Built renderer.** `desktop/out/renderer` is 28 MB: **14.3 MB JS and 13.8 MB of `.map` files**, from `find … | xargs du -ck`. `desktop/out/drawio` is 50 MB.
- **Comparator: ExcalidrawZ.** This is a native Swift app with WKWebView that also embeds Excalidraw.
  - `/Applications/ExcalidrawZ.app` is **104 MB universal** (x86_64+arm64).
  - Its `Resources/excalidraw-latest` is 44 MB: **8.7 MB JS, 13.3 MB woff2 (232 files), 22.8 MB sourcemaps**.
  - So a complete Excalidraw payload is about **22 MB without maps**.
- **Tauri comparators, confirmed by `strings` containing `tauri_utils` / `tauri-plugin-*`.**
  - Hermes.app is **12 MB**.
  - Conductor.app is **503 MB**, because it bundles `MacOS/node` (105 MB) plus 362 MB of Resources. A system webview does not make an app small if you ship sidecars.
- **The Spotify claim.** `/Applications/Spotify.app` contains `Chromium Embedded Framework.framework` and no Electron. That confirms it is **CEF, not Electron**, at 393 MB installed.
- **Main-process hygiene grep.** There is no `sendSync` in `desktop/src`. The only sync fs calls on startup paths are `store.ts:245 readFileSync` (a small JSON store; fine) and a test fixture. A `Worker` is already used in `storageJob.ts:25`.

---

## 2. What DHH actually said (2025–2026). Quotes are under 15 words.

**Install speed (Omarchy): confirmed, with sources**
- **Jul 2025.** His first target was a sub-5-minute install on a fast connection, framed as a "Cartridge is benchmark" idea: the Super Nintendo standard. https://x.com/dhh/status/1943742620116914507
- **Sep 2025.**
  - "FULL INSTALL of Omarchy down UNDER THREE MINUTES" (offline ISO, Ryan Hughes). https://x.com/dhh/status/1965128234871488957
  - He then said "TWO MINUTES". https://x.com/dhh/status/1965857746282229793
- **Omarchy 4 "Quattro" (2026).** His tweet, paraphrased: the codebase is 4× bigger (40K lines of QML), but the *overall system* is a quarter of the code because "we've dropped a bajillion dependencies". ISO **20% smaller**, installs **up to 40% faster**. https://x.com/dhh/status/2085307947605758179
- **Lex Fridman #501, published Aug 26 2026.** https://lexfridman.com/dhh-2-transcript/ (I grepped the transcript locally.) His concrete points:
  - **Benchmark against physics, not competitors.** The NVMe drive does 7 GB/s and the ISO is 5.8 GB, so ask why the install isn't about one second. "there's no speed limit".
  - **The baseline is absurd.** A new Mac took 42 minutes of updates before first use, and a Windows PC took 1 h 35 min.
  - **Payload size maps 1:1 to install time.** Most of the install is decompressing packages. Going from 7.5 GB to 5.85 GB "almost literally translated one-to-one".
  - **Keep the features, slim the packaging.**
    - He built a *slim* JetBrains font package, which saved 180 MB of the original 200 MB.
    - He recompressed the NVIDIA packages with maximum zstd, saving about 200 MB. Build time is cheap; the user's install time is not.
  - **Use human input time to preload.** The installer does its work while the user answers five questions: "the oldest trick in the book".
  - **"McLaren" mindset:** shave megabytes the way McLaren shaves grams.
  - **Curated is not minimal.** Omakase means "chef's choice": he keeps the apps in the box and fights bloat in how they are packaged.
  - **Records.** 45 s is the current record. "Turbo images" aim for about 12 s on known hardware.
  - **Rust port of a Python effects library (agent-written, ~45 min).** Startup went from **86 ms to 2 ms**, it runs **9.6× faster**, and it is a **3 MB single executable with no dependencies**. He ported it because Python used about 30 W and spun up the fans on laptops.
- **Rails World 2026 keynote (Sep 23 2026).** HEY is being rebuilt as native apps on each platform with a Rust backend, and agents make native affordable. I could not find a transcript; this is from a secondary source: https://launchkit.codes/rails-agents/pencils-down-what-dhh-actually-said
- **On Electron (2020).** "Electron has gotten a bad rap from some truly atrocious uses". HEY's JS bundle is about 40 KB. https://x.com/dhh/status/1265687484857372672

**Spotify: UNCONFIRMED**
- I found **no primary DHH source** (tweet, HEY World post or transcript) calling the Spotify desktop app a bloated Electron app. I searched X, HEY World, the Lex #501 transcript and Omarchy issues.
- What is verifiable:
  - Omarchy Quattro **moved Spotify (with Signal and 1Password) from default to on-demand install**. https://botmonster.com/self-hosting/omarchy-quattro-release/
  - An Omarchy issue proposes replacing the Spotify GUI with a TUI. https://github.com/omacom/omarchy/issues/2750
  - Spotify has been CEF since 2011 (https://codenote.net/en/posts/famous-electron-apps-2026-research/), and I confirmed that locally.
- If Yasin remembers a specific clip, ask for the link. Don't cite it in docs as fact.

**What to take for this project:**
1. Measure against the physical floor (the Electron runtime), not against other apps.
2. Shrink the payload without removing features: slim packages, maximum compression and strip unused variants are exactly the DHH/McLaren moves.
3. Do work while the user is busy (preload during idle or input).
4. Cut dependencies, not features.

---

## 3. The disciplines: a one-page operating playbook for Yaseen Draw

**Laws**
- **Measure, then act.** Knuth's "premature optimization" line ends with "yet we should not pass up our opportunities in that critical 3%". Find that 3% with a profiler. Never optimize without a before/after number.
- **Beck's order.** Make it work, make it right, make it fast. This project is step 3 on a working product, so every change must keep step 1 (the feature contracts in `docs/CONTRACTS.md`) green.
- **Brendan Gregg's mantras, in priority order.** Don't do it → do it but not again (cache) → do it less → do it later → do it when they're not looking → do it concurrently → do it cheaper. https://www.brendangregg.com/methodology.html
- **Avoid Gregg's anti-methods.** Streetlight: using the tools you know rather than the ones that find the problem. Random change: tweaking without a hypothesis.

**Budgets. These become CI gates; a budget without a gate decays.**

| Dimension | Budget | Source / rationale |
|---|---|---|
| Input response | under 50 ms handler, under 100 ms visible | RAIL https://web.dev/articles/rail |
| Frame (pan/zoom/drag) | 16.6 ms frame, **≤10 ms of our JS** (browser needs about 6 ms) | RAIL |
| Idle work chunks | ≤50 ms each (`requestIdleCallback`) | RAIL |
| INP-equivalent | ≤200 ms good, over 500 ms poor. Split into input delay, processing and presentation | https://web.dev/articles/inp |
| Long tasks | none over 50 ms on the main thread during interaction (Long Animation Frames API) | Chrome LoAF |
| Install size | set from §6: Electron floor about 230 MB arm64 | measured |
| Cold start → first canvas | set after baselining. Target: `ready-to-show` plus first `StaticCanvas` paint | — |

**Methods by symptom**
- **Slow startup.** Use Gregg's time-division method. Mark main `app.ready`, window created, `did-finish-load`, React mount and first scene paint, then attack the biggest segment first.
- **Jank.** Record a Performance trace in Chromium DevTools, then work down from the long frames to their long tasks and hot functions.
- **Memory or GPU.** Apply the USE method (utilization, saturation, errors) per resource: CPU, GPU raster, JS heap, canvas backing stores, IPC. Look for the resource that is *saturated*, not only the one that is busy.
- **Critical rendering path.** Nothing blocking before first paint: no synchronous fonts, no unused CSS or JS on the entry chunk, lazy-load dialogs and editors (CodeMirror, cytoscape, mermaid chunks).
- **Perceived performance.**
  - Theme-matched `backgroundColor` is already done (`desktop/src/main/index.ts:98`).
  - Show the skeleton immediately. Preload the next likely thing while the user is choosing, as DHH's installer does.
- **Data-oriented design (Mike Acton).** Design around the data's access pattern. For a canvas app that means:
  - flat element arrays with id→index maps;
  - avoid O(n²) set rebuilds per pointer move (upstream #12180/#12183);
  - spatial index for hit tests and culling;
  - cache derived bitmaps keyed by version.
- **Regression prevention (Figma's model).** Run scripted benchmarks for drag, pan, zoom and select on a large fixture in Electron, on every PR. Keep a low-end machine in the loop and alert on regressions. https://www.figma.com/blog/keeping-figma-fast/

---

## 4. Electron practice (official docs plus VS Code, Slack, Notion, Figma, Linear, Obsidian)

Official checklist: https://www.electronjs.org/docs/latest/tutorial/performance
- Check what each dependency costs before adding it (`node --cpu-prof --heap-prof -e "require('x')"`). The docs' own example: `request` took about 500 ms to load, `node-fetch` under 50 ms.
- Lazy-`require` or dynamic-`import` anything not needed for first paint.
- Never block the main process: no sync IPC, no `@electron/remote`, use workers for CPU work.
- Keep the renderer at 60 fps: `requestIdleCallback`, Web Workers.
- Don't ship polyfills Chromium already has; target the latest ES.
- Bundle local assets; avoid network on the startup path.
- Bundle the main process to one file.
- Call `Menu.setApplicationMenu(null)` only if there's no menu. Not applicable here; we build a real menu.

Beyond the checklist:
- **V8 code cache for custom schemes.** By default Chromium caches compiled JS only for http(s). A custom scheme needs `{ standard: true, codeCache: true }` in `registerSchemesAsPrivileged`; the option was added in Electron 28 by PR #40544. https://github.com/electron/electron/pull/40544 and https://www.electronjs.org/docs/latest/api/structures/custom-scheme
  - `session.setCodeCachePath()` can relocate the cache.
  - **Yaseen Draw lacks this flag (finding F1).**
- **V8 snapshots.**
  - Atom reported about 50% faster startup; VS Code has used them since 2017. https://palette.dev/blog/improving-performance-of-electron-apps
  - Takuya Matsuyama (Inkdrop) reported about 1,000 ms saved: 4 s → 3 s TTI. https://www.devas.life/how-to-make-your-electron-app-launch-1000ms-faster/
  - Fuse `loadBrowserProcessSpecificV8Snapshot` gives the main process its own snapshot. https://www.electronjs.org/docs/latest/tutorial/fuses
  - High complexity (electron-link and mksnapshot per Electron version). Do it last, and only if F1 plus lazy loading isn't enough.
- **VS Code.** The ESM migration (1.94, Oct 2024) "massively improves startup performance" and cut the workbench bundle by more than 10%. They use staged initialization: render the shell, then restore, then load extensions lazily. https://www.devclass.com/development/2024/10/14/vs-code-migration-to-ecmascript-modules-massively-improves-startup-performance-but-extensions-left-behind-for-now/1624637
- **Slack.** Migrating to BrowserView and consolidating renderers gave up to **50% less memory and 33% faster launch**. Multiple workspaces no longer cost a renderer each. https://slack.engineering/growing-pains-migrating-slacks-desktop-app-to-browserview/
  - The lesson here: each extra `BrowserWindow`/`webContents` is a full renderer process, so count them.
- **Notion.**
  - Moving to SQLite (WASM) instead of IndexedDB made page load and navigation **50% faster**. https://www.notion.com/blog/faster-page-load-navigation
  - A 3perf audit found 1,100+ modules initialized at startup, 39% of the vendor bundle and 61% of the app bundle unused at first render, and core-js bundled three times. Projected gain: 30% (3.9 s of 12.6 s on a low-end device). https://3perf.com/blog/notion/
- **Linear.** Local-first: IndexedDB into an in-memory MobX pool; every UI read is local and mutations are optimistic. About 50% less code loaded after their 2021 work. https://performance.dev/how-is-linear-so-fast-a-technical-breakdown
- **Figma.** Per-PR performance CI in Electron with a fleet of low-end laptops, results in Datadog with alerts. Figma also reports file loading, dragging and zooming up to **3× faster** from incremental frame loading. https://www.figma.com/blog/keeping-figma-fast/ and https://www.figma.com/blog/incremental-frame-loading/
- **Obsidian.** An app:// scheme with the code cache on, which is why it has 27 MB in Code Cache locally. Plugins load lazily.
- **Microsoft Teams (Electron → WebView2).** About 50% less memory and 2× faster startup. The codenote audit reports the installer dropping from 134 MiB to 12 MiB. https://codenote.net/en/posts/famous-electron-apps-2026-research/
- **Size levers.**
  - `electronLanguages` strips Chromium locale paks. One report took an app from 324 → 289 MB and its DMG from 142 → 128 MB. https://github.com/getopenscreen/openscreen/pull/617
  - **Gotcha:** the matcher is exact or prefix on the lowercased `.lproj` name, so list `en` **and** `en_GB` explicitly and verify the output by counting the lproj dirs.
- **Other runtime settings worth confirming (not verified in this repo).**
  - Leave `backgroundThrottling` at its default (true) for hidden windows.
  - Use `MessagePort` or transferables for large payloads rather than JSON-stringified base64 over `invoke`.
  - Leave `spellcheck` on (it's a feature, YAZ-672).

---

## 5. Excalidraw large-scene and image knowledge (upstream)

**Architecture you inherit.** I read these files from upstream master: `packages/element/src/renderElement.ts`, `packages/excalidraw/scene/Renderer.ts`, `packages/common/src/constants.ts`, `packages/excalidraw/data/blob.ts`.

- **Two canvases (PR #6759, Aug 2023).**
  - A *static* canvas holds the shapes. It re-renders only when `sceneNonce`/version changes.
  - An *interactive* canvas holds selection, handles and cursors.
  - Both are `React.memo`'d. The static canvas must render first because of the shape cache.
- **New-element layer (#8340, Aug 2024).** An element being drawn gets its own canvas, so freedraw no longer re-renders the static scene each pointermove.
- **Throttling (#5422).** Scene rendering is throttled to rAF, with a trailing call. `isRenderThrottlingEnabled()` gates it.
- **Per-element bitmap cache.**
  - `elementWithCanvasCache = new WeakMap<Element, ElementWithCanvas>()` (renderElement.ts:682).
  - It regenerates on a zoom change unless `appState.shouldCacheIgnoreZoom` is set (it is during zoom gestures), or on theme, crop or frame-opacity change (renderElement.ts:697–706).
  - Each cached canvas is capped at `AREA_LIMIT = 16,777,216 px` (about **64 MB RGBA per element**) and `WIDTH_HEIGHT_LIMIT = 32767` (renderElement.ts:231–262).
  - **With many large images at high zoom this cache is the main memory cost.** Suspect it first on image-heavy boards.
- **Images.**
  - Images are stored as **base64 dataURLs** in `BinaryFiles`, about 33% larger than raw bytes and held as JS strings.
  - They are decoded through `loadHTMLImageElement(dataURL)` (element/src/image.ts:21–30).
  - `IMAGE_RENDER_TIMEOUT = 500` (constants.ts:355).
  - On insert they are downscaled to `maxWidthOrHeight: 1440` (constants.ts:405, `resizeImageFile` in blob.ts:357). The upstream web app caps uploads at 4 MiB (`FILE_UPLOAD_MAX_BYTES`).
- **Regressions and fixes to know.**
  - **#8692 → #8697 (Oct 2024).** The image cropper regenerated each image's element canvas *every frame*. The fix added `imageCrop` to the cache key and drew from the cached canvas. If the vendored fork predates #8697 or diverged there, images are re-rasterized every frame.
  - **#10578 (Jan 2026).** Dark mode no longer uses a CSS `filter: invert()` on the static canvas; colors are inverted in JS. This fixed Safari, emoji and images.
  - **#12050 (Sep 2026).** The same fix for the *interactive* canvas.
    - With software compositing, the full-viewport filter dropped dark-mode drag to 38–65 fps, against 120 fps with the filter removed.
    - p95 frame time was 33 ms.
  - **#12180/#12183 (Sep 27 2026).** Id-set rebuilding on every drag or resize was O(n²). Dragging 4,000 elements went from **643 ms to 54 ms per frame**; 1,000 elements from 45 ms to 18.5 ms.
  - **#10648 (Jan 2026).** Cache hits in collision detection.
  - **#8980.** Fewer frame clippings.
  - **#9352.** Eraser performance.
  - **#12063 (Sep 2026).** Element bitmaps snapped to whole device pixels.
- **Still open upstream.**
  - #7280: 5,000+ elements lag.
  - #10063: O(n) viewport culling with `isElementInViewport` per element and no spatial index; proposes quadtree/R-tree plus dirty regions.
  - #2222: tiled rendering, open since 2020 because invalidation is hard.
- **Practical patterns for large, image-heavy boards (ranked).**
  1. **Stay current with upstream perf PRs.** Diff the vendored fork against #8697, #10578, #12050, #12180/#12183 and #10648. This is cheap, touches no features, and has proven numbers.
  2. **Downscale on insert.** Keep 1440 px or make it a setting, and keep the original on disk if fidelity matters.
  3. **Bound the element-canvas cache for images.**
     - Draw images straight from a shared `ImageBitmap` per fileId (`createImageBitmap`, decoded off the main thread) instead of one zoom-scaled canvas per element.
     - Or add an LRU/byte budget on cached canvases.
     - This is fork work; prove it with a heap snapshot on a 50-image fixture.
  4. **Keep blobs off the JSON/IPC path.** Pass file bytes as `Uint8Array`/transferables or file paths, never base64 strings through `JSON.stringify` on every autosave.
  5. **Dark mode:** no CSS filters on canvases (#12050).
  6. **Offscreen culling** is already in place; a spatial index only if a trace shows `isElementInViewport` hot at N over 5k.
- **Obsidian-Excalidraw (zsviczian)** exposes a concurrent image-render worker count and compresses scene data (10+ MB → about 1 MB for handwriting). It is desktop-first, and the author says handwriting-scale scenes are not the design target. https://github.com/zsviczian/obsidian-excalidraw-plugin/wiki/Troubleshooting-Excalidraw-Performance-Issues/dccf6a77c69d60e49b491a8fcd26e1b31d02cbb1

---

## 6. Calibration table: installed size on this Mac (du, Sep 27 2026)

| App | Runtime | Arch | Installed | Notes |
|---|---|---|---|---|
| Hermes | Tauri (WKWebView) | arm64 | **12 MB** | floor for a system-webview app |
| Ghostty | native (Zig/Swift) | universal | 61 MB | |
| ExcalidrawZ | native Swift + WKWebView + Excalidraw | universal | **104 MB** | 44 MB web bundle, of which 22.8 MB is maps |
| Roam Research | Electron 30.0.5 | arm64 | 230 MB | fw 222 MB, 55 lproj |
| Todoist | Electron 41.2.0 | arm64 | 289 MB | **fw 226 MB; locales stripped to 18 (12 MB)** |
| Notion | Electron 43.6.0 | arm64 | 290 MB | fw 276, asar 9 |
| Slack | Electron 44.3.0 | arm64 | 321 MB | fw 285, asar 9 |
| **Yaseen Draw v0.1.11** | **Electron 43.4.1** | arm64 | **370 MB** | fw 273 (48 MB lproj), asar 72, share-viewer 23 |
| Spotify | **CEF** | — | 393 MB | not Electron |
| Linear | Electron 41.3.0 | universal | 471 MB | universal doubles the binary (359 MB) |
| Obsidian | Electron 39.7.0 | universal | 481 MB | |
| Conductor | Tauri + bundled node | arm64 | 503 MB | webview doesn't help if you ship sidecars |
| VS Code | Electron 43.6.0 | arm64 | 856 MB | extensions, node_modules unpacked |
| Claude | Electron 44.4.3 | universal | 880 MB | |

External figures:
- Zed: DMG under 100 MB, binary over 220 MB (https://github.com/zed-industries/zed/discussions/28524).
- Sublime Text: about 15 MB (https://en.wikipedia.org/wiki/Sublime_Text).
- Tauri hello-world: about 3–10 MB vs Electron about 85–150 MB; idle RAM about 30–80 MB vs 150–400 MB; cold start about 0.4 s vs 1.4 s (https://www.gethopp.app/blog/tauri-vs-electron).
- Omarchy: 5.8 GB ISO, 45 s record install.

**What counts as "great"**
- **Electron (arm64) floor.**
  - The framework is about 273 MB stock and about **225 MB with locales stripped**; Todoist shows this.
  - Floor plus a lean payload (about 22 MB of Excalidraw plus our code, no maps) plus share-viewer makes **about 250–270 MB installed a best-in-class Electron result**.
  - That is about 28–32% smaller than today, not 10×.
- **An order of magnitude (about 37 MB) is physically impossible on Electron.** The framework alone is 7× that. It requires a system webview (WKWebView/WebView2), where 12–100 MB is realistic; ExcalidrawZ is 104 MB universal.
- That is an architecture decision (see below), not an optimization.
- **Speed and smoothness can reach "order of magnitude" on Electron.** Examples: upstream drag went 643 → 54 ms, and the code cache and lazy loading apply to startup. Frame time and startup are set by our code, not by the runtime's size.

---

## 7. Findings ranked by impact, with proposed changes

**F1. V8 code cache disabled for the renderer. Impact: startup ms (all warm launches). Effort: one line.**
- Evidence: `desktop/src/main/index.ts:82` registers `app` without `codeCache`. On disk, `Code Cache/js` is empty (36 KB total) against 27 MB for Obsidian. There are 14.3 MB of renderer JS that V8 re-parses and recompiles on every launch.

```diff
--- a/desktop/src/main/index.ts
+++ b/desktop/src/main/index.ts
@@ -82 +82 @@
-protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
+protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
```

- Risk: very low. The cache is keyed by URL plus a source hash, and Chromium invalidates it on content change (so it survives app updates safely). There is no behavior change.
- Proof:
  1. After two launches, `du -sh "…/Code Cache/js"` should be MBs, not empty.
  2. Performance marks from `app.ready` to first `StaticCanvas` paint, 10 cold and 10 warm launches, before vs after.
  3. The full e2e/contract suite stays green.
- The draw.io `app://drawio` content benefits from the same flag, since it's the same scheme.

**F2. 47 MB of unused Chromium locale paks. Impact: about 47 MB installed (−13%) and about 15 MB DMG.**
- Evidence: 220 lproj = 48 MB, measured. The app's UI is English-only; `langCode` was dropped, per `client/src/drawings/ExcalidrawSurface.tsx:84`.

```diff
--- a/desktop/package.json
+++ b/desktop/package.json
@@ -23,2 +23,3 @@
     "productName": "Yaseen Draw",
+    "electronLanguages": ["en", "en_GB"],
```

(Insert this near line 23, inside `"build"`.)
- Risk: low, but real.
  - On macOS, `app.getLocale()` and `navigator.language` resolve only among the shipped lproj.
  - `Intl`/`toLocaleString()` without an explicit locale would then default to en for users with a non-English OS. Grep found no `navigator.language`/`getLocale` use in `client/src`, `desktop/src` or `shared`.
  - The macOS spellchecker uses the OS's NSSpellChecker and is unaffected.
- Proof:
  1. `ls …/Resources | grep -c lproj` gives the expected count; gendered `en_*` variants may need listing.
  2. Launch with the system language set to German: dates and menus render and the spellcheck context menu works.
  3. Compare `du` before and after.

**F3. Sourcemaps shipped in the package (13.8 MB in `out/renderer`). Impact: about 14 MB, plus draw.io and share-viewer maps if present.**
- ExcalidrawZ shows the same waste: 22.8 MB of maps.
- Change: build maps but keep them out of `files` (upload them or keep them locally for crash symbolication). Other angles own the exact diff.
- Risk: none to features. Stack traces in production lose source mapping, unless the maps are kept as a release artifact.

**F4. Vendored Excalidraw fork vs upstream perf fixes. Impact: jank. Proven upstream numbers: 643 → 54 ms/frame drag at 4k elements; dark-mode 38 → 120 fps.**
- Change: audit `client/vendor/*.tgz` against #8697, #10578, #12050, #12180, #12183, #10648, #8980, #9352, #12063, then cherry-pick or rebase.
- Risk: medium, because the fork carries our customizations.
- Proof: a scripted drag/pan/zoom benchmark on 1k/4k-element and 50-image fixtures, dark and light (the Figma model), plus the full test suite.

**F5. Image memory. Impact: RAM/GPU on image-heavy boards (up to about 64 MB per cached image canvas).**
- Change:
  - Share one decoded `ImageBitmap` per fileId.
  - Put a byte budget or LRU on `elementWithCanvasCache` entries for images.
  - Keep blobs out of JSON/IPC on autosave.
- Risk: medium (fork internals).
- Proof: heap and GPU memory snapshots (`process.getProcessMemoryInfo`, `app.getGPUInfo`) on a 50×4K-image fixture, before and after. The visual diff of exports must be identical.

**F6. Startup sequencing, the DHH "preload while they answer" move. Impact: perceived start.**
- Change:
  - Lazy-load the heavy chunks: `percentages-*.js` 1.8 MB, `cynefin-*` 1.3 MB, cytoscape 0.94 MB, CodeMirror 0.6 MB.
  - Where they're dynamic already, prefetch them in `requestIdleCallback` after first paint.
- Proof: a coverage report showing unused JS on the entry chunk, plus the time-division marks.

---

## ARCHITECTURE DECISIONS FOR YASIN

**AD1. The "order of magnitude smaller" target**
- Problem: 371 MB → 37 MB cannot be reached on Electron, because the framework alone is at least 225 MB even stripped. The owner wants 10× and no feature loss.
- Options:
  1. **Stay on Electron. Target about 250–270 MB (−30%) and 10× on speed and smoothness metrics.**
  2. Move to Tauri/WKWebView with WebView2 on Windows. About 15–100 MB, but it loses Chromium uniformity. Risks:
     - Safari/WebKit canvas and filter behavior (see #10578 Safari issues);
     - an offline draw.io host;
     - the `plugins: true` (PDF) setting;
     - the spellcheck context menu;
     - a Windows WebView2 variance matrix;
     - a rewrite of all main-process code in Rust or a Node sidecar. A sidecar erases the win, as Conductor's 503 MB shows.
  3. A hybrid: native Swift shell plus WKWebView on macOS only (the ExcalidrawZ model, 104 MB universal), with Electron kept for Windows. That means two codebases.
- **Recommendation: option 1.**
  - The owner's hard rules are no feature loss and no stability loss.
  - Options 2 and 3 are rewrites with real feature and behavior risk.
  - Reframe "10×" per metric:
    - 10× faster warm start (code cache plus lazy chunks);
    - 10× smoother large-scene drag (upstream O(n²) fixes);
    - 10× less image memory;
    - about 1.4× smaller install.
  - Revisit option 2 only after 1 is done, with a spike that runs the existing e2e suite on WKWebView.

**AD2. Universal vs arm64-only**
- Problem: universal builds double the binary (Linear and Obsidian are about 470–480 MB). We ship arm64 only today, which is good.
- Options:
  1. Keep arm64-only.
  2. Add an x64 DMG as a *separate* artifact if Intel users matter.
- Recommendation: 1. If Intel is ever needed, use 2, never universal.

**AD3. V8 snapshot**
- Problem: this is the largest remaining startup lever (Atom −50%), but it adds a per-Electron-upgrade build step.
- Options:
  1. Skip it.
  2. Do it after F1/F6 if cold start is still above budget.
- Recommendation: 2. Measure first. It's gated on a startup budget miss.

**AD4. Performance CI gate (the Figma model)**
- Problem: without a gate, gains decay.
- Options:
  1. Size gate only: `du` of the .app and DMG compared with a checked-in budget.
  2. Size plus a scripted Playwright/Electron benchmark (drag, pan, zoom on fixtures) with a threshold.
- Recommendation: 2. Size is trivial to gate; frame time catches the regressions users feel.

---

## EXECUTION ISSUE CANDIDATES

1. **Enable the V8 code cache for `app://`** (F1). One line, plus a before/after warm-start measurement and a Code Cache size check.
2. **Strip Chromium locales with `electronLanguages`** (F2), plus a German-locale smoke test and an lproj count assertion in the pack script.
3. **Stop shipping sourcemaps in the package** (F3). Keep them as a release artifact for symbolication.
4. **Startup time-division instrumentation.** Add `performance.mark` and main-process timestamps from `app.ready` to first canvas, and log them to a dev-only report. This is the baseline for everything else.
5. **Audit the vendored Excalidraw fork against the upstream perf PR list** (F4). Produce a table of present, missing and conflicting PRs, then cherry-pick.
6. **Build the large-scene benchmark fixtures and harness**: 1k/4k/10k elements and 50 large images, dark and light. Drag, pan and zoom p50/p95 frame times go into CI (AD4).
7. **Image memory budget** (F5): a shared `ImageBitmap` cache plus a byte-bounded element-canvas cache for images, proven by heap and GPU snapshots.
8. **Keep blobs off JSON/IPC** on the autosave and share paths (F5). Use transferables or paths.
9. **Lazy-load and idle-prefetch the heavy renderer chunks** (F6), with a coverage-based entry-chunk budget.
10. **Size budget gate in the pack scripts**: fail if the .app or DMG exceeds the budget, with the delta printed per top-level dir.
11. **(Deferred, gated on #4's data) V8 snapshot spike** (AD3).
12. **(Deferred, AD1 option 2 exploration) WKWebView spike**: run the existing e2e suite in a Tauri shell and list what breaks. This is decision input only.

---

## Sources (primary first)
- DHH:
  - https://x.com/dhh/status/1943742620116914507
  - https://x.com/dhh/status/1965128234871488957
  - https://x.com/dhh/status/1965857746282229793
  - https://x.com/dhh/status/2085307947605758179
  - https://x.com/dhh/status/1265687484857372672
  - https://lexfridman.com/dhh-2-transcript/
  - https://launchkit.codes/rails-agents/pencils-down-what-dhh-actually-said
- Omarchy and Spotify:
  - https://botmonster.com/self-hosting/omarchy-quattro-release/
  - https://github.com/omacom/omarchy/issues/2750
  - https://codenote.net/en/posts/famous-electron-apps-2026-research/
- Electron:
  - https://www.electronjs.org/docs/latest/tutorial/performance
  - https://www.electronjs.org/docs/latest/tutorial/fuses
  - https://www.electronjs.org/docs/latest/api/structures/custom-scheme
  - https://github.com/electron/electron/pull/40544
  - https://github.com/getopenscreen/openscreen/pull/617
- Teams:
  - https://slack.engineering/growing-pains-migrating-slacks-desktop-app-to-browserview/
  - https://www.notion.com/blog/faster-page-load-navigation
  - https://3perf.com/blog/notion/
  - https://palette.dev/blog/improving-performance-of-electron-apps
  - https://www.devas.life/how-to-make-your-electron-app-launch-1000ms-faster/
  - https://www.devclass.com/development/2024/10/14/vs-code-migration-to-ecmascript-modules-massively-improves-startup-performance-but-extensions-left-behind-for-now/1624637
  - https://www.figma.com/blog/keeping-figma-fast/
  - https://www.figma.com/blog/incremental-frame-loading/
  - https://performance.dev/how-is-linear-so-fast-a-technical-breakdown
- Disciplines:
  - https://web.dev/articles/rail
  - https://web.dev/articles/inp
  - https://www.brendangregg.com/methodology.html
  - https://www.brendangregg.com/usemethod.html
- Excalidraw:
  - https://github.com/excalidraw/excalidraw/pull/6759
  - https://github.com/excalidraw/excalidraw/pull/8340
  - https://github.com/excalidraw/excalidraw/pull/5422
  - https://github.com/excalidraw/excalidraw/issues/8692
  - https://github.com/excalidraw/excalidraw/pull/8697
  - https://github.com/excalidraw/excalidraw/pull/10578
  - https://github.com/excalidraw/excalidraw/pull/12050
  - https://github.com/excalidraw/excalidraw/pull/12180
  - https://github.com/excalidraw/excalidraw/pull/12183
  - https://github.com/excalidraw/excalidraw/issues/10063
  - https://github.com/excalidraw/excalidraw/issues/7280
  - https://github.com/excalidraw/excalidraw/issues/2222
- Calibration:
  - https://www.gethopp.app/blog/tauri-vs-electron
  - https://github.com/zed-industries/zed/discussions/28524
  - https://en.wikipedia.org/wiki/Sublime_Text
