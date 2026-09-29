import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ATOMIC_TMP_HEX_LEN } from '@shared/fileKind'
import { atomicWrite } from '../fs/fsUtils'

/**
 * THE VAULT'S `.gitignore`, kept honest before every sync commit (YAZ-1829).
 *
 * `syncPass` used to stage everything, so anything the OS dropped in the vault was committed and
 * pushed — Finder's `.DS_Store` in every folder the user had ever opened, one per sync commit
 * subject. Staging is scoped to boards now (ACT-370, `SYNC_SCOPE` in `sync.ts`), but the ignore
 * entries still earn their keep: `.gitignore` itself is in the scope, and a `.DS_Store` an older
 * version committed is untracked here.
 * The user's own vault is not ours to reorganise, so this is APPEND-ONLY: a missing entry is
 * added at the end, every line already there is left byte-for-byte, and a vault that already
 * ignores the entry is not touched at all.
 */

/** What every vault this app syncs ignores: Finder's droppings, and the tmp file a crashed atomic write left (`isAtomicTmp`). */
export const VAULT_IGNORED = ['.DS_Store', `*.tmp-${'?'.repeat(ATOMIC_TMP_HEX_LEN)}`] as const

/**
 * The file's new contents, or null when it already covers every entry. Pure, so the whole rule is
 * testable without a filesystem: comparison is on TRIMMED lines, because `.DS_Store ` and a
 * leading-whitespace copy are the same rule to git. Also keeps `.git/info/attributes`' board rule
 * (YAZ-1897 D2, `resolve.ts`) — the same append-only rule for a file of git patterns.
 */
export function withLines(current: string | null, entries: readonly string[]): string | null {
  const lines = current === null ? [] : current.split('\n').map((line) => line.trim())
  const missing = entries.filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return null
  const body = current === null || current === '' ? '' : current.endsWith('\n') ? current : `${current}\n`
  return `${body}${missing.join('\n')}\n`
}

/** Writes the entries into `<root>/.gitignore` if any are missing; true when the file changed. */
export async function ensureVaultIgnores(root: string, entries: readonly string[] = VAULT_IGNORED): Promise<boolean> {
  const file = path.join(root, '.gitignore')
  const current = await readFile(file, 'utf8').catch(() => null)
  const next = withLines(current, entries)
  if (next === null) return false
  await atomicWrite(file, next)
  return true
}
