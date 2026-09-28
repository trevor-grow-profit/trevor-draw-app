/**
 * A board's hover picture (YAZ-1800): the key, and the draw behind it — the engine and the bridge
 * stubbed, so this pins what they are ASKED for and what an empty board answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileNode } from '@shared/treeSort'

const engine = vi.hoisted(() => ({
  restoreElements: vi.fn((elements: unknown) => elements),
  exportToBlob: vi.fn(async () => new Blob([new Uint8Array(8)], { type: 'image/png' })),
}))
vi.mock('../drawings/engine', () => ({ loadExcalidraw: async () => engine }))
const renderDiagramPreview = vi.hoisted(() => vi.fn(async () => 'data:image/svg+xml;base64,PHN2Zy8+'))
vi.mock('../diagrams/renderDiagram', () => ({ renderDiagramPreview }))

const { BOARD_PREVIEW_BOUNDS, boardPreviewKey, boardPreviews } = await import('./boardPreviewCache')

const board = (over: Partial<FileNode> = {}): FileNode => ({ type: 'file', name: 'a.excalidraw', path: '/v/a:b.excalidraw', size: 1, mtime: 5, kind: 'drawing', ...over })

function installLoad(json: string, files: Record<string, { mimeType: string; dataURL: string }> = {}) {
  const load = vi.fn(async (req: { root: string; path: string; imageMaxPx?: number }) => ({ path: req.path, json, mtime: 1, size: 1, files, stored: [] }))
  Object.defineProperty(window, 'yaseenDraw', { value: { drawing: { load } }, configurable: true, writable: true })
  return load
}

afterEach(() => {
  boardPreviews.clear()
  engine.exportToBlob.mockClear()
  renderDiagramPreview.mockClear()
})

describe('boardPreviewKey', () => {
  it('is root, path, mtime, theme and the dark-mode colour setting — newline-joined, so a `:` in the path is fine', () => {
    expect(boardPreviewKey('/v', board(), 'dark', 'adapt')).toBe('/v\n/v/a:b.excalidraw\n5\ndark\nadapt')
  })

  it('moves with the mtime, not the block: a write that leaves updatedAt alone is still a new picture (🔒 D1 amendment)', () => {
    const meta = { createdAt: 1, updatedAt: 9 }
    expect(boardPreviewKey('/v', board({ meta, mtime: 5 }), 'light', 'adapt')).not.toBe(boardPreviewKey('/v', board({ meta, mtime: 6 }), 'light', 'adapt'))
  })

  it('moves with the dark-mode colour setting, so a toggle redraws the diagram previews (🔒 YAZ-1802 D16)', () => {
    expect(boardPreviewKey('/v', board(), 'dark', 'adapt')).not.toBe(boardPreviewKey('/v', board(), 'dark', 'keep'))
  })
})

describe('boardPreviews', () => {
  it('reads the board, draws it in the key`s theme and the board bounds, with its images', async () => {
    const load = installLoad(JSON.stringify({ elements: [{ id: 'r' }], appState: { viewBackgroundColor: '#fafafa' } }), { img: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' } })
    const dataURL = await boardPreviews.load(boardPreviewKey('/v', board(), 'dark', 'adapt'))
    expect(dataURL?.startsWith('data:image/png;base64,')).toBe(true)
    // A picture's load: images no bigger than they can appear in it, made in main (🔒 YAZ-2073 D6).
    expect(load).toHaveBeenCalledWith({ root: '/v', path: '/v/a:b.excalidraw', imageMaxPx: Math.max(BOARD_PREVIEW_BOUNDS.maxWidth, BOARD_PREVIEW_BOUNDS.maxHeight) })
    const call = (engine.exportToBlob.mock.calls[0] as unknown as [Record<string, never>])[0] as Record<string, unknown>
    expect(call.exportPadding).toBe(BOARD_PREVIEW_BOUNDS.padding)
    expect(call.appState).toMatchObject({ viewBackgroundColor: '#fafafa', theme: 'dark', exportWithDarkMode: true })
    expect(call.files).toMatchObject({ img: { id: 'img', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' } })
  })

  it('an empty board is the empty string, not a failure — and nothing is drawn', async () => {
    installLoad(JSON.stringify({ elements: [{ id: 'gone', isDeleted: true }] }))
    await expect(boardPreviews.load(boardPreviewKey('/v', board(), 'light', 'adapt'))).resolves.toBe('')
    expect(engine.exportToBlob).not.toHaveBeenCalled()
  })

  it('a board that is not a scene is null', async () => {
    installLoad('not json')
    await expect(boardPreviews.load(boardPreviewKey('/v', board(), 'light', 'adapt'))).resolves.toBeNull()
  })

  it('a DIAGRAM goes through its own door and the D9 renderer, in the key`s theme and colour setting — never the drawing door (🔒 YAZ-1802 D9)', async () => {
    const xml = '<mxfile><diagram id="p"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>'
    const diagramLoad = vi.fn(async (req: { root: string; path: string }) => ({ path: req.path, xml, mtime: 1, size: 1 }))
    const drawingLoad = vi.fn()
    Object.defineProperty(window, 'yaseenDraw', { value: { diagram: { load: diagramLoad }, drawing: { load: drawingLoad } }, configurable: true, writable: true })
    const flow = board({ name: 'Flow.drawio', path: '/v/Flow.drawio', kind: 'diagram' })
    await expect(boardPreviews.load(boardPreviewKey('/v', flow, 'dark', 'keep'))).resolves.toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(diagramLoad).toHaveBeenCalledWith({ root: '/v', path: '/v/Flow.drawio' })
    expect(renderDiagramPreview).toHaveBeenCalledWith(xml, 'dark', 'keep', BOARD_PREVIEW_BOUNDS)
    expect(drawingLoad).not.toHaveBeenCalled()
  })

  it('a diagram main refuses (empty, corrupt, not draw.io) is null — "Preview unavailable", never a spinner', async () => {
    const load = vi.fn(async () => Promise.reject({ code: 'IO_ERROR', message: 'the file is empty' }))
    Object.defineProperty(window, 'yaseenDraw', { value: { diagram: { load } }, configurable: true, writable: true })
    await expect(boardPreviews.load(boardPreviewKey('/v', board({ name: 'Bad.drawio', path: '/v/Bad.drawio', kind: 'diagram' }), 'light', 'adapt'))).resolves.toBeNull()
    expect(renderDiagramPreview).not.toHaveBeenCalled()
  })
})
