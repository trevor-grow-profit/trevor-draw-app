/**
 * The vault switcher (YAZ-1767): the sidebar header's trigger + panel. Pins the locked decisions —
 * D3 the current vault is a row (`aria-current`), D4 "Open folder…" last, D5 dead folders stay in
 * an open panel, D6 the one-line trigger, D7 the filter/keyboard model (ranking, default
 * highlight skipping the current vault, clamp, Enter, Esc, focus never leaving the input), D8 the
 * ⌘O request. Every CLICK goes through the mocked `window.yaseenDraw.window.openRecent` — the one
 * back-end door (D1). The right-click menu (YAZ-1941, ported from Docs YAZ-1798) is pinned below:
 * its "Open in this window" is the only in-place open, through the `onOpenHere` prop. Display
 * names, their inline field and the one-line rows' ⓘ path tooltip (YAZ-2056, ported from Docs
 * YAZ-1974) are pinned last, over the REAL `storage` on a fake bridge, so a name set in one test
 * never leaks into the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { defaultAppState, defaultFolderState, type AppState, type RecentRoots } from '@shared/types'
import { storage } from '../lib/storage'
import { MISSING_TEXT, NO_MATCH_TEXT, OPEN_FOLDER_TEXT, OPEN_HERE_TEXT, VaultSwitcher, defaultHighlight, rankVaultRows } from './VaultSwitcher'

const ROOT = '/v/Notes'
const NOW = 1_700_000_000_000
/** MRU order: the current vault first (it always is — the renderer bumps it on open), then three others; two share the basename "Notes". */
const RECENTS: RecentRoots = [
  { path: ROOT, lastOpened: NOW - 60_000 },
  { path: '/w/Notes', lastOpened: NOW - 2 * 3_600_000 },
  { path: '/v/Archive', lastOpened: NOW - 86_400_000 },
  { path: '/v/Notes Archive', lastOpened: NOW - 3 * 86_400_000 },
]

let openRecent: ReturnType<typeof vi.fn>
let setFolder: ReturnType<typeof vi.fn>
/** Main's `state.onChange` broadcast into this window — another window's write landing here. */
let broadcast: (state: AppState) => void
let recentsSpy: ReturnType<typeof vi.spyOn>
let root: Root | null = null
let container: HTMLElement | null = null

/** Seeds the storage cache with display names (Docs YAZ-1974 D3), path → name. */
const withNames = (names: Record<string, string>): AppState => ({
  ...defaultAppState(),
  folders: Object.fromEntries(Object.entries(names).map(([path, name]) => [path, { ...defaultFolderState(), name }])),
})

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  openRecent = vi.fn(async () => true)
  setFolder = vi.fn(async () => undefined)
  const state = {
    get: async () => defaultAppState(),
    setFolder,
    onChange: (listener: (s: AppState) => void) => {
      broadcast = listener
      return () => undefined
    },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: { window: { openRecent, identity: async () => ({}) }, state }, configurable: true, writable: true })
  await storage.init()
  recentsSpy = vi.spyOn(storage, 'getRecentRoots').mockReturnValue(RECENTS)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  recentsSpy.mockRestore()
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  vi.useRealTimers()
})

type Props = Parameters<typeof VaultSwitcher>[0]

function render(over: Partial<Props> = {}) {
  const props: Props = {
    root: ROOT,
    onPickFolder: vi.fn(),
    pickDisabled: false,
    openRequest: 0,
    onOpenHere: vi.fn(async () => true),
    onReveal: vi.fn(),
    onOpenVsCode: vi.fn(),
    onNotice: vi.fn(),
    ...over,
  }
  const draw = (next: Partial<Props>) => {
    Object.assign(props, next)
    act(() =>
      root?.render(
        <StrictMode>
          {/* The real header is the anchor (D5): the trigger's parent rect is what the panel spans. */}
          <div className="sidebar__header">
            <VaultSwitcher {...props} />
          </div>
        </StrictMode>,
      ),
    )
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  draw({})
  return { props, rerender: draw, el: container }
}

const trigger = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.sidebar__root')!
const panel = (el: HTMLElement) => el.querySelector<HTMLElement>('.ctx-menu--panel')
const filter = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.vault-switcher__filter')!
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.vault-switcher__rows .vault-switcher__row')]
const openFolderRow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.vault-switcher__open')!
const activeRow = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.vault-switcher__row--active')
const names = (el: HTMLElement) => rows(el).map((r) => r.querySelector('.vault-switcher__name')?.textContent)
const tooltip = () => document.querySelector<HTMLElement>('[role="tooltip"]')
const hoverInfo = (row: HTMLElement) => act(() => void row.querySelector('.vault-switcher__info')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const leaveInfo = (row: HTMLElement) => act(() => void row.querySelector('.vault-switcher__info')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: row })))
/** A row's full path, read the only way the panel shows it: its ⓘ tooltip (Docs YAZ-1974 D2). */
const pathOf = (row: HTMLElement) => {
  hoverInfo(row)
  const path = tooltip()?.textContent
  leaveInfo(row)
  return path
}

