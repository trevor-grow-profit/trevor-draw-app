import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import {
  DEFAULT_CANVAS_PANEL,
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_LENS,
  DIAGRAM_DARK_COLORS,
  MAX_RECENT_ROOTS,
  SIDEBAR_DEFAULT_W,
  SIDEBAR_MAX_W,
  SIDEBAR_MIN_W,
  THEMES,
  addRecentRoot,
  cleanVaultName,
  defaultAppState,
  defaultFolderState,
  isCanvasPanelTab,
  isSidebarLens,
  isSortOrder,
  type AppState,
  type CanvasPanelState,
  type DiagramDarkColors,
  type FolderPatch,
  type FolderState,
  type RecentRoots,
  type SettingsState,
  type SidebarLens,
  type Theme,
  type WindowBounds,
  type WindowEntry,
} from '@shared/types'
import { isCanvasPrefs, sanitizeCanvasPrefs } from '@shared/canvasPrefs'
import { isWithin } from '@shared/paths'
import { atomicWrite } from './fs/fsUtils'
import { isFiniteNumber, isRecord, isStringArray } from '@shared/guards'

/**
 * The app state store (D9, GRO-2159): one user-global JSON file owned by the main process.
 * Electron-free — the caller passes the file path — so tests run it against a temp dir.
 * Mutations update memory, notify `onChange` listeners synchronously and schedule one debounced
 * atomic write; `flush()` writes at once (quit). Snapshots are immutable: every mutation builds a
 * new state object, so a listener can keep the one it was handed.
 */
export interface Store {
  get(): AppState
  setSettings(settings: SettingsState): void
  setSidebarWidth(width: number): void
  pushRecent(path: string, now?: number): void
  removeRecent(path: string): void
  setFolder(root: string, patch: FolderPatch): void
  upsertWindow(entry: WindowEntry): void
  removeWindow(id: string): void
  /**
   * Repair every stored reference to a just-renamed file OR directory (Links E1 GRO-2194,
   * E1b GRO-2241): window `root`/`file`/`tabs` (through `normalizeTabs`) and its Focus Mode
   * lists `focusDirs`/`focusFavorites` (YAZ-1628, YAZ-1766), recents, and each folder-state key
   * with its `expanded`/`lastFile`.
   * A dir remaps by prefix — everything at or under it follows,
   * including a window ROOTED at the renamed folder. One commit; a no-op when nothing
   * references it.
   */
  renamePath(oldPath: string, newPath: string): void
  /**
   * Drop every stored reference to a just-deleted file OR directory (GRO-2272) — the delete
   * twin of `renamePath`. A directory removes BY PREFIX: everything at or under it goes.
   *
   * Per field: a window's `file` becomes null (and `normalizeTabs` then empties its tabs),
   * deleted tabs are dropped as are its `focusDirs` / `focusFavorites` entries
   * (YAZ-1628, YAZ-1766), `recents` loses the entry, and folder-state keys plus their
   * `expanded` / `lastFile`
   * (`<basePath>::<view>`) go too.
   * A window's `root` is deliberately LEFT ALONE: the renderer's existing `onRootMissing`
   * probe owns that repair (it also drops the dead MRU entry), and nulling it here would
   * race it. One commit; a no-op when nothing references the path.
   */
  removePath(path: string): void
  onChange(listener: (state: AppState) => void): () => void
  flush(): Promise<void>
}

export const WRITE_DEBOUNCE_MS = 150

// ---------- validation (field by field; anything off falls back to its default) ----------

const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const clampSidebarWidth = (w: number): number => Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, w))

export const isRecentRoots = (v: unknown): v is RecentRoots =>
  Array.isArray(v) && v.every((x) => isRecord(x) && typeof x.path === 'string' && isFiniteNumber(x.lastOpened))

/** The canvas panel's memory (🔒 YAZ-1775 D10): both halves guarded, an unknown tab reads as the default. */
export const isCanvasPanel = (v: unknown): v is CanvasPanelState => isRecord(v) && isCanvasPanelTab(v.tab) && typeof v.docked === 'boolean'
const sanitizeCanvasPanel = (raw: unknown): CanvasPanelState => {
  const src = isRecord(raw) ? raw : {}
  return { tab: isCanvasPanelTab(src.tab) ? src.tab : DEFAULT_CANVAS_PANEL.tab, docked: typeof src.docked === 'boolean' ? src.docked : DEFAULT_CANVAS_PANEL.docked }
}

