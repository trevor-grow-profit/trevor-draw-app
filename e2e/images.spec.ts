/**
 * Pictures on the canvas: pasted or dropped images land ONCE in `<vault>/assets/<sha1>.<ext>` and the
 * board keeps `files: {}` (🔒 YAZ-1775 D3); legacy embedded images are moved out on the first save;
 * a missing asset is a placeholder, not a crash.
 */
import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect, withClipboard } from './support/fixtures'
import { activeCanvas, canvasBox, canvasReady, drawRect } from './support/canvas'
import { notice } from './support/sidebar'
import { embedded, fileIdFor, imageElement, liveElements, readScene, rect, scene, sceneOr, solidPNG } from './support/vault'

const assetsOf = (vault: string) => (existsSync(`${vault}/assets`) ? readdirSync(`${vault}/assets`).filter((n) => !n.startsWith('.')) : [])

/** ⌘V on the canvas: the engine reads the OS clipboard (needs the secure app:// context). */
async function pasteOnCanvas(page: Page): Promise<void> {
  const box = await canvasBox(page)
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6)
  await page.keyboard.press('Meta+v')
}

/** Drops `bytes` as a file onto the canvas, the way a Finder drag does. */
async function dropOnCanvas(page: Page, bytes: Buffer, name: string): Promise<void> {
  await activeCanvas(page).evaluate((canvas, { b64, fileName }) => {
    const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], fileName, { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const r = canvas.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer: dt }
    canvas.dispatchEvent(new DragEvent('dragover', at))
    canvas.dispatchEvent(new DragEvent('drop', at))
  }, { b64: bytes.toString('base64'), fileName: name })
}

test('a pasted image lands once in assets/ under its content id, and the board stays small', async ({ openBoard }) => {
  const { app, page, vault, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  await withClipboard(app, async () => {
    const png = solidPNG(64, 48, [230, 60, 60]).toString('base64')
    await app.electron.evaluate(({ clipboard, nativeImage }, b64) => clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))), png)
    await pasteOnCanvas(page)
    await expect.poll(() => liveElements(board)?.filter((el) => el.type === 'image').length).toBe(1)
    await expect.poll(() => assetsOf(vault)).toHaveLength(1)
    // Pasting the SAME picture again adds a second element but no second file.
    await pasteOnCanvas(page)
    await expect.poll(() => liveElements(board)?.filter((el) => el.type === 'image').length).toBe(2)
  })
  const [asset] = assetsOf(vault)
  expect(assetsOf(vault)).toHaveLength(1)
  expect(asset).toBe(`${fileIdFor(readFileSync(`${vault}/assets/${asset}`))}.png`)
  const saved = readScene(board)
  expect(saved.files).toEqual({})
  expect(new Set(saved.elements.filter((el) => el.type === 'image').map((el) => `${el.fileId}.png`))).toEqual(new Set([asset]))
  expect(readFileSync(board).length).toBeLessThan(20_000)
})

test('a picture dropped on the canvas becomes one asset, and it is still there after a relaunch', async ({ openBoard, launch }) => {
  const { app, page, vault, board } = await openBoard({ 'Board.excalidraw': scene([rect('a')]) })
  const bytes = solidPNG(40, 30, [40, 120, 220])
  await dropOnCanvas(page, bytes, 'dropped.png')
  await expect.poll(() => assetsOf(vault)).toEqual([`${fileIdFor(bytes)}.png`])
  await expect.poll(() => liveElements(board)?.find((el) => el.type === 'image')?.fileId).toBe(fileIdFor(bytes))
  await app.quit()
  const again = await launch()
  const reopened = await again.window()
  await canvasReady(reopened)
  await expect(reopened.getByRole('alert')).toHaveCount(0)
  // The document door hands the picture back from the store, which is what the canvas draws.
  const loaded = await reopened.evaluate(({ root, path }) => window.yaseenDraw.drawing.load({ root, path }), { root: vault, path: board })
  expect(loaded.stored).toEqual([fileIdFor(bytes)])
})

test('a legacy board that embeds its images is moved out to assets/ on its first save', async ({ openBoard }) => {
  const bytes = solidPNG(20, 20, [10, 200, 90])
  const id = fileIdFor(bytes)
  const { page, vault, board } = await openBoard({ 'Legacy.excalidraw': scene([imageElement('img', id)], { files: { [id]: embedded(id, bytes, { created: 1 }) } }) })
  expect(Object.keys(readScene(board).files ?? {})).toEqual([id]) // opening alone rewrites nothing
  await drawRect(page)
  await expect.poll(() => sceneOr(board)?.files).toEqual({})
  expect(readFileSync(`${vault}/assets/${id}.png`)).toEqual(bytes)
  expect(liveElements(board)?.find((el) => el.type === 'image')?.fileId).toBe(id)
})

test('a board whose picture is missing from assets/ still opens and edits', async ({ openBoard }) => {
  const { page, board } = await openBoard({ 'Missing.excalidraw': scene([imageElement('img', 'f'.repeat(40)), rect('a', 300)]) })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await drawRect(page)
  await expect.poll(() => liveElements(board)?.length).toBe(3)
})

test('opening a vault sweeps assets nothing uses and are over a day old to the Trash, and says so', async ({ sandbox, launch }) => {
  const used = solidPNG(8, 8, [1, 2, 3])
  const oldOrphan = solidPNG(8, 8, [4, 5, 6])
  const freshOrphan = solidPNG(8, 8, [7, 8, 9])
  const vault = sandbox.vault('V', {
    'Board.excalidraw': scene([imageElement('img', fileIdFor(used))]),
    [`assets/${fileIdFor(used)}.png`]: used,
    [`assets/${fileIdFor(oldOrphan)}.png`]: oldOrphan,
    [`assets/${fileIdFor(freshOrphan)}.png`]: freshOrphan,
  })
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
  utimesSync(`${vault}/assets/${fileIdFor(used)}.png`, twoDaysAgo, twoDaysAgo)
  utimesSync(`${vault}/assets/${fileIdFor(oldOrphan)}.png`, twoDaysAgo, twoDaysAgo)
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await expect(notice(page)).toContainText('Cleaned 1 unused image')
  expect(sandbox.trashed()).toEqual([`${fileIdFor(oldOrphan)}.png`])
  expect(assetsOf(vault).sort()).toEqual([`${fileIdFor(used)}.png`, `${fileIdFor(freshOrphan)}.png`].sort())
})
