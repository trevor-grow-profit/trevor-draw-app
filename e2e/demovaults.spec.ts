/**
 * The repo's own demo vaults (tools/seed*.mjs), opened the way a hand pass opens them: every awkward
 * case each one was built for must open, fail readably or preview — never crash or hang.
 */
import { readdirSync } from 'node:fs'
import { test, expect } from './support/fixtures'
import { canvasReady } from './support/canvas'
import { glance, row, treeReady } from './support/sidebar'
import { runSeed } from './support/vault'

const cantOpen = "This Excalidraw drawing can't be opened"

test('seedDemoVault: the stress cases open — 40 images, a 10 MB picture, legacy, missing asset — and broken ones say why', async ({ sandbox, launch }) => {
  test.setTimeout(150_000)
  const vault = sandbox.path('Demo')
  runSeed('seedDemoVault.mjs', ['--vault', vault])
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  for (const board of ['01 Simple shapes', '02 Images from assets', '03 Legacy embedded', '04 Missing asset', '05 Image heavy 40', '06 Big image 10MB', '09 Upstream minimal', '12 Shares image with 02']) {
    await row(page, board).click()
    await expect(page.getByRole('tab', { name: board })).toHaveAttribute('aria-selected', 'true')
    await canvasReady(page)
    await expect(page.getByRole('alert').filter({ visible: true })).toHaveCount(0)
  }
  for (const board of ['07 Corrupt', '08 Empty file']) {
    await row(page, board).click()
    await expect(page.getByRole('alert').filter({ hasText: cantOpen }).filter({ visible: true })).toBeVisible()
  }
  await row(page, '13 Fifty boards').click()
  await expect(page.locator('[role=tree] .tree__label').filter({ hasText: /^Board \d\d$/ })).toHaveCount(50)
})

test('seedPreviewDemoVault: previews for pictures, deleted-only, corrupt and unreadable boards', async ({ sandbox, launch }) => {
  const vault = sandbox.path('Preview demo')
  runSeed('seedPreviewDemoVault.mjs', ['--vault', vault])
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await glance(page, '09 Images — three pictures from assets', (p) => p.locator('img.board-preview__img--loaded'))
  await glance(page, '13 Only deleted elements — should say Empty board', (p) => p.locator('.board-preview__msg').filter({ hasText: 'Empty board' }))
  await glance(page, '14 Corrupt — not JSON', (p) => p.locator('.board-preview__msg').filter({ hasText: 'Preview unavailable' }))
  await glance(page, 'Locked — chmod 000, cannot be read', (p) => p.locator('.board-preview__msg').filter({ hasText: 'Preview unavailable' }))
  await glance(page, '08 Dark canvas — navy background colour', (p) => p.locator('img.board-preview__img--loaded'))
})

test('seedDrawioDemoVault: big, multi-page, uppercase and picture diagrams open offline; the first sync keeps both copies', async ({ sandbox, launch }) => {
  test.setTimeout(150_000)
  const vault = sandbox.path('Drawio demo')
  runSeed('seedDrawioDemoVault.mjs', ['--vault', vault])
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const network = app.outsideRequests()
  const page = await app.window()
  await treeReady(page)
  // Sam changed two diagrams too: diagrams never merge, yours is kept beside theirs (🔒 YAZ-1802 D8).
  await expect.poll(() => readdirSync(vault).filter((name) => name.includes('(conflict, ')).length, { timeout: 30_000 }).toBe(2)
  const frame = page.locator('iframe.drawio-editor__frame').filter({ visible: true })
  for (const diagramName of ['Big — 2000 cells (speed test)', 'Multi-page — three pages (preview shows page 1)', 'UPPERCASE', 'Embedded image — data URI picture (must show)', 'Remote image — must NOT load (offline CSP blocks it)']) {
    await row(page, diagramName).click()
    await expect(frame).toBeVisible()
    await expect(frame.contentFrame().locator('.geDiagramContainer')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('alert').filter({ visible: true })).toHaveCount(0)
  }
  await row(page, 'Broken — corrupt, not XML').click()
  await expect(page.getByText(/This draw.io diagram can't be opened/).filter({ visible: true })).toBeVisible()
  // The remote picture is TRIED and blocked by draw.io's CSP: nothing may actually get through.
  expect(network.attempted.length).toBeGreaterThan(0)
  expect(network.reached).toEqual([])
})
