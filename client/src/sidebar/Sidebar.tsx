import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SIDEBAR_LENSES, SORT_ORDERS, type FileClipState, type SettingsState, type SidebarLens, type SortOrder, type TreeNode, type TreeResponse } from '@shared/types'
import { EMPTY_DIAGRAM_XML } from '@shared/diagramFile'
import { isWithin } from '@shared/paths'
import { api, BridgeRequestError } from '../api'
import { EMPTY_SCENE_JSON } from '../drawings/drawingScene'
import { ContextMenuSurface } from '../components/ContextMenuSurface'
import { ChevronsIcon, EyeIcon, HeartIcon, PreviewIcon, SearchIcon, SidebarPanelIcon, SortIcon } from '../components/icons'
import type { WatchSource } from '../hooks/useWatch'
import { basename } from '../lib/paths'
import { allDirs, findDirNode, findNode, treeHasFile } from '../lib/treeState'
import { sortTree } from '@shared/treeSort'
import { BoardInfo } from './BoardInfo'
import { useShareBadges } from '../share/useShareBadges'
import { HoverPreviewHost } from './HoverPreviewHost'
import { SearchResults } from '../search/SearchResults'
import { ConfirmDelete, type DeleteTarget } from './ConfirmDelete'
import { ContextMenu } from './ContextMenu'
import { datedSeed, entryPath, renamedPath, targetDirFor, type EntryKind, type MenuRow } from './createEntry'
import { SettingsButton } from '../settings/SettingsButton'
import { buildMenuSections, countItems } from './menuSections'
import type { NoticeKind } from '../lib/notice'
import { Tree, type PendingCreate, type PendingRename, type TreeFileMove } from './Tree'
import { VaultSwitcher } from './VaultSwitcher'
import { useExpansion } from './hooks/useExpansion'
import { useFavoritesLens } from './hooks/useFavoritesLens'
import { useFocusMode } from './hooks/useFocusMode'
import { useHoverPreview } from './hooks/useHoverPreview'
import { useInfoPopover } from './hooks/useInfoPopover'
import { useMissingFileChecks } from './hooks/useMissingFileChecks'
import { useRevealRequest } from './hooks/useRevealRequest'
import { useSelection } from './hooks/useSelection'
import { useSidebarSearch } from './hooks/useSidebarSearch'
import { useSortOrder } from './hooks/useSortOrder'
import { useVaultTree } from './hooks/useVaultTree'

import type { SidebarRevealRequest } from './revealRow'

export { BOARD_PREVIEW_DWELL_MS } from './hooks/useHoverPreview'
export { WATCH_REFRESH_MS } from './hooks/useVaultTree'

interface SidebarProps {
  root: string
  activeFile: string | null
  watch: WatchSource
  onOpenFile: (path: string) => void
  /** ⌘-click on a file row (I3 LOCKED ruling, GRO-2235): open in a background tab; App passes the workspace's openBackground. */
  onOpenFileBackground: (path: string) => void
  /**
   * A FOLDER search row was chosen (🔒 D3, YAZ-1491): App flips the lens to Files and issues the
   * same reveal request the tab menu uses, so the folder opens and flashes below — whichever lens
   * was showing, by Enter or by click alike. Never a tab: a folder has nothing to open.
   */
  onRevealInFiles: (path: string) => void
  /** "Open folder…" — the last row of the header's vault switcher (YAZ-1767 D4) — runs the in-place picker, unchanged. */
  onPickFolder: () => void
  /** True while the native folder dialog is open; the switcher's "Open folder…" row is disabled meanwhile. */
  pickDisabled: boolean
  /**
   * ⌘O (YAZ-1767 D8): App's request counter for the vault switcher, threaded straight to the
   * header's `VaultSwitcher`, which opens its panel and focuses the filter on every new value.
   * 0 = nothing requested (App pins a request to the root it was made on, so a remount on
   * another vault never replays it).
   */
  switcherOpenRequest: number
  /** The vault menu's "Open in this window" (YAZ-1941; decided on Docs YAZ-1798 D8) and the switcher's ⇧⏎ / ⇧-click (Docs YAZ-1974 D8): App's in-place switch, threaded to the `VaultSwitcher`. */
  onOpenVaultHere: (path: string) => Promise<boolean>
  /** Hide the sidebar (GRO-2023); TabBar leads its nav row with the Show-sidebar button while hidden (YAZ-1759). */
  onCollapse: () => void
  /**
   * Which lens the tabs row shows (🔒 D4, YAZ-847). App-owned and persisted as window identity
   * (`WindowEntry.sidebarLens`, per window since YAZ-1628), never Sidebar-local: this component
   * is mounted `key={root}` and only while the sidebar is open, so local state would forget the
   * choice on every collapse/reopen and every root switch.
   */
  lens: SidebarLens
  /** A lens tab was clicked; App writes it through to the window identity and passes the new value back down. */
  onLensChange: (lens: SidebarLens) => void
  /** One tab-menu reveal, pinned to the lens selected when it was requested. */
  revealRequest: SidebarRevealRequest | null
  /** The request has been accepted into Sidebar-local work and must not replay after a remount. */
  onRevealConsumed: (id: number) => void
  /**
   * The settings (GRO-2024); App owns and applies them. The sidebar no longer edits them (the
   * dialog does, YAZ-1679) but still READS `confirmDelete` and writes it back through the
   * delete sheet's "Don't ask me again" (GRO-2272).
   */
  settings: SettingsState
  onChangeSettings: (next: SettingsState) => void
  /** The footer cog: App mounts the settings dialog, so the cog only asks for it (YAZ-1679). */
  onOpenSettings: () => void
  /** The stored root could not be read (e.g. deleted); parent decides what to do. */
  onRootMissing: () => void
  /** The restored last file is not in the tree any more (checked once per root). */
  onFileMissing: () => void
  /**
   * Context-menu "Rename" committed (files E1 GRO-2194, folders E1b GRO-2241) — and the
   * drag-a-file-onto-a-folder move (E1b) lands here too, as a plain old→new rename: App flushes
   * the open editor(s), calls `fs:rename`, and routes ANY failure to the passive notice — this
   * promise never rejects, so the inline input just closes.
   */
  onRenameFile: (oldPath: string, newPath: string, kind: TreeNode['type']) => Promise<void>
  /**
   * Context-menu "Delete" confirmed (GRO-2272): App moves the entry to the system Trash and
   * routes ANY failure to the passive notice — this promise never rejects, so the sheet just closes.
   */
  onDeleteFile: (path: string) => Promise<void>
  /** Right-click → "Share" (YAZ-1799 D6): App opens its one Share dialog for the board. */
  onShareFile: (path: string) => void
  /** Right-click → "Version history" (YAZ-1897 D4): App opens the board's Version history. */
  onHistoryFile: (path: string) => void
  /** Show a transient, unobtrusive message — never a dialog (E1, GRO-2171). App owns the banner. */
  onNotice: (message: string, kind?: NoticeKind) => void
  /**
   * ⌘K asked for the search bar (YAZ-801): the bar focuses its input. True at MOUNT is the
   * ⌘K-while-collapsed path (App un-collapses, so the sidebar mounts with it already set), not an
   * edge case. Nothing sets it true yet — YAZ-804 wires the shortcut.
   */
  pendingSearchFocus: boolean
  /** The focus above happened (YAZ-801); App clears its flag so the next ⌘K is a fresh request. */
  onSearchFocusHandled: () => void
  /**
   * YAZ-1801 D3: absolute paths the last sync pass held back as over GitHub's limit. Rows for
   * them wear a cloud-off icon. App derives it from its ONE sync status; absent = none.
   */
  tooLarge?: ReadonlySet<string>
  /**
   * The file clipboard's two verbs for App's ⌘C / ⌘X / ⌘V listener (D6 amended, YAZ-1674). App
   * owns the LISTENER — this component is unmounted while the sidebar is collapsed, and focus
   * after a click may sit in the canvas or nowhere focusable, so a panel listener never hears the
   * key — and this component owns the RULES, behind a handle rewritten whenever a rule input
   * changes and emptied on unmount. Each verb answers whether it acted, so App knows what to swallow.
   */
  clipboardRef: { current: SidebarClipboard | null }
}

