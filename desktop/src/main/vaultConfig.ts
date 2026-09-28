import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { VAULT_CONFIG_DIR, type VaultConfigChange } from '@shared/types'
import { atomicWrite, BridgeFailure, fsCall, requireAbsPath, toBridgeFailure } from './fs/fsUtils'
import { createWatchedFolder, type WatchedFolder } from './watchedFolder'

/**
 * Vault-local config store (Desktop J, GRO-2188): JSON files in `<root>/.yaseendraw/`, the
 * `.obsidian/`-style dotfolder that travels with the vault. Electron-free, like `store.ts`.
 *
 * Lazy: reading never creates anything; the dotfolder appears on the first `writeConfig`
 * (`mkdir -p` + the `atomicWrite` tmp+rename idiom, pretty-printed JSON).
 *
 * Watching: the shared vault watcher (`fs/watchers.ts`) ignores every dot-entry by design, so
 * this module runs its own watcher per root, scoped to the dotfolder path. The engine
 * (`fs/treeWatcher.ts`) waits for a not-yet-existing path, so the watcher is attached at first
 * subscribe whether or not the folder exists — it creates nothing, and an external
 * `mkdir .yaseendraw` + write by a sync tool is still picked up live. One caveat (verified): the
 * polling fallback loses the path for good when the folder appears DURING its initialisation, so
 * the first `writeConfig` that creates the folder re-`add()`s it once — the debounce absorbs any
 * duplicate events after a re-add. Same lifecycle idioms as `fs/watchers.ts`:
 * one watcher per root, shared listener set, closed on the last unsubscribe.
 *
 * Echo policy: `writeConfig` notifies this process's subscribers synchronously (so every window
 * of the vault hears about a write from any of them), and the watcher's later echo of that same
 * write is dropped by mtime — the app's standard echo-suppression pattern (docs/CONTRACTS.md,
 * "Bridge API"). A genuinely external edit has a different mtime and notifies as usual,
 * debounced/deduped to one `{ root, name }` per file.
 */

/**
 * Re-exported, not re-declared (YAZ-861): the name lives in `@shared/types` so main and the
 * client's adoption probe can never drift. This module owns the dotfolder, so it keeps naming it.
 */
export { VAULT_CONFIG_DIR }

type Listener = (change: VaultConfigChange) => void

interface Entry {
  watched: WatchedFolder
  listeners: Set<Listener>
}

/** One watcher per root's dotfolder, shared by every subscriber; closed when the last one leaves. */
const entries = new Map<string, Entry>()

export function activeConfigWatcherRoots(): string[] {
  return [...entries.keys()]
}

/** A config name is a plain `<stem>.json` basename: no separators, no `..`, nothing else. */
function requireConfigName(name: unknown): string {
  if (name === undefined || name === '') throw new BridgeFailure('BAD_REQUEST', "missing 'name'")
  if (typeof name !== 'string' || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
    throw new BridgeFailure('BAD_REQUEST', "'name' must be a plain file name", { path: String(name) })
  }
  if (!name.endsWith('.json') || name === '.json') {
    throw new BridgeFailure('UNSUPPORTED_EXTENSION', 'only .json files live in .yaseendraw', { path: name })
  }
  return name
}

export type ConfigRead = { state: 'absent' } | { state: 'ok'; value: unknown } | { state: 'malformed'; error: string; file: string }

/**
 * Like `readConfig`, but distinguishes a missing file from malformed JSON and leaves the
 * reporting to the caller — the corrupt-file semantics layered on top need the difference
 * (absent → an empty result, malformed → error surfaced, mutations refused).
 * NEVER creates the folder.
 */
export async function readConfigDetailed(root: string, name: string): Promise<ConfigRead> {
  const dir = requireAbsPath(root, 'root')
  const file = path.join(dir, VAULT_CONFIG_DIR, requireConfigName(name))
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' }
    throw toBridgeFailure(err, file)
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) as unknown }
  } catch (err) {
    return { state: 'malformed', error: String(err), file }
  }
}

/** Parsed `<root>/.yaseendraw/<name>`, or null when missing or malformed. NEVER creates the folder. */
export async function readConfig(root: string, name: string): Promise<unknown> {
  const res = await readConfigDetailed(root, name)
  if (res.state === 'ok') return res.value
  // Malformed config (half-synced file, hand edit) must not throw across IPC: warn once, act as absent.
  if (res.state === 'malformed') console.warn(`[vaultConfig] ${res.file} is not valid JSON: ${res.error}`)
  return null
}

/** `mkdir -p` the dotfolder lazily, then an atomic pretty-printed write; own subscribers notified synchronously. */
export async function writeConfig(root: string, name: string, value: unknown): Promise<void> {
  const r = requireAbsPath(root, 'root')
  const n = requireConfigName(name)
  const content: string | undefined = JSON.stringify(value, null, 2)
  if (content === undefined) throw new BridgeFailure('BAD_REQUEST', "'value' must be JSON-serialisable")
  const dir = path.join(r, VAULT_CONFIG_DIR)
  const file = path.join(dir, n)
  const { mtime } = await fsCall(file, async () => {
    await mkdir(dir, { recursive: true })
    return atomicWrite(file, `${content}\n`)
  })
  const entry = entries.get(r)
  if (entry !== undefined) {
    entry.watched.noteOwnWrite(file, mtime)
    entry.listeners.forEach((l) => l({ root: r, name: n }))
  }
}

function createEntry(root: string): Entry {
  const dir = path.join(root, VAULT_CONFIG_DIR)
  const entry: Entry = {
    listeners: new Set(),
    watched: createWatchedFolder({
      dir,
      tag: 'vaultConfig',
      // Only config files directly in the dotfolder count — atomicWrite tmp files and subdirs don't.
      relevant: (p, d) => path.dirname(p) === d && p.endsWith('.json'),
      onChange: (paths) => {
        for (const name of new Set(paths.map((p) => path.basename(p)))) entry.listeners.forEach((l) => l({ root, name }))
      },
    }),
  }
  return entry
}

/** Subscribes to config changes under `root`; returns an unsubscribe fn. Attaching creates nothing on disk. */
export function subscribeConfig(root: string, listener: Listener): () => void {
  const r = requireAbsPath(root, 'root')
  let entry = entries.get(r)
  if (entry === undefined) {
    entry = createEntry(r)
    entries.set(r, entry)
  }
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0 && entries.get(r) === entry) {
      entries.delete(r)
      void entry.watched.close()
    }
  }
}
