/**
 * THE CANVAS PREFS ↔ ENGINE appState MAPPING (🔒 YAZ-1775 D9).
 *
 * `SettingsState.canvas` holds the engine's `browser: true, export: false` appState — grid,
 * snapping, binding, selection mode, tool lock, zen, writing mode, the two pen widths, the three
 * "new element is born with" defaults, the laser's trail / colour / size (🔒 YAZ-1989 D1) — plus
 * frame visibility. The engine package persists none of it (the web app used browser
 * localStorage), so the shell's one state file does, and this module is the PURE translation between the two vocabularies, in both directions, plus the
 * equality the anti-ping-pong rule needs.
 *
 * NO ENGINE IMPORT. The appState slice is a structural type, so `canvasPrefs.test.ts` pins every
 * key without pulling in `@excalidraw/excalidraw` (and without breaking the lazy-load rule in
 * `client/src/drawings/engine.ts`). The types and the defaults themselves live in `shared/types.ts`
 * — this file is the behaviour.
 *
 * TWO KEYS ARE NOT PLAIN appState:
 * - `toolLock` lives inside `activeTool`, and a partial `activeTool` handed to `updateScene` would
 *   wipe the tool the user is holding. `prefsToAppState` emits the DEFAULT tool shape with the
 *   lock set, which is right at MOUNT and wrong for a live update — the surface merges with the
 *   current tool instead, which is the only place that can read it.
 * - `framesVisible` is never appState at all: it is applied through the engine's
 *   `updateFrameRendering` (`client/src/drawings/framesVisibility.ts`, the web app's rule), so
 *   `prefsToAppState` deliberately emits nothing for it.
 *
 * TWO GUARDS, ON PURPOSE (🔒 YAZ-1775 D9): `isCanvasPrefs` is STRICT — every field present and valid — and
 * is what the IPC boundary demands of a sandboxed renderer. `sanitizeCanvasPrefs` is LENIENT,
 * field by field over the defaults, and is what the state FILE gets: a store written before a key
 * existed must still load, keeping every key it does have.
 */

import { isRecord } from './guards'
import { DEFAULT_CANVAS_PREFS, LASER_COLORS, LASER_SIZES, LASER_TRAIL_MODES, ROUGHNESS_LEVELS, SELECT_ON_MODES, TEXT_ALIGNS, type CanvasPrefs, type LaserColor, type LaserSize, type LaserTrailMode, type Roughness, type SelectOn, type TextAlign } from './types'

/** Every pref key, in declaration order — the order `changedPrefKeys` reports in. */
export const CANVAS_PREF_KEYS = Object.keys(DEFAULT_CANVAS_PREFS) as ReadonlyArray<keyof CanvasPrefs>

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
/** A stroke width is a positive number the engine could actually draw with; 0 and NaN are not widths. */
const isWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100

