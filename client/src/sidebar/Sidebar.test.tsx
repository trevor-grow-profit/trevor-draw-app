/**
 * Sidebar file-row gestures: ⌘-click opens a BACKGROUND TAB in this window (I3 LOCKED ruling,
 * GRO-2235); the row's context-menu "Open in new window" still opens a new window on
 * {root, file} over the bridge (D2, GRO-2168) — either way the current window's active file
 * is untouched (onOpenFile never fires). Plain click and folder/blank-space context menus are
 * unchanged, and activating a stale tab probes a fresh tree before onFileMissing fires.
 * Real Tree/ContextMenu render against the jsdom bridge stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, defaultAppState, type AppState, type FileClipRequest, type FileClipState, type PasteResponse, type TreeNode, type WatchEvent, type WindowIdentity } from '@shared/types'
import { EMPTY_DIAGRAM_XML } from '@shared/diagramFile'
import { EMPTY_SCENE_JSON } from '../drawings/drawingScene'
// Focus Mode's persistence is the REAL storage module (no mock in this file): a spy on its read is
// how a test hands the Sidebar a focus restored from an earlier session (YAZ-1605).
import { storage } from '../lib/storage'
import { BridgeRequestError } from '../api'
import { BOARD_PREVIEW_DWELL_MS } from './HoverPreviewHost'
import { WATCH_REFRESH_MS } from './hooks/useVaultTree'
import { Sidebar, type SidebarClipboard } from './Sidebar'
import { datedSeed } from './createEntry'

// The hover preview's picture (YAZ-1800) is drawn by the engine, which jsdom cannot run: the cache is
// stubbed to answer a dataURL, the key is the real one.
const previewLoad = vi.hoisted(() => vi.fn(async (_key: string): Promise<string | null> => 'data:image/png;base64,AA'))
vi.mock('./boardPreviewCache', async (importActual) => ({
  ...(await importActual<typeof import('./boardPreviewCache')>()),
  boardPreviews: { load: previewLoad, clear: () => undefined, Preview: () => null },
}))


const TREE: TreeNode[] = [
  { type: 'dir', name: 'sub', path: '/v/sub', children: [] },
  { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
]

/** Just the bridge surface the Sidebar tree touches (the jsdom stub pattern, App.test.tsx). */
function installBridge() {
  const bridge = {
    tree: vi.fn(async (root: string) => ({ root, tree: TREE, generatedAt: 1 })),
    // The inline-create flow (GRO-2022): "New drawing" hands `createFile` the path AND the empty-scene bytes (🔒 YAZ-1810).
    createFile: vi.fn(async (req: string | { path: string; content?: string }) => ({ path: typeof req === 'string' ? req : req.path, mtime: 2, size: 0 })),
    createDir: vi.fn(async (path: string) => ({ path })),
    state: { get: vi.fn(async () => defaultAppState()), setFolder: vi.fn(async () => undefined), onChange: vi.fn((_listener: (state: AppState) => void) => () => undefined) },
    window: {
      open: vi.fn(async () => undefined),
      // Focus Mode is window identity (YAZ-1628): `storage.init()` boots from `identity`, writes go to `setIdentity`.
      identity: vi.fn(async (): Promise<WindowIdentity> => ({ id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [] })),
      setIdentity: vi.fn(async () => undefined),
    },
    // The file clipboard (YAZ-1674, 🔒 D1) lives in main behind `file.*`: two invokes and the
    // `clip:changed` push every window gets. `onClipChanged` hands back an unsubscribe; a test that
    // wants to PUSH a state captures the listener through `mockImplementation`.
    file: {
      clip: vi.fn(async (_req: FileClipRequest) => undefined),
      paste: vi.fn(async (_req: { targetDir: string }): Promise<PasteResponse> => ({ pasted: [], failed: [] })),
      // Read ONCE on mount, so a window opened after a clip labels Paste from the start.
      clipState: vi.fn(async (): Promise<FileClipState> => null),
      onClipChanged: vi.fn((_listener: (state: FileClipState) => void) => () => undefined),
    },
    // The Favorites list (YAZ-1766 6A): `.yaseendraw/favorites.json` behind main; absolute paths both ways.
    // Empty by default; the favorites block seeds `get` and captures the `onChanged` listener.
    favorites: {
      get: vi.fn(async (_root: string): Promise<string[]> => []),
      set: vi.fn(async (_root: string, _paths: readonly string[]) => undefined),
      onChanged: vi.fn((_listener: (change: { root: string }) => void) => () => undefined),
    },
    // Reveal in Finder (GRO-2274) goes through the shell namespace.
    shell: {
      reveal: vi.fn(async ({ path }: { path: string }) => ({ path })),
      // Open in default app (YAZ-1577): the row with no viewer's click, and its menu item.
      openDefault: vi.fn(async ({ path }: { path: string }) => ({ path })),
    },
    // The shared-board marks (YAZ-1890) read this vault's shares; none here.
    share: {
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => undefined),
    },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return bridge
}

let root: Root | null = null
let container: HTMLElement | null = null

type SidebarProps = Parameters<typeof Sidebar>[0]

async function mount(over: Partial<SidebarProps> = {}, tweakBridge?: (bridge: ReturnType<typeof installBridge>) => unknown) {
  const bridge = installBridge()
  await tweakBridge?.(bridge) // before the first render: the loading/error tree states only exist there
  const el = document.createElement('div')
  document.body.appendChild(el)
  container = el
  root = createRoot(el)
  const props: SidebarProps = {
    root: '/v',
    activeFile: null,
    watch: { subscribe: () => () => undefined },
    onOpenFile: vi.fn(),
    onOpenFileBackground: vi.fn(),
    // A folder search row (🔒 D3, YAZ-1491): App flips to Files and issues the reveal request.
    onRevealInFiles: vi.fn(),
    onPickFolder: vi.fn(),
    pickDisabled: false,
    // The header's vault switcher (YAZ-1767): 0 = no ⌘O pending; the panel itself is VaultSwitcher.test's subject.
    switcherOpenRequest: 0,
    onOpenVaultHere: vi.fn(async () => true),
    onCollapse: vi.fn(),
    // Every test below this line is about the FILE TREE, so the harness mounts the FILES lens
    // (YAZ-847) — which is also the app's own default. App owns and persists the value, and the
    // "lens tabs" describe mounts each lens explicitly.
    lens: 'files',
    onLensChange: vi.fn(),
    revealRequest: null,
    onRevealConsumed: vi.fn(),
    settings: { ...DEFAULT_SETTINGS },
    onChangeSettings: vi.fn(),
    onOpenSettings: vi.fn(),
    onRootMissing: vi.fn(),
    onFileMissing: vi.fn(),
    onRenameFile: vi.fn(async () => undefined),
    onDeleteFile: vi.fn(async () => undefined),
    onShareFile: vi.fn(),
    onHistoryFile: vi.fn(),
    onNotice: vi.fn(),
    pendingSearchFocus: false,
    onSearchFocusHandled: vi.fn(),
    // ⌘C / ⌘X / ⌘V's handle (D6 amended, YAZ-1674): App's listener asks it; the chord tests hold their own box.
    clipboardRef: { current: null },
    ...over,
  }
  await act(async () => root?.render(<StrictMode><Sidebar {...props} /></StrictMode>))
  /** Re-render the SAME Sidebar instance with changed props (the App-driven activation path). */
  const rerender = async (next: Partial<SidebarProps>) =>
    act(async () => root?.render(<StrictMode><Sidebar {...props} {...next} /></StrictMode>))
  return { bridge, props, el, rerender }
}

/** The timers a watcher refresh waits on, faked once the mount has settled, so `quiet` never sleeps real time. */
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
/** A watcher change refreshes the tree once `WATCH_REFRESH_MS` of quiet has passed (YAZ-2073 5E); this skips past it. */
const quiet = () => act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_REFRESH_MS)))
const fileRow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.tree__row--file')
const searchInput = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[aria-label="Search boards"]')
/**
 * Drive the CONTROLLED search input like a user: native value setter + input event (SettingsDialog
 * idiom). Async so the re-render it triggers has settled before the assertions read the body.
 */
const type = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const menuItems = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.ctx-menu__item')]
const itemByLabel = (el: HTMLElement, label: string) => menuItems(el).find((b) => b.textContent === label)
/**
 * The "Open in ▸" flyout (D7 amended, YAZ-1674): open it (a click on the parent — hover works too)
 * and read its children. `subItemByLabel` is undefined when the parent is absent OR the child is
 * not offered, which is exactly the two "no such item" answers the gating tests below ask for.
 */
