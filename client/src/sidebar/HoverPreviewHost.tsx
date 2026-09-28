/**
 * THE HOVER PREVIEW (YAZ-1800): a board row rested on for the dwell opens a picture of the whole
 * board beside the sidebar. The row is pending until the dwell ends, then shown. A save to it is
 * only a new picture key, which the panel swaps in place (🔒 D5 amendment); only the row leaving the
 * tree closes it. Every close bumps `hoverRequest`, so an earlier row's dwell never fires late.
 * Isolated (YAZ-2073 5D, 🔒 D16): the row lives in a tiny store the Sidebar writes and only the panel
 * reads, so a pointer crossing rows re-renders the panel and nothing else — never the Sidebar or the Tree.
 * The Sidebar's half, `useHoverPreview`, lives here rather than in `hooks/`: it writes the store this
 * panel reads, and the two halves only make sense side by side.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { DiagramDarkColors, TreeResponse } from '@shared/types'
import type { FileNode } from '@shared/treeSort'
import { findNode } from '../lib/treeState'
import { createStore, type Store } from '../lib/store'
import { useAppliedTheme } from '../lib/theme'
import { BoardPreview } from './BoardPreview'
import { boardPreviewKey } from './boardPreviewCache'

/** The row the pointer (or focus) rests on — pending until the dwell ends, then shown; `path` null = none. */
export interface HoverState {
  path: string | null
  shown: boolean
}

/** How long the pointer (or focus) rests on a board row before its preview opens (YAZ-1800). */
export const BOARD_PREVIEW_DWELL_MS = 400

export function useHoverPreview(blocked: boolean, enabled: boolean, activeFile: string | null) {
  const [hover] = useState(() => createStore<HoverState>({ path: null, shown: false }))
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverRequest = useRef(0)
  const blockedRef = useRef(blocked)
  blockedRef.current = blocked
  const closePreview = useCallback(() => {
    hoverRequest.current++
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    hover.set({ path: null, shown: false })
  }, [hover])
  const hoverFile = useCallback(
    (node: FileNode | null) => {
      // The same row again (focus after the pointer, or back) keeps its dwell or its panel.
      if (node !== null && hover.getState().path === node.path) return
      closePreview()
      if (node === null || blockedRef.current) return
      const id = hoverRequest.current
      const { path } = node
      hover.set({ path, shown: false })
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null
        if (id === hoverRequest.current) hover.set({ shown: true })
      }, BOARD_PREVIEW_DWELL_MS)
    },
    [hover, closePreview],
  )
  // Everything else that ends a glance: the toggle, a search, a menu opening, another board opening.
  useEffect(() => {
    if (!enabled || blocked) closePreview()
  }, [enabled, blocked, closePreview])
  useEffect(() => closePreview(), [activeFile, closePreview])
  useEffect(() => closePreview, [closePreview]) // unmount: no dwell timer outlives the sidebar

  return { hover, hoverFile, closePreview }
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
  // Escape closes the preview — and ONLY while one shows, so the key is otherwise untouched for the
  // selection, the menus and the canvas; a dwell still pending has no panel to close (YAZ-2073 8B).
  // Capture phase, so it wins before the body's own Escape.
  const visible = shown && node !== null && enabled
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])
  if (!visible) return null
  return <BoardPreview key={node.path} root={root} node={node} cacheKey={boardPreviewKey(root, node, theme, diagramDarkColors)} anchor={anchor} />
}
