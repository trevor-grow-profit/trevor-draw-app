/**
 * THE ENGINE SEAM (YAZ-879, rebuilt for the drawing DOCUMENT in 🔒 YAZ-1810, given its chrome in
 * YAZ-1812).
 *
 * 🔒 ONE FILE OWNS THE CANVAS. This is the only component that mounts `<Excalidraw>`, the only
 * one that knows how a scene serializes, and the only one that knows what "changed" means to the
 * engine. `DrawingEditor` and the `useBoardDocument` chrome it rides on — the autosave, the dirty
 * state, the conflict bar, the chips — import this module's TYPES and this component and nothing
 * else, so replacing the engine rewrites this file and touches no chrome. `DrawingEditor.test.tsx`
 * mocks this one module and pins that boundary rather than trusting it.
 *
 * LAZY: the engine arrives through `engine.ts`'s `loadExcalidraw()` — one dynamic import per
 * renderer, with the offline font pin and the export-source pin already applied, its stylesheet
 * riding the same load — so the entry chunk stays free of both.
 *
 * SNAPSHOTS, NOT A CONTROLLED SCENE: the surface stays UNCONTROLLED (the engine owns its undo,
 * selection and tool state) and reports outward through `onSnapshot`. A snapshot is a cheap
 * change KEY — `getSceneVersion`, the engine's own sum of element versions, which is what it
 * offers for exactly this — plus a `serialize()` that costs nothing until a save fires. The
 * FIRST snapshot is emitted at mount, from the loaded scene, BEFORE the engine's own first
 * `onChange`, so the host always has a baseline to call "clean" even if the engine never
 * volunteers one. That baseline runs the disk elements through the engine's own
 * `restoreElements()` first: restore is what the engine actually mounts (it bumps element
 * `version` and materialises rounding values), so only a restore-then-compare baseline agrees
 * with the engine's first `onChange`, and an untouched drawing never reads as dirty. Restore is
 * deterministic, so the two independent runs always land on the same sum.
 *
 * ⚡ `getSceneVersion` IS A SUM, and a sum is not an identity: an undo that returns to the same
 * total reads CLEAN. Accepted on YAZ-1775 (demo round 1) — the alternative is hashing the
 * serialised scene on every pointer move, which is the cost the version exists to avoid, and the
 * failure mode is "a redundant save was skipped", not "an edit was lost".
 *
 * THE BOARD'S OWN appState COUNTS TOO (YAZ-2073 2E): the version adds `appStateEdits` — how often a
 * field the serializer writes (the canvas background, the grid size) has moved since the engine's
 * first `onChange` — so View › Canvas Background is an edit like any other (`boardAppState.ts`).
 *
 * SHAPE ON DISK: `serializeAsJSON(…, 'local')` is the library's OWN writer — the same one its
 * "Save to disk" uses — so element cleanup is its rules, not ours. Two things are ours: the
 * `files` argument is deliberately EMPTY (🔒 YAZ-1775 D3: bytes live in `<vault>/assets/`, the scene
 * carries ids only) and a trailing newline, so a file this app creates and this app saves differ
 * only in what was drawn. A snapshot hands the host the engine's LIVE files and the ids the
 * scene still references alongside the lean JSON, so the host can work out what the store is
 * missing (`unpersistedFiles`) without ever seeing an engine type.
 *
 * ⚡ EVERY PROP HANDED TO THE ENGINE IS STABLE. `<Excalidraw>` is memoized and calls `onChange`
 * whenever it renders, so a prop rebuilt per render is a feedback loop: change → the host
 * re-renders → new `initialData` / `onChange` identity → the memo misses → change… (React error
 * #185, seen on the first mount of the original embed). Hence the module-level `UI_OPTIONS`, the
 * ref-backed callbacks, the once-only `initialData`, the launcher STORE the rail subscribes to
 * rather than props, and the host memoizing what it passes in.
 *
 * THE CHROME INSIDE THE ENGINE (🔒 YAZ-1775 D10). No `<MainMenu>` at all: the engine's own trigger is
 * hidden (`drawingEditor.css`, the web app's own rule) and its items moved out — File › Export
 * Image… ⌘⇧E and View › Canvas Background to the application menu (`boardCommand.ts` routes
 * them to the visible drawing), Preferences to Settings › Canvas (🔒 YAZ-1775 D9). `renderTopLeftUI` is the
 * rail (`LauncherRail.tsx`: the panel hamburger plus the Writing / Frames toggles);
 * `renderTopRightUI` is the host's status chips, the slot the web app's CloudStatus sat in, so
 * they can never cover the tool island; the engine's one child is the docked workspace panel
 * (`CanvasSidebar.tsx`, ⚡ YAZ-1775 D8 amended). ⌘F / ⌘C open the Images / Components tabs with the web
 * app's guards, bound on THIS component's own element in the capture phase — never `window`.
 *
 * CANVAS PREFS BOTH WAYS (🔒 YAZ-1775 D9). `canvasPrefs` is the shell's copy, and `appliedRef` is what the
 * engine is believed to hold. Engine → shell: every `onChange` reads the prefs slice off the
 * engine's appState (`appStateToPrefs`) and, ONLY when it differs from `appliedRef`, records it
 * and reports it 300 ms later. Shell → engine: a `canvasPrefs` prop that differs from `appliedRef`
 * is pushed with `updateScene`, changed keys only, with `toolLock` merged into the CURRENT tool
 * and `framesVisible` applied through `updateFrameRendering` instead. Both directions compare
 * against that one ref before writing — that is the whole anti-ping-pong rule.
 */
