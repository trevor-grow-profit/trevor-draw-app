/**
 * A scene file dropped on a board ADDS to it (`dropScene.ts`). The engine is a stub for the rules —
 * which drops are ours, which bytes travel, which door the elements go through — and the REAL
 * engine's `restoreElements` runs once, to pin that a file's bindings survive the trip.
 */
import { describe, expect, it, vi } from 'vitest'
import { droppedSceneFile, isSceneFileName, mergeDroppedScene, parseDroppedScene, shouldMergeDrop, type DropEngine, type DropTarget } from './dropScene'

const rect = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, ...over })
const image = (id: string, fileId: string) => ({ id, type: 'image', fileId, x: 0, y: 0, width: 10, height: 10 })
const bytes = (dataURL = 'data:image/png;base64,AA==') => ({ mimeType: 'image/png', dataURL })
const sceneJson = (elements: unknown[], files: Record<string, unknown> = {}) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: '#123456' }, files })

function fakeCanvas(scene: unknown[] = []) {
  const addFiles = vi.fn()
  const insertElements = vi.fn()
  return { addFiles, insertElements, api: { getSceneElements: () => scene, addFiles, insertElements } as unknown as DropTarget }
}

/** `restoreElements` as the engine's own: hand back what it was given. */
const engine: DropEngine = { restoreElements: vi.fn((elements: unknown) => elements) } as unknown as DropEngine

const transfer = (...files: File[]) => ({ files: files as unknown as FileList })
const file = (name: string, type = '') => new File(['{}'], name, { type })

describe('which drops are ours', () => {
  it('a `.excalidraw` or `.json`, by name, in any case', () => {
    for (const name of ['board.excalidraw', 'Board.EXCALIDRAW', 'export.json', 'x.JSON']) expect(isSceneFileName(name)).toBe(true)
    for (const name of ['shapes.excalidrawlib', 'shot.png', 'diagram.drawio', 'notes.txt', 'excalidraw']) expect(isSceneFileName(name)).toBe(false)
  })

  it('exactly one scene file; images, libraries, several files and no files go to the engine', () => {
    const scene = file('board.excalidraw')
    expect(droppedSceneFile(transfer(scene))).toBe(scene)
    expect(droppedSceneFile(transfer(file('a.json', 'application/json')))?.name).toBe('a.json')
    expect(droppedSceneFile(transfer(file('shot.png', 'image/png')))).toBeNull()
    expect(droppedSceneFile(transfer(file('shapes.excalidrawlib')))).toBeNull()
    expect(droppedSceneFile(transfer(scene, file('other.excalidraw')))).toBeNull()
    expect(droppedSceneFile(transfer())).toBeNull()
    expect(droppedSceneFile(null)).toBeNull()
  })

  it('merges onto a board with something on it; an EMPTY board (or one holding only deleted elements) opens the file as before', () => {
    expect(shouldMergeDrop([rect('a')])).toBe(true)
    expect(shouldMergeDrop([])).toBe(false)
    expect(shouldMergeDrop([rect('gone', { isDeleted: true })])).toBe(false)
  })
})

describe('parseDroppedScene', () => {
  it('takes anything with an `elements` array and drops the deleted ones', () => {
    expect(parseDroppedScene(sceneJson([rect('a'), rect('b', { isDeleted: true })])).elements).toEqual([rect('a')])
    expect(parseDroppedScene(JSON.stringify({ elements: [rect('a')] }))).toEqual({ elements: [rect('a')], files: {} })
  })

  it('refuses what is not a scene, in words', () => {
    expect(() => parseDroppedScene('nope')).toThrow('not valid JSON')
    expect(() => parseDroppedScene(JSON.stringify({ hello: 'world' }))).toThrow('not an Excalidraw drawing')
    expect(() => parseDroppedScene(JSON.stringify([1, 2]))).toThrow('not an Excalidraw drawing')
  })
})

describe('mergeDroppedScene', () => {
  it('restores with repairBindings and hands the elements to `insertElements` — the paste door, never a replace', () => {
    const { api, insertElements, addFiles } = fakeCanvas([rect('existing')])
    const added = mergeDroppedScene(engine, api, sceneJson([rect('a'), rect('b')]))
    expect(engine.restoreElements).toHaveBeenCalledWith([rect('a'), rect('b')], null, { repairBindings: true })
    expect(insertElements).toHaveBeenCalledTimes(1)
    expect(insertElements).toHaveBeenCalledWith([rect('a'), rect('b')])
    expect(added).toEqual([rect('a'), rect('b')])
    expect(addFiles).not.toHaveBeenCalled()
  })

  it('hands the canvas the bytes a live image names, each carrying its id, BEFORE the elements', () => {
    const { api, insertElements, addFiles } = fakeCanvas()
    const order: string[] = []
    addFiles.mockImplementation(() => order.push('files'))
    insertElements.mockImplementation(() => order.push('elements'))
    mergeDroppedScene(engine, api, sceneJson([image('i', 'f1'), rect('r')], { f1: bytes(), orphan: bytes('data:image/png;base64,BB=='), broken: { mimeType: 'image/png' } }))
    expect(addFiles).toHaveBeenCalledTimes(1)
    const entries = addFiles.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'f1', ...bytes() })
    expect(typeof entries[0].created).toBe('number')
    expect(order).toEqual(['files', 'elements'])
  })

  it('an empty file adds nothing and is not an error', () => {
    const { api, insertElements, addFiles } = fakeCanvas()
    expect(mergeDroppedScene(engine, api, sceneJson([]))).toEqual([])
    expect(mergeDroppedScene(engine, api, sceneJson([rect('gone', { isDeleted: true })]))).toEqual([])
    expect(insertElements).not.toHaveBeenCalled()
    expect(addFiles).not.toHaveBeenCalled()
  })

  it('a file that is not a scene throws, and nothing reaches the canvas', () => {
    const { api, insertElements, addFiles } = fakeCanvas()
    expect(() => mergeDroppedScene(engine, api, '{"type":"excalidrawlib","libraryItems":[]}')).toThrow('not an Excalidraw drawing')
    expect(insertElements).not.toHaveBeenCalled()
    expect(addFiles).not.toHaveBeenCalled()
  })

  it('through the REAL engine’s restore, a container keeps its bound text and an arrow keeps its binding', async () => {
    const real = (await import('@excalidraw/excalidraw')) as unknown as DropEngine
    const { api, insertElements } = fakeCanvas()
    const box = rect('box', { boundElements: [{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }] })
    const label = { id: 'label', type: 'text', x: 1, y: 1, width: 8, height: 8, text: 'hi', originalText: 'hi', containerId: 'box', fontSize: 20, fontFamily: 1 }
    const arrow = { id: 'arrow', type: 'arrow', x: 20, y: 5, width: 30, height: 0, points: [[0, 0], [30, 0]], startBinding: { elementId: 'box', focus: 0, gap: 1 }, endBinding: null }
    mergeDroppedScene(real, api, sceneJson([box, label, arrow]))
    const inserted = insertElements.mock.calls[0][0] as Array<Record<string, unknown>>
    const byId = new Map(inserted.map((el) => [el.id, el]))
    expect(byId.get('label')).toMatchObject({ containerId: 'box' })
    expect(byId.get('arrow')).toMatchObject({ startBinding: { elementId: 'box' } })
    expect((byId.get('box') as { boundElements: unknown[] }).boundElements).toHaveLength(2)
  })
})
