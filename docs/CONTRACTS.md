# Yaseen Draw — contracts

The one document an agent should read before changing anything. It states what is true about the
app's shape — layout, bridge, state, menus, windows, links, packaging — not how any one feature is
implemented. Prose here is normative; where it disagrees with the code, the code is a bug.

**Convention.** 🔒 marks a decision that is LOCKED: it was argued once, and must not be
re-litigated in passing — reopen it on its issue or leave it alone. ⚡ marks an amendment to an
earlier locked decision; the amendment wins.

Every label NAMES ITS ISSUE, because the numbering restarts per issue: `🔒 YAZ-1775 D3` is the
port's image-bytes decision, `🔒 YAZ-1674 D3` is the file clipboard's third, and the two have
nothing to do with each other. A bare `D3` would be unresolvable, so there are none.

> Yaseen Draw is the drawing sibling of Yaseen Docs. It was seeded from `yaseen-docs-app`
> @ `66c9806` (🔒 YAZ-1775 D1) and then stripped of every subsystem the canvas does not need
> (YAZ-1808).
> Git history before the seed lives in that repo, not this one.

## Repo layout

| Path | What it is |
|---|---|
| `client/` | the renderer: React 19, Vite. Talks to nothing but `window.yaseenDraw`. |
| `client/src/drawings/` | the drawing document: the engine seam (`ExcalidrawSurface`, the ONE importer of the package), its host, and what a scene is |
| `client/src/diagrams/` | the draw.io diagram document (YAZ-1802): `DrawioEditor` (the iframe host), `drawioProtocol.ts` (the postMessage dialect and the configure object) and `renderDiagram.ts` (the D9 renderer: the hover picture, Version history's pictures, Export Image…) |
| `desktop/drawio-overlay/` | OUR files laid over the draw.io webapp by `tools/packDrawio.mjs`: the `PreConfig.js` / `PostConfig.js` config hooks (page view off, ⌘-wheel zoom, the keymap) and the preview page `yaseen-render.html` — draw.io's own files are never modified |
| `client/src/drawings/presentation/` | the canvas panel's Present tab: the slide rules, the panel and the full-pane player |
| `client/src/image-studio/` | the canvas panel's Images tab: the Image Studio, the shapes catalog, both insert paths |
| `client/src/components-library/` | the canvas panel's Components tab: the saved-component library, its capture, import, preview and insert (named so it is never confused with `client/src/components/`) |
| `client/src/sidebar/` | the file tree, its context menu, rename/move/trash, favorites, vault switcher (one-line rows with a hover ⓘ full path and vault display names since YAZ-2056) and its right-click vault menu (items as data in `vaultMenuSections.ts`) |
| `client/src/tabs/` | the tab strip |
| `client/src/workspace/` | the tab model (`tabsReducer`) and its per-tab history |
| `client/src/settings/` | the settings dialog and its registry |
| `client/src/search/` | ⌘K title search and the one ranking matcher |
| `client/vendor/` | the five vendored `yaseendraw-*-<forkCommit>.tgz` engine tarballs (🔒 YAZ-1775 D2) |
| `desktop/` | the Electron shell: `src/main` (files, state, windows, menu, git sync), `src/preload` (the bridge) |
| `shared/` | types and pure helpers imported by BOTH sides (`@shared/*`); the contracts are grouped by domain under `shared/types/` behind the `@shared/types` barrel, so no consumer depends on the grouping |
| `tools/` | `packEngine.mjs` (bump the vendored engine), `packDesktop.mjs` (electron-builder), `seedDemoVault.mjs` (the stress-test vault the behaviour checks run against), `seedSortDemoVault.mjs` / `seedPreviewDemoVault.mjs` (the demo vaults behind YAZ-1835 and YAZ-1800, each proved by an integration test); the pure halves of `packEngine` and `seedDemoVault` live in `tools/lib/` beside their tests; `perf/` is the size gate and the perf harness (YAZ-2073, below) |
| `e2e/` | the Playwright E2E suite (🔒 YAZ-2073 D17): `*.spec.ts` by feature area, `support/` for the launcher fixture, vault builders and the main-process hook that keeps OS hand-offs inside the test's sandbox |
| `docs/` | this file, and `REGRESSION.md` — the hand-scenario list (stable IDs, ★ core) |
| `thoughts/ledgers/` | continuity ledgers for in-flight work |

### Scripts

| Command | What it does |
|---|---|
| `npm install` | installs the workspaces and unpacks the vendored engine tarballs |
| `npm run dev` | `electron-vite dev` in `desktop/`: main + preload built, renderer served with HMR |
| `npm test` | vitest, three projects — `client` (jsdom), `desktop` (node), `tools` (node) |
| `npm run test:watch` | the same suites, re-run on save |
| `npm run typecheck` | `tsc --noEmit` over client, shared and desktop |
| `npm run drawio:pack` | `tools/packDrawio.mjs`: download the pinned draw.io release once (sha256-checked), unpack it into `desktop/.cache/drawio/<tag>/` (gitignored) and lay the overlay over it — idempotent; `desktop`'s `dev` and `build` run it first |
| `npm run build` | `electron-vite build` into `desktop/out`, then `tools/buildShareViewer.mjs` into `share/dist/assets` (wiped first, gitignored) |
| `npm run desktop:build` | build + electron-builder → `desktop/dist-app` (`--win` variant for Windows) |
| `npm run perf:budget` | `tools/perf/measureBudget.mjs`, the size and integrity gate (YAZ-2073 1A): bytes of the `.app`, DMG, asar, share viewer, Chromium locales and renderer against `tools/perf/budget.json`, plus what no unit test sees — Info.plist types and scheme, the ad-hoc seal, every lazily imported chunk shipped, the 13 Excalidraw font families, the draw.io files, the storage worker — and the bytes shipped twice. `perf:budget:ci` (`--out-only`) checks `desktop/out` alone; CI runs it after the build |
| `npm run perf -- <scenario…\|all>` | `tools/perf/run.mjs`, the perf harness (YAZ-2073 1B): launches the packaged app (`--dev`: `desktop/out`) on seeded fixtures in an isolated profile, drives it over the DevTools protocol, and prints per-metric medians / p95 / noise as JSON against the `perf` ceilings. Scenarios: `launch`, `drawio`, `canvas-1k` / `-4k` (and `-dark`), `canvas-images`, `canvas-legacy`, `hover`, `drawers`, `storm`, `idle`, `heavy-tabs`, `quit-flush`. Local only — it opens windows |
| `npm run e2e` | build, then the Playwright suite in `e2e/` against the BUILT app (`desktop/out`): every test launches it on its own throwaway profile and sandboxed vaults under the OS temp dir; `E2E_WORKERS` (default 3) sets parallelism, `E2E_SHOW=1` shows the windows, `E2E_KEEP=1` keeps passing tests' sandboxes, `E2E_PACKAGED=1` runs against `desktop/dist-app` from `desktop:build` instead (share specs skip: their endpoint overrides are unpackaged-only); extra args go to `playwright test` after `--` |

⚡ YAZ-2073 D17 amends 🔒 OD1 on YAZ-1805 ("no UI driver"): Yasin turned Playwright ON as the
no-feature-loss guarantee for the speed project. `npm run e2e` is a local command, not a CI step.
It never touches the real profile or a real vault, and `e2e/support/mainHook.cjs` keeps the OS out
of it: Trash, Finder, default-app and browser hand-offs are recorded in the sandbox instead of run,
and the `yaseendraw://` registration is skipped. What it cannot see — the packaged app, the OS, how
things look, a real browser, Windows — is the hand pass in [`docs/REGRESSION.md`](REGRESSION.md),
which every bundle/shell PR runs (★ core + the areas it touched) and cites by ID.

## Supported file capabilities

Two kinds of BOARD, one extension each (🔒 YAZ-1802 D1 / D2).

| Extension | Kind | Read | Write | Create |
|---|---|---|---|---|
| `.excalidraw` | `drawing` | yes | yes | yes |
| `.drawio` | `diagram` | yes | yes | yes |
| anything else (`x.drawio.svg` included) | `null` | no | no | no |

- `shared/fileKind.ts` is the ONE classifier: `fileKind(name)` returns `'drawing'`, `'diagram'` or
  `null`, case-insensitively (`UP.DRAWIO` is a diagram), and `isDrawing` / `isDiagram` / `isBoard` /
  `canRenameWithoutConversion` are derived from it. No surface may re-test an extension by hand.
  `.drawio` is the only diagram extension (🔒 YAZ-1802 D3): `x.drawio.svg` / `x.drawio.png` are
  pictures with a diagram inside, files of no kind.
- 🔒 YAZ-1802 D2: `isDrawing` means EXCALIDRAW only — every door that reads or writes scene JSON
  (`drawing:*`, the create's JSON stamp, board merge, history, previews, shrink, the orphan sweep,
  storage, the Import / Export Drawing dialogs) keeps asking it. The GENERIC surfaces (tree row
  kind, the file head's dates, Info, search, hover preview, the files a launch is handed, link
  routing, `Editor`) ask `isBoard` / `fileKind`, and so do Version history and the menu bar's
  Export Image… (🔒 YAZ-1802 D9 / D10); Share and Share Link ask `isBoard` too (🔒 YAZ-1802 D11).
- A rename never converts between the two kinds, in the sidebar (`renamedPath` re-appends the old
  suffix) and in main (`fs:rename` → `UNSUPPORTED_EXTENSION`). A copy keeps its extension as
  spelled: `Flow copy.drawio`, `UP copy.DRAWIO`.
- A file of no kind still LISTS in the tree (YAZ-1577) and opens in the OS default app; it is
  never read or written through the bridge (`UNSUPPORTED_EXTENSION`).
- `.excalidraw` and `.drawio` hide their extension wherever a name is shown — tree rows, tab
  labels, the window title, the rename field (⚡ YAZ-1775 D8 amended, 🔒 YAZ-1802 D13). Every other
  file shows its full name.
- 🔒 YAZ-1802 D15: so a draw.io diagram wears a type mark — a muted linked-boxes glyph (`DiagramBadge`,
  aria-label "draw.io diagram"), never draw.io's logo — in its tree row's chevron slot (every other
  file row keeps that 14 px slot empty, so names line up with folders and lose no width) and before
  its tab label. An Excalidraw board is unmarked: the usual kind.
- Image bytes do NOT live in the scene JSON: they are content-addressed at
  `<vault>/assets/<fileId>.<ext>` (🔒 YAZ-1775 D3) and travel with the scene through
  `drawing:load` / `drawing:save`. The id is Excalidraw's own — the SHA-1 of the bytes — so an
  asset is immutable, rename-proof and shared by every board that uses the picture. The scene is
  always written with `files: {}`; a legacy file that still embeds its images is extracted on its
  first save. Until then `drawing:load` answers its scene with the embedded map emptied and the
  bytes in `files` alone, so they cross the bridge once (🔒 YAZ-2073 D7); opening writes nothing. `assets/` is hidden from the sidebar tree (the TOP-LEVEL one only: a folder the
  user called `assets` inside a subfolder is theirs and shows).
- There is ONE door that makes a board, and it is the sidebar's context menu: the Create group is
  **New Excalidraw drawing**, **New dated Excalidraw drawing** (🔒 YAZ-1999 D3), **New draw.io
  diagram** (🔒 YAZ-1802 D13), New folder, New dated folder, in that order, on a row or on blank
  space. Nowhere else in the app creates a file.
  - Every board is born NAME-FIRST (🔒 YAZ-1999 D1, D5 — this replaced 🔒 YAZ-1775 R1's `Untitled`
    birth): the item opens the tree's inline name box in the right-clicked FOLDER (a file row means
    its parent, blank space means the vault root), exactly like New folder. Nothing touches the
    disk until Enter; Escape or clicking away leaves nothing behind; Enter on an empty box does
    nothing. The box's kind — `drawing`, `diagram` or `dir` (D6) — picks the extension (added
    unless the typed name already carries it), the placeholder and the empty content.
  - "New dated Excalidraw drawing" is the same box seeded with today's `MM_DD- ` (`datedSeed`,
    local date, no year — the YAZ-1604 seed "New dated folder" uses), caret at the end; Enter on
    the untouched seed does nothing. The seed is ordinary text: delete it and the name is plain.
  - Enter writes the board with its empty content in the same `wx` write (content-at-create): the
    `EMPTY_SCENE` for a drawing, `EMPTY_DIAGRAM_XML` for a diagram (one page; page view, grid and
    alignment guides off — 🔒 YAZ-1802 D12a), stamped with both dates (D7). A name already taken is
    refused, never overwritten: the error shows under the box and the typed text stays.
  - The new board then opens in the CURRENT tab.
- A `.excalidraw` has ONE door per direction (🔒 YAZ-1810): `drawing:load` and `drawing:save`, and
  no other channel reads or writes a scene — a second writer with different rules about the
  scene's images is a race with no upside. `fs:create-file` is the one exception and only for
  BIRTH: a new drawing is written with the empty scene, under `wx`.
- Every board main writes starts with its own dates — `{ "yaseendraw": { "createdAt", "updatedAt" } }`
  as the FIRST key (🔒 YAZ-1834, "Board metadata" below). Set by main in those two doors, read by
  `fs:tree` off the file head, never touched by the renderer.
- `client/src/Editor.tsx` dispatches on the kind: "Select a file from the sidebar." with no file,
  "Unsupported file type." for a `null` kind, `DrawingEditor` for a drawing and `DrawioEditor` for a
  diagram ("draw.io diagrams" below).

## Bridge API

