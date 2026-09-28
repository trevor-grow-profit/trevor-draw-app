/**
 * The sidebar's render isolation (YAZ-2073 5D, 🔒 D16), counted: the hover preview lives in its own
 * store, so a pointer sweep over the rows renders neither the Sidebar nor the Tree; and `Tree` is
 * memoized with stable props, so a Sidebar render that changes nothing the rows show leaves them be.
 *
 * Counters, all outside the component: `useShareBadges` is called once per Sidebar render, the
 * top-level `Tree` is wrapped in a memoized spy with the real component's own comparison, and the
 * share-mark map it hands down is read once per file row rendered at any depth.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS, defaultAppState, type TreeNode, type WindowIdentity } from '@shared/types'
import { BOARD_PREVIEW_DWELL_MS, Sidebar } from './Sidebar'

const renders = vi.hoisted(() => ({ sidebar: 0, tree: 0, rows: 0 }))

vi.mock('../share/useShareBadges', () => {
  // Every file row reads its share mark off this map, once per render of that row.
  const none = new (class extends Map<string, never> {
    override get(path: string) {
      renders.rows++
      return super.get(path)
    }
  })()
  return {
    useShareBadges: () => {
      renders.sidebar++
      return none
    },
  }
})
vi.mock('./Tree', async (importActual) => {
  const actual = await importActual<typeof import('./Tree')>()
  const { createElement, memo } = await import('react')
  return {
    ...actual,
    Tree: memo((props: Parameters<typeof actual.Tree>[0]) => {
      renders.tree++
      return createElement(actual.Tree, props)
    }),
  }
})
vi.mock('./boardPreviewCache', async (importActual) => ({
  ...(await importActual<typeof import('./boardPreviewCache')>()),
  boardPreviews: { load: async () => 'data:image/png;base64,AA', clear: () => undefined, Preview: () => null },
}))

const board = (i: number): TreeNode => ({ type: 'file', name: `b${String(i).padStart(2, '0')}.excalidraw`, path: `/v/sub/b${String(i).padStart(2, '0')}.excalidraw`, size: 1, mtime: 1, kind: 'drawing' })
const TREE: TreeNode[] = [{ type: 'dir', name: 'sub', path: '/v/sub', children: Array.from({ length: 20 }, (_, i) => board(i)) }]

function installBridge() {
  const bridge = {
    tree: vi.fn(async (root: string) => ({ root, tree: TREE, generatedAt: 1 })),
    state: { get: vi.fn(async () => defaultAppState()), setFolder: vi.fn(async () => undefined), onChange: vi.fn(() => () => undefined) },
    window: {
      identity: vi.fn(async (): Promise<WindowIdentity> => ({ id: 'w1', root: '/v', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [] })),
      setIdentity: vi.fn(async () => undefined),
    },
    file: { clipState: vi.fn(async () => null), onClipChanged: vi.fn(() => () => undefined) },
    favorites: { get: vi.fn(async () => []), set: vi.fn(async () => undefined), onChanged: vi.fn(() => () => undefined) },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
}

let root: Root | null = null
let container: HTMLElement | null = null

type SidebarProps = Parameters<typeof Sidebar>[0]

async function mount() {
  installBridge()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const props: SidebarProps = {
    root: '/v',
    activeFile: null,
    watch: { subscribe: () => () => undefined },
    onOpenFile: vi.fn(),
    onOpenFileBackground: vi.fn(),
    onRevealInFiles: vi.fn(),
    onPickFolder: vi.fn(),
    pickDisabled: false,
    switcherOpenRequest: 0,
    onOpenVaultHere: vi.fn(async () => true),
    onCollapse: vi.fn(),
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
    clipboardRef: { current: null },
  }
  await act(async () => root?.render(<Sidebar {...props} />))
  const el = container
  // Open the folder (the expansion is remembered per vault across mounts), so the 20 boards are rows
  // of a nested Tree level; then start counting from zero.
  if (el.querySelector('[aria-expanded="true"]') === null) await act(async () => el.querySelector<HTMLButtonElement>('.tree__row--dir')?.click())
  const rows = [...el.querySelectorAll<HTMLButtonElement>('.tree__row--file')]
  expect(rows).toHaveLength(20)
  Object.assign(renders, { sidebar: 0, tree: 0, rows: 0 })
  return { el, rows, props, rerender: () => act(async () => root?.render(<Sidebar {...props} />)) }
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  vi.useRealTimers()
})

describe('Sidebar render isolation (YAZ-2073 5D)', () => {
  const enter = (row: Element) => act(() => void row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
  const leave = (row: Element) => act(() => void row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))

  it('a 20-row pointer sweep renders neither the sidebar nor the tree, and the preview still opens on a dwell', async () => {
    const { rows } = await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (const row of rows) {
      enter(row)
      leave(row)
    }
    enter(rows[3])
    await act(async () => void vi.advanceTimersByTime(BOARD_PREVIEW_DWELL_MS))
    expect(document.querySelector('.board-preview')?.getAttribute('aria-label')).toBe('Preview of b03')
    leave(rows[3])
    expect(document.querySelector('.board-preview')).toBeNull()
    expect(renders).toEqual({ sidebar: 0, tree: 0, rows: 0 })
  })

  it('a sidebar render that changes nothing the rows show leaves the tree alone', async () => {
    const { el, rerender } = await mount()
    await rerender()
    await act(async () => el.querySelector<HTMLButtonElement>('.sidebar__sort')?.click())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(renders.sidebar).toBeGreaterThan(0)
    expect(renders).toMatchObject({ tree: 0, rows: 0 })
  })
})
