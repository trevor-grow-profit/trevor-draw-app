import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import type { WindowEntry } from '@shared/types'
import { CONTRACT, SPECIAL, type Envelope } from '@shared/ipc'
import { createStore, type Store } from '../store'
import * as windows from '../windows'
import { registerWindowIpc } from './window'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

function registered(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no handler registered for ${channel}`)
  return call[1] as unknown as Handler
}

const ok = (value: unknown) => ({ ok: true, value })
const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })
const bounds = { x: 10, y: 20, width: 800, height: 600 }
const entry: WindowEntry = { id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds }

let dir: string
let store: Store
let unregister: () => void
/** The manager slice the IPC layer drives: the real lookup, spies for the plumbing. */
let manager: {
  idFor: typeof windows.idFor
  openWindow: ReturnType<typeof vi.fn>
  duplicateWindow: ReturnType<typeof vi.fn>
  openRecentBeside: ReturnType<typeof vi.fn>
  closeWindow: ReturnType<typeof vi.fn>
  handleFlushed: ReturnType<typeof vi.fn>
}
/** `event.sender` stand-ins: webContents 1 is registered as window w1, webContents 9 is unknown. */
const sender = { id: 1 }
const stranger = { id: 9 }
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(ipcMain.on).mockClear()
  dir = await mkdtemp(path.join(tmpdir(), 'yd-window-ipc-'))
  store = createStore(path.join(dir, 'yaseendraw.json'))
  store.upsertWindow(entry)
  unregister = windows.register({ webContents: sender }, 'w1')
  manager = { idFor: windows.idFor, openWindow: vi.fn(), duplicateWindow: vi.fn(), openRecentBeside: vi.fn(() => true), closeWindow: vi.fn(), handleFlushed: vi.fn() }
  registerWindowIpc(store, manager)
})
afterEach(async () => {
  unregister()
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

describe('window lookup', () => {
  it('maps a webContents id to its window id until unregistered', () => {
    expect(windows.idFor(sender)).toBe('w1')
    expect(windows.idFor(stranger)).toBeUndefined()
    unregister()
    expect(windows.idFor(sender)).toBeUndefined()
    unregister = windows.register({ webContents: sender }, 'w1')
  })
})

describe('registerWindowIpc', () => {
  it('registers every window channel the preload invokes (and nothing else)', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch).sort()
    expect(channels).toEqual([CONTRACT.window.identity.channel, CONTRACT.window.setIdentity.channel, CONTRACT.window.open.channel, CONTRACT.window.openRecent.channel, CONTRACT.window.closeSelf.channel].sort())
  })

  it('window:identity answers the complete per-window identity for a registered sender', async () => {
    expect(await registered(CONTRACT.window.identity.channel)({ sender })).toEqual(ok({ id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [] }))
  })

  it('window:identity rejects an unregistered sender (BAD_REQUEST) and a window the state no longer has (NOT_FOUND)', async () => {
    expect(await registered(CONTRACT.window.identity.channel)({ sender: stranger })).toEqual(bad('BAD_REQUEST'))
    store.removeWindow('w1')
    expect(await registered(CONTRACT.window.identity.channel)({ sender })).toEqual(bad('NOT_FOUND'))
  })

  it('window:set-identity merges root / file into the entry, keeping id and bounds; tabs follow the invariant', async () => {
    // file → null clears tabs (tabs [] ⇔ file null); a new file not in tabs is prepended.
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { root: '/other', file: null })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ id: 'w1', root: '/other', file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds }])
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { file: '/other/b.excalidraw' })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ id: 'w1', root: '/other', file: '/other/b.excalidraw', tabs: ['/other/b.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds }])
    // Unknown keys cannot touch id / bounds.
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { id: 'hijack', bounds: { x: 0, y: 0, width: 1, height: 1 } })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ id: 'w1', root: '/other', file: '/other/b.excalidraw', tabs: ['/other/b.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds }])
  })

  it('window:set-identity accepts a tabs patch: de-duplicated, and the active file is prepended when missing (GRO-2232)', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { tabs: ['/v/a.excalidraw', '/v/b.excalidraw', '/v/a.excalidraw'] })).toEqual(ok(undefined))
    expect(store.get().windows[0].tabs).toEqual(['/v/a.excalidraw', '/v/b.excalidraw'])
    // The invariant holds on the entry AS WRITTEN: a tabs patch missing the untouched active file repairs by prepending.
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { tabs: ['/v/b.excalidraw', '/v/c.excalidraw'] })).toEqual(ok(undefined))
    expect(store.get().windows[0].tabs).toEqual(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'])
    // file and tabs patched together: the new file leads.
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { file: '/v/b.excalidraw', tabs: ['/v/b.excalidraw', '/v/c.excalidraw'] })).toEqual(ok(undefined))
    expect(store.get().windows[0]).toEqual({ id: 'w1', root: '/v', file: '/v/b.excalidraw', tabs: ['/v/b.excalidraw', '/v/c.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds })
  })

  it('window:set-identity validates and patches sidebar visibility without changing other identity or bounds', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { sidebarCollapsed: true })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ ...entry, sidebarCollapsed: true }])
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { sidebarCollapsed: 'true' })).toEqual(bad('BAD_REQUEST'))
    expect(store.get().windows).toEqual([{ ...entry, sidebarCollapsed: true }])
  })

  it('window:set-identity validates and patches the lens, and identity reads it back (YAZ-1628)', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { sidebarLens: 'favorites' })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ ...entry, sidebarLens: 'favorites' }])
    expect(await registered(CONTRACT.window.identity.channel)({ sender })).toEqual(ok({ id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'favorites', focusDirs: [], focusFavorites: [] }))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { sidebarLens: 'outline' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { sidebarLens: 1 })).toEqual(bad('BAD_REQUEST'))
    expect(store.get().windows).toEqual([{ ...entry, sidebarLens: 'favorites' }])
  })

  it('window:set-identity validates and patches the Focus Mode lists with the tabs rule, and identity reads them back (YAZ-1628)', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusDirs: ['/v/a', '/v/b'], focusFavorites: ['/v/F'] })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ ...entry, focusDirs: ['/v/a', '/v/b'], focusFavorites: ['/v/F'] }])
    expect(await registered(CONTRACT.window.identity.channel)({ sender })).toEqual(ok({ id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: ['/v/a', '/v/b'], focusFavorites: ['/v/F'] }))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusDirs: [] })).toEqual(ok(undefined)) // one lens' exit leaves the other alone
    expect(store.get().windows).toEqual([{ ...entry, focusDirs: [], focusFavorites: ['/v/F'] }])
    // A non-array, or one relative element, rejects the whole call and leaves the entry untouched.
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusDirs: 'nope' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusFavorites: ['/v/F', 'rel'] })).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusDirs: ['/v/a', 5] })).toEqual(bad('NOT_ABSOLUTE'))
    expect(store.get().windows).toEqual([{ ...entry, focusDirs: [], focusFavorites: ['/v/F'] }])
  })

  it('window:set-identity validates and patches focusFavorites with the same tabs rule, and identity reads it back (YAZ-1766 D5)', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusFavorites: ['/v/a'] })).toEqual(ok(undefined))
    expect(store.get().windows).toEqual([{ ...entry, focusFavorites: ['/v/a'] }])
    expect(await registered(CONTRACT.window.identity.channel)({ sender })).toEqual(ok({ id: 'w1', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: ['/v/a'] }))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusFavorites: 'nope' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { focusFavorites: ['/v/a', 'rel'] })).toEqual(bad('NOT_ABSOLUTE'))
    expect(store.get().windows).toEqual([{ ...entry, focusFavorites: ['/v/a'] }])
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { sidebarLens: 'favorites' })).toEqual(ok(undefined)) // the other lens (D1)
    expect(store.get().windows[0].sidebarLens).toBe('favorites')
  })

  it('window:set-identity rejects the whole call on any bad tabs element, leaving the entry untouched', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { tabs: 'nope' })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { tabs: ['/v/a.excalidraw', 'rel.excalidraw'] })).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { tabs: ['/v/a.excalidraw', 5] })).toEqual(bad('NOT_ABSOLUTE'))
    expect(store.get().windows).toEqual([entry])
  })

  it('window:close-self hands the caller id to the manager (real close path); unknown callers are rejected', async () => {
    expect(await registered(CONTRACT.window.closeSelf.channel)({ sender })).toEqual(ok(undefined))
    expect(manager.closeWindow).toHaveBeenCalledWith('w1')
    expect(await registered(CONTRACT.window.closeSelf.channel)({ sender: stranger })).toEqual(bad('BAD_REQUEST'))
    expect(manager.closeWindow).toHaveBeenCalledTimes(1)
  })

  it('window:set-identity validates the patch', async () => {
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, 'nope')).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { root: 5 })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { root: 'rel' })).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { file: 'a.excalidraw' })).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { extra: true })).toEqual(ok(undefined)) // unknown keys are ignored, not refused
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender: stranger }, { root: '/v' })).toEqual(bad('BAD_REQUEST'))
    store.removeWindow('w1')
    expect(await registered(CONTRACT.window.setIdentity.channel)({ sender }, { root: '/v' })).toEqual(bad('NOT_FOUND'))
  })

  it('window:open validates the options and hands them to the manager (absent paths read as null)', async () => {
    expect(await registered(CONTRACT.window.open.channel)({ sender }, { root: '/v', file: '/v/a.excalidraw' })).toEqual(ok(undefined))
    expect(manager.openWindow).toHaveBeenCalledWith({ root: '/v', file: '/v/a.excalidraw' })
    expect(await registered(CONTRACT.window.open.channel)({ sender }, {})).toEqual(ok(undefined))
    expect(manager.openWindow).toHaveBeenCalledWith({ root: null, file: null })
    expect(await registered(CONTRACT.window.open.channel)({ sender }, 'nope')).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.open.channel)({ sender }, { root: 5 })).toEqual(bad('BAD_REQUEST'))
    expect(await registered(CONTRACT.window.open.channel)({ sender }, { root: 'rel' })).toEqual(bad('NOT_ABSOLUTE'))
    expect(manager.openWindow).toHaveBeenCalledTimes(2)
  })

  it('window:open-recent validates the path and returns the door\'s verdict (YAZ-1767 D1)', async () => {
    expect(await registered(CONTRACT.window.openRecent.channel)({ sender }, '/v/other')).toEqual(ok(true))
    expect(manager.openRecentBeside).toHaveBeenCalledExactlyOnceWith('/v/other')
    manager.openRecentBeside.mockReturnValueOnce(false)
    expect(await registered(CONTRACT.window.openRecent.channel)({ sender }, '/v/gone')).toEqual(ok(false))
    expect(await registered(CONTRACT.window.openRecent.channel)({ sender }, 'rel')).toEqual(bad('NOT_ABSOLUTE'))
    expect(await registered(CONTRACT.window.openRecent.channel)({ sender }, undefined)).toEqual(bad('BAD_REQUEST'))
    expect(manager.openRecentBeside).toHaveBeenCalledTimes(2)
  })

  it('app:flushed routes the renderer ack to the manager by sender', () => {
    const call = vi.mocked(ipcMain.on).mock.calls.find(([ch]) => ch === SPECIAL.appFlushed)
    expect(call).toBeDefined()
    const handler = call?.[1] as unknown as (e: { sender: { id: number } }) => void
    handler({ sender })
    expect(manager.handleFlushed).toHaveBeenCalledWith(sender)
  })
})
