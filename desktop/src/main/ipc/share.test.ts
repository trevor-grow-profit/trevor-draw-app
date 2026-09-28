import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { CONTRACT } from '@shared/ipc'
import { CLOUDFLARE_API, CLOUDFLARE_TOKEN_PAGE } from '../share/cloudflare'
import { createSecrets } from '../secrets'
import { excalidrawFontsDir, readViewerAssets, registerShareIpc, shareEndpoints, viewerAssetsDir } from './share'
import { registered } from './ipcFixture'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))

describe('viewerAssetsDir', () => {
  const where = { resourcesPath: '/Applications/Yaseen Draw.app/Contents/Resources', appPath: '/repo/desktop' }

  it('reads the extraResource inside a packaged app', () => {
    expect(viewerAssetsDir({ ...where, isPackaged: true })).toBe(path.join(where.resourcesPath, 'share-viewer'))
  })

  it('reads the repo checkout beside desktop/ in dev', () => {
    expect(viewerAssetsDir({ ...where, isPackaged: false })).toBe(path.join('/repo', 'share', 'dist', 'assets'))
  })
})

describe('excalidrawFontsDir (YAZ-2073 3C)', () => {
  it("reads the renderer's own copy inside a packaged app's asar", () => {
    const mainDir = '/Applications/Yaseen Draw.app/Contents/Resources/app.asar/out/main'
    expect(excalidrawFontsDir({ isPackaged: true, mainDir, appPath: '/unused', exists: () => false })).toBe(path.resolve(mainDir, '..', 'renderer', 'excalidraw-assets', 'fonts'))
  })

  it('reads the package where npm installed it in dev: the repo root first, then client/', () => {
    const root = path.join('/repo', 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')
    const client = path.join('/repo', 'client', 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')
    const where = { isPackaged: false, mainDir: '/repo/desktop/out/main', appPath: '/repo/desktop' }
    expect(excalidrawFontsDir({ ...where, exists: (p) => p === root || p === client })).toBe(root)
    expect(excalidrawFontsDir({ ...where, exists: (p) => p === client })).toBe(client)
  })
})

describe('readViewerAssets (🔒 YAZ-1802 D5 / D11)', () => {
  let root = ''
  beforeEach(async () => void (root = await mkdtemp(path.join(tmpdir(), 'yaz-1973-assets-'))))
  afterEach(async () => rm(root, { recursive: true, force: true }))
  const put = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }

  it("publishes the viewer build as /assets/…, and draw.io's viewer, stencils, licence, image and MathJax folders from the app's own webapp", async () => {
    const viewer = path.join(root, 'share-viewer')
    const drawio = path.join(root, 'drawio')
    await put(path.join(viewer, 'viewer.js'), 'viewer')
    await put(path.join(viewer, 'drawio', 'config.js'), 'config')
    const fonts = path.join(root, 'excalidraw-fonts')
    for (const file of ['js/viewer-static.min.js', 'js/stencils.min.js', 'LICENSE-drawio.txt', 'js/app.min.js', 'img/lib/azure/VM.svg', 'math4/es5/startup.js']) await put(path.join(drawio, file), file)
    await put(path.join(fonts, 'Excalifont', 'Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2'), 'excalifont')
    const assets = await readViewerAssets(viewer, drawio, fonts)
    expect(Object.fromEntries(assets.map((a) => [a.path, new TextDecoder().decode(a.bytes)]))).toEqual({
      '/assets/viewer.js': 'viewer',
      '/assets/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2': 'excalifont',
      '/assets/drawio/config.js': 'config',
      '/assets/drawio/js/viewer-static.min.js': 'js/viewer-static.min.js',
      '/assets/drawio/js/stencils.min.js': 'js/stencils.min.js',
      '/assets/drawio/LICENSE-drawio.txt': 'LICENSE-drawio.txt',
      '/assets/drawio/img/lib/azure/VM.svg': 'img/lib/azure/VM.svg',
      '/assets/drawio/math4/es5/startup.js': 'math4/es5/startup.js',
    })
  })

  it('refuses to set up with no viewer build, no fonts or no draw.io webapp, rather than upload a page that cannot draw', async () => {
    await put(path.join(root, 'share-viewer', 'viewer.js'), 'viewer')
    await put(path.join(root, 'fonts', 'Assistant', 'Assistant-Regular.woff2'), 'assistant')
    const fonts = path.join(root, 'fonts')
    await expect(readViewerAssets(path.join(root, 'nothing'), root, fonts)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('npm run build') })
    await expect(readViewerAssets(path.join(root, 'share-viewer'), root, path.join(root, 'no-fonts'))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('npm install') })
    await expect(readViewerAssets(path.join(root, 'share-viewer'), path.join(root, 'no-drawio'), fonts)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('npm run drawio:pack') })
  })
})

