import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { isRecord } from '@shared/guards'
import { CH } from '../../channels'
import { BridgeFailure } from '../fs/fsUtils'
import type { Secrets } from '../secrets'
import { DRAWIO_SHARE_DIRS, DRAWIO_SHARE_FILES } from '../drawio/assets'
import { CLOUDFLARE_API, CLOUDFLARE_TOKEN_PAGE, type AssetFile } from '../share/cloudflare'
import { shareFsHooks } from '../share/fsHooks'
import { createSharing } from '../share/sharing'
import workerSource from '../../../../share/worker.js?raw'
import viewerSource from '../../../../share/viewer/page.js?raw'
import { broadcastAll } from './broadcast'
import { handle, handleWithEvent } from './envelope'

/**
 * The `share.*` half of `window.yaseenDraw` (YAZ-1799). Every request is shape-checked
 * here; the token crosses the bridge exactly once (renderer → main, in `share:setup`) and is never
 * sent back. Progress goes to the window that asked; changes go to every window.
 *
 * The demo switches are read by `shareEndpoints` and only in an unpackaged (dev) build.
 */
const req = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new BridgeFailure('BAD_REQUEST', 'missing request')
  return v
}
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') throw new BridgeFailure('BAD_REQUEST', `'${name}' must be a non-empty string`)
  return v
}

/**
 * Where the viewer's built assets live (`tools/buildShareViewer.mjs` → `share/dist/assets/`, part of
 * `npm run build`): the packaged app carries them as the `share-viewer` extraResource; dev reads the
 * repo checkout beside `desktop/`.
 */
export function viewerAssetsDir({ isPackaged, resourcesPath, appPath }: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return isPackaged ? join(resourcesPath, 'share-viewer') : join(appPath, '..', 'share', 'dist', 'assets')
}

/**
 * Excalidraw's font files, which the viewer fetches from `/assets/fonts/` (YAZ-2073 3C): the packaged
 * app's ONE copy, beside the renderer bundle in the asar (`excalidrawAssets()` in
 * `electron.vite.config.ts`); dev reads the package itself, wherever npm hoisted it — the same bytes.
 */
