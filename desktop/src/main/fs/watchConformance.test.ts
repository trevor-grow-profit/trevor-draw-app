import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { WatchEvent } from '@shared/types'
import { createWatchedFolder } from '../watchedFolder'
import { atomicWrite } from './fsUtils'
import { activeWatcherRoots, subscribe } from './watchers'
import { makeFixture, until } from './testFixture'

/**
 * THE WATCHER CONFORMANCE SUITE (YAZ-2073 5F, 🔒 D9): what every consumer of a watcher relies on,
 * written as observable events on real disk, so the engine underneath can change and this file
 * says whether anything a consumer sees changed with it. The Sidebar refreshes on any event, an
 * open editor reloads (or raises the conflict bar) on `change` of its own path with the file's
 * mtime, git sync debounces on any event, and the config / library stores re-read on a relevant
 * path. Every case records until the watcher has been quiet for `QUIET_MS`, then compares.
 *
 * The desktop project runs chokidar with stat polling (`vitest.config.ts`); this suite does not,
 * because it pins what the app does in production.
 */
delete process.env.CHOKIDAR_USEPOLLING

/** Longer than any engine's own settling (chokidar's `awaitWriteFinish` is 200 ms), so a late duplicate would be caught. */
const QUIET_MS = 600

let root: string
let cleanup: () => Promise<void>
let outside: string
/**
 * FSEvents can hand a watcher the last few milliseconds of history from BEFORE it started (chokidar
 * then reports those files as `change`d), so every case starts on a vault that has been still for a
 * moment: after the fixture is made, and after each case's own clean-up.
 */
const still = () => new Promise((r) => setTimeout(r, 400))
beforeAll(async () => {
  ;({ root, cleanup } = await makeFixture())
  outside = await mkdtemp(path.join(tmpdir(), 'yaseendraw-outside-'))
  await still()
})
afterAll(async () => {
  await cleanup()
  await rm(outside, { recursive: true, force: true })
})

const offs: Array<() => void> = []
afterEach(async () => {
  offs.splice(0).forEach((off) => off())
  await until(() => activeWatcherRoots().length === 0)
  await still()
})

/** Subscribes, waits for `ready`, and hands back the events that follow it. */
async function watching(): Promise<{ events: WatchEvent[]; settled: () => Promise<WatchEvent[]> }> {
  const events: WatchEvent[] = []
  let ready = false
  offs.push(subscribe(root, (ev) => (ev.type === 'ready' ? (ready = true) : events.push(ev))))
  await until(() => ready)
  /** Resolves once no event has arrived for `QUIET_MS`. */
  const settled = async () => {
    let seen = -1
    while (seen !== events.length) {
      seen = events.length
      await new Promise((r) => setTimeout(r, QUIET_MS))
    }
    return events
  }
  return { events, settled }
}

const at = (...parts: string[]) => path.join(root, ...parts)
const mtimeOf = async (p: string) => (await stat(p)).mtimeMs
/** Order-free view of a recording: `type path`, sorted. */
const shape = (events: readonly WatchEvent[]) => events.map((e) => `${e.type} ${'path' in e ? path.relative(root, e.path) : ''}`).sort()

