import type { FileClipState, SidebarLens, TreeNode, TreeResponse } from '@shared/types'
import { findDirNode, findNode } from '../lib/treeState'

/**
 * The sidebar context menu's items AS DATA (🔒 D8, YAZ-1674). Every gating rule that used to be a
 * conditional in `ContextMenu`'s JSX is one small function here returning an item or null, so the
 * component keeps only mechanics (overlay, clamp, Escape) and the rules test PURE — no DOM.
 *
 * SIX groups, in this order (🔒 YAZ-1674 D7, amended twice): Open/View · Clipboard · Create · This row ·
 * "Open in ▸" · Delete. The component draws a separator between NON-EMPTY groups only, so a
 * blank-space menu (no row to rename or delete) never ends in a stray rule. Labels are the bare
 * text — a shortcut hint rides on `hint` and is drawn by CSS from `data-hint`, so `textContent`
 * and the accessible name stay what every test pins.
 *
 * NOTE (🔒 YAZ-1674 D7): grouping moves "Copy N paths" below the Open group, which loosens 🔒 YAZ-1337 D5 of
 * YAZ-1337 ("the plural pair leads") — "Open N in new tabs" still leads the whole menu, and the
 * plural copy still leads its own group.
 *
 * D7 amended (YAZ-1674): the OS verbs collapse into ONE "Open in ▸" parent whose flyout is itself
 * groups of leaves — the same renderer, the same separator rule, one level deep — and that parent
 * is its OWN group between the this-row group and Delete. The Open group keeps only the plural
 * open and Focus and is EMPTY on a single file row, so the clipboard group then leads.
 */
interface MenuItemBase {
  id: string
  label: string
  /** Right-aligned hint — a shortcut (⌘X …) or a state mark (the sort menu's ✓, 🔒 YAZ-1835 D5) — drawn from `data-hint` by CSS, never part of the label. */
  hint?: string
  danger?: boolean
}

/** A leaf: selecting it runs `onSelect`, then the whole menu closes. */
export interface MenuAction extends MenuItemBase {
  onSelect: () => void
  children?: undefined
  /** Rendered but inert — Paste with an empty clipboard, for discoverability (🔒 D5, YAZ-1674). Only a leaf can be. */
  disabled?: boolean
}

/**
 * A parent ("Open in ▸", D7 amended): it has NO `onSelect` — selecting it only opens its flyout.
 * The children are ONE level of leaves in their own groups, so a separator inside the flyout is
 * simply a second non-empty section; the component skips empty ones exactly as it does at the root.
 */
export interface MenuParent extends MenuItemBase {
  onSelect?: undefined
  children: readonly MenuAction[][]
}

export type MenuItem = MenuAction | MenuParent

export type MenuSection = MenuItem[]

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
  const found = findDirNode(nodes, dir)
  if (found === null || found.type !== 'dir') return { files: 0, folders: 0 }
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
  walk(found.children)
  return { files, folders }
}

/**
 * The rows a "Focus on …" may narrow to, out of the right-clicked row or its 2+ selection
 * (YAZ-1605): DIRS, on both lenses — a shift-selection may hold files, which are simply not
 * focusable, as a folder is not openable for `openTabPaths`. Null, not `[]`, hides the item.
 */
export function focusable(paths: readonly string[], tree: TreeResponse | null): string[] | null {
  const kept = paths.filter((p) => tree !== null && findDirNode(tree.tree, p) !== null)
  return kept.length > 0 ? kept : null
}

/** "Focus on folder" / "Focus on 3 folders" — the plural items' own labelling rule (YAZ-1337). */
export function focusLabel(count: number): string {
  return count > 1 ? `Focus on ${count} folders` : 'Focus on folder'
}

/** A board row — a drawing or a diagram (🔒 YAZ-1802 D2) — by the live tree's word (🔒 YAZ-1835 D6): Info describes boards, not `notes.txt`. */
export function isBoardRow(tree: readonly TreeNode[], path: string): boolean {
  const node = findNode(tree, path)
  return node !== null && node.type === 'file' && node.kind !== null
}