const openPanel = (el: HTMLElement) => act(() => trigger(el).click())
const key = (el: HTMLElement, k: string) => act(() => void filter(el).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
/** Types into an input the way React sees it: the native value setter, then an `input` event. */
const fill = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const type = (el: HTMLElement, value: string) => fill(filter(el), value)
/** The vault right-click menu (YAZ-1798). */
const vaultMenu = () => document.querySelector<HTMLElement>('.ctx-overlay .ctx-menu')
const menuLabels = () => [...(vaultMenu()?.querySelectorAll('.ctx-menu__item') ?? [])].map((b) => b.textContent)
const menuItem = (label: string) => [...(vaultMenu()?.querySelectorAll<HTMLButtonElement>('.ctx-menu__item') ?? [])].find((b) => b.textContent === label)!
/** Dispatches a right-click and reports whether the native menu was swallowed (G1). */
const rightClick = (target: HTMLElement) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
  act(() => void target.dispatchEvent(e))
  return e.defaultPrevented
}
const pick = (label: string) => act(() => menuItem(label).click())
/** Settles the `openRecent` promise chain inside act. */
const settle = () => act(async () => {})

describe('VaultSwitcher: the trigger (D6)', () => {
  it('is one line — the bold basename and a chevron, no "change" — with the full path as its tooltip', () => {
    const { el } = render()
    const t = trigger(el)
    expect(t.querySelector('.sidebar__root-name')?.textContent).toBe('Notes')
    expect(t.querySelector('.sidebar__root-hint svg')?.getAttribute('style') ?? '').not.toContain('rotate')
    expect(t.querySelector('.sidebar__root-hint')?.getAttribute('aria-hidden')).toBe('true')
    expect(t.textContent).not.toContain('change')
    expect(t.title).toBe(ROOT)
    expect(t.getAttribute('aria-haspopup')).toBe('menu')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(t.disabled).toBe(false)
  })

  it('click opens the panel (chevron flips, aria-expanded), a second click closes it', () => {
    const { el } = render()
    openPanel(el)
    expect(panel(el)).not.toBeNull()
    expect(trigger(el).getAttribute('aria-expanded')).toBe('true')
    expect(trigger(el).querySelector('.sidebar__root-hint svg')?.getAttribute('style')).toContain('rotate(180deg)')
    // The surface closes on ANY window mousedown; the trigger swallows its own so the click that
    // follows toggles closed instead of close-then-reopen.
    act(() => void trigger(el).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(panel(el)).not.toBeNull()
    openPanel(el)
    expect(panel(el)).toBeNull()
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false')
  })

  it('a mousedown anywhere else closes the panel', () => {
    const { el } = render()
    openPanel(el)
    act(() => void window.dispatchEvent(new MouseEvent('mousedown')))
    expect(panel(el)).toBeNull()
  })

  it('the panel hangs off the header rect (D5): a ctx-menu with the panel class, at least the header width (Docs YAZ-1974 D7: it grows to fit a long name)', () => {
    const { el } = render()
    const header = el.querySelector<HTMLElement>('.sidebar__header')!
    header.getBoundingClientRect = () => ({ left: 0, top: 0, right: 260, bottom: 41, width: 260, height: 41, x: 0, y: 0, toJSON: () => ({}) })
    openPanel(el)
    const p = panel(el)!
    expect(p.classList.contains('ctx-menu')).toBe(true)
    expect(p.getAttribute('role')).toBe('menu')
    expect(p.style.minWidth).toBe('260px')
    expect(p.style.width).toBe('')
  })
})

describe('VaultSwitcher: the rows (D3/D4/D5)', () => {
  it('lists every recent vault in MRU order — the current vault included and marked aria-current — with name and relative time; Open folder… is the last row', () => {
    const { el } = render()
    openPanel(el)
    expect(names(el)).toEqual(['Notes', 'Notes', 'Archive', 'Notes Archive'])
    const [current, other] = rows(el)
    expect(current.getAttribute('aria-current')).toBe('true')
    expect(other.getAttribute('aria-current')).toBeNull()
    expect(current.querySelector('.vault-switcher__when')?.textContent).toBe('1 minute ago')
    expect(other.querySelector('.vault-switcher__when')?.textContent).toBe('2 hours ago')
    // Open folder… is outside the rows list, after it, and reads as the last menu item.
    const items = [...panel(el)!.querySelectorAll('[role="menuitem"]')]
    expect(items.at(-1)?.textContent).toBe(OPEN_FOLDER_TEXT)
    expect(items).toHaveLength(5)
  })

  it('rows are read fresh from storage on EVERY open', () => {
    const { el } = render()
    openPanel(el)
    expect(names(el)).toHaveLength(4)
    openPanel(el)
    recentsSpy.mockReturnValue(RECENTS.slice(0, 2))
    openPanel(el)
    expect(names(el)).toEqual(['Notes', 'Notes'])
    expect(recentsSpy).toHaveBeenCalledTimes(2)
  })

  it('clicking a row — the current vault too (one rule for every row) — opens it through window.openRecent and closes the panel', async () => {
    const { el } = render()
    openPanel(el)
    act(() => rows(el)[0].click())
    await settle()
    expect(openRecent).toHaveBeenCalledExactlyOnceWith(ROOT)
    expect(panel(el)).toBeNull()
  })

  it('a dead folder (openRecent → false): the row is disabled, its time slot says Folder not found, the panel STAYS open and the filter keeps focus', async () => {
    openRecent.mockResolvedValueOnce(false)
    const { el } = render()
    openPanel(el)
    act(() => rows(el)[2].click())
    await settle()
    expect(openRecent).toHaveBeenCalledWith('/v/Archive')
    expect(panel(el)).not.toBeNull()
    const dead = rows(el)[2]
    expect(dead.disabled).toBe(true)
    expect(dead.querySelector('.vault-switcher__when')?.textContent).toBe(MISSING_TEXT)
    expect(dead.querySelector('.vault-switcher__when')?.classList.contains('vault-switcher__when--missing')).toBe(true)
    expect(document.activeElement).toBe(filter(el))
    // A dead row cannot be activated again by keyboard either: the highlight (still on the default,
    // row 1) walks onto it, Enter is a no-op, and the panel is still open.
    key(el, 'ArrowDown')
    expect(activeRow(el)).toBe(dead)
    key(el, 'Enter')
    await settle()
    expect(openRecent).toHaveBeenCalledTimes(1)
    expect(panel(el)).not.toBeNull()
  })

  it('Open folder… runs onPickFolder and closes the panel; disabled while pickDisabled', () => {
    const { el, props, rerender } = render()
    openPanel(el)
    act(() => openFolderRow(el).click())
    expect(props.onPickFolder).toHaveBeenCalledTimes(1)
    expect(panel(el)).toBeNull()
    expect(openRecent).not.toHaveBeenCalled()

    rerender({ pickDisabled: true })
    openPanel(el)
    expect(openFolderRow(el).disabled).toBe(true)
    act(() => openFolderRow(el).click())
    expect(props.onPickFolder).toHaveBeenCalledTimes(1)
    expect(panel(el)).not.toBeNull()
  })
})

describe('VaultSwitcher: filter + keyboard (D7)', () => {
  it('the filter is first, autofocused on open, with the placeholder and label', () => {
    const { el } = render()
    openPanel(el)
    const input = filter(el)
    expect(panel(el)!.querySelector('input, button')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.placeholder).toBe('Switch vault…')
    expect(input.getAttribute('aria-label')).toBe('Switch vault')
    expect(input.value).toBe('')
  })

  it('the query resets on every open', async () => {
    const { el } = render()
    openPanel(el)
    await type(el, 'arch')
    expect(filter(el).value).toBe('arch')
    openPanel(el)
    openPanel(el)
    expect(filter(el).value).toBe('')
  })

  it('ranks like the [[ picker over basenames: exact, then prefix, then substring; an empty query is MRU order', async () => {
    const { el } = render()
    openPanel(el)
    await type(el, 'notes')
    expect(names(el)).toEqual(['Notes', 'Notes', 'Notes Archive'])
    await type(el, 'arch')
    expect(names(el)).toEqual(['Archive', 'Notes Archive'])
    await type(el, '')
    expect(names(el)).toEqual(['Notes', 'Notes', 'Archive', 'Notes Archive'])
  })

  it('with an empty query the highlight starts on the first row that is NOT the current vault (⌘O ⏎ = last-used other vault)', () => {
    const { el } = render()
    openPanel(el)
    expect(activeRow(el)).toBe(rows(el)[1])
    expect(pathOf(activeRow(el)!)).toBe('/w/Notes')
  })

  it('when every row is the current vault the highlight starts on the first row', () => {
    recentsSpy.mockReturnValue([RECENTS[0]])
    const { el } = render()
    openPanel(el)
    expect(activeRow(el)).toBe(rows(el)[0])
  })

  it('a typed query moves the highlight to the top match', async () => {
    const { el } = render()
    openPanel(el)
    await type(el, 'arch')
    expect(activeRow(el)).toBe(rows(el)[0])
    expect(pathOf(activeRow(el)!)).toBe('/v/Archive')
  })

  it('no match: a muted "No matching vaults" line above Open folder…, which is always visible and takes the highlight', async () => {
    const { el } = render()
    openPanel(el)
    await type(el, 'zzz')
    expect(rows(el)).toHaveLength(0)
    const empty = panel(el)!.querySelector('.vault-switcher__empty')
    expect(empty?.textContent).toBe(NO_MATCH_TEXT)
    expect((empty!.compareDocumentPosition(openFolderRow(el)) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect(openFolderRow(el).classList.contains('vault-switcher__row--active')).toBe(true)
  })

  it('↑/↓ move the highlight and CLAMP at both ends — never wrap', () => {
    const { el } = render()
    openPanel(el)
    key(el, 'ArrowUp')
    expect(activeRow(el)).toBe(rows(el)[0])
    key(el, 'ArrowUp')
    expect(activeRow(el)).toBe(rows(el)[0])
    for (let i = 0; i < 4; i++) key(el, 'ArrowDown')
    expect(activeRow(el)).toBe(openFolderRow(el))
    key(el, 'ArrowDown')
    expect(activeRow(el)).toBe(openFolderRow(el))
    key(el, 'ArrowUp')
    expect(activeRow(el)).toBe(rows(el)[3])
    // Arrow keys never leave the input.
    expect(document.activeElement).toBe(filter(el))
  })

  it('hover moves the highlight too', () => {
    const { el } = render()
    openPanel(el)
    act(() => rows(el)[3].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(activeRow(el)).toBe(rows(el)[3])
    act(() => openFolderRow(el).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(activeRow(el)).toBe(openFolderRow(el))
  })

  it('Enter opens the highlighted row through window.openRecent (the default: the last-used OTHER vault) and closes the panel', async () => {
    const { el } = render()
    openPanel(el)
    key(el, 'Enter')
    await settle()
    expect(openRecent).toHaveBeenCalledExactlyOnceWith('/w/Notes')
    expect(panel(el)).toBeNull()
  })

  it('Enter after typing opens the top match', async () => {
    const { el } = render()
    openPanel(el)
    await type(el, 'notes arch')
    key(el, 'Enter')
    await settle()
    expect(openRecent).toHaveBeenCalledExactlyOnceWith('/v/Notes Archive')
  })

  it('⇧⏎ / ⇧-click open the vault IN this window (Docs YAZ-1974 D8): onOpenHere, never openRecent; on the current vault they are a plain ⏎', async () => {
    const { el, props } = render()
    openPanel(el)
    act(() => void filter(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })))
    await settle()
    expect(props.onOpenHere).toHaveBeenCalledExactlyOnceWith('/w/Notes')
    expect(openRecent).not.toHaveBeenCalled()
    expect(panel(el)).toBeNull()

    openPanel(el)
    act(() => void rows(el)[2].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })))
    await settle()
    expect(props.onOpenHere).toHaveBeenLastCalledWith('/v/Archive')
    expect(openRecent).not.toHaveBeenCalled()

    openPanel(el)
    act(() => void rows(el)[0].dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true })))
    await settle()
    expect(openRecent).toHaveBeenCalledExactlyOnceWith(ROOT)
    expect(props.onOpenHere).toHaveBeenCalledTimes(2)
  })

  it('holding ⇧ says so on the highlighted row (Docs YAZ-1974 D9): "Open here" in its time slot, never on the current vault; released, the time is back', () => {
    const { el } = render()
    openPanel(el)
    const shift = (type: 'keydown' | 'keyup', shiftKey: boolean) => act(() => void window.dispatchEvent(new KeyboardEvent(type, { key: 'Shift', shiftKey })))
    const when = (row: HTMLElement) => row.querySelector('.vault-switcher__when')?.textContent
    shift('keydown', true)
    expect(when(activeRow(el)!)).toBe(OPEN_HERE_TEXT)
    expect(rows(el).filter((r) => when(r) === OPEN_HERE_TEXT)).toHaveLength(1)
    key(el, 'ArrowUp')
    expect(activeRow(el)).toBe(rows(el)[0])
    expect(when(rows(el)[0])).toBe('1 minute ago')
    shift('keyup', false)
    key(el, 'ArrowDown')
    expect(when(activeRow(el)!)).not.toBe(OPEN_HERE_TEXT)
  })

  it('⇧ never reaches Open folder… or a dead row (Docs YAZ-1974 D8/D9): no "Open here" on either, ⇧⏎ on Open folder… still picks, a dead row stays inert', async () => {
    openRecent.mockResolvedValueOnce(false)
    const { el, props } = render()
    openPanel(el)
    act(() => rows(el)[2].click())
    await settle()
    const shiftEnter = () => act(() => void filter(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })))
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })))
    key(el, 'ArrowDown')
    expect(activeRow(el)).toBe(rows(el)[2])
    expect(activeRow(el)?.querySelector('.vault-switcher__when')?.textContent).toBe(MISSING_TEXT)
    shiftEnter()
    await settle()
    expect(props.onOpenHere).not.toHaveBeenCalled()
    act(() => openFolderRow(el).dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(panel(el)!.textContent).not.toContain(OPEN_HERE_TEXT)
    shiftEnter()
    expect(props.onPickFolder).toHaveBeenCalledTimes(1)
    expect(props.onOpenHere).not.toHaveBeenCalled()
    expect(openRecent).toHaveBeenCalledTimes(1)
  })

  it('the held-⇧ cue ends when the window loses focus mid-press (Docs YAZ-1974 D9)', () => {
    const { el } = render()
    openPanel(el)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })))
    expect(activeRow(el)?.querySelector('.vault-switcher__when')?.textContent).toBe(OPEN_HERE_TEXT)
    act(() => void window.dispatchEvent(new FocusEvent('blur')))
    expect(panel(el)!.textContent).not.toContain(OPEN_HERE_TEXT)
  })

  it('Enter on Open folder… runs the picker; not while pickDisabled', () => {
    const { el, props, rerender } = render()
    openPanel(el)
    for (let i = 0; i < 5; i++) key(el, 'ArrowDown')
    key(el, 'Enter')
    expect(props.onPickFolder).toHaveBeenCalledTimes(1)
    expect(openRecent).not.toHaveBeenCalled()
    expect(panel(el)).toBeNull()

    rerender({ pickDisabled: true })
    openPanel(el)
    for (let i = 0; i < 5; i++) key(el, 'ArrowDown')
    key(el, 'Enter')
    expect(props.onPickFolder).toHaveBeenCalledTimes(1)
    expect(panel(el)).not.toBeNull()
  })

  it('Esc closes the panel on the first press (the menu convention, not the search bar\'s two-press rule)', async () => {
    const { el } = render()
    openPanel(el)
    await type(el, 'arch')
    key(el, 'Escape')
    expect(panel(el)).toBeNull()
  })

  it('clicking a row never steals focus from the filter (mousedown is swallowed)', () => {
    const { el } = render()
    openPanel(el)
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    rows(el)[1].dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(filter(el))
  })
})

