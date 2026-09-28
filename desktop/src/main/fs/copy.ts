import { cp, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PasteResponse, RenameFileResponse } from '@shared/types'
import { isWithin } from '@shared/paths'
import type { FileClip } from '../fileClip'
import { BridgeFailure, fsCall, isSkipped, requireDir, toBridgeFailure } from './fsUtils'
import { requireAbsPath, requireObject } from './validate'

/** One entry that landed: the shape `PasteResponse.pasted` carries. */
type PastedEntry = PasteResponse['pasted'][number]

/**
 * Finder's clash rule (YAZ-1674, D3): `Note.md` → `Note copy.md` → `Note copy 2.md` → … The
 * name itself is returned when nothing sits at `dir/name`. Files split at the LAST extension
 * (`archive.tar.gz` → `archive.tar copy.gz`, exactly Finder); folders keep the whole name
 * (`Notes` → `Notes copy`) — a dot in a folder name is not an extension. A source that already
 * ends in ` copy` / ` copy N` counts on from N rather than becoming `Note copy copy.md`, which is
 * also Finder. Existence is asked of the filesystem per candidate (a `stat`), so a case-insensitive
 * volume answers case-insensitively — the same answer `fs.cp`'s `errorOnExist` would give.
 */
export async function freeName(dir: string, name: string, kind: 'file' | 'dir'): Promise<string> {
  return fsCall(dir, async () => {
    const taken = async (candidate: string) => (await stat(path.join(dir, candidate)).catch(() => null)) !== null
    if (!(await taken(name))) return name
    const ext = kind === 'file' ? path.extname(name) : ''
    const stem = name.slice(0, name.length - ext.length)
    const m = /^(.*) copy(?: (\d+))?$/.exec(stem)
    const base = m === null ? stem : m[1]
    let n = m === null ? 1 : Number(m[2] ?? '1') + 1
    for (;;) {
      const candidate = `${base} copy${n === 1 ? '' : ` ${n}`}${ext}`
      if (!(await taken(candidate))) return candidate
      n += 1
    }
  })
}

/**
 * Copies one entry INTO `toDir` under a free name (YAZ-1674, D4). `fs.cp` with `recursive` (a
 * folder comes whole — hidden dirs inside it included, exactly what Finder would carry),
 * `errorOnExist` + `force: false` (never overwrites: the free name is pre-picked, and a racer
 * landing on it in between still gets `ALREADY_EXISTS`, not a clobber) and `preserveTimestamps`
 * (bytes AND mtimes faithful). Copying into the entry's OWN folder is Duplicate for free.
 *
 * Guards borrowed from rename/remove, and only where they transfer: a source the tree hides
 * (`isSkipped`: dot-entries, node_modules) is refused `BAD_REQUEST` — the UI never showed it,
 * so it cannot be copied through the UI; a folder into itself or a descendant is refused
 * `BAD_REQUEST` (an infinite copy); a missing source is `NOT_FOUND`. The target folder is
 * `pasteEntries`'s to check (ONE door: it is this function's only production caller). No
 * extension rules: nothing is renamed, the copy keeps its name and kind.
 *
 * Nothing downstream: no store repair (nothing moved or went) and no push (the watcher's
 * `add`/`addDir` echo fills the tree, and the client refreshes anyway — idempotent).
 * NOT in v1: carrying assets/images/drawings across vaults, link rewriting on copy.
 */
export async function copyEntry(from: unknown, toDir: unknown): Promise<PastedEntry> {
  const src = requireAbsPath(from, 'from')
  const dir = requireAbsPath(toDir, 'toDir')
  return fsCall(src, async () => {
    const st = await stat(src) // missing source → ENOENT → NOT_FOUND
    const kind = st.isDirectory() ? ('dir' as const) : ('file' as const)
    // `isSkipped`, not a bare dot check — the SAME definition of "invisible" the tree, index and
    // watcher use, so the guard cannot drift from the rule that justifies it (remove.ts's posture).
    if (isSkipped(path.basename(src))) throw new BridgeFailure('BAD_REQUEST', 'hidden entries cannot be copied', { path: src })
    if (kind === 'dir' && isWithin(src, dir)) {
      throw new BridgeFailure('BAD_REQUEST', 'a folder cannot be copied inside itself', { path: dir })
    }
    const to = path.join(dir, await freeName(dir, path.basename(src), kind))
    // An errno from the copy itself belongs to the TARGET (EEXIST → ALREADY_EXISTS on `to`).
    await fsCall(to, () => cp(src, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true }))
    return { from: src, to, kind }
  })
}

/** The two disk verbs a paste is made of; `ipc/fs.ts` hands in the production pair (copyEntry, and rename + its store/broadcast downstream). */
export interface PasteOps {
  copy: (from: string, toDir: string) => Promise<PastedEntry>
  move: (from: string, to: string) => Promise<RenameFileResponse>
}

/** Node's errno for a rename across volumes, whether raw or already carried through `fsCall`'s IO_ERROR mapping (its message keeps the `EXDEV:` prefix). */
function isCrossDevice(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EXDEV') return true
  return err instanceof BridgeFailure && err.code === 'IO_ERROR' && err.message.startsWith('EXDEV')
}

/** One `PasteResponse.failed` row for `from`: a `BridgeFailure` keeps its code; a raw errno maps like every other fs error; anything else is IO_ERROR. */
function failureOf(from: string, err: unknown): PasteResponse['failed'][number] {
  if (isCrossDevice(err)) return { from, code: 'IO_ERROR', message: 'cannot move across disks; copy it instead' }
  const f = toBridgeFailure(err, from)
  // CONFLICT is a write-only code (mtime races); a copy or move can never raise it.
  return { from, code: f.code === 'CONFLICT' ? 'IO_ERROR' : f.code, message: f.message }
}

/**
 * Pastes the clipboard INTO `req.targetDir` (YAZ-1674, D2/D3): entries in the clipboard's ORDER,
 * one row per entry in `pasted` or `failed`, and one bad entry never stops the rest. Only the
 * target itself is a whole-call failure — it must be absolute, exist and be a folder (`NOT_FOUND`
 * / `NOT_A_DIRECTORY`, attributed to it); it is never created.
 *
 * `copy` → `ops.copy(from, targetDir)` (a clash takes the next free name, D3).
 * `cut` → `ops.move(from, targetDir/basename)`: the EXISTING rename pipeline per entry, so a
 * clash is `ALREADY_EXISTS` (never overwrites) and an entry already IN the target folder is
 * skipped silently — drag-drop's "nothing to do" — neither pasted nor failed. A rename across
 * volumes (`EXDEV`) is not a move `fs.rename` can make; that entry fails `IO_ERROR` with
 * "cannot move across disks; copy it instead" rather than a copy-then-delete the user did not ask for.
 */
export async function pasteEntries(clip: FileClip, req: unknown, ops: PasteOps): Promise<PasteResponse> {
  const targetDir = requireAbsPath(requireObject(req).targetDir, 'targetDir')
  await requireDir(targetDir)
  const pasted: PasteResponse['pasted'] = []
  const failed: PasteResponse['failed'] = []
  for (const from of clip.paths) {
    try {
      if (clip.op === 'cut') {
        if (path.dirname(from) === targetDir) continue // already here: nothing to do (D2)
        const r = await ops.move(from, path.join(targetDir, path.basename(from)))
        pasted.push({ from: r.oldPath, to: r.newPath, kind: r.kind })
      } else {
        pasted.push(await ops.copy(from, targetDir))
      }
    } catch (err) {
      failed.push(failureOf(from, err))
    }
  }
  return { pasted, failed }
}
