import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, addRecentRoot, defaultAppState, type AppState, type WindowIdentity } from '@shared/types'
import { storage } from './storage'
import { hashFilePath } from './urlHash'

/** A fake `window.yaseenDraw` with just the state / window halves the storage module talks to. */
type IdentityFixture = Omit<WindowIdentity, 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'> & Partial<Pick<WindowIdentity, 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'>>

function installBridge(state: AppState, identity: IdentityFixture) {
  let listener: ((s: AppState) => void) | null = null
  const bridge = {
    state: {
      get: vi.fn(async () => state),
      setSettings: vi.fn(async () => undefined),
      setSidebarWidth: vi.fn(async () => undefined),
      pushRecent: vi.fn(async () => undefined),
      removeRecent: vi.fn(async () => undefined),
      setFolder: vi.fn(async () => undefined),
      onChange: vi.fn((l: (s: AppState) => void) => {
        listener = l
        return () => {
          if (listener === l) listener = null
        }
      }),
    },
    window: {
      identity: vi.fn(async (): Promise<WindowIdentity> => ({
        ...identity,
        sidebarCollapsed: identity.sidebarCollapsed ?? false,
        sidebarLens: identity.sidebarLens ?? 'files',
        focusDirs: identity.focusDirs ?? [],
        focusFavorites: identity.focusFavorites ?? [],
      })),
      setIdentity: vi.fn(async () => undefined),
      open: vi.fn(),
      duplicate: vi.fn(),
    },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return { bridge, emit: (s: AppState) => listener?.(s), hasListener: () => listener !== null }
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

let b: ReturnType<typeof installBridge>
beforeEach(async () => {
  b = installBridge(defaultAppState(), { id: 'w1', root: null, file: null, tabs: [], sidebarCollapsed: false })
  await storage.init()
})
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  vi.restoreAllMocks()
})

describe('addRecentRoot', () => {
  it('prepends, de-dupes and caps at 10', () => {
    let list = addRecentRoot([], '/a', 1)
    list = addRecentRoot(list, '/b', 2)
    list = addRecentRoot(list, '/a', 3)
    expect(list).toEqual([
      { path: '/a', lastOpened: 3 },
      { path: '/b', lastOpened: 2 },
    ])
    for (let i = 0; i < 20; i++) list = addRecentRoot(list, `/x${i}`, 10 + i)
    expect(list).toHaveLength(10)
    expect(list[0].path).toBe('/x19')
  })
})