describe('VaultSwitcher: ⌘O (D8)', () => {
  it('each new openRequest value TOGGLES: opens with the filter focused, a second one closes, a third reopens with the query reset; 0 requests nothing', async () => {
    const { el, rerender } = render()
    expect(panel(el)).toBeNull()
    rerender({ openRequest: 1 })
    expect(panel(el)).not.toBeNull()
    expect(document.activeElement).toBe(filter(el))
    await type(el, 'arch')
    // Still open: a second ⌘O closes it (the ⌘K rule) — no re-read of the rows.
    rerender({ openRequest: 2 })
    expect(panel(el)).toBeNull()
    expect(recentsSpy).toHaveBeenCalledTimes(1)
    // A third opens afresh: rows re-read, query cleared, filter focused.
    rerender({ openRequest: 3 })
    expect(panel(el)).not.toBeNull()
    expect(filter(el).value).toBe('')
    expect(document.activeElement).toBe(filter(el))
    expect(recentsSpy).toHaveBeenCalledTimes(2)
  })

  it('a request already consumed does not reopen after Esc; the next one does', () => {
    const { el, rerender } = render({ openRequest: 3 })
    expect(panel(el)).not.toBeNull()
    key(el, 'Escape')
    expect(panel(el)).toBeNull()
    rerender({ openRequest: 3 })
    expect(panel(el)).toBeNull()
    rerender({ openRequest: 4 })
    expect(panel(el)).not.toBeNull()
  })
})