/** Per-field guards shared by the loader, `sanitizeSettings` and the IPC boundary (`isSettings`). */
const SETTINGS_FIELD_OK: { [K in keyof SettingsState]: (v: unknown) => v is SettingsState[K] } = {
  theme: (v): v is Theme => typeof v === 'string' && (THEMES as readonly string[]).includes(v),
  // 🔒 YAZ-1775 D5: an absolute path the user picked, or null for `<userData>/library`. Never `''` — an
  // empty string would resolve to the process cwd, which is not a place to put a user's library.
  libraryFolder: (v): v is string | null => v === null || (typeof v === 'string' && isAbsolute(v)),
  confirmDelete: (v): v is boolean => typeof v === 'boolean',
  hoverPreview: (v): v is boolean => typeof v === 'boolean',
  // 🔒 YAZ-1775 D9: STRICT at the bridge — a sandboxed renderer hands over a whole `CanvasPrefs` or nothing.
  canvas: isCanvasPrefs,
  canvasPanel: isCanvasPanel,
  // 🔒 YAZ-1802 D16: a state file from before the setting (or a value this build does not know) reads `adapt`.
  diagramDarkColors: (v): v is DiagramDarkColors => typeof v === 'string' && (DIAGRAM_DARK_COLORS as readonly string[]).includes(v),
}
const SETTINGS_KEYS = Object.keys(SETTINGS_FIELD_OK) as Array<keyof SettingsState>

/**
 * The LENIENT half of 🔒 YAZ-1775 D9's "strict guard at IPC, lenient sanitize on load": the two composite
 * fields are repaired key by key rather than thrown away whole, so a state file written before a
 * canvas pref existed keeps every pref it does have instead of resetting the lot.
 */
const SETTINGS_SANITIZE: Partial<{ [K in keyof SettingsState]: (v: unknown) => SettingsState[K] }> = {
  canvas: sanitizeCanvasPrefs,
  canvasPanel: sanitizeCanvasPanel,
}

/** Stored settings merged field-by-field over defaults, so partial/stale shapes stay usable. */
export function sanitizeSettings(raw: unknown): SettingsState {
  const src = isRecord(raw) ? raw : {}
  const out = { ...DEFAULT_SETTINGS }
  for (const k of SETTINGS_KEYS) {
    const repair = SETTINGS_SANITIZE[k]
    if (repair !== undefined) {
      ;(out as Record<string, unknown>)[k] = repair(src[k])
      continue
    }
    const v = src[k]
    if (SETTINGS_FIELD_OK[k](v)) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Strict: every field present and valid (the IPC boundary rejects anything else). */
export const isSettings = (v: unknown): v is SettingsState => isRecord(v) && SETTINGS_KEYS.every((k) => SETTINGS_FIELD_OK[k](v[k]))

export const isWindowBounds = (v: unknown): v is WindowBounds =>
  isRecord(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.width) && isFiniteNumber(v.height)

/** Core v1 shape; additive window-identity fields are repaired separately. */
type StoredWindowEntry = Pick<WindowEntry, 'id' | 'root' | 'file' | 'bounds'> & { tabs?: unknown; sidebarCollapsed?: unknown; sidebarLens?: unknown; focusDirs?: unknown; focusFavorites?: unknown }
const isStoredWindowEntry = (v: unknown): v is StoredWindowEntry =>
  isRecord(v) && typeof v.id === 'string' && isStringOrNull(v.root) && isStringOrNull(v.file) && isWindowBounds(v.bounds)

/**
 * The tabs invariant (GRO-2232), shared by the loader and the IPC boundary (`ipc/window.ts`):
 * de-duplicates preserving first occurrence, prepends a non-null `file` that is missing —
 * `file` IS the active tab, so a legacy entry without `tabs` becomes `[file]` — and clears
 * the list when `file` is null (`tabs: []` ⇔ `file: null`).
 */
export function normalizeTabs(tabs: readonly string[], file: string | null): string[] {
  if (file === null) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tabs) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  if (!seen.has(file)) out.unshift(file)
  return out
}

function sanitizeWindows(raw: unknown, legacySidebarCollapsed: boolean, legacySidebarLens: SidebarLens): WindowEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: WindowEntry[] = []
  for (const w of raw) {
    if (!isStoredWindowEntry(w) || seen.has(w.id)) continue
    seen.add(w.id)
    // Junk `tabs` elements (non-strings, relative paths) drop; a missing/invalid list repairs from `file`.
    const rawTabs: unknown = (w as { tabs?: unknown }).tabs
    const tabs = normalizeTabs(Array.isArray(rawTabs) ? rawTabs.filter((t): t is string => typeof t === 'string' && isAbsolute(t)) : [], w.file)
    const sidebarCollapsed = typeof w.sidebarCollapsed === 'boolean' ? w.sidebarCollapsed : legacySidebarCollapsed
    const sidebarLens = isSidebarLens(w.sidebarLens) ? w.sidebarLens : legacySidebarLens
    // Focus Mode's lists (YAZ-1628) read with the `tabs` rule: relative paths drop, a missing or junk list is no focus.
    const focusDirs = isStringArray(w.focusDirs) ? w.focusDirs.filter(isAbsolute) : []
    const focusFavorites = isStringArray(w.focusFavorites) ? w.focusFavorites.filter(isAbsolute) : []
    out.push({ id: w.id, root: w.root, file: w.file, tabs, sidebarCollapsed, sidebarLens, focusDirs, focusFavorites, bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height } })
  }
  return out
}

