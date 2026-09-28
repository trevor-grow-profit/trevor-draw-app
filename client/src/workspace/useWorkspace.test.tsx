/**
 * The renderer-owned tab model (Tabs I2, GRO-2234): the pure reducer's invariants
 * (`active ∈ tabs`, `tabs: []` ⇔ `active: null`, de-duplication, the keep-mounted set),
 * the boot snapshot precedence, and the hook's ONE-explicit-`setIdentity({tabs, file})`
 * mirror per change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAppState, type AppState, type WindowIdentity } from '@shared/types'
import { storage } from '../lib/storage'
import { bootTabs, tabsReducer, useWorkspace, type TabsState, type UseWorkspace } from './useWorkspace'


const state = (tabs: string[], active: string | null, mounted?: string[]): TabsState => ({
  tabs,
  active,
  mounted: mounted ?? (active === null ? [] : [active]),
  history: {},
})

describe('tabsReducer', () => {
  describe('open-current (rule 4: replace the active tab)', () => {
    it('creates the first tab of an empty window', () => {
      expect(tabsReducer(state([], null), { type: 'open-current', path: '/v/a.excalidraw' })).toEqual({
        ...state(['/v/a.excalidraw'], '/v/a.excalidraw'),
        history: {},
      })
    })

    it('replaces the active tab in its slot; the replaced path leaves the mounted set', () => {
      const s = state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/a.excalidraw', ['/v/b.excalidraw', '/v/a.excalidraw'])
      expect(tabsReducer(s, { type: 'open-current', path: '/v/c.excalidraw' })).toEqual({
        tabs: ['/v/c.excalidraw', '/v/b.excalidraw'],
        active: '/v/c.excalidraw',
        mounted: ['/v/b.excalidraw', '/v/c.excalidraw'],
        history: { '/v/c.excalidraw': { entries: ['/v/a.excalidraw', '/v/c.excalidraw'], index: 1 } },
      })
    })

    it('ACTIVATES an already-open path instead of duplicating (rule 3)', () => {
      const s = state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(s, { type: 'open-current', path: '/v/b.excalidraw' })).toEqual({
        tabs: ['/v/a.excalidraw', '/v/b.excalidraw'],
        active: '/v/b.excalidraw',
        mounted: ['/v/a.excalidraw', '/v/b.excalidraw'],
        history: {},
      })
    })

    it('re-opening the active path is a no-op (same state object — no identity mirror)', () => {
      const s = state(['/v/a.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(s, { type: 'open-current', path: '/v/a.excalidraw' })).toBe(s)
    })
  })

  describe('open-background (rule 5)', () => {
    it('open-background appends WITHOUT activating or mounting (the editor lazy-mounts on first activation)', () => {
      const s = state(['/v/a.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(s, { type: 'open-background', path: '/v/b.excalidraw' })).toEqual({
        tabs: ['/v/a.excalidraw', '/v/b.excalidraw'],
        active: '/v/a.excalidraw',
        mounted: ['/v/a.excalidraw'],
        history: {},
      })
    })

    it('open-background on an already-open path is a no-op — it never yanks activation', () => {
      const s = state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(s, { type: 'open-background', path: '/v/b.excalidraw' })).toBe(s)
    })

    it('open-background as the FIRST tab activates: non-empty tabs require a non-null file', () => {
      expect(tabsReducer(state([], null), { type: 'open-background', path: '/v/a.excalidraw' })).toEqual(state(['/v/a.excalidraw'], '/v/a.excalidraw'))
    })
  })

  describe('activate', () => {
    it('activates a listed tab and adds it to the mounted set once', () => {
      const s = state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/a.excalidraw')
      const next = tabsReducer(s, { type: 'activate', path: '/v/b.excalidraw' })
      expect(next).toEqual(state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/b.excalidraw', ['/v/a.excalidraw', '/v/b.excalidraw']))
      // Re-activating keeps the mounted set stable (no duplicates).
      const back = tabsReducer(tabsReducer(next, { type: 'activate', path: '/v/a.excalidraw' }), { type: 'activate', path: '/v/b.excalidraw' })
      expect(back.mounted).toEqual(['/v/a.excalidraw', '/v/b.excalidraw'])
    })

    it('an unknown path or the already-active path is a no-op', () => {
      const s = state(['/v/a.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(s, { type: 'activate', path: '/v/zzz.excalidraw' })).toBe(s)
      expect(tabsReducer(s, { type: 'activate', path: '/v/a.excalidraw' })).toBe(s)
    })
  })

  describe('close (rule 7 ladder)', () => {
    const abc = state(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'], '/v/b.excalidraw')

    it('closing the active tab activates its RIGHT neighbour', () => {
      expect(tabsReducer(abc, { type: 'close', path: '/v/b.excalidraw' })).toEqual(state(['/v/a.excalidraw', '/v/c.excalidraw'], '/v/c.excalidraw', ['/v/c.excalidraw']))
    })

    it('closing the active LAST tab falls back to the left neighbour', () => {
      const s = state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/b.excalidraw')
      expect(tabsReducer(s, { type: 'close', path: '/v/b.excalidraw' })).toEqual(state(['/v/a.excalidraw'], '/v/a.excalidraw'))
    })

    it('closing a NON-active tab keeps the active one (and prunes the mounted set)', () => {
      const s = state(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'], '/v/b.excalidraw', ['/v/c.excalidraw', '/v/b.excalidraw'])
      expect(tabsReducer(s, { type: 'close', path: '/v/c.excalidraw' })).toEqual(state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/b.excalidraw', ['/v/b.excalidraw']))
    })

    it('closing the only tab leaves the empty state (tabs: [] ⇔ active: null); the window stays alive', () => {
      expect(tabsReducer(state(['/v/a.excalidraw'], '/v/a.excalidraw'), { type: 'close', path: '/v/a.excalidraw' })).toEqual(state([], null))
    })

    it('closing an unknown path is a no-op', () => {
      expect(tabsReducer(abc, { type: 'close', path: '/v/zzz.excalidraw' })).toBe(abc)
    })
  })

  describe('move (I3 drag-to-reorder, GRO-2235)', () => {
    const abc = state(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'], '/v/b.excalidraw')

    it('moves the tab at `from` to final index `to`; active and mounted are untouched', () => {
      expect(tabsReducer(abc, { type: 'move', from: 0, to: 2 })).toEqual(state(['/v/b.excalidraw', '/v/c.excalidraw', '/v/a.excalidraw'], '/v/b.excalidraw'))
      expect(tabsReducer(abc, { type: 'move', from: 2, to: 0 })).toEqual(state(['/v/c.excalidraw', '/v/a.excalidraw', '/v/b.excalidraw'], '/v/b.excalidraw'))
      const withMounts = state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/b.excalidraw', ['/v/a.excalidraw', '/v/b.excalidraw'])
      expect(tabsReducer(withMounts, { type: 'move', from: 1, to: 0 }).mounted).toEqual(['/v/a.excalidraw', '/v/b.excalidraw'])
    })

    it('the same slot, an out-of-range `from`, or a `to` clamped back onto `from` are no-ops (same object)', () => {
      expect(tabsReducer(abc, { type: 'move', from: 1, to: 1 })).toBe(abc)
      expect(tabsReducer(abc, { type: 'move', from: 3, to: 0 })).toBe(abc)
      expect(tabsReducer(abc, { type: 'move', from: -1, to: 0 })).toBe(abc)
      expect(tabsReducer(abc, { type: 'move', from: 2, to: 99 })).toBe(abc) // clamped to the last slot — its own
    })
  })

  describe('cycle (rule 9: wraparound, plain left→right order)', () => {
    const abc = state(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'], '/v/c.excalidraw')

    it('next wraps from the last tab to the first; prev wraps back', () => {
      const next = tabsReducer(abc, { type: 'cycle', dir: 1 })
      expect(next.active).toBe('/v/a.excalidraw')
      expect(tabsReducer(next, { type: 'cycle', dir: -1 }).active).toBe('/v/c.excalidraw')
    })

    it('is a no-op with fewer than two tabs', () => {
      const one = state(['/v/a.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(one, { type: 'cycle', dir: 1 })).toBe(one)
      const none = state([], null)
      expect(tabsReducer(none, { type: 'cycle', dir: -1 })).toBe(none)
    })
  })

  describe('reset', () => {
    it('normalizes: de-duplicates and PREPENDS an active file missing from the list (main\'s order)', () => {
      expect(tabsReducer(state([], null), { type: 'reset', tabs: ['/v/a.excalidraw', '/v/a.excalidraw', '/v/b.excalidraw'], active: '/v/c.excalidraw' })).toEqual(
        state(['/v/c.excalidraw', '/v/a.excalidraw', '/v/b.excalidraw'], '/v/c.excalidraw'),
      )
    })

    it('a null active forces the empty state; resetting an already-empty state is a no-op', () => {
      const s = state(['/v/a.excalidraw'], '/v/a.excalidraw')
      expect(tabsReducer(s, { type: 'reset', tabs: ['/v/a.excalidraw'], active: null })).toEqual(state([], null))
      const empty = state([], null)
      expect(tabsReducer(empty, { type: 'reset', tabs: [], active: null })).toBe(empty)
    })

    it('mounts ONLY the active tab (rule 15: restore shows all tabs, one editor)', () => {
      const next = tabsReducer(state([], null), { type: 'reset', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], active: '/v/b.excalidraw' })
      expect(next.mounted).toEqual(['/v/b.excalidraw'])
    })
  })

  describe('rename (Links E1, GRO-2194: an open tab follows its renamed file)', () => {
    it('remaps the tab in place — slot, activation and the mounted set all follow', () => {
      const s = state(['/v/old.excalidraw', '/v/x.excalidraw'], '/v/old.excalidraw', ['/v/x.excalidraw', '/v/old.excalidraw'])
      expect(tabsReducer(s, { type: 'rename', oldPath: '/v/old.excalidraw', newPath: '/v/new.excalidraw' })).toEqual({
        tabs: ['/v/new.excalidraw', '/v/x.excalidraw'],
        active: '/v/new.excalidraw',
        mounted: ['/v/x.excalidraw', '/v/new.excalidraw'],
        history: {},
      })
    })

    it('remaps a background tab without touching activation', () => {
      const s = state(['/v/x.excalidraw', '/v/old.excalidraw'], '/v/x.excalidraw')
      expect(tabsReducer(s, { type: 'rename', oldPath: '/v/old.excalidraw', newPath: '/v/new.excalidraw' })).toEqual(state(['/v/x.excalidraw', '/v/new.excalidraw'], '/v/x.excalidraw'))
    })

    it('is a no-op (same state object — no identity mirror) when the old path is not open', () => {
      const s = state(['/v/x.excalidraw'], '/v/x.excalidraw')
      expect(tabsReducer(s, { type: 'rename', oldPath: '/v/old.excalidraw', newPath: '/v/new.excalidraw' })).toBe(s)
    })

    it('drops the old tab when the new path is somehow already open (dedupe), keeping activation sane', () => {
      const s = state(['/v/old.excalidraw', '/v/new.excalidraw'], '/v/old.excalidraw', ['/v/old.excalidraw'])
      const next = tabsReducer(s, { type: 'rename', oldPath: '/v/old.excalidraw', newPath: '/v/new.excalidraw' })
      expect(next.tabs).toEqual(['/v/new.excalidraw'])
      expect(next.active).toBe('/v/new.excalidraw')
      expect(next.mounted).toEqual(['/v/new.excalidraw'])
    })
  })

  describe('rename-dir (Links E1b, GRO-2241: every tab under a renamed folder follows by prefix)', () => {
    it('remaps every tab under the old prefix in place — slots, activation and the mounted set follow', () => {
      const s = state(['/v/Old/a.excalidraw', '/v/x.excalidraw', '/v/Old/deep/b.excalidraw'], '/v/Old/a.excalidraw', ['/v/x.excalidraw', '/v/Old/a.excalidraw'])
      expect(tabsReducer(s, { type: 'rename-dir', oldPath: '/v/Old', newPath: '/v/New' })).toEqual({
        tabs: ['/v/New/a.excalidraw', '/v/x.excalidraw', '/v/New/deep/b.excalidraw'],
        active: '/v/New/a.excalidraw',
        mounted: ['/v/x.excalidraw', '/v/New/a.excalidraw'],
        history: {},
      })
    })

    it('is a no-op (same state object — no identity mirror) when nothing is open under the folder', () => {
      const s = state(['/v/x.excalidraw', '/v/Older/a.excalidraw'], '/v/x.excalidraw') // `/v/Older` is NOT under `/v/Old` — prefix means `/v/Old/`
      expect(tabsReducer(s, { type: 'rename-dir', oldPath: '/v/Old', newPath: '/v/New' })).toBe(s)
    })

    it('drops a remapped tab whose target path is somehow already open (dedupe), keeping activation sane', () => {
      const s = state(['/v/Old/a.excalidraw', '/v/New/a.excalidraw'], '/v/Old/a.excalidraw', ['/v/Old/a.excalidraw'])
      const next = tabsReducer(s, { type: 'rename-dir', oldPath: '/v/Old', newPath: '/v/New' })
      expect(next.tabs).toEqual(['/v/New/a.excalidraw'])
      expect(next.active).toBe('/v/New/a.excalidraw')
      expect(next.mounted).toEqual(['/v/New/a.excalidraw'])
    })
  })
})

/** A fake `window.yaseenDraw` with just the surface storage touches (the storage.test.ts pattern). */
type IdentityFixture = Omit<WindowIdentity, 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'> & Partial<Pick<WindowIdentity, 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'>>