describe('VaultSwitcher: pure helpers', () => {
  const rowsOf = (...paths: string[]) => paths.map((path, i) => ({ name: path.slice(path.lastIndexOf('/') + 1), folder: path.slice(path.lastIndexOf('/') + 1), path, lastOpened: i }))

  it('rankVaultRows: empty query keeps MRU order, otherwise exact > prefix > substring, uncapped', () => {
    const list = rowsOf('/a/Notes', '/b/Old Notes', '/c/Notes Archive', '/d/Other', '/e/n1', '/f/n2', '/g/n3', '/h/n4', '/i/n5', '/j/n6')
    expect(rankVaultRows(list, '  ').map((r) => r.path)).toEqual(list.map((r) => r.path))
    expect(rankVaultRows(list, 'notes').map((r) => r.path)).toEqual(['/a/Notes', '/c/Notes Archive', '/b/Old Notes'])
    // The [[ picker caps at 8; the switcher shows every match.
    expect(rankVaultRows(list, 'n')).toHaveLength(9)
  })

  it('rankVaultRows matches the display name AND the folder name, one row per vault at its best rank (Docs YAZ-1974 D6)', () => {
    const [wiki, notes, lead] = rowsOf('/v/business-wiki-MASTER', '/v/Notes', '/v/leadnurtureai')
    const list = [{ ...wiki, name: 'Business Wiki' }, { ...notes, name: 'Wiki Notes' }, lead]
    expect(rankVaultRows(list, 'busi').map((r) => r.path)).toEqual(['/v/business-wiki-MASTER']) // display-name prefix (and folder prefix: still once)
    expect(rankVaultRows(list, 'wiki-MASTER').map((r) => r.path)).toEqual(['/v/business-wiki-MASTER']) // folder-name match
    // "wiki": Wiki Notes is a prefix match, Business Wiki a substring on both names — once, after it.
    expect(rankVaultRows(list, 'wiki').map((r) => r.path)).toEqual(['/v/Notes', '/v/business-wiki-MASTER'])
    expect(rankVaultRows(list, 'notes').map((r) => r.path)).toEqual(['/v/Notes']) // the folder name still finds a renamed vault
    expect(rankVaultRows(list, 'lead').map((r) => r.path)).toEqual(['/v/leadnurtureai']) // un-renamed: as before
  })

  it('defaultHighlight: skips the current root on an empty query, 0 otherwise (which is Open folder… when nothing matches)', () => {
    const list = rowsOf('/v/cur', '/v/a', '/v/b')
    expect(defaultHighlight(list, '', '/v/cur')).toBe(1)
    expect(defaultHighlight(list, '', '/v/none')).toBe(0)
    expect(defaultHighlight(rowsOf('/v/cur'), '', '/v/cur')).toBe(0)
    expect(defaultHighlight([], '', '/v/cur')).toBe(0)
    expect(defaultHighlight(list, 'a', '/v/cur')).toBe(0)
    expect(defaultHighlight([], 'zzz', '/v/cur')).toBe(0)
  })
})

