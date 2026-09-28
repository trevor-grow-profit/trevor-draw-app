/**
 * The ⌘K catalog (YAZ-1814): ONE walk of the tree the Sidebar already holds gives one row per
 * drawing — named the way the tree and the tab strip spell it — and one row per folder (🔒 YAZ-1491 D1/D2,
 * YAZ-1491), ranked through the shared matcher at SEARCH_CAP. Non-drawing files never appear, and
 * `assets/` is already gone from `fs:tree`, so the catalog inherits that rule.
 */
import { describe, expect, it } from 'vitest'
import type { FileKind, TreeNode } from '@shared/types'
import { SEARCH_CAP, buildBoardCatalog, searchTitles } from './searchCandidates'

const file = (path: string, kind: FileKind | null = 'drawing'): TreeNode => ({
  type: 'file',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  size: 1,
  mtime: 1,
  kind,
})

const dir = (path: string, children: TreeNode[] = []): TreeNode => ({
  type: 'dir',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  children,
})

describe('buildBoardCatalog — the file rows', () => {
  it('one row per drawing: matched on the name, opening its own path, folder as the label', () => {
    expect(buildBoardCatalog('/vault', [dir('/vault/sub', [file('/vault/sub/Alpha.excalidraw')])])).toEqual([
      { kind: 'dir', name: 'sub', lower: 'sub', label: 'sub', path: '/vault/sub', folder: '' },
      { kind: 'file', name: 'Alpha', lower: 'alpha', label: 'Alpha', path: '/vault/sub/Alpha.excalidraw', folder: 'sub' },
    ])
  })

  it('a root-level drawing carries an empty folder', () => {
    expect(buildBoardCatalog('/vault', [file('/vault/Alpha.excalidraw')])[0].folder).toBe('')
  })

  it('a nested drawing is labelled by its ROOT-RELATIVE parent, and a trailing slash on the root is tolerated', () => {
    const deep = [dir('/vault/A', [dir('/vault/A/B', [file('/vault/A/B/Deep.excalidraw')])])]
    expect(buildBoardCatalog('/vault', deep).find((r) => r.kind === 'file')?.folder).toBe('A/B')
    expect(buildBoardCatalog('/vault/', deep).find((r) => r.kind === 'file')?.folder).toBe('A/B')
  })

  it('reads a Windows vault in its own separator (YAZ-2073 8B)', () => {
    const tree: TreeNode[] = [
      { type: 'dir', name: 'A', path: 'C:\\v\\A', children: [{ type: 'file', name: 'Deep.excalidraw', path: 'C:\\v\\A\\Deep.excalidraw', size: 1, mtime: 1, kind: 'drawing' }] },
      { type: 'file', name: 'Top.excalidraw', path: 'C:\\v\\Top.excalidraw', size: 1, mtime: 1, kind: 'drawing' },
    ]
    expect(buildBoardCatalog('C:\\v', tree).map((r) => [r.name, r.folder])).toEqual([['A', ''], ['Deep', 'A'], ['Top', '']])
    expect(buildBoardCatalog('C:\\v\\', tree).map((r) => r.folder)).toEqual(['', 'A', ''])
  })

  it('a drawing matches and reads WITHOUT its extension — the name the tree shows', () => {
    const rows = buildBoardCatalog('/vault', [file('/vault/Customer Acquisition Cost.excalidraw')])
    expect(rows.map((c) => [c.name, c.label, c.lower])).toEqual([['Customer Acquisition Cost', 'Customer Acquisition Cost', 'customer acquisition cost']])
    expect(rows[0].path).toBe('/vault/Customer Acquisition Cost.excalidraw')
  })

  it('🔒 YAZ-1802 D2: a draw.io diagram is a board too — a row, its .drawio hidden; a picture of one is not', () => {
    const rows = buildBoardCatalog('/vault', [file('/vault/Flow.drawio', 'diagram'), file('/vault/UP.DRAWIO', 'diagram'), file('/vault/image.drawio.svg', null)])
    expect(rows.map((c) => [c.name, c.path])).toEqual([
      ['Flow', '/vault/Flow.drawio'],
      ['UP', '/vault/UP.DRAWIO'],
    ])
  })

  it('duplicate names BOTH appear under the bare name, told apart by the folder', () => {
    const rows = buildBoardCatalog('/vault', [file('/vault/Note.excalidraw'), dir('/vault/deep', [file('/vault/deep/Note.excalidraw')])]).filter((r) => r.kind === 'file')
    expect(rows.map((c) => c.name)).toEqual(['Note', 'Note'])
    expect(rows.map((c) => c.folder)).toEqual(['', 'deep'])
    expect(rows.map((c) => c.path)).toEqual(['/vault/Note.excalidraw', '/vault/deep/Note.excalidraw'])
  })

  it('a NON-drawing file is never a row — it lists in the tree and opens in the OS app, but it is not a document', () => {
    expect(buildBoardCatalog('/vault', [file('/vault/photo.png', null), file('/vault/notes.md', null), file('/vault/Board.excalidraw')]).map((r) => r.path)).toEqual([
      '/vault/Board.excalidraw',
    ])
  })

  it('the image store never appears: `fs:tree` already drops the top-level `assets/`, and the catalog is that tree', () => {
    // What `fs:tree` hands over for a vault WITH an image store: the store is simply not in it.
    expect(buildBoardCatalog('/vault', [file('/vault/Board.excalidraw')]).some((r) => r.name === 'assets')).toBe(false)
    // A folder the user called `assets` INSIDE a subfolder is theirs — the tree shows it, so search finds it.
    expect(buildBoardCatalog('/vault', [dir('/vault/sub', [dir('/vault/sub/assets')])]).map((r) => r.path)).toEqual(['/vault/sub', '/vault/sub/assets'])
  })

  it('an empty tree is an empty catalog', () => {
    expect(buildBoardCatalog('/vault', [])).toEqual([])
  })
})

