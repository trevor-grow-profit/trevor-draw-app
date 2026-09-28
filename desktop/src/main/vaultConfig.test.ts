import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { VaultConfigChange } from '@shared/types'
import { failure, until } from './fs/testFixture'
import { activeConfigWatcherRoots, readConfig, readConfigDetailed, subscribeConfig, VAULT_CONFIG_DIR, writeConfig } from './vaultConfig'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const roots: string[] = []
const offs: Array<() => void> = []
afterEach(async () => {
  offs.splice(0).forEach((off) => off())
  await until(() => activeConfigWatcherRoots().length === 0)
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yd-vaultcfg-'))
  roots.push(root)
  return root
}

/** Subscribes to `root`, queueing every change; unsubscribed in afterEach. */
function collect(root: string): VaultConfigChange[] {
  const changes: VaultConfigChange[] = []
  offs.push(subscribeConfig(root, (c) => changes.push(c)))
  return changes
}

describe('readConfig', () => {
  it('missing folder or file → null, and reading NEVER creates .yaseendraw', async () => {
    const root = await makeRoot()
    expect(await readConfig(root, 'sample.json')).toBeNull()
    expect(await readdir(root)).toEqual([])
    await mkdir(path.join(root, VAULT_CONFIG_DIR))
    expect(await readConfig(root, 'sample.json')).toBeNull()
  })

  it('malformed JSON → null with one console.warn, not a throw', async () => {
    const root = await makeRoot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await mkdir(path.join(root, VAULT_CONFIG_DIR))
    await writeFile(path.join(root, VAULT_CONFIG_DIR, 'sample.json'), '{not json')
    expect(await readConfig(root, 'sample.json')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects relative roots and unsafe or non-.json names', async () => {
    const root = await makeRoot()
    expect((await failure(readConfig('rel', 'a.json'))).code).toBe('NOT_ABSOLUTE')
    expect((await failure(readConfig(root, undefined as never))).code).toBe('BAD_REQUEST')
    expect((await failure(readConfig(root, ''))).code).toBe('BAD_REQUEST')
    expect((await failure(readConfig(root, 'a/b.json'))).code).toBe('BAD_REQUEST')
    expect((await failure(readConfig(root, 'a\\b.json'))).code).toBe('BAD_REQUEST')
    expect((await failure(readConfig(root, '../up.json'))).code).toBe('BAD_REQUEST')
    expect((await failure(readConfig(root, 'a.txt'))).code).toBe('UNSUPPORTED_EXTENSION')
    expect((await failure(readConfig(root, '.json'))).code).toBe('UNSUPPORTED_EXTENSION')
  })
})

describe('readConfigDetailed', () => {
  it('distinguishes absent from malformed without warning (the corrupt-file semantics need it)', async () => {
    const root = await makeRoot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await readConfigDetailed(root, 'sample.json')).toEqual({ state: 'absent' })
    expect(await readdir(root)).toEqual([]) // detailed reading NEVER creates .yaseendraw either
    await writeConfig(root, 'sample.json', { version: 1 })
    expect(await readConfigDetailed(root, 'sample.json')).toEqual({ state: 'ok', value: { version: 1 } })
    await writeFile(path.join(root, VAULT_CONFIG_DIR, 'sample.json'), '{not json')
    const res = await readConfigDetailed(root, 'sample.json')
    expect(res.state).toBe('malformed')
    if (res.state === 'malformed') expect(res.error).toContain('JSON')
    expect(warn).not.toHaveBeenCalled() // the caller owns the reporting, unlike readConfig
  })

  it('rejects the same bad roots and names as readConfig', async () => {
    const root = await makeRoot()
    expect((await failure(readConfigDetailed('rel', 'a.json'))).code).toBe('NOT_ABSOLUTE')
    expect((await failure(readConfigDetailed(root, 'a/b.json'))).code).toBe('BAD_REQUEST')
    expect((await failure(readConfigDetailed(root, 'a.txt'))).code).toBe('UNSUPPORTED_EXTENSION')
  })
})

describe('writeConfig', () => {
  it('creates .yaseendraw lazily, writes pretty JSON + newline atomically, round-trips', async () => {
    const root = await makeRoot()
    await writeConfig(root, 'sample.json', { version: 1, types: { due: 'date' } })
    const raw = await readFile(path.join(root, VAULT_CONFIG_DIR, 'sample.json'), 'utf8')
    expect(raw).toBe(`${JSON.stringify({ version: 1, types: { due: 'date' } }, null, 2)}\n`)
    expect(await readConfig(root, 'sample.json')).toEqual({ version: 1, types: { due: 'date' } })
    // No tmp files left behind, nothing but the config in the dotfolder.
    expect(await readdir(path.join(root, VAULT_CONFIG_DIR))).toEqual(['sample.json'])
  })

  it('rejects the same bad names as readConfig and non-serialisable values', async () => {
    const root = await makeRoot()
    expect((await failure(writeConfig('rel', 'a.json', {}))).code).toBe('NOT_ABSOLUTE')
    expect((await failure(writeConfig(root, '../up.json', {}))).code).toBe('BAD_REQUEST')
    expect((await failure(writeConfig(root, 'a.txt', {}))).code).toBe('UNSUPPORTED_EXTENSION')
    expect((await failure(writeConfig(root, 'a.json', undefined))).code).toBe('BAD_REQUEST')
    expect(await readdir(root)).toEqual([]) // no folder created by any rejected write
  })
})

describe('subscribeConfig', () => {
  it('a subscribe before the folder exists creates nothing and still sees an external folder + file creation', async () => {
    const root = await makeRoot()
    const changes = collect(root)
    await sleep(200)
    expect(await readdir(root)).toEqual([]) // subscribing never creates the dotfolder
    await mkdir(path.join(root, VAULT_CONFIG_DIR))
    await writeFile(path.join(root, VAULT_CONFIG_DIR, 'sample.json'), '{"kind":"external"}')
    await until(() => changes.length >= 1)
    expect(changes[0]).toEqual({ root, name: 'sample.json' })
  })

  it('an own write notifies synchronously, once — the watcher echo is deduped by mtime', async () => {
    const root = await makeRoot()
    const changes = collect(root)
    await sleep(200)
    await writeConfig(root, 'sample.json', { a: 1 })
    expect(changes).toEqual([{ root, name: 'sample.json' }]) // synchronous, before any watcher round-trip
    await sleep(800) // long enough for the watcher's echo of the write to have landed if it were not deduped
    expect(changes).toHaveLength(1)
  })

  it('an own write straight after subscribing (folder created during watcher init) still leaves external edits watched', async () => {
    // Regression: a polling watcher (the fallback) loses a path that appears DURING its initialisation; the
    // first writeConfig re-anchors the watcher (see the module header), so this must notify.
    const root = await makeRoot()
    const changes = collect(root)
    await writeConfig(root, 'sample.json', { a: 1 }) // no wait: races the watcher's init on purpose
    expect(changes).toEqual([{ root, name: 'sample.json' }])
    await sleep(300)
    await writeFile(path.join(root, VAULT_CONFIG_DIR, 'sample.json'), '{"a":2}')
    await until(() => changes.length >= 2)
    expect(changes[1]).toEqual({ root, name: 'sample.json' })
  })

  it('external change and unlink notify {root, name}; non-json files never do', async () => {
    const root = await makeRoot()
    await writeConfig(root, 'sample.json', { a: 1 })
    const changes = collect(root)
    await sleep(300) // let the watcher finish its initial scan
    await writeFile(path.join(root, VAULT_CONFIG_DIR, 'sample.json'), '{"a":2}')
    await until(() => changes.length >= 1)
    expect(changes[0]).toEqual({ root, name: 'sample.json' })
    await rm(path.join(root, VAULT_CONFIG_DIR, 'sample.json'))
    await until(() => changes.length >= 2)
    expect(changes[1]).toEqual({ root, name: 'sample.json' })
    await writeFile(path.join(root, VAULT_CONFIG_DIR, 'notes.txt'), 'not config')
    await sleep(500)
    expect(changes).toHaveLength(2)
  })

  it('one watcher per root shared by all subscribers, closed when the last one leaves', async () => {
    const root = await makeRoot()
    const a = collect(root)
    const b = collect(root)
    expect(activeConfigWatcherRoots()).toEqual([root])
    await writeConfig(root, 'view.json', { open: true })
    expect(a).toEqual([{ root, name: 'view.json' }])
    expect(b).toEqual([{ root, name: 'view.json' }])
    const offA = offs.shift()
    offA?.()
    await sleep(100)
    expect(activeConfigWatcherRoots()).toEqual([root])
    const offB = offs.shift()
    offB?.()
    await until(() => activeConfigWatcherRoots().length === 0)
  })
})
