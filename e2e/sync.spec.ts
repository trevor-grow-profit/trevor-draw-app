/**
 * Per-vault GitHub sync with the system git against a LOCAL bare origin (YAZ-1081, YAZ-1801): the
 * chip, sync-now, the too-large guard, and Settings › Storage's "Move pictures out".
 */
import { closeSync, existsSync, openSync, readFileSync, ftruncateSync } from 'node:fs'
import { test, expect } from './support/fixtures'
import { canvasReady, drawRect } from './support/canvas'
import { row, treeReady } from './support/sidebar'
import { fileIdOf, gitIn, gitVault, imageElement, liveElements, png, readScene, rect, scene } from './support/vault'

test('the sync chip goes Pending after an edit and Synced after “sync now”, which commits and pushes', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const { origin } = gitVault(vault)
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await expect(page.getByRole('button', { name: 'Synced' })).toBeVisible()
  await drawRect(page)
  await expect.poll(() => liveElements(board)?.length).toBe(2)
  await expect(page.getByRole('button', { name: 'Pending' })).toBeVisible()
  await page.getByRole('button', { name: 'Pending' }).click()
  await expect(page.getByRole('button', { name: 'Synced' })).toBeVisible({ timeout: 30_000 })
  const pushed = JSON.parse(gitIn(origin, 'show', 'main:Board.excalidraw')) as { elements: unknown[] }
  expect(pushed.elements).toHaveLength(2)
  expect(gitIn(vault, 'status', '--porcelain')).toBe('')
})

test('a file over GitHub’s limit is held back: never committed, flagged in the tree and the chip', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const { origin } = gitVault(vault)
  // 96 MiB, sparse: over the 95 MiB guard without writing 96 MiB of bytes.
  const fd = openSync(`${vault}/Huge video.mov`, 'w')
  ftruncateSync(fd, 96 * 1024 * 1024)
  closeSync(fd)
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await expect(page.getByRole('button', { name: '1 file not synced' })).toBeVisible({ timeout: 30_000 })
  await expect(row(page, 'Huge video.mov').locator('.tree__too-large')).toBeVisible()
  expect(gitIn(vault, 'status', '--porcelain')).toContain('Huge video.mov')
  expect(gitIn(origin, 'ls-tree', '--name-only', 'main')).not.toContain('Huge video.mov')
})

test('Settings › Storage moves embedded pictures out of legacy boards into assets/', async ({ sandbox, launch }) => {
  const bytes = png(30, 30, [90, 30, 200])
  const id = fileIdOf(bytes)
  const legacy = scene([imageElement('img', id)], { files: { [id]: { id, mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}`, created: 1 } } })
  const vault = sandbox.vault('V', { 'Old one.excalidraw': legacy, 'Nested/Old two.excalidraw': legacy, 'Lean.excalidraw': scene([rect('a')]) })
  gitVault(vault, { sync: false })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Storage' }).click()
  await expect(dialog.getByText(/2 drawings still carry/)).toBeVisible()
  await dialog.getByTestId('storage-shrink').click()
  await expect(dialog.getByRole('status').filter({ hasText: /2 drawings .* lighter/ })).toBeVisible({ timeout: 30_000 })
  for (const board of ['Old one.excalidraw', 'Nested/Old two.excalidraw']) {
    expect(readScene(`${vault}/${board}`).files).toEqual({})
    expect(readScene(`${vault}/${board}`).elements.map((el) => el.fileId)).toEqual([id])
  }
  expect(existsSync(`${vault}/assets/${id}.png`)).toBe(true)
  expect(readFileSync(`${vault}/assets/${id}.png`)).toEqual(bytes)
})
