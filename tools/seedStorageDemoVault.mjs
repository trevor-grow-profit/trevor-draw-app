#!/usr/bin/env node
/**
 * USAGE: node tools/seedStorageDemoVault.mjs --root <dir> [--force]
 *
 * The demo behind YAZ-1801 "Board Size Considerations" — Settings › Storage, the oversize-file
 * sync guard and "Move pictures out of boards". Everything it writes lives under `<root>`:
 *
 *   <root>/remote.git/                                   a LOCAL bare repo standing in for GitHub (never GitHub)
 *   <root>/Board Size Considerations (YAZ-1801)/         the vault: a git repo, origin → remote.git, upstream set,
 *                                                        a local identity, `.yaseendraw/github.json` = on, and a
 *                                                        few commits of history so "old versions" is not zero
 *   <root>/Board Size Considerations (YAZ-1801) - no git/  a small plain folder: the "Not a git repo" state
 *   <root>/yaseendraw.json                               an app-state file opening the main vault — launch with
 *                                                        YASEEN_DRAW_USER_DATA_DIR=<root>
 *
 * The boards, each named for what it proves: a modern lean board; legacy boards with 3 small,
 * ~45 MB and ~60 MB (amber) of embedded pictures; a ~110 MB board that is left UNCOMMITTED so the
 * first sync hits the 95 MiB guard (D3); two boards embedding the SAME picture (dedupe); a nested
 * legacy board; corrupt JSON; an embedded picture nothing references; a malformed dataURL; and a
 * 120 MB `Big video.mov` (sparse, also uncommitted) proving the guard is about any file. Every
 * legacy board carries a `yaseendraw` block dated 2026-01-15, so the demo can show `updatedAt`
 * does not move after "Move pictures out of boards". Pictures are noisy PNGs (incompressible),
 * generated here — nothing is downloaded. Disk: roughly 450 MB.
 *
 * `--root` IS REQUIRED AND IS WIPED (the `seedDemoVault.mjs` rule): no default, an existing path is
 * refused unless `--force`, and a root that is or contains the real vault or the real app-state
 * folder is refused outright, `--force` or not.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assetFileName, fileIdFor } from './lib/seedDemoVault.mjs'
import { cli, embedded, git, identity, indexedKit, json, noiseRaw, pngFromRaw, refuseExisting, scene as sceneOf, wipe, write, writeProfile } from './lib/seedKit.mjs'

const USAGE = 'usage: node tools/seedStorageDemoVault.mjs --root <dir> [--force]'
const args = cli(USAGE, { '--root': 'dir' }, ['--root'])
const ROOT = args.root

// ---------------------------------------------------------------- the safety guard
const HOME = os.homedir()
const PRECIOUS = [
  path.join(HOME, 'Documents', 'GitHub', 'yaseen-draw-vault'),
  path.join(HOME, 'Library', 'Application Support', 'Yaseen Draw'),
  HOME,
  '/',
]
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
for (const p of PRECIOUS) {
  // Wiping ROOT must not take any of these with it, and ROOT must not be one of them.
  if (inside(p, ROOT) || (p !== '/' && p !== HOME && inside(ROOT, p))) {
    console.error(`refusing: ${ROOT} is, contains or sits inside ${p}`)
    process.exit(2)
  }
}
refuseExisting(ROOT, USAGE, { what: 'path', force: args.force })
wipe(ROOT)
fs.mkdirSync(ROOT, { recursive: true })
// /tmp is a symlink on macOS; the app compares roots as strings, so everything is written real.
const REAL_ROOT = fs.realpathSync(ROOT)
const REMOTE = path.join(REAL_ROOT, 'remote.git')
const VAULT = path.join(REAL_ROOT, 'Board Size Considerations (YAZ-1801)')
const PLAIN = path.join(REAL_ROOT, 'Board Size Considerations (YAZ-1801) - no git')


const MB = 1024 * 1024
const CREATED = Date.UTC(2026, 0, 15, 10, 0)
const UPDATED = Date.UTC(2026, 0, 15, 12, 0)
const BLOCK = { createdAt: CREATED, updatedAt: UPDATED }

// ---------------------------------------------------------------- noisy PNGs
/** The share of each picture's rows given to its colour band. */
const BAND = 0.1
/**
 * An RGB PNG of about `bytes`, mostly noise so it neither compresses nor dedupes: every image is
 * unique, and its size on disk is its size in git. A tinted band across the top keeps each one
 * tellable apart on the canvas.
 */
