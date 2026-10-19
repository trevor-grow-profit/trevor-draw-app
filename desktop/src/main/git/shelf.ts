import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { git, type GitResult } from './exec'

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Never restore through a parent symlink introduced by an incoming checkout. */
async function checkParents(root: string, rel: string): Promise<void> {
  let current = root
  for (const part of rel.split('/').slice(0, -1)) {
    current = path.join(current, part)
    const st = await lstat(current).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (st !== null && !st.isDirectory()) throw new Error(`Cannot restore through a symlink or non-directory: ${current}`)
  }
}

/** Durable, private recovery data. A crash or failed restore must never discard the only copy. */
const recoveryDirs = new Map<string, string>()

async function recoveryDir(bin: string, root: string): Promise<string> {
  const cached = recoveryDirs.get(root)
  if (cached !== undefined) return cached
  const result = await git(bin, root, ['rev-parse', '--git-path', 'trevor-draw-recovery'])
  if (result.code !== 0) throw new Error(result.stderr)
  const dir = path.resolve(root, result.stdout.trim())
  recoveryDirs.set(root, dir)
  return dir
}

export async function assertNoPendingShelf(bin: string, root: string): Promise<void> {
  const dir = await recoveryDir(bin, root)
  if (await lstat(dir).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false
    throw err
  })) throw new Error(`Sync paused: files from an interrupted sync are preserved in ${dir}. Recover them before syncing again.`)
}

function checked(result: GitResult): string[] {
  if (result.code !== 0) throw new Error(result.stderr || 'Could not inspect files before syncing')
  return result.stdout.split('\0').filter(Boolean)
}

/** Shelve tracked edits AND untracked non-board files before Git checks out the upstream tree.
 * Back up everything before changing anything. Keep the manifest and copies on any failure.
 * Local bytes return to their original paths; incoming versions remain available in Git history.
 */
export async function shelfOutsideScope(bin: string, root: string, specs: readonly string[]): Promise<{ restore: () => Promise<void> } | null> {
  await assertNoPendingShelf(bin, root)
  const tracked = checked(await git(bin, root, ['ls-files', '-z', '--modified', '--', ...specs]))
  const untracked = checked(await git(bin, root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...specs]))
  const rels = [...new Set([...tracked, ...untracked])]
  if (rels.length === 0) return null
  const dir = await recoveryDir(bin, root)
  await mkdir(dir)
  const entries: Array<{ rel: string; copy: string | null; mode: number }> = []
  // No worktree changes until the full backup and manifest exist.
  try {
    for (const [i, rel] of rels.entries()) {
      const source = path.join(root, rel)
      const st = await lstat(source).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (st !== null && !st.isFile()) throw new Error(`Cannot safely shelve ${rel}: expected a regular file`)
      const copy = st === null ? null : String(i)
      if (copy !== null) await copyFile(source, path.join(dir, copy))
      entries.push({ rel, copy, mode: st?.mode ?? 0 })
    }
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ root, entries }, null, 2))
  } catch (err) {
    // Originals have not been touched; an incomplete backup is safe to remove.
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  const restore = async () => {
    try {
      // Another editor may have written during the rebase. Never overwrite those newer bytes.
      const changed = new Set([
        ...checked(await git(bin, root, ['diff', '--name-only', '-z', 'HEAD'])),
        ...checked(await git(bin, root, ['ls-files', '--others', '--exclude-standard', '-z'])),
      ])
      for (const { rel, copy } of entries) {
        await checkParents(root, rel)
        const target = path.join(root, rel)
        const st = await lstat(target).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null
          throw err
        })
        if (st !== null && !st.isFile()) throw new Error(`Cannot restore over a directory or symlink: ${rel}`)
        if (changed.has(rel)) {
          const same = copy === null ? st === null : st !== null && await digest(target) === await digest(path.join(dir, copy))
          if (!same) throw new Error(`File changed during sync: ${rel}. Its current version was left in place.`)
        }
      }
      for (const { rel, copy, mode } of entries) {
        const target = path.join(root, rel)
        if (copy === null) await rm(target, { force: true })
        else {
          await mkdir(path.dirname(target), { recursive: true })
          await copyFile(path.join(dir, copy), target)
          await chmod(target, mode)
          if (await digest(target) !== await digest(path.join(dir, copy))) throw new Error(`Restored bytes differ: ${rel}`)
        }
      }
    } catch (err) {
      throw new Error(`Sync recovery needed. Original files are preserved in ${dir}. ${String(err)}`)
    }
    await rm(dir, { recursive: true, force: true })
  }
  try {
    if (tracked.length > 0) {
      const checkout = await git(bin, root, ['checkout', '--', ...tracked.map((rel) => `:(literal)${rel}`)])
      if (checkout.code !== 0) throw new Error(checkout.stderr)
    }
    for (const rel of untracked) await rm(path.join(root, rel))
  } catch (err) {
    await restore()
    throw err
  }
  return { restore }
}
