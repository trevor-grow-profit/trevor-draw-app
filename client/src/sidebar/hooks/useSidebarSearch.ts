/** The persistent search bar (YAZ-739, YAZ-801, YAZ-803): the query, its ranked results and the keyboard's row. */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { TreeResponse } from '@shared/types'
import type { SearchCandidate } from '../../search/searchCandidates'
import { useSearchResults } from '../../search/useSearchResults'

export function useSidebarSearch(root: string, tree: TreeResponse | null, pendingSearchFocus: boolean, onSearchFocusHandled: () => void, activate: (hit: SearchCandidate, background: boolean) => void) {
  // The persistent search bar's query (YAZ-801). It lives in the Sidebar rather than in the bar because
  // YAZ-803 swaps the BODY while it is non-empty; Sidebar is mounted `key={root}`, so it resets
  // on unmount and on a root switch without any clearing code.
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  // The highlighted result row (YAZ-803); the keyboard owns it, so it lives with the query.
  const [selected, setSelected] = useState(0)
  // ⌘K's feed (YAZ-1814): the ONE tree this panel already holds and the watcher already keeps
  // fresh — the catalog walk lives in `search/`, is lazy until the first query, and drops
  // non-drawing files and (through `fs:tree`) the image store.
  const results = useSearchResults(root, query, tree?.tree ?? null)
  // 🔒 flat-list ruling on YAZ-739: while a query is typed the body shows a FLAT ranked list
  // instead of the tree. A conditional render, not a teardown — every bit of tree state (data,
  // expansion, pending create/rename, drag) lives in the Sidebar and is waiting untouched when it clears.
  const searching = query.trim() !== ''
  // A tree refresh can shrink the list under the keyboard's index (F1 finding 2, YAZ-808), so
  // every reader of the selection clamps: the highlight lands on the last row, not on nowhere.
  const sel = Math.min(selected, results.length - 1)

  // ⌘K's focus handshake (YAZ-801). Firing on MOUNT is deliberate, not a side effect to guard
  // against: ⌘K with the sidebar collapsed un-collapses it, so the sidebar mounts with the flag
  // already true (0- re-scope on YAZ-800). A plain remount with the flag false focuses nothing.
  useEffect(() => {
    if (!pendingSearchFocus) return
    searchInput.current?.focus()
    onSearchFocusHandled()
  }, [pendingSearchFocus, onSearchFocusHandled])

  const changeQuery = (e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    setSelected(0) // a new query is a new ranking: the top row is the selection again
  }

  const searchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // Esc empties a typed query first and only gives up focus on the second press.
      if (query !== '') setQuery('')
      else e.currentTarget.blur()
      return
    }
    // The bar keeps focus while the list is driven from it (YAZ-803). ↑/↓ WRAP (YAZ-1814):
    // the list is capped at 50 and read top-down, so falling off the end is a
    // request for the other end — and ↑ from the top row is the cheapest way to the
    // bottom of a full list. Opening leaves the list up.
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(sel + 1 >= results.length ? 0 : sel + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(sel - 1 < 0 ? results.length - 1 : sel - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = results[sel]
      if (hit === undefined) return
      activate(hit, e.metaKey)
    }
  }

  return { query, setQuery, searching, results, sel, setSelected, searchInput, changeQuery, searchKeyDown }
}
