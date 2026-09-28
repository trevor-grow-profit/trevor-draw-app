# Yaseen Draw — the regression pass

Two layers guard against feature loss (🔒 YAZ-2073 D17):

1. **`npm run e2e`** — the Playwright suite in `e2e/`. It builds the app, then launches the BUILT
   app (`desktop/out`) once or more per test on a throwaway profile and sandboxed vaults, and drives
   it through the UI, the application menu and the `window.yaseenDraw` bridge. It covers the
   behaviour of every group below; the last column of each table says how far.
2. **This list, by hand** — the part automation cannot see: the packaged `.app`, the OS itself
   (Finder, LaunchServices, native sheets, the real clipboard of another app, Trash), how things
   LOOK (fonts, colours, dark mode, flashes), a real browser opening a share link, and Windows.

Every scenario has a **stable ID** — cite it, never renumber. **★ = core**: every PR that touches
the bundle, the shell, packaging or startup runs the ★ set (≈ 12 min) plus the sections it touched
(the full list ≈ 45 min), and says so in its body, e.g. `H-list ★ + D, W passed on 0.1.12 build`.
Add a scenario when a bug escapes both layers; mark it ★ only if it guards a silent failure.

**The coverage tag** (last column everywhere): `A: spec` = an e2e spec (file name without
`.spec.ts`) exercises the behaviour; `A (part): spec — rest` = it covers some of it and the rest is
by hand; `M` = hand only. Only the e2e suite counts as A here — unit tests are listed in the
[feature-safety-net](../thoughts/yaz-2073-scope/research/feature-safety-net.md) inventory, not in this file.

**Setup.** Run the PACKAGED app (`npm run desktop:build`, then
`desktop/dist-app/mac-arm64/Yaseen Draw.app/Contents/MacOS/Yaseen Draw`) with
`YASEEN_DRAW_USER_DATA_DIR=<scratch profile>` against seeded vaults under a scratch folder — the
`LAUNCH.md` › Verify recipe. Never Yasin's real profile or vault. Seeds: `tools/seedDemoVault.mjs`
(stress vault), `seedDrawioDemoVault.mjs`, `seedMergeDemoVault.mjs`, `seedPreviewDemoVault.mjs`,
`seedShareDemoVault.mjs` + `fakeCloudflare.mjs`, `seedSortDemoVault.mjs`, `seedStorageDemoVault.mjs`,
`seedLaserDemoVault.mjs`.

## PR checklist (YAZ-2073 children)

Paste into the PR body and tick each line:

- [ ] `npm test` ✓
- [ ] `npm run typecheck` ✓
- [ ] `npm run perf:budget` ✓ — numbers pasted; ceiling lowered when a number dropped
- [ ] `npm run e2e` ✓ — test count + wall time pasted
- [ ] REGRESSION ★ + touched sections ✓ — IDs cited, e.g. `★ + D, W passed on 0.1.12 build`

## Core (★)

| ID | Scenario | Why by hand | E2E (A) / hand only (M) |
|---|---|---|---|
| ★C1 | Cold launch restores every window, its tabs and bounds; with no vault, one Welcome window with recents. | the packaged binary and real window chrome | A: `launch` |
| ★C2 | Open a text-heavy board: Excalifont, Virgil and Assistant render (not a system font); DevTools › Network shows no request that is not `app:` / `data:` / `blob:`. | glyph shapes | A: `launch` (fonts load from `app://`, zero network) |
| ★C3 | Paste a screenshot from the macOS clipboard (⌘⌃⇧4 then ⌘V): it appears; `assets/` gains ONE file; the board JSON stays small; relaunch shows it. | a real screenshot from another app | A: `images` |
| ★C4 | Paste the same image twice → still one asset. Drag a PNG in from Finder → one asset. | a real Finder drag | A: `images` (the drop is synthesized) |
| ★C5 | Export Image… ⌘⇧E → save a PNG and an SVG; the SVG opens in Safari with the hand-drawn font (the subset worker ran). | the engine's own save, Safari | A (part): `canvas`, `engine` — the dialog opens and the SVG carries the subset font; a drawing's PNG save by hand |
| ★C6 | Export Excalidraw Drawing… ⌘⇧S → the file opens on excalidraw.com with its pictures. | excalidraw.com | A: `canvas` (standalone file, pictures embedded) |
| ★C7 | Engine tools that ship as lazy chunks: laser pointer (K), Mermaid / text-to-diagram renders a flowchart, frame tool, eraser, lasso, command palette (⌘/), element link, stats. | how they look and feel | A (part): `canvas`, `engine` — laser, Mermaid, frame, eraser, element link, stats; lasso and command palette by hand |
| ★C8 | Open a `.drawio`: shapes panel closed, `R` then drag draws a rectangle, a colour letter colours the selection, ⌘-scroll zooms, an edit shows Saved, relaunch keeps it, the file is plain XML. | the Excalidraw keymap overlay, zoom feel | A (part): `drawio` — R + drag, Saved, ⌘Q keeps it, plain XML; colour letters and ⌘-scroll by hand |
| ★C9 | Hover a drawing and a diagram in the sidebar, in light and dark → the right picture in both themes. | the picture itself | A: `sidebar` (pictures load, both themes) |
| ★C10 | Theme System → Dark → Light, live in two windows; a dark launch has no white flash. | colours, flash | A: `settings` (live in every window; dark window background on relaunch) |
| ★C11 | Edit the file from outside (another editor, `echo >> file`): a clean tab reloads; a tab with unsaved edits shows Reload / Keep mine. | an outside editor | A: `autosave`, `windows` |
| ★C12 | ⌘Q in the middle of an edit, relaunch: the last stroke is on disk, the tabs and window are as left, and a synced vault's origin has the commit. | the real ⌘Q | A (part): `autosave`, `drawio` — the last stroke lands, the tab in front is kept and the edit is pushed; the window's bounds and the relaunch by hand |
| ★O1 | App NOT running: double-click a `.excalidraw` in Finder → it opens in the right window and tab. | LaunchServices, cold `open-file` | A (part): `links` — a cold start with the path in argv; the cold `open-file` event by hand |
| ★O2 | Same as O1 for a `.drawio`. | LaunchServices | A (part): `links` — `open-file` into a running app; cold by hand |
| O3 | App running: double-click a board in Finder → it opens in the window on its vault (or a new one). | LaunchServices | A: `links` (the event, not the OS) |
| O4 | `open 'yaseendraw:///<abs path>'` from Terminal routes to the board; a bad link shows a notice, never a dialog. Beware: LaunchServices may pick `/Applications/Yaseen Draw.app` — for a candidate build, `lsregister -f` it or test the installed copy. | the OS URL handler | A: `links` (the event, not the OS) |

