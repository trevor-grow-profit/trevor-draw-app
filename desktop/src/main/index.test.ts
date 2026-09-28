/**
 * THE STARTUP ORDER in `index.ts` (YAZ-2073 1D) — the Electron wiring no other suite loads, with
 * Electron and the heavy modules stubbed and the real link queue, file-arg filter and profile
 * override left in. Each rule here is one a startup optimization (lazy imports, deferred IPC,
 * `ready-to-show`) could break without an error: a double-clicked board opening an empty window,
 * a profile override applied too late, image paste and export losing their secure context.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const s = {
    order: [] as string[],
    on: new Map<string, (...args: unknown[]) => void>(),
    ready: (): void => undefined,
    serveApp: null as ((req: { url: string }) => unknown) | null,
    windows: [] as Array<{ isDestroyed: () => boolean; isMinimized: () => boolean; restore: () => void; focus: () => void }>,
  }
  const log = (entry: string) => () => void s.order.push(entry)
  const app = {
    isPackaged: true,
    setName: vi.fn(),
    setPath: vi.fn((name: string) => s.order.push(`setPath:${name}`)),
    requestSingleInstanceLock: vi.fn(() => (s.order.push('singleInstanceLock'), true)),
    setAsDefaultProtocolClient: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      s.order.push(`on:${event}`)
      s.on.set(event, fn)
    }),
    whenReady: vi.fn(() => new Promise<void>((resolve) => (s.ready = () => (s.order.push('ready'), resolve())))),
    getPath: vi.fn(() => '/profile'),
    getAppPath: vi.fn(() => '/app'),
    quit: vi.fn(),
    exit: vi.fn(),
  }
  const manager = {
    restoreAll: vi.fn(log('restoreAll')),
    routeToFile: vi.fn((path: string) => s.order.push(`route:${path}`)),
    linkNotice: vi.fn(),
    idFor: vi.fn(),
    flushAllForQuit: vi.fn(async () => undefined),
  }
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(log('registerSchemesAsPrivileged')),
    handle: vi.fn((_scheme: string, fn: (req: { url: string }) => unknown) => void (s.serveApp = fn)),
  }
  const net = { fetch: vi.fn((url: string) => `fetched ${url}`) }
  return { s, app, manager, protocol, net, serveDrawio: vi.fn(() => 'drawio answer') }
})

vi.mock('electron', () => ({
  app: h.app,
  protocol: h.protocol,
  net: h.net,
  BrowserWindow: { getAllWindows: () => h.s.windows, getFocusedWindow: () => null },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
  powerMonitor: { on: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn(), getAllDisplays: vi.fn(() => []) },
  shell: { openExternal: vi.fn() },
}))
vi.mock('./store', () => ({ createStore: () => ({ get: () => ({ settings: { theme: 'light', libraryFolder: null }, windows: [], recents: [] }) }) }))
vi.mock('./windows', () => ({ createWindowManager: () => h.manager }))
vi.mock('./ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('./ipc/share', () => ({ viewerAssetsDir: () => '/viewer' }))
vi.mock('./drawio/assets', () => ({ resolveDrawioDir: () => '/drawio-pack', serveDrawio: h.serveDrawio }))
vi.mock('./library/folder', () => ({ ensureLibraryFolder: vi.fn(async () => undefined) }))
vi.mock('./theme', () => ({ subscribeNativeTheme: vi.fn(), windowBackgroundColor: vi.fn() }))
vi.mock('./menu', () => ({
  buildContextMenuTemplate: vi.fn(),
  buildMenuTemplate: vi.fn(() => []),
  createMenuHandlers: vi.fn(() => ({})),
  pickMenuTargetWindow: vi.fn(),
  subscribeMenuRebuild: vi.fn(),
  subscribeMenuRebuildOnActiveFile: vi.fn(),
}))

const BOARD = '/vault/Plans/Board.excalidraw'
const event = () => ({ preventDefault: vi.fn() })
/** Lets `whenReady().then(…)` run to its end. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(h.s, { order: [], on: new Map(), serveApp: null, windows: [] })
  vi.stubEnv('YASEEN_DRAW_USER_DATA_DIR', '/tmp/isolated-profile')
  vi.resetModules()
  await import('./index')
})

describe('main startup order (YAZ-2073 1D)', () => {
  it('applies the isolated profile before the single-instance lock, so a test profile runs beside the real app', () => {
    expect(h.app.setPath).toHaveBeenCalledWith('userData', '/tmp/isolated-profile')
    expect(h.s.order.indexOf('setPath:userData')).toBeLessThan(h.s.order.indexOf('singleInstanceLock'))
  })

  it('registers app:// as standard + secure + fetch before ready — image paste, clipboard, export fonts and the subset worker need all three', () => {
    // secure → crypto.subtle (image file ids) and navigator.clipboard; standard → a real origin for
    // the SVG-export subset worker and relative URLs; supportFetchAPI → the engine fetches its fonts.
    expect(h.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([{ scheme: 'app', privileges: expect.objectContaining({ standard: true, secure: true, supportFetchAPI: true }) }])
    expect(h.s.order).not.toContain('ready')
  })

  it('listens for open-file and open-url before ready, and routes a cold-start double-click only after the windows are restored', async () => {
    expect(h.s.order).toEqual(expect.arrayContaining(['on:open-url', 'on:open-file']))
    expect(h.s.order).not.toContain('ready')
    const e = event()
    h.s.on.get('open-file')!(e, BOARD)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(h.manager.routeToFile).not.toHaveBeenCalled()
    h.s.ready()
    await settle()
    expect(h.s.order.slice(h.s.order.indexOf('ready'))).toEqual(['ready', 'restoreAll', `route:${BOARD}`])
  })

  it('after ready a link routes at once, and a bad one gets the notice instead of a route', async () => {
    h.s.ready()
    await settle()
    h.s.on.get('open-url')!(event(), 'yaseendraw:///vault/Plans/Board.excalidraw')
    expect(h.manager.routeToFile).toHaveBeenCalledWith(BOARD, null)
    h.s.on.get('open-url')!(event(), 'https://example.com')
    expect(h.manager.linkNotice).toHaveBeenCalledWith("Can't open link: https://example.com")
  })

  it('a second launch routes the board in its argv, and without one focuses the first window', async () => {
    h.s.ready()
    await settle()
    const win = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), focus: vi.fn() }
    h.s.windows = [win]
    h.s.on.get('second-instance')!(event(), ['/Applications/Yaseen Draw.app/Contents/MacOS/Yaseen Draw', BOARD])
    expect(h.manager.routeToFile).toHaveBeenCalledWith(BOARD, null)
    expect(win.focus).not.toHaveBeenCalled()
    h.s.on.get('second-instance')!(event(), ['/Applications/Yaseen Draw.app/Contents/MacOS/Yaseen Draw', '--flag'])
    expect([win.restore, win.focus].map((f) => f.mock.calls.length)).toEqual([1, 1])
  })

  it('serves app:// by host: app://drawio from the draw.io pack, everything else from the renderer build', async () => {
    h.s.ready()
    await settle()
    expect(h.s.serveApp!({ url: 'app://drawio/js/app.min.js' })).toBe('drawio answer')
    expect(h.serveDrawio).toHaveBeenCalledWith('/drawio-pack', '/js/app.min.js', expect.objectContaining({ noStore: false }))
    expect(h.s.serveApp!({ url: 'app://yaseen/' })).toMatch(/^fetched file:\/\/.*\/renderer\/index\.html$/)
    expect(h.s.serveApp!({ url: 'app://yaseen/assets/index-A.js' })).toMatch(/^fetched file:\/\/.*\/renderer\/assets\/index-A\.js$/)
  })
})
