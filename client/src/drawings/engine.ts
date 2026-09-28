/**
 * THE ENGINE'S NAME, AND THE TWO GLOBALS IT READS AT IMPORT TIME (YAZ-878, carried into the
 * document by 🔒 YAZ-1810).
 *
 * `@excalidraw/excalidraw` is NAMED here and nowhere else: every other module reaches it through
 * `loadExcalidraw()`, so the package's identity, its lazy loading and its two startup pins live
 * in one file.
 *
 * LAZY BY CONTRACT: a dynamic `import()` fired on the first canvas mount, so the renderer's entry
 * chunk never carries the package (≈250 transitive packages and megabytes of fonts). A window
 * sitting on Welcome, or on a folder with no tab open, loads none of it.
 *
 * OFFLINE BY CONTRACT (🔒 locked): the renderer must NEVER reach a CDN. Excalidraw resolves its
 * font files against `window.EXCALIDRAW_ASSET_PATH` and falls back to esm.sh only when that URL
 * FAILS, so the path is set — to the copy of the package's own asset folder bundled into the app
 * under `app://yaseen/excalidraw-assets/` — BEFORE the module is imported. The copy is made at
 * build time by `desktop/electron.vite.config.ts` (`excalidrawAssets()`) and never committed.
 * Fonts are fetched at all only for scenes that contain TEXT.
 *
 * The SAVE side pins the second global the same way: `serializeAsJSON` stamps `EXPORT_SOURCE`,
 * which the package reads ONCE at module-eval time as
 * `window.EXCALIDRAW_EXPORT_SOURCE || window.location.origin` — without this the app's own
 * `app://` origin would land in every file the user saves. It is set to the same `source` a new
 * drawing is born with (`drawingScene.ts`), so a file this app creates and this app edits differ
 * only in what was drawn.
 *
 * BOTH PINS MUST PRECEDE THE IMPORT, which is why they sit inside `loadExcalidraw` rather than at
 * module scope next to it: module scope would run them when THIS file is first imported, and
 * nothing guarantees that happens before some other module imports the package.
 *
 * THE THIRD PIN IS NOT A GLOBAL BUT A localStorage KEY (⚡ YAZ-1775 R4/R5, YAZ-1812), and it is the ONE
 * engine localStorage key this app touches — WRITTEN, never read. See `YASEEN_FULL_TOOLBAR_MODE`.
 */
import type { ComponentProps } from 'react'
import { EXCALIDRAW_ASSET_DIR } from '@shared/excalidrawFonts'
import { isDrawing } from '@shared/fileKind'
import { DRAWING_SOURCE } from './drawingScene'

declare global {
  interface Window {
    /** Excalidraw's own hook for "where do my fonts live"; unset would mean its esm.sh default. */
    EXCALIDRAW_ASSET_PATH?: string | readonly string[]
    /** Excalidraw's own hook for the `source` its exports stamp; unset would mean `location.origin`. */
    EXCALIDRAW_EXPORT_SOURCE?: string
  }
}

/**
 * THE CONTEXTUAL PROPERTIES TOOLBAR'S GATE (⚡ YAZ-1775 R4/R5). The engine's `deriveStylesPanelMode`
 * (`packages/common/src/editorInterface.ts:152-164`) answers `mobile` for a phone, `compact` for a
 * tablet, and otherwise whatever it finds under this localStorage key — read at mount and on
 * resize. `LayerUI.tsx:575` renders the fork's `<ContextualPropertiesToolbar>` (`Actions.tsx:377`)
 * — Yasin's horizontal bar, with the engine's own key hints — in the **`full`** desktop mode;
 * `LayerUI.tsx:242` renders upstream's vertical `compact-shape-actions-island` in `compact`.
 *
 * ⚡ THE NAMES READ BACKWARDS, which is why this constant exists rather than a bare string: the
 * fully built-out toolbar is `full`, and `compact` is upstream's lesser strip. Rounds 3–4 of the
 * demo had them inverted; round 5 corrected it against the fork source. There is no preference and
 * no toggle (the `propertiesToolbar` pref was removed by the round-4 amendment): this value is
 * written before EVERY mount, which is also what guards against a stray stored `compact`.
 *
 * `formFactor.ts` is the other half — without it a canvas pane narrowed by the shell sidebar falls
 * into the engine's ≤ 1180 px tablet band and is forced to `compact` before this key is consulted.
 */
