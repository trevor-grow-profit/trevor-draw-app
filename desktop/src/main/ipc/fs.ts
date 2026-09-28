import path from 'node:path'
import { CONTRACT } from '@shared/ipc'
import * as favorites from '../favorites'
import { fileClip } from '../fileClip'
import { copyEntry, pasteEntries } from '../fs/copy'
import { createDir, createFile } from '../fs/create'
import { BridgeFailure } from '../fs/fsUtils'
import { openInDefaultApp } from '../fs/openDefault'
import { openInVsCode } from '../fs/openInVsCode'
import { renameFile } from '../fs/rename'
import { removeEntry } from '../fs/remove'
import { revealItem } from '../fs/reveal'
import { tree } from '../fs/tree'
import { repairShares, shareFsHooks } from '../share/fsHooks'
import { sweepVaultOnce } from './drawing'
import { openRoots, type Store } from '../store'
import type { WindowLookup } from '../windows'
import { broadcastAll } from './broadcast'
import { handle, handleWithEvent } from './envelope'

/**
 * The favorites.json repair (YAZ-1766 6A, D13) rides the SAME handlers as the store repair below,
 * but never fails the file op or skips the broadcast: a corrupt or unwritable favorites.json is
 * warned about and the rename/delete stands.
 */
const repairFavorites = (p: Promise<void>): Promise<void> => p.catch((err: unknown) => console.warn(`[favorites] repair failed: ${String(err)}`))

