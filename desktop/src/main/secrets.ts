/**
 * THE SECRETS DOOR (🔒 YAZ-1842 D1, amending YAZ-1775 D4; YAZ-1817): `userData/secrets.json` =
 * `{ version: 2, values: Record<name, value> }`, plain text, owner-only (mode 0600).
 *
 * THE RULE, and it has no exceptions: **the renderer never receives a value.** It may write one
 * (`set`) and ask whether one is there (`has`); reading (`read`) is main's alone — YAZ-1818's provider
 * code calls it when it builds a Pixabay request. That is why the Pixabay key is not a
 * `SettingsState` field: the store is broadcast to every window on every change, and a key in it
 * would be a key in every renderer's devtools console.
 *
 * WHY PLAIN TEXT (YAZ-1842). Version 1 encrypted values with Electron's `safeStorage`, which on
 * macOS keys on a Keychain item bound to the app's code identity. This app is ad-hoc signed (no
 * Developer ID, locked), so every build is a different identity to the Keychain: a key written by
 * one build could not be read by the next, `has` answered false, and the Settings row looked
 * broken. The file lives in the user's own Library, never in a vault, and is readable only by the
 * user — the same protection as an `.env` file. A version-1 file is treated as corrupt (moved
 * aside), so the next paste starts clean rather than half-migrating blobs nobody can open.
 *
 * Lazy, like every other file this app owns: reading never creates the file; a corrupt one is
 * moved aside as `secrets.json.corrupt-<epoch>` (the `store.ts` posture). Writes are atomic and
 * chained.
 */

import { stat } from 'node:fs/promises'
import { isRecord } from '@shared/guards'
import { atomicWrite, fsCall } from './fs/fsUtils'
import { createChain, readOrQuarantine } from './watchedFolder'

export const SECRETS_FILE = 'secrets.json'
/** Owner read/write only — the whole reason the file may hold plain text. */
export const SECRETS_FILE_MODE = 0o600
const VERSION = 2

export interface Secrets {
  /** Store `value`, or clear the name with null. */
  set(name: string, value: string | null): Promise<void>
  /** Whether a value is stored. The only question a renderer may ask. */
  has(name: string): Promise<boolean>
  /** The value, for MAIN only (YAZ-1818's providers). Null when absent. */
  read(name: string): Promise<string | null>
}

type Values = Record<string, string>

export function createSecrets(file: string): Secrets {
  /** Writes chain so two read-modify-writes never interleave. */
  const chain = createChain()
  /**
   * The parsed file, kept while its mtime says nothing has changed. `providers.ts` asks for the key
   * on every search, every preview and every import, and re-reading plus re-parsing the file each
   * time is the cost this saves; the mtime check keeps an outside edit honest for one `stat`.
   */
  let cached: { mtimeMs: number; values: Values } | null = null

  const parse = (raw: unknown): Values | null =>
    isRecord(raw) && raw.version === VERSION && isRecord(raw.values)
      ? Object.fromEntries(Object.entries(raw.values).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : null

  async function load(): Promise<Values> {
    const mtimeMs = await stat(file).then((st) => st.mtimeMs, () => null)
    if (mtimeMs === null) return {}
    if (cached !== null && cached.mtimeMs === mtimeMs) return cached.values
    const values = (await readOrQuarantine(file, parse, 'secrets', 'a valid secrets file')) ?? {}
    cached = { mtimeMs, values }
    return values
  }

  const read = async (name: string): Promise<string | null> => (await load())[name] ?? null

  return {
    set(name, value) {
      return chain.run(async () => {
        const values = { ...(await load()) }
        if (value === null) delete values[name]
        else values[name] = value
        // Owner-only from the tmp file's creation, so the value is never briefly world-readable (YAZ-2073 D12).
        const { mtime } = await fsCall(file, () => atomicWrite(file, `${JSON.stringify({ version: VERSION, values }, null, 2)}\n`, SECRETS_FILE_MODE))
        cached = { mtimeMs: mtime, values }
      })
    },
    has: (name) => read(name).then((v) => v !== null),
    read,
  }
}
