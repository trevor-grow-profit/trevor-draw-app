import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { makeFixture } from '../fs/testFixture'
import { createStore, type Store } from '../store'
import { fileClip } from '../fileClip'
import * as favorites from '../favorites'
import { registerFsIpc } from './fs'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  // fs:delete goes to the SYSTEM Trash; these tests must not move real files into it, so the
  // trash call is stubbed and the assertions are about the store repair and the broadcast.
  // `remove.test.ts` owns the disk-level behaviour.
  shell: { trashItem: vi.fn(async () => undefined) },
}))
// The favorites.json repair (YAZ-1766 6A, D13) rides the rename/delete handlers; `favorites.test.ts`
// owns its disk behaviour, so here it is a mock whose failure must never fail the file op.
vi.mock('../favorites', () => ({ renamePath: vi.fn(async () => undefined), removePath: vi.fn(async () => undefined) }))

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

function registered(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no handler registered for ${channel}`)
  return call[1] as unknown as Handler
}

/** A `BrowserWindow` stand-in: only what the broadcaster touches. */
function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  }
}

let root: string
let cleanup: () => Promise<void>
let storeDir: string
let store: Store
beforeAll(async () => {
  ;({ root, cleanup } = await makeFixture())
  storeDir = await mkdtemp(path.join(tmpdir(), 'yd-fs-ipc-'))
  store = createStore(path.join(storeDir, 'yaseendraw.json'))
})
afterAll(async () => {
  await store.flush()
  await cleanup()
  await rm(storeDir, { recursive: true, force: true })
})

/** Sender → window id lookup fake (E1b root guard); tests point `senderWinId` at a store entry. */
let senderWinId: string | undefined
const windows = { idFor: () => senderWinId }

describe('registerFsIpc', () => {
  it('registers every fs channel the preload invokes (and nothing else)', () => {
    registerFsIpc(store, windows)
    const channels = vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch).sort()
    expect(channels).toEqual([CONTRACT.createDir.channel, CONTRACT.createFile.channel, CONTRACT.file.delete.channel, CONTRACT.file.clip.channel, CONTRACT.file.paste.channel, CONTRACT.file.clipState.channel, CONTRACT.file.rename.channel, CONTRACT.tree.channel, CONTRACT.shell.reveal.channel, CONTRACT.shell.openVsCode.channel, CONTRACT.shell.openDefault.channel].sort())
  })

  it('answers with an envelope: a tree on success, a BridgeError on failure', async () => {
    const ok = await registered(CONTRACT.tree.channel)({ sender: {} }, root)
    expect(ok.ok).toBe(true)
    if (!ok.ok) throw new Error('expected ok')
    expect((ok.value as { root: string }).root).toBe(root)
    const missing = path.join(root, 'missing')
    expect(await registered(CONTRACT.tree.channel)({ sender: {} }, missing)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'path does not exist', path: missing },
    })
  })

  it('fs:rename renames on disk, repairs the store and broadcasts file:renamed to every window (Links E1, GRO-2194)', async () => {
    const oldPath = path.join(root, 'b.excalidraw')
    const newPath = path.join(root, 'bee.excalidraw')
    store.upsertWindow({ id: 'w1', root, file: oldPath, tabs: [oldPath], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
    store.setFolder(root, { lastFile: oldPath })
    const w = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
    const res = await registered(CONTRACT.file.rename.channel)({ sender: {} }, { oldPath, newPath })
    expect(res).toEqual({ ok: true, value: { oldPath, newPath, kind: 'file' } })
    expect(await readFile(newPath, 'utf8')).toBe('{"b":1}\n')
    // Store repaired in the SAME handler: window file/tabs and the folder's lastFile follow.
    expect(store.get().windows.find((win) => win.id === 'w1')).toMatchObject({ file: newPath, tabs: [newPath] })
    expect(store.get().folders[root].lastFile).toBe(newPath)
    // Every live window got the push (kind included — a `dir` push remaps by prefix, E1b).
    expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.file.onRenamed.channel, { oldPath, newPath, kind: 'file' })
  })

  it('fs:rename refuses the calling window\'s own vault root (E1b, GRO-2241) but allows another window\'s subfolder root', async () => {
    const sub = path.join(root, 'Zeta')
    store.upsertWindow({ id: 'w-sub', root: sub, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
    const w = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
    // The caller's OWN root: refused, nothing moves, nothing broadcast.
    senderWinId = 'w-sub'
    expect(await registered(CONTRACT.file.rename.channel)({ sender: {} }, { oldPath: sub, newPath: path.join(root, 'Zeta2') })).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'the vault root itself cannot be renamed', path: sub },
    })
    expect(w.webContents.send).not.toHaveBeenCalled()
    // The same dir renamed from a window rooted ABOVE it: allowed, and the sub-rooted
    // window's `WindowEntry.root` is repaired by the same handler.
    senderWinId = 'w1'
    const newPath = path.join(root, 'Zeta2')
    const res = await registered(CONTRACT.file.rename.channel)({ sender: {} }, { oldPath: sub, newPath })
    expect(res).toEqual({ ok: true, value: { oldPath: sub, newPath, kind: 'dir' } })
    expect(store.get().windows.find((win) => win.id === 'w-sub')?.root).toBe(newPath)
    expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.file.onRenamed.channel, { oldPath: sub, newPath, kind: 'dir' })
  })

  it('fs:rename failure answers a BridgeError envelope, repairs nothing and broadcasts nothing', async () => {
    const oldPath = path.join(root, 'A.excalidraw')
    const newPath = path.join(root, 'bee.excalidraw') // created by the test above
    const w = fakeWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
    const before = store.get()
    expect(await registered(CONTRACT.file.rename.channel)({ sender: {} }, { oldPath, newPath })).toEqual({
      ok: false,
      error: { code: 'ALREADY_EXISTS', message: 'a file with this name already exists', path: newPath },
    })
    expect(store.get()).toBe(before)
    expect(w.webContents.send).not.toHaveBeenCalled()
  })

  describe('fs:delete (GRO-2272)', () => {
    it('trashes the file, repairs the store and pushes file:deleted to every window', async () => {
      const target = path.join(root, 'delete-me.excalidraw')
      await writeFile(target, '# gone\n')
      store.upsertWindow({ id: 'wd', root, file: target, tabs: [target, path.join(root, 'A.excalidraw')], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      senderWinId = undefined
      const res = await registered(CONTRACT.file.delete.channel)({ sender: {} }, { path: target })
      expect(res).toEqual({ ok: true, value: { path: target, kind: 'file' } })
      // Store repaired in the SAME handler: the active file went, so the heir took over and
      // the SURVIVING tab is still there (the invariant removePath protects).
      expect(store.get().windows.find((win) => win.id === 'wd')).toMatchObject({ file: path.join(root, 'A.excalidraw'), tabs: [path.join(root, 'A.excalidraw')] })
      expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.file.onDeleted.channel, { path: target, kind: 'file' })
    })

    it("refuses the calling window's own vault root: nothing trashed, nothing broadcast", async () => {
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      store.upsertWindow({ id: 'w-own', root, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
      senderWinId = 'w-own'
      expect(await registered(CONTRACT.file.delete.channel)({ sender: {} }, { path: root })).toEqual({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'the vault root itself cannot be deleted', path: root },
      })
      expect(w.webContents.send).not.toHaveBeenCalled()
      await expect(readFile(path.join(root, 'A.excalidraw'), 'utf8')).resolves.toBe('{"A":1}\n') // vault intact
      senderWinId = undefined
    })

    it("allows deleting a folder that is ANOTHER window's root — onRootMissing owns that repair, so the stored root is untouched", async () => {
      const sub = path.join(root, 'DeleteMeDir')
      await mkdir(sub, { recursive: true })
      await writeFile(path.join(sub, 'inner.excalidraw'), 'inner')
      store.upsertWindow({ id: 'w-other', root: sub, file: path.join(sub, 'inner.excalidraw'), tabs: [path.join(sub, 'inner.excalidraw')], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      senderWinId = undefined
      expect(await registered(CONTRACT.file.delete.channel)({ sender: {} }, { path: sub })).toEqual({ ok: true, value: { path: sub, kind: 'dir' } })
      const other = store.get().windows.find((win) => win.id === 'w-other')
      expect(other?.root).toBe(sub) // deliberately NOT nulled here
      expect(other?.file).toBeNull() // the file under it went
      expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.file.onDeleted.channel, { path: sub, kind: 'dir' })
    })

    it('a refused delete (dot-folder) answers a BridgeError envelope and broadcasts nothing', async () => {
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const dot = path.join(root, '.obsidian')
      const res = await registered(CONTRACT.file.delete.channel)({ sender: {} }, { path: dot })
      expect(res).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: 'hidden entries cannot be deleted', path: dot } })
      expect(w.webContents.send).not.toHaveBeenCalled()
    })
  })

  describe('favorites.json repair (YAZ-1766 6A, D13)', () => {
    it('fs:rename hands the open roots + paths to favorites.renamePath; a repair failure is warned and the op still answers and broadcasts', async () => {
      const oldPath = path.join(root, 'fav-a.excalidraw')
      const newPath = path.join(root, 'fav-b.excalidraw')
      await writeFile(oldPath, '# fav\n')
      store.upsertWindow({ id: 'w-fav', root, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.mocked(favorites.renamePath).mockRejectedValueOnce(new Error('favorites.json is read-only'))
      senderWinId = undefined
      expect(await registered(CONTRACT.file.rename.channel)({ sender: {} }, { oldPath, newPath })).toEqual({ ok: true, value: { oldPath, newPath, kind: 'file' } })
      expect(vi.mocked(favorites.renamePath)).toHaveBeenCalledWith(expect.arrayContaining([root]), oldPath, newPath)
      expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.file.onRenamed.channel, { oldPath, newPath, kind: 'file' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('favorites.json is read-only'))
      store.removeWindow('w-fav')
    })

    it('fs:delete hands the open roots + path to favorites.removePath; a repair failure is warned and the delete still answers and broadcasts', async () => {
      const target = path.join(root, 'fav-gone.excalidraw')
      await writeFile(target, '# gone\n')
      store.upsertWindow({ id: 'w-fav', root, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      vi.mocked(favorites.removePath).mockRejectedValueOnce(new Error('boom'))
      senderWinId = undefined
      expect(await registered(CONTRACT.file.delete.channel)({ sender: {} }, { path: target })).toEqual({ ok: true, value: { path: target, kind: 'file' } })
      expect(vi.mocked(favorites.removePath)).toHaveBeenCalledWith(expect.arrayContaining([root]), target)
      expect(w.webContents.send).toHaveBeenCalledWith(CONTRACT.file.onDeleted.channel, { path: target, kind: 'file' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
      store.removeWindow('w-fav')
    })
  })

  describe('fs:clip / fs:paste (YAZ-1674)', () => {
    const win = (id: string, file: string | null) =>
      store.upsertWindow({ id, root, file, tabs: file === null ? [] : [file], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 0, y: 0, width: 800, height: 600 } })

    it('fs:clip stores the ordered selection and pushes clip:changed (count + op) to EVERY window (D1)', async () => {
      fileClip.clear()
      const a = fakeWindow()
      const b = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([a as never, b as never])
      const paths = [path.join(root, 'b.excalidraw'), path.join(root, 'Zeta')]
      expect(await registered(CONTRACT.file.clip.channel)({ sender: {} }, { op: 'copy', paths })).toEqual({ ok: true, value: undefined })
      expect(fileClip.get()).toEqual({ op: 'copy', paths })
      for (const w of [a, b]) expect(w.webContents.send).toHaveBeenCalledExactlyOnceWith(CONTRACT.file.onClipChanged.channel, { count: 2, op: 'copy' })
    })

    it('fs:clip with bad input answers a BridgeError envelope, keeps the clipboard and pushes nothing', async () => {
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const before = fileClip.get()
      expect(await registered(CONTRACT.file.clip.channel)({ sender: {} }, { op: 'cut', paths: ['relative.excalidraw'] })).toEqual({
        ok: false,
        error: { code: 'NOT_ABSOLUTE', message: "'paths' must be an absolute path", path: 'relative.excalidraw' },
      })
      expect(await registered(CONTRACT.file.clip.channel)({ sender: {} }, { op: 'cut', paths: [] })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } })
      expect(fileClip.get()).toBe(before)
      expect(w.webContents.send).not.toHaveBeenCalled()
    })

    it('fs:clip-state answers null when empty and { count, op } after a set — the catch-up read for a window that mounts after a clip', async () => {
      fileClip.clear()
      expect(await registered(CONTRACT.file.clipState.channel)({ sender: {} })).toEqual({ ok: true, value: null })
      fileClip.set({ op: 'cut', paths: [path.join(root, 'A.excalidraw'), path.join(root, 'b.excalidraw')] })
      expect(await registered(CONTRACT.file.clipState.channel)({ sender: {} })).toEqual({ ok: true, value: { count: 2, op: 'cut' } })
      fileClip.clear()
    })

    it('fs:paste with an empty clipboard is BAD_REQUEST "nothing to paste"', async () => {
      fileClip.clear()
      expect(await registered(CONTRACT.file.paste.channel)({ sender: {} }, { targetDir: root })).toEqual({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'nothing to paste' },
      })
    })

    it('paste of a COPY copies under a free name, repairs NOTHING, pushes NO file event, and KEEPS the clipboard (D2/D4)', async () => {
      const src = path.join(root, 'copy-src.excalidraw')
      await writeFile(src, 'copy me')
      win('w-copy', src)
      fileClip.set({ op: 'copy', paths: [src] })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const before = store.get()
      // Into its own folder: Duplicate for free.
      const res = await registered(CONTRACT.file.paste.channel)({ sender: {} }, { targetDir: root })
      expect(res).toEqual({ ok: true, value: { pasted: [{ from: src, to: path.join(root, 'copy-src copy.excalidraw'), kind: 'file' }], failed: [] } })
      expect(await readFile(path.join(root, 'copy-src copy.excalidraw'), 'utf8')).toBe('copy me')
      expect(await readFile(src, 'utf8')).toBe('copy me')
      expect(store.get()).toBe(before) // nothing moved: no repair
      expect(w.webContents.send).not.toHaveBeenCalled() // no file:renamed, no clip:changed
      expect(fileClip.get()).toEqual({ op: 'copy', paths: [src] }) // a copy pastes again and again
      const again = await registered(CONTRACT.file.paste.channel)({ sender: {} }, { targetDir: root })
      expect(again).toMatchObject({ ok: true, value: { pasted: [{ to: path.join(root, 'copy-src copy 2.excalidraw') }] } })
    })

    it('paste of a CUT moves through the rename pipeline — store repaired, file:renamed per entry — then CLEARS the clipboard (D2)', async () => {
      const dir = path.join(root, 'cut-target')
      await mkdir(dir)
      const a = path.join(root, 'cut-a.excalidraw')
      const b = path.join(root, 'cut-b.excalidraw')
      await writeFile(a, 'a')
      await writeFile(b, 'b')
      win('w-cut', a)
      store.setFolder(root, { lastFile: b })
      fileClip.set({ op: 'cut', paths: [a, b] })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const res = await registered(CONTRACT.file.paste.channel)({ sender: {} }, { targetDir: dir })
      const toA = path.join(dir, 'cut-a.excalidraw')
      const toB = path.join(dir, 'cut-b.excalidraw')
      expect(res).toEqual({ ok: true, value: { pasted: [{ from: a, to: toA, kind: 'file' }, { from: b, to: toB, kind: 'file' }], failed: [] } })
      expect(await readFile(toA, 'utf8')).toBe('a')
      // The SAME downstream as fs:rename, once per entry: window file/tabs and lastFile follow…
      expect(store.get().windows.find((x) => x.id === 'w-cut')).toMatchObject({ file: toA, tabs: [toA] })
      expect(store.get().folders[root].lastFile).toBe(toB)
      // …and every window got file:renamed per entry, then clip:changed null (the cut pasted once).
      expect(w.webContents.send).toHaveBeenNthCalledWith(1, CONTRACT.file.onRenamed.channel, { oldPath: a, newPath: toA, kind: 'file' })
      expect(w.webContents.send).toHaveBeenNthCalledWith(2, CONTRACT.file.onRenamed.channel, { oldPath: b, newPath: toB, kind: 'file' })
      expect(w.webContents.send).toHaveBeenNthCalledWith(3, CONTRACT.file.onClipChanged.channel, null)
      expect(fileClip.get()).toBeNull()
    })

    it('a CUT whose every entry failed keeps the clipboard (the user fixes the cause and pastes again); the failures ride in the envelope', async () => {
      const dir = path.join(root, 'cut-clash')
      await mkdir(dir)
      await writeFile(path.join(dir, 'same.excalidraw'), 'keep')
      const src = path.join(root, 'same.excalidraw')
      await writeFile(src, 'incoming')
      fileClip.set({ op: 'cut', paths: [src] })
      const w = fakeWindow()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([w as never])
      const res = await registered(CONTRACT.file.paste.channel)({ sender: {} }, { targetDir: dir })
      expect(res).toEqual({ ok: true, value: { pasted: [], failed: [{ from: src, code: 'ALREADY_EXISTS', message: 'a file with this name already exists' }] } })
      expect(await readFile(path.join(dir, 'same.excalidraw'), 'utf8')).toBe('keep')
      expect(fileClip.get()).toEqual({ op: 'cut', paths: [src] })
      expect(w.webContents.send).not.toHaveBeenCalled()
    })

    it('a missing target folder is a whole-call BridgeError envelope: nothing pasted, clipboard kept', async () => {
      fileClip.set({ op: 'copy', paths: [path.join(root, 'A.excalidraw')] })
      const missing = path.join(root, 'no-such-dir')
      expect(await registered(CONTRACT.file.paste.channel)({ sender: {} }, { targetDir: missing })).toEqual({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'path does not exist', path: missing },
      })
      expect(fileClip.get()).not.toBeNull()
      fileClip.clear()
    })
  })
})
