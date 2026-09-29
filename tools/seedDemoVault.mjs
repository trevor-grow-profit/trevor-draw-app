#!/usr/bin/env node
/**
 * USAGE: node tools/seedDemoVault.mjs --vault <dir> [--origin <bare-dir>] [--force]
 *
 * Builds the stress-test vault the phase-4 behaviour checks run against: a git repo full of
 * `.excalidraw` boards plus a content-addressed `assets/` folder, and a bare origin beside it so
 * the sidebar's GitHub sync chip has somewhere to push. Node built-ins only (fs, path, crypto,
 * zlib, child_process) — the images are generated here, nothing is downloaded.
 *
 * `--vault` IS REQUIRED AND BOTH PATHS ARE WIPED. There is deliberately no default: this script
 * `rm -rf`s what it is given, and any default would one day be somebody's real vault. A target
 * that already exists is REFUSED unless `--force` says otherwise. `--origin` defaults to
 * `<vault> (origin).git` beside it.
 *
 * What it seeds, and the scenario each board is for: simple shapes · images from `assets/` ·
 * legacy embedded dataURLs (extracted to `assets/` on first save) · a missing asset (placeholder,
 * no crash) · a 40-image board · a ~10 MB PNG · corrupt JSON · an empty file · an upstream-minimal
 * scene · nested + unicode paths · a board sharing one image with another (dedupe) · 50 boards in
 * one folder · two orphan assets, one older than the 24 h sweep window and one fresh.
 *
 * It writes NO Electron user-data profile: the app opens a vault through the folder picker or ⌘O,
 * and `yaseendraw.json`'s schema is the app's own business (see LAUNCH.md "Behaviour checks" for
 * the isolated-profile recipe).
 */
import fs from 'node:fs'
import path from 'node:path'
import { assetFileName, fileIdFor } from './lib/seedDemoVault.mjs'
import { cli, embedded, git as runGit, gradientPNG, indexedKit, noisePNG, refuseExisting, rnd, scene, solidPNG, wipe, write } from './lib/seedKit.mjs'

// ---------------------------------------------------------------- paths
const USAGE = 'usage: node tools/seedDemoVault.mjs --vault <dir> [--origin <bare-dir>] [--force]'

const args = cli(USAGE, { '--vault': 'dir', '--origin': 'dir' }, ['--vault'])
const VAULT = args.vault
const ORIGIN = args.origin ?? `${VAULT} (origin).git`
const ASSETS = path.join(VAULT, 'assets')

// A target that already exists is somebody's data until they say otherwise.
refuseExisting(VAULT, USAGE, { what: 'vault', force: args.force })
refuseExisting(ORIGIN, USAGE, { what: 'origin', force: args.force })

const NOW = Date.now()

// ---------------------------------------------------------------- tiny image encoders
/** Noisy (incompressible) RGB PNG of roughly the requested byte size. */
function noisyPNG(targetBytes) {
  const side = Math.ceil(Math.sqrt(targetBytes / 3))
  return noisePNG(side, side)
}
function svgImage(label, fill) {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">\n` +
      `  <rect width="400" height="300" rx="24" fill="${fill}"/>\n` +
      `  <circle cx="200" cy="150" r="90" fill="#ffffff" fill-opacity="0.85"/>\n` +
      `  <text x="200" y="162" font-family="Helvetica, Arial, sans-serif" font-size="32" text-anchor="middle" fill="#1e1e1e">${label}</text>\n` +
      `</svg>\n`,
    'utf8',
  )
}
/** Baseline 1x1 grey JPEG: one-entry Huffman tables, DC=0 / EOB → scan bits "00" padded to 0x3F. */
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, // SOI
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0 JFIF
  0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(0x01), // DQT: table 0, all ones
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, // SOF0: 8-bit, 1x1, 1 comp
  0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, ...new Array(15).fill(0x00), 0x00, // DHT DC0: one code (len 1) → symbol 0
  0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, ...new Array(15).fill(0x00), 0x00, // DHT AC0: one code (len 1) → EOB
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, // SOS
  0x3f, // scan data: "0" (DC cat 0) + "0" (EOB) + 1-padding
  0xff, 0xd9, // EOI
])

// ---------------------------------------------------------------- Excalidraw helpers
let idCounter = 1
const newId = () => `demo-${(idCounter++).toString(36).padStart(4, '0')}-${rnd().toString(36)}`
const { rect, text, image } = indexedKit({ newId, updated: NOW })
const board = (elements, { files = {}, viewBackgroundColor = '#ffffff' } = {}) =>
  JSON.stringify(scene('yaseen-draw-demo', elements, { bg: viewBackgroundColor, files, gridSize: null }), null, 2)

// ---------------------------------------------------------------- asset registry
/** name → { id, mime, bytes, file } ; `write: false` keeps the bytes OUT of assets/ (legacy / missing demos). */
const assets = new Map()
function asset(name, mime, bytes, { write = true } = {}) {
  const id = fileIdFor(bytes)
  const file = write ? path.join(ASSETS, assetFileName(id, mime)) : null
  assets.set(name, { id, mime, bytes, file, write })
  return id
}