/*
 * ENGINE PARITY (🔒 YAZ-1775 R3). The full record — every web-app prop, `UIOptions` field, child,
 * imperative call, startup default and editor CSS rule at fork `e72242f8`, each with its reason —
 * is the "1A · Engine parity checklist" comment on YAZ-1805. This block is the short true list.
 *
 * PORTED: `onChange` · `initialData` (the scene off disk + 🔒 YAZ-1775 D3 assets + 🔒 YAZ-1775 D9 prefs) ·
 *   `initialState` (open fitted to the content, 🔒 YAZ-1855 D1) · `theme` (live) · `detectScroll: false` · `autoFocus` · `excalidrawAPI` (the fork calls it
 *   `onExcalidrawAPI`) · `renderTopLeftUI` as the 🔒 YAZ-1775 D10 rail · `renderTopRightUI` as a slot for the
 *   shell's chips · `UIOptions.canvasActions.clearCanvas: false` · the sidebar as `CanvasSidebar`
 *   (Images / Components / Present) with the web app's ⌘F / ⌘C shortcuts and their suppression
 *   gates, its last-tab and dock memory (in the shell store), and the writing-mode and frames
 *   toggles · the Assistant-font, architect-roughness and centred-text startup defaults, as plain
 *   🔒 YAZ-1775 D9 prefs with no migration stamps.
 * ADDED (ours): `UIOptions.getFormFactor` — phone or desktop, never tablet (⚡ YAZ-1775 R5) ·
 *   `canvasActions.loadScene` and `saveToActiveFile` forced false, because autosave is the one door
 *   to the file · `excalidraw.desktopUIMode = 'full'` written before every mount (⚡ YAZ-1775 R4/R5).
 * DROPPED: everything cloud, collab, share-link, AI, Excalidraw+ and Boards/Docs · `<MainMenu>`
 *   entirely (🔒 YAZ-1775 D10 moved Export Image…, Export Drawing… and Canvas Background to the application
 *   menu, Preferences and Theme to Settings) · `langCode`, `viewModeEnabled`,
 *   `viewModeSelectionEnabled`, `renderCustomStats`, `onExport`, `onThemeChange`, `onLinkOpen`,
 *   the embeddable trio · `onImageBackgroundRemoval` (🔒 YAZ-1775 D6) · `AppWelcomeScreen`,
 *   `OverwriteConfirmDialog`, `AppFooter`, `ErrorDialog`, `DebugCanvas` and the palette's custom
 *   items · every `excalidraw-app/` localStorage key (🔒 YAZ-1775 D9).
 *   `handleKeyboardGlobally` is THE ONE DELIBERATE DROP: several tabs each mount an engine, and
 *   every one of them would answer a single global key.
 *
 * THE IMPERATIVE DOORS THIS APP USES: `updateScene` (the prefs push, the dock pref, image export,
 * canvas background, `replaceScene`) · `refresh` · `getAppState` / `getSceneElements` / `getFiles` /
 * `addFiles` (the 🔒 YAZ-1775 D3 hydrate/extract path, and a dropped scene's bytes) · `insertElements` (a dropped
 * scene file, `dropScene.ts`) · `updateFrameRendering` (the frames pref's one
 * application path) · `setViewport` and `setActiveTool` (the Present tab) · `toggleSidebar` (the
 * hamburger and the two shortcuts). `focusContainer` is RE-IMPLEMENTED here: the engine keeps it
 * on its App class rather than on the imperative API, so the seam focuses `.excalidraw-container`
 * itself for the tab-reveal handoff (🔒 YAZ-1812).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { referencedFileIds, type DrawingFileData } from '@shared/drawingAssets'
import { appStateToPrefs, changedPrefKeys, prefsEqual, prefsToAppState, type EngineAppStateSlice } from '@shared/canvasPrefs'
import { DEFAULT_CANVAS_PANEL, DEFAULT_CANVAS_PREFS, type CanvasPanelState, type CanvasPanelTab, type CanvasPrefs } from '@shared/types'
import { CANVAS_SIDEBAR, CanvasSidebar, openCanvasTab } from './CanvasSidebar'
import { appStateEdits, boardAppStateKeys } from './boardAppState'
import { openViewport, type DrawingScene } from './drawingScene'
import { droppedSceneFile, mergeDroppedScene, shouldMergeDrop } from './dropScene'
import { applyToolbarMode, loadExcalidraw, type ExcalidrawModule } from './engine'
import { yaseenFormFactor } from './formFactor'
import { applyFramesVisibility } from './framesVisibility'
import { createLauncherStore, LauncherRail } from './LauncherRail'
import { assembleStandaloneScene } from './exportDrawing'
import { PresentationPlayer } from './presentation/PresentationPlayer'

type ExcalidrawProps = ComponentProps<ExcalidrawModule['Excalidraw']>
type ChangeArgs = Parameters<NonNullable<ExcalidrawProps['onChange']>>
type ImperativeApi = NonNullable<Parameters<NonNullable<ExcalidrawProps['onExcalidrawAPI']>>[0]>
type EngineAppState = ChangeArgs[1]

/** What the host learns about the canvas; deliberately engine-free (a number and a thunk). */
export interface DrawingSnapshot {
  /** Cheap identity of the drawn content — elements and the board's own appState: equal to the baseline's = nothing to save. */
  readonly version: number
  /**
   * Everything a save needs, computed once when the save timer fires: the scene in the 🔒 YAZ-1775 D3
   * form (`files: {}`), the engine's live image map, and the ids the scene still references.
   */
  serialize(): { json: string; files: Record<string, DrawingFileData>; referenced: Set<string> }
}

