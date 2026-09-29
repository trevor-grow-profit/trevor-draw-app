import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import type { FileKind, RecentRoots, WindowEntry } from '@shared/types'
import { CONTRACT } from '@shared/ipc'
import { createStore, type Store } from './store'
import { HELP_URL, buildContextMenuTemplate, buildMenuTemplate, createMenuHandlers, pickMenuTargetWindow, subscribeMenuRebuild, subscribeMenuRebuildOnActiveFile, CANVAS_BACKGROUND_PICKS, type ContextMenuActions, type MenuHandlers, type MenuHost } from './menu'

// ---------- buildMenuTemplate (pure) ----------

const noopHandlers = (): MenuHandlers => ({
  newWindow: vi.fn(),
  switchVault: vi.fn(),
  openFolder: vi.fn(),
  openRecent: vi.fn(),
  search: vi.fn(),
  settings: vi.fn(),
  closeTab: vi.fn(),
  zoom: vi.fn(),
  nextTab: vi.fn(),
  prevTab: vi.fn(),
  toggleSidebar: vi.fn(),
  exportImage: vi.fn(),
  exportDrawing: vi.fn(),
  shareLink: vi.fn(),
  canvasBackground: vi.fn(),
  openHelp: vi.fn(),
})

const RECENTS: RecentRoots = [
  { path: '/vaults/notes', lastOpened: 3 },
  { path: '/vaults/work', lastOpened: 2 },
  { path: '/vaults/old', lastOpened: 1 },
]

function build(recents: RecentRoots = RECENTS, isDev = false, handlers: MenuHandlers = noopHandlers(), activeKind: FileKind | null = 'drawing') {
  return buildMenuTemplate({ recents, isDev, activeKind }, handlers)
}

function menuOf(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const top = template.find((m) => m.label === label)
  expect(top, label).toBeDefined()
  return top?.submenu as MenuItemConstructorOptions[]
}

/** Fires a template item's click the way Electron does (menuItem, window, KeyboardEvent). */
function click(item: MenuItemConstructorOptions | undefined, event: { altKey?: boolean } = {}): void {
  expect(item?.click).toBeTypeOf('function')
  item?.click?.(undefined as never, undefined, event as never)
}

