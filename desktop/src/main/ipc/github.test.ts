import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { VAULT_CONFIG_DIR, type GithubSyncStatus, type WindowEntry } from '@shared/types'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { createStore, type Store } from '../store'
import { activeConfigWatcherRoots } from '../vaultConfig'
import { registerGithubIpc } from './github'
import { registered } from './ipcFixture'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })

/** The resolved value of an ok envelope; a failure envelope fails the test where it happened. */
async function value(env: Promise<Envelope<unknown>>): Promise<GithubSyncStatus> {
  const res = await env
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`)
  return res.value as GithubSyncStatus
}

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

const win = (id: string, root: string | null): WindowEntry => ({ id, root, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds })

let dir: string
let vault: string
let store: Store
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  dir = await mkdtemp(path.join(tmpdir(), 'yd-github-ipc-'))
  vault = path.join(dir, 'vault')
  await mkdir(vault) // the root exists (an open vault always does); its dotfolder does not
  store = createStore(path.join(dir, 'yaseendraw.json'))
  registerGithubIpc(store)
})
afterEach(async () => {
  // Dropping every window releases this test's config watcher (the next register drops strays).
  for (const w of store.get().windows) store.removeWindow(w.id)
  await until(() => activeConfigWatcherRoots().length === 0)
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

describe('registerGithubIpc', () => {
  it('refuses a Version history request that is not a board inside the vault (YAZ-1897 D4)', async () => {
    expect(await registered(CONTRACT.github.history)({ sender }, 'rel', 'b.excalidraw')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.github.version)({ sender }, vault, '../b.excalidraw', 'x')).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.github.restore)({ sender }, vault, 'b.excalidraw', 'HEAD:b.excalidraw')).toEqual(bad('BAD_REQUEST'))
  })

  it('rejects a root that is not an absolute path, and a non-boolean flag, before any git work happens', async () => {
    expect(await registered(CONTRACT.github.status)({ sender }, 'rel')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.github.status)({ sender })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.github.syncNow)({ sender }, 'rel')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.github.setEnabled)({ sender }, 'rel', true)).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.github.setEnabled)({ sender }, vault, 'true')).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.github.setEnabled)({ sender }, vault)).toEqual(bad('BAD_REQUEST'))
    // A refused write leaves the vault untouched — nothing was created on the way to the rejection.
    await expect(readFile(path.join(vault, VAULT_CONFIG_DIR, 'github.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers `off` for a vault nobody enabled — the resting state, never an error', async () => {
    // `repo` here is whatever a read-only inspection could learn (nothing, for a folder that is
    // not a repo, and nothing at all on a machine with no git); the state is the contract.
    expect(await value(registered(CONTRACT.github.status)({ sender }, vault))).toMatchObject({ root: vault, state: 'off' })
  })

  it('setEnabled(false) writes the switch and broadcasts `off` to every live window', async () => {
    const a = fakeWindow()
    const b = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([a, b] as unknown as BrowserWindow[])
    store.upsertWindow(win('w1', vault))

    expect(await value(registered(CONTRACT.github.setEnabled)({ sender }, vault, false))).toEqual({ root: vault, state: 'off', enabled: false })
    expect(JSON.parse(await readFile(path.join(vault, VAULT_CONFIG_DIR, 'github.json'), 'utf8'))).toEqual({ enabled: false })
    for (const w of [a, b]) expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.github.onStatus.channel, { root: vault, state: 'off', enabled: false })
  })

  it('follows the open-vault roots: one config subscription per root, dropped with the last window on it', async () => {
    expect(activeConfigWatcherRoots()).toEqual([])
    store.upsertWindow(win('w1', vault))
    expect(activeConfigWatcherRoots()).toEqual([vault])
    store.upsertWindow(win('w2', vault))
    expect(activeConfigWatcherRoots()).toEqual([vault]) // shared, not doubled
    store.upsertWindow(win('w3', null)) // Welcome window: no root, no subscription
    expect(activeConfigWatcherRoots()).toEqual([vault])
    store.removeWindow('w1')
    expect(activeConfigWatcherRoots()).toEqual([vault])
    store.removeWindow('w2')
    await until(() => activeConfigWatcherRoots().length === 0)
  })
})
