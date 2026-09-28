/**
 * Path containment both processes share (YAZ-2073 2D). Main's paths come from `path.join`, so on
 * Windows they read `C:\Vault\a.excalidraw` — and a hand-written `${root}/` prefix check silently
 * answered "outside" for every one of them. Pure strings, no `node:path`: the renderer uses it too.
 */

/** The separator `p` is written in: `\` for a Windows path (a `\` and no `/`), `/` for everything else. */
export const sepOf = (p: string): '/' | '\\' => (p.includes('\\') && !p.includes('/') ? '\\' : '/')

/** `p` without its trailing separators — `/` and `C:\` come back as `` and `C:`, ready to take `sep + name`. */
export const trimSep = (p: string): string => p.replace(sepOf(p) === '/' ? /\/+$/ : /\\+$/, '')

/**
 * `p` is `base` itself or inside it, by whole segment in `base`'s own separator — so `/v` never
 * contains `/vault/x`. A trailing separator on `base` is ignored (`/` and `C:\` contain everything
 * under them). `strict` leaves `base` itself out.
 */
export function isWithin(base: string, p: string, strict = false): boolean {
  const b = trimSep(base)
  if (p === b) return !strict
  return p.startsWith(b + sepOf(base)) && (!strict || p.length > b.length + 1)
}
