/**
 * PNG pixels for the export pixel gate (YAZ-2073 5A/5B, `tools/perf/exportPixels.mjs`): a decoder for
 * the PNGs Chromium writes and a per-pixel diff, with no image dependency.
 */
import zlib from 'node:zlib'

/** RGBA bytes of an 8-bit, non-interlaced PNG — what Chromium writes, so no decoder dependency is needed. */
export function decodePng(buf) {
  let width, height, channels
  const idat = []
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]]
      if (data[8] !== 8 || data[12] !== 0 || !channels) throw new Error('unsupported PNG: needs 8-bit, non-interlaced, non-palette')
    } else if (type === 'IDAT') idat.push(data)
    i += len + 12
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      line[x] += [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]
    }
    for (let x = 0; x < width; x++) {
      const px = line.subarray(x * channels, x * channels + channels)
      const gray = channels < 3
      rgba.set([px[0], gray ? px[0] : px[1], gray ? px[0] : px[2], channels % 2 === 0 ? px[channels - 1] : 255], (y * width + x) * 4)
    }
    prev = line
  }
  return { width, height, rgba }
}

/** 'same', or how two PNGs differ: pixels with any channel off, and the largest channel delta. */
export function pixelDiff(beforeBytes, afterBytes) {
  const [a, b] = [decodePng(beforeBytes), decodePng(afterBytes)]
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}×${a.height} vs ${b.width}×${b.height}`
  let diff = 0
  let max = 0
  for (let i = 0; i < a.rgba.length; i += 4) {
    const d = Math.max(Math.abs(a.rgba[i] - b.rgba[i]), Math.abs(a.rgba[i + 1] - b.rgba[i + 1]), Math.abs(a.rgba[i + 2] - b.rgba[i + 2]), Math.abs(a.rgba[i + 3] - b.rgba[i + 3]))
    if (d > 0) diff++
    max = Math.max(max, d)
  }
  return diff === 0 ? 'same' : `${diff} px differ (max channel delta ${max})`
}
