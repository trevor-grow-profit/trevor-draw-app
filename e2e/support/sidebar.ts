/** The sidebar's tree, its right-click menu and the one passive notice — by role and label. */
import { expect, type Locator, type Page } from '@playwright/test'

/** A tree row by its shown label (board extensions hidden, diagrams wear a badge in their name). */
export const row = (page: Page, label: string): Locator =>
  page.locator('button.tree__row', { has: page.locator('.tree__label').getByText(label, { exact: true }) })

/** Right-clicks `label`'s row (or blank tree space for `null`) and picks `item` — `Open in ▸ …` as ['Open in', '…']. */
export async function contextMenu(page: Page, label: string | null, item: string | [string, string]): Promise<void> {
  if (label === null) {
    const body = page.locator('.sidebar__body')
    const box = await body.boundingBox()
    if (box === null) throw new Error('no sidebar body')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8, { button: 'right' })
  } else {
    await row(page, label).click({ button: 'right' })
  }
  const [first, second] = Array.isArray(item) ? item : [item]
  await menuItem(page, first).click()
  if (second !== undefined) await menuItem(page, second).click()
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A menu item by its label; the shortcut hint (`⌘C`, `⇧⏎`) the item draws after it is ignored. */
export const menuItem = (page: Page, label: string): Locator => page.getByRole('menuitem', { name: new RegExp(`^${escapeRegExp(label)}( [⌘⇧⌥⌃⏎].*)?$`) })

/** The passive notice (copy / paste / favorites / errors), not the sync banner's status. */
export const notice = (page: Page): Locator => page.locator('.link-notice')

/** The inline name box the Create group and Rename open. */
export const nameBox = (page: Page): Locator => page.locator('input.create-inline__input')

/** Waits for the vault's tree to render its first answer. */
export async function treeReady(page: Page): Promise<void> {
  await expect(page.getByRole('tree')).toBeVisible()
}
