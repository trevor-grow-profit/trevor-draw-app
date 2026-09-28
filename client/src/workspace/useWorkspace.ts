import { useCallback, useRef, useState } from 'react'
import { isWithin } from '@shared/paths'
import { storage } from '../lib/storage'
import { hashFilePath } from '../lib/urlHash'

/**
 * The renderer-owned tab model (Tabs I2, GRO-2234). A window's open files are
 * `WindowEntry.tabs` with `file` doubling as the ACTIVE tab (GRO-2232); the boot identity
 * snapshot seeds this state, and from then on the renderer owns it, mirroring every change
 * down as ONE explicit complete workspace identity write — never a
 * `{ file }`-only patch, whose main-side normalization would prepend files into `tabs`
 * on its own (the legacy pre-tabs path).
 *
 * Invariants (enforced here, matching main's `WindowEntry`): `active ∈ tabs` whenever
 * non-null; `tabs: []` ⇔ `active: null`; `tabs` de-duplicated by path. `mounted` is
 * renderer-only: `mounted ⊆ tabs`, `active ∈ mounted` whenever non-null.
 */
export interface TabsState {
  /** Open tabs, absolute paths, left→right (`WindowEntry.tabs`). */
  tabs: string[]
  /** The active tab; doubles as the window's `file` (title, URL hash, sidebar highlight). */
  active: string | null
  /**
   * Tabs visited since boot, in first-activation order: exactly the editors kept mounted.
   * A background tab's editor lazy-mounts on first activation — which is also why opening
   * one never steals focus (`focusEditor` only fires when an editor mounts).
   */
  mounted: string[]
  /**
   * Per-tab back/forward stacks (YAZ-721, LOCKED ruling D1): a side table keyed by the tab's
   * CURRENT path — NOT tab identity. A tab with no record reads lazily as
   * `{ entries: [path], index: 0 }`. Renderer- and session-only: it never reaches `storage`.
   */
  history: Record<string, TabHistory>
}

/** One tab's back/forward stack (YAZ-721 D1): `entries[index]` is the file the tab shows. */
export interface TabHistory {
  entries: string[]
  index: number
}

export type TabsAction =
  | { type: 'open-current'; path: string } // sidebar click & friends: replace the active tab (activate instead when already open)
  | { type: 'open-background'; path: string } // append at the end, do NOT activate (no-op when already open)
  | { type: 'activate'; path: string } // tab-strip click
  | { type: 'close'; path: string } // ✕ / ⌘W: the active tab closes to its right neighbour, else left
  | { type: 'move'; from: number; to: number } // drag-to-reorder (I3): the tab at `from` lands at final index `to`
  | { type: 'cycle'; dir: 1 | -1 } // ⌃Tab / ⌃⇧Tab: wraparound, plain left→right order
  | { type: 'back' } // the active tab steps back through its OWN stack (YAZ-721)
  | { type: 'forward' } // …and forward again, as far as the stack was walked back
  | { type: 'reset'; tabs: string[]; active: string | null } // boot + root switch: replace wholesale, normalizing
  | { type: 'rename'; oldPath: string; newPath: string } // in-app rename (Links E1, GRO-2194): the open tab follows the file in place
  | { type: 'rename-dir'; oldPath: string; newPath: string } // in-app FOLDER rename (Links E1b, GRO-2241): every tab under the prefix follows in place
  | { type: 'delete'; path: string } // in-app delete (GRO-2272): the tab goes, the active one closing to its heir
  | { type: 'delete-dir'; path: string } // in-app FOLDER delete (GRO-2272): every tab under the folder goes

const EMPTY: TabsState = { tabs: [], active: null, mounted: [], history: {} }

function withActive(s: TabsState, active: string): TabsState {
  return { tabs: s.tabs, active, mounted: s.mounted.includes(active) ? s.mounted : [...s.mounted, active], history: s.history }
}

