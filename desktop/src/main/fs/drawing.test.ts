import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_DRAWING_BYTES } from '@shared/types'
import { BOARD_META_KEY, ORPHAN_MAX_AGE_MS } from '@shared/drawingAssets'
import { sweepOrphanAssets } from '../drawings/orphanSweep'
import { loadDrawing, saveDrawing } from './drawing'
import { blockOf, failure, withoutBlock } from './testFixture'

// Pass-through: the durability test watches which files get fsynced (YAZ-2073 D12).
vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>()
  return { ...m, open: vi.fn(m.open) }
})

const PNG_B64 = 'aGVsbG8='
const dataUrl = (b64 = PNG_B64) => `data:image/png;base64,${b64}`
const imageEl = (fileId: string, over: Record<string, unknown> = {}) => ({ id: `el-${fileId}`, type: 'image', fileId, ...over })

/** Puts `<root>/assets/<name>` on disk, optionally aged into the past. */
async function seedAsset(name: string, body = 'hello', ageMs = 0): Promise<string> {
  const file = path.join(root, 'assets', name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs)
    await utimes(file, when, when)
  }
  return file
}

let root: string

/** The smallest thing that is a scene: an object with an `elements` array. */
function scene(elements: unknown[] = [], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw', elements, appState: {}, files: {}, ...extra }, null, 2)}\n`
}

async function seed(rel: string, body: string): Promise<string> {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
  return file
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'draw-doc-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('drawing:load', () => {
  it('answers the bytes, the mtime a save guards on, and no images for a scene that names none', async () => {
    const body = scene([{ id: 'a', type: 'rectangle' }])
    const file = await seed('Board.excalidraw', body)
    const st = await stat(file)
    await expect(loadDrawing({ root, path: 'Board.excalidraw' })).resolves.toEqual({
      path: file,
      json: body,
      mtime: st.mtimeMs,
      size: st.size,
      files: {},
      stored: [],
    })
  })

  it('takes an absolute path under the root as readily as a relative one', async () => {
    const file = await seed('Nested/Deep.excalidraw', scene())
    await expect(loadDrawing({ root, path: file })).resolves.toMatchObject({ path: file })
  })

  it('refuses a path that escapes the vault, a non-drawing extension, and a missing `path`', async () => {
    expect((await failure(loadDrawing({ root, path: '../outside.excalidraw' }))).code).toBe('BAD_REQUEST')
    expect((await failure(loadDrawing({ root, path: 'notes.txt' }))).code).toBe('UNSUPPORTED_EXTENSION')
    expect((await failure(loadDrawing({ root, path: '  ' } as never))).code).toBe('BAD_REQUEST')
    expect((await failure(loadDrawing({ root: 'relative', path: 'a.excalidraw' }))).code).toBe('NOT_ABSOLUTE')
  })

  it('reports a missing file as NOT_FOUND', async () => {
    expect((await failure(loadDrawing({ root, path: 'gone.excalidraw' }))).code).toBe('NOT_FOUND')
  })

  it('reports an EMPTY and a CORRUPT file as one readable IO_ERROR naming the path (YAZ-1810 acceptance)', async () => {
    const empty = await seed('Empty.excalidraw', '')
    const corrupt = await seed('Corrupt.excalidraw', '{ not json')
    const noElements = await seed('NoElements.excalidraw', '{"type":"excalidraw"}')
    const array = await seed('Array.excalidraw', '[1,2,3]')
    for (const file of [empty, corrupt, noElements, array]) {
      const err = await failure(loadDrawing({ root, path: file }))
      expect(err.code, file).toBe('IO_ERROR')
      expect(err.message).toBe('file is not an Excalidraw scene')
      expect(err.path).toBe(file)
    }
  })

  it('reads a legacy embedded scene well past MAX_FILE_BYTES (the 200 MiB ceiling is for exactly this)', async () => {
    // 12 MiB of base64 payload — over the 10 MiB text cap, nowhere near the drawing cap.
    const dataURL = `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`
    const file = await seed('Legacy.excalidraw', scene([{ type: 'image', fileId: 'abc' }], { files: { abc: { mimeType: 'image/png', dataURL } } }))
    const res = await loadDrawing({ root, path: file })
    expect(res.size).toBeGreaterThan(10 * 1024 * 1024)
    expect(res.size).toBeLessThan(MAX_DRAWING_BYTES)
  })
})

