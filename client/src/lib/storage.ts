import {
  DEFAULT_SIDEBAR_LENS,
  addRecentRoot,
  cleanVaultName,
  defaultAppState,
  defaultFolderState,
  type AppState,
  type FolderState,
  type RecentRoots,
  type SettingsState,
  type SidebarLens,
  type SortOrder,
  type WindowIdentity,
} from '@shared/types'
import { basename } from './paths'
import { api } from '../api'

/**
 * The renderer's view of the app state (D9, GRO-2159): an in-memory cache of the main-owned
 * `yaseendraw.json` plus this window's identity. `init()` loads both over the bridge and
 * subscribes to `state.onChange`, so a change made in any window replaces the cache here and
 * wakes `subscribe` listeners. Reads are synchronous off the cache; writes update the cache at
 * once (optimistic) and send the targeted mutator over the bridge, fire-and-forget.
 */

let state: AppState = defaultAppState()
let identity: WindowIdentity = { id: '', root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: DEFAULT_SIDEBAR_LENS, focusDirs: [], focusFavorites: [] }
let unsubscribe: (() => void) | null = null
const listeners = new Set<() => void>()

/** Issues one bridge call at once without awaiting it; a rejection (or a missing bridge) is logged, never thrown. */
function send(what: string, call: () => Promise<void>): void {
  const log = (err: unknown) => console.error(`[storage] ${what} failed:`, err)
  try {
    call().catch(log)
  } catch (err) {
    log(err)
  }
}

function folderOf(root: string): FolderState {
  return state.folders[root] ?? defaultFolderState()
}

function patchFolder(root: string, patch: Partial<FolderState>): void {
  state = { ...state, folders: { ...state.folders, [root]: { ...folderOf(root), ...patch } } }
}