describe('storage.init', () => {
  it('loads the state and this window\'s identity from the bridge and subscribes to changes', async () => {
    const seeded: AppState = {
      ...defaultAppState(),
      settings: { ...DEFAULT_SETTINGS, theme: 'dark' },
      recents: [{ path: '/v', lastOpened: 5 }],
      folders: { '/v': { expanded: ['/v/sub'], lastFile: '/v/a.excalidraw', sortOrder: 'name', name: null } },
    }
    b = installBridge(seeded, { id: 'w2', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: true })
    await storage.init()
    expect(b.bridge.state.get).toHaveBeenCalledTimes(1)
    expect(b.bridge.window.identity).toHaveBeenCalledTimes(1)
    expect(b.hasListener()).toBe(true)
    expect(storage.getRoot()).toBe('/v')
    expect(storage.getFile()).toBe('/v/a.excalidraw')
    expect(storage.getTabs()).toEqual(['/v/a.excalidraw'])
    expect(storage.getSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
    expect(storage.getSidebarCollapsed()).toBe(true)
    expect(storage.getRecentRoots()).toEqual([{ path: '/v', lastOpened: 5 }])
    expect(storage.getExpanded('/v')).toEqual(['/v/sub'])
    expect(storage.getLastFile('/v')).toBe('/v/a.excalidraw')
  })

  it('reads fall back to defaults before init / when the bridge is unavailable', async () => {
    vi.resetModules()
    delete (window as unknown as Record<string, unknown>).yaseenDraw
    const fresh = (await import('./storage')).storage
    expect(fresh.getRoot()).toBeNull()
    expect(fresh.getTabs()).toEqual([])
    expect(fresh.getRecentRoots()).toEqual([])
    expect(fresh.getExpanded('/r')).toEqual([])
    expect(fresh.getLastFile('/r')).toBeNull()
    expect(fresh.getSidebarCollapsed()).toBe(false)
    expect(fresh.getSidebarLens()).toBe('files')
    expect(fresh.getSettings()).toEqual(DEFAULT_SETTINGS)
    await expect(fresh.init()).rejects.toBeDefined()
  })

  it('re-initialising drops the previous change subscription', async () => {
    const first = b
    b = installBridge(defaultAppState(), { id: 'w1', root: null, file: null, tabs: [], sidebarCollapsed: false })
    await storage.init()
    expect(first.hasListener()).toBe(false)
    expect(b.hasListener()).toBe(true)
  })
})

describe('storage', () => {
  it('root is the window identity; changing it clears the file AND tabs in one write, re-setting it keeps them', () => {
    expect(storage.getRoot()).toBeNull()
    storage.setRoot('/notes')
    expect(storage.getRoot()).toBe('/notes')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/notes', file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] })
    storage.setWorkspace('/notes', ['/notes/a.excalidraw'], '/notes/a.excalidraw')
    storage.setRoot('/notes')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/notes' })
    expect(storage.getFile()).toBe('/notes/a.excalidraw')
    expect(storage.getTabs()).toEqual(['/notes/a.excalidraw'])
    storage.setRoot(null)
    expect(storage.getRoot()).toBeNull()
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: null, file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] })
    expect(storage.getFile()).toBeNull()
    expect(storage.getTabs()).toEqual([])
  })

  it('setWorkspace mirrors the whole workspace identity in one call and keeps an independent tab array', () => {
    const tabs = ['/v/a.excalidraw']
    storage.setWorkspace('/v', tabs, '/v/a.excalidraw')
    expect(storage.getTabs()).toEqual(['/v/a.excalidraw'])
    expect(storage.getTabs()).not.toBe(tabs)
    expect(b.bridge.window.setIdentity).toHaveBeenCalledTimes(1)
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw'], file: '/v/a.excalidraw' })
  })

  it('recent roots are MRU in the cache and pushed through the bridge', () => {
    expect(storage.pushRecentRoot('/a', 5)).toEqual([{ path: '/a', lastOpened: 5 }])
    storage.pushRecentRoot('/b', 6)
    expect(storage.getRecentRoots()).toEqual([
      { path: '/b', lastOpened: 6 },
      { path: '/a', lastOpened: 5 },
    ])
    expect(b.bridge.state.pushRecent.mock.calls).toEqual([['/a'], ['/b']])
  })

  it('removeRecentRoot drops the entry from the cache and sends the removal over the bridge', () => {
    storage.pushRecentRoot('/a', 5)
    storage.pushRecentRoot('/b', 6)
    storage.removeRecentRoot('/a')
    expect(storage.getRecentRoots()).toEqual([{ path: '/b', lastOpened: 6 }])
    expect(b.bridge.state.removeRecent).toHaveBeenCalledWith('/a')
  })

  it('sortOrder is keyed by root, defaults to name, and goes over the bridge as its own patch (🔒 YAZ-1835 D3)', () => {
    expect(storage.getSortOrder('/r1')).toBe('name')
    storage.setSortOrder('/r1', 'updated')
    expect(storage.getSortOrder('/r1')).toBe('updated')
    expect(storage.getSortOrder('/r2')).toBe('name')
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/r1', { sortOrder: 'updated' })
    storage.setExpanded('/r1', ['/r1/a'])
    expect(storage.getSortOrder('/r1')).toBe('updated') // the other folder fields survive
  })

  it('vaultName falls back to the folder name; setVaultName cleans, stores the folder name as null, and rides setFolder (Docs YAZ-1974 D3)', () => {
    expect(storage.vaultName('/v/business-wiki-MASTER')).toBe('business-wiki-MASTER')
    storage.setVaultName('/v/business-wiki-MASTER', '  Business Wiki ')
    expect(storage.vaultName('/v/business-wiki-MASTER')).toBe('Business Wiki')
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/v/business-wiki-MASTER', { name: 'Business Wiki' })
    storage.setVaultName('/v/business-wiki-MASTER', 'business-wiki-MASTER') // the folder's own name = no custom name
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/v/business-wiki-MASTER', { name: null })
    storage.setVaultName('/v/business-wiki-MASTER', 'Business Wiki')
    storage.setVaultName('/v/business-wiki-MASTER', '')
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/v/business-wiki-MASTER', { name: null })
    expect(storage.vaultName('/v/business-wiki-MASTER')).toBe('business-wiki-MASTER')
  })

  it('expanded and lastFile are keyed by root; setWorkspace records lastFile and one complete identity write', () => {
    storage.setExpanded('/r1', ['/r1/a'])
    storage.setExpanded('/r2', ['/r2/b'])
    expect(storage.getExpanded('/r1')).toEqual(['/r1/a'])
    expect(storage.getExpanded('/r2')).toEqual(['/r2/b'])
    expect(storage.getExpanded('/r3')).toEqual([])
    expect(b.bridge.state.setFolder.mock.calls).toEqual([
      ['/r1', { expanded: ['/r1/a'] }],
      ['/r2', { expanded: ['/r2/b'] }],
    ])
    storage.setWorkspace('/r1', ['/r1/a/x.excalidraw', '/r1/y.excalidraw'], '/r1/a/x.excalidraw')
    expect(storage.getLastFile('/r1')).toBe('/r1/a/x.excalidraw')
    expect(storage.getLastFile('/r2')).toBeNull()
    expect(storage.getExpanded('/r1')).toEqual(['/r1/a']) // the other folder fields survive
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/r1', { lastFile: '/r1/a/x.excalidraw' })
    // ONE explicit write carries BOTH halves — never the legacy { file }-only patch, whose
    // main-side normalization would prepend the file into tabs on its own.
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/r1/a/x.excalidraw', '/r1/y.excalidraw'], file: '/r1/a/x.excalidraw' })
    storage.setWorkspace('/r1', [], null)
    expect(storage.getLastFile('/r1')).toBeNull()
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/r1', { lastFile: null })
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: [], file: null })
  })

  it('a tabs-only change (active file unchanged) writes the identity but NOT the folder (FN14, GRO-2197)', () => {
    storage.setWorkspace('/r', ['/r/a.excalidraw'], '/r/a.excalidraw')
    expect(b.bridge.state.setFolder).toHaveBeenCalledTimes(1)
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/r', { lastFile: '/r/a.excalidraw' })
    // ⌘-click background tab / drag-reorder / closing a non-active tab: `file` is identical —
    // no redundant lastFile write (which would commit, hit disk and broadcast to every window).
    storage.setWorkspace('/r', ['/r/a.excalidraw', '/r/b.excalidraw'], '/r/a.excalidraw')
    expect(b.bridge.state.setFolder).toHaveBeenCalledTimes(1)
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/r/a.excalidraw', '/r/b.excalidraw'], file: '/r/a.excalidraw' })
    expect(storage.getTabs()).toEqual(['/r/a.excalidraw', '/r/b.excalidraw'])
    expect(storage.getLastFile('/r')).toBe('/r/a.excalidraw')
    // A REAL active-file change still writes both halves.
    storage.setWorkspace('/r', ['/r/a.excalidraw', '/r/b.excalidraw'], '/r/b.excalidraw')
    expect(b.bridge.state.setFolder).toHaveBeenCalledTimes(2)
    expect(b.bridge.state.setFolder).toHaveBeenLastCalledWith('/r', { lastFile: '/r/b.excalidraw' })
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/r/a.excalidraw', '/r/b.excalidraw'], file: '/r/b.excalidraw' })
  })

  it('setWorkspace on a null root (no folder to remember into) updates the identity only', () => {
    storage.setWorkspace(null, ['/x/a.excalidraw'], '/x/a.excalidraw')
    expect(storage.getFile()).toBe('/x/a.excalidraw')
    expect(storage.getTabs()).toEqual(['/x/a.excalidraw'])
    expect(b.bridge.state.setFolder).not.toHaveBeenCalled()
    expect(b.bridge.window.setIdentity).toHaveBeenCalledWith({ tabs: ['/x/a.excalidraw'], file: '/x/a.excalidraw' })
  })

  it('getFile/getTabs are the window identity: set by setWorkspace, cleared when the root changes', () => {
    expect(storage.getFile()).toBeNull()
    storage.setRoot('/v')
    storage.setWorkspace('/v', ['/v/b.excalidraw', '/v/c.excalidraw'], '/v/b.excalidraw')
    expect(storage.getFile()).toBe('/v/b.excalidraw')
    expect(storage.getTabs()).toEqual(['/v/b.excalidraw', '/v/c.excalidraw'])
    storage.setRoot('/other')
    expect(storage.getFile()).toBeNull()
    expect(storage.getTabs()).toEqual([])
  })

  /** The workspace boot precedence: `hashFilePath(hash) ?? storage.getFile() ?? storage.getLastFile(root)`. */
  const bootFile = (hash: string, root: string) => hashFilePath(hash) ?? storage.getFile() ?? storage.getLastFile(root)

  it('boot precedence (GRO-2160): identity file wins over the folder lastFile, a pasted hash beats both', async () => {
    // Two windows on the same folder: w2 restored on b.excalidraw while the folder's lastFile is a.excalidraw.
    const seeded: AppState = { ...defaultAppState(), folders: { '/v': { expanded: [], lastFile: '/v/a.excalidraw', sortOrder: 'name', name: null } } }
    b = installBridge(seeded, { id: 'w2', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/b.excalidraw'], sidebarCollapsed: false })
    await storage.init()
    expect(bootFile('', '/v')).toBe('/v/b.excalidraw')
    expect(bootFile('#/v/c.excalidraw', '/v')).toBe('/v/c.excalidraw')
    // A fresh window on the folder (identity file null) still falls back to the folder's lastFile.
    b = installBridge(seeded, { id: 'w3', root: '/v', file: null, tabs: [], sidebarCollapsed: false })
    await storage.init()
    expect(bootFile('', '/v')).toBe('/v/a.excalidraw')
  })

  it('focusFavorites is this window identity (YAZ-1766 D5), focusDirs\' rule: setIdentity, deaf to broadcasts, cleared by a root change', async () => {
    b = installBridge(defaultAppState(), { id: 'w1', root: '/r1', file: null, tabs: [], focusFavorites: ['/r1/restored'] })
    await storage.init()
    expect(storage.getFocusFavorites()).toEqual(['/r1/restored'])
    storage.setFocusFavorites(['/r1/a'])
    expect(storage.getFocusFavorites()).toEqual(['/r1/a'])
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ focusFavorites: ['/r1/a'] })
    expect(b.bridge.state.setFolder).not.toHaveBeenCalled()
    b.emit({ ...defaultAppState(), sidebarWidth: 333 })
    expect(storage.getFocusFavorites()).toEqual(['/r1/a'])
    storage.setRoot('/r2')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/r2', file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] })
    expect(storage.getFocusFavorites()).toEqual([])
  })

  it('focusDirs is this window identity (YAZ-1628): one list per lens through window.setIdentity, deaf to state broadcasts, cleared by a root change', async () => {
    b = installBridge(defaultAppState(), { id: 'w1', root: '/r1', file: null, tabs: [], focusDirs: ['/r1/restored'] })
    await storage.init()
    expect(storage.getFocusDirs()).toEqual(['/r1/restored']) // restored from main at boot, like sidebarCollapsed
    storage.setFocusDirs(['/r1/a', '/r1/b'])
    expect(storage.getFocusDirs()).toEqual(['/r1/a', '/r1/b'])
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ focusDirs: ['/r1/a', '/r1/b'] })
    expect(b.bridge.state.setFolder).not.toHaveBeenCalled() // never the per-vault bucket
    // One lens' exit never touches the other lens' focus.
    storage.setFocusFavorites(['/r1/fav'])
    storage.setFocusDirs([])
    expect(storage.getFocusDirs()).toEqual([])
    expect(storage.getFocusFavorites()).toEqual(['/r1/fav'])
    // Another window's write lands as a state broadcast; it cannot move THIS window's focus.
    b.emit({ ...defaultAppState(), sidebarWidth: 333 })
    expect(storage.getSidebarWidth()).toBe(333)
    expect(storage.getFocusFavorites()).toEqual(['/r1/fav'])
    // Re-setting the same root keeps both lists; a different root clears them in the root write itself.
    storage.setRoot('/r1')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/r1' })
    expect(storage.getFocusFavorites()).toEqual(['/r1/fav'])
    storage.setRoot('/r2')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/r2', file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] })
    expect(storage.getFocusDirs()).toEqual([])
    expect(storage.getFocusFavorites()).toEqual([])
  })

  it('sidebarCollapsed is this window identity and round-trips through window.setIdentity', () => {
    expect(storage.getSidebarCollapsed()).toBe(false)
    storage.setSidebarCollapsed(true)
    expect(storage.getSidebarCollapsed()).toBe(true)
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ sidebarCollapsed: true })
    storage.setSidebarCollapsed(false)
    expect(storage.getSidebarCollapsed()).toBe(false)
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ sidebarCollapsed: false })
  })

  it('sidebarLens is this window identity (YAZ-847, per window since YAZ-1628): restored at boot, written through window.setIdentity, deaf to state broadcasts, reset to Files by a root change (Docs YAZ-1846 D2)', async () => {
    expect(storage.getSidebarLens()).toBe('files')
    storage.setSidebarLens('favorites')
    expect(storage.getSidebarLens()).toBe('favorites')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ sidebarLens: 'favorites' })
    storage.setSidebarLens('files')
    expect(storage.getSidebarLens()).toBe('files')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ sidebarLens: 'files' })
    // Restored from main at boot, like sidebarCollapsed.
    b = installBridge(defaultAppState(), { id: 'w1', root: '/r1', file: null, tabs: [], sidebarLens: 'favorites' })
    await storage.init()
    expect(storage.getSidebarLens()).toBe('favorites')
    // Another window's write lands as a state broadcast; it cannot move THIS window's lens.
    b.emit({ ...defaultAppState(), sidebarWidth: 333 })
    expect(storage.getSidebarWidth()).toBe(333)
    expect(storage.getSidebarLens()).toBe('favorites')
    // Re-setting the SAME root keeps it.
    storage.setRoot('/r1')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/r1' })
    expect(storage.getSidebarLens()).toBe('favorites')
    // A root CHANGE lands on Files (Docs YAZ-1846 D2) — in the same single identity write.
    storage.setRoot('/r2')
    expect(b.bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: '/r2', file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] })
    expect(storage.getSidebarLens()).toBe('files')
  })

  it('settings default and round-trip through the bridge', () => {
    expect(storage.getSettings()).toEqual(DEFAULT_SETTINGS)
    const next = { ...DEFAULT_SETTINGS, theme: 'dark' as const, confirmDelete: false }
    storage.setSettings(next)
    expect(storage.getSettings()).toEqual(next)
    expect(b.bridge.state.setSettings).toHaveBeenCalledWith(next)
  })

  it('a state:changed broadcast replaces the cache and notifies subscribers; unsubscribe stops them', () => {
    const seen = vi.fn()
    const off = storage.subscribe(seen)
    const next: AppState = {
      ...defaultAppState(),
      settings: { ...DEFAULT_SETTINGS, theme: 'light' },
      folders: { '/v': { expanded: ['/v/sub'], lastFile: '/v/a.excalidraw', sortOrder: 'name', name: null } },
    }
    b.emit(next)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(storage.getSettings().theme).toBe('light')
    expect(storage.getSidebarCollapsed()).toBe(false) // another window's global-state broadcast cannot change this identity
    expect(storage.getSidebarLens()).toBe('files') // nor the lens (YAZ-1628)
    expect(storage.getExpanded('/v')).toEqual(['/v/sub'])
    expect(storage.getLastFile('/v')).toBe('/v/a.excalidraw')
    off()
    b.emit(defaultAppState())
    expect(seen).toHaveBeenCalledTimes(1)
    expect(storage.getSidebarCollapsed()).toBe(false)
  })

  it('local writes do not notify subscribers (the broadcast echo does)', () => {
    const seen = vi.fn()
    storage.subscribe(seen)
    storage.setSidebarCollapsed(true)
    storage.setSettings({ ...DEFAULT_SETTINGS, confirmDelete: false })
    expect(seen).not.toHaveBeenCalled()
  })

  it('a failed bridge write is logged once and the optimistic cache value stays', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    b.bridge.state.setSettings.mockRejectedValueOnce({ code: 'BAD_REQUEST', message: 'nope' })
    storage.setSettings({ ...DEFAULT_SETTINGS, confirmDelete: false })
    await flushMicrotasks()
    expect(error).toHaveBeenCalledTimes(1)
    expect(storage.getSettings().confirmDelete).toBe(false)
  })
})