/** The fs half of `window.yaseenDraw` (`dialog:pick-folder` lives in `./dialog`). */
export function registerFsIpc(store: Store, windows: WindowLookup): void {
  // The tree, plus the one-per-session orphan sweep of this vault's image store (🔒 YAZ-1775 D3,
  // YAZ-1811). The first `fs:tree` for a root IS "the vault was opened", and it is the only
  // moment that means that without inventing a second signal for it. The sweep is detached: the
  // tree answers immediately, and its own notice reaches the asking window later, if at all.
  handleWithEvent(CONTRACT.tree, async (e, root: string) => {
    const res = await tree(root)
    void sweepVaultOnce(res.root, e.sender)
    return res
  })
  handle(CONTRACT.createDir, createDir)
  handle(CONTRACT.createFile, createFile)
  // Reveal in Finder (GRO-2274): read-only, so no store repair and no broadcast — but still
  // enveloped like every other handler so a stale row's NOT_FOUND reaches the renderer as a
  // passive notice instead of vanishing (showItemInFolder is silent on a missing path).
  handle(CONTRACT.shell.reveal, revealItem)
  // Open in VS Code (YAZ-963): reveal's twin in every respect — read-only, nothing to repair,
  // nothing to broadcast, and enveloped for the same NOT_FOUND notice.
  handle(CONTRACT.shell.openVsCode, openInVsCode)
  // Open in default app (YAZ-1577): third of the read-only OS verbs — same envelope, same NOT_FOUND notice.
  handle(CONTRACT.shell.openDefault, openInDefaultApp)
  // In-app rename/move (Links E1 GRO-2194, E1b GRO-2241). The SAME handler repairs the
  // store — every stored path at or under the renamed entry follows (window roots/files/
  // tabs, recents, folder state) — and then pushes `file:renamed` to EVERY window so open
  // tabs remap in place (a `dir` event remaps by prefix). The tree needs no push: the shared
  // watcher's unlink+add echo already heals it (no double-processing).
  handleWithEvent(CONTRACT.file.rename, async (e, req: unknown) => {
    // E1b: the calling window's own vault ROOT cannot be renamed — root identity is a
    // recents/vault-management question (which recents entry follows, what this window's
    // identity then means), out of E1b's scope. ANOTHER window rooted at a subfolder of
    // this vault is fine: `store.renamePath` below remaps its `WindowEntry.root`.
    const oldPath = typeof (req as { oldPath?: unknown } | null)?.oldPath === 'string' ? path.resolve((req as { oldPath: string }).oldPath) : null
    const senderId = windows.idFor(e.sender)
    const senderRoot = store.get().windows.find((w) => w.id === senderId)?.root
    if (oldPath !== null && senderRoot != null && senderRoot === oldPath) {
      throw new BridgeFailure('BAD_REQUEST', 'the vault root itself cannot be renamed', { path: oldPath })
    }
    const res = await renameFile(req)
    store.renamePath(res.oldPath, res.newPath)
    await repairFavorites(favorites.renamePath(openRoots(store.get()), res.oldPath, res.newPath))
    // YAZ-1799: a shared board's link follows it (shares.json key rewritten, same id).
    await repairShares(shareFsHooks.renamed(openRoots(store.get()), res.oldPath, res.newPath))
    broadcastAll(CONTRACT.file.onRenamed, { oldPath: res.oldPath, newPath: res.newPath, kind: res.kind })
    return res
  })
  // In-app delete (GRO-2272). Deliberately the SAME shape as the rename handler above —
  // fs work, then `store.removePath` repair, then one broadcast to every window — with two
  // differences that are the point of the feature:
  //  - it REMOVES rather than remaps, so a window whose active file went is left on an heir
  //    tab (store.removePath picks it with the workspace's own ladder);
  //  - nothing downstream rewrites references to the deleted file; other drawings keep theirs.
  // Like rename, the tree needs no push: the watcher's unlink / unlinkDir echo heals it
  // (verified empirically in the GRO-2275 scope pass — trashItem is a MOVE at the fs layer,
  // so the watcher reports it exactly like any other move out of the root).
  handleWithEvent(CONTRACT.file.delete, async (e, req: unknown) => {
    // The calling window's own vault ROOT cannot be deleted — same reasoning and the same
    // sender lookup as rename: root identity is a recents/vault-management question. ANOTHER
    // window rooted inside the deleted folder IS allowed; it falls through to that window's
    // existing onRootMissing probe, which also drops the dead MRU entry.
    const target = typeof (req as { path?: unknown } | null)?.path === 'string' ? path.resolve((req as { path: string }).path) : null
    const senderId = windows.idFor(e.sender)
    const senderRoot = store.get().windows.find((w) => w.id === senderId)?.root
    if (target !== null && senderRoot != null && senderRoot === target) {
      throw new BridgeFailure('BAD_REQUEST', 'the vault root itself cannot be deleted', { path: target })
    }
    const res = await removeEntry(req)
    store.removePath(res.path)
    await repairFavorites(favorites.removePath(openRoots(store.get()), res.path))
    // YAZ-1799: deleting a shared board (or a folder holding some) stops sharing them.
    await repairShares(shareFsHooks.deleted(openRoots(store.get()), res.path))
    broadcastAll(CONTRACT.file.onDeleted, { path: res.path, kind: res.kind })
    return res
  })
  // File clipboard (YAZ-1674, D1): the ONE app-wide clipboard lives in main (`fileClip`), so a
  // paste in any window takes what any window cut or copied — within a vault or across two.
  // Every change is pushed to EVERY window as `clip:changed` (the github status posture):
  // that is how a menu on vault B learns "Paste 3 items" after a cut on vault A.
  // Subscribed once for the process's life — `registerFsIpc` runs once, so there is nothing to unsubscribe.
  fileClip.onChange((state) => broadcastAll(CONTRACT.file.onClipChanged, state))
  // Cut / Copy is a pure clipboard write: nothing on disk is touched or even stat'ed, so there
  // is no store repair and no file push here — a path that goes stale before the paste is
  // reported per entry BY the paste. No vault-root guard either: Cut/Copy is offered on ROWS
  // only, never on blank space, and a window's own root is never a row of its tree (D5/D6).
  handle(CONTRACT.file.clip, async (req: unknown) => {
    fileClip.set(req)
  })
  // A window opened AFTER a clip missed the push: it reads the current state once on mount,
  // then `clip:changed` carries the rest (the same catch-up read `github.status` offers).
  handle(CONTRACT.file.clipState, async () => fileClip.state())
  // Paste (D2–D4). Per entry, in clipboard order, and one bad entry never stops the rest:
  //  - a COPY is `copyEntry` (fs.cp under Finder's next free name, D3/D4) with deliberately NO
  //    store repair and NO broadcast — nothing moved and nothing went, so there is nothing to
  //    remap or retire; the tree learns of the new entry from the watcher's add/addDir echo,
  //    exactly like any add made outside the app, and the client's refresh() is idempotent;
  //  - a CUT is the EXISTING rename pipeline above, verbatim — `renameFile`, then
  //    `store.renamePath`, then `file:renamed` to every window — once PER ENTRY, so open tabs
  //    on a moved file remap as they would for a drag-drop move. Across volumes `fs.rename`
  //    cannot move (EXDEV); that entry fails `IO_ERROR` rather than copy-then-delete.
  // A cut pastes ONCE: the clipboard clears when at least one entry landed (a cut whose every
  // entry failed stays, so the user can fix the cause and paste again); a copy is kept and
  // pastes again and again (D2).
  handle(CONTRACT.file.paste, async (req: unknown) => {
    const clip = fileClip.get()
    if (clip === null) throw new BridgeFailure('BAD_REQUEST', 'nothing to paste')
    const res = await pasteEntries(clip, req, {
      copy: copyEntry,
      move: async (from, to) => {
        const r = await renameFile({ oldPath: from, newPath: to })
        store.renamePath(r.oldPath, r.newPath)
        await repairFavorites(favorites.renamePath(openRoots(store.get()), r.oldPath, r.newPath))
        await repairShares(shareFsHooks.renamed(openRoots(store.get()), r.oldPath, r.newPath))
        broadcastAll(CONTRACT.file.onRenamed, { oldPath: r.oldPath, newPath: r.newPath, kind: r.kind })
        return r
      },
    })
    if (clip.op === 'cut' && res.pasted.length > 0) fileClip.clear()
    return res
  })
}
