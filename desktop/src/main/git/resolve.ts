import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { mergeBoards } from '@shared/boardMerge'
import { isDiagram, isDrawing } from '@shared/fileKind'
import { VAULT_CONFIG_DIR, type GithubSyncMerge } from '@shared/types'
import { FAVORITES_FILE, mergeFavoritesFile } from '../favorites'
import { atomicWrite } from '../fs/fsUtils'
import { mergeSharesFile, SHARES_FILE } from '../share/shareLinks'
import { git, zList } from './exec'
import { withLines } from './ignore'

/**
 * A REBASE THAT STOPPED ON CONFLICTS, FINISHED INSTEAD OF ABANDONED (🔒 YAZ-1897 D1–D4).
 *
 * Before this, any conflict aborted the pass and the whole vault stopped syncing until a person
 * untangled it by hand. Now each conflicted file is settled where it stands and the rebase goes on
 * — still a rebase, never a merge commit, so history stays one readable line:
 *  - a BOARD merges shape by shape (`mergeBoards`, D1). Git never line-merges a board at all (D2,
 *    `ensureBoardMergeRule`), so every board both machines changed arrives here;
 *  - the vault's `shares.json` and `favorites.json` merge per entry, and any other `.yaseendraw/`
 *    config keeps ours (a conflicted copy nobody sees would only be clutter);
 *  - anything else — prose, a board that will not parse, two unrelated new boards at one path —
 *    KEEPS BOTH (D3): the remote's version at the path, ours beside it as
 *    `<name> (conflict, YYYY-MM-DD).<ext>`;
 *  - a file one side deleted and the other edited keeps the edit.
 *
 * THE LOSSLESS RULE STILL HOLDS. Anything this cannot settle — a git step that fails, a stop that
 * is not a conflict — aborts the rebase exactly as before, and the caller reports `conflict`.
 * One thing the old abort could NOT protect: an autosave that lands while the rebase is stopped.
 * `rebase --abort` resets it away and an unstaged edit blocks `--continue`, so before either one
 * every dirty tracked file is PARKED by copy (bytes held, file checked out) and written back once
 * the rebase is over — the YAZ-1801 D12 idiom, by copy, never by merge.
 *
 * Stage numbers inside a rebase are easy to get backwards: 2 is the UPSTREAM (theirs), 3 is the
 * local commit being replayed (ours). Every read goes through `checkout-index --temp`, so no file
 * — a 40 MB board, a picture — ever squeezes through a stdout buffer.
 */

/** Where the vault stood before the pass's first merge — Version history's "before the merge" entry (D4). Local only, replaced by the next merge. */
export const BEFORE_MERGE_REF = 'refs/yaseendraw/before-merge'

/**
 * D2: every board both machines changed becomes a conflict, so it reaches `mergeBoards` instead of
 * git's line merge. 🔒 YAZ-1802 D8: a diagram too — a line merge of two `.drawio` files can come out
 * "clean" and still be broken XML, so it is always a conflict, and `mergeText` keeps both copies.
 *
 * Spelled as bracket classes so `B.DRAWIO` / `A.Excalidraw` match too (🔒 YAZ-1802 D17): git folds
 * case in attribute patterns only under `core.ignorecase`, which is per repo — false for a clone
 * made on a case-sensitive volume — so a plain `*.drawio` can silently let one through to a line
 * merge. A vault that already has the old `*.excalidraw -merge` line keeps it; it is harmless.
 */
export const BOARD_MERGE_RULES = ['*.[eE][xX][cC][aA][lL][iI][dD][rR][aA][wW] -merge', '*.[dD][rR][aA][wW][iI][oO] -merge']

const SHARES_PATH = `${VAULT_CONFIG_DIR}/${SHARES_FILE}`
const FAVORITES_PATH = `${VAULT_CONFIG_DIR}/${FAVORITES_FILE}`

/**
 * Each vault's `info/attributes` path: asked of git once, then every pass is one read (YAZ-2073 5H).
 * Kept for the process's life — it moves only with the repository itself, and a pass on a folder
 * that is no longer a repo stops before it asks.
 */
const attributesFiles = new Map<string, string>()

/**
 * D2, kept in `.git/info/attributes`: this machine only, never committed, and never the user's own
 * `.gitattributes`. Append-only and idempotent, so it runs on every pass — and puts back a rule
 * someone deleted.
 */
export async function ensureBoardMergeRule(bin: string, root: string): Promise<void> {
  let file = attributesFiles.get(root)
  if (file === undefined) {
    const where = await git(bin, root, ['rev-parse', '--git-path', 'info/attributes'])
    if (where.code !== 0) return
    file = path.resolve(root, where.stdout.trim())
    attributesFiles.set(root, file)
  }
  const next = withLines(await readFile(file, 'utf8').catch(() => null), BOARD_MERGE_RULES)
  if (next === null) return
  await mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(file, next)
}

