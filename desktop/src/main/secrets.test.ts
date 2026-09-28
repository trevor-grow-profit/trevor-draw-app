import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SECRETS_FILE, SECRETS_FILE_MODE, createSecrets, type Secrets } from './secrets'

// Pass-through: the owner-only test looks at the tmp file just before it takes the real name.
vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>()
  return { ...m, rename: vi.fn(m.rename) }
})

let dir: string
let file: string
let secrets: Secrets
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yd-secrets-'))
  file = path.join(dir, SECRETS_FILE)
  secrets = createSecrets(file)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const onDisk = async () => JSON.parse(await readFile(file, 'utf8')) as { version: number; values: Record<string, string> }

describe('createSecrets (🔒 YAZ-1842 D1)', () => {
  it('nothing stored: has is false, read is null, and asking creates no file', async () => {
    expect(await secrets.has('pixabayApiKey')).toBe(false)
    expect(await secrets.read('pixabayApiKey')).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('set stores the value under { version: 2, values }, owner-only; has flips; read gives it back', async () => {
    await secrets.set('pixabayApiKey', 'hunter2-key')
    expect(await onDisk()).toEqual({ version: 2, values: { pixabayApiKey: 'hunter2-key' } })
    expect((await stat(file)).mode & 0o777).toBe(SECRETS_FILE_MODE)
    expect(await secrets.has('pixabayApiKey')).toBe(true)
    expect(await secrets.read('pixabayApiKey')).toBe('hunter2-key')
  })

  it('the value is never on disk wider than owner-only, not even in the tmp file (YAZ-2073 D12)', async () => {
    const modes: number[] = []
    const { rename: realRename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      modes.push((await stat(from)).mode & 0o777)
      return realRename(from, to)
    })
    await secrets.set('pixabayApiKey', 'hunter2-key')
    expect(modes).toEqual([SECRETS_FILE_MODE])
  })

  it('set with null clears the name and leaves the others; clearing an absent name still answers', async () => {
    await secrets.set('a', '1')
    await secrets.set('b', '2')
    await secrets.set('a', null)
    expect(Object.keys((await onDisk()).values)).toEqual(['b'])
    expect(await secrets.has('a')).toBe(false)
    expect(await secrets.has('b')).toBe(true)
    await secrets.set('zzz', null)
    expect(Object.keys((await onDisk()).values)).toEqual(['b'])
  })

  it('a value set again replaces the old one', async () => {
    await secrets.set('a', 'first')
    await secrets.set('a', 'second')
    expect(await secrets.read('a')).toBe('second')
  })

  it('a version-1 file (safeStorage blobs from a build this one cannot read) is moved aside and the next set starts clean', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { pixabayApiKey: Buffer.from('v10ABC').toString('base64') } }))
    expect(await secrets.has('pixabayApiKey')).toBe(false)
    await secrets.set('pixabayApiKey', 'fresh')
    expect((await readdir(dir)).sort()).toEqual([SECRETS_FILE, expect.stringMatching(/^secrets\.json\.corrupt-\d+$/)])
    expect(await onDisk()).toEqual({ version: 2, values: { pixabayApiKey: 'fresh' } })
  })

  it('a corrupt file is moved aside as secrets.json.corrupt-<epoch> and treated as empty', async () => {
    await writeFile(file, '{ nope')
    expect(await secrets.has('a')).toBe(false)
    await secrets.set('a', 'x')
    expect((await readdir(dir)).sort()).toEqual([SECRETS_FILE, expect.stringMatching(/^secrets\.json\.corrupt-\d+$/)])
    expect(await secrets.read('a')).toBe('x')
  })

  it('a non-string row in a good file is ignored', async () => {
    await writeFile(file, JSON.stringify({ version: 2, values: { a: 7, b: 'x' } }))
    expect(await secrets.has('a')).toBe(false)
    expect(await secrets.read('b')).toBe('x')
  })

  it('an outside edit is seen on the next read (mtime, not a stale cache)', async () => {
    await secrets.set('a', 'x')
    await new Promise((r) => setTimeout(r, 15))
    await writeFile(file, JSON.stringify({ version: 2, values: { a: 'edited' } }))
    expect(await secrets.read('a')).toBe('edited')
  })

  it('concurrent sets serialise — every name lands', async () => {
    await Promise.all(['a', 'b', 'c'].map((n) => secrets.set(n, n)))
    expect(Object.keys((await onDisk()).values).sort()).toEqual(['a', 'b', 'c'])
  })
})
