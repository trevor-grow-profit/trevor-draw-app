import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOUDFLARE_TOKEN_SECRET, SHARE_UPLOAD_PASSWORD_SECRET, type ShareAccount, type ShareSetupProgress } from '@shared/types'
// The REAL Worker (plain JS, the file Cloudflare runs), driven in-process against a Map bucket.
// @ts-expect-error — untyped JS module
import { handle as workerHandle } from '../../../../share/worker.js'
import { createSecrets } from '../secrets'
import { CLOUDFLARE_TOKEN_PAGE, uploadTimeoutMs } from './cloudflare'
import { memoryBucket } from './memoryBucket'
import { createSharing, type Sharing } from './sharing'

const API = 'https://api.test/client/v4'
const ORIGIN = 'https://share.test'

let dir: string
let vault: string
let bucket: ReturnType<typeof memoryBucket>
let workerSecret: string | undefined
let online: boolean
let sharing: Sharing
/** Every request that reached the Worker (not Cloudflare's API): method, route and the permission header. */
let workerCalls: { method: string; route: string; allow: string | null }[]

const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const notFound = () => Response.json({ success: false, errors: [{ code: 10006, message: 'not found' }], result: null }, { status: 404 })
/** The fake account: what exists on it survives a "Forget key" + re-setup (reconnect). */
let account: {
  accounts: ShareAccount[]
  buckets: Set<string>
  scripts: Set<string>
  domains: { id: string; hostname: string; service: string }[]
  zones: { name: string; status: string }[]
  subdomain: string | null
  assetUploads: number
  attached: string[]
  /** The last script upload's metadata (bindings and all). */
  metadata: { bindings?: unknown[] } | null
  /** Every API call, `METHOD /route?query`. */
  calls: string[]
  /** Refusals to inject: the first call matching `when` answers this Cloudflare error, once. */
  refuse: { when: RegExp; status: number; code: number }[]
}
/** Worker requests that fail as unreachable before the fresh address answers (a new workers.dev). */
let workerDown: number
let clock: number
let slept: number[]
const cfError = (status: number, code: number) => Response.json({ success: false, errors: [{ code, message: `raw cloudflare text ${code}` }], result: null }, { status })
const fakeFetch: typeof fetch = async (input, init) => {
  if (!online) throw new TypeError('fetch failed')
  const url = new URL(String(input))
  if (url.href.startsWith(API)) {
    const route = url.pathname.replace('/client/v4', '')
    const method = init?.method ?? 'GET'
    const call = `${method} ${route}${url.search}`
    account.calls.push(call)
    const refusal = account.refuse.find((r) => r.when.test(call))
    if (refusal !== undefined) {
      account.refuse.splice(account.refuse.indexOf(refusal), 1)
      return cfError(refusal.status, refusal.code)
    }
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (route === '/user/tokens/verify') return auth.startsWith('Bearer cfat_') ? cfError(401, 1000) : ok({ status: 'active' })
    if (/^\/accounts\/[^/]+\/tokens\/verify$/.test(route)) return ok({ status: 'active' })
    if (route === '/accounts') return ok(account.accounts)
    if (route === '/zones') return ok(account.zones.filter((z) => z.name === url.searchParams.get('name')).map((z) => ({ id: `z-${z.name}`, ...z })))
    if (/\/r2\/buckets\/[^/]+$/.test(route) && method === 'GET') return account.buckets.has(route.split('/').pop() as string) ? ok({}) : notFound()
    if (route.endsWith('/r2/buckets') && method === 'POST') {
      const name = JSON.parse(String(init?.body)).name
      if (account.buckets.has(name)) return cfError(409, 10073)
      account.buckets.add(name)
      return ok({})
    }
    if (route.endsWith('/workers/scripts') && method === 'GET') return ok([...account.scripts].map((id) => ({ id })))
    if (route.endsWith('/assets-upload-session')) return ok({ jwt: 'session', buckets: [['h1']] })
    if (route.endsWith('/workers/assets/upload')) {
      account.assetUploads++
      return ok({ jwt: 'done' })
    }
    if (/\/workers\/scripts\/[^/]+$/.test(route) && method === 'PUT') {
      account.metadata = JSON.parse(await ((init?.body as FormData).get('metadata') as Blob).text())
      const bindings = (account.metadata?.bindings ?? []) as { type: string; name: string; text?: string }[]
      workerSecret = bindings.find((b) => b.type === 'secret_text' && b.name === 'UPLOAD_PASSWORD')?.text
      account.scripts.add(route.split('/').pop() as string)
      return ok({})
    }
    if (route.endsWith('/workers/domains') && method === 'GET') return ok(account.domains)
    if (route.endsWith('/workers/domains') && method === 'PUT') {
      const body = JSON.parse(String(init?.body))
      account.attached.push(String(init?.body))
      account.domains = [...account.domains.filter((d) => d.hostname !== body.hostname), { id: `d-${body.hostname}`, hostname: body.hostname, service: body.service }]
      return ok({ id: `d-${body.hostname}` })
    }
    if (/\/workers\/domains\/[^/]+$/.test(route) && method === 'DELETE') {
      account.domains = account.domains.filter((d) => d.id !== route.split('/').pop())
      return ok(null)
    }
    if (route.endsWith('/workers/subdomain') && method === 'GET') return account.subdomain === null ? cfError(404, 10007) : ok({ subdomain: account.subdomain })
    if (route.endsWith('/workers/subdomain') && method === 'PUT') {
      account.subdomain = JSON.parse(String(init?.body)).subdomain
      return ok({ subdomain: account.subdomain })
    }
    return ok({})
  }
  if (workerDown > 0) {
    workerDown--
    throw new TypeError('fetch failed')
  }
  // Off the wire, a body always carries its Content-Length (the Worker requires it).
  const headers = new Headers(init?.headers)
  if (typeof init?.body === 'string') headers.set('content-length', String(Buffer.byteLength(init.body)))
  const request = new Request(url, { ...init, headers } as RequestInit)
  workerCalls.push({ method: request.method, route: url.pathname, allow: request.headers.get('x-allow-download') })
  return workerHandle(request, { BUCKET: bucket, UPLOAD_PASSWORD: workerSecret })
}

