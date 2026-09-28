import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ipcMain } from 'electron'
import type { WatchEvent } from '@shared/types'
import { SPECIAL } from '@shared/ipc'
import { makeFixture, until } from '../fs/testFixture'
import { activeWatcherRoots } from '../fs/watchers'
import { registerWatchIpc } from './watch'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

type Listener = (event: unknown, ...args: unknown[]) => void | Promise<void>

function listener(channel: string): Listener {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no listener registered for ${channel}`)
  return call[1] as unknown as Listener
}

let nextId = 1
/** Stand-in for `event.sender` (a WebContents): records sends and the `destroyed` hook. */
function makeSender() {
  return { id: nextId++, send: vi.fn(), once: vi.fn(), isDestroyed: () => false }
}
type Sender = ReturnType<typeof makeSender>

const sent = (s: Sender): Array<{ id: string; ev: WatchEvent }> =>
  s.send.mock.calls.filter(([ch]) => ch === SPECIAL.watchEvent).map(([, msg]) => msg as { id: string; ev: WatchEvent })
const destroy = (s: Sender) => {
  const hook = s.once.mock.calls.find(([name]) => name === 'destroyed')
  if (hook === undefined) throw new Error('no destroyed hook registered')
  ;(hook[1] as () => void)()
}

let root: string
let cleanup: () => Promise<void>
const senders: Sender[] = []
beforeAll(async () => {
  ;({ root, cleanup } = await makeFixture())
  registerWatchIpc()
})
afterAll(() => cleanup())
afterEach(async () => {
  senders.splice(0).forEach((s) => s.once.mock.calls.some(([name]) => name === 'destroyed') && destroy(s))
  await until(() => activeWatcherRoots().length === 0)
})

const subscribeAs = async (s: Sender, id: string, r: string) => {
  senders.includes(s) || senders.push(s)
  await listener(SPECIAL.watchSubscribe)({ sender: s }, { id, root: r })
}
const unsubscribeAs = (s: Sender, id: string) => listener(SPECIAL.watchUnsubscribe)({ sender: s }, id)

describe('watch IPC', () => {
  it('registers subscribe + unsubscribe listeners', () => {
    const channels = vi.mocked(ipcMain.on).mock.calls.map(([ch]) => ch).sort()
    expect(channels).toEqual([SPECIAL.watchSubscribe, SPECIAL.watchUnsubscribe].sort())
  })

  it('two subscriptions on one root share one watcher; each gets `ready` addressed to its id', async () => {
    const s = makeSender()
    await subscribeAs(s, 'sub-1', root)
    await until(() => sent(s).length >= 1)
    await subscribeAs(s, 'sub-2', root)
    await until(() => sent(s).length >= 2)
    expect(sent(s)).toEqual([
      { id: 'sub-1', ev: { type: 'ready', root } },
      { id: 'sub-2', ev: { type: 'ready', root } },
    ])
    expect(activeWatcherRoots()).toEqual([root])
  })

  it('unsubscribing one subscription leaves the other receiving events', async () => {
    const s = makeSender()
    await subscribeAs(s, 'keep', root)
    await subscribeAs(s, 'drop', root)
    await until(() => sent(s).length >= 2)
    unsubscribeAs(s, 'drop')
    expect(activeWatcherRoots()).toEqual([root])
    const file = path.join(root, 'alpha', 'ipc-watched.excalidraw')
    await writeFile(file, 'v1')
    await until(() => sent(s).some((m) => m.ev.type === 'add'))
    const adds = sent(s).filter((m) => m.ev.type === 'add')
    expect(adds).toEqual([{ id: 'keep', ev: { type: 'add', path: file, mtime: expect.any(Number) } }])
  })

  it('destroying the sender removes every subscription it held', async () => {
    const s = makeSender()
    await subscribeAs(s, 'a', root)
    await subscribeAs(s, 'b', root)
    await until(() => sent(s).length >= 2)
    expect(s.once).toHaveBeenCalledTimes(1)
    expect(s.once.mock.calls[0][0]).toBe('destroyed')
    destroy(s)
    await until(() => activeWatcherRoots().length === 0)
  })

  it('two windows on one root (GRO-2169): one watcher, a save reaches both as `change`; one window closing leaves the other live, the last closing disposes the watcher', async () => {
    const a = makeSender()
    const b = makeSender()
    await subscribeAs(a, 'win-a', root)
    await subscribeAs(b, 'win-b', root)
    await until(() => sent(a).length >= 1 && sent(b).length >= 1)
    expect(activeWatcherRoots()).toEqual([root])

    // Window A saves the file both windows have open → the shared watcher emits one `change` to each.
    const file = path.join(root, 'alpha', 'a.excalidraw')
    await writeFile(file, 'saved by window A')
    const change = (s: Sender) => sent(s).filter((m) => m.ev.type === 'change')
    await until(() => change(a).length >= 1 && change(b).length >= 1)
    expect(change(a)).toEqual([{ id: 'win-a', ev: { type: 'change', path: file, mtime: expect.any(Number) } }])
    expect(change(b)).toEqual([{ id: 'win-b', ev: { type: 'change', path: file, mtime: expect.any(Number) } }])

    // Window A closes: B stays subscribed to the still-alive watcher and keeps receiving events.
    destroy(a)
    expect(activeWatcherRoots()).toEqual([root])
    const aBefore = sent(a).length
    await writeFile(file, 'saved again, window A gone')
    await until(() => change(b).length >= 2)
    expect(sent(a).length).toBe(aBefore)

    // The LAST window closing disposes the watcher.
    destroy(b)
    await until(() => activeWatcherRoots().length === 0)
  })

  it('an unsubscribe that lands while the subscribe is still checking the root leaks nothing (YAZ-2073 2C)', async () => {
    const s = makeSender()
    senders.push(s)
    // A quick root switch or a StrictMode remount: `watch:unsubscribe` arrives before `requireDir` settles.
    const pending = listener(SPECIAL.watchSubscribe)({ sender: s }, { id: 'raced', root })
    unsubscribeAs(s, 'raced')
    await pending
    expect(activeWatcherRoots()).toEqual([])
    expect(sent(s)).toEqual([])
    // The same window's next subscription still works.
    await subscribeAs(s, 'next', root)
    await until(() => sent(s).length >= 1)
    expect(sent(s)).toEqual([{ id: 'next', ev: { type: 'ready', root } }])
  })

  it('an unsubscribe for an id that is not subscribing leaves nothing behind: that id can still subscribe later (YAZ-2073 2C)', async () => {
    const s = makeSender()
    senders.push(s)
    unsubscribeAs(s, 'never-seen')
    await subscribeAs(s, 'never-seen', root)
    await until(() => sent(s).length >= 1)
    expect(sent(s)).toEqual([{ id: 'never-seen', ev: { type: 'ready', root } }])
    expect(activeWatcherRoots()).toEqual([root])
  })

  it('a bad root answers one error event and subscribes nothing', async () => {
    const s = makeSender()
    await subscribeAs(s, 'rel', root.slice(1))
    await subscribeAs(s, 'missing', path.join(root, 'nope'))
    await subscribeAs(s, 'file', path.join(root, 'b.excalidraw'))
    expect(sent(s).map((m) => [m.id, m.ev.type, (m.ev as { message: string }).message])).toEqual([
      ['rel', 'error', "'root' must be an absolute path"],
      ['missing', 'error', 'path does not exist'],
      ['file', 'error', 'expected a directory'],
    ])
    expect(activeWatcherRoots()).toEqual([])
    expect(s.once).not.toHaveBeenCalled()
  })
})
