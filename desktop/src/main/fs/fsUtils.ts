import { randomBytes } from 'node:crypto'
import { open, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { BoardMeta, BridgeError, TreeNode } from '@shared/types'
import { fileKind, isBoard, isDrawing } from '@shared/fileKind'
import { byName } from '@shared/treeSort'
import { ASSETS_DIR } from '@shared/drawingAssets'
import { readBoardHead } from './boardHead'

/**
 * Thrown by the fs layer; `ipc/envelope.ts` turns it into the `BridgeError` the renderer sees.
 * Carries a `BridgeError` code plus the optional `path` / `mtime` the renderer shows.
 */
export class BridgeFailure extends Error {
  readonly path?: string
  /** Current on-disk mtime; only on `CONFLICT`. */
  readonly mtime?: number
  constructor(
    readonly code: BridgeError['code'],
    message: string,
    extra: { path?: string; mtime?: number } = {},
  ) {
    super(message)
    this.path = extra.path
    this.mtime = extra.mtime
  }
}

function isSafeAbsPath(p: unknown): p is string {
  return typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0')
}

/** Validates + normalises a path argument, throwing BAD_REQUEST / NOT_ABSOLUTE when missing/relative. */
export function requireAbsPath(p: unknown, param: string): string {
  if (p === undefined || p === '') {
    throw new BridgeFailure('BAD_REQUEST', `missing '${param}'`)
  }
  if (!isSafeAbsPath(p)) {
    throw new BridgeFailure('NOT_ABSOLUTE', `'${param}' must be an absolute path`, { path: String(p) })
  }
  return path.resolve(p)
}

/** Throws unless `p` is an Excalidraw drawing — the kind the Import / Export Drawing dialogs take (🔒 YAZ-1802 D2). */
export function requireDrawingFile(p: string): void {
  if (!isDrawing(p)) throw new BridgeFailure('UNSUPPORTED_EXTENSION', 'only .excalidraw files are editable', { path: p })
}

/** Dot-entries and node_modules are invisible to every call. */
export function isSkipped(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}

/**
 * Every regular file in a vault, depth-first — the ONE walk Settings › Storage's two jobs share
 * (YAZ-1801: `git/storage.ts` measures, `fs/shrink.ts` rewrites), so they can never disagree about
 * which files are the vault's. Dot-entries and `node_modules` are invisible (`isSkipped`); an
 * unreadable folder is an empty one. `inAssets` marks the TOP-LEVEL `assets/` store only (🔒
 * YAZ-1775 D3) — a user's own `assets` folder deeper down is theirs.
 */
export async function* vaultFiles(root: string): AsyncGenerator<{ full: string; name: string; inAssets: boolean }> {
  const stack: Array<{ dir: string; inAssets: boolean }> = [{ dir: root, inAssets: false }]
  while (stack.length > 0) {
    const { dir, inAssets } = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (isSkipped(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push({ dir: full, inAssets: inAssets || (dir === root && e.name === ASSETS_DIR) })
      else if (e.isFile()) yield { full, name: e.name, inAssets }
    }
  }
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined
}

/** Maps a Node fs error to a BridgeFailure for `p`. */
export function toBridgeFailure(err: unknown, p: string): BridgeFailure {
  if (err instanceof BridgeFailure) return err
  switch (errnoCode(err)) {
    case 'ENOENT':
      return new BridgeFailure('NOT_FOUND', 'path does not exist', { path: p })
    case 'EACCES':
    case 'EPERM':
      return new BridgeFailure('FORBIDDEN', 'permission denied', { path: p })
    case 'ENOTDIR':
      return new BridgeFailure('NOT_A_DIRECTORY', 'expected a directory', { path: p })
    case 'EEXIST':
      return new BridgeFailure('ALREADY_EXISTS', 'path already exists', { path: p })
    case 'EISDIR':
      return new BridgeFailure('NOT_A_FILE', 'expected a file', { path: p })
    default:
      return new BridgeFailure('IO_ERROR', err instanceof Error ? err.message : String(err), { path: p })
  }
}

/** Runs `fn`, converting any fs error into a BridgeFailure attributed to `p`. */
export async function fsCall<T>(p: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toBridgeFailure(err, p)
  }
}

/** Throws NOT_FOUND / FORBIDDEN / NOT_A_DIRECTORY unless `dir` is a readable directory. */
export async function requireDir(dir: string): Promise<void> {
  await fsCall(dir, async () => {
    if (!(await stat(dir)).isDirectory()) throw new BridgeFailure('NOT_A_DIRECTORY', 'expected a directory', { path: dir })
  })
}

/**
 * A board's dates and stat in one open — a drawing's JSON block or a diagram's `<mxfile>`
 * attributes (🔒 YAZ-1802 D7) — or just the stat of any other file. A board that
 * cannot be OPENED (EACCES, say) is still a board: it falls back to the stat, so it is listed
 * without dates rather than dropped (🔒 YAZ-1834 D7 — no metadata is never no board).
 */
async function fileHead(full: string): Promise<{ meta: BoardMeta | null; mtime: number; size: number }> {
  const head = isBoard(full) ? await readBoardHead(full).catch(() => null) : null
  if (head === null) {
    const st = await stat(full)
    return { meta: null, mtime: st.mtimeMs, size: st.size }
  }
  const { block, mtime, size } = head
  return { meta: block === null ? null : { createdAt: block.createdAt, updatedAt: block.updatedAt }, mtime, size }
}

/**
 * Recursive tree of every regular file under `dir`, each carrying its preview `kind` (`null` = no
 * in-app viewer, YAZ-1577 D1). Dirs first, then files, each sorted case-insensitively; every dir
 * shows even when empty, so freshly created folders are visible (GRO-2022 D1). Dot-entries and
 * `node_modules` are skipped; unreadable subdirs are skipped. A drawing also carries `meta`, its
 * `yaseendraw` block read off the file head in the same open as its stat (🔒 YAZ-1834 D6) — one
 * open+read per drawing instead of one stat, measured fine on the 63-board stress vault (1834D);
 * a board without a trustworthy block simply has none.
 */
export async function buildTree(dir: string): Promise<TreeNode[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs: TreeNode[] = []
  const files: TreeNode[] = []
  await Promise.all(
    entries.map(async (e) => {
      if (isSkipped(e.name)) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        const children = await buildTree(full).catch(() => null)
        if (children !== null) dirs.push({ type: 'dir', name: e.name, path: full, children })
      } else if (e.isFile()) {
        const head = await fileHead(full).catch(() => null)
        if (head) files.push({ type: 'file', name: e.name, path: full, size: head.size, mtime: head.mtime, kind: fileKind(e.name), ...(head.meta ? { meta: head.meta } : {}) })
      }
    }),
  )
  return [...dirs.sort(byName), ...files.sort(byName)]
}