/** What App's ⌘C / ⌘X / ⌘V listener may ask of the mounted sidebar (D6 amended, YAZ-1674); each answers whether it acted. */
export interface SidebarClipboard {
  cutOrCopy: (op: 'copy' | 'cut') => boolean
  paste: () => boolean
}

/**
 * What the open context menu targets (GRO-2296). Every item has its OWN field: no item
 * derives its target — or its visibility — from another item's value.
 *
 * This split exists because the items are about to diverge. `copyPath` gains a blank-space
 * fallback to the vault ROOT (GRO-2273) and `revealPath` will want the same (GRO-2274),
 * while `renamePath` must NOT: main refuses to rename a window's own vault root
 * (`BAD_REQUEST`, E1b GRO-2241), so offering it would be an item that can only ever fail.
 * Before the split, `renamePath` was literally `menu.copyPath` and the two would have moved
 * together silently.
 */
export interface MenuTargets {
  x: number
  y: number
  /** Where "New …" creates: a dir row → itself, a file row → its parent, blank space → the root. */
  targetDir: string
  /** The right-clicked row's kind; null for blank space. Drives the Rename input's mode. */
  rowKind: 'file' | 'dir' | null
  /** "Copy path" — the right-clicked row (file or folder), or the vault ROOT for blank space (GRO-2273). */
  copyPath: string | null
  /**
   * "Copy N paths" — the MULTI-SELECT target (🔒 D5, YAZ-1337): the WHOLE selection, ordered by
   * the panel (on-screen rows first, hidden ones after — `orderedSelection`, ⚡ YAZ-1338), or null
   * when there is no plural gesture to offer (a right-click outside the selection, on blank
   * space, or on a selection of one — where the singular items already ARE this menu).
   *
   * Its OWN field per this split's whole point, and emphatically NOT `copyPath` in a list: that
   * one falls back to the vault ROOT on blank space, which is precisely a target this item must
   * never have — "Copy 1 paths" over the root is an item that means nothing. The two are free to
   * diverge again (a selection may one day hold folders, which the singular item already allows).
   */
  copyPaths: string[] | null
  /**
   * "Open N in new tabs" — the same multi-select target asked SEPARATELY (🔒 D5, YAZ-1337), and
   * `newWindowPath`'s plural sibling in spirit only: that one opens ONE file in a whole new
   * window (D2, GRO-2168), this one appends N background tabs to THIS window (I3's opener,
   * GRO-2235). Equal today, independent by construction — the doctrine above is exactly about
   * fields that happen to agree.
   */
  openTabPaths: string[] | null
  /**
   * "Cut" / "Copy" — the file-clipboard target (🔒 D5, YAZ-1674): the ORDERED 2+ selection when the
   * right-clicked row is in one (`copyPaths`' plural rule — labels "Cut 3 items"), else the one
   * row, file or dir; null on blank space, which has nothing to clip. Its OWN field, per this
   * split's doctrine: `copyPaths` is null outside a plural gesture and `copyPath` falls back to
   * the vault root, and neither is what a Cut may name.
   */
  clipPaths: string[] | null
  /** "Open in new window" — FILE rows only (D2, GRO-2168). */
  newWindowPath: string | null
  /** "Rename" — a concrete row only, NEVER blank space: the vault root is not renameable (E1b, GRO-2241). */
  renamePath: string | null
  /** "Delete" — a concrete row only, NEVER blank space: there is no target, and main refuses the vault root (GRO-2272). */
  deletePath: string | null
  /** "Reveal in Finder" — the row, or the vault ROOT for blank space (GRO-2274); same target as `copyPath`. */
  revealPath: string | null
  /** "Open in VS Code" — the same target rule again (YAZ-963); its OWN field, per this split's whole point. */
  openVsCodePath: string | null
  /** "Open in default app" — the same target rule a third time (YAZ-1577); its OWN field, same doctrine. */
  openDefaultPath: string | null
  /**
   * "Focus on folder" / "Focus on N folders" (YAZ-1605): the DIRS the menu's `lens` narrows to.
   * Inside a 2+ selection that holds the right-clicked row it is the selection's eligible rows,
   * in panel order — `copyPaths`' plural rule, counting only what can be focused, as
   * `openTabPaths` counts only files. Otherwise the one row, or null on file rows and blank
   * space. Its OWN field, per this split's doctrine.
   */
  focusPaths: string[] | null
  /**
   * "Add to favorites" / "Remove from favorites" (YAZ-1766 D3): the row, or the ordered 2+
   * selection holding it — files and folders alike, every lens; null on blank space. Its OWN field.
   */
  favoritePaths: string[] | null
  /** True only when EVERY `favoritePaths` entry is already a favorite — a mixed selection reads as Add. */
  favoriteIsOn: boolean
  /**
   * "Info" (🔒 YAZ-1835 D6): the ONE board row under the pointer; null on blank space, a folder, or a 2+
   * selection. "Share" (🔒 YAZ-1802 D11) and "Version history" (🔒 YAZ-1802 D10) take it too. Its OWN field.
   */
  infoPath: string | null
  /**
   * The lens the items act in (Docs YAZ-2050 D1, YAZ-2056 D5): the active one, or FILES for a search
   * row — a search row is a disk row, whichever tab sits under the query. Every lens read in the
   * menu path reads this.
   */
  lens: SidebarLens
  /**
   * A search row's path (Docs YAZ-2050 D2, YAZ-2056 D6), null for every tree row and blank space: the
   * items that draw INTO the tree (a name box, Focus) reveal it in Files first, since the tree is hidden.
   */
  leaveSearchTo: string | null
}

