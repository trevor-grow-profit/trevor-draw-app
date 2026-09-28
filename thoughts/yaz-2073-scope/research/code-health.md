# Code-health audit — YAZ-2074 (angle: "code-health", refactor-not-remove)

Repo `main @ 51e85cd` (v0.1.11). Read-only.

## 1. What I measured (commands + numbers)

- **LOC** (`git ls-files … | xargs wc -l`):
  - Prod TS/JS: **30,998 lines in 232 files**, of which **8,084 are comment lines (26%)**, 2,182 blank, so about 20.7k code. It carries **1,518 ticket refs** (YAZ-/GRO-). Prod CSS: 3,960 lines.
  - Tests are about 32k lines (client 17.4k, desktop 13.2k, shared 1.3k, tools 1.3k), which is 1.03× prod. That's healthy, and not a target.
  - By area (prod, including CSS): client/src 18,760; desktop/src 9,533; tools 3,158; shared 2,987; desktop/drawio-overlay 650; share 520.
- **Biggest prod files**:

  | File | Lines | Notes |
  |---|---|---|
  | `client/src/sidebar/Sidebar.tsx` | 1,499 | 22 useState, 28 effects, 15 refs, 27 useCallback |
  | `client/src/app.css` | 1,312 | |
  | `client/src/App.tsx` | 663 | 16 useState, 29 useCallback |
  | `client/src/drawings/ExcalidrawSurface.tsx` | 620 | |
  | `client/src/settings/settings.css` | 572 | |
  | `client/src/sidebar/VaultSwitcher.tsx` | 478 | |
  | `desktop/src/main/store.ts` | 471 | |
  | `client/src/image-studio/ImageStudio.tsx` | 463 | 19 useState |
  | `desktop/src/main/windows.ts` | 442 | |
  | `desktop/src/main/git/manager.ts` | 432 | |
  | `client/src/drawings/DrawingEditor.tsx` | 427 | |

  - Biggest test file: `Sidebar.test.tsx` at 3,214 lines.
- **Dead code** (`npx knip@5` with a research-only config, with and without tests):
  - **Unused files: 0 real.** Knip flagged 2, both false positives. `shared/links.ts` is reached through the `@shared` alias from `desktop/src/main/index.ts:7`. `share/viewer/drawioConfig.js` is copied by `tools/buildShareViewer.mjs:67`.
  - **Unused exports: 20 values and 47 types.** Every one of them is referenced inside its own file (checked by grep). They are over-exported, not dead, so dropping `export` removes 0 LOC.
  - Excluding test files, a further **~50 exports are used only by tests** (for example `tabsReducer`, `clampBounds`, `_resetSweeps`). These are deliberate test seams; keep them.
  - **Verdict: there is effectively no dead code to delete.** The codebase is disciplined here.
- **Dependencies**:
  - `@excalidraw/common` and `@excalidraw/fractional-indexing` are listed in `client/package.json` but never imported. They are required so npm resolves the vendored `file:` siblings, so keep them.
  - Workspace hygiene: `@vitejs/plugin-react` is declared in client but used by `desktop/electron.vite.config.ts`. `vite` is not listed in desktop. `esbuild` is declared in desktop but used by `tools/buildShareViewer.mjs`. Build-only; this has zero runtime effect.
- **Exact duplication** (`npx jscpd@4`, min 6 lines / 60 tokens):
  - Prod: **0.49%** (177 lines, 15 clones). 106 of those lines are in `tools/seed*.mjs`; the rest is `DrawingEditor` vs `DrawioEditor` (47 lines) and `fs/drawing.ts` vs `fs/diagram.ts` (10 lines).
  - Tests: 1.35%.
  - **Structural (non-literal) duplication is the real cost** (see section 2).
- **Vendored engine** (the Excalidraw fork, merge-base with `upstream/master` is `1acf66ed`):
  - Fork is **265 commits ahead**.
  - Prod source changed (excluding tests/snapshots/md):
    - excalidraw: +10,723 / −802 in 100 files
    - element: +2,211 / −125
    - common: +126
    - **math: 0, fractional-indexing: 0**. These two are byte-stock upstream-master rebuilds.
  - That is about 13k lines on a ~140k-line package base (~9%).
  - The fork also carries unrelated web-product code (`convex/` 17% and `worker/` of the changed files, plus `excalidraw-app/`).
  - The excalidraw tgz is 31.3 MB:
    - fonts twice (dist/prod/fonts 12.9 MB + dist/dev/fonts 12.9 MB)
    - dev build + source maps ≈ 10 MB
    - locales twice (5.3 + 2.0 MB)
  - Git history already holds **65 MB of tgz blobs** (2 generations × 5 packages, plus an old milkdown tgz). `.git` is 98 MB.
  - Unpacked `node_modules/@excalidraw/excalidraw` is 57 MB.
  - The fork's runtime deps include `sass` and `cross-env`, which add install weight, not bundle weight.
