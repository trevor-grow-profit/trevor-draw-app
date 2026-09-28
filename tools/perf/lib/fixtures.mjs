/**
 * The perf fixtures (YAZ-2073 1B): boards, vaults and an isolated app profile, generated from a
 * seeded RNG so every run and every machine measures the same bytes, and nothing big is committed.
 * Every asset a fixture writes is referenced by a board — the orphan sweep never has anything to trash.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileIdFor, fracIndex } from '../../lib/seedDemoVault.mjs'
import { json, pngFromRaw, scene as sceneOf, writeProfile as writeKitProfile } from '../../lib/seedKit.mjs'

/** mulberry32: a tiny seeded PRNG, uniform in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An RGB PNG like a screenshot: a flat background with a dozen coloured panels, so it decodes at full size but stays small on disk. */
export function screenshotPng(width, height, rand) {
  const stride = width * 3 + 1 // each scanline leads with filter byte 0
  const raw = Buffer.alloc(stride * height)
  const colour = () => [0, 0, 0].map(() => Math.floor(rand() * 256))
  const fill = (x0, y0, w, h, rgb) => {
    const x1 = Math.min(width, x0 + w)
    const row = Buffer.alloc(Math.max(0, x1 - x0) * 3)
    for (let k = 0; k < row.length; k += 3) row.set(rgb, k)
    for (let y = y0; y < Math.min(height, y0 + h); y++) row.copy(raw, y * stride + 1 + x0 * 3)
  }
  fill(0, 0, width, height, colour())
  for (let k = 0; k < 12; k++) fill(Math.floor(rand() * width), Math.floor(rand() * height), Math.floor(rand() * width * 0.5), Math.floor(rand() * height * 0.5), colour())
  return pngFromRaw(width, height, raw)
}

/** An RGB PNG of noise: incompressible, so its size on disk is its pixel count × 3. */
export function noisePng(width, height, rand) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let i = 0; i < raw.length; i++) raw[i] = i % (width * 3 + 1) === 0 ? 0 : Math.floor(rand() * 256)
  return pngFromRaw(width, height, raw)
}

const COLOURS = ['#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff', '#ffd8a8']
const SHAPES = ['rectangle', 'ellipse', 'diamond']

function element(i, rand, props) {
  return {
    id: `perf-${i.toString(36)}-${Math.floor(rand() * 2 ** 31).toString(36)}`,
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: 1, opacity: 100, groupIds: [], frameId: null, index: fracIndex(i), roundness: null,
    seed: 1 + Math.floor(rand() * (2 ** 31 - 1)), version: 1, versionNonce: 1 + Math.floor(rand() * (2 ** 31 - 1)),
    isDeleted: false, boundElements: null, updated: 1_790_000_000_000, link: null, locked: false,
    ...props,
  }
}

const scene = (elements) => json(sceneOf('yaseen-draw-perf', elements))

/** `n` filled, hand-drawn shapes on a grid: the drag / pan / zoom scene (1k and 4k are the scope's sizes). */
export function shapesBoard(n, seed) {
  const rand = rng(seed)
  const cols = Math.ceil(Math.sqrt(n * 1.6))
  return scene(Array.from({ length: n }, (_, i) => element(i, rand, {
    type: SHAPES[i % 3], x: (i % cols) * 120, y: Math.floor(i / cols) * 90, width: 90, height: 60,
    backgroundColor: COLOURS[Math.floor(rand() * COLOURS.length)], roundness: i % 3 === 0 ? { type: 3 } : null,
  })))
}

/** Writes `count` screenshot-sized PNGs into `<vault>/assets/` (content-addressed, 🔒 YAZ-1775 D3) and returns a board placing all of them. */
export function imageBoard(vault, count, seed, { width = 1440, height = 822 } = {}) {
  const rand = rng(seed)
  fs.mkdirSync(path.join(vault, 'assets'), { recursive: true })
  const cols = Math.ceil(Math.sqrt(count))
  return scene(Array.from({ length: count }, (_, i) => {
    const bytes = screenshotPng(width, height, rand)
    const fileId = fileIdFor(bytes)
    fs.writeFileSync(path.join(vault, 'assets', `${fileId}.png`), bytes)
    return element(i, rand, { type: 'image', x: (i % cols) * 400, y: Math.floor(i / cols) * 250, width: 360, height: Math.round((360 * height) / width), fileId, status: 'saved', scale: [1, 1], crop: null })
  }))
}

