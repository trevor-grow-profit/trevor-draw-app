import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BridgeError } from '@shared/types'
import type { Envelope, Invoke } from '@shared/ipc'
import { BridgeFailure } from '../fs/fsUtils'

/** The plain data the renderer rejects with: a `BridgeFailure`'s fields, anything else as IO_ERROR. */
export function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeFailure) {
    const out: BridgeError = { code: err.code, message: err.message }
    if (err.path !== undefined) out.path = err.path
    if (err.mtime !== undefined) out.mtime = err.mtime
    return out
  }
  return { code: 'IO_ERROR', message: err instanceof Error ? err.message : String(err) }
}

/** A door's arguments as main receives them: its arity, each one `unknown` until the handler has checked it. */
type Unchecked<A extends unknown[]> = { [K in keyof A]: unknown }

/**
 * `ipcMain.handle` for one `CONTRACT` door, with the envelope the preload unwraps: Electron strips
 * custom props from a thrown Error, so a structured `BridgeError` has to travel as a resolved value.
 * `fn` gets the invoke event first (for handlers that need the calling window, e.g. the folder
 * dialog). The arguments arrive from a renderer, so `fn` sees them as `unknown` and validates them;
 * only the answer is typed from the table.
 */
export function handleWithEvent<A extends unknown[], T>(door: Invoke<A, T>, fn: (e: IpcMainInvokeEvent, ...args: Unchecked<A>) => Promise<T>): void {
  ipcMain.handle(door.channel, async (e, ...args: unknown[]): Promise<Envelope<T>> => {
    try {
      return { ok: true, value: await fn(e, ...(args as Unchecked<A>)) }
    } catch (err) {
      return { ok: false, error: toBridgeError(err) }
    }
  })
}

/** `handleWithEvent` for the common case: the handler only needs the renderer's arguments. */
export function handle<A extends unknown[], T>(door: Invoke<A, T>, fn: (...args: Unchecked<A>) => Promise<T>): void {
  handleWithEvent(door, (_e, ...args: Unchecked<A>) => fn(...args))
}
