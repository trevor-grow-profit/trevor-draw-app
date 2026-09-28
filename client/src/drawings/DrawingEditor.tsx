/**
 * THE DRAWING DOCUMENT (🔒 YAZ-1810): a `.excalidraw` opened full-pane in a tab. `Editor`
 * dispatches `kind === 'drawing'` here, and this is the shell's ordinary document host — save
 * chip, sync chip, conflict bar, debounced autosave, the quit handshake, all from
 * `useBoardDocument` (YAZ-2073 🔒 D16) — with the canvas where a text editor would be.
 *
 * 🔒 CHROME ONLY. The ENGINE lives behind `ExcalidrawSurface`; nothing in this file imports the
 * package, or anything that does. `DrawingEditor.test.tsx` mocks that one seam and pins the rest.
 *
 * AUTOSAVE ON THE VERSION, NOT THE BYTES. The engine reports a snapshot per pointer move. The
 * snapshot lives in a REF and autosave is fed only its cheap integer `version`, so a drag costs
 * one React render instead of hundreds — and serialising happens ONCE, inside `write`, when the
 * 500 ms timer fires. The FIRST snapshot is the surface's restore-then-compare baseline, so a
 * drawing that is opened and not touched is clean and is never written back.
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
 * THE CHIPS ARE THE ENGINE'S TOP-RIGHT ROW, not a strip above the canvas: the canvas starts
 * directly under the tab bar, and the chips sit where the web app's cloud status does.
 *
 * 🔒 YAZ-1775 D3 ON SAVE. `unpersistedFiles` picks the canvas files the store lacks — referenced by a
 * live image element, and not among what `drawing:load` found in `assets/` plus what earlier
 * saves reported back — and ships them as `newFiles`; main writes them BEFORE the scene. A
 * legacy embedded board comes back from load as not-stored, so its first save is the shrink:
 * bytes into `assets/`, JSON down to `files: {}`. The persisted set only ever grows, so the same
 * image is never shipped twice in one session.
 */
import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { CanvasPanelState, CanvasPrefs, DrawingLoadResponse } from '@shared/types'
import { unpersistedFiles } from '@shared/drawingAssets'
import { api } from '../api'
import { BoardDocumentShell } from '../documents/BoardDocumentShell'
import { BoardChips, exportWithNotice, useBoardDocument, type BoardDocumentProps } from '../documents/useBoardDocument'
import type { NoticeKind } from '../lib/notice'
import { basename } from '../lib/paths'
import { useAppliedTheme } from '../lib/theme'
import { exportFileName } from './exportDrawing'
import { parseSceneText, type DrawingScene } from './drawingScene'
import { ExcalidrawSurface, type DrawingSnapshot, type DrawingSurfaceApi } from './ExcalidrawSurface'
import './drawingEditor.css'

/** What a document that will not open says — one message for its three causes (missing, corrupt, empty). */
export const BROKEN_DRAWING_DOCUMENT = "This Excalidraw drawing can't be opened: its file is missing or is not a scene."

/** What File › Export Drawing… says when the save sheet or the write refused (🔒 YAZ-1775 D3, YAZ-1821). */
const EXPORT_FAILED = "The Excalidraw drawing couldn't be exported."

