/**
 * The Images tab (YAZ-1818). The bridge is stubbed at the client `api` seam, like every other test
 * in this repo, and the engine's element package is stubbed at `loadExcalidrawElement` — so what is
 * pinned here is the TAB's behaviour: what it asks main for, what it never asks for (a stored
 * `previewUrl`), what it hides when there is no key, and what still works with no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoredMediaItem, StudioItem } from '@shared/types'

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: {
    media: { favorites: vi.fn(), recent: vi.fn(), onChanged: vi.fn(), search: vi.fn(), preview: vi.fn(), import: vi.fn() },
    secrets: { has: vi.fn(), set: vi.fn() },
  },
}))
vi.mock('../drawings/engine', () => ({ loadExcalidrawElement: vi.fn() }))

import { api, BridgeRequestError } from '../api'
import { loadExcalidrawElement } from '../drawings/engine'
import { clearPreviewMemo, ImageStudio } from './ImageStudio'
import { OFFLINE_NOTICE, resetImageStudioSession } from './imageStudioSession'
import type { InsertEngine, InsertTarget } from './insertShape'
import type { SmartShapeApi } from './shapes'

const media = vi.mocked(api.media)
const secrets = vi.mocked(api.secrets)
const loadElement = vi.mocked(loadExcalidrawElement)


const item = (over: Partial<StudioItem> = {}): StudioItem => ({ itemKey: 'iconify:noto:money-bag', provider: 'iconify', providerId: 'noto:money-bag', kind: 'icon', title: 'money bag', ...over })
const stored = (over: Partial<StoredMediaItem> = {}): StoredMediaItem => ({ ...item(), updatedAt: 1, ...over })

const smart: SmartShapeApi = {
  SMART_SHAPE_DEFINITIONS: [
    { id: 'arrow-right', title: 'Arrow right', kind: 'filled-arrow', width: 200, height: 100, closed: true, roundness: null, defaults: {}, handles: ['shaft'] },
  ] as unknown as SmartShapeApi['SMART_SHAPE_DEFINITIONS'],
  generateSmartShapePoints: () =>
    [
      [0, 0],
      [200, 50],
      [0, 100],
    ] as unknown as ReturnType<SmartShapeApi['generateSmartShapePoints']>,
  createSmartShapeMetadata: (id) => ({ version: 1, id, kind: 'filled-arrow', parameters: {} }),
}

const engine: InsertEngine = {
  convertToExcalidrawElements: ((skeletons: unknown[]) => skeletons.map((s, i) => ({ ...(s as object), id: `new-${i}` }))) as unknown as InsertEngine['convertToExcalidrawElements'],
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY' } as unknown as InsertEngine['CaptureUpdateAction'],
}

function fakeCanvas() {
  const updateScene = vi.fn()
  const insertImages = vi.fn(async () => undefined)
  return {
    updateScene,
    insertImages,
    api: {
      getAppState: () => ({ width: 800, height: 600, zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
      getSceneElementsIncludingDeleted: () => [],
      updateScene,
      insertImages,
    } as unknown as InsertTarget,
  }
}

let root: Root | null = null
let container: HTMLElement | null = null

beforeEach(() => {
  clearPreviewMemo()
  resetImageStudioSession()
  media.favorites.mockReset().mockResolvedValue([])
  media.recent.mockReset().mockResolvedValue([])
  media.onChanged.mockReset().mockReturnValue(() => {})
  media.search.mockReset().mockResolvedValue({ items: [], nextCursor: null, pixabayAvailable: false, warnings: [] })
  media.preview.mockReset().mockResolvedValue({ mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,PREVIEW' })
  media.import.mockReset().mockResolvedValue({ mimeType: 'image/svg+xml', dataURL: `data:image/svg+xml;base64,${btoa('<svg/>')}`, item: item({ width: 48, height: 48 }) })
  secrets.has.mockReset().mockResolvedValue(false)
  loadElement.mockReset().mockResolvedValue(smart as unknown as Awaited<ReturnType<typeof loadExcalidrawElement>>)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

async function mount(props: Partial<Parameters<typeof ImageStudio>[0]> = {}) {
  const canvas = fakeCanvas()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<ImageStudio engine={engine} excalidrawAPI={canvas.api} {...props} />)
  })
  return { canvas, container: container }
}

const byText = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)
const byLabel = (host: HTMLElement, label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const click = async (element: Element | null | undefined) => {
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

async function search(host: HTMLElement, query = 'money bag') {
  const input = byLabel(host, 'Search graphics, icons, and logos') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('the four views', () => {
  it('opens on Search and lists the library on mount', async () => {
    const { container: host } = await mount()
    expect(byText(host, 'Search')?.getAttribute('aria-pressed')).toBe('true')
    expect(media.favorites).toHaveBeenCalledWith({ op: 'list' })
    expect(media.recent).toHaveBeenCalledWith({ op: 'list' })
  })

  it('re-lists both lists on media:changed — a favorite made in another window', async () => {
    let push = () => {}
    media.onChanged.mockImplementation((listener: () => void) => {
      push = listener
      return () => {}
    })
    await mount()
    media.favorites.mockClear()
    media.recent.mockClear()
    await act(async () => push())
    expect(media.favorites).toHaveBeenCalledWith({ op: 'list' })
    expect(media.recent).toHaveBeenCalledWith({ op: 'list' })
  })

  it('shows the shapes at once and grows by the Smart Shapes when the package lands', async () => {
    const { container: host } = await mount()
    await click(byText(host, 'Shapes'))
    expect(host.querySelectorAll('.image-studio__card')).toHaveLength(8)
    expect(byLabel(host, 'Add Rectangle')).not.toBeNull()
    expect(byLabel(host, 'Add Arrow right')).not.toBeNull()
  })

  it('renders Favorites and Recent from the library, not from a search', async () => {
    media.favorites.mockResolvedValue([stored({ itemKey: 'iconify:noto:star', providerId: 'noto:star', title: 'star' })])
    media.recent.mockResolvedValue([stored({ itemKey: 'pixabay:7', provider: 'pixabay', providerId: '7', kind: 'illustration', title: 'Money' })])
    const { container: host } = await mount()
    await click(byText(host, 'Favorites'))
    expect(byLabel(host, 'Add star')).not.toBeNull()
    await click(byText(host, 'Recent'))
    expect(byLabel(host, 'Add Money')).not.toBeNull()
  })
})

describe('previews', () => {
  it('asks media:preview by provider and id, and NEVER uses a stored previewUrl', async () => {
    media.favorites.mockResolvedValue([stored({ previewUrl: '/api/image-studio/preview/iconify/noto%3Amoney-bag' })])
    const { container: host } = await mount()
    await click(byText(host, 'Favorites'))
    await act(async () => undefined)
    expect(media.preview).toHaveBeenCalledWith({ provider: 'iconify', id: 'noto:money-bag' })
    const img = host.querySelector('img')
    expect(img?.getAttribute('src')).toBe('data:image/svg+xml;base64,PREVIEW')
    expect(host.innerHTML).not.toContain('/api/image-studio/preview')
  })

  it('draws a placeholder rather than an error when the preview cannot be had', async () => {
    media.preview.mockRejectedValue(new BridgeRequestError('OFFLINE', 'could not reach api.iconify.design'))
    media.favorites.mockResolvedValue([stored()])
    const { container: host } = await mount()
    await click(byText(host, 'Favorites'))
    await act(async () => undefined)
    expect(host.querySelector('.image-studio__placeholder')).not.toBeNull()
    expect(host.querySelector('.image-studio__error')).toBeNull()
    // And the tile still inserts: a missing picture is not a missing item.
    expect((byLabel(host, 'Add money bag') as HTMLButtonElement).disabled).toBe(false)
  })

  it('asks for one preview once, however often its tile re-mounts', async () => {
    media.favorites.mockResolvedValue([stored()])
    const { container: host } = await mount()
    await click(byText(host, 'Favorites'))
    await act(async () => undefined)
    await click(byText(host, 'Shapes'))
    await click(byText(host, 'Favorites'))
    await act(async () => undefined)
    expect(media.preview).toHaveBeenCalledTimes(1)
  })

  it('keeps at most 300 tile pictures: past that the least recently seen goes, and re-showing it asks again (YAZ-2073 5J)', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => stored({ itemKey: `iconify:set:i${i}`, providerId: `set:i${i}`, title: `icon ${i}` }))
    const reshow = async (host: HTMLElement) => {
      await click(byText(host, 'Shapes'))
      await click(byText(host, 'Favorites'))
      await act(async () => undefined)
    }
    media.favorites.mockResolvedValue(many(301))
    const { container: host } = await mount()
    await click(byText(host, 'Favorites'))
    await act(async () => undefined)
    expect(media.preview).toHaveBeenCalledTimes(301)
    await reshow(host)
    // The first tile's picture was evicted by the 301st: that one tile, and only it, is asked for again.
    expect(media.preview).toHaveBeenCalledTimes(302)
    expect(media.preview).toHaveBeenLastCalledWith({ provider: 'iconify', id: 'set:i0' })
  })
})

describe('searching', () => {
  it('sends the query and the source, and renders what comes back', async () => {
    media.search.mockResolvedValue({ items: [item(), item({ itemKey: 'iconify:noto:coin', providerId: 'noto:coin', title: 'coin' })], nextCursor: null, pixabayAvailable: true, warnings: [] })
    const { container: host } = await mount()
    await search(host)
    expect(media.search).toHaveBeenCalledWith({ q: 'money bag', source: 'all', cursor: null })
    expect(host.querySelectorAll('.image-studio__card')).toHaveLength(2)
  })

  it('refuses a one-character query without calling main', async () => {
    const { container: host } = await mount()
    await search(host, 'a')
    expect(media.search).not.toHaveBeenCalled()
    expect(host.querySelector('.image-studio__error')?.textContent).toContain('at least two characters')
  })

  it('shows a provider warning when one of the two was having a bad day', async () => {
    media.search.mockResolvedValue({ items: [item()], nextCursor: null, pixabayAvailable: true, warnings: ['Pixabay graphics are temporarily unavailable.'] })
    const { container: host } = await mount()
    await search(host)
    expect(host.querySelector('.image-studio__warning')?.textContent).toContain('Pixabay graphics are temporarily unavailable.')
  })

  it('is a passive offline state, not an error, when the machine cannot reach a provider (🔒 YAZ-1775 D4)', async () => {
    media.search.mockRejectedValue(new BridgeRequestError('OFFLINE', 'could not reach api.iconify.design'))
    const { container: host } = await mount()
    await search(host)
    expect(host.querySelector('.image-studio__notice')?.textContent).toBe(OFFLINE_NOTICE)
    expect(host.querySelector('.image-studio__error')).toBeNull()
    // And the other three views are untouched by it.
    await click(byText(host, 'Shapes'))
    expect(byLabel(host, 'Add Rectangle')).not.toBeNull()
  })

  it('shows a real error for a real failure', async () => {
    media.search.mockRejectedValue(new BridgeRequestError('PROVIDER_FAILED', 'provider returned 503'))
    const { container: host } = await mount()
    await search(host)
    expect(host.querySelector('.image-studio__error')?.textContent).toContain('503')
  })

  it('re-runs the search when the source changes', async () => {
    media.search.mockResolvedValue({ items: [item()], nextCursor: null, pixabayAvailable: true, warnings: [] })
    const { container: host } = await mount()
    await search(host)
    const select = byLabel(host, 'Search source') as HTMLSelectElement
    await act(async () => {
      select.value = 'iconify'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(media.search).toHaveBeenLastCalledWith({ q: 'money bag', source: 'iconify', cursor: null })
  })
})

describe('the infinite scroll', () => {
  /** jsdom has a no-op IntersectionObserver (`test-setup.ts`); this one hands back its callback. */
  function captureObserver() {
    const observed: Element[] = []
    let fire: () => void = () => {}
    class Capturing {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {
        fire = () => this.callback([{ isIntersecting: true }])
      }
      observe(element: Element) {
        observed.push(element)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
    const original = globalThis.IntersectionObserver
    ;(globalThis as unknown as Record<string, unknown>).IntersectionObserver = Capturing
    return { observed, fire: () => fire(), restore: () => ((globalThis as unknown as Record<string, unknown>).IntersectionObserver = original) }
  }

  it('watches a sentinel while there is a next page and loads it once', async () => {
    const observer = captureObserver()
    try {
      media.search.mockResolvedValueOnce({ items: [item()], nextCursor: 'PAGE2', pixabayAvailable: false, warnings: [] })
      media.search.mockResolvedValueOnce({ items: [item({ itemKey: 'iconify:noto:coin', providerId: 'noto:coin', title: 'coin' })], nextCursor: null, pixabayAvailable: false, warnings: [] })
      const { container: host } = await mount()
      await search(host)
      expect(host.querySelector('.image-studio__search-sentinel')).not.toBeNull()
      expect(observer.observed).toHaveLength(1)

      await act(async () => observer.fire())
      expect(media.search).toHaveBeenLastCalledWith({ q: 'money bag', source: 'all', cursor: 'PAGE2' })
      expect(host.querySelectorAll('.image-studio__card')).toHaveLength(2)

      // The last page has no cursor, so there is nothing left to watch and nothing more to ask for.
      expect(host.querySelector('.image-studio__search-sentinel')).toBeNull()
      expect(media.search).toHaveBeenCalledTimes(2)
    } finally {
      observer.restore()
    }
  })

  it('never asks for the same cursor twice, however often the sentinel fires', async () => {
    const observer = captureObserver()
    try {
      media.search.mockResolvedValue({ items: [item()], nextCursor: 'PAGE2', pixabayAvailable: false, warnings: [] })
      const { container: host } = await mount()
      await search(host)
      await act(async () => observer.fire())
      await act(async () => observer.fire())
      await act(async () => observer.fire())
      expect(media.search.mock.calls.filter(([req]) => (req as { cursor?: string }).cursor === 'PAGE2')).toHaveLength(1)
    } finally {
      observer.restore()
    }
  })
})

