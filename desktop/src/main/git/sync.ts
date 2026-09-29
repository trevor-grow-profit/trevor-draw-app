import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DIAGRAM_EXTENSIONS, DRAWING_VIEW_EXTENSIONS, GITHUB_FILE_LIMIT_BYTES, type GithubSyncMerge, type GithubSyncStatus } from '@shared/types'
import { isBoard } from '@shared/fileKind'
import { detectRepo } from './detect'
import { ensureVaultIgnores, VAULT_IGNORED } from './ignore'
import { git, GIT_TIMEOUT_CODE, installGitHint, resolveGit, zList, type GitResult } from './exec'
import { ensureBoardMergeRule, resolveRebase } from './resolve'

/**
 * One sync pass (YAZ-1081 2B): everything "make this vault and its GitHub remote agree" means,
 * as a single async function of a root that answers with a `GithubSyncStatus` and never throws.
 *
 * The order is fixed and load-bearing — commit, fetch, rebase, push:
 *   - COMMIT FIRST so the rebase has a clean tree to move. Nothing here ever stashes; a stash is
 *     a place work can be forgotten, and this app's promise is that the user's notes are always
 *     on disk exactly as they left them. ONE exception (🔒 YAZ-1801 D12): a TRACKED file held back
 *     as too large is the one edit a commit can never absorb, and it would make the rebase refuse
 *     ("unstaged changes"). Only those files are parked for the length of the rebase and their
 *     exact bytes copied back straight after (`parkWhileRebasing`) — files sync will never commit
 *     anyway, restored by a copy, never a merge.
 *   - REBASE, never merge. Two machines editing different notes replay cleanly and the history
 *     stays a line anyone can read in the GitHub UI.
 *   - A rebase that CONFLICTS is settled and finished (YAZ-1897, `resolve.ts`): boards merge shape
 *     by shape, anything else keeps both copies, and the pass reports what it merged. Only what
 *     cannot be settled is aborted (the lossless rule, YAZ-1081): git puts the working tree back
 *     byte-for-byte and the pass reports `attention/conflict`. A vault is never left in a
 *     half-finished rebase, and no `<<<<<<<` marker ever lands in a user's file.
 *
 * Every failure is CLASSIFIED rather than thrown (`classifyGitFailure`), because the three kinds
 * want three different responses: offline is not the user's problem (retry quietly), auth is
 * (say so once), anything else is worth showing verbatim. `syncPass` is stateless — the cadence,
 * the retries and the debounce all live in `manager.ts`.
 */

/** How many file names a commit subject lists before it summarises the rest. */
const SUBJECT_FILES = 3

/** Git pathspecs for what a vault ignores; `*` crosses `/`, so these match at any depth. */
const IGNORED_PATHSPEC = VAULT_IGNORED.map((entry) => `*${entry}`)

/**
 * WHAT SYNC COMMITS (ACT-370): boards and what belongs to them, nothing else. `add -A` on the vault
 * root would commit every dirty file in the repo — fine in a repo that holds only boards, a trap in
 * any other (a vault opened inside a working repo, say our-marketing, where a half-done doc edit
 * would ride along in a `sync:` commit). So staging is scoped to these pathspecs (`*` crosses `/`,
 * so a board at any depth matches) and every other dirty file is left exactly as it is, for its
 * owner to commit. `.yaseendraw/` holds the vault's favorites and sync switch, `assets/` is where a
 * drawing's picture bytes land, and `.gitignore` is in because `ensureVaultIgnores` appends to it.
 */
const SCOPE_GLOBS: readonly string[] = [...DRAWING_VIEW_EXTENSIONS.map((ext) => `*${ext}`), ...DIAGRAM_EXTENSIONS.map((ext) => `*${ext}`), '.yaseendraw/', 'assets/', '.gitignore']

/** The scope as git pathspecs. `icase`: a board's extension is matched in any case (`B.EXCALIDRAW`), like everywhere else in the app. */
export const SYNC_SCOPE: readonly string[] = SCOPE_GLOBS.map((glob) => `:(icase)${glob}`)

/** The complement of `SYNC_SCOPE` as pathspecs: everything sync leaves alone. */
const OUTSIDE_SCOPE: readonly string[] = ['.', ...SCOPE_GLOBS.map((glob) => `:(exclude,icase)${glob}`)]

