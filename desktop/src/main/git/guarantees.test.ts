import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GithubSyncStatus, WatchEvent } from '@shared/types'
import { git } from './exec'
import { makeBareRemote, makeGitRepo, REAL_GIT_TIMEOUT_MS, requireGit, wireOrigin, type GitRepo } from './gitFixture'
import { createGitSync, type GitSyncHost, type GitSyncManager } from './manager'
import { remoteMoved, syncPass } from './sync'

/**
 * The five guarantees GitHub Sync stands on (YAZ-1081 — Fable-owned, see YAZ-1082 scope 4/4).
 * Implementation issues (YAZ-1085+) must make these pass UNMODIFIED. Guarantee 1 was amended once,
 * on purpose, by YAZ-1897 D3 (Yasin-approved): conflicts are now settled rather than refused, so
 * "lossless" means every byte survives, and the old byte-identical abort is its fallback half:
 *   1. a conflict is LOSSLESS — every byte from both machines survives (merged, or kept as two
 *      copies — YAZ-1897 D1/D3), and a pass that has to stop anyway leaves the working tree
 *      byte-identical, a save made while it was stopped included
 *   2. passes on one root never interleave, and a trigger burst coalesces to ONE follow-up
 *   3. a disabled root produces ZERO git activity, no matter what the watcher sees
 *   4. a machine with no git classifies `attention/no-git` instead of throwing
 *   5. quit flush lands pending edits on the remote before it resolves
 */

/** Every file's bytes under `root`, .git excluded — the lossless comparator. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else out.set(path.relative(root, p), readFileSync(p, 'utf8'))
    }
  }
  walk(root)
  return out
}

/** Polls until `cond` holds — adoption and pass starts are async with no handle to await. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: condition never held')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** Repo `a` pushed to a bare remote, plus an independent second clone at `bDir`. */
async function twoClonesOneRemote(): Promise<{ bin: string; remoteUrl: string; a: GitRepo; bDir: string }> {
  const bin = await requireGit()
  const remote = await makeBareRemote()
  cleanups.push(remote.cleanup)
  const a = await makeGitRepo()
  cleanups.push(a.cleanup)
  await a.write('note.md', 'line one\nline two\n')
  await a.run(['add', '-A'])
  await a.run(['commit', '-m', 'base'])
  await wireOrigin(a, remote)
  await a.run(['push', '-u', 'origin', 'HEAD'])
  const bDir = await mkdtemp(path.join(tmpdir(), 'yaz1081-clone-'))
  cleanups.push(() => rm(bDir, { recursive: true, force: true }))
  const clone = await git(bin, tmpdir(), ['clone', remote.url, bDir])
  expect(clone.code).toBe(0)
  for (const cfg of [['user.name', 'other'], ['user.email', 'other@example.invalid'], ['commit.gpgsign', 'false']]) {
    expect((await git(bin, bDir, ['config', ...cfg])).code).toBe(0)
  }
  return { bin, remoteUrl: remote.url, a, bDir }
}

/** Pushes a same-line edit from the second clone. */
async function pushFromB(bin: string, bDir: string, content: string): Promise<void> {
  await writeFile(path.join(bDir, 'note.md'), content, 'utf8')
  for (const args of [['add', '-A'], ['commit', '-m', 'b change'], ['push']]) {
    expect((await git(bin, bDir, args)).code).toBe(0)
  }
}

describe('guarantee 1: a conflict is lossless', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('keeps both versions of a file both machines changed, and finishes the pass (YAZ-1897 D3)', async () => {
    const { bin, a, bDir } = await twoClonesOneRemote()
    await pushFromB(bin, bDir, 'line one CHANGED ON B\nline two\n')
    await a.write('note.md', 'line one CHANGED ON A\nline two\n')

    const status = await syncPass(a.root)

    expect(status.state).toBe('synced')
    const copy = status.merged?.[0]?.copy ?? ''
    expect(status.merged).toEqual([{ path: 'note.md', author: 'other', clashes: 0, copy: expect.stringMatching(/^note \(conflict, \d{4}-\d{2}-\d{2}\)\.md$/) }])
    const files = snapshot(a.root)
    expect(files.get('note.md')).toBe('line one CHANGED ON B\nline two\n')
    expect(files.get(copy)).toBe('line one CHANGED ON A\nline two\n')
    expect((await git(bin, a.root, ['status'])).stdout).not.toMatch(/rebase in progress/i)
  })

  it('aborts back to a byte-identical working tree when the merge cannot be committed, keeping a save made mid-rebase', async () => {
    const { bin, a, bDir } = await twoClonesOneRemote()
    await pushFromB(bin, bDir, 'line one CHANGED ON B\nline two\n')
    await a.write('note.md', 'line one CHANGED ON A\nline two\n')
    await a.write('other.md', 'saved before\n')
    await a.run(['add', '-A'])
    await a.run(['commit', '-m', 'local work'])
    // A user hook that refuses any commit made while a rebase is stopped — and, standing in for the
    // app's autosave, writes a board exactly then. The merge cannot be committed, so the pass aborts.
    const hook = path.join(a.root, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, `#!/bin/sh\nif [ -d "$(git rev-parse --git-dir)/rebase-merge" ]; then echo "saved mid-rebase" > other.md; exit 1; fi\n`, { mode: 0o755 })
    const before = snapshot(a.root)

    const status = await syncPass(a.root)

    expect(status.state).toBe('attention')
    expect(status.attention).toBe('conflict')
    expect(snapshot(a.root)).toEqual(new Map([...before, ['other.md', 'saved mid-rebase\n']]))
    // A merge that never landed does not move "your version before the merge" (Version history).
    expect((await git(bin, a.root, ['rev-parse', '--verify', '-q', 'refs/yaseendraw/before-merge'])).code).not.toBe(0)
    const st = await git(bin, a.root, ['status'])
    expect(st.stdout).not.toMatch(/rebase in progress/i)
  })
})