describe('buildBoardCatalog — the folder rows (🔒 D1, YAZ-1491)', () => {
  it('one `dir` row per folder: matched by its own name, revealing its own path', () => {
    expect(buildBoardCatalog('/vault', [dir('/vault/Archive')])).toEqual([
      { kind: 'dir', name: 'Archive', lower: 'archive', label: 'Archive', path: '/vault/Archive', folder: '' },
    ])
  })

  it('a nested folder is labelled by its ROOT-RELATIVE parent, the way a drawing row is', () => {
    const rows = buildBoardCatalog('/vault', [dir('/vault/A', [dir('/vault/A/B', [dir('/vault/A/B/C')])])])
    expect(rows.map((c) => [c.name, c.folder])).toEqual([
      ['A', ''],
      ['B', 'A'],
      ['C', 'A/B'],
    ])
  })

  it('folders lead the catalog, outer before inner, whatever order their drawings sit in', () => {
    const rows = buildBoardCatalog('/vault', [file('/vault/Root.excalidraw'), dir('/vault/A', [file('/vault/A/Inner.excalidraw'), dir('/vault/A/B')])])
    expect(rows.map((c) => c.path)).toEqual(['/vault/A', '/vault/A/B', '/vault/Root.excalidraw', '/vault/A/Inner.excalidraw'])
  })
})

