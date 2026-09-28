/**
 * THE DRAWING DOCUMENT (🔒 YAZ-1810): a `.excalidraw` opened full-pane in a tab. `Editor`
 * dispatches `kind === 'drawing'` here, and this is the shell's ordinary document host — save
 * chip, sync chip, conflict bar, debounced autosave, the quit handshake — with the canvas where
 * a text editor would be.
 *
 * 🔒 CHROME ONLY. The ENGINE lives behind `ExcalidrawSurface`; nothing in this file imports the
 * package, or anything that does. `DrawingEditor.test.tsx` mocks that one seam and pins the rest.
 *
 * AUTOSAVE ON THE VERSION, NOT THE BYTES. The engine reports a snapshot per pointer move. The
 * snapshot lives in a REF and `Autosave<number>` is fed only its cheap integer `version`, so a
 * drag costs one React render instead of hundreds — and serialising happens ONCE, inside
 * `save()`, when the 500 ms timer fires. The FIRST snapshot is the surface's restore-then-compare
 * baseline, so a drawing that is opened and not touched is clean and is never written back.
 *
 * EXTERNAL CHANGES. A watcher `change` on this path, once any in-flight save has settled, is our
 * own echo when its mtime matches what the save returned. Otherwise a CLEAN editor RELOADS from
 * disk and a DIRTY one raises the conflict bar (Reload / Keep mine). A `CONFLICT` from the save
 * door itself — a stale `expectedMtime`, i.e. the other window got there first — raises the same
 * bar, and `Autosave` blocks further writes until one of the two buttons answers it. Two windows
 * on one board is exactly this rule seen from both sides.
 *
 * RELOADING MUST NOT WRITE. The engine answers `updateScene` with its own `onChange`, so a naive
 * reload looks like an edit and saves the freshly-read bytes straight back. Two guards, both
 * cheap: `replaceScene` returns the version computed from the elements it handed the engine (not
 * read back from it, which races its commit), and the first snapshot after a reload is consumed
 * as the new BASELINE rather than as a change.
 *
 * ⚡ KEYS ARE THE HOST'S, NEVER `window`'s. ⌘S is caught on this element in the CAPTURE phase —
 * before the engine's own keymap sees it — and flushes now. A `window` listener would fire for
 * every mounted tab at once, and the shell keeps several mounted. The surface applies the same
 * rule to ⌘F / ⌘C, and it is why the parity checklist drops `handleKeyboardGlobally`.
 *
 * THE APPLICATION MENU'S TWO CANVAS ITEMS (🔒 YAZ-1775 D10) arrive the same way: `App` dispatches a
 * `BOARD_COMMAND_EVENT` on the VISIBLE `.editor--drawing` section (`boardCommand.ts`), and
 * this host claims it on its own element. Same reason as the keys — several engines are mounted,
 * and exactly one of them is in front.
 *
 * THE CHIPS ARE THE ENGINE'S TOP-RIGHT ROW, not a strip above the canvas: the canvas starts
 * directly under the tab bar, and the chips sit where the web app's cloud status does.
 *
 * 🔒 YAZ-1775 D3 ON SAVE. `unpersistedFiles` picks the canvas files the store lacks — referenced by a
 * live image element, and not among what `drawing:load` found in `assets/` plus what earlier
 * saves reported back — and ships them as `newFiles`; main writes them BEFORE the scene. A
 * legacy embedded board comes back from load as not-stored, so its first save is the shrink:
 * bytes into `assets/`, JSON down to `files: {}`. The persisted set only ever grows, so the same
 * image is never shipped twice in one session.
 *
 * RENAME AND DELETE. The host registers the shell's rename-continuity handle for its path, so a
 * rename flushes these bytes before the file moves and a DELETE retires the controller — without
 * which closing the tab would flush on unmount and resurrect the file that was just trashed.
 * `capture()` answers null on purpose: a text buffer can travel to the new path as a string, a
 * live canvas cannot, and the pre-rename flush has already put it on disk.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CanvasPanelState, CanvasPrefs, DrawingLoadResponse, GithubSyncStatus } from '@shared/types'
import { unpersistedFiles } from '@shared/drawingAssets'
import { api, BridgeRequestError } from '../api'
import type { WatchSource } from '../hooks/useWatch'
import type { NoticeKind } from '../lib/notice'
import { basename } from '../lib/paths'
import { Autosave, SaveConflict, type SaveStatus } from '../lib/autosave'
import { registerRenameContinuity } from '../lib/renameContinuity'
import { createStore, type Store } from '../lib/store'
import { useAppliedTheme } from '../lib/theme'
import { BOARD_COMMAND_EVENT, type BoardCommand } from './boardCommand'
import { exportFileName } from './exportDrawing'
import { noteBoardSaved } from '../share/liveShare'
import { parseSceneText, type DrawingScene } from './drawingScene'
import { mayTakeFocus } from './focusHandoff'
import { ExcalidrawSurface, type DrawingSnapshot, type DrawingSurfaceApi } from './ExcalidrawSurface'
import { ConflictBar } from './ConflictBar'
import { SaveIndicator } from './SaveIndicator'
import { SyncIndicator } from './SyncIndicator'
import './drawingEditor.css'
import './statusChips.css'

/** What a document that will not open says — one message for its three causes (missing, corrupt, empty). */
export const BROKEN_DRAWING_DOCUMENT = "This Excalidraw drawing can't be opened: its file is missing or is not a scene."