/** The engine-free handle the host gets; nothing in it names the package. */
export interface DrawingSurfaceApi {
  /** Re-measure the canvas — a tab hidden by `visibility` may have been laid out at the wrong size. */
  refresh(): void
  /**
   * Put the keyboard in the canvas (🔒 focus handoff on tab reveal, YAZ-1812): the engine's own
   * `focusContainer()`, so the tool hotkeys work without a click when a mounted tab comes back
   * into view. The HOST decides WHETHER — `focusHandoff.ts` is the gate — this only does it.
   */
  focus(): void
  /**
   * File › Export Image… (🔒 YAZ-1775 D10): the engine's OWN export dialog, opened through its own
   * `appState.openDialog` door — the clean way in, found in demo round 4, with no keyboard-event hack.
   */
  openImageExport(): void
  /**
   * View › Canvas Background (🔒 YAZ-1775 D10): `appState.viewBackgroundColor`, which the engine then
   * writes into the file. The one canvas value that is per BOARD rather than per user.
   */
  setCanvasBackground(color: string): void
  /**
   * File › Export Drawing… (🔒 YAZ-1775 D3, YAZ-1821): the canvas as a STANDALONE `.excalidraw` — the whole
   * live files map, minus what only deleted elements name, embedded in the JSON. This is the one
   * place this app embeds; `serialize()` above is the lean vault form and is untouched by it.
   */
  exportScene(): string
  /**
   * Replace what the canvas shows (the file changed on disk under a clean editor). Returns the
   * version the engine will report for it — the host's new clean baseline. Computed from the
   * RESTORED elements we hand in, not read back from the engine afterwards: a read-back races
   * the engine's own commit, and a baseline one version stale makes the reload look like an
   * edit and writes it straight back to disk.
   */
  replaceScene(scene: DrawingScene): number
}

export interface DrawingSurfaceProps {
  /** The scene as it came off disk; the canvas opens on it and never re-reads it. */
  scene: DrawingScene
  /** The app's resolved appearance, handed to the engine as-is (a prop change re-themes live). */
  theme: 'light' | 'dark'
  /**
   * The shell's canvas preferences (🔒 YAZ-1775 D9). Seeded into `initialData.appState` at mount — layered
   * OVER the file's own appState, which overrides nothing of the drawing because none of these
   * keys are ones the engine exports into a file — and applied live whenever they differ from
   * what the engine is believed to hold.
   */
  canvasPrefs?: CanvasPrefs
  /** A pref the ENGINE or the rail changed. Reported only when a value actually moved, 300 ms debounced. */
  onCanvasPrefsChange?: (next: CanvasPrefs) => void
  /** What the canvas panel remembers: the tab the hamburger opens on, and the dock preference (🔒 YAZ-1775 D10). */
  canvasPanel?: CanvasPanelState
  onCanvasPanelChange?: (next: CanvasPanelState) => void
  /** Mount, then every engine change. The first call is the host's clean baseline. */
  onSnapshot: (snapshot: DrawingSnapshot) => void
  /** The engine itself failed to load — the host shows it and offers nothing but the message. */
  onFailed: (message: string) => void
  /** Called once the engine is mounted, with the handle above. */
  onApi?: (api: DrawingSurfaceApi) => void
  /** The status chips, in the engine's own top-right row; memoize it (see the prop-stability note). */
  renderTopRight?: () => ReactNode
}

