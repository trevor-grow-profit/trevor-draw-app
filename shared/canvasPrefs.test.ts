import { describe, expect, it } from 'vitest'
import { DEFAULT_CANVAS_PREFS, LASER_COLORS, LASER_SIZES, LASER_TRAIL_MODES, type CanvasPrefs } from './types'
import { appStateToPrefs, CANVAS_PREF_KEYS, changedPrefKeys, isCanvasPrefs, prefsEqual, prefsToAppState, sanitizeCanvasPrefs, type EngineAppStateSlice } from './canvasPrefs'

const prefs = (over: Partial<CanvasPrefs> = {}): CanvasPrefs => ({ ...DEFAULT_CANVAS_PREFS, ...over })

describe('DEFAULT_CANVAS_PREFS', () => {
  it('is the engine`s own defaults (🔒 YAZ-1775 D9: the fork`s appState.ts / constants.ts)', () => {
    expect(DEFAULT_CANVAS_PREFS).toEqual({
      gridModeEnabled: false,
      objectsSnapModeEnabled: false,
      snapToMidpoints: true,
      arrowBinding: true,
      selectOn: 'wrap',
      toolLock: false,
      zenModeEnabled: false,
      writingMode: false,
      writingStrokeWidth: 0.5,
      vectorStrokeWidth: 2,
      framesVisible: true,
      defaultFontFamily: 10,
      defaultRoughness: 0,
      defaultTextAlign: 'center',
      // 🔒 YAZ-1989 D1: the stock laser — a red fading trail, small.
      laserTrailMode: 'fade',
      laserColor: '#ff0000',
      laserSize: 'S',
    })
  })

  it('is the FOURTEEN keys D9 names plus the three laser keys 🔒 YAZ-1989 D1 adds, and no more', () => {
    expect(CANVAS_PREF_KEYS).toHaveLength(17)
    expect(CANVAS_PREF_KEYS.slice(-3)).toEqual(['laserTrailMode', 'laserColor', 'laserSize'])
    // The round-4 amendment removed the properties-toolbar pref: the toolbar mode is a constant.
    expect(CANVAS_PREF_KEYS).not.toContain('propertiesToolbar')
  })
})

describe('isCanvasPrefs (strict — the IPC boundary)', () => {
  it('accepts a complete, valid record', () => {
    expect(isCanvasPrefs(prefs())).toBe(true)
  })

  it('rejects anything that is not a plain object', () => {
    for (const bad of [null, undefined, 3, 'x', [], [DEFAULT_CANVAS_PREFS]]) expect(isCanvasPrefs(bad)).toBe(false)
  })

  it('rejects a MISSING field — a partial is the loader`s business, not the bridge`s', () => {
    const { framesVisible: _drop, ...partial } = prefs()
    expect(isCanvasPrefs(partial)).toBe(false)
  })

  it('rejects a field of the wrong type or outside its vocabulary', () => {
    expect(isCanvasPrefs({ ...prefs(), gridModeEnabled: 'yes' })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), selectOn: 'contain' })).toBe(false) // the ENGINE's word, not ours
    expect(isCanvasPrefs({ ...prefs(), defaultTextAlign: 'justify' })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), defaultRoughness: 3 })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), writingStrokeWidth: 0 })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), vectorStrokeWidth: Number.NaN })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), defaultFontFamily: 10.5 })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), laserTrailMode: 'forever' })).toBe(false)
    expect(isCanvasPrefs({ ...prefs(), laserColor: '#123456' })).toBe(false) // not one of the five swatches
    expect(isCanvasPrefs({ ...prefs(), laserColor: '#FF0000' })).toBe(false) // the toolbar's exact spelling only
    expect(isCanvasPrefs({ ...prefs(), laserSize: 'XL' })).toBe(false)
  })

  it('accepts every laser value the toolbar can write (🔒 YAZ-1989 D1)', () => {
    for (const laserTrailMode of LASER_TRAIL_MODES) expect(isCanvasPrefs(prefs({ laserTrailMode }))).toBe(true)
    for (const laserColor of LASER_COLORS) expect(isCanvasPrefs(prefs({ laserColor }))).toBe(true)
    for (const laserSize of LASER_SIZES) expect(isCanvasPrefs(prefs({ laserSize }))).toBe(true)
  })

  it('rejects a store from before 🔒 YAZ-1989 D1 at the BRIDGE — the renderer always has all three', () => {
    const { laserTrailMode: _t, laserColor: _c, laserSize: _s, ...before } = prefs()
    expect(isCanvasPrefs(before)).toBe(false)
  })
})