The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`).
Its ONLY door to the machine is `window.yaseenDraw`, defined by `desktop/src/preload/index.ts`
over the channels in `desktop/src/channels.ts`, typed by `YaseenDrawApi` in `shared/types/`.
Every `ipcMain.handle` answers with an `Envelope<T>`: `{ ok: true, value }` or
`{ ok: false, error }` carrying a structured `BridgeError` (`code`, `message`, optional `path` /
`mtime`), which the preload rethrows. Electron flattens a thrown Error to its message, which is
why failure travels as data. `client/src/api.ts` re-wraps it as a `BridgeRequestError` for the
calls that go through it; `state`, `window`, `menu`, `link` and `watch` are called straight off
`window.yaseenDraw` and reject with the plain object. The codes are `BridgeErrorCode`
(`shared/types/errors.ts`); sharing added `NOT_SET_UP` (Settings › Sharing has not been set up).

| `window.yaseenDraw` | Channel | What it does |
|---|---|---|
| `tree(root)` | `fs:tree` | the folder tree; dot-entries and `node_modules` are invisible; a board carries `meta` (its dates) when its head has a trustworthy block or `<mxfile>` attributes (🔒 YAZ-1834 D6, 🔒 YAZ-1802 D7) |
| `createDir(path)` | `fs:create-dir` | never overwrites (`ALREADY_EXISTS`) |
| `createFile(req)` | `fs:create-file` | `.excalidraw` or `.drawio` only; `{ path, content }`, content-at-create under `wx`; a drawing's content must be a JSON object, a diagram's a whole `<mxfile>` (else `BAD_REQUEST`), and either is born stamped with `createdAt = updatedAt = now` (🔒 YAZ-1834 D3, 🔒 YAZ-1802 D7) |
| `drawing.load(req)` | `drawing:load` | one `.excalidraw` AS A DOCUMENT: its bytes, its mtime, and the images it names; with `imageMaxPx` (a picture of it, never an editor) the images come back preview-sized (🔒 YAZ-2073 D6) |
| `drawing.save(req)` | `drawing:save` | images first, then the scene, atomically; `expectedMtime` → `CONFLICT` with NOTHING written; the scene lands with its `yaseendraw` block first, `createdAt` carried from the file, `updatedAt` = now (🔒 YAZ-1834 D3) |
| `diagram.load(req)` / `diagram.save(req)` | `diagram:load` / `diagram:save` | 🔒 YAZ-1802 D6: one `.drawio` AS A DOCUMENT — `{ root, path }` → `{ path, xml, mtime, size }`; a file that is empty, not XML, not draw.io or cut short is `IO_ERROR` with the reason. `{ root, path, xml, expectedMtime }` → `{ path, mtime, size }`, atomic, `CONFLICT` with NOTHING written, `yaseendraw-created` / `-updated` stamped on the root `<mxfile>` (D7); any other extension is `UNSUPPORTED_EXTENSION` |
| `drawing.libraryFolder()` | `drawing:library-folder` | the RESOLVED library folder — the setting, or `<userData>/library` (🔒 YAZ-1775 D5) |
| `pickFolder()` | `dialog:pick-folder` | the native open-directory dialog |
| `dialog.openDrawing()` | `dialog:open-file` | the native OPEN-FILE dialog, `.excalidraw` filter → `{ path, name, content }` or `{ cancelled: true }`; the bytes come back because the picked file is outside the vault |
| `dialog.saveDrawing(req)` | `dialog:save-file` | the native SAVE sheet AND the atomic write behind it → `{ path }` or `{ cancelled: true }`; the only path ever written is the one the user just typed |
| `dialog.saveImage(req)` | `dialog:save-image` | the same one door for a draw.io diagram's Export Image… (🔒 YAZ-1802 D9): `{ defaultName, png, svg }` (both data URLs, both drawn before the sheet opens); a PNG / SVG sheet, and the picked name's extension decides which is written — any other is `UNSUPPORTED_EXTENSION` |
| `watch(root, cb)` | `watch:*` | one recursive watcher under the root (`fs/treeWatcher.ts`, YAZ-2073 5F); `ready` / `change` / `add` / `unlink` / `addDir` / `unlinkDir` / `error` |
| `file.rename(req)` | `fs:rename` | same-parent rename or a move; never overwrites |
| `file.delete(req)` | `fs:delete` | `shell.trashItem` ONLY — never `fs.rm`, no permanent fallback |
| `file.clip` / `paste` / `clipState` | `fs:clip*`, `fs:paste` | main owns the ONE app-wide file clipboard |
| `file.onRenamed` / `onDeleted` / `onClipChanged` | `file:*`, `clip:changed` | pushes to EVERY window |
| `shell.reveal` / `openVsCode` / `openDefault` | `shell:*` | OS hand-offs |
| `state.get` / `setSettings` / `setSidebarWidth` / `pushRecent` / `removeRecent` / `setFolder` | `state:*` | the app state file; `setFolder(root, patch: FolderPatch)` merges `expanded` / `lastFile` / `sortOrder` / `name`, each type-checked at the IPC boundary, `name` cleaned main-side by `cleanVaultName` |
| `state.onChange` | `state:changed` | a change in any window replaces the cache in all of them |
| `window.identity` / `setIdentity` | `window:*` | THIS window's `WindowEntry`, by the `?win=<id>` in its URL |
| `window.open` / `openRecent` / `closeSelf` | `window:*` | window lifecycle |
| `window.onFlush` | `app:flush` / `app:flushed` | the close/quit handshake (main waits, 5s cap) |
| `menu.on*` | `menu:*` | Open Folder…, Open Recent, Search Vault, Switch Vault…, Settings…, Toggle Sidebar, Close Tab, Next/Previous Tab, Export Image…, Export Excalidraw Drawing…, Canvas Background, Share Link (`menu.onShareLink`) |
| `link.onOpenFile` / `onNotice` | `link:*` | a routed `yaseendraw://` link |
| `favorites.get` / `set` / `onChanged` | `favorites:*` | `<vault>/.yaseendraw/favorites.json` |
| `media.favorites(req)` | `media:favorites` | `{ op: 'list' }` · `{ op: 'add', item }` · `{ op: 'remove', itemKey }` over `<library>/media.json` (🔒 YAZ-1775 D5); every verb answers the resulting list |
| `media.recent(req)` | `media:recent` | `{ op: 'list' }` · `{ op: 'record', item }` — the MRU, `RECENT_LIMIT` 60 |
| `media.onChanged` | `media:changed` | pushed to EVERY window when `media.json` changes — any vault, any writer, no payload |
| `media.search(req)` | `media:search` | `{ q, source: 'all' \| 'iconify' \| 'pixabay', cursor? }` → `{ items, nextCursor, pixabayAvailable, warnings }` (🔒 YAZ-1775 D4) |
| `media.preview(req)` | `media:preview` | `{ provider: 'pixabay' \| 'iconify', id }` → `{ mimeType, dataURL }`, from the 24 h disk cache when it is there |
| `media.import(req)` | `media:import` | the same request → `{ mimeType, dataURL, item }`; NEVER cached, capped at `MAX_IMPORT_BYTES` 20 MB |
| `components.list()` | `components:list` | the saved-component index over `<library>/components/` (🔒 YAZ-1775 D5), reconciled against the folder on every read — a fragment the index does not know is adopted, a row whose file went drops out, and a missing or corrupt index is rebuilt |
| `components.save(req)` | `components:save` | `{ name, fragmentJson, previewPng }` → the `ComponentItem` it made; writes `<slug>.excalidraw` + `<slug>.png` |
| `components.read(req)` | `components:read` | `{ slug }` → `{ fragmentJson }` — the bytes an insert needs |
| `components.rename(req)` | `components:rename` | `{ slug, name }` → the row; the LABEL only, both files keep their names |
| `components.delete(req)` | `components:delete` | `{ slug }`; both files to the OS trash (`shell.trashItem`) and the row out of the index |
| `components.preview(req)` | `components:preview` | `{ slug }` → the stored PNG as a dataURL |
| `components.onChanged` | `components:changed` | pushed to EVERY window when the components library changes — any vault, any writer, no payload |
| `secrets.set(req)` / `has(req)` | `secrets:set` / `secrets:has` | `{ name, value \| null }` writes or clears a secret — `pixabayApiKey` only, any other name is `BAD_REQUEST`; `{ name }` → boolean. NO channel answers a value (🔒 YAZ-1775 D4, YAZ-1842 D1) |
| `github.status` / `syncNow` / `setEnabled` / `onStatus` | `github:*` | per-vault GitHub sync; a pass that merged carries `merged` (below) |
| `github.history` / `version` / `restore` | `github:history` / `github:version` / `github:restore` | Version history (YAZ-1897 D4): `(root, path)` → a board's versions newest first; `(root, path, ref)` → one version's `{ kind: 'drawing', json, files }` (pictures from `assets/`, as `drawing:load`) or `{ kind: 'diagram', xml }` (🔒 YAZ-1802 D10, a version that is no diagram is `IO_ERROR`); a diagram restores through `diagram:save`'s write; `(root, path, ref)` writes it over the board. `ref` is opaque (`<sha>:<path>`), anything else is `BAD_REQUEST` |
| `share.status` / `accounts` / `setup` / `onSetupProgress` / `openCloudflare` | `share:status` / `share:accounts` / `share:setup` / `share:setup-progress` / `share:open-cloudflare` | Share links (YAZ-1799, below): the setup status (no secret), the accounts a pasted key sees, set up from `{ token, accountId? }` with progress pushed to the asking window, and the pre-filled token page in the browser |
| `share.get` / `list` / `publish` / `setPermission` / `stop` | `share:get` / `share:list` / `share:publish` / `share:set-permission` / `share:stop` | one board's record; the vault's records (`{ root, check? }` — `check: false` skips the live check); share or re-upload `{ root, path, content, id? }`; flip the download flag on the same link; stop. `NOT_SET_UP` before setup, `TOO_LARGE` over 100 MB |
| `share.setDomain` / `disconnect` / `onChanged` | `share:set-domain` / `share:disconnect` / `share:changed` | attach or remove the custom domain; forget the key (or delete everything first); any status or shares.json change, pushed to EVERY window |
| `storage.stats(root)` / `storage.shrink(root, skip)` | `storage:stats` / `storage:shrink` | Settings › Storage (YAZ-1801): the vault's sizes from the disk and the LOCAL git (never the network), measured on a worker thread (D8), and "Move pictures out of boards" (on the same worker, 🔒 D11) — every legacy board rewritten lean, pictures into `assets/`, its `yaseendraw` block kept verbatim (`updatedAt` does not move); `skip` = absolute paths with unsaved edits in a tab → `{ shrunk, skipped, bytesMoved }` |

Rules that hold across the whole surface:

- **Main owns the disk and the state file.** The renderer never touches either directly.
- **Never overwrite.** Create and rename use `wx` / exclusive semantics; a collision is
  `ALREADY_EXISTS`, not a silent clobber.
- **Atomic, durable writes.** Every write is tmp-file + fsync + rename, and a new asset is fsynced
  before the scene naming it lands, so neither a crash nor a power loss can truncate a drawing
  (YAZ-2073 D12).
- **Echo suppression by mtime.** A write's own watcher event is recognised by the mtime the write
  returned and ignored; a genuine external change while the buffer is dirty raises the conflict bar.
- **One watcher engine** (`fs/treeWatcher.ts`, 🔒 YAZ-2073 D9) under the vault, `.yaseendraw/` and
  library watches: one recursive `fs.watch` per folder (no fd per file), each path looked at once it
  has been quiet 100 ms (`SETTLE_MS`) and classified by `lstat` against what it knew, `ready` after
  one walk of what is there, the app's own `atomicWrite` tmp files never announced. A folder that
  does not exist yet is waited for. On a macOS network volume (no `local` in `mount`), or where
  `fs.watch` throws, chokidar polling (1 s) runs instead, loaded only then. What consumers see is
  pinned by `watchConformance.test.ts`, which passed against chokidar before the switch.
- **One door per direction, per kind.** Where a kind has a dedicated pair (`drawing:load` /
  `drawing:save`), nothing else may read or write those bytes. A save is an ORDER as well as a
  write: the images the scene names land before the scene that names them, and the dates ride
  the same atomic write (🔒 YAZ-1834 D3).
- **One read ceiling, per document.** `MAX_DRAWING_BYTES` (200 MiB, `shared/types/errors.ts`)
  bounds every whole-file read of a board — `drawing:load`, `dialog:open-file`, and the save's
  own size check — because they all have to open legacy scenes that still embed their images as
  base64. There is no separate text-read ceiling any more (the markdown layer that had one went
  in YAZ-1808); `fs:tree` reads only a board's first KB (`BOARD_META_HEAD_BYTES`).
- **Assets are immutable and append-only.** A save lands an asset on a tmp sibling, fsyncs it, then
  `link`s it to its content-addressed name (a volume without hard links renames), so a torn write
  never sits under a valid name; EEXIST is success (YAZ-2073 2B1). Nothing but the orphan sweep
  ever removes one.
- **The renderer never reaches a provider** (🔒 YAZ-1775 D4). Iconify and Pixabay are fetched by MAIN, which
  holds the key, does the curation, keeps the cache and enforces the import cap. The renderer's
  whole knowledge of the key is the boolean `pixabayAvailable`.
- **A secret never crosses the bridge outward** (🔒 YAZ-1775 D4). The renderer may `set` one and ask `has`;
  there is no channel, no state field and no push that carries a value, so a key cannot reach a
  devtools console, a `state:get` answer or a renderer crash dump. Main reads it itself.

### The orphan sweep (🔒 YAZ-1775 D3)

The first `fs:tree` for a root in a session — the moment a vault is "opened" — also runs one
sweep of `<vault>/assets/`, detached, so the tree answers immediately. A file goes to the OS
trash (`shell.trashItem`, never `fs.rm`) only when BOTH hold: no `.excalidraw` anywhere under the
root references its id, and it is older than 24 h (`ORPHAN_MAX_AGE_MS`). The age guard is what
makes this safe with editors open — an image pasted a minute ago is already in `assets/` while
the board naming it has not saved yet. The scan reads every board fresh, nested folders included,
skips dot-dirs, `node_modules` and the store itself, and tolerates a corrupt or unreadable file
by skipping it. When it trashed something the asking window shows "Cleaned N unused images"
through the existing passive notice; when it did not, it says nothing.
- **No path jail** (out of scope, below): anything under the user's account is reachable.

## App state schema

ONE user-global JSON file, owned by the main process:
`~/Library/Application Support/Yaseen Draw/yaseendraw.json`
(`YASEEN_DRAW_USER_DATA_DIR` overrides the directory — that is how an isolated profile is made).
Nothing is ever stored in the browser profile. `desktop/src/main/store.ts` loads it field by field:
anything unrecognised or malformed falls back to its default rather than failing the launch.

```ts
AppState {
  version: 1
  settings: {
    theme: 'system' | 'light' | 'dark'
    libraryFolder: string | null         // 🔒 YAZ-1775 D5, null = `<userData>/library`
    confirmDelete: boolean
    canvas: CanvasPrefs                  // 🔒 YAZ-1775 D9, below
    canvasPanel: { tab: 'image-studio' | 'components' | 'presentation'; docked: boolean }
    diagramDarkColors: 'adapt' | 'keep'  // 🔒 YAZ-1802 D16, default 'adapt'
  }
  sidebarWidth: number                     // clamped to [180, 520]
  recents: { path: string; lastOpened: number }[]   // MRU, max 10
  windows: WindowEntry[]
  folders: Record<string /* vault root */, FolderState>
}

WindowEntry {
  id: string
  root: string | null                      // null = the Welcome screen
  file: string | null                      // doubles as the ACTIVE tab
  tabs: string[]                           // absolute, de-duplicated, left→right
  sidebarCollapsed: boolean
  sidebarLens: 'files' | 'favorites'       // ⚡ YAZ-1775 D8 amended; an unknown value reads as 'files'
  focusDirs: string[]                      // Focus Mode, Files lens
  focusFavorites: string[]                 // Focus Mode, Favorites lens
  bounds: { x, y, width, height }
}

FolderState {
  expanded: string[]                       // SESSION only: never written to disk (YAZ-1642)
  lastFile: string | null
  sortOrder: 'name' | 'updated' | 'created'   // the Files lens's order for this vault (🔒 YAZ-1835 D3); persisted, default 'name'
  name: string | null                      // the vault's DISPLAY NAME (Docs YAZ-1974 D3); null = its folder name
}
```

