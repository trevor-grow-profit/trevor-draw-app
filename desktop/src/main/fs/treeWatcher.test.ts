import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { WatchListener, WatchOptionsWithStringEncoding } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isNetworkMount, watchTree, type TreeWatcher } from './treeWatcher'
import { settled, sleep, until } from './testFixture'

/**
 * The engine's own rules (YAZ-2073 5F). What consumers see through it is pinned by
 * `watchConformance.test.ts`; this file holds what only the engine knows about: depth, a folder
 * that is not there yet, the watched folder itself going and coming back, tmp files that linger,
 * reading `mount`, and the polling fallback.
 */
/**
 * `fail`: every `fs.watch` throws, as on a platform without it; `refuse`: only a watch of that one
 * path does (EACCES). `lateStream`: FSEvents as libuv serves it on macOS (YAZ-2073 5F1) — opening a
 * watch leaves the process's one stream, and so every watch, deaf until it is rebuilt
 * `LATE_STREAM_MS` later; `deafUntil` is when.
 */
const nativeWatch = vi.hoisted(() => ({ fail: false, refuse: null as string | null, lateStream: false, deafUntil: 0 }))
const LATE_STREAM_MS = 300
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const watch = ((p: string, opts?: WatchOptionsWithStringEncoding | WatchListener<string>, listener?: WatchListener<string>) => {
    if (nativeWatch.fail) throw Object.assign(new Error('not here'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    if (p === nativeWatch.refuse) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    if (!nativeWatch.lateStream) return fs.watch(p, opts as WatchOptionsWithStringEncoding, listener)
    nativeWatch.deafUntil = Date.now() + LATE_STREAM_MS
    const w = fs.watch(p, typeof opts === 'function' ? {} : opts)
    const emit = w.emit.bind(w)
    w.emit = (event: string, ...args: unknown[]) => (event === 'change' && Date.now() < nativeWatch.deafUntil ? false : emit(event, ...args))
    const heard = typeof opts === 'function' ? opts : listener
    if (heard !== undefined) w.on('change', heard)
    return w
  }) as typeof fs.watch
  return { ...fs, default: { ...fs, watch }, watch }
})

/** Every `/sbin/mount` the engine runs, counted and passed through. */
const mountReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const cp = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((...args: Parameters<typeof cp.execFile>) => {
    if (args[0] === '/sbin/mount') mountReads.count++
    return cp.execFile(...args)
  }) as typeof cp.execFile
  return { ...cp, default: { ...cp, execFile }, execFile }
})

const dirs: string[] = []
const watchers: TreeWatcher[] = []
afterEach(async () => {
  vi.useRealTimers()
  nativeWatch.fail = false
  nativeWatch.refuse = null
  nativeWatch.lateStream = false
  await Promise.all(watchers.splice(0).map((w) => w.close()))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'yaseendraw-engine-'))
  dirs.push(d)
  return d
}

/**
 * A script for `node -e … <dir>`: watches 4 000 folders in `<dir>`, says so on stdout, then rebuilds
 * its FSEvents stream over and over, so `fseventsd` is always busy registering 4 000 paths.
 */
const CROWDED_FSEVENTSD = `
const fs = require('node:fs'), path = require('node:path'), dir = process.argv[1]
for (let i = 0; i < 4000; i++) { fs.mkdirSync(path.join(dir, String(i))); fs.watch(path.join(dir, String(i)), () => {}) }
process.stdout.write('crowded')
setInterval(() => fs.watch(dir).close(), 0)`

/** Starts a watch on `dir` and records `type rel` lines; `ready` resolves once it is live. */
function record(dir: string, opts: Parameters<typeof watchTree>[1] = {}) {
  const lines: string[] = []
  let ready = false
  const w = watchTree(dir, opts)
  watchers.push(w)
  const note = (type: string) => (p: string) => lines.push(`${type} ${path.relative(dir, p)}`)
  w.on('add', note('add')).on('change', note('change')).on('unlink', note('unlink')).on('addDir', note('addDir')).on('unlinkDir', note('unlinkDir'))
  w.on('ready', () => (ready = true))
  const quiet = () => settled(() => lines.length, 500).then(() => [...lines].sort())
  return { lines, ready: () => until(() => ready, 10_000), quiet, watcher: w }
}

