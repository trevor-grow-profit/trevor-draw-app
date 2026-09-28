import { useEffect, useMemo, useRef } from 'react'
import type { WatchEvent } from '@shared/types'

export type WatchListener = (ev: WatchEvent) => void

export interface WatchSource {
  subscribe: (listener: WatchListener) => () => void
}

/**
 * One bridge `watch(root)` subscription per root; fans events out to subscribers. Main owns the
 * watcher (`fs/treeWatcher.ts`) and sends `ready` once the subscription is live, which subscribers use to
 * refetch state they may have missed.
 */
export function useWatch(root: string | null): WatchSource {
  const listeners = useRef(new Set<WatchListener>())
  const source = useMemo<WatchSource>(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => {
          listeners.current.delete(listener)
        }
      },
    }),
    [],
  )
  useEffect(() => {
    if (root === null) return
    return window.yaseenDraw.watch(root, (ev) => listeners.current.forEach((l) => l(ev)))
  }, [root])
  return source
}
