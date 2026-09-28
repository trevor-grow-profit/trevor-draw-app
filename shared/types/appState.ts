/** `yaseendraw.json`: the settings, the window list, the recents and the per-folder state. */

import { DEFAULT_CANVAS_PANEL, DEFAULT_CANVAS_PREFS, type CanvasPanelState, type CanvasPrefs } from './canvas'

/** `AppState.recents` — most-recent first, max MAX_RECENT_ROOTS, de-duplicated. */
export type RecentRoots = Array<{ path: string; lastOpened: number }>
export const MAX_RECENT_ROOTS = 10

/** Pure: prepend `path` to the MRU list, de-duplicated, capped — shared by the client cache and the main store. */
export function addRecentRoot(list: RecentRoots, path: string, now: number): RecentRoots {
  return [{ path, lastOpened: now }, ...list.filter((r) => r.path !== path)].slice(0, MAX_RECENT_ROOTS)
}

/** Entries in a vault's `.yaseendraw/favorites.json` (YAZ-1766 D2, in the vault since 6A/D11) are capped at this many on read and write. */
export const MAX_FAVORITES = 500

/**
 * `WindowEntry.sidebarLens` — which lens the sidebar's chrome-v2 ROW 1 tabs show (⚡ YAZ-1775 D8 amended):
 * `files` (the file explorer) or `favorites` (the pinned files and folders, YAZ-1766 D1).
 * Window identity like `sidebarCollapsed` since YAZ-1628: the tabs are not per-folder view
 * state, so there is no per-root keying and no `FolderState` entry. Any unrecognised stored
 * value falls back to the default, `files`.
 */
export type SidebarLens = 'files' | 'favorites'
/** The tabs' order, left→right. */
export const SIDEBAR_LENSES: readonly SidebarLens[] = ['files', 'favorites']
/** The lens a new window, and a switch to a DIFFERENT vault, opens on (port of Docs YAZ-1846 D1/D2). */
export const DEFAULT_SIDEBAR_LENS: SidebarLens = 'files'
export const isSidebarLens = (v: unknown): v is SidebarLens => SIDEBAR_LENSES.includes(v as SidebarLens)

/**
 * The Files lens's order (🔒 YAZ-1835 D2): by name, by last save, or by birth. Dates read a board's
 * own block first and its mtime when it has none (🔒 YAZ-1834 D6); folders always lead, by name.
 */
export type SortOrder = 'name' | 'updated' | 'created'
export const SORT_ORDERS: readonly SortOrder[] = ['name', 'updated', 'created']
export const isSortOrder = (v: unknown): v is SortOrder => SORT_ORDERS.includes(v as SortOrder)

/** `AppState.sidebarWidth` — the drag-to-resize bounds (YAZ-738), clamped on every write and on load. */
export const SIDEBAR_MIN_W = 180
export const SIDEBAR_MAX_W = 520
export const SIDEBAR_DEFAULT_W = 260

/**
 * `AppState.settings` — app-global preferences (GRO-2024), one user-global file for every vault.
 */
export interface SettingsState {
  /** Appearance (Desktop K, GRO-2218): explicit values win; `system` tracks the OS live. */
  theme: Theme
  /**
   * The one library folder every vault shares (🔒 YAZ-1775 D5): an absolute path the user chose, or null
   * for the default `<userData>/library`. Media favorites and saved components were per cloud
   * account in the web app; per-vault storage would mean re-favouriting in every vault, and app
   * userData alone would never be backed up. A folder the user can point inside a synced vault is
   * both. `drawing.libraryFolder()` resolves it; null is the default, never `''`. Its contents
   * (`media.json`, `components/`) are written by YAZ-1817 / YAZ-1818 / YAZ-1819.
   */
  libraryFolder: string | null
  /**
   * Show the confirm sheet before deleting (GRO-2272 — VS Code's `explorer.confirmDelete`).
   * Defaults TRUE and should stay that way: the sheet is the ONLY guard on delete, because
   * `shell.trashItem` has no programmatic undo, so there is no in-app restore to fall back
   * on. Cleared from the sheet's own "Don't ask me again" and re-enabled from the settings
   * cog — a one-way switch would leave hand-editing `yaseendraw.json` as the only way back.
   */
  confirmDelete: boolean
  /** Rest the mouse on a board in the sidebar to see the whole drawing (YAZ-1800). Every window and vault share it. */
  hoverPreview: boolean
  /**
   * The canvas preferences every board, every window and every relaunch share (🔒 YAZ-1775 D9). Seeded
   * into the engine at mount and kept in step both ways, diff-before-write in each direction so
   * two windows can never ping-pong. See `CanvasPrefs`.
   */
  canvas: CanvasPrefs
  /** What the in-canvas docked panel remembers: its last-used tab and its dock preference (🔒 YAZ-1775 D10). */
  canvasPanel: CanvasPanelState
  /**
   * How draw.io diagrams look in dark mode (🔒 YAZ-1802 D16): `adapt` lets draw.io re-colour them so
   * an ordinary diagram stays readable, `keep` shows every diagram in its own colours. It is the
   * DEFAULT only — a file whose `<mxGraphModel>` says `adaptiveColors="none"` keeps its colours
   * either way. The editor, the hover preview and the history pictures all follow it, live.
   */
  diagramDarkColors: DiagramDarkColors
}

