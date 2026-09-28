import { vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Envelope } from '@shared/ipc'

/** A registered door as a test calls it: the invoke event first, then the renderer's arguments. */
export type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

/** An `ipcMain.on` listener (the specials: watch, the flush ack). */
export type Listener = (event: unknown, ...args: unknown[]) => void | Promise<void>

/** The handler `door` registered on the mocked `ipcMain.handle` — every IPC test mocks `electron`. */
export function registered(door: { channel: string }): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === door.channel)
  if (call === undefined) throw new Error(`no handler registered for ${door.channel}`)
  return call[1] as unknown as Handler
}

/** The listener registered for a special `channel` on the mocked `ipcMain.on`. */
export function listener(channel: string): Listener {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no listener registered for ${channel}`)
  return call[1] as unknown as Listener
}