/** What File › Export Drawing… says when the save sheet or the write refused (🔒 YAZ-1775 D3, YAZ-1821). */
const EXPORT_FAILED = "The Excalidraw drawing couldn't be exported."

export interface DrawingEditorProps {
  root: string
  path: string
  /** The window's one watcher subscription; the conflict rule listens on it. */
  watch: WatchSource
  /** The vault's sync status (YAZ-1081), App-owned; null while fetching, undefined = no chip. */
  sync?: GithubSyncStatus | null
  onSyncNow?: () => void
  /**
   * The user-level canvas preferences (🔒 YAZ-1775 D9), App's copy of `SettingsState.canvas`: seeded into
   * the scene at mount and kept in step with the engine both ways. Omitted = the engine's defaults.
   */
  canvasPrefs?: CanvasPrefs
  /** The engine (or the rail) moved a pref: App writes it back to the one store every window reads. */
  onCanvasPrefsChange?: (next: CanvasPrefs) => void
  /** What the canvas panel remembers between mounts: its last-used tab and its dock pref (🔒 YAZ-1775 D10). */
  canvasPanel?: CanvasPanelState
  onCanvasPanelChange?: (next: CanvasPanelState) => void
  /** The window's ONE passive notice: where an export landed, or why it did not (🔒 YAZ-1775 D3, YAZ-1821). */
  onNotice?: (text: string, icon?: NoticeKind) => void
}

/** A loaded document: the scene the canvas opens on, and the mtime the first save guards with. */
interface LoadedDocument {
  scene: DrawingScene
  mtime: number
  /** The ids the store already holds — what the renderer must never ship again. */
  stored: string[]
}

/**
 * `drawing:load`'s answer as the engine wants it: the image map becomes `BinaryFileData`-shaped
 * entries keyed by id. Throws when the bytes are not a scene, which is the error pane.
 */
function toDocument(res: DrawingLoadResponse): LoadedDocument {
  const parsed = parseSceneText(res.json)
  const files: Record<string, unknown> = {}
  const created = Date.now()
  for (const [id, entry] of Object.entries(res.files)) files[id] = { id, mimeType: entry.mimeType, dataURL: entry.dataURL, created }
  return { scene: { ...parsed, files }, mtime: res.mtime, stored: res.stored }
}

export function DrawingEditor({ root, path, watch, sync, onSyncNow, canvasPrefs, onCanvasPrefsChange, canvasPanel, onCanvasPanelChange, onNotice }: DrawingEditorProps) {
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setLoaded(null)
    setError(null)
    api.drawing.load({ root, path }).then(
      (res) => {
        if (!live) return
        try {
          setLoaded(toDocument(res))
        } catch {
          setError(BROKEN_DRAWING_DOCUMENT)
        }
      },
      // Missing, unreadable, not a scene: ONE readable state, never a blank pane.
      () => {
        if (live) setError(BROKEN_DRAWING_DOCUMENT)
      },
    )
    return () => {
      live = false
    }
  }, [root, path])

  return (
    <section className="editor editor--drawing">
      {error !== null && (
        <p className="editor-msg editor-msg--error" role="alert">
          {error}
        </p>
      )}
      {error === null && loaded === null && <p className="editor-msg">Loading…</p>}
      {/* Keyed by path so a rename mounts a fresh host rather than re-pointing a live canvas. */}
      {error === null && loaded !== null && (
        <DrawingHost
          key={path}
          root={root}
          path={path}
          loaded={loaded}
          watch={watch}
          sync={sync}
          onSyncNow={onSyncNow}
          canvasPrefs={canvasPrefs}
          onCanvasPrefsChange={onCanvasPrefsChange}
          canvasPanel={canvasPanel}
          onCanvasPanelChange={onCanvasPanelChange}
          onNotice={onNotice}
          onFailed={setError}
        />
      )}
    </section>
  )
}

