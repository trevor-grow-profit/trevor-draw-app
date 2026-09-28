/**
 * The App shell: Welcome on a null root with no auto-dialog (C2, GRO-2164) and openRoot
 * switching the window's folder in place (C3, GRO-2165). Editor and Sidebar are mocked to
 * observable stubs; the bridge is the jsdom stub pattern (storage.test.ts), so the real
 * storage / api / hook modules run against it.
 */
import { LINK_NOTICE_MS, type NoticeKind } from './lib/notice'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, defaultAppState, defaultFolderState, type AppState, type GithubSyncStatus, type PickFolderResponse, type SidebarLens, type TreeResponse, type WindowIdentity } from '@shared/types'
import * as continuity from './lib/renameContinuity'
import { storage } from './lib/storage'

interface SidebarStubProps {
  root: string
  activeFile: string | null
  onOpenFile: (path: string) => void
  onOpenFileBackground: (path: string) => void
  onRootMissing: () => void
  onFileMissing: () => void
  /** The ONE rename door: the inline rename AND the drag-move both arrive through it. */
  onRenameFile: (oldPath: string, newPath: string, kind: 'file' | 'dir') => Promise<void>
  pendingSearchFocus: boolean
  /** ⌘O (YAZ-1767 D8): a counter, bumped per request; 0 = none pending for this root. */
  switcherOpenRequest: number
  /** The lens tabs (YAZ-847): App owns the value and the write-through; the sidebar only reports clicks. */
  lens: SidebarLens
  onLensChange: (lens: SidebarLens) => void
  onCollapse: () => void
  revealRequest?: { id: number; path: string; lens: SidebarLens }
  onRevealConsumed?: (id: number) => void
  /** A folder search row (🔒 YAZ-1491 D3): App flips to Files and issues a reveal request for the dir. */
  onRevealInFiles?: (path: string) => void
  onNotice: (message: string, icon?: NoticeKind) => void
  /** ⌘C / ⌘X / ⌘V's handle (⚡ YAZ-1674 D6 amended): App asks, the Sidebar (here a stub) answers. */
  clipboardRef: { current: { cutOrCopy: (op: 'copy' | 'cut') => boolean; paste: () => boolean } | null }
  /** YAZ-1801 D3: the held-back files, as the tree's absolute paths. */
  tooLarge?: ReadonlySet<string>
}

const captured = vi.hoisted(() => ({
  sidebar: null as SidebarStubProps | null,
  history: null as { path: string; fromMerge?: boolean } | null,
}))

vi.mock('./Editor', () => ({
  Editor: ({ path }: { path: string | null }) => <div data-editor data-path={path ?? ''} />,
}))
vi.mock('./sidebar/Sidebar', () => ({
  Sidebar: (props: SidebarStubProps) => {
    captured.sidebar = props
    return <aside data-sidebar data-root={props.root} />
  },
}))

vi.mock('./history/VersionHistory', () => ({
  VersionHistory: (props: { path: string; fromMerge?: boolean }) => {
    captured.history = props
    return <div data-version-history={props.path} />
  },
}))
vi.mock('./share/liveShare', async (importOriginal) => ({ ...(await importOriginal<typeof import('./share/liveShare')>()), noteBoardSaved: vi.fn() }))

import { App } from './App'
import { noteBoardSaved } from './share/liveShare'


/** The `window.yaseenDraw` surface the App tree touches, all observable. */
type IdentityFixture = Omit<WindowIdentity, 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'> & Partial<Pick<WindowIdentity, 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'>>