describe('drawing:save', () => {
  it('writes the scene atomically and answers the new mtime and size', async () => {
    const file = await seed('Board.excalidraw', scene())
    const before = await stat(file)
    const body = scene([{ id: 'a', type: 'ellipse' }])
    const res = await saveDrawing({ root, path: 'Board.excalidraw', json: body, newFiles: [] })
    expect(res.path).toBe(file)
    expect(res.persisted).toEqual([])
    const written = await readFile(file, 'utf8')
    expect(withoutBlock(written)).toBe(body)
    expect(blockOf(written)).toMatchObject({ createdAt: expect.any(Number), updatedAt: expect.any(Number) })
    expect(res.mtime).not.toBe(before.mtimeMs)
    expect(res.size).toBe(Buffer.byteLength(written, 'utf8'))
    // No stray tmp file survives the rename.
    expect(await readdir(root)).toEqual(['Board.excalidraw'])
    await expect(loadDrawing({ root, path: 'Board.excalidraw' })).resolves.toMatchObject({ json: written })
  })

  it('creates a document that is not there yet (a rename raced the save; the canvas is the only copy)', async () => {
    const body = scene()
    const res = await saveDrawing({ root, path: 'Fresh.excalidraw', json: body, expectedMtime: 123, newFiles: [] })
    const written = await readFile(res.path, 'utf8')
    expect(withoutBlock(written)).toBe(body)
    // Born on this save: no prior file, so both dates are the save itself.
    const block = blockOf(written)
    expect(block.createdAt).toBe(block.updatedAt)
  })

  it('rejects a stale expectedMtime as CONFLICT carrying the disk mtime, and writes NOTHING', async () => {
    const original = scene()
    const file = await seed('Board.excalidraw', original)
    const st = await stat(file)
    const err = await failure(saveDrawing({ root, path: file, json: scene([{ id: 'b' }]), expectedMtime: st.mtimeMs - 1000, newFiles: [] }))
    expect(err.code).toBe('CONFLICT')
    expect(err.mtime).toBe(st.mtimeMs)
    expect(err.path).toBe(file)
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('accepts a matching expectedMtime', async () => {
    const file = await seed('Board.excalidraw', scene())
    const st = await stat(file)
    await expect(saveDrawing({ root, path: file, json: scene([{ id: 'c' }]), expectedMtime: st.mtimeMs, newFiles: [] })).resolves.toMatchObject({ path: file })
  })

  it('refuses a malformed request before touching the file', async () => {
    const original = scene()
    const file = await seed('Board.excalidraw', original)
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ root, path: file, json: 42, newFiles: [] }, 'BAD_REQUEST'],
      [{ root, path: file, json: scene(), newFiles: 'nope' }, 'BAD_REQUEST'],
      [{ root, path: file, json: scene(), expectedMtime: 'soon', newFiles: [] }, 'BAD_REQUEST'],
      [{ root, path: file, json: '{ not json', newFiles: [] }, 'BAD_REQUEST'],
      [{ root, path: '../escape.excalidraw', json: scene(), newFiles: [] }, 'BAD_REQUEST'],
      [{ root, path: 'notes.txt', json: scene(), newFiles: [] }, 'UNSUPPORTED_EXTENSION'],
    ]
    for (const [req, code] of bad) {
      expect((await failure(saveDrawing(req as never))).code, JSON.stringify(req.path)).toBe(code)
    }
    expect(await readFile(file, 'utf8')).toBe(original)
  })

  it('round-trips: load, edit, save, load again', async () => {
    await seed('Board.excalidraw', scene())
    const first = await loadDrawing({ root, path: 'Board.excalidraw' })
    const edited = scene([{ id: 'x', type: 'rectangle' }])
    const saved = await saveDrawing({ root, path: 'Board.excalidraw', json: edited, expectedMtime: first.mtime, newFiles: [] })
    const second = await loadDrawing({ root, path: 'Board.excalidraw' })
    expect(withoutBlock(second.json)).toBe(edited)
    expect(second.mtime).toBe(saved.mtime)
  })
})