describe('buildMenuTemplate', () => {
  it('has the six menus in order', () => {
    expect(build().map((m) => m.label)).toEqual(['Trevor Draw', 'File', 'Edit', 'View', 'Window', 'Help'])
  })

  it('App menu: About, Settings… ⌘, in its own group (YAZ-1679), the standard Hide roles, and Quit', () => {
    const handlers = noopHandlers()
    const app = menuOf(build(RECENTS, false, handlers), 'Trevor Draw')
    expect(app.map((i) => i.role ?? i.type ?? i.id)).toEqual(['about', 'separator', 'menu.app.settings', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit'])
    const settings = app.find((i) => i.label === 'Settings…')
    expect(settings?.accelerator).toBe('CmdOrCtrl+,')
    click(settings)
    expect(handlers.settings).toHaveBeenCalledTimes(1)
  })

  it('File menu: New Window ⌘⇧N, Switch Vault… ⌘O, Open Folder… ⌘⇧O, Open Recent, Search Vault ⌘K, Close Tab ⌘W, Close Window ⌘⇧W', () => {
    const handlers = noopHandlers()
    const file = menuOf(build(RECENTS, false, handlers), 'File')

    const newWindow = file.find((i) => i.label === 'New Window')
    expect(newWindow?.accelerator).toBe('CmdOrCtrl+Shift+N')
    click(newWindow)
    expect(handlers.newWindow).toHaveBeenCalledTimes(1)

    // ⌘O is Switch Vault… (YAZ-1767 D8): directly ABOVE Open Folder…, into the focused renderer.
    const switchVault = file.find((i) => i.label === 'Switch Vault…')
    expect(switchVault?.accelerator).toBe('CmdOrCtrl+O')
    click(switchVault)
    expect(handlers.switchVault).toHaveBeenCalledTimes(1)

    const openFolder = file.find((i) => i.label === 'Open Folder…')
    expect(openFolder?.accelerator).toBe('CmdOrCtrl+Shift+O')
    expect(file.indexOf(openFolder as MenuItemConstructorOptions)).toBe(file.indexOf(switchVault as MenuItemConstructorOptions) + 1)
    click(openFolder)
    expect(handlers.openFolder).toHaveBeenCalledTimes(1)

    expect(file.find((i) => i.label === 'Open Recent')).toBeDefined()

    // ⌘K is Search Vault (D4, YAZ-739 amended): its own group right below Open Recent.
    const search = file.find((i) => i.label === 'Search Vault')
    expect(search?.accelerator).toBe('CmdOrCtrl+K')
    expect(file.indexOf(search as MenuItemConstructorOptions)).toBe(file.findIndex((i) => i.label === 'Open Recent') + 2)
    click(search)
    expect(handlers.search).toHaveBeenCalledTimes(1)

    // ⌘W is Close Tab (GRO-2232, locked): a click item into the focused renderer, NOT the role.
    const closeTab = file.find((i) => i.label === 'Close Tab')
    expect(closeTab?.accelerator).toBe('CmdOrCtrl+W')
    expect(closeTab?.role).toBeUndefined()
    click(closeTab)
    expect(handlers.closeTab).toHaveBeenCalledTimes(1)

    // Close Window keeps role close (the flush-handshake OS close) on ⌘⇧W.
    const close = file.find((i) => i.label === 'Close Window')
    expect(close?.role).toBe('close')
    expect(close?.accelerator).toBe('CmdOrCtrl+Shift+W')
  })

  it('Open Recent lists recents in MRU order; a click hands over the path alone — ⌥ means nothing (YAZ-1913 D1)', () => {
    const handlers = noopHandlers()
    const file = menuOf(build(RECENTS, false, handlers), 'File')
    const recent = file.find((i) => i.label === 'Open Recent')?.submenu as MenuItemConstructorOptions[]
    expect(recent.map((i) => i.label)).toEqual(['/vaults/notes', '/vaults/work', '/vaults/old'])

    click(recent[1])
    expect(handlers.openRecent).toHaveBeenLastCalledWith('/vaults/work')
    click(recent[0], { altKey: true })
    expect(handlers.openRecent).toHaveBeenLastCalledWith('/vaults/notes')
    // A programmatic `menuItem.click()` passes no event at all: the same call, not a crash.
    recent[2].click?.(undefined as never, undefined, undefined as never)
    expect(handlers.openRecent).toHaveBeenLastCalledWith('/vaults/old')
  })

  it('Open Recent with no recents shows one disabled placeholder', () => {
    const file = menuOf(build([]), 'File')
    const recent = file.find((i) => i.label === 'Open Recent')?.submenu as MenuItemConstructorOptions[]
    expect(recent).toEqual([{ label: 'No Recent Folders', enabled: false }])
  })

  it('Edit is the native roles only — no app-owned rows', () => {
    const items = menuOf(build(RECENTS, false, noopHandlers()), 'Edit')
    expect(items.map((i) => i.role ?? i.type ?? i.label)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'])
    expect(items.every((i) => i.submenu === undefined)).toBe(true)
  })

  it('View menu: Toggle Sidebar, Reload, our own zoom items (not the roles); Toggle DevTools only in dev', () => {
    const handlers = noopHandlers()
    const view = menuOf(build(RECENTS, false, handlers), 'View')
    expect(view.map((i) => i.role).filter(Boolean)).toEqual(['reload'])
    const toggle = view.find((i) => i.label === 'Toggle Sidebar')
    click(toggle)
    expect(handlers.toggleSidebar).toHaveBeenCalledTimes(1)

    const dev = menuOf(build(RECENTS, true), 'View')
    expect(dev.map((i) => i.role).filter(Boolean)).toEqual(['reload', 'toggleDevTools'])
  })

  it('View › Actual Size / Zoom In / Zoom Out own ⌘0 / ⌘+ (and hidden ⌘=) / ⌘− and hand the step to handlers.zoom (YAZ-1710)', () => {
    const handlers = noopHandlers()
    const view = menuOf(build(RECENTS, false, handlers), 'View')
    const zoom = view.filter((i) => i.id?.startsWith('menu.view.zoom'))
    expect(zoom.map((i) => [i.id, i.label, i.accelerator, i.visible ?? true])).toEqual([
      ['menu.view.zoom-reset', 'Actual Size', 'CmdOrCtrl+0', true],
      ['menu.view.zoom-in', 'Zoom In', 'CmdOrCtrl+Plus', true],
      ['menu.view.zoom-in-eq', 'Zoom In', 'CmdOrCtrl+=', false],
      ['menu.view.zoom-out', 'Zoom Out', 'CmdOrCtrl+-', true],
    ])
    zoom.forEach((item) => click(item))
    expect(vi.mocked(handlers.zoom).mock.calls).toEqual([[0], [1], [1], [-1]])
  })

  it('File › Export Image… is ⌘⇧E, enabled on a drawing tab, and calls exportImage (🔒 YAZ-1775 D10)', () => {
    const handlers = noopHandlers()
    const item = menuOf(build(RECENTS, false, handlers, 'drawing'), 'File').find((i) => i.id === 'menu.file.export-image')
    expect(item?.label).toBe('Export Image…')
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+E')
    expect(item?.enabled).toBe(true)
    click(item)
    expect(handlers.exportImage).toHaveBeenCalledTimes(1)
    // A non-board tab (or no tab at all) greys it out rather than letting it silently no-op.
    expect(menuOf(build(RECENTS, false, handlers, null), 'File').find((i) => i.id === 'menu.file.export-image')?.enabled).toBe(false)
  })

  it('a draw.io diagram tab enables Export Image… but not the Excalidraw-only items (🔒 YAZ-1802 D9)', () => {
    const template = build(RECENTS, false, noopHandlers(), 'diagram')
    const enabled = (menu: string, id: string) => menuOf(template, menu).find((i) => i.id === id)?.enabled
    expect(enabled('File', 'menu.file.export-image')).toBe(true)
    expect(enabled('File', 'menu.file.export-drawing')).toBe(false)
    expect(enabled('View', 'menu.view.canvas-background')).toBe(false)
  })

  it('File › Export Drawing… is ⌘⇧S, gated the same way, and calls exportDrawing (🔒 YAZ-1775 D3, YAZ-1821)', () => {
    const handlers = noopHandlers()
    const file = menuOf(build(RECENTS, false, handlers, 'drawing'), 'File')
    const item = file.find((i) => i.id === 'menu.file.export-drawing')
    expect(item?.label).toBe('Export Excalidraw Drawing…')
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+S')
    expect(item?.enabled).toBe(true)
    click(item)
    expect(handlers.exportDrawing).toHaveBeenCalledTimes(1)
    expect(menuOf(build(RECENTS, false, handlers, null), 'File').find((i) => i.id === 'menu.file.export-drawing')?.enabled).toBe(false)
    // It sits beside the image export, and the two are not the same gesture.
    expect(file.findIndex((i) => i.id === 'menu.file.export-drawing')).toBe(file.findIndex((i) => i.id === 'menu.file.export-image') + 1)
  })

  it('File › Share Link is ⌘⇧L, right after Export Drawing…, enabled on any board — a diagram too (YAZ-1799, 🔒 YAZ-1802 D11)', () => {
    const handlers = noopHandlers()
    const file = menuOf(build(RECENTS, false, handlers, 'drawing'), 'File')
    const item = file.find((i) => i.id === 'menu.file.share-link')
    expect(item?.label).toBe('Share Link')
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+L')
    expect(item?.enabled).toBe(true)
    click(item)
    expect(handlers.shareLink).toHaveBeenCalledTimes(1)
    expect(file.findIndex((i) => i.id === 'menu.file.share-link')).toBe(file.findIndex((i) => i.id === 'menu.file.export-drawing') + 1)
    const shareLinkOn = (kind: FileKind | null) => menuOf(build(RECENTS, false, handlers, kind), 'File').find((i) => i.id === 'menu.file.share-link')?.enabled
    expect(shareLinkOn('diagram')).toBe(true)
    expect(shareLinkOn(null)).toBe(false)
  })

  it('⌘⇧S and ⌘⇧L are claimed by nothing else in the menu bar', () => {
    const accelerators = build()
      .flatMap((top) => (Array.isArray(top.submenu) ? (top.submenu as MenuItemConstructorOptions[]) : []))
      .flatMap((item) => [item, ...(Array.isArray(item.submenu) ? (item.submenu as MenuItemConstructorOptions[]) : [])])
      .map((item) => item.accelerator)
      .filter((a): a is string => a !== undefined)
    expect(accelerators.filter((a) => a === 'CmdOrCtrl+Shift+S')).toEqual(['CmdOrCtrl+Shift+S'])
    expect(accelerators.filter((a) => a === 'CmdOrCtrl+Shift+L')).toEqual(['CmdOrCtrl+Shift+L'])
  })

  it('View › Canvas Background carries the engine`s five picks, gated the same way (🔒 YAZ-1775 D10)', () => {
    const handlers = noopHandlers()
    const item = menuOf(build(RECENTS, false, handlers, 'drawing'), 'View').find((i) => i.id === 'menu.view.canvas-background')
    expect(item?.label).toBe('Canvas Background')
    expect(item?.enabled).toBe(true)
    expect(item?.accelerator).toBeUndefined()
    const picks = item?.submenu as MenuItemConstructorOptions[]
    expect(picks.map((p) => p.label)).toEqual(['White', 'Slate', 'Blue', 'Yellow', 'Bronze'])
    expect(CANVAS_BACKGROUND_PICKS.map((p) => p.color)).toEqual(['#ffffff', '#f8f9fa', '#f5faff', '#fffce8', '#fdf8f6'])
    picks.forEach((pick) => click(pick))
    expect(vi.mocked(handlers.canvasBackground).mock.calls).toEqual(CANVAS_BACKGROUND_PICKS.map((p) => [p.color]))
    expect(menuOf(build(RECENTS, false, handlers, null), 'View').find((i) => i.id === 'menu.view.canvas-background')?.enabled).toBe(false)
  })

  it('Window menu: role window (macOS window list) with minimize / zoom, the tab-switching items, front', () => {
    const handlers = noopHandlers()
    const top = build(RECENTS, false, handlers).find((m) => m.label === 'Window')
    expect(top?.role).toBe('window')
    const items = top?.submenu as MenuItemConstructorOptions[]
    expect(items.map((i) => i.role ?? i.id ?? i.type)).toEqual([
      'minimize',
      'zoom',
      'separator',
      'menu.window.next-tab',
      'menu.window.prev-tab',
      'menu.window.next-tab-alt',
      'menu.window.prev-tab-alt',
      'separator',
      'front',
    ])
  })

  it('tab switching (GRO-2232): ⌃Tab / ⌃⇧Tab on the visible pair; hidden ⌘⇧] / ⌘⇧[ duplicates still fire', () => {
    const handlers = noopHandlers()
    const items = menuOf(build(RECENTS, false, handlers), 'Window')
    const byId = (id: string) => items.find((i) => i.id === id)

    const next = byId('menu.window.next-tab')
    expect(next?.label).toBe('Next Tab')
    expect(next?.accelerator).toBe('Control+Tab')
    click(next)
    expect(handlers.nextTab).toHaveBeenCalledTimes(1)

    const prev = byId('menu.window.prev-tab')
    expect(prev?.label).toBe('Previous Tab')
    expect(prev?.accelerator).toBe('Control+Shift+Tab')
    click(prev)
    expect(handlers.prevTab).toHaveBeenCalledTimes(1)

    // The second accelerator pair rides hidden duplicates (acceleratorWorksWhenHidden, macOS).
    const nextAlt = byId('menu.window.next-tab-alt')
    expect(nextAlt?.accelerator).toBe('CmdOrCtrl+Shift+]')
    expect(nextAlt?.visible).toBe(false)
    expect(nextAlt?.acceleratorWorksWhenHidden).toBe(true)
    click(nextAlt)
    expect(handlers.nextTab).toHaveBeenCalledTimes(2)

    const prevAlt = byId('menu.window.prev-tab-alt')
    expect(prevAlt?.accelerator).toBe('CmdOrCtrl+Shift+[')
    expect(prevAlt?.visible).toBe(false)
    expect(prevAlt?.acceleratorWorksWhenHidden).toBe(true)
    click(prevAlt)
    expect(handlers.prevTab).toHaveBeenCalledTimes(2)
  })

  it('Help menu: role help, GitHub link item', () => {
    const handlers = noopHandlers()
    const template = build(RECENTS, false, handlers)
    const top = template.find((m) => m.label === 'Help')
    expect(top?.role).toBe('help')
    const github = (top?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Trevor Draw on GitHub')
    click(github)
    expect(handlers.openHelp).toHaveBeenCalledTimes(1)
  })

  it('⌘⇧N is the ONE duplicate-window door: the File item clicks straight through to newWindow', () => {
    const handlers = noopHandlers()
    const item = menuOf(build(RECENTS, false, handlers), 'File').find((i) => i.id === 'menu.file.new-window')
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+N')
    click(item)
    expect(handlers.newWindow).toHaveBeenCalledTimes(1)
  })

  it('actionable items carry stable ids so a live check can drive them', () => {
    const file = menuOf(build(), 'File')
    expect(file.find((i) => i.label === 'New Window')?.id).toBe('menu.file.new-window')
    expect(file.find((i) => i.label === 'Switch Vault…')?.id).toBe('menu.file.switch-vault')
    expect(file.find((i) => i.label === 'Open Folder…')?.id).toBe('menu.file.open-folder')
    expect(file.find((i) => i.label === 'Search Vault')?.id).toBe('menu.file.search')
    expect(file.find((i) => i.label === 'Close Tab')?.id).toBe('menu.file.close-tab')
    expect(file.find((i) => i.label === 'Close Window')?.id).toBe('menu.file.close-window')
    const recent = file.find((i) => i.label === 'Open Recent')?.submenu as MenuItemConstructorOptions[]
    expect(recent.map((i) => i.id)).toEqual(['menu.file.open-recent.0', 'menu.file.open-recent.1', 'menu.file.open-recent.2'])
    expect(menuOf(build(), 'View').find((i) => i.label === 'Toggle Sidebar')?.id).toBe('menu.view.toggle-sidebar')
    expect((build().find((m) => m.label === 'Help')?.submenu as MenuItemConstructorOptions[])[0].id).toBe('menu.help.github')
  })
})

// ---------- buildContextMenuTemplate (pure, YAZ-672) ----------

type ContextParams = Parameters<typeof buildContextMenuTemplate>[0]

const EDIT_FLAGS: ContextParams['editFlags'] = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true }

const noopActions = (): ContextMenuActions => ({ replace: vi.fn(), addToDictionary: vi.fn() })

/** What Electron hands `context-menu`, defaulting to a clean right-click in an editable body. */
function context(params: Partial<ContextParams> = {}): ContextParams {
  return { misspelledWord: '', dictionarySuggestions: [], editFlags: EDIT_FLAGS, ...params }
}

const shapeOf = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label ?? i.role ?? i.type)

describe('buildContextMenuTemplate', () => {
  it('a misspelling with suggestions: the suggestions, Add to Dictionary, then cut/copy/paste', () => {
    const items = buildContextMenuTemplate(context({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea'] }), noopActions())
    expect(shapeOf(items)).toEqual(['the', 'ten', 'tea', 'separator', 'Add to Dictionary', 'separator', 'cut', 'copy', 'paste'])
  })

  it('a misspelling Electron has no suggestions for leads with Add to Dictionary — no dangling separator', () => {
    const items = buildContextMenuTemplate(context({ misspelledWord: 'Yaseen' }), noopActions())
    expect(shapeOf(items)).toEqual(['Add to Dictionary', 'separator', 'cut', 'copy', 'paste'])
  })

  it('nothing misspelled: still never empty — cut/copy/paste mirroring editFlags', () => {
    const items = buildContextMenuTemplate(context({ editFlags: { ...EDIT_FLAGS, canCut: false, canPaste: false } }), noopActions())
    expect(shapeOf(items)).toEqual(['cut', 'copy', 'paste'])
    expect(items.map((i) => i.enabled)).toEqual([false, true, false])
  })

  it('clicking a suggestion replaces the word; Add to Dictionary teaches the misspelled one', () => {
    const actions = noopActions()
    const items = buildContextMenuTemplate(context({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'] }), actions)
    click(items.find((i) => i.label === 'ten'))
    expect(actions.replace).toHaveBeenCalledWith('ten')
    click(items.find((i) => i.label === 'Add to Dictionary'))
    expect(actions.addToDictionary).toHaveBeenCalledWith('teh')
  })
})

// ---------- pickMenuTargetWindow (pure, GRO-2197) ----------

/** The structural slice the picker needs — no Electron anywhere. */
const fakeWin = (id: number, destroyed = false) => ({ webContents: { id }, isDestroyed: () => destroyed })

describe('pickMenuTargetWindow', () => {
  it('the OS-focused window always wins', () => {
    const focused = fakeWin(2)
    expect(pickMenuTargetWindow(focused, [fakeWin(1), focused, fakeWin(3)], 3)).toBe(focused)
  })

  it('no focused window (macOS, app not frontmost) → the last-focused live window', () => {
    const last = fakeWin(2)
    expect(pickMenuTargetWindow(null, [fakeWin(1), last, fakeWin(3)], 2)).toBe(last)
  })

  it('a destroyed last-focused window falls back to a live one', () => {
    const live = fakeWin(1)
    expect(pickMenuTargetWindow(null, [live, fakeWin(2, true)], 2)).toBe(live)
  })

  it('no last-focused id recorded yet → any live window (never a destroyed one)', () => {
    const live = fakeWin(2)
    expect(pickMenuTargetWindow(null, [fakeWin(1, true), live], undefined)).toBe(live)
  })

  it('a destroyed focused window is not a target either — the fallback chain runs', () => {
    const live = fakeWin(1)
    expect(pickMenuTargetWindow(fakeWin(9, true), [live], undefined)).toBe(live)
  })

  it('no windows at all → undefined', () => {
    expect(pickMenuTargetWindow(null, [], 1)).toBeUndefined()
  })
})

// ---------- createMenuHandlers, against fakes ----------

let dir: string
let store: Store
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yd-menu-'))
  store = createStore(path.join(dir, 'yaseendraw.json'))
})
afterEach(async () => {
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

const ENTRY: WindowEntry = { id: 'w1', root: '/vaults/notes', file: '/vaults/notes/a.excalidraw', tabs: ['/vaults/notes/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } }

function makeHandlers(focused?: { id: number; send: ReturnType<typeof vi.fn> }) {
  // `openRecentBeside` is the window manager's door (YAZ-1767 D1); the probe/prune/bump rules are windows.test's.
  const windows = { idFor: vi.fn(), openRecentBeside: vi.fn(() => true), duplicateWindow: vi.fn() }
  const host: MenuHost = {
    focusedWebContents: () => focused,
    zoom: vi.fn(),
    openExternal: vi.fn(),
  }
  const handlers = createMenuHandlers(store, { ...windows, idFor: (wc: { id: number }) => (wc.id === 7 ? 'w1' : undefined) }, host)
  return { handlers, windows, host }
}

describe('createMenuHandlers', () => {
  it('newWindow duplicates the focused window entry', () => {
    store.upsertWindow(ENTRY)
    const wc = { id: 7, send: vi.fn() }
    const { handlers, windows } = makeHandlers(wc)
    handlers.newWindow()
    expect(windows.duplicateWindow).toHaveBeenCalledWith(ENTRY)
  })

  it('newWindow with no focused window is a no-op', () => {
    const { handlers, windows } = makeHandlers(undefined)
    handlers.newWindow()
    expect(windows.duplicateWindow).not.toHaveBeenCalled()
  })

  it('openFolder tells the focused renderer to run its pick-folder flow', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.openFolder()
    expect(wc.send).toHaveBeenCalledWith(CONTRACT.menu.onOpenFolder.channel)
  })

  it('settings tells the focused renderer to open its settings dialog (YAZ-1679)', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.settings()
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onSettings.channel)

    const { handlers: unfocused } = makeHandlers(undefined)
    expect(() => unfocused.settings()).not.toThrow()
  })

  it('search tells the focused renderer to focus its search bar (D4, YAZ-804)', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.search()
    expect(wc.send).toHaveBeenCalledWith(CONTRACT.menu.onSearch.channel)

    const { handlers: unfocused } = makeHandlers(undefined)
    expect(() => unfocused.search()).not.toThrow()
  })

  it('switchVault tells the focused renderer to open its vault switcher (YAZ-1767 D8)', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.switchVault()
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onSwitchVault.channel)

    const { handlers: unfocused } = makeHandlers(undefined)
    expect(() => unfocused.switchVault()).not.toThrow()
  })

  it('openRecent from a vault window goes through the one open-recent door (YAZ-1913 D1), never swapping this window', () => {
    store.upsertWindow(ENTRY)
    const wc = { id: 7, send: vi.fn() }
    const { handlers, windows } = makeHandlers(wc)
    handlers.openRecent('/vaults/work')
    expect(windows.openRecentBeside).toHaveBeenCalledExactlyOnceWith('/vaults/work')
    expect(wc.send).not.toHaveBeenCalled()
    // The door's verdict (dead folder → false) is the manager's business; the menu ignores it.
    windows.openRecentBeside.mockReturnValueOnce(false)
    expect(() => handlers.openRecent('/vaults/gone')).not.toThrow()
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('openRecent from a Welcome window fills that window in place (menu:open-root), not the door', () => {
    store.upsertWindow({ ...ENTRY, root: null, file: null, tabs: [] })
    const wc = { id: 7, send: vi.fn() }
    const { handlers, windows } = makeHandlers(wc)
    handlers.openRecent('/vaults/work')
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onOpenRoot.channel, '/vaults/work')
    expect(windows.openRecentBeside).not.toHaveBeenCalled()
  })

  it('closeTab / nextTab / prevTab go to the focused renderer only (GRO-2232); no focused window is a no-op', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.closeTab()
    expect(wc.send).toHaveBeenLastCalledWith(CONTRACT.menu.onCloseTab.channel)
    handlers.nextTab()
    expect(wc.send).toHaveBeenLastCalledWith(CONTRACT.menu.onNextTab.channel)
    handlers.prevTab()
    expect(wc.send).toHaveBeenLastCalledWith(CONTRACT.menu.onPrevTab.channel)
    expect(wc.send).toHaveBeenCalledTimes(3)

    const { handlers: unfocused } = makeHandlers(undefined)
    expect(() => {
      unfocused.closeTab()
      unfocused.nextTab()
      unfocused.prevTab()
    }).not.toThrow()
  })

  it('toggleSidebar tells only the focused renderer to run its window-local toggle', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.toggleSidebar()
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onToggleSidebar.channel)

    const { handlers: unfocused } = makeHandlers(undefined)
    expect(() => unfocused.toggleSidebar()).not.toThrow()
  })

  it('zoom is applied by main on the focused window, never pushed to the renderer (YAZ-1710)', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers, host } = makeHandlers(wc)
    handlers.zoom(1)
    expect(host.zoom).toHaveBeenCalledExactlyOnceWith(1)
    expect(wc.send).not.toHaveBeenCalled()

    const { handlers: unfocused, host: unfocusedHost } = makeHandlers(undefined)
    unfocused.zoom(-1)
    expect(unfocusedHost.zoom).toHaveBeenCalledExactlyOnceWith(-1)
  })

  it('openHelp opens the repo README', () => {
    const { handlers, host } = makeHandlers(undefined)
    handlers.openHelp()
    expect(host.openExternal).toHaveBeenCalledWith(HELP_URL)
    expect(HELP_URL).toBe('https://github.com/trevor-grow-profit/trevor-draw-app#readme')
  })
})