function installBridge(state: AppState, identity: IdentityFixture) {
  const stateChanged = new Set<(next: AppState) => void>()
  const menuOpenFolder = new Set<() => void>()
  const menuOpenRoot = new Set<(path: string) => void>()
  const menuSearch = new Set<() => void>()
  const menuSwitchVault = new Set<() => void>()
  const menuSettings = new Set<() => void>()
  const menuToggleSidebar = new Set<() => void>()
  const menuCloseTab = new Set<() => void>()
  const menuNextTab = new Set<() => void>()
  const menuPrevTab = new Set<() => void>()
  const menuExportImage = new Set<() => void>()
  const menuCanvasBackground = new Set<() => void>()
  const menuExportDrawing = new Set<() => void>()
  const linkOpenFile = new Set<(path: string) => void>()
  const linkNotice = new Set<(message: string) => void>()
  const fileRenamed = new Set<(ev: { oldPath: string; newPath: string; kind?: 'file' | 'dir' }) => void>()
  const fileDeleted = new Set<(ev: { path: string; kind: 'file' | 'dir' }) => void>()
  const syncStatus = new Set<(status: GithubSyncStatus) => void>()
  const menuSub = (set: Set<() => void>) =>
    vi.fn((l: () => void) => {
      set.add(l)
      return () => set.delete(l)
    })
  const bridge = {
    tree: vi.fn(async (root: string): Promise<TreeResponse> => ({ root, tree: [], generatedAt: 1 })),
    readFile: vi.fn(async (path: string) => ({ path, content: '', mtime: 1, size: 0 })),
    writeFile: vi.fn(async ({ path, content }: { path: string; content: string }) => ({ path, mtime: 2, size: content.length })),
    pickFolder: vi.fn(async (): Promise<PickFolderResponse> => ({ cancelled: true })),
    watch: vi.fn(() => () => undefined),
    state: {
      get: vi.fn(async () => state),
      setSettings: vi.fn(async () => undefined),
      setSidebarWidth: vi.fn(async () => undefined),
      pushRecent: vi.fn(async () => undefined),
      removeRecent: vi.fn(async () => undefined),
      setFolder: vi.fn(async () => undefined),
      onChange: vi.fn((listener: (next: AppState) => void) => {
        stateChanged.add(listener)
        return () => stateChanged.delete(listener)
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
      closeSelf: vi.fn(async () => undefined),
      openRecent: vi.fn(async () => true),
      onFlush: vi.fn(() => () => undefined),
    },
    menu: {
      onOpenFolder: menuSub(menuOpenFolder),
      onOpenRoot: vi.fn((l: (path: string) => void) => {
        menuOpenRoot.add(l)
        return () => menuOpenRoot.delete(l)
      }),
      onSearch: menuSub(menuSearch),
      onSwitchVault: menuSub(menuSwitchVault),
      onSettings: menuSub(menuSettings),
      onToggleSidebar: menuSub(menuToggleSidebar),
      onCloseTab: menuSub(menuCloseTab),
      onNextTab: menuSub(menuNextTab),
      onPrevTab: menuSub(menuPrevTab),
      // 🔒 YAZ-1775 D10 / D3: the three canvas items; App routes them to the visible drawing layer by DOM.
      onExportImage: menuSub(menuExportImage),
      onCanvasBackground: menuSub(menuCanvasBackground),
      onExportDrawing: menuSub(menuExportDrawing),
      onShareLink: vi.fn(() => () => undefined),
    },
    link: {
      onOpenFile: vi.fn((l: (path: string) => void) => {
        linkOpenFile.add(l)
        return () => linkOpenFile.delete(l)
      }),
      onNotice: vi.fn((l: (message: string) => void) => {
        linkNotice.add(l)
        return () => linkNotice.delete(l)
      }),
    },
    // In-app rename (Links E1, GRO-2194): App subscribes to the renamed push on mount.
    file: {
      rename: vi.fn(async ({ oldPath, newPath }: { oldPath: string; newPath: string }) => ({ oldPath, newPath })),
      onRenamed: vi.fn((l: (ev: { oldPath: string; newPath: string; kind?: 'file' | 'dir' }) => void) => {
        fileRenamed.add(l)
        return () => fileRenamed.delete(l)
      }),
      // In-app delete (GRO-2272): the invoke plus the push every window receives.
      delete: vi.fn(async ({ path }: { path: string }) => ({ path, kind: 'file' as const })),
      onDeleted: vi.fn((l: (ev: { path: string; kind: 'file' | 'dir' }) => void) => {
        fileDeleted.add(l)
        return () => fileDeleted.delete(l)
      }),
    },
    // Sync off (YAZ-1081 YAZ-1817): App owns one `useGithubSync`, which subscribes on mount. `off` is
    // the real default for a vault nobody switched on — no chip state to assert here, and no
    // attention banner. The sync UI's own tests are SyncIndicator/SettingsDialog/syncAttention.
    github: {
      status: vi.fn(async (r: string) => ({ root: r, state: 'off' as const })),
      syncNow: vi.fn(async (r: string) => ({ root: r, state: 'off' as const })),
      setEnabled: vi.fn(async (r: string) => ({ root: r, state: 'off' as const })),
      onStatus: vi.fn((l: (status: GithubSyncStatus) => void) => {
        syncStatus.add(l)
        return () => syncStatus.delete(l)
      }),
    },
    // Settings › Sharing (YAZ-1799 D7): App's `useSharing` reads while Settings is open. Not set up.
    share: {
      status: vi.fn(async () => ({ state: 'off' as const, url: null, workersDevUrl: null, customDomain: null, accountName: null, workerName: null, bucketName: null, readyAt: null, demo: false })),
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
    },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return {
    bridge,
    emitStateChanged: (next: AppState) => stateChanged.forEach((listener) => listener(next)),
    emitOpenFolder: () => menuOpenFolder.forEach((l) => l()),
    emitOpenRoot: (path: string) => menuOpenRoot.forEach((l) => l(path)),
    emitSearch: () => menuSearch.forEach((l) => l()),
    emitSwitchVault: () => menuSwitchVault.forEach((l) => l()),
    emitSettings: () => menuSettings.forEach((l) => l()),
    emitToggleSidebar: () => menuToggleSidebar.forEach((l) => l()),
    emitCloseTab: () => menuCloseTab.forEach((l) => l()),
    emitNextTab: () => menuNextTab.forEach((l) => l()),
    emitPrevTab: () => menuPrevTab.forEach((l) => l()),
    emitExportImage: () => menuExportImage.forEach((l) => l()),
    emitCanvasBackground: (color: string) => menuCanvasBackground.forEach((l) => (l as unknown as (c: string) => void)(color)),
    emitExportDrawing: () => menuExportDrawing.forEach((l) => l()),
    emitLinkOpenFile: (path: string) => linkOpenFile.forEach((l) => l(path)),
    emitLinkNotice: (message: string) => linkNotice.forEach((l) => l(message)),
    emitFileRenamed: (oldPath: string, newPath: string, kind?: 'file' | 'dir') => fileRenamed.forEach((l) => l({ oldPath, newPath, kind })),
    emitFileDeleted: (path: string, kind: 'file' | 'dir' = 'file') => fileDeleted.forEach((l) => l({ path, kind })),
    emitSyncStatus: (status: GithubSyncStatus) => syncStatus.forEach((l) => l(status)),
  }
}

let root: Root | null = null
let container: HTMLElement | null = null

async function mount(state: AppState, identity: IdentityFixture) {
  const b = installBridge(state, identity)
  await storage.init()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<StrictMode><App /></StrictMode>))
  // Settle the in-flight bridge fetches the mount kicked off, inside act.
  await act(async () => {})
  return { ...b, el: container }
}

const recent = (path: string, lastOpened = 1) => ({ path, lastOpened })
const withFolder = (state: AppState, folderRoot: string, lastFile: string | null): AppState => ({
  ...state,
  folders: { ...state.folders, [folderRoot]: { ...defaultFolderState(), lastFile } },
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  captured.sidebar = null
  history.replaceState(null, '', '/')
  delete document.documentElement.dataset.theme
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  vi.restoreAllMocks()
})

describe('App per-window sidebar visibility (YAZ-1280)', () => {
  it('boots from window identity and View › Toggle Sidebar reuses the one local toggle path', async () => {
    const { bridge, el, emitToggleSidebar } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: true })
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    act(() => emitToggleSidebar())
    expect(el.querySelector('[data-sidebar]')).not.toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ sidebarCollapsed: false })
  })

  it('plain Cmd+B on app chrome prevents default, toggles once, and the listener is removed on unmount', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false })
    const event = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true })
    act(() => void el.querySelector('.app')?.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenCalledExactlyOnceWith({ sidebarCollapsed: true })

    act(() => root?.unmount())
    root = null
    const afterUnmount = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(afterUnmount)
    expect(afterUnmount.defaultPrevented).toBe(false)
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(1)
  })
})

/**
 * ⌘C / ⌘X / ⌘V for the sidebar's FILE clipboard (D6 amended, YAZ-1674): the keys are App's
 * window listener — a panel listener needs focus inside the panel, and after a click on the open
 * file it sits in the document pane, on blank space nowhere focusable — with the ownership
 * boundary that leaves a field, a contenteditable or a modal holding the key, so text
 * copy/paste is untouched. The Sidebar's handle holds the rules and answers whether it acted;
 * App swallows the key exactly then.
 */