/**
 * Sidebar's pinned `MenuTargets` plus the app-wide clipboard's LIVE state — the one field read at
 * render time rather than at open time, so "Paste N items" follows a copy made in another window
 * while this menu stands (🔒 D1, YAZ-1674).
 */
export type MenuSectionTargets = MenuTargets & { clip: FileClipState }

export interface MenuHandlers {
  /** One background tab per path (I3's opener, GRO-2235) — the caller owns the loop's semantics. */
  onOpenInNewTabs: (paths: string[]) => void
  onOpenNewWindow: (path: string) => void
  onOpenVsCode: (path: string) => void
  onOpenDefault: (path: string) => void
  onReveal: (path: string) => void
  /** "Focus on folder" / "Focus on N folders" (YAZ-1605) — the caller spells the label: it knows the count. */
  focusLabel: string
  onFocus: (paths: string[]) => void
  /** Cut / Copy (YAZ-1674): the paths go to main's ONE app-wide clipboard (🔒 D1); the caller reports. */
  onCut: (paths: string[]) => void
  onCopy: (paths: string[]) => void
  /** Paste into the menu's target dir — null WITHHOLDS the item (🔒 D5, YAZ-1674): Paste is offered exactly where "New folder" is. */
  onPaste: (() => void) | null
  /**
   * The panel's passive notice (YAZ-1337): a clipboard write that never lands says so, the way
   * `PageContextMenu` reports it — a copy that quietly did nothing is the worst kind of no-op.
   */
  onNotice: (message: string) => void
  /** "New Excalidraw drawing" (⚡ YAZ-1674 D8 amended): the first row of the create group — opens the name box (🔒 YAZ-1999 D1). */
  onNewDrawing: () => void
  /** "New dated Excalidraw drawing" (🔒 YAZ-1999 D3): the same birth, its box seeded with today's `MM_DD- `, directly below it. */
  onNewDatedDrawing: () => void
  /** "New draw.io diagram" (🔒 YAZ-1802 D13): the same birth for a `.drawio`, directly below it. */
  onNewDiagram: () => void
  /** Create a DISK folder — null hides the item (YAZ-948). */
  onNewFolder: (() => void) | null
  /** "New dated folder" (YAZ-1604): a disk folder born with today's `MM_DD- ` seed. Same gate as `onNewFolder`. */
  onNewDatedFolder: (() => void) | null
  /** "Add to favorites" / "Remove N from favorites" (YAZ-1766 D3): the paths and the direction the menu read, same idiom. */
  onToggleFavorite: (paths: string[], isOn: boolean) => void
  onRename: (path: string) => void
  /** "Info" (🔒 YAZ-1835 D6): open the board's popover; the caller anchors it where the menu was. */
  onInfo: (path: string) => void
  /** "Share" (YAZ-1799 D6): open the Share dialog for the board — same gate as Info. */
  onShare: (path: string) => void
  /** "Version history" (YAZ-1897 D4): open the board's versions — same gate as Info. */
  onHistory: (path: string) => void
  onDelete: (path: string) => void
}

type Item = (t: MenuSectionTargets, h: MenuHandlers) => MenuItem | null
/** A leaf-only rule — what a flyout may hold. Every leaf is also an `Item`. */
type Leaf = (t: MenuSectionTargets, h: MenuHandlers) => MenuAction | null

/** Why a clipboard write failed, as the notices spell it — shared with the vault menu (YAZ-1941). */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** "1 item" / "3 items" — the one spelling the menu's labels and the Sidebar's notices share. */
export const countItems = (n: number) => (n === 1 ? '1 item' : `${n} items`)

// ---- (1) Open / View: the plural open and Focus — read-only, and often empty on one row ----

/**
 * "Open N in new tabs" — the FILES of a 2+ selection (🔒 D5, YAZ-1337): a folder cannot be a tab
 * (YAZ-1578 🔒 D3), so a folders-only selection has no item. It LEADS the menu: when a right-click
 * lands inside a selection, what the user is pointing at is the SELECTION. It leaves the
 * selection standing — acting on it is not the same as ending it.
 */
