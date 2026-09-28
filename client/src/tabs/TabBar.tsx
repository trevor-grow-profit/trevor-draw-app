import { useEffect, useRef, useState } from 'react'
import { isDiagram } from '@shared/fileKind'
import { api, BridgeRequestError } from '../api'
import { ContextMenuSurface } from '../components/ContextMenuSurface'
import { dropIndex, insertionSlot } from '../lib/dragSlot'
import { basename, stripExt } from '../lib/paths'
import { DiagramBadge, SidebarPanelIcon } from '../components/icons'
import './tabs.css'

export interface TabBarProps {
  /** Open tabs, absolute paths, left→right. */
  tabs: readonly string[]
  /** The active tab (the window's `file`); null with no tabs open. */
  active: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
  /** Drag-to-reorder (I3, GRO-2235): the tab at `from` lands at final index `to`. */
  onMove: (from: number, to: number) => void
  /** History (YAZ-721): the active tab's own back/forward stack has somewhere to go. */
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  /**
   * Collapsed sidebar (YAZ-1759): the reopen control sits HERE, left of ◀, instead of floating
   * over it. Absent while the sidebar is open.
   */
  onShowSidebar?: () => void
  /** Reveal this exact tab in the sidebar without activating it. */
  onShowInSidebar?: (path: string) => void
  /**
   * Where a failed OS action says so (YAZ-963) — App's passive notice. Optional: a mount with
   * nowhere to show one loses the message, never the gesture.
   */
  onNotice?: (message: string) => void
}

/** In-flight drag state: the grabbed tab's index + the hovered insertion slot (0…tabs.length). */
interface DragState {
  from: number
  over: number | null
}

const Chevron = ({ d }: { d: string }) => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)

/**
 * The window tab strip (Tabs I2/I3, GRO-2234/2235): one tab per open file, ViewTabs' tablist
 * semantics (role=tab, aria-selected, active underline). Labels hide only a board's own
 * extension; view-only labels keep their extension and every full path lives in the title
 * tooltip. A draw.io diagram's label follows its type mark, as its sidebar row does (🔒 YAZ-1802
 * D15). Tabs reorder by HTML5 drag (the groupDrag idiom: `dataTransfer` guarded — jsdom's
 * synthetic drags have none) with an accent insertion indicator; the strip scrolls when full and
 * keeps the ACTIVE tab in view. Left of
 * the strip sit the ◀ ▶ history buttons (YAZ-721), disabled when the active tab's stack has
 * nowhere to go — buttons only, per LOCKED ruling D2: no shortcut, no menu item.
 * Presentational only — all durable state changes go through workspace callbacks.
 */
