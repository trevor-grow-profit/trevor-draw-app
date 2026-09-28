/** A draw.io diagram in the app: its editor frame (`app://drawio`) and its file on disk. */
import { readFileSync } from 'node:fs'
import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test'

/** The draw.io editor of the active tab, inside its iframe. */
export const editorFrame = (page: Page): FrameLocator => page.frameLocator('iframe.drawio-editor__frame')

/** The cells of a diagram file on disk, not counting draw.io's two root cells. */
export const cellCount = (path: string): number => (readFileSync(path, 'utf8').match(/<mxCell id="(?!0"|1")/g) ?? []).length

/**
 * Waits until the diagram in front shows `label` (a cell's whole text) and returns it. draw.io
 * boots in its own frame, which can take many seconds beside a busy suite.
 */
export async function diagramReady(page: Page, label: string): Promise<Locator> {
  const cell = editorFrame(page).getByText(label, { exact: true })
  await expect(cell).toBeVisible({ timeout: 30_000 })
  return cell
}