describe('App ⌘C / ⌘X / ⌘V file clipboard (YAZ-1674, D6 amended)', () => {
  const chord = (key: string, over: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...over })
  const handle = () => ({ cutOrCopy: vi.fn((_op: 'copy' | 'cut') => true), paste: vi.fn(() => true) })
  const arm = (h: ReturnType<typeof handle>) => {
    const ref = captured.sidebar?.clipboardRef
    expect(ref).toBeDefined()
    if (ref) ref.current = h
  }
  const open = () => mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })

  it('acts from the body, from a tree row and from blank space alike: copy / cut / paste reach the handle and the key is swallowed', async () => {
    const { el } = await open()
    const h = handle()
    arm(h)
    const row = document.createElement('button')
    row.className = 'tree__row'
    el.querySelector('[data-sidebar]')?.appendChild(row)
    const fromBody = chord('c')
    act(() => void el.querySelector('.app')?.dispatchEvent(fromBody))
    const fromRow = chord('x')
    act(() => void row.dispatchEvent(fromRow))
    const fromBlank = chord('v')
    act(() => void document.body.dispatchEvent(fromBlank))
    expect(h.cutOrCopy.mock.calls).toEqual([['copy'], ['cut']])
    expect(h.paste).toHaveBeenCalledTimes(1)
    expect([fromBody, fromRow, fromBlank].map((e) => e.defaultPrevented)).toEqual([true, true, true])
  })

  it('does NOTHING from a contenteditable or an input — text copy/paste keeps working, the key is left alone', async () => {
    const { el } = await open()
    const h = handle()
    arm(h)
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const input = document.createElement('input')
    el.querySelector('.app')?.append(editable, input)
    const events = [chord('c'), chord('v'), chord('x'), chord('v')]
    act(() => {
      editable.dispatchEvent(events[0]!)
      editable.dispatchEvent(events[1]!)
      input.dispatchEvent(events[2]!)
      input.dispatchEvent(events[3]!)
    })
    expect(h.cutOrCopy).not.toHaveBeenCalled()
    expect(h.paste).not.toHaveBeenCalled()
    expect(events.every((e) => !e.defaultPrevented)).toBe(true)
  })

  it('Shift or ⌥ held is not ours, and a handle that declines leaves the key alone', async () => {
    const { el } = await open()
    const h = { cutOrCopy: vi.fn(() => false), paste: vi.fn(() => false) }
    arm(h)
    const shifted = chord('c', { shiftKey: true })
    const alted = chord('v', { altKey: true })
    const declined = chord('v')
    act(() => {
      el.querySelector('.app')?.dispatchEvent(shifted)
      el.querySelector('.app')?.dispatchEvent(alted)
      el.querySelector('.app')?.dispatchEvent(declined)
    })
    expect(h.cutOrCopy).not.toHaveBeenCalled()
    expect(h.paste).toHaveBeenCalledTimes(1) // asked…
    expect(declined.defaultPrevented).toBe(false) // …and not swallowed, because it said no
    expect(alted.defaultPrevented).toBe(false)
  })

  it('with the sidebar collapsed (no handle) the keys are not ours at all', async () => {
    const { el } = await open()
    const ref = captured.sidebar?.clipboardRef
    if (ref) ref.current = null
    const ev = chord('v')
    act(() => void el.querySelector('.app')?.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(false)
  })
})

/**
 * The notice's glyph (D10 amended, YAZ-1674): `onNotice(text, icon?)` — the kind rides on the
 * toast as `data-icon` and draws an aria-hidden SVG before the text, so `textContent` and the
 * `role="status"` announcement stay the bare text. No kind → `'info'`, which is what every caller
 * that never changed gets.
 */
describe('App notice icon (D10 amended, YAZ-1674)', () => {
  const open = () => mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })

  it.each(['copy', 'cut', 'paste', 'favorite', 'error', 'info'] as const)('renders data-icon="%s" and an aria-hidden svg before the bare text', async (icon) => {
    const { el } = await open()
    act(() => captured.sidebar?.onNotice(`hello ${icon}`, icon))
    const toast = el.querySelector<HTMLElement>('.link-notice')
    expect(toast?.dataset.icon).toBe(icon)
    expect(toast?.getAttribute('role')).toBe('status')
    expect(toast?.textContent).toBe(`hello ${icon}`)
    const svg = toast?.querySelector('svg.link-notice__icon')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(toast?.firstElementChild).toBe(svg)
  })

  it('defaults to info when the caller names no kind', async () => {
    const { el } = await open()
    act(() => captured.sidebar?.onNotice('plain'))
    expect(el.querySelector<HTMLElement>('.link-notice')?.dataset.icon).toBe('info')
    expect(el.querySelector('.link-notice')?.textContent).toBe('plain')
  })
})

