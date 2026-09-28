import type { GithubSyncConfig, GithubSyncStatus, VaultConfigChange, WatchEvent } from '@shared/types'
import { isRecord } from '@shared/guards'
import type { RemoteLook } from './sync'

/**
 * Per-root sync orchestration (YAZ-1081 2B): WHEN a pass runs, and what the app is told about it.
 * `sync.ts` owns what a pass does; this module owns the clock, the serialisation and the adoption.
 *
 * Electron-free by construction — every edge (config store, vault watcher, status broadcast, the
 * pass itself) arrives through `GitSyncHost`, so the whole state machine is testable with a fake
 * host and no git, no filesystem and no window. Production wiring is a later issue.
 *
 * The cadence (YAZ-1081 D2/D3), in one place so it can be argued with:
 *   - ADOPTION pulls. Opening a vault is the moment the user is most likely to be looking at
 *     stale content, so a root turns on with a pass (D3).
 *   - EDITS settle first. Watcher events mark the root `pending` immediately — the UI should say
 *     "not saved to GitHub yet" the instant a key is pressed — then a trailing-edge debounce
 *     (`quietMs`, default 30 s) waits for the user to stop typing before committing. Same idiom
 *     as the index cache's persist debounce, `.unref()` included: a timer must never be the reason
 *     the app won't quit; `flushForQuit` is what guarantees the last write lands.
 *   - OFFLINE waits patiently. A pass that comes back `pending` arms exactly one retry
 *     (`retryMs`, default 2 min). No backoff ladder, no jitter: this is a text editor, not a
 *     replication service, and `notifyWake`/`notifyFocus` already cover the common "laptop came
 *     back" case sooner than any ladder would.
 *   - FOCUS and WAKE pull, behind a short cooldown, so alt-tabbing between two machines converges
 *     without turning window focus into a git spam button.
 *   - IDLE pulls too (YAZ-1897 D6): a vault whose last pass ended `synced` runs a QUIET pass every
 *     `pollMs` (default 60 s), so a board someone is only looking at still receives the other
 *     machine's shapes. Never while edits are settling (the debounce's pass is coming anyway, and
 *     a pass kept away from active drawing is a pass that never meets a mid-rebase save), never
 *     while `pending` (the retry owns it) or `attention` (the next edit or focus does). Quiet means
 *     no `syncing` flash on the chip every minute — only the result is broadcast. It LOOKS first
 *     (`host.lookAtRemote`, YAZ-2073 5H): two git spawns, and the full pass only when there is news —
 *     which it does not fetch a second time.
 *
 * Two invariants everything else is built to protect:
 *   - ONE pass at a time per root, and a burst of triggers during a running pass collapses into
 *     exactly ONE follow-up. Concurrent passes would race on `.git/index.lock` and could push a
 *     half-staged tree; an uncoalesced queue would let a 50-file save turn into 50 commits.
 *   - A DISABLED root is completely silent: no vault subscription, no timers, no passes, nothing.
 *     Sync is opt-in per vault (D4) and "off" has to mean off, not "quiet".
 */

/** The per-vault switch, read and written through the host's config store. */
export const GITHUB_SYNC_FILE = 'github.json'

const DEFAULT_QUIET_MS = 30_000
const DEFAULT_RETRY_MS = 120_000
const DEFAULT_FOCUS_COOLDOWN_MS = 10_000
const DEFAULT_POLL_MS = 60_000

export interface GitSyncHost {
  readConfig(root: string, name: string): Promise<unknown>
  writeConfig(root: string, name: string, value: unknown): Promise<void>
  subscribeVault(root: string, listener: (ev: WatchEvent) => void): () => void
  subscribeConfig(root: string, listener: (change: VaultConfigChange) => void): () => void
  onStatus(status: GithubSyncStatus): void
  /** `flush` is the quit variant (YAZ-1111): commit always, no fetch/rebase, short-capped push. `fetched`: origin was fetched a moment ago. */
  syncPass(root: string, opts?: { flush?: boolean; fetched?: boolean }): Promise<GithubSyncStatus>
  /** The idle pull's cheap look (YAZ-2073 5H): `level` only when the branch and its remote provably are. */
  lookAtRemote(root: string): Promise<RemoteLook>
  /** Optional read-only facts for an unmanaged (off) root — the settings panel wants remote/branch even when sync is off. */
  inspect?(root: string): Promise<GithubSyncStatus>
  quietMs?: number
  retryMs?: number
  focusCooldownMs?: number
  pollMs?: number
}

