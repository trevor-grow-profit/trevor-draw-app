/**
 * The "Info" popover (🔒 YAZ-1835 D6): the board's PATH, resolved against the live tree at render;
 * `now` is pinned at open, like the vault switcher's, so a relative time never shifts on a re-render.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TreeResponse } from '@shared/types'
import { findNode } from '../../lib/treeState'

export function useInfoPopover(tree: TreeResponse | null) {
  const [infoPopover, setInfoPopover] = useState<{ x: number; y: number; path: string; now: number } | null>(null)
  // The Info popover's board, off the LIVE tree (🔒 YAZ-1835 D7): a refresh moves its dates; a deletion closes it.
  const infoNode = useMemo(() => {
    if (infoPopover === null || tree === null) return null
    const n = findNode(tree.tree, infoPopover.path)
    return n !== null && n.type === 'file' ? n : null
  }, [infoPopover, tree])
  // The board went (deleted, moved): close for good, so a path that comes back does not reopen it.
  useEffect(() => {
    if (infoPopover !== null && tree !== null && infoNode === null) setInfoPopover(null)
  }, [infoPopover, tree, infoNode])
  return { infoPopover, setInfoPopover, infoNode }
}
