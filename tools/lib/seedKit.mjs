/**
 * What every `tools/seed*DemoVault.mjs` shares, so each script keeps only its data: the CLI flag and
 * refuse-to-wipe rule, a PNG encoder (node built-ins only — pictures are generated, never
 * downloaded), Excalidraw element builders and scenes, the vault writers, git, and the isolated
 * Electron profile. The builders reproduce each script's exact bytes: id and index formats, `seed`
 * ranges and the ORDER of Math.random calls are all part of what a seeded vault looks like.
 */
import { execFileSync } from 'node:child_process'
import { randomFillSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileIdFor, fracIndex } from './seedDemoVault.mjs'

// ---------------------------------------------------------------- CLI and the wipe rule
const ARGV = process.argv.slice(2)
/** `--name <value>`: undefined when absent, '' when it is the last word. */
export const flag = (name) => {
  const i = ARGV.indexOf(name)
  return i === -1 ? undefined : (ARGV[i + 1] ?? '')
}
/** A directory flag, resolved; falsy when it is missing or empty. */
export const dirFlag = (name) => flag(name) && path.resolve(flag(name))
/** A required flag's value; without one, the usage line and exit 2. */
export function required(value, usage) {
  if (value) return value
  console.error(usage)
  process.exit(2)
}
/**
 * The `seedDemoVault.mjs` rule: a target that already exists is somebody's data until `--force`
 * says otherwise, so it is refused (exit 2) rather than wiped.
 */
export function refuseExisting(target, usage, { what = 'folder', force = ARGV.includes('--force') } = {}) {
  if (!fs.existsSync(target) || force) return
  console.error(`refusing to wipe an existing ${what}: ${target}\npass --force if that is really what you want\n${usage}`)
  process.exit(2)
}
export const wipe = (...dirs) => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))

// ---------------------------------------------------------------- PNG (node built-ins only)
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
/** zlib's own where this Node has it (much faster on the 100 MB demos); the same number either way. */
const crc32 =
  zlib.crc32 ??
  ((buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  })
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** An 8-bit RGB PNG from raw scanlines, each row led by its filter byte. */
export function pngFromRaw(w, h, raw, level = 6) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))])
}
/** `pixel(x, y)` returns [r, g, b]. */
export function png(w, h, pixel) {
  const stride = 1 + w * 3
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * stride + 1 + x * 3)
  return pngFromRaw(w, h, raw)
}
export const solidPNG = (w, h, rgb) => png(w, h, () => rgb)
/** A diagonal blend from `a` toward `b`; `toCorner` reaches `b` exactly on the bottom-right pixel. */
export function gradientPNG(w, h, a, b, { toCorner = false } = {}) {
  const [dx, dy] = toCorner ? [w - 1, h - 1] : [w, h]
  return png(w, h, (x, y) => a.map((v, i) => Math.round(v + (b[i] - v) * ((x / dx + y / dy) / 2))))
}
export const stripesPNG = (w, h) => png(w, h, (x) => (Math.floor(x / 40) % 2 ? [255, 190, 11] : [58, 134, 255]))
/** Random scanlines, filter bytes zeroed: incompressible, so a picture is ~w×h×3 bytes on disk. */
export function noiseRaw(w, h) {
  const stride = 1 + w * 3
  const raw = Buffer.alloc(stride * h)
  randomFillSync(raw)
  for (let y = 0; y < h; y++) raw[y * stride] = 0
  return raw
}
export const noisePNG = (w, h) => pngFromRaw(w, h, noiseRaw(w, h), 1)

// ---------------------------------------------------------------- Excalidraw elements
/** A text element's box: ~`widthPerChar` of the font size per character, 1.25 lines. */
const textBox = (str, size, widthPerChar) => {
  const lines = str.split('\n')
  return { width: Math.ceil(Math.max(...lines.map((l) => l.length)) * size * widthPerChar), height: Math.ceil(lines.length * size * 1.25) }
}
const TEXT = { fontFamily: 5, textAlign: 'left', verticalAlign: 'top', autoResize: true, lineHeight: 1.25, containerId: null }
const ARROW = { startArrowhead: null, endArrowhead: 'arrow', startBinding: null, endBinding: null, elbowed: false }

/**
 * The preview / share / draw.io builders: ids `<prefix>-<n in base 36>`, index `a00001`… (five
 * digits sort as strings), `seed` then `versionNonce` drawn from 1…2³⁰, `updated: 1`. Each call
 * returns its own counter.
 */