const openInNewTabs: Leaf = (t, h) => {
  const paths = t.openTabPaths
  if (paths === null) return null
  return { id: 'open-tabs', label: `Open ${paths.length} in new tabs`, onSelect: () => h.onOpenInNewTabs(paths) }
}

/**
 * Focus on folder (YAZ-1605): a read-only VIEW verb, so it closes the Open group — it
 * changes what the tree shows, never what is on disk. An EMPTY list hides it too (the caller's
 * "nothing here can be focused" answer).
 */
const focus: Leaf = (t, h) => {
  const paths = t.focusPaths
  if (paths === null || paths.length === 0) return null
  return { id: 'focus', label: h.focusLabel, onSelect: () => h.onFocus(paths) }
}

// ---- (2) Clipboard: the file clipboard (YAZ-1674), then the text clipboard ----

/**
 * Cut / Copy (🔒 D5, YAZ-1674): ONE rule, two verbs — any ROW, file or dir, both lenses; hidden on
 * blank space (there is nothing to clip). Inside a 2+ selection the target is the ORDERED
 * selection and the label counts it; else the one row and the bare verb.
 */
const clipVerb = (id: string, verb: string, hint: string, pick: (h: MenuHandlers) => (paths: string[]) => void): Leaf => (t, h) => {
  const paths = t.clipPaths
  if (paths === null) return null
  return { id, label: paths.length >= 2 ? `${verb} ${paths.length} items` : verb, hint, onSelect: () => pick(h)(paths) }
}
const cut = clipVerb('cut', 'Cut', '⌘X', (h) => h.onCut)
const copy = clipVerb('copy', 'Copy', '⌘C', (h) => h.onCopy)

/**
 * Paste (🔒 D5, YAZ-1674): offered wherever "New folder" is (`onPaste` null withholds it), and
 * DISABLED — not hidden — while the clipboard is empty, so the verb is discoverable before the
 * first Cut or Copy. With something clipped the label counts it: "Paste 1 item", "Paste 3 items".
 */
const paste: Leaf = (t, h) => {
  const onPaste = h.onPaste
  if (onPaste === null) return null
  const clip = t.clip
  if (clip === null) return { id: 'paste', label: 'Paste', hint: '⌘V', disabled: true, onSelect: () => undefined }
  return { id: 'paste', label: `Paste ${countItems(clip.count)}`, hint: '⌘V', onSelect: onPaste }
}

/**
 * "Copy N paths" — the whole selection, files and folders (YAZ-1578), in the panel's own order
 * (🔒 D5, YAZ-1337; ⚡ YAZ-1338 appends the paths whose rows are hidden), newline-joined. Null
 * hides it, which is every menu opened outside a 2+ selection. Its own target, never `copyPath`
 * in a list: that one falls back to the vault root on blank space. The failure is REPORTED
 * (`PageContextMenu`'s idiom): a clipboard the OS refused is silent otherwise.
 */
const copyPaths: Leaf = (t, h) => {
  const paths = t.copyPaths
  if (paths === null) return null
  return {
    id: 'copy-paths',
    label: `Copy ${paths.length} paths`,
    onSelect: () => {
      void navigator.clipboard.writeText(paths.join('\n')).then(
        () => h.onNotice(`Copied ${paths.length} paths`),
        (error: unknown) => h.onNotice(`Can't copy paths: ${errorText(error)}`),
      )
    },
  }
}

/**
 * "Copy path" — the row, or the vault ROOT for blank space (GRO-2273). Every copy confirms
 * through the one notice (YAZ-1341) — this item long predates it, so it also gained the failure
 * report it never had. No shortcut hint: the chord that used to carry one went with the old
 * document layer (YAZ-1808), so the menu row is the whole gesture.
 */
const copyPath: Leaf = (t, h) => {
  const path = t.copyPath
  if (path === null) return null
  return {
    id: 'copy-path',
    label: 'Copy path',
    onSelect: () => {
      void navigator.clipboard.writeText(path).then(
        () => h.onNotice('Copied path'),
        (error: unknown) => h.onNotice(`Can't copy path: ${errorText(error)}`),
      )
    },
  }
}

// ---- (3) Create: births BESIDE the right-clicked row — the group targets a DIRECTORY, never the row ----