const openFlyout = (el: HTMLElement) => {
  const parent = itemByLabel(el, 'Open in')
  if (parent !== undefined) act(() => parent.click())
  return [...el.querySelectorAll<HTMLButtonElement>('.ctx-menu__sub .ctx-menu__item')]
}
const subLabels = (el: HTMLElement) => openFlyout(el).map((b) => b.textContent)
const subItemByLabel = (el: HTMLElement, label: string) => openFlyout(el).find((b) => b.textContent === label)
/** Open the flyout OUTSIDE the click's own `act`: a nested `act` does not flush, so the child must exist before that act begins. */
const clickSub = (el: HTMLElement, label: string) => {
  const child = subItemByLabel(el, label)
  act(() => child?.click())
}
const clickSubAsync = async (el: HTMLElement, label: string) => {
  const child = subItemByLabel(el, label)
  await act(async () => child?.click())
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/**
 * A row with no in-app viewer (`kind: null`, YAZ-1577 D2): the OS default app IS the viewer, so
 * every open gesture hands the path to `shell.openDefault` and no tab callback fires. Shift is
 * still the selection gesture and still wins (YAZ-1336 🔒 D2).
 */
describe('rows with no viewer open in the OS default app (YAZ-1577 D2)', () => {
  const NO_VIEWER_TREE: TreeNode[] = [
    { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    { type: 'file', name: 'book.epub', path: '/v/book.epub', size: 1, mtime: 1, kind: null },
  ]
  const withNoViewerTree = (bridge: ReturnType<typeof installBridge>) =>
    bridge.tree.mockResolvedValue({ root: '/v', tree: NO_VIEWER_TREE, generatedAt: 1 })
  const epubRow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.tree__row--file[title="/v/book.epub"]')

  it('is marked external and keeps its full filename; a viewer-able row is not marked', async () => {
    const { el } = await mount({}, withNoViewerTree)
    expect(epubRow(el)?.classList.contains('tree__row--external')).toBe(true)
    expect(epubRow(el)?.textContent).toBe('book.epub')
    expect(fileRow(el)?.classList.contains('tree__row--external')).toBe(false)
  })

  it('a plain click hands the path to the OS and opens no tab', async () => {
    const { bridge, props, el } = await mount({}, withNoViewerTree)
    await act(async () => epubRow(el)?.click())
    expect(bridge.shell.openDefault).toHaveBeenCalledExactlyOnceWith({ path: '/v/book.epub' })
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(props.onOpenFileBackground).not.toHaveBeenCalled()
  })

  it('⌘-click does the same — there is no tab to background', async () => {
    const { bridge, props, el } = await mount({}, withNoViewerTree)
    await act(async () => void epubRow(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
    expect(bridge.shell.openDefault).toHaveBeenCalledExactlyOnceWith({ path: '/v/book.epub' })
    expect(props.onOpenFileBackground).not.toHaveBeenCalled()
  })

  it('shift-click selects the row and opens nothing anywhere', async () => {
    const { bridge, props, el } = await mount({}, withNoViewerTree)
    await act(async () => void epubRow(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    expect(epubRow(el)?.classList.contains('tree__row--selected')).toBe(true)
    expect(bridge.shell.openDefault).not.toHaveBeenCalled()
    expect(props.onOpenFile).not.toHaveBeenCalled()
  })

  it('a stale row (deleted outside the app) surfaces a passive notice', async () => {
    const { props, el } = await mount({}, (bridge) => {
      withNoViewerTree(bridge)
      bridge.shell.openDefault.mockRejectedValue({ code: 'NOT_FOUND', message: 'path does not exist' })
    })
    await act(async () => epubRow(el)?.click())
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Can\'t open "book.epub" — it is no longer there', 'error')
  })

  it('every file row\'s "Open in ▸" flyout offers "Default app" directly beside "VS Code" (D7 amended)', async () => {
    const { bridge, el } = await mount()
    act(() => void fileRow(el)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    const labels = subLabels(el)
    expect(labels.indexOf('Default app')).toBe(labels.indexOf('VS Code') + 1)
    await clickSubAsync(el, 'Default app')
    expect(bridge.shell.openDefault).toHaveBeenCalledExactlyOnceWith({ path: '/v/a.excalidraw' })
  })
})

describe('Sidebar file-row open gestures (D2 GRO-2168, I3 GRO-2235)', () => {
  it('a plain click on a file row opens it in place (onOpenFile), never over the bridge', async () => {
    const { bridge, props, el } = await mount()
    act(() => fileRow(el)?.click())
    expect(props.onOpenFile).toHaveBeenCalledWith('/v/a.excalidraw')
    expect(bridge.window.open).not.toHaveBeenCalled()
  })

  it('⌘-click on a file row opens a BACKGROUND TAB in this window (the LOCKED I3 ruling), never a new window', async () => {
    const { bridge, props, el } = await mount()
    act(() => void fileRow(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
    expect(props.onOpenFileBackground).toHaveBeenCalledTimes(1)
    expect(props.onOpenFileBackground).toHaveBeenCalledWith('/v/a.excalidraw')
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(bridge.window.open).not.toHaveBeenCalled()
  })

  it('the file row context menu offers "Open in ▸ New window" above "Copy path"; it routes to the bridge and closes', async () => {
    const { bridge, props, el } = await mount()
    act(() => void fileRow(el)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    const labels = menuItems(el).map((b) => b.textContent)
    expect(labels).toContain('Open in')
    expect(labels).toContain('Copy path')
    expect(subLabels(el)).toContain('New window')
    clickSub(el, 'New window')
    expect(bridge.window.open).toHaveBeenCalledTimes(1)
    expect(bridge.window.open).toHaveBeenCalledWith({ root: '/v', file: '/v/a.excalidraw' })
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })

  /**
   * Board birth is NAME-FIRST (🔒 YAZ-1999 D1, D5 — reverses YAZ-1775 R1): every "New…" board item opens
   * the inline name box in the target folder, and nothing touches the disk until Enter. Scenario
   * numbers are the S1–S18 contract pinned on YAZ-1999.
   */
  describe('name-first board birth (YAZ-1999)', () => {
    /** Right-click `target` (blank space by default) and take `label`. */
    const pickNew = async (el: HTMLElement, label: string, target = '.sidebar__body') => {
      act(() => void el.querySelector(target)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
      await act(async () => itemByLabel(el, label)?.click())
    }
    const box = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.create-inline__input')
    const key = async (el: HTMLElement, k: string, value?: string) => {
      const input = box(el)!
      if (value !== undefined) input.value = value
      await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    }

    it('opens an empty, focused box named for the board and writes NOTHING until Enter (S1, S5, S11)', async () => {
      const { el, bridge } = await mount()
      await pickNew(el, 'New Excalidraw drawing')
      expect(box(el)?.placeholder).toBe('New Excalidraw drawing')
      expect(box(el)?.value).toBe('')
      expect(document.activeElement).toBe(box(el))
      await key(el, 'Enter')
      expect(box(el)).not.toBeNull()
      expect(bridge.createFile).not.toHaveBeenCalled()
    })

    it('Enter writes the typed name with an EMPTY SCENE (🔒 YAZ-1810) and opens it in the current tab (S1)', async () => {
      const { el, props, bridge } = await mount()
      await pickNew(el, 'New Excalidraw drawing')
      await key(el, 'Enter', 'Roadmap')
      expect(bridge.createFile).toHaveBeenCalledExactlyOnceWith({ path: '/v/Roadmap.excalidraw', content: EMPTY_SCENE_JSON })
      expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/Roadmap.excalidraw')
      expect(props.onOpenFileBackground).not.toHaveBeenCalled()
      expect(box(el)).toBeNull()
    })

    it('creates inside the right-clicked FOLDER, not the vault root (S1)', async () => {
      const { el, bridge } = await mount()
      await pickNew(el, 'New Excalidraw drawing', '.tree__row--dir')
      await key(el, 'Enter', 'Plan')
      expect(bridge.createFile).toHaveBeenCalledExactlyOnceWith({ path: '/v/sub/Plan.excalidraw', content: EMPTY_SCENE_JSON })
    })

    it('"New draw.io diagram" is the same box, and Enter writes an EMPTY DIAGRAM (S4, 🔒 D5)', async () => {
      const { el, props, bridge } = await mount()
      await pickNew(el, 'New draw.io diagram')
      expect(box(el)?.placeholder).toBe('New draw.io diagram')
      await key(el, 'Enter', 'Flow')
      expect(bridge.createFile).toHaveBeenCalledExactlyOnceWith({ path: '/v/Flow.drawio', content: EMPTY_DIAGRAM_XML })
      expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/Flow.drawio')
    })

    it('"New dated Excalidraw drawing" seeds today\'s MM_DD- ; Enter on the untouched seed does nothing, a title creates the dated board (S13, S14)', async () => {
      const { el, props, bridge } = await mount()
      await pickNew(el, 'New dated Excalidraw drawing')
      expect(box(el)?.value).toBe(datedSeed())
      await key(el, 'Enter')
      expect(bridge.createFile).not.toHaveBeenCalled()
      await key(el, 'Enter', `${datedSeed()}Plan`)
      expect(bridge.createFile).toHaveBeenCalledExactlyOnceWith({ path: `/v/${datedSeed()}Plan.excalidraw`, content: EMPTY_SCENE_JSON })
      expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith(`/v/${datedSeed()}Plan.excalidraw`)
    })

    it('Escape writes nothing (S6)', async () => {
      const { el, bridge } = await mount()
      await pickNew(el, 'New Excalidraw drawing')
      await key(el, 'Escape', 'Roadmap')
      expect(box(el)).toBeNull()
      expect(bridge.createFile).not.toHaveBeenCalled()
    })

    it('a name that is taken keeps the box open with the error and the typed text, and opens nothing (S8)', async () => {
      const { el, props, bridge } = await mount()
      bridge.createFile.mockRejectedValueOnce(new BridgeRequestError('ALREADY_EXISTS', 'path already exists'))
      await pickNew(el, 'New Excalidraw drawing')
      await key(el, 'Enter', 'a')
      expect(box(el)?.value).toBe('a')
      expect(el.querySelector('.create-inline__error')?.textContent).toBe('path already exists')
      expect(props.onOpenFile).not.toHaveBeenCalled()
    })
  })

  it('folder rows and blank space get no "Open in new window" item', async () => {
    const { el } = await mount()
    act(() => void el.querySelector('.tree__row--dir')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(subItemByLabel(el, 'New window')).toBeUndefined()
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
    act(() => void el.querySelector('.ctx-overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(subItemByLabel(el, 'New window')).toBeUndefined()
    expect(itemByLabel(el, 'New Excalidraw drawing')).toBeDefined()
  })
})

describe('Sidebar folder rename + file drag-move (E1b, GRO-2241)', () => {
  /** Drag events bubble like the real thing; jsdom has no DragEvent, the handlers guard `dataTransfer` (the TabBar idiom). */
  const fire = (target: Element | null | undefined, type: string) =>
    act(() => void target?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })))
  const dirRow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.tree__row--dir')

  it.each([
    ['data.json', 'profile', '/v/profile.json'],
    ['report.PDF', 'brief', '/v/brief.PDF'],
  ] as const)('shows the full UNSUPPORTED filename for %s and renames it deterministically', async (name, nextName, target) => {
    const node: TreeNode = { type: 'file', name, path: `/v/${name}`, size: 1, mtime: 1, kind: null }
    const { props, el } = await mount({}, (bridge) =>
      bridge.tree.mockResolvedValue({ root: '/v', tree: [node], generatedAt: 1 }),
    )
    const row = el.querySelector<HTMLButtonElement>(`.tree__row--file[title="/v/${name}"]`)
    act(() => void row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    act(() => itemByLabel(el, 'Rename')?.click())
    const input = el.querySelector<HTMLInputElement>('.create-inline__input')
    expect(input?.value).toBe(name)
    act(() => {
      input!.value = nextName
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => undefined)
    expect(props.onRenameFile).toHaveBeenCalledExactlyOnceWith(`/v/${name}`, target, 'file')
  })

  it('submitting an unchanged full unsupported filename is a no-op', async () => {
    const node: TreeNode = { type: 'file', name: 'data.json', path: '/v/data.json', size: 1, mtime: 1, kind: null }
    const { props, el } = await mount({}, (bridge) =>
      bridge.tree.mockResolvedValue({ root: '/v', tree: [node], generatedAt: 1 }),
    )
    act(() => void el.querySelector('.tree__row--file')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    act(() => itemByLabel(el, 'Rename')?.click())
    const input = el.querySelector<HTMLInputElement>('.create-inline__input')
    expect(input?.value).toBe('data.json')
    act(() => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => undefined)
    expect(props.onRenameFile).not.toHaveBeenCalled()
  })

  it('submitting an unchanged compound unsupported filename is a no-op', async () => {
    const node: TreeNode = { type: 'file', name: 'schema.graphql.ts', path: '/v/schema.graphql.ts', size: 1, mtime: 1, kind: null }
    const { props, el } = await mount({}, (bridge) =>
      bridge.tree.mockResolvedValue({ root: '/v', tree: [node], generatedAt: 1 }),
    )
    act(() => void el.querySelector('.tree__row--file')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    act(() => itemByLabel(el, 'Rename')?.click())
    const input = el.querySelector<HTMLInputElement>('.create-inline__input')
    expect(input?.value).toBe('schema.graphql.ts')
    act(() => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => undefined)
    expect(props.onRenameFile).not.toHaveBeenCalled()
  })

  it('a FOLDER row\'s context menu offers "Rename"; committing routes old→new (no extension logic) through onRenameFile', async () => {
    const { props, el } = await mount()
    act(() => void dirRow(el)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    act(() => itemByLabel(el, 'Rename')?.click())
    const input = el.querySelector<HTMLInputElement>('.create-inline__input')
    expect(input?.value).toBe('sub') // the raw folder name — no extension stripping for dirs
    act(() => {
      input!.value = 'archive'
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => undefined)
    expect(props.onRenameFile).toHaveBeenCalledWith('/v/sub', '/v/archive', 'dir')
  })

  it('dragging a file row onto a folder row moves it there (onRenameFile old→new parent); the target highlights while hovered', async () => {
    const { props, el } = await mount()
    fire(fileRow(el), 'dragstart')
    fire(dirRow(el), 'dragover')
    expect(dirRow(el)?.classList.contains('tree__row--drop')).toBe(true)
    fire(dirRow(el), 'drop')
    expect(props.onRenameFile).toHaveBeenCalledWith('/v/a.excalidraw', '/v/sub/a.excalidraw', 'file')
    expect(el.querySelector('.tree__row--drop')).toBeNull() // drag state cleared
  })

  it('dropping on the ROOT HEADER targets the vault root — a no-op for a file already there; dragend abandons cleanly', async () => {
    const { props, el } = await mount()
    const header = el.querySelector<HTMLElement>('.sidebar__header')
    fire(fileRow(el), 'dragstart')
    fire(header, 'dragover')
    expect(header?.classList.contains('sidebar__header--drop')).toBe(true)
    fire(header, 'drop')
    expect(props.onRenameFile).not.toHaveBeenCalled() // `/v/a.excalidraw` already lives at the root
    fire(fileRow(el), 'dragstart')
    fire(fileRow(el), 'dragend')
    fire(dirRow(el), 'drop')
    expect(props.onRenameFile).not.toHaveBeenCalled() // an abandoned drag drops nothing
  })
})

describe('Sidebar stale tab activation (I3, GRO-2235)', () => {
  it('activating a file the tree does not show probes a FRESH tree and fires onFileMissing when it is really gone', async () => {
    const { bridge, props, rerender } = await mount({ activeFile: '/v/a.excalidraw' })
    bridge.tree.mockClear()
    await rerender({ activeFile: '/v/gone.excalidraw' })
    expect(bridge.tree).toHaveBeenCalledWith('/v') // the confirmation probe
    expect(props.onFileMissing).toHaveBeenCalledTimes(1)
  })

  it('a just-created file missing from the CACHED tree but present in the fresh one stays open (the inline-create race)', async () => {
    const { bridge, props, rerender } = await mount({ activeFile: '/v/a.excalidraw' })
    const created: TreeNode = { type: 'file', name: 'new.excalidraw', path: '/v/new.excalidraw', size: 1, mtime: 2, kind: 'drawing' }
    bridge.tree.mockImplementation(async (r: string) => ({ root: r, tree: [...TREE, created], generatedAt: 2 }))
    await rerender({ activeFile: '/v/new.excalidraw' })
    expect(props.onFileMissing).not.toHaveBeenCalled()
  })

  it('activating a file the cached tree shows probes nothing; out-of-root activations are skipped', async () => {
    const { bridge, props, rerender } = await mount({ activeFile: null })
    bridge.tree.mockClear()
    await rerender({ activeFile: '/v/a.excalidraw' }) // in the cached tree: no probe
    await rerender({ activeFile: '/elsewhere/pasted.excalidraw' }) // outside the root: never in the tree, never probed
    expect(bridge.tree).not.toHaveBeenCalled()
    expect(props.onFileMissing).not.toHaveBeenCalled()
  })

  it('a file deleted WHILE active stays open: a tree refresh without an activation change never re-validates', async () => {
    // Boot on a: the first tree validates it. Then a is deleted on disk mid-edit — the
    // watcher-driven refresh delivers a tree WITHOUT it, but the boot validation is spent and
    // no activation changed, so nothing fires (the file is recreated by the next save).
    let emit: ((ev: WatchEvent) => void) | undefined
    const watch = {
      subscribe: (l: (ev: WatchEvent) => void) => {
        emit = l
        return () => undefined
      },
    }
    const { bridge, props } = await mount({ activeFile: '/v/a.excalidraw', watch })
    fakeClock()
    bridge.tree.mockImplementation(async (r: string) => ({ root: r, tree: TREE.filter((n) => n.path !== '/v/a.excalidraw'), generatedAt: 3 }))
    await act(async () => emit?.({ type: 'unlink', path: '/v/a.excalidraw' }))
    await quiet()
    expect(props.onFileMissing).not.toHaveBeenCalled()
  })
})

describe('Show in sidebar — Files reveal (YAZ-1063)', () => {
  const TARGET = '/v/target/deep/Note.excalidraw'
  const DEEP_TREE: TreeNode[] = [
    {
      type: 'dir', name: 'other', path: '/v/other',
      children: [{ type: 'file', name: 'Keep.excalidraw', path: '/v/other/Keep.excalidraw', size: 1, mtime: 1, kind: 'drawing' }],
    },
    {
      type: 'dir', name: 'target', path: '/v/target',
      children: [{
        type: 'dir', name: 'deep', path: '/v/target/deep',
        children: [{ type: 'file', name: 'Note.excalidraw', path: TARGET, size: 1, mtime: 1, kind: 'drawing' }],
      }],
    },
  ]
  const withDeepTree = (bridge: ReturnType<typeof installBridge>) =>
    bridge.tree.mockResolvedValue({ root: '/v', tree: DEEP_TREE, generatedAt: 1 })
  const dirRow = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.tree__row--dir')].find((row) => row.querySelector('.tree__label')?.textContent === label)

  it('waits for the initial tree snapshot, then opens only the missing ancestor chain and exposes an exact-path row', async () => {
    const { el, props } = await mount({ revealRequest: { id: 1, path: TARGET, lens: 'files' } }, withDeepTree)
    expect(props.onRevealConsumed).toHaveBeenCalledExactlyOnceWith(1)
    expect(dirRow(el, 'target')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(dirRow(el, 'deep')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(dirRow(el, 'other')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector(`[data-path="${TARGET}"]`)?.classList.contains('tree__row--revealed')).toBe(true)
  })

  it('preserves unrelated expansion when a later request opens the target chain', async () => {
    const { el, rerender } = await mount({}, withDeepTree)
    act(() => dirRow(el, 'other')?.click())
    expect(dirRow(el, 'other')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    await rerender({ revealRequest: { id: 1, path: TARGET, lens: 'files' } })
    expect(dirRow(el, 'other')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(dirRow(el, 'target')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(dirRow(el, 'deep')?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('reports one passive notice when the loaded Files tree cannot show the path', async () => {
    const { props } = await mount({ revealRequest: { id: 1, path: '/v/Missing.excalidraw', lens: 'files' } }, withDeepTree)
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Can\'t show "Missing.excalidraw" in Files — it is no longer there', 'error')
  })
})

/**
 * A launch shows the restored tab but does not open its folders (YAZ-1642, D2). Only the file the
 * Sidebar MOUNTS with is exempt; every later `activeFile` reveals exactly as before. Fresh vault per
 * mount (the expand-all idiom below): the app-state cache is module-level.
 */
describe('launch: the restored tab is shown, not revealed (YAZ-1642)', () => {
  const drawing = (path: string): TreeNode => ({ type: 'file', name: path.split('/').pop()!, path, size: 1, mtime: 1, kind: 'drawing' })
  const DEEP = (v: string): TreeNode[] => [
    { type: 'dir', name: 'other', path: `${v}/other`, children: [drawing(`${v}/other/Keep.excalidraw`)] },
    { type: 'dir', name: 'target', path: `${v}/target`, children: [{ type: 'dir', name: 'deep', path: `${v}/target/deep`, children: [drawing(`${v}/target/deep/Note.excalidraw`)] }] },
  ]
  let vaults = 0
  const mountVault = async (activeFile: (v: string) => string) => {
    const v = `/v-launch-${++vaults}`
    const m = await mount({ root: v, activeFile: activeFile(v) }, (b) => b.tree.mockResolvedValue({ root: v, tree: DEEP(v), generatedAt: 1 } as never))
    return { ...m, v }
  }
  const isOpen = (el: HTMLElement, path: string) => el.querySelector(`.tree__row[data-path="${path}"]`)?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')

  it('mounting with an active file leaves its ancestors closed', async () => {
    const { el, v } = await mountVault((v) => `${v}/target/deep/Note.excalidraw`)
    expect(isOpen(el, `${v}/target`)).toBe('false')
    expect(el.querySelector(`[data-path="${v}/target/deep/Note.excalidraw"]`)).toBeNull()
  })

  it('a file opened after the mount still opens its ancestors', async () => {
    const { el, v, rerender } = await mountVault((v) => `${v}/other/Keep.excalidraw`)
    expect(isOpen(el, `${v}/other`)).toBe('false')
    await rerender({ activeFile: `${v}/target/deep/Note.excalidraw` })
    expect(isOpen(el, `${v}/target`)).toBe('true')
    expect(isOpen(el, `${v}/target/deep`)).toBe('true')
    expect(isOpen(el, `${v}/other`)).toBe('false')
  })

  it('coming back to the restored tab after another file reveals it too', async () => {
    const { el, v, rerender } = await mountVault((v) => `${v}/target/deep/Note.excalidraw`)
    await rerender({ activeFile: `${v}/other/Keep.excalidraw` })
    expect(isOpen(el, `${v}/other`)).toBe('true')
    await rerender({ activeFile: `${v}/target/deep/Note.excalidraw` })
    expect(isOpen(el, `${v}/target`)).toBe('true')
    expect(isOpen(el, `${v}/target/deep`)).toBe('true')
  })
})

/**
 * The context menu's per-item TARGET matrix (GRO-2296). Each menu item resolves its own
 * target; no item derives its visibility from another item's value. These assertions are the
 * guard rail for GRO-2297 (blank-space Copy path → the vault ROOT), GRO-2302 (Reveal in
 * Finder) and GRO-2285 (Delete), all of which add items to this same menu: the blank-space
 * row below is what stops a root fallback for Copy path from silently switching on Rename
 * for the vault root, which main refuses outright (BAD_REQUEST, GRO-2241).
 */
describe('context menu target matrix (GRO-2296)', () => {
  const open = async (selector: string) => {
    const { el } = await mount()
    act(() => void el.querySelector(selector)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    return el
  }

  it('a FILE row targets every item: rename, copy path, open in new window', async () => {
    const el = await open('.tree__row--file')
    expect(itemByLabel(el, 'Rename')).toBeDefined()
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
    expect(subItemByLabel(el, 'New window')).toBeDefined()
  })

  it('a FOLDER row targets rename and copy path; the file-only items stay hidden', async () => {
    const el = await open('.tree__row--dir')
    expect(itemByLabel(el, 'Rename')).toBeDefined()
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
    expect(subItemByLabel(el, 'New window')).toBeUndefined()
  })

  it('BLANK SPACE shows no Rename — the vault root is never renameable (the GRO-2297 guard rail)', async () => {
    const el = await open('.sidebar__body')
    expect(itemByLabel(el, 'Rename')).toBeUndefined()
    expect(subItemByLabel(el, 'New window')).toBeUndefined()
    // The create actions are always available on blank space: they target the root.
    expect(itemByLabel(el, 'New Excalidraw drawing')).toBeDefined()
    expect(itemByLabel(el, 'New folder')).toBeDefined()
  })

  it('Rename on a FOLDER row opens the inline input in DIRECTORY mode (raw name, no extension logic)', async () => {
    const el = await open('.tree__row--dir')
    act(() => itemByLabel(el, 'Rename')?.click())
    expect(el.querySelector<HTMLInputElement>('.create-inline__input')?.value).toBe('sub')
  })

  it('Rename on a FILE row opens the inline input in FILE mode (extension stripped)', async () => {
    const el = await open('.tree__row--file')
    act(() => itemByLabel(el, 'Rename')?.click())
    expect(el.querySelector<HTMLInputElement>('.create-inline__input')?.value).toBe('a')
  })
})

/**
 * Blank-space "Copy path" (GRO-2273): right-clicking below the tree copies the VAULT ROOT's
 * absolute path — the blank area already means "the root" everywhere else in this menu
 * (`targetDirFor` sends "New drawing" there). VS Code's empty-Explorer menu behaves the same.
 * Copy path only: Copy Relative Path was declined (LOCKED, GRO-2273).
 */
describe('blank-space copy path (GRO-2273)', () => {
  function installClipboard() {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }

  it('copies the vault ROOT path, with no trailing slash, and closes the menu', async () => {
    const writeText = installClipboard()
    const { el } = await mount()
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
    act(() => itemByLabel(el, 'Copy path')?.click())
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('/v')
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })

  it('still offers no Rename on blank space — the root fallback must not leak into it', async () => {
    installClipboard()
    const { el } = await mount()
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
    expect(itemByLabel(el, 'Rename')).toBeUndefined()
  })

  it('file and folder rows still copy their OWN path, not the root', async () => {
    const writeText = installClipboard()
    const { el } = await mount()
    act(() => void el.querySelector('.tree__row--file')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    act(() => itemByLabel(el, 'Copy path')?.click())
    expect(writeText).toHaveBeenCalledWith('/v/a.excalidraw')
    act(() => void el.querySelector('.tree__row--dir')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    act(() => itemByLabel(el, 'Copy path')?.click())
    expect(writeText).toHaveBeenCalledWith('/v/sub')
  })
})

/**
 * Delete (GRO-2272 `C1-`/`C3-`): the menu entry, the confirm sheet, and what actually reaches
 * App. The blank-space case is the one that matters most — a destructive item must never
 * appear with no target, and main refuses the vault root anyway.
 */
describe('delete (GRO-2272)', () => {
  const openOn = async (selector: string, over: Partial<SidebarProps> = {}) => {
    const m = await mount(over)
    act(() => void m.el.querySelector(selector)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    return m
  }
  const sheet = (el: HTMLElement) => el.querySelector('.confirm')
  const sheetBtn = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLButtonElement>('.confirm__btn')].find((b) => b.textContent === label)

  it('file and folder rows offer Delete; BLANK SPACE does not', async () => {
    const f = await openOn('.tree__row--file')
    expect(itemByLabel(f.el, 'Delete')).toBeDefined()
    const d = await openOn('.tree__row--dir')
    expect(itemByLabel(d.el, 'Delete')).toBeDefined()
    const b = await openOn('.sidebar__body')
    expect(itemByLabel(b.el, 'Delete')).toBeUndefined()
  })

  it('clicking Delete opens the confirm sheet and deletes NOTHING yet', async () => {
    const { el, props } = await openOn('.tree__row--file')
    act(() => itemByLabel(el, 'Delete')?.click())
    expect(sheet(el)).not.toBeNull()
    expect(props.onDeleteFile).not.toHaveBeenCalled()
  })

  it('confirming calls onDeleteFile with the absolute path', async () => {
    const { el, props } = await openOn('.tree__row--file')
    act(() => itemByLabel(el, 'Delete')?.click())
    await act(async () => sheetBtn(el, 'Delete')?.click())
    expect(props.onDeleteFile).toHaveBeenCalledExactlyOnceWith('/v/a.excalidraw')
  })

  it('cancelling calls nothing and closes the sheet', async () => {
    const { el, props } = await openOn('.tree__row--file')
    act(() => itemByLabel(el, 'Delete')?.click())
    await act(async () => sheetBtn(el, 'Cancel')?.click())
    expect(props.onDeleteFile).not.toHaveBeenCalled()
    expect(sheet(el)).toBeNull()
  })

  it('a FOLDER target shows the sheet and deletes the folder path', async () => {
    const { el, props } = await openOn('.tree__row--dir')
    act(() => itemByLabel(el, 'Delete')?.click())
    expect(sheet(el)?.textContent).toContain('"sub"')
    await act(async () => sheetBtn(el, 'Delete')?.click())
    expect(props.onDeleteFile).toHaveBeenCalledExactlyOnceWith('/v/sub')
  })

  it('"Don\'t ask me again" persists confirmDelete: false through onChangeSettings', async () => {
    const { el, props } = await openOn('.tree__row--file')
    act(() => itemByLabel(el, 'Delete')?.click())
    act(() => void el.querySelector<HTMLInputElement>('.confirm__ask input')?.click())
    await act(async () => sheetBtn(el, 'Delete')?.click())
    expect(props.onChangeSettings).toHaveBeenCalledWith(expect.objectContaining({ confirmDelete: false }))
    expect(props.onDeleteFile).toHaveBeenCalledExactlyOnceWith('/v/a.excalidraw')
  })

  it('confirmDelete: false deletes DIRECTLY — no sheet at all (YAZ-857: the setting finally gates)', async () => {
    const { el, props } = await openOn('.tree__row--file', { settings: { ...DEFAULT_SETTINGS, confirmDelete: false } })
    act(() => itemByLabel(el, 'Delete')?.click())
    expect(sheet(el)).toBeNull()
    expect(props.onDeleteFile).toHaveBeenCalledExactlyOnceWith('/v/a.excalidraw')
  })
})

/**
 * Reveal in Finder (GRO-2274). Available on every row type AND on blank space, where it
 * targets the vault ROOT — the same target Copy path uses. Reveal-in-parent for all of them
 * (LOCKED, VS Code parity): there is no branching on kind, which is the point.
 */
describe('reveal in Finder (GRO-2274)', () => {
  const openOn = async (selector: string) => {
    const m = await mount()
    act(() => void m.el.querySelector(selector)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    return m
  }

  it('a FILE row reveals its own path', async () => {
    const { el, bridge } = await openOn('.tree__row--file')
    clickSub(el, 'Reveal in Finder')
    expect(bridge.shell.reveal).toHaveBeenCalledExactlyOnceWith({ path: '/v/a.excalidraw' })
  })

  it('a FOLDER row reveals the folder itself — no branching on kind', async () => {
    const { el, bridge } = await openOn('.tree__row--dir')
    clickSub(el, 'Reveal in Finder')
    expect(bridge.shell.reveal).toHaveBeenCalledExactlyOnceWith({ path: '/v/sub' })
  })

  it('BLANK SPACE reveals the vault root — unlike Delete, which has no blank-space target', async () => {
    const { el, bridge } = await openOn('.sidebar__body')
    expect(itemByLabel(el, 'Delete')).toBeUndefined()
    clickSub(el, 'Reveal in Finder')
    expect(bridge.shell.reveal).toHaveBeenCalledExactlyOnceWith({ path: '/v' })
  })

  it('a stale row surfaces a passive notice rather than looking like a dead menu item', async () => {
    const { el, bridge, props } = await openOn('.tree__row--file')
    bridge.shell.reveal.mockRejectedValue(Object.assign(new Error('path does not exist'), { code: 'NOT_FOUND' }))
    await clickSubAsync(el, 'Reveal in Finder')
    await act(async () => undefined)
    expect(props.onNotice).toHaveBeenCalledWith(expect.stringContaining('no longer there'), 'error')
  })

  it('closes the menu after revealing', async () => {
    const { el } = await openOn('.tree__row--file')
    clickSub(el, 'Reveal in Finder')
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })
})

/**
 * Menu ORDER (GRO-2272 `C1a-`, LOCKED): VS Code's Explorer grouping — read-only utilities
 * first, then the create actions, then Rename and Delete LAST. Pinned here because order is a
 * deliberate safety property, not an accident of JSX: Delete used to sit directly under
 * Rename, which is the misclick pair that matters most.
 */
/**
 * The persistent search bar (YAZ-801): row 2 of the sidebar chrome, ALWAYS present — loading,
 * error and empty vault included, since a bar that comes and goes with the tree would be a view,
 * which is exactly what the rescinded design was. Typing changes nothing below on purpose;
 * YAZ-803 swaps the body to results. The ⌘K focus handshake has no key binding yet (YAZ-804),
 * so it is driven here through the prop — including at MOUNT, which is the ⌘K-while-collapsed path.
 */
describe('persistent search bar (YAZ-801)', () => {
  const pressEscape = (input: HTMLInputElement) => act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

  it('renders while the tree is still loading', async () => {
    const { el } = await mount({}, (b) => b.tree.mockImplementation(() => new Promise(() => undefined)))
    expect(el.textContent).toContain('Loading…')
    expect(searchInput(el)).not.toBeNull()
  })

  it('renders when the tree failed to load', async () => {
    const { el } = await mount({}, (b) => b.tree.mockRejectedValue(new Error('nope')))
    expect(el.querySelector('.sidebar__msg--error')).not.toBeNull()
    expect(searchInput(el)).not.toBeNull()
  })

  it('renders in an empty vault', async () => {
    const { el } = await mount({}, (b) => b.tree.mockImplementation(async (r: string) => ({ root: r, tree: [], generatedAt: 1 })))
    expect(el.textContent).toContain('No boards here.')
    expect(searchInput(el)).not.toBeNull()
  })

  it('typing updates the query', async () => {
    const { el } = await mount()
    const input = searchInput(el)!
    await type(input, 'meeting')
    expect(input.value).toBe('meeting')
  })

  it('Escape with text clears the query and KEEPS focus', async () => {
    const { el } = await mount()
    const input = searchInput(el)!
    act(() => input.focus())
    await type(input, 'meeting')
    pressEscape(input)
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
  })

  it('Escape with an empty input gives up focus', async () => {
    const { el } = await mount()
    const input = searchInput(el)!
    act(() => input.focus())
    pressEscape(input)
    expect(document.activeElement).not.toBe(input)
  })

  it('mounting with pendingSearchFocus focuses the input and reports back (⌘K while collapsed)', async () => {
    const { el, props } = await mount({ pendingSearchFocus: true })
    expect(document.activeElement).toBe(searchInput(el))
    expect(props.onSearchFocusHandled).toHaveBeenCalled()
  })

  it('flipping pendingSearchFocus false → true on a mounted sidebar focuses the input and reports back', async () => {
    const { el, props, rerender } = await mount()
    expect(document.activeElement).not.toBe(searchInput(el))
    await rerender({ pendingSearchFocus: true })
    expect(document.activeElement).toBe(searchInput(el))
    expect(props.onSearchFocusHandled).toHaveBeenCalled()
  })

  it('a plain mount steals no focus', async () => {
    const { el, props } = await mount()
    expect(document.activeElement).not.toBe(searchInput(el))
    expect(props.onSearchFocusHandled).not.toHaveBeenCalled()
  })
})

/**
 * Search results in the body (YAZ-803, 🔒 flat-list ruling on YAZ-739): a typed query swaps the
 * tree for a FLAT ranked list and clearing brings the tree straight back — the swap is a
 * conditional render, so nothing about the tree is torn down. The rows come from the tree the
 * Sidebar already holds (🔒 D1, YAZ-1491), so search costs no second read of the vault. The list
 * is driven entirely from the bar, which never loses focus: arrows clamp at both ends (no wrap),
 * Enter opens in place, ⌘Enter in a background tab, and the list stays up either way.
 */
describe('search results (YAZ-803)', () => {
  const drawing = (basename: string, folder = ''): TreeNode => ({
    type: 'file',
    name: `${basename}.excalidraw`,
    path: `/v/${folder === '' ? '' : `${folder}/`}${basename}.excalidraw`,
    size: 1,
    mtime: 1,
    kind: 'drawing',
  })
  /** Alpha at the root and Anchor inside Docs — two prefix matches for "a", one of them with a folder label. */
  const SEARCH_TREE: TreeNode[] = [drawing('Alpha'), { type: 'dir', name: 'Docs', path: '/v/Docs', children: [drawing('Anchor', 'Docs')] }]

  /** Mount over the vault of Alpha + Docs/Anchor, then type `query` into the bar. */
  const search = async (query: string, over: Partial<SidebarProps> = {}) => {
    const m = await mount(over, (b) => b.tree.mockResolvedValue({ root: '/v', tree: SEARCH_TREE, generatedAt: 1 }))
    const input = searchInput(m.el)!
    await type(input, query)
    return { ...m, input }
  }
  const rowLabels = (el: HTMLElement) => [...el.querySelectorAll('.search-results__row .search-results__label')].map((n) => n.textContent)
  const activeLabel = (el: HTMLElement) => el.querySelector('.search-results__row--active .search-results__label')?.textContent ?? null
  const press = (input: HTMLInputElement, key: string, metaKey = false) =>
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey, bubbles: true })))

  it('typing swaps the tree for the ranked result list; clearing brings the tree back', async () => {
    const { el, input } = await search('a')
    expect(el.querySelector('.tree')).toBeNull()
    expect(rowLabels(el)).toEqual(['Alpha', 'Anchor'])
    await type(input, '')
    expect(el.querySelector('.search-results')).toBeNull()
    expect(el.querySelector('.tree__row--file')).not.toBeNull()
  })

  it('a reveal request for the current lens clears search so that lens tree can render', async () => {
    const { el, input, rerender } = await search('a')
    await rerender({ revealRequest: { id: 1, path: '/v/Alpha.excalidraw', lens: 'files' } })
    expect(input.value).toBe('')
    expect(el.querySelector('.tree__row--file')).not.toBeNull()
  })

  it('a request pinned to another lens does not disturb the current search', async () => {
    const { input, rerender } = await search('a')
    await rerender({ revealRequest: { id: 1, path: '/v/Alpha.excalidraw', lens: 'favorites' } })
    expect(input.value).toBe('a')
  })

  it('a query nothing matches says so, and still hides the tree', async () => {
    const { el } = await search('zzz')
    expect(el.textContent).toContain('No matches')
    expect(el.querySelector('.tree')).toBeNull()
  })

  it('a folder label rides along on rows that have one', async () => {
    const { el } = await search('anch')
    expect(el.querySelector('.search-results__folder')?.textContent).toBe('Docs')
  })

  it('a NON-drawing file is never a result row (YAZ-1814) — it still lists in the tree', async () => {
    const withPng: TreeNode[] = [...SEARCH_TREE, { type: 'file', name: 'alpaca.png', path: '/v/alpaca.png', size: 1, mtime: 1, kind: null }]
    const m = await mount({}, (b) => b.tree.mockResolvedValue({ root: '/v', tree: withPng, generatedAt: 1 }))
    expect(m.el.querySelector('.tree__row--file[title="/v/alpaca.png"]')).not.toBeNull()
    await type(searchInput(m.el)!, 'alp')
    expect(rowLabels(m.el)).toEqual(['Alpha'])
  })

  it('a drawing created after the search opened turns up on the next tree — no restart (YAZ-1814)', async () => {
    // The feed is the tree the STRUCTURAL WATCHER refreshes: fire the watch event the main process
    // would send for a new file and the result list follows, with the query still standing.
    let notify: ((ev: WatchEvent) => void) | null = null
    const { el, bridge } = await search('a', { watch: { subscribe: (l) => ((notify = l), () => (notify = null)) } })
    fakeClock()
    expect(rowLabels(el)).toEqual(['Alpha', 'Anchor'])
    bridge.tree.mockResolvedValue({ root: '/v', tree: [...SEARCH_TREE, drawing('Abacus')], generatedAt: 2 })
    await act(async () => {
      notify?.({ type: 'add', path: '/v/Abacus.excalidraw', mtime: 2 })
      await Promise.resolve()
    })
    await quiet()
    expect(rowLabels(el)).toEqual(['Alpha', 'Anchor', 'Abacus'])
  })

  it('the top row starts selected; ArrowDown/ArrowUp WRAP at both ends (YAZ-1814)', async () => {
    const { el, input } = await search('a')
    expect(activeLabel(el)).toBe('Alpha')
    await press(input, 'ArrowUp')
    expect(activeLabel(el)).toBe('Anchor') // up from the top lands on the last row
    await press(input, 'ArrowDown')
    expect(activeLabel(el)).toBe('Alpha') // and down from the bottom comes back to the first
    await press(input, 'ArrowDown')
    expect(activeLabel(el)).toBe('Anchor')
    await press(input, 'ArrowUp')
    expect(activeLabel(el)).toBe('Alpha')
  })

  it('Enter opens the SELECTED row in the current tab and leaves the list up', async () => {
    const { el, input, props } = await search('a')
    await press(input, 'ArrowDown')
    await press(input, 'Enter')
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/Docs/Anchor.excalidraw')
    expect(props.onOpenFileBackground).not.toHaveBeenCalled()
    expect(input.value).toBe('a')
    expect(rowLabels(el)).toEqual(['Alpha', 'Anchor'])
  })

  it('⌘Enter opens the selected row in a background tab instead', async () => {
    const { input, props } = await search('a')
    await press(input, 'Enter', true)
    expect(props.onOpenFileBackground).toHaveBeenCalledExactlyOnceWith('/v/Alpha.excalidraw')
    expect(props.onOpenFile).not.toHaveBeenCalled()
  })

  it('changing the query re-selects the top row', async () => {
    const { el, input } = await search('a')
    await press(input, 'ArrowDown')
    expect(activeLabel(el)).toBe('Anchor')
    await type(input, 'an')
    expect(activeLabel(el)).toBe('Anchor') // the new ranking's FIRST row, not the carried index
    expect(rowLabels(el)).toEqual(['Anchor'])
  })

  it('a tree refresh that shrinks the list keeps the highlight on the LAST row, and Enter opens that row (YAZ-808)', async () => {
    // The watcher fans out to every subscriber (useWatch's shape); the refresh it triggers is
    // what re-feeds the result list, because the rows ARE the tree (🔒 D1, YAZ-1491).
    const listeners: ((ev: WatchEvent) => void)[] = []
    const watch = {
      subscribe: (l: (ev: WatchEvent) => void) => {
        listeners.push(l)
        return () => void listeners.splice(listeners.indexOf(l), 1)
      },
    }
    const { el, input, bridge, props } = await search('a', { watch })
    fakeClock()
    await press(input, 'ArrowDown')
    expect(activeLabel(el)).toBe('Anchor') // index 1 of two rows
    bridge.tree.mockResolvedValue({ root: '/v', tree: [drawing('Alpha')], generatedAt: 2 })
    await act(async () => [...listeners].forEach((l) => l({ type: 'unlink', path: '/v/Docs/Anchor.excalidraw' })))
    await quiet()
    expect(rowLabels(el)).toEqual(['Alpha'])
    expect(activeLabel(el)).toBe('Alpha') // the stale index 1 clamps onto the last row, not onto nothing
    await press(input, 'Enter')
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/Alpha.excalidraw')
  })

  it('right-clicking blank space in the results offers no menu — not even the OS one (YAZ-803, Docs YAZ-2050)', async () => {
    const { el } = await search('a')
    let reached = true
    act(() => void (reached = el.querySelector('.sidebar__body')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))))
    expect(reached).toBe(false) // default-prevented: Electron's Cut/Copy/Paste menu never opens
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })
})

/**
 * A search row's right-click (Docs YAZ-2050, YAZ-2056 D5/D6): the SAME menu its tree row gets,
 * never Electron's Cut/Copy/Paste. Docs YAZ-2050 D1 / YAZ-2056 D5: it follows the FILES rules on
 * either tab — the lens is pinned onto the menu, so Focus and the Favorites hop read Files. Docs
 * YAZ-2050 D2 / YAZ-2056 D6: the seven items that draw INTO the tree (Focus, the five births,
 * Rename) leave the search through the folder-row door (`onRevealInFiles`) and then act;
 * everything else acts in place and the query stays.
 */
describe('search-row context menu (Docs YAZ-2050, YAZ-2056 D5/D6)', () => {
  const drawing = (path: string, name: string): TreeNode => ({ type: 'file', name, path, size: 1, mtime: 1, kind: 'drawing' })
  /** Notes/, Projects/ holding Roadmap/ (holding plan) and p, and a root drawing `top`. */
  const VAULT = (v: string): TreeNode[] => [
    { type: 'dir', name: 'Notes', path: `${v}/Notes`, children: [drawing(`${v}/Notes/n.excalidraw`, 'n.excalidraw')] },
    {
      type: 'dir', name: 'Projects', path: `${v}/Projects`,
      children: [
        { type: 'dir', name: 'Roadmap', path: `${v}/Projects/Roadmap`, children: [drawing(`${v}/Projects/Roadmap/plan.excalidraw`, 'plan.excalidraw')] },
        drawing(`${v}/Projects/p.excalidraw`, 'p.excalidraw'),
      ],
    },
    drawing(`${v}/top.excalidraw`, 'top.excalidraw'),
  ]

  let vaults = 0
  /** A fresh vault AND window per mount — expansion is per root, and `focus` seeds the window's Files focus (YAZ-1628). */
  const mountVault = async (over: Partial<SidebarProps> = {}, opts: { focus?: string[] } = {}) => {
    const v = `/v-search-menu-${++vaults}`
    const m = await mount({ root: v, ...over }, async (b) => {
      b.tree.mockResolvedValue({ root: v, tree: VAULT(v), generatedAt: 1 } as never)
      b.window.identity.mockResolvedValue({ id: 'w1', root: v, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: (opts.focus ?? []).map((p) => `${v}${p}`), focusFavorites: [] })
      await storage.init()
    })
    return { ...m, v, input: searchInput(m.el)! }
  }
  const search = async (query: string, over: Partial<SidebarProps> = {}, opts: { focus?: string[] } = {}) => {
    const m = await mountVault(over, opts)
    await type(m.input, query)
    return m
  }
  const rightClick = (target: Element | null) => act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  /** Right-click that reports whether the event survived — false means default-prevented (no OS menu). */
  const rightClickReached = (target: Element) => {
    let reached = true
    act(() => void (reached = target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))))
    return reached
  }
  const labels = (el: HTMLElement) => menuItems(el).map((b) => b.textContent)
  const results = (el: HTMLElement) => [...el.querySelectorAll<HTMLLIElement>('.search-results__row')]
  const result = (el: HTMLElement, dir = false) => el.querySelector<HTMLLIElement>(`.search-results__row${dir ? '--dir' : ':not(.search-results__row--dir)'}`)
  const rowByPath = (el: HTMLElement, path: string) => el.querySelector<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)
  const topLabels = (el: HTMLElement) => [...el.querySelectorAll('ul.tree[role="tree"] > li > .tree__row .tree__label')].map((n) => n.textContent)
  const eye = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__focus-off')
  /** The name box inside `dir`'s own children — where a birth into that folder mounts. */
  const boxIn = (el: HTMLElement, dir: string) => rowByPath(el, dir)?.closest('[role="treeitem"]')?.querySelector<HTMLInputElement>('.create-inline__input') ?? null
  /** What App does with `onRevealInFiles`: flip to Files and issue the reveal the Sidebar consumes. */
  const appReveals = (rerender: (next: Partial<SidebarProps>) => Promise<void>, path: string) =>
    rerender({ lens: 'files', revealRequest: { id: 1, path, lens: 'files' } })
  /** The tree row's menu, read off its own mount — the reference every search-row menu must equal. */
  const treeMenu = async (path: string) => {
    const { el, v } = await mountVault()
    rightClick(rowByPath(el, `${v}${path}`))
    const out = labels(el)
    act(() => root?.unmount())
    container?.remove()
    return out
  }

  it('a BOARD result opens the board row\'s menu — never the OS edit menu — and becomes the highlighted row', async () => {
    const expected = await treeMenu('/top.excalidraw')
    const { el } = await search('o')
    const board = results(el).find((r) => r.getAttribute('title')?.endsWith('/top.excalidraw'))!
    expect(board.classList.contains('search-results__row--active')).toBe(false)
    expect(rightClickReached(board)).toBe(false)
    expect(labels(el)).toEqual(expected)
    expect(board.classList.contains('search-results__row--active')).toBe(true)
  })

  it('a FOLDER result opens the folder row\'s menu', async () => {
    const expected = await treeMenu('/Projects')
    const { el } = await search('proj')
    rightClick(result(el, true))
    expect(labels(el)).toEqual(expected)
    expect(labels(el)).toEqual(expect.arrayContaining(['Focus on folder', 'New folder', 'New dated folder']))
  })

  it('on the FAVORITES tab a result still gets the Files-tab menu (YAZ-2056 D5)', async () => {
    const files = await search('top')
    rightClick(result(files.el))
    const expected = labels(files.el)
    expect(expected).toEqual(expect.arrayContaining(['Rename', 'Paste', 'New folder']))
    act(() => root?.unmount())
    container?.remove()
    const favorites = await search('top', { lens: 'favorites' })
    rightClick(result(favorites.el))
    expect(labels(favorites.el)).toEqual(expected)
  })

  it('Rename leaves the search, then the inline input mounts on the (nested) row (YAZ-2056 D6)', async () => {
    const { el, input, props, rerender, v } = await search('plan')
    rightClick(result(el))
    act(() => itemByLabel(el, 'Rename')?.click())
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith(`${v}/Projects/Roadmap/plan.excalidraw`)
    await appReveals(rerender, `${v}/Projects/Roadmap/plan.excalidraw`)
    expect(input.value).toBe('')
    expect(el.querySelector('.search-results')).toBeNull()
    expect(el.querySelector<HTMLInputElement>('.create-inline__input')?.value).toBe('plan')
  })

  it.each(['New Excalidraw drawing', 'New dated Excalidraw drawing', 'New draw.io diagram', 'New folder', 'New dated folder'])(
    '%s on a FOLDER result leaves the search and mounts the name box inside that folder (YAZ-2056 D6)',
    async (item) => {
      const { el, input, props, rerender, v } = await search('road')
      rightClick(result(el, true))
      act(() => itemByLabel(el, item)?.click())
      expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith(`${v}/Projects/Roadmap`)
      await appReveals(rerender, `${v}/Projects/Roadmap`)
      expect(input.value).toBe('')
      expect(boxIn(el, `${v}/Projects/Roadmap`)).not.toBeNull()
    },
  )

  it('New drawing on a BOARD result mounts the name box in its parent folder, and the birth lands there (YAZ-2056 D6)', async () => {
    const { el, props, rerender, bridge, v } = await search('plan')
    rightClick(result(el))
    act(() => itemByLabel(el, 'New Excalidraw drawing')?.click())
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith(`${v}/Projects/Roadmap/plan.excalidraw`)
    await appReveals(rerender, `${v}/Projects/Roadmap/plan.excalidraw`)
    const box = boxIn(el, `${v}/Projects/Roadmap`)!
    await type(box, 'Next')
    await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(bridge.createFile).toHaveBeenCalledExactlyOnceWith({ path: `${v}/Projects/Roadmap/Next.excalidraw`, content: EMPTY_SCENE_JSON })
  })

  it('Focus from search lands focused in Files — the reveal keeps a focus on its own target (YAZ-2056 D6)', async () => {
    const { el, props, rerender, bridge, v } = await search('road')
    rightClick(result(el, true))
    await act(async () => itemByLabel(el, 'Focus on folder')?.click())
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith(`${v}/Projects/Roadmap`)
    await appReveals(rerender, `${v}/Projects/Roadmap`)
    expect(topLabels(el)).toEqual(['Roadmap'])
    expect(eye(el)).not.toBeNull()
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ focusDirs: [`${v}/Projects/Roadmap`] })
  })

  it('Focus from the FAVORITES tab focuses FILES, never the Favorites list, and needs no Favorites hop (YAZ-2056 D5)', async () => {
    const { el, props, rerender, bridge, v } = await search('road', { lens: 'favorites' })
    rightClick(result(el, true))
    await act(async () => itemByLabel(el, 'Focus on folder')?.click())
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ focusDirs: [`${v}/Projects/Roadmap`] })
    expect(bridge.window.setIdentity).not.toHaveBeenCalledWith({ focusFavorites: expect.anything() })
    await appReveals(rerender, `${v}/Projects/Roadmap`)
    expect(topLabels(el)).toEqual(['Roadmap'])
    expect(props.onLensChange).not.toHaveBeenCalled() // App's reveal flipped the tab, not the Sidebar
  })

  it('New drawing from the FAVORITES tab skips the Favorites hop — the reveal door brings Files (YAZ-2056 D5/D6)', async () => {
    const { el, props, rerender, v } = await search('road', { lens: 'favorites' })
    rightClick(result(el, true))
    act(() => itemByLabel(el, 'New Excalidraw drawing')?.click())
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith(`${v}/Projects/Roadmap`)
    expect(props.onLensChange).not.toHaveBeenCalled()
    await appReveals(rerender, `${v}/Projects/Roadmap`)
    expect(boxIn(el, `${v}/Projects/Roadmap`)).not.toBeNull()
  })

  it('a Files focus that would HIDE the row is ended by the reveal, so the rename box has a row to mount on (YAZ-2056 D6)', async () => {
    const { el, rerender, bridge, v } = await search('plan', {}, { focus: ['/Notes'] })
    rightClick(result(el))
    act(() => itemByLabel(el, 'Rename')?.click())
    await appReveals(rerender, `${v}/Projects/Roadmap/plan.excalidraw`)
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ focusDirs: [] })
    expect(eye(el)).toBeNull()
    expect(el.querySelector<HTMLInputElement>('.create-inline__input')?.value).toBe('plan')
  })

  it('items that need no tree act in place and keep the search (YAZ-2056 D6)', async () => {
    const writeText = vi.fn(async () => undefined)
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const { el, input, props, bridge, v } = await search('plan')
      rightClick(result(el))
      act(() => itemByLabel(el, 'Copy path')?.click())
      expect(writeText).toHaveBeenCalledExactlyOnceWith(`${v}/Projects/Roadmap/plan.excalidraw`)
      rightClick(result(el))
      await clickSubAsync(el, 'Reveal in Finder')
      expect(bridge.shell.reveal).toHaveBeenCalledExactlyOnceWith({ path: `${v}/Projects/Roadmap/plan.excalidraw` })
      expect(props.onRevealInFiles).not.toHaveBeenCalled()
      expect(input.value).toBe('plan')
      expect(el.querySelector('.search-results')).not.toBeNull()
    } finally {
      // Put the real clipboard back, so no later test writes through this spy.
      if (original === undefined) delete (navigator as unknown as Record<string, unknown>).clipboard
      else Object.defineProperty(navigator, 'clipboard', original)
    }
  })

  it('"No matches" offers no menu either — not even the OS one', async () => {
    const { el } = await search('zzz')
    expect(rightClickReached(el.querySelector('.sidebar__msg')!)).toBe(false)
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })
})

/**
 * Folders in the search list (YAZ-1491). 🔒 D1: the rows come from the tree the Sidebar already
 * holds (`dirs`), never a second read of the vault. 🔒 YAZ-1491 D2: one flat list, the same matcher — a
 * folder is one row, a file still never matches on its folder. 🔒 YAZ-1491 D3: choosing a folder row REVEALS it in
 * Files — `onRevealInFiles`, never `onOpenFile` — from EITHER lens and by keyboard OR click, and
 * the Files reveal path accepts a DIR: ancestors AND the dir itself open, the dir row flashes.
 * 🔒 YAZ-1491 D4: the row looks like a folder.
 */
describe('folder rows in search (YAZ-1491)', () => {
  const rowLabels = (el: HTMLElement) => [...el.querySelectorAll('.search-results__row .search-results__label')].map((n) => n.textContent)
  const dirResult = (el: HTMLElement) => el.querySelector<HTMLLIElement>('.search-results__row--dir')
  const press = (input: HTMLInputElement, key: string, metaKey = false) =>
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey, bubbles: true })))
  const dirRow = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.tree__row--dir')].find((row) => row.querySelector('.tree__label')?.textContent === label)
  const expandedState = (el: HTMLElement, label: string) => dirRow(el, label)?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')

  /** A folder AND a drawing both called `sub`, so the tie-break is observable. */
  const SUB_TREE: TreeNode[] = [
    { type: 'dir', name: 'sub', path: '/v/sub', children: [] },
    { type: 'file', name: 'sub.excalidraw', path: '/v/sub.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
  ]
  const search = async (query: string, over: Partial<SidebarProps> = {}) => {
    const m = await mount(over, (b) => b.tree.mockResolvedValue({ root: '/v', tree: SUB_TREE, generatedAt: 1 }))
    const input = searchInput(m.el)!
    await type(input, query)
    return { ...m, input }
  }

  it('a folder of the loaded tree is a row — above the same-named drawing — marked as a folder (🔒 YAZ-1491 D1/D2/D4)', async () => {
    const { el } = await search('sub')
    expect(rowLabels(el)).toEqual(['sub', 'sub'])
    const [folder, file] = [...el.querySelectorAll('.search-results__row')]
    expect(folder.classList.contains('search-results__row--dir')).toBe(true)
    expect(folder.getAttribute('aria-label')).toBe('Search result sub, folder')
    expect(folder.querySelector('.search-results__glyph')).not.toBeNull()
    expect(file.classList.contains('search-results__row--dir')).toBe(false)
  })

  it('Enter on a folder row asks App to reveal it in Files and opens nothing (🔒 YAZ-1491 D3)', async () => {
    const { el, input, props } = await search('sub')
    expect(dirResult(el)?.classList.contains('search-results__row--active')).toBe(true)
    await press(input, 'Enter')
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith('/v/sub')
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(props.onOpenFileBackground).not.toHaveBeenCalled()
  })

  it('⌘-Enter on a folder row reveals too — there is no background tab for a folder', async () => {
    const { input, props } = await search('sub')
    await press(input, 'Enter', true)
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith('/v/sub')
    expect(props.onOpenFileBackground).not.toHaveBeenCalled()
  })

  it('a click on a folder row goes through the SAME rule as Enter', async () => {
    const { el, props } = await search('sub')
    act(() => dirResult(el)?.click())
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith('/v/sub')
    expect(props.onOpenFile).not.toHaveBeenCalled()
  })

  it('the drawing row beneath still OPENS — the rule is per row, not per list', async () => {
    const { input, props } = await search('sub')
    await press(input, 'ArrowDown')
    await press(input, 'Enter')
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/sub.excalidraw')
    expect(props.onRevealInFiles).not.toHaveBeenCalled()
  })

  it('from the FAVORITES lens a folder row still reveals in Files (🔒 YAZ-1491 D3: whichever tab was showing)', async () => {
    const { el, input, props } = await search('sub', { lens: 'favorites' })
    expect(dirResult(el)).not.toBeNull()
    await press(input, 'Enter')
    expect(props.onRevealInFiles).toHaveBeenCalledExactlyOnceWith('/v/sub')
  })

  it('App\'s reply — the Files reveal request — clears the query and flashes the folder row', async () => {
    const { el, input, props, rerender } = await search('sub')
    await press(input, 'Enter')
    // What `revealInFiles` in App does next: the lens is already Files here, so only the request lands.
    await rerender({ revealRequest: { id: 1, path: '/v/sub', lens: 'files' } })
    expect(input.value).toBe('')
    expect(el.querySelector('.search-results')).toBeNull()
    expect(dirRow(el, 'sub')?.classList.contains('tree__row--revealed')).toBe(true)
    expect(props.onNotice).not.toHaveBeenCalled()
  })

  it('a Files reveal request for a DIR opens its ancestors AND itself and flashes its row — no "no longer there"', async () => {
    // Its own root: expansion persists PER ROOT across the tests in this file, so a sibling under
    // `/v` could already be open from an earlier click. Nothing has ever touched `/w`.
    const DIR = '/w/target/deep'
    const DEEP_TREE: TreeNode[] = [
      { type: 'dir', name: 'other', path: '/w/other', children: [] },
      {
        type: 'dir', name: 'target', path: '/w/target',
        children: [{
          type: 'dir', name: 'deep', path: DIR,
          children: [{ type: 'file', name: 'Note.excalidraw', path: `${DIR}/Note.excalidraw`, size: 1, mtime: 1, kind: 'drawing' }],
        }],
      },
    ]
    const { el, props } = await mount(
      { root: '/w', revealRequest: { id: 1, path: DIR, lens: 'files' } },
      (b) => b.tree.mockResolvedValue({ root: '/w', tree: DEEP_TREE, generatedAt: 1 }),
    )
    expect(props.onRevealConsumed).toHaveBeenCalledExactlyOnceWith(1)
    expect(expandedState(el, 'target')).toBe('true')
    expect(expandedState(el, 'deep')).toBe('true') // the folder opens ITSELF too
    expect(expandedState(el, 'other')).toBe('false')
    expect(el.querySelector(`.tree__row--dir[data-path="${DIR}"]`)?.classList.contains('tree__row--revealed')).toBe(true)
    expect(props.onNotice).not.toHaveBeenCalled()
  })

  it('a reveal for a folder the tree no longer has still reports the passive notice', async () => {
    const { props } = await mount({ revealRequest: { id: 1, path: '/v/gone', lens: 'files' } })
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Can\'t show "gone" in Files — it is no longer there', 'error')
  })
})

/**
 * The lens tabs (🔒 D4/D5, YAZ-847): chrome v2 ROW 1, above the persistent search bar. Files is
 * the DEFAULT lens and holds the file explorer; Favorites (YAZ-1766 D1) is the pinned list behind
 * the heart. The VALUE is App's (window identity, `WindowEntry.sidebarLens`, since YAZ-1628): the
 * sidebar renders the row and reports clicks, and App hands the new lens back down. Switching is
 * a conditional render, never a teardown — the search wave's rule, re-proved here on the tree's
 * expansion. Search keeps working from both lenses and the query survives a lens switch (🔒 YAZ-847 D5).
 */
describe('lens tabs (🔒 D4/D5, YAZ-847)', () => {
  const tabs = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.sidebar__lenses[role="tablist"] [role="tab"]')]
  /** The Favorites tab is a heart, so its name is its `aria-label`; Files spells itself. */
  const tabName = (b: HTMLButtonElement) => b.textContent || b.getAttribute('aria-label')
  const tabByLabel = (el: HTMLElement, label: string) => tabs(el).find((b) => tabName(b) === label)
  const selectedTabs = (el: HTMLElement) => tabs(el).filter((b) => b.getAttribute('aria-selected') === 'true').map(tabName)
  const bodyMsg = (el: HTMLElement) => el.querySelector('.sidebar__body .sidebar__msg')?.textContent ?? null
  const resultLabels = (el: HTMLElement) => [...el.querySelectorAll('.search-results__row .search-results__label')].map((n) => n.textContent)
  const dirItem = (el: HTMLElement) => el.querySelector('.tree__row--dir')?.closest('[role="treeitem"]') ?? null

  it('renders a tablist of exactly Files then Favorites (YAZ-1766 D1), the active one aria-selected and no other', async () => {
    const { el } = await mount({ lens: 'files' })
    expect(tabs(el).map(tabName)).toEqual(['Files', 'Favorites'])
    expect(selectedTabs(el)).toEqual(['Files'])
    const favorites = await mount({ lens: 'favorites' })
    expect(selectedTabs(favorites.el)).toEqual(['Favorites'])
  })

  it('the default lens is Files: the file tree, and the search bar is still there', async () => {
    const { el } = await mount({ lens: 'files' })
    expect(el.querySelector('.tree')).not.toBeNull()
    expect(el.querySelector('.tree__row--file')).not.toBeNull()
    expect(searchInput(el)).not.toBeNull() // ALWAYS visible, on both lenses (the locked YAZ-739 rule)
  })

  it('the Favorites lens is the pinned list, never the file tree', async () => {
    const { el } = await mount({ lens: 'favorites' })
    expect(el.querySelector('.tree__row--file')).toBeNull()
    expect(bodyMsg(el)).toBe('No favorites yet. Right-click a file or folder → Add to favorites.')
    expect(searchInput(el)).not.toBeNull()
  })

  it('clicking a tab reports UP to App and flips nothing by itself — the value is App\'s', async () => {
    const { el, props } = await mount({ lens: 'files' })
    act(() => tabByLabel(el, 'Favorites')?.click())
    expect(props.onLensChange).toHaveBeenCalledExactlyOnceWith('favorites')
    expect(selectedTabs(el)).toEqual(['Files']) // still Files until App hands the new lens back
    expect(el.querySelector('.tree')).not.toBeNull()
  })

  it('App handing the new lens back down is what swaps the body', async () => {
    const { el, rerender } = await mount({ lens: 'files' })
    await rerender({ lens: 'favorites' })
    expect(selectedTabs(el)).toEqual(['Favorites'])
    expect(el.querySelector('.tree')).toBeNull()
    expect(bodyMsg(el)).toBe('No favorites yet. Right-click a file or folder → Add to favorites.')
  })

  it('switching Files → Favorites → Files never tears the tree down: its expansion is waiting', async () => {
    const { el, rerender } = await mount({ lens: 'files' })
    const before = dirItem(el)?.getAttribute('aria-expanded')
    act(() => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click())
    const toggled = dirItem(el)?.getAttribute('aria-expanded')
    expect(toggled).not.toBe(before)
    await rerender({ lens: 'favorites' })
    expect(el.querySelector('.tree')).toBeNull()
    await rerender({ lens: 'files' })
    expect(dirItem(el)?.getAttribute('aria-expanded')).toBe(toggled)
    act(() => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click()) // fold it back the way it was found
  })

  it('a query on FAVORITES replaces the empty list with the flat results; clearing brings the list back', async () => {
    const { el } = await mount({ lens: 'favorites' })
    const input = searchInput(el)!
    await type(input, 'a')
    expect(resultLabels(el)).toEqual(['a'])
    expect(bodyMsg(el)).toBeNull()
    await type(input, '')
    expect(el.querySelector('.search-results')).toBeNull()
    expect(bodyMsg(el)).toBe('No favorites yet. Right-click a file or folder → Add to favorites.')
  })

  it('the tabs row stays visible and clickable DURING a search, and a lens switch keeps the query (🔒 YAZ-847 D5)', async () => {
    const { el, props, rerender } = await mount({ lens: 'favorites' })
    const input = searchInput(el)!
    await type(input, 'a')
    expect(selectedTabs(el)).toEqual(['Favorites'])
    act(() => tabByLabel(el, 'Files')?.click())
    expect(props.onLensChange).toHaveBeenCalledExactlyOnceWith('files')
    await rerender({ lens: 'files' })
    expect(input.value).toBe('a') // the query is untouched by the switch…
    expect(resultLabels(el)).toEqual(['a']) // …and still replaces the ACTIVE tab's body
    expect(el.querySelector('.tree')).toBeNull()
    await type(input, '')
    expect(el.querySelector('.tree')).not.toBeNull() // clearing lands on the lens that is now active
  })

  /**
   * Blank space means the same thing in either lens — the vault ROOT — and offers the same
   * root-targeted menu, "New folder" and the root paste target included (YAZ-948 retired the one
   * lens that withheld them).
   */
  it('BLANK SPACE in Favorites opens the same root-targeted menu as Files', async () => {
    const { el } = await mount({ lens: 'favorites' })
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(el.querySelector('.ctx-menu')).not.toBeNull()
    expect(menuItems(el).map((b) => b.textContent)).toEqual(['Paste', 'Copy path', 'New Excalidraw drawing', 'New dated Excalidraw drawing', 'New draw.io diagram', 'New folder', 'New dated folder', 'Open in'])
  })

  it('a typed query still offers nothing on either lens — a result list has no root to target (YAZ-803)', async () => {
    const { el } = await mount({ lens: 'favorites' })
    await type(searchInput(el)!, 'a')
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })
})

/**
 * Expand / collapse all (⚡ YAZ-862): ONE double-chevron button at the end of the lens row,
 * replacing the whole expanded set in a single dispatch. Anything open means the click collapses;
 * only a fully closed tree expands. It belongs to the tree BODY, so it is GONE (never disabled)
 * while a query is typed and in a vault with no folders to open. The Favorites half — the same
 * button acting on the pinned folders only — is pinned in the favorites describe below.
 */
describe('expand / collapse all (⚡ YAZ-862)', () => {
  const drawing = (path: string): TreeNode => ({ type: 'file', name: 'n.excalidraw', path, size: 1, mtime: 1, kind: 'drawing' })
  /** Two depths of folder: docs/ holding deep/, notes/ empty beside it, and a drawing at the top. */
  const NESTED = (v: string): TreeNode[] => [
    {
      type: 'dir',
      name: 'docs',
      path: `${v}/docs`,
      children: [{ type: 'dir', name: 'deep', path: `${v}/docs/deep`, children: [drawing(`${v}/docs/deep/n.excalidraw`)] }],
    },
    { type: 'dir', name: 'notes', path: `${v}/notes`, children: [] },
    drawing(`${v}/n.excalidraw`),
  ]

  // Expansion is persisted per ROOT in the app-state cache, which is module-level and outlives a
  // test — so every mount here opens its OWN vault and therefore starts from an empty set.
  let vaults = 0
  const mountVault = async (nodes: (v: string) => TreeNode[] = NESTED, over: Partial<SidebarProps> = {}) => {
    const vault = `/v-all-${++vaults}`
    return mount({ root: vault, ...over }, (b) => b.tree.mockResolvedValue({ root: vault, tree: nodes(vault), generatedAt: 1 } as never))
  }
  const allButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__expand-all')
  const label = (el: HTMLElement) => allButton(el)?.getAttribute('aria-label') ?? null
  const dirLabels = (el: HTMLElement) => [...el.querySelectorAll('.tree__row--dir .tree__label')].map((n) => n.textContent)
  const dirRow = (el: HTMLElement, i: number) => el.querySelectorAll<HTMLButtonElement>('.tree__row--dir')[i]

  it('a closed tree offers "Expand all", and one click opens every folder at every depth', async () => {
    const { el } = await mountVault()
    expect(dirLabels(el)).toEqual(['docs', 'notes'])
    expect(label(el)).toBe('Expand all')
    expect(allButton(el)?.title).toBe('Expand all')
    act(() => allButton(el)?.click())
    expect(dirLabels(el)).toEqual(['docs', 'deep', 'notes'])
    expect(label(el)).toBe('Collapse all')
    expect(allButton(el)?.title).toBe('Collapse all')
  })

  it('an open tree — fully or PARTLY — offers "Collapse all", and one click closes the lot', async () => {
    const { el } = await mountVault()
    act(() => allButton(el)?.click())
    act(() => allButton(el)?.click())
    expect(dirLabels(el)).toEqual(['docs', 'notes'])
    expect(label(el)).toBe('Expand all')
    // One open folder is enough — the button never offers to expand a tree that is already part way.
    act(() => dirRow(el, 1)?.click())
    expect(label(el)).toBe('Collapse all')
    act(() => allButton(el)?.click())
    expect(dirLabels(el)).toEqual(['docs', 'notes'])
    expect(label(el)).toBe('Expand all')
  })

  it('there is no button while a query is typed, on an empty Favorites tab, or in a vault with no folders', async () => {
    const searched = await mountVault()
    const input = searchInput(searched.el)!
    await type(input, 'a')
    expect(allButton(searched.el)).toBeNull()
    await type(input, '')
    expect(allButton(searched.el)).not.toBeNull() // back with the tree it belongs to

    // The lens row's button acts on the ACTIVE lens, so an EMPTY Favorites tab has nothing to
    // unfold — the same "nothing to open" rule, not a lens exclusion. The folder tree standing
    // right there does not lend it one.
    const favorites = await mountVault(NESTED, { lens: 'favorites' })
    expect(allButton(favorites.el)).toBeNull()

    const flat = await mountVault((v) => [drawing(`${v}/n.excalidraw`)])
    expect(flat.el.querySelector('.tree__row--file')).not.toBeNull()
    expect(allButton(flat.el)).toBeNull()
  })
})

/**
 * Focus Mode on the FILES lens (YAZ-1605): the tree narrows to the folders you picked — they are
 * the ONLY top rows — and the eye beside the chevrons is the way out. The focus lives in the same
 * per-vault storage bucket as `expanded`, so (exactly as above) every mount here opens its OWN
 * vault and therefore starts from no focus at all.
 */
describe('focus mode (YAZ-1605)', () => {
  const drawing = (path: string, name: string): TreeNode => ({ type: 'file', name, path, size: 1, mtime: 1, kind: 'drawing' })
  /** Notes/ holding Sub/, Projects/ holding Alpha/, the prefix-sharing Projects-Archive/, and a root drawing. */
  const FOCUS = (v: string): TreeNode[] => [
    {
      type: 'dir', name: 'Notes', path: `${v}/Notes`,
      children: [{ type: 'dir', name: 'Sub', path: `${v}/Notes/Sub`, children: [] }, drawing(`${v}/Notes/n.excalidraw`, 'n.excalidraw')],
    },
    {
      type: 'dir', name: 'Projects', path: `${v}/Projects`,
      children: [
        { type: 'dir', name: 'Alpha', path: `${v}/Projects/Alpha`, children: [drawing(`${v}/Projects/Alpha/a.excalidraw`, 'a.excalidraw')] },
        drawing(`${v}/Projects/p.excalidraw`, 'p.excalidraw'),
      ],
    },
    { type: 'dir', name: 'Projects-Archive', path: `${v}/Projects-Archive`, children: [drawing(`${v}/Projects-Archive/old.excalidraw`, 'old.excalidraw')] },
    drawing(`${v}/top.excalidraw`, 'top.excalidraw'),
  ]

  let vaults = 0
  /**
   * One fresh vault AND one fresh WINDOW per mount (`storage.init()` against this mount's bridge).
   * `focus` seeds a PERSISTED focus the way main hands it over at boot — in the window's identity
   * (YAZ-1628), never the vault bucket — so the Sidebar restores it through the real storage module.
   */
  const mountVault = async (over: Partial<SidebarProps> = {}, opts: { nodes?: (v: string) => TreeNode[]; focus?: string[] } = {}) => {
    const v = `/v-focus-${++vaults}`
    const m = await mount({ root: v, ...over }, async (b) => {
      b.tree.mockResolvedValue({ root: v, tree: (opts.nodes ?? FOCUS)(v), generatedAt: 1 } as never)
      b.window.identity.mockResolvedValue({ id: 'w1', root: v, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: (opts.focus ?? []).map((p) => `${v}${p}`), focusFavorites: [] })
      await storage.init()
    })
    return { ...m, v }
  }

  const rowByPath = (el: HTMLElement, path: string) => el.querySelector<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)
  const rightClick = (target: Element | null) => act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  const shiftClickRow = (row: HTMLElement | null) => act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  const closeMenu = (el: HTMLElement) => act(() => void el.querySelector('.ctx-overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  const dirLabels = (el: HTMLElement) => [...el.querySelectorAll('.tree__row--dir .tree__label')].map((n) => n.textContent)
  /** Only the rows drawn at depth 0 — every nested list is a `role="group"`, so this is what "at the top" means. */
  const topLabels = (el: HTMLElement) => [...el.querySelectorAll('ul.tree[role="tree"] > li > .tree__row .tree__label')].map((n) => n.textContent)
  const lensButtons = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.sidebar__lenses button')]
  const allButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__expand-all')
  const eye = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__focus-off')
  const isOpen = (el: HTMLElement, path: string) => rowByPath(el, path)?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')
  /** The only way in: right-click the row and take the menu's Focus item. */
  const focusRow = async (el: HTMLElement, path: string, label = 'Focus on folder') => {
    rightClick(rowByPath(el, path))
    await act(async () => itemByLabel(el, label)?.click())
  }

  it('offers "Focus on folder" on a folder row — never on a file row or on blank space', async () => {
    const { el, v } = await mountVault()
    rightClick(rowByPath(el, `${v}/Projects`))
    expect(itemByLabel(el, 'Focus on folder')).toBeDefined()
    closeMenu(el)
    rightClick(rowByPath(el, `${v}/top.excalidraw`))
    expect(itemByLabel(el, 'Focus on folder')).toBeUndefined()
    closeMenu(el)
    rightClick(el.querySelector('.sidebar__body'))
    expect(itemByLabel(el, 'Focus on folder')).toBeUndefined()
    expect(itemByLabel(el, 'New Excalidraw drawing')).toBeDefined() // the menu is there; only Focus is missing
  })

  it('focusing a folder makes it the only top row, opens it, and stores the one path', async () => {
    const { el, v, bridge } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    expect(topLabels(el)).toEqual(['Projects'])
    expect(isOpen(el, `${v}/Projects`)).toBe('true')
    expect(dirLabels(el)).toEqual(['Projects', 'Alpha'])
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ focusDirs: [`${v}/Projects`] })
    expect(bridge.state.setFolder).not.toHaveBeenCalledWith(v, expect.objectContaining({ focusDirs: expect.anything() })) // never the vault bucket (YAZ-1628)
  })

  it('the eye is lit only while focused and sits directly before the chevrons', async () => {
    const { el, v } = await mountVault()
    expect(eye(el)).toBeNull()
    await focusRow(el, `${v}/Projects`)
    expect(eye(el)?.getAttribute('aria-label')).toBe('Exit focus mode')
    const row = lensButtons(el)
    expect(row.indexOf(eye(el)!)).toBe(row.indexOf(allButton(el)!) - 1)
  })

  it('clicking the eye brings every top row back and clears the stored focus', async () => {
    const { el, v, bridge } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    await act(async () => eye(el)?.click())
    expect(eye(el)).toBeNull()
    expect(topLabels(el)).toEqual(['Notes', 'Projects', 'Projects-Archive', 'top'])
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ focusDirs: [] })
  })

  it('a focus restored from this window\'s identity narrows the first render and is never written back', async () => {
    const { el, bridge } = await mountVault({}, { focus: ['/Projects'] })
    expect(topLabels(el)).toEqual(['Projects'])
    expect(eye(el)).not.toBeNull()
    expect(bridge.window.setIdentity).not.toHaveBeenCalled()
  })

  it('expand all while focused opens only the folders inside the focus', async () => {
    const { el, v } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    act(() => allButton(el)?.click()) // focusing opened Projects, so the first click is the collapse…
    expect(allButton(el)?.getAttribute('aria-label')).toBe('Expand all')
    act(() => allButton(el)?.click())
    expect(isOpen(el, `${v}/Projects/Alpha`)).toBe('true')
    await act(async () => eye(el)?.click())
    expect(dirLabels(el)).toEqual(['Notes', 'Projects', 'Alpha', 'Projects-Archive']) // Notes never opened
  })

  it('collapse all while focused leaves a fold outside the focus exactly as it was', async () => {
    const { el, v } = await mountVault()
    act(() => rowByPath(el, `${v}/Notes`)?.click())
    expect(dirLabels(el)).toEqual(['Notes', 'Sub', 'Projects', 'Projects-Archive'])
    await focusRow(el, `${v}/Projects`)
    act(() => allButton(el)?.click())
    expect(dirLabels(el)).toEqual(['Projects'])
    await act(async () => eye(el)?.click())
    expect(dirLabels(el)).toEqual(['Notes', 'Sub', 'Projects', 'Projects-Archive'])
  })

  it('a focus on /Projects never shows the prefix-sharing /Projects-Archive', async () => {
    const { el, v } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    expect(topLabels(el)).toEqual(['Projects'])
    expect(rowByPath(el, `${v}/Projects-Archive`)).toBeNull()
  })

  it('a 2-folder selection reads "Focus on 2 folders" and puts both at the top in TREE order', async () => {
    const { el, v } = await mountVault()
    shiftClickRow(rowByPath(el, `${v}/Projects`)) // click order Projects → Notes…
    shiftClickRow(rowByPath(el, `${v}/Notes`))
    rightClick(rowByPath(el, `${v}/Notes`))
    expect(itemByLabel(el, 'Focus on 2 folders')).toBeDefined()
    await act(async () => itemByLabel(el, 'Focus on 2 folders')?.click())
    expect(topLabels(el)).toEqual(['Notes', 'Projects']) // …tree order out
  })

  it('a selection of files only offers no Focus item', async () => {
    const { el, v } = await mountVault()
    act(() => rowByPath(el, `${v}/Projects`)?.click()) // open it so a nested drawing is a row too…
    // …and let go of it: since D9 (YAZ-1674) that click SELECTED the folder, and this case is about files only.
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    shiftClickRow(rowByPath(el, `${v}/top.excalidraw`))
    shiftClickRow(rowByPath(el, `${v}/Projects/p.excalidraw`))
    rightClick(rowByPath(el, `${v}/top.excalidraw`))
    expect(menuItems(el).map((b) => b.textContent).some((t) => t?.startsWith('Focus'))).toBe(false)
  })

  it('a selection of one folder and one file focuses the folder — "Focus on folder", singular', async () => {
    const { el, v } = await mountVault()
    shiftClickRow(rowByPath(el, `${v}/Projects`))
    shiftClickRow(rowByPath(el, `${v}/top.excalidraw`))
    rightClick(rowByPath(el, `${v}/top.excalidraw`))
    expect(itemByLabel(el, 'Focus on folder')).toBeDefined()
    await act(async () => itemByLabel(el, 'Focus on folder')?.click())
    expect(topLabels(el)).toEqual(['Projects'])
  })

  it('focusing a folder AND its own subfolder draws the subfolder once, under its parent', async () => {
    const { el, v } = await mountVault()
    act(() => rowByPath(el, `${v}/Projects`)?.click()) // open it so Alpha is a row to select — and SELECT it (D9, YAZ-1674)
    shiftClickRow(rowByPath(el, `${v}/Projects/Alpha`)) // shift ADDS the subfolder beside its parent
    rightClick(rowByPath(el, `${v}/Projects/Alpha`))
    await act(async () => itemByLabel(el, 'Focus on 2 folders')?.click())
    expect(topLabels(el)).toEqual(['Projects'])
    expect(dirLabels(el)).toEqual(['Projects', 'Alpha'])
  })

  /** The watcher-driven refresh idiom: a new tree answers the next `bridge.tree`, an event triggers it. */
  const withWatcher = () => {
    let emit: ((ev: WatchEvent) => void) | undefined
    const watch = {
      subscribe: (l: (ev: WatchEvent) => void) => {
        emit = l
        return () => undefined
      },
    }
    return { watch, fire: (ev: WatchEvent) => emit?.(ev) }
  }

  it('a focused folder that leaves the tree ends the focus and brings the whole vault back', async () => {
    const { watch, fire } = withWatcher()
    const { el, v, bridge } = await mountVault({ watch })
    fakeClock()
    await focusRow(el, `${v}/Projects`)
    bridge.tree.mockResolvedValue({ root: v, tree: FOCUS(v).filter((n) => n.path !== `${v}/Projects`), generatedAt: 2 } as never)
    await act(async () => fire({ type: 'unlinkDir', path: `${v}/Projects` }))
    await quiet()
    expect(eye(el)).toBeNull()
    expect(topLabels(el)).toEqual(['Notes', 'Projects-Archive', 'top'])
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ focusDirs: [] })
  })

  it('with two folders focused, the survivor keeps the focus when the other vanishes', async () => {
    const { watch, fire } = withWatcher()
    const { el, v, bridge } = await mountVault({ watch })
    fakeClock()
    shiftClickRow(rowByPath(el, `${v}/Notes`))
    shiftClickRow(rowByPath(el, `${v}/Projects`))
    rightClick(rowByPath(el, `${v}/Notes`))
    await act(async () => itemByLabel(el, 'Focus on 2 folders')?.click())
    bridge.tree.mockResolvedValue({ root: v, tree: FOCUS(v).filter((n) => n.path !== `${v}/Projects`), generatedAt: 2 } as never)
    await act(async () => fire({ type: 'unlinkDir', path: `${v}/Projects` }))
    await quiet()
    expect(eye(el)).not.toBeNull()
    expect(topLabels(el)).toEqual(['Notes'])
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ focusDirs: [`${v}/Notes`] })
  })

  it('a reveal OUTSIDE the focus ends it and still shows the target', async () => {
    const { el, v, rerender } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    await rerender({ revealRequest: { id: 1, path: `${v}/Notes/n.excalidraw`, lens: 'files' } })
    expect(eye(el)).toBeNull()
    expect(rowByPath(el, `${v}/Notes/n.excalidraw`)?.classList.contains('tree__row--revealed')).toBe(true)
  })

  it('a reveal INSIDE the focus keeps it', async () => {
    const { el, v, rerender } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    await rerender({ revealRequest: { id: 1, path: `${v}/Projects/Alpha/a.excalidraw`, lens: 'files' } })
    expect(eye(el)).not.toBeNull()
    expect(topLabels(el)).toEqual(['Projects'])
    expect(rowByPath(el, `${v}/Projects/Alpha/a.excalidraw`)?.classList.contains('tree__row--revealed')).toBe(true)
  })

  it('a typed query hides the eye; clearing it brings the eye back, still narrowed', async () => {
    const { el, v } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    const input = searchInput(el)!
    await type(input, 'a')
    expect(eye(el)).toBeNull()
    await type(input, '')
    expect(eye(el)).not.toBeNull()
    expect(topLabels(el)).toEqual(['Projects'])
  })

  it('a Files focus survives a trip through Favorites — the eye belongs to the ACTIVE lens', async () => {
    const { el, v, rerender } = await mountVault()
    await focusRow(el, `${v}/Projects`)
    await rerender({ lens: 'favorites' })
    expect(eye(el)).toBeNull() // Favorites carries its own focus, and it is empty
    await rerender({ lens: 'files' })
    expect(eye(el)).not.toBeNull()
    expect(topLabels(el)).toEqual(['Projects'])
  })
})

