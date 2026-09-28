/**
 * The window manager (GRO-2160): creates windows from `AppState.windows`, keeps their bounds
 * current, restores them all on launch, and never lets one die with unsaved edits (the
 * `app:flush` → `app:flushed` handshake). Electron-free — `main/index.ts` injects the
 * `BrowserWindow` factory and display geometry as a `WindowHost` — so everything here runs
 * under vitest with fakes.
 */
import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { fileKind } from '@shared/fileKind'
import { isWithin, sepOf } from '@shared/paths'
import { DEFAULT_SIDEBAR_LENS, type OpenWindowOptions, type RecentRoots, type WindowBounds, type WindowEntry } from '@shared/types'
import { CH } from '../channels'
import type { Store } from './store'

export interface WindowLike {
  webContents: { id: number }
}

/**
 * Which `AppState.windows` entry a renderer belongs to, keyed by `webContents.id`, so IPC
 * handlers can resolve their caller (`window.identity()` etc.). The lookup deliberately
 * knows nothing about Electron beyond the id.
 */
export interface WindowLookup {
  idFor(webContents: { id: number }): string | undefined
}

const byWebContents = new Map<number, string>()

/** Maps `win` to the state entry `id`; returns the unregister function (call it on `closed`). */
export function register(win: WindowLike, id: string): () => void {
  const wcId = win.webContents.id
  byWebContents.set(wcId, id)
  return () => {
    if (byWebContents.get(wcId) === id) byWebContents.delete(wcId)
  }
}

export function idFor(webContents: { id: number }): string | undefined {
  return byWebContents.get(webContents.id)
}

/** A hung save can never block close or quit: the flush handshake gives up after this long. */
export const FLUSH_TIMEOUT_MS = 5000
/** `move`/`resize` fire for every pixel of a drag; one store commit (= one `state:changed` broadcast) per burst. */
export const BOUNDS_DEBOUNCE_MS = 250
/** `duplicateWindow` offsets the copy so it does not sit exactly on its source. */
export const WINDOW_CASCADE_PX = 24

const DEFAULT_BOUNDS: WindowBounds = { x: 100, y: 100, width: 1200, height: 800 }

/** The slice of `BrowserWindow` the manager drives; a test fake implements it in a few lines. */
export interface ManagedWindow {
  webContents: { id: number; send(channel: string, ...args: unknown[]): void }
  getBounds(): WindowBounds
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
  /** Like Electron's: emits `close` first — the manager intercepts it to run the flush handshake. */
  close(): void
  /** Like Electron's: destroys without emitting `close` (`closed` still fires). */
  destroy(): void
  on(event: 'move' | 'resize' | 'closed' | 'focus', listener: () => void): unknown
  on(event: 'close', listener: (e: { preventDefault(): void }) => void): unknown
}

/** The Electron-only half, injected by `main/index.ts`: window construction and display geometry. */
export interface WindowHost {
  /** Builds the `BrowserWindow` at `entry.bounds` and loads `<renderer>?win=<entry.id>`. */
  create(entry: WindowEntry): ManagedWindow
  /** Every display's workArea, primary first (`clampBounds` keeps the earliest area on ties). */
  workAreas(): WindowBounds[]
  /** Whether `path` exists as a regular file — `routeToFile` (E1) probes before opening anything. */
  exists(path: string): boolean
  /** Whether `path` exists as a directory — `openRecentBeside` probes before touching the MRU (GRO-2211, moved here by YAZ-1767). */
  dirExists(path: string): boolean
}

export interface WindowManager extends WindowLookup {
  /** One window per stored entry, bounds clamped; an empty state seeds a single Welcome window (D3). */
  restoreAll(): void
  /** An independent window on `root`/`file`; the gesture is File › New Window on the Welcome screen. */
  openWindow(opts: OpenWindowOptions): void
  /** ⌘⇧N (GRO-2167): same folder + file as `from`, cascaded bounds, fresh id. Called straight from the menu. */
  duplicateWindow(from: WindowEntry): void
  /**
   * The ONE back-end door for "open a recent vault" (YAZ-1767 🔒 D1): the sidebar's vault
   * switcher (`window:open-recent`) and the menu's ⌥-click on Open Recent both land here. Probes
   * the directory FIRST (GRO-2211): a dead folder is pruned from the MRU and opens nothing →
   * `false`. A live one is bumped to the top of the MRU, then (🔒 YAZ-1767 D9) every live window already
   * on that vault is RAISED — most recently focused on top — and nothing new opens; with none
   * open, a new window opens on the vault's remembered `folders[root].lastFile` (D2). → `true`.
   */
  openRecentBeside(path: string): boolean
  /**
   * `window:close-self` (GRO-2232, e.g. ⌘W on the last tab): the REAL `close()` on the live
   * window — the `close` interception above runs the flush handshake — NEVER a bare destroy.
   * No live window for `id` (mid-close race) is a no-op.
   */
  closeWindow(id: string): void
  /** A `yaseendraw://` link resolved to `path` (E1, GRO-2171): validate, then `resolveLinkTarget` routes it. */
  routeToFile(path: string, rootOverride?: string | null): void
  /** The unobtrusive can't-open surface (E1): restore + focus a live window, send `link:notice`. Never a dialog. */
  linkNotice(message: string): void
  /** `app:flushed` arrived from this renderer (wired in `ipc/window.ts`). */
  handleFlushed(sender: { id: number }): void
  /** `before-quit`: handshake every window sequentially; `windows[]` is kept so relaunch restores them. */
  flushAllForQuit(): Promise<void>
}

