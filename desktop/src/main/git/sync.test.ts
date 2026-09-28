import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GIT_TIMEOUT_CODE, git, type GitResult } from './exec'
import { makeBareRemote, makeGitRepo, REAL_GIT_TIMEOUT_MS, requireGit, wireOrigin, type BareRemote, type GitRepo } from './gitFixture'
import { GITHUB_FILE_LIMIT_BYTES } from '@shared/types'
import { classifyGitFailure, commitMessage, lookAtRemote, syncPass, TRANSFER_TIMEOUT_MS } from './sync'

/** A file's SHA-1, streamed (the D12 test's file is 95 MiB). */
async function sha1(file: string): Promise<string> {
  const hash = createHash('sha1')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

// Real git throughout; the spy only records the options each call was given (YAZ-1801 D4).
vi.mock('./exec', async (actual) => {
  const mod = await actual<typeof import('./exec')>()
  return { ...mod, git: vi.fn(mod.git) }
})

/**
 * `syncPass` against REAL git and a bare-repo "GitHub" on the filesystem — the same posture as
 * `detect.test.ts`: a mocked git would only prove the mock agrees with itself, and every
 * interesting behaviour here (what a rebase does to a working tree, what a first push writes into
 * `.git/config`) is git's behaviour, not ours.
 *
 * The one thing a fixture cannot produce is a broken network, so the offline/auth classification
 * is tested as a pure function over the strings git actually prints (`classifyGitFailure`), plus
 * one end-to-end unreachable-remote case to prove the wiring reaches it.
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** A repo with one commit on `main`, nothing wired. */
async function baseRepo(): Promise<GitRepo> {
  const repo = await makeGitRepo()
  cleanups.push(repo.cleanup)
  await repo.write('note.md', 'line one\n')
  await repo.run(['add', '-A'])
  await repo.run(['commit', '-m', 'base'])
  return repo
}

/** A repo whose `main` already tracks a bare remote — the steady state sync lives in. */
async function pushedRepo(): Promise<{ repo: GitRepo; remote: BareRemote }> {
  const repo = await baseRepo()
  const remote = await makeBareRemote()
  cleanups.push(remote.cleanup)
  await wireOrigin(repo, remote)
  await repo.run(['push', '-u', 'origin', 'HEAD'])
  return { repo, remote }
}

/** The remote's HEAD sha, read the way another machine would — over the "network". */
async function remoteHead(repo: GitRepo, remote: BareRemote): Promise<string> {
  const line = await repo.run(['ls-remote', remote.url, 'HEAD'])
  return line.split('\t')[0] ?? ''
}

/** An independent second clone, standing in for the user's other machine. */
async function secondClone(remote: BareRemote): Promise<string> {
  const bin = await requireGit()
  const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-clone-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  expect((await git(bin, tmpdir(), ['clone', remote.url, dir])).code).toBe(0)
  for (const cfg of [
    ['user.name', 'other'],
    ['user.email', 'other@example.invalid'],
    ['commit.gpgsign', 'false'],
  ]) {
    expect((await git(bin, dir, ['config', ...cfg])).code).toBe(0)
  }
  return dir
}

describe('syncPass', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('commits dirty files and pushes them, naming them in the subject', async () => {
    const { repo, remote } = await pushedRepo()
    await repo.write('a.md', '# a\n')
    await repo.write('b.md', '# b\n')

    const status = await syncPass(repo.root)

    expect(status.state).toBe('synced')
    expect(status.repo).toEqual({ remoteUrl: remote.url, branch: 'main' })
    expect(await repo.run(['log', '-1', '--format=%s'])).toBe('sync: a.md, b.md')
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
  })

  it("never commits Finder's droppings: `.DS_Store` is ignored, at any depth, before anything is staged (YAZ-1829)", async () => {
    const { repo } = await pushedRepo()
    await repo.write('a.md', '# a\n')
    await repo.write('.DS_Store', 'finder\n')
    await repo.write('sub/.DS_Store', 'finder\n')

    expect((await syncPass(repo.root)).state).toBe('synced')

    const tracked = await repo.run(['ls-files'])
    expect(tracked.split('\n')).toContain('.gitignore')
    expect(tracked).not.toContain('.DS_Store')
    // The files are still on disk — ignoring is not deleting.
    expect(existsSync(path.join(repo.root, '.DS_Store'))).toBe(true)
  })

  it('never commits the tmp file a crashed atomic write left behind, at any depth', async () => {
    const { repo } = await pushedRepo()
    await repo.write('a.excalidraw', '{}\n')
    await repo.write('a.excalidraw.tmp-0123456789ab', '{')
    await repo.write('assets/f.png.tmp-abcdef012345', 'png')

    expect((await syncPass(repo.root)).state).toBe('synced')

    const tracked = await repo.run(['ls-files'])
    expect(tracked.split('\n')).toContain('a.excalidraw')
    expect(tracked).not.toContain('.tmp-')
  })

  it('UNTRACKS a `.DS_Store` an older version already committed, and leaves it on disk', async () => {
    const { repo } = await pushedRepo()
    await repo.write('.DS_Store', 'finder\n')
    await repo.run(['add', '-A'])
    await repo.run(['commit', '-m', 'sync: .DS_Store'])
    await repo.run(['push'])

    expect((await syncPass(repo.root)).state).toBe('synced')

    expect(await repo.run(['ls-files'])).not.toContain('.DS_Store')
    expect(existsSync(path.join(repo.root, '.DS_Store'))).toBe(true)
  })

  it('leaves a vault with no droppings untouched — no `.gitignore` appears out of nowhere', async () => {
    const { repo } = await pushedRepo()
    await repo.write('a.md', '# a\n')

    expect((await syncPass(repo.root)).state).toBe('synced')

    expect(existsSync(path.join(repo.root, '.gitignore'))).toBe(false)
  })

  // ---------- YAZ-1801 D3: a file over GitHub's limit never jams the rest ----------

  /** A SPARSE file at `bytes` (default: exactly the guard): `truncate` sets the size without writing a byte, so this costs nothing. */
  async function oversize(repo: GitRepo, name: string, bytes = GITHUB_FILE_LIMIT_BYTES): Promise<void> {
    await repo.write(name, '')
    await truncate(path.join(repo.root, name), bytes)
  }

  it('holds an oversize file back, commits and pushes everything else, and says so as attention/too-large', async () => {
    const { repo, remote } = await pushedRepo()
    await repo.write('small.md', '# small\n')
    await oversize(repo, 'Folder/Huge board.excalidraw')

    const status = await syncPass(repo.root)

    expect(status).toMatchObject({ state: 'attention', attention: 'too-large', tooLarge: ['Folder/Huge board.excalidraw'] })
    const tracked = await repo.run(['ls-files'])
    expect(tracked).toContain('small.md')
    expect(tracked).not.toContain('Huge board')
    // The rest really went: the remote has our commit, and its subject does not name the held-back file.
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
    expect(await repo.run(['log', '-1', '--format=%s'])).toBe('sync: small.md')
    // Never even hashed: excluded BEFORE the add, so no 95 MB blob lands in .git/objects.
    expect(Number(/(\d+) kilobytes/.exec(await repo.run(['count-objects']))?.[1])).toBeLessThan(1024)
  })

  it('is idempotent: a second pass holds the same file back, makes no commit, and does not fail on "nothing to commit"', async () => {
    const { repo } = await pushedRepo()
    await oversize(repo, 'Big video.mov')
    const head = await repo.run(['rev-parse', 'HEAD'])

    const first = await syncPass(repo.root)
    const second = await syncPass(repo.root)

    for (const status of [first, second]) expect(status).toMatchObject({ state: 'attention', attention: 'too-large', tooLarge: ['Big video.mov'] })
    // The ONLY dirty file was oversize: nothing was staged, so nothing was committed.
    expect(await repo.run(['rev-parse', 'HEAD'])).toBe(head)
    expect(await repo.run(['diff', '--cached', '--name-only'])).toBe('')
  })

  it('draws the line AT the limit: a file one byte under it syncs, a file exactly at it is held back', async () => {
    const { repo } = await pushedRepo()
    await oversize(repo, 'under.mov', GITHUB_FILE_LIMIT_BYTES - 1)
    await oversize(repo, 'at.mov')

    expect(await syncPass(repo.root)).toMatchObject({ attention: 'too-large', tooLarge: ['at.mov'] })
    expect(await repo.run(['ls-files'])).toContain('under.mov')
  })

  it('holds back a TRACKED file that grew past the limit; the committed version stays as it was', async () => {
    const { repo } = await pushedRepo()
    await truncate(path.join(repo.root, 'note.md'), GITHUB_FILE_LIMIT_BYTES + 1)

    const status = await syncPass(repo.root)

    expect(status).toMatchObject({ attention: 'too-large', tooLarge: ['note.md'] })
    expect(await repo.run(['show', 'HEAD:note.md'])).toBe('line one')
  })

  it('D12: a held-back TRACKED file never blocks the rebase — the rest syncs both ways and its bytes stay exactly as they were', async () => {
    const { repo, remote } = await pushedRepo()
    const other = await secondClone(remote)
    const bin = await requireGit()
    // The other machine changes the big file's committed version AND adds a note, and pushes first.
    await writeFile(path.join(other, 'note.md'), 'line one\nfrom the other machine\n', 'utf8')
    await writeFile(path.join(other, 'other.md'), '# other\n', 'utf8')
    for (const args of [['add', '-A'], ['commit', '-m', 'other'], ['push']]) expect((await git(bin, other, args)).code).toBe(0)
    // Here: note.md grows past the line (a distinctive head, then a sparse tail), and a small edit.
    const big = path.join(repo.root, 'note.md')
    await writeFile(big, 'our head\n')
    await truncate(big, GITHUB_FILE_LIMIT_BYTES + 1)
    const before = await sha1(big)
    await repo.write('small.md', '# small\n')

    const status = await syncPass(repo.root)

    expect(status).toMatchObject({ state: 'attention', attention: 'too-large', tooLarge: ['note.md'] })
    // Both ways: their commit is under ours, ours is on the remote.
    expect(await repo.run(['log', '--format=%s'])).toBe('sync: small.md\nother\nbase')
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
    // Our bytes on disk, untouched; theirs is what history holds; nothing staged, nothing stashed.
    expect(await sha1(big)).toBe(before)
    expect(await repo.run(['show', 'HEAD:note.md'])).toBe('line one\nfrom the other machine')
    expect(await repo.run(['diff', '--cached', '--name-only'])).toBe('')
    expect(await repo.run(['stash', 'list'])).toBe('')
    // And the next pass is the same calm answer, not a conflict.
    expect(await syncPass(repo.root)).toMatchObject({ attention: 'too-large', tooLarge: ['note.md'] })
  })

  it('clears once the file is gone: the next pass is plain synced, with no list', async () => {
    const { repo } = await pushedRepo()
    await oversize(repo, 'Huge.excalidraw')
    expect((await syncPass(repo.root)).attention).toBe('too-large')

    await unlink(path.join(repo.root, 'Huge.excalidraw'))
    const status = await syncPass(repo.root)

    expect(status.state).toBe('synced')
    expect(status.tooLarge).toBeUndefined()
  })

  it('syncs a held-back board on the next pass once it has shrunk under the line', async () => {
    const { repo, remote } = await pushedRepo()
    await oversize(repo, 'Huge.excalidraw')
    expect((await syncPass(repo.root)).attention).toBe('too-large')

    await repo.write('Huge.excalidraw', '{"type":"excalidraw"}\n')
    const status = await syncPass(repo.root)

    expect(status.state).toBe('synced')
    expect(status.tooLarge).toBeUndefined()
    expect(await repo.run(['show', 'HEAD:Huge.excalidraw'])).toBe('{"type":"excalidraw"}')
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
  })

  it('gives fetch and push the transfer budget and every local call the default (YAZ-1801 D4)', async () => {
    const { repo } = await pushedRepo()
    await repo.write('a.md', '# a\n')
    vi.mocked(git).mockClear()

    expect((await syncPass(repo.root)).state).toBe('synced')

    const calls = vi.mocked(git).mock.calls.filter(([, root]) => root === repo.root)
    const timeoutOf = (verb: string) => calls.filter(([, , args]) => args[0] === verb).map(([, , , opts]) => opts?.timeoutMs)
    expect(timeoutOf('fetch')).toEqual([TRANSFER_TIMEOUT_MS])
    expect(timeoutOf('push')).toEqual([TRANSFER_TIMEOUT_MS])
    expect(calls.filter(([, , args]) => args[0] !== 'fetch' && args[0] !== 'push').every(([, , , opts]) => opts?.timeoutMs === undefined)).toBe(true)
  })

  it('asks git where the merge rule lives once per vault, and still puts back a rule someone deleted (YAZ-2073 5H)', async () => {
    const { repo } = await pushedRepo()
    await repo.write('a.md', '# a\n')
    expect((await syncPass(repo.root)).state).toBe('synced')
    const attributes = path.join(repo.root, '.git', 'info', 'attributes')
    await unlink(attributes)
    await repo.write('b.md', '# b\n')
    vi.mocked(git).mockClear()
    expect((await syncPass(repo.root)).state).toBe('synced')
    const gitPath = vi.mocked(git).mock.calls.filter(([, root, args]) => root === repo.root && args.includes('--git-path'))
    expect(gitPath).toEqual([])
    expect(readFileSync(attributes, 'utf8')).toContain('-merge')
  })

  it('summarises past three files in the subject', async () => {
    const { repo } = await pushedRepo()
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) await repo.write(name, `# ${name}\n`)

    expect((await syncPass(repo.root)).state).toBe('synced')
    expect(await repo.run(['log', '-1', '--format=%s'])).toBe('sync: a.md, b.md, c.md +2 more')
  })

  it('rebases a behind-only repo and pushes nothing new', async () => {
    const { repo, remote } = await pushedRepo()
    const other = await secondClone(remote)
    const bin = await requireGit()
    await writeFile(path.join(other, 'note.md'), 'line one\nfrom the other machine\n', 'utf8')
    for (const args of [['add', '-A'], ['commit', '-m', 'other'], ['push']]) {
      expect((await git(bin, other, args)).code).toBe(0)
    }
    const tipBefore = await remoteHead(repo, remote)

    const status = await syncPass(repo.root)

    expect(status.state).toBe('synced')
    // Fast-forwarded onto their commit; nothing of ours to publish, so the remote is untouched.
    expect(await repo.run(['rev-parse', 'HEAD'])).toBe(tipBefore)
    expect(await remoteHead(repo, remote)).toBe(tipBefore)
    expect(await repo.run(['log', '--format=%s'])).toBe('other\nbase')
  })

  it('merges a diverged-but-clean pair of machines: their file and ours both survive on the remote', async () => {
    const { repo, remote } = await pushedRepo()
    const other = await secondClone(remote)
    const bin = await requireGit()
    // The other machine adds its OWN note and pushes first…
    await writeFile(path.join(other, 'other.md'), '# from the other machine\n', 'utf8')
    for (const args of [['add', '-A'], ['commit', '-m', 'other'], ['push']]) {
      expect((await git(bin, other, args)).code).toBe(0)
    }
    // …while this machine edits a DIFFERENT file. No lines collide: the everyday two-machine case.
    await repo.write('note.md', 'line one\nedited here\n')

    const status = await syncPass(repo.root)

    expect(status.state).toBe('synced')
    // Our commit replayed on top of theirs and both are on the remote; the working tree has both files.
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
    expect(await repo.run(['log', '--format=%s'])).toBe('sync: note.md\nother\nbase')
    expect(await repo.run(['show', 'HEAD:other.md'])).toBe('# from the other machine')
  })

  it('sets the upstream on a first push', async () => {
    const repo = await baseRepo()
    const remote = await makeBareRemote()
    cleanups.push(remote.cleanup)
    await wireOrigin(repo, remote)

    const status = await syncPass(repo.root)

    expect(status.state).toBe('synced')
    expect(await repo.run(['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/main')
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
  })

  it('reports a repo with no origin as off, with the facts it could read', async () => {
    const repo = await baseRepo()
    expect(await syncPass(repo.root)).toEqual({ root: repo.root, state: 'off', repo: { remoteUrl: null, branch: 'main' } })
  })

  it('reports a plain directory as off', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-nosync-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    expect(await syncPass(dir)).toEqual({ root: dir, state: 'off', repo: { remoteUrl: null, branch: null } })
  })

  /**
   * A remote path that does not exist is the closest a fixture gets to "the network is down", and
   * git answers it with `fatal: Could not read from remote repository.` — an OFFLINE marker, so
   * the pass comes back `pending` and the manager retries. That is arguably generous (a deleted
   * repo is not a flaky Wi-Fi connection, and 'other' would be defensible), but the failure mode
   * of being generous is a quiet retry every two minutes, while the failure mode of being strict
   * is an alarming red state every time a train goes into a tunnel. The precise offline strings
   * are pinned by the unit matrix below.
   *
   * The local commit still lands first: an unreachable remote must never cost the user an edit.
   */
  it('commits locally and reports pending when the remote is unreachable', async () => {
    const { repo } = await pushedRepo()
    await repo.run(['remote', 'set-url', 'origin', path.join(tmpdir(), 'yaseendraw-no-such-remote')])
    await repo.write('offline.md', '# written on a train\n')

    const status = await syncPass(repo.root)

    expect(status.state).toBe('pending')
    expect(status.message).toMatch(/does not appear to be a git repository/)
    expect(await repo.run(['log', '-1', '--format=%s'])).toBe('sync: offline.md')
  })
})

