import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TreeNode } from '@shared/types'
import { buildTree } from './fsUtils'
import { tree } from './tree'

vi.mock('./fsUtils', async (importOriginal) => ({ ...(await importOriginal<typeof import('./fsUtils')>()), buildTree: vi.fn() }))

/**
 * ONE walk per root at a time (YAZ-2073 5E, 🔒 D10): a watcher storm used to start one full walk
 * per event per window, all at once. Every walk here is a deferred the test settles by hand.
 */
const walks: Array<{ dir: string; resolve: (nodes: TreeNode[]) => void; reject: (err: unknown) => void }> = []
const file = (name: string): TreeNode => ({ type: 'file', name, path: `/${name}`, size: 1, mtime: 1, kind: 'drawing' })
const names = (res: { tree: TreeNode[] }) => res.tree.map((n) => n.name)
/** Lets the pending `requireDir` stats and promise chains run. */
const settle = () => new Promise((r) => setTimeout(r, 20))

let a: string
let b: string
beforeAll(async () => {
  a = await mkdtemp(path.join(tmpdir(), 'yaseendraw-flight-a-'))
  b = await mkdtemp(path.join(tmpdir(), 'yaseendraw-flight-b-'))
})
afterAll(() => Promise.all([rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]))
beforeEach(() => {
  walks.length = 0
  vi.mocked(buildTree).mockImplementation((dir) => new Promise((resolve, reject) => walks.push({ dir, resolve, reject })))
})

describe('tree: one walk per root at a time', () => {
  it('a call made during a walk is answered by the NEXT walk, which starts only after the current one ends', async () => {
    const first = tree(a)
    await settle()
    const second = tree(a)
    await settle()
    expect(walks).toHaveLength(1)
    walks[0].resolve([file('old')])
    expect(names(await first)).toEqual(['old'])
    await settle()
    expect(walks).toHaveLength(2)
    walks[1].resolve([file('new')])
    expect(names(await second)).toEqual(['new'])
  })

  it('fifty calls during a walk share exactly one trailing walk', async () => {
    const first = tree(a)
    await settle()
    const storm = Array.from({ length: 50 }, () => tree(a))
    await settle()
    walks[0].resolve([file('w1')])
    await settle()
    expect(walks).toHaveLength(2)
    walks[1].resolve([file('w2')])
    expect((await Promise.all(storm)).map(names)).toEqual(Array.from({ length: 50 }, () => ['w2']))
    expect(names(await first)).toEqual(['w1'])
    expect(walks).toHaveLength(2)
  })

  it('a failed walk fails only its own callers; the next call walks afresh', async () => {
    const first = tree(a)
    await settle()
    const queued = tree(a)
    await settle()
    walks[0].reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    await expect(first).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await settle()
    walks[1].resolve([file('back')])
    expect(names(await queued)).toEqual(['back'])
    const later = tree(a)
    await settle()
    expect(walks).toHaveLength(3)
    walks[2].resolve([file('fresh')])
    expect(names(await later)).toEqual(['fresh'])
  })

  it('different roots never share a walk', async () => {
    const ra = tree(a)
    const rb = tree(b)
    await settle()
    expect(walks.map((w) => w.dir).sort()).toEqual([a, b].sort())
    walks.find((w) => w.dir === a)?.resolve([file('in-a')])
    walks.find((w) => w.dir === b)?.resolve([file('in-b')])
    expect([names(await ra), names(await rb)]).toEqual([['in-a'], ['in-b']])
  })

  it('a call after every walk settled walks again: nothing is cached', async () => {
    const one = tree(a)
    await settle()
    walks[0].resolve([file('one')])
    await one
    const two = tree(a)
    await settle()
    expect(walks).toHaveLength(2)
    walks[1].resolve([file('two')])
    expect(names(await two)).toEqual(['two'])
  })
})