const makeSharing = () =>
  createSharing({
    secrets: createSecrets(path.join(dir, 'secrets.json')),
    configFile: path.join(dir, 'sharing.json'),
    apiBase: API,
    demoOrigin: ORIGIN,
    modules: { 'worker.js': '// test' },
    readAssets: async () => [{ path: '/assets/viewer.js', bytes: new TextEncoder().encode('// viewer') }],
    fetchImpl: fakeFetch,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
  })

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'share-'))
  vault = path.join(dir, 'vault')
  await import('node:fs/promises').then((fs) => fs.mkdir(path.join(vault, 'Sub'), { recursive: true }))
  await writeFile(path.join(vault, 'Sub', 'Board.excalidraw'), '{}')
  bucket = memoryBucket()
  workerSecret = undefined
  online = true
  workerCalls = []
  workerDown = 0
  clock = 1_000_000
  slept = []
  account = {
    accounts: [{ id: 'acc1', name: 'Test account' }],
    buckets: new Set(),
    scripts: new Set(),
    domains: [],
    zones: ['example.co.uk', 'co.uk', 'yasin.dev'].map((name) => ({ name, status: 'active' })),
    subdomain: 'me',
    assetUploads: 0,
    attached: [],
    metadata: null,
    calls: [],
    refuse: [],
  }
  sharing = makeSharing()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const board = () => path.join(vault, 'Sub', 'Board.excalidraw')
const puts = () => workerCalls.filter((c) => c.method === 'PUT')

