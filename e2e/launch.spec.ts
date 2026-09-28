/**
 * App launch and the first canvas: what a cold start must restore, and the shell guarantees the
 * engine silently depends on (feature-safety-net §3 risks 1, 3, 5).
 */
import { createHash } from 'node:crypto'
import { test, expect } from './support/fixtures'
import { canvasReady } from './support/canvas'
import { gitVault, readProfile, rect, scene, text } from './support/vault'

test('a first launch opens one Welcome window and writes a fresh state file', async ({ sandbox, launch }) => {
  const app = await launch()
  const page = await app.window()
  await expect(page.getByRole('heading', { name: 'Yaseen Draw' })).toBeVisible()
  await expect(page.getByText('No recent folders yet.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open folder…' })).toBeEnabled()
  await app.quit()
  const state = readProfile(sandbox.profile)
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0].root).toBeNull()
})

test('Welcome lists recents; a gone one says so when clicked, a live one opens in this window', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('Notes', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: null }], recents: [vault, sandbox.path('Gone vault')] })
  const app = await launch()
  const page = await app.window()
  const gone = page.locator('button.welcome__recent').filter({ hasText: 'Gone vault' })
  await gone.click()
  await expect(gone).toBeDisabled()
  await expect(gone).toContainText('Folder not found')
  await page.locator('button.welcome__recent').filter({ hasText: 'Notes' }).click()
  await expect(page.getByRole('treeitem', { name: 'Board' })).toBeVisible()
  expect((await page.evaluate(() => window.yaseenDraw.window.identity())).root).toBe(vault)
})

test('a relaunch restores every window with its tabs, active tab and bounds', async ({ sandbox, launch }) => {
  const a = sandbox.vault('A', { 'One.excalidraw': scene([rect('r1')]), 'Two.excalidraw': scene([rect('r2')]) })
  const b = sandbox.vault('B', { 'Three.excalidraw': scene([rect('r3')]) })
  sandbox.writeProfile({
    windows: [
      { root: a, tabs: [`${a}/One.excalidraw`, `${a}/Two.excalidraw`], file: `${a}/Two.excalidraw`, bounds: { x: 60, y: 60, width: 1100, height: 760 } },
      { root: b, tabs: [`${b}/Three.excalidraw`], bounds: { x: 120, y: 90, width: 1000, height: 700 } },
    ],
  })
  const app = await launch()
  const pages = await app.windows(2)
  const byRoot = async (root: string) => {
    for (const p of pages) if ((await p.evaluate(() => window.yaseenDraw.window.identity())).root === root) return p
    throw new Error(`no window on ${root}`)
  }
  const pa = await byRoot(a)
  await expect(pa.getByRole('tab', { name: 'One' })).toBeVisible()
  await expect(pa.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true')
  await canvasReady(pa)
  const pb = await byRoot(b)
  await expect(pb.getByRole('tab', { name: 'Three' })).toHaveAttribute('aria-selected', 'true')
  const bounds = await app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()).sort((x, y) => x.x - y.x))
  expect(bounds[0]).toMatchObject({ x: 60, width: 1100, height: 760 })
  expect(bounds[1]).toMatchObject({ x: 120, width: 1000, height: 700 })
})

test('a window names its vault and board in the title and the board path in the URL hash', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('Team Vault', { 'Plans/Roadmap.excalidraw': scene([rect('r')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Plans/Roadmap.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await expect(page).toHaveTitle('Roadmap — Team Vault')
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#${vault}/Plans/Roadmap.excalidraw`)
})

test('the renderer is a secure context on app:// (image ids, clipboard, workers depend on it)', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('r')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const probe = await page.evaluate(async () => {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('yaseen'))
    return {
      origin: location.origin,
      secure: isSecureContext,
      sha1: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      clipboard: typeof navigator.clipboard?.write,
      sandboxedBridge: typeof (window as unknown as { require?: unknown }).require,
    }
  })
  expect(probe).toEqual({ origin: 'app://yaseen', secure: true, sha1: createHash('sha1').update('yaseen').digest('hex'), clipboard: 'function', sandboxedBridge: 'undefined' })
})

test('opening a text board loads its fonts from the app itself and never touches the network', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Words.excalidraw': scene([text('t1', 'Hand-drawn words', 0, 0), rect('r', 0, 60)]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Words.excalidraw` }] })
  const app = await launch()
  const requests: string[] = []
  app.electron.context().on('request', (req) => requests.push(req.url()))
  const page = await app.window()
  await canvasReady(page)
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check('20px Excalifont')
  })).toBe(true)
  const fontRequests = requests.filter((url) => /\.woff2(\?|$)/.test(url))
  expect(fontRequests.length).toBeGreaterThan(0)
  expect(fontRequests.every((url) => url.startsWith('app://yaseen/'))).toBe(true)
  expect(requests.filter((url) => !/^(app|data|blob|devtools|chrome-extension):/.test(url))).toEqual([])
})

test('Settings › Storage measures a git vault on the storage worker', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('r')]) })
  gitVault(vault, { sync: false })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  const stats = await page.evaluate((root) => window.yaseenDraw.storage.stats(root), vault)
  expect(stats).toMatchObject({ root: vault, boards: { count: 1 }, large: [], embedded: { boards: 0 } })
  expect(stats.git?.historyBytes).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Storage' }).click()
  await expect(page.getByRole('img', { name: /of 10 GB/ })).toBeVisible()
})
