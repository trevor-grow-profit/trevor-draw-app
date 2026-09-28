# feature-safety-net — YAZ-2073 regression gate (angle: NO feature loss, NO stability loss)

Artifacts (all in `$SCRATCH/feature-safety-net/`): `measureBudget.mjs` (proposed `tools/perf/measureBudget.mjs`, 290 lines, zero deps, run + negative-tested), `budget.json` (proposed `tools/perf/budget.json`, baselines filled from v0.1.11), `baseline.json` (raw measurement), `test.log`, `testfiles.txt` (per-file test counts/durations).

## 1. What I measured

| What | Command | Result |
|---|---|---|
| Unit/integration suite | `npm test` (vitest, 3 projects) | **PASS — 168 files, 2 575 tests, 41.3 s wall** (130 s user CPU). client 83 files/1 337 tests · desktop 79/1 154 · tools 6/84 |
| Slowest files | vitest per-file times | `git/resolve.test.ts` 40.8 s, `git/sync.test.ts` 30.9 s, `git/history.test.ts` 9.5 s, `Sidebar.test.tsx` 7.2 s (219 tests), `fs/watchers.test.ts` 7.1 s — wall time = the git suites (real git) |
| Typecheck | `npm run typecheck` | **PASS, 5.6 s** |
| Packaged bundle (v0.1.11) | `node measureBudget.mjs` | .app 387.15 MB · Frameworks 287.40 MB · app.asar 75.97 MB · share-viewer 23.42 MB · dmg 172.48 MB · 55 `*.lproj` |
| Renderer (desktop/out) | same | eager JS **973 567 B in 1 file** (engine is already lazy: `engine.ts:133` `import('@excalidraw/excalidraw')`) · eager CSS 92 881 B · renderer total 28.31 MB (14 MB `assets/` 131 files + 13 MB `excalidraw-assets/fonts` 243 files) · 125 chunks reachable from `index.html` · main bundle 285 KB |
| Packaged integrity | same | **PASS**: Info.plist `yaseendraw` scheme + `.excalidraw`/`.drawio` Owner/Editor, `Signature=adhoc` + `codesign --verify --deep --strict`, all required `out/` entries in the asar, 13 font families, `drawio/img` + `drawio/math4`, storage worker chunk, share-viewer fonts + `drawio/config.js`, zero dangling chunk imports |
| Gate negative test | deleted `katex-*.js` from a copy of `out/renderer` | `INTEGRITY FAIL: renderer: chunk assets/katex-oVG3DVWa.js is imported but not shipped` → exit 1 ✔ |
| Cold start | `--cold-start N` implemented (CDP poll of the packaged app on a throwaway profile) | **NOT RUN** — it opens a window on Yasin's screen; ledgers say "No launching the Electron app unless Yasin asks" (`CONTINUITY_CLAUDE-yaz-1834-board-metadata.md:17`, `…-1775-port.md:14`). Needs his OK once to set the baseline. |

Where hand-verified scenario lists live: **only in Linear pinned comments, not in the repo** — YAZ-1775 "✅ Demo approved" (summarised in `LAUNCH.md:117-122`), YAZ-1897 S1–S28 (📘 comment; 15 of them automated in `git/resolve.test.ts`), YAZ-1941 S1–S20, YAZ-1999 S1–S18, YAZ-2056 S1–S48, YAZ-1913 12 real-app checks, YAZ-1800 20 hover scenarios, YAZ-1802 4A/4B passes, YAZ-1805 "1A · Engine parity checklist". Ledger refs: `thoughts/ledgers/*-2056-*.md:4,19`, `*-1999-*.md:7,18`, `*-1941-*.md:7,18`, `*-1897-*.md:21`.

"No Playwright" — why and what replaces it: 🔒 OD1 on YAZ-1805, resolved by Yasin (`docs/CONTRACTS.md:56-58`, `LAUNCH.md:66-69`, `.github/workflows/ci.yml:2`); Playwright was deleted in YAZ-1808 (`…-1775-port.md:305`). Every ledger repeats "No Playwright, ever (not in subagents either)". Reasoning recorded: CI = typecheck + unit tests + build; behaviour = launch the app in an isolated profile and run a scenario list. **Accepted precedent for machine checks of the real app without a UI driver**: a DevTools-protocol probe (YAZ-1855 `…-1855-*.md:11`, YAZ-1897 4B `…-1897-*.md:21`) and `--inspect` on the built app, clicking menu items from main and reading `window.identity()` (YAZ-1913 `…-1913-*.md:33`). The proposed smoke test follows that precedent — it reads state and calls the bridge; it never clicks or types into the UI.

## 2. FEATURE INVENTORY (one line each · where · coverage: **A** = automated test file(s), **M** = manual only, **A/M** = logic automated, real-Chromium/OS behaviour manual)