describe('App files held back as too large (YAZ-1801 D3)', () => {
  it('shows the too-large banner with NO Dismiss, and hands the sidebar the held-back files as absolute tree paths', async () => {
    const { el, emitSyncStatus } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    await act(async () => emitSyncStatus({ root: '/v', state: 'attention', attention: 'too-large', tooLarge: ['Folder/Big video.mov'], enabled: true }))
    const banner = el.querySelector('.sync-banner')
    expect(banner?.textContent).toContain('Big video.mov is over GitHub')
    expect([...(banner?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).not.toContain('Dismiss')
    expect([...(captured.sidebar?.tooLarge ?? [])]).toEqual(['/v/Folder/Big video.mov'])

    await act(async () => emitSyncStatus({ root: '/v', state: 'synced', enabled: true }))
    expect(el.querySelector('.sync-banner')).toBeNull()
    expect([...(captured.sidebar?.tooLarge ?? [])]).toEqual([])
  })
})

describe('App after a sync pass that merged (YAZ-1897 D4)', () => {
  it('says so once with "See changes", which opens Version history on the merged board; shared links re-upload', async () => {
    const { el, emitSyncStatus } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    await act(async () => emitSyncStatus({ root: '/v', state: 'synced', enabled: true, merged: [{ path: 'Plans/Roadmap.excalidraw', author: 'Sam', clashes: 2 }] }))
    const toast = el.querySelector<HTMLElement>('.link-notice')
    expect(toast?.querySelector('.link-notice__text')?.textContent).toBe("Merged Sam's changes into “Roadmap” · 2 shapes edited on both — kept the newest.")
    expect(noteBoardSaved).toHaveBeenCalledWith('/v', '/v/Plans/Roadmap.excalidraw')
    // The next ordinary status must not replay it.
    await act(async () => emitSyncStatus({ root: '/v', state: 'synced', enabled: true }))
    await act(async () => el.querySelector<HTMLButtonElement>('.link-notice__action')?.click())
    expect(captured.history).toMatchObject({ path: '/v/Plans/Roadmap.excalidraw', fromMerge: true })
    expect(el.querySelector('.link-notice')).toBeNull()
  })

  it('a notice with an action waits to be dismissed instead of fading', async () => {
    vi.useFakeTimers()
    try {
      const { el, emitSyncStatus } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
      await act(async () => emitSyncStatus({ root: '/v', state: 'synced', enabled: true, merged: [{ path: 'a.excalidraw', author: 'Sam', clashes: 0 }] }))
      await act(async () => vi.advanceTimersByTime(60_000))
      expect(el.querySelector('.link-notice')).not.toBeNull()
      await act(async () => el.querySelector<HTMLButtonElement>('.link-notice__close')?.click())
      expect(el.querySelector('.link-notice')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('App on a null root (C2, GRO-2164)', () => {
  it('boots to the Welcome screen with the recents and never auto-opens the folder dialog', async () => {
    const { bridge, el } = await mount({ ...defaultAppState(), recents: [recent('/vaults/notes')] }, { id: 'w1', root: null, file: null, tabs: [] })
    expect(el.querySelector('.welcome__title')?.textContent).toBe('Yaseen Draw')
    expect([...el.querySelectorAll('.welcome__recent-path')].map((s) => s.textContent)).toEqual(['/vaults/notes'])
    expect(bridge.pickFolder).not.toHaveBeenCalled()
    expect(el.querySelector('[data-editor]')).toBeNull()
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    expect(el.querySelector('.tabbar')).toBeNull() // the tab strip never shows on Welcome (rule 2)
  })

  it('clicking a live recent opens that folder in place, on its remembered last file', async () => {
    const state = withFolder({ ...defaultAppState(), recents: [recent('/vaults/notes')] }, '/vaults/notes', '/vaults/notes/a.excalidraw')
    const { bridge, el } = await mount(state, { id: 'w1', root: null, file: null, tabs: [] })
    await act(async () => el.querySelector<HTMLButtonElement>('.welcome__recent')?.click())
    expect(el.querySelector('.welcome')).toBeNull()
    expect(el.querySelector('[data-sidebar]')?.getAttribute('data-root')).toBe('/vaults/notes')
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/vaults/notes/a.excalidraw')
    expect(location.hash).toBe('#/vaults/notes/a.excalidraw')
    expect(bridge.state.pushRecent).toHaveBeenCalledWith('/vaults/notes')
  })

  it('clicking a dead recent marks the row, drops the MRU entry and does not switch the window', async () => {
    const { bridge, el } = await mount({ ...defaultAppState(), recents: [recent('/vaults/gone')] }, { id: 'w1', root: null, file: null, tabs: [] })
    bridge.tree.mockRejectedValue({ code: 'NOT_FOUND', message: 'path does not exist' })
    await act(async () => el.querySelector<HTMLButtonElement>('.welcome__recent')?.click())
    expect(bridge.state.removeRecent).toHaveBeenCalledWith('/vaults/gone')
    expect(bridge.state.pushRecent).not.toHaveBeenCalled()
    expect(bridge.window.setIdentity).not.toHaveBeenCalled()
    expect(el.querySelector('.welcome__recent-when')?.textContent).toBe('Folder not found')
    expect(el.querySelector('[data-sidebar]')).toBeNull()
  })
})

describe('App openRoot (C3, GRO-2165)', () => {
  it('File › Open Recent switches the window in place: sidebar re-keyed, prior tabs cleared, file ← the folder\'s lastFile as the sole tab, hash synced', async () => {
    const state = withFolder(defaultAppState(), '/w', '/w/b.excalidraw')
    const { bridge, el, emitOpenRoot } = await mount(state, { id: 'w1', root: '/v', file: '/v/old.excalidraw', tabs: ['/v/old.excalidraw', '/v/z.excalidraw'] })
    await act(async () => emitOpenRoot('/w'))
    expect(el.querySelector('[data-sidebar]')?.getAttribute('data-root')).toBe('/w')
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/w/b.excalidraw')
    expect([...el.querySelectorAll('.tabbar [role="tab"]')].map((t) => t.textContent)).toEqual(['b'])
    expect(location.hash).toBe('#/w/b.excalidraw')
    expect(bridge.state.pushRecent).toHaveBeenCalledWith('/w')
    // The window entry records the switch (D6, tabs rule 13): ONE write clears root's file+tabs,
    // then ONE {tabs, file} write restores the folder's remembered file.
    expect(bridge.window.setIdentity.mock.calls).toEqual([
      [{ root: '/w', file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] }],
      [{ tabs: ['/w/b.excalidraw'], file: '/w/b.excalidraw' }],
    ])
  })

  it('switching to a folder with no remembered last file leaves no file open', async () => {
    const { bridge, el, emitOpenRoot } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    await act(async () => emitOpenRoot('/w'))
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('')
    expect(location.hash).toBe('')
    expect(bridge.window.setIdentity.mock.calls).toEqual([[{ root: '/w', file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] }]])
  })

  it('a dead recent chosen from the menu drops the MRU entry and leaves the window on its folder', async () => {
    const { bridge, el, emitOpenRoot } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    bridge.tree.mockRejectedValue({ code: 'NOT_FOUND', message: 'path does not exist' })
    await act(async () => emitOpenRoot('/gone'))
    expect(bridge.state.removeRecent).toHaveBeenCalledWith('/gone')
    expect(bridge.window.setIdentity).not.toHaveBeenCalled()
    expect(el.querySelector('[data-sidebar]')?.getAttribute('data-root')).toBe('/v')
  })
})

describe('App boot on a window entry with a file (D2, GRO-2168)', () => {
  it('the entry file wins over the folder lastFile: a ⌘-click window opens on the clicked file', async () => {
    const state = withFolder(defaultAppState(), '/v', '/v/last.excalidraw')
    const { el } = await mount(state, { id: 'w2', root: '/v', file: '/v/picked.excalidraw', tabs: ['/v/picked.excalidraw'] })
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/picked.excalidraw')
  })
})

describe('App window title (C3, GRO-2165)', () => {
  it('is "<file> — <folder>" with a file open, the folder alone without one, the app name on Welcome', async () => {
    const state = withFolder(defaultAppState(), '/vaults/w', '/vaults/w/Note.excalidraw')
    const { emitOpenRoot } = await mount(state, { id: 'w1', root: null, file: null, tabs: [] })
    expect(document.title).toBe('Yaseen Draw')
    await act(async () => emitOpenRoot('/vaults/w'))
    expect(document.title).toBe('Note — w')
    await act(async () => emitOpenRoot('/vaults/empty'))
    expect(document.title).toBe('empty')
  })
})

describe('App deep links (E1, GRO-2171)', () => {
  it('link:open-file selects the file through the same path as a sidebar click: editor, hash, identity', async () => {
    const { bridge, el, emitLinkOpenFile } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    await act(async () => emitLinkOpenFile('/v/sub/linked.excalidraw'))
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/sub/linked.excalidraw')
    expect(location.hash).toBe('#/v/sub/linked.excalidraw')
    expect(bridge.state.setFolder).toHaveBeenCalledWith('/v', { lastFile: '/v/sub/linked.excalidraw' })
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ tabs: ['/v/sub/linked.excalidraw'], file: '/v/sub/linked.excalidraw' })
  })

  it('link:notice shows the transient banner, which dismisses itself after LINK_NOTICE_MS', async () => {
    const { el, emitLinkNotice } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    vi.useFakeTimers()
    try {
      act(() => emitLinkNotice("Can't open /v/a.txt: not a drawing"))
      expect(el.querySelector('.link-notice')?.textContent).toBe("Can't open /v/a.txt: not a drawing")
      act(() => vi.advanceTimersByTime(LINK_NOTICE_MS))
      expect(el.querySelector('.link-notice')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('App rename push (Links E1, GRO-2194)', () => {
  it('file:renamed remaps the active tab in place: strip label, editor, hash, title and ONE identity mirror', async () => {
    const { bridge, el, emitFileRenamed } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/B.excalidraw', tabs: ['/v/B.excalidraw', '/v/x.excalidraw'] })
    vi.mocked(bridge.window.setIdentity).mockClear()
    await act(async () => emitFileRenamed('/v/B.excalidraw', '/v/C.excalidraw'))
    expect([...el.querySelectorAll('.tabbar [role="tab"]')].map((t) => t.textContent)).toEqual(['C', 'x'])
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('C')
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/C.excalidraw')
    expect(location.hash).toBe('#/v/C.excalidraw')
    expect(document.title).toBe('C — v')
    expect(bridge.window.setIdentity).toHaveBeenCalledTimes(1)
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ tabs: ['/v/C.excalidraw', '/v/x.excalidraw'], file: '/v/C.excalidraw' })
  })

  it('a rename of a file this window does not show changes nothing (no identity write)', async () => {
    const { bridge, emitFileRenamed } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw'] })
    vi.mocked(bridge.window.setIdentity).mockClear()
    await act(async () => emitFileRenamed('/other/B.excalidraw', '/other/C.excalidraw'))
    expect(bridge.window.setIdentity).not.toHaveBeenCalled()
  })

  it('retires the old editor BEFORE the workspace repair, and a dir rename remaps every open tab under the folder', async () => {
    const order: string[] = []
    const retire = vi.spyOn(continuity, 'retirePath').mockImplementation(() => void order.push('retire'))
    const retireDirSpy = vi.spyOn(continuity, 'retireDir')
    const { bridge, el, emitFileRenamed } = await mount(defaultAppState(), {
      id: 'w1',
      root: '/v',
      file: '/v/Docs/a.excalidraw',
      tabs: ['/v/Docs/a.excalidraw', '/v/x.excalidraw'],
    })
    vi.mocked(bridge.window.setIdentity).mockImplementation(async () => void order.push('workspace'))
    await act(async () => emitFileRenamed('/v/Docs/a.excalidraw', '/v/Docs/b.excalidraw', 'file'))
    expect(order).toEqual(['retire', 'workspace'])
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/Docs/b.excalidraw')

    // A `dir` event is a PREFIX remap: every open editor and tab under the folder follows.
    await act(async () => emitFileRenamed('/v/Docs', '/v/Notes', 'dir'))
    expect(retireDirSpy).toHaveBeenCalledWith('/v/Docs')
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/Notes/b.excalidraw')
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({
      tabs: ['/v/Notes/b.excalidraw', '/v/x.excalidraw'],
      file: '/v/Notes/b.excalidraw',
    })
    retire.mockRestore()
  })
})

describe('App appearance (Desktop K, GRO-2218)', () => {
  it('defaults to System, which reads as light here (jsdom has no matchMedia): data-theme on <html>', async () => {
    await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('a stored Dark setting themes the very first render', async () => {
    const state: AppState = { ...defaultAppState(), settings: { ...DEFAULT_SETTINGS, theme: 'dark' } }
    await mount(state, { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('applies another window\'s theme change live through the existing state broadcast', async () => {
    const { emitStateChanged } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(document.documentElement.dataset.theme).toBe('light')
    act(() => emitStateChanged({ ...defaultAppState(), settings: { ...DEFAULT_SETTINGS, theme: 'dark' } }))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('App sidebar resize (YAZ-738)', () => {
  const drag = (el: HTMLElement, dx: number) => {
    el.querySelector('.sidebar-resize')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 0 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: dx }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: dx }))
  }
  /** The width is stamped on <html> (YAZ-738), where app.css reads it. */
  const sideW = () => document.documentElement.style.getPropertyValue('--side-w')

  it('a drag widens the sidebar live and persists the new width once', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(sideW()).toBe('260px')
    act(() => drag(el, 120))
    expect(sideW()).toBe('380px')
    expect(bridge.state.setSidebarWidth.mock.calls).toEqual([[380]])
  })

  it('dragging well past the minimum collapses the sidebar instead of writing a sliver width', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    act(() => drag(el, 50 - 260))
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    expect(sideW()).toBe('260px')
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ sidebarCollapsed: true })
    expect(bridge.state.setSidebarWidth).not.toHaveBeenCalled()
  })
})

/**
 * The sidebar's lens (🔒 YAZ-1775 D4, YAZ-847): App-owned, persisted as window identity (YAZ-1628), and
 * passed down — never a Sidebar-local flag. The sidebar is mounted `key={root}` and only while it
 * is open, so the collapse → reopen step below is the whole reason the value lives here.
 */
describe('App sidebar lens (🔒 YAZ-1775 D4, YAZ-847)', () => {
  it('mounts the sidebar on the STORED lens — Files by default', async () => {
    await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(captured.sidebar?.lens).toBe('files')
  })

  it('a stored `favorites` boots straight onto Favorites', async () => {
    await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarLens: 'favorites' })
    expect(captured.sidebar?.lens).toBe('favorites')
  })

  it('a tab click writes through to this window\'s identity and comes back down as the new lens', async () => {
    const { bridge } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    act(() => captured.sidebar?.onLensChange('favorites'))
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ sidebarLens: 'favorites' })
    expect(captured.sidebar?.lens).toBe('favorites')
  })

  it('the lens survives collapse → reopen, because the value is App\'s and not the sidebar\'s', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    act(() => captured.sidebar?.onLensChange('favorites'))
    // The strip's Show-sidebar button exists only while the sidebar is hidden (YAZ-1759).
    expect(el.querySelector('[aria-label="Show sidebar"]')).toBeNull()
    act(() => captured.sidebar?.onCollapse())
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    act(() => el.querySelector<HTMLButtonElement>('.tabbar-nav__btn[aria-label="Show sidebar"]')?.click())
    expect(el.querySelector('[data-sidebar]')).not.toBeNull()
    expect(captured.sidebar?.lens).toBe('favorites')
  })

  it('a switch to a DIFFERENT vault lands on Files; re-opening the same vault keeps the tab (Docs YAZ-1846 D2, YAZ-2056 D1)', async () => {
    const { emitOpenRoot } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarLens: 'favorites' })
    await act(async () => emitOpenRoot('/v'))
    expect(captured.sidebar?.lens).toBe('favorites')
    await act(async () => emitOpenRoot('/w'))
    expect(captured.sidebar?.root).toBe('/w')
    expect(captured.sidebar?.lens).toBe('files')
  })
})

/**
 * Reveal requests are App's (YAZ-1023, 🔒 YAZ-1775 D3 YAZ-1491): the sidebar unmounts while collapsed and
 * is re-keyed on every root, so the request — its id, its lens, its consumption — lives up here.
 * A FOLDER search row asks for one through `onRevealInFiles`: always the Files lens, whichever
 * lens was showing, because a folder exists on no other one.
 */
describe('App reveal request ownership (YAZ-1023, 🔒 YAZ-1775 D3 YAZ-1491)', () => {
  it('a folder search row flips the lens to FILES and issues the reveal request on that lens', async () => {
    await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarLens: 'favorites' })
    expect(captured.sidebar?.lens).toBe('favorites') // the row was chosen from Favorites
    act(() => captured.sidebar?.onRevealInFiles?.('/v/sub'))
    expect(captured.sidebar?.lens).toBe('files')
    expect(captured.sidebar?.revealRequest).toEqual({ id: 1, path: '/v/sub', lens: 'files' })
  })

  it('gives repeated requests for the same path a new identity', async () => {
    await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    act(() => captured.sidebar?.onRevealInFiles?.('/v/sub'))
    expect(captured.sidebar?.revealRequest?.id).toBe(1)
    act(() => captured.sidebar?.onRevealInFiles?.('/v/sub'))
    expect(captured.sidebar?.revealRequest).toEqual({ id: 2, path: '/v/sub', lens: 'files' })
  })

  it('consumes handled work without replaying it after collapse/reopen, while later gestures keep monotonic IDs', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    act(() => captured.sidebar?.onRevealInFiles?.('/v/sub'))
    expect(captured.sidebar?.revealRequest?.id).toBe(1)
    act(() => captured.sidebar?.onRevealConsumed?.(1))
    expect(captured.sidebar?.revealRequest).toBeNull()

    act(() => captured.sidebar?.onCollapse())
    act(() => el.querySelector<HTMLButtonElement>('.tabbar-nav__btn[aria-label="Show sidebar"]')?.click())
    expect(captured.sidebar?.revealRequest).toBeNull()

    act(() => captured.sidebar?.onRevealInFiles?.('/v/other'))
    expect(captured.sidebar?.revealRequest?.id).toBe(2)
  })

  it('a root switch drops the pending request with the sidebar that was showing it', async () => {
    const { emitOpenRoot } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    act(() => captured.sidebar?.onRevealInFiles?.('/v/sub'))
    expect(captured.sidebar?.revealRequest?.id).toBe(1)
    await act(async () => emitOpenRoot('/w'))
    expect(captured.sidebar?.root).toBe('/w')
    expect(captured.sidebar?.revealRequest).toBeNull()
  })
})