describe('treeWatcher', { timeout: 20_000 }, () => {
  it("depth 0 announces the folder's own entries and nothing deeper", async () => {
    const dir = await tempDir()
    await mkdir(path.join(dir, 'sub'))
    const r = record(dir, { depth: 0 })
    await r.ready()
    await writeFile(path.join(dir, 'top.json'), '{}')
    await writeFile(path.join(dir, 'sub', 'deep.json'), '{}')
    await mkdir(path.join(dir, 'new'))
    expect(await r.quiet()).toEqual(['add top.json', 'addDir new'])
  })

  it('a folder several levels from existing is waited for, and what it holds arrives when it does', async () => {
    const parent = await tempDir()
    const dir = path.join(parent, 'a', 'b', 'library')
    const r = record(dir)
    await r.ready()
    await mkdir(path.join(parent, 'a'))
    await sleep(200)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'media.json'), '{}')
    expect(await r.quiet()).toEqual(['add media.json'])
  })

  it('the watched folder itself going takes everything with it; coming back brings its contents', async () => {
    const parent = await tempDir()
    const dir = path.join(parent, 'vault')
    await mkdir(path.join(dir, 'sub'), { recursive: true })
    await writeFile(path.join(dir, 'sub', 'x.excalidraw'), 'x')
    await sleep(300)
    const r = record(dir)
    await r.ready()
    await rename(dir, path.join(parent, 'elsewhere'))
    expect(await r.quiet()).toEqual(['unlink sub/x.excalidraw', 'unlinkDir sub'])
    r.lines.length = 0
    await mkdir(dir)
    await writeFile(path.join(dir, 'back.excalidraw'), 'b')
    expect(await r.quiet()).toEqual(['add back.excalidraw'])
  })

  it('an atomicWrite tmp file is silent even when it lingers past the settle window', async () => {
    const dir = await tempDir()
    const r = record(dir)
    await r.ready()
    const tmp = path.join(dir, 'big.excalidraw.tmp-0123456789ab')
    await writeFile(tmp, 'a large save, still being written')
    await sleep(400)
    await rename(tmp, path.join(dir, 'big.excalidraw'))
    expect(await r.quiet()).toEqual(['add big.excalidraw'])
  })

  it.runIf(process.platform === 'darwin')('`ready` comes once the stream hears: the first write after it is never missed (YAZ-2073 5F1)', async () => {
    nativeWatch.lateStream = true
    const dir = await tempDir()
    const r = record(dir)
    await r.ready()
    await writeFile(path.join(dir, 'first.json'), '{}')
    expect(await r.quiet()).toEqual(['add first.json'])
  })

  it.runIf(process.platform === 'darwin')('an awaited folder that appears before the stream hears is still found, and watched (YAZ-2073 5F1)', async () => {
    nativeWatch.lateStream = true
    const dir = path.join(await tempDir(), 'library')
    const r = record(dir)
    await sleep(100) // the parent is watched by now, and the stream still deaf (`LATE_STREAM_MS`)
    await mkdir(dir)
    await writeFile(path.join(dir, 'media.json'), '{}')
    await r.ready()
    await writeFile(path.join(dir, 'media.json'), '{"items":[]}')
    await until(() => r.lines.length > 0)
    expect(await r.quiet()).toEqual(['change media.json'])
  })

  // The same against the real FSEvents, made to happen every time. Opt-in (`FSEVENTS_STRESS=1`):
  // the crowded `fseventsd` it needs slows every other watch on the machine, parallel tests included.
  it.runIf(process.platform === 'darwin' && process.env.FSEVENTS_STRESS === '1')('a watch reopened the moment the last one closed hears the first write after `ready`, however busy `fseventsd` is (YAZ-2073 5F1)', async () => {
    const dir = await tempDir()
    // `fs.watch` returns before macOS starts the stream that hears it. A busy `fseventsd` (a sync
    // client, a build, a full test run) makes that start late; `CROWDED_FSEVENTSD` makes it
    // tens of ms late every time, well past the few ms `ready` takes.
    const crowd = spawn(process.execPath, ['-e', CROWDED_FSEVENTSD, await tempDir()], { stdio: ['ignore', 'pipe', 'inherit'] })
    const missed: number[] = []
    try {
      await once(crowd.stdout, 'data')
      for (let i = 0; i < 5; i++) {
        const r = record(dir)
        await r.ready()
        const file = path.join(dir, `f${i}.json`)
        await writeFile(file, '{}')
        await until(() => r.lines.length > 0, 1000).catch(() => missed.push(i))
        // Closed with the delete still in flight, and the next watch opened at once: the reopen `setFolder` does.
        await rm(file)
        await r.watcher.close()
      }
    } finally {
      crowd.kill()
      await once(crowd, 'exit')
    }
    expect(missed).toEqual([])
  })

  it('close() ends every event, pending ones included', async () => {
    const dir = await tempDir()
    const r = record(dir)
    await r.ready()
    await writeFile(path.join(dir, 'late.json'), '{}')
    await r.watcher.close()
    await sleep(400)
    expect(r.lines).toEqual([])
  })

  it('a folder that arrives but cannot be watched falls back to polling: what it holds still arrives, nothing throws', async () => {
    const parent = await tempDir()
    const dir = path.join(parent, 'library')
    nativeWatch.refuse = dir
    const r = record(dir)
    await r.ready()
    await mkdir(dir)
    await writeFile(path.join(dir, 'media.json'), '{}')
    await until(() => r.lines.length > 0, 10_000)
    expect(await r.quiet()).toEqual(['add media.json'])
    await writeFile(path.join(dir, 'later.json'), '{}')
    await until(() => r.lines.length > 1, 10_000)
    expect(r.lines).toEqual(['add media.json', 'add later.json'])
  })

  it('falls back to chokidar polling when fs.watch cannot serve, and still announces', async () => {
    nativeWatch.fail = true
    const dir = await tempDir()
    const r = record(dir)
    await r.ready()
    await writeFile(path.join(dir, 'polled.json'), '{}')
    await until(() => r.lines.length > 0, 10_000)
    expect(r.lines).toEqual(['add polled.json'])
  })
})

