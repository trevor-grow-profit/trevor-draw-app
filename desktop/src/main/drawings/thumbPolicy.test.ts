import { describe, expect, it } from 'vitest'
import { drawnBoxes, planThumbSweep, THUMB_MIN_PX, thumbFileName, thumbPx, THUMBS_MAX_BYTES } from './thumbPolicy'

const image = (fileId: string, x: number, y: number, width: number, height: number, over: Record<string, unknown> = {}) => ({ type: 'image', fileId, x, y, width, height, angle: 0, crop: null, ...over })

describe('drawnBoxes', () => {
  it('scales every image by the one fit the whole picture gets: an 11-wide grid of 1440 × 822 into 1200 px', () => {
    const grid = Array.from({ length: 121 }, (_, i) => image(`f${i}`, (i % 11) * 1500, Math.floor(i / 11) * 880, 1440, 822))
    const boxes = drawnBoxes(grid, 1200)
    const scale = 1200 / (10 * 1500 + 1440)
    expect(boxes.size).toBe(121)
    expect(boxes.get('f0')!.width).toBeCloseTo(1440 * scale)
    expect(boxes.get('f0')!.height).toBeCloseTo(822 * scale)
  })

  it('never scales up: a small board draws its pictures at their own size', () => {
    expect(drawnBoxes([image('a', 0, 0, 300, 200)], 1200).get('a')).toEqual({ width: 300, height: 200 })
  })

  it('bounds a rotated picture by its rotated box, so the scale is never under-estimated', () => {
    // 1000 × 10 turned a quarter stands 1000 tall: the fit is 500 / 1000, not 500 / 505 off its unturned width.
    const boxes = drawnBoxes([image('a', 0, 0, 1000, 10, { angle: Math.PI / 2 }), image('b', 0, 0, 100, 100)], 500)
    expect(boxes.get('a')!.width).toBeCloseTo(500)
    expect(boxes.get('b')!.width).toBeCloseTo(50)
  })

  it('keeps the biggest box per picture when one is placed twice, along each axis', () => {
    const boxes = drawnBoxes([image('a', 0, 0, 400, 100), image('a', 0, 200, 100, 400)], 5000)
    expect(boxes.get('a')).toEqual({ width: 400, height: 400 })
  })

  it('answers null for a picture any of whose elements is cropped: the crop is in the original`s pixels', () => {
    const crop = { x: 10, y: 10, width: 100, height: 100, naturalWidth: 1440, naturalHeight: 822 }
    const boxes = drawnBoxes([image('a', 0, 0, 400, 300), image('a', 500, 0, 200, 200, { crop }), image('b', 0, 400, 50, 50)], 1200)
    expect(boxes.get('a')).toBeNull()
    expect(boxes.get('b')).toEqual({ width: 50, height: 50 })
  })

  it('leaves out deleted elements, other kinds and images whose geometry is not numbers', () => {
    const boxes = drawnBoxes([
      image('gone', 0, 0, 10, 10, { isDeleted: true }),
      { type: 'rectangle', x: 0, y: 0, width: 99999, height: 99999 },
      image('nan', 0, 0, Number.NaN, 10),
      image('zero', 0, 0, 0, 10),
      image('', 0, 0, 10, 10),
      null,
      image('ok', 0, 0, 10, 10),
    ], 1200)
    expect([...boxes.keys()]).toEqual(['ok'])
  })
})

describe('thumbPx', () => {
  it('is the next power of two at or above what is drawn, from THUMB_MIN_PX', () => {
    expect(thumbPx({ width: 1440, height: 822 }, { width: 106, height: 60.5 })).toBe(128)
    expect(thumbPx({ width: 1440, height: 822 }, { width: 128, height: 73 })).toBe(128)
    expect(thumbPx({ width: 1440, height: 822 }, { width: 580, height: 331 })).toBe(1024)
    expect(thumbPx({ width: 1440, height: 822 }, { width: 3, height: 2 })).toBe(THUMB_MIN_PX)
  })

  it('is null when the thumbnail would not be smaller than the picture: never upscale, never a same-size copy', () => {
    expect(thumbPx({ width: 1440, height: 822 }, { width: 1200, height: 685 })).toBeNull()
    expect(thumbPx({ width: 100, height: 50 }, { width: 10, height: 5 })).toBe(64)
    expect(thumbPx({ width: 64, height: 50 }, { width: 10, height: 5 })).toBeNull()
  })

  it('follows the axis drawn the most per source pixel when an element stretches its picture', () => {
    // 1000 × 1000 squeezed into 50 wide, 400 tall: the height needs 400 px.
    expect(thumbPx({ width: 1000, height: 1000 }, { width: 50, height: 400 })).toBe(512)
    // A wide picture drawn tall: 2000 × 500 in 100 × 100 — the height needs 100 of 500 rows, so 400 across.
    expect(thumbPx({ width: 2000, height: 500 }, { width: 100, height: 100 })).toBe(512)
  })
})

describe('thumbFileName', () => {
  it('is `<fileId>-<px>.png`', () => {
    expect(thumbFileName('a1b2', 256)).toBe('a1b2-256.png')
  })
})

describe('planThumbSweep', () => {
  const entry = (name: string, size: number, mtimeMs: number) => ({ name, size, mtimeMs })

  it('drops the least recently used first until what stays fits', () => {
    const entries = [entry('c-128.png', 40, 3), entry('a-128.png', 40, 1), entry('b-256.png', 40, 2)]
    expect(planThumbSweep(entries, 100)).toEqual(['a-128.png'])
    expect(planThumbSweep(entries, 40)).toEqual(['a-128.png', 'b-256.png'])
    expect(planThumbSweep(entries, 120)).toEqual([])
  })

  it('never touches a name that is not one of ours', () => {
    expect(planThumbSweep([entry('notes.txt', 500, 0), entry('x-128.png.tmp-0123456789ab', 500, 0), entry('a-64.png', 10, 5)], 0)).toEqual(['a-64.png'])
  })

  it('keeps a quarter gigabyte by default', () => {
    expect(THUMBS_MAX_BYTES).toBe(256 * 1024 * 1024)
    expect(planThumbSweep([entry('a-64.png', THUMBS_MAX_BYTES, 0)])).toEqual([])
  })
})
