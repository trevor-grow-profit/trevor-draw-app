import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cli, elementKit, embedded, git, gradientPNG, indexedKit, noiseRaw, parseArgs, png, publish, scene, solidPNG, write, writeProfile, writeState } from './lib/seedKit.mjs'

/**
 * `tools/lib/seedKit.mjs` is what every seed script builds its vault from, so the suite pins the
 * parts a vault's bytes depend on: a PNG that decodes to the pixels asked for, the element id /
 * index / seed rules, and the scene and file shapes. (That the scripts' output did not move when
 * they adopted the kit was proved by a byte-for-byte snapshot of all seven vaults, YAZ-2073 6D.)
 */

/** The IHDR fields and the inflated scanlines, with every chunk's CRC checked. */
function decode(bytes) {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunks = {}
  for (let o = 8; o < bytes.length; ) {
    const len = bytes.readUInt32BE(o)
    const typeAndData = bytes.subarray(o + 4, o + 8 + len)
    expect(bytes.readUInt32BE(o + 8 + len)).toBe(zlib.crc32(typeAndData))
    chunks[typeAndData.subarray(0, 4).toString('ascii')] = typeAndData.subarray(4)
    o += 12 + len
  }
  const ihdr = chunks.IHDR
  return { w: ihdr.readUInt32BE(0), h: ihdr.readUInt32BE(4), depth: ihdr[8], colour: ihdr[9], raw: zlib.inflateSync(chunks.IDAT), end: 'IEND' in chunks }
}
const pixel = ({ w, raw }, x, y) => [...raw.subarray(y * (1 + w * 3) + 1 + x * 3, y * (1 + w * 3) + 4 + x * 3)]

describe('PNG encoder', () => {
  it('writes an 8-bit RGB PNG whose scanlines are the pixels asked for', () => {
    const img = decode(png(3, 2, (x, y) => [x * 10, y * 20, 7]))
    expect(img).toMatchObject({ w: 3, h: 2, depth: 8, colour: 2, end: true })
    expect(img.raw.length).toBe(2 * (1 + 3 * 3))
    expect([img.raw[0], img.raw[10]]).toEqual([0, 0]) // filter: none
    expect(pixel(img, 2, 1)).toEqual([20, 20, 7])
    expect(pixel(decode(solidPNG(4, 4, [1, 2, 3])), 3, 3)).toEqual([1, 2, 3])
  })

  it('blends a gradient toward, or exactly onto, the far corner', () => {
    expect(pixel(decode(gradientPNG(5, 5, [0, 0, 0], [200, 100, 40], { toCorner: true })), 4, 4)).toEqual([200, 100, 40])
    expect(pixel(decode(gradientPNG(5, 5, [0, 0, 0], [200, 100, 40])), 4, 4)).toEqual([160, 80, 32])
    expect(pixel(decode(gradientPNG(5, 5, [9, 9, 9], [200, 100, 40])), 0, 0)).toEqual([9, 9, 9])
  })

  it('leaves every noise row unfiltered', () => {
    const raw = noiseRaw(8, 6)
    expect(raw.length).toBe(6 * 25)
    for (let y = 0; y < 6; y++) expect(raw[y * 25]).toBe(0)
  })
})

describe('element builders', () => {
  afterEach(() => vi.restoreAllMocks())

  it('elementKit: prefixed base-36 ids, five-digit string-sortable indexes, one counter per kit', () => {
    const { rect, text } = elementKit('p')
    const a = rect(0, 0, 10, 10)
    const b = text(0, 0, 'two\nlines', 20)
    expect([a.id, a.index, b.id, b.index]).toEqual(['p-0', 'a00001', 'p-1', 'a00002'])
    expect(a).toMatchObject({ type: 'rectangle', roundness: { type: 3 }, backgroundColor: '#a5d8ff', updated: 1 })
    expect(b).toMatchObject({ width: Math.ceil(5 * 20 * 0.55), height: 50, strokeWidth: 1, roughness: 0 })
    expect(elementKit('q').rect(0, 0, 1, 1).id).toBe('q-0')
  })

  it('indexedKit: newId draws before seed and versionNonce, and seeds are never 0', () => {
    const draws = [0.5, 0, 0.25]
    vi.spyOn(Math, 'random').mockImplementation(() => draws.shift())
    const { image } = indexedKit({ newId: () => `id-${Math.random()}`, updated: 42 })
    const el = image(62, 0, 0, 10, 10, 'f')
    expect([el.id, el.seed, el.versionNonce]).toEqual(['id-0.5', 1, 1 + Math.floor(0.25 * (2 ** 31 - 1))])
    expect(el).toMatchObject({ index: 'b00', updated: 42, strokeColor: 'transparent', fileId: 'f' })
  })

  it('puts the yaseendraw block first in a scene, and embeds a picture as a dataURL', () => {
    expect(Object.keys(scene('demo', [], { block: { createdAt: 1, updatedAt: 2 } }))[0]).toBe('yaseendraw')
    expect('yaseendraw' in scene('demo', [])).toBe(false)
    expect(embedded('abc', Buffer.from('hi'), { created: 1 })).toEqual({ mimeType: 'image/png', id: 'abc', dataURL: 'data:image/png;base64,aGk=', created: 1 })
  })
})