export interface GitSyncManager {
  setOpenRoots(roots: readonly string[]): void
  status(root: string): Promise<GithubSyncStatus>
  syncNow(root: string): Promise<GithubSyncStatus>
  setEnabled(root: string, enabled: boolean): Promise<GithubSyncStatus>
  notifyFocus(root: string): void
  notifyWake(): void
  flushForQuit(): Promise<void>
}

/** Everyone who asked for a pass while one was running shares this single follow-up's result. */
interface Follow {
  promise: Promise<GithubSyncStatus>
  resolve: (status: GithubSyncStatus) => void
}

/** One managed (enabled) root. Roots that are merely open have no entry — that is guarantee 3. */
interface Entry {
  unsubVault: () => void
  /** Last status broadcast for this root; `status()` answers from here without touching git. */
  last: GithubSyncStatus
  /** `Date.now()` when the last pass FINISHED — the focus/wake cooldown reads this. */
  lastPassAt: number
  busy: boolean
  follow: Follow | null
  debounce: ReturnType<typeof setTimeout> | null
  retry: ReturnType<typeof setTimeout> | null
  /** The idle pull (D6): armed only after a pass that ended `synced` with no edits settling. */
  poll: ReturnType<typeof setTimeout> | null
  /** Set by `drop`: a pass already in flight must not broadcast or spawn a follow-up after it. */
  dropped: boolean
}


/** `flush` is the quit variant (YAZ-1111); `poll` is the idle pull (YAZ-1897 D6), which shows no `syncing` and looks first (YAZ-2073 5H). */
type PassMode = 'normal' | 'flush' | 'poll'

/** Every timer an entry can hold, cleared at once — on drop and before the quit flush. */
function clearTimers(entry: Entry): void {
  for (const timer of [entry.debounce, entry.retry, entry.poll]) if (timer !== null) clearTimeout(timer)
  entry.debounce = null
  entry.retry = null
  entry.poll = null
}

/** Unref'd throughout: a sync timer must never hold the app open (the index cache's idiom). */
function arm(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return timer
}

