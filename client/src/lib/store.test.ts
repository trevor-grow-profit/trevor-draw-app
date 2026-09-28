/** The tiny external store behind the rail, the save chips and the hover preview (YAZ-2073 5D). */
import { describe, expect, it, vi } from 'vitest'
import { createStore } from './store'

describe('createStore', () => {
  it('merges a patch and notifies only when a value actually moved', () => {
    const store = createStore({ a: 1, b: 'x' })
    const listener = vi.fn()
    store.subscribe(listener)
    store.set({ a: 1 })
    store.set({})
    expect(listener).not.toHaveBeenCalled()
    store.set({ b: 'y' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState()).toEqual({ a: 1, b: 'y' })
  })

  it('hands back a NEW state object on a change and the SAME one otherwise, as `useSyncExternalStore` needs', () => {
    const store = createStore({ a: 1 })
    const before = store.getState()
    store.set({ a: 1 })
    expect(store.getState()).toBe(before)
    store.set({ a: 2 })
    expect(store.getState()).not.toBe(before)
    expect(before.a).toBe(1)
  })

  it('returns an unsubscribe', () => {
    const store = createStore({ a: 1 })
    const listener = vi.fn()
    store.subscribe(listener)()
    store.set({ a: 2 })
    expect(listener).not.toHaveBeenCalled()
  })
})
