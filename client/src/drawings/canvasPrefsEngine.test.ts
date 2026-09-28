/**
 * THE LASER PREFS AGREE WITH THE VENDORED ENGINE (🔒 YAZ-1989 D1). `shared/` may not import the
 * engine, so its laser lists are copies: this pins them — and the defaults — to what the fork
 * actually exports, so an engine bump that changes a swatch fails here instead of every stored
 * colour silently resetting to red at the IPC guard.
 */
import { describe, expect, it } from 'vitest'
import { prefsToAppState } from '@shared/canvasPrefs'
import { DEFAULT_CANVAS_PREFS, LASER_COLORS, LASER_SIZES, LASER_TRAIL_MODES } from '@shared/types'

describe('laser canvas prefs vs the vendored engine', () => {
  it('offer exactly the engine’s modes, swatches and sizes', async () => {
    const engine = await import('@excalidraw/excalidraw')
    expect([...LASER_TRAIL_MODES]).toEqual([...engine.LASER_TRAIL_MODES])
    expect([...LASER_COLORS]).toEqual([...engine.LASER_COLORS])
    expect([...LASER_SIZES]).toEqual(Object.keys(engine.LASER_SIZES))
  })

  it('default to the engine’s own defaults', async () => {
    const engine = await import('@excalidraw/excalidraw')
    const { laserTrailMode, laserColor, laserSize } = engine.restoreAppState(null, null)
    expect(prefsToAppState(DEFAULT_CANVAS_PREFS, ['laserTrailMode', 'laserColor', 'laserSize'])).toEqual({ laserTrailMode, laserColor, laserSize })
  })
})
