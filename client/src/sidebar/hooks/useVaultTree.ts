/** The vault's tree as this panel holds it (data, open folders, Files order, the active file it no longer shows), and its two narrowed readings: Focus Mode and the Favorites lens. */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react'
import { isWithin } from '@shared/paths'
import type { SidebarLens, SortOrder, TreeResponse } from '@shared/types'
import { api, BridgeRequestError } from '../../api'
import type { WatchSource } from '../../hooks/useWatch'
import type { NoticeKind } from '../../lib/notice'
import { storage } from '../../lib/storage'
import { allDirs, favoriteRoots, findDirNode, focusRoots, sameList, treeHasFile, treeReducer, type TreeAction } from '../../lib/treeState'
import type { TreeReorder } from '../Tree'

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

/** One lens's focus list, read from this window's identity and kept in step with it and with the live tree. */
function useFocusList(read: () => readonly string[], write: (dirs: readonly string[]) => void, tree: TreeResponse | null) {
  const [dirs, setDirs] = useState<readonly string[]>(read)
  // Focus Mode's write-back (YAZ-1605), idempotent like the expansion's (⚡ YAZ-874) — into this window's
  // identity (YAZ-1628), not the vault bucket.
  useEffect(() => {
    if (!sameList(read(), dirs)) write(dirs)
  }, [read, write, dirs])
  // A focus target that left the vault DROPS OUT — deleted or moved out — and the last one leaving
  // ends the focus: never an empty tree under a lit eye. The store repairs the FILE on delete; this
  // component holds its own copy, so it prunes against the live tree itself, exactly as the selection does.
  useEffect(() => {
    if (tree === null || dirs.length === 0) return
    const kept = dirs.filter((dir) => findDirNode(tree.tree, dir) !== null)
    if (kept.length !== dirs.length) setDirs(kept)
  }, [tree, dirs])
  return [dirs, setDirs] as const
}

/**
 * Focus Mode (YAZ-1605): one path LIST per lens — dirs, on both lenses; empty is no focus.
 * Per WINDOW since YAZ-1628 (`sidebarCollapsed`'s rule), unlike the per-vault expansion:
 * restored from this window's identity and written back the same way, so it survives a lens
 * switch and a restart and follows its own rename, ⌘⇧N inherits it, and another window on the
 * same vault is never affected.
 */
export function useFocusMode(root: string, tree: TreeResponse | null, lens: SidebarLens, dispatch: Dispatch<TreeAction>) {
  const [focusDirs, setFocusDirs] = useFocusList(storage.getFocusDirs, storage.setFocusDirs, tree)
  const [focusFavorites, setFocusFavorites] = useFocusList(storage.getFocusFavorites, storage.setFocusFavorites, tree)
  // The focused top rows (YAZ-1605), resolved off the LIVE tree in tree order — a vanished dir yields
  // no row, and the prune drops it. The vault's `dirs` stay WHOLE: reveal must still find what is hidden.
  const focusNodes = useMemo(() => (tree === null || focusDirs.length === 0 ? [] : focusRoots(tree.tree, focusDirs)), [tree, focusDirs])
  // Favorites are NOT pruned against the tree here (D14): a path missing on this machine may simply not
  // have synced yet, so it draws no row (`favoriteRoots`) and main heals dead entries on the next write.

  /**
   * Focus Mode (YAZ-1605): narrow `inLens` — the menu's pinned lens, FILES for a search row (Docs
   * YAZ-2050 D1, YAZ-2056 D5) — to these folders, REPLACING any focus, one or many — and OPEN each
   * row (the synthetic-child idiom `startCreate` uses), so the tree never lands on closed chevrons.
   */
  const focusOn = useCallback(
    (paths: string[], inLens: SidebarLens) => {
      // Favorites keeps its OWN list (YAZ-1766 D5); both lenses share the one expansion (D7).
      if (inLens === 'favorites') setFocusFavorites(paths)
      else setFocusDirs(paths)
      for (const path of paths) dispatch({ type: 'expandTo', root, file: `${path}/x` })
    },
    [root, dispatch],
  )
  const focused = lens === 'favorites' ? focusFavorites.length > 0 : focusNodes.length > 0
  const exitFocus = useCallback(() => (lens === 'favorites' ? setFocusFavorites([]) : setFocusDirs([])), [lens])

  return { focusDirs, setFocusDirs, focusFavorites, focusNodes, focused, focusOn, exitFocus }
}

