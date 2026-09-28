import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_DIAGRAM_BYTES } from '@shared/types'
import { BOARDS, boardTarget, guardedStamp, resolveBoard } from './boardDocument'
import { failure } from './testFixture'

/** The rules both board doors share (YAZ-2073 D16); `drawing.test.ts` and `diagram.test.ts` pin them per door. */
let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-board-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('resolveBoard / boardTarget', () => {
  it('resolves a vault-relative or absolute path of the asked kind inside the vault', () => {
    expect(resolveBoard(root, 'A/B.excalidraw', 'drawing')).toBe(path.join(root, 'A/B.excalidraw'))
    expect(resolveBoard(root, path.join(root, 'Flow.drawio'), 'diagram')).toBe(path.join(root, 'Flow.drawio'))
  })

  it('refuses the other kind in its own words, an escape and a missing path', () => {
    expect(() => resolveBoard(root, 'Flow.drawio', 'drawing')).toThrow(BOARDS.drawing.refused)
    expect(() => resolveBoard(root, 'Board.excalidraw', 'diagram')).toThrow(BOARDS.diagram.refused)
    expect(() => resolveBoard(root, '../Out.excalidraw', 'drawing')).toThrow('path escapes the vault root')
    expect(() => resolveBoard(root, ' ', 'diagram')).toThrow("missing 'path'")
  })

  it('checks the request shape before the path', () => {
    expect(() => boardTarget(null, 'drawing')).toThrow('request must be an object')
    expect(boardTarget({ root, path: 'Flow.drawio', xml: 'x' }, 'diagram')).toEqual({ dir: root, file: path.join(root, 'Flow.drawio'), body: { root, path: 'Flow.drawio', xml: 'x' } })
  })
})

describe('guardedStamp', () => {
  const stampWith = (at: { createdAt: number; updatedAt: number }) => `${at.createdAt}/${at.updatedAt}`

  it('a new file is born now, and no guard can refuse it — a gone file is not a conflict', async () => {
    const file = path.join(root, 'New.excalidraw')
    const before = Date.now()
    const [born, updated] = (await guardedStamp(file, 'drawing', 123, stampWith)).split('/').map(Number)
    expect(born).toBe(updated)
    expect(born).toBeGreaterThanOrEqual(before)
  })

  it('an existing file stamps with its own age and head block, under a matching guard', async () => {
    const file = path.join(root, 'Board.excalidraw')
    await writeFile(file, '{"yaseendraw":{"createdAt":5,"updatedAt":6,"extra":1},"elements":[]}\n')
    const { mtimeMs } = await stat(file)
    let seen: unknown
    const stamped = await guardedStamp(file, 'drawing', mtimeMs, (at, prior) => {
      seen = prior
      return stampWith(at)
    })
    expect(Number(stamped.split('/')[0])).toBe(mtimeMs)
    expect(seen).toMatchObject({ createdAt: 5, extra: 1 })
  })

  it('a stale guard is a CONFLICT naming the kind and the disk mtime', async () => {
    const file = path.join(root, 'Flow.drawio')
    await writeFile(file, '<mxfile></mxfile>\n')
    const { mtimeMs } = await stat(file)
    const err = await failure(guardedStamp(file, 'diagram', mtimeMs - 1000, stampWith))
    expect(err).toMatchObject({ code: 'CONFLICT', message: 'draw.io diagram changed on disk since last read', path: file, mtime: mtimeMs })
  })

  it('measures the stamped bytes against the kind’s ceiling', async () => {
    const err = await failure(guardedStamp(path.join(root, 'Big.drawio'), 'diagram', undefined, () => 'x'.repeat(MAX_DIAGRAM_BYTES + 1)))
    expect(err).toMatchObject({ code: 'TOO_LARGE', message: BOARDS.diagram.tooLarge })
  })
})
