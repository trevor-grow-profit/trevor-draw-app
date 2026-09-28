/**
 * A `.drawio` open in a tab (YAZ-1802): `DrawingEditor`'s twin — save and sync chips, conflict bar,
 * debounced autosave, quit flush, rename continuity, all from `useBoardDocument` (YAZ-2073 🔒 D16) —
 * with draw.io where the canvas is.
 *
 * 🔒 D4: draw.io runs in an iframe on its own origin and is talked to by postMessage only
 * (`drawioProtocol.ts`). The XML is loaded BEFORE the iframe mounts, so a file main refuses is the
 * error pane and draw.io can never autosave over it. Autosave counts draw.io's changes and leaves
 * the rules to the board document. Theme (D12) and the dark-mode colour setting (D16) apply live
 * by message. Keys, export and share: docs/CONTRACTS.md › draw.io diagrams.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAWIO_ORIGIN } from '@shared/drawio'
import type { DiagramDarkColors } from '@shared/types'
import { api, BridgeRequestError } from '../api'
import { BoardDocumentShell } from '../documents/BoardDocumentShell'
import { BoardChips, exportWithNotice, useBoardDocument, type BoardDocumentProps } from '../documents/useBoardDocument'
import type { NoticeKind } from '../lib/notice'
import { basename, stripExt } from '../lib/paths'
import { useAppliedTheme } from '../lib/theme'
import { drawioAdaptiveColors, drawioConfig, drawioFrameUrl, readDrawioMessage } from './drawioProtocol'
import { renderDiagramImage } from './renderDiagram'
import './drawioEditor.css'

/** What a diagram that will not open says; main's reason follows it when there is one. */
export const BROKEN_DIAGRAM_DOCUMENT = "This draw.io diagram can't be opened"

const EXPORT_FAILED = "The draw.io diagram couldn't be exported."
const EXPORT_EMPTY = 'This draw.io diagram is empty, so there is no image to export.'

/**
 * How long the host waits for our PostConfig.js to say it is ready before configuring draw.io
 * anyway — a missing overlay must cost the keymap, never the document.
 */
const READY_FALLBACK_MS = 3000

export interface DrawioEditorProps extends BoardDocumentProps {
  /** 🔒 YAZ-1802 D16: the app's dark-mode colour setting, applied live (see the module doc). */
  darkColors: DiagramDarkColors
  /** The window's ONE passive notice: where an exported image landed, or why it did not. */
  onNotice?: (text: string, icon?: NoticeKind) => void
  /** App's sidebar toggle: ⌘B pressed inside draw.io with nothing selected, sent up by our PostConfig.js as a `shortcut` event. */
  onToggleSidebar?: () => void
}

interface LoadedDiagram {
  xml: string
  mtime: number
}

const loadDiagram = (req: { root: string; path: string }): Promise<LoadedDiagram> => api.diagram.load(req).then((res) => ({ xml: res.xml, mtime: res.mtime }))

/** Missing, unreadable, not draw.io: ONE readable state naming why, never a blank pane. */
function brokenDiagram(err: unknown): string {
  const why = err instanceof BridgeRequestError && err.code === 'IO_ERROR' ? err.message : err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? 'the file is missing' : null
  return why === null ? `${BROKEN_DIAGRAM_DOCUMENT}.` : `${BROKEN_DIAGRAM_DOCUMENT}: ${why}.`
}

export function DrawioEditor(props: DrawioEditorProps) {
  return (
    <BoardDocumentShell root={props.root} path={props.path} className="editor--diagram" load={loadDiagram} errorText={brokenDiagram}>
      {(loaded) => <DiagramHost {...props} loaded={loaded} />}
    </BoardDocumentShell>
  )
}

interface DiagramHostProps extends DrawioEditorProps {
  loaded: LoadedDiagram
}

