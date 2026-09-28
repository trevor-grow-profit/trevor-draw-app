/**
 * The diagram document's host (YAZ-1802), with draw.io replaced by the one thing the host can see
 * of it: postMessage. The iframe never loads in jsdom, so the test plays draw.io — it posts the
 * protocol's events as that iframe's window from `app://drawio` and reads what the host posts
 * back — and every rule (the handshake order, the baseline, the debounce, echo / reload /
 * conflict, retire) runs through the real `Autosave` and the real host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DRAWIO_ORIGIN } from '@shared/drawio'
import type { DiagramDarkColors, WatchEvent } from '@shared/types'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: { ...actual.api, diagram: { load: vi.fn(), save: vi.fn() }, dialog: { saveImage: vi.fn() } } }
})
vi.mock('../share/liveShare', () => ({ noteBoardSaved: vi.fn() }))
vi.mock('./renderDiagram', () => ({ renderDiagramImage: vi.fn() }))

import { api, BridgeRequestError } from '../api'
import { BOARD_COMMAND_EVENT } from '../drawings/boardCommand'
import { _resetRenameContinuity } from '../lib/renameContinuity'
import { BROKEN_DIAGRAM_DOCUMENT, DrawioEditor } from './DrawioEditor'
import { renderDiagramImage } from './renderDiagram'

const load = vi.mocked(api.diagram.load)
const save = vi.mocked(api.diagram.save)
const saveImage = vi.mocked(api.dialog.saveImage)
const toggleSidebar = vi.fn()
const notice = vi.fn()

const ROOT = '/vault'
const PATH = '/vault/Flow.drawio'
const XML = '<mxfile><diagram id="p" name="Page-1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>'
const EDITED = XML.replace('Page-1', 'Edited')

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
/** Everything the host posted into the iframe, parsed. */
let posted: Array<Record<string, unknown>> = []

function render(darkColors: DiagramDarkColors = 'adapt'): void {
  act(() => root?.render(<DrawioEditor root={ROOT} path={PATH} watch={watch} darkColors={darkColors} onNotice={notice} onToggleSidebar={toggleSidebar} />))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe')

/** Capture what the host posts into the iframe (jsdom never loads it). */
function tapFrame(): void {
  const win = frame()?.contentWindow
  if (!win) throw new Error('no iframe')
  Object.defineProperty(win, 'postMessage', { configurable: true, value: (data: string, origin: string) => posted.push({ ...(JSON.parse(data) as Record<string, unknown>), _origin: origin }) })
}

/** draw.io speaking: a JSON string, from the iframe's window, from the drawio origin (unless told otherwise). */
function drawio(msg: Record<string, unknown>, over: { origin?: string; source?: Window | null } = {}): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg), origin: over.origin ?? DRAWIO_ORIGIN, source: over.source === undefined ? frame()!.contentWindow : over.source }))
  })
}

/** Mount, and walk draw.io through the handshake to a loaded, clean document. */
async function opened(): Promise<void> {
  render()
  await settle()
  tapFrame()
  drawio({ event: 'yaseenReady' })
  drawio({ event: 'configure' })
  drawio({ event: 'init' })
  drawio({ event: 'load', xml: XML })
}

const text = (): string => container.textContent ?? ''

