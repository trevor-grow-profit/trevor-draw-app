import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { CONTRACT, leaves, SPECIAL } from '@shared/ipc'
import { createStore } from '../store'
import type { WindowManagerIpc } from '../windows'
import { registerIpc } from './index'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {},
  shell: {},
  nativeImage: {},
}))
vi.mock('../storageWorker?modulePath', () => ({ default: '' }))

/** Every invoke channel in the table. */
const invokes = leaves(CONTRACT).flatMap(([, door]) => (door.kind === 'invoke' ? [door.channel] : []))

const dir = await mkdtemp(path.join(tmpdir(), 'yd-ipc-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

it('main answers every CONTRACT invoke exactly once, and nothing the table does not list (YAZ-2073 🔒 D16)', () => {
  registerIpc(createStore(path.join(dir, 'state.json')), {} as WindowManagerIpc, dir, { viewerAssetsDir: dir, drawioDir: dir, fontsDir: dir, isPackaged: false })
  expect(vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch).sort()).toEqual(invokes.sort())
  expect(vi.mocked(ipcMain.on).mock.calls.map(([ch]) => ch).sort()).toEqual([SPECIAL.appFlushed, SPECIAL.watchSubscribe, SPECIAL.watchUnsubscribe])
})
