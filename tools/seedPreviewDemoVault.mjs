#!/usr/bin/env node
/**
 * USAGE: node tools/seedPreviewDemoVault.mjs --vault <dir> [--profile <dir>] [--force]
 *
 * The vault the sidebar HOVER PREVIEW is demoed against (YAZ-1800). Every board name says what it
 * tests: shapes, empty, deleted-only, far-off tiny, wide, tall, 3 000 elements, images from
 * assets/, a large image, a missing asset, a dark canvas, frames, a text wall, corrupt / zero-byte /
 * no-elements files, an unreadable board, non-boards, long and unicode names, nesting, forty boards
 * (more than the 32-picture cache holds) and boards meant to be edited, renamed or deleted while
 * previewed. Boards only — nothing here is about any other feature.
 *
 * `--vault` IS REQUIRED AND THE PATH IS WIPED (the `seedDemoVault.mjs` rule). `--profile` also
 * writes an isolated Electron profile (`yaseendraw.json`) whose one window is already on the vault
 * (LAUNCH.md "Behaviour checks"), so no dialog is needed and the real profile is never read.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const USAGE = 'usage: node tools/seedPreviewDemoVault.mjs --vault <dir> [--profile <dir>] [--force]'
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : (args[i + 1] ?? '')
}
const VAULT = flag('--vault') && path.resolve(flag('--vault'))
const PROFILE = flag('--profile') && path.resolve(flag('--profile'))
if (!VAULT) {
  console.error(USAGE)
  process.exit(2)
}
for (const dir of [VAULT, PROFILE].filter(Boolean)) {
  if (fs.existsSync(dir) && !args.includes('--force')) {
    console.error(`refusing to wipe an existing folder: ${dir}\npass --force if that is really what you want\n${USAGE}`)
    process.exit(2)
  }
  if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755)
}
// A chmod-000 board from a previous run would stop rmSync; open it up first.
const locked = path.join(VAULT, 'Locked — chmod 000, cannot be read.excalidraw')
if (fs.existsSync(locked)) fs.chmodSync(locked, 0o644)
fs.rmSync(VAULT, { recursive: true, force: true })
fs.mkdirSync(VAULT, { recursive: true })

// ---------------------------------------------------------------- PNG (node built-ins only)
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(w, h, pixel) {
  const stride = 1 + w * 3
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y)
      raw.set([r, g, b], y * stride + 1 + x * 3)
    }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const gradient = (w, h, a, b) => png(w, h, (x, y) => a.map((v, i) => Math.round(v + (b[i] - v) * ((x / w + y / h) / 2))))
const stripes = (w, h) => png(w, h, (x) => (Math.floor(x / 40) % 2 ? [255, 190, 11] : [58, 134, 255]))

// ---------------------------------------------------------------- Excalidraw elements
let n = 0
const seed = () => 1 + Math.floor(Math.random() * 2 ** 30)
const idx = (i) => `a${String(i).padStart(5, '0')}`
const base = (extra = {}) => ({
  id: `p-${(n++).toString(36)}`, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: idx(n),
  roundness: null, seed: seed(), version: 1, versionNonce: seed(), isDeleted: false, boundElements: null,
  updated: 1, link: null, locked: false, ...extra,
})
const rect = (x, y, w, h, bg = '#a5d8ff', extra = {}) => ({ ...base({ roundness: { type: 3 }, backgroundColor: bg, ...extra }), type: 'rectangle', x, y, width: w, height: h })
const ellipse = (x, y, w, h, bg = '#ffc9c9') => ({ ...base({ backgroundColor: bg }), type: 'ellipse', x, y, width: w, height: h })
const arrow = (x, y, dx, dy) => ({ ...base({ roundness: { type: 2 } }), type: 'arrow', x, y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]], startArrowhead: null, endArrowhead: 'arrow', startBinding: null, endBinding: null, elbowed: false })
const text = (x, y, str, size = 20, extra = {}) => {
  const lines = str.split('\n')
  return { ...base({ strokeWidth: 1, roughness: 0, ...extra }), type: 'text', x, y, width: Math.ceil(Math.max(...lines.map((l) => l.length)) * size * 0.55), height: Math.ceil(lines.length * size * 1.25), text: str, originalText: str, fontSize: size, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', autoResize: true, lineHeight: 1.25, containerId: null }
}
const image = (x, y, w, h, fileId) => ({ ...base({ strokeColor: 'transparent', roughness: 0 }), type: 'image', x, y, width: w, height: h, status: 'saved', fileId, scale: [1, 1], crop: null })
const frame = (x, y, w, h, name) => ({ ...base({ roughness: 0, strokeWidth: 1 }), type: 'frame', x, y, width: w, height: h, name })

// ---------------------------------------------------------------- writers
const scene = (elements, { bg = '#ffffff', files = {} } = {}) => ({ type: 'excalidraw', version: 2, source: 'yaz-1800-demo', elements, appState: { viewBackgroundColor: bg, gridSize: 20 }, files })
function write(rel, content) {
  const file = path.join(VAULT, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`)
  return file
}
const board = (rel, elements, opts) => write(`${rel}.excalidraw`, scene(elements, opts))
/** An image in `assets/<sha1>.png`, the way the app stores them (🔒 YAZ-1775 D3). `onDisk: false` = the missing-asset case. */
function asset(bytes, { onDisk = true } = {}) {
  const id = createHash('sha1').update(bytes).digest('hex')
  if (onDisk) write(`assets/${id}.png`, bytes)
  return id
}
const label = (title, sub) => [text(0, -90, title, 32), ...(sub ? [text(0, -45, sub, 18, { strokeColor: '#868e96' })] : [])]

