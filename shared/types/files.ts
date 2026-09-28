/** The file layer: the tree, create, rename, delete, the app-wide clipboard, the dialogs and the watcher. */

import type { BridgeErrorCode, FileKind, MAX_DRAWING_BYTES } from './errors'

/**
 * The two dates every board main writes carries as its FIRST key (🔒 YAZ-1834 D1):
 * `{ "yaseendraw": { "createdAt", "updatedAt" } }`. Set by main only (D3); the block is also the
 * contract the cloud backfill (YAZ-1832) writes, and it may add keys of its own inside the
 * block, which every save preserves (D5). Rules and readers: `shared/drawingAssets.ts`.
 */
export interface BoardMeta {
  /** Epoch ms. Born on create or on the first save of a board without a block; never rewritten once it is a finite number. */
  createdAt: number
  /** Epoch ms of the last in-app save. */
  updatedAt: number
}

export type TreeNode =
  | {
      type: 'dir'
      name: string
      path: string
      children: TreeNode[]
    }
  | {
      type: 'file'
      name: string
      path: string
      /** Byte size. */
      size: number
      /** mtime in epoch ms. */
      mtime: number
      /**
       * The board's own dates from its `yaseendraw` block (🔒 YAZ-1834 D1/D6), read from the
       * file head during the walk; absent when the file has no block, or it is not the first key,
       * or it is malformed (D7). For sorting it WINS over `mtime`: a clone resets mtimes, the block
       * travels with the bytes.
       */
      meta?: BoardMeta
      /** Preview classification (`shared/fileKind.ts`); `null` = listed, but no in-app viewer (YAZ-1577 D1). */
      kind: FileKind | null
    }

export interface TreeResponse {
  root: string
  /** Recursive tree of the root: every file and every directory, supported or not (GRO-2022). Hidden (dot) entries and `node_modules` skipped. */
  tree: TreeNode[]
  /** Main-process time (epoch ms) when the tree was computed. */
  generatedAt: number
}

// ---------- createDir(path) ----------

export interface CreateDirResponse {
  path: string
}

// ---------- createFile(req) ----------

/**
 * `createFile` takes `{ path, content }` (Bible B, GRO-2202): the content lands in the same
 * atomic `wx` write, which is what lets "New drawing" be born with the empty scene inside it —
 * no create-then-write race, never a zero-byte board, and the never-overwrite guarantee intact.
 * Main stamps the scene's `yaseendraw` block before writing (🔒 YAZ-1834 D3).
 */
export interface CreateFileRequest {
  path: string
  /** The scene, as JSON text. Must be a JSON object → otherwise `BAD_REQUEST`. */
  content: string
}

export interface CreateFileResponse {
  path: string
  mtime: number
  /** The created file's byte length (0 for an empty create). */
  size: number
}

// ---------- file.rename(req) (Links E1 + E1b, GRO-2194 / GRO-2241) ----------

/**
 * In-app rename/move. Files rename in place or move between folders (extension KIND
 * unchanged: md↔md, base↔base); directories rename/move too (`kind: 'dir'` in the
 * response — no extension rules, dot-dirs and the calling window's own vault root are
 * refused `BAD_REQUEST`). The target's parent must already exist (`NOT_FOUND` — never a
 * mkdir). Never overwrites: an existing target rejects `ALREADY_EXISTS`. The same handler
 * repairs every stored path reference — for a dir, everything at or UNDER it: window
 * roots/files/tabs, recents, folder-state keys and their expanded/lastFile/fold/base-group
 * entries — and pushes `file:renamed` to every window.
 */
export interface RenameFileRequest {
  oldPath: string
  newPath: string
}

export interface RenameFileResponse {
  oldPath: string
  newPath: string
  /** What moved: a single file, or a directory (E1b — renderers then remap by prefix). */
  kind: 'file' | 'dir'
}

/** Pushed to EVERY window after a successful in-app rename; renderers remap their own tabs (a `dir` event remaps every tab under the old prefix). */
export interface FileRenamedEvent {
  oldPath: string
  newPath: string
  kind: 'file' | 'dir'
}

// ---------- file clipboard (YAZ-1674) ----------

/**
 * Cut / Copy from the sidebar (YAZ-1674, D1): the ONE app-wide clipboard lives in main, so a
 * paste in any window — on the same vault or another — takes what any window cut or copied.
 * `paths` is the ORDERED selection (one row, or the whole multi-select), absolute; `op` decides
 * what a later paste does (D2: a cut MOVES through the rename pipeline and pastes once; a copy
 * COPIES and pastes again and again). Session-only, never persisted. Rejects `BAD_REQUEST` for
 * a missing/unknown `op` or an empty `paths`, `NOT_ABSOLUTE` for a relative entry.
 */
export interface FileClipRequest {
  paths: string[]
  op: 'copy' | 'cut'
}