export interface DrawingEditorProps extends BoardDocumentProps {
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

const loadDocument = (req: { root: string; path: string }): Promise<LoadedDocument> => api.drawing.load(req).then(toDocument)
// Missing, unreadable, not a scene: ONE readable state, never a blank pane.
const brokenDocument = (): string => BROKEN_DRAWING_DOCUMENT

export function DrawingEditor(props: DrawingEditorProps) {
  return (
    <BoardDocumentShell root={props.root} path={props.path} className="editor--drawing" load={loadDocument} errorText={brokenDocument}>
      {(loaded, onFailed) => <DrawingHost {...props} loaded={loaded} onFailed={onFailed} />}
    </BoardDocumentShell>
  )
}

interface DrawingHostProps extends DrawingEditorProps {
  loaded: LoadedDocument
  onFailed: (message: string) => void
}

/** Mounts exactly one canvas for `loaded`; its board document owns everything that writes. */
function DrawingHost({ root, path, loaded, watch, sync, onSyncNow, canvasPrefs, onCanvasPrefsChange, canvasPanel, onCanvasPanelChange, onNotice, onFailed }: DrawingHostProps) {
  const theme = useAppliedTheme()
  /** The latest snapshot; read only when a save fires (see the module doc). */
  const snapshot = useRef<DrawingSnapshot | null>(null)
  const surface = useRef<DrawingSurfaceApi | null>(null)
  /** Set by a reload; the next snapshot is consumed as the new baseline, not as a change. */
  const reloadedTo = useRef<number | null>(null)
  /** Ids the store holds: load's `stored`, grown by every save's `persisted` (🔒 YAZ-1775 D3). */
  const persisted = useRef(new Set(loaded.stored))

  // Fresh closures every render are fine: the hook reads them through its `engine` ref, never stale.
  const board = useBoardDocument({
    root,
    path,
    watch,
    sync,
    onSyncNow,
    write: async (expectedMtime) => {
      const current = snapshot.current
      if (current === null) throw new Error('nothing to save')
      const { json, files, referenced } = current.serialize()
      const newFiles = unpersistedFiles(files, referenced, persisted.current)
      const res = await api.drawing.save({ root, path, json, expectedMtime, newFiles })
      for (const id of res.persisted) persisted.current.add(id)
      return res
    },
    reload: async (a) => {
      const s = surface.current
      if (s === null) return
      try {
        const doc = toDocument(await api.drawing.load({ root, path }))
        reloadedTo.current = doc.mtime
        persisted.current = new Set(doc.stored)
        a.reset(s.replaceScene(doc.scene), doc.mtime)
      } catch (err) {
        reloadedTo.current = null
        throw err
      }
    },
    // The application menu's three canvas items (🔒 YAZ-1775 D10); a host whose engine has not
    // handed its API over yet simply has nothing to do.
    onCommand: (command) => {
      const s = surface.current
      if (s === null) return
      if (command.kind === 'export-image') s.openImageExport()
      else if (command.kind === 'export-drawing') void exportDrawing()
      else s.setCanvasBackground(command.color)
    },
    // A tab back from `visibility: hidden` may have been laid out at the wrong size.
    onShown: () => surface.current?.refresh(),
    focus: () => surface.current?.focus(),
  })
  const { autosave, start, chips } = board

  const onSnapshot = useCallback(
    (next: DrawingSnapshot) => {
      snapshot.current = next
      const a = autosave.current
      // The first snapshot IS the clean baseline (the surface restored the disk elements first).
      if (a === null) {
        start(next.version, loaded.mtime)
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
    [autosave, start, loaded.mtime],
  )

  // The chips, as the engine's top-right slot content: ONE identity for the host's life (the surface
  // hands this straight to a memoized `<Excalidraw>`); what they say comes from the store.
  const renderTopRight = useCallback(() => <BoardChips store={chips} className="drawing-editor__chips" />, [chips])

  const onApi = useCallback((a: DrawingSurfaceApi) => {
    surface.current = a
  }, [])

  /**
   * File › Export Drawing… (🔒 YAZ-1775 D3, YAZ-1821). The canvas assembles a STANDALONE scene — the whole
   * live files map, minus what only deleted elements name, embedded — and main's save sheet writes
   * it wherever the user points. THE VAULT FILE IS NOT TOUCHED: nothing here reads it, writes it or
   * flushes the autosave, so an export of a dirty board exports what is on the canvas and the
   * board's own save timer carries on as if nothing happened.
   */
  const exportDrawing = async (): Promise<void> => {
    const s = surface.current
    if (s === null || board.retired.current) return
    await exportWithNotice(() => api.dialog.saveDrawing({ defaultName: exportFileName(basename(path)), content: s.exportScene() }), EXPORT_FAILED, onNotice)
  }

  /** ⌘S flushes now — caught before the engine's own keymap, and never on `window`. */
  const onKeyDownCapture = (e: ReactKeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      board.flush()
    }
  }

  return (
    <div className="drawing-editor" ref={board.hostRef} onKeyDownCapture={onKeyDownCapture}>
      {board.conflictBar}
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
