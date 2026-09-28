/**
 * Editor continuity across an in-app rename (Links E1, GRO-2194) and an in-app DELETE
 * (GRO-2272). Editors are keyed by path, so remapping or removing a tab remounts or unmounts
 * its editor — and that unmount would flush the live scene back to the OLD path, resurrecting
 * the file the rename or delete just removed.
 *
 * Two rules, in this order:
 *  - the originating window awaits `flushRenamedPath` / `flushRenamedDir` BEFORE `fs:rename`,
 *    so what is on screen is on disk and travels with the file;
 *  - every window's `file:renamed` / `file:deleted` handler RETIRES the old handle before
 *    remapping its tabs — a retired editor never writes again, so the unmount flush is a no-op.
 *
 * Residual race, accepted: a save already in flight over IPC when the rename lands cannot be
 * recalled. The map is module-scoped, i.e. per renderer, so ANOTHER window's pending debounced
 * save for the same path is not retired either — the same race widened to a debounce interval.
 * Fixing it needs a main-side broadcast the rename path does not have today.
 */

import { isWithin } from '@shared/paths'

/** What a mounted editor exposes to the rename/delete flows (registered by `DrawingEditor`). */
export interface RenameContinuityHandle {
  /** Push the live scene through autosave and resolve once it is on disk (or blocked). */
  flush(): Promise<void>
  /** Stop this editor writing ever again (pending drops, unmount flush becomes a no-op). */
  retire(): void
  /** Whether the tab holds edits not yet on disk (YAZ-1801: shrink must not rewrite under them). */
  dirty(): boolean
}

const handles = new Map<string, RenameContinuityHandle>()

/** One handle per open path per window (tabs de-duplicate); returns the unregister. */
export function registerRenameContinuity(path: string, handle: RenameContinuityHandle): () => void {
  handles.set(path, handle)
  return () => {
    if (handles.get(path) === handle) handles.delete(path)
  }
}

/** Flush the editor open at `path`, if any — the pre-rename step. */
export function flushRenamedPath(path: string): Promise<void> {
  return handles.get(path)?.flush() ?? Promise.resolve()
}

/**
 * The pre-rename step for a FOLDER (E1b, GRO-2241): every mounted editor UNDER `dir` flushes,
 * so each scene is on disk and travels with its file. No editors there → no-op.
 */
export function flushRenamedDir(dir: string): Promise<void> {
  return Promise.all([...handles].filter(([path]) => isWithin(dir, path, true)).map(([, handle]) => handle.flush())).then(() => undefined)
}

/** The `file:renamed` / `file:deleted` step, run BEFORE the workspace remap unmounts the editor. */
export function retirePath(path: string): void {
  handles.get(path)?.retire()
}

/** The kind-`dir` twin: every editor under `dir` retires. */
export function retireDir(dir: string): void {
  for (const [path, handle] of handles) if (isWithin(dir, path, true)) handle.retire()
}

/**
 * Every open path in THIS window whose editor has unsaved edits (YAZ-1801 D5) — the `skip` list
 * "Move pictures out of boards" hands main, so it never rewrites a board under a dirty buffer
 * (that is the conflict bar's case, and the user would see it for an action they took in
 * Settings). Per renderer, like the map: another WINDOW's dirty tab is not in it — the shrink's
 * own mtime re-check narrows that race to the instant of the write.
 */
export function dirtyPaths(): string[] {
  return [...handles].filter(([, handle]) => handle.dirty()).map(([path]) => path)
}

/** Test hook. */
export function _resetRenameContinuity(): void {
  handles.clear()
}
