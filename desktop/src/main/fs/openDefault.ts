import { shell } from 'electron'
import { stat } from 'node:fs/promises'
import type { RevealResponse } from '@shared/types'
import { BridgeFailure, fsCall, requireAbsPath } from './fsUtils'
import { requireObject } from './validate'

/**
 * Open in default app (YAZ-1577) — the third read-only OS verb beside `reveal` and `openInVsCode`,
 * deliberately the same shape: stat first so a stale row (deleted or moved externally) reports
 * `NOT_FOUND` for the caller's passive notice, no dot-entry and no extension guard. This is how a
 * file the app has no viewer for (`kind: null` in the tree) gets opened at all — the OS decides
 * which application, exactly as a Finder double-click would.
 *
 * `shell.openPath` differs from `openExternal` in one way that matters: it never throws, it
 * RETURNS the OS' message (`''` on success). That string is the whole error contract.
 */
export async function openInDefaultApp(req: unknown): Promise<RevealResponse> {
  const p = requireAbsPath(requireObject(req).path, 'path')
  return fsCall(p, async () => {
    await stat(p) // missing → ENOENT → NOT_FOUND, so a stale row can be reported
    const error = await shell.openPath(p)
    if (error !== '') throw new BridgeFailure('IO_ERROR', error, { path: p })
    return { path: p }
  })
}