describe('App settings dialog (YAZ-1679)', () => {
  it('Yaseen Draw › Settings… (⌘,) mounts the ONE dialog, and its × unmounts it', async () => {
    const { el, emitSettings } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(el.querySelector('.settings-dialog')).toBeNull()
    // Async: opening Settings reads the share status (App's `useSharing`), which lands a tick later.
    await act(async () => emitSettings())
    expect(el.querySelector('.settings-dialog')).not.toBeNull()
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')?.click())
    expect(el.querySelector('.settings-dialog')).toBeNull()
  })
})

describe('App ⌘K search (D4, YAZ-804)', () => {
  it('from a collapsed sidebar it un-collapses through the global setting and mounts the sidebar with the focus flag already true', async () => {
    const { bridge, el, emitSearch } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: true })
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    act(() => emitSearch())
    expect(el.querySelector('[data-sidebar]')).not.toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ sidebarCollapsed: false })
    expect(captured.sidebar?.pendingSearchFocus).toBe(true)
  })

  it('with the sidebar already open it only raises the focus flag', async () => {
    const { bridge, emitSearch } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(captured.sidebar?.pendingSearchFocus).toBe(false)
    act(() => emitSearch())
    expect(captured.sidebar?.pendingSearchFocus).toBe(true)
    expect(bridge.window.setIdentity).not.toHaveBeenCalledWith({ sidebarCollapsed: false })
  })
})

