import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { EXCALIDRAW_FONT_FAMILIES, REQUIRED_OUT, asarIndex, checkApp, checkOut, chunkGraph, duplicateBytes, importsOf, measure, overBudget } from './lib/bundle.mjs'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yd-bundle-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const put = (rel, body = 'x') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), body)
}

/** A `desktop/out` that passes every check: the entry imports one chunk eagerly and loads one lazily. */
function goodOut() {
  for (const p of REQUIRED_OUT) put(`out/${p}`)
  put('out/renderer/index.html', '<script type="module" crossorigin src="./assets/index-A.js"></script><link rel="stylesheet" crossorigin href="./assets/index-A.css">')
  put('out/renderer/assets/index-A.js', 'import{a}from"./react-B.js";const m=()=>import("./mermaid-C.js");')
  put('out/renderer/assets/react-B.js', 'export const a=1;'.padEnd(100))
  put('out/renderer/assets/mermaid-C.js', 'new Worker(new URL("./subset-worker.chunk.js", import.meta.url))')
  put('out/renderer/assets/subset-worker.chunk.js')
  put('out/renderer/assets/index-A.css', 'body{}')
  put('out/main/storageWorker-D.js')
  put('out/drawio/img/a.png')
  put('out/drawio/math4/b.js')
  for (const fam of EXCALIDRAW_FONT_FAMILIES) put(`out/renderer/excalidraw-assets/fonts/${fam}/a.woff2`)
  return path.join(dir, 'out')
}

describe('importsOf', () => {
  it('splits static imports from dynamic imports and worker URLs', () => {
    const { eager, lazy } = importsOf('import a from "./a.js";import{b}from"../b.js";import("./c.js");new URL("./w.js", import.meta.url);import x from "react"')
    expect([...eager]).toEqual(['./a.js', '../b.js'])
    expect([...lazy]).toEqual(['./c.js', './w.js'])
  })
})

describe('chunkGraph', () => {
  it('reports every reachable chunk, and which of them load before first paint', () => {
    const out = goodOut()
    const g = chunkGraph(path.join(out, 'renderer'), ['assets/index-A.js'])
    expect([...g.eager].sort()).toEqual(['assets/index-A.js', 'assets/react-B.js'])
    expect(g.all.size).toBe(4)
    expect(g.missing).toEqual([])
  })
})

describe('checkOut', () => {
  it('passes a complete build', () => {
    expect(checkOut(goodOut())).toEqual([])
  })

  it('fails when a lazily loaded chunk is imported but not shipped', () => {
    const out = goodOut()
    fs.rmSync(path.join(out, 'renderer/assets/subset-worker.chunk.js'))
    expect(checkOut(out)).toEqual(['renderer: chunk assets/subset-worker.chunk.js is imported but not shipped'])
  })

  it('fails when an Excalidraw font family is missing', () => {
    const out = goodOut()
    fs.rmSync(path.join(out, 'renderer/excalidraw-assets/fonts/Virgil'), { recursive: true })
    expect(checkOut(out)).toEqual(['out: Excalidraw font family Virgil missing (text falls back to the esm.sh CDN)'])
  })

  it('fails when the storage worker or a draw.io file is not built', () => {
    const out = goodOut()
    fs.rmSync(path.join(out, 'main/storageWorker-D.js'))
    fs.rmSync(path.join(out, 'drawio/js/PostConfig.js'))
    expect(checkOut(out)).toEqual(['out: missing drawio/js/PostConfig.js', 'out: storage worker chunk missing (Settings › Storage / Move pictures out)'])
  })
})

describe('measure', () => {
  it('sizes the eager JS closure, the eager CSS and any shipped sourcemaps', () => {
    const out = goodOut()
    put('out/renderer/assets/index-A.js.map', '0123456789')
    const m = measure({ out })
    const size = (f) => fs.statSync(path.join(out, 'renderer/assets', f)).size
    expect(m.rendererEagerJsBytes).toBe(size('index-A.js') + size('react-B.js'))
    expect(m.rendererEagerCssBytes).toBe(6)
    expect(m.rendererMapBytes).toBe(10)
    expect(m).not.toHaveProperty('appBytes')
  })
})

/** A real-format asar holding `files` (path → contents). */
function asar(rel, files) {
  const tree = { files: {} }
  let offset = 0
  for (const [p, body] of Object.entries(files)) {
    const parts = p.split('/')
    let node = tree
    for (const dirName of parts.slice(0, -1)) node = node.files[dirName] ??= { files: {} }
    node.files[parts.at(-1)] = { size: Buffer.byteLength(body), offset: String(offset) }
    offset += Buffer.byteLength(body)
  }
  const header = Buffer.from(JSON.stringify(tree))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(header.length + 8, 4)
  head.writeUInt32LE(header.length + 4, 8)
  head.writeUInt32LE(header.length, 12)
  put(rel, Buffer.concat([head, header, ...Object.values(files).map((b) => Buffer.from(b))]))
  return path.join(dir, rel)
}

