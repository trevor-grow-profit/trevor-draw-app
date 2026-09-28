/**
 * The drawing document's chrome, with the ENGINE replaced by a stub (🔒 YAZ-1810).
 *
 * `ExcalidrawSurface` is mocked, which is the point: the seam says the host knows nothing about
 * `@excalidraw/excalidraw` beyond a version number, a `serialize()` thunk and two imperative
 * calls, and a test that can drive all of this without the package is that claim, proven. The
 * stub exposes the surface's three outward moves — emit a snapshot, hand over the API, fail —
 * so every rule below (baseline, debounce, conflict, reload, flush, retire) is exercised through
 * the real `Autosave` and the real host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_CANVAS_PREFS, type DrawingLoadResponse, type GithubSyncStatus } from '@shared/types'
import type { WatchEvent } from '@shared/types'
import type { DrawingFileData } from '@shared/drawingAssets'
import type { DrawingSnapshot, DrawingSurfaceApi, DrawingSurfaceProps } from './ExcalidrawSurface'
import { requestBoardCommand, type BoardCommand } from './boardCommand'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: { ...actual.api, drawing: { load: vi.fn(), save: vi.fn() }, dialog: { saveDrawing: vi.fn() } } }
})

/** The engine stub: records what it was given and hands the host the two callbacks it owns. */
const surface = {
  props: null as DrawingSurfaceProps | null,
  emit: null as ((snapshot: DrawingSnapshot) => void) | null,
  fail: null as ((message: string) => void) | null,
  /** What `replaceScene` will report as the engine's settled version. */
  nextReplaceVersion: 0,
  replaced: [] as unknown[],
  refreshes: 0,
  /** How many times the tab-reveal handoff (🔒 YAZ-1812) put the keyboard in this canvas. */
  focuses: 0,
  /** What the application menu's three canvas items (🔒 YAZ-1775 D10 / 🔒 YAZ-1775 D3) reached this canvas as. */
  commands: [] as BoardCommand[],
  /** What `exportScene()` answers — the standalone bytes the save sheet is offered (🔒 YAZ-1775 D3). */
  exportedScene: '{"type":"excalidraw","elements":[],"files":{}}\n',
}

vi.mock('./ExcalidrawSurface', async (importOriginal) => ({
  // The real constant, so a change to the seam's message cannot slip past this suite.
  ENGINE_LOAD_FAILED: ((await importOriginal()) as { ENGINE_LOAD_FAILED: string }).ENGINE_LOAD_FAILED,
  ExcalidrawSurface: (props: DrawingSurfaceProps) => {
    surface.props = props
    surface.emit = props.onSnapshot
    surface.fail = props.onFailed
    props.onApi?.({
      refresh: () => {
        surface.refreshes += 1
      },
      focus: () => {
        surface.focuses += 1
      },
      replaceScene: (scene) => {
        surface.replaced.push(scene)
        return surface.nextReplaceVersion
      },
      openImageExport: () => {
        surface.commands.push({ kind: 'export-image' })
      },
      setCanvasBackground: (color) => {
        surface.commands.push({ kind: 'canvas-background', color })
      },
      exportScene: () => {
        surface.commands.push({ kind: 'export-drawing' })
        return surface.exportedScene
      },
    } satisfies DrawingSurfaceApi)
    // The real engine renders this into its own top-right row; the stub just puts it on screen,
    // because WHERE the chips go is the surface's business and WHAT they say is the host's.
    return <div data-testid="surface">{props.renderTopRight?.()}</div>
  },
}))

import { api } from '../api'
import { _resetRenameContinuity } from '../lib/renameContinuity'
import { BROKEN_DRAWING_DOCUMENT, DrawingEditor } from './DrawingEditor'

const load = vi.mocked(api.drawing.load)
const save = vi.mocked(api.drawing.save)
const saveDrawing = vi.mocked(api.dialog.saveDrawing)

const ROOT = '/vault'
const PATH = '/vault/Board.excalidraw'

function scene(elements: unknown[] = []): string {
  return `${JSON.stringify({ type: 'excalidraw', version: 2, elements, appState: {}, files: {} })}\n`
}

function loaded(over: Partial<DrawingLoadResponse> = {}): DrawingLoadResponse {
  return { path: PATH, json: scene(), mtime: 100, size: 42, files: {}, stored: [], ...over }
}

