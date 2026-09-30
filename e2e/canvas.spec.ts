/**
 * The Excalidraw canvas and its panel: engine tools that only exist as lazy chunks (laser, Mermaid),
 * the menu's board commands (export, background, zoom), and the workspace panel's Present,
 * Components and Images tabs (feature-safety-net "Excalidraw canvas" / "Canvas panel").
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { activeCanvas, canvasBox, canvasChanged, canvasReady, clickEmpty, savedChip, staticCanvasShot } from './support/canvas'
import { diagramReady } from './support/drawio'
import { notice } from './support/sidebar'
import { diagram, diagramBox, fileIdFor, frame, imageElement, liveElements, readScene, rect, scene, solidPNG, unchangedFor } from './support/vault'

const panel = (page: Page) => page.locator('.excalidraw')
const openPanelTab = async (page: Page, tab: 'Image Studio' | 'Components' | 'Presentation') => {
  await page.getByRole('button', { name: 'Open workspace panel' }).click()
  await panel(page).getByRole('tab', { name: tab }).click()
}

test('Export Excalidraw Drawing writes a standalone file with its pictures inside, leaving the board alone', async ({ sandbox, openBoard }) => {
  const bytes = solidPNG(12, 12, [200, 30, 30])
  const id = fileIdFor(bytes)
  const { app, page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a'), imageElement('img', id, 300, 0)]), [`assets/${id}.png`]: bytes })
  const before = statSync(board).mtimeMs
  const out = sandbox.path('Exported copy.excalidraw')
  await app.answerSaveDialog(out)
  await app.menu('menu.file.export-drawing', page)
  await expect(notice(page)).toContainText('Exported to Exported copy.excalidraw')
  const exported = readScene(out)
  expect(exported.elements.map((el) => el.id).sort()).toEqual(['a', 'img'])
  expect(exported.files?.[id]).toMatchObject({ mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}` })
  expect(statSync(board).mtimeMs).toBe(before)
})

test('Export Image… on a diagram writes the PNG the user named', async ({ sandbox, openBoard }) => {
  const { app, page } = await openBoard({ 'Flow.drawio': diagram(diagramBox('c', 'Export me')) })
  await diagramReady(page, 'Export me')
  const out = sandbox.path('Flow picture.png')
  await app.answerSaveDialog(out)
  await app.menu('menu.file.export-image', page)
  await expect.poll(() => existsSync(out), { timeout: 30_000 }).toBe(true)
  expect(readFileSync(out).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
})

test('View › Canvas Background changes the canvas and saves the colour into the board', async ({ openBoard }) => {
  // Found by this suite (YAZ-2073 1C), fixed by 2E: an appState-only edit is an edit (`boardAppState.ts`).
  const { app, page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const before = await staticCanvasShot(page)
  await app.menu('menu.view.canvas-background.3', page) // Yellow
  await canvasChanged(page, before)
  await app.quit()
  expect(readScene(board).appState?.viewBackgroundColor).toBe('#fffce8')
})

test('opening a board, then panning and zooming it, is not an edit: the board is never written', async ({ openBoard }) => {
  const { app, page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const before = statSync(board).mtimeMs
  await expect(savedChip(page)).toBeVisible()
  const box = await canvasBox(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(300, 200) // pan
  await page.keyboard.down('Meta')
  await page.mouse.wheel(0, -400) // zoom in
  await page.keyboard.up('Meta')
  await unchangedFor(2_000, () => statSync(board).mtimeMs) // several autosave debounces (500 ms)
  await app.quit() // …and the quit flush writes nothing either
  expect(statSync(board).mtimeMs).toBe(before)
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

test('the laser pointer draws a trail that is never saved into the board', async ({ openBoard }) => {
  const { app, page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const before = statSync(board).mtimeMs
  const laser = page.getByRole('region', { name: 'Shapes' }).getByTestId('toolbar-laser')
  await laser.click()
  await expect(laser).toHaveAttribute('aria-pressed', 'true')
  const box = await canvasBox(page)
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 500, box.y + 400, { steps: 10 })
  await page.mouse.up()
  await unchangedFor(1_500, () => statSync(board).mtimeMs) // past the autosave debounce: a saved stroke would be on disk
  await app.quit() // …and the quit flush saves nothing either
  expect(statSync(board).mtimeMs).toBe(before)
})

test('tool keys work on the canvas: R then a drag draws a rectangle', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const box = await canvasBox(page)
  await clickEmpty(page) // focus the canvas
  await page.keyboard.press('r')
  await expect(page.getByTestId('toolbar-rectangle').filter({ visible: true })).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(box.x + 250, box.y + 250)
  await page.mouse.down()
  await page.mouse.move(box.x + 400, box.y + 350, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => liveElements(board)?.map((el) => el.type)).toEqual(['rectangle', 'rectangle'])
})

test('Mermaid to Excalidraw loads its lazy engine and inserts a flowchart', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene() })
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

test('Present: frames become slides and the player walks them with the keys', async ({ openBoard }) => {
  const { page } = await openBoard({ 'Deck.excalidraw': scene([frame('f1', 'Intro', 0, 0), rect('a', 50, 50, 100, 60, { frameId: 'f1' }), frame('f2', 'Plan', 600, 0)]) })
  await openPanelTab(page, 'Presentation')
  const slides = panel(page).getByRole('region', { name: 'Presentation' })
  await expect(slides.getByText('2 slides')).toBeVisible()
  await expect(slides.getByTestId('presentation-slide-f1')).toContainText('Intro')
  // Reorder: moving the first slide down makes it the second — the panel's order is the deck's.
  await slides.getByRole('button', { name: 'Move slide 1 down' }).click()
  await expect(slides.locator('.presentation-sidebar__slide').first()).toContainText('Plan')
  await slides.getByRole('button', { name: 'Move slide 1 down' }).click()
  await expect(slides.locator('.presentation-sidebar__slide').first()).toContainText('Intro')
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

test('Components: save a selection to the Library folder, insert a copy into another board, rename, delete', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Source.excalidraw': scene([rect('a'), rect('b', 260)]), 'Target.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, tabs: [`${vault}/Source.excalidraw`, `${vault}/Target.excalidraw`], file: `${vault}/Source.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await clickEmpty(page)
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
  const components = panel(page).filter({ visible: true })
  await components.getByRole('button', { name: 'Insert Two boxes' }).click()
  await expect.poll(() => liveElements(`${vault}/Target.excalidraw`)?.length).toBe(2)

  // Rename changes the label only; Delete sends both files to the Trash. (Inserting closed the panel.)
  await openPanelTab(page, 'Components')
  await components.getByRole('button', { name: 'Options for Two boxes' }).click()
  await components.getByRole('button', { name: 'Rename Two boxes' }).click()
  await components.getByRole('textbox', { name: 'Rename Two boxes' }).fill('Pair')
  await components.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(components.getByRole('button', { name: 'Insert Pair' })).toBeVisible()
  await components.getByRole('button', { name: 'Options for Pair' }).click()
  await components.getByRole('button', { name: 'Delete Pair' }).click()
  await page.getByRole('alertdialog', { name: 'Delete Pair?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(components.getByText('No saved components yet')).toBeVisible()
  expect(sandbox.trashed().sort()).toEqual(['two-boxes.excalidraw', 'two-boxes.png'])
})

test('Images › Shapes inserts a shape without any network', async ({ openBoard }) => {
  const { app, page, board } = await openBoard({ 'Board.excalidraw': scene() }, 'Board.excalidraw', { network: true })
  await openPanelTab(page, 'Image Studio')
  await panel(page).getByRole('navigation', { name: 'Image Studio sections' }).getByRole('button', { name: 'Shapes' }).click()
  await panel(page).getByRole('button', { name: 'Add Hexagon', exact: true }).click()
  await expect.poll(() => liveElements(board)?.length ?? 0).toBeGreaterThan(0)
  expect(app.outsideRequests().attempted).toEqual([])
})

test('the launcher rail’s Writing mode and Show frames are global canvas preferences', async ({ openBoard }) => {
  const { page } = await openBoard({ 'Board.excalidraw': scene() })
  const rail = page.getByRole('navigation', { name: 'Workspace panel and canvas modes' })
  await rail.getByRole('button', { name: 'Writing mode' }).click()
  await rail.getByRole('button', { name: 'Show frames' }).click()
  await expect(rail.getByRole('button', { name: 'Show frames' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await page.evaluate(() => window.yaseenDraw.state.get())).settings.canvas).toMatchObject({ writingMode: true, framesVisible: false })
})

/** Drops scene JSON as a file onto the canvas, the way a Finder drag of a `.excalidraw` does (no MIME type). */
async function dropSceneOnCanvas(page: Page, json: string, name: string): Promise<void> {
  await activeCanvas(page).evaluate((canvas, { json, fileName }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([json], fileName))
    const r = canvas.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer: dt }
    canvas.dispatchEvent(new DragEvent('dragover', at))
    canvas.dispatchEvent(new DragEvent('drop', at))
  }, { json, fileName: name })
}