## Documents and sidebar (D)

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| D1 | Create each of the five kinds from the right-click menu (name first; Escape leaves nothing; a taken name is refused in place). | A: `boards` |
| D2 | Rename (the kind is kept), move by drag, delete → it is in the macOS Trash (confirm on; off skips the dialog). | A: `boards` (Trash is a stand-in) |
| D3 | Cut / copy / paste across two vault windows (`copy 2` naming). | A (part): `boards` — one window; across two vault windows by hand |
| D4 | ⌘K search, ⌘⏎ opens a background tab, right-click a result. | A (part): `sidebar` — right-click a result by hand |
| D5 | Sort by Last updated after a save; the Info popover. | A (part): `sidebar` — sorts seeded dates; the re-sort after a live save by hand |
| D6 | Focus on two folders, then the eye. | A (part): `sidebar` — one folder; two by hand |
| D7 | Favorites: add, drag-reorder, a rename follows. | A (part): `sidebar` — drag-reorder by hand |
| D8 | Sidebar collapse, resize, drag past the edge to collapse. | A (part): `sidebar` — drag past the edge to collapse by hand |
| D9 | A non-board file opens in its default macOS app. | A: `boards` (the hand-off is recorded, not run) |
| D10 | Corrupt and empty boards show a readable error; the 40-image and ~10 MB boards of `seedDemoVault` open and scroll smoothly. | A (part): `autosave`, `demovaults` — errors and opening; smooth scrolling by hand |
| D11 | Unicode and deeply nested paths: open, rename, move. | A (part): `boards` — a unicode rename; deep-path move by hand |

## Windows and vaults (W)

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| W1 | ⌘⇧N duplicates the window. | A: `windows` (menu, not the key) |
| W2 | Open in ▸ New window. | A: `windows` |
| W3 | One board in two windows: a save reloads the clean one; the dirty one shows the bar. | A (part): `windows`, `autosave`, `boardDocument` — the bar is raised by an outside write; from the second window by hand |
| W4 | ⌘O switcher: filter, ⏎ opens beside, ⇧⏎ in place, the held-⇧ "Open here" cue, the ⓘ full path on hover. | A (part): `vaults` — the ⓘ and the held-⇧ cue by hand |
| W5 | Every vault-menu item, including Reveal in Finder and Open in VS Code. | A (part): `vaults` — Set / Reset display name, Remove; Open in this window, Copy name / path, Reveal, VS Code by hand |
| W6 | Open Folder… opens beside, never replaces a vault. | A: `vaults` |
| W7 | A window left on an unplugged monitor comes back on screen. | A: `windows` (a far-off saved position) |
| W8 | Menu items enable by the front tab's kind; app zoom ⌘+ / ⌘− / ⌘0 with the real keys. | A (part): `drawio`, `canvas` — menu clicked from main; the real keys by hand |

## Canvas panel (P)

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| P1 | Images: Iconify search + insert, Pixabay with a key, offline → Shapes still work, favorites and recent. | A (part): `canvas` — Shapes offline only (no network in the suite); the rest by hand |
| P2 | Components: save, insert in ANOTHER vault, rename, delete, Import JSON. | A (part): `canvas` — save, insert in another board, rename, delete; another vault and Import JSON by hand |
| P3 | Present: reorder by drag and ⌥↑/↓, play, → ← Space Home End, Esc zooms out, ⇧T. | A (part): `canvas` — reorder by button, play, → Home; drag, ⌥↑/↓, ← Space End, Esc, ⇧T by hand |
| P4 | The panel remembers (YAZ-1990): search Images, scroll, close (click the canvas, Esc, hamburger) → reopen by hamburger and by ⌘F — same query (selected on ⌘F), results, view and scroll; each Images view keeps its own scroll; another drawing tab shows the same; Components keeps its query, rows and scroll; an app restart starts empty. | M — unit: `ImageStudio`, `imageStudioSession`, `SavedComponents` |

## Sync and history (S) — `seedMergeDemoVault.mjs`

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| S1 | First sync merges every case, shows the notice, See changes opens Version history. | A: `history` |
| S2 | An idle pull shows the other machine's change within 60 s. | M (the 60 s timer) |
| S3 | A file over 95 MiB is held back: banner, chip, red cloud. | A (part): `sync` — chip and tree mark; the banner by hand |
| S4 | Version history of a drawing (change marks) and a diagram (as it was); Restore. | A (part): `history` — drawing Restore, diagram as it was; change marks by hand |
| S5 | Settings › Storage bar; Move pictures out while the window stays responsive. | A (part): `sync`, `launch` — the bar and the move; responsiveness by hand |
| S6 | No git installed → the setup prompt. | M |

