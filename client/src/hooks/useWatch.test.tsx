/**
 * `useWatch`: ONE bridge `watch(root)` per window root, fanned out to every editor and the sidebar.
 * The source object is stable, so subscribers never resubscribe on a render; a root change moves
 * the one bridge subscription; no root, no subscription.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WatchEvent } from '@shared/types'
import { useWatch, type WatchSource } from './useWatch'

type Emit = (ev: WatchEvent) => void
let watch: ReturnType<typeof vi.fn<(root: string, listener: Emit) => () => void>>
let emitters: Map<string, Emit>
let unwatched: string[]
beforeEach(() => {
  emitters = new Map()
  unwatched = []
  watch = vi.fn((root: string, listener: Emit) => {
    emitters.set(root, listener)
    return () => void unwatched.push(root)
  })
  Object.defineProperty(window, 'yaseenDraw', { value: { watch }, configurable: true, writable: true })
})

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  delete (window as unknown as Record<string, unknown>).yaseenDraw
})

/** Renders the hook for `vaultRoot`; `sources` collects the source object of every render. */
function mount(vaultRoot: string | null) {
  const sources: WatchSource[] = []
  function Probe({ r }: { r: string | null }) {
    sources.push(useWatch(r))
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<Probe r={vaultRoot} />))
  return { sources, rerender: (r: string | null) => act(() => root?.render(<Probe r={r} />)) }
}

describe('useWatch', () => {
  it('opens one bridge subscription and fans each event out to every subscriber', () => {
    const { sources } = mount('/vault')
    const a = vi.fn()
    const b = vi.fn()
    sources[0].subscribe(a)
    const offB = sources[0].subscribe(b)
    const ev: WatchEvent = { type: 'change', path: '/vault/Board.excalidraw', mtime: 1 }
    emitters.get('/vault')!(ev)
    expect(watch).toHaveBeenCalledTimes(1)
    expect([a.mock.calls, b.mock.calls]).toEqual([[[ev]], [[ev]]])
    offB()
    emitters.get('/vault')!({ type: 'ready', root: '/vault' })
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([2, 1])
  })

  it('keeps the same source across renders and subscribers across a root change', () => {
    const { sources, rerender } = mount('/vault')
    const listener = vi.fn()
    sources[0].subscribe(listener)
    rerender('/other')
    expect(new Set(sources).size).toBe(1)
    expect(unwatched).toEqual(['/vault'])
    expect(watch.mock.calls.map(([r]) => r)).toEqual(['/vault', '/other'])
    emitters.get('/other')!({ type: 'ready', root: '/other' })
    expect(listener).toHaveBeenCalledWith({ type: 'ready', root: '/other' })
  })

  it('watches nothing without a root, and lets go on unmount', () => {
    const { rerender } = mount(null)
    expect(watch).not.toHaveBeenCalled()
    rerender('/vault')
    act(() => root?.unmount())
    root = null
    expect(unwatched).toEqual(['/vault'])
  })
})
