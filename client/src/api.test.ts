import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YaseenDrawApi } from '@shared/ipc'
import { api, BridgeRequestError } from './api'

/** A minimal `window.yaseenDraw` stub: only the methods the client `api` delegates to. */
function installBridge(): { [K in keyof YaseenDrawApi]: ReturnType<typeof vi.fn> } {
  const bridge = {
    tree: vi.fn(),
    createDir: vi.fn(),
    createFile: vi.fn(),
    drawing: vi.fn(),
    diagram: vi.fn(),
    pickFolder: vi.fn(),
    dialog: vi.fn(),
    watch: vi.fn(),
    state: vi.fn(),
    window: vi.fn(),
    menu: vi.fn(),
    link: vi.fn(),
    file: vi.fn(),
    shell: vi.fn(),
    favorites: vi.fn(),
    media: vi.fn(),
    components: vi.fn(),
    secrets: vi.fn(),
    github: vi.fn(),
    storage: vi.fn(),
    share: vi.fn(),
  }
  Object.defineProperty(window, 'yaseenDraw', { value: bridge, configurable: true, writable: true })
  return bridge
}

let bridge: ReturnType<typeof installBridge>
beforeEach(() => (bridge = installBridge()))
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).yaseenDraw
})

describe('api', () => {
  it('delegates to window.yaseenDraw with the same arguments and resolves its value', async () => {
    bridge.tree.mockResolvedValue({ root: '/v', tree: [], generatedAt: 1 })
    bridge.pickFolder.mockResolvedValue({ cancelled: true })
    await expect(api.tree('/v')).resolves.toEqual({ root: '/v', tree: [], generatedAt: 1 })
    expect(bridge.tree).toHaveBeenCalledWith('/v')
    await expect(api.pickFolder()).resolves.toEqual({ cancelled: true })
    await api.createDir('/v/d')
    await api.createFile({ path: '/v/n.excalidraw', content: '{}' })
    expect(bridge.createDir).toHaveBeenCalledWith('/v/d')
    expect(bridge.createFile).toHaveBeenCalledWith({ path: '/v/n.excalidraw', content: '{}' })
  })

  it('the file dialogs delegate and answer what the user chose (YAZ-1833 / 🔒 YAZ-1775 D3 YAZ-1821)', async () => {
    const dialog = { openDrawing: vi.fn(), saveDrawing: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'dialog', { value: dialog, configurable: true })
    const picked = { path: '/x/a.excalidraw', name: 'a', content: '{}' }
    dialog.openDrawing.mockResolvedValue(picked)
    await expect(api.dialog.openDrawing()).resolves.toEqual(picked)
    const req = { defaultName: 'Board.excalidraw', content: '{"type":"excalidraw"}' }
    dialog.saveDrawing.mockResolvedValue({ path: '/x/Board.excalidraw' })
    await expect(api.dialog.saveDrawing(req)).resolves.toEqual({ path: '/x/Board.excalidraw' })
    expect(dialog.saveDrawing).toHaveBeenCalledWith(req)
    // A refusal arrives as plain data and comes back as the class.
    dialog.saveDrawing.mockRejectedValue({ code: 'IO_ERROR', message: 'disk is full' })
    const err = (await api.dialog.saveDrawing(req).catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect(err.code).toBe('IO_ERROR')
  })

  it('the drawing document doors pass their request through and answer the receipt (🔒 YAZ-1810)', async () => {
    const drawing = { load: vi.fn(), save: vi.fn(), libraryFolder: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'drawing', { value: drawing, configurable: true })
    const loaded = { path: '/v/b.excalidraw', json: '{"elements":[]}', mtime: 1, size: 15, files: {}, stored: [] }
    drawing.load.mockResolvedValue(loaded)
    await expect(api.drawing.load({ root: '/v', path: 'b.excalidraw' })).resolves.toEqual(loaded)
    expect(drawing.load).toHaveBeenCalledWith({ root: '/v', path: 'b.excalidraw' })
    const req = { root: '/v', path: 'b.excalidraw', json: '{"elements":[]}', expectedMtime: 1, newFiles: [] }
    drawing.save.mockResolvedValue({ path: '/v/b.excalidraw', mtime: 2, size: 15, persisted: [] })
    await expect(api.drawing.save(req)).resolves.toEqual({ path: '/v/b.excalidraw', mtime: 2, size: 15, persisted: [] })
    expect(drawing.save).toHaveBeenCalledWith(req)
    // 🔒 YAZ-1775 D5: read-only, and main owns the resolution (only it knows where userData is).
    drawing.libraryFolder.mockResolvedValue('/Users/x/Library/Application Support/Yaseen Draw/library')
    await expect(api.drawing.libraryFolder()).resolves.toBe('/Users/x/Library/Application Support/Yaseen Draw/library')
    // A CONFLICT rejection arrives as plain data and comes back as the class, mtime included.
    drawing.save.mockRejectedValue({ code: 'CONFLICT', message: 'drawing changed on disk since last read', path: '/v/b.excalidraw', mtime: 9 })
    const err = (await api.drawing.save(req).catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect([err.code, err.mtime]).toEqual(['CONFLICT', 9])
  })

  it('rename delegates to file.rename and wraps ALREADY_EXISTS like every other code (Links E1, GRO-2194)', async () => {
    const file = { rename: vi.fn(), onRenamed: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'file', { value: file, configurable: true })
    file.rename.mockResolvedValue({ oldPath: '/v/a.excalidraw', newPath: '/v/b.excalidraw' })
    await expect(api.rename({ oldPath: '/v/a.excalidraw', newPath: '/v/b.excalidraw' })).resolves.toEqual({ oldPath: '/v/a.excalidraw', newPath: '/v/b.excalidraw' })
    expect(file.rename).toHaveBeenCalledWith({ oldPath: '/v/a.excalidraw', newPath: '/v/b.excalidraw' })
    file.rename.mockRejectedValue({ code: 'ALREADY_EXISTS', message: 'a file with this name already exists', path: '/v/b.excalidraw' })
    const err = (await api.rename({ oldPath: '/v/a.excalidraw', newPath: '/v/b.excalidraw' }).catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect(err.code).toBe('ALREADY_EXISTS')
    expect(err.path).toBe('/v/b.excalidraw')
  })

  it('a rejected plain BridgeError becomes a thrown BridgeRequestError with code / message / path / mtime', async () => {
    bridge.tree.mockRejectedValue({ code: 'CONFLICT', message: 'newer on disk', path: '/v/a.excalidraw', mtime: 42 })
    const err = await api.tree('/v').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BridgeRequestError)
    const e = err as BridgeRequestError
    expect(e.code).toBe('CONFLICT')
    expect(e.message).toBe('newer on disk')
    expect(e.path).toBe('/v/a.excalidraw')
    expect(e.mtime).toBe(42)
    expect(e.name).toBe('BridgeRequestError')
    expect('status' in e).toBe(false)
  })

  it('github calls delegate and pass the status through, onStatus included (YAZ-1081)', async () => {
    const github = { status: vi.fn(), syncNow: vi.fn(), setEnabled: vi.fn(), onStatus: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'github', { value: github, configurable: true })
    github.status.mockResolvedValue({ root: '/v', state: 'off' })
    await expect(api.github.status('/v')).resolves.toEqual({ root: '/v', state: 'off' })
    expect(github.status).toHaveBeenCalledWith('/v')
    github.setEnabled.mockResolvedValue({ root: '/v', state: 'synced' })
    await expect(api.github.setEnabled('/v', true)).resolves.toEqual({ root: '/v', state: 'synced' })
    expect(github.setEnabled).toHaveBeenCalledWith('/v', true)
    await api.github.syncNow('/v')
    expect(github.syncNow).toHaveBeenCalledWith('/v')
    // onStatus is a pass-through, not a `call` wrapper: the unsubscribe must survive it.
    const off = () => {}
    github.onStatus.mockReturnValue(off)
    const listener = vi.fn()
    expect(api.github.onStatus(listener)).toBe(off)
    expect(github.onStatus).toHaveBeenCalledWith(listener)
  })

  it('media calls pass the request through and answer the list; onChanged is a pass-through (🔒 YAZ-1775 D5)', async () => {
    const media = { favorites: vi.fn(), recent: vi.fn(), onChanged: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'media', { value: media, configurable: true })
    const row = { itemKey: 'pixabay:1', provider: 'pixabay', providerId: '1', kind: 'photo', title: 'A tree', updatedAt: 1 }
    media.favorites.mockResolvedValue([row])
    await expect(api.media.favorites({ op: 'list' })).resolves.toEqual([row])
    expect(media.favorites).toHaveBeenCalledWith({ op: 'list' })
    media.recent.mockResolvedValue([])
    await expect(api.media.recent({ op: 'remove' } as never)).resolves.toEqual([])
    const off = () => {}
    media.onChanged.mockReturnValue(off)
    const listener = vi.fn()
    expect(api.media.onChanged(listener)).toBe(off)
    expect(media.onChanged).toHaveBeenCalledWith(listener)
  })

  it('the studio doors delegate, and a provider failure arrives with its typed code (🔒 YAZ-1775 D4)', async () => {
    const media = { favorites: vi.fn(), recent: vi.fn(), onChanged: vi.fn(), search: vi.fn(), preview: vi.fn(), import: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'media', { value: media, configurable: true })
    media.search.mockResolvedValue({ items: [], nextCursor: null, pixabayAvailable: false, warnings: [] })
    await expect(api.media.search({ q: 'money bag', source: 'all' })).resolves.toMatchObject({ pixabayAvailable: false })
    expect(media.search).toHaveBeenCalledWith({ q: 'money bag', source: 'all' })
    media.preview.mockResolvedValue({ mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml;base64,x' })
    await expect(api.media.preview({ provider: 'iconify', id: 'noto:money-bag' })).resolves.toMatchObject({ mimeType: 'image/svg+xml' })
    media.import.mockRejectedValue({ code: 'OFFLINE', message: 'could not reach api.iconify.design' })
    await expect(api.media.import({ provider: 'iconify', id: 'noto:money-bag' })).rejects.toMatchObject({ name: 'BridgeRequestError', code: 'OFFLINE' })
  })

  it('components calls pass the request through and answer what main made; onChanged is a pass-through (🔒 YAZ-1775 D5)', async () => {
    const components = { list: vi.fn(), save: vi.fn(), read: vi.fn(), rename: vi.fn(), delete: vi.fn(), preview: vi.fn(), onChanged: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'components', { value: components, configurable: true })
    const item = { slug: 'a-card', name: 'A card', elementCount: 2, createdAt: 1, updatedAt: 1 }
    components.list.mockResolvedValue([item])
    await expect(api.components.list()).resolves.toEqual([item])
    components.save.mockResolvedValue(item)
    await expect(api.components.save({ name: 'A card', fragmentJson: '{}', previewPng: 'data:image/png;base64,AA==' })).resolves.toEqual(item)
    expect(components.save).toHaveBeenCalledWith({ name: 'A card', fragmentJson: '{}', previewPng: 'data:image/png;base64,AA==' })
    components.read.mockResolvedValue({ fragmentJson: '{}' })
    await expect(api.components.read({ slug: 'a-card' })).resolves.toEqual({ fragmentJson: '{}' })
    components.rename.mockResolvedValue(item)
    await expect(api.components.rename({ slug: 'a-card', name: 'B' })).resolves.toEqual(item)
    components.preview.mockResolvedValue('data:image/png;base64,AA==')
    await expect(api.components.preview({ slug: 'a-card' })).resolves.toBe('data:image/png;base64,AA==')
    components.delete.mockRejectedValue({ code: 'NOT_FOUND', message: 'no such component' })
    await expect(api.components.delete({ slug: 'gone' })).rejects.toMatchObject({ name: 'BridgeRequestError', code: 'NOT_FOUND' })
    const off = () => undefined
    components.onChanged.mockReturnValue(off)
    const listener = () => undefined
    expect(api.components.onChanged(listener)).toBe(off)
    expect(components.onChanged).toHaveBeenCalledWith(listener)
  })

  it('secrets: set and has delegate, and a bridge failure arrives as a typed BridgeRequestError (🔒 YAZ-1775 D4)', async () => {
    const secrets = { set: vi.fn(), has: vi.fn() }
    Object.defineProperty(window.yaseenDraw, 'secrets', { value: secrets, configurable: true })
    secrets.set.mockResolvedValue(undefined)
    await expect(api.secrets.set({ name: 'pixabayApiKey', value: 'k' })).resolves.toBeUndefined()
    expect(secrets.set).toHaveBeenCalledWith({ name: 'pixabayApiKey', value: 'k' })
    secrets.has.mockResolvedValue(true)
    await expect(api.secrets.has({ name: 'pixabayApiKey' })).resolves.toBe(true)
    secrets.set.mockRejectedValue({ code: 'IO_ERROR', message: 'disk went away' })
    const err = (await api.secrets.set({ name: 'pixabayApiKey', value: 'k' }).catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect(err.code).toBe('IO_ERROR')
  })

  it('a BridgeError without path / mtime leaves those fields undefined', async () => {
    bridge.tree.mockRejectedValue({ code: 'NOT_FOUND', message: 'path does not exist' })
    const err = (await api.tree('/v/missing').catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.mtime).toBeUndefined()
    expect(err.path).toBeUndefined()
  })

  it('anything that is not a BridgeError is wrapped as IO_ERROR with its message', async () => {
    bridge.tree.mockRejectedValue(new Error('ipc gone'))
    const err = (await api.tree('/v').catch((e: unknown) => e)) as BridgeRequestError
    expect(err).toBeInstanceOf(BridgeRequestError)
    expect(err.code).toBe('IO_ERROR')
    expect(err.message).toBe('ipc gone')
  })
})