/**
 * Favorites (YAZ-1766 D2, in the vault since 6A/D11): the vault's pinned files and folders in the
 * user's order, read from `.yaseendraw/favorites.json` through main (absolute paths). Another
 * window's — or another machine's, via sync — write lands here through `favorites:changed`.
 */
export function useFavoritesLens(root: string, tree: TreeResponse | null, focusFavorites: readonly string[], onNotice: (message: string, kind?: NoticeKind) => void) {
  const [favorites, setFavorites] = useState<readonly string[]>([])
  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites
  // Favorites drag-to-reorder (D4): the dragged root row + the hovered row and edge.
  const [reorderDragging, setReorderDragging] = useState<string | null>(null)
  const [reorderOver, setReorderOver] = useState<{ path: string; edge: 'before' | 'after' } | null>(null)
  // The Favorites tab's rows (YAZ-1766 D4/D5): its own focus list when set, else the favorites — each
  // in STORED order, off the live tree; nesting and redundancy are kept (`favoriteRoots`, not `focusRoots`).
  const favoriteNodes = useMemo(() => (tree === null ? [] : favoriteRoots(tree.tree, focusFavorites.length > 0 ? focusFavorites : favorites)), [tree, favorites, focusFavorites])
  const favoriteDirs = useMemo(() => allDirs(favoriteNodes), [favoriteNodes])

  // Favorites (6A/6C): read once per root, then re-read on every `favorites:changed` for this root —
  // an own write's echo, another window's, or a synced file. A stale root's answer is dropped.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      void api.favorites.get(root).then((next) => {
        if (!cancelled) setFavorites((prev) => (sameList(prev, next) ? prev : next))
      })
    load()
    const off = api.favorites.onChanged((c) => {
      if (c.root === root) load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [root])
  /**
   * The ONE writer (6C): optimistic, then main writes the file; a refusal (a malformed favorites.json
   * → INVALID_CONFIG, D12) reverts the list and toasts. Main drops dead entries on the way (D14).
   */
  const saveFavorites = useCallback(
    (next: readonly string[]) => {
      const prev = favoritesRef.current
      setFavorites(next)
      api.favorites.set(root, next).catch((err: unknown) => {
        setFavorites(prev)
        onNotice(`Can't save favorites: ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [root, onNotice],
  )

  /**
   * The favorite toggle (YAZ-1766 D3/D6): remove every path, or append the ones not yet pinned —
   * insertion order, no duplicates. `isOn` arrives with the paths, so the caller states the verb.
   * The toast confirms with its own glyph; `saveFavorites` persists.
   */
  const toggleFavorite = useCallback(
    (paths: string[], isOn: boolean) => {
      const n = paths.length > 1 ? `${paths.length} ` : ''
      const prev = favoritesRef.current
      saveFavorites(isOn ? prev.filter((p) => !paths.includes(p)) : [...prev, ...paths.filter((p) => !prev.includes(p))])
      onNotice(isOn ? `Removed ${n}from favorites` : `Added ${n}to favorites`, 'favorite')
    },
    [onNotice, saveFavorites],
  )

  // ---- Favorites drag-to-reorder (YAZ-1766 D4): a root row dropped above/below another rewrites the list ----

  const dropReorder = useCallback(() => {
    const from = reorderDragging
    const over = reorderOver
    setReorderDragging(null)
    setReorderOver(null)
    if (from === null || over === null || over.path === from) return
    const prev = favoritesRef.current
    const without = prev.filter((p) => p !== from)
    const i = without.indexOf(over.path)
    if (i < 0) return
    const at = over.edge === 'before' ? i : i + 1
    saveFavorites([...without.slice(0, at), from, ...without.slice(at)])
  }, [reorderDragging, reorderOver, saveFavorites])

  /** Off while the tab is focused: the focus list is what is shown then, not the favorites order. */
  const reorderOff = focusFavorites.length > 0
  const favoriteReorder = useMemo<TreeReorder>(
    () => ({
      dragging: reorderDragging,
      over: reorderOver,
      start: reorderOff ? () => undefined : setReorderDragging,
      hover: (path, edge) => setReorderOver((prev) => (prev?.path === path && prev.edge === edge ? prev : { path, edge })),
      drop: dropReorder,
      end: () => {
        setReorderDragging(null)
        setReorderOver(null)
      },
    }),
    [reorderDragging, reorderOver, reorderOff, dropReorder],
  )

  return { favorites, favoriteNodes, favoriteDirs, toggleFavorite, favoriteReorder }
}
