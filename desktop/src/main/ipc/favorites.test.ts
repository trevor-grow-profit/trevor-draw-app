import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { FAVORITES_FILE } from '../favorites'
import { createStore, type Store } from '../store'
import { activeConfigWatcherRoots, VAULT_CONFIG_DIR } from '../vaultConfig'
import { registerFavoritesIpc } from './favorites'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

function registered(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no handler registered for ${channel}`)
  return call[1] as unknown as Handler
}

const ok = (value: unknown) => ({ ok: true, value })
const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A `BrowserWindow` stand-in: only what the broadcaster touches. */
function fakeWindow() {
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }
}

const bounds = { x: 0, y: 0, width: 800, height: 600 }
const sender = { id: 1 }
const win = (id: string, root: string | null) => ({ id, root, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files' as const, focusDirs: [], focusFavorites: [], bounds })

let dir: string
let vault: string
let store: Store
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  dir = await mkdtemp(path.join(tmpdir(), 'yd-favorites-ipc-'))
  vault = path.join(dir, 'vault')
  await mkdir(vault) // the root exists (an open vault always does); its dotfolder does not
  await writeFile(path.join(vault, 'a.md'), '# a\n')
  store = createStore(path.join(dir, 'yaseendraw.json'))
  registerFavoritesIpc(store)
})
afterEach(async () => {
  for (const w of store.get().windows) store.removeWindow(w.id)
  await until(() => activeConfigWatcherRoots().length === 0)
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

describe('registerFavoritesIpc (YAZ-1766 6A)', () => {
  it('registers exactly the favorites channels the preload invokes', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch).sort()
    expect(channels).toEqual([CONTRACT.favorites.get.channel, CONTRACT.favorites.set.channel].sort())
  })

  it('get and set round-trip absolute paths through the envelope; bad arguments answer error envelopes', async () => {
    const a = path.join(vault, 'a.md')
    expect(await registered(CONTRACT.favorites.get.channel)({ sender }, vault)).toEqual(ok([]))
    expect(await registered(CONTRACT.favorites.set.channel)({ sender }, vault, [a])).toEqual(ok(undefined))
    expect(await registered(CONTRACT.favorites.get.channel)({ sender }, vault)).toEqual(ok([a]))
    expect(await registered(CONTRACT.favorites.get.channel)({ sender }, 'rel')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.favorites.set.channel)({ sender }, vault, 'a.md')).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.favorites.set.channel)({ sender }, vault, [1])).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.favorites.set.channel)({ sender }, vault, ['/elsewhere/x.md'])).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.favorites.get.channel)({ sender }, vault)).toEqual(ok([a])) // none of the refusals wrote
  })

  it('subscribes one favorites watcher per open-vault root and drops it when the last window leaves', async () => {
    expect(activeConfigWatcherRoots()).toEqual([])
    store.upsertWindow(win('w1', vault))
    expect(activeConfigWatcherRoots()).toEqual([vault])
    store.upsertWindow(win('w2', vault))
    expect(activeConfigWatcherRoots()).toEqual([vault]) // shared, not doubled
    store.upsertWindow(win('w3', null)) // Welcome window: no root, no watcher
    expect(activeConfigWatcherRoots()).toEqual([vault])
    store.removeWindow('w1')
    expect(activeConfigWatcherRoots()).toEqual([vault])
    store.removeWindow('w2')
    await until(() => activeConfigWatcherRoots().length === 0)
  })

  it('broadcasts favorites:changed { root } to every live window on an own write and on an external edit', async () => {
    const a = fakeWindow()
    const b = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([a, b] as unknown as BrowserWindow[])
    store.upsertWindow(win('w1', vault))
    a.webContents.send.mockClear()
    b.webContents.send.mockClear()

    await registered(CONTRACT.favorites.set.channel)({ sender }, vault, [path.join(vault, 'a.md')])
    expect(a.webContents.send).toHaveBeenCalledWith(CONTRACT.favorites.onChanged.channel, { root: vault })
    expect(b.webContents.send).toHaveBeenCalledWith(CONTRACT.favorites.onChanged.channel, { root: vault })

    a.webContents.send.mockClear()
    await new Promise((r) => setTimeout(r, 300)) // let the watcher settle on the just-created dotfolder
    await writeFile(path.join(vault, VAULT_CONFIG_DIR, FAVORITES_FILE), JSON.stringify({ version: 1, favorites: [] }))
    await until(() => a.webContents.send.mock.calls.some(([ch, c]) => ch === CONTRACT.favorites.onChanged.channel && (c as { root: string }).root === vault))
    expect(await registered(CONTRACT.favorites.get.channel)({ sender }, vault)).toEqual(ok([]))
  })
})
