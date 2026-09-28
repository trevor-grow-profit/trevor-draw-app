/**
 * HOW BIG A PREVIEW'S PICTURES NEED TO BE (🔒 YAZ-2073 D6). Policy only — no disk, no Electron — so
 * every rule below is a unit test with nothing mocked.
 *
 * A board's picture (the sidebar hover preview) is the scene scaled to fit a box, never up
 * (`previewDimensions`): every image in it is drawn at its element's size times that one scale.
 * An image needs no more pixels than that; the thumbnail is made at the next power of two at or
 * above it, so it is never smaller than what is drawn and the same few sizes serve every board.
 *
 * THE SCALE IS NEVER UNDER-ESTIMATED. The scene's true bounds hold every image's rotated box, so the
 * union of those boxes is at most the scene — and the scale computed from it at least the real one.
 * An image can only ever come back bigger than it is drawn, never smaller.
 *
 * A CROPPED image keeps its bytes: its crop is in the original's pixels, which a thumbnail changes.
 */
import { isValidFileId } from '@shared/drawingAssets'
import { isFiniteNumber } from '@shared/guards'

/** The largest box, in picture pixels, one image is drawn into. */
export interface DrawnBox {
  width: number
  height: number
}

/** The smallest thumbnail: below this a picture is a few dozen pixels and no longer worth a file. */
export const THUMB_MIN_PX = 64

interface LiveImage {
  fileId: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  cropped: boolean
}

function liveImages(elements: readonly unknown[]): LiveImage[] {
  const images: LiveImage[] = []
  for (const el of elements) {
    if (typeof el !== 'object' || el === null) continue
    const { type, fileId, isDeleted, x, y, width, height, angle, crop } = el as Record<string, unknown>
    if (type !== 'image' || typeof fileId !== 'string' || fileId === '' || isDeleted === true) continue
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) continue
    images.push({ fileId, x, y, width, height, angle: isFiniteNumber(angle) ? angle : 0, cropped: typeof crop === 'object' && crop !== null })
  }
  return images
}

/**
 * Every live image's largest drawn box when the scene is fit into `picturePx` × `picturePx`, by
 * fileId; `null` when some element of it must keep the original (a crop). An image element whose
 * geometry is not numbers is left out — and so keeps its bytes too.
 */
export function drawnBoxes(elements: readonly unknown[], picturePx: number): Map<string, DrawnBox | null> {
  const images = liveImages(elements)
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const { x, y, width, height, angle } of images) {
    const cos = Math.abs(Math.cos(angle))
    const sin = Math.abs(Math.sin(angle))
    const halfW = (width * cos + height * sin) / 2
    const halfH = (width * sin + height * cos) / 2
    const cx = x + width / 2
    const cy = y + height / 2
    x1 = Math.min(x1, cx - halfW)
    y1 = Math.min(y1, cy - halfH)
    x2 = Math.max(x2, cx + halfW)
    y2 = Math.max(y2, cy + halfH)
  }
  const scale = Math.min(1, picturePx / (x2 - x1), picturePx / (y2 - y1))
  const boxes = new Map<string, DrawnBox | null>()
  for (const { fileId, width, height, cropped } of images) {
    const prior = boxes.get(fileId)
    if (prior === null) continue
    boxes.set(fileId, cropped ? null : { width: Math.max(prior?.width ?? 0, width * scale), height: Math.max(prior?.height ?? 0, height * scale) })
  }
  return boxes
}

/**
 * The longest side of the thumbnail an image of `natural` size needs to fill `box`: the next power
 * of two at or above it, from `THUMB_MIN_PX`. null when that is not smaller than the image itself —
 * never upscale, and a same-size copy is only a worse copy. An element may stretch its picture, so
 * the need is taken along whichever axis is drawn the most per source pixel.
 */
export function thumbPx(natural: { width: number; height: number }, box: DrawnBox): number | null {
  const longest = Math.max(natural.width, natural.height)
  const need = longest * Math.max(box.width / natural.width, box.height / natural.height)
  let px = THUMB_MIN_PX
  while (px < need) px *= 2
  return px < longest ? px : null
}

/** A thumbnail's file name: the asset it was made from, and its longest side. */
export const thumbFileName = (fileId: string, px: number): string => `${fileId}-${px}.png`

/** Whether `name` is one `thumbFileName` could have made. */
function isThumbName(name: string): boolean {
  const m = /^(.+)-\d+\.png$/.exec(name)
  return m !== null && isValidFileId(m[1])
}

/** What a cache folder may hold before its least recently used thumbnails go. */
export const THUMBS_MAX_BYTES = 256 * 1024 * 1024

/**
 * The sweep's plan: least recently used first (a hit touches the file's mtime), until what stays fits
 * in `maxBytes`. Only names shaped like `thumbFileName`'s are the cache's to delete.
 */
export function planThumbSweep(entries: readonly { name: string; size: number; mtimeMs: number }[], maxBytes: number): string[] {
  const ours = entries.filter((e) => isThumbName(e.name)).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = ours.reduce((sum, e) => sum + e.size, 0)
  const doomed: string[] = []
  for (const e of ours) {
    if (total <= maxBytes) break
    doomed.push(e.name)
    total -= e.size
  }
  return doomed
}
