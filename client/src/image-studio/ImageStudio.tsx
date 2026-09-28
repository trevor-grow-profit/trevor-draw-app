/**
 * THE IMAGES TAB (🔒 YAZ-1775 D4, YAZ-1818): four views — Search, Shapes, Favorites, Recent —
 * over the providers MAIN owns. The renderer never holds an API key and never reaches a provider.
 *
 * A PREVIEW IS ASKED FOR, NOT LINKED TO. Every tile asks `media:preview` for its bytes as a
 * dataURL, because the renderer may not fetch from a provider; a favorite's stored `previewUrl`
 * is never read. The cache behind it is `lib/previewCache.ts`.
 *
 * NO KEY IS NOT AN ERROR (🔒 YAZ-1775 D4). `pixabayAvailable` false simply hides the Pixabay source and
 * says nothing; Settings › Images is where a key is entered.
 *
 * OFFLINE IS A STATE, NOT A BANNER. A search that could not reach a provider renders a passive
 * line; Shapes keeps working entirely, and Favorites and Recent keep working with whatever
 * previews main still has cached.
 *
 * THE SMART SHAPES ARRIVE LATE ON PURPOSE. `@excalidraw/element` is a second ~300 kB download
 * (`engine.ts`'s lazy rule), so the seven basic shapes render immediately and the twelve Smart
 * Shapes join when it lands. Nothing waits on it.
 *
 * WHAT AN INSERT COSTS ON DISK: nothing, here. The bytes go to the engine, its files map grows an
 * id the store does not hold, and `drawing:save` writes it into `assets/` before the scene names
 * it (🔒 YAZ-1775 D3).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PIXABAY_SECRET, type MediaBytesProvider, type MediaSearchSource, type StoredMediaItem, type StudioItem } from '@shared/types'
import { api, BridgeRequestError } from '../api'
import { createPreviewCache } from '../lib/previewCache'
import { loadExcalidrawElement } from '../drawings/engine'
import { insertImage, insertShape, fileFromImport, type InsertEngine, type InsertTarget } from './insertShape'
import { buildShapeCatalog, filterShapeCatalog, getShape, type ShapeCatalogItem, type ShapePreview, type SmartShapeApi } from './shapes'
import './imageStudio.css'

type StudioView = 'search' | 'shapes' | 'favorites' | 'recent'
const STUDIO_VIEWS: readonly StudioView[] = ['search', 'shapes', 'favorites', 'recent']

const VIEW_LABELS: Record<StudioView, string> = { search: 'Search', shapes: 'Shapes', favorites: 'Favorites', recent: 'Recent' }

/** What the Search view says when the machine could not reach a provider (🔒 YAZ-1775 D4's offline half). */
export const OFFLINE_NOTICE = "You're offline. Shapes, Favorites and Recent still work."

export interface ImageStudioProps {
  /** The two engine values an insert needs; the panel only exists once the engine has loaded. */
  engine: InsertEngine
  /** The engine's imperative handle; `CanvasSidebar` does not render a tab without one. */
  excalidrawAPI: InsertTarget
  /** Bumped by ⌘F: switch to Search and put the caret in the field (the web app's own pattern). */
  searchFocusRequest?: number
}

/** A catalog shape as a studio item, so one grid renders all four views. */
const shapeItem = (shape: ShapeCatalogItem): StudioItem => ({
  itemKey: `shape:${shape.id}`,
  provider: 'shape',
  providerId: shape.id,
  kind: 'shape',
  title: shape.title,
  collectionName: 'Shapes',
})

const dedupeItems = (items: StudioItem[]) => [...new Map(items.map((item) => [item.itemKey, item])).values()]

const getErrorMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback)

/**
 * The tile pictures. Keyed `provider:id` — the same key main's 24 h disk cache uses, so the two
 * can never disagree about what a tile is showing. Exported so a test starts with an empty one.
 * Bounded (YAZ-2073 5J): a long browse must not keep every tile it ever showed, and an evicted
 * tile refills from main's disk cache in milliseconds.
 */
const previews = createPreviewCache(async (key) => {
  const [provider, ...rest] = key.split(':')
  const { dataURL } = await api.media.preview({ provider: provider as MediaBytesProvider, id: rest.join(':') })
  return dataURL
}, { limit: 300 })
export const clearPreviewMemo = previews.clear

