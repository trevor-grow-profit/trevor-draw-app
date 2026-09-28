## Deep scope, 2 of 3: decisions (🔒 locked)

Yasin approved going with every recommendation (2026-09-27, before sleeping), under three guardrails: **stay on Electron**, **nothing changes how a feature looks or works**, and **work stays on the `yaz-2073-speed` worktree; no push/merge/release until he confirms**.

Where a finding's own recommendation broke a guardrail, the lock below picks the option that keeps looks and behavior identical. Those are marked ⚠️.

### 🔒 D1. Runtime shell: stay on Electron
- **Problem:** 10× smaller needs dropping Chromium.
- **Options:**
  1. Electron + trims.
  2. Tauri.
  3. Electrobun.
  4. Wails.
  5. Native Swift.
- **Locked: 1** (Yasin). Tauri means the Safari engine (unpinned per macOS version) with open Excalidraw bugs (#8156 grid lag, #5679 zoom vanish), a clipboard "Paste" prompt, ⌘Q quit-flush gaps, and a rewrite of 9.4k LOC of main plus 13k LOC of tests.
- **After:** same engine that every test and hand pass already validated. A WebKit readiness spike is kept as a **Future** issue.

### 🔒 D2. "10×" means per-dimension targets, not installed MB
- **Locked:** the targets table in scope comment 1 of 3. Each becomes a gate in `tools/perf/budget.json`.

### 🔒 D3. Chromium locale paks: trim to `en*` in `afterPack`; keep the 55 app `.lproj` folders
- **Options:**
  1. Keep all.
  2. Trim `locale.pak` in `afterPack` before codesign.
  3. `electronLanguages: ["en"]`.
- **Locked: 2.** Option 3 also deletes the app `.lproj` folders, which turns macOS Open/Save panels English for non-English users. Option 2 only affects Chromium-drawn widget strings, which already sit inside an English UI.
- **File:** `desktop/build/adhocSign.cjs`
```diff
 module.exports = async function adhocSign(context) {
   if (context.electronPlatformName !== 'darwin') return
   const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
+  trimChromiumLocales(app) // keep en*.lproj/locale.pak only; app-level .lproj markers stay (YAZ-2073 D3)
   execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
 }
```
- **After:** −48.7 MB installed, −11 MB DMG, no visible change.

### 🔒 D4. Drawer and panel animations: keep them exactly as they are ⚠️
- **Options:**
  1. Keep.
  2. Remove the 120 ms fades.
  3. Add a Reduce-motion toggle.
- **Locked: 1.** The smoothness finding recommended 2, but that changes how the UI looks. Measured, every drawer and panel already runs at p50 8.3 ms with no frame over 20 ms, so the drawers are not where the jank is.

### 🔒 D5. Image decoding: off-thread `createImageBitmap` at **full resolution** (engine fork) ⚠️
- **Problem:** the UI thread decodes every image (14–23 ms per 1440×822 PNG). A hover on a 121-image board froze the UI for 108–168 ms.
- **Options:**
  1. Full-res bitmap.
  2. Bitmap capped at 2048 px.
  3. Option 2 + LRU of mounted engines.
- **Locked: 1.** A cap would make big images blurrier when zoomed in, which is a visual change.
- **Guard:** measure RSS on the heavy board ×3 tabs, before and after. If RSS grows beyond +25%, stop and bring it to Yasin rather than cap silently.
- **Files:** fork `packages/excalidraw/element/image.ts`, `types.ts`, `renderElement.ts`, then repack with `tools/packEngine.mjs`.
- **After:** decode cost 20 ms → about 2 ms per image, off the UI thread.

### 🔒 D6. Hover-preview pixels: engine bitmaps + preview-sized thumbnails made in main
- **Options:**
  1. Bitmap only.
  2. Also main-side thumbnails per immutable `fileId` in `userData/thumbs/`.
  3. Also persist board preview PNGs.
- **Locked: 1 + 2.** Thumbnails are generated at **≥ preview size × devicePixelRatio**, so previews look identical. Assets are immutable, so the cache never invalidates. Nothing is written to the vault. Option 3 breaks YAZ-1800's "memory only" rule.
- **After:** a hover preview no longer ships up to 30.7 MB of base64 over IPC. Target: preview in under 300 ms.

### 🔒 D7. Legacy embedded-image boards: lean the load response only
- **Options:**
  1. Stop sending the image bytes twice over IPC.
  2. Auto-shrink on open.
  3. Leave it.
- **Locked: 1, with no new notice** (a notice would be new UI). Option 2 would break "a clean board is never written".

### 🔒 D8. Mounted editors: keep every visited tab mounted (no LRU) ⚠️
- **Locked: keep.** An LRU would drop a tab's undo history and add a remount delay, which is a behavior change. Memory is bounded instead by D5's guard and the 6D cache caps.

### 🔒 D9. File watcher: recursive `fs.watch` layer, behind a conformance suite; chokidar kept only as a polling fallback
- **Problem:** chokidar holds one fd per file (2,335 fds), adds about 260 ms per event, and is shipped unbundled.
- **Options:**
  1. Keep chokidar but share one instance.
  2. Native `fs.watch(root, {recursive:true})` + a thin classify/debounce layer.
  3. `@parcel/watcher` (native module).
- **Locked: 2.** Measured: 0 fds, 14 ms latency.
- **Fallback:** chokidar polling on non-local volumes, or if `fs.watch` throws, lazily loaded and **actually bundled**.
- **Gate:** a conformance suite that replays today's expectations:
  - an atomic save gives exactly 1 `change`
  - tmp files stay silent
  - `mkdir -p` gives `addDir` + `add`
  - rename
  - trash
  - a 200-file burst

### 🔒 D10. Tree answers: coalesce now; incremental `TreeIndex` → Future
- **Options:**
  1. Single-flight + one trailing walk per root, plus a renderer debounce.
  2. Incremental index.
  3. Delta pushes.
- **Locked: 1.** It removes the pathology (33 s → 0.9 s CPU measured). Option 2 adds index-consistency risk for a vault size we don't have yet. It becomes a Future issue, triggered when a vault walk takes over 100 ms or a vault has over 10k files.

### 🔒 D11. Quit sequence: restore it *and* extract a tested `runQuitSequence`
- **File:** `desktop/src/main/index.ts:238-245`
```diff
   quitting = true
   void manager
     .flushAllForQuit()
-    .finally(() => app.exit(0))
+    .then(() => Promise.allSettled([store.flush(), gitSync?.flushForQuit()]))
+    .finally(() => app.exit(0))
```
  This moves into a `runQuitSequence(deps)` module, with a test that fails if any step is missing.
- **After:** the edit made just before ⌘Q is saved, committed and pushed again, and this can't silently regress.

### 🔒 D12. Durability: fsync on every `atomicWrite`
- **Locked: fsync everywhere.** It costs about 5 ms on a 500 ms-debounced save. It also covers `landAssets`, and the secrets tmp file is opened 0600.

### 🔒 D13. V8 code cache: on, at Chromium's default location
- **File:** `desktop/src/main/index.ts:82`
```diff
-protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
+protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
```
- **After:** compiled JS is reused across launches: draw.io open −113 ms, canvas about −30 ms. The cache uses about 21 MB in userData and is self-managed LRU, like VS Code and Obsidian.

### 🔒 D14. Renderer: minify, with hidden sourcemaps kept outside the app
- **File:** `desktop/electron.vite.config.ts` (renderer `build`)
```diff
-    build: { outDir: rendererOut, rollupOptions: { input: resolve(client, 'index.html') } },
+    build: { outDir: rendererOut, minify: 'esbuild', sourcemap: 'hidden', rollupOptions: { input: resolve(client, 'index.html') } },
```
  The `.map` files are moved out of `out/` (gitignored `desktop/.maps/<version>/`) before packing.
- **After:** 14.7 → 9.4 MB of JS, entry chunk 973 → 413 KB. Stack traces can still be symbolicated locally.

### 🔒 D15. Keep as-is (measured, and not worth the risk)
- The client's own dialogs are not code-split: at most 3 ms gain, and it would add Suspense flicker.
- Excalidraw's 54 locale chunks stay: zero runtime cost, and dropping them is a feature-shaped removal.
- draw.io stays uncompressed at rest: compressing would add 20–30 ms to every editor open.
- share-viewer compression at rest stays off (after the font dedupe).
- `plugins: true` stays: no size change, and it may back PDF handling.
- arm64-only stays; never universal.
- V8 snapshot is skipped unless the launch budget is still missed after this project, and then only as a Future issue.

### 🔒 D16. Refactors for elegance: all feature-neutral
- **IPC contract as data:** one `CONTRACT` table in `shared/ipc.ts` generates the preload and renderer wrappers. That's about −700 to −900 LOC and deletes the drift test's reason to exist. Zero dependencies, not electron-trpc.
- **`useBoardDocument` hook + shell:** shared by the drawing and diagram editors. Not a generic `<BoardEditor>`.
- **Sidebar:** targeted render isolation (hover store, `memo(Tree)`, stable props, resize without app churn) plus decomposition into feature hooks. No React Compiler and no virtualization now.
- **Engine CSS selectors:** a pin test for the 36 engine-owned selectors. Moving them into the fork is left for later.
- **Engine vendoring model** (prod-only tgz + LFS, or a registry): **Future.** It has zero effect on app size or speed.

### 🔒 D17. The safety net
- **Playwright is ON.** Yasin explicitly overrides YAZ-1805 OD1 ("no Playwright") for this project. A Playwright `_electron` E2E suite runs against the built app with an isolated profile and seeded demo vaults, covering the feature inventory.
- **`docs/REGRESSION.md`:** the one growing hand-scenario list, which PRs cite.
- **`tools/perf/`:**
  - the size/integrity budget gate (in CI)
  - CDP perf harnesses for startup, draw.io open, frame time, hover preview and tree storm (local)
  - the budget ratchet: every PR lowers what it earned, and raising a budget needs Yasin's OK
- **Windows packaging CI** for PRs that touch `desktop/`, `tools/pack*` or `electron.vite.config.ts`.

### 🔒 D18. Upstream engine perf fixes: cherry-pick the ones with no visible change
- An audit of the fork vs upstream is running: #8697, #10578, #12050, #12180/#12183, #10648 and others.
- Pure-speed fixes get cherry-picked.
- Any PR that changes rendering visually (e.g. #10578's dark-mode inversion moving from a CSS filter to JS) is **not** taken and is brought to Yasin.
