/**
 * Autosave, the quit flush and the watcher: what reaches the disk and when (docs/CONTRACTS.md
 * "Bridge API" rules — atomic, mtime-guarded, echo-suppressed; flush-on-quit handshake).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { test, expect, type Fixtures, type Sandbox } from './support/fixtures'
import { canvasChanged, canvasReady, drawRect, savedChip, staticCanvasShot } from './support/canvas'
import { gitIn, gitVault, liveElements, readProfile, readScene, rect, scene, writeOutside } from './support/vault'

test('an edit autosaves: one more element, the dates block first, images never inline', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a'), rect('b', 300)]) })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await drawRect(page)
  await expect.poll(() => liveElements(board)?.length).toBe(3)
  await expect(savedChip(page)).toBeVisible()
  const raw = JSON.parse(readFileSync(board, 'utf8')) as Record<string, unknown>
  expect(Object.keys(raw)[0]).toBe('yaseendraw')
  const meta = raw.yaseendraw as { createdAt: number; updatedAt: number }
  expect(meta.updatedAt).toBeGreaterThanOrEqual(meta.createdAt)
  expect(raw.files).toEqual({})
})

test('opening a board and looking at it never writes it', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Board.excalidraw`
  const before = statSync(board).mtimeMs
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await expect(savedChip(page)).toBeVisible()
  // A clean board has nothing to flush; wait out several autosave debounces (500 ms) to be sure.
  await page.waitForTimeout(2_000)
  await app.quit()
  expect(statSync(board).mtimeMs).toBe(before)
})

test('⌘Q right after an edit still lands the edit on disk (the renderer flush on quit), and relaunches clean', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  await drawRect(page)
  await app.quit() // no wait: the 500 ms autosave debounce has not fired yet
  expect(liveElements(board)).toHaveLength(2)
  // …and the relaunch finds a whole state file, not one moved aside as `.corrupt-<epoch>`.
  const again = await launch()
  await canvasReady(await again.window())
  expect(readdirSync(sandbox.profile).filter((name) => name.includes('.corrupt-'))).toEqual([])
})

test.describe('the quit sequence after the renderers flush (YAZ-2073 2A)', () => {
  // The state-file flush and the last sync commit were dropped from the quit sequence by accident
  // (82d63ce; $SCRATCH/findings/main-process.md F2). Expected to FAIL until YAZ-2073 2A restores
  // `runQuitSequence` — then Playwright reports "expected to fail but passed": drop the marker.
  test.fail()

  test('⌘Q right after an edit on a synced vault commits and pushes that edit', async ({ sandbox, launch }) => {
    const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
    const { origin } = gitVault(vault)
    const board = `${vault}/Board.excalidraw`
    sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
    const app = await launch()
    const page = await app.window()
    await canvasReady(page)
    await expect(page.getByRole('button', { name: 'Synced' })).toBeVisible()
    await drawRect(page)
    await expect.poll(() => liveElements(board)?.length).toBe(2)
    await app.quit()
    const pushed = JSON.parse(gitIn(origin, 'show', 'main:Board.excalidraw')) as { elements: unknown[] }
    expect(pushed.elements).toHaveLength(2)
  })

  test('⌘Q right after a tab switch keeps the tab that was in front', async ({ sandbox, launch }) => {
    const vault = sandbox.vault('V', { 'One.excalidraw': scene([rect('a')]), 'Two.excalidraw': scene([rect('b')]) })
    sandbox.writeProfile({ windows: [{ root: vault, tabs: [`${vault}/One.excalidraw`, `${vault}/Two.excalidraw`], file: `${vault}/One.excalidraw` }] })
    const app = await launch()
    const page = await app.window()
    await canvasReady(page)
    await page.getByRole('tab', { name: 'Two' }).click()
    await app.quit() // the state file's 150 ms write debounce has not fired yet
    expect(readProfile(sandbox.profile).windows[0].file).toBe(`${vault}/Two.excalidraw`)
  })
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal} right after an edit takes the ⌘Q path: the edit lands, then the app exits (YAZ-2073 2G)`, async ({ sandbox, launch }) => {
    const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
    const board = `${vault}/Board.excalidraw`
    sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
    const app = await launch()
    const page = await app.window()
    await canvasReady(page)
    await drawRect(page)
    await app.terminate(signal) // no wait: the 500 ms autosave debounce has not fired yet
    expect(liveElements(board)).toHaveLength(2)
  })
}

test('an outside change to a clean board reloads it in place', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
  const board = `${vault}/Board.excalidraw`
  sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
  const app = await launch()
  const page = await app.window()
  await canvasReady(page)
  const before = await staticCanvasShot(page)
  writeOutside(board, scene([rect('a'), rect('from-outside', 50, 40, 100, 50, { backgroundColor: '#e03131' })]))
  await canvasChanged(page, before)
  // KNOWN RACE (found by this suite, reported on YAZ-2073 1C): an edit made within about a second of
  // the reload can raise a spurious "File changed on disk" bar — the watcher reports the one outside
  // write again after the reload (1 in 15 runs for an atomic write, 3 in 8 for an in-place one).
  // A person does not edit that fast; this test waits like one, so it pins the reload, not the race.
  await page.waitForTimeout(1_500)
  await expect(page.getByRole('alert').filter({ hasText: 'File changed on disk.' })).toHaveCount(0)
  // The buffer took the outside version: the next save keeps its element and adds ours.
  await drawRect(page, 150, 300)
  await expect.poll(() => liveElements(board)?.length).toBe(3)
  expect(liveElements(board)?.map((el) => el.id)).toEqual(expect.arrayContaining(['a', 'from-outside']))
})

test.describe('an outside change to a board with unsaved edits raises the conflict bar', () => {
  const setup = async ({ sandbox, launch }: { sandbox: Sandbox; launch: Fixtures['launch'] }) => {
    const vault = sandbox.vault('V', { 'Board.excalidraw': scene([rect('a')]) })
    const board = `${vault}/Board.excalidraw`
    sandbox.writeProfile({ windows: [{ root: vault, file: board }] })
    const app = await launch()
    const page = await app.window()
    await canvasReady(page)
    await drawRect(page) // dirty for the next 500 ms…
    writeOutside(board, scene([rect('a'), rect('theirs', 400, 0)])) // …and the disk moves under it
    const bar = page.getByRole('alert').filter({ hasText: 'File changed on disk.' })
    await expect(bar).toBeVisible()
    return { page, board, bar }
  }

  test('Reload takes the disk version and drops the unsaved edit', async ({ sandbox, launch }) => {
    const { page, board, bar } = await setup({ sandbox, launch })
    await bar.getByRole('button', { name: 'Reload' }).click()
    await expect(bar).toBeHidden()
    expect(liveElements(board)?.map((el) => el.id)).toEqual(['a', 'theirs'])
    await drawRect(page, 150, 300) // editing continues on the reloaded version
    await expect.poll(() => liveElements(board)?.length).toBe(3)
    expect(liveElements(board)?.map((el) => el.id)).toContain('theirs')
  })

  test('Keep mine writes the tab over the disk version', async ({ sandbox, launch }) => {
    const { board, bar } = await setup({ sandbox, launch })
    await bar.getByRole('button', { name: 'Keep mine' }).click()
    await expect(bar).toBeHidden()
    await expect.poll(() => liveElements(board)?.map((el) => el.id).includes('theirs')).toBe(false)
    expect(liveElements(board)).toHaveLength(2)
  })
})

test('a corrupt board and an empty file each show a readable error, not a crash', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Corrupt.excalidraw': '{ "type": "excalidraw", "elements": [', 'Empty.excalidraw': '', 'Fine.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Corrupt.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  const error = page.getByRole('alert').filter({ hasText: "This Excalidraw drawing can't be opened" })
  await expect(error).toBeVisible()
  await page.getByRole('treeitem', { name: 'Empty' }).click()
  await expect(error).toBeVisible()
  await page.getByRole('treeitem', { name: 'Fine' }).click()
  await canvasReady(page)
  expect(readScene(`${vault}/Fine.excalidraw`).elements).toHaveLength(1)
  expect(readFileSync(`${vault}/Corrupt.excalidraw`, 'utf8')).toBe('{ "type": "excalidraw", "elements": [')
})
