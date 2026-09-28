import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, BridgeRequestError } from './api'

/** A `window.yaseenDraw` stub, installed after `api` was built: `api` must look the bridge up at call time. */
function installBridge<T extends object>(bridge: T): T {
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return bridge
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).yaseenDraw
})

describe('api (the CONTRACT table over window.yaseenDraw, YAZ-2073 🔒 D16)', () => {
  it('an invoke delegates with the same arguments, at any depth, and resolves its value', async () => {
    const bridge = installBridge({ tree: vi.fn().mockResolvedValue({ root: '/v', tree: [], generatedAt: 1 }), github: { setEnabled: vi.fn().mockResolvedValue({ root: '/v', state: 'synced' }) } })
    await expect(api.tree('/v')).resolves.toEqual({ root: '/v', tree: [], generatedAt: 1 })
    expect(bridge.tree).toHaveBeenCalledWith('/v')
    await expect(api.github.setEnabled('/v', true)).resolves.toEqual({ root: '/v', state: 'synced' })
    expect(bridge.github.setEnabled).toHaveBeenCalledWith('/v', true)
  })

  it('a rejected plain BridgeError becomes a thrown BridgeRequestError with code / message / path / mtime', async () => {
    installBridge({ drawing: { save: vi.fn().mockRejectedValue({ code: 'CONFLICT', message: 'newer on disk', path: '/v/a.excalidraw', mtime: 42 }) } })
    const err = (await api.drawing.save({ root: '/v', path: 'a.excalidraw', json: '{}', newFiles: [] }).catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect([err.name, err.code, err.message, err.path, err.mtime]).toEqual(['BridgeRequestError', 'CONFLICT', 'newer on disk', '/v/a.excalidraw', 42])
    expect('status' in err).toBe(false)
  })

  it('a BridgeError without path / mtime leaves those fields undefined', async () => {
    installBridge({ tree: vi.fn().mockRejectedValue({ code: 'NOT_FOUND', message: 'path does not exist' }) })
    const err = (await api.tree('/v/missing').catch((e: unknown) => e)) as BridgeRequestError
    expect([err.code, err.mtime, err.path]).toEqual(['NOT_FOUND', undefined, undefined])
  })

  it('anything that is not a BridgeError — a missing bridge included — is wrapped as IO_ERROR with its message', async () => {
    installBridge({ tree: vi.fn().mockRejectedValue(new Error('ipc gone')) })
    await expect(api.tree('/v')).rejects.toMatchObject({ name: 'BridgeRequestError', code: 'IO_ERROR', message: 'ipc gone' })
    delete (window as unknown as Record<string, unknown>).yaseenDraw
    await expect(api.state.get()).rejects.toMatchObject({ name: 'BridgeRequestError', code: 'IO_ERROR' })
  })

  it('a push, watch and onFlush pass straight through: the listener in, the bridge’s own unsubscribe out', () => {
    const off = () => {}
    const bridge = installBridge({ github: { onStatus: vi.fn(() => off) }, watch: vi.fn(() => off), window: { onFlush: vi.fn(() => off) } })
    const listener = vi.fn()
    expect(api.github.onStatus(listener)).toBe(off)
    expect(bridge.github.onStatus).toHaveBeenCalledWith(listener)
    expect(api.watch('/v', listener)).toBe(off)
    expect(bridge.watch).toHaveBeenCalledWith('/v', listener)
    expect(api.window.onFlush(listener)).toBe(off)
    expect(bridge.window.onFlush).toHaveBeenCalledWith(listener)
  })
})
