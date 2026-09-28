import { describe, expect, it, vi } from 'vitest'
import { applyToolbarMode, DESKTOP_UI_MODE_STORAGE_KEY, YASEEN_FULL_TOOLBAR_MODE } from './engine'

/** How often each engine module was actually imported (a factory runs once, on the first import). */
const imported = { engine: 0, css: 0 }

/** A stand-in for the engine's localStorage; the real one is jsdom's and shared between tests. */
function fakeStorage(initial: string | null = null) {
  const store = new Map<string, string>()
  if (initial !== null) store.set(DESKTOP_UI_MODE_STORAGE_KEY, initial)
  return {
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
    read: () => store.get(DESKTOP_UI_MODE_STORAGE_KEY) ?? null,
  }
}

describe('applyToolbarMode (⚡ YAZ-1775 R4/R5)', () => {
  it("writes `full` — the fork's ContextualPropertiesToolbar, NOT upstream's compact strip", () => {
    // The names read backwards; demo rounds 3-4 had them inverted. This is the correction.
    const storage = fakeStorage()
    applyToolbarMode(storage)
    expect(storage.read()).toBe(YASEEN_FULL_TOOLBAR_MODE)
    expect(storage.setItem).toHaveBeenCalledWith('excalidraw.desktopUIMode', 'full')
  })

  it('OVERWRITES a stray stored value — the guard this call exists for', () => {
    const storage = fakeStorage('compact')
    applyToolbarMode(storage)
    expect(storage.read()).toBe('full')
  })

  it('does not rewrite a value that is already right', () => {
    const storage = fakeStorage('full')
    applyToolbarMode(storage)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('a storage that is absent or throws is not an error — the engine falls back on its own', () => {
    expect(() => applyToolbarMode(null)).not.toThrow()
    expect(() =>
      applyToolbarMode({
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => undefined,
      }),
    ).not.toThrow()
  })
})

/** A renderer that has loaded nothing yet — a fresh registry and fresh counting stubs, no pins — so no test leans on another's order. */
async function freshEngine(): Promise<typeof import('./engine')> {
  vi.resetModules()
  imported.engine = 0
  imported.css = 0
  vi.doMock('@excalidraw/excalidraw', () => {
    imported.engine++
    return {}
  })
  vi.doMock('@excalidraw/excalidraw/index.css', () => {
    imported.css++
    return {}
  })
  delete window.EXCALIDRAW_ASSET_PATH
  return import('./engine')
}

describe('loadExcalidraw', () => {
  it('pins the fonts offline BEFORE the import, and brings the stylesheet — once, on ONE promise, however many callers', async () => {
    const { loadExcalidraw } = await freshEngine()
    const first = loadExcalidraw()
    expect(window.EXCALIDRAW_ASSET_PATH).toBe(new URL('excalidraw-assets/', window.location.href).toString())
    expect(loadExcalidraw()).toBe(first)
    await first
    await vi.waitFor(() => expect(imported).toEqual({ engine: 1, css: 1 }))
  })
})

describe('warmEngineFor (YAZ-2073 4B)', () => {
  it('loads nothing for a window with no file open or with a draw.io diagram in front', async () => {
    const { warmEngineFor } = await freshEngine()
    warmEngineFor(null)
    warmEngineFor('/vault/flow.drawio')
    await new Promise((r) => setTimeout(r, 0))
    expect(imported).toEqual({ engine: 0, css: 0 })
    expect(window.EXCALIDRAW_ASSET_PATH).toBeUndefined()
  })

  it('starts the engine and its stylesheet for a drawing — on the ONE promise the canvas awaits', async () => {
    const { loadExcalidraw, warmEngineFor } = await freshEngine()
    warmEngineFor('/vault/Board.EXCALIDRAW')
    expect(window.EXCALIDRAW_ASSET_PATH).toBeDefined()
    await loadExcalidraw()
    await vi.waitFor(() => expect(imported).toEqual({ engine: 1, css: 1 }))
  })
})
