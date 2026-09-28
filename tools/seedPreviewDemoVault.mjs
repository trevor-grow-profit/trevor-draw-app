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
import fs from 'node:fs'
import path from 'node:path'
import { asset as assetIn, dirFlag, elementKit, gradientPNG, refuseExisting, required, scene, stripesPNG, wipe, write as writeIn, writeProfile } from './lib/seedKit.mjs'

const USAGE = 'usage: node tools/seedPreviewDemoVault.mjs --vault <dir> [--profile <dir>] [--force]'
const VAULT = required(dirFlag('--vault'), USAGE)
const PROFILE = dirFlag('--profile')
for (const dir of [VAULT, PROFILE].filter(Boolean)) {
  refuseExisting(dir, USAGE)
  if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755)
}
// A chmod-000 board from a previous run would stop rmSync; open it up first.
const locked = path.join(VAULT, 'Locked — chmod 000, cannot be read.excalidraw')
if (fs.existsSync(locked)) fs.chmodSync(locked, 0o644)
wipe(VAULT)
fs.mkdirSync(VAULT, { recursive: true })

// ---------------------------------------------------------------- elements and writers
const { rect, ellipse, arrow, text, image, frame } = elementKit('p')
const write = (rel, content) => writeIn(VAULT, rel, content)
const board = (rel, elements, opts) => write(`${rel}.excalidraw`, scene('yaz-1800-demo', elements, opts))
const asset = (bytes, opts) => assetIn(VAULT, bytes, opts)
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
const small = asset(gradientPNG(240, 240, [255, 107, 107], [77, 171, 247]))
const wide = asset(stripesPNG(800, 300))
board('09 Images — three pictures from assets', [...label('Three images', 'bytes live in assets/'), image(0, 0, 240, 240, small), image(280, 0, 400, 150, wide), image(280, 180, 240, 240, small)])
const large = asset(gradientPNG(2400, 1600, [20, 20, 60], [250, 200, 80]))
board('10 Large image — 2400×1600 picture', [image(0, 0, 1200, 800, large), text(0, 820, 'One large image scaled into the board', 24)])
const gone = asset(gradientPNG(64, 64, [0, 0, 0], [255, 255, 255]), { onDisk: false })
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
write('photo.png', gradientPNG(120, 80, [0, 128, 0], [255, 255, 0]))

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
  wipe(PROFILE)
  writeProfile(PROFILE, VAULT, { theme: 'light' })
  console.log(`profile ${PROFILE}`)
}