describe('🔒 YAZ-1775 D3 — the image store on load', () => {
  it('hydrates a referenced id from assets/ and reports it as STORED', async () => {
    await seedAsset('abc.png')
    await seed('Board.excalidraw', scene([imageEl('abc')]))
    const res = await loadDrawing({ root, path: 'Board.excalidraw' })
    expect(res.files).toEqual({ abc: { mimeType: 'image/png', dataURL: dataUrl() } })
    expect(res.stored).toEqual(['abc'])
  })

  it('leaves a MISSING asset out entirely — the placeholder, never a failed open', async () => {
    await seed('Board.excalidraw', scene([imageEl('gone')]))
    const res = await loadDrawing({ root, path: 'Board.excalidraw' })
    expect(res.files).toEqual({})
    expect(res.stored).toEqual([])
    expect(res.json).toContain('gone') // the scene is untouched; only the bytes are absent
  })

  it('falls back to a LEGACY scene`s own embedded bytes, and does NOT call them stored', async () => {
    await seed('Legacy.excalidraw', scene([imageEl('emb')], { files: { emb: { mimeType: 'image/png', dataURL: dataUrl() } } }))
    const res = await loadDrawing({ root, path: 'Legacy.excalidraw' })
    expect(res.files.emb).toEqual({ mimeType: 'image/png', dataURL: dataUrl() })
    expect(res.stored).toEqual([])
  })

  it('prefers the store over an embedded copy of the same id', async () => {
    await seedAsset('dup.png', 'from-the-store')
    await seed('Board.excalidraw', scene([imageEl('dup')], { files: { dup: { mimeType: 'image/png', dataURL: dataUrl('ZW1iZWRkZWQ=') } } }))
    const res = await loadDrawing({ root, path: 'Board.excalidraw' })
    expect(Buffer.from(res.files.dup.dataURL.split(',')[1], 'base64').toString()).toBe('from-the-store')
    expect(res.stored).toEqual(['dup'])
  })

  it('hydrates nothing for a DELETED image element — an undo brings the id back, the sweep`s age guard keeps the bytes', async () => {
    await seedAsset('ghost.png')
    await seed('Board.excalidraw', scene([imageEl('ghost', { isDeleted: true })]))
    expect((await loadDrawing({ root, path: 'Board.excalidraw' })).files).toEqual({})
  })

  it('ignores a foreign file in assets/ and reads `jpeg` as well as `jpg`', async () => {
    await seedAsset('notes.txt', 'nope')
    await seedAsset('photo.jpeg', 'jj')
    await seed('Board.excalidraw', scene([imageEl('photo'), imageEl('notes')]))
    const res = await loadDrawing({ root, path: 'Board.excalidraw' })
    expect(res.stored).toEqual(['photo'])
    expect(res.files.photo.mimeType).toBe('image/jpeg')
  })
})

