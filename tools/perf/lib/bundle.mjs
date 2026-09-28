/**
 * The size and integrity half of `tools/perf/` (YAZ-2073 1A, 🔒 D17): what the shipped bundle weighs,
 * and the invariants a bundle or shell change can break SILENTLY — no unit test ever sees the
 * packaged bundle. Pure over the paths it is handed, so the suite drives it against temp dirs.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/** Bytes of a file, or of a directory tree (symlinks not followed — the framework is full of them); null when absent. */
export function bytes(p) {
  const s = statSync(p, { throwIfNoEntry: false })
  if (!s) return null
  if (!s.isDirectory()) return s.size
  let n = 0
  for (const e of readdirSync(p, { withFileTypes: true })) if (!e.isSymbolicLink()) n += bytes(join(p, e.name)) ?? 0
  return n
}

/** Every file under `root`, as `/`-joined relative paths. */
export function walk(root, rel = '') {
  const out = []
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(root, r))
    else out.push(r)
  }
  return out
}

/**
 * `app.asar`'s file index, read from its header `[u32 4][u32 pickle][u32 payload][u32 jsonLen][json]`:
 * path → size and the byte offset of the file's contents in the archive (they follow the pickle;
 * null for a file kept outside it in `app.asar.unpacked`).
 */
export function asarIndex(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const json = Buffer.alloc(head.readUInt32LE(12))
    readSync(fd, json, 0, json.length, 16)
    const dataStart = 8 + head.readUInt32LE(4)
    const files = new Map()
    const visit = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name
        if (child.files) visit(child, p)
        else files.set(p, { size: child.size ?? 0, offset: child.unpacked ? null : dataStart + Number(child.offset) })
      }
    }
    visit(JSON.parse(json.toString('utf8')), '')
    return files
  } finally {
    closeSync(fd)
  }
}

const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']|new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g

/** A chunk's relative imports: static `from "./x.js"` is eager; `import("./x.js")` and `new URL("./x", import.meta.url)` are lazy. */
export function importsOf(src) {
  const eager = new Set()
  const lazy = new Set()
  for (const m of src.matchAll(SPEC)) {
    const dynamic = m[2] !== undefined || /import\s*\(/.test(m[0])
    ;(dynamic ? lazy : eager).add(m[1] ?? m[2])
  }
  return { eager, lazy }
}

/**
 * The chunk graph from `entries` inside `dir`: `eager` is what parses before first paint (the
 * static-import closure), `all` everything reachable, `missing` every import that names a file
 * that is not shipped — a lazily loaded engine feature that would only fail when first used.
 */
export function chunkGraph(dir, entries) {
  const eager = new Set()
  const all = new Set()
  const missing = []
  const visit = (file, isEager) => {
    if (isEager ? eager.has(file) : all.has(file)) return
    if (isEager) eager.add(file)
    all.add(file)
    if (!existsSync(join(dir, file))) return void missing.push(file)
    if (!/\.m?js$/.test(file)) return
    const { eager: e, lazy: l } = importsOf(readFileSync(join(dir, file), 'utf8'))
    const at = (s) => posix.normalize(posix.join(posix.dirname(file), s))
    for (const s of e) visit(at(s), isEager)
    for (const s of l) visit(at(s), false)
  }
  for (const f of entries) visit(f, true)
  return { eager, all, missing }
}

/** What `index.html` loads up front: its module scripts + modulepreloads, and its stylesheets. */
export function htmlEntries(html) {
  const refs = (re) => [...html.matchAll(re)].map((m) => m[1])
  return {
    js: [...refs(/<script[^>]+src="\.\/([^"]+)"/g), ...refs(/<link[^>]+rel="modulepreload"[^>]+href="\.\/([^"]+)"/g)],
    css: refs(/<link[^>]+rel="stylesheet"[^>]+href="\.\/([^"]+)"/g),
  }
}

