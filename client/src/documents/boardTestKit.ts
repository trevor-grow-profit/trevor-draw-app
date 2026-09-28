/**
 * Test doubles the three board-document suites share (YAZ-2073 8B) — `useBoardDocument.test`,
 * `DrawingEditor.test` and `DrawioEditor.test`: the window's watcher driven by hand, and the
 * `IntersectionObserver` that tells a board its tab came back into view. Test-only; nothing ships it.
 */
import { act } from 'react'
import type { WatchEvent } from '@shared/types'
import type { WatchSource } from '../hooks/useWatch'

/** The window's watcher, driven by hand: `watcherSaw` hands one event to every subscriber. */
export function fakeWatch(): { watch: WatchSource; watcherSaw: (ev: WatchEvent) => void } {
  const listeners = new Set<(ev: WatchEvent) => void>()
  return {
    watch: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    watcherSaw: (ev) => act(() => listeners.forEach((l) => l(ev))),
  }
}

/** Run `body` with a stubbed observer, handing it the "this tab is now visible" trigger. */
export async function withRevealObserver(body: (reveal: () => void) => Promise<void> | void): Promise<void> {
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
  const original = globalThis.IntersectionObserver
  class Spy {
    constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observers.push(cb)
    }
    observe() {}
    disconnect() {}
  }
  globalThis.IntersectionObserver = Spy as unknown as typeof IntersectionObserver
  try {
    await body(() => act(() => observers.forEach((cb) => cb([{ isIntersecting: true }]))))
  } finally {
    globalThis.IntersectionObserver = original
  }
}
