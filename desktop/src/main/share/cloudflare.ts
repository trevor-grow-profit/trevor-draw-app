/**
 * THE CLOUDFLARE API CLIENT (YAZ-1799): only the calls "Set up sharing", custom domains
 * and "delete everything" need. Electron-free — plain `fetch` — so it unit-tests against a stub
 * and runs against `tools/fakeCloudflare.mjs` in the demo.
 *
 * The base URL is `YASEEN_DRAW_CLOUDFLARE_API` when set (the demo points it at the fake server);
 * production is `https://api.cloudflare.com/client/v4`, always.
 *
 * Every failure becomes a `BridgeFailure` whose message is written for the person in Settings:
 * `OFFLINE` when Cloudflare could not be reached at all (never a hang — every call has a timeout),
 * `PROVIDER_FAILED` when it answered and refused. The message names what failed and Cloudflare's
 * error code, never Cloudflare's own wording (that goes to the log); `sharing.ts` turns the codes
 * that have a remedy into plain English.
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { ShareAccount } from '@shared/types'
import { BridgeFailure } from '../fs/fsUtils'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
/**
 * Where "Open Cloudflare" goes: the token page, pre-filled with every permission sharing needs
 * (YAZ-1799 D16) — the custom domain's two included — for all accounts and all zones.
 */
export const CLOUDFLARE_TOKEN_PAGE =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent(
    JSON.stringify([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
      { key: 'account_settings', type: 'read' },
      { key: 'zone', type: 'read' },
      { key: 'workers_routes', type: 'edit' },
    ]),
  ) +
  '&accountId=*&zoneId=all&name=' +
  encodeURIComponent('Trevor Draw sharing')

const API_TIMEOUT_MS = 20_000
/** An upload's patience: a minute, plus ~2 s per MB (a slow uplink moves ~0.5 MB/s). */
export const uploadTimeoutMs = (bytes: number): number => Math.round(60_000 + (bytes / 1_000_000) * 2_000)

interface CfEnvelope<T> {
  success: boolean
  errors?: { code: number; message: string }[]
  result: T
}

/** Which permission each step needs, so a 403 can name it. */
export const STEP_PERMISSION = {
  bucket: 'Workers R2 Storage: Edit',
  worker: 'Workers Scripts: Edit',
  subdomain: 'Workers Scripts: Edit',
  account: 'Account Settings: Read',
  domain: 'Zone: Read and Workers Routes: Edit',
} as const

export class CloudflareError extends BridgeFailure {
  constructor(
    code: 'OFFLINE' | 'PROVIDER_FAILED',
    message: string,
    readonly status: number,
    readonly cfCode: number | null,
  ) {
    super(code, message)
  }
}

/** Tries per call when the socket dies under the request: the first, then two more. */
const SOCKET_RETRIES = 3
const DEAD_SOCKET_CODES = new Set(['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET', 'ECONNREFUSED'])

function deadSocketCode(err: unknown): string | null {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined
  const code = cause !== undefined && cause !== null && typeof cause.code === 'string' ? cause.code : null
  return code !== null && DEAD_SOCKET_CODES.has(code) ? code : null
}

/** `fetch failed` whose cause is the socket closing under the write — not a timeout, not a refusal Cloudflare answered. */
export function isDeadSocket(err: unknown): boolean {
  return deadSocketCode(err) !== null
}

export function offline(what: string, err: unknown): CloudflareError {
  const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
  // The person gets plain English; the log keeps the real reason (undici folds it into `cause`).
  const cause = err instanceof Error && err.cause instanceof Error ? ` — cause: ${err.cause.name} ${err.cause.message}` : ''
  console.warn(`[share] could not reach ${what}: ${err instanceof Error ? `${err.name} ${err.message}` : String(err)}${cause}`)
  return new CloudflareError('OFFLINE', timedOut ? `${what} took too long to answer. Check your internet connection and try again.` : `Can't reach ${what}. Check your internet connection and try again.`, 0, null)
}

