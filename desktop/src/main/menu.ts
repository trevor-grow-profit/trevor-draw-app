/**
 * The application menu (B3, GRO-2161). `buildMenuTemplate` is a pure function of its inputs
 * (recents, isDev, handlers) so structure, accelerators and roles unit-test without Electron;
 * `createMenuHandlers` needs only the injected `MenuHost` for the Electron bits (focused
 * window, external links). The `Menu.buildFromTemplate`/`setApplicationMenu` apply layer
 * lives in `main/index.ts`.
 */
import type { MenuItemConstructorOptions } from 'electron'
import type { FileKind, RecentRoots, ZoomStep } from '@shared/types'
import { CONTRACT } from '@shared/ipc'
import type { Store } from './store'
import type { WindowManager } from './windows'

/** Help › Yaseen Draw on GitHub: the repo README (origin URL of this repo). */
export const HELP_URL = 'https://github.com/yaseenarshad/yaseen-draw-app#readme'

export interface MenuHandlers {
  /** File › New Window (⌘⇧N, D6): duplicate the focused window — same folder, same file. */
  newWindow(): void
  /** File › Switch Vault… (⌘O, YAZ-1767 D8): the focused window's renderer opens its sidebar vault switcher. */
  switchVault(): void
  /** File › Open Folder… (⌘⇧O): the focused window's renderer runs its pick-folder flow. */
  openFolder(): void
  /** File › Open Recent › item: in place on a Welcome window; beside it otherwise (YAZ-1913 🔒 D1). */
  openRecent(path: string): void
  /** File › Search Vault (⌘K, YAZ-804): the focused window's renderer focuses its sidebar search bar. */
  search(): void
  /** Yaseen Draw › Settings… (⌘,, YAZ-1679): the focused window's renderer opens its settings dialog. */
  settings(): void
  /** File › Close Tab (⌘W, GRO-2232): the focused window's renderer closes its active tab. */
  closeTab(): void
  /** Window › Next Tab (⌃Tab / ⌘⇧], GRO-2232): the focused window's renderer activates the tab to the right. */
  nextTab(): void
  /** Window › Previous Tab (⌃⇧Tab / ⌘⇧[, GRO-2232): the focused window's renderer activates the tab to the left. */
  prevTab(): void
  /** View › Toggle Sidebar: ask only the focused renderer to toggle its window identity. */
  toggleSidebar(): void
  /** View › Zoom In / Out / Actual Size (⌘+ / ⌘− / ⌘0): app-wide zoom on the focused window (YAZ-1710). */
  zoom(step: ZoomStep): void
  /**
   * File › Export Image… (⌘⇧E, 🔒 YAZ-1775 D10): the focused renderer's visible board exports a picture — a drawing
   * through the engine's export dialog, a diagram through the D9 renderer (🔒 YAZ-1802 D9).
   */
  exportImage(): void
  /** File › Export Drawing… (⌘⇧S, 🔒 YAZ-1775 D3): the focused renderer's visible drawing writes a standalone `.excalidraw`. */
  exportDrawing(): void
  /** File › Share Link (⌘⇧L, YAZ-1799): the focused renderer opens the Share dialog for its visible board. */
  shareLink(): void
  /** View › Canvas Background › a pick (🔒 YAZ-1775 D10): the focused renderer's visible drawing takes `color`. */
  canvasBackground(color: string): void
  openHelp(): void
}

export interface MenuInputs {
  /** MRU order, straight from `AppState.recents`. */
  recents: RecentRoots
  /** Dev builds get View › Toggle Developer Tools. */
  isDev: boolean
  /**
   * The kind of the focused window's ACTIVE TAB, null when it is no board (🔒 YAZ-1775 D10). The board
   * items are enabled only on a kind they work for — Export Image… (🔒 YAZ-1802 D9) and Share Link
   * (🔒 YAZ-1802 D11) on any board, the Excalidraw-only ones on a drawing — because a menu row that
   * silently does nothing is worse than a greyed-out one. `main/index.ts` recomputes it on every rebuild, and
   * `subscribeMenuRebuildOnActiveFile` plus the focus hook are what make a rebuild happen.
   */
  activeKind: FileKind | null
}

/**
 * The engine's own canvas-background picks (`DEFAULT_CANVAS_BACKGROUND_PICKS`,
 * `packages/common/src/colors.ts`): white, then radix slate2 / blue2 / yellow2 / bronze2. No
 * "Custom…" row — a colour dialog is not a menu item's job, and the engine's own picker is gone
 * with its main menu (🔒 YAZ-1775 D10).
 */
export const CANVAS_BACKGROUND_PICKS: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'White', color: '#ffffff' },
  { label: 'Slate', color: '#f8f9fa' },
  { label: 'Blue', color: '#f5faff' },
  { label: 'Yellow', color: '#fffce8' },
  { label: 'Bronze', color: '#fdf8f6' },
]

