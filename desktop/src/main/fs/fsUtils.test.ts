import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { atomicWrite, BridgeFailure, buildTree, isSkipped, requireAbsPath, requireDrawingFile, toBridgeFailure, writeDurable } from './fsUtils'

// Pass-through spies: the durability tests watch the handle's `sync` and the rename that follows it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>()
  return { ...m, open: vi.fn(m.open), rename: vi.fn(m.rename) }
})

/** Records, in order, every fsync of a handle `open` hands out and every rename, with the renamed file's mode. */
async function traceDurability(): Promise<string[]> {
  const log: string[] = []
  const { open: realOpen, rename: realRename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const fh = await realOpen(...args)
    const sync = fh.sync.bind(fh)
    fh.sync = async () => {
      log.push(`sync ${path.basename(String(args[0])).replace(/\.tmp-.*/, '.tmp')}`)
      return sync()
    }
    return fh
  })
  vi.mocked(rename).mockImplementation(async (from, to) => {
    log.push(`rename mode ${((await stat(from)).mode & 0o777).toString(8)}`)
    return realRename(from, to)
  })
  return log
}

/** The rules every fs handler is built on; until now each was covered only incidentally. */

describe('requireAbsPath', () => {
  it('normalises an absolute path', () => {
    expect(requireAbsPath('/v/sub/../a.excalidraw', 'path')).toBe('/v/a.excalidraw')
  })

  it.each([
    [undefined, 'BAD_REQUEST'],
    ['', 'BAD_REQUEST'],
    ['relative.excalidraw', 'NOT_ABSOLUTE'],
    [42, 'NOT_ABSOLUTE'],
    ['/v/with\0nul', 'NOT_ABSOLUTE'],
  ])('refuses %s', (value, code) => {
    expect(() => requireAbsPath(value, 'path')).toThrowError(expect.objectContaining({ code }))
  })
})

