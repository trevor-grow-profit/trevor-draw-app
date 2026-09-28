import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { TreeNode } from '@shared/types'
import { plainPngSize } from '../drawings/png'
import { createThumbs } from '../drawings/thumbs'
import { loadDrawing } from './drawing'
import { tree } from './tree'

vi.mock('electron', async () => ({ nativeImage: (await import('../drawings/fakeNativeImage')).fakeNativeImage }))

/**
 * 1800E — the hover preview's scenarios against the REAL main-process doors and the vault
 * `tools/seedPreviewDemoVault.mjs` builds (the demo Yasin approved). This is the disk half of the
 * chain: which boards the tree offers as board rows, and what `drawing:load` hands the renderer for
 * each. The renderer half — a rejected load is "Preview unavailable", nothing visible is "Empty
 * board" — is `client/src/sidebar/boardPreviewCache.test.ts`. No Playwright.
 */

const run = promisify(execFile)
const SEED = path.resolve(__dirname, '../../../../tools/seedPreviewDemoVault.mjs')
const LOCKED = 'Locked — chmod 000, cannot be read.excalidraw'

let work: string
let vault: string
beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'yd-1800e-'))
  vault = path.join(work, 'YAZ-1800 Mouse over Preview')
  await run(process.execPath, [SEED, '--vault', vault])
}, 60_000)
afterAll(async () => {
  await chmod(path.join(vault, LOCKED), 0o644).catch(() => undefined)
  await rm(work, { recursive: true, force: true })
})

const load = (name: string) => loadDrawing({ root: vault, path: path.join(vault, name) })
const visible = (json: string) => (JSON.parse(json) as { elements: { isDeleted?: boolean }[] }).elements.filter((e) => e.isDeleted !== true).length
const files = (nodes: TreeNode[]): Extract<TreeNode, { type: 'file' }>[] => nodes.flatMap((n) => (n.type === 'dir' ? files(n.children) : [n]))

describe('1800E — what the tree offers as a board row', () => {
  it('every .excalidraw is a board row (kind drawing), at any depth; notes.txt and photo.png never are', async () => {
    const all = files((await tree(vault)).tree)
    const kindOf = (name: string) => all.find((n) => n.name === name)?.kind
    expect(kindOf('01 Simple — three shapes and an arrow.excalidraw')).toBe('drawing')
    expect(kindOf('Deepest board — header shows the folder.excalidraw')).toBe('drawing')
    expect(kindOf('14 Corrupt — not JSON.excalidraw')).toBe('drawing') // listed, then "unavailable" on hover
    expect(kindOf('notes.txt')).not.toBe('drawing')
    expect(kindOf('photo.png')).not.toBe('drawing')
    expect(all.filter((n) => n.path.includes('/Forty boards/'))).toHaveLength(40) // more than the 32-picture cache
  })
})

describe('1800E — what drawing:load hands the renderer for each seeded board', () => {
  it('drawable boards load with their elements — wide, tall, tiny-far, huge, frames, text, dark canvas, long and unicode names', async () => {
    const cases: [string, number][] = [
      ['01 Simple — three shapes and an arrow.excalidraw', 7],
      ['02 Wide — a long row of boxes.excalidraw', 25],
      ['03 Tall — a long column of boxes.excalidraw', 25],
      ['04 Tiny and far away — one small dot at x=50000.excalidraw', 1],
      ['05 Huge — 3000 elements (speed test).excalidraw', 3000],
      ['06 Frames — two frames with content.excalidraw', 7],
      ['07 Text wall — a long written note.excalidraw', 1],
      ['08 Dark canvas — navy background colour.excalidraw', 2],
      ['日本語 — ünïcødé 🎨 board.excalidraw', 3],
    ]
    for (const [name, count] of cases) expect(visible((await load(name)).json), name).toBe(count)
    const dark = JSON.parse((await load('08 Dark canvas — navy background colour.excalidraw')).json) as { appState: { viewBackgroundColor: string } }
    expect(dark.appState.viewBackgroundColor).toBe('#1b1f3b') // the board's own canvas colour reaches the picture
  })

  it('images arrive inlined from assets/; a missing asset is simply absent and the board still loads', async () => {
    const images = await load('09 Images — three pictures from assets.excalidraw')
    expect(Object.keys(images.files)).toHaveLength(2) // two distinct pictures, one used twice
    for (const f of Object.values(images.files)) expect(f.dataURL.startsWith('data:image/png;base64,')).toBe(true)
    expect(Object.keys((await load('10 Large image — 2400×1600 picture.excalidraw')).files)).toHaveLength(1)
    const missing = await load('11 Missing image — its asset file is not on disk.excalidraw')
    expect(missing.files).toEqual({})
    expect(visible(missing.json)).toBe(2)
  })

  it('the PREVIEW load (`imageMaxPx`, 🔒 YAZ-2073 D6): the 2400 × 1600 picture comes back preview-sized from userData, small ones as they are, and the vault is untouched', async () => {
    const listing = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true })).sort()
    const before = await listing(vault)
    const thumbs = createThumbs(path.join(work, 'userData', 'thumbs'))
    const preview = (name: string) => loadDrawing({ root: vault, path: path.join(vault, name), imageMaxPx: 1200 }, thumbs)
    const [id, entry] = Object.entries((await preview('10 Large image — 2400×1600 picture.excalidraw')).files)[0]
    // Drawn 1200 × 800 at most in a 1200 px picture: the thumbnail is the next power of two up, still under the original.
    expect(plainPngSize(Buffer.from(entry.dataURL.split(',')[1], 'base64'))).toEqual({ width: 2048, height: 1365 })
    expect(await readdir(path.join(work, 'userData', 'thumbs'))).toEqual([`${id}-2048.png`])
    // 09: the 240 × 240 picture is drawn at its own size and keeps its bytes; the 800 × 300 one is drawn at 400 × 150.
    const full = (await load('09 Images — three pictures from assets.excalidraw')).files
    const shown = (await preview('09 Images — three pictures from assets.excalidraw')).files
    const sizeOf = (e: { dataURL: string }) => plainPngSize(Buffer.from(e.dataURL.split(',')[1], 'base64'))
    const small = Object.keys(full).find((k) => sizeOf(full[k])?.width === 240)!
    const wide = Object.keys(full).find((k) => sizeOf(full[k])?.width === 800)!
    expect(shown[small]).toEqual(full[small])
    expect(sizeOf(shown[wide])).toEqual({ width: 512, height: 192 })
    expect(await listing(vault)).toEqual(before)
  })

  it('an empty board and a deleted-only board load with nothing visible — the renderer answers "Empty board"', async () => {
    expect(visible((await load('12 Empty — brand new, nothing drawn.excalidraw')).json)).toBe(0)
    expect(visible((await load('13 Only deleted elements — should say Empty board.excalidraw')).json)).toBe(0)
  })

  it('corrupt, zero-byte, not-a-scene and unreadable boards are refused — the renderer answers "Preview unavailable"', async () => {
    for (const name of ['14 Corrupt — not JSON.excalidraw', '15 Zero bytes.excalidraw', '16 No elements array — not a scene.excalidraw']) {
      await expect(load(name), name).rejects.toThrow()
    }
    // Root reads everything, so the chmod-000 case only proves itself for an ordinary user.
    if (process.getuid?.() !== 0) await expect(load(LOCKED)).rejects.toThrow()
  })
})