/**
 * Whether a vault-relative path is something sync would commit — the pure twin of `SYNC_SCOPE`,
 * for the watcher: an edit outside the scope is not a reason to run a pass (`manager.ts`).
 */
export function inSyncScope(rel: string): boolean {
  const posix = rel.split(path.sep).join('/')
  if (posix === '' || posix.startsWith('..')) return false
  if (isBoard(posix)) return true
  return posix === '.gitignore' || posix === '.yaseendraw' || posix.startsWith('.yaseendraw/') || posix === 'assets' || posix.startsWith('assets/')
}

const listFiles = async (bin: string, root: string, args: readonly string[]): Promise<string[]> => {
  const listed = await git(bin, root, ['ls-files', '-z', ...args, '--', ...IGNORED_PATHSPEC])
  return listed.code === 0 ? listed.stdout.split('\0').filter((p) => p !== '') : []
}

/**
 * Keep the OS's droppings (and a crashed write's tmp file) out of the commit `add -A` is about to
 * make (YAZ-1829). `add -A` stages everything, so Finder's `.DS_Store` ends up committed, pushed, and
 * in the commit SUBJECT — which is what this vault's history shows. Two steps, both idempotent and both no-ops until one of
 * these files actually exists:
 *  - the vault's `.gitignore` gains the entry (APPEND-ONLY; the user's own file is not ours to
 *    reorganise, and a vault that already ignores it is not touched at all);
 *  - anything a previous version already committed is untracked with `--cached`, so git stops
 *    carrying it and the file stays exactly where it is on disk.
 * Returns true when either changed something, so the caller knows there is now work to stage.
 */
async function keepDroppingsOut(bin: string, root: string): Promise<boolean> {
  const tracked = await listFiles(bin, root, [])
  const untracked = tracked.length > 0 ? [] : await listFiles(bin, root, ['-o', '--exclude-standard'])
  if (tracked.length === 0 && untracked.length === 0) return false
  const ignoreChanged = await ensureVaultIgnores(root).catch(() => false)
  if (tracked.length === 0) return ignoreChanged
  return (await git(bin, root, ['rm', '--cached', '--quiet', '--', ...tracked])).code === 0 || ignoreChanged
}

/**
 * The network budget of a flush pass (YAZ-1111): quitting must never sit out the full 30s wall,
 * so the one network call a flush still makes — the push — gets this cap instead.
 */
const FLUSH_PUSH_TIMEOUT_MS = 5_000

/**
 * The budget of an ordinary pass's two TRANSFERS, `fetch origin` and `push` (YAZ-1801 D4). The
 * 30 s default is right for every local call, and wrong for moving a vault's worth of pictures
 * over a home uplink: a 60 MB board at 1 MB/s is a minute, and a push killed at 30 s is a push
 * that restarts from zero on every retry and never lands. Ten minutes is "a stalled transfer",
 * not "a slow one". The flush push keeps its own 5 s cap — quitting still never waits on it.
 */
export const TRANSFER_TIMEOUT_MS = 10 * 60_000

/** The vault-relative paths in `rel` whose working-tree file is at or over the GitHub guard. A path that will not stat (deleted) is not. */
async function oversize(root: string, rel: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of rel) {
    const st = await stat(path.join(root, p)).catch(() => null)
    if (st !== null && st.isFile() && st.size >= GITHUB_FILE_LIMIT_BYTES) out.push(p)
  }
  return out
}

/**
 * YAZ-1801 D3 — a file over GitHub's limit must never reach a commit. GitHub refuses the WHOLE
 * push when one blob in it is over 100 MiB, so one oversize board would silently jam every other
 * edit in the vault behind it, forever. So it is held back, loudly, and everything else goes.
 *
 * Two steps, both idempotent (they run on every pass, and a held-back file is still dirty, so
 * every pass sees it again):
 *  - BEFORE `add -A`: the untracked and modified files are stat'ed, and the oversize ones are
 *    excluded from the add by literal pathspec. Excluding rather than add-then-reset matters for
 *    the numbers too: `git add` would write a 110 MB blob into `.git/objects` on every pass, and
 *    that unreachable object would sit in Settings › Storage's "Git history" until a gc.
 *  - AFTER `add -A`: the staged list is checked again and anything over the limit is unstaged
 *    (`reset -q -- <file>`) — the belt for a file that grew between the stat and the add.
 *
 * Returns the vault-relative paths held back. OUT OF SCOPE (noted, not handled): a file that
 * was already COMMITTED over the limit by an earlier build or by hand — that commit is in the
 * history and the push will keep failing (`attention/error`) until the history is rewritten.
 */
