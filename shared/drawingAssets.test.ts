import { describe, expect, it } from 'vitest'
import {
  ASSETS_DIR,
  BOARD_META_HEAD_BYTES,
  BOARD_META_KEY,
  ORPHAN_MAX_AGE_MS,
  assetFileName,
  extForMime,
  fileIdOfAssetName,
  isValidFileId,
  mimeForAssetExt,
  parseDataUrl,
  planOrphanSweep,
  parseBoardMetaBlock,
  referencedFileIds,
  stampBoardMeta,
  stripEmbeddedFiles,
  unpersistedFiles,
  type AssetListingEntry,
  type DrawingFileData,
} from './drawingAssets'

const png = (payload = 'aGk='): DrawingFileData => ({ mimeType: 'image/png', dataURL: `data:image/png;base64,${payload}` })

describe('names and mimes', () => {
  it('maps every mime the store keeps, and nothing else', () => {
    expect(extForMime('image/png')).toBe('png')
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('image/svg+xml')).toBe('svg')
    expect(extForMime('image/avif')).toBe('avif')
    expect(extForMime('image/bmp')).toBeNull()
    expect(extForMime('application/json')).toBeNull()
  })

  it('reads back every extension it writes — and `jpeg`, which it never writes but files carry', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp', 'image/avif']) {
      expect(mimeForAssetExt(extForMime(mime)!), mime).toBe(mime)
    }
    expect(mimeForAssetExt('jpeg')).toBe('image/jpeg')
    expect(mimeForAssetExt('PNG')).toBe('image/png') // a file from another OS may shout
    expect(mimeForAssetExt('excalidraw')).toBeNull()
    expect(mimeForAssetExt('txt')).toBeNull()
  })

  it('names a file `<id>.<ext>` and refuses a mime it cannot store', () => {
    expect(assetFileName('abc123', 'image/png')).toBe('abc123.png')
    expect(assetFileName('abc123', 'image/bmp')).toBeNull()
  })

  it('reads the id back out of a name, and refuses dot-entries and empty stems', () => {
    expect(fileIdOfAssetName('abc123.png')).toBe('abc123')
    expect(fileIdOfAssetName('abc.123.png')).toBe('abc.123')
    expect(fileIdOfAssetName('noext')).toBe('noext')
    expect(fileIdOfAssetName('.DS_Store')).toBeNull()
    expect(fileIdOfAssetName('.png')).toBeNull()
  })

  it('lives under the vault-root folder the tree hides', () => {
    expect(ASSETS_DIR).toBe('assets')
  })
})

