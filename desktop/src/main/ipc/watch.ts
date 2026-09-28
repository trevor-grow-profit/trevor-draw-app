import { ipcMain, type IpcMainEvent } from 'electron'
import type { WatchEvent } from '@shared/types'
import { isRecord } from '@shared/guards'
import { SPECIAL } from '@shared/ipc'
import { requireDir, toBridgeFailure } from '../fs/fsUtils'
import { requireAbsPath } from '../fs/validate'
import { subscribe } from '../fs/watchers'

/** Live subscriptions per renderer (`webContents.id`) → subscription id → unsubscribe. */
const bySender = new Map<number, Map<string, () => void>>()
/**
 * Subscribe ids still checking their root, per sender. An unsubscribe in that gap drops the id here,
 * so the late subscribe registers nothing instead of leaking a watcher for the window's life (YAZ-2073 2C).
 */
const pending = new Map<number, Set<string>>()

/**
 * `window.yaseenDraw.watch(root, listener)`: the preload sends `{ id, root }`, main answers every
 * event as `watch:event { id, ev }` on that sender. One watcher per root (see `fs/watchers.ts`)
 * no matter how many windows or subscriptions; a window going away drops all of its subscriptions.
 */
export function registerWatchIpc(): void {
  ipcMain.on(SPECIAL.watchSubscribe, (e, msg: unknown) => onSubscribe(e, msg))
  ipcMain.on(SPECIAL.watchUnsubscribe, (e, id: unknown) => onUnsubscribe(e, id))
}

async function onSubscribe(e: IpcMainEvent, msg: unknown): Promise<void> {
  if (!isRecord(msg)) return
  const { id, root } = msg
  if (typeof id !== 'string') return
  const { sender } = e
  // A watcher event can land between the window closing and its `destroyed` hook running.
  const send = (ev: WatchEvent) => {
    if (!sender.isDestroyed()) sender.send(SPECIAL.watchEvent, { id, ev })
  }
  let checking = pending.get(sender.id)
  if (checking === undefined) pending.set(sender.id, (checking = new Set()))
  checking.add(id)
  let dir: string
  try {
    dir = requireAbsPath(root, 'root')
    await requireDir(dir)
  } catch (err) {
    // A bad root is the whole answer: one error event, no subscription.
    if (settle(sender.id, id)) send({ type: 'error', message: toBridgeFailure(err, String(root)).message })
    return
  }
  if (!settle(sender.id, id) || sender.isDestroyed()) return
  let subs = bySender.get(sender.id)
  if (subs === undefined) {
    subs = new Map()
    bySender.set(sender.id, subs)
    sender.once('destroyed', () => {
      bySender.get(sender.id)?.forEach((off) => off())
      bySender.delete(sender.id)
    })
  }
  subs.set(id, subscribe(dir, send))
}

/** Ends `id`'s root check; false when it was unsubscribed meanwhile. */
function settle(senderId: number, id: string): boolean {
  const checking = pending.get(senderId)
  const live = checking?.delete(id) === true
  if (checking?.size === 0) pending.delete(senderId)
  return live
}

function onUnsubscribe(e: IpcMainEvent, id: unknown): void {
  if (typeof id !== 'string') return
  if (pending.get(e.sender.id)?.delete(id)) return
  const subs = bySender.get(e.sender.id)
  const off = subs?.get(id)
  if (subs === undefined || off === undefined) return
  subs.delete(id)
  off()
}
