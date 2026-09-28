# Renderer smoothness (client/src/** + our overlays on the vendored engine)

Angle owner: renderer-smoothness. Packaged v0.1.11 (`/Applications/Yaseen Draw.app`) driven over CDP (`--remote-debugging-port=9335`), MacBook Pro built-in XDR display at 120 Hz, window zoom 157% (DPR 3.15). The app was quit afterwards. Scratch windows were closed and their recents removed. Two empty `folders[...]` buckets for scratch paths remain in `yaseendraw.json`; the API has no delete for them, and they are harmless.

## TL;DR

- **Every drawer, panel and popover measured at 120 fps with zero dropped frames.** Each was measured over 2–3 open/close cycles on a light board and on a 121-image board. Nothing in them animates a layout property.
- **The real jank is image decoding on the main thread.**
  - Hovering an image-heavy board in the sidebar (the hover preview) froze the UI for 111–168 ms per hover in a visible window.
  - In a hidden window the same work produced 0.5–1.1 s long tasks.
  - A 31 MB legacy board took 3.7 s before its preview appeared.
  - Cause: the engine resolves images on `onload` and never pre-decodes, so the first `drawImage` of every image decodes synchronously on `CrRendererMain`. The trace shows 1,149 ms of `GpuImageDecodeCache::DecodeImage` on the main thread for one preview.
- Everything else found is low-impact hygiene: hover re-renders the whole tree, every save re-walks the vault tree, and save-status chip changes re-render the engine.

## 1. What I measured

**Harness** (one-off research scripts; the checked-in successors are under `tools/perf/`):

- `drive.mjs` is a CDP driver: Runtime, Input, Tracing and Profiler.
- `harness.js` injects an in-page rAF frame-delta sampler plus a `long-animation-frame` observer, and reports p50/p95/max and the number of frames over 20 ms and 50 ms.
- Traces: `export.trace.json`, `pan.trace.json`, `agentic.trace.json`. CPU profile: `export.cpuprofile`.

**Data sets**

- The user's live window, `boards-draw-growprofit` (3 rows, light board).
- A copy of Yasin's drawing vault without `.git` (99 MB, 84 files), opened in a second window. The real vault was never opened, so nothing could save into it.
- A synthetic 2,000-board vault (100 folders × 20 boards) with the heavy boards copied in.

**Drawer and panel frame times (120 Hz, so 8.3 ms is a perfect frame)**

| Action | Board | p50 | p95 | max | >20 ms |
|---|---|---|---|---|---|
| Canvas panel (rail ☰) open / close ×3 | light | 8.3 | 8.5–9.2 | 13 | 0 |
| Panel tab switch Images / Present / Components | light | 8.3 | 9.6–9.8 | 18 | 0 |
| Shell sidebar Hide / Show ×2 (canvas resizes) | light | 8.3 | 9.7–10.1 | 10 | 0 |
| Canvas panel open / close ×2 | 121-image board | 8.3 | 9.9–10 | 10 | 0 |
| Shell sidebar Hide / Show ×2 | 121-image board | 8.3 | 9.9–10.3 | 10 | 0 |
| Vault switcher open ×3 | 2,000-board vault | 8.3 | 9.8–10.1 | 10 | 0 |
| Mouse sweep over tree rows ×3 | 2,000 boards, 2,100 rows expanded | 8.3 | 10.3 | 17 | 0 |
| 5 external writes 600 ms apart (watcher refresh) | 2,000 boards | 8.3 | 9.8 | 10 | 0 |
| 3 freedraw strokes of 120 points each, autosave lands | 65-image board | 8.3 | 9.9–10.1 | 11 | 0 |

**Image paths (the jank)**

- **Hover preview, visible window, engine warm:**
  - Trevor (121 images, 9.3 MB): 1 frame of 167 ms. LoAF 168 ms, 117 ms blocking. Picture appears after 739 ms.
  - 8-1 Class (90 images, 9 MB): 108 ms frame. Picture after 630 ms.
  - Agentic Agency (31.5 MB, legacy embedded base64): picture after 3,718 ms. One run showed a 2,973 ms rAF gap.
