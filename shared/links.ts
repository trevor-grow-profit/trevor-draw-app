/**
 * The `yaseendraw://` deep-link format (E1, GRO-2171; locked decision D7): path-only,
 * absolute, percent-encoded — `yaseendraw:///Users/me/vault/My%20note.md` — no vault id.
 * An optional `?root=` (also a percent-encoded absolute path) overrides which folder the
 * link opens under. Shared so main's parser and the client's generator agree byte-for-byte
 * on one encoding.
 */

const SCHEME = 'yaseendraw://'

/**
 * `encodeURI` keeps `/` readable and encodes spaces/unicode, but leaves `#` and `?` alone —
 * either would truncate the path on parse, so they get encoded on top.
 */
const encodePath = (path: string): string => encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')

/**
 * A Windows drive path rides the link the way `file:///C:/…` does (YAZ-2073 2D): `C:\Vault\a` →
 * `/C:/Vault/a`, which `parseFileLink` turns back into `C:\Vault\a`. A POSIX path is untouched.
 */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/
const DRIVE_IN_LINK = /^\/[A-Za-z]:\//
const toLinkPath = (path: string): string => (DRIVE_PATH.test(path) ? `/${path.replace(/\\/g, '/')}` : path)
/** The absolute path a decoded link path names — a drive path back in its own `\` — or null. */
const fromLinkPath = (path: string): string | null =>
  DRIVE_IN_LINK.test(path) ? path.slice(1).replace(/\//g, '\\') : path.startsWith('/') ? path : null

/** The `yaseendraw://` link that opens `path` (absolute). */
export function fileLink(path: string): string {
  return SCHEME + encodePath(toLinkPath(path))
}

/** `decodeURIComponent` that answers null for malformed percent-encoding instead of throwing. */
function decode(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

/**
 * Parses a `yaseendraw://` link back to its absolute path (+ optional `?root=` override).
 * Null for any other scheme, a relative/empty path, or malformed percent-encoding. Manual
 * string parsing on purpose: `new URL()` host-parses the double-slash form
 * (`yaseendraw://Users/...`) unpredictably for non-special schemes — here it simply decodes
 * to a relative path and is rejected.
 */
export function parseFileLink(url: string): { path: string; root: string | null } | null {
  if (!url.startsWith(SCHEME)) return null
  let rest = url.slice(SCHEME.length)
  let root: string | null = null
  const q = rest.indexOf('?')
  if (q !== -1) {
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=')
      if (eq === -1 || pair.slice(0, eq) !== 'root') continue
      const decoded = decode(pair.slice(eq + 1))
      if (decoded === null) return null
      // A non-absolute override could never contain the (absolute) path: no override at all.
      root = fromLinkPath(decoded) ?? root
    }
    rest = rest.slice(0, q)
  }
  const decoded = decode(rest)
  const path = decoded === null ? null : fromLinkPath(decoded)
  if (path === null) return null
  return { path, root }
}
