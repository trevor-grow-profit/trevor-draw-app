/**
 * THE BOARD DOCUMENT HOST (YAZ-2073 🔒 D16): the save / conflict / flush / rename state machine the
 * drawing (`DrawingEditor`, 🔒 YAZ-1810) and the diagram (`DrawioEditor`, YAZ-1802) share, written
 * once. An editor says only what its engine knows — when its content is the clean baseline
 * (`start`), how the live document is written (`write`), how disk truth goes back in (`reload`) —
 * and this hook owns the rest. A hook and a shell, not a generic `<BoardEditor engine={…}>`: the two
 * engines have nothing else in common.
 *
 * AUTOSAVE COUNTS, IT NEVER COMPARES BYTES. `Autosave<number>` is fed a change counter the engine
 * keeps; the bytes are produced once, inside `write`, when the 500 ms timer fires. Its status
 * reaches the chips through a store (YAZ-2073 5D), so a save's three status moves never re-render
 * the host.
 *
 * EXTERNAL CHANGES. A watcher `change` on this path, once any in-flight save has settled, is our
 * own echo when its mtime matches what the save returned. Otherwise a CLEAN editor RELOADS from
 * disk and a DIRTY one raises the conflict bar (Reload / Keep mine). A `CONFLICT` from the save
 * door itself — a stale `expectedMtime`, i.e. the other window got there first — raises the same
 * bar, and `Autosave` blocks further writes until one of the two buttons answers it. Two windows
 * on one board is exactly this rule seen from both sides.
 *
 * RENAME AND DELETE. The host registers the shell's rename-continuity handle for its path, so a
 * rename flushes these bytes before the file moves and a DELETE retires the controller — without
 * which closing the tab would flush on unmount and resurrect the file that was just trashed.
 *
 * THE APPLICATION MENU'S BOARD COMMANDS (🔒 YAZ-1775 D10) and the TAB-REVEAL focus handoff
 * (🔒 YAZ-1812) are both claimed on THIS host's own element: the shell keeps several boards
 * mounted, and exactly one of them is in front.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { GithubSyncStatus, SaveDrawingResponse } from '@shared/types'
import { api, BridgeRequestError } from '../api'
import type { WatchSource } from '../hooks/useWatch'
import { Autosave, SaveConflict, type SaveStatus } from '../lib/autosave'
import type { NoticeKind } from '../lib/notice'
import { basename } from '../lib/paths'
import { registerRenameContinuity } from '../lib/renameContinuity'
import { createStore, type Store } from '../lib/store'
import { noteBoardSaved } from '../share/liveShare'
import { BOARD_COMMAND_EVENT, type BoardCommand } from './boardCommand'
import { ConflictBar } from './ConflictBar'
import { mayTakeFocus } from './focusHandoff'
import { SaveIndicator } from './SaveIndicator'
import { SyncIndicator } from './SyncIndicator'
import './statusChips.css'

/** What every board editor is handed for its document, and hands on to `useBoardDocument` as is. */
export interface BoardDocumentProps {
  root: string
  path: string
  /** The window's one watcher subscription; the conflict rule listens on it. */
  watch: WatchSource
  /** The vault's sync status (YAZ-1081), App-owned; null while fetching, undefined = no chip. */
  sync?: GithubSyncStatus | null
  onSyncNow?: () => void
}

export interface BoardDocumentOptions extends BoardDocumentProps {
  write: (expectedMtime: number) => Promise<{ mtime: number }>
  /** Disk truth into the engine, and `autosave` reset to it; throws when the file cannot be read. */
  reload: (autosave: Autosave<number>) => Promise<void>
  onCommand: (command: BoardCommand) => void
  /** The tab came back into view; `focus` then hands the engine the keyboard, unless something holds it. */
  onShown?: () => void
  focus: () => void
}

/**
 * `hostRef` goes on the host's own element (commands and the reveal are claimed on it); `start` hands
 * over the engine's clean baseline, and `autosave` is null until it has.
 */