export const storage = {
  /** Load the state + identity and start following changes; call once before the first render. */
  async init(): Promise<void> {
    const [s, id] = await Promise.all([api.state.get(), api.window.identity()])
    state = s
    identity = id
    unsubscribe?.()
    unsubscribe = api.state.onChange((next) => {
      state = next
      listeners.forEach((l) => l())
    })
  },

  /** Called after a `state:changed` push landed in the cache — from any window, this one's own writes included. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getRoot: (): string | null => identity.root,
  /**
   * Changing the root clears this window's file AND tab list (Tabs rule 13, GRO-2234) and both
   * Focus Mode lists (YAZ-1628, YAZ-1766), and lands the lens on Files (Docs YAZ-1846 D2), in the
   * same write; re-setting the same root keeps them.
   */
  setRoot(root: string | null): void {
    const patch = root === identity.root
      ? { root }
      : { root, file: null, tabs: [] as string[], sidebarLens: DEFAULT_SIDEBAR_LENS, focusDirs: [] as string[], focusFavorites: [] as string[] }
    identity = { ...identity, ...patch }
    send('window.setIdentity', () => api.window.setIdentity(patch))
  },

  getRecentRoots: (): RecentRoots => state.recents,
  pushRecentRoot(path: string, now = Date.now()): RecentRoots {
    const next = addRecentRoot(state.recents, path, now)
    state = { ...state, recents: next }
    send('state.pushRecent', () => api.state.pushRecent(path))
    return next
  },

  /** Drop a dead folder from the MRU (its directory vanished on disk, C2 — GRO-2164). */
  removeRecentRoot(path: string): void {
    state = { ...state, recents: state.recents.filter((r) => r.path !== path) }
    send('state.removeRecent', () => api.state.removeRecent(path))
  },

  /** What the app calls a vault (Docs YAZ-1974 D4): its display name, else its folder name. */
  vaultName: (root: string): string => folderOf(root).name ?? basename(root),
  /** Set (or, with null / empty / the folder's own name, clear) a vault's display name (Docs YAZ-1974 D3, D5). */
  setVaultName(root: string, raw: string | null): void {
    const clean = cleanVaultName(raw)
    const name = clean === basename(root) ? null : clean
    patchFolder(root, { name })
    send('state.setFolder', () => api.state.setFolder(root, { name }))
  },

  /** The Files lens's order for this vault (🔒 YAZ-1835 D3); another window's change lands through `subscribe`. */
  getSortOrder: (root: string): SortOrder => folderOf(root).sortOrder,
  setSortOrder(root: string, sortOrder: SortOrder): void {
    patchFolder(root, { sortOrder })
    send('state.setFolder', () => api.state.setFolder(root, { sortOrder }))
  },

  getExpanded: (root: string): string[] => folderOf(root).expanded,
  setExpanded(root: string, dirs: string[]): void {
    patchFolder(root, { expanded: dirs })
    send('state.setFolder', () => api.state.setFolder(root, { expanded: dirs }))
  },

  /**
   * Focus Mode (YAZ-1605): a path list per lens, empty when off. Window identity since YAZ-1628,
   * like `sidebarCollapsed` below — no root argument, and a global state broadcast never follows
   * another window's focus into this one; a root change clears the lists (`setRoot`).
   */
  getFocusDirs: (): string[] => identity.focusDirs,
  setFocusDirs(dirs: readonly string[]): void {
    const focusDirs = [...dirs]
    identity = { ...identity, focusDirs }
    send('window.setIdentity', () => api.window.setIdentity({ focusDirs }))
  },
  /** The Favorites tab's own focus list (YAZ-1766 D5): the favorited dirs it is narrowed to. */
  getFocusFavorites: (): string[] => identity.focusFavorites,
  setFocusFavorites(dirs: readonly string[]): void {
    const focusFavorites = [...dirs]
    identity = { ...identity, focusFavorites }
    send('window.setIdentity', () => api.window.setIdentity({ focusFavorites }))
  },

  /** The window identity records what is open now: THIS window's restored file, not the folder's shared lastFile (GRO-2160). */
  getFile: (): string | null => identity.file,

  /** Valid AT BOOT only (like `getFile`): the renderer owns tab state after boot (Tabs I2, GRO-2234). */
  getTabs: (): string[] => identity.tabs,

  getLastFile: (root: string): string | null => folderOf(root).lastFile,

  /** One durable mirror for the complete workspace identity. */
  setWorkspace(root: string | null, tabs: readonly string[], file: string | null): void {
    const fileChanged = file !== identity.file
    identity = { ...identity, file, tabs: [...tabs] }
    if (root !== null && fileChanged) {
      patchFolder(root, { lastFile: file })
      send('state.setFolder', () => api.state.setFolder(root, { lastFile: file }))
    }
    send('window.setIdentity', () => api.window.setIdentity({ tabs: [...tabs], file }))
  },

  /** Already validated field-by-field by the main process on load (`desktop/src/main/store.ts`). */
  getSettings: (): SettingsState => state.settings,
  setSettings(settings: SettingsState): void {
    state = { ...state, settings }
    send('state.setSettings', () => api.state.setSettings(settings))
  },

  /** Sidebar visibility is window identity; global state broadcasts cannot change another window. */
  getSidebarCollapsed: (): boolean => identity.sidebarCollapsed,
  setSidebarCollapsed(collapsed: boolean): void {
    identity = { ...identity, sidebarCollapsed: collapsed }
    send('window.setIdentity', () => api.window.setIdentity({ sidebarCollapsed: collapsed }))
  },

  /** Already clamped to [SIDEBAR_MIN_W, SIDEBAR_MAX_W] by the main process on load and on write. */
  getSidebarWidth: (): number => state.sidebarWidth,
  setSidebarWidth(width: number): void {
    state = { ...state, sidebarWidth: width }
    send('state.setSidebarWidth', () => api.state.setSidebarWidth(width))
  },

  /**
   * The active sidebar lens (YAZ-847): chrome, not per-folder view state, so no root argument
   * and no `FolderState` entry. Window identity since YAZ-1628, like `sidebarCollapsed` above —
   * another window's switch never lands here through a state broadcast; a switch to a DIFFERENT
   * root lands it on Files (`setRoot`, Docs YAZ-1846 D2), the same root keeps it.
   */
  getSidebarLens: (): SidebarLens => identity.sidebarLens,
  setSidebarLens(lens: SidebarLens): void {
    identity = { ...identity, sidebarLens: lens }
    send('window.setIdentity', () => api.window.setIdentity({ sidebarLens: lens }))
  },
}