- **The same preview pipeline run stage by stage in-page, window hidden:**
  - `drawing.load` IPC: 51 ms (8.5 MB of dataURLs) / 41 ms / 163 ms (30.7 MB).
  - `JSON.parse`: 4–31 ms. `restoreElements`: 4–6 ms.
  - **`exportToBlob`: 1,888 / 1,570 / 2,130 ms**, producing a PNG of only 80–248 KB.
  - Long tasks during that run: **858, 521, 1,071 ms**.
- **What the trace says:**
  - `CrRendererMain` spent `GpuImageDecodeCache::DecodeImage` 1,149 ms and `RasterCHROMIUM` 1,191 ms, with one `RunTask` of 1,742 ms.
  - The JS profile is mostly idle (1,042 ms), so the cost is Blink decoding images, not our code.
- **Decode strategy micro-benchmark** (1440×822 PNG from the vault, sync `drawImage` onto an 800×600 canvas):

  | Strategy | Sync `drawImage` | Async prep |
  |---|---|---|
  | `onload` only (what the engine does) | 14–16 ms | 0 ms |
  | `img.decode()` | 14–23 ms (**no help**) | 13–19 ms |
  | `createImageBitmap(img)` | **2 ms** | 12–13 ms, off-thread |

- **Opening boards:**
  - Legacy Agentic Agency: long tasks 59 + 104 + 290 ms before the canvas appears (~620 ms).
  - Assets-backed boards (65–121 images): canvas in 90–122 ms, worst frame 50–68 ms.
- **Unattributed:** a ~2.9 s rAF gap appeared on the first wheel/pan after opening a heavy board, 4 times across 2 runs. It did not reproduce in 3 later runs. There was no long event on the renderer or browser main threads (the GPU process is not visible from a page-target trace). Treat it as a follow-up, not a finding.

**Memory, after the session:**
- Renderer RSS: 184 MB (light window), 313 MB and 335 MB (windows that had opened heavy boards).
- Main process: 490 MB RSS. That belongs to the main-process angle.
- JS heap: 23–27 MB, so decoded bitmaps and strings live outside the JS heap.

## 2. Findings ranked by user-visible jank

### F1 — HIGH: image decode happens synchronously on the main thread; the hover preview is the worst trigger

**Evidence:**

- `client/src/sidebar/boardPreviewCache.ts:53-66` (`drawBoardPreview`) loads the **full** board with every full-resolution image as base64 over IPC, just to draw a picture of at most 1200×800 (`BOARD_PREVIEW_BOUNDS`, `:23`).
- It then calls `createScenePreviewPng` → `engine.exportToBlob` (`client/src/lib/scenePreview.ts:63-76`).
- Main side: `desktop/src/main/fs/drawing.ts:137-140` does `readFile` then `bytes.toString('base64')` for every referenced asset on every preview.
- Engine side: the fork's `packages/element/src/image.ts:21-32` resolves on `onload` with no decode, and `renderElement.ts:466-476` does `drawImage(img …)`. That forces a synchronous decode of every image on first draw, measured at 14–16 ms per 1440×822 PNG and ~1.1 s for a 121-image board.
- The same path runs when a board opens in the editor and when an image first scrolls into view (`App.addNewImagesToImageCache` → `updateImageCache`). That is the 290 ms long task when opening Agentic Agency.
- The cache is in memory only (`limit: 32`, `:69`) and keyed by mtime (`:33-35`). The first hover after every launch and after every save repeats the whole cost.

**Fix A (engine fork, small): decode off-thread once, then draw from an `ImageBitmap`.** The fork was at `e72242f8`.

```diff
--- a/packages/element/src/image.ts
+++ b/packages/element/src/image.ts
@@ -60,15 +60,24 @@
               const imagePromise = loadHTMLImageElement(fileData.dataURL);
               const data = {
                 image: imagePromise,
                 mimeType: fileData.mimeType,
               } as const;
               // store the promise immediately to indicate there's an in-progress
               // initialization
               imageCache.set(fileId, data);
 
               const image = await imagePromise;
-
-              imageCache.set(fileId, { ...data, image });
+              // Decode OFF the main thread, once. A bare `onload` image is decoded
+              // synchronously by the first drawImage (measured 14–16 ms per 1440×822
+              // PNG; `img.decode()` does not help canvas). SVG stays an element so it
+              // keeps rasterising at the drawn size.
+              const bitmap =
+                fileData.mimeType !== MIME_TYPES.svg &&
+                typeof createImageBitmap === "function"
+                  ? await createImageBitmap(image).catch(() => undefined)
+                  : undefined;
+              imageCache.set(fileId, { ...data, image, bitmap });
             } catch (error: any) {
```

