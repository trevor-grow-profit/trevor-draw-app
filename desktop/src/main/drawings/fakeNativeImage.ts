/**
 * Electron's `nativeImage`, as much of it as `thumbs.ts` uses, for tests on plain Node: a PNG decodes
 * to its IHDR size, anything else is empty, and a resize answers grey pixels at the size
 * asked (the other side rounded, as Chromium does).
 */
import { vi } from 'vitest'

interface FakeImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(opts: { width?: number; height?: number; quality?: string }): FakeImage
  toBitmap(): Buffer
}

function image(width: number, height: number): FakeImage {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => (w !== undefined ? image(w, Math.max(1, Math.round((height * w) / width))) : image(Math.max(1, Math.round((width * h!) / height)), h!)),
    toBitmap: () => Buffer.alloc(width * height * 4, 0x80),
  }
}

const isPng = (b: Buffer) => b.length >= 24 && b.readUInt32BE(0) === 0x89504e47

export const fakeNativeImage = {
  createFromBuffer: vi.fn((bytes: Buffer) => (isPng(bytes) ? image(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) : image(0, 0))),
}
