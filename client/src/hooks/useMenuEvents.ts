import { useEffect } from 'react'
import { api } from '../api'

interface UseMenuEventsOptions {
  /** File › Open Folder… (⌘⇧O) targeted this window: run the pick-folder flow. */
  onOpenFolder: () => void
  /** File › Open Recent chose `path` for this window: switch the root in place. */
  onOpenRoot: (path: string) => void
  /** File › Search Vault (⌘K): focus the sidebar's search bar, un-collapsing the sidebar first (YAZ-804). */
  onSearch: () => void
  /** File › Switch Vault… (⌘O): open the sidebar header's vault switcher, un-collapsing the sidebar first (YAZ-1767 D8). */
  onSwitchVault: () => void
  /** Trevor Draw › Settings… (⌘,): open the settings dialog (YAZ-1679). */
  onSettings: () => void
  /** View › Toggle Sidebar: toggle only this renderer's window identity (YAZ-1280). */
  onToggleSidebar: () => void
  /** File › Close Tab (⌘W): close the active tab — or the window when none are open (GRO-2234). */
  onCloseTab: () => void
  /** Window › Next Tab (⌃Tab / ⌘⇧]): activate the tab to the right, wrapping (GRO-2234). */
  onNextTab: () => void
  /** Window › Previous Tab (⌃⇧Tab / ⌘⇧[): activate the tab to the left, wrapping (GRO-2234). */
  onPrevTab: () => void
  /** File › Export Image… (⌘⇧E, 🔒 YAZ-1775 D10): the visible drawing opens the engine's export dialog; a diagram saves a PNG or SVG (🔒 YAZ-1802 D9). */
  onExportImage: () => void
  /** View › Canvas Background › a pick (🔒 YAZ-1775 D10): the visible drawing takes `color`. */
  onCanvasBackground: (color: string) => void
  /** File › Export Drawing… (⌘⇧S, 🔒 YAZ-1775 D3): the visible drawing writes a standalone `.excalidraw`. */
  onExportDrawing: () => void
  /** File › Share Link (⌘⇧L, YAZ-1799): open the Share dialog for the visible board — a diagram too (🔒 YAZ-1802 D11). */
  onShareLink: () => void
}

/** Menu gestures from the main process (GRO-2161, tabs GRO-2232); main sends them to the focused window only. */
export function useMenuEvents({ onOpenFolder, onOpenRoot, onSearch, onSwitchVault, onSettings, onToggleSidebar, onCloseTab, onNextTab, onPrevTab, onExportImage, onCanvasBackground, onExportDrawing, onShareLink }: UseMenuEventsOptions): void {
  useEffect(() => {
    const menu = api.menu
    const offs = [
      menu.onOpenFolder(onOpenFolder),
      menu.onOpenRoot(onOpenRoot),
      menu.onSearch(onSearch),
      menu.onSwitchVault(onSwitchVault),
      menu.onSettings(onSettings),
      menu.onToggleSidebar(onToggleSidebar),
      menu.onCloseTab(onCloseTab),
      menu.onNextTab(onNextTab),
      menu.onPrevTab(onPrevTab),
      menu.onExportImage(onExportImage),
      menu.onCanvasBackground(onCanvasBackground),
      menu.onExportDrawing(onExportDrawing),
      menu.onShareLink(() => onShareLink()),
    ]
    return () => offs.forEach((off) => off())
  }, [onOpenFolder, onOpenRoot, onSearch, onSwitchVault, onSettings, onToggleSidebar, onCloseTab, onNextTab, onPrevTab, onExportImage, onCanvasBackground, onExportDrawing, onShareLink])
}
