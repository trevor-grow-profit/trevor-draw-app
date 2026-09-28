/**
 * A tiny external store for `useSyncExternalStore` (YAZ-2073 5D): state that changes often and is
 * read by ONE small component lives here instead of in a big parent's state, so a change re-renders
 * the reader alone. The rail, the save chips and the sidebar's hover preview use it.
 */
export interface Store<S extends object> {
  getState(): S
  subscribe(listener: () => void): () => void
  /** Merge a patch; listeners fire only when something actually moved. */
  set(patch: Partial<S>): void
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (patch) => {
      const next = { ...state, ...patch }
      if ((Object.keys(next) as Array<keyof S>).every((k) => next[k] === state[k])) return
      state = next
      listeners.forEach((l) => l())
    },
  }
}