/** The one failure this seam can raise on its own (the file's own failures are the host's). */
export const ENGINE_LOAD_FAILED = "Can't open the Excalidraw editor."

/** How long the engine's own toggles settle before the shell hears about them (🔒 YAZ-1775 D9). */
const PREFS_DEBOUNCE_MS = 300

/**
 * The file IS the document: the app's autosave is the ONE door to its bytes, so the engine's own
 * open and save-to-file doors stay shut — a second writer would race the first. `clearCanvas` is
 * off for the web app's own reason (a destructive action with no undo affordance in this shell).
 * Image export is untouched: it writes somewhere else entirely. `getFormFactor` is ours (⚡ YAZ-1775 R5):
 * the pane is a desktop editor whatever width the shell sidebar leaves it.
 */
const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, clearCanvas: false },
  getFormFactor: yaseenFormFactor,
} as const

/**
 * The file's own loose shape as the engine's arguments. `drawingScene.ts` validates only the
 * OUTLINE because the file is user data; the engine's `restore()` decides the rest.
 */
function engineScene(scene: DrawingScene, canvasAppState: Record<string, unknown>): { elements: ChangeArgs[0]; appState: EngineAppState; files: ChangeArgs[2] } {
  return {
    elements: scene.elements as ChangeArgs[0],
    appState: { ...scene.appState, ...canvasAppState } as unknown as EngineAppState,
    files: scene.files as ChangeArgs[2],
  }
}