function sanitizeFolder(raw: unknown): FolderState | null {
  if (!isRecord(raw)) return null
  return {
    // Tree expansion is SESSION state (YAZ-1642): never restored, never written (`toDisk`).
    // A relaunch starts every tree collapsed; a pre-1642 file's leftover lists are ignored.
    expanded: [],
    lastFile: typeof raw.lastFile === 'string' ? raw.lastFile : null,
    sortOrder: isSortOrder(raw.sortOrder) ? raw.sortOrder : defaultFolderState().sortOrder,
    name: cleanVaultName(raw.name),
  }
}

function sanitizeFolders(raw: unknown): Record<string, FolderState> {
  if (!isRecord(raw)) return {}
  const out: Record<string, FolderState> = {}
  for (const [root, folder] of Object.entries(raw)) {
    const clean = sanitizeFolder(folder)
    if (clean !== null) out[root] = clean
  }
  return out
}

/** The file's shape: each folder bucket minus its session fields (YAZ-1642) — what a relaunch restores, nothing more. */
function toDisk(state: AppState): unknown {
  const folders = Object.fromEntries(Object.entries(state.folders).map(([root, { expanded: _e, ...kept }]) => [root, kept]))
  return { ...state, folders }
}

/** Null when the document is not a version-1 state object at all (→ treated as corrupt). */
function sanitizeState(raw: unknown): AppState | null {
  if (!isRecord(raw) || raw.version !== 1) return null
  // YAZ-1280 migration: a v1 file's retired global value seeds only windows that do not yet
  // have their own value. The returned state omits the old key, so the next write completes it.
  const legacySidebarCollapsed = raw.sidebarCollapsed === true
  // YAZ-1628 migration, the same shape: a v1 file's retired global lens (YAZ-847) seeds only
  // windows without a valid lens of their own; a pre-847 file has none at all, and missing or
  // junk both read as the default. The returned state omits the old key too.
  const legacySidebarLens: SidebarLens = isSidebarLens(raw.sidebarLens) ? raw.sidebarLens : DEFAULT_SIDEBAR_LENS
  return {
    version: 1,
    settings: sanitizeSettings(raw.settings),
    sidebarWidth: isFiniteNumber(raw.sidebarWidth) ? clampSidebarWidth(raw.sidebarWidth) : SIDEBAR_DEFAULT_W,
    recents: isRecentRoots(raw.recents) ? raw.recents.slice(0, MAX_RECENT_ROOTS) : [],
    windows: sanitizeWindows(raw.windows, legacySidebarCollapsed, legacySidebarLens),
    folders: sanitizeFolders(raw.folders),
  }
}