/** Where the pieces of a build live: `out` is `desktop/out`; `app` / `dmg` are the packaged bundle (absent in `--out-only`). */
export function measure({ out, app, dmg }) {
  const m = {}
  if (app) {
    const res = join(app, 'Contents/Resources')
    const fwRes = join(app, 'Contents/Frameworks/Electron Framework.framework/Resources')
    m.appBytes = bytes(app)
    m.frameworksBytes = bytes(join(app, 'Contents/Frameworks'))
    m.asarBytes = bytes(join(res, 'app.asar'))
    m.shareViewerBytes = bytes(join(res, 'share-viewer'))
    m.dmgBytes = dmg ? bytes(dmg) : null
    m.lprojCount = existsSync(res) ? readdirSync(res).filter((n) => n.endsWith('.lproj')).length : null
    // Chromium's own UI strings, one locale.pak per language: afterPack drops all but the en* ones and never touches the app .lproj above (YAZ-2073 3B).
    m.chromiumLocaleBytes = existsSync(fwRes) ? readdirSync(fwRes).filter((n) => n.endsWith('.lproj')).reduce((n, d) => n + (bytes(join(fwRes, d, 'locale.pak')) ?? 0), 0) : null
    m.chromiumLocaleCount = existsSync(fwRes) ? readdirSync(fwRes).filter((n) => n.endsWith('.lproj')).length : null
    const asar = join(res, 'app.asar')
    m.asarNodeModulesFiles = existsSync(asar) ? [...asarIndex(asar).keys()].filter((k) => k.startsWith('node_modules/')).length : null
    m.duplicateBytes = existsSync(asar) ? duplicateBytes(asar, join(res, 'share-viewer')) : null
  }
  const r = join(out, 'renderer')
  if (existsSync(join(r, 'index.html'))) {
    const { js, css } = htmlEntries(readFileSync(join(r, 'index.html'), 'utf8'))
    const g = chunkGraph(r, js)
    m.rendererEagerJsBytes = [...g.eager].reduce((n, f) => n + (bytes(join(r, f)) ?? 0), 0)
    m.rendererEagerCssBytes = css.reduce((n, f) => n + (bytes(join(r, f)) ?? 0), 0)
    m.rendererReachableChunks = [...g.all].filter((f) => /\.m?js$/.test(f)).length
    m.rendererTotalBytes = bytes(r)
    m.rendererMapBytes = walk(r).filter((f) => f.endsWith('.map')).reduce((n, f) => n + statSync(join(r, f)).size, 0)
  }
  m.mainBundleBytes = bytes(join(out, 'main'))
  return m
}

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')

/**
 * Bytes the bundle carries twice (size-forensics #8): share-viewer files byte-identical to a file
 * in `app.asar`, at any size — v0.1.11's second font set is 247 files of under 100 KB each. A
 * ceiling rather than a failure: 3C brings it to 0, and any new copy after that turns the gate red.
 */
export function duplicateBytes(asar, dir) {
  if (!existsSync(dir)) return 0
  const fd = openSync(asar, 'r')
  const inAsar = new Set()
  try {
    for (const { size, offset } of asarIndex(asar).values()) {
      if (size === 0 || offset === null) continue
      const buf = Buffer.alloc(size)
      readSync(fd, buf, 0, size, offset)
      inAsar.add(sha1(buf))
    }
  } finally {
    closeSync(fd)
  }
  return walk(dir).map((f) => readFileSync(join(dir, f))).filter((b) => b.length > 0 && inAsar.has(sha1(b))).reduce((n, b) => n + b.length, 0)
}

/** The 13 families the engine fetches from `app://yaseen/excalidraw-assets/fonts`; a missing one silently falls back to the esm.sh CDN. */
export const EXCALIDRAW_FONT_FAMILIES = ['Assistant', 'Cascadia', 'ComicShanns', 'Excalifont', 'IBMPlexMono', 'Inter', 'Liberation', 'LiberationSerif', 'Lilita', 'Nunito', 'Roboto', 'Virgil', 'Xiaolai']

/** Files every build must ship under `out/`. */
export const REQUIRED_OUT = [
  'main/index.js', 'preload/index.js', 'renderer/index.html',
  'drawio/index.html', 'drawio/yaseen-render.html', 'drawio/js/PreConfig.js', 'drawio/js/PostConfig.js',
  'drawio/js/yaseen-render.js', 'drawio/js/yaseen-render-config.js', 'drawio/yaseen-fonts/fonts.css',
  'drawio/LICENSE-drawio.txt', 'drawio/js/viewer-static.min.js', 'drawio/js/stencils.min.js', 'drawio/js/app.min.js',
]

/** `desktop/out` alone — what CI can check after `npm run build`, no packaging. */
export function checkOut(out) {
  const fails = []
  for (const p of REQUIRED_OUT) if (!existsSync(join(out, p))) fails.push(`out: missing ${p}`)
  for (const d of ['drawio/img', 'drawio/math4']) if (!existsSync(join(out, d)) || walk(join(out, d)).length === 0) fails.push(`out: ${d}/ is empty (shared diagrams draw blank / raw TeX)`)
  // Built via `?modulePath` (ipc/storage.ts); the tests build it with esbuild instead, so only this sees it go.
  if (!existsSync(join(out, 'main')) || !readdirSync(join(out, 'main')).some((f) => /storageWorker/.test(f))) fails.push('out: storage worker chunk missing (Settings › Storage / Move pictures out)')
  for (const fam of EXCALIDRAW_FONT_FAMILIES) {
    const dir = join(out, 'renderer/excalidraw-assets/fonts', fam)
    if (!existsSync(dir) || readdirSync(dir).length === 0) fails.push(`out: Excalidraw font family ${fam} missing (text falls back to the esm.sh CDN)`)
  }
  const r = join(out, 'renderer')
  if (existsSync(join(r, 'index.html'))) for (const f of chunkGraph(r, htmlEntries(readFileSync(join(r, 'index.html'), 'utf8')).js).missing) fails.push(`renderer: chunk ${f} is imported but not shipped`)
  return fails
}