/**
 * Rewrite every stack through `f` — renaming a path, or dropping it with `null` (which drops
 * the whole record when its own key goes). The index follows the entry it pointed at, which
 * always survives when the key does: a record's key IS its current entry.
 */
function rekey(h: Record<string, TabHistory>, f: (p: string) => string | null): Record<string, TabHistory> {
  const out: Record<string, TabHistory> = {}
  for (const [key, r] of Object.entries(h)) {
    const k = f(key)
    if (k === null) continue
    const entries: string[] = []
    let index = 0
    r.entries.forEach((e, i) => {
      const m = f(e)
      if (m === null) return
      if (i === r.index) index = entries.length
      entries.push(m)
    })
    out[k] = { entries, index }
  }
  return out
}

/** Pure; returns the SAME state object for a no-op so callers can skip the identity mirror. */
export function tabsReducer(s: TabsState, a: TabsAction): TabsState {
  switch (a.type) {
    case 'open-current': {
      if (a.path === s.active) return s
      if (s.tabs.includes(a.path)) return withActive(s, a.path) // dedupe by path: activate, never duplicate
      if (s.active === null) return { tabs: [a.path], active: a.path, mounted: [a.path], history: s.history }
      // Replace the active tab in its slot; the old file's editor unmounts (→ autosave flush).
      // The slot's stack gains the page and re-keys onto it, any forward entries truncated.
      const h = s.history[s.active] ?? { entries: [s.active], index: 0 }
      const history = { ...s.history }
      delete history[s.active]
      return {
        tabs: s.tabs.map((t) => (t === s.active ? a.path : t)),
        active: a.path,
        mounted: [...s.mounted.filter((t) => t !== s.active), a.path],
        history: { ...history, [a.path]: { entries: [...h.entries.slice(0, h.index + 1), a.path], index: h.index + 1 } },
      }
    }
    case 'open-background': {
      if (s.tabs.includes(a.path)) return s // already open: stay where we are, steal nothing
      // The first tab of an empty window must activate: non-empty `tabs` requires a non-null `file`.
      if (s.active === null) return { tabs: [a.path], active: a.path, mounted: [a.path], history: s.history }
      return { ...s, tabs: [...s.tabs, a.path] } // not mounted: the editor lazy-mounts on first activation
    }
    case 'activate':
      return a.path === s.active || !s.tabs.includes(a.path) ? s : withActive(s, a.path)
    case 'back':
    case 'forward': {
      // The step lands in the ACTIVE tab's slot, like any same-tab navigation — but records
      // nothing: the stack is walked, not extended. A target already open in ANOTHER tab
      // activates that tab instead, leaving both stacks alone (de-dup by path wins here too).
      if (s.active === null) return s
      const h = s.history[s.active]
      if (h === undefined) return s
      const i = h.index + (a.type === 'back' ? -1 : 1)
      if (i < 0 || i >= h.entries.length) return s
      const target = h.entries[i]
      if (s.tabs.includes(target)) return withActive(s, target)
      const history = { ...s.history }
      delete history[s.active]
      return {
        tabs: s.tabs.map((t) => (t === s.active ? target : t)),
        active: target,
        mounted: [...s.mounted.filter((t) => t !== s.active), target],
        history: { ...history, [target]: { entries: h.entries, index: i } },
      }
    }
    case 'close': {
      const i = s.tabs.indexOf(a.path)
      if (i === -1) return s
      const history = { ...s.history }
      delete history[a.path] // the tab's stack closes with it
      const rest: TabsState = {
        tabs: s.tabs.filter((t) => t !== a.path),
        active: s.active,
        mounted: s.mounted.filter((t) => t !== a.path),
        history,
      }
      if (a.path !== s.active) return rest
      // ⌘W ladder (rule 7): the right neighbour takes over, else the left; closing the last
      // tab leaves the empty state — the window stays alive (App escalates to closeSelf only
      // on a ⌘W with zero tabs).
      const heir = s.tabs[i + 1] ?? s.tabs[i - 1] ?? null
      return heir === null ? { ...rest, active: null } : withActive({ ...rest, active: null }, heir)
    }
    case 'move': {
      // Reorder only: `active` and `mounted` are untouched — dragging never activates a tab.
      const to = Math.max(0, Math.min(a.to, s.tabs.length - 1))
      if (a.from < 0 || a.from >= s.tabs.length || a.from === to) return s
      const tabs = [...s.tabs]
      const [moved] = tabs.splice(a.from, 1)
      tabs.splice(to, 0, moved)
      return { ...s, tabs }
    }
    case 'cycle': {
      if (s.active === null || s.tabs.length < 2) return s
      const i = s.tabs.indexOf(s.active)
      return withActive(s, s.tabs[(i + a.dir + s.tabs.length) % s.tabs.length])
    }
    case 'reset': {
      if (a.active === null) return s.tabs.length === 0 && s.active === null && s.mounted.length === 0 ? s : EMPTY
      const tabs = [...new Set(a.tabs)]
      // An active file missing from the list is PREPENDED — main's own normalization order.
      return { tabs: tabs.includes(a.active) ? tabs : [a.active, ...tabs], active: a.active, mounted: [a.active], history: {} }
    }
    case 'rename': {
      // The tab follows its renamed file IN PLACE (Links E1): same slot, activation and the
      // mounted set remapped with it. Should the new path somehow already be open (a stale
      // tab), the old one is dropped instead — the de-dup invariant wins. Stacks follow by
      // key AND by entry: a page reached through history is the same file as the one on screen.
      if (a.oldPath === a.newPath) return s
      const remap = (t: string) => (t === a.oldPath ? a.newPath : t)
      if (!s.tabs.includes(a.oldPath)) {
        // Not open here, but some tab may still hold it further back in its stack.
        return Object.values(s.history).some((r) => r.entries.includes(a.oldPath)) ? { ...s, history: rekey(s.history, remap) } : s
      }
      const hasNew = s.tabs.includes(a.newPath)
      const tabs = hasNew ? s.tabs.filter((t) => t !== a.oldPath) : s.tabs.map(remap)
      const mounted = [...new Set(hasNew ? s.mounted.filter((t) => t !== a.oldPath) : s.mounted.map(remap))]
      const active = s.active === a.oldPath ? a.newPath : s.active
      const kept = { ...s.history }
      if (hasNew) delete kept[a.oldPath]
      return {
        tabs,
        active,
        mounted: active !== null && !mounted.includes(active) && tabs.includes(active) ? [...mounted, active] : mounted,
        history: rekey(kept, remap),
      }
    }
    case 'delete': {
      // Deleting a tab IS closing it, from the user's point of view — so reuse the `close`
      // case rather than re-implementing the heir ladder. Divergence between the two would
      // show up as "deleting the active drawing picks a different tab than ⌘W does", which is
      // the kind of inconsistency nobody reports but everybody feels. The tab also leaves
      // every OTHER tab's stack first: back must never step onto a file that is gone.
      const base = Object.values(s.history).some((r) => r.entries.includes(a.path))
        ? { ...s, history: rekey(s.history, (p) => (p === a.path ? null : p)) }
        : s
      return tabsReducer(base, { type: 'close', path: a.path })
    }
    case 'delete-dir': {
      // Every tab under the folder closes, left to right, each through the SAME ladder. The
      // fold means the heir is whatever survives after all of them are gone; the old prefix
      // itself can never be a tab (tabs are files, not dirs).
      const prefix = `${a.path}/`
      const under = (t: string) => t.startsWith(prefix)
      const base = Object.values(s.history).some((r) => r.entries.some(under)) ? { ...s, history: rekey(s.history, (p) => (under(p) ? null : p)) } : s
      const doomed = s.tabs.filter(under)
      if (doomed.length === 0) return base
      return doomed.reduce((acc, path) => tabsReducer(acc, { type: 'close', path }), base)
    }
    case 'rename-dir': {
      // A FOLDER moved (E1b): every tab under `oldPath/` follows by prefix, each in its own
      // slot; activation and the mounted set remap with them. A remapped tab landing on a
      // path that was ALREADY open is dropped — the de-dup invariant wins (same rule as
      // `rename`); the old prefix itself can never be a tab (tabs are files, not dirs).
      if (a.oldPath === a.newPath) return s
      const under = (t: string) => isWithin(a.oldPath, t, true)
      const remap = (t: string) => (under(t) ? a.newPath + t.slice(a.oldPath.length) : t)
      if (!s.tabs.some(under)) {
        // Nothing open under the folder, but a stack further back may still point inside it.
        return Object.values(s.history).some((r) => r.entries.some(under)) ? { ...s, history: rekey(s.history, remap) } : s
      }
      const existing = new Set(s.tabs)
      const tabs: string[] = []
      for (const t of s.tabs) {
        const m = remap(t)
        if (m !== t && (existing.has(m) || tabs.includes(m))) continue
        tabs.push(m)
      }
      const mounted = [...new Set(s.mounted.map(remap))].filter((t) => tabs.includes(t))
      const active = s.active === null ? null : remap(s.active)
      return {
        tabs,
        active,
        mounted: active !== null && !mounted.includes(active) && tabs.includes(active) ? [...mounted, active] : mounted,
        history: rekey(s.history, remap),
      }
    }
  }
}

