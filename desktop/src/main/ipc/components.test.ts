/**
 * The `components:*` doors on a real temp library, with `electron` mocked (🔒 YAZ-1775 D5, YAZ-1819): the
 * six channels, the guards a sandboxed renderer's arguments have to pass, and the ONE push every
 * window gets whichever vault it is on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { LIBRARY_COMPONENTS_DIR } from '@shared/types'
import { CONTRACT } from '@shared/ipc'
import type { ComponentStore } from '../library/componentStore'
import { createStore, type Store } from '../store'
import { registerComponentsIpc } from './components'
import { registered } from './ipcFixture'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { trashItem: vi.fn(async () => undefined) },
}))

const ok = (value: unknown) => ({ ok: true, value })
const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })
const sender = { id: 1 }

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const fragment = (elements: unknown[] = [{ id: 'e1', type: 'rectangle' }]) =>
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw', elements, appState: {}, files: {} })

const until = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A `BrowserWindow` stand-in: only what the broadcaster touches. */
function fakeWindow() {
  return { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } }
}

let dir: string
let userData: string
let store: Store
let components: ComponentStore
let trashed: string[]
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
  dir = await mkdtemp(path.join(tmpdir(), 'yd-components-ipc-'))
  userData = path.join(dir, 'userData')
  await mkdir(path.join(userData, 'library'), { recursive: true })
  store = createStore(path.join(userData, 'yaseendraw.json'))
  trashed = []
  components = registerComponentsIpc(store, userData, async (p) => {
    trashed.push(p)
    await rm(p, { force: true })
  })
})
afterEach(async () => {
  await components.close()
  await store.flush()
  await rm(dir, { recursive: true, force: true })
})

const list = () => registered(CONTRACT.components.list)({ sender })
const save = (req: unknown) => registered(CONTRACT.components.save)({ sender }, req)
const read = (req: unknown) => registered(CONTRACT.components.read)({ sender }, req)
const renameIt = (req: unknown) => registered(CONTRACT.components.rename)({ sender }, req)
const remove = (req: unknown) => registered(CONTRACT.components.delete)({ sender }, req)
const preview = (req: unknown) => registered(CONTRACT.components.preview)({ sender }, req)

describe('registerComponentsIpc (🔒 YAZ-1775 D5, YAZ-1819)', () => {
  it('save → list → read → preview → rename → delete, all under `<userData>/library` by default (🔒 YAZ-1775 D5)', async () => {
    const saved = await save({ name: 'A card', fragmentJson: fragment(), previewPng: PNG })
    expect(saved).toEqual(ok(expect.objectContaining({ slug: 'a-card', name: 'A card', elementCount: 1 })))
    expect(await readdir(path.join(userData, 'library', LIBRARY_COMPONENTS_DIR))).toContain('a-card.excalidraw')
    // A component is a fragment in the LIBRARY, not a board: no `yaseendraw` block (🔒 YAZ-1834 D7).
    expect(await readFile(path.join(userData, 'library', LIBRARY_COMPONENTS_DIR, 'a-card.excalidraw'), 'utf8')).toBe(`${fragment()}\n`)
    expect(await list()).toEqual(ok([expect.objectContaining({ slug: 'a-card' })]))
    expect(await read({ slug: 'a-card' })).toEqual(ok({ fragmentJson: `${fragment()}\n` }))
    expect(await preview({ slug: 'a-card' })).toEqual(ok(PNG))
    expect(await renameIt({ slug: 'a-card', name: 'Renamed' })).toEqual(ok(expect.objectContaining({ slug: 'a-card', name: 'Renamed' })))
    expect(await remove({ slug: 'a-card' })).toEqual(ok(undefined))
    expect(trashed.map((p) => path.basename(p)).sort()).toEqual(['a-card.excalidraw', 'a-card.png'])
    expect(await list()).toEqual(ok([]))
  })

  it('`read` answers an ENVELOPE around the fragment, not the bare bytes — the shape the contract names', async () => {
    await save({ name: 'A card', fragmentJson: fragment(), previewPng: PNG })
    expect(await read({ slug: 'a-card' })).toEqual({ ok: true, value: { fragmentJson: expect.stringContaining('"elements"') } })
  })

  it('a request that is not a request at all is BAD_REQUEST on every door', async () => {
    for (const req of [undefined, null, 'a-card', 42, []]) {
      expect(await save(req), String(req)).toEqual(bad('BAD_REQUEST'))
      expect(await read(req), String(req)).toEqual(bad('BAD_REQUEST'))
      expect(await renameIt(req), String(req)).toEqual(bad('BAD_REQUEST'))
      expect(await remove(req), String(req)).toEqual(bad('BAD_REQUEST'))
      expect(await preview(req), String(req)).toEqual(bad('BAD_REQUEST'))
    }
  })

  it('a missing or empty field is BAD_REQUEST before anything is touched', async () => {
    expect(await save({ name: '', fragmentJson: fragment(), previewPng: PNG })).toEqual(bad('BAD_REQUEST'))
    expect(await save({ name: 'A card', fragmentJson: '', previewPng: PNG })).toEqual(bad('BAD_REQUEST'))
    expect(await save({ name: 'A card', fragmentJson: fragment(), previewPng: 7 })).toEqual(bad('BAD_REQUEST'))
    expect(await renameIt({ slug: 'a-card' })).toEqual(bad('BAD_REQUEST'))
    expect(await readdir(path.join(userData, 'library'))).toEqual([])
  })

  it('a slug that could leave the components folder never reaches the filesystem', async () => {
    for (const slug of ['../../etc/passwd', 'a/b', '..', 'A-Card']) {
      expect(await read({ slug }), slug).toEqual(bad('BAD_REQUEST'))
      expect(await remove({ slug }), slug).toEqual(bad('BAD_REQUEST'))
    }
    expect(trashed).toEqual([])
  })

  it('a component that is not there is NOT_FOUND, not a crash', async () => {
    expect(await read({ slug: 'gone' })).toEqual(bad('NOT_FOUND'))
    expect(await remove({ slug: 'gone' })).toEqual(bad('NOT_FOUND'))
  })

  it('broadcasts components:changed to EVERY window on a save, whichever vault they are on (🔒 YAZ-1775 D5)', async () => {
    const a = fakeWindow()
    const b = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([a, b] as unknown as BrowserWindow[])
    await save({ name: 'A card', fragmentJson: fragment(), previewPng: PNG })
    expect(a.webContents.send).toHaveBeenCalledWith(CONTRACT.components.onChanged.channel)
    expect(b.webContents.send).toHaveBeenCalledWith(CONTRACT.components.onChanged.channel)
    // No payload: a window re-lists regardless of its root, because the library is one folder.
    expect(a.webContents.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.components.onChanged.channel)
  })

  it('a change of `settings.libraryFolder` re-points the store AND counts as a change of the library', async () => {
    await save({ name: 'A card', fragmentJson: fragment(), previewPng: PNG })
    const other = path.join(dir, 'other-library')
    await mkdir(other, { recursive: true })
    const win = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([win] as unknown as BrowserWindow[])
    store.setSettings({ ...store.get().settings, libraryFolder: other })
    await until(() => win.webContents.send.mock.calls.length > 0)
    expect(win.webContents.send).toHaveBeenCalledWith(CONTRACT.components.onChanged.channel)
    expect(await list()).toEqual(ok([]))
    store.setSettings({ ...store.get().settings, libraryFolder: null })
    expect(await list()).toEqual(ok([expect.objectContaining({ slug: 'a-card' })]))
  })
})