/**
 * Files and subfolders inside `dir`, counted RECURSIVELY from the already-loaded tree
 * (GRO-2272 `C3-`) — a delete takes the whole subtree, so a shallow count would understate
 * what the user is about to lose. No fetch: the sidebar already holds this tree.
 */
export function countChildren(nodes: readonly TreeNode[], dir: string): { files: number; folders: number } {
  const found = findDir(nodes, dir)
  if (found === null) return { files: 0, folders: 0 }
  let files = 0
  let folders = 0
  const walk = (children: readonly TreeNode[]): void => {
    for (const child of children) {
      if (child.type === 'dir') {
        folders++
        walk(child.children)
      } else files++
    }
  }
  walk(found)
  return { files, folders }
}

/**
 * The rows a "Focus on …" may narrow to, out of the right-clicked row or its 2+ selection
 * (YAZ-1605): DIRS, on both lenses — a shift-selection may hold files, which are simply not
 * focusable, as a folder is not openable for `openTabPaths`. Null, not `[]`, hides the item.
 */
function focusable(paths: readonly string[], tree: TreeResponse | null): string[] | null {
  const kept = paths.filter((p) => tree !== null && findDirNode(tree.tree, p) !== null)
  return kept.length > 0 ? kept : null
}

/** "Focus on folder" / "Focus on 3 folders" — the plural items' own labelling rule (YAZ-1337). */
function focusLabel(count: number): string {
  return count > 1 ? `Focus on ${count} folders` : 'Focus on folder'
}

function findDir(nodes: readonly TreeNode[], dir: string): readonly TreeNode[] | null {
  for (const node of nodes) {
    if (node.type !== 'dir') continue
    if (node.path === dir) return node.children
    if (isWithin(node.path, dir, true)) {
      const hit = findDir(node.children, dir)
      if (hit !== null) return hit
    }
  }
  return null
}

/** The lens tabs' copy; the ORDER is `SIDEBAR_LENSES`', so the default lens leads (YAZ-847). */
const LENS_LABEL: Record<SidebarLens, string> = { files: 'Files', favorites: 'Favorites' }
/** A board row — a drawing or a diagram (🔒 YAZ-1802 D2) — by the live tree's word (🔒 YAZ-1835 D6): Info describes boards, not `notes.txt`. */
function isBoardRow(tree: readonly TreeNode[], path: string): boolean {
  const node = findNode(tree, path)
  return node !== null && node.type === 'file' && node.kind !== null
}
/** The sort control's labels (🔒 YAZ-1835 D5), in `SORT_ORDERS` order. */
const SORT_LABEL: Record<SortOrder, string> = { name: 'Name', updated: 'Last updated', created: 'Created' }


/** The Favorites tree's file move (YAZ-1766 D4): nothing on that tab drags to disk, so every callback is a no-op. */
const INERT_MOVE: TreeFileMove = { dragging: null, dropDir: null, start: () => undefined, end: () => undefined, hover: () => undefined, drop: () => undefined }