export function ExcalidrawSurface({
  scene,
  theme,
  canvasPrefs = DEFAULT_CANVAS_PREFS,
  onCanvasPrefsChange,
  canvasPanel = DEFAULT_CANVAS_PANEL,
  onCanvasPanelChange,
  onSnapshot,
  onFailed,
  onApi,
  renderTopRight,
}: DrawingSurfaceProps) {
  const [engine, setEngine] = useState<ExcalidrawModule | null>(null)
  // Callbacks change identity on every host render; the load must run ONCE and `onChange` must
  // never change identity, so all of them go through refs.
  const engineRef = useRef<ExcalidrawModule | null>(null)
  /** The board's own appState edits (see the module doc), counted from the engine's first `onChange`. */
  const countEdits = useRef<ReturnType<typeof appStateEdits> | null>(null)
  const emitRef = useRef(onSnapshot)
  const failRef = useRef(onFailed)
  const apiRef = useRef(onApi)
  const prefsOutRef = useRef(onCanvasPrefsChange)
  const panelOutRef = useRef(onCanvasPanelChange)
  const panelRef = useRef(canvasPanel)
  /** The engine's raw handle, for the rail and the shortcuts; null until it has mounted. */
  const rawApiRef = useRef<ImperativeApi | null>(null)
  /**
   * The same handle as STATE, because the Images tab is a child of `<Excalidraw>` that has to
   * re-render when it arrives (YAZ-1818) — a ref alone would leave the tab's insert button
   * disabled for the life of the mount.
   */
  const [imperativeApi, setImperativeApi] = useState<ImperativeApi | null>(null)
  /**
   * ⌘F's one-shot request to focus the Images tab's search field (🔒 YAZ-1990). A flag the tab
   * clears, never a counter: the tab re-mounts on every reopen and must not re-read an old press.
   * Per surface, not in the shared session, so a hidden drawing tab can never consume it.
   */
  const [searchFocusPending, setSearchFocusPending] = useState(false)
  const onSearchFocused = useCallback(() => setSearchFocusPending(false), [])
  /**
   * Whether the canvas holds a selection, for the Components tab's "Save selection" (YAZ-1819).
   * The web app read it with the engine's `useUIAppState()` hook inside the panel; here it is read
   * off the SAME `onChange` the rest of this seam is driven by, so the tab needs no engine hook —
   * and because it is a boolean, the memoized panel is re-made only when it actually flips.
   */
  const [hasSelection, setHasSelection] = useState(false)
  /** This seam's own element — the handle's `focus()` reaches the engine's container through it. */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /**
   * The presentation, if one is running (YAZ-1820): the player is a SIBLING of `<Excalidraw>`, not
   * a child of the Present tab, because a tab's body is unmounted the moment the panel closes and
   * closing the panel must not end a presentation. It covers this pane and no other, which is why
   * it is here rather than portalled to `document.body` as the web app's was.
   */
  const [presenting, setPresenting] = useState<{ initialFrameId: string | null } | null>(null)
  emitRef.current = onSnapshot
  failRef.current = onFailed
  apiRef.current = onApi
  prefsOutRef.current = onCanvasPrefsChange
  panelOutRef.current = onCanvasPanelChange
  panelRef.current = canvasPanel

  /** What the engine is believed to hold (see the anti-ping-pong note in the module doc). */
  const appliedRef = useRef<CanvasPrefs>(canvasPrefs)
  /** The engine → shell debounce: the latest value and its timer. */
  const pendingRef = useRef<{ prefs: CanvasPrefs; timer: ReturnType<typeof setTimeout> } | null>(null)
  const reportPrefs = useCallback((next: CanvasPrefs) => {
    if (pendingRef.current !== null) clearTimeout(pendingRef.current.timer)
    pendingRef.current = {
      prefs: next,
      timer: setTimeout(() => {
        pendingRef.current = null
        prefsOutRef.current?.(next)
      }, PREFS_DEBOUNCE_MS),
    }
  }, [])
  // Unmount: a change still on the timer is reported rather than lost.
  useEffect(
    () => () => {
      const pending = pendingRef.current
      if (pending === null) return
      clearTimeout(pending.timer)
      pendingRef.current = null
      prefsOutRef.current?.(pending.prefs)
    },
    [],
  )

  /** Remember a panel choice (🔒 YAZ-1775 D10); a value that did not move is not a write. */
  const rememberPanel = useCallback((patch: Partial<CanvasPanelState>) => {
    const next = { ...panelRef.current, ...patch }
    if (next.tab === panelRef.current.tab && next.docked === panelRef.current.docked) return
    panelRef.current = next
    panelOutRef.current?.(next)
  }, [])

  /** THE one door that closes the canvas panel (🔒 YAZ-1775 D10) — the hamburger, the ✕ and Play. */
  const closePanel = useCallback(() => rawApiRef.current?.toggleSidebar({ name: null, force: false }), [])

  // The rail's store, made ONCE: the hamburger drives the engine's sidebar, the two toggles write
  // the PREF and let the round trip apply it. Every action reads the refs above, so the store — and
  // therefore `renderTopLeftUI` — never changes identity.
  const rail = useMemo(() => {
    const flip = (key: 'writingMode' | 'framesVisible') => prefsOutRef.current?.({ ...appliedRef.current, [key]: !appliedRef.current[key] })
    const store = createLauncherStore(
      {
        // 🔒 YAZ-1775 D10: open on the last-used tab (Components until then); pressing again closes.
        togglePanel: () => {
          if (store.getState().activeTab !== null) closePanel()
          else rawApiRef.current?.toggleSidebar({ name: CANVAS_SIDEBAR, tab: panelRef.current.tab, force: true })
        },
        // The web app's rule: open on the tab; the ACTIVE tab's own shortcut closes the panel.
        openTab: (tab) => rawApiRef.current?.toggleSidebar({ name: CANVAS_SIDEBAR, tab, force: store.getState().activeTab !== tab }),
        toggleWriting: () => flip('writingMode'),
        toggleFrames: () => flip('framesVisible'),
      },
      { ready: false, activeTab: null, writingMode: canvasPrefs.writingMode, framesVisible: canvasPrefs.framesVisible },
    )
    return store
    // Mount-only by contract: the initial values are read once (`closePanel` is stable), and every
    // later value arrives through `set` from the effect below.
  }, [closePanel])

  // Play (YAZ-1820): the panel closes, because it would otherwise sit on top of the deck. Stable
  // identities, so the memoized panel and the memoized `<Excalidraw>` are untouched by them.
  const startPresentation = useCallback(
    (initialFrameId: string | null) => {
      closePanel()
      setPresenting({ initialFrameId })
    },
    [closePanel],
  )
  const endPresentation = useCallback(() => setPresenting(null), [])
  /**
   * The player hid the frame outlines to present; this puts back what the USER's preference says
   * (🔒 YAZ-1775 D9: `SettingsState.canvas.framesVisible`, read off the one ref that knows what the engine
   * is believed to hold — where the web app read a localStorage key).
   */
  const restoreFrames = useCallback(() => {
    const api = rawApiRef.current
    if (api !== null) applyFramesVisibility(api, appliedRef.current.framesVisible)
  }, [])
  const onDock = useCallback((docked: boolean) => rememberPanel({ docked }), [rememberPanel])

  /**
   * The web app's `c` / `f` shortcuts (`AppSidebar.tsx:983-1078`) as ⌘C → Components and
   * ⌘F → Images, with its guards kept verbatim: the primary modifier alone, no repeat, no IME
   * composition, no editable target, no live text selection, and — asked of the engine itself —
   * no element being drawn, dragged, resized, rotated or cropped, no text being edited, no dialog
   * open and nothing selected. Those gates are why the keys never fire mid-drag or mid-edit, and
   * why ⌘C still copies a selection.
   *
   * Bound on THIS element in the CAPTURE phase, never `window`: the shell keeps several tabs
   * mounted, each with its own engine, and only the focused canvas may answer (🔒 YAZ-1775 R3).
   */
  const onKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      const api = rawApiRef.current
      if (api === null) return
      const key = event.key.toLowerCase()
      const tab: CanvasPanelTab | null = key === 'c' ? 'components' : key === 'f' ? 'image-studio' : null
      if (tab === null || !event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.repeat || event.nativeEvent.isComposing) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("[contenteditable='true']") !== null)) return
      const selection = window.getSelection()
      if (selection !== null && !selection.isCollapsed) return
      const appState = api.getAppState() as unknown as Record<string, unknown>
      const busy = BUSY_APP_STATE_KEYS.some((k) => Boolean(appState[k]))
      if (busy || appState.cursorButton === 'down' || Object.keys((appState.selectedElementIds ?? {}) as Record<string, unknown>).length > 0) return
      event.preventDefault()
      event.stopPropagation()
      // ⌘F does not just open the tab, it puts the caret in the search field — the web app's
      // `onRequestImageStudioSearch` (`AppSidebar.tsx:1071-1072`). Only when this press OPENS it:
      // the active tab's own shortcut closes the panel, and must leave nothing pending behind.
      if (tab === 'image-studio' && rail.getState().activeTab !== tab) setSearchFocusPending(true)
      rail.openTab(tab)
    },
    [rail],
  )

  /**
   * A SCENE FILE DROPPED ON A BOARD ADDS TO IT (`dropScene.ts`). The engine's own `onDrop` would
   * REPLACE the canvas with the file; this capture-phase handler on the seam's own element runs
   * first and, for one `.excalidraw` / `.json` on a board that holds elements, stops the event and
   * inserts the file instead. Every other drop — images, a library, several files, an empty board —
   * falls through to the engine untouched. A file that will not parse is reported in the engine's
   * own error dialog, the same place its loader reports one.
   */
  const onDropCapture = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const api = rawApiRef.current
    const mod = engineRef.current
    if (api === null || mod === null) return
    const file = droppedSceneFile(event.dataTransfer)
    if (file === null || !shouldMergeDrop(api.getSceneElements())) return
    event.preventDefault()
    event.stopPropagation()
    void file
      .text()
      .then((json) => {
        mergeDroppedScene(mod, api, json)
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        api.updateScene({ appState: { errorMessage: `Could not add "${file.name}": ${reason}` } as unknown as EngineAppState })
      })
  }, [])

  // Shell → engine (🔒 YAZ-1775 D9): a prop that differs from what was last applied is pushed, changed keys
  // only. `framesVisible` goes through `updateFrameRendering`; `toolLock` is merged into the tool
  // the engine is HOLDING, because a partial `activeTool` would wipe it.
  useEffect(() => {
    rail.set({ writingMode: canvasPrefs.writingMode, framesVisible: canvasPrefs.framesVisible })
    if (prefsEqual(canvasPrefs, appliedRef.current)) return
    const keys = changedPrefKeys(appliedRef.current, canvasPrefs)
    appliedRef.current = canvasPrefs
    const api = rawApiRef.current
    if (api === null) return
    const appState = prefsToAppState(
      canvasPrefs,
      keys.filter((k) => k !== 'toolLock' && k !== 'framesVisible'),
    )
    if (keys.includes('toolLock')) appState.activeTool = { ...api.getAppState().activeTool, locked: canvasPrefs.toolLock }
    if (Object.keys(appState).length > 0) api.updateScene({ appState: appState as unknown as EngineAppState })
    if (keys.includes('framesVisible')) applyFramesVisibility(api, canvasPrefs.framesVisible)
  }, [canvasPrefs, rail])

  // The scene and the prefs are read ONCE, at mount, by the effect below; a ref keeps them out of
  // its dependency list without lying to the linter about what it uses.
  const openedOn = useRef({ scene, canvasPrefs })

  useEffect(() => {
    let live = true
    // ⚡ YAZ-1775 R4/R5: the engine reads its styles-panel mode out of localStorage at mount, so the one
    // mode this app ships lands there before every mount — the guard against a stray stored value.
    applyToolbarMode()
    loadExcalidraw().then(
      (mod) => {
        if (!live) return
        engineRef.current = mod
        countEdits.current = appStateEdits(boardAppStateKeys(mod))
        setEngine(mod)
        // The baseline, before the engine has said anything — through the engine's own restore,
        // because restored elements are what it mounts (see the module doc).
        const { elements, appState, files } = engineScene(openedOn.current.scene, prefsToAppState(openedOn.current.canvasPrefs))
        emitRef.current(snapshotOf(mod, mod.restoreElements(elements, null) as ChangeArgs[0], appState, files, 0))
      },
      () => {
        if (live) failRef.current(ENGINE_LOAD_FAILED)
      },
    )
    return () => {
      live = false
    }
  }, [])

  // Built ONCE, from the mount-time scene and prefs: the engine reads `initialData` only at mount,
  // and a fresh identity on every settings write would re-render the memoized `<Excalidraw>` for
  // nothing (the #185 rule). The saved scene may sit far from the origin, so open on ALL of it
  // (🔒 YAZ-1855 D1) — `initialState.viewport`, which the engine resolves once the canvas is measured.
  const [initialData] = useState(() => engineScene(scene, prefsToAppState(canvasPrefs)))
  const [initialState] = useState(() => openViewport(scene) as ExcalidrawProps['initialState'])

  const onChange = useCallback(
    (elements: ChangeArgs[0], appState: EngineAppState, files: ChangeArgs[2]) => {
      const mod = engineRef.current
      const edits = countEdits.current
      if (mod !== null && edits !== null) emitRef.current(snapshotOf(mod, elements, appState, files, edits(appState as unknown as Record<string, unknown>)))
      // The canvas panel's open tab: the rail's emphasis, the triggers' opacity, and the memory
      // the hamburger opens on next time.
      setHasSelection(Object.keys((appState as unknown as { selectedElementIds?: Record<string, unknown> }).selectedElementIds ?? {}).length > 0)
      const activeTab = openCanvasTab((appState as unknown as { openSidebar?: { name?: string; tab?: string } | null }).openSidebar)
      if (activeTab !== null) rememberPanel({ tab: activeTab })
      rail.set({ activeTab })
      // Engine → shell (🔒 YAZ-1775 D9): the prefs slice, compared before anything is written.
      const seen = appStateToPrefs(appState as unknown as EngineAppStateSlice, appliedRef.current)
      if (prefsEqual(seen, appliedRef.current)) return
      appliedRef.current = seen
      rail.set({ writingMode: seen.writingMode, framesVisible: seen.framesVisible })
      reportPrefs(seen)
    },
    [rail, rememberPanel, reportPrefs],
  )

  /** The imperative handle, wrapped once into the engine-free API the host sees. */
  const onExcalidrawAPI = useCallback(
    (api: ImperativeApi | null) => {
      // The engine hands null on unmount; the host's ref keeps the last live handle, which it
      // never calls after its own unmount. `engineRef` is set before `<Excalidraw>` ever renders.
      if (api === null || engineRef.current === null) return
      const mod = engineRef.current
      rawApiRef.current = api
      setImperativeApi(api)
      // Frames are never appState (🔒 YAZ-1775 D9): applied the moment the engine can take them.
      applyFramesVisibility(api, appliedRef.current.framesVisible)
      // The dock preference the web app kept per cloud username, kept in the shell store here.
      const docked = panelRef.current.docked
      if (api.getAppState().defaultSidebarDockedPreference !== docked) api.updateScene({ appState: { defaultSidebarDockedPreference: docked } as unknown as EngineAppState })
      rail.set({ ready: true })
      apiRef.current?.({
        refresh: () => api.refresh(),
        // `focusContainer()` lives on the engine's App class, not on this handle — so do what it
        // does: focus the engine's own container, the element it gives `tabIndex` for exactly this.
        focus: () => rootRef.current?.querySelector<HTMLElement>('.excalidraw-container')?.focus(),
        openImageExport: () => api.updateScene({ appState: { openDialog: { name: 'imageExport' } } as unknown as EngineAppState }),
        setCanvasBackground: (color) => api.updateScene({ appState: { viewBackgroundColor: color } as unknown as EngineAppState }),
        // The FULL files map, straight off the engine: everything YAZ-1811 hydrated out of `assets/` at
        // load plus anything pasted or inserted since and not yet saved. The store's copy would be
        // missing the second half.
        exportScene: () =>
          assembleStandaloneScene(mod, {
            elements: api.getSceneElements() as readonly unknown[],
            appState: api.getAppState() as unknown as Record<string, unknown>,
            files: api.getFiles() as unknown as Record<string, unknown>,
          }),
        replaceScene: (next) => {
          const restored = mod.restoreElements(next.elements as ChangeArgs[0], null)
          api.updateScene({ elements: restored })
          const entries = Object.values(next.files) as Parameters<ImperativeApi['addFiles']>[0]
          if (entries.length > 0) api.addFiles(entries)
          return mod.getSceneVersion(restored)
        },
      })
    },
    [rail],
  )

  // The rail rides the slot the web app's launchers did; its identity never changes (see above).
  const renderTopLeftUI = useCallback(() => <LauncherRail store={rail} />, [rail])
  // The chips live in the engine's OWN top-right row (the slot the web app's cloud status sits
  // in) rather than a strip above the canvas, so the canvas starts directly under the tab bar
  // and the chips can never cover the toolbar island.
  const renderTopRightUI = useMemo(
    () => (renderTopRight === undefined ? undefined : () => <div className="excalidraw-ui-top-right drawing-editor__top-right">{renderTopRight()}</div>),
    [renderTopRight],
  )

  // The panel is re-created only when the open tab moves — its triggers' emphasis is the one
  // thing about it that depends on live state.
  const [activeTab, setActiveTab] = useState<CanvasPanelTab | null>(null)
  useEffect(() => rail.subscribe(() => setActiveTab(rail.getState().activeTab)), [rail])
  const canvasSidebar = useMemo(
    () =>
      engine === null ? null : (
        <CanvasSidebar
          engine={engine}
          activeTab={activeTab}
          onClose={closePanel}
          onDock={onDock}
          excalidrawAPI={imperativeApi}
          searchFocusPending={searchFocusPending}
          onSearchFocused={onSearchFocused}
          hasSelection={hasSelection}
          onStartPresentation={startPresentation}
        />
      ),
    [engine, activeTab, closePanel, onDock, imperativeApi, searchFocusPending, onSearchFocused, hasSelection, startPresentation],
  )

  // The frame held while the engine chunk is arriving; `.drawing-editor__canvas > div` sizes it.
  if (engine === null) return <div />
  const { Excalidraw } = engine
  return (
    // The surface's own element, so ⌘F / ⌘C are heard here and nowhere else in the shell.
    <div ref={rootRef} className="drawing-surface" onKeyDownCapture={onKeyDownCapture} onDropCapture={onDropCapture}>
      <Excalidraw
        initialData={initialData}
        initialState={initialState}
        theme={theme}
        UIOptions={UI_OPTIONS}
        onChange={onChange}
        onExcalidrawAPI={onExcalidrawAPI}
        renderTopLeftUI={renderTopLeftUI}
        renderTopRightUI={renderTopRightUI}
        // The engine's own scroll listener is for a page that scrolls under it; this pane does not.
        detectScroll={false}
        // Safe on a background tab: hidden layers are `visibility: hidden` (tabs.css), and
        // Chromium will not move focus into a hidden subtree — so only a visible canvas takes it.
        autoFocus
      >
        {canvasSidebar}
      </Excalidraw>
      {presenting !== null && imperativeApi !== null && (
        <PresentationPlayer
          engine={engine}
          excalidrawAPI={imperativeApi}
          initialFrameId={presenting.initialFrameId}
          onExit={endPresentation}
          onRestoreFrames={restoreFrames}
        />
      )}
    </div>
  )
}