```diff
--- a/packages/excalidraw/types.ts
+++ b/packages/excalidraw/types.ts
@@ -1109,5 +1109,7 @@
     {
       image: HTMLImageElement | Promise<HTMLImageElement>;
+      /** Pre-decoded pixels for drawImage (raster only); `image` keeps naturalWidth etc. */
+      bitmap?: ImageBitmap;
       mimeType: ValueOf<typeof IMAGE_MIME_TYPES>;
     }
```

```diff
--- a/packages/element/src/renderElement.ts
+++ b/packages/element/src/renderElement.ts
@@ -464,5 +464,5 @@
           }
 
           context.drawImage(
-            img,
+            cacheEntry?.bitmap ?? img,
             x,
             y,
```

Apply the same `cacheEntry?.bitmap ?? img` swap to the dark-invert `tempContext.drawImage(img, …)` call near line 421.

Also close bitmaps where cache entries are dropped (`imageCache.delete` / App unmount): `entry.bitmap?.close()`.

- **Risk:**
  - An `ImageBitmap` pins decoded pixels (w×h×4). A 121-image board of ~1440×822 PNGs is ~4.7 MB each, **~570 MB if every image is pinned**. Chromium's discardable decode cache would otherwise evict them. This must be measured (RSS before/after) with the Trevor board plus 3 mounted heavy tabs.
  - Mitigation: `createImageBitmap(image, { resizeWidth: min(naturalWidth, 2048), resizeQuality: 'high' })`, or bitmap only when `naturalWidth*naturalHeight > 1 MP`.
  - `naturalWidth` readers (crop, stats, `Actions.tsx`, `App.tsx`) keep using `image`, so nothing changes for them.
- **Proof of no regression:**
  - Fork unit tests.
  - `yaseenRender.test.mjs` and export snapshot tests: pixel-diff exported PNGs before/after on the demo vault.
  - Crop, flip and dark-mode invert on an image.
  - Re-run `s_big3.mjs` / `s_heavy.mjs`. Target: max frame < 20 ms on hover and open.

**Fix B (app, medium): preview-sized pixels for the preview.** Assets are immutable and content-addressed (`<sha1>.<ext>`), so a thumbnail keyed by `fileId + maxPx` never goes stale.

- Add `drawing:load` option `{ imageMaxPx?: number }`, used only by `boardPreviewCache.ts:56`.
- In main, `nativeImage.createFromBuffer(bytes).resize({ width: …, quality: 'good' })`, cached under `userData/thumbs/<fileId>-<px>.png` (or in memory in main).
- Expected effect: the Agentic IPC payload drops from 30.7 MB to a few hundred KB, and renderer decode drops by roughly (orig px / thumb px)², ~20–50× on these boards.
- Legacy embedded entries (`sceneFiles` `:145-146`) need the same resize.
- **Risk:**
  - nativeImage decode+resize runs on the main-process thread. Do it in a `utilityProcess`, or at least cache it so it happens once per asset.
  - Writes to `userData`: see Decision D2.
  - Proof: `boardPreviewCache` tests plus the preview integration test (`previewVault.integration.test.ts`); visual check with `seedPreviewDemoVault.mjs`.

**Fix C (app, tiny, optional): don't hand the preview images it will not show.** Filter `files` to ids referenced by *visible* elements before `exportToBlob`. It is already true that only referenced ids are loaded, so the gain is small. Listed only for completeness.

### F2 — MEDIUM: opening a legacy (embedded-base64) board blocks for ~450 ms

- **Evidence:**
  - Agentic Agency (31.5 MB): 3 long tasks of 59, 104 and 290 ms between click and canvas.
  - Assets-backed boards with 65–121 images open in ~90 ms.
  - Contributors:
    - `drawing:load` returns `json` still containing all embedded bytes. `DrawingEditor.tsx:117-123` → `parseSceneText` parses 31 MB.
    - The `files` map is sent a **second** time in `res.files` (`desktop/src/main/fs/drawing.ts:119-120` plus `sceneFiles` `:145-146`), so IPC carries ~62 MB.
    - The decode cost from F1.