function installBridge(app: AppState, identity: IdentityFixture) {
  const bridge = {
    state: {
      get: vi.fn(async () => app),
      setFolder: vi.fn(async () => undefined),
      onChange: vi.fn(() => () => undefined),
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
    },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return bridge
}

afterEach(() => {
  history.replaceState(null, '', '/')
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  vi.restoreAllMocks()
})

describe('bootTabs (rules 12/15)', () => {
  const seeded: AppState = {
    ...defaultAppState(),
    folders: { '/v': { expanded: [], lastFile: '/v/last.excalidraw', sortOrder: 'name', name: null } },
  }

  it('restores the stored tabs with the identity file active; only the active tab mounts', async () => {
    installBridge(seeded, { id: 'w1', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], sidebarCollapsed: false })
    await storage.init()
    expect(bootTabs('/v')).toEqual(state(['/v/a.excalidraw', '/v/b.excalidraw'], '/v/b.excalidraw'))
  })

  it('a pasted #hash wins as active and is PREPENDED when missing from the stored tabs', async () => {
    installBridge(seeded, { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false })
    await storage.init()
    history.replaceState(null, '', '#/v/pasted.excalidraw')
    expect(bootTabs('/v')).toEqual(state(['/v/pasted.excalidraw', '/v/a.excalidraw'], '/v/pasted.excalidraw'))
  })

  it('a fresh window falls back to the folder lastFile; a null root (Welcome) is empty', async () => {
    installBridge(seeded, { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false })
    await storage.init()
    expect(bootTabs('/v')).toEqual(state(['/v/last.excalidraw'], '/v/last.excalidraw'))
    expect(bootTabs(null)).toEqual(state([], null))
  })
})