### Documents & disk
- `.excalidraw` open/edit/save (debounced 500 ms, atomic tmp+rename, mtime-guarded) — `client/src/drawings/DrawingEditor.tsx`, `lib/autosave.ts`, `desktop/src/main/fs/drawing.ts` — A (`fs/drawing.test` 36, `autosave.test` 10, `DrawingEditor.test` 33 w/ mocked engine)
- Content-addressed images in `<vault>/assets/<sha1>.<ext>`, `files:{}` in scene, legacy embedded images extracted on first save — `shared/drawingAssets.ts`, `fs/drawing.ts` — A (`drawingAssets.test` 34, `fs/drawing.test`)
- Orphan-asset sweep (24 h age guard, to Trash) — `main/drawings/orphanSweep.ts` — A (12)
- `.drawio` load/save as plain XML, validated outline, dates on `<mxfile>` — `main/fs/diagram.ts`, `shared/diagramFile.ts` — A (`fs/diagram.test` 12, `diagramFile.test` 14)
- One classifier for kinds (case-insensitive, `x.drawio.svg` = no kind) — `shared/fileKind.ts` — A (5)
- Board metadata block (`yaseendraw.createdAt/updatedAt` first key) — `main/fs/boardHead.ts` — A (`boardHead.test`, `boardMetaVault.integration.test`)
- Non-board files listed muted, opened in OS default app — `fs/openDefault.ts` — A (5) / M (real hand-off)
- External edit hot-reload when clean; Reload / Keep-mine bar when dirty; echo suppression by mtime — `hooks/useWatch.ts`, `main/fs/watchers.ts`, `ConflictBar.tsx` — A (`watchers.test` 12; `ConflictBar`, `useWatch` have NO direct test) / M
- Fit-to-content on open (≤100 %, ≥10 %) — `drawings/drawingScene.ts openViewport` — A (`drawingScene.test` 17) / M (real canvas)
- Saved / Synced chips — `SaveIndicator.tsx` (no test), `SyncIndicator.tsx` (19) — A/M
- Flush-on-close / flush-on-quit handshake (5 s cap) — `main/windows.ts`, `index.ts:234-247` — A (`windows.test` 51) / M (real quit)