describe('the Pixabay key, which the renderer only ever learns yes or no about (🔒 YAZ-1775 D4)', () => {
  it('does not offer Pixabay as a source when no key is set', async () => {
    const { container: host } = await mount()
    expect([...(byLabel(host, 'Search source') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['all', 'iconify'])
    expect(host.textContent).not.toContain('API key')
  })

  it('offers it once one is', async () => {
    secrets.has.mockResolvedValue(true)
    const { container: host } = await mount()
    expect([...(byLabel(host, 'Search source') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['all', 'iconify', 'pixabay'])
  })

  it('follows the search answer when the key changes under it', async () => {
    secrets.has.mockResolvedValue(true)
    media.search.mockResolvedValue({ items: [], nextCursor: null, pixabayAvailable: false, warnings: [] })
    const { container: host } = await mount()
    await search(host)
    expect([...(byLabel(host, 'Search source') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['all', 'iconify'])
  })
})

describe('inserting', () => {
  it('puts a shape on the canvas with no import and no network', async () => {
    const { canvas, container: host } = await mount()
    await click(byText(host, 'Shapes'))
    await click(byLabel(host, 'Add Rectangle'))
    expect(canvas.updateScene).toHaveBeenCalled()
    expect(media.import).not.toHaveBeenCalled()
    expect(media.recent).toHaveBeenCalledWith({ op: 'record', item: expect.objectContaining({ itemKey: 'shape:rectangle', provider: 'shape' }) })
  })

  it('imports an image, hands it to the engine as a File, and records it with the provider metadata', async () => {
    media.search.mockResolvedValue({ items: [item()], nextCursor: null, pixabayAvailable: false, warnings: [] })
    const { canvas, container: host } = await mount()
    await search(host)
    await click(byLabel(host, 'Add money bag'))

    expect(media.import).toHaveBeenCalledWith({ provider: 'iconify', id: 'noto:money-bag' })
    const [files, , , options] = canvas.insertImages.mock.calls[0] as unknown as [File[], undefined, undefined, { viewportSizing: unknown }]
    expect(files[0].name).toBe('noto-money-bag.svg')
    expect(files[0].type).toBe('image/svg+xml')
    expect(options).toEqual({ viewportSizing: { targetScreenSize: 320, viewportFraction: 0.55 } })
    // Main's item wins where it knows better; the caller's fields survive where it does not.
    expect(media.recent).toHaveBeenCalledWith({ op: 'record', item: expect.objectContaining({ itemKey: 'iconify:noto:money-bag', width: 48, height: 48 }) })
  })

  it('reports a failed import without leaving the tile stuck on Adding…', async () => {
    media.import.mockRejectedValue(new BridgeRequestError('TOO_LARGE', 'that image is over the 20 MB import limit'))
    media.search.mockResolvedValue({ items: [item()], nextCursor: null, pixabayAvailable: false, warnings: [] })
    const { container: host } = await mount()
    await search(host)
    await click(byLabel(host, 'Add money bag'))
    expect(host.querySelector('.image-studio__error')?.textContent).toContain('20 MB')
    expect(host.querySelector('.image-studio__adding')).toBeNull()
  })
})

describe('favorites', () => {
  it('adds the whole item, and removes it by key on a second press', async () => {
    media.search.mockResolvedValue({ items: [item()], nextCursor: null, pixabayAvailable: false, warnings: [] })
    media.favorites.mockResolvedValue([])
    const { container: host } = await mount()
    await search(host)

    media.favorites.mockResolvedValue([stored()])
    await click(byLabel(host, 'Add money bag to favorites'))
    expect(media.favorites).toHaveBeenCalledWith({ op: 'add', item: expect.objectContaining({ itemKey: 'iconify:noto:money-bag' }) })

    media.favorites.mockResolvedValue([])
    await click(byLabel(host, 'Remove money bag from favorites'))
    expect(media.favorites).toHaveBeenCalledWith({ op: 'remove', itemKey: 'iconify:noto:money-bag' })
  })
})

describe('⌘F', () => {
  const field = (host: HTMLElement) => byLabel(host, 'Search graphics, icons, and logos') as HTMLInputElement

  it('switches to Search, focuses the field, and takes the request exactly once', async () => {
    const onSearchFocused = vi.fn()
    const { container: host } = await mount()
    await click(byText(host, 'Shapes'))
    expect(byText(host, 'Shapes')?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      root!.render(<ImageStudio engine={engine} excalidrawAPI={fakeCanvas().api} searchFocusPending onSearchFocused={onSearchFocused} />)
    })
    expect(byText(host, 'Search')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(field(host))
    expect(onSearchFocused).toHaveBeenCalledTimes(1)
  })

  it('arrives with the kept query selected, so typing replaces it (🔒 YAZ-1990 D4)', async () => {
    await search((await mount()).container, 'mountain')
    act(() => root!.unmount())
    container!.remove()
    const { container: host } = await mount({ searchFocusPending: true, onSearchFocused: () => {} })
    expect(field(host).value).toBe('mountain')
    expect([field(host).selectionStart, field(host).selectionEnd]).toEqual([0, 'mountain'.length])
  })

  it('leaves the view and the focus alone when the panel opens any other way', async () => {
    const { container: host } = await mount()
    await click(byText(host, 'Favorites'))
    act(() => root!.unmount())
    container!.remove()
    const reopened = (await mount({ searchFocusPending: false })).container
    expect(byText(reopened, 'Favorites')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(document.body)
  })
})

describe('closing and reopening the panel (🔒 YAZ-1990)', () => {
  /** What the engine does when the panel closes: the tab is unmounted, then mounted fresh on reopen. */
  async function reopen() {
    act(() => root!.unmount())
    container!.remove()
    return (await mount()).container
  }
  const grid = (host: HTMLElement) => host.querySelector<HTMLElement>('.image-studio__grid')!
  const titles = (host: HTMLElement) => [...host.querySelectorAll('.image-studio__meta strong')].map((node) => node.textContent)

  it('comes back with the query, the results and the next page it had', async () => {
    media.search.mockResolvedValue({ items: [item()], nextCursor: 'PAGE2', pixabayAvailable: false, warnings: [] })
    await search((await mount()).container, 'mountain')
    const host = await reopen()
    expect((byLabel(host, 'Search graphics, icons, and logos') as HTMLInputElement).value).toBe('mountain')
    expect(titles(host)).toEqual(['money bag'])
    expect(host.querySelector('.image-studio__search-sentinel')).not.toBeNull()
    expect(media.search).toHaveBeenCalledTimes(1)
  })

  it('comes back on the view it was left on', async () => {
    let host = (await mount()).container
    await click(byText(host, 'Favorites'))
    host = await reopen()
    expect(byText(host, 'Favorites')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('puts each view back at its own scroll offset (🔒 D3)', async () => {
    media.search.mockResolvedValue({ items: [item()], nextCursor: null, pixabayAvailable: false, warnings: [] })
    let host = (await mount()).container
    await search(host)
    await act(async () => {
      grid(host).scrollTop = 480
      grid(host).dispatchEvent(new Event('scroll'))
    })
    await click(byText(host, 'Recent'))
    expect(grid(host).scrollTop).toBe(0)
    await act(async () => {
      grid(host).scrollTop = 120
      grid(host).dispatchEvent(new Event('scroll'))
    })

    host = await reopen()
    expect(grid(host).scrollTop).toBe(120)
    await click(byText(host, 'Search'))
    expect(grid(host).scrollTop).toBe(480)
  })

  it('shows a page that landed while the panel was closed', async () => {
    let release: (value: Awaited<ReturnType<typeof media.search>>) => void = () => {}
    media.search.mockReturnValue(new Promise((resolve) => (release = resolve)))
    const host = (await mount()).container
    await search(host, 'mountain')
    act(() => root!.unmount())
    await act(async () => release({ items: [item()], nextCursor: null, pixabayAvailable: false, warnings: [] }))
    expect(titles(await reopen())).toEqual(['money bag'])
  })

  it('paints the kept favorites at once, then re-lists them', async () => {
    media.favorites.mockResolvedValue([stored()])
    let host = (await mount()).container
    await click(byText(host, 'Favorites'))
    media.favorites.mockReturnValue(new Promise(() => {}))
    host = await reopen()
    expect(titles(host)).toEqual(['money bag'])
    expect(media.favorites).toHaveBeenLastCalledWith({ op: 'list' })
  })
})