describe('useWorkspace legacy main-tab mirror', () => {
  let reactRoot: Root | null = null
  let latest: UseWorkspace
  let bridge: ReturnType<typeof installBridge>

  function Probe({ root }: { root: string | null }) {
    latest = useWorkspace(root)
    return null
  }

  beforeEach(async () => {
    bridge = installBridge(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false })
    await storage.init()
    reactRoot = createRoot(document.createElement('div'))
    act(() => reactRoot?.render(<Probe root="/v" />))
  })

  afterEach(() => {
    act(() => reactRoot?.unmount())
    reactRoot = null
  })

  it('every mutating action sends ONE setIdentity carrying BOTH tabs and file, plus the folder lastFile', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(1)
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw'], file: '/v/a.excalidraw' })
    expect(bridge.state.setFolder).toHaveBeenLastCalledWith('/v', { lastFile: '/v/a.excalidraw' })

    act(() => latest.openBackground('/v/b.excalidraw'))
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], file: '/v/a.excalidraw' })

    act(() => latest.next())
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], file: '/v/b.excalidraw' })

    act(() => latest.close('/v/a.excalidraw'))
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/b.excalidraw'], file: '/v/b.excalidraw' })
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(4)
  })

  it('a no-op action mirrors nothing', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(1)
    act(() => latest.activate('/v/a.excalidraw')) // already active
    act(() => latest.openBackground('/v/a.excalidraw')) // already open
    act(() => latest.prev()) // one tab: nothing to cycle
    act(() => latest.close('/v/zzz.excalidraw')) // unknown
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(1)
  })

  it('move mirrors the reorder as ONE {tabs, file} write with the active file unchanged; a no-op move mirrors nothing', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    act(() => latest.openBackground('/v/b.excalidraw'))
    const writes = bridge.window.setIdentity.mock.calls.length
    act(() => latest.move(0, 1))
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(writes + 1)
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/b.excalidraw', '/v/a.excalidraw'], file: '/v/a.excalidraw' })
    act(() => latest.move(1, 1))
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(writes + 1)
  })

  it('closeActive reports whether there was a tab to close (false → App escalates to closeSelf)', () => {
    let closed: boolean | undefined
    act(() => {
      closed = latest.closeActive()
    })
    expect(closed).toBe(false)
    act(() => latest.openCurrent('/v/a.excalidraw'))
    act(() => {
      closed = latest.closeActive()
    })
    expect(closed).toBe(true)
    expect(latest.tabs).toEqual([])
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: [], file: null })
  })

  it('canBack / canForward read the ACTIVE tab\'s place in its own stack (YAZ-721 D1)', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    act(() => latest.openCurrent('/v/b.excalidraw'))
    act(() => latest.openCurrent('/v/c.excalidraw'))
    expect(latest.canBack).toBe(true)
    expect(latest.canForward).toBe(false)

    act(() => latest.back())
    expect(latest.active).toBe('/v/b.excalidraw')
    expect(latest.canBack).toBe(true)
    expect(latest.canForward).toBe(true)
  })

  it('back mirrors ONE {tabs, file} write — the stacks never reach storage', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    act(() => latest.openCurrent('/v/b.excalidraw'))
    const writes = bridge.window.setIdentity.mock.calls.length
    act(() => latest.back())
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(writes + 1)
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw'], file: '/v/a.excalidraw' })
  })

  it('back at the start of the stack (and forward at its end) mirror nothing', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    const writes = bridge.window.setIdentity.mock.calls.length
    act(() => latest.back())
    act(() => latest.forward())
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(writes)
  })

  it('reset with a restored file mirrors against the EXPLICIT new root; an empty reset mirrors nothing', () => {
    act(() => latest.openCurrent('/v/a.excalidraw'))
    act(() => latest.reset('/w', '/w/b.excalidraw'))
    expect(latest.tabs).toEqual(['/w/b.excalidraw'])
    expect(bridge.state.setFolder).toHaveBeenLastCalledWith('/w', { lastFile: '/w/b.excalidraw' })
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/w/b.excalidraw'], file: '/w/b.excalidraw' })
    const writes = bridge.window.setIdentity.mock.calls.length
    act(() => latest.reset(null, null)) // rides on setRoot's own {root, file: null, tabs: []} write
    expect(latest.tabs).toEqual([])
    expect(latest.active).toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(writes)
  })
})

