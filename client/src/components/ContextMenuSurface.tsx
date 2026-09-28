import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface ContextMenuSurfaceProps {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
  /** A fixed width in px: the Info popover and the Share menu. Menus otherwise keep their content width. */
  width?: number
  /** A floor in px (Docs YAZ-1974 D7): the vault switcher is at least its header's width and grows to fit names. */
  minWidth?: number
  /** Extra class beside `ctx-menu` (YAZ-1767 D5): `ctx-menu--panel` restyles the surface as a flush drop-down panel. */
  className?: string
  /** What the surface announces: a `menu` by default; the Info popover is a `dialog` (🔒 YAZ-1835 D6). */
  role?: 'menu' | 'dialog'
}

/** Action-free context-menu mechanics shared by menus whose commands stay domain-owned. */
export function ContextMenuSurface({ x, y, onClose, children, width, minWidth, className, role = 'menu' }: ContextMenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const [position, setPosition] = useState({ left: x, top: y })
  onCloseRef.current = onClose

  useEffect(() => {
    const close = () => onCloseRef.current()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useLayoutEffect(() => {
    const bounds = menuRef.current?.getBoundingClientRect()
    if (bounds === undefined) return
    setPosition({
      left: Math.max(0, Math.min(x, window.innerWidth - bounds.width)),
      top: Math.max(0, Math.min(y, window.innerHeight - bounds.height)),
    })
  }, [x, y])

  return (
    <div
      ref={menuRef}
      className={['ctx-menu', className].filter(Boolean).join(' ')}
      role={role}
      style={{ left: position.left, top: position.top, width, minWidth }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}
