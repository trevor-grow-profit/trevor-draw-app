/** The canvas preferences and the in-canvas docked panel (🔒 YAZ-1775 D9 / D10). */

import type { SettingsState } from './appState'

/**
 * The user-level canvas preferences held in `SettingsState.canvas`: the engine's
 * `browser: true, export: false` appState (`packages/excalidraw/appState.ts`) plus frame
 * visibility. The TYPE and the DEFAULTS live in this leaf file; the mapping to and from the
 * engine's appState keys is `shared/canvasPrefs.ts`, which imports from here so that nothing
 * downstream of the mapping has to know about the engine.
 *
 * WHY here and not in the engine's own localStorage (the web app's answer): the engine package
 * does not persist appState, so grid / tool lock / zen would reset on every mount, be invisible
 * to the settings cog, and differ per window. One store, broadcast to every window, is the rule.
 */
export const SELECT_ON_MODES = ['wrap', 'overlap'] as const
export type SelectOn = (typeof SELECT_ON_MODES)[number]
/** The engine's roughness presets (`ROUGHNESS`): architect 0, artist 1, cartoonist 2. */
export const ROUGHNESS_LEVELS = [0, 1, 2] as const
export type Roughness = (typeof ROUGHNESS_LEVELS)[number]
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const
export type TextAlign = (typeof TEXT_ALIGNS)[number]

/**
 * The laser's own settings (🔒 YAZ-1989 D1), in the fork's spelling so the mapping is a straight
 * copy; the first of each list is the stock laser and the default. `canvasPrefsEngine.test.ts`
 * pins the lists and defaults to the vendored engine's exports.
 */
export const LASER_TRAIL_MODES = ['fade', 'hold', 'sticky'] as const
export type LaserTrailMode = (typeof LASER_TRAIL_MODES)[number]
export const LASER_COLORS = ['#ff0000', '#ffd400', '#00c853', '#2979ff', '#d500f9'] as const
export type LaserColor = (typeof LASER_COLORS)[number]
export const LASER_SIZES = ['S', 'M', 'L'] as const
export type LaserSize = (typeof LASER_SIZES)[number]

/**
 * The fork's `FONT_FAMILY` ids the Default font row offers (`packages/common/src/constants.ts`),
 * Assistant first because it is the value the web app forced through a one-shot localStorage
 * migration — carried here as a plain preference instead, with no migration stamp (🔒 YAZ-1775 D9).
 * Id 4 is deliberately absent: the fork leaves it unused for historical reasons.
 */
export const FONT_FAMILY_OPTIONS: ReadonlyArray<{ id: number; label: string }> = [
  { id: 10, label: 'Assistant' },
  { id: 5, label: 'Excalifont' },
  { id: 1, label: 'Virgil' },
  { id: 2, label: 'Helvetica' },
  { id: 3, label: 'Cascadia' },
  { id: 6, label: 'Nunito' },
  { id: 7, label: 'Lilita One' },
  { id: 8, label: 'Comic Shanns' },
  { id: 9, label: 'Liberation Sans' },
  { id: 11, label: 'Inter' },
  { id: 12, label: 'Roboto' },
  { id: 13, label: 'Liberation Serif' },
  { id: 14, label: 'IBM Plex Mono' },
]

