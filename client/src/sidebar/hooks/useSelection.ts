import { useCallback, useEffect, useMemo, useReducer, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import type { SidebarLens, TreeResponse } from '@shared/types'
import { EMPTY_SELECTION, orderedSelection, selectionReducer } from '../../lib/selection'
import { treeHasPath } from '../../lib/treeState'
import type { TreeSelection } from '../Tree'

/**
 * Multi-select (YAZ-1336, 🔒 D1): the selected PATHS — files and, since YAZ-1578, folders —
 * shared by BOTH lenses, one entry per path however many rows draw it (🔒 YAZ-1336 D3). It lives in
 * the Sidebar and nowhere else on purpose: that component is mounted `key={root}` and only while the
 * sidebar is open, so a selection is honestly about rows currently on screen and cannot
 * outlive them (a collapse ends it).
 */
export function useSelection(lens: SidebarLens, searching: boolean, tree: TreeResponse | null, bodyRef: RefObject<HTMLDivElement | null>, menuOpen: boolean) {
  const [selectedPaths, dispatchSelection] = useReducer(selectionReducer, EMPTY_SELECTION)

  // A selection is about the rows on screen (YAZ-1336), so whatever REPLACES them ends it: the
  // other lens is a different reading of the vault, and a typed query swaps the body for the flat
  // list entirely (🔒 the flat-list ruling on YAZ-739). `clear` on an empty selection returns the
  // same set, so the mount pass and every ordinary render below cost nothing.
  useEffect(() => {
    dispatchSelection({ type: 'clear' })
  }, [lens, searching])

  // The loaded tree is the canonical disk truth for BOTH lenses —
  // so a path it no longer has cannot stay selected. A selected path is a file OR a folder
  // (YAZ-1578, 🔒 D1), hence `treeHasPath` here and nowhere else. Reference-stable when nothing
  // was dropped, which is every refresh that changed something else.
  useEffect(() => {
    if (tree === null) return
    dispatchSelection({ type: 'prune', exists: (path) => treeHasPath(tree.tree, path) })
  }, [tree])

  /**
   * The whole selection as a list, ordered by the PANEL (YAZ-1337, as ⚡ YAZ-1338 rules it): the
   * rows on screen first, in the order the eye reads them — never click order, which is not an
   * order the user can see — and every still-selected path with no row appended after them, so
   * collapsing a folder over a selected file hides the row and keeps the file. The one rule lives
   * in `orderedSelection`, which the clipboard chords read too: the menu and the chords cannot
   * spell one selection two ways.
   */
  const orderedSelectedPaths = useCallback((): string[] => orderedSelection(selectedPaths, bodyRef.current), [selectedPaths, bodyRef])

  /** The multi-select as both trees take it (YAZ-1336): the set, plus its two gestures — toggle (shift) and set (any other click, D9). */
  const selection = useMemo<TreeSelection>(
    () => ({
      paths: selectedPaths,
      toggle: (path) => dispatchSelection({ type: 'toggle', path }),
      set: (path) => dispatchSelection({ type: 'set', path }),
    }),
    [selectedPaths],
  )

  // Escape drops the multi-select (YAZ-1336) — and ONLY when there is one: with nothing
  // selected the key still belongs to everyone else listening for it, so this must neither
  // swallow it nor stop it travelling. An OPEN context menu owns the key outright
  // (YAZ-1340): its window listener is closing it on this very press, and one Escape must
  // not also throw the selection the menu was about to act on.
  // (⌘C/⌘X/⌘V are App's window listener, D6 — see `clipboardRef`.)
  const clearOnEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || selectedPaths.size === 0 || menuOpen) return
    e.preventDefault()
    e.stopPropagation()
    dispatchSelection({ type: 'clear' })
  }

  // A plain LEFT click on blank space ends the selection (D6 amended, YAZ-1674), so ⌘V then
  // pastes into the vault root — the Finder rule. Rows, inputs and buttons own their own
  // clicks (a row click SELECTS, D9), and a right-click keeps the selection standing
  // (YAZ-1337: its menu is about the root, not a fresh pick; the menu's overlay lives
  // outside this body, so its own mousedown never arrives here).
  const clearOnBlankClick = (e: MouseEvent) => {
    if (e.button !== 0 || selectedPaths.size === 0) return
    if (e.target instanceof Element && e.target.closest('button, input, textarea, a, [role="treeitem"]') !== null) return
    dispatchSelection({ type: 'clear' })
  }

  return { selectedPaths, dispatchSelection, selection, orderedSelectedPaths, clearOnEscape, clearOnBlankClick }
}
