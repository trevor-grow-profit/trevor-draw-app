/**
 * Favorites (YAZ-1766 D2, in the vault since 6A/D11): the vault's pinned files and folders in the
 * user's order, read from `.yaseendraw/favorites.json` through main (absolute paths). Another
 * window's — or another machine's, via sync — write lands here through `favorites:changed`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TreeResponse } from '@shared/types'
import { api } from '../../api'
import type { NoticeKind } from '../../lib/notice'
import { allDirs, favoriteRoots } from '../../lib/treeState'
import type { TreeReorder } from '../Tree'
import { sameList } from './sameList'

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