/**
 * A LEGACY board: its images embedded as base64 dataURLs in `files`, as boards were before the
 * assets folder (🔒 YAZ-1775 D3). 15 noise images of 900×600 make it ~32 MB, the scope's 31 MB board.
 */
export function legacyBoard(count, seed, { width = 900, height = 600 } = {}) {
  const rand = rng(seed)
  const files = {}
  const elements = Array.from({ length: count }, (_, i) => {
    const bytes = noisePng(width, height, rand)
    const fileId = fileIdFor(bytes)
    files[fileId] = { mimeType: 'image/png', id: fileId, dataURL: `data:image/png;base64,${bytes.toString('base64')}`, created: 1_790_000_000_000 }
    return element(i, rand, { type: 'image', x: (i % 4) * 400, y: Math.floor(i / 4) * 300, width: 360, height: 240, fileId, status: 'saved', scale: [1, 1], crop: null })
  })
  return `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw-perf', elements, appState: { viewBackgroundColor: '#ffffff' }, files })}\n`
}

/** A plain-XML draw.io flowchart of `n` boxes chained by edges. */
export function flowDiagram(n) {
  const cells = []
  for (let i = 0; i < n; i++) {
    cells.push(`<mxCell id="v${i}" value="Step ${i + 1}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${(i % 6) * 180}" y="${Math.floor(i / 6) * 120}" width="140" height="60" as="geometry"/></mxCell>`)
    if (i > 0) cells.push(`<mxCell id="e${i}" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="v${i - 1}" target="v${i}"><mxGeometry relative="1" as="geometry"/></mxCell>`)
  }
  return `<mxfile host="yaseen-draw-perf"><diagram id="perf" name="Page-1"><mxGraphModel grid="0" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>\n`
}

/** `folders` × `perFolder` 75-shape boards: the 2 000-board vault the tree-storm scenario rewrites. */
export function writeBoardVault(vault, folders, perFolder, seed) {
  const board = shapesBoard(75, seed)
  const files = []
  for (let d = 0; d < folders; d++) {
    const dir = path.join(vault, `folder-${String(d).padStart(3, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let f = 0; f < perFolder; f++) {
      files.push(path.join(dir, `board-${String(f).padStart(2, '0')}.excalidraw`))
      fs.writeFileSync(files.at(-1), board)
    }
  }
  return files
}

/**
 * An isolated profile (`YASEEN_DRAW_USER_DATA_DIR`) whose one window is already on `vault` with
 * `file` open — light theme unless asked, fixed bounds, previews on — so a launch needs no dialog and never
 * reads the real profile (LAUNCH.md "Behaviour checks").
 */
export function writeProfile(profile, vault, file, { theme = 'light' } = {}) {
  writeKitProfile(profile, vault, { id: 'perf-win', theme, settings: { hoverPreview: true }, sidebarWidth: 260, lastOpened: 1_790_000_000_000, file, tabs: [file], bounds: { x: 80, y: 60, width: 1280, height: 820 } })
}

const MARKER = '.yaseen-draw-perf'

/**
 * The `--work` root, made ours: fixtures under it are wiped and rewritten on every run, so a
 * folder that already holds anything and was not made by this harness (a vault, a home folder) is
 * refused. `dirFor` answers a scenario's folder inside it and nothing outside it.
 */
export function claimWorkDir(root) {
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0 && !fs.existsSync(path.join(root, MARKER))) throw new Error(`refusing to use ${root} as the perf work dir: it is not empty and was not made by tools/perf`)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, MARKER), 'fixtures and profiles written by tools/perf — safe to delete\n')
  return {
    dirFor(name) {
      const dir = path.resolve(root, name)
      if (path.dirname(dir) !== path.resolve(root)) throw new Error(`${name} is not a folder name`)
      return dir
    },
  }
}