describe('requireDrawingFile', () => {
  it('accepts a drawing, whatever the case of its extension', () => {
    expect(() => requireDrawingFile('/v/a.excalidraw')).not.toThrow()
    expect(() => requireDrawingFile('/v/a.EXCALIDRAW')).not.toThrow()
  })

  it('refuses anything else', () => {
    expect(() => requireDrawingFile('/v/a.md')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_EXTENSION' }))
    expect(() => requireDrawingFile('/v/a')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_EXTENSION' }))
  })
})

describe('isSkipped — the one definition of "invisible"', () => {
  it('hides dot-entries and node_modules, and nothing else', () => {
    expect(isSkipped('.yaseendraw')).toBe(true)
    expect(isSkipped('.DS_Store')).toBe(true)
    expect(isSkipped('node_modules')).toBe(true)
    expect(isSkipped('Notes')).toBe(false)
    expect(isSkipped('a.excalidraw')).toBe(false)
  })
})

describe('toBridgeFailure — the errno table the whole fs layer answers through', () => {
  it.each([
    ['ENOENT', 'NOT_FOUND'],
    ['EACCES', 'FORBIDDEN'],
    ['EPERM', 'FORBIDDEN'],
    ['ENOTDIR', 'NOT_A_DIRECTORY'],
    ['EEXIST', 'ALREADY_EXISTS'],
    ['EISDIR', 'NOT_A_FILE'],
    ['EMFILE', 'IO_ERROR'],
  ])('%s becomes %s, attributed to the path', (errno, code) => {
    const failure = toBridgeFailure(Object.assign(new Error('boom'), { code: errno }), '/v/a.excalidraw')
    expect(failure.code).toBe(code)
    expect(failure.path).toBe('/v/a.excalidraw')
  })

  it('passes an existing BridgeFailure through untouched — the first attribution wins', () => {
    const original = new BridgeFailure('CONFLICT', 'newer on disk', { path: '/v/a.excalidraw', mtime: 42 })
    expect(toBridgeFailure(original, '/somewhere/else')).toBe(original)
  })

  it('a non-error is still an IO_ERROR carrying its own text', () => {
    expect(toBridgeFailure('just a string', '/v/a')).toMatchObject({ code: 'IO_ERROR', message: 'just a string' })
  })
})

describe('buildTree', () => {
  it('lists dirs before files, each case-insensitively sorted, keeping empty dirs and skipping the invisible', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-tree-'))
    try {
      await mkdir(path.join(root, 'Zeta'))
      await mkdir(path.join(root, 'alpha'))
      await mkdir(path.join(root, 'node_modules'))
      await mkdir(path.join(root, '.yaseendraw'))
      await writeFile(path.join(root, 'b.excalidraw'), '{}')
      await writeFile(path.join(root, 'A.txt'), 'x')
      await writeFile(path.join(root, '.DS_Store'), 'x')

      const tree = await buildTree(root)

      expect(tree.map((n) => n.name)).toEqual(['alpha', 'Zeta', 'A.txt', 'b.excalidraw'])
      expect(tree.filter((n) => n.type === 'dir').map((n) => (n.type === 'dir' ? n.children : []))).toEqual([[], []])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('carries each file\'s kind: a drawing is `drawing`, anything else is null (YAZ-1577 D1)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-tree-'))
    try {
      await writeFile(path.join(root, 'a.excalidraw'), '{}')
      await writeFile(path.join(root, 'b.pdf'), 'x')
      const byName = new Map((await buildTree(root)).map((n) => [n.name, n]))
      expect(byName.get('a.excalidraw')).toMatchObject({ type: 'file', kind: 'drawing' })
      expect(byName.get('b.pdf')).toMatchObject({ type: 'file', kind: null })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists neither a symlink nor a device — only regular files and real directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yaseendraw-tree-'))
    try {
      await writeFile(path.join(root, 'real.excalidraw'), '{}')
      await symlink(path.join(root, 'real.excalidraw'), path.join(root, 'link.excalidraw'))
      expect((await buildTree(root)).map((n) => n.name)).toEqual(['real.excalidraw'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('durable writes (YAZ-2073 D12)', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yaseendraw-durable-'))
    try {
      await fn(dir)
    } finally {
      vi.mocked(open).mockRestore()
      vi.mocked(rename).mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('atomicWrite fsyncs the tmp file before renaming it over the target', () =>
    withDir(async (dir) => {
      const log = await traceDurability()
      const file = path.join(dir, 'a.excalidraw')
      await writeFile(file, 'old')
      const res = await atomicWrite(file, 'new ✓')
      expect(log).toEqual(['sync a.excalidraw.tmp', 'rename mode 644'])
      expect(await readFile(file, 'utf8')).toBe('new ✓')
      expect(res.size).toBe(Buffer.byteLength('new ✓'))
      expect(await readdir(dir)).toEqual(['a.excalidraw'])
    }))

  it('atomicWrite lands bytes verbatim, and a mode applies to the tmp file from its creation', () =>
    withDir(async (dir) => {
      const log = await traceDurability()
      const file = path.join(dir, 'secret.json')
      await atomicWrite(file, new Uint8Array([0, 255, 7]), 0o600)
      expect(log).toEqual(['sync secret.json.tmp', 'rename mode 600'])
      expect([...(await readFile(file))]).toEqual([0, 255, 7])
    }))

  it('a failed write leaves neither the tmp file nor a touched target', () =>
    withDir(async (dir) => {
      const file = path.join(dir, 'a.excalidraw')
      await writeFile(file, 'old')
      vi.mocked(rename).mockRejectedValueOnce(new Error('EXDEV'))
      await expect(atomicWrite(file, 'new')).rejects.toThrow('EXDEV')
      expect(await readdir(dir)).toEqual(['a.excalidraw'])
      expect(await readFile(file, 'utf8')).toBe('old')
    }))

  it('writeDurable fsyncs before closing, and `wx` refuses an existing file', () =>
    withDir(async (dir) => {
      const log = await traceDurability()
      const file = path.join(dir, 'x.png')
      await writeDurable(file, new Uint8Array([1, 2]), 'wx')
      expect(log).toEqual(['sync x.png'])
      await expect(writeDurable(file, new Uint8Array([3]), 'wx')).rejects.toMatchObject({ code: 'EEXIST' })
      expect([...(await readFile(file))]).toEqual([1, 2])
    }))
})