export interface CloudflareClient {
  /** A user token checks at /user/tokens/verify; an account-owned one (`cfat_…`, D18) at its account's. */
  verifyToken(): Promise<void>
  listAccounts(): Promise<ShareAccount[]>
  /** Creates the bucket; an existing bucket we own is fine (setup is re-runnable). */
  createBucket(accountId: string, name: string): Promise<void>
  deleteBucket(accountId: string, name: string): Promise<void>
  /**
   * Workers Static Assets: upload `files` (paths like `/assets/viewer.js`) for `script` and answer
   * the completion token the script upload attaches. Only files Cloudflare does not already hold
   * are sent — a re-setup with the same viewer uploads nothing.
   */
  uploadAssets(accountId: string, script: string, files: readonly AssetFile[]): Promise<string>
  /** The upload password rides in the same upload, as a `secret_text` binding. */
  uploadWorker(accountId: string, name: string, modules: Record<string, string>, mainModule: string, bucketName: string, password: string, assetsJwt?: string): Promise<void>
  deleteWorker(accountId: string, name: string): Promise<void>
  /** The account's workers.dev subdomain, or null when it has never claimed one (10007). */
  getSubdomain(accountId: string): Promise<string | null>
  claimSubdomain(accountId: string, subdomain: string): Promise<void>
  enableWorkersDev(accountId: string, script: string): Promise<void>
  /** Does this bucket already exist on the account? (reconnect after "Forget key") */
  hasBucket(accountId: string, name: string): Promise<boolean>
  /** Does this Worker script already exist on the account? */
  hasWorker(accountId: string, name: string): Promise<boolean>
  /** Custom domains already attached to `service` (reconnect restores the first). */
  listDomains(accountId: string, service: string): Promise<{ id: string; hostname: string }[]>
  /** The account's zone named exactly `name`, active or not, or null. */
  findZone(accountId: string, name: string): Promise<{ id: string; name: string; status: string } | null>
  attachDomain(accountId: string, hostname: string, script: string, zoneId: string): Promise<{ id: string }>
  detachDomain(accountId: string, domainId: string): Promise<void>
}

export interface AssetFile {
  /** Served path, leading slash: `/assets/viewer.js`. */
  path: string
  bytes: Uint8Array
}

const MIME: Record<string, string> = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html', '.xml': 'application/xml', '.txt': 'text/plain' }
export const assetMime = (path: string): string => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
/** The manifest hash: 32 hex chars of the content (+ extension, so a renamed type re-uploads). Wrangler uses blake3; Cloudflare only needs a stable 32-hex id. */
export const assetHash = (file: AssetFile): string => createHash('sha256').update(Buffer.from(file.bytes).toString('base64') + extname(file.path).slice(1)).digest('hex').slice(0, 32)