/** What the IPC layer (`ipc/window.ts`) needs from the manager; tests fake just this slice. */
export type WindowManagerIpc = Pick<WindowManager, 'idFor' | 'openWindow' | 'openRecentBeside' | 'closeWindow' | 'handleFlushed'>

// ---------- bounds clamping (pure) ----------

const overlapArea = (a: WindowBounds, b: WindowBounds): number => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

const centreDistanceSq = (a: WindowBounds, b: WindowBounds): number => {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2)
  const dy = a.y + a.height / 2 - (b.y + b.height / 2)
  return dx * dx + dy * dy
}

/**
 * Restored bounds must land on a display that still exists: the window goes fully inside the
 * work area it overlaps most (fully off-screen → the nearest one; ties keep the earliest, so
 * callers pass the primary first), shrunk to fit if oversized. No work areas at all leaves
 * the bounds alone (nothing to clamp against).
 */
export function clampBounds(bounds: WindowBounds, workAreas: readonly WindowBounds[]): WindowBounds {
  if (workAreas.length === 0) return bounds
  let area = workAreas[0]
  let best = overlapArea(bounds, area)
  for (const wa of workAreas) {
    const o = overlapArea(bounds, wa)
    if (o > best) {
      area = wa
      best = o
    }
  }
  if (best === 0) area = workAreas.reduce((a, b) => (centreDistanceSq(bounds, b) < centreDistanceSq(bounds, a) ? b : a))
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}

const sameBounds = (a: WindowBounds, b: WindowBounds): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// ---------- deep-link routing (pure, E1 GRO-2171) ----------

export type LinkTarget = { kind: 'existing'; id: string } | { kind: 'new'; root: string; file: string }

/** Trailing slash off (never off `/` itself), so `/v` and `/v/` name the same root. */
const stripSlash = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/** The folder `path` sits in, by its own separator's rules — a Windows path's parent is not posix's `.` (YAZ-2073 2D). */
const parentDir = (path: string): string => (sepOf(path) === '\\' ? win32 : posix).dirname(path)

/**
 * Where a `yaseendraw://` link to `path` should land: (1) the open window whose root contains
 * it — most specific root wins, ties keep the first in `windows[]`, Welcome windows never match;
 * (2) a new window on the most recent `recents` folder containing it (the list is already
 * most-recent-first); (3) a new window on the file's parent folder. A containing `rootOverride`
 * pins the effective root instead: the open window on exactly that root, else a new window there.
 */
export function resolveLinkTarget(
  path: string,
  windows: readonly WindowEntry[],
  recents: RecentRoots,
  rootOverride?: string | null,
): LinkTarget {
  if (rootOverride != null && isWithin(rootOverride, path, true)) {
    const exact = windows.find((w) => w.root !== null && stripSlash(w.root) === stripSlash(rootOverride))
    return exact === undefined ? { kind: 'new', root: rootOverride, file: path } : { kind: 'existing', id: exact.id }
  }
  let best: { id: string; rootLength: number } | undefined
  for (const w of windows) {
    if (w.root === null || !isWithin(w.root, path, true)) continue
    if (best === undefined || w.root.length > best.rootLength) best = { id: w.id, rootLength: w.root.length }
  }
  if (best !== undefined) return { kind: 'existing', id: best.id }
  const recent = recents.find((r) => isWithin(r.path, path, true))
  if (recent !== undefined) return { kind: 'new', root: recent.path, file: path }
  return { kind: 'new', root: parentDir(path), file: path }
}

// ---------- the manager ----------