/** `clip:changed` — pushed to EVERY window after every clipboard change: how many, and which verb; null when empty (the menu's disabled "Paste"). */
export type FileClipState = { count: number; op: 'copy' | 'cut' } | null

/** Paste the clipboard INTO this folder (D5: a dir row → itself, a file row → its parent, blank space → the vault root). Must exist — never created. */
export interface PasteRequest {
  targetDir: string
}

/**
 * Per-entry outcome of a paste (D3): every clipboard entry lands in exactly one of the two
 * lists, in clipboard order — except a cut entry already in `targetDir`, which is skipped
 * silently (nothing to do). A copy that clashes takes Finder's next free name (`Note copy.md`,
 * `Note copy 2.md`; folders keep the whole name); a cut that clashes fails `ALREADY_EXISTS`.
 * A cut across volumes fails `IO_ERROR` ("cannot move across disks; copy it instead"); a
 * stale entry `NOT_FOUND`; a hidden source or a folder into itself `BAD_REQUEST`.
 */
export interface PasteResponse {
  pasted: { from: string; to: string; kind: 'file' | 'dir' }[]
  failed: { from: string; code: BridgeErrorCode; message: string }[]
}

// ---------- pickFolder() ----------

/**
 * Opens Electron's native open-directory dialog, parented to the calling window, and resolves
 * once the user picks a folder or cancels. Dialog failure → rejects `PICKER_FAILED`. One dialog
 * in flight per window: a call while that window's dialog is open resolves `{ cancelled: true }`.
 */
export type PickFolderResponse =
  | {
      /** Absolute path of the chosen folder, without trailing slash. */
      path: string
    }
  | {
      /** The user dismissed the dialog. */
      cancelled: true
    }

// ---------- dialog.openDrawing() ----------

/**
 * The native OPEN-FILE dialog, filtered to `.excalidraw`, parented to the calling window
 * (YAZ-1833). Same one-in-flight-per-window guard as `pickFolder()`, and the same
 * `{ cancelled: true }` answer for a dismissal.
 *
 * WHY IT ANSWERS THE BYTES AND NOT JUST A PATH: the file an import reaches for is by definition
 * OUTSIDE the vault, and the renderer has no door that reads an arbitrary absolute path. Rather
 * than opening one, the dialog reads what the user has just chosen — bounded by
 * `MAX_DRAWING_BYTES`, as `drawing:load` is — so the only foreign bytes that ever cross the bridge
 * are the ones a native dialog gesture asked for.
 */
export type OpenDrawingResponse =
  | {
      /** Absolute path of the chosen file. */
      path: string
      /** Its base name WITHOUT the `.excalidraw` extension — what an import names the component. */
      name: string
      /** Its UTF-8 bytes. */
      content: string
    }
  | {
      /** The user dismissed the dialog. */
      cancelled: true
    }

/**
 * The native SAVE dialog and the write behind it (🔒 YAZ-1775 D3, YAZ-1821): File › Export Drawing… writes
 * a standalone `.excalidraw` — every image embedded — somewhere the user picks, which is by
 * definition outside the vault. It is one door rather than "pick a path, then write it", because a
 * renderer holding an arbitrary absolute path it may write to is exactly what the fs layer's
 * root-relative rules exist to prevent: here the only path that is ever written is the one the
 * user just typed into a native sheet.
 */
export interface SaveDrawingRequest {
  /** The name the sheet opens on, extension included (`<board name>.excalidraw`). */
  defaultName: string
  /** The bytes to write, atomically (tmp + rename), once the user has picked. */
  content: string
}

export type SaveDrawingResponse =
  | {
      /** Absolute path of the file that was written. */
      path: string
    }
  | {
      /** The user dismissed the dialog; nothing was written. */
      cancelled: true
    }

/**
 * File › Export Image… for a draw.io diagram (🔒 YAZ-1802 D9): the same one-door rule as
 * `SaveDrawingRequest`. The sheet offers PNG and SVG, and the picked name's extension decides
 * which of the two pictures is written — so both arrive with the request, already drawn.
 */
export interface SaveImageRequest {
  /** The name the sheet opens on, extension included (`<board name>.png`). */
  defaultName: string
  /** The picture as a `data:image/png;base64,` URL. */
  png: string
  /** The same picture as a `data:image/svg+xml;base64,` URL. */
  svg: string
}

// ---------- watch(root, listener) ----------

/**
 * Delivered to the listener for as long as the subscription lives. A `ready` event is sent
 * once the watcher has completed its initial scan (at once for late joiners of a shared root).
 */
export type WatchEvent =
  | { type: 'ready'; root: string }
  | { type: 'add'; path: string; mtime: number }
  | { type: 'change'; path: string; mtime: number }
  | { type: 'unlink'; path: string }
  | { type: 'addDir'; path: string }
  | { type: 'unlinkDir'; path: string }
  | { type: 'error'; message: string }
