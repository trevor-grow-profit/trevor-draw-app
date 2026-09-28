import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Envelope, Invoke } from '@shared/ipc'
import { BridgeFailure } from '../fs/fsUtils'
import { handle, handleWithEvent, toBridgeError } from './envelope'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

/** The callback `handle` registered for `channel` with the mocked `ipcMain.handle`. */
function registered(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no handler registered for ${channel}`)
  return call[1] as unknown as Handler
}

/** A test-only door: `handle` needs only the channel at runtime. */
const door = <A extends unknown[], T>(channel: string): Invoke<A, T> => ({ kind: 'invoke', channel })

beforeEach(() => vi.mocked(ipcMain.handle).mockClear())

describe('handle', () => {
  it('wraps the resolved value in { ok: true, value } and forwards the args without the event', async () => {
    const fn = vi.fn(async (a: string, b: number) => `${a}:${b}`)
    handle(door('t:ok'), fn)
    expect(await registered('t:ok')({ sender: {} }, 'x', 2)).toEqual({ ok: true, value: 'x:2' })
    expect(fn).toHaveBeenCalledWith('x', 2)
  })

  it('a thrown BridgeFailure(CONFLICT, mtime) comes out as { ok: false, error: { code: CONFLICT, mtime } }', async () => {
    handle(door('t:conflict'), async () => {
      throw new BridgeFailure('CONFLICT', 'file changed on disk since last read', { path: '/v/a.md', mtime: 42 })
    })
    expect(await registered('t:conflict')({ sender: {} })).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'file changed on disk since last read', path: '/v/a.md', mtime: 42 },
    })
  })

  it('an unknown Error maps to IO_ERROR with its message', async () => {
    handle(door('t:boom'), async () => {
      throw new Error('boom')
    })
    expect(await registered('t:boom')({ sender: {} })).toEqual({ ok: false, error: { code: 'IO_ERROR', message: 'boom' } })
  })
})

describe('handleWithEvent', () => {
  it('passes the invoke event first, then the args, and wraps the result like handle', async () => {
    const fn = vi.fn(async (e: unknown, a: string) => `${(e as { sender: { id: number } }).sender.id}:${a}`)
    handleWithEvent(door('t:event'), fn)
    const event = { sender: { id: 7 } }
    expect(await registered('t:event')(event, 'x')).toEqual({ ok: true, value: '7:x' })
    expect(fn).toHaveBeenCalledWith(event, 'x')
  })

  it('maps a thrown BridgeFailure to an error envelope too', async () => {
    handleWithEvent(door('t:event-fail'), async () => {
      throw new BridgeFailure('PICKER_FAILED', 'no display')
    })
    expect(await registered('t:event-fail')({ sender: {} })).toEqual({ ok: false, error: { code: 'PICKER_FAILED', message: 'no display' } })
  })
})

describe('toBridgeError', () => {
  it('omits path/mtime when the failure has none, so the envelope carries no undefined props', () => {
    expect(toBridgeError(new BridgeFailure('BAD_REQUEST', "missing 'root'"))).toEqual({ code: 'BAD_REQUEST', message: "missing 'root'" })
    expect(toBridgeError(new BridgeFailure('NOT_FOUND', 'path does not exist', { path: '/x' }))).toEqual({
      code: 'NOT_FOUND',
      message: 'path does not exist',
      path: '/x',
    })
  })

  it('non-Error throwables become IO_ERROR with their string form', () => {
    expect(toBridgeError('nope')).toEqual({ code: 'IO_ERROR', message: 'nope' })
  })
})
