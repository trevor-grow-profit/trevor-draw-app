import { describe, expect, it } from 'vitest'
import { appStateEdits, boardAppStateKeys } from './boardAppState'

describe('boardAppStateKeys', () => {
  it('is what the vendored engine’s serializer writes, less the canvas prefs (🔒 YAZ-1775 D9): the background counts, the grid toggle and the view do not', async () => {
    const keys = boardAppStateKeys(await import('@excalidraw/excalidraw'))
    expect(keys).toContain('viewBackgroundColor')
    for (const notTheBoards of ['gridModeEnabled', 'scrollX', 'scrollY', 'zoom', 'theme', 'selectedElementIds']) expect(keys).not.toContain(notTheBoards)
  })

  it('never counts the laser`s settings (🔒 YAZ-1989 D1), even from a serializer that wrote them: they are user prefs, so a colour pick is not a board edit', async () => {
    const keys = boardAppStateKeys(await import('@excalidraw/excalidraw'))
    for (const pref of ['laserTrailMode', 'laserColor', 'laserSize']) expect(keys).not.toContain(pref)
    // The fork marks them `export: false`, so its serializer should never write them; the filter is
    // what holds if it ever did.
    const writesEverything = {
      restoreAppState: () => ({}),
      serializeAsJSON: () => JSON.stringify({ appState: { viewBackgroundColor: '#ffffff', laserTrailMode: 'sticky', laserColor: '#2979ff', laserSize: 'L' } }),
    } as unknown as Parameters<typeof boardAppStateKeys>[0]
    expect(boardAppStateKeys(writesEverything)).toEqual(['viewBackgroundColor'])
  })
})

describe('appStateEdits', () => {
  const base = { viewBackgroundColor: '#ffffff', gridSize: 20, scrollX: 0, zoom: { value: 1 } }

  it('the first appState is the reference; only a move of a counted key adds one, and the count never falls', () => {
    const edits = appStateEdits(['viewBackgroundColor', 'gridSize'])
    expect(edits(base)).toBe(0)
    expect(edits({ ...base })).toBe(0)
    expect(edits({ ...base, scrollX: 400, zoom: { value: 2 } })).toBe(0) // pan and zoom are not edits
    expect(edits({ ...base, viewBackgroundColor: '#fffce8' })).toBe(1)
    expect(edits({ ...base, viewBackgroundColor: '#fffce8', scrollX: 9 })).toBe(1)
    expect(edits(base)).toBe(2) // back to white is another change, not a return to clean
  })
})
