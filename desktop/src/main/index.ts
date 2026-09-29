import { app, BrowserWindow, Menu, nativeTheme, net, powerMonitor, protocol, screen, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DRAWIO_HOST } from '@shared/drawio'
import { fileKind } from '@shared/fileKind'
import { fileLink, parseFileLink } from '@shared/links'
import type { WindowEntry } from '@shared/types'
import { APP_SCHEME } from './appScheme'
import { resolveDrawioDir, serveDrawio } from './drawio/assets'
import type { GitSyncManager } from './git/manager'
import { registerIpc } from './ipc'
import { excalidrawFontsDir, viewerAssetsDir } from './ipc/share'
import { ensureLibraryFolder } from './library/folder'
import { openableFileArgs } from './fileArgs'
import { createLinkQueue } from './linkQueue'
import { openLink } from './fs/openLink'
import { buildContextMenuTemplate, buildMenuTemplate, createMenuHandlers, pickMenuTargetWindow, subscribeMenuRebuild, subscribeMenuRebuildOnActiveFile } from './menu'
import { runQuitSequence } from './quitSequence'
import { createStore } from './store'
import { subscribeNativeTheme, windowBackgroundColor } from './theme'
import { applyUserDataOverride } from './userData'
import { createWindowManager } from './windows'
import { createWindowOpenHandler } from './windowOpenPolicy'

// Before anything reads app.getPath('userData'): the workspace is named "desktop", the app is not.
app.setName('Trevor Draw')
applyUserDataOverride(app, process.env.YASEEN_DRAW_USER_DATA_DIR)

