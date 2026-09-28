import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DrawingLoadResponse } from '@shared/types'
import { referencedFileIds, unpersistedFiles } from '@shared/drawingAssets'
import { loadDrawing, saveDrawing } from './drawing'

/**
 * 🔒 YAZ-2073 D7 — a LEGACY board (images embedded as base64) opened with the lean load: open, edit,
 * save. The load now sends the scene without its embedded bytes (they travel once, in `files`), so
 * this pins that the save the renderer makes from it lands every picture in `assets/`, writes the
 * scene lean, and leaves the vault byte-for-byte as the same save did when the load still sent the
 * bytes inside `json`. The renderer half is modelled on `DrawingEditor`: the engine's serializer
 * writes `files: {}`, and `unpersistedFiles` ships every live picture the store does not hold.
 */

const b64 = (s: string) => Buffer.from(s).toString('base64')
const PICS = { p1: b64('first picture'), p2: b64('second picture'), unused: b64('embedded, named by nothing') }
const LEGACY = JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [
    { id: 'i1', type: 'image', fileId: 'p1', x: 0, y: 0, width: 10, height: 10 },
    { id: 'i2', type: 'image', fileId: 'p2', x: 20, y: 0, width: 10, height: 10 },
    { id: 'i3', type: 'image', fileId: 'p1', x: 40, y: 0, width: 10, height: 10 },
  ],
  appState: { viewBackgroundColor: '#fdf6e3', gridSize: null },
  files: {
    p1: { mimeType: 'image/png', id: 'p1', dataURL: `data:image/png;base64,${PICS.p1}`, created: 1 },
    p2: { mimeType: 'image/jpeg', id: 'p2', dataURL: `data:image/jpeg;base64,${PICS.p2}`, created: 1 },
    unused: { mimeType: 'image/png', id: 'unused', dataURL: `data:image/png;base64,${PICS.unused}`, created: 1 },
  },
})
const OPENED_AT = new Date('2026-09-01T10:00:00Z')

let work: string
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'yd-legacy-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(work, { recursive: true, force: true })
})

async function vaultWithLegacyBoard(name: string): Promise<string> {
  const root = path.join(work, name)
  await mkdir(root, { recursive: true })
  const file = path.join(root, 'Legacy.excalidraw')
  await writeFile(file, LEGACY)
  await utimes(file, OPENED_AT, OPENED_AT)
  return root
}

/** The renderer's open → edit → save, from what it parses as the scene (`sceneText`) and the load's pictures. */
async function editAndSave(root: string, opened: DrawingLoadResponse, sceneText: string) {
  const parsed = JSON.parse(sceneText) as { elements: unknown[]; appState: Record<string, unknown> }
  const elements = [...parsed.elements, { id: 'r1', type: 'rectangle', x: 0, y: 30, width: 50, height: 20 }]
  const json = `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw', elements, appState: parsed.appState, files: {} }, null, 2)}\n`
  const newFiles = unpersistedFiles(opened.files, referencedFileIds(elements), new Set(opened.stored))
  return saveDrawing({ root, path: 'Legacy.excalidraw', json, expectedMtime: opened.mtime, newFiles })
}

async function vaultBytes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { scene: await readFile(path.join(root, 'Legacy.excalidraw'), 'utf8') }
  for (const name of await readdir(path.join(root, 'assets'))) out[name] = (await readFile(path.join(root, 'assets', name))).toString('base64')
  return out
}

describe('YAZ-2073 D7 — legacy board: open, edit, save with the lean load', () => {
  it('lands every embedded picture in assets/, writes the scene lean, and leaves the vault exactly as before D7', async () => {
    const lean = await vaultWithLegacyBoard('lean')
    const opened = await loadDrawing({ root: lean, path: 'Legacy.excalidraw' })
    expect(opened.json).not.toContain(PICS.p1)
    expect(opened.stored).toEqual([])
    const saved = await editAndSave(lean, opened, opened.json)
    expect(saved.persisted.sort()).toEqual(['p1', 'p2'])

    // Every picture the scene still names is in the store, bytes intact; the unused one is not.
    expect((await readdir(path.join(lean, 'assets'))).sort()).toEqual(['p1.png', 'p2.jpg'])
    expect((await readFile(path.join(lean, 'assets', 'p1.png'))).toString()).toBe('first picture')
    expect((await readFile(path.join(lean, 'assets', 'p2.jpg'))).toString()).toBe('second picture')
    const onDisk = JSON.parse(await readFile(path.join(lean, 'Legacy.excalidraw'), 'utf8')) as { files: unknown; elements: { id: string }[] }
    expect(onDisk.files).toEqual({})
    expect(onDisk.elements.map((e) => e.id)).toEqual(['i1', 'i2', 'i3', 'r1'])

    // The same round trip when the load still answered the file's own text, embedded bytes and all.
    const before = await vaultWithLegacyBoard('before')
    const openedBefore = await loadDrawing({ root: before, path: 'Legacy.excalidraw' })
    await editAndSave(before, openedBefore, await readFile(path.join(before, 'Legacy.excalidraw'), 'utf8'))
    expect(await vaultBytes(lean)).toEqual(await vaultBytes(before))

    // And it reopens with its pictures, from the store now.
    const reopened = await loadDrawing({ root: lean, path: 'Legacy.excalidraw' })
    expect(reopened.stored).toEqual(['p1', 'p2'])
    expect(reopened.files.p1.dataURL).toBe(`data:image/png;base64,${PICS.p1}`)
  })

  it('opening alone writes nothing: the file keeps its bytes and mtime, and no assets/ appears', async () => {
    const root = await vaultWithLegacyBoard('open-only')
    await loadDrawing({ root, path: 'Legacy.excalidraw' })
    expect(await readFile(path.join(root, 'Legacy.excalidraw'), 'utf8')).toBe(LEGACY)
    expect((await stat(path.join(root, 'Legacy.excalidraw'))).mtimeMs).toBe(OPENED_AT.getTime())
    expect(await readdir(root)).toEqual(['Legacy.excalidraw'])
  })
})
