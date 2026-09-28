/**
 * The search bar's result list (YAZ-803). 🔒 flat-list ruling on YAZ-739: a FLAT ranked list,
 * never a tree — the rows carry a folder label instead of a position. Presentational only:
 * selection is owned by the Sidebar, since the keyboard drives it from the search input — and so
 * is ACTIVATION (🔒 D3, YAZ-1491): a click reports the row and the ⌘ flag, and the Sidebar's one
 * rule decides whether that reveals a folder or opens a drawing. Folder rows look like folders
 * (🔒 YAZ-1491 D4): a glyph before the label and a `, folder` suffix on the aria-label. A right-click
 * reports the row the same way (Docs YAZ-2050): the Sidebar opens the tree row's own menu for it.
 */
import { useEffect, useRef } from 'react'
import type { SearchCandidate } from './searchCandidates'

interface SearchResultsProps {
  results: readonly SearchCandidate[]
  /** Index of the selected row; the keyboard owns it, hover never moves it. */
  selected: number
  onSelect: (index: number) => void
  /** A row was clicked; `background` is ⌘ (I3 convention, GRO-2235) — the Sidebar's `activate` shares this with Enter. */
  onActivate: (row: SearchCandidate, background: boolean) => void
  /** A row was right-clicked (Docs YAZ-2050): the Sidebar opens the SAME menu the row's tree row gets. */
  onRowContextMenu: (row: SearchCandidate, e: React.MouseEvent) => void
}

/** Small folder outline for a `dir` row (🔒 D4, YAZ-1491) — the `SidebarPanelIcon` idiom. */
function FolderGlyph() {
  return (
    <svg className="search-results__glyph" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3.4l1.6 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function SearchResults({ results, selected, onSelect, onActivate, onRowContextMenu }: SearchResultsProps) {
  const selectedRow = useRef<HTMLLIElement | null>(null)

  // The list scrolls inside `.sidebar__body`, so arrowing past its edge must bring the row along.
  // jsdom has no scrollIntoView — hence the `?.()` (the TabBar idiom).
  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  return (
    <ul className="search-results" role="listbox" aria-label="Search results">
      {results.map((r, i) => (
        <li
          // `␟` (U+241F) separates the key's parts: a printable character that cannot appear in a
          // path or a name, so the key stays unique. It replaces a literal NUL, which did the same
          // job but made this file grep-invisible — `grep` treats a NUL byte as binary and skips it.
          key={`${r.path}␟${r.name}`}
          ref={i === selected ? selectedRow : null}
          role="option"
          aria-selected={i === selected}
          aria-label={`Search result ${r.label}${r.kind === 'dir' ? ', folder' : ''}`}
          className={`search-results__row${i === selected ? ' search-results__row--active' : ''}${r.kind === 'dir' ? ' search-results__row--dir' : ''}`}
          title={r.path}
          onClick={(e) => {
            // A click moves selection to the clicked row, so the next arrow key continues from it.
            onSelect(i)
            onActivate(r, e.metaKey)
          }}
          onContextMenu={(e) => {
            onSelect(i) // a right-click highlights the row too — the tree's rule (D9, YAZ-1674)
            onRowContextMenu(r, e)
          }}
        >
          <span className="search-results__label">
            {r.kind === 'dir' && <FolderGlyph />}
            {r.label}
          </span>
          {r.folder !== '' && <span className="search-results__folder">{r.folder}</span>}
        </li>
      ))}
    </ul>
  )
}
