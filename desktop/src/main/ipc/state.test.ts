import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { DEFAULT_SETTINGS, SIDEBAR_MAX_W } from '@shared/types'
import { CH, type Envelope } from '../../channels'
import { createStore, type Store } from '../store'
import { registerStateIpc } from './state'

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

/** A `BrowserWindow` stand-in: only what the broadcaster touches. */
function fakeWindow(opts: { destroyed?: boolean; wcDestroyed?: boolean } = {}) {
  return {
    isDestroyed: () => opts.destroyed === true,
    webContents: { isDestroyed: () => opts.wcDestroyed === true, send: vi.fn() },
  }
}

let dir: string
let store: Store
const sender = { id: 1 }
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  dir = await mkdtemp(path.join(tmpdir(), 'yd-state-ipc-'))
  store = createStore(path.join(dir, 'yaseendraw.json'))
  registerStateIpc(store)
})
afterEach(async () => {
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

describe('registerStateIpc', () => {
  it('registers every state channel the preload invokes (and nothing else)', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch).sort()
    expect(channels).toEqual(
      [CH.stateGet, CH.stateSetSettings, CH.stateSetSidebarWidth, CH.statePushRecent, CH.stateRemoveRecent, CH.stateSetFolder].sort(),
    )
  })

  it('state:get answers the current state', async () => {
    expect(await registered(CH.stateGet)({ sender })).toEqual(ok(store.get()))
  })

  it('state:set-settings takes a complete valid SettingsState and rejects anything else as BAD_REQUEST', async () => {
    const next = { ...DEFAULT_SETTINGS, theme: 'dark' as const, confirmDelete: false }
    expect(await registered(CH.stateSetSettings)({ sender }, next)).toEqual(ok(undefined))
    expect(store.get().settings).toEqual(next)
    expect(await registered(CH.stateSetSettings)({ sender }, { ...DEFAULT_SETTINGS, theme: 'blue' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetSettings)({ sender }, { ...DEFAULT_SETTINGS, confirmDelete: 'yes' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetSettings)({ sender }, { theme: 'dark' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetSettings)({ sender }, 'nope')).toEqual(bad('BAD_REQUEST'))
    expect(store.get().settings).toEqual(next)
  })

  it('state:set-sidebar-width only takes a finite number, clamped', async () => {
    expect(await registered(CH.stateSetSidebarWidth)({ sender }, 9999)).toEqual(ok(undefined))
    expect(store.get().sidebarWidth).toBe(SIDEBAR_MAX_W)
    expect(await registered(CH.stateSetSidebarWidth)({ sender }, Number.NaN)).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetSidebarWidth)({ sender }, '300')).toEqual(bad('BAD_REQUEST'))
    expect(store.get().sidebarWidth).toBe(SIDEBAR_MAX_W)
  })

  it('state:push-recent needs an absolute path', async () => {
    expect(await registered(CH.statePushRecent)({ sender }, '/v')).toEqual(ok(undefined))
    expect(store.get().recents.map((r) => r.path)).toEqual(['/v'])
    expect(await registered(CH.statePushRecent)({ sender }, 'v')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CH.statePushRecent)({ sender }, undefined)).toEqual(bad('BAD_REQUEST'))
  })

  it('state:remove-recent needs an absolute path and drops the entry (unknown path is a no-op)', async () => {
    store.pushRecent('/v', 1)
    store.pushRecent('/w', 2)
    expect(await registered(CH.stateRemoveRecent)({ sender }, '/v')).toEqual(ok(undefined))
    expect(store.get().recents.map((r) => r.path)).toEqual(['/w'])
    expect(await registered(CH.stateRemoveRecent)({ sender }, '/gone')).toEqual(ok(undefined))
    expect(store.get().recents.map((r) => r.path)).toEqual(['/w'])
    expect(await registered(CH.stateRemoveRecent)({ sender }, 'v')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CH.stateRemoveRecent)({ sender }, undefined)).toEqual(bad('BAD_REQUEST'))
  })

  it('state:set-folder checks the root and the patch shape', async () => {
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { expanded: ['/v/sub'], lastFile: '/v/a.excalidraw' })).toEqual(ok(undefined))
    expect(store.get().folders['/v']).toEqual({ expanded: ['/v/sub'], lastFile: '/v/a.excalidraw', sortOrder: 'name', name: null })
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { lastFile: null })).toEqual(ok(undefined))
    expect(store.get().folders['/v'].lastFile).toBeNull()
    expect(await registered(CH.stateSetFolder)({ sender }, 'v', {})).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', 'nope')).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { expanded: 'nope' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { expanded: [1] })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { lastFile: 5 })).toEqual(bad('BAD_REQUEST'))
    expect(store.get().folders['/v']).toEqual({ expanded: ['/v/sub'], lastFile: null, sortOrder: 'name', name: null })
    // Focus Mode's lists are window identity since YAZ-1628 (`window.setIdentity`): here they are unknown keys, ignored like any other.
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { focusDirs: ['/v/sub'] })).toEqual(ok(undefined))
    expect(store.get().folders['/v']).toEqual({ expanded: ['/v/sub'], lastFile: null, sortOrder: 'name', name: null })
    // The sort order (🔒 YAZ-1835 D3): the three values pass, anything else — "opened" above all — is refused.
    for (const sortOrder of ['updated', 'created', 'name'] as const) {
      expect(await registered(CH.stateSetFolder)({ sender }, '/v', { sortOrder })).toEqual(ok(undefined))
      expect(store.get().folders['/v'].sortOrder).toBe(sortOrder)
    }
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { sortOrder: 'opened' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { sortOrder: 1 })).toEqual(bad('BAD_REQUEST'))
    expect(store.get().folders['/v'].sortOrder).toBe('name')
    // The vault's display name (Docs YAZ-1974 D3): a string (cleaned by the store) or null, nothing else.
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { name: '  Business Wiki ' })).toEqual(ok(undefined))
    expect(store.get().folders['/v'].name).toBe('Business Wiki')
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { name: 5 })).toEqual(bad('BAD_REQUEST'))
    expect(store.get().folders['/v'].name).toBe('Business Wiki')
    expect(await registered(CH.stateSetFolder)({ sender }, '/v', { name: null })).toEqual(ok(undefined))
    expect(store.get().folders['/v'].name).toBeNull()
  })

  it('broadcasts state:changed with the new state to every live window, skipping destroyed ones', async () => {
    const live = fakeWindow()
    const gone = fakeWindow({ destroyed: true })
    const halfGone = fakeWindow({ wcDestroyed: true })
    const other = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([live, gone, halfGone, other] as unknown as BrowserWindow[])
    await registered(CH.stateSetSidebarWidth)({ sender }, 321)
    expect(live.webContents.send).toHaveBeenCalledTimes(1)
    expect(live.webContents.send).toHaveBeenCalledWith(CH.stateChanged, store.get())
    expect(other.webContents.send).toHaveBeenCalledWith(CH.stateChanged, store.get())
    expect(gone.webContents.send).not.toHaveBeenCalled()
    expect(halfGone.webContents.send).not.toHaveBeenCalled()
    // Direct store mutations (the window manager's upserts) broadcast too.
    store.removeWindow('nope') // no change → no broadcast
    expect(live.webContents.send).toHaveBeenCalledTimes(1)
    store.pushRecent('/v', 1)
    expect(live.webContents.send).toHaveBeenCalledTimes(2)
  })
})
