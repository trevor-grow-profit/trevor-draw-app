/**
 * THE HOVER PREVIEW (YAZ-1800): a board row rested on for the dwell opens a picture of the whole
 * board beside the sidebar. `hover` is the row — pending until the dwell ends, then shown. A save to
 * it is only a new picture key, which the panel swaps in place (🔒 D5 amendment); only the row
 * leaving the tree closes it. Every close bumps `hoverRequest`, so an earlier row's dwell never fires late.
 * It is a STORE only `HoverPreviewHost` reads (YAZ-2073 5D): crossing rows re-renders the panel, never the Sidebar.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode } from '@shared/treeSort'
import { createStore } from '../../lib/store'
import type { HoverState } from '../HoverPreviewHost'

/** How long the pointer (or focus) rests on a board row before its preview opens (YAZ-1800). */
export const BOARD_PREVIEW_DWELL_MS = 400

interface HoverPreviewOptions {
  /** A menu or the Info popover owns the pointer while it stands: nothing opens under it. */
  blocked: boolean
  /** Previews on (the toggle) and possible (no search typed). */
  enabled: boolean
  activeFile: string | null
}

export function useHoverPreview({ blocked, enabled, activeFile }: HoverPreviewOptions) {
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
