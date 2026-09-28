import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXCALIDRAW_FONT_FAMILIES, REQUIRED_OUT, asarIndex, checkOut, chunkGraph, importsOf, measure, overBudget } from './lib/bundle.mjs'

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

describe('asarIndex', () => {
  it('reads file paths and sizes from the archive header', () => {
    const header = Buffer.from(JSON.stringify({ files: { out: { files: { main: { files: { 'index.js': { size: 12, offset: '0' } } } } }, 'package.json': { size: 3, offset: '12' } } }))
    const head = Buffer.alloc(16)
    head.writeUInt32LE(4, 0)
    head.writeUInt32LE(header.length + 8, 4)
    head.writeUInt32LE(header.length + 4, 8)
    head.writeUInt32LE(header.length, 12)
    put('app.asar', Buffer.concat([head, header]))
    expect(asarIndex(path.join(dir, 'app.asar'))).toEqual(new Map([['out/main/index.js', 12], ['package.json', 3]]))
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
