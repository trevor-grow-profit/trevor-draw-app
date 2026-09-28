import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DrawingFileEntry } from '@shared/types'
import { fakeNativeImage } from './fakeNativeImage'
import { encodePng, plainPngSize } from './png'
import { createThumbs } from './thumbs'

vi.mock('electron', async () => ({ nativeImage: (await import('./fakeNativeImage')).fakeNativeImage }))

let work: string
let folder: string
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'thumbs-'))
  folder = path.join(work, 'userData', 'thumbs')
  fakeNativeImage.createFromBuffer.mockClear()
})
afterEach(() => rm(work, { recursive: true, force: true }))

const pngOf = async (width: number, height: number) => encodePng(new Uint8Array(width * height * 4), width, height)
const entryOf = (bytes: Buffer, mimeType = 'image/png'): DrawingFileEntry => ({ mimeType, dataURL: `data:${mimeType};base64,${bytes.toString('base64')}` })
const bytesOf = (entry: DrawingFileEntry) => Buffer.from(entry.dataURL.split(',')[1], 'base64')
const image = (fileId: string, x: number, width: number, height: number, over: Record<string, unknown> = {}) => ({ type: 'image', fileId, x, y: 0, width, height, ...over })
/** Eleven 1440 × 822 pictures in a row: each is drawn ~108 px wide in a 1200 px picture. */
const row = (ids: string[]) => ids.map((id, i) => image(id, i * 1500, 1440, 822))

describe('thumbs.fit', () => {
  it('answers a PNG no smaller than the picture is drawn, stored as `<fileId>-<px>.png` under its folder', async () => {
    const shot = entryOf(await pngOf(1440, 822))
    const out = await createThumbs(folder).fit({ a: shot }, row(['a', ...'bcdefghijk']), 1200)
    expect(out.a.mimeType).toBe('image/png')
    expect(plainPngSize(bytesOf(out.a))).toEqual({ width: 128, height: 73 })
    expect(await readdir(folder)).toEqual(['a-128.png'])
    expect(await readFile(path.join(folder, 'a-128.png'))).toEqual(bytesOf(out.a))
  })

  it('reads a second request from the cache — reused across launches — and touches it for the sweep', async () => {
    const shot = entryOf(await pngOf(1440, 822))
    const first = await createThumbs(folder).fit({ a: shot }, row(['a', ...'bcdefghijk']), 1200)
    const long = new Date(Date.now() - 60_000)
    await utimes(path.join(folder, 'a-128.png'), long, long)
    const again = await createThumbs(folder).fit({ a: shot }, row(['a', ...'bcdefghijk']), 1200)
    expect(again).toEqual(first)
    expect(fakeNativeImage.createFromBuffer).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => expect((await stat(path.join(folder, 'a-128.png'))).mtimeMs).toBeGreaterThan(long.getTime()))
  })

  it('never upscales: a picture drawn at its own size or bigger keeps its bytes, and nothing is written', async () => {
    const shot = entryOf(await pngOf(300, 200))
    const out = await createThumbs(folder).fit({ a: shot }, [image('a', 0, 300, 200)], 1200)
    expect(out.a).toBe(shot)
    expect(fakeNativeImage.createFromBuffer).not.toHaveBeenCalled()
    await expect(readdir(folder)).rejects.toThrow()
  })

  it('keeps the original for what a thumbnail would change or cannot make: cropped, not a plain PNG, a bad id, an undecodable picture', async () => {
    const big = await pngOf(1440, 822)
    const crop = { x: 0, y: 0, width: 100, height: 100, naturalWidth: 1440, naturalHeight: 822 }
    const withProfile = Buffer.concat([big.subarray(0, 33), Buffer.from([0, 0, 0, 1, ...Buffer.from('iCCP'), 0, 0, 0, 0, 0]), big.subarray(33)])
    const files = {
      cropped: entryOf(big),
      svg: entryOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'),
      jpeg: entryOf(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'),
      profiled: entryOf(withProfile),
      'bad/id': entryOf(big),
      broken: entryOf(big),
    }
    fakeNativeImage.createFromBuffer.mockImplementationOnce(() => ({ isEmpty: () => true }) as never)
    const elements = [image('cropped', 0, 1440, 822, { crop }), ...row(['svg', 'jpeg', 'profiled', 'bad/id', 'broken']).map((e) => ({ ...e, x: e.x + 1500 })), image('pad', 20000, 1440, 822)]
    const out = await createThumbs(folder).fit(files, elements, 1200)
    for (const id of Object.keys(files)) expect(out[id], id).toBe(files[id as keyof typeof files])
    expect(fakeNativeImage.createFromBuffer).toHaveBeenCalledTimes(1) // only `broken` got as far as a decode
  })

  it('a folder that cannot be written is still a working cache: the thumbnail is answered, never an error', async () => {
    await mkdir(path.dirname(folder), { recursive: true })
    await writeFile(folder, 'a file where the folder should be')
    const out = await createThumbs(folder).fit({ a: entryOf(await pngOf(1440, 822)) }, row(['a', ...'bcdefghijk']), 1200)
    expect(plainPngSize(bytesOf(out.a))).toEqual({ width: 128, height: 73 })
  })

  it('once per session, after the first thumbnail it writes, drops the least recently used past the cap — and only its own files', async () => {
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'old-64.png'), Buffer.alloc(4000))
    await writeFile(path.join(folder, 'notes.txt'), Buffer.alloc(4000))
    const long = new Date(Date.now() - 3_600_000)
    await utimes(path.join(folder, 'old-64.png'), long, long)
    await utimes(path.join(folder, 'notes.txt'), long, long)
    await createThumbs(folder, { maxBytes: 3000 }).fit({ a: entryOf(await pngOf(1440, 822)) }, row(['a', ...'bcdefghijk']), 1200)
    await vi.waitFor(async () => expect((await readdir(folder)).sort()).toEqual(['a-128.png', 'notes.txt']))
  })
})
