import { memo, type ReactElement } from 'react'
import type { FileKind, TreeNode } from '@shared/types'
import type { FileNode } from '@shared/treeSort'
import { DiagramBadge, LinkIcon } from '../components/icons'
import { stripExt } from '../lib/paths'
import { TOO_LARGE_LABEL } from '../lib/syncAttention'
import { CreateInline } from './CreateInline'
import { renameInputName, type EntryKind } from './createEntry'
import { RenameInline } from './RenameInline'

/** Inline "New drawing"/"New folder" input pending inside the tree (GRO-2022). */
export interface PendingCreate {
  kind: EntryKind
  seed: string
  /** Absolute path of the directory the entry is created in. */
  parentDir: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}

/** Inline rename replacing one row's label (files E1, GRO-2194; folders E1b, GRO-2241). */
export interface PendingRename {
  /** Absolute path of the row (file or dir) being renamed. */
  path: string
  onSubmit: (name: string) => Promise<void>
  onCancel: () => void
}

/**
 * Drag a FILE row onto a FOLDER row to move it there (E1b, GRO-2241). The TabBar's HTML5
 * drag idiom: component state carries the payload (`dataTransfer` is guarded — jsdom's
 * synthetic drags have none), a highlight class marks the hovered drop target. FILE rows
 * only — no multi-select, no folder dragging (Future note in GRO-2241).
 */
export interface TreeFileMove {
  /** The dragged FILE row's path; null when no drag is in flight. */
  dragging: string | null
  /** The dir currently highlighted as the drop target (a dir row's path, or the root for the header). */
  dropDir: string | null
  start: (path: string) => void
  end: () => void
  hover: (dir: string | null) => void
  drop: (dir: string) => void
}

/**
 * Favorites drag-to-reorder (YAZ-1766 D4): the SAME HTML5 idiom as `TreeFileMove`, but a separate
 * mechanism — it rewrites the favorites LIST and never touches disk. Applied to depth-0 rows only:
 * when it is present, nested rows are not draggable at all (no disk moves from the Favorites tab),
 * and the file move above is expected to be inert.
 */
export interface TreeReorder {
  /** The dragged root row's path; null when no drag is in flight. */
  dragging: string | null
  /** The hovered root row and which edge of it the drop lands on. */
  over: { path: string; edge: 'before' | 'after' } | null
  start: (path: string) => void
  hover: (path: string, edge: 'before' | 'after') => void
  drop: () => void
  end: () => void
}

/** Which half of the hovered row the pointer is in — jsdom's zero rect and 0 clientY read as `after`. */
const edgeOf = (e: React.DragEvent): 'before' | 'after' => {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
}

/**
 * Sidebar multi-select (YAZ-1336, 🔒 D1) as both trees take it: the selected PATHS plus the two
 * gestures that change them. The Sidebar owns the reducer behind it; keying by path is 🔒 YAZ-1336 D3, so
 * a folder drawn on both lenses shows selected on BOTH of its rows. A path is a
 * file or a FOLDER (YAZ-1578): a selected folder is the folder itself, never its contents.
 */
export interface TreeSelection {
  paths: ReadonlySet<string>
  /** 🔒 YAZ-1336 D2: shift+click on a file or folder row toggles it in or out — no range, never an open, never a fold. */
  toggle: (path: string) => void
  /** D9 (YAZ-1674): a plain click or ⌘-click makes the selection EXACTLY this row — then opens or folds as before. */
  set: (path: string) => void
}

interface TreeProps {
  nodes: TreeNode[]
  /** Absolute path of the directory these nodes are children of (the root at depth 0). */
  dirPath: string
  expanded: ReadonlySet<string>
  activeFile: string | null
  onToggle: (dir: string) => void
  onOpenFile: (path: string) => void
  /**
   * ⌘-click on a file row (I3 LOCKED ruling, GRO-2235): open it in a background tab of THIS
   * window — activation stays put. "Open in new window" lives on the context menu (D2).
   */
  onOpenFileBackground: (path: string) => void
  /** A row with no in-app viewer (`kind: null`, YAZ-1577 D2): hand it to the OS default app instead of a tab. */
  onOpenDefault: (path: string) => void
  /** Right-click on a row; blank-space right-clicks are handled by the sidebar body. */
  onNodeContextMenu: (node: TreeNode, e: React.MouseEvent) => void
  pending: PendingCreate | null
  /** The one row (file or dir) currently renamed inline (E1/E1b); null when none. */
  renaming: PendingRename | null
  /** File drag-to-move state + callbacks (E1b); owned by the Sidebar. */
  move: TreeFileMove
  /** Multi-select state + gestures (YAZ-1336); owned by the Sidebar, shared by both lenses. */
  selection: TreeSelection
  /** Favorites-only (YAZ-1766 D4): root rows reorder the list instead of moving files; nested rows do not drag. */
  reorder?: TreeReorder
  /**
   * The hover preview's trigger (YAZ-1800): a BOARD row's pointer and focus, entering (the node) and
   * leaving (null). The Sidebar owns the dwell and the panel. Absent = previews off.
   */
  onHoverFile?: (node: FileNode | null) => void
  /** YAZ-1801 D3: absolute paths held back from sync as over GitHub's limit; their rows get the cloud-off icon. */
  tooLarge?: ReadonlySet<string>
  /** Shared boards (YAZ-1799): a small link icon on the row, red when the last update failed or the link is stale; the title is the status. */
  shareBadges?: ReadonlyMap<string, ShareBadge>
  depth?: number
}

