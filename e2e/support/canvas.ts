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

/** Drags a shape with `tool` (a toolbar testid suffix) from (x, y) by (w, h), relative to the canvas's top-left. */
export async function drawShape(page: Page, tool: 'rectangle' | 'ellipse' | 'arrow' | 'line', x: number, y: number, w = 120, h = 80): Promise<void> {
  await page.getByTestId(`toolbar-${tool}`).filter({ visible: true }).click()
  const box = await activeCanvas(page).boundingBox()
  if (box === null) throw new Error('canvas has no box')
  await page.mouse.move(box.x + x, box.y + y)
  await page.mouse.down()
  await page.mouse.move(box.x + x + w / 2, box.y + y + h / 2, { steps: 4 })
  await page.mouse.move(box.x + x + w, box.y + y + h, { steps: 4 })
  await page.mouse.up()
}

export const drawRect = (page: Page, x = 200, y = 200, w = 120, h = 80): Promise<void> => drawShape(page, 'rectangle', x, y, w, h)

/** The "Saved" status chip of the active editor. */
export const savedChip = (page: Page): Locator => page.getByRole('status').filter({ hasText: /^Saved$/ }).filter({ visible: true })

/** The rendered scene of the active tab as PNG bytes — for "the picture changed" assertions. */
export const staticCanvasShot = (page: Page): Promise<Buffer> =>
  page.locator('.excalidraw canvas.excalidraw__canvas.static').filter({ visible: true }).first().screenshot()

/** Waits until the active tab's rendered scene differs from `before`. */
export async function canvasChanged(page: Page, before: Buffer): Promise<void> {
  await expect.poll(async () => (await staticCanvasShot(page)).equals(before), { message: 'the canvas should re-render' }).toBe(false)
}
