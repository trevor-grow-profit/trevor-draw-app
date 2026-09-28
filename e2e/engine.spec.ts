/**
 * Engine doors reached through the fork's own UI, each a lazy chunk or a worker a bundle change can
 * orphan without an error (feature-safety-net §3 risk 7): the eraser, the frame tool, the stats
 * panel, element links, and SVG export with its font-subsetting worker.
 */
import { test, expect } from './support/fixtures'
import { canvasBox, clickEmpty } from './support/canvas'
import { liveElements, rect, scene, text } from './support/vault'

test('the eraser removes the shape it is dragged across', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene([rect('keep', -400, 0), rect('gone', 0, 0)]) })
  const box = await canvasBox(page)
  await page.getByRole('region', { name: 'Shapes' }).getByTestId('toolbar-eraser').click()
  // The fitted view centres the two boxes; sweep a line across the right-hand one's middle.
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.8, { steps: 20 })
  await page.mouse.up()
  await expect.poll(() => liveElements(board)?.map((el) => el.id)).toEqual(['keep'])
})

test('the frame tool (F) draws a named frame', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const box = await canvasBox(page)
  await clickEmpty(page)
  await page.keyboard.press('f')
  await page.mouse.move(box.x + 150, box.y + 150)
  await page.mouse.down()
  await page.mouse.move(box.x + 400, box.y + 350, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => liveElements(board)?.some((el) => el.type === 'frame')).toBe(true)
})

test('the stats panel (⌥/) counts the scene', async ({ openBoard }) => {
  const { page } = await openBoard({ 'Board.excalidraw': scene([rect('a'), rect('b', 300)]) })
  await clickEmpty(page)
  await page.keyboard.press('Alt+/')
  await expect(page.locator('.exc-stats')).toContainText('Shapes')
  await expect(page.locator('.exc-stats .exc-stats__row').filter({ hasText: 'Shapes' })).toContainText('2')
})

test('an element link (⌘K on a selection) is saved on the element', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene([rect('only')]) })
  await clickEmpty(page)
  await page.keyboard.press('Meta+a') // select everything
  await page.keyboard.press('Meta+k')
  const input = page.locator('.excalidraw-hyperlinkContainer-input')
  await expect(input).toBeVisible()
  await input.fill('https://example.com/spec')
  await input.press('Enter')
  await expect.poll(() => liveElements(board)?.[0]?.link).toBe('https://example.com/spec')
})

test('Export Image › SVG embeds the subset hand-drawn font (the subset worker ran)', async ({ openBoard }) => {
  const { app, page } = await openBoard({ 'Board.excalidraw': scene([text('t', 'Hand-drawn words', 0, 0), rect('a', 0, 60)]) })
  await app.menu('menu.file.export-image', page)
  const modal = page.locator('.ImageExportModal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('canvas, svg').first()).toBeVisible() // the preview rendered
  // The engine saves through the File System Access picker; answer it in the page instead of a native sheet.
  await page.evaluate(() => {
    const w = window as unknown as { __exported: Promise<string>; showSaveFilePicker: unknown }
    w.__exported = new Promise((resolve) => {
      w.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (blob: Blob) => resolve(await blob.text()), close: async () => {} }) })
    })
  })
  await modal.getByRole('button', { name: /SVG/ }).first().click()
  const svg = await page.evaluate(() => (window as unknown as { __exported: Promise<string> }).__exported)
  expect(svg).toContain('<svg')
  expect(svg).toMatch(/@font-face\s*{[^}]*font-family:\s*"Excalifont";\s*src:\s*url\(data:font\/woff2;base64,/)
})