export function createCloudflareClient(token: string, base: string = CLOUDFLARE_API, fetchImpl: typeof fetch = fetch): CloudflareClient {
  async function call<T>(method: string, route: string, body?: BodyInit, contentType?: string, bearer: string = token, timeoutMs = API_TIMEOUT_MS): Promise<{ status: number; env: CfEnvelope<T> }> {
    let res: Response
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}` }
    if (contentType !== undefined) headers['content-type'] = contentType
    // A request written into a keep-alive socket Cloudflare has already closed dies with EPIPE or
    // ECONNRESET before a byte reaches the server (Electron's Node does not notice the closed
    // socket first; setup's asset reads leave the connection idle long enough). Nothing was
    // received, so sending it again is safe — the same retry wrangler makes. A timeout is not retried.
    for (let attempt = 1; ; attempt += 1) {
      try {
        res = await fetchImpl(`${base}${route}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
        break
      } catch (err) {
        if (attempt < SOCKET_RETRIES && isDeadSocket(err)) {
          console.warn(`[share] ${method} ${route}: the connection was closed under the request (${deadSocketCode(err)}); sending it again (${attempt}/${SOCKET_RETRIES - 1})`)
          await new Promise((r) => setTimeout(r, 300 * attempt))
          continue
        }
        throw offline('Cloudflare', err)
      }
    }
    let env: CfEnvelope<T>
    try {
      env = (await res.json()) as CfEnvelope<T>
    } catch {
      throw new CloudflareError('PROVIDER_FAILED', `Cloudflare answered something unexpected (HTTP ${res.status}).`, res.status, null)
    }
    return { status: res.status, env }
  }
  const fail = (status: number, env: CfEnvelope<unknown>, what: string): never => {
    const first = env.errors?.[0]
    console.warn(`[share] ${what}: Cloudflare said HTTP ${status}`, env.errors)
    throw new CloudflareError('PROVIDER_FAILED', `${what} (Cloudflare error ${first?.code ?? `HTTP ${status}`}). Try again in a moment.`, status, first?.code ?? null)
  }
  const ok = async <T>(method: string, route: string, what: string, body?: BodyInit, contentType?: string, timeoutMs?: number): Promise<T> => {
    const { status, env } = await call<T>(method, route, body, contentType, token, timeoutMs)
    if (!env.success || status >= 400) fail(status, env, what)
    return env.result
  }
  const jsonBody = (v: unknown) => JSON.stringify(v)
  const a = (id: string) => `/accounts/${encodeURIComponent(id)}`

  return {
    async verifyToken() {
      let route = '/user/tokens/verify'
      if (token.startsWith('cfat_')) {
        const [account] = await ok<{ id: string }[]>('GET', '/accounts', 'Cloudflare did not accept this key')
        if (account === undefined) throw new CloudflareError('PROVIDER_FAILED', 'This key cannot see any Cloudflare account.', 403, null)
        route = `${a(account.id)}/tokens/verify`
      }
      const result = await ok<{ status: string }>('GET', route, 'Cloudflare did not accept this key')
      if (result.status !== 'active') throw new CloudflareError('PROVIDER_FAILED', `This key is ${result.status}, not active. Make a new one and paste it here.`, 200, null)
    },
    listAccounts: () => ok<ShareAccount[]>('GET', '/accounts', 'Could not list your Cloudflare accounts'),
    async createBucket(accountId, name) {
      const { status, env } = await call('POST', `${a(accountId)}/r2/buckets`, jsonBody({ name }), 'application/json')
      if (env.success && status < 400) return
      if (env.errors?.[0]?.code === 10073) return // already exists and is ours: setup is re-runnable
      fail(status, env, 'Could not create the storage bucket')
    },
    deleteBucket: (accountId, name) => ok('DELETE', `${a(accountId)}/r2/buckets/${encodeURIComponent(name)}`, 'Could not delete the storage bucket'),
    async uploadAssets(accountId, script, files) {
      const byHash = new Map<string, AssetFile>()
      const manifest: Record<string, { hash: string; size: number }> = {}
      for (const f of files) {
        const hash = assetHash(f)
        byHash.set(hash, f)
        manifest[f.path] = { hash, size: f.bytes.length }
      }
      const session = await ok<{ jwt: string; buckets?: string[][] }>('POST', `${a(accountId)}/workers/scripts/${encodeURIComponent(script)}/assets-upload-session`, 'Could not start uploading the viewer', jsonBody({ manifest }), 'application/json')
      let completion = session.jwt
      for (const bucket of session.buckets ?? []) {
        const form = new FormData()
        for (const hash of bucket) {
          const f = byHash.get(hash)
          if (f === undefined) continue
          form.append(hash, new Blob([Buffer.from(f.bytes).toString('base64')], { type: assetMime(f.path) }), hash)
        }
        // Each bucket is authorised by the SESSION token, not the API key.
        const size = bucket.reduce((n, hash) => n + (byHash.get(hash)?.bytes.length ?? 0), 0)
        const { status, env } = await call<{ jwt?: string } | null>('POST', `${a(accountId)}/workers/assets/upload?base64=true`, form, undefined, session.jwt, uploadTimeoutMs(size))
        if (!env.success || status >= 400) fail(status, env, 'Could not upload the viewer')
        if (env.result?.jwt !== undefined) completion = env.result.jwt
      }
      return completion
    },
    async uploadWorker(accountId, name, modules, mainModule, bucketName, password, assetsJwt) {
      const form = new FormData()
      const bindings: Record<string, string>[] = [
        { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName },
        { type: 'secret_text', name: 'UPLOAD_PASSWORD', text: password },
      ]
      if (assetsJwt !== undefined) bindings.push({ type: 'assets', name: 'ASSETS' })
      const metadata: Record<string, unknown> = { main_module: mainModule, compatibility_date: '2025-01-01', bindings }
      if (assetsJwt !== undefined) metadata.assets = { jwt: assetsJwt }
      form.append('metadata', new Blob([jsonBody(metadata)], { type: 'application/json' }))
      for (const [file, source] of Object.entries(modules)) form.append(file, new Blob([source], { type: 'application/javascript+module' }), file)
      const size = Object.values(modules).reduce((n, source) => n + source.length, 0)
      await ok('PUT', `${a(accountId)}/workers/scripts/${encodeURIComponent(name)}`, 'Could not upload the share Worker', form, undefined, uploadTimeoutMs(size))
    },
    deleteWorker: (accountId, name) => ok('DELETE', `${a(accountId)}/workers/scripts/${encodeURIComponent(name)}?force=true`, 'Could not delete the share Worker'),
    async getSubdomain(accountId) {
      const { status, env } = await call<{ subdomain: string } | null>('GET', `${a(accountId)}/workers/subdomain`)
      if (env.errors?.[0]?.code === 10007) return null
      if (!env.success || status >= 400) fail(status, env, 'Could not read your workers.dev address')
      return env.result?.subdomain ?? null
    },
    claimSubdomain: (accountId, subdomain) => ok('PUT', `${a(accountId)}/workers/subdomain`, 'Could not claim a workers.dev address', jsonBody({ subdomain }), 'application/json'),
    enableWorkersDev: (accountId, script) =>
      ok('POST', `${a(accountId)}/workers/scripts/${encodeURIComponent(script)}/subdomain`, 'Could not turn on the workers.dev address', jsonBody({ enabled: true }), 'application/json'),
    async hasBucket(accountId, name) {
      const { status, env } = await call('GET', `${a(accountId)}/r2/buckets/${encodeURIComponent(name)}`)
      if (status === 404) return false
      if (!env.success || status >= 400) fail(status, env, 'Could not check for an existing storage bucket')
      return true
    },
    async hasWorker(accountId, name) {
      const scripts = await ok<{ id: string }[]>('GET', `${a(accountId)}/workers/scripts`, 'Could not check for an existing share Worker')
      return scripts.some((s) => s.id === name)
    },
    listDomains: (accountId, service) => ok<{ id: string; hostname: string }[]>('GET', `${a(accountId)}/workers/domains?service=${encodeURIComponent(service)}`, 'Could not list your custom domains'),
    async findZone(accountId, name) {
      const zones = await ok<{ id: string; name: string; status: string }[]>('GET', `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(accountId)}`, 'Could not look up your domains')
      return zones.find((z) => z.name === name) ?? null
    },
    attachDomain: (accountId, hostname, script, zoneId) =>
      ok<{ id: string }>('PUT', `${a(accountId)}/workers/domains`, 'Could not attach the domain', jsonBody({ hostname, service: script, zone_id: zoneId }), 'application/json'),
    detachDomain: (accountId, domainId) => ok('DELETE', `${a(accountId)}/workers/domains/${encodeURIComponent(domainId)}`, 'Could not detach the domain'),
  }
}
