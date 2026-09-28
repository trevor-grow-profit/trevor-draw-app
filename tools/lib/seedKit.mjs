/**
 * What every `tools/seed*DemoVault.mjs` shares, so each script keeps only its data: the one strict
 * CLI parser and the refuse-to-wipe rule, a PNG encoder (node built-ins only — pictures are
 * generated, never downloaded), Excalidraw element builders and scenes, the vault writers, git, and
 * the isolated Electron profile. The perf fixtures (`tools/perf/lib/fixtures.mjs`, `exportPixels.mjs`)
 * and the E2E suite (`e2e/support/`) build on the same PNG, scene, git and profile writers. The
 * builders reproduce each script's exact bytes: id and index formats, `seed` ranges and the ORDER
 * of Math.random calls are all part of what a seeded vault looks like — which is also why
 * `seedMergeDemoVault` and `seedSortDemoVault` keep their own few elements (hand-set ids and seeds
 * the merge and sort cases are written against), and why the perf fixtures keep theirs (a seeded
 * RNG, and key orders their measured bytes depend on).
 */
import { execFileSync } from 'node:child_process'
import { randomFillSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileIdFor, fracIndex } from './seedDemoVault.mjs'

// ---------------------------------------------------------------- CLI and the wipe rule
/**
 * The one CLI parser, and strict: these scripts wipe what they are pointed at, so an unknown word or
 * a flag without its value is an error, never a guess. `spec` maps each value flag to `'dir'`
 * (resolved to an absolute path) or `'value'`; `--force` and `--help` / `-h` always parse. Returns
 * `{ force, help }` plus each flag given, by name without its dashes.
 */
export function parseArgs(argv, spec) {
  const out = { force: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--force') out.force = true
    else if (!Object.hasOwn(spec, arg)) throw new Error(`unknown argument: ${arg}`)
    else {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a ${spec[arg] === 'dir' ? 'directory' : 'value'}`)
      out[arg.slice(2)] = spec[arg] === 'dir' ? path.resolve(value) : value
    }
  }
  return out
}
/**
 * A script's command line, parsed: `--help` prints the usage and exits 0; a bad argument or a
 * missing `required` flag prints why and the usage, and exits 2.
 */
export function cli(usage, spec, required = []) {
  let args
  try {
    args = parseArgs(process.argv.slice(2), spec)
    const missing = args.help ? undefined : required.find((name) => args[name.slice(2)] === undefined)
    if (missing) throw new Error(`${missing} <${spec[missing]}> is required`)
  } catch (err) {
    console.error(`${err.message}\n${usage}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(usage)
    process.exit(0)
  }
  return args
}
/**
 * The `seedDemoVault.mjs` rule: a target that already exists is somebody's data until `--force`
 * says otherwise, so it is refused (exit 2) rather than wiped.
 */
export function refuseExisting(target, usage, { what = 'folder', force }) {
  if (!fs.existsSync(target) || force) return
  console.error(`refusing to wipe an existing ${what}: ${target}\npass --force if that is really what you want\n${usage}`)
  process.exit(2)
}
export const wipe = (...dirs) => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))

// ---------------------------------------------------------------- PNG (node built-ins only)
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([len, body, crc])
}
/** An 8-bit RGB (or, with `alpha`, RGBA) PNG from raw scanlines, each row led by its filter byte. */
export function pngFromRaw(w, h, raw, { level = 6, alpha = false } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = alpha ? 6 : 2 // colour type: RGBA or RGB
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
/** One colour: distinct colours are distinct bytes, so distinct content ids. */
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
export const noisePNG = (w, h) => pngFromRaw(w, h, noiseRaw(w, h), { level: 1 })

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
/**
 * A scene as the app saves it; `block` is the `yaseendraw` dates block, which goes FIRST (🔒 YAZ-1834).
 * @type {(source: string, elements: unknown[], options?: { bg?: string, files?: Record<string, unknown>, block?: { createdAt: number, updatedAt: number }, gridSize?: number }) => object}
 */
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
/** `git` is found on PATH; `GIT` overrides it for an odd install. */
const GIT = process.env.GIT || 'git'
/** Git with none of this machine's user or system config (hooks, signing, templates) leaking in. */
export const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
/** `git` in `cwd`, output trimmed; stderr is captured, so a failure's error says why. */
export const git = (cwd, args) => execFileSync(GIT, args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString().trim()
/** A repo-local committer, and no signing prompt. */
export function identity(cwd, name, email = `${name.toLowerCase()}@example.invalid`) {
  git(cwd, ['config', 'user.name', name])
  git(cwd, ['config', 'user.email', email])
  git(cwd, ['config', 'commit.gpgsign', 'false'])
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
/**
 * One window of `yaseendraw.json` (docs/CONTRACTS.md "App state schema").
 * @type {(window: { id?: string, root: string | null, file?: string | null, tabs?: string[], sidebarCollapsed?: boolean, sidebarLens?: string, bounds?: { x: number, y: number, width: number, height: number } }) => object}
 */
export const profileWindow = ({ id = 'w1', root, file = null, tabs = [], sidebarCollapsed = false, sidebarLens = 'files', bounds = { x: 60, y: 60, width: 1440, height: 900 } }) => ({
  id, root, file, tabs, sidebarCollapsed, sidebarLens, focusDirs: [], focusFavorites: [], bounds,
})
/**
 * `<dir>/yaseendraw.json`: the profile a launch on `dir` (`YASEEN_DRAW_USER_DATA_DIR`) reads instead
 * of the real one. `windows` are `profileWindow`s; `settings` adds to the theme and the delete prompt.
 * @param {string} dir
 * @param {{ theme?: string, settings?: Record<string, unknown>, sidebarWidth?: number, recents?: { path: string, lastOpened: number }[], windows?: object[], folders?: Record<string, unknown> }} state
 */
export function writeState(dir, { theme = 'system', settings = {}, sidebarWidth = 300, recents = [], windows = [], folders = {} }) {
  return write(dir, 'yaseendraw.json', { version: 1, settings: { theme, confirmDelete: true, ...settings }, sidebarWidth, recents, windows, folders })
}
/** A profile whose one window is already on `vault`: no dialog, and the real profile is never read. */
export function writeProfile(dir, vault, { lastOpened = Date.now(), recents = [{ path: vault, lastOpened }], id, file, tabs, sidebarCollapsed, bounds, ...state } = {}) {
  return writeState(dir, { ...state, recents, windows: [profileWindow({ id, root: vault, file, tabs, sidebarCollapsed, bounds })] })
}
