/**
 * The board document both kinds share (YAZ-2073 D16, `client/src/documents/useBoardDocument.tsx`):
 * the rules `autosave.spec.ts` and `windows.spec.ts` pin for a drawing, run for a diagram too — two
 * windows on one board, a conflict answered with Keep mine — plus a rename straight after an edit
 * for each kind. ⌘Q with unsaved edits is `autosave.spec.ts` (drawing) and `drawio.spec.ts` (diagram).
 */
import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { conflictBar, drawRect } from './support/canvas'
import { cellCount, diagramReady, editorFrame } from './support/drawio'
import { contextMenu, nameBox } from './support/sidebar'
import { diagram, diagramBox, liveElements, rect, scene, writeOutside, writesSettled } from './support/vault'

const box = (page: Page, label: string) => editorFrame(page).getByText(label, { exact: true })

/** Select the top box and duplicate it: an edit draw.io autosaves. */
async function duplicateBox(page: Page, label: string): Promise<void> {
  await box(page, label).last().click()
  await page.keyboard.press('Meta+d')
}

test('the same diagram in two windows: a save in one reloads the other, which then saves on top of it', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Shared box')) })
  const file = `${vault}/Flow.drawio`
  sandbox.writeProfile({ windows: [{ root: vault, file }, { root: vault, file, bounds: { x: 200, y: 120, width: 1280, height: 820 } }] })
  const app = await launch()
  const [one, two] = await app.windows(2)
  await diagramReady(one, 'Shared box')
  await diagramReady(two, 'Shared box')
  await app.focus(one)
  await duplicateBox(one, 'Shared box')
  await expect.poll(() => cellCount(file)).toBe(2)
  await writesSettled(file)
  await expect(box(two, 'Shared box')).toHaveCount(2)
  await expect(conflictBar(two)).toHaveCount(0)
  await app.focus(two)
  await duplicateBox(two, 'Shared box')
  await expect.poll(() => cellCount(file)).toBe(3)
})

test('an outside change to a diagram with unsaved edits raises the bar; Keep mine writes the tab over it', async ({ openBoard }) => {
  const { page, board: file } = await openBoard({ 'Flow.drawio': diagram(diagramBox('c1', 'Mine')) })
  await diagramReady(page, 'Mine')
  await duplicateBox(page, 'Mine') // dirty for the next 500 ms…
  writeOutside(file, diagram(diagramBox('c1', 'Theirs'))) // …and the disk moves under it
  await expect(conflictBar(page)).toBeVisible()
  await conflictBar(page).getByRole('button', { name: 'Keep mine' }).click()
  await expect(conflictBar(page)).toBeHidden()
  await expect.poll(() => cellCount(file)).toBe(2)
  expect(readFileSync(file, 'utf8')).not.toContain('Theirs')
})

test('renaming a drawing straight after an edit takes the edit to the new name and leaves nothing at the old one', async ({ openBoard }) => {
  const { page, vault } = await openBoard({ 'Before.excalidraw': scene([rect('a')]) })
  await drawRect(page)
  await contextMenu(page, 'Before', 'Rename')
  await nameBox(page).fill('After')
  await nameBox(page).press('Enter')
  await expect(page.getByRole('tab', { name: 'After' })).toBeVisible()
  await expect.poll(() => liveElements(`${vault}/After.excalidraw`)?.length).toBe(2)
  await writesSettled(`${vault}/After.excalidraw`)
  expect(existsSync(`${vault}/Before.excalidraw`)).toBe(false)
})

test('renaming a diagram straight after an edit takes the edit to the new name and leaves nothing at the old one', async ({ openBoard }) => {
  const { page, vault } = await openBoard({ 'Before.drawio': diagram(diagramBox('c1', 'Box')) })
  await diagramReady(page, 'Box')
  await duplicateBox(page, 'Box')
  await contextMenu(page, 'Before', 'Rename')
  await nameBox(page).fill('After')
  await nameBox(page).press('Enter')
  await expect(page.getByRole('tab', { name: /After/ })).toBeVisible()
  await expect.poll(() => existsSync(`${vault}/After.drawio`) && cellCount(`${vault}/After.drawio`)).toBe(2)
  await writesSettled(`${vault}/After.drawio`)
  expect(existsSync(`${vault}/Before.drawio`)).toBe(false)
})
