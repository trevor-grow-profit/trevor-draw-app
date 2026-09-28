#!/usr/bin/env node
/**
 * USAGE: node tools/perf/exportPixels.mjs --out <dir> [--compare <dir>] [--app <.app> | --dev] [--work <dir>]
 *
 * The engine's pixel-identity gate (YAZ-2073 5A/5B): a vendored-engine bump that is meant to change
 * no pixels proves it here. Launches the built app on an isolated profile (never the real one), puts
 * a fixture scene into an empty board — every raster kind the engine decodes (PNG, JPEG, WebP, an
 * EXIF-rotated JPEG, a PNG with alpha, a tiny upscaled PNG, an animated GIF) plus an SVG, cropped,
 * flipped, rotated and rounded images, and text in Excalifont and Assistant — and writes to --out, once per theme:
 *   export-<case>-<theme>@<scale>.png   the engine's exportToBlob (as previews and "Export image" do)
 *   export-<case>-<theme>.svg           the engine's exportToSvg
 *   canvas-<theme>@<zoom>.png           a screenshot of the live canvas at a fixed viewport
 * With --compare, every file is diffed against the same name in an earlier run (PNGs pixel by pixel,
 * SVGs byte for byte); any difference exits 1.
 *   --app   a packaged bundle (default: desktop/dist-app/mac-arm64/Yaseen Draw.app)
 *   --dev   `desktop/out` under the workspace's Electron instead (after `npm run build`)
 *   --work  where the fixture vault and profile go (default: <tmpdir>/yaseen-draw-pixels); refused
 *           unless empty or made by tools/perf, since it is rewritten on every run
 * Run it on build A with --out a, then on build B with --out b --compare a.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wipe, writeProfile } from '../lib/seedKit.mjs'
import { launch, sleep } from './lib/app.mjs'
import { claimWorkDir } from './lib/fixtures.mjs'
import { pixelDiff } from './lib/pngPixels.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const opt = (name) => (argv.includes(`--${name}`) ? path.resolve(argv[argv.indexOf(`--${name}`) + 1]) : undefined)
const out = opt('out')
const compare = opt('compare')
if (!out) {
  console.error('usage: node tools/perf/exportPixels.mjs --out <dir> [--compare <dir>] [--app <.app> | --dev] [--work <dir>]')
  process.exit(2)
}
const work = claimWorkDir(opt('work') ?? path.join(os.tmpdir(), 'yaseen-draw-pixels'))
const bundle = opt('app') ?? path.join(repo, 'desktop/dist-app/mac-arm64/Yaseen Draw.app')
const app = argv.includes('--dev')
  ? { bin: createRequire(path.join(repo, 'desktop/package.json'))('electron'), args: [path.join(repo, 'desktop')] }
  : { bin: path.join(bundle, 'Contents/MacOS/Yaseen Draw'), args: [] }

// The engine and the editor, reached read-only through React's fibers: `engine` is the lazily loaded
// module a surface component holds, `App` the editor instance under `.excalidraw`.
const FIBERS = `(() => {
  const el = document.querySelector('.excalidraw')
  const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'))
  if (!key) return null
  let f = el[key]
  while (f && typeof f.stateNode?.getSceneElements !== 'function') f = f.return
  const app = f?.stateNode
  let root = el[key]
  while (root.return) root = root.return
  const queue = [root]
  while (queue.length) {
    const n = queue.shift()
    if (typeof n.memoizedProps?.engine?.exportToBlob === 'function') return { app, engine: n.memoizedProps.engine }
    if (n.child) queue.push(n.child)
    if (n.sibling) queue.push(n.sibling)
  }
  return null
})()`

/**
 * Builds the fixture files in the page (canvas encoders, so JPEG/WebP need no dependency here) and
 * returns them as `BinaryFiles`. Deterministic: a seeded PRNG paints every raster.
 */
