import { shell } from 'electron'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { DeleteResponse } from '@shared/types'
import { BridgeFailure, fsCall, isSkipped, requireAbsPath } from './fsUtils'

/**
 * In-app delete (GRO-2272 — decision A, LOCKED): the entry moves to the SYSTEM TRASH.
 *
 * `shell.trashItem` and nothing else. There is deliberately NO `fs.rm` anywhere in this
 * module, and no permanent-delete fallback when the trash call fails: a filesystem with no
 * Trash (a network volume, some external drives) is exactly the situation where the user's
 * recovery story has just disappeared, so destroying the file instead would hand them the
 * opposite of what they asked for. A failed trash refuses loudly (`IO_ERROR`) and leaves the
 * entry untouched on disk. `remove.test.ts` asserts the file survives, which is what stops a
 * future "helpful" fallback being added.
 *
 * Guards mirror `rename.ts` where they transfer, and only where they transfer:
 *  - entries the tree/index/watcher hide (dot-entries like `.yaseendraw` / `.obsidian` /
 *    `.trash`, and `node_modules`) are invisible infrastructure, so deleting one through a UI
 *    that never showed it is refused (`BAD_REQUEST`). The check reuses `isSkipped` rather than
 *    testing for a leading dot, so this guard cannot drift from the rule that justifies it;
 *  - the extension-kind rules do NOT apply (nothing is being renamed), and deletion is not
 *    restricted to the supported-file discovery set: the tree shows EVERY folder regardless of
 *    what is inside it, so every folder must be deletable;
 *  - the calling window's own vault root is refused upstream in `ipc/fs.ts`, which is the
 *    only layer that knows who is calling — same split as rename.
 *
 * `shell.trashItem` is a MOVE at the filesystem layer, so the shared watcher emits a normal
 * `unlink` (files) or `unlinkDir` + one `unlink` per descendant (folders) — verified in the
 * GRO-2275 scope pass and pinned by `watchConformance.test.ts` (YAZ-2073 5F). The tree therefore heals itself
 * and needs no push, exactly as rename relies on.
 */
export async function removeEntry(req: unknown): Promise<DeleteResponse> {
  if (typeof req !== 'object' || req === null) throw new BridgeFailure('BAD_REQUEST', 'request must be an object')
  const p = requireAbsPath((req as Record<string, unknown>).path, 'path')
  return fsCall(p, async () => {
    const src = await stat(p) // missing → ENOENT → NOT_FOUND
    const kind = src.isDirectory() ? ('dir' as const) : ('file' as const)
    // `isSkipped`, not a bare dot check: it is the SAME definition of "invisible" the tree,
    // index and watcher use (dot-entries AND node_modules), so the guard cannot drift from the
    // thing it is justified by — nothing the UI never showed can be deleted through it.
    if (isSkipped(path.basename(p))) {
      throw new BridgeFailure('BAD_REQUEST', 'hidden entries cannot be deleted', { path: p })
    }
    // Electron resolves trashItem() and rejects on failure; either way nothing else runs here.
    await shell.trashItem(p)
    return { path: p, kind }
  })
}
