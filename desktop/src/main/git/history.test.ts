import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BoardVersionScene } from '@shared/types'
import { parseDiagramMetaAttrs } from '@shared/diagramFile'
import { boardHistory, boardVersion, restoreBoardVersion } from './history'
import { makeTwoMachines, REAL_GIT_TIMEOUT_MS, type Machine } from './gitFixture'
import { syncPass } from './sync'

/**
 * Version history (YAZ-1897 D4) over REAL git: two machines, real sync passes, then the three
 * reads a person makes from the panel — the list, one version's picture data, and a restore.
 */

type El = Record<string, unknown> & { id: string }
const shape = (id: string, over: Partial<El> = {}): El => ({ id, type: 'rectangle', x: 0, index: `a${id}`, version: 1, versionNonce: 1, updated: 1000, isDeleted: false, boundElements: null, ...over })
const board = (elements: El[]): string => `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} }, null, 2)}\n`
const xs = (json: string): unknown[] => (JSON.parse(json) as { elements: El[] }).elements.map((e) => e.x)
/** A draw.io diagram as main stamps it (🔒 YAZ-1802 D7), one labelled cell. */
const diagram = (label: string, created = 1000, updated = created): string =>
  `<mxfile yaseendraw-created="${created}" yaseendraw-updated="${updated}">\n  <diagram id="p" name="Page-1">\n    <mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${label}" vertex="1" parent="1"/></root></mxGraphModel>\n  </diagram>\n</mxfile>\n`