describe('VaultSwitcher: the right-click menu (YAZ-1798)', () => {
  const OTHER = RECENTS[2].path // '/v/Archive'
  const otherRow = (el: HTMLElement) => rows(el)[2]

  it('the trigger opens the CURRENT vault\'s menu (no Open in this window, no Remove) and leaves the panel closed; the native menu is swallowed', () => {
    const { el } = render()
    expect(rightClick(trigger(el))).toBe(true)
    expect(menuLabels()).toEqual(['Set display name', 'Copy vault name', 'Copy path', 'Reveal in Finder', 'Open in VS Code'])
    expect(panel(el)).toBeNull()
  })

  it('the current vault\'s own row gets the same five; another row gets all eight — and the highlight never moves', () => {
    const { el } = render()
    openPanel(el)
    const before = activeRow(el)
    rightClick(rows(el)[0])
    expect(menuLabels()).toEqual(['Set display name', 'Copy vault name', 'Copy path', 'Reveal in Finder', 'Open in VS Code'])
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    rightClick(otherRow(el))
    expect(menuLabels()).toEqual(['Open in this window', 'Set display name', 'Copy vault name', 'Copy path', 'Reveal in Finder', 'Open in VS Code', 'Remove from recent vaults'])
    expect(activeRow(el)).toBe(before)
  })

  it('Reveal in Finder / Open in VS Code hand the row\'s path to the Sidebar\'s verbs; the menu closes, the panel stays', () => {
    const { el, props } = render()
    openPanel(el)
    rightClick(otherRow(el))
    pick('Reveal in Finder')
    expect(props.onReveal).toHaveBeenCalledWith(OTHER)
    expect(vaultMenu()).toBeNull()
    expect(panel(el)).not.toBeNull()
    rightClick(otherRow(el))
    pick('Open in VS Code')
    expect(props.onOpenVsCode).toHaveBeenCalledWith(OTHER)
  })

  it('Copy vault name writes the folder name of an un-renamed vault and confirms through onNotice', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { el, props } = render()
    openPanel(el)
    rightClick(otherRow(el))
    pick('Copy vault name')
    await settle()
    expect(writeText).toHaveBeenCalledWith('Archive')
    expect(props.onNotice).toHaveBeenCalledWith('Copied vault name')
  })

  it('Remove from recent vaults forgets the MRU entry and drops the row at once; the panel stays with the filter focused', () => {
    const remove = vi.spyOn(storage, 'removeRecentRoot').mockImplementation(() => undefined)
    const { el } = render()
    openPanel(el)
    rightClick(otherRow(el))
    pick('Remove from recent vaults')
    expect(remove).toHaveBeenCalledWith(OTHER)
    expect(rows(el).map(pathOf)).not.toContain(OTHER)
    expect(panel(el)).not.toBeNull()
    expect(document.activeElement).toBe(filter(el))
    remove.mockRestore()
  })

  it('Open in this window goes through onOpenHere (never openRecent) and closes the panel on success', async () => {
    const { el, props } = render()
    openPanel(el)
    rightClick(otherRow(el))
    pick('Open in this window')
    await settle()
    expect(props.onOpenHere).toHaveBeenCalledWith(OTHER)
    expect(openRecent).not.toHaveBeenCalled()
    expect(panel(el)).toBeNull()
  })

  it('Open in this window on a folder that is gone (false) greys the row like a click does; the panel stays — and the dead row then gets no menu', async () => {
    const { el } = render({ onOpenHere: vi.fn(async () => false) })
    openPanel(el)
    rightClick(otherRow(el))
    pick('Open in this window')
    await settle()
    expect(otherRow(el).disabled).toBe(true)
    expect(otherRow(el).querySelector('.vault-switcher__when')?.textContent).toBe(MISSING_TEXT)
    expect(panel(el)).not.toBeNull()
    expect(rightClick(otherRow(el))).toBe(true)
    expect(vaultMenu()).toBeNull()
  })

  it('layers (D4): Esc closes only the menu, the next Esc the panel; ↑/↓/⏎ never reach the panel while the menu stands', () => {
    const { el } = render()
    openPanel(el)
    const before = activeRow(el)
    rightClick(otherRow(el))
    key(el, 'ArrowDown')
    key(el, 'Enter')
    expect(activeRow(el)).toBe(before)
    expect(openRecent).not.toHaveBeenCalled()
    key(el, 'Escape')
    expect(vaultMenu()).toBeNull()
    expect(panel(el)).not.toBeNull()
    key(el, 'Escape')
    expect(panel(el)).toBeNull()
  })

  it('layers (D4): a click outside the menu closes only the menu', () => {
    const { el } = render()
    openPanel(el)
    rightClick(otherRow(el))
    act(() => void document.querySelector('.ctx-overlay')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(vaultMenu()).toBeNull()
    expect(panel(el)).not.toBeNull()
  })
})

