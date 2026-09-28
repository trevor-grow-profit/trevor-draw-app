import type { Push } from '@shared/ipc'

/** A push's arguments after its channel: the payload, or nothing for a `void` push. */
export type PushPayload<T> = [T] extends [void] ? [] : [T]

/** What a push goes to: a window's `webContents`, or the `event.sender` that asked. */
export interface PushTarget {
  send(channel: string, ...args: unknown[]): void
}

/**
 * Sends a `CONTRACT` push (+ its payload) to ONE window — the menu's target, a link's window, the
 * window that asked; `broadcastAll` is the every-window twin. Electron-free, so the menu and the
 * window manager use it as they are. No target (no window at all) sends nothing.
 */
export function sendPush<T>(to: PushTarget | undefined, event: Push<T>, ...payload: PushPayload<T>): void {
  to?.send(event.channel, ...payload)
}
