## Deep scope, 1 of 3: what we measured and what we found

Base: `main` @ `51e85cd` (v0.1.11). Eight research angles ran in parallel:
- size forensics
- runtime shell
- renderer bundle
- main process
- renderer smoothness
- feature safety net
- optimization discipline research
- code health

The full findings files (about 2,000 lines, with numbers, file:line evidence and diffs) are the source for every issue below.

### Baseline (v0.1.11, arm64, measured)

| Metric | Today |
|---|---|
| Installed .app | **371 MB**: Electron framework 273, app.asar 72, share-viewer 23 |
| DMG download | **172.5 MB** (zlib/UDZO) |
| Launch → canvas (real vault) | **about 580 ms** (spawn → nav 290 ms, nav → canvas 285 ms) |
| Open a draw.io diagram | **782 ms** |
| Renderer JS shipped | 14.7 MB, **unminified**, plus 13.8 MB of sourcemaps in `out/` |
| V8 code cache | **off** for `app://`, so every launch recompiles everything (`Code Cache/js` is empty) |
| Main process idle | 49 MB phys footprint, about 1% CPU |
| Hover preview of a 121-image board | **UI frozen 108–168 ms**; a 31 MB legacy board takes 3.7 s |
| Tree storm (230 boards changed in a 2,000-board vault) | main **33 s CPU / 3.16 GB**, IPC stalls up to 1.9 s, one save took 13.8 s |
| Drawer / panel / sidebar open-close | **already smooth**: p50 8.3 ms, no frame over 20 ms at 120 Hz |
| Tests | 2,575 tests (166 files) pass in 46 s; typecheck passes in 5.6 s |

### Headline findings

- **10× smaller can't happen on Electron.** Chromium alone is 227 MB after every safe trim. The realistic best is about −30% installed and about −35% download. A system-webview shell (Tauri etc.) could reach about 50 MB but means a rewrite onto an unpinned Safari engine with open Excalidraw bugs. Yasin chose Electron (see decisions).
- **10× faster and smoother is realistic, because those numbers come from our code:**
  - image decoding on the UI thread: 20 ms → 2 ms per image with `createImageBitmap`
  - the tree-refresh storm: 33 s → 0.9 s CPU
  - upstream Excalidraw's O(n²) drag fix: 643 → 54 ms per frame at 4k elements; whether the fork has it is being audited
  - the code cache: draw.io open −113 ms
- **Data-safety bug on `main` right now:** commit `82d63ce` accidentally deleted `store.flush()` + `gitSync.flushForQuit()` from the quit handler (`desktop/src/main/index.ts:238-245`). Measured: an edit made 2.5 s before ⌘Q was never committed or pushed.
- **Other reliability gaps:**
  - no fsync in `atomicWrite`, so a crash can leave an empty board
  - a watch subscribe/unsubscribe race leaks subscriptions
  - two Windows path bugs: double-click open, and adding a favorite
  - chokidar is **not** bundled even though the config comment and CONTRACTS say it is (`out/main/index.js:9` still `require`s it)
- **Pure waste in the package:**
  - DMG uses zlib; LZMA saves −33.6 MB of download
  - duplicate font copy in share-viewer: −13.7 MB
  - unused Chromium locale paks: −48.7 MB installed
  - renderer not minified: −5.3 MB, and the entry chunk goes 973 → 413 KB
- **The code is already disciplined.** knip finds 0 unused files and there is 0.49% copy-paste. The refactor wins are structural:
  - the IPC bridge is written out 5× (1,229 lines)
  - `DrawingEditor` / `DrawioEditor` duplicate the save/conflict state machine
  - `Sidebar.tsx` is 1,499 lines with no memoization: hovering a row re-renders the whole tree, and resizing re-renders the whole app per mouse move
- **Unexplained:** a ~2.9 s frame gap on the first pan after opening a heavy image board. It happened 4× in 2 runs and didn't recur in 3 more. It gets its own investigation issue.

### Targets for this project (per dimension; each becomes a budget gate)

| Dimension | Before | Target |
|---|---|---|
| DMG | 172.5 MB | **≤ 115 MB** |
| Installed | 371 MB | **≤ 300 MB** |
| Launch → canvas | about 580 ms | **≤ 450 ms** |
| draw.io open | 782 ms | **≤ 650 ms** |
| Hover preview on a 121-image board | 108–168 ms freeze | **no frame over 20 ms, preview under 300 ms** |
| Opening an image-heavy board | long tasks around 450 ms+ | **no long task over 50 ms from image decode** |
| Drag at 1k / 4k elements | TBD (baseline in 1B) | **≥ 5× faster if the upstream fix is missing** |
| Tree storm (230 changes / 2k vault) | 33 s CPU, 3.16 GB | **≤ 1 s CPU, ≤ 250 MB** |
| Sidebar hover | whole-tree re-render | **0 Sidebar renders per hover** |
| Features lost | — | **0** (enforced by the E2E suite + REGRESSION.md) |
