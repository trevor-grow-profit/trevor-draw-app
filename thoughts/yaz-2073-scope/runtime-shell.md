# Angle: runtime-shell — should Yaseen Draw leave Electron?

Scope: the shell/runtime decision (Electron vs Tauri / Electrobun / Wails / Neutralino / native Swift), plus the Electron-side size levers that lose no features. Repo is read-only; every measurement below was taken on a scratch copy.

---

## 1. What I measured

| Item | Number | How |
|---|---|---|
| Installed `.app` | **371 MB** | `du -sh` on `desktop/dist-app/mac-arm64/Yaseen Draw.app` |
| `Electron Framework.framework` | **273 MB** (binary 183 MB, Resources 65 MB, Libraries 24 MB) | `du -sh` |
| Locale paks in the framework | **220** `*.lproj/locale.pak` (Electron 43 ships `_FEMININE/_MASCULINE/_NEUTER` variants), **47.2 MB**. Non-`en*`: **46.5 MB** | `du -sk Resources/*.lproj` |
| Libraries | `libvk_swiftshader` 16 MB, `libGLESv2` 6 MB, `libffmpeg` 2.1 MB | `du -sh` |
| App payload | `app.asar` 72 MB (built `out/`: drawio 50 MB, renderer 28 MB, main 284 KB) + `share-viewer` 23 MB = **95 MB** | `du -sh` |
| Compressed share (gzip -6) | Frameworks **113 MB**, payload **51 MB** | `tar | gzip | wc -c` |
| DMG as shipped | **164.5 MB** (UDZO/zlib) | `hdiutil imageinfo` |
| Same DMG, re-encoded as ULMO (lzma) | **132.5 MB (−32 MB, −19.5%)** | `hdiutil convert -format ULMO` |
| App with non-`en` framework locales pruned | **325 MB installed (−46 MB)**; ULMO DMG 128.4 MB (only −4 MB, because lzma already dedups the paks) | copy in `$SCRATCH/runtime-shell/stage`, then `hdiutil create` |
| Does the pruned copy launch? | **Yes.** 4 processes up, userData + `yaseendraw.json` written, empty stderr | ran it with `YASEEN_DRAW_USER_DATA_DIR=$SCRATCH/runtime-shell/ud`, killed after 6 s |
| Live memory (Yasin's running v0.1.11, 2 windows) | **5 processes, 616 MB RSS.** Main process alone: **182 MB** | `ps -axo rss,comm` |
| Main-process code | **9,377 LOC** non-test TS (main + preload + channels), **13,094 LOC** of tests, **93** IPC channels | `wc -l` on `desktop/src` |
| Calibration: installed apps on this Mac | VS Code 856 MB, Claude 880 MB, Obsidian 482 MB, Linear 471 MB, Notion 291 MB, Slack 321 MB (all Electron). Non-Electron: **ExcalidrawZ 104 MB** (SwiftUI + WKWebView; 32 MB binary + 44 MB Excalidraw web assets), Ghostty 62 MB, Telegram 249 MB | `du -sh /Applications/*` |

**The arithmetic that settles "an order of magnitude".** 10× smaller is about 37 MB installed. Even after pruning its locales, Electron's framework alone is **227 MB**, about 6× that target. **No Electron configuration can reach 10×.** Only a system-webview shell can, and only if the payload also shrinks: at today's 95 MB of payload, even Tauri lands around 105 MB.

---

## 2. What the main process actually uses (full inventory, `desktop/src/**`)

**Electron APIs.** The only Electron imports are in `index.ts:1`, `ipc/{envelope,window,watch,dialog,broadcast,drawing,components,share}.ts`, `fs/{reveal,openDefault,openInVsCode,remove,openLink}.ts` and `preload/index.ts:1`.
- `app`:
  - single-instance lock plus `second-instance` argv routing (`index.ts:29-44`)
  - `setAsDefaultProtocolClient('yaseendraw')` (`:47`)
  - `open-url` and `open-file` before `ready` (`:61-75`)
  - `before-quit` flush handshake, load-bearing for sync integrity (`:237-245`)
  - `window-all-closed` → quit
- `protocol.registerSchemesAsPrivileged` + `protocol.handle('app')` (`:82, :171-183`), routed by host:
  - `app://yaseen` serves the renderer
  - `app://drawio` serves draw.io on its own origin, with the CSP injected per response (`drawio/assets.ts` `DRAWIO_CSP`)
- `BrowserWindow` (`:95-113`):
  - multiple windows, restored bounds, theme `backgroundColor`
  - sandbox, contextIsolation, preload
  - `plugins: true` (`:99`): dead config, since the client has no PDF use
  - `setWindowOpenHandler`, `setZoomLevel` (`:193`)
  - `context-menu` with spellcheck (`replaceMisspelling`, `addWordToSpellCheckerDictionary`, `:104-108`)
- `Menu` (application menu rebuilt on store change and on focus; context menu), `nativeTheme.themeSource`, `screen` work areas, `net.fetch` (protocol file serving)
- `powerMonitor` `resume` / `unlock-screen` → git pull (`:224-225`)
- `shell`: `openExternal`, `openPath`, `showItemInFolder`, `trashItem` (every delete; `fs/remove.ts:47`)
- `dialog` open/save (`ipc/dialog.ts:61-62`)
- `ipcMain.handle`/`on` plus `webContents.send`; `contextBridge`
- **Not used:** `printToPDF`, `capturePage`, offscreen rendering, `webview`, `BrowserView`, `safeStorage` (dropped in YAZ-1842, `secrets.ts:11`), `clipboard`, `Tray`, `Notification`, `autoUpdater`, `crashReporter`

**Node APIs.** No native modules. The only runtime dependency is `chokidar@4`.
- `fs/promises` and `fs` everywhere (atomic writes, bounded reads)
- `child_process.execFile`, system git from a fixed absolute path, no bundled git (`git/exec.ts:1, :38-50`)
- `worker_threads` for storage stats and shrink (`storageJob.ts:1`, `storageWorker.ts:1`)
- `crypto` (`randomUUID`), `os`, `url`, `buffer`
- global `fetch` for media providers (`media/providers.ts:98`) and the Cloudflare API (`share/cloudflare.ts`)

**Renderer boundary.** One seam: `window.yaseenDraw` (typed `YaseenDrawApi`), with 90 references in `client/src`. The renderer never imports Electron. `windows.ts` is already Electron-free (it takes a `WindowHost` injection, `windows.ts:68-78`). Architecturally, the shell is swappable.

**Browser APIs in the bundled renderer** (grepped over `desktop/out/renderer/assets/*.js`), with the WebKit relevance of each:
- `navigator.clipboard.read` / `ClipboardItem` (engine, `percentages-*.js`): WKWebView shows a native **"Paste" confirmation bubble** on `clipboard.read()`.
- `.pressure` ×28, `tiltX` (freedraw): pen pressure on macOS WebKit with tablets is **UNCONFIRMED**.
- `OffscreenCanvas`, `createImageBitmap`, `WebAssembly`, module `new Worker` (pica, image-blob-reduce, font-subset worker): all supported in Safari 17+.
- `roundRect` ×65: Safari 16+.
- `ctx.filter` for dark-mode SVG images: the engine already has an `is$1` (Safari) pixel-inversion fallback (`index-CTfqWGQk.js`, "image" case). Upstream Excalidraw is Safari-aware.
- `showOpenFilePicker` / `showSaveFilePicker` (browser-fs-access): feature-detected with an `<input>` fallback. The app uses its own IPC dialogs anyway.
- `requestIdleCallback` (CodeMirror, guarded), `EyeDropper` (only a prop name), `launchQueue` (PWA, unused).
- App code (`client/src`) is clean: `clipboard.writeText` only, and locales are pinned (`lib/format.ts:2` `'en-US'`, `lib/relativeTime.ts:7` `'en'`).

---

## 3. Findings, ranked by impact

1. **An order-of-magnitude size cut requires dropping Chromium, and that is an engine change, not a refactor.** On macOS it swaps Blink for WKWebView, whose version is tied to the OS and cannot be pinned. Concrete, currently open upstream Excalidraw Safari bugs hit features this app ships:
   - [#8156](https://github.com/excalidraw/excalidraw/issues/8156): the grid makes panning and creating elements laggy in Safari (macOS and iPadOS). Grid is a persisted user pref (`shared/canvasPrefs.ts:41`).
   - [#5679](https://github.com/excalidraw/excalidraw/issues/5679): content disappears when zoomed in, from the canvas area limit. "Safari on all devices".
   - [#1246](https://github.com/excalidraw/excalidraw/issues/1246): Safari memory warnings on large scenes.

   So WebKit would make the canvas **less** smooth, not more. It fails "no stability loss" unless each of these is fixed in the fork first.
2. **Electron's floor is about 227 MB framework plus payload.** Zero-risk Electron levers:
   - `electronLanguages`: −46 MB installed (measured, and the pruned copy launches)
   - DMG `ULMO`: −32 MB download (measured)

   Together, about 12% installed and 20% download. Real but modest.
3. **The payload (95 MB) is the biggest thing we fully control, and it is shell-independent:** drawio 50 MB, share-viewer 23 MB, excalidraw-assets 13 MB. Whatever shell is chosen, that work comes first. On Tauri it becomes the dominant size term (≈90% of the app). This belongs to other angles; listed here so the matrix adds up.
4. **Memory, not size, is where a system webview clearly wins.** gethopp measured 6 windows at Tauri ~172 MB vs Electron ~409 MB ([source](https://www.gethopp.app/blog/tauri-vs-electron)). Our **main process at 182 MB RSS is an outlier** (typical Electron main is 50–80 MB). Worth a heap snapshot by the memory/perf angle before crediting any win to a shell change. Likely suspects: chokidar per root, media cache, the store. UNCONFIRMED.
5. **Startup:** a negligible difference between shells per gethopp. Not a reason to switch.
6. **`plugins: true`** (`index.ts:99`) enables Chromium's PDF plugin. Nothing in `client/src` uses PDF. draw.io's `app.min.js` mentions `application/pdf` for export MIME types only (UNCONFIRMED that it never embeds one). This is hygiene and surface reduction, not size.

---

## 4. Candidate matrix (this app, arm64 mac + Windows x64)

| | Realistic installed size, mac (today's payload → after payload work to ~40 MB) | DMG | Effort | What gets rewritten | Feature / stability risk |
|---|---|---|---|---|---|
| **(a) Electron + trim** | 325 MB → ~270 MB | ~128 MB → ~105 MB (ULMO) | **S** (hours) | nothing | **None** (one pinned engine; all 13k test LOC keep working) |
| **(b) Tauri 2** | ~105 MB → **~50 MB** (Rust shell ~8–15 MB; hello-world 8.6 MiB per gethopp) | ~55 MB → **~25 MB** | **XL**: 6–10 wks + WebKit QA | all 9,377 main LOC → Rust; 13,094 test LOC → Rust tests; 93 channels re-verified; preload → `invoke` shim | **High on mac**: unpinned WebKit; Excalidraw Safari bugs #8156/#5679; `clipboard.read` Paste bubble; pen pressure UNCONFIRMED; ⌘Q `ExitRequested` gaps ([tauri#9198](https://github.com/tauri-apps/tauri/issues/9198)) threaten the quit flush; draw.io origin becomes per-OS (`drawio://localhost` vs `http://drawio.localhost`) → `DRAWIO_ORIGIN`, `DRAWIO_CSP`, postMessage checks; `dragDropEnabled` must be false for HTML5 drop; powerMonitor needs a third-party plugin. Windows WebView2 is Chromium, so low engine risk there |
| **(c) Electrobun** (system webview) | ~60–70 MB → ~40 MB (UNCONFIRMED: one report puts a React app at ~64 MB) | small (zstd self-extractor) | **L** | Electron API layer only (index.ts, ipc envelope/window/watch/dialog, preload, `shell` calls ≈ 1.5k LOC); TS logic kept *if* Node-compatible | **Very high**: v1.0 Feb 2026; v2.0 (Aug 21 2026) replaced Bun with the brand-new "Cottontail" JSC runtime, whose author says it still needs "a lot of work … on startup, memory, and runtime performance". chokidar, worker_threads and execFile parity are unproven. Same WebKit risks as (b). `bundleCEF` restores Chromium but gives up the size win |
| **(d) Wails v3** (Go) | ~55 MB after payload work | ~25 MB | XL | main → Go | v3 is **beta** (v2 is the stable line); same WebKit risks |
| **(e) Neutralinojs** | ~45 MB | ~20 MB | XL | main → extensions (separate processes) | No per-host custom-scheme origin for draw.io isolation, weak multi-window, local server model. **Reject** |
| **(f) Native Swift** | ExcalidrawZ = **104 MB** measured | — | XXL | everything but the web canvas | Mac-only: Windows x64 would need a second app. **Reject** |

---

## 5. Proposed changes (Electron path, feature-neutral)

**C1. Prune Chromium locales (−46 MB installed, measured).** `desktop/package.json`:
```diff
@@ -21,6 +21,7 @@
   "build": {
     "appId": "com.yasinarshad.yaseendraw",
     "productName": "Yaseen Draw",
+    "electronLanguages": ["en", "en-US", "en_GB", "en-GB"],
     "directories": {
       "output": "dist-app"
     },
```
- **Why it is safe.** UI strings are the app's own. Dates are pinned to `en`/`en-US` (`client/src/lib/format.ts:2`, `relativeTime.ts:7`). draw.io is pinned to `lang=en` (CONTRACTS). macOS spellcheck uses NSSpellChecker, not `locale.pak`. A pruned copy launched cleanly.
- **Risk.** If electron-builder also strips the **app-level** empty `Contents/Resources/*.lproj` markers (55 of them today), macOS system panels (open/save, Edit › Emoji & Symbols) would show in English for non-English OS users. See [hermes-agent#93912](https://github.com/NousResearch/hermes-agent/issues/93912).
- **Proof.** After the build:
  - `ls -d Contents/Resources/*.lproj | wc -l` is still 55
  - `ls Frameworks/Electron\ Framework.framework/Resources/*.lproj` shows only `en*`
  - Windows: `locales/` contains only `en-US.pak` / `en-GB.pak`
  - Run the full test suite, then a manual pass on dialogs, the spellcheck context menu and the date rows in Board Info.

  If the markers vanish, drop `electronLanguages` and prune `Frameworks/.../*.lproj` in `build/adhocSign.cjs` (afterPack) before signing.

**C2. LZMA DMG (−32 MB download, measured).** `desktop/package.json` `"dmg"` block:
```diff
     "dmg": {
-      "artifactName": "${productName}-${version}-arm64.dmg"
+      "artifactName": "${productName}-${version}-arm64.dmg",
+      "format": "ULMO"
     },
```
- **Risk.** None at runtime. ULMO needs macOS 10.15+, and Electron 43 already needs a newer macOS. If electron-builder's enum rejects `ULMO`, use `ULFO`, or add an `hdiutil convert -format ULMO` step to `tools/packDesktop.mjs`.
- **Proof.** Mount it, drag-install, launch, and compare `du` of the installed app to the UDZO build.

**C3. (hygiene) Drop `plugins: true`.** `desktop/src/main/index.ts:99`:
```diff
-      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
+      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
```
- **Risk.** Only if some flow embeds a PDF (none found). Proof: draw.io File › Export as PDF/SVG/PNG, and import of a PDF into draw.io, before and after.

**Rejected Electron levers:**
- **Deleting `libvk_swiftshader` (16 MB):** unsupported; it is the GPU software-fallback path, and the failure mode is a crash on blocklisted or virtual GPUs.
- **Custom Electron/Chromium build** (gn `enable_pdf=false`, printing off, etc.): savings unmeasured (no public numbers found). It needs Chromium build infrastructure (~100+ GB, hours per build) repeated every Electron security release (~8 weeks). Fails "simple, robust".
- **castLabs ECS:** adds Widevine; it is not smaller.
- **asar compression:** asar has no compression; the DMG is the compression layer (C2).
- **V8 snapshots:** a startup lever, not a size lever (the snapshot is already 0.74 MB).
- **Universal build:** would roughly double the size. Staying arm64-only is correct.

---

## ARCHITECTURE DECISIONS FOR YASIN

### AD-1 — Which runtime shell?

**Problem.** "An order of magnitude smaller" means ~37 MB. Chromium alone is 227 MB after every safe trim, so 10× is impossible on Electron. Dropping Chromium (Tauri/Electrobun/Wails) means:
- rendering Excalidraw and draw.io in macOS WKWebView: an unpinned engine that changes with each macOS update, with open upstream Safari bugs in features we ship (grid perf #8156, zoom disappearance #5679)
- rewriting the 9.4k-LOC main process and its 13k LOC of tests (Tauri/Wails), or betting on a one-month-old JS runtime (Electrobun 2.0 / Cottontail)

**Options**
1. **Stay on Electron and trim** (C1 + C2), and put the "order of magnitude" effort into payload, startup, frame time and memory, which are shell-independent. Result: ~12% smaller installed and ~20% smaller download now; about 270 MB / 105 MB after the payload angles. Zero engine risk.
2. **Tauri 2 migration:** ~50 MB installed / ~25 MB DMG after payload work (about 7×). 6–10 weeks of rewrite, plus a permanent two-engine QA matrix (WebKit per macOS version, WebView2 on Windows).
3. **Electrobun (system webview):** keeps most TS main code, but the runtime changed a month ago and Node parity is unproven.
4. **Hybrid gate:** do option 1 now, and run a cheap **WebKit readiness spike**: load the built renderer in Safari/WKWebView with a stub `window.yaseenDraw` bridge (the single seam) and work through a checklist:
   - grid pan at 60 fps
   - zoom to max on a 2k-element board
   - ⌘V image paste and context-menu paste
   - pen pressure
   - draw.io load/autosave via postMessage
   - Writing mode, presentation, image/media studio
   - drag-drop of files
   - IME text entry
   - dark-mode image inversion

   Revisit option 2 only if the spike passes with zero regressions, or the fork fixes them.

**Recommendation: 4, which means 1 now.** Why:
- Yasin's hard rules are "no feature loss, no stability loss". The engine switch is the single largest reliability risk available in this project, and it buys size and memory, not smoothness: WebKit is measurably worse at our canvas's known hot spots.
- Electron pins one engine that every one of the 13k test lines and every manual pass has validated.
- The payload and renderer work gives real 2–10× wins in the dimensions users feel (startup, frame time, memory) without touching the shell.
- The spike keeps option 2 honest and data-driven instead of a leap. Because the renderer only talks through `window.yaseenDraw`, the spike costs about a day and needs no rewrite.

### AD-2 — Redefine the "10×" target per dimension

**Problem.** "Order of magnitude smaller" is physically unreachable while keeping Chromium.

**Options**
1. Keep the 10× installed-size goal, which forces AD-1 option 2.
2. Set per-dimension targets: download (DMG), payload MB, cold start ms, frame time on large boards, idle RSS.

**Recommendation: 2.** Payload 95 → ~40 MB and main RSS 182 → ~60 MB are both plausible, and both are feature-neutral.

---

## EXECUTION ISSUE CANDIDATES

1. **Prune Chromium locales via `electronLanguages`** (C1). Acceptance:
   - installed size −46 MB
   - app-level `.lproj` markers still 55
   - Windows `locales/` en-only
   - tests green; manual pass on dialogs, spellcheck and dates
2. **LZMA DMG** (C2). Acceptance: DMG ≤ 133 MB for v0.1.11-equivalent content; mount/install/launch smoke test.
3. **Remove `plugins: true`** (C3), with a draw.io export/import PDF regression pass.
4. **Main-process memory audit.** 182 MB RSS main: take a heap snapshot (`--inspect`) and attribute it to chokidar, media cache and store; set an idle-RSS budget. (Feeds the perf angle.)
5. **WebKit readiness spike** (AD-1 option 4). Serve `desktop/out/renderer` over a local scheme in a minimal WKWebView (or Safari) with a stub `window.yaseenDraw`. Run the checklist in AD-1 and record fps, memory and breakages. Output: go/no-go on the shell change, with a list of fork fixes needed.
6. **Shell decision record.** Write the AD-1 outcome into `docs/CONTRACTS.md` (the shell is Electron; the reasons; the conditions for re-opening), so the question is not re-litigated each quarter.
7. *(Only if 5 passes and Yasin opts in)* **Tauri 2 port plan:**
   - map the 93 channels to Tauri commands/events
   - Rust ports of fs/git/share/media/watch (`notify` crate)
   - per-OS draw.io origin
   - quit-flush via `ExitRequested` + `CloseRequested` with a ⌘Q regression test
   - power events
   - HTML5 drag-drop config
   - `clipboard.read` via the clipboard-manager plugin

   Run it as a parallel build behind the same test contract, never an in-place swap.

Sources: [gethopp Tauri vs Electron](https://www.gethopp.app/blog/tauri-vs-electron) · [Electrobun repo](https://github.com/blackboardsh/electrobun) · [Electrobun 2.0 / Cottontail](https://blackboard.sh/blog/electrobun-2-0/) · [InfoWorld Electrobun 1.0](https://www.infoworld.com/article/4137964/first-look-electrobun-for-typescript-powered-desktop-apps.html) · [Wails v3 beta](https://v3.wails.io/blog/wails-v3-beta/) · [tauri#9198](https://github.com/tauri-apps/tauri/issues/9198) · [WKWebView pitfalls (zenn)](https://zenn.dev/tamat_llc/articles/tauri-macos-wkwebview-pitfalls) · [HN: Tauri→Electron](https://news.ycombinator.com/item?id=44118251) · [excalidraw#8156](https://github.com/excalidraw/excalidraw/issues/8156) · [excalidraw#5679](https://github.com/excalidraw/excalidraw/issues/5679) · [excalidraw#1246](https://github.com/excalidraw/excalidraw/issues/1246) · [hermes-agent#93912](https://github.com/NousResearch/hermes-agent/issues/93912) · [tauri-plugin-power-monitor](https://github.com/marrionesa/tauri-plugin-power-monitor)
