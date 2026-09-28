/** The vault's tree as this panel holds it: data, open folders, Files order, and the active file it no longer shows. Its two narrowed readings are `useFocusMode` and `useFavoritesLens`. */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { isWithin } from '@shared/paths'
import type { SortOrder, TreeResponse } from '@shared/types'
import { api, BridgeRequestError } from '../../api'
import type { WatchSource } from '../../hooks/useWatch'
import { storage } from '../../lib/storage'
import { sameList, treeHasFile, treeReducer } from '../../lib/treeState'

/** The quiet a watcher change waits out before the tree refreshes; a burst inside it is one walk (YAZ-2073 5E). */
export const WATCH_REFRESH_MS = 120

export function useVaultTree(root: string, watch: WatchSource, activeFile: string | null, onRootMissing: () => void, onFileMissing: () => void) {
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, dispatch] = useReducer(treeReducer, root, storage.getExpanded)
  // The Files lens's order (🔒 YAZ-1835 D3): per vault, read off the store and re-read when another window changes it.
  const [sortOrder, setSortOrderState] = useState<SortOrder>(() => storage.getSortOrder(root))

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

  // Another window's sort change lands in the store cache; follow it (🔒 YAZ-1835 D3).
  useEffect(() => storage.subscribe(() => setSortOrderState(storage.getSortOrder(root))), [root])
  const setSortOrder = useCallback(
    (order: SortOrder) => {
      setSortOrderState(order)
      storage.setSortOrder(root, order)
    },
    [root],
  )

  useEffect(() => {
    // Idempotent (⚡ YAZ-874): the first render holds exactly what was
    // just read, and re-sending it would make the main process commit, write and broadcast for nothing.
    if (sameList(storage.getExpanded(root), expanded)) return
    storage.setExpanded(root, expanded)
  }, [root, expanded])

  // The file this mount woke up with is SHOWN, not revealed (YAZ-1642): a relaunch restores the
  // tab and leaves the tree collapsed. Any file opened after that still opens its folders.
  const restoredFile = useRef(activeFile)
  useEffect(() => {
    if (activeFile === restoredFile.current) return
    restoredFile.current = null
    if (activeFile !== null) dispatch({ type: 'expandTo', root, file: activeFile })
  }, [root, activeFile])

  // Stored lastFile that no longer exists → drop it (first tree only, so a file deleted on disk
  // EXTERNALLY while it is being edited stays open and is recreated by the next save — an
  // IN-APP delete never reaches here, it closes tabs through the `file:deleted` broadcast
  // which retires the editor first (GRO-2272); do not unify the two. Files OUTSIDE the
  // root (opened via a pasted `#/abs/path.excalidraw` URL, GRO-2069) are never in the tree — skip them.
  const validated = useRef(false)
  useEffect(() => {
    if (tree === null || validated.current) return
    validated.current = true
    if (activeFile !== null && isWithin(root, activeFile, true) && !treeHasFile(tree.tree, activeFile))
      onFileMissing()
  }, [tree, activeFile, root, onFileMissing])

  // A stale tab ACTIVATED after its file vanished on disk (I3, GRO-2235): when the activation
  // CHANGES to an in-root file the cached tree does not show, confirm against a FRESH tree —
  // the inline-create flow activates a just-created file before `refresh()` lands, so the
  // cached tree can be behind — and close it through the same onFileMissing path. A file
  // deleted EXTERNALLY while it is the active editor stays open (no activation change —
  // recreated by the next save); an IN-APP delete never routes through here, it closes tabs
  // via the `file:deleted` broadcast, which also retires the editor first (GRO-2272). Do not
  // unify the two. Background tabs are never probed (out of scope, noted in GRO-2235).
  const lastActive = useRef(activeFile)
  const treeRef = useRef(tree)
  treeRef.current = tree
  useEffect(() => {
    if (activeFile === lastActive.current) return
    lastActive.current = activeFile
    if (activeFile === null || !isWithin(root, activeFile, true)) return
    if (treeRef.current !== null && treeHasFile(treeRef.current.tree, activeFile)) return
    let cancelled = false // the activation moved on (or the sidebar unmounted): the probe's verdict is stale
    api.tree(root).then(
      (res) => {
        if (!cancelled && !treeHasFile(res.tree, activeFile)) onFileMissing()
      },
      () => undefined, // a root-level failure is refresh()'s problem, not this probe's
    )
    return () => {
      cancelled = true
    }
  }, [activeFile, root, onFileMissing])

  // The Tree is memoized (YAZ-2073 5D): these two keep their identity until they change.
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const toggleDir = useCallback((dir: string) => dispatch({ type: 'toggle', dir }), [])

  return { tree, error, refresh, expanded, dispatch, expandedSet, toggleDir, sortOrder, setSortOrder }
}
