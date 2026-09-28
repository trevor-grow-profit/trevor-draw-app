/**
 * THE IN-CANVAS DOCKED PANEL (⚡ YAZ-1775 D8 amended): the web app's `AppSidebar`
 * (`excalidraw-app/components/AppSidebar.tsx`) minus its Boards and Docs tabs. The shell sidebar
 * is this app's file manager, so the canvas panel holds only what the canvas owns — **Images**
 * (YAZ-1818), **Components** (YAZ-1819), **Present** (YAZ-1820) — each an icon with a small label, in the web app's
 * own tab strip.
 *
 * Same engine `DefaultSidebar` the web app used: its docked/pinnable panel, `hideLibrary` (the
 * upstream element library is not ported), and a hamburger in `headerStart` that closes the panel
 * — the rail's hamburger being the other way. The engine's stock `DefaultSidebar.Trigger` is
 * rendered `hidden`: the panel's doors are the rail and ⌘F / ⌘C, never a floating trigger.
 *
 * The Images tab is the Image Studio (`client/src/image-studio/`, YAZ-1818), the Components tab is the
 * saved-component library (`client/src/components-library/`, YAZ-1819 — named so it cannot be
 * mistaken for `client/src/components/`, the shell's own widgets), and the Present tab is the
 * slide list (`client/src/drawings/presentation/`, YAZ-1820).
 *
 * PLAY IS NOT THIS PANEL'S. `onStartPresentation` goes up to `ExcalidrawSurface`, which mounts the
 * player as a SIBLING of `<Excalidraw>` — a tab's body is unmounted the moment the panel closes,
 * and closing the panel must not end a presentation. The same unmount is why the Images and
 * Components tabs keep what they were doing in module-scope sessions (YAZ-1990), not in the surface.
 *
 * ENGINE-BOUND BY DESIGN: this renders the engine's own components, so it takes the LOADED module
 * as a prop rather than importing the package (`engine.ts`'s lazy rule), and it is rendered only
 * by `ExcalidrawSurface`, as a memoized child of `<Excalidraw>`.
 */
import type { ReactNode } from 'react'
import { CANVAS_PANEL_TABS, type CanvasPanelTab } from '@shared/types'
import { SavedComponents } from '../components-library/SavedComponents'
import { ImageStudio } from '../image-studio/ImageStudio'
import type { ExcalidrawImperativeApi, ExcalidrawModule } from './engine'
import { PresentationSidebar } from './presentation/PresentationSidebar'
import { componentsIcon, hamburgerIcon, imageIcon } from './launcherIcons'
import { presentationIcon } from './presentation/presentationIcons'
import './canvasPanel.css'

/** The engine sidebar name the web app used for its workspace panel. */
export const CANVAS_SIDEBAR = 'default'

/**
 * What every tab shows before the engine has handed its handle over. Said ONCE, here, because
 * this is the component that holds `excalidrawAPI` — which is also why the three tabs below take
 * a non-null one and need no "is there a canvas yet" branch of their own.
 */
export const CANVAS_LOADING = 'The canvas is still loading.'

/** The three tabs, left→right, with the web app's own labels. */
export const CANVAS_SIDEBAR_TABS: ReadonlyArray<{ tab: CanvasPanelTab; label: string; shortLabel: string; icon: ReactNode }> = [
  { tab: 'image-studio', label: 'Image Studio', shortLabel: 'Images', icon: imageIcon },
  { tab: 'components', label: 'Components', shortLabel: 'Components', icon: componentsIcon },
  { tab: 'presentation', label: 'Presentation', shortLabel: 'Present', icon: presentationIcon },
]

/** The engine's sidebar state, narrowed to the tab this app recognises (anything else = closed). */
export function openCanvasTab(openSidebar: { name?: string; tab?: string } | null | undefined): CanvasPanelTab | null {
  if (openSidebar == null || openSidebar.name !== CANVAS_SIDEBAR) return null
  const tab = openSidebar.tab
  return (CANVAS_PANEL_TABS as readonly string[]).includes(tab ?? '') ? (tab as CanvasPanelTab) : null
}

export interface CanvasSidebarProps {
  engine: ExcalidrawModule
  /** The open tab, read off `appState.openSidebar` by the surface; drives the triggers' emphasis. */
  activeTab: CanvasPanelTab | null
  /** The header hamburger: close the panel (the engine's `toggleSidebar({ name: null })`). */
  onClose: () => void
  /** The dock/pin gesture; the surface stores it in `SettingsState.canvasPanel` (🔒 YAZ-1775 D10). */
  onDock: (docked: boolean) => void
  /** The engine's imperative handle, which each tab narrows to what it uses; null until it has mounted. */
  excalidrawAPI: ExcalidrawImperativeApi | null
  /** Set by a ⌘F that opened the Images tab: it switches to Search and focuses the field (YAZ-1818, YAZ-1990). */
  searchFocusPending: boolean
  /** The Images tab has taken the focus request; the surface clears it. */
  onSearchFocused: () => void
  /** Whether the canvas holds a selection — the Components tab's "Save selection" gate (YAZ-1819). */
  hasSelection: boolean
  /** Play, from the Present tab (YAZ-1820): the SURFACE owns the player, so it outlives this panel. */
  onStartPresentation: (initialFrameId: string | null) => void
}

export function CanvasSidebar({ engine, activeTab, onClose, onDock, excalidrawAPI, searchFocusPending, onSearchFocused, hasSelection, onStartPresentation }: CanvasSidebarProps) {
  const { DefaultSidebar, Sidebar } = engine
  return (
    <>
      {/* The engine's own floating trigger is not this app's door; the rail is (🔒 YAZ-1775 D10). */}
      <DefaultSidebar.Trigger hidden />
      <DefaultSidebar
        hideLibrary
        headerStart={
          <button type="button" className="app-sidebar-panel-toggle" aria-label="Close workspace panel" title="Close workspace panel" onClick={onClose}>
            {hamburgerIcon}
          </button>
        }
        onDock={onDock}
      >
        <DefaultSidebar.TabTriggers>
          {CANVAS_SIDEBAR_TABS.map(({ tab, label, shortLabel, icon }) => (
            <Sidebar.TabTrigger key={tab} tab={tab} className="app-sidebar-tab-trigger" aria-label={label} title={label} style={{ opacity: activeTab === tab ? 1 : 0.4 }}>
              {icon}
              <span className="app-sidebar-tab-label">{shortLabel}</span>
            </Sidebar.TabTrigger>
          ))}
        </DefaultSidebar.TabTriggers>
        {CANVAS_SIDEBAR_TABS.map(({ tab }) => (
          <Sidebar.Tab key={tab} tab={tab}>
            {excalidrawAPI === null ? (
              <div className="canvas-panel__loading" role="status">
                {CANVAS_LOADING}
              </div>
            ) : tab === 'image-studio' ? (
              <ImageStudio engine={engine} excalidrawAPI={excalidrawAPI} searchFocusPending={searchFocusPending} onSearchFocused={onSearchFocused} />
            ) : tab === 'components' ? (
              <SavedComponents engine={engine} excalidrawAPI={excalidrawAPI} hasSelection={hasSelection} />
            ) : (
              <PresentationSidebar engine={engine} excalidrawAPI={excalidrawAPI} onStartPresentation={onStartPresentation} />
            )}
          </Sidebar.Tab>
        ))}
      </DefaultSidebar>
    </>
  )
}