/**
 * The boot state (rule 15): `storage`'s identity is valid AT BOOT only (`storage.init()`
 * resolves before the first render). Active-file precedence (GRO-2069/2160): a pasted
 * `#/abs/path` hash wins, then this window's restored file, then the folder's remembered
 * lastFile; a hash file missing from the stored tabs is added (rule 12). Only the active
 * tab's editor mounts.
 */
export function bootTabs(root: string | null): TabsState {
  if (root === null) return EMPTY
  const active = hashFilePath(location.hash) ?? storage.getFile() ?? storage.getLastFile(root)
  return tabsReducer(EMPTY, { type: 'reset', tabs: storage.getTabs(), active })
}

export interface UseWorkspace extends TabsState {
  /** Rule 11: replace the active tab — sidebar single-click, search, inline-create, deep links. */
  openCurrent: (path: string) => void
  /** Rule 5: append at the end without activating (and so without stealing focus) — I3's ⌘-click. */
  openBackground: (path: string) => void
  activate: (path: string) => void
  close: (path: string) => void
  /** Drag-to-reorder (I3): the tab at `from` lands at final index `to`; activation untouched. */
  move: (from: number, to: number) => void
  /** ⌘W: closes the active tab; false when there is none (App escalates to `closeSelf`). */
  closeActive: () => boolean
  next: () => void
  prev: () => void
  /** YAZ-721 D1: step the ACTIVE tab through its own stack; no-ops at either bound. */
  back: () => void
  forward: () => void
  /** Whether that step exists — the toolbar arrows' enabled state. */
  canBack: boolean
  canForward: boolean
  /** The root switched to `nextRoot` (rule 13): replace the list with the restored file, or nothing. */
  reset: (nextRoot: string | null, file: string | null) => void
  /** An in-app rename landed (`file:renamed`, Links E1): remap the open tab in place; no-op when absent. */
  renamePath: (oldPath: string, newPath: string) => void
  /**
   * A FOLDER rename landed (`file:renamed` kind `dir`, Links E1b — GRO-2241): remap every
   * tab under the old prefix in place. `nextRoot` overrides the mirror's root when THIS
   * window's own root moved with the folder (a subfolder opened as a vault) — the mirror's
   * lastFile write then lands under the repaired root, not a stale entry.
   */
  renameDirPath: (oldPath: string, newPath: string, nextRoot?: string) => void
  /** A delete landed (`file:deleted`, GRO-2272): drop the tab; the active one closes to its heir. */
  deletePath: (path: string) => void
  /** A FOLDER delete landed (`file:deleted` kind `dir`): drop every tab under the prefix. */
  deleteDirPath: (path: string) => void
}

