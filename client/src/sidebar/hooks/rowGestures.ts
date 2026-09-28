/** What the rows do: multi-select, the file clipboard, the inline name boxes and drag-to-move. */
import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch, type DragEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { EMPTY_DIAGRAM_XML } from '@shared/diagramFile'
import type { FileClipState, SidebarLens, TreeNode, TreeResponse } from '@shared/types'
import { api } from '../../api'
import { EMPTY_SCENE_JSON } from '../../drawings/drawingScene'
import type { NoticeKind } from '../../lib/notice'
import { basename } from '../../lib/paths'
import { EMPTY_SELECTION, orderedSelection, selectionReducer } from '../../lib/selection'
import { treeHasPath, type TreeAction } from '../../lib/treeState'
import type { PendingCreate, PendingRename, TreeFileMove, TreeSelection } from '../Tree'
import { entryPath, renamedPath, type EntryKind } from '../createEntry'
import { countItems } from '../menuSections'

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

/** Cut / Copy / Paste (YAZ-1674): the app-wide clipboard as this window sees it, and its verbs. */
export function useFileClipboard(root: string, refresh: () => void, dispatch: Dispatch<TreeAction>, onNotice: (message: string, kind?: NoticeKind) => void) {
  /**
   * Main's ONE app-wide file clipboard (🔒 YAZ-1674 D1): `{ count, op }` or null, pushed to every window on
   * every change, so a menu opened here can label "Paste N items" for a copy made in another
   * window on another vault. Session-only, never persisted. A window opened AFTER a clip reads the
   * current state ONCE on mount (`clipState`), so its Paste is labelled from the start.
   */
  const [clip, setClip] = useState<FileClipState>(null)
  useEffect(() => {
    // Subscribe FIRST, then read: a push that lands while the read is in flight is newer than the
    // read and must win — the read only fills a window nothing has pushed to yet.
    let live = true
    let pushed = false
    const unsubscribe = api.onClipChanged((state) => {
      pushed = true
      setClip(state)
    })
    api.clipState().then(
      (state) => {
        if (live && !pushed) setClip(state)
      },
      () => undefined, // an empty clipboard is the honest fallback; the next push corrects it
    )
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  /**
   * Cut / Copy: hand the ordered paths to main (🔒 YAZ-1674 D1) and SAY SO — every clipboard write confirms
   * (YAZ-1341), and a refusal is reported, never swallowed. The selection stands: acting on it is
   * not the same as ending it (YAZ-1337).
   */
  const clipTo = useCallback(
    (paths: string[], op: 'copy' | 'cut') => {
      const what = countItems(paths.length)
      api.clip({ paths, op }).then(
        () => onNotice(op === 'cut' ? `Cut ${what}` : `Copied ${what}`, op),
        (err: unknown) => onNotice(`Can't ${op}: ${err instanceof Error ? err.message : String(err)}`, 'error'),
      )
    },
    [onNotice],
  )

  /**
   * Paste into `dir` (🔒 YAZ-1674 D2–D4): PER-ENTRY results, so one bad entry never hides the rest — the
   * notice counts both halves and names the first failure. The target opens (the synthetic-child
   * idiom `startCreate` uses) and the tree refreshes EXPLICITLY: a copy moves nothing, so no
   * `fileRenamed` broadcast repairs it, and the watcher's add echo is a courtesy, not a contract
   * (`refresh` is idempotent).
   */
  const pasteInto = useCallback(
    async (dir: string) => {
      try {
        const res = await api.paste({ targetDir: dir })
        if (dir !== root) dispatch({ type: 'expandTo', root, file: `${dir}/x` })
        refresh()
        const first = res.failed[0]
        if (first === undefined) {
          // Reachable only when EVERY entry was a cut into the folder it is already in (skipped silently, D2) — nothing went wrong.
          if (res.pasted.length === 0) onNotice('Nothing to paste', 'info')
          else onNotice(`Pasted ${countItems(res.pasted.length)}`, 'paste')
        } else if (res.pasted.length === 0) onNotice(`Couldn't paste: ${basename(first.from)} — ${first.message}`, 'error')
        else onNotice(`Pasted ${countItems(res.pasted.length)}, skipped ${res.failed.length}: ${basename(first.from)} — ${first.message}`, 'paste')
      } catch (err: unknown) {
        onNotice(`Can't paste: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    },
    [root, dispatch, refresh, onNotice],
  )

  return { clip, clipTo, pasteInto }
}

/** The two inline name boxes: New drawing / folder in the target folder (GRO-2022), Rename over the row (E1 GRO-2194, E1b GRO-2241). */
export function useInlineEdits(refresh: () => void, onOpenFile: (path: string) => void, onRenameFile: (oldPath: string, newPath: string, kind: TreeNode['type']) => Promise<void>) {
  const [creating, setCreating] = useState<{ kind: EntryKind; seed: string; parentDir: string } | null>(null)
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)

  const submitCreate = useCallback(
    async (name: string) => {
      if (creating === null) return
      const p = entryPath(creating.parentDir, name, creating.kind)
      if (creating.kind === 'dir') await api.createDir(p)
      // Content-at-create (🔒 YAZ-1810): a new board is born with its EMPTY content in the same `wx`
      // write — a zero-byte `.excalidraw` or `.drawio` is exactly the corrupt case the editor's error pane exists for.
      else await api.createFile({ path: p, content: creating.kind === 'diagram' ? EMPTY_DIAGRAM_XML : EMPTY_SCENE_JSON })
      setCreating(null)
      refresh()
      if (creating.kind !== 'dir') onOpenFile(p)
    },
    [creating, refresh, onOpenFile],
  )

  const cancelCreate = useCallback(() => setCreating(null), [])
  const pending = useMemo<PendingCreate | null>(
    () => (creating === null ? null : { kind: creating.kind, seed: creating.seed, parentDir: creating.parentDir, onSubmit: submitCreate, onCancel: cancelCreate }),
    [creating, submitCreate, cancelCreate],
  )

  const submitRename = useCallback(
    async (name: string) => {
      if (renamingEntry === null) return
      const target = renamedPath(renamingEntry.path, name, renamingEntry.kind)
      setRenamingEntry(null)
      if (target === renamingEntry.path) return // same name = no-op
      // App owns the whole flow (and routes failures to the passive notice — never a dialog);
      // the tree row follows via the watcher's unlink+add refresh.
      await onRenameFile(renamingEntry.path, target, renamingEntry.kind)
    },
    [renamingEntry, onRenameFile],
  )

  const cancelRename = useCallback(() => setRenamingEntry(null), [])
  const renaming = useMemo<PendingRename | null>(
    () => (renamingEntry === null ? null : { path: renamingEntry.path, onSubmit: submitRename, onCancel: cancelRename }),
    [renamingEntry, submitRename, cancelRename],
  )

  return { startCreate: setCreating, pending, startRename: setRenamingEntry, renaming }
}

/** File drag-to-move (E1b, GRO-2241): the dragged FILE row and its drop target — a folder row or the root header. */
export function useTreeDrag(root: string, onRenameFile: (oldPath: string, newPath: string, kind: TreeNode['type']) => Promise<void>) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)

  const dropOnDir = useCallback(
    (dir: string) => {
      const path = dragging
      setDragging(null)
      setDropDir(null)
      if (path === null) return
      const target = `${dir}/${basename(path)}`
      if (target === path) return // dropped into its own folder: nothing to do
      // The SAME rename flow as the context menu — never-overwrite and every failure as a
      // passive notice come with it; link updates and the workspace remap ride the same pipeline.
      void onRenameFile(path, target, 'file')
    },
    [dragging, onRenameFile],
  )

  const fileMove = useMemo<TreeFileMove>(
    () => ({
      dragging,
      dropDir,
      start: setDragging,
      end: () => {
        setDragging(null)
        setDropDir(null)
      },
      hover: setDropDir,
      drop: dropOnDir,
    }),
    [dragging, dropDir, dropOnDir],
  )

  // The root header doubles as the "move to the vault root" drop target (E1b).
  const header = {
    isDropTarget: dropDir === root,
    onDragOver: (e: DragEvent) => {
      if (dragging === null) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      if (dropDir !== root) setDropDir(root)
    },
    onDragLeave: () => {
      if (dropDir === root) setDropDir(null)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      dropOnDir(root)
    },
  }

  return { fileMove, header }
}
