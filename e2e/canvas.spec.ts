/**
 * The Excalidraw canvas and its panel: engine tools that only exist as lazy chunks (laser, Mermaid),
 * the menu's board commands (export, background, zoom), and the workspace panel's Present,
 * Components and Images tabs (feature-safety-net "Excalidraw canvas" / "Canvas panel").
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect, type DrawApp } from './support/fixtures'
import { activeCanvas, canvasChanged, canvasReady, staticCanvasShot } from './support/canvas'
import { fileIdOf, frame, imageElement, liveElements, png, readScene, rect, scene, writeVault } from './support/vault'

/** Makes the next native Save sheet answer `path`, as if the user typed it and pressed Save. */
const answerSaveSheet = (app: DrawApp, path: string) =>
  app.electron.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, path)

const panel = (page: Page) => page.locator('.excalidraw')
const openPanelTab = async (page: Page, tab: 'Image Studio' | 'Components' | 'Presentation') => {
  await page.getByRole('button', { name: 'Open workspace panel' }).click()
  await panel(page).getByRole('tab', { name: tab }).click()
}

test('Export Excalidraw Drawing writes a standalone file with its pictures inside, leaving the board alone', async ({ sandbox, launch }) => {
  const bytes = png(12, 12, [200, 30, 30])
  const id = fileIdOf(bytes)
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a'), imageElement('img', id, 300, 0)]), [`assets/${id}.png`]: bytes })
  const board = `${vault}/Board.excalidraw`
  const before = statSync(board).mtimeMs
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const out = sandbox.path('Exported copy.excalidraw')
  await answerSaveSheet(app, out)
  await app.menu('menu.file.export-drawing', page)
  await expect(page.locator('.link-notice')).toContainText('Exported to Exported copy.excalidraw')
  const exported = readScene(out)
  expect(exported.elements.map((el) => el.id).sort()).toEqual(['a', 'img'])
  expect(exported.files?.[id]).toMatchObject({ mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}` })
  expect(statSync(board).mtimeMs).toBe(before)
})

test('Export Image… opens the engine’s image export for a drawing', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await app.menu('menu.file.export-image', page)
  const modal = page.locator('.ImageExportModal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('canvas, svg').first()).toBeVisible() // the preview rendered
})

test('Export Image… on a diagram writes the PNG the user named', async ({ sandbox, launch }) => {
  const vault = writeVault(sandbox.path('V'), {
    'Flow.drawio': '<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="c" value="Export me" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>\n',
  })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Flow.drawio` }] })
  const app = await launch()
  const page = await app.window()
  await expect(page.frameLocator('iframe.drawio-editor__frame').getByText('Export me')).toBeVisible({ timeout: 30_000 })
  const out = sandbox.path('Flow picture.png')
  await answerSaveSheet(app, out)
  await app.menu('menu.file.export-image', page)
  await expect.poll(() => existsSync(out), { timeout: 30_000 }).toBe(true)
  expect(readFileSync(out).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
})

test('View › Canvas Background changes the canvas and saves the colour into the board', async ({ sandbox, launch }) => {
  // PRODUCT BUG found by this suite (reported on YAZ-2073 1C): the colour is applied on screen but
  // never saved — autosave keys on `getSceneVersion` (element versions only), so an appState-only
  // change leaves the board "Saved"; quit and it is gone. Flip to a plain test when it is fixed.
  test.fail()
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const before = await staticCanvasShot(page)
  await app.menu('menu.view.canvas-background.3', page) // Yellow
  await canvasChanged(page, before)
  await app.quit()
  expect(readScene(board).appState?.viewBackgroundColor).toBe('#fffce8')
})

test('View › zoom in / out / actual size change the window’s zoom', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  const level = () => app.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())
  await app.menu('menu.view.zoom-in', page)
  await app.menu('menu.view.zoom-in', page)
  await expect.poll(level).toBe(1)
  await app.menu('menu.view.zoom-out', page)
  await expect.poll(level).toBe(0.5)
  await app.menu('menu.view.zoom-reset', page)
  await expect.poll(level).toBe(0)
})