/** A broken cloud (cloud-off): red, right of the name, on a file sync held back. */
function CloudOffIcon() {
  return (
    <span className="tree__too-large" role="img" aria-label={TOO_LARGE_LABEL} title={TOO_LARGE_LABEL}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    </span>
  )
}

/**
 * 🔒 YAZ-1802 D15: a draw.io diagram's mark, since its name no longer says (the extension is
 * hidden). An unmarked board is an Excalidraw drawing, the usual kind. The mark sits in the slot a
 * folder's chevron takes, so it costs the name no width; every other row keeps the slot empty so
 * all names line up.
 */
function KindIcon({ kind }: { kind: FileKind | null }) {
  return kind === 'diagram' ? <DiagramBadge className="tree__kind" /> : <span className="tree__kind" aria-hidden="true" />
}

export interface ShareBadge {
  tone: 'ok' | 'error'
  title: string
}

/** The shared-board mark (YAZ-1890): a small link glyph right of the name; its title is the link's status. Nothing for an unshared board. */
const ShareMark = ({ badge }: { badge: ShareBadge | undefined }) =>
  badge === undefined ? null : (
    <span className="tree__share" data-tone={badge.tone} title={badge.title} aria-label={badge.title} role="img">
      <LinkIcon size={12} />
    </span>
  )

/**
 * One level of the tree, and through `recurse` every open level below it. Memoized as `Tree` (YAZ-2073 5D,
 * 🔒 D16): the Sidebar hands it stable props, so a Sidebar render that changes nothing a row shows
 * re-renders no row. Every level shares those props, so a move in one of them (a fold, the selection,
 * the active file) re-renders every open level.
 */
