import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { SIDEBAR_LENSES, SORT_ORDERS, type FileClipState, type SettingsState, type SidebarLens, type SortOrder, type TreeNode, type TreeResponse } from '@shared/types'
import { EMPTY_DIAGRAM_XML } from '@shared/diagramFile'
import { api, BridgeRequestError } from '../api'
import { EMPTY_SCENE_JSON } from '../drawings/drawingScene'
import { ContextMenuSurface } from '../components/ContextMenuSurface'
import { ChevronsIcon, EyeIcon, HeartIcon, PreviewIcon, SearchIcon, SidebarPanelIcon, SortIcon } from '../components/icons'
import type { WatchSource } from '../hooks/useWatch'
import { basename } from '../lib/paths'
import { storage } from '../lib/storage'
import { EMPTY_SELECTION, orderedSelection, selectionReducer } from '../lib/selection'
import { allDirs, ancestorDirs, favoriteRoots, findDirNode, findNode, focusRoots, treeHasFile, treeHasPath, treeReducer } from '../lib/treeState'
import { sortTree, type FileNode } from '@shared/treeSort'
import { useAppliedTheme } from '../lib/theme'
import { BoardInfo } from './BoardInfo'
import { useShareBadges } from '../share/useShareBadges'
import { BoardPreview } from './BoardPreview'
import { boardPreviewKey } from './boardPreviewCache'
import { SearchResults } from '../search/SearchResults'
import type { SearchCandidate } from '../search/searchCandidates'
import { useSearchResults } from '../search/useSearchResults'
import { ConfirmDelete, type DeleteTarget } from './ConfirmDelete'
import { ContextMenu } from './ContextMenu'
import { datedSeed, entryPath, renamedPath, targetDirFor, type EntryKind, type MenuRow } from './createEntry'
import { SettingsButton } from '../settings/SettingsButton'
import { buildMenuSections, countItems } from './menuSections'
import type { NoticeKind } from '../lib/notice'
import { Tree, type PendingCreate, type PendingRename, type TreeFileMove, type TreeReorder, type TreeSelection } from './Tree'
import { VaultSwitcher } from './VaultSwitcher'
import { flashTreeRows, revealMissingMessage, type SidebarRevealRequest } from './revealRow'

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
    if (dir.startsWith(`${node.path}/`)) {
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

/** How long the pointer (or focus) rests on a board row before its preview opens (YAZ-1800). */
export const BOARD_PREVIEW_DWELL_MS = 400

/** The Favorites tree's file move (YAZ-1766 D4): nothing on that tab drags to disk, so every callback is a no-op. */
const INERT_MOVE: TreeFileMove = { dragging: null, dropDir: null, start: () => undefined, end: () => undefined, hover: () => undefined, drop: () => undefined }
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

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
  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, dispatch] = useReducer(treeReducer, root, storage.getExpanded)
  // Focus Mode (YAZ-1605): one path LIST per lens — dirs, on both lenses; empty is no focus.
  // Per WINDOW since YAZ-1628 (`sidebarCollapsed`'s rule), unlike the per-vault expansion above:
  // restored from this window's identity and written back the same way, so it survives a lens
  // switch and a restart and follows its own rename, ⌘⇧N inherits it, and another window on the
  // same vault is never affected.
  const [focusDirs, setFocusDirs] = useState<readonly string[]>(storage.getFocusDirs)
  const [focusFavorites, setFocusFavorites] = useState<readonly string[]>(storage.getFocusFavorites)
  // Favorites (YAZ-1766 D2, in the vault since 6A/D11): the vault's pinned files and folders in the
  // user's order, read from `.yaseendraw/favorites.json` through main (absolute paths). Another
  // window's — or another machine's, via sync — write lands here through `favorites:changed` (below).
  const [favorites, setFavorites] = useState<readonly string[]>([])
  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites
  // Favorites drag-to-reorder (D4): the dragged root row + the hovered row and edge.
  const [reorderDragging, setReorderDragging] = useState<string | null>(null)
  const [reorderOver, setReorderOver] = useState<{ path: string; edge: 'before' | 'after' } | null>(null)
  // Multi-select (YAZ-1336, 🔒 D1): the selected PATHS — files and, since YAZ-1578, folders —
  // shared by BOTH lenses, one entry per path however many rows draw it (🔒 YAZ-1336 D3). It lives HERE
  // and nowhere else on purpose: this component is mounted `key={root}` and only while the
  // sidebar is open, so a selection is honestly about rows currently on screen and cannot
  // outlive them (a collapse ends it).
  const [selectedPaths, dispatchSelection] = useReducer(selectionReducer, EMPTY_SELECTION)
  const [menu, setMenu] = useState<MenuTargets | null>(null)
  // The Files lens's order (🔒 YAZ-1835 D3): per vault, read off the store and re-read when another window changes it.
  const [sortOrder, setSortOrderState] = useState<SortOrder>(() => storage.getSortOrder(root))
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null)
  // The "Info" popover (🔒 YAZ-1835 D6): the board's PATH, resolved against the live tree at render;
  // `now` is pinned at open, like the vault switcher's, so a relative time never shifts on a re-render.
  const [infoPopover, setInfoPopover] = useState<{ x: number; y: number; path: string; now: number } | null>(null)
  const [creating, setCreating] = useState<{ kind: EntryKind; seed: string; parentDir: string } | null>(null)
  const [renamingEntry, setRenamingEntry] = useState<{ path: string; kind: 'file' | 'dir' } | null>(null)
  // The delete confirm sheet's target (GRO-2272 `C3-`); null when the sheet is closed.
  const [confirmingDelete, setConfirmingDelete] = useState<DeleteTarget | null>(null)
  // File drag-to-move (E1b, GRO-2241): the dragged file row + the highlighted drop target.
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  // The persistent search bar's query (YAZ-801). It lives HERE rather than in the bar because
  // YAZ-803 swaps the BODY while it is non-empty; Sidebar is mounted `key={root}`, so it resets
  // on unmount and on a root switch without any clearing code.
  const [query, setQuery] = useState('')
  const seenRevealId = useRef<number | null>(null)
  const handledFilesRevealId = useRef<number | null>(null)
  const [pendingReveal, setPendingReveal] = useState<SidebarRevealRequest | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // The highlighted result row (YAZ-803); the keyboard owns it, so it lives with the query.
  const [selected, setSelected] = useState(0)

  // Every directory of the CURRENT tree, outer before inner (`allDirs`): the expand-all set
  // (⚡ YAZ-862) and, since YAZ-1491, the search list's folder rows (🔒 D1) — one memo, no second
  // feed.
  const dirs = useMemo(() => (tree === null ? [] : allDirs(tree.tree)), [tree])
  // The focused top rows (YAZ-1605), resolved off the LIVE tree in tree order — a vanished dir yields
  // no row, and the prune below drops it. `dirs` stays the WHOLE vault: reveal must still find what is hidden.
  const focusNodes = useMemo(() => (tree === null || focusDirs.length === 0 ? [] : focusRoots(tree.tree, focusDirs)), [tree, focusDirs])
  // The expand/collapse-all button acts on the dirs ON SCREEN: the focused subtrees, or all of them.
  const shownDirs = useMemo(() => (focusNodes.length === 0 ? dirs : allDirs(focusNodes)), [dirs, focusNodes])
  // The Favorites tab's rows (YAZ-1766 D4/D5): its own focus list when set, else the favorites — each
  // in STORED order, off the live tree; nesting and redundancy are kept (`favoriteRoots`, not `focusRoots`).
  const favoriteNodes = useMemo(() => (tree === null ? [] : favoriteRoots(tree.tree, focusFavorites.length > 0 ? focusFavorites : favorites)), [tree, favorites, focusFavorites])
  const favoriteDirs = useMemo(() => allDirs(favoriteNodes), [favoriteNodes])
  // 🔒 YAZ-1835 D1: the order is a VIEW applied here, to the Files lens only — `fs:tree`, ⌘K and the Favorites lens never see it.
  const sortedNodes = useMemo(() => sortTree(focusNodes.length > 0 ? focusNodes : (tree?.tree ?? []), sortOrder), [focusNodes, tree, sortOrder])
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
  // What the chevrons button unfolds on the two disk-reading lenses.
  const bodyDirs = lens === 'favorites' ? favoriteDirs : shownDirs
  // ⌘K's feed (YAZ-1814): the ONE tree this panel already holds and the watcher already keeps
  // fresh — the catalog walk lives in `search/`, is lazy until the first query, and drops
  // non-drawing files and (through `fs:tree`) the image store.
  const results = useSearchResults(root, query, tree?.tree ?? null)
  // 🔒 flat-list ruling on YAZ-739: while a query is typed the body shows a FLAT ranked list
  // instead of the tree. A conditional render, not a teardown — every bit of tree state (data,
  // expansion, pending create/rename, drag) lives here and is waiting untouched when it clears.
  const searching = query.trim() !== ''
  // A tree refresh can shrink the list under the keyboard's index (F1 finding 2, YAZ-808), so
  // every reader of the selection clamps: the highlight lands on the last row, not on nowhere.
  const sel = Math.min(selected, results.length - 1)

  // THE HOVER PREVIEW (YAZ-1800): a board row rested on for the dwell opens a picture of the whole
  // board beside the sidebar. `hover` is the row — pending until the dwell ends, then shown. A save to
  // it is only a new picture key, which the panel swaps in place (🔒 D5 amendment); only the row
  // leaving the tree closes it. Every close bumps `hoverRequest`, so an earlier row's dwell never fires late.
  const asideRef = useRef<HTMLElement>(null)
  const theme = useAppliedTheme()
  const [hover, setHover] = useState<{ path: string; shown: boolean } | null>(null)
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverRequest = useRef(0)
  // A menu or the Info popover owns the pointer while it stands: nothing opens under it.
  const hoverBlocked = menu !== null || sortMenu !== null || infoPopover !== null
  const hoverBlockedRef = useRef(hoverBlocked)
  hoverBlockedRef.current = hoverBlocked
  const closePreview = useCallback(() => {
    hoverRequest.current++
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    hoverRef.current = null
    setHover(null)
  }, [])
  const hoverFile = useCallback(
    (node: FileNode | null) => {
      // The same row again (focus after the pointer, or back) keeps its dwell or its panel.
      if (node !== null && hoverRef.current?.path === node.path) return
      closePreview()
      if (node === null || hoverBlockedRef.current) return
      const id = hoverRequest.current
      const { path } = node
      hoverRef.current = { path, shown: false }
      setHover(hoverRef.current)
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null
        if (id === hoverRequest.current) setHover({ path, shown: true })
      }, BOARD_PREVIEW_DWELL_MS)
    },
    [closePreview],
  )
  const previewsOn = settings.hoverPreview && !searching
  // YAZ-1799: a link mark on shared boards (red when the last update failed or the link is stale).
  const shareBadges = useShareBadges(root)
  // The hovered board off the LIVE tree (the Info popover's rule): its fresh mtime keys the picture, and gone closes the panel.
  const hoverNode = useMemo(() => {
    if (hover === null || tree === null) return null
    const n = findNode(tree.tree, hover.path)
    return n !== null && n.type === 'file' ? n : null
  }, [hover, tree])
  useEffect(() => {
    if (hover !== null && tree !== null && hoverNode === null) closePreview()
  }, [hover, tree, hoverNode, closePreview])
  // Everything else that ends a glance: the toggle, a search, a menu opening, another board opening.
  useEffect(() => {
    if (!previewsOn || hoverBlocked) closePreview()
  }, [previewsOn, hoverBlocked, closePreview])
  useEffect(() => closePreview(), [activeFile, closePreview])
  // Escape closes the preview — and ONLY while there is one, so the key is otherwise untouched for the
  // selection, the menus and the canvas. Capture phase, so it wins before the body's own Escape.
  const hoverActive = hover !== null
  useEffect(() => {
    if (!hoverActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      closePreview()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [hoverActive, closePreview])
  useEffect(() => closePreview, [closePreview]) // unmount: no dwell timer outlives the sidebar

  // One activation rule for keyboard AND click (🔒 D3, YAZ-1491): a folder reveals, a file opens.
  // Enter PREVIEWS — focus stays in the bar, so ↑/↓ carry on walking the results.
  const activate = (hit: SearchCandidate, background: boolean) => {
    if (hit.kind === 'dir') onRevealInFiles(hit.path)
    else if (background) onOpenFileBackground(hit.path)
    else onOpenFile(hit.path)
  }

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
  }, [lens, onRevealConsumed, revealRequest])

  useEffect(() => {
    if (pendingReveal !== null && pendingReveal.lens !== lens) setPendingReveal(null)
  }, [lens, pendingReveal])

  // Expand / collapse the whole tree (⚡ YAZ-862). "Any open" is measured against what the CURRENT
  // tree can actually unfold (`dirs`, above), never the raw persisted list, which would leave the
  // button offering to collapse nothing.
  const foldable = bodyDirs
  const anyExpanded = bodyDirs.some((d) => expanded.includes(d))
  const allLabel = anyExpanded ? 'Collapse all' : 'Expand all'

  const refresh = useCallback(() => {
    api.tree(root).then(
      (res) => {
        // Walks overlap now that every watcher event refreshes (🔒 YAZ-1835 D4): a slower, older
        // answer must never overwrite a newer one, and `generatedAt` is main's clock for exactly that.
        setTree((cur) => (cur !== null && cur.generatedAt > res.generatedAt ? cur : res))
        setError(null)
      },
      (err: unknown) => {
        if (err instanceof BridgeRequestError && (err.code === 'NOT_FOUND' || err.code === 'NOT_A_DIRECTORY')) onRootMissing()
        else setError(err instanceof BridgeRequestError ? err.message : 'Failed to load folder')
      },
    )
  }, [root, onRootMissing])

  useEffect(() => refresh(), [refresh])

  // Refresh on EVERY change, not only structural ones (🔒 YAZ-1835 D4): a save moves a board's
  // `updatedAt`, and with it its place under "Last updated" — in this window and every other one
  // on the vault. `ready` also fires on every watch (re)subscription, covering missed events.
  useEffect(
    () =>
      watch.subscribe((ev) => {
        if (ev.type === 'error') setError(ev.message)
        else refresh()
      }),
    [watch, refresh],
  )

  // Another window's sort change lands in the store cache; follow it (🔒 YAZ-1835 D3).
  useEffect(() => storage.subscribe(() => setSortOrderState(storage.getSortOrder(root))), [root])
  const setSortOrder = useCallback(
    (order: SortOrder) => {
      setSortOrderState(order)
      storage.setSortOrder(root, order)
    },
    [root],
  )

  useEffect(() => {
    // Idempotent (⚡ YAZ-874): the first render holds exactly what was
    // just read, and re-sending it would make the main process commit, write and broadcast for nothing.
    if (sameList(storage.getExpanded(root), expanded)) return
    storage.setExpanded(root, expanded)
  }, [root, expanded])

  // Focus Mode's write-back (YAZ-1605), idempotent like the two above it — into this window's
  // identity (YAZ-1628), not the vault bucket.
  useEffect(() => {
    if (sameList(storage.getFocusDirs(), focusDirs)) return
    storage.setFocusDirs(focusDirs)
  }, [focusDirs])
  useEffect(() => {
    if (sameList(storage.getFocusFavorites(), focusFavorites)) return
    storage.setFocusFavorites(focusFavorites)
  }, [focusFavorites])

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

  // The file this mount woke up with is SHOWN, not revealed (YAZ-1642): a relaunch restores the
  // tab and leaves the tree collapsed. Any file opened after that still opens its folders.
  const restoredFile = useRef(activeFile)
  useEffect(() => {
    if (activeFile === restoredFile.current) return
    restoredFile.current = null
    if (activeFile !== null) dispatch({ type: 'expandTo', root, file: activeFile })
  }, [root, activeFile])

  // Focus Mode (YAZ-1605): a focus target that left the vault DROPS OUT — deleted or moved out —
  // and the last one leaving ends the focus: never an empty tree under a lit eye. The store repairs
  // the FILE on delete; this component holds its own copy, so it prunes against the live tree
  // itself, exactly as the selection does above.
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
    if (focusDirs.length > 0 && !focusDirs.some((dir) => pendingReveal.path === dir || pendingReveal.path.startsWith(`${dir}/`))) setFocusDirs([])
    // A folder opens ITSELF too — the synthetic-child idiom the create menu already uses.
    dispatch({ type: 'expandTo', root, file: revealIsDir ? `${pendingReveal.path}/x` : pendingReveal.path })
  }, [focusDirs, onNotice, pendingReveal, revealIsDir, revealTargetPresent, root, tree])

  const filesRevealReady = revealTargetPresent && ancestorDirs(root, pendingReveal.path).every((dir) => expanded.includes(dir))

  useEffect(() => {
    if (!filesRevealReady || pendingReveal === null || bodyRef.current === null) return
    return flashTreeRows(bodyRef.current, pendingReveal.path) ?? undefined
  }, [filesRevealReady, pendingReveal])

  // ⌘K's focus handshake (YAZ-801). Firing on MOUNT is deliberate, not a side effect to guard
  // against: ⌘K with the sidebar collapsed un-collapses it, so the sidebar mounts with the flag
  // already true (0- re-scope on YAZ-800). A plain remount with the flag false focuses nothing.
  useEffect(() => {
    if (!pendingSearchFocus) return
    searchInput.current?.focus()
    onSearchFocusHandled()
  }, [pendingSearchFocus, onSearchFocusHandled])

  // Stored lastFile that no longer exists → drop it (first tree only, so a file deleted on disk
  // EXTERNALLY while it is being edited stays open and is recreated by the next save — an
  // IN-APP delete never reaches here, it closes tabs through the `file:deleted` broadcast
  // which retires the editor first (GRO-2272); do not unify the two. Files OUTSIDE the
  // root (opened via a pasted `#/abs/path.excalidraw` URL, GRO-2069) are never in the tree — skip them.
  const validated = useRef(false)
  useEffect(() => {
    if (tree === null || validated.current) return
    validated.current = true
    if (activeFile !== null && activeFile.startsWith(`${root.replace(/\/+$/, '')}/`) && !treeHasFile(tree.tree, activeFile))
      onFileMissing()
  }, [tree, activeFile, root, onFileMissing])

  // A stale tab ACTIVATED after its file vanished on disk (I3, GRO-2235): when the activation
  // CHANGES to an in-root file the cached tree does not show, confirm against a FRESH tree —
  // the inline-create flow activates a just-created file before `refresh()` lands, so the
  // cached tree can be behind — and close it through the same onFileMissing path. A file
  // deleted EXTERNALLY while it is the active editor stays open (no activation change —
  // recreated by the next save); an IN-APP delete never routes through here, it closes tabs
  // via the `file:deleted` broadcast, which also retires the editor first (GRO-2272). Do not
  // unify the two. Background tabs are never probed (out of scope, noted in GRO-2235).
  const lastActive = useRef(activeFile)
  const treeRef = useRef(tree)
  treeRef.current = tree
  useEffect(() => {
    if (activeFile === lastActive.current) return
    lastActive.current = activeFile
    if (activeFile === null || !activeFile.startsWith(`${root.replace(/\/+$/, '')}/`)) return
    if (treeRef.current !== null && treeHasFile(treeRef.current.tree, activeFile)) return
    let cancelled = false // the activation moved on (or the sidebar unmounted): the probe's verdict is stale
    api.tree(root).then(
      (res) => {
        if (!cancelled && !treeHasFile(res.tree, activeFile)) onFileMissing()
      },
      () => undefined, // a root-level failure is refresh()'s problem, not this probe's
    )
    return () => {
      cancelled = true
    }
  }, [activeFile, root, onFileMissing])

  // ---- New drawing / new folder (GRO-2022): right-click menu → inline name input ----

  /**
   * The whole selection as a list, ordered by the PANEL (YAZ-1337, as ⚡ YAZ-1338 rules it): the
   * rows on screen first, in the order the eye reads them — never click order, which is not an
   * order the user can see — and every still-selected path with no row appended after them, so
   * collapsing a folder over a selected file hides the row and keeps the file. The one rule lives
   * in `orderedSelection`, which the clipboard chords read too: the menu and the chords cannot
   * spell one selection two ways.
   */
  const orderedSelectedPaths = useCallback((): string[] => orderedSelection(selectedPaths, bodyRef.current), [selectedPaths])

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
    [root],
  )
  const focused = lens === 'favorites' ? focusFavorites.length > 0 : focusNodes.length > 0
  const exitFocus = useCallback(() => (lens === 'favorites' ? setFocusFavorites([]) : setFocusDirs([])), [lens])

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

  const renaming: PendingRename | null =
    renamingEntry === null ? null : { path: renamingEntry.path, onSubmit: submitRename, onCancel: () => setRenamingEntry(null) }

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

  const fileMove: TreeFileMove = {
    dragging,
    dropDir,
    start: setDragging,
    end: () => {
      setDragging(null)
      setDropDir(null)
    },
    hover: setDropDir,
    drop: dropOnDir,
  }

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
  const favoriteReorder: TreeReorder = {
    dragging: reorderDragging,
    over: reorderOver,
    start: focusFavorites.length > 0 ? () => undefined : setReorderDragging,
    hover: (path, edge) => setReorderOver((prev) => (prev?.path === path && prev.edge === edge ? prev : { path, edge })),
    drop: dropReorder,
    end: () => {
      setReorderDragging(null)
      setReorderOver(null)
    },
  }

  /** The multi-select as both trees take it (YAZ-1336): the set, plus its two gestures — toggle (shift) and set (any other click, D9). */
  const selection: TreeSelection = {
    paths: selectedPaths,
    toggle: (path) => dispatchSelection({ type: 'toggle', path }),
    set: (path) => dispatchSelection({ type: 'set', path }),
  }

  const pending: PendingCreate | null =
    creating === null
      ? null
      : {
          kind: creating.kind,
          seed: creating.seed,
          parentDir: creating.parentDir,
          onSubmit: submitCreate,
          onCancel: cancelCreate,
        }

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
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0) // a new query is a new ranking: the top row is the selection again
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              // Esc empties a typed query first and only gives up focus on the second press.
              if (query !== '') setQuery('')
              else e.currentTarget.blur()
              return
            }
            // The bar keeps focus while the list is driven from it (YAZ-803). ↑/↓ WRAP (YAZ-1814,
            // YAZ-1814): the list is capped at 50 and read top-down, so falling off the end is a
            // request for the other end — and ↑ from the top row is the cheapest way to the
            // bottom of a full list. Opening leaves the list up.
            if (results.length === 0) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected(sel + 1 >= results.length ? 0 : sel + 1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected(sel - 1 < 0 ? results.length - 1 : sel - 1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = results[sel]
              if (hit === undefined) return
              activate(hit, e.metaKey)
            }
          }}
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
        // Escape drops the multi-select (YAZ-1336) — and ONLY when there is one: with nothing
        // selected the key still belongs to everyone else listening for it, so this must neither
        // swallow it nor stop it travelling. An OPEN context menu owns the key outright
        // (YAZ-1340): its window listener is closing it on this very press, and one Escape must
        // not also throw the selection the menu was about to act on.
        // (⌘C/⌘X/⌘V are App's window listener, D6 — see `clipboardRef`.)
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || selectedPaths.size === 0 || menu !== null) return
          e.preventDefault()
          e.stopPropagation()
          dispatchSelection({ type: 'clear' })
        }}
        // A plain LEFT click on blank space ends the selection (D6 amended, YAZ-1674), so ⌘V then
        // pastes into the vault root — the Finder rule. Rows, inputs and buttons own their own
        // clicks (a row click SELECTS, D9), and a right-click keeps the selection standing
        // (YAZ-1337: its menu is about the root, not a fresh pick; the menu's overlay lives
        // outside this body, so its own mousedown never arrives here).
        // A click on any row, a drag, or a right-click ends a hover preview at once (YAZ-1800).
        onClickCapture={(e) => {
          if (e.target instanceof Element && e.target.closest('.tree__row') !== null) closePreview()
        }}
        onDragStartCapture={closePreview}
        onContextMenuCapture={closePreview}
        onMouseDown={(e) => {
          if (e.button !== 0 || selectedPaths.size === 0) return
          if (e.target instanceof Element && e.target.closest('button, input, textarea, a, [role="treeitem"]') !== null) return
          dispatchSelection({ type: 'clear' })
        }}
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
                expanded={new Set(expanded)}
                activeFile={activeFile}
                onToggle={(dir) => dispatch({ type: 'toggle', dir })}
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
                expanded={new Set(expanded)}
                activeFile={activeFile}
                onToggle={(dir) => dispatch({ type: 'toggle', dir })}
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
      {hover?.shown === true && hoverNode !== null && previewsOn && (
        <BoardPreview key={hoverNode.path} root={root} node={hoverNode} cacheKey={boardPreviewKey(root, hoverNode, theme, settings.diagramDarkColors)} anchor={asideRef} />
      )}
      {confirmingDelete !== null && <ConfirmDelete target={confirmingDelete} onConfirm={confirmDelete} onCancel={() => setConfirmingDelete(null)} />}
    </aside>
  )
}