export function createWindowManager(store: Store, host: WindowHost): WindowManager {
  /** Live windows by state entry id (dropped again in `closed`). */
  const live = new Map<string, ManagedWindow>()
  /** In-flight flush handshakes by `webContents.id`; `settle` answers ack and timeout alike. */
  const pendingFlush = new Map<number, { done: Promise<void>; settle: () => void }>()
  /** Windows closing as part of the quit keep their state entry so relaunch restores them. */
  let quitting = false
  /**
   * Live window ids, most recently FOCUSED first (YAZ-1767 D9): `focus` moves an id to the front,
   * `closed` drops it. A window that has never been focused is not in the list at all — it ranks
   * last when the door raises a vault's windows.
   */
  const focusOrder: string[] = []
  const noteFocused = (id: string): void => {
    const at = focusOrder.indexOf(id)
    if (at !== -1) focusOrder.splice(at, 1)
    focusOrder.unshift(id)
  }

  const entryOf = (id: string): WindowEntry | undefined => store.get().windows.find((w) => w.id === id)

  /**
   * One handshake: send `app:flush`, resolve on `handleFlushed` from the same renderer or after
   * FLUSH_TIMEOUT_MS. A second request while one is pending joins it (a close racing the quit).
   */
  const flushRenderer = (win: ManagedWindow): Promise<void> => {
    const wcId = win.webContents.id
    const pending = pendingFlush.get(wcId)
    if (pending !== undefined) return pending.done
    let resolve!: () => void
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const timer = setTimeout(settle, FLUSH_TIMEOUT_MS)
    function settle(): void {
      clearTimeout(timer)
      pendingFlush.delete(wcId)
      resolve()
    }
    pendingFlush.set(wcId, { done, settle })
    win.webContents.send(CH.appFlush)
    return done
  }

  /** Patch only `bounds` onto the entry as it is NOW (the renderer may have changed root/file since). */
  const commitBounds = (id: string, win: ManagedWindow): void => {
    const entry = entryOf(id)
    if (entry === undefined || win.isDestroyed()) return
    const bounds = win.getBounds()
    if (!sameBounds(bounds, entry.bounds)) store.upsertWindow({ ...entry, bounds })
  }

  const attach = (entry: WindowEntry): void => {
    const win = host.create(entry)
    const { id } = entry
    const unregister = register(win, id)
    live.set(id, win)

    let boundsTimer: ReturnType<typeof setTimeout> | null = null
    const cancelBoundsTimer = (): void => {
      if (boundsTimer !== null) {
        clearTimeout(boundsTimer)
        boundsTimer = null
      }
    }
    const scheduleBounds = (): void => {
      cancelBoundsTimer()
      boundsTimer = setTimeout(() => {
        boundsTimer = null
        commitBounds(id, win)
      }, BOUNDS_DEBOUNCE_MS)
    }
    win.on('move', scheduleBounds)
    win.on('resize', scheduleBounds)
    win.on('focus', () => noteFocused(id))

    /** `close` is always intercepted: the window only goes away via `destroy()` after its flush. */
    let closing = false
    win.on('close', (e) => {
      e.preventDefault()
      if (closing || quitting) return // its handshake is already running (or the quit sequence owns it)
      closing = true
      cancelBoundsTimer()
      commitBounds(id, win)
      void flushRenderer(win).then(() => {
        if (!win.isDestroyed()) win.destroy()
      })
    })

    win.on('closed', () => {
      cancelBoundsTimer()
      unregister()
      live.delete(id)
      const at = focusOrder.indexOf(id)
      if (at !== -1) focusOrder.splice(at, 1)
      // A user close forgets the window; the LAST one closing quits the app (`window-all-closed`), so that is a quit too.
      if (!quitting && live.size > 0) store.removeWindow(id)
    })
  }

  const open = (entry: WindowEntry): void => {
    store.upsertWindow(entry)
    attach(entry)
  }

  const openWindow = (opts: OpenWindowOptions): void => {
    open({ id: randomUUID(), root: opts.root, file: opts.file, tabs: opts.file === null ? [] : [opts.file], sidebarCollapsed: false, sidebarLens: DEFAULT_SIDEBAR_LENS, focusDirs: [], focusFavorites: [], bounds: clampBounds({ ...DEFAULT_BOUNDS }, host.workAreas()) })
  }

  const focusWindow = (win: ManagedWindow): void => {
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  /** E1: restore + focus a live window and hand it the can't-open message. No live window → nothing to say it in. */
  const linkNotice = (message: string): void => {
    const win = [...live.values()].find((w) => !w.isDestroyed())
    if (win === undefined) return
    focusWindow(win)
    win.webContents.send(CH.linkNotice, message)
  }

  return {
    idFor,

    restoreAll() {
      let entries = store.get().windows
      if (entries.length === 0) {
        // First launch: one window on the Welcome screen (root null; the screen itself is C2).
        const first: WindowEntry = { id: randomUUID(), root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: DEFAULT_SIDEBAR_LENS, focusDirs: [], focusFavorites: [], bounds: { ...DEFAULT_BOUNDS } }
        store.upsertWindow(first)
        entries = [first]
      }
      const areas = host.workAreas()
      for (const entry of entries) {
        const bounds = clampBounds(entry.bounds, areas)
        const next = sameBounds(bounds, entry.bounds) ? entry : { ...entry, bounds }
        if (next !== entry) store.upsertWindow(next)
        attach(next)
      }
    },

    openWindow,

    duplicateWindow(from) {
      const cascaded = { ...from.bounds, x: from.bounds.x + WINDOW_CASCADE_PX, y: from.bounds.y + WINDOW_CASCADE_PX }
      // Clone every ordered path list so the new window's durable identity cannot alias the source;
      // sidebar visibility, the lens and both Focus Mode lists (YAZ-1628, YAZ-1766) are copied by value and then persist independently.
      open({
        id: randomUUID(),
        root: from.root,
        file: from.file,
        tabs: [...from.tabs],
        sidebarCollapsed: from.sidebarCollapsed,
        sidebarLens: from.sidebarLens,
        focusDirs: [...from.focusDirs],
        focusFavorites: [...from.focusFavorites],
        bounds: clampBounds(cascaded, host.workAreas()),
      })
    },

    openRecentBeside(path) {
      // Beside never passes through the renderer's validating openRoot, so probe here: a dead
      // folder is pruned from the MRU (mirrors the Welcome/in-place path) and opens nothing.
      if (!host.dirExists(path)) {
        store.removeRecent(path)
        return false
      }
      // Opening beside never lands in the renderer that bumps the MRU on an in-place open, so bump here.
      store.pushRecent(path)
      // Already open (YAZ-1767 🔒 D9): raise that vault's live windows instead of opening a third
      // copy — LEAST recently focused first, so the most recently focused one ends on top (a
      // window never focused ranks last). Roots compare like `resolveLinkTarget`: trailing slash off.
      const wanted = stripSlash(path)
      const alreadyOpen = store
        .get()
        .windows.filter((w) => w.root !== null && stripSlash(w.root) === wanted)
        .map((w) => ({ id: w.id, win: live.get(w.id) }))
        .filter((w): w is { id: string; win: ManagedWindow } => w.win !== undefined && !w.win.isDestroyed())
      if (alreadyOpen.length > 0) {
        const rank = (id: string): number => {
          const at = focusOrder.indexOf(id)
          return at === -1 ? Number.POSITIVE_INFINITY : at
        }
        for (const { win } of alreadyOpen.sort((a, b) => rank(b.id) - rank(a.id))) focusWindow(win)
        return true
      }
      openWindow({ root: path, file: store.get().folders[path]?.lastFile ?? null })
      return true
    },

    closeWindow(id) {
      const win = live.get(id)
      if (win !== undefined && !win.isDestroyed()) win.close()
    },

    routeToFile(path, rootOverride) {
      // Validate first (E1): a supported file kind and a live regular file. Anything off →
      // notice, never a dialog; the renderer's kind dispatch decides what mounts.
      if (fileKind(path) === null) {
        linkNotice(`Can't open ${path}: unsupported file type`)
        return
      }
      if (!host.exists(path)) {
        linkNotice(`Can't open ${path}: file not found`)
        return
      }
      const state = store.get()
      const target = resolveLinkTarget(path, state.windows, state.recents, rootOverride)
      if (target.kind === 'new') {
        openWindow({ root: target.root, file: target.file })
        return
      }
      const win = live.get(target.id)
      if (win === undefined || win.isDestroyed()) {
        // A stored entry with no live window (mid-close race): fall back to a fresh window on its root.
        const entry = state.windows.find((w) => w.id === target.id)
        openWindow({ root: entry?.root ?? parentDir(path), file: path })
        return
      }
      focusWindow(win)
      win.webContents.send(CH.linkOpenFile, path)
    },

    linkNotice,

    handleFlushed(sender) {
      pendingFlush.get(sender.id)?.settle()
    },

    async flushAllForQuit() {
      quitting = true
      for (const [id, win] of [...live]) {
        if (win.isDestroyed()) continue
        commitBounds(id, win)
        await flushRenderer(win)
        if (!win.isDestroyed()) win.destroy()
      }
    },
  }
}