describe('sanitizeCanvasPrefs (lenient — the state file)', () => {
  it('keeps every valid field and defaults only the bad ones', () => {
    expect(sanitizeCanvasPrefs({ gridModeEnabled: true, selectOn: 'overlap', defaultRoughness: 7, zenModeEnabled: 'no' })).toEqual(
      prefs({ gridModeEnabled: true, selectOn: 'overlap' }),
    )
  })

  it('loads a state file from before 🔒 YAZ-1989 D1 whole, the laser at its defaults', () => {
    const { laserTrailMode: _t, laserColor: _c, laserSize: _s, ...before } = prefs({ gridModeEnabled: true })
    expect(sanitizeCanvasPrefs(before)).toEqual(prefs({ gridModeEnabled: true }))
    expect(sanitizeCanvasPrefs({ ...before, laserTrailMode: 'sticky', laserColor: 'blue', laserSize: 'L' })).toEqual(prefs({ gridModeEnabled: true, laserTrailMode: 'sticky', laserSize: 'L' }))
  })

  it('answers the defaults for junk — a store from before a key existed still loads whole', () => {
    for (const junk of [null, undefined, 42, 'x', []]) expect(sanitizeCanvasPrefs(junk)).toEqual(DEFAULT_CANVAS_PREFS)
  })

  it('never returns the shared default object itself', () => {
    expect(sanitizeCanvasPrefs({})).not.toBe(DEFAULT_CANVAS_PREFS)
  })
})

describe('prefsToAppState', () => {
  it('maps every key onto the engine`s own name, defaults included', () => {
    expect(prefsToAppState(prefs())).toEqual({
      gridModeEnabled: false,
      objectsSnapModeEnabled: false,
      isMidpointSnappingEnabled: true,
      isBindingEnabled: true,
      boxSelectionMode: 'contain',
      activeTool: { type: 'selection', customType: null, fromSelection: false, lastActiveTool: null, locked: false },
      zenModeEnabled: false,
      writingMode: false,
      currentItemWritingStrokeWidth: 0.5,
      currentItemVectorStrokeWidth: 2,
      currentItemFontFamily: 10,
      currentItemRoughness: 0,
      currentItemTextAlign: 'center',
      laserTrailMode: 'fade',
      laserColor: '#ff0000',
      laserSize: 'S',
    })
  })

  it('never emits framesVisible — that one goes through updateFrameRendering', () => {
    expect(prefsToAppState(prefs({ framesVisible: false }))).not.toHaveProperty('frameRendering')
    expect(prefsToAppState(prefs(), ['framesVisible'])).toEqual({})
  })

  it('translates selectOn into the engine`s boxSelectionMode both ways', () => {
    expect(prefsToAppState(prefs({ selectOn: 'wrap' }), ['selectOn'])).toEqual({ boxSelectionMode: 'contain' })
    expect(prefsToAppState(prefs({ selectOn: 'overlap' }), ['selectOn'])).toEqual({ boxSelectionMode: 'overlap' })
  })

  it('emits ONLY the keys it is asked for', () => {
    expect(prefsToAppState(prefs({ gridModeEnabled: true }), ['gridModeEnabled'])).toEqual({ gridModeEnabled: true })
  })

  it('emits a WHOLE activeTool for toolLock — a partial one would wipe the held tool', () => {
    const out = prefsToAppState(prefs({ toolLock: true }), ['toolLock'])
    expect(out.activeTool).toEqual({ type: 'selection', customType: null, fromSelection: false, lastActiveTool: null, locked: true })
  })
})