// ---------------------------------------------------------------- build
const writeFile = (rel, content) => write(VAULT, rel, content)
const git = (args, cwd = VAULT) => runGit(cwd, ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...args])

console.log(`== wiping previous output\n   vault:  ${VAULT}\n   origin: ${ORIGIN}`)
wipe(VAULT, ORIGIN)
fs.mkdirSync(ASSETS, { recursive: true })
fs.mkdirSync(path.dirname(ORIGIN), { recursive: true })

console.log('== generating images')
const t0 = Date.now()
const tinyId = asset('tiny-64x64.png', 'image/png', solidPNG(64, 64, [230, 60, 60]))
const mediumId = asset('medium-1200x800.png', 'image/png', gradientPNG(1200, 800, [20, 120, 220], [250, 200, 40], { toCorner: true }))
const svgId = asset('vector-400x300.svg', 'image/svg+xml', svgImage('SVG', '#6c5ce7'))
const bigId = asset('big-noise-~10MB.png', 'image/png', noisyPNG(10.8 * 1024 * 1024))
asset('legacy-embedded-A (NOT in assets)', 'image/png', solidPNG(48, 48, [46, 204, 113]), { write: false })
asset('legacy-embedded-B (NOT in assets)', 'image/png', solidPNG(48, 48, [155, 89, 182]), { write: false })
const missingId = fileIdFor(Buffer.from('this asset is missing on purpose')) // nothing is ever written for it
const heavyIds = []
const HEAVY_COLOURS = [
  [231, 76, 60], [230, 126, 34], [241, 196, 15], [46, 204, 113], [26, 188, 156],
  [52, 152, 219], [155, 89, 182], [52, 73, 94], [149, 165, 166], [255, 121, 198],
]
HEAVY_COLOURS.forEach((c, i) => heavyIds.push(asset(`heavy-${String(i + 1).padStart(2, '0')}-300x200.png`, 'image/png', gradientPNG(300, 200, c, [255, 255, 255], { toCorner: true }))))
asset('orphan-old (mtime 3 days ago)', 'image/png', solidPNG(32, 32, [90, 90, 90]))
asset('orphan-fresh (mtime now)', 'image/png', solidPNG(32, 32, [200, 200, 200]))
console.log(`   images generated in ${Date.now() - t0} ms`)

console.log('== writing assets/')
for (const [name, a] of assets) {
  if (!a.write) continue
  fs.writeFileSync(a.file, a.bytes)
  console.log(`   ${path.basename(a.file).padEnd(45)} ${String(a.bytes.length).padStart(10)} B  ${name}`)
}
const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000)
fs.utimesSync(assets.get('orphan-old (mtime 3 days ago)').file, threeDaysAgo, threeDaysAgo)
fs.writeFileSync(
  path.join(ASSETS, 'README-DEMO.txt'),
  [
    'Trevor Draw demo vault — asset map (fileId = lowercase SHA-1 hex of the bytes, i.e. Excalidraw generateIdFromFile)',
    '',
    ...[...assets].map(([name, a]) => `${assetFileName(a.id, a.mime)}  ${a.write ? '' : '(NOT written) '}${name}`),
    `${missingId}.png  missing-on-purpose (referenced by "04 Missing asset", never written)`,
    '',
    'Orphans (referenced by no board): orphan-old, orphan-fresh.',
    'Not-written: the two legacy-embedded PNGs live only as dataURLs inside "03 Legacy embedded.excalidraw".',
    '',
  ].join('\n'),
)

console.log('== writing boards')
const boards = {}
const add = (rel, content) => {
  boards[rel] = writeFile(rel, content)
}

// Welcome
{
  const lines = [
    'Trevor Draw — stress-test vault',
    '01 simple shapes',
    '02 images from assets/',
    '03 legacy embedded dataURLs',
    '04 missing asset',
    '05 image heavy (40 refs, 10 files)',
    '06 big image (~10 MB PNG)',
    '07 corrupt JSON',
    '08 empty file',
    '09 upstream minimal',
    '10/11 nested + unicode',
    '12 shares image with 02',
    '13 fifty boards',
  ]
  const els = [rect(0, 60, 40, 560, 60 + lines.length * 34, { backgroundColor: '#fff3bf', fillStyle: 'hachure' })]
  lines.forEach((l, i) => els.push(text(i + 1, 90, 70 + i * 34, l, i === 0 ? 28 : 20)))
  add('Welcome.excalidraw', board(els))
}

// 01 Simple shapes
add(
  '01 Simple shapes.excalidraw',
  board([
    rect(0, 100, 100, 200, 120, { backgroundColor: '#a5d8ff' }),
    rect(1, 360, 100, 200, 120, { backgroundColor: '#b2f2bb' }),
    rect(2, 620, 100, 200, 120, { backgroundColor: '#ffc9c9' }),
    text(3, 100, 260, 'Three rectangles, no images.'),
    text(4, 100, 300, 'Pure-vector baseline board.'),
  ]),
)