export type DiagramDarkColors = 'adapt' | 'keep'
export const DIAGRAM_DARK_COLORS: readonly DiagramDarkColors[] = ['adapt', 'keep']

/** Obsidian's Appearance vocabulary and order — also exactly Electron's `nativeTheme.themeSource`. */
export type Theme = 'system' | 'light' | 'dark'
export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

export const DEFAULT_SETTINGS: SettingsState = {
  theme: 'system',
  libraryFolder: null,
  confirmDelete: true,
  hoverPreview: true,
  canvas: DEFAULT_CANVAS_PREFS,
  canvasPanel: DEFAULT_CANVAS_PANEL,
  diagramDarkColors: 'adapt',
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One open window; restored on relaunch (GRO-2160). `root` null = Welcome screen.
 *
 * Tabs (GRO-2232): `tabs` is every open file as absolute paths, de-duplicated, ordered
 * left→right; `file` doubles as the ACTIVE tab — there is no separate activeTab field.
 * Invariants: `file ∈ tabs` whenever `file` is non-null, and `tabs: []` ⇔ `file: null`
 * (the no-tabs state). Deliberately additive within `AppState.version` 1 — bumping the
 * version would make `sanitizeState` treat every existing store file as corrupt. An old
 * build's field-by-field sanitizer silently drops the unknown `tabs` key and falls back
 * to `file` (graceful downgrade); this build repairs a missing `tabs` from `file`.
 */
export interface WindowEntry {
  id: string
  root: string | null
  file: string | null
  tabs: string[]
  /** Whether this window's sidebar is hidden (YAZ-1280); independent from every other window. */
  sidebarCollapsed: boolean
  /**
   * Which sidebar lens THIS window shows (YAZ-847; per window since YAZ-1628, `sidebarCollapsed`'s
   * rule): independent from every other window — a duplicate inherits it and then diverges — and
   * kept across a root change, being a view preference rather than vault content. A pre-1628
   * file's retired global value seeds every window that has none of its own.
   */
  sidebarLens: SidebarLens
  /**
   * Focus Mode (YAZ-1605; per window since YAZ-1628): the directories THIS window's Files tree
   * is narrowed to — one or several (a shift-selection) — or empty for the whole vault. Window
   * identity like `sidebarCollapsed`, so a second window on the same vault focuses on its own:
   * a duplicate inherits the list by value and then diverges, a root change clears it. A flat
   * list of absolute paths, so `store.renamePath` / `store.removePath` repair it as they repair
   * `tabs` — a renamed focus follows its folder, a deleted one drops out.
   */
  focusDirs: string[]
  /** Its Favorites twin (YAZ-1766 D5): the favorited DIRS this window's Favorites tab is narrowed to, or empty. */
  focusFavorites: string[]
  bounds: WindowBounds
}

/**
 * View state that only means something inside that folder. `expanded` is a SESSION list
 * (YAZ-1642): shared by every window on
 * the vault through the main-owned store, never written to disk and never restored — a launch
 * starts the tree collapsed. `lastFile` persists.
 */
export interface FolderState {
  expanded: string[]
  lastFile: string | null
  /** The Files lens's order for this vault (🔒 YAZ-1835 D3): persisted, and every window on the vault follows it. */
  sortOrder: SortOrder
}

/**
 * The whole persisted app state — one user-global JSON file, owned by the main process
 * (`~/Library/Application Support/Yaseen Draw/yaseendraw.json`). Settings are global so
 * they apply to every folder and travel to another machine by copying this one file.
 */
export interface AppState {
  version: 1
  settings: SettingsState
  /** Sidebar width in px, within [SIDEBAR_MIN_W, SIDEBAR_MAX_W]. */
  sidebarWidth: number
  /** Most-recent first, max 10, de-duplicated. */
  recents: RecentRoots
  windows: WindowEntry[]
  folders: Record<string, FolderState>
}

/** A fresh default state (a factory, so no caller can mutate a shared constant). */
export function defaultAppState(): AppState {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, sidebarWidth: SIDEBAR_DEFAULT_W, recents: [], windows: [], folders: {} }
}

export function defaultFolderState(): FolderState {
  return { expanded: [], lastFile: null, sortOrder: 'name' }
}