### Excalidraw canvas (vendored fork `e72242f8`, `client/vendor/*.tgz`)
- Engine mount, one toolbar (`desktopUIMode='full'`), phone/desktop form factor — `ExcalidrawSurface.tsx`, `engine.ts`, `formFactor.ts` — A (`engine.test` 4, `formFactor.test` 5) / M (real engine never runs in jsdom except `shareContent.integration.test`)
- Engine tools reachable through the fork's own UI (not wired by us, lazy chunks): shapes, arrows/binding, freehand/pen mode, text, eraser, lasso, hand, frame, embeddable, image insert, **laser pointer**, element links, stats, command palette, canvas search, **Mermaid → Excalidraw / text-to-diagram dialog (mermaid + katex + cytoscape + CodeMirror chunks)**, SVG export font subsetting (`subset-worker.chunk`), image resize (`pica`, `image-blob-reduce`) — bundle `desktop/out/renderer/assets/*` — **M only** (no test; the only proof they ship is my chunk-closure check)
- Paste / drop image from OS clipboard → one asset, small JSON — engine + `drawing:save` — A (asset landing) / **M (clipboard read; needs secure context: `crypto.subtle.digest("SHA-1")` + `navigator.clipboard` ×10 in `percentages-*.js`)**
- 14 canvas prefs (grid, snapping, binding, zen, writing mode, tool lock, frames visible, pen widths, new-element defaults) global + live across windows — `shared/canvasPrefs.ts`, `settings/canvasSection.tsx` — A (`canvasPrefs.test` 21) / M
- Canvas background (View menu) — `boardCommand.ts` — A (7)
- Export Image… ⌘⇧E (engine PNG/SVG dialog) — M (dialog is engine's)
- Export Excalidraw Drawing… ⌘⇧S (standalone file, images embedded) — `exportDrawing.ts`, `dialog:save-file` — A (`exportDrawing.test` 10, `ipc/dialog.test` 25)
- Excalidraw fonts served offline from `app://yaseen/excalidraw-assets/fonts` (13 families) — `electron.vite.config.ts:36-54`, `engine.ts:131` — **M only** (no test; silent CDN fallback to esm.sh if missing)
- Multiple engine instances (one per mounted tab), focus handoff on tab reveal — `focusHandoff.ts` — A (4)

### Canvas panel (hamburger)
- Images tab ⌘F: Iconify + Pixabay search, shapes catalog, favorites, recent, insert → `assets/` — `image-studio/*`, `main/media/*`, `main/library/mediaStore.ts` — A (`ImageStudio.test` 23, `providers.test` 23, `curation.test` 22, `cache.test` 9, `mediaStore.test` 14, `shapes.test` 17, `insertShape.test` 10) / M (network)
- Components tab ⌘C: save selection, insert copies, rename, delete, Import JSON, PNG previews, Library folder shared across vaults — `components-library/*`, `main/library/componentStore.ts` — A (`SavedComponents.test` 25, `componentStore.test` 27, `componentImport.test` 14, `savedComponents.test` 38)
- Present tab: frames = slides, reorder (drag, ⌥↑/↓), rename, full-pane player, keys, camera reserve — `drawings/presentation/*` — A (`PresentationPlayer.test` 21, `PresentationSidebar.test` 17, `slides.test` 19, `camera.test` 3) / M

### draw.io diagrams (pinned v31.5.2, pruned, served on `app://drawio`)
- Editor in iframe on own origin, CSP, offline/lockdown URL, `yaseenReady` handshake (3 s fallback) — `diagrams/DrawioEditor.tsx:43,196`, `drawioProtocol.ts`, `main/drawio/assets.ts` — A (`DrawioEditor.test` 25, `drawioProtocol.test` 13, `drawio/assets.test` 9) / M
- Overlay: page view off, ⌘-wheel zoom, Excalidraw keymap (tool keys, colour letters, ⇧, 1–0 sizing, ⌘⇧X), text corner-scaling, fonts from `yaseen-fonts/` — `desktop/drawio-overlay/js/PostConfig.js`, `PreConfig.js` — A (`tools/drawioOverlay.test.mjs` 18 against a stand-in)
- Pruned pack (deny list, request set pinned) — `tools/lib/drawioPack.mjs` — A (`packDrawio.test` 19)
- One renderer for pictures (hover, history, Export Image PNG/SVG) — `renderDiagram.ts`, `drawio-overlay/yaseen-render.*` — A (`renderDiagram.test` 6, `tools/yaseenRender.test.mjs` 7) / M
- Dark-mode adapt/keep colours, live — PostConfig `yaseenAdaptiveColors` — A/M
- Diagram badge in tree/tab — `DiagramBadge` — A (Sidebar/TabBar tests)

### Sidebar
- Files lens (whole folder tree, `assets/` hidden at top level) + ♥ Favorites lens — `sidebar/Sidebar.tsx`, `Tree.tsx`, `main/fs/tree.ts` — A (`Sidebar.test` 219, `tree.test` 6)
- Create: New Excalidraw drawing / New dated drawing / New draw.io diagram / New folder / New dated folder, name-first inline box — `CreateInline.tsx`, `createEntry.ts`, `main/fs/create.ts` — A (26 + 5 + 15)
- Rename inline (kind-preserving), move by drag-drop, delete to Trash (+confirm setting) — `RenameInline.tsx`, `main/fs/rename.ts`, `remove.ts`, `ConfirmDelete.tsx` — A (9, 23, 10, 12)
- App-wide file clipboard ⌘X/⌘C/⌘V across windows/vaults, "copy N" naming — `main/fileClip.ts`, `fs/copy.ts`, `lib/fileClipboardHotkey.ts` — A (10, 20, 11)
- Multi-select (⇧-click), Copy path / Copy N paths, Open N in tabs — `lib/selection.ts` — A (9)
- Right-click menu (5 groups, Open in ▸ new window / VS Code / default app / Finder) — `menuSections.ts`, `ContextMenu.tsx`, `fs/openInVsCode.ts`, `reveal.ts` — A (42, 24, 7, 7) / M (OS hand-offs)
- ⌘K search (files + folders, ranking, ⌘⏎ background tab, right-click on result) — `search/*` — A (`searchCandidates` 21, `useSearchResults` 12, `SearchResults` 8, `matchCandidates` 7)
- Sort (name / updated / created, per vault) + Info popover — `shared/treeSort.ts`, `BoardInfo.tsx` — A (6, 3, `sortVault.integration.test` 4)
- Hover preview (400 ms dwell, LRU 32, theme-keyed, toggle) — `BoardPreview.tsx`, `boardPreviewCache.ts`, `lib/scenePreview.ts` — A (3, 8, 13, `previewVault.integration.test` 5) / M (real engine render)
- Focus on folder(s) with eye toggle, per lens, persisted — `lib/treeState.ts` — A (18)
- Favorites in `<vault>/.yaseendraw/favorites.json`, drag-reorder, follows renames/deletes, syncs — `main/favorites.ts` — A (19 + `ipc/favorites.test` 4)
- Collapse (floating restore), resize 180–520 px drag-to-collapse, ⌘B — `lib/sidebarHotkey.ts`, `lib/dragSlot.ts` (no test) — A/M
- Folders start collapsed each launch; expand-all/collapse-all chevrons — A (Sidebar.test)
- Share link mark (red on failure), red cloud for too-large file — `useShareBadges.ts`, `syncAttention.ts` — A (6, 27)

### Tabs, windows, vaults
- Tabs, per-tab history, ⌃Tab/⌘⇧]/[, ⌘W semantics, tab context menu (Copy path) — `tabs/TabBar.tsx`, `workspace/useWorkspace.ts` — A (26, 49 + 17)
- Multiple windows: ⌘⇧N duplicate, ⌘⇧W, ⌘-click opens file in new window, restore windows+tabs+bounds on relaunch, clamp to live display — `main/windows.ts` — A (51) / M
- Vault switcher ⌘O (filter, one-line rows, hover ⓘ path, ⇧⏎ open here, held-⇧ cue, dead rows) — `VaultSwitcher.tsx` — A (59) / M (S1–S48)
- Vault menu (open here, display name, copy name/path, reveal, VS Code, remove) — `vaultMenuSections.ts` — A (9) / M
- Open folder never replaces a vault (opens beside / raises) — `App.tsx openPicked`, `menu.ts openRecent` — A (`menu.test` 47, `App.test` 80)
- Welcome screen with recents — `Welcome.tsx` — A (8)
- Window title = vault display name + board — `lib/windowTitle.ts` — A (3)
- URL hash `#/abs/path` — `lib/urlHash.ts` — A (3)

### Menus & keys
- App menu (pure template, stable ids, enablement by active kind, fallback target window) — `main/menu.ts` — A (47)
- App zoom ⌘+/⌘−/⌘0 applied by main — `index.ts:191-194` — M
- Spellcheck context menu (replace / add to dictionary) — `index.ts:103-108`, `menu.ts buildContextMenuTemplate` — A (template) / M
- Settings › Hotkeys single source — `settings/hotkeys.ts` — A (7, pins the set)

### Links & OS integration
- `yaseendraw://` links (encode/parse, route to best window, notice on failure, cold-start queue) — `shared/links.ts`, `main/linkQueue.ts`, `index.ts:47,59-64` — A (`links`, `linkQueue.test` 5, `openLink.test` 14) / **M (OS registration)**
- Finder double-click / `open -a` / Open With for `.excalidraw` + `.drawio` (Owner), cold + warm; parent-folder-as-vault fallback — `index.ts:72-75,226-230`, `main/fileArgs.ts`, `desktop/package.json build.fileAssociations` — A (`fileArgs.test` 9, routing in `windows.test`) / **M (the `open-file` event + LaunchServices)**
- Single instance; second launch focuses / routes argv (Windows) — `index.ts:29-44` — **M only**
- Window-open policy (external links to browser) — `windowOpenPolicy.ts` — A (10)
- Theme-matched window background (no white flash) — `index.ts:98`, `main/theme.ts` — A (5) / M

### Sync, merge, history, storage (per-vault GitHub, system git)
- Commit→fetch→rebase→push, idle 60 s pull, focus/wake/unlock pulls, quit-flush push (5 s) — `main/git/sync.ts`, `manager.ts`, `index.ts:154-161,224-225` — A (`sync.test` 36, `manager.test` 22, `guarantees.test` 6)
- Shape-by-shape board merge; keep-both for diagrams/others; shares/favorites per-entry — `shared/boardMerge.ts`, `git/resolve.ts` — A (17, 19 incl. S1–S17)
- Too-large (≥95 MiB) held back, banner, chip, red cloud — `git/sync.ts`, `vault.ts` — A
- Git discovery at fixed paths, setup prompt when missing — `git/detect.ts`, `exec.ts` — A (7, 12)
- Merge notice + See changes — `history/mergeNotice.ts` — A (4)
- Version history (pictures + change marks for drawings; as-it-was for diagrams) + Restore — `history/VersionHistory.tsx`, `compare.ts`, `git/history.ts` — A (11, 4, 10) / M (real pictures)
- Settings › Storage (history bar, >50 MiB list, Move pictures out) on a worker thread — `storageSection.tsx`, `main/storageJob.ts`, `storageWorker.ts` (built via `?modulePath`, `ipc/storage.ts:4`) — A (17, 3, `storageVault.integration.test` 7 — but the worker is built by esbuild in `gitFixture.ts:137-145`, **not** by electron-vite) / M

### Share links (own Cloudflare R2 + Worker)
- Setup from one pasted token, account picker, reuse, subdomain claim, progress steps — `main/share/setup.ts`, `cloudflare.ts` — A (`fakeCloudflare.integration.test` 22)
- Share dialog (Not shared / Anyone; View+download / View only), ⌘⇧L + right-click — `ShareDialog.tsx` — A (18)
- Always-live re-upload (10 s settle, one in flight, latest wins), stale detection, rename/delete follow — `share/liveShare.ts`, `main/share/boards.ts`, `fsHooks.ts` — A (8, `sharing.test` 35, `shareLinks.test` 3)
- Custom domain, Forget key, Delete all — `setup.ts` — A (integration)
- Worker (PUT/PATCH/DELETE/wipe, /b /scene /raw /assets, CSP) — `share/worker.js` — A (`worker.test` 25)
- **Share viewer web bundle** (Excalidraw view mode, Download .excalidraw/PNG; draw.io GraphViewer for diagrams, stencils/img/math4) — `share/viewer/*.js`, `tools/buildShareViewer.mjs`, shipped as `Contents/Resources/share-viewer` — A (`buildShareViewer.test` 3 = it builds) / **M (rendering in a browser; nothing tests `share/viewer/*.js` behaviour)**
- Sharing page in Settings — `SharingPage.tsx` — A (32)

### Settings & state
- Settings dialog (registry, search, sections: Appearance, Excalidraw canvas, Files, Images, Sync, Sharing, Storage, Hotkeys) ⌘, — `settings/*` — A (`SettingsDialog.test` 38, `searchSettings.test` 13)
- Theme System/Light/Dark live via `nativeTheme.themeSource` — `main/theme.ts`, `lib/theme.ts` — A
- Library folder choose/reset — `LibraryFolderControl.tsx` (no test), `main/library/folder.ts` (5) — A/M
- Pixabay key write-only, `secrets.json` 0600 — `main/secrets.ts` — A (9 + 4)
- One state file, field-by-field tolerant load, corrupt → `.corrupt-<epoch>`, `YASEEN_DRAW_USER_DATA_DIR` — `main/store.ts`, `userData.ts` — A (69, 2)
- Per-vault `.yaseendraw/` (favorites, github, shares) created lazily — `main/vaultConfig.ts` — A (12)

### Packaging / distribution
- macOS arm64 dmg + dir, ad-hoc deep seal (`build/adhocSign.cjs`) — **M** (now covered by gate: `Signature=adhoc` + `--verify --deep --strict`)
- Windows x64 NSIS unsigned — `desktop:build:win` — **M only; built only on a `v*` tag** (`release.yml`), never on a PR
- Release workflow on tag — `.github/workflows/release.yml` — M
- Custom `app://` privileged scheme (standard + secure + fetch) — `index.ts:82,171-181` — **M only**
- Dev tooling kept working: `seedDemoVault` (63 boards), `seedDrawioDemoVault`, `seedMergeDemoVault`, `seedPreviewDemoVault`, `seedShareDemoVault` + `fakeCloudflare.mjs`, `seedSortDemoVault`, `seedStorageDemoVault`, `packEngine` — A (`seedDemoVault.test` 15, `packEngine.test` 22)

### Test-less modules (no test imports them) — from a script over `git ls-files`
`desktop/src/main/index.ts` (the whole Electron wiring: protocol, open-file/open-url, single-instance, quit), `main/ipc/index.ts`, `ipc/diagram.ts`, `ipc/broadcast.ts`, `main/watchedFolder.ts`, `main/storageWorker.ts`, `share/viewer/{entry,board,diagram,drawioConfig,assetPath}.js`, `client/src/main.tsx`, `drawings/ConflictBar.tsx`, `SaveIndicator.tsx`, `hooks/useWatch.ts`, `hooks/usePickFolder.ts`, `lib/{dragSlot,modalKeys,windowChord,useVaultName,relativeTime}.ts`, `settings/{LibraryFolderControl,PixabayKeyControl,canvasSection,controls,options}.tsx`. (Some are exercised indirectly, e.g. `share/setup.ts` via the fake-Cloudflare integration.)

## 3. Findings ranked by risk of SILENT breakage during a bundle/shell refactor

1. **`app://` scheme privileges are load-bearing for three engine features** — `desktop/src/main/index.ts:82` `{ standard: true, secure: true, supportFetchAPI: true }`. `secure` = secure context → `crypto.subtle.digest("SHA-1")` (image file ids — every paste/drop/insert) and `navigator.clipboard` (10 call sites in the engine chunk `percentages-*.js`); `standard` = real origin → the `subset-worker.chunk` Worker (SVG export font subsetting) and relative URLs; `supportFetchAPI` → fonts via fetch. Changing the protocol (e.g. `file://`, a new host, a service-worker loader, or moving to `loadFile`) breaks image paste + export silently. **No test.** Proof: smoke probe asserts `isSecureContext === true`, `typeof crypto.subtle.digest === 'function'`, and a real `crypto.subtle.digest('SHA-1', …)` round-trip.
2. **Cold-start event ordering** — `open-url` (`index.ts:61`) and `open-file` (`:72`) listeners MUST be attached before `ready` (macOS fires them first on a Finder double-click), then drained after `restoreAll()` (`:226-230`). The classic startup optimization (lazy-import main modules, defer IPC registration, `show:false` + `ready-to-show`) can reorder these → a double-clicked board opens an empty window, no error. Only `linkQueue.test`/`fileArgs.test` cover the pure halves. Proof: gate's Info.plist check + manual M-OS scenarios (§4, O1–O4) on the packaged app.
3. **Excalidraw fonts** — copied at `writeBundle` (`electron.vite.config.ts:47-49`) to `out/renderer/excalidraw-assets/fonts`, located at runtime by `engine.ts:131`. The SAME families are also copied into `drawio/yaseen-fonts/` by `packDrawio` (`tools/lib/drawioPack.mjs:72`) and into `share-viewer` (`share/viewer/assetPath.js:2`), and 4 Assistant woff2 are also emitted hashed into `assets/`. A dedupe refactor must keep **four consumers**: canvas, hover/SVG export (`exportToSvg`), draw.io editor + render page, share viewer. Missing fonts **do not error** — the engine silently falls back to the esm.sh CDN (online) or a system font (offline). **No test.** Proof: gate checks 13 families (done); smoke probe checks no request leaves `app://` (CDP `Network`) and `document.fonts.check('20px Excalifont')`.
4. **Share viewer is verified only at "Set up sharing"** — `viewerAssetsDir()` `ipc/share.ts:38-39` reads `Contents/Resources/share-viewer` (packaged) and `readViewerAssets` pulls draw.io `DRAWIO_SHARE_FILES`/`DIRS` (`drawio/assets.ts:43,51`) from the app's own draw.io copy. The assets are uploaded ONLY when the user runs setup again — a broken viewer ships fine and fails months later, on someone else's browser. `share/viewer/*.js` has no behavioural test. Proof: gate checks presence + chunk closure of `share-viewer` (done); manual scenario K3–K5 against `tools/fakeCloudflare.mjs` + `seedShareDemoVault.mjs` on the PACKAGED app (setup reads the packaged path, dev reads the repo).
5. **Storage worker chunk** — `ipc/storage.ts:4` `import storageWorker from '../storageWorker?modulePath'`; tests build it with esbuild instead (`git/gitFixture.ts:137-145`), so an electron-vite/rollup change that drops or renames the chunk passes CI. Gate checks the chunk exists (done); smoke probe calls `window.yaseenDraw.storage.stats(root)` (read-only).
6. **draw.io on its own origin** — `app://drawio` routed by host (`index.ts:171-181`), CSP on every answer, handshake `yaseenReady` with a 3 s fallback (`DrawioEditor.tsx:43`) — a broken overlay degrades quietly (keymap/fonts lost, document still opens). Good unit coverage of the parts; none of the assembled whole. Proof: smoke probe waits for `yaseenReady` (not the fallback) and loads `yaseen-render.html`.
7. **Engine lazy features exist only as lazy chunks** (mermaid/TTD 50+ chunks, katex, cytoscape, CodeMirror, laser, subset worker, pica). Any chunking/tree-shaking/"remove unused locales" work can orphan them; nothing but the new closure check notices. Locale chunks (58 `xx-XX-*.js`) are dead today because `langCode` is dropped (`ExcalidrawSurface.tsx:84`) — removing them is safe *only* with that prop still dropped.
8. **Windows is never built on a PR** (`ci.yml` macOS only; `release.yml` builds win on tag). Any refactor of paths, `process.platform` branches, argv handling or electron-builder config can break Windows and surface at release time. Proof: add `desktop:build:win` (no install) to a pre-release checklist, or a `windows-latest` job on PRs that touch `desktop/`/`tools/pack*` (see Decision D3).
9. **Inherited `plugins: true`** (`index.ts:99`, from the docs-app seed `2e26687`) — enables Chromium's PDF plugin. No draw feature appears to need it; removing it is a candidate for a size/attack-surface change but must be proven (PDF in an embeddable? image of type PDF?) — flag, don't touch without a scenario.
10. **`*.lproj` trimming (55 dirs)** affects native strings in open/save sheets, Trash prompts, and spellcheck language availability (the spellcheck context menu is a feature, `index.ts:103-108`). Keep `en.lproj`; verify the context-menu squiggles + Finder sheets after trimming.
11. **Untested UI glue that a React/bundle refactor touches**: `ConflictBar.tsx`, `useWatch.ts`, `SaveIndicator.tsx`, `dragSlot.ts` (sidebar resize), `client/src/main.tsx`. These are the reliability UX (conflict bar = data-loss guard). Add thin tests before refactoring (issue E6).

## 4. Proposed regression gate

### (a) Budget + measurement — `tools/perf/budget.json` + `tools/perf/measureBudget.mjs`
- Files ready in `$SCRATCH/feature-safety-net/`. Two modes: full (packaged `.app` + dmg + asar index + Info.plist + codesign + share-viewer) and `--out-only` (CI: `desktop/out` after `npm run build`). `--cold-start N` = opt-in, launches the packaged binary N+1 times on a throwaway `YASEEN_DRAW_USER_DATA_DIR` with `--remote-debugging-port`, polls CDP until `#root` has content (Welcome) / `.excalidraw canvas` exists (seeded board), drops run 0, reports medians.
- Ratchet rule: each optimization PR lowers the ceiling it earned in `budget.json`; raising any ceiling needs Yasin's OK in the PR body. Ceilings today = baseline × 1.01.
- Wiring (small diffs):

```diff
--- a/package.json
+++ b/package.json
@@ -17,4 +17,6 @@
     "test": "vitest run",
-    "test:watch": "vitest"
+    "test:watch": "vitest",
+    "perf:budget": "node tools/perf/measureBudget.mjs",
+    "perf:budget:ci": "node tools/perf/measureBudget.mjs --out-only"
   },
```
```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -26,3 +26,4 @@
       - run: npm run typecheck
       - run: npm test
       - run: npm run build
+      - run: npm run perf:budget:ci
```
- Cost: 0.38 s; zero deps; no network; never writes into the repo.

### (b) Hand-verification scenario list ("H-list"; run on the PACKAGED app with `YASEEN_DRAW_USER_DATA_DIR`, per `LAUNCH.md` recipe, against the seeded vaults). Proposed home: `docs/REGRESSION.md` (see Decision D1). ⏱ ≈ 45 min full, ≈ 12 min "core" (★).
- **Core (★, every optimization PR that changes bundle/shell)**
  - ★C1 Cold launch restores windows + tabs; Welcome window with recents when no vault.
  - ★C2 Open a text-heavy board: Excalifont/Virgil/Assistant render; DevTools Network shows zero non-`app://` requests.
  - ★C3 Paste an image from the macOS clipboard (screenshot ⌘⌃⇧4) → appears; `assets/` gains one file; board JSON stays small; relaunch shows it.
  - ★C4 Same image pasted twice → one asset. Drag-drop a PNG from Finder → asset.
  - ★C5 Export Image… ⌘⇧E → PNG and SVG (SVG opens in Safari with correct font = subset worker ran).
  - ★C6 Export Excalidraw Drawing… ⌘⇧S writes a standalone file that excalidraw.com opens.
  - ★C7 Engine lazy tools: laser pointer (K), Mermaid/"text to diagram" dialog renders a flowchart, frame tool, eraser, lasso, command palette, element link, stats.
  - ★C8 Open a `.drawio`: shapes panel closed, `R` draws a rectangle, colour letter colours selection, ⌘-scroll zooms, edit → Saved chip, relaunch keeps edit (plain XML on disk).
  - ★C9 Hover a drawing and a diagram in the sidebar → previews in both themes.
  - ★C10 Theme flip System→Dark→Light live in two windows; no white flash on dark launch.
  - ★C11 External edit (`echo >> file` / another editor) hot-reloads a clean tab; dirty tab shows Reload / Keep mine.
  - ★C12 ⌘Q mid-edit then relaunch: the last stroke is on disk.
  - ★O1 Finder double-click `.excalidraw` with app NOT running → opens in the right window/tab. ★O2 same for `.drawio`. O3 same with app running. O4 `open 'yaseendraw:///…'` from Terminal routes; bad link → notice, no dialog. (Beware: LaunchServices may pick `/Applications/Yaseen Draw.app`; for a candidate build, `lsregister -f` it or test the installed copy.)
- **Documents & sidebar**: D1 create each of 5 kinds (name-first, Esc leaves nothing), D2 rename (kind kept) / move by drag / delete → Trash (confirm on), D3 cut/copy/paste across two vault windows ("copy 2" naming), D4 ⌘K search + ⌘⏎ background tab + right-click result, D5 sort by updated after a save, Info popover, D6 focus on 2 folders + eye, D7 favorites add/reorder/rename-follows, D8 sidebar collapse/resize/drag-to-collapse, D9 non-board file opens in default app, D10 corrupt + empty boards show readable error; 40-image and 10 MB boards open (`seedDemoVault`), D11 unicode + nested paths.
- **Windows & vaults**: W1 ⌘⇧N duplicate, W2 ⌘-click file → new window, W3 same board in two windows (reload when clean, bar when dirty), W4 ⌘O switcher filter/⏎/⇧⏎/held-⇧ cue/ⓘ path, W5 vault menu all items, W6 Open Folder… opens beside, never replaces, W7 window on an unplugged monitor comes back on screen, W8 menu items enabled/disabled by active tab kind; app zoom ⌘+/⌘−/⌘0.
- **Canvas panel**: P1 Images: Iconify search + insert, Pixabay with key, offline → shapes still work, favorites/recent; P2 Components: save, insert in another vault, rename, delete, Import JSON; P3 Present: reorder (drag, ⌥↑/↓), play, →/←/Space/Home/End/Esc-zooms-out, ⇧T.
- **Sync & history** (`seedMergeDemoVault`): S1 first sync merges all cases + notice + See changes, S2 idle pull shows other machine's change within 60 s, S3 >95 MiB file held back (banner, chip, red cloud), S4 Version history for drawing (marks) and diagram (as-it-was) + Restore, S5 Settings › Storage bar + Move pictures out (window stays responsive), S6 no git → setup prompt.
- **Share** (`seedShareDemoVault` + `fakeCloudflare.mjs`, dev env vars honoured only unpackaged → run K-list on `npm run dev` AND once on a packaged build against real Cloudflare before a release): K1 setup steps, K2 share drawing + diagram, open link in Safari + Firefox, K3 viewer: download .excalidraw/PNG allowed / 403 when View only, K4 live update 10 s after edit, K5 diagram with stencil + math label renders, K6 rename keeps link, delete stops it, K7 Delete all.
- **Settings**: T1 each of 14 canvas prefs applies across boards/windows and survives relaunch, T2 Library folder change, T3 Pixabay key set/clear, T4 draw.io dark colours adapt/keep live, T5 settings search.
- **Distribution**: R1 dmg mounts, drag-install, first-open Open Anyway, `codesign -dv` = adhoc; R2 `desktop:build:win` produces the exe (install on a Windows box before release).

### (c) Cheap automated smoke test (respects "No Playwright, ever")
- **Not** a UI driver: `tools/perf/smoke.mjs` launches the PACKAGED binary on a seeded throwaway profile + `seedDemoVault`/`seedDrawioDemoVault` output with `--remote-debugging-port`, and over raw CDP (node's global `WebSocket`, no deps) only **reads state and calls the bridge** — the precedent from YAZ-1855/1897/1913. Asserts (each maps to a §3 risk):
  1. `isSecureContext`, `crypto.subtle.digest('SHA-1', …)` works, `navigator.clipboard` defined (risk 1).
  2. Drawing tab: `.excalidraw canvas` mounted; `document.fonts.check('20px Excalifont')` after `document.fonts.ready`; CDP `Network.requestWillBeSent` saw **zero** non-`app:`/`data:`/`blob:` URLs (risk 3).
  3. Diagram tab: iframe `app://drawio/…` present and the host received `yaseenReady` before the 3 s fallback (risk 6); `window.yaseenDraw.diagram.load` round-trip.
  4. `await window.yaseenDraw.storage.stats(root)` resolves (worker chunk, risk 5).
  5. `window.yaseenDraw.window.identity()` matches the seeded entry; windows+tabs restored.
  6. Lazy engine chunk load: `await import('<chunk of mermaid-to-excalidraw>')` from the page resolves (risk 7).
  7. Quits via `app.quit` over `--inspect` main (or SIGTERM) and the state file is rewritten, not `.corrupt-*`.
- Shows a window for ~10 s → local, opt-in, run by an agent only when Yasin OKs it for that PR (never in CI — OD1). Complements, never replaces, the ★ hand pass.

## 5. Risk of the gate itself
- Budget script: read-only, no deps; false failures only if the asar header format changes (Electron-stable for years) → the script then fails loudly, not silently.
- Cold-start/smoke: launches the real app → isolated `YASEEN_DRAW_USER_DATA_DIR` (read before the single-instance lock, `index.ts:26-29`, so it coexists with the installed app); never touches the real vault; temp dirs in `os.tmpdir()`.
- CI step adds < 1 s.

## ARCHITECTURE DECISIONS FOR YASIN

**D1 — Where the regression scenario list lives**
- Problem: every past S-list (S1–S48 etc.) is in Linear comments; the refactor needs ONE list that grows and that a PR can cite.
- Options: 1) keep per-issue lists in Linear only; 2) `docs/REGRESSION.md` in the repo (H-list above, IDs stable, each PR ticks the ★ core + the areas it touched, Linear links to it); 3) a Linear document.
- Recommendation: **2** — it versions with the code it protects, agents read it with CONTRACTS.md, and a PR can say "H-list ★ + D, W passed". Linear keeps the per-issue acceptance lists as today.

