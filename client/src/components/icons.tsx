import { BOARD_TYPE_NAME } from '@shared/fileKind'

/** The shell's stroked 14px glyphs, in the sidebar's style. */
const svg = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

/** Octicons' `triangle-down` (the chevron GitHub Desktop's repository switcher wears, YAZ-1767 D6); `up` flips it while the panel is open. */
export function TriangleIcon({ up = false }: { up?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={up ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427Z" />
    </svg>
  )
}

/**
 * Panel-left pictogram shared by the sidebar's collapse button and the tab strip's Show-sidebar
 * button (GRO-2023). Deliberately NOT on the shared `svg` spread: its square line caps are the
 * original pixels.
 */
export function SidebarPanelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <line x1="5.75" y1="2.5" x2="5.75" y2="13.5" />
    </svg>
  )
}

/** The sidebar's search affordance (⌘K). */
export const SearchIcon = () => (
  <svg {...svg}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3.5 3.5" />
  </svg>
)

/** Double chevron, for collapse-all in the Files tree. */
export const ChevronsIcon = () => (
  <svg {...svg}>
    <path d="M4.5 4 8 7l3.5-3M4.5 9 8 12l3.5-3" />
  </svg>
)

/** The sort control (YAZ-1835): three bars, shortest last. */
export const SortIcon = () => (
  <svg {...svg}>
    <path d="M3 4.5h10M3 8h7M3 11.5h4" />
  </svg>
)

/** Focus Mode's eye (YAZ-1605). */
export const EyeIcon = () => (
  <svg {...svg}>
    <path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z" />
    <circle cx="8" cy="8" r="1.8" />
  </svg>
)

/** Circled "i", for the vault switcher row's full-path tooltip (Docs YAZ-1974 D2). */
export const InfoIcon = () => (
  <svg {...svg}>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 7.2v4.3" />
    <circle cx="8" cy="4.9" r="0.4" fill="currentColor" />
  </svg>
)

/** The sidebar's hover-preview toggle (YAZ-1800): a framed picture; accent while previews are on. */
export const PreviewIcon = () => (
  <svg {...svg}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M2 11l3.5-3.5 2.5 2.5 2-2L14 12" />
    <circle cx="10.5" cy="6" r="1" />
  </svg>
)

/** The Favorites lens tab (YAZ-1766 D1, a glyph not a word); filled while active via CSS. */
export const HeartIcon = () => (
  <svg {...svg} width={15} height={15} viewBox="0 0 24 24" strokeWidth={2} className="heart-icon">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>
)

/**
 * 🔒 YAZ-1802 D15: a draw.io diagram's type mark — linked boxes, a generic glyph, never draw.io's
 * logo — on its sidebar row and before its tab label, named for screen readers. Excalidraw boards carry none.
 */
export const DiagramBadge = ({ className }: { className: string }) => (
  <span className={className} role="img" aria-label={BOARD_TYPE_NAME.diagram} title={BOARD_TYPE_NAME.diagram}>
    <svg {...svg} width={12} height={12} viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="3" y="3" width="7" height="6" rx="1" />
      <rect x="14" y="15" width="7" height="6" rx="1" />
      <path d="M6.5 9v4a2 2 0 0 0 2 2H14" />
    </svg>
  </span>
)

/** Share link (YAZ-1799): the chain — the Share dialog's Copy link button and a shared board's sidebar mark. */
export const LinkIcon = ({ size = 15 }: { size?: number }) => (
  <svg {...svg} width={size} height={size} viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
)

/** The Share dialog's "Not shared" (YAZ-1799). */
export const LockIcon = () => (
  <svg {...svg} width={18} height={18} viewBox="0 0 24 24" strokeWidth={1.8}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
)

/** The Share dialog's "Anyone with the link" (YAZ-1799). */
export const GlobeIcon = () => (
  <svg {...svg} width={18} height={18} viewBox="0 0 24 24" strokeWidth={1.8}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
)