- **Fix, main side (small):** send `stripEmbeddedFiles(json).json`, the lean scene, as `json` in `loadDrawing`. The embedded bytes already travel in `files`. The renderer never needs them twice. On the next save `liftEmbedded` still sees the embedded bytes on disk, because it reads `json` from the request… **careful:**
  - `saveDrawing` lifts from the *request* json (`drawing.ts:233`). Once the renderer sends lean json it can no longer find the embedded bytes there, and would rely on `newFiles`.
  - That is already covered: `unpersistedFiles(files, referenced, persisted)` (`DrawingEditor.tsx:209`) sends every live, non-stored file.
  - So the lean load is safe, but it needs an explicit test: "legacy board, open, edit, save → assets/ gets every embedded picture; scene lean".
  - This touches main's contract. Coordinate with the main-process angle.
- **Risk:** medium (data path). Prove it with `drawing.test.ts`, `shrink.test.ts` and a new integration test on a legacy fixture.
- Fix A from F1 removes the decode share.

### F3 — LOW (scales with vault size): hover enter/leave re-renders the whole Sidebar and Tree

- **Evidence:**
  - `client/src/sidebar/Sidebar.tsx:436-452`: every row enter/leave calls `setHover(...)`, twice per row crossed (close, then pending) plus once at dwell. It lives in the 1,499-line `Sidebar`.
  - `Tree` is not memoized (`Tree.tsx:155`).
  - Its props are rebuilt on every render: `expanded={new Set(expanded)}` (`Sidebar.tsx:1392`, `:1421`), inline `onToggle` (`:1394`, `:1423`), and object literals `fileMove`/`selection`/`pending`/`favoriteReorder` (`:1102`, `:1131`, `:1144`, `:1150`).
  - Measured at 2,100 expanded rows: **4.8 ms p50, 8.8 ms max per hover event** (React commit), ~10 ms per row crossed, which is above the 8.3 ms frame budget. The real mouse sweep stayed under 20 ms per frame (max 17).
  - At the owner's current vault size (84 files) it is negligible.
- **Fix (medium refactor, no behaviour change):**
  - Move `hover` out of Sidebar state into a tiny external store, the same `createLauncherStore` pattern as `LauncherRail.tsx:53-72`.
  - `hoverFile` writes the store.
  - A `<HoverPreviewHost>` subscribes with `useSyncExternalStore`, resolves `hoverNode` off `tree`, and renders `<BoardPreview>`.
  - The effects at `:462-469` move with it.
  - Then Sidebar re-renders zero times per hover.
- **Risk:** low. The existing hover-preview tests in `Sidebar.test.tsx` (~`:3069+`) pin the behaviour, including dwell, Escape, blocked-by-menu and closing on activeFile change.

### F4 — LOW: every file change re-walks the whole vault and re-renders the tree

- **Evidence:**
  - `Sidebar.tsx:538-545` calls `refresh()` on **every** watcher event, deliberately (YAZ-1835 D4).
  - `refresh` → `api.tree(root)` → a main-process walk that reads every board head. Measured **47–65 ms per call at 2,000 boards**.
  - The answer is always a fresh object (`:523`), so `sortTree`/`allDirs`/`buildBoardCatalog` recompute and the full Tree re-renders.
  - Every autosave produces one event per window open on that vault. Renderer frames were unaffected (p95 9.8 ms); the cost is main-process time, which is shared by all windows' IPC.
- **Fix (small, keeps D4):** coalesce with a trailing 150 ms timer so a burst of events is one walk. It is idempotent, and `generatedAt` already guards ordering.

```diff
--- a/client/src/sidebar/Sidebar.tsx
+++ b/client/src/sidebar/Sidebar.tsx
@@ -536,10 +536,19 @@
   // `updatedAt`, and with it its place under "Last updated" — in this window and every other one
   // on the vault. `ready` also fires on every watch (re)subscription, covering missed events.
-  useEffect(
-    () =>
-      watch.subscribe((ev) => {
-        if (ev.type === 'error') setError(ev.message)
-        else refresh()
-      }),
-    [watch, refresh],
-  )
+  // Coalesced: a burst (save → rename → asset writes) is ONE walk, 150 ms after the last event.
+  useEffect(() => {
+    let timer: ReturnType<typeof setTimeout> | null = null
+    const off = watch.subscribe((ev) => {
+      if (ev.type === 'error') return setError(ev.message)
+      if (timer !== null) clearTimeout(timer)
+      timer = setTimeout(() => { timer = null; refresh() }, 150)
+    })
+    return () => { off(); if (timer !== null) clearTimeout(timer) }
+  }, [watch, refresh])
```

