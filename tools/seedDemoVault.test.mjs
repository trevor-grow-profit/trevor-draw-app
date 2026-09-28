import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { EXT, assetFileName, fileIdFor, fracIndex } from './lib/seedDemoVault.mjs'
import { parseArgs } from './lib/seedKit.mjs'

/**
 * `tools/seedDemoVault.mjs` writes a ~130 MB vault, so the suite covers the pure rules only: the
 * content-id and filename the app resolves assets by, the element ordering key, and the argument
 * parsing that decides WHICH directory gets wiped.
 */

describe('asset naming', () => {
  it('ids an asset by the SHA-1 of its bytes, like Excalidraw generateIdFromFile', () => {
    const bytes = Buffer.from('hello')
    expect(fileIdFor(bytes)).toBe(createHash('sha1').update(bytes).digest('hex'))
    expect(fileIdFor(bytes)).toMatch(/^[0-9a-f]{40}$/)
  })

  it('gives the same id to the same bytes, so one image pasted twice is one file (🔒 YAZ-1775 D3)', () => {
    expect(fileIdFor(Buffer.from('same'))).toBe(fileIdFor(Buffer.from('same')))
    expect(fileIdFor(Buffer.from('same'))).not.toBe(fileIdFor(Buffer.from('other')))
  })

  it('names the file <sha1>.<ext> for every mime the vault seeds', () => {
    const id = fileIdFor(Buffer.from('x'))
    expect(assetFileName(id, 'image/png')).toBe(`${id}.png`)
    expect(assetFileName(id, 'image/jpeg')).toBe(`${id}.jpg`)
    expect(assetFileName(id, 'image/svg+xml')).toBe(`${id}.svg`)
    expect(assetFileName(id, 'image/gif')).toBe(`${id}.gif`)
    expect(Object.keys(EXT)).toHaveLength(4)
  })

  it('refuses a mime it has no extension for rather than writing a bare sha', () => {
    expect(() => assetFileName(fileIdFor(Buffer.from('x')), 'image/tiff')).toThrow(/unsupported asset mime/)
  })
})

describe('fracIndex', () => {
  it('sorts as a string in generation order, which plain counting would not — well past 4 000 elements', () => {
    const keys = Array.from({ length: 12_000 }, (_, i) => fracIndex(i))
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('switches to a longer key form after 62, then after 62 + 62² elements', () => {
    expect(fracIndex(0)).toBe('a0')
    expect(fracIndex(61)).toBe('az')
    expect(fracIndex(62)).toBe('b00')
    expect(fracIndex(3905)).toBe('bzz')
    expect(fracIndex(3906)).toBe('c000')
  })
})

describe('parseArgs — the script wipes what it is given, so nothing is implied', () => {
  const DEMO = { '--vault': 'dir', '--origin': 'dir' }

  it('takes --vault and --origin and resolves them to absolute paths', () => {
    const args = parseArgs(['--vault', 'scratch/vault', '--origin', 'scratch/origin.git'], DEMO)
    expect(args.vault).toBe(path.resolve('scratch/vault'))
    expect(args.origin).toBe(path.resolve('scratch/origin.git'))
  })

  it('--force is off unless it is asked for', () => {
    expect(parseArgs(['--vault', '/tmp/v'], DEMO).force).toBe(false)
    expect(parseArgs(['--vault', '/tmp/v', '--force'], DEMO).force).toBe(true)
  })

  it('throws rather than wiping a directory the caller did not mean', () => {
    expect(() => parseArgs(['--vault'], DEMO)).toThrow(/needs a directory/)
    expect(() => parseArgs(['--vault', '--origin', '/tmp/o.git'], DEMO)).toThrow(/needs a directory/)
    expect(() => parseArgs(['--vualt', '/tmp/v'], DEMO)).toThrow(/unknown argument/)
    expect(() => parseArgs(['/tmp/v'], DEMO)).toThrow(/unknown argument/)
  })

  it('reports --help without requiring anything else', () => {
    expect(parseArgs(['--help'], DEMO).help).toBe(true)
    expect(parseArgs(['--vault', '/tmp/v'], DEMO).help).toBe(false)
  })
})

/** The script itself, run as the user runs it — the guard is worthless if only the parser has it. */
describe('the script refuses to wipe anything it was not told to', () => {
  const run = promisify(execFile)
  const script = fileURLToPath(new URL('./seedDemoVault.mjs', import.meta.url))
  const exec = (args) => run(process.execPath, [script, ...args]).catch((err) => err)

  it('REQUIRES --vault: there is no default that could one day be a real vault', async () => {
    for (const args of [[], ['--origin', '/tmp/o.git'], ['--force']]) {
      const result = await exec(args)
      expect(result.code).toBe(2)
      expect(`${result.stderr}`).toMatch(/--vault <dir> is required/)
    }
  })

  it('puts the bare origin beside the vault when only --vault is given — and refuses that one too', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-seed-'))
    try {
      await mkdir(path.join(dir, 'v (origin).git'))
      const result = await exec(['--vault', path.join(dir, 'v')])
      expect(result.code).toBe(2)
      expect(`${result.stderr}`).toContain(`refusing to wipe an existing origin: ${path.join(dir, 'v (origin).git')}`)
      expect(await readdir(dir)).toEqual(['v (origin).git'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an EXISTING vault, and says --force is the way past it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-seed-'))
    try {
      await writeFile(path.join(dir, 'precious.excalidraw'), '{}')
      const result = await exec(['--vault', dir])
      expect(result.code).toBe(2)
      expect(`${result.stderr}`).toMatch(/refusing to wipe an existing vault/)
      expect(`${result.stderr}`).toMatch(/--force/)
      // And nothing was touched.
      expect(await readdir(dir)).toEqual(['precious.excalidraw'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('--help prints the usage and exits cleanly', async () => {
    const result = await exec(['--help'])
    expect(result.code).toBeUndefined()
    expect(`${result.stdout}`).toMatch(/--vault <dir>/)
  })
})
