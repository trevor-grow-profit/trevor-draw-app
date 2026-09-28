/**
 * The diagram document's IPC (🔒 YAZ-1802 D6): exactly two doors, each answering in the standard
 * envelope — the value on success, a plain `BridgeError` (code, message, path, mtime) on every
 * refusal, because Electron would strip those fields from a thrown Error. `fs/diagram.test.ts`
 * covers the rules themselves; this pins what the renderer receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { registerDiagramIpc } from './diagram'
import { registered } from './ipcFixture'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const XML = '<mxfile><diagram id="p" name="Page-1"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>\n'

let root: string
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  root = await mkdtemp(path.join(tmpdir(), 'draw-diagram-ipc-'))
  registerDiagramIpc()
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('diagram IPC', () => {
  it('answers diagram:load with the file in the envelope', async () => {
    const file = path.join(root, 'Flow.drawio')
    await writeFile(file, XML)
    expect(await registered(CONTRACT.diagram.load)({}, { root, path: 'Flow.drawio' })).toEqual({ ok: true, value: { path: file, xml: XML, mtime: (await stat(file)).mtimeMs, size: Buffer.byteLength(XML) } })
  })

  it('answers diagram:save with the new mtime and writes the stamped diagram', async () => {
    const file = path.join(root, 'Flow.drawio')
    const res = (await registered(CONTRACT.diagram.save)({}, { root, path: 'Flow.drawio', xml: XML })) as Envelope<{ path: string; mtime: number }>
    expect(res).toMatchObject({ ok: true, value: { path: file, mtime: (await stat(file)).mtimeMs } })
    expect(await readFile(file, 'utf8')).toContain('<diagram id="p"')
  })

  it.each([
    ['a request that is not an object', CONTRACT.diagram.load.channel, () => 'Flow.drawio', 'BAD_REQUEST'],
    ['a relative root', CONTRACT.diagram.load.channel, () => ({ root: 'vault', path: 'Flow.drawio' }), 'NOT_ABSOLUTE'],
    ['a path that escapes the vault', CONTRACT.diagram.load.channel, () => ({ root, path: '../Flow.drawio' }), 'BAD_REQUEST'],
    ['a board that is not a diagram', CONTRACT.diagram.load.channel, () => ({ root, path: 'Board.excalidraw' }), 'UNSUPPORTED_EXTENSION'],
    ['a save without xml', CONTRACT.diagram.save.channel, () => ({ root, path: 'Flow.drawio' }), 'BAD_REQUEST'],
    ['a save of something that is not a diagram', CONTRACT.diagram.save.channel, () => ({ root, path: 'Flow.drawio', xml: '<html/>' }), 'BAD_REQUEST'],
  ])('refuses %s in the envelope, never by throwing', async (_what, channel, req, code) => {
    const res = await registered({ channel })({}, req())
    expect(res).toMatchObject({ ok: false, error: { code, message: expect.any(String) } })
  })

  it('reports a file that is not a draw.io document as a readable IO_ERROR with its path', async () => {
    const file = path.join(root, 'Broken.drawio')
    await writeFile(file, 'not xml at all')
    expect(await registered(CONTRACT.diagram.load)({}, { root, path: 'Broken.drawio' })).toMatchObject({ ok: false, error: { code: 'IO_ERROR', path: file } })
  })

  it('carries the disk mtime on a CONFLICT so the editor can offer Reload / Keep mine', async () => {
    const file = path.join(root, 'Flow.drawio')
    await writeFile(file, XML)
    const res = await registered(CONTRACT.diagram.save)({}, { root, path: 'Flow.drawio', xml: XML, expectedMtime: 1 })
    expect(res).toEqual({ ok: false, error: { code: 'CONFLICT', message: expect.any(String), path: file, mtime: (await stat(file)).mtimeMs } })
  })
})