/**
 * The Favorites tab (YAZ-1766): a third lens listing the files and folders the user pinned from any
 * row's menu, in insertion order, each a full tree row — a pinned folder unfolds in place through
 * the Files tree's own expansion (D7), a pinned file inside a pinned folder shows twice (root and
 * nested), the toast names the kind, the list persists in the vault's `.yaseendraw/favorites.json`
 * through `favorites.get/set` (D2, in the vault since 6A/D11), root rows drag to reorder (D4), and
 * Focus keeps its own per-window list here (D5). One fresh vault and window per mount, as the Focus
 * block above does it.
 */
describe('favorites (YAZ-1766)', () => {
  const drawing = (path: string, name: string): TreeNode => ({ type: 'file', name, path, size: 1, mtime: 1, kind: 'drawing' })
  const FAV = (v: string): TreeNode[] => [
    { type: 'dir', name: 'Notes', path: `${v}/Notes`, children: [drawing(`${v}/Notes/n.excalidraw`, 'n.excalidraw')] },
    {
      type: 'dir', name: 'Projects', path: `${v}/Projects`,
      children: [{ type: 'dir', name: 'Alpha', path: `${v}/Projects/Alpha`, children: [] }, drawing(`${v}/Projects/p.excalidraw`, 'p.excalidraw')],
    },
    drawing(`${v}/top.excalidraw`, 'top.excalidraw'),
  ]

  let vaults = 0
  /** A fresh vault + window; `favorites` seeds what `favorites.get` answers — the vault file's list, absolute, as main hands it over (6A). */
  const mountVault = async (over: Partial<SidebarProps> = {}, opts: { favorites?: string[]; focusFavorites?: string[]; nodes?: (v: string) => TreeNode[] } = {}) => {
    const v = `/v-fav-${++vaults}`
    let emit: ((c: { root: string }) => void) | undefined
    const m = await mount({ root: v, lens: 'files', ...over }, async (b) => {
      b.tree.mockResolvedValue({ root: v, tree: (opts.nodes ?? FAV)(v), generatedAt: 1 } as never)
      b.favorites.get.mockResolvedValue((opts.favorites ?? []).map((p) => `${v}${p}`))
      b.favorites.onChanged.mockImplementation((l) => {
        emit = l
        return () => undefined
      })
      b.window.identity.mockResolvedValue({ id: 'w1', root: v, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: (opts.focusFavorites ?? []).map((p) => `${v}${p}`) })
      await storage.init()
    })
    return { ...m, v, emit: (c: { root: string }) => emit?.(c) }
  }

  const rowByPath = (el: HTMLElement, path: string) => el.querySelector<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)
  const rowsByPath = (el: HTMLElement, path: string) => [...el.querySelectorAll<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)]
  const rightClick = (target: Element | null) => act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  const shiftClickRow = (row: HTMLElement | null) => act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  const closeMenu = (el: HTMLElement) => act(() => void el.querySelector('.ctx-overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  const topLabels = (el: HTMLElement) => [...el.querySelectorAll('ul.tree[role="tree"] > li > .tree__row .tree__label')].map((n) => n.textContent)
  const bodyMsg = (el: HTMLElement) => el.querySelector('.sidebar__body .sidebar__msg')?.textContent ?? null
  const eye = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__focus-off')
  const isOpen = (el: HTMLElement, path: string) => rowByPath(el, path)?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')
  const pick = async (el: HTMLElement, path: string, label: string) => {
    rightClick(rowByPath(el, path))
    await act(async () => itemByLabel(el, label)?.click())
  }
  /** jsdom has no DragEvent: a MouseEvent with the row's edge in `clientY` (the zero rect reads `< 0` as "before"). */
  const drag = (target: Element | null | undefined, type: string, clientY = 0) =>
    act(() => void target?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY })))

  it('the tab is the second, and starts on the empty hint', async () => {
    const { el } = await mountVault({ lens: 'favorites' })
    expect([...el.querySelectorAll('.sidebar__lenses [role="tab"]')].map((b) => b.textContent || b.getAttribute('aria-label'))).toEqual(['Files', 'Favorites'])
    expect(bodyMsg(el)).toBe('No favorites yet. Right-click a file or folder → Add to favorites.')
    expect(el.querySelector('.tree')).toBeNull()
  })

  it('New drawing from a ROOT favorited FILE hops to Files — its parent dir is not on the tab; from a favorited FOLDER it stays put and the box opens there (3B1, S18)', async () => {
    const { el, v, props, bridge } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes/n.excalidraw', '/Projects'] })
    await pick(el, `${v}/Notes/n.excalidraw`, 'New Excalidraw drawing')
    expect(props.onLensChange).toHaveBeenCalledExactlyOnceWith('files')
    vi.mocked(props.onLensChange).mockClear()
    await pick(el, `${v}/Projects`, 'New Excalidraw drawing')
    expect(props.onLensChange).not.toHaveBeenCalled()
    const input = el.querySelector<HTMLInputElement>('.create-inline__input')!
    input.value = 'Plan'
    await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(bridge.createFile).toHaveBeenCalledExactlyOnceWith({ path: `${v}/Projects/Plan.excalidraw`, content: EMPTY_SCENE_JSON })
  })

  it('"Add to favorites" is on file AND folder rows in Files, never on blank space; adding toasts, persists to the vault file and lists the row on the tab', async () => {
    const { el, v, bridge, props, rerender } = await mountVault()
    rightClick(rowByPath(el, `${v}/top.excalidraw`))
    expect(itemByLabel(el, 'Add to favorites')).toBeDefined()
    closeMenu(el)
    rightClick(el.querySelector('.sidebar__body'))
    expect(itemByLabel(el, 'Add to favorites')).toBeUndefined()
    expect(itemByLabel(el, 'New Excalidraw drawing')).toBeDefined()
    closeMenu(el)
    await pick(el, `${v}/Projects`, 'Add to favorites')
    expect(props.onNotice).toHaveBeenCalledWith('Added to favorites', 'favorite')
    expect(bridge.favorites.set).toHaveBeenCalledWith(v, [`${v}/Projects`])
    expect(bridge.state.setFolder).not.toHaveBeenCalled() // vault content, not app state (D15)
    expect(bridge.window.setIdentity).not.toHaveBeenCalled() // nor window identity
    await rerender({ lens: 'favorites' })
    expect(topLabels(el)).toEqual(['Projects'])
    // The pinned row now reads Remove, on the Favorites tab and back on Files alike.
    rightClick(rowByPath(el, `${v}/Projects`))
    expect(itemByLabel(el, 'Remove from favorites')).toBeDefined()
    closeMenu(el)
    await rerender({ lens: 'files' })
    rightClick(rowByPath(el, `${v}/Projects`))
    expect(itemByLabel(el, 'Remove from favorites')).toBeDefined()
  })

  it('every favorites row carries the full row menu — Focus, Copy path, Rename, Open in, Delete', async () => {
    const { el, v } = await mountVault({ lens: 'favorites' }, { favorites: ['/Projects', '/top.excalidraw'] })
    rightClick(rowByPath(el, `${v}/Projects`))
    for (const label of ['Focus on folder', 'Cut', 'Copy', 'Copy path', 'New Excalidraw drawing', 'Rename', 'Remove from favorites', 'Open in', 'Delete']) expect(itemByLabel(el, label), label).toBeDefined()
    closeMenu(el)
    rightClick(rowByPath(el, `${v}/top.excalidraw`))
    // A FILE row keeps the rest of the menu and loses only the folder-shaped items.
    for (const label of ['Cut', 'Copy', 'Copy path', 'New Excalidraw drawing', 'Rename', 'Remove from favorites', 'Open in', 'Delete']) expect(itemByLabel(el, label), label).toBeDefined()
    expect(itemByLabel(el, 'Focus on folder')).toBeUndefined()
  })

  it('"Remove from favorites" drops the row, toasts, and persists the shorter list', async () => {
    const { el, v, bridge, props } = await mountVault({ lens: 'favorites' }, { favorites: ['/Projects', '/top.excalidraw'] })
    expect(topLabels(el)).toEqual(['Projects', 'top'])
    await pick(el, `${v}/Projects`, 'Remove from favorites')
    expect(topLabels(el)).toEqual(['top'])
    expect(props.onNotice).toHaveBeenCalledWith('Removed from favorites', 'favorite')
    expect(bridge.favorites.set).toHaveBeenLastCalledWith(v, [`${v}/top.excalidraw`])
  })

  it('a restored list renders in STORED order (not tree order) and is never written back', async () => {
    const { el, bridge } = await mountVault({ lens: 'favorites' }, { favorites: ['/top.excalidraw', '/Projects', '/Notes'] })
    expect(topLabels(el)).toEqual(['top', 'Projects', 'Notes'])
    expect(bridge.favorites.set).not.toHaveBeenCalled()
  })

  it('a favorited folder unfolds in place, and its fold is the Files tree\'s own (D7)', async () => {
    const { el, v, rerender } = await mountVault({ lens: 'favorites' }, { favorites: ['/Projects'] })
    expect(isOpen(el, `${v}/Projects`)).toBe('false')
    act(() => rowByPath(el, `${v}/Projects`)?.click())
    expect(isOpen(el, `${v}/Projects`)).toBe('true')
    expect(rowByPath(el, `${v}/Projects/p.excalidraw`)).not.toBeNull()
    await rerender({ lens: 'files' })
    expect(isOpen(el, `${v}/Projects`)).toBe('true')
  })

  it('redundancy: a file AND its parent folder both listed — the file at the root and again inside the folder', async () => {
    const { el, v } = await mountVault({ lens: 'favorites' }, { favorites: ['/Projects/p.excalidraw', '/Projects'] })
    expect(topLabels(el)).toEqual(['p', 'Projects'])
    act(() => rowByPath(el, `${v}/Projects`)?.click())
    expect(rowsByPath(el, `${v}/Projects/p.excalidraw`)).toHaveLength(2)
  })

  it('a 2-row selection reads "Add 2 to favorites" and pins both in panel order; a MIXED one reads Add and pins only the missing; all-pinned reads "Remove 2 from favorites"', async () => {
    const { el, v, bridge } = await mountVault()
    shiftClickRow(rowByPath(el, `${v}/Projects`))
    shiftClickRow(rowByPath(el, `${v}/Notes`))
    rightClick(rowByPath(el, `${v}/Notes`))
    await act(async () => itemByLabel(el, 'Add 2 to favorites')?.click())
    expect(bridge.favorites.set).toHaveBeenLastCalledWith(v, [`${v}/Notes`, `${v}/Projects`])
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    shiftClickRow(rowByPath(el, `${v}/Projects`)) // already pinned…
    shiftClickRow(rowByPath(el, `${v}/top.excalidraw`)) // …this one not
    rightClick(rowByPath(el, `${v}/top.excalidraw`))
    expect(itemByLabel(el, 'Add 2 to favorites')).toBeDefined()
    await act(async () => itemByLabel(el, 'Add 2 to favorites')?.click())
    expect(bridge.favorites.set).toHaveBeenLastCalledWith(v, [`${v}/Notes`, `${v}/Projects`, `${v}/top.excalidraw`])
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    shiftClickRow(rowByPath(el, `${v}/Notes`))
    shiftClickRow(rowByPath(el, `${v}/Projects`))
    rightClick(rowByPath(el, `${v}/Notes`))
    expect(itemByLabel(el, 'Remove 2 from favorites')).toBeDefined()
    await act(async () => itemByLabel(el, 'Remove 2 from favorites')?.click())
    expect(bridge.favorites.set).toHaveBeenLastCalledWith(v, [`${v}/top.excalidraw`])
  })

  it('Focus on the Favorites tab writes THIS window\'s focusFavorites — never focusDirs or the vault file — and the eye is lens-local', async () => {
    const { el, v, bridge, rerender } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes', '/Projects', '/top.excalidraw'] })
    await pick(el, `${v}/Projects`, 'Focus on folder')
    expect(topLabels(el)).toEqual(['Projects'])
    expect(isOpen(el, `${v}/Projects`)).toBe('true')
    expect(bridge.window.setIdentity).toHaveBeenCalledWith({ focusFavorites: [`${v}/Projects`] })
    expect(bridge.window.setIdentity).not.toHaveBeenCalledWith(expect.objectContaining({ focusDirs: expect.anything() }))
    expect(bridge.favorites.set).not.toHaveBeenCalled() // the fold it opened is the one write, and that is app state
    expect(eye(el)?.getAttribute('aria-label')).toBe('Exit focus mode')
    await rerender({ lens: 'files' })
    expect(eye(el)).toBeNull() // Files carries its own focus, and it is empty
    expect(topLabels(el)).toEqual(['Notes', 'Projects', 'top'])
    await rerender({ lens: 'favorites' })
    expect(eye(el)).not.toBeNull()
    await act(async () => eye(el)?.click())
    expect(eye(el)).toBeNull()
    expect(topLabels(el)).toEqual(['Notes', 'Projects', 'top'])
    expect(bridge.window.setIdentity).toHaveBeenLastCalledWith({ focusFavorites: [] })
  })

  it('a restored focusFavorites narrows the first render and is never written back', async () => {
    const { el, bridge } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes', '/Projects'], focusFavorites: ['/Notes'] })
    expect(topLabels(el)).toEqual(['Notes'])
    expect(eye(el)).not.toBeNull()
    expect(bridge.window.setIdentity).not.toHaveBeenCalled()
  })

  it('root rows drag to reorder: a drop indicator on the hovered edge, the new order persisted; nested rows do not drag; Files is untouched', async () => {
    const { el, v, bridge, props } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes', '/Projects', '/top.excalidraw'] })
    expect(rowByPath(el, `${v}/Notes`)?.getAttribute('draggable')).toBe('true')
    expect(rowByPath(el, `${v}/top.excalidraw`)?.getAttribute('draggable')).toBe('true')
    act(() => rowByPath(el, `${v}/Projects`)?.click())
    expect(rowByPath(el, `${v}/Projects/Alpha`)?.getAttribute('draggable')).toBe('false')
    expect(rowByPath(el, `${v}/Projects/p.excalidraw`)?.getAttribute('draggable')).toBe('false')
    drag(rowByPath(el, `${v}/top.excalidraw`), 'dragstart')
    drag(rowByPath(el, `${v}/Notes`), 'dragover', -1)
    expect(rowByPath(el, `${v}/Notes`)?.classList.contains('tree__row--drop-before')).toBe(true)
    drag(rowByPath(el, `${v}/Notes`), 'drop')
    expect(topLabels(el)).toEqual(['top', 'Notes', 'Projects'])
    expect(el.querySelector('.tree__row--drop-before, .tree__row--drop-after')).toBeNull()
    expect(bridge.favorites.set).toHaveBeenLastCalledWith(v, [`${v}/top.excalidraw`, `${v}/Notes`, `${v}/Projects`])
    // Below the midpoint lands AFTER; nothing moved on disk at any point.
    drag(rowByPath(el, `${v}/top.excalidraw`), 'dragstart')
    drag(rowByPath(el, `${v}/Projects`), 'dragover', 1)
    expect(rowByPath(el, `${v}/Projects`)?.classList.contains('tree__row--drop-after')).toBe(true)
    drag(rowByPath(el, `${v}/Projects`), 'drop')
    expect(topLabels(el)).toEqual(['Notes', 'Projects', 'top'])
    expect(props.onRenameFile).not.toHaveBeenCalled()
  })

  it('dragging a favorites row onto a nested folder moves nothing on disk, and dragend abandons cleanly', async () => {
    const { el, v, props } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes', '/Projects', '/top.excalidraw'] })
    act(() => rowByPath(el, `${v}/Projects`)?.click())
    drag(rowByPath(el, `${v}/top.excalidraw`), 'dragstart')
    drag(rowByPath(el, `${v}/Projects/Alpha`), 'dragover')
    expect(rowByPath(el, `${v}/Projects/Alpha`)?.classList.contains('tree__row--drop')).toBe(false)
    drag(rowByPath(el, `${v}/Projects/Alpha`), 'drop')
    expect(props.onRenameFile).not.toHaveBeenCalled()
    expect(topLabels(el)).toEqual(['Notes', 'Projects', 'top'])
    drag(rowByPath(el, `${v}/top.excalidraw`), 'dragstart')
    drag(rowByPath(el, `${v}/top.excalidraw`), 'dragend')
    drag(rowByPath(el, `${v}/Notes`), 'dragover', -1)
    expect(el.querySelector('.tree__row--drop-before')).toBeNull()
  })

  it('reorder is off while the tab is focused — the focus list is what is shown, not the favorites order', async () => {
    const { el, v, bridge } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes', '/Projects'], focusFavorites: ['/Notes', '/Projects'] })
    drag(rowByPath(el, `${v}/Projects`), 'dragstart')
    drag(rowByPath(el, `${v}/Notes`), 'dragover', -1)
    expect(el.querySelector('.tree__row--drop-before')).toBeNull()
    drag(rowByPath(el, `${v}/Notes`), 'drop')
    expect(topLabels(el)).toEqual(['Notes', 'Projects'])
    expect(bridge.favorites.set).not.toHaveBeenCalled()
  })

  it('another window\'s — or a synced — write lands through favorites:changed for THIS root: re-read, never re-written', async () => {
    const { el, v, bridge, emit } = await mountVault({ lens: 'favorites' })
    expect(bodyMsg(el)).not.toBeNull()
    const reads = bridge.favorites.get.mock.calls.length // the mount read (StrictMode runs the effect twice)
    await act(async () => emit({ root: '/some-other-vault' }))
    expect(bridge.favorites.get).toHaveBeenCalledTimes(reads) // another vault's change is not this window's
    bridge.favorites.get.mockResolvedValue([`${v}/top.excalidraw`])
    await act(async () => emit({ root: v }))
    expect(topLabels(el)).toEqual(['top'])
    expect(bridge.favorites.set).not.toHaveBeenCalled()
  })

  it('a refused write (a malformed favorites.json → INVALID_CONFIG, D12) reverts the list and toasts an error', async () => {
    const { el, v, bridge, props } = await mountVault({ lens: 'favorites' }, { favorites: ['/Notes'] })
    bridge.favorites.set.mockRejectedValueOnce({ code: 'INVALID_CONFIG', message: 'favorites.json is malformed; fix or delete it' })
    await pick(el, `${v}/Notes`, 'Remove from favorites')
    expect(bridge.favorites.set).toHaveBeenLastCalledWith(v, [])
    expect(topLabels(el)).toEqual(['Notes']) // reverted
    expect(props.onNotice).toHaveBeenCalledWith("Can't save favorites: favorites.json is malformed; fix or delete it", 'error')
  })

  it('a favorite the tree lacks (not synced yet, or gone) draws no row and is NOT pruned — no write (D14)', async () => {
    let fire: ((ev: WatchEvent) => void) | undefined
    const watch = { subscribe: (l: (ev: WatchEvent) => void) => ((fire = l), () => undefined) }
    const { el, v, bridge } = await mountVault({ lens: 'favorites', watch }, { favorites: ['/Ghost.excalidraw', '/Notes', '/Projects'] })
    fakeClock()
    expect(topLabels(el)).toEqual(['Notes', 'Projects'])
    bridge.tree.mockResolvedValue({ root: v, tree: FAV(v).filter((n) => n.path !== `${v}/Projects`), generatedAt: 2 } as never)
    await act(async () => fire?.({ type: 'unlinkDir', path: `${v}/Projects` }))
    await quiet()
    expect(topLabels(el)).toEqual(['Notes'])
    expect(bridge.favorites.set).not.toHaveBeenCalled()
  })

  it('expand / collapse all acts on the favorited folders only', async () => {
    const { el, v } = await mountVault({ lens: 'favorites' }, { favorites: ['/Projects'] })
    const all = el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__expand-all')
    expect(all?.getAttribute('aria-label')).toBe('Expand all')
    act(() => all?.click())
    expect(isOpen(el, `${v}/Projects`)).toBe('true')
    expect(isOpen(el, `${v}/Projects/Alpha`)).toBe('true')
    expect(storage.getExpanded(v)).not.toContain(`${v}/Notes`)
  })
})