export function elementKit(prefix) {
  let n = 0
  const seed = () => 1 + Math.floor(Math.random() * 2 ** 30)
  const base = (extra = {}) => ({
    id: `${prefix}-${(n++).toString(36)}`, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${String(n).padStart(5, '0')}`,
    roundness: null, seed: seed(), version: 1, versionNonce: seed(), isDeleted: false, boundElements: null,
    updated: 1, link: null, locked: false, ...extra,
  })
  const shape = (type, bg) => (x, y, w, h, fill = bg, extra = {}) => ({ ...base({ ...(type === 'rectangle' && { roundness: { type: 3 } }), backgroundColor: fill, ...extra }), type, x, y, width: w, height: h })
  return {
    rect: shape('rectangle', '#a5d8ff'),
    ellipse: shape('ellipse', '#ffc9c9'),
    diamond: shape('diamond', '#b2f2bb'),
    arrow: (x, y, dx, dy) => ({ ...base({ roundness: { type: 2 } }), type: 'arrow', x, y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]], ...ARROW }),
    text: (x, y, str, size = 20, extra = {}) => ({ ...base({ strokeWidth: 1, roughness: 0, ...extra }), type: 'text', x, y, ...textBox(str, size, 0.55), text: str, originalText: str, fontSize: size, ...TEXT }),
    image: (x, y, w, h, fileId, extra = {}) => ({ ...base({ strokeColor: 'transparent', roughness: 0, ...extra }), type: 'image', x, y, width: w, height: h, status: 'saved', fileId, scale: [1, 1], crop: null }),
    frame: (x, y, w, h, name) => ({ ...base({ roughness: 0, strokeWidth: 1 }), type: 'frame', x, y, width: w, height: h, name }),
  }
}

/** 1…2³¹−1: Excalidraw treats a `seed` of 0 as unset, so the range starts at one. */
export const rnd = () => 1 + Math.floor(Math.random() * (2 ** 31 - 1))

/**
 * The stress-vault builders (`seedDemoVault`, `seedStorageDemoVault`): the caller passes each
 * element's position `i` (index `fracIndex(i)`), `seed`s run 1…2³¹−1, and `newId(type)` is called
 * BEFORE `seed` and `versionNonce`, so an id that draws Math.random keeps its place in the stream.
 */
export function indexedKit({ newId, updated, strokeWidth = 2, roughness = 1 }) {
  const common = (i, roundness = null) => ({
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth, strokeStyle: 'solid', roughness,
    opacity: 100, groupIds: [], frameId: null, index: fracIndex(i), roundness, seed: rnd(), version: 1, versionNonce: rnd(),
    isDeleted: false, boundElements: null, updated, link: null, locked: false,
  })
  return {
    rect: (i, x, y, width, height, extra = {}) => ({ id: newId('rectangle'), type: 'rectangle', x, y, width, height, ...common(i, { type: 3 }), ...extra }),
    text: (i, x, y, str, fontSize = 20) => ({ id: newId('text'), type: 'text', x, y, ...textBox(str, fontSize, 0.6), ...common(i), strokeWidth: 1, roughness: 0, text: str, originalText: str, fontSize, ...TEXT }),
    image: (i, x, y, width, height, fileId) => ({ id: newId('image'), type: 'image', x, y, width, height, ...common(i), strokeColor: 'transparent', strokeWidth: 1, roughness: 0, status: 'saved', fileId, scale: [1, 1], crop: null }),
  }
}

// ---------------------------------------------------------------- scenes and writers
/** A scene as the app saves it; `block` is the `yaseendraw` dates block, which goes FIRST (🔒 YAZ-1834). */
export const scene = (source, elements, { bg = '#ffffff', files = {}, block, gridSize = 20 } = {}) => ({
  ...(block && { yaseendraw: block }),
  type: 'excalidraw', version: 2, source, elements, appState: { viewBackgroundColor: bg, gridSize }, files,
})
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`
/** Writes `<dir>/<rel>`, parents made; anything but a string or Buffer is written as JSON. */
export function write(dir, rel, content) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : json(content))
  return file
}
/** An image in `<vault>/assets/<sha1>.png`, the way the app stores them (🔒 YAZ-1775 D3). `onDisk: false` = the missing-asset case. */
export function asset(vault, bytes, { onDisk = true } = {}) {
  const id = fileIdFor(bytes)
  if (onDisk) write(vault, `assets/${id}.png`, bytes)
  return id
}
/** A `files` entry carrying the bytes as a dataURL — a legacy board or an upstream export. */
export const embedded = (id, bytes, { mime = 'image/png', ...times }) => ({ mimeType: mime, id, dataURL: `data:${mime};base64,${bytes.toString('base64')}`, ...times })

// ---------------------------------------------------------------- git
/** `git` in `cwd`, output trimmed; stderr is captured, so a failure's error says why. */
export const git = (cwd, args, bin = 'git') => execFileSync(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().trim()
/** A repo-local committer, and no signing prompt. */
export function identity(cwd, name, email = `${name.toLowerCase()}@example.invalid`, bin = 'git') {
  git(cwd, ['config', 'user.name', name], bin)
  git(cwd, ['config', 'user.email', email], bin)
  git(cwd, ['config', 'commit.gpgsign', 'false'], bin)
}
/** The two-computer idiom: `vault` committed as "You" and pushed, upstream set, to a new bare `origin`. */
export function publish(vault, origin, message) {
  git(undefined, ['init', '--bare', '-b', 'main', origin])
  git(vault, ['init', '-b', 'main'])
  identity(vault, 'You')
  git(vault, ['add', '-A'])
  git(vault, ['commit', '-m', message])
  git(vault, ['remote', 'add', 'origin', origin])
  git(vault, ['push', '-u', 'origin', 'main'])
}
/** The other computer: a clone of `origin` at `dir`, committing as `name`. */
export function cloneAs(origin, dir, name) {
  git(undefined, ['clone', origin, dir])
  identity(dir, name)
}

// ---------------------------------------------------------------- isolated profile (LAUNCH.md "Behaviour checks")
/** `<dir>/yaseendraw.json` whose one window is already on `vault`: no dialog, and the real profile is never read. */
export function writeProfile(dir, vault, { theme = 'system', sidebarWidth = 300, lastOpened = Date.now(), recents = [{ path: vault, lastOpened }], file = null, tabs = [], bounds = { x: 60, y: 60, width: 1440, height: 900 }, folders = {} } = {}) {
  const window = { id: 'w1', root: vault, file, tabs, sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds }
  return write(dir, 'yaseendraw.json', { version: 1, settings: { theme, confirmDelete: true }, sidebarWidth, recents, windows: [window], folders })
}