describe('searchTitles', () => {
  const catalog = buildBoardCatalog('/vault', [file('/vault/Big CAC story.excalidraw'), file('/vault/CAC Model.excalidraw'), file('/vault/CAC.excalidraw')])

  it('ranks exact → prefix → substring, input order within each bucket', () => {
    expect(searchTitles(catalog, 'cac').map((c) => c.label)).toEqual(['CAC', 'CAC Model', 'Big CAC story'])
  })

  it('is case-insensitive in both directions', () => {
    expect(searchTitles(catalog, 'CAC MODEL').map((c) => c.label)).toEqual(['CAC Model'])
  })

  it('a drawing never matches on its folder (🔒 D3, YAZ-739); the folder itself is ONE row (🔒 D2, YAZ-1491)', () => {
    const rows = buildBoardCatalog('/vault', [dir('/vault/Archive', [file('/vault/Archive/Note.excalidraw')])])
    expect(searchTitles(rows, 'archive').map((c) => [c.kind, c.label])).toEqual([['dir', 'Archive']])
  })

  it('a folder and a drawing of the same name both match exactly — the folder first (🔒 YAZ-1491 D1)', () => {
    const rows = buildBoardCatalog('/vault', [dir('/vault/CAC'), file('/vault/CAC.excalidraw')])
    expect(searchTitles(rows, 'cac').map((c) => [c.kind, c.path])).toEqual([
      ['dir', '/vault/CAC'],
      ['file', '/vault/CAC.excalidraw'],
    ])
  })

  it('"Board 4" lists Board 04 and Board 40–49, prefix-first (the issue`s acceptance criterion)', () => {
    const rows = buildBoardCatalog('/vault', [
      file('/vault/Board 04.excalidraw'),
      ...Array.from({ length: 10 }, (_, i) => file(`/vault/Board 4${i}.excalidraw`)),
      file('/vault/Old Board 4 sketch.excalidraw'),
    ])
    const hits = searchTitles(rows, 'Board 4').map((c) => c.label)
    expect(hits.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `Board 4${i}`))
    expect(hits).toContain('Old Board 4 sketch')
    expect(hits.indexOf('Old Board 4 sketch')).toBeGreaterThan(hits.indexOf('Board 49'))
    expect(searchTitles(rows, 'Board 04').map((c) => c.label)).toEqual(['Board 04'])
  })

  it('an empty query returns the first SEARCH_CAP rows in catalog order', () => {
    const many = buildBoardCatalog('/vault', Array.from({ length: SEARCH_CAP + 10 }, (_, i) => file(`/vault/Note ${i}.excalidraw`)))
    expect(searchTitles(many, '')).toEqual(many.slice(0, SEARCH_CAP))
  })

  it('caps at SEARCH_CAP AFTER ranking — a late exact match still tops a board of substrings', () => {
    const many = buildBoardCatalog('/vault', [
      ...Array.from({ length: SEARCH_CAP + 10 }, (_, i) => file(`/vault/note cac ${i}.excalidraw`)),
      file('/vault/CAC.excalidraw'),
    ])
    const matched = searchTitles(many, 'cac')
    expect(matched).toHaveLength(SEARCH_CAP)
    expect(matched[0].name).toBe('CAC')
  })
})

/**
 * The perf tripwire (YAZ-1814): ⌘K has NO debounce, so every keystroke builds nothing and scans the whole
 * catalog. These budgets are an order of magnitude above what the scan costs — they exist to fail
 * loudly if the matcher ever grows a per-row allocation, a regex or a sort, not to time a machine.
 */
describe('perf tripwire — a 5,000-drawing vault', () => {
  const tree: TreeNode[] = Array.from({ length: 50 }, (_, d) =>
    dir(
      `/vault/Folder ${d}`,
      Array.from({ length: 100 }, (_, i) => file(`/vault/Folder ${d}/Board ${d}-${i}.excalidraw`)),
    ),
  )

  it('builds the catalog once, well under a frame', () => {
    const started = performance.now()
    const catalog = buildBoardCatalog('/vault', tree)
    const elapsed = performance.now() - started
    expect(catalog).toHaveLength(5050)
    expect(elapsed).toBeLessThan(200)
  })

  it('ranks a whole typed word — one scan per keystroke — well inside a keypress', () => {
    const catalog = buildBoardCatalog('/vault', tree)
    const queries = ['b', 'bo', 'boa', 'boar', 'board', 'board ', 'board 4', 'board 40', 'board 40-', 'board 40-9']
    const started = performance.now()
    for (const q of queries) searchTitles(catalog, q)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(250)
  })
})