export function useWorkspace(root: string | null): UseWorkspace {
  const [state, setState] = useState<TabsState>(() => bootTabs(root))
  // Dispatch reads/writes the ref so consecutive dispatches in one event see each other; the
  // mirror side effect stays OUT of the setState updater (StrictMode double-invokes updaters).
  const stateRef = useRef(state)
  const rootRef = useRef(root)
  rootRef.current = root

  const dispatch = useCallback((action: TabsAction, opts?: { root?: string | null; mirror?: boolean }): void => {
    const prevState = stateRef.current
    const nextState = tabsReducer(prevState, action)
    if (nextState === prevState) return
    stateRef.current = nextState
    setState(nextState)
    // ONE explicit write per durable change carries the tab list and the active file.
    if (opts?.mirror !== false) storage.setWorkspace(opts?.root !== undefined ? opts.root : rootRef.current, nextState.tabs, nextState.active)
  }, [])

  const openCurrent = useCallback((path: string) => dispatch({ type: 'open-current', path }), [dispatch])
  const openBackground = useCallback((path: string) => dispatch({ type: 'open-background', path }), [dispatch])
  const activate = useCallback((path: string) => dispatch({ type: 'activate', path }), [dispatch])
  const close = useCallback((path: string) => dispatch({ type: 'close', path }), [dispatch])
  const move = useCallback((from: number, to: number) => dispatch({ type: 'move', from, to }), [dispatch])
  const closeActive = useCallback((): boolean => {
    const active = stateRef.current.active
    if (active === null) return false
    dispatch({ type: 'close', path: active })
    return true
  }, [dispatch])
  const next = useCallback(() => dispatch({ type: 'cycle', dir: 1 }), [dispatch])
  const prev = useCallback(() => dispatch({ type: 'cycle', dir: -1 }), [dispatch])
  const back = useCallback(() => dispatch({ type: 'back' }), [dispatch])
  const forward = useCallback(() => dispatch({ type: 'forward' }), [dispatch])
  const reset = useCallback(
    (nextRoot: string | null, file: string | null) =>
      // An empty reset mirrors nothing: `storage.setRoot` already wrote {root, file: null,
      // tabs: []} in ONE identity patch (rule 13). A restored file is one {tabs, file} write
      // against the NEW root (App's root state has not re-rendered yet, hence explicit).
      dispatch({ type: 'reset', tabs: [], active: file }, { root: nextRoot, mirror: file !== null }),
    [dispatch],
  )
  const renamePath = useCallback((oldPath: string, newPath: string) => dispatch({ type: 'rename', oldPath, newPath }), [dispatch])
  const renameDirPath = useCallback(
    (oldPath: string, newPath: string, nextRoot?: string) =>
      dispatch({ type: 'rename-dir', oldPath, newPath }, nextRoot !== undefined ? { root: nextRoot } : undefined),
    [dispatch],
  )

  const deletePath = useCallback((path: string) => dispatch({ type: 'delete', path }), [dispatch])
  const deleteDirPath = useCallback((path: string) => dispatch({ type: 'delete-dir', path }), [dispatch])

  const h: TabHistory | undefined = state.history[state.active ?? '']
  return {
    ...state,
    openCurrent, openBackground, activate, close, move, closeActive, next, prev, back, forward, reset, renamePath, renameDirPath, deletePath, deleteDirPath,
    canBack: h !== undefined && h.index > 0,
    canForward: h !== undefined && h.index < h.entries.length - 1,
  }
}