const newDrawing: Leaf = (_t, h) => ({ id: 'new-drawing', label: 'New Excalidraw drawing', onSelect: h.onNewDrawing })

const newDatedDrawing: Leaf = (_t, h) => ({ id: 'new-dated-drawing', label: 'New dated Excalidraw drawing', onSelect: h.onNewDatedDrawing })

/** 🔒 YAZ-1802 D13: the create group names both kinds of board, Excalidraw first. */
const newDiagram: Leaf = (_t, h) => ({ id: 'new-diagram', label: 'New draw.io diagram', onSelect: h.onNewDiagram })

const newFolder: Leaf = (_t, h) => (h.onNewFolder === null ? null : { id: 'new-folder', label: 'New folder', onSelect: h.onNewFolder })

const newDatedFolder: Leaf = (_t, h) =>
  h.onNewDatedFolder === null ? null : { id: 'new-dated-folder', label: 'New dated folder', onSelect: h.onNewDatedFolder }

// ---- (4) This row: acts ON the right-clicked row, so it sits after the create group ----

/** Rename — a concrete row only, NEVER blank space: main refuses to rename a window's own vault root (E1b, GRO-2241). */
const rename: Leaf = (t, h) => {
  const path = t.renamePath
  if (path === null) return null
  return { id: 'rename', label: 'Rename', onSelect: () => h.onRename(path) }
}

/**
 * The favorite toggle (YAZ-1766 D3): ONE state-aware item on every ROW — file or dir, any lens —
 * never on blank space. Inside a 2+ selection it names the whole ordered selection and counts it
 * ("Add 3 to favorites"); `favoriteIsOn` is true only when EVERY path is already a favorite, so a
 * mixed selection reads as Add and the handler adds the missing ones. Leads the "Open in ▸"
 * group (Yasin, demo 2026-09-21): a place-verb beside the OS place-verbs, one hairline above Delete.
 */
const toggleFavorite: Leaf = (t, h) => {
  const paths = t.favoritePaths
  if (paths === null) return null
  const isOn = t.favoriteIsOn
  const n = paths.length > 1 ? `${paths.length} ` : ''
  return { id: 'toggle-favorite', label: isOn ? `Remove ${n}from favorites` : `Add ${n}to favorites`, onSelect: () => h.onToggleFavorite(paths, isOn) }
}

// ---- (5) Open in ▸: the OS verbs, one parent in a group of its own (D7 amended) ----

/** "Open in ▸ New window" — FILE rows only (D2, GRO-2168); folders and blank space hide it. */
const openInNewWindow: Leaf = (t, h) => {
  const path = t.newWindowPath
  if (path === null) return null
  return { id: 'open-window', label: 'New window', onSelect: () => h.onOpenNewWindow(path) }
}

/**
 * Open in VS Code (YAZ-963): Reveal's sibling — same target rule (file, folder, or the vault ROOT
 * for blank space), same read-only posture, same passive notice when the row is stale.
 */
const openInVsCode: Leaf = (t, h) => {
  const path = t.openVsCodePath
  if (path === null) return null
  return { id: 'open-vscode', label: 'VS Code', onSelect: () => h.onOpenVsCode(path) }
}

/** Open in ▸ Default app (YAZ-1577): the third OS verb, directly below VS Code — same target rule, same posture. */
const openInDefault: Leaf = (t, h) => {
  const path = t.openDefaultPath
  if (path === null) return null
  return { id: 'open-default', label: 'Default app', onSelect: () => h.onOpenDefault(path) }
}

/**
 * Reveal in Finder (GRO-2274): available on every row type AND on blank space, where it reveals
 * the vault root — the same target Copy path uses. A read-only utility; inside the flyout it sits
 * alone below a separator (D7 amended) — it shows the row rather than opening it.
 */
const revealInFinder: Leaf = (t, h) => {
  const path = t.revealPath
  if (path === null) return null
  return { id: 'reveal', label: 'Reveal in Finder', onSelect: () => h.onReveal(path) }
}

