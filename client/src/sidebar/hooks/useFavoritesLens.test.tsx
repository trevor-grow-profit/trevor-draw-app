/** The Favorites list's reorder, driven directly (YAZ-1766; a hook since YAZ-2073 6C). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useFavoritesLens } from './useFavoritesLens'

const PATHS = ['/v/a', '/v/b', '/v/c']

let root: Root | null = null
let hook: ReturnType<typeof useFavoritesLens>
const onNotice = vi.fn()
function Probe() {
  hook = useFavoritesLens('/v', null, [], onNotice)
  return null
}
const bridge = {
  get: vi.fn(async () => PATHS),
  set: vi.fn(async (_root: string, _paths: readonly string[]) => undefined),
  onChanged: vi.fn(() => () => undefined),
}

beforeEach(async () => {
  Object.defineProperty(window, 'yaseenDraw', { value: { favorites: bridge }, configurable: true, writable: true })
  root = createRoot(document.createElement('div'))
  await act(async () => root?.render(<Probe />))
})
afterEach(() => {
  act(() => root?.unmount())
  delete (window as unknown as Record<string, unknown>).yaseenDraw
  vi.clearAllMocks()
})

/** Drag `from` onto `over`'s edge and drop. */
const reorder = (from: string, over: string, edge: 'before' | 'after') => {
  act(() => hook.favoriteReorder.start(from))
  act(() => hook.favoriteReorder.hover(over, edge))
  act(() => hook.favoriteReorder.drop())
}

// The drag itself, the focused tab's lock and a refused write's revert are pinned through the real rows in
// `Sidebar.test.tsx`; this suite keeps only what the rows cannot easily reach.
describe('useFavoritesLens', () => {
  it('dropping a row on itself writes nothing and ends the drag', () => {
    reorder('/v/a', '/v/a', 'after')
    expect(bridge.set).not.toHaveBeenCalled()
    expect(hook.favoriteReorder.dragging).toBeNull()
  })
})