- **Packaged-app asset duplication**: `shasum` over all 247 woff2 files shows `Resources/share-viewer/fonts/` (13 MB) is **byte-identical** to `app.asar:/out/renderer/excalidraw-assets/fonts/` (13 MB).

## 2. Findings ranked by impact

### R1. Ship the Excalidraw fonts once (−13 MB installed, −247 files) — high impact, small change

- **Evidence**:
  - `tools/buildShareViewer.mjs:67` copies `@excalidraw/excalidraw/dist/prod/fonts` into `share/dist/assets/fonts`, which ships as `extraResources → share-viewer`.
  - `desktop/electron.vite.config.ts:57` (`excalidrawAssets().writeBundle`) copies the same folder into `out/renderer/excalidraw-assets/fonts` inside the asar. The hashes are identical.
  - draw.io already follows the "never carry bytes twice" rule. `desktop/src/main/ipc/share.ts:48-64` (`readViewerAssets`) reads draw.io from `out/drawio` in the asar. Fonts just weren't moved to that rule.
- **Refactor**:
  - Pass `fontsDir` (the renderer's `excalidraw-assets/fonts`, `app.getAppPath()/out/renderer/…`) next to `drawioDir`.
  - In `readViewerAssets`, add `...(await filesUnder(fontsDir, fontsDir, '/assets/fonts/'))`.
  - Delete `buildShareViewer.mjs:67`.
  - `tools/fakeCloudflare.mjs` must serve `/assets/fonts/` from node_modules in the demo.
- **Diff sketch**:
  ```diff
  --- tools/buildShareViewer.mjs
  @@ -67 +67 @@
  -  fs.cpSync(path.join(pkgDir('@excalidraw/excalidraw'), 'dist', 'prod', 'fonts'), path.join(OUT, 'fonts'), { recursive: true })
  +  // fonts/: NOT copied — share setup publishes them from the renderer's excalidraw-assets (one copy in the app)
  --- desktop/src/main/ipc/share.ts
  @@ -48 +48 @@
  -export async function readViewerAssets(dir: string, drawioDir: string): Promise<AssetFile[]> {
  +export async function readViewerAssets(dir: string, drawioDir: string, fontsDir: string): Promise<AssetFile[]> {
  @@ -60 +60,2 @@
     const own = await filesUnder(dir, dir, '/assets/')
  +  const fonts = await filesUnder(fontsDir, fontsDir, '/assets/fonts/')
  @@ -63 +64 @@
  -  return Promise.all([...own, ...drawioFiles, ...drawioDirs].map(…
  +  return Promise.all([...own, ...fonts, ...drawioFiles, ...drawioDirs].map(…
  ```
- **Risk**: the share setup upload list changes. `tools/buildShareViewer.mjs:34` (`diagramFontCss`) points drawio fonts at `/assets/fonts/`, and it still works because the upload path is unchanged.
- **Proof**:
  - Update `buildShareViewer.test.mjs` and `share.test` / `sharing.test` so the asset manifest is identical before and after (same path set, same bytes).
  - Run the fakeCloudflare demo: set up sharing, open a shared text board, and check fonts load (Network 200 on `/assets/fonts/*`).

### R2. One declarative IPC contract (≈ −700 to −900 LOC including tests; removes a whole drift-bug class)

- **Evidence**: the bridge is declared **five times** by hand.

  | Declaration | Lines |
  |---|---|
  | `shared/types/*` `*Api` interfaces (17 interfaces) | 343 |
  | `desktop/src/channels.ts` (93 channel strings) | 132 |
  | `desktop/src/preload/index.ts` (63 `call(CH.x)` + 26 `on<>`) | 194 |
  | `client/src/api.ts` (62 re-typed wrappers, each restating the generic already in the interface) | 155 |
  | `desktop/src/preload/bridge.test.ts` (exists only to catch drift between the four above) | 405 |
  | **Total** | **1,229** |

- **Layering leak**: the renderer reaches main two ways.
  - Through `api.ts`, which converts errors to `BridgeRequestError`.
  - Directly through `window.yaseenDraw`, in 11 files / 28 sites (for example `client/src/lib/storage.ts:51-189`, `App.tsx:251,258,412,467`, `DrawingEditor.tsx:291`, `DrawioEditor.tsx:326`). These get raw `BridgeError`s.
- **Refactor**:
  - Add `shared/ipc.ts` with a single table: `CONTRACT = { tree: invoke<[root: string], TreeResponse>('fs:tree'), drawing: { load: invoke<[DrawingLoadRequest], DrawingLoadResponse>('drawing:load'), … }, state: { onChange: push<AppState>('state:changed') }, … }`.
  - Add a mapped type `Api<typeof CONTRACT>` that produces `YaseenDrawApi`.
  - Preload: `exposeInMainWorld('yaseenDraw', buildBridge(CONTRACT))`, a ~25-line tree walk. `watch` and `onFlush` stay hand-written specials.
  - Main: `handle(CONTRACT.drawing.load, fn)`, typed from the table. Runtime validation stays, because args still arrive as `unknown`.
  - Renderer: `api = wrapErrors(window.yaseenDraw)`, a ~15-line generic. Keep the 4 convenience adapters (`share.accounts(token)`, `share.list(root, check)`, `share.setDomain`, `share.disconnect`) as explicit overrides.
  - Replace `bridge.test.ts` with a generic builder test plus "every CONTRACT channel has exactly one `ipcMain.handle`".
- **Risk**:
  - Security posture is unchanged: the channel allowlist is still fixed at build time and `contextIsolation` is unaffected.
  - Do it in one PR per namespace behind the generic builder, to keep diffs reviewable.
- **Proof**:
  - `npm run typecheck`, which becomes the drift guard.
  - Full `vitest run`.
  - A snapshot test of `Object.keys` of the exposed bridge before and after (must be equal).

### R3. Extract `useBoardDocument` from DrawingEditor + DrawioEditor (≈ −120 prod, ≈ −200 test LOC; one place for the save/conflict rules)

- **Evidence**: `DrawioEditor.tsx:1-3` calls itself "`DrawingEditor`'s twin", and the two hold the same state machine written twice:
  - Load/error shell: `DrawingEditor.tsx:126-181` ≈ `DrawioEditor.tsx:64-107`.
  - Watcher echo/reload/conflict rule: `DrawingEditor.tsx:266-280` = `DrawioEditor.tsx:258-270` (jscpd exact clone).
  - `keepMine`: 282-287 = 272-277.
  - Flush handshake plus unmount flush: 291-304 = 326-338 (clone).
  - Rename continuity: 307-320 = 340-352.
  - Board-command listener: 325-340 ≈ 314-323.
  - Reveal/focus `IntersectionObserver`: 348-359 ≈ 354-363.
  - `SaveConflict` wrapping in `save`: 214-218 = 150-153.
  - Export try/catch notice: 389-396 = 301-308 (clone).
  - Chips JSX: 365-371 ≈ 367-370.
- **Refactor**:
  - Add `client/src/documents/useBoardDocument.ts`. It owns `Autosave`, `retired`, `conflictMtime`, the watcher rule, flush, rename continuity, the focus observer and the command routing. It takes `{ root, path, watch, save(expectedMtime), reload(), onCommand, focusTarget }` and returns `{ status, conflictBar, chips, autosaveRef }`.
  - Add a `<BoardDocumentShell load={…} errorText={…}>` component for the outer load/error/loading section.
  - Both editors shrink to their engine-specific parts: snapshot/baseline handling for Excalidraw, and the postMessage handshake for draw.io.
- **Risk**: medium. This touches the autosave/conflict path, which is the most reliability-critical code.
- **Proof**:
  - Keep **all** existing `DrawingEditor.test.tsx` (662) and `DrawioEditor.test.tsx` (435) cases green, unmodified, before trimming anything.
  - Then move the shared cases (conflict, flush, rename-retire, echo) to `useBoardDocument.test.tsx` and delete the duplicates.
  - Manual pass: two windows on one board, a conflict, Keep mine, a rename mid-edit, and ⌘Q with unsaved edits, once for each kind.

### R4. Decompose `Sidebar.tsx` (1,499 lines) into feature hooks and isolate high-frequency state (perf and readability; ≈ 0 to −100 LOC)

- **Evidence**:
  - About 12 concerns in one component: favorites, focus mode, multi-select, sort, info popover, delete confirm, drag-move, search, hover preview, expand-all, reveal, clipboard.
  - It has 22 useState, 28 effects and 27 useCallback. Comments are 28% of the file (418 lines).
  - There is **no `React.memo` anywhere in client/src** (`git grep "memo("` returns 0 hits).
  - **Hover preview state lives in Sidebar** (`Sidebar.tsx:420-449`). Each row the pointer crosses fires `closePreview → setHover(null)` and then `setHover(pending)` (`:434,:445`), plus a third `setHover(shown)` after 400 ms. `Tree.tsx:187` wires this to `onMouseEnter`/`onMouseLeave`/`onFocus`/`onBlur` on every file row.
  - So **sweeping the pointer across N rows re-renders the whole Sidebar and the whole recursive `Tree` about 2N times**. Search keystrokes and every other Sidebar state change re-render the full tree as well.
- **Refactor**:
  - Add `sidebar/hooks/{useHoverPreview,useFavoritesLens,useFocusMode,useSidebarSearch,useTreeDrag}.ts`.
  - Move the hover state into a tiny `<HoverPreviewHost>` sibling that owns `setHover`, so rows call a stable ref-backed function and the Tree never re-renders on hover.
  - Wrap `Tree` in `memo`. Its props must be stable: `recurse` at `Tree.tsx:175` is rebuilt each render, and should become `useMemo` or a context.
- **Risk**: medium. The behaviour is pinned by `Sidebar.test.tsx` (3,214 lines), which must stay green unmodified through the split.
- **Proof**:
  - Tests.
  - React Profiler over a ~2,000-file seeded vault (`tools/seedDemoVault.mjs` extended): count `Tree` commits during a 20-row pointer sweep. Target 0 Tree commits, down from about 40.

### R5. Sidebar resize re-renders the whole app on every mousemove — small diff

- **Evidence**:
  - `App.tsx:137-141` calls `setSidebarWidth(width)` on every `mousemove`.
  - The only consumers are the `--side-w` CSS var effect (`App.tsx:208`) and the drag start (`:133`).
  - Each move therefore re-renders App, Sidebar and the full Tree, TabBar and every mounted editor host (`DrawingEditor`; the inner `<Excalidraw>` is memoized).
- **Diff** (`client/src/App.tsx`):
  ```diff
  @@ -137,23 +137,26 @@
         const move = (ev: MouseEvent) => {
           raw = start + ev.clientX - x0
           width = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, raw))
  -        setSidebarWidth(width)
  +        // Paint-only while dragging: the CSS var, not React state (one App render per drag, not per pixel).
  +        document.documentElement.style.setProperty('--side-w', `${width}px`)
         }
         const up = () => {
           window.removeEventListener('mousemove', move)
           window.removeEventListener('mouseup', up)
           document.body.style.cursor = ''
           setResizing(false)
           if (raw < SIDEBAR_MIN_W * 0.6) {
  -          setSidebarWidth(start)
  +          document.documentElement.style.setProperty('--side-w', `${start}px`)
             toggleSidebar()
  -        } else if (width !== start) storage.setSidebarWidth(width)
  +        } else if (width !== start) {
  +          setSidebarWidth(width)
  +          storage.setSidebarWidth(width)
  +        }
         }
  ```
- **Risk**: low. App.test may assert the state mid-drag, but it reads `--side-w`, which is still set.
- **Proof**: App.test resize cases, plus a Profiler check of commits during a drag (from 1 per move to 1 total).

### R6. One separator-aware path-containment helper (fixes 2 confirmed Windows logic bugs; ≈ −15 LOC)

- **Evidence**: containment is reimplemented about 14 times.
  - With a hard-coded `/`:
    - `desktop/src/main/favorites.ts:29` (`under`, used at :95, :119, :140)
    - `desktop/src/main/share/boards.ts:21` (`within`, used at :23, :217, :245)
    - `windows.ts:167` (`rootContains`)
    - `useWorkspace.ts:211`
    - `Sidebar.tsx:267,664,694,712`
    - `treeState.ts:26,56,65`
    - `liveShare.ts:69`
    - `App.tsx:417`
    - `lib/paths.ts:14`
  - With `path.sep`: `fs/drawing.ts:67`, `fs/diagram.ts:22`, `drawio/assets.ts:79`.
  - `client/src/lib/paths.ts:25` (`vaultPath`) already handles `\`, so the codebase knows Windows paths exist, and `desktop:build:win` ships an NSIS x64 target.
- **Measured** (the real `shared/links.ts` run under node 26 in scratch):
  - **Windows file-association double-click**: `fileLink('C:\\Users\\me\\Vault\\Board.excalidraw')` gives `yaseendraw://C:%5CUsers…`, and **`parseFileLink` returns `null`**. `index.ts:35,229` therefore turn every Windows double-click into a "Can't open link" notice (`index.ts:52-55`).
  - **Windows favorites**: `under('C:\\v', 'C:\\v\\a.excalidraw') === false`, so `setFavorites` throws "a favorite must be inside the vault" (`favorites.ts:95`) for every Windows favorite.
  - Status: UNCONFIRMED on a real Windows machine; confirmed at the logic level.
- **Refactor**:
  - Add `shared/paths.ts`:
    ```ts
    export const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')
    export const isWithin = (base: string, p: string, strict = false) => {
      const b = base.replace(/[\\/]+$/, '')
      const s = sepOf(b)
      return (!strict && p === b) || p.startsWith(b + s)
    }
    ```
  - Replace the ~14 sites with `isWithin`.
  - `shared/links.ts`: encode a drive path as `/C:/…` (forward slashes) and decode it back when `/^\/[A-Za-z]:\//` matches.
- **Diff** (favorites):
  ```diff
  --- desktop/src/main/favorites.ts
  @@ -29 +29 @@
  -const under = (root: string, p: string): boolean => p === root || p.startsWith(`${root}/`)
  +const under = (root: string, p: string): boolean => isWithin(root, p)   // import { isWithin } from '@shared/paths'
  --- desktop/src/main/share/boards.ts
  @@ -21 +21 @@
  -const within = (abs: string, base: string) => abs === base || abs.startsWith(`${base}/`)
  +const within = (abs: string, base: string) => isWithin(base, abs)
  ```
- **Risk**: low on macOS, because behaviour is identical for POSIX paths.
- **Proof**:
  - Table tests in `shared/paths.test.ts` covering POSIX, `C:\`, trailing separators, and a sibling prefix (`/v` vs `/vault`).
  - Add Windows cases to `links.test.ts`, `favorites.test.ts` and `boards` tests.

### R7. Seed-script kit for tools/ (≈ −450 to −500 LOC, dev-only)

- **Evidence**: 7 `tools/seed*.mjs` scripts total 1,893 lines, and each redefines the same helpers:
  - Scene builders (`rect`/`text`/`ellipse`/`arrow`/`frame`/`image`/`board`/`scene`, about 3–4 copies each).
  - A PNG encoder (`crc32`/`chunk`/`png`/`noisyPNG`: `seedDemoVault.mjs:71-130`, `seedDrawioDemoVault.mjs:70-93`, `seedPreviewDemoVault.mjs:57-81`, `seedShareDemoVault.mjs:57-89`, `seedStorageDemoVault.mjs:92-148`).
  - `flag()` ×5, `git()` ×3, `write()` ×4.
  - jscpd finds 106 cloned lines just among these.
  - `tools/lib/seedDemoVault.mjs` (68 lines) exists but only 2 scripts use it.
- **Refactor**: add `tools/lib/seedKit.mjs` exporting `png`/`noisyPNG`/`gradientPNG`, `el.{rect,text,…}`, `scene()`, `board()`, `asset()`, `flag()`, `git()`, `write()`. Each seed script keeps only its data.
- **Risk**: none at runtime.
- **Proof**:
  - `seedDemoVault.test.mjs`.
  - Run each seed script and diff the generated vault trees before/after. They should be byte-identical except for random ids; seed the RNG for the comparison.

### R8. Declarative request validation in main (≈ −60 LOC, uniform error text)

- **Evidence**:
  - **120** hand-written `throw new BridgeFailure('BAD_REQUEST', …)`.
  - **13** copies of `typeof req !== 'object' || req === null` → "request must be an object" (`fileClip.ts:51`, `fs/copy.ts:107`, `create.ts:34`, `diagram.ts:29`, `drawing.ts:74`, `openDefault.ts:17`, `openInVsCode.ts:29`, `remove.ts:35`, `rename.ts:43`, `reveal.ts:25`, `ipc/state.ts:11`, `ipc/window.ts:71,106`).
  - 58 `'x' must be a …` checks.
  - `ipc/share.ts` already has local `req()`/`str()` helpers (`:97-106`), a third style.
- **Refactor**:
  - Add `fs/fsUtils.ts` → `requireObject(raw, what='request')`, `str(body,'k')`, `optStr`, `optNum`, `bool`.
  - Promote `share.ts`'s helpers to it.
  - Move `isStringArray` from `store.ts:85` into `shared/guards.ts`.
- **Risk**: low, as long as the messages stay byte-identical where tests pin them.
- **Proof**: desktop vitest; grep the tests for the pinned message strings first.

### R9. Unify `fs/drawing.ts` and `fs/diagram.ts` document resolution (≈ −25 LOC)

- **Evidence**:
  - `resolveDocument` (`drawing.ts:64-70`) ≡ `resolveDiagram` (`diagram.ts:19-25`), differing only in `isDrawing`/`isDiagram` and the message.
  - `target()` (`drawing.ts:73-78`) ≡ `diagram.ts:28-33` (jscpd clone).
  - The conflict guard plus stamp-with-prior-head block is the same shape in both saves.
- **Refactor**: add `fs/boardDocument.ts` with `resolveBoard(dir, rel, kind)`, `boardTarget(raw, kind)` and `guardedStampedWrite(file, prior, expectedMtime, stamp, max, label)`.
- **Risk**: low. **Proof**: `drawing.test.ts` and `diagram` tests green.

### R10. Small hygiene diffs (≈ −10 LOC each, zero risk)

- **Duplicate guard**:
  ```diff
  --- shared/drawingAssets.ts
  @@ -1 +1,2 @@
   import type { BoardMeta } from './types/files'
  +import { isRecord as isPlainObject } from './guards'
  @@ -151 +151,0 @@
  -const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  --- shared/canvasPrefs.ts
  @@ -61 +61 @@
  -  return typeof v === 'object' && v !== null && !Array.isArray(v) && CANVAS_PREF_KEYS.every((k) => FIELD_OK[k]((v as Record<string, unknown>)[k]))
  +  return isRecord(v) && CANVAS_PREF_KEYS.every((k) => FIELD_OK[k](v[k]))
  @@ -66 +66 @@
  -  const src = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  +  const src = isRecord(raw) ? raw : {}
  ```
- **Unbounded memory: the Image Studio tile cache** (every search tile's dataURL is kept for the session; the board-preview cache is already capped at 32 in `boardPreviewCache.ts:69`):
  ```diff
  --- client/src/image-studio/ImageStudio.tsx
  @@ -68,5 +68,5 @@
   const previews = createPreviewCache(async (key) => {
     const [provider, ...rest] = key.split(':')
     const { dataURL } = await api.media.preview({ provider: provider as MediaBytesProvider, id: rest.join(':') })
     return dataURL
  -})
  +}, { limit: 300 }) // LRU: a long browse session must not keep every tile it ever showed (main's disk cache refills in ms)
  ```
- **Main-only modules in shared/**:
  - `shared/boardMerge.ts`, `shared/links.ts` and `shared/mediaLibrary.ts` have 0 client importers. `links.ts:5` claims the client generates links, but no client file imports it.
  - Either move them to `desktop/src/main/` or keep them there for purity and document it. Cosmetic.
- **Workspace deps**: move `@vitejs/plugin-react`, `vite` and `esbuild` to the root devDependencies. Build-graph honesty only.

## 3. Vendored engine: cost of how it's vendored

- **Customization is real, not cosmetic**: about 13k prod lines (Writing mode, smart shapes, text lists/underlines, presentation hooks, R2 scene work).
  - `math` and `fractional-indexing` are **stock** upstream-master rebuilds. They're vendored only because upstream-master isn't on npm.
  - The fork's `packages/excalidraw/presentation/*` is about 4.9k lines, but only `animationRuntimePolicy` is imported by the package (`App.tsx:319`, `staticScene.ts:37`). The rest tree-shakes out, so there is no bundle cost.
- **Maintenance and size costs of the tgz-in-git model**:
  1. **Repo weight**: +33 MB of git blobs per bump, forever. There have been 2 bumps so far (65 MB), and `.git` is 98 MB.
  2. **Tarball content ×2**: dev and prod builds, dev source maps, fonts twice, locales twice. The app only consumes prod at build time. Vite resolves the `development` condition under `electron-vite dev`, so dev is only a dev-server convenience.
  3. **Five packages** where two are stock.
  4. **The fork mixes engine and web product** (`convex/`, `worker/`, `excalidraw-app/`), so every engine bump rebuilds against unrelated churn.
  5. **Undocumented CSS coupling to engine internals**: 36 engine-owned selectors in app CSS (`drawings/drawingEditor.css` 31, `presentation/presentation.css` 5, plus `ExcalidrawSurface.tsx:490` `.excalidraw-container`). `tools/packEngine.mjs:6-8` warns that "nothing pins those class names but the fork itself".
  6. `packEngine.mjs` plus `lib/packEngine.mjs` (366 lines) plus a 260-line test exist mainly to work around npm `file:` integrity traps (README "two traps").
- The runtime bundle impact of vendoring is **nil**: the same code would be bundled from a registry. **The cost is repo/CI weight and bump friction, not app size.**

## 4. Risk summary / how to prove no regression (all items)

- **Gate on every PR**: `npm run typecheck`, `vitest run` (all three projects), `npm run desktop:build`, then launch the packaged app and hand-test the golden paths:
  - open / edit / autosave / conflict / rename / delete a board and a diagram
  - share setup + view (fakeCloudflare demo)
  - GitHub sync
  - Image Studio insert
- **Never edit a test's expectations in the same PR that moves code.** Move first (tests unchanged and green), then dedupe tests in a follow-up.
- Perf items (R4, R5): record a React Profiler trace before and after on a seeded 2k-file vault.

## 5. ARCHITECTURE DECISIONS FOR YASIN

**AD1 — IPC contract as data (R2)**
- **Problem**: the bridge is spelled 5× (1,229 lines) and a drift test guards it; the renderer uses two access styles.
- **Options**:
  1. Keep it as is.
  2. Single `CONTRACT` table in `shared/ipc.ts` + generated preload/renderer wrappers (types derived).
  3. Adopt a library such as electron-trpc.
- **Recommendation: 2.** It's zero-dependency, keeps the explicit allowlist and envelope, and deletes the drift class. Option 3 adds a dependency and a new mental model for the same gain.

**AD2 — Board-document host abstraction (R3)**
- **Problem**: the drawing and diagram editors duplicate the save/conflict/flush/rename state machine.
- **Options**:
  1. Keep the twins.
  2. A shared hook + shell.
  3. A generic `<BoardEditor engine={…}>` component with an engine adapter interface.
- **Recommendation: 2.** It gives the same reliability win with less indirection. Option 3 only pays off if a third board kind arrives.

**AD3 — Render isolation strategy for the sidebar (R4)**
- **Problem**: there is no memoization anywhere, so hover, search and resize re-render the whole tree.
- **Options**:
  1. Targeted: colocate hot state + `memo(Tree)` + stable props.
  2. Adopt the React Compiler (babel-plugin-react-compiler) for auto-memo across client.
  3. Virtualize the tree (react-window).
- **Recommendation: 1 now.** It's surgical, measurable and needs no new build dependency.
  - Evaluate 2 as a separate spike: it could delete many of the 171 `useCallback`/`useMemo` calls, but it changes the semantics of the ref-heavy engine glue in `ExcalidrawSurface`, so it needs its own proof.
  - Pursue 3 only if the Profiler shows large vaults still slow after 1.

**AD4 — How the engine fork is consumed (section 3)**
- **Problem**: +33 MB of git per bump, 5 packages (2 stock), dev+prod in every tarball, web-product churn in the fork.
- **Options**:
  1. Status quo.
  2. Same tgz model, but the fork's pack step emits **prod-only** packages (drop `dist/dev` + maps + duplicate fonts/locales, about −17 MB per tgz) and stores the tgz in **Git LFS**.
  3. Publish the fork packages to a private registry (GitHub Packages, `@yaseendraw/*`) and delete `client/vendor` + most of `packEngine`.
  4. Split the fork: an engine-only branch/repo (packages/*) separate from the web product (convex/worker/excalidraw-app).
- **Recommendation: 3 + 4 over time; 2 as the immediate step.**
  - Option 2 keeps "pinned, no patching" (YAZ-868 D1/D2) and needs no new infrastructure.
  - Option 3 removes the npm `file:` integrity traps entirely (about 450 lines of pack tooling and tests).
  - Option 4 makes engine bumps reviewable.
  - None of these changes app bytes; they cut repo, CI and bump cost.

**AD5 — Engine-owned CSS selectors (36 in app CSS)**
- **Problem**: app styling depends on fork-internal class names that nothing pins.
- **Options**:
  1. Keep them, with the packEngine reminder.
  2. Move these overrides into the fork's own SCSS (the fork is ours) behind a `yaseenDesktop` UI-mode flag, which already exists as `YASEEN_FULL_TOOLBAR_MODE` / `DESKTOP_UI_MODE_STORAGE_KEY` in `engine.ts`.
  3. Add a pin test that renders `<Excalidraw>` in jsdom and asserts the selectors exist.
- **Recommendation: 3 now, 2 opportunistically.** Option 3 turns a silent break into a red test at bump time.

**AD6 — Unbounded mounted editors (context for R3/R4)**
- **Problem**: `useWorkspace.ts:23-27` keeps every visited tab's editor mounted for the session, with no cap. Each is a live Excalidraw instance or a draw.io iframe.
- **Options**:
  1. Keep it.
  2. An LRU cap (say 6) on `mounted`, with a flush-then-unmount of the least-recently-used tab (the flush path already exists: `autosave.flush`).
  3. Unmount on hide, snapshotting view state.
- **Recommendation: 2.** It bounds memory with an existing, tested flush. The cost is a remount delay on returning to an evicted tab. Coordinate with the perf/memory angle.

## 6. EXECUTION ISSUE CANDIDATES (Linear sub-issues)

1. **Ship Excalidraw fonts once**: share setup publishes `/assets/fonts/` from `out/renderer/excalidraw-assets/fonts`; drop the copy in `buildShareViewer`; fakeCloudflare serves from node_modules. (−13 MB installed.) [S]
2. **Sidebar resize without React churn**: the R5 diff plus a Profiler check. [XS]
3. **Bound the Image Studio preview cache**: the R10 diff. [XS]
4. **`shared/paths.ts` `isWithin` + Windows-safe `fileLink`/`parseFileLink`**: replace about 14 containment sites; add Windows table tests; fixes the Windows double-click open and favorites. [S]
5. **IPC contract as data**, phase A: `shared/ipc.ts` + typed builder + preload generation (bridge surface byte-for-byte equal). [M]
6. **IPC contract as data**, phase B: `client/src/api.ts` generated `wrapErrors`; route `storage.ts`/App/editors through `api`; replace `bridge.test.ts`. [M]
7. **`useBoardDocument` + `BoardDocumentShell`**: move only (tests untouched). [M]
8. **Dedupe DrawingEditor/DrawioEditor tests** into `useBoardDocument.test.tsx`. [S]
9. **Sidebar decomposition**: extract the 5 feature hooks (tests untouched). [L]
10. **Hover/search render isolation**: `HoverPreviewHost`, `memo(Tree)`, stable `recurse` props; Profiler proof on a 2k-file seeded vault. [M]
11. **Main request-validation helpers** (`requireObject`/`str`/`optNum`…), and move `isStringArray` to `shared/guards`. [S]
12. **`fs/boardDocument.ts`**: unify drawing/diagram resolve, target and guarded write. [S]
13. **`tools/lib/seedKit.mjs`**: collapse the 7 seed scripts' helpers; seeded-RNG before/after diff. [S]
14. **Small hygiene**: `isRecord` reuse (drawingAssets, canvasPrefs); root devDeps for plugin-react/vite/esbuild; move main-only modules out of `shared/` (or document why they stay). [XS]
15. **Engine pin test** for the 36 engine-owned selectors (AD5 option 3). [S]
16. **Fork pack emits prod-only tarballs + Git LFS for `client/vendor`** (AD4 option 2); decision needed first. [M]
17. **Spike: React Compiler on client** (AD3 option 2): measure the diff in commits and bundle size, with the ExcalidrawSurface risk review. [M, spike]
18. **LRU cap on mounted editors** (AD6), coordinated with the perf angle. [M]

**Estimated net reduction if 1–14 land**:
- About 1,500–1,900 LOC (prod plus tests, including about 500 in tools).
- −13 MB installed.
- Two Windows logic bugs fixed.
- Sidebar hover/resize commits drop from O(rows) to O(1).
- No feature is removed.
