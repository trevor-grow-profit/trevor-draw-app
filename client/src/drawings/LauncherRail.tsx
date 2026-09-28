/**
 * THE RAIL (🔒 YAZ-1775 D10): the canvas's top-left row, where the engine's own menu trigger used
 * to be (`drawingEditor.css` hides that, the web app's rule). Three controls and nothing else:
 *
 * - the HAMBURGER, which toggles the in-canvas workspace panel (`CanvasSidebar.tsx`) — open on the
 *   last-used tab, press again to close, exactly the web app's `app-sidebar-launchers__boards-menu`
 *   gesture with the target changed. It stays visible while the panel is open, because it is the
 *   other way to close it (the panel's own header hamburger is the first);
 * - WRITING and FRAMES, two icon toggles with tooltip labels, so flipping into pen mode never
 *   costs a panel. The panel's three tabs are its own strip, so the rail launches nothing else.
 *
 * THE TOGGLES WRITE A PREFERENCE, NOT THE ENGINE (🔒 YAZ-1775 D9). Both are `SettingsState.canvas` keys:
 * the rail reports the new value up, the shell stores it, the value comes back down as a prop and
 * the surface applies it to the engine. That is the same round trip Settings › Canvas takes, which
 * is why the two can never disagree — there is one value and one path, not two.
 *
 * ⚡ IDENTITY-STABLE BY CONSTRUCTION. `renderTopLeftUI` must never change identity (the memoized
 * `<Excalidraw>`'s React #185 rule, see `ExcalidrawSurface.tsx`), so this component reads live
 * state from a tiny external STORE the surface owns and subscribes to it with
 * `useSyncExternalStore` — a re-render here never re-renders the engine. Nothing in this file
 * names the engine.
 */
import { useSyncExternalStore } from 'react'
import type { CanvasPanelTab } from '@shared/types'
import { createStore, type Store } from '../lib/store'
import { frameIcon, freedrawIcon, hamburgerIcon } from './launcherIcons'

export interface LauncherState {
  /** The engine has mounted and handed over its imperative API; until then nothing is actionable. */
  ready: boolean
  /** The canvas panel's open tab, or null while it is closed. */
  activeTab: CanvasPanelTab | null
  writingMode: boolean
  framesVisible: boolean
}

export interface LauncherActions {
  /** The hamburger: open the panel on the last-used tab, or close it when it is already open. */
  togglePanel: () => void
  /** ⌘C / ⌘F's door: open on `tab`, or close when `tab` is already the active one (the web app's rule). */
  openTab: (tab: CanvasPanelTab) => void
  toggleWriting: () => void
  toggleFrames: () => void
}

export interface LauncherStore extends LauncherActions, Store<LauncherState> {}

/** The store's state half; the surface supplies the actions, which read its refs. */
export function createLauncherStore(actions: LauncherActions, initial: LauncherState): LauncherStore {
  return { ...actions, ...createStore(initial) }
}

export function LauncherRail({ store }: { store: LauncherStore }) {
  const { ready, activeTab, writingMode, framesVisible } = useSyncExternalStore(store.subscribe, store.getState)
  const open = activeTab !== null
  return (
    <nav className="app-sidebar-launchers" aria-label="Workspace panel and canvas modes">
      <button
        type="button"
        className="app-sidebar-launcher app-sidebar-launchers__boards-menu"
        aria-label={open ? 'Close workspace panel' : 'Open workspace panel'}
        aria-pressed={open}
        title={open ? 'Close workspace panel' : 'Open workspace panel'}
        disabled={!ready}
        onClick={store.togglePanel}
      >
        {hamburgerIcon}
      </button>
      <div className="app-sidebar-launchers__modes">
        <button
          type="button"
          className="app-sidebar-launcher app-sidebar-launcher--quiet app-sidebar-launcher--icon app-sidebar-launcher--toggle"
          aria-label="Writing mode"
          aria-pressed={writingMode}
          title={writingMode ? 'Writing: on' : 'Writing: off'}
          disabled={!ready}
          onClick={store.toggleWriting}
        >
          {freedrawIcon}
        </button>
        <button
          type="button"
          className="app-sidebar-launcher app-sidebar-launcher--quiet app-sidebar-launcher--icon app-sidebar-launcher--toggle"
          aria-label="Show frames"
          aria-pressed={framesVisible}
          title={framesVisible ? 'Frames: shown' : 'Frames: hidden'}
          disabled={!ready}
          onClick={store.toggleFrames}
        >
          {frameIcon}
        </button>
      </div>
    </nav>
  )
}
