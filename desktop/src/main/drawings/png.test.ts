import { describe, expect, it } from 'vitest'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { encodePng, plainPngSize } from './png'

const chunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** A 3 × 2 RGB PNG with `extra` chunks between the header and the pixels. */
function png(extra: Buffer[] = [], width = 3, height = 2): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND')])
}

describe('plainPngSize', () => {
  it('answers the size of a PNG whose pixels are all it shows — text, pHYs and sRGB say nothing about how they look', () => {
    expect(plainPngSize(png())).toEqual({ width: 3, height: 2 })
    expect(plainPngSize(png([chunk('tEXt', Buffer.from('Software\0x')), chunk('pHYs', Buffer.alloc(9)), chunk('sRGB', Buffer.from([0]))]))).toEqual({ width: 3, height: 2 })
  })

  it('needs only the head: the bytes up to the first IDAT', () => {
    const whole = png([chunk('tEXt', Buffer.alloc(40))])
    expect(plainPngSize(whole.subarray(0, whole.indexOf('IDAT') + 4))).toEqual({ width: 3, height: 2 })
  })

  it('is null for a PNG that carries a profile, gamma, EXIF rotation or animation — its own bytes show those', () => {
    for (const type of ['iCCP', 'cICP', 'gAMA', 'cHRM', 'mDCV', 'cLLI', 'eXIf', 'acTL']) expect(plainPngSize(png([chunk(type, Buffer.alloc(8))])), type).toBeNull()
  })

  it('is null for anything that is not a whole PNG head', () => {
    expect(plainPngSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(plainPngSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull() // a JPEG
    expect(plainPngSize(png().subarray(0, 40))).toBeNull() // cut off before the pixels
    expect(plainPngSize(png([], 0, 2))).toBeNull()
  })
})

describe('encodePng', () => {
  it('writes premultiplied BGRA as a straight-alpha RGBA PNG a decoder reads back pixel for pixel', async () => {
    // BGRA premultiplied: opaque orange, half-transparent blue (premultiplied 100 → 200), fully transparent.
    const bgra = Uint8Array.from([10, 128, 255, 255, 100, 0, 0, 128, 0, 0, 0, 0])
    const out = await encodePng(bgra, 3, 1)
    expect(out.subarray(0, 8)).toEqual(SIG)
    expect(plainPngSize(out)).toEqual({ width: 3, height: 1 })
    expect(out[24]).toBe(8) // bit depth
    expect(out[25]).toBe(6) // RGBA
    const idatAt = out.indexOf('IDAT')
    const raw = inflateSync(out.subarray(idatAt + 4, idatAt + 4 + out.readUInt32BE(idatAt - 4)))
    expect([...raw]).toEqual([0, 255, 128, 10, 255, 0, 0, 199, 128, 0, 0, 0, 0])
  })

  it('puts each row behind its own filter byte', async () => {
    const out = await encodePng(new Uint8Array(2 * 2 * 4).fill(255), 2, 2)
    const idatAt = out.indexOf('IDAT')
    const raw = inflateSync(out.subarray(idatAt + 4, idatAt + 4 + out.readUInt32BE(idatAt - 4)))
    expect(raw.length).toBe(2 * (1 + 2 * 4))
    expect([raw[0], raw[9]]).toEqual([0, 0])
  })
})
