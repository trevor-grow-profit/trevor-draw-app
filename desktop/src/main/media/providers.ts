/**
 * THE IMAGE STUDIO'S PROVIDERS, IN THE MAIN PROCESS (🔒 YAZ-1775 D4, YAZ-1818). The half of
 * `worker/imageStudio.ts` that TALKS: the two-phase Iconify walk, the alternating Pixabay pages,
 * the refill pass, and the image proxy that turns a provider's bytes into something a sandboxed
 * renderer can draw. `curation.ts` holds every decision it makes; `cache.ts` holds what it keeps.
 *
 * WHY MAIN AND NOT THE RENDERER (🔒 YAZ-1775 D4): the Pixabay key. It is stored by main and read HERE
 * (`secrets.read`), so it never crosses the bridge, never lands in a devtools console and never
 * reaches a crash dump. The renderer learns exactly one thing about it — `pixabayAvailable` — and
 * when it is false the provider is simply skipped: no error, no empty section, no mention of keys.
 *
 * `fetch` COMES IN AS AN ARGUMENT. Electron's main process has Node's global `fetch`, and
 * production passes it; the tests pass their own, which is why there is not one network call in
 * this module's test file and not one `vi.stubGlobal` either.
 *
 * FAILURE IS TYPED, AND THE TWO KINDS ARE DIFFERENT. A `fetch` that THROWS means the machine
 * never reached the provider → `OFFLINE`, which the Search view renders as a passive "You're
 * offline" while Shapes, Favorites and Recent carry on. A provider that ANSWERS and refuses →
 * `PROVIDER_FAILED`. Bytes that are not an image → `UNSUPPORTED_TYPE` (the Worker's 415); past
 * `MAX_IMPORT_BYTES` → `TOO_LARGE` (its 413), checked on the header AND on what actually arrived,
 * because `Content-Length` is a claim.
 *
 * ONE PROVIDER FAILING IS NOT THE REQUEST FAILING. In `all`, a dead Pixabay still answers with
 * the icons plus a warning, and its cursor is untouched — so the next page retries it from where
 * it was, which is the behaviour the Worker's own test pins. Only when EVERY requested provider
 * failed does the call itself reject.
 */
import type { MediaBytesRequest, MediaImportResponse, MediaPreviewResponse, MediaSearchRequest, MediaSearchResponse, StudioItem } from '@shared/types'
import { BridgeFailure } from '../fs/fsUtils'
import type { MediaCache } from './cache'
import { pixabayItemCacheKey, pixabayPageCacheKey, previewCacheKey, searchCacheKey } from './cachePolicy'
import {
  decodeCursor,
  encodeCursor,
  hasMorePages,
  ICONIFY_COLOR_BATCH_LIMIT,
  iconifyItemFromId,
  iconifyPageExhausted,
  iconifySearchUrl,
  iconifySvgUrl,
  interleaveResults,
  isColorCollection,
  MAX_IMPORT_BYTES,
  nextPixabayType,
  normalizeIconifyResults,
  normalizePixabayResults,
  oppositePixabayType,
  PIXABAY_API,
  PIXABAY_PAGE_SIZE,
  pixabaySearchUrl,
  providerLimits,
  providersFor,
  SEARCH_LIMIT,
  COLOR_COLLECTION_PRIORITY,
  finiteNumber,
  type AnyProviderSearchResult,
  type IconifyCursor,
  type IconifySearchPayload,
  type PixabayCursor,
  type PixabayHit,
  type PixabayImageType,
  type ProviderSearchResult,
  type SearchCursor,
  type SearchProvider,
} from './curation'

/** The identity the Worker sent; providers rate-limit anonymous traffic harder. */
const USER_AGENT = 'Trevor Draw Image Studio'

/** The shortest query the studio will run — the Worker's own floor. */
export const MIN_QUERY_LENGTH = 2
/** And its ceiling; a query longer than this is cut, not refused. */
export const MAX_QUERY_LENGTH = 120