function noisyPNG(bytes, [r, g, b]) {
  // The band compresses to nothing, so the noise below it is sized to carry the whole target.
  const side = Math.max(16, Math.ceil(Math.sqrt(bytes / 3 / (1 - BAND))))
  const stride = 1 + side * 3
  const raw = noiseRaw(side, side)
  for (let y = 0; y < Math.floor(side * BAND); y++)
    for (let x = 0; x < side; x++) raw.set([r, g, b], y * stride + 1 + x * 3)
  const png = pngFromRaw(side, side, raw, { level: 1 })
  return { id: fileIdFor(png), mime: 'image/png', bytes: png, side }
}
const COLORS = [
  [230, 73, 128],
  [34, 139, 230],
  [64, 192, 87],
  [250, 176, 5],
  [132, 94, 247],
  [21, 170, 191],
  [253, 126, 20],
  [73, 80, 87],
]
const pics = (count, bytesEach, offset = 0) => Array.from({ length: count }, (_, i) => noisyPNG(bytesEach, COLORS[(i + offset) % COLORS.length]))
/** The decoded bytes whose base64 is `embeddedBytes` long. */
const decodedFor = (embeddedBytes) => Math.floor((embeddedBytes * 3) / 4)

// ---------------------------------------------------------------- scenes
let seq = 1
// Ids `t1`, `i2`…: one counter across texts and images, no Math.random.
const { text, image } = indexedKit({ newId: (type) => `${type[0]}${seq++}`, updated: UPDATED, strokeWidth: 1, roughness: 0 })

/** A scene with a title line and its pictures in a row, the `yaseendraw` block FIRST (🔒 YAZ-1834). */
function scene(title, pictures, { embed = true, extraFiles = {}, extraElements = [] } = {}) {
  const elements = [text(0, 0, -80, title, 24), ...pictures.map((p, n) => image(n + 1, n * 440, 0, 400, 400, p.id)), ...extraElements]
  const files = {}
  if (embed) for (const p of pictures) files[p.id] = embedded(p.id, p.bytes, { mime: p.mime, created: CREATED })
  Object.assign(files, extraFiles)
  return json(sceneOf('yaz-1801-demo', elements, { block: BLOCK, files }))
}
const mb = (file) => `${(fs.statSync(file).size / MB).toFixed(1)} MB`
const commit = (message) => {
  git(VAULT, ['add', '-A'])
  git(VAULT, ['commit', '-q', '-m', message])
  console.log(`  commit: ${message}`)
}

// ---------------------------------------------------------------- the "GitHub"
git(REAL_ROOT, ['init', '-q', '--bare', '-b', 'main', REMOTE])

// ---------------------------------------------------------------- the vault
fs.mkdirSync(VAULT, { recursive: true })
git(VAULT, ['init', '-q', '-b', 'main'])
identity(VAULT, 'YAZ-1801 Demo', 'demo@example.invalid')
git(VAULT, ['remote', 'add', 'origin', REMOTE])
write(VAULT, '.yaseendraw/github.json', `${JSON.stringify({ enabled: true })}\n`)

console.log(`vault: ${VAULT}`)

// 1. Modern and lean: pictures already in assets/, `files: {}`.
const clean = pics(2, 200 * 1024, 0)
for (const p of clean) write(VAULT, path.join('assets', assetFileName(p.id, p.mime)), p.bytes)
write(VAULT, 'Small clean board.excalidraw', scene('Small clean board — pictures already in assets/', clean, { embed: false }))

// 2. Legacy, three small pictures — first version (replaced below, so history has an old one).
write(VAULT, 'Legacy - few pictures.excalidraw', scene('Legacy — few pictures (v1)', pics(3, 450 * 1024, 1)))
commit('seed: clean board, legacy v1')
const few = pics(3, 500 * 1024, 3)
write(VAULT, 'Legacy - few pictures.excalidraw', scene('Legacy — few pictures', few))
commit('seed: legacy few pictures v2')

// 3. Heavy legacy (~45 MB of embedded), then one picture swapped: ~7 MB of "old versions".
const heavyPics = pics(6, decodedFor(45 * MB) / 6, 0)
write(VAULT, 'Legacy - heavy (like Team VSL).excalidraw', scene('Legacy — heavy, like Team VSL', heavyPics))
commit('seed: heavy legacy board v1')
heavyPics[5] = noisyPNG(decodedFor(45 * MB) / 6, COLORS[7])
write(VAULT, 'Legacy - heavy (like Team VSL).excalidraw', scene('Legacy — heavy, like Team VSL', heavyPics))
commit('seed: heavy legacy board v2 (one picture replaced)')

