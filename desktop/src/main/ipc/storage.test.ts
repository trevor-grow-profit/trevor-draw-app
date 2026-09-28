import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { registerStorageIpc } from './storage'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
// electron-vite's `?modulePath` is a build-time import; here it is the same worker, bundled by the fixture.
vi.mock('../storageWorker?modulePath', async () => ({ default: await (await import('../git/gitFixture')).bundleStorageWorker() }))

/** The `storage.*` doors (YAZ-1801): requests are checked like request bodies before any walk or rewrite. */

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>
const registered = (channel: string): Handler => vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)![1] as unknown as Handler
const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'draw-storage-ipc-'))
  vi.mocked(ipcMain.handle).mockClear()
  registerStorageIpc()
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('storage IPC (YAZ-1801)', () => {
  it('stats answers for a plain folder, with git null', async () => {
    await writeFile(path.join(root, 'a.excalidraw'), '{"elements":[],"files":{}}')
    const res = await registered(CONTRACT.storage.stats.channel)(undefined, root)
    expect(res).toMatchObject({ ok: true, value: { root, boards: { count: 1 }, git: null } })
  })

  it('refuses a relative root and a skip list that is not absolute paths — nothing is walked', async () => {
    await expect(registered(CONTRACT.storage.stats.channel)(undefined, 'relative/dir')).resolves.toEqual(bad('NOT_ABSOLUTE'))
    await expect(registered(CONTRACT.storage.shrink.channel)(undefined, root, 'not-an-array')).resolves.toEqual(bad('BAD_REQUEST'))
    await expect(registered(CONTRACT.storage.shrink.channel)(undefined, root, ['relative.excalidraw'])).resolves.toEqual(bad('NOT_ABSOLUTE'))
  })

  it('a vault that is gone answers NOT_FOUND from main, before any worker starts — for both doors', async () => {
    const gone = path.join(root, 'moved-away')
    await expect(registered(CONTRACT.storage.stats.channel)(undefined, gone)).resolves.toEqual(bad('NOT_FOUND'))
    await expect(registered(CONTRACT.storage.shrink.channel)(undefined, gone, [])).resolves.toEqual(bad('NOT_FOUND'))
  })

  it('shrink answers the counts', async () => {
    await expect(registered(CONTRACT.storage.shrink.channel)(undefined, root, [])).resolves.toEqual({ ok: true, value: { shrunk: 0, skipped: 0, bytesMoved: 0 } })
  })
})