describe('guarantee 2: passes serialize and triggers coalesce', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('a burst of syncNow during a running pass yields exactly one follow-up pass', async () => {
    const log: string[] = []
    // `null as …` keeps TS from narrowing to `never`: the only assignment lives in a nested closure.
    let release = null as (() => void) | null
    let active = 0
    const host: GitSyncHost = {
      readConfig: async () => ({ enabled: true }),
      writeConfig: async () => {},
      subscribeVault: () => () => {},
      subscribeConfig: () => () => {},
      onStatus: () => {},
      quietMs: 60 * 60 * 1000, // the debounce must never fire on its own here
      syncPass: async (root) => {
        active += 1
        expect(active).toBe(1) // the serialization guarantee itself
        log.push(root)
        await new Promise<void>((resolve) => {
          release = resolve
        })
        active -= 1
        return { root, state: 'synced' } satisfies GithubSyncStatus
      },
      remoteMoved: async () => true,
    }
    const manager: GitSyncManager = createGitSync(host)
    manager.setOpenRoots(['/tmp/vault'])
    await until(() => log.length === 1) // adoption's initial pass (D3: pull on vault open)
    const settled = Promise.all([manager.syncNow('/tmp/vault'), manager.syncNow('/tmp/vault'), manager.syncNow('/tmp/vault')])
    release?.() // finish the initial pass → the ONE coalesced follow-up starts
    await until(() => log.length === 2)
    release?.() // finish the follow-up
    await settled
    await new Promise((r) => setTimeout(r, 50))
    expect(log).toEqual(['/tmp/vault', '/tmp/vault']) // initial + ONE follow-up, nothing more
  })
})

describe('guarantee 3: a disabled root is completely silent', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('never subscribes the vault watcher and never runs a pass', async () => {
    let vaultSubs = 0
    let passes = 0
    let storm = null as ((ev: WatchEvent) => void) | null
    const host: GitSyncHost = {
      readConfig: async () => ({ enabled: false }),
      writeConfig: async () => {},
      subscribeVault: (_root, listener) => {
        vaultSubs += 1
        storm = listener
        return () => {}
      },
      subscribeConfig: () => () => {},
      onStatus: () => {},
      quietMs: 0,
      syncPass: async (root) => {
        passes += 1
        return { root, state: 'synced' } satisfies GithubSyncStatus
      },
      remoteMoved: async () => true,
    }
    const manager = createGitSync(host)
    manager.setOpenRoots(['/tmp/vault'])
    await new Promise((r) => setTimeout(r, 50)) // give adoption every chance to misbehave
    for (let i = 0; i < 50; i += 1) storm?.({ type: 'change', path: `/tmp/vault/n${i}.md`, mtime: i })
    manager.notifyFocus('/tmp/vault')
    manager.notifyWake()
    await manager.flushForQuit()
    expect(vaultSubs).toBe(0)
    expect(passes).toBe(0)
  })
})

describe('guarantee 4: no git binary is a classification, not a crash', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('reports attention/no-git', async () => {
    const repo = await makeGitRepo()
    cleanups.push(repo.cleanup)
    const status = await syncPass(repo.root, { candidates: [] })
    expect(status.state).toBe('attention')
    expect(status.attention).toBe('no-git')
  })
})

describe('guarantee 5: quit flush lands pending edits', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('commits and pushes before resolving', async () => {
    const { remoteUrl, a } = await twoClonesOneRemote()
    await a.write('note.md', 'line one\nline two\nline three added\n')
    const host: GitSyncHost = {
      readConfig: async () => ({ enabled: true }),
      writeConfig: async () => {},
      subscribeVault: () => () => {},
      subscribeConfig: () => () => {},
      onStatus: () => {},
      quietMs: 60 * 60 * 1000, // the debounce alone would never fire in time
      syncPass,
      remoteMoved,
    }
    const manager = createGitSync(host)
    manager.setOpenRoots([a.root])
    await manager.flushForQuit()
    const tip = await a.run(['ls-remote', remoteUrl, 'HEAD'])
    const local = await a.run(['rev-parse', 'HEAD'])
    expect(tip.split('\t')[0]).toBe(local)
  })
})