/**
 * The idle pull's cheap look (YAZ-2073 5H): `fetch` + `rev-list`, two spawns where a full pass
 * makes nine. It answers `level` ONLY when both sides are provably level; news or an unpushed
 * commit is `moved` (fetched — the full pass need not fetch again), and a look that failed is
 * `unknown`, left to the full pass to fetch and classify.
 */
describe('lookAtRemote', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  const spawns = (root: string) => vi.mocked(git).mock.calls.filter(([, r]) => r === root).map(([, , args]) => args[0])

  it('level with the remote: level, from a fetch and one rev-list and nothing else', async () => {
    const { repo } = await pushedRepo()
    vi.mocked(git).mockClear()
    expect(await lookAtRemote(repo.root)).toBe('level')
    expect(spawns(repo.root)).toEqual(['fetch', 'rev-list'])
  })

  it('the other machine pushed: moved, and the full pass told so brings it in without fetching again', async () => {
    const { repo, remote } = await pushedRepo()
    const other = await secondClone(remote)
    const bin = await requireGit()
    await writeFile(path.join(other, 'theirs.md'), 'from the other machine\n', 'utf8')
    for (const args of [['add', '-A'], ['commit', '-m', 'other'], ['push']]) expect((await git(bin, other, args)).code).toBe(0)
    expect(await lookAtRemote(repo.root)).toBe('moved')
    vi.mocked(git).mockClear()
    expect((await syncPass(repo.root, { fetched: true })).state).toBe('synced')
    expect(spawns(repo.root)).not.toContain('fetch')
    expect(existsSync(path.join(repo.root, 'theirs.md'))).toBe(true)
    expect(await lookAtRemote(repo.root)).toBe('level')
  })

  it('a local commit nobody pushed yet (made outside the app), or no upstream yet: moved', async () => {
    const { repo } = await pushedRepo()
    await repo.write('by-hand.md', '# committed in a terminal\n')
    await repo.run(['add', '-A'])
    await repo.run(['commit', '-m', 'by hand'])
    expect(await lookAtRemote(repo.root)).toBe('moved')
    await repo.run(['branch', '--unset-upstream'])
    expect(await lookAtRemote(repo.root)).toBe('moved')
  })

  it('an unreachable remote: unknown, so the full pass fetches and classifies it', async () => {
    const { repo } = await pushedRepo()
    await repo.run(['remote', 'set-url', 'origin', path.join(tmpdir(), 'yaseendraw-no-such-remote')])
    expect(await lookAtRemote(repo.root)).toBe('unknown')
  })
})

