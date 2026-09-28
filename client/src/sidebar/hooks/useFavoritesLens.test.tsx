/** The Favorites list's writer and reorder, driven directly (YAZ-1766; a hook since YAZ-2073 6C). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useFavoritesLens } from './useFavoritesLens'

const PATHS = ['/v/a', '/v/b', '/v/c']

let root: Root | null = null
let hook: ReturnType<typeof useFavoritesLens>
const onNotice = vi.fn()
function Probe({ focusFavorites = [] }: { focusFavorites?: readonly string[] }) {
  hook = useFavoritesLens('/v', null, focusFavorites, onNotice)
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

describe('useFavoritesLens', () => {
  it('a drop lands before or after the hovered row, and dropping a row on itself writes nothing', () => {
    reorder('/v/c', '/v/a', 'before')
    expect(bridge.set).toHaveBeenLastCalledWith('/v', ['/v/c', '/v/a', '/v/b'])
    reorder('/v/c', '/v/a', 'after')
    expect(bridge.set).toHaveBeenLastCalledWith('/v', ['/v/a', '/v/c', '/v/b'])
    bridge.set.mockClear()
    reorder('/v/a', '/v/a', 'after')
    expect(bridge.set).not.toHaveBeenCalled()
    expect(hook.favoriteReorder.dragging).toBeNull()
  })

  it('does not drag while the tab is focused', async () => {
    await act(async () => root?.render(<Probe focusFavorites={['/v/a']} />))
    act(() => hook.favoriteReorder.start('/v/c'))
    expect(hook.favoriteReorder.dragging).toBeNull()
  })

  it('a refused write reverts the list and says why', async () => {
    bridge.set.mockRejectedValueOnce(new Error('bad file'))
    await act(async () => hook.toggleFavorite(['/v/d'], false))
    expect(hook.favorites).toEqual(PATHS)
    expect(onNotice).toHaveBeenCalledWith("Can't save favorites: bad file", 'error')
  })
})