describe('App ⌘O vault switcher (YAZ-1767 D8)', () => {
  it('from a collapsed sidebar it un-collapses first (the ⌘K handshake) and mounts the sidebar with a request pending', async () => {
    const { bridge, el, emitSwitchVault } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: true })
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    act(() => emitSwitchVault())
    expect(el.querySelector('[data-sidebar]')).not.toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ sidebarCollapsed: false })
    expect(captured.sidebar?.switcherOpenRequest).toBe(1)
  })

  it('with the sidebar open each ⌘O bumps the counter; the sidebar starts at 0', async () => {
    const { bridge, emitSwitchVault } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(captured.sidebar?.switcherOpenRequest).toBe(0)
    act(() => emitSwitchVault())
    expect(captured.sidebar?.switcherOpenRequest).toBe(1)
    act(() => emitSwitchVault())
    expect(captured.sidebar?.switcherOpenRequest).toBe(2)
    expect(bridge.window.setIdentity).not.toHaveBeenCalledWith({ sidebarCollapsed: false })
  })

  it('a request is pinned to the root it was made on: after an in-place root switch the remounted sidebar reads 0', async () => {
    const { emitSwitchVault, emitOpenRoot } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    act(() => emitSwitchVault())
    expect(captured.sidebar?.switcherOpenRequest).toBe(1)
    await act(async () => emitOpenRoot('/w'))
    expect(captured.sidebar?.root).toBe('/w')
    expect(captured.sidebar?.switcherOpenRequest).toBe(0)
    // A fresh request on the new root counts again.
    act(() => emitSwitchVault())
    expect(captured.sidebar?.switcherOpenRequest).toBe(2)
  })

  it('on Welcome (no root) it is a no-op — nothing to switch from', async () => {
    const { bridge, el, emitSwitchVault } = await mount(defaultAppState(), { id: 'w1', root: null, file: null, tabs: [] })
    act(() => emitSwitchVault())
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    expect(bridge.window.setIdentity).not.toHaveBeenCalledWith({ sidebarCollapsed: false })
  })
})

