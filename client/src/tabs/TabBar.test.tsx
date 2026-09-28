/**
 * The window tab strip (Tabs I2/I3, GRO-2234/2235): tablist semantics per the ViewTabs
 * pattern, extension-stripped labels with full-path tooltips, the close
 * affordances (✕, middle-click) vs activation, drag-to-reorder with the insertion indicator,
 * and the active tab scrolled into view on activation. Plus the right-click Copy path menu
 * (YAZ-922) and the ◀ ▶ history buttons (YAZ-721).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TabBar, type TabBarProps } from './TabBar'

// The OS-action items call the bridge (YAZ-963): stub the verbs, keep BridgeRequestError real.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { shell: { reveal: vi.fn().mockResolvedValue({}), openVsCode: vi.fn().mockResolvedValue({}) } },
}))
import { api, BridgeRequestError } from '../api'
const reveal = vi.mocked(api.shell.reveal)
const openVsCode = vi.mocked(api.shell.openVsCode)


let root: Root | null = null
let container: HTMLElement | null = null

function mount(props: TabBarProps) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<TabBar {...props} />))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

/** The history props (YAZ-721) the tab tests don't exercise: nowhere to go, nothing wired. */
const noNav = { canBack: false, canForward: false, onBack: vi.fn(), onForward: vi.fn() }

describe('TabBar', () => {
  const noop = { onActivate: vi.fn(), onClose: vi.fn(), onMove: vi.fn() }

  it('renders a labelled tablist: one role=tab per path, extension-stripped label, full path as tooltip', () => {
    const el = mount({ tabs: ['/v/Note.excalidraw', '/v/sub/Plan.excalidraw'], active: '/v/Note.excalidraw', ...noop, ...noNav })
    expect(el.querySelector('.tabbar')?.getAttribute('role')).toBe('tablist')
    expect(el.querySelector('.tabbar')?.getAttribute('aria-label')).toBe('Open files')
    const tabsEls = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabsEls.map((t) => t.textContent)).toEqual(['Note', 'Plan'])
    expect(tabsEls.map((t) => t.title)).toEqual(['/v/Note.excalidraw', '/v/sub/Plan.excalidraw'])
  })

  it('marks a draw.io diagram’s tab with its type glyph before the label, and leaves an Excalidraw tab unmarked (🔒 YAZ-1802 D15)', () => {
    const el = mount({ tabs: ['/v/Note.excalidraw', '/v/Flow.drawio', '/v/Flow.drawio.svg'], active: '/v/Flow.drawio', ...noop, ...noNav })
    const [drawing, diagram, picture] = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(drawing.querySelector('.tabbar__kind')).toBeNull()
    expect(picture.querySelector('.tabbar__kind')).toBeNull()
    const mark = diagram.querySelector('.tabbar__kind')
    expect(mark?.getAttribute('aria-label')).toBe('draw.io diagram')
    expect(mark?.nextElementSibling?.className).toBe('tabbar__label')
    expect(diagram.textContent).toBe('Flow')
  })

  it('marks only the active tab: aria-selected + the underline modifier', () => {
    const el = mount({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], active: '/v/b.excalidraw', ...noop, ...noNav })
    expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect([...el.querySelectorAll('.tabbar__tab')].map((t) => t.classList.contains('tabbar__tab--active'))).toEqual([false, true])
  })

  it('clicking a tab activates it; the ✕ (labelled per file) closes it without activating', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const el = mount({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], active: '/v/a.excalidraw', onActivate, onClose, onMove: vi.fn(), ...noNav })
    act(() => el.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click())
    expect(onActivate).toHaveBeenCalledWith('/v/b.excalidraw')
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Close b"]')?.click())
    expect(onClose).toHaveBeenCalledWith('/v/b.excalidraw')
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('middle-click closes a tab (the browser-tab convention); other aux buttons do nothing', () => {
    const onClose = vi.fn()
    const el = mount({ tabs: ['/v/a.excalidraw'], active: '/v/a.excalidraw', onActivate: vi.fn(), onClose, onMove: vi.fn(), ...noNav })
    const tab = el.querySelector<HTMLButtonElement>('[role="tab"]')
    act(() => void tab?.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })))
    expect(onClose).toHaveBeenCalledWith('/v/a.excalidraw')
    act(() => void tab?.dispatchEvent(new MouseEvent('auxclick', { button: 2, bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders an empty strip with no tabs (rule 2: the strip shows whenever a folder is open)', () => {
    const el = mount({ tabs: [], active: null, ...noop, ...noNav })
    expect(el.querySelector('.tabbar')).not.toBeNull()
    expect(el.querySelectorAll('[role="tab"]')).toHaveLength(0)
  })
})