/** Mounted with `key={root}` by App, so all state below is per root. */
export function Sidebar({
  root,
  activeFile,
  watch,
  onOpenFile,
  onOpenFileBackground,
  onRevealInFiles,
  onPickFolder,
  pickDisabled,
  switcherOpenRequest,
  onOpenVaultHere,
  onCollapse,
  lens,
  onLensChange,
  revealRequest,
  onRevealConsumed,
  settings,
  onChangeSettings,
  onOpenSettings,
  onRootMissing,
  onFileMissing,
  onRenameFile,
  onDeleteFile,
  onShareFile,
  onHistoryFile,
  onNotice,
  pendingSearchFocus,
  onSearchFocusHandled,
  clipboardRef,
  tooLarge,
}: SidebarProps) {
  const { tree, error, refresh } = useVaultTree(root, watch, onRootMissing)
  useMissingFileChecks(root, tree, activeFile, onFileMissing)
  const { expanded, dispatch, expandedSet, toggleDir } = useExpansion(root, activeFile)
  const { focusDirs, setFocusDirs, focusFavorites, focusNodes, focused, focusOn, exitFocus } = useFocusMode(root, tree, lens, dispatch)
  const { favorites, favoriteNodes, favoriteDirs, toggleFavorite, favoriteReorder } = useFavoritesLens(root, tree, focusFavorites, onNotice)
  const bodyRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const [menu, setMenu] = useState<MenuTargets | null>(null)
  const [sortOrder, setSortOrder] = useSortOrder(root)
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  const { infoPopover, setInfoPopover, infoNode } = useInfoPopover(tree)
  const [creating, setCreating] = useState<{ kind: EntryKind; seed: string; parentDir: string } | null>(null)
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)
  // The delete confirm sheet's target (GRO-2272 `C3-`); null when the sheet is closed.
  const [confirmingDelete, setConfirmingDelete] = useState<DeleteTarget | null>(null)
  // File drag-to-move (E1b, GRO-2241): the dragged file row + the highlighted drop target.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const { query, setQuery, searching, results, sel, setSelected, activate, searchInput, changeQuery, searchKeyDown } = useSidebarSearch({
    root,
    tree,
    pendingSearchFocus,
    onSearchFocusHandled,
    onRevealInFiles,
    onOpenFile,
    onOpenFileBackground,
  })
  const { selectedPaths, dispatchSelection, selection, orderedSelectedPaths, clearOnEscape, clearOnBlankClick } = useSelection({ lens, searching, tree, bodyRef, menuOpen: menu !== null })

  // Every directory of the CURRENT tree, outer before inner (`allDirs`): the expand-all set
  // (⚡ YAZ-862) and, since YAZ-1491, the search list's folder rows (🔒 D1) — one memo, no second
  // feed.
  const dirs = useMemo(() => (tree === null ? [] : allDirs(tree.tree)), [tree])
  // The expand/collapse-all button acts on the dirs ON SCREEN: the focused subtrees, or all of them.
  const shownDirs = useMemo(() => (focusNodes.length === 0 ? dirs : allDirs(focusNodes)), [dirs, focusNodes])
  // 🔒 YAZ-1835 D1: the order is a VIEW applied here, to the Files lens only — `fs:tree`, ⌘K and the Favorites lens never see it.
  const sortedNodes = useMemo(() => sortTree(focusNodes.length > 0 ? focusNodes : (tree?.tree ?? []), sortOrder), [focusNodes, tree, sortOrder])
  // What the chevrons button unfolds on the two disk-reading lenses.
  const bodyDirs = lens === 'favorites' ? favoriteDirs : shownDirs
  const previewsOn = settings.hoverPreview && !searching
  // A menu or the Info popover owns the pointer while it stands: nothing opens under it.
  const { hover, hoverFile, closePreview } = useHoverPreview({ blocked: menu !== null || sortMenu !== null || infoPopover !== null, enabled: previewsOn, activeFile })
  // YAZ-1799: a link mark on shared boards (red when the last update failed or the link is stale).
  const shareBadges = useShareBadges(root)
  useRevealRequest({ root, lens, revealRequest, onRevealConsumed, tree, dirs, expanded, dispatch, focusDirs, setFocusDirs, setQuery, onNotice, bodyRef })

  // Expand / collapse the whole tree (⚡ YAZ-862). "Any open" is measured against what the CURRENT
  // tree can actually unfold (`dirs`, above), never the raw persisted list, which would leave the
  // button offering to collapse nothing.
  const foldable = bodyDirs
  const anyExpanded = bodyDirs.some((d) => expanded.includes(d))
  const allLabel = anyExpanded ? 'Collapse all' : 'Expand all'

  // ---- New drawing / new folder (GRO-2022): right-click menu → inline name input ----

  const openMenu = useCallback(
    (node: MenuRow | null, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const filePath = node?.type === 'file' ? node.path : null
      // A right-click on a row the selection does NOT hold is a fresh target, so the selection
      // becomes THAT row (D9, YAZ-1674 — the Finder rule; it used to merely clear), which keeps
      // the plural items honest: whatever they name is what the user can still see highlighted.
      // BLANK SPACE is not a row and never touches it (YAZ-1337): its menu is about the vault
      // root, and a right-click into the empty space below the tree must not throw a selection away.
      if (node !== null && !selectedPaths.has(node.path)) dispatchSelection({ type: 'set', path: node.path })
      // The plural gesture exists only when the right-clicked row — file or folder (YAZ-1578) — is
      // ITSELF in a selection of two or more (🔒 YAZ-1337 D5): a selection of one already IS the singular
      // menu, and a row outside the selection just ended it above. Read once, here, like every
      // other target this menu pins.
      const plural = node !== null && selectedPaths.has(node.path) && selectedPaths.size >= 2 ? orderedSelectedPaths() : null
      // Tabs open FILES (YAZ-1578, 🔒 D3): a selected folder is copied, never opened, so the open
      // item counts only the files — and is not offered at all when the selection holds none.
      const openable = plural?.filter((path) => tree !== null && treeHasFile(tree.tree, path)) ?? []
      setMenu({
        x: e.clientX,
        y: e.clientY,
        // Only a search ROW opens a menu while searching (blank space there offers none), so `searching` names the origin.
        lens: searching ? 'files' : lens,
        leaveSearchTo: searching ? (node?.path ?? null) : null,
        targetDir: targetDirFor(node, root),
        rowKind: node?.type ?? null,
        // ONE field per item, each resolved on its own (GRO-2296). Several are the same
        // expression TODAY and must stay independent anyway — `copyPath`'s root fallback
        // below is exactly the divergence the split exists for.
        //
        // Blank space copies the vault ROOT (GRO-2273): the blank area already means "the
        // root" everywhere else here (`targetDirFor` sends "New drawing" there), and VS Code's
        // empty-Explorer menu does the same. Trailing separators are stripped so the copied
        // bytes match the root the rest of the app uses.
        copyPath: node?.path ?? root.replace(/\/+$/, ''),
        // Both plural fields read the ONE ordered list above and stay separate fields — which
        // is exactly what the doctrine asks, since YAZ-1578 is where they stopped agreeing.
        copyPaths: plural,
        openTabPaths: openable.length > 0 ? openable : null,
        clipPaths: plural ?? (node === null ? null : [node.path]),
        newWindowPath: filePath,
        renamePath: node?.path ?? null,
        deletePath: node?.path ?? null,
        revealPath: node?.path ?? root.replace(/\/+$/, ''),
        openVsCodePath: node?.path ?? root.replace(/\/+$/, ''),
        openDefaultPath: node?.path ?? root.replace(/\/+$/, ''),
        // Focus Mode (YAZ-1605): the plural selection's eligible rows, else the one row — DIRS
        // only. Empty (a selection of files only) hides the item.
        focusPaths: focusable(plural ?? (node === null ? [] : [node.path]), tree),
        // Favorites (YAZ-1766 D3): the row or its ordered selection, any kind, any lens; blank space has nothing to pin.
        favoritePaths: node === null ? null : plural ?? [node.path],
        favoriteIsOn: node !== null && (plural ?? [node.path]).every((p) => favorites.includes(p)),
        // Info (🔒 YAZ-1835 D6): one BOARD, on its own — the live tree says whether the row is a drawing;
        // a plural gesture has no single thing to describe.
        infoPath: plural === null && filePath !== null && isBoardRow(tree?.tree ?? [], filePath) ? filePath : null,
      })
    },
    [root, tree, selectedPaths, orderedSelectedPaths, favorites, lens, searching],
  )

  // ---- Cut / Copy / Paste (YAZ-1674) ----

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
    [root, refresh, onNotice],
  )

  /**
   * ⌘V's target (D6, YAZ-1674): beside the FIRST ordered selected row — a dir → into it, a file →
   * its parent (the "New drawing" rule, `targetDirFor`) — or the vault root with no selection at all.
   */
  const pasteTargetDir = useCallback((): string => {
    const first = orderedSelectedPaths()[0]
    if (first === undefined) return root
    return targetDirFor({ type: dirs.includes(first) ? 'dir' : 'file', path: first }, root)
  }, [orderedSelectedPaths, dirs, root])

  /**
   * The chords' handle (D6 amended, YAZ-1674): App's window listener asks these two verbs; the
   * rules stay HERE. Cut / Copy need a selection ≥1 (since D9 a plain click is one); Paste needs
   * a non-empty clipboard; an open context menu owns the verbs outright (its items ARE them).
   * Rewritten whenever a rule input changes and emptied on unmount — a collapsed sidebar has no
   * tree to paste into or read an order from.
   */
  useEffect(() => {
    clipboardRef.current = {
      cutOrCopy: (op) => {
        if (menu !== null || selectedPaths.size === 0) return false
        clipTo(orderedSelectedPaths(), op)
        return true
      },
      paste: () => {
        if (menu !== null || clip === null) return false
        void pasteInto(pasteTargetDir())
        return true
      },
    }
    return () => {
      clipboardRef.current = null
    }
  }, [clipboardRef, menu, selectedPaths, clip, clipTo, orderedSelectedPaths, pasteInto, pasteTargetDir])

  /**
   * Context menu "Open N in new tabs" (🔒 D5, YAZ-1337): the SAME background opener ⌘-click
   * already uses (I3, GRO-2235), once per selected path. The loop needs no guard of its own —
   * the workspace ignores a path that is already open and appends without stealing activation
   * (`open-background`, useWorkspace.ts) — so N tabs land in tree order and the caret stays put.
   */
  const openFilesInTabs = useCallback(
    (paths: string[]) => {
      for (const path of paths) onOpenFileBackground(path)
    },
    [onOpenFileBackground],
  )

  /** Context menu "Open in new window" (D2, GRO-2168): a fresh window on {root, file}; this one untouched. (⌘-click opens a background tab instead since I3.) */
  const openFileNewWindow = useCallback(
    (path: string) => {
      window.yaseenDraw.window.open({ root, file: path }).catch((err: unknown) => console.error('[sidebar] window.open failed:', err))
    },
    [root],
  )

  const startCreate = useCallback(
    (kind: EntryKind, seed = '') => {
      if (menu === null) return
      // The input renders inside the target dir's children, so that dir must be open;
      // expandTo opens every dir ABOVE the given path, so a synthetic child opens targetDir itself.
      if (menu.targetDir !== root) dispatch({ type: 'expandTo', root, file: `${menu.targetDir}/x` })
      // Favorites shows a SUBSET of the vault (YAZ-1766, 3B1): a target dir it does not hold would give
      // the input nowhere to mount, so the create moves to Files — where the `expandTo` above has
      // already opened that dir. The reveal hop's rule (D10), applied to the other gesture that needs a row.
      if (menu.lens === 'favorites' && menu.targetDir !== root && findDirNode(favoriteNodes, menu.targetDir) === null) onLensChange('files')
      setCreating({ kind, seed, parentDir: menu.targetDir })
      setMenu(null)
    },
    [menu, root, favoriteNodes, onLensChange],
  )

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

  /**
   * Reveal in Finder (GRO-2274). Read-only, so there is no confirm and nothing to repair —
   * but a STALE row (deleted or moved externally) rejects `NOT_FOUND`, and that has to be
   * visible: `showItemInFolder` is silent on a missing path, so without a notice the menu
   * item would just look broken.
   */
  const reveal = useCallback(
    (path: string) => {
      api.reveal({ path }).catch((err: unknown) => {
        onNotice(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? `Can't reveal "${basename(path)}" — it is no longer there` : `Can't reveal: ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [onNotice],
  )

  /**
   * Open in VS Code (YAZ-963): `reveal`'s twin, notice included. A dead `vscode://` URL opens
   * an empty editor rather than reporting anything, so the stale-row `NOT_FOUND` is exactly as
   * load-bearing here as it is above.
   */
  const openVsCode = useCallback(
    (path: string) => {
      api.openVsCode({ path }).catch((err: unknown) => {
        onNotice(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? `Can't open "${basename(path)}" in VS Code — it is no longer there` : `Can't open in VS Code: ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [onNotice],
  )

  /**
   * Open in default app (YAZ-1577): the third twin. Both the click on a row with no viewer and
   * the menu item land here; the OS' own refusal (`IO_ERROR`, e.g. no app registered for the
   * type) is the one extra message worth showing verbatim.
   */
  const openDefault = useCallback(
    (path: string) => {
      api.openDefault({ path }).catch((err: unknown) => {
        onNotice(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? `Can't open "${basename(path)}" — it is no longer there` : `Can't open "${basename(path)}": ${err instanceof Error ? err.message : String(err)}`, 'error')
      })
    },
    [onNotice],
  )

  // ---- Delete (GRO-2272): context menu "Delete" → confirm sheet → App trashes the entry ----

  /** Counts for the sheet, computed ONCE when it opens rather than on every render, off the loaded tree. */
  const askDelete = useCallback(
    (path: string) => {
      // The setting finally gates the sheet (YAZ-857 — it existed end-to-end but nothing read
      // it): off → delete directly, exactly what "Don't ask me again" promised.
      if (!settings.confirmDelete) {
        void onDeleteFile(path)
        return
      }
      const kind: 'file' | 'dir' = menu?.rowKind === 'file' ? 'file' : 'dir'
      const target: DeleteTarget = { path, kind }
      if (kind === 'dir') target.children = countChildren(tree?.tree ?? [], path)
      setConfirmingDelete(target)
    },
    [menu, tree, settings.confirmDelete, onDeleteFile],
  )

  const confirmDelete = useCallback(
    (dontAskAgain: boolean) => {
      const target = confirmingDelete
      setConfirmingDelete(null)
      if (target === null) return
      if (dontAskAgain) onChangeSettings({ ...settings, confirmDelete: false })
      // Fire and forget: App owns the result and routes every failure to the passive notice.
      void onDeleteFile(target.path)
    },
    [confirmingDelete, onDeleteFile, onChangeSettings, settings],
  )

  // ---- Rename (files E1 GRO-2194, folders E1b GRO-2241): context menu "Rename" → inline input over the row ----

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

  // ---- File drag-to-move (E1b, GRO-2241): drop a FILE row on a folder row or the root header ----

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

  const pending = useMemo<PendingCreate | null>(
    () => (creating === null ? null : { kind: creating.kind, seed: creating.seed, parentDir: creating.parentDir, onSubmit: submitCreate, onCancel: cancelCreate }),
    [creating, submitCreate, cancelCreate],
  )

  // ONE gate for both disk-folder births (YAZ-948 rule; YAZ-1604 adds the dated twin).
  const canNewFolder = menu !== null

  // A search row's tree-drawing items leave the search first (Docs YAZ-2050 D2, YAZ-2056 D6) through
  // the folder-row door (YAZ-1491 D3): App flips to Files; the reveal clears the query, ends a focus
  // that would hide the row, expands and flashes it — and the item's box or focus lands beside it.
  const viaTree =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A): void => {
      if (menu?.leaveSearchTo != null) onRevealInFiles(menu.leaveSearchTo)
      run(...args)
    }

  return (
    <aside ref={asideRef} className="sidebar">
      {/* The root header doubles as the "move to the vault root" drop target (E1b). */}
      <div
        className={`sidebar__header${dropDir === root ? ' sidebar__header--drop' : ''}`}
        onDragOver={(e) => {
          if (dragging === null) return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          if (dropDir !== root) setDropDir(root)
        }}
        onDragLeave={() => {
          if (dropDir === root) setDropDir(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dropOnDir(root)
        }}
      >
        {/* The vault switcher (YAZ-1767): the trigger is the header's top-left button (name + chevron,
            D6); its panel hangs off this header's rect (D5). "Open folder…" is its last row (D4). */}
        <VaultSwitcher
          root={root}
          onPickFolder={onPickFolder}
          pickDisabled={pickDisabled}
          openRequest={switcherOpenRequest}
          // The right-click menu (YAZ-1941, Docs YAZ-1798): the file menu's own OS verbs and notice; App's in-place switch, for the menu and ⇧⏎ / ⇧-click (Docs YAZ-1974 D8).
          onOpenHere={onOpenVaultHere}
          onReveal={reveal}
          onOpenVsCode={openVsCode}
          onNotice={onNotice}
        />
        <button type="button" className="sidebar__collapse" onClick={onCollapse} title="Hide sidebar" aria-label="Hide sidebar">
          <SidebarPanelIcon />
        </button>
      </div>
      {/* Lens tabs (🔒 D4/D5, YAZ-847; ⚡ D8 amended) — chrome v2 ROW 1, above the search bar:
          Files (the file explorer) ⇄ Favorites. The row stays VISIBLE and clickable during a
          search, and switching lenses never touches the query (🔒 YAZ-847 D5). `role="tab"` +
          `aria-selected` only — no `aria-controls`/`tabpanel`, because the body below is shared
          with the flat search results and belongs to neither lens while a query is typed. */}
      <div className="sidebar__lenses" role="tablist" aria-label="Sidebar lens">
        {SIDEBAR_LENSES.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={lens === id}
            className={`sidebar__lens${id === 'favorites' ? ' sidebar__lens--glyph' : ''}${lens === id ? ' sidebar__lens--active' : ''}`}
            onClick={() => onLensChange(id)}
            // Favorites is a glyph, not a word (YAZ-1766 D1): the label lives in `title` + `aria-label`.
            title={id === 'favorites' ? LENS_LABEL[id] : undefined}
            aria-label={id === 'favorites' ? LENS_LABEL[id] : undefined}
          >
            {id === 'favorites' ? <HeartIcon /> : LENS_LABEL[id]}
          </button>
        ))}
        {/* One button for both directions AND both lenses (⚡ YAZ-862, ⚡ YAZ-873): anything open
            collapses everything, and only a fully closed tree expands it. It acts on whichever
            lens is ACTIVE. Gone — not disabled — while a query is typed (the tree is not the body
            then) and whenever the active reading has no folder to unfold. */}
        {/* Focus Mode's eye (YAZ-1605): lit ONLY while the active lens is focused, one slot left of
            the chevrons; one click ends the focus. Gone while a query is typed, like its neighbour. */}
        {/* The sort control (🔒 YAZ-1835 D5): Files lens only, gone while a query is typed; it opens the
            same menu component the rows use, with a check on the current order. */}
        {/* The right-hand tools sit in ONE group pushed to the far end (YAZ-1800), in the order
            sort · preview · eye · chevrons, so whichever of them are present stay flush right. */}
        <span className="sidebar__tools">
          {!searching && lens === 'files' && (
            <button
              type="button"
              className="sidebar__sort"
              aria-label={`Sort by ${SORT_LABEL[sortOrder]}`}
              title={`Sort by ${SORT_LABEL[sortOrder]}`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setSortMenu({ x: r.left, y: r.bottom + 2 })
              }}
            >
              <SortIcon />
            </button>
          )}
          {/* The hover preview's toggle (🔒 YAZ-1800 D3): accent while previews are on, one slot right of the sort
              control; the same flag as Settings › Files › Preview on hover. Gone while a query is typed. */}
          {!searching && (
            <button
              type="button"
              className={`sidebar__preview${settings.hoverPreview ? ' sidebar__preview--on' : ''}`}
              aria-pressed={settings.hoverPreview}
              aria-label="Preview on hover"
              title="Preview on hover"
              onClick={() => onChangeSettings({ ...settings, hoverPreview: !settings.hoverPreview })}
            >
              <PreviewIcon />
            </button>
          )}
          {!searching && focused && (
            <button type="button" className="sidebar__focus-off" aria-label="Exit focus mode" title="Exit focus mode" onClick={exitFocus}>
              <EyeIcon />
            </button>
          )}
          {!searching && foldable.length > 0 && (
            <button
              type="button"
              className="sidebar__expand-all"
              aria-label={allLabel}
              title={allLabel}
              // Only the dirs ON SCREEN move (YAZ-1605): folds outside a focus are exactly as they were when it ends.
              onClick={() => dispatch({ type: 'setAll', dirs: anyExpanded ? expanded.filter((d) => !bodyDirs.includes(d)) : [...new Set([...expanded, ...bodyDirs])] })}
            >
              <ChevronsIcon />
            </button>
          )}
        </span>
      </div>
      {/* Persistent search bar (YAZ-739 A-, chrome v2 row 2 — 🔒 YAZ-797): always visible, never a
          tab or a view — on BOTH lenses (YAZ-847 keeps that rule). YAZ-750's filter affordance
          sits beside it; YAZ-803 swaps the body to results while `query` is non-empty. */}
      <div className="sidebar__search">
        <SearchIcon />
        <input
          ref={searchInput}
          className="sidebar__search-input"
          type="text"
          placeholder="Search"
          title="Search (⌘K)"
          aria-label="Search boards"
          value={query}
          onChange={changeQuery}
          onKeyDown={searchKeyDown}
        />
      </div>
      {/* The blank-space menu is the TREE's ("New drawing" here creates in the vault root); the
          results list has no such target, so right-clicking it offers nothing (YAZ-803) — not even
          Electron's text menu, which leaked through until Docs YAZ-2050. Its ROWS get the full menu.
          Blank space means the same thing in either lens: the vault ROOT. */}
      <div
        ref={bodyRef}
        className="sidebar__body"
        onContextMenu={(e) => (searching ? e.preventDefault() : openMenu(null, e))}
        // Escape and a plain click on blank space drop the multi-select (YAZ-1336, D6 amended YAZ-1674).
        onKeyDown={clearOnEscape}
        onMouseDown={clearOnBlankClick}
        // A click on any row, a drag, or a right-click ends a hover preview at once (YAZ-1800).
        onClickCapture={(e) => {
          if (e.target instanceof Element && e.target.closest('.tree__row') !== null) closePreview()
        }}
        onDragStartCapture={closePreview}
        onContextMenuCapture={closePreview}
      >
        {searching ? (
          // A typed query replaces the ACTIVE TAB's body, whichever lens that is (🔒 YAZ-847 D5).
          results.length > 0 ? (
            <SearchResults results={results} selected={sel} onSelect={setSelected} onActivate={activate} onRowContextMenu={(hit, e) => openMenu({ type: hit.kind, path: hit.path }, e)} />
          ) : (
            <p className="sidebar__msg">No matches</p>
          )
        ) : lens === 'favorites' ? (
          // The Favorites tab (YAZ-1766): the pinned rows in the user's order, each a full tree row —
          // a favorited folder unfolds in place through the SAME `expanded` set as Files (D7) and
          // every row carries the same menu. Nothing here drags to disk (an inert move); root rows
          // drag to reorder the list (D4).
          <>
            {error !== null && <p className="sidebar__msg sidebar__msg--error">{error}</p>}
            {tree === null && error === null && <p className="sidebar__msg">Loading…</p>}
            {tree !== null && favoriteNodes.length === 0 && <p className="sidebar__msg">No favorites yet. Right-click a file or folder → Add to favorites.</p>}
            {tree !== null && favoriteNodes.length > 0 && (
              <Tree
                nodes={favoriteNodes}
                dirPath={root}
                expanded={expandedSet}
                activeFile={activeFile}
                onToggle={toggleDir}
                onOpenFile={onOpenFile}
                onOpenFileBackground={onOpenFileBackground}
                onOpenDefault={openDefault}
                onNodeContextMenu={openMenu}
                pending={pending}
                renaming={renaming}
                move={INERT_MOVE}
                reorder={favoriteReorder}
                selection={selection}
                onHoverFile={previewsOn ? hoverFile : undefined}
                tooLarge={tooLarge}
                shareBadges={shareBadges}
              />
            )}
          </>
        ) : (
          <>
            {error !== null && <p className="sidebar__msg sidebar__msg--error">{error}</p>}
            {tree === null && error === null && <p className="sidebar__msg">Loading…</p>}
            {tree !== null && tree.tree.length === 0 && pending === null && (
              <p className="sidebar__msg">No boards here.</p>
            )}
            {tree !== null && (
              <Tree
                nodes={sortedNodes}
                dirPath={root}
                expanded={expandedSet}
                activeFile={activeFile}
                onToggle={toggleDir}
                onOpenFile={onOpenFile}
                onOpenFileBackground={onOpenFileBackground}
                onOpenDefault={openDefault}
                onNodeContextMenu={openMenu}
                pending={pending}
                renaming={renaming}
                move={fileMove}
                selection={selection}
                onHoverFile={previewsOn ? hoverFile : undefined}
                tooLarge={tooLarge}
                shareBadges={shareBadges}
              />
            )}
          </>
        )}
      </div>
      <div className="sidebar__footer">
        <SettingsButton onClick={onOpenSettings} />
      </div>
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          // Items as data (🔒 D8, YAZ-1674): every gating rule lives in `menuSections`. `clip` is read
          // at RENDER time, so "Paste N items" follows the app-wide clipboard while the menu stands.
          sections={buildMenuSections(
            { ...menu, clip },
            {
              onOpenInNewTabs: openFilesInTabs,
              onOpenNewWindow: openFileNewWindow,
              onOpenVsCode: openVsCode,
              onOpenDefault: openDefault,
              onReveal: reveal,
              focusLabel: focusLabel(menu.focusPaths?.length ?? 0),
              onFocus: viaTree((paths) => focusOn(paths, menu.lens)),
              onCut: (paths) => clipTo(paths, 'cut'),
              onCopy: (paths) => clipTo(paths, 'copy'),
              // Paste goes exactly where "New folder" goes (🔒 D5, YAZ-1674).
              onPaste: canNewFolder ? () => void pasteInto(menu.targetDir) : null,
              onNotice,
              onNewDrawing: viaTree(() => startCreate('drawing')),
              onNewDatedDrawing: viaTree(() => startCreate('drawing', datedSeed())),
              onNewDiagram: viaTree(() => startCreate('diagram')),
              onNewFolder: canNewFolder ? viaTree(() => startCreate('dir')) : null,
              onNewDatedFolder: canNewFolder ? viaTree(() => startCreate('dir', datedSeed())) : null,
              onToggleFavorite: toggleFavorite,
              onRename: viaTree((path) => setRenamingEntry({ path, kind: menu.rowKind === 'file' ? 'file' : 'dir' })),
              onInfo: (path) => setInfoPopover({ x: menu.x, y: menu.y, path, now: Date.now() }),
              onShare: onShareFile,
              onHistory: onHistoryFile,
              onDelete: askDelete,
            },
          )}
          onClose={() => setMenu(null)}
        />
      )}
      {sortMenu !== null && (
        <ContextMenu
          x={sortMenu.x}
          y={sortMenu.y}
          sections={[SORT_ORDERS.map((order) => ({ id: `sort-${order}`, label: SORT_LABEL[order], hint: order === sortOrder ? '✓' : undefined, onSelect: () => setSortOrder(order) }))]}
          onClose={() => setSortMenu(null)}
        />
      )}
      {infoPopover !== null && infoNode !== null && (
        <ContextMenuSurface x={infoPopover.x} y={infoPopover.y} width={300} role="dialog" onClose={() => setInfoPopover(null)}>
          <BoardInfo node={infoNode} root={root} now={infoPopover.now} />
        </ContextMenuSurface>
      )}
      <HoverPreviewHost hover={hover} tree={tree} root={root} enabled={previewsOn} diagramDarkColors={settings.diagramDarkColors} anchor={asideRef} onClose={closePreview} />
      {confirmingDelete !== null && <ConfirmDelete target={confirmingDelete} onConfirm={confirmDelete} onCancel={() => setConfirmingDelete(null)} />}
    </aside>
  )
}
