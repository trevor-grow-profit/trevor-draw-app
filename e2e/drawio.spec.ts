/**
 * draw.io diagrams (docs/CONTRACTS.md "draw.io diagrams", YAZ-1802): the pruned webapp on its own
 * `app://drawio` origin, the overlay handshake, autosave of plain XML with dates, outside changes,
 * broken files, and the menu's per-kind enablement.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { FrameLocator, Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { row, treeReady } from './support/sidebar'
import { diagram, diagramBox, scene, writesSettled } from './support/vault'

const editorFrame = (page: Page): FrameLocator => page.frameLocator('iframe.drawio-editor__frame')
const cellCount = (path: string) => (readFileSync(path, 'utf8').match(/<mxCell id="(?!0"|1")/g) ?? []).length

test('a diagram opens in draw.io on app://drawio, offline and locked down, after the overlay’s handshake', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Hello box')), 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const requests: string[] = []
  app.electron.context().on('request', (req) => requests.push(req.url()))
  const page = await app.window()
  await treeReady(page)
  await page.evaluate(() => {
    const w = window as unknown as { __drawioEvents: string[] }
    w.__drawioEvents = []
    window.addEventListener('message', (e) => {
      if (e.origin !== 'app://drawio' || typeof e.data !== 'string') return
      w.__drawioEvents.push((JSON.parse(e.data) as { event: string }).event)
    })
  })
  await row(page, 'Flow').click()
  await expect(editorFrame(page).getByText('Hello box')).toBeVisible({ timeout: 30_000 })
  const src = new URL((await page.locator('iframe.drawio-editor__frame').getAttribute('src')) ?? '')
  expect(`${src.protocol}//${src.host}`).toBe('app://drawio')
  expect(Object.fromEntries(src.searchParams)).toMatchObject({ embed: '1', offline: '1', lockdown: '1', stealth: '1', ui: 'simple' })
  const events = await page.evaluate(() => (window as unknown as { __drawioEvents: string[] }).__drawioEvents)
  expect(events).toContain('yaseenReady')
  expect(events.indexOf('yaseenReady')).toBeLessThan(events.indexOf('load'))
  expect(requests.filter((url) => !/^(app|data|blob):/.test(url))).toEqual([])
  await expect(page.getByRole('tab', { name: /Flow/ }).getByRole('img', { name: 'draw.io diagram' })).toBeVisible()
})

test('an edit in draw.io autosaves plain XML with the diagram’s own dates, and never rewrites a clean diagram', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Hello box')) })
  const file = `${vault}/Flow.drawio`
  const original = readFileSync(file, 'utf8')
  sandbox.writeProfile({ windows: [{ root: vault, file }] })
  const app = await launch()
  const page = await app.window()
  const box = editorFrame(page).getByText('Hello box')
  await expect(box).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  expect(readFileSync(file, 'utf8')).toBe(original) // opened, not written
  await box.click()
  await page.keyboard.press('Meta+d') // duplicate the selected box
  await expect.poll(() => cellCount(file)).toBe(2)
  const xml = readFileSync(file, 'utf8')
  expect(xml).toMatch(/^<mxfile yaseendraw-created="[\d.]+" yaseendraw-updated="\d+"/)
  expect(xml).not.toContain('compressed="true"')
  expect(xml).toContain('<mxGraphModel')
})

test('an outside change to a clean diagram reloads it in the editor', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Before')) })
  const file = `${vault}/Flow.drawio`
  sandbox.writeProfile({ windows: [{ root: vault, file }] })
  const app = await launch()
  const page = await app.window()
  await expect(editorFrame(page).getByText('Before')).toBeVisible({ timeout: 30_000 })
  writeFileSync(file, diagram(diagramBox('c1', 'After the outside edit')))
  await expect(editorFrame(page).getByText('After the outside edit')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('an edit to a diagram survives ⌘Q straight after it', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Only box here')) })
  const file = `${vault}/Flow.drawio`
  sandbox.writeProfile({ windows: [{ root: vault, file }] })
  const app = await launch()
  const page = await app.window()
  const box = editorFrame(page).getByText('Only box here')
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.click()
  await page.keyboard.press('Meta+d')
  await app.quit()
  expect(cellCount(file)).toBe(2)
})

test('a broken diagram shows why it cannot open; a compressed one opens and its first save is plain XML', async ({ sandbox, launch }) => {
  const plain = diagram(diagramBox('c1', 'Packed label'))
  const page1 = plain.match(/<mxGraphModel[\s\S]*<\/mxGraphModel>/)?.[0] ?? ''
  const { deflateRawSync } = await import('node:zlib')
  const packed = deflateRawSync(Buffer.from(encodeURIComponent(page1))).toString('base64')
  const vault = sandbox.vault('V', {
    'Broken.drawio': 'this is not xml at all',
    'Packed.drawio': `<mxfile><diagram id="p1" name="Page-1">${packed}</diagram></mxfile>\n`,
  })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Broken.drawio` }] })
  const app = await launch()
  const page = await app.window()
  await expect(page.getByText(/This draw.io diagram can't be opened: .*not a draw.io diagram/)).toBeVisible()
  await row(page, 'Packed').click()
  const box = editorFrame(page).getByText('Packed label')
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.click()
  await page.keyboard.press('Meta+d')
  await expect.poll(() => cellCount(`${vault}/Packed.drawio`)).toBe(2)
  await writesSettled(`${vault}/Packed.drawio`)
  expect(readFileSync(`${vault}/Packed.drawio`, 'utf8')).toContain('<mxGraphModel')
})

test('the menu enables Export Image for a diagram but not the drawing-only items', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Only box here')), 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Flow.drawio` }] })
  const app = await launch()
  const page = await app.window()
  await expect(editorFrame(page).getByText('Only box here')).toBeVisible({ timeout: 30_000 })
  await app.focus(page)
  await expect.poll(() => app.menuEnabled('menu.file.export-image')).toBe(true)
  expect(await app.menuEnabled('menu.file.export-drawing')).toBe(false)
  expect(await app.menuEnabled('menu.view.canvas-background')).toBe(false)
  expect(await app.menuEnabled('menu.file.share-link')).toBe(true)
  await row(page, 'Board').click()
  await expect.poll(() => app.menuEnabled('menu.file.export-drawing')).toBe(true)
  expect(await app.menuEnabled('menu.view.canvas-background')).toBe(true)
  await app.menu('menu.file.close-tab', page)
  await expect.poll(() => app.menuEnabled('menu.file.export-image')).toBe(false)
})