describe('watcher conformance: the vault watcher', () => {
  it('an atomic save over an existing board is exactly ONE `change`, carrying the file`s final mtime; the tmp file is silent', async () => {
    const file = at('alpha', 'a.excalidraw')
    const w = await watching()
    const { mtime } = await atomicWrite(file, '{"saved":1}')
    const events = await w.settled()
    expect(events).toEqual([{ type: 'change', path: file, mtime }])
    expect(mtime).toBe(await mtimeOf(file))
  })

  it('an atomic create is exactly ONE `add`; the tmp file is silent', async () => {
    const file = at('alpha', 'fresh.excalidraw')
    const w = await watching()
    const { mtime } = await atomicWrite(file, '{"new":1}')
    expect(await w.settled()).toEqual([{ type: 'add', path: file, mtime }])
    await rm(file)
  })

  it('write, overwrite, delete: `add`, `change`, `unlink`', async () => {
    const file = at('Zeta', 'plain.excalidraw')
    const w = await watching()
    await writeFile(file, 'one')
    await until(() => w.events.length === 1)
    await writeFile(file, 'two, longer')
    await until(() => w.events.length === 2)
    await rm(file)
    await w.settled()
    expect(w.events.map((e) => e.type)).toEqual(['add', 'change', 'unlink'])
    expect(w.events.every((e) => 'path' in e && e.path === file)).toBe(true)
  })

  it('a burst of saves to one board collapses to ONE `change` with the last mtime', async () => {
    const file = at('alpha', 'a.excalidraw')
    const w = await watching()
    for (let i = 0; i < 5; i++) {
      await writeFile(file, `save ${i}`)
      await new Promise((r) => setTimeout(r, 10))
    }
    const events = await w.settled()
    expect(events).toEqual([{ type: 'change', path: file, mtime: await mtimeOf(file) }])
  })

  it('a file written in slow chunks (a sync tool, a copy) is announced once, when it is whole', async () => {
    const file = at('Zeta', 'slow.excalidraw')
    const w = await watching()
    for (let i = 0; i < 8; i++) {
      await appendFile(file, `chunk ${i}\n`)
      await new Promise((r) => setTimeout(r, 30))
    }
    const events = await w.settled()
    expect(events).toEqual([{ type: 'add', path: file, mtime: await mtimeOf(file) }])
    await rm(file)
  })

  it('mkdir -p plus a file: every new folder is `addDir`, the file is `add`', async () => {
    const w = await watching()
    await mkdir(at('deep', 'er', 'est'), { recursive: true })
    await writeFile(at('deep', 'er', 'est', 'd.excalidraw'), 'd')
    expect(shape(await w.settled())).toEqual(['add deep/er/est/d.excalidraw', 'addDir deep', 'addDir deep/er', 'addDir deep/er/est'])
    await rm(at('deep'), { recursive: true })
  })

  it('renaming a folder: everything under the old name goes, everything under the new one comes', async () => {
    await mkdir(at('Before', 'sub'), { recursive: true })
    await writeFile(at('Before', 'one.excalidraw'), '1')
    await writeFile(at('Before', 'sub', 'two.excalidraw'), '2')
    const w = await watching()
    await rename(at('Before'), at('After'))
    expect(shape(await w.settled())).toEqual([
      'add After/one.excalidraw',
      'add After/sub/two.excalidraw',
      'addDir After',
      'addDir After/sub',
      'unlink Before/one.excalidraw',
      'unlink Before/sub/two.excalidraw',
      'unlinkDir Before',
      'unlinkDir Before/sub',
    ])
    await rm(at('After'), { recursive: true })
  })

  it('renaming a file: `unlink` the old name, `add` the new one', async () => {
    await writeFile(at('alpha', 'old-name.excalidraw'), 'x')
    const w = await watching()
    await rename(at('alpha', 'old-name.excalidraw'), at('alpha', 'new-name.excalidraw'))
    expect(shape(await w.settled())).toEqual(['add alpha/new-name.excalidraw', 'unlink alpha/old-name.excalidraw'])
    await rm(at('alpha', 'new-name.excalidraw'))
  })

  it('trash (a move out of the vault): a folder takes everything inside it along, a file is `unlink`', async () => {
    await mkdir(at('Doomed', 'inner'), { recursive: true })
    await writeFile(at('Doomed', 'x.excalidraw'), 'x')
    await writeFile(at('Doomed', 'inner', 'y.png'), 'y')
    await writeFile(at('loose.excalidraw'), 'l')
    const w = await watching()
    await rename(at('Doomed'), path.join(outside, 'Doomed'))
    await rename(at('loose.excalidraw'), path.join(outside, 'loose.excalidraw'))
    expect(shape(await w.settled())).toEqual(['unlink Doomed/inner/y.png', 'unlink Doomed/x.excalidraw', 'unlink loose.excalidraw', 'unlinkDir Doomed', 'unlinkDir Doomed/inner'])
  })

  it('a move INTO the vault from outside: the folder and everything in it arrive', async () => {
    await mkdir(path.join(outside, 'Incoming', 'nested'), { recursive: true })
    await writeFile(path.join(outside, 'Incoming', 'i.excalidraw'), 'i')
    await writeFile(path.join(outside, 'Incoming', 'nested', 'n.drawio'), 'n')
    const w = await watching()
    await rename(path.join(outside, 'Incoming'), at('Incoming'))
    expect(shape(await w.settled())).toEqual(['add Incoming/i.excalidraw', 'add Incoming/nested/n.drawio', 'addDir Incoming', 'addDir Incoming/nested'])
    await rm(at('Incoming'), { recursive: true })
  })

  it('rm -rf of a folder: each file `unlink`, each folder `unlinkDir`', async () => {
    await mkdir(at('Gone', 'a'), { recursive: true })
    await writeFile(at('Gone', 'g.excalidraw'), 'g')
    await writeFile(at('Gone', 'a', 'h.excalidraw'), 'h')
    const w = await watching()
    await rm(at('Gone'), { recursive: true })
    expect(shape(await w.settled())).toEqual(['unlink Gone/a/h.excalidraw', 'unlink Gone/g.excalidraw', 'unlinkDir Gone', 'unlinkDir Gone/a'])
  })

  it('a 200-file burst (a sync pull): 200 `add`s, each path exactly once', async () => {
    await mkdir(at('Burst'))
    const w = await watching()
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(at('Burst', `b${i}.excalidraw`), `{"i":${i}}`)))
    const events = await w.settled()
    expect(shape(events)).toEqual(Array.from({ length: 200 }, (_, i) => `add Burst/b${i}.excalidraw`).sort())
    await rm(at('Burst'), { recursive: true })
  })

  it('dot-entries and node_modules, at any depth, are silent', async () => {
    const w = await watching()
    await writeFile(at('.git', 'index'), 'x')
    await writeFile(at('.yaseendraw', 'favorites.json'), '[]')
    await writeFile(at('.hidden.excalidraw'), 'h2')
    await writeFile(at('node_modules', 'pkg', 'x.excalidraw'), 'x')
    await mkdir(at('alpha', '.cache'), { recursive: true })
    await writeFile(at('alpha', '.cache', 'c.excalidraw'), 'c')
    await mkdir(at('Zeta', 'node_modules', 'deep'), { recursive: true })
    await writeFile(at('Zeta', 'node_modules', 'deep', 'd.excalidraw'), 'd')
    expect(await w.settled()).toEqual([])
    await rm(at('alpha', '.cache'), { recursive: true })
    await rm(at('Zeta', 'node_modules'), { recursive: true })
  })
})

