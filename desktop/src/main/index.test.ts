import { afterAll, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

// YAZ-2073 D11: quitSequence.test.ts pins the order; this pins the wiring — index.ts's `before-quit`
// hands runQuitSequence the LIVE manager, store and sync manager, and its exit is `app.exit(0)`.
// 82d63ce dropped a step from this handler and nothing noticed.

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return {
    userData: mkdtempSync(join(tmpdir(), 'yd-index-')),
    handlers: new Map<string, (...args: unknown[]) => void>(),
    manager: { restoreAll: () => undefined, idFor: () => undefined, flushAllForQuit: async () => undefined },
    gitSync: { flushForQuit: async () => undefined, notifyWake: () => undefined, notifyFocus: () => undefined },
    store: undefined as unknown,
  }
})

vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: () => h.userData,
    getAppPath: () => h.userData,
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    quit: vi.fn(),
    exit: vi.fn(),
    on: (event: string, fn: (...args: unknown[]) => void) => void h.handlers.set(event, fn),
    setAsDefaultProtocolClient: vi.fn(),
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
  net: { fetch: vi.fn() },
  powerMonitor: { on: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  screen: {},
  shell: {},
}))
vi.mock('./windows', () => ({
  createWindowManager: (store: unknown) => {
    h.store = store
    return h.manager
  },
}))
vi.mock('./ipc', () => ({ registerIpc: () => h.gitSync }))
vi.mock('./ipc/share', () => ({ viewerAssetsDir: () => h.userData }))
vi.mock('./library/folder', () => ({ ensureLibraryFolder: async () => undefined }))
vi.mock('./quitSequence', () => ({ runQuitSequence: vi.fn(async () => undefined) }))

afterAll(() => rmSync(h.userData, { recursive: true, force: true }))

describe('main/index.ts before-quit (YAZ-2073 D11)', () => {
  it('runs the quit sequence once, with the live manager, store and sync manager, exiting through app.exit(0)', async () => {
    const { app } = await import('electron')
    const { runQuitSequence } = await import('./quitSequence')
    await import('./index')
    await new Promise((r) => setTimeout(r, 0)) // `whenReady` ran: registerIpc handed back the sync manager

    const quit = h.handlers.get('before-quit')!
    const event = { preventDefault: vi.fn() }
    quit(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(runQuitSequence).toHaveBeenCalledTimes(1)
    const deps = vi.mocked(runQuitSequence).mock.calls[0][0]
    expect(deps.manager).toBe(h.manager)
    expect(deps.store).toBe(h.store)
    expect(deps.gitSync).toBe(h.gitSync)
    deps.exit()
    expect(app.exit).toHaveBeenCalledWith(0)

    // `app.exit` fires no quit events, but a second ⌘Q while flushing must not start a second sequence.
    const again = { preventDefault: vi.fn() }
    quit(again)
    expect(again.preventDefault).toHaveBeenCalled()
    expect(runQuitSequence).toHaveBeenCalledTimes(1)
  })
})