describe('asarIndex', () => {
  it('reads every file path, size and content offset from the archive header', () => {
    const file = asar('app.asar', { 'out/main/index.js': 'main();', 'package.json': '{}' })
    const idx = asarIndex(file)
    expect([...idx.keys()]).toEqual(['out/main/index.js', 'package.json'])
    const bytes = fs.readFileSync(file)
    const { size, offset } = idx.get('package.json')
    expect(bytes.subarray(offset, offset + size).toString()).toBe('{}')
  })
})

describe('duplicateBytes', () => {
  it('counts share-viewer files byte-identical to one in the asar, at any size', () => {
    const file = asar('app.asar', { 'out/renderer/fonts/a.woff2': 'AAAA', 'out/renderer/b.js': 'bb' })
    put('sv/fonts/a.woff2', 'AAAA')
    put('sv/fonts/c.woff2', 'CCCCCC')
    expect(duplicateBytes(file, path.join(dir, 'sv'))).toBe(4)
  })
})

/** A packaged-looking `.app`: an Info.plist, an asar with everything `checkApp` requires, a share viewer, the app's .lproj markers and Chromium's English strings. Unsigned. */
function fakeApp(plist) {
  const app = path.join(dir, 'Fake.app')
  put('Fake.app/Contents/Info.plist', JSON.stringify(plist))
  execFileSync('plutil', ['-convert', 'xml1', path.join(app, 'Contents/Info.plist')])
  const files = Object.fromEntries([...REQUIRED_OUT, 'drawio/img/a.png', 'drawio/math4/b.js', 'main/storageWorker-D.js', ...EXCALIDRAW_FONT_FAMILIES.map((f) => `renderer/excalidraw-assets/fonts/${f}/a.woff2`)].map((p) => [`out/${p}`, 'x']))
  asar('Fake.app/Contents/Resources/app.asar', files)
  for (const p of ['viewer.js', 'drawio/config.js', 'drawio/fonts.css']) put(`Fake.app/Contents/Resources/share-viewer/${p}`)
  for (const l of ['en', 'de']) fs.mkdirSync(path.join(app, `Contents/Resources/${l}.lproj`))
  put('Fake.app/Contents/Frameworks/Electron Framework.framework/Resources/en.lproj/locale.pak')
  return app
}
const docType = (ext) => ({ CFBundleTypeExtensions: [ext], CFBundleTypeRole: 'Editor', LSHandlerRank: 'Owner' })
const PLIST = { CFBundleIdentifier: 'com.yasinarshad.yaseendraw', CFBundleURLTypes: [{ CFBundleURLSchemes: ['yaseendraw'] }], CFBundleDocumentTypes: [docType('excalidraw'), docType('drawio')] }

describe.skipIf(process.platform !== 'darwin')('checkApp', () => {
  it('passes a complete bundle except for the seal, which only a real build has', () => {
    expect(checkApp(fakeApp(PLIST)).filter((f) => !f.startsWith('codesign'))).toEqual([])
  })

  it('fails when .drawio is no longer an Owner document type, or the link scheme is gone', () => {
    const fails = checkApp(fakeApp({ ...PLIST, CFBundleURLTypes: [], CFBundleDocumentTypes: [docType('excalidraw'), { ...docType('drawio'), LSHandlerRank: 'Alternate' }] }))
    expect(fails).toContain('Info.plist: CFBundleURLSchemes lacks yaseendraw')
    expect(fails).toContain('Info.plist: .drawio is not an Owner/Editor document type')
  })

  it('fails a share viewer that ships its own fonts/ again: setup publishes the asar copy (YAZ-2073 3C)', () => {
    const app = fakeApp(PLIST)
    put('Fake.app/Contents/Resources/share-viewer/fonts/Virgil/a.woff2')
    expect(checkApp(app)).toContain('share-viewer: ships its own fonts/ (share setup publishes the app’s one copy, YAZ-2073 3C)')
  })

  it('fails a locale trim that took the English strings or the app .lproj markers with it (YAZ-2073 D3)', () => {
    const app = fakeApp(PLIST)
    fs.rmSync(path.join(app, 'Contents/Resources/de.lproj'), { recursive: true })
    fs.rmSync(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Resources/en.lproj'), { recursive: true })
    const fails = checkApp(app)
    expect(fails).toContain('locales: Chromium’s en.lproj/locale.pak is gone')
    expect(fails).toContain('locales: only English .lproj markers left in Contents/Resources (Open/Save panels would stop following the OS language)')
  })
})

describe('overBudget', () => {
  const ceilings = { dmgBytes: { max: 1000 }, lprojCount: { max: 55 }, coldMs: { max: null } }

  it('fails a metric over its ceiling and skips unset ceilings and unmeasured metrics', () => {
    expect(overBudget({ dmgBytes: 1001, lprojCount: 55, coldMs: 9e9 }, ceilings)).toEqual(['dmgBytes 1001 > ceiling 1000'])
    expect(overBudget({ lprojCount: 55 }, ceilings)).toEqual([])
  })

  it('lets build-to-build jitter through the tolerance, and nothing more', () => {
    expect(overBudget({ dmgBytes: 1001 }, ceilings, 0.001)).toEqual([])
    expect(overBudget({ dmgBytes: 1002 }, ceilings, 0.001)).toEqual(['dmgBytes 1002 > ceiling 1000'])
  })
})
