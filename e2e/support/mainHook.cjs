/**
 * Preloaded into the app's MAIN process (`electron -r mainHook.cjs desktop`) before
 * `out/main/index.js` runs. It changes nothing the app does to its own windows, files or state —
 * only the places where the app hands off to the OS, so a test run never reaches outside its
 * sandbox (`E2E_SANDBOX`, set by support/fixtures.ts):
 *
 *  - `setAsDefaultProtocolClient` would register the dev Electron binary as the OS handler for
 *    `yaseendraw://` on every launch; a test run leaves LaunchServices alone.
 *  - `shell.trashItem` moves into `<sandbox>/Trash` instead of the user's Trash, and the other
 *    hand-offs (Finder reveal, default app, browser / VS Code URLs) are recorded one JSON line each
 *    in `<sandbox>/os-calls.jsonl` instead of opening anything — a spec asserts on that file. A path
 *    outside the sandbox throws instead: an app bug must not move a real file into a folder the
 *    run then deletes.
 *  - `<sandbox>/quit.marker` is written when the app's own quit sequence reaches `app.exit` —
 *    its flushes are done by then — so a spec can tell "quit finished" from "the process is gone"
 *    (Electron's teardown after `app.exit` can take many seconds on a loaded Mac).
 *  - every window is made fully transparent (not hidden: a hidden window is throttled and would
 *    change what the renderer does), so a run does not paint over the desktop. `E2E_SHOW=1`
 *    leaves the windows visible for debugging.
 *
 * A packaged bundle ignores `-r`, so under `E2E_PACKAGED=1` support/fixtures.ts requires this file
 * into the running app right after launch instead: everything above then holds except the
 * `yaseendraw://` registration, which the bundle has already made by then (as any launch of it does).
 */
const { app, BrowserWindow, shell } = require('electron')
const { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } = require('node:fs')
const { basename, dirname, join, sep } = require('node:path')

const sandbox = process.env.E2E_SANDBOX
if (!sandbox) throw new Error('mainHook: E2E_SANDBOX is not set')
const REAL_SANDBOX = realpathSync(sandbox)

/** `path` itself, resolved through symlinks (/var → /private/var) via its folder, which exists. */
const real = (path) => join(realpathSync(dirname(path)), basename(path))
function inSandbox(call, path) {
  if (!real(path).startsWith(REAL_SANDBOX + sep)) throw new Error(`mainHook: ${call} outside the test sandbox: ${path}`)
}
const record = (call, arg) => appendFileSync(join(sandbox, 'os-calls.jsonl'), `${JSON.stringify({ call, arg })}\n`)

app.setAsDefaultProtocolClient = () => true
app.on('quit', () => writeFileSync(join(sandbox, 'quit.marker'), ''))

shell.trashItem = async (path) => {
  inSandbox('trashItem', path)
  const trash = join(sandbox, 'Trash')
  mkdirSync(trash, { recursive: true })
  renameSync(path, join(trash, `${Date.now()}-${basename(path)}`))
}
shell.showItemInFolder = (path) => {
  inSandbox('showItemInFolder', path)
  record('showItemInFolder', path)
}
shell.openPath = async (path) => {
  inSandbox('openPath', path)
  record('openPath', path)
  return ''
}
shell.openExternal = async (url) => record('openExternal', url)

if (process.env.E2E_SHOW !== '1') {
  app.on('browser-window-created', (_event, win) => win.setOpacity(0))
  for (const win of BrowserWindow.getAllWindows()) win.setOpacity(0) // late install (packaged)
}