export function TabBar({ tabs, active, onActivate, onClose, onMove, canBack, canForward, onBack, onForward, onShowSidebar, onShowInSidebar, onNotice }: TabBarProps) {
  const [drag, setDrag] = useState<DragState | null>(null)
  // Right-click menu (YAZ-922): the tab IS the file, so it offers the sidebar row's Copy path —
  // and since YAZ-963 that row's OS actions too (Reveal in Finder, Open in VS Code).
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)

  // Overflow polish (I3): tabs shrink to a floor and the strip scrolls, so scroll the active
  // tab fully into view on every activation. jsdom has no scrollIntoView — hence the `?.()`.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active])
  const drop = (insertion: number): void => {
    if (drag === null) return
    setDrag(null)
    const to = dropIndex(drag.from, insertion)
    if (to !== drag.from) onMove(drag.from, to)
  }

  /**
   * The menu's OS actions (YAZ-963), the sidebar's `reveal` idiom on a tab: read-only, so the
   * menu closes at once and there is nothing to confirm or repair — but a STALE tab (deleted or
   * moved externally) rejects `NOT_FOUND`, and without the notice the item would just look
   * broken. Both messages are the caller's, because "reveal" and "open … in VS Code" name the
   * gesture differently in each half.
   */
  const osAction = (call: Promise<unknown>, stale: string, failed: string): void => {
    setMenu(null)
    call.catch((err: unknown) => {
      onNotice?.(err instanceof BridgeRequestError && err.code === 'NOT_FOUND' ? stale : `${failed}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  return (
    <div className="tabbar-row">
      <div className="tabbar-nav">
        {onShowSidebar && (
          <button type="button" className="tabbar-nav__btn" aria-label="Show sidebar" title="Show sidebar" onClick={onShowSidebar}>
            <SidebarPanelIcon />
          </button>
        )}
        <button type="button" className="tabbar-nav__btn" aria-label="Back" title="Back" disabled={!canBack} onClick={onBack}>
          <Chevron d="m10 4-4 4 4 4" />
        </button>
        <button type="button" className="tabbar-nav__btn" aria-label="Forward" title="Forward" disabled={!canForward} onClick={onForward}>
          <Chevron d="m6 4 4 4-4 4" />
        </button>
      </div>
      <div
        className="tabbar scroll-strip"
        role="tablist"
        aria-label="Open files"
        onDragOver={(e) => {
          // The empty strip tail: only direct hits — tab hovers are handled (and marked) per tab.
          if (e.target !== e.currentTarget || drag === null) return
          e.preventDefault()
          if (drag.over !== tabs.length) setDrag({ ...drag, over: tabs.length })
        }}
        onDrop={(e) => {
          if (e.target !== e.currentTarget || drag === null) return
          e.preventDefault()
          drop(tabs.length)
        }}
      >
        {tabs.map((path, i) => {
          const isActive = path === active
          const label = stripExt(basename(path))
          const cls = ['tabbar__tab']
          if (isActive) cls.push('tabbar__tab--active')
          if (drag !== null && drag.from === i) cls.push('tabbar__tab--dragging')
          // The insertion indicator: an accent edge on the tab the drop would land before —
          // or after the LAST tab for the end slot.
          const over = drag?.over ?? null
          if (over === i) cls.push('tabbar__tab--insert-before')
          if (over === tabs.length && i === tabs.length - 1) cls.push('tabbar__tab--insert-after')
          return (
            <div
              key={path}
              ref={isActive ? activeRef : undefined}
              className={cls.join(' ')}
              draggable
              onDragStart={() => setDrag({ from: i, over: null })}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => {
                if (drag === null) return
                const over = insertionSlot(e, i)
                e.preventDefault()
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                if (drag.over !== over) setDrag({ ...drag, over })
              }}
              onDrop={(e) => {
                if (drag === null) return
                e.preventDefault()
                drop(insertionSlot(e, i))
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, path })
              }}
            >
              <button
                type="button"
                role="tab"
                className="tabbar__btn"
                aria-selected={isActive}
                title={path}
                onClick={() => onActivate(path)}
                onAuxClick={(e) => {
                  // Middle-click closes — the browser-tab convention.
                  if (e.button === 1) onClose(path)
                }}
              >
                {isDiagram(path) && <DiagramBadge className="tabbar__kind" />}
                <span className="tabbar__label">{label}</span>
              </button>
              <button type="button" className="tabbar__close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => onClose(path)}>
                ✕
              </button>
            </div>
          )
        })}
      </div>
      {menu !== null && (
        <ContextMenuSurface x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            className="ctx-menu__item"
            role="menuitem"
            onClick={() => {
              onShowInSidebar?.(menu.path)
              setMenu(null)
            }}
          >
            Show in sidebar
          </button>
          <button
            type="button"
            className="ctx-menu__item"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard.writeText(menu.path)
              setMenu(null)
            }}
          >
            Copy path
          </button>
          <button type="button" className="ctx-menu__item" role="menuitem" onClick={() => osAction(api.shell.reveal({ path: menu.path }), `Can't reveal "${basename(menu.path)}" — it is no longer there`, "Can't reveal")}>
            Reveal in Finder
          </button>
          <button type="button" className="ctx-menu__item" role="menuitem" onClick={() => osAction(api.shell.openVsCode({ path: menu.path }), `Can't open "${basename(menu.path)}" in VS Code — it is no longer there`, "Can't open in VS Code")}>
            Open in VS Code
          </button>
        </ContextMenuSurface>
      )}
    </div>
  )
}
