/**
 * Focus Mode (YAZ-1605): one path LIST per lens — dirs, on both lenses; empty is no focus.
 * Per WINDOW since YAZ-1628 (`sidebarCollapsed`'s rule), unlike the per-vault expansion:
 * restored from this window's identity and written back the same way, so it survives a lens
 * switch and a restart and follows its own rename, ⌘⇧N inherits it, and another window on the
 * same vault is never affected.
 */
import { useCallback, useEffect, useMemo, useState, type Dispatch } from 'react'
import type { SidebarLens, TreeResponse } from '@shared/types'
import { storage } from '../../lib/storage'
import { findDirNode, focusRoots, type TreeAction } from '../../lib/treeState'
import { sameList } from './sameList'

export function useFocusMode(root: string, tree: TreeResponse | null, lens: SidebarLens, dispatch: Dispatch<TreeAction>) {
  const [focusDirs, setFocusDirs] = useState<readonly string[]>(storage.getFocusDirs)
  const [focusFavorites, setFocusFavorites] = useState<readonly string[]>(storage.getFocusFavorites)
  // The focused top rows (YAZ-1605), resolved off the LIVE tree in tree order — a vanished dir yields
  // no row, and the prune below drops it. The vault's `dirs` stay WHOLE: reveal must still find what is hidden.
  const focusNodes = useMemo(() => (tree === null || focusDirs.length === 0 ? [] : focusRoots(tree.tree, focusDirs)), [tree, focusDirs])

  // Focus Mode's write-back (YAZ-1605), idempotent like the expansion's (⚡ YAZ-874) — into this window's
  // identity (YAZ-1628), not the vault bucket.
  useEffect(() => {
    if (sameList(storage.getFocusDirs(), focusDirs)) return
    storage.setFocusDirs(focusDirs)
  }, [focusDirs])
  useEffect(() => {
    if (sameList(storage.getFocusFavorites(), focusFavorites)) return
    storage.setFocusFavorites(focusFavorites)
  }, [focusFavorites])

  // Focus Mode (YAZ-1605): a focus target that left the vault DROPS OUT — deleted or moved out —
  // and the last one leaving ends the focus: never an empty tree under a lit eye. The store repairs
  // the FILE on delete; this component holds its own copy, so it prunes against the live tree
  // itself, exactly as the selection does.
  useEffect(() => {
    if (tree === null || focusDirs.length === 0) return
    const kept = focusDirs.filter((dir) => findDirNode(tree.tree, dir) !== null)
    if (kept.length !== focusDirs.length) setFocusDirs(kept)
  }, [tree, focusDirs])
  useEffect(() => {
    if (tree === null || focusFavorites.length === 0) return
    const kept = focusFavorites.filter((dir) => findDirNode(tree.tree, dir) !== null)
    if (kept.length !== focusFavorites.length) setFocusFavorites(kept)
  }, [tree, focusFavorites])
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