describe('VaultSwitcher: display names (Docs YAZ-1974 D4/D5)', () => {
  const OTHER = RECENTS[2].path // '/v/Archive'
  const otherRow = (el: HTMLElement) => rows(el)[2]
  const field = (el: HTMLElement) => el.querySelector<HTMLInputElement>('.vault-switcher__rename')
  const fieldKey = (el: HTMLElement, k: string) => act(() => void field(el)!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))
  /** Right-click → Set display name on `target`, then type `value` into the field it opens. */
  const rename = async (el: HTMLElement, target: HTMLElement, value: string) => {
    rightClick(target)
    pick('Set display name')
    await fill(field(el)!, value)
  }

  it('the trigger and the rows show display names; the trigger keeps the full path as its tooltip', () => {
    act(() => broadcast(withNames({ [ROOT]: 'Draw Vault', [OTHER]: '🚀 Launch' })))
    const { el } = render()
    expect(trigger(el).querySelector('.sidebar__root-name')?.textContent).toBe('Draw Vault')
    expect(trigger(el).title).toBe(ROOT)
    openPanel(el)
    expect(names(el)).toEqual(['Draw Vault', 'Notes', '🚀 Launch', 'Notes Archive'])
  })

  it('a rename landing from another window updates the header live (S13)', () => {
    const { el } = render()
    act(() => broadcast(withNames({ [ROOT]: 'Draw Vault' })))
    expect(trigger(el).querySelector('.sidebar__root-name')?.textContent).toBe('Draw Vault')
  })

  it('the filter finds a renamed row by its display name and by its folder name, once', async () => {
    act(() => broadcast(withNames({ [OTHER]: 'Old Stuff' })))
    const { el } = render()
    openPanel(el)
    await type(el, 'old')
    expect(names(el)).toEqual(['Old Stuff'])
    await type(el, 'archive')
    expect(names(el)).toEqual(['Old Stuff', 'Notes Archive'])
  })

  it('Set display name on a row: a focused field, name selected, folder name as placeholder — ⏎ saves, the row shows it, the panel stays with the filter focused', async () => {
    const { el } = render()
    openPanel(el)
    rightClick(otherRow(el))
    pick('Set display name')
    const input = field(el)!
    expect(otherRow(el).tagName).toBe('DIV') // no input inside a <button>
    expect(document.activeElement).toBe(input)
    expect([input.value, input.placeholder, input.selectionStart, input.selectionEnd]).toEqual(['Archive', 'Archive', 0, 'Archive'.length])
    await fill(input, '  Old Stuff ')
    fieldKey(el, 'Enter')
    expect(field(el)).toBeNull()
    expect(names(el)[2]).toBe('Old Stuff')
    expect(setFolder).toHaveBeenLastCalledWith(OTHER, { name: 'Old Stuff' })
    expect(panel(el)).not.toBeNull()
    expect(document.activeElement).toBe(filter(el))
    rightClick(otherRow(el))
    expect(menuLabels()).toContain('Reset to folder name')
  })

  it('blur saves', async () => {
    const { el } = render()
    openPanel(el)
    await rename(el, otherRow(el), 'Old Stuff')
    act(() => filter(el).focus())
    expect(field(el)).toBeNull()
    expect(names(el)[2]).toBe('Old Stuff')
    expect(panel(el)).not.toBeNull()
  })

  it('Esc throws the edit away and closes ONLY the field (the layer rule); the next Esc closes the panel', async () => {
    const { el } = render()
    openPanel(el)
    await rename(el, otherRow(el), 'Old Stuff')
    fieldKey(el, 'Escape')
    expect(field(el)).toBeNull()
    expect(names(el)[2]).toBe('Archive')
    expect(setFolder).not.toHaveBeenCalled()
    expect(panel(el)).not.toBeNull()
    expect(document.activeElement).toBe(filter(el))
    key(el, 'Escape')
    expect(panel(el)).toBeNull()
  })

  it('a click-away outside the panel saves and keeps the panel', async () => {
    const { el } = render()
    openPanel(el)
    await rename(el, otherRow(el), 'Old Stuff')
    act(() => void window.dispatchEvent(new MouseEvent('mousedown')))
    expect(panel(el)).not.toBeNull()
    act(() => field(el)!.blur()) // the browser's own focus change on that mousedown
    expect(names(el)[2]).toBe('Old Stuff')
  })

  it('the first click on another row only ends the rename (saved) — it never opens that vault; the next click does', async () => {
    const { el } = render()
    openPanel(el)
    await rename(el, otherRow(el), 'Old Stuff')
    const target = rows(el)[1]
    act(() => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      target.click()
    })
    await settle()
    expect(field(el)).toBeNull()
    expect(names(el)[2]).toBe('Old Stuff')
    expect(openRecent).not.toHaveBeenCalled()
    expect(panel(el)).not.toBeNull()
    act(() => {
      rows(el)[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      rows(el)[1].click()
    })
    await settle()
    expect(openRecent).toHaveBeenCalledExactlyOnceWith('/w/Notes')
  })

  it('an empty field, or the folder name itself, is no custom name: back to the folder name, no Reset item', async () => {
    act(() => broadcast(withNames({ [OTHER]: 'Old Stuff' })))
    const { el } = render()
    openPanel(el)
    await rename(el, otherRow(el), '   ')
    fieldKey(el, 'Enter')
    expect(names(el)[2]).toBe('Archive')
    expect(setFolder).toHaveBeenLastCalledWith(OTHER, { name: null })
    rightClick(otherRow(el))
    expect(menuLabels()).not.toContain('Reset to folder name')
    pick('Set display name')
    await fill(field(el)!, 'Archive ')
    fieldKey(el, 'Enter')
    expect(storage.vaultName(OTHER)).toBe('Archive')
  })

  it('while the field stands, keys stay in it: the filter keeps its query, ↑/↓ never move the highlight, ⏎ saves without opening a vault', async () => {
    const { el, props } = render()
    openPanel(el)
    const before = activeRow(el)
    await rename(el, otherRow(el), 'Old Stuff')
    fieldKey(el, 'ArrowDown')
    expect(activeRow(el)).toBe(before)
    fieldKey(el, 'Enter')
    await settle()
    expect(filter(el).value).toBe('')
    expect(names(el)[2]).toBe('Old Stuff')
    expect(activeRow(el)).toBe(before)
    expect(openRecent).not.toHaveBeenCalled()
    expect(props.onOpenHere).not.toHaveBeenCalled()
  })

  it('Reset to folder name drops the display name', () => {
    act(() => broadcast(withNames({ [OTHER]: 'Old Stuff' })))
    const { el } = render()
    openPanel(el)
    rightClick(otherRow(el))
    pick('Reset to folder name')
    expect(names(el)[2]).toBe('Archive')
    expect(setFolder).toHaveBeenLastCalledWith(OTHER, { name: null })
    expect(document.activeElement).toBe(filter(el))
  })

  it('Set display name on the header renames the CURRENT vault in the header, the panel closed', async () => {
    const { el } = render()
    await rename(el, trigger(el), 'Draw Vault')
    expect(trigger(el).tagName).toBe('DIV')
    fieldKey(el, 'Enter')
    expect(trigger(el).tagName).toBe('BUTTON')
    expect(trigger(el).querySelector('.sidebar__root-name')?.textContent).toBe('Draw Vault')
    expect(setFolder).toHaveBeenLastCalledWith(ROOT, { name: 'Draw Vault' })
    expect(panel(el)).toBeNull()
  })
})