**D2 — Machine smoke test of the packaged app (CDP probe) given OD1 "no UI driver"**
- Problem: the riskiest breakages (secure context, fonts offline, draw.io handshake, worker chunk) are invisible to jsdom and the budget script; OD1 forbids a UI-driver suite.
- Options: 1) hand pass only; 2) `smoke.mjs` CDP probe — reads state + calls the bridge, never clicks — local, opt-in per PR, never in CI; 3) the same probe in CI on macOS (headful runner).
- Recommendation: **2** — matches the precedent already accepted on YAZ-1855/1897/1913, catches the silent classes in ~10 s, and leaves OD1 intact for CI. Needs an explicit yes because it launches the app.

**D3 — Windows in the gate**
- Problem: a shell refactor can break the Windows build, which is only built on a release tag.
- Options: 1) status quo; 2) `windows-latest` CI job running `npm run desktop:build:win` on PRs that touch `desktop/`, `tools/pack*`, `electron.vite.config.ts`; 3) manual `desktop:build:win` on the Mac before each release (R2).
- Recommendation: **2** for the duration of YAZ-2073 (it is exactly the project that touches packaging), then fall back to 3.

**D4 — Budget ratchet authority**
- Problem: without a rule, budgets drift back up.
- Options: 1) fixed ceilings; 2) ratchet: every PR lowers what it earned, raising needs Yasin's written OK.
- Recommendation: **2**.