/** One running instance (GRO-2160): a second launch focuses the first; a link in its argv routes (E1). */
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()
app.on('second-instance', (_event, argv) => {
  // Windows/Linux deliver a clicked yaseendraw:// link as an argv entry of the second launch —
  // and a double-clicked `.excalidraw` or `.drawio` as a bare PATH in the same place (YAZ-1815): off macOS there is
  // no `open-file` event, so argv is the only door the file association has.
  const urls = [...argv.filter((arg) => arg.startsWith('yaseendraw://')), ...openableFileArgs(argv, argsSkip()).map(fileLink)]
  if (urls.length > 0) {
    for (const url of urls) links.push(url)
    return // routing focuses (or opens) the right window itself
  }
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win === undefined) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

// Deep links (E1, GRO-2171): the packaged bundle's `protocols` Info.plist entry is F1's job.
app.setAsDefaultProtocolClient('yaseendraw')

/** A parsed link routes to the best window; a bad one gets the unobtrusive notice, never a dialog. */
function handleLink(url: string): void {
  const parsed = parseFileLink(url)
  if (parsed === null) {
    manager.linkNotice(`Can't open link: ${url}`)
    return
  }
  manager.routeToFile(parsed.path, parsed.root)
}

/** macOS fires `open-url` before `ready` on cold start: queue until `restoreAll()` ran, then flush. */
const links = createLinkQueue(handleLink)
app.on('open-url', (event, url) => {
  event.preventDefault()
  links.push(url)
})

// macOS hands a double-clicked (or `open`ed, or "Open With"-ed) file to `open-file` as a plain
// absolute path — also before `ready` on a cold start. Encoding it as a yaseendraw:// link reuses
// the whole E1 pipeline (queue, parse, routing, kind/exists guards); fileLink ↔ parseFileLink is
// lossless (links.test.ts round trips). The bundle claims `.excalidraw` and `.drawio` as Owner
// associations in `desktop/package.json`, which is what makes the event fire at all (🔒 YAZ-1775 D1,
// 🔒 YAZ-1802 D14).
app.on('open-file', (event, path) => {
  event.preventDefault()
  links.push(fileLink(path))
})

/** How many leading argv entries belong to the launcher: the executable, plus the app dir in dev. */
const argsSkip = (): number => (app.isPackaged ? 1 : 2)

// Before `ready`: the privileged `app://` scheme, V8 code cache included (appScheme.ts).
protocol.registerSchemesAsPrivileged([APP_SCHEME])

const RENDERER_DIR = join(__dirname, '../renderer')

/** The draw.io webapp (🔒 YAZ-1802 D4/D5): the pack cache in dev, `out/drawio` in a build. */
const DRAWIO_DIR = resolveDrawioDir({ mainDir: __dirname, appPath: app.getAppPath(), isPackaged: app.isPackaged, exists: existsSync })

/** One user-global state file (D9, GRO-2159): `~/Library/Application Support/Trevor Draw/yaseendraw.json`. */
const store = createStore(join(app.getPath('userData'), 'yaseendraw.json'))

/** Window lifecycle (GRO-2160) lives in windows.ts; this host is its Electron-only half. */
const manager = createWindowManager(store, {
  create(entry: WindowEntry) {
    const win = new BrowserWindow({
      ...entry.bounds,
      // The backing store matches the theme (K, GRO-2218): no white flash on dark launches.
      backgroundColor: windowBackgroundColor(store.get().settings.theme, nativeTheme.shouldUseDarkColors),
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
    })
    win.webContents.setWindowOpenHandler(createWindowOpenHandler(openLink))
    // Electron ships no default context menu (YAZ-672), so the spellchecker's squiggles would
    // otherwise be unactionable; the template itself is pure and lives in menu.ts.
    win.webContents.on('context-menu', (_event, params) =>
      Menu.buildFromTemplate(buildContextMenuTemplate(params, {
        replace: (s) => win.webContents.replaceMisspelling(s),
        addToDictionary: (w) => win.webContents.session.addWordToSpellCheckerDictionary(w),
      })).popup({ window: win }))
    // `<renderer>?win=<id>` so the renderer can ask `window.identity()` who it is.
    const url = new URL(process.env.ELECTRON_RENDERER_URL ?? 'app://yaseen/index.html')
    url.searchParams.set('win', entry.id)
    void win.loadURL(url.toString())
    return win
  },
  // Primary first: clampBounds keeps the earliest work area when a window is fully off-screen.
  workAreas() {
    const primary = screen.getPrimaryDisplay()
    return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea)
  },
  exists(path) {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  // The open-recent door's probe (YAZ-1767 D1; was the menu host's until the switcher shared the path).
  dirExists(path) {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
})

/**
 * The most recently focused window's `webContents.id` — pickMenuTargetWindow's fallback key
 * (GRO-2197). Never cleared on blur: macOS reporting "no focused window" (app not frontmost)
 * is exactly the state the fallback exists for, so the last id must survive it.
 */
let lastFocusedWcId: number | undefined

/** The per-vault GitHub sync manager (YAZ-1081), created with the rest of the IPC once `ready` fires. */
let gitSync: GitSyncManager | undefined

/**
 * Set once the menu exists (🔒 YAZ-1775 D10): focusing another window changes which window a menu action
 * targets, and therefore whether the two canvas items are enabled — but nothing in the STORE
 * moved, so `subscribeMenuRebuildOnActiveFile` cannot see it. The focus hook says so directly.
 */
let rebuildMenuOnFocus: (() => void) | undefined

app.on('browser-window-focus', (_event, win) => {
  lastFocusedWcId = win.webContents.id
  rebuildMenuOnFocus?.()
  // YAZ-1081 D2: focusing a vault's window is a PULL trigger — alt-tabbing back from another
  // machine should converge without waiting out a timer. The manager's own cooldown throttles it.
  const root = store.get().windows.find((w) => w.id === manager.idFor(win.webContents))?.root ?? null
  if (root !== null) gitSync?.notifyFocus(root)
})

app.whenReady().then(() => {
  if (!isPrimaryInstance) return
  // Appearance (K, GRO-2218): the setting IS the themeSource vocabulary. Applied from the loaded
  // store BEFORE any window is created (restoreAll below), re-applied whenever it changes — so
  // `prefers-color-scheme` in every renderer and the OS chrome follow the setting.
  subscribeNativeTheme(store, (theme) => {
    nativeTheme.themeSource = theme
  })
  protocol.handle('app', (req) => {
    const { host, pathname } = new URL(req.url)
    // 🔒 YAZ-1802 D4: routed by HOST — `app://drawio` is the diagram editor's own origin.
    if (host === DRAWIO_HOST) {
      return serveDrawio(DRAWIO_DIR, pathname, {
        fetchFile: (url) => net.fetch(url),
        noStore: !app.isPackaged,
        onNotFound: app.isPackaged ? undefined : (missing) => console.warn(`[drawio] 404 app://drawio${missing} — not in the pruned pack (tools/lib/drawioPack.mjs)`),
      })
    }
    const file = join(RENDERER_DIR, pathname === '/' ? 'index.html' : pathname)
    return net.fetch(pathToFileURL(file).toString())
  })
  // Menu bar (B3, GRO-2161): the template is pure (menu.ts); only this apply layer touches Menu.
  // `focusedWebContents` resolves through pickMenuTargetWindow (GRO-2197): macOS reports no
  // focused window while the app is not frontmost, and a menu action must never silently no-op
  // — so the last-focused live window (tracked below) is the documented fallback target.
  const menuTarget = () => pickMenuTargetWindow(BrowserWindow.getFocusedWindow(), BrowserWindow.getAllWindows(), lastFocusedWcId)?.webContents
  const handlers = createMenuHandlers(store, manager, {
    focusedWebContents: menuTarget,
    zoom: (step) => {
      const wc = menuTarget()
      if (wc !== undefined) wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + 0.5 * step)
    },
    openExternal: (url) => void shell.openExternal(url),
  })
  // 🔒 YAZ-1775 D10: the board items are enabled only while the window a menu action would target has
  // a board of the right kind in front. Read at build time from the same entry `focusedEntry` uses,
  // so the answer and the send target can never disagree.
  const activeFileKind = () => {
    const wc = menuTarget()
    const id = wc === undefined ? undefined : manager.idFor(wc)
    const file = id === undefined ? null : (store.get().windows.find((w) => w.id === id)?.file ?? null)
    return file === null ? null : fileKind(file)
  }
  const applyMenu = (): void =>
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ recents: store.get().recents, isDev: !app.isPackaged, activeKind: activeFileKind() }, handlers)))
  applyMenu()
  subscribeMenuRebuild(store, applyMenu)
  // A tab switch changes which file is in front (🔒 YAZ-1775 D10); focus changes which window is asked.
  subscribeMenuRebuildOnActiveFile(store, applyMenu)
  rebuildMenuOnFocus = applyMenu
  gitSync = registerIpc(store, manager, app.getPath('userData'), {
    viewerAssetsDir: viewerAssetsDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    drawioDir: DRAWIO_DIR,
    fontsDir: excalidrawFontsDir({ isPackaged: app.isPackaged, mainDir: __dirname, appPath: app.getAppPath(), exists: existsSync }),
    isPackaged: app.isPackaged,
  })
  // 🔒 YAZ-1775 D5: the one library folder every vault shares. Made at startup, detached — a launch must
  // not wait on a disk, and a path that cannot be created is still what the Settings row names.
  void ensureLibraryFolder(store.get().settings.libraryFolder, app.getPath('userData'))
  // YAZ-1081 D3: a lid that just opened is the other "the world moved on while you were away"
  // moment, and the machine that edited the vault meanwhile is usually the other one. Wired here
  // rather than at module scope because powerMonitor is only safe to touch after `ready`.
  powerMonitor.on('resume', () => gitSync?.notifyWake())
  powerMonitor.on('unlock-screen', () => gitSync?.notifyWake())
  manager.restoreAll()
  // A COLD launch from a Finder / Explorer double-click: macOS has already queued its `open-file`
  // path above, Windows and Linux put it in this process's own argv and fire nothing (YAZ-1815).
  for (const path of openableFileArgs(process.argv, argsSkip())) links.push(fileLink(path))
  links.flush()
})

// Quit: renderers, then the pending state and the last sync commit (YAZ-1111), then exit for real —
// `app.exit` re-runs no quit events. The order and every step live in quitSequence.ts, pinned by its
// tests; index.startup.test.ts pins that this handler goes through it (YAZ-2073 D11).
let quitting = false
app.on('before-quit', (event) => {
  event.preventDefault()
  if (quitting) return
  quitting = true
  void runQuitSequence({ manager, store, gitSync, exit: () => app.exit(0) })
})

// Obsidian quits when its last window closes (its main.js `window-all-closed` handler); so do we.
app.on('window-all-closed', () => app.quit())
