/**
 * The drawing document's IPC (🔒 YAZ-1810): `fs/drawing.ts` behind the standard envelope, and
 * nothing else.
 *
 * NO STORE REPAIR AND NO BROADCAST: repair and the pushes exist for paths that MOVE or GO, and a
 * save does neither — it changes bytes at a path every
 * window already knows. A window with the same document open learns of the change from the
 * shared watcher, like any edit made outside the app, and decides for itself (reload when clean,
 * the conflict bar when dirty). One writer telling the others what to think would be a second,
 * competing truth about a file the disk already answers for.
 *
 * THE ORPHAN SWEEP (🔒 YAZ-1775 D3, YAZ-1811) is not an IPC of its own. `ipc/fs.ts` calls
 * `sweepVaultOnce` after answering the FIRST `fs:tree` for a root in this session — the moment a
 * vault is "opened" — DETACHED, so the tree answer never waits on it, and its result rides the
 * requesting window's existing passive notice channel ("Cleaned N unused images"), and only when
 * it actually did something. Silence is the right report for a sweep that found nothing.
 */
import path from 'node:path'
import { shell, type WebContents } from 'electron'
import { CONTRACT } from '@shared/ipc'
import { sweepOrphanAssets } from '../drawings/orphanSweep'
import { createThumbs, THUMBS_DIR } from '../drawings/thumbs'
import { loadDrawing, saveDrawing } from '../fs/drawing'
import { resolveLibraryFolder } from '../library/folder'
import type { Store } from '../store'
import { handle } from './envelope'

export function registerDrawingIpc(store: Store, userData: string): void {
  // A preview's pictures come back preview-sized, cached under userData — never in the vault (🔒 YAZ-2073 D6).
  const thumbs = createThumbs(path.join(userData, THUMBS_DIR))
  handle(CONTRACT.drawing.load, (req) => loadDrawing(req, thumbs))
  handle(CONTRACT.drawing.save, saveDrawing)
  // 🔒 YAZ-1775 D5: read-only and store-backed — the setting is the renderer's to WRITE (through
  // `state:set-settings`, like every other setting); this only says where it points.
  handle(CONTRACT.drawing.libraryFolder, async () => resolveLibraryFolder(store.get().settings.libraryFolder, userData))
}

/** Roots swept in this process's life — the "first opened in a session" guard. */
const swept = new Set<string>()

/** Test hook: forget every sweep so a root can be swept again. */
export function _resetSweeps(): void {
  swept.clear()
}

/**
 * Sweep `root` once per session, detached, and tell `sender` what happened. `trash` and `now`
 * are the real ones unless a test injects stand-ins.
 *
 * The guard is claimed BEFORE the async work starts: two windows opening the same vault in the
 * same tick must not both walk it. The returned promise settles when this call's sweep (and its
 * notice) is done — the app never awaits it; tests do, instead of guessing how long a walk takes.
 */
export function sweepVaultOnce(root: string, sender: Pick<WebContents, 'isDestroyed' | 'send'>, deps: { trash?: (p: string) => Promise<void>; now?: () => number } = {}): Promise<void> {
  if (swept.has(root)) return Promise.resolve()
  swept.add(root)
  return sweepOrphanAssets(root, { now: deps.now ?? Date.now, trash: deps.trash ?? ((p) => shell.trashItem(p)) }).then((n) => {
    if (n === 0) return
    const message = `Cleaned ${n} unused ${n === 1 ? 'image' : 'images'}`
    console.log(`[drawing] ${message} in ${root}`)
    // The window that asked for the tree may have closed while the vault was being walked.
    if (!sender.isDestroyed()) sender.send(CONTRACT.link.onNotice.channel, message)
  })
}