const FIXTURE_FILES = `(async () => {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const paint = (w, h, alpha) => {
    const c = new OffscreenCanvas(w, h)
    const x = c.getContext('2d')
    const img = x.createImageData(w, h)
    for (let i = 0, p = 0; p < w * h; p++, i += 4) {
      const px = p % w, py = Math.floor(p / w), n = rand() * 50 - 25
      img.data[i] = 128 + 127 * Math.sin(px / 37) + n
      img.data[i + 1] = (py * 255) / h + n
      img.data[i + 2] = ((px + py) * 255) / (w + h) + n
      img.data[i + 3] = alpha ? (255 * px) / w : 255
    }
    x.putImageData(img, 0, 0)
    x.strokeStyle = '#fff'
    for (let i = 0; i < w; i += 40) { x.beginPath(); x.moveTo(i, 0); x.lineTo(w - i, h); x.stroke() }
    return c
  }
  const bytes = async (canvas, type) => new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.9 })).arrayBuffer())
  // EXIF orientation 6 (rotate 90° CW) as an APP1 segment right after the JPEG's SOI
  const withExif6 = (jpeg) => {
    const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]
    return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)])
  }
  // three flat 8×6 frames (red, green, blue), 150 ms each, looping
  const gif = Uint8Array.from(atob('R0lGODlhCAAGAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADwAAACwAAAAACAAGAAAIDgABCBxIsKDBgwgTDgwIACH5BAEPAAEALAAAAAAIAAYAgQCgAAAAAAAAAAAAAAgOAAEIHEiwoMGDCBMODAgAIfkEAQ8AAQAsAAAAAAgABgCBAAD/AAAAAAAAAAAACA4AAQgcSLCgwYMIEw4MCAA7'), (c) => c.charCodeAt(0))
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="5" y="5" width="190" height="110" rx="16" fill="#ffd43b" stroke="#1e1e1e" stroke-width="4"/><circle cx="60" cy="60" r="30" fill="#228be6"/></svg>')
  const photo = paint(1600, 1000, false)
  const raw = {
    png: [await bytes(photo, 'image/png'), 'image/png'],
    jpg: [await bytes(photo, 'image/jpeg'), 'image/jpeg'],
    webp: [await bytes(photo, 'image/webp'), 'image/webp'],
    exif: [withExif6(await bytes(paint(800, 500, false), 'image/jpeg')), 'image/jpeg'],
    alpha: [await bytes(paint(1200, 800, true), 'image/png'), 'image/png'],
    tiny: [await bytes(paint(40, 30, false), 'image/png'), 'image/png'],
    gif: [gif, 'image/gif'],
    svg: [svg, 'image/svg+xml'],
  }
  const files = {}
  for (const [name, [data, mimeType]] of Object.entries(raw)) {
    let bin = ''
    for (const b of data) bin += String.fromCharCode(b)
    files[name] = { id: name, mimeType, dataURL: 'data:' + mimeType + ';base64,' + btoa(bin), created: 1 }
  }
  return files
})()`

