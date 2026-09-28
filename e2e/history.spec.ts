/**
 * Two computers, one vault (YAZ-1897): the first sync merges shape by shape, keeps both copies of
 * what cannot merge, says so, and Version history shows and restores any committed version. Git is
 * the real binary against a local bare origin (tools/seedMergeDemoVault.mjs); nothing leaves the Mac.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from './support/fixtures'
import { contextMenu, notice, treeReady } from './support/sidebar'
import { diagram, diagramBox, gitIn, gitVault, liveElements, rect, runSeed, scene } from './support/vault'

const history = (page: Page) => page.getByTestId('version-history')

test('the first sync merges the other computer’s edits, keeps both copies of a text file, and says so', async ({ sandbox, launch }) => {
  const vault = sandbox.path('Merge demo')
  runSeed('seedMergeDemoVault.mjs', ['--vault', vault])
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  const merged = notice(page).filter({ hasText: "Merged Sam's changes into 3 boards" })
  await expect(merged).toBeVisible({ timeout: 30_000 })
  await expect(merged).toContainText('edited on both — kept the newest')
  await expect(merged).toContainText('“Notes.md” changed on both computers — your copy is saved as “Notes (conflict, ')
  // 01: both sides added a shape → both kept.
  expect(liveElements(`${vault}/01 Both added a shape.excalidraw`)?.map((el) => el.id)).toEqual(expect.arrayContaining(['yours', 'sams']))
  // 03: Sam deleted the card, you edited its text → the edit wins, card and text kept.
  expect(liveElements(`${vault}/03 Card deleted vs text edited.excalidraw`)?.map((el) => el.id)).toEqual(expect.arrayContaining(['card', 'cardText']))
  // Notes.md cannot merge: yours is kept beside Sam's.
  const copy = readdirSync(vault).find((name) => /^Notes \(conflict, \d{4}-\d{2}-\d{2}\)\.md$/.test(name))
  expect(copy).toBeDefined()
  expect(readFileSync(`${vault}/${copy}`, 'utf8')).toContain('keep Monday')
  expect(readFileSync(`${vault}/Notes.md`, 'utf8')).toContain('Sam: move it to Tuesday')
  // …and the merge reached the "GitHub" (the bare origin).
  await expect.poll(() => gitIn(`${vault} (origin).git`, 'show', 'main:01 Both added a shape.excalidraw')).toContain('"yours"')
  await merged.getByRole('button', { name: 'See changes' }).click()
  await expect(history(page)).toBeVisible()
  await expect(history(page).getByRole('listbox', { name: 'Versions' }).getByRole('option').first()).toBeVisible()
})

test('Version history restores an earlier version of a drawing over the current one', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('first')]) })
  gitVault(vault)
  writeFileSync(`${vault}/Board.excalidraw`, scene([rect('first'), rect('second', 300)]))
  gitIn(vault, 'commit', '-am', 'sync: second shape')
  gitIn(vault, 'push')
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Board', 'Version history')
  await expect(history(page)).toHaveAccessibleName('Version history of Board')
  const versions = history(page).getByRole('listbox', { name: 'Versions' }).getByRole('option')
  await expect(versions).toHaveCount(2)
  await versions.last().click() // the oldest: one shape
  await expect(history(page).getByTestId('history-picture')).toBeVisible()
  await history(page).getByTestId('history-restore').click()
  await history(page).getByTestId('history-restore-confirm').click()
  await expect.poll(() => liveElements(`${vault}/Board.excalidraw`)?.map((el) => el.id)).toEqual(['first'])
})

test('Version history of a diagram shows it as it was', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Version one')) })
  gitVault(vault)
  writeFileSync(`${vault}/Flow.drawio`, diagram(diagramBox('c1', 'Version two')))
  gitIn(vault, 'commit', '-am', 'sync: relabel')
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Flow', 'Version history')
  const versions = history(page).getByRole('listbox', { name: 'Versions' }).getByRole('option')
  await expect(versions).toHaveCount(2)
  await versions.last().click()
  await expect(history(page).getByTestId('history-picture')).toBeVisible({ timeout: 30_000 })
})

test('a vault without git has no versions yet and says how to start keeping them', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await contextMenu(page, 'Board', 'Version history')
  await expect(history(page).getByTestId('history-empty')).toContainText('No versions yet')
  expect(existsSync(`${vault}/.git`)).toBe(false)
})
