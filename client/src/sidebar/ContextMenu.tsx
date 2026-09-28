import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { MenuAction, MenuItem, MenuParent, MenuSection } from './menuSections'

interface ContextMenuProps {
  x: number
  y: number
  /**
   * The items as data (🔒 D8, YAZ-1674) — built by a sections builder, where every gating rule
   * lives: the file tree's `buildMenuSections` (six groups, 🔒 D7) or the vault switcher's
   * `buildVaultMenuSections` (five, YAZ-1941 · YAZ-2056). This component only draws them: a
   * `role="group"` per NON-EMPTY section (the separator is CSS between adjacent groups), and one
   * button per item whose ONLY text child is the label — the hint is drawn from `data-hint`, so
   * `textContent` and the accessible name stay the bare label. A parent item ("Open in ▸", D7
   * amended) opens a flyout drawn by the SAME group renderer, one level deep.
   */
  sections: readonly MenuSection[]
  onClose: () => void
}

/** Groups of items (🔒 YAZ-1674 D7): one `role="group"` per NON-EMPTY section — the root and every flyout share it. */
function Groups<T extends MenuItem>({ sections, render }: { sections: readonly (readonly T[])[]; render: (item: T) => ReactNode }) {
  return (
    <>
      {sections
        .filter((section) => section.length > 0)
        .map((section) => (
          <div key={section[0].id} className="ctx-menu__group" role="group">
            {section.map(render)}
          </div>
        ))}
    </>
  )
}

/** A leaf: `onSelect()` then `onClose()` — every item closes the WHOLE menu (🔒 YAZ-1674 D8). */
function ActionButton({ item, onClose, onMouseEnter }: { item: MenuAction; onClose: () => void; onMouseEnter?: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`ctx-menu__item${item.danger === true ? ' ctx-menu__item--danger' : ''}`}
      disabled={item.disabled}
      data-hint={item.hint}
      onMouseEnter={onMouseEnter}
      // An item whose handler already closes the menu (the create group's inline input) just
      // sets the same null twice — harmless.
      onClick={() => {
        item.onSelect()
        onClose()
      }}
    >
      {item.label}
    </button>
  )
}

/**
 * The flyout (D7 amended, YAZ-1674): a second `.ctx-menu`, opened to the RIGHT of its parent row,
 * top-aligned with it, measured after the first paint like the root — and when its right edge
 * would spill off the viewport it opens to the LEFT of the parent instead (Finder's rule), the
 * top clamped exactly as the root clamps. Hidden until measured so it never flashes at 0,0.
 */
function Flyout({ anchor, sections, onClose, onCloseFlyout }: { anchor: RefObject<HTMLButtonElement | null>; sections: readonly (readonly MenuAction[])[]; onClose: () => void; onCloseFlyout: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Once per open: the anchor ref is stable and the flyout mounts only while it is open.
  useLayoutEffect(() => {
    const el = ref.current
    const parent = anchor.current
    if (el === null || parent === null) return
    const r = el.getBoundingClientRect()
    const p = parent.getBoundingClientRect()
    const left = p.right + r.width > window.innerWidth ? Math.max(0, p.left - r.width) : p.right
    setPos({ left, top: Math.max(0, Math.min(p.top, window.innerHeight - r.height)) })
  }, [anchor])

  return (
    <div
      ref={ref}
      className="ctx-menu ctx-menu__sub"
      role="menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos === null ? 'hidden' : undefined }}
      onMouseDown={(e) => e.stopPropagation()}
      // ArrowLeft steps back out of the flyout alone; Escape does the same through the root's
      // window listener, which asks whether a flyout is open before closing everything.
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft') return
        e.preventDefault()
        e.stopPropagation()
        onCloseFlyout()
      }}
    >
      <Groups sections={sections} render={(item) => <ActionButton key={item.id} item={item} onClose={onClose} />} />
    </div>
  )
}

/**
 * A parent ("Open in ▸"): a `menuitem` with `aria-haspopup`, its chevron drawn by CSS so the text
 * stays the bare label. Opens on hover AND on click (and ArrowRight / Enter); it has no select of
 * its own. The flyout stays while the pointer is inside the row or the flyout — there is no
 * leave rule — and closes when the pointer enters a DIFFERENT top-level item (the root's job).
 * Keyboard: Tab already reaches every item (they are buttons), so Tab + Enter + Escape is the
 * complete path; ArrowRight / Enter to open and ArrowLeft to close are sugar on top of it.
 */
function ParentItem({ item, open, onOpen, onCloseFlyout, onClose }: { item: MenuParent; open: boolean; onOpen: () => void; onCloseFlyout: () => void; onClose: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="ctx-menu__parent" onMouseEnter={onOpen}>
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="ctx-menu__item ctx-menu__item--parent"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'Enter') return
          e.preventDefault()
          e.stopPropagation()
          onOpen()
        }}
      >
        {item.label}
      </button>
      {open && <Flyout anchor={buttonRef} sections={item.children} onClose={onClose} onCloseFlyout={onCloseFlyout} />}
    </div>
  )
}

/** The sidebar's right-click menu — the file tree's (GRO-2022) and the vault switcher's (YAZ-1941). The overlay catches click-away and stray right-clicks. */
export function ContextMenu({ x, y, sections, onClose }: ContextMenuProps) {
  // The ONE open flyout (D7 amended): at most one parent is expanded at a time.
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A flyout owns its own Escape: the first press closes it alone, the next closes the menu.
      if (openId !== null) setOpenId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, openId])

  // Viewport clamping (GRO-2204): render at the cursor, then measure and pull the menu back
  // inside the window instead of spilling off an edge.
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = menuRef.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(0, Math.min(x, window.innerWidth - r.width)), top: Math.max(0, Math.min(y, window.innerHeight - r.height)) })
  }, [x, y])

  return (
    <div
      className="ctx-overlay"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div ref={menuRef} className="ctx-menu" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()} role="menu">
        <Groups
          sections={sections}
          render={(item) =>
            item.children === undefined ? (
              // Entering a DIFFERENT top-level item is what closes an open flyout.
              <ActionButton key={item.id} item={item} onClose={onClose} onMouseEnter={() => setOpenId(null)} />
            ) : (
              <ParentItem key={item.id} item={item} open={openId === item.id} onOpen={() => setOpenId(item.id)} onCloseFlyout={() => setOpenId(null)} onClose={onClose} />
            )
          }
        />
      </div>
    </div>
  )
}
