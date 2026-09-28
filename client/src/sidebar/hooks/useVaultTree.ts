/**
 * The vault's tree as this panel holds it: read on mount and re-read on the watcher's word
 * (🔒 YAZ-1835 D4), with the root going missing handed up and any other failure shown in the body.
 */
import { useCallback, useEffect, useState } from 'react'
import type { TreeResponse } from '@shared/types'
import { api, BridgeRequestError } from '../../api'
import type { WatchSource } from '../../hooks/useWatch'

/** The quiet a watcher change waits out before the tree refreshes; a burst inside it is one walk (YAZ-2073 5E). */
export const WATCH_REFRESH_MS = 120

export function useVaultTree(root: string, watch: WatchSource, onRootMissing: () => void) {
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    api.tree(root).then(
      (res) => {
        // Walks overlap now that every watcher event refreshes (🔒 YAZ-1835 D4): a slower, older
        // answer must never overwrite a newer one, and `generatedAt` is main's clock for exactly that.
        setTree((cur) => (cur !== null && cur.generatedAt > res.generatedAt ? cur : res))
        setError(null)
      },
      (err: unknown) => {
        if (err instanceof BridgeRequestError && (err.code === 'NOT_FOUND' || err.code === 'NOT_A_DIRECTORY')) onRootMissing()
        else setError(err instanceof BridgeRequestError ? err.message : 'Failed to load folder')
      },
    )
  }, [root, onRootMissing])

  useEffect(() => refresh(), [refresh])

  // Refresh on EVERY change, not only structural ones (🔒 YAZ-1835 D4): a save moves a board's
  // `updatedAt`, and with it its place under "Last updated" — in this window and every other one
  // on the vault. `ready` also fires on every watch (re)subscription, covering missed events, and
  // refreshes at once; a change waits out `WATCH_REFRESH_MS` of quiet, so a burst (a sync pull, a
  // folder copy) costs one walk, not one per file (YAZ-2073 5E, 🔒 D10).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = watch.subscribe((ev) => {
      if (ev.type === 'error') return setError(ev.message)
      clearTimeout(timer)
      if (ev.type === 'ready') refresh()
      else timer = setTimeout(refresh, WATCH_REFRESH_MS)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [watch, refresh])

  return { tree, error, refresh }
}