describe('🔒 YAZ-1775 D3 — the image store on save', () => {
  it('writes the assets BEFORE the scene, names them `<id>.<ext>`, and reports them persisted', async () => {
    await seed('Board.excalidraw', scene())
    const res = await saveDrawing({
      root,
      path: 'Board.excalidraw',
      json: scene([imageEl('newid')]),
      newFiles: [{ fileId: 'newid', mimeType: 'image/png', dataURL: dataUrl() }],
    })
    expect(res.persisted).toEqual(['newid'])
    expect(await readFile(path.join(root, 'assets', 'newid.png'), 'utf8')).toBe('hello')
    // The scene on disk names the id and carries no bytes.
    const saved = JSON.parse(await readFile(res.path, 'utf8')) as { files: unknown }
    expect(saved.files).toEqual({})
  })

  it('fsyncs each new asset and the scene before the save answers (YAZ-2073 D12)', async () => {
    const synced: string[] = []
    const { open: realOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(open).mockImplementation(async (...args) => {
      const fh = await realOpen(...args)
      const sync = fh.sync.bind(fh)
      fh.sync = () => (synced.push(path.basename(String(args[0])).replace(/\.tmp-.*/, '.tmp')), sync())
      return fh
    })
    try {
      await seed('Board.excalidraw', scene())
      await saveDrawing({ root, path: 'Board.excalidraw', json: scene([imageEl('newid')]), newFiles: [{ fileId: 'newid', mimeType: 'image/png', dataURL: dataUrl() }] })
      expect(synced).toEqual(['newid.png', 'Board.excalidraw.tmp'])
    } finally {
      vi.mocked(open).mockRestore()
    }
  })

  it('never rewrites an asset that is already there — content-addressed means it IS those bytes', async () => {
    const asset = await seedAsset('same.png', 'original')
    const before = (await stat(asset)).mtimeMs
    await seed('Board.excalidraw', scene())
    const res = await saveDrawing({ root, path: 'Board.excalidraw', json: scene([imageEl('same')]), newFiles: [{ fileId: 'same', mimeType: 'image/png', dataURL: dataUrl('ZGlmZmVyZW50') }] })
    expect(res.persisted).toEqual(['same'])
    expect(await readFile(asset, 'utf8')).toBe('original')
    expect((await stat(asset)).mtimeMs).toBe(before)
  })

  it('EXTRACTS a legacy embedded scene on its first save: bytes into assets/, JSON shrunk', async () => {
    const legacy = scene([imageEl('emb')], { files: { emb: { mimeType: 'image/png', dataURL: dataUrl() } } })
    await seed('Legacy.excalidraw', legacy)
    const before = (await stat(path.join(root, 'Legacy.excalidraw'))).size
    const res = await saveDrawing({ root, path: 'Legacy.excalidraw', json: legacy, newFiles: [] })
    expect(res.persisted).toEqual(['emb'])
    expect(await readFile(path.join(root, 'assets', 'emb.png'), 'utf8')).toBe('hello')
    expect(res.size).toBeLessThan(before)
    expect((JSON.parse(await readFile(res.path, 'utf8')) as { files: unknown }).files).toEqual({})
    // …and the document still opens with its picture, now from the store.
    expect((await loadDrawing({ root, path: 'Legacy.excalidraw' })).stored).toEqual(['emb'])
  })

  it('does not extract an embedded entry the scene no longer references', async () => {
    const legacy = scene([], { files: { orphan: { mimeType: 'image/png', dataURL: dataUrl() } } })
    await seed('Legacy.excalidraw', legacy)
    const res = await saveDrawing({ root, path: 'Legacy.excalidraw', json: legacy, newFiles: [] })
    expect(res.persisted).toEqual([])
    expect(await readdir(path.join(root, 'assets')).catch(() => null)).toBeNull()
  })

  it('leaves an already-lean scene byte-identical BELOW the block: an untouched save moves only `updatedAt` (🔒 YAZ-1834 D3)', async () => {
    const lean = scene([{ id: 'a' }])
    await seed('Board.excalidraw', lean)
    await saveDrawing({ root, path: 'Board.excalidraw', json: lean, newFiles: [] })
    const once = await readFile(path.join(root, 'Board.excalidraw'), 'utf8')
    expect(withoutBlock(once)).toBe(lean)
    await new Promise((r) => setTimeout(r, 5))
    await saveDrawing({ root, path: 'Board.excalidraw', json: lean, newFiles: [] })
    const twice = await readFile(path.join(root, 'Board.excalidraw'), 'utf8')
    expect(withoutBlock(twice)).toBe(lean)
    expect(blockOf(twice).createdAt).toBe(blockOf(once).createdAt)
    expect(blockOf(twice).updatedAt).toBeGreaterThan(blockOf(once).updatedAt as number)
  })

  it('refuses a malformed newFiles entry and writes NOTHING — not the assets, not the scene', async () => {
    const original = scene()
    await seed('Board.excalidraw', original)
    const bad: unknown[] = [
      { fileId: '../escape', mimeType: 'image/png', dataURL: dataUrl() },
      { fileId: 'a/b', mimeType: 'image/png', dataURL: dataUrl() },
      { fileId: 'ok', mimeType: 'image/bmp', dataURL: 'data:image/bmp;base64,aGk=' },
      { fileId: 'ok', mimeType: 'image/png', dataURL: 'https://example.com/a.png' },
      { fileId: 'ok', mimeType: 'image/png' },
      'not an object',
    ]
    for (const entry of bad) {
      const err = await failure(saveDrawing({ root, path: 'Board.excalidraw', json: scene(), newFiles: [entry] as never }))
      expect(err.code, JSON.stringify(entry)).toBe('BAD_REQUEST')
    }
    expect(await readFile(path.join(root, 'Board.excalidraw'), 'utf8')).toBe(original)
    expect(await readdir(path.join(root, 'assets')).catch(() => null)).toBeNull()
  })

  it('a CONFLICT writes no assets either: a refused save leaves the vault exactly as it was', async () => {
    const file = await seed('Board.excalidraw', scene())
    const st = await stat(file)
    await failure(saveDrawing({ root, path: file, json: scene([imageEl('x')]), expectedMtime: st.mtimeMs - 1000, newFiles: [{ fileId: 'x', mimeType: 'image/png', dataURL: dataUrl() }] }))
    expect(await readdir(path.join(root, 'assets')).catch(() => null)).toBeNull()
  })

  it('two boards sharing one image keep ONE file', async () => {
    await seed('A.excalidraw', scene())
    await seed('B.excalidraw', scene())
    const entry = { fileId: 'shared', mimeType: 'image/png', dataURL: dataUrl() }
    await saveDrawing({ root, path: 'A.excalidraw', json: scene([imageEl('shared')]), newFiles: [entry] })
    await saveDrawing({ root, path: 'B.excalidraw', json: scene([imageEl('shared')]), newFiles: [entry] })
    expect(await readdir(path.join(root, 'assets'))).toEqual(['shared.png'])
  })
})

describe('🔒 YAZ-1834 — the yaseendraw block on save', () => {
  it('births a block on a LEGACY board: createdAt = its pre-save mtime, updatedAt = the save', async () => {
    const file = await seed('Old.excalidraw', scene())
    const born = new Date('2021-03-04T05:06:07Z')
    await utimes(file, born, born)
    const before = Date.now()
    await saveDrawing({ root, path: file, json: scene([{ id: 'a' }]), newFiles: [] })
    const after = Date.now()
    const block = blockOf(await readFile(file, 'utf8'))
    expect(block.createdAt).toBe(born.getTime())
    expect(block.updatedAt).toBeGreaterThanOrEqual(before)
    expect(block.updatedAt).toBeLessThanOrEqual(after)
  })

  it('keeps createdAt and the backfill`s own keys, bumps only updatedAt (D5) — across saves that do not send the block back', async () => {
    // As the importer writes it: the block FIRST (D1 — a block anywhere else is not read, and is replaced on save).
    const backfilled = `${JSON.stringify({ [BOARD_META_KEY]: { createdAt: 1600000000000, updatedAt: 1600000000001, cloudId: 'k7' }, type: 'excalidraw', elements: [], files: {} }, null, 2)}\n`
    const file = await seed('Cloud.excalidraw', backfilled)
    // The renderer's json never carries the block (the engine drops unknown keys): plain scenes in.
    await saveDrawing({ root, path: file, json: scene([{ id: 'a' }]), newFiles: [] })
    await saveDrawing({ root, path: file, json: scene([{ id: 'a' }, { id: 'b' }]), newFiles: [] })
    const block = blockOf(await readFile(file, 'utf8'))
    expect(block).toMatchObject({ createdAt: 1600000000000, cloudId: 'k7' })
    expect(block.updatedAt).toBeGreaterThan(1600000000001)
  })

  it('lifts a legacy embedded scene AND places the block first in the same write', async () => {
    const legacy = scene([imageEl('abc')], { files: { abc: { mimeType: 'image/png', dataURL: dataUrl() } } })
    const file = await seed('Legacy.excalidraw', legacy)
    await saveDrawing({ root, path: file, json: legacy, newFiles: [] })
    const written = await readFile(file, 'utf8')
    expect(Object.keys(JSON.parse(written) as object)[0]).toBe(BOARD_META_KEY)
    expect((JSON.parse(written) as { files: unknown }).files).toEqual({})
    expect(await readdir(path.join(root, 'assets'))).toEqual(['abc.png'])
  })

  it('a block that is NOT the first key is not trusted: the save births a fresh one from the mtime (D7 — the importer must write it first)', async () => {
    const file = await seed('Misplaced.excalidraw', scene([], { [BOARD_META_KEY]: { createdAt: 5, updatedAt: 6 } }))
    await saveDrawing({ root, path: file, json: scene(), newFiles: [] })
    expect(blockOf(await readFile(file, 'utf8')).createdAt).toBeGreaterThan(6)
  })

  it('a refused save (CONFLICT) stamps nothing — the legacy file stays block-less and byte-identical', async () => {
    const original = scene()
    const file = await seed('Board.excalidraw', original)
    await failure(saveDrawing({ root, path: file, json: scene([{ id: 'b' }]), expectedMtime: 1, newFiles: [] }))
    expect(await readFile(file, 'utf8')).toBe(original)
  })
})

/**
 * The simulated end-to-end (🔒 YAZ-1811 acceptance): a real temp vault, the real doors, no
 * Electron and no React. `shell.trashItem` is the one thing injected — a test must not move
 * files into the developer's own Trash.
 */
describe('end to end on a temp vault', () => {
  it('legacy board → load → save → assets extracted, JSON shrunk, and it reopens with its picture', async () => {
    const legacy = scene([imageEl('sha1id')], { files: { sha1id: { mimeType: 'image/png', dataURL: dataUrl() } } })
    await seed('Boards/Legacy.excalidraw', legacy)

    const opened = await loadDrawing({ root, path: 'Boards/Legacy.excalidraw' })
    expect(opened.stored).toEqual([]) // nothing in the store yet; the bytes came from the file
    expect(opened.files.sha1id.dataURL).toBe(dataUrl())

    // The renderer would send the file it holds and no longer has on disk.
    const saved = await saveDrawing({ root, path: 'Boards/Legacy.excalidraw', json: opened.json, expectedMtime: opened.mtime, newFiles: [] })
    expect(saved.persisted).toEqual(['sha1id'])
    expect(saved.size).toBeLessThan(opened.size)
    expect(await readdir(path.join(root, 'assets'))).toEqual(['sha1id.png'])

    const reopened = await loadDrawing({ root, path: 'Boards/Legacy.excalidraw' })
    expect(reopened.stored).toEqual(['sha1id'])
    expect(reopened.files.sha1id.dataURL).toBe(dataUrl())
  })

  it('the conflict path: a second writer wins, the first is refused, nothing of its save lands', async () => {
    const file = await seed('Board.excalidraw', scene())
    const first = await loadDrawing({ root, path: file })
    // Somebody else (another window, or git) writes the file.
    await new Promise((r) => setTimeout(r, 10))
    await writeFile(file, scene([{ id: 'theirs' }]))
    const err = await failure(saveDrawing({ root, path: file, json: scene([imageEl('mine')]), expectedMtime: first.mtime, newFiles: [{ fileId: 'mine', mimeType: 'image/png', dataURL: dataUrl() }] }))
    expect(err.code).toBe('CONFLICT')
    expect(JSON.parse(await readFile(file, 'utf8')).elements).toEqual([{ id: 'theirs' }])
    expect(await readdir(path.join(root, 'assets')).catch(() => null)).toBeNull()
    // Keep mine: the guard the CONFLICT reported lets the write through.
    await saveDrawing({ root, path: file, json: scene([imageEl('mine')]), expectedMtime: err.mtime, newFiles: [{ fileId: 'mine', mimeType: 'image/png', dataURL: dataUrl() }] })
    expect(await readdir(path.join(root, 'assets'))).toEqual(['mine.png'])
  })

  it('the sweep trashes a 3-day-old orphan, keeps a fresh one, and keeps one a NESTED board still uses', async () => {
    await seedAsset('orphan.png', 'old', 3 * 24 * 60 * 60 * 1000)
    await seedAsset('fresh.png', 'new')
    await seedAsset('nested.png', 'held', 3 * 24 * 60 * 60 * 1000)
    await seedAsset('deleted.png', 'held-by-age', 3 * 24 * 60 * 60 * 1000)
    await seed('Deep/Folders/Board.excalidraw', scene([imageEl('nested')]))
    await seed('Deep/Folders/Undo.excalidraw', scene([imageEl('deleted', { isDeleted: true })]))

    const trashed: string[] = []
    const swept = await sweepOrphanAssets(root, { now: Date.now, trash: async (p) => void trashed.push(path.basename(p)) })
    // `deleted.png` is unreferenced but its element is only soft-deleted — it goes too, once old.
    expect(trashed.sort()).toEqual(['deleted.png', 'orphan.png'])
    expect(swept).toBe(2)
    expect((await readdir(path.join(root, 'assets'))).sort()).toEqual(['deleted.png', 'fresh.png', 'nested.png', 'orphan.png'])
  })

  it('the sweep never eats the picture behind an UNSAVED paste', async () => {
    // The paste landed in the store a minute ago; the board naming it has not been saved.
    await seedAsset('justpasted.png', 'bytes', 60_000)
    await seed('Board.excalidraw', scene())
    const trashed: string[] = []
    expect(await sweepOrphanAssets(root, { now: Date.now, trash: async (p) => void trashed.push(p) })).toBe(0)
    expect(trashed).toEqual([])
  })

  it('a CORRUPT board is skipped, not fatal — and its age-guarded images survive until it is fixed', async () => {
    await seedAsset('used.png', 'x', ORPHAN_MAX_AGE_MS + 1000)
    await seed('Broken.excalidraw', '{ not json')
    await seed('Empty.excalidraw', '')
    await seed('Good.excalidraw', scene([imageEl('used')]))
    const trashed: string[] = []
    expect(await sweepOrphanAssets(root, { now: Date.now, trash: async (p) => void trashed.push(p) })).toBe(0)
    expect(trashed).toEqual([])
  })
})