test('the laser pointer draws a trail that is never saved into the board', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Board.excalidraw`
  const before = statSync(board).mtimeMs
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const laser = page.getByRole('region', { name: 'Shapes' }).getByTestId('toolbar-laser')
  await laser.click()
  await expect(laser).toHaveAttribute('aria-pressed', 'true')
  const box = await activeCanvas(page).boundingBox()
  if (box === null) throw new Error('no canvas')
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 500, box.y + 400, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(1_500) // longer than the autosave debounce: a saved stroke would be on disk
  expect(statSync(board).mtimeMs).toBe(before)
})

test('tool keys work on the canvas: R then a drag draws a rectangle', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const box = await activeCanvas(page).boundingBox()
  if (box === null) throw new Error('no canvas')
  await page.mouse.click(box.x + 600, box.y + 500) // focus the canvas on empty space
  await page.keyboard.press('r')
  await expect(page.getByTestId('toolbar-rectangle').filter({ visible: true })).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(box.x + 250, box.y + 250)
  await page.mouse.down()
  await page.mouse.move(box.x + 400, box.y + 350, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => liveElements(board)?.map((el) => el.type)).toEqual(['rectangle', 'rectangle'])
})

test('Mermaid to Excalidraw loads its lazy engine and inserts a flowchart', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await page.getByTestId('dropdown-menu-button').filter({ visible: true }).click()
  await page.getByRole('menuitem', { name: 'Mermaid to Excalidraw' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Mermaid to Excalidraw' })
  const editor = dialog.getByRole('textbox') // the lazy CodeMirror chunk
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await editor.fill('flowchart LR\n  Start --> Finish')
  await dialog.getByRole('button', { name: 'Insert' }).click()
  await expect.poll(() => liveElements(board)?.filter((el) => el.type === 'arrow').length ?? 0, { timeout: 30_000 }).toBe(1)
  expect(liveElements(board)?.filter((el) => el.type === 'text').map((el) => el.text).sort()).toEqual(['Finish', 'Start'])
})

test('Present: frames become slides and the player walks them with the keys', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Deck.excalidraw': scene([frame('f1', 'Intro', 0, 0), rect('a', 50, 50, 100, 60, { frameId: 'f1' }), frame('f2', 'Plan', 600, 0)]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Deck.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await openPanelTab(page, 'Presentation')
  const slides = panel(page).getByRole('region', { name: 'Presentation' })
  await expect(slides.getByText('2 slides')).toBeVisible()
  await expect(slides.getByTestId('presentation-slide-f1')).toContainText('Intro')
  await slides.getByRole('button', { name: /Start presentation/ }).click()
  const player = page.getByRole('dialog', { name: 'Presentation mode' })
  await expect(player).toContainText('slide 1 of 2 — Intro')
  await page.keyboard.press('ArrowRight')
  await expect(player).toContainText('slide 2 of 2 — Plan')
  await page.keyboard.press('Home')
  await expect(player).toContainText('slide 1 of 2 — Intro')
  await player.getByRole('button', { name: 'Exit presentation' }).click()
  await expect(player).toBeHidden()
})

test('Components: save a selection to the Library folder and insert a copy into another board', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Source.excalidraw': scene([rect('a'), rect('b', 260)]), 'Target.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, tabs: [`${vault}/Source.excalidraw`, `${vault}/Target.excalidraw`], file: `${vault}/Source.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const box = await activeCanvas(page).boundingBox()
  if (box === null) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 120)
  await page.keyboard.press('Meta+a')
  await openPanelTab(page, 'Components')
  await panel(page).getByRole('button', { name: 'Save selection' }).click()
  await panel(page).getByRole('textbox', { name: 'Component name' }).fill('Two boxes')
  await panel(page).getByRole('button', { name: /^Save 2 elements?$/ }).click()
  await expect(panel(page).getByRole('button', { name: 'Insert Two boxes' })).toBeVisible()
  const library = `${sandbox.profile}/library/components`
  await expect.poll(() => (existsSync(library) ? readdirSync(library).sort() : [])).toEqual(['two-boxes.excalidraw', 'two-boxes.png'])

  await page.getByRole('tab', { name: 'Target' }).click()
  await canvasReady(page)
  await openPanelTab(page, 'Components')
  await panel(page).filter({ visible: true }).getByRole('button', { name: 'Insert Two boxes' }).click()
  await expect.poll(() => liveElements(`${vault}/Target.excalidraw`)?.length).toBe(2)
})

test('Images › Shapes inserts a shape without any network', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const requests: string[] = []
  app.electron.context().on('request', (req) => requests.push(req.url()))
  const page = await app.window()
  await canvasReady(page)
  await openPanelTab(page, 'Image Studio')
  await panel(page).getByRole('navigation', { name: 'Image Studio sections' }).getByRole('button', { name: 'Shapes' }).click()
  await panel(page).getByRole('button', { name: 'Add Hexagon', exact: true }).click()
  await expect.poll(() => liveElements(board)?.length ?? 0).toBeGreaterThan(0)
  expect(requests.filter((url) => !/^(app|data|blob):/.test(url))).toEqual([])
})

test('the launcher rail’s Writing mode and Show frames are global canvas preferences', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const rail = page.getByRole('navigation', { name: 'Workspace panel and canvas modes' })
  await rail.getByRole('button', { name: 'Writing mode' }).click()
  await rail.getByRole('button', { name: 'Show frames' }).click()
  await expect(rail.getByRole('button', { name: 'Show frames' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await page.evaluate(() => window.yaseenDraw.state.get())).settings.canvas).toMatchObject({ writingMode: true, framesVisible: false })
})