describe('VaultSwitcher: one-line rows and the ⓘ path tooltip (Docs YAZ-1974 D2)', () => {
  const LONG = '/Users/yasin/Documents/GitHub/content-skills/content-app-planning-with-a-very-long-folder-name'

  it('each row is ONE line — a name, an ⓘ and a time — and no path anywhere in the panel', () => {
    const { el } = render()
    openPanel(el)
    for (const row of rows(el)) {
      expect(row.querySelectorAll('.vault-switcher__name')).toHaveLength(1)
      expect(row.querySelectorAll('.vault-switcher__info svg')).toHaveLength(1)
      expect(row.querySelectorAll('.vault-switcher__when')).toHaveLength(1)
      expect(row.children).toHaveLength(3)
    }
    expect(panel(el)!.textContent).not.toContain('/')
    expect(tooltip()).toBeNull()
  })

  it('hovering the ⓘ draws the WHOLE path in a tooltip portalled to <body>, breakable after every slash; leaving clears it', () => {
    recentsSpy.mockReturnValue([RECENTS[0], { path: LONG, lastOpened: NOW }])
    const { el } = render()
    openPanel(el)
    hoverInfo(rows(el)[1])
    const tip = tooltip()!
    expect(tip.parentElement).toBe(document.body)
    expect(tip.textContent).toBe(LONG)
    expect(tip.querySelectorAll('wbr')).toHaveLength(LONG.split('/').length)
    leaveInfo(rows(el)[1])
    expect(tooltip()).toBeNull()
  })

  it('the two "Notes" vaults tell apart by their tooltips; a dead row still shows its path', async () => {
    openRecent.mockResolvedValueOnce(false)
    const { el } = render()
    openPanel(el)
    expect([pathOf(rows(el)[0]), pathOf(rows(el)[1])]).toEqual([ROOT, '/w/Notes'])
    act(() => rows(el)[1].click())
    await settle()
    expect(rows(el)[1].disabled).toBe(true)
    expect(pathOf(rows(el)[1])).toBe('/w/Notes')
  })

  it('the ⓘ is part of its row: a click opens the vault, a right-click is the row\'s menu', async () => {
    const { el } = render()
    openPanel(el)
    const info = rows(el)[2].querySelector<HTMLElement>('.vault-switcher__info')!
    expect(rightClick(info)).toBe(true)
    expect(menuLabels()).toContain('Remove from recent vaults')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    act(() => info.click())
    await settle()
    expect(openRecent).toHaveBeenCalledExactlyOnceWith('/v/Archive')
  })

  it('closing the panel takes the tooltip with it', () => {
    const { el } = render()
    openPanel(el)
    hoverInfo(rows(el)[1])
    key(el, 'Escape')
    expect(tooltip()).toBeNull()
  })
})