describe('write', () => {
  let dir
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('makes parent folders, and writes non-strings as pretty JSON with a newline', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'seedkit-'))
    const file = write(dir, 'a/b/c.json', { x: 1 })
    expect(file).toBe(path.join(dir, 'a/b/c.json'))
    expect(await readFile(file, 'utf8')).toBe('{\n  "x": 1\n}\n')
    expect(await readFile(write(dir, 't.txt', 'plain'), 'utf8')).toBe('plain')
  })
})

describe('parseArgs / cli', () => {
  afterEach(() => vi.restoreAllMocks())
  const SPEC = { '--dir': 'dir', '--port': 'value' }

  it('resolves dir flags, keeps value flags as given, and always knows --force and --help', () => {
    expect(parseArgs(['--dir', 'a/b', '--port', '8799', '--force'], SPEC)).toEqual({ dir: path.resolve('a/b'), port: '8799', force: true, help: false })
    expect(parseArgs(['-h'], SPEC)).toEqual({ force: false, help: true })
    expect(() => parseArgs(['--port'], SPEC)).toThrow(/--port needs a value/)
    expect(() => parseArgs(['--toString', 'x'], SPEC)).toThrow(/unknown argument: --toString/)
  })

  /** `cli` on `argv`, with process.exit and the console captured. */
  function run(argv, required) {
    const out = { stdout: [], stderr: [], code: undefined }
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'seed.mjs', ...argv])
    vi.spyOn(console, 'log').mockImplementation((m) => out.stdout.push(m))
    vi.spyOn(console, 'error').mockImplementation((m) => out.stderr.push(m))
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      out.code = code
      throw new Error('exit')
    })
    try {
      out.args = cli('usage: seed --dir <dir>', SPEC, required)
    } catch (err) {
      if (err.message !== 'exit') throw err
    }
    return out
  }

  it('prints the usage and exits 0 for --help, even without a required flag', () => {
    expect(run(['--help'], ['--dir'])).toMatchObject({ code: 0, stdout: ['usage: seed --dir <dir>'], stderr: [] })
  })

  it('says what is missing or wrong, then the usage, and exits 2', () => {
    expect(run([], ['--dir'])).toMatchObject({ code: 2, stderr: ['--dir <dir> is required\nusage: seed --dir <dir>'] })
    expect(run(['--dri', '/x'], ['--dir'])).toMatchObject({ code: 2, stderr: ['unknown argument: --dri\nusage: seed --dir <dir>'] })
  })

  it('hands back the parsed flags otherwise', () => {
    expect(run(['--dir', '/x'], ['--dir'])).toMatchObject({ code: undefined, args: { dir: '/x', force: false } })
  })
})

describe('profile', () => {
  let dir
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('writeProfile: one window already on the vault, every schema field, settings added after the theme', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'seedkit-'))
    writeProfile(dir, '/v', { id: 'p', theme: 'light', settings: { hoverPreview: true }, lastOpened: 5, file: '/v/B.excalidraw', tabs: ['/v/B.excalidraw'], sidebarCollapsed: true })
    const state = JSON.parse(await readFile(path.join(dir, 'yaseendraw.json'), 'utf8'))
    expect(state).toEqual({
      version: 1,
      settings: { theme: 'light', confirmDelete: true, hoverPreview: true },
      sidebarWidth: 300,
      recents: [{ path: '/v', lastOpened: 5 }],
      windows: [{ id: 'p', root: '/v', file: '/v/B.excalidraw', tabs: ['/v/B.excalidraw'], sidebarCollapsed: true, sidebarLens: 'files', focusDirs: [], focusFavorites: [], bounds: { x: 60, y: 60, width: 1440, height: 900 } }],
      folders: {},
    })
    expect(Object.keys(state.settings)).toEqual(['theme', 'confirmDelete', 'hoverPreview'])
  })

  it('writeState: a setting can override the theme in place, and there may be no window at all', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'seedkit-'))
    writeState(dir, { theme: 'light', settings: { theme: 'dark' } })
    expect(JSON.parse(await readFile(path.join(dir, 'yaseendraw.json'), 'utf8'))).toMatchObject({ settings: { theme: 'dark', confirmDelete: true }, windows: [], recents: [] })
  })
})

describe('git', () => {
  let dir
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('publish: the vault committed as You and pushed to a new bare origin, upstream set — with none of this machine’s git config', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'seedkit-'))
    const vault = path.join(dir, 'vault')
    write(vault, 'Board.excalidraw', scene('t', []))
    publish(vault, path.join(dir, 'origin.git'), 'seed it')
    expect(git(vault, ['log', '--format=%an %s'])).toBe('You seed it')
    expect(git(vault, ['rev-parse', '--abbrev-ref', '@{u}'])).toBe('origin/main')
    expect(git(path.join(dir, 'origin.git'), ['ls-tree', '--name-only', 'main'])).toBe('Board.excalidraw')
    expect(git(vault, ['config', '--list', '--show-scope']).split('\n').every((line) => line.startsWith('local\t'))).toBe(true)
  })
})
