/**
 * Image Studio's session (YAZ-1990): the search without React. What is pinned here is what makes
 * it safe to outlive the panel — a page is never asked for twice, and a response that lands after a
 * newer search started (even one started by a later mount) is dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSearchResponse, StudioItem } from '@shared/types'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: { media: { search: vi.fn() } },
}))

import { api, BridgeRequestError } from '../api'
import { imageStudioSession, OFFLINE_NOTICE, resetImageStudioSession, runSearch, scrollTops, wasRequested } from './imageStudioSession'

const search = vi.mocked(api.media.search)
const state = () => imageStudioSession.getState()

const item = (key: string): StudioItem => ({ itemKey: `iconify:${key}`, provider: 'iconify', providerId: key, kind: 'icon', title: key })
const page = (keys: string[], nextCursor: string | null = null): MediaSearchResponse => ({ items: keys.map(item), nextCursor, pixabayAvailable: true, warnings: [] })

/** A search response the test releases by hand, to order two requests' answers. */
function deferred() {
  let resolve: (value: MediaSearchResponse) => void = () => {}
  const promise = new Promise<MediaSearchResponse>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  resetImageStudioSession()
  search.mockReset().mockResolvedValue(page([]))
})

describe('a fresh search', () => {
  it('asks with the trimmed query and the source, and keeps what comes back', async () => {
    imageStudioSession.set({ query: '  mountain ', source: 'iconify' })
    search.mockResolvedValue(page(['a', 'b'], 'PAGE2'))
    await runSearch()
    expect(search).toHaveBeenCalledWith({ q: 'mountain', source: 'iconify', cursor: null })
    expect(state()).toMatchObject({ searchedQuery: 'mountain', cursor: 'PAGE2', isSearching: false })
    expect(state().results.map(({ title }) => title)).toEqual(['a', 'b'])
  })

  it('refuses a one-character query without asking', async () => {
    imageStudioSession.set({ query: 'a' })
    await runSearch()
    expect(search).not.toHaveBeenCalled()
    expect(state().error).toBe('Type at least two characters.')
  })

  it('is a passive offline state, not an error, when no provider can be reached', async () => {
    imageStudioSession.set({ query: 'mountain' })
    search.mockRejectedValue(new BridgeRequestError('OFFLINE', 'no network'))
    await runSearch()
    expect(state()).toMatchObject({ offline: true, error: null, isSearching: false })
  })
})

describe('the next page', () => {
  it('appends without duplicates and is never asked for twice', async () => {
    imageStudioSession.set({ query: 'mountain' })
    search.mockResolvedValueOnce(page(['a'], 'PAGE2')).mockResolvedValue(page(['a', 'b'], 'PAGE2'))
    await runSearch()
    await runSearch({ append: true })
    await runSearch({ append: true })
    expect(search.mock.calls.filter(([req]) => req.cursor === 'PAGE2')).toHaveLength(1)
    expect(wasRequested('PAGE2')).toBe(true)
    expect(state().results.map(({ title }) => title)).toEqual(['a', 'b'])
  })

  it('asks again only when retried, and says so when it fails offline', async () => {
    imageStudioSession.set({ query: 'mountain' })
    search.mockResolvedValueOnce(page(['a'], 'PAGE2')).mockRejectedValueOnce(new BridgeRequestError('OFFLINE', 'no network'))
    await runSearch()
    await runSearch({ append: true })
    expect(state().pageError).toBe(OFFLINE_NOTICE)
    search.mockResolvedValue(page(['b']))
    await runSearch({ append: true, retry: true })
    expect(state()).toMatchObject({ pageError: null, cursor: null })
    expect(state().results.map(({ title }) => title)).toEqual(['a', 'b'])
  })
})

describe('outliving the panel', () => {
  it('drops an older search that answers after a newer one', async () => {
    const slow = deferred()
    search.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(page(['river']))
    imageStudioSession.set({ query: 'mountain' })
    const first = runSearch()
    imageStudioSession.set({ query: 'river' })
    await runSearch()
    slow.resolve(page(['mountain']))
    await first
    expect(state().searchedQuery).toBe('river')
    expect(state().results.map(({ title }) => title)).toEqual(['river'])
    expect(state().isSearching).toBe(false)
  })

  it('a reset forgets everything, including an answer still on its way', async () => {
    const slow = deferred()
    search.mockReturnValueOnce(slow.promise)
    imageStudioSession.set({ query: 'mountain', view: 'favorites' })
    scrollTops.search = 400
    const pending = runSearch()
    resetImageStudioSession()
    slow.resolve(page(['mountain']))
    await pending
    expect(state()).toMatchObject({ view: 'search', query: '', results: [], isSearching: false })
    expect(scrollTops.search).toBe(0)
  })
})