const FIELD_OK: { [K in keyof CanvasPrefs]: (v: unknown) => v is CanvasPrefs[K] } = {
  gridModeEnabled: isBool,
  objectsSnapModeEnabled: isBool,
  snapToMidpoints: isBool,
  arrowBinding: isBool,
  selectOn: (v): v is SelectOn => typeof v === 'string' && (SELECT_ON_MODES as readonly string[]).includes(v),
  toolLock: isBool,
  zenModeEnabled: isBool,
  writingMode: isBool,
  writingStrokeWidth: isWidth,
  vectorStrokeWidth: isWidth,
  framesVisible: isBool,
  defaultFontFamily: (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
  // The web app's roughness sanitation (`data/localStorage.ts`: delete unless exactly 0|1|2),
  // ported as validation rather than as a migration — nothing here ever wrote a bad one.
  defaultRoughness: (v): v is Roughness => typeof v === 'number' && (ROUGHNESS_LEVELS as readonly number[]).includes(v),
  defaultTextAlign: (v): v is TextAlign => typeof v === 'string' && (TEXT_ALIGNS as readonly string[]).includes(v),
  // 🔒 YAZ-1989 D1: the laser toolbar's own vocabularies, exact spellings only — a colour outside
  // the five swatches (or `#FF0000`) is not one the toolbar could have written.
  laserTrailMode: (v): v is LaserTrailMode => typeof v === 'string' && (LASER_TRAIL_MODES as readonly string[]).includes(v),
  laserColor: (v): v is LaserColor => typeof v === 'string' && (LASER_COLORS as readonly string[]).includes(v),
  laserSize: (v): v is LaserSize => typeof v === 'string' && (LASER_SIZES as readonly string[]).includes(v),
}

/** Strict: every field present and valid — the IPC boundary's check. */
export function isCanvasPrefs(v: unknown): v is CanvasPrefs {
  return isRecord(v) && CANVAS_PREF_KEYS.every((k) => FIELD_OK[k](v[k]))
}

/** Lenient: field by field over the defaults, so a state file from before a key existed still loads. */
export function sanitizeCanvasPrefs(raw: unknown): CanvasPrefs {
  const src = isRecord(raw) ? raw : {}
  const out = { ...DEFAULT_CANVAS_PREFS }
  for (const k of CANVAS_PREF_KEYS) {
    const v = src[k]
    if (FIELD_OK[k](v)) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** The slice of the engine's appState these prefs live in — structural, so no engine import. */
export interface EngineAppStateSlice {
  gridModeEnabled?: boolean
  objectsSnapModeEnabled?: boolean
  isMidpointSnappingEnabled?: boolean
  isBindingEnabled?: boolean
  boxSelectionMode?: 'contain' | 'overlap'
  activeTool?: { locked?: boolean } | null
  zenModeEnabled?: boolean
  writingMode?: boolean
  currentItemWritingStrokeWidth?: number
  currentItemVectorStrokeWidth?: number
  frameRendering?: { outline?: boolean; name?: boolean } | null
  currentItemFontFamily?: number
  currentItemRoughness?: number
  currentItemTextAlign?: string
  laserTrailMode?: string
  laserColor?: string
  laserSize?: string
}

/** The engine's own default `activeTool`, for MOUNT only (see the module doc). */
const DEFAULT_ACTIVE_TOOL = { type: 'selection', customType: null, fromSelection: false, lastActiveTool: null } as const

/**
 * Prefs → the engine's appState keys, for `keys` (all of them by default). `framesVisible` emits
 * nothing; `toolLock` emits the DEFAULT tool with the lock set, which is right at mount only.
 */
export function prefsToAppState(prefs: CanvasPrefs, keys: ReadonlyArray<keyof CanvasPrefs> = CANVAS_PREF_KEYS): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    switch (k) {
      case 'gridModeEnabled':
        out.gridModeEnabled = prefs.gridModeEnabled
        break
      case 'objectsSnapModeEnabled':
        out.objectsSnapModeEnabled = prefs.objectsSnapModeEnabled
        break
      case 'snapToMidpoints':
        out.isMidpointSnappingEnabled = prefs.snapToMidpoints
        break
      case 'arrowBinding':
        out.isBindingEnabled = prefs.arrowBinding
        break
      case 'selectOn':
        out.boxSelectionMode = prefs.selectOn === 'wrap' ? 'contain' : 'overlap'
        break
      case 'toolLock':
        out.activeTool = { ...DEFAULT_ACTIVE_TOOL, locked: prefs.toolLock }
        break
      case 'zenModeEnabled':
        out.zenModeEnabled = prefs.zenModeEnabled
        break
      case 'writingMode':
        out.writingMode = prefs.writingMode
        break
      case 'writingStrokeWidth':
        out.currentItemWritingStrokeWidth = prefs.writingStrokeWidth
        break
      case 'vectorStrokeWidth':
        out.currentItemVectorStrokeWidth = prefs.vectorStrokeWidth
        break
      case 'framesVisible':
        break // `updateFrameRendering`'s, never appState (see the module doc)
      case 'defaultFontFamily':
        out.currentItemFontFamily = prefs.defaultFontFamily
        break
      case 'defaultRoughness':
        out.currentItemRoughness = prefs.defaultRoughness
        break
      case 'defaultTextAlign':
        out.currentItemTextAlign = prefs.defaultTextAlign
        break
      // 🔒 YAZ-1989 D1: the same key names on both sides, so these three are straight copies.
      case 'laserTrailMode':
      case 'laserColor':
      case 'laserSize':
        out[k] = prefs[k]
        break
    }
  }
  return out
}

/**
 * The engine's appState → prefs: each key read when the engine HAS it, and taken from `fallback`
 * when it does not — so a slice that is missing a field never overwrites a stored value with a
 * default. `fallback` is the caller's "what the engine held last time", which is exactly what the
 * diff-before-write rule needs.
 */
export function appStateToPrefs(appState: EngineAppStateSlice, fallback: CanvasPrefs): CanvasPrefs {
  const frames = appState.frameRendering
  return {
    gridModeEnabled: isBool(appState.gridModeEnabled) ? appState.gridModeEnabled : fallback.gridModeEnabled,
    objectsSnapModeEnabled: isBool(appState.objectsSnapModeEnabled) ? appState.objectsSnapModeEnabled : fallback.objectsSnapModeEnabled,
    snapToMidpoints: isBool(appState.isMidpointSnappingEnabled) ? appState.isMidpointSnappingEnabled : fallback.snapToMidpoints,
    arrowBinding: isBool(appState.isBindingEnabled) ? appState.isBindingEnabled : fallback.arrowBinding,
    selectOn: appState.boxSelectionMode === 'contain' ? 'wrap' : appState.boxSelectionMode === 'overlap' ? 'overlap' : fallback.selectOn,
    toolLock: isBool(appState.activeTool?.locked) ? appState.activeTool.locked : fallback.toolLock,
    zenModeEnabled: isBool(appState.zenModeEnabled) ? appState.zenModeEnabled : fallback.zenModeEnabled,
    writingMode: isBool(appState.writingMode) ? appState.writingMode : fallback.writingMode,
    writingStrokeWidth: isWidth(appState.currentItemWritingStrokeWidth) ? appState.currentItemWritingStrokeWidth : fallback.writingStrokeWidth,
    vectorStrokeWidth: isWidth(appState.currentItemVectorStrokeWidth) ? appState.currentItemVectorStrokeWidth : fallback.vectorStrokeWidth,
    // Both halves or neither: a half-applied `frameRendering` is the engine mid-update, not a preference.
    framesVisible: frames != null && isBool(frames.outline) && isBool(frames.name) ? frames.outline && frames.name : fallback.framesVisible,
    defaultFontFamily: FIELD_OK.defaultFontFamily(appState.currentItemFontFamily) ? appState.currentItemFontFamily : fallback.defaultFontFamily,
    defaultRoughness: FIELD_OK.defaultRoughness(appState.currentItemRoughness) ? appState.currentItemRoughness : fallback.defaultRoughness,
    defaultTextAlign: FIELD_OK.defaultTextAlign(appState.currentItemTextAlign) ? appState.currentItemTextAlign : fallback.defaultTextAlign,
    // An engine built before 🔒 YAZ-1989 D1 has none of the three, and so keeps the stored ones.
    laserTrailMode: FIELD_OK.laserTrailMode(appState.laserTrailMode) ? appState.laserTrailMode : fallback.laserTrailMode,
    laserColor: FIELD_OK.laserColor(appState.laserColor) ? appState.laserColor : fallback.laserColor,
    laserSize: FIELD_OK.laserSize(appState.laserSize) ? appState.laserSize : fallback.laserSize,
  }
}

/** Value equality over every pref key — the "compare before writing" half of the rule. */
export function prefsEqual(a: CanvasPrefs, b: CanvasPrefs): boolean {
  return CANVAS_PREF_KEYS.every((k) => a[k] === b[k])
}

/** The keys whose value differs, in `CANVAS_PREF_KEYS` order — what a live update has to push. */
export function changedPrefKeys(prev: CanvasPrefs, next: CanvasPrefs): Array<keyof CanvasPrefs> {
  return CANVAS_PREF_KEYS.filter((k) => prev[k] !== next[k])
}
