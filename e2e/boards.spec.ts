/**
 * Making, renaming, moving, copying and deleting boards from the sidebar (docs/CONTRACTS.md
 * "Supported file capabilities"; 🔒 YAZ-1999 name-first birth; delete = Trash only).
 */
import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { canvasReady } from './support/canvas'
import { contextMenu, nameBox, notice, row, treeReady } from './support/sidebar'
import { diagram, diagramBox, readScene, rect, scene } from './support/vault'

/** `MM_DD- ` for `daysAgo` days back. */
const dated = (daysAgo = 0) => {
  const day = new Date(Date.now() - daysAgo * 86_400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(day.getMonth() + 1)}_${p(day.getDate())}- `
}
/** The name box holding today's prefix — or yesterday's, when the run crossed midnight since the app read its clock. */
async function datedSeed(page: Page): Promise<string> {
  await expect(nameBox(page)).toHaveValue(new RegExp(`^(${dated()}|${dated(1)})$`))
  return nameBox(page).inputValue()
}

test('New Excalidraw drawing is born name-first, stamped, and opens in the current tab', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Existing.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, null, 'New Excalidraw drawing')
  await expect(nameBox(page)).toHaveAttribute('placeholder', 'New Excalidraw drawing')
  expect(existsSync(`${vault}/Plan.excalidraw`)).toBe(false) // nothing on disk until Enter
  await nameBox(page).fill('Plan')
  await nameBox(page).press('Enter')
  await expect(page.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
  await canvasReady(page)
  const board = readScene(`${vault}/Plan.excalidraw`)
  expect(board.elements).toEqual([])
  expect(board.yaseendraw?.createdAt).toBe(board.yaseendraw?.updatedAt)
})

test('New draw.io diagram in a folder writes a plain one-page mxfile and opens the diagram editor', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Sub/Inner.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Sub', 'New draw.io diagram')
  await nameBox(page).fill('Flow')
  await nameBox(page).press('Enter')
  await expect(page.locator('iframe.drawio-editor__frame')).toBeVisible()
  const xml = readFileSync(`${vault}/Sub/Flow.drawio`, 'utf8')
  expect(xml).toMatch(/^<mxfile [^>]*yaseendraw-created="\d+"/)
  expect(xml).toContain('page="0"')
  expect(xml.match(/<diagram /g)).toHaveLength(1)
})

test('New dated drawing and New dated folder seed today’s MM_DD- prefix; New folder makes a folder', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Keep.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, null, 'New dated Excalidraw drawing')
  const drawingSeed = await datedSeed(page)
  await nameBox(page).press('Enter') // the untouched seed makes nothing
  await expect(nameBox(page)).toBeVisible()
  await nameBox(page).press('End')
  await nameBox(page).pressSequentially('Standup')
  await nameBox(page).press('Enter')
  await expect.poll(() => existsSync(`${vault}/${drawingSeed}Standup.excalidraw`)).toBe(true)
  await canvasReady(page) // the new board opens and its canvas takes focus — let it, before the next box

  await contextMenu(page, null, 'New dated folder')
  const folderSeed = await datedSeed(page)
  await nameBox(page).press('End')
  await nameBox(page).pressSequentially('Sprint')
  await nameBox(page).press('Enter')
  await expect(row(page, `${folderSeed}Sprint`)).toBeVisible()

  await contextMenu(page, null, 'New folder')
  await nameBox(page).fill('Archive')
  await nameBox(page).press('Enter')
  await expect(row(page, 'Archive')).toBeVisible()
  expect(existsSync(`${vault}/Archive`)).toBe(true)
})

test('Escape leaves nothing behind, and a taken name is refused in place without overwriting', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Taken.excalidraw': scene([rect('mine')]) })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, null, 'New Excalidraw drawing')
  await nameBox(page).fill('Ghost')
  await nameBox(page).press('Escape')
  await expect(nameBox(page)).toBeHidden()
  expect(existsSync(`${vault}/Ghost.excalidraw`)).toBe(false)

  await contextMenu(page, null, 'New Excalidraw drawing')
  await nameBox(page).fill('Taken')
  await nameBox(page).press('Enter')
  await expect(page.locator('.create-inline__error')).toContainText('already exists')
  await expect(nameBox(page)).toHaveValue('Taken')
  expect(readScene(`${vault}/Taken.excalidraw`).elements.map((el) => el.id)).toEqual(['mine'])
})

test('Rename keeps the kind, moves the file on disk and the open tab follows', async ({ openBoard }) => {
  const { page, vault } = await openBoard({ 'Old name.excalidraw': scene([rect('a')]), 'Flow.drawio': diagram(diagramBox('c', 'Box')) })
  await contextMenu(page, 'Old name', 'Rename')
  await expect(nameBox(page)).toHaveValue('Old name')
  await nameBox(page).fill('Ünïcödé plan 🎨')
  await nameBox(page).press('Enter')
  await expect(page.getByRole('tab', { name: 'Ünïcödé plan 🎨' })).toBeVisible()
  expect(existsSync(`${vault}/Ünïcödé plan 🎨.excalidraw`)).toBe(true)
  expect(existsSync(`${vault}/Old name.excalidraw`)).toBe(false)

  await contextMenu(page, 'Flow', 'Rename')
  await nameBox(page).fill('Flow 2')
  await nameBox(page).press('Enter')
  await expect(row(page, 'Flow 2')).toBeVisible()
  expect(existsSync(`${vault}/Flow 2.drawio`)).toBe(true)
})

test('dragging a board onto a folder moves it there', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Mover.excalidraw': scene([rect('a')]), 'Target/Other.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await row(page, 'Mover').dragTo(row(page, 'Target'))
  await expect.poll(() => existsSync(`${vault}/Target/Mover.excalidraw`)).toBe(true)
  expect(existsSync(`${vault}/Mover.excalidraw`)).toBe(false)
  await expect(row(page, 'Mover')).toBeHidden() // folders start collapsed
})

test('Delete asks first, Cancel keeps the file, Delete moves it to the Trash and closes its tab', async ({ sandbox, openBoard }) => {
  const { page, vault } = await openBoard({ 'Doomed.excalidraw': scene([rect('a')]), 'Stay.excalidraw': scene() })
  await contextMenu(page, 'Doomed', 'Delete')
  const confirm = page.getByRole('dialog').filter({ hasText: 'Delete "Doomed.excalidraw"? It moves to the Trash.' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  expect(existsSync(`${vault}/Doomed.excalidraw`)).toBe(true)

  await contextMenu(page, 'Doomed', 'Delete')
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(row(page, 'Doomed')).toBeHidden()
  expect(existsSync(`${vault}/Doomed.excalidraw`)).toBe(false)
  expect(sandbox.trashed()).toEqual(['Doomed.excalidraw'])
  await expect(page.getByRole('tab', { name: 'Doomed' })).toHaveCount(0)
})

test('with "Confirm before deleting" off, Delete goes straight to the Trash', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Folder/One.excalidraw': scene(), 'Folder/Two.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }], settings: { confirmDelete: false } })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Folder', 'Delete')
  await expect(row(page, 'Folder')).toBeHidden()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(sandbox.trashed()).toEqual(['Folder'])
})

test('Copy then Paste into the same folder makes “copy”, into another folder keeps the name', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]), 'Elsewhere/Keep.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Board', 'Copy')
  await expect(notice(page)).toContainText('Copied 1 item')
  await contextMenu(page, null, 'Paste 1 item')
  await expect(notice(page)).toContainText('Pasted 1 item')
  await expect(row(page, 'Board copy')).toBeVisible()
  expect(readScene(`${vault}/Board copy.excalidraw`).elements.map((el) => el.id)).toEqual(['a'])
  await contextMenu(page, 'Elsewhere', 'Paste 1 item')
  await expect.poll(() => existsSync(`${vault}/Elsewhere/Board.excalidraw`)).toBe(true)
})

test('⌘X on a selected row then ⌘V on a folder moves it (the app-wide file clipboard)', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Mover.excalidraw': scene([rect('a')]), 'Dest/Keep.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await row(page, 'Mover').click({ modifiers: ['Shift'] }) // select without opening
  await page.keyboard.press('Meta+x')
  await expect(notice(page)).toContainText('Cut 1 item')
  await row(page, 'Dest').click()
  await page.keyboard.press('Meta+v')
  await expect.poll(() => existsSync(`${vault}/Dest/Mover.excalidraw`)).toBe(true)
  expect(existsSync(`${vault}/Mover.excalidraw`)).toBe(false)
})

test('files of no kind are listed and handed to the OS default app; .drawio.svg is not a diagram', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'notes.txt': 'hello', 'picture.drawio.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await expect(row(page, 'notes.txt')).toHaveClass(/tree__row--external/)
  await row(page, 'notes.txt').click()
  await row(page, 'picture.drawio.svg').click()
  await expect.poll(() => sandbox.osCalls()).toEqual([
    { call: 'openPath', arg: `${vault}/notes.txt` },
    { call: 'openPath', arg: `${vault}/picture.drawio.svg` },
  ])
  await expect(page.getByRole('tablist', { name: 'Open files' }).getByRole('tab')).toHaveCount(0)
})

test('Open in ▸ Reveal in Finder / VS Code / Default app hand the path to the OS', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Board', ['Open in', 'Reveal in Finder'])
  await contextMenu(page, 'Board', ['Open in', 'VS Code'])
  await contextMenu(page, 'Board', ['Open in', 'Default app'])
  await expect.poll(() => sandbox.osCalls()).toEqual([
    { call: 'showItemInFolder', arg: `${vault}/Board.excalidraw` },
    { call: 'openExternal', arg: `vscode://file${`${vault}/Board.excalidraw`.split('/').map(encodeURIComponent).join('/')}` },
    { call: 'openPath', arg: `${vault}/Board.excalidraw` },
  ])
})