/** The two ends of what a pass is replaying onto: our HEAD before the rebase, and the upstream it replays onto. */
export interface RebaseSpan {
  before: string
  upstream: string
}

/** One conflicted file's three versions; null where that side has no file (added on one side, deleted on the other). */
interface Stages {
  base: Buffer | null
  theirs: Buffer | null
  mine: Buffer | null
}

/** What one file's resolution wrote: the paths to stage, and what to tell the user (null = nothing worth saying). */
interface Settled {
  staged: string[]
  report: GithubSyncMerge | null
}

const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'))

/**
 * Settles a stopped rebase and continues it to the end. Answers what was merged, or null after
 * aborting (lossless) when something could not be settled. Parked saves are back on disk either way,
 * and only a merge that LANDED moves "before the merge" — a failed one leaves the last one's pointer.
 */
export async function resolveRebase(bin: string, root: string, span: RebaseSpan): Promise<GithubSyncMerge[] | null> {
  const parked = new Map<string, Buffer | null>()
  const copies = new Map<string, string>()
  const report = new Map<string, GithubSyncMerge>()
  let landed = false
  try {
    for (;;) {
      const conflicted = [...new Set(zList(await git(bin, root, ['ls-files', '-z', '--unmerged'])).map((line) => line.slice(line.indexOf('\t') + 1)))]
      if (conflicted.length === 0) return null // stopped for something that is not a conflict
      for (const rel of conflicted) {
        const settled = await settle(bin, root, rel, copies, () => authorOf(bin, root, span, rel))
        if (settled === null) return null
        if ((await git(bin, root, ['add', '-A', '--', ...settled.staged.map((p) => `:(literal)${p}`)])).code !== 0) return null
        if (settled.report === null) continue
        const prior = report.get(rel)
        report.set(rel, prior === undefined ? settled.report : { ...settled.report, clashes: prior.clashes + settled.report.clashes })
      }
      const step = await nextStep(bin, root, await authorOf(bin, root, span), parked)
      if (step === 'done') break
      if (step === 'failed') return null
    }
    landed = true
    await git(bin, root, ['update-ref', BEFORE_MERGE_REF, span.before])
    return [...report.values()]
  } finally {
    if (!landed) {
      await park(bin, root, parked)
      // Its own exit code is ignored on purpose: if even the abort failed there is nothing more a
      // pass can do, and `attention/conflict` is still the right thing to show.
      await git(bin, root, ['rebase', '--abort'])
    }
    await unpark(root, parked)
  }
}

/**
 * Commits this stop's resolution and moves on. The commit is ours rather than `--continue`'s so it
 * can carry a `Merged-with:` trailer — Version history marks merged versions by it. A resolution that
 * changed nothing (the merge equals the remote) is skipped: `--continue` refuses an empty pick.
 */
async function nextStep(bin: string, root: string, authors: string, parked: Map<string, Buffer | null>): Promise<'done' | 'again' | 'failed'> {
  const nothingStaged = (await git(bin, root, ['diff', '--cached', '--quiet'])).code === 0
  if (!nothingStaged) {
    const message = (await git(bin, root, ['log', '-1', '--format=%B', 'REBASE_HEAD'])).stdout.trim() || 'sync'
    if ((await git(bin, root, ['commit', '-q', '-m', message, '-m', `Merged-with: ${authors}`])).code !== 0) return 'failed'
  }
  await park(bin, root, parked) // as late as possible: a save landing after this is the abort path's to park
  const moved = await git(bin, root, ['-c', 'core.editor=true', 'rebase', nothingStaged ? '--skip' : '--continue'])
  if (moved.code === 0) return 'done'
  return zList(await git(bin, root, ['ls-files', '-z', '--unmerged'])).length > 0 ? 'again' : 'failed'
}