interface DrawingHostProps extends DrawingEditorProps {
  loaded: LoadedDocument
  onFailed: (message: string) => void
}

/** Mounts exactly one canvas for `loaded` and owns everything that writes. */
function DrawingHost({ root, path, loaded, watch, sync, onSyncNow, canvasPrefs, onCanvasPrefsChange, canvasPanel, onCanvasPanelChange, onNotice, onFailed }: DrawingHostProps) {
  const theme = useAppliedTheme()
  const hostRef = useRef<HTMLDivElement>(null)
  // The chips' live state, read by `<Chips>` alone (YAZ-2073 5D): a save's three status moves never re-render this host.
  const [chips] = useState(() => createStore<ChipState>({ status: 'saved', sync, onSyncNow }))
  const [conflictMtime, setConflictMtime] = useState<number | null>(null)
  /** The latest snapshot; read only when a save fires (see the module doc). */
  const snapshot = useRef<DrawingSnapshot | null>(null)
  const surface = useRef<DrawingSurfaceApi | null>(null)
  const autosave = useRef<Autosave<number> | null>(null)
  /** Set by a reload; the next snapshot is consumed as the new baseline, not as a change. */
  const reloadedTo = useRef<number | null>(null)
  /** Ids the store holds: load's `stored`, grown by every save's `persisted` (🔒 YAZ-1775 D3). */
  const persisted = useRef(new Set(loaded.stored))
  /** A retired host never writes again (a delete, or a rename that moved this path away). */
  const retired = useRef(false)

  const save = useCallback(
    async (_version: number, expectedMtime: number): Promise<{ mtime: number }> => {
      const current = snapshot.current
      if (current === null) throw new Error('nothing to save')
      const { json, files, referenced } = current.serialize()
      const newFiles = unpersistedFiles(files, referenced, persisted.current)
      try {
        const res = await api.drawing.save({ root, path, json, expectedMtime, newFiles })
        for (const id of res.persisted) persisted.current.add(id)
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

  const onSnapshot = useCallback(
    (next: DrawingSnapshot) => {
      snapshot.current = next
      const a = autosave.current
      // The first snapshot IS the clean baseline (the surface restored the disk elements first).
      if (a === null) {
        autosave.current = new Autosave<number>({ content: next.version, mtime: loaded.mtime, delayMs: 500, save, onStatus: (status) => chips.set({ status }), onConflict: setConflictMtime })
        return
      }
      const mtime = reloadedTo.current
      if (mtime !== null) {
        reloadedTo.current = null
        // Whatever the engine settled on after `replaceScene` IS the baseline; treating it as a
        // change would write the bytes we have just read straight back to disk.
        a.reset(next.version, mtime)
        return
      }
      a.update(next.version)
    },
    [chips, loaded.mtime, save],
  )

  /** Disk truth into the canvas, then a fresh baseline: the clean editor's answer to a change. */
  const reload = useCallback(async () => {
    const a = autosave.current
    const s = surface.current
    if (a === null || s === null || retired.current) return
    try {
      const doc = toDocument(await api.drawing.load({ root, path }))
      reloadedTo.current = doc.mtime
      persisted.current = new Set(doc.stored)
      a.reset(s.replaceScene(doc.scene), doc.mtime)
      setConflictMtime(null)
    } catch {
      // The file went, or stopped being a scene: keep what is on the canvas and let the next
      // save say so. A reload that cannot read must never blank the drawing in front of the user.
      reloadedTo.current = null
    }
  }, [root, path])

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
    const offFlush = window.yaseenDraw.window.onFlush(async () => {
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

  // The application menu's two canvas items (🔒 YAZ-1775 D10), claimed on THIS host's element so only the
  // drawing in front answers. `boardCommand.ts` already picked the visible layer; a host whose
  // engine has not handed its API over yet simply has nothing to do.
  useEffect(() => {
    // The event lands on the SECTION `boardCommand.ts` selects (`.editor--drawing`), and it does
    // not bubble — on purpose, so no ancestor can become a second claimant.
    const section = hostRef.current?.closest('.editor--drawing') ?? null
    if (section === null) return
    const onCommand = (event: Event): void => {
      const command = (event as CustomEvent<BoardCommand>).detail
      const s = surface.current
      if (s === null) return
      if (command.kind === 'export-image') s.openImageExport()
      else if (command.kind === 'export-drawing') void exportDrawingRef.current()
      else s.setCanvasBackground(command.color)
    }
    section.addEventListener(BOARD_COMMAND_EVENT, onCommand)
    return () => section.removeEventListener(BOARD_COMMAND_EVENT, onCommand)
  }, [])

  // A tab coming back from `visibility: hidden` may have been laid out at the wrong size — and it
  // also has nobody holding the keyboard, because `autoFocus` only ever fired at MOUNT. So the
  // same moment re-measures the canvas AND hands it the keyboard (🔒 focus handoff on tab reveal,
  // YAZ-1812), gated by `mayTakeFocus`: never out from under the ⌘K search bar, the vault switcher
  // or a dialog. The layer is the whole tab stack, so the tab being LEFT hands over to this one.
  useEffect(() => {
    const host = hostRef.current
    if (host === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      surface.current?.refresh()
      const layer = host.closest('.tabstack')
      if (mayTakeFocus(document.activeElement, layer)) surface.current?.focus()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => chips.set({ sync, onSyncNow }), [chips, sync, onSyncNow])
  // The chips, as the engine's top-right slot content: ONE identity for the host's life (the surface
  // hands this straight to a memoized `<Excalidraw>`); what they say comes from the store.
  const renderTopRight = useCallback(() => <Chips store={chips} />, [chips])

  const onApi = useCallback((a: DrawingSurfaceApi) => {
    surface.current = a
  }, [])

  /**
   * File › Export Drawing… (🔒 YAZ-1775 D3, YAZ-1821). The canvas assembles a STANDALONE scene — the whole
   * live files map, minus what only deleted elements name, embedded — and main's save sheet writes
   * it wherever the user points. THE VAULT FILE IS NOT TOUCHED: nothing here reads it, writes it or
   * flushes the autosave, so an export of a dirty board exports what is on the canvas and the
   * board's own save timer carries on as if nothing happened.
   *
   * Through a ref because the command listener is bound once, at mount, on this host's section.
   */
  const exportDrawing = useCallback(async () => {
    const s = surface.current
    if (s === null || retired.current) return
    try {
      const answer = await api.dialog.saveDrawing({ defaultName: exportFileName(basename(path)), content: s.exportScene() })
      if ('cancelled' in answer) return
      onNotice?.(`Exported to ${basename(answer.path)}`)
    } catch (err) {
      onNotice?.(err instanceof BridgeRequestError && err.message !== '' ? err.message : EXPORT_FAILED, 'error')
    }
  }, [onNotice, path])
  const exportDrawingRef = useRef(exportDrawing)
  exportDrawingRef.current = exportDrawing

  /** ⌘S flushes now — caught before the engine's own keymap, and never on `window`. */
  const onKeyDownCapture = (e: ReactKeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      if (!retired.current) void autosave.current?.flush()
    }
  }

  return (
    <div className="drawing-editor" ref={hostRef} onKeyDownCapture={onKeyDownCapture}>
      {conflictMtime !== null && <ConflictBar onReload={() => void reload()} onKeepMine={keepMine} />}
      <div className="drawing-editor__canvas">
        <ExcalidrawSurface
          scene={loaded.scene}
          theme={theme}
          canvasPrefs={canvasPrefs}
          onCanvasPrefsChange={onCanvasPrefsChange}
          canvasPanel={canvasPanel}
          onCanvasPanelChange={onCanvasPanelChange}
          onSnapshot={onSnapshot}
          onFailed={onFailed}
          onApi={onApi}
          renderTopRight={renderTopRight}
        />
      </div>
    </div>
  )
}

/** What the chips show: the save status (the autosave reports it) and the vault's sync, App's. */
interface ChipState {
  status: SaveStatus
  sync: GithubSyncStatus | null | undefined
  onSyncNow: (() => void) | undefined
}

function Chips({ store }: { store: Store<ChipState> }) {
  const { status, sync, onSyncNow } = useSyncExternalStore(store.subscribe, store.getState)
  return (
    <div className="drawing-editor__chips">
      {sync != null && onSyncNow !== undefined && <SyncIndicator status={sync} onSyncNow={onSyncNow} />}
      <SaveIndicator status={status} />
    </div>
  )
}
