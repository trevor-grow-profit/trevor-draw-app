/**
 * Links and file hand-offs (docs/CONTRACTS.md "Links"): `yaseendraw://` links, a Finder
 * double-click (`open-file`), and a board path in argv (a Windows/Linux double-click, and a cold
 * start). The OS side — LaunchServices registration — stays in docs/REGRESSION.md (O1–O4).
 */
import { spawn } from 'node:child_process'
import { appCommand, identity, test, expect, type DrawApp } from './support/fixtures'
import { canvasReady } from './support/canvas'
import { diagramReady } from './support/drawio'
import { notice, treeReady } from './support/sidebar'
import { diagram, diagramBox, rect, scene } from './support/vault'

/** What macOS would deliver: `open-url` for a clicked link, `open-file` for a double-clicked board. */
const emit = (app: DrawApp, event: 'open-url' | 'open-file', arg: string) =>
  app.electron.evaluate(({ app: electronApp }, [name, value]) => {
    electronApp.emit(name, { preventDefault() {} }, value)
  }, [event, arg] as const)

const fileLink = (path: string) => `yaseendraw://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`

test('a yaseendraw:// link opens its board in the window already on that vault', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Linked board.excalidraw': scene([rect('a')]), 'Other.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Other.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await emit(app, 'open-url', fileLink(`${vault}/Linked board.excalidraw`))
  await expect(page.getByRole('tab', { name: 'Linked board' })).toHaveAttribute('aria-selected', 'true')
  await canvasReady(page)
  expect(app.electron.windows()).toHaveLength(1)
})

test('a link into a vault no window has open opens a new window on that vault', async ({ sandbox, launch }) => {
  const home = sandbox.vault('Home', { 'H.excalidraw': scene() })
  const away = sandbox.vault('Away', { 'Deep/Target.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: home }] })
  const app = await launch()
  const first = await app.window()
  await treeReady(first)
  await emit(app, 'open-url', `${fileLink(`${away}/Deep/Target.excalidraw`)}?root=${encodeURIComponent(away)}`)
  const pages = await app.windows(2)
  const second = pages.find((p) => p !== first)
  if (second === undefined) throw new Error('no second window')
  await expect(second.getByRole('tab', { name: 'Target' })).toBeVisible()
  expect((await identity(second)).root).toBe(away)
})

test('a broken link shows a notice, never a dialog', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await emit(app, 'open-url', 'yaseendraw://not a path')
  await expect(notice(page)).toContainText("Can't open link: yaseendraw://not a path")
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a double-clicked .drawio (open-file) opens in its vault’s window', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Flow.drawio': diagram(diagramBox('c1', 'Opened by Finder')), 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await emit(app, 'open-file', `${vault}/Flow.drawio`)
  await diagramReady(page, 'Opened by Finder')
})

test('a cold start handed a board path opens it — the parent folder becomes the vault when none is open', async ({ sandbox, launch }) => {
  const loose = sandbox.vault('Loose folder', { 'Handed over.excalidraw': scene([rect('a')]) })
  sandbox.writeProfile({ windows: [{ root: null }] })
  const app = await launch({ args: [`${loose}/Handed over.excalidraw`] })
  // A window still navigating has no bridge yet: its identity reads as null, and the poll asks again.
  const holding = async () => {
    for (const p of app.electron.windows()) if ((await identity(p).catch(() => null))?.file === `${loose}/Handed over.excalidraw`) return p
    return null
  }
  await expect.poll(async () => (await holding()) !== null).toBe(true)
  const page = await holding()
  if (page === null) throw new Error('no window holds the board')
  expect((await identity(page)).root).toBe(loose)
  await canvasReady(page)
})

test('a second launch on the same profile hands its board to the running app and exits (single instance)', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Second launch.excalidraw': scene([rect('a')]), 'Other.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault, file: `${vault}/Other.excalidraw` }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  // The same binary, the same profile, a board in argv: what a Windows double-click does.
  const { command, args } = appCommand([`${vault}/Second launch.excalidraw`])
  const second = spawn(command, args, { env: sandbox.env(), stdio: 'ignore' })
  const exitCode = await new Promise<number | null>((resolve) => second.once('exit', resolve))
  expect(exitCode).toBe(0)
  await expect(page.getByRole('tab', { name: 'Second launch' })).toHaveAttribute('aria-selected', 'true')
  expect(app.electron.windows()).toHaveLength(1)
})

test('a web link the page tries to open goes to the browser; nothing opens inside the app', async ({ sandbox, launch }) => {
  const vault = sandbox.vault('V', { 'Board.excalidraw': scene() })
  sandbox.writeProfile({ windows: [{ root: vault }] })
  const app = await launch()
  const page = await app.window()
  await treeReady(page)
  await page.evaluate(() => {
    window.open('https://example.com/docs', '_blank')
    window.open('file:///etc/hosts', '_blank')
  })
  await expect.poll(() => sandbox.osCalls()).toEqual([{ call: 'openExternal', arg: 'https://example.com/docs' }])
  expect(app.electron.windows()).toHaveLength(1)
})