// 02 Images from assets
add(
  '02 Images from assets.excalidraw',
  board([
    image(0, 100, 100, 256, 256, tinyId),
    image(1, 420, 100, 600, 400, mediumId),
    image(2, 1080, 100, 400, 300, svgId),
    text(3, 100, 540, 'tiny 64x64 png · medium 1200x800 png · svg — all from assets/'),
  ]),
)

// 03 Legacy embedded (upstream-style files map, bytes NOT in assets/)
{
  const a = assets.get('legacy-embedded-A (NOT in assets)')
  const b = assets.get('legacy-embedded-B (NOT in assets)')
  const files = {}
  for (const f of [a, b]) files[f.id] = embedded(f.id, f.bytes, { mime: f.mime, created: NOW })
  add(
    '03 Legacy embedded.excalidraw',
    board([image(0, 100, 100, 240, 240, a.id), image(1, 420, 100, 240, 240, b.id), text(2, 100, 380, 'Both images are embedded as dataURL in "files" — first save should extract them to assets/.')], { files }),
  )
}

// 04 Missing asset
add('04 Missing asset.excalidraw', board([image(0, 100, 100, 320, 240, missingId), text(1, 100, 380, 'image is missing on purpose')]))

// 05 Image heavy 40 (8x5 grid, 10 distinct PNGs x4)
{
  const els = []
  for (let n = 0; n < 40; n++) {
    const col = n % 8
    const row = Math.floor(n / 8)
    els.push(image(n, 60 + col * 340, 60 + row * 240, 300, 200, heavyIds[n % 10]))
  }
  add('05 Image heavy 40.excalidraw', board(els))
}

// 06 Big image 10MB
{
  const big = assets.get('big-noise-~10MB.png')
  add('06 Big image 10MB.excalidraw', board([image(0, 100, 100, 1200, 1200, bigId), text(1, 100, 1340, `one ~${(big.bytes.length / 1024 / 1024).toFixed(1)} MB noisy PNG`)]))
}

// 07 Corrupt, 08 Empty, 09 Upstream minimal
add('07 Corrupt.excalidraw', '{"type": "excalidraw", "elements": [')
add('08 Empty file.excalidraw', '')
add('09 Upstream minimal.excalidraw', board([], { viewBackgroundColor: '#f5f5f5' }))

// 10 / 11 nested
add('Folder A/10 Nested board.excalidraw', board([rect(0, 100, 100, 240, 140, { backgroundColor: '#d0bfff' }), rect(1, 400, 100, 240, 140, { backgroundColor: '#ffd8a8' })]))
add('Folder A/Sub folder/11 Deep unicode 🎨 ünïcødé.excalidraw', board([text(0, 100, 100, 'Deep, nested, unicode file name 🎨 ünïcødé')]))

// 12 shares the medium png with 02
add('12 Shares image with 02.excalidraw', board([image(0, 100, 100, 600, 400, mediumId), text(1, 100, 540, 'same fileId as the medium png in board 02 (dedupe)')]))

// 13 Fifty boards
for (let n = 1; n <= 50; n++) {
  const nn = String(n).padStart(2, '0')
  add(`13 Fifty boards/Board ${nn}.excalidraw`, board([rect(0, 100, 100, 200 + n * 4, 120, { backgroundColor: `hsl(${(n * 37) % 360}, 70%, 85%)` }), text(1, 100, 260, `Board ${nn}`)]))
}

// non-drawing files
writeFile('notes.md', '# Demo vault notes\n\n- This vault stress-tests Trevor Draw.\n- Drawings are `*.excalidraw`; image bytes live in `assets/<sha1>.<ext>`.\n- See `Welcome.excalidraw` for the scenario list.\n')
writeFile('random.txt', 'just a plain text file — not a drawing\n')
writeFile('photo.jpg', TINY_JPEG)

console.log(`   ${Object.keys(boards).length} boards written`)

// ---------------------------------------------------------------- git
console.log('== git')
git(['init', '-q', '-b', 'main'])
git(['add', '-A'])
git(['commit', '-q', '-m', 'seed demo vault'])
git(['init', '-q', '--bare', '-b', 'main', ORIGIN], path.dirname(ORIGIN))
git(['remote', 'add', 'origin', ORIGIN])
git(['push', '-q', '-u', 'origin', 'main'])
// The per-vault sync switch (🔒 YAZ-1775 D1: the dotfolder is `.yaseendraw/`, not the docs app's name).
writeFile('.yaseendraw/github.json', JSON.stringify({ enabled: true }, null, 2) + '\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'enable github sync'])
git(['push', '-q', 'origin', 'main'])
console.log('   ' + git(['log', '--oneline']).replace(/\n/g, '\n   '))

console.log('\nDone.')
console.log(`vault:  ${VAULT}`)
console.log(`origin: ${ORIGIN}`)
console.log(`Open it in the app with the vault switcher's "Open folder…" (⌘O). Assets map: ${path.join(ASSETS, 'README-DEMO.txt')}`)