/**
 * Writes `content` and fsyncs it before closing (YAZ-2073 D12; libuv issues F_FULLFSYNC on macOS): the
 * bytes are on disk before anything — a rename, a board naming an asset — points at them, so a power
 * loss can't surface an empty or stale file under the real name. `mode` applies from creation.
 * A string lands as UTF-8; bytes (a scene's images through `drawing:save`, 🔒 YAZ-1775 D3) land verbatim —
 * `writeFile` ignores the encoding for a view, so one call serves both.
 */
export async function writeDurable(file: string, content: string | Uint8Array, flag: 'w' | 'wx', mode?: number): Promise<void> {
  const fh = await open(file, flag, mode)
  try {
    await fh.writeFile(content, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** The sibling a write lands in before it takes `file`'s name — same dir, so a rename or link is atomic. */
export function tmpSibling(file: string): string {
  return `${file}.tmp-${randomBytes(6).toString('hex')}`
}

/** Writes `content` durably to `tmpSibling(file)` then renames over `file`. Parent dir must exist. */
export async function atomicWrite(file: string, content: string | Uint8Array, mode?: number): Promise<{ mtime: number; size: number }> {
  const tmp = tmpSibling(file)
  try {
    await writeDurable(tmp, content, 'w', mode)
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
  const st = await stat(file)
  return { mtime: st.mtimeMs, size: st.size }
}

/** Whether `name` is a `tmpSibling` — `atomicWrite`'s or `landAssets`' own tmp file, which no watcher ever announces (YAZ-2073 5F). */
export const isAtomicTmp = (name: string): boolean => /\.tmp-[0-9a-f]{12}$/.test(name)
