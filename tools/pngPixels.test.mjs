import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodePng, pixelDiff } from './lib/pngPixels.mjs'

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([len, body, crc])
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A PNG of `pixels` (rows of channel bytes), each row written with the next of the five filter types. */
function encodePng(width, height, channels, pixels) {
  const stride = width * channels
  const rows = []
  for (let y = 0; y < height; y++) {
    const filter = y % 5
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    const out = Buffer.alloc(stride + 1)
    out[0] = filter
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0
      const c = x >= channels ? prior[x - channels] : 0
      out[x + 1] = row[x] - [0, a, prior[x], (a + prior[x]) >> 1, paeth(a, prior[x], c)][filter]
    }
    rows.push(out)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

const noise = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 131 + seed * 17 + ((i * i) % 251)) & 255))

describe('decodePng', () => {
  it('reverses all five scanline filters, RGBA', () => {
    const pixels = noise(7 * 10 * 4, 1)
    const { width, height, rgba } = decodePng(encodePng(7, 10, 4, pixels))
    expect([width, height]).toEqual([7, 10])
    expect(rgba.equals(pixels)).toBe(true)
  })

  it('expands RGB to opaque RGBA', () => {
    const pixels = noise(5 * 6 * 3, 2)
    const { rgba } = decodePng(encodePng(5, 6, 3, pixels))
    for (let p = 0; p < 30; p++) expect([...rgba.subarray(p * 4, p * 4 + 4)]).toEqual([...pixels.subarray(p * 3, p * 3 + 3), 255])
  })
})

describe('pixelDiff', () => {
  const pixels = noise(6 * 6 * 4, 3)

  it('calls identical pixels the same', () => {
    expect(pixelDiff(encodePng(6, 6, 4, pixels), encodePng(6, 6, 4, Buffer.from(pixels)))).toBe('same')
  })

  it('counts the pixels that differ and the largest channel delta', () => {
    const changed = Buffer.from(pixels)
    changed[0] ^= 1
    changed[4 * 7 + 2] = (changed[4 * 7 + 2] + 40) & 255
    expect(pixelDiff(encodePng(6, 6, 4, pixels), encodePng(6, 6, 4, changed))).toBe(`2 px differ (max channel delta ${Math.abs(changed[4 * 7 + 2] - pixels[4 * 7 + 2])})`)
  })

  it('reports a size change instead of comparing', () => {
    expect(pixelDiff(encodePng(6, 6, 4, pixels), encodePng(3, 12, 4, pixels))).toBe('size 6×6 vs 3×12')
  })
})
