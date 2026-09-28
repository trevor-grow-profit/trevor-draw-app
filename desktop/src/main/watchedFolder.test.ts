/**
 * The one watched-folder shape every store in main shares (media, components, vault config): the
 * relevance filter and the 50 ms debounce, re-anchoring under the engine's polling fallback, the
 * quarantine read and the serialising chain. Echo suppression, a missing folder and `setFolder` are
 * `fs/watchConformance.test.ts`'s. Real engine, real temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sleep, until } from './fs/testFixture'
import { createChain, createWatchedFolder, readOrQuarantine, type WatchedFolder } from './watchedFolder'

/** `fs.watch` refuses while set, so the engine runs its chokidar polling fallback (a network volume's path). */
const nativeWatch = vi.hoisted(() => ({ fail: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const watch = ((...args: Parameters<typeof fs.watch>) => {
    if (nativeWatch.fail) throw Object.assign(new Error('not here'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    return fs.watch(...args)
  }) as typeof fs.watch
  return { ...fs, default: { ...fs, watch }, watch }
})
/** Every path handed to a watcher's `add`, which then does its real work. */
const added = vi.hoisted(() => [] as string[])
vi.mock('./fs/treeWatcher', async (importOriginal) => {
  const engine = await importOriginal<typeof import('./fs/treeWatcher')>()
  const watchTree: typeof engine.watchTree = (...args) => {
    const w = engine.watchTree(...args)
    const add = w.add.bind(w)
    w.add = (p) => void (added.push(p), add(p))
    return w
  }
  return { ...engine, watchTree }
})

/** Long enough for a watcher to have started, and for an event that is coming to have come. */
const QUIET_MS = 600
/** The polling fallback stats once a second; an event it owes arrives within a few polls. */
const POLL_PATIENCE_MS = 8000

let base: string
let folder: WatchedFolder | null = null
let calls: string[][]
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'draw-watched-'))
  calls = []
  added.length = 0
})
afterEach(async () => {
  nativeWatch.fail = false
  await folder?.close()
  folder = null
  await rm(base, { recursive: true, force: true })
})

async function watchJson(dir: string, opts: { depth?: number; alsoWatch?: (dir: string) => readonly string[] } = {}): Promise<WatchedFolder> {
  folder = createWatchedFolder({ dir, depth: 0, tag: 'test', relevant: (p) => p.endsWith('.json'), onChange: (paths) => calls.push([...paths].sort()), ...opts })
  await sleep(QUIET_MS)
  return folder
}

describe('createWatchedFolder', () => {
  it('announces outside changes once, debounced, and ignores irrelevant paths', async () => {
    await watchJson(base)
    await Promise.all([writeFile(path.join(base, 'a.json'), '{}'), writeFile(path.join(base, 'b.json'), '{}'), writeFile(path.join(base, 'a.json.tmp'), 'x')])
    await until(() => calls.length > 0)
    await sleep(QUIET_MS)
    expect(calls).toEqual([[path.join(base, 'a.json'), path.join(base, 'b.json')]])
  })

  describe('under the polling fallback', { timeout: 20_000 }, () => {
    beforeEach(() => void (nativeWatch.fail = true))

    it('the first own write re-anchors a folder that did not exist when the watch started, so the next outside write is heard', async () => {
      const dir = path.join(base, 'later')
      const watched = await watchJson(dir)
      await mkdir(dir)
      const own = path.join(dir, 'own.json')
      await writeFile(own, '{}')
      watched.noteOwnWrite(own, (await stat(own)).mtimeMs)
      await sleep(QUIET_MS)
      await writeFile(path.join(dir, 'outside.json'), '{}')
      await until(() => calls.some((c) => c.includes(path.join(dir, 'outside.json'))), POLL_PATIENCE_MS)
    })

    it('hands every `alsoWatch` path to the watcher once it is ready', async () => {
      // The loss it recovers from — a folder appearing in the first few ms of chokidar's start — cannot
      // be staged reliably, so this pins the hand-over itself.
      const sub = path.join(base, 'components')
      await watchJson(base, { alsoWatch: (dir) => [path.join(dir, 'components')] })
      await until(() => added.length > 0, POLL_PATIENCE_MS)
      expect(added).toEqual([sub])
    })
  })
})

describe('readOrQuarantine', () => {
  const parse = (raw: unknown) => (typeof raw === 'object' && raw !== null && 'ok' in raw ? (raw as { ok: boolean }) : null)

  it('reads a missing file as absent and a good one as parsed', async () => {
    const file = path.join(base, 'store.json')
    expect(await readOrQuarantine(file, parse, 'test', 'a store')).toBeNull()
    await writeFile(file, '{"ok":true}')
    expect(await readOrQuarantine(file, parse, 'test', 'a store')).toEqual({ ok: true })
  })

  it.each([['not JSON', '{nope'], ['the wrong shape', '[1,2]']])('moves %s aside and reads it as absent', async (_what, body) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const file = path.join(base, 'store.json')
    await writeFile(file, body)
    expect(await readOrQuarantine(file, parse, 'test', 'a store')).toBeNull()
    const [aside] = (await readdir(base)).filter((f) => f.startsWith('store.json.corrupt-'))
    expect(await readFile(path.join(base, aside), 'utf8')).toBe(body)
    expect(await readdir(base)).not.toContain('store.json')
    error.mockRestore()
  })
})

describe('createChain', () => {
  it('runs each job only after every earlier one settled, rejections included', async () => {
    const chain = createChain()
    const order: string[] = []
    const job = (name: string, ms: number, fail = false) => () =>
      sleep(ms).then(() => {
        order.push(name)
        if (fail) throw new Error(name)
        return name
      })
    const results = await Promise.allSettled([chain.run(job('slow', 60)), chain.run(job('fails', 10, true)), chain.run(job('last', 0))])
    expect(order).toEqual(['slow', 'fails', 'last'])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })

  it('wait reads after the queued writes without joining the chain', async () => {
    const chain = createChain()
    let value = 0
    void chain.run(() => sleep(30).then(() => void (value = 1)))
    expect(await chain.wait(async () => value)).toBe(1)
  })
})
