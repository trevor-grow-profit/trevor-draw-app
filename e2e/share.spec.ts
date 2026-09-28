/**
 * Share links (YAZ-1799) against tools/fakeCloudflare.mjs — a local stand-in for the Cloudflare API
 * that runs the REAL share Worker on 127.0.0.1. No request leaves the Mac. The app honours the two
 * endpoint overrides only when unpackaged, which is how this suite runs it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { PACKAGED, test as base, expect, type DrawApp, type Sandbox } from './support/fixtures'
import { canvasReady, drawRect } from './support/canvas'
import { contextMenu, row, treeReady } from './support/sidebar'
import { REPO, diagram, diagramBox, rect, scene } from './support/vault'

interface FakeCloudflare {
  origin: string
  env: Record<string, string>
}

const test = base.extend<{ cloudflare: FakeCloudflare }>({
  cloudflare: async ({ sandbox }, use) => {
    const child: ChildProcess = spawn(process.execPath, [join(REPO, 'tools/fakeCloudflare.mjs'), '--data', sandbox.path('fake-cloudflare'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out)
        if (m) resolve(m[1])
      })
      child.once('exit', (code) => reject(new Error(`fakeCloudflare exited ${code}: ${out}`)))
    })
    const origin = `http://127.0.0.1:${port}`
    await use({ origin, env: { YASEEN_DRAW_CLOUDFLARE_API: `${origin}/client/v4`, YASEEN_DRAW_SHARE_ORIGIN: origin } })
    child.kill()
  },
})

// The app honours YASEEN_DRAW_CLOUDFLARE_API / _SHARE_ORIGIN only unpackaged: a packaged run would
// talk to real Cloudflare, which this suite never does (docs/REGRESSION.md K1–K7 cover it by hand).
test.skip(PACKAGED, 'share links run only against the unpackaged app and the fake Cloudflare')

const shareDialog = (page: Page) => page.getByTestId('share-dialog')

async function setUpSharing(page: Page, token = 'demo-good'): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Sharing' }).click()
  await expect(dialog.getByTestId('sharing-status')).toContainText('Not set up')
  await dialog.getByRole('textbox', { name: 'Cloudflare API key' }).fill(token)
  await dialog.getByTestId('sharing-setup').click()
}

async function launchShared(sandbox: Sandbox, launch: (o?: { env?: Record<string, string> }) => Promise<DrawApp>, cloudflare: FakeCloudflare, files: Record<string, string>, file?: string) {
  const vault = sandbox.vault('Shared vault', files)
  sandbox.writeProfile({ windows: [{ root: vault, file: file === undefined ? null : `${vault}/${file}` }] })
  const app = await launch({ env: cloudflare.env })
  const page = await app.window()
  await treeReady(page)
  await setUpSharing(page)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByTestId('sharing-status')).toContainText('Sharing ready', { timeout: 30_000 })
  await settings.getByRole('button', { name: 'Close settings' }).click()
  return { vault, app, page }
}

/** Right-click › Share › Anyone with the link, then Done once the first upload is up. */
async function shareBoard(page: Page, label: string): Promise<void> {
  await contextMenu(page, label, 'Share')
  await shareDialog(page).getByTestId('share-access').click()
  await page.getByRole('menuitemradio', { name: 'Anyone with the link' }).click()
  await expect(shareDialog(page).getByTestId('share-live')).toContainText('Up to date', { timeout: 30_000 })
  await shareDialog(page).getByTestId('share-done').click()
}

const shareOf = (page: Page, root: string, path: string) => page.evaluate((req) => window.yaseenDraw.share.get(req), { root, path })

test('setting up sharing walks every step against the (fake) Cloudflare account', async ({ sandbox, launch, cloudflare }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch({ env: cloudflare.env })
  const page = await app.window()
  await setUpSharing(page)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const steps = dialog.getByTestId('sharing-steps')
  await expect(dialog.getByTestId('sharing-status')).toContainText('Sharing ready', { timeout: 30_000 })
  for (const step of ['verify', 'account', 'bucket', 'viewer', 'worker', 'subdomain', 'test']) {
    await expect(steps.locator(`[data-step="${step}"]`)).toHaveAttribute('data-state', 'done')
  }
  // The key is a secret: it went to secrets.json, never to the state file.
  expect(readFileSync(`${sandbox.profile}/yaseendraw.json`, 'utf8')).not.toContain('demo-good')
})