describe('context menu order (GRO-2272 C1a)', () => {
  it('a FILE row renders utilities, then create actions, then Rename and Delete last', async () => {
    const { el } = await mount()
    act(() => void el.querySelector('.tree__row--file')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(menuItems(el).map((b) => b.textContent?.replace('▸', '').trim())).toEqual([
      // The Open group (🔒 D7 amended, YAZ-1674) is EMPTY on one file row — the OS verbs fold into
      // the "Open in ▸" flyout, which stands in its own group before Delete — so the clipboard leads.
      // The clipboard group: the file clipboard first (Paste is DISABLED, not hidden, while it is
      // empty — 🔒 YAZ-1674 D5), then the text clipboard. Hints are `data-hint`, so the text stays bare.
      'Cut',
      'Copy',
      'Paste',
      'Copy path',
      // The create group: the board births first, then the two folder births — every one
      // of them targets a DIRECTORY (the row's parent), never the row itself.
      'New Excalidraw drawing',
      'New dated Excalidraw drawing',
      'New draw.io diagram',
      'New folder',
      'New dated folder',
      // The act-on-this-row group, above the destructive pair, which stays last.
      'Rename',
      // The favorite toggle (YAZ-1766 D3) leads the "Open in ▸" group, one hairline above Delete.
      'Add to favorites',
      'Open in',
      // Share (YAZ-1799 D6), Version history (YAZ-1897 D4) and Info (🔒 YAZ-1835 D6) sit in Delete's group; Info stays right above it.
      'Share',
      'Version history',
      'Info',
      'Delete',
    ])
  })

  it('Delete is the LAST item wherever it appears', async () => {
    for (const row of ['.tree__row--file', '.tree__row--dir']) {
      const m = await mount()
      act(() => void m.el.querySelector(row)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
      const labels = menuItems(m.el).map((b) => b.textContent)
      expect(labels[labels.length - 1]).toBe('Delete')
    }
  })
})

/**
 * Multi-select (YAZ-1334 → YAZ-1336). Shift+click TOGGLES a file row in/out of a path-keyed
 * selection (🔒 YAZ-1336 D2 amended: toggle-accumulate, range is out of v1) — it never opens, never
 * previews. Selection is Sidebar-owned view state (🔒 YAZ-1336 D1): Escape and a lens switch clear it;
 * since D9 (YAZ-1674) a plain click — and ⌘-click's LOCKED background-open gesture (I3) — makes
 * it EXACTLY the clicked row, so every clipboard chord has a target the moment a row is clicked.
 */
describe('Sidebar multi-select via shift+click (YAZ-1336)', () => {
  const MULTI_TREE: TreeNode[] = [
    { type: 'dir', name: 'sub', path: '/v/sub', children: [] },
    { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    { type: 'file', name: 'b.excalidraw', path: '/v/b.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    { type: 'file', name: 'c.excalidraw', path: '/v/c.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
  ]
  const withMultiTree = (bridge: ReturnType<typeof installBridge>) =>
    bridge.tree.mockResolvedValue({ root: '/v', tree: MULTI_TREE, generatedAt: 1 })
  const rowByPath = (el: HTMLElement, path: string) =>
    el.querySelector<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)
  const shiftClick = (row: HTMLElement | null) =>
    act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  const selectedPaths = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLElement>('.tree__row--selected')].map((r) => r.dataset.path)

  it('shift+click toggles file rows into and out of the selection without opening anything', async () => {
    const { el, props } = await mount({}, withMultiTree)
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    shiftClick(rowByPath(el, '/v/b.excalidraw'))
    expect(selectedPaths(el)).toEqual(['/v/a.excalidraw', '/v/b.excalidraw'])
    expect(rowByPath(el, '/v/a.excalidraw')?.closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true')
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    expect(selectedPaths(el)).toEqual(['/v/b.excalidraw'])
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(props.onOpenFileBackground).not.toHaveBeenCalled()
  })

  it('plain click makes the selection EXACTLY the clicked file and opens it as before (D9, YAZ-1674)', async () => {
    const { el, props } = await mount({}, withMultiTree)
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    shiftClick(rowByPath(el, '/v/b.excalidraw'))
    act(() => rowByPath(el, '/v/c.excalidraw')?.click())
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/c.excalidraw')
    expect(selectedPaths(el)).toEqual(['/v/c.excalidraw'])
  })

  it('a click on the file ALREADY open only selects it — no re-open (D11, YAZ-1674)', async () => {
    // Click-then-⌘C must work on the open drawing too, so the click still makes it the selection.
    const { el, props } = await mount({ activeFile: '/v/a.excalidraw' }, withMultiTree)
    act(() => void rowByPath(el, '/v/a.excalidraw')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(selectedPaths(el)).toEqual(['/v/a.excalidraw'])
    // A second click is the same answer — the row never re-opens what is already active.
    act(() => void rowByPath(el, '/v/a.excalidraw')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(selectedPaths(el)).toEqual(['/v/a.excalidraw'])
  })

  it('⌘-click selects the clicked row too and still opens a background tab (LOCKED I3)', async () => {
    const { el, props } = await mount({}, withMultiTree)
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    act(() => void rowByPath(el, '/v/b.excalidraw')?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
    expect(props.onOpenFileBackground).toHaveBeenCalledExactlyOnceWith('/v/b.excalidraw')
    expect(selectedPaths(el)).toEqual(['/v/b.excalidraw'])
  })

  it('shift+click on a dir row toggles it in and out beside files — folders select too (YAZ-1578, 🔒 D1)', async () => {
    const { el, props } = await mount({}, withMultiTree)
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    shiftClick(rowByPath(el, '/v/sub'))
    expect(selectedPaths(el)).toEqual(['/v/sub', '/v/a.excalidraw']) // panel order, not click order
    expect(rowByPath(el, '/v/sub')?.closest('[role="treeitem"]')?.getAttribute('aria-selected')).toBe('true')
    shiftClick(rowByPath(el, '/v/sub'))
    expect(selectedPaths(el)).toEqual(['/v/a.excalidraw'])
    expect(props.onOpenFile).not.toHaveBeenCalled()
  })

  it('Escape clears the selection', async () => {
    const { el } = await mount({}, withMultiTree)
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    expect(selectedPaths(el)).toEqual(['/v/a.excalidraw'])
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(selectedPaths(el)).toEqual([])
  })

  it('switching lens clears the selection', async () => {
    const { el, rerender } = await mount({}, withMultiTree)
    shiftClick(rowByPath(el, '/v/a.excalidraw'))
    await rerender({ lens: 'favorites' })
    await rerender({ lens: 'files' })
    expect(selectedPaths(el)).toEqual([])
  })
})

/** The other two ways a selection ends (YAZ-1336), and the one press that must NOT be taken. */
describe('Sidebar multi-select: search, Escape-when-empty, and the prune', () => {
  const selectedRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.tree__row--selected')]
  const shiftClick = (row: HTMLElement | null) =>
    act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))

  it('a typed query ends it: the tree comes back with nothing selected', async () => {
    const { el } = await mount()
    shiftClick(fileRow(el))
    expect(selectedRows(el)).toHaveLength(1)
    // 🔒 the flat-list ruling (YAZ-739): a query REPLACES the tree, so a selection cannot survive
    // underneath it and be waiting when the query clears.
    await type(searchInput(el) as HTMLInputElement, 'a')
    expect(el.querySelector('.tree')).toBeNull()
    await type(searchInput(el) as HTMLInputElement, '')
    expect(el.querySelector('.tree')).not.toBeNull()
    expect(selectedRows(el)).toHaveLength(0)
  })

  it('Escape with NOTHING selected is left alone — the key still belongs to everyone else', async () => {
    const { el } = await mount()
    const body = el.querySelector('.sidebar__body') as HTMLElement
    const spare = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void body.dispatchEvent(spare))
    expect(spare.defaultPrevented).toBe(false)
    // With a selection standing it IS the selection's key: taken, not passed on.
    shiftClick(fileRow(el))
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void body.dispatchEvent(taken))
    expect(taken.defaultPrevented).toBe(true)
    expect(selectedRows(el)).toHaveLength(0)
  })

  it('a file that leaves the tree leaves the selection with it, and the rest stays selected', async () => {
    const A: TreeNode = { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' }
    const B: TreeNode = { type: 'file', name: 'b.excalidraw', path: '/v/b.excalidraw', size: 1, mtime: 1, kind: 'drawing' }
    let emit: ((ev: WatchEvent) => void) | undefined
    const watch = {
      subscribe: (l: (ev: WatchEvent) => void) => {
        emit = l
        return () => undefined
      },
    }
    const { el, bridge } = await mount({ watch }, (b) => b.tree.mockResolvedValue({ root: '/v', tree: [A, B], generatedAt: 1 }))
    fakeClock()
    for (const row of el.querySelectorAll<HTMLElement>('.tree__row--file')) shiftClick(row)
    expect(selectedRows(el)).toHaveLength(2)
    // b is deleted on disk: the watcher-driven refresh brings the tree that no longer has it.
    bridge.tree.mockResolvedValue({ root: '/v', tree: [A], generatedAt: 2 })
    await act(async () => emit?.({ type: 'unlink', path: '/v/b.excalidraw' }))
    await quiet()
    expect(selectedRows(el).map((r) => r.dataset.path)).toEqual(['/v/a.excalidraw'])
  })

  it('a refresh keeps a selected FOLDER that is still on disk and drops one that left (YAZ-1578)', async () => {
    const A: TreeNode = { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' }
    const KEPT: TreeNode = { type: 'dir', name: 'kept', path: '/v/kept', children: [] }
    const GONE: TreeNode = { type: 'dir', name: 'gone', path: '/v/gone', children: [] }
    let emit: ((ev: WatchEvent) => void) | undefined
    const watch = {
      subscribe: (l: (ev: WatchEvent) => void) => {
        emit = l
        return () => undefined
      },
    }
    const { el, bridge } = await mount({ watch }, (b) => b.tree.mockResolvedValue({ root: '/v', tree: [GONE, KEPT, A], generatedAt: 1 }))
    fakeClock()
    for (const row of el.querySelectorAll<HTMLElement>('.tree__row[data-path]')) shiftClick(row)
    expect(selectedRows(el)).toHaveLength(3)
    bridge.tree.mockResolvedValue({ root: '/v', tree: [KEPT, A], generatedAt: 2 })
    await act(async () => emit?.({ type: 'unlinkDir', path: '/v/gone' }))
    await quiet()
    expect(selectedRows(el).map((r) => r.dataset.path)).toEqual(['/v/kept', '/v/a.excalidraw'])
  })
})

/**
 * Multi-select context-menu actions (YAZ-1334 → YAZ-1337, 🔒 D5). Right-clicking a row that is
 * INSIDE a 2+ selection adds "Copy N paths" / "Open N in new tabs" ABOVE the singular items —
 * plural targets live in their OWN MenuTargets fields per the one-field-per-item doctrine.
 * Right-clicking outside the selection clears it; blank space leaves it alone. Copied paths come
 * out in VISIBLE tree order (not click order), newline-joined, deduped by construction.
 */
describe('Sidebar multi-select context menu (YAZ-1337)', () => {
  const MULTI_TREE: TreeNode[] = [
    { type: 'dir', name: 'sub', path: '/v/sub', children: [] },
    { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    { type: 'file', name: 'b.excalidraw', path: '/v/b.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    { type: 'file', name: 'c.excalidraw', path: '/v/c.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
  ]
  const withMultiTree = (bridge: ReturnType<typeof installBridge>) =>
    bridge.tree.mockResolvedValue({ root: '/v', tree: MULTI_TREE, generatedAt: 1 })
  const rowByPath = (el: HTMLElement, path: string) =>
    el.querySelector<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)
  const shiftClickRow = (row: HTMLElement | null) =>
    act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  const rightClick = (target: Element | null) =>
    act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  const selectedCount = (el: HTMLElement) => el.querySelectorAll('.tree__row--selected').length
  function installClipboard() {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return writeText
  }

  it('right-click inside a 2-selection: "Open 2 in new tabs" LEADS, "Copy 2 paths" leads the clipboard group; copy is VISIBLE order, selection survives', async () => {
    const writeText = installClipboard()
    const { el, props } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/c.excalidraw')) // click order c → a…
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    const labels = menuItems(el).map((b) => b.textContent)
    // 🔒 D7 (YAZ-1674) loosens YAZ-1337's "the plural pair leads": the plural OPEN still leads the
    // whole menu, but the plural COPY now sits in the clipboard group, below the Open group —
    // directly above the singular "Copy path", which it still leads.
    expect(labels[0]).toBe('Open 2 in new tabs')
    expect(labels.indexOf('Copy 2 paths')).toBeGreaterThan(labels.indexOf('Open 2 in new tabs'))
    expect(labels.indexOf('Copy 2 paths')).toBe(labels.indexOf('Copy path') - 1)
    expect(labels).toContain('Open 2 in new tabs')
    expect(labels).toContain('Copy path') // singular items still target the clicked row
    act(() => itemByLabel(el, 'Copy 2 paths')?.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith('/v/a.excalidraw\n/v/c.excalidraw') // …but tree order out
    expect(el.querySelector('.ctx-menu')).toBeNull()
    expect(selectedCount(el)).toBe(2)
    await act(async () => {})
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Copied 2 paths') // YAZ-1341: a copy SAYS SO
  })

  it('the singular "Copy path" confirms too — every copy speaks with the one voice (YAZ-1341)', async () => {
    installClipboard()
    const { el, props } = await mount({}, withMultiTree)
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    act(() => itemByLabel(el, 'Copy path')?.click())
    await act(async () => {})
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Copied path')
  })

  it('"Open N in new tabs" background-opens every selected path and keeps the selection', async () => {
    const { el, props } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/b.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/c.excalidraw'))
    rightClick(rowByPath(el, '/v/b.excalidraw'))
    act(() => itemByLabel(el, 'Open 3 in new tabs')?.click())
    expect(props.onOpenFileBackground).toHaveBeenCalledTimes(3)
    expect((props.onOpenFileBackground as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'])
    expect(props.onOpenFile).not.toHaveBeenCalled()
    expect(el.querySelector('.ctx-menu')).toBeNull()
    expect(selectedCount(el)).toBe(3)
  })

  it('a 1-selection gets no plural items — the singular menu already is that menu', async () => {
    const { el } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    expect(itemByLabel(el, 'Copy 1 paths')).toBeUndefined()
    expect(itemByLabel(el, 'Copy 1 path')).toBeUndefined()
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
  })

  it('right-click on a row OUTSIDE the selection SELECTS that row (D9, Finder) and shows the ordinary menu', async () => {
    const { el } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/b.excalidraw'))
    rightClick(rowByPath(el, '/v/c.excalidraw'))
    expect(itemByLabel(el, 'Copy 2 paths')).toBeUndefined()
    expect(itemByLabel(el, 'Copy path')).toBeDefined()
    expect(selectedCount(el)).toBe(1)
    expect(rowByPath(el, '/v/c.excalidraw')?.classList.contains('tree__row--selected')).toBe(true)
  })

  it('right-click on blank space leaves the selection alone and stays plural-free', async () => {
    const { el } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/b.excalidraw'))
    rightClick(el.querySelector('.sidebar__body'))
    expect(itemByLabel(el, 'Copy 2 paths')).toBeUndefined()
    expect(itemByLabel(el, 'New Excalidraw drawing')).toBeDefined()
    expect(selectedCount(el)).toBe(2)
  })

  // ---- Mixed selections (YAZ-1578, 🔒 D3): folders copy, only files open ----

  it('right-click a selected FOLDER in a mixed selection: "Copy N paths" lists all N, "Open N in new tabs" opens only the files', async () => {
    const writeText = installClipboard()
    const { el, props } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/b.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/sub'))
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    rightClick(rowByPath(el, '/v/sub'))
    expect(itemByLabel(el, 'Copy 3 paths')).toBeDefined()
    expect(itemByLabel(el, 'Open 2 in new tabs')).toBeDefined()
    expect(itemByLabel(el, 'Copy path')).toBeDefined() // the singular items still target the folder
    act(() => itemByLabel(el, 'Copy 3 paths')?.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith('/v/sub\n/v/a.excalidraw\n/v/b.excalidraw') // panel order
    rightClick(rowByPath(el, '/v/sub'))
    act(() => itemByLabel(el, 'Open 2 in new tabs')?.click())
    expect(props.onOpenFileBackground).toHaveBeenCalledTimes(2)
    expect(props.onOpenFileBackground).toHaveBeenNthCalledWith(1, '/v/a.excalidraw')
    expect(props.onOpenFileBackground).toHaveBeenNthCalledWith(2, '/v/b.excalidraw')
    expect(selectedCount(el)).toBe(3)
  })

  it('a folders-only selection offers "Copy N paths" and no "Open … in new tabs"', async () => {
    const TWO_DIRS: TreeNode[] = [
      { type: 'dir', name: 'one', path: '/v/one', children: [] },
      { type: 'dir', name: 'two', path: '/v/two', children: [] },
      { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    ]
    const { el } = await mount({}, (b) => b.tree.mockResolvedValue({ root: '/v', tree: TWO_DIRS, generatedAt: 1 }))
    shiftClickRow(rowByPath(el, '/v/one'))
    shiftClickRow(rowByPath(el, '/v/two'))
    rightClick(rowByPath(el, '/v/two'))
    expect(itemByLabel(el, 'Copy 2 paths')).toBeDefined()
    expect(menuItems(el).map((b) => b.textContent).some((t) => /in new tabs$/.test(t ?? ''))).toBe(false)
  })

  // ---- Polish pins (YAZ-1340): shift means selection EVERYWHERE, and one Escape does one thing ----

  it('shift+click on a dir row selects it and never folds it; a plain click folds it and selects it (YAZ-1578 🔒 D1; D9 YAZ-1674 supersedes its D4)', async () => {
    // Expansion PERSISTS per root across mounts in this file (storage-backed), so this test
    // assumes nothing about the starting state and puts it back the way it found it.
    const { el } = await mount({}, withMultiTree)
    const dirRow = () => el.querySelector<HTMLButtonElement>('.tree__row--dir')
    const expandedNow = () => dirRow()?.closest('[role="treeitem"]')?.getAttribute('aria-expanded')
    const before = expandedNow()
    shiftClickRow(dirRow())
    expect(expandedNow()).toBe(before) // shift never folds…
    expect(selectedCount(el)).toBe(1) // …it selects the folder
    act(() => dirRow()?.click())
    expect(expandedNow()).not.toBe(before) // a plain click still folds…
    expect(selectedCount(el)).toBe(1) // …and the folder is the selection (D9: it was already, so nothing changes)
    act(() => dirRow()?.click())
    expect(expandedNow()).toBe(before)
  })

  it('Escape with the context menu open closes the MENU and leaves the selection standing', async () => {
    const { el } = await mount({}, withMultiTree)
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/b.excalidraw'))
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    expect(itemByLabel(el, 'Copy 2 paths')).toBeDefined()
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(el.querySelector('.ctx-menu')).toBeNull()
    expect(selectedCount(el)).toBe(2)
  })
})

/**
 * The plural items' harder halves (YAZ-1337): a clipboard the OS refuses has to be reported, not
 * swallowed, and a right-click that lands OUTSIDE the selection re-picks the row it landed on.
 */
describe('Sidebar multi-select context menu: the copy failure (YAZ-1337)', () => {
  const shiftClickRow = (row: HTMLElement | undefined) =>
    act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  const rightClick = (target: Element | null | undefined) =>
    act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))

  it('a clipboard the OS refuses is REPORTED through the panel notice, never swallowed', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('DENIED')
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const MULTI: TreeNode[] = [
      { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
      { type: 'file', name: 'b.excalidraw', path: '/v/b.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    ]
    const { el, props } = await mount({}, (b) => b.tree.mockResolvedValue({ root: '/v', tree: MULTI, generatedAt: 1 }))
    for (const row of el.querySelectorAll<HTMLElement>('.tree__row--file')) shiftClickRow(row)
    rightClick(el.querySelector('.tree__row[data-path="/v/a.excalidraw"]'))
    await act(async () => itemByLabel(el, 'Copy 2 paths')?.click())
    expect(props.onNotice).toHaveBeenCalledWith("Can't copy paths: DENIED")
  })

  it('a right-click on a DIR row outside the selection makes the selection THAT folder (D9)', async () => {
    const TREE_WITH_DIR: TreeNode[] = [
      { type: 'dir', name: 'sub', path: '/v/sub', children: [] },
      { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
      { type: 'file', name: 'b.excalidraw', path: '/v/b.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    ]
    const { el } = await mount({}, (b) => b.tree.mockResolvedValue({ root: '/v', tree: TREE_WITH_DIR, generatedAt: 1 }))
    for (const row of el.querySelectorAll<HTMLElement>('.tree__row--file')) shiftClickRow(row)
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(2)
    rightClick(el.querySelector('.tree__row--dir'))
    expect([...el.querySelectorAll<HTMLElement>('.tree__row--selected')].map((r) => r.dataset.path)).toEqual(['/v/sub'])
    expect(itemByLabel(el, 'Copy 2 paths')).toBeUndefined()
    expect(itemByLabel(el, 'New folder')).toBeDefined() // …and the dir's own ordinary menu stands
  })
})

/**
 * ⚡ Fable's ruling on YAZ-1338, at the panel: THE SELECTION IS THE TRUTH, THE DOM IS ONLY THE
 * ORDER. Folding a folder over a selected drawing hides its ROW; it stays picked, so N keeps
 * counting it and the copy keeps carrying it — after the paths still on screen.
 */
describe('Sidebar multi-select: folded rows (YAZ-1338)', () => {
  const NESTED: TreeNode[] = [
    { type: 'dir', name: 'sub', path: '/v/sub', children: [{ type: 'file', name: 'b.excalidraw', path: '/v/sub/b.excalidraw', size: 1, mtime: 1, kind: 'drawing' }] },
    { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
  ]
  const withNested = (bridge: ReturnType<typeof installBridge>) => bridge.tree.mockResolvedValue({ root: '/v', tree: NESTED, generatedAt: 1 })
  const rowByPath = (el: HTMLElement, path: string) => el.querySelector<HTMLElement>(`.tree__row[data-path="${path}"]`)
  const shiftClickRow = (row: HTMLElement | null) =>
    act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  /**
   * Expand / Collapse all (⚡ YAZ-862) is the fold gesture here: since D9 (YAZ-1674) a plain click
   * on the folder row would make the selection THAT folder, and this test is about a pick that
   * survives its row disappearing — the all-button folds without touching the selection.
   */
  const foldAll = (el: HTMLElement) => act(() => el.querySelector<HTMLButtonElement>('.sidebar__lenses .sidebar__expand-all')?.click())
  const rightClickRow = (row: HTMLElement | null) =>
    act(() => void row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))

  it('a selected drawing inside a folder the user then FOLDS still counts, and copies after the visible ones', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { el } = await mount({}, withNested)
    // Expansion persists per root across mounts in this file, so ENSURE the states rather than
    // toggling blind — this test must not care what its neighbours left behind.
    if (rowByPath(el, '/v/sub/b.excalidraw') === null) foldAll(el) // "Expand all": open `sub` so its drawing has a row to pick
    shiftClickRow(rowByPath(el, '/v/sub/b.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    foldAll(el) // "Collapse all": the row goes, the pick does not
    expect(rowByPath(el, '/v/sub/b.excalidraw')).toBeNull()
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(1)
    rightClickRow(rowByPath(el, '/v/a.excalidraw'))
    expect(itemByLabel(el, 'Copy 2 paths')).toBeDefined() // N is the SELECTION's size, not the DOM's
    act(() => itemByLabel(el, 'Copy 2 paths')?.click())
    expect(writeText).toHaveBeenCalledExactlyOnceWith('/v/a.excalidraw\n/v/sub/b.excalidraw')
  })

})

describe('settings cog (YAZ-1679)', () => {
  it('the footer cog only asks App for the dialog — the sidebar edits no setting itself', async () => {
    const { el, props } = await mount()
    act(() => el.querySelector<HTMLButtonElement>('.settings-button')?.click())
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(props.onChangeSettings).not.toHaveBeenCalled()
  })
})

/**
 * Cut / Copy / Paste (YAZ-1674): the menu items (🔒 D5) and the chords (D6) both hand the ORDERED
 * selection to main's one app-wide clipboard (🔒 YAZ-1674 D1) over `file.clip`, and Paste goes to the menu's
 * `targetDir` — or, from ⌘V, beside the first selected row — over `file.paste`. "Paste N items"
 * reads the `clip:changed` push, so a copy in ANOTHER window labels this one's menu.
 */
describe('Cut / Copy / Paste (YAZ-1674)', () => {
  type ClipState = { count: number; op: 'copy' | 'cut' } | null
  const MULTI_TREE: TreeNode[] = [
    { type: 'dir', name: 'sub', path: '/v/sub', children: [] },
    { type: 'file', name: 'a.excalidraw', path: '/v/a.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    { type: 'file', name: 'c.excalidraw', path: '/v/c.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
  ]
  /** The bridge's clipboard push, captured so a test can play "another window just copied". */
  let pushClip: ((state: ClipState) => void) | null = null
  const withClipboard = (bridge: ReturnType<typeof installBridge>) => {
    bridge.tree.mockResolvedValue({ root: '/v', tree: MULTI_TREE, generatedAt: 1 })
    bridge.file.onClipChanged.mockImplementation((listener) => {
      pushClip = listener
      return () => undefined
    })
  }
  const rowByPath = (el: HTMLElement, path: string) => el.querySelector<HTMLButtonElement>(`.tree__row[data-path="${path}"]`)
  const shiftClickRow = (row: HTMLElement | null) => act(() => void row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  const rightClick = (target: Element | null) => act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  const body = (el: HTMLElement) => el.querySelector('.sidebar__body')

  beforeEach(() => {
    pushClip = null
  })

  it('a row offers Cut and Copy with their hints, and a DISABLED Paste while the clipboard is empty (🔒 YAZ-1674 D5)', async () => {
    const { el } = await mount({}, withClipboard)
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    expect(itemByLabel(el, 'Cut')?.getAttribute('data-hint')).toBe('⌘X')
    expect(itemByLabel(el, 'Copy')?.getAttribute('data-hint')).toBe('⌘C')
    const paste = itemByLabel(el, 'Paste')
    expect(paste?.disabled).toBe(true)
    expect(paste?.getAttribute('data-hint')).toBe('⌘V')
    // Five groups drawn on one drawing row: clipboard, create, this-row, "Open in" alone, Delete —
    // the Open group is empty here (no plural open, nothing to focus) and the renderer skips it.
    expect(el.querySelectorAll('.ctx-menu__group')).toHaveLength(5)
  })

  it('blank space offers no Cut / Copy (nothing to clip) but keeps the disabled Paste — the root is a paste target', async () => {
    const { el } = await mount({}, withClipboard)
    rightClick(body(el))
    expect(itemByLabel(el, 'Cut')).toBeUndefined()
    expect(itemByLabel(el, 'Copy')).toBeUndefined()
    expect(itemByLabel(el, 'Paste')?.disabled).toBe(true)
    // No row to rename or delete: clipboard, create, and the root's own "Open in" — three groups.
    expect(el.querySelectorAll('.ctx-menu__group')).toHaveLength(3)
  })

  it('Cut on a single row clips that one path and SAYS SO (YAZ-1341); the menu closes', async () => {
    const { el, bridge, props } = await mount({}, withClipboard)
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    await act(async () => itemByLabel(el, 'Cut')?.click())
    expect(bridge.file.clip).toHaveBeenCalledExactlyOnceWith({ paths: ['/v/a.excalidraw'], op: 'cut' })
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Cut 1 item', 'cut')
    expect(el.querySelector('.ctx-menu')).toBeNull()
  })

  it('inside a 2-selection the items count it — "Copy 2 items" — and clip the ORDERED selection, which stands', async () => {
    const { el, bridge, props } = await mount({}, withClipboard)
    shiftClickRow(rowByPath(el, '/v/c.excalidraw')) // click order c → a…
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    expect(itemByLabel(el, 'Cut 2 items')).toBeDefined()
    await act(async () => itemByLabel(el, 'Copy 2 items')?.click())
    expect(bridge.file.clip).toHaveBeenCalledExactlyOnceWith({ paths: ['/v/a.excalidraw', '/v/c.excalidraw'], op: 'copy' }) // …tree order out
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Copied 2 items', 'copy')
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(2)
  })

  it('a clipboard push labels Paste "Paste 2 items"; clicking it pastes into the row\'s targetDir, refreshes and reports', async () => {
    const { el, bridge, props } = await mount({}, withClipboard)
    bridge.file.paste.mockResolvedValue({ pasted: [{ from: '/w/x.excalidraw', to: '/v/sub/x.excalidraw', kind: 'file' }, { from: '/w/y.excalidraw', to: '/v/sub/y.excalidraw', kind: 'file' }], failed: [] })
    const treeReads = bridge.tree.mock.calls.length
    act(() => pushClip?.({ count: 2, op: 'copy' }))
    rightClick(rowByPath(el, '/v/sub'))
    const paste = itemByLabel(el, 'Paste 2 items')
    expect(paste?.disabled).toBe(false)
    await act(async () => paste?.click())
    expect(bridge.file.paste).toHaveBeenCalledExactlyOnceWith({ targetDir: '/v/sub' })
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Pasted 2 items', 'paste')
    expect(bridge.tree.mock.calls.length).toBe(treeReads + 1) // the explicit refresh: a copy broadcasts nothing
  })

  it('a FILE row pastes into its PARENT (the "New drawing" rule), and per-entry failures are counted and named', async () => {
    const { el, bridge, props } = await mount({}, withClipboard)
    bridge.file.paste.mockResolvedValue({ pasted: [{ from: '/w/x.excalidraw', to: '/v/x.excalidraw', kind: 'file' }], failed: [{ from: '/w/Note.excalidraw', code: 'ALREADY_EXISTS', message: 'already exists' }] })
    act(() => pushClip?.({ count: 2, op: 'cut' }))
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    await act(async () => itemByLabel(el, 'Paste 2 items')?.click())
    expect(bridge.file.paste).toHaveBeenCalledExactlyOnceWith({ targetDir: '/v' })
    expect(props.onNotice).toHaveBeenCalledExactlyOnceWith('Pasted 1 item, skipped 1: Note.excalidraw — already exists', 'paste')
  })

  it('nothing pasted → "Couldn\'t paste: …"; a rejected paste → a notice, never a throw', async () => {
    const { el, bridge, props } = await mount({}, withClipboard)
    bridge.file.paste.mockResolvedValueOnce({ pasted: [], failed: [{ from: '/w/Note.excalidraw', code: 'NOT_FOUND', message: 'gone' }] })
    act(() => pushClip?.({ count: 1, op: 'copy' }))
    rightClick(body(el))
    await act(async () => itemByLabel(el, 'Paste 1 item')?.click())
    expect(props.onNotice).toHaveBeenLastCalledWith("Couldn't paste: Note.excalidraw — gone", 'error')
    bridge.file.paste.mockRejectedValueOnce({ code: 'NOT_FOUND', message: 'target dir is gone' })
    rightClick(body(el))
    await act(async () => itemByLabel(el, 'Paste 1 item')?.click())
    expect(props.onNotice).toHaveBeenLastCalledWith("Can't paste: target dir is gone", 'error')
  })

  it('a window opened AFTER a clip reads the clipboard ONCE on mount: Paste is labelled and enabled from the start', async () => {
    const { el, bridge } = await mount({}, (bridge) => {
      withClipboard(bridge)
      bridge.file.clipState.mockResolvedValue({ count: 2, op: 'copy' })
    })
    expect(bridge.file.clipState).toHaveBeenCalled()
    rightClick(rowByPath(el, '/v/sub'))
    expect(itemByLabel(el, 'Paste 2 items')?.disabled).toBe(false)
  })

  it('a push that lands while the mount read is in flight WINS over the read', async () => {
    let settle: ((state: { count: number; op: 'copy' | 'cut' } | null) => void) | null = null
    const { el, bridge } = await mount({}, (bridge) => {
      withClipboard(bridge)
      bridge.file.clipState.mockImplementation(() => new Promise((resolve) => (settle = resolve)))
    })
    expect(bridge.file.clipState).toHaveBeenCalled()
    act(() => pushClip?.({ count: 3, op: 'cut' }))
    await act(async () => settle?.({ count: 1, op: 'copy' }))
    rightClick(rowByPath(el, '/v/sub'))
    expect(itemByLabel(el, 'Paste 3 items')).toBeDefined()
  })

  // ---- The chords' handle (D6 amended): App's window listener asks these; the RULES are here ----

  /** A box App would hold; the Sidebar fills it every render and empties it on unmount. */
  const box = () => ({ current: null as SidebarClipboard | null })
  const verb = (ref: { current: SidebarClipboard | null }, op: 'copy' | 'cut' | 'paste') =>
    op === 'paste' ? (ref.current?.paste() ?? false) : (ref.current?.cutOrCopy(op) ?? false)

  it('cutOrCopy with a selection clips the ORDERED paths and answers true; the cut is the same call with its op', async () => {
    const clipboardRef = box()
    const { el, bridge } = await mount({ clipboardRef }, withClipboard)
    shiftClickRow(rowByPath(el, '/v/c.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    expect(verb(clipboardRef, 'copy')).toBe(true)
    expect(bridge.file.clip).toHaveBeenCalledExactlyOnceWith({ paths: ['/v/a.excalidraw', '/v/c.excalidraw'], op: 'copy' })
    expect(verb(clipboardRef, 'cut')).toBe(true)
    expect(bridge.file.clip).toHaveBeenLastCalledWith({ paths: ['/v/a.excalidraw', '/v/c.excalidraw'], op: 'cut' })
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(2) // the selection stands
  })

  it('with NO selection cutOrCopy answers false and clips nothing — the key is not ours', async () => {
    const clipboardRef = box()
    const { bridge } = await mount({ clipboardRef }, withClipboard)
    expect(verb(clipboardRef, 'copy')).toBe(false)
    expect(bridge.file.clip).not.toHaveBeenCalled()
  })

  it('paste answers false with an empty clipboard; with one it pastes beside the FIRST selected row — a folder → into it, a file → its parent, none → the root', async () => {
    const clipboardRef = box()
    const { el, bridge } = await mount({ clipboardRef }, withClipboard)
    expect(verb(clipboardRef, 'paste')).toBe(false)
    expect(bridge.file.paste).not.toHaveBeenCalled()
    act(() => pushClip?.({ count: 1, op: 'copy' }))
    await act(async () => void verb(clipboardRef, 'paste'))
    expect(bridge.file.paste).toHaveBeenLastCalledWith({ targetDir: '/v' })
    shiftClickRow(rowByPath(el, '/v/sub'))
    await act(async () => void verb(clipboardRef, 'paste'))
    expect(bridge.file.paste).toHaveBeenLastCalledWith({ targetDir: '/v/sub' })
    act(() => void body(el)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    await act(async () => void verb(clipboardRef, 'paste'))
    expect(bridge.file.paste).toHaveBeenLastCalledWith({ targetDir: '/v' })
    expect(bridge.file.paste).toHaveBeenCalledTimes(3)
  })

  it('an open context menu owns the verbs: both answer false while it stands', async () => {
    const clipboardRef = box()
    const { el, bridge } = await mount({ clipboardRef }, withClipboard)
    act(() => pushClip?.({ count: 1, op: 'copy' }))
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    rightClick(rowByPath(el, '/v/a.excalidraw'))
    expect(verb(clipboardRef, 'copy')).toBe(false)
    expect(verb(clipboardRef, 'paste')).toBe(false)
    expect(bridge.file.clip).not.toHaveBeenCalled()
    expect(bridge.file.paste).not.toHaveBeenCalled()
  })

  it('the handle is emptied on unmount — a collapsed sidebar has no verbs to offer', async () => {
    const clipboardRef = box()
    await mount({ clipboardRef }, withClipboard)
    expect(clipboardRef.current).not.toBeNull()
    act(() => root?.unmount())
    root = null
    expect(clipboardRef.current).toBeNull()
  })

  it('D9: a plain click on a file, then copy, clips exactly that file', async () => {
    const clipboardRef = box()
    const { el, bridge, props } = await mount({ clipboardRef }, withClipboard)
    act(() => rowByPath(el, '/v/a.excalidraw')?.click())
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('/v/a.excalidraw')
    expect(verb(clipboardRef, 'copy')).toBe(true)
    expect(bridge.file.clip).toHaveBeenCalledExactlyOnceWith({ paths: ['/v/a.excalidraw'], op: 'copy' })
  })

  it('D9: a plain click on a FOLDER selects it, so paste goes INTO it', async () => {
    const clipboardRef = box()
    const { el, bridge } = await mount({ clipboardRef }, withClipboard)
    act(() => pushClip?.({ count: 1, op: 'copy' }))
    act(() => rowByPath(el, '/v/sub')?.click())
    await act(async () => void verb(clipboardRef, 'paste'))
    expect(bridge.file.paste).toHaveBeenCalledExactlyOnceWith({ targetDir: '/v/sub' })
    act(() => rowByPath(el, '/v/sub')?.click()) // fold it back the way it was found
  })

  it('a plain LEFT click on BLANK SPACE clears the selection, so paste goes to the ROOT; a right-click there keeps it (YAZ-1337)', async () => {
    const clipboardRef = box()
    const { el, bridge } = await mount({ clipboardRef }, withClipboard)
    act(() => pushClip?.({ count: 1, op: 'copy' }))
    act(() => rowByPath(el, '/v/sub')?.click())
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(1)
    act(() => void body(el)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 })))
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(1) // a right-click is not a pick
    act(() => void body(el)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(0)
    await act(async () => void verb(clipboardRef, 'paste'))
    expect(bridge.file.paste).toHaveBeenCalledExactlyOnceWith({ targetDir: '/v' })
    act(() => rowByPath(el, '/v/sub')?.click()) // fold it back the way it was found
  })

  it('a LEFT mousedown ON a row is the row\'s own gesture — it never clears through the body', async () => {
    const { el } = await mount({}, withClipboard)
    shiftClickRow(rowByPath(el, '/v/a.excalidraw'))
    shiftClickRow(rowByPath(el, '/v/c.excalidraw'))
    act(() => void rowByPath(el, '/v/a.excalidraw')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(2)
  })
})

/**
 * The sort control (🔒 YAZ-1835 D1–D5): a header button on the Files lens opening the three-item
 * menu; the order is a VIEW applied to the rows, remembered per vault through `storage`, followed
 * across windows through the store's subscription, and a watcher `change` event (a save) refreshes
 * the tree so a saved board can rise.
 */
const SORTABLE: TreeNode[] = [
  // Inside `sub`, name order and date order DISAGREE, so a recursion test can tell them apart.
  { type: 'dir', name: 'sub', path: '/v/sub', children: [{ type: 'file', name: 'a-first.excalidraw', path: '/v/sub/a-first.excalidraw', size: 1, mtime: 1, kind: 'drawing', meta: { createdAt: 1, updatedAt: 1 } }, { type: 'file', name: 'b-second.excalidraw', path: '/v/sub/b-second.excalidraw', size: 1, mtime: 1, kind: 'drawing', meta: { createdAt: 2, updatedAt: 2 } }] },
  { type: 'file', name: 'Apple.excalidraw', path: '/v/Apple.excalidraw', size: 1, mtime: 10, kind: 'drawing', meta: { createdAt: 400, updatedAt: 900 } },
  { type: 'file', name: 'Banana.excalidraw', path: '/v/Banana.excalidraw', size: 1, mtime: 10, kind: 'drawing', meta: { createdAt: 990, updatedAt: 991 } },
  { type: 'file', name: 'Cherry.excalidraw', path: '/v/Cherry.excalidraw', size: 1, mtime: 10, kind: 'drawing', meta: { createdAt: 300, updatedAt: 950 } },
  { type: 'file', name: 'notes.txt', path: '/v/notes.txt', size: 1, mtime: 5, kind: null },
]
/** The visible board rows, top level only unless asked — the real `storage` keeps `sub` expanded across mounts. */
const rowPaths = (el: HTMLElement, nested = false) => [...el.querySelectorAll<HTMLElement>('.tree__row--file')].map((r) => (r.dataset.path ?? '').replace('/v/', '')).filter((p) => nested || !p.includes('/'))
const sortButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__sort')
const mountSortable = (over: Partial<SidebarProps> = {}) => mount(over, (b) => b.tree.mockResolvedValue({ root: '/v', tree: SORTABLE, generatedAt: 1 }))

describe('sort control (🔒 YAZ-1835)', () => {
  it('shows on the Files lens, not on Favorites and not while a query is typed; the tree starts in name order', async () => {
    const { el } = await mountSortable()
    expect(sortButton(el)?.getAttribute('aria-label')).toBe('Sort by Name')
    expect(rowPaths(el)).toEqual(['Apple.excalidraw', 'Banana.excalidraw', 'Cherry.excalidraw', 'notes.txt'])
    const input = searchInput(el)
    if (input === null) throw new Error('no search input')
    await type(input, 'a')
    expect(sortButton(el)).toBeNull()
    await type(input, '')
    expect(sortButton(el)).not.toBeNull()
    const fav = await mountSortable({ lens: 'favorites' })
    expect(sortButton(fav.el)).toBeNull()
  })

  it('opens a three-item menu with a check on the current order; picking one reorders the rows and writes the vault`s sortOrder', async () => {
    const { el, bridge } = await mountSortable()
    act(() => sortButton(el)?.click())
    const items = menuItems(el)
    expect(items.map((b) => b.textContent)).toEqual(['Name', 'Last updated', 'Created'])
    expect(items.map((b) => b.dataset.hint ?? '')).toEqual(['✓', '', ''])
    await act(async () => itemByLabel(el, 'Last updated')?.click())
    expect(rowPaths(el)).toEqual(['Banana.excalidraw', 'Cherry.excalidraw', 'Apple.excalidraw', 'notes.txt'])
    expect(bridge.state.setFolder).toHaveBeenLastCalledWith('/v', { sortOrder: 'updated' })
    expect(sortButton(el)?.getAttribute('aria-label')).toBe('Sort by Last updated')
    expect(menuItems(el)).toEqual([]) // the menu closed on select
    act(() => sortButton(el)?.click())
    await act(async () => itemByLabel(el, 'Created')?.click())
    expect(rowPaths(el)).toEqual(['Banana.excalidraw', 'Apple.excalidraw', 'Cherry.excalidraw', 'notes.txt'])
  })

  it('folder contents follow the order once the folder is open', async () => {
    vi.spyOn(storage, 'getSortOrder').mockReturnValue('name') // the real `storage` still holds the previous test's pick
    const { el } = await mountSortable()
    act(() => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click())
    expect(rowPaths(el, true).slice(0, 2)).toEqual(['sub/a-first.excalidraw', 'sub/b-second.excalidraw'])
    act(() => sortButton(el)?.click())
    await act(async () => itemByLabel(el, 'Last updated')?.click())
    expect(rowPaths(el, true).slice(0, 2)).toEqual(['sub/b-second.excalidraw', 'sub/a-first.excalidraw'])
    act(() => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click()) // fold it back: `storage` remembers expansion across mounts
  })

  it('starts on the order the vault remembers, and follows another window`s change through the store', async () => {
    const get = vi.spyOn(storage, 'getSortOrder').mockReturnValue('updated')
    let wake: (() => void) | null = null
    vi.spyOn(storage, 'subscribe').mockImplementation((l) => ((wake = l), () => (wake = null)))
    const { el } = await mountSortable()
    expect(rowPaths(el)[0]).toBe('Banana.excalidraw')
    get.mockReturnValue('name')
    await act(async () => wake?.())
    expect(rowPaths(el)[0]).toBe('Apple.excalidraw')
  })

  it('sorts inside Focus Mode too — the focused folder`s children, in the order', async () => {
    vi.spyOn(storage, 'getFocusDirs').mockReturnValue(['/v/sub'])
    vi.spyOn(storage, 'getSortOrder').mockReturnValue('updated')
    const { el } = await mountSortable()
    // The focused folder IS the top row; open it and its children come in the order.
    act(() => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click())
    expect(rowPaths(el, true)).toEqual(['sub/b-second.excalidraw', 'sub/a-first.excalidraw'])
    act(() => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click()) // fold it back for the tests after
  })

  it('the Favorites lens keeps the hand order and ⌘K keeps its ranking, whatever the sort (D1)', async () => {
    vi.spyOn(storage, 'getSortOrder').mockReturnValue('updated')
    const { el } = await mount({ lens: 'favorites' }, (b) => {
      b.tree.mockResolvedValue({ root: '/v', tree: SORTABLE, generatedAt: 1 })
      b.favorites.get.mockResolvedValue(['/v/Cherry.excalidraw', '/v/Apple.excalidraw', '/v/Banana.excalidraw'])
    })
    expect(rowPaths(el)).toEqual(['Cherry.excalidraw', 'Apple.excalidraw', 'Banana.excalidraw']) // NOT Banana, Cherry, Apple
    // Info is offered on a board row here as well (either lens, D6).
    act(() => void [...el.querySelectorAll<HTMLElement>('.tree__row--file')][0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(itemByLabel(el, 'Info')).toBeDefined()
    const files = await mountSortable()
    const input = searchInput(files.el)
    if (input === null) throw new Error('no search input')
    await type(input, 'an')
    expect([...files.el.querySelectorAll('.search-results__row .search-results__label')].map((n) => n.textContent)).toEqual(['Banana']) // ranked, not sorted
    await type(input, 'a')
    const labels = [...files.el.querySelectorAll('.search-results__row .search-results__label')].map((n) => n.textContent)
    expect(labels.indexOf('Apple')).toBeLessThan(labels.indexOf('Banana')) // the catalog's own order, though "updated" would flip them
  })

  it('an older tree walk that lands AFTER a newer one is dropped (D4 — walks overlap now)', async () => {
    let notify: ((ev: WatchEvent) => void) | null = null
    const { el, bridge } = await mountSortable({ watch: { subscribe: (l) => ((notify = l), () => (notify = null)) } })
    fakeClock()
    const resolvers: Array<(v: { root: string; tree: TreeNode[]; generatedAt: number }) => void> = []
    bridge.tree.mockImplementation(() => new Promise((r) => resolvers.push(r)))
    await act(async () => notify?.({ type: 'change', path: '/v/Apple.excalidraw', mtime: 1 }))
    await quiet()
    await act(async () => notify?.({ type: 'change', path: '/v/Apple.excalidraw', mtime: 2 }))
    await quiet()
    expect(resolvers).toHaveLength(2)
    const renamed = (name: string, at: number) => ({ root: '/v', tree: [{ type: 'file' as const, name, path: `/v/${name}`, size: 1, mtime: 1, kind: 'drawing' as const }], generatedAt: at })
    await act(async () => resolvers[1]?.(renamed('newer.excalidraw', 20)))
    await act(async () => resolvers[0]?.(renamed('older.excalidraw', 10)))
    expect(rowPaths(el)).toEqual(['newer.excalidraw'])
  })

  it('a watcher `change` event refreshes the tree, so a saved board can rise (D4)', async () => {
    let notify: ((ev: WatchEvent) => void) | null = null
    const { el, bridge } = await mountSortable({ watch: { subscribe: (l) => ((notify = l), () => (notify = null)) } })
    fakeClock()
    act(() => sortButton(el)?.click())
    await act(async () => itemByLabel(el, 'Last updated')?.click())
    const calls = bridge.tree.mock.calls.length
    const saved = SORTABLE.map((n) => (n.type === 'file' && n.name === 'Apple.excalidraw' ? { ...n, meta: { createdAt: 400, updatedAt: 5000 } } : n))
    bridge.tree.mockResolvedValue({ root: '/v', tree: saved, generatedAt: 2 })
    await act(async () => notify?.({ type: 'change', path: '/v/Apple.excalidraw', mtime: 5000 }))
    await quiet()
    expect(bridge.tree.mock.calls.length).toBe(calls + 1)
    expect(rowPaths(el)[0]).toBe('Apple.excalidraw')
  })
})

/**
 * "Info" (🔒 YAZ-1835 D6/D7): above Delete on a board row only, opening a popover that reads the LIVE
 * tree node — a refresh moves its dates, the board vanishing closes it, Escape closes it.
 */
describe('Info popover (🔒 YAZ-1835 D6/D7)', () => {
  const rightClick = (target: Element | null | undefined) => act(() => void target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 })))
  const rowFor = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLElement>('.tree__row--file')].find((r) => r.dataset.path === `/v/${name}`)
  const popover = (el: HTMLElement) => el.querySelector<HTMLElement>('.board-info')
  const row = (el: HTMLElement, label: string) => [...(popover(el)?.querySelectorAll('dt') ?? [])].find((dt) => dt.textContent === label)?.nextElementSibling?.textContent

  it('is offered on a board row, directly above Delete, and on nothing else', async () => {
    const { el } = await mountSortable()
    rightClick(rowFor(el, 'Apple.excalidraw'))
    const labels = menuItems(el).map((b) => b.textContent)
    expect(labels.indexOf('Info')).toBe(labels.indexOf('Delete') - 1)
    rightClick(rowFor(el, 'notes.txt'))
    expect(itemByLabel(el, 'Info')).toBeUndefined()
    rightClick(el.querySelector('.tree__row--dir'))
    expect(itemByLabel(el, 'Info')).toBeUndefined()
    rightClick(el.querySelector('.sidebar__body'))
    expect(itemByLabel(el, 'Info')).toBeUndefined()
    // A 2+ selection has no single board to describe (the multi-select idiom: shift-click extends).
    act(() => void rowFor(el, 'Apple.excalidraw')?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
    act(() => void rowFor(el, 'Banana.excalidraw')?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    expect(el.querySelectorAll('.tree__row--selected').length).toBe(2)
    rightClick(rowFor(el, 'Apple.excalidraw'))
    expect(itemByLabel(el, 'Info')).toBeUndefined()
    expect(itemByLabel(el, 'Delete')).toBeDefined()
  })

  it('opens the popover with the six rows, follows a tree refresh, and closes when the board is gone', async () => {
    let notify: ((ev: WatchEvent) => void) | null = null
    const { el, bridge } = await mountSortable({ watch: { subscribe: (l) => ((notify = l), () => (notify = null)) } })
    fakeClock()
    rightClick(rowFor(el, 'Apple.excalidraw'))
    await act(async () => itemByLabel(el, 'Info')?.click())
    expect(menuItems(el)).toEqual([]) // the menu closed; the popover stands on its own
    expect(row(el, 'Name')).toBe('Apple.excalidraw')
    expect(row(el, 'Folder')).toBe('/')
    expect(row(el, 'Size')).toBe('1 B')
    expect(row(el, 'Created')).toMatch(/^(Dec 31, 1969|Jan 1, 1970)/) // epoch 400 ms, in whatever zone the machine keeps
    const before = row(el, 'Updated')
    // A save elsewhere: the watcher refreshes the tree and the popover shows the new date.
    const later = Date.now()
    bridge.tree.mockResolvedValue({ root: '/v', tree: SORTABLE.map((n) => (n.type === 'file' && n.name === 'Apple.excalidraw' ? { ...n, meta: { createdAt: 400, updatedAt: later } } : n)), generatedAt: 2 })
    await act(async () => notify?.({ type: 'change', path: '/v/Apple.excalidraw', mtime: later }))
    await quiet()
    expect(row(el, 'Updated')).not.toBe(before)
    expect(row(el, 'Updated')).toMatch(/· just now$/)
    // The board vanishes: the popover has nothing to describe and closes.
    bridge.tree.mockResolvedValue({ root: '/v', tree: SORTABLE.filter((n) => n.name !== 'Apple.excalidraw'), generatedAt: 3 })
    await act(async () => notify?.({ type: 'unlink', path: '/v/Apple.excalidraw' }))
    await quiet()
    expect(popover(el)).toBeNull()
  })

  it('a legacy board reads "Not stamped yet"; Escape closes the popover, and so does a click away', async () => {
    const legacy = [...SORTABLE, { type: 'file' as const, name: 'Legacy.excalidraw', path: '/v/Legacy.excalidraw', size: 2048, mtime: 7, kind: 'drawing' as const }]
    const { el } = await mount({}, (b) => b.tree.mockResolvedValue({ root: '/v', tree: legacy, generatedAt: 1 }))
    const open = async () => {
      rightClick(rowFor(el, 'Legacy.excalidraw'))
      await act(async () => itemByLabel(el, 'Info')?.click())
    }
    await open()
    expect(el.querySelector('[role="dialog"] .board-info')).not.toBeNull()
    expect(row(el, 'Created')).toBe('Not stamped yet · written on the next save')
    expect(row(el, 'Size')).toBe('2.0 KB')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(popover(el)).toBeNull()
    await open()
    act(() => void window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(popover(el)).toBeNull()
  })

  it('a board that comes BACK after vanishing does not reopen its popover', async () => {
    let notify: ((ev: WatchEvent) => void) | null = null
    const { el, bridge } = await mountSortable({ watch: { subscribe: (l) => ((notify = l), () => (notify = null)) } })
    fakeClock()
    rightClick(rowFor(el, 'Apple.excalidraw'))
    await act(async () => itemByLabel(el, 'Info')?.click())
    expect(popover(el)).not.toBeNull()
    bridge.tree.mockResolvedValue({ root: '/v', tree: SORTABLE.filter((n) => n.name !== 'Apple.excalidraw'), generatedAt: 2 })
    await act(async () => notify?.({ type: 'unlink', path: '/v/Apple.excalidraw' }))
    await quiet()
    expect(popover(el)).toBeNull()
    bridge.tree.mockResolvedValue({ root: '/v', tree: SORTABLE, generatedAt: 3 })
    await act(async () => notify?.({ type: 'add', path: '/v/Apple.excalidraw', mtime: 3 }))
    await quiet()
    expect(popover(el)).toBeNull()
  })
})

describe('hover preview (YAZ-1800)', () => {
  const panel = () => document.querySelector<HTMLElement>('.board-preview')
  const enter = (row: Element) => act(() => void row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
  const leave = (row: Element) => act(() => void row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
  const dwell = (ms = BOARD_PREVIEW_DWELL_MS) => act(async () => void vi.advanceTimersByTime(ms))
  const previewButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__preview')

  beforeEach(() => previewLoad.mockReset().mockResolvedValue('data:image/png;base64,AA'))

  it('opens after the dwell on a board row, shows the picture, and closes the moment the pointer leaves', async () => {
    const { el } = await mount()
    fakeClock()
    const row = fileRow(el)!
    expect(row.title).toBe('') // the path tooltip gives way to the panel
    await enter(row)
    await dwell(BOARD_PREVIEW_DWELL_MS - 1)
    expect(panel()).toBeNull()
    await dwell(1)
    expect(panel()?.getAttribute('aria-label')).toBe('Preview of a')
    expect(panel()?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA')
    expect(previewLoad).toHaveBeenCalledWith(['/v', '/v/a.excalidraw', 1, 'light', 'adapt'].join('\n'))
    await leave(row)
    expect(panel()).toBeNull()
  })

  it('leaving before the dwell ends never opens it; Escape and a row click close an open one', async () => {
    const { el } = await mount()
    fakeClock()
    const row = fileRow(el)!
    await enter(row)
    await leave(row)
    await dwell()
    expect(panel()).toBeNull()
    await enter(row)
    await dwell()
    expect(panel()).not.toBeNull()
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(panel()).toBeNull()
    await leave(row)
    await enter(row)
    await dwell()
    await act(async () => row.click())
    expect(panel()).toBeNull()
  })

  it('Escape during the dwell, before any panel shows, is not the preview`s: it still clears the selection (YAZ-2073 8B)', async () => {
    const { el } = await mount()
    fakeClock()
    const row = fileRow(el)!
    act(() => void row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(1)
    await enter(row)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => void el.querySelector('.sidebar__body')?.dispatchEvent(esc))
    expect(el.querySelectorAll('.tree__row--selected')).toHaveLength(0)
  })

  it('says so when a board is empty or cannot be drawn', async () => {
    const { el } = await mount()
    fakeClock()
    // StrictMode runs the panel's effect twice, so the stub answers the same for every call.
    previewLoad.mockResolvedValue('')
    await enter(fileRow(el)!)
    await dwell()
    expect(panel()?.textContent).toContain('Empty board')
    await leave(fileRow(el)!)
    previewLoad.mockResolvedValue(null)
    await enter(fileRow(el)!)
    await dwell()
    expect(panel()?.textContent).toContain('Preview unavailable')
    previewLoad.mockResolvedValue('data:image/png;base64,AA')
  })

  it('the header toggle flips the setting; OFF, a board row keeps its tooltip and hovering does nothing', async () => {
    const { el, props } = await mount({ settings: { ...DEFAULT_SETTINGS, hoverPreview: false } })
    expect(previewButton(el)?.getAttribute('aria-pressed')).toBe('false')
    act(() => previewButton(el)?.click())
    expect(props.onChangeSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, hoverPreview: true })
    fakeClock()
    const row = fileRow(el)!
    expect(row.title).toBe('/v/a.excalidraw')
    await enter(row)
    await dwell()
    expect(panel()).toBeNull()
  })

  // The watcher is the one door a save or a delete reaches the tree through; each emit re-reads `bridge.tree`.
  const watched = () => {
    const w: { emit: ((ev: WatchEvent) => void) | null; watch: SidebarProps['watch'] } = { emit: null, watch: { subscribe: (l) => ((w.emit = l), () => (w.emit = null)) } }
    return w
  }

  it('a save to the hovered board keeps the panel up and asks for the new picture (🔒 D5 amendment: swap in place)', async () => {
    const w = watched()
    const { el, bridge } = await mount({ watch: w.watch })
    fakeClock()
    await enter(fileRow(el)!)
    await dwell()
    expect(panel()).not.toBeNull()
    bridge.tree.mockResolvedValue({ root: '/v', tree: TREE.map((n) => (n.path === '/v/a.excalidraw' ? { ...n, mtime: 9 } : n)), generatedAt: 2 })
    await act(async () => w.emit?.({ type: 'change', path: '/v/a.excalidraw', mtime: 9 }))
    await quiet()
    expect(panel()).not.toBeNull()
    expect(previewLoad).toHaveBeenLastCalledWith(['/v', '/v/a.excalidraw', 9, 'light', 'adapt'].join('\n'))
  })

  it('the hovered board disappearing from the tree (deleted, renamed, moved) closes the panel', async () => {
    const w = watched()
    const { el, bridge } = await mount({ watch: w.watch })
    fakeClock()
    await enter(fileRow(el)!)
    await dwell()
    bridge.tree.mockResolvedValue({ root: '/v', tree: TREE.filter((n) => n.path !== '/v/a.excalidraw'), generatedAt: 2 })
    await act(async () => w.emit?.({ type: 'unlink', path: '/v/a.excalidraw' }))
    await quiet()
    expect(panel()).toBeNull()
  })

  it('a right-click or a drag on the row closes an open panel', async () => {
    const { el } = await mount()
    fakeClock()
    const row = fileRow(el)!
    await enter(row)
    await dwell()
    act(() => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    expect(panel()).toBeNull()
    expect(document.querySelector('[role="menu"]')).not.toBeNull() // and nothing opens under the menu while it stands
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await leave(row)
    await enter(row)
    await dwell()
    expect(panel()).not.toBeNull()
    act(() => void row.dispatchEvent(new Event('dragstart', { bubbles: true })))
    expect(panel()).toBeNull()
  })

  it('keyboard focus on a board row previews it like the pointer; blur closes it; a search starting closes it too', async () => {
    const { el } = await mount()
    fakeClock()
    const row = fileRow(el)!
    act(() => row.focus())
    await dwell()
    expect(panel()?.getAttribute('aria-label')).toBe('Preview of a')
    act(() => row.blur())
    expect(panel()).toBeNull()
    await enter(row) // by pointer this time, so typing's focus move is not what closes it
    await dwell()
    expect(panel()).not.toBeNull()
    await type(searchInput(el)!, 'a')
    expect(panel()).toBeNull()
  })

  it('turning the toggle off closes an open preview', async () => {
    const { el, rerender } = await mount()
    fakeClock()
    await enter(fileRow(el)!)
    await dwell()
    expect(panel()).not.toBeNull()
    await rerender({ settings: { ...DEFAULT_SETTINGS, hoverPreview: false } })
    expect(panel()).toBeNull()
  })
})

/**
 * The watch-driven refresh, coalesced (YAZ-2073 5E, 🔒 D10): a change waits out `WATCH_REFRESH_MS`
 * of quiet, so a burst (a sync pull, a folder copy) is ONE `fs:tree`, not one per file; `ready`
 * still refreshes at once (🔒 YAZ-1835 D4 is unchanged: every change is followed by a fresh tree).
 */
describe('watch-driven refresh (YAZ-2073 5E)', () => {
  const watched = () => {
    const w: { emit: (ev: WatchEvent) => void; watch: SidebarProps['watch'] } = { emit: () => undefined, watch: { subscribe: (l) => ((w.emit = l), () => (w.emit = () => undefined)) } }
    return w
  }
  const mountWatched = async () => {
    const w = watched()
    const m = await mount({ watch: w.watch })
    fakeClock()
    return { ...m, emit: (ev: WatchEvent) => act(async () => w.emit(ev)), calls: () => m.bridge.tree.mock.calls.length }
  }

  it('a burst of changes inside the quiet window is one tree walk, made once the burst goes quiet', async () => {
    const { bridge, emit, calls } = await mountWatched()
    const before = calls()
    bridge.tree.mockResolvedValue({ root: '/v', tree: TREE.filter((n) => n.path !== '/v/a.excalidraw'), generatedAt: 2 })
    for (let i = 0; i < 50; i++) {
      await emit({ type: 'change', path: `/v/f${i}.excalidraw`, mtime: i })
      await act(async () => void vi.advanceTimersByTime(WATCH_REFRESH_MS - 1))
    }
    expect(calls()).toBe(before)
    await quiet()
    expect(calls()).toBe(before + 1)
  })

  it('`ready` refreshes at once and takes a pending change refresh with it', async () => {
    const { emit, calls } = await mountWatched()
    const before = calls()
    await emit({ type: 'add', path: '/v/new.excalidraw', mtime: 1 })
    await emit({ type: 'ready', root: '/v' })
    expect(calls()).toBe(before + 1)
    await quiet()
    expect(calls()).toBe(before + 1)
  })

  it('an `error` shows at once and walks nothing', async () => {
    const { el, emit, calls } = await mountWatched()
    const before = calls()
    await emit({ type: 'error', message: 'watch failed' })
    expect(el.querySelector('.sidebar__msg--error')?.textContent).toContain('watch failed')
    await quiet()
    expect(calls()).toBe(before)
  })

  it('a refresh still pending when the sidebar unmounts never runs', async () => {
    const { emit, calls } = await mountWatched()
    const before = calls()
    await emit({ type: 'unlink', path: '/v/a.excalidraw' })
    act(() => root?.unmount())
    root = null
    await quiet()
    expect(calls()).toBe(before)
  })
})