/** Settles one conflicted file on disk; null when it cannot be. */
async function settle(bin: string, root: string, rel: string, copies: Map<string, string>, author: () => Promise<string>): Promise<Settled | null> {
  const stages = await stagesOf(bin, root, rel)
  if (stages === null) return null
  const { base, theirs, mine } = stages
  // Deleted on one side, edited on the other: the edit stays (S11). Nothing to tell anyone.
  if (theirs === null || mine === null) {
    const kept = theirs ?? mine
    if (kept === null) return null
    await atomicWrite(abs(root, rel), kept)
    return { staged: [rel], report: null }
  }
  const merged = mergeText(rel, base?.toString('utf8') ?? null, theirs.toString('utf8'), mine.toString('utf8'))
  if (merged !== null) {
    await atomicWrite(abs(root, rel), merged.json)
    return { staged: [rel], report: merged.clashes === null ? null : { path: rel, author: await author(), clashes: merged.clashes } }
  }
  // D3: keep both. The remote's at the path (it is already everywhere else); ours beside it.
  const copy = copies.get(rel) ?? freeCopyName(root, rel)
  copies.set(rel, copy)
  await atomicWrite(abs(root, rel), theirs)
  await atomicWrite(abs(root, copy), mine)
  return { staged: [rel, copy], report: { path: rel, author: await author(), clashes: 0, copy } }
}

/**
 * The merge a file knows how to do, or null for keep-both. `clashes: null` marks a merge nobody
 * needs to hear about (the vault's own config files).
 */
function mergeText(rel: string, base: string | null, theirs: string, mine: string): { json: string; clashes: number | null } | null {
  if (isDrawing(rel)) return base === null ? null : mergeBoards(base, theirs, mine) // S10: two new boards are two boards
  if (isDiagram(rel)) return null // 🔒 YAZ-1802 D8: no diagram merge (yet) — keep both, never a guessed XML splice
  const quiet = (json: string | null) => (json === null ? null : { json, clashes: null })
  if (rel === SHARES_PATH) return quiet(mergeSharesFile(base, theirs, mine))
  if (rel === FAVORITES_PATH) return quiet(mergeFavoritesFile(base, theirs, mine))
  if (rel.startsWith(`${VAULT_CONFIG_DIR}/`)) return quiet(mine)
  return null
}

/** `a/Board.excalidraw` → `a/Board (conflict, 2026-09-23).excalidraw`, numbered past anything already there. */
function freeCopyName(root: string, rel: string): string {
  const dir = path.posix.dirname(rel)
  const ext = path.posix.extname(rel)
  const stem = path.posix.basename(rel, ext)
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  for (let n = 1; ; n += 1) {
    const name = `${stem} (conflict, ${day}${n === 1 ? '' : ` ${n}`})${ext}`
    const candidate = dir === '.' ? name : `${dir}/${name}`
    if (!existsSync(abs(root, candidate))) return candidate
  }
}

/** All three versions of an unmerged path, written to temp files by git and read back as bytes. */
async function stagesOf(bin: string, root: string, rel: string): Promise<Stages | null> {
  const res = await git(bin, root, ['checkout-index', '--stage=all', '--temp', '--', rel])
  if (res.code !== 0) return null
  const temps = res.stdout.split('\t')[0]?.trim().split(' ') ?? []
  if (temps.length !== 3) return null
  const [base, theirs, mine] = await Promise.all(
    temps.map(async (name) => {
      if (name === '.') return null
      const file = path.join(root, name)
      const bytes = await readFile(file)
      await rm(file, { force: true })
      return bytes
    }),
  )
  return { base, theirs, mine }
}

/**
 * Who made the remote's side, as the notice and the `Merged-with:` trailer say it: "Sara", "Sara
 * and Sam". Of one file when `rel` is given — falling back to everyone upstream when a rename hides
 * that file's own log — else of the whole span.
 */
async function authorOf(bin: string, root: string, span: RebaseSpan, rel?: string): Promise<string> {
  const names = async (only: string[]) => [...new Set(zList(await git(bin, root, ['log', '-z', '--format=%an', `${span.before}..${span.upstream}`, ...only])))]
  const own = rel === undefined ? [] : await names(['--', `:(literal)${rel}`])
  const all = own.length > 0 ? own : await names([])
  if (all.length <= 1) return all[0] ?? 'another machine'
  return `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`
}

/** Dirty tracked files — a save that landed mid-rebase — held by copy and checked out, so nothing git does next can reset them away. */
async function park(bin: string, root: string, parked: Map<string, Buffer | null>): Promise<void> {
  const dirty = zList(await git(bin, root, ['ls-files', '-z', '--modified']))
  if (dirty.length === 0) return
  for (const rel of dirty) parked.set(rel, await readFile(abs(root, rel)).catch(() => null))
  await git(bin, root, ['checkout', '--', ...dirty.map((p) => `:(literal)${p}`)])
}

/** The parked saves back on disk, newest bytes each (a deleted one deleted again). The next pass commits them. */
async function unpark(root: string, parked: Map<string, Buffer | null>): Promise<void> {
  for (const [rel, bytes] of parked) {
    if (bytes === null) await rm(abs(root, rel), { force: true })
    else await atomicWrite(abs(root, rel), bytes)
  }
}