let n = 0
const base = (props) => ({
  id: `px-${++n}`, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
  roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${String.fromCharCode(64 + n)}`, roundness: null, seed: n * 7919, version: 1, versionNonce: n,
  isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...props,
})
const image = (fileId, width, height, props = {}) => base({ type: 'image', fileId, status: 'saved', width, height, scale: [1, 1], crop: null, strokeColor: 'transparent', ...props })
const crop = { x: 400, y: 250, width: 800, height: 500, naturalWidth: 1600, naturalHeight: 1000 }
/** name → the elements of one export case; laid out in a grid, all of them are the canvas scene. */
const CASES = {
  png: [image('png', 400, 250)],
  jpg: [image('jpg', 400, 250)],
  webp: [image('webp', 400, 250)],
  exif: [image('exif', 250, 400)],
  alpha: [image('alpha', 360, 240, { backgroundColor: '#a5d8ff', strokeColor: '#1e1e1e' })],
  tiny: [image('tiny', 320, 240)],
  gif: [image('gif', 320, 240)],
  svg: [image('svg', 400, 240)],
  cropped: [image('png', 400, 250, { crop })],
  flipX: [image('jpg', 400, 250, { scale: [-1, 1] })],
  flipY: [image('webp', 400, 250, { scale: [1, -1] })],
  rotated: [image('png', 400, 250, { angle: 0.5 })],
  rounded: [image('jpg', 400, 250, { roundness: { type: 3 } })],
  text: [base({ type: 'rectangle', width: 300, height: 120, backgroundColor: '#ffc9c9' }), base({ type: 'text', text: 'Pixel gate 123', originalText: 'Pixel gate 123', fontSize: 28, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true, width: 220, height: 35, x: 20, y: 40 }), base({ type: 'text', text: 'Assistant 456', originalText: 'Assistant 456', fontSize: 28, fontFamily: 10, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true, width: 220, height: 35, x: 20, y: 150 })],
}
Object.values(CASES).forEach((els, i) => els.forEach((e) => Object.assign(e, { x: (i % 5) * 480 + (e.x ?? 0), y: Math.floor(i / 5) * 460 + (e.y ?? 0) })))

const FILE_COUNT = new Set(Object.values(CASES).flat().map((e) => e.fileId).filter(Boolean)).size
const THEMES = ['light', 'dark']
const ZOOMS = [0.5, 1, 2]

fs.mkdirSync(out, { recursive: true })
const vault = work.dirFor('vault')
const board = path.join(vault, 'Pixels.excalidraw')
for (const theme of THEMES) {
  wipe(vault)
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(board, JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw-pixels', elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }))
  // An isolated profile whose one window sits on the board, in `theme`, sidebar folded, no previews.
  const profile = work.dirFor(`profile-${theme}`)
  wipe(profile)
  writeProfile(profile, vault, { id: 'pixels', theme, settings: { hoverPreview: false }, sidebarWidth: 260, recents: [], file: board, tabs: [board], sidebarCollapsed: true, bounds: { x: 80, y: 60, width: 1280, height: 820 } })
  const proc = await launch({ ...app, profile })
  const page = await proc.page()
  try {
    await page.waitFor(`!!${FIBERS}`)
    await page.ev(`window.__px = ${FIBERS}; window.__pxFiles = null; ${FIXTURE_FILES}.then((f) => { window.__pxFiles = f; return true })`)
    await page.ev(`(() => { const { engine } = window.__px; window.__pxCases = Object.fromEntries(Object.entries(${JSON.stringify(CASES)}).map(([k, v]) => [k, engine.restoreElements(v, null)])); return true })()`)
    // exports: each case alone, PNG at scale 1 and 2, and SVG
    const shots = await page.ev(`(async () => {
      const { engine } = window.__px, files = window.__pxFiles, out = {}
      const b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
      for (const [name, elements] of Object.entries(window.__pxCases)) {
        for (const scale of [1, 2]) {
          const blob = await engine.exportToBlob({ elements, files, mimeType: 'image/png', exportPadding: 10, appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: ${theme === 'dark'}, exportScale: scale } })
          out['export-' + name + '-${theme}@' + scale + '.png'] = await b64(blob)
        }
        const svg = await engine.exportToSvg({ elements, files, exportPadding: 10, appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: ${theme === 'dark'} } })
        out['export-' + name + '-${theme}.svg'] = btoa(unescape(encodeURIComponent(svg.outerHTML)))
      }
      return out
    })()`)
    // the live canvas: the whole fixture as the scene, at fixed viewports, once every image is decoded
    await page.ev(`(() => { const { app } = window.__px; app.addFiles(Object.values(window.__pxFiles)); app.updateScene({ elements: Object.values(window.__pxCases).flat() }); return true })()`)
    await page.waitFor(`(() => { const c = window.__px.app.imageCache; return c.size === ${FILE_COUNT} && [...c.values()].every((e) => !(e.image instanceof Promise)) })()`)
    const rect = await page.ev(`(() => { const r = document.querySelector('.excalidraw canvas.excalidraw__canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    // the canvases alone: the chrome over them (save chips, toolbars) is not the engine's drawing and varies with timing
    await page.ev(`(() => { const s = document.createElement('style'); s.textContent = 'body * { visibility: hidden !important } .excalidraw canvas { visibility: visible !important }'; document.head.append(s); return true })()`)
    for (const zoom of ZOOMS) {
      await page.ev(`(() => { window.__px.app.setState({ zoom: { value: ${zoom} }, scrollX: 40, scrollY: 40, selectedElementIds: {} }); return true })()`)
      await sleep(1500)
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } })
      shots[`canvas-${theme}@${zoom}.png`] = data
    }
    for (const [name, b64] of Object.entries(shots)) fs.writeFileSync(path.join(out, name), Buffer.from(b64, 'base64'))
  } finally {
    page.close()
    await proc.quit()
  }
}
console.log(`wrote ${fs.readdirSync(out).length} files to ${out}`)

if (compare) {
  let differs = 0
  for (const name of fs.readdirSync(out).sort()) {
    const before = path.join(compare, name)
    const result = !fs.existsSync(before) ? 'missing in --compare' : name.endsWith('.png') ? pixelDiff(fs.readFileSync(before), fs.readFileSync(path.join(out, name))) : fs.readFileSync(before).equals(fs.readFileSync(path.join(out, name))) ? 'same' : 'SVG text differs'
    if (result !== 'same') differs++
    console.log(`${result === 'same' ? 'same   ' : 'DIFFERS'}  ${name}${result === 'same' ? '' : `  — ${result}`}`)
  }
  console.log(differs === 0 ? 'pixel-identical' : `${differs} file(s) differ`)
  process.exitCode = differs === 0 ? 0 : 1
}
