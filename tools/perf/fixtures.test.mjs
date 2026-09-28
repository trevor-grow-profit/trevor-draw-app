import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { referencedAssetIds } from '../../desktop/src/main/drawings/orphanSweep.ts'
import { createStore } from '../../desktop/src/main/store.ts'
import { claimWorkDir, flowDiagram, imageBoard, legacyBoard, noisePng, rng, screenshotPng, shapesBoard, writeBoardVault, writeProfile } from './lib/fixtures.mjs'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yd-fixtures-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('rng', () => {
  it('is the same sequence for the same seed, and a different one for another', () => {
    const a = rng(7)
    const b = rng(7)
    const seq = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(seq)
    expect(rng(8)()).not.toBe(seq[0])
    expect(seq.every((x) => x >= 0 && x < 1)).toBe(true)
  })
})

describe('screenshotPng', () => {
  it('is a deterministic truecolour PNG of the asked size', () => {
    const png = screenshotPng(40, 30, rng(1))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([40, 30, 8, 2])
    const idat = png.indexOf('IDAT')
    expect(zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4))).length).toBe((40 * 3 + 1) * 30)
    expect(screenshotPng(40, 30, rng(1))).toEqual(png)
  })
})

describe('boards', () => {
  it('builds the same n-shape scene from the same seed, every id unique', () => {
    const board = shapesBoard(4000, 4)
    const { elements } = JSON.parse(board)
    expect(elements).toHaveLength(4000)
    expect(new Set(elements.map((e) => e.id)).size).toBe(4000)
    expect(shapesBoard(4000, 4)).toBe(board)
  })

  it('references every image it writes, so the orphan sweep has nothing to trash', async () => {
    fs.writeFileSync(path.join(dir, 'Images.excalidraw'), imageBoard(dir, 5, 3, { width: 32, height: 18 }))
    const written = fs.readdirSync(path.join(dir, 'assets')).map((f) => f.replace(/\.png$/, ''))
    expect(written).toHaveLength(5)
    expect([...(await referencedAssetIds(dir))].sort()).toEqual(written.sort())
  })

  it("embeds a legacy board's images as dataURLs named by their content", () => {
    const { elements, files } = JSON.parse(legacyBoard(2, 5, { width: 20, height: 10 }))
    expect(elements.map((e) => e.fileId)).toEqual(Object.keys(files))
    for (const [id, file] of Object.entries(files)) expect(createHash('sha1').update(Buffer.from(file.dataURL.split(',')[1], 'base64')).digest('hex')).toBe(id)
  })

  it('makes noise PNGs that do not compress, so a legacy board weighs what it claims', () => {
    expect(noisePng(100, 100, rng(1)).length).toBeGreaterThan(100 * 100 * 3)
  })

  it('writes the storm vault as folders of boards', () => {
    const files = writeBoardVault(dir, 3, 4, 1)
    expect(files).toHaveLength(12)
    expect(fs.readdirSync(dir).sort()).toEqual(['folder-000', 'folder-001', 'folder-002'])
    expect(JSON.parse(fs.readFileSync(files[11], 'utf8')).elements).toHaveLength(75)
  })

  it('writes a plain-XML diagram with one box per step', () => {
    const xml = flowDiagram(4)
    expect(xml.startsWith('<mxfile')).toBe(true)
    expect(xml.match(/vertex="1"/g)).toHaveLength(4)
    expect(xml.match(/edge="1"/g)).toHaveLength(3)
  })
})

describe('writeProfile', () => {
  it('is a state file the app loads as one window on the board', () => {
    const vault = path.join(dir, 'vault')
    const file = path.join(vault, 'Light.excalidraw')
    writeProfile(path.join(dir, 'profile'), vault, file)
    const state = createStore(path.join(dir, 'profile', 'yaseendraw.json')).get()
    expect(state.windows).toEqual([expect.objectContaining({ root: vault, file, tabs: [file] })])
    expect(state.settings).toMatchObject({ theme: 'light', hoverPreview: true })
  })
})

describe('claimWorkDir', () => {
  it('takes an empty or missing folder, marks it, and hands out scenario folders inside it only', () => {
    const root = path.join(dir, 'work')
    const work = claimWorkDir(root)
    expect(work.dirFor('launch')).toBe(path.join(root, 'launch'))
    expect(() => work.dirFor('../vault')).toThrow('is not a folder name')
    expect(() => work.dirFor('a/b')).toThrow('is not a folder name')
    fs.mkdirSync(path.join(root, 'launch'))
    expect(() => claimWorkDir(root)).not.toThrow() // ours: it carries the marker
  })

  it('refuses a folder that already holds something it did not make', () => {
    fs.writeFileSync(path.join(dir, 'Board.excalidraw'), '{}')
    expect(() => claimWorkDir(dir)).toThrow('refusing to use')
  })
})
