import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { GIT_CANDIDATES, git, resolveGit } from './exec'

/**
 * Test fixtures for the git layer (YAZ-1081 2A), in the shape of `fs/testFixture.ts`.
 *
 * These run the REAL git, not a mock: the whole point of `detect.ts` is that it reads git's actual
 * output, so a fake would only test the fake. Every repo is a throwaway under the temp dir and
 * every setting is written LOCALLY, so the developer's own `~/.gitconfig` — identity, commit
 * signing, default branch — can never decide whether a test passes.
 */

export interface GitRepo {
  root: string
  /** Writes `<root>/<name>`, creating parent directories. */
  write: (name: string, content: string) => Promise<void>
  /** Runs git in this repo and returns trimmed stdout; THROWS on a non-zero exit, so broken setup is never silent. */
  run: (args: string[]) => Promise<string>
  cleanup: () => Promise<void>
}

export interface BareRemote {
  /** A filesystem path, which is a perfectly good git remote URL and needs no network. */
  url: string
  cleanup: () => Promise<void>
}

/** The machine's git, or a clear failure — these tests cannot run without one. */
export async function requireGit(): Promise<string> {
  const bin = await resolveGit()
  if (bin === null) throw new Error(`no git found at ${GIT_CANDIDATES.join(' or ')}; the git tests need a real one`)
  return bin
}

async function runIn(bin: string, root: string, args: string[]): Promise<string> {
  const res = await git(bin, root, args)
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} exited ${res.code} in ${root}: ${res.stderr.trim()}`)
  return res.stdout.trim()
}

/** A temp repo on `main` with a local identity, ready for `write` + `add` + `commit`. Zero commits until you make one. */
export async function makeGitRepo(): Promise<GitRepo> {
  const bin = await requireGit()
  const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-git-'))
  const run = (args: string[]) => runIn(bin, root, args)
  await run(['init', '-b', 'main', '.'])
  await run(['config', 'user.name', 'Trevor Draw Test'])
  await run(['config', 'user.email', 'test@example.invalid'])
  // A developer with `commit.gpgsign = true` globally would otherwise fail every commit here.
  await run(['config', 'commit.gpgsign', 'false'])
  return {
    root,
    write: async (name, content) => {
      const file = path.join(root, name)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content, 'utf8')
    },
    run,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** A temp bare repo to stand in for GitHub — wire it up with `wireOrigin`, push to it, clone from it. */
export async function makeBareRemote(): Promise<BareRemote> {
  const bin = await requireGit()
  const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-remote-'))
  await runIn(bin, root, ['init', '--bare', '-b', 'main', '.'])
  return { url: root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

export async function wireOrigin(repo: GitRepo, remote: BareRemote): Promise<void> {
  await repo.run(['remote', 'add', 'origin', remote.url])
}

/** One machine of a two-machine test (YAZ-1897): its vault, and plain file and git helpers over it. */
export interface Machine {
  root: string
  write: (rel: string, content: string) => Promise<void>
  read: (rel: string) => string
  remove: (rel: string) => Promise<void>
  /** Runs git here and answers trimmed stdout (no throw — the tests assert on what they need). */
  git: (...args: string[]) => Promise<string>
}

function machine(root: string, bin: string): Machine {
  const abs = (rel: string) => path.join(root, rel)
  return {
    root,
    write: async (rel, content) => {
      await mkdir(path.dirname(abs(rel)), { recursive: true })
      await writeFile(abs(rel), content)
    },
    read: (rel) => readFileSync(abs(rel), 'utf8'),
    remove: (rel) => unlink(abs(rel)),
    git: async (...args) => (await git(bin, root, args)).stdout.trim(),
  }
}

/**
 * Two machines sharing one bare-repo "GitHub" (YAZ-1897): machine A ("Trevor Draw Test") seeded
 * with `files` and pushed, machine B ("Sam") cloned from it. `cleanup` removes all three.
 */
export async function makeTwoMachines(files: Record<string, string>): Promise<{ a: Machine; b: Machine; cleanup: () => Promise<void> }> {
  const bin = await requireGit()
  const remote = await makeBareRemote()
  const repo = await makeGitRepo()
  const bDir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-b-'))
  const cleanup = async () => {
    await Promise.all([remote.cleanup(), repo.cleanup(), rm(bDir, { recursive: true, force: true })])
  }
  for (const [rel, content] of Object.entries(files)) await repo.write(rel, content)
  await repo.run(['add', '-A'])
  await repo.run(['commit', '-m', 'base'])
  await wireOrigin(repo, remote)
  await repo.run(['push', '-u', 'origin', 'HEAD'])
  await runIn(bin, tmpdir(), ['clone', remote.url, bDir])
  for (const cfg of [['user.name', 'Sam'], ['user.email', 'sam@example.invalid'], ['commit.gpgsign', 'false']]) await runIn(bin, bDir, ['config', ...cfg])
  return { a: machine(repo.root, bin), b: machine(bDir, bin), cleanup }
}

/**
 * The ceiling the two REAL-git suites run under (`sync.test.ts`, `guarantees.test.ts`): every case
 * there is a commit plus a push plus a fetch against a bare repo on disk. Vitest's 5 s default is
 * enough on a warm Mac and not on a cold CI runner, and the work is real I/O rather than a hang,
 * so those two describes raise it — and nothing else in the project does.
 */
export const REAL_GIT_TIMEOUT_MS = 20_000

let workerBundle: Promise<string> | null = null

/**
 * `main/storageWorker.ts` bundled to one CJS file, the way electron-vite's `?modulePath` builds it —
 * a worker thread runs plain JS, not vitest's transformed TS (YAZ-1801 D8, D11). Built once per test
 * process; the file lives in the temp dir with the rest of the fixtures.
 */
export function bundleStorageWorker(): Promise<string> {
  workerBundle ??= (async () => {
    const outfile = path.join(await mkdtemp(path.join(tmpdir(), 'yaseendraw-worker-')), 'storageWorker.cjs')
    await build({
      entryPoints: [fileURLToPath(new URL('../storageWorker.ts', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      alias: { '@shared': fileURLToPath(new URL('../../../../shared', import.meta.url)) },
      logLevel: 'silent',
    })
    return outfile
  })()
  return workerBundle
}