// ---------- loading ----------

/** Reads the file synchronously; a corrupt one is moved aside as `<file>.corrupt-<epoch>` and defaults are used. */
function load(filePath: string): AppState {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAppState()
    throw err
  }
  let parsed: unknown
  let state: AppState | null = null
  try {
    parsed = JSON.parse(raw)
    state = sanitizeState(parsed)
  } catch {
    state = null
  }
  if (state !== null) return state
  const backup = `${filePath}.corrupt-${Date.now()}`
  try {
    renameSync(filePath, backup)
    console.error(`[store] ${filePath} is not a valid app state; moved to ${backup} and using defaults`)
  } catch (err) {
    console.error(`[store] ${filePath} is not a valid app state and could not be moved aside: ${String(err)}`)
  }
  return defaultAppState()
}

/**
 * The open-vault roots — `AppState.windows`, where null is Welcome — unique: two windows on one
 * vault are one root. What main keeps per open vault (sync, favorites, repairs) is kept per these.
 */
export function openRoots(state: AppState): string[] {
  return [...new Set(state.windows.map((w) => w.root).filter((r): r is string => r !== null))]
}

// ---------- the store ----------

export function createStore(filePath: string): Store {
  let state = load(filePath)
  const listeners = new Set<(state: AppState) => void>()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Writes are chained so two atomic writes can never land out of order. */
  let chain: Promise<void> = Promise.resolve()
  /**
   * The text this store last wrote. A commit whose file would read the same — a session-only
   * `expanded` toggle, a settings echo — writes nothing (YAZ-2073 5G).
   */
  let written: string | null = null

  const write = (): Promise<void> => {
    dirty = false
    const snapshot = state
    chain = chain
      .then(async () => {
        const text = `${JSON.stringify(toDisk(snapshot), null, 2)}\n`
        if (text === written) return
        mkdirSync(dirname(filePath), { recursive: true })
        await atomicWrite(filePath, text)
        written = text
      })
      .catch((err: unknown) => console.error(`[store] failed to write ${filePath}: ${String(err)}`))
    return chain
  }

  const commit = (next: AppState): void => {
    state = next
    dirty = true
    listeners.forEach((l) => l(next))
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void write()
    }, WRITE_DEBOUNCE_MS)
  }

  const folderOf = (root: string): FolderState => state.folders[root] ?? defaultFolderState()

  return {
    get: () => state,

    setSettings(settings) {
      commit({ ...state, settings: sanitizeSettings(settings) })
    },

    setSidebarWidth(width) {
      commit({ ...state, sidebarWidth: clampSidebarWidth(width) })
    },

    pushRecent(path, now = Date.now()) {
      commit({ ...state, recents: addRecentRoot(state.recents, path, now) })
    },

    removeRecent(path) {
      if (!state.recents.some((r) => r.path === path)) return
      commit({ ...state, recents: state.recents.filter((r) => r.path !== path) })
    },

    setFolder(root, patch) {
      const cur = folderOf(root)
      const next: FolderState = {
        ...cur,
        ...(patch.expanded !== undefined ? { expanded: [...patch.expanded] } : {}),
        ...(patch.lastFile !== undefined ? { lastFile: patch.lastFile } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.name !== undefined ? { name: cleanVaultName(patch.name) } : {}),
      }
      commit({ ...state, folders: { ...state.folders, [root]: next } })
    },

    upsertWindow(entry) {
      const tabs = normalizeTabs(entry.tabs, entry.file)
      const normalized: WindowEntry = { ...entry, tabs }
      const windows = state.windows.some((w) => w.id === entry.id) ? state.windows.map((w) => (w.id === entry.id ? normalized : w)) : [...state.windows, normalized]
      commit({ ...state, windows })
    },

    removeWindow(id) {
      if (!state.windows.some((w) => w.id === id)) return
      commit({ ...state, windows: state.windows.filter((w) => w.id !== id) })
    },

    renamePath(oldPath, newPath) {
      // E1b (GRO-2241): `oldPath` may be a DIRECTORY — every stored path AT or UNDER it
      // follows: window roots (a subfolder opened as a vault!), files and tabs, recents,
      // and each folder-state KEY plus its expanded dirs and lastFile. For a FILE rename the
      // prefix branch is inert (nothing is ever stored under a
      // file path), so ONE mapping serves both kinds — and it is still one commit, one
      // notify, a no-op when nothing references the path.
      let changed = false
      const remap = (p: string): string => {
        if (!isWithin(oldPath, p)) return p
        changed = true
        return newPath + p.slice(oldPath.length)
      }
      const windows = state.windows.map((w) => {
        const root = w.root === null ? null : remap(w.root)
        const file = w.file === null ? null : remap(w.file)
        const tabs = normalizeTabs(w.tabs.map(remap), file)
        return {
          ...w,
          root,
          file,
          tabs,
          // Focus Mode's lists (YAZ-1628, YAZ-1766): path lists like `tabs` — a renamed focus follows its folder.
          focusDirs: w.focusDirs.map(remap),
          focusFavorites: w.focusFavorites.map(remap),
        }
      })
      const recents = state.recents.map((r) => ({ ...r, path: remap(r.path) }))
      const folders = Object.fromEntries(
        Object.entries(state.folders).map(([root, folder]) => [
          remap(root),
          {
            ...folder,
            expanded: folder.expanded.map(remap),
            lastFile: folder.lastFile === null ? null : remap(folder.lastFile),
          },
        ]),
      )
      if (!changed) return
      commit({ ...state, windows, recents, folders })
    },

    removePath(deleted) {
      // The delete twin of `renamePath` above; read that first — the traversal is identical,
      // only the mapping differs (drop instead of remap). A FILE's prefix branch is inert
      // (nothing is ever stored under a file path), so one pass serves both kinds.
      let changed = false
      /** Is this stored path the deleted entry, or inside it? */
      const gone = (p: string): boolean => isWithin(deleted, p)
      const drop = (paths: readonly string[]): string[] => {
        const kept = paths.filter((p) => !gone(p))
        if (kept.length !== paths.length) changed = true
        return kept
      }
      const windows = state.windows.map((w) => {
        // `root` is NOT touched here — see the interface doc: the renderer's onRootMissing owns it.
        const tabs = drop(w.tabs)
        let file = w.file
        if (file !== null && gone(file)) {
          changed = true
          // The active file itself went. Pick an HEIR with the same ladder useWorkspace uses —
          // right neighbour, else left — rather than nulling `file`: normalizeTabs returns []
          // for a null file, which would throw away the window's SURVIVING tabs. The renderer
          // picks the same heir a moment later and mirrors it down, but the store is also the
          // boot snapshot, so it has to be correct on its own if the app quits in between.
          const i = w.tabs.indexOf(file)
          file = w.tabs.slice(i + 1).find((t) => !gone(t)) ?? [...w.tabs.slice(0, i)].reverse().find((t) => !gone(t)) ?? null
        }
        return {
          ...w,
          file,
          tabs: normalizeTabs(tabs, file),
          // Focus Mode's lists (YAZ-1628, YAZ-1766): a deleted focus target drops out, exactly as a deleted tab does above.
          focusDirs: drop(w.focusDirs),
          focusFavorites: drop(w.focusFavorites),
        }
      })
      const recents = state.recents.filter((r) => !gone(r.path))
      if (recents.length !== state.recents.length) changed = true
      /** A `lastFile` that went is forgotten, and that counts as a change worth committing. */
      const keepLastFile = (lastFile: string | null): string | null => {
        if (lastFile === null || !gone(lastFile)) return lastFile
        changed = true
        return null
      }
      const folders = Object.fromEntries(
        Object.entries(state.folders)
          .filter(([root]) => {
            if (!gone(root)) return true
            changed = true
            return false
          })
          .map(([root, folder]) => [
            root,
            {
              ...folder,
              expanded: drop(folder.expanded),
              lastFile: keepLastFile(folder.lastFile),
            },
          ]),
      )
      if (!changed) return
      commit({ ...state, windows, recents, folders })
    },

    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (dirty) return write()
      return chain
    },
  }
}