async function stageWithinLimit(bin: string, root: string): Promise<{ failed: GitResult | null; tooLarge: string[] }> {
  // Only what is in scope is even looked at (ACT-370): an untracked video beside the boards is not
  // sync's to hold back, or to name in a banner. `--modified` lists deletions too.
  const untracked = zList(await git(bin, root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...SYNC_SCOPE]))
  const modified = zList(await git(bin, root, ['ls-files', '-z', '--modified', '--', ...SYNC_SCOPE]))
  const dirty = [...new Set([...untracked, ...modified])]
  const held = await oversize(root, dirty)
  // Literal paths, never the globs: `git add` fails outright on a pathspec that matches nothing,
  // and a vault with no `.drawio` in it is the ordinary case.
  const toStage = dirty.filter((p) => !held.includes(p))
  if (toStage.length === 0) return { failed: null, tooLarge: held }
  const staged = await git(bin, root, ['add', '-A', '--', ...toStage.map((p) => `:(literal)${p}`)])
  if (staged.code !== 0) return { failed: staged, tooLarge: held }
  const late = await oversize(root, zList(await git(bin, root, ['diff', '--cached', '--name-only', '-z'])))
  if (late.length > 0) await git(bin, root, ['reset', '-q', '--', ...late.map((p) => `:(literal)${p}`)])
  return { failed: null, tooLarge: [...new Set([...held, ...late])].sort() }
}

/**
 * The commit subject for a sync commit: `sync: a.md, b.md, c.md +4 more`, or a bare `sync` when
 * there is nothing to name. Basenames only — a subject is a glance, not an audit trail, and the
 * full paths are in the diff. Nothing here is interpolated into a shell (see `exec.ts`), so a
 * file called `; rm -rf ~` is just a boring string.
 */
export function commitMessage(dirtyFiles: readonly string[]): string {
  const names = dirtyFiles.map((f) => path.basename(f)).filter((n) => n !== '')
  if (names.length === 0) return 'sync'
  const rest = names.length - SUBJECT_FILES
  const head = names.slice(0, SUBJECT_FILES).join(', ')
  return rest > 0 ? `sync: ${head} +${rest} more` : `sync: ${head}`
}

/**
 * Auth is checked BEFORE offline (a deliberate ordering, not the list order): git wraps almost
 * every remote failure — expired token included — in the generic `unable to access` /
 * `Could not read from remote repository` envelope, so an offline-first check would file a dead
 * SSH key as "no network" and retry it silently forever instead of telling the user to sign in.
 * The auth needles are specific enough that a genuinely offline machine never matches them.
 *
 * `403` is matched on a word boundary so an abbreviated SHA like `1a403bc` in a push rejection
 * cannot masquerade as an HTTP status.
 */
const AUTH_PATTERNS = [/authentication failed/i, /permission denied/i, /publickey/i, /could not read username/i, /terminal prompts disabled/i, /\b403\b/]

const OFFLINE_PATTERNS = [/could not resolve host/i, /unable to access/i, /could not read from remote repository/i, /connection refused/i, /connection timed out/i, /network is unreachable/i]

/** git's own way of saying "I don't know who you are" — the hint block names `user.name`. */
const IDENTITY_PATTERNS = [/tell me who you are/i, /empty ident/i, /user\.name/i]

/** A commit that had nothing staged after `add -A` (e.g. every dirty path was ignored) is not a failure. */
const NOTHING_TO_COMMIT = /nothing to commit|no changes added/i

/**
 * Which of the three failure kinds a non-zero git run is. Pure and exported so the classification
 * can be unit-tested against real git output without a network, which is the only way to test it
 * honestly — you cannot make a CI box lose DNS on demand.
 *
 * A timeout counts as offline: `exec.ts` already fails fast on a credential prompt
 * (`GIT_TERMINAL_PROMPT=0`), so a run that hits its wall — 30 s for a local call,
 * `TRANSFER_TIMEOUT_MS` (10 min) for a fetch or push (YAZ-1801 D4) — is a stalled transfer, not a lock.
 */
export function classifyGitFailure(res: GitResult): 'offline' | 'auth' | 'other' {
  if (res.code === GIT_TIMEOUT_CODE) return 'offline'
  const text = `${res.stderr}\n${res.stdout}`
  if (AUTH_PATTERNS.some((p) => p.test(text))) return 'auth'
  if (OFFLINE_PATTERNS.some((p) => p.test(text))) return 'offline'
  return 'other'
}