describe('TabBar drag-to-reorder (I3, GRO-2235)', () => {
  const TABS = ['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw']
  const tabAt = (el: HTMLElement, i: number) => [...el.querySelectorAll<HTMLElement>('.tabbar__tab')][i]
  /**
   * Drag events bubble like the real thing; jsdom has no DragEvent, the handlers guard
   * `dataTransfer` (the groupDrag idiom). jsdom rects are all-zero, so the before/after
   * midpoint test reduces to the sign of clientX: negative = before the tab, else after.
   */
  const fire = (target: Element, type: string, clientX = 0) =>
    act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX })))

  it('dropping past a tab\'s midpoint calls onMove with the final index; grab and indicator classes mark the drag', () => {
    const onMove = vi.fn()
    const el = mount({ tabs: TABS, active: '/v/a.excalidraw', onActivate: vi.fn(), onClose: vi.fn(), onMove, ...noNav })
    fire(tabAt(el, 0), 'dragstart')
    expect(tabAt(el, 0).classList.contains('tabbar__tab--dragging')).toBe(true)
    fire(tabAt(el, 2), 'dragover', 5) // right half of c → the end slot: the last tab marks --insert-after
    expect(tabAt(el, 2).classList.contains('tabbar__tab--insert-after')).toBe(true)
    fire(tabAt(el, 2), 'drop', 5)
    expect(onMove).toHaveBeenCalledWith(0, 2) // a lands last
    expect(el.querySelector('.tabbar__tab--dragging')).toBeNull() // drag state cleared
  })

  it('dropping on a tab\'s left half inserts BEFORE it (--insert-before on that tab)', () => {
    const onMove = vi.fn()
    const el = mount({ tabs: TABS, active: '/v/a.excalidraw', onActivate: vi.fn(), onClose: vi.fn(), onMove, ...noNav })
    fire(tabAt(el, 0), 'dragstart')
    fire(tabAt(el, 2), 'dragover', -5)
    expect(tabAt(el, 2).classList.contains('tabbar__tab--insert-before')).toBe(true)
    fire(tabAt(el, 2), 'drop', -5)
    expect(onMove).toHaveBeenCalledWith(0, 1) // before c, after the grab point shifted one left
  })

  it('dropping back on the grabbed slot is a no-op; dragend clears an abandoned drag', () => {
    const onMove = vi.fn()
    const el = mount({ tabs: TABS, active: '/v/a.excalidraw', onActivate: vi.fn(), onClose: vi.fn(), onMove, ...noNav })
    fire(tabAt(el, 1), 'dragstart')
    fire(tabAt(el, 1), 'drop', -5) // before itself = its own slot
    expect(onMove).not.toHaveBeenCalled()
    fire(tabAt(el, 1), 'dragstart')
    fire(tabAt(el, 1), 'dragend')
    expect(el.querySelector('.tabbar__tab--dragging')).toBeNull()
  })
})

describe('TabBar keeps the active tab in view (I3 overflow polish)', () => {
  it('activation scrolls the ACTIVE tab into view when scrollIntoView exists (jsdom lacks it: the ?. guard is every other test here)', () => {
    const spy = vi.fn()
    ;(HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView = spy
    try {
      mount({ tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], active: '/v/a.excalidraw', onActivate: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), ...noNav })
      act(() => root?.render(<TabBar tabs={['/v/a.excalidraw', '/v/b.excalidraw']} active="/v/b.excalidraw" onActivate={vi.fn()} onClose={vi.fn()} onMove={vi.fn()} {...noNav} />))
      const activeTab = spy.mock.contexts.at(-1) as HTMLElement
      expect(activeTab.classList.contains('tabbar__tab--active')).toBe(true)
      expect(activeTab.querySelector('[role="tab"]')?.textContent).toBe('b')
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView
    }
  })
})

