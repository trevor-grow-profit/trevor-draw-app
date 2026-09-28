import { describe, expect, it } from 'vitest'
import type { GithubSyncStatus, VaultConfigChange, WatchEvent } from '@shared/types'
import { createGitSync, GITHUB_SYNC_FILE, type GitSyncHost } from './manager'

/**
 * The state machine on a FAKE host: no git, no filesystem, no window. Every timing here is real
 * (`setTimeout`, tiny intervals) rather than faked — the manager's whole job is interleaving
 * timers with in-flight promises, and vitest's fake timers cannot advance a chain that is waiting
 * on a real `await` without the test having to drive both by hand, which is how a test ends up
 * proving the driver works instead of the code.
 *
 * `guarantees.test.ts` pins serialisation, silence-when-disabled and the quit flush; this file
 * covers the cadence around them.
 */

const ROOT = '/tmp/vault-a'

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: condition never held')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

interface Harness {
  host: GitSyncHost
  /** One entry per pass, in order. */
  passes: string[]
  /** One entry per idle pull's cheap look (`remoteMoved`, YAZ-2073 5H), in order. */
  looks: string[]
  /** Roots whose pass carried `flush: true` (the quit variant, YAZ-1111). */
  flushes: string[]
  statuses: GithubSyncStatus[]
  writes: Array<{ root: string; name: string; value: unknown }>
  /** What `readConfig` will answer for a root — tests flip this to simulate an external edit. */
  enabled: Map<string, boolean>
  vaultSubs: () => number
  emitVault: (root: string, ev: WatchEvent) => void
  emitConfig: (root: string, name: string) => void
}

interface HarnessOpts {
  /** Deliberately long defaults: each test opts INTO the clock it is about, so nothing else fires. */
  quietMs?: number
  retryMs?: number
  focusCooldownMs?: number
  pollMs?: number
  /** `n` is the 1-based pass count for that root. */
  pass?: (root: string, n: number) => Promise<GithubSyncStatus>
  /** What an idle pull's look answers; by default the remote always moved, so every poll is a full pass. */
  moved?: (root: string) => Promise<boolean>
  inspect?: (root: string) => Promise<GithubSyncStatus>
}

const NEVER = 60 * 60 * 1000

function harness(opts: HarnessOpts = {}): Harness {
  const passes: string[] = []
  const looks: string[] = []
  /** Roots whose pass was requested with `flush: true` (the quit variant, YAZ-1111). */
  const flushes: string[] = []
  const statuses: GithubSyncStatus[] = []
  const writes: Array<{ root: string; name: string; value: unknown }> = []
  const enabled = new Map<string, boolean>()
  const vaultListeners = new Map<string, Set<(ev: WatchEvent) => void>>()
  const configListeners = new Map<string, Set<(change: VaultConfigChange) => void>>()
  let vaultSubs = 0

  const listen = <T>(map: Map<string, Set<T>>, root: string, listener: T): (() => void) => {
    const set = map.get(root) ?? new Set<T>()
    set.add(listener)
    map.set(root, set)
    return () => set.delete(listener)
  }

  const host: GitSyncHost = {
    readConfig: async (root, name) => (name === GITHUB_SYNC_FILE ? { enabled: enabled.get(root) === true } : null),
    writeConfig: async (root, name, value) => {
      writes.push({ root, name, value })
      if (isRecord(value)) enabled.set(root, value.enabled === true)
    },
    subscribeVault: (root, listener) => {
      vaultSubs += 1
      return listen(vaultListeners, root, listener)
    },
    subscribeConfig: (root, listener) => listen(configListeners, root, listener),
    onStatus: (status) => {
      statuses.push(status)
    },
    syncPass: async (root, passOpts) => {
      passes.push(root)
      if (passOpts?.flush === true) flushes.push(root)
      const n = passes.filter((p) => p === root).length
      return opts.pass === undefined ? { root, state: 'synced' } : await opts.pass(root, n)
    },
    remoteMoved: async (root) => {
      looks.push(root)
      return opts.moved === undefined ? true : await opts.moved(root)
    },
    quietMs: opts.quietMs ?? NEVER,
    retryMs: opts.retryMs ?? NEVER,
    focusCooldownMs: opts.focusCooldownMs ?? NEVER,
    pollMs: opts.pollMs ?? NEVER,
  }
  if (opts.inspect !== undefined) host.inspect = opts.inspect

  return {
    host,
    passes,
    looks,
    flushes,
    statuses,
    writes,
    enabled,
    vaultSubs: () => vaultSubs,
    emitVault: (root, ev) => {
      for (const l of [...(vaultListeners.get(root) ?? [])]) l(ev)
    },
    emitConfig: (root, name) => {
      for (const l of [...(configListeners.get(root) ?? [])]) l({ root, name })
    },
  }
}