describe('sharing (YAZ-1799) against the real Worker', () => {
  it('setup runs every step, keeps both secrets in main, and answers a status with neither', async () => {
    const steps: ShareSetupProgress[] = []
    const status = await sharing.setup('tok', (p) => steps.push(p))
    expect(steps.filter((s) => s.state === 'done').map((s) => s.step)).toEqual(['verify', 'account', 'bucket', 'viewer', 'worker', 'subdomain', 'test'])
    expect(status).toMatchObject({ state: 'ready', url: ORIGIN, workersDevUrl: 'https://yaseen-draw-share.me.workers.dev' })
    expect(JSON.stringify(status)).not.toContain(workerSecret)
    const secrets = JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8')).values
    expect(secrets[CLOUDFLARE_TOKEN_SECRET]).toBe('tok')
    expect(secrets[SHARE_UPLOAD_PASSWORD_SECRET]).toBe(workerSecret)
    expect(bucket.objects.size).toBe(0) // the test upload cleaned up after itself
  })

  it('one link; re-upload keeps the id and the permission; view only is enforced by the Worker; stop kills the link', async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(first.url).toBe(`${ORIGIN}/b/${first.id}`)
    expect(first.allowDownload).toBe(true) // a new share: view and download
    let page = await (await fakeFetch(first.url)).text()
    expect(page).toContain('id="dl-excalidraw"')
    expect(page).toContain('id="dl-png"')
    expect((await fakeFetch(`${ORIGIN}/raw/${first.id}`)).status).toBe(200)

    // view only: same link, no re-upload, buttons gone, /raw refused, the viewer can still draw
    const viewOnly = await sharing.setPermission(vault, board(), false)
    expect([viewOnly.id, viewOnly.url, viewOnly.allowDownload]).toEqual([first.id, first.url, false])
    page = await (await fakeFetch(first.url)).text()
    expect(page).not.toContain('id="dl-png"')
    expect(page).not.toContain('id="dl-excalidraw"')
    expect((await fakeFetch(`${ORIGIN}/raw/${first.id}`)).status).toBe(403)
    expect(await (await fakeFetch(`${ORIGIN}/scene/${first.id}`)).text()).toBe('{"v":1}')

    // an auto-upload after a save keeps the id and the record's view-only flag
    const second = await sharing.publish(vault, board(), '{"v":2}', first.id)
    expect([second.id, second.sharedAt, second.allowDownload]).toEqual([first.id, first.sharedAt, false])
    expect(await (await fakeFetch(`${ORIGIN}/scene/${first.id}`)).text()).toBe('{"v":2}')

    // back to view and download
    await sharing.setPermission(vault, board(), true)
    expect(await (await fakeFetch(`${ORIGIN}/raw/${first.id}`)).text()).toBe('{"v":2}')
    const onDisk = JSON.parse(await readFile(path.join(vault, '.yaseendraw', 'shares.json'), 'utf8'))
    expect(onDisk.shares['Sub/Board.excalidraw']).toMatchObject({ id: first.id, allowDownload: true })
    expect([...bucket.objects.keys()].sort()).toEqual([`boards/${first.id}.excalidraw`, `perm/${first.id}`])

    await sharing.stop(vault, board())
    expect((await fakeFetch(first.url)).status).toBe(404)
    expect(bucket.objects.size).toBe(0)
    expect(await sharing.get(vault, board())).toBeNull()
  })

  it('publish creates the record and the object; setPermission only PATCHes; stop deletes both', async () => {
    await sharing.setup('tok', () => {})
    workerCalls = []
    const first = await sharing.publish(vault, board(), '{"v":1}')
    expect(puts()).toEqual([{ method: 'PUT', route: `/api/boards/${first.id}`, allow: '1' }]) // a new share: view and download
    expect(bucket.objects.has(`boards/${first.id}.excalidraw`)).toBe(true)
    expect((await sharing.get(vault, board()))?.id).toBe(first.id)
    workerCalls = []
    await sharing.setPermission(vault, board(), false)
    expect(workerCalls.map((c) => c.method)).toEqual(['PATCH'])
    await sharing.stop(vault, board())
    expect(bucket.objects.size).toBe(0)
    expect(await sharing.get(vault, board())).toBeNull()
  })

  it('a re-upload never sends a permission, so it can never reset a view-only board', async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    await sharing.setPermission(vault, board(), false)
    workerCalls = []
    await sharing.publish(vault, board(), '{"v":2}', first.id)
    await sharing.publish(vault, board(), '{"v":3}') // the dialog's publish on an already-shared board is a re-upload too
    expect(puts().map((c) => c.allow)).toEqual([null, null])
    expect((await sharing.get(vault, board()))?.allowDownload).toBe(false)
  })

  it('end to end: a view-only board is still view-only on the Worker after a re-upload', async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    await sharing.setPermission(vault, board(), false)
    await sharing.publish(vault, board(), '{"v":2}', first.id)
    expect((await fakeFetch(`${ORIGIN}/raw/${first.id}`)).status).toBe(403)
  })

  it('refuses a board over 100 MB before any network call; a shared one keeps its record, marked failed until it shrinks', async () => {
    await sharing.setup('tok', () => {})
    await expect(sharing.publish(vault, board(), 'x'.repeat(100_000_001))).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(bucket.objects.size).toBe(0)
    const first = await sharing.publish(vault, board(), '{"v":1}')
    workerCalls = []
    await expect(sharing.publish(vault, board(), 'x'.repeat(100_000_001), first.id)).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(workerCalls).toEqual([])
    const failed = await sharing.get(vault, board())
    expect(failed).toMatchObject({ id: first.id, sync: { state: 'failed' } })
    expect(failed?.sync.message).toMatch(/100\.0 MB/)
    await sharing.publish(vault, board(), '{"v":2}', first.id)
    expect((await sharing.get(vault, board()))?.sync).toEqual({ state: 'ok' })
  })

  it('stale: the Worker lost the copy (404) — the next save re-creates it on the SAME id, with the recorded permission', async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    await sharing.setPermission(vault, board(), false)
    bucket.objects.clear()
    expect((await sharing.list(vault))[0]).toMatchObject({ id: first.id, stale: true })
    expect(await sharing.get(vault, board())).toMatchObject({ stale: true }) // the Share dialog sees it too
    workerCalls = []
    await sharing.publish(vault, board(), '{"v":2}', first.id)
    expect(puts()).toEqual([{ method: 'PUT', route: `/api/boards/${first.id}`, allow: '0' }]) // a create on the Worker: it needs the flag
    expect((await sharing.list(vault))[0]).toMatchObject({ id: first.id, allowDownload: false, stale: false })
    expect((await fakeFetch(`${ORIGIN}/raw/${first.id}`)).status).toBe(403)
    workerCalls = []
    await sharing.publish(vault, board(), '{"v":3}', first.id)
    expect(puts().map((c) => c.allow)).toEqual([null]) // live again: back to plain re-uploads
  })

  it("list(check: false) — the sidebar badges' call — sends no HEAD per share; the Settings list does", async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    workerCalls = []
    expect(await sharing.list(vault, { check: false })).toEqual([expect.objectContaining({ id: first.id, stale: false, fileExists: true })])
    expect(workerCalls).toEqual([])
    bucket.objects.clear()
    expect((await sharing.list(vault, { check: false }))[0]).toMatchObject({ stale: false }) // unchecked: nothing learned
    expect((await sharing.list(vault))[0]).toMatchObject({ stale: true })
    expect(workerCalls).toEqual([expect.objectContaining({ method: 'HEAD', route: `/scene/${first.id}` })])
  })

  it('a re-upload names its link: it lands on the record wherever a rename moved it, and never re-creates a stopped one', async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    const moved = path.join(vault, 'Moved.excalidraw')
    await sharing.relocate([vault], board(), moved)
    // An upload started under the old path before the rename answered.
    await sharing.publish(vault, board(), '{"v":2}', first.id)
    expect(await sharing.get(vault, board())).toBeNull()
    expect((await sharing.get(vault, moved))?.id).toBe(first.id)
    expect(await (await fakeFetch(`${ORIGIN}/scene/${first.id}`)).text()).toBe('{"v":2}')
    await sharing.stop(vault, moved)
    await expect(sharing.publish(vault, moved, '{"v":3}', first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(bucket.objects.size).toBe(0)
  })

  it('two writers at once never lose each other\'s shares.json entry', async () => {
    await sharing.setup('tok', () => {})
    const other = makeSharing() // a second instance: the chain is per vault, not per instance
    const boards = ['A', 'B', 'C', 'D'].map((n) => path.join(vault, `${n}.excalidraw`))
    const shared = await Promise.all(boards.map((b, i) => (i % 2 === 0 ? sharing : other).publish(vault, b, '{}')))
    const onDisk = JSON.parse(await readFile(path.join(vault, '.yaseendraw', 'shares.json'), 'utf8'))
    expect(Object.keys(onDisk.shares).sort()).toEqual(['A.excalidraw', 'B.excalidraw', 'C.excalidraw', 'D.excalidraw'])
    await Promise.all([sharing.setPermission(vault, boards[0], false), other.relocate([vault], boards[1], path.join(vault, 'B2.excalidraw')), sharing.stop(vault, boards[2])])
    const after = JSON.parse(await readFile(path.join(vault, '.yaseendraw', 'shares.json'), 'utf8')).shares
    expect(Object.keys(after).sort()).toEqual(['A.excalidraw', 'B2.excalidraw', 'D.excalidraw'])
    expect(after['A.excalidraw']).toMatchObject({ id: shared[0].id, allowDownload: false })
    expect(after['B2.excalidraw'].id).toBe(shared[1].id)
  })

  it('a failed re-upload keeps the record and is reported on the entry; the next one clears it', async () => {
    await sharing.setup('tok', () => {})
    await sharing.publish(vault, board(), '{"v":1}')
    online = false
    await expect(sharing.publish(vault, board(), '{"v":2}')).rejects.toMatchObject({ code: 'OFFLINE' })
    const failed = await sharing.get(vault, board())
    expect(failed?.sync).toMatchObject({ state: 'failed' })
    expect(failed?.sync.message).toMatch(/Can't reach/)
    online = true
    await sharing.publish(vault, board(), '{"v":3}')
    expect((await sharing.get(vault, board()))?.sync).toEqual({ state: 'ok' })
  })

  it('reconnect: after "Forget key" a new setup REUSES the Worker, bucket and domain, and old links stay manageable', async () => {
    await sharing.setup('tok', () => {})
    await sharing.setDomain('share.yasin.dev')
    const first = await sharing.publish(vault, board(), '{"v":1}')
    const oldPassword = workerSecret
    await sharing.disconnect(vault, false) // "Forget key on this Mac": nothing on Cloudflare is touched
    expect((await sharing.status()).state).toBe('off')
    expect(bucket.objects.has(`boards/${first.id}.excalidraw`)).toBe(true)

    const steps: ShareSetupProgress[] = []
    const again = await sharing.setup('tok', (p) => steps.push(p))
    expect(steps.find((p) => p.step === 'bucket' && p.state === 'done')?.message).toMatch(/existing .* reusing it/)
    expect(steps.find((p) => p.step === 'worker' && p.state === 'done')?.message).toMatch(/existing .* kept its links/)
    expect(again.customDomain).toBe('share.yasin.dev')
    expect(workerSecret).not.toBe(oldPassword) // a NEW upload password
    // The old link is still there and manageable with the new password.
    expect((await fakeFetch(first.url)).status).toBe(200)
    await sharing.setPermission(vault, board(), false)
    expect((await fakeFetch(`${ORIGIN}/raw/${first.id}`)).status).toBe(403)
    await sharing.stop(vault, board())
    expect((await fakeFetch(first.url)).status).toBe(404)
  })

  it('delete everything: wipes the bucket a page per request until the Worker says done, then deletes the Worker and bucket', async () => {
    await sharing.setup('tok', () => {})
    await sharing.publish(vault, board(), '{"v":1}')
    for (let i = 0; i < 2500; i++) bucket.objects.set(`boards/old${String(i).padStart(16, '0')}.excalidraw`, { bytes: new Uint8Array([123, 125]), customMetadata: {} })
    workerCalls = []
    await sharing.disconnect(vault, true)
    expect(workerCalls.map((c) => c.route)).toEqual(Array(3).fill('/api/wipe'))
    expect(bucket.objects.size).toBe(0)
    expect(await sharing.get(vault, board())).toBeNull()
    expect((await sharing.status()).state).toBe('off')
  })

  it('several accounts: listed for a picker; setup refuses to guess and uses the picked one', async () => {
    account.accounts = [{ id: 'acc1', name: 'Personal' }, { id: 'acc2', name: 'Work' }]
    expect(await sharing.accounts('tok')).toHaveLength(2)
    await expect(sharing.setup('tok', () => {})).rejects.toThrow(/more than one Cloudflare account/)
    const status = await sharing.setup('tok', () => {}, 'acc2')
    expect(status.accountName).toBe('Work')
  })

  it('custom domain: the longest matching zone on the account wins (share.example.co.uk → example.co.uk, not co.uk)', async () => {
    await sharing.setup('tok', () => {})
    await sharing.setDomain('share.example.co.uk')
    expect(account.attached.map((b) => JSON.parse(b))).toEqual([{ hostname: 'share.example.co.uk', service: 'yaseen-draw-share', zone_id: 'z-example.co.uk' }])
    await expect(sharing.setDomain('share.missingzone.com')).rejects.toThrow(/isn't under any domain on your Cloudflare account/)
  })

  it('custom domain: suffixes are looked up longest first on the account, and the new domain attaches BEFORE the old one detaches', async () => {
    await sharing.setup('tok', () => {})
    await sharing.setDomain('share.yasin.dev')
    account.calls = []
    await sharing.setDomain('a.b.example.co.uk')
    const zoneCalls = account.calls.filter((c) => c.startsWith('GET /zones'))
    expect(zoneCalls).toEqual([
      'GET /zones?name=a.b.example.co.uk&account.id=acc1',
      'GET /zones?name=b.example.co.uk&account.id=acc1',
      'GET /zones?name=example.co.uk&account.id=acc1',
    ])
    const order = account.calls.filter((c) => c.includes('/workers/domains'))
    expect(order).toEqual(['PUT /accounts/acc1/workers/domains', 'DELETE /accounts/acc1/workers/domains/d-share.yasin.dev'])
    expect((await sharing.status()).customDomain).toBe('a.b.example.co.uk')
  })

  it('custom domain: a pending zone, an existing DNS record and a missing permission each get their own plain message', async () => {
    await sharing.setup('tok', () => {})
    account.zones.push({ name: 'pending.dev', status: 'pending' })
    await expect(sharing.setDomain('share.pending.dev')).rejects.toThrow(/pending\.dev is on your Cloudflare account but isn't active yet/)
    account.refuse.push({ when: /PUT .*\/workers\/domains/, status: 409, code: 100117 })
    await expect(sharing.setDomain('share.yasin.dev')).rejects.toThrow(/already has a DNS record/)
    account.refuse.push({ when: /GET \/zones/, status: 403, code: 10000 })
    await expect(sharing.setDomain('share.yasin.dev')).rejects.toThrow(/“Zone: Read and Workers Routes: Edit”/)
    await sharing.setDomain('share.yasin.dev')
    account.refuse.push({ when: /DELETE .*\/workers\/domains/, status: 403, code: 10000 })
    const err = await sharing.setDomain(null).catch((e: Error) => e)
    expect(String(err)).toMatch(/Zone: Read and Workers Routes: Edit/)
    expect(String(err)).not.toMatch(/raw cloudflare text/)
  })

  it('setup: the upload password rides in the Worker upload as a secret_text binding — no separate secret call, no environment', async () => {
    await sharing.setup('tok', () => {})
    expect(account.metadata?.bindings).toEqual(expect.arrayContaining([{ type: 'secret_text', name: 'UPLOAD_PASSWORD', text: workerSecret }]))
    expect(account.calls.some((c) => c.includes('/secrets'))).toBe(false)
    await sharing.setDomain('share.yasin.dev')
    expect(JSON.parse(account.attached[0])).not.toHaveProperty('environment')
  })

  it('setup: an account-owned key (cfat_…) is checked at its account, never at /user (D18)', async () => {
    const status = await sharing.setup('cfat_abc', () => {})
    expect(status.state).toBe('ready')
    expect(account.calls).toContain('GET /accounts/acc1/tokens/verify')
    expect(account.calls).not.toContain('GET /user/tokens/verify')
    expect(await sharing.accounts('cfat_abc')).toHaveLength(1)
  })

  it('setup: an existing bucket is reused when creating it answers 10073 (it is ours)', async () => {
    account.refuse.push({ when: /GET .*\/r2\/buckets\/yaseen-draw-shares/, status: 404, code: 10006 })
    account.buckets.add('yaseen-draw-shares')
    expect((await sharing.setup('tok', () => {})).state).toBe('ready')
  })

  it.each([
    ['bucket', /GET .*\/r2\/buckets\//, 'Workers R2 Storage: Edit'],
    ['worker', /GET .*\/workers\/scripts$/, 'Workers Scripts: Edit'],
  ])('setup: the %s check runs inside its own step, so a 403 there names that permission', async (step, when, permission) => {
    account.refuse.push({ when, status: 403, code: 10000 })
    const steps: ShareSetupProgress[] = []
    await expect(sharing.setup('tok', (p) => steps.push(p))).rejects.toThrow(permission)
    expect(steps.at(-1)).toMatchObject({ step, state: 'failed' })
  })

  it('setup: Cloudflare error codes become plain English, never Cloudflare\'s own text', async () => {
    const cases: [RegExp, number, number, RegExp][] = [
      [/GET \/user\/tokens\/verify/, 400, 1000, /didn't accept this key/],
      [/POST .*\/r2\/buckets$/, 403, 10042, /R2 .* isn't switched on .*dash\.cloudflare\.com\/\?to=\/:account\/r2/],
      [/POST .*\/r2\/buckets$/, 403, 10000, /missing the “Workers R2 Storage: Edit” permission/],
      [/PUT .*\/workers\/scripts\//, 400, 10021, /Could not upload the share Worker \(Cloudflare error 10021\)/],
    ]
    for (const [when, status, code, message] of cases) {
      account.refuse = [{ when, status, code }]
      account.buckets.clear()
      const err = await sharing.setup('tok', () => {}).catch((e: Error) => e)
      expect(String(err)).toMatch(message)
      expect(String(err)).not.toMatch(/raw cloudflare text/)
    }
  })

  it('setup: no workers.dev subdomain yet (10007) → claims <account>-xxxx, retrying a taken name (D17)', async () => {
    account.subdomain = null
    account.refuse.push({ when: /PUT .*\/workers\/subdomain$/, status: 409, code: 10036 }) // the first name is someone else's
    const status = await sharing.setup('tok', () => {})
    expect(account.subdomain).toMatch(/^test-account-[a-z0-9]{4}$/)
    expect(account.calls.filter((c) => c === 'PUT /accounts/acc1/workers/subdomain')).toHaveLength(2)
    expect(status.workersDevUrl).toBe(`https://yaseen-draw-share.${account.subdomain}.workers.dev`)
  })

  it('setup: when Cloudflare refuses the claim outright, it says to claim one in the dashboard', async () => {
    account.subdomain = null
    account.refuse.push({ when: /PUT .*\/workers\/subdomain$/, status: 400, code: 10032 })
    await expect(sharing.setup('tok', () => {})).rejects.toThrow(/claim a workers\.dev subdomain in the Cloudflare dashboard \(Workers & Pages\), then run setup again/)
  })

  it('setup: the test upload backs off while a fresh workers.dev address comes up, and gives up after ~90 s', async () => {
    workerDown = 4
    expect((await sharing.setup('tok', () => {})).state).toBe('ready')
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000])
    slept = []
    workerDown = 1_000
    await sharing.disconnect(vault, false)
    await expect(sharing.setup('tok', () => {})).rejects.toThrow(/isn't answering yet/)
    const total = slept.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(60_000)
    expect(total).toBeLessThanOrEqual(90_000)
  })

  it('uploads get far more time than a 20 s API call, growing with size', () => {
    expect(uploadTimeoutMs(0)).toBe(60_000)
    expect(uploadTimeoutMs(50_000_000)).toBe(160_000)
  })

  it('setup is idempotent: run twice, it reuses everything and ends in the same state with a new password', async () => {
    const first = await sharing.setup('tok', () => {})
    await sharing.setDomain('share.yasin.dev')
    const password = workerSecret
    const second = await sharing.setup('tok', () => {})
    expect(second).toMatchObject({ ...first, customDomain: 'share.yasin.dev', readyAt: expect.any(Number), url: ORIGIN })
    expect(workerSecret).not.toBe(password)
    expect(account.domains).toHaveLength(1)
  })

  it('delete everything: a bucket Cloudflare says is not empty (10008) asks to finish deleting, in plain words', async () => {
    await sharing.setup('tok', () => {})
    account.refuse.push({ when: /DELETE .*\/r2\/buckets\//, status: 409, code: 10008 })
    const err = await sharing.disconnect(vault, true).catch((e: Error) => e)
    expect(String(err)).toMatch(/still has shared boards in it/)
    expect(String(err)).not.toMatch(/raw cloudflare text/)
  })

  it('the token page pre-fills all five permissions, every account and every zone (D16)', () => {
    const url = new URL(CLOUDFLARE_TOKEN_PAGE)
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
      { key: 'account_settings', type: 'read' },
      { key: 'zone', type: 'read' },
      { key: 'workers_routes', type: 'edit' },
    ])
    expect([url.searchParams.get('accountId'), url.searchParams.get('zoneId'), url.searchParams.get('name')]).toEqual(['*', 'all', 'Trevor Draw sharing'])
  })

  it('an in-app rename or move carries the share (same id, same permission); a delete stops it', async () => {
    await sharing.setup('tok', () => {})
    const first = await sharing.publish(vault, board(), '{"v":1}')
    await sharing.setPermission(vault, board(), false)
    const moved = path.join(vault, 'Elsewhere', 'Renamed.excalidraw')
    await sharing.relocate([vault], board(), moved)
    expect(await sharing.get(vault, board())).toBeNull()
    expect(await sharing.get(vault, moved)).toMatchObject({ id: first.id, allowDownload: false })
    // A folder rename moves every share inside it.
    const movedDir = path.join(vault, 'Renamed folder')
    await sharing.relocate([vault], path.join(vault, 'Elsewhere'), movedDir)
    const inDir = path.join(movedDir, 'Renamed.excalidraw')
    expect((await sharing.get(vault, inDir))?.id).toBe(first.id)
    // Deleting the folder stops the share: the link dies and the record goes.
    await sharing.forget([vault], movedDir)
    expect((await fakeFetch(first.url)).status).toBe(404)
    expect(await sharing.get(vault, inDir)).toBeNull()
  })

  it('a cut-paste into another open vault carries the share into that vault\'s shares.json (same id, same permission)', async () => {
    await sharing.setup('tok', () => {})
    const other = path.join(dir, 'other')
    const first = await sharing.publish(vault, board(), '{"v":1}')
    await sharing.setPermission(vault, board(), false)
    const there = path.join(other, 'Pasted.excalidraw')
    await sharing.relocate([vault, other], board(), there)
    expect(await sharing.get(vault, board())).toBeNull()
    expect(await sharing.get(other, there)).toMatchObject({ id: first.id, allowDownload: false })
    expect((await fakeFetch(first.url)).status).toBe(200)
  })

  it('a rename touches no vault that has nothing shared (shares.json is never created by a repair)', async () => {
    const other = path.join(dir, 'other')
    await sharing.relocate([vault, other], board(), path.join(vault, 'X.excalidraw'))
    await expect(readFile(path.join(vault, '.yaseendraw', 'shares.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a delete while offline keeps the record (Settings lists it to stop later)', async () => {
    await sharing.setup('tok', () => {})
    await sharing.publish(vault, board(), '{"v":1}')
    online = false
    await sharing.forget([vault], board())
    online = true
    expect(await sharing.get(vault, board())).not.toBeNull()
  })

  it('without setup, share and stop say NOT_SET_UP', async () => {
    await expect(sharing.publish(vault, board(), '{}')).rejects.toMatchObject({ code: 'NOT_SET_UP' })
  })
})
