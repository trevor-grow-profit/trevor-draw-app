/** The bridge's own shapes; the doors themselves are `CONTRACT` in `shared/ipc.ts`. */

import type { SidebarLens } from './appState'
import type { BridgeErrorCode } from './errors'

/**
 * Every bridge promise rejects with a plain object satisfying `BridgeError` (the preload
 * unwraps the IPC envelope; `client/src/api.ts` wraps it in `BridgeRequestError`).
 * `CONFLICT` carries the current on-disk `mtime`.
 */
export interface BridgeError {
  code: BridgeErrorCode | 'CONFLICT'
  message: string
  path?: string
  mtime?: number
}

/** Reveal in Finder (GRO-2274): the absolute path to show in the OS file manager. */
export interface RevealRequest {
  path: string
}

/** Reveal in Finder (GRO-2274): echoes the revealed path. */
export interface RevealResponse {
  path: string
}

/** In-app delete (GRO-2272): the absolute path of the entry to move to the system Trash. */
export interface DeleteRequest {
  path: string
}

/** In-app delete (GRO-2272): what moved to the system Trash. */
export interface DeleteResponse {
  path: string
  kind: 'file' | 'dir'
}

/** `file:deleted` — pushed to EVERY window after a successful delete (GRO-2272). */
export interface FileDeletedEvent {
  path: string
  kind: 'file' | 'dir'
}

export interface WindowIdentity {
  id: string
  root: string | null
  file: string | null
  /** Open tabs left→right (GRO-2232); `file` is the active one (same invariants as `WindowEntry.tabs`). */
  tabs: string[]
  /** Whether this window's sidebar is hidden (YAZ-1280). */
  sidebarCollapsed: boolean
  /** Which sidebar lens this window shows (YAZ-847, per window since YAZ-1628). */
  sidebarLens: SidebarLens
  /** Focus Mode's lists (YAZ-1605, per window since YAZ-1628; Favorites' own since YAZ-1766): the same three as `WindowEntry`'s. */
  focusDirs: string[]
  focusFavorites: string[]
}

export interface OpenWindowOptions {
  root: string | null
  file: string | null
}