`FolderState.name` (YAZ-2056, a port of Docs YAZ-1974 D3) is persisted, per machine — never in the
vault's `.yaseendraw/`, which would push a personal label into a shared repo. `cleanVaultName` trims it
and caps it at `MAX_VAULT_NAME` (80) code points on load and on every patch; empty or not a string
is `null`, and a name equal to the folder's basename is stored as `null` (`storage.setVaultName`). It
survives Remove from recent vaults (recents never prune `folders`), follows the vault through
`renamePath`, and goes with it in `removePath`; a Finder rename outside the app drops it, like recents.

`SettingsState.canvas` is `CanvasPrefs` (`shared/types/`, mapped by `shared/canvasPrefs.ts`) —
the fourteen user-level canvas preferences 🔒 YAZ-1775 D9 took out of the engine's browser localStorage:

```ts
CanvasPrefs {
  gridModeEnabled: boolean          // false
  objectsSnapModeEnabled: boolean   // false
  snapToMidpoints: boolean          // true   (engine `isMidpointSnappingEnabled`)
  arrowBinding: boolean             // true   (engine `isBindingEnabled`)
  selectOn: 'wrap' | 'overlap'      // 'wrap' (engine `boxSelectionMode` contain/overlap)
  toolLock: boolean                 // false  (engine `activeTool.locked`)
  zenModeEnabled: boolean           // false
  writingMode: boolean              // false
  writingStrokeWidth: number        // 0.5    (engine `currentItemWritingStrokeWidth`)
  vectorStrokeWidth: number         // 2      (engine `currentItemVectorStrokeWidth`)
  framesVisible: boolean            // true   (engine `updateFrameRendering`, never appState)
  defaultFontFamily: number         // 10 Assistant (engine `currentItemFontFamily`)
  defaultRoughness: 0 | 1 | 2       // 0 architect  (engine `currentItemRoughness`)
  defaultTextAlign: 'left'|'center'|'right'  // 'center' (engine `currentItemTextAlign`)
}
```

Every default is the engine's own (`packages/excalidraw/appState.ts`, `packages/common/src/constants.ts`).
They are seeded into `initialData.appState` at mount and kept in step both ways, each direction
comparing against one "what the engine holds" ref before writing, so two windows can never
ping-pong; the engine's own read-back is 300 ms debounced. The guard is STRICT at the IPC boundary
(a renderer hands over a whole `CanvasPrefs` or nothing) and LENIENT on load (field by field over
the defaults, so a state file written before a key existed keeps every key it does have). Per BOARD
there is only what the engine writes into the file itself — `viewBackgroundColor`, `gridSize`,
`gridStep`. The VIEW is never kept, per board or anywhere (🔒 YAZ-1855 D2/D3): the engine exports
no zoom or scroll, and every fresh mount opens fitted to the board's live elements (🔒 YAZ-1855 D1 —
`initialState.viewport` with `fit: 'scale-down'`: never past 100%, floored at the engine's 10%; an
empty board stays at 100%). A tab already mounted keeps its live zoom; a reload from disk keeps it too. None of the web app's localStorage keys are carried over; the one engine key this app
touches is `excalidraw.desktopUIMode`, WRITTEN before every mount and never read (⚡ YAZ-1775 R4/R5).

Invariants: `file ∈ tabs` whenever `file` is non-null, and `tabs: []` ⇔ `file: null`.
`sidebarCollapsed`, `sidebarLens` and both focus lists are WINDOW identity — a duplicate inherits
them by value and then diverges; a global `state:changed` broadcast never moves another window's.
A new window opens on `DEFAULT_SIDEBAR_LENS` (Files), and so does a switch to a DIFFERENT vault:
`storage.setRoot`'s one identity write clears the file, tabs and focus lists and resets the lens,
while re-setting the same vault keeps them all (YAZ-2056 D1, a port of Docs YAZ-1846 D2).
Settings and `sidebarWidth` are global and every window follows a change live.

`SettingsState.libraryFolder` (🔒 YAZ-1775 D5) is the ONE folder every vault shares, where media favorites
and saved components live (YAZ-1817 / YAZ-1818 filled it; YAZ-1819 adds `components/`): an absolute path the user picked, or null
for `<userData>/library`. Only main can resolve null, so Settings asks through
`drawing:library-folder`; main also `mkdir -p`s the folder at startup, so the row always names a
directory that exists. A folder that cannot be created is still the answer — a launch must not
fail because a picked path has gone read-only.

### The Library folder (🔒 YAZ-1775 D5)

```
<library>/
  media.json                      the media library — YAZ-1817 (YAZ-1817)
  components.json                 the saved-component index — YAZ-1819 (YAZ-1819)
  components/
    <slug>.excalidraw             one component: a whole Excalidraw document, images EMBEDDED
    <slug>.png                    its preview, bounded at 800 × 600
```

`media.json` is `{ version: 1, favorites: StoredMediaItem[], recent: StoredMediaItem[] }`, both
lists newest-first, de-duplicated by `itemKey`, and capped on the tail — `favorites` at 500
(`MAX_MEDIA_FAVORITES`), `recent` at `RECENT_LIMIT` 60 as an MRU. A `StoredMediaItem` is the web
app's (`convex/mediaTypes.ts`, field for field, so a library written by either app reads in the
other): `itemKey` (the identity), `provider` (`pixabay` | `iconify` | `shape`), `providerId`,
`kind`, `title`, the optional attribution and layout fields (`previewUrl`, `creator`,
`creatorUrl`, `collectionName`, `sourceUrl`, `licenseName`, `licenseUrl`, `attribution`, `width`,
`height`, `trademarkNotice`), and `updatedAt`, which MAIN stamps on every write — a renderer's own
is dropped. `previewUrl` is stored but NEVER trusted: a CDN URL expires, and the Images tab
re-derives every preview from `provider` + `providerId` over `media:preview`. Pointers only — the BYTES never live in the library (they
go through `media:import` into the vault's `assets/`).

The rules are pure (`shared/mediaLibrary.ts`); the disk half (`desktop/src/main/library/mediaStore.ts`)
follows the app's file idioms: a read never creates the file, a mutation that changes nothing does
not write, writes are tmp + rename and serialised, a file that is not a version-1 library is moved
aside as `media.json.corrupt-<epoch>`, and a bad ROW in a good file is dropped rather than costing
the rest. ONE watcher watches the library folder (depth 0, `media.json` only), re-pointed when
`settings.libraryFolder` changes; an own write notifies every window synchronously and its echo is
dropped by mtime, an external write (the other machine, through a synced vault) notifies as usual.
`media:changed` carries no payload because every window re-lists regardless of its vault — that is
the cross-vault promise.

### The Image Studio's providers (🔒 YAZ-1775 D4)

The canvas panel's **Images** tab is the web app's Image Studio, and everything behind it is the
main process. `worker/imageStudio.ts` — the Cloudflare Worker that used to serve
`draw.yaseenarshad.com` — was PORTED, not simplified, into `desktop/src/main/media/`:

| Module | What it is |
|---|---|
| `curation.ts` | the pure rules: normalisation, ranking, the interleave, the opaque cursor, every constant |
| `cachePolicy.ts` | the pure cache policy: key scheme, 24 h, the sweep plan |
| `cache.ts` | the disk half of the cache; never throws at a caller |
| `providers.ts` | the fetching: the Iconify walk, the Pixabay pages, the refill, the image proxy |

The numbers are the Worker's own and are locked: `SEARCH_LIMIT` 18, `ICONIFY_ALL_RESULT_LIMIT` 14
and `PIXABAY_ALL_RESULT_LIMIT` 4 in `all`, `ICONIFY_COLOR_BATCH_LIMIT` 6, `PIXABAY_PAGE_SIZE` 4,
`SEARCH_CACHE_VERSION` `'2'`, `MAX_IMPORT_BYTES` 20 MB, `COLOR_COLLECTION_PRIORITY` and
`LOW_PRIORITY_COLLECTIONS` verbatim. Iconify is searched twice — a colour-collection batch, then a
general pass with those collections filtered OUT — and the page is three icons to one graphic.
Pixabay serves `vector` and `illustration` only, alternating, de-duplicated by the cursor's
`seenIds`. The cursor is opaque base64url and carries the query and the source: one minted for
another search is `BAD_REQUEST`, never a silent restart.

- **No key, no provider.** `secrets.read('pixabayApiKey')` is main's alone. With no key Pixabay is
  SKIPPED — not warned about, not shown failing — and the answer says `pixabayAvailable: false`,
  which is the only thing the renderer ever learns about it.
- **One provider failing is not the request failing.** In `all`, a dead Pixabay still answers with
  the icons plus a `warnings` line, and its half of the cursor is untouched so the next page
  retries it from where it was. Only when EVERY requested provider failed does the call reject.
- **Failure is typed.** A `fetch` that threw is `OFFLINE` (the machine never reached the provider);
  a provider that answered and refused is `PROVIDER_FAILED`; a non-image is `UNSUPPORTED_TYPE`;
  past 20 MB is `TOO_LARGE`, checked on `Content-Length` AND on the bytes that actually arrived.
- **Previews travel as dataURLs.** No custom protocol, no renderer fetch. A stored `previewUrl` is
  never read: every tile asks `media:preview` by `provider` + `providerId`.
- **An import is not cached and does not touch the disk here.** Its bytes go to the engine's
  `insertImages`, and the SAVE path (🔒 YAZ-1775 D3, YAZ-1811) writes them into `<vault>/assets/` before the scene
  names them.

```
<userData>/media-cache/
  <sha256 of the cache key>.json     search answers, Pixabay pages and records, previews
```

One flat folder of JSON, named by the hash of the Worker's own key strings (`search?_iscv=2&q=…`,
`pixabay/search/<q>/<type>/<page>/<perPage>`, `pixabay/item/<id>`, `image/<provider>/<id>/preview`);
the search key also carries whether a key was set, so adding one never keeps serving yesterday's
Iconify-only page. Freshness is the FILE's mtime, so the 24 h read guard and the startup sweep are
one rule. The sweep runs once at registration, detached, and removes only `*.json` past 24 h —
which is exactly what a read would have refused. Imports are never written here. A cache that
cannot read or write is a miss, never an error.

The renderer half is `client/src/image-studio/`: `ImageStudio.tsx` (Search / Shapes / Favorites / Recent),
`shapes.ts` (7 basic shapes plus the engine's 12 Smart Shapes as NATIVE elements — the smart half
needs `@excalidraw/element`, which arrives on its own lazy promise so the basics render at once),
`insertShape.ts` (both insert paths, and `IMAGE_STUDIO_INSERTION` = 320 px capped at 55 % of the
viewport) and `imageStudio.css`. ⌘F opens the tab AND focuses its search field; offline, Search
shows a passive line while Shapes, Favorites and Recent keep working — previews from the cache
where main still has them, a placeholder where it does not.

### Saved components (🔒 YAZ-1775 D5)

The canvas panel's **Components** tab is the web app's Saved Components, and the library is a
folder rather than a Convex table. One component is TWO files named after its slug —
`<library>/components/<slug>.excalidraw` and `<slug>.png` — plus a row in
`<library>/components.json`, which is `{ version: 1, items: ComponentItem[] }` with
`ComponentItem = { slug, name, elementCount, createdAt, updatedAt }`, newest-updated first.

**The fragment embeds its images**, which is the one place this app deliberately does not follow
🔒 YAZ-1775 D3: it is a whole `{ type: 'excalidraw', version: 2, source, elements, appState: {}, files }`
document whose `files` map carries the component's bytes as dataURLs. A component is small and has
to insert into ANY vault on ANY machine, so it cannot point at a `<vault>/assets/` file. On insert
those bytes are handed to the canvas as files; the board's next save extracts them into THIS
vault's `assets/` through YAZ-1811, deduped by `fileId`.