/**
 * Delete (GRO-2272 `B2-`): deleting a tab IS closing it. These assertions exist to keep the
 * two in step — divergence would show up as "deleting the active drawing picks a different tab
 * than ⌘W does", which nobody reports and everybody feels.
 */
describe('delete / delete-dir (GRO-2272)', () => {
  const S = (tabs: string[], active: string | null, mounted: string[] = tabs): TabsState => ({ tabs, active, mounted, history: {} })

  it('deleting a NON-active tab leaves the active one alone', () => {
    const next = tabsReducer(S(['/a.excalidraw', '/b.excalidraw', '/c.excalidraw'], '/a.excalidraw'), { type: 'delete', path: '/b.excalidraw' })
    expect(next.tabs).toEqual(['/a.excalidraw', '/c.excalidraw'])
    expect(next.active).toBe('/a.excalidraw')
    expect(next.mounted).toEqual(['/a.excalidraw', '/c.excalidraw'])
  })

  it('deleting the ACTIVE tab promotes the right neighbour', () => {
    const next = tabsReducer(S(['/a.excalidraw', '/b.excalidraw', '/c.excalidraw'], '/b.excalidraw'), { type: 'delete', path: '/b.excalidraw' })
    expect(next.tabs).toEqual(['/a.excalidraw', '/c.excalidraw'])
    expect(next.active).toBe('/c.excalidraw')
  })

  it('deleting the LAST tab falls back to the left neighbour', () => {
    const next = tabsReducer(S(['/a.excalidraw', '/b.excalidraw'], '/b.excalidraw'), { type: 'delete', path: '/b.excalidraw' })
    expect(next.active).toBe('/a.excalidraw')
  })

  it('deleting the ONLY tab empties the window; it stays alive', () => {
    const next = tabsReducer(S(['/a.excalidraw'], '/a.excalidraw'), { type: 'delete', path: '/a.excalidraw' })
    expect(next).toEqual({ tabs: [], active: null, mounted: [], history: {} })
  })

  it('deleting a path that is not open returns the SAME state object (no identity mirror)', () => {
    const before = S(['/a.excalidraw'], '/a.excalidraw')
    expect(tabsReducer(before, { type: 'delete', path: '/never.excalidraw' })).toBe(before)
  })

  it('delete matches close exactly — the heir ladder is shared, not re-implemented', () => {
    const before = S(['/a.excalidraw', '/b.excalidraw', '/c.excalidraw'], '/b.excalidraw')
    expect(tabsReducer(before, { type: 'delete', path: '/b.excalidraw' })).toEqual(tabsReducer(before, { type: 'close', path: '/b.excalidraw' }))
  })

  it('delete-dir drops every tab under the prefix in one dispatch and picks a survivor', () => {
    const next = tabsReducer(S(['/Docs/a.excalidraw', '/x.excalidraw', '/Docs/deep/b.excalidraw'], '/Docs/a.excalidraw'), { type: 'delete-dir', path: '/Docs' })
    expect(next.tabs).toEqual(['/x.excalidraw'])
    expect(next.active).toBe('/x.excalidraw')
    expect(next.mounted).toEqual(['/x.excalidraw'])
  })

  it('delete-dir empties the window when every tab was under the folder', () => {
    const next = tabsReducer(S(['/Docs/a.excalidraw', '/Docs/b.excalidraw'], '/Docs/a.excalidraw'), { type: 'delete-dir', path: '/Docs' })
    expect(next).toEqual({ tabs: [], active: null, mounted: [], history: {} })
  })

  it('delete-dir needs a real path segment: /Docsy.excalidraw is not under /Docs', () => {
    const before = S(['/Docsy.excalidraw'], '/Docsy.excalidraw')
    expect(tabsReducer(before, { type: 'delete-dir', path: '/Docs' })).toBe(before)
  })

  it('every invariant survives both actions: active in tabs, empty iff null, mounted a subset', () => {
    for (const action of [{ type: 'delete', path: '/b.excalidraw' }, { type: 'delete-dir', path: '/Docs' }] as const) {
      const next = tabsReducer(S(['/Docs/a.excalidraw', '/b.excalidraw', '/c.excalidraw'], '/b.excalidraw'), action)
      if (next.active !== null) expect(next.tabs).toContain(next.active)
      expect(next.tabs.length === 0).toBe(next.active === null)
      expect(new Set(next.tabs).size).toBe(next.tabs.length)
      for (const m of next.mounted) expect(next.tabs).toContain(m)
    }
  })
})