describe('TabBar right-click menu (YAZ-922)', () => {
  const TABS = ['/vault/Note.excalidraw', '/vault/sub/Deep Note.excalidraw']
  const props = { tabs: TABS, active: '/vault/Note.excalidraw', onActivate: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), ...noNav }

  /** jsdom has no clipboard; the menu's only job is to hand the path to it, so spy on writeText. */
  let writeText: ReturnType<typeof vi.fn>
  const hadClipboard = 'clipboard' in navigator

  beforeEach(() => {
    writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
  })

  afterEach(() => {
    if (!hadClipboard) delete (navigator as unknown as Record<string, unknown>).clipboard
  })

  const tabAt = (el: HTMLElement, i: number) => [...el.querySelectorAll<HTMLElement>('.tabbar__tab')][i]

  /** Right-click a tab; returns the event so the caller can check it was swallowed. */
  const rightClick = (target: Element, clientX = 0, clientY = 0): MouseEvent => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX, clientY })
    act(() => void target.dispatchEvent(e))
    return e
  }

  const menuOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.ctx-menu')
  const items = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]')]

  it('right-clicking a tab opens a role=menu at the pointer with Show in sidebar, Copy path, and the OS actions', () => {
    const el = mount(props)
    expect(menuOf(el)).toBeNull() // nothing until asked for
    const e = rightClick(tabAt(el, 0), 120, 42)
    expect(e.defaultPrevented).toBe(true) // the OS menu never shows
    const menu = menuOf(el)
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.style.left).toBe('120px')
    expect(menu?.style.top).toBe('42px')
    expect(items(el).map((b) => b.textContent)).toEqual(['Show in sidebar', 'Copy path', 'Reveal in Finder', 'Open in VS Code'])
  })

  it('Show in sidebar targets the right-clicked inactive tab, closes the menu, and never activates it', () => {
    const onActivate = vi.fn()
    const onShowInSidebar = vi.fn()
    const el = mount({ ...props, onActivate, onShowInSidebar })
    rightClick(tabAt(el, 1))
    act(() => items(el)[0]?.click())
    expect(onShowInSidebar).toHaveBeenCalledExactlyOnceWith('/vault/sub/Deep Note.excalidraw')
    expect(onActivate).not.toHaveBeenCalled()
    expect(menuOf(el)).toBeNull()
  })

  it('clamps the menu inside the viewport when the pointer is near its right and bottom edges', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.classList.contains('ctx-menu') ? 160 : 0
      const height = this.classList.contains('ctx-menu') ? 180 : 0
      return { width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    try {
      const el = mount(props)
      rightClick(tabAt(el, 0), 1000, 700)
      expect(menuOf(el)?.style.left).toBe('864px')
      expect(menuOf(el)?.style.top).toBe('588px')
    } finally {
      rect.mockRestore()
    }
  })

  it('Copy path writes the tab\'s ABSOLUTE path — not the label — and closes the menu', () => {
    const el = mount(props)
    rightClick(tabAt(el, 1))
    act(() => items(el)[1]?.click())
    expect(writeText).toHaveBeenCalledWith('/vault/sub/Deep Note.excalidraw')
    expect(menuOf(el)).toBeNull()
  })

  it('the menu retargets: right-clicking another tab copies THAT tab\'s path', () => {
    const el = mount(props)
    rightClick(tabAt(el, 0))
    rightClick(tabAt(el, 1))
    act(() => items(el)[1]?.click())
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('/vault/sub/Deep Note.excalidraw')
  })

  it('Escape anywhere in the window dismisses the menu', () => {
    const el = mount(props)
    rightClick(tabAt(el, 0))
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })))
    expect(menuOf(el)).not.toBeNull() // other keys are none of its business
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(menuOf(el)).toBeNull()
  })

  it('a press OUTSIDE dismisses the menu', () => {
    const el = mount(props)
    rightClick(tabAt(el, 0))
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menuOf(el)).toBeNull()
  })

  it('a press INSIDE the menu keeps it open (the item stops propagation, so the click can land)', () => {
    const el = mount(props)
    rightClick(tabAt(el, 0))
    act(() => void items(el)[1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menuOf(el)).not.toBeNull()
    // …and the press that survived is followed by the click that actually copies.
    act(() => items(el)[1]?.click())
    expect(writeText).toHaveBeenCalledWith('/vault/Note.excalidraw')
  })

  it('closing the menu unhooks its window listeners (no stray dismissals after the fact)', () => {
    const el = mount(props)
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    try {
      rightClick(tabAt(el, 0))
      expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(['keydown', 'mousedown'])
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(['keydown', 'mousedown'])
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })
})

