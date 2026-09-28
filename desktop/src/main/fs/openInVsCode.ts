import { shell } from 'electron'
import { stat } from 'node:fs/promises'
import type { RevealResponse } from '@shared/types'
import { fsCall, requireAbsPath } from './fsUtils'
import { requireObject } from './validate'

/**
 * Open in VS Code (YAZ-963) — `reveal.ts`'s mirror, deliberately the same shape.
 *
 * `shell.openExternal('vscode://file/<path>')` — the OS URL handler decides WHICH VS Code
 * answers (Stable, Insiders, a fork registered for the scheme), so this app never spawns a
 * process (LOCKED). A spawn would have to know the install's binary location or find `code` on
 * a PATH the packaged app does not have, would hand the editor this process' environment, and
 * would fail differently on every machine; a deep link couples to nothing but the scheme. That
 * VS Code is installed at all is never asserted — an unhandled scheme is the OS' business,
 * exactly as it is for the `yaseendraw://` links this app itself registers.
 *
 * Every path SEGMENT is percent-encoded, separators left literal: `My Board.excalidraw` makes an
 * invalid URL raw, and encoding the whole path in one go would eat the `/` along with the spaces.
 *
 * The stat is the same load-bearing check `reveal.ts` explains: a dead `vscode://` URL opens an
 * empty editor rather than reporting anything, so a stale row (deleted or moved externally) must
 * surface `NOT_FOUND` for the caller's passive notice. Read-only like reveal, so no dot-entry
 * and no extension guard — file, folder and vault root alike, and what opening a FOLDER means is
 * VS Code's decision, not this menu's.
 *
 * `RevealResponse` rather than a twin type: the shape is the same echoed path.
 */
export async function openInVsCode(req: unknown): Promise<RevealResponse> {
  const p = requireAbsPath(requireObject(req).path, 'path')
  return fsCall(p, async () => {
    await stat(p) // missing → ENOENT → NOT_FOUND, so a stale row can be reported
    await shell.openExternal(`vscode://file${p.split('/').map(encodeURIComponent).join('/')}`)
    return { path: p }
  })
}