const change = (name: string, mtime: number): WatchEvent => ({ type: 'change', path: `${ROOT}/${name}`, mtime })

describe('vault edits (D2 cadence)', () => {
  it('marks pending once for a burst and runs exactly one pass after the quiet period', async () => {
    const h = harness({ quietMs: 30 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.statuses.at(-1)?.state === 'synced') // adoption's pull (D3)
    expect(h.passes).toEqual([ROOT])

    h.emitVault(ROOT, change('a.md', 1))
    h.emitVault(ROOT, change('b.md', 2))
    h.emitVault(ROOT, { type: 'add', path: `${ROOT}/c.md`, mtime: 3 })
    // The UI hears about unsynced work immediately, and only once for the burst.
    expect(h.statuses.filter((s) => s.state === 'pending')).toHaveLength(1)
    expect(h.passes).toEqual([ROOT])

    await until(() => h.passes.length === 2)
    await sleep(120)
    expect(h.passes).toEqual([ROOT, ROOT])
  })

  it('ignores watcher lifecycle events', async () => {
    const h = harness({ quietMs: 20 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)

    h.emitVault(ROOT, { type: 'ready', root: ROOT })
    h.emitVault(ROOT, { type: 'error', message: 'watcher fell over' })
    await sleep(120)
    expect(h.passes).toEqual([ROOT])
  })

  it('coalesces edits made during a running pass into one follow-up', async () => {
    let release: (() => void) | undefined
    const h = harness({
      quietMs: 5,
      pass: async (root, n) => {
        if (n === 1) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { root, state: 'synced' }
      },
    })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)

    for (let i = 0; i < 20; i += 1) h.emitVault(ROOT, change(`n${i}.md`, i))
    await sleep(60) // the debounce fires while pass 1 is still blocked
    expect(h.passes).toHaveLength(1)

    release?.()
    await until(() => h.passes.length === 2)
    await sleep(120)
    expect(h.passes).toEqual([ROOT, ROOT])
  })
})

describe('offline retry', () => {
  it('arms one retry after a pending pass and settles once it succeeds', async () => {
    const h = harness({
      retryMs: 25,
      pass: async (root, n) => (n === 1 ? { root, state: 'pending', message: 'no network' } : { root, state: 'synced' }),
    })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])

    await until(() => h.statuses.at(-1)?.state === 'synced')
    expect(h.passes).toEqual([ROOT, ROOT])
    expect(await manager.status(ROOT)).toEqual({ root: ROOT, state: 'synced', enabled: true })

    // A success does not re-arm: exactly one retry timer ever existed.
    await sleep(120)
    expect(h.passes).toHaveLength(2)
  })
})

describe('github.json drives adoption', () => {
  it('adopts on a config change to enabled and drops on a change back to off', async () => {
    const h = harness()
    h.enabled.set(ROOT, false)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await sleep(40)
    expect(h.passes).toEqual([])
    expect(h.vaultSubs()).toBe(0)

    // Another machine pushed a `github.json` with sync on, and the dotfolder watcher saw it.
    h.enabled.set(ROOT, true)
    h.emitConfig(ROOT, GITHUB_SYNC_FILE)
    await until(() => h.passes.length === 1)
    expect(h.vaultSubs()).toBe(1)

    h.enabled.set(ROOT, false)
    h.emitConfig(ROOT, GITHUB_SYNC_FILE)
    await until(() => h.statuses.at(-1)?.state === 'off')
    h.emitVault(ROOT, change('a.md', 1)) // the watcher is gone; this reaches nobody
    await sleep(60)
    expect(h.passes).toHaveLength(1)
    expect(await manager.status(ROOT)).toEqual({ root: ROOT, state: 'off', enabled: false })
  })

  it('ignores changes to other config files', async () => {
    const h = harness()
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)

    h.enabled.set(ROOT, false)
    h.emitConfig(ROOT, 'favorites.json')
    await sleep(60)
    expect(await manager.status(ROOT)).toEqual({ root: ROOT, state: 'synced', enabled: true })
  })

  it('drops a root that is no longer open', async () => {
    const h = harness({ quietMs: 5 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)

    manager.setOpenRoots([])
    h.emitVault(ROOT, change('a.md', 1))
    await sleep(60)
    expect(h.passes).toHaveLength(1)
    expect(await manager.status(ROOT)).toEqual({ root: ROOT, state: 'off', enabled: false })
  })
})

