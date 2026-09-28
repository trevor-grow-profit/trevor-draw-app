# Renderer bundle: payload and time to an interactive canvas (YAZ-2074, angle "renderer-bundle")

The build scripts, harnesses, traces and raw logs stayed in a scratch folder; the repo was not touched.

## TL;DR
- The renderer is already split well. The engine is lazy (`client/src/drawings/engine.ts:129-135`). Mermaid, CodeMirror, font-subset WASM, locales and pica are lazy chunks inside the engine. Nothing heavy is on the Welcome path.
- **The renderer ships UNMINIFIED.** electron-vite 5 defaults the renderer to `minify: false` (`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:536`), and `desktop/electron.vite.config.ts:111` doesn't override it. Minifying takes JS+CSS from **14.68 → 9.40 MB (−5.3 MB of asar, −36%)** and the entry chunk from **973 → 413 KB**.
- **The V8 code cache is off for `app://`** (`desktop/src/main/index.ts:82`). The main-process angle found this too. What's new here is **draw.io: 782 → 669 ms to a ready editor (−113 ms, −14%)** per open. For the Excalidraw canvas path it's −29 ms.
- **Engine download starts late.** It's requested 66 ms after navigation, only after `storage.init` IPC → React render → workspace → mount. Warming it right after `storage.init` for drawing windows saves about 30–37 ms, estimated from the trace.
- Honest ceiling: renderer nav→canvas is **~285 ms** today. These three changes take it to about **200–220 ms (−25 to −30%)**. This angle doesn't have an order of magnitude in it. Spawn→navigation is another **~290 ms**, and that's the main-process angle.

## 1. What I measured

### 1a. Shipped bundle (`desktop/out/renderer`, same bytes as `/Applications/Yaseen Draw.app` app.asar; checked `index-kGzVaEUc.js` = 973,567 B in both)
- 131 files in `assets/`. JS+CSS is **14,758,040 B raw / 3,727,007 B gzip-9**.
- `excalidraw-assets/` is 13 MB in 243 woff2 files (211 are Xiaolai CJK subsets). Fonts load per glyph range, only for text scenes.
- `out/drawio` is 50 MB and not in scope. Its `js/app.min.js` alone is 9.75 MB.
- Reproduced byte-for-byte in scratch: `vite build` with the same config gives the same hashes (`build.mjs`, `outA/`).
- Per-module attribution came from a Rollup `generateBundle` stats plugin (`outA.stats.json`, `analyze.mjs`).

