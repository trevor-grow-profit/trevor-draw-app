/**
 * Pure helpers for `tools/seedDemoVault.mjs` (and the seed kit and perf fixtures). Separated so the
 * naming and content-id rules that the app itself depends on (a vault asset is named for the SHA-1
 * of its bytes) are unit-tested without writing a 130 MB vault to disk.
 */
import { createHash } from 'node:crypto'

/** Mime → the extension `assets/<fileId>.<ext>` uses (🔒 YAZ-1775 D3). */
export const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
}

/**
 * A drawing's `fileId`: the lowercase SHA-1 hex of the bytes. This is Excalidraw's own
 * `generateIdFromFile`, and 🔒 YAZ-1775 D3 makes it the asset's filename too, which is what dedupes the
 * same image pasted into two boards down to one file.
 */
export const fileIdFor = (bytes) => createHash('sha1').update(bytes).digest('hex')

/** `<sha1>.<ext>` — the name the seeded bytes must land under for a board to resolve them. */
export function assetFileName(fileId, mime) {
  const ext = EXT[mime]
  if (!ext) throw new Error(`unsupported asset mime: ${mime}`)
  return `${fileId}.${ext}`
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/**
 * An Excalidraw fractional index. Elements sort by `index` as a STRING, so the generator cannot
 * just count: `a10` sorts before `a2`. Two-char keys cover the first 62 elements, three-char keys
 * the next 62², four-char keys the next 62³ (238 k in all), and every key of a longer form sorts
 * after every key of a shorter one.
 */
export function fracIndex(i) {
  if (i < 62) return `a${BASE62[i]}`
  if (i < 62 + 62 ** 2) return `b${BASE62[Math.floor((i - 62) / 62)]}${BASE62[(i - 62) % 62]}`
  const j = i - 62 - 62 ** 2
  return `c${BASE62[Math.floor(j / 62 ** 2)]}${BASE62[Math.floor(j / 62) % 62]}${BASE62[j % 62]}`
}
