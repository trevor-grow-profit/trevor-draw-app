import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RecentRoots, WindowBounds, WindowEntry } from '@shared/types'
import { CH } from '../channels'
import { createStore, type Store } from './store'
import {
  BOUNDS_DEBOUNCE_MS,
  FLUSH_TIMEOUT_MS,
  WINDOW_CASCADE_PX,
  clampBounds,
  createWindowManager,
  resolveLinkTarget,
  type ManagedWindow,
  type WindowHost,
} from './windows'

// ---------- clampBounds (pure) ----------

describe('clampBounds', () => {
  const primary: WindowBounds = { x: 0, y: 0, width: 1440, height: 900 }
  const secondary: WindowBounds = { x: 1440, y: 0, width: 1920, height: 1080 }

  it('leaves a window fully inside a display untouched', () => {
    const b = { x: 100, y: 100, width: 800, height: 600 }
    expect(clampBounds(b, [primary, secondary])).toEqual(b)
  })

  it('nudges a partially visible window fully onto its display', () => {
    expect(clampBounds({ x: -200, y: -50, width: 800, height: 600 }, [primary])).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(clampBounds({ x: 1200, y: 700, width: 800, height: 600 }, [primary])).toEqual({ x: 640, y: 300, width: 800, height: 600 })
  })

  it('brings a fully off-screen window onto the nearest display', () => {
    // Far right of both displays: the secondary is nearest.
    expect(clampBounds({ x: 5000, y: 200, width: 800, height: 600 }, [primary, secondary])).toEqual({ x: 2560, y: 200, width: 800, height: 600 })
    // Far below the primary: the primary is nearest.
    expect(clampBounds({ x: 100, y: 5000, width: 800, height: 600 }, [primary, secondary])).toEqual({ x: 100, y: 300, width: 800, height: 600 })
  })

  it('shrinks an oversized window to the work area', () => {
    expect(clampBounds({ x: -100, y: -100, width: 3000, height: 2000 }, [primary])).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
  })

  it('a window spanning two displays snaps into the one holding the larger share', () => {
    // 440px of the width sit on the primary, 360px on the secondary.
    expect(clampBounds({ x: 1000, y: 100, width: 800, height: 600 }, [primary, secondary])).toEqual({ x: 640, y: 100, width: 800, height: 600 })
  })

  it('no work areas at all (headless edge) leaves the bounds alone', () => {
    const b = { x: 9000, y: 9000, width: 800, height: 600 }
    expect(clampBounds(b, [])).toEqual(b)
  })
})

// ---------- the manager, against fakes ----------

let nextWebContentsId = 100

/** A `ManagedWindow` stand-in: records sends, replays events, destroys like Electron (`closed` fires, `close` does not). */
class FakeWindow {
  webContents = { id: nextWebContentsId++, send: vi.fn() }
  destroyed = false
  minimized = false
  focusCount = 0
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  constructor(public bounds: WindowBounds) {}
  focus(): void {
    this.focusCount++
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }
  emit(event: 'move' | 'resize' | 'focus'): void {
    for (const l of this.listeners.get(event) ?? []) l()
  }
  /** What Electron does on a user close: emit `close`; destroy only when nobody preventDefault-ed. */
  close(): void {
    let prevented = false
    for (const l of this.listeners.get('close') ?? []) l({ preventDefault: () => (prevented = true) })
    if (!prevented) this.destroy()
  }
  getBounds(): WindowBounds {
    return { ...this.bounds }
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const l of this.listeners.get('closed') ?? []) l()
  }
  flushCount(): number {
    return this.webContents.send.mock.calls.filter(([ch]) => ch === CH.appFlush).length
  }
}

const AREA: WindowBounds = { x: 0, y: 0, width: 1440, height: 900 }