// ---------------------------------------------------------------- 00 — the scenario list, itself a board to preview
board('00 READ ME — what to try', [
  text(0, 0, [
    'YAZ-1800 Mouse over Preview — demo vault',
    '',
    '1. Rest the mouse on any board for ~0.4 s → the big panel opens beside the sidebar.',
    '2. Sweep the mouse quickly down the list → nothing flickers open.',
    '3. Header button (picture frame, right of sort) → off: no preview, native tooltip back.',
    '4. Arrow keys in the tree → each focused board previews.',
    '5. Escape while a preview shows → only the preview closes.',
    '6. Open "Edit me", draw, save, hover it again → the new drawing shows.',
    '7. Settings → Appearance → Dark → hover again → the picture redraws dark.',
    '8. Resize the window / drag the sidebar edge → the panel re-fits.',
    '9. "Forty boards" → scan all 40, go back to 01 → it redraws (cache holds 32).',
  ].join('\n'), 22),
])

// ---------------------------------------------------------------- normal drawings
board('01 Simple — three shapes and an arrow', [
  ...label('Simple board', 'the everyday case'),
  rect(0, 0, 220, 120), ellipse(320, 0, 180, 120), arrow(220, 60, 100, 0), rect(120, 200, 260, 90, '#b2f2bb'), text(150, 230, 'Hover me', 24),
])
board('02 Wide — a long row of boxes', Array.from({ length: 24 }, (_, i) => rect(i * 260, 0, 220, 140, i % 2 ? '#ffec99' : '#a5d8ff')).concat(label('Panorama — 24 boxes in a row')))
board('03 Tall — a long column of boxes', Array.from({ length: 24 }, (_, i) => rect(0, i * 180, 300, 140, i % 2 ? '#d0bfff' : '#b2f2bb')).concat(label('Tower — 24 boxes')))
board('04 Tiny and far away — one small dot at x=50000', [ellipse(50_000, 30_000, 24, 24, '#fa5252')])
board('05 Huge — 3000 elements (speed test)', Array.from({ length: 3000 }, (_, i) => rect((i % 60) * 70, Math.floor(i / 60) * 50, 60, 40, `hsl(${(i * 7) % 360} 70% 75%)`)))
board('06 Frames — two frames with content', [
  frame(0, 0, 500, 360, 'Frame A'), rect(40, 60, 200, 100), text(60, 200, 'inside A', 24),
  frame(600, 0, 500, 360, 'Frame B'), ellipse(660, 60, 200, 160), text(660, 260, 'inside B', 24),
  text(0, 420, 'Frames are exported with their names on top.', 18),
])
board('07 Text wall — a long written note', [text(0, 0, Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: The quick brown fox jumps over the lazy dog, again and again.`).join('\n'), 18)])
board('08 Dark canvas — navy background colour', [text(0, 0, 'This board has its own dark background', 28, { strokeColor: '#f8f9fa' }), rect(0, 80, 300, 160, '#364fc7', { strokeColor: '#f8f9fa' })], { bg: '#1b1f3b' })

// ---------------------------------------------------------------- images
const small = asset(gradient(240, 240, [255, 107, 107], [77, 171, 247]))
const wide = asset(stripes(800, 300))
board('09 Images — three pictures from assets', [...label('Three images', 'bytes live in assets/'), image(0, 0, 240, 240, small), image(280, 0, 400, 150, wide), image(280, 180, 240, 240, small)])
const large = asset(gradient(2400, 1600, [20, 20, 60], [250, 200, 80]))
board('10 Large image — 2400×1600 picture', [image(0, 0, 1200, 800, large), text(0, 820, 'One large image scaled into the board', 24)])
const gone = asset(gradient(64, 64, [0, 0, 0], [255, 255, 255]), { onDisk: false })
board('11 Missing image — its asset file is not on disk', [image(0, 0, 300, 300, gone), text(0, 320, 'The image file was never written — the rest must still show', 20)])

// ---------------------------------------------------------------- empty and broken
board('12 Empty — brand new, nothing drawn', [])
board('13 Only deleted elements — should say Empty board', [rect(0, 0, 200, 100, '#ffc9c9', { isDeleted: true }), text(0, 150, 'deleted', 20, { isDeleted: true })])
write('14 Corrupt — not JSON.excalidraw', '{ this is not json')
write('15 Zero bytes.excalidraw', '')
write('16 No elements array — not a scene.excalidraw', `${JSON.stringify({ type: 'excalidraw', appState: {} })}\n`)
board('Locked — chmod 000, cannot be read', [rect(0, 0, 100, 100)])
fs.chmodSync(locked, 0o000)

// ---------------------------------------------------------------- change it while it is cached
board('Edit me — draw, save, hover again', [...label('Edit me', 'save, then hover: the new version must show'), rect(0, 0, 200, 120, '#ffd8a8')])
board('Rename me — the preview follows the new name', [...label('Rename me'), ellipse(0, 0, 200, 200, '#96f2d7')])
board('Delete me — while its preview is open', [...label('Delete me'), rect(0, 0, 240, 120, '#ffa8a8')])

// ---------------------------------------------------------------- names and non-boards
board('A really really long board name that will never fit in the sidebar and must also truncate cleanly in the preview header', [...label('Long name'), rect(0, 0, 200, 100)])
board('日本語 — ünïcødé 🎨 board', [...label('ユニコード 🎨', 'non-latin name'), ellipse(0, 0, 240, 160, '#eebefa')])
write('notes.txt', 'Not a board — no preview, keeps its tooltip.\n')
write('photo.png', gradient(120, 80, [0, 128, 0], [255, 255, 0]))

// ---------------------------------------------------------------- folders
board('Nested/Deeper/Deepest board — header shows the folder', [...label('Deep in a folder', 'Nested/Deeper'), rect(0, 0, 220, 120, '#c5f6fa')])
board('Nested/Middle board', [...label('Middle'), rect(0, 0, 220, 120, '#e9fac8')])
for (let i = 1; i <= 40; i++) {
  const pad = String(i).padStart(2, '0')
  board(`Forty boards/Board ${pad}`, [text(0, 0, `Board ${pad}`, 64), rect(0, 100, 60 + i * 10, 60, `hsl(${i * 9} 70% 70%)`)])
}

// ---------------------------------------------------------------- favorites (Favorites tab previews too)
write('.yaseendraw/favorites.json', { version: 1, favorites: ['01 Simple — three shapes and an arrow.excalidraw', '09 Images — three pictures from assets.excalidraw', 'Nested'] })

console.log(`seeded ${VAULT}`)

// ---------------------------------------------------------------- isolated profile (LAUNCH.md recipe)
if (PROFILE) {
  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })
  const state = {
    version: 1,
    settings: { theme: 'light', confirmDelete: true },
    sidebarWidth: 300,
    recents: [{ path: VAULT, lastOpened: Date.now() }],
    windows: [{ id: 'w1', root: VAULT, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 60, y: 60, width: 1440, height: 900 } }],
    folders: {},
  }
  fs.writeFileSync(path.join(PROFILE, 'yaseendraw.json'), `${JSON.stringify(state, null, 2)}\n`)
  console.log(`profile ${PROFILE}`)
}