/**
 * The one line worth showing a user out of a failed run: git's own `fatal:`/`error:` line when
 * there is one, else the first non-blank line, else a bare exit code. Progress chatter and the
 * four-line "make sure you have the correct access rights" epilogue are noise here.
 */
function firstMeaningfulLine(res: GitResult): string {
  const lines = `${res.stderr}\n${res.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? `git exited ${res.code}`
}

type RepoRef = GithubSyncStatus['repo']

/** offline → `pending` (the manager retries on its own clock); auth → say so; anything else → verbatim. */
function fromFailure(root: string, repo: RepoRef, res: GitResult): GithubSyncStatus {
  const message = firstMeaningfulLine(res)
  const kind = classifyGitFailure(res)
  if (kind === 'offline') return { root, state: 'pending', message, repo }
  if (kind === 'auth') return { root, state: 'attention', attention: 'auth', message, repo }
  return { root, state: 'attention', attention: 'error', message, repo }
}

/**
 * `flush: true` is the quit variant (YAZ-1111): the commit — local and instant — always happens,
 * but the fetch/rebase half is SKIPPED (we are leaving; rebasing now serves nobody, and the next
 * open does it anyway) and the push gets a short cap instead of the 30s wall, so a half-dead
 * network can never make quitting feel frozen. A push the remote rejects (it was ahead) is fine:
 * the commit is safe locally and the next open rebases and pushes it.
 *
 * `fetched: true` says the idle pull's look (`lookAtRemote`) fetched origin a moment ago and found
 * news, so the pass rebases onto that fetch instead of making the same round trip again.
 */
export async function syncPass(root: string, opts?: { candidates?: readonly string[]; flush?: boolean; fetched?: boolean }): Promise<GithubSyncStatus> {
  // No git binary is a CLASSIFICATION, never an exception: a Mac without the Command Line Tools
  // or a PC without Git for Windows is an ordinary machine, and the app must be able to say
  // "install it" (`installGitHint`, per OS) rather than crash a pass.
  const bin = await resolveGit(opts?.candidates)
  if (bin === null) {
    return { root, state: 'attention', attention: 'no-git', message: installGitHint() }
  }

  const facts = await detectRepo(bin, root)
  const repo: RepoRef = { remoteUrl: facts.remoteUrl, branch: facts.branch }
  // Not a repo, or a repo nobody wired to GitHub: `off`, not an error. This is the resting state
  // of every vault that has never been set up, and the settings panel still gets the facts.
  if (!facts.isRepo || facts.remoteUrl === null) return { root, state: 'off', repo }

  // ---------- 1. local edits become one commit (minus anything GitHub would refuse — D3) ----------
  const droppings = await keepDroppingsOut(bin, root)
  await ensureBoardMergeRule(bin, root) // YAZ-1897 D2: boards never reach git's line merge
  let tooLarge: string[] = []
  if (facts.dirty || droppings) {
    const staging = await stageWithinLimit(bin, root)
    tooLarge = staging.tooLarge
    if (staging.failed !== null) return withTooLarge(fromFailure(root, repo, staging.failed), tooLarge)
    // Nothing staged — every dirty file was held back, or ignored — is not a commit to attempt:
    // git's wording for "only untracked files left" matches neither NOTHING_TO_COMMIT needle.
    // Something the user staged by hand outside the scope (`git add` in a terminal, half a commit
    // in progress) is theirs, not sync's: it is unstaged — every byte stays in the working tree —
    // so the commit below carries boards only (ACT-370). `.DS_Store` untracking (above) is kept.
    await git(bin, root, ['reset', '-q', '--', ...OUTSIDE_SCOPE, ...IGNORED_PATHSPEC.map((spec) => `:(exclude)${spec}`)])
    const anything = (await git(bin, root, ['diff', '--cached', '--quiet'])).code !== 0
    // The subject is built from what IS staged, never from porcelain: porcelain collapses an
    // untracked folder to `Folder/`, and it names the dirty files sync leaves alone.
    const named = zList(await git(bin, root, ['diff', '--cached', '--name-only', '-z']))
    const committed = anything ? await git(bin, root, ['commit', '-m', commitMessage(named)]) : { code: 0, stdout: '', stderr: '' }
    if (committed.code !== 0 && !NOTHING_TO_COMMIT.test(`${committed.stdout}\n${committed.stderr}`)) {
      // A machine with no `user.name`/`user.email` cannot commit at all, and no amount of retrying
      // changes that — it is a one-time setup step, so it gets its own attention state.
      if (IDENTITY_PATTERNS.some((p) => p.test(`${committed.stderr}\n${committed.stdout}`))) {
        return { root, state: 'attention', attention: 'no-identity', message: 'git has no name or email configured for this machine', repo }
      }
      return { root, state: 'attention', attention: 'error', message: firstMeaningfulLine(committed), repo }
    }
  }

  // ---------- 2. learn what the remote has (skipped on flush — see the doc comment) ----------
  const flush = opts?.flush === true
  if (!flush && opts?.fetched !== true) {
    const fetched = await git(bin, root, ['fetch', 'origin'], { timeoutMs: TRANSFER_TIMEOUT_MS })
    if (fetched.code !== 0) return withTooLarge(fromFailure(root, repo, fetched), tooLarge)
  }

  const level = await divergence(bin, root)
  const hasUpstream = level !== null
  const behind = level?.behind ?? 0
  const ahead = level?.ahead ?? 1 // no upstream ⇒ treat the branch as unpushed

  // ---------- 3. replay our commits on top of theirs (never a merge; see D12 for the one stash) ----------
  let merged: GithubSyncMerge[] = []
  if (behind > 0 && !flush) {
    const span = (await git(bin, root, ['rev-parse', 'HEAD', '@{u}'])).stdout.split('\n')
    const outcome = await parkWhileRebasing(bin, root, tooLarge, async () => {
      if ((await git(bin, root, ['rebase', '@{u}'])).code === 0) return true
      // YAZ-1897: settle the conflicts and finish; it aborts (losslessly) whatever it cannot settle.
      const report = await resolveRebase(bin, root, { before: span[0] ?? 'HEAD', upstream: span[1] ?? '@{u}' })
      merged = report ?? []
      return report !== null
    })
    if (outcome !== true && outcome !== false) return withTooLarge(fromFailure(root, repo, outcome), tooLarge)
    if (!outcome) {
      return withTooLarge({ root, state: 'attention', attention: 'conflict', message: 'sync could not finish merging with the other machine — nothing was lost, but this needs a human', repo }, tooLarge)
    }
  }
  // Every answer from here on carries what the pass merged (and the held-back list), pushed or not.
  const done = (status: GithubSyncStatus): GithubSyncStatus => withTooLarge(merged.length > 0 ? { ...status, merged } : status, tooLarge)

  // ---------- 4. publish ----------
  if (ahead > 0) {
    const pushed = await git(bin, root, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeoutMs: flush ? FLUSH_PUSH_TIMEOUT_MS : TRANSFER_TIMEOUT_MS })
    if (pushed.code !== 0) return done(fromFailure(root, repo, pushed))
  }

  // D3: everything else is pushed; the held-back files are the one thing left to say, and saying
  // it is an `attention` — the banner stays up (no Dismiss) until a pass no longer finds any.
  // The words are the renderer's (`syncAttention.ts`), built from the list, so there is no `message`.
  if (tooLarge.length > 0) return done({ root, state: 'attention', attention: 'too-large', repo })
  return done({ root, state: 'synced', repo })
}

/**
 * `--left-right --count @{u}...HEAD` prints "<behind>\t<ahead>" in one call. The command FAILING
 * is itself the answer to a different question: a branch with no upstream (never pushed), which
 * has nothing to rebase onto and everything to push — null.
 */
async function divergence(bin: string, root: string): Promise<{ behind: number; ahead: number } | null> {
  const counts = await git(bin, root, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
  if (counts.code !== 0) return null
  const [b = '', a = ''] = counts.stdout.trim().split(/\s+/)
  return { behind: Number.parseInt(b, 10) || 0, ahead: Number.parseInt(a, 10) || 0 }
}

/** What the idle pull's look found: both tips level, news fetched just now, or no answer at all. */
export type RemoteLook = 'level' | 'moved' | 'unknown'

/**
 * The idle pull's cheap look (YAZ-2073 5H): `fetch` + one `rev-list`, two spawns where a full pass
 * makes nine. The idle pull only runs while no watcher event has arrived since a `synced` pass,
 * so the working tree is known clean and only the two branch tips can have moved. `level` ONLY
 * when both sides provably are; news on the remote, an unpushed commit (one made in a terminal,
 * say) or no upstream is `moved`, with origin already fetched; a look that failed is `unknown` —
 * the full pass does, fetches and classifies both.
 */
export async function lookAtRemote(root: string): Promise<RemoteLook> {
  const bin = await resolveGit()
  if (bin === null) return 'unknown'
  if ((await git(bin, root, ['fetch', 'origin'], { timeoutMs: TRANSFER_TIMEOUT_MS })).code !== 0) return 'unknown'
  const level = await divergence(bin, root)
  return level !== null && level.behind === 0 && level.ahead === 0 ? 'level' : 'moved'
}

/**
 * 🔒 YAZ-1801 D12 — the one stash. A held-back TRACKED file is still modified after the commit
 * (the commit left it out), and `git rebase` refuses to run over an unstaged change — which, with
 * the remote ahead, used to report a false `conflict` on every pass. So exactly those files are
 * parked (`stash push -- <paths>`), `rebase` runs, and their bytes are copied back from the stash
 * (`checkout stash@{0} -- <paths>`, then unstaged so the index matches HEAD again) and the stash
 * dropped — whether the rebase landed or aborted. A copy, never a merge: it cannot conflict, and
 * the remote's version of the file stays in history. Untracked held-back files never block a
 * rebase and are not touched. Answers `rebase()`'s verdict, or the git failure that stopped the park.
 */
async function parkWhileRebasing(bin: string, root: string, tooLarge: readonly string[], rebase: () => Promise<boolean>): Promise<boolean | GitResult> {
  // ACT-370: a dirty tracked file OUTSIDE the scope (the user's own edit in a shared repo) is the
  // same problem as a held-back one — `rebase` refuses over it — with the same answer: shelved by
  // copy for the length of the rebase, and its exact bytes (or its deletion) put back after.
  const outside = zList(await git(bin, root, ['ls-files', '-z', '--modified', '--', ...OUTSIDE_SCOPE]))
  const shelf = outside.length === 0 ? null : await shelve(bin, root, outside)
  try {
    return await parkTooLarge(bin, root, tooLarge, rebase)
  } finally {
    if (shelf !== null) await shelf.restore()
  }
}

/**
 * Copies of the given dirty tracked files (a deleted one recorded as such), then `checkout` so
 * the tree is clean for the rebase. `restore` puts the copies back byte for byte, deletes again
 * what was deleted, and removes the copies. On disk, not in memory: a shared repo's dirty file can
 * be anything, a video included.
 */
async function shelve(bin: string, root: string, rels: readonly string[]): Promise<{ restore: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-shelf-'))
  const kept = new Map<string, string | null>()
  for (const [i, rel] of rels.entries()) {
    const copy = path.join(dir, String(i))
    const ok = await copyFile(path.join(root, rel), copy).then(() => true, () => false)
    kept.set(rel, ok ? copy : null)
  }
  await git(bin, root, ['checkout', '--', ...rels.map((p) => `:(literal)${p}`)])
  return {
    async restore() {
      for (const [rel, copy] of kept) {
        const target = path.join(root, rel)
        if (copy === null) await rm(target, { force: true })
        else await copyFile(copy, target).catch(() => undefined)
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

async function parkTooLarge(bin: string, root: string, tooLarge: readonly string[], rebase: () => Promise<boolean>): Promise<boolean | GitResult> {
  const tracked = tooLarge.length === 0 ? [] : zList(await git(bin, root, ['ls-files', '-z', '--', ...tooLarge.map((p) => `:(literal)${p}`)]))
  if (tracked.length === 0) return rebase()
  const specs = tracked.map((p) => `:(literal)${p}`)
  const parked = await git(bin, root, ['stash', 'push', '-q', '-m', 'yaseendraw: held back while rebasing', '--', ...specs])
  if (parked.code !== 0) return parked
  try {
    return await rebase()
  } finally {
    await git(bin, root, ['checkout', 'stash@{0}', '--', ...specs])
    await git(bin, root, ['reset', '-q', '--', ...specs])
    await git(bin, root, ['stash', 'drop', '-q'])
  }
}

/** A failure status still carries the held-back list, so the sidebar icons do not blink off while offline. */
function withTooLarge(status: GithubSyncStatus, tooLarge: readonly string[]): GithubSyncStatus {
  return tooLarge.length > 0 ? { ...status, tooLarge } : status
}
