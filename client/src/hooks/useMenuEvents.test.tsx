/**
 * useMenuEvents (GRO-2161, tabs GRO-2232): the renderer's half of the File › Open Folder… /
 * Open Recent / Search Vault / Close Tab, Trevor Draw › Settings… (YAZ-1679) and Window › Next/Previous Tab menu gestures — subscribed on
 * mount, unsubscribed on unmount, latest callbacks win.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useMenuEvents } from './useMenuEvents'


function installBridge() {
  const openFolderListeners = new Set<() => void>()
  const openRootListeners = new Set<(path: string) => void>()
  const searchListeners = new Set<() => void>()
  const switchVaultListeners = new Set<() => void>()
  const settingsListeners = new Set<() => void>()
  const toggleSidebarListeners = new Set<() => void>()
  const closeTabListeners = new Set<() => void>()
  const nextTabListeners = new Set<() => void>()
  const prevTabListeners = new Set<() => void>()
  const exportImageListeners = new Set<() => void>()
  const canvasBackgroundListeners = new Set<(color: string) => void>()
  const exportDrawingListeners = new Set<() => void>()
  const shareLinkListeners = new Set<() => void>()
  const sub = <T,>(set: Set<T>) =>
    vi.fn((l: T) => {
      set.add(l)
      return () => set.delete(l)
    })
  const bridge = {
    menu: {
      onOpenFolder: sub(openFolderListeners),
      onOpenRoot: sub(openRootListeners),
      onSearch: sub(searchListeners),
      onSwitchVault: sub(switchVaultListeners),
      onSettings: sub(settingsListeners),
      onToggleSidebar: sub(toggleSidebarListeners),
      onCloseTab: sub(closeTabListeners),
      onNextTab: sub(nextTabListeners),
      onPrevTab: sub(prevTabListeners),
      onExportImage: sub(exportImageListeners),
      onCanvasBackground: sub(canvasBackgroundListeners),
      onExportDrawing: sub(exportDrawingListeners),
      onShareLink: sub(shareLinkListeners),
    },
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return {
    emitOpenFolder: () => openFolderListeners.forEach((l) => l()),
    emitOpenRoot: (path: string) => openRootListeners.forEach((l) => l(path)),
    emitSearch: () => searchListeners.forEach((l) => l()),
    emitSwitchVault: () => switchVaultListeners.forEach((l) => l()),
    emitSettings: () => settingsListeners.forEach((l) => l()),
    emitToggleSidebar: () => toggleSidebarListeners.forEach((l) => l()),
    emitCloseTab: () => closeTabListeners.forEach((l) => l()),
    emitNextTab: () => nextTabListeners.forEach((l) => l()),
    emitPrevTab: () => prevTabListeners.forEach((l) => l()),
    emitExportImage: () => exportImageListeners.forEach((l) => l()),
    emitCanvasBackground: (color: string) => canvasBackgroundListeners.forEach((l) => l(color)),
    emitExportDrawing: () => exportDrawingListeners.forEach((l) => l()),
    emitShareLink: () => shareLinkListeners.forEach((l) => l()),
    count: () => openFolderListeners.size + openRootListeners.size + searchListeners.size + switchVaultListeners.size + settingsListeners.size + toggleSidebarListeners.size + closeTabListeners.size + nextTabListeners.size + prevTabListeners.size + exportImageListeners.size + canvasBackgroundListeners.size + exportDrawingListeners.size + shareLinkListeners.size,
  }
}

interface ProbeProps {
  onOpenFolder: () => void
  onOpenRoot: (path: string) => void
  onSearch: () => void
  onSwitchVault: () => void
  onSettings: () => void
  onToggleSidebar: () => void
  onCloseTab: () => void
  onNextTab: () => void
  onPrevTab: () => void
  onExportImage: () => void
  onCanvasBackground: (color: string) => void
  onExportDrawing: () => void
  onShareLink: () => void
}

function Probe(props: ProbeProps) {
  useMenuEvents(props)
  return null
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  delete (window as unknown as Record<string, unknown>).yaseenDraw
})

describe('useMenuEvents', () => {
  it('routes menu gestures to the callbacks and unsubscribes on unmount', () => {
    const b = installBridge()
    const handlers = { onOpenFolder: vi.fn(), onOpenRoot: vi.fn(), onSearch: vi.fn(), onSwitchVault: vi.fn(), onSettings: vi.fn(), onToggleSidebar: vi.fn(), onCloseTab: vi.fn(), onNextTab: vi.fn(), onPrevTab: vi.fn(), onExportImage: vi.fn(), onCanvasBackground: vi.fn(), onExportDrawing: vi.fn(), onShareLink: vi.fn() }
    root = createRoot(document.createElement('div'))
    act(() => root?.render(<Probe {...handlers} />))

    act(() => b.emitOpenFolder())
    expect(handlers.onOpenFolder).toHaveBeenCalledTimes(1)
    act(() => b.emitOpenRoot('/vaults/notes'))
    expect(handlers.onOpenRoot).toHaveBeenCalledWith('/vaults/notes')
    act(() => b.emitSearch())
    expect(handlers.onSearch).toHaveBeenCalledTimes(1)
    act(() => b.emitSwitchVault())
    expect(handlers.onSwitchVault).toHaveBeenCalledTimes(1)
    act(() => b.emitSettings())
    expect(handlers.onSettings).toHaveBeenCalledTimes(1)
    act(() => b.emitToggleSidebar())
    expect(handlers.onToggleSidebar).toHaveBeenCalledTimes(1)
    act(() => b.emitCloseTab())
    expect(handlers.onCloseTab).toHaveBeenCalledTimes(1)
    act(() => b.emitNextTab())
    expect(handlers.onNextTab).toHaveBeenCalledTimes(1)
    act(() => b.emitPrevTab())
    expect(handlers.onPrevTab).toHaveBeenCalledTimes(1)
    // 🔒 YAZ-1775 D10: the items that left the canvas hamburger for the application menu, plus 🔒 YAZ-1775 D3's export.
    act(() => b.emitExportImage())
    expect(handlers.onExportImage).toHaveBeenCalledTimes(1)
    act(() => b.emitCanvasBackground('#fffce8'))
    expect(handlers.onCanvasBackground).toHaveBeenCalledWith('#fffce8')
    act(() => b.emitExportDrawing())
    expect(handlers.onExportDrawing).toHaveBeenCalledTimes(1)
    // YAZ-1799 D6: File › Share Link (⌘⇧L) opens the Share dialog for the visible drawing.
    act(() => b.emitShareLink())
    expect(handlers.onShareLink).toHaveBeenCalledTimes(1)

    act(() => root?.unmount())
    root = null
    expect(b.count()).toBe(0)
  })
})
