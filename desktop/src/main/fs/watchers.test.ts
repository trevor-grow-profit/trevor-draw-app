import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WatchEvent } from '@shared/types'
import { activeWatcherRoots, subscribe } from './watchers'
import { makeFixture, until } from './testFixture'

let root: string
let cleanup: () => Promise<void>
beforeAll(async () => ({ root, cleanup } = await makeFixture()))
afterAll(() => cleanup())

interface Sub {
  /** Next event (events arrive in order; `ready` is always first). */
  next: () => Promise<WatchEvent>
  close: () => void
}

const open: Sub[] = []
afterEach(async () => {
  open.splice(0).forEach((s) => s.close())
  await until(() => activeWatcherRoots().length === 0)
})

/** Subscribes to `r` and queues its events. */
function openWatch(r: string): Sub {
  const queue: WatchEvent[] = []
  const waiters: Array<(ev: WatchEvent) => void> = []
  const off = subscribe(r, (ev) => {
    const w = waiters.shift()
    if (w) w(ev)
    else queue.push(ev)
  })
  const next = () =>
    new Promise<WatchEvent>((resolve, reject) => {
      const q = queue.shift()
      if (q) return resolve(q)
      const t = setTimeout(() => reject(new Error('timed out waiting for event')), 3000)
      waiters.push((ev) => (clearTimeout(t), resolve(ev)))
    })
  const sub = { next, close: off }
  open.push(sub)
  return sub
}

describe('shared watchers', () => {
  it('emits `ready` first and shares one watcher per root; late joiners get `ready` at once', async () => {
    const a = openWatch(root)
    expect(await a.next()).toEqual({ type: 'ready', root })
    const b = openWatch(root)
    expect(await b.next()).toEqual({ type: 'ready', root })
    expect(activeWatcherRoots()).toEqual([root])
  })

  it('every subscriber gets the same event, with its mtime', async () => {
    const a = openWatch(root)
    const b = openWatch(root)
    await a.next()
    await b.next()
    const file = path.join(root, 'alpha', 'watched.excalidraw')
    await writeFile(file, 'v1')
    const add = await a.next()
    expect(add).toMatchObject({ type: 'add', path: file, mtime: expect.any(Number) })
    expect(await b.next()).toEqual(add)
    await rm(file)
  })

  it('reports every regular file, whatever it is and whether or not the app can show it (YAZ-1577 D1)', async () => {
    const a = openWatch(root)
    await a.next()
    const files = ['JSON', 'PY', 'pdf', 'PNG', 'WEBP', 'epub', 'svg', 'base'].map((ext) => path.join(root, 'alpha', `watched.${ext}`))
    await Promise.all(files.map((f) => writeFile(f, 'x')))
    const seen = await Promise.all(files.map(() => a.next()))
    expect(seen.map((ev) => `${ev.type} ${'path' in ev ? ev.path : ''}`).sort()).toEqual(files.map((f) => `add ${f}`).sort())
    await Promise.all(files.map((f) => rm(f)))
  })

  it('closes the watcher only when the last subscriber leaves', async () => {
    const a = openWatch(root)
    const b = openWatch(root)
    await a.next()
    await b.next()
    a.close()
    await new Promise((r) => setTimeout(r, 100))
    expect(activeWatcherRoots()).toEqual([root])
    b.close()
    await until(() => activeWatcherRoots().length === 0)
  })
})