describe('watcher conformance: a watched folder (config and library stores)', () => {
  const folders: Array<{ close: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((f) => f.close()))
  })

  /** A folder watch reporting every `.json` directly inside `dir`, the way `vaultConfig.ts` does. */
  function watchFolder(dir: string, depth?: number) {
    const batches: string[][] = []
    const watched = createWatchedFolder({ dir, depth, tag: 'conformance', relevant: (p, d) => path.dirname(p) === d && p.endsWith('.json'), onChange: (paths) => batches.push([...paths].sort()) })
    folders.push(watched)
    const settled = async () => {
      let seen = -1
      while (seen !== batches.length) {
        seen = batches.length
        await new Promise((r) => setTimeout(r, QUIET_MS))
      }
      return batches
    }
    return { watched, batches, settled }
  }
  /** chokidar has no `ready` for a folder watch; give any engine time to attach. */
  const attached = () => new Promise((r) => setTimeout(r, 300))

  it('an atomic save of a relevant file is ONE notification naming it; its tmp file is silent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-folder-'))
    const f = watchFolder(dir, 0)
    await attached()
    await atomicWrite(path.join(dir, 'media.json'), '{"a":1}')
    expect(await f.settled()).toEqual([[path.join(dir, 'media.json')]])
    await rm(dir, { recursive: true, force: true })
  })

  it('a write this process announced itself (its mtime noted) is not echoed; the next outside write is', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-folder-'))
    const f = watchFolder(dir, 0)
    await attached()
    const file = path.join(dir, 'favorites.json')
    const { mtime } = await atomicWrite(file, '[1]')
    f.watched.noteOwnWrite(file, mtime)
    expect(await f.settled()).toEqual([])
    await new Promise((r) => setTimeout(r, 20))
    await atomicWrite(file, '[1,2]')
    expect(await f.settled()).toEqual([[file]])
    await rm(dir, { recursive: true, force: true })
  })

  it('a folder that does not exist yet is picked up when something OUTSIDE the app creates it and writes into it', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'yaseendraw-folder-'))
    const dir = path.join(parent, '.yaseendraw')
    const f = watchFolder(dir)
    await attached()
    await mkdir(dir)
    await writeFile(path.join(dir, 'github.json'), '{"enabled":true}')
    expect((await f.settled()).flat()).toEqual([path.join(dir, 'github.json')])
    await rm(parent, { recursive: true, force: true })
  })

  it('a folder the app itself creates (noteOwnWrite re-anchors) then hears the next outside write', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'yaseendraw-folder-'))
    const dir = path.join(parent, 'library')
    const f = watchFolder(dir, 0)
    await attached()
    await mkdir(dir)
    const own = path.join(dir, 'media.json')
    f.watched.noteOwnWrite(own, (await atomicWrite(own, '{}')).mtime)
    await f.settled()
    await new Promise((r) => setTimeout(r, 20))
    await atomicWrite(own, '{"b":2}')
    expect((await f.settled()).flat()).toContain(own)
    await rm(parent, { recursive: true, force: true })
  })

  it('setFolder: the old folder goes quiet, the new one is heard', async () => {
    const a = await mkdtemp(path.join(tmpdir(), 'yaseendraw-folder-'))
    const b = await mkdtemp(path.join(tmpdir(), 'yaseendraw-folder-'))
    const f = watchFolder(a, 0)
    await attached()
    f.watched.setFolder(b)
    await attached()
    await writeFile(path.join(a, 'media.json'), '{}')
    await writeFile(path.join(b, 'media.json'), '{}')
    expect(await f.settled()).toEqual([[path.join(b, 'media.json')]])
    await Promise.all([a, b].map((d) => rm(d, { recursive: true, force: true })))
  })
})