/** A shape tile's picture: one of six stock outlines, or the engine's own generated path. */
function ShapeTile({ preview }: { preview: ShapePreview }) {
  if (preview.type === 'smart') {
    return (
      <svg viewBox={preview.viewBox} aria-hidden="true">
        {preview.closed ? (
          <polygon className="image-studio__shape-path--closed" points={preview.points} />
        ) : (
          <polyline className="image-studio__shape-path--open" points={preview.points} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    )
  }
  if (preview.shape === 'rectangle') {
    return (
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <rect className="image-studio__shape-path--basic" x="10" y="20" width="80" height="60" rx="12" />
      </svg>
    )
  }
  if (preview.shape === 'ellipse') {
    return (
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <ellipse className="image-studio__shape-path--basic" cx="50" cy="50" rx="40" ry="34" />
      </svg>
    )
  }
  const points =
    preview.shape === 'diamond'
      ? '50,7 93,50 50,93 7,50'
      : preview.shape === 'triangle'
        ? '50,10 90,88 10,88'
        : preview.shape === 'hexagon'
          ? '25,10 75,10 94,50 75,90 25,90 6,50'
          : '50,5 61,36 95,38 68,58 78,91 50,71 22,91 32,58 5,38 39,36'
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <polygon className="image-studio__shape-path--basic" points={points} />
    </svg>
  )
}

export function ImageStudio({ engine, excalidrawAPI, searchFocusRequest = 0 }: ImageStudioProps) {
  const [view, setView] = useState<StudioView>('search')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<MediaSearchSource>('all')
  const [shapeQuery, setShapeQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [results, setResults] = useState<StudioItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [offline, setOffline] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [insertingKey, setInsertingKey] = useState<string | null>(null)
  const [busyFavoriteKey, setBusyFavoriteKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pixabayAvailable, setPixabayAvailable] = useState(true)
  const [favorites, setFavorites] = useState<StoredMediaItem[]>([])
  const [recent, setRecent] = useState<StoredMediaItem[]>([])
  const [smart, setSmart] = useState<SmartShapeApi | null>(null)

  const searchRequestId = useRef(0)
  /** The cursors already asked for this search; a page is never requested twice. */
  const requestedCursors = useRef(new Set<string>())
  /** The same fact as `isSearching`, readable synchronously inside `runSearch`'s own guard. */
  const isSearchingRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchGridRef = useRef<HTMLDivElement>(null)
  const searchSentinelRef = useRef<HTMLDivElement>(null)
  const loadNextPageRef = useRef<() => void>(() => {})


  // The library lists, and the ONE push that keeps them true in every window and every vault.
  useEffect(() => {
    let live = true
    const refresh = () => {
      void api.media.favorites({ op: 'list' }).then((list) => live && setFavorites(list))
      void api.media.recent({ op: 'list' }).then((list) => live && setRecent(list))
    }
    refresh()
    const off = api.media.onChanged(refresh)
    return () => {
      live = false
      off()
    }
  }, [])

  // Whether a key is set, before the first search has said so — so the Pixabay source is never
  // offered to someone who has not entered one (🔒 YAZ-1775 D4: the renderer learns yes/no, never a value).
  useEffect(() => {
    let live = true
    void api.secrets.has({ name: PIXABAY_SECRET }).then(
      (has) => live && setPixabayAvailable(has),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  // The Smart Shapes' package, lazily; the basics are already on screen while it arrives.
  useEffect(() => {
    let live = true
    void loadExcalidrawElement().then(
      (mod) => live && setSmart(mod as unknown as SmartShapeApi),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  // A source that is no longer offered cannot stay selected.
  useEffect(() => {
    if (!pixabayAvailable && source === 'pixabay') setSource('all')
  }, [pixabayAvailable, source])

  const catalog = useMemo(() => buildShapeCatalog(smart), [smart])
  const shapes = useMemo(() => filterShapeCatalog(catalog, shapeQuery).map(shapeItem), [catalog, shapeQuery])
  const favoriteKeys = useMemo(() => new Set(favorites.map(({ itemKey }) => itemKey)), [favorites])

  const displayedItems: StudioItem[] = view === 'shapes' ? shapes : view === 'favorites' ? favorites : view === 'recent' ? recent : results

  useEffect(() => {
    if (searchFocusRequest > 0) setView('search')
  }, [searchFocusRequest])

  useEffect(() => {
    if (searchFocusRequest > 0 && view === 'search') searchInputRef.current?.focus()
  }, [searchFocusRequest, view])

  /**
   * One page. `append` is the infinite scroll's next page and keeps what is on screen; a fresh
   * search clears everything, including the cursors already asked for — which is what stops the
   * observer from re-firing the page it just loaded.
   */
  const runSearch = useCallback(
    async ({
      append = false,
      retry = false,
      nextQuery,
      nextSource,
    }: { append?: boolean; retry?: boolean; nextQuery?: string; nextSource?: MediaSearchSource } = {}) => {
      const askedQuery = nextQuery ?? (append ? searchedQuery : query.trim())
      const askedSource = nextSource ?? source
      if (askedQuery.length < 2) {
        setError('Type at least two characters.')
        return
      }
      const requestedCursor = append ? cursor : null
      if (append && (requestedCursor === null || isSearchingRef.current || (!retry && requestedCursors.current.has(requestedCursor)))) return
      const requestId = append ? searchRequestId.current : ++searchRequestId.current
      isSearchingRef.current = true
      setIsSearching(true)
      if (requestedCursor !== null) {
        requestedCursors.current.add(requestedCursor)
        setPageError(null)
      } else {
        requestedCursors.current.clear()
        setError(null)
        setPageError(null)
        setOffline(false)
        setResults([])
        setCursor(null)
        setWarnings([])
        setSearchedQuery(askedQuery)
      }
      try {
        const response = await api.media.search({ q: askedQuery, source: askedSource, cursor: requestedCursor })
        if (requestId !== searchRequestId.current) return
        setResults((current) => dedupeItems(append ? [...current, ...response.items] : response.items))
        setCursor(response.nextCursor)
        setWarnings(response.warnings)
        setPixabayAvailable(response.pixabayAvailable)
        setOffline(false)
      } catch (cause) {
        if (requestId !== searchRequestId.current) return
        const isOffline = cause instanceof BridgeRequestError && cause.code === 'OFFLINE'
        const message = getErrorMessage(cause, 'Image search failed')
        if (isOffline) setOffline(true)
        if (append) setPageError(isOffline ? OFFLINE_NOTICE : message)
        else if (!isOffline) setError(message)
      } finally {
        if (requestId === searchRequestId.current) {
          isSearchingRef.current = false
          setIsSearching(false)
        }
      }
    },
    [cursor, query, searchedQuery, source],
  )

  useEffect(() => {
    loadNextPageRef.current = () => void runSearch({ append: true })
  }, [runSearch])

  // The infinite scroll: one observer on a sentinel at the end of the grid, re-armed whenever the
  // cursor moves. It is never armed for a cursor already asked for, so a page cannot load twice.
  useEffect(() => {
    const sentinel = searchSentinelRef.current
    if (view !== 'search' || !cursor || pageError || isSearching || requestedCursors.current.has(cursor) || !sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadNextPageRef.current()
      },
      { root: searchGridRef.current, rootMargin: '160px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [cursor, isSearching, pageError, view])

  // Both tiles' buttons are disabled while one is in flight; these re-check the same fact, because
  // a keyboard activation can land in the frame before React has re-rendered them.
  const addItem = async (item: StudioItem) => {
    if (insertingKey !== null) return
    setInsertingKey(item.itemKey)
    setError(null)
    try {
      let recorded = item
      if (item.provider === 'shape') {
        const shape = getShape(catalog, item.providerId)
        if (shape === undefined) throw new Error('That shape is not available yet.')
        insertShape(engine, excalidrawAPI, shape)
      } else {
        const imported = await api.media.import({ provider: item.provider, id: item.providerId })
        await insertImage(excalidrawAPI, fileFromImport(item, imported))
        // Main's item is what the provider says NOW — a fresh size and attribution for the MRU
        // row — layered over the caller's, which knows the pretty collection name a search gave it.
        recorded = { ...item, ...imported.item }
      }
      setRecent(await api.media.recent({ op: 'record', item: recorded }))
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not add item'))
    } finally {
      setInsertingKey(null)
    }
  }

  const toggleFavorite = async (item: StudioItem) => {
    if (busyFavoriteKey !== null) return
    setBusyFavoriteKey(item.itemKey)
    setError(null)
    try {
      setFavorites(favoriteKeys.has(item.itemKey) ? await api.media.favorites({ op: 'remove', itemKey: item.itemKey }) : await api.media.favorites({ op: 'add', item }))
    } catch (cause) {
      setError(getErrorMessage(cause, 'Could not change favorites'))
    } finally {
      setBusyFavoriteKey(null)
    }
  }

  return (
    <div className="image-studio">
      <header className="image-studio__header">
        <div>
          <span>IMAGE STUDIO</span>
          <strong>Add visuals</strong>
        </div>
      </header>
      <nav className="image-studio__nav" aria-label="Image Studio sections">
        {STUDIO_VIEWS.map((tab) => (
          <button type="button" key={tab} className={view === tab ? 'is-active' : undefined} aria-pressed={view === tab} onClick={() => setView(tab)}>
            {VIEW_LABELS[tab]}
          </button>
        ))}
      </nav>

      {view === 'search' && (
        <form
          className="image-studio__search"
          onSubmit={(event) => {
            event.preventDefault()
            void runSearch({})
          }}
        >
          <select
            aria-label="Search source"
            value={source}
            onChange={(event) => {
              const nextSource = event.target.value as MediaSearchSource
              setSource(nextSource)
              if (searchedQuery) void runSearch({ nextQuery: searchedQuery, nextSource })
            }}
          >
            <option value="all">All</option>
            <option value="iconify">Iconify</option>
            {/* 🔒 YAZ-1775 D4: with no key there is no Pixabay to offer, and nothing to explain here. */}
            {pixabayAvailable && <option value="pixabay">Pixabay</option>}
          </select>
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search graphics, icons, and logos"
            placeholder="Search graphics, icons, and logos"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={isSearching}>
            {isSearching ? '…' : 'Search'}
          </button>
        </form>
      )}
      {view === 'shapes' && (
        <div className="image-studio__search">
          <input type="search" aria-label="Search shapes" placeholder="Search shapes" value={shapeQuery} onChange={(event) => setShapeQuery(event.target.value)} />
        </div>
      )}

      {view === 'search' && offline && (
        <div className="image-studio__notice" role="status">
          {OFFLINE_NOTICE}
        </div>
      )}
      {view === 'search' && warnings.length > 0 && <div className="image-studio__warning">{warnings.join(' ')}</div>}
      {error && <div className="image-studio__error">{error}</div>}

      <div className="image-studio__grid" ref={searchGridRef}>
        {displayedItems.map((item) => {
          const catalogShape = item.provider === 'shape' ? getShape(catalog, item.providerId) : undefined
          const favorited = favoriteKeys.has(item.itemKey)
          return (
            <article className="image-studio__card" key={item.itemKey}>
              <button
                type="button"
                className="image-studio__add"
                disabled={insertingKey !== null}
                onClick={() => void addItem(item)}
                aria-label={`Add ${item.title}`}
              >
                <span className="image-studio__preview">
                  {catalogShape ? <ShapeTile preview={catalogShape.preview} /> : <previews.Preview cacheKey={`${item.provider}:${item.providerId}`} placeholderClass="image-studio__placeholder" />}
                  {insertingKey === item.itemKey && <span className="image-studio__adding">Adding…</span>}
                </span>
                <span className="image-studio__meta">
                  <strong>{item.title}</strong>
                  <small>{item.provider === 'shape' ? 'Shape' : `${item.kind}${item.collectionName ? ` · ${item.collectionName}` : ''}`}</small>
                </span>
              </button>
              <button
                type="button"
                className={favorited ? 'image-studio__favorite is-active' : 'image-studio__favorite'}
                aria-label={favorited ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`}
                aria-pressed={favorited}
                disabled={busyFavoriteKey !== null}
                onClick={() => void toggleFavorite(item)}
              >
                {favorited ? '★' : '☆'}
              </button>
            </article>
          )
        })}
        {view === 'search' && cursor && results.length > 0 && <div className="image-studio__search-sentinel" ref={searchSentinelRef} aria-hidden="true" />}
      </div>

      {displayedItems.length === 0 && (
        <div className="image-studio__empty">
          {view === 'search'
            ? searchedQuery === ''
              ? 'Search once, then add anything from the mixed results.'
              : `No graphics match “${searchedQuery}”`
            : view === 'favorites'
              ? 'Star an item and it will stay available in every Excalidraw drawing.'
              : view === 'recent'
                ? 'Items you add will appear here across every Excalidraw drawing.'
                : shapeQuery
                  ? 'No shapes match your search.'
                  : 'No items found.'}
        </div>
      )}
      {view === 'search' && pageError && cursor && (
        <>
          <div className="image-studio__error" role="alert">
            {pageError}
          </div>
          <button type="button" className="image-studio__retry" disabled={isSearching} onClick={() => void runSearch({ append: true, retry: true })}>
            {isSearching ? 'Retrying…' : 'Retry loading results'}
          </button>
        </>
      )}
      {view === 'search' && isSearching && results.length > 0 && (
        <div className="image-studio__loading-more" role="status">
          Loading more…
        </div>
      )}
      <footer className="image-studio__footer">Graphics via Pixabay · icons via Iconify.</footer>
    </div>
  )
}