export function useBoardDocument(options: BoardDocumentOptions) {
  const { root, path, watch, sync, onSyncNow } = options
  /** The engine's callbacks as of the last render: the listeners below are bound once, at mount. */
  const engine = useRef(options)
  engine.current = options
  const hostRef = useRef<HTMLDivElement>(null)
  const autosave = useRef<Autosave<number> | null>(null)
  /** A retired host never writes again (a delete, or a rename that moved this path away). */
  const retired = useRef(false)
  const [conflictMtime, setConflictMtime] = useState<number | null>(null)
  // The chips' live state, read by `<BoardChips>` alone (YAZ-2073 5D).
  const [chips] = useState(() => createStore<ChipState>({ status: 'saved', sync, onSyncNow }))
  useLayoutEffect(() => chips.set({ sync, onSyncNow }), [chips, sync, onSyncNow])

  const save = useCallback(
    async (_version: number, expectedMtime: number): Promise<{ mtime: number }> => {
      try {
        const res = await engine.current.write(expectedMtime)
        // Always-live share links (YAZ-1799): a shared board re-uploads once its saves settle.
        noteBoardSaved(root, path)
        return res
      } catch (err) {
        // A stale guard is the conflict bar's business, not an error chip.
        if (err instanceof BridgeRequestError && err.mtime !== undefined) throw new SaveConflict(err.mtime)
        throw err
      }
    },
    [root, path],
  )

  const start = useCallback(
    (content: number, mtime: number) => {
      autosave.current = new Autosave<number>({ content, mtime, delayMs: 500, save, onStatus: (status) => chips.set({ status }), onConflict: setConflictMtime })
    },
    [chips, save],
  )

  /** Disk truth into the engine, then a fresh baseline: the clean editor's answer to a change. */
  const reload = useCallback(async () => {
    const a = autosave.current
    if (a === null || retired.current) return
    try {
      await engine.current.reload(a)
      setConflictMtime(null)
    } catch {
      // The file went, or stopped being a board: keep what is on screen and let the next save
      // say so. A reload that cannot read must never blank the board in front of the user.
    }
  }, [])

  // The watcher rule (see the module doc): settle the in-flight save, then echo / reload / conflict.
  useEffect(
    () =>
      watch.subscribe((ev) => {
        if (ev.type !== 'change' || ev.path !== path) return
        const a = autosave.current
        if (a === null || retired.current) return
        void a.settled().then(() => {
          if (ev.mtime === a.mtime) return // the echo of our own write
          if (a.dirty) setConflictMtime(ev.mtime)
          else void reload()
        })
      }),
    [watch, path, reload],
  )

  const keepMine = useCallback(() => {
    const a = autosave.current
    if (a === null || retired.current || conflictMtime === null) return
    setConflictMtime(null)
    void a.adopt(conflictMtime)
  }, [conflictMtime])

  // The close/quit handshake (main holds the window until this settles, 5 s cap) and the unmount
  // flush. A retired host does neither — that is what keeps a delete deleted.
  useEffect(() => {
    const offFlush = api.window.onFlush(async () => {
      if (!retired.current) await autosave.current?.flush()
    })
    return () => {
      offFlush()
      const a = autosave.current
      if (a !== null) {
        if (!retired.current) void a.flush()
        a.dispose()
      }
      autosave.current = null
    }
  }, [])

  // The shell's rename/delete continuity handle (see the module doc).
  useEffect(
    () =>
      registerRenameContinuity(path, {
        flush: async () => {
          if (!retired.current) await autosave.current?.flush()
        },
        retire: () => {
          retired.current = true
          autosave.current?.dispose()
        },
        // YAZ-1801: Settings › Storage's shrink skips a board this tab has unsaved edits on.
        dirty: () => autosave.current?.dirty === true,
      }),
    [path],
  )

  // The menu's commands, claimed on the SECTION `boardCommand.ts` dispatches on. The event does
  // not bubble — on purpose, so no ancestor can become a second claimant.
  useEffect(() => {
    const section = hostRef.current?.closest('.editor') ?? null
    if (section === null) return
    const onCommand = (event: Event): void => engine.current.onCommand((event as CustomEvent<BoardCommand>).detail)
    section.addEventListener(BOARD_COMMAND_EVENT, onCommand)
    return () => section.removeEventListener(BOARD_COMMAND_EVENT, onCommand)
  }, [])

  // A tab coming back from `visibility: hidden` has nobody holding the keyboard, because the
  // engine's focus only ever landed at MOUNT. So the moment it is revealed hands it over, gated by
  // `mayTakeFocus`: never out from under the ⌘K search bar, the vault switcher or a dialog. The
  // layer is the whole tab stack, so the tab being LEFT hands over to this one.
  useEffect(() => {
    const host = hostRef.current
    if (host === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      engine.current.onShown?.()
      if (mayTakeFocus(document.activeElement, host.closest('.tabstack'))) engine.current.focus()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const flush = useCallback(() => {
    if (!retired.current) void autosave.current?.flush()
  }, [])

  const conflictBar = conflictMtime !== null && <ConflictBar onReload={() => void reload()} onKeepMine={keepMine} />
  return { hostRef, autosave, retired, start, flush, chips, conflictBar }
}

/** What the chips show: the save status (the autosave reports it) and the vault's sync, App's. */
interface ChipState {
  status: SaveStatus
  sync: GithubSyncStatus | null | undefined
  onSyncNow: (() => void) | undefined
}

/** The sync chip (when the vault has one) and the save chip; what they say comes from the store. */
export function BoardChips({ store, className }: { store: Store<ChipState>; className: string }) {
  const { status, sync, onSyncNow } = useSyncExternalStore(store.subscribe, store.getState)
  return (
    <div className={className}>
      {sync != null && onSyncNow !== undefined && <SyncIndicator status={sync} onSyncNow={onSyncNow} />}
      <SaveIndicator status={status} />
    </div>
  )
}

/**
 * An export's one passive notice: where the file landed, or why it did not. A dismissed sheet — or
 * a `sheet` that answers null, having said why itself — is silent.
 */
export async function exportWithNotice(sheet: () => Promise<SaveDrawingResponse | null>, failed: string, onNotice?: (text: string, icon?: NoticeKind) => void): Promise<void> {
  try {
    const answer = await sheet()
    if (answer === null || 'cancelled' in answer) return
    onNotice?.(`Exported to ${basename(answer.path)}`)
  } catch (err) {
    onNotice?.(err instanceof BridgeRequestError && err.message !== '' ? err.message : failed, 'error')
  }
}
