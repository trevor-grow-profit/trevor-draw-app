import { boardBaseName } from '@shared/fileKind'
import { isWithin, sepOf, trimSep } from '@shared/paths'

/** Last path segment in the path's own separator (trailing ones ignored); the input itself for `/`. */
export function basename(p: string): string {
  const trimmed = trimSep(p)
  return trimmed.slice(trimmed.lastIndexOf(sepOf(p)) + 1) || p
}

/** File name without its board extension (`fileKind`'s contract); every other name is returned whole. */
export const stripExt = boardBaseName

/** The folder a board sits in, relative to the vault — `/` at the root (Info 🔒 YAZ-1835 D7, the hover preview 🔒 YAZ-1800 D4). */
export function boardFolder(root: string, path: string): string {
  const rel = isWithin(root, path, true) ? path.slice(trimSep(root).length + 1) : path
  const cut = rel.lastIndexOf(sepOf(root))
  return cut === -1 ? '/' : rel.slice(0, cut)
}

/**
 * A vault-relative POSIX path (git's, e.g. sync's `tooLarge`) as the absolute path the tree uses,
 * in the ROOT's own separator: `C:\Notes` + `a/b.mov` → `C:\Notes\a\b.mov` on Windows, where
 * main's tree paths come from `path.join`. A root with any `/` is treated as POSIX.
 */
export function vaultPath(root: string, rel: string): string {
  const sep = sepOf(root)
  return `${trimSep(root)}${sep}${sep === '/' ? rel : rel.split('/').join(sep)}`
}