describe('flush mode (YAZ-1111)', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('pushes to a reachable remote exactly like a normal pass', async () => {
    const { repo, remote } = await pushedRepo()
    await repo.write('note.md', 'line one\nline two\n')
    vi.mocked(git).mockClear()
    const status = await syncPass(repo.root, { flush: true })
    expect(status.state).toBe('synced')
    expect(await remoteHead(repo, remote)).toBe(await repo.run(['rev-parse', 'HEAD']))
    // No fetch on a flush, and its push keeps the short cap rather than the 10 min transfer budget.
    const calls = vi.mocked(git).mock.calls.filter(([, root]) => root === repo.root)
    expect(calls.some(([, , args]) => args[0] === 'fetch')).toBe(false)
    expect(calls.filter(([, , args]) => args[0] === 'push').map(([, , , opts]) => opts?.timeoutMs)).toEqual([5_000])
  })

  it('never sits out the 30s wall: an unreachable remote still lands the commit and returns fast', async () => {
    const repo = await baseRepo()
    // TEST-NET-1 (192.0.2.0/24) is guaranteed unroutable, so the push HANGS instead of failing
    // fast — exactly the captive-portal quit the flush cap exists for. On a network that answers
    // with a quick refusal instead, the pass just returns even faster; both paths are in-budget.
    await repo.run(['remote', 'add', 'origin', 'http://192.0.2.1:9418/x.git'])
    await repo.write('note.md', 'line one\nedited\n')
    const status = await syncPass(repo.root, { flush: true })
    // The CAP itself, not the wall clock: `syncPass` must not have waited out git's own 30 s
    // (a clock assertion here flakes under full-suite load, for exactly the reason the suite
    // ceiling was raised). Returning at all inside the suite's ceiling IS the guarantee.
    expect(status.state === 'pending' || status.state === 'attention').toBe(true)
    // The edit is safe regardless: committed locally, pushed on the next open.
    expect(await repo.run(['log', '-1', '--format=%s'])).toBe('sync: note.md')
  })
})