// ---------- subscribeMenuRebuild ----------

describe('createMenuHandlers — the three canvas gestures (🔒 YAZ-1775 D10, 🔒 YAZ-1775 D3)', () => {
  it('exportImage, exportDrawing and canvasBackground push to the focused renderer, colour and all', () => {
    const wc = { id: 7, send: vi.fn() }
    const { handlers } = makeHandlers(wc)
    handlers.exportImage()
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onExportImage.channel)
    wc.send.mockClear()
    // Same gating and the same delivery as the image export — one channel apart.
    handlers.exportDrawing()
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onExportDrawing.channel)
    wc.send.mockClear()
    handlers.canvasBackground('#fffce8')
    expect(wc.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.menu.onCanvasBackground.channel, '#fffce8')
  })

  it('with no window at all they are silent no-ops', () => {
    const { handlers } = makeHandlers(undefined)
    expect(() => {
      handlers.exportImage()
      handlers.exportDrawing()
      handlers.canvasBackground('#ffffff')
    }).not.toThrow()
  })
})

describe('subscribeMenuRebuildOnActiveFile (🔒 YAZ-1775 D10)', () => {
  it('rebuilds when a window`s active file changes, and not for other writes', () => {
    store.upsertWindow(ENTRY)
    const rebuild = vi.fn()
    subscribeMenuRebuildOnActiveFile(store, rebuild)

    store.setSidebarWidth(300)
    store.pushRecent('/vaults/notes')
    expect(rebuild).not.toHaveBeenCalled()

    store.upsertWindow({ ...ENTRY, file: '/vaults/notes/b.excalidraw', tabs: ['/vaults/notes/b.excalidraw'] })
    expect(rebuild).toHaveBeenCalledTimes(1)
    // A write that leaves every window's active file alone is not a reason to rebuild.
    store.upsertWindow({ ...ENTRY, file: '/vaults/notes/b.excalidraw', tabs: ['/vaults/notes/b.excalidraw'], sidebarCollapsed: true })
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('returns an unsubscribe', () => {
    store.upsertWindow(ENTRY)
    const rebuild = vi.fn()
    subscribeMenuRebuildOnActiveFile(store, rebuild)()
    store.upsertWindow({ ...ENTRY, file: null, tabs: [] })
    expect(rebuild).not.toHaveBeenCalled()
  })
})

describe('subscribeMenuRebuild', () => {
  it('rebuilds when recents change, not on other writes', () => {
    const rebuild = vi.fn()
    subscribeMenuRebuild(store, rebuild)

    store.setSidebarWidth(321)
    store.setSettings(store.get().settings)
    store.upsertWindow(ENTRY)
    store.setFolder('/vaults/notes', { lastFile: null })
    expect(rebuild).not.toHaveBeenCalled()

    store.pushRecent('/vaults/notes')
    expect(rebuild).toHaveBeenCalledTimes(1)
    store.pushRecent('/vaults/work')
    expect(rebuild).toHaveBeenCalledTimes(2)
  })

  it('returns an unsubscribe', () => {
    const rebuild = vi.fn()
    const off = subscribeMenuRebuild(store, rebuild)
    off()
    store.pushRecent('/vaults/notes')
    expect(rebuild).not.toHaveBeenCalled()
  })
})
