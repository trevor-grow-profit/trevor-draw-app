# Yaseen Draw

> Seeded from yaseen-docs-app @ 66c9806

Yaseen Draw — a local whiteboard for a folder of boards (Excalidraw drawings and draw.io
diagrams), as an Electron macOS desktop app: a React renderer around a vendored
[Excalidraw](https://excalidraw.com) fork and a bundled, offline draw.io, and a main process
that reads and writes the files on this machine (the renderer only ever talks to the
`window.yaseenDraw` bridge — there is no server of any kind, except the optional share Worker on
your own Cloudflare account). Pick a folder, browse its
`.excalidraw` and `.drawio` files in the sidebar, draw, and changes are saved back to disk (debounced, atomic).
Files changed outside the app (another editor, sync) are reloaded live; if you have unsaved edits
you get a Reload / Keep mine choice. Lineage in one line: the shell follows Obsidian, the
transport mechanism follows VS Code (sandboxed renderer + typed preload bridge + main-process fs),
and the canvas is Yasin's own Excalidraw fork.

## Requirements

Node.js 22 or newer (`package.json` `engines`, and what CI runs), npm, macOS (the packaged app targets macOS arm64; the dev build runs wherever Electron does).

## Run

```sh
npm install
npm run dev      # launches the Electron app with HMR
```

The first `npm run dev` or `npm run build` downloads the pinned draw.io webapp once (54 MB,
sha256-checked) into `desktop/.cache/drawio/`; after that no network is needed.

See `LAUNCH.md` for the full launch recipe (state file, isolated profiles, packaged-app install)
and `docs/CONTRACTS.md` for the bridge, app-state and packaging contracts.

```sh
npm test         # unit tests (vitest, three projects: client jsdom, desktop node, tools node)
npm run typecheck
npm run build    # electron-vite build into desktop/out + the share viewer into share/dist
```

## Build the app

```sh
npm run desktop:build
```

produces `desktop/dist-app/mac-arm64/Yaseen Draw.app` and `desktop/dist-app/Yaseen Draw-<version>-arm64.dmg` (arm64, ad-hoc signed). Drag the `.app` into `/Applications`, or send someone the dmg.

The app bundles jgraph's draw.io webapp ([jgraph/drawio](https://github.com/jgraph/drawio), Apache-2.0) unmodified, with its licence as `LICENSE-drawio.txt` in the app's `drawio/` folder. Yaseen Draw is not affiliated with draw.io; it opens `.drawio` files.

## Installing on another Mac/PC

Every packaged version is downloadable from the repo's [Releases page](https://github.com/yaseenarshad/yaseen-draw-app/releases) — the `.dmg` for a Mac (Apple Silicon), the `-win-x64-setup.exe` for Windows — no build toolchain needed on the installing machine.

The Mac app is ad-hoc signed, not notarized, so on someone else's Mac (macOS 15) the first open is blocked with "Apple could not verify…". Once: open **System Settings › Privacy & Security**, scroll to the blocked-app notice, click **Open Anyway**, and confirm. After that it opens normally. The Windows installer is unsigned, so SmartScreen shows "Windows protected your PC" the first time: click **More info › Run anyway**, once.

## Share links

Right-click a board › **Share**, or **File › Share Link** (`⌘⇧L`), and turn on *Anyone with the
link*: the board gets one link anyone can open in a browser — no account, no app, no editing.
Pick *View and download* (the default) or *View only*; the link stays the same either way. The
link is **always live**: every save updates it about ten seconds after you stop drawing. A rename
inside the app keeps the link; deleting the board stops it. Shared boards wear a small link mark
in the sidebar, red when the last update failed.

The link is served from **your own free Cloudflare account** — one storage bucket and one small
Worker, which **Settings › Sharing** sets up from one pasted API key (Open Cloudflare opens the
token page with every permission pre-filled). Nothing goes through anyone else's server, and it
costs $0 on Cloudflare's free tier (Cloudflare asks for a card on file before it turns R2 on). The
same page lists the vault's shared boards, attaches your own domain, and turns sharing off. The
contract is in `docs/CONTRACTS.md` › Share links.

A shared draw.io diagram opens in draw.io's own read-only viewer (zoom, pan, pages) and downloads
as its `.drawio` file; there is no PNG download for a diagram. If you set up sharing before
diagrams could be shared, run **Settings › Sharing › Set up sharing** once more: it updates your
Worker, and every existing link keeps working.

## Sync

Turn on **Settings › Sync** to push a vault to GitHub. It uses the computer's own git, found at a fixed set of locations rather than on `PATH` (`desktop/src/main/git/exec.ts`): on a Mac the Command Line Tools or Homebrew git, on Windows [Git for Windows](https://git-scm.com/download/win) (its installer bundles the Git Credential Manager, so a one-time GitHub sign-in sticks). Without one, the sync banner says so and offers a setup prompt to paste into an LLM. The switch lives per vault, in `<vault>/.yaseendraw/github.json`.

Two computers can work on one vault. When both changed the same Excalidraw drawing, sync merges it
shape by shape: everyone's shapes are kept, and if you both changed the same shape, the newest edit
wins. A draw.io diagram, and any other file, changed on both keeps both copies (yours as
`<name> (conflict, <date>)`). A small
notice says what was merged, with **See changes**. Nothing needs a person to untangle it. The app
also checks GitHub every minute while a vault is open, so the other computer's changes show up on
their own.

Right-click a board › **Version history** to see every version as a picture: for a drawing, the
board now, with what changed since that version marked in green (added), amber (changed) and faded
red (removed); for a diagram, the version as it was. **Restore** puts any version back.

## Excalidraw drawings

A drawing is one `.excalidraw` file — Excalidraw's own scene JSON, readable by excalidraw.com and
by any other tool that speaks the format. The app never invents a wrapper around it.

A drawing opens zoomed out to show everything on it (never past 100%, down to 10% for a huge board),
so you start from the overview and zoom into the part you want. An empty drawing opens at 100%.

Image bytes are kept OUT of the scene: a pasted or dropped image is written once to
`<vault>/assets/<contentId>.<ext>` and the scene refers to it, so a board full of screenshots stays
a small JSON file that git can actually diff and GitHub will actually accept. The same image used
twice is stored once.

Saving is debounced and atomic (tmp file + rename), the mtime you read is the mtime a write must
match, and a file that changed underneath an unsaved buffer raises the conflict bar instead of
silently losing either side.

## draw.io diagrams

A diagram is one `.drawio` file — draw.io's own XML, always saved plain (uncompressed) so an AI
agent, git and a person can all read it. It opens in the real draw.io, bundled with the app and
fully offline, and saves, reloads and syncs exactly like a drawing. Excalidraw is the whiteboard;
draw.io is for clean, screenshot-ready diagrams.

draw.io is set up to feel like the Excalidraw canvas: an endless canvas (no page), the shapes panel
closed, 2 px lines with 8 px corners in Assistant, plain scroll pans and `⌘`-scroll or a pinch
zooms, and dragging a text box by its corner scales the text. Excalidraw's keys work too — with
nothing selected `R` / `O` / `T` / `A` / `W` pick a tool; with a selection the colour letters
(`R` red, `U` blue, `G` green…) colour it, `⇧` + a letter colours the outline, and `1`…`0` size
it. Settings › Hotkeys has the full table.

A diagram is marked with a small linked-boxes glyph in the sidebar and on its tab (an Excalidraw
board is unmarked). Hover it for a preview, right-click › **Version history** to see and restore
older versions, and **File › Export Image…** (`⌘⇧E`) saves its first page, unsaved edits included, as a PNG or an SVG.
In dark mode draw.io re-colours diagrams so they stay readable; **Settings › Appearance › draw.io
diagrams in dark mode** can keep their original colours instead, and a diagram that asks to keep
its own colours (`adaptiveColors="none"`) always does. Present is Excalidraw-only for now.

## Sidebar and windows

- **Two lenses**: the sidebar shows your vault two ways, switched by the tabs at the top. **Files** is the ordinary folder tree on disk — every file, not just the drawings: a file the app cannot open is listed muted and a click hands it to the OS default app, as does right-click → Open in ▸ "Default app" on any row. The **♥** tab is your favorites (below). Same vault, two readings; both offer the same right-click menu. Switching the window to another vault opens it on Files; the same vault keeps its tab.
- **Create**: right-click a folder, a file, or the blank space under the tree → "New Excalidraw drawing" / "New draw.io diagram" / "New folder" / "New dated folder" (a folder pre-named with today's `MM_DD- `, cursor ready for the title); name it inline (Enter confirms, Esc cancels). A drawing gets `.excalidraw` and a diagram `.drawio` automatically, and either opens at once; nothing is ever overwritten.
- **Rename and delete**: both are in the same right-click menu, in both lenses. Renaming edits the name inline and commits on Enter; deleting moves the file to the system Trash — never a permanent delete — and closes its tabs.
- **Cut, copy, paste**: right-click a row (or a selection) → **Cut** / **Copy**, then right-click a folder → **Paste** (`⌘X` / `⌘C` / `⌘V` do the same on the selected rows; `⌘V` pastes into the selected folder, beside the selected file, or into the vault root when nothing is selected). One clipboard for the whole app, so you can copy in one window and paste into another vault's window. A copy that lands on an existing name becomes "Board copy.excalidraw", then "Board copy 2.excalidraw" — pasting into the same folder is how you duplicate; a cut never overwrites, moves tabs along like drag-drop, and pastes once. Folders copy whole. The menu itself is five groups: open, clipboard, new, this row, favorites + **Open in ▸** (new window, VS Code, default app, Finder), delete.
- **Search**: `⌘K` searches file and folder names across the vault from the sidebar; ↑/↓ pick, Enter opens, ⌘-Enter opens in a background tab. Right-click a result for the same menu its row has in the tree.
- **Tabs and windows**: drawings open in tabs (`⌃Tab` / `⌃⇧Tab` or `⌘⇧]` / `⌘⇧[` to switch, `⌘W` closes the **tab** — on the last one it empties the window and then closes it). `⌘⇧N` duplicates the window (same folder, same file), `⌘O` opens the vault switcher in the sidebar header (type to filter, `⏎` brings that vault to the front or opens it in a new window, `⇧⏎` or ⇧-click opens it in this window; hover a vault's ⓘ to see its full path; right-click a vault — or the header's vault name — to open it in this window, give it a display name, copy its name or path, reveal it in Finder, open it in VS Code, or remove it from the recents), `⌘⇧O` opens a folder, `⌘⇧W` closes the window; File › Open Recent lists the last folders. Opening a folder never replaces the vault you are in (only "Open in this window" — the right-click item, or `⇧⏎` in the switcher — does, on purpose): it opens in its own window, or brings that vault's window to the front (only the empty Welcome screen fills itself). ⌘-click a sidebar file — or right-click → Open in ▸ "New window" — to open it in its own window. Open windows and their tabs are restored on relaunch.
- **Links**: a `yaseendraw://` URL opens that exact drawing from anywhere (Slack, another app). Finder opens `.excalidraw` and `.drawio` files with Yaseen Draw, and Open With lists it for both.
- **Folders start closed**: the tree opens fully collapsed on every launch, with your last tab restored. Folders you open are remembered for the session and shared by every window on the vault; quitting forgets them. Opening a drawing from search, a link or another tab still opens its folders. The double chevron beside the tabs expands or collapses everything on screen.
- **Collapse**: the panel icon in the header hides the sidebar (a floating button on the left edge brings it back); the choice survives reload. Drag the sidebar's right edge to resize it (180–520 px, remembered); drag it well past the minimum to collapse.
- **Paths**: the open file shows in the URL as `#/absolute/path.excalidraw`; right-click any row for "Copy path"; a click selects a row, shift-click adds files and folders to the selection, then right-click it for "Copy N paths".
- **Focus**: right-click a folder → "Focus on folder" and the tree shows only that — shift-select several first for "Focus on N folders". An eye appears beside the collapse button while you are focused; click it to see everything again. Each lens keeps its own focus, and it survives a restart.
- **Favorites**: right-click any file or folder → "Add to favorites" (shift-select several for "Add N to favorites"); a heart toast confirms. The **♥** tab lists them in the order you added them — drag a row up or down to reorder — and a favorited folder opens in place, so a drawing can show both on its own and inside its folder. Every row keeps the full right-click menu, including Focus, which narrows the ♥ tab on its own. Favorites live in the vault's own `.yaseendraw/favorites.json` and sync with it — turn on GitHub sync and the same list shows up on your other machine. Every window sees the same list, it survives a restart, follows renames and drops out when deleted.

## The canvas panel

The hamburger at the top-left of a drawing opens the canvas's own docked panel, three tabs wide.

- **Images** (`⌘F`): search icons and graphics from Iconify and Pixabay, insert a shape from the
  built-in catalog, or pick from Favorites and Recent. The app fetches them for you — the canvas
  never reaches a provider itself — and an inserted picture becomes an ordinary `assets/` file.
  Pixabay needs a free API key (Settings › Images); without one, Iconify and the shapes still work,
  and so does everything else while you are offline.
- **Components** (`⌘C`): save the current selection as a named, reusable component, then insert
  independent copies of it into any board, in any vault. **Import JSON** turns a `.excalidraw` file
  on disk into one. Components live in your Library folder, not in a vault, so they follow you.
- **Present**: every top-level frame on the board is a slide. Reorder them by dragging or
  `⌥↑` / `⌥↓`, rename them, and press Play for a full-pane player — `→` / `←`, `Space`,
  `Home` / `End`, `Esc` for the whole deck, and a strip of the canvas kept clear on the right for a
  camera. The order is stored in the board, so it travels with the file.

**File › Export Image…** (`⌘⇧E`) opens the engine's own PNG / SVG dialog, and **File › Export
Excalidraw Drawing…** (`⌘⇧S`) writes a standalone `.excalidraw` anywhere on disk with its images embedded —
the one file this app writes that is not lean, because it has no `assets/` folder to point at.
**View › Canvas Background** sets the board's own colour.

## Settings

The cog bottom-left, or `⌘,`. **Appearance › Theme** (System / Light / Dark — System follows the
OS live) and **draw.io diagrams in dark mode** (Adapt colours / Keep original colours). **Excalidraw canvas** holds the fourteen drawing preferences the engine used to keep to
itself — grid, snapping, binding, zen and writing modes, tool lock, frame visibility, the pen widths
and what a new element looks like — and they apply to every Excalidraw drawing, every window and
every relaunch (draw.io diagrams have fixed defaults).
**Files › Confirm before deleting** (on by default: the sheet is the only guard, because the
system Trash has no programmatic undo) and **Files › Library folder** (where components and image
favorites live — point it inside a synced vault and they sync too). **Images › Pixabay API key**
(kept in the app's own data folder, readable only by your user; never shown again). **Sync** for
this vault's GitHub switch. **Storage** (its own page) shows this vault's git history on a bar that
ends at GitHub's 10 GB maximum (marked at 1 GB and 5 GB), lists any file close to or over GitHub's
100 MB limit, and offers **Move pictures out** for older boards that still carry their pictures
inside; it measures only while Settings is open. A file near GitHub's 100 MB limit (sync draws
the line a little under it, at 95 MB) is never committed: sync holds it back, says so in a banner
that stays until it is fixed, turns the sync chip red ("1 file not synced") and marks the file with
a red cloud in the sidebar — everything else keeps syncing.
**Hotkeys** lists every shortcut. Settings are global — one file, every window follows a change
live — and never written into a vault.

## Out of scope

There is no browser mode: the app runs only inside Electron. The file layer has no path jail:
anything under your user account can be read or written. There is no end-to-end UI-driver suite,
by agents or in CI — behaviour is verified by launching the app in an isolated profile (see
`LAUNCH.md`).
Distribution is deliberately minimal (locked decisions): no Developer-ID signing or notarization,
no auto-update, no Intel or universal builds.
