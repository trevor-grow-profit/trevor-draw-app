/**
 * The two PNG facts a preview thumbnail needs (🔒 YAZ-2073 D6), on plain Node: whether a picture's
 * pixels are ALL it shows, and its raw pixels written back as a PNG.
 *
 * A thumbnail is made from decoded pixels, so anything the original carries BESIDE its pixels would
 * be lost: a colour profile or gamma the renderer applies, an EXIF rotation, animation frames. Such
 * a picture keeps its own bytes. Only a PNG whose chunks before the pixels say nothing about how
 * they look is thumbnailed — which covers what the engine writes when it pastes an image.
 *
 * The encoder takes what `nativeImage.toBitmap()` hands over — BGRA, alpha-premultiplied — and
 * compresses on libuv's pool (`zlib.deflate`), so the main process only spends a copy on it.
 */
import { promisify } from 'node:util'
import { crc32, deflate } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Chunks that change what the pixels look like, or which pixels show. */
const BESIDE_THE_PIXELS = new Set(['iCCP', 'cICP', 'gAMA', 'cHRM', 'mDCV', 'cLLI', 'eXIf', 'acTL'])
const deflateAsync = promisify(deflate)

/**
 * The size of a PNG whose pixels are all it shows; null for anything else — not a PNG, one with a
 * chunk from `BESIDE_THE_PIXELS`, or a head cut off before the pixels start. `bytes` may be just the
 * file's head: every chunk that matters comes before the first `IDAT`.
 */
export function plainPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  const size = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  for (let at = 33; at + 8 <= buf.length; at += 12 + buf.readUInt32BE(at)) {
    const type = buf.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') return size.width > 0 && size.height > 0 ? size : null
    if (BESIDE_THE_PIXELS.has(type)) return null
  }
  return null
}

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** Premultiplied BGRA pixels → an 8-bit RGBA PNG (straight alpha, as PNG stores it). */
export async function encodePng(bgra: Uint8Array, width: number, height: number): Promise<Buffer> {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height) // each row leads with filter 0 (none)
  for (let y = 0; y < height; y++) {
    for (let x = 0, s = y * width * 4, d = y * stride + 1; x < width; x++, s += 4, d += 4) {
      const a = bgra[s + 3]
      const k = a === 0 || a === 255 ? 1 : 255 / a
      raw[d] = Math.min(255, Math.round(bgra[s + 2] * k))
      raw[d + 1] = Math.min(255, Math.round(bgra[s + 1] * k))
      raw[d + 2] = Math.min(255, Math.round(bgra[s] * k))
      raw[d + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', await deflateAsync(raw)), chunk('IEND', Buffer.alloc(0))])
}
