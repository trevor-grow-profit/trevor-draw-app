/**
 * Multiple windows (docs/CONTRACTS.md "Multi-window"): duplicate, open a board in a new window,
 * close-forgets vs quit-restores, windows brought back on screen, and two windows on one board.
 */
import type { Page } from '@playwright/test'
import { test, expect, type DrawApp } from './support/fixtures'
import { canvasChanged, canvasReady, drawRect, staticCanvasShot } from './support/canvas'
import { contextMenu, treeReady } from './support/sidebar'
import { liveElements, readProfile, rect, scene, writesSettled } from './support/vault'

const identity = (page: Page) => page.evaluate(() => window.yaseenDraw.window.identity())

/** The window whose identity is not `known`'s — the one that just opened. */
async function newest(app: DrawApp, count: number, known: Page): Promise<Page> {
  const pages = await app.windows(count)
  const other = pages.find((p) => p !== known)
  if (other === undefined) throw new Error('no new window')
  return other
}

test('New Window duplicates this window: same vault, same tabs, then they go their own ways', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'One.excalidraw': scene([rect('a')]), 'Two.excalidraw': scene([rect('b')]) })
  sandbox.writeProfile({ windows: [{ root: vault, tabs: [`${vault}/One.excalidraw`, `${vault}/Two.excalidraw`], file: `${vault}/Two.excalidraw` }] })
  const app = await launch()
  const first = await app.window()
  await canvasReady(first)
  await app.menu('menu.file.new-window', first)
  const second = await newest(app, 2, first)
  await canvasReady(second)
  expect(await identity(second)).toMatchObject({ root: vault, tabs: [`${vault}/One.excalidraw`, `${vault}/Two.excalidraw`], file: `${vault}/Two.excalidraw` })
  expect((await identity(second)).id).not.toBe((await identity(first)).id)
  await second.getByRole('button', { name: 'Close Two' }).click()
  await expect(first.getByRole('tab', { name: 'Two' })).toBeVisible() // the original is untouched
  await expect.poll(() => readProfile(sandbox.profile).windows.length).toBe(2)
})

test('Open in ▸ New window opens that board alone in a new window on the same vault', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Here.excalidraw': scene([rect('a')]), 'There.excalidraw': scene([rect('b')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Here.excalidraw` }] })
  const app = await launch()
  const first = await app.window()
  await treeReady(first)
  await contextMenu(first, 'There', ['Open in', 'New window'])
  const second = await newest(app, 2, first)
  await canvasReady(second)
  expect(await identity(second)).toMatchObject({ root: vault, tabs: [`${vault}/There.excalidraw`] })
})

test('closing one of two windows forgets it; quitting keeps every window for the next launch', async ({ sandbox, launch }) => {
  const a = sandbox.vault('A', { 'One.excalidraw': scene() })
  const b = sandbox.vault('B', { 'Two.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: a }, { root: b }, { root: a }] })
  const app = await launch()
  const pages = await app.windows(3)
  const onB = (await Promise.all(pages.map(async (p) => ((await identity(p)).root === b ? p : null)))).find((p) => p !== null)
  if (!onB) throw new Error('no window on B')
  await (await app.electron.browserWindow(onB)).evaluate((w) => w.close())
  await app.windows(2)
  await expect.poll(() => readProfile(sandbox.profile).windows.map((w) => w.root)).toEqual([a, a])
  await app.quit()
  expect(readProfile(sandbox.profile).windows.map((w) => w.root)).toEqual([a, a])
  const again = await launch()
  await again.windows(2)
})

test('closing a window right after an edit flushes the edit first', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]), 'Other.excalidraw': scene() })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }, { root: vault, file: `${vault}/Other.excalidraw`, bounds: { x: 220, y: 140, width: 1000, height: 700 } }] })
  const app = await launch()
  const pages = await app.windows(2)
  const editing = (await identity(pages[0])).file === board ? pages[0] : pages[1]
  await canvasReady(editing)
  await drawRect(editing)
  await (await app.electron.browserWindow(editing)).evaluate((w) => w.close()) // before the 500 ms autosave
  await app.windows(1)
  expect(liveElements(board)).toHaveLength(2)
})

test('a window saved on a display that is gone comes back on screen', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'One.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, bounds: { x: 30_000, y: 30_000, width: 900, height: 700 } }] })
  const app = await launch()
  await app.window()
  const onScreen = await app.electron.evaluate(({ BrowserWindow, screen }) => {
    const b = BrowserWindow.getAllWindows()[0].getBounds()
    return screen.getAllDisplays().some((d) => b.x >= d.workArea.x && b.y >= d.workArea.y && b.x < d.workArea.x + d.workArea.width && b.y < d.workArea.y + d.workArea.height)
  })
  expect(onScreen).toBe(true)
})

test('the same board in two windows: a save in one reloads the other', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Shared.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Shared.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }, { root: vault, file: board, bounds: { x: 200, y: 120, width: 1280, height: 820 } }] })
  const app = await launch()
  const [one, two] = await app.windows(2)
  await canvasReady(one)
  await canvasReady(two)
  const before = await staticCanvasShot(two)
  await app.focus(one)
  await drawRect(one, 200, 200, 200, 150)
  await expect.poll(() => liveElements(board)?.length).toBe(2)
  await writesSettled(board)
  await canvasChanged(two, before)
  await expect(two.getByRole('alert').filter({ hasText: 'File changed on disk.' })).toHaveCount(0)
  // …and the other window, having reloaded, saves on top of it rather than over it.
  await app.focus(two) // a user clicks into the other window first
  await drawRect(two, 450, 420)
  await expect.poll(() => liveElements(board)?.length).toBe(3)
})
