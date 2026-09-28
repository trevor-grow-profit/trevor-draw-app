/**
 * Driving the Excalidraw canvas the way a user does — toolbar buttons (the fork's own
 * `data-testid`s) and real pointer events on the interactive canvas.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The mounted engine of the ACTIVE tab (every visited tab stays mounted, 🔒 YAZ-2073 D8). */
export const activeCanvas = (page: Page): Locator => page.locator('.excalidraw canvas.excalidraw__canvas.interactive').filter({ visible: true }).first()

/** Waits until the drawing's engine is mounted and interactive. */
export async function canvasReady(page: Page): Promise<void> {
  await expect(page.getByTestId('toolbar-rectangle').filter({ visible: true })).toBeVisible()
  await expect(activeCanvas(page)).toBeVisible()
}

/** The active canvas's box on the page. */
export async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await activeCanvas(page).boundingBox()
  if (box === null) throw new Error('canvas has no box')
  return box
}

/** Clicks empty canvas near its bottom-right corner: the canvas takes focus and nothing is selected. */
export async function clickEmpty(page: Page): Promise<void> {
  const box = await canvasBox(page)
  await page.mouse.click(box.x + box.width - 80, box.y + box.height - 140)
}

/** Drags a rectangle with the toolbar from (x, y) by (w, h), relative to the canvas's top-left. */
export async function drawRect(page: Page, x = 200, y = 200, w = 120, h = 80): Promise<void> {
  await page.getByTestId('toolbar-rectangle').filter({ visible: true }).click()
  const box = await canvasBox(page)
  await page.mouse.move(box.x + x, box.y + y)
  await page.mouse.down()
  await page.mouse.move(box.x + x + w / 2, box.y + y + h / 2, { steps: 4 })
  await page.mouse.move(box.x + x + w, box.y + y + h, { steps: 4 })
  await page.mouse.up()
}

/** The "Saved" status chip of the active editor (a drawing's or a diagram's). */
export const savedChip = (page: Page): Locator => page.getByRole('status').filter({ hasText: /^Saved$/ }).filter({ visible: true })

/** The bar an outside change to a board with unsaved edits raises (a drawing's or a diagram's). */
export const conflictBar = (page: Page): Locator => page.getByRole('alert').filter({ hasText: 'File changed on disk.' })

/**
 * The rendered scene of the active tab as PNG bytes — for "the picture changed" assertions. The
 * canvas's OWN bitmap, not a screenshot of its box: the toolbar and chips float over that box, and a
 * hover fading in the toolbar once passed for "the scene re-rendered" (YAZ-2073 2F).
 */
export const staticCanvasShot = async (page: Page): Promise<Buffer> => {
  const url = await page
    .locator('.excalidraw canvas.excalidraw__canvas.static')
    .filter({ visible: true })
    .first()
    .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL('image/png'))
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
}

/** Waits until the active tab's rendered scene differs from `before`. */
export async function canvasChanged(page: Page, before: Buffer): Promise<void> {
  await expect.poll(async () => (await staticCanvasShot(page)).equals(before), { message: 'the canvas should re-render' }).toBe(false)
}