/**
 * "Open in ▸" (D7 amended, YAZ-1674): the OS verbs collapse into one parent so the top level reads
 * as verbs about the ROW; it stands in its OWN group between the this-row items and Delete. The
 * flyout keeps every child's own gate — New window is FILE rows only (D2, GRO-2168); VS Code,
 * Default app and Reveal share the root-on-blank-space rule — and a separator (a second section)
 * sets Reveal apart from the three "open" verbs. No child at all → no parent: an empty flyout is a lie.
 */
const openIn: Item = (t, h) => {
  const children = [build([openInNewWindow, openInVsCode, openInDefault], t, h), build([revealInFinder], t, h)]
  if (children.every((section) => section.length === 0)) return null
  return { id: 'open-in', label: 'Open in', children }
}

// ---- (6) Delete's group: Info, then Delete — LAST (GRO-2272 `C1a-`, LOCKED; Info above it, 🔒 YAZ-1835 D6) ----

/**
 * Delete renders LAST (GRO-2272 `C1a-`, LOCKED): VS Code's Explorer puts it at the bottom, and
 * destructive-last is safer on its own merits — Delete used to sit directly under Rename, the
 * misclick pair that matters most; 🔒 YAZ-1337 D7 now puts a whole group ("Open in ▸") and two
 * separators between them. Its one neighbour is now Info (🔒 YAZ-1835 D6), a read-only item —
 * the safest thing a misclick can land on.
 * Delete opens the confirm sheet; it must NEVER delete directly. Null on blank space: no target,
 * and main refuses the vault root anyway.
 */
const del: Leaf = (t, h) => {
  const path = t.deletePath
  if (path === null) return null
  return { id: 'delete', label: 'Delete', danger: true, onSelect: () => h.onDelete(path) }
}

/** "Info" (🔒 YAZ-1835 D6): one BOARD row, never blank space, a folder or a multi-select — above Delete, in its group. */
const info: Leaf = (t, h) => {
  const path = t.infoPath
  if (path === null) return null
  return { id: 'info', label: 'Info', onSelect: () => h.onInfo(path) }
}

const OPEN_GROUP: readonly Item[] = [openInNewTabs, focus]
const CLIPBOARD_GROUP: readonly Item[] = [cut, copy, paste, copyPaths, copyPath]
const CREATE_GROUP: readonly Item[] = [newDrawing, newDatedDrawing, newDiagram, newFolder, newDatedFolder]
const ROW_GROUP: readonly Item[] = [rename]
const OPEN_IN_GROUP: readonly Item[] = [toggleFavorite, openIn]
/**
 * "Share" (YAZ-1799 D6): Info's gate — one board row, a drawing or a diagram (🔒 YAZ-1802 D11) — and
 * just above Info, so Info stays directly above Delete (🔒 YAZ-1835 D6).
 */
const share: Leaf = (t, h) => {
  const path = t.infoPath
  if (path === null) return null
  return { id: 'share', label: 'Share', onSelect: () => h.onShare(path) }
}

/** "Version history" (YAZ-1897 D4): Info's gate too — a draw.io diagram has pictures and Restore (🔒 YAZ-1802 D10) — between Share and Info. */
const history: Leaf = (t, h) => {
  const path = t.infoPath
  if (path === null) return null
  return { id: 'history', label: 'Version history', onSelect: () => h.onHistory(path) }
}

const DELETE_GROUP: readonly Item[] = [share, history, info, del]

/** Runs a group's rules and keeps the items they offered — the root's groups and a flyout's leaves alike. */
const build = <T extends MenuItem>(group: readonly ((t: MenuSectionTargets, h: MenuHandlers) => T | null)[], t: MenuSectionTargets, h: MenuHandlers): T[] =>
  group.map((rule) => rule(t, h)).filter((item): item is T => item !== null)

/** The six groups of 🔒 YAZ-1674 D7 (as amended), in order, every null item dropped. An empty group is the component's to skip. */
export function buildMenuSections(targets: MenuSectionTargets, handlers: MenuHandlers): MenuSection[] {
  return [OPEN_GROUP, CLIPBOARD_GROUP, CREATE_GROUP, ROW_GROUP, OPEN_IN_GROUP, DELETE_GROUP].map((group) => build(group, targets, handlers))
}