- **Risk:** tests that assert an immediate refresh after a watch event need fake timers to advance 150 ms. Also check the reveal-after-create flow (`pendingReveal`, `:369`), which waits for the tree.
- **Bigger follow-up:** patch a single node's `mtime`/`updatedAt` for `change` events instead of a full walk. That is a main-process contract change, so it belongs with the main-process angle.

### F5 — LOW: save-status chips re-render the whole `<Excalidraw>` 2–3× per save

- **Evidence:**
  - `DrawingEditor.tsx:362-370`: `renderTopRight` depends on `status`.
  - `ExcalidrawSurface.tsx:519-522`: `renderTopRightUI` is rebuilt, the memoized `<Excalidraw>` misses and re-renders.
  - Status goes unsaved → saving → saved, 3 transitions per save (`autosave.ts:147-151`).
  - Measured: no dropped frames across strokes with saves landing (p95 ≤ 10.1 ms). This is hygiene, and it goes against the file's own "every prop handed to the engine is stable" rule (`ExcalidrawSurface.tsx:41-46`).
- **Fix (small):** do what the rail does. Keep `status`, `sync` and `onSyncNow` in a `createLauncherStore`-style store. `renderTopRight` becomes `useCallback(() => <Chips store={chips} />, [chips])`, which is stable, and an effect `chips.set({ status, sync, onSyncNow })`.
- **Risk:** low. The `DrawingEditor.test.tsx` chip assertions cover it.

### F6 — INFO: drawer and animation inventory (no jank; the owner's "animation" is intentional motion, not dropped frames)

| Where | What | Property | Cost |
|---|---|---|---|
| `app.css:945-963` vault switcher panel | `vault-switcher-in` 120 ms | opacity + translateY | compositor-only; respects `prefers-reduced-motion` |
| `app.css:699-711` hover-preview image | fade 120 ms | opacity | compositor |
| `app.css:239,292` link notice | 120 ms in | opacity + translateY | compositor |
| `app.css:1264` tree chevron | 120 ms | transform | compositor |
| `statusChips.css:32,45` saving/syncing dot | `chip-pulse` 0.9 s infinite | opacity | compositor, only while saving/syncing |
| `app.css:893-910` `.scroll-strip` | scroll-driven `mask-image` | mask (**paint**) | repaints the tab strip only while it scrolls |
| `presentation.css:283` player controls | `backdrop-filter: blur(14px)` over the canvas | filter | re-blurs a small pill each frame while the canvas animates; small area |
| Engine `DefaultSidebar` (canvas panel) | **none**. The `Island` mounts and unmounts instantly. The engine CSS has `.layer-ui__wrapper.animate{transition:width .1s}` (dev `index.css:6264`), but no JS applies `animate`, so it is dead. | — | — |

- Nothing animates `width`/`height`/`left`/`top`/`margin`.
- No `backdrop-filter` or large blurred shadows sit over the canvas while panels open. The `.board-preview` box-shadow is static.
- If the owner's "drawer animation" is the vault switcher's 120 ms settle-in, removing it is a product call (D1), not a performance fix.

### F7 — INFO: mounted tabs are unbounded

- `useWorkspace.ts:23-27`: every tab visited since boot stays mounted, each with its own engine, image cache and decoded bitmaps.
- Measured renderer RSS: 184 MB (light) vs 313–335 MB (windows that opened heavy boards).
- It combines with F1-A (pinned bitmaps). See D3.

### Not an issue (checked)

- `onChange` → `snapshotOf` is O(n) `getSceneVersion`. `serialize()` runs only when the 500 ms debounce fires (`autosave.ts:153-156`). There is no `JSON.stringify` per change.
- `setHasSelection` bails out on an equal boolean, and `rail.set` no-ops on equal values (`LauncherRail.tsx:67`).
- Component and media previews are memoized, with `loading="lazy"` (`previewCache.tsx:28-76`). Component previews are stored PNGs, not re-rendered.
- Search is a synchronous rank per keystroke with no debounce (`useSearchResults.ts:3`). Not measured; the catalog is memoized on `tree`.
- Workers: the only heavy main-thread work found is Blink image decode (F1). Moving `exportToBlob` into a worker is not viable (it needs DOM, fonts and Path2D); `createImageBitmap` is the worker-free fix.

