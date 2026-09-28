/**
 * THE BOARD'S OWN appState (YAZ-2073 2E). A snapshot's version is `getSceneVersion`, a sum over
 * ELEMENTS, so an edit the engine keeps in appState — View › Canvas Background — never read as a
 * change, and was never saved. What counts now is every field the engine's own serializer writes
 * (`serializeAsJSON(…, 'local')`, read off it rather than listed here, so the two cannot drift),
 * minus the user-level canvas prefs (🔒 YAZ-1775 D9): those belong to the app, are pushed into
 * every open board at once, and a grid toggle must not rewrite every tab. The set is whatever
 * `prefsToAppState` emits, so a pref added there (the laser's three, 🔒 YAZ-1989 D1) is dropped here
 * with no second list. Pan and zoom are never written, so they never count.
 *
 * The engine arrives as an argument (a type-only import), so this file never pulls the package in.
 */
import { prefsToAppState } from '@shared/canvasPrefs'
import { DEFAULT_CANVAS_PREFS } from '@shared/types'
import type { ExcalidrawModule } from './engine'

const PREF_KEYS = new Set(Object.keys(prefsToAppState(DEFAULT_CANVAS_PREFS)))

/** The appState keys a board carries: what the engine's serializer writes of a default appState, less the prefs. */
export function boardAppStateKeys(engine: ExcalidrawModule): string[] {
  const written = (JSON.parse(engine.serializeAsJSON([], engine.restoreAppState(null, null), {}, 'local')) as { appState: Record<string, unknown> }).appState
  return Object.keys(written).filter((k) => !PREF_KEYS.has(k))
}

/**
 * A counter of changes to `keys`, fed the engine's appState on every `onChange`: the first one it
 * sees is the reference (the engine only reports once the scene is loaded), and every move after
 * adds one. It only ever grows, so version + edits never returns to a baseline it has left — a
 * background set back to white is one redundant save, never a lost one.
 */
export function appStateEdits(keys: readonly string[]): (appState: Readonly<Record<string, unknown>>) => number {
  let last: string | null = null
  let edits = 0
  return (appState) => {
    const seen = JSON.stringify(keys.map((k) => appState[k]))
    if (last !== null && seen !== last) edits += 1
    last = seen
    return edits
  }
}