describe('isValidFileId — this id becomes a path segment', () => {
  it('takes the engine`s own hex ids and the wider plain-token shape', () => {
    expect(isValidFileId('3a7b9f0e1c2d')).toBe(true)
    expect(isValidFileId('A-Z_az09')).toBe(true)
    expect(isValidFileId('a'.repeat(128))).toBe(true)
  })

  it('refuses anything that could leave the folder, forge an extension, or not be a string', () => {
    for (const bad of ['', '..', '../escape', 'a/b', 'a\\b', 'a.png', 'a b', 'a\0b', 'a'.repeat(129), null, undefined, 7, {}, ['a']]) {
      expect(isValidFileId(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('referencedFileIds', () => {
  it('collects live image elements only — a DELETED one keeps its id for undo but not its bytes', () => {
    const ids = referencedFileIds([
      { type: 'image', fileId: 'live' },
      { type: 'image', fileId: 'gone', isDeleted: true },
      { type: 'image', fileId: 'live' }, // the same picture twice
      { type: 'rectangle', fileId: 'notanimage' },
      { type: 'image', fileId: '' },
      { type: 'image' },
      null,
      'nonsense',
    ])
    expect([...ids]).toEqual(['live'])
  })

  it('answers an empty set for an empty scene', () => {
    expect(referencedFileIds([]).size).toBe(0)
  })
})

describe('parseDataUrl', () => {
  it('splits a base64 data URL into its mime and payload', () => {
    expect(parseDataUrl('data:image/png;base64,aGk=')).toEqual({ mimeType: 'image/png', base64: 'aGk=' })
    expect(parseDataUrl('data:image/svg+xml;base64,')).toEqual({ mimeType: 'image/svg+xml', base64: '' })
  })

  it('refuses anything that is not base64 BYTES — a remote URL most of all', () => {
    for (const bad of ['https://example.com/a.png', 'data:image/png,raw', 'data:image/png;base64,<script>', 'not a url', '']) {
      expect(parseDataUrl(bad), bad).toBeNull()
    }
  })
})

describe('stripEmbeddedFiles', () => {
  const legacy = JSON.stringify({ type: 'excalidraw', elements: [{ type: 'image', fileId: 'a' }], files: { a: png(), bad: { mimeType: 'image/png', dataURL: 'https://cdn/x.png' }, worse: 7 } })

  it('lifts the usable entries out and writes the scene with an empty files map', () => {
    const { json, embedded } = stripEmbeddedFiles(legacy)
    expect(Object.keys(embedded)).toEqual(['a'])
    expect(embedded.a).toEqual(png())
    const parsed = JSON.parse(json) as { files: unknown; elements: unknown[] }
    expect(parsed.files).toEqual({})
    // The drawing itself is untouched — only its baggage moved.
    expect(parsed.elements).toEqual([{ type: 'image', fileId: 'a' }])
    expect(json.endsWith('\n')).toBe(true)
  })

  it('is BYTE-STABLE on a scene that is already lean: an untouched save must not churn the vault`s git history', () => {
    const lean = `${JSON.stringify({ type: 'excalidraw', elements: [], files: {} }, null, 2)}\n`
    const { json, embedded } = stripEmbeddedFiles(lean)
    expect(json).toBe(lean)
    expect(embedded).toEqual({})
    // …and running it again over its own output changes nothing either.
    expect(stripEmbeddedFiles(json).json).toBe(lean)
  })

  it('normalises a lean scene that is spelled differently (minified, or with no files key at all)', () => {
    const minified = '{"type":"excalidraw","elements":[]}'
    const { json, embedded } = stripEmbeddedFiles(minified)
    expect(embedded).toEqual({})
    expect(JSON.parse(json)).toEqual({ type: 'excalidraw', elements: [], files: {} })
  })

  it('is idempotent on a legacy scene: the second pass finds nothing left to lift', () => {
    const once = stripEmbeddedFiles(legacy)
    const twice = stripEmbeddedFiles(once.json)
    expect(twice.embedded).toEqual({})
    expect(twice.json).toBe(once.json)
  })

  it('throws on bytes that are not a scene object', () => {
    for (const bad of ['', '{ not json', '[1,2]', 'null', '"a string"']) {
      expect(() => stripEmbeddedFiles(bad), bad).toThrow()
    }
  })
})

describe('unpersistedFiles', () => {
  const files = { b: png('Yg=='), a: png('YQ=='), dead: png('ZA=='), old: png('bw==') }

  it('ships only what is REFERENCED and not already on disk, sorted by id', () => {
    const out = unpersistedFiles(files, new Set(['a', 'b', 'old']), new Set(['old']))
    expect(out.map((f) => f.fileId)).toEqual(['a', 'b'])
    expect(out[0]).toEqual({ fileId: 'a', ...png('YQ==') })
  })

  it('never ships a pasted-then-deleted image', () => {
    expect(unpersistedFiles(files, new Set(['a']), new Set()).map((f) => f.fileId)).toEqual(['a'])
  })

  it('ships nothing when the store already has everything', () => {
    expect(unpersistedFiles(files, new Set(['a', 'b']), new Set(['a', 'b']))).toEqual([])
  })
})

describe('planOrphanSweep', () => {
  const NOW = 1_000_000_000_000
  const old = NOW - ORPHAN_MAX_AGE_MS - 1
  const listing: AssetListingEntry[] = [
    { name: 'kept.png', mtime: old }, // referenced
    { name: 'orphan.png', mtime: old }, // unreferenced AND old
    { name: 'fresh.png', mtime: NOW - 60_000 }, // unreferenced but MINUTES old
    { name: 'notes.txt', mtime: old }, // not an asset
    { name: 'noext', mtime: old },
    { name: '.DS_Store', mtime: old },
    { name: 'subfolder', mtime: old, isDir: true },
  ]

  it('trashes only the unreferenced AND old image assets', () => {
    expect(planOrphanSweep(listing, new Set(['kept']), NOW)).toEqual(['orphan.png'])
  })

  it('never touches a file pasted minutes ago — an unsaved paste is not an orphan', () => {
    expect(planOrphanSweep([{ name: 'fresh.png', mtime: NOW }], new Set(), NOW)).toEqual([])
  })

  it('treats exactly-at-the-boundary as still fresh (the guard is strict)', () => {
    expect(planOrphanSweep([{ name: 'edge.png', mtime: NOW - ORPHAN_MAX_AGE_MS }], new Set(), NOW)).toEqual([])
    expect(planOrphanSweep([{ name: 'edge.png', mtime: NOW - ORPHAN_MAX_AGE_MS - 1 }], new Set(), NOW)).toEqual(['edge.png'])
  })

  it('leaves the user`s own files alone whatever their age: dot-entries, folders, foreign extensions', () => {
    expect(planOrphanSweep(listing, new Set(), NOW).sort()).toEqual(['kept.png', 'orphan.png'])
  })

  it("sweeps the tmp file a crashed write left behind once it is past the age guard, even under a referenced asset's name", () => {
    const tmps = [
      { name: 'kept.png.tmp-0123456789ab', mtime: old },
      { name: 'gone.png.tmp-abcdef012345', mtime: old },
      { name: 'writing.png.tmp-00112233aabb', mtime: NOW },
    ]
    expect(planOrphanSweep(tmps, new Set(['kept']), NOW)).toEqual(['kept.png.tmp-0123456789ab', 'gone.png.tmp-abcdef012345'])
  })

  it('takes a caller-supplied age so a test does not have to wait a day', () => {
    expect(planOrphanSweep([{ name: 'a.png', mtime: NOW - 10 }], new Set(), NOW, 5)).toEqual(['a.png'])
  })
})

describe('stampBoardMeta (🔒 YAZ-1834 D3/D5/D7)', () => {
  const at = { createdAt: 1000, updatedAt: 2000 }
  const lean = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ type: 'excalidraw', elements: [], files: {}, ...extra }, null, 2)}\n`
  const firstKey = (json: string) => Object.keys(JSON.parse(json) as object)[0]
  const block = (json: string) => (JSON.parse(json) as Record<string, Record<string, unknown>>)[BOARD_META_KEY]

  it('births the block FIRST on a scene that has none, from the given dates', () => {
    const out = stampBoardMeta(lean(), at)
    expect(firstKey(out)).toBe(BOARD_META_KEY)
    expect(block(out)).toEqual({ createdAt: 1000, updatedAt: 2000 })
    expect(out.endsWith('\n')).toBe(true)
    // The drawing itself is untouched, and the block reads back off the head.
    expect(JSON.parse(out)).toMatchObject({ type: 'excalidraw', elements: [], files: {} })
    expect(parseBoardMetaBlock(out.slice(0, BOARD_META_HEAD_BYTES))).toEqual({ createdAt: 1000, updatedAt: 2000 })
  })

  it('keeps an existing createdAt and every unknown key, bumps only updatedAt — the backfill contract', () => {
    const backfilled = lean({ [BOARD_META_KEY]: { createdAt: 1600000000000, updatedAt: 1600000000001, cloudId: 'abc', note: 'has a } brace' } })
    const out = stampBoardMeta(backfilled, at)
    expect(block(out)).toEqual({ createdAt: 1600000000000, updatedAt: 2000, cloudId: 'abc', note: 'has a } brace' })
    expect(parseBoardMetaBlock(out)).toEqual({ createdAt: 1600000000000, updatedAt: 2000, cloudId: 'abc', note: 'has a } brace' })
  })

  it('takes the block the FILE holds (`prior`) over one inside the text — the disk is the block`s truth on save', () => {
    const prior = { createdAt: 10, updatedAt: 11, cloudId: 'disk' }
    // The renderer's json carries no block (the usual save)…
    expect(block(stampBoardMeta(lean(), at, prior))).toEqual({ createdAt: 10, updatedAt: 2000, cloudId: 'disk' })
    // …and even when it does, the file's wins.
    expect(block(stampBoardMeta(lean({ [BOARD_META_KEY]: { createdAt: 1, updatedAt: 2, cloudId: 'text' } }), at, prior))).toEqual({ createdAt: 10, updatedAt: 2000, cloudId: 'disk' })
    // A null prior means "the file has no block": the text's own, if any, then birth.
    expect(block(stampBoardMeta(lean(), at, null))).toEqual({ createdAt: 1000, updatedAt: 2000 })
  })

  it('moves a block that was NOT first to the front and keeps every other key in its order', () => {
    const out = stampBoardMeta(lean({ appState: { a: 1 }, [BOARD_META_KEY]: { createdAt: 5, updatedAt: 6 } }), at)
    expect(Object.keys(JSON.parse(out) as object)).toEqual([BOARD_META_KEY, 'type', 'elements', 'files', 'appState'])
    expect(block(out)).toEqual({ createdAt: 5, updatedAt: 2000 })
  })

  it('replaces a block that is not a plain object, or whose createdAt is not a finite number', () => {
    for (const bad of [7, 'x', null, [1], { createdAt: 'yesterday', updatedAt: 1 }, { createdAt: Infinity }, { updatedAt: 3 }]) {
      expect(block(stampBoardMeta(lean({ [BOARD_META_KEY]: bad }), at)), JSON.stringify(bad)).toMatchObject({ createdAt: 1000, updatedAt: 2000 })
    }
  })

  it('is byte-stable: stamping its own output with the same dates changes nothing', () => {
    const once = stampBoardMeta(lean({ [BOARD_META_KEY]: { z: 1, updatedAt: 9, createdAt: 8 } }), at)
    expect(stampBoardMeta(once, at)).toBe(once)
    // …and the block's key order is normalized whatever the input spelled.
    expect(Object.keys(block(once))).toEqual(['createdAt', 'updatedAt', 'z'])
  })

  it('throws on text that is not a JSON object', () => {
    for (const bad of ['', '{ not json', '[1,2]', 'null', '"s"']) expect(() => stampBoardMeta(bad, at), bad).toThrow()
  })
})

describe('parseBoardMetaBlock (🔒 YAZ-1834 D6/D7)', () => {
  const head = (obj: unknown) => `${JSON.stringify(obj, null, 2)}\n`.slice(0, BOARD_META_HEAD_BYTES)

  it('reads the two dates when the block is the first key', () => {
    expect(parseBoardMetaBlock(head({ [BOARD_META_KEY]: { createdAt: 1, updatedAt: 2 }, type: 'excalidraw' }))).toEqual({ createdAt: 1, updatedAt: 2 })
    // Minified, and with the head cut off mid-document, still fine: only the block is parsed.
    expect(parseBoardMetaBlock('{"yaseendraw":{"createdAt":1,"updatedAt":2},"elements":[{"id":"a","ty')).toEqual({ createdAt: 1, updatedAt: 2 })
  })

  it('carries extra keys in the block back, even one whose value holds a brace', () => {
    expect(parseBoardMetaBlock(head({ [BOARD_META_KEY]: { createdAt: 1, updatedAt: 2, note: 'a } b', cloudId: 'x' } }))).toEqual({ createdAt: 1, updatedAt: 2, note: 'a } b', cloudId: 'x' })
    expect(parseBoardMetaBlock(head({ [BOARD_META_KEY]: { createdAt: 1, updatedAt: 2, note: 'esc \\" } q' } }))).toEqual({ createdAt: 1, updatedAt: 2, note: 'esc \\" } q' })
  })

  it('is null when the block is missing, not first, malformed, non-finite, or cut short', () => {
    const cases: Record<string, string> = {
      missing: head({ type: 'excalidraw', elements: [] }),
      notFirst: head({ type: 'excalidraw', [BOARD_META_KEY]: { createdAt: 1, updatedAt: 2 } }),
      notObject: head({ [BOARD_META_KEY]: 7 }),
      oneDate: head({ [BOARD_META_KEY]: { createdAt: 1 } }),
      stringDate: head({ [BOARD_META_KEY]: { createdAt: '1', updatedAt: 2 } }),
      cutShort: '{"yaseendraw":{"createdAt":1,"upda',
      notJson: 'hello',
      empty: '',
      array: '[{"yaseendraw":{}}]',
    }
    for (const [name, text] of Object.entries(cases)) expect(parseBoardMetaBlock(text), name).toBeNull()
  })
})