export function createGitSync(host: GitSyncHost): GitSyncManager {
  const quietMs = host.quietMs ?? DEFAULT_QUIET_MS
  const retryMs = host.retryMs ?? DEFAULT_RETRY_MS
  const focusCooldownMs = host.focusCooldownMs ?? DEFAULT_FOCUS_COOLDOWN_MS
  const pollMs = host.pollMs ?? DEFAULT_POLL_MS

  /** Enabled roots only. */
  const entries = new Map<string, Entry>()
  /** Every OPEN root, enabled or not — a `github.json` pulled from another machine has to be heard. */
  const configSubs = new Map<string, () => void>()
  const openRoots = new Set<string>()
  /** Per-root chain so two adopt/drop evaluations can never interleave their `readConfig`s. */
  const evaluations = new Map<string, Promise<void>>()
  /** `setOpenRoots` is synchronous but adoption is not; quit waits on this before flushing. */
  let settling: Promise<void> = Promise.resolve()

  function broadcast(root: string, status: GithubSyncStatus): void {
    const entry = entries.get(root)
    // `merged` is news about ONE pass (YAZ-1897): kept out of `last`, so a late `status()` never replays the notice.
    if (entry !== undefined) entry.last = status.merged === undefined ? status : { ...status, merged: undefined }
    try {
      host.onStatus(status)
    } catch (err) {
      console.warn(`[git-sync] status listener threw for ${root}: ${String(err)}`)
    }
  }

  /**
   * A transitional status that keeps the repo facts the UI is already showing — and the held-back
   * list (YAZ-1801 D3), so a file's cloud-off icon does not blink away for the length of every
   * pass. Only a finished pass may clear it. A `too-large` result is otherwise an ordinary
   * `attention`: no retry is armed (only `pending` arms one), the next edit, focus or wake runs
   * the next pass, and that pass re-checks the files from scratch — nothing here loops.
   */
  function carry(root: string, state: 'syncing' | 'pending', entry: Entry): GithubSyncStatus {
    const next: GithubSyncStatus = { root, state, enabled: true }
    if (entry.last.repo !== undefined) next.repo = entry.last.repo
    if (entry.last.tooLarge !== undefined) next.tooLarge = entry.last.tooLarge
    return next
  }

  // ---------- the serialisation core ----------

  /**
   * The only way a pass ever starts. Idle → run now; busy → join (or create) the ONE follow-up.
   * Unmanaged roots answer `off` without doing anything, so every caller can be unconditional.
   */
  function requestPass(root: string, mode: PassMode = 'normal'): Promise<GithubSyncStatus> {
    const entry = entries.get(root)
    if (entry === undefined) return Promise.resolve({ root, state: 'off', enabled: false })
    if (!entry.busy) return runPass(root, entry, mode)
    if (entry.follow === null) {
      let resolve: (status: GithubSyncStatus) => void = () => {}
      const promise = new Promise<GithubSyncStatus>((r) => {
        resolve = r
      })
      entry.follow = { promise, resolve }
    }
    return entry.follow.promise
  }

  /**
   * One pass, start to finish. Never rejects: a host that throws is classified like any other
   * failure, because a rejected promise here would take out a debounce timer's `void` call.
   *
   * `busy` stays true across the result broadcast on purpose — a listener that calls `syncNow`
   * synchronously from `onStatus` must coalesce into the follow-up rather than start a second
   * pass alongside the one that is about to start.
   */
  async function runPass(root: string, entry: Entry, mode: PassMode = 'normal'): Promise<GithubSyncStatus> {
    entry.busy = true
    for (const timer of [entry.retry, entry.poll]) if (timer !== null) clearTimeout(timer)
    entry.retry = null
    entry.poll = null
    if (mode !== 'poll') broadcast(root, carry(root, 'syncing', entry))

    let status: GithubSyncStatus
    try {
      // The idle pull looks before it leaps (YAZ-2073 5H): a level remote leaves the root exactly
      // as the last pass did, so that status stands, and it arms the next pull below.
      const look = mode === 'poll' ? await host.lookAtRemote(root) : 'unknown'
      if (look === 'level') status = entry.last
      else if (mode === 'flush') status = await host.syncPass(root, { flush: true })
      else status = await host.syncPass(root, look === 'moved' ? { fetched: true } : undefined)
    } catch (err) {
      status = { root, state: 'attention', attention: 'error', message: String(err) }
    }
    // The switch's honest read-back (YAZ-1081 3B): a managed root is `enabled: true` even when
    // the pass answers `off` (not a repo / no remote yet) — the settings switch reads this field,
    // so clicking On never looks like it did nothing.
    status = { ...status, enabled: !entry.dropped }
    // A look that found both tips level counts as a pass here: the cadence runs from it.
    entry.lastPassAt = Date.now()

    if (!entry.dropped) {
      // A quiet pull that changed nothing says nothing: no IPC to every window once a minute.
      if (mode !== 'poll' || JSON.stringify(status) !== JSON.stringify(entry.last)) broadcast(root, status)
      // Offline. Exactly one timer, replaced by (not stacked on) the next pass's.
      if (status.state === 'pending') {
        entry.retry = arm(retryMs, () => {
          entry.retry = null
          void requestPass(root)
        })
      }
      // D6: idle and in step → look again in a minute. Exactly one timer, replaced by the next pass's.
      if (status.state === 'synced' && entry.debounce === null && mode !== 'flush') {
        entry.poll = arm(pollMs, () => {
          entry.poll = null
          void requestPass(root, 'poll')
        })
      }
    }

    const follow = entry.follow
    entry.follow = null
    entry.busy = false
    if (follow === null) return status
    if (entry.dropped) follow.resolve(status)
    else void runPass(root, entry).then(follow.resolve, () => follow.resolve(status))
    return status
  }

  // ---------- adoption / drop ----------

  /** `{ enabled: true }` exactly; every other shape (absent, malformed, `"true"`) means off. */
  async function readEnabled(root: string): Promise<boolean> {
    const raw = await host.readConfig(root, GITHUB_SYNC_FILE).catch(() => null)
    return isRecord(raw) && raw.enabled === true
  }

  function adopt(root: string): Promise<GithubSyncStatus> {
    if (entries.has(root)) return requestPass(root)
    const entry: Entry = {
      unsubVault: () => {},
      last: { root, state: 'off', enabled: true },
      lastPassAt: 0,
      busy: false,
      follow: null,
      debounce: null,
      retry: null,
      poll: null,
      dropped: false,
    }
    entries.set(root, entry)
    entry.unsubVault = host.subscribeVault(root, (ev) => {
      onVaultEvent(root, ev)
    })
    // D3: opening a vault is itself a trigger — adoption pulls.
    return requestPass(root)
  }

  function drop(root: string): void {
    const entry = entries.get(root)
    if (entry === undefined) return
    entry.dropped = true
    clearTimers(entry)
    entries.delete(root)
    try {
      entry.unsubVault()
    } catch (err) {
      console.warn(`[git-sync] unsubscribe threw for ${root}: ${String(err)}`)
    }
    // Anyone waiting on a follow-up that will now never run gets the honest answer.
    const follow = entry.follow
    entry.follow = null
    follow?.resolve({ root, state: 'off', enabled: false })
  }

  /** Re-reads `github.json` and adopts or drops to match it. Serialised per root. */
  function evaluate(root: string): Promise<void> {
    const prev = evaluations.get(root) ?? Promise.resolve()
    const run = prev.then(
      () => reconcile(root),
      () => reconcile(root),
    )
    evaluations.set(
      root,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  async function reconcile(root: string): Promise<void> {
    if (!openRoots.has(root)) return
    const enabled = await readEnabled(root)
    if (!openRoots.has(root)) return // closed while we were reading
    if (enabled) {
      if (!entries.has(root)) void adopt(root)
      return
    }
    if (entries.has(root)) {
      drop(root)
      broadcast(root, { root, state: 'off', enabled: false })
    }
  }

  // ---------- triggers ----------

  function onVaultEvent(root: string, ev: WatchEvent): void {
    // `ready` is the watcher announcing itself and `error` is about the watcher, not the vault —
    // neither means a byte changed on disk.
    if (ev.type === 'ready' || ev.type === 'error') return
    const entry = entries.get(root)
    if (entry === undefined) return
    // The first event of a burst is what the UI needs to hear; the other forty-nine say the same thing.
    if (entry.last.state !== 'pending') broadcast(root, carry(root, 'pending', entry))
    if (entry.debounce !== null) clearTimeout(entry.debounce)
    // D6: edits are settling — the debounce's pass replaces the idle pull.
    if (entry.poll !== null) clearTimeout(entry.poll)
    entry.poll = null
    entry.debounce = arm(quietMs, () => {
      entry.debounce = null
      void requestPass(root)
    })
  }

  function ensureOpen(root: string): void {
    if (openRoots.has(root)) return
    openRoots.add(root)
    configSubs.set(
      root,
      host.subscribeConfig(root, (change) => {
        if (change.name !== GITHUB_SYNC_FILE) return
        void evaluate(root)
      }),
    )
  }

  function close(root: string): void {
    openRoots.delete(root)
    drop(root)
    const unsub = configSubs.get(root)
    configSubs.delete(root)
    evaluations.delete(root)
    if (unsub === undefined) return
    try {
      unsub()
    } catch (err) {
      console.warn(`[git-sync] config unsubscribe threw for ${root}: ${String(err)}`)
    }
  }

  return {
    setOpenRoots(roots) {
      const wanted = new Set(roots)
      for (const root of [...openRoots]) if (!wanted.has(root)) close(root)
      const fresh: string[] = []
      for (const root of wanted) {
        if (openRoots.has(root)) continue
        ensureOpen(root)
        fresh.push(root)
      }
      // Adoption is async; `flushForQuit` joins here so a quit right after an open still flushes.
      settling = settling.then(
        () => Promise.all(fresh.map((root) => evaluate(root))).then(() => undefined),
        () => undefined,
      )
    },

    async status(root) {
      const entry = entries.get(root)
      if (entry !== undefined) return entry.last
      if (host.inspect !== undefined) {
        try {
          return { ...(await host.inspect(root)), enabled: false }
        } catch (err) {
          console.warn(`[git-sync] inspect failed for ${root}: ${String(err)}`)
        }
      }
      return { root, state: 'off', enabled: false }
    },

    syncNow(root) {
      return requestPass(root)
    },

    async setEnabled(root, enabled) {
      await host.writeConfig(root, GITHUB_SYNC_FILE, { enabled } satisfies GithubSyncConfig)
      if (!enabled) {
        drop(root)
        const off: GithubSyncStatus = { root, state: 'off', enabled: false }
        broadcast(root, off)
        return off
      }
      // Turning sync on is an explicit act, so the caller waits for the first pass and gets a real
      // answer — "connected" or "you need to sign in" — instead of an optimistic `syncing`.
      ensureOpen(root)
      return adopt(root)
    },

    notifyFocus(root) {
      const entry = entries.get(root)
      if (entry === undefined || entry.busy) return
      if (Date.now() - entry.lastPassAt < focusCooldownMs) return
      void requestPass(root)
    },

    notifyWake() {
      const now = Date.now()
      for (const [root, entry] of [...entries]) {
        if (entry.busy || now - entry.lastPassAt < focusCooldownMs) continue
        void requestPass(root)
      }
    },

    async flushForQuit() {
      // Adoption may still be in flight — a quit two ticks after an open must still find the root.
      await settling
      await Promise.all([...evaluations.values()])
      const jobs: Array<Promise<unknown>> = []
      for (const [root, entry] of [...entries]) {
        clearTimers(entry)
        // Through the same chain as everything else: a pass already running is joined, not raced.
        jobs.push(requestPass(root, 'flush'))
      }
      await Promise.all(jobs)
    },
  }
}
