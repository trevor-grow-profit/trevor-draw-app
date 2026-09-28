/**
 * The tab menu's "Show in sidebar" and a folder search row (YAZ-1063, 🔒 D3 YAZ-1491): App's reveal
 * request, accepted once, pinned to its lens — then, on Files, the target's folders open and its row flashes.
 */
import { useEffect, useRef, useState, type Dispatch, type RefObject } from 'react'
import type { SidebarLens, TreeResponse } from '@shared/types'
import { isWithin } from '@shared/paths'
import type { NoticeKind } from '../../lib/notice'
import { ancestorDirs, treeHasFile, type TreeAction } from '../../lib/treeState'
import { flashTreeRows, revealMissingMessage, type SidebarRevealRequest } from '../revealRow'

interface RevealOptions {
  root: string
  lens: SidebarLens
  revealRequest: SidebarRevealRequest | null
  onRevealConsumed: (id: number) => void
  tree: TreeResponse | null
  /** Every directory of the tree, focused away or not. */
  dirs: readonly string[]
  expanded: readonly string[]
  dispatch: Dispatch<TreeAction>
  focusDirs: readonly string[]
  setFocusDirs: (dirs: readonly string[]) => void
  /** An accepted reveal clears the search, so the tree is the body again. */
  setQuery: (query: string) => void
  onNotice: (message: string, kind?: NoticeKind) => void
  bodyRef: RefObject<HTMLDivElement | null>
}

export function useRevealRequest({ root, lens, revealRequest, onRevealConsumed, tree, dirs, expanded, dispatch, focusDirs, setFocusDirs, setQuery, onNotice, bodyRef }: RevealOptions) {
  const seenRevealId = useRef<number | null>(null)
  const handledFilesRevealId = useRef<number | null>(null)
  const [pendingReveal, setPendingReveal] = useState<SidebarRevealRequest | null>(null)

  useEffect(() => {
    if (revealRequest === null || seenRevealId.current === revealRequest.id) return
    seenRevealId.current = revealRequest.id
    onRevealConsumed(revealRequest.id)
    if (revealRequest.lens !== lens) {
      setPendingReveal(null)
      return
    }
    setQuery('')
    setPendingReveal(revealRequest)
  }, [lens, onRevealConsumed, revealRequest, setQuery])

  useEffect(() => {
    if (pendingReveal !== null && pendingReveal.lens !== lens) setPendingReveal(null)
  }, [lens, pendingReveal])

  // A Files reveal targets a file — or, since a folder search row (🔒 D3, YAZ-1491), a DIR of the
  // tree. Both questions are asked once here and read by the two steps below.
  const revealIsDir = pendingReveal?.lens === 'files' && dirs.includes(pendingReveal.path)
  const revealTargetPresent = tree !== null && pendingReveal?.lens === 'files' && (revealIsDir || treeHasFile(tree.tree, pendingReveal.path))

  useEffect(() => {
    if (tree === null || pendingReveal?.lens !== 'files' || handledFilesRevealId.current === pendingReveal.id) return
    handledFilesRevealId.current = pendingReveal.id
    if (!revealTargetPresent) {
      onNotice(revealMissingMessage(pendingReveal.path, 'files'), 'error')
      return
    }
    // A reveal is "show me THIS" (YAZ-1605): a target outside every focused folder ends the focus first.
    if (focusDirs.length > 0 && !focusDirs.some((dir) => isWithin(dir, pendingReveal.path))) setFocusDirs([])
    // A folder opens ITSELF too — the synthetic-child idiom the create menu already uses.
    dispatch({ type: 'expandTo', root, file: revealIsDir ? `${pendingReveal.path}/x` : pendingReveal.path })
  }, [dispatch, focusDirs, onNotice, pendingReveal, revealIsDir, revealTargetPresent, root, setFocusDirs, tree])

  const filesRevealReady = revealTargetPresent && ancestorDirs(root, pendingReveal.path).every((dir) => expanded.includes(dir))

  useEffect(() => {
    if (!filesRevealReady || pendingReveal === null || bodyRef.current === null) return
    return flashTreeRows(bodyRef.current, pendingReveal.path) ?? undefined
  }, [filesRevealReady, pendingReveal, bodyRef])
}