export interface CanvasPrefs {
  gridModeEnabled: boolean
  objectsSnapModeEnabled: boolean
  /** The engine's `isMidpointSnappingEnabled`. */
  snapToMidpoints: boolean
  /** The engine's `isBindingEnabled` (arrows bind to the shapes they touch). */
  arrowBinding: boolean
  /** The engine's `boxSelectionMode`: `wrap` = `contain`, `overlap` = `overlap`. */
  selectOn: SelectOn
  /** `activeTool.locked` — NOT a plain key: a live update has to merge with the CURRENT tool. */
  toolLock: boolean
  zenModeEnabled: boolean
  writingMode: boolean
  /** The engine's `currentItemWritingStrokeWidth` (`WRITING_STROKE_WIDTH.default`). */
  writingStrokeWidth: number
  /** The engine's `currentItemVectorStrokeWidth` (`STROKE_WIDTH.medium`). */
  vectorStrokeWidth: number
  /**
   * `frameRendering.outline` + `.name` together — the grey box and its label. NEVER `clip` or
   * `enabled`: turning `enabled` off would also stop frames clipping their children. Applied
   * through the engine's `updateFrameRendering`, never through appState.
   */
  framesVisible: boolean
  /** New text's font (`currentItemFontFamily`, a `FONT_FAMILY_OPTIONS` id): Assistant (10). */
  defaultFontFamily: number
  /** New shapes' sloppiness (`currentItemRoughness`): architect (0). */
  defaultRoughness: Roughness
  /** New text's alignment (`currentItemTextAlign`): the engine's `DEFAULT_NEW_TEXT_ALIGN`. */
  defaultTextAlign: TextAlign
  /** The laser's trail (`laserTrailMode`): `fade` (🔒 YAZ-1989 D1). */
  laserTrailMode: LaserTrailMode
  /** The laser's colour (`laserColor`, a `LASER_COLORS` swatch): red (🔒 YAZ-1989 D1). */
  laserColor: LaserColor
  /** The laser's size (`laserSize`): `S` (🔒 YAZ-1989 D1). */
  laserSize: LaserSize
}

/** The engine's own defaults (`appState.ts` `getDefaultAppState()` + `constants.ts`). */
export const DEFAULT_CANVAS_PREFS: CanvasPrefs = {
  gridModeEnabled: false,
  objectsSnapModeEnabled: false,
  snapToMidpoints: true,
  arrowBinding: true,
  selectOn: 'wrap',
  toolLock: false,
  zenModeEnabled: false,
  writingMode: false,
  writingStrokeWidth: 0.5,
  vectorStrokeWidth: 2,
  framesVisible: true,
  defaultFontFamily: 10,
  defaultRoughness: 0,
  defaultTextAlign: 'center',
  laserTrailMode: 'fade',
  laserColor: '#ff0000',
  laserSize: 'S',
}

/**
 * The in-canvas docked panel's tabs (⚡ YAZ-1775 D8 amended), in the order its strip shows them. The web
 * app's `boards` and `docs` tabs are not here: the shell sidebar IS the boards list, and there is
 * no Docs subsystem. The tab NAMES are the engine's sidebar tab names, kept as the web app spelled
 * them so the engine's own sidebar state reads the same on both sides.
 */
export const CANVAS_PANEL_TABS = ['image-studio', 'components', 'presentation'] as const
export type CanvasPanelTab = (typeof CANVAS_PANEL_TABS)[number]
export const isCanvasPanelTab = (v: unknown): v is CanvasPanelTab => (CANVAS_PANEL_TABS as readonly string[]).includes(v as string)

/**
 * What the canvas panel remembers between mounts (🔒 YAZ-1775 D10, and the parity checklist's §5): the tab
 * the hamburger opens on, and whether the panel is docked. The web app kept both in localStorage
 * (`yaseen-whiteboard-last-sidebar-section`, `yaseen-whiteboard-sidebar-docked:<username>`); 🔒 YAZ-1775 D9
 * carries over the BEHAVIOUR and not the keys, so they live in `SettingsState` — app-global, which
 * is exactly what one browser profile's localStorage was, and every window follows a change live.
 * Whether the panel is OPEN is not remembered: it starts closed on every mount, as the web app's
 * startup `toggleSidebar({ name: null, force: false })` did.
 */
export interface CanvasPanelState {
  tab: CanvasPanelTab
  docked: boolean
}

export const DEFAULT_CANVAS_PANEL: CanvasPanelState = { tab: 'components', docked: false }