/** A DRAWING's version: `boardVersion`'s scene half (🔒 YAZ-1802 D10 made it a union on `kind`). */
async function drawingVersion(root: string, rawPath: string, ref: string | undefined): Promise<Extract<BoardVersionScene, { kind: 'drawing' }>> {
  const version = await boardVersion(root, rawPath, ref)
  if (version.kind !== 'drawing') throw new Error(`expected a drawing version, got ${version.kind}`)
  return version
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function twoMachines(files: Record<string, string>): Promise<{ a: Machine; b: Machine }> {
  const pair = await makeTwoMachines(files)
  cleanups.push(pair.cleanup)
  return pair
}

const r1 = shape('1')
const r2 = shape('2')

describe('Version history', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('lists versions newest first with who made them; a merge is marked, and "before the merge" is offered', async () => {
    const { a, b } = await twoMachines({ 'b.excalidraw': board([r1, r2]) })
    await b.write('b.excalidraw', board([{ ...r1, x: 7, version: 2, updated: 3000 }, r2]))
    await syncPass(b.root)
    await a.write('b.excalidraw', board([{ ...r1, x: 13, version: 2, updated: 2000 }, { ...r2, x: 5, version: 2, updated: 2000 }]))
    await syncPass(a.root)

    const versions = await boardHistory(a.root, 'b.excalidraw')
    const plain = versions.filter((v) => !v.localOnly)
    expect(plain.map((v) => [v.author, v.merged])).toEqual([
      ['Trevor Draw Test', true],
      ['Sam', false],
      ['Trevor Draw Test', false],
    ])
    expect(plain.every((v, i) => i === 0 || v.at <= (plain[i - 1]?.at ?? 0))).toBe(true)
    const before = versions.find((v) => v.localOnly)
    expect(before).toMatchObject({ author: 'Trevor Draw Test', merged: false })
    expect(xs((await drawingVersion(a.root, 'b.excalidraw', before?.ref)).json)).toEqual([13, 5])
    expect(xs((await drawingVersion(a.root, path.join(a.root, 'b.excalidraw'), plain[0]?.ref)).json)).toEqual([7, 5])
  })

  it('drops "before the merge" once the board no longer differs from it', async () => {
    const { a, b } = await twoMachines({ 'b.excalidraw': board([r1]), 'other.excalidraw': board([r1]) })
    await b.write('b.excalidraw', board([r1, shape('sam', { index: 'a9' })]))
    await syncPass(b.root)
    await a.write('b.excalidraw', board([r1, shape('me', { index: 'a9' })]))
    await syncPass(a.root)
    // The merge never touched `other.excalidraw`: its before-merge version is its current one.
    expect((await boardHistory(a.root, 'other.excalidraw')).some((v) => v.localOnly)).toBe(false)
    expect((await boardHistory(a.root, 'b.excalidraw')).some((v) => v.localOnly)).toBe(true)
  })

  it('follows a rename: older versions still open under their old name', async () => {
    const { a } = await twoMachines({ 'old.excalidraw': board([r1]) })
    await a.git('mv', 'old.excalidraw', 'new.excalidraw')
    await a.write('new.excalidraw', board([{ ...r1, x: 3 }]))
    await a.git('commit', '-am', 'rename and edit')
    const versions = await boardHistory(a.root, 'new.excalidraw')
    expect(versions).toHaveLength(2)
    expect(versions[1]?.ref.endsWith(':old.excalidraw')).toBe(true)
    expect(xs((await drawingVersion(a.root, 'new.excalidraw', versions[1]?.ref)).json)).toEqual([0])
  })

  it('resolves an old version\'s pictures from assets/, like opening the board does', async () => {
    const image = shape('img', { type: 'image', fileId: 'abc123' })
    const { a } = await twoMachines({ 'b.excalidraw': board([image]), 'assets/abc123.png': 'png-bytes' })
    const [v] = await boardHistory(a.root, 'b.excalidraw')
    const scene = await drawingVersion(a.root, 'b.excalidraw', v?.ref)
    expect(scene.files.abc123).toEqual({ mimeType: 'image/png', dataURL: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}` })
  })

  it('restores a version as an ordinary edit, byte for byte', async () => {
    const { a } = await twoMachines({ 'b.excalidraw': board([r1]) })
    await a.write('b.excalidraw', board([{ ...r1, x: 9 }]))
    await a.git('commit', '-am', 'edit')
    const oldest = (await boardHistory(a.root, 'b.excalidraw')).at(-1)
    await restoreBoardVersion(a.root, 'b.excalidraw', oldest?.ref)
    expect(a.read('b.excalidraw')).toBe(board([r1]))
    expect(await a.git('status', '--porcelain')).toBe('M b.excalidraw')
  })

  it('refuses a ref it did not hand out, a path outside the vault, and a non-board', async () => {
    const { a } = await twoMachines({ 'b.excalidraw': board([r1]), 'n.md': 'x' })
    await expect(boardVersion(a.root, 'b.excalidraw', 'HEAD:b.excalidraw')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(boardVersion(a.root, 'b.excalidraw', '--output=/tmp/x')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(boardHistory(a.root, '../escape.excalidraw')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(boardHistory(a.root, 'n.md')).rejects.toMatchObject({ code: 'UNSUPPORTED_EXTENSION' })
  })

  it('answers an empty history for a vault with no git', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-nogit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'b.excalidraw'), board([r1]))
    expect(await boardHistory(dir, 'b.excalidraw')).toEqual([])
  })

  describe('a draw.io diagram (🔒 YAZ-1802 D10)', () => {
    it('lists every version, and a version is the diagram`s XML — not a scene', async () => {
      const { a } = await twoMachines({ 'Flow.drawio': diagram('one') })
      await a.write('Flow.drawio', diagram('two'))
      await a.git('commit', '-am', 'two')
      await a.write('Flow.drawio', diagram('three'))
      await a.git('commit', '-am', 'three')
      const versions = await boardHistory(a.root, 'Flow.drawio')
      expect(versions).toHaveLength(3)
      expect(await boardVersion(a.root, 'Flow.drawio', versions[2]?.ref)).toEqual({ kind: 'diagram', xml: diagram('one') })
    })

    it('restores through diagram:save: that version`s bytes, created kept, updated moved to now', async () => {
      const { a } = await twoMachines({ 'Flow.drawio': diagram('one', 1000) })
      await a.write('Flow.drawio', diagram('two', 1000, 2000))
      await a.git('commit', '-am', 'two')
      const oldest = (await boardHistory(a.root, 'Flow.drawio')).at(-1)
      const before = Date.now()
      await restoreBoardVersion(a.root, 'Flow.drawio', oldest?.ref)
      const restored = a.read('Flow.drawio')
      const meta = parseDiagramMetaAttrs(restored)
      expect(meta?.createdAt).toBe(1000)
      expect(meta?.updatedAt).toBeGreaterThanOrEqual(before)
      expect(restored.replace(/yaseendraw-updated="\d+"/, 'yaseendraw-updated="1000"')).toBe(diagram('one', 1000))
    })

    it('never shows or restores a version that is no draw.io diagram', async () => {
      const { a } = await twoMachines({ 'Flow.drawio': 'not a diagram' })
      await a.write('Flow.drawio', diagram('fixed'))
      await a.git('commit', '-am', 'fixed')
      const corrupt = (await boardHistory(a.root, 'Flow.drawio')).at(-1)
      await expect(boardVersion(a.root, 'Flow.drawio', corrupt?.ref)).rejects.toMatchObject({ code: 'IO_ERROR' })
      await expect(restoreBoardVersion(a.root, 'Flow.drawio', corrupt?.ref)).rejects.toMatchObject({ code: 'IO_ERROR' })
      expect(a.read('Flow.drawio')).toBe(diagram('fixed'))
    })
  })
})