/** App flips `<html data-theme>`; the host reads it back through a MutationObserver. */
async function appTheme(theme: 'light' | 'dark'): Promise<void> {
  document.documentElement.dataset.theme = theme
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  listeners.clear()
  posted = []
  Object.defineProperty(window, 'yaseenDraw', {
    configurable: true,
    writable: true,
    value: {
      window: {
        onFlush: () => () => {},
      },
    },
  })
  load.mockResolvedValue({ path: PATH, xml: XML, mtime: 100, size: XML.length })
  vi.mocked(renderDiagramImage).mockImplementation(async (_xml, format) => (format === 'png' ? 'data:image/png;base64,UE5H' : 'data:image/svg+xml;base64,U1ZH'))
  saveImage.mockResolvedValue({ path: '/Users/y/Desktop/Flow.png' })
  save.mockResolvedValue({ path: PATH, mtime: 200, size: 50 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  delete document.documentElement.dataset.theme
  _resetRenameContinuity()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('opening', () => {
  it('a file main refuses is the error pane with its reason — and draw.io is never mounted on it', async () => {
    load.mockRejectedValue(new BridgeRequestError('IO_ERROR', 'the file is empty'))
    render()
    await settle()
    expect(text()).toContain(`${BROKEN_DIAGRAM_DOCUMENT}: the file is empty.`)
    expect(frame()).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('mounts draw.io on its own origin with the app theme and the offline flags', async () => {
    render()
    await settle()
    const src = new URL(frame()!.src)
    expect(`${src.protocol}//${src.host}`).toBe(DRAWIO_ORIGIN)
    expect(src.searchParams.get('offline')).toBe('1')
    expect(src.searchParams.get('configure')).toBe('1')
  })
})

describe('the handshake (drawioProtocol.ts)', () => {
  it('configures only once our PostConfig said it is ready, then loads the XML with autosave on', async () => {
    render()
    await settle()
    tapFrame()
    drawio({ event: 'configure' })
    expect(posted).toEqual([])
    drawio({ event: 'yaseenReady' })
    expect(posted[0]).toMatchObject({ action: 'configure', _origin: DRAWIO_ORIGIN })
    expect((posted[0].config as Record<string, unknown>).compressXml).toBe(false)
    drawio({ event: 'init' })
    expect(posted[1]).toMatchObject({ action: 'load', xml: XML, autosave: 1, title: 'Flow' })
  })

  it('configures anyway after a while when the overlay never answers — the document must still open', async () => {
    render()
    await settle()
    tapFrame()
    drawio({ event: 'configure' })
    await act(async () => {
      vi.advanceTimersByTime(3100)
    })
    expect(posted[0]).toMatchObject({ action: 'configure' })
  })

  it('ignores the same events from another window or another origin', async () => {
    render()
    await settle()
    tapFrame()
    drawio({ event: 'yaseenReady' }, { origin: 'https://app.diagrams.net' })
    drawio({ event: 'configure' }, { source: window })
    drawio({ event: 'yaseenReady' })
    expect(posted).toEqual([])
  })

  it('⌘B pressed inside draw.io with nothing selected arrives as its `shortcut` event and toggles the app sidebar — from THAT frame only', async () => {
    await opened()
    drawio({ event: 'shortcut', command: 'toggleSidebar' }, { source: window })
    drawio({ event: 'shortcut', command: 'closeTab' })
    expect(toggleSidebar).not.toHaveBeenCalled()
    drawio({ event: 'shortcut', command: 'toggleSidebar' })
    expect(toggleSidebar).toHaveBeenCalledOnce()
  })
})

describe('the theme (🔒 YAZ-1802 D12)', () => {
  it('a flip is draw.io’s own darkMode / lightMode action — the frame is never reloaded', async () => {
    await opened()
    const src = frame()!.src
    await appTheme('dark')
    expect(posted.at(-1)).toEqual({ action: 'invokeAction', actionName: 'darkMode', _origin: DRAWIO_ORIGIN })
    await appTheme('light')
    expect(posted.at(-1)).toMatchObject({ action: 'invokeAction', actionName: 'lightMode' })
    expect(frame()!.src).toBe(src)
  })

  it('a flip before draw.io listens is sent the moment it does, ahead of the document', async () => {
    render()
    await settle()
    tapFrame()
    drawio({ event: 'yaseenReady' })
    drawio({ event: 'configure' })
    await appTheme('dark')
    expect(posted.map((m) => m.action)).toEqual(['configure'])
    drawio({ event: 'init' })
    expect(posted.map((m) => m.action)).toEqual(['configure', 'invokeAction', 'load'])
    expect(posted[1]).toMatchObject({ actionName: 'darkMode' })
  })
})

describe('the dark-mode colour setting (🔒 YAZ-1802 D16)', () => {
  it('rides the configure reply as draw.io’s defaultAdaptiveColors', async () => {
    render('keep')
    await settle()
    tapFrame()
    drawio({ event: 'yaseenReady' })
    drawio({ event: 'configure' })
    expect((posted[0].config as Record<string, unknown>).defaultAdaptiveColors).toBe('none')
  })

  it('a change is ONE message to our PostConfig — no reload, nothing saved', async () => {
    await opened()
    const src = frame()!.src
    posted = []
    render('keep')
    await settle()
    expect(posted).toEqual([{ action: 'yaseenAdaptiveColors', value: 'none', _origin: DRAWIO_ORIGIN }])
    render('keep')
    await settle()
    expect(posted).toHaveLength(1)
    expect(frame()!.src).toBe(src)
    expect(save).not.toHaveBeenCalled()
  })

  it('a change before draw.io listens is sent the moment it does', async () => {
    render()
    await settle()
    tapFrame()
    drawio({ event: 'yaseenReady' })
    drawio({ event: 'configure' })
    render('keep')
    await settle()
    expect(posted.map((m) => m.action)).toEqual(['configure'])
    drawio({ event: 'init' })
    expect(posted.map((m) => m.action)).toEqual(['configure', 'yaseenAdaptiveColors', 'load'])
  })
})

describe('File › Export Image… (🔒 YAZ-1802 D9)', () => {
  const exportImage = async (): Promise<void> => {
    container.querySelector('.editor--diagram')!.dispatchEvent(new CustomEvent(BOARD_COMMAND_EVENT, { detail: { kind: 'export-image' } }))
    await settle()
    await settle()
  }

  it('draws what is on screen — unsaved edits too — as PNG and SVG, and main’s sheet writes the one picked', async () => {
    await opened()
    drawio({ event: 'autosave', xml: EDITED })
    await exportImage()
    expect(vi.mocked(renderDiagramImage).mock.calls).toEqual([
      [EDITED, 'png'],
      [EDITED, 'svg'],
    ])
    expect(saveImage).toHaveBeenCalledExactlyOnceWith({ defaultName: 'Flow.png', png: 'data:image/png;base64,UE5H', svg: 'data:image/svg+xml;base64,U1ZH' })
    expect(notice).toHaveBeenCalledWith('Exported to Flow.png')
    expect(save).not.toHaveBeenCalled()
  })

  it('an empty diagram says so and opens no sheet; a failure says why', async () => {
    await opened()
    vi.mocked(renderDiagramImage).mockResolvedValue('')
    await exportImage()
    expect(saveImage).not.toHaveBeenCalled()
    expect(notice).toHaveBeenLastCalledWith('This draw.io diagram is empty, so there is no image to export.')
    vi.mocked(renderDiagramImage).mockRejectedValue(new Error('timed out'))
    await exportImage()
    expect(notice).toHaveBeenLastCalledWith("The draw.io diagram couldn't be exported.", 'error')
  })

})

describe('saving', () => {
  it('opening and not touching writes nothing; an edit saves the latest XML 500 ms later under the loaded mtime', async () => {
    await opened()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(save).not.toHaveBeenCalled()
    drawio({ event: 'autosave', xml: EDITED })
    expect(text()).toContain('Unsaved')
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    await settle()
    expect(save).toHaveBeenCalledExactlyOnceWith({ root: ROOT, path: PATH, xml: EDITED, expectedMtime: 100 })
    expect(text()).toContain('Saved')
  })

  it('⌘S (draw.io’s own save event) writes at once', async () => {
    await opened()
    drawio({ event: 'save', xml: EDITED })
    await settle()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ xml: EDITED }))
  })

})

describe('changes on disk', () => {
  it('a CLEAN tab reloads the disk into draw.io; its answer is the new baseline, not an edit', async () => {
    await opened()
    load.mockResolvedValue({ path: PATH, xml: EDITED, mtime: 300, size: 1 })
    watcherSaw({ type: 'change', path: PATH, mtime: 300 })
    await settle()
    expect(posted.at(-1)).toMatchObject({ action: 'load', xml: EDITED })
    drawio({ event: 'load', xml: EDITED })
    drawio({ event: 'autosave', xml: `${EDITED} ` })
    await act(async () => {
      vi.advanceTimersByTime(600)
    })
    await settle()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedMtime: 300 }))
  })

})