describe('focus and wake (D3)', () => {
  it('suppresses a pull inside the cooldown', async () => {
    const h = harness({ focusCooldownMs: NEVER })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.statuses.at(-1)?.state === 'synced')

    manager.notifyFocus(ROOT)
    manager.notifyWake()
    await sleep(60)
    expect(h.passes).toEqual([ROOT])
  })

  it('pulls once the cooldown has passed', async () => {
    const h = harness({ focusCooldownMs: 0 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.statuses.at(-1)?.state === 'synced')

    manager.notifyFocus(ROOT)
    await until(() => h.passes.length === 2)
    manager.notifyWake()
    await until(() => h.passes.length === 3)
  })

  it('does nothing for an unmanaged root', async () => {
    const h = harness({ focusCooldownMs: 0 })
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT]) // disabled by default
    await sleep(40)
    manager.notifyFocus(ROOT)
    manager.notifyWake()
    await sleep(40)
    expect(h.passes).toEqual([])
  })
})

describe('setEnabled', () => {
  it('writes the switch and answers with the first pass’s real result', async () => {
    const h = harness({ pass: async (root) => ({ root, state: 'attention', attention: 'auth', message: 'sign in again' }) })
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await sleep(40)
    expect(h.passes).toEqual([])

    const status = await manager.setEnabled(ROOT, true)

    expect(h.writes).toEqual([{ root: ROOT, name: GITHUB_SYNC_FILE, value: { enabled: true } }])
    expect(status).toEqual({ root: ROOT, state: 'attention', attention: 'auth', message: 'sign in again', enabled: true })
    expect(h.passes).toEqual([ROOT])

    // The dotfolder watcher's echo of our own write must not adopt a second time.
    h.emitConfig(ROOT, GITHUB_SYNC_FILE)
    await sleep(40)
    expect(h.passes).toEqual([ROOT])
    expect(h.vaultSubs()).toBe(1)
  })

  it('turning it off writes false, drops the root and broadcasts off', async () => {
    const h = harness()
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.statuses.at(-1)?.state === 'synced')

    const off = await manager.setEnabled(ROOT, false)

    expect(off).toEqual({ root: ROOT, state: 'off', enabled: false })
    expect(h.statuses.at(-1)).toEqual({ root: ROOT, state: 'off', enabled: false })
    expect(h.writes.at(-1)).toEqual({ root: ROOT, name: GITHUB_SYNC_FILE, value: { enabled: false } })
    await sleep(40)
    expect(h.passes).toEqual([ROOT])
  })
})

describe('status of an unmanaged root', () => {
  it('is off when the host cannot inspect', async () => {
    const manager = createGitSync(harness().host)
    expect(await manager.status('/tmp/never-opened')).toEqual({ root: '/tmp/never-opened', state: 'off', enabled: false })
  })

  it('defers to the host’s read-only inspection when there is one', async () => {
    const repo = { remoteUrl: 'git@github.com:yaseen/docs.git', branch: 'main' }
    const manager = createGitSync(harness({ inspect: async (root) => ({ root, state: 'off', repo }) }).host)
    expect(await manager.status(ROOT)).toEqual({ root: ROOT, state: 'off', repo, enabled: false })
  })

  it('falls back to off when inspection throws', async () => {
    const manager = createGitSync(
      harness({
        inspect: async () => {
          throw new Error('disk went away')
        },
      }).host,
    )
    expect(await manager.status(ROOT)).toEqual({ root: ROOT, state: 'off', enabled: false })
  })
})

describe('flushForQuit', () => {
  it('cancels a waiting debounce and lands one last pass', async () => {
    const h = harness({ quietMs: NEVER })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)
    h.emitVault(ROOT, change('a.md', 1))

    await manager.flushForQuit()

    expect(h.passes).toEqual([ROOT, ROOT])
    // YAZ-1111: the adoption pass is a normal one; only the quit pass is the flush variant.
    expect(h.flushes).toEqual([ROOT])
    await sleep(60)
    expect(h.passes).toHaveLength(2)
  })
})