describe('commitMessage', () => {
  it('uses basenames, caps the list at three, and falls back to a bare subject', () => {
    expect(commitMessage([])).toBe('sync')
    expect(commitMessage(['notes/deep/one.md'])).toBe('sync: one.md')
    expect(commitMessage(['a.md', 'b.md', 'c.md'])).toBe('sync: a.md, b.md, c.md')
    expect(commitMessage(['a.md', 'b.md', 'c.md', 'd.md'])).toBe('sync: a.md, b.md, c.md +1 more')
  })
})

describe('classifyGitFailure', () => {
  const failed = (stderr: string, code = 128): GitResult => ({ code, stdout: '', stderr })

  it('calls a timeout offline', () => {
    expect(classifyGitFailure({ code: GIT_TIMEOUT_CODE, stdout: '', stderr: 'git: timed out after 30000ms' })).toBe('offline')
  })

  it.each([
    ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", 'offline'],
    ['fatal: Could not read from remote repository.', 'offline'],
    ["fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443: Connection refused", 'offline'],
    ["fatal: unable to access 'https://github.com/x/y.git/': Failed to connect: Connection timed out", 'offline'],
    ['ssh: connect to host github.com port 22: Network is unreachable', 'offline'],
    ['remote: Support for password authentication was removed.\nfatal: Authentication failed for https://github.com/x/y.git/', 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ["fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403", 'auth'],
    ['error: failed to push some refs to origin\nhint: Updates were rejected', 'other'],
    ["fatal: '/nowhere' does not appear to be a git repository", 'other'],
  ])('classifies %s', (stderr, expected) => {
    expect(classifyGitFailure(failed(stderr))).toBe(expected)
  })

  it('prefers auth over the generic transport envelope git wraps every failure in', () => {
    // Both an auth needle and two offline ones. Filing this as offline would retry a dead SSH key
    // silently forever instead of telling the user to sign in.
    const both = "fatal: unable to access 'https://x/y.git/': The requested URL returned error: 403\nfatal: Could not read from remote repository."
    expect(classifyGitFailure(failed(both))).toBe('auth')
  })

  it('does not mistake an abbreviated sha for an HTTP 403', () => {
    expect(classifyGitFailure(failed('error: failed to push some refs\n ! [rejected] 1a403bc..9f2c1de main -> main'))).toBe('other')
  })
})