describe('appStateToPrefs', () => {
  const full: EngineAppStateSlice = {
    gridModeEnabled: true,
    objectsSnapModeEnabled: true,
    isMidpointSnappingEnabled: false,
    isBindingEnabled: false,
    boxSelectionMode: 'overlap',
    activeTool: { locked: true },
    zenModeEnabled: true,
    writingMode: true,
    currentItemWritingStrokeWidth: 1.5,
    currentItemVectorStrokeWidth: 4,
    frameRendering: { outline: false, name: false },
    currentItemFontFamily: 5,
    currentItemRoughness: 2,
    currentItemTextAlign: 'left',
    laserTrailMode: 'sticky',
    laserColor: '#2979ff',
    laserSize: 'L',
  }

  it('reads every key back off the engine', () => {
    expect(appStateToPrefs(full, DEFAULT_CANVAS_PREFS)).toEqual({
      gridModeEnabled: true,
      objectsSnapModeEnabled: true,
      snapToMidpoints: false,
      arrowBinding: false,
      selectOn: 'overlap',
      toolLock: true,
      zenModeEnabled: true,
      writingMode: true,
      writingStrokeWidth: 1.5,
      vectorStrokeWidth: 4,
      framesVisible: false,
      defaultFontFamily: 5,
      defaultRoughness: 2,
      defaultTextAlign: 'left',
      laserTrailMode: 'sticky',
      laserColor: '#2979ff',
      laserSize: 'L',
    })
  })

  it('round-trips through prefsToAppState', () => {
    const start = prefs({ gridModeEnabled: true, selectOn: 'overlap', toolLock: true, writingStrokeWidth: 0.75, defaultFontFamily: 5, defaultRoughness: 1, defaultTextAlign: 'right', laserTrailMode: 'hold', laserColor: '#d500f9', laserSize: 'M' })
    const back = appStateToPrefs({ ...(prefsToAppState(start) as EngineAppStateSlice), frameRendering: { outline: start.framesVisible, name: start.framesVisible } }, DEFAULT_CANVAS_PREFS)
    expect(back).toEqual(start)
  })

  it('falls back per field: an appState missing a key never overwrites the stored value', () => {
    const stored = prefs({ writingMode: true, gridModeEnabled: true, framesVisible: false })
    expect(appStateToPrefs({}, stored)).toEqual(stored)
  })

  it('an engine without the laser keys (built before 🔒 YAZ-1989 D1) keeps the stored laser', () => {
    const stored = prefs({ laserTrailMode: 'hold', laserColor: '#00c853', laserSize: 'M' })
    const { laserTrailMode: _t, laserColor: _c, laserSize: _s, ...olderEngine } = full
    expect(appStateToPrefs(olderEngine, stored)).toMatchObject({ laserTrailMode: 'hold', laserColor: '#00c853', laserSize: 'M' })
  })

  it('treats a half-applied frameRendering as "no answer" rather than as a preference', () => {
    const stored = prefs({ framesVisible: false })
    expect(appStateToPrefs({ frameRendering: { outline: true } }, stored).framesVisible).toBe(false)
    expect(appStateToPrefs({ frameRendering: null }, stored).framesVisible).toBe(false)
    expect(appStateToPrefs({ frameRendering: { outline: true, name: true } }, stored).framesVisible).toBe(true)
  })

  it('ignores a value the engine could not have meant', () => {
    const stored = prefs({ defaultRoughness: 1, vectorStrokeWidth: 3 })
    expect(appStateToPrefs({ currentItemRoughness: 9, currentItemVectorStrokeWidth: -1, boxSelectionMode: undefined, laserTrailMode: 'forever', laserColor: '#123456', laserSize: 'XL' }, stored)).toEqual(stored)
  })
})

describe('prefsEqual / changedPrefKeys (the anti-ping-pong rule)', () => {
  it('equal by VALUE, not identity', () => {
    expect(prefsEqual(prefs(), prefs())).toBe(true)
    expect(prefsEqual(prefs(), prefs({ zenModeEnabled: true }))).toBe(false)
  })

  it('names only what moved, in key order', () => {
    expect(changedPrefKeys(prefs(), prefs())).toEqual([])
    expect(changedPrefKeys(prefs(), prefs({ defaultTextAlign: 'left', gridModeEnabled: true }))).toEqual(['gridModeEnabled', 'defaultTextAlign'])
  })
})
