/**
 * IMAGE STUDIO'S SESSION (🔒 YAZ-1990 D1, D2): what the Images tab was doing — its view, queries,
 * results and scroll — held at module scope, because closing the canvas panel UNMOUNTS the tab.
 * One per window (each window is its own renderer), shared by that window's drawing tabs; an app
 * restart starts empty (🔒 D0).
 *
 * THE SEARCH LIVES HERE TOO, not in the component: its request id and the cursors it already asked
 * for must outlive a mount, or a page still in flight from before a close could overwrite a newer
 * search. A page that lands after the panel closed still lands; a stale one never does.
 */
import type { MediaSearchSource, StoredMediaItem, StudioItem } from '@shared/types'
import { api, BridgeRequestError } from '../api'
import { createStore } from '../lib/store'
import type { SmartShapeApi } from './shapes'

export type StudioView = 'search' | 'shapes' | 'favorites' | 'recent'

/** What the Search view says when the machine could not reach a provider (🔒 YAZ-1775 D4's offline half). */
export const OFFLINE_NOTICE = "You're offline. Shapes, Favorites and Recent still work."

export interface StudioSession {
  view: StudioView
  query: string
  source: MediaSearchSource
  shapeQuery: string
  /** The query the results on screen belong to, which the field may have moved on from. */
  searchedQuery: string
  results: StudioItem[]
  cursor: string | null
  warnings: string[]
  isSearching: boolean
  offline: boolean
  pageError: string | null
  error: string | null
  pixabayAvailable: boolean
  /** Kept, not just re-listed, so the rows exist on the first paint after a reopen and the scroll can land. */
  favorites: StoredMediaItem[]
  recent: StoredMediaItem[]
  smart: SmartShapeApi | null
}

const EMPTY: StudioSession = {
  view: 'search',
  query: '',
  source: 'all',
  shapeQuery: '',
  searchedQuery: '',
  results: [],
  cursor: null,
  warnings: [],
  isSearching: false,
  offline: false,
  pageError: null,
  error: null,
  pixabayAvailable: true,
  favorites: [],
  recent: [],
  smart: null,
}

export const imageStudioSession = createStore<StudioSession>(EMPTY)

/** Where each view's grid was left (🔒 D3). Written on every scroll and never rendered, so it stays out of the store. */
export const scrollTops: Record<StudioView, number> = { search: 0, shapes: 0, favorites: 0, recent: 0 }

let searchRequestId = 0
/** The cursors already asked for this search; a page is never requested twice. */
const requestedCursors = new Set<string>()
export const wasRequested = (cursor: string) => requestedCursors.has(cursor)

/** A test starts from an empty session, the way `clearPreviewMemo` gives it empty tiles. */
export function resetImageStudioSession() {
  searchRequestId++
  requestedCursors.clear()
  Object.assign(scrollTops, { search: 0, shapes: 0, favorites: 0, recent: 0 })
  imageStudioSession.set(EMPTY)
}

const dedupeItems = (items: StudioItem[]) => [...new Map(items.map((item) => [item.itemKey, item])).values()]

export const getErrorMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback)

/**
 * One page. `append` is the infinite scroll's next page and keeps what is on screen; a fresh
 * search clears everything, including the cursors already asked for — which is what stops the
 * observer from re-firing the page it just loaded.
 */
export async function runSearch({
  append = false,
  retry = false,
  nextQuery,
  nextSource,
}: { append?: boolean; retry?: boolean; nextQuery?: string; nextSource?: MediaSearchSource } = {}) {
  const { set, getState } = imageStudioSession
  const state = getState()
  const askedQuery = nextQuery ?? (append ? state.searchedQuery : state.query.trim())
  const askedSource = nextSource ?? state.source
  if (askedQuery.length < 2) {
    set({ error: 'Type at least two characters.' })
    return
  }
  const requestedCursor = append ? state.cursor : null
  if (append && (requestedCursor === null || state.isSearching || (!retry && requestedCursors.has(requestedCursor)))) return
  const requestId = append ? searchRequestId : ++searchRequestId
  if (requestedCursor !== null) {
    requestedCursors.add(requestedCursor)
    set({ isSearching: true, pageError: null })
  } else {
    requestedCursors.clear()
    set({ isSearching: true, error: null, pageError: null, offline: false, results: [], cursor: null, warnings: [], searchedQuery: askedQuery })
  }
  try {
    const response = await api.media.search({ q: askedQuery, source: askedSource, cursor: requestedCursor })
    if (requestId !== searchRequestId) return
    const results = dedupeItems(append ? [...getState().results, ...response.items] : response.items)
    set({ results, cursor: response.nextCursor, warnings: response.warnings, pixabayAvailable: response.pixabayAvailable, offline: false })
  } catch (cause) {
    if (requestId !== searchRequestId) return
    const isOffline = cause instanceof BridgeRequestError && cause.code === 'OFFLINE'
    const message = getErrorMessage(cause, 'Image search failed')
    if (isOffline) set({ offline: true })
    if (append) set({ pageError: isOffline ? OFFLINE_NOTICE : message })
    else if (!isOffline) set({ error: message })
  } finally {
    if (requestId === searchRequestId) set({ isSearching: false })
  }
}