export function excalidrawFontsDir({ isPackaged, mainDir, appPath, exists }: { isPackaged: boolean; mainDir: string; appPath: string; exists: (p: string) => boolean }): string {
  if (isPackaged) return resolve(mainDir, '..', 'renderer', 'excalidraw-assets', 'fonts')
  const inPackage = (base: string) => join(base, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')
  const repo = join(appPath, '..')
  return [inPackage(repo), inPackage(join(repo, 'client'))].find(exists) ?? inPackage(repo)
}

/**
 * The Worker's static assets: the viewer build's own files as `/assets/…`, Excalidraw's fonts as
 * `/assets/fonts/…` from `fontsDir` (`excalidrawFontsDir`, YAZ-2073 3C), and the draw.io files and
 * folders a shared diagram runs (`DRAWIO_SHARE_FILES` / `DRAWIO_SHARE_DIRS`) as `/assets/drawio/…`,
 * read from the app's own draw.io webapp (🔒 YAZ-1802 D5 / D11, YAZ-1973) — the pack cache in dev,
 * `out/drawio` inside the packaged app's asar. Neither is a second copy of those bytes in `share-viewer`.
 */
export async function readViewerAssets(dir: string, drawioDir: string, fontsDir: string): Promise<AssetFile[]> {
  const missing = (what: string, run: string) => () => {
    throw new BridgeFailure('NOT_FOUND', `${what} is not built on this computer (run: ${run}), so sharing cannot be set up yet.`)
  }
  const notBuilt = missing('The viewer page', 'npm run build')
  await readdir(drawioDir).catch(missing('draw.io', 'npm run drawio:pack'))
  /** Every file under `root`, published at `prefix` + its path relative to `base`. */
  const filesUnder = async (root: string, base: string, prefix: string) =>
    (await readdir(root, { recursive: true, withFileTypes: true }).catch(notBuilt))
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .map((abs) => ({ path: `${prefix}${relative(base, abs).split(sep).join('/')}`, abs }))
  const own = await filesUnder(dir, dir, '/assets/')
  const fonts = await filesUnder(fontsDir, fontsDir, '/assets/fonts/')
  const drawioFiles = DRAWIO_SHARE_FILES.map((file) => ({ path: `/assets/drawio/${file}`, abs: join(drawioDir, ...file.split('/')) }))
  const drawioDirs = (await Promise.all(DRAWIO_SHARE_DIRS.map((sub) => filesUnder(join(drawioDir, sub), drawioDir, '/assets/drawio/')))).flat()
  return Promise.all([...own, ...fonts, ...drawioFiles, ...drawioDirs].map(async ({ path, abs }) => ({ path, bytes: new Uint8Array(await readFile(abs).catch(notBuilt)) })))
}

/**
 * Where sharing talks to. DEMO SWITCHES, honoured ONLY when the app is not packaged — a shipped app
 * always sends the real token to the real Cloudflare, whatever the environment says:
 *  - `YASEEN_DRAW_CLOUDFLARE_API` — the Cloudflare API base (`tools/fakeCloudflare.mjs` in the demo).
 *  - `YASEEN_DRAW_SHARE_ORIGIN` — where Worker requests and links go instead of `*.workers.dev`.
 * The token page follows the API: the demo's lives on the fake server, production opens Cloudflare's own.
 */
export function shareEndpoints(isPackaged: boolean, env: Record<string, string | undefined>): { apiBase: string; demoOrigin: string | null; tokenPage: string } {
  const apiBase = (!isPackaged && env.YASEEN_DRAW_CLOUDFLARE_API?.trim()) || CLOUDFLARE_API
  const demoOrigin = (!isPackaged && env.YASEEN_DRAW_SHARE_ORIGIN?.trim().replace(/\/+$/, '')) || null
  const tokenPage = apiBase === CLOUDFLARE_API ? CLOUDFLARE_TOKEN_PAGE : `${new URL(apiBase).origin}/__fake/token-page`
  return { apiBase, demoOrigin, tokenPage }
}

export function registerShareIpc(userData: string, secrets: Secrets, where: { viewerAssetsDir: string; drawioDir: string; fontsDir: string; isPackaged: boolean }): void {
  const { apiBase, demoOrigin, tokenPage } = shareEndpoints(where.isPackaged, process.env)
  const sharing = createSharing({
    secrets,
    configFile: join(userData, 'sharing.json'),
    apiBase,
    demoOrigin,
    // Uploaded verbatim: the same two files `tools/fakeCloudflare.mjs` imports and runs.
    modules: { 'worker.js': workerSource, 'viewer/page.js': viewerSource },
    readAssets: () => readViewerAssets(where.viewerAssetsDir, where.drawioDir, where.fontsDir),
    onChanged: () => broadcastAll(CH.shareChanged),
  })
  // Shares follow in-app renames, moves and deletes (the fs IPC calls these beside its favorites repair).
  shareFsHooks.renamed = (roots, oldPath, newPath) => sharing.relocate(roots, oldPath, newPath)
  shareFsHooks.deleted = (roots, path) => sharing.forget(roots, path)

  handle(CH.shareStatus, () => sharing.status())
  handle(CH.shareAccounts, async (body: unknown) => sharing.accounts(str(req(body).token, 'token')))
  handleWithEvent(CH.shareSetup, (e, body: unknown) => {
    const r = req(body)
    if (r.accountId !== undefined && typeof r.accountId !== 'string') throw new BridgeFailure('BAD_REQUEST', "'accountId' must be a string")
    return sharing.setup(str(r.token, 'token'), (p) => e.sender.isDestroyed() || e.sender.send(CH.shareSetupProgress, p), r.accountId)
  })
  handle(CH.shareOpenCloudflare, async () => void (await shell.openExternal(tokenPage)))
  handle(CH.shareGet, async (body: unknown) => {
    const r = req(body)
    return sharing.get(str(r.root, 'root'), str(r.path, 'path'))
  })
  handle(CH.shareList, async (body: unknown) => {
    const r = req(body)
    if (r.check !== undefined && typeof r.check !== 'boolean') throw new BridgeFailure('BAD_REQUEST', "'check' must be a boolean")
    return sharing.list(str(r.root, 'root'), { check: r.check !== false })
  })
  handle(CH.sharePublish, async (body: unknown) => {
    const r = req(body)
    if (r.id !== undefined && typeof r.id !== 'string') throw new BridgeFailure('BAD_REQUEST', "'id' must be a string")
    return sharing.publish(str(r.root, 'root'), str(r.path, 'path'), str(r.content, 'content'), r.id)
  })
  handle(CH.shareSetPermission, async (body: unknown) => {
    const r = req(body)
    if (typeof r.allowDownload !== 'boolean') throw new BridgeFailure('BAD_REQUEST', "'allowDownload' must be a boolean")
    return sharing.setPermission(str(r.root, 'root'), str(r.path, 'path'), r.allowDownload)
  })
  handle(CH.shareStop, async (body: unknown) => {
    const r = req(body)
    return sharing.stop(str(r.root, 'root'), str(r.path, 'path'))
  })
  handle(CH.shareSetDomain, async (body: unknown) => {
    const h = req(body).hostname
    if (h !== null && typeof h !== 'string') throw new BridgeFailure('BAD_REQUEST', "'hostname' must be a string or null")
    return sharing.setDomain(h === null || h.trim() === '' ? null : h)
  })
  handle(CH.shareDisconnect, async (body: unknown) => {
    const r = req(body)
    if (r.root !== null && typeof r.root !== 'string') throw new BridgeFailure('BAD_REQUEST', "'root' must be a string or null")
    return sharing.disconnect(r.root, r.deleteEverything === true)
  })
}
