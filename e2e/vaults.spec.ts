/**
 * Vaults: the switcher (⌘O), its right-click vault menu, display names, and the rule that opening a
 * folder never replaces a vault (YAZ-1913, YAZ-1941, YAZ-2056).
 */
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { menuItem, row, treeReady } from './support/sidebar'
import { readProfile, scene } from './support/vault'

const identity = (page: Page) => page.evaluate(() => window.yaseenDraw.window.identity())
const switcherInput = (page: Page) => page.getByRole('textbox', { name: 'Switch vault' })
/** The switcher's vault rows — not its last row, "Open folder…". */
const vaultRows = (page: Page) => page.locator('button.vault-switcher__row:not(.vault-switcher__open)')
const switcherRow = (page: Page, name: string) => vaultRows(page).filter({ has: page.locator('.vault-switcher__name', { hasText: name }) })

test('the switcher filters recents; Enter opens the vault beside this window, never in place', async ({ sandbox, launch }) => {
  const home = sandbox.vault('Home', { 'H.excalidraw': scene() })
  const work = sandbox.vault('Work Notes', { 'W.excalidraw': scene() })
  const other = sandbox.vault('Other', { 'O.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: home }], recents: [home, work, other] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await page.locator('button.sidebar__root').click()
  await expect(switcherInput(page)).toBeFocused()
  await expect(switcherRow(page, 'Home')).toHaveAttribute('aria-current', 'true')
  await switcherInput(page).fill('work')
  await expect(vaultRows(page)).toHaveCount(1)
  await switcherInput(page).press('Enter')
  const pages = await app.windows(2)
  const roots = await Promise.all(pages.map(async (p) => (await identity(p)).root))
  expect(roots.sort()).toEqual([home, work].sort())
})

test('⇧Enter switches this window to the vault in place, with a fresh Files lens', async ({ sandbox, launch }) => {
  const home = sandbox.vault('Home', { 'H.excalidraw': scene() })
  const work = sandbox.vault('Work', { 'W.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: home, file: `${home}/H.excalidraw`, sidebarLens: 'favorites' }], recents: [home, work] })
  const app = await launch()
  const page = await app.window()
  await app.menu('menu.file.switch-vault', page)
  await switcherInput(page).fill('Work')
  await switcherInput(page).press('Shift+Enter')
  await expect(row(page, 'W')).toBeVisible()
  expect(await identity(page)).toMatchObject({ root: work, file: null, tabs: [], sidebarLens: 'files' })
  expect(app.electron.windows()).toHaveLength(1)
  await expect(page).toHaveTitle('Work')
})

test('a vault whose folder is gone stays listed as “Folder not found” and does not open', async ({ sandbox, launch }) => {
  const home = sandbox.vault('Home', { 'H.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: home }], recents: [home, sandbox.path('Vanished')] })
  const app = await launch()
  const page = await app.window()
  await app.menu('menu.file.switch-vault', page)
  const gone = switcherRow(page, 'Vanished')
  await gone.click()
  await expect(gone).toBeDisabled()
  await expect(gone).toContainText('Folder not found')
  expect(app.electron.windows()).toHaveLength(1)
})

test('the vault menu sets a display name the title and switcher use, and resets it', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('vault-2026-final', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Board.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await page.locator('button.sidebar__root').click({ button: 'right' })
  await menuItem(page, 'Set display name').click()
  const field = page.getByRole('textbox', { name: 'Display name' })
  await field.fill('Team Board')
  await field.press('Enter')
  await expect(page).toHaveTitle('Board — Team Board')
  await expect(page.locator('button.sidebar__root')).toHaveAccessibleName('Team Board')
  await expect.poll(() => (readProfile(sandbox.profile).folders as Record<string, { name: string | null }>)[vault]?.name).toBe('Team Board')
  await page.locator('button.sidebar__root').click({ button: 'right' })
  await menuItem(page, 'Reset to folder name').click()
  await expect(page).toHaveTitle('Board — vault-2026-final')
})

test('Remove from recent vaults drops a vault from the switcher and the state file', async ({ sandbox, launch }) => {
  const home = sandbox.vault('Home', { 'H.excalidraw': scene() })
  const old = sandbox.vault('Old', { 'O.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: home }], recents: [home, old] })
  const app = await launch()
  const page = await app.window()
  await app.menu('menu.file.switch-vault', page)
  await switcherRow(page, 'Old').click({ button: 'right' })
  await menuItem(page, 'Remove from recent vaults').click()
  await expect.poll(() => readProfile(sandbox.profile).recents.map((r) => r.path)).toEqual([home])
})

test('File › Open Recent on a vault window opens the vault beside it', async ({ sandbox, launch }) => {
  const home = sandbox.vault('Home', { 'H.excalidraw': scene() })
  const other = sandbox.vault('Other', { 'O.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: home }], recents: [home, other] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await app.menu('menu.file.open-recent.1', page)
  const pages = await app.windows(2)
  expect((await Promise.all(pages.map(async (p) => (await identity(p)).root))).sort()).toEqual([home, other].sort())
})

test('File › Open Recent on the Welcome window opens that vault in the Welcome window', async ({ sandbox, launch }) => {
  const other = sandbox.vault('Other', { 'O.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: null }], recents: [other] })
  const app = await launch()
  const page = await app.window()
  await expect(page.getByRole('heading', { name: 'Yaseen Draw' })).toBeVisible()
  await app.menu('menu.file.open-recent.0', page)
  await expect(row(page, 'O')).toBeVisible()
  expect(app.electron.windows()).toHaveLength(1)
})

test('Open folder… on the Welcome window opens the picked folder there; on a vault window it opens beside', async ({ sandbox, launch }) => {
  const picked = sandbox.vault('Picked', { 'P.excalidraw': scene() })
  const second = sandbox.vault('Second', { 'S.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: null }] })
  const app = await launch()
  const page = await app.window()
  const answerPicker = (path: string) =>
    app.electron.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog
    }, path)
  await answerPicker(picked)
  await page.getByRole('button', { name: 'Open folder…' }).click()
  await expect(row(page, 'P')).toBeVisible()
  expect(app.electron.windows()).toHaveLength(1)
  await answerPicker(second)
  await app.menu('menu.file.open-folder', page)
  const pages = await app.windows(2)
  expect((await Promise.all(pages.map(async (p) => (await identity(p)).root))).sort()).toEqual([picked, second].sort())
  await expect.poll(() => readProfile(sandbox.profile).recents.map((r) => r.path).sort()).toEqual([picked, second].sort())
})