describe('App tabs (I2, GRO-2234)', () => {
  /** The strip's labels left→right. */
  const stripLabels = (el: HTMLElement) => [...el.querySelectorAll('.tabbar [role="tab"]')].map((t) => t.textContent)
  const activeLabel = (el: HTMLElement) => el.querySelector('[role="tab"][aria-selected="true"]')?.textContent
  /** Mounted editor layers as [path, hidden?] pairs (rule 6: visited tabs stay mounted, inactive hidden). */
  const layers = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('.tabstack__layer')].map((l) => [
      l.querySelector('[data-editor]')?.getAttribute('data-path'),
      l.classList.contains('tabstack__layer--hidden'),
    ])

  it('boots from the identity snapshot: every stored tab in the strip, ONLY the active editor mounted (rule 15)', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    expect(stripLabels(el)).toEqual(['a', 'b'])
    expect(activeLabel(el)).toBe('b')
    expect(layers(el)).toEqual([['/v/b.excalidraw', false]])
  })

  it('opening a path that is already a background tab activates it instead of duplicating it', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    act(() => captured.sidebar?.onOpenFileBackground('/v/b.excalidraw'))
    act(() => captured.sidebar?.onOpenFileBackground('/v/b.excalidraw'))
    expect(stripLabels(el)).toEqual(['a', 'b'])
    expect(activeLabel(el)).toBe('a')
    expect(layers(el)).toEqual([['/v/a.excalidraw', false]])

    act(() => captured.sidebar?.onOpenFile('/v/b.excalidraw'))
    expect(stripLabels(el)).toEqual(['a', 'b'])
    expect(activeLabel(el)).toBe('b')
    expect(layers(el)).toEqual([
      ['/v/a.excalidraw', true],
      ['/v/b.excalidraw', false],
    ])
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], file: '/v/b.excalidraw' })
    expect(document.title).toBe('b — v')
  })

  it('a pasted #hash wins as the active tab and is prepended when missing from the stored tabs (rule 12)', async () => {
    history.replaceState(null, '', '#/v/pasted.excalidraw')
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    expect(stripLabels(el)).toEqual(['pasted', 'a'])
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/pasted.excalidraw')
    expect(location.hash).toBe('#/v/pasted.excalidraw')
  })

  it('the strip shows with a folder open even with zero tabs; the editor shows the empty state', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(el.querySelector('.tabbar')).not.toBeNull()
    expect(stripLabels(el)).toEqual([])
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('')
  })

  it('the sidebar ⌘-click path (I3, GRO-2235) opens a BACKGROUND tab: appended, not activated, not mounted', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    act(() => captured.sidebar?.onOpenFileBackground('/v/b.excalidraw'))
    expect(stripLabels(el)).toEqual(['a', 'b'])
    expect(activeLabel(el)).toBe('a') // activation (and so focus) never moves
    expect(layers(el)).toEqual([['/v/a.excalidraw', false]]) // b's editor lazy-mounts on first activation
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], file: '/v/a.excalidraw' })
  })

  it('dragging a tab reorders the strip through the reducer and mirrors ONE {tabs, file} write (I3)', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    const [tabA, tabB] = [...el.querySelectorAll<HTMLElement>('.tabbar__tab')]
    // jsdom rects are all-zero: clientX 5 lands past b's midpoint — a moves to the end.
    act(() => void tabA.dispatchEvent(new MouseEvent('dragstart', { bubbles: true, cancelable: true })))
    act(() => void tabB.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 5 })))
    expect(stripLabels(el)).toEqual(['b', 'a'])
    expect(activeLabel(el)).toBe('a') // reorder never activates
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/b.excalidraw', '/v/a.excalidraw'], file: '/v/a.excalidraw' })
  })

  it('a sidebar click opens in the CURRENT tab: the active tab is replaced in place and its editor unmounts (rule 4)', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/x.excalidraw'] })
    act(() => captured.sidebar?.onOpenFile('/v/b.excalidraw'))
    expect(stripLabels(el)).toEqual(['b', 'x'])
    expect(layers(el)).toEqual([['/v/b.excalidraw', false]]) // a's editor is GONE (→ autosave flush on unmount)
    // ONE explicit identity write carries BOTH halves — never the legacy {file}-only patch.
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/b.excalidraw', '/v/x.excalidraw'], file: '/v/b.excalidraw' })
    expect(bridge.state.setFolder).toHaveBeenLastCalledWith('/v', { lastFile: '/v/b.excalidraw' })
  })

  it('opening an already-open path ACTIVATES its tab (rule 3); both visited editors stay mounted, the inactive one hidden', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    act(() => captured.sidebar?.onOpenFile('/v/b.excalidraw'))
    expect(stripLabels(el)).toEqual(['a', 'b']) // no duplicate, no reorder
    expect(layers(el)).toEqual([
      ['/v/a.excalidraw', true],
      ['/v/b.excalidraw', false],
    ])
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], file: '/v/b.excalidraw' })
    // Title and hash follow the ACTIVE tab (rule 12).
    expect(document.title).toBe('b — v')
    expect(location.hash).toBe('#/v/b.excalidraw')
  })

  it('clicking tabs switches without unmounting: both layers survive a round-trip (rule 6)', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    act(() => el.querySelectorAll<HTMLButtonElement>('.tabbar [role="tab"]')[1]?.click())
    expect(activeLabel(el)).toBe('b')
    act(() => el.querySelectorAll<HTMLButtonElement>('.tabbar [role="tab"]')[0]?.click())
    expect(activeLabel(el)).toBe('a')
    expect(layers(el)).toEqual([
      ['/v/a.excalidraw', false],
      ['/v/b.excalidraw', true],
    ])
  })

  it('✕ on the active tab activates its right neighbour, else left (rule 7)', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'] })
    act(() => el.querySelector<HTMLButtonElement>('.tabbar__tab--active .tabbar__close')?.click())
    expect(stripLabels(el)).toEqual(['a', 'c'])
    expect(activeLabel(el)).toBe('c')
    act(() => el.querySelector<HTMLButtonElement>('.tabbar__tab--active .tabbar__close')?.click())
    expect(stripLabels(el)).toEqual(['a'])
    expect(activeLabel(el)).toBe('a')
  })

  it('⌘W ladder: active tab → neighbours → empty state with the window ALIVE → closeSelf (rule 7)', async () => {
    const { bridge, el, emitCloseTab } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'] })
    act(() => emitCloseTab())
    expect(activeLabel(el)).toBe('c') // right neighbour of the closed b
    act(() => emitCloseTab())
    expect(activeLabel(el)).toBe('a') // c had nothing to its right: left neighbour
    act(() => emitCloseTab())
    expect(stripLabels(el)).toEqual([])
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('') // empty state renders
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ tabs: [], file: null })
    expect(bridge.window.closeSelf).not.toHaveBeenCalled() // the window stays alive
    act(() => emitCloseTab())
    expect(bridge.window.closeSelf).toHaveBeenCalledTimes(1) // zero tabs: the WINDOW closes
  })

  it('⌘W on the Welcome screen closes the window through the real close path', async () => {
    const { bridge, emitCloseTab } = await mount(defaultAppState(), { id: 'w1', root: null, file: null, tabs: [] })
    act(() => emitCloseTab())
    expect(bridge.window.closeSelf).toHaveBeenCalledTimes(1)
  })

  it('Next/Previous Tab cycle with wraparound (rule 9)', async () => {
    const { el, emitNextTab, emitPrevTab } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/c.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'] })
    act(() => emitNextTab())
    expect(activeLabel(el)).toBe('a') // wrapped past the end
    act(() => emitPrevTab())
    expect(activeLabel(el)).toBe('c') // and back
  })

  it('a deep link activates an already-open file\'s tab; a new file opens in the CURRENT tab (rule 10)', async () => {
    const { el, emitLinkOpenFile } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    act(() => emitLinkOpenFile('/v/b.excalidraw'))
    expect(stripLabels(el)).toEqual(['a', 'b'])
    expect(activeLabel(el)).toBe('b')
    act(() => emitLinkOpenFile('/v/c.excalidraw'))
    expect(stripLabels(el)).toEqual(['a', 'c']) // replaced the active b, like a sidebar click
    expect(activeLabel(el)).toBe('c')
  })

  it('the active file vanishing on disk closes its tab; the neighbour takes over', async () => {
    const { el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    act(() => captured.sidebar?.onFileMissing())
    expect(stripLabels(el)).toEqual(['b'])
    expect(activeLabel(el)).toBe('b')
  })
})

/**
 * The ONE rename door: every gesture — the sidebar's inline rename, its drag-move — arrives at
 * App as (oldPath, newPath) and is committed straight away. The confirm sheet that used to sit
 * in front of a NAME change was deleted (🔒 YAZ-1775): with wikilinks gone it warned about
 * nothing, and every new `Untitled` board would have tripped it. Delete keeps its confirm.
 */
