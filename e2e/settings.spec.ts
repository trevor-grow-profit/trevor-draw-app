/**
 * Settings (⌘,) and dark mode: every setting is global, applies live in every window and survives a
 * relaunch; secrets never reach the state file (docs/CONTRACTS.md "Settings", 🔒 YAZ-1775 D4 / D9).
 */
import { readFileSync, statSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { canvasChanged, canvasReady, staticCanvasShot } from './support/canvas'
import { treeReady } from './support/sidebar'
import { diagram, diagramBox, gitVault, readProfile, rect, scene } from './support/vault'

const settings = (page: Page): Locator => page.getByRole('dialog', { name: 'Settings' })
const segment = (page: Page, group: string, option: string): Locator => settings(page).getByRole('group', { name: group }).getByRole('button', { name: option, exact: true })

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settings(page)).toBeVisible()
}

test('Settings opens from the sidebar and from the app menu, searches its rows, and Escape closes it', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await openSettings(page)
  const nav = settings(page).getByRole('navigation', { name: 'Settings sections' })
  for (const section of ['Appearance', 'Excalidraw canvas', 'Files', 'Images', 'Sync', 'Storage', 'Sharing', 'Hotkeys']) {
    await expect(nav.getByRole('button', { name: section })).toBeVisible()
  }
  const search = settings(page).getByRole('textbox', { name: 'Search settings' })
  await expect(search).toBeFocused()
  await search.fill('snap')
  await expect(settings(page).getByRole('group', { name: 'Snap to objects' })).toBeVisible()
  await expect(settings(page).getByRole('group', { name: 'Theme' })).toHaveCount(0)
  await search.fill('zzzz nothing')
  await expect(settings(page).getByText('No settings match', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape') // first Escape clears the query…
  await expect(search).toHaveValue('')
  await page.keyboard.press('Escape') // …the second closes
  await expect(settings(page)).toBeHidden()
  await app.menu('menu.app.settings', page)
  await expect(settings(page)).toBeVisible()
  await settings(page).getByRole('button', { name: 'Hotkeys' }).click()
  for (const table of ['Window', 'Excalidraw canvas', 'draw.io diagram', 'Mouse']) await expect(settings(page).getByText(table, { exact: true }).first()).toBeVisible()
  await settings(page).getByRole('button', { name: 'Close settings' }).click()
  await expect(settings(page)).toBeHidden()
})

test('Dark theme applies live to the app, the canvas and every window, and is remembered', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }, { root: vault, bounds: { x: 220, y: 140, width: 1000, height: 700 } }] })
  const app = await launch()
  const [one, two] = await app.windows(2)
  const drawingWindow = (await one.locator('.excalidraw').count()) > 0 ? one : two
  const other = drawingWindow === one ? two : one
  await canvasReady(drawingWindow)
  await expect(drawingWindow.locator('html')).toHaveAttribute('data-theme', 'light')
  await openSettings(drawingWindow)
  await segment(drawingWindow, 'Theme', 'Dark').click()
  await expect(drawingWindow.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(drawingWindow.locator('.excalidraw.theme--dark')).toBeVisible()
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await app.electron.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  expect(await drawingWindow.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
  await expect.poll(() => readProfile(sandbox.profile).settings.theme).toBe('dark')
  await app.quit()
  const again = await launch()
  const pages = await again.windows(2)
  await expect(pages[0].locator('html')).toHaveAttribute('data-theme', 'dark')
  // The window's backing colour matches too, so a dark launch has no white flash.
  expect(await again.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBackgroundColor().toLowerCase()))).toEqual(['#1e1e1e', '#1e1e1e'])
})

test('a diagram follows dark mode, adapting its colours unless told to keep them', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Dark box')) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Flow.drawio` }], settings: { theme: 'dark' } })
  const app = await launch()
  const page = await app.window()
  await expect(page.frameLocator('iframe.drawio-editor__frame').getByText('Dark box')).toBeVisible({ timeout: 30_000 })
  const drawio = () => {
    const frame = page.frames().find((f) => f.url().startsWith('app://drawio'))
    if (frame === undefined) throw new Error('no draw.io frame')
    return frame
  }
  const isDark = () => drawio().evaluate(() => (window as unknown as { Editor: { isDarkMode(): boolean } }).Editor.isDarkMode())
  await expect.poll(isDark).toBe(true)
  await openSettings(page)
  await segment(page, 'Theme', 'Light').click()
  await expect.poll(isDark).toBe(false)
  await segment(page, 'draw.io diagrams in dark mode', 'Keep original colours').click()
  await expect.poll(() => readProfile(sandbox.profile).settings.diagramDarkColors).toBe('keep')
})

test('a canvas preference (Grid) applies live to an open board and is stored globally', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const before = await staticCanvasShot(page)
  await openSettings(page)
  await segment(page, 'Grid', 'On').click()
  await expect.poll(() => (readProfile(sandbox.profile).settings.canvas as { gridModeEnabled?: boolean } | undefined)?.gridModeEnabled).toBe(true)
  await settings(page).getByRole('button', { name: 'Close settings' }).click()
  await canvasChanged(page, before) // the grid is drawn
  const board = JSON.parse(readFileSync(`${vault}/Board.excalidraw`, 'utf8')) as { appState: Record<string, unknown> }
  expect(board.appState.gridModeEnabled).toBeUndefined() // a user preference, never written into the board
})

test('Confirm before deleting and Preview on hover are switches in Files', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await openSettings(page)
  await segment(page, 'Confirm before deleting', 'Off').click()
  await segment(page, 'Preview on hover', 'Off').click()
  await expect.poll(() => readProfile(sandbox.profile).settings).toMatchObject({ confirmDelete: false, hoverPreview: false })
  await settings(page).getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('button', { name: 'Preview on hover' })).toHaveAttribute('aria-pressed', 'false')
})

test('the Pixabay key is write-only: set and cleared from Settings, kept 0600 outside the state file', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await openSettings(page)
  await settings(page).getByRole('button', { name: 'Images' }).click()
  const status = settings(page).getByTestId('pixabay-key-status')
  await expect(status).toHaveText('No key')
  await settings(page).getByRole('textbox', { name: 'Pixabay API key' }).fill('e2e-secret-key-123')
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click()
  await expect(status).toHaveText('Key set')
  expect(await page.evaluate(() => window.yaseenDraw.secrets.has({ name: 'pixabayApiKey' }))).toBe(true)
  expect(readFileSync(`${sandbox.profile}/yaseendraw.json`, 'utf8')).not.toContain('e2e-secret-key-123')
  expect(statSync(`${sandbox.profile}/secrets.json`).mode & 0o777).toBe(0o600)
  await settings(page).getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(status).toHaveText('No key')
})

test('the Library folder defaults to the profile’s own library', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await openSettings(page)
  await settings(page).getByRole('button', { name: 'Images' }).click()
  await expect(settings(page).getByTestId('library-folder-path')).toContainText(`${sandbox.profile}/library`)
  await expect(settings(page).getByTestId('library-folder-path')).toContainText('(default)')
})

test('Sync › GitHub on a git vault writes the vault’s switch and the chip turns Synced', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  gitVault(vault, { sync: false })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await expect(page.getByRole('button', { name: 'Sync off' })).toBeVisible()
  await openSettings(page)
  await segment(page, 'Sync this vault to GitHub', 'On').click()
  await expect.poll(() => readFileSync(`${vault}/.yaseendraw/github.json`, 'utf8')).toContain('"enabled": true')
  await settings(page).getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('button', { name: 'Synced' })).toBeVisible()
})