/** Mounts exactly one draw.io iframe for `loaded`; its board document owns everything that writes. */
function DiagramHost({ root, path, loaded, watch, sync, onSyncNow, darkColors, onNotice, onToggleSidebar }: DiagramHostProps) {
  const theme = useAppliedTheme()
  const frameRef = useRef<HTMLIFrameElement>(null)
  /** The URL is fixed at mount: a theme flip is a message, never a reload of the editor. */
  const [src] = useState(() => drawioFrameUrl(theme))
  /** The XML draw.io last posted — what the next save writes. */
  const latestXml = useRef(loaded.xml)
  /** Bumped on every draw.io change; `Autosave` compares these, never the XML. */
  const version = useRef(0)
  /** The mtime of the document a `load` action carried, until draw.io answers `load`. */
  const pendingLoad = useRef<number | null>(null)
  /** The handshake (drawioProtocol.ts): our PostConfig is in, draw.io asked to be configured, draw.io listens. */
  const handshake = useRef({ overlayReady: false, configureAsked: false, configured: false, initialised: false })
  /** The theme draw.io is showing (the URL's, then each flip sent), and the one the app wants now. */
  const shownTheme = useRef(theme)
  const wantedTheme = useRef(theme)
  /** The same pair for the dark-mode colour setting: what the configure reply (then each change) sent, and what the app wants now. */
  const shownColors = useRef(darkColors)
  const wantedColors = useRef(darkColors)

  const post = useCallback((msg: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(msg), DRAWIO_ORIGIN)
  }, [])

  /** Send a document into draw.io; its `load` answer becomes the new clean baseline at `mtime`. */
  const sendLoad = useCallback(
    (xml: string, mtime: number) => {
      pendingLoad.current = mtime
      latestXml.current = xml
      post({ action: 'load', xml, autosave: 1, title: stripExt(basename(path)) })
    },
    [post, path],
  )

  const configure = useCallback(() => {
    const h = handshake.current
    if (h.configured || !h.configureAsked) return
    h.configured = true
    shownColors.current = wantedColors.current
    post({ action: 'configure', config: drawioConfig(wantedColors.current) })
  }, [post])

  /** Show the app's theme, once draw.io listens: its own `darkMode` / `lightMode` action. */
  const syncTheme = useCallback(() => {
    if (!handshake.current.initialised || shownTheme.current === wantedTheme.current) return
    shownTheme.current = wantedTheme.current
    post({ action: 'invokeAction', actionName: wantedTheme.current === 'dark' ? 'darkMode' : 'lightMode' })
  }, [post])

  /** A change of the dark-mode colour setting since the configure reply, once draw.io listens: our PostConfig's message. */
  const syncColors = useCallback(() => {
    if (!handshake.current.initialised || shownColors.current === wantedColors.current) return
    shownColors.current = wantedColors.current
    post({ action: 'yaseenAdaptiveColors', value: drawioAdaptiveColors(wantedColors.current) })
  }, [post])

  /** File › Export Image… (🔒 D9): the XML draw.io last posted, unsaved edits included, drawn before the sheet opens because the pick decides the format. */
  const exportImage = (): Promise<void> =>
    exportWithNotice(
      async () => {
        const xml = latestXml.current
        const [png, svg] = await Promise.all([renderDiagramImage(xml, 'png'), renderDiagramImage(xml, 'svg')])
        if (png === '') {
          onNotice?.(EXPORT_EMPTY)
          return null
        }
        return api.dialog.saveImage({ defaultName: `${stripExt(basename(path))}.png`, png, svg })
      },
      EXPORT_FAILED,
      onNotice,
    )

  // Fresh closures every render are fine: the hook reads them through its `engine` ref, never stale.
  const board = useBoardDocument({
    root,
    path,
    watch,
    sync,
    onSyncNow,
    write: (expectedMtime) => api.diagram.save({ root, path, xml: latestXml.current, expectedMtime }),
    reload: async (a) => {
      const res = await api.diagram.load({ root, path })
      a.reset(version.current, res.mtime)
      sendLoad(res.xml, res.mtime)
    },
    // Export Image… is the one board command a diagram answers.
    onCommand: (command) => {
      if (command.kind === 'export-image') void exportImage()
    },
    focus: () => frameRef.current?.focus(),
  })
  const { autosave, retired, start } = board

  // The one message listener: the protocol, in the order drawioProtocol.ts documents.
  useEffect(() => {
    let fallback: ReturnType<typeof setTimeout> | undefined
    const onMessage = (ev: MessageEvent): void => {
      const msg = readDrawioMessage(ev, frameRef.current?.contentWindow)
      if (msg === null) return
      const h = handshake.current
      switch (msg.event) {
        case 'yaseenReady':
          h.overlayReady = true
          configure()
          return
        case 'configure':
          h.configureAsked = true
          if (h.overlayReady) configure()
          else fallback = setTimeout(configure, READY_FALLBACK_MS)
          return
        case 'init':
          h.initialised = true
          syncTheme()
          syncColors()
          sendLoad(latestXml.current, autosave.current?.mtime ?? loaded.mtime)
          return
        case 'load': {
          const mtime = pendingLoad.current ?? autosave.current?.mtime ?? loaded.mtime
          pendingLoad.current = null
          const a = autosave.current
          // draw.io's own answer IS the baseline: nothing it shows after a load is an edit.
          if (a === null) start(version.current, mtime)
          else a.reset(version.current, mtime)
          return
        }
        case 'autosave':
        case 'save': {
          const a = autosave.current
          // A change before the first `load` answer has no baseline to be measured against.
          if (a === null || retired.current || pendingLoad.current !== null) return
          latestXml.current = msg.xml
          a.update(++version.current)
          if (msg.event === 'save') void a.flush()
          return
        }
        case 'shortcut':
          onToggleSidebar?.()
          return
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (fallback !== undefined) clearTimeout(fallback)
    }
  }, [configure, syncTheme, syncColors, sendLoad, autosave, retired, start, loaded.mtime, onToggleSidebar])

  // 🔒 YAZ-1802 D12: the app's theme, live.
  useEffect(() => {
    wantedTheme.current = theme
    syncTheme()
  }, [theme, syncTheme])

  // 🔒 YAZ-1802 D16: the dark-mode colour setting, live.
  useEffect(() => {
    wantedColors.current = darkColors
    syncColors()
  }, [darkColors, syncColors])

  return (
    <div className="drawio-editor" ref={board.hostRef}>
      {board.conflictBar}
      <BoardChips store={board.chips} className="drawio-editor__chips" />
      <iframe ref={frameRef} className="drawio-editor__frame" src={src} title={`${stripExt(basename(path))} — draw.io`} />
    </div>
  )
}
