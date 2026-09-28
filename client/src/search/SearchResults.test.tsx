/**
 * The flat result list (YAZ-803, 🔒 flat-list ruling on YAZ-739): rows in the ranking's order,
 * the folder as a secondary label only when there is one, and the tree's ⌘-click convention.
 * Since YAZ-1491 a click reports ONE activation with the ⌘ flag (🔒 D3) — the Sidebar decides
 * what a folder vs a note does — and a folder row looks like a folder (🔒 YAZ-1491 D4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SearchCandidate } from './searchCandidates'
import { SearchResults } from './SearchResults'


const cand = (name: string, folder = ''): SearchCandidate => ({
  kind: 'file',
  name,
  lower: name.toLowerCase(),
  label: name,
  path: `/v/${folder === '' ? '' : `${folder}/`}${name}.md`,
  folder,
})
const dir = (name: string, folder = ''): SearchCandidate => ({
  kind: 'dir',
  name,
  lower: name.toLowerCase(),
  label: name,
  path: `/v/${folder === '' ? '' : `${folder}/`}${name}`,
  folder,
})

let reactRoot: Root | null = null
let container: HTMLElement | null = null

function render(results: SearchCandidate[], selected = 0) {
  const props = { onSelect: vi.fn(), onActivate: vi.fn(), onRowContextMenu: vi.fn() }
  container = document.createElement('div')
  document.body.appendChild(container)
  reactRoot = createRoot(container)
  act(() => reactRoot?.render(<StrictMode><SearchResults results={results} selected={selected} {...props} /></StrictMode>))
  return { el: container, ...props }
}

const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLLIElement>('.search-results__row')]

afterEach(() => {
  act(() => reactRoot?.unmount())
  reactRoot = null
  container?.remove()
  container = null
  vi.restoreAllMocks()
})

describe('SearchResults (YAZ-803)', () => {
  it('renders one row per result, in the order given', () => {
    const { el } = render([cand('Beta'), cand('Alpha')])
    expect(rows(el).map((r) => r.querySelector('.search-results__label')?.textContent)).toEqual(['Beta', 'Alpha'])
  })

  it('shows the folder only for rows that have one', () => {
    const { el } = render([cand('Root note'), cand('Nested', 'Docs/Deep')])
    expect(rows(el)[0].querySelector('.search-results__folder')).toBeNull()
    expect(rows(el)[1].querySelector('.search-results__folder')?.textContent).toBe('Docs/Deep')
  })

  it('rows are anchored by aria-label (what the e2e run clicks)', () => {
    const { el } = render([cand('Meeting notes')])
    expect(rows(el)[0].getAttribute('aria-label')).toBe('Search result Meeting notes')
  })

  it('the selected row alone carries the active class and aria-selected', () => {
    const { el } = render([cand('A'), cand('B'), cand('C')], 1)
    expect(rows(el).map((r) => r.classList.contains('search-results__row--active'))).toEqual([false, true, false])
    expect(rows(el).map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  })

  it('a plain click activates the row (background: false) and moves selection to it', () => {
    const results = [cand('A'), cand('B')]
    const { el, onActivate, onSelect } = render(results)
    act(() => rows(el)[1].click())
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(results[1], false)
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('⌘-click activates with background: true (the tree row convention)', () => {
    const results = [cand('A')]
    const { el, onActivate } = render(results)
    act(() => void rows(el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })))
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(results[0], true)
  })

  it('a right-click reports the row and moves selection to it, opening nothing (Docs YAZ-2050)', () => {
    const results = [cand('A'), dir('B')]
    const { el, onActivate, onSelect, onRowContextMenu } = render(results)
    act(() => void rows(el)[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(onRowContextMenu).toHaveBeenCalledExactlyOnceWith(results[1], expect.objectContaining({ type: 'contextmenu' }))
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('a folder row carries the dir class, a glyph, and a `, folder` aria-label suffix (🔒 D4, YAZ-1491)', () => {
    const { el } = render([dir('Archive'), cand('Archive')])
    const [folder, note] = rows(el)
    expect(folder.classList.contains('search-results__row--dir')).toBe(true)
    expect(folder.getAttribute('aria-label')).toBe('Search result Archive, folder')
    expect(folder.querySelector('.search-results__glyph')).not.toBeNull()
    expect(folder.querySelector('.search-results__label')?.textContent).toBe('Archive')
    expect(note.classList.contains('search-results__row--dir')).toBe(false)
    expect(note.getAttribute('aria-label')).toBe('Search result Archive')
    expect(note.querySelector('.search-results__glyph')).toBeNull()
  })
})
