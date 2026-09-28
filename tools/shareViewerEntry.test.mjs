// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewerPage } from '../share/viewer/page.js'

/**
 * A SHARED DRAWING'S VIEWER SCRIPT (YAZ-1799): `share/viewer/entry.js` + `board.js` run on the
 * Worker's real page in jsdom, with the engine and React's renderer stubbed (the real engine is
 * `buildShareViewer.test.mjs`'s build, and a browser's). This pins what the script decides:
 * what it draws and how, the owner's download switch, the PNG button's rules and the names of
 * the files it saves. `buildShareViewer.test.mjs` does the same for a diagram's `diagram.js`.
 */
const exportToBlob = vi.fn(async () => new Blob(['png']))
const render = vi.fn()
vi.mock('@excalidraw/excalidraw', () => ({ Excalidraw: 'Excalidraw', exportToBlob }))
vi.mock('@excalidraw/excalidraw/index.css', () => ({}))
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render }) }))

const ID = 'AbCdEfGhIjKlMnOpQrStUvWx'
const rect = (id, isDeleted = false) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted })
const SCENE = { type: 'excalidraw', elements: [rect('a'), rect('gone', true)], appState: { viewBackgroundColor: '#fafafa' }, files: {} }

let saved
let fetches
beforeEach(() => {
  vi.resetModules()
  render.mockClear()
  exportToBlob.mockClear()
  saved = []
  fetches = []
  URL.createObjectURL = () => 'blob:board'
  URL.revokeObjectURL = () => undefined
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    saved.push(this.download)
  })
})
afterEach(() => vi.restoreAllMocks())

/** The Worker's page for this board, then the viewer script run against a fetch that answers `routes`. */
async function open({ allowDownload = true, name = 'Q3: plan/v2', scene = SCENE, raw = 200 } = {}) {
  document.documentElement.innerHTML = viewerPage({ id: ID, kind: 'drawing', allowDownload, name, updatedAt: Date.UTC(2026, 8, 1) }).replace(/^<!doctype html>\n<html lang="en">/, '').replace(/<\/html>\s*$/, '')
  globalThis.fetch = vi.fn(async (url) => {
    fetches.push(url)
    if (url === `/scene/${ID}`) return scene instanceof Error ? Promise.reject(scene) : new Response(JSON.stringify(scene))
    return new Response('{}', { status: raw })
  })
  await import('../share/viewer/entry.js')
  const el = (id) => document.getElementById(id)
  return { el, rendered: () => vi.waitFor(() => expect(render).toHaveBeenCalledOnce()) }
}

describe('the shared drawing viewer', () => {
  it('draws the live elements read-only, fitted, with no editing or export UI', async () => {
    const { el, rendered } = await open()
    await rendered()
    const { props } = render.mock.calls[0][0]
    expect(props.viewModeEnabled).toBe(true)
    expect(props.initialData).toMatchObject({ elements: [rect('a')], appState: { viewBackgroundColor: '#fafafa', theme: 'light' }, scrollToContent: true })
    expect(props.UIOptions.tools.image).toBe(false)
    expect(Object.values(props.UIOptions.canvasActions).every((on) => on === false)).toBe(true)
    expect(el('note')).toBeNull()
    expect(fetches).toEqual([`/scene/${ID}`])
  })

  it('says view and download, with the date, and saves the board under a file-safe name', async () => {
    const { el, rendered } = await open()
    await rendered()
    expect(el('meta').textContent).toMatch(/^View and download · updated /)
    el('dl-excalidraw').click()
    await vi.waitFor(() => expect(saved).toEqual(['Q3_ plan_v2.excalidraw']))
    expect(fetches.at(-1)).toBe(`/raw/${ID}?download=1`)
  })

  it('makes a 2× PNG of the live elements on the drawing background', async () => {
    const { el, rendered } = await open()
    await rendered()
    expect(el('dl-png').disabled).toBe(false)
    await el('dl-png').onclick()
    const [opts] = exportToBlob.mock.calls[0]
    expect(opts.elements).toEqual([rect('a')])
    expect(opts.appState).toMatchObject({ exportBackground: true, viewBackgroundColor: '#fafafa' })
    expect(opts.getDimensions(100, 50)).toEqual({ width: 200, height: 100, scale: 2 })
    expect(saved).toEqual(['Q3_ plan_v2.png'])
  })

  it('keeps Download PNG off for an empty drawing, and says why', async () => {
    const { el, rendered } = await open({ scene: { ...SCENE, elements: [rect('gone', true)] } })
    await rendered()
    expect(el('dl-png').disabled).toBe(true)
    expect(el('dl-png').title).toBe('This drawing is empty')
  })

  it('tells the viewer when the owner turned downloads off since the page loaded', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined)
    const { el, rendered } = await open({ raw: 403 })
    await rendered()
    el('dl-excalidraw').click()
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('The owner turned off downloads for this drawing.'))
    expect(saved).toEqual([])
  })

  it('shows no download buttons and says view only when the owner allows none', async () => {
    const { el, rendered } = await open({ allowDownload: false })
    await rendered()
    expect([el('dl-excalidraw'), el('dl-png')]).toEqual([null, null])
    expect(el('meta').textContent).toMatch(/^View only · updated /)
  })

  it('says so in the page when the board cannot be loaded', async () => {
    // The script rethrows after saying so (the browser logs it); here that is an unhandled rejection to absorb.
    const rejected = vi.fn()
    process.on('unhandledRejection', rejected)
    try {
      const { el } = await open({ scene: new Error('offline') })
      await vi.waitFor(() => expect(el('note').textContent).toBe('This drawing could not be loaded. The link may have just been stopped.'))
      expect(render).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(rejected).toHaveBeenCalled())
    } finally {
      process.off('unhandledRejection', rejected)
    }
  })
})