function makeHost(
  areas: WindowBounds[] = [AREA],
  exists: (path: string) => boolean = () => true,
  dirExists: (path: string) => boolean = () => true,
): { host: WindowHost; created: Array<{ entry: WindowEntry; win: FakeWindow }> } {
  const created: Array<{ entry: WindowEntry; win: FakeWindow }> = []
  const host: WindowHost = {
    create(entry) {
      const win = new FakeWindow({ ...entry.bounds })
      created.push({ entry, win })
      return win as ManagedWindow
    },
    workAreas: () => areas,
    exists,
    dirExists,
  }
  return { host, created }
}

let dir: string
let store: Store
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yd-windows-'))
  store = createStore(path.join(dir, 'yaseendraw.json'))
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.useRealTimers()
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

/** Two stored windows, restored: the common close/quit fixture. */
function seedTwo() {
  store.upsertWindow({ id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 10, y: 10, width: 800, height: 600 } })
  store.upsertWindow({ id: 'w2', root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 40, y: 40, width: 800, height: 600 } })
  const { host, created } = makeHost()
  const manager = createWindowManager(store, host)
  manager.restoreAll()
  return { manager, w1: created[0].win, w2: created[1].win }
}

describe('createWindowManager: restore', () => {
  it('first launch seeds one Welcome window (root null, D3) and persists it', () => {
    const { host, created } = makeHost()
    createWindowManager(store, host).restoreAll()
    expect(created).toHaveLength(1)
    expect(created[0].entry.root).toBeNull()
    expect(created[0].entry.file).toBeNull()
    expect(created[0].entry.tabs).toEqual([])
    expect(created[0].entry.sidebarCollapsed).toBe(false)
    expect(store.get().windows).toEqual([created[0].entry])
  })

  it('restores every stored entry, clamping lost bounds back onto a display and persisting the clamp', () => {
    store.upsertWindow({ id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 10, y: 10, width: 800, height: 600 } })
    store.upsertWindow({ id: 'w2', root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 9000, y: 9000, width: 800, height: 600 } })
    const { host, created } = makeHost()
    createWindowManager(store, host).restoreAll()
    expect(created.map((c) => c.entry.id)).toEqual(['w1', 'w2'])
    expect(created[0].entry.bounds).toEqual({ x: 10, y: 10, width: 800, height: 600 })
    expect(created[1].entry.bounds).toEqual({ x: 640, y: 300, width: 800, height: 600 })
    expect(store.get().windows.find((w) => w.id === 'w2')?.bounds).toEqual({ x: 640, y: 300, width: 800, height: 600 })
  })

  it('registers every window it creates so IPC can resolve its caller', () => {
    const { manager, w1 } = seedTwo()
    expect(manager.idFor(w1.webContents)).toBe('w1')
  })
})

describe('createWindowManager: bounds', () => {
  it('saves moved/resized bounds once per burst (debounced), onto the entry as it is now', () => {
    store.upsertWindow({ id: 'w1', root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 10, y: 10, width: 800, height: 600 } })
    const { host, created } = makeHost()
    createWindowManager(store, host).restoreAll()
    const win = created[0].win
    // The renderer picked a folder mid-drag: the bounds commit must not undo it.
    store.upsertWindow({ ...store.get().windows[0], root: '/v' })
    let changes = 0
    store.onChange(() => changes++)
    win.bounds = { x: 50, y: 60, width: 900, height: 700 }
    win.emit('move')
    win.emit('resize')
    win.emit('move')
    expect(changes).toBe(0)
    vi.advanceTimersByTime(BOUNDS_DEBOUNCE_MS)
    expect(changes).toBe(1)
    expect(store.get().windows[0]).toEqual({ id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 50, y: 60, width: 900, height: 700 } })
  })
})