test('a scene file dropped on a board that has drawings ADDS to it — twice adds twice — and never replaces it', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const other = scene([rect('b', 300, 0), rect('c', 600, 0)])
  await dropSceneOnCanvas(page, other, 'Other.excalidraw')
  await expect.poll(() => liveElements(board)?.length).toBe(3)
  expect(liveElements(board)?.map((el) => el.id)).toContain('a')
  // The paste door duplicates ids, so the same file can be dropped again and lands again.
  await dropSceneOnCanvas(page, other, 'Other.excalidraw')
  await expect.poll(() => liveElements(board)?.length).toBe(5)
  expect(new Set(liveElements(board)?.map((el) => el.id)).size).toBe(5)
  expect(liveElements(board)?.filter((el) => el.type === 'rectangle')).toHaveLength(5)
})

test('a scene file dropped on an EMPTY board opens it, as the engine always did', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Board.excalidraw': scene() })
  await dropSceneOnCanvas(page, scene([rect('b', 300, 0), rect('c', 600, 0)], { background: '#fffce8' }), 'Other.excalidraw')
  await expect.poll(() => liveElements(board)?.map((el) => el.id).sort()).toEqual(['b', 'c'])
  await expect.poll(() => readScene(board).appState?.viewBackgroundColor).toBe('#fffce8')
})