**The slug is the identity, the name is only the label.** The slug is the kebab of the name, uniqued
with `-2`, `-3` (Finder's counting, never `-1`), capped at 60 characters, and validated as a path
segment — lowercase words joined by single hyphens and nothing else, so a slug out of a hand-edited
index can never name a file outside the folder. A rename therefore moves no file.

**The folder is the truth; the index is a cache.** Every read reconciles them: a fragment the index
does not know is adopted (named after its own slug, counted by reading it once), a row whose file
has gone drops out, an unreadable fragment is skipped rather than offered as a tile that cannot be
inserted, and an index that is missing or is not a version-1 index is rebuilt from the folder — the
bad one moved aside as `components.json.corrupt-<epoch>`. A READ NEVER WRITES: the reconciliation is
in memory and only a mutation puts it on disk, so listing costs a read-only disk nothing and does
not churn a synced folder. One watcher watches the library folder at depth 1 (the index, and the
two files a component is — an `atomicWrite` tmp file is silence), own writes are echo-suppressed by
path + mtime, and `components:changed` carries no payload because every window re-lists regardless
of its vault. A delete is `shell.trashItem`, never `fs.rm`, and a trash that fails leaves the row.

The rules are pure (`shared/savedComponents.ts`); the disk half is
`desktop/src/main/library/componentStore.ts`, guarded by `desktop/src/main/ipc/components.ts`.

The renderer half is `client/src/components-library/`: `componentData.ts` (the web app's
`SavedComponentsData.ts` — the capture with its four assertions, the fragment, and the insert),
`client/src/lib/scenePreview.ts` (`SavedComponentPreview.ts`, PNG instead of WebP so every reader can open the
file; since YAZ-1800 the ONE scene renderer, shared with the sidebar's hover preview), `SavedComponents.tsx` and `savedComponents.css`. **Insert makes an independent copy**: the
elements go through the engine's own `insertElements`, which duplicates ids and centres on the
viewport, so two inserts of one component are two unrelated sets of elements. Search is the app's
ONE ranking matcher (`search/matchCandidates.ts`, the same one ⌘K uses) over the names, paged by
`PAGE_SIZE` 24, grown by a sentinel at the end of the grid — the Images tab's gesture, so one panel
does not have two. Rename and delete are inline in the card rather than `window.prompt` /
`window.confirm`, and 🔒 `confirmDelete` (Settings › Files) decides whether the delete asks first.
A rename shows the name the STORE answered with, never an optimistic one: a refusal leaves the old
name on the card beside the reason.

**Import JSON** (YAZ-1833) is the same library through a different door: the button opens the
native open-file dialog (`dialog:open-file`, `.excalidraw` filter), `componentImport.ts` parses
what comes back — the web app's `parseImportedComponentJson` envelope table
(`growprofit/saved-component` with its schema-version and element-count checks, `excalidraw`,
`excalidraw/clipboard`, `excalidraw-api/clipboard`, and a ONE-item `excalidrawlib`), then
`restoreElements(…, { repairBindings: true })`, the soft-deleted filter, a second assertion pass
and the 750 000-byte element ceiling — and the result goes through `components:save` exactly as a
captured selection does. Two differences from the web app, both deliberate: it is a FILE PICKER
rather than a paste box (a desktop app has a dialog; a browser tab did not), and IMAGES ARE KEPT,
because the picked file carries its own `files` map, so importing a legacy embedded board yields a
component with its pictures. An image id with no bytes behind it in that file is a refusal. The
component is named after the file's base name and its preview is drawn from the fragment and
bounded like every other, so importing a board-sized scene is allowed and still yields a tile.
Every refusal throws BEFORE `components:save` is called and shows as a PASSIVE notice
(`role="status"`, not the assertive error line) — nothing is written.

### Presenting (YAZ-1820)

The canvas panel's **Present** tab is the web app's `PresentationSidebar`, and ▶ Start
presentation mounts its `PresentationPlayer` over the canvas pane. The whole of it is
`client/src/drawings/presentation/`: `slides.ts` (the rules), `camera.ts` (the offsets),
`PresentationSidebar.tsx`, `PresentationPlayer.tsx`, `presentationIcons.tsx`, `presentation.css`.

**A slide is a top-level frame, and the deck's order lives in the FILE.** The position is
`frame.customData.presentationOrder`, with `customData.yaseenPresentation.presentationOrder` read
as a fallback so a deck generated against the in-package contract
(`packages/excalidraw/presentation/CONTRACT.md`) and a deck a human dragged into shape are the
same deck. Nothing about a presentation is in `SettingsState` or in any store: a board carries its
own deck. A frame nested in another frame is a shape in a slide, not a slide; a deleted one is not
a slide either.

**The order is a request, not a guarantee.** A file is user data, so a claim is honoured only when
it is in range AND is the only claim for its slot; everything else fills the gaps in scene order.
The answer is therefore always exactly the top-level frames, numbered 1..n with no holes. A
reorder — drag the handle, or Alt+↑ / Alt+↓ — writes the new numbers back through `updateScene`
with `CaptureUpdateAction.IMMEDIATELY`, so it is one undo step and it lands in the file on the next
autosave. A reorder request is completed rather than trusted: unknown ids are dropped, duplicates
taken once, and a frame the caller forgot keeps its place at the end, so a stale list can reshuffle
the deck but can never lose a slide out of it. A rename writes the frame's own `name`.

**The player covers the PANE, not the window.** The web app portalled to `document.body`, hid the
chrome with a `body` class and measured `window.innerWidth`; this shell keeps several drawing tabs
mounted at once, each with its own engine, so the overlay is a child of `.drawing-surface`, the two
chrome classes (`--presenting`, `--presentation-tools`) go on that element, and the camera reserve
(0.32 of the width, always on) is a fraction of the pane. The keyboard and double-click handlers
are still document-wide — the canvas has the keyboard while presenting, and it is not inside the
overlay — so both stand down unless the overlay is in the visible tab layer, the same test
`boardCommand.ts` makes for the menu's canvas items.

**Keys:** → / PageDown / Space (Space only while the tools are hidden) next, ← / PageUp previous,
Home / End the ends, **Esc zooms out to the whole deck and never leaves** (restarting a deck by
accident is worse than reaching for ✕), ⇧T shows or hides the editor chrome, Tab is trapped in the
control bar while the chrome is hidden. Double-clicking the canvas presents the smallest slide
under the pointer. Presenting is free-form: the camera is never locked, the hand tool pans while
the chrome is hidden, and the tool the presenter had before is put back on exit. Frame outlines are
hidden for the duration and restored to `SettingsState.canvas.framesVisible` — never to a
hardcoded value — whether the presenter left through ✕, the deck emptied under them, or the
component was simply unmounted.

**Not ported** (locked exclusion on 🔒 YAZ-1775): hosted HTML animations and everything that served
them — `PresentationAnimationController`, `animationOrchestrator`, `animationDomAdapter`, the
CSP-sandboxed iframe assets, and the `yaseendraw:presentation-frame` lifecycle event they were the
only subscriber to. What that event DROVE is kept, because it is the camera behaving itself rather
than an animation protocol: the transition token that stops a stale landing, and the rule that an
in-flight transition must not land while the deck is zoomed out.

### Board size and GitHub's limits (YAZ-1801)

GitHub refuses any file over 100 MiB (and rejects the WHOLE push that carries one), warns over
50 MiB, and wants a repo under 1 GB (strongly under 5 GB). The constants live in
`shared/types/vault.ts`.

- **D3 — an oversize file never jams sync.** A sync pass stats the untracked and modified files
  before `git add -A` and excludes any at or over `GITHUB_FILE_LIMIT_BYTES` (95 MiB, a margin under the
  100) by literal pathspec, then re-checks the staged list and `reset`s anything that grew past it.
  Everything else commits and pushes; the pass ends `attention` / `too-large` with
  `GithubSyncStatus.tooLarge` (vault-relative paths). The banner for it has NO Dismiss and stays
  until a pass stops finding the file; the chip reads "N files not synced"; the sidebar row wears a
  red cloud-off icon. The manager carries `tooLarge` through `pending` / `syncing` and arms no retry
  for it. Out of scope: a file already COMMITTED over the limit (the push fails as `error`).
- **🔒 D12 — a held-back tracked file never blocks the rebase.** It is still modified after the
  commit, and `git rebase` refuses an unstaged change. So, only when the remote is ahead, exactly
  the held-back TRACKED files are parked (`stash push -- <paths>`), the rebase runs, and their bytes
  are copied back (`checkout stash@{0} -- <paths>`, unstaged, `stash drop`) whether it landed or
  aborted — a copy, never a merge. The pass still ends `too-large`, never a false `conflict`. The
  parked blob stays unreachable in `.git` until git's own gc, so "Git history" can read high by
  that file's size until then. This is the sync pass's only stash.
- **D4 — transfers get 10 minutes.** `fetch origin` and the ordinary `push` run with
  `TRANSFER_TIMEOUT_MS`; every local call keeps 30 s; the quit flush's push keeps 5 s.
- **D5 — one extraction.** `liftEmbedded` + `landAssets` (`desktop/src/main/fs/drawing.ts`) are
  the only code that moves embedded pictures into `assets/`; `drawing:save` and `shrinkVault`
  (`fs/shrink.ts`) both call them. Shrink differs from a save in one way only: it never stamps —
  the block rides through verbatim. It skips boards the renderer lists as dirty (THIS window's
  tabs with unsaved edits — `renameContinuity.dirtyPaths`), re-checks each board's mtime before
  writing, and counts unreadable boards as skipped. A clean tab on a rewritten board reloads through
  the ordinary watcher rule.
- **D6 — no history reset.** Settings › Storage shows "Old versions" (history minus the current
  snapshot's on-disk size) in the bar's muted line and offers no button for it.
- **D8 + 🔒 D11 — neither measuring nor shrinking freezes the window.** `storage:stats` and
  `storage:shrink` both go through `runOffThread` (`main/storageJob.ts`) to ONE `worker_threads`
  Worker (`main/storageWorker.ts`, built as its own main chunk by electron-vite's `?modulePath`
  import), told which job by a tagged message: `{ kind: 'stats', root }` | `{ kind: 'shrink', root,
  skip }`. Same functions, same answers; one short-lived thread per job. Both walk the vault with
  the one `vaultFiles` (`fs/fsUtils.ts`), so they agree on which files are the vault's. Shrink's
  mtime re-check before each write (D5) still lets a save that lands while the worker runs win.
- **🔒 D13 — measured only while Settings is open.** `useVaultStorage` measures on the Storage
  page's open, on a sync pass FINISHING (`syncing` → synced / attention / off) while Settings is
  open — App passes `settingsOpen ? syncState : null` — and after a shrink; one measure at a time,
  a trigger mid-measure queuing one re-run. A vault change clears the numbers and measures nothing.
  A failed first measure reads "Couldn't measure this vault" (not "Measuring…" forever); the next
  page open retries.
- **One red line.** The page's "Needs attention" lists every file ≥ 50 MiB (`VaultStorageStats.large`,
  any kind — board, picture, video) and turns it red at `GITHUB_FILE_LIMIT_BYTES`, the same 95 MiB the
  sync guard holds files back at, so a red row is exactly a file sync will not push.

The demo vault for this is `tools/seedStorageDemoVault.mjs`.

### Two computers, one vault (YAZ-1897)

A sync pass is still commit → fetch → rebase → push (`desktop/src/main/git/sync.ts`). What changed
is what a CONFLICT does: it is settled and the rebase finishes (`git/resolve.ts`), instead of the
whole vault stopping until a person untangles it. The decision record is the 🔒 D1–D6 comments on
YAZ-1897; the scenario catalogue (S1–S28) is the 📘 comment there.

- **D1 — boards merge shape by shape** (`shared/boardMerge.ts`): 3-way against the common ancestor.
  One side changed a shape → that side (a delete included; saved boards keep deleted shapes as
  `isDeleted` tombstones). Both changed it → an edit beats a delete, else the newest `updated` wins
  (then `version`, then the lower `versionNonce`) and it counts as a clash. A clashing shape keeps
  both sides' `boundElements`; a live shape whose box (`containerId`) or frame (`frameId`) the other
  side deleted gets that parent back. `appState` merges per key, ours winning a clash; the
  `yaseendraw` dates block stays first with the earlier `createdAt` and the later `updatedAt`.
- **D2 — git never line-merges a board.** Every pass keeps `-merge` rules for both board
  extensions in `.git/info/attributes` (this machine only, never committed, never the user's own
  `.gitattributes`), so every board both sides changed reaches D1 — or, for a diagram, keep-both
  (🔒 YAZ-1802 D8). The rules are spelled `*.[eE][xX][cC][aA][lL][iI][dD][rR][aA][wW] -merge` and
  `*.[dD][rR][aA][wW][iI][oO] -merge` (🔒 YAZ-1802 D17): git folds case in attribute patterns only
  under `core.ignorecase`, which is per repo and false for a clone made on a case-sensitive volume,
  and `resolve.ts` classifies through `fileKind`, so `B.EXCALIDRAW` merges and `B.DRAWIO` keeps both
  like their lower-case twins. A vault that still has the old `*.excalidraw -merge` line keeps it.
- **D3 — anything else keeps both.** The remote's version stays at the path and ours is written
  beside it as `<name> (conflict, YYYY-MM-DD).<ext>`. Exceptions: `.yaseendraw/shares.json` and
  `favorites.json` merge per entry (a record beats a removal; favorites keep the remote's order,
  ours appended), and any other `.yaseendraw/` file keeps ours. Two NEW boards at one path, or a
  board that will not parse, keep both. A file deleted on one side and edited on the other keeps
  the edit.
- **The lossless rule still holds.** Only what cannot be settled (a git step that fails) aborts the
  rebase, and the pass reports `attention` / `conflict` ("Sync couldn't finish merging…"). A save
  that lands while the rebase is stopped is parked by copy before any `--continue` or `--abort`
  and written back after, so the abort can no longer reset it away.
- **What a pass reports.** `GithubSyncStatus.merged` = `{ path, author, clashes, copy? }[]`, only on
  the status of the pass that merged (the manager never keeps it as `last`). Each merged commit
  carries a `Merged-with: <author>` trailer. Once a merge has landed, `refs/yaseendraw/before-merge`
  points at the pre-rebase commit (local only, replaced by the next merge).
- **D6 — the idle pull.** A vault whose last pass ended `synced` runs a quiet pass every 60 s
  (`pollMs`): no `syncing` broadcast first, no broadcast at all when nothing changed, never while
  edits are settling, `pending` or `attention`. It looks before it passes (YAZ-2073 5H):
  `remoteMoved` runs `fetch` + one `rev-list` (2 git spawns; a full pass makes 9), and only a
  remote that moved, an unpushed commit, no upstream or a failed look escalates to the full pass.
- **D4 — seeing it.** A merge puts up one notice ("Merged Sam's changes into “Roadmap” · 2 shapes
  edited on both — kept the newest.") with **See changes**; a notice with an action waits to be
  dismissed. Right-click a board › **Version history** (`client/src/history/`) lists its versions;
  the picture is the board NOW with what changed since the chosen version marked (added green,
  changed amber, removed faded red, `compare.ts`), or the version **as it was**. **Restore**
  writes it back as an ordinary edit and re-uploads a shared link. A draw.io diagram's versions
  are pictures too (🔒 YAZ-1802 D10), drawn by the D9 renderer, **as it was** only — no change
  marks in v1 — and Restore writes through `diagram:save` (checked, D7 dates stamped).
- **D5 — no per-board hold.** Every board syncs.

The demo vault for this is `tools/seedMergeDemoVault.mjs` (two computers and a bare origin; the
app's first sync on open meets every case).

### Secrets (🔒 YAZ-1775 D4, ⚡ YAZ-1842 D1)

`<userData>/secrets.json` = `{ version: 2, values: Record<name, value> }`, plain text, file mode
`0600` from the tmp file's creation on, owned by `desktop/src/main/secrets.ts`. It is NOT part of the app state file and never rides
`state:changed`; the renderer can write and ask, never read. It is plain text on purpose: version 1
encrypted values with Electron's `safeStorage`, which on macOS binds a Keychain item to the app's
code identity — and an ad-hoc-signed app (locked: no Developer ID) is a new identity on every
build, so a key saved by one release was unreadable by the next. A version-1 file is moved aside as
corrupt and the next paste starts clean. The names: `pixabayApiKey` (`PIXABAY_SECRET`), typed once
in Settings › Images and read by main when it builds a Pixabay request; and sharing's
`cloudflareApiToken` and `shareUploadPassword` (YAZ-1799), written by MAIN at share setup and
forgotten on disconnect. `secrets:set` accepts `pixabayApiKey` ONLY (`RENDERER_WRITABLE_SECRETS`), so
a renderer can never overwrite sharing's two.

Two things live in the VAULT instead, because they are the user's own data:
`<vault>/.yaseendraw/favorites.json` (YAZ-1794: vault-relative paths, so favorites travel with the
vault), `<vault>/.yaseendraw/github.json` (the per-vault sync switch) and
`<vault>/.yaseendraw/shares.json` (which boards are shared, YAZ-1799). Nothing else is ever
written into a vault except the drawings and `assets/`. A board's own dates live INSIDE the
drawing, not in the dotfolder — see "Board metadata" below.

To reset or hand-edit the state file: **quit the app first** (⌘Q flushes it), then edit or delete
the JSON. A missing file launches one empty window.

## ⌘K search

One search, over NAMES, in the sidebar's own bar (🔒 YAZ-797: a persistent bar, never a modal).
⌘K focuses it — the sidebar un-collapses first — and a typed query replaces the active lens's body
with a FLAT ranked list (🔒 the flat-list ruling on YAZ-739), never a filtered tree.

- **The catalog** (`client/src/search/searchCandidates.ts`, 🔒 YAZ-1814 on YAZ-1814) is one row per
  board — `.excalidraw` or `.drawio` (🔒 YAZ-1802 D2) — under the name the tree and the tab strip show, WITHOUT the extension — plus
  one row per folder, matched by its own name (🔒 YAZ-1775 D2 on YAZ-1491) and labelled by its parent. A
  drawing never matches on its folder; the folder is its own row instead.
- **It is derived, not indexed.** There is no vault index any more (it went with the markdown layer
  in YAZ-1808): the catalog is one walk of the tree the Sidebar already holds, which IS `fs:tree`
  and is already kept fresh by the structural watcher — so a drawing created a second ago is
  findable without a restart, and searching costs no second read of the vault.
- **What never appears:** a file of no supported kind (it lists in the tree and opens in the OS app,
  but it is not a document this app can search for), and the image store `assets/`, which `fs:tree`
  has already dropped (🔒 YAZ-1775 D3). A folder the user called `assets` inside a subfolder is
  theirs and is searchable, exactly as the tree rule says.
- **Ranking** is the ONE matcher every naming surface uses (`search/matchCandidates.ts`, GRO-2197):
  case-insensitive, exact → prefix → substring, input order inside a bucket, capped at `SEARCH_CAP`
  (50) AFTER ranking, so a late exact match still tops a page of substrings. Folders lead the
  catalog, so a folder sits above a drawing it ties with — the reveal is the cheaper mistake.
- **The feed is lazy and latches.** Nothing is built until the first non-empty query of a mount;
  from then on it rebuilds with every new tree. There is NO debounce — the scan is synchronous and
  a tripwire test over a 5,000-drawing catalog fails if it ever stops being cheap.
- **Keys, in the bar** (it keeps focus throughout, so ↑/↓ carry on walking): ↑/↓ move and WRAP at
  both ends; Enter activates — a drawing OPENS in the current tab, a folder REVEALS itself in the
  Files lens (🔒 YAZ-1775 D3 on YAZ-1491) — ⌘-Enter opens in a background tab; Escape clears a typed query
  and only gives up focus on a second press. A click does exactly what Enter does on that row.
- **A right-click on a result row** (YAZ-2056 D5/D6, a port of Docs YAZ-2050) opens the SAME menu
  that board's or folder's Files row gets, through the same `openMenu` (`SearchResults.onRowContextMenu`),
  and highlights the row; blank space under the results, or "No matches", offers no menu at all and
  is default-prevented, so Electron's text menu never leaks through (the bar itself keeps it). It
  follows the FILES rules on either tab — a search row is a disk row: `MenuTargets.lens` pins
  `'files'` for a search row (the active lens otherwise), and every lens read in the menu path reads
  it — `focusOn(paths, lens)` and `startCreate`'s Favorites hop. The seven items that draw INTO the
  hidden tree — Focus, New Excalidraw drawing, New dated Excalidraw drawing, New draw.io diagram,
  New folder, New dated folder, Rename — first leave the search through the folder-row reveal door:
  `MenuTargets.leaveSearchTo` names the row, `viaTree` calls `onRevealInFiles` with it, and the
  reveal clears the query, ends a focus that would hide the row, expands and flashes it before the
  box or the focus lands beside it. Every other item acts in place and the query stays. Multi-select
  never reaches this menu (a query clears the selection).

## Menus and shortcuts

The application menu is a pure function of its inputs (`desktop/src/main/menu.ts`
`buildMenuTemplate`), so its structure and accelerators unit-test without Electron. Item ids are
stable. A menu action targets the OS-focused window, else the most recently focused live window
(GRO-2197: macOS reports no focused window while the app is not frontmost, and a menu item must
never silently do nothing).

**🔒 A window with a vault never has its vault swapped (YAZ-1913).** Only an empty Welcome window
(root `null`) fills itself in place. Every other vault-opening gesture — File › Open Folder… (⌘⇧O),
the vault switcher's Open folder… row and its vault rows, File › Open Recent — goes through main's
one open-recent door, `openRecentBeside`: that vault's live windows are raised, or a new window opens
on its remembered last file. Picked folders decide in the renderer (`App.tsx` `openPicked`, which
knows its root); Open Recent decides in main (`menu.ts` `openRecent`, from the target window's
entry). The one opt-in exception is "Open in this window" — the vault menu's item (YAZ-1941 D2),
or ⇧⏎ / ⇧-click on a switcher row (Docs YAZ-1974 D8) — which calls App's `openRoot` directly.

**The vault switcher** (⌘O; YAZ-2056, a port of Yaseen Docs YAZ-1974):
the sidebar header's trigger drops a `ContextMenuSurface` panel hung off the header's rect: a filter
input, then every recent vault as ONE line — display name · ⓘ · relative time — the current vault
marked `aria-current`, then Open folder…. The keyboard model is YAZ-1767's: ⌘O toggles the panel;
an empty query highlights the last-used OTHER vault, a typed one its top match; ↑/↓ clamp; ⏎ or a
click opens beside through `openRecent` (a `false` greys the row "Folder not found" and the panel
stays); Esc closes. **Names** (Docs YAZ-1974 D3–D6): `storage.vaultName(root)` —
`folders[root].name ?? basename(root)`, live through `useVaultName` — is what the trigger, the rows,
the OS window title (`windowTitle(vault, file)` takes the NAME), Welcome's recents, "Copy vault name"
and Settings › Sharing's "Nothing in … is shared." show (YAZ-2056 D4); File › Open Recent keeps full
paths, and the Reveal / VS Code "no longer there" notices keep the FOLDER name, on purpose. The
filter ranks through `matchCandidates` over each row's display name AND folder name (`VaultRow.folder`;
one candidate per name, the second only when it differs) — each row once, at its best rank (Docs YAZ-1974 D6).
**The path** (Docs YAZ-1974 D2) is one hover away: an ⓘ between name and time, shown while its row is hovered
(`visibility`, so nothing shifts; a dead row too), draws the WHOLE path — `<wbr>` after every `/`,
never truncated — in a `role="tooltip"` portalled to `<body>`, `position: fixed` at the row (below
it, or above when there is more room there) at z-index 42, so the panel's scroll box never clips
it; mouse-only by design; a click on the ⓘ is the row's click, a right-click the row's menu; the
trigger keeps `title={root}`. **Width** (Docs YAZ-1974 D7): the panel is at least the header's width and grows to
fit its longest name, capped at `min(480px, 100vw − 16px)`; past the cap a name wraps
(`overflow-wrap: anywhere`), never "…". `ContextMenuSurface` keeps `width` — a fixed width, for the
Info popover and the Share menu — and adds `minWidth` beside it, the floor the switcher passes
(YAZ-2056 D2; Docs renamed `width` to `minWidth`, which Draw's two fixed-width callers rule out).
**⇧** (Docs YAZ-1974 D8/D9): ⇧⏎ and ⇧-click open the vault IN this window — the menu's "Open in this window"
(`onOpenHere`, a `false` greys the row) — a plain ⏎ on the current vault, ignored on Open folder…,
inert on a dead row; while ⇧ is held (window `keydown` / `keyup`, released on window `blur`,
listened to only while the panel is open) the highlighted row's time slot reads "Open here" in the
accent colour — never on the current vault, a dead row or Open folder….

**The vault menu** (YAZ-1941, a port of Yaseen Docs YAZ-1798): right-clicking the switcher's
trigger (= the current vault) or any live row opens the sidebar's own `ContextMenu` with
`buildVaultMenuSections({ path, name, isCurrent, renamed })` (`sidebar/vaultMenuSections.ts`, pure) —
five groups: another vault gets [Open in this window `⇧⏎`] · [Set display name · Reset to folder
name] · [Copy vault name · Copy path] · [Reveal in Finder · Open in VS Code] · [Remove from recent
vaults]; the current vault only the middle three groups; "Reset to folder name" only while a
display name is set (Docs YAZ-1974 D5 — never labelled "Rename", which renames on disk in the file
menu). "Set display name" turns the name into an inline `TextField` (`components/TextField.tsx`,
YAZ-2056 D3) WHERE it was right-clicked — the header or the row, a `<div>` in place of the
`<button>` meanwhile — the name selected, the folder name as placeholder: ⏎ or blur saves, Esc
cancels, an empty field is the folder name again; the field is the top layer: Esc and click-away
end only it (the panel stays), and a mousedown on another row ends it (the blur saves) and swallows
that click, so a vault never opens by accident. "Copy vault name" copies the display name. "Open in this
window" is `openRoot` (in place; `false` greys the row like a click's); Reveal / VS Code are the
Sidebar's own verbs (any absolute path, `NOT_FOUND` notice); the copies confirm through the sidebar
notice; Remove is `storage.removeRecentRoot` with no confirm (the folder is untouched) and drops the
row at once. The menu is the top layer while it stands: Esc and click-away close only it, and the
filter ignores ↑/↓/⏎/Esc meanwhile. Every right-click swallows Electron's native text menu; a
"Folder not found" row gets no menu.

| Menu | Item | Key |
|---|---|---|
| Yaseen Draw | Settings… | ⌘, |
| File | New Window | ⌘⇧N |
| File | Switch Vault… | ⌘O |
| File | Open Folder… | ⌘⇧O |
| File | Open Recent ▸ | — (from a vault window it opens beside; Welcome fills in place) |
| File | Search Vault | ⌘K |
| File | Export Image… (a board tab) | ⌘⇧E |
| File | Export Excalidraw Drawing… (a drawing tab only) | ⌘⇧S |
| File | Share Link (a board tab) | ⌘⇧L |
| File | Close Tab | ⌘W |
| File | Close Window | ⌘⇧W |
| Edit | Undo / Redo / Cut / Copy / Paste / Select All | stock roles |
| View | Toggle Sidebar | — |
| View | Reload · Toggle Developer Tools (dev builds) | — |
| View | Actual Size / Zoom In / Zoom Out | ⌘0 / ⌘+ / ⌘− |
| View | Canvas Background ▸ White / Slate / Blue / Yellow / Bronze (a drawing tab only) | — |
| Window | Minimize · Zoom · Next Tab · Previous Tab · Bring All to Front | ⌃Tab / ⌃⇧Tab (⌘⇧] / ⌘⇧[ alternates) |
| Help | Yaseen Draw on GitHub | — |

Zoom is deliberately NOT the stock roles: a registered accelerator never reaches the page on
macOS, so main applies the step to the focused window's `webContents` itself.

Export Image…, Export Excalidraw Drawing… and Canvas Background are the canvas's own three items, moved out
of the engine's main menu by 🔒 YAZ-1775 D10 (there is no `<MainMenu>` in a drawing and the engine's stock
trigger is hidden). Main enables them only while the window a menu action would target has a
board of their kind in front, rebuilding the menu when any window's active file changes and when focus
moves between windows. Each is pushed to that window's renderer, which dispatches it as a DOM
event on the VISIBLE drawing layer (`client/src/drawings/boardCommand.ts`) — several tabs are
mounted at once, each with its own engine, so a prop or a `window` listener would reach the wrong
canvas. The drawing then calls the engine's own door: `openDialog: { name: 'imageExport' }` (the
engine's PNG / SVG export dialog), or `viewBackgroundColor`, which the engine writes into the
file — or, for Export Drawing…, the assembly below. Export Image… also works on a draw.io diagram
(🔒 YAZ-1802 D9): main enables it on any board tab (`MenuInputs.activeKind`), the event lands on the
visible `.editor--diagram`, and the diagram's picture comes from the D9 renderer ("draw.io
diagrams").

### Sidebar sort and Info (🔒 YAZ-1835)

**🔒 D1 — the order is a VIEW, applied in the renderer.** `fs:tree` keeps handing over the tree in
name order; `sortTree` (`shared/treeSort.ts`, a pure rule) returns a re-ordered COPY that the
Files lens renders. ⌘K reads the unsorted tree (its "input order inside a bucket" tie-break is
therefore untouched by the sort), and the Favorites lens keeps the user's hand order.

**🔒 D2 — three orders.** Name (case-insensitive `localeCompare`) · Last updated · Created. A date
reads the board's block first and its mtime when it has none (🔒 YAZ-1834 D6); newest first; a tie
falls back to the name so the order is stable across refreshes. Folders ALWAYS lead and are ALWAYS
by name — a folder has no dates — and a folder's contents use the same order at every depth. There
is no "last opened" (🔒 YAZ-1834 D2).

**🔒 D3 — per vault, in the app state.** `FolderState.sortOrder`, default `name`, persisted; a
pre-1835 file loads `name`. Every window on the vault follows a change: the Sidebar subscribes to
the store cache, which `state:changed` refreshes.

**🔒 D4 — the tree refreshes on EVERY watcher event.** A save is a `change`, and a save is what
moves `updatedAt`; the Sidebar used to skip `change`. One tree walk per save (one stat and a 1 KB
head read per board), with no own-write echo guard on purpose: our own save is the reorder we want.
Walks overlap, so an answer older than the tree on screen is dropped by `generatedAt`. Coalesced
(YAZ-2073 5E): main runs one walk per root at a time and callers arriving mid-walk share ONE trailing
walk, and the Sidebar waits out 120 ms of watcher quiet (`WATCH_REFRESH_MS`; `ready` refreshes at
once), so a 230-file sync pull is a couple of walks, not 230 concurrent ones.

**🔒 D5 — the control.** One button (`.sidebar__sort`) in the lens row, Files lens only, hidden
while a query is typed; it opens the same `ContextMenu` the rows use with three items and a `✓`
hint on the current one.

**🔒 D6 — Info.** A board row's context menu offers `Info` directly above `Delete`, in Delete's
group, on either lens — for ONE board only: never blank space, a folder, a non-board file or a
2+ selection (`MenuTargets.infoPath`, its own field). Selecting it closes the menu and opens a
`ContextMenuSurface` popover (`role="dialog"`) at the click point; click-away or Escape closes it,
and so does the board vanishing.

**🔒 D7 — Info reads the live tree, nothing else.** The popover keeps the board's PATH and resolves
the node off the current tree on every render, so a save in any window moves its dates and a
deletion closes it. Rows: Name · Type ("Excalidraw drawing" / "draw.io diagram", `BOARD_TYPE_NAME`,
🔒 YAZ-1802 D13) · Folder (vault-relative, `/` at the root) · Size · Created · Updated · On disk (mtime); dates as "Sep 22, 2026, 3:14 PM · 2 hours ago" (`formatDateTime`,
`relativeTime`); a board with no trustworthy block reads "Not stamped yet · written on the next
save" for the two dates (🔒 YAZ-1834 D7). No new IPC. The demo vault behind these rules is
`tools/seedSortDemoVault.mjs`, proved by `sortVault.integration.test.ts`.

### Sidebar hover preview (🔒 YAZ-1800)

**🔒 D1 — drawn on the first hover, in the renderer, kept in memory.** No new IPC: the picture is
`drawing:load` → `parseSceneText` → `restoreElements` → `visibleElements` → `createScenePreviewPng`
(`lib/scenePreview.ts`) fit to 1200 × 800 with 16 px padding. Nothing visible answers `''` ("Empty
board"); a refused load or a failed draw is the cache's `null` ("Preview unavailable"). The load
passes `imageMaxPx` (the picture's longest side, 1200): main answers each plain PNG at the next
power of two at or above the size it is drawn in the picture — never smaller, never upscaled; a
cropped, colour-profiled, EXIF-rotated or animated PNG and every other type keep their bytes —
cached per immutable asset as `<userData>/thumbs/<fileId>-<px>.png`, reused across launches, the
least recently used dropped past 256 MiB (🔒 YAZ-2073 D6). Nothing is written to the vault and no
board's picture is stored; a relaunch redraws. The key is `root \n path \n mtime \n
theme \n diagramDarkColors` — mtime, not the `updatedAt` block, because every write moves it and
the block's one advantage (surviving a clone) means nothing to a memory cache. A draw.io diagram
is `diagram:load` → the D9 renderer instead (🔒 YAZ-1802 D9), same bounds, `''` and `null`.

**🔒 D2 / D3 — the switch.** `SettingsState.hoverPreview`, app-wide, default `true`, in
`yaseendraw.json`; flipped by Settings › Files › Preview on hover and by the picture-frame button in
the lens row's `.sidebar__tools` group (sort · preview · eye · chevrons), accent while on.

**🔒 D4 / D5 — the panel and its triggers.** `BoardPreview.tsx`, portalled, `pointer-events: none`,
right of the sidebar and vertically centred (`boardPreviewPlacement`). It opens after a 400 ms
dwell of the pointer OR keyboard focus on a board row, in either lens. It closes at once on leave,
blur, a row click, drag, right-click, another board opening, a menu or Info opening, a search, the
toggle, the row leaving the tree, and a capture-phase Escape that touches nothing else. A save or a
theme flip is a new key, swapped in place. Board rows drop the native path tooltip while previews
are on.

**🔒 D6 — bounded.** `createPreviewCache(fetch, { limit })` evicts the least recently seen picture;
boards keep 32. The demo vault is `tools/seedPreviewDemoVault.mjs`, proved by
`previewVault.integration.test.ts`.

### Board metadata (🔒 YAZ-1834)

Every board main writes begins with its own two dates:

```json
{
  "yaseendraw": { "createdAt": 1758500000000, "updatedAt": 1758500000000 },
  "type": "excalidraw",
  …
}
```

**🔒 YAZ-1834 D1 — the block lives IN the file, as its first key.** Not in a sidecar and not in
`.yaseendraw/`: a shared vault file that changed on every save would put the same lines under
two machines' edits on every save and make every sync a merge; a block inside the drawing
changes only when the drawing changes, travels with rename, move, clone and sync for free, and
needs no repair code. Written first so `fs:tree` can read it from the first KB of the file
(`BOARD_META_HEAD_BYTES`) without opening the board.

**🔒 D3 — main sets both dates, in the doors that already write the file.** `fs:create-file`
births the block (`createdAt = updatedAt = now`) inside "New drawing"'s content, under the same
`wx`. `drawing:save` re-reads the current file's head — the engine's serializer drops keys it
does not know, so the renderer never sends the block back — keeps `createdAt`, sets `updatedAt`
to now, and `stampBoardMeta` places it first in the same atomic write as the scene. A board with
no block is born one on its first save, aged by its pre-save mtime. A refused save (`CONFLICT`,
`BAD_REQUEST`, `TOO_LARGE`) stamps nothing. Consequence: an "untouched" save moves `updatedAt`
and nothing else; the scene below the block stays byte-identical.

**🔒 D5 — the block is the backfill contract** (YAZ-1832). `createdAt` is never rewritten once
it is a finite number, and every other key inside the block is preserved verbatim, so an importer
may add `"cloudId"` beside the dates and it survives every save. The importer must write the
block FIRST: a block anywhere else is not read (D7) and is replaced on the next save. It does not
have to spell that itself — `stampBoardMeta(sceneJson, dates, cloudBlock)` is the one writer of
the block, and the importer calls it like the save door does.

**🔒 D6 — no new bridge.** `TreeNode` (file) carries `meta?: { createdAt, updatedAt }` when the
head holds a trustworthy block. For sorting, YAZ-1835 will take the block over `mtime`: a clone
resets mtimes, the block travels. Boards without one will sort by `mtime`.

**🔒 D7 — a missing, misplaced or malformed block is simply "no metadata".** The tree shows
none, nothing is moved aside, no save or create is ever blocked by it, and the next save births a
fresh block. A board main cannot even OPEN (permissions) is still listed, from its stat, without
dates — no metadata is never no board. `drawing:load` passes the block through untouched inside
`json`; the engine ignores it. Export Drawing… (below) writes NO block — an export is a snapshot,
not a board — and neither does the saved-components store (`library/componentStore.ts`, whose
`.excalidraw` fragments live outside any vault). A copy (Finder or in-app) keeps its origin's
dates. Dropped from the design on purpose: `openedAt`, an id, tags, description (🔒 D2).

**🔒 YAZ-1802 D7 — a diagram carries the same two dates** as the first two attributes of its root
`<mxfile>` — `yaseendraw-created` / `yaseendraw-updated`, epoch ms — because a `.drawio` is XML, not a
JSON object. Same doors, same rules: `fs:create-file` births both, `diagram:save` keeps `created` from
the current file's head (else its pre-save mtime, exactly like a drawing), moves `updated`, and
restores both when draw.io or another editor dropped them. A bare `<mxGraphModel>` file has nowhere
to carry them and is simply undated until draw.io saves it back as an `<mxfile>`.

Pure rules: `shared/drawingAssets.ts` (`stampBoardMeta`, `parseBoardMetaBlock`) and
`shared/diagramFile.ts` (`stampDiagramMeta`, `parseDiagramMetaAttrs`); the one open that serves both
the tree and the save: `desktop/src/main/fs/boardHead.ts` (`readBoardHead`).

### Export Drawing… (🔒 YAZ-1775 D3, YAZ-1821)

**🔒 YAZ-1775 D3 says the vault file never embeds, and that export is the one place that does.** A board in
a vault is a lean scene (`files: {}`) beside a shared `<vault>/assets/` folder, because embedding
base64 makes multi-MB files that git rewrites on every save. A file being handed to someone else
has no `assets/` folder to point at, so Export Drawing… writes a STANDALONE `.excalidraw` with
every image it uses embedded — the file upstream Excalidraw and excalidraw.com open with its
pictures intact. It is also exactly what a share link uploads (Share links, below).

- **The renderer assembles it** (`client/src/drawings/exportDrawing.ts`):
  `serializeAsJSON(elements, appState, files, 'local')` — the library's own writer, the same one
  the vault save uses — over the **full canvas files map**: everything YAZ-1811 hydrated out of `assets/`
  at load, plus anything pasted, imported or inserted since and not yet saved. The engine's live
  map is the only place all of it is in one piece.
- **Files only deleted elements name are not sent.** An undo can leave an image's bytes in the
  engine's map long after the element is gone, and shipping them would put a deleted picture inside
  a file about to be handed to someone. The filter is `referencedFileIds`, the same rule YAZ-1811's save
  path uses; `serializeAsJSON(…, 'local')` filters again (`filterOutDeletedFiles`) — belt and
  braces, and idempotent.
- **Main owns the sheet and the write.** `dialog:save-file` shows the save dialog (default name
  `<board name>.excalidraw`, `.excalidraw` filter) and then writes atomically, in the same call.
  One door rather than "pick a path, then write it": a renderer holding an arbitrary absolute path
  it may write to is what the fs layer's root-relative rules exist to prevent, so the only path
  ever written is the one the user has just typed into a native sheet. The extension is enforced
  after the sheet, because a name can be typed freely.
- **The vault file is not touched.** An export reads nothing from the vault, writes nothing into
  it, and does not flush the autosave: exporting a dirty board exports what is on the canvas, and
  the board's own save timer carries on. Where it landed, or why it did not, is the window's one
  passive notice.

**A hidden tab shows nothing** (🔒 YAZ-1862). Background tab layers are `visibility: hidden` (so they
keep their size), and the rule reaches EVERY descendant with `!important`: the engine forces its footer
buttons back to `visibility: visible`, and without the override a background tab's zoom label and
buttons painted over the active tab and took its clicks.

**Focus on tab reveal** (🔒 the focus-handoff decision on YAZ-1812). Several tabs are mounted at
once; the canvas has `autoFocus`, but that fires only at mount, so switching to an
already-mounted tab used to leave the keyboard nowhere until the user clicked. The reveal effect in
`DrawingEditor` (the `IntersectionObserver` that re-measures the canvas) now also hands it the
keyboard through `DrawingSurfaceApi.focus()` — GATED by `drawings/focusHandoff.ts`: only when
`document.activeElement` is the body or nothing at all, or is inside the tab layer (the tab being
left). The sidebar search bar, the vault switcher, a dialog and the tab strip keep what they have;
a tab becoming visible must never pull ⌘K's caret out from under the user. The re-measure is
unconditional — only the focus is gated.

Renderer-owned chords (`client/src/lib/*Hotkey.ts`, all gated by `ownsWindowChord` so a text field
or an open modal keeps the key): ⌘B toggles the sidebar (YAZ-1280); ⌘X / ⌘C / ⌘V drive the
sidebar's file clipboard when the selection owns them. Inside a focused canvas, ⌘F and ⌘C open the
canvas panel's Images and Components tabs — and ⌘F additionally puts the caret in the Images tab's
search field (YAZ-1818, the web app's `onRequestImageStudioSearch`, as a counter the tab watches)
— bound on the drawing's own element in the capture
phase, never `window`, and suppressed whenever the keystroke could have meant something else (an
editable target, a live selection, a gesture in flight, a dialog, or anything selected on the
canvas). That last gate is why ⌘C with a selection is still the engine's COPY and nothing else
(YAZ-1819): the Components tab is what ⌘C means only when there is nothing to copy. Settings › Hotkeys lists every one of them and is the single place that copy lives.

**Inside a draw.io diagram** (🔒 YAZ-1802 D17) the keyboard belongs to the iframe, and no key
pressed there reaches the renderer's document. The menu's accelerators (⌘K, ⌘W, ⌘O, ⌘⇧O, ⌘, , the
zoom trio, ⌘⇧E, ⌘⇧L, the tab keys) still fire, because the menu takes them whatever frame has focus;
draw.io's own bindings on ⌘K / ⌘, / ⌘0 / ⌘+ / ⌘− and ⌘⇧O / ⌘⇧E / ⌘⇧L / ⌘⇧[ / ⌘⇧] / ⌘⇧S are cleared in
the configure reply (`MENU_CHORDS`), since off macOS the page would see the key first — ⌘⇧S too,
though Export Excalidraw Drawing… is greyed there, because draw.io's own is Save As, which the app
has not got. Export Image… and Share Link work on a diagram tab; only Export Excalidraw Drawing… and
Canvas Background are greyed there. ⌘S is draw.io's own `save` event,
which the host flushes at once. Of the renderer-owned chords only ⌘B means something here: with
nothing selected our `PostConfig.js` sends it up as draw.io's `shortcut` event and the host toggles
the sidebar; with a selection it stays draw.io's bold. ⌘X / ⌘C / ⌘V and Escape stay draw.io's.

The right-click menu inside the renderer is Electron's (`buildContextMenuTemplate`): spelling
suggestions, Add to Dictionary, and cut/copy/paste. Electron ships no default one, which is why
this exists at all.

### Settings

The dialog (`client/src/settings/`) is one scrolling page of sections plus a standalone Hotkeys
page, driven entirely by the registry in `registry.tsx`: a setting is declared once — id, label,
hint, search keywords, how it renders — and appears in its section, in the nav and in search from
that one entry. A row's `id` IS its `SettingsState` field name wherever the setting has one; the
two that do not — the Pixabay key and the GitHub switch — are marked below.

| Section | Rows |
|---|---|
| Appearance | Theme · draw.io diagrams in dark mode (🔒 YAZ-1802 D16: Adapt colours / Keep original colours) — 🔒 YAZ-1775 D9 put everything else about the canvas in Excalidraw canvas |
| Excalidraw canvas | the fourteen `CanvasPrefs` (🔒 YAZ-1775 D9) in three groups: Drawing aids, Modes, New elements — Excalidraw's alone; a draw.io diagram has fixed defaults (🔒 YAZ-1802 D12) |
| Files | Confirm before deleting · Library folder (🔒 YAZ-1775 D5: resolved path, Choose…, Reset to default) |
| Images | Pixabay API key (🔒 YAZ-1775 D4: a password field, Save / Clear, "Key set" / "No key" from `secrets:has`, never echoed) — NOT in `SettingsState`, it lives in main's owner-only `secrets.json` (YAZ-1842 D1) |
| Sync | the per-vault GitHub switch — the other setting NOT in `SettingsState` (it lives in `.yaseendraw/github.json`) |
| Sharing | its own page (YAZ-1799 🔒 D7): Status · Set up sharing (Open Cloudflare, the pasted key, the account picker, the step list) · Your shared boards (permission, Copy link, Stop sharing, the one status line; live-checked) · Custom domain · How sharing works · Turn off sharing (Forget key / Delete all shared links, each behind an in-page confirm). Nothing here is in `SettingsState` — see Share links |
| Storage | its own page, like Hotkeys (YAZ-1801), present only while a vault is open — a report, not settings: **GitHub** (a bar of the git history on a fixed scale ending at 10 GB, marked at 1 GB and 5 GB; green to 1 GB, amber to 5 GB, red past it, "10 GB — over GitHub's max" past 10 GB; "Not synced with git" for a plain folder) with two muted lines, "Your files N" and "Old versions N" · **Needs attention** (only when non-empty: every file ≥ 50 MiB, red "Stays on this Mac" at the sync guard's 95 MiB, amber "Close to the limit" below) · **Make Excalidraw drawings smaller** (only while pictures are inside drawings, or a result from this session is showing: one sentence, "Move pictures out", the result line). Measured only while Settings is open (🔒 D13): on the page's open, a sync pass finishing, and after a shrink — one measure at a time, a trigger mid-measure queuing one re-run; a failed first measure reads "Couldn't measure this vault" |
| Hotkeys | its own page: the Window, Excalidraw canvas, draw.io diagram and Mouse tables, from `hotkeys.ts` |

A group may declare `available(ctx)` (Storage's two conditional groups), and a row may be `bare`
— its control is the whole row, its label and hint feed search only.

`hotkeys.ts` is the single source of truth for every binding the app advertises — Settings ›
Hotkeys renders it and nothing else — and `hotkeys.test.ts` pins the expected set, the Excalidraw
canvas and draw.io tables included, so a keymap change anywhere fails loudly here.

## Share links (YAZ-1799)

A board can be shared as ONE read-only link anyone can open in a browser, with no account and no
app. The link is served from the user's OWN Cloudflare account — one R2 bucket and one small
Worker the app provisions (🔒 YAZ-1799 D1) — so nothing goes through anyone else's server. There
is no encryption (🔒 YAZ-1799 D2): the link's random id is its only secret, 144 bits
(`newShareId`), and the Worker checks only its shape.

**Who owns what.**
- MAIN owns Cloudflare: the API token, the Worker's upload password and every HTTP call
  (`desktop/src/main/share/`: `sharing.ts` wires `config.ts` — sharing.json, link origin, the Worker
  request —, `setup.ts` — the Cloudflare API: set up, domain, disconnect — and `boards.ts` — the
  shared boards). The token crosses the bridge exactly once, renderer → main in `share:setup`, and
  no `share:*` answer or push carries it or the password.
- The RENDERER assembles the bytes (`client/src/share/shareContent.ts`): the same standalone
  `.excalidraw` Export Drawing… writes, images embedded, read from DISK (Share can start from the
  sidebar on a board that is not open; an open one is flushed first). A draw.io diagram is its
  `.drawio` XML exactly as saved (🔒 YAZ-1802 D11) — its pictures already live inside it. Main
  checks the size and uploads; it never assembles.

**Storage.**
- `<userData>/sharing.json` — which account, bucket and Worker, the workers.dev address, the custom
  domain. App-wide (the Cloudflare account is the user's, not a vault's), not a secret, never in
  app state.
- `secrets.json` — `cloudflareApiToken` and `shareUploadPassword` (see Secrets). The password is
  generated by main at every setup and uploaded as the Worker's secret binding; nobody sees it.
- `<vault>/.yaseendraw/shares.json` — `{ version: 1, shares: { "<vault-relative path>": { id,
  allowDownload, sharedAt, updatedAt } } }`, written on the vault's own chain
  (`shareLinks.updateShares`). A malformed file is `INVALID_CONFIG`, never overwritten.

**The Worker** (`share/worker.js`, plain JS: the exact file Cloudflare runs, main uploads verbatim
and `tools/fakeCloudflare.mjs` runs under Node). Boards live at `boards/<id>.excalidraw`; each
link's download flag is its OWN object, `perm/<id>` (`"0"` | `"1"`, missing = allowed —
🔒 YAZ-1799 D15), so a re-upload never resets it and flipping it never rewrites the board.
- `PUT /api/boards/:id` — bearer; `Content-Length` required, over 100 MB (`MAX_BODY_BYTES`, the
  Workers free plan's body cap, = `MAX_SHARE_BYTES`) refused 413 before a byte is read; streamed into
  R2. `x-allow-download` writes the flag only when present (a first share, or a stale one coming back).
- `PATCH /api/boards/:id` — bearer, `{ allowDownload }`: the flag alone, same link, no re-upload.
- `DELETE /api/boards/:id` — bearer: the board and its flag; the link dies at once.
- `POST /api/wipe` — bearer: ONE page (≤ 1,000 objects, one list + one batched delete) per call,
  answering `{ done }`, so every call stays under the free plan's 50 subrequests; main calls until done.
- `GET /b/:id` — the viewer page; `/scene/:id` — what it draws; `/raw/:id` — the download, 403
  when downloads are off (🔒 YAZ-1799 D5/D9: one link, the permission enforced server-side, not
  just hidden); `/assets/*` — the viewer's static assets. A stopped, unknown or malformed id gets
  the same "stopped or never existed" page.
- Auth is `Authorization: Bearer <password>`, compared in constant time. The board name rides
  `x-board-name` (URI-encoded, capped at 300) and is HTML-escaped in the page; the page's JSON data
  block is `<`-escaped; the download's `filename*` is RFC 5987.

**Diagrams** (🔒 YAZ-1802 D11). A board is a `drawing` (scene JSON) or a `diagram` (`.drawio` XML).
- Main uploads a diagram with `content-type: application/xml` and `x-board-kind: diagram`; a drawing
  sends no kind. The Worker stores it as the R2 custom metadata `kind` and answers it on `/scene`
  and `/raw` as `x-board-kind` (a diagram served as `application/xml`, downloaded as
  `<name>.drawio`). The key stays `boards/<id>.excalidraw` for both, and anything but `diagram` —
  a board stored before kinds included — is a drawing, so every old link keeps working.
- `/b/<id>` picks the viewer by kind. A diagram's page runs draw.io's own read-only viewer
  (`GraphViewer`, the D9 renderer's `viewer-static.min.js` from the pinned draw.io): first
  `/assets/drawio/config.js`, which points every path it would take from viewer.diagrams.net at
  `/assets/drawio/`, then the viewer, then `/assets/diagram.js`. It opens fitted (never past 100%);
  the viewer's hover toolbar zooms and turns pages, and dragging or scrolling pans. It offers
  Download .drawio only — no PNG: draw.io draws labels as HTML inside the SVG, and Safari and
  Firefox block reading such a canvas back. Same CSP, still no inline script.
- The Worker's `/assets/drawio/` holds our `config.js` and a `fonts.css` for the editor's five font
  families pointing at the Excalidraw fonts already under `/assets/fonts/` (the two files built into
  `share/dist/assets`, the fonts published from the app's renderer copy), and draw.io's own files, `DRAWIO_SHARE_FILES` in `drawio/assets.ts`, which
  share setup reads from the app's ONE draw.io webapp (`readViewerAssets`, 🔒 YAZ-1802 D5,
  YAZ-1973) and publishes at their pack paths: `js/viewer-static.min.js` (4.2 MB),
  `js/stencils.min.js` (7.7 MB, all 204 stencil sets — `diagram.js` loads it only for a diagram
  that names a `mxgraph.…` library shape, compressed pages looked inside), `LICENSE-drawio.txt`,
  and two whole folders (`DRAWIO_SHARE_DIRS`): `img/` (11 MB, ~2,100 files) — the pictures
  draw.io's image shapes point at (Azure, network, clipart…), which would otherwise draw blank on a
  link — and `math4/` (3.3 MB, 78 files), the MathJax the viewer loads on every page, without
  which a math label shows raw TeX. `config.js` also points the paths nothing is published under
  (styles, shapes, mxgraph) at `/assets/drawio/`, because unset they default to viewer.diagrams.net.
  The static assets are ~50 MB (~2,600 files); every file far under Cloudflare's 25 MiB per asset
  and the whole set under its 20,000-files-per-version cap.
- **An outdated Worker.** The Worker echoes the stored kind on every PUT (`x-board-kind`). A Worker
  deployed before kinds answers a diagram's upload without it, and would serve the XML to the
  Excalidraw viewer: main refuses the upload with `WORKER_OUTDATED` ("… run Set up sharing again").
  A first share is taken back down (nobody has its link yet); an already-shared diagram keeps its
  record and shows the failure as its status line, and the first save after setup puts it right.
  Set up sharing again is the one redeploy every user needs: it reuses the bucket and the Worker
  (D11 of YAZ-1799), uploads the new code and assets, and every link keeps its id.

**Always live** (🔒 YAZ-1799 D3). Every successful save of a shared board re-uploads it to the SAME
id (`client/src/share/liveShare.ts`), per board in the window that saved it: after 10 s with no
further save (SETTLE), never two uploads at once (ONE IN FLIGHT), and a save that lands mid-upload
queues exactly one more, which re-reads the disk (LATEST WINS). Main records every outcome of an
already-shared board in memory (`uploading` → ok | `failed` + reason) and the dialog, the
sidebar mark and Settings show the one status line (`shareText.liveLine`); a failure keeps the
record and the link's last good version, and the next save retries — nothing retries on a timer.
Not set up, too large and offline are all refusals main records the same way.

**Stale.** A link whose copy is gone from R2 (a Settings list check or a PATCH answered 404) is
marked `stale`; the next save re-creates it on the same id, and that PUT carries the recorded
permission. `share:list` checks every link with one HEAD of `/scene/<id>` — only Settings asks for
that; the sidebar marks call it with `check: false` and send nothing.

**Rename and delete** (🔒 YAZ-1799 D10). An in-app rename or move (drag, cut/paste, across open
vaults too) moves the record, keyed by path, with the board — the link does not change, and a
re-upload in flight names its link (`id`) so it lands on the moved record. An in-app delete stops
the share (a failure keeps the record so Settings can stop it later). A rename in Finder is not
seen: Settings lists the record as "No board at this path any more".

**Setup** (Settings › Sharing, 🔒 YAZ-1799 D7). One pasted API token; "Open Cloudflare" opens the
token page pre-filled with the five permissions sharing needs (🔒 YAZ-1799 D16: Workers Scripts:
Edit, Workers R2 Storage: Edit, Account Settings: Read, Zone: Read, Workers Routes: Edit). An
account-owned `cfat_…` key is verified at its account, not at `/user` (🔒 YAZ-1799 D18). A key that
sees several accounts shows a picker first (🔒 YAZ-1799 D12). The steps, each reporting progress
and naming its missing permission on a 403: verify · account · bucket · viewer (the static assets)
· worker (code + password binding) · subdomain · test (a real upload, read-back and delete, backing
off for up to ~90 s while a fresh workers.dev address comes up).
- **Reuse** (🔒 YAZ-1799 D11): an existing bucket and Worker are found and reused, never recreated
  or emptied, so a re-setup after "Forget key" brings every old link back (with its custom domain).
- **Subdomain** (🔒 YAZ-1799 D17): an account with no workers.dev subdomain gets one claimed,
  `<account-slug>-xxxx`, retrying a taken name.
- **Custom domain**: attached as a Worker custom domain on the account's zone with the LONGEST
  matching name; refused in plain English when the zone is missing, not yet active, or the name
  already has a DNS record. The new domain is attached before the old one is detached.
- **Turn off**: "Forget key on this Mac" forgets the token, password and sharing.json — links keep
  their last version. "Delete all shared links" wipes the bucket, then the domain, the Worker and the
  bucket, then forgets; it clears only the OPEN vault's shares.json (another vault's records stay
  until that vault stops them).

**The viewer** (🔒 YAZ-1799 D13). React and the SAME vendored Excalidraw the app draws with, bundled
by `tools/buildShareViewer.mjs` into `share/dist/assets/` (part of `npm run build` and `npm run
dev`), shipped as the `share-viewer` extraResource and uploaded as the Worker's static assets —
with Excalidraw's fonts under `/assets/fonts/`, published from the app's own renderer copy
(`excalidrawFontsDir` in `ipc/share.ts`, YAZ-2073 3C), so nothing is fetched from a CDN at view time. View mode only; Download .excalidraw
and Download PNG (2×) when allowed. Every page is sent with `script-src 'self'; connect-src 'self';
frame-ancestors 'none'`, `nosniff` and `no-referrer`, and has no inline script (the board's details
ride a JSON data block; `EXCALIDRAW_ASSET_PATH` is set by the bundle's first module).

**The UI.** One Share dialog (🔒 YAZ-1799 D6, the Google Docs model) behind File › Share Link
(⌘⇧L) and the sidebar's right-click Share: General access *Not shared* / *Anyone with the link*,
and *View and download* (default) / *View only* on the same link. Shared boards wear a small link
mark in the sidebar, red when the last update failed or the link is stale (🔒 YAZ-1799 D14).

**The demo.** `tools/fakeCloudflare.mjs` fakes just the Cloudflare endpoints setup calls (with
Cloudflare's real error codes, and magic tokens listed on its `/__fake/token-page`) and serves the
real Worker over a disk bucket; `tools/seedShareDemoVault.mjs` seeds a vault of one board per
scenario, an isolated profile and start/stop scripts. The app follows it only through two env vars,
`YASEEN_DRAW_CLOUDFLARE_API` and `YASEEN_DRAW_SHARE_ORIGIN`, which `shareEndpoints` honours ONLY in
an unpackaged (dev) build — a shipped app always sends the real token to the real Cloudflare.
`desktop/src/main/share/fakeCloudflare.integration.test.ts` runs the scenarios against it.

## Multi-window

`desktop/src/main/windows.ts` owns the lifecycle; `main/index.ts` is its Electron-only half.

- Every window is one `WindowEntry`; the renderer learns which one it is from `?win=<id>` in its
  URL and asks `window.identity()`.
- ⌘⇧N duplicates the focused window — same folder, same file, same tabs, cascaded bounds — and
  the copy then diverges.
- Windows and their tabs are restored on relaunch; bounds are clamped to a live display, so a
  window from a disconnected monitor comes back on screen.
- Closing runs the flush handshake: main holds the window open, pushes `app:flush`, and waits for
  `app:flushed` (5s cap) so an in-flight autosave lands before the process lets go. ⌘Q does the
  same for every window, then writes the state file. SIGTERM and SIGINT (a logout, `kill`, ⌃C in a
  terminal) are the same quit: Electron turns them into `app.quit()` (`e2e/autosave.spec.ts` pins it).
- One running instance. A second launch focuses the first; a `yaseendraw://` URL in its argv
  routes instead of focusing.

## Links

`yaseendraw://` is path-only, absolute and percent-encoded:
`yaseendraw:///Users/me/vault/Board.excalidraw`, with an optional `?root=` (also a percent-encoded
absolute path) naming the vault the link should open under. `shared/links.ts` owns the one
encoding, so main's parser and the renderer's generator cannot drift; `#` and `?` are encoded on
top of `encodeURI` because either would truncate the path on parse. A Windows drive path rides the
link the way `file:///C:/…` does — `C:\Vault\Board.excalidraw` ⇄ `yaseendraw:///C:/Vault/Board.excalidraw`
— and parses back to its native `\` form, so an Explorer double-click routes like a Finder one
(YAZ-2073 2D). Path containment everywhere ("is this inside that vault or folder") goes through
`shared/paths.ts` `isWithin`, which compares by whole segment in the base path's own separator.

Main routes a link to the best window — one already on that vault, else the focused one, else a
new one — and the renderer then treats it exactly like a sidebar click (activate the tab if the
file is already open, else open it in the current tab). A link that cannot be opened shows the
window's one passive notice; never a dialog. macOS delivers links through `open-url`, which fires
before `ready` on a cold start, so they queue (`main/linkQueue.ts`) until the windows exist.

The packaged app registers the scheme (`protocols` in `desktop/package.json`) and claims
`.excalidraw` as an Owner file association (🔒 YAZ-1775 D1).

**Opening a drawing from outside the app** — a Finder double-click, `open -a "Yaseen Draw"
Board.excalidraw`, or a plain `open Board.excalidraw` once the association is registered — travels
the deep-link pipeline rather than a path of its own. The OS delivers it differently per platform
and main converts each into the same `yaseendraw://` push:

| Platform | How the path arrives | Where it is read |
|---|---|---|
| macOS | the `open-file` event (before `ready` on a cold start) | `app.on('open-file')` → `fileLink` → the link queue |
| Windows / Linux, app not running | this process's own `process.argv` | `openableFileArgs(process.argv)` after `restoreAll()` |
| Windows / Linux, app running | the `second-instance` argv | `openableFileArgs(argv)` in that handler |

`main/fileArgs.ts` is the one filter: an argument counts only when it is not a switch, is not a
URL, and names a file of a kind this app owns.

From there the routing rule is the ordinary link rule, and it decides **which window and which
tab**: the open window whose root contains the file (most specific root wins) activates the tab if
that file is already open and otherwise opens it in the current tab; failing that, a new window on
the most recent remembered vault that contains the file; and failing that — a drawing outside every
open and every remembered vault — **a new window with the file's PARENT FOLDER as the vault**. An
unsupported or missing file shows the window's one passive notice, never a dialog.

## draw.io diagrams (YAZ-1802)

A `.drawio` opens in jgraph's own draw.io webapp, pinned to release `v31.5.2` (🔒 D5), unmodified
but for two config hooks, inside an iframe on its OWN origin.

- **🔒 D4 — the origin is the sandbox.** Main serves the webapp on the `drawio` host of the existing
  `app` scheme (`app://drawio/…`, `serveDrawio` in `desktop/src/main/drawio/assets.ts`), routed by
  host, path traversal a 404, every answer — a 404 included — carrying `DRAWIO_CSP`: nothing leaves
  the origin (no fetch, no remote image, no CDN font). Dev adds `Cache-Control: no-store` so a
  re-pack applies on the next diagram open (🔒 D17); a packaged app caches normally. Our user agent
  never contains ` draw.io/`, so draw.io's own Electron mode (drawio-desktop's code) never loads.
  The renderer and the iframe talk by postMessage ONLY, in draw.io's `proto=json` dialect, and a
  message counts only from that iframe's window and `app://drawio` (`drawioProtocol.ts` documents
  the conversation). The iframe URL shuts every network door
  (`offline`, `stealth`, `lockdown`, no plugins / PWA / cloud storage) and pins `lang=en`, the one
  language the pruned pack carries (D5).
- **🔒 D3 — plain XML.** The configure reply sets `compressXml: false`; a compressed file opens and
  is written plain on its first edit. Opening and not editing writes nothing.
- **🔒 D6 — two doors.** `diagram:load` validates the outline first (a draw.io root, closed at the
  end; comments after it are fine), so a broken file is an error pane and draw.io is never mounted
  on it — it cannot autosave over what it failed to read — and `diagram:save` refuses anything that
  is not a whole diagram (`BAD_REQUEST`) before touching the disk. The
  host reuses `lib/autosave.ts` (500 ms), the watcher rule (echo / reload when clean / Reload–Keep
  mine when dirty), the quit flush, the tab-close flush, rename continuity and `noteBoardSaved`
  exactly as `DrawingEditor` does.
- **🔒 D17 — the handshake.** Our `PostConfig.js` posts `{ event: 'yaseenReady' }` once its patches
  and fonts are in; the host answers draw.io's `configure` only after that (a 3 s fallback, so a
  missing overlay costs the keymap, never the document), then `init` → `load` with `autosave: 1`,
  and draw.io's `load` answer is the clean baseline. The Saved / Synced chips sit in a slim strip
  above the iframe. A theme flip is draw.io's `darkMode` / `lightMode` action, sent once draw.io
  listens (a flip before its `init` goes at `init`); the iframe is never reloaded for it.
- **🔒 D7 — dates.** `yaseendraw-created` / `yaseendraw-updated` on the root `<mxfile>` ("Board
  metadata" above); `fs:tree` reads them off the head, so sort and Info work.
- **🔒 D8 — sync keeps both.** `.git/info/attributes` carries the case-proof `.drawio` `-merge` rule
  ("Two computers, one vault"), and a diagram changed on both machines keeps both copies —
  `<name> (conflict, <date>).drawio`, the extension as the file spelled it.
- **🔒 D9 — one renderer** for every picture of a diagram outside its editor: draw.io's own viewer
  on our page `app://drawio/yaseen-render.html` in one hidden iframe (`renderDiagram.ts`). Page 1
  (compressed or not) is drawn by `getSvg` with the diagram's fonts and images inside it; a PNG is
  that same SVG on a canvas. The hover preview (same bounds, theme and cache as a drawing's),
  Version history's pictures and File › Export Image… all go through it — Export draws the XML
  draw.io last posted (unsaved edits too) light, in its own colours, as a PNG (2×) and an SVG, and
  `dialog:save-image` writes the one the user picks. A page that never starts is thrown away so
  the next picture retries; a picture that never comes back fails after 15 s.
- **🔒 D10 — history.** Version history lists a diagram's versions and draws each through D9;
  Restore goes through `diagram:save`'s write. No change marks in v1 (Future, with cell-level merge).
- **🔒 D16 — dark-mode colours.** `SettingsState.diagramDarkColors` (Settings › Appearance) is
  draw.io's `defaultAdaptiveColors` — `adapt` → `auto`, `keep` → `none` — in the configure reply,
  and live afterwards by our `{ action: 'yaseenAdaptiveColors' }` message, which `PostConfig.js`
  answers (draw.io has no embed action for it): it moves the default and re-draws, never edits the
  file, so nothing autosaves and undo is untouched. A file whose `<mxGraphModel>` says
  `adaptiveColors="none"` keeps its colours whatever the setting. The D9 renderer honours the same
  setting, so previews and history pictures match the editor.
- **🔒 D12a — feel**, in the configure reply (`drawioConfig`) and `PostConfig.js`: page view off
  on open (`pv=0`), grid and alignment guides off for new diagrams (both stay per-diagram
  toggles: the right-click Grid item, View › Guides), 2 px lines with 8 px corners in Assistant, the fonts (Assistant, Inter,
  Roboto, IBM Plex Mono, Liberation Serif) from `yaseen-fonts/` on the drawio origin, Excalidraw's
  picks and open-colour palette in the colour dialog; plain wheel pans, ⌘/ctrl-wheel and pinch
  zoom; the shapes panel starts collapsed; Grid on the empty-canvas right-click menu; a corner drag
  on text scales its font. "Text" means LOOKS like text: draw.io's text style, or a childless,
  labelled vertex with no fill and no border (how AI-written titles are spelled).
- **🔒 D12b — keys.** With nothing selected, draw.io's own bindings from the configure reply: `R`
  rectangle, `O` ellipse, `T` text, `A` / `D` / `L` arrow, `W` / `P` / `X` freehand, `S` and `F`
  cleared, ⌘\ clear formatting. With a selection, `PostConfig.js`: the Excalidraw fork's colour
  letters (`t b w d r p a v u c e g y o n`) — a shape's fill in the light shade (open-colour index
  1, a no-fill shape included), a text's font colour, a line's or freehand stroke's stroke and an
  image's border in the dark shade (index 4); ⇧ + letter strokes a shape and gives text its
  background (light shade); `1`…`0` set a text's font size (12…128) or anything else's long side
  (48…1024, aspect and centre kept); ⌘⇧X strikethrough. Locked cells are left alone. A colour
  letter no longer starts typing into a selected label (Enter / F2 do). Settings › Hotkeys'
  "draw.io diagram" table lists them; `tools/drawioOverlay.test.mjs` runs `PostConfig.js` against a
  stand-in draw.io and checks every action name against the pinned bundle.
- **Not yet:** Present and merging diagrams are Future (🔒 D1).

## Packaging

`npm run desktop:build` runs `electron-vite build` and then electron-builder through
`tools/packDesktop.mjs`, which stamps the ROOT `package.json` version (`0.1.0`) into the bundle —
`desktop/package.json`'s own version is never what ships.

- appId `com.yasinarshad.yaseendraw`, productName **Yaseen Draw**, icon from `desktop/build/`
  (one 1024² `icon.png`; electron-builder derives `Contents/Resources/icon.icns`).
- macOS: arm64 `dmg` + `dir`, `identity: null` — ad-hoc signed by `desktop/build/adhocSign.cjs`,
  never Developer-ID signed or notarized (out of scope). The dmg is lzma-compressed (ULMO, macOS
  10.15+): electron-builder's own zlib image is converted by `packDesktop.mjs --mac`
  (`tools/lib/dmg.mjs`, YAZ-2073 3A), which mounts the new image and verifies the app's seal before
  replacing the old one, and drops the `.blockmap` (nothing reads it — no auto-update). `codesign -dv` on the packed bundle reads
  `Signature=adhoc` with `TeamIdentifier=not set`; `spctl -a -t install` therefore REJECTS it, and
  that rejection is the expected result, not a defect — it is what the one-time **Open Anyway**
  below answers.
- The bundle declares what it owns: `CFBundleURLSchemes` `yaseendraw`, a `.excalidraw` document
  type named "Excalidraw Drawing" and a `.drawio` one named "draw.io Diagram" (🔒 YAZ-1802 D14),
  both with role `Editor` and `LSHandlerRank` `Owner`, so Finder hands both to this app (🔒 YAZ-1775 D1).
- Windows: unsigned x64 NSIS installer.
- `files: ["out/**"]` is the whole app payload: the main bundle carries its dependencies (chokidar is
  pure JS and gets bundled), so the packaged app ships no `node_modules`. That holds because
  `desktop/package.json` has no `dependencies` (electron-builder packs those; chokidar is a
  devDependency) and `externalizeDeps` is off for main and preload; `tools/mainBundle.test.mjs`
  builds both and fails on any `require` but Node built-ins and electron (YAZ-2073 3E). The one `extraResources`
  entry is the share viewer's built assets (`share/dist/assets` → `Contents/Resources/share-viewer`,
  YAZ-1883), which main uploads at share setup; `viewerAssetsDir` in `ipc/share.ts` reads there when
  packaged and from the repo checkout in dev. It carries no fonts: setup publishes the renderer's
  copy (`excalidrawFontsDir`, YAZ-2073 3C).
- The renderer is minified (esbuild, as Vite ships it) with `sourcemap: 'hidden'`; the build moves
  every `.map` to the gitignored `desktop/.maps/<version>/` (`renderSourcemapsAside()` in
  `electron.vite.config.ts`, 🔒 YAZ-2073 D14), so none ships and a minified stack trace from that
  version can still be symbolicated on the machine that built it.
- The renderer serves from the custom `app://yaseen/` protocol, registered with `codeCache` (and
  `app://drawio/` with it: `appScheme.ts`, 🔒 YAZ-2073 D13), so V8 keeps compiled code in
  `<userData>/Code Cache` across launches — ~15 MB once draw.io has opened, Chromium's own LRU —
  instead of recompiling every script on every launch. Excalidraw's fonts are copied
  beside the bundle at build time so a scene with text never reaches a CDN (🔒 the offline rule).
  The draw.io webapp (~47 MB, 2 660 files) is copied from the pack cache into `out/drawio` the same
  way (`drawioAssets()` in `electron.vite.config.ts`, replaced whole on every build) and served as
  `app://drawio/` (🔒 YAZ-1802 D5). It is PRUNED to what the editor, the picture page and the share
  viewer load (YAZ-1973: a deny list with reasons in `tools/lib/drawioPack.mjs`, the request set
  pinned in `packDrawio.test.mjs`; the stamp re-unpacks when a rule changes) — no other languages
  (the frame URL pins `lang=en`), no cloud/integration code, no dev sources, and no `stencils/` or
  `shapes/` files, which `js/stencils.min.js` / `js/shapes-14-6-5.min.js` carry. Dev logs every
  `app://drawio` 404 (`serveDrawio` `onNotFound`) — the check after a bump. The share viewer's
  draw.io files are read from this copy at share setup, so the app carries them once. It ships
  unmodified under Apache-2.0: the war carries no licence file of its own, so the overlay adds
  `LICENSE-drawio.txt` (jgraph/drawio's `LICENSE` at the pinned tag) at its root, and no `LICENSE`
  anywhere in the war is ever pruned (`stencils/`, `shapes/`, `templates/`, `img/`,
  `js/libavoid-js/`).
- Size (v0.1.11, YAZ-2073): the `.app` is ~351 MB and the dmg ~125 MB (from ~370 MB / ~172 MB;
  v0.1.8's YAZ-1973 prune had taken them from ~528 MB / ~208 MB). `npm run perf:budget` measures a
  build against the ceilings in `tools/perf/budget.json`; 🔒 the ratchet (YAZ-2073 D17): a change that
  shrinks a metric lowers its ceiling in the same PR, and raising one needs Yasin's OK.
- `.github/workflows/release.yml` builds both on a `v*` tag (node 22, `CSC_IDENTITY_AUTO_DISCOVERY:
  false`, `fail_on_unmatched_files: true`) and attaches them to that tag's release.
- 🔒 **Releases are Yasin's call.** No tag, no GitHub release and no `npm version` without him
  saying so — he batches releases. The workflow is verified by a local `npm run desktop:build`,
  never by pushing a tag to see what happens.

Bumping the vendored engine is `node tools/packEngine.mjs --commit <sha>` followed by `npm ci` —
see `client/vendor/README.md` for the two traps that script exists to defuse.

## Out of scope (locked)

No browser mode — the app runs only inside Electron. No path jail in the file layer. No
Developer-ID signing or notarization, no auto-update, no Intel or universal builds. No end-to-end
suite in CI (the Playwright suite is local — ⚡ YAZ-2073 D17, "Scripts" above).
