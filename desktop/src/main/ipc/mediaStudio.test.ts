/**
 * The Image Studio's three channels (🔒 YAZ-1775 D4, YAZ-1818): the guard layer. What is pinned here is
 * that a sandboxed renderer's arguments are checked BEFORE a provider is touched, that a typed
 * failure reaches the envelope with its code intact, and that the cache folder is made and swept
 * at registration rather than on the first search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { PIXABAY_SECRET } from '@shared/types'
import { CONTRACT, type Envelope } from '@shared/ipc'
import { CACHE_TTL_MS } from '../media/cachePolicy'
import type { Secrets } from '../secrets'
import { registerMediaStudioIpc } from './mediaStudio'
import { registered } from './ipcFixture'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: { getAllWindows: vi.fn(() => []) } }))

const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })

const until = async (pred: () => Promise<boolean>, ms = 3000) => {
  const t0 = Date.now()
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error('condition not met')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The secrets instance `registerSecretsIpc` returns, reduced to what the providers use. */
function fakeSecrets(key: string | null): Secrets & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    set: async () => undefined,
    has: async () => key !== null,
    read: async (name: string) => {
      reads.push(name)
      return key
    },
  }
}

let userData: string
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  userData = await mkdtemp(path.join(tmpdir(), 'yd-media-studio-'))
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('registration', () => {
  it('makes the cache folder and sweeps yesterday out of it, detached', async () => {
    const folder = registerMediaStudioIpc(userData, fakeSecrets(null), vi.fn() as unknown as typeof globalThis.fetch)
    await until(async () => (await stat(folder).then(() => true, () => false)))
    const stale = path.join(folder, 'deadbeef.json')
    await writeFile(stale, '{}')
    const old = new Date(Date.now() - CACHE_TTL_MS - 1000)
    await utimes(stale, old, old)

    vi.mocked(ipcMain.handle).mockClear()
    const second = registerMediaStudioIpc(userData, fakeSecrets(null), vi.fn() as unknown as typeof globalThis.fetch)
    await until(async () => (await readdir(second)).length === 0)
    expect(await readdir(second)).toEqual([])
  })
})

describe('the guards', () => {
  const noFetch = vi.fn(async () => {
    throw new Error('a guarded request must never reach a provider')
  })

  it('refuses a search with no request, a bad source or a non-string cursor', async () => {
    registerMediaStudioIpc(userData, fakeSecrets(null), noFetch as unknown as typeof globalThis.fetch)
    const search = registered(CONTRACT.media.search)
    await expect(search(null)).resolves.toEqual(bad('BAD_REQUEST'))
    await expect(search(null, { q: 'money bag' })).resolves.toEqual(bad('BAD_REQUEST'))
    await expect(search(null, { q: 'money bag', source: 'web' })).resolves.toEqual(bad('BAD_REQUEST'))
    await expect(search(null, { q: 'money bag', source: 'all', cursor: 7 })).resolves.toEqual(bad('BAD_REQUEST'))
    await expect(search(null, { q: 'a', source: 'all' })).resolves.toEqual(bad('BAD_REQUEST'))
  })

  it('refuses preview and import for a provider that serves no bytes — `shape` is drawn, not fetched', async () => {
    registerMediaStudioIpc(userData, fakeSecrets(null), noFetch as unknown as typeof globalThis.fetch)
    for (const door of [CONTRACT.media.preview, CONTRACT.media.import]) {
      const call = registered(door)
      await expect(call(null, { provider: 'shape', id: 'rectangle' })).resolves.toEqual(bad('BAD_REQUEST'))
      await expect(call(null, { provider: 'iconify', id: '' })).resolves.toEqual(bad('BAD_REQUEST'))
      await expect(call(null, { provider: 'iconify' })).resolves.toEqual(bad('BAD_REQUEST'))
      await expect(call(null, 'noto:rocket')).resolves.toEqual(bad('BAD_REQUEST'))
    }
  })
})

describe('what reaches the renderer', () => {
  it('answers a search through the envelope and asks the secrets instance for the key', async () => {
    const secrets = fakeSecrets(null)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ icons: ['noto:money-bag'], collections: { noto: { name: 'Noto' } }, total: 1 }), { headers: { 'Content-Type': 'application/json' } }))
    registerMediaStudioIpc(userData, secrets, fetchMock as unknown as typeof globalThis.fetch)
    const answer = (await registered(CONTRACT.media.search)(null, { q: 'money bag', source: 'all' })) as Envelope<{ items: unknown[]; pixabayAvailable: boolean }>
    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.value.pixabayAvailable).toBe(false)
    expect(answer.ok && answer.value.items).toHaveLength(1)
    expect(secrets.reads).toContain(PIXABAY_SECRET)
  })

  it('carries a provider failure through with its typed code', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    registerMediaStudioIpc(userData, fakeSecrets(null), fetchMock as unknown as typeof globalThis.fetch)
    await expect(registered(CONTRACT.media.search)(null, { q: 'money bag', source: 'iconify' })).resolves.toEqual(bad('OFFLINE'))
    await expect(registered(CONTRACT.media.preview)(null, { provider: 'iconify', id: 'noto:money-bag' })).resolves.toEqual(bad('OFFLINE'))
  })

  it('answers an import with the bytes as a dataURL and the provider item', async () => {
    const fetchMock = vi.fn(async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }))
    registerMediaStudioIpc(userData, fakeSecrets(null), fetchMock as unknown as typeof globalThis.fetch)
    const answer = (await registered(CONTRACT.media.import)(null, { provider: 'iconify', id: 'noto:money-bag' })) as Envelope<{ mimeType: string; dataURL: string; item: { itemKey: string } }>
    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.value.mimeType).toBe('image/svg+xml')
    expect(answer.ok && answer.value.dataURL.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(answer.ok && answer.value.item.itemKey).toBe('iconify:noto:money-bag')
  })
})