| chunk | raw | gz | loads | contents |
|---|---|---|---|---|
| `index-kGzVaEUc.js` (ENTRY) | 973 KB | 196 KB | startup, every window | react-dom 561 KB, client/src ~400 KB (sidebar 88, drawings 67, settings 39, share 36, lib 27, image-studio 24, components-library 21, App 19, diagrams 18, history 15), shared 11 |
| `index-DwLtXr9M.css` | 93 KB | 23 KB | startup | app CSS |
| `percentages-WBIPKLEE-*.js` (ENGINE) | 1,839 KB | 458 KB | first canvas mount | @excalidraw/excalidraw prod 1,076 KB, pako 214, radix 190, roughjs 49, floating-ui 63, jotai 24 |
| `index-CTfqWGQk.js` | 494 KB | 137 KB | with engine | @excalidraw/element 285, common 49, math 10 |
| `index-DsNGVyNd.css` | 207 KB | 30 KB | with engine | engine CSS |
| `subset-shared.chunk-*.js` | 1,838 KB | 742 KB | lazy (SVG export with fonts) | harfbuzz + woff2 WASM as base64 |
| `index-BnMY-bi8.js` + 58 mermaid chunks | 6.87 MB | 1.34 MB | lazy (Mermaid→Excalidraw dialog) | mermaid 844 KB, mermaid-to-excalidraw 153, dompurify, cytoscape 961, katex 485, … |
| `CodeMirrorEditor-*.js` | 625 KB | 155 KB | lazy (TTD/code editor) | @codemirror/* |
| 56 locale chunks | 1.56 MB | 523 KB | never (the app sets no `langCode`) | engine translations |
| `roundRect-*.js` | 6.6 KB | | always, with engine | `canvas-roundrect-polyfill`. Chromium 142 has native `roundRect`. |

Engine distribution: `node_modules/@excalidraw/excalidraw/package.json` `exports["."].production → dist/prod/index.js`. Vite resolves the **prod** build, which the fork's esbuild has already minified. The tarball also carries `dist/dev` (30 MB with maps). That only costs repo/npm install size and never reaches the app.

### 1b. Minified build (`MIN=1`, same config plus `minify: 'esbuild'`, `outB/`)
- JS+CSS: **9,396,633 B raw / 3,049,681 gz**, down from 14,683,622 / 3,651,506. That's **−5.29 MB raw (−36%)**. The asar isn't compressed, so the raw number is the one that counts.
- Entry: 973 → **413 KB**. Engine: 1,839 → **1,236 KB**. App CSS: 93 → **53 KB**. Mermaid core: 1,358 → 737 KB. Cytoscape: 961 → 443 KB.

### 1c. Lab harness (Electron 43.4.1 from the repo's node_modules, isolated `userData` in scratch)
Setup: a synthetic 885-element scene (rectangles, ellipses, text in Excalifont, arrows). Timing runs from `import('@excalidraw/excalidraw')` + CSS through `<Excalidraw>` mount to the first rAF after `onExcalidrawAPI`. Six launches per condition, median of warm runs 3–6. Log: `harness/matrix.log`.

| condition | import | mount | start→painted | JS heap |
|---|---|---|---|---|
| unminified, no code cache (**today**) | 76 ms | 30 | **173 ms** | 15.9 MB |
| unminified + `codeCache:true` | 53 | 29 | **144 (−29)** | 16.2 |
| minified, no code cache | 71 | 29 | 167 (−6) | 14.9 |
| minified + `codeCache:true` | 51 | 28 | **142 (−31)** | 14.8 |
| + `v8CacheOptions:'bypassHeatCheck'` | 53 | 29 | 144 | 14.9 (no extra gain) |

- The code cache only kicks in on the 3rd launch. Chromium's heat check skips run 1 and produces the cache on run 2.
- On disk: `Code Cache/js` is 1.1 MB with `codeCache:true` and 8 KB without.

**draw.io editor** (`harness/drawio.js`). It serves `desktop/out/drawio` on `app://drawio` with the app's exact `drawioFrameUrl()` params. All non-app/non-file requests are blocked (0 were attempted). Timing runs until `.geDiagramContainer svg` exists.

| condition | ready (median runs 3–6) | JS heap | Code Cache/js |
|---|---|---|---|
| today | **781 ms** | 125 MB | 8 KB |
| `codeCache:true` | **669 ms (−113 ms, −14%)** | 118 MB | 20 MB |

### 1d. Real installed app (`/Applications/Yaseen Draw.app`)
- Isolated with a throwaway `YASEEN_DRAW_USER_DATA_DIR`, and CDP on port 9333.
- It opened a scratch vault containing the synthetic board. No user data was read or written.
- Another agent's instance (port 9335) was left alone. Every instance I started was killed.

CDP, 6 cold-process launches (`realapp/runs.log`):
- spawn → navigation origin: **283–314 ms** (main process)
- nav → first-paint: **148–164 ms**
- nav → FCP: **204–224 ms**
- nav → Excalidraw canvas present: **282–299 ms**
- **spawn → canvas: 567–601 ms**
- Renderer JS heap: 17.5 MB. Long-animation-frames: 3, about 195 ms total, longest 81 ms.

Startup trace (`--trace-startup … --trace-startup-format=json`, `realapp/trace.json`, analysed with `trace.mjs`). The renderer main thread, relative to navigation:
```
  4.3  request entry JS + app CSS
 15.2  entry JS received (973 KB over app:// → net.fetch(file://): ~11 ms)
 15.3  evaluateModule entry 9.9 ms
 28.2  React work 7 ms (after storage.init IPC)          31.5 firstPaint
 65.6  REQUEST engine CSS + engine + element chunks        ← engine starts only here
 96.3  engine received/compiled (1.84 MB, ~30 ms)          evaluateModule 6.8 ms
113.5  roundRect polyfill chunk requested (loaded until 254 ms: blocked behind long tasks)
116.9  React/engine 26 ms
131 / 171  Assistant woff2 requested TWICE (hashed copies from engine CSS + excalidraw-assets copies via FontFace)
167    Excalifont requested
174.8  74 ms long task (engine first render of 885 elements)
258–313  two more ~25 ms React tasks → canvas ≈ 285 ms
```
- Main-thread V8 in the first 400 ms: lazy compile `V8.CompileCode` **30.8 ms** (ParseFunction 17.4, CompileIgnition 7.3) and `evaluateModule` 16.8 ms.
- `Code Cache/js` stays empty, which confirms the in-memory cache is never persisted.

## 2. Findings ranked by impact

| # | Finding | Evidence | Impact |
|---|---|---|---|
| R1 | V8 code cache off for `app://`, which hits yaseen **and drawio** | `desktop/src/main/index.ts:82`. Installed app's `~/Library/Application Support/Yaseen Draw/Code Cache/js` holds 0 entries since 2026-09-21. | draw.io open **−113 ms**. Canvas path −29 ms (lab), which matches the ~31 ms of main-thread lazy compile in the trace. draw.io heap −7 MB. Costs +1 MB (yaseen) and +20 MB (drawio) in userData. |
| R2 | Renderer not minified | `electron-vite …/lib-q6ns0vZr.js:536` default `minify:false`. `desktop/electron.vite.config.ts:111` has no override. The share viewer *is* minified (`tools/buildShareViewer.mjs:55`). | **−5.29 MB** app.asar (≈ −0.6 MB DMG). Entry 973→413 KB. Canvas −6 ms (lab), JS heap −1 MB. |
| R3 | Engine fetch waits for IPC + first render | Trace: entry done at 25 ms, engine requested at 65.6 ms. `client/src/drawings/ExcalidrawSurface.tsx:418-439` is the only trigger. | Est. **−30 to −37 ms** nav→canvas for windows restored onto a drawing. Welcome windows unchanged. |
| R4 | Assistant UI font fetched twice | Trace at 131 ms (`assets/Assistant-*-hash.woff2` from `index-DsNGVyNd.css`) and at 171 ms (`excalidraw-assets/fonts/Assistant/*.woff2` via the engine's FontFace) | 4 extra reads (80 KB) and duplicate FontFace registration. Small. Fix belongs in the fork. |
| R5 | `canvas-roundrect-polyfill` loaded with every engine load | Trace at 113 ms (roundRect chunk) | 6.6 KB plus one module eval, blocked behind long tasks. Engine fork, trivial. |
| R6 | pako (214 KB unmin) is eager inside the engine chunk | `outA.stats.json`, percentages chunk | Only PNG-embed/encode paths need it. Lazy-loading it in the fork saves about 45 KB of minified parse. Small. |
| R7 | Client features all live in the entry chunk (Settings, Share, VersionHistory, ImageStudio, SavedComponents, Presentation, DrawioEditor, SharingPage) | `client/src/App.tsx:27-38`, `Editor.tsx:4` | About 400 KB unminified (≈150 KB min) of mostly preparsed code. V8 preparse is roughly 1 ms/100 KB, so **≤3 ms**. **Not worth it.** See ARCH-2. |
| R8 | 56 locale chunks shipped but unreachable (no `langCode`, no language picker) | `grep langCode client/src` finds only a comment (`ExcalidrawSurface.tsx:84`) | 1.56 MB raw (≈0.8 MB after R2) on disk. Zero runtime cost. Product call: ARCH-3. |
| R9 | Renderer bytecode (electron-vite `bytecodePlugin`) | Unsupported for the renderer (`lib-q6ns0vZr.js:1317` warns "does not support renderer") | N/A. R1 is the renderer equivalent. |

Already fine, don't touch:
- Build target is `chrome142`, from electron-vite `getElectronChromeTarget`.
- Engine resolves to its **prod** build.
- React is the production CJS build (`react-dom-client.production.js`).
- Heavy features are all lazy (mermaid 6.9 MB, subset WASM 1.8 MB, CodeMirror 0.6 MB, pica / image-blob-reduce).
- Board previews use `exportToBlob`, not the subset path (`client/src/lib/scenePreview.ts:66`).

## 3. Proposed changes

### C1: enable the V8 code cache on `app://` (R1). Shared with main-process F3; land it once.
`desktop/src/main/index.ts`
```diff
@@ -80,3 +80,5 @@
 // Privileged scheme: `standard` gives a real origin (history API, relative URLs), `secure` treats it
 // like https. VS Code (vscode-file://) and Obsidian (app://obsidian.md) do the same.
-protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
+// `codeCache`: Chromium persists V8 code only for http(s) unless a standard scheme opts in; measured
+// −29 ms to canvas and −113 ms to a ready draw.io editor on warm launches (YAZ-2074).
+protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
```
- **Risk:** low.
  - The cache is keyed by URL and V8 checks the source hash. Vite's content-hashed filenames make stale hits impossible for the yaseen host.
  - draw.io files are unhashed, but V8 rejects a cache whose source hash mismatches, so a draw.io version bump just recompiles once.
  - Costs about 21 MB in userData. It's a Chromium-managed LRU, and `session.setCodeCachePath` can move it if wanted.
- **Proof:**
  - (a) `find "…/Code Cache/js" -type f | wc -l` > 2 after two launches.
  - (b) Replay `harness/run.sh` and `harness/drawio.js` against the built app (medians above).
  - (c) Existing vitest plus the manual smoke: open drawing, open draw.io, share viewer, version history.

### C2: minify the renderer (R2)
`desktop/electron.vite.config.ts`
```diff
@@ -108,5 +108,11 @@
       dedupe: ['react', 'react-dom'],
     },
-    build: { outDir: rendererOut, rollupOptions: { input: resolve(client, 'index.html') } },
+    build: {
+      outDir: rendererOut,
+      rollupOptions: { input: resolve(client, 'index.html') },
+      // electron-vite leaves the renderer unminified by default; −5.3 MB of app.asar (YAZ-2074).
+      minify: 'esbuild',
+    },
   },
 })
```
- **Risk:** low.
  - The engine is already esbuild-minified upstream, and React is the prod build.
  - Client code doesn't depend on function or class names: no `constructor.name` or `Function#toString` in `client/src`.
  - Stack traces lose readable names. If wanted, emit `sourcemap: 'hidden'` to a location outside `out/`, because electron-builder's `files: ["out/**"]` (`desktop/package.json:27`) would otherwise ship the maps.
- **Proof:**
  - `npm run build` then `du -sh desktop/out/renderer/assets` goes 14.7 → 9.4 MB.
  - Full vitest suite plus a smoke of every lazy door: Mermaid dialog, code-block editor, SVG export with fonts, image insert/resize (pica), presentation, settings, share, history, draw.io.
  - Diff chunk count: 131 in both builds (checked in scratch: `outA` = 127 js/css, `outB` = 127).

### C3: warm the engine as soon as the window's identity says "drawing" (R3)
`client/src/main.tsx`
```diff
@@ -1,6 +1,8 @@
 import React from 'react'
 import ReactDOM from 'react-dom/client'
+import { isDrawing } from '@shared/fileKind'
 import { App } from './App'
+import { loadExcalidraw } from './drawings/engine'
 import { storage } from './lib/storage'
 import './app.css'
@@ -21,6 +23,15 @@
 // The app state lives in the main process (D9): load it (and this window's identity) before the first render.
 void storage
   .init()
   .catch((err: unknown) => console.error('[storage] init failed; rendering with defaults', err))
+  .then(() => {
+    // A window reopening onto a drawing will mount the canvas next: start the engine's download and
+    // compile NOW, in parallel with the first render, instead of after it (YAZ-2074, ~35 ms). Same
+    // ONE promise `ExcalidrawSurface` awaits, same offline pins; Welcome / draw.io windows skip it.
+    const file = storage.getFile()
+    if (file !== null && isDrawing(file)) {
+      loadExcalidraw().catch(() => {}) // the surface reports a failure itself, on the same promise
+      void import('@excalidraw/excalidraw/index.css')
+    }
+  })
   .then(render)
```
- **Risk:** low.
  - `engine.ts`'s own contract holds: the only import site is still `loadExcalidraw()`, and both globals are pinned inside it before the import.
  - `applyToolbarMode()` is still written before every mount, because the engine reads it at mount, not at import.
  - The no-drawing path is byte-for-byte unchanged.
  - If `storage.init` rejected, `getFile()` returns the default `null`, so nothing changes.
- **Proof:**
  - A startup trace should show `ResourceSendRequest percentages-*.js` at about 28–30 ms instead of 66 ms.
  - `realapp/cdp.mjs` nav→canvas median should drop by about 30 ms.
  - Add a unit test that main's boot calls `loadExcalidraw` only for a drawing identity.

### C4: engine-fork hygiene (R4, R5, R6). Big-change description, in the fork, then `tools/packEngine.mjs`.
- Drop `canvas-roundrect-polyfill`. The fork targets Chromium ≥142 only.
- Lazy-import `pako` behind the PNG metadata encode/decode paths.
- Make the Assistant `@font-face` in `index.css` and the runtime `Fonts` registry share one URL set, so each face is fetched once.
- **Risk:** medium, because it's engine code.
- **Proof:**
  - Fork tests.
  - Export PNG with embedded scene, then re-import it.
  - Check UI font rendering.
  - The trace should show one Assistant request set and no roundRect chunk.

## 4. Before/after estimates (renderer part of launch → interactive canvas, warm launches, M1 Max)
| | nav→canvas | spawn→canvas | app.asar | draw.io open |
|---|---|---|---|---|
| today (measured) | ~285 ms | ~580 ms | 72 MB | ~780 ms (lab) |
| + C1 code cache | ~255 | ~550 | 72 | **~670** |
| + C2 minify | ~250 | ~545 | **~66.7** | ~670 |
| + C3 engine warm-up | **~215** | **~510** | ~66.7 | ~670 |

On slower (Intel/low-end Windows) machines, parse and compile scale about 3–5×, so C1 and C2 matter proportionally more there.

## ARCHITECTURE DECISIONS FOR YASIN

**ARCH-1: Where does the draw.io and engine code cache live, and how big may it grow?**
- Problem: C1 adds about 20 MB (draw.io) + 1 MB (yaseen) to `~/Library/Application Support/Yaseen Draw/Code Cache`. That's disk, not app size.
- Options:
  1. Chromium default location and LRU.
  2. `session.setCodeCachePath()` into `Caches/` so macOS can purge it.
  3. Code cache for yaseen only (a separate scheme for drawio without `codeCache`).
- Recommendation: **1**. It's what Obsidian and VS Code do. It's self-managing, and the 113 ms per draw.io open is the biggest single renderer win.

**ARCH-2: Code-split the client's own features (Settings, Share, History, Image Studio, Presentation, draw.io host, Sharing page)?**
- Problem: they sit in the entry chunk (~150 KB minified).
- Options:
  1. `React.lazy` each dialog/page.
  2. Leave as is.
- Recommendation: **2**. Measured payoff is ≤3 ms (V8 preparses lazily; the entry evaluates in 9.9 ms total). Lazy loading adds Suspense states, failure paths and flicker on first open. That's a stability cost for no user-visible win. Revisit only if the entry grows past about 1 MB minified.

**ARCH-3: Unreachable engine locales (56 chunks, 1.56 MB raw)**
- Problem: the app never sets `langCode` and has no language picker, so they can't load.
- Options:
  1. Keep (zero runtime cost).
  2. Strip in the fork build, keeping `en`.
  3. Expose a language setting and make them a feature.
- Recommendation: **1 for now.** Removing them is size-only (~0.8 MB after minify) and contradicts "no feature loss" if a picker ever ships. Decide together with the size-forensics angle.

**ARCH-4: Source maps for the minified renderer**
- Problem: after C2, production stack traces in logs lose names.
- Options:
  1. No maps (today's behaviour, just shorter names).
  2. `sourcemap: 'hidden'` written outside `out/` and archived per release.
  3. Ship maps in the app (+~20 MB).
- Recommendation: **2**. You get debuggability at zero app size.

## EXECUTION ISSUE CANDIDATES
1. **Enable V8 code cache for `app://`** (C1). One line plus a startup A/B script: port `harness/bench.js` and `harness/drawio.js` into `tools/` as `perf:startup`. Joint with main-process F3.
2. **Minify the renderer build** (C2) plus a hidden-sourcemap archive (ARCH-4). Acceptance: `out/renderer/assets` ≤ 9.5 MB and the lazy-door smoke list passes.
3. **Warm the engine at boot for drawing windows** (C3) plus a unit test. Acceptance: trace shows the engine request < 35 ms after nav.
4. **Startup perf harness in-repo.** `tools/perf/` gets the CDP launcher (`realapp/cdp.mjs`), the trace analyser (`realapp/trace.mjs`) and the synthetic 885-element board generator. Record nav→canvas, spawn→canvas, heap, and draw.io ready, for regression checks on every release.
5. **Engine fork hygiene** (C4): drop the roundRect polyfill, lazy-load pako, and fetch Assistant once. Repack via `tools/packEngine.mjs`.
6. (Optional, decide in ARCH-3) strip unreachable locales in the fork build.