export const DESKTOP_UI_MODE_STORAGE_KEY = 'excalidraw.desktopUIMode'
export const YASEEN_FULL_TOOLBAR_MODE = 'full' as const

/**
 * Writes the toolbar mode where the engine reads it, overwriting a stray stored value. A storage
 * that throws or is absent is silently skipped — the engine then measures its own way, and
 * `getFormFactor` still keeps it out of `compact`.
 */
export function applyToolbarMode(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()): void {
  try {
    if (storage === null) return
    if (storage.getItem(DESKTOP_UI_MODE_STORAGE_KEY) !== YASEEN_FULL_TOOLBAR_MODE) storage.setItem(DESKTOP_UI_MODE_STORAGE_KEY, YASEEN_FULL_TOOLBAR_MODE)
  } catch {
    // The engine measures its own way; `getFormFactor` is the other half of the guarantee.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The engine module, named here and nowhere else. */
export type ExcalidrawModule = typeof import('@excalidraw/excalidraw')

/**
 * The engine's IMPERATIVE HANDLE, derived from the engine's own component type rather than
 * re-declared: a hand-written interface is contravariant against `updateScene`'s generic and will
 * not accept the real API. Named here beside the module for the same reason the module is — the
 * canvas panel's tabs each narrow it to the four or five methods they actually use (`Pick<>`), so
 * a change to any of those signatures is a build error at the call site.
 */
export type ExcalidrawImperativeApi = NonNullable<Parameters<NonNullable<ComponentProps<ExcalidrawModule['Excalidraw']>['onExcalidrawAPI']>>[0]>

/**
 * THE ELEMENT PACKAGE, FOR THE SMART SHAPES ONLY (YAZ-1818). `@excalidraw/element` is the second
 * package of the vendored engine tree, and it is named HERE for the same reason the first one is:
 * it is ~300 kB that must not reach the renderer's entry chunk. The Image Studio's Shapes view
 * needs three values out of it — `SMART_SHAPE_DEFINITIONS`, `generateSmartShapePoints`,
 * `createSmartShapeMetadata` — which are not re-exported by `@excalidraw/excalidraw`'s index, so
 * they cannot come through `loadExcalidraw()`.
 *
 * It is a SEPARATE promise on purpose: the seven basic shapes need nothing at all, so the Shapes
 * view renders them immediately and the twelve Smart Shapes join a tick later, rather than the
 * panel waiting on a second download.
 */
export type ExcalidrawElementModule = typeof import('@excalidraw/element')

let elementLoading: Promise<ExcalidrawElementModule> | null = null

/** The element package, loaded lazily and shared; every consumer waits on this ONE promise. */
export function loadExcalidrawElement(): Promise<ExcalidrawElementModule> {
  elementLoading ??= import('@excalidraw/element')
  return elementLoading
}

/** The in-flight (then settled) module load; one per renderer, never re-imported. */
let loading: Promise<ExcalidrawModule> | null = null

/**
 * The engine, loaded lazily and pinned offline; every consumer waits on this ONE promise. Its
 * stylesheet rides the same first load (YAZ-2073 8B) — every rule in it is scoped to the engine's
 * own classes, so a caller that never mounts a canvas is styled no differently.
 */
export function loadExcalidraw(): Promise<ExcalidrawModule> {
  if (loading === null) {
    window.EXCALIDRAW_ASSET_PATH = new URL(`${EXCALIDRAW_ASSET_DIR}/`, window.location.href).toString()
    window.EXCALIDRAW_EXPORT_SOURCE = DRAWING_SOURCE
    loading = import('@excalidraw/excalidraw')
    void import('@excalidraw/excalidraw/index.css')
  }
  return loading
}

/**
 * THE BOOT-TIME WARM-UP (YAZ-2073 4B): a window restored onto a drawing mounts the canvas next, so
 * the engine's download and compile start at boot, in parallel with the first render, instead of
 * after it (the canvas mount was the only trigger, ~35 ms later). The same ONE promise and pins
 * `ExcalidrawSurface` uses; a window on Welcome, a folder or a diagram loads nothing, as before.
 */
export function warmEngineFor(file: string | null): void {
  if (file === null || !isDrawing(file)) return
  loadExcalidraw().catch(() => {}) // the canvas reports a failure itself, awaiting this same promise
}