/**
 * The web app's "a gesture is in flight" set (`AppSidebar.tsx:1011-1061`), as appState keys: any
 * one of them truthy means the keystroke could have meant something else.
 */
const BUSY_APP_STATE_KEYS = [
  'newElement',
  'multiElement',
  'selectionElement',
  'resizingElement',
  'selectedLinearElement',
  'editingFrame',
  'croppingElementId',
  'selectedElementsAreBeingDragged',
  'isResizing',
  'isRotating',
  'editingTextElement',
  'openDialog',
] as const

/** One snapshot from the engine's own two utilities; the only place either is called. */
function snapshotOf(engine: ExcalidrawModule, elements: ChangeArgs[0], appState: EngineAppState, files: ChangeArgs[2], appStateEditCount: number): DrawingSnapshot {
  return {
    version: engine.getSceneVersion(elements) + appStateEditCount,
    serialize: () => {
      // The engine's map, flattened to the two fields that cross the bridge: its `created` /
      // `lastRetrieved` bookkeeping is about this session, not about the file.
      const live: Record<string, DrawingFileData> = {}
      for (const [id, entry] of Object.entries(files)) {
        if (typeof entry?.dataURL === 'string' && typeof entry.mimeType === 'string') live[id] = { mimeType: entry.mimeType, dataURL: entry.dataURL }
      }
      return {
        // 🔒 YAZ-1775 D3: an EMPTY files map on purpose — the scene names its images and never carries
        // them. A text file in a git vault ends with a newline, as a new drawing is written.
        json: `${engine.serializeAsJSON(elements, appState, {}, 'local')}\n`,
        files: live,
        referenced: referencedFileIds(elements),
      }
    },
  }
}