describe('reading `mount` (YAZ-2073 5F1)', () => {
  it.runIf(process.platform === 'darwin')('watches started together read the table once; one started after 5 s reads it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000) // past whatever an earlier test read
    const dir = await tempDir()
    mountReads.count = 0
    await Promise.all([record(dir), record(dir), record(dir)].map((r) => r.ready()))
    expect(mountReads.count).toBe(1)
    vi.setSystemTime(Date.now() + 4000)
    await record(dir).ready()
    expect(mountReads.count).toBe(1)
    vi.setSystemTime(Date.now() + 1001)
    await record(dir).ready()
    expect(mountReads.count).toBe(2)
  })
})

describe('isNetworkMount (macOS `mount`)', () => {
  const TABLE = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)',
    '//yasin@nas._smb._tcp.local/Boards on /Volumes/Boards (smbfs, nodev, nosuid, mounted by yasin)',
    'nas:/export/vaults on /Volumes/NFS Vaults (nfs, nodev, nosuid, mounted by yasin)',
    '/dev/disk5s1 on /Volumes/USB Stick (exfat, local, nodev, nosuid, noowners, mounted by yasin)',
  ].join('\n')

  it('a share (SMB, NFS) is network; the system volume and a USB stick are local; the longest mount point decides', () => {
    expect(isNetworkMount(TABLE, '/Volumes/Boards/Team vault')).toBe(true)
    expect(isNetworkMount(TABLE, '/Volumes/NFS Vaults/mine')).toBe(true)
    expect(isNetworkMount(TABLE, '/Volumes/USB Stick/vault')).toBe(false)
    expect(isNetworkMount(TABLE, '/System/Volumes/Data/Users/yasin/vault')).toBe(false)
    expect(isNetworkMount(TABLE, '/Volumes/BoardsNot/vault')).toBe(false)
  })

  it('an unreadable table is local — the native watcher is the default', () => {
    expect(isNetworkMount('', '/Volumes/Boards')).toBe(false)
  })
})