test('a bad key is refused with the reason, and nothing is set up', async ({ sandbox, launch, cloudflare }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch({ env: cloudflare.env })
  const page = await app.window()
  await setUpSharing(page, 'demo-invalid')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByTestId('sharing-status')).toContainText('Not set up')
})

test('sharing a board makes a live link; View only blocks the download; Not shared takes it down', async ({ sandbox, launch, cloudflare }) => {
  const { vault, page } = await launchShared(sandbox, launch, cloudflare, { 'Plan.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Plan.excalidraw`
  await contextMenu(page, 'Plan', 'Share')
  await expect(shareDialog(page)).toBeVisible()
  await shareDialog(page).getByTestId('share-access').click()
  await page.getByRole('menuitemradio', { name: 'Anyone with the link' }).click()
  await expect(shareDialog(page).getByTestId('share-live')).toContainText('Up to date', { timeout: 30_000 })
  const entry = await shareOf(page, vault, board)
  expect(entry?.url).toBe(`${cloudflare.origin}/b/${entry?.id}`)
  await expect(row(page, 'Plan').locator('.tree__share')).toBeVisible() // the tree marks shared boards
  const id = entry?.id ?? ''
  expect((await fetch(`${cloudflare.origin}/b/${id}`)).status).toBe(200)
  const sharedScene = (await (await fetch(`${cloudflare.origin}/scene/${id}`)).json()) as { elements: { id: string }[] }
  expect(sharedScene.elements.map((el) => el.id)).toEqual(['a'])
  expect((await fetch(`${cloudflare.origin}/raw/${id}`)).status).toBe(200)

  await shareDialog(page).getByTestId('share-permission').click()
  await page.getByRole('menuitemradio', { name: 'View only' }).click()
  await expect.poll(async () => (await fetch(`${cloudflare.origin}/raw/${id}`)).status).toBe(403)

  await shareDialog(page).getByTestId('share-access').click()
  await page.getByRole('menuitemradio', { name: 'Not shared' }).click()
  await expect.poll(async () => (await fetch(`${cloudflare.origin}/b/${id}`)).status).toBe(404)
  await expect.poll(() => shareOf(page, vault, board)).toBeNull()
})

test('a shared board re-uploads itself after an edit settles', async ({ sandbox, launch, cloudflare }) => {
  const { vault, page } = await launchShared(sandbox, launch, cloudflare, { 'Live.excalidraw': scene([rect('a')]) }, 'Live.excalidraw')
  await canvasReady(page)
  await shareBoard(page, 'Live')
  const entry = await shareOf(page, vault, `${vault}/Live.excalidraw`)
  await drawRect(page)
  // The live re-upload waits for 10 s of quiet, then sends the new scene.
  await expect.poll(async () => ((await (await fetch(`${cloudflare.origin}/scene/${entry?.id}`)).json()) as { elements: unknown[] }).elements.length, { timeout: 45_000 }).toBe(2)
})

test('a diagram shares too, and its link serves the diagram', async ({ sandbox, launch, cloudflare }) => {
  const { vault, page } = await launchShared(sandbox, launch, cloudflare, { 'Flow.drawio': diagram(diagramBox('c1', 'Shared box')) })
  await shareBoard(page, 'Flow')
  const entry = await shareOf(page, vault, `${vault}/Flow.drawio`)
  expect((await fetch(`${cloudflare.origin}/b/${entry?.id}`)).status).toBe(200)
  expect(await (await fetch(`${cloudflare.origin}/raw/${entry?.id}`)).text()).toContain('Shared box')
})

test('before setup, Share explains and sends you to Settings › Sharing', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await app.menu('menu.file.share-link', page)
  await expect(shareDialog(page)).toContainText("Sharing isn't set up")
  await page.getByTestId('share-setup').click()
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByTestId('sharing-status')).toContainText('Not set up')
})