/** The packaged `.app`: Info.plist, the ad-hoc seal, the asar payload and the share viewer. macOS only (plutil, codesign). */
export function checkApp(app) {
  if (!existsSync(app)) return [`no app at ${app}`]
  const fails = []
  // yaseendraw:// + .excalidraw/.drawio as Owner (🔒 YAZ-1775 D1, 🔒 YAZ-1802 D14): what makes open-url / open-file fire at all.
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]).toString())
  if (!(plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []).includes('yaseendraw')) fails.push('Info.plist: CFBundleURLSchemes lacks yaseendraw')
  for (const ext of ['excalidraw', 'drawio']) {
    const t = (plist.CFBundleDocumentTypes ?? []).find((d) => (d.CFBundleTypeExtensions ?? []).includes(ext))
    if (t?.LSHandlerRank !== 'Owner' || t?.CFBundleTypeRole !== 'Editor') fails.push(`Info.plist: .${ext} is not an Owner/Editor document type`)
  }
  if (plist.CFBundleIdentifier !== 'com.yasinarshad.yaseendraw') fails.push(`Info.plist: appId is ${plist.CFBundleIdentifier}`)
  // The deep ad-hoc seal (desktop/build/adhocSign.cjs): without it Gatekeeper calls a download "damaged".
  if (!/Signature=adhoc/.test(spawnSync('codesign', ['-dv', '--verbose=2', app]).stderr.toString())) fails.push('codesign: not ad-hoc sealed')
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
  } catch (e) {
    fails.push(`codesign --verify --deep --strict failed: ${String(e.stderr ?? e).slice(0, 300)}`)
  }
  // The afterPack locale trim (🔒 YAZ-2073 D3) keeps Chromium's English strings and every app .lproj marker.
  if (!existsSync(join(app, 'Contents/Frameworks/Electron Framework.framework/Resources/en.lproj/locale.pak'))) fails.push('locales: Chromium’s en.lproj/locale.pak is gone')
  if (!readdirSync(join(app, 'Contents/Resources')).some((n) => n.endsWith('.lproj') && !n.startsWith('en'))) fails.push('locales: only English .lproj markers left in Contents/Resources (Open/Save panels would stop following the OS language)')
  const idx = asarIndex(join(app, 'Contents/Resources/app.asar'))
  const under =(dir) => [...idx.keys()].filter((k) => k.startsWith(`out/${dir}/`))
  for (const p of REQUIRED_OUT) if (!idx.has(`out/${p}`)) fails.push(`asar: missing out/${p}`)
  for (const d of ['drawio/img', 'drawio/math4']) if (under(d).length === 0) fails.push(`asar: out/${d}/ is empty (shared diagrams draw blank / raw TeX)`)
  if (!under('main').some((f) => /storageWorker/.test(f))) fails.push('asar: storage worker chunk missing (Settings › Storage / Move pictures out)')
  for (const fam of EXCALIDRAW_FONT_FAMILIES) if (under(`renderer/excalidraw-assets/fonts/${fam}`).length === 0) fails.push(`asar: Excalidraw font family ${fam} missing (text falls back to the esm.sh CDN)`)
  // The share viewer (extraResources → share-viewer, YAZ-1883): uploaded only at "Set up sharing", so a broken one ships silently.
  const sv = join(app, 'Contents/Resources/share-viewer')
  if (!existsSync(sv)) return [...fails, 'share-viewer: missing from Contents/Resources']
  const files = walk(sv)
  // Its text fonts are the asar's (checked above), which share setup publishes as /assets/fonts/ (YAZ-2073 3C).
  if (files.some((f) => f.startsWith('fonts/'))) fails.push('share-viewer: ships its own fonts/ (share setup publishes the app’s one copy, YAZ-2073 3C)')
  if (!files.includes('drawio/config.js') || !files.includes('drawio/fonts.css')) fails.push('share-viewer: drawio/config.js or fonts.css missing (shared diagrams)')
  for (const f of chunkGraph(sv, files.filter((f) => /^[^/]+\.js$/.test(f))).missing) fails.push(`share-viewer: chunk ${f} is imported but not shipped`)
  return fails
}

/** Metrics over their ceiling. `tolerance` absorbs build-to-build jitter (a DMG differs by tens of bytes between identical builds). */
export function overBudget(metrics, ceilings, tolerance = 0) {
  const over = []
  for (const [k, { max }] of Object.entries(ceilings)) {
    if (max == null || metrics[k] == null) continue
    if (metrics[k] - max > max * tolerance) over.push(`${k} ${metrics[k]} > ceiling ${max}`)
  }
  return over
}
