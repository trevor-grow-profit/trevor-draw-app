import { DIAGRAM_EXTENSIONS, DRAWING_VIEW_EXTENSIONS, type FileKind } from './types'

/**
 * Lower-cased extension of a file name or path, dot included; `null` when there is none. A leading
 * dot alone is not an extension (`.excalidraw` the file has none), matching Node's `path.extname`.
 */
function extensionOf(name: string): string | null {
  const basename = name.slice(name.lastIndexOf('/') + 1)
  const dot = basename.lastIndexOf('.')
  return dot <= 0 ? null : basename.slice(dot).toLowerCase()
}

/** Classifies a file name or path using the one approved, case-insensitive extension contract. */
export function fileKind(name: string): FileKind | null {
  const ext = extensionOf(name)
  if (ext === null) return null
  if ((DRAWING_VIEW_EXTENSIONS as readonly string[]).includes(ext)) return 'drawing'
  if ((DIAGRAM_EXTENSIONS as readonly string[]).includes(ext)) return 'diagram'
  return null
}

/**
 * What the app calls each kind wherever a TYPE is meant (🔒 YAZ-1802 D13): the engine is named, so
 * "Excalidraw drawing" and "draw.io diagram" never blur into each other. Generic surfaces say "board".
 */
export const BOARD_TYPE_NAME: Record<FileKind, string> = { drawing: 'Excalidraw drawing', diagram: 'draw.io diagram' }

/**
 * An EXCALIDRAW scene, and only that (🔒 YAZ-1802 D2): every door that reads or writes scene JSON —
 * `drawing:load` / `drawing:save`, the create's JSON stamping, board merge, history, previews,
 * shrink, the orphan sweep, storage — keeps asking this, so a diagram never reaches them.
 */
export function isDrawing(name: string): boolean {
  return fileKind(name) === 'drawing'
}

/** A draw.io diagram (🔒 YAZ-1802 D2): its own doors, `diagram:load` / `diagram:save`. */
export function isDiagram(name: string): boolean {
  return fileKind(name) === 'diagram'
}

/**
 * Any document the app opens in-app — a drawing OR a diagram (🔒 YAZ-1802 D2). What the GENERIC
 * surfaces ask: the tree row, Info, search, the hover preview, the dates on the file head, the
 * files a launch was handed.
 */
export function isBoard(name: string): boolean {
  return fileKind(name) !== null
}

/** A board's name or path without its extension (`Flow.DRAWIO` → `Flow`, `.excalidraw` → ``); any other name is returned whole. */
export function boardBaseName(name: string): string {
  const dot = name.lastIndexOf('.')
  const isBoardExt = dot !== -1 && ([...DRAWING_VIEW_EXTENSIONS, ...DIAGRAM_EXTENSIONS] as string[]).includes(name.slice(dot).toLowerCase())
  return isBoardExt ? name.slice(0, dot) : name
}

/** The extension each kind of board is born with (🔒 YAZ-1802 D13). */
export const BOARD_EXTENSION: Record<FileKind, string> = { drawing: DRAWING_VIEW_EXTENSIONS[0], diagram: DIAGRAM_EXTENSIONS[0] }

/**
 * Renames never transcode bytes: a file may move between the extensions of its own kind, and a
 * file with no supported kind keeps its exact extension, since nothing else vouches for what its
 * bytes are (YAZ-1577 D5).
 */
export function canRenameWithoutConversion(oldName: string, newName: string): boolean {
  const oldKind = fileKind(oldName)
  if (oldKind !== fileKind(newName)) return false
  if (oldKind !== null) return true
  return extensionOf(oldName) === extensionOf(newName)
}

/** How many hex digits end an atomic write's tmp name, `<file>.tmp-<hex>` (`tmpSibling` in main's `fs/fsUtils.ts`). */
export const ATOMIC_TMP_HEX_LEN = 12
const ATOMIC_TMP = new RegExp(`\\.tmp-[0-9a-f]{${ATOMIC_TMP_HEX_LEN}}$`)

/**
 * Whether `name` is an atomic write's own tmp file. One that outlives its write is a crash's
 * leftover: no watcher announces it (YAZ-2073 5F), the tree does not list it, git never commits it
 * and the orphan sweep trashes one in `assets/` once it is a day old.
 */
export const isAtomicTmp = (name: string): boolean => ATOMIC_TMP.test(name)