/** The window's watcher, driven by hand. */
const listeners = new Set<(ev: WatchEvent) => void>()
const watch = {
  subscribe: (listener: (ev: WatchEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
function watcherSaw(ev: WatchEvent): void {
  act(() => listeners.forEach((l) => l(ev)))
}


let root: Root | null = null
let container: HTMLElement

function render(props: Partial<Parameters<typeof DrawingEditor>[0]> = {}): void {
  act(() => root?.render(<DrawingEditor root={ROOT} path={PATH} watch={watch} {...props} />))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Emit a snapshot whose `serialize()` answers `json` and, optionally, live engine files. */
function emit(version: number, json = scene([{ id: 'a' }]), files: Record<string, DrawingFileData> = {}, referenced = new Set(Object.keys(files))): void {
  act(() => surface.emit?.({ version, serialize: () => ({ json, files, referenced }) }))
}

const chips = (): string => container.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  listeners.clear()
  surface.props = null
  surface.emit = null
  surface.fail = null
  surface.replaced = []
  surface.refreshes = 0
  surface.focuses = 0
  surface.nextReplaceVersion = 0
  surface.commands = []
  Object.defineProperty(window, 'yaseenDraw', {
    configurable: true,
    writable: true,
    value: {
      window: {
        onFlush: () => () => {},
      },
    },
  })
  load.mockResolvedValue(loaded())
  save.mockResolvedValue({ path: PATH, mtime: 200, size: 50, persisted: [] })
  saveDrawing.mockReset().mockResolvedValue({ cancelled: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  _resetRenameContinuity()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('opening', () => {
  it('reads through drawing:load and opens the canvas on the scene it answered', async () => {
    load.mockResolvedValue(loaded({ json: scene([{ id: 'x', type: 'rectangle' }]) }))
    render()
    await flush()
    expect(load).toHaveBeenCalledWith({ root: ROOT, path: PATH })
    expect(surface.props?.scene.elements).toEqual([{ id: 'x', type: 'rectangle' }])
  })

  it('hands the images from the store to the engine in its own shape, keyed by id', async () => {
    load.mockResolvedValue(loaded({ files: { abc: { mimeType: 'image/png', dataURL: 'data:image/png;base64,aGk=' } }, stored: ['abc'] }))
    render()
    await flush()
    expect(surface.props?.scene.files).toMatchObject({ abc: { id: 'abc', mimeType: 'image/png', dataURL: 'data:image/png;base64,aGk=' } })
  })

  it('shows ONE readable message — never a blank pane — for a load failure and for bytes that are not a scene', async () => {
    load.mockRejectedValue(new Error('nope'))
    render()
    await flush()
    expect(chips()).toContain(BROKEN_DRAWING_DOCUMENT)

    load.mockResolvedValue(loaded({ json: '' }))
    render({ path: '/vault/Corrupt.excalidraw' })
    await flush()
    expect(chips()).toContain(BROKEN_DRAWING_DOCUMENT)
    expect(container.querySelector('[data-testid="surface"]')).toBeNull()
  })

  it('shows the engine`s own failure when the package will not load', async () => {
    render()
    await flush()
    act(() => surface.fail?.("Can't open the Excalidraw editor."))
    expect(chips()).toContain("Can't open the Excalidraw editor.")
  })
})

describe('autosave', () => {
  it('treats the FIRST snapshot as the clean baseline and never writes it back', async () => {
    render()
    await flush()
    emit(7)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(save).not.toHaveBeenCalled()
    expect(chips()).toContain('Saved')
  })

  it('debounces a change by 500 ms, serialises ONCE when the timer fires, and guards on the load mtime', async () => {
    render()
    await flush()
    emit(7)
    const serialize = vi.fn(() => ({ json: scene([{ id: 'b' }]), files: {}, referenced: new Set<string>() }))
    act(() => surface.emit?.({ version: 8, serialize }))
    expect(chips()).toContain('Unsaved')
    act(() => surface.emit?.({ version: 9, serialize }))
    expect(save).not.toHaveBeenCalled()
    // The version moved twice; the scene is serialised once, when the save actually runs.
    expect(serialize).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(serialize).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ root: ROOT, path: PATH, json: scene([{ id: 'b' }]), expectedMtime: 100, newFiles: [] })
    expect(chips()).toContain('Saved')
  })

  it('⌘S flushes immediately, without waiting for the debounce', async () => {
    render()
    await flush()
    emit(1)
    emit(2)
    await act(async () => {
      container.querySelector('.drawing-editor')?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
      await Promise.resolve()
    })
    expect(save).toHaveBeenCalledTimes(1)
  })

})

describe('external changes', () => {
  it('RELOADS a clean tab from disk and does not write the reloaded bytes back', async () => {
    render()
    await flush()
    emit(5)
    load.mockResolvedValue(loaded({ json: scene([{ id: 'fromDisk' }]), mtime: 400 }))
    surface.nextReplaceVersion = 11
    watcherSaw({ type: 'change', path: PATH, mtime: 400 })
    await flush()
    expect(surface.replaced).toHaveLength(1)
    expect((surface.replaced[0] as { elements: unknown[] }).elements).toEqual([{ id: 'fromDisk' }])
    // The engine answers `updateScene` with its own onChange; that snapshot is the new BASELINE.
    emit(11)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(save).not.toHaveBeenCalled()
    expect(chips()).toContain('Saved')
  })

  it('an edit straight after a reload is guarded by the reloaded mtime, not the one before it (YAZ-2073 2F)', async () => {
    render()
    await flush()
    emit(5)
    load.mockResolvedValue(loaded({ mtime: 400 }))
    surface.nextReplaceVersion = 11
    watcherSaw({ type: 'change', path: PATH, mtime: 400 })
    await flush()
    emit(11) // the engine's answer to the reload: the baseline
    emit(12) // the user's first stroke
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedMtime: 400 }))
    expect(chips()).not.toContain('File changed on disk.')
  })

  it('takes whatever version the engine settled on after a reload, even if it is not the one replaceScene predicted', async () => {
    render()
    await flush()
    emit(5)
    load.mockResolvedValue(loaded({ mtime: 400 }))
    surface.nextReplaceVersion = 11
    watcherSaw({ type: 'change', path: PATH, mtime: 400 })
    await flush()
    emit(12) // the engine disagreed; it is still the baseline, not an edit
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(save).not.toHaveBeenCalled()
  })

})

describe('🔒 YAZ-1775 D3 — which image bytes a save ships', () => {
  const png = (payload: string): DrawingFileData => ({ mimeType: 'image/png', dataURL: `data:image/png;base64,${payload}` })

  it('ships only the files the store lacks, and never ships one twice', async () => {
    load.mockResolvedValue(loaded({ files: { old: png('bw==') }, stored: ['old'] }))
    render()
    await flush()
    emit(1)
    save.mockResolvedValue({ path: PATH, mtime: 200, size: 50, persisted: ['fresh'] })
    emit(2, scene([{ type: 'image', fileId: 'old' }, { type: 'image', fileId: 'fresh' }]), { old: png('bw=='), fresh: png('Zg==') }, new Set(['old', 'fresh']))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    // `old` came back from load as already stored; only `fresh` travels.
    expect(save.mock.calls[0][0].newFiles).toEqual([{ fileId: 'fresh', ...png('Zg==') }])

    // A later save in the same session must not ship `fresh` again: the receipt added it.
    emit(3, scene([{ type: 'image', fileId: 'fresh' }]), { old: png('bw=='), fresh: png('Zg==') }, new Set(['old', 'fresh']))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(save.mock.calls[1][0].newFiles).toEqual([])
  })

  it('never ships a pasted-then-deleted image: only what the scene still references', async () => {
    render()
    await flush()
    emit(1)
    emit(2, scene(), { dropped: png('ZA==') }, new Set())
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(save.mock.calls[0][0].newFiles).toEqual([])
  })

  it('a LEGACY embedded board comes back as not-stored, so its first save ships the bytes out', async () => {
    load.mockResolvedValue(loaded({ json: scene([{ type: 'image', fileId: 'emb' }]), files: { emb: png('ZQ==') }, stored: [] }))
    render()
    await flush()
    emit(1)
    emit(2, scene([{ type: 'image', fileId: 'emb' }]), { emb: png('ZQ==') }, new Set(['emb']))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(save.mock.calls[0][0].newFiles).toEqual([{ fileId: 'emb', ...png('ZQ==') }])
  })

  it('a reload resets the persisted set to what the disk now holds', async () => {
    render()
    await flush()
    emit(1)
    load.mockResolvedValue(loaded({ json: scene([{ type: 'image', fileId: 'disk' }]), files: { disk: png('ZA==') }, stored: ['disk'], mtime: 400 }))
    watcherSaw({ type: 'change', path: PATH, mtime: 400 })
    await flush()
    emit(0) // the engine's post-reload snapshot lands as the baseline
    emit(9, scene([{ type: 'image', fileId: 'disk' }]), { disk: png('ZA==') }, new Set(['disk']))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(save.mock.calls[0][0].newFiles).toEqual([])
  })
})

describe('chips and the canvas frame', () => {
  it('renders the save chip — and the sync chip only when the vault has one — into the engine`s top-right slot', async () => {
    render()
    await flush()
    expect(chips()).toContain('Saved')

    const sync: GithubSyncStatus = { state: 'pending', enabled: true } as GithubSyncStatus
    render({ sync, onSyncNow: vi.fn() })
    await flush()
    expect(chips()).toContain('Pending')
  })

  // YAZ-2073 5D: the chips read a store, so a save's status moves (unsaved → saving → saved) repaint
  // the chips alone — the host never re-renders the surface — and a sync change keeps the top-right
  // renderer's identity, which the surface hands straight to the memoized `<Excalidraw>`.
  it('a save and a sync change repaint the chips without a new top-right renderer', async () => {
    const onSyncNow = vi.fn()
    render({ sync: { state: 'pending', enabled: true } as GithubSyncStatus, onSyncNow })
    await flush()
    emit(7)
    const props = surface.props
    emit(8)
    expect(chips()).toContain('Unsaved')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(chips()).toContain('Saved')
    expect(surface.props).toBe(props)

    render({ sync: { state: 'synced', enabled: true } as GithubSyncStatus, onSyncNow })
    expect(chips()).not.toContain('Pending')
    expect(surface.props?.renderTopRight).toBe(props?.renderTopRight)
  })

  /**
   * The reveal effect: one `IntersectionObserver`, two jobs — re-measure, and the gated focus
   * handoff (🔒 "Focus handoff on tab reveal", YAZ-1812).
   */
  describe('the tab becoming visible again', () => {
    /** Run the body with a stubbed observer, and hand back the "this tab is now visible" trigger. */
    const withObserver = async (body: (reveal: () => void) => Promise<void> | void) => {
      const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
      const original = globalThis.IntersectionObserver
      class Spy {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          observers.push(cb)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return []
        }
      }
      globalThis.IntersectionObserver = Spy as unknown as typeof IntersectionObserver
      try {
        await body(() => act(() => observers.forEach((cb) => cb([{ isIntersecting: true }]))))
      } finally {
        globalThis.IntersectionObserver = original
      }
    }

    it('re-measures the canvas', async () => {
      await withObserver(async (reveal) => {
        render()
        await flush()
        reveal()
        expect(surface.refreshes).toBe(1)
      })
    })

  })

  it('claims the application menu`s three canvas commands on its own section (🔒 YAZ-1775 D10, 🔒 YAZ-1775 D3)', async () => {
    // The container IS this tab's workspace layer, which is what `requestBoardCommand` selects.
    container.className = 'tabstack__layer'
    render()
    await flush()

    expect(requestBoardCommand({ kind: 'export-image' }, document.body)).toBe(true)
    expect(requestBoardCommand({ kind: 'canvas-background', color: '#fffce8' }, document.body)).toBe(true)
    expect(requestBoardCommand({ kind: 'export-drawing' }, document.body)).toBe(true)
    await flush()
    expect(surface.commands).toEqual([{ kind: 'export-image' }, { kind: 'canvas-background', color: '#fffce8' }, { kind: 'export-drawing' }])
  })

  it('Export Drawing… offers the canvas`s standalone bytes under the BOARD`s name (🔒 YAZ-1775 D3, YAZ-1821)', async () => {
    container.className = 'tabstack__layer'
    const onNotice = vi.fn()
    render({ onNotice })
    await flush()
    saveDrawing.mockResolvedValue({ path: '/Users/x/Desktop/Board.excalidraw' })

    requestBoardCommand({ kind: 'export-drawing' }, document.body)
    await flush()
    expect(saveDrawing).toHaveBeenCalledExactlyOnceWith({ defaultName: 'Board.excalidraw', content: surface.exportedScene })
    expect(onNotice).toHaveBeenCalledWith('Exported to Board.excalidraw')
    // 🔒 YAZ-1775 D3: the VAULT file is not touched — no save, no flush, nothing read back.
    expect(save).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('hands the surface the shell`s canvas prefs to seed the scene with (🔒 YAZ-1775 D9)', async () => {
    render({ canvasPrefs: { ...DEFAULT_CANVAS_PREFS, gridModeEnabled: true } })
    await flush()
    expect(surface.props?.canvasPrefs).toEqual({ ...DEFAULT_CANVAS_PREFS, gridModeEnabled: true })
  })
})
