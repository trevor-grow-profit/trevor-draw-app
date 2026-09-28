import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { registerDialogIpc } from './dialog'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

function registered(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no handler registered for ${channel}`)
  return call[1] as unknown as Handler
}

const showOpenDialog = vi.mocked(dialog.showOpenDialog)
const showSaveDialog = vi.mocked(dialog.showSaveDialog)
const fromWebContents = vi.mocked(BrowserWindow.fromWebContents)
const sender = { id: 1 }

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
  showOpenDialog.mockReset()
  showSaveDialog.mockReset()
  fromWebContents.mockReset().mockReturnValue(null)
  registerDialogIpc()
})

const pick = () => registered(CONTRACT.pickFolder.channel)({ sender })
const open = () => registered(CONTRACT.dialog.openDrawing.channel)({ sender })

describe('dialog:pick-folder', () => {
  it('registers exactly the four dialog channels', () => {
    expect(vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch)).toEqual([CONTRACT.pickFolder.channel, CONTRACT.dialog.openDrawing.channel, CONTRACT.dialog.saveDrawing.channel, CONTRACT.dialog.saveImage.channel])
  })

  it('opens an openDirectory dialog parented to the calling window and answers { path }', async () => {
    const win = { id: 'w' } as unknown as BrowserWindow
    fromWebContents.mockReturnValue(win)
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/x/vault'] })
    expect(await pick()).toEqual({ ok: true, value: { path: '/Users/x/vault' } })
    expect(fromWebContents).toHaveBeenCalledWith(sender)
    expect(showOpenDialog).toHaveBeenCalledWith(win, { title: 'Open folder', properties: ['openDirectory', 'createDirectory'] })
  })

  it('falls back to an unparented dialog when the sender has no window', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/x/vault'] })
    expect(await pick()).toEqual({ ok: true, value: { path: '/Users/x/vault' } })
    expect(showOpenDialog).toHaveBeenCalledWith({ title: 'Open folder', properties: ['openDirectory', 'createDirectory'] })
  })

  it('answers { cancelled: true } when the dialog is dismissed or returns no path', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await pick()).toEqual({ ok: true, value: { cancelled: true } })
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect(await pick()).toEqual({ ok: true, value: { cancelled: true } })
  })

  it('strips trailing slashes from the picked path, except for the filesystem root', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/x/vault//'] })
    expect(await pick()).toEqual({ ok: true, value: { path: '/Users/x/vault' } })
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/'] })
    expect(await pick()).toEqual({ ok: true, value: { path: '/' } })
  })

  it('a dialog failure comes out as PICKER_FAILED', async () => {
    showOpenDialog.mockRejectedValue(new Error('no display'))
    expect(await pick()).toEqual({ ok: false, error: { code: 'PICKER_FAILED', message: 'no display' } })
  })
})

describe('one dialog in flight per window', () => {
  /** A dialog the test settles by hand, so a pick can be held open mid-flight. */
  function pendingDialog() {
    let settle!: (v: Electron.OpenDialogReturnValue) => void
    showOpenDialog.mockReturnValueOnce(
      new Promise<Electron.OpenDialogReturnValue>((r) => {
        settle = r
      }),
    )
    return { settle }
  }

  it('a second call while a dialog is open for the window resolves { cancelled: true }; the guard lifts when it settles', async () => {
    const win = { id: 'w' } as unknown as BrowserWindow
    fromWebContents.mockReturnValue(win)
    const { settle } = pendingDialog()
    const first = pick()
    expect(await pick()).toEqual({ ok: true, value: { cancelled: true } })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    settle({ canceled: false, filePaths: ['/Users/x/vault'] })
    expect(await first).toEqual({ ok: true, value: { path: '/Users/x/vault' } })
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/x/other'] })
    expect(await pick()).toEqual({ ok: true, value: { path: '/Users/x/other' } })
  })

  it('windows are guarded independently — a dialog open for one does not block another', async () => {
    const a = { id: 'a' } as unknown as BrowserWindow
    const b = { id: 'b' } as unknown as BrowserWindow
    fromWebContents.mockReturnValueOnce(a).mockReturnValueOnce(b)
    const heldA = pendingDialog()
    const heldB = pendingDialog()
    const pickA = pick()
    const pickB = pick()
    expect(showOpenDialog).toHaveBeenCalledTimes(2)
    heldA.settle({ canceled: false, filePaths: ['/vault/a'] })
    heldB.settle({ canceled: false, filePaths: ['/vault/b'] })
    expect(await pickA).toEqual({ ok: true, value: { path: '/vault/a' } })
    expect(await pickB).toEqual({ ok: true, value: { path: '/vault/b' } })
  })

  it('windowless senders share one guard bucket', async () => {
    const { settle } = pendingDialog()
    const first = pick()
    expect(await pick()).toEqual({ ok: true, value: { cancelled: true } })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    settle({ canceled: true, filePaths: [] })
    expect(await first).toEqual({ ok: true, value: { cancelled: true } })
  })

  it('the guard lifts on dialog failure too', async () => {
    showOpenDialog.mockRejectedValueOnce(new Error('no display'))
    expect(await pick()).toEqual({ ok: false, error: { code: 'PICKER_FAILED', message: 'no display' } })
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/x/vault'] })
    expect(await pick()).toEqual({ ok: true, value: { path: '/Users/x/vault' } })
  })
})


/**
 * The import picker (YAZ-1833). It answers the picked file's BYTES, so these run against a real
 * temp file — the read is the door's own, not a mock's.
 */
describe('dialog:open-file', () => {
  let dir = ''
  const made: string[] = []
  const file = async (name: string, content: string) => {
    if (dir === '') {
      dir = await mkdtemp(path.join(tmpdir(), 'yd-dialog-'))
      made.push(dir)
    }
    const p = path.join(dir, name)
    await writeFile(p, content, 'utf8')
    return p
  }
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true })
  })

  it('opens an openFile dialog filtered to .excalidraw, parented to the calling window', async () => {
    const win = { id: 'w' } as unknown as BrowserWindow
    fromWebContents.mockReturnValue(win)
    const picked = await file('03 Legacy embedded.excalidraw', '{"type":"excalidraw","elements":[]}')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [picked] })
    expect(await open()).toEqual({
      ok: true,
      value: { path: picked, name: '03 Legacy embedded', content: '{"type":"excalidraw","elements":[]}' },
    })
    expect(showOpenDialog).toHaveBeenCalledWith(win, {
      title: 'Import Excalidraw JSON',
      properties: ['openFile'],
      filters: [{ name: 'Excalidraw', extensions: ['excalidraw'] }],
    })
  })

  it('answers { cancelled: true } when the dialog is dismissed or returns no path', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await open()).toEqual({ ok: true, value: { cancelled: true } })
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect(await open()).toEqual({ ok: true, value: { cancelled: true } })
  })

  it('a filter can be defeated by typing a name, so the extension is checked again', async () => {
    const picked = await file('notes.txt', 'hello')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [picked] })
    expect(await open()).toEqual({ ok: false, error: { code: 'UNSUPPORTED_EXTENSION', message: 'only .excalidraw files are editable', path: picked } })
  })

  it('a file that has gone between the pick and the read is NOT_FOUND, never a crash', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(tmpdir(), 'yd-dialog-missing', 'gone.excalidraw')] })
    const answer = (await open()) as { ok: false; error: { code: string } }
    expect(answer.ok).toBe(false)
    expect(answer.error.code).toBe('NOT_FOUND')
  })

  it('shares the one-dialog-in-flight guard with the folder picker', async () => {
    let settle!: (v: Electron.OpenDialogReturnValue) => void
    showOpenDialog.mockReturnValueOnce(
      new Promise<Electron.OpenDialogReturnValue>((r) => {
        settle = r
      }),
    )
    const first = pick()
    expect(await open()).toEqual({ ok: true, value: { cancelled: true } })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    settle({ canceled: true, filePaths: [] })
    expect(await first).toEqual({ ok: true, value: { cancelled: true } })
  })
})


/**
 * The export sheet and the write behind it (🔒 YAZ-1775 D3, YAZ-1821). One door: the only path ever written
 * is the one the user has just typed into a native sheet, in the same call.
 */
describe('dialog:save-file', () => {
  let dir = ''
  const made: string[] = []
  const destination = async (name: string) => {
    if (dir === '') {
      dir = await mkdtemp(path.join(tmpdir(), 'yd-export-'))
      made.push(dir)
    }
    return path.join(dir, name)
  }
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true })
  })

  const save = (body: unknown) => registered(CONTRACT.dialog.saveDrawing.channel)({ sender }, body)
  const SCENE = '{"type":"excalidraw","version":2,"elements":[],"files":{}}\n'

  it('opens a save sheet on the board\u2019s own name and writes the bytes atomically', async () => {
    const win = { id: 'w' } as unknown as BrowserWindow
    fromWebContents.mockReturnValue(win)
    const target = await destination('Roadmap.excalidraw')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await save({ defaultName: 'Roadmap.excalidraw', content: SCENE })).toEqual({ ok: true, value: { path: target } })
    // An export is a snapshot, not a board: the bytes land verbatim, with no `yaseendraw` block (🔒 YAZ-1834 D3).
    expect(await readFile(target, 'utf8')).toBe(SCENE)
    expect(showSaveDialog).toHaveBeenCalledWith(win, {
      title: 'Export Excalidraw Drawing',
      filters: [{ name: 'Excalidraw', extensions: ['excalidraw'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
      defaultPath: 'Roadmap.excalidraw',
    })
    expect(await readFile(target, 'utf8')).toBe(SCENE)
  })

  it('a dismissed sheet writes NOTHING', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await save({ defaultName: 'a.excalidraw', content: SCENE })).toEqual({ ok: true, value: { cancelled: true } })
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: undefined as unknown as string })
    expect(await save({ defaultName: 'a.excalidraw', content: SCENE })).toEqual({ ok: true, value: { cancelled: true } })
  })

  it('a sheet lets a name be typed freely, so the extension is enforced', async () => {
    const target = await destination('notes.txt')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await save({ defaultName: 'a.excalidraw', content: SCENE })).toEqual({
      ok: false,
      error: { code: 'UNSUPPORTED_EXTENSION', message: 'only .excalidraw files are editable', path: target },
    })
  })

  it('a malformed request never reaches a sheet', async () => {
    for (const body of [undefined, {}, { defaultName: '' , content: SCENE }, { defaultName: 'a.excalidraw', content: '' }]) {
      const answer = (await save(body)) as { ok: false; error: { code: string } }
      expect(answer.ok).toBe(false)
      expect(answer.error.code).toBe('BAD_REQUEST')
    }
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('a sheet failure comes out as PICKER_FAILED', async () => {
    showSaveDialog.mockRejectedValueOnce(new Error('no display'))
    expect(await save({ defaultName: 'a.excalidraw', content: SCENE })).toEqual({ ok: false, error: { code: 'PICKER_FAILED', message: 'no display' } })
  })

  it('shares the one-dialog-in-flight guard with the pickers', async () => {
    let settle!: (v: Electron.OpenDialogReturnValue) => void
    showOpenDialog.mockReturnValueOnce(
      new Promise<Electron.OpenDialogReturnValue>((r) => {
        settle = r
      }),
    )
    const first = pick()
    expect(await save({ defaultName: 'a.excalidraw', content: SCENE })).toEqual({ ok: true, value: { cancelled: true } })
    expect(showSaveDialog).not.toHaveBeenCalled()
    settle({ canceled: true, filePaths: [] })
    await first
  })
})

/**
 * A draw.io diagram's Export Image… (🔒 YAZ-1802 D9): the same one-door rule, a PNG / SVG sheet, and
 * the picked extension decides which of the two pictures lands.
 */
describe('dialog:save-image', () => {
  let dir = ''
  const made: string[] = []
  const destination = async (name: string) => {
    if (dir === '') {
      dir = await mkdtemp(path.join(tmpdir(), 'yd-image-'))
      made.push(dir)
    }
    return path.join(dir, name)
  }
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true })
  })

  const save = (body: unknown) => registered(CONTRACT.dialog.saveImage.channel)({ sender }, body)
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"/>'
  const PICTURES = { defaultName: 'Flow.png', png: `data:image/png;base64,${PNG_BYTES.toString('base64')}`, svg: `data:image/svg+xml;base64,${Buffer.from(SVG_TEXT).toString('base64')}` }

  it('opens a PNG / SVG sheet on the diagram`s own name and writes the PNG`s bytes for a .png', async () => {
    const win = { id: 'w' } as unknown as BrowserWindow
    fromWebContents.mockReturnValue(win)
    const target = await destination('Flow.png')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await save(PICTURES)).toEqual({ ok: true, value: { path: target } })
    expect(await readFile(target)).toEqual(PNG_BYTES)
    expect(showSaveDialog).toHaveBeenCalledWith(win, {
      title: 'Export Image',
      filters: [
        { name: 'PNG image', extensions: ['png'] },
        { name: 'SVG image', extensions: ['svg'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
      defaultPath: 'Flow.png',
    })
  })

  it('writes the SVG for a .svg, whatever the case of the extension', async () => {
    const target = await destination('Flow.SVG')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: target })
    expect(await save(PICTURES)).toEqual({ ok: true, value: { path: target } })
    expect(await readFile(target, 'utf8')).toBe(SVG_TEXT)
  })

  it('refuses any other extension, and a dismissed sheet writes NOTHING', async () => {
    const target = await destination('Flow.jpg')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    expect(await save(PICTURES)).toEqual({ ok: false, error: { code: 'UNSUPPORTED_EXTENSION', message: 'an image exports as .png or .svg', path: target } })
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await save(PICTURES)).toEqual({ ok: true, value: { cancelled: true } })
  })

  it('a request without both pictures as data URLs never reaches a sheet', async () => {
    for (const body of [undefined, { ...PICTURES, defaultName: '' }, { ...PICTURES, png: '' }, { ...PICTURES, png: PICTURES.svg }, { ...PICTURES, svg: 'data:text/html;base64,AA' }]) {
      const answer = (await save(body)) as { ok: false; error: { code: string } }
      expect(answer.ok).toBe(false)
      expect(answer.error.code).toBe('BAD_REQUEST')
    }
    expect(showSaveDialog).not.toHaveBeenCalled()
  })
})