describe('files held back as too large (YAZ-1801 D3)', () => {
  it('carries the held-back list through pending and syncing, arms no retry, and a later clean pass clears it', async () => {
    const h = harness({
      quietMs: 10,
      retryMs: 10,
      pass: async (root, n) => (n === 1 ? { root, state: 'attention', attention: 'too-large', tooLarge: ['Huge.excalidraw'] } : { root, state: 'synced' }),
    })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.statuses.at(-1)?.attention === 'too-large')
    // Not `pending`, so no retry clock: nothing loops while the file stays too big.
    await sleep(80)
    expect(h.passes).toEqual([ROOT])

    h.emitVault(ROOT, change('a.md', 1))
    await until(() => h.statuses.at(-1)?.state === 'synced')
    const transitional = h.statuses.filter((s) => s.state === 'pending' || s.state === 'syncing').slice(-2)
    expect(transitional.map((s) => s.tooLarge)).toEqual([['Huge.excalidraw'], ['Huge.excalidraw']])
    expect(h.statuses.at(-1)?.tooLarge).toBeUndefined()
  })
})

describe('idle pull (YAZ-1897 D6)', () => {
  it('pulls again after `pollMs` while synced, without a `syncing` flash or a repeat broadcast', async () => {
    const h = harness({ pollMs: 20 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length >= 3)
    const afterAdoption = h.statuses.findIndex((s) => s.state === 'synced') + 1
    expect(h.statuses.slice(afterAdoption)).toEqual([]) // quiet: nothing new, nothing said
    manager.setOpenRoots([])
  })

  it('broadcasts a quiet pull that brought news, and never keeps `merged` as the root\'s last status', async () => {
    const merged = [{ path: 'b.excalidraw', author: 'Sam', clashes: 0 }]
    const h = harness({ pollMs: 20, pass: async (root, n) => (n === 2 ? { root, state: 'synced', merged } : { root, state: 'synced' }) })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.statuses.some((s) => s.merged !== undefined))
    expect(h.statuses.map((s) => s.state)).toEqual(['syncing', 'synced', 'synced']) // no `syncing` before the pull
    expect((await manager.status(ROOT)).merged).toBeUndefined()
    manager.setOpenRoots([])
  })

  it('never pulls while pending or in attention', async () => {
    for (const state of ['pending', 'attention'] as const) {
      const h = harness({ pollMs: 10, pass: async (root) => ({ root, state }) })
      h.enabled.set(ROOT, true)
      const manager = createGitSync(h.host)
      manager.setOpenRoots([ROOT])
      await until(() => h.passes.length === 1)
      await sleep(60)
      expect(h.passes).toHaveLength(1)
      manager.setOpenRoots([])
    }
  })

  it('stands down while edits settle, and the edit pass re-arms it', async () => {
    const h = harness({ pollMs: 40, quietMs: 80 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)
    h.emitVault(ROOT, change('a.md', 1))
    await sleep(60) // the poll would have fired by now; the edit cancelled it
    expect(h.passes).toHaveLength(1)
    await until(() => h.passes.length === 2) // the debounce's pass
    await until(() => h.passes.length === 3) // …and the poll it re-armed
    manager.setOpenRoots([])
  })

  it('a look that finds both sides level runs NO pass and says nothing, then looks again (YAZ-2073 5H)', async () => {
    const h = harness({ pollMs: 15, moved: async () => false })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.looks.length >= 3)
    expect(h.passes).toEqual([ROOT]) // adoption's pass only
    expect(h.statuses.map((s) => s.state)).toEqual(['syncing', 'synced'])
    expect((await manager.status(ROOT)).state).toBe('synced')
    manager.setOpenRoots([])
  })

  it('a look that finds the remote moved (or could not tell) escalates to a full pass', async () => {
    let moved = false
    const h = harness({ pollMs: 15, moved: async () => moved })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.looks.length >= 1)
    expect(h.passes).toHaveLength(1)
    moved = true
    await until(() => h.passes.length === 2)
    expect(h.flushes).toEqual([])
    expect(h.statuses.filter((s) => s.state === 'syncing')).toHaveLength(1) // still quiet: no flash for the pull
    manager.setOpenRoots([])
  })

  it('only the idle pull looks first: adoption, edits and syncNow run the full pass straight away', async () => {
    const h = harness({ quietMs: 10, moved: async () => false })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)
    h.emitVault(ROOT, change('a.md', 1))
    await until(() => h.passes.length === 2)
    await manager.syncNow(ROOT)
    expect(h.passes).toHaveLength(3)
    expect(h.looks).toEqual([])
    manager.setOpenRoots([])
  })

  it('goes silent when the vault closes', async () => {
    const h = harness({ pollMs: 10 })
    h.enabled.set(ROOT, true)
    const manager = createGitSync(h.host)
    manager.setOpenRoots([ROOT])
    await until(() => h.passes.length === 1)
    manager.setOpenRoots([])
    await sleep(50)
    expect(h.passes).toHaveLength(1)
  })
})