export interface MediaProvidersDeps {
  /** Node's global `fetch` in production; a stub in tests. */
  fetch: typeof globalThis.fetch
  /** `secrets.read(PIXABAY_SECRET)` — null when no key is stored or it cannot be decrypted here. */
  readPixabayKey: () => Promise<string | null>
  cache: MediaCache
}

export interface MediaProviders {
  search(req: MediaSearchRequest): Promise<MediaSearchResponse>
  preview(req: MediaBytesRequest): Promise<MediaPreviewResponse>
  import(req: MediaBytesRequest): Promise<MediaImportResponse>
}

/** What a provider's failure looks like to the search loop: which one, and why. */
type ProviderFailure = { provider: SearchProvider; error: BridgeFailure }

const warningFor = (provider: SearchProvider) => (provider === 'iconify' ? 'Icons are temporarily unavailable.' : 'Pixabay graphics are temporarily unavailable.')

export function createMediaProviders({ fetch, readPixabayKey, cache }: MediaProvidersDeps): MediaProviders {
  /** A request that never got an answer is OFFLINE; one that got a bad answer is the provider's fault. */
  async function request(url: string): Promise<Response> {
    try {
      return await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
    } catch {
      throw new BridgeFailure('OFFLINE', `could not reach ${new URL(url).host}`)
    }
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await request(url)
    if (!response.ok) throw new BridgeFailure('PROVIDER_FAILED', `provider returned ${response.status}`)
    try {
      return (await response.json()) as T
    } catch {
      throw new BridgeFailure('PROVIDER_FAILED', 'provider answered with something that is not JSON')
    }
  }

  /** The Worker's `cachedJsonFetch`: the disk first, the network second, the disk again after. */
  async function cachedJson<T>(key: string, url: string): Promise<T> {
    const hit = await cache.read<T>(key)
    if (hit !== null) return hit
    const payload = await fetchJson<T>(url)
    await cache.write(key, payload)
    return payload
  }

  // ---------- Iconify ----------

  async function fetchIconifyPage(query: string, start: number, limit: number, prefixes?: string[]) {
    const payload = await fetchJson<IconifySearchPayload>(iconifySearchUrl(query, start, limit, prefixes).toString())
    const fetchedCount = payload.icons?.length ?? 0
    return {
      items: normalizeIconifyResults(payload),
      fetchedCount,
      responseLimit: finiteNumber(payload.limit) ?? limit,
      total: finiteNumber(payload.total),
    }
  }

  /**
   * The colour pass, then the general pass with the colour sets filtered out — the reason a query
   * answers with emoji and flat icons before it answers with another wall of Material glyphs.
   * The general pass loops because it may have to skip a whole page of colour icons it already
   * showed; eight requests is the Worker's own ceiling on that.
   */
  async function searchIconify(query: string, currentCursor: IconifyCursor, limit: number): Promise<ProviderSearchResult<'iconify'>> {
    const cursor = { ...currentCursor }
    const items: StudioItem[] = []
    if (!cursor.colorExhausted && limit > 0) {
      const start = cursor.colorStart
      const page = await fetchIconifyPage(query, start, Math.min(ICONIFY_COLOR_BATCH_LIMIT, limit), COLOR_COLLECTION_PRIORITY)
      const returnedItems = page.items.slice(0, limit)
      // A page that yielded nothing usable still consumed what it fetched — otherwise the cursor
      // never advances and the next request asks for the same window again.
      const consumedCount = returnedItems.length > 0 || page.fetchedCount === 0 ? returnedItems.length : page.fetchedCount
      cursor.colorStart += consumedCount
      cursor.colorExhausted = iconifyPageExhausted(start, consumedCount, page)
      items.push(...returnedItems)
    }

    let requests = 0
    while (items.length < limit && !cursor.generalExhausted && requests < 8) {
      const start = cursor.generalStart
      const page = await fetchIconifyPage(query, start, limit - items.length)
      let consumedCount = 0
      for (const item of page.items) {
        consumedCount++
        if (!isColorCollection(item.providerId.split(':')[0])) items.push(item)
        if (items.length === limit) break
      }
      if (consumedCount === 0 && page.fetchedCount > 0) consumedCount = page.fetchedCount
      cursor.generalStart += consumedCount
      cursor.generalExhausted = iconifyPageExhausted(start, consumedCount, page)
      requests++
      if (consumedCount === 0) break
    }

    return { items: items.slice(0, limit), cursor, hasMore: !cursor.colorExhausted || !cursor.generalExhausted }
  }

  // ---------- Pixabay ----------

  async function fetchPixabayPage(query: string, imageType: PixabayImageType, page: number, key: string) {
    const url = pixabaySearchUrl(query, page, imageType, key, PIXABAY_PAGE_SIZE)
    const payload = await cachedJson<{ hits?: PixabayHit[]; totalHits?: number }>(pixabayPageCacheKey(query, imageType, page, PIXABAY_PAGE_SIZE), url.toString())
    const hits = payload.hits ?? []
    const totalHits = finiteNumber(payload.totalHits)
    return { hits, hasMore: totalHits !== undefined ? page * PIXABAY_PAGE_SIZE < totalHits : hits.length === PIXABAY_PAGE_SIZE }
  }

  /**
   * Vector and illustration in turn, four at a time, skipping ids the cursor has already shown —
   * the two streams overlap, and the same graphic appearing twice in one scroll is the bug that
   * `seenIds` exists for.
   */
  async function searchPixabay(query: string, currentCursor: PixabayCursor, limit: number, key: string): Promise<ProviderSearchResult<'pixabay'>> {
    const cursor = { ...currentCursor, seenIds: [...currentCursor.seenIds] }
    const items: StudioItem[] = []
    const seenIds = new Set(cursor.seenIds)
    const maxRequests = Math.ceil(limit / PIXABAY_PAGE_SIZE) + 2
    let requests = 0
    while (items.length + PIXABAY_PAGE_SIZE <= limit && requests < maxRequests) {
      const imageType = nextPixabayType(cursor)
      if (imageType === null) break
      const pageKey = `${imageType}Page` as const
      const exhaustedKey = `${imageType}Exhausted` as const
      const payload = await fetchPixabayPage(query, imageType, cursor[pageKey], key)
      cursor[pageKey]++
      cursor[exhaustedKey] = !payload.hasMore
      cursor.nextType = oppositePixabayType(imageType)
      for (const item of normalizePixabayResults(payload)) {
        if (seenIds.has(item.providerId)) continue
        seenIds.add(item.providerId)
        items.push(item)
      }
      requests++
    }
    cursor.seenIds = [...seenIds]
    return { items, cursor, hasMore: !cursor.vectorExhausted || !cursor.illustrationExhausted }
  }

  // ---------- The federated search ----------

  async function searchUncached(query: string, req: MediaSearchRequest, key: string | null): Promise<MediaSearchResponse> {
    const pixabayAvailable = key !== null
    // A cursor is renderer input. One that does not decode, or was minted for another query, is a
    // bad REQUEST — never a provider failure and never an empty page that silently starts over.
    const cursor = ((): SearchCursor => {
      try {
        return decodeCursor(req.cursor, query, req.source)
      } catch {
        throw new BridgeFailure('BAD_REQUEST', 'invalid search cursor')
      }
    })()
    // No key is not a failure and not a warning: the provider is simply not there (🔒 YAZ-1775 D4). Marking
    // it exhausted keeps `nextCursor` honest — there is no further Pixabay page to ask for.
    if (!pixabayAvailable) {
      cursor.pixabay.vectorExhausted = true
      cursor.pixabay.illustrationExhausted = true
    }
    const providers = providersFor(req.source).filter((provider) => provider !== 'pixabay' || pixabayAvailable)
    const limits = providerLimits(req.source)
    const runProvider = (provider: SearchProvider, limit: number): Promise<AnyProviderSearchResult> =>
      provider === 'iconify' ? searchIconify(query, cursor.iconify, limit) : searchPixabay(query, cursor.pixabay, limit, key as string)

    const resultsByProvider = new Map<SearchProvider, StudioItem[]>()
    const succeeded = new Set<SearchProvider>()
    const failures: ProviderFailure[] = []
    const warnings: string[] = []

    /** Merge a provider's page in, de-duplicated, and advance ITS half of the cursor. */
    const appendResult = (provider: SearchProvider, result: AnyProviderSearchResult) => {
      const current = resultsByProvider.get(provider) ?? []
      const itemKeys = new Set(current.map(({ itemKey }) => itemKey))
      resultsByProvider.set(provider, [
        ...current,
        ...result.items.filter(({ itemKey }) => {
          if (itemKeys.has(itemKey)) return false
          itemKeys.add(itemKey)
          return true
        }),
      ])
      if (provider === 'iconify') cursor.iconify = result.cursor as IconifyCursor
      else cursor.pixabay = result.cursor as PixabayCursor
    }

    /** A provider that answered and failed: one warning, cursor untouched, so the next page retries it. */
    const warn = (provider: SearchProvider, error: BridgeFailure) => {
      if (!failures.some((failure) => failure.provider === provider)) {
        failures.push({ provider, error })
        warnings.push(warningFor(provider))
      }
    }

    const settled = await Promise.allSettled(providers.map((provider) => runProvider(provider, limits[provider])))
    settled.forEach((result, index) => {
      const provider = providers[index]
      if (result.status === 'fulfilled') {
        succeeded.add(provider)
        appendResult(provider, result.value)
      } else {
        warn(provider, asBridgeFailure(result.reason))
      }
    })

    if (providers.length > 0 && succeeded.size === 0) throw failures[0].error

    // The refill: `all` wants eighteen. Whatever the split left short, ask the providers that DID
    // answer for again — which is how one thin provider still fills the page.
    if (req.source === 'all') {
      for (const provider of providers) {
        const resultCount = [...resultsByProvider.values()].reduce((total, items) => total + items.length, 0)
        const remaining = SEARCH_LIMIT - resultCount
        if (remaining <= 0 || !succeeded.has(provider)) continue
        try {
          appendResult(provider, await runProvider(provider, remaining))
        } catch (cause) {
          warn(provider, asBridgeFailure(cause))
        }
      }
    }

    const items =
      req.source === 'all' ? interleaveResults(resultsByProvider.get('iconify') ?? [], resultsByProvider.get('pixabay') ?? []) : (resultsByProvider.get(req.source) ?? [])
    const more = providers.length > 0 && hasMorePages(cursor, req.source)
    return { items, nextCursor: more ? encodeCursor(cursor) : null, pixabayAvailable, warnings }
  }

  // ---------- The bytes ----------

  async function pixabayRecord(id: string, key: string | null): Promise<PixabayHit> {
    if (key === null) throw new BridgeFailure('PROVIDER_FAILED', 'Pixabay needs an API key')
    if (!/^\d+$/.test(id)) throw new BridgeFailure('BAD_REQUEST', "'id' is not a Pixabay id")
    const url = new URL(PIXABAY_API)
    url.searchParams.set('key', key)
    url.searchParams.set('id', id)
    const payload = await cachedJson<{ hits?: PixabayHit[] }>(pixabayItemCacheKey(id), url.toString())
    const hit = payload.hits?.find((candidate) => String(candidate.id) === id)
    if (hit === undefined) throw new BridgeFailure('NOT_FOUND', 'that image is no longer on Pixabay')
    return hit
  }

  /** Where the bytes live: Iconify serves the SVG by name, Pixabay only after its record is read. */
  async function sourceUrl(req: MediaBytesRequest, wantPreview: boolean, key: string | null): Promise<{ url: string; item: StudioItem }> {
    if (req.provider === 'iconify') {
      const url = iconifySvgUrl(req.id)
      const item = iconifyItemFromId(req.id)
      if (url === null || item === null) throw new BridgeFailure('BAD_REQUEST', "'id' is not an Iconify icon")
      return { url, item }
    }
    const record = await pixabayRecord(req.id, key)
    const source = wantPreview ? record.previewURL : (record.vectorURL ?? record.largeImageURL ?? record.webformatURL)
    if (typeof source !== 'string' || !source.startsWith('https://')) throw new BridgeFailure('PROVIDER_FAILED', 'Pixabay gave no usable image URL')
    const [item] = normalizePixabayResults({ hits: [record] })
    if (item === undefined) throw new BridgeFailure('PROVIDER_FAILED', 'Pixabay answered with something that is not a graphic')
    return { url: source, item }
  }

  /** Fetch one picture and hand it back as a dataURL, with the type and size guards 🔒 YAZ-1775 D4 names. */
  async function fetchImage(url: string): Promise<MediaPreviewResponse> {
    const response = await request(url)
    if (!response.ok) throw new BridgeFailure('PROVIDER_FAILED', `provider returned ${response.status}`)
    const mimeType = response.headers.get('Content-Type')?.split(';')[0].trim() ?? ''
    if (!mimeType.startsWith('image/')) throw new BridgeFailure('UNSUPPORTED_TYPE', 'the provider answered with something that is not an image')
    const claimed = Number(response.headers.get('Content-Length') ?? 0)
    if (claimed > MAX_IMPORT_BYTES) throw new BridgeFailure('TOO_LARGE', 'that image is over the 20 MB import limit')
    const bytes = Buffer.from(await response.arrayBuffer())
    // `Content-Length` is a claim, not a fact — the bytes that actually arrived are what count.
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new BridgeFailure('TOO_LARGE', 'that image is over the 20 MB import limit')
    return { mimeType, dataURL: `data:${mimeType};base64,${bytes.toString('base64')}` }
  }

  return {
    async search(req) {
      const query = req.q.trim().slice(0, MAX_QUERY_LENGTH)
      if (query.length < MIN_QUERY_LENGTH) throw new BridgeFailure('BAD_REQUEST', 'enter at least two characters')
      const key = await readPixabayKey()
      const cacheKey = searchCacheKey(query, req.source, req.cursor, key !== null)
      const hit = await cache.read<MediaSearchResponse>(cacheKey)
      if (hit !== null) return hit
      const response = await searchUncached(query, { ...req, q: query }, key)
      // A page that is only half the providers' work is still cached: the cursor it carries names
      // the position the failed provider is still at, so replaying it retries exactly as the live
      // call would have. Which is what makes a second identical search free (🔒 YAZ-1775 D4's 24 h).
      await cache.write(cacheKey, response)
      return response
    },

    async preview(req) {
      const cacheKey = previewCacheKey(req.provider, req.id)
      const hit = await cache.read<MediaPreviewResponse>(cacheKey)
      // The cache first, always: it is what keeps a favorited tile visible with no network and,
      // for Pixabay, with no key (🔒 YAZ-1775 D4's offline half).
      if (hit !== null) return hit
      const { url } = await sourceUrl(req, true, await readPixabayKey())
      const image = await fetchImage(url)
      await cache.write(cacheKey, image)
      return image
    },

    async import(req) {
      // NEVER cached (🔒 YAZ-1775 D4): these bytes are on their way to `assets/`, which content-addresses
      // and de-duplicates them already (🔒 YAZ-1775 D3).
      const { url, item } = await sourceUrl(req, false, await readPixabayKey())
      return { ...(await fetchImage(url)), item }
    },
  }
}

/** Anything a provider call rejected with, as the typed failure the bridge carries. */
function asBridgeFailure(cause: unknown): BridgeFailure {
  if (cause instanceof BridgeFailure) return cause
  return new BridgeFailure('PROVIDER_FAILED', cause instanceof Error ? cause.message : String(cause))
}