## Share links (K) — `seedShareDemoVault.mjs` + `fakeCloudflare.mjs`

The Cloudflare endpoint overrides work only unpackaged: run K on `npm run dev` against the fake,
and ONCE on a packaged build against real Cloudflare before a release. (`share` is skipped on a
packaged e2e run for the same reason.)

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| K1 | Setup walks every step. | A: `share` (fake Cloudflare) |
| K2 | Share a drawing and a diagram; open each link in Safari AND Firefox. | A (part): `share` — served, not rendered; both browsers by hand |
| K3 | The viewer: download .excalidraw / PNG allowed; View only → 403. | A (part): `share` — `/raw` 200 then 403; the viewer's Download buttons by hand |
| K4 | A live update lands about 10 s after an edit. | A: `share` |
| K5 | A diagram with a stencil and a math label renders in the viewer. | M (a browser) |
| K6 | Rename keeps the link; delete stops it. | M |
| K7 | Delete all. | M |

## Settings (T)

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| T1 | Each of the 14 canvas preferences applies across boards and windows and survives relaunch (the laser's own 3 are 1989-19). | A (part): `settings`, `canvas` — Grid, Writing mode, Show frames; the other 11 and the relaunch by hand |
| T2 | Change the Library folder (native picker). | A (part): `settings` — the default only; the picker by hand |
| T3 | Pixabay key set / clear. | A: `settings` |
| T4 | draw.io dark colours adapt / keep, live. | A: `settings` |
| T5 | Settings search. | A: `settings` |

## Distribution (R)

| ID | Scenario | E2E (A) / hand only (M) |
|---|---|---|
| R1 | The dmg mounts; drag-install; first open needs Open Anyway; `codesign -dv` says `Signature=adhoc`. | M |
| R2 | `npm run desktop:build:win` produces the installer; install and smoke it on a Windows machine before a release. | M (CI's `windows.yml` builds the installer on a pull request; installing it is by hand) |
| R3 | On a macOS account set to another language (e.g. Deutsch), **Open folder…** shows a German Open panel and the app menu's system items are German; the app's own UI, Chromium's strings and the sidebar's Name sort are English (Chromium ships English only — 🔒 YAZ-2073 D3). | M |

## Feature inventory coverage

Every line of [feature-safety-net](../thoughts/yaz-2073-scope/research/feature-safety-net.md) §2 (the YAZ-2073 inventory), in its 12 groups. **F-IDs are stable**;
"By hand" names the H-list rows above (or an imported row below) that walk the rest.

### Documents & disk

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F1 | `.excalidraw` open / edit / debounced atomic save | A: `autosave` | — |
| F2 | Images in `assets/<sha1>`; legacy embedded images extracted on first save | A: `images` | ★C3 ★C4 |
| F3 | Orphan-asset sweep (24 h guard, to Trash) | A: `images` | — |
| F4 | `.drawio` plain-XML load / save, dates on `<mxfile>` | A: `drawio` | ★C8 |
| F5 | One kind classifier (case-insensitive; `x.drawio.svg` has no kind) | A: `boards`, `demovaults` | — |
| F6 | Board metadata block (dates as the first key) | A: `autosave`, `boards` | — |
| F7 | Non-board files listed, opened in the OS default app | A: `boards` (hand-off recorded) | D9 |
| F8 | Outside edit: reload when clean, Reload / Keep mine when dirty | A: `autosave`, `drawio`, `windows`, `boardDocument` | ★C11 |
| F9 | Fit-to-content on open (10–100 %) | A: `launch` | — |
| F10 | Saved / Synced chips | A: `drawio`, `sync`, `settings` | — |
| F11 | Flush-on-close / flush-on-quit handshake (5 s cap) | A: `autosave`, `drawio`, `windows`, `boardDocument` | ★C12 |

### Excalidraw canvas

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F12 | Engine mount, one full toolbar, never the tablet form factor | A (part): `canvas`, `engine` — it mounts and works; toolbar layout by hand | 1775-12 |
| F13 | Engine tools as lazy chunks (shapes … Mermaid, SVG subset, image resize) | A (part): `canvas`, `engine` — rectangle, laser, Mermaid, eraser, frame, stats, link, SVG subset | ★C7; the laser's modes, bar and undo: 1989-1…25 |
| F14 | Paste / drop an OS-clipboard image → one asset, small JSON | A: `images`, `launch` (secure context) | ★C3 ★C4 |
| F15 | 14 canvas prefs (+ the laser's 3, 1989-19), global and live across windows | A (part): `settings`, `canvas` — 3 of 14 | T1 |
| F16 | Canvas background (View menu) | A: `canvas` — the colour is saved (YAZ-2073 2E); panning and zooming never write | — |
| F17 | Export Image… ⌘⇧E (engine PNG / SVG dialog) | A (part): `canvas`, `engine` — dialog + SVG; drawing PNG by hand | ★C5 |
| F18 | Export Excalidraw Drawing… ⌘⇧S, images embedded | A: `canvas` | ★C6 |
| F19 | Excalidraw fonts served offline from `app://` | A: `launch` | ★C2 |
| F20 | One engine per mounted tab; focus handoff on reveal | A (part): `tabs` — a hidden tab keeps its engine; focus handoff untested | — |

### Canvas panel (hamburger)

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F21 | Images tab: Iconify / Pixabay, shapes, favorites, recent, insert | A (part): `canvas` — Shapes offline | P1 |
| F22 | Components tab: save, insert, rename, delete, Import JSON, shared Library | A (part): `canvas` — Import JSON, cross-vault by hand | P2 |
| F23 | Present tab: frames as slides, reorder, rename, player, keys | A (part): `canvas` — slide rename, drag, most keys by hand | P3 |
| F87 | Canvas panel keeps its state across close/reopen (Images and Components) | M | P4 |

### draw.io diagrams

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F24 | Editor iframe on `app://drawio`, CSP, offline / lockdown, handshake | A: `drawio` | ★C8 |
| F25 | Overlay: page view off, ⌘-wheel zoom, Excalidraw keymap, text scaling | A (part): `drawio` — R + drag only | ★C8 |
| F26 | Pruned draw.io pack (deny list, pinned request set) | A (part): `drawio`, `demovaults` — loads offline, nothing reached; pack contents unit-only | — |
| F27 | One renderer for pictures (hover, history, Export Image) | A: `sidebar`, `history`, `canvas` | ★C9 S4 |
| F28 | Dark-mode adapt / keep colours, live | A: `settings` | T4 |
| F29 | Diagram badge in tree and tab | A (part): `drawio` — the tab's badge; the tree row's by hand | — |

### Sidebar

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F30 | Files lens (`assets/` hidden) + Favorites lens | A: `sidebar` | — |
| F31 | Create five kinds, name-first inline box | A: `boards` | D1 |
| F32 | Rename (kind kept), drag move, delete to Trash + confirm setting | A: `boards`, `settings` (Trash is a stand-in) | D2 |
| F33 | App-wide file clipboard across windows / vaults, "copy N" | A (part): `boards` — one window | D3 |
| F34 | ⇧-click multi-select, Copy path(s), Open N in tabs | A: `sidebar` | — |
| F35 | Right-click menu, Open in ▸ window / VS Code / default / Finder | A: `boards`, `windows` (OS hand-offs recorded) | D9 W5 |
| F36 | ⌘K search, ⌘⏎ background tab, right-click a result | A (part): `sidebar` — right-click a result | D4, 2056-S40…S47 |
| F37 | Sort (name / updated / created, per vault) + Info popover | A: `sidebar` | D5 |
| F38 | Hover preview (400 ms dwell, cache 32, theme-keyed, toggle) | A (part): `sidebar`, `demovaults` — the cache bound and the picture by hand | ★C9, 1800-* |
| F39 | Focus on folder(s) with the eye toggle, persisted | A (part): `sidebar` — one folder, no persistence | D6 |
| F40 | Favorites in the vault, drag-reorder, follow rename / delete, sync | A (part): `sidebar` — add, lens, rename; reorder by hand | D7 |
| F41 | Collapse, resize 180–520 px, drag to collapse, ⌘B | A (part): `sidebar` — drag to collapse by hand | D8 |
| F42 | Folders start collapsed; expand-all / collapse-all | A: `sidebar` | — |
| F43 | Share mark (red on failure), red cloud for a too-large file | A (part): `share`, `sync` — the red failure mark untested | S3 |

### Tabs, windows, vaults

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F44 | Tabs, per-tab history, tab keys, ⌘W, tab menu (Copy path) | A (part): `tabs` — via the Window menu; ⌃Tab / ⌘⇧] [ keys untested | — |
| F45 | Multiple windows: duplicate, restore with bounds, clamp to display | A (part): `windows`, `launch` — ⌘⇧W untested | ★C1 W1 W7 |
| F46 | Vault switcher ⌘O (filter, ⓘ path, ⇧⏎, held-⇧ cue, dead rows) | A (part): `vaults` — ⓘ and cue by hand | W4, 2056-S24…S36 |
| F47 | Vault menu (open here, display name, copy, reveal, VS Code, remove) | A (part): `vaults` — display name, remove | W5, 1941-* |
| F48 | Open folder never replaces a vault | A: `vaults` | W6, 1913-* |
| F49 | Welcome screen with recents | A: `launch` | ★C1 |
| F50 | Window title = vault display name + board | A: `launch`, `vaults` | — |
| F51 | URL hash `#/abs/path` | A: `launch` | — |

### Menus & keys

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F52 | App menu: stable ids, enablement by kind, fallback target window | A (part): `drawio` + every spec's menu clicks; fallback target untested | W8 |
| F53 | App zoom ⌘+ / ⌘− / ⌘0 | A (part): `canvas` — the menu items, not the keys | W8 |
| F54 | Spellcheck context menu (replace / add to dictionary) | M | — |
| F55 | Settings › Hotkeys single source | A (part): `settings` — the page renders its tables | — |

### Links & OS integration

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F56 | `yaseendraw://` links: route, notice on failure, cold-start queue | A (part): `links` — the event in-process; OS registration by hand | O4 |
| F57 | Finder double-click / Open With, cold + warm, parent-folder vault | A (part): `links` — routing only; Finder / LaunchServices by hand | ★O1 ★O2 O3 |
| F58 | Single instance; a second launch hands over its argv | A: `links` | — |
| F59 | Window-open policy (web links go to the browser) | A: `links` | — |
| F60 | Theme-matched window background (no white flash) | A (part): `settings` — the colour; the flash by hand | ★C10 |

### Sync, merge, history, storage

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F61 | Commit → fetch → rebase → push; idle, focus, wake and quit pulls / pushes | A (part): `sync`, `history`, `autosave` — sync now, first sync, the quit push; idle / focus / wake by hand | S2 ★C12 |
| F62 | Shape-by-shape board merge; keep-both for diagrams and others | A: `history`, `demovaults` | S1 |
| F63 | Too-large (≥ 95 MiB) held back: banner, chip, red cloud | A (part): `sync` — banner by hand | S3 |
| F64 | Git discovery at fixed paths; setup prompt when missing | M | S6 |
| F65 | Merge notice + See changes | A: `history` | S1 |
| F66 | Version history (pictures, change marks, as-it-was) + Restore | A (part): `history` — change marks by hand | S4 |
| F67 | Settings › Storage on the worker thread; Move pictures out | A: `launch`, `sync` (the real electron-vite worker) | S5 |

### Share links

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F68 | Setup from one pasted token, account, subdomain, progress steps | A: `share` (fake Cloudflare) | K1 |
| F69 | Share dialog (Not shared / Anyone; View only), ⌘⇧L + right-click | A (part): `share` — right-click and the menu item; the ⌘⇧L key by hand | — |
| F70 | Always-live re-upload (10 s settle); rename / delete follow | A (part): `share` — rename / delete follow by hand | K4 K6 |
| F71 | Custom domain, Forget key, Delete all | M | K7 |
| F72 | Worker routes (PUT / DELETE, `/b` `/scene` `/raw`, CSP) | A: `share` (the same `worker.js` behind the fake) | K3 |
| F73 | Share viewer web bundle rendering in a browser | M | K2 K5 |
| F74 | Sharing page in Settings | A: `share` | — |

### Settings & state

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F75 | Settings dialog: sections, search, ⌘, | A: `settings` | T5 |
| F76 | Theme System / Light / Dark, live | A: `settings` | ★C10 |
| F77 | Library folder choose / reset | A (part): `settings` — the default only | T2 |
| F78 | Pixabay key write-only, `secrets.json` 0600 | A: `settings` | T3 |
| F79 | One tolerant state file; corrupt → `.corrupt-<epoch>`; profile override | A: `launch`, `autosave` | — |
| F80 | Per-vault `.yaseendraw/` (favorites, github, shares) | A: `sidebar`, `settings`, `share` | — |

### Packaging / distribution

| ID | Feature | Coverage | By hand |
|---|---|---|---|
| F81 | macOS arm64 dmg, ad-hoc deep seal | M | R1 |
| F82 | Windows x64 NSIS, unsigned | M (built by CI's `windows.yml` on a pull request) | R2 |
| F83 | Release workflow on a tag | M (`windows.yml` runs its Windows build on a pull request) | R1 R2 |
| F84 | Privileged `app://` scheme (standard, secure, fetch) | A: `launch` | — |
| F85 | Demo seed scripts and `packEngine` keep working | A (part): `demovaults`, `history` — four seeds; the rest unit-only | — |
| F86 | English-only Chromium locale paks; the app's 55 `.lproj` markers kept | A (part): `tools/afterPack.test.mjs`; `npm run perf:budget` fails a bundle without Chromium's `en.lproj` or the app's non-English `.lproj` markers | R3 |

## Imported issue lists

The scenario lists the earlier issues were proven with, kept with their own IDs (prefixed with the
issue) so a change that touches that area can re-walk them. Same tag as above.

### YAZ-1775 — the approved demo (2026-09-21)

The "Scenarios proven in the demo" line has no IDs; numbered here in its order.

| ID | Scenario | Coverage |
|---|---|---|
| 1775-1 | Orphan sweep: the old orphan goes to Trash, the fresh one stays. | A: `images` |
| 1775-2 | An outside edit on disk reloads a clean tab. | A: `autosave` |
| 1775-3 | Paste → one asset, small JSON, still there after relaunch. | A: `images` (the relaunch on a dropped picture) |
| 1775-4 | The same image twice → one asset. | A: `images` |
| 1775-5 | A legacy board with embedded images shrinks on its first save. | A: `images` |
| 1775-6 | A missing asset → placeholder, no crash. | A: `images`, `demovaults` |
| 1775-7 | Corrupt and empty files → a readable error. | A: `autosave` |
| 1775-8 | The 40-image and 10 MB boards open. | A: `demovaults` |
| 1775-9 | Unicode and nested paths: rename and move. | A (part): `boards` — nested move by hand (D11) |
| 1775-10 | Two windows on one board: reload when clean, the bar when dirty. | A (part): `windows`, `autosave`, `boardDocument` (W3) |
| 1775-11 | The Grid pref applies across boards and windows and survives relaunch. | A (part): `settings` — relaunch by hand (T1) |
| 1775-12 | R / O / W / T show the horizontal toolbar with key hints beside the sidebar. | A (part): `canvas` — R only; the toolbar's look by hand |
| 1775-13 | The Favorites tab. | A: `sidebar` |
| 1775-14 | The vault switcher. | A: `vaults` |
| 1775-15 | The sync chip against a bare origin. | A: `sync` |

### YAZ-1800 — hover preview (`seedPreviewDemoVault.mjs`)

| ID | Scenario | Coverage |
|---|---|---|
| 1800-1 | Rest on a board: the panel opens after about 0.4 s beside the sidebar. | A: `sidebar` |
| 1800-2 | A fast sweep down the list opens nothing. | M |
| 1800-3 | Wide, tall and tiny-far-away drawings fit whole. | M |
| 1800-4 | A 3000-element board: the second hover is instant. | M |
| 1800-5 | Images show; a missing asset leaves the rest intact. | A (part): `demovaults` — pictures; the missing asset by hand |
| 1800-6 | Empty and only-deleted boards say "Empty board". | A: `sidebar`, `demovaults` |
| 1800-7 | Corrupt, zero-byte, no-elements and locked boards say "Preview unavailable". | A (part): `demovaults` — corrupt and unreadable |
| 1800-8 | Non-boards get no preview; the native tooltip stays. | M |
| 1800-9 | Long and unicode names truncate cleanly in the header. | M |
| 1800-10 | A nested board's header shows its parent path. | M |
| 1800-11 | Header button and Settings toggle turn previews off and stay in step. | A: `sidebar`, `settings` |
| 1800-12 | ↑ / ↓ through the tree previews each board paused on. | M |
| 1800-13 | Escape closes only the preview. | M |
| 1800-14 | Click, right-click or drag closes it. | M |
| 1800-15 | Draw and save, hover again: the new drawing (swaps in place mid-hover). | M |
| 1800-16 | Rename or delete while shown: closes; the renamed board previews under its new name. | M |
| 1800-17 | Switching to Dark redraws the preview dark. | A (part): `sidebar` — dark at launch; the live switch by hand |
| 1800-18 | Resizing the window or the sidebar re-fits the panel. | M |
| 1800-19 | Scan 40 boards and back: 01 redraws (the cache holds 32). | M |
| 1800-20 | Previews work in the Favorites tab too. | M |

### YAZ-1802 — draw.io support

The 4A / 4B pass lists are not in the export — see the issue. Below is the decision record's
"scenarios every build must cover" list, numbered here in its order.

| ID | Scenario | Coverage |
|---|---|---|
| 1802-C1 | Create, name, and a refused rename or taken name. | A: `boards` |
| 1802-C2 | Compressed, multi-page, empty, corrupt and not-mxfile diagrams. | A (part): `drawio`, `demovaults` — empty and not-mxfile by hand |
| 1802-C3 | `.DRAWIO` and `x.drawio.svg` classify correctly. | A: `boards`, `demovaults` |
| 1802-C4 | Outside edit to a clean vs a dirty diagram. | A: `drawio`, `boardDocument` |
| 1802-C5 | One diagram in two windows. | A: `boardDocument` |
| 1802-C6 | An edit survives ⌘Q straight after it. | A: `drawio` |
| 1802-C7 | Sync keeps both copies of a diagram. | A: `demovaults` |
| 1802-C8 | Offline, and remote images blocked. | A: `drawio`, `demovaults` |
| 1802-C9 | Embedded images show. | A (part): `demovaults` — it opens without an error; that the picture shows by hand |
| 1802-C10 | A 2000-cell diagram stays fast. | A (part): `demovaults` — it opens; speed by hand |
| 1802-C11 | Unicode paths. | M |
| 1802-C12 | Theme and the dark-colour setting apply live. | A: `settings` |
| 1802-C13 | Hover preview of a diagram. | A: `sidebar` |
| 1802-C14 | Version history of a diagram, and Restore. | A (part): `history` — as it was; Restore by hand |
| 1802-C15 | A share link views and downloads the diagram. | A (part): `share` — served, not rendered (K2) |
| 1802-C16 | An AI-written diagram round-trips byte-stable apart from our date attributes. | A (part): `drawio` — clean never rewritten; the edit round-trip by hand |
| 1802-C17 | Excalidraw boards are unaffected. | A: every spec |

### YAZ-1913 — Open folder… opens beside

S10 is left out: the issue marks it impossible (the app quits with its last window).

| ID | Scenario | Coverage |
|---|---|---|
| 1913-S1 | Switcher Open folder… on a vault window → new window on B; A untouched. | A (part): `vaults` — via File › Open Folder…; the switcher row by hand |
| 1913-S2 | Same via File › Open Folder… (⌘⇧O). | A: `vaults` (menu, not the key) |
| 1913-S3 | Picking a vault open in another window raises that window; nothing new opens. | M |
| 1913-S4 | Picking this window's own vault raises it; its tabs are not reset. | M |
| 1913-S5 | Cancelling the folder dialog changes nothing. | M |
| 1913-S6 | Welcome's Open folder… button fills that window in place. | A: `vaults` |
| 1913-S7 | Welcome with ⌘⇧O fills in place. | A (part): `vaults` — the button; the key by hand |
| 1913-S8 | File › Open Recent on a vault window opens beside or raises. | A: `vaults` |
| 1913-S9 | File › Open Recent on Welcome fills in place. | A: `vaults` |
| 1913-S11 | ⌥-click on Open Recent behaves like a plain click. | M |
| 1913-S12 | A gone folder is pruned from recents and nothing opens. | A (part): `vaults`, `launch` — switcher and Welcome rows; Open Recent by hand |
| 1913-S13 | A path differing only by a trailing slash counts as already open. | M |
| 1913-S14 | A subfolder of the current vault opens as a new vault window. | M |
| 1913-S15 | ⌘⇧O again while the dialog is up does nothing. | M |
| 1913-S16 | A window whose vault vanished (now Welcome) fills in place. | M |
| 1913-S17 | Welcome picking a vault open elsewhere fills in place (two windows). | M |

### YAZ-1941 — right-click menu on vaults

| ID | Scenario | Coverage |
|---|---|---|
| 1941-S1 | Right-click the header vault name: copy / reveal groups, no native menu, panel stays closed. | A (part): `vaults` — the menu opens; its items by hand |
| 1941-S2 | The current vault's switcher row shows the same items. | M |
| 1941-S3 | Another vault's row: Open in this window, copy, reveal, Remove, with hairlines. | A (part): `vaults` — Remove used; the layout by hand |
| 1941-S4 | A "Folder not found" row opens no menu. | M |
| 1941-S5 | Copy vault name on an emoji-named vault pastes it exactly; notice shown. | M |
| 1941-S6 | Copy path gives the full absolute path; notice shown. | M |
| 1941-S7 | Reveal in Finder and Open in VS Code open that folder. | M |
| 1941-S8 | Reveal on a vault deleted meanwhile → an error notice, no hang. | M |
| 1941-S9 | Open in this window switches in place; ⌘O shows it as current. | A (part): `vaults` — via ⇧⏎; the menu item by hand |
| 1941-S10 | After an in-place switch the sidebar shows its normal default lens. | A: `vaults` |
| 1941-S11 | Open in this window on a vault open elsewhere → two windows show it. | M |
| 1941-S12 | A gone vault's row greys "Folder not found"; the panel stays; reopened it is gone. | A (part): `vaults` — the grey row; the reopen by hand |
| 1941-S13 | Remove drops the row at once; the panel stays; the folder stays on disk. | A (part): `vaults` — the state file; the row, the panel and the folder by hand |
| 1941-S14 | Open Recent and the other window's panel drop it; Open folder… brings it back on top. | A (part): `vaults` — the state file; the rest by hand |
| 1941-S15 | Esc closes the menu first, then the panel. | M |
| 1941-S16 | A click outside closes only the menu. | M |
| 1941-S17 | With the menu open, ↑ / ↓ / ⏎ do nothing to the panel. | M |
| 1941-S18 | Copy path closes the menu; the panel stays open. | M |
| 1941-S19 | Right-clicking another row closes the menu; the highlight never jumps. | M |
| 1941-S20 | Settings › Hotkeys › Mouse lists "Right-click vault". | M |

### YAZ-1999 — name-first boards and the dated drawing

| ID | Scenario | Coverage |
|---|---|---|
| 1999-S1 | Folder row › New Excalidraw drawing → box in that folder; Enter creates and opens it. | A (part): `boards` — blank space; the folder row by hand |
| 1999-S2 | On a file row the box appears in its parent folder. | M |
| 1999-S3 | On blank space the box appears at the vault root. | A: `boards` |
| 1999-S4 | New draw.io diagram → `Flow.drawio` opens in the draw.io editor. | A: `boards` |
| 1999-S5 | Enter on an empty box does nothing. | M |
| 1999-S6 | Escape closes the box; nothing is written. | A: `boards` |
| 1999-S7 | Clicking away cancels like Escape. | M |
| 1999-S8 | A taken name is refused under the box; the text stays; nothing overwritten. | A: `boards` |
| 1999-S9 | Invalid names (`a/b`, `.x`) show their reason; the box stays. | M |
| 1999-S10 | Typing the extension yourself never doubles it. | M |
| 1999-S11 | No menu item ever creates an `Untitled` file. | A: `boards` |
| 1999-S12 | The Create group's five items, in order, on file, folder and blank. | M |
| 1999-S13 | New dated Excalidraw drawing seeds `MM_DD- `; Enter creates `MM_DD- Plan`. | A: `boards` |
| 1999-S14 | Enter on the untouched seed does nothing. | A: `boards` |
| 1999-S15 | Replacing the seed gives a plain name. | M |
| 1999-S16 | Rename still selects the whole name. | M |
| 1999-S17 | New folder and New dated folder work as before. | A: `boards` |
| 1999-S18 | In Favorites, creating in a hidden folder switches to Files first. | M |

### YAZ-2056 — vault viewer and other ports from Docs

| ID | Scenario | Coverage |
|---|---|---|
| 2056-S1 | A switcher row's menu lists Open here ⇧⏎, Set display name, copy, reveal, Remove. | M |
| 2056-S2 | Set display name on a row: field in place; ⏎ renames; panel and filter focus stay. | M |
| 2056-S3 | After a rename the menu also offers Reset to folder name. | A (part): `vaults` — on the header |
| 2056-S4 | Rename from the header: header and window title update. | A: `vaults` |
| 2056-S5 | Esc in the field drops the edit and closes only the field. | M |
| 2056-S6 | Clicking elsewhere in the panel saves the name. | M |
| 2056-S7 | Clearing the field and ⏎ returns the folder name. | M |
| 2056-S8 | Typing exactly the folder name stores no custom name. | M |
| 2056-S9 | Names are trimmed and cut to 80 characters. | M |
| 2056-S10 | Reset to folder name restores it everywhere. | A: `vaults` |
| 2056-S11 | An emoji name shows in row, header, title, Welcome and Sharing. | M |
| 2056-S12 | While the field is open, keys go to it, not the filter or highlight. | M |
| 2056-S13 | A second window on the vault updates its header and title live. | M |
| 2056-S14 | Copy vault name gives the display name; Copy path the path. | M |
| 2056-S15 | Welcome lists the display name, its time and the path. | M |
| 2056-S16 | File › Open Recent still lists full paths. | M |
| 2056-S17 | Reveal on a renamed vault whose folder is gone names the folder. | M |
| 2056-S18 | Settings › Sharing with nothing shared uses the display name. | M |
| 2056-S19 | Names survive quit and relaunch. | A (part): `vaults` — stored in the state file; the relaunch by hand |
| 2056-S20 | Remove, then reopen via Open folder…: the name comes back. | M |
| 2056-S21 | The filter matches display and folder names, listing the vault once. | M |
| 2056-S22 | An un-renamed vault filters as before. | A: `vaults` |
| 2056-S23 | Empty query keeps MRU order; ⌘O ⏎ jumps to the last other vault. | M |
| 2056-S24 | At rest every row is one line; no path shows. | M |
| 2056-S25 | Hovering a row shows only its ⓘ; the row does not shift. | M |
| 2056-S26 | Hovering the ⓘ shows the whole path, wrapped at slashes. | M |
| 2056-S27 | The last row's ⓘ tooltip, and after scrolling, is not clipped. | M |
| 2056-S28 | The two `Notes` vaults are told apart by their ⓘ. | M |
| 2056-S29 | Clicking the ⓘ acts like clicking the row. | M |
| 2056-S30 | A greyed gone vault's ⓘ still shows its path. | M |
| 2056-S31 | ↑ / ↓ move the highlight; no tooltip from the keyboard. | M |
| 2056-S32 | Long names show in full; the panel widens, wraps past 480 px, never "…". | M |
| 2056-S33 | The Info popover and Share menu keep their old width. | M |
| 2056-S34 | ⇧⏎ or ⇧-click switches this window in place. | A (part): `vaults` — ⇧⏎; ⇧-click by hand |
| 2056-S35 | ⇧⏎ on the current vault = ⏎; ⇧ ignored on Open folder…; dead rows inert. | A (part): `vaults` — the dead row |
| 2056-S36 | Holding ⇧ shows "Open here" on the highlighted row, also over a canvas. | M |
| 2056-S37 | The ⇧⏎ hint in the menu; the Hotkeys page mentions ⇧⏎ and Set display name. | M |
| 2056-S38 | From Favorites, switching to another vault in place lands on Files. | A (part): `vaults` — ⇧⏎; the menu item and Welcome by hand |
| 2056-S39 | Re-opening the SAME vault keeps Favorites. | M |
| 2056-S40 | Right-click a ⌘K board result: the Files row's menu; the result highlights. | M |
| 2056-S41 | Right-click a folder result: the folder menu. | M |
| 2056-S42 | Blank space or "No matches" opens nothing; the input keeps its text menu. | M |
| 2056-S43 | Rename from a result: back to Files, row revealed, flashing, box ready. | M |
| 2056-S44 | New… from a result: the name box in that folder (or beside a board). | M |
| 2056-S45 | Focus from a folder result lands focused in Files. | M |
| 2056-S46 | From Favorites, New… or Focus on a non-favorite result works in Files. | M |
| 2056-S47 | Other result actions work in place; query and results stay. | M |
| 2056-S48 | YAZ-1767 / 1941 / 1913 behaviour and ⌘K keys unchanged. | A (part): `vaults`, `sidebar` — see those lists |

### YAZ-1989 — laser pointer (`seedLaserDemoVault.mjs`)

The 🔒 FINAL scenario list on YAZ-1989; the vault's `00 READ ME` board repeats it. Rows 1–16 and
23 are also proven in the fork by `packages/excalidraw/tests/laserTrailModes.test.tsx` (jsdom);
17–22, 24 and 25 are hand-only. All are M here because only the e2e suite counts as A in this
file, and the laser has no e2e run (Yasin's rule for YAZ-1989: no Playwright).

| ID | Scenario | Coverage |
|---|---|---|
| 1989-1 | Fade: a short comet, gone in about 2 s. | M |
| 1989-2 | Hold: three strokes with short pauses all stay; about 5 s after the last one they fade together. | M |
| 1989-3 | Hold: one long scribble stays whole — no tail eaten. | M |
| 1989-4 | Sticky: stays until cleared. | M |
| 1989-5 | Red, then yellow: the red marks stay red; S / M / L mix the same way. | M |
| 1989-6 | Fade + ↵ right after drawing: the mark sticks (Keep). | M |
| 1989-7 | Hold + the bar's Keep within 5 s: it sticks. | M |
| 1989-8 | Clear → gone; ⌘Z → back; ⇧⌘Z → gone again. | M |
| 1989-9 | Esc with marks: gone and the tool is V; K, ⌘Z → back. | M |
| 1989-10 | V (or any tool) with sticky marks: they stay; shapes under them still click. | M |
| 1989-11 | Fade / Hold marks, then V: they still fade. | M |
| 1989-12 | Clear → V → K → ↶: back. | M |
| 1989-13 | Move a shape, K, ⌘Z: only the laser marks undo; on V, ⌘Z undoes the shape. | M |
| 1989-14 | The footer ↶ ↷ and the bar ↶ ↷ do exactly what ⌘Z / ⇧⌘Z do while the laser is out. | M |
| 1989-15 | ⇧↵ / Make permanent: grouped, selected pen strokes in the same colours and on-screen thickness, draggable; one ⌘Z on V removes them; laser ⌘Z does not bring the marks back. | M |
| 1989-16 | Sticky marks, then pan and zoom: pinned to the drawing, same thickness on screen. | M |
| 1989-17 | Marks belong to the open tab: sticky marks on 01 stay while 01's tab stays open (switch to another tab and back — still there); open 08 in that tab or close it, and they are gone with their laser history. | M |
| 1989-18 | Laser marks never make a board unsaved; reopen → no marks; the board JSON has no `laser*` keys. | M |
| 1989-19 | Sticky + blue + L, ⌘Q, relaunch: still Sticky / blue / L, on every board. | M |
| 1989-20 | Presentation: play 05, press K and mark (the bar hides in view mode; the settings still apply). | M |
| 1989-21 | The laser over the linked box in 03 still opens the link. | M |
| 1989-22 | Dark theme and 04: every swatch reads clearly; the bar looks native in light and dark. | M |
| 1989-23 | Sticky marks left alone: no constant CPU in Activity Monitor (the render loop idles). | M |
| 1989-24 | 10 (400 shapes): marking stays smooth. | M |
| 1989-25 | With the laser out, ⌘Z / ⇧⌘Z / ↵ / Esc reach the engine (the Edit menu never takes them); Edit › Undo clicked in the menu bar behaves as it does for the board. | M |