describe('App rename door', () => {
  const identity = (): IdentityFixture => ({ id: 'w1', root: '/v', file: null, tabs: [] })

  it('a NAME change renames straight away — no sheet in between', async () => {
    const { bridge, el } = await mount(defaultAppState(), identity())
    await act(async () => void (await captured.sidebar?.onRenameFile('/v/B.excalidraw', '/v/B2.excalidraw', 'file')))
    expect(el.querySelector('.confirm')).toBeNull()
    expect(bridge.file.rename).toHaveBeenCalledWith({ oldPath: '/v/B.excalidraw', newPath: '/v/B2.excalidraw' })
  })

  it('a MOVE renames straight away too', async () => {
    const { bridge, el } = await mount(defaultAppState(), identity())
    await act(async () => await captured.sidebar?.onRenameFile('/v/B.excalidraw', '/v/Docs/B.excalidraw', 'file'))
    expect(el.querySelector('.confirm')).toBeNull()
    expect(bridge.file.rename).toHaveBeenCalledWith({ oldPath: '/v/B.excalidraw', newPath: '/v/Docs/B.excalidraw' })
  })

  it('a FOLDER rename goes through the same door', async () => {
    const { bridge, el } = await mount(defaultAppState(), identity())
    await act(async () => void (await captured.sidebar?.onRenameFile('/v/Docs', '/v/Notes', 'dir')))
    expect(el.querySelector('.confirm')).toBeNull()
    expect(bridge.file.rename).toHaveBeenCalledWith({ oldPath: '/v/Docs', newPath: '/v/Notes' })
  })

  it('a rename that fails lands in the passive notice, never a dialog', async () => {
    const { bridge, el } = await mount(defaultAppState(), identity())
    bridge.file.rename.mockRejectedValueOnce({ code: 'ALREADY_EXISTS', message: 'a file with this name already exists', path: '/v/B2.excalidraw' })
    await act(async () => void (await captured.sidebar?.onRenameFile('/v/B.excalidraw', '/v/B2.excalidraw', 'file')))
    expect(el.querySelector('.confirm')).toBeNull()
    expect(el.querySelector('.link-notice')?.textContent).toBe('Can\'t rename: "B2.excalidraw" already exists')
  })
})

describe('App root-missing (C2, GRO-2164)', () => {
  it('the open folder vanishing on disk drops the window to the Welcome screen', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    expect(el.querySelector('[data-sidebar]')?.getAttribute('data-root')).toBe('/v')
    expect(el.querySelector('.welcome')).toBeNull()
    act(() => captured.sidebar?.onRootMissing())
    expect(el.querySelector('.welcome__title')?.textContent).toBe('Yaseen Draw')
    expect(el.querySelector('[data-sidebar]')).toBeNull()
    expect(el.querySelector('[data-editor]')).toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ root: null, file: null, tabs: [], sidebarLens: 'files', focusDirs: [], focusFavorites: [] })
  })
})

/**
 * Delete wiring (GRO-2272 `B3-`). The ordering test is the point of this block: retire the
 * editor BEFORE the workspace remap, because removing a page unmounts its editor and the unmount
 * flush would write the buffer back to disk, recreating the file that was just trashed.
 */
describe('in-app delete (GRO-2272)', () => {
  it('retires the editor BEFORE remapping the workspace — asserted by call order, not by reading the code', async () => {
    const order: string[] = []
    const retireSpy = vi.spyOn(continuity, 'retirePath').mockImplementation(() => void order.push('retire'))
    const b = installBridge(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    await storage.init()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root?.render(<App />))
    // setIdentity is the workspace mirror: its first call AFTER the event is the remap.
    b.bridge.window.setIdentity.mockImplementation(async () => void order.push('workspace'))
    await act(async () => b.emitFileDeleted('/v/a.excalidraw'))
    expect(order[0]).toBe('retire')
    expect(order).toEqual(['retire', 'workspace'])
    retireSpy.mockRestore()
  })

  it('a file event closes that tab and activates the heir', async () => {
    const b = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    await act(async () => b.emitFileDeleted('/v/a.excalidraw'))
    expect(document.title).toContain('b')
  })

  it('a dir event retires and closes every tab under the folder', async () => {
    const retireDir = vi.spyOn(continuity, 'retireDir')
    const b = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/Docs/a.excalidraw', tabs: ['/v/Docs/a.excalidraw', '/v/x.excalidraw'] })
    await act(async () => b.emitFileDeleted('/v/Docs', 'dir'))
    expect(retireDir).toHaveBeenCalledWith('/v/Docs')
    expect(document.title).toContain('x')
    retireDir.mockRestore()
  })

  it('a delete for a path this window does not have open changes nothing', async () => {
    const b = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    const before = document.title
    await act(async () => b.emitFileDeleted('/v/somewhere-else.excalidraw'))
    expect(document.title).toBe(before)
  })
})

describe('App › Open folder… never swaps a vault window (YAZ-1913 🔒 D2)', () => {
  it('a vault window hands the picked folder to main\'s open-recent door and keeps its own vault and tabs (S1, S2)', async () => {
    const { bridge, el, emitOpenFolder } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'] })
    bridge.pickFolder.mockResolvedValueOnce({ path: '/w' })
    await act(async () => emitOpenFolder())
    expect(bridge.window.openRecent).toHaveBeenCalledExactlyOnceWith('/w')
    expect(bridge.tree).not.toHaveBeenCalledWith('/w')
    expect(bridge.window.setIdentity).not.toHaveBeenCalledWith(expect.objectContaining({ root: '/w' }))
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/a.excalidraw')
    expect(document.title).toBe('a — v')
  })

  it('picking this window\'s own vault goes to the door too (it just raises) — the tabs are not reset (S4)', async () => {
    const { bridge, el, emitOpenFolder } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'] })
    bridge.pickFolder.mockResolvedValueOnce({ path: '/v' })
    await act(async () => emitOpenFolder())
    expect(bridge.window.openRecent).toHaveBeenCalledExactlyOnceWith('/v')
    expect(el.querySelectorAll('.tabbar [role="tab"]').length).toBe(2)
    expect(el.querySelector('[data-editor]')?.getAttribute('data-path')).toBe('/v/b.excalidraw')
  })

  it('a cancelled dialog does nothing (S5)', async () => {
    const { bridge, emitOpenFolder } = await mount(defaultAppState(), { id: 'w1', root: '/v', file: null, tabs: [] })
    await act(async () => emitOpenFolder())
    expect(bridge.pickFolder).toHaveBeenCalledOnce()
    expect(bridge.window.openRecent).not.toHaveBeenCalled()
  })

  it('the Welcome window\'s Open folder… button fills it in place, never through the door (S6)', async () => {
    const { bridge, el } = await mount(defaultAppState(), { id: 'w1', root: null, file: null, tabs: [] })
    bridge.pickFolder.mockResolvedValueOnce({ path: '/vaults/w' })
    await act(async () => el.querySelector<HTMLButtonElement>('.welcome .btn--primary')?.click())
    expect(document.title).toBe('w')
    expect(bridge.window.setIdentity).toHaveBeenCalledWith(expect.objectContaining({ root: '/vaults/w' }))
    expect(bridge.window.openRecent).not.toHaveBeenCalled()
  })

  it('⌘⇧O on the Welcome window also fills it in place (S7)', async () => {
    const { bridge, emitOpenFolder } = await mount(defaultAppState(), { id: 'w1', root: null, file: null, tabs: [] })
    bridge.pickFolder.mockResolvedValueOnce({ path: '/vaults/w' })
    await act(async () => emitOpenFolder())
    expect(document.title).toBe('w')
    expect(bridge.window.openRecent).not.toHaveBeenCalled()
  })
})