describe('createWindowManager: close', () => {
  it('intercepts close, waits for app:flushed, then destroys and drops the entry', async () => {
    const { manager, w1 } = seedTwo()
    w1.close()
    expect(w1.flushCount()).toBe(1)
    expect(w1.isDestroyed()).toBe(false)
    manager.handleFlushed(w1.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(w1.isDestroyed()).toBe(true)
    expect(store.get().windows.map((w) => w.id)).toEqual(['w2'])
    expect(manager.idFor(w1.webContents)).toBeUndefined()
  })

  it('the last window keeps its entry (its close is the quit) and saves its final bounds', async () => {
    store.upsertWindow({ id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 10, y: 10, width: 800, height: 600 } })
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    manager.restoreAll()
    const win = created[0].win
    win.bounds = { x: 200, y: 100, width: 800, height: 600 }
    win.close()
    manager.handleFlushed(win.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(win.isDestroyed()).toBe(true)
    expect(store.get().windows).toEqual([{ id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 200, y: 100, width: 800, height: 600 } }])
  })

  it('a hung renderer cannot block close: the handshake times out after FLUSH_TIMEOUT_MS', async () => {
    const { w1 } = seedTwo()
    w1.close()
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1)
    expect(w1.isDestroyed()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(w1.isDestroyed()).toBe(true)
  })

  it('a second close while the flush is pending does not start a second handshake', () => {
    const { w1 } = seedTwo()
    w1.close()
    w1.close()
    expect(w1.flushCount()).toBe(1)
    expect(w1.isDestroyed()).toBe(false)
  })

  it('closeWindow (window:close-self, GRO-2232) runs the REAL close path: flush handshake, then destroy and drop', async () => {
    const { manager, w1 } = seedTwo()
    manager.closeWindow('w1')
    expect(w1.flushCount()).toBe(1)
    expect(w1.isDestroyed()).toBe(false) // never a bare destroy — the handshake holds the window
    manager.handleFlushed(w1.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(w1.isDestroyed()).toBe(true)
    expect(store.get().windows.map((w) => w.id)).toEqual(['w2'])
  })

  it('closeWindow on an unknown or already-destroyed id is a no-op (mid-close race)', async () => {
    const { manager, w1, w2 } = seedTwo()
    manager.closeWindow('nope')
    expect(w1.flushCount()).toBe(0)
    expect(w2.flushCount()).toBe(0)
    w1.close()
    manager.handleFlushed(w1.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(w1.isDestroyed()).toBe(true)
    manager.closeWindow('w1') // gone: nothing to close, nothing thrown
    expect(w1.flushCount()).toBe(1)
  })
})

describe('createWindowManager: quit', () => {
  it('flushes every window at once, keeps all entries, saves final bounds, then resolves (YAZ-2073 5G)', async () => {
    const { manager, w1, w2 } = seedTwo()
    w1.bounds = { x: 111, y: 11, width: 800, height: 600 }
    const done = vi.fn()
    void manager.flushAllForQuit().then(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(w1.flushCount()).toBe(1)
    expect(w2.flushCount()).toBe(1) // in parallel: w2 is asked without waiting for w1's ack
    manager.handleFlushed(w1.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(w1.isDestroyed()).toBe(true)
    expect(w2.isDestroyed()).toBe(false)
    expect(done).not.toHaveBeenCalled()
    manager.handleFlushed(w2.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(w2.isDestroyed()).toBe(true)
    expect(done).toHaveBeenCalled()
    expect(store.get().windows.map((w) => w.id)).toEqual(['w1', 'w2'])
    expect(store.get().windows[0].bounds).toEqual({ x: 111, y: 11, width: 800, height: 600 })
  })

  it('hung renderers cannot block quit: their handshakes time out together, so N windows cost ONE timeout (YAZ-2073 5G)', async () => {
    const { manager, w1, w2 } = seedTwo()
    const done = vi.fn()
    void manager.flushAllForQuit().then(done)
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1)
    expect(w1.isDestroyed()).toBe(false)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(w1.isDestroyed()).toBe(true)
    expect(w2.isDestroyed()).toBe(true)
    expect(done).toHaveBeenCalled()
    expect(store.get().windows).toHaveLength(2)
  })

  it('a close that lands mid-quit joins the running handshake instead of racing it', async () => {
    const { manager, w1 } = seedTwo()
    void manager.flushAllForQuit()
    await vi.advanceTimersByTimeAsync(0)
    w1.close()
    expect(w1.flushCount()).toBe(1)
    manager.handleFlushed(w1.webContents)
    await vi.advanceTimersByTimeAsync(0)
    expect(w1.isDestroyed()).toBe(true)
    expect(store.get().windows).toHaveLength(2) // quit keeps every entry
  })
})

describe('createWindowManager: openRecentBeside (YAZ-1767 D1 — the one open-recent door)', () => {
  it('a live folder: bumps it to the top of the MRU, opens a window on its remembered last file (D2), returns true', () => {
    store.pushRecent('/v/other', 1)
    store.pushRecent('/v/notes', 2)
    store.setFolder('/v/other', { lastFile: '/v/other/Start here.excalidraw' })
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    expect(manager.openRecentBeside('/v/other')).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].entry.root).toBe('/v/other')
    expect(created[0].entry.file).toBe('/v/other/Start here.excalidraw')
    expect(created[0].entry.tabs).toEqual(['/v/other/Start here.excalidraw'])
    expect(store.get().recents.map((r) => r.path)).toEqual(['/v/other', '/v/notes'])
    expect(store.get().windows).toEqual([created[0].entry])
  })

  it('a vault with no remembered file opens on nothing (file null, no tabs)', () => {
    const { host, created } = makeHost()
    expect(createWindowManager(store, host).openRecentBeside('/v/fresh')).toBe(true)
    expect(created[0].entry.file).toBeNull()
    expect(created[0].entry.tabs).toEqual([])
    expect(store.get().recents[0]?.path).toBe('/v/fresh')
  })

  it('D9: the vault is already open in ONE window → that window is raised, nothing new opens, true', () => {
    store.upsertWindow({ id: 'w1', root: '/v/other/', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    manager.restoreAll()
    expect(created).toHaveLength(1)
    const w1 = created[0].win
    w1.minimized = true
    // Trailing slash on the stored root, none on the request: `resolveLinkTarget`'s comparison.
    expect(manager.openRecentBeside('/v/other')).toBe(true)
    expect(created).toHaveLength(1)
    expect(w1.focusCount).toBe(1)
    expect(w1.minimized).toBe(false)
    expect(store.get().recents[0]?.path).toBe('/v/other')
    expect(store.get().windows).toHaveLength(1)
  })

  it('D9: two windows on the vault, focus history A then B → raised A then B, so B (most recently focused) ends on top', () => {
    const entry = (id: string) => ({ id, root: '/v/other', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files' as const, focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
    store.upsertWindow(entry('a'))
    store.upsertWindow(entry('b'))
    store.upsertWindow({ ...entry('c'), root: '/v/notes' })
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    manager.restoreAll()
    const [a, b, c] = created.map((x) => x.win)
    const order: string[] = []
    a.focus = () => order.push('a')
    b.focus = () => order.push('b')
    c.focus = () => order.push('c')
    a.emit('focus')
    b.emit('focus')
    expect(manager.openRecentBeside('/v/other')).toBe(true)
    expect(order).toEqual(['a', 'b'])
    expect(created).toHaveLength(3)

    // The history moves: A focused again → A on top; C (another vault) is never touched.
    order.length = 0
    a.emit('focus')
    expect(manager.openRecentBeside('/v/other')).toBe(true)
    expect(order).toEqual(['b', 'a'])
  })

  it('D9: a window never focused ranks LAST (raised first, ends underneath)', () => {
    const entry = (id: string) => ({ id, root: '/v/other', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files' as const, focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
    store.upsertWindow(entry('a'))
    store.upsertWindow(entry('b'))
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    manager.restoreAll()
    const [a, b] = created.map((x) => x.win)
    const order: string[] = []
    a.focus = () => order.push('a')
    b.focus = () => order.push('b')
    a.emit('focus')
    expect(manager.openRecentBeside('/v/other')).toBe(true)
    expect(order).toEqual(['b', 'a'])
  })

  it('D9: a matching entry with NO live window (mid-close) falls through to a new window', () => {
    store.upsertWindow({ id: 'w1', root: '/v/other', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    manager.restoreAll()
    created[0].win.destroy() // `closed` fires: the manager forgets the live window and its focus rank
    expect(manager.openRecentBeside('/v/other')).toBe(true)
    expect(created).toHaveLength(2)
    expect(created[1].entry.root).toBe('/v/other')
  })

  it('a dead folder: pruned from the MRU, no window, returns false (GRO-2211)', () => {
    store.pushRecent('/v/gone', 1)
    store.pushRecent('/v/notes', 2)
    const { host, created } = makeHost([AREA], () => true, (p) => p !== '/v/gone')
    expect(createWindowManager(store, host).openRecentBeside('/v/gone')).toBe(false)
    expect(created).toHaveLength(0)
    expect(store.get().windows).toEqual([])
    expect(store.get().recents.map((r) => r.path)).toEqual(['/v/notes'])
  })
})

describe('createWindowManager: openWindow / duplicateWindow (D6 plumbing)', () => {
  it('openWindow creates an independent window and persists its entry', () => {
    const { host, created } = makeHost()
    const manager = createWindowManager(store, host)
    manager.openWindow({ root: '/v', file: '/v/a.excalidraw' })
    expect(created).toHaveLength(1)
    expect(created[0].entry.root).toBe('/v')
    expect(created[0].entry.file).toBe('/v/a.excalidraw')
    expect(created[0].entry.tabs).toEqual(['/v/a.excalidraw']) // the opened file is the one tab (GRO-2232)
    expect(created[0].entry.sidebarCollapsed).toBe(false)
    expect(created[0].entry.sidebarLens).toBe('files') // a new window starts on Files (YAZ-847, YAZ-1628)
    expect(created[0].entry.focusDirs).toEqual([]) // a new window starts unfocused (YAZ-1628)
    expect(created[0].entry.focusFavorites).toEqual([])
    expect(store.get().windows).toEqual([created[0].entry])
  })

  it('duplicateWindow copies the complete workspace identity, then the two entries can diverge', () => {
    const from: WindowEntry = { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], sidebarCollapsed: true, sidebarLens: 'favorites', focusDirs: ['/v/a'], focusFavorites: ['/v/F'], bounds: { x: 100, y: 100, width: 800, height: 600 } }
    store.upsertWindow(from)
    const { host, created } = makeHost()
    createWindowManager(store, host).duplicateWindow(from)
    expect(created).toHaveLength(1)
    const entry = created[0].entry
    expect(entry.id).not.toBe('w1')
    expect(entry.root).toBe('/v')
    expect(entry.file).toBe('/v/a.excalidraw')
    expect(entry.tabs).toEqual(['/v/a.excalidraw', '/v/b.excalidraw']) // the copy carries every tab, not just the active file (GRO-2232)
    expect(entry.sidebarCollapsed).toBe(true)
    expect(entry.sidebarLens).toBe('favorites') // the lens comes along too (YAZ-1628)
    // Both Focus Mode lists come along BY VALUE (YAZ-1628): the copy holds the same paths in fresh arrays.
    expect(entry.focusDirs).toEqual(['/v/a'])
    expect(entry.focusFavorites).toEqual(['/v/F'])
    expect(entry.focusDirs).not.toBe(from.focusDirs)
    expect(entry.focusFavorites).not.toBe(from.focusFavorites)
    expect(entry.bounds).toEqual({ x: 100 + WINDOW_CASCADE_PX, y: 100 + WINDOW_CASCADE_PX, width: 800, height: 600 })
    expect(store.get().windows).toContainEqual(entry)
    store.upsertWindow({ ...entry, sidebarCollapsed: false })
    expect(store.get().windows.find((w) => w.id === 'w1')?.sidebarCollapsed).toBe(true)
    expect(store.get().windows.find((w) => w.id === entry.id)?.sidebarCollapsed).toBe(false)
    from.focusDirs.push('/v/mutated') // mutating the source afterwards never reaches the copy
    from.focusFavorites.push('/v/Mutated')
    expect(entry.focusDirs).toEqual(['/v/a'])
    expect(entry.focusFavorites).toEqual(['/v/F'])
  })

  it('duplicating a Welcome window keeps root and file null — Welcome → Welcome (⌘⇧N, GRO-2167)', () => {
    const from: WindowEntry = { id: 'w1', root: null, file: null, tabs: [], sidebarCollapsed: true, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 100, y: 100, width: 800, height: 600 } }
    store.upsertWindow(from)
    const { host, created } = makeHost()
    createWindowManager(store, host).duplicateWindow(from)
    expect(created).toHaveLength(1)
    expect(created[0].entry.id).not.toBe('w1')
    expect(created[0].entry.root).toBeNull()
    expect(created[0].entry.file).toBeNull()
    expect(store.get().windows.map((w) => w.id)).toEqual(['w1', created[0].entry.id])
  })

  it('the cascade is clamped: duplicating a window at the display edge stays fully on-screen (GRO-2167)', () => {
    // Bottom-right corner of the 1440×900 area: the +24/+24 cascade would hang off the display.
    const from: WindowEntry = { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 640, y: 300, width: 800, height: 600 } }
    store.upsertWindow(from)
    const { host, created } = makeHost()
    createWindowManager(store, host).duplicateWindow(from)
    expect(created[0].entry.bounds).toEqual({ x: 640, y: 300, width: 800, height: 600 })
  })
})

// ---------- deep-link routing (E1, GRO-2171) ----------

describe('resolveLinkTarget (pure)', () => {
  const win = (id: string, root: string | null): WindowEntry => ({ id, root, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
  const recents = (...paths: string[]): RecentRoots => paths.map((path, i) => ({ path, lastOpened: 100 - i }))

  it('picks the open window whose root contains the path (root = dirname included)', () => {
    expect(resolveLinkTarget('/v/a.excalidraw', [win('w1', '/v')], [])).toEqual({ kind: 'existing', id: 'w1' })
    expect(resolveLinkTarget('/v/sub/deep/a.excalidraw', [win('w1', '/v')], [])).toEqual({ kind: 'existing', id: 'w1' })
  })

  it('containment is by path segment: /a/b does not contain /a/bc/x.excalidraw', () => {
    expect(resolveLinkTarget('/a/bc/x.excalidraw', [win('w1', '/a/b')], [])).toEqual({ kind: 'new', root: '/a/bc', file: '/a/bc/x.excalidraw' })
  })

  it('the most specific (longest) containing root wins; a tie keeps the first in windows[]', () => {
    const windows = [win('w1', '/v'), win('w2', '/v/sub'), win('w3', '/v/sub')]
    expect(resolveLinkTarget('/v/sub/a.excalidraw', windows, [])).toEqual({ kind: 'existing', id: 'w2' })
  })

  it('Welcome windows (root null) are never targets', () => {
    expect(resolveLinkTarget('/v/a.excalidraw', [win('w1', null)], [])).toEqual({ kind: 'new', root: '/v', file: '/v/a.excalidraw' })
  })

  it('no containing window: the first (most recent) recents entry containing the path roots a new window', () => {
    const target = resolveLinkTarget('/w/sub/b.excalidraw', [win('w1', '/v')], recents('/other', '/w', '/w/sub'))
    expect(target).toEqual({ kind: 'new', root: '/w', file: '/w/sub/b.excalidraw' })
  })

  it('nothing contains the path: a new window rooted at its parent folder', () => {
    expect(resolveLinkTarget('/elsewhere/deep/c.excalidraw', [win('w1', '/v')], recents('/w'))).toEqual({
      kind: 'new',
      root: '/elsewhere/deep',
      file: '/elsewhere/deep/c.excalidraw',
    })
  })

  it('a Finder double-click on a drawing OUTSIDE every open vault opens its PARENT FOLDER as the vault (YAZ-1815)', () => {
    // The file association travels this same path (`open-file` / argv → `yaseendraw://` → here),
    // so a board that belongs to no open and no recent vault still opens — in a new window whose
    // root is the folder the file sits in.
    expect(resolveLinkTarget('/Users/me/Desktop/Sketch.excalidraw', [win('w1', '/v')], [])).toEqual({
      kind: 'new',
      root: '/Users/me/Desktop',
      file: '/Users/me/Desktop/Sketch.excalidraw',
    })
  })

  it('a containing rootOverride wins: the open window on exactly that root first, else a new window there', () => {
    const windows = [win('w1', '/v'), win('w2', '/v/sub')]
    // Without the override, the more specific /v/sub would win; the override pins /v.
    expect(resolveLinkTarget('/v/sub/a.excalidraw', windows, [], '/v')).toEqual({ kind: 'existing', id: 'w1' })
    expect(resolveLinkTarget('/v/sub/a.excalidraw', [], [], '/v')).toEqual({ kind: 'new', root: '/v', file: '/v/sub/a.excalidraw' })
  })

  it('a rootOverride that does not contain the path is ignored', () => {
    expect(resolveLinkTarget('/v/a.excalidraw', [win('w1', '/v')], [], '/w')).toEqual({ kind: 'existing', id: 'w1' })
    expect(resolveLinkTarget('/v/a.excalidraw', [], [], null)).toEqual({ kind: 'new', root: '/v', file: '/v/a.excalidraw' })
  })
})

describe('createWindowManager: routeToFile (E1)', () => {
  /** One folder window on /v plus a Welcome window — the routing fixture. */
  function seedRouting(exists: (path: string) => boolean = () => true) {
    store.upsertWindow({ id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 10, y: 10, width: 800, height: 600 } })
    store.upsertWindow({ id: 'w2', root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 40, y: 40, width: 800, height: 600 } })
    const { host, created } = makeHost([AREA], exists)
    const manager = createWindowManager(store, host)
    manager.restoreAll()
    return { manager, created, w1: created[0].win, w2: created[1].win }
  }

  const sentOn = (win: FakeWindow, channel: string) => win.webContents.send.mock.calls.filter(([ch]) => ch === channel)

  it('routes into the containing open window: restored if minimized, focused, sent link:open-file with the path', () => {
    const { manager, created, w1 } = seedRouting()
    w1.minimized = true
    manager.routeToFile('/v/sub/a.excalidraw')
    expect(w1.isMinimized()).toBe(false)
    expect(w1.focusCount).toBe(1)
    expect(w1.webContents.send).toHaveBeenCalledWith(CH.linkOpenFile, '/v/sub/a.excalidraw')
    expect(created).toHaveLength(2) // no new window
  })

  it('an upper-case extension routes too', () => {
    const { manager, w1 } = seedRouting()
    manager.routeToFile('/v/A.EXCALIDRAW')
    expect(w1.webContents.send).toHaveBeenCalledWith(CH.linkOpenFile, '/v/A.EXCALIDRAW')
  })

  it('🔒 YAZ-1802 D14: a draw.io diagram routes like a drawing, in any case', () => {
    const { manager, w1 } = seedRouting()
    manager.routeToFile('/v/Flow.drawio')
    manager.routeToFile('/v/UP.DRAWIO')
    expect(sentOn(w1, CH.linkOpenFile)).toEqual([[CH.linkOpenFile, '/v/Flow.drawio'], [CH.linkOpenFile, '/v/UP.DRAWIO']])
  })

  it('no containing window: a new window on the most recent recents folder containing the file, persisted', () => {
    const { manager, created } = seedRouting()
    store.pushRecent('/w', 1)
    manager.routeToFile('/w/sub/b.excalidraw')
    expect(created).toHaveLength(3)
    expect(created[2].entry.root).toBe('/w')
    expect(created[2].entry.file).toBe('/w/sub/b.excalidraw')
    expect(created[2].entry.sidebarCollapsed).toBe(false)
    expect(store.get().windows).toContainEqual(created[2].entry)
  })

  it('nothing matches: a new window rooted at the file parent folder', () => {
    const { manager, created } = seedRouting()
    manager.routeToFile('/elsewhere/deep/c.excalidraw')
    expect(created).toHaveLength(3)
    expect(created[2].entry.root).toBe('/elsewhere/deep')
    expect(created[2].entry.file).toBe('/elsewhere/deep/c.excalidraw')
  })

  it('a rootOverride routes into the open window on exactly that root', () => {
    const { manager, created, w1 } = seedRouting()
    manager.routeToFile('/v/sub/a.excalidraw', '/v')
    expect(w1.webContents.send).toHaveBeenCalledWith(CH.linkOpenFile, '/v/sub/a.excalidraw')
    expect(created).toHaveLength(2)
  })

  it('a stored entry with no live window (mid-close race) falls back to a fresh window on that entry root', () => {
    const { manager, created } = seedRouting()
    // The entry exists in the state but was never attached — its window is already gone.
    store.upsertWindow({ id: 'w3', root: '/v/deeper', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 20, y: 20, width: 800, height: 600 } })
    manager.routeToFile('/v/deeper/n.excalidraw') // most specific root wins → resolves to the dead w3
    expect(created).toHaveLength(3)
    expect(created[2].entry.id).not.toBe('w3') // a fresh window, not a resurrection of the dead entry
    expect(created[2].entry.root).toBe('/v/deeper')
    expect(created[2].entry.file).toBe('/v/deeper/n.excalidraw')
  })

  it('an unsupported path opens nothing and reports “unsupported file type” passively', () => {
    const { manager, created, w1 } = seedRouting()
    manager.routeToFile('/v/archive.zip')
    expect(created).toHaveLength(2)
    expect(w1.focusCount).toBe(1)
    const notices = sentOn(w1, CH.linkNotice)
    expect(notices).toEqual([[CH.linkNotice, "Can't open /v/archive.zip: unsupported file type"]])
    expect(sentOn(w1, CH.linkOpenFile)).toHaveLength(0)
  })

  it('🔒 YAZ-1802 D3: a picture that holds a diagram is not one — it gets the same notice', () => {
    const { manager, w1 } = seedRouting()
    manager.routeToFile('/v/image.drawio.svg')
    expect(sentOn(w1, CH.linkNotice)).toEqual([[CH.linkNotice, "Can't open /v/image.drawio.svg: unsupported file type"]])
    expect(sentOn(w1, CH.linkOpenFile)).toHaveLength(0)
  })

  it('a missing file (host.exists false) gets the same notice: no window, no dialog', () => {
    const { manager, created, w1 } = seedRouting(() => false)
    manager.routeToFile('/v/gone.excalidraw')
    expect(created).toHaveLength(2)
    expect(sentOn(w1, CH.linkNotice)).toHaveLength(1)
    expect(sentOn(w1, CH.linkOpenFile)).toHaveLength(0)
  })

  it('a directory with a supported-looking suffix is refused passively by the regular-file probe', () => {
    const directory = '/v/folder.excalidraw'
    const { manager, created, w1 } = seedRouting((candidate) => candidate !== directory)
    manager.routeToFile(directory)
    expect(created).toHaveLength(2)
    expect(sentOn(w1, CH.linkNotice)).toEqual([[CH.linkNotice, `Can't open ${directory}: file not found`]])
    expect(sentOn(w1, CH.linkOpenFile)).toHaveLength(0)
  })

  it('linkNotice (the parse-failure path) restores + focuses a live window and delivers the message', () => {
    const { manager, w1 } = seedRouting()
    w1.minimized = true
    manager.linkNotice("Can't open link")
    expect(w1.isMinimized()).toBe(false)
    expect(w1.focusCount).toBe(1)
    expect(w1.webContents.send).toHaveBeenCalledWith(CH.linkNotice, "Can't open link")
  })
})
