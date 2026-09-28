import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { CONTRACT, type Envelope } from '@shared/ipc'
import type { Secrets } from '../secrets'
import { registerSecretsIpc } from './secrets'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

type Handler = (event: unknown, ...args: unknown[]) => Promise<Envelope<unknown>>

function registered(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel)
  if (call === undefined) throw new Error(`no handler registered for ${channel}`)
  return call[1] as unknown as Handler
}

const ok = (value: unknown) => ({ ok: true, value })
const bad = (code: string) => expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })
const sender = { id: 1 }

let userData: string
let secrets: Secrets
beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear()
  userData = await mkdtemp(path.join(tmpdir(), 'yd-secrets-ipc-'))
  secrets = registerSecretsIpc(userData)
})
afterEach(() => rm(userData, { recursive: true, force: true }))

const set = (req: unknown) => registered(CONTRACT.secrets.set.channel)({ sender }, req)
const has = (req: unknown) => registered(CONTRACT.secrets.has.channel)({ sender }, req)

describe('registerSecretsIpc (🔒 YAZ-1775 D4, YAZ-1817)', () => {
  it('registers set and has — and NO channel that answers a value', () => {
    expect(vi.mocked(ipcMain.handle).mock.calls.map(([ch]) => ch).sort()).toEqual([CONTRACT.secrets.has.channel, CONTRACT.secrets.set.channel].sort())
  })

  it('set stores into `<userData>/secrets.json` owner-only; has flips; null clears; main reads the value', async () => {
    expect(await has({ name: 'pixabayApiKey' })).toEqual(ok(false))
    expect(await set({ name: 'pixabayApiKey', value: 'abc123' })).toEqual(ok(undefined))
    expect(await has({ name: 'pixabayApiKey' })).toEqual(ok(true))
    const file = path.join(userData, 'secrets.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, values: { pixabayApiKey: 'abc123' } })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await secrets.read('pixabayApiKey')).toBe('abc123')
    expect(await set({ name: 'pixabayApiKey', value: null })).toEqual(ok(undefined))
    expect(await has({ name: 'pixabayApiKey' })).toEqual(ok(false))
  })

  it('refuses a missing name, an empty value, or a non-string value with BAD_REQUEST', async () => {
    expect(await set(undefined)).toEqual(bad('BAD_REQUEST'))
    expect(await set({ name: '', value: 'x' })).toEqual(bad('BAD_REQUEST'))
    expect(await set({ name: 'pixabayApiKey', value: '' })).toEqual(bad('BAD_REQUEST'))
    expect(await set({ name: 'pixabayApiKey', value: 7 })).toEqual(bad('BAD_REQUEST'))
    expect(await has({ name: 3 })).toEqual(bad('BAD_REQUEST'))
    expect(await has({ name: 'a' })).toEqual(ok(false))
  })

  it("set refuses any name but the Pixabay key — sharing's token and upload password are main's to write", async () => {
    await secrets.set('cloudflareApiToken', 'real-token')
    for (const name of ['cloudflareApiToken', 'shareUploadPassword', 'anythingElse']) {
      expect(await set({ name, value: 'overwritten' })).toEqual(bad('BAD_REQUEST'))
      expect(await set({ name, value: null })).toEqual(bad('BAD_REQUEST'))
    }
    expect(await secrets.read('cloudflareApiToken')).toBe('real-token')
    expect(await has({ name: 'shareUploadPassword' })).toEqual(ok(false))
  })
})
