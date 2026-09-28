import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureVaultIgnores, VAULT_IGNORED, withLines } from './ignore'

describe('withLines', () => {
  it('creates the file when there is none', () => {
    expect(withLines(null, ['.DS_Store'])).toBe('.DS_Store\n')
  })

  it('appends to what is there and NEVER rewrites a line', () => {
    expect(withLines('node_modules\n*.log\n', ['.DS_Store'])).toBe('node_modules\n*.log\n.DS_Store\n')
  })

  it('adds the missing newline of a file that ends without one', () => {
    expect(withLines('node_modules', ['.DS_Store'])).toBe('node_modules\n.DS_Store\n')
  })

  it('is a no-op when the entry is already there, whatever the whitespace around it', () => {
    expect(withLines('.DS_Store\n', ['.DS_Store'])).toBeNull()
    expect(withLines('node_modules\n  .DS_Store  \n', ['.DS_Store'])).toBeNull()
  })

  it('adds only what is missing, in order', () => {
    expect(withLines('.DS_Store\n', ['.DS_Store', 'Thumbs.db'])).toBe('.DS_Store\nThumbs.db\n')
  })

  it('an empty file is written as if it were absent', () => {
    expect(withLines('', ['.DS_Store'])).toBe('.DS_Store\n')
  })
})

describe('ensureVaultIgnores on a real folder', () => {
  it('writes once and then reports no change, leaving the file byte-identical', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-ignore-'))
    try {
      await writeFile(path.join(root, '.gitignore'), 'secrets/\n')
      expect(await ensureVaultIgnores(root)).toBe(true)
      const first = await readFile(path.join(root, '.gitignore'), 'utf8')
      expect(first).toBe('secrets/\n.DS_Store\n*.tmp-????????????\n')
      // Idempotent: a second pass writes nothing at all.
      expect(await ensureVaultIgnores(root)).toBe(false)
      expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates the file in a vault that has none', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-ignore-'))
    try {
      expect(await ensureVaultIgnores(root)).toBe(true)
      expect(await readFile(path.join(root, '.gitignore'), 'utf8')).toBe(`${VAULT_IGNORED.join('\n')}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
