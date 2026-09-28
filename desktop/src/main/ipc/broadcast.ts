import { BrowserWindow } from 'electron'
import type { Push } from '@shared/ipc'
import { sendPush, type PushPayload } from './push'

/**
 * Sends a `CONTRACT` push (+ its payload) to every live window, whichever window — or main itself —
 * caused the change. Renderers filter by their own root where that matters (`favorites:changed`
 * carries the root for that; `state:changed` is everyone's).
 */
export function broadcastAll<T>(event: Push<T>, ...payload: PushPayload<T>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendPush(win.webContents, event, ...payload)
  }
}
