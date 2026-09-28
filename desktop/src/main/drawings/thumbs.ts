/**
 * PREVIEW-SIZED PICTURES, MADE IN MAIN (🔒 YAZ-2073 D6): `<userData>/thumbs/`, one PNG per asset and
 * size — `<fileId>-<px>.png`. A board's picture used to take every image at full resolution, as
 * base64 over IPC, and decode it on the UI thread; it now takes each at the size it is drawn
 * (`thumbPolicy.ts` decides which), made once and reused across launches.
 *
 * AN ASSET IS IMMUTABLE — its id is the SHA-1 of its bytes, and a legacy scene's embedded ids are
 * trusted exactly as `liftEmbedded` trusts them when it lands them in `assets/` — so a thumbnail
 * never goes stale and there is nothing to invalidate. Nothing is ever written to the vault.
 *
 * A CACHE MAY NEVER FAIL A PREVIEW (the media cache's rule): a picture that cannot be read, decoded
 * or stored comes back as its own bytes, which is exactly what the preview drew before.
 *
 * ON THE MAIN THREAD, IN SMALL STEPS. `nativeImage` exists only here (not in a worker or a utility
 * process), so decode and resize run on main, one picture per turn of the event loop — a few ms
 * for a screenshot — and the PNG is compressed on libuv's pool. Only a cache miss pays at all.
 *
 * BOUNDED BY A SWEEP: once per session, after the first thumbnail is written, the least recently
 * used go until the folder fits `THUMBS_MAX_BYTES` (a hit touches the file's mtime).
 */
import { mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { nativeImage } from 'electron'
import type { DrawingFileEntry } from '@shared/types'
import { isValidFileId, parseDataUrl } from '@shared/drawingAssets'
import { atomicWrite } from '../fs/fsUtils'
import { encodePng, plainPngSize } from './png'
import { drawnBoxes, planThumbSweep, thumbFileName, thumbPx, THUMBS_MAX_BYTES } from './thumbPolicy'

/** The cache's folder under userData. */
export const THUMBS_DIR = 'thumbs'

/** Base64 characters enough to hold every chunk before a PNG's pixels (a profile or EXIF block is a few KB). */
const HEAD_BASE64 = 64 * 1024

export interface Thumbs {
  /** `files` as a picture of `elements`, at most `picturePx` across, needs them. Never throws. */
  fit(files: Record<string, DrawingFileEntry>, elements: readonly unknown[], picturePx: number): Promise<Record<string, DrawingFileEntry>>
}

const pngEntry = (bytes: Buffer): DrawingFileEntry => ({ mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}` })

export interface ThumbsOptions {
  /** Injected in tests so the cap does not need a quarter gigabyte of files. */
  maxBytes?: number
}

export function createThumbs(folder: string, { maxBytes = THUMBS_MAX_BYTES }: ThumbsOptions = {}): Thumbs {
  let swept = false

  /** The least recently used thumbnails past the cap, deleted; never throws. */
  const sweep = async (): Promise<void> => {
    const names = await readdir(folder).catch(() => [] as string[])
    const entries = await Promise.all(
      names.map(async (name) => {
        const info = await stat(path.join(folder, name)).catch(() => null)
        return info === null || !info.isFile() ? null : { name, size: info.size, mtimeMs: info.mtimeMs }
      }),
    )
    for (const name of planThumbSweep(entries.filter((e) => e !== null), maxBytes)) await rm(path.join(folder, name), { force: true }).catch(() => undefined)
  }

  /** One picture at `px`: the cached file, or a new one made from `base64`; null = keep the original. */
  const thumbnail = async (fileId: string, px: number, base64: string): Promise<Buffer | null> => {
    const file = path.join(folder, thumbFileName(fileId, px))
    const cached = await readFile(file).catch(() => null)
    if (cached !== null) {
      const now = new Date()
      void utimes(file, now, now).catch(() => undefined)
      return cached
    }
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const small = image.resize(width >= height ? { width: px, quality: 'good' } : { height: px, quality: 'good' })
    const size = small.getSize()
    const png = await encodePng(small.toBitmap(), size.width, size.height)
    const stored = await mkdir(folder, { recursive: true })
      .then(() => atomicWrite(file, png))
      .then(() => true, () => false)
    if (stored && !swept) {
      swept = true
      void sweep()
    }
    return png
  }

  return {
    async fit(files, elements, picturePx) {
      const boxes = drawnBoxes(elements, picturePx)
      const out: Record<string, DrawingFileEntry> = {}
      // One picture at a time: each decode is its own short turn on the main thread.
      for (const [fileId, entry] of Object.entries(files)) {
        out[fileId] = entry
        const box = boxes.get(fileId)
        const data = parseDataUrl(entry.dataURL)
        if (box == null || data === null || data.mimeType !== 'image/png' || !isValidFileId(fileId)) continue
        const head = data.base64.slice(0, HEAD_BASE64 - (HEAD_BASE64 % 4))
        const natural = plainPngSize(Buffer.from(head, 'base64'))
        const px = natural === null ? null : thumbPx(natural, box)
        if (px === null) continue
        const png = await thumbnail(fileId, px, data.base64).catch(() => null)
        if (png !== null) out[fileId] = pngEntry(png)
      }
      return out
    },
  }
}
