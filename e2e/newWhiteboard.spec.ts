import { existsSync, readFileSync } from 'node:fs'
import { test, expect } from './support/fixtures'
import { canvasReady, drawRect, savedChip } from './support/canvas'
import { contextMenu, nameBox, treeReady } from './support/sidebar'
import { liveElements, readScene, rect, scene } from './support/vault'

test('visible New whiteboard creates, autosaves, and reopens without changing an existing board', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Existing.excalidraw': scene([rect('keep')]) })
  const existing = readFileSync(`${vault}/Existing.excalidraw`, 'utf8')
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await page.getByRole('button', { name: 'New whiteboard', exact: true }).click()
  await expect(nameBox(page)).toBeFocused()
  await nameBox(page).fill('My whiteboard')
  expect(existsSync(`${vault}/My whiteboard.excalidraw`)).toBe(false)
  await nameBox(page).press('Enter')
  await canvasReady(page)
  const board = `${vault}/My whiteboard.excalidraw`
  expect(readScene(board).elements).toEqual([])
  await drawRect(page)
  await expect.poll(() => liveElements(board)?.length).toBe(1)
  await expect(savedChip(page)).toBeVisible()
  await app.quit()
  const reopened = await (await launch()).window()
  await canvasReady(reopened)
  await expect(reopened.getByRole('tab', { name: 'My whiteboard', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(liveElements(board)).toHaveLength(1)
  expect(readFileSync(`${vault}/Existing.excalidraw`, 'utf8')).toBe(existing)
})

for (const sidebarWidth of [180, 280, 520]) {
  test(`New whiteboard works from Favorites and search at sidebar width ${sidebarWidth}`, async ({ sandbox, launch }, testInfo) => {
    const vault = sandbox.vault('V', { 'Taken.excalidraw': scene([rect('keep')]), 'Sub/Other.excalidraw': scene() })
    const existing = readFileSync(`${vault}/Taken.excalidraw`, 'utf8')
    sandbox.writeProfile({ sidebarWidth, windows: [{ root: vault, bounds: { x: 40, y: 40, width: 900, height: 650 } }] })
    const page = await (await launch()).window()
    await treeReady(page)
    await contextMenu(page, 'Sub', 'Focus on folder')
    await page.getByRole('tab', { name: 'Favorites', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search boards' }).fill('no matching board')
    const button = page.getByRole('button', { name: 'New whiteboard', exact: true })
    await expect(button).toBeEnabled()
    const fits = await button.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const sidebar = el.closest('.sidebar')!.getBoundingClientRect()
      return r.left >= sidebar.left && r.right <= sidebar.right && el.scrollWidth <= el.clientWidth
    })
    expect(fits).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('new-whiteboard.png') })
    await button.click()
    await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('textbox', { name: 'Search boards' })).toHaveValue('')
    await expect(nameBox(page)).toBeFocused()
    await nameBox(page).fill('Canceled')
    await nameBox(page).press('Escape')
    expect(existsSync(`${vault}/Canceled.excalidraw`)).toBe(false)
    await button.click()
    await nameBox(page).fill('Taken')
    await nameBox(page).press('Enter')
    await expect(page.locator('.create-inline__error')).toContainText('already exists')
    expect(readFileSync(`${vault}/Taken.excalidraw`, 'utf8')).toBe(existing)
    await nameBox(page).fill('Recovered')
    await nameBox(page).press('Enter')
    await expect.poll(() => existsSync(`${vault}/Recovered.excalidraw`)).toBe(true)
    await canvasReady(page)
  })
}


test('New whiteboard is available in an empty vault', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('Empty')
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const page = await (await launch()).window()
  await expect(page.getByText('No boards here.')).toBeVisible()
  await page.getByRole('button', { name: 'New whiteboard', exact: true }).click()
  await nameBox(page).fill('First')
  await nameBox(page).press('Enter')
  await canvasReady(page)
  expect(readScene(`${vault}/First.excalidraw`).elements).toEqual([])
})