// 4. Over GitHub's 50 MB warning, under its 100 MB refusal: amber.
write(VAULT, 'Big but OK - 60 MB.excalidraw', scene('Big but OK — 60 MB (amber: GitHub warns)', pics(5, decodedFor(60 * MB) / 5, 2)))

// 6. Two boards embedding the SAME picture — "Move pictures out" stores it once.
const shared = noisyPNG(600 * 1024, COLORS[4])
write(VAULT, 'Shared picture A.excalidraw', scene('Shared picture A — same picture as B', [shared]))
write(VAULT, 'Shared picture B.excalidraw', scene('Shared picture B — same picture as A', [shared]))

// 7. Nested legacy board.
write(VAULT, 'Folder/Nested legacy.excalidraw', scene('Nested legacy board', pics(2, 400 * 1024, 5)))

// 8. Corrupt: shrink skips it, stats count its size.
write(VAULT, 'Corrupt board.excalidraw', '{ "yaseendraw": { "createdAt": 1768471200000, "updatedAt": 1768478400000 }, "type": "excalidraw", "elements": [ this is not json\n')

// 9. An embedded picture NO element references: shrink drops it and does not move it.
const orphan = noisyPNG(300 * 1024, COLORS[6])
write(
  VAULT,
  'Unreferenced embedded.excalidraw',
  scene('Unreferenced embedded — the picture in files{} is used by nothing', [], {
    extraFiles: { [orphan.id]: embedded(orphan.id, orphan.bytes, { created: CREATED }) },
  }),
)

// 11. One good picture and one whose dataURL is malformed (placeholder in the app; shrink drops it).
const good = noisyPNG(300 * 1024, COLORS[1])
const brokenId = 'b'.repeat(40)
write(
  VAULT,
  'Malformed picture data.excalidraw',
  scene('Malformed picture data — right-hand picture is broken on purpose', [good], {
    extraElements: [image(9, 440, 0, 400, 400, brokenId)],
    extraFiles: { [brokenId]: { mimeType: 'image/png', id: brokenId, dataURL: 'data:image/png;base64,@@not-base64@@', created: CREATED } },
  }),
)

commit('seed: 60 MB board, shared pictures, nested, corrupt, unreferenced, malformed')
git(VAULT, ['push', '-q', '-u', 'origin', 'main'])
console.log('  pushed to remote.git, upstream set')

// ---------- AFTER the last commit: the two files the first sync must hold back (D3) ----------
// 5. ~110 MB board: over the 95 MiB guard, under the app's 200 MiB read cap.
write(VAULT, 'Too big for GitHub - 110 MB.excalidraw', scene('Too big for GitHub — 110 MB', pics(8, decodedFor(110 * MB) / 8, 1)))
// 10. A 120 MB non-board file: sparse (costs no disk), and the guard is about ANY file.
const video = write(VAULT, 'Big video.mov', '')
fs.truncateSync(video, 120 * MB)

for (const rel of ['Small clean board.excalidraw', 'Legacy - few pictures.excalidraw', 'Legacy - heavy (like Team VSL).excalidraw', 'Big but OK - 60 MB.excalidraw', 'Too big for GitHub - 110 MB.excalidraw', 'Big video.mov']) {
  console.log(`  ${rel.padEnd(44)} ${mb(path.join(VAULT, rel))}`)
}

// ---------------------------------------------------------------- the plain folder (not a repo)
write(PLAIN, 'Plain board.excalidraw', scene('Plain board — this folder is not a git repo', [noisyPNG(200 * 1024, COLORS[2])]))
write(PLAIN, 'Another board.excalidraw', scene('Another board', [], { embed: false }))
console.log(`plain folder: ${PLAIN}`)

// ---------------------------------------------------------------- the app state
const tabs = [path.join(VAULT, 'Legacy - few pictures.excalidraw'), path.join(VAULT, 'Small clean board.excalidraw')]
const recents = [
  { path: VAULT, lastOpened: Date.now() },
  { path: PLAIN, lastOpened: Date.now() - 1000 },
]
const folders = { [VAULT]: { lastFile: tabs[0], sortOrder: 'name' } }
console.log(`app state: ${writeProfile(REAL_ROOT, VAULT, { sidebarWidth: 280, recents, file: tabs[0], tabs, bounds: { x: 80, y: 60, width: 1440, height: 900 }, folders })}`)
// `--watch`, not `npm run dev`: plain dev never restarts main, so a main-process edit during the demo is silently not running.
console.log(`\nlaunch (from the repo root): cd desktop && YASEEN_DRAW_USER_DATA_DIR="${REAL_ROOT}" npx electron-vite dev --watch`)