function TreeLevel({
  nodes,
  dirPath,
  expanded,
  activeFile,
  onToggle,
  onOpenFile,
  onOpenFileBackground,
  onOpenDefault,
  onNodeContextMenu,
  pending,
  renaming,
  move,
  selection,
  reorder,
  onHoverFile,
  tooLarge,
  shareBadges,
  depth = 0,
}: TreeProps): ReactElement {
  const recurse = { expanded, activeFile, onToggle, onOpenFile, onOpenFileBackground, onOpenDefault, onNodeContextMenu, pending, renaming, move, selection, reorder, onHoverFile, tooLarge, shareBadges }
  // The reorder gesture lives on depth-0 rows alone; deeper rows of a reorderable tree drag nothing.
  const rowReorder = reorder !== undefined && depth === 0 ? reorder : null
  // What a FILE row's drag does: move on disk (E1b) on an ordinary tree, reorder at depth 0 of a reorderable one, nothing below that.
  const fileDrag: Pick<TreeFileMove, 'start' | 'end'> | null = reorder === undefined ? move : rowReorder
  // A BOARD row's hover preview trigger (YAZ-1800) — pointer and focus alike. It replaces the native
  // path tooltip, which would sit on top of the panel that already names the board; any other file
  // (no in-app viewer, no picture) keeps its tooltip.
  const hoverProps = (node: FileNode) =>
    // 🔒 YAZ-1802 D9: a diagram previews too — any board kind.
    onHoverFile === undefined || node.kind === null
      ? { title: node.path }
      : { onMouseEnter: () => onHoverFile(node), onMouseLeave: () => onHoverFile(null), onFocus: () => onHoverFile(node), onBlur: () => onHoverFile(null) }
  const dropEdge = (path: string) => (rowReorder?.over?.path === path ? ` tree__row--drop-${rowReorder.over.edge}` : '')
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {pending !== null && pending.parentDir === dirPath && (
        <li>
          <CreateInline
            kind={pending.kind}
            seed={pending.seed}
            indent={8 + depth * 14 + (pending.kind === 'dir' ? 0 : 14)}
            onSubmit={pending.onSubmit}
            onCancel={pending.onCancel}
          />
        </li>
      )}
      {nodes.map((node) =>
        node.type === 'dir' ? (
          <li key={node.path} role="treeitem" aria-expanded={expanded.has(node.path)} aria-selected={selection.paths.has(node.path)}>
            {renaming !== null && renaming.path === node.path ? (
              // Inline FOLDER rename (E1b, GRO-2241): same idiom as files, prefilled with the
              // raw name — folders have no extension logic (one could be NAMED "Plans.excalidraw").
              <RenameInline initial={node.name} indent={8 + depth * 14} onSubmit={renaming.onSubmit} onCancel={renaming.onCancel} />
            ) : (
              <button
                type="button"
                className={`tree__row tree__row--dir${selection.paths.has(node.path) ? ' tree__row--selected' : ''}${move.dropDir === node.path ? ' tree__row--drop' : ''}${dropEdge(node.path)}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                // Read by `flashTreeRows` (a Files reveal of a FOLDER, YAZ-1491) and by
                // `orderedSelection`, which puts a selected folder in on-screen order (YAZ-1578).
                data-path={node.path}
                // Shift is the SELECTION gesture everywhere (YAZ-1340) and a folder joins the
                // selection like a file (YAZ-1578, 🔒 D1) — so shift toggles and never folds. A
                // PLAIN click SELECTS the folder (D9, YAZ-1674 — the Finder rule) and then folds,
                // so ⌘C / ⌘V have a target the moment a folder is clicked.
                onClick={(e) => {
                  if (e.shiftKey) {
                    selection.toggle(node.path)
                    return
                  }
                  selection.set(node.path)
                  onToggle(node.path)
                }}
                onContextMenu={(e) => onNodeContextMenu(node, e)}
                draggable={rowReorder !== null}
                onDragStart={rowReorder === null ? undefined : (e) => {
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                  rowReorder.start(node.path)
                }}
                onDragEnd={rowReorder?.end}
                onDragOver={(e) => {
                  if (rowReorder !== null && rowReorder.dragging !== null) {
                    e.preventDefault()
                    rowReorder.hover(node.path, edgeOf(e))
                    return
                  }
                  if (move.dragging === null) return
                  e.preventDefault() // a dir row is a valid drop target while a file drag is in flight
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                  if (move.dropDir !== node.path) move.hover(node.path)
                }}
                onDragLeave={() => {
                  if (move.dropDir === node.path) move.hover(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (rowReorder !== null && rowReorder.dragging !== null) rowReorder.drop()
                  else move.drop(node.path)
                }}
              >
                <span className={`tree__chevron${expanded.has(node.path) ? ' tree__chevron--open' : ''}`} />
                <span className="tree__label">{node.name}</span>
              </button>
            )}
            {expanded.has(node.path) && <Tree nodes={node.children} dirPath={node.path} depth={depth + 1} {...recurse} />}
          </li>
        ) : renaming !== null && renaming.path === node.path ? (
          // Inline rename (Links E1, GRO-2194): a drawing hides its suffix and re-appends it on
          // commit; view-only files show the full filename so their extension stays explicit.
          <li key={node.path} role="treeitem">
            <RenameInline initial={renameInputName(node.name)} indent={8 + depth * 14 + 14} onSubmit={renaming.onSubmit} onCancel={renaming.onCancel} />
          </li>
        ) : (
          <li key={node.path} role="treeitem" aria-selected={node.path === activeFile || selection.paths.has(node.path)}>
            <button
              type="button"
              className={`tree__row tree__row--file${node.kind === null ? ' tree__row--external' : ''}${node.path === activeFile ? ' tree__row--active' : ''}${selection.paths.has(node.path) ? ' tree__row--selected' : ''}${dropEdge(node.path)}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={(e) => {
                // Shift is the SELECTION gesture and nothing else (YAZ-1336, 🔒 D2): it never
                // opens, never previews — so it is asked first, before any of the open rules.
                if (e.shiftKey) {
                  selection.toggle(node.path)
                  return
                }
                // Every other click makes the selection THIS row (D9, YAZ-1674) — plain and ⌘
                // alike, the external row too — before the open rules decide where it opens.
                selection.set(node.path)
                // No in-app viewer (YAZ-1577 D2): the OS default app IS the viewer, so no tab —
                // and nothing for ⌘ to background. Asked before the open rules, after shift.
                if (node.kind === null) {
                  onOpenDefault(node.path)
                  return
                }
                // Opening keeps focus on the row (YAZ-921), so ↑/↓ carry on walking the tree.
                if (e.metaKey) onOpenFileBackground(node.path)
                else if (node.path !== activeFile) onOpenFile(node.path)
              }}
              onContextMenu={(e) => onNodeContextMenu(node, e)}
              {...hoverProps(node)}
              data-path={node.path}
              draggable={fileDrag !== null}
              onDragStart={fileDrag === null ? undefined : (e) => {
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', node.path)
                }
                fileDrag.start(node.path)
              }}
              onDragEnd={fileDrag?.end}
              onDragOver={rowReorder === null ? undefined : (e) => {
                if (rowReorder.dragging === null) return
                e.preventDefault()
                rowReorder.hover(node.path, edgeOf(e))
              }}
              onDrop={rowReorder === null ? undefined : (e) => {
                e.preventDefault()
                rowReorder.drop()
              }}
            >
              <KindIcon kind={node.kind} />
              <span className="tree__label">{stripExt(node.name)}</span>
              {tooLarge?.has(node.path) === true && <CloudOffIcon />}
              <ShareMark badge={shareBadges?.get(node.path)} />
            </button>
          </li>
        ),
      )}
    </ul>
  )
}

export const Tree = memo(TreeLevel)
