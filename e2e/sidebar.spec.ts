/**
 * The sidebar: the Files tree, ⌘K search, favorites, sort + Info, hover preview, focus mode,
 * collapse, multi-select and the watcher (feature-safety-net "Sidebar").
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './support/fixtures'
import { canvasReady } from './support/canvas'
import { contextMenu, glance, notice, row, treeReady } from './support/sidebar'
import { diagram, diagramBox, readProfile, rect, scene, stampedScene } from './support/vault'

const DAY = 86_400_000

test('the tree hides the top-level assets/ store and dot-entries, lists folders collapsed, and expands all', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', {
    'assets/0123.png': 'x',
    '.hidden/Secret.excalidraw': scene(),
    'Board.excalidraw': scene(),
    'Projects/Deep/Nested.excalidraw': scene(),
    'Projects/assets/Mine.excalidraw': scene(),
  })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await expect(row(page, 'Board')).toBeVisible()
  await expect(row(page, 'assets')).toHaveCount(0)
  await expect(row(page, '.hidden')).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: 'Projects' })).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'Nested')).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(row(page, 'Nested')).toBeVisible()
  await expect(row(page, 'Mine')).toBeVisible() // a user's own `assets` folder deeper down is theirs
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(row(page, 'Nested')).toBeHidden()
})

test('the tree follows the disk: a file added or removed outside the app appears and disappears', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  writeFileSync(`${vault}/Arrived.excalidraw`, scene())
  await expect(row(page, 'Arrived')).toBeVisible()
  rmSync(`${vault}/Board.excalidraw`)
  await expect(row(page, 'Board')).toBeHidden()
})

test('hover previews render in dark mode too, for a drawing and a diagram', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Shapes.excalidraw': scene([rect('a'), rect('b', 260, 40)]), 'Flow.drawio': diagram(diagramBox('c', 'Night')) })
  sandbox.writeProfile({ windows: [{ root: vault }], settings: { theme: 'dark' } })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await glance(page, 'Shapes', (p) => p.locator('img.board-preview__img--loaded'))
  await glance(page, 'Flow', (p) => p.locator('img.board-preview__img--loaded'), 20_000)
})

test('⌘K search finds boards and folders; Enter opens, ⌘Enter opens in a background tab', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Roadmap 2026.excalidraw': scene(), 'Notes/Road trip.excalidraw': scene(), 'Other.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Other.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await canvasReady(page) // a mounting canvas takes focus; ⌘K comes after it, as a user's would
  await app.menu('menu.file.search', page)
  const search = page.getByRole('textbox', { name: 'Search boards' })
  await expect(search).toBeFocused()
  await search.fill('road')
  const results = page.getByRole('listbox', { name: 'Search results' })
  await expect(results.getByRole('option')).toHaveCount(2)
  await search.fill('zzzz')
  await expect(page.getByText('No matches')).toBeVisible()
  await search.fill('road trip')
  await expect(results.getByRole('option')).toHaveCount(1)
  await search.press('Meta+Enter')
  await expect(page.getByRole('tab', { name: 'Road trip' })).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByRole('tab', { name: 'Other' })).toHaveAttribute('aria-selected', 'true')
  await search.fill('roadmap')
  await search.press('Enter')
  await expect(page.getByRole('tab', { name: 'Roadmap 2026' })).toHaveAttribute('aria-selected', 'true')
})

test('favorites: add from the menu, see them in the Favorites lens, stored in the vault, follow a rename', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Star.excalidraw': scene(), 'Plain.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Star', 'Add to favorites')
  await expect(notice(page)).toContainText('Added to favorites')
  const stored = () => {
    try {
      return readFileSync(`${vault}/.yaseendraw/favorites.json`, 'utf8')
    } catch {
      return ''
    }
  }
  await expect.poll(stored).toContain('Star.excalidraw')
  await page.getByRole('tab', { name: 'Favorites' }).click()
  await expect(row(page, 'Star')).toBeVisible()
  await expect(row(page, 'Plain')).toHaveCount(0)
  await contextMenu(page, 'Star', 'Rename')
  await page.locator('input.create-inline__input').fill('Superstar')
  await page.locator('input.create-inline__input').press('Enter')
  await expect(row(page, 'Superstar')).toBeVisible()
  await expect.poll(stored).toContain('Superstar.excalidraw')
  await contextMenu(page, 'Superstar', 'Remove from favorites')
  await expect(page.getByText('No favorites yet.', { exact: false })).toBeVisible()
})

test('sort by Last updated and Created reorders by the boards’ own dates and is remembered', async ({ sandbox, launch }) => {
  const now = Date.now()
  const vault = sandbox.vault('V', {
    'A oldest edit.excalidraw': stampedScene([], now - 1 * DAY, now - 9 * DAY),
    'B newest edit.excalidraw': stampedScene([], now - 9 * DAY, now - 1 * DAY),
    'C middle.excalidraw': stampedScene([], now - 5 * DAY, now - 5 * DAY),
  })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  const order = () => page.locator('[role=tree] .tree__label').allTextContents()
  await expect.poll(order).toEqual(['A oldest edit', 'B newest edit', 'C middle'])
  await page.getByRole('button', { name: 'Sort by Name' }).click()
  await page.getByRole('menuitem', { name: 'Last updated' }).click()
  await expect.poll(order).toEqual(['B newest edit', 'C middle', 'A oldest edit'])
  await page.getByRole('button', { name: 'Sort by Last updated' }).click()
  await page.getByRole('menuitem', { name: 'Created' }).click()
  await expect.poll(order).toEqual(['A oldest edit', 'C middle', 'B newest edit'])
  await expect.poll(() => (readProfile(sandbox.profile).folders as Record<string, { sortOrder?: string }>)[vault]?.sortOrder).toBe('created')
  await app.quit()
  const relaunched = await launch()
  const again = await relaunched.window()
  await expect(again.getByRole('button', { name: 'Sort by Created' })).toBeVisible()
})

test('Info shows a board’s kind, folder, size and dates; an unstamped board says so', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Plans/Stamped.excalidraw': stampedScene([rect('a')], Date.UTC(2026, 0, 15), Date.UTC(2026, 1, 20)), 'Legacy.excalidraw': scene(), 'Flow.drawio': diagram() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Legacy', 'Info')
  const legacy = page.getByRole('dialog').filter({ has: page.locator('dl.board-info') })
  await expect(legacy).toContainText('Excalidraw drawing')
  await expect(legacy).toContainText('Not stamped yet')
  await page.keyboard.press('Escape')
  await contextMenu(page, 'Flow', 'Info')
  await expect(page.locator('dl.board-info')).toContainText('draw.io diagram')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Expand all' }).click()
  await contextMenu(page, 'Stamped', 'Info')
  const info = page.locator('dl.board-info')
  await expect(info).toContainText('Plans')
  await expect(info).toContainText('2026')
  await expect(info).not.toContainText('Not stamped yet')
})

test('hover preview: a drawing and a diagram get pictures after the dwell, an empty board says so, and it can be turned off', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Shapes.excalidraw': scene([rect('a'), rect('b', 260, 40)]), 'Empty.excalidraw': scene(), 'Flow.drawio': diagram(diagramBox('c', 'Hello')), 'Other.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  const preview = page.locator('.board-preview')
  await glance(page, 'Shapes', (p) => p.locator('img.board-preview__img--loaded'))
  await glance(page, 'Flow', (p) => p.locator('img.board-preview__img--loaded'), 20_000)
  await glance(page, 'Empty', (p) => p.locator('.board-preview__msg').filter({ hasText: 'Empty board' }))
  await page.mouse.move(900, 500)
  await page.getByRole('button', { name: 'Preview on hover' }).click()
  await expect(page.getByRole('button', { name: 'Preview on hover' })).toHaveAttribute('aria-pressed', 'false')
  await row(page, 'Other').hover()
  await page.waitForTimeout(1_000) // twice the 400 ms dwell: a preview would be up by now
  await expect(preview).toHaveCount(0)
})

test('Focus on folder narrows the Files lens; the eye button brings the whole vault back', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Work/Plan.excalidraw': scene(), 'Home/List.excalidraw': scene(), 'Top.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Work', 'Focus on folder')
  await expect(row(page, 'Plan')).toBeVisible()
  await expect(row(page, 'Top')).toHaveCount(0)
  await expect(row(page, 'Home')).toHaveCount(0)
  await page.getByRole('button', { name: 'Exit focus mode' }).click()
  await expect(row(page, 'Top')).toBeVisible()
  await expect(row(page, 'Home')).toBeVisible()
})

test('the sidebar collapses (button, ⌘B) and comes back, and the window remembers it', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await page.getByRole('button', { name: 'Hide sidebar' }).click()
  await expect(page.getByRole('tree')).toBeHidden()
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(page.getByRole('tree')).toBeVisible()
  await page.getByRole('tab', { name: 'Board' }).click()
  await page.keyboard.press('Meta+b')
  await expect(page.getByRole('tree')).toBeHidden()
  await expect.poll(async () => (await page.evaluate(() => window.yaseenDraw.window.identity())).sidebarCollapsed).toBe(true)
  await page.keyboard.press('Meta+b')
  await expect(page.getByRole('tree')).toBeVisible()
})

test('⇧-click selects several boards; the menu opens them all in tabs', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'One.excalidraw': scene(), 'Two.excalidraw': scene(), 'Three.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await row(page, 'One').click({ modifiers: ['Shift'] })
  await row(page, 'Three').click({ modifiers: ['Shift'] })
  const tabs = page.getByRole('tablist', { name: 'Open files' }).getByRole('tab')
  await expect(tabs).toHaveCount(0) // ⇧-click selects, never opens
  await contextMenu(page, 'Three', 'Open 2 in new tabs')
  await expect(tabs).toHaveText(['One', 'Three'])
})

test('Copy path puts the absolute path on the clipboard', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Nested/Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  const saved = await app.electron.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await contextMenu(page, 'Nested', 'Copy path')
    await expect(notice(page)).toContainText('Copied path')
    expect(await app.electron.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${vault}/Nested`)
  } finally {
    await app.electron.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
  }
})

test('dragging the sidebar’s edge resizes it within 180–520 px and the width is remembered', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }], sidebarWidth: 260 })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  const handle = page.locator('.sidebar-resize')
  const box = await handle.boundingBox()
  if (box === null) throw new Error('no resize handle')
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 200, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => readProfile(sandbox.profile).sidebarWidth as number).toBeGreaterThan(360)
  expect(readProfile(sandbox.profile).sidebarWidth as number).toBeLessThanOrEqual(520)
})
