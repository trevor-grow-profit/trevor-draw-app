/**
 * THE HOVER PREVIEW'S PANEL (YAZ-1800), isolated (YAZ-2073 5D, 🔒 D16). The hovered row lives in a
 * tiny store the Sidebar writes and only this component reads, so a pointer crossing rows re-renders
 * this and nothing else — never the Sidebar, never the Tree.
 */
import { useEffect, useMemo, useSyncExternalStore, type RefObject } from 'react'
import type { DiagramDarkColors, TreeResponse } from '@shared/types'
import { findNode } from '../lib/treeState'
import type { Store } from '../lib/store'
import { useAppliedTheme } from '../lib/theme'
import { BoardPreview } from './BoardPreview'
import { boardPreviewKey } from './boardPreviewCache'

/** The row the pointer (or focus) rests on — pending until the dwell ends, then shown; `path` null = none. */
export interface HoverState {
  path: string | null
  shown: boolean
}

interface HoverPreviewHostProps {
  hover: Store<HoverState>
  /** The live tree: the hovered board is resolved off it, so a save swaps the picture and a deletion closes the panel. */
  tree: TreeResponse | null
  root: string
  /** Previews on (the toggle) and possible (no search typed). */
  enabled: boolean
  diagramDarkColors: DiagramDarkColors
  /** The sidebar, which the panel sits beside. */
  anchor: RefObject<HTMLElement | null>
  onClose: () => void
}

export function HoverPreviewHost({ hover, tree, root, enabled, diagramDarkColors, anchor, onClose }: HoverPreviewHostProps) {
  const { path, shown } = useSyncExternalStore(hover.subscribe, hover.getState)
  const theme = useAppliedTheme()
  // The hovered board off the LIVE tree (the Info popover's rule): its fresh mtime keys the picture, and gone closes the panel.
  const node = useMemo(() => {
    if (path === null || tree === null) return null
    const n = findNode(tree.tree, path)
    return n !== null && n.type === 'file' ? n : null
  }, [path, tree])
  useEffect(() => {
    if (path !== null && tree !== null && node === null) onClose()
  }, [path, tree, node, onClose])
  // Escape closes the preview — and ONLY while there is one, so the key is otherwise untouched for the
  // selection, the menus and the canvas. Capture phase, so it wins before the body's own Escape.
  const active = path !== null
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [active, onClose])
  if (!shown || node === null || !enabled) return null
  return <BoardPreview key={node.path} root={root} node={node} cacheKey={boardPreviewKey(root, node, theme, diagramDarkColors)} anchor={anchor} />
}
