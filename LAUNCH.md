# LAUNCH — how to run this app (for humans and agents)

Yaseen Draw: a local whiteboard for a folder of boards — `.excalidraw` drawings and `.drawio`
diagrams — as an Electron macOS desktop app: React renderer around the vendored Excalidraw fork and
a bundled draw.io, main-process file layer. See
`README.md` for the human overview and `docs/CONTRACTS.md` for the bridge, state and packaging
contracts.

## Dev loop (do this when asked to "run it")

```bash
npm install
npm run dev
```

- `npm run dev` runs `electron-vite dev` in `desktop/`: it builds main + preload, serves the renderer with HMR and launches the Electron app — one command, and every remembered window reopens. There is no server of any kind and nothing listens for the app itself on any port (the only network socket is electron-vite's private HMR channel in dev); renderer ↔ main is the typed `window.yaseenDraw` bridge.
- draw.io (YAZ-1802): desktop's `dev` and `build` first run `tools/packDrawio.mjs`, which downloads the pinned draw.io webapp ONCE (54 MB, sha256-checked — network needed that one time) into `desktop/.cache/drawio/` and lays `desktop/drawio-overlay/` over it on every run. Run `npm run drawio:pack` yourself before a bare `npx electron-vite dev`; an overlay edit applies the next time a diagram opens (dev serves `app://drawio` with `no-store`).
- Yasin's vault is `$HOME/Documents/GitHub/yaseen-draw-vault` — a git repo the app's GitHub sync pushes to (the username part of `$HOME` differs per machine — resolve it, don't hardcode). The app repo itself is `yaseen-draw-app`; the vault is `yaseen-draw-vault`. If a window opens the wrong folder, click the vault name in the sidebar header (or ⌘O) and choose **Open folder…** — the vault opens in its own window (YAZ-1913), so close the wrong one — or run `window.yaseenDraw.window.setIdentity({ root: '<abs path>', file: null })` from the devtools console and reload.
- Folder picking is the native open-directory dialog (`window.yaseenDraw.pickFolder()`), which pops up on Yasin's screen; in an agent session seed `<user-data-dir>/yaseendraw.json` with a `windows[]` entry (`{ id, root, file, tabs, sidebarCollapsed, sidebarLens, focusDirs, focusFavorites, bounds }`) before launch, or call `window.yaseenDraw.window.setIdentity({ root, file: null })` and reload, instead of using the vault switcher's **Open folder…**.

## Build + install

```bash
npm run desktop:build
```

- Builds `desktop/out` (electron-vite) and then packages with electron-builder: `desktop/dist-app/mac-arm64/Yaseen Draw.app` (~351 MB, ~47 MB of it the bundled draw.io webapp, pruned to what the app loads — YAZ-1973) and `desktop/dist-app/Yaseen Draw-0.1.0-arm64.dmg` (~125 MB, lzma — `tools/packDesktop.mjs` converts electron-builder's zlib image, mounts it and checks the app's seal; YAZ-2073 3A) — arm64 only, and the version in the dmg name is the ROOT `package.json` version that `tools/packDesktop.mjs` stamps in. The filenames contain spaces, so quote every path.
- The renderer ships minified; its hidden sourcemaps land in the gitignored `desktop/.maps/<version>/`, never in the app (🔒 YAZ-2073 D14) — keep that folder for a release whose stack traces you may need to read. A stack frame such as `app://yaseen/assets/index-CUvbLYUM.js:23:53960` maps back with `source-map-js` (installed with Vite; it counts columns from 0, a stack from 1):

```bash
node -e "const {SourceMapConsumer}=require('source-map-js'); const m=new SourceMapConsumer(require('./desktop/.maps/0.1.11/assets/index-CUvbLYUM.js.map')); console.log(m.originalPositionFor({ line: 23, column: 53959 }))"
# → { source: '../../../../client/src/main.tsx', line: 26, column: 41, … }
```
- `mac.identity: null` makes electron-builder skip signing, so `desktop/build/adhocSign.cjs` (`afterPack`) deep ad-hoc signs the bundle itself — without that seal Gatekeeper reports a downloaded copy as "damaged" instead of offering **Open Anyway**. Check it with `codesign -dv --verbose=2 "desktop/dist-app/mac-arm64/Yaseen Draw.app"`, which prints `Signature=adhoc`. `spctl -a -t install` on the same bundle prints `rejected` — expected, because nothing here is Developer-ID signed.
- The first packaging run on a clean machine needs network: electron-builder downloads its Electron dist zip and dmgbuild once, then caches them.
- Install: open the dmg and drag `Yaseen Draw.app` into `/Applications` in Finder (or copy it straight from `desktop/dist-app/mac-arm64/`). The installed app and a `npm run dev` instance coexist — different userData, different single-instance lock.
- First open is blocked by Gatekeeper (the app is not notarized): right-click › **Open**, or System Settings › Privacy & Security › **Open Anyway** — once, then never again on that Mac. See `README.md` "Installing on another Mac/PC".
- The app claims `.excalidraw` and `.drawio` as Owner, so after that first open a Finder double-click opens drawings and diagrams with it, and from a shell:

```bash
open -a "Yaseen Draw" "/path/to/some drawing.excalidraw"
```

- 🔒 Releases are Yasin's call: no tag, no GitHub release, no `npm version` unless he says so. `npm run desktop:build` is how the release path gets verified.
- Windows: `npm run desktop:build:win` packages an unsigned x64 NSIS installer, `desktop/dist-app/Yaseen Draw-<version>-win-x64-setup.exe` (electron-builder can produce it from a Mac too). First open shows SmartScreen — **More info › Run anyway**, once. Both scripts stamp the root `package.json` version through `tools/packDesktop.mjs`.
- No toolchain on the target machine? Download the `.dmg` (Mac, Apple Silicon) or the `-win-x64-setup.exe` (Windows) from the repo's [Releases page](https://github.com/yaseenarshad/yaseen-draw-app/releases). Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds both on GitHub runners and attaches them to that tag's release.

## App state — where it lives, how to reset it

- ONE user-global file, owned by the main process: `~/Library/Application Support/Yaseen Draw/yaseendraw.json` (settings, recents, open windows and their tabs, per-folder `lastFile` — schema in `docs/CONTRACTS.md` "App state schema"). Nothing is ever stored in the browser profile.
- TWO things do live in the vault, both by design and both the user's own data rather than app state: the favorites list at `<vault>/.yaseendraw/favorites.json` and the per-vault GitHub sync switch at `<vault>/.yaseendraw/github.json`. The dotfolder is created lazily on the first write and never otherwise; reading it creates nothing. Image bytes written by a drawing land in `<vault>/assets/`, and a board's own `createdAt` / `updatedAt` sit inside the drawing itself as its first key (🔒 YAZ-1834). Everything else about a vault stays in the state file above.
- To reset or hand-edit: **quit the app first** (⌘Q — quitting flushes the file), then delete or edit the JSON; on the next launch a missing file gets defaults and a corrupt one is moved aside as `yaseendraw.json.corrupt-<epoch>`, never silently overwritten. To find it (the folder first appears after the app has run once against the real state):

```bash
ls "$HOME/Library/Application Support/Yaseen Draw/"
```

- `YASEEN_DRAW_USER_DATA_DIR=<dir>` relocates the whole state file. This is how every check runs against a temp state without touching the real one.

## Verify

```bash
npm test          # vitest, THREE projects: client (jsdom), desktop (node), tools (node)
npm run typecheck
npm run build     # electron-vite build → desktop/out
```

- If `npm` isn't in the shell's PATH (agent shells often lack it), use its install location directly — e.g. `/opt/homebrew/bin/npm` (ARM mac), `/usr/local/bin/npm` (Intel mac), or the Volta/nvm/fnm install under `$HOME`.

### Behaviour checks: the dev app in an isolated profile

🔒 (OD1 on YAZ-1805): there is no end-to-end UI-driver suite in this repo and none is to be
added — not by an agent, not in CI. CI is typecheck + unit tests + build. Behaviour is verified by
LAUNCHING the app and using it.

The recipe, which never touches the real app state:

```bash
mkdir -p /tmp/draw-profile
# seed the profile with a window already on a scratch vault, so no native dialog is needed
cat > /tmp/draw-profile/yaseendraw.json <<'JSON'
{ "version": 1,
  "settings": { "theme": "system", "confirmDelete": true },
  "sidebarWidth": 260,
  "recents": [{ "path": "/tmp/draw-vault", "lastOpened": 0 }],
  "windows": [{ "id": "w1", "root": "/tmp/draw-vault", "file": null, "tabs": [],
                "sidebarCollapsed": false, "sidebarLens": "files",
                "focusDirs": [], "focusFavorites": [],
                "bounds": { "x": 80, "y": 80, "width": 1280, "height": 820 } }],
  "folders": {} }
JSON
cd desktop && YASEEN_DRAW_USER_DATA_DIR=/tmp/draw-profile npx electron-vite dev
```

The env var is read before the single-instance lock, so the installed app and the dev app run side
by side. Do NOT add `--watch` while agents are editing main-process files: every rebuild relaunches
the window on the user's screen. For a human GUI run with no agent editing main, `--watch` is the
right call (`seedStorageDemoVault.mjs` prints it) — without it, a main-process edit needs a manual relaunch.

The vault itself is generated — `node tools/seedDemoVault.mjs --vault <dir>` writes 63 boards plus
a content-addressed `assets/` folder covering every awkward case (missing asset, legacy embedded
dataURLs, corrupt and empty files, a 40-image board, a ~10 MB PNG, unicode and nested paths, two
orphans) and, at `<dir> (origin).git` unless `--origin` says otherwise, a bare origin for the sync
chip. `--vault` is REQUIRED and has no default, because the script WIPES what it is given; a path
that already exists is refused unless you add `--force`. It writes no profile: open the vault with
⌘O.

Two computers merging one vault (YAZ-1897): `node tools/seedMergeDemoVault.mjs --vault <dir>
--profile <profile-dir>` builds the vault, a bare origin beside it and "Sam's" clone, and leaves
conflicting edits on both sides, so the app's first sync on open merges every case and shows the
notice; its `00 READ ME` board lists what to try.

A feature's own demo vault can bring its profile: `node tools/seedPreviewDemoVault.mjs --vault <dir>
--profile <profile-dir>` (YAZ-1800, the hover preview) writes the vault AND a `yaseendraw.json`
whose one window is already on it, so the recipe above needs no hand-written JSON — launch with
`YASEEN_DRAW_USER_DATA_DIR=<profile-dir>`. Every board name says the case it covers.

draw.io support (YAZ-1802) has its own demo vault: `node tools/seedDrawioDemoVault.mjs --vault
<dir> --profile <profile-dir>`: every draw.io edge case by name, a few Excalidraw boards, and a git
origin plus "Sam's" clone so the first sync shows the keep-both copies (one `.drawio`, one
`.DRAWIO`); its `00 READ ME` lists what to try.

Then run the scenario list by hand (or by computer-use). The standing list, from the demo Yasin
approved on YAZ-1775, is: external disk edit hot-reloads a clean tab · paste → one asset, small
JSON, survives relaunch · same image twice → one asset · missing asset → placeholder, no crash ·
corrupt and empty files → readable error · 40-image and 10 MB boards open · unicode + nested paths
rename/move · two windows on one board (reload when clean, bar when dirty) · a canvas preference
applies across boards and windows and survives relaunch · favorites tab · vault switcher · sync
chip to a bare origin. Add the acceptance list of whatever issue is in flight.

The packaged app is checked the same way — launch
`desktop/dist-app/mac-arm64/Yaseen Draw.app/Contents/MacOS/Yaseen Draw` with the same env var.

## Gotchas

- Never draw in real vault files during testing — copy the vault to a scratch dir first.
- The vault is on NFS: saves can take 0.3–4 s and chokidar may double-fire. Echo suppression is by mtime (`Autosave.settled()`). This applies to the packaged app exactly as to dev — same main-process fs, same libuv.
- The main process has no path jail (owner's choice): any absolute path the user can read or write, the app can too.
- Linear project: https://linear.app/growprofit/issue/YAZ-1775 — the port's decision record.