describe('TabBar history buttons (YAZ-721, LOCKED D2: buttons only — no shortcut, no menu item)', () => {
  const btn = (el: HTMLElement, label: string) => el.querySelector<HTMLButtonElement>(`.tabbar-nav__btn[aria-label="${label}"]`)
  const tabs = { tabs: ['/v/a.excalidraw'], active: '/v/a.excalidraw', onActivate: vi.fn(), onClose: vi.fn(), onMove: vi.fn() }

  it('renders ◀ ▶ left of the tablist, each labelled and tooltipped', () => {
    const el = mount({ ...tabs, ...noNav })
    const labels = [...el.querySelectorAll<HTMLButtonElement>('.tabbar-nav__btn')]
    expect(labels.map((b) => b.getAttribute('aria-label'))).toEqual(['Back', 'Forward'])
    expect(labels.map((b) => b.title)).toEqual(['Back', 'Forward'])
    // Outside .tabbar, so the strip's own drop guards (e.target !== e.currentTarget) are untouched.
    expect(el.querySelector('.tabbar .tabbar-nav__btn')).toBeNull()
  })

  it('with the sidebar collapsed (YAZ-1759), Show sidebar leads the row as a peer of ◀ ▶ and reopens on click', () => {
    const onShowSidebar = vi.fn()
    const el = mount({ ...tabs, ...noNav, onShowSidebar })
    const labels = [...el.querySelectorAll<HTMLButtonElement>('.tabbar-nav__btn')]
    expect(labels.map((b) => b.getAttribute('aria-label'))).toEqual(['Show sidebar', 'Back', 'Forward'])
    expect(labels[0]?.title).toBe('Show sidebar')
    expect(el.querySelector('.tabbar-nav')?.firstElementChild).toBe(labels[0])
    act(() => btn(el, 'Show sidebar')?.click())
    expect(onShowSidebar).toHaveBeenCalledTimes(1)
    // A flex child of the nav row, not a floater over it — and still outside .tabbar (same guard as above).
    expect(el.querySelector('.tabbar .tabbar-nav__btn')).toBeNull()
  })

  it('each button is disabled exactly when its side of the stack has nowhere to go', () => {
    const el = mount({ ...tabs, canBack: true, canForward: false, onBack: vi.fn(), onForward: vi.fn() })
    expect(btn(el, 'Back')?.disabled).toBe(false)
    expect(btn(el, 'Forward')?.disabled).toBe(true)
  })

  it('clicking an enabled button steps that way', () => {
    const onBack = vi.fn()
    const onForward = vi.fn()
    const el = mount({ ...tabs, canBack: true, canForward: true, onBack, onForward })
    act(() => btn(el, 'Back')?.click())
    act(() => btn(el, 'Forward')?.click())
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onForward).toHaveBeenCalledTimes(1)
  })
})

/**
 * The OS actions on the tab (YAZ-963): the tab IS the file, so it offers Reveal in Finder and
 * Open in VS Code beside Copy path — same absolute-path target, same close-on-click, and a
 * NOT_FOUND surfacing through `onNotice` exactly as the sidebar's reveal does.
 */
describe('tab menu OS actions (YAZ-963)', () => {
  let root2: Root | null = null
  let host: HTMLElement | null = null
  afterEach(() => {
    act(() => root2?.unmount())
    host?.remove()
    root2 = null
    host = null
    reveal.mockClear()
    openVsCode.mockClear()
  })
  const mountWith = (extra: Partial<TabBarProps> = {}): HTMLElement => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root2 = createRoot(host)
    const base: TabBarProps = {
      tabs: ['/vault/A.excalidraw', '/vault/sub/Deep Note.excalidraw'],
      active: '/vault/A.excalidraw',
      onActivate: vi.fn(),
      onClose: vi.fn(),
      onMove: vi.fn(),
      canBack: false,
      canForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      ...extra,
    }
    act(() => root2?.render(<TabBar {...base} />))
    return host
  }
  const tabAt = (el: HTMLElement, i: number) => [...el.querySelectorAll<HTMLElement>('.tabbar__tab')][i]
  const rightClick = (target: Element): void => {
    act(() => void target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })))
  }
  const itemNamed = (el: HTMLElement, label: string) => [...el.querySelectorAll<HTMLButtonElement>('.ctx-menu [role="menuitem"]')].find((b) => b.textContent === label)
  const menuOf = (el: HTMLElement) => el.querySelector<HTMLElement>('.ctx-menu')

  it('Reveal in Finder calls the bridge with the tab\'s absolute path and closes the menu', () => {
    const el = mountWith()
    rightClick(tabAt(el, 1))
    act(() => itemNamed(el, 'Reveal in Finder')?.click())
    expect(reveal).toHaveBeenCalledExactlyOnceWith({ path: '/vault/sub/Deep Note.excalidraw' })
    expect(menuOf(el)).toBeNull()
  })

  it('Open in VS Code calls the bridge with the tab\'s absolute path and closes the menu', () => {
    const el = mountWith()
    rightClick(tabAt(el, 0))
    act(() => itemNamed(el, 'Open in VS Code')?.click())
    expect(openVsCode).toHaveBeenCalledExactlyOnceWith({ path: '/vault/A.excalidraw' })
    expect(menuOf(el)).toBeNull()
  })

  it('a stale tab surfaces through onNotice instead of a silently dead item', async () => {
    reveal.mockRejectedValueOnce(new BridgeRequestError('NOT_FOUND', 'gone'))
    const onNotice = vi.fn()
    const el = mountWith({ onNotice })
    rightClick(tabAt(el, 0))
    act(() => itemNamed(el, 'Reveal in Finder')?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(onNotice).toHaveBeenCalledTimes(1)
    expect(String(onNotice.mock.calls[0][0])).toMatch(/no longer there|Can't reveal/i)
  })
})