/**
 * The whole menu bar as a template. Item `id`s are stable so a live check can drive items
 * through `Menu.getApplicationMenu().getMenuItemById(...)`.
 */
export function buildMenuTemplate({ recents, isDev, activeKind }: MenuInputs, handlers: MenuHandlers): MenuItemConstructorOptions[] {
  const recentItems: MenuItemConstructorOptions[] =
    recents.length === 0
      ? [{ label: 'No Recent Folders', enabled: false }]
      : recents.map((r, i) => ({
          id: `menu.file.open-recent.${i}`,
          label: r.path,
          click: () => handlers.openRecent(r.path),
        }))
  const activeIsDrawing = activeKind === 'drawing'
  return [
    // macOS titles the first menu with the running app's name; the label only matters off-mac.
    {
      label: 'Yaseen Draw',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // ⌘, is the platform's settings key (YAZ-1679); the renderer owns the dialog, so the
        // gesture goes to the focused window's renderer like Search Vault does.
        { id: 'menu.app.settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => handlers.settings() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { id: 'menu.file.new-window', label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => handlers.newWindow() },
        { type: 'separator' },
        // ⌘O opens the sidebar header's vault switcher (YAZ-1767 D8): the renderer owns the panel,
        // so the gesture goes to the focused window's renderer like Search Vault does.
        { id: 'menu.file.switch-vault', label: 'Switch Vault…', accelerator: 'CmdOrCtrl+O', click: () => handlers.switchVault() },
        { id: 'menu.file.open-folder', label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => handlers.openFolder() },
        { id: 'menu.file.open-recent', label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        // ⌘K focuses the sidebar's search bar (D4, YAZ-739 amended): the renderer owns the bar,
        // so the gesture goes to the focused window's renderer — un-collapsing the sidebar first.
        { id: 'menu.file.search', label: 'Search Vault', accelerator: 'CmdOrCtrl+K', click: () => handlers.search() },
        { type: 'separator' },
        // 🔒 YAZ-1775 D10: the drawing's image export left the canvas hamburger for the app menu bar. It
        // opens the ENGINE's own export dialog (`openDialog: { name: 'imageExport' }`) — a
        // standalone `.excalidraw` export is YAZ-1821's. A diagram exports through the D9 renderer
        // (🔒 YAZ-1802), so the item works on any board.
        { id: 'menu.file.export-image', label: 'Export Image…', accelerator: 'CmdOrCtrl+Shift+E', enabled: activeKind !== null, click: () => handlers.exportImage() },
        // 🔒 YAZ-1775 D3: the ONE place a `.excalidraw` embeds its images, so a board can be handed to
        // someone with no vault and no `assets/` folder. ⌘⇧S is free in this menu — the engine's
        // own "Save as" is off (`saveToActiveFile: false`) and a registered accelerator never
        // reaches the page on macOS anyway — and it is the key the gesture means.
        { id: 'menu.file.export-drawing', label: 'Export Excalidraw Drawing…', accelerator: 'CmdOrCtrl+Shift+S', enabled: activeIsDrawing, click: () => handlers.exportDrawing() },
        // YAZ-1799 D6: the Share dialog for the same board — its standalone file, kept live on the user's
        // own Cloudflare. A diagram shares its XML (🔒 YAZ-1802 D11), so the item works on any board.
        { id: 'menu.file.share-link', label: 'Share Link', accelerator: 'CmdOrCtrl+Shift+L', enabled: activeKind !== null, click: () => handlers.shareLink() },
        { type: 'separator' },
        // ⌘W is Close Tab (GRO-2232, locked): the renderer owns tab state, so the gesture goes to
        // the focused window's renderer. Close Window moves to ⌘⇧W and keeps `role: 'close'` — the
        // OS close that windows.ts intercepts for the flush handshake.
        { id: 'menu.file.close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => handlers.closeTab() },
        { id: 'menu.file.close-window', role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { id: 'menu.view.toggle-sidebar', label: 'Toggle Sidebar', click: () => handlers.toggleSidebar() },
        { type: 'separator' },
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' } satisfies MenuItemConstructorOptions] : []),
        { type: 'separator' },
        // Not the stock zoom roles (YAZ-1710): a registered accelerator never reaches the page on
        // macOS, so main applies the step to the focused window's webContents itself.
        { id: 'menu.view.zoom-reset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => handlers.zoom(0) },
        { id: 'menu.view.zoom-in', label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => handlers.zoom(1) },
        // Electron's own zoomIn role also answers ⌘= (no shift); keep that hidden twin.
        { id: 'menu.view.zoom-in-eq', label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => handlers.zoom(1) },
        { id: 'menu.view.zoom-out', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => handlers.zoom(-1) },
        { type: 'separator' },
        // 🔒 YAZ-1775 D10: the engine's canvas-background picks, greyed out off a drawing tab. The value is
        // per BOARD — the engine writes `viewBackgroundColor` into the file — which is why it is
        // here and not in Settings › Canvas with the user-level prefs (🔒 YAZ-1775 D9).
        {
          id: 'menu.view.canvas-background',
          label: 'Canvas Background',
          enabled: activeIsDrawing,
          submenu: CANVAS_BACKGROUND_PICKS.map(({ label, color }, i) => ({ id: `menu.view.canvas-background.${i}`, label, click: () => handlers.canvasBackground(color) })),
        },
      ],
    },
    // Top-level role `window` marks this submenu as macOS's Windows menu, so the OS appends the window list.
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // Tab switching (GRO-2232): the visible pair carries the macOS-conventional ⌃Tab / ⌃⇧Tab;
        // hidden duplicates carry the ⌘⇧] / ⌘⇧[ equivalents (`acceleratorWorksWhenHidden`, macOS).
        { id: 'menu.window.next-tab', label: 'Next Tab', accelerator: 'Control+Tab', click: () => handlers.nextTab() },
        { id: 'menu.window.prev-tab', label: 'Previous Tab', accelerator: 'Control+Shift+Tab', click: () => handlers.prevTab() },
        { id: 'menu.window.next-tab-alt', label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', visible: false, acceleratorWorksWhenHidden: true, click: () => handlers.nextTab() },
        { id: 'menu.window.prev-tab-alt', label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', visible: false, acceleratorWorksWhenHidden: true, click: () => handlers.prevTab() },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    { label: 'Help', role: 'help', submenu: [{ id: 'menu.help.github', label: 'Yaseen Draw on GitHub', click: () => handlers.openHelp() }] },
  ]
}

export interface ContextMenuActions {
  /** Swap the misspelled word under the cursor for the suggestion the user picked. */
  replace(word: string): void
  /** Teach the spellchecker a word it flagged, for good. */
  addToDictionary(word: string): void
}

/**
 * The right-click menu (YAZ-672). Electron ships no default one, so the spellchecker's squiggles
 * had nothing to act on. Pure like `buildMenuTemplate`; the `context-menu` event and the
 * `Menu.buildFromTemplate(...).popup()` apply layer live in `main/index.ts`.
 */
export function buildContextMenuTemplate(
  params: Pick<Electron.ContextMenuParams, 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'>,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const suggestions: MenuItemConstructorOptions[] = params.dictionarySuggestions.map((s) => ({ label: s, click: () => actions.replace(s) }))
  const dictionary: MenuItemConstructorOptions[] =
    params.misspelledWord === ''
      ? []
      : [
          ...(suggestions.length === 0 ? [] : [{ type: 'separator' } satisfies MenuItemConstructorOptions]),
          { label: 'Add to Dictionary', click: () => actions.addToDictionary(params.misspelledWord) },
          { type: 'separator' },
        ]
  return [
    ...suggestions,
    ...dictionary,
    { role: 'cut', enabled: params.editFlags.canCut },
    { role: 'copy', enabled: params.editFlags.canCopy },
    { role: 'paste', enabled: params.editFlags.canPaste },
  ]
}

/**
 * The window a menu action targets (GRO-2197): the OS-focused one when there is one, else the
 * most recently focused LIVE window, else any live window, else undefined. WHY a fallback at
 * all: macOS reports NO focused window while the app is not frontmost — `getFocusedWindow()`
 * returns null even with a sole visible, unminimized window, and `win.focus()` cannot change
 * that (macOS refuses to activate a background app) — and a menu item that silently does
 * nothing is the worst possible answer. Electron-free and structural on purpose so
 * `menu.test.ts` fakes windows in a few lines; generic so `index.ts` gets `BrowserWindow`
 * back out. `lastFocusedId` is a `webContents.id` (tracked via `browser-window-focus`).
 */
export function pickMenuTargetWindow<W extends { webContents: { id: number }; isDestroyed(): boolean }>(
  focused: W | null,
  all: readonly W[],
  lastFocusedId: number | undefined,
): W | undefined {
  if (focused !== null && !focused.isDestroyed()) return focused
  const live = all.filter((w) => !w.isDestroyed())
  return live.find((w) => w.webContents.id === lastFocusedId) ?? live[0]
}

/** The Electron-only half, injected by `main/index.ts` (like windows.ts's `WindowHost`). */
export interface MenuHost {
  /**
   * The webContents a menu action targets. The fallback IS the contract (GRO-2197): the
   * OS-focused window's when there is one, else the most recently focused live window's, else
   * any live window's — undefined ONLY when no window exists at all. `index.ts` implements
   * this through `pickMenuTargetWindow` (see its comment for why macOS forces the fallback).
   */
  focusedWebContents(): { id: number; send(channel: string, ...args: unknown[]): void } | undefined
  /** App-wide zoom on the focused window: level ± 0.5, or back to 0 (YAZ-1710). */
  zoom(step: ZoomStep): void
  openExternal(url: string): void
}

type MenuWindows = Pick<WindowManager, 'idFor' | 'duplicateWindow' | 'openRecentBeside'>

export function createMenuHandlers(store: Store, windows: MenuWindows, host: MenuHost): MenuHandlers {
  /** The focused window's `AppState.windows` entry (lookup: `webContents.id` → entry id). */
  const focusedEntry = () => {
    const wc = host.focusedWebContents()
    const id = wc === undefined ? undefined : windows.idFor(wc)
    return id === undefined ? undefined : store.get().windows.find((w) => w.id === id)
  }
  return {
    newWindow() {
      const entry = focusedEntry()
      if (entry !== undefined) windows.duplicateWindow(entry)
    },
    switchVault() {
      host.focusedWebContents()?.send(CONTRACT.menu.onSwitchVault.channel)
    },
    openFolder() {
      host.focusedWebContents()?.send(CONTRACT.menu.onOpenFolder.channel)
    },
    openRecent(path) {
      // A vault window never has its vault swapped (YAZ-1913 🔒 D1): only an empty Welcome window fills in place.
      if (focusedEntry()?.root === null) {
        host.focusedWebContents()?.send(CONTRACT.menu.onOpenRoot.channel, path)
        return
      }
      // A vault window goes through the one open-recent door (YAZ-1767 D1): raise that vault's
      // windows, or a new window on its remembered last file.
      windows.openRecentBeside(path)
    },
    search() {
      host.focusedWebContents()?.send(CONTRACT.menu.onSearch.channel)
    },
    settings() {
      host.focusedWebContents()?.send(CONTRACT.menu.onSettings.channel)
    },
    closeTab() {
      host.focusedWebContents()?.send(CONTRACT.menu.onCloseTab.channel)
    },
    nextTab() {
      host.focusedWebContents()?.send(CONTRACT.menu.onNextTab.channel)
    },
    prevTab() {
      host.focusedWebContents()?.send(CONTRACT.menu.onPrevTab.channel)
    },
    toggleSidebar() {
      host.focusedWebContents()?.send(CONTRACT.menu.onToggleSidebar.channel)
    },
    zoom(step) {
      host.zoom(step)
    },
    exportImage() {
      host.focusedWebContents()?.send(CONTRACT.menu.onExportImage.channel)
    },
    exportDrawing() {
      host.focusedWebContents()?.send(CONTRACT.menu.onExportDrawing.channel)
    },
    shareLink() {
      host.focusedWebContents()?.send(CONTRACT.menu.onShareLink.channel)
    },
    canvasBackground(color) {
      host.focusedWebContents()?.send(CONTRACT.menu.onCanvasBackground.channel, color)
    },
    openHelp() {
      host.openExternal(HELP_URL)
    },
  }
}

/**
 * Rebuild only when `recents` actually changed: store snapshots reuse untouched sub-objects,
 * so reference identity of `state.recents` skips every settings/window/folder write for free.
 */
export function subscribeMenuRebuild(store: Store, rebuild: () => void): () => void {
  let last = store.get().recents
  return store.onChange((state) => {
    if (state.recents === last) return
    last = state.recents
    rebuild()
  })
}

/** The one fact the board items are gated on: which file each window has in front. */
const activeFilesKey = (state: { windows: ReadonlyArray<{ id: string; file: string | null }> }): string => state.windows.map((w) => `${w.id}=${w.file ?? ''}`).join('\n')

/**
 * Rebuild when any window's ACTIVE FILE changes (🔒 YAZ-1775 D10): File › Export Image…, File › Export
 * Drawing… and View › Canvas Background are enabled only while the focused window's active tab is
 * a board of their kind, so a tab switch
 * has to re-evaluate them. A second subscription rather than a widening of `subscribeMenuRebuild`,
 * so the recents rule — and its test — stays exactly what it was. Focus changes are the host's to
 * report (`browser-window-focus` in `main/index.ts`): they move which window is asked, not what
 * the store says.
 */
export function subscribeMenuRebuildOnActiveFile(store: Store, rebuild: () => void): () => void {
  let last = activeFilesKey(store.get())
  return store.onChange((state) => {
    const next = activeFilesKey(state)
    if (next === last) return
    last = next
    rebuild()
  })
}
