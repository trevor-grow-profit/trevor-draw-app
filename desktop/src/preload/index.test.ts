import { describe, expect, it, vi } from 'vitest'
import type { WatchEvent } from '@shared/types'
import { SPECIAL } from '@shared/ipc'

const exposed: Record<string, unknown> = {}
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => void (exposed[name] = value) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
}))

const { ipcRenderer } = await import('electron')
const { bridge, buildBridge } = await import('./index')

/** The handler the bridge last registered on `channel`, as main's `webContents.send` would reach it. */
const lastOn = (channel: string) => vi.mocked(ipcRenderer.on).mock.calls.filter(([ch]) => ch === channel).at(-1)?.[1] as unknown as (e: unknown, ...a: unknown[]) => void
const flushRequested = lastOn(SPECIAL.appFlush)

describe('buildBridge', () => {
  const table = { a: { kind: 'invoke', channel: 'x:a' }, ns: { onB: { kind: 'push', channel: 'x:b' } } } as const
  const built = buildBridge(table) as { a: (...args: unknown[]) => Promise<unknown>; ns: { onB: (l: (p: unknown) => void) => () => void } }

  it('an invoke sends its arguments on its channel and resolves the envelope’s value', async () => {
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ ok: true, value: 7 })
    await expect(built.a('/v', true)).resolves.toBe(7)
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('x:a', '/v', true)
  })

  it('an error envelope rejects with the plain BridgeError, as it came', async () => {
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: 'newer on disk', mtime: 42 } })
    await expect(built.a()).rejects.toEqual({ code: 'CONFLICT', message: 'newer on disk', mtime: 42 })
  })

  it('a push hands each payload to the listener, without the event, until unsubscribed', () => {
    const listener = vi.fn()
    const off = built.ns.onB(listener)
    const handler = lastOn('x:b')
    handler(undefined, { root: '/v' })
    expect(listener).toHaveBeenCalledWith({ root: '/v' })
    off()
    expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith('x:b', handler)
  })
})

describe('the preload bridge', () => {
  it('exposes window.yaseenDraw with exactly the surface and channels it had before the table (YAZ-2073 🔒 D16)', async () => {
    expect(exposed.yaseenDraw).toBe(bridge)
    const lines: string[] = []
    const walk = async (o: Record<string, unknown>, at: string): Promise<void> => {
      for (const key of Object.keys(o).sort()) {
        const v = o[key]
        if (typeof v !== 'function') {
          await walk(v as Record<string, unknown>, `${at}${key}.`)
          continue
        }
        for (const fn of [ipcRenderer.invoke, ipcRenderer.on, ipcRenderer.send, ipcRenderer.removeListener]) vi.mocked(fn).mockClear()
        vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ ok: true, value: null })
        const out = (v as (...a: unknown[]) => unknown)(() => {}, () => {})
        if (typeof out === 'function') out()
        else await out
        const ipc = [['invoke', ipcRenderer.invoke], ['on', ipcRenderer.on], ['send', ipcRenderer.send], ['off', ipcRenderer.removeListener]] as const
        const calls = ipc.flatMap(([verb, fn]) => vi.mocked(fn).mock.calls.map((c, i) => [vi.mocked(fn).mock.invocationCallOrder[i], `${verb} ${String(c[0])}`] as const))
        lines.push(`${at}${key} -> ${calls.sort((x, y) => x[0] - y[0]).map(([, s]) => s).join(', ')}`)
      }
    }
    await walk(bridge as unknown as Record<string, unknown>, '')
    expect(lines.join('\n')).toMatchSnapshot()
  })

  it('watch() multiplexes by subscription id: each listener gets only its own events; unsubscribe sends watch:unsubscribe', () => {
    vi.mocked(ipcRenderer.send).mockClear()
    const a = vi.fn()
    const b = vi.fn()
    const offA = bridge.watch('/vault/a', a)
    const offB = bridge.watch('/vault/b', b)
    const subs = vi.mocked(ipcRenderer.send).mock.calls.filter(([ch]) => ch === SPECIAL.watchSubscribe).map((c) => c[1] as { id: string; root: string })
    expect(subs.map((s) => s.root)).toEqual(['/vault/a', '/vault/b'])
    expect(subs[0].id).not.toBe(subs[1].id)
    const handlers = vi.mocked(ipcRenderer.on).mock.calls.filter(([ch]) => ch === SPECIAL.watchEvent).slice(-2).map((c) => c[1] as unknown as (e: unknown, msg: { id: string; ev: WatchEvent }) => void)
    // Main fans every event out to every listener on watch:event; the id filters them.
    const evA: WatchEvent = { type: 'change', path: '/vault/a/x.excalidraw', mtime: 1 }
    const evB: WatchEvent = { type: 'unlink', path: '/vault/b/y.excalidraw' }
    for (const h of handlers) h(undefined, { id: subs[0].id, ev: evA })
    for (const h of handlers) h(undefined, { id: subs[1].id, ev: evB })
    expect(a.mock.calls).toEqual([[evA]])
    expect(b.mock.calls).toEqual([[evB]])
    offA()
    expect(ipcRenderer.removeListener).toHaveBeenLastCalledWith(SPECIAL.watchEvent, handlers[0])
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(SPECIAL.watchUnsubscribe, subs[0].id)
    offB()
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(SPECIAL.watchUnsubscribe, subs[1].id)
  })

  it('acks app:flush only after every onFlush listener settled (GRO-2160 close handshake)', async () => {
    const settle = () => new Promise((r) => setTimeout(r))
    let release!: () => void
    const off = bridge.window.onFlush(() => new Promise<void>((r) => (release = r)))
    vi.mocked(ipcRenderer.send).mockClear()
    flushRequested(undefined)
    await settle()
    expect(ipcRenderer.send).not.toHaveBeenCalled()
    release()
    await settle()
    expect(ipcRenderer.send).toHaveBeenCalledWith(SPECIAL.appFlushed)
    // No listeners registered (Welcome window): the ack comes straight away.
    off()
    vi.mocked(ipcRenderer.send).mockClear()
    flushRequested(undefined)
    await settle()
    expect(ipcRenderer.send).toHaveBeenCalledWith(SPECIAL.appFlushed)
  })
})