## 3. ARCHITECTURE DECISIONS FOR YASIN

**D1 — The drawer motion**

- **Problem:** "opening the drawer, there's an animation." No drawer drops frames. The motion that exists is deliberate: the vault switcher's 120 ms settle-in, and the 120 ms fade of the hover-preview image.
- **Options:**
  1. Keep it as is.
  2. Remove all 120 ms entrance animations (instant UI).
  3. Add a Settings › Appearance "Reduce motion" toggle that also forces the engine's `animations-disabled`.
- **Recommendation:** first confirm which drawer you meant. If it is the vault switcher or the preview, choose **2**. At 120 Hz an instant open reads as faster, and the code already disables it for `prefers-reduced-motion`, so it is a 3-line CSS removal.

**D2 — Where preview pixels come from**

- **Problem:** a hover preview ships every full-res image as base64 (up to 30.7 MB) and decodes it on the UI thread, every launch and every save.
- **Options:**
  1. Engine bitmap decode only (F1-A).
  2. Also main-side downscaled thumbnails per immutable `fileId` in `userData/thumbs/` (F1-B).
  3. Also persist the board preview PNG per (path, mtime, theme). This contradicts YAZ-1800's "memory only" rule.
- **Recommendation:** **1 + 2.** 1 fixes the canvas as well. 2 makes previews cheap forever, because assets are immutable, so the cache never invalidates and needs no sweep beyond orphan GC. It writes nothing to the vault. 3 is unnecessary once 2 lands.

**D3 — Decoded-pixel memory vs smoothness**

- **Problem:** F1-A pins decoded pixels (~570 MB worst case for one 121-image board). Unbounded mounted tabs (F7) multiply that.
- **Options:**
  1. Bitmap at full resolution.
  2. Bitmap capped at 2048 px on the long side.
  3. Option 2 plus an LRU of mounted engines (e.g., 5), where evicted tabs remount on activation (costing ~100 ms on a heavy board).
- **Recommendation:** **2 now; 3 only if RSS measurements say so.** Keep an unbounded mount list until there is a measured memory problem, since tab switching is instant today.

**D4 — Legacy embedded boards**

- **Problem:** legacy boards open about 5× slower and ship their bytes twice.
- **Options:**
  1. Lean the load response (F2).
  2. Auto-shrink on open (write to the vault without an edit).
  3. Leave it to Settings › Storage › "Move pictures out".
- **Recommendation:** **1** (no writes, no feature change), plus a one-time passive notice on a legacy board that points to option 3. Never 2: writing on open breaks "a clean board is never written."

## 4. EXECUTION ISSUE CANDIDATES

1. **Engine: off-thread image decode via ImageBitmap** (fork `image.ts`, `types.ts`, `renderElement.ts`; repack with `tools/packEngine.mjs`). Includes an RSS measurement on the Trevor board ×3 tabs and a pixel-diff export test. Accept when hovering or opening a 121-image board has max frame < 20 ms.
2. **Main: preview-sized image thumbnails for `drawing:load`** (`imageMaxPx`, nativeImage resize, `userData/thumbs/<fileId>-<px>`, off the main-process thread). Wire it into `boardPreviewCache.ts:56`. Accept when the Agentic Agency preview shows in < 300 ms.
3. **Main: lean `drawing:load` json for legacy boards** (no double payload), plus a legacy open→edit→save integration test.
4. **Sidebar: hover state out of Sidebar render** (external store and `HoverPreviewHost`). Accept at 0 Sidebar renders per hover (React Profiler / test spy).
5. **Sidebar: coalesce watcher-triggered tree refresh (150 ms trailing)** (diff above).
6. **DrawingEditor: chips via store, so `<Excalidraw>` props stay stable** (diff sketch in F5).
7. **(Decision D1) Remove 120 ms entrance animations**, or add Reduce Motion.
8. **Follow-up investigation: the 2.9 s first-pan rAF gap** after opening an image-heavy board. Needs a GPU-process trace from a browser-target CDP connection or `--trace-startup`.
9. **Perf regression harness:** check in the CDP drive, harness and scenario scripts as `tools/perf/` (drawers, hover preview, heavy open, freedraw), with a p95/max budget per scenario.
