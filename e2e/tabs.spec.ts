/**
 * Tabs: opening in the current / a background tab, per-tab Back / Forward, the Window menu's tab
 * keys, Close Tab, the tab's own menu, and a mounted tab keeping its unsaved state while hidden.
 */
import { existsSync } from 'node:fs'
import { test, expect, withClipboard } from './support/fixtures'
import { canvasReady, drawRect } from './support/canvas'
import { menuItem, row, treeReady } from './support/sidebar'
import { liveElements, readProfile, rect, scene } from './support/vault'

const THREE = { 'One.excalidraw': scene([rect('a')]), 'Two.excalidraw': scene([rect('b')]), 'Three.excalidraw': scene([rect('c')]) }

test('a click opens in the current tab and Back / Forward walk that tab’s history', async ({ openBoard }) => {
  const { page } = await openBoard(THREE)
  const tabs = page.getByRole('tablist', { name: 'Open files' }).getByRole('tab')
  await row(page, 'Two').click()
  await expect(tabs).toHaveText(['Two'])
  await row(page, 'Three').click()
  await expect(tabs).toHaveText(['Three'])
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(tabs).toHaveText(['Two'])
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(tabs).toHaveText(['One'])
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled()
  await page.getByRole('button', { name: 'Forward' }).click()
  await expect(tabs).toHaveText(['Two'])
})

test('⌘-click opens a background tab; the Window menu walks tabs and Close Tab picks the neighbour', async ({ sandbox, openBoard }) => {
  const { app, page, vault } = await openBoard(THREE)
  const tabs = page.getByRole('tablist', { name: 'Open files' }).getByRole('tab')
  const active = page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { selected: true })
  await row(page, 'Two').click({ modifiers: ['Meta'] })
  await row(page, 'Three').click({ modifiers: ['Meta'] })
  await expect(tabs).toHaveText(['One', 'Two', 'Three'])
  await expect(active).toHaveText('One')
  await app.menu('menu.window.next-tab', page)
  await expect(active).toHaveText('Two')
  await app.menu('menu.window.next-tab-alt', page)
  await expect(active).toHaveText('Three')
  await app.menu('menu.window.next-tab', page) // wraps
  await expect(active).toHaveText('One')
  await app.menu('menu.window.prev-tab', page)
  await expect(active).toHaveText('Three')
  await app.menu('menu.window.prev-tab-alt', page)
  await expect(active).toHaveText('Two')
  await app.menu('menu.file.close-tab', page)
  await expect(tabs).toHaveText(['One', 'Three'])
  await expect(active).toHaveText('Three')
  await page.getByRole('button', { name: 'Close Three' }).click()
  await expect(tabs).toHaveText(['One'])
  await expect.poll(() => readProfile(sandbox.profile).windows[0].tabs).toEqual([`${vault}/One.excalidraw`])
})

test('Close Tab on the last tab leaves the empty editor; on no tab at all it closes the window', async ({ sandbox, openBoard }) => {
  const { app, page } = await openBoard(THREE)
  await app.menu('menu.file.close-tab', page)
  await expect(page.getByText('Select a file from the sidebar.')).toBeVisible()
  await expect(page).toHaveTitle('V')
  await app.menu('menu.file.close-tab', page)
  // The last window closing quits the app (`window-all-closed`), through the same quit sequence.
  await expect.poll(() => existsSync(sandbox.path('quit.marker'))).toBe(true)
})

test('a hidden tab stays mounted: its unsaved-then-saved edit and its engine survive switching away and back', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', THREE)
  sandbox.writeProfile({ windows: [{ root: vault, tabs: [`${vault}/One.excalidraw`, `${vault}/Two.excalidraw`], file: `${vault}/One.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await drawRect(page)
  await page.getByRole('tab', { name: 'Two' }).click() // switching away flushes nothing it should lose
  await canvasReady(page)
  await expect.poll(() => liveElements(`${vault}/One.excalidraw`)?.length).toBe(2)
  await expect(page.locator('.tabstack__layer')).toHaveCount(2)
  await page.getByRole('tab', { name: 'One' }).click()
  await canvasReady(page)
  await expect(page.getByRole('button', { name: 'Undo' }).filter({ visible: true })).toBeEnabled() // same engine, same history
})

test('the tab’s own menu copies its path and shows it in the sidebar', async ({ openBoard }) => {
  const { app, page, board } = await openBoard({ 'Deep/Down/Board.excalidraw': scene([rect('a')]) })
  await treeReady(page)
  await page.getByRole('tab', { name: 'Board' }).click({ button: 'right' })
  await menuItem(page, 'Show in sidebar').click()
  await expect(row(page, 'Board')).toBeVisible()
  await withClipboard(app, async () => {
    await page.getByRole('tab', { name: 'Board' }).click({ button: 'right' })
    await menuItem(page, 'Copy path').click()
    await expect.poll(() => app.electron.evaluate(({ clipboard }) => clipboard.readText())).toBe(board)
  })
})