describe('shareEndpoints — the demo switches are dev-only', () => {
  const demo = { YASEEN_DRAW_CLOUDFLARE_API: 'http://127.0.0.1:8799/client/v4', YASEEN_DRAW_SHARE_ORIGIN: 'http://localhost:8799/' }

  it('a packaged app ignores both env vars: the real token only ever goes to the real Cloudflare', () => {
    expect(shareEndpoints(true, demo)).toEqual({ apiBase: CLOUDFLARE_API, demoOrigin: null, tokenPage: CLOUDFLARE_TOKEN_PAGE })
  })

  it('a dev build honours them, and the token page follows the fake API', () => {
    expect(shareEndpoints(false, demo)).toEqual({ apiBase: demo.YASEEN_DRAW_CLOUDFLARE_API, demoOrigin: 'http://localhost:8799', tokenPage: 'http://127.0.0.1:8799/__fake/token-page' })
  })

  it('a dev build with neither set is production', () => {
    expect(shareEndpoints(false, { YASEEN_DRAW_CLOUDFLARE_API: ' ', YASEEN_DRAW_SHARE_ORIGIN: '' })).toEqual({ apiBase: CLOUDFLARE_API, demoOrigin: null, tokenPage: CLOUDFLARE_TOKEN_PAGE })
  })
})

describe('registerShareIpc refuses malformed requests before sharing sees them', () => {
  const bad = expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'BAD_REQUEST' }) })
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() }
  let userData: string
  beforeEach(async () => {
    vi.mocked(ipcMain.handle).mockClear()
    userData = await mkdtemp(path.join(tmpdir(), 'yd-share-ipc-'))
    registerShareIpc(userData, createSecrets(path.join(userData, 'secrets.json')), { viewerAssetsDir: path.join(userData, 'none'), drawioDir: path.join(userData, 'none'), fontsDir: path.join(userData, 'none'), isPackaged: true })
  })
  afterEach(() => rm(userData, { recursive: true, force: true }))

  it.each([
    [CONTRACT.share.accounts.channel, [[], [''], [3], [{ token: 't' }]]],
    [CONTRACT.share.setup.channel, [[], [''], ['t', 3]]],
    [CONTRACT.share.get.channel, [[{ root: '/v' }], [{ path: 'a.excalidraw' }], [{ root: '', path: 'a' }]]],
    [CONTRACT.share.list.channel, [[], [1], ['/v', 'no'], [{ root: '/v' }]]],
    [CONTRACT.share.publish.channel, [[{ root: '/v', path: 'a' }], [{ root: '/v', path: 'a', content: 'x', id: 7 }]]],
    [CONTRACT.share.setPermission.channel, [[{ root: '/v', path: 'a' }], [{ root: '/v', path: 'a', allowDownload: 'yes' }]]],
    [CONTRACT.share.stop.channel, [[{ root: '/v' }], [null]]],
    [CONTRACT.share.setDomain.channel, [[], [5], [{ hostname: null }]]],
    [CONTRACT.share.disconnect.channel, [[], [5, true], [null], [null, 'yes'], [{ root: null, deleteEverything: true }]]],
  ])('%s refuses %j with BAD_REQUEST', async (channel, calls) => {
    for (const args of calls) expect(await registered({ channel })({ sender }, ...args)).toEqual(bad)
  })
})
