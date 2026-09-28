/**
 * The one watched-folder shape every store in main shares (media, components, vault config): its
 * four rules — relevance filter, own-write echo suppression, re-anchoring a folder created after
 * the watch, the 50 ms debounce — plus the quarantine read and the serialising chain. Real chokidar
 * (stat polling, `vitest.config.ts`), real temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { until } from './fs/testFixture'
import { createChain, createWatchedFolder, readOrQuarantine, type WatchedFolder } from './watchedFolder'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Long enough for chokidar's initial scan, and for an event that is coming to have come. */
const SETTLE_MS = 600

let base: string
let folder: WatchedFolder | null = null
let calls: string[][]
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'draw-watched-'))
  calls = []
})
afterEach(async () => {
  await folder?.close()
  folder = null
  await rm(base, { recursive: true, force: true })
})

async function watchJson(dir: string): Promise<WatchedFolder> {
  folder = createWatchedFolder({ dir, depth: 0, tag: 'test', relevant: (p) => p.endsWith('.json'), onChange: (paths) => calls.push([...paths].sort()) })
  await sleep(SETTLE_MS)
  return folder
}

describe('createWatchedFolder', () => {
  it('announces outside changes once, debounced, and ignores irrelevant paths', async () => {
    await watchJson(base)
    await Promise.all([writeFile(path.join(base, 'a.json'), '{}'), writeFile(path.join(base, 'b.json'), '{}'), writeFile(path.join(base, 'a.json.tmp'), 'x')])
    await until(() => calls.length > 0)
    await sleep(SETTLE_MS)
    expect(calls).toEqual([[path.join(base, 'a.json'), path.join(base, 'b.json')]])
  })

  it("drops the echo of this process's own write and delete, but not a later outside change", async () => {
    const file = path.join(base, 'own.json')
    await writeFile(file, '{}')
    const watched = await watchJson(base)
    await writeFile(file, '{"a":1}')
    watched.noteOwnWrite(file, (await stat(file)).mtimeMs)
    await sleep(SETTLE_MS)
    expect(calls).toEqual([])
    watched.noteOwnWrite(file, null)
    await unlink(file)
    await sleep(SETTLE_MS)
    expect(calls).toEqual([])
    await writeFile(file, '{"b":2}')
    await until(() => calls.length > 0)
    expect(calls).toEqual([[file]])
  })

  it('re-anchors on the first own write when the folder did not exist yet', async () => {
    const dir = path.join(base, 'later')
    const watched = await watchJson(dir)
    await mkdir(dir)
    const own = path.join(dir, 'own.json')
    await writeFile(own, '{}')
    watched.noteOwnWrite(own, (await stat(own)).mtimeMs)
    await sleep(SETTLE_MS)
    await writeFile(path.join(dir, 'outside.json'), '{}')
    await until(() => calls.some((c) => c.includes(path.join(dir, 'outside.json'))))
  })

  it('setFolder silences the old folder and watches the new one', async () => {
    const next = path.join(base, 'next')
    await mkdir(next)
    const watched = await watchJson(base)
    watched.setFolder(next)
    await sleep(SETTLE_MS)
    await writeFile(path.join(base, 'old.json'), '{}')
    await writeFile(path.join(next, 'new.json'), '{}')
    await until(() => calls.length > 0)
    await sleep(SETTLE_MS)
    expect(calls).toEqual([[path.join(next, 'new.json')]])
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