**D5 — Cold-start baseline**
- Problem: no ms baseline exists; the script is ready but launches the app 12× (~1 min, window flashes).
- Recommendation: Yasin OKs one `npm run perf:budget -- --cold-start 5` on v0.1.11 to freeze the baseline before any optimization lands.

## EXECUTION ISSUE CANDIDATES
- **E1 — Add the size/integrity budget gate**: `tools/perf/measureBudget.mjs` + `budget.json` (from scratch copy), `perf:budget*` scripts, CI step `--out-only`; test: negative fixture (missing chunk, missing font family, missing Info.plist type) in `tools/perf/measureBudget.test.mjs`. ~½ day.
- **E2 — Freeze baselines**: run full gate + `--cold-start 5` on v0.1.11 (Yasin's OK), commit numbers to `budget.json`. ~1 h.
- **E3 — `docs/REGRESSION.md` H-list** (§4b), link it from CONTRACTS › Scripts and LAUNCH › Verify; import the Linear S-lists that are still valid (1775 demo, 1800, 1802 4A/4B, 1913, 1941, 1999, 2056) as sub-sections. ~½ day.
- **E4 — `tools/perf/smoke.mjs` CDP probe** (§4c), opt-in, local; asserts 1–7; document in LAUNCH.md. ~1 day. (Gated on D2.)
- **E5 — Windows PR build job** for the project's duration (D3). ~1 h.
- **E6 — Pre-refactor test backfill for untested reliability glue**: `ConflictBar`, `useWatch`, `SaveIndicator`, `dragSlot`, `main/watchedFolder`, `ipc/diagram` (envelope + validation), share viewer `entry/board/diagram.js` (jsdom: picks viewer by kind, download buttons honour permission). ~1 day.
- **E7 — Extract `index.ts`'s pre-`ready` wiring into a pure, tested module** (`startupOrder.ts`: registers `open-url`/`open-file`/`second-instance` + scheme privileges, asserts order) so later startup optimizations cannot reorder it unnoticed. ~½ day. Pairs with any "lazy main" optimization.
- **E8 — Protocol-privilege guard test**: unit test that `registerSchemesAsPrivileged` is called with `standard+secure+supportFetchAPI` for `app` (mock electron), with a comment naming the three engine features that depend on it. ~1 h.
- **E9 — Font single-source**: whatever size work dedupes fonts must keep canvas / export / draw.io / share viewer consumers; add a test in `packDrawio.test`/`buildShareViewer.test` asserting both copies come from the same source and cover the same families. ~½ day (only if size agents propose font dedupe).
- **E10 — Per-PR checklist in the PR template** for YAZ-2073 children: `npm test` ✓ · typecheck ✓ · `perf:budget` ✓ (numbers pasted, ceiling lowered) · smoke ✓ (if D2) · H-list ★ + touched areas ✓ by Yasin.
